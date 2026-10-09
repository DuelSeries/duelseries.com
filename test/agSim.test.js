'use strict';
// agar.io server sim (build brief 9.2 agSim card), run on the FIXTURE law table. Every number below follows from a
// KNOWN row or a FIXTURE (unapproved suggestion) value and must be re-pinned when Owen approves the real rows.
const test = require('node:test');
const assert = require('node:assert');
const { createSim, popPieces, equalPopPieces, SIM_LAW_IDS } = require('../server/ag/agSim');
const { LAWS, withValues, massOf } = require('../server/ag/agLaws');
const { createRng } = require('../server/ag/agRng');
const { FIXTURE, makeFixture } = require('./agLawsFixture');

const BIG = { minX: -5000, minY: -5000, maxX: 5000, maxY: 5000 };

function emptySim(laws) {
  return createSim({ laws: laws || FIXTURE, seed: 1, border: BIG, food: false, viruses: false });
}

function cellsOf(sim, pid) {
  return sim.playerInfo(pid).cells.map((id) => sim.getCell(id));
}

test('refuses to start on missing laws or unbuilt rules and names them', () => {
  assert.throws(() => createSim({ laws: withValues(FIXTURE, { L3: null, L5: null }), seed: 1 }),
    (e) => /L3\b/.test(e.message) && /L5\b/.test(e.message));
  // The real table (all approved 2026-10-02) runs: its rules L6 'linearRamp', L29 'equalPieces' and L32 grows
  // 'whileUneaten' (with L32_GROW 'randomStep') are built. A rule name the sim does not build is still refused.
  assert.doesNotThrow(() => createSim({ laws: LAWS, seed: 1 }));
  assert.throws(() => createSim({ laws: withValues(LAWS, { L6: { rule: 'curve', zoneSizes: 1 } }), seed: 1 }),
    /L6 rule "curve" is not implemented/);
  assert.throws(() => createSim({ laws: withValues(LAWS, { L6: { rule: 'linearRamp' } }), seed: 1 }), /L6 zoneSizes/);
  assert.throws(() => createSim({ laws: withValues(LAWS, { L32: { minSize: 10, maxSize: 16, grows: 'often' } }),
    seed: 1 }), /L32 rule "often" is not implemented/);
  assert.throws(() => createSim({ laws: withValues(LAWS, { L32_GROW: { rule: 'randomStep', chancePerTick: 1,
    stepSize: 1 } }), seed: 1 }), /L32_GROW chancePerTick/);
  assert.throws(() => createSim({ laws: withValues(LAWS, { L32_GROW: null }), seed: 1 }), /L32_GROW/);
  assert.throws(() => createSim({ laws: withValues(LAWS, { L33: Object.assign({}, LAWS.L33.value, { thirdMin: 300 }) }),
    seed: 1 }), /L33/);
  assert.throws(() => createSim({ laws: withValues(FIXTURE, { L5: null }), seed: 1 }), /L5/);
  assert.throws(() => createSim({ laws: makeFixture({ L29: { rule: 'og', minPieceMass: 36 } }), seed: 1 }), /L29/);
  assert.throws(() => createSim({ laws: makeFixture({ U_EAT_REMOVE: 'later' }), seed: 1 }), /U_EAT_REMOVE/);
  assert.throws(() => createSim({ laws: FIXTURE }), /seed/);
  assert.ok(SIM_LAW_IDS.includes('L2') && SIM_LAW_IDS.includes('L39') && SIM_LAW_IDS.includes('L23'));
});

test('split gate: 59.99 cannot split, 60 splits into two of sqrt(60*60/2)', () => {
  const sim = emptySim();
  const a = sim.addPlayer({ name: 'a' });
  sim.debugPlace({ kind: 'player', owner: a, x: 0, y: 0, size: 59.99 });
  sim.split(a);
  sim.step();
  assert.strictEqual(sim.playerInfo(a).cells.length, 1);

  const b = sim.addPlayer({ name: 'b' });
  sim.debugPlace({ kind: 'player', owner: b, x: 1000, y: 0, size: 60 });
  sim.setInput(b, { x: 2000, y: 0, split: true });
  const ev = sim.step();
  const cs = cellsOf(sim, b);
  assert.strictEqual(cs.length, 2);
  for (const c of cs) assert.strictEqual(c.size, 42.42640687119285);
  assert.strictEqual(42.42640687119285, Math.sqrt(60 * 60 / 2));
  // The new id is announced as own in the tick that creates it.
  assert.deepStrictEqual(ev.newOwn.filter(([, id]) => id === cs[1].id), [[b, cs[1].id]]);
  assert.ok(ev.added.includes(cs[1].id));

  // With the comparison approved as '>' a size-60 cell does not split.
  const strict = emptySim(makeFixture({ L8_CMP: '>' }));
  const c = strict.addPlayer({});
  strict.debugPlace({ kind: 'player', owner: c, x: 0, y: 0, size: 60 });
  strict.split(c);
  strict.step();
  assert.strictEqual(strict.playerInfo(c).cells.length, 1);
});

test('size 1000 split on 4 ticks gives 16 cells of 250; a 5th split leaves 16; size^2 sum kept', () => {
  const sim = emptySim();
  const a = sim.addPlayer({});
  sim.debugPlace({ kind: 'player', owner: a, x: 0, y: 0, size: 1000 });
  sim.setInput(a, { x: 3000, y: 1000 });
  const sumSq = () => cellsOf(sim, a).reduce((s, c) => s + c.size * c.size, 0);
  const before = sumSq();
  for (let i = 0; i < 4; i++) {
    sim.split(a);
    sim.step();
  }
  let cs = cellsOf(sim, a);
  assert.strictEqual(cs.length, 16);
  for (const c of cs) assert.ok(Math.abs(c.size - 250) < 1e-9, 'size ' + c.size);
  assert.ok(Math.abs(sumSq() - before) / before < 1e-9);
  sim.split(a);
  sim.step();
  cs = cellsOf(sim, a);
  assert.strictEqual(cs.length, 16);
  assert.ok(Math.abs(sumSq() - before) / before < 1e-9);
});

