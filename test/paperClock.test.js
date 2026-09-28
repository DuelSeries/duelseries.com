'use strict';
// The Paper room's delivery path (night queue item 3): the drift-corrected fixed-step clock,
// the volatile frame sent before the reliable bundle, pp:in batches, and the input FIFO as a
// jitter buffer (grows on a starve, trimmed when its cushion was never needed).
const test = require('node:test');
const assert = require('node:assert');
const { PaperRoom } = require('../server/paper/PaperRoom');
const { makeArena, P, MP } = require('../server/paper/ArenaGame');

const STEP = MP.STEP_MS;
const C = 1000;
const at = (r, a) => new P.Vec2(C + Math.cos(a) * r, C + Math.sin(a) * r);
const HOOKS = { onCashout() {}, onTransfer() {}, onRefund() {}, onSweep() {}, onBreach() {} };

let n = 0;
function sock() {
  return { id: 'k' + ++n, got: [], join() {}, leave() {}, emit(ev, p) { this.got.push([ev, p]); } };
}

function kit({ stake = 0.1, autoTick = false } = {}) {
  const wall = { t: 1000000 };
  const mono = { t: 5000 };
  const emits = [];
  const io = {
    to: (id) => ({
      emit: (ev, p) => emits.push([id, ev, p]),
      volatile: { emit: (ev, p) => emits.push([id, ev, p, 'volatile']) }
    })
  };
  const room = new PaperRoom({ stake, io, hooks: HOOKS, now: () => wall.t, clock: () => mono.t, autoTick, seed: 0.2 });
  room.game.radiusTarget = () => 950;
  room.game.setRadiusNow(950);
  return { room, g: room.game, wall, mono, emits };
}

test('clock: each wake runs every step that is due and carries the rest, so ticks never drift', () => {
  const k = kit();
  k.room.addHuman(sock(), { name: 'a', micro: 100000, wallet: 'Wa', spot: at(300, 0) });
  k.room.last = k.mono.t;
  k.room.acc = 0;
  const t0 = k.g.tick;
  // Wakes at uneven times (a timer that fires 0 to 3 ms late, sometimes a whole quantum late).
  let s = 7;
  const rand = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; };
  let elapsed = 0;
  while (elapsed < 10000) {
    const d = Math.max(0.1, k.room._dueIn()) + rand() * 3 + (rand() < 0.1 ? 15.6 : 0);
    k.mono.t += d;
    elapsed += d;
    k.wall.t += d;
    k.room.wake();
  }
  assert.strictEqual(k.g.tick - t0, Math.floor(elapsed / STEP), 'one tick per STEP_MS of clock, none lost or added');
  assert.ok(k.room.acc >= 0 && k.room.acc < STEP);
  k.room.stop();
});

test('clock: a stall runs at most MAX_STEPS_PER_WAKE steps and drops the rest, keeping the step phase', () => {
  const k = kit();
  k.room.addHuman(sock(), { name: 'a', micro: 100000, wallet: 'Wa', spot: at(300, 0) });
  k.room.last = k.mono.t;
  k.room.acc = 0;
  const t0 = k.g.tick;
  k.mono.t += 10 * STEP + 5;
  k.room.wake();
  assert.strictEqual(k.g.tick - t0, MP.MAX_STEPS_PER_WAKE);
  assert.ok(Math.abs(k.room.acc - 5) < 1e-6, 'the phase inside the step is kept: ' + k.room.acc);
  assert.ok(Math.abs(k.room._dueIn() - (STEP - 5)) < 1e-6);
  k.mono.t += STEP - 5;
  k.room.wake();
  assert.strictEqual(k.g.tick - t0, MP.MAX_STEPS_PER_WAKE + 1, 'back on the grid at once');
  k.room.stop();
});

