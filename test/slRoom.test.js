'use strict';
// slRoom (SERVER-DESIGN 5, 9.6, 12.4, 15.3; task T9). The room on a fake clock with the fake seat view of
// test/slNetFakes.js (slView is task T8): scheduler and catch-up, the slower clocks, the on-arrival pong and echo, the
// hold through the room (lock record, rings, cash-out, death wins), the 3 s blip glide, the idle pause, dead seats,
// the console contract and the no-money rule.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const W = require('../shared/slWire.js');
const { SlRoom, ROOM_LAW_IDS, fireClock, makeClock, cleanChat } = require('../server/sl/slRoom');
const { createRng } = require('../server/sl/slRng');
const { makeFixture } = require('./slLawsFixture');
const { fakeTimers, bareSocket, fakeView, wangByte, PI2 } = require('./slNetFakes');

const LAWS = makeFixture();
const P = 42.67; // L7
const GRD = 32550; // L1

function makeRoom(o) {
  const opts = o || {};
  const ft = fakeTimers(1000);
  const view = fakeView(opts.view);
  const room = new SlRoom(LAWS, Object.assign({ seed: 7, view, clock: ft.clock, timers: ft.timers, autoTick: false,
    shippableOnly: false, prey: false, now: () => 1.7e12, log: { log() {}, warn() {}, error() {} } }, opts.room));
  return { ft, view, room };
}

function bundles(sock) {
  return sock.emitted.filter((e) => e.name === 'sl:f').map((e) => W.decodeBundle(e.data));
}

function layer(sock) {
  const out = [];
  for (const e of sock.emitted) if (e.name === 'sl:x') for (const m of e.data) out.push(m);
  return out;
}

const ping = () => W.encodeInput([{ type: 'ping' }]);
const angle = (q) => W.encodeInput([{ type: 'angle', q }]);

// Turns the snake toward the map centre, so a test of a few seconds never meets the border.
function aimHome(room, seat, ft, auto) {
  const s = room.sim.snake(seat.snakeId);
  const hx = s.pts[s.pts.length - 1].xx;
  const hy = s.pts[s.pts.length - 1].yy;
  let a = Math.atan2(GRD - hy, GRD - hx);
  if (a < 0) a += PI2;
  const q = Math.round(a / PI2 * 251) % 251;
  room.onInput(seat, angle(q));
  for (let k = 0; k < 12; k++) {
    ft.advance(P);
    if (!auto) room.wake();
  }
  if (auto) ft.run(0);
  return q;
}

test('ROOM_LAW_IDS: every row the room reads is in the table (FIXTURE) and the C_ rows it adds carry a status', () => {
  for (const id of ROOM_LAW_IDS) {
    if (id === 'C_EMERGENCY_FAIL_WAKES') continue;
    assert.ok(LAWS[id], 'missing ' + id);
  }
  assert.throws(() => makeRoomWith({ C_PHASES: 2 }), /C_PHASES/);
  assert.throws(() => makeRoomWith({ C_DISCONNECT: { rule: 'glideThenDie', glideMs: 3000, x: 1 } }), /not built/);
});

function makeRoomWith(patch) {
  return new SlRoom(makeFixture(patch), { seed: 1, view: fakeView(), autoTick: false, shippableOnly: false, prey: false });
}

test('the real table is refused while any row is not shippable (the room stays closed)', () => {
  const { LAWS: REAL } = require('../server/sl/slLaws');
  assert.throws(() => new SlRoom(REAL, { seed: 1, view: fakeView(), autoTick: false }), /not shippable/);
});

