'use strict';
// slSim world half (task T6; SERVER-BUILD-BRIEF section 8, SERVER-DESIGN 6.3 and 18.1). FIXTURE table only. Every
// expected number is a LITERAL from the SERVER-LAWS row of its id (or computed in this file from that row's formula
// with its literal constants), never read back from the code under test:
//   L31 eat disc k0 5.98, k1 2.26, r0 17.8, r1 17.96, halfway lean     L35 f1 = a = 14.5, capsule body
//   L36 the bigger by L = sct + fam lives, equal L a seeded coin        L37 own body safe
//   L38 f1 14.5, m 0                                                    L39 2 per point + 1, Appendix 2 bytes,
//   L40 kill credit                                                         disc 20 + 15 (sc - 1), skin colours
//   L42 r = (0.011 k - 0.002) flux, k 3 to 76, clear 400                L49 no protection
//   sc = min(6, 1 + (sct - 2) / 106); speed 5.39 + 0.4 sc; travel sp x (42.67 / 8) / 4 per update; border 2923 at
//   22 snakes or fewer (C_R_MIN, BUILD-DECISIONS T7).

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSim, deathRadByte, pointSegDist2, segSegDist2, WORLD_ROWS, WORLD_LAW_IDS } = require('../server/sl/slSim');
const { streamSeed, createRng } = require('../server/sl/slRng');
const { FIXTURE, makeFixture } = require('./slLawsFixture');

const PI2 = 2 * Math.PI;
const C = 32550; // L1 grd
const P = 42.67; // L7
const F1 = 14.5; // L35 f1
const A = 14.5; // L35 a
const FLUX0 = 2923; // C_R_MIN: the border radius at 22 snakes or fewer
const K18 = 1.2681186e-4; // L18 K per rad byte^2

function sc(sct) {
  return Math.min(6, 1 + (sct - 2) / 106);
}
function speed(sct) {
  return 5.39 + 0.4 * sc(sct);
}
function travel(sct) {
  return speed(sct) * (P / 8) / 4;
}
function near(a, b, tol, what) {
  assert.ok(Math.abs(a - b) <= tol, (what || 'value') + ': ' + a + ' is not within ' + tol + ' of ' + b);
}
function tickWith(sim) {
  sim.applyInputs();
  return sim.step();
}
function headOf(s) {
  return [s.cx, s.cy];
}

// ------------------------------------------------------------------ gate

test('slSim world: the rows it reads, the forms it builds, the options it needs', () => {
  for (const id of WORLD_LAW_IDS) {
    if (id === 'C_SPAWN_TRIES') continue;
    assert.ok(Object.prototype.hasOwnProperty.call(FIXTURE, id), id);
  }
  assert.equal(WORLD_ROWS.C_SPAWN_TRIES.status, 'CHOSEN');
  assert.equal(WORLD_ROWS.C_SPAWN_TRIES.value, 64);
  const v = (id) => FIXTURE[id].value;
  const refuse = (patch, re) => assert.throws(() => createSim(makeFixture(patch), { seed: 1 }), re);
  refuse({ L35: Object.assign({}, v('L35'), { body: 'points' }) }, /L35/);
  refuse({ L36: Object.assign({}, v('L36'), { tie: 'joinOrder' }) }, /L36/);
  refuse({ L36: { rule: 'deeperDies' } }, /L36/);
  refuse({ L31: Object.assign({}, v('L31'), { lean: 'ang' }) }, /L31/);
  refuse({ 'L39.place': Object.assign({}, v('L39.place'), { perPoint: 3 }) }, /L39.place/);
  refuse({ 'L39.count': Object.assign({}, v('L39.count'), { border: 1 }) }, /L39.count/);
  refuse({ 'L42.k': { min: 3, max: 76, weight: 'area' } }, /L42.k/);
  refuse({ L38: Object.assign({}, v('L38'), { margin: 0 }) }, /L38/);
  assert.throws(() => createSim(FIXTURE, { seed: 1, food: true }), /border/);
  assert.throws(() => createSim(FIXTURE, { seed: 1, prey: true }), /border/);
  assert.throws(() => createSim(FIXTURE, { seed: 1 }).spawn({ cv: 0 }), /border/);
  assert.throws(() => createSim(FIXTURE, { seed: 1 }).spawn({ x: C, cv: 0 }), /both/);
  const w = createSim(FIXTURE, { seed: 1, world: true });
  assert.ok(w.border && w.food && w.preys);
  assert.equal(w.flux(), FLUX0);
  assert.ok(w.food.stats().filled > 0, 'the initial L26 fill ran');
  assert.equal(createSim(FIXTURE, { seed: 1, world: true, prey: false }).preys, null);
  assert.equal(createSim(FIXTURE, { seed: 1, world: true, fill: false }).food.stats().filled, 0);
  assert.equal(createSim(FIXTURE, { seed: 1 }).flux(), null);
});

