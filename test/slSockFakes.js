'use strict';
// Test helpers for the /sl socket layer (task T11). TEST ONLY: never imported by shipped code.
//
//   rig(opts)          a fixture-table SlArenas (no bots unless opts.bots, no prey, no auto tick, a fake clock) with
//                      attachSlSockets in hand mode (no namespace); returns { arenas, sockets, ft, wall, ops, pushes,
//                      sock(o) (a connected fake socket), room() }
//   frozenGateTrace(ms)  the input events the FROZEN client's own send gates emit (public/js/sl/slInput.js run
//                      unchanged) over ms of 60 Hz frames with a circling mouse and boost toggles

const fs = require('fs');
const path = require('path');
const { fakeTimers, bareSocket } = require('./slNetFakes');
const { makeFixture } = require('./slLawsFixture');
const { SlArenas } = require('../server/sl/slArenas');
const { attachSlSockets } = require('../server/sl/slSockets');

const QUIET = { log() {}, warn() {}, error() {} };

// index.js socketRL on a fake wall clock.
function fakeRL(wall) {
  return (socket, key, minMs) => {
    const now = wall.t;
    if (!socket._rl) socket._rl = {};
    if (socket._rl[key] !== undefined && now - socket._rl[key] < minMs) return false;
    socket._rl[key] = now;
    return true;
  };
}

// A fake socket.io socket: bareSocket's emit and conn, plus incoming handlers (on / fire), a handshake, and a
// disconnect that fires 'disconnect' once, as socket.io does.
function fakeIoSocket(o) {
  const opt = o || {};
  const s = bareSocket();
  const handlers = new Map();
  s.handshake = { address: opt.ip || '10.0.0.1', headers: opt.headers || {}, auth: opt.auth };
  s.on = (ev, fn) => { handlers.set(ev, fn); return s; };
  s.fire = (ev, ...args) => {
    const fn = handlers.get(ev);
    if (fn) fn(...args);
  };
  s.handlers = handlers;
  s.disconnect = function () {
    if (this.disconnected) return;
    this.disconnected = true;
    this.fire('disconnect', 'server namespace disconnect');
  };
  return s;
}

function rig(opts) {
  const o = opts || {};
  const ft = fakeTimers(1000);
  const wall = { t: 1.7e12 };
  const laws = o.laws || makeFixture(o.patch || {});
  const arenas = new SlArenas(laws, Object.assign({ shippableOnly: false, autoTick: false, bots: o.bots === true,
    seed: o.seed === undefined ? 11 : o.seed, clock: ft.clock, timers: ft.timers, now: () => wall.t, prey: false,
    log: QUIET }, o.arenas || {}));
  const opsState = { maintenance: false };
  const ops = { get: () => opsState };
  const pushes = [];
  const sockets = attachSlSockets(null, arenas, Object.assign({
    socketRL: fakeRL(wall),
    ops,
    now: () => wall.t,
    seed: 3,
    log: QUIET,
    notifyJoin: (name) => { pushes.push(name); },
  }, o.helpers || {}));
  function sock(so) {
    const s = fakeIoSocket(so);
    sockets.attach(s);
    return s;
  }
  return { arenas, sockets, ft, wall, ops: opsState, pushes, sock, room: () => arenas.room(), laws };
}

// The sl:x messages a socket got, flattened.
function layerMsgs(s) {
  const out = [];
  for (const e of s.emitted) if (e.name === 'sl:x' && Array.isArray(e.data)) for (const m of e.data) out.push(m);
  return out;
}

function frozenGateTrace(ms, seed) {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'sl', 'slInput.js'), 'utf8');
  const win = { document: {}, addEventListener() {} };
  new Function('window', SRC)(win);
  const D = win.DuelSlither;
  const S = {};
  D.S = S;
  const clock = { t: 0 };
  const sent = [];
  D.slLoop = { now: () => clock.t };
  D.slNet = { send(ev) { sent.push({ t: clock.t, ev: Object.assign({}, ev) }); } };
  const I = D.slInput;
  I.initInputState(S);
  Object.assign(S, { connected: true, playing: true, wfpr: false, mamu: 0.033, vfrb: 0, ww: 1280, hh: 720 });
  S.slither = { md: false, wmd: false, eang: 0, wang: 0, scang: 1, spang: 1 };
  const k = seed === undefined ? 1 : seed;
  const frameMs = 1000 / 60;
  for (let t = frameMs; t <= ms; t += frameMs) {
    clock.t = t;
    const a = (t / 1000) * 2.3 * k;
    S.xm = Math.round(Math.cos(a) * 200);
    S.ym = Math.round(Math.sin(a) * 200);
    S.slither.wmd = Math.floor(t / 310) % 2 === 1;
    I.stepPing(t);
    I.stepBoostAndAngle(t);
  }
  return sent;
}

module.exports = { QUIET, fakeRL, fakeIoSocket, rig, layerMsgs, frozenGateTrace };