test('scheduler on a fake clock: k due steps = k sim steps + ONE view collect and ONE flush; dropped ms counted', () => {
  const { ft, view, room } = makeRoom({ view: { perFrame: true } });
  const sock = bareSocket();
  const seat = room.seat(sock, { nick: 'Owen', cv: 3 });
  assert.ok(seat);
  const tick0 = room.sim.tick();
  const f0 = bundles(sock).length;
  const c0 = view.stats.collects;
  ft.advance(3.5 * P);
  assert.strictEqual(room.wake(), 3);
  assert.strictEqual(room.sim.tick() - tick0, 3);
  assert.strictEqual(view.stats.collects - c0, 1, 'one view collect per wake');
  assert.strictEqual(view.stats.collectFrames[view.stats.collectFrames.length - 1], 3, 'over the 3 steps');
  const b = bundles(sock);
  assert.strictEqual(b.length - f0, 1, 'one flush');
  assert.deepStrictEqual(b[b.length - 1].map((e) => e.type), ['kill_count', 'kill_count', 'kill_count']);
  assert.deepStrictEqual(b[b.length - 1].map((e) => e.count), [tick0 + 1, tick0 + 2, tick0 + 3]);
  // a long stall: at most C_MAX_STEPS (4) run, the rest is dropped and counted
  ft.advance(10 * P);
  assert.strictEqual(room.wake(), 4);
  assert.strictEqual(room.stats.droppedSteps, 6);
  assert.ok(Math.abs(room.stats.droppedMs - 6 * P) < 1e-9);
  assert.strictEqual(room.timing.droppedSteps, 6);
  assert.strictEqual(view.stats.collects - c0, 2);
  // an early wake runs nothing
  ft.advance(P / 4);
  assert.strictEqual(room.wake(), 0);
});

test('accumulator clocks fire on the first step at or after each due time and hit their mean period exactly', () => {
  const { room } = makeRoom();
  // L9, L10, L11.slow (half slots of the L9 timer: 3008.4 / 2, task T14), L11.fast, L8.sweep
  const periods = { lb: 3008.4, mm: 2504.2, zSlow: 1504.2, zFast: 127.43, sweep: 503.91 };
  const fires = { lb: [], mm: [], zSlow: [], zFast: [], sweep: [] };
  const last = {};
  for (const k of Object.keys(periods)) last[k] = 0;
  const N = 3000;
  for (let n = 0; n < N; n++) {
    room.tickOnce();
    for (const k of Object.keys(periods)) {
      if (room.clocks[k].fires !== last[k]) {
        last[k] = room.clocks[k].fires;
        fires[k].push(room.sim.nowMs());
      }
    }
  }
  const end = room.sim.nowMs();
  assert.ok(Math.abs(end - N * P) < 1e-6);
  for (const k of Object.keys(periods)) {
    const per = periods[k];
    const f = fires[k];
    assert.strictEqual(f.length, Math.floor(end / per), k + ' fire count');
    for (let i = 0; i < f.length; i++) {
      const due = (i + 1) * per;
      assert.ok(f[i] >= due - 1e-6 && f[i] - due < P, k + ' fire ' + i + ' at ' + f[i] + ' due ' + due);
    }
    const mean = (f[f.length - 1] - f[0]) / (f.length - 1);
    assert.ok(Math.abs(mean - per) <= P / (f.length - 1) + 1e-9, k + ' mean ' + mean);
    assert.strictEqual(room.clocks[k].missed, 0);
  }
  // the clock helper on its own: a gap is counted, never paid back
  const c = makeClock(100, 0);
  assert.strictEqual(fireClock(c, 99), false);
  assert.strictEqual(fireClock(c, 100), true);
  assert.strictEqual(fireClock(c, 450), true);
  assert.strictEqual(c.missed, 2, 'due 300 and 400 were missed');
  assert.strictEqual(c.due, 500);
});

