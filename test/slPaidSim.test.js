'use strict';
// The paid sim option (PAID-SL-DESIGN.md 4, 11.1 slPaidSim; task T2): opts.paidDrops { border, inset } and lastLog().
//   - Absent, the sim is the free sim to the last bit: a border-heavy script (3 seeds x 5000 steps) gives the digests
//     the unchanged slSim.js gave at 10c8ac4 (pinned below), so the free room and its goldens cannot move.
//   - Present: every death drops 2 sct + 1, border deaths included (C_PAID_BORDER_DROPS); every drop lies inside
//     flux - C_PAID_DROP_INSET and every food under one cell diagonal past it (slSim paidPlace); the death stream is
//     drawn exactly as in the free room.
//   - lastLog() is the step's own log, also after a step that threw half way; digest() never reads it.
//   - Reachability (task T2 step 4): the largest sc a snake reaches (430 points, L3), and a pellet at the inset, plus
//     the placement slack the checker allows, is eaten head on and along the border by a spawn-size and a cap-size
//     snake that then turns back without a border death. At inset 40 the cap-size snake died after 16 of 360 head-on
//     approaches, so the row is 60 (slLaws.js C_PAID_DROP_INSET).
const test = require('node:test');
const assert = require('node:assert/strict');

const { createSim, deathRadByte } = require('../server/sl/slSim');
const { createRng } = require('../server/sl/slRng');
const slSnake = require('../server/sl/slSnake');
const { checkLaws } = require('../server/slPaid/slCheck');
const { FIXTURE } = require('./slLawsFixture');

const PI2 = 2 * Math.PI;
const C = FIXTURE.L1.value; // grd, the map centre
const FLUX0 = 2923; // C_R_MIN: the border radius at 22 snakes or fewer, where a paid room's border stays (design 1)
const INSET = FIXTURE.C_PAID_DROP_INSET.value;
const PAID = Object.freeze({ border: true, inset: INSET });
const CELL = FIXTURE['L2.size'].value / 256; // one food cell (slGrid)
const DIAG = CELL * Math.SQRT2;
const SLACK = checkLaws(FIXTURE).slack; // what the checker's I7 allows past flux - inset (two cell diagonals)

function byteOf(a) {
  const w = ((a % PI2) + PI2) % PI2;
  return Math.round(w / PI2 * 251) % 251;
}

function dist(x, y) {
  return Math.hypot(x - C, y - C);
}

// ------------------------------------------------------------------ the script

// 14 slots on the L42 rings, every fourth a long snake (sct 60 + 25 k); per live snake per tick: slots 0, 3, 6, 9, 12
// dive at the border 30 percent of ticks (an angle byte about straight out), the others steer at random (10 percent),
// boost on or off (3 percent), or disconnect (sim.kill, 0.06 percent); a dead slot respawns with chance 4 percent.
// The digest every 1000 ticks; onTick(sim, log) sees every step.
const SLOTS = 14;
function drive(seed, ticks, extra, onTick) {
  const sim = createSim(FIXTURE, Object.assign({ seed, world: true }, extra));
  const r = createRng((seed * 2246822519) >>> 0);
  const long = (k) => (k % 4 === 0 ? 60 + 25 * k : undefined);
  const slots = [];
  for (let k = 0; k < SLOTS; k++) slots.push(sim.spawn({ cv: (k * 5) % 66, sct: long(k) }).id);
  const digests = [];
  const causes = { snake: 0, border: 0, kill: 0 };
  for (let t = 1; t <= ticks; t++) {
    for (let k = 0; k < SLOTS; k++) {
      const id = slots[k];
      const s = sim.snake(id);
      if (!s) {
        if (r.next() < 0.04) slots[k] = sim.spawn({ cv: r.int(66), sct: long(k) }).id;
        continue;
      }
      const u = r.next();
      if (k % 3 === 0 && u < 0.3) {
        sim.setInput(id, { type: 'angle', q: byteOf(Math.atan2(slSnake.headY(s) - C, slSnake.headX(s) - C) + (r.next() - 0.5)) }, r.int(43));
      } else if (u < 0.1) sim.setInput(id, { type: 'angle', q: r.int(251) }, r.int(43));
      else if (u < 0.13) sim.setInput(id, { type: 'boost', on: r.next() < 0.5 }, r.int(43));
      else if (u < 0.1306) sim.kill(id);
    }
    sim.applyInputs();
    const log = sim.step();
    for (const d of log.deaths) causes[d.cause]++;
    if (onTick) onTick(sim, log);
    if (t % 1000 === 0) digests.push(sim.digest());
  }
  return { sim, digests, causes };
}

