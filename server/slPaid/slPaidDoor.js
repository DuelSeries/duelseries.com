'use strict';
// The paid sl door (PAID-SL-DESIGN.md 3.2; task T4): agar's order (server/ag/agPaidDoor.js, untouched) written for sl,
// so no agar string leaks and there are no stub methods (D1-m1). slSockets hands it a paid socket's sl:join (the
// socket's handshake said auth.paid 1) AFTER the money-field refusal and the join rate limit and ABOVE the free room's
// maintenance and door checks (critic C-1), with the name already cleaned (cleanNick, D1-M1). The token and the stake
// are read from the handshake (auth.entryToken, auth.stake), never from sl:join.
//
// The ORDER is the contract. Every refusal that can be decided without the token is decided before the token is
// touched; every refusal after the token is spent refunds it exactly once with a reason that starts 'refund slither'
// (the drainer never books it as winnings); nothing a client sends can set a stake, a worth, a wallet or an amount.
//
//   1  shape: auth.entryToken a string of 1 to FIELD_MAX chars, else 'entry'; auth.stake a paid rung (stakeRules
//      rungOf, 0.5 or 1), else 'bad-stake'                                                         token untouched
//   2  this socket is already seated, or its join is in flight: silent                             untouched
//   3  one paid join per socket per DOOR_RATE_MS, else 'slow-down'                                 untouched
//   4  stopping (the shutdown settle ran): 'restarting'; the stake row stays pending and the boot sweep refunds it
//   5  open, and no room of the rung has space and none can open: 'full'                           untouched
//   6  maintenance: consume, then refund 'maintenance'; the switch off (or SL_PAID never built the rungs): consume,
//      then refund 'not-open'                                                                       spent, refunded
//   7  consumeAtStake(token, stake, 'slither'): ok, worth above 0 and a wallet, else 'entry'. Worth only from the token.
//   8  jid = uuid; journal.open({ jid, wallet, deposit, stakeSig, door, claimKey }, label) BEFORE the claim (D2-m2; door
//      and claimKey let the boot replay refund a stake the door claimed but never seated, review item d). An open the journal
//      did not write (false or a throw) refunds 'unavailable' with no claim, and alerts once per 10 minutes: a seat
//      with no journal record would leave nothing for a crash or a kill to find (critic C-7)
//   9  only with entry.stakeSig and a ledger: ledger.claimSeat(entry) (tracked). 'error' (or a rejection): the token
//      is put back (restore), 'unavailable', nothing refunded. Not 'ok': 'settled' (the row was refunded already).
//      A token without stakeSig (dev, non-durable) skips the claim (D3-F3)
//  10  after the await, in ONE synchronous turn inside ONE try: the socket is gone: refund 'join-lost'; stopping:
//      'restarting'; the switch off: 'not-open'; the wallet already holds a paid snake: 'one-seat' (Owen Q3)
//  11  room = seatFor(stake) (none: refund 'full'); room.seatPaid(socket, { nick, cv }, { jid, micro, wallet, paid,
//      name, stakeSig }); null (the room refused) tries one other room, else refund 'full'
//  12  settled the moment seatPaid returns an account; recordEntry(entry, 'snake'). A throw before that refunds
//      'seat-failed' ONLY when no paid room holds an account for the jid (seatPaid opens it last and aborts it on a
//      throw, design 3.3; an account whose own refund the bank refused is paid by the room's owed lane, never twice)
//
// A refund goes through the stake row when the token has one (ledger.refund(stakeSig, 'refund slither ' + why,
// claimKey): an owed row the drainer pays, once, whatever restarts), else through slPayout.refund (dev tokens: what
// landed, capped at the rung). Both are tracked, so the shutdown waits for them. A refund after the journal open also
// closes the jid 'refused', once the refund lane has answered: a stake row refund the database did not take yet
// ('queued', or a rejection) leaves the record open, so a crash before the ledger's own retry lands is flagged
// UNSETTLED-AT-BOOT with its stakeSig instead of passing as refunded (MONEY INVARIANT 9). The door then asks the same
// refund again every DOOR_RECHECK_MS (one conditional update, so the ask and the ledger's retry cannot both win) and
// closes the jid once it answers 'owed' or 'settled' (landed), so a refund that did land is not flagged at the next
// boot. The FIRST answer 'settled' after this door's own claim means nothing was refunded (only this token's claimKey
// can refund a consumed row): CRITICAL, alerted, the record left open for the boot check.
//
// The logger is called only through say(), which never throws: a logger that throws must not keep a spent token from
// its refund, nor reject the claim chain (an unhandled rejection takes the server down).
//
// Refusal: sl:x [{ t: 'refused', why, refunded }] (refunded: the micro handed back for this entry, 0 when the token
// was not spent or was put back), then the socket is disconnected (the sl refusal shape, slSockets refuse).