test('one pong per ping, on arrival, with no tick in between; several POSTs of one burst leave in one bundle', () => {
  const { ft, room } = makeRoom();
  const sock = bareSocket();
  const seat = room.seat(sock, { nick: 'a', cv: 1 });
  const tick0 = room.sim.tick();
  const n0 = bundles(sock).length;
  room.onInput(seat, W.encodeInput([{ type: 'ping' }, { type: 'ping' }, { type: 'ping' }]));
  room.onInput(seat, ping());
  assert.strictEqual(bundles(sock).length, n0, 'nothing leaves before the setImmediate flush');
  ft.runImmediates();
  const b = bundles(sock);
  assert.strictEqual(b.length, n0 + 1);
  assert.deepStrictEqual(b[b.length - 1].map((e) => e.type), ['pong', 'pong', 'pong', 'pong']);
  assert.strictEqual(room.sim.tick(), tick0, 'no tick ran');
  assert.strictEqual(room.stats.pongs, 4);
});

test('own echo on arrival (dir, ang and the wang the next step applies); none while held; the stored byte applies at release', () => {
  const { ft, view, room } = makeRoom();
  const sock = bareSocket();
  const seat = room.seat(sock, { nick: 'a', cv: 1 });
  ft.advance(P);
  room.wake();
  room.onInput(seat, angle(100));
  ft.runImmediates();
  let b = bundles(sock);
  const echo = b[b.length - 1].find((e) => e.type === 'snake_rot');
  const s0 = room.sim.snake(seat.snakeId);
  assert.ok(echo && echo.own && (echo.dir === 1 || echo.dir === 2));
  assert.strictEqual(echo.wang, Math.floor(256 * 100 / 251) * PI2 / 256);
  // L48.rot: their own records always carry ang with dir and wang (S1+S2: never dir+wang alone; task T14); the ang
  // byte is the snake's ang now, floored (L48.angRound)
  assert.strictEqual(Object.keys(echo).sort().join(','), 'ang,dir,own,type,wang', 'their form 3 or 5: dir, ang and wang');
  assert.strictEqual(echo.ang, Math.floor(s0.ang * 256 / PI2) * PI2 / 256);
  assert.strictEqual(view.stats.notes, 1, 'the view was told');
  const n = b.length;
  ft.advance(P);
  room.wake();
  const s = room.sim.snake(seat.snakeId);
  assert.strictEqual(wangByte(s.wang), Math.floor(256 * 100 / 251), 'the sim applied the echoed byte');
  assert.strictEqual(s.dir, echo.dir);
  b = bundles(sock);
  for (let i = n; i < b.length; i++) {
    assert.ok(!b[i].some((e) => e.type === 'snake_rot' && Math.round(e.wang * 256 / PI2) === Math.floor(256 * 100 / 251) && e !== echo),
      'no second copy of the echoed wang from the tick');
  }
  // hold: no echo while held
  room.onHold(seat, 1);
  ft.advance(P);
  room.wake();
  assert.ok(s.holdMult !== null);
  const e0 = room.stats.echoes;
  room.onInput(seat, angle(30));
  room.onInput(seat, angle(31));
  ft.runImmediates();
  assert.strictEqual(room.stats.echoes, e0, 'no own echo while held (SERVER-DESIGN 5.2 step 3)');
  ft.advance(P);
  room.wake();
  assert.notStrictEqual(wangByte(s.wang), Math.floor(256 * 31 / 251), 'steering locked');
  room.onHold(seat, 0);
  ft.advance(P);
  room.wake();
  assert.strictEqual(s.holdMult, null);
  assert.strictEqual(wangByte(s.wang), Math.floor(256 * 31 / 251), 'the newest stored byte applies at release');
});

