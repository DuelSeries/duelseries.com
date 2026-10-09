'use strict';
// Tick timing instrument (server/tickTimer.js), its agar.io room wiring (server/ag/agRoom.js) and the rows
// GET /api/debug/tick builds from it (server/debugTick.js). FIX-PLAN S1.
const test = require('node:test');
const assert = require('node:assert');
const { TickTimer, TIMING, quantile } = require('../server/tickTimer');
const debugTick = require('../server/debugTick');
const { AgRoom, ROOM_TUNING } = require('../server/ag/agRoom');
const { FIXTURE } = require('./agLawsFixture');

const TICK = FIXTURE.L1.value;
const MAX_STEPS = ROOM_TUNING.MAX_STEPS_PER_WAKE.value;
const WALL0 = 1759900000000;   // any wall time: the absolute times are checked against it
const quiet = { error() {}, warn() {}, log() {} };

function sum(a) {
  return a.reduce((s, v) => s + v, 0);
}
function bucketSum(h) {
  return sum(Object.values(h.buckets));
}

function sock(id) {
  return { id, conn: { writeBuffer: [] }, n: 0, emit() { this.n++; } };
}

test('lateness, steps per wake and step cost land in the plan buckets; dropped backlog is counted', () => {
  let t = 100;
  const tt = new TickTimer({ periodMs: 40, maxSteps: 4, clock: () => t, now: () => WALL0 + t });
  // Wake 0.5 ms late, one step costing 3 ms.
  tt.wakeBegin(t, t - 0.5);
  tt.step(t - 0.5, t, t + 3, t + 3);
  t += 3;
  tt.wakeEnd(1);
  // Wake 30 ms late, two steps of 1 ms.
  t = 200;
  tt.wakeBegin(t, t - 30);
  tt.step(t - 30, t, t + 1, t + 1);
  tt.step(t + 10, t + 1, t + 2, t + 2);
  tt.wakeEnd(2);
  // A wake 0.2 ms early that runs nothing.
  t = 240;
  tt.wakeBegin(t, t + 0.2);
  tt.wakeEnd(0);
  // A stall that drops 3 steps of 40 ms.
  tt.dropped(3, 120);
  const r = tt.report({ recent: 'all' });
  assert.deepStrictEqual(Object.keys(r.lateHist.buckets), ['0-1', '1-2', '2-5', '5-10', '10-20', '20-50', '50+']);
  assert.strictEqual(r.lateHist.buckets['0-1'], 2);       // 0.5 late and the early one
  assert.strictEqual(r.lateHist.buckets['20-50'], 1);
  assert.strictEqual(r.earlyWakes, 1);
  assert.strictEqual(r.worstLateMs, 30);
  assert.strictEqual(r.worstLateAt, WALL0 + 200);
  assert.deepStrictEqual(r.stepsPerWake, [1, 1, 1, 0, 0]);
  assert.strictEqual(r.wakes, 3);
  assert.strictEqual(r.steps, 3);
  assert.strictEqual(r.tickMsHist.n, 3);
  assert.strictEqual(r.tickMsHist.buckets['2-5'], 1);
  assert.strictEqual(r.tickMsHist.buckets['1-2'], 2);
  assert.strictEqual(r.wakeToEmitHist.n, 2);               // the 0-step wake emits nothing
  assert.strictEqual(r.wakeToEmitHist.buckets['2-5'], 2);  // 3 ms and 2 ms
  assert.strictEqual(r.droppedBacklog, 1);
  assert.strictEqual(r.droppedSteps, 3);
  assert.strictEqual(r.droppedMs, 120);
  // Only the 30 ms wake is in the late log, with its absolute time.
  assert.deepStrictEqual(r.lateWakes, [{ at: WALL0 + 200, ms: 30, steps: 2 }]);
  // Send intervals: 103 -> 201 -> 202.
  assert.strictEqual(r.sendIntervalHist.n, 2);
  assert.strictEqual(r.sendIntervalHist.buckets['80-100'], 1);
  assert.strictEqual(r.sendIntervalHist.buckets['0-20'], 1);
  assert.strictEqual(r.window.multiStepWakePct, 33.333);
  assert.strictEqual(r.window.sendInterval.over60Pct, 50);
  assert.strictEqual(r.window.sendInterval.band60to80Pct, 0);
  // Recent ticks carry absolute ms.
  assert.deepStrictEqual(r.recent[0], { due: WALL0 + 99.5, start: WALL0 + 100, sendEnd: WALL0 + 103, end: WALL0 + 103 });
  assert.strictEqual(r.recent.length, 3);
});

