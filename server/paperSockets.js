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
const { WATCHERS_MAX } = require('./paper/PaperRoom');
const { sharedPass } = require('./skinPass');

const TEXT = {
  'bad-stake': 'That table does not exist.',
  'not-open': 'Paid Paper tables are not open yet.',
  restarting: 'DuelSeries is restarting. Try again in a minute.',
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

// pp:watch's answers when there is nothing to show: pp:watching { none: true, why, text }. The page shows its own
// words and asks again by itself.
const WATCH_TEXT = {
  'bad-stake': 'That table cannot be watched.',
  seated: 'You are playing at a table already.',
  nobody: 'Nobody is playing right now.',
  full: 'Too many people are watching this table right now.'
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
  // the shared money journal (agJournal), the arenas' own by default: a durable paid join writes its door record there
  // before the stake claim (step 7j)
  journal = arenas && arenas.journal ? arenas.journal : null,
  paidEnabled = process.env.PAPER_PAID === '1',
  // onFreeJoin({ name }): the owner's quiet phone push (joinAlerts), once a free seat exists; never on a respawn. A
  // paid seat's push rides the arenas' onStake instead (the buy-in counts once the player steers).
  onFreeJoin = null,
  // the shared in-game chat guard (server/chatGuard.js); a test passes its own
  chatGuard = require('./chatGuard').shared
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

  /* The door's journal record for a durable paid join (the Paper analog of security review item d): written BEFORE
     the stake claim, with door, the stakeSig and the token's claimKey (the only key that can refund a consumed row).
     A restart after the claim and before the seat leaves it the jid's last open with no close, and the boot replay
     (agJournal) refunds that stake row once through stakeLedger.refund. The seat's own open (PaperArenas, same jid)
     replaces it, so a seated account is never touched. -> { jid, label, acct } when written, null when there is no
     journal, false when the write failed (the door then spends nothing). */
  function openDoor(entry, name, seat) {
    if (!journal || typeof journal.open !== 'function') return null;
    const jid = crypto.randomUUID();
    const door = { jid, label: seat.room.lobbyType,
      acct: { jid, wallet: entry.walletAddress, deposit: toMicro(entry.worth), name } };
    try {
      const rec = Object.assign({ stakeSig: entry.stakeSig, door: true, claimKey: entry.claimKey }, door.acct);
      if (journal.open(rec, door.label) === true) return door;
    } catch (e) {
      console.error('[PAPER] DOOR journal open threw', e && e.message);
    }
    console.error('[PAPER] DOOR journal open not written (' + door.label + '); the join spends nothing');
    return false;
  }

  // The door's record closed: at once when nothing was claimed, else once the refund lane answered 'owed' or
  // 'settled' (landed). A refund the database did not take yet leaves the record open, so the next boot's replay asks
  // the same conditional refund again (paid at most once) instead of a crash stranding the stake.
  function closeDoor(door, why, refund) {
    if (!door) return;
    const close = () => {
      try {
        journal.close(door.acct, 'refused', { why, reason: 'refund paper ' + why }, door.label);
      } catch (e) {
        console.error('[PAPER] DOOR journal close', e && e.message);
      }
    };
    if (refund === undefined) return close();
    Promise.resolve(refund).then((r) => { if (r === 'owed' || r === 'settled') close(); }, () => {});
  }

  // refundEntry after the door's record was written: the record closes once that refund landed.
  function refundDoor(door, entry, why, name) {
    const r = refundEntry(entry, why, name);
    if (door) closeDoor(door, why, r);
    return r;
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

  /* The bought skin this join wears (docs/skin-purchases.md), or null for the free look: the lobby's choice (`shop`)
     counts only when its skin pass is genuine, unexpired and lists 'paper:<shop>'; the HMAC is checked here, so the
     page can claim nothing it does not own. Only strings are read; any other shape is as if it were absent. A
     respawn that carries neither field wears what the join proved (the pass is checked again, so it still expires);
     a join always starts over from its own fields. */
  function paidSkinFor(socket, msg, respawn) {
    const shop = typeof msg.shop === 'string' ? msg.shop : null;
    const skinPass = typeof msg.skinPass === 'string' ? msg.skinPass : null;
    const asked = shop !== null && skinPass !== null ? { shop, skinPass } : respawn ? socket._ppSkinAsk : null;
    let worn = null;
    try {
      worn = asked ? sharedPass().wornFrom('paper', asked) : null;
    } catch (_) {
      worn = null;
    }
    // Kept only once proved, so a hostile socket cannot park a big string here.
    socket._ppSkinAsk = worn ? asked : null;
    return worn;
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
      unwatch(socket); // a seat taken back on this socket ends any watch on it
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
        unwatch(socket);
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
    // 4s. the server is going down (the shutdown settle ran): refused BEFORE the token is spent, so its stake row
    // stays pending and the next boot's sweep refunds it (nobody new is seated during a restart)
    if (stake > 0 && arenas.stopping === true) return refuse(socket, 'restarting');
    // 4o. the owner's paper:paid:off (kept across restarts): a NEW paid join is refunded at the door; a seated player
    // still resumes above (3r, 3t) and cashes out
    if (stake > 0 && arenas.paidOpen === false) return refuseAndRefund(socket, token, stake, 'not-open', name);
    // 5. maintenance
    if (ops.get().maintenance) return refuseAndRefund(socket, token, stake, 'maintenance', name);
    // the free arena's boot warm-up (no token at stake, the client retries by itself)
    if (stake === 0 && arenas.warming) return refuse(socket, 'warming', { retryMs: 500 });
    // 5b. the bought skin this seat wears, proved now (synchronous, no database), so a durable join's claim in flight
    // below carries the answer with it
    const skin = paidSkinFor(socket, msg, respawn);
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
      // 7j. the door's journal record, before the claim. Not written: nothing is spent (the token goes back, its
      // stake row stays pending for the sweep), since a claim with no record would leave a restart nothing to find.
      const door = openDoor(entry, name, seat);
      if (door === false) {
        if (entry.restore) entry.restore();
        return refuse(socket, 'unavailable');
      }
      const claim = ledger.claimSeat(entry).then((c) => {
        if (c === 'error') {                        // nothing spent: the token goes back
          if (entry.restore) entry.restore();
          closeDoor(door, 'unavailable');
          return refuse(socket, 'unavailable');
        }
        if (c !== 'ok') {                           // a sweep refunded it first: seat nothing
          closeDoor(door, 'settled');
          remember(token, 'settled', true);
          return refuse(socket, 'settled', { refunded: true });
        }
        if (socket.disconnected === true) {         // gone while the claim was in flight
          refundDoor(door, entry, 'join-lost', name);
          return remember(token, 'join-lost', true);
        }
        if (arenas.stopping === true || arenas.paidOpen === false) {   // steps 4s and 4o again
          const why = arenas.stopping === true ? 'restarting' : 'not-open';
          refundDoor(door, entry, why, name);
          remember(token, why, true);
          return refuse(socket, why, { refunded: true });
        }
        if (socket._ppRoom && socket._ppRoom.hasLiveUnit(socket.id)) {   // step 4 again
          refundDoor(door, entry, 'seat-failed', name);
          remember(token, 'seat-failed', true);
          return refuse(socket, 'seat-failed', { refunded: true });
        }
        const again = arenas.seatFor(stake, socket._ppRoom);             // step 6 again
        if (!again) {
          refundDoor(door, entry, 'full', name);
          remember(token, 'full', true);
          return refuse(socket, 'full', { refunded: true });
        }
        seatEntry(socket, token, stake, name, proof, entry, again, door, skin, respawn);
      }).catch((e) => console.error('[PAPER] durable join', e && e.stack ? e.stack : e));
      if (proof) {
        claiming.set(proof, claim);
        claim.then(() => { if (claiming.get(proof) === claim) claiming.delete(proof); });
      }
      return;
    }
    seatEntry(socket, token, stake, name, proof, entry, seat, null, skin, respawn);
  }

  // Steps 7c to 9, for a spent token (and for a free seat, which has none). door: the durable join's journal record
  // (7j), whose jid the seat takes, or null. skin: the bought skin's id proved at step 5b, or null.
  function seatEntry(socket, token, stake, name, proof, entry, seat, door = null, skin = null, respawn = false) {
    // 7c. a wallet whose last paid joins were refunded before their first input (join-lost,
    // join-timeout) is paused for a while: an unconfirmed seat's loss is refunded but its win
    // is kept, so a script could otherwise repeat that 3 s free option on every buy-in. Only
    // the wallet in the token says who this is, so the pause is decided here, after the
    // consume, and pays back what landed in full like every other server-decided refusal.
    if (stake > 0 && arenas.releaseCooldown && arenas.releaseCooldown(entry.walletAddress)) {
      console.warn('[PAPER] COOLDOWN ' + entry.walletAddress + ' ' + stake);
      refundDoor(door, entry, 'cooldown', name);
      remember(token, 'cooldown', true);
      return refuse(socket, 'cooldown', { refunded: true });
    }
    // 8. seat; any throw refunds what landed and leaves no unit behind (addHuman cleans up). A watch that began on
    // this socket while a durable join's claim was in flight ends here: a socket is a seat or a watcher, never both.
    unwatch(socket);
    if (socket._ppRoom && socket._ppRoom !== seat.room) socket.leave(socket._ppRoom.ioRoom);
    const micro = stake > 0 ? toMicro(entry.worth) : 0;
    try {
      seat.room.addHuman(socket, {
        name,
        micro,
        wallet: stake > 0 ? entry.walletAddress : null,
        spot: seat.spot,
        proof,
        paid: stake > 0 ? entry.paid : undefined,
        stakeSig: stake > 0 && entry.stakeSig ? entry.stakeSig : undefined,
        jid: door ? door.jid : undefined,
        skin: skin || undefined
      });
    } catch (e) {
      console.error('[PAPER] seat failed', seat.room.lobbyType, e && e.message);
      let refunded = false;
      if (stake > 0 && entry.worth > 0) {
        refundDoor(door, entry, 'seat-failed', name);
        refunded = true;
        remember(token, 'seat-failed', true);
      }
      return refuse(socket, 'seat-failed', { refunded });
    }
    // 9. socket state is these two fields only
    socket._ppRoom = seat.room;
    socket._ppStake = stake;
    // 10. a free seat's phone push, after the seat exists (nothing paid rides on a free seat, and it cannot throw out)
    if (stake === 0 && !respawn && typeof onFreeJoin === 'function') {
      try {
        onFreeJoin({ name });
      } catch (e) {
        console.error('[PAPER] free join push', e && e.message);
      }
    }
  }

  // A watching socket never joins or respawns: dropped silently BEFORE anything is read (the page opens a fresh
  // page to play; a socket that wants a seat sends pp:leave first).
  function onJoin(socket, msg) {
    if (!isObject(msg)) return;
    if (socket._ppWatch) return;
    if (!socketRL(socket, 'ppjoin', 1000)) return;
    enter(socket, msg, Number(msg.stake), false);
  }

  function onRespawn(socket, msg) {
    if (!isObject(msg)) return;
    if (socket._ppWatch) return;
    if (!socketRL(socket, 'ppjoin', 1000)) return;
    if (typeof socket._ppStake !== 'number') return refuse(socket, 'bad-stake');
    enter(socket, msg, socket._ppStake, true);
  }

  // ---------------------------------------------------------------------------------------
  // Spectate (the lobby's Free rung only). A watcher is read-only: it never takes a seat, never counts as a
  // player, never touches money, a token, a resumeKey, the journal or the directory's seat maps. Its arena lives
  // on socket._ppWatch, never _ppRoom, so pp:in and the join's own guards never see it as a player.
  // ---------------------------------------------------------------------------------------

  function watchRefuse(socket, why) {
    socket.emit('pp:watching', { none: true, why, text: WATCH_TEXT[why] || why });
  }

  function unwatch(socket) {
    const room = socket._ppWatch;
    if (!room) return;
    socket._ppWatch = null;
    room.removeWatcher(socket.id);
  }

  // pp:watch { stake, after?: unit id }: the busiest arena of that rung (Free, $0.50 or $1), its whole state, then its
  // frames and bundles, read only.
  // after: follow the square ranked right after that one (the leader otherwise). Sent again it moves the watch
  // (to a busier arena if there is one), never doubles it.
  function onWatch(socket, msg) {
    if (!isObject(msg)) return;
    if (!socketRL(socket, 'ppwatch', 1000)) return;
    const stake = typeof msg.stake === 'number' ? rungOf(msg.stake) : null;
    if (stake === null || !isStake(stake)) return watchRefuse(socket, 'bad-stake');
    if (socket._ppRoom && socket._ppRoom.hasLiveUnit(socket.id)) return watchRefuse(socket, 'seated');
    const after = Number.isInteger(msg.after) && msg.after > 0 ? msg.after : 0;
    // A dead player's socket still sits in its arena's io room: it leaves it, as pp:leave does.
    if (socket._ppRoom) {
      socket.leave(socket._ppRoom.ioRoom);
      socket._ppRoom = null;
    }
    const room = arenas.watchFor(stake);
    if (!room) {
      unwatch(socket);
      return watchRefuse(socket, 'nobody');
    }
    if (socket._ppWatch !== room) {
      unwatch(socket);
      if (room.watchers.size >= WATCHERS_MAX) return watchRefuse(socket, 'full');
    }
    if (!room.addWatcher(socket, after)) {
      unwatch(socket);
      return watchRefuse(socket, 'nobody');
    }
    socket._ppWatch = room;
  }

  // One input integer, or an array of them (every tick one client frame predicted, in order;
  // the room checks the length and every element).
  function onInput(socket, n) {
    const room = socket._ppRoom;
    if (!room || !(Number.isInteger(n) || Array.isArray(n))) return;
    room.setInput(socket.id, n);
  }

  // A watcher resyncs like a player: the same geometry reply, the same rate limits.
  function onNeed(socket, msg) {
    if (!isObject(msg)) return;
    const room = socket._ppRoom || socket._ppWatch;
    if (!room) return;
    const id = Number.isInteger(msg.id) && msg.id > 0 ? msg.id : 0;
    if (!socketRL(socket, 'ppneed' + id, id ? 250 : 2000)) return;
    socket.emit('pp:geo', MP.packBin(room.geo(id)));
  }

  function onLeave(socket) {
    unwatch(socket);
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

  // pp:chat { text } (the shared in-game chat, Owen 2026-10-16): only a seat with a live square speaks; a watcher hears
  // the room (it sits in the io room) but cannot send. The chat guard cleans, rate limits and filters the line and only
  // its returned text goes on, to the whole room; a refusal note goes to the sender alone as pp:chatnote { text }.
  function onChat(socket, msg) {
    if (!isObject(msg) || typeof msg.text !== 'string') return;
    if (!socketRL(socket, 'ppchat', 300)) return;
    const room = socket._ppRoom;
    if (!room || !room.hasLiveUnit(socket.id)) return;
    const r = chatGuard.check(socket.id, msg.text, Date.now());
    if (!r.ok) {
      if (r.note) socket.emit('pp:chatnote', { text: r.note });
      return;
    }
    room.chat(socket.id, r.text);
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
    socket.on('pp:watch', guard('pp:watch', (msg) => onWatch(socket, msg)));
    socket.on('pp:chat', guard('pp:chat', (msg) => onChat(socket, msg)));
  }

  // io 'disconnect': the seat enters its grace (design 5.7). The socket object is gone, so the
  // directory's socket map finds the seat. A watcher just leaves its arena's watcher list.
  function drop(socketId) {
    try {
      if (typeof arenas.watcherGone === 'function') arenas.watcherGone(socketId);
    } catch (e) {
      console.error('[PAPER] drop watcher', e && e.stack ? e.stack : e);
    }
    try {
      const seat = arenas.seatOfSocket(socketId);
      if (seat) seat.room.beginGrace(seat);
    } catch (e) {
      console.error('[PAPER] drop', e && e.stack ? e.stack : e);
    }
  }

  return { attach, drop, TEXT, WATCH_TEXT };
};
