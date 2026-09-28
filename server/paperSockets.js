'use strict';
// Paper socket handlers (design 5.6, 5.7, 6.2). The ORDER in join() is the contract: every
// refusal that can be decided without the entry token is decided before the token is touched;
// a server-decided refusal after a paid buy-in refunds what landed on-chain, once; nothing a
// client sends can set a stake, a worth, a wallet or an amount. Every handler ignores a
// payload of the wrong shape before reading it, and no handler can throw out of socket.io
// (the server has no uncaughtException handler, so a throw would take every live stake down).
const crypto = require('crypto');
const { toMicro, HOUSE_CUT_DIV } = require('./paperPayout');
const { rungOf } = require('./stakeRules');
const { MP } = require('./paper/loadPaperLib');

const TEXT = {
  'bad-stake': 'That table does not exist.',
  'not-open': 'Paid Paper tables are not open yet.',
  maintenance: 'DuelSeries is updating. Your entry was refunded.',
  full: 'Every Paper table at this stake is full. Your entry was refunded.',
  entry: 'Entry fee not verified',
  'seat-failed': 'Could not seat you. Your entry was refunded.',
  expired: 'Your square is gone. Your money dropped where you stood.',
  warming: 'The table is getting ready.',
  'join-lost': 'The connection dropped while you were joining. Your entry was refunded.',
  'join-timeout': 'Your connection did not answer in time. Your entry was refunded.',
  cooldown: 'Your last joins did not connect, so paid tables are paused for this wallet for a few minutes. Your entry was refunded.',
  emergency: 'This table closed because of a server problem. Your entry was refunded.',
  killed: 'Your square was cut. The player who cut it took its money.',
  unavailable: 'Could not confirm your entry right now. An entry that is never used is refunded within a few minutes.',
  settled: 'This entry was already refunded.'
};