const crypto = require('crypto');
const { rungOf, STAKE_TIERS } = require('../stakeRules');
const { toMicro } = require('../paperPayout');
const { AG_ALERT_WINDOW_MS } = require('../ag/agAlert');
const { isPlainObject, field } = require('../sl/slSockets');
const { DOOR_RATE_MS, DOOR_RECHECK_MS, FIELD_MAX } = require('./slPaidConst');

const GAME = 'slither'; // the entry store's door name: a token scoped to another game (a Paper or agar dev token) stays shut
const WHYS = Object.freeze(['entry', 'bad-stake', 'slow-down', 'restarting', 'full', 'maintenance', 'not-open',
  'unavailable', 'settled', 'join-lost', 'one-seat', 'seat-failed']);

function authOf(socket) {
  const hs = socket && socket.handshake;
  return hs && isPlainObject(hs.auth) ? hs.auth : null;
}

// A paid rung of the ladder (its own number), else null.
function paidRung(v) {
  const r = rungOf(v);
  return r !== null && STAKE_TIERS.includes(r) ? r : null;
}

function usable(entry) {
  return !!entry && entry.ok === true && entry.worth > 0 && typeof entry.walletAddress === 'string' &&
    entry.walletAddress !== '';
}

// arenas: SlPaidArenas. consumeAtStake(token, stake, game): entryStore's. ledger: stakeLedger (claimSeat, refund) or
// null. slPayout: { refund } (paperPayout for 'slither'). journal: the shared agJournal { open, close }. ops: { get() ->
// { maintenance } }. recordEntry(entry, label): the profile's buy-in row. alert(info): the owner alert. track(p): the
// shutdown's in-flight set. timers: { setTimeout } for the refund re-ask (tests: fake timers). log: needs error.
function createSlPaidDoor({ arenas, consumeAtStake, ledger = null, slPayout, journal, ops = null, recordEntry = null,
  alert = null, uuid = () => crypto.randomUUID(), now = Date.now, log = console, track = (p) => p,
  timers = { setTimeout } } = {}) {
  if (!arenas) throw new Error('slPaidDoor: arenas is required');
  if (typeof consumeAtStake !== 'function') throw new Error('slPaidDoor: consumeAtStake must be a function');
  if (!slPayout || typeof slPayout.refund !== 'function') throw new Error('slPaidDoor: slPayout.refund must be a function');
  if (!journal || typeof journal.open !== 'function' || typeof journal.close !== 'function') {
    throw new Error('slPaidDoor: journal must have open and close');
  }
  const lg = log || console;
  if (typeof lg.error !== 'function') throw new Error('slPaidDoor: log needs error');
  if (!timers || typeof timers.setTimeout !== 'function') {
    throw new Error('slPaidDoor: timers.setTimeout must be a function');
  }
  const lastJoin = new WeakMap(); // socket -> ms of its last paid join (step 3)
  const busy = new WeakSet(); // sockets whose join is in flight (step 2)
  let journalAlertAt = -Infinity;
  const stats = { joins: 0, seated: 0, refused: {}, refunds: 0, refundMicro: 0, journalFails: 0 };

  // the door's only way to log (see the header): never throws
  function say(...a) {
    try {
      lg.error(...a);
    } catch (_) { /* nothing left to log it with */ }
  }

  function refuse(socket, why, refunded) {
    busy.delete(socket);
    stats.refused[why] = (stats.refused[why] || 0) + 1;
    try {
      socket.emit('sl:x', [{ t: 'refused', why, refunded: Number.isSafeInteger(refunded) && refunded > 0 ? refunded : 0 }]);
    } catch (e) { /* closing it is what matters */ }
    try {
      socket.disconnect(true);
    } catch (e) { /* already gone */ }
  }

  function tracked(p) {
    try {
      track(p);
    } catch (e) {
      say('[SLP] DOOR track threw: ' + (e && e.message));
    }
    return p;
  }

  function sayAlert(info) {
    if (typeof alert !== 'function') return;
    try {
      alert(info);
    } catch (e) {
      say('[SLP] DOOR alert threw: ' + (e && e.message));
    }
  }

  // A spent token the door did not seat. Returns the micro handed back. ctx (after step 8): the jid's journal close,
  // written once the refund lane has answered (see the header).
  function refundEntry(entry, why, name, ctx) {
    const micro = toMicro(entry.worth);
    const durable = !!(entry.stakeSig && ledger);
    let p;
    try {
      p = durable
        ? ledger.refund(entry.stakeSig, 'refund slither ' + why, entry.claimKey)
        : slPayout.refund({ wallet: entry.walletAddress, name, micro, paid: entry.paid, why });
    } catch (e) {
      say('[SLP] DOOR CRITICAL refund threw, owed ' + micro + ' micro (' + why + '): ' + (e && e.message));
      sayAlert({ kind: 'door-refund', lobbyType: ctx ? ctx.label : '', micro });
      return 0;
    }
    stats.refunds++;
    stats.refundMicro += micro;
    const open = !!(ctx && ctx.opened);
    const done = Promise.resolve(p).then((r) => {
      if (durable && r === 'settled' && ctx && ctx.claimed) {
        // this door's claim made the row consumed under this token's claimKey, which only this refund holds
        say('[SLP] DOOR CRITICAL refund of ' + micro + ' micro (' + why + ') answered settled after this door ' +
          'claimed the row: nothing was refunded; journal ' +
          (open ? ctx.jid + ' left open for the boot check' : 'not written'));
        sayAlert({ kind: 'door-refund', lobbyType: ctx.label, micro });
        return;
      }
      if (durable && r !== 'owed' && r !== 'settled') {
        say('[SLP] DOOR refund of ' + micro + ' micro (' + why + ') not recorded yet (' + r + '); journal ' +
          (open ? ctx.jid + ' left open for the boot check, asked again in ' + DOOR_RECHECK_MS + ' ms'
            : 'not written'));
        if (open) askAgain(entry, why, ctx);
        return;
      }
      if (open) closeJournal(ctx, entry, why);
    }, (e) => {
      say('[SLP] DOOR CRITICAL refund of ' + micro + ' micro (' + why + ') failed: ' + (e && e.message) +
        (durable && open ? '; journal left open for the boot check' : ''));
      if (!durable && open) closeJournal(ctx, entry, why);
      else if (open) askAgain(entry, why, ctx);
    });
    tracked(done);
    return micro;
  }

  // A stake row refund not recorded yet, asked again in DOOR_RECHECK_MS: 'owed' (this ask wrote it) or 'settled' (the
  // ledger's own retry, or the first write after all) closes the jid; anything else asks again. Only the ask is
  // tracked, never the wait, so a shutdown does not wait a minute; a process that exits first leaves the record open,
  // and the boot check flags it (the ledger's queued retry died with it).
  function askAgain(entry, why, ctx) {
    let h;
    try {
      h = timers.setTimeout(() => {
        let p;
        try {
          p = ledger.refund(entry.stakeSig, 'refund slither ' + why, entry.claimKey);
        } catch (e) {
          say('[SLP] DOOR refund re-ask of ' + ctx.jid + ' threw: ' + (e && e.message));
          return askAgain(entry, why, ctx);
        }
        tracked(Promise.resolve(p).then((r) => {
          if (r === 'owed' || r === 'settled') return closeJournal(ctx, entry, why);
          return askAgain(entry, why, ctx);
        }, (e) => {
          say('[SLP] DOOR refund re-ask of ' + ctx.jid + ' failed: ' + (e && e.message));
          return askAgain(entry, why, ctx);
        }));
      }, DOOR_RECHECK_MS);
    } catch (e) {
      say('[SLP] DOOR CRITICAL refund re-ask of ' + ctx.jid + ' not scheduled, journal left open: ' + (e && e.message));
      return;
    }
    if (h && typeof h.unref === 'function') {
      try {
        h.unref();
      } catch (_) { /* a timer that holds the process open is only slower to exit */ }
    }
  }

  // st.settled: the entry is refunded or its money sits in a seat.
  function refundAndRefuse(socket, entry, why, ctx) {
    ctx.settled = true;
    const micro = refundEntry(entry, why, ctx.name, ctx);
    refuse(socket, why, micro);
  }

  function openJournal(ctx, entry) {
    try {
      const rec = { jid: ctx.jid, wallet: entry.walletAddress, deposit: ctx.micro, name: ctx.name };
      if (entry.stakeSig) {
        rec.stakeSig = entry.stakeSig;
        // the door's own record (security review item d): a restart after the claim and before the seat leaves this
        // open with no close and no seat open after it, and the boot replay refunds the stake row with this claimKey
        // (the only key that can refund a consumed row), once
        rec.door = true;
        if (typeof entry.claimKey === 'string' && entry.claimKey) rec.claimKey = entry.claimKey;
      }
      return journal.open(rec, ctx.label) === true;
    } catch (e) {
      say('[SLP] DOOR journal open threw: ' + (e && e.message));
      return false;
    }
  }

  function closeJournal(ctx, entry, why) {
    try {
      const acct = { jid: ctx.jid, wallet: entry.walletAddress, deposit: ctx.micro, name: ctx.name };
      if (journal.close(acct, 'refused', { why, reason: 'refund slither ' + why }, ctx.label) === false) {
        say('[SLP] DOOR JOURNAL close of ' + ctx.jid + ' (refused ' + why + ') not written');
      }
    } catch (e) {
      say('[SLP] DOOR JOURNAL close of ' + ctx.jid + ' threw: ' + (e && e.message));
    }
  }

  // info: { nick (cleaned), cv (checked) } from slSockets. Never throws.
  function join(socket, info) {
    if (!socket || typeof socket.id !== 'string') return;
    stats.joins++;
    try {
      enter(socket, info && typeof info === 'object' ? info : {});
    } catch (e) {
      // only the steps before the spend run here (the spent part holds its own try and refund)
      say('[SLP] DOOR threw before the token was spent', e && e.stack ? e.stack : e);
      refuse(socket, 'unavailable', 0);
    }
  }

  function enter(socket, info) {
    // 1. shape
    const auth = authOf(socket);
    const token = auth ? field(auth, 'entryToken') : undefined;
    if (typeof token !== 'string' || token.length < 1 || token.length > FIELD_MAX) return refuse(socket, 'entry', 0);
    const stake = paidRung(auth ? field(auth, 'stake') : undefined);
    if (stake === null) return refuse(socket, 'bad-stake', 0);
    // 2. already seated or joining
    if (busy.has(socket) || arenas.roomOf(socket.id)) return;
    // 3. the door's own limiter
    const t = now();
    const last = lastJoin.get(socket);
    if (last !== undefined && t - last < DOOR_RATE_MS) return refuse(socket, 'slow-down', 0);
    lastJoin.set(socket, t);
    busy.add(socket);
    // 4. going down: the token is not touched
    if (arenas.stopping === true) return refuse(socket, 'restarting', 0);
    // 5. no room can take it
    if (arenas.paidOpen && !arenas.hasSpace(stake)) return refuse(socket, 'full', 0);
    const name = typeof info.nick === 'string' ? info.nick : '';
    // 6. maintenance, the switch
    let why = null;
    if (ops && typeof ops.get === 'function') {
      const o = ops.get();
      if (o && o.maintenance) why = 'maintenance';
    }
    if (!why && !arenas.paidOpen) why = 'not-open';
    // 7. the one-time token, for exactly this rung, at the slither door
    const entry = consumeAtStake(token, stake, GAME);
    if (why) {
      const micro = usable(entry) ? refundEntry(entry, why, name, null) : 0;
      return refuse(socket, why, micro);
    }
    if (!usable(entry)) return refuse(socket, 'entry', 0);
    spent(socket, info, stake, entry, name);
  }

  // Steps 8 to 12: the token is spent, so every way out refunds it once or seats it.
  function spent(socket, info, stake, entry, name) {
    const ctx = { settled: false, jid: null, opened: false, claimed: false, label: arenas.labelOf(stake, 0), name,
      micro: toMicro(entry.worth) };
    try {
      // 8.
      ctx.jid = uuid();
      ctx.opened = openJournal(ctx, entry);
      if (!ctx.opened) {
        stats.journalFails++;
        say('[SLP] DOOR JOURNAL CRITICAL open of ' + ctx.jid + ' not written: the entry is refunded, nobody is seated');
        const t = now();
        if (t - journalAlertAt >= AG_ALERT_WINDOW_MS) {
          journalAlertAt = t;
          sayAlert({ kind: 'journal', lobbyType: ctx.label, micro: ctx.micro });
        }
        return refundAndRefuse(socket, entry, 'unavailable', ctx);
      }
      // 9.
      if (entry.stakeSig && ledger) {
        const claim = Promise.resolve()
          .then(() => ledger.claimSeat(entry))
          .then((c) => c, (e) => {
            say('[SLP] DOOR claim threw (token put back): ' + (e && e.message));
            return 'error';
          })
          .then((c) => afterClaim(socket, info, stake, entry, ctx, c))
          .catch((e) => say('[SLP] DOOR durable join', e && e.stack ? e.stack : e));
        tracked(claim);
        return;
      }
      seatEntry(socket, info, stake, entry, ctx);
    } catch (e) {
      say('[SLP] DOOR threw after the token was spent' + (ctx.settled ? ' (already settled)' : ', refunding'),
        e && e.stack ? e.stack : e);
      if (!ctx.settled) refundAndRefuse(socket, entry, 'seat-failed', ctx);
    }
  }

  function afterClaim(socket, info, stake, entry, ctx, c) {
    if (c === 'error') {
      ctx.settled = true;
      try {
        if (typeof entry.restore === 'function') entry.restore();
      } catch (e) {
        say('[SLP] DOOR token restore threw: ' + (e && e.message));
      }
      closeJournal(ctx, entry, 'unavailable');
      return refuse(socket, 'unavailable', 0);
    }
    if (c !== 'ok') {
      // the stake row was refunded already (a sweep won the race): nothing is seated and nothing more is paid
      ctx.settled = true;
      closeJournal(ctx, entry, 'settled');
      return refuse(socket, 'settled', ctx.micro);
    }
    ctx.claimed = true;
    seatEntry(socket, info, stake, entry, ctx);
  }

  // Steps 10 to 12, one synchronous turn, one try.
  function seatEntry(socket, info, stake, entry, ctx) {
    try {
      seatSteps(socket, info, stake, entry, ctx);
    } catch (e) {
      if (ctx.settled) {
        say('[SLP] DOOR threw after the seat was settled', e && e.stack ? e.stack : e);
        return;
      }
      let held = false;
      try {
        held = arenas.hasAccount(ctx.jid);
      } catch (e2) {
        held = false;
      }
      if (held) {
        // the bank refused the account's own refund: the room's owed lane (I4) pays it, the door never does too
        ctx.settled = true;
        say('[SLP] DOOR CRITICAL seat ' + ctx.jid + ' threw with its account still open: no door refund, ' +
          'the room refunds it through the owed lane', e && e.stack ? e.stack : e);
        return refuse(socket, 'seat-failed', 0);
      }
      say('[SLP] DOOR seat threw, refunding ' + ctx.jid, e && e.stack ? e.stack : e);
      refundAndRefuse(socket, entry, 'seat-failed', ctx);
    }
  }

  function seatSteps(socket, info, stake, entry, ctx) {
    // 10.
    if (socket.disconnected === true) return refundAndRefuse(socket, entry, 'join-lost', ctx);
    if (arenas.stopping === true) return refundAndRefuse(socket, entry, 'restarting', ctx);
    if (!arenas.paidOpen) return refundAndRefuse(socket, entry, 'not-open', ctx);
    if (arenas.walletSeatOf(entry.walletAddress)) return refundAndRefuse(socket, entry, 'one-seat', ctx);
    // 11.
    const seatInfo = { nick: ctx.name, cv: info.cv };
    const money = { jid: ctx.jid, micro: ctx.micro, wallet: entry.walletAddress, paid: entry.paid, name: ctx.name,
      stakeSig: entry.stakeSig || null };
    let room = arenas.seatFor(stake);
    let acct = room ? room.seatPaid(socket, seatInfo, money) : null;
    if (!acct && room) {
      const other = arenas.seatFor(stake, room);
      if (other) {
        room = other;
        acct = other.seatPaid(socket, seatInfo, money);
      }
    }
    if (!acct) return refundAndRefuse(socket, entry, 'full', ctx);
    // 12. the money sits in the seat now
    ctx.settled = true;
    busy.delete(socket);
    stats.seated++;
    if (typeof recordEntry === 'function') {
      try {
        recordEntry(entry, 'snake');
      } catch (e) {
        say('[SLP] DOOR recordEntry: ' + (e && e.message));
      }
    }
    return acct;
  }

  return { join, stats, GAME };
}

module.exports = { createSlPaidDoor, paidRung, WHYS, GAME };
