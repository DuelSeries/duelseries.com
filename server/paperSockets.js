'use strict';
// Paper socket handlers (design 5.6, 5.7, 6.2). The ORDER in join() is the contract: every
// refusal that can be decided without the entry token is decided before the token is touched;
// a server-decided refusal after a paid buy-in refunds what landed on-chain, once; nothing a
// client sends can set a stake, a worth, a wallet or an amount. Every handler ignores a
// payload of the wrong shape before reading it, and no handler can throw out of socket.io
// (the server has no uncaughtException handler, so a throw would take every live stake down).
const { toMicro } = require('./paperPayout');

const TEXT = {
  'bad-stake': 'That table does not exist.',
  'not-open': 'Paid Paper tables are not open yet.',
  maintenance: 'DuelSeries is updating. Your entry was refunded.',
  full: 'Every Paper table at this stake is full. Your entry was refunded.',
  entry: 'Entry fee not verified',
  'seat-failed': 'Could not seat you. Your entry was refunded.',
  expired: 'Your square is gone. Your money dropped where you stood.',
  warming: 'The table is getting ready.'
};

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
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
  paidEnabled = process.env.PAPER_PAID === '1'
}) {
  function refuse(socket, why, extra) {
    socket.emit('pp:refused', Object.assign({ why, text: TEXT[why] || why, refunded: false }, extra || {}));
  }

  // A refusal decided by the server after a paid buy-in: consume the token here, directly (no
  // stake row for a seat never taken), and send back what landed, capped at the rung.
  function refuseAndRefund(socket, token, stake, why, name) {
    let refunded = false;
    if (stake > 0) {
      const r = entryStore.consumeAtStake(token, stake);
      if (r.ok && r.worth > 0 && r.walletAddress) {
        payout.refund({ wallet: r.walletAddress, name, micro: toMicro(r.worth), paid: r.paid, why });
        refunded = true;
      }
    }
    refuse(socket, why, { refunded });
  }

  // pp:join and pp:respawn share this; `stake` comes from the message only for a first join.
  function enter(socket, msg, stake, respawn) {
    const token = typeof msg.entryToken === 'string' ? msg.entryToken : undefined;
    const name = sanitizeName(msg.name);
    // 2. the stake is a ladder rung
    if (!isStake(stake)) return refuse(socket, 'bad-stake');
    // 3. paid tables open only behind PAPER_PAID
    if (stake > 0 && !paidEnabled) return refuse(socket, 'not-open');
    // 3r. reconnect: the seat is proven by its resumeKey; no token is read or consumed
    if (!respawn && msg.resumeKey !== undefined) {
      const seat = arenas.seatByKey(String(msg.resumeKey));
      if (!seat || !seat.room.resume(socket, seat)) return refuse(socket, 'expired');
      socket._ppRoom = seat.room;
      socket._ppStake = seat.room.stake;
      return;
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
    // 8. seat; any throw refunds what landed and leaves no unit behind (addHuman cleans up)
    if (socket._ppRoom && socket._ppRoom !== seat.room) socket.leave(socket._ppRoom.ioRoom);
    const micro = stake > 0 ? toMicro(entry.worth) : 0;
    try {
      seat.room.addHuman(socket, { name, micro, wallet: stake > 0 ? entry.walletAddress : null, spot: seat.spot });
    } catch (e) {
      console.error('[PAPER] seat failed', seat.room.lobbyType, e && e.message);
      let refunded = false;
      if (stake > 0 && entry.worth > 0) {
        payout.refund({ wallet: entry.walletAddress, name, micro, paid: entry.paid, why: 'seat-failed' });
        refunded = true;
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

  function onInput(socket, n) {
    const room = socket._ppRoom;
    if (!room || !Number.isInteger(n)) return;
    room.setInput(socket.id, n);
  }

  function onNeed(socket, msg) {
    if (!isObject(msg)) return;
    const room = socket._ppRoom;
    if (!room) return;
    const id = Number.isInteger(msg.id) && msg.id > 0 ? msg.id : 0;
    if (!socketRL(socket, 'ppneed' + id, id ? 250 : 2000)) return;
    socket.emit('pp:geo', room.geo(id));
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
