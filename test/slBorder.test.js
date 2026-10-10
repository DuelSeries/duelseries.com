'use strict';
// slBorder (SERVER-DESIGN 10, 18.1; build brief section 8 row slBorder; task T7): R* for N 0 to 500, clamps, the
// step bound per check, C_N_SMOOTH_MS. Vectors are literals from the law table rows by id (SERVER-LAWS section N):
//   L51 1220000 (area per snake), C_R_MIN { snakes: 22 }, C_R_MAX 31899, L11.step { units: 6, everyMs: 127.43 },
//   C_N_SMOOTH_MS 10000, L11.fast 127.43, L1 32550, L2.size 300, L7 42.67 (the tick the room calls tick() on).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const B = require('../server/sl/slBorder');
const L = require('../server/sl/slLaws');
const { FIXTURE, makeFixture } = require('./slLawsFixture');

const ROOT = path.join(__dirname, '..');
const AREA = 1220000;
const R_MIN = 2923; // round(sqrt(22 x 1220000 / pi)) = round(2922.9159)
const R_MAX = 31899;
const UNITS = 6;
const EVERY = 127.43;
const WINDOW = 10000;
const P = 42.67;

// The test's own formula, written from SERVER-LAWS section M item 2 and 3.
function want(n) {
  return Math.min(R_MAX, Math.max(R_MIN, Math.round(Math.sqrt((n * AREA) / Math.PI))));
}

test('the table rows hold the literals this test uses', () => {
  assert.deepStrictEqual(B.BORDER_LAW_IDS, ['L1', 'L2.size', 'L11.driver', 'L11.step', 'L51', 'C_R_MIN', 'C_R_MAX',
    'C_N_SMOOTH_MS']);
  assert.strictEqual(FIXTURE.L51.value, AREA);
  assert.deepStrictEqual(FIXTURE.C_R_MIN.value, { snakes: 22 });
  assert.strictEqual(FIXTURE.C_R_MAX.value, R_MAX);
  assert.deepStrictEqual(FIXTURE['L11.step'].value, { units: UNITS, everyMs: EVERY });
  assert.strictEqual(FIXTURE['L11.fast'].value, EVERY); // the motion check and the fast z check share one period
  assert.strictEqual(FIXTURE.C_N_SMOOTH_MS.value, WINDOW);
  assert.deepStrictEqual(FIXTURE['L11.driver'].value,
    { rule: 'crowdDensity', count: 'allSnakes', integer: true, start: 'target' });
  assert.strictEqual(FIXTURE.L1.value, 32550);
  assert.strictEqual(FIXTURE['L2.size'].value, 300);
  // Every row the border reads ships (KNOWN, CHOSEN or APPROVED with approvedAt) on the real table.
  assert.strictEqual(L.assertShippable(L.LAWS, B.BORDER_LAW_IDS), L.LAWS);
  const c = B.borderConfig(L.LAWS);
  assert.strictEqual(c.rMin, R_MIN);
  assert.strictEqual(c.rMax, R_MAX);
  assert.strictEqual(c.units, UNITS);
  assert.strictEqual(c.everyMs, EVERY);
  assert.strictEqual(c.smoothMs, WINDOW);
  assert.strictEqual(B.borderConfig(L.LAWS), c); // read once per frozen table
});

test('R* vectors: literal radii, the C_R_MIN floor at 22 snakes and the C_R_MAX ceiling', () => {
  const V = [
    [0, 2923], [1, 2923], [10, 2923], [21, 2923], [22, 2923], [23, 2989], [30, 3413], [50, 4406], [100, 6232],
    [101, 6263], [150, 7632], [200, 8813], [250, 9853], [300, 10794], [330, 11320], [382, 12180], [400, 12463],
    [478, 13624], [500, 13934], [2620, 31897], [2621, 31899], [3000, 31899], [1e6, 31899],
  ];
  for (const [n, r] of V) {
    assert.strictEqual(B.targetRadius(n, FIXTURE), r, 'N ' + n);
    assert.strictEqual(B.targetRadius(n, L.LAWS), r, 'N ' + n + ' real table');
  }
  // SERVER-LAWS section M item 2 examples (rounded there; BUILD-DECISIONS T1: the formula is the law, 2 units).
  for (const [n, r] of [[22, 2923], [50, 4406], [101, 6264], [330, 11322], [478, 13625]]) {
    assert.ok(Math.abs(B.targetRadius(n, FIXTURE) - r) <= 2, 'section M N ' + n);
  }
  // The averaged count is fractional.
  assert.strictEqual(B.targetRadius(22.5, FIXTURE), 2956);
  assert.strictEqual(B.targetRadius(61.5, FIXTURE), 4887);
  assert.strictEqual(B.targetRadius(100.9, FIXTURE), 6260);
});