// The free sim's digests for this script, cut from slSim.js at 10c8ac4 (before the paid option existed).
const FREE = {
  11: ['451e8bdb', '77e36daa', '50f9603a', 'e85ce620', '54526dbd'],
  12: ['3b4fc3d5', '0053e9c4', '1c7395f6', '12973298', '24756d64'],
  13: ['0140da57', '8e5f8603', '6e41a137', '572da21f', '40aa59d9'],
};

// ------------------------------------------------------------------ the option

test('paidDrops: the shape it takes; it needs the border', () => {
  const make = (pd, o) => createSim(FIXTURE, Object.assign({ seed: 1, border: true, paidDrops: pd }, o));
  for (const pd of [undefined, null]) assert.ok(make(pd));
  assert.ok(make({ border: true, inset: 60 }));
  assert.ok(make({ border: false, inset: 0 }));
  for (const bad of [true, 1, 'x', [], { inset: 60 }, { border: 'yes', inset: 60 }, { border: true },
    { border: true, inset: -1 }, { border: true, inset: NaN }, { border: true, inset: Infinity }, { border: true, inset: '60' }]) {
    assert.throws(() => make(bad), /paidDrops/, JSON.stringify(bad));
  }
  assert.throws(() => createSim(FIXTURE, { seed: 1, paidDrops: PAID }), /paidDrops needs the border/);
  assert.equal(INSET, 60);
});

test('option absent: the free sim to the last bit, 3 seeds x 5000 steps of a border-heavy script', () => {
  for (const seed of [11, 12, 13]) {
    const a = drive(seed, 5000);
    assert.deepEqual(a.digests, FREE[seed], 'seed ' + seed);
    assert.ok(a.causes.border > 100 && a.causes.snake > 50 && a.causes.kill > 5, JSON.stringify(a.causes));
    assert.deepEqual(drive(seed, 1000, { paidDrops: null }).digests, FREE[seed].slice(0, 1), 'null is absent');
  }
});

test('option present: every death drops 2 sct + 1 inside flux - inset, border deaths too; foods under a cell diagonal past it', () => {
  for (const seed of [11, 12, 13]) {
    let drops = 0;
    let borderDrops = 0;
    let pulled = 0;
    let worstFood = -Infinity;
    const p = drive(seed, 5000, { paidDrops: PAID }, (sim, log) => {
      assert.equal(sim.flux(), FLUX0, 'the border stays at its 22-snake floor');
      const lim = sim.flux() - INSET;
      for (const d of log.deaths) {
        assert.equal(d.drops.length, 2 * d.sct + 1, d.cause + ' death of sct ' + d.sct);
        if (d.cause === 'border') borderDrops += d.drops.length;
        for (const q of d.drops) {
          drops++;
          assert.equal(q.b, deathRadByte(sim.W, d.sct));
          const r = dist(q.x, q.y);
          assert.ok(r <= lim + 1e-9, 'drop at ' + r + ' past ' + lim);
          if (r > lim - 1e-6) pulled++;
          assert.ok(q.food, 'every drop is a food');
          const rf = dist(q.food.x, q.food.y) - lim;
          if (rf > worstFood) worstFood = rf;
          assert.ok(rf < DIAG, 'food ' + q.food.id + ' lies ' + rf + ' past flux - inset');
        }
      }
      if (log.tick % 1000 === 0) assert.deepEqual(sim.check(), [], 'tick ' + log.tick);
    });
    assert.ok(p.causes.border > 100, JSON.stringify(p.causes));
    assert.ok(borderDrops > 20000 && pulled > 5000, 'border drops ' + borderDrops + ', pulled ' + pulled);
    assert.ok(worstFood > 0 && worstFood < DIAG && DIAG < SLACK, 'worst food ' + worstFood);
    assert.notDeepEqual(p.digests, FREE[seed], 'the option changes the world');
    assert.ok(drops > 40000);
  }
});