test('hold start through the room: ONE legal lock record (dir 1 or 2, ang = wang) and the ring to the holders', () => {
  const { ft, room } = makeRoom();
  const sockA = bareSocket();
  const a = room.seat(sockA, { nick: 'a', cv: 1 });
  ft.advance(P);
  room.wake();
  room.onHold(a, 1);
  ft.advance(P);
  room.wake();
  const b = bundles(sockA);
  const locks = b[b.length - 1].filter((e) => e.type === 'snake_rot');
  assert.strictEqual(locks.length, 1);
  const lk = locks[0];
  assert.deepStrictEqual(Object.keys(lk).sort(), ['ang', 'dir', 'own', 'type', 'wang']);
  assert.ok(lk.dir === 1 || lk.dir === 2);
  assert.strictEqual(lk.ang, lk.wang);
  const s = room.sim.snake(a.snakeId);
  assert.strictEqual(wangByte(s.wang), wangByte(lk.wang));
  const rings = layer(sockA).filter((m) => m.t === 'hold');
  assert.deepStrictEqual(rings, [{ t: 'hold', id: a.snakeId, on: 1, need: 3000 }]);
  room.onHold(a, 0);
  ft.advance(P);
  room.wake();
  assert.deepStrictEqual(layer(sockA).filter((m) => m.t === 'hold').pop(), { t: 'hold', id: a.snakeId, on: 0 });
});

// Upstream of one phone on long-polling at round trip R with loss: the client keeps one ping outstanding (the next
// one after the pong and 250 ms after the previous ping, slInput.js:257-265); the engine.io client sends one POST
// at a time carrying everything emitted meanwhile (polling.js:138-145); a lost request is resent after an RTO of
// 1000 ms that doubles on each loss in a row (RFC 6298's initial RTO; a TEST model, not a law). Downstream the pong
// leaves on arrival (the bare socket is always ready) and takes R / 2, with the same loss model. Returns the server
// arrival times of every POST with what it carried.
function upstreamTrace(seed, R, loss, durMs) {
  const rng = createRng(seed);
  const lose = () => rng.next() < loss;
  const delay = () => {
    let d = R / 2;
    let rto = 1000;
    while (lose()) {
      d += rto;
      rto *= 2;
    }
    return d;
  };
  const out = [];
  const ev = [];
  const at = (t, k) => ev.push([t, k]);
  let pending = ['hold', 'ping'];
  let inFlight = false;
  let lastPing = 0;
  at(0, 'post');
  while (ev.length) {
    ev.sort((x, y) => x[0] - y[0]);
    const [t, k] = ev.shift();
    if (t > durMs) break;
    if (k === 'post') {
      if (inFlight || !pending.length) continue;
      inFlight = true;
      const arr = t + delay();
      out.push({ at: arr, msgs: pending });
      pending = [];
      at(arr, 'arrive');
      at(arr + R / 2, 'postDone');
    } else if (k === 'postDone') {
      inFlight = false;
      at(t, 'post');
    } else if (k === 'arrive') {
      // the pong of a ping in that POST reaches the client
      at(t + delay(), 'pong');
    } else if (k === 'pong') {
      const next = Math.max(t, lastPing + 250);
      at(next, 'ping');
    } else if (k === 'ping') {
      lastPing = t;
      pending.push('ping');
      at(t, 'post');
    }
  }
  return out;
}