test('slSim world: segment distances (closed-form vectors)', () => {
  assert.equal(pointSegDist2(0, 5, -1, 0, 1, 0), 25);
  assert.equal(pointSegDist2(4, 3, -1, 0, 1, 0), 18); // past the end: to (1, 0)
  assert.equal(pointSegDist2(2, 2, 2, 2, 2, 2), 0);
  assert.equal(segSegDist2(-1, 1, 1, -1, -1, -1, 1, 1), 0); // crossing
  assert.equal(segSegDist2(0, 3, 10, 3, 0, 0, 10, 0), 9); // parallel
  assert.equal(segSegDist2(0, 0, 0, 0, 3, 4, 3, 4), 25); // two points
  assert.equal(segSegDist2(5, 1, 5, 9, 0, 0, 3, 0), 5); // (5, 1) to (3, 0): 4 + 1
  near(segSegDist2(-9.33, 12, 9.33, 12, 0, 0, 0, -42), 144, 1e-12, 'the swept pass over a tail cap');
});

// ------------------------------------------------------------------ L35 form B, L40, L49

// A wall snake W heading +y (ang pi / 2): its body runs along x = xw from y = top - (sct - 1) 42 to top.
function wallAndVictim(vSct, eps, wSct) {
  const sim = createSim(FIXTURE, { seed: 11 });
  const xw = C + 1000;
  const w = sim.spawn({ x: xw, y: C + 800, ang: Math.PI / 2, cv: 2, sct: wSct });
  const thr = F1 * sc(vSct) + A * sc(wSct); // test point ahead by f1 sc_v, touching within a sc_w
  const v = sim.spawn({ x: xw - thr - travel(vSct) - eps, y: C, ang: 0, cv: 3, sct: vSct });
  return { sim, w, v };
}

test('slSim L35: a head running into a body dies when the test point (f1 sc_victim ahead) is within a sc_other', () => {
  for (const [vSct, wSct] of [[2, 40], [108, 40], [2, 300]]) {
    // eps < 0: after one update the gap is under the threshold: dies on its first update (L49: no protection)
    let r = wallAndVictim(vSct, -0.01, wSct);
    let log = tickWith(r.sim);
    assert.equal(log.deaths.length, 1, 'sct ' + vSct + ' into sct ' + wSct);
    const d = log.deaths[0];
    assert.equal(d.id, r.v.id);
    assert.equal(d.cause, 'snake');
    assert.equal(d.killer, r.w.id);
    assert.equal(d.headOn, false);
    assert.equal(r.sim.snake(r.v.id), null);
    assert.equal(r.w.kills, 1, 'L40: the killer is credited');
    assert.equal(d.drops.length, 2 * vSct + 1);
    // eps > 0: one update leaves it 0.01 short; the next update kills it
    r = wallAndVictim(vSct, 0.01, wSct);
    assert.equal(tickWith(r.sim).deaths.length, 0, 'sct ' + vSct + ' survives at threshold + 0.01');
    assert.equal(tickWith(r.sim).deaths.length, 1);
    assert.equal(r.sim.check().length, 0);
  }
});

test('slSim L35: beside a body the threshold is a sc_other only (the test point is ahead, not around the head)', () => {
  // W heads +x along y = C (sct 60, sc 1.5471698); V runs beside it, lateral gap g, its test point over W's body.
  const aW = A * sc(60); // 22.434
  near(aW, 22.43396226, 1e-8, 'a sc_o at sct 60');
  for (const vSct of [2, 108]) {
    for (const [g, dies] of [[22, true], [23, false]]) {
      const sim = createSim(FIXTURE, { seed: 5 });
      const w = sim.spawn({ x: C + 500, y: C, ang: 0, cv: 1, sct: 60 });
      const v = sim.spawn({ x: C - 1000, y: C + g, ang: 0, cv: 4, sct: vSct });
      let died = null;
      for (let t = 0; t < 100 && !died; t++) {
        const log = tickWith(sim);
        if (log.deaths.length) died = log.deaths[0];
      }
      if (dies) {
        assert.ok(died, 'gap ' + g + ' sct ' + vSct + ' dies');
        assert.equal(died.id, v.id);
        assert.equal(died.killer, w.id);
      } else {
        assert.equal(died, null, 'gap ' + g + ' sct ' + vSct + ' lives (R (sc_v + sc_o) would kill it)');
      }
    }
  }
});