test('the ring keeps the last 60 s of ticks, oldest first, and idle breaks the send-interval chain', () => {
  let t = 0;
  const tt = new TickTimer({ periodMs: 1000, maxSteps: 4, clock: () => t, now: () => WALL0 + t });
  assert.strictEqual(tt.ringSize, TIMING.RING_SECONDS);
  const before = [tt.rStart, tt.rDue, tt.wAt, tt.lAt];
  for (let i = 0; i < 75; i++) {
    t = i * 1000;
    tt.wakeBegin(t, t);
    tt.step(t, t, t + 1, t + 2);
    tt.wakeEnd(1);
  }
  const r = tt.report({ recent: 'all' });
  assert.strictEqual(r.window.ticks, 60);
  assert.strictEqual(r.recent.length, 60);
  assert.strictEqual(r.recent[0].start, WALL0 + 15000);
  assert.strictEqual(r.recent[59].start, WALL0 + 74000);
  assert.strictEqual(r.window.tickInterval.p50, 1000);
  assert.strictEqual(r.window.tickMs.max, 2);
  assert.strictEqual(r.sendIntervalHist.n, 74);
  // Recording reuses the same preallocated arrays.
  assert.deepStrictEqual([tt.rStart, tt.rDue, tt.wAt, tt.lAt], before);
  tt.idle();
  t = 500000;
  tt.wakeBegin(t, NaN);
  tt.step(NaN, t, t + 1, t + 1);
  tt.wakeEnd(1);
  const r2 = tt.report({ recent: 1 });
  assert.strictEqual(r2.sendIntervalHist.n, 74, 'no gap counted across the idle');
  assert.strictEqual(r2.lateHist.n, 75, 'a wake with no due time records no lateness');
  assert.strictEqual(r2.recent.length, 1);
  assert.strictEqual(r2.recent[0].due, null);
  // The default read carries DEFAULT_RECENT raw ticks; percentiles always cover the whole ring.
  assert.strictEqual(tt.report().recent.length, TIMING.DEFAULT_RECENT);
});

