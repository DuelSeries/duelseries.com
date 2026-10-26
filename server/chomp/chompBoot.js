'use strict';
// Chomp (the hidden Pac-Man-style arena) on its own socket.io namespace, /chomp, served by GET /chomp. Free only: no
// stake, token, wallet or payout is read anywhere in server/chomp. Not in the lobby yet (Owen 2026-10-25: a hobby
// build to get the base down and the look right first).
//
// openChomp({ io, env, helpers: { socketRL, sanitizeName } }) -> { room, close() } or null when CHOMP is off.
// CHOMP: unset/1/true/on/yes on (the default), 0/false/off/no off, anything else off and logged.
//
// Events in (each shape checked, each rate limited per socket, every handler wrapped so nothing a client sends can
// throw out of socket.io):
//   c:join {name}         take a seat (one per socket)
//   c:dir {d, s, c, r}    d 0..3 (up, left, down, right), s the page's input number, c/r its tile at the key press
//   c:leave               give the seat up
// Events out: c:init (on connect: the arena, the live dots, who is in), c:you {id} (seated), c:s (binary snapshot,
// volatile, SNAP_HZ), c:dots {e, b} (eaten / back), c:ev [events], c:lb [[id, score]], c:me {s, l, rk, n},
// c:over {score, rank, of, secs}, c:refused {why}.
//
// The free room is warm from boot like the other games' (bots playing before anyone comes), its bot count on the day
// curve (server/botPopulation.js, 'chomp'). c:chat {text} goes through the shared chat guard (server/chatGuard.js):
// out as c:chat {name, c, text, me} to everyone, a refusal as c:chatnote {text} to the sender alone.

const R = require('../../shared/chompRules');
const chatGuard = require('../chatGuard').shared;
const { gameBotTarget } = require('../botPopulation');
const { ChompRoom, SNAP_EVERY } = require('./chompRoom');
const { socketClientIp } = require('../clientAddr');

const PER_IP = 10;                 // CHOSEN: sockets one address may hold on /chomp
const RATE = { join: 500, dir: 12, leave: 500, chat: 300 };   // CHOSEN: least ms between two events of a kind (flood stops)

function switchOn(env) {
  const v = String(env.CHOMP == null ? '' : env.CHOMP).trim().toLowerCase();
  if (v === '' || v === '1' || v === 'true' || v === 'on' || v === 'yes') return true;
  if (v !== '0' && v !== 'false' && v !== 'off' && v !== 'no') console.warn(`[CHOMP] CHOMP=${v} not understood: off`);
  return false;
}

function isInt(v, lo, hi) { return Number.isInteger(v) && v >= lo && v <= hi; }