test('slSim L35: a boosting test point that steps over the round end of a body is caught by the swept test', () => {
  // the swept test exists because one update at nsp3 moves 14 x 42.67 / 32 = 18.67 > a at sc 1 (14.5)
  assert.ok(14 * P / 32 > A);
  const run = (tail) => {
    const sim = createSim(FIXTURE, { seed: 21 });
    const v = sim.spawn({ x: C - 3000, y: C, ang: 0, cv: 3, sct: 30 });
    sim.setInput(v.id, { type: 'boost', on: true }, 43);
    const xs = [v.tpx];
    for (let t = 0; t < 24; t++) {
      tickWith(sim);
      xs.push(v.tpx);
    }
    if (tail === null) return { xs };
    // the next sample, from a dry run of the same seed: V's motion does not depend on T
    const X = (xs[24] + tail.next) / 2;
    const t = sim.spawn({ x: X, y: C - tail.h - 42, ang: 3 * Math.PI / 2, cv: 5 }); // tail at (X, C - h)
    const log = tickWith(sim);
    return { xs, log, v, t, X };
  };
  const dry = run(null);
  const dryNext = (() => {
    const sim = createSim(FIXTURE, { seed: 21 });
    const v = sim.spawn({ x: C - 3000, y: C, ang: 0, cv: 3, sct: 30 });
    sim.setInput(v.id, { type: 'boost', on: true }, 43);
    for (let t = 0; t < 25; t++) tickWith(sim);
    return v.tpx;
  })();
  const step = dryNext - dry.xs[24];
  assert.ok(step > 18 && step < 18.7, 'at the boost plateau: ' + step);
  // both samples are farther than a from the tail point at h 12: sqrt((step / 2)^2 + 144) > 14.5
  assert.ok(Math.hypot(step / 2, 12) > A);
  const hit = run({ next: dryNext, h: 12 });
  assert.equal(hit.log.deaths.length, 1);
  assert.equal(hit.log.deaths[0].id, hit.v.id);
  assert.equal(hit.log.deaths[0].killer, hit.t.id);
  const miss = run({ next: dryNext, h: 15 });
  assert.equal(miss.log.deaths.length, 0, 'h 15 > a: the segment passes clear');
});

test('slSim L35: every test reads the bodies of the same instant (a body whose snake dies this update still kills)', () => {
  // Y runs into the wall Z and dies on update 1; X runs into Y's body on the same update. Whatever the seeded order,
  // both die (a sequential sweep that removed Y first would let X live in about half the seeds).
  const thrY = F1 * sc(30) + A * sc(40);
  const thrX = F1 * sc(2) + A * sc(30);
  for (let seed = 1; seed <= 60; seed++) {
    const sim = createSim(FIXTURE, { seed });
    const xz = C + 1000;
    const z = sim.spawn({ x: xz, y: C + 800, ang: Math.PI / 2, cv: 2, sct: 40 });
    const y = sim.spawn({ x: xz - thrY - travel(30) + 0.01, y: C, ang: 0, cv: 3, sct: 30 });
    // X heads +y toward Y's body 300 units behind Y's head
    const x = sim.spawn({ x: xz - 300, y: C - thrX - travel(2) + 0.01, ang: Math.PI / 2, cv: 4 });
    const log = tickWith(sim);
    const by = new Map(log.deaths.map((d) => [d.id, d]));
    assert.equal(log.deaths.length, 2, 'seed ' + seed);
    assert.equal(by.get(y.id).killer, z.id);
    assert.equal(by.get(x.id).killer, y.id);
    assert.ok(sim.snake(z.id));
  }
});

// ------------------------------------------------------------------ L36 head-on

function headOn(seed, a, b, bFirst) {
  const sim = createSim(FIXTURE, { seed });
  const sa = Object.assign({ x: C - 200, y: C, ang: 0, cv: 1 }, a);
  const sb = Object.assign({ x: C + 200, y: C, ang: Math.PI, cv: 2 }, b);
  const first = bFirst ? sim.spawn(sb) : sim.spawn(sa);
  const second = bFirst ? sim.spawn(sa) : sim.spawn(sb);
  const A_ = bFirst ? second : first;
  const B_ = bFirst ? first : second;
  for (let t = 0; t < 60; t++) {
    const log = tickWith(sim);
    if (log.deaths.length) return { log, A: A_, B: B_, first, t };
  }
  return null;
}

test('slSim L36: a same-update head-on kills exactly one; equal L is a coin (about half each), never join order', () => {
  let aDied = 0;
  let firstDied = 0;
  const N = 1000;
  for (let seed = 1; seed <= N; seed++) {
    const r = headOn(seed, {}, {}, seed % 2 === 0);
    assert.ok(r, 'seed ' + seed + ' met head-on');
    assert.equal(r.log.deaths.length, 1, 'seed ' + seed + ': exactly one dies');
    assert.equal(r.t, 24, 'the heads meet on update 25 (gap 400 - 2 x 25 x 7.7206 <= 29)');
    const d = r.log.deaths[0];
    assert.equal(d.headOn, true);
    assert.equal(d.cause, 'snake');
    const other = d.id === r.A.id ? r.B : r.A;
    assert.equal(d.killer, other.id);
    assert.equal(other.kills, 1);
    if (d.id === r.A.id) aDied++;
    if (d.id === r.first.id) firstDied++;
  }
  // binomial(1000, 0.5): sd 15.8; 450 to 550 is more than 3 sd
  assert.ok(aDied > 450 && aDied < 550, 'left snake died ' + aDied + ' of ' + N);
  assert.ok(firstDied > 450 && firstDied < 550, 'first-spawned snake died ' + firstDied + ' of ' + N);
});