test('a hold completes on a 300 ms round trip, 2 percent loss upstream trace (POST batching): never ended by a gap', () => {
  const R = 300;
  let completed = 0;
  let safetyEnds = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const ft = fakeTimers(1000);
    const room = new SlRoom(LAWS, { seed: 100 + seed, view: fakeView(), clock: ft.clock, timers: ft.timers,
      shippableOnly: false, prey: false, now: () => 1.7e12, log: { log() {}, warn() {}, error() {} } });
    const sock = bareSocket();
    const seat = room.seat(sock, { nick: 'p' + seed, cv: 2 });
    aimHome(room, seat, ft, true);
    ft.run(600);
    const t0 = ft.clock();
    const trace = upstreamTrace(seed, R, 0.02, 4500);
    let pressAt = NaN;
    for (const post of trace) {
      ft.timers.setTimeout(() => {
        for (const m of post.msgs) {
          if (m === 'hold') {
            pressAt = ft.clock();
            room.onHold(seat, 1);
          } else {
            room.onInput(seat, ping());
          }
        }
      }, post.at);
    }
    // the longest silence while the hold runs
    let maxGap = 0;
    for (let i = 1; i < trace.length; i++) {
      if (trace[i - 1].at < 3200) maxGap = Math.max(maxGap, trace[i].at - trace[i - 1].at);
    }
    ft.run(4500);
    const cashed = layer(sock).find((m) => m.t === 'cashed');
    if (cashed) {
      completed++;
      assert.ok(Number.isFinite(cashed.len));
      assert.strictEqual(room.sim.snake(seat.snakeId), null, 'the snake left the sim');
      assert.strictEqual(room.stats.deaths, 0, 'no death: no food');
      assert.ok(pressAt - t0 >= R / 2);
      // the cash-out message goes before the own end in the stream
      const order = sock.emitted.map((e) => e.name === 'sl:x' ? (e.data.some((m) => m.t === 'cashed') ? 'cashed' : 'x')
        : (W.decodeBundle(e.data).some((r) => r.type === 'dead') ? 'dead' : 'f'));
      assert.ok(order.indexOf('cashed') >= 0 && order.indexOf('cashed') < order.indexOf('dead'));
    } else {
      assert.ok(maxGap > 2000, 'seed ' + seed + ': no cash-out although the longest silence was ' + maxGap);
      safetyEnds++;
    }
    if (maxGap <= 2000) assert.ok(cashed, 'seed ' + seed + ' completes');
    assert.strictEqual(room.holds.stats.safety, cashed ? 0 : 1);
    room.stop();
  }
  assert.ok(completed >= 36, 'completed ' + completed + ' of 40 (safety ends ' + safetyEnds + ')');
  if (process.env.SL_T9_VERBOSE) console.log('hold trace: completed', completed, 'of 40, safety ends', safetyEnds);
});

test('the hold completes C_HOLD_MS after the press arrived, and a death in the completing tick wins', () => {
  {
    const { ft, room } = makeRoom();
    const sock = bareSocket();
    const seat = room.seat(sock, { nick: 'a', cv: 1 });
    aimHome(room, seat, ft, false);
    ft.advance(10);
    room.onHold(seat, 1);
    const pressSim = room.sim.nowMs() + P - Math.round(P - 10);
    let t = 0;
    while (!layer(sock).some((m) => m.t === 'cashed')) {
      ft.advance(P);
      room.onInput(seat, ping());
      room.wake();
      assert.ok(++t < 100);
    }
    const doneSim = room.sim.nowMs();
    assert.ok(doneSim - pressSim >= 3000 && doneSim - pressSim < 3000 + P, 'held ' + (doneSim - pressSim));
    const end = bundles(sock).pop();
    assert.deepStrictEqual(end.slice(-2).map((e) => e.type), ['dead', 'snake_remove']);
    assert.strictEqual(seat.dead, true);
    assert.strictEqual(seat.cashed, true);
    assert.strictEqual(room.stats.cashouts, 1);
  }
  {
    const { ft, room } = makeRoom();
    const sock = bareSocket();
    const seat = room.seat(sock, { nick: 'a', cv: 1 });
    aimHome(room, seat, ft, false);
    room.onHold(seat, 1);
    for (;;) {
      ft.advance(P);
      room.onInput(seat, ping());
      const next = room.sim.nowMs() + P;
      if (room.holds.heldMs(seat.snakeId, next) >= 3000) {
        room.sim.kill(seat.snakeId); // dies in step 4 of the completing tick
        room.wake();
        break;
      }
      room.wake();
    }
    assert.ok(!layer(sock).some((m) => m.t === 'cashed'), 'the death wins the tie');
    assert.strictEqual(room.stats.cashouts, 0);
    assert.strictEqual(room.stats.deaths, 1);
    assert.strictEqual(seat.dead, true);
    assert.strictEqual(seat.cashed, false);
    assert.strictEqual(room.holds.holding(seat.snakeId), false);
    assert.strictEqual(room.holds.size(), 0);
  }
});