test('R* for every N 0 to 500: the formula, integers, monotone, the crowd per area held above the floor', () => {
  let prev = -1;
  for (let n = 0; n <= 500; n++) {
    const r = B.targetRadius(n, FIXTURE);
    assert.ok(Number.isInteger(r), 'N ' + n);
    assert.strictEqual(r, want(n), 'N ' + n);
    assert.ok(r >= prev, 'monotone at N ' + n);
    assert.ok(r >= R_MIN && r <= R_MAX, 'clamped at N ' + n);
    if (n >= 23) {
      // pi R^2 / N = area per snake, off only by the rounding of R to an integer (|dR| <= 0.5).
      const a = (Math.PI * r * r) / n;
      const da = (2 * Math.PI * r * 0.5 + Math.PI * 0.25) / n;
      assert.ok(Math.abs(a - AREA) <= da, 'area per snake at N ' + n + ': ' + a);
    }
    prev = r;
  }
  for (const bad of [-1, -0.001, NaN, Infinity, -Infinity, '22', null, undefined]) {
    assert.throws(() => B.targetRadius(bad, FIXTURE), RangeError, String(bad));
  }
});

test('step: at most L11.step.units per check, never past the target, integers only', () => {
  const V = [
    [3000, 3010, 3006], [3000, 3006, 3006], [3000, 3003, 3003], [3000, 3000, 3000], [3000, 2990, 2994],
    [3000, 2994, 2994], [3000, 2999, 2999], [2923, 31899, 2929], [31899, 2923, 31893],
  ];
  for (const [radius, target, r] of V) assert.strictEqual(B.step({ radius, target }, FIXTURE), r, radius + '->' + target);
  assert.throws(() => B.step({ radius: 3000.5, target: 3010 }, FIXTURE), TypeError);
  assert.throws(() => B.step({ radius: 3000, target: NaN }, FIXTURE), TypeError);
  assert.throws(() => B.step(null, FIXTURE), TypeError);
  // The step size comes from the row.
  const t = makeFixture({ 'L11.step': { units: 2, everyMs: EVERY } });
  assert.strictEqual(B.step({ radius: 3000, target: 3010 }, t), 3002);
});

test('the table is checked: missing rows, unbuilt driver forms, bad clamps, maps off the lattice', () => {
  assert.throws(() => B.targetRadius(22, L.withValues(FIXTURE, { L51: null })), /L51/);
  assert.throws(() => B.targetRadius(22, makeFixture({ 'L11.driver': { rule: 'nope' } })), /unknown rule/);
  assert.throws(() => B.targetRadius(22, makeFixture({ 'L11.driver': { rule: 'spawnRing', q: 1 } })), /not built/);
  const d = { rule: 'crowdDensity', count: 'allSnakes', integer: true, start: 'target' };
  for (const patch of [{ count: 'humans' }, { integer: false }, { start: 'min' }, { extra: 1 }]) {
    assert.throws(() => B.targetRadius(22, makeFixture({ 'L11.driver': Object.assign({}, d, patch) })), /L11\.driver/,
      JSON.stringify(patch));
  }
  assert.throws(() => B.targetRadius(22, makeFixture({ C_R_MAX: 2900 })), /above C_R_MAX/);
  assert.throws(() => B.targetRadius(22, makeFixture({ C_R_MAX: 32551 })), /lattice/);
  assert.throws(() => B.targetRadius(22, makeFixture({ C_R_MAX: 3000.5 })), /C_R_MAX/);
  assert.throws(() => B.targetRadius(22, makeFixture({ C_R_MIN: { snakes: 0 } })), /C_R_MIN/);
  assert.throws(() => B.targetRadius(22, makeFixture({ C_R_MIN: 22 })), /C_R_MIN/);
  assert.throws(() => B.targetRadius(22, makeFixture({ 'L11.step': { units: 6.5, everyMs: EVERY } })), /L11\.step/);
  assert.throws(() => B.targetRadius(22, makeFixture({ 'L11.step': { units: 6, everyMs: 0 } })), /L11\.step/);
  assert.throws(() => B.targetRadius(22, makeFixture({ C_N_SMOOTH_MS: -1 })), /C_N_SMOOTH_MS/);
  assert.throws(() => B.targetRadius(22, makeFixture({ L51: 0 })), /L51/);
  // SERVER-DESIGN 10: grd + C_R_MAX inside 255 x sector_size.
  assert.throws(() => B.targetRadius(22, makeFixture({ 'L2.size': 200 })), /255 sectors/);
  // C_R_MIN follows its row: 50 snakes gives the N 50 radius.
  assert.strictEqual(B.targetRadius(0, makeFixture({ C_R_MIN: { snakes: 50 } })), 4406);
  assert.strictEqual(B.targetRadius(101, makeFixture({ C_R_MAX: 5000 })), 5000);
});