test('slSim L36: the bigger snake by L = sct + fam always wins a same-update head-on', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const bFirst = seed % 2 === 0;
    // by fam: the same bodies, L 2.6 against 2.3
    let r = headOn(seed, { fam: 0.6 }, { fam: 0.3 }, bFirst);
    assert.equal(r.log.deaths.length, 1);
    assert.equal(r.log.deaths[0].id, r.B.id, 'seed ' + seed + ': L 2.3 dies');
    r = headOn(seed, { fam: 0.3 }, { fam: 0.6 }, bFirst);
    assert.equal(r.log.deaths[0].id, r.A.id);
    // by sct: 3 points against 2 points with fam 0.9 (L 3 against 2.9)
    r = headOn(seed, { sct: 3 }, { fam: 0.9 }, bFirst);
    assert.equal(r.log.deaths.length, 1);
    assert.equal(r.log.deaths[0].id, r.B.id);
    assert.equal(r.log.deaths[0].headOn, true);
  }
});

// ------------------------------------------------------------------ L37

test('slSim L37: a snake crossing its own body never dies on it', () => {
  const sim = createSim(FIXTURE, { seed: 9 });
  const s = sim.spawn({ x: C, y: C, ang: 0, cv: 6, sct: 120 });
  let crossings = 0;
  for (let t = 0; t < 400; t++) {
    // keep wanting a quarter turn to the right: it circles over its own body
    const q = Math.floor((((s.ang + Math.PI / 2) % PI2) / PI2) * 251) % 251;
    sim.setInput(s.id, { type: 'angle', q }, 0);
    const log = tickWith(sim);
    assert.equal(log.deaths.length, 0, 'tick ' + t);
    // the test point within a sc of its own body, 4 or more points behind the head
    const [hx, hy] = headOf(s);
    const k = F1 * sc(s.pts.length);
    const px = hx + Math.cos(s.ang) * k;
    const py = hy + Math.sin(s.ang) * k;
    const pts = s.pts;
    for (let i = 0; i < pts.length - 5; i++) {
      if (pointSegDist2(px, py, pts[i].xx, pts[i].yy, pts[i + 1].xx, pts[i + 1].yy) <= (A * sc(pts.length)) ** 2) {
        crossings++;
        break;
      }
    }
  }
  assert.ok(crossings > 20, 'the test point crossed the own body ' + crossings + ' times');
  assert.equal(sim.count(), 1);
});

// ------------------------------------------------------------------ L38

test('slSim L38: the border kills when the test point (f1 sc ahead) passes flux + m; no drops, no killer', () => {
  const run = (eps, patch) => {
    const laws = patch ? makeFixture(patch) : FIXTURE;
    const sim = createSim(laws, { seed: 3, border: true, food: true, fill: false });
    assert.equal(sim.flux(), FLUX0);
    const f1 = patch && patch.L38 ? patch.L38.f1 : F1;
    const m = patch && patch.L38 ? patch.L38.m : 0;
    const s = sim.spawn({ x: C + FLUX0 + m - f1 - travel(2) + eps, y: C, ang: 0, cv: 3 });
    return { sim, s, log: tickWith(sim) };
  };
  let r = run(0.01);
  assert.equal(r.log.deaths.length, 1);
  const d = r.log.deaths[0];
  assert.equal(d.cause, 'border');
  assert.equal(d.killer, 0);
  assert.equal(d.drops.length, 0, 'L39: border deaths drop nothing');
  assert.equal(r.sim.food.tick.adds.length, 0);
  assert.equal(r.sim.food.stats().standing, 0);
  r = run(-0.01);
  assert.equal(r.log.deaths.length, 0);
  assert.equal(tickWith(r.sim).deaths[0].cause, 'border');
  // the border row's own f1 and m are read: f1 30 dies earlier, m 5 later
  r = run(0.01, { L38: { rule: 'borderKill', f1: 30, m: 0 } });
  assert.equal(r.log.deaths.length, 1);
  r = run(-0.01, { L38: { rule: 'borderKill', f1: 30, m: 0 } });
  assert.equal(r.log.deaths.length, 0);
  r = run(0.01, { L38: { rule: 'borderKill', f1: 14.5, m: 5 } });
  assert.equal(r.log.deaths.length, 1);
  r = run(-0.01, { L38: { rule: 'borderKill', f1: 14.5, m: 5 } });
  assert.equal(r.log.deaths.length, 0);
});