test('a connection blip: the snake glides straight about 3 s (C_DISCONNECT glideMs), then dies with its food', () => {
  const { ft, room } = makeRoom();
  const sock = bareSocket();
  const seat = room.seat(sock, { nick: 'a', cv: 1 });
  aimHome(room, seat, ft, false);
  room.onInput(seat, W.encodeInput([{ type: 'boost', on: true }, { type: 'angle', q: 3 }]));
  const id = seat.snakeId;
  const s = room.sim.snake(id);
  assert.ok(room.unseat(sock, 'transport close'));
  assert.strictEqual(room.seats.size, 0);
  const goneSim = room.sim.nowMs();
  ft.advance(P);
  room.wake();
  const lockByte = wangByte(s.wang);
  assert.strictEqual(s.boosting, false, 'the boost ended');
  let diedAt = NaN;
  let lastX = s.pts[s.pts.length - 1].xx;
  while (room.sim.snake(id)) {
    assert.strictEqual(wangByte(s.wang), lockByte, 'straight: wang stays the locked byte');
    ft.advance(P);
    room.wake();
    if (!room.sim.snake(id)) diedAt = room.sim.nowMs();
    assert.ok(room.sim.nowMs() - goneSim < 4000);
  }
  assert.ok(s.pts[s.pts.length - 1].xx !== lastX, 'it kept moving');
  const glide = diedAt - goneSim;
  assert.ok(glide >= 3000 && glide <= 3000 + 3 * P, 'glided ' + glide + ' ms');
  assert.strictEqual(room.stats.glideDeaths, 1);
  assert.strictEqual(room.stats.deaths, 1);
  assert.strictEqual(room.orphans.size, 0);
});

test('a dead seat with no ping for 5 s is closed (C_DEAD_SEAT_MS); pings keep it until its own close', () => {
  const { ft, room } = makeRoom();
  const sockA = bareSocket();
  const a = room.seat(sockA, { nick: 'a', cv: 1 });
  const sockB = bareSocket();
  const b = room.seat(sockB, { nick: 'b', cv: 2 });
  room.sim.kill(a.snakeId);
  room.sim.kill(b.snakeId);
  ft.advance(P);
  room.wake();
  assert.ok(a.dead && b.dead);
  for (let t = 0; t < 7000; t += P) {
    ft.advance(P);
    room.onInput(b, ping());
    room.wake();
  }
  assert.strictEqual(sockA.disconnected, true, 'no ping for 5 s: closed');
  assert.strictEqual(room.seatOf(sockA), null);
  assert.strictEqual(sockB.disconnected, false, 'a pinging dead tab stays');
});

test('idle pause: no human seated for C_IDLE_PAUSE_MS (60 s) stops the ticking; the first join resumes it', () => {
  const ft = fakeTimers(1000);
  const room = new SlRoom(LAWS, { seed: 5, view: fakeView(), clock: ft.clock, timers: ft.timers, shippableOnly: false,
    prey: false, now: () => 1.7e12, log: { log() {}, warn() {}, error() {} } });
  assert.strictEqual(room.sim.tick(), 0, 'nothing ticks before anyone sits');
  const sock = bareSocket();
  const seat = room.seat(sock, { nick: 'a', cv: 1 });
  aimHome(room, seat, ft, true);
  ft.run(1000);
  assert.ok(room.sim.tick() > 20);
  room.unseat(sock, 'leave');
  ft.run(59000);
  assert.strictEqual(room.paused, false, 'still ticking inside the 60 s');
  ft.run(2000);
  assert.strictEqual(room.paused, true);
  assert.strictEqual(room.timer, null);
  assert.strictEqual(ft.pending(), 0);
  const frozen = room.sim.tick();
  ft.run(10000);
  assert.strictEqual(room.sim.tick(), frozen, 'paused: no ticks');
  const sock2 = bareSocket();
  room.seat(sock2, { nick: 'b', cv: 1 });
  assert.strictEqual(room.paused, false);
  ft.run(500);
  assert.ok(room.sim.tick() >= frozen + 11, 'resumed');
  assert.strictEqual(room.stats.pauses, 1);
  assert.strictEqual(room.stats.resumes, 1);
  room.stop();
});