test('eat rule: 115 eats 100 at 81.66 not 81.67; 114.9 never; areas add; eaten id eaten and removed same tick', () => {
  // The rule's mechanics with an explicit ratio of 1.15 (a test value; the real L23 is MEASURED 1.17, checked below)
  const RATIO = makeFixture({ L23: 1.15 });
  function pair(bigSize, d, laws) {
    const sim = emptySim(laws || RATIO);
    const a = sim.addPlayer({});
    const b = sim.addPlayer({});
    const big = sim.debugPlace({ kind: 'player', owner: a, x: 0, y: 0, size: bigSize });
    const small = sim.debugPlace({ kind: 'player', owner: b, x: d, y: 0, size: 100 });
    return { sim, a, b, big, small };
  }
  const yes = pair(115, 81.66);
  const ev = yes.sim.step();
  assert.deepStrictEqual(ev.eats, [[yes.big, yes.small]]);
  assert.ok(ev.removed.includes(yes.small));
  assert.strictEqual(yes.sim.getCell(yes.small), null);
  assert.strictEqual(yes.sim.getCell(yes.big).size, 152.3975065412817);
  assert.strictEqual(152.3975065412817, Math.sqrt(115 * 115 + 100 * 100));
  assert.deepStrictEqual(ev.died, [yes.b]);

  const no = pair(115, 81.67);
  assert.deepStrictEqual(no.sim.step().eats, []);
  assert.ok(no.sim.getCell(no.small));
  assert.strictEqual(81.66666666666666, 115 - 100 / 3);

  for (const d of [0, 10, 40]) {
    const never = pair(114.9, d);
    for (let i = 0; i < 5; i++) assert.deepStrictEqual(never.sim.step().eats, []);
  }

  // The real ratio (L23 MEASURED 1.17, copied into the fixture): 117.1 eats 100 on top of it, 116.9 never.
  assert.strictEqual(FIXTURE.L23.value, 1.17);
  const big = pair(117.1, 0, FIXTURE);
  assert.deepStrictEqual(big.sim.step().eats, [[big.big, big.small]]);
  const short = pair(116.9, 0, FIXTURE);
  for (let i = 0; i < 5; i++) assert.deepStrictEqual(short.sim.step().eats, []);
});

test('a merge joins two cells of the same player after the merge time, as a plain removal (no eat record)', () => {
  const sim = emptySim();
  const a = sim.addPlayer({});
  // Merge time at size 50 is max(30, 0.2 * 50) s = 750 ticks of L1 (fixture L12; L1 MEASURED 40.014 ms); born long ago.
  const big = sim.debugPlace({ kind: 'player', owner: a, x: 0, y: 0, size: 60, born: -2000 });
  const small = sim.debugPlace({ kind: 'player', owner: a, x: 10, y: 0, size: 50, born: -2000 });
  const ev = sim.step();
  // U_EAT_REMOVE (measured): their server never lists a merge as an eat; the merged id is only removed.
  assert.deepStrictEqual(ev.eats, []);
  assert.ok(ev.removed.includes(small));
  assert.strictEqual(sim.getCell(small), null);
  assert.deepStrictEqual(ev.died, []);
  assert.strictEqual(sim.getCell(big).size, Math.sqrt(60 * 60 + 50 * 50));

  // Young own cells (just split) never merge and are not pushed apart while under 13 ticks old.
  const sim2 = emptySim();
  const b = sim2.addPlayer({});
  sim2.debugPlace({ kind: 'player', owner: b, x: 0, y: 0, size: 60 });
  sim2.debugPlace({ kind: 'player', owner: b, x: 10, y: 0, size: 50 });
  assert.deepStrictEqual(sim2.step().eats, []);
});

test('own cells past 13 ticks that cannot merge are pushed apart by the other cell\'s size^2 share', () => {
  const sim = emptySim();
  const a = sim.addPlayer({});
  const p = sim.debugPlace({ kind: 'player', owner: a, x: 0, y: 0, size: 60, born: -20 });
  const q = sim.debugPlace({ kind: 'player', owner: a, x: 50, y: 0, size: 40, born: -20 });
  sim.step();
  const P = sim.getCell(p);
  const Q = sim.getCell(q);
  const push = (100 - 50) / 50;
  assert.strictEqual(P.x, 0 - 50 * (push * 1600 / 5200));
  assert.strictEqual(Q.x, 50 + 50 * (push * 3600 / 5200));
  assert.ok(Math.abs(Q.x - P.x - 100) < 1e-9);
});

test('movement: min(distance, 2.2 * size^-0.45 * 40) per tick toward the target', () => {
  const sim = emptySim();
  const a = sim.addPlayer({});
  const id = sim.debugPlace({ kind: 'player', owner: a, x: 0, y: 0, size: 100 });
  sim.setInput(a, { x: 3000, y: 4000 });
  sim.step();
  const c = sim.getCell(id);
  const speed = 2.2 * Math.pow(100, -0.45) * 40;
  assert.strictEqual(c.x, 3000 * (speed / 5000));
  assert.strictEqual(c.y, 4000 * (speed / 5000));
  sim.setInput(a, { x: c.x + 1, y: c.y });
  const x0 = c.x;
  sim.step();
  assert.strictEqual(c.x, x0 + 1);
  // The target is clamped to the border like their client clamps it.
  sim.setInput(a, { x: 1e12, y: c.y });
  sim.step();
  assert.ok(Number.isFinite(c.x) && c.x <= BIG.maxX);
  assert.strictEqual(sim.setInput(a, { x: NaN, y: 0 }), true);
  assert.strictEqual(sim.playerInfo(a).target.x, 1e12);
});

test('border: centre kept within [min + size/2, max - size/2], boost reflected', () => {
  const sim = emptySim();
  const a = sim.addPlayer({});
  const id = sim.debugPlace({ kind: 'player', owner: a, x: 4990, y: 0, size: 100 });
  sim.step();
  assert.strictEqual(sim.getCell(id).x, 4950);
  const blob = sim.debugPlace({ kind: 'ejected', x: 4900, y: 3000, size: 36.06, boost: { distance: 780, dx: 1, dy: 0, div: 9 } });
  sim.step();
  const b = sim.getCell(blob);
  assert.strictEqual(b.x, 5000 - 36.06 / 2);
  assert.strictEqual(b.bdx, -1);
});