// ------------------------------------------------------------------ L39 death drops, sim.kill

test('slSim L39.rad: the Appendix 2 build table, every range edge', () => {
  const W = createSim(FIXTURE, { seed: 1 }).W;
  const table = [[2, 68], [89, 68], [90, 69], [127, 69], [128, 70], [150, 70], [151, 71], [169, 71], [170, 72],
    [184, 72], [185, 73], [201, 73], [202, 74], [209, 74], [210, 75], [217, 75], [218, 76], [225, 76], [226, 77],
    [239, 77], [240, 78], [245, 78], [246, 79], [251, 79], [252, 80], [258, 80], [259, 81], [262, 81], [430, 81]];
  for (const [sct, b] of table) assert.equal(deathRadByte(W, sct), b, 'sct ' + sct);
});

test('slSim L39: a death drops 2 per point + 1 along the pulled body, in discs of 20 + 15 (sc - 1), skin colours', () => {
  for (const [sct, b] of [[2, 68], [50, 68], [128, 70], [206, 74], [300, 81]]) {
    const sim = createSim(FIXTURE, { seed: 100 + sct, border: true, food: true, fill: false });
    const s = sim.spawn({ x: C - 1000, y: C + 300, ang: 0.3, cv: 3, sct });
    for (let t = 0; t < 30; t++) {
      sim.setInput(s.id, { type: 'angle', q: (t * 37) % 251 }, 0);
      tickWith(sim); // a bent, pulled body
    }
    const pts = s.pts.map((p) => [p.xx, p.yy]);
    const head = headOf(s);
    assert.equal(sim.kill(s.id), true);
    assert.ok(sim.snake(s.id), 'sim.kill waits for the next step');
    const log = tickWith(sim);
    assert.equal(log.deaths.length, 1);
    const d = log.deaths[0];
    assert.equal(d.cause, 'kill');
    assert.equal(d.killer, 0);
    assert.equal(d.sct, sct);
    assert.equal(d.drops.length, 2 * sct + 1, 'L39.count at sct ' + sct);
    const R = 20 + 15 * (sc(sct) - 1);
    let far = 0;
    let value = 0;
    for (let i = 0; i < d.drops.length; i++) {
      const q = d.drops[i];
      assert.equal(q.b, b, 'L39.rad at sct ' + sct);
      assert.equal(q.cv, 3, 'plain colours drop their own');
      value += K18 * q.b * q.b;
      const k = Math.floor(i / 2);
      let d2;
      if (i === d.drops.length - 1) {
        d2 = (q.x - head[0]) ** 2 + (q.y - head[1]) ** 2;
      } else {
        const a = pts[k];
        const e = k < pts.length - 1 ? pts[k + 1] : head;
        d2 = pointSegDist2(q.x, q.y, a[0], a[1], e[0], e[1]);
      }
      assert.ok(d2 <= R * R + 1e-9, 'drop ' + i + ' within ' + R + ' of its stretch');
      if (d2 > 0.81 * R * R) far++;
      // each drop is a food at its cell (one food per cell)
      assert.ok(q.food && q.food.b === b && q.food.cv === 3 && !q.food.nat);
    }
    assert.ok(far > 0, 'drops reach the outer part of the disc');
    near(value, (2 * sct + 1) * K18 * b * b, 1e-9, 'drop value ledger');
    assert.equal(sim.food.stats().dropped, 2 * sct + 1, 'every drop is a food');
    assert.equal(sim.snake(s.id), null);
    assert.equal(sim.kill(s.id), false);
    assert.equal(sim.check().length, 0);
  }
});

test('slSim L39.colour.skin: death drops by the skin table (one colour, pattern, cv mod 9, weights)', () => {
  const colours = (cv, sct, seed) => {
    const sim = createSim(FIXTURE, { seed });
    const s = sim.spawn({ x: C, y: C, ang: 0, cv, sct });
    sim.kill(s.id);
    return tickWith(sim).deaths[0].drops.map((q) => q.cv);
  };
  assert.ok(colours(19, 40, 1).every((c) => c === 5), 'skin 19 drops colour 5 (3389 of 3389)');
  assert.ok(colours(12, 40, 1).every((c) => c === 7), 'skin 12 pattern {7}');
  assert.ok(colours(67, 40, 1).every((c) => c === 67 % 9), 'a skin in no table drops cv mod 9');
  const all = [];
  for (let seed = 1; seed <= 4; seed++) all.push(...colours(9, 300, seed));
  const n = all.length;
  assert.equal(n, 4 * 601);
  // skin 9 weights {0: 92, 1: 300, 2: 18, 3: 22, 4: 11, 5: 11, 6: 79, 7: 320, 8: 21}, total 874
  near(all.filter((c) => c === 7).length / n, 320 / 874, 0.04, 'colour 7 share');
  near(all.filter((c) => c === 1).length / n, 300 / 874, 0.04, 'colour 1 share');
});

