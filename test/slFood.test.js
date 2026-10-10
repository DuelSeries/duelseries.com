'use strict';
// slFood (SERVER-DESIGN 6.4; task T5): the food store by cell, natural fill and passes, drops, eats.
// Done when: one food per cell over 20,000 ticks; passes on the L29 clock; no natural spawn outside the border; never
// a `c`; the natural profile targeted, the standing total only reported.
// Vectors are literals copied from the law rows by id (SERVER-LAWS section N): L1 32550, L2.size 300, L26 bands,
// L27 base 15 span 32.5, L28 weights, L29.period 503.92, L29.rate guardMult 2 and bands.
const test = require('node:test');
const assert = require('node:assert');
const { FIXTURE, makeFixture } = require('./slLawsFixture');
const { createGrid } = require('../server/sl/slGrid');
const { streams, createRng } = require('../server/sl/slRng');
const F = require('../server/sl/slFood');
const RC = require('../server/sl/slRecordCache');

const GRD = 32550;
const SS = 300;
const CELL = 300 / 256;
const P = 42.67; // L7
const PERIOD = 503.92; // L29.period
const PV = 19; // L6 protocol

function world(seed, laws) {
  const grid = createGrid({ sectorSize: SS, grd: GRD });
  const rng = streams(seed);
  const food = F.createFood(laws || FIXTURE, { grid, rng: rng.food });
  return { grid, rng, food };
}

function inside(x, y, flux) {
  return (x - GRD) * (x - GRD) + (y - GRD) * (y - GRD) <= flux * flux;
}

test('food laws: the FIXTURE rows, literally', () => {
  const K = F.foodLaws(FIXTURE);
  assert.strictEqual(K.grd, 32550);
  assert.strictEqual(K.sectorSize, 300);
  assert.strictEqual(K.radBase, 15);
  assert.strictEqual(K.radSpan, 32.5);
  assert.deepStrictEqual(K.weights, [6, 33.3, 8.3, 9.5, 7.9, 7.1, 2.4, 19.7, 5.8]);
  assert.ok(Math.abs(K.wTotal - 100) < 1e-9);
  assert.strictEqual(K.period, 503.92);
  assert.strictEqual(K.guardMult, 2);
  assert.strictEqual(K.targetBands.length, 6);
  assert.strictEqual(K.rateBands.length, 12);
  assert.deepStrictEqual(F.FOOD_LAW_IDS, ['L1', 'L2.size', 'L25', 'L26', 'L27', 'L28', 'L29.period', 'L29.rate',
    'L30', 'C_FOOD_SCALE', 'C_OUTSIDE_FOOD', 'C_DROP_CELL', 'C_FOOD_FULL_FORMS']);
});

test('L26 target and L29 rate by fraction of the radius (band upper edges, half-open)', () => {
  const { food } = world(1);
  const target = [[0, 5.9], [0.0799, 5.9], [0.08, 3.8], [0.159, 3.8], [0.16, 3.6], [0.5, 3.6], [0.56, 3.2],
    [0.72, 2.3], [0.88, 1], [0.999, 1], [1, 1], [1.4, 1]];
  for (const [f, v] of target) assert.strictEqual(food.targetAt(f), v, 'target at ' + f);
  const rate = [[0, 0.231], [0.08, 0.155], [0.16, 0.13], [0.24, 0.083], [0.32, 0.083], [0.4, 0.088], [0.48, 0.067],
    [0.56, 0.038], [0.64, 0.048], [0.72, 0.042], [0.8, 0.022], [0.88, 0.018], [0.99, 0.018], [1.2, 0.018]];
  for (const [f, v] of rate) assert.strictEqual(food.rateAt(f), v, 'rate at ' + f);
});