test('a border death drops 2 sct + 1 cash-sized foods inside flux - inset; the free room drops none', () => {
  for (const sct of [2, 50, 300]) {
    const run = (extra) => {
      const sim = createSim(FIXTURE, Object.assign({ seed: 3, border: true, food: true, fill: false }, extra));
      const sc = slSnake.speedSc(sim.K, sct);
      const travel = (5.39 + 0.4 * sc) * (42.67 / 8) / 4;
      const s = sim.spawn({ x: C + FLUX0 - 14.5 * sc - travel + 0.01, y: C, ang: 0, cv: 3, sct });
      sim.applyInputs();
      return { sim, s, log: sim.step() };
    };
    const free = run({});
    assert.equal(free.log.deaths.length, 1);
    assert.equal(free.log.deaths[0].cause, 'border');
    assert.equal(free.log.deaths[0].drops.length, 0, 'L39.count border 0 in the free room');
    const paid = run({ paidDrops: PAID });
    assert.equal(paid.log.deaths.length, 1);
    const d = paid.log.deaths[0];
    assert.equal(d.cause, 'border');
    assert.equal(d.killer, 0);
    assert.equal(d.drops.length, 2 * sct + 1);
    const lim = FLUX0 - INSET;
    let pulled = 0;
    for (const q of d.drops) {
      assert.equal(q.b, deathRadByte(paid.sim.W, sct));
      assert.ok(q.b >= FIXTURE.C_PAID_CASH_BYTE.value, 'every death drop is cash-sized');
      assert.equal(q.cv, 3);
      assert.ok(dist(q.x, q.y) <= lim + 1e-9);
      if (Math.abs(dist(q.x, q.y) - lim) < 1e-6) pulled++;
      assert.ok(q.food && !q.food.nat && q.food.b === q.b);
      assert.ok(dist(q.food.x, q.food.y) < lim + DIAG);
    }
    assert.ok(pulled > 0, 'the head end lay past the circle and was pulled onto it');
    assert.equal(paid.sim.food.stats().dropped, 2 * sct + 1);
    assert.deepEqual(paid.sim.check(), []);
  }
});

test('the death stream is drawn as in the free room: same draws, same places inside, same colours', () => {
  const death = (extra, x, y, ang, sct) => {
    const sim = createSim(FIXTURE, Object.assign({ seed: 21, border: true, food: true, fill: false }, extra));
    const s = sim.spawn({ x, y, ang, cv: 9, sct }); // skin 9: weighted colours, one more draw per drop
    sim.kill(s.id);
    sim.applyInputs();
    const d = sim.step().deaths[0];
    return { sim, d, state: sim.wrng.death.state() };
  };
  // deep inside: identical to the bit, foods included
  let f = death({}, C - 500, C + 200, 0.4, 40);
  let p = death({ paidDrops: PAID }, C - 500, C + 200, 0.4, 40);
  assert.equal(p.state, f.state);
  assert.equal(p.d.drops.length, 81);
  for (let i = 0; i < 81; i++) {
    const a = f.d.drops[i];
    const b = p.d.drops[i];
    assert.deepEqual([b.x, b.y, b.b, b.cv, b.food.id], [a.x, a.y, a.b, a.cv, a.food.id], 'drop ' + i);
  }
  assert.equal(p.sim.digest(), f.sim.digest());
  // at the border: the head end is pulled in, the draws and colours are the same, the deep drops lie where they did
  f = death({}, C + FLUX0 - 30, C - 600, Math.PI / 2, 40);
  p = death({ paidDrops: PAID }, C + FLUX0 - 30, C - 600, Math.PI / 2, 40);
  assert.equal(p.state, f.state);
  let moved = 0;
  for (let i = 0; i < 81; i++) {
    const a = f.d.drops[i];
    const b = p.d.drops[i];
    assert.equal(b.cv, a.cv);
    if (dist(a.x, a.y) <= FLUX0 - INSET - 30) assert.deepEqual([b.x, b.y], [a.x, a.y], 'drop ' + i);
    else if (b.x !== a.x || b.y !== a.y) moved++;
  }
  assert.ok(moved > 20, 'moved ' + moved);
});

// ------------------------------------------------------------------ lastLog, digest

