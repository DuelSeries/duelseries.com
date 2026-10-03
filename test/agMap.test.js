'use strict';
// Map shrink (CHOSEN, server laws 4, build brief 7.3 and the 9.2 agMap card), run on the FIXTURE table:
// FULL_SIDE 14142.135623730952 (L2), N_FULL 50 (L39), N_MIN 4.
const test = require('node:test');
const assert = require('node:assert');
const M = require('../server/ag/agMap');
const { withValues } = require('../server/ag/agLaws');
const { createRng } = require('../server/ag/agRng');
const { FIXTURE, makeFixture } = require('./agLawsFixture');

const FULL = 14142.135623730952;
const SMALL = 4000.0000000000005;

test('targetSide hits the card numbers', () => {
  assert.strictEqual(M.targetSide(1, FIXTURE), SMALL);
  assert.strictEqual(M.targetSide(0, FIXTURE), SMALL);
  assert.strictEqual(M.targetSide(4, FIXTURE), SMALL);
  assert.strictEqual(M.targetSide(8, FIXTURE), 5656.854249492381);
  assert.strictEqual(M.targetSide(16, FIXTURE), 8000.000000000001);
  assert.strictEqual(M.targetSide(32, FIXTURE), 11313.708498984763);
  assert.strictEqual(M.targetSide(50, FIXTURE), FULL);
  assert.strictEqual(M.targetSide(80, FIXTURE), FULL);
  assert.throws(() => M.targetSide(NaN, FIXTURE), TypeError);
});

test('rates hit the card numbers', () => {
  assert.strictEqual(M.growRate(FIXTURE), 893.1875130777444);
  assert.strictEqual(M.shrinkRate(FIXTURE), 59.545834205182956);
  assert.strictEqual((FULL - SMALL) / M.growRate(FIXTURE), 11.354990385818532);
  assert.strictEqual((FULL - SMALL) / M.shrinkRate(FIXTURE), 170.32485578727798);
});

function stepsUntil(state, target, dtMs, done, cap) {
  let s = state;
  let n = 0;
  while (!done(s) && n < cap) {
    s = M.stepSide(s, target, dtMs, FIXTURE);
    n++;
  }
  return { s, n };
}

test('4000 to full in 11.354990385818532 s of steps, landing exactly on the target', () => {
  const need = 11.354990385818532;
  for (const dt of [40, 1, 50, 33]) {
    const { s, n } = stepsUntil({ side: SMALL, belowMs: null }, FULL, dt, (x) => x.side === FULL, 1e6);
    assert.strictEqual(s.side, FULL);
    assert.strictEqual(s.belowMs, null);
    // It lands on the first step whose total time covers the analytic time, never earlier.
    assert.strictEqual(n, Math.ceil((need * 1000) / dt), 'dt ' + dt);
  }
  // Growth starts at once (no wait) and moves rate * dt.
  const one = M.stepSide({ side: SMALL, belowMs: null }, FULL, 40, FIXTURE);
  assert.strictEqual(one.side, SMALL + (893.1875130777444 * 40) / 1000);
});

test('full to 4000 in 170.32485578727798 s of steps after the 3000 ms wait', () => {
  const need = 170.32485578727798;
  for (const dt of [40, 50]) {
    let s = { side: FULL, belowMs: null };
    let waited = 0;
    // The wait: the first step below starts it at 0, later steps add dt, nothing moves before 3000 ms.
    while (true) {
      const next = M.stepSide(s, SMALL, dt, FIXTURE);
      if (next.side !== FULL) { s = next; break; }
      s = next;
      waited++;
      assert.ok(s.belowMs < 3000);
    }
    assert.strictEqual(waited, 3000 / dt);
    assert.strictEqual(s.belowMs, 3000);
    assert.strictEqual(s.side, FULL - (59.545834205182956 * dt) / 1000);
    const { s: end, n } = stepsUntil(s, SMALL, dt, (x) => x.side === SMALL, 1e6);
    assert.strictEqual(end.side, SMALL);
    assert.strictEqual(n + 1, Math.ceil((need * 1000) / dt), 'dt ' + dt);
  }
});

test('the wait resets when the target comes back up, and growth is immediate', () => {
  let s = { side: FULL, belowMs: null };
  for (let i = 0; i < 70; i++) s = M.stepSide(s, SMALL, 40, FIXTURE);
  assert.strictEqual(s.belowMs, 69 * 40);
  s = M.stepSide(s, FULL, 40, FIXTURE); // back to target: wait cleared
  assert.strictEqual(s.belowMs, null);
  assert.strictEqual(s.side, FULL);
  for (let i = 0; i < 75; i++) s = M.stepSide(s, SMALL, 40, FIXTURE);
  assert.strictEqual(s.side, FULL, 'still waiting after a reset');
  s = M.stepSide(s, SMALL, 40, FIXTURE);
  assert.ok(s.side < FULL);
  const mid = s.side;
  s = M.stepSide(s, FULL, 40, FIXTURE);
  assert.strictEqual(s.side, Math.min(FULL, mid + (893.1875130777444 * 40) / 1000));
  assert.strictEqual(s.belowMs, null);
});

test('stepSide is pure and checks its inputs', () => {
  const s = Object.freeze({ side: FULL, belowMs: null });
  const n = M.stepSide(s, SMALL, 40, FIXTURE);
  assert.notStrictEqual(n, s);
  assert.throws(() => M.stepSide(s, SMALL, -1, FIXTURE), RangeError);
  assert.throws(() => M.stepSide(s, NaN, 40, FIXTURE), TypeError);
  assert.throws(() => M.stepSide({ side: NaN }, SMALL, 40, FIXTURE), TypeError);
});

