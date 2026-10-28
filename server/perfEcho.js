// The echo behind the ping readout every game shows (Owen 2026-10-27: "the exact same ping and FPS count in every
// single game"; public/js/shared/dsPerfHud.js). The page emits 'ds:ping' with a socket.io acknowledgement and times
// the answer, so every game measures the same thing: one round trip on its own game socket, through whatever is
// queued on it.
//
// install(io) answers on every namespace: the default one (snake, Awesome Tanks, Bowmasters, Knockout, Battleship,
// Head Soccer, Swim, Paper.io and the games built after them), /ag, /sl, /chomp and any made later. It reads nothing
// and touches no room, seat or money: the answer is an empty acknowledgement.
'use strict';

const EVENT = 'ds:ping';
// A page sends one every 2 s (three at 500 ms as it starts). More than this in a window is dropped unanswered, so a
// modified page cannot make the server answer a flood.
const MAX_PER_WINDOW = 6;
const WINDOW_MS = 2000;

function attach(socket, now) {
  const clock = now || Date.now;
  let windowAt = 0;
  let count = 0;
  socket.on(EVENT, function () {
    const ack = arguments[arguments.length - 1];
    if (typeof ack !== 'function') return;
    const t = clock();
    if (t - windowAt >= WINDOW_MS) {
      windowAt = t;
      count = 0;
    }
    if (++count > MAX_PER_WINDOW) return;
    ack();
  });
}

function install(io) {
  const hooked = new Set();
  const hook = (nsp) => {
    if (!nsp || hooked.has(nsp)) return;
    hooked.add(nsp);
    nsp.on('connection', (socket) => attach(socket));
  };
  if (io._nsps) for (const nsp of io._nsps.values()) hook(nsp);
  io.on('new_namespace', hook);
  return hooked;
}

module.exports = { install, attach, EVENT, MAX_PER_WINDOW, WINDOW_MS };
