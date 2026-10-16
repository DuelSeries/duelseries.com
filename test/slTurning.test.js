'use strict';
// Turning (task TURNING, 2026-10-11; slither-reference/recordings/TURNING.md). Owen: our turning was "not smooth,
// wide". Measured against his slither.io recordings, two server faults made the frozen client correct itself on every
// packet: (1) a new point was placed one msl along the CURRENT ang from the last point, 17 units inside the head path
// the client predicts (theirs: 2.0 median head error); (2) the on-arrival echo carried the ang of the last update while
// the client had turned on since, throwing it back 0.06 rad on 62 percent of hard-turn echoes (theirs: 3.4 percent),
// and the next update threw it forward again (the slot applied from the update start). Expected numbers are literals
// from the SERVER-LAWS rows (L5 msl 42, L7 P 42.67, L12 sp 5.79 at sct 2, L14 the client turn formula with K 111).

const test = require('node:test');
const assert = require('node:assert/strict');

const W = require('../shared/slWire.js');
const { createSim } = require('../server/sl/slSim');
const slSnake = require('../server/sl/slSnake');
const { SlRoom } = require('../server/sl/slRoom');
const { FIXTURE, makeFixture } = require('./slLawsFixture');
const { fakeTimers, bareSocket, fakeView } = require('./slNetFakes');

const PI2 = 2 * Math.PI;
const P = 42.67; // L7
const MSL = 42; // L5
const C = 32550; // L1 grd: the map centre
const SP2 = 5.79; // L12 at sct 2: 5.39 + 0.4 x 1
const RATE2 = 0.004125; // L14 at sct 2: 0.033 / 8 x scang(1) 1 x spang 1 (rad per ms)

function near(a, b, tol, what) {
  assert.ok(Math.abs(a - b) <= tol, (what || 'value') + ': ' + a + ' is not within ' + tol + ' of ' + b);
}

function wrapPi(a) {
  let v = a % PI2;
  if (v < 0) v += PI2;
  if (v > Math.PI) v -= PI2;
  return v;
}

// L14 rate by the row's formula (rad per ms)
function rateOf(sct, sp) {
  const sc = Math.min(6, 1 + (sct - 2) / 111);
  return 0.033 / 8 * (0.13 + 0.87 * Math.pow((7 - sc) / 6, 2)) * Math.min(1, sp / 4.8);
}

// an angle byte whose L15 wang lies `ahead` rad past ang, so the turn goes on
function byteAhead(ang, ahead) {
  let a = (ang + ahead) % PI2;
  if (a < 0) a += PI2;
  return Math.round(a / PI2 * 251) % 251;
}

function tickWith(sim) {
  sim.applyInputs();
  return sim.step();
}

test('turning: in a steady hard turn every new point lies on the head path (turn, then move, each piece of the update)', () => {
  const sim = createSim(FIXTURE, { seed: 1 });
  const s = sim.spawn({ x: C, y: C, ang: 0, cv: 3, fam: 0 });
  const v = SP2 / 32;
  // the head path: chords of v Q turning RATE2 Q each piece (Q = P / PIECES, slSnake travel since 2026-10-16), on the
  // circle of radius v Q / (2 sin(RATE2 Q / 2)), the path the client predicts within its frame step (it turns, then
  // moves along ang, every frame); one chord per update (v P) made a radius of 43.920
  const Q = P / slSnake.PIECES;
  const R = v * Q / (2 * Math.sin(RATE2 * Q / 2));
  near(R, 43.867, 1e-3, 'polygon radius at sct 2 (v / omega 43.864)');
  let centre = null;
  let checked = 0;
  let worst = 0;
  let oldWorst = 0;
  for (let t = 0; t < 120; t++) {
    sim.setInput(s.id, { type: 'angle', q: byteAhead(s.ang, 2.0) }, P);
    const before = s.pts[s.pts.length - 1];
    const bx = before.xx;
    const by = before.yy;
    const angBefore = s.ang;
    const rec = tickWith(sim).updates[0];
    assert.equal(s.pts.length, 2, 'no growth');
    assert.equal(s.dir, 2);
    if (t === 10) centre = [s.cx - R * Math.sin(s.ang + RATE2 * Q / 2), s.cy + R * Math.cos(s.ang + RATE2 * Q / 2)];
    if (!rec.move || !centre) continue;
    near(Math.hypot(rec.xx - bx, rec.yy - by), MSL, 1e-9, 'one msl step');
    const off = Math.abs(Math.hypot(rec.xx - centre[0], rec.yy - centre[1]) - R);
    worst = Math.max(worst, off);
    // negative control: the old point, one msl along the ang the update ended on
    const ox = bx + MSL * Math.cos(s.ang);
    const oy = by + MSL * Math.sin(s.ang);
    oldWorst = Math.max(oldWorst, Math.abs(Math.hypot(ox - centre[0], oy - centre[1]) - R));
    assert.ok(s.ang !== angBefore);
    checked++;
  }
  assert.ok(checked >= 15, 'points checked ' + checked);
  assert.ok(worst < 0.02, 'a point ' + worst + ' off the head path (a chord sags R (1 - cos(RATE2 Q / 2)) = 0.011)');
  assert.ok(oldWorst > 5, 'the old placement is told apart (' + oldWorst + ')');
});