test('chat is cleaned (C_CHAT) and sent to every seat; a kill line only when a human is involved (C_KILLFEED)', () => {
  const { ft, room } = makeRoom();
  const sa = bareSocket();
  const sb = bareSocket();
  const a = room.seat(sa, { nick: 'Ann', cv: 1 });
  const b = room.seat(sb, { nick: 'Bob', cv: 2 });
  room.onChat(a, '  <b>hi</b> ' + 'x'.repeat(200));
  ft.runImmediates();
  const m = layer(sb).find((x) => x.t === 'chat');
  assert.strictEqual(m.name, 'Ann');
  assert.strictEqual(m.text, ('bhi/b ' + 'x'.repeat(200)).slice(0, 120));
  assert.strictEqual(cleanChat('<<>>', room.R), '');
  assert.strictEqual(room.onChat(a, '<>'), false);
  room._onDeath({ id: b.snakeId, killer: a.snakeId, cause: 'snake' }, room.sim.tick(), room.sim.nowMs());
  room._onDeath({ id: 999, killer: 998, cause: 'snake' }, room.sim.tick(), room.sim.nowMs());
  ft.advance(P);
  room.wake();
  const kills = layer(sa).filter((x) => x.t === 'kill');
  assert.deepStrictEqual(kills, [{ t: 'kill', killer: 'Ann', victim: 'Bob' }]);
});

test('console contract: a free room (no worth, no stake), bots only through a driver, the human cap', () => {
  const { room } = makeRoom();
  const sock = bareSocket();
  room.seat(sock, { nick: 'a', cv: 1 });
  assert.strictEqual(room.lobbyType, 'sl_na_s0');
  assert.strictEqual(room.playerCount, 1);
  assert.strictEqual(room.botCount, 0);
  assert.strictEqual(room.botsAllowed(), true);
  assert.strictEqual(room.addBot(), null, 'no bot driver yet (slBots, T12)');
  assert.strictEqual(room.clearBots(), 0);
  assert.strictEqual(room.liveStakeTotal(), 0);
  assert.strictEqual(room.floorWorth, undefined);
  const snakes = Array.from(room.snakes.values());
  assert.deepStrictEqual(snakes, [{ alive: true, isBot: false, worth: 0 }]);
  const small = new SlRoom(makeFixture({ C_HUMAN_CAP: 1 }), { seed: 2, view: fakeView(), autoTick: false, shippableOnly: false, prey: false });
  assert.ok(small.seat(bareSocket(), { nick: 'x', cv: 0 }));
  assert.strictEqual(small.seat(bareSocket(), { nick: 'y', cv: 0 }), null);
  assert.strictEqual(small.refusal(), 'full');
});

test('three wakes in a row that throw close the room (C_EMERGENCY_FAIL_WAKES); a throw never leaves the timer', () => {
  const ft = fakeTimers(1000);
  const view = fakeView({ throwOnCollect: true });
  const room = new SlRoom(LAWS, { seed: 9, view, clock: ft.clock, timers: ft.timers, shippableOnly: false, prey: false,
    now: () => 1.7e12, log: { log() {}, warn() {}, error() {} } });
  let closedWith = null;
  room.onClosed = (r, sockets) => {
    closedWith = sockets;
  };
  const sock = bareSocket();
  room.seat(sock, { nick: 'a', cv: 1 });
  ft.run(10 * P);
  assert.strictEqual(room.closed, true);
  assert.strictEqual(room.stopped, true);
  assert.strictEqual(room.stats.failedWakes, 3);
  assert.deepStrictEqual(closedWith, [sock]);
  assert.ok(room.safeStats.total >= 3);
});