test('decay: mass * (1 - 0.002) every 25 ticks, never below the L18 floor', () => {
  const sim = emptySim();
  const a = sim.addPlayer({});
  const id = sim.debugPlace({ kind: 'player', owner: a, x: 0, y: 0, size: 100 });
  const floor = sim.debugPlace({ kind: 'player', owner: a, x: 2000, y: 0, size: 31.65 });
  for (let i = 0; i < 24; i++) sim.step();
  assert.strictEqual(sim.getCell(id).size, 100);
  sim.step();
  assert.strictEqual(sim.getCell(id).size, Math.sqrt(100 * 100 * (1 - 0.002)));
  assert.strictEqual(sim.getCell(floor).size, Math.sqrt(10 * 100));
});

test('eject: blob of the L20 size from the edge, owner loses the L20 loss, 3-tick cooldown, blob is nobody\'s cell', () => {
  const { blobSize, lossSize } = FIXTURE.L20.value;   // MEASURED: 38 and 42.21
  const sim = emptySim();
  const a = sim.addPlayer({});
  const id = sim.debugPlace({ kind: 'player', owner: a, x: 0, y: 0, size: 100 });
  sim.setInput(a, { x: 0, y: 0, eject: true });
  const ev = sim.step();
  const blobs = ev.added.map((x) => sim.getCell(x)).filter((c) => c && c.kind === 'ejected');
  assert.strictEqual(blobs.length, 1);
  const blob = blobs[0];
  assert.strictEqual(blob.size, blobSize);
  assert.strictEqual(blob.owner, null);
  assert.strictEqual(blob.ejectedBy, a);
  assert.strictEqual(sim.getCell(id).size, Math.sqrt(100 * 100 - lossSize * lossSize));
  assert.ok(ev.newOwn.every(([, cid]) => cid !== blob.id));
  // Cooldown 3 ticks: ejects on the next two ticks are dropped, the third goes through.
  let made = 0;
  for (let i = 0; i < 3; i++) {
    sim.eject(a);
    made += sim.step().added.filter((x) => sim.getCell(x) && sim.getCell(x).kind === 'ejected').length;
  }
  assert.strictEqual(made, 1);
  // Below the eject minimum nothing leaves.
  const b = sim.addPlayer({});
  sim.debugPlace({ kind: 'player', owner: b, x: 3000, y: 3000, size: 56 });
  sim.eject(b);
  assert.strictEqual(sim.step().added.filter((x) => sim.getCell(x).kind === 'ejected').length, 0);
});

test('virus: fed by area it shoots a new virus on the 8th blob along the blob direction and resets', () => {
  const sim = emptySim();
  const v = sim.debugPlace({ kind: 'virus', x: 0, y: 0, size: 100 });
  for (let i = 1; i <= 8; i++) {
    sim.debugPlace({ kind: 'ejected', x: 0, y: 0, size: 36.06, boost: { distance: 0, dx: 0, dy: 1, div: 9 } });
    const before = sim.counts().ejected;
    const ev = sim.step();
    // U_EAT_REMOVE (measured): a virus feed is a plain removal, never an eat record.
    assert.deepStrictEqual(ev.eats, []);
    assert.strictEqual(before, 1);
    assert.strictEqual(sim.counts().ejected, 0, 'the blob was fed to the virus');
    assert.strictEqual(ev.removed.length, 1);
    const shots = ev.added.map((x) => sim.getCell(x)).filter((c) => c && c.kind === 'virus' && c.id !== v);
    if (i < 8) {
      assert.strictEqual(shots.length, 0, 'feed ' + i);
      assert.ok(sim.getCell(v).size < 141.421356237);
    } else {
      assert.strictEqual(shots.length, 1);
      assert.strictEqual(sim.getCell(v).size, 100);
      const s = shots[0];
      assert.strictEqual(s.size, 100);
      assert.strictEqual(s.bdx, 0);
      assert.strictEqual(s.bdy, 1);
      sim.step();
      assert.ok(s.y > 0 && s.x === 0);
    }
  }
});

test('virus pop: a size-200 cell eating a size-100 virus splits into 9 cells', () => {
  const sim = emptySim();
  const a = sim.addPlayer({});
  const cell = sim.debugPlace({ kind: 'player', owner: a, x: 0, y: 0, size: 200 });
  const v = sim.debugPlace({ kind: 'virus', x: 20, y: 0, size: 100 });
  const ev = sim.step();
  assert.deepStrictEqual(ev.eats, [[cell, v]]);
  assert.ok(ev.removed.includes(v));
  const cs = cellsOf(sim, a);
  assert.strictEqual(cs.length, 9);
  const total = cs.reduce((s, c) => s + massOf(c.size), 0);
  assert.ok(Math.abs(total - 500) < 1e-9);
  for (const c of cs.slice(1)) assert.ok(Math.abs(massOf(c.size) - 500 / 9) < 1e-9);
  // A size-114 cell cannot eat a virus (L30 1.15).
  const sim2 = emptySim();
  const b = sim2.addPlayer({});
  sim2.debugPlace({ kind: 'player', owner: b, x: 0, y: 0, size: 114 });
  sim2.debugPlace({ kind: 'virus', x: 0, y: 0, size: 100 });
  assert.deepStrictEqual(sim2.step().eats, []);
});

test('popPieces follows the two branches and never exceeds the free slots', () => {
  const p1 = popPieces(200, 15, 36);
  assert.strictEqual(p1.length, 8);
  for (const m of p1) assert.strictEqual(m, 200 / 9);
  const p2 = popPieces(1000, 15, 36);
  assert.strictEqual(p2.length, 15);
  for (const m of p2) assert.strictEqual(m, 500 / 14);
  const p3 = popPieces(2000, 15, 36);
  assert.strictEqual(p3.length, 15);
  assert.strictEqual(p3[0], 500);
  assert.strictEqual(p3[1], 250);
  for (const m of p3.slice(2)) assert.strictEqual(m, 250 / 12);
  assert.strictEqual(popPieces(20, 1, 36).length, 1);
  assert.deepStrictEqual(popPieces(500, 0, 36), []);
});