test('turning: a record turns from its arrival (offset 20 ms: 20 ms of turn), the head moving piece by piece', () => {
  const sim = createSim(FIXTURE, { seed: 1 });
  const s = sim.spawn({ x: C, y: C, ang: 0, cv: 3, fam: 0 });
  const x0 = s.cx;
  const y0 = s.cy;
  sim.setInput(s.id, { type: 'angle', q: 60 }, 20); // wang floor(256 x 60 / 251) = 61 bytes: far ahead, dir 2
  tickWith(sim);
  near(s.ang, RATE2 * 20, 1e-15, 'turned 20 ms, not a whole update (' + RATE2 * P + ')');
  // window time P - 20 = 22.67: pieces 1 and 2 straight, piece 3 turns 32.0025 - 22.67 ms, piece 4 turns to the end
  const Q = P / slSnake.PIECES;
  const lp = SP2 * (Q / 8) / 4;
  const a3 = RATE2 * (3 * Q - (P - 20));
  const a4 = RATE2 * 20;
  near(s.cx, x0 + 2 * lp + lp * Math.cos(a3) + lp * Math.cos(a4), 1e-9, 'head x: each piece turns, then moves');
  near(s.cy, y0 + lp * Math.sin(a3) + lp * Math.sin(a4), 1e-9, 'head y');
});

test('turning: steerAt gives the ang at the arrival, and the update goes on from it at the L14 rate', () => {
  const sim = createSim(FIXTURE, { seed: 1 });
  const s = sim.spawn({ x: C, y: C, ang: 0, cv: 3, fam: 0 });
  const K = slSnake.snakeLaws(FIXTURE);
  sim.setInput(s.id, { type: 'angle', q: byteAhead(0, 2.5) }, P);
  for (let t = 0; t < 3; t++) tickWith(sim);
  const a0 = s.ang;
  near(a0, 3 * P * RATE2, 1e-12, 'three whole updates of turn');
  sim.setInput(s.id, { type: 'angle', q: byteAhead(a0, 2.5) }, 25); // arrives P - 25 ms into the window
  const x = { ang: 0, wang: 0, dir: 0, turning: false };
  const raw = slSnake.steerAt(K, s, P, x);
  assert.equal(raw, Math.floor(256 * byteAhead(a0, 2.5) / 251));
  near(x.ang, a0 + RATE2 * (P - 25), 1e-12, 'ang at the arrival');
  assert.equal(x.dir, 2);
  assert.equal(s.ang, a0, 'steerAt leaves the snake alone');
  tickWith(sim);
  near(s.ang, x.ang + RATE2 * 25, 1e-12, 'the update ends where a client holding the echo ends');
});

function makeRoom() {
  const ft = fakeTimers(1000);
  const view = fakeView();
  const room = new SlRoom(makeFixture(), { seed: 7, view, clock: ft.clock, timers: ft.timers, autoTick: false,
    shippableOnly: false, prey: false, now: () => 1.7e12, log: { log() {}, warn() {}, error() {} } });
  return { ft, room };
}

