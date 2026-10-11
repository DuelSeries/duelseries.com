'use strict';
// Resume after a blip, end to end (task T16b; Owen Q10 "glide 3 s from the start"): THEIR frozen client (every
// script of public/sl.html, unchanged, in the vm page of test/slVmPage.js) with OUR layer transport
// (public/js/slx/slxNet.js, active: no harness transport) over a fake socket.io link to the REAL server side
// (slSockets, slArenas, slRoom with the real sim, view and send queue; test/slSockFakes.js rig, FIXTURE table).
//
// The link: 40 ms each way; a handshake takes two trips; a blip drops every message in flight both ways, the client
// sees its socket close at once (one failed poll ends an engine.io polling socket), the server sees it later (or
// never: a silent drop it has not timed out yet), and connections fail until the link is back.
// Checked: back at 1 s, the player keeps the SAME snake, their close never runs, their own body equals the server's
// (the last 12 points, within 0.5 units, at some server tick), no wire error, no apply throw, no page error. Back at
// 3.5 s, the snake had died at the glide end and their client still gets its own death, so the life ends on the death
// path (the 'Match Results' card), not a lost connection. Away past the window, their close runs as before.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const V = require('./slVmPage');
const { rig } = require('./slSockFakes');
const slSnake = require('../server/sl/slSnake');

const SLXNET = fs.readFileSync(path.join(V.ROOT, 'public/js/slx/slxNet.js'), 'utf8');
const LAT = 40;
const STEP = 1000 / 60;