test('spawn, own announcement, death by being eaten, respawn, leave', () => {
  const sim = createSim({ laws: FIXTURE, seed: 3, border: BIG, food: false, viruses: false });
  const a = sim.addPlayer({ name: 'Ann' });
  sim.spawn(a);
  let ev = sim.step();
  assert.strictEqual(ev.spawned.length, 1);
  const [pid, id] = ev.spawned[0];
  assert.strictEqual(pid, a);
  assert.deepStrictEqual(ev.newOwn, [[a, id]]);
  const c = sim.getCell(id);
  assert.strictEqual(c.size, FIXTURE.L14.value);   // MEASURED start size 32
  assert.strictEqual(c.name, 'Ann');
  assert.strictEqual(c.owner, a);
  // Colour by the L36_RULE shape: one 255, one 7, the third 8 to 254.
  const rgb = c.rgb.slice().sort((x, y) => x - y);
  assert.ok(rgb[0] === 7 && rgb[2] === 255 && rgb[1] >= 8 && rgb[1] <= 254, JSON.stringify(c.rgb));
  // A big player eats it: death is reported once.
  const b = sim.addPlayer({ name: 'Big' });
  sim.debugPlace({ kind: 'player', owner: b, x: c.x, y: c.y, size: 300 });
  ev = sim.step();
  assert.deepStrictEqual(ev.died, [a]);
  assert.strictEqual(sim.playerInfo(a).alive, false);
  sim.spawn(a, 'Ann2');
  ev = sim.step();
  assert.strictEqual(ev.spawned.length, 1);
  assert.strictEqual(sim.getCell(ev.spawned[0][1]).name, 'Ann2');
  // Leave: all cells removed in the next tick, no eat records.
  const ids = sim.playerInfo(b).cells;
  sim.removePlayer(b);
  ev = sim.step();
  for (const x of ids) assert.ok(ev.removed.includes(x));
  assert.strictEqual(sim.playerInfo(b), null);
  assert.ok(ev.died.includes(b));
});

test('ids count up from L38 start and are never 0; food and viruses fill the shrunk map', () => {
  const sim = createSim({ laws: FIXTURE, seed: 5 });
  const ids = [];
  sim.forEachCell((c) => ids.push(c.id));
  assert.strictEqual(ids[0], 1);
  for (let i = 1; i < ids.length; i++) assert.strictEqual(ids[i], ids[i - 1] + 1);
  const n = sim.counts();
  // Empty room: side 4000 (n_eff 4), food floor(700 * 4 / 50) = 56, viruses floor(50 * 4 / 50) = 4.
  assert.strictEqual(sim.border().maxX - sim.border().minX, 4000.0000000000005);
  assert.strictEqual(n.food, 56);
  assert.strictEqual(n.viruses, 4);
  sim.forEachCell((c) => {
    if (c.kind === 'food') {
      assert.ok(c.size >= 10 && c.size < 20);
      const s = c.rgb.slice().sort((x, y) => x - y);
      assert.ok(s.includes(7) && s.includes(255));
    }
    if (c.kind === 'virus') assert.deepStrictEqual(c.rgb, [51, 255, 51]);
  });
});

test('map grows with the crowd, shrinks after the wait, and never removes a non-food cell', () => {
  const sim = createSim({ laws: FIXTURE, seed: 11 });
  const pids = [];
  for (let i = 0; i < 50; i++) {
    const p = sim.addPlayer({ name: 'p' + i, bot: i > 0 });
    sim.spawn(p);
    pids.push(p);
  }
  let changed = 0;
  for (let i = 0; i < 300; i++) if (sim.step().borderChanged) changed++;
  assert.ok(changed > 0);
  const full = sim.border();
  assert.strictEqual(full.maxX - full.minX, 14142.135623730952);
  assert.strictEqual(sim.counts().food, 700);
  for (const p of pids.slice(4)) sim.removePlayer(p);
  sim.step();
  const live = new Set();
  sim.forEachCell((c) => { if (c.kind !== 'food') live.add(c.id); });
  for (let i = 0; i < 25 * 200; i++) {
    const ev = sim.step();
    for (const id of ev.removed) assert.ok(!live.has(id) || ev.eats.some((e) => e[1] === id), 'removed by shrink: ' + id);
  }
  const b = sim.border();
  assert.strictEqual(b.maxX - b.minX, 4000.0000000000005);
  sim.forEachCell((c) => {
    assert.ok(c.x >= b.minX && c.x <= b.maxX && c.y >= b.minY && c.y <= b.maxY);
  });
});

// LAW CHECK 2026-10-02 (agario-reference/recordings/ours-vs-theirs.md): a fresh room grows from the MAP_N_MIN side to
// full in about 11 s while its bots spawn. Filling the full counts into the small map piled them in the middle: 98
// percent of the viruses (and 57 percent of the food) sat in the inner quarter of the map after 30 s, 84 percent of the
// viruses still after 30 minutes. Their FFA map is evenly covered (L26, L34 densities measured near Owen all over it).
test('a map that grows while it fills stays evenly covered: food and viruses are not piled in the middle', () => {
  for (const laws of [FIXTURE, LAWS]) {
    const sim = createSim({ laws, seed: 21 });
    for (let i = 0; i < laws.L39.value; i++) sim.spawn(sim.addPlayer({ name: 'p' + i, bot: i > 0 }));
    const growTicks = Math.ceil(((laws.L2.value / (laws.L2.value * laws.MAP_GROW_FRAC.value)) * 1000) / laws.L1.value) + 10;
    for (let i = 0; i < growTicks; i++) sim.step();
    const b = sim.border();
    assert.strictEqual(b.maxX - b.minX, laws.L2.value, 'the map reached full size');
    const q = (b.maxX - b.minX) / 4;
    const share = { food: [0, 0], virus: [0, 0] };
    sim.forEachCell((c) => {
      const k = c.kind === 'food' ? 'food' : c.kind === 'virus' ? 'virus' : null;
      if (!k) return;
      share[k][1]++;
      if (Math.abs(c.x) < q && Math.abs(c.y) < q) share[k][0]++;
    });
    // the inner quarter of the area holds a quarter of each (binomial, wide bounds)
    assert.strictEqual(share.food[1], laws.L34.value.amount);
    assert.strictEqual(share.virus[1], laws.L26.value.amount);
    assert.ok(share.food[0] / share.food[1] > 0.2 && share.food[0] / share.food[1] < 0.3, 'food inner share ' + share.food[0] / share.food[1]);
    // 3 standard deviations of a binomial quarter (before the fix: 98 percent; with the strip share dropped when it fell
    // due a tick early: 45 percent)
    assert.ok(Math.abs(share.virus[0] - 0.25 * share.virus[1]) <= 3 * Math.sqrt(0.1875 * share.virus[1]), 'viruses inner ' + share.virus[0] + ' of ' + share.virus[1]);
  }
});