test('refuses rows it has not built', () => {
  assert.throws(() => F.foodLaws(makeFixture({ C_FOOD_SCALE: 'absolute' })), /C_FOOD_SCALE/);
  assert.throws(() => F.foodLaws(makeFixture({ C_DROP_CELL: 'drop' })), /C_DROP_CELL/);
  assert.throws(() => F.foodLaws(makeFixture({ C_FOOD_FULL_FORMS: false })), /C_FOOD_FULL_FORMS/);
  assert.throws(() => F.foodLaws(makeFixture({ C_OUTSIDE_FOOD: { naturalInsideOnly: false, outsideStays: true } })),
    /C_OUTSIDE_FOOD/);
  assert.throws(() => F.foodLaws(makeFixture({ L25: { rule: 'packetByContext', natural: 'b', drop: 'b', dump: 'F' } })), /L25/);
  assert.throws(() => F.foodLaws(makeFixture({ L30: { rule: 'expireAfter', ms: 1000 } })), /unknown rule|not built/);
  assert.throws(() => F.foodLaws(makeFixture({ L26: { rule: 'radialProfile', bands: [[0.5, 3], [0.9, 1]] } })), /L26/);
  const grid = createGrid({ sectorSize: 600, grd: GRD });
  assert.throws(() => F.createFood(FIXTURE, { grid, rng: createRng(1) }), /lattice/);
});

test('passes run on the L29 clock: first tick at or after each due time, mean period exact', () => {
  const { food } = world(2);
  const ticks = [];
  for (let k = 1; k <= 20000; k++) {
    food.beginTick();
    if (food.step(k * P, 2923)) ticks.push(k);
  }
  // 20000 x 42.67 = 853400 ms; due times 503.92 j; passes = floor(853400 / 503.92) = 1693
  assert.strictEqual(ticks.length, 1693);
  assert.strictEqual(ticks[0], 12); // ceil(503.92 / 42.67) = ceil(11.8097)
  assert.strictEqual(ticks[1], 24); // ceil(1007.84 / 42.67) = ceil(23.619)
  for (let j = 0; j < ticks.length; j++) {
    const dueAt = (j + 1) * PERIOD;
    assert.ok(ticks[j] * P >= dueAt - 1e-6 && (ticks[j] - 1) * P < dueAt + 1e-6, 'pass ' + j + ' at tick ' + ticks[j]);
  }
  assert.strictEqual(food.stats().passes, 1693);
});

test('one food per cell over 20,000 ticks of passes, drops onto taken cells and eats; no natural food outside the border', () => {
  const { grid, rng, food } = world(3);
  const t = createRng(99); // the test's own stream for where drops and eats go
  let flux = 6264;
  food.fill(flux);
  let naturalSeen = 0;
  let outsideLeft = 0;
  const hot = [GRD + 100.3, GRD - 220.7]; // one spot hit by many drops: forces the nearest-free search
  for (let k = 1; k <= 20000; k++) {
    if (k % 2500 === 0) flux = flux === 6264 ? 2923 : 6264; // the border moves both ways
    food.beginTick();
    // drops: a burst at the hot spot and a few anywhere near the centre
    if (k % 7 === 0) food.drop(hot[0], hot[1], 24 + t.int(21), t.int(9));
    if (k % 3 === 0) food.drop(GRD + t.range(-5000, 5000), GRD + t.range(-5000, 5000), 68 + t.int(14), t.int(9));
    // eats: a disc at a random spot, every food in it, with an eater
    if (k % 2 === 0) {
      food.forEachInDisc(GRD + t.range(-4000, 4000), GRD + t.range(-4000, 4000), 60, (f) => food.eat(f, 1 + t.int(500)));
    }
    food.step(k * P, flux);
    for (const f of food.tick.adds) {
      if (f.nat) {
        naturalSeen++;
        assert.ok(inside(f.x, f.y, flux), 'natural food outside the border at tick ' + k);
      }
    }
    for (const e of food.tick.eats) assert.strictEqual(e.ev.cmd, '<');
    if (k % 1000 === 0) assert.deepStrictEqual(food.check(), [], 'invariants at tick ' + k);
  }
  assert.deepStrictEqual(food.check(), []);
  // one food per cell: every held food's id is its cell, and the ids are unique
  const ids = new Set();
  food.forEachFood((f) => {
    assert.ok(!ids.has(f.id), 'two foods in cell ' + f.id);
    ids.add(f.id);
    assert.strictEqual(f.id, (f.sx << 24) | (f.sy << 16) | (f.rx << 8) | f.ry);
    if (!inside(f.x, f.y, 2923)) outsideLeft++;
  });
  assert.strictEqual(ids.size, grid.foodTotal());
  const s = food.stats();
  assert.ok(naturalSeen > 1000, 'natural spawns ' + naturalSeen);
  assert.ok(s.moved > 100, 'drops onto taken cells moved ' + s.moved);
  assert.strictEqual(s.lost, 0);
  assert.ok(s.eatenNatural > 0 && s.eatenDrop > 0);
  assert.strictEqual(s.standing, s.natural + s.drops);
  // the border shrank to 2923 last; food it left outside stays (C_OUTSIDE_FOOD, L30: no expiry)
  assert.ok(outsideLeft > 0, 'food outside the shrunk border stays');
  // determinism: the same seed and calls give the same store
  assert.strictEqual(typeof food.digest(), 'string');
  assert.ok(rng.food.state() !== 0);
});