test('driver: starts AT the target, first check one period after start, checks on the exact grid', () => {
  for (const [n, r] of [[0, 2923], [22, 2923], [101, 6263], [500, 13934], [3000, 31899]]) {
    const b = B.createBorder(FIXTURE, { nowMs: 0, count: n });
    assert.strictEqual(b.radius(), r, 'start N ' + n);
    assert.strictEqual(b.target(), r);
    assert.strictEqual(b.due(), EVERY);
  }
  const b = B.createBorder(FIXTURE, { nowMs: 1000, count: 22 });
  assert.strictEqual(b.due(), 1000 + EVERY);
  assert.strictEqual(b.tick(1000 + EVERY - 0.001, 22), false);
  assert.strictEqual(b.tick(1000 + EVERY, 22), true);
  assert.strictEqual(b.due(), 1000 + 2 * EVERY);
  // Ticks every L7 period for 1,000,000 ms of sim time: due is always t0 + k x 127.43 (no drift), a check every 2 or 3
  // ticks, and the check count is the number of grid times passed (the mean period is exact).
  const c = B.createBorder(FIXTURE, { nowMs: 0, count: 22 });
  let fired = 0;
  let lastFire = -1;
  const gaps = new Set();
  let t = 0;
  for (let k = 1; k <= 23436; k++) {
    t = k * P;
    if (c.tick(t, 22)) {
      fired++;
      if (lastFire >= 0) gaps.add(k - lastFire);
      lastFire = k;
    }
    const idx = Math.round(c.due() / EVERY);
    assert.ok(Object.is(c.due(), idx * EVERY) && c.due() > t && c.due() - EVERY <= t);
  }
  assert.deepStrictEqual([...gaps].sort(), [2, 3]);
  assert.strictEqual(fired, Math.floor(t / EVERY));
  assert.strictEqual(c.stats().dropped, 0);
  assert.strictEqual(c.stats().checks, fired);
});

test('driver: growth 22 to 101 snakes moves at most 6 per check and per tick, never overshoots, then holds', () => {
  const b = B.createBorder(FIXTURE, { nowMs: 0, count: 22 });
  let r = b.radius();
  let t = 0;
  let checks = 0;
  const start = r;
  let k = 0;
  while (k < 4000) {
    k++;
    t = k * P;
    const n = t < 1000 ? 22 : 101;
    const fired = b.tick(t, n);
    const d = b.radius() - r;
    if (fired) checks++;
    else assert.strictEqual(d, 0, 'no move without a check');
    assert.ok(d >= 0 && d <= UNITS, 'step ' + d + ' at tick ' + k);
    assert.ok(b.radius() <= b.target() || d === 0, 'never past the target');
    // Over any stretch: total move at most 6 x the checks fired.
    assert.ok(b.radius() - start <= UNITS * checks);
    r = b.radius();
  }
  assert.strictEqual(b.radius(), 6263);
  assert.strictEqual(b.target(), 6263);
  // 6263 - 2923 = 3340 units at 6 per 127.43 ms: at least 557 checks, about 71 s.
  const s = b.stats();
  assert.strictEqual(s.meanCount, 101);
  assert.ok(s.checks >= 557);
  // Then the room empties to 0 (bots cleared): it shrinks back by at most 6 per check, to the 22-snake floor.
  r = b.radius();
  for (let j = 0; j < 4000; j++) {
    k++;
    t = k * P;
    b.tick(t, 0);
    const d = r - b.radius();
    assert.ok(d >= 0 && d <= UNITS);
    r = b.radius();
  }
  assert.strictEqual(b.radius(), R_MIN);
});

test('C_N_SMOOTH_MS: the count is a time-weighted mean over the trailing 10 s window', () => {
  // Full window of 22, then 101 from t = 10000: at t = 15000 the mean is (22 x 5000 + 101 x 5000) / 10000 = 61.5.
  const b = B.createBorder(FIXTURE, { nowMs: 0, count: 22 });
  b.tick(10000, 101);
  b.tick(15000, 101);
  assert.strictEqual(b.stats().meanCount, 61.5);
  assert.strictEqual(b.target(), 4887);
  b.tick(20000, 101);
  assert.strictEqual(b.stats().meanCount, 101);
  // Less history than the window: the mean over the history there is.
  const h = B.createBorder(FIXTURE, { nowMs: 0, count: 22 });
  h.tick(1000, 101);
  h.tick(2000, 101);
  assert.strictEqual(h.stats().meanCount, 61.5);
  // One death at 101 snakes, the respawn 1 s later: the target moves 3 units (6263 to 6260), not 31 (the raw N 100).
  const d = B.createBorder(FIXTURE, { nowMs: 0, count: 101 });
  d.tick(20000, 101);
  d.tick(20000 + P, 100);
  d.tick(21000 + P, 101);
  assert.strictEqual(d.target(), 6260);
  assert.strictEqual(B.targetRadius(100, FIXTURE), 6232);
  // The window length is the row's: with C_N_SMOOTH_MS 2000 the same jump is fully in after 2 s.
  const w = B.createBorder(makeFixture({ C_N_SMOOTH_MS: 2000 }), { nowMs: 0, count: 22 });
  w.tick(10000, 101);
  w.tick(11000, 101);
  assert.strictEqual(w.stats().meanCount, 61.5);
  w.tick(12000, 101);
  assert.strictEqual(w.stats().meanCount, 101);
});