test('clock: the timer runs only while someone is seated and ticks on its own', async () => {
  const k = kit({ stake: 0, autoTick: true });
  k.room.clock = () => require('perf_hooks').performance.now();
  assert.strictEqual(k.room.timer, null);
  const s = sock();
  const seat = k.room.addHuman(s, { name: 'a', micro: 0, wallet: null, spot: at(300, 0) });
  assert.ok(k.room.timer, 'armed by the join');
  const t0 = k.g.tick;
  const keep = setInterval(() => {}, 1000); // the room's timer is unref'd
  const deadline = Date.now() + 3000;
  while (k.g.tick - t0 < 6 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  clearInterval(keep);
  assert.ok(k.g.tick - t0 >= 6, 'ticked on its own: ' + (k.g.tick - t0));
  k.room.removeHuman(seat.unit.id, 9);
  assert.strictEqual(k.room.seats.size, 0);
  assert.strictEqual(k.room.timer, null, 'idle: no timer');
  k.room.stop();
});

test('a snapshot sends the volatile frame BEFORE the reliable bundle (a send makes the transport unwritable for the turn)', () => {
  const k = kit();
  k.room.addHuman(sock(), { name: 'a', micro: 100000, wallet: 'Wa', spot: at(300, 0) });
  k.emits.length = 0;
  let order = null;
  for (let i = 0; i < 40 && !order; i++) {
    k.room.pending.push(['m', 1, 1]); // something for this tick's bundle
    k.wall.t += STEP;
    k.room.tickOnce();
    const names = k.emits.filter((e) => e[0] === k.room.ioRoom).map((e) => e[1]);
    if (names.includes('pp:s')) order = names;
    k.emits.length = 0;
  }
  assert.deepStrictEqual(order, ['pp:s', 'pp:ev']);
  k.room.stop();
});

test('pp:in batches: an array is applied in order, each counted against the rate; a bad batch is ignored whole', () => {
  const k = kit();
  const s = sock();
  const seat = k.room.addHuman(s, { name: 'a', micro: 100000, wallet: 'Wa', spot: at(300, 0) });
  const u = seat.unit;
  assert.ok(k.room.setInput(s.id, [MP.encodeInput(1, 10, false), MP.encodeInput(2, 11, false), MP.encodeInput(3, 12, true)]));
  assert.deepStrictEqual(u._fifo.map((e) => [e.seq, e.angle, e.hold]), [[1, 10, false], [2, 11, false], [3, 12, true]]);
  const long = [];
  for (let i = 0; i <= MP.INPUT_BATCH_MAX; i++) long.push(MP.encodeInput(4 + i, 10, false));
  assert.strictEqual(k.room.setInput(s.id, long), false, 'longer than INPUT_BATCH_MAX');
  assert.strictEqual(k.room.setInput(s.id, []), false, 'empty');
  assert.strictEqual(k.room.setInput(s.id, [MP.encodeInput(4, 10, false), 1.5]), false, 'a non-integer');
  assert.strictEqual(k.room.setInput(s.id, [MP.encodeInput(4, 10, false), 'x']), false);
  assert.strictEqual(u._fifo.length, 3, 'nothing from a bad batch');
  // The rate: 120 inputs a second per seat, however they are batched.
  let seq = 4;
  let taken = 0;
  for (let b = 0; b < 20; b++) {
    const batch = [];
    for (let i = 0; i < MP.INPUT_BATCH_MAX; i++) batch.push(MP.encodeInput(seq++ & 255, 10, false));
    const before = seat.inCount;
    k.room.setInput(s.id, batch);
    taken += Math.min(seat.inCount, 120) - Math.min(before, 120);
  }
  assert.strictEqual(seat.inCount > 120, true);
  assert.strictEqual(taken + 3, 120, 'exactly 120 inputs this second');
  k.room.stop();
});

function fifoKit() {
  const g = makeArena({ stake: 0.1, seed: 0.71 });
  g.radiusTarget = () => 950;
  g.setRadiusNow(950);
  const h = g.spawnHuman({ name: 'me' }, at(300, 0.3));
  let seq = 0;
  const push = (k) => { for (let i = 0; i < k; i++) { seq = (seq + 1) & 255; g.setInput(h.id, seq, 20, false, 0); } };
  return { g, h, push };
}

test('input FIFO: a cushion that was never needed for INPUT_TRIM_TICKS is trimmed by one; a needed one is not', () => {
  const { g, h, push } = fifoKit();
  push(MP.INPUT_TRIM_DEPTH - 1); // with one in per tick, every pop finds INPUT_TRIM_DEPTH queued
  for (let t = 0; t < MP.INPUT_TRIM_TICKS - 1; t++) {
    push(1);
    g.update(STEP);
  }
  assert.strictEqual(g.stats.inputTrims, 0);
  const ack = h.seqAck;
  push(1);
  g.update(STEP);
  assert.strictEqual(g.stats.inputTrims, 1, 'trimmed at the end of the window');
  assert.strictEqual((h.seqAck - ack) & 255, 2, 'that one tick consumed two inputs');
  assert.strictEqual(h._fifo.length, MP.INPUT_TRIM_DEPTH - 2);
  // Now the cushion is exactly what is needed: one pop at depth INPUT_TRIM_DEPTH - 1 per window.
  for (let t = 0; t < 3 * MP.INPUT_TRIM_TICKS; t++) {
    push(1);
    g.update(STEP);
  }
  assert.strictEqual(g.stats.inputTrims, 1, 'no further trim');
  assert.ok(!h.death);
});

test('input FIFO: a starve leaves one more input queued for good (it grows to what the jitter needs); the cap drops the oldest', () => {
  const { g, h, push } = fifoKit();
  push(1);
  g.update(STEP);
  assert.strictEqual(h._fifo.length, 0);
  g.update(STEP); // a starve: the square repeats its angle
  push(2); // the late input and the next one arrive together
  g.update(STEP);
  assert.strictEqual(h._fifo.length, 1, 'one spare from now on');
  for (let t = 0; t < 30; t++) {
    push(1);
    g.update(STEP);
    assert.strictEqual(h._fifo.length, 1);
  }
  push(MP.INPUT_QUEUE_MAX + 3);
  assert.strictEqual(h._fifo.length, MP.INPUT_QUEUE_MAX, 'the hard cap');
  const newest = h._fifo[h._fifo.length - 1].seq;
  assert.strictEqual(newest, h._lastSeq, 'the newest input is kept');
  assert.ok(!h.death);
});