// ------------------------------------------------------------------ L42 spawn ring

test('slSim L42: spawns lie on ring k, r = (0.011 k - 0.002) flux, k uniform 3 to 76, angle uniform', () => {
  const sim = createSim(FIXTURE, { seed: 77, border: true });
  near((0.011 * 3 - 0.002) * FLUX0, 90.613, 1e-9, 'ring 3');
  near((0.011 * 76 - 0.002) * FLUX0, 2437.782, 1e-9, 'ring 76');
  const ks = new Map();
  let cs = 0;
  let sn = 0;
  const N = 3000;
  for (let i = 0; i < N; i++) {
    const s = sim.spawn({ cv: 0 });
    const [x, y] = [s.pts[s.pts.length - 1].xx, s.pts[s.pts.length - 1].yy];
    const r = Math.hypot(x - C, y - C);
    const k = (r / FLUX0 + 0.002) / 0.011;
    const kr = Math.round(k);
    near(r, (0.011 * kr - 0.002) * FLUX0, 1e-6, 'spawn ' + i + ' on ring ' + kr);
    assert.ok(kr >= 3 && kr <= 76, 'k ' + kr);
    ks.set(kr, (ks.get(kr) || 0) + 1);
    cs += (x - C) / r;
    sn += (y - C) / r;
    sim.remove(s.id);
  }
  assert.equal(ks.size, 74, 'every ring 3 to 76 used');
  // uniform: mean 40.5 per ring, sd 6.3
  for (const [k, c] of ks) assert.ok(c > 15 && c < 70, 'ring ' + k + ' count ' + c);
  near(cs / N, 0, 0.05, 'mean cos');
  near(sn / N, 0, 0.05, 'mean sin');
});

test('slSim L42.clear: no spawn within 400 of a body point; when no draw is clear, the farthest of 64 draws', () => {
  const sim = createSim(FIXTURE, { seed: 8, border: true });
  // a long body through the centre and a coil around ring 30
  const w = sim.spawn({ x: C + 2000, y: C, ang: 0, cv: 1, sct: 100 });
  const u = sim.spawn({ x: C - 900, y: C + 900, ang: 1, cv: 1, sct: 60 });
  for (let i = 0; i < 1000; i++) {
    const s = sim.spawn({ cv: 0 });
    const h = s.pts[s.pts.length - 1];
    for (const o of [w, u]) {
      for (const p of o.pts) assert.ok(Math.hypot(p.xx - h.xx, p.yy - h.yy) > 400, 'spawn ' + i + ' clear of ' + o.id);
    }
    sim.remove(s.id);
  }
  // nothing is clear: exactly 64 tries of two 'spawn' draws (k, angle), then the heading; the farthest try wins
  const seed = 12;
  const big = createSim(makeFixture({ 'L42.clear': 1e9 }), { seed, border: true });
  const o = big.spawn({ x: C, y: C, ang: 0, cv: 1, sct: 3 });
  const s = big.spawn({ cv: 0 });
  const r = createRng(streamSeed(seed, 'spawn'));
  let best = -1;
  let bx = 0;
  let by = 0;
  for (let t = 0; t < 64; t++) {
    const k = 3 + r.int(74);
    const th = r.next() * PI2;
    const rr = (0.011 * k - 0.002) * FLUX0;
    const x = C + rr * Math.cos(th);
    const y = C + rr * Math.sin(th);
    let m = Infinity;
    for (const p of o.pts) m = Math.min(m, (p.xx - x) ** 2 + (p.yy - y) ** 2);
    if (m > best) {
      best = m;
      bx = x;
      by = y;
    }
  }
  const heading = r.next() * PI2;
  const h = s.pts[s.pts.length - 1];
  assert.equal(h.xx, bx);
  assert.equal(h.yy, by);
  assert.equal(s.ang, heading);
  assert.equal(big.rng.spawn.state(), r.state(), '129 spawn draws');
});

// ------------------------------------------------------------------ L31 eat zone, L18, L34

