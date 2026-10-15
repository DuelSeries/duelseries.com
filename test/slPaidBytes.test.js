'use strict';
// The gold rule's byte ranges (PAID-SL-DESIGN.md 5 and 9, 11.1 slPaidBytes; task T2): in a paid room a food is cash
// iff its rad byte is at least C_PAID_CASH_BYTE (68). That holds only while the three sources never meet:
//   natural food   L27: base + floor(span x u), u in [0, 1)                     15 to 47
//   boost drops    L24.size of an L23 charge c in [lo(sct), hi(sct)), every sct  up to 54
//   death drops    L39.rad of the victim's sct, every reachable sct              68 to 81
// swept here from the law formulas at every sct and every charge edge, and seen in real sims (a filled world, a long
// snake boosting down to its minimum, deaths at many lengths). The client draws a food of byte b at rad b / 5, so its
// gold test is sz >= 13.6 (the vm check through the frozen slApply is task T6's).
const test = require('node:test');
const assert = require('node:assert/strict');

const { createSim, deathRadByte } = require('../server/sl/slSim');
const slSnake = require('../server/sl/slSnake');
const { FIXTURE } = require('./slLawsFixture');

const CASH = FIXTURE.C_PAID_CASH_BYTE.value;
const CAP = FIXTURE.L3.value; // 430 body points; the last grow can add one more
const C = FIXTURE.L1.value;

function natRange() {
  const n = FIXTURE.L27.value;
  return [n.base, n.base + Math.ceil(n.span) - 1];
}

function boostRange(K) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let sct = K.minSct; sct <= CAP + 1; sct++) {
    const a = slSnake.chargeLo(K, sct);
    const b = slSnake.chargeHi(K, sct);
    assert.ok(a > 0 && b >= a, 'charge edges at sct ' + sct);
    // every charge the 'charge' stream can draw: c = a + (b - a) u, u in [0, 1); the byte only rises with c
    for (let i = 0; i <= 64; i++) {
      const c = a + (b - a) * (i < 64 ? i / 64 : 1 - Number.EPSILON);
      const byte = slSnake.dropByte(K, c);
      lo = Math.min(lo, byte);
      hi = Math.max(hi, byte);
    }
    hi = Math.max(hi, slSnake.dropByte(K, b)); // the edge itself, which no draw reaches
  }
  return [lo, hi];
}

function deathRange(W, minSct) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let sct = minSct; sct <= CAP + 1; sct++) {
    const b = deathRadByte(W, sct);
    lo = Math.min(lo, b);
    hi = Math.max(hi, b);
  }
  return [lo, hi];
}

test('the three byte ranges from the law formulas, at every sct and every charge: disjoint at the cash byte', () => {
  const sim = createSim(FIXTURE, { seed: 1 });
  const nat = natRange();
  const boost = boostRange(sim.K);
  const death = deathRange(sim.W, sim.K.minSct);
  assert.deepEqual(nat, [15, 47]);
  assert.equal(boost[1], 54);
  assert.deepEqual(death, [68, 81]);
  assert.ok(nat[1] < CASH, 'natural food stays below the cash byte');
  assert.ok(boost[1] < CASH, 'boost drops stay below the cash byte');
  assert.equal(death[0], CASH, 'every death drop is cash-sized, the smallest exactly at it');
  assert.equal(CASH / 5, 13.6, 'the client gold test is sz >= 13.6');
});

test('a filled world and its passes: every natural food below the cash byte', () => {
  const sim = createSim(FIXTURE, { seed: 4, world: true });
  let n = 0;
  let max = 0;
  const look = () => sim.food.forEachFood((f) => {
    if (!f.nat) return;
    n++;
    max = Math.max(max, f.b);
  });
  look();
  for (let t = 0; t < 600; t++) {
    sim.applyInputs();
    sim.step();
    for (const f of sim.food.tick.adds) if (f.nat) max = Math.max(max, f.b);
  }
  look();
  assert.ok(n > 1500, 'natural foods seen ' + n);
  assert.ok(max >= 45 && max < CASH, 'largest natural byte ' + max);
});

test('snakes boosting at every fifth length up to 430 points: every boost drop below the cash byte', () => {
  const sim = createSim(FIXTURE, { seed: 8, border: true, food: true, fill: false });
  let drops = 0;
  let max = 0;
  const lengths = new Set();
  for (let sct = sim.K.minSct; sct <= CAP; sct += sct < 30 ? 1 : 5) {
    // heading for the centre from 1500 out, boosting for 40 steps (well short of the border on the far side)
    const s = sim.spawn({ x: C - 1500, y: C, ang: 0, cv: sct % 9, sct });
    sim.setInput(s.id, { type: 'boost', on: true }, 0);
    for (let t = 0; t < 40; t++) {
      sim.applyInputs();
      const log = sim.step();
      assert.equal(log.deaths.length, 0);
      for (const d of log.drops) {
        drops++;
        max = Math.max(max, d.b);
        lengths.add(s.pts.length);
        assert.ok(d.b < CASH, 'boost drop byte ' + d.b + ' at sct ' + s.pts.length);
        assert.ok(!d.food || d.food.b === d.b);
      }
    }
    sim.remove(s.id);
  }
  assert.ok(drops > 500 && lengths.size > 90, drops + ' drops at ' + lengths.size + ' lengths');
  assert.ok(max >= 50, 'largest boost byte ' + max);
});

test('deaths in a paid sim at many lengths: every drop at or above the cash byte, by L39.rad', () => {
  for (const sct of [2, 50, 89, 90, 128, 151, 200, 252, 300, 430]) {
    const sim = createSim(FIXTURE, { seed: 10 + sct, border: true, food: true, fill: false,
      paidDrops: { border: true, inset: FIXTURE.C_PAID_DROP_INSET.value } });
    const s = sim.spawn({ x: C - 300, y: C + 100, ang: 0.2, cv: 9, sct });
    sim.kill(s.id);
    sim.applyInputs();
    const d = sim.step().deaths[0];
    assert.equal(d.drops.length, 2 * sct + 1);
    for (const q of d.drops) {
      assert.equal(q.b, deathRadByte(sim.W, sct));
      assert.ok(q.b >= CASH && q.food.b === q.b, 'death drop byte ' + q.b + ' at sct ' + sct);
    }
  }
});