// Scripted players for the long runs: targets, splits and ejects from a separate seeded generator.
function script(sim, seed, nPlayers) {
  const r = createRng(seed);
  const pids = [];
  for (let i = 0; i < nPlayers; i++) {
    const p = sim.addPlayer({ name: 'bot' + i, bot: i > 0 });
    sim.spawn(p);
    pids.push(p);
  }
  return function drive(t) {
    const b = sim.border();
    for (const p of pids) {
      const info = sim.playerInfo(p);
      if (!info.alive) { sim.spawn(p); continue; }
      if (t % 20 === 0) {
        sim.setInput(p, { x: b.minX + (b.maxX - b.minX) * r(), y: b.minY + (b.maxY - b.minY) * r() });
      }
      const roll = r();
      if (roll < 0.01) sim.split(p);
      else if (roll < 0.03) sim.eject(p);
    }
  };
}

test('no Math.random: 1000 ticks run clean with it replaced by a throwing function', () => {
  const saved = Math.random;
  Math.random = () => { throw new Error('Math.random used'); };
  try {
    const sim = createSim({ laws: FIXTURE, seed: 21 });
    const drive = script(sim, 4, 12);
    for (let t = 0; t < 1000; t++) {
      drive(t);
      sim.step();
    }
    assert.ok(sim.counts().cells > 0);
  } finally {
    Math.random = saved;
  }
});

test('determinism: two seed-7 sims with the same inputs give identical snapshots every 500 ticks to 5000', () => {
  const s1 = createSim({ laws: FIXTURE, seed: 7 });
  const s2 = createSim({ laws: FIXTURE, seed: 7 });
  const d1 = script(s1, 99, 10);
  const d2 = script(s2, 99, 10);
  let compared = 0;
  for (let t = 1; t <= 5000; t++) {
    d1(t);
    d2(t);
    s1.step();
    s2.step();
    if (t % 500 === 0) {
      assert.strictEqual(JSON.stringify(s1.snapshot()), JSON.stringify(s2.snapshot()), 'tick ' + t);
      compared++;
    }
  }
  assert.strictEqual(compared, 10);
  // A different seed gives a different world.
  const s3 = createSim({ laws: FIXTURE, seed: 8 });
  assert.notStrictEqual(JSON.stringify(s3.snapshot()), JSON.stringify(createSim({ laws: FIXTURE, seed: 7 }).snapshot()));
});

function invariantRun(laws, seed) {
  const sim = createSim({ laws, seed });
  const drive = script(sim, 77, 16);
  let eatsSeen = 0;
  let merges = 0;
  const seenIds = new Set();
  for (let t = 0; t < 3000; t++) {
    drive(t);
    // Half of every 20 ticks each player holds its mouse on its own cells (as a player waiting to merge does), so the
    // run reaches merges on any table: random far targets alone keep pieces in parallel flight, never pressed together.
    if (t % 20 >= 10) {
      sim.forEachPlayer((info) => {
        if (!info.cells.length) return;
        let x = 0, y = 0;
        for (const id of info.cells) { const c = sim.getCell(id); x += c.x; y += c.y; }
        sim.setInput(info.pid, { x: x / info.cells.length, y: y / info.cells.length });
      });
    }
    const ownerBefore = new Map();
    sim.forEachCell((c) => ownerBefore.set(c.id, c.owner));
    const ev = sim.step();
    const eatenNow = new Set();
    for (const [eater, eaten] of ev.eats) {
      assert.ok(ev.removed.includes(eaten));
      eatsSeen++;
      eatenNow.add(eaten);
      // A merge is never an eat record (U_EAT_REMOVE, measured): it is a plain removal.
      assert.ok(!(ownerBefore.get(eater) !== null && ownerBefore.get(eater) === ownerBefore.get(eaten)), 'merge listed');
    }
    // An own cell removed without an eat record is a merge (the script never leaves).
    for (const id of ev.removed) if (ownerBefore.get(id) && !eatenNow.has(id)) merges++;
    for (const id of ev.added) {
      assert.ok(!seenIds.has(id), 'id reused ' + id);
      seenIds.add(id);
    }
    const b = ev.border;
    sim.forEachCell((c) => {
      assert.ok(Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.size) && c.size > 0);
      if (c.kind === 'food') return;
      // The own-cell push runs after the border step (measured), so only a piece of a player with 2+ cells may end
      // a tick past its L3 box, and then by less than its own size (pressed pieces on their server: 7.9 units).
      const r = c.size / 2;
      const slack = c.kind === 'player' && sim.playerInfo(c.owner).cells.length > 1 ? c.size : 0;
      assert.ok(c.x >= b.minX + r - slack - 1e-9 && c.x <= b.maxX - r + slack + 1e-9, 'x out ' + c.kind + ' ' + c.x);
      assert.ok(c.y >= b.minY + r - slack - 1e-9 && c.y <= b.maxY - r + slack + 1e-9, 'y out ' + c.kind + ' ' + c.y);
      assert.notStrictEqual(c.id, 0);
    });
  }
  const l = sim.ledger();
  const destroyed = l.decay + l.eject + l.eat + l.virus + l.cap + l.left + l.trim;
  const live = sim.totalMass();
  assert.ok(Math.abs(live - (l.created - destroyed)) / live < 1e-9, live + ' vs ' + (l.created - destroyed));
  assert.ok(eatsSeen > 0);
  assert.ok(merges > 0, "the scripted run should include merges");
}