test('slSim L31: eats every food inside the disc ahead of the head (centre sp (5.98 + 2.26 sc), radius 17.8 + 17.96 sc)', () => {
  for (const turn of [false, true]) {
    const sim = createSim(FIXTURE, { seed: 4, border: true, food: true, fill: false });
    const s = sim.spawn({ x: C, y: C, ang: 0, cv: 3 });
    if (turn) sim.setInput(s.id, { type: 'angle', q: 63 }, 0); // wang = 2 pi floor(256 x 63 / 251) / 256 = pi / 2
    // the zone is taken from the snake as the update starts (task T14): the spawn head and ang 0, the wang the input
    // set (inputs apply before the update), the spawn speed; the eats land after the update
    sim.applyInputs();
    const [hx, hy] = headOf(s);
    // the update's records turn from their arrival (TURNING.md), the zone still takes the wang they give
    const t2 = { ang: s.ang, wang: turn ? Math.PI / 2 : s.wang };
    assert.equal(t2.ang, 0);
    assert.equal(s.wang, 0, 'the record waits in the slot for the update');
    const dir = t2.ang + (t2.wang - t2.ang) / 2; // halfway between ang and wang
    const ahead = speed(2) * (5.98 + 2.26 * sc(2));
    const cx = hx + Math.cos(dir) * ahead;
    const cy = hy + Math.sin(dir) * ahead;
    const R = 17.8 + 17.96 * sc(2);
    near(ahead, 47.709599999999995, 1e-9, 'centre distance at sc 1');
    near(R, 35.76, 1e-12, 'radius at sc 1');
    // foods at several distances and directions around the centre
    const foods = [];
    for (const dist of [5, 30, 34.5, 35.5, 37, 40]) {
      for (const a of [0, 1.3, 2.6, 4.0, 5.2]) {
        const f = sim.food.drop(cx + dist * Math.cos(a), cy + dist * Math.sin(a), 30, 2);
        if (f) foods.push(f);
      }
    }
    const want = foods.filter((f) => (f.x - cx) ** 2 + (f.y - cy) ** 2 <= R * R).map((f) => f.id).sort((a, b) => a - b);
    assert.ok(want.length > 5 && want.length < foods.length, 'some inside, some outside');
    // the same foods with the centre along ang only would differ when turning (pi / 4 against 0)
    if (turn) {
      const ax = hx + Math.cos(t2.ang) * ahead;
      const ay = hy + Math.sin(t2.ang) * ahead;
      const alt = foods.filter((f) => (f.x - ax) ** 2 + (f.y - ay) ** 2 <= R * R).map((f) => f.id).sort((a, b) => a - b);
      assert.notDeepEqual(alt, want, 'the lean matters for this layout');
    }
    tickWith(sim);
    const eaten = sim.food.tick.eats.map((e) => e.food.id).sort((a, b) => a - b);
    assert.deepEqual(eaten, want);
    for (const e of sim.food.tick.eats) {
      assert.equal(e.eater, s.id);
      assert.equal(e.ev.eater, s.id, 'never an eat without an eater (no c)');
    }
    // L18 one food at a time, the multiplier from the fam before each eat
    let fam = 0;
    for (let i = 0; i < want.length; i++) {
      const Lq = (Math.floor(100 * (2 - 1 + fam)) + 1) / 100;
      fam += K18 * 30 * 30 * Math.pow(1 - Lq / 430, 2.25);
    }
    near(s.fam, fam, 1e-12, 'fam after ' + want.length + ' eats');
  }
});

test('slSim L34: a prey inside the eat disc is eaten in the L18 form with Kp 0.0958111', () => {
  const sim = createSim(FIXTURE, { seed: 6, border: true, prey: true });
  const s = sim.spawn({ x: C, y: C, ang: 0, cv: 3 });
  const p = sim.preys.spawnAt(C + travel(2) + 47.7096, C + 3);
  const far = sim.preys.spawnAt(C + travel(2) + 47.7096, C + 60);
  tickWith(sim);
  assert.deepEqual(sim.preys.tick.eats.map((e) => [e.id, e.eater]), [[p.id, s.id]]);
  assert.ok(sim.preys.get(far.id), 'the prey outside the disc lives');
  const Lq = (Math.floor(100 * (2 - 1)) + 1) / 100;
  near(s.fam, 0.0958111 * p.rad * p.rad * Math.pow(1 - Lq / 430, 2.25), 1e-12, 'L34');
});

test('slSim L31: one food, two eaters: exactly one eats it, the earlier in the seeded order (never join order)', () => {
  const firsts = new Map();
  for (let seed = 1; seed <= 200; seed++) {
    const sim = createSim(FIXTURE, { seed, border: true, food: true, fill: false });
    const a = sim.spawn({ x: C - 60, y: C, ang: 0, cv: 1 });
    const b = sim.spawn({ x: C, y: C - 60, ang: Math.PI / 2, cv: 2 });
    sim.food.drop(C + 2, C + 2, 40, 0);
    tickWith(sim);
    const e = sim.food.tick.eats;
    assert.equal(e.length, 1, 'seed ' + seed);
    firsts.set(e[0].eater === a.id ? 'a' : 'b', (firsts.get(e[0].eater === a.id ? 'a' : 'b') || 0) + 1);
  }
  assert.ok(firsts.get('a') > 70 && firsts.get('b') > 70, JSON.stringify([...firsts]));
});

// ------------------------------------------------------------------ the grid search equals brute force