function openChomp({ io, env = process.env, helpers = {} }) {
  if (!switchOn(env)) { console.log('[CHOMP] off'); return null; }
  const nsp = io.of('/chomp');
  const room = new ChompRoom({ nsp, botFill: () => gameBotTarget('chomp') });
  const rl = helpers.socketRL || ((s, key, ms) => {
    const now = Date.now(); s._rl = s._rl || {};
    if (s._rl[key] && now - s._rl[key] < ms) return false;
    s._rl[key] = now; return true;
  });
  const clean = helpers.sanitizeName || (n => (typeof n === 'string' ? n : '').replace(/[<>]/g, '').trim().slice(0, 20) || 'Player');
  const perIp = new Map();

  // ---- the loop: fixed 60 Hz steps against the wall clock, so a late timer catches up instead of slowing the game
  let timer = null, last = 0, acc = 0;
  const stepMs = 1000 / R.TICK_HZ;
  function frame() {
    const now = Date.now();
    acc += now - last; last = now;
    if (acc > 250) acc = 250;                  // after a long stall, drop time rather than fast-forward the arena
    while (acc >= stepMs) {
      acc -= stepMs;
      room.step();
      if (room.tick % SNAP_EVERY === 0) send();
    }
  }
  function start() {
    if (timer) return;
    last = Date.now(); acc = 0;
    timer = setInterval(frame, 8);
  }
  function send() {
    // The volatile snapshot goes first: a volatile packet is dropped when the socket is still busy writing, so
    // after any other emit in the same moment it would almost always be lost.
    nsp.volatile.emit('c:s', Buffer.from(room.snapshot()));
    const d = room.drain();
    if (d.dots) nsp.emit('c:dots', d.dots);
    if (d.events) nsp.emit('c:ev', d.events);
    if (room.tick % R.TICK_HZ === 0) {
      nsp.emit('c:lb', room.board());
    }
    if (room.tick % (R.TICK_HZ / 4) === 0) {
      for (const [sid, p] of room.bySocket) {
        const s = nsp.sockets.get(sid);
        if (s) s.emit('c:me', { s: p.score, l: p.lives, rk: room.rankOf(p), n: room.players.size });
      }
    }
  }

  nsp.use((socket, next) => {
    const ip = socketClientIp(socket);
    if ((perIp.get(ip) || 0) >= PER_IP) return next(Object.assign(new Error('limit'), { data: { why: 'limit' } }));
    next();
  });

  nsp.on('connection', (socket) => {
    const ip = socketClientIp(socket);
    const n = (perIp.get(ip) || 0) + 1;
    if (n > PER_IP) { socket.emit('c:refused', { why: 'limit' }); socket.disconnect(true); return; }
    perIp.set(ip, n);
    socket.emit('c:init', room.init());

    function on(ev, fn) {
      socket.on(ev, (msg) => {
        try {
          if (msg != null && (typeof msg !== 'object' || Array.isArray(msg))) return;
          fn(msg || {});
        } catch (e) { console.error(`[CHOMP] ${ev} handler`, e && e.message); }
      });
    }
    on('c:join', (msg) => {
      if (!rl(socket, 'c:join', RATE.join)) return;
      if (room.bySocket.has(socket.id)) return;
      const p = room.addPlayer({ name: clean(msg.name).slice(0, 15), socketId: socket.id });
      if (!p) { socket.emit('c:refused', { why: 'full' }); return; }
      socket.emit('c:you', { id: p.id, metas: room.metas() });
    });
    on('c:dir', (msg) => {
      if (!rl(socket, 'c:dir', RATE.dir)) return;
      const p = room.bySocket.get(socket.id);
      if (!p || !isInt(msg.d, 0, 3) || !isInt(msg.s, 0, 65535)) return;
      const c = isInt(msg.c, 0, room.A.W - 1) ? msg.c : null, r = isInt(msg.r, 0, room.A.H - 1) ? msg.r : null;
      room.input(p, msg.d, msg.s, c, r);
    });
    on('c:chat', (msg) => {
      if (!rl(socket, 'c:chat', RATE.chat)) return;
      const p = room.bySocket.get(socket.id);
      if (!p || p.dying || typeof msg.text !== 'string') return;
      const r = chatGuard.check(socket.id, msg.text, Date.now());
      if (!r.ok) { if (r.note) socket.emit('c:chatnote', { text: r.note }); return; }
      const line = { name: p.name, c: p.color, text: r.text };
      socket.broadcast.emit('c:chat', line);
      socket.emit('c:chat', Object.assign({ me: 1 }, line));
    });
    on('c:leave', () => {
      if (!rl(socket, 'c:leave', RATE.leave)) return;
      room.removePlayer(room.bySocket.get(socket.id));
    });
    socket.on('disconnect', () => {
      room.removePlayer(room.bySocket.get(socket.id));
      const left = (perIp.get(ip) || 1) - 1;
      if (left <= 0) perIp.delete(ip); else perIp.set(ip, left);
      chatGuard.forget(socket.id);
    });
  });

  room.fillBots();
  start();
  console.log(`[CHOMP] open: ${room.A.mx}x${room.A.my} modules, ${room.ghosts.length} ghosts`);
  return { room, nsp, close() { if (timer) clearInterval(timer); timer = null; } };
}

module.exports = { openChomp, switchOn };
