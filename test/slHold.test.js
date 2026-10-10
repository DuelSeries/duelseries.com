'use strict';
// slHold (SERVER-DESIGN 15.3; task T9): the old ramp, the steering lock record, the book (start, release, safety net,
// completion, death wins the tie). Literal vectors from the law rows by id; the sim is the bare T4/T6 sim.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const W = require('../shared/slWire.js');
const { encodeRecord } = require('../server/sl/slRecordCache');
const { createSim } = require('../server/sl/slSim');
const H = require('../server/sl/slHold');
const { makeFixture } = require('./slLawsFixture');

const LAWS = makeFixture();
const PI2 = 2 * Math.PI;
const P = 42.67; // L7

test('holdMult: the old ramp max(0.2, 1 - 0.8 t / 3000) from C_HOLD_RAMP only (literal vectors)', () => {
  const v = [[0, 1], [1000, 0.7333333333333334], [2000, 0.4666666666666667], [3000, 0.2], [4000, 0.2], [-5, 1]];
  for (const [t, m] of v) assert.ok(Math.abs(H.holdMult(t, LAWS) - m) < 1e-12, t + ' ms: ' + H.holdMult(t, LAWS));
  assert.strictEqual(H.holdMult(1000, LAWS).toFixed(4), '0.7333');
  assert.strictEqual(H.holdMult(2000, LAWS).toFixed(4), '0.4667');
  assert.strictEqual(H.holdMult(3000, LAWS).toFixed(4), '0.2000');
  // read from the row: a patched floor moves it, shared/constants.js never does
  const L2 = makeFixture({ C_HOLD_RAMP: { rule: 'linearToFloor', floor: 0.5, ms: 3000 } });
  assert.ok(Math.abs(H.holdMult(1500, L2) - 0.75) < 1e-12);
});