test('lastLog is the step log, also after a step that threw half way', () => {
  const sim = createSim(FIXTURE, { seed: 5, world: true, paidDrops: PAID });
  const a = sim.spawn({ x: C - 400, y: C, ang: 0, cv: 1, sct: 30 });
  sim.spawn({ x: C + 400, y: C + 300, ang: 2, cv: 2, sct: 30 });
  sim.applyInputs();
  const log = sim.step();
  assert.equal(sim.lastLog(), log);
  // a throw after the deaths (step 7, the food pass): the kill and its drops are in the log
  sim.kill(a.id);
  const pass = sim.food.step;
  sim.food.step = () => {
    throw new Error('injected');
  };
  sim.applyInputs();
  assert.throws(() => sim.step(), /injected/);
  sim.food.step = pass;
  const after = sim.lastLog();
  assert.equal(after, log, 'the same object');
  assert.equal(after.tick, 2);
  assert.equal(after.deaths.length, 1);
  assert.equal(after.deaths[0].id, a.id);
  assert.equal(after.deaths[0].cause, 'kill');
  assert.equal(after.deaths[0].drops.length, 61);
  assert.equal(sim.snake(a.id), null);
  // a throw inside Phase A (a boost drop): the kill of that step and its drops are logged, the updates stop short
  const b = sim.spawn({ x: C, y: C - 800, ang: 1, cv: 4, sct: 80 });
  sim.setInput(b.id, { type: 'boost', on: true }, 0);
  const drop = sim.food.drop;
  sim.food.drop = (...args) => {
    if (args[2] < FIXTURE.C_PAID_CASH_BYTE.value) throw new Error('injected boost');
    return drop(...args);
  };
  let threw = false;
  let victim = null;
  for (let t = 0; t < 40 && !threw; t++) {
    victim = sim.spawn({ x: C + 900, y: C - 800 + 30 * t, ang: 1, cv: 4, sct: 20 });
    sim.kill(victim.id); // dies at the start of the next step, before Phase A
    sim.applyInputs();
    try {
      sim.step();
    } catch (e) {
      assert.match(e.message, /injected boost/);
      threw = true;
    }
  }
  sim.food.drop = drop;
  assert.ok(threw, 'the boosting snake dropped');
  const half = sim.lastLog();
  assert.equal(half.deaths.length, 1);
  assert.equal(half.deaths[0].id, victim.id);
  assert.equal(half.deaths[0].cause, 'kill');
  assert.equal(half.deaths[0].drops.length, 41);
  assert.ok(half.deaths[0].drops.every((q) => q.food && sim.food.get(q.food.id) === q.food));
  assert.ok(half.updates.length < sim.count(), 'Phase A stopped at the throw');
});

test('digest() reads the sim only: the log can change and the digest does not', () => {
  const make = () => {
    const sim = createSim(FIXTURE, { seed: 9, world: true, paidDrops: PAID });
    for (let k = 0; k < 6; k++) sim.spawn({ cv: k });
    return sim;
  };
  const x = make();
  const y = make();
  for (let t = 0; t < 200; t++) {
    x.applyInputs();
    x.step();
    y.applyInputs();
    y.step();
    if (t % 7 === 0) {
      const before = y.digest();
      const log = y.lastLog();
      log.deaths.push({ id: 999, cause: 'border', drops: [{ x: 1, y: 2 }] });
      log.updates.length = 0;
      log.tick = -1;
      assert.equal(y.digest(), before);
    }
    assert.equal(y.digest(), x.digest(), 'tick ' + t);
  }
});

// ------------------------------------------------------------------ reachability

// One snake drives at a pellet lying `past` beyond flux - inset on the +x axis: head on from `start` units back at
// `off` radians off the radius, then, the step it eats it, steers for the centre. Returns the eat step (-1: never),
// how far inside the border its L35 test point was then, and the closest pass after it (negative: a border death).
function headOn(sct, past, start, off, inset = INSET) {
  const sim = createSim(FIXTURE, { seed: 5, border: true, food: true, fill: false, paidDrops: { border: true, inset } });
  const flux = sim.flux();
  const R = flux - inset + past;
  const pellet = sim.food.drop(C + R, C, FIXTURE.C_PAID_CASH_BYTE.value, 0);
  const s = sim.spawn({ x: C + R - start * Math.cos(off), y: C - start * Math.sin(off), ang: off, cv: 1, sct });
  let eaten = -1;
  let atEat = 0;
  let closest = Infinity;
  for (let t = 0; t < 900; t++) {
    const want = eaten < 0 ? off : Math.atan2(C - slSnake.headY(s), C - slSnake.headX(s));
    sim.setInput(s.id, { type: 'angle', q: byteOf(want) }, 0);
    sim.applyInputs();
    const log = sim.step();
    if (log.deaths.length) return { eaten, atEat, closest: -1 };
    const gap = flux - dist(slSnake.headX(s) + 14.5 * s.sc * Math.cos(s.ang), slSnake.headY(s) + 14.5 * s.sc * Math.sin(s.ang));
    for (const e of sim.food.tick.eats) {
      if (e.food === pellet) {
        eaten = t;
        atEat = gap;
      }
    }
    if (eaten >= 0) {
      if (gap < closest) closest = gap;
      if (t > eaten + 400) break;
    } else if (t > 300) {
      break;
    }
  }
  return { eaten, atEat, closest };
}