test('invariants over a 3000-tick scripted run: no NaN, inside the L3 box, mass ledger closes, eaten ids removed', () => {
  invariantRun(FIXTURE, 13);
});

test('the same invariants hold on the real (approved) table', () => {
  invariantRun(LAWS, 13);
});

test('forEachCellInRect returns exactly the cells whose box overlaps the rectangle', () => {
  const sim = createSim({ laws: FIXTURE, seed: 2 });
  const want = [];
  sim.forEachCell((c) => {
    if (c.x + c.size >= -500 && c.x - c.size <= 700 && c.y + c.size >= -300 && c.y - c.size <= 900) want.push(c.id);
  });
  const got = [];
  sim.forEachCellInRect(-500, -300, 700, 900, (c) => got.push(c.id));
  assert.deepStrictEqual(got.sort((a, b) => a - b), want.sort((a, b) => a - b));
});

// The grid keeps its bucket arrays between rebuilds (S2, speed only): after thousands of rebuilds with cells eaten,
// born, moved and split, a rectangle query still returns exactly the plain scan, each cell once.
test('forEachCellInRect stays exact over a long run (reused buckets, 2000 ticks, checked every 50)', () => {
  const sim = createSim({ laws: FIXTURE, seed: 5 });
  const drive = script(sim, 31, 12);
  const r = createRng(9);
  let checked = 0;
  for (let t = 1; t <= 2000; t++) {
    drive(t);
    sim.step();
    if (t % 50 !== 0) continue;
    const b = sim.border();
    for (let q = 0; q < 4; q++) {
      const x0 = b.minX + (b.maxX - b.minX) * r(), y0 = b.minY + (b.maxY - b.minY) * r();
      const x1 = x0 + 3000 * r(), y1 = y0 + 2000 * r();
      const want = [];
      sim.forEachCell((c) => {
        if (c.x + c.size >= x0 && c.x - c.size <= x1 && c.y + c.size >= y0 && c.y - c.size <= y1) want.push(c.id);
      });
      const got = [];
      sim.forEachCellInRect(x0, y0, x1, y1, (c) => got.push(c.id));
      assert.strictEqual(new Set(got).size, got.length, 'no cell twice');
      assert.deepStrictEqual(got.sort((a, c) => a - c), want.sort((a, c) => a - c), 'tick ' + t);
      checked++;
    }
  }
  assert.strictEqual(checked, 160);
});

test('the shipped sim holds no candidate number, no clock, no Math.random and no fixture import', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'ag', 'agSim.js'), 'utf8');
  const code = src.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  for (const bad of ['14142', '7071', '31.62', '780', '0.0122', '36.06', '42.43', '141.42', '1500', '22500', '0.002',
    '1.15', 'Math.random', 'Date', 'setTimeout', 'setInterval', 'agLawsFixture', 'performance.now']) {
    assert.ok(!code.includes(bad), 'agSim.js code contains ' + bad);
  }
  assert.ok(!/\b[DW] \d{3,}/.test(src), 'agSim.js cites D/W lines');
});

// ---------------------------------------------------------------------------------------------------------------
// The real table's rules (approved 2026-10-02, parity log final table), on LAWS itself.

test('L6 linearRamp: full L5 speed outside 0.651 sizes of the target, a straight line down to 0 inside', () => {
  const sim = emptySim(LAWS);
  const a = sim.addPlayer({});
  const id = sim.debugPlace({ kind: 'player', owner: a, x: 0, y: 0, size: 100 });
  const speed = 83.466 * Math.pow(100, -0.4468);
  assert.ok(Math.abs(speed - 10.67) < 0.01, 'parity log: 10.67 per update at size 100');
  sim.setInput(a, { x: 3000, y: 4000 });
  sim.step();
  const c = sim.getCell(id);
  assert.ok(Math.abs(Math.hypot(c.x, c.y) - speed) < 1e-9, 'full speed far from the target');
  // 30 units from the target, inside the 65.1-unit zone: speed x 30 / 65.1 (the min rule would step the full speed).
  const x0 = c.x;
  sim.setInput(a, { x: x0 + 30, y: c.y });
  sim.step();
  assert.ok(Math.abs((c.x - x0) - speed * 30 / (0.651 * 100)) < 1e-9, 'ramp step ' + (c.x - x0));
  // Just past the zone edge: full speed.
  const x1 = c.x;
  sim.setInput(a, { x: x1 + 65.2, y: c.y });
  sim.step();
  assert.ok(Math.abs((c.x - x1) - speed) < 1e-9);
  // Held still on a point inside the zone the cell closes in and never overshoots (speed / zone < 1 from size 32 up).
  const goal = c.x + 20;
  sim.setInput(a, { x: goal, y: c.y });
  for (let i = 0; i < 300; i++) { sim.step(); assert.ok(c.x <= goal); }
  assert.ok(goal - c.x < 1e-6);
  assert.ok(83.466 * Math.pow(32, -0.4468) / (0.651 * 32) < 1);
});

test('L29 equalPieces: equal pieces up to the free slots, each at least mass 20', () => {
  const near = (arr, m, n) => arr.length === n && arr.every((x) => Math.abs(x - m) < 1e-12);
  assert.ok(near(equalPopPieces(325, 15, 20), 325 / 16, 15), 'their pop: mass 325, 15 free, 16 pieces of 20.3');
  assert.ok(near(equalPopPieces(100, 15, 20), 20, 4), 'mass 100 makes 5 pieces of 20');
  assert.ok(near(equalPopPieces(325, 3, 20), 81.25, 3), 'only 3 free slots: 4 pieces');
  assert.deepStrictEqual(equalPopPieces(39.9, 15, 20), [], 'too small for two pieces of 20');
  assert.deepStrictEqual(equalPopPieces(325, 0, 20), []);

  // In the sim on the real table: a size-150 cell (mass 225) eats a size-100 virus (mass 100), 15 free slots.
  const sim = emptySim(LAWS);
  const a = sim.addPlayer({});
  const cell = sim.debugPlace({ kind: 'player', owner: a, x: 0, y: 0, size: 150 });
  const v = sim.debugPlace({ kind: 'virus', x: 10, y: 0, size: 100 });
  const ev = sim.step();
  assert.deepStrictEqual(ev.eats, [[cell, v]], 'eating a virus is an eat record');
  const cs = cellsOf(sim, a);
  assert.strictEqual(cs.length, 16);
  for (const c of cs) assert.ok(Math.abs(massOf(c.size) - 325 / 16) < 1e-9, 'piece mass ' + massOf(c.size));
  // A cell with 13 other own cells pops into its 2 free slots only.
  const sim2 = emptySim(LAWS);
  const b = sim2.addPlayer({});
  const eater = sim2.debugPlace({ kind: 'player', owner: b, x: 0, y: 0, size: 150 });
  for (let i = 0; i < 13; i++) sim2.debugPlace({ kind: 'player', owner: b, x: 2000 + 200 * i, y: 3000, size: 40 });
  sim2.debugPlace({ kind: 'virus', x: 10, y: 0, size: 100 });
  sim2.step();
  assert.strictEqual(sim2.playerInfo(b).cells.length, 16);
  assert.ok(Math.abs(massOf(sim2.getCell(eater).size) - 325 / 3) < 1e-9);
});

