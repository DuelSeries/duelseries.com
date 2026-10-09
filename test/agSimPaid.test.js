'use strict';
// agSim's paid option and still set (PAID-AGAR-DESIGN.md 3.3, checklist step 4; Owen's hold-Q cash-out 2026-10-08):
// money facts in sim order and only for eats of another player's cell, facts that survive a throwing step, the shield,
// the still freeze (split and eject refused), findSpawnPoint, spawn(at), clearCells, takeMoneyEvents, and the free sim
// unchanged by any of it.
const test = require('node:test');
const assert = require('node:assert');
const { createSim } = require('../server/ag/agSim');
const { createRng } = require('../server/ag/agRng');
const { FIXTURE } = require('./agLawsFixture');

const BIG = { minX: -5000, minY: -5000, maxX: 5000, maxY: 5000 };

function paidSim(extra) {
  const paid = { shielded: new Set(), still: new Set() };
  const sim = createSim(Object.assign({ laws: FIXTURE, seed: 1, border: BIG, food: false, viruses: false, paid }, extra));
  return { sim, paid };
}

function cellsOf(sim, pid) {
  return sim.playerInfo(pid).cells.map((id) => sim.getCell(id));
}

// Scripted players (agSim.test.js's script): targets, splits and ejects from their own seeded generator.
function script(sim, seed, n) {
  const r = createRng(seed);
  const pids = [];
  for (let i = 0; i < n; i++) {
    const p = sim.addPlayer({ name: 'p' + i, bot: false });
    sim.spawn(p);
    pids.push(p);
  }
  return function drive(t) {
    const b = sim.border();
    for (const p of pids) {
      const info = sim.playerInfo(p);
      if (!info.alive) { sim.spawn(p); continue; }
      if (t % 20 === 0) sim.setInput(p, { x: b.minX + (b.maxX - b.minX) * r(), y: b.minY + (b.maxY - b.minY) * r() });
      const roll = r();
      if (roll < 0.01) sim.split(p);
      else if (roll < 0.03) sim.eject(p);
    }
  };
}

test('the free sim is unchanged: an empty still set and no option give identical events and state over 2000 ticks', () => {
  const a = createSim({ laws: FIXTURE, seed: 11 });
  const b = createSim({ laws: FIXTURE, seed: 11, still: new Set() });
  const da = script(a, 5, 12);
  const db = script(b, 5, 12);
  for (let t = 0; t < 2000; t++) {
    da(t);
    db(t);
    const ea = a.step();
    const eb = b.step();
    assert.deepStrictEqual(eb, ea, 'tick ' + t);
    assert.strictEqual('money' in ea, false, 'a free step reports no money facts');
    if (t % 250 === 0) assert.strictEqual(JSON.stringify(b.snapshot()), JSON.stringify(a.snapshot()));
  }
  assert.strictEqual(JSON.stringify(b.snapshot()), JSON.stringify(a.snapshot()));
});

test('free-only calls refuse in a free sim: findSpawnPoint and spawn(at) are paid only', () => {
  const sim = createSim({ laws: FIXTURE, seed: 1, border: BIG, food: false, viruses: false });
  const p = sim.addPlayer({ name: 'x' });
  assert.throws(() => sim.findSpawnPoint(32, 500, 4), /paid rooms only/);
  assert.throws(() => sim.spawn(p, 'x', { x: 0, y: 0 }), /paid rooms only/);
  assert.deepStrictEqual(sim.takeMoneyEvents(), { money: [], feeds: [] });
  assert.throws(() => createSim({ laws: FIXTURE, seed: 1, paid: { shielded: [], still: new Set() } }), /paid must be/);
  assert.throws(() => createSim({ laws: FIXTURE, seed: 1, still: [] }), /still must be a Set/);
});

test('money facts come in sim order: a chained eat of two cells of one victim, the second one last', () => {
  const { sim } = paidSim();
  const A = sim.addPlayer({ name: 'A' });
  const B = sim.addPlayer({ name: 'B' });
  sim.debugPlace({ kind: 'player', owner: A, x: 0, y: 0, size: 300 });
  sim.debugPlace({ kind: 'player', owner: B, x: 30, y: 0, size: 40 });
  sim.debugPlace({ kind: 'player', owner: B, x: -30, y: 0, size: 50 });
  const ev = sim.step();
  assert.deepStrictEqual(ev.money, [
    { eater: A, victim: B, eatenSq: 1600, victimSq: 1600 + 2500, last: false },
    { eater: A, victim: B, eatenSq: 2500, victimSq: 2500, last: true },
  ]);
  assert.deepStrictEqual(ev.feeds, []);
  assert.strictEqual(sim.playerInfo(B).cells.length, 0);
});

