'use strict';
// The paid agar.io door (PAID-AGAR-DESIGN.md 5.4), Paper's door (server/paperSockets.js) with the reviews' fixes.
// agSockets hands it every ag:join that carries a stake above 0, an entryToken or a resumeKey, BEFORE the free join's
// rate limit and maintenance answer, so a paid join under maintenance is refunded, never refused bare.
//
// The ORDER below is the contract. Every refusal that can be decided without the token is decided before the token is
// touched; every server-decided refusal after the token is spent refunds what landed, exactly once, with a reason that
// starts with 'refund' (so the drainer never books it as winnings, server/payoutDrainer.js:32-35); nothing a client
// sends can set a stake, a worth, a wallet or an amount (the worth and the wallet come from the consumed token only,
// and a real token is minted only to the verified on-chain payer).
//
//   1. shape: entryToken and resumeKey strings of at most 64, the name cleaned; client money fields ignored
//   2. the stake is a paid ladder rung (stakeRules.rungOf), else 'bad-stake'
//   3. this socket already holds an open paid account: dropped silently (before resume and re-sent token, so one
//      socket can never take two seats)
//   4. resumeKey: reattach that account, or tell the remembered outcome (no token read; works while closed)
//   5. a re-sent token: its unconfirmed seat, or its outcome; a token still being claimed waits for that claim
//   6. maintenance: consume and refund
//   7. consume the one-time token at this rung for 'agar'; it must carry a worth above 0 and a wallet
//   8. a real token's stake row is claimed (await) before the seat; 'error' puts the token back
//   9. after the await: still connected and still no open account, else refund
//  10. from here to the end in ONE synchronous turn: this wallet already holds a seat -> reattach it to this socket
//      and refund this token ('reattach', token-proof: Owen Q8 one seat per wallet)
//  11. the door is closed (AG_PAID off, owner console agar:paid:off) -> refund 'not-open'
//  12. the release cooldown -> refund 'cooldown'
//  13. a room of the rung: addPaidHuman; 'no-room' -> one other room; else refund 'no-room'; full -> 'full'; a throw ->
//      'seat-failed'. walletSeat is set inside this turn (onAccountOpen).
//  14. ag:joined { resumeKey, stake, micro, ... }

const crypto = require('crypto');
const { rungOf } = require('../stakeRules');
const { toMicro, HOUSE_CUT_DIV } = require('../paperPayout');

const TEXT = Object.freeze({
  'bad-stake': 'That table does not exist.',
  'not-open': 'Paid agar.io tables are not open right now. Your entry was refunded.',
  maintenance: 'DuelSeries is updating. Your entry was refunded.',
  full: 'Every agar.io table at this stake is full. Your entry was refunded.',
  'no-room': 'There was no safe place to start you. Your entry was refunded.',
  entry: 'Entry fee not verified',
  'seat-failed': 'Could not seat you. Your entry was refunded.',
  reattach: 'You already have a seat: you are back in it, and this entry was refunded.',
  expired: 'That seat is gone.',
  'join-lost': 'The connection dropped while you were joining. Your entry was refunded.',
  'join-timeout': 'Your page did not answer in time. Your entry was refunded.',
  'join-failed': 'Could not start you. Your entry was refunded.',
  cooldown: 'Your last joins did not connect, so paid tables are paused for this wallet for a few minutes. Your entry was refunded.',
  emergency: 'This table closed because of a server problem. Your balance was refunded in full.',
  shutdown: 'The server restarted. Your balance was refunded in full.',
  unavailable: 'Could not confirm your entry right now. An entry that is never used is refunded within a few minutes.',
  settled: 'This entry was already refunded.',
  'slow-down': 'One moment.',
});

const FIELD_MAX = 64;       // design 5.4 step 1: a real token and a resume key are UUIDs
const DOOR_RATE_MS = 250;   // design 3.5 DOOR_RATE_MS: one paid join per socket per this many ms

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// What the directory keeps instead of the token: enough to recognise a re-sent token (paperSockets.js:39-42).
function proofOf(token) {
  if (typeof token !== 'string' || !token || token.length > FIELD_MAX) return null;
  return crypto.createHash('sha256').update(token).digest('hex');
}

// True for a payload the paid door answers (design 5.4): a stake above 0, an entryToken or a resumeKey. A plain free
// Play ({ name }) and a stake of 0 with neither field stay on the free path.
function wantsPaid(msg) {
  if (!isPlainObject(msg)) return false;
  if (msg.entryToken !== undefined || msg.resumeKey !== undefined) return true;
  if (msg.stake === undefined) return false;
  return rungOf(msg.stake) !== 0;
}