test('C_HOLD_MS and C_HOLD_RAMP equal the old game constants at cut time; slHold never reads shared/constants.js', () => {
  const C = require('../shared/constants.js');
  assert.strictEqual(LAWS.C_HOLD_MS.value, C.CASHOUT_HOLD_MS);
  assert.strictEqual(LAWS.C_HOLD_RAMP.value.ms, C.CASHOUT_HOLD_MS);
  assert.strictEqual(LAWS.C_HOLD_RAMP.value.floor, C.CASHOUT_MIN_SPEED_MULT);
  for (const f of ['slHold.js', 'slRoom.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'sl', f), 'utf8');
    assert.ok(!/require\([^)]*constants/.test(src), f + ' must not require shared/constants.js');
  }
});

test('holdLaws refuses forms it does not build (boost allowed, steering free, another ramp, a parameter)', () => {
  assert.throws(() => H.holdLaws(makeFixture({ C_HOLD_BOOST: { allow: true } })), /no boosting/);
  assert.throws(() => H.holdLaws(makeFixture({ C_HOLD_STEER: 'free' })), /locked/);
  assert.throws(() => H.holdLaws(makeFixture({ C_HOLD_RAMP: { rule: 'linearToFloor', floor: 0.2, ms: 3000, k: 1 } })), /not built/);
  assert.throws(() => H.holdLaws(makeFixture({ C_HOLD_RAMP: { rule: 'pongPerPing' } })), /not built|linearToFloor/);
});

function simWith() {
  const sim = createSim(LAWS, { seed: 11 });
  const s = sim.spawn({ x: 21600, y: 21600, ang: 0.3, cv: 2 });
  return { sim, s };
}

test('lock: steering locks to the ang byte and ONE legal rotation record carries dir 1 or 2 with ang = wang', () => {
  for (const ang of [0.3, 1.2345, 3.1, 5.9, 0.0001, PI2 - 0.0001]) {
    const sim = createSim(LAWS, { seed: 3 });
    const s = sim.spawn({ x: 21600, y: 21600, ang, cv: 1 });
    const book = H.createHoldBook(LAWS);
    book.press(s.id, 0);
    const out = book.step(sim, P, () => 0);
    assert.strictEqual(out.started.length, 1);
    const lock = out.started[0].lock;
    assert.deepStrictEqual(Object.keys(lock).sort(), ['ang', 'dir', 'id', 'type', 'wang']);
    assert.ok(lock.dir === 1 || lock.dir === 2);
    assert.strictEqual(lock.ang, lock.wang);
    const raw = Math.round(lock.wang * 256 / PI2);
    assert.ok(Number.isInteger(raw) && raw >= 0 && raw < 256);
    assert.strictEqual(lock.wang, raw * PI2 / 256, 'on the 8-bit grid');
    // the sim's wang is that same byte, and its dir is the record's
    assert.ok(Math.abs(s.wang - lock.wang) < 1e-12);
    assert.strictEqual(s.dir, lock.dir);
    assert.strictEqual(raw, Math.floor(ang * 256 / PI2) % 256, 'L48.angRound floor of the ang at the lock');
    // on the wire: their form 3 or 5 (dir, ang, wang; no sp)
    const ev = W.decodeBundle(Uint8Array.from([1, ...encodeRecord(Object.assign({ own: false }, lock), false, 19)]))[0];
    assert.deepStrictEqual(Object.keys(ev).sort(), ['ang', 'dir', 'id', 'own', 'type', 'wang']);
    assert.strictEqual(ev.ang, ev.wang);
    assert.ok(s.holdMult !== null);
  }
});

test('book: the ramp each step, the newest stored input applies at release, no boost while held', () => {
  const { sim, s } = simWith();
  const book = H.createHoldBook(LAWS);
  sim.setInput(s.id, { type: 'boost', on: true }, 0);
  sim.applyInputs();
  book.press(s.id, 10);
  let t = P;
  book.step(sim, t, () => 0);
  assert.strictEqual(s.boosting, false, 'the hold ended the boost (C_HOLD_BOOST allow false)');
  sim.step();
  for (let k = 0; k < 20; k++) {
    t += P;
    sim.setInput(s.id, { type: 'boost', on: true }, 0);
    sim.setInput(s.id, { type: 'angle', q: 40 + k }, 0);
    sim.applyInputs();
    book.step(sim, t, () => 0);
    assert.ok(Math.abs(s.holdMult - H.holdMult(t - 10, LAWS)) < 1e-12, 'mult from the press time');
    assert.strictEqual(s.boosting, false, 'no boosting while holding (Owen 17:00)');
    sim.step();
  }
  assert.ok(book.heldMs(s.id, t) > 800);
  book.release(s.id, 'release');
  const out = book.step(sim, t + P, () => 0);
  assert.deepStrictEqual(out.ended, [{ id: s.id, why: 'release' }]);
  assert.strictEqual(s.holdMult, null);
  assert.strictEqual(s.wang, Math.floor(256 * 59 / 251) * PI2 / 256, 'the newest stored byte (59) applied at release');
  assert.strictEqual(book.holding(s.id), false);
});

test('book: completion at C_HOLD_MS, and a death in the same tick wins the tie', () => {
  {
    const { sim, s } = simWith();
    const book = H.createHoldBook(LAWS);
    book.press(s.id, 0);
    let t = 0;
    let done = [];
    while (!done.length) {
      t += P;
      book.heard(s.id, t - 10); // upstream keeps coming (pings)
      sim.applyInputs();
      book.step(sim, t, () => 0);
      sim.step();
      done = book.complete(sim, t);
      assert.ok(t < 3200);
    }
    assert.deepStrictEqual(done, [s.id]);
    assert.ok(t >= 3000 && t < 3000 + P, 'completes on the first tick at or after 3000 ms: ' + t);
    assert.strictEqual(book.stats.completed, 1);
  }
  {
    const { sim, s } = simWith();
    const book = H.createHoldBook(LAWS);
    book.press(s.id, 0);
    let t = 0;
    while (t + P < 3000) {
      t += P;
      book.heard(s.id, t - 10); // upstream keeps coming (pings)
      sim.applyInputs();
      book.step(sim, t, () => 0);
      sim.step();
      assert.deepStrictEqual(book.complete(sim, t), []);
    }
    // the completing tick: the room's kill dies at the start of this step (a death in step 4 of the tick)
    sim.kill(s.id);
    t += P;
    book.heard(s.id, t - 10);
    sim.applyInputs();
    book.step(sim, t, () => 0);
    const log = sim.step();
    assert.strictEqual(log.deaths.length, 1);
    assert.ok(log.deaths[0].drops.length > 0, 'a death drops food');
    assert.deepStrictEqual(book.complete(sim, t), [], 'the death wins');
    assert.strictEqual(book.stats.completed, 0);
    assert.strictEqual(book.stats.deaths, 1);
  }
});

test('book: the safety net is max(2000, 3 x RTT p95) of total upstream silence, never a short stale rule', () => {
  const { sim, s } = simWith();
  const book = H.createHoldBook(LAWS);
  assert.strictEqual(book.safetyMs(0), 2000);
  assert.strictEqual(book.safetyMs(500), 2000);
  assert.strictEqual(book.safetyMs(900), 2700);
  book.press(s.id, 0);
  let t = 0;
  // upstream heard every 1900 ms (a slow lossy phone): the hold keeps going
  for (let k = 1; k <= 40; k++) {
    t += P;
    if (t % 1900 < P) book.heard(s.id, t);
    const out = book.step(sim, t, () => 0);
    assert.strictEqual(out.ended.length, 0, 'not ended at ' + t);
    sim.step();
  }
  // 2000 ms of silence: it ends with 'safety'
  const heardAt = t;
  book.heard(s.id, heardAt);
  let ended = null;
  while (!ended) {
    t += P;
    const out = book.step(sim, t, () => 0);
    if (out.ended.length) ended = { t, why: out.ended[0].why };
    sim.step();
  }
  assert.strictEqual(ended.why, 'safety');
  assert.ok(ended.t - heardAt > 2000 && ended.t - heardAt <= 2000 + P);
  assert.strictEqual(s.holdMult, null);
});

test('book: a press and release before the tick start nothing; release then press while holding restarts', () => {
  const { sim, s } = simWith();
  const book = H.createHoldBook(LAWS);
  book.press(s.id, 5);
  book.release(s.id, 'release');
  let out = book.step(sim, P, () => 0);
  assert.strictEqual(out.started.length + out.ended.length, 0);
  assert.strictEqual(s.holdMult, null);
  book.press(s.id, 50);
  assert.strictEqual(book.press(s.id, 60), false, 'a second press while one waits is ignored');
  book.step(sim, 2 * P, () => 0);
  assert.strictEqual(book.heldMs(s.id, 1000), 950);
  book.release(s.id, 'release');
  book.press(s.id, 1000);
  out = book.step(sim, 1000 + P, () => 0);
  assert.strictEqual(out.ended.length, 1);
  assert.strictEqual(out.started.length, 1);
  assert.strictEqual(book.heldMs(s.id, 1500), 500, 'the new hold counts from its own press');
});