test('C_N_SMOOTH_MS: the mean equals a brute-force integral over 60,000 random tick counts', () => {
  // A plain recount: keep every (t, n) and integrate the step function over [max(0, now - W), now].
  let seed = 7;
  function rnd() {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return seed / 4294967296;
  }
  const hist = [[0, 50]];
  const m = B.createCountMean(WINDOW, 0, 50);
  let n = 50;
  let maxPoints = 0;
  for (let k = 1; k <= 60000; k++) {
    const t = k * P;
    const u = rnd();
    if (u < 0.3) n = Math.max(0, Math.min(500, n + Math.floor(rnd() * 21) - 10));
    m.observe(t, n);
    if (n !== hist[hist.length - 1][1]) hist.push([t, n]);
    maxPoints = Math.max(maxPoints, m.points());
    if (k % 97 === 0) {
      const lo = Math.max(0, t - WINDOW);
      let sum = 0;
      for (let i = 0; i < hist.length; i++) {
        const a = Math.max(hist[i][0], lo);
        const e = i + 1 < hist.length ? hist[i + 1][0] : t;
        if (e > a) sum += hist[i][1] * (e - a);
      }
      const ref = sum / (t - lo);
      assert.ok(Math.abs(m.value(t) - ref) <= 1e-9 * Math.max(1, ref), 'tick ' + k + ': ' + m.value(t) + ' vs ' + ref);
    }
  }
  // The ring holds only the window: at most one point per tick inside 10 s plus the one covering its start.
  assert.ok(maxPoints <= Math.ceil(WINDOW / P) + 2, 'points ' + maxPoints);
  assert.throws(() => m.observe(1000, 3), /clock went back/);
});

test('driver: a long gap fires ONE check and drops the missed ones; bad input throws; deterministic', () => {
  const b = B.createBorder(FIXTURE, { nowMs: 0, count: 22 });
  b.tick(P, 101);
  const r0 = b.radius();
  // 60 s with no tick (an idle pause): one check, at most 6 units, the next due on the grid after now.
  assert.strictEqual(b.tick(60000, 101), true);
  assert.ok(b.radius() - r0 <= UNITS);
  const s = b.stats();
  assert.strictEqual(s.checks, 1);
  assert.strictEqual(s.dropped, Math.floor(60000 / EVERY) - 1);
  assert.strictEqual(b.due(), (Math.floor(60000 / EVERY) + 1) * EVERY);
  assert.strictEqual(b.tick(60010, 101), false); // the next grid time is 471 x 127.43 = 60019.53
  assert.throws(() => b.tick(1000, 22), /clock went back/);
  assert.throws(() => b.tick(70000, -1), RangeError);
  assert.throws(() => b.tick(70000, 2.5), RangeError);
  assert.throws(() => b.tick(NaN, 22), TypeError);
  assert.throws(() => B.createBorder(FIXTURE, { nowMs: 0 }), RangeError);
  assert.throws(() => B.createBorder(FIXTURE, { nowMs: Infinity, count: 1 }), TypeError);

  function run() {
    const x = B.createBorder(FIXTURE, { nowMs: 0, count: 30 });
    let seed = 99;
    let n = 30;
    const out = [];
    for (let k = 1; k <= 20000; k++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      if (seed % 7 === 0) n = Math.max(0, Math.min(300, n + (seed % 11) - 5));
      x.tick(k * P, n);
      out.push(x.radius());
    }
    return out.join(',');
  }
  assert.strictEqual(run(), run());
});

test('slBorder holds no randomness, no wall clock, no money and requires only slLaws', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server/sl/slBorder.js'), 'utf8');
  assert.doesNotMatch(src, /Math\.random|Date\.now|new Date|performance\.now|setTimeout|setInterval/);
  assert.doesNotMatch(src, /slither-reference|money|wallet|escrow|stake|usdc/i);
  const reqs = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.deepStrictEqual(reqs, ['./slLaws']);
});