test('no money: the T9 files require no money or database module', () => {
  const banned = ['money', 'Usdc', 'Wallet', 'paperPayout', 'stakeLedger', 'entryStore', 'db'];
  for (const f of ['slRoom.js', 'slSendQueue.js', 'slHold.js', 'slSafe.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'sl', f), 'utf8');
    const reqs = Array.from(src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)).map((m) => m[1]);
    for (const r of reqs) {
      const base = path.basename(r).replace(/\.js$/, '');
      assert.ok(banned.indexOf(base) < 0, f + ' requires ' + r);
    }
    assert.ok(!/Math\.random/.test(src), f + ' uses Math.random');
  }
});

// Fixer pass (2026-10-10): others see the cash-out ring while it holds (Owen 17:00). A seat that picks the holding
// snake up after the hold started gets the ring with the time already held; when its view drops the snake it gets the
// ring's end. Real slView, so the adds and removals are the real ones.
test('ring for a late viewer: a join next to a holding snake gets {hold on 1, need, elapsed}; a view removal ends it', () => {
  const ft = fakeTimers(1000);
  const room = new SlRoom(LAWS, { seed: 9, clock: ft.clock, timers: ft.timers, autoTick: false, shippableOnly: false,
    prey: false, now: () => 1.7e12, log: { log() {}, warn() {}, error() {} } });
  const sockA = bareSocket();
  const a = room.seat(sockA, { nick: 'a', cv: 1 });
  aimHome(room, a, ft, false);
  room.onHold(a, 1);
  for (let k = 0; k < 24; k++) { // about 1 s of hold, pinging like their client (the safety net needs upstream)
    if (k % 6 === 0) room.onInput(a, ping());
    ft.advance(P);
    room.wake();
  }
  assert.ok(room.holds.holding(a.snakeId), 'A holds');
  const heldNow = room.holds.heldMs(a.snakeId, room.sim.nowMs());
  assert.ok(heldNow > 900 && heldNow < 1100, 'held ' + heldNow);
  // B spawns 600 units from A's head (inside its first view)
  const sa = room.sim.snake(a.snakeId);
  const hx = sa.pts[sa.pts.length - 1].xx;
  const hy = sa.pts[sa.pts.length - 1].yy;
  const spawn = room.sim.spawn;
  room.sim.spawn = (o) => spawn(Object.assign({}, o, { x: hx + 600, y: hy, ang: 0 }));
  const sockB = bareSocket();
  const b = room.seat(sockB, { nick: 'b', cv: 2 });
  room.sim.spawn = spawn;
  const addA = bundles(sockB).flat().find((e) => e.type === 'snake_add' && e.id === a.snakeId);
  assert.ok(addA, 'B was sent A');
  const rings = layer(sockB).filter((m) => m.t === 'hold');
  assert.strictEqual(rings.length, 1);
  assert.deepStrictEqual(Object.keys(rings[0]).sort(), ['elapsed', 'id', 'need', 'on', 't']);
  assert.deepStrictEqual([rings[0].id, rings[0].on, rings[0].need], [a.snakeId, 1, 3000]);
  assert.strictEqual(rings[0].elapsed, Math.round(heldNow), 'the time A has held');
  // a seat that does not hold A gets nothing; the own seat gets no elapsed message for itself
  assert.strictEqual(layer(sockA).filter((m) => m.t === 'hold' && m.elapsed !== undefined).length, 0);
  // B's view drops A (the hook on a removal): the ring ends for B only
  const n = layer(sockB).length;
  room._pushEvents(b, room.sim.tick(), [{ type: 'snake_remove', id: a.snakeId, kill: false }]);
  room.seatOf(sockB).queue.flush(ft.clock());
  assert.deepStrictEqual(layer(sockB).slice(n).filter((m) => m.t === 'hold'), [{ t: 'hold', id: a.snakeId, on: 0 }]);
});