test('same seed, same calls: same digest; another seed differs', () => {
  const run = (seed) => {
    const { food } = world(seed);
    food.fill(2923);
    for (let k = 1; k <= 3000; k++) {
      food.beginTick();
      if (k % 5 === 0) food.drop(GRD + (k % 97) * 3.3, GRD - (k % 89) * 2.9, 30, k % 9);
      food.step(k * P, 2923);
    }
    return food.digest();
  };
  assert.strictEqual(run(5), run(5));
  assert.notStrictEqual(run(5), run(6));
});

test('drops: the cell of the position, else the nearest free cell of that sector (C_DROP_CELL)', () => {
  const { food } = world(4);
  // (32555.3, 32561.9): sector 108, cell rx = floor(155.3 / 1.171875) = 132, ry = floor(161.9 / 1.171875) = 138
  const a = food.drop(32555.3, 32561.9, 40, 3);
  assert.deepStrictEqual([a.sx, a.sy, a.rx, a.ry], [108, 108, 132, 138]);
  assert.strictEqual(a.x, 108 * 300 + 132 * CELL);
  assert.strictEqual(a.y, 108 * 300 + 138 * CELL);
  assert.strictEqual(a.nat, false);
  assert.strictEqual(a.rad, 8); // 40 / 5
  // the same spot again: ring 1, distance 1, first in scan order (rows from the top) = (132, 137)
  const b = food.drop(32555.3, 32561.9, 41, 3);
  assert.deepStrictEqual([b.rx, b.ry], [132, 137]);
  const c = food.drop(32555.3, 32561.9, 42, 3);
  assert.deepStrictEqual([c.rx, c.ry], [131, 138]);
  const d = food.drop(32555.3, 32561.9, 43, 3);
  assert.deepStrictEqual([d.rx, d.ry], [133, 138]);
  const e = food.drop(32555.3, 32561.9, 44, 3);
  assert.deepStrictEqual([e.rx, e.ry], [132, 139]);
  const g = food.drop(32555.3, 32561.9, 45, 3); // the four at distance 1 are taken: sqrt 2, first in scan order
  assert.deepStrictEqual([g.rx, g.ry], [131, 137]);
  // a cell at the sector edge searches inside its own sector only
  const h1 = food.drop(108 * 300 + 0.2, 108 * 300 + 0.2, 30, 0);
  const h2 = food.drop(108 * 300 + 0.2, 108 * 300 + 0.2, 30, 0);
  assert.deepStrictEqual([h1.sx, h1.rx, h1.ry, h2.sx, h2.sy, h2.rx, h2.ry], [108, 0, 0, 108, 108, 1, 0]);
  assert.throws(() => food.drop(NaN, 1, 30, 0), /finite/);
  assert.throws(() => food.drop(1, 1, 256, 0), /byte/);
  assert.throws(() => food.drop(1, 1, 30, 9), /colour/);
  assert.strictEqual(food.stats().moved, 6);
});