// Independent 2D segment distance: 0 when they cross, else the smallest endpoint-to-segment distance.
function bruteSeg2(p0, p1, a, b) {
  const cross = (o, u, v) => (u[0] - o[0]) * (v[1] - o[1]) - (u[1] - o[1]) * (v[0] - o[0]);
  const d1 = cross(a, b, p0);
  const d2 = cross(a, b, p1);
  const d3 = cross(p0, p1, a);
  const d4 = cross(p0, p1, b);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(pointSegDist2(p0[0], p0[1], a[0], a[1], b[0], b[1]), pointSegDist2(p1[0], p1[1], a[0], a[1], b[0], b[1]),
    pointSegDist2(a[0], a[1], p0[0], p0[1], p1[0], p1[1]), pointSegDist2(b[0], b[1], p0[0], p0[1], p1[0], p1[1]));
}

test('slSim L35: the sector-grid search finds exactly what a brute force over every capsule finds', () => {
  const sim = createSim(FIXTURE, { seed: 31 });
  const r = createRng(4031);
  for (let i = 0; i < 40; i++) {
    sim.spawn({ x: C - 1200 + 2400 * r.next(), y: C - 1200 + 2400 * r.next(), ang: r.next() * PI2, cv: i % 9,
      sct: 2 + r.int(150) });
  }
  for (let t = 0; t < 40; t++) {
    sim.forEachSnake((s) => {
      if (r.next() < 0.3) sim.setInput(s.id, { type: 'angle', q: r.int(251) }, 0);
    });
    tickWith(sim);
  }
  assert.ok(sim.count() > 5, 'snakes left: ' + sim.count());
  const snakes = [];
  sim.forEachSnake((s) => snakes.push(s));
  let hits = 0;
  for (let q = 0; q < 3000; q++) {
    const x0 = C - 1300 + 2600 * r.next();
    const y0 = C - 1300 + 2600 * r.next();
    const len = q % 2 ? 0 : 40 * r.next();
    const th = r.next() * PI2;
    const p0 = [x0, y0];
    const p1 = [x0 + len * Math.cos(th), y0 + len * Math.sin(th)];
    let best = null;
    let bd = Infinity;
    for (const s of snakes) {
      const chain = s.pts.map((p) => [p.xx, p.yy]).concat([headOf(s)]);
      let m = Infinity;
      for (let i = 0; i < chain.length - 1; i++) m = Math.min(m, bruteSeg2(p0, p1, chain[i], chain[i + 1]));
      const lim = A * sc(s.pts.length);
      if (m <= lim * lim && m < bd) {
        bd = m;
        best = s.id;
      }
    }
    const got = sim.probe(p0[0], p0[1], p1[0], p1[1]);
    if (best === null) {
      assert.equal(got, null, 'query ' + q);
    } else {
      hits++;
      assert.ok(got, 'query ' + q + ' finds snake ' + best);
      assert.equal(got.id, best, 'query ' + q);
      near(got.d * got.d, bd, 1e-6, 'query ' + q + ' distance');
    }
  }
  assert.ok(hits > 100, 'hits ' + hits);
  assert.equal(sim.check().length, 0);
});

// ------------------------------------------------------------------ the world over time

test('slSim world: 3000 ticks of 16 snakes: invariants hold every 100 ticks, deaths of every cause, food per cell', () => {
  const sim = createSim(FIXTURE, { seed: 2024, world: true });
  const r = createRng(2024);
  const slots = [];
  for (let k = 0; k < 16; k++) slots.push(sim.spawn({ cv: (k * 7) % 66 }).id);
  const causes = { snake: 0, border: 0, kill: 0 };
  let headOns = 0;
  let eats = 0;
  for (let t = 0; t < 3000; t++) {
    for (let i = 0; i < slots.length; i++) {
      const id = slots[i];
      if (!sim.snake(id)) {
        if (r.next() < 0.05) slots[i] = sim.spawn({ cv: r.int(66) }).id;
        continue;
      }
      const u = r.next();
      if (u < 0.1) sim.setInput(id, { type: 'angle', q: r.int(251) }, r.int(43));
      else if (u < 0.13) sim.setInput(id, { type: 'boost', on: r.next() < 0.5 }, r.int(43));
      else if (u < 0.1305) sim.kill(id);
    }
    const log = tickWith(sim);
    for (const d of log.deaths) {
      causes[d.cause]++;
      if (d.headOn) headOns++;
      assert.equal(d.drops.length, d.cause === 'border' ? 0 : 2 * d.sct + 1);
      if (d.cause === 'snake') assert.ok(d.killer > 0 && d.killer !== d.id);
    }
    for (const e of sim.food.tick.eats) {
      assert.ok(e.eater > 0 && e.ev.eater === e.eater);
      eats++;
    }
    if (t % 100 === 99) assert.deepEqual(sim.check(), [], 'tick ' + t);
  }
  assert.ok(causes.snake > 5 && causes.border > 5 && causes.kill > 0, JSON.stringify(causes));
  assert.ok(eats > 1000, 'eats ' + eats);
  assert.ok(headOns >= 0);
});