test('quantile matches the polish probes (linear interpolation)', () => {
  assert.strictEqual(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.strictEqual(quantile([10], 0.99), 10);
  assert.ok(Number.isNaN(quantile([], 0.5)));
});

test('agar room: lateness from the armed due time, histograms sum to the tick count, dropped backlog in ms', () => {
  let t = 1000;
  const r = new AgRoom({ laws: FIXTURE, shippableOnly: false, seed: 7, autoTick: false, log: quiet,
    clock: () => t, now: () => WALL0 + t });
  const s = sock('a');
  r.addSocket(s);
  r.join('a', 'probe');
  r.last = t;
  r.acc = 0;
  // A timer armed now is due one tick later; the wake comes 3 ms after that and runs one step.
  r._arm();
  clearTimeout(r.timer);
  r.timer = null;
  assert.strictEqual(r._dueAt, 1000 + TICK);
  t += TICK + 3;
  assert.strictEqual(r.wake(), 1);
  assert.ok(Number.isNaN(r._dueAt), 'the due time is used once');
  // Plain wakes (no armed timer): steps run, no lateness recorded.
  for (const g of [41, 17, 80, 12, 39]) {
    t += g;
    r.wake();
  }
  // A long stall: MAX_STEPS run, the rest is dropped and its ms counted.
  r._arm();
  clearTimeout(r.timer);
  r.timer = null;
  const due = r._dueAt;
  t = due + TICK * 9 + 1;
  assert.strictEqual(r.wake(), MAX_STEPS);
  const rep = debugTick.agRow(r, { recent: 'all' });
  assert.strictEqual(rep.game, 'agar');
  assert.strictEqual(rep.ticks, r.stats.ticks);
  assert.strictEqual(rep.tickMsHist.n, rep.ticks, 'tickMsHist sums to the ticks');
  assert.strictEqual(bucketSum(rep.tickMsHist), rep.ticks);
  assert.strictEqual(sum(rep.stepsPerWake), rep.wakes, 'stepsPerWake sums to the wakes');
  assert.strictEqual(sum(rep.stepsPerWake.map((n, k) => n * k)), rep.ticks, 'steps per wake add up to the ticks');
  assert.strictEqual(rep.lateHist.n, 2);
  assert.strictEqual(bucketSum(rep.lateHist), 2);
  assert.strictEqual(rep.lateHist.buckets['2-5'], 1);
  assert.strictEqual(rep.lateHist.buckets['50+'], 1);
  assert.strictEqual(rep.droppedBacklog, 1);
  // The stall left 10 due steps (9 whole ticks past the due one): 4 ran, 6 dropped.
  assert.strictEqual(rep.droppedSteps, 10 - MAX_STEPS);
  assert.ok(Math.abs(rep.droppedMs - (10 - MAX_STEPS) * TICK) < 1e-6);
  assert.strictEqual(rep.lateWakes.length, 1);
  assert.strictEqual(rep.lateWakes[0].steps, MAX_STEPS);
  // Each step's due time follows the accumulator; the first is exactly one tick after the start.
  assert.strictEqual(rep.recent[0].due, Math.round((WALL0 + 1000 + TICK) * 10) / 10);
  assert.ok(rep.recent.every((x) => x.start >= WALL0 && x.sendEnd >= x.start && x.end >= x.sendEnd));
  assert.strictEqual(rep.seats, 1);
  assert.strictEqual(rep.players, 1);
  assert.ok(rep.bundles >= rep.ticks);
  // Leaving idles the room: the next send interval starts fresh.
  r.removeSocket('a');
  assert.ok(Number.isNaN(r.timing._lastSend));
  r.stop();
});

test('agar room on its real timer: wakes record lateness and ticks run at about one per L1', async () => {
  const r = new AgRoom({ laws: FIXTURE, shippableOnly: false, seed: 7, autoTick: true, log: quiet });
  const s = sock('live');
  r.addSocket(s);
  await new Promise((res) => setTimeout(res, TICK * 10 + 20));
  const rep = debugTick.agRow(r, { recent: 5 });
  r.removeSocket('live');
  r.stop();
  assert.ok(rep.ticks >= 5, 'ticks ran: ' + rep.ticks);
  assert.strictEqual(rep.tickMsHist.n, rep.ticks);
  assert.strictEqual(rep.lateHist.n, rep.wakes, 'every timer wake has a due time');
  assert.strictEqual(sum(rep.stepsPerWake), rep.wakes);
  assert.strictEqual(sum(rep.stepsPerWake.map((n, k) => n * k)), rep.ticks);
  assert.ok(rep.recent.length <= 5);
  const nowWall = Date.now();
  assert.ok(rep.recent.every((x) => Math.abs(x.start - nowWall) < 60000), 'recent entries are absolute wall ms');
  assert.ok(rep.window.tickInterval.n >= 4);
});

test('debug rows: snake stalls carry absolute times; agar, paper and tanks rows; keys never collide', () => {
  const now = WALL0 + 10000;
  const snake = { lobbyType: 'na_s0', _lag: { ticks: 100, late: 2, worst: 37.4, worstAt: WALL0 + 4000,
    recent: [{ ms: 25, at: WALL0 + 3000 }, { ms: 37, at: WALL0 + 4000 }] },
  _bc: { count: 50, late: 1, worst: 80, worstAt: WALL0 + 4000, recent: [{ ms: 80, at: WALL0 + 4000 }] } };
  const br = { lobbyType: 'na_br', _lag: { ticks: 10, late: 0, worst: 0, worstAt: 0, recent: [] } };
  const idle = { lobbyType: 'na_s1', _lag: { ticks: 0, late: 0, worst: 0, worstAt: 0, recent: [] } };
  const ag = new AgRoom({ laws: FIXTURE, shippableOnly: false, seed: 7, autoTick: false, log: quiet });
  ag.tickOnce();
  const paper = { lobbyType: 'paper_na_s0', seats: new Map([['u', {}]]), playerCount: 1, botCount: 3, timer: {},
    game: { tick: 812 } };
  const tanks = { lobbyType: 'tanks', playerCount: 0, botCount: 6, timer: null, seq: 44 };
  const rows = debugTick.roomRows({ snakeRooms: [snake, br, idle, { lobbyType: 'na_s0', _lag: snake._lag }],
    agRooms: [ag], paperRooms: [paper], shooterRooms: [tanks], now, recent: 0 });
  assert.deepStrictEqual(Object.keys(rows), ['na_s0', 'na_br', 'na_s0~2', 'ag_na_s0', 'paper_na_s0', 'tanks']);
  assert.deepStrictEqual(rows.na_s0.recent[1], { ms: 37, at: WALL0 + 4000, agoSec: 6 });
  assert.strictEqual(rows.na_s0.worstAt, WALL0 + 4000);
  assert.strictEqual(rows.na_s0.latePct, 2);
  assert.deepStrictEqual(rows.na_s0.broadcast.recent, [{ ms: 80, at: WALL0 + 4000, agoSec: 6 }]);
  assert.strictEqual(rows.na_br.broadcast, null);
  assert.strictEqual(rows.ag_na_s0.ticks, 1);
  assert.strictEqual(rows.ag_na_s0.recent.length, 0);
  assert.deepStrictEqual(rows.paper_na_s0, { game: 'paper', seats: 1, players: 1, bots: 3, ticking: true, ticks: 812 });
  assert.deepStrictEqual(rows.tanks, { game: 'shooter', players: 0, bots: 6, ticking: false, broadcasts: 44 });
  ag.stop();
});

test('?recent= parsing', () => {
  assert.strictEqual(debugTick.parseRecent('all'), 'all');
  assert.strictEqual(debugTick.parseRecent('200'), 200);
  assert.strictEqual(debugTick.parseRecent(undefined), TIMING.DEFAULT_RECENT);
  assert.strictEqual(debugTick.parseRecent('-3'), TIMING.DEFAULT_RECENT);
  assert.strictEqual(debugTick.parseRecent('x'), TIMING.DEFAULT_RECENT);
});