test('never a `c`: an eat always names its eater, nothing else removes food', () => {
  const { food, grid } = world(5);
  food.fill(2923);
  const n0 = grid.foodTotal();
  // passes with the border shrunk to a sliver: nothing outside is removed
  for (let k = 1; k <= 200; k++) {
    food.beginTick();
    food.step(k * P, 400);
  }
  assert.ok(grid.foodTotal() >= n0, 'no food left the map without an eater');
  let some = null;
  food.forEachFood((f) => { if (!some) some = f; });
  assert.throws(() => food.eat(some, 0), /eater/);
  assert.throws(() => food.eat(some, undefined), /eater/);
  const ev = food.eat(some, 7);
  assert.deepStrictEqual(ev, { type: 'food_eat', cmd: '<', sectorFromLast: false, sx: some.sx, sy: some.sy,
    rx: some.rx, ry: some.ry, eater: 7 });
  assert.throws(() => food.eat(some, 7), /not on the map/);
  assert.strictEqual(grid.foodTotal(), n0 - 1 + food.stats().spawned);
  // the store has no remove, expire or decay entry point
  for (const k of Object.keys(food)) assert.ok(!/remove|expire|decay/i.test(k), 'unexpected entry point ' + k);
});

test('natural profile targeted: fill mean per band near the L26 target; the guard counts natural food only', () => {
  const { food } = world(6);
  food.fill(12500);
  // mean natural count per whole sector in the 0.16 to 0.56 band (target 3.6) and the 0.56 to 0.72 band (3.2)
  const acc = { a: [0, 0], b: [0, 0] };
  food.forEachBorderSector(12500, (sx, sy, si, f) => {
    if (f >= 0.16 && f < 0.56) { acc.a[0] += food.naturalCountIn(si); acc.a[1]++; }
    if (f >= 0.56 && f < 0.72) { acc.b[0] += food.naturalCountIn(si); acc.b[1]++; }
  });
  const ma = acc.a[0] / acc.a[1];
  const mb = acc.b[0] / acc.b[1];
  assert.ok(Math.abs(ma - 3.6) < 0.18, 'band 0.16-0.56 mean ' + ma);
  assert.ok(Math.abs(mb - 3.2) < 0.2, 'band 0.56-0.72 mean ' + mb);
  // passes with no eats stop each sector at guardMult x target (L29.rate guardMult 2): a pass adds only while the
  // natural count is below 2 x target, so a sector ends at most at ceil(2 x target), or at its fill count when the
  // Poisson fill already put it above that
  const afterFill = new Map();
  food.forEachBorderSector(12500, (sx, sy, si) => afterFill.set(si, food.naturalCountIn(si)));
  for (let k = 1; k <= 4000; k++) {
    food.beginTick();
    food.step(k * P, 12500);
  }
  let atGuard = 0;
  let sectors = 0;
  food.forEachBorderSector(12500, (sx, sy, si, f) => {
    const cap = Math.ceil(2 * food.targetAt(f));
    const n = food.naturalCountIn(si);
    assert.ok(n <= Math.max(cap, afterFill.get(si)), 'sector ' + si + ' holds ' + n + ' above its guard ' + cap);
    sectors++;
    if (n >= 2 * food.targetAt(f)) atGuard++;
  });
  // 4000 ticks is 170 s: at the slowest edge rate 0.018 per s most sectors have reached the guard
  assert.ok(atGuard / sectors > 0.5, 'sectors at the guard ' + atGuard + ' of ' + sectors);
  // drops never count toward the guard: a sector full of drops still spawns natural food
  const g2 = world(7);
  for (let i = 0; i < 400; i++) g2.food.drop(GRD + 10 + (i % 20) * 7, GRD + 10 + Math.floor(i / 20) * 7, 30, 1);
  const si = g2.grid.sectorAt(GRD + 10, GRD + 10);
  let nat = 0;
  for (let k = 1; k <= 30000 && nat === 0; k++) {
    g2.food.beginTick();
    g2.food.step(k * P, 2923);
    nat = g2.food.naturalCountIn(si);
  }
  assert.ok(nat > 0, 'natural food spawned beside 400 drops');
  assert.strictEqual(g2.food.stats().standing, g2.food.stats().natural + g2.food.stats().drops);
});

test('natural sizes (L27) and colours (L28): support and shares over many spawns', () => {
  const { food } = world(8);
  food.fill(31899);
  const bytes = new Map();
  const cols = new Array(9).fill(0);
  let n = 0;
  food.forEachFood((f) => {
    n++;
    bytes.set(f.b, (bytes.get(f.b) || 0) + 1);
    cols[f.cv]++;
    assert.strictEqual(f.rad, f.b / 5);
  });
  assert.ok(n > 50000, 'foods ' + n);
  assert.deepStrictEqual([...bytes.keys()].sort((a, b) => a - b), Array.from({ length: 33 }, (_, i) => 15 + i));
  // byte 47 at half the share of the others (15 + floor(32.5 u))
  const share47 = bytes.get(47) / n;
  assert.ok(Math.abs(share47 - 0.5 / 32.5) < 0.004, 'byte 47 share ' + share47);
  const w = [6, 33.3, 8.3, 9.5, 7.9, 7.1, 2.4, 19.7, 5.8];
  for (let i = 0; i < 9; i++) assert.ok(Math.abs(cols[i] / n - w[i] / 100) < 0.01, 'colour ' + i + ' share ' + cols[i] / n);
});