const TOKEN_MAX_LEN = 256; // a real token is a UUID; anything longer names no seat

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// What the directory keeps instead of the token itself: enough to recognise a re-sent token,
// useless to anyone reading memory or logs.
function proofOf(token) {
  if (typeof token !== 'string' || !token || token.length > TOKEN_MAX_LEN) return null;
  return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = function createPaperSockets({
  arenas,
  ops,
  socketRL,
  sanitizeName,
  isStake,
  consumePaidEntryAtStake,
  entryStore,
  payout,
  ledger = null,
  paidEnabled = process.env.PAPER_PAID === '1'
}) {
  function refuse(socket, why, extra) {
    socket.emit('pp:refused', Object.assign({ why, text: TEXT[why] || why, refunded: false }, extra || {}));
  }

  /* Pay back a paid entry the door took and did not seat. A real token's stake has a durable
     row (entry.stakeSig, STATUS item 7a): the refund goes through that row to the owed-payout
     lane, once, whatever restarts (the drainer sends it within seconds). A dev token has no row
     and is paid back by Paper's own payout, as before. Either way: what landed, capped at the
     rung. */
  function refundEntry(entry, why, name) {
    if (entry.stakeSig && ledger) {
      return ledger.refund(entry.stakeSig, 'refund paper ' + why, entry.claimKey);
    }
    return payout.refund({ wallet: entry.walletAddress, name, micro: toMicro(entry.worth), paid: entry.paid, why });
  }

  // A refusal decided by the server after a paid buy-in: consume the token here, directly (no
  // stake row for a seat never taken), and send back what landed, capped at the rung.
  function refuseAndRefund(socket, token, stake, why, name) {
    let refunded = false;
    if (stake > 0) {
      const r = entryStore.consumeAtStake(token, stake);
      if (r.ok && r.worth > 0 && r.walletAddress) {
        refundEntry(r, why, name);
        refunded = true;
      }
      // A refusal lost with a dropped link is told again when the page re-sends the token.
      if (r.ok) remember(token, why, refunded);
    }
    refuse(socket, why, { refunded });
  }

  // Durable joins whose stake claim is in flight, by sha256(token): a page that re-sends the same
  // token on a new link meanwhile is answered once that claim has settled (step 3t).
  const claiming = new Map();

  function remember(token, why, refunded) {
    const proof = proofOf(token);
    if (proof) arenas.rememberOutcome('t:' + proof, why, refunded);
  }

  // pp:join and pp:respawn share this; `stake` comes from the message only for a first join.
  function enter(socket, msg, stake, respawn) {
    const token = typeof msg.entryToken === 'string' ? msg.entryToken : undefined;
    const name = sanitizeName(msg.name);
    // 2. the stake is a ladder rung, and from here on it is the ladder's own number: nothing
    // a message sends (0.10499, 0.004) can become an arena's stake, a label or _ppStake.
    stake = rungOf(stake);
    if (stake === null || !isStake(stake)) return refuse(socket, 'bad-stake');
    // 3. paid tables open only behind PAPER_PAID. A real token offered here (the page leaves
    // every rung selectable until the board answers) is paid for: it is refunded like any
    // other door refusal, never left to expire unspent. A page asking again hears that.
    if (stake > 0 && !paidEnabled) {
      const p = proofOf(token);
      const was = p ? arenas.outcomeOf('t:' + p) : null;
      if (was) return refuse(socket, was.why, { refunded: was.refunded });
      return refuseAndRefund(socket, token, stake, 'not-open', name);
    }
    // 3r. reconnect: the seat is proven by its resumeKey; no token is read or consumed
    if (!respawn && msg.resumeKey !== undefined) {
      const key = String(msg.resumeKey);
      const seat = arenas.seatByKey(key);
      if (!seat || !seat.room.resume(socket, seat)) {
        // What really became of the seat while the link was down: refunded before its first
        // input, cashed out (the hold finished and the money went to the wallet), or cut by
        // a player who took its money. Only a square whose money dropped is 'expired'.
        const was = arenas.outcomeOf('k:' + key);
        if (was && was.why === 'cashedout') {
          const grossMicro = Number(was.grossMicro) || 0;
          const cutMicro = Math.floor(grossMicro / HOUSE_CUT_DIV);
          return socket.emit('pp:cashedout', { grossMicro, cutMicro, netMicro: grossMicro - cutMicro, cashoutId: was.cashoutId, resumed: true });
        }
        return was ? refuse(socket, was.why, { refunded: was.refunded }) : refuse(socket, 'expired');
      }
      socket._ppRoom = seat.room;
      socket._ppStake = seat.room.stake;
      return;
    }
    // 3t. a paid join re-sent with its entry token: the page keeps the token in memory until
    // pp:joined or pp:refused answers it, and asks again on the next connection when its link
    // dropped first. The token names the UNCONFIRMED seat it bought, which this socket takes
    // back (nothing consumed, nothing deposited), or the outcome that join already had (a
    // refund, a refusal) is told again. A token that did not reach the server goes on below
    // as a first join; a confirmed seat is never named by its token (only its resumeKey).
    const proof = stake > 0 ? proofOf(token) : null;
    if (proof) {
      // Step 4's guard first: a socket already playing never takes a second seat this way.
      if (socket._ppRoom && socket._ppRoom.hasLiveUnit(socket.id)) return;
      // The first send is still claiming its stake row: answer this one once that has settled
      // (the seat it made, or the refund it got), never with 'entry' for a token being spent.
      if (claiming.has(proof)) {
        claiming.get(proof).then(() => {
          try { enter(socket, msg, stake, respawn); } catch (e) { console.error('[PAPER] re-sent join', e && e.stack ? e.stack : e); }
        });
        return;
      }
      const seat = arenas.seatByProof(proof);
      if (seat) {
        if (!seat.room.resume(socket, seat, true)) return refuse(socket, 'expired');
        if (socket._ppRoom && socket._ppRoom !== seat.room) socket.leave(socket._ppRoom.ioRoom);
        socket._ppRoom = seat.room;
        socket._ppStake = seat.room.stake;
        return;
      }
      const was = arenas.outcomeOf('t:' + proof);
      if (was) return refuse(socket, was.why, { refunded: was.refunded });
    }
    // 4. already playing on this socket: a buggy or hostile duplicate, dropped silently
    if (socket._ppRoom && socket._ppRoom.hasLiveUnit(socket.id)) return;
    // 5. maintenance
    if (ops.get().maintenance) return refuseAndRefund(socket, token, stake, 'maintenance', name);
    // the free arena's boot warm-up (no token at stake, the client retries by itself)
    if (stake === 0 && arenas.warming) return refuse(socket, 'warming', { retryMs: 500 });
    // 6. a seat and a spot, in this same synchronous turn as the consume and the seat
    const seat = arenas.seatFor(stake, socket._ppRoom);
    if (!seat) return refuseAndRefund(socket, token, stake, 'full', name);
    // 7. the one-time token, for exactly this rung
    const entry = consumePaidEntryAtStake(token, stake, 'paper');
    if (!entry || !entry.ok || (stake > 0 && !(entry.worth > 0 && entry.walletAddress))) {
      return refuse(socket, 'entry');
    }
    // 7d. a real token's stake row is claimed in the database BEFORE the seat (STATUS item 7a),
    // so a restart's sweep can never refund a stake that is seated, and never both. The claim
    // is a database round trip: the socket and the seat are looked at again after it.
    if (stake > 0 && entry.stakeSig && ledger) {
      const claim = ledger.claimSeat(entry).then((c) => {
        if (c === 'error') {                        // nothing spent: the token goes back
          if (entry.restore) entry.restore();
          return refuse(socket, 'unavailable');
        }
        if (c !== 'ok') {                           // a sweep refunded it first: seat nothing
          remember(token, 'settled', true);
          return refuse(socket, 'settled', { refunded: true });
        }
        if (socket.disconnected === true) {         // gone while the claim was in flight
          refundEntry(entry, 'join-lost', name);
          return remember(token, 'join-lost', true);
        }
        if (socket._ppRoom && socket._ppRoom.hasLiveUnit(socket.id)) {   // step 4 again
          refundEntry(entry, 'seat-failed', name);
          remember(token, 'seat-failed', true);
          return refuse(socket, 'seat-failed', { refunded: true });
        }
        const again = arenas.seatFor(stake, socket._ppRoom);             // step 6 again
        if (!again) {
          refundEntry(entry, 'full', name);
          remember(token, 'full', true);
          return refuse(socket, 'full', { refunded: true });
        }
        seatEntry(socket, token, stake, name, proof, entry, again);
      }).catch((e) => console.error('[PAPER] durable join', e && e.stack ? e.stack : e));
      if (proof) {
        claiming.set(proof, claim);
        claim.then(() => { if (claiming.get(proof) === claim) claiming.delete(proof); });
      }
      return;
    }
    seatEntry(socket, token, stake, name, proof, entry, seat);
  }

  // Steps 7c to 9, for a spent token (and for a free seat, which has none).
  function seatEntry(socket, token, stake, name, proof, entry, seat) {
    // 7c. a wallet whose last paid joins were refunded before their first input (join-lost,
    // join-timeout) is paused for a while: an unconfirmed seat's loss is refunded but its win
    // is kept, so a script could otherwise repeat that 3 s free option on every buy-in. Only
    // the wallet in the token says who this is, so the pause is decided here, after the
    // consume, and pays back what landed in full like every other server-decided refusal.
    if (stake > 0 && arenas.releaseCooldown && arenas.releaseCooldown(entry.walletAddress)) {
      console.warn('[PAPER] COOLDOWN ' + entry.walletAddress + ' ' + stake);
      refundEntry(entry, 'cooldown', name);
      remember(token, 'cooldown', true);
      return refuse(socket, 'cooldown', { refunded: true });
    }
    // 8. seat; any throw refunds what landed and leaves no unit behind (addHuman cleans up)
    if (socket._ppRoom && socket._ppRoom !== seat.room) socket.leave(socket._ppRoom.ioRoom);
    const micro = stake > 0 ? toMicro(entry.worth) : 0;
    try {
      seat.room.addHuman(socket, {
        name,
        micro,
        wallet: stake > 0 ? entry.walletAddress : null,
        spot: seat.spot,
        proof,
        paid: stake > 0 ? entry.paid : undefined
      });
    } catch (e) {
      console.error('[PAPER] seat failed', seat.room.lobbyType, e && e.message);
      let refunded = false;
      if (stake > 0 && entry.worth > 0) {
        refundEntry(entry, 'seat-failed', name);
        refunded = true;
        remember(token, 'seat-failed', true);
      }
      return refuse(socket, 'seat-failed', { refunded });
    }
    // 9. socket state is these two fields only
    socket._ppRoom = seat.room;
    socket._ppStake = stake;
  }

  function onJoin(socket, msg) {
    if (!isObject(msg)) return;
    if (!socketRL(socket, 'ppjoin', 1000)) return;
    enter(socket, msg, Number(msg.stake), false);
  }

  function onRespawn(socket, msg) {
    if (!isObject(msg)) return;
    if (!socketRL(socket, 'ppjoin', 1000)) return;
    if (typeof socket._ppStake !== 'number') return refuse(socket, 'bad-stake');
    enter(socket, msg, socket._ppStake, true);
  }

  // One input integer, or an array of them (every tick one client frame predicted, in order;
  // the room checks the length and every element).
  function onInput(socket, n) {
    const room = socket._ppRoom;
    if (!room || !(Number.isInteger(n) || Array.isArray(n))) return;
    room.setInput(socket.id, n);
  }

  function onNeed(socket, msg) {
    if (!isObject(msg)) return;
    const room = socket._ppRoom;
    if (!room) return;
    const id = Number.isInteger(msg.id) && msg.id > 0 ? msg.id : 0;
    if (!socketRL(socket, 'ppneed' + id, id ? 250 : 2000)) return;
    socket.emit('pp:geo', MP.packBin(room.geo(id)));
  }

  function onLeave(socket) {
    const room = socket._ppRoom;
    if (!room) return;
    const seat = room.seatOfSocket(socket.id);
    if (seat && !seat.unit.death) room.removeHuman(seat.unit.id, 9);
    socket.leave(room.ioRoom);
    socket._ppRoom = null;
  }

  function onPing(socket, msg) {
    if (!isObject(msg) || typeof msg.t !== 'number' || !Number.isFinite(msg.t)) return;
    const room = socket._ppRoom;
    socket.emit('pp:pong', { t: msg.t, tick: room ? room.game.tick : 0 });
  }

  function guard(name, fn) {
    return function () {
      try {
        fn.apply(null, arguments);
      } catch (e) {
        console.error('[PAPER] handler ' + name, e && e.stack ? e.stack : e);
      }
    };
  }

  function attach(socket) {
    socket.on('pp:join', guard('pp:join', (msg) => onJoin(socket, msg)));
    socket.on('pp:respawn', guard('pp:respawn', (msg) => onRespawn(socket, msg)));
    socket.on('pp:in', guard('pp:in', (n) => onInput(socket, n)));
    socket.on('pp:need', guard('pp:need', (msg) => onNeed(socket, msg)));
    socket.on('pp:leave', guard('pp:leave', () => onLeave(socket)));
    socket.on('pp:ping', guard('pp:ping', (msg) => onPing(socket, msg)));
  }

  // io 'disconnect': the seat enters its grace (design 5.7). The socket object is gone, so the
  // directory's socket map finds the seat.
  function drop(socketId) {
    try {
      const seat = arenas.seatOfSocket(socketId);
      if (seat) seat.room.beginGrace(seat);
    } catch (e) {
      console.error('[PAPER] drop', e && e.stack ? e.stack : e);
    }
  }

  return { attach, drop, TEXT };
};
