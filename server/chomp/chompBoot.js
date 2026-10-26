'use strict';
// Chomp (the Pac-Man-style arena) on its own socket.io namespace, /chomp, served by GET /chomp: the free arena and,
// while CHOMP_PAID is on and the server hands its money in, the paid rungs (server/chomp/chompArenas.js) behind
// agar.io's paid door (server/ag/agPaidDoor.js, with Chomp's event prefix 'c').
//
// openChomp({ io, env, helpers: { socketRL, sanitizeName, ops }, money: { hooks, door }, paidSwitch, botStore,
//   botBank }) -> { arenas, room (the free one), nsp, paid, close() } or null when CHOMP is off.
// CHOMP: unset/1/true/on/yes on (the default), 0/false/off/no off, anything else off and logged.
// CHOMP_PAID: the paid rungs; unset/1/true/on/yes on (the default), 0/false/off/no off, anything else off and logged
// (fails closed). The instant off switch needs no restart: the owner console's chomp:paid:off (new paid joins refunded
// at the door, seated players finish), kept across restarts by paidSwitch.
//
// Events in (each shape checked, each rate limited per socket, every handler wrapped so nothing a client sends can
// throw out of socket.io):
//   c:join {name}                     free: take a seat in the free arena (one per socket)
//   c:join {name, stake, entryToken | resumeKey}   paid: the paid door (a stake above 0, a token or a key)
//   c:dir {d, s, c, r}                d 0..3 (up, left, down, right), s the page's input number, c/r its tile at the press
//   c:ready                           paid: the page drew its own chomper (the shield and the freeze go)
//   c:hold {on: 1 | 0}                paid: hold Q (the page repeats {on: 1} every 200 ms)
//   c:chat {text}                     the shared chat guard (server/chatGuard.js)
//   c:leave                           free: give the seat up (a paid seat leaves only by cash-out)
// Events out: c:init (the arena, the live dots, who is in; a paid room's coins and stake), c:you {id} (free seat),
// c:joined (paid seat), c:s (binary snapshot, volatile, SNAP_HZ), c:dots {e, b}, c:coins {a, r}, c:ev [events],
// c:lb [[id, score | micro]], c:me {s, l, rk, n, m?}, c:over (free), c:dead / c:cashedout / c:paid / c:payerror /
// c:closed / c:holding / c:replaced / c:refunded (paid), c:refused {why}, c:chat, c:chatnote.
//
// Each room's sockets are a socket.io room of their own (the free arena's is 'free'), so a page only ever hears its
// own arena. The free arena is warm from boot (bots on the day curve, server/botPopulation.js 'chomp').

const R = require('../../shared/chompRules');
const chatGuard = require('../chatGuard').shared;
const { gameBotTarget } = require('../botPopulation');
const { SNAP_EVERY } = require('./chompRoom');
const { ChompArenas, refuse } = require('./chompArenas');
const { createAgPaidDoor, wantsPaid } = require('../ag/agPaidDoor');
const { socketClientIp } = require('../clientAddr');

const PER_IP = 10;                 // CHOSEN: sockets one address may hold on /chomp
const RATE = { join: 500, dir: 12, leave: 500, chat: 300, ready: 250, hold: 50 };   // CHOSEN: flood stops (ms)
const PAID_DEFAULT = true;

// The door's answers in Chomp's words (agPaidDoor's TEXT keeps the rest).
const DOOR_TEXT = Object.freeze({
  'not-open': 'Paid Chomp rooms are not open right now. Your entry was refunded.',
  full: 'Every Chomp room at this stake is full. Your entry was refunded.',
  'no-room': 'There was no safe place to start you. Your entry was refunded.',
});

function switchOn(env) {
  const v = String(env.CHOMP == null ? '' : env.CHOMP).trim().toLowerCase();
  if (v === '' || v === '1' || v === 'true' || v === 'on' || v === 'yes') return true;
  if (v !== '0' && v !== 'false' && v !== 'off' && v !== 'no') console.warn(`[CHOMP] CHOMP=${v} not understood: off`);
  return false;
}

function paidSwitch(raw, log) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  if (v === '') return PAID_DEFAULT;
  if (v === '1' || v === 'true' || v === 'on' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false;
  (log || console).error('[CHOMP] CHOMP_PAID=' + JSON.stringify(String(raw).slice(0, 20)) + ' is not a switch value; paid Chomp stays OFF');
  return false;
}