// Along the border: the snake follows the circle the pellet lies on (aiming 80 units ahead on it) from 600 units
// before it.
function along(sct, past) {
  const sim = createSim(FIXTURE, { seed: 5, border: true, food: true, fill: false, paidDrops: PAID });
  const flux = sim.flux();
  const R = flux - INSET + past;
  const pellet = sim.food.drop(C + R, C, FIXTURE.C_PAID_CASH_BYTE.value, 0);
  const phi0 = -600 / R;
  const s = sim.spawn({ x: C + R * Math.cos(phi0), y: C + R * Math.sin(phi0), ang: phi0 + Math.PI / 2, cv: 1, sct });
  let eaten = -1;
  let closest = Infinity;
  for (let t = 0; t < 400; t++) {
    const hx = slSnake.headX(s);
    const hy = slSnake.headY(s);
    const a = Math.atan2(hy - C, hx - C) + 80 / R;
    sim.setInput(s.id, { type: 'angle', q: byteOf(Math.atan2(C + R * Math.sin(a) - hy, C + R * Math.cos(a) - hx)) }, 0);
    sim.applyInputs();
    if (sim.step().deaths.length) return { eaten, closest: -1 };
    closest = Math.min(closest, flux - dist(slSnake.headX(s) + 14.5 * s.sc * Math.cos(s.ang), slSnake.headY(s) + 14.5 * s.sc * Math.sin(s.ang)));
    for (const e of sim.food.tick.eats) if (e.food === pellet) eaten = t;
    if (eaten >= 0 && t > eaten + 50) break;
  }
  return { eaten, closest };
}

test('reachability: the largest sc is at the 430 cap, and a pellet at the inset is eaten head on and along the border without a border death', () => {
  const sim = createSim(FIXTURE, { seed: 1 });
  const K = sim.K;
  const cap = FIXTURE.L3.value; // mscps: body points never pass it
  assert.equal(cap, 430);
  const scCap = slSnake.speedSc(K, cap);
  assert.ok(Math.abs(scCap - (1 + 428 / 106)) < 1e-12, 'sc ' + scCap);
  for (let n = 2; n < cap; n++) assert.ok(slSnake.speedSc(K, n) < scCap);
  const spawnSct = FIXTURE.L20.value.sct;
  for (const sct of [spawnSct, cap]) {
    for (const past of [0, SLACK]) {
      let runs = 0;
      for (let deg = 0; deg <= 80; deg += 20) {
        for (let start = 400; start < 440; start += 8) {
          const r = headOn(sct, past, start, deg * Math.PI / 180);
          runs++;
          const what = 'sct ' + sct + ' past ' + past.toFixed(2) + ' at ' + deg + ' deg from ' + start;
          assert.ok(r.eaten >= 0, what + ': eaten');
          // measured: at least 66 units inside at the eat (spawn size, 80 degrees off), 14.8 after it (cap size head on)
          assert.ok(r.atEat > 50, what + ': test point ' + r.atEat + ' inside at the eat');
          assert.ok(r.closest > 10, what + ': closest pass after it ' + r.closest);
        }
      }
      assert.equal(runs, 25);
      const a = along(sct, past);
      assert.ok(a.eaten >= 0, 'along the border, sct ' + sct);
      assert.ok(a.closest > 30, 'along the border, sct ' + sct + ': closest ' + a.closest);
    }
  }
});

test('why the inset is 60, not the design\'s 40: at 40 a cap-size snake that eats head on cannot always turn back', () => {
  let died = 0;
  for (let start = 400; start < 420; start++) if (headOn(430, 0, start, 0, 40).closest < 0) died++;
  assert.ok(died > 0, 'at inset 40 the cap-size snake survives every head-on approach');
  for (let start = 400; start < 420; start++) assert.ok(headOn(430, 0, start, 0).closest > 10, 'from ' + start);
});