test('L32 whileUneaten: food is born at 10 and grows 1 size at a time with the L32_GROW chance, never past 16', () => {
  const sim = createSim({ laws: LAWS, seed: 5, border: BIG, viruses: false });
  const size = new Map();
  sim.forEachCell((c) => { assert.strictEqual(c.size, 10); size.set(c.id, c.size); });
  assert.strictEqual(size.size, LAWS.L34.value.amount);
  let steps = 0;
  let exposure = 0;
  for (let t = 0; t < 2000; t++) {
    for (const s of size.values()) if (s < 16) exposure++;
    const ev = sim.step();
    for (const id of ev.added) {
      const c = sim.getCell(id);
      // (the first step also lists the first world's food, which may have grown on that step already)
      if (c && c.kind === 'food' && !size.has(id)) { assert.strictEqual(c.size, 10, 'born at 10'); size.set(id, 10); }
    }
    sim.forEachCell((c) => {
      if (c.kind !== 'food') return;
      const was = size.get(c.id);
      if (c.size !== was) {
        assert.strictEqual(c.size, was + 1, 'one size per step');
        steps++;
        size.set(c.id, c.size);
      }
      assert.ok(c.size <= 16);
    });
  }
  const chance = steps / exposure;
  assert.ok(Math.abs(chance - 5.38e-4) < 0.1 * 5.38e-4, 'grow chance per tick ' + chance);
  const l = sim.ledger();
  const live = sim.totalMass();
  const destroyed = l.decay + l.eject + l.eat + l.virus + l.cap + l.left + l.trim;
  assert.ok(Math.abs(live - (l.created - destroyed)) / live < 1e-9, 'growth is counted as created mass');
  // A food that is eaten stops growing: nothing grows that is not in the world.
  const one = createSim({ laws: LAWS, seed: 6, border: BIG, food: false, viruses: false });
  const pid = one.addPlayer({});
  one.debugPlace({ kind: 'player', owner: pid, x: 0, y: 0, size: 40 });
  one.debugPlace({ kind: 'food', x: 5, y: 0, size: 10 });
  assert.strictEqual(one.step().eats.length, 1);
  for (let t = 0; t < 5000; t++) one.step();
  assert.strictEqual(one.counts().food, 0);
  assert.ok(Math.abs(one.totalMass() - massOf(one.getCell(one.playerInfo(pid).cells[0]).size)) < 1e-9);
});

test('L33 food colours on the real table: one channel 255, one 7, the third 8 to 254', () => {
  const sim = createSim({ laws: LAWS, seed: 9, border: BIG, viruses: false });
  let n = 0;
  let lo = 255;
  let hi = 0;
  sim.forEachCell((c) => {
    const s = c.rgb.slice().sort((x, y) => x - y);
    assert.strictEqual(s[2], 255);
    assert.strictEqual(s[0], 7);
    lo = Math.min(lo, s[1]);
    hi = Math.max(hi, s[1]);
    n++;
  });
  assert.ok(n > 2000 && lo >= 8 && hi <= 254 && lo < 20 && hi > 240, lo + ' to ' + hi);
});

test('the own-cell push runs after the border step: a pressed piece ends the tick past its L3 box', () => {
  const sim = emptySim(LAWS);
  const a = sim.addPlayer({});
  // Two size-100 pieces, 13+ ticks old, not yet allowed to merge, overlapping by 100 against the right wall
  // (L3 box edge 5000 - 50 = 4950). No target, so only the border step and the push move them.
  const p = sim.debugPlace({ kind: 'player', owner: a, x: 4950, y: 0, size: 100, born: -20 });
  const q = sim.debugPlace({ kind: 'player', owner: a, x: 4850, y: 0, size: 100, born: -20 });
  sim.step();
  assert.strictEqual(sim.getCell(p).x, 5000, 'pushed 50 past its box (a push before the border would leave 4950)');
  assert.strictEqual(sim.getCell(q).x, 4800);
  // The next border step brings it back inside, then the push moves it out again by what still overlaps.
  sim.step();
  assert.strictEqual(sim.getCell(p).x, 4975);
  assert.strictEqual(sim.getCell(q).x, 4775);
});