function world(seed) {
  const r = rig({ seed });
  const room = r.room();
  const q = []; // { at, seq, fn }
  let seq = 0;
  const link = { up: true, epoch: 0 };
  const clients = [];
  let P = null;
  const later = (ms, fn) => q.push({ at: P.vnow + ms, seq: ++seq, fn });

  // socket.io-client look-alike (the parts their transport and slxNet use)
  function io(ns, opts) {
    const cs = { ns, opts, connected: false, dead: false, handlers: {}, ss: null, emitted: [], disconnects: 0 };
    clients.push(cs);
    cs.on = (ev, fn) => { (cs.handlers[ev] = cs.handlers[ev] || []).push(fn); return cs; };
    cs.fire = (ev, a) => { for (const f of (cs.handlers[ev] || []).slice()) f(a); };
    cs.emit = (ev, data) => {
      if (!cs.connected) return;
      cs.emitted.push(ev);
      let d;
      if (data && typeof data === 'object' && typeof data.BYTES_PER_ELEMENT === 'number') d = Buffer.from(Array.from(data));
      else d = data === undefined ? undefined : JSON.parse(JSON.stringify(data)); // the wire: plain node values
      const s = cs.ss;
      const ep = link.epoch;
      if (!link.up) return;
      later(LAT, () => { if (ep === link.epoch && s && !s.disconnected) s.fire(ev, d); });
    };
    cs.disconnect = () => {
      cs.disconnects++;
      if (cs.dead) return;
      cs.dead = true;
      if (!cs.connected) return;
      cs.connected = false;
      const s = cs.ss;
      const ep = link.epoch;
      if (link.up) later(LAT, () => { if (ep === link.epoch && s && !s.disconnected) { s.disconnected = true; s.fire('disconnect', 'client namespace disconnect'); } });
      cs.fire('disconnect', 'io client disconnect');
    };
    const ep = link.epoch;
    const fail = () => { if (!cs.dead && !cs.connected) { cs.dead = true; cs.fire('connect_error', new Error('xhr poll error')); } };
    if (!link.up) {
      later(2 * LAT, fail);
      return cs;
    }
    later(LAT, () => {
      if (cs.dead) return;
      if (ep !== link.epoch) return fail();
      const ss = r.sock({ ip: '10.0.0.1', auth: opts && opts.auth ? JSON.parse(JSON.stringify(opts.auth)) : undefined });
      cs.ss = ss;
      const emit0 = ss.emit.bind(ss);
      ss.emit = (name, data) => {
        emit0(name, data);
        if (!link.up) return;
        const e2 = link.epoch;
        const d = name === 'sl:f' ? new P.U8(Array.from(data)) : JSON.parse(JSON.stringify(data));
        later(LAT, () => { if (e2 === link.epoch && cs.connected) cs.fire(name, d); });
      };
      const disc0 = ss.disconnect.bind(ss);
      ss.disconnect = function () {
        if (this.disconnected) return;
        disc0();
        if (!link.up) return;
        const e2 = link.epoch;
        later(LAT, () => {
          if (e2 !== link.epoch || !cs.connected) return;
          cs.connected = false;
          cs.dead = true;
          cs.fire('disconnect', 'io server disconnect');
        });
      };
      later(LAT, () => {
        if (cs.dead) return;
        if (ep !== link.epoch) return fail();
        cs.connected = true;
        cs.fire('connect');
      });
    });
    return cs;
  }
  io.protocol = 5;

  P = V.makePage({ step: STEP, vw: 1280, vh: 720, ls: null, seed, warm: 60, openFrame: 64, frames: 0 }, [], {
    scripts: V.SRC.concat([['public/js/slx/slxNet.js', SLXNET]]),
    win: { DuelSlitherConfig: { assetBase: '/' }, io },
  });

  // the server's own snake, every step: its body (for the mirror) and whether it lives
  const snaps = [];
  let ownId = 0;
  const step0 = room.sim.step;
  room.sim.step = function () {
    const log = step0.apply(this, arguments);
    const s = ownId ? room.sim.snake(ownId) : null;
    if (s) {
      snaps.push(s.pts.map((p) => [p.xx, p.yy]));
      if (snaps.length > 400) snaps.shift();
    }
    return log;
  };

  let lastV = null;
  P.socketHook = function () {
    q.sort((a, b) => a.at - b.at || a.seq - b.seq);
    while (q.length && q[0].at <= P.vnow) q.shift().fn();
    if (lastV === null) lastV = P.vnow;
    const dt = P.vnow - lastV;
    lastV = P.vnow;
    r.ft.advance(dt);
    r.wall.t += dt;
    room.wake();
    r.ft.runImmediates();
  };

  const W = {
    r, room, P, link, clients, snaps, seen: [],
    setOwn(id) { ownId = id; },
    // a blip: the client's live sockets close at once; the server sees it after seenMs (null: never)
    blip(seenMs) {
      link.up = false;
      link.epoch++;
      const servers = [];
      for (const cs of clients) {
        if (!cs.connected) continue;
        cs.connected = false;
        cs.dead = true;
        if (cs.ss) servers.push(cs.ss);
        cs.fire('disconnect', 'transport close');
      }
      if (seenMs !== null) {
        later(seenMs, () => {
          for (const s of servers) if (!s.disconnected) { s.disconnected = true; s.fire('disconnect', 'transport close'); }
        });
      }
    },
    restore() { link.up = true; },
    run(ms, steer) {
      const end = P.vnow + ms;
      let nextSteer = 0;
      while (P.vnow < end) {
        P.step();
        if (steer && P.vnow >= nextSteer) {
          nextSteer = P.vnow + 300;
          W.steerHome();
        }
      }
    },
    // the mouse toward the map centre, so a run of seconds never meets the border
    steerHome() {
      const S = P.win.DuelSlither.S;
      const o = S.slither;
      if (!o || !S.playing) return;
      const dx = S.grd - o.xx;
      const dy = S.grd - o.yy;
      const len = Math.hypot(dx, dy) || 1;
      P.fire('m', [String(640 + dx / len * 150), String(360 + dy / len * 150)]);
    },
  };
  P.boot();
  const slx = P.win.DuelSlither.slx;
  assert.strictEqual(slx.active, true, 'the layer is active (no harness transport)');
  for (const ev of ['open', 'resuming', 'resumed', 'close', 'ownDead']) slx.on(ev, () => W.seen.push(ev));
  slx.on('close', (info) => { W.closeInfo = JSON.parse(JSON.stringify(info)); });
  for (let k = 0; k < 60; k++) P.step();
  P.win.DuelSlither.play('Owen');
  return W;
}

// Play until the own snake is on the client and the server, then a few seconds of steering.
function startLife(W) {
  const D = W.P.win.DuelSlither;
  for (let i = 0; i < 600 && !(D.S.playing && D.S.slither); i++) W.P.step();
  assert.ok(D.S.playing && D.S.slither, 'a life started');
  const id = D.S.slither.id;
  const seat = Array.from(W.room.seats.values())[0];
  assert.strictEqual(seat.snakeId, id, 'their own snake is the seat\'s');
  W.setOwn(id);
  W.run(1500, true);
  return { D, id, seat };
}