test('merges, food, viruses, decay, the cap and a self-feed produce no fact; another player\'s blob is a feed', () => {
  const { sim } = paidSim();
  const A = sim.addPlayer({ name: 'A' });
  const B = sim.addPlayer({ name: 'B' });
  // two old cells of A pressed together merge; food, a virus and A's own blob are eaten
  sim.debugPlace({ kind: 'player', owner: A, x: 0, y: 0, size: 200, born: -100000 });
  sim.debugPlace({ kind: 'player', owner: A, x: 5, y: 0, size: 60, born: -100000 });
  sim.debugPlace({ kind: 'food', x: 10, y: 10, size: 10 });
  sim.debugPlace({ kind: 'virus', x: -20, y: 0, size: 100 });
  sim.debugPlace({ kind: 'ejected', x: 0, y: 20, size: 38, ejectedBy: A });
  // B's blob eaten by A: a feed
  sim.debugPlace({ kind: 'ejected', x: 0, y: -20, size: 38, ejectedBy: B });
  sim.debugPlace({ kind: 'player', owner: B, x: 3000, y: 3000, size: 40 });
  let feeds = [];
  for (let t = 0; t < 60; t++) {
    const ev = sim.step();
    assert.deepStrictEqual(ev.money, [], 'tick ' + t + ': no money fact');
    feeds = feeds.concat(ev.feeds);
  }
  assert.deepStrictEqual(feeds, [{ feeder: B, eater: A, blobSq: 38 * 38 }]);
});

test('a step that throws after the eats keeps its facts for the next completed step', () => {
  // A dynamic-border sim reads L2 in its map step, after the eats: a law table that throws there once makes exactly
  // that step throw after eats() has run.
  let boom = false;
  const laws = new Proxy(FIXTURE, {
    get(t, k) {
      if (k === 'L2' && boom) {
        boom = false;
        throw new Error('injected map-step failure');
      }
      return t[k];
    },
  });
  const paid = { shielded: new Set(), still: new Set() };
  const sim = createSim({ laws, seed: 3, paid, food: false, viruses: false });
  const A = sim.addPlayer({ name: 'A' });
  const B = sim.addPlayer({ name: 'B' });
  const C = sim.addPlayer({ name: 'C' });
  sim.debugPlace({ kind: 'player', owner: A, x: 0, y: 0, size: 300 });
  sim.debugPlace({ kind: 'player', owner: B, x: 20, y: 0, size: 40 });
  sim.debugPlace({ kind: 'player', owner: C, x: 1000, y: 1000, size: 40 });
  boom = true;
  assert.throws(() => sim.step(), /injected/);
  assert.strictEqual(sim.playerInfo(B).cells.length, 0, 'the eat happened in the throwing step');
  // the next step completes and returns the earlier fact first, then its own
  sim.debugPlace({ kind: 'player', owner: C, x: 0, y: 0, size: 20 });
  const ev = sim.step();
  assert.deepStrictEqual(ev.money.map((f) => [f.victim, f.last]), [[B, true], [C, false]]);
});

test('takeMoneyEvents hands over the facts no completed step returned, once', () => {
  let boom = false;
  const laws = new Proxy(FIXTURE, { get(t, k) { if (k === 'L2' && boom) throw new Error('stuck'); return t[k]; } });
  const sim = createSim({ laws, seed: 4, paid: { shielded: new Set(), still: new Set() }, food: false, viruses: false });
  const A = sim.addPlayer({ name: 'A' });
  const B = sim.addPlayer({ name: 'B' });
  sim.debugPlace({ kind: 'player', owner: A, x: 0, y: 0, size: 300 });
  sim.debugPlace({ kind: 'player', owner: B, x: 10, y: 0, size: 40 });
  boom = true;
  assert.throws(() => sim.step());
  const got = sim.takeMoneyEvents();
  assert.deepStrictEqual(got.money, [{ eater: A, victim: B, eatenSq: 1600, victimSq: 1600, last: true }]);
  assert.deepStrictEqual(sim.takeMoneyEvents().money, [], 'cleared: nothing is applied twice');
});

test('a shielded player eats nothing and nothing eats its cells', () => {
  const { sim, paid } = paidSim();
  const A = sim.addPlayer({ name: 'A' });
  const S = sim.addPlayer({ name: 'S' });
  sim.debugPlace({ kind: 'player', owner: A, x: 0, y: 0, size: 400 });
  sim.debugPlace({ kind: 'player', owner: S, x: 10, y: 0, size: 32 });
  sim.debugPlace({ kind: 'food', x: 3000, y: 3000, size: 10 });
  sim.debugPlace({ kind: 'player', owner: S, x: 3000, y: 3000, size: 200 });
  paid.shielded.add(S);
  for (let t = 0; t < 30; t++) {
    const ev = sim.step();
    assert.deepStrictEqual(ev.money, []);
  }
  assert.strictEqual(sim.playerInfo(S).cells.length, 2, 'the shielded cell was never eaten');
  let food = 0;
  sim.forEachCell((c) => { if (c.kind === 'food') food++; });
  assert.strictEqual(food, 1, 'the shielded player ate nothing, not even food');
  paid.shielded.delete(S);
  const ev = sim.step();
  assert.ok(ev.money.some((f) => f.victim === S), 'unshielded, it can be eaten');
});