test('L11 on the real table: a Space split piece is firstStep (98.42) ahead after its first tick, the rest follows the decay', () => {
  const { velocity, decayDiv, firstStep } = LAWS.L11.value;
  assert.strictEqual(firstStep, 98.42);
  assert.strictEqual(LAWS.L11.status, 'MEASURED');
  const q = 1 - 1 / decayDiv;
  for (const size of [67, 77, 166]) {   // recorded single splits at parent sizes 67 and 77 (FFA) and 166 (other type)
    const sim = createSim({ laws: LAWS, seed: 1, border: BIG, food: false, viruses: false });
    const a = sim.addPlayer({});
    const parent = sim.debugPlace({ kind: 'player', owner: a, x: 0, y: 0, size, born: -10000 });
    sim.setInput(a, { x: 4000, y: 0, split: true });   // the mouse far ahead, as on the recorded splits
    sim.step();
    const cs = cellsOf(sim, a);
    assert.strictEqual(cs.length, 2);
    const child = cs.find((c) => c.id !== parent);
    const p = sim.getCell(parent);
    // first update: the piece is firstStep ahead of its parent (both took the same normal step)
    assert.ok(Math.abs(child.x - p.x - firstStep) < 1e-9, 'size ' + size + ': first step ' + (child.x - p.x));
    assert.ok(Math.abs(child.y) < 1e-9 && Math.abs(p.y) < 1e-9);
    // later updates: the boost left after the first step, 1/decayDiv of it each tick
    let sep = child.x - p.x;
    for (let j = 1; j <= 5; j++) {
      sim.setInput(a, { x: 4000 + 20 * j, y: 0 });
      sim.step();
      const now = sim.getCell(child.id).x - sim.getCell(parent).x;
      const want = (velocity / decayDiv) * Math.pow(q, j);
      assert.ok(Math.abs(now - sep - want) < 1e-6, 'size ' + size + ' step ' + j + ': ' + (now - sep) + ' vs ' + want);
      sep = now;
    }
  }
  // The whole reach: firstStep plus the boost left after the first step (756.6, against 733.5 approved).
  const sim = createSim({ laws: LAWS, seed: 1, border: BIG, food: false, viruses: false });
  const a = sim.addPlayer({});
  const parent = sim.debugPlace({ kind: 'player', owner: a, x: -4000, y: 0, size: 100, born: -10000 });
  sim.split(a);   // no target: neither piece takes a normal step, only the boost moves the piece
  sim.step();
  const child = cellsOf(sim, a).find((c) => c.id !== parent);
  for (let t = 0; t < 400; t++) sim.step();
  const reach = sim.getCell(child.id).x - sim.getCell(parent).x;
  assert.ok(Math.abs(reach - (firstStep + velocity * q)) < 0.01, 'reach ' + reach);
  assert.ok(Math.abs(reach - 756.6) < 0.1, 'reach ' + reach);
});

test('L11 first step is for Space splits only: pop pieces start at the eater centre; tables without it start there too', () => {
  const { velocity, decayDiv } = LAWS.L11.value;
  // Without firstStep (the approved shape before Owen chose the recordings): the piece is velocity / decayDiv ahead.
  const plain = withValues(LAWS, { L11: { velocity, sizeExp: 0, decayDiv } });
  const sim = createSim({ laws: plain, seed: 1, border: BIG, food: false, viruses: false });
  const a = sim.addPlayer({});
  const parent = sim.debugPlace({ kind: 'player', owner: a, x: 0, y: 0, size: 100, born: -10000 });
  sim.split(a);
  sim.step();
  const child = cellsOf(sim, a).find((c) => c.id !== parent);
  assert.ok(Math.abs(child.x - sim.getCell(parent).x - velocity / decayDiv) < 1e-9);
  assert.throws(() => createSim({ laws: withValues(LAWS, { L11: Object.assign({}, LAWS.L11.value, { firstStep: 0 }) }),
    seed: 1 }), /L11 firstStep/);
  assert.throws(() => createSim({ laws: withValues(LAWS, { L11: Object.assign({}, LAWS.L11.value, { firstStep: 'x' }) }),
    seed: 1 }), /L11 firstStep/);
  // A pop on the real table: the pieces begin at the eater's centre (the pop comes after this tick's movement) and
  // their next update is one boost step out, never the Space split's firstStep.
  const pop = createSim({ laws: LAWS, seed: 3, border: BIG, food: false, viruses: false });
  const b = pop.addPlayer({});
  const eater = pop.debugPlace({ kind: 'player', owner: b, x: 0, y: 0, size: 200, born: -10000 });
  pop.debugPlace({ kind: 'virus', x: 0, y: 0, size: 100 });
  const ev = pop.step();
  const pieces = ev.added.map((x) => pop.getCell(x)).filter((c) => c && c.kind === 'player' && c.id !== eater);
  assert.ok(pieces.length > 1, 'the virus popped');
  for (const c of pieces) assert.ok(Math.hypot(c.x, c.y) < 1e-9, 'pop piece at the centre');
  pop.step();
  for (const c of pieces) {
    const d = Math.hypot(pop.getCell(c.id).x - pop.getCell(eater).x, pop.getCell(c.id).y - pop.getCell(eater).y);
    assert.ok(Math.abs(d - velocity / decayDiv) < 1e-6, 'pop piece ' + d);
  }
});

test('L21 start on the real table: the blob begins (size after the loss - blob size) toward the mouse and a big cell never eats its own blob', () => {
  const { blobSize, lossSize } = LAWS.L20.value;
  const { velocity, decayDiv } = LAWS.L21.value;
  assert.strictEqual(LAWS.L21.value.start, 'blobFarEdgeOnCellEdge');
  for (const size of [61, 80, 100, 150, 300, 600]) {
    const sim = createSim({ laws: withValues(LAWS, { L21: Object.assign({}, LAWS.L21.value, { spreadRad: 0 }) }), seed: 1,
      border: BIG, food: false, viruses: false });
    const a = sim.addPlayer({});
    const id = sim.debugPlace({ kind: 'player', owner: a, x: 0, y: 0, size, born: -10000 });
    // the mouse close ahead, so the cell barely moves toward its blob
    sim.setInput(a, { x: 8, y: 0 });
    sim.eject(a);
    const ev = sim.step();
    const blobs = ev.added.map((x) => sim.getCell(x)).filter((c) => c && c.kind === 'ejected');
    assert.strictEqual(blobs.length, 1, 'size ' + size + ': the blob survives its eject tick');
    const after = Math.sqrt(size * size - lossSize * lossSize);
    assert.ok(Math.abs(sim.getCell(id).size - after) < 1e-9);
    // first sighting = start + one boost step (velocity / decayDiv) along the mouse line
    assert.ok(Math.abs(blobs[0].x - (after - blobSize + velocity / decayDiv)) < 1e-9, 'size ' + size + ': x ' + blobs[0].x);
    assert.ok(Math.abs(blobs[0].y) < 1e-9);
    for (let t = 0; t < 40; t++) sim.step();
    assert.strictEqual(sim.counts().ejected, 1, 'size ' + size + ': the blob is still there 40 ticks later');
  }
});