function isInt(v, lo, hi) { return Number.isInteger(v) && v >= lo && v <= hi; }

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function openChomp({ io, env = process.env, helpers = {}, money = null, paidSwitch: switchStore = null, botStore = null,
  botBank = null, log = console, autoTick = true, arenasOpts = null } = {}) {
  if (!switchOn(env)) { log.log('[CHOMP] off'); return null; }
  const nsp = io ? io.of('/chomp') : null;
  const paid = paidSwitch(env.CHOMP_PAID, log) && !!(money && money.hooks && money.door);
  const arenas = new ChompArenas(Object.assign({
    nsp, region: env.REGION || 'na', botCurve: () => gameBotTarget('chomp'), paid, log,
    moneyHooks: paid ? money.hooks : null, botStore: paid ? botStore : null, botBank: paid ? botBank : null,
  }, arenasOpts || {}));
  const room = arenas.free;
  if (paid) {
    try {
      arenas.startBots();
    } catch (e) {
      log.error('[CHOMP] paid bots not restored: ' + (e && e.message));
    }
    // a saved chomp:paid:off outlives a restart; a switch that cannot be read fails CLOSED
    if (switchStore && typeof switchStore.closedAtBoot === 'function') {
      let c = { closed: true, why: 'threw' };
      try {
        c = switchStore.closedAtBoot();
      } catch (e) {
        log.error('[CHOMP] CRITICAL paid switch read threw, the paid door starts CLOSED: ' + (e && e.message));
      }
      if (c.closed) {
        arenas.paidOpen = false;
        log.warn('[CHOMP] paid door CLOSED at boot (' + c.why + '): chomp:paid:off outlived the restart');
      }
    }
  }
  const rl = helpers.socketRL || ((s, key, ms) => {
    const now = Date.now(); s._rl = s._rl || {};
    if (s._rl[key] && now - s._rl[key] < ms) return false;
    s._rl[key] = now; return true;
  });
  const clean = helpers.sanitizeName || (n => (typeof n === 'string' ? n : '').replace(/[<>]/g, '').trim().slice(0, 20) || 'Player');
  const ops = helpers.ops || null;
  const perIp = new Map();
  const door = money && money.door ? createAgPaidDoor(Object.assign({
    arenas, cleanName: (raw) => (typeof raw === 'string' ? clean(raw).slice(0, 15) : ''),
    clientIp: socketClientIp, ops, log, ev: 'c', game: 'chomp', text: DOOR_TEXT, tag: '[CHOMP]',
  }, money.door)) : null;

  // ---- the loop: fixed 60 Hz steps against the wall clock, so a late timer catches up instead of slowing the game
  let timer = null, last = 0, acc = 0;
  const stepMs = 1000 / R.TICK_HZ;
  function frame() {
    const now = Date.now();
    acc += now - last; last = now;
    if (acc > 250) acc = 250;                  // after a long stall, drop time rather than fast-forward the arena
    while (acc >= stepMs) {
      acc -= stepMs;
      for (const r of arenas.liveRooms()) {
        if (!r.safeStep()) continue;
        if (r.tick % SNAP_EVERY === 0) {
          try {
            r.flush();
          } catch (e) {
            log.error('[CHOMP] send', r.lobbyType, e && e.message);
          }
        }
      }
    }
  }
  function start() {
    if (timer || !autoTick) return;
    last = Date.now(); acc = 0;
    timer = setInterval(frame, 8);
  }

  // The room this socket plays or watches in: a paid room through the directory, else the free arena.
  function roomOf(socket) {
    return arenas.roomOfSocket(socket.id) || room;
  }

  function attach(socket) {
    const ip = socketClientIp(socket);
    const n = (perIp.get(ip) || 0) + 1;
    if (n > PER_IP) { socket.emit('c:refused', { why: 'limit' }); socket.disconnect(true); return; }
    perIp.set(ip, n);
    // A stake hand-off (auth { paid: 1 }) connects seatless and has PAID_SEATLESS_MS to send its paid c:join; the
    // lobby's Spectate on a paid rung (auth { watchStake }) watches that rung's busiest room; anyone else sees the
    // free arena.
    const auth = socket.handshake && socket.handshake.auth ? socket.handshake.auth : {};
    if (auth.paid === 1 && arenas.paidEnabled) arenas.connectPaid(socket);
    else if (typeof auth.watchStake === 'number' && auth.watchStake > 0) {
      if (!arenas.connectWatch(socket, auth.watchStake)) refuse(socket, 'nobody');
    } else room.attach(socket);

    function on(ev, fn) {
      socket.on(ev, (msg) => {
        try {
          if (msg != null && (typeof msg !== 'object' || Array.isArray(msg))) return;
          fn(msg || {});
        } catch (e) { log.error(`[CHOMP] ${ev} handler`, e && e.message); }
      });
    }
    on('c:join', (msg) => {
      // a paid payload goes to the paid door FIRST (its own limiter; it refunds under maintenance)
      if (isPlainObject(msg) && wantsPaid(msg)) {
        if (door) return door.join(socket, msg);
        socket.emit('c:refused', { why: 'not-open' });
        return;
      }
      if (!rl(socket, 'c:join', RATE.join)) return;
      if (arenas.paidRoomOf(socket.id)) return;            // a paid seat never takes a free one
      if (ops && typeof ops.get === 'function' && ops.get().maintenance) { socket.emit('c:refused', { why: 'maintenance' }); return; }
      if (room.bySocket.has(socket.id)) return;
      const was = arenas.roomOfSocket(socket.id);
      if (was) { was.removeSocket(socket.id); arenas.bySocket.delete(socket.id); }
      room.attach(socket);
      const p = room.addPlayer({ name: clean(msg.name).slice(0, 15), socketId: socket.id });
      if (!p) { socket.emit('c:refused', { why: 'full' }); return; }
      socket.emit('c:you', { id: p.id, metas: room.metas() });
      if (typeof helpers.notifyJoin === 'function') {
        try { helpers.notifyJoin(p.name); } catch (e) { log.error('[CHOMP] notifyJoin', e && e.message); }
      }
    });
    on('c:dir', (msg) => {
      if (!rl(socket, 'c:dir', RATE.dir)) return;
      const r = roomOf(socket);
      const p = r.bySocket.get(socket.id);
      if (!p || !isInt(msg.d, 0, 3) || !isInt(msg.s, 0, 65535)) return;
      const c = isInt(msg.c, 0, r.A.W - 1) ? msg.c : null, rr = isInt(msg.r, 0, r.A.H - 1) ? msg.r : null;
      r.input(p, msg.d, msg.s, c, rr);
    });
    on('c:ready', () => {
      if (!rl(socket, 'c:ready', RATE.ready)) return;
      arenas.ready(socket.id);
    });
    // A release is never rate limited, but reaches the room only after a press that got through (agSockets' rule).
    let holdPressed = false;
    on('c:hold', (msg) => {
      const onv = msg.on === 1 || msg.on === true, off = msg.on === 0 || msg.on === false;
      if (!onv && !off) return;
      if (onv) {
        if (!rl(socket, 'c:hold', RATE.hold)) return;
        holdPressed = true;
      } else {
        if (!holdPressed) return;
        holdPressed = false;
      }
      arenas.hold(socket.id, onv);
    });
    on('c:chat', (msg) => {
      if (!rl(socket, 'c:chat', RATE.chat)) return;
      if (typeof msg.text !== 'string') return;
      const r = roomOf(socket);
      if (!r.canChat(socket.id)) return;
      const p = r.bySocket.get(socket.id);
      const g = chatGuard.check(socket.id, msg.text, Date.now());
      if (!g.ok) { if (g.note) socket.emit('c:chatnote', { text: g.note }); return; }
      const line = { name: p.name, c: p.color, text: g.text };
      if (nsp) socket.to(r.ioRoom).emit('c:chat', line);
      socket.emit('c:chat', Object.assign({ me: 1 }, line));
    });
    on('c:leave', () => {
      if (!rl(socket, 'c:leave', RATE.leave)) return;
      if (arenas.paidRoomOf(socket.id)) { socket.emit('c:refused', { why: 'cash-out-to-leave' }); return; }
      room.removePlayer(room.bySocket.get(socket.id));
    });
    socket.on('disconnect', () => {
      try {
        room.removePlayer(room.bySocket.get(socket.id));
        arenas.disconnect(socket.id);
      } catch (e) { log.error('[CHOMP] disconnect', e && e.message); }
      const left = (perIp.get(ip) || 1) - 1;
      if (left <= 0) perIp.delete(ip); else perIp.set(ip, left);
      chatGuard.forget(socket.id);
    });
  }

  if (nsp) {
    nsp.use((socket, next) => {
      const ip = socketClientIp(socket);
      if ((perIp.get(ip) || 0) >= PER_IP) return next(Object.assign(new Error('limit'), { data: { why: 'limit' } }));
      next();
    });
    nsp.on('connection', attach);
  }

  room.fillBots();
  start();
  log.log(`[CHOMP] open: ${room.A.mx}x${room.A.my} modules, ${room.ghosts.length} ghosts; paid rungs ${paid ? 'on' : 'OFF'}`);
  return {
    arenas, room, nsp, paid, door, attach, frame,
    close() { if (timer) clearInterval(timer); timer = null; arenas.stop(); },
  };
}

module.exports = { openChomp, switchOn, paidSwitch, DOOR_TEXT };