test('turning: the echo of an input mid-turn carries the ang at its arrival, so the next update does not snap', () => {
  const { ft, room } = makeRoom();
  const sock = bareSocket();
  const seat = room.seat(sock, { nick: 'a', cv: 1 });
  ft.advance(P);
  room.wake();
  const s = room.sim.snake(seat.snakeId);
  room.onInput(seat, W.encodeInput([{ type: 'angle', q: byteAhead(s.ang, 2.5) }]));
  for (let t = 0; t < 4; t++) {
    ft.advance(P);
    room.wake();
  }
  assert.ok(s.turning && s.dir === 2, 'turning');
  ft.runImmediates();
  ft.advance(18);
  const off = room._steerOffsetNow();
  assert.equal(off, room._offsetNow(), 'on-time wakes: both offsets agree');
  const w = P - off;
  assert.ok(w > 12 && w < 30, 'the input lands inside the window (' + w + ')');
  const rate = rateOf(s.pts.length, s.sp);
  const want = s.ang + rate * w; // the server's ang at the arrival (L14 per ms)
  const stale = s.ang;
  const n0 = sock.emitted.length;
  room.onInput(seat, W.encodeInput([{ type: 'angle', q: byteAhead(s.ang, 2.5) }]));
  ft.runImmediates();
  let echo = null;
  for (const e of sock.emitted.slice(n0)) {
    if (e.name !== 'sl:f') continue;
    for (const ev of W.decodeBundle(e.data)) if (ev.type === 'snake_rot' && ev.own) echo = ev;
  }
  assert.ok(echo, 'an echo');
  const byte = (a) => Math.floor(a * 256 / PI2) * PI2 / 256; // L48.angRound floor
  assert.equal(echo.ang, byte(want), 'the echo ang is the ang at the arrival');
  assert.notEqual(echo.ang, byte(stale), 'not the ang of the last update');
  // the client takes the echo's ang and turns on at the L14 rate; the next update must agree within the byte
  ft.advance(P - 18);
  room.wake();
  const client = echo.ang + rate * off;
  near(wrapPi(s.ang - client), 0, PI2 / 256, 'the update snaps the client by under one ang byte');
  near(s.ang, want + rate * off, 1e-9, 'the server turned per ms from the arrival');
});

test('turning: after a LATE wake the echo matches the client, which set its ang when the late update left', () => {
  const { ft, room } = makeRoom();
  const sock = bareSocket();
  const seat = room.seat(sock, { nick: 'a', cv: 1 });
  ft.advance(P);
  room.wake();
  const s = room.sim.snake(seat.snakeId);
  room.onInput(seat, W.encodeInput([{ type: 'angle', q: byteAhead(s.ang, 2.5) }]));
  for (let t = 0; t < 3; t++) {
    ft.advance(P);
    room.wake();
  }
  ft.advance(P + 10); // this step runs 10 ms late (a 15.6 ms Windows timer, CPU load)
  room.wake();
  ft.runImmediates();
  const a0 = s.ang; // what the client holds from the moment that update left
  ft.advance(15);
  assert.equal(room._steerOffsetNow(), Math.round(P - 15), 'steering: 15 ms since the step ran');
  assert.equal(room._offsetNow(), Math.round(P - 25), 'the step grid: 25 ms since it was due');
  const rate = rateOf(s.pts.length, s.sp);
  const n0 = sock.emitted.length;
  room.onInput(seat, W.encodeInput([{ type: 'angle', q: byteAhead(s.ang, 2.5) }]));
  ft.runImmediates();
  let echo = null;
  for (const e of sock.emitted.slice(n0)) {
    if (e.name !== 'sl:f') continue;
    for (const ev of W.decodeBundle(e.data)) if (ev.type === 'snake_rot' && ev.own) echo = ev;
  }
  const byte = (a) => Math.floor(a * 256 / PI2) * PI2 / 256;
  const w = P - Math.round(P - 15);
  assert.equal(echo.ang, byte(a0 + rate * w), 'the client ang 15 ms after the late update: no jump forward');
  assert.notEqual(echo.ang, byte(a0 + rate * (w + 10)), 'not 10 ms ahead of the client');
});

test('turning: a glide (C_DISCONNECT) drops the steering records still waiting in the slot and goes straight', () => {
  const { ft, room } = makeRoom();
  const sock = bareSocket();
  const seat = room.seat(sock, { nick: 'a', cv: 1 });
  ft.advance(P);
  room.wake();
  const s = room.sim.snake(seat.snakeId);
  assert.equal(s.turning, false, 'straight before');
  ft.advance(20);
  room.onInput(seat, W.encodeInput([{ type: 'angle', q: byteAhead(s.ang, 2.5) }])); // waits in the slot
  assert.ok(s.inSteer.length > 0, 'the record waits for the update');
  room.unseat(sock, 'leave'); // the glide locks steering at the next step, before the update runs the slot
  const a0 = s.ang;
  ft.advance(P - 20);
  room.wake();
  assert.ok(room.sim.snake(s.id), 'gliding');
  assert.equal(s.inSteer.length, 0, 'the slot is cleared by the lock');
  assert.equal(s.turning, false, 'no turn toward the dropped record');
  near(wrapPi(s.ang - a0), 0, PI2 / 256, 'ang stays on the lock byte');
});