test('records: natural f slow, drop b fast, dumps F, eats < ; all on their wire grid, no kind 15', () => {
  const { food, grid } = world(9);
  food.fill(2923);
  let nat = null;
  for (let k = 1; !nat; k++) {
    food.beginTick();
    food.step(k * P, 2923);
    nat = food.tick.adds.find((f) => f.nat) || null;
  }
  const dropped = food.drop(GRD + 3.7, GRD + 9.1, Math.round(84.2853 * Math.sqrt(0.0815) + 0.1702), 5);
  const ea = food.addEvent(nat);
  assert.strictEqual(ea, food.addEvent(nat), 'one event object per food');
  assert.deepStrictEqual(ea, { type: 'food_add', rapid: false, sectorFromLast: false, sx: nat.sx, sy: nat.sy,
    rx: nat.rx, ry: nat.ry, cvFromLast: false, cv: nat.cv, rad: nat.b / 5 });
  assert.strictEqual(food.addEvent(dropped).rapid, true);
  const si = grid.sectorAt(GRD + 3.7, GRD + 9.1);
  const dump = food.dumpEvent(si);
  assert.strictEqual(dump, food.dumpEvent(si), 'one dump per sector per tick');
  assert.strictEqual(dump.type, 'food_sector');
  assert.strictEqual(dump.foods.length, grid.foodCountIn(si));
  // an empty sector has no dump (L8.adds)
  assert.strictEqual(food.dumpEvent(0), null);
  const eat = food.eat(dropped, 12);
  const cache = RC.createRecordCache(PV);
  const evs = [ea, food.addEvent(dropped), dump, eat];
  const scan = RC.scanBundle(RC.bundleBytes(evs.map((e) => cache.recordBytes(e, false))));
  assert.strictEqual(scan.wireError, null);
  assert.deepStrictEqual(scan.kind15, []);
  assert.deepStrictEqual(scan.offGrid, []);
  assert.deepStrictEqual(scan.events.map((e) => e.type), ['food_add', 'food_add', 'food_sector', 'food_eat']);
  assert.strictEqual(scan.events[3].cmd, '<');
  assert.strictEqual(scan.events[3].eater, 12);
});

test('forEachInDisc: distance <= r from the cell position, safe to eat inside', () => {
  const { food } = world(10);
  const a = food.drop(GRD, GRD, 30, 0); // cell (108, 108, 128, 128): x = 32400 + 150 = 32550
  const b = food.drop(GRD + 10, GRD, 30, 0);
  food.drop(GRD + 50, GRD, 30, 0);
  const got = [];
  const n = food.forEachInDisc(GRD, GRD, 10.5, (f) => { got.push(f); food.eat(f, 3); });
  assert.strictEqual(n, 2);
  assert.deepStrictEqual(got.map((f) => f.id).sort(), [a.id, b.id].sort());
  assert.strictEqual(food.stats().drops, 1);
  assert.throws(() => food.forEachInDisc(GRD, GRD, -1, () => {}), /finite/);
});

test('slFood and slPrey use no Math.random, no Date, no money code and never import the fixture', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  for (const f of ['slFood.js', 'slPrey.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'sl', f), 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!/Math\.random/.test(src), f + ' uses Math.random');
    assert.ok(!/\bDate\b/.test(src), f + ' uses Date');
    assert.ok(!/slLawsFixture/.test(src), f + ' imports the fixture');
    const reqs = (src.match(/require\(([^)]*)\)/g) || []).map((r) => r.slice(9, -2));
    for (const r of reqs) assert.ok(/^\.\/sl[A-Z]\w*$/.test(r), f + ' requires ' + r);
  }
});