// Their own body (the head side, no dying point) equals the server's at some recent tick.
function assertMirror(W, D) {
  const pts = D.S.slither.pts.filter((p) => !p.dying).map((p) => [p.xx, p.yy]);
  const K = Math.min(12, pts.length);
  const mine = pts.slice(-K);
  let best = Infinity;
  for (const s of W.snaps) {
    if (s.length < K) continue;
    const theirs = s.slice(-K);
    let worst = 0;
    for (let i = 0; i < K; i++) worst = Math.max(worst, Math.hypot(mine[i][0] - theirs[i][0], mine[i][1] - theirs[i][1]));
    best = Math.min(best, worst);
  }
  assert.ok(best < 0.5, 'their own body matches the server at some tick: worst point off by ' + best.toFixed(3));
}

function assertClean(W, D) {
  assert.strictEqual(D.stats.wireErrors, 0, 'wire errors');
  assert.strictEqual(D.stats.applyThrows, 0, 'apply throws: ' + D.stats.lastThrow);
  assert.deepStrictEqual(W.P.errors, [], 'page errors');
  assert.strictEqual(D.slx.errors, 0, 'layer errors');
}

test('end to end: a 1 s blip the server saw; back in time, the player keeps the same snake and their own body', () => {
  const W = world(41);
  const { D, id, seat } = startLife(W);
  assertMirror(W, D);
  W.blip(200);
  W.run(1000);
  assert.ok(W.room.parked.has(seat), 'the server parked the seat');
  assert.ok(W.room.orphans.has(id), 'the snake glides');
  assert.strictEqual(D.slx.resuming(), true);
  W.restore();
  W.run(1000);
  assert.strictEqual(D.slx.resuming(), false);
  assert.deepStrictEqual(W.seen, ['open', 'resuming', 'resumed'], 'one life: no second open, no close');
  assert.strictEqual(D.S.slither.id, id, 'the same snake');
  assert.ok(D.S.playing);
  assert.ok(W.room.sim.snake(id), 'alive on the server');
  assert.strictEqual(W.room.stats.backs, 1);
  assert.strictEqual(W.room.stats.glideDeaths, 0);
  W.run(2000, true);                                             // and it plays on, steered from the new socket
  assertMirror(W, D);
  assertClean(W, D);
  assert.ok(D.S.playing && D.S.slither.id === id);
});

test('end to end: a blip the server never saw (its socket still open); the new socket takes the seat over', () => {
  const W = world(42);
  const { D, id } = startLife(W);
  W.blip(null);
  W.run(700);
  W.restore();
  W.run(1200);
  assert.deepStrictEqual(W.seen, ['open', 'resuming', 'resumed']);
  assert.strictEqual(W.room.stats.takeovers, 1);
  assert.strictEqual(D.S.slither.id, id);
  W.run(2000, true);
  assertMirror(W, D);
  assertClean(W, D);
});

test('end to end: back at 3.5 s; the snake died at the glide end and their client gets its own death (the death card)', () => {
  const W = world(43);
  const { D, id } = startLife(W);
  W.blip(100);
  W.run(3500);
  assert.strictEqual(W.room.sim.snake(id), null, 'dead on the server');
  assert.strictEqual(W.room.stats.glideDeaths, 1);
  W.restore();
  W.run(1500);
  assert.ok(W.seen.includes('resumed'));
  assert.ok(W.seen.includes('ownDead'), 'their client applied its own death');
  assert.notStrictEqual(D.S.dead_mtm, -1, 'their death fade runs');
  W.run(9000);
  // the death path: their fade ends in their own close (sl:leave, no close event), as after any death; the card
  // (slxCard) titles it from ownDead: Match Results, not Connection lost
  assert.deepStrictEqual(W.seen, ['open', 'resuming', 'resumed', 'ownDead']);
  const last = W.clients[W.clients.length - 1];
  assert.ok(last.emitted.includes('sl:leave'), 'their own close after the fade');
  assert.strictEqual(W.room.seats.size, 0);
  assert.strictEqual(W.room.parked.size, 0);
  assertClean(W, D);
});

test('end to end: away past the window (9 s); their close runs once, as a lost connection', () => {
  const W = world(44);
  const { D } = startLife(W);
  W.blip(100);
  W.run(9000);
  assert.deepStrictEqual(W.seen, ['open', 'resuming', 'close']);
  assert.strictEqual(W.closeInfo.playing, true);
  assert.strictEqual(W.closeInfo.sawDead, false);
  W.restore();
  W.run(1000);
  assert.strictEqual(W.seen.filter((e) => e === 'close').length, 1);
  assert.strictEqual(W.room.parked.size, 0);
  assertClean(W, D);
});