test('still: a held player\'s cells are not steered, its split and eject are refused; boosted pieces finish', () => {
  const { sim, paid } = paidSim();
  const P = sim.addPlayer({ name: 'P' });
  sim.debugPlace({ kind: 'player', owner: P, x: 0, y: 0, size: 150 });
  sim.setInput(P, { x: 4000, y: 0 });
  sim.step();
  const x1 = cellsOf(sim, P)[0].x;
  assert.ok(x1 > 0, 'it moves toward the target');
  paid.still.add(P);
  sim.split(P);
  sim.eject(P);
  const before = sim.counts();
  for (let t = 0; t < 10; t++) sim.step();
  assert.strictEqual(cellsOf(sim, P)[0].x, x1, 'held: not one unit of steering');
  assert.strictEqual(sim.counts().playerCells, before.playerCells, 'split refused');
  assert.strictEqual(sim.counts().ejected, before.ejected, 'eject refused');
  // a piece already flying from a split finishes its boost while held (design 3.3.4)
  paid.still.delete(P);
  sim.split(P);
  sim.step();
  paid.still.add(P);
  const flying = cellsOf(sim, P).find((c) => c.boost > 0);
  assert.ok(flying, 'a piece with boost left');
  const fx = flying.x;
  sim.step();
  assert.notStrictEqual(flying.x, fx, 'the boosted piece keeps flying');
  paid.still.delete(P);
  const cx = cellsOf(sim, P)[0].x;
  sim.step();
  assert.notStrictEqual(cellsOf(sim, P)[0].x, cx, 'released: it steers again');
});

test('still in a free sim (the free hold-Q) freezes steering the same way', () => {
  const still = new Set();
  const sim = createSim({ laws: FIXTURE, seed: 2, border: BIG, food: false, viruses: false, still });
  const P = sim.addPlayer({ name: 'P' });
  sim.debugPlace({ kind: 'player', owner: P, x: 0, y: 0, size: 100 });
  sim.setInput(P, { x: 0, y: 4000 });
  still.add(P);
  for (let t = 0; t < 5; t++) sim.step();
  assert.strictEqual(cellsOf(sim, P)[0].y, 0);
  still.delete(P);
  sim.step();
  assert.ok(cellsOf(sim, P)[0].y > 0);
});

test('clearCells removes the cells at the next step and keeps the player (it can spawn again)', () => {
  const sim = createSim({ laws: FIXTURE, seed: 2, border: BIG, food: false, viruses: false });
  const P = sim.addPlayer({ name: 'P' });
  sim.spawn(P);
  sim.step();
  assert.strictEqual(sim.playerInfo(P).cells.length, 1);
  assert.ok(sim.clearCells(P));
  const ev = sim.step();
  assert.strictEqual(sim.playerInfo(P).cells.length, 0);
  assert.ok(ev.died.includes(P), 'reported like any player whose cells are gone');
  assert.ok(sim.hasPlayer(P), 'the player stays');
  sim.spawn(P);
  sim.step();
  assert.strictEqual(sim.playerInfo(P).cells.length, 1, 'and plays again');
});

test('findSpawnPoint: null on a map ruled by a size-1500 cell, a clear point otherwise; spawn(at) starts there', () => {
  const small = { minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 };
  const { sim } = paidSim({ border: small });
  const big = sim.addPlayer({ name: 'big' });
  sim.debugPlace({ kind: 'player', owner: big, x: 0, y: 0, size: 1500 });
  assert.strictEqual(sim.findSpawnPoint(32, 500, 64), null, 'nowhere is clear of the giant');
  const { sim: s2 } = paidSim();
  const g = s2.addPlayer({ name: 'g' });
  s2.debugPlace({ kind: 'player', owner: g, x: 0, y: 0, size: 1500 });
  const pt = s2.findSpawnPoint(32, 500, 64);
  assert.ok(pt, 'a clear point on a big map');
  assert.ok(Math.hypot(pt.x, pt.y) >= 1500 + 32 + 500, 'clear of the giant by its size + 32 + 500');
  // a cell that cannot eat the newcomer (below eatRatio x 32) does not block
  const { sim: s3 } = paidSim({ border: small });
  const tiny = s3.addPlayer({ name: 't' });
  s3.debugPlace({ kind: 'player', owner: tiny, x: 0, y: 0, size: 37 });
  assert.ok(s3.findSpawnPoint(32, 500, 64), 'a 37 cannot eat a 32 (1.17 x 32 = 37.44)');
  const me = s2.addPlayer({ name: 'me' });
  s2.spawn(me, 'me', pt);
  s2.step();
  const c = cellsOf(s2, me)[0];
  assert.deepStrictEqual([c.x, c.y, c.size], [pt.x, pt.y, 32]);
  assert.throws(() => s2.spawn(me, 'me', { x: NaN, y: 0 }), /finite/);
});

test('the paid facts never reach a view: a paid step carries only the extra money and feeds lists', () => {
  const { sim } = paidSim();
  const A = sim.addPlayer({ name: 'A' });
  sim.spawn(A);
  const ev = sim.step();
  const free = createSim({ laws: FIXTURE, seed: 1, border: BIG, food: false, viruses: false });
  const keys = Object.keys(free.step()).sort();
  assert.deepStrictEqual(Object.keys(ev).filter((k) => k !== 'money' && k !== 'feeds').sort(), keys);
});