test('createMapState needs every map law and starts at the target', () => {
  assert.deepStrictEqual(M.createMapState(FIXTURE, 16), { side: 8000.000000000001, belowMs: null });
  assert.deepStrictEqual(M.createMapState(FIXTURE), { side: SMALL, belowMs: null });
  assert.throws(() => M.createMapState(withValues(FIXTURE, { L39: null })), /L39/);
  assert.throws(() => M.createMapState(withValues(FIXTURE, { L2: null })), /L2/);
  // The real table (every row approved 2026-10-02): full side at its room size L39, smaller below it.
  const { LAWS } = require('../server/ag/agLaws');
  assert.deepStrictEqual(M.createMapState(LAWS, LAWS.L39.value), { side: LAWS.L2.value, belowMs: null });
  assert.ok(M.createMapState(LAWS).side < LAWS.L2.value);
  assert.throws(() => M.createMapState(withValues(LAWS, { L3: null, L39: null })), /L3.*L39/);
});

test('borderFor is a square centred on the origin', () => {
  assert.deepStrictEqual(M.borderFor(FULL), { minX: -FULL / 2, minY: -FULL / 2, maxX: FULL / 2, maxY: FULL / 2 });
  assert.strictEqual(M.borderFor(FULL).maxX, 7071.067811865476);
});

test('countForMap follows MAP_COUNT_BOTS', () => {
  assert.strictEqual(M.countForMap(3, 10, FIXTURE), 13);
  assert.strictEqual(M.countForMap(3, 10, makeFixture({ MAP_COUNT_BOTS: false })), 3);
});

test('pushInside applies the L3 rule and reports the clamped axes', () => {
  const b = M.borderFor(4000); // -2000..2000
  const c = { x: 2500, y: -1990, size: 100 };
  const mask = M.pushInside(c, b, FIXTURE);
  assert.strictEqual(c.x, 2000 - 50);
  assert.strictEqual(c.y, -2000 + 50);
  assert.strictEqual(mask, M.PUSHED_X | M.PUSHED_Y);
  const d = { x: 10, y: 1949, size: 100 };
  assert.strictEqual(M.pushInside(d, b, FIXTURE), 0);
  assert.deepStrictEqual(d, { x: 10, y: 1949, size: 100 });
  const e = { x: -1951, y: 0, size: 100 };
  assert.strictEqual(M.pushInside(e, b, FIXTURE), M.PUSHED_X);
  assert.strictEqual(e.x, -1950);
  // A different L3 factor is read from the table, not assumed.
  const f = { x: 2000, y: 0, size: 100 };
  M.pushInside(f, b, makeFixture({ L3: { radiusFactor: 1, reflectBoost: true } }));
  assert.strictEqual(f.x, 1900);
  // Too big for the box: sent to the centre on that axis.
  const g = { x: 5, y: 7, size: 5000 };
  assert.strictEqual(M.pushInside(g, b, FIXTURE), M.PUSHED_X | M.PUSHED_Y);
  assert.strictEqual(g.x, 0);
  assert.strictEqual(g.y, 0);
});

test('isOutside and scaledTarget', () => {
  const b = M.borderFor(4000);
  assert.strictEqual(M.isOutside(2000, 0, b), false);
  assert.strictEqual(M.isOutside(2000.0001, 0, b), true);
  assert.strictEqual(M.isOutside(0, -2001, b), true);
  assert.strictEqual(M.scaledTarget(700, 50, FIXTURE), 700);
  assert.strictEqual(M.scaledTarget(700, 99, FIXTURE), 700);
  assert.strictEqual(M.scaledTarget(700, 4, FIXTURE), 56);
  assert.strictEqual(M.scaledTarget(700, 0, FIXTURE), 56);
  assert.strictEqual(M.scaledTarget(50, 7, FIXTURE), 7);
  assert.strictEqual(M.scaledTarget(50, 13, FIXTURE), 13);
  assert.strictEqual(M.scaledTarget(50, 9, FIXTURE), 9);
  assert.strictEqual(M.scaledTarget(700, 9, FIXTURE), 126);
  assert.strictEqual(M.scaledTarget(700, 3.5, FIXTURE), 56);
});

test('no cell is ever removed by a shrink: every cell stays, inside the L3 box, through full to 4000', () => {
  const rng = createRng(7);
  const cells = [];
  for (let i = 0; i < 300; i++) {
    cells.push({ id: i + 1, x: rng.range(-9000, 9000), y: rng.range(-9000, 9000), size: rng.range(10, 900) });
  }
  let s = { side: FULL, belowMs: null };
  let ticks = 0;
  while (s.side !== SMALL && ticks < 10000) {
    s = M.stepSide(s, M.targetSide(2, FIXTURE), 40, FIXTURE);
    const b = M.borderFor(s.side);
    for (const c of cells) M.pushInside(c, b, FIXTURE);
    ticks++;
  }
  assert.strictEqual(s.side, SMALL);
  assert.strictEqual(cells.length, 300);
  const b = M.borderFor(SMALL);
  for (const c of cells) {
    const r = c.size / 2;
    assert.ok(Number.isFinite(c.x) && Number.isFinite(c.y));
    assert.ok(c.x >= b.minX + r && c.x <= b.maxX - r, 'x of ' + c.id);
    assert.ok(c.y >= b.minY + r && c.y <= b.maxY - r, 'y of ' + c.id);
  }
});