// arenas: AgArenas (paid rungs, maps, paidOpen); consumeAtStake(token, stake) -> entry (entryStore, 'agar' door);
// ledger: stakeLedger (claimSeat, refund) or null; refund(info): agPayout.refund for dev and non-durable tokens;
// ops: { get() -> { maintenance } }; cleanName(raw) -> string | null; clientIp(socket); now: clock for the limiter
function createAgPaidDoor({ arenas, consumeAtStake, ledger = null, refund, ops = null, cleanName, clientIp = null,
  now = Date.now, log = console } = {}) {
  if (!arenas) throw new Error('agPaidDoor: arenas is required');
  if (typeof consumeAtStake !== 'function') throw new Error('agPaidDoor: consumeAtStake must be a function');
  if (typeof refund !== 'function') throw new Error('agPaidDoor: refund must be a function');
  if (typeof cleanName !== 'function') throw new Error('agPaidDoor: cleanName must be a function');
  const lastJoin = new WeakMap();   // socket -> ms of its last paid join (the door's own limiter)
  const claiming = new Map();       // proof -> the claim promise of a durable join in flight (step 5)

  function refuse(socket, why, extra) {
    try {
      socket.emit('ag:refused', Object.assign({ why, text: TEXT[why] || why, refunded: false }, extra || {}));
    } catch (e) { /* the socket is gone */ }
  }

  function remember(token, why, refunded, extra) {
    const p = proofOf(token);
    if (p) arenas.rememberOutcome('t:' + p, why, refunded, extra);
  }

  // A spent token the door did not seat: through its stake row when it has one (the owed-payout lane, once, whatever
  // restarts), else through the agar payout (dev tokens: the fake withdraw). What landed, capped at the rung.
  function refundEntry(entry, why, name) {
    try {
      if (entry.stakeSig && ledger) return ledger.refund(entry.stakeSig, 'refund agar ' + why, entry.claimKey);
      return refund({ wallet: entry.walletAddress, name, micro: toMicro(entry.worth), paid: entry.paid, why });
    } catch (e) {
      log.error('[AG] DOOR CRITICAL refund threw, owed ' + entry.worth + ' to ' + entry.walletAddress + ' (' + why +
        '): ' + (e && e.message));
      return null;
    }
  }

  // A refusal decided after a buy-in, with the token not yet consumed: consume it here and refund.
  function refuseAndRefund(socket, token, stake, why, name) {
    let refunded = false;
    const r = token ? consumeAtStake(token, stake) : null;
    if (r && r.ok && r.worth > 0 && r.walletAddress) {
      refundEntry(r, why, name);
      refunded = true;
    }
    if (r && r.ok) remember(token, why, refunded);
    refuse(socket, why, { refunded });
  }

  // What a page asking again is told: a cash-out's receipt, a death, or a refusal.
  function answerOutcome(socket, was) {
    if (was.why === 'cashedout' || was.why === 'settled') {
      const grossMicro = Number(was.grossMicro) || 0;
      const cutMicro = Math.floor(grossMicro / HOUSE_CUT_DIV);
      socket.emit('ag:cashedout', { grossMicro, cutMicro, netMicro: grossMicro - cutMicro, cashoutId: was.cashoutId,
        resumed: true, auto: was.why === 'settled' });
      return;
    }
    if (was.why === 'eaten') {
      socket.emit('ag:dead', { lostMicro: Number(was.lostMicro) || 0, by: was.by || '', resumed: true });
      return;
    }
    refuse(socket, was.why, { refunded: !!was.refunded });
  }

  function seated(socket, room) {
    arenas._paidSeated(socket, room);
  }

  function join(socket, msg) {
    if (!socket || !isPlainObject(msg)) return;
    const t = now();
    const last = lastJoin.get(socket);
    if (last !== undefined && t - last < DOOR_RATE_MS) {
      return refuse(socket, 'slow-down', { retry: true, retryMs: 500 });
    }
    lastJoin.set(socket, t);
    enter(socket, msg);
  }

  function enter(socket, msg) {
    // 1. shape
    const token = msg.entryToken;
    const key = msg.resumeKey;
    if (token !== undefined && (typeof token !== 'string' || !token || token.length > FIELD_MAX)) return refuse(socket, 'entry');
    if (key !== undefined && (typeof key !== 'string' || !key || key.length > FIELD_MAX)) return refuse(socket, 'expired');
    const cleaned = cleanName(msg.name);
    const name = typeof cleaned === 'string' ? cleaned : '';
    // 2. a paid rung
    const stake = rungOf(msg.stake);
    if (stake === null || !(stake > 0)) return refuse(socket, 'bad-stake');
    // 3. this socket already plays a paid seat
    if (arenas.paidRoomOf(socket.id)) return;
    // 4. resume key
    if (key !== undefined) {
      const seat = arenas.seatByKey(key);
      if (seat) {
        arenas._takeSocket(socket);
        if (seat.room.resumePaid(socket, seat.pid)) return seated(socket, seat.room);
      }
      const was = arenas.outcomeOf('k:' + key);
      return was ? answerOutcome(socket, was) : refuse(socket, 'expired');
    }
    // 5. a re-sent token
    const proof = proofOf(token);
    if (proof) {
      if (claiming.has(proof)) {
        claiming.get(proof).then(() => {
          try {
            enter(socket, msg);
          } catch (e) {
            log.error('[AG] re-sent paid join', e && e.stack ? e.stack : e);
          }
        });
        return;
      }
      const seat = arenas.seatByProof(proof);
      if (seat) {
        arenas._takeSocket(socket);
        if (seat.room.resumePaid(socket, seat.pid, { byToken: true })) return seated(socket, seat.room);
        return refuse(socket, 'expired');
      }
      const was = arenas.outcomeOf('t:' + proof);
      if (was) return answerOutcome(socket, was);
    }
    if (!token) return refuse(socket, 'entry');
    // 6. maintenance
    if (ops && typeof ops.get === 'function') {
      const o = ops.get();
      if (o && o.maintenance) return refuseAndRefund(socket, token, stake, 'maintenance', name);
    }
    // 7. the one-time token, for exactly this rung
    const entry = consumeAtStake(token, stake);
    if (!entry || !entry.ok || !(entry.worth > 0 && typeof entry.walletAddress === 'string' && entry.walletAddress)) {
      return refuse(socket, 'entry');
    }
    // 8. a real token's stake row, claimed before the seat
    if (entry.stakeSig && ledger) {
      const claim = Promise.resolve().then(() => ledger.claimSeat(entry)).then((c) => {
        if (c === 'error') {
          if (typeof entry.restore === 'function') entry.restore();
          return refuse(socket, 'unavailable');
        }
        if (c !== 'ok') {
          remember(token, 'settled', true);
          return refuse(socket, 'settled', { refunded: true });
        }
        seatEntry(socket, token, stake, name, proof, entry);
      }).catch((e) => log.error('[AG] durable paid join', e && e.stack ? e.stack : e));
      if (proof) {
        claiming.set(proof, claim);
        claim.then(() => { if (claiming.get(proof) === claim) claiming.delete(proof); });
      }
      return;
    }
    seatEntry(socket, token, stake, name, proof, entry);
  }

  function refundAndRefuse(socket, token, entry, why, name) {
    refundEntry(entry, why, name);
    remember(token, why, true);
    refuse(socket, why, { refunded: true });
  }

  // Steps 9 to 14, all in one synchronous turn.
  function seatEntry(socket, token, stake, name, proof, entry) {
    // 9.
    if (socket.disconnected === true) {
      refundEntry(entry, 'join-lost', name);
      return remember(token, 'join-lost', true);
    }
    if (arenas.paidRoomOf(socket.id)) return refundAndRefuse(socket, token, entry, 'seat-failed', name);
    // 10. one seat per wallet: this token proves the wallet (minted only to the verified payer)
    const ws = arenas.walletSeatOf(entry.walletAddress);
    if (ws) {
      arenas._takeSocket(socket);
      const ok = ws.room.resumePaid(socket, ws.pid);
      refundEntry(entry, 'reattach', name);
      remember(token, 'reattach', true);
      if (ok) {
        seated(socket, ws.room);
        try {
          socket.emit('ag:refunded', { why: 'reattach', text: TEXT.reattach });
        } catch (e) { /* told on the seat anyway */ }
        return;
      }
      return refuse(socket, 'seat-failed', { refunded: true });
    }
    // 11. the door switch
    if (!arenas.paidOpen) return refundAndRefuse(socket, token, entry, 'not-open', name);
    // 12. the release cooldown
    if (arenas.releaseCooldown(entry.walletAddress)) {
      log.warn('[AG] COOLDOWN ' + String(entry.walletAddress).slice(0, 8) + ' ' + stake);
      return refundAndRefuse(socket, token, entry, 'cooldown', name);
    }
    // 13. a room and a safe spot
    const seatEntryInfo = {
      name, micro: toMicro(entry.worth), wallet: entry.walletAddress, paid: entry.paid, proof,
      ip: typeof clientIp === 'function' ? safeIp(socket) : '',
    };
    let room = arenas.seatFor(stake);
    if (!room) return refundAndRefuse(socket, token, entry, 'full', name);
    let r;
    try {
      arenas._takeSocket(socket);
      r = room.addPaidHuman(socket, seatEntryInfo);
      if (r === 'no-room') {
        const other = arenas.seatFor(stake, room);
        if (other) {
          room = other;
          r = room.addPaidHuman(socket, seatEntryInfo);
        }
      }
    } catch (e) {
      log.error('[AG] paid seat failed', room && room.lobbyType, e && e.message);
      return refundAndRefuse(socket, token, entry, 'seat-failed', name);
    }
    if (r === 'no-room') return refundAndRefuse(socket, token, entry, 'no-room', name);
    if (r === 'full' || r === 'stopped') return refundAndRefuse(socket, token, entry, 'full', name);
    if (!r || typeof r !== 'object') return refundAndRefuse(socket, token, entry, 'seat-failed', name);
    // 14.
    seated(socket, room);
    try {
      socket.emit('ag:joined', room.joinedPayload(r, false));
    } catch (e) {
      log.error('[AG] ag:joined', e && e.message);
    }
  }

  function safeIp(socket) {
    try {
      return String(clientIp(socket) || '');
    } catch (e) {
      return '';
    }
  }

  return { join, wants: wantsPaid, claiming, TEXT };
}

module.exports = { createAgPaidDoor, wantsPaid, proofOf, TEXT, FIELD_MAX, DOOR_RATE_MS };
