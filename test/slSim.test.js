'use strict';
// slSim snake half (task T4; SERVER-BUILD-BRIEF section 8, SERVER-DESIGN 6.2 and 18.1). FIXTURE table only. Every
// expected number is a LITERAL from the SERVER-LAWS row of its id (or computed from that row's formula with the row's
// literal constants written in this file), never read back from the code under test.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const slCore = require('../shared/slCore.js');
const { createSim, SIM_LAW_IDS } = require('../server/sl/slSim');
const slSnake = require('../server/sl/slSnake');
const { FIXTURE, makeFixture } = require('./slLawsFixture');

const PI2 = 2 * Math.PI;
const P = 42.67; // L7
const MSL = 42; // L5
const C = 32550; // L1 grd: the map centre

function near(a, b, tol, what) {
  assert.ok(Math.abs(a - b) <= tol, (what || 'value') + ': ' + a + ' is not within ' + tol + ' of ' + b);
}

function sim1(spec, seed) {
  const sim = createSim(FIXTURE, { seed: seed === undefined ? 1 : seed });
  const s = sim.spawn(Object.assign({ x: C, y: C, ang: 0, cv: 3 }, spec || {}));
  return { sim, s };
}

function tickWith(sim) {
  sim.applyInputs();
  return sim.step();
}

// ------------------------------------------------------------------ the law gate

test('slSim: every SIM_LAW_IDS row is in the table; a changed or refuted form is refused', () => {
  for (const id of SIM_LAW_IDS) assert.ok(Object.prototype.hasOwnProperty.call(FIXTURE, id), id);
  assert.throws(() => createSim(makeFixture({ L16: { rule: 'pushBeforePull' } }), { seed: 1 }), /pushBeforePull/);
  assert.throws(() => createSim(makeFixture({ L12: Object.assign({}, FIXTURE.L12.value, { setAt: 'everyUpdate' }) }), { seed: 1 }), /L12/);
  assert.throws(() => createSim(makeFixture({ 'L18.when': 'extraPoint' }), { seed: 1 }), /L18.when/);
  assert.throws(() => createSim(makeFixture({ 'L23.period': { periodMs: 155.2, start: 'grid' } }), { seed: 1 }), /L23.period/);
  assert.throws(() => createSim(makeFixture({ L20: Object.assign({}, FIXTURE.L20.value, { sp: 5.8 }) }), { seed: 1 }), /L20/);
  assert.throws(() => createSim(makeFixture({ L22: null }), { seed: 1 }), /L22/);
  assert.throws(() => createSim(FIXTURE, {}), /seed/);
});

test('slSim: the sim files use no Math.random, no Date and never import the fixture', () => {
  for (const f of ['slSim.js', 'slSnake.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'sl', f), 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!/Math\.random/.test(src), f + ' uses Math.random');
    assert.ok(!/\bDate\b/.test(src), f + ' uses Date');
    assert.ok(!/slLawsFixture/.test(src), f + ' imports the fixture');
  }
});

// ------------------------------------------------------------------ L20 spawn

test('slSim L20: spawn state sct 2, fam 0, sp 5.79, two points 42 apart, ang = wang = heading', () => {
  const { s } = sim1({ ang: 1.25 });
  assert.equal(s.pts.length, 2);
  assert.equal(s.fam, 0);
  assert.equal(Math.trunc(1000 * s.sp), 5790);
  assert.equal(Math.trunc(18 * s.sp), 104);
  assert.equal(s.ang, 1.25);
  assert.equal(s.wang, 1.25);
  const [t, h] = s.pts;
  assert.equal(h.xx, C);
  assert.equal(h.yy, C);
  near(Math.hypot(h.xx - t.xx, h.yy - t.yy), 42, 1e-9, 'spawn gap');
  near(Math.atan2(h.yy - t.yy, h.xx - t.xx), 1.25, PI2 / 65536, 'spawn line heading');
  // heading uniform from the spawn stream when not given: different per seed, always inside [0, 2 pi)
  const hs = new Set();
  for (let seed = 1; seed <= 50; seed++) {
    const sim = createSim(FIXTURE, { seed });
    const a = sim.spawn({ x: C, y: C, cv: 0 }).ang;
    assert.ok(a >= 0 && a < PI2);
    hs.add(a);
  }
  assert.equal(hs.size, 50);
});

// ------------------------------------------------------------------ L12

test('slSim L12: the normal speed is set at spawn and boost end only, never on growth', () => {
  const { sim, s } = sim1({ fam: 8 }); // 8 pending points: every move is a grow
  for (let i = 0; i < 80; i++) tickWith(sim);
  assert.equal(s.pts.length, 10);
  assert.equal(Math.trunc(1000 * s.sp), 5790, 'still the spawn speed at sct 10');
  sim.setInput(s.id, { type: 'boost', on: true }, 43);
  tickWith(sim);
  sim.setInput(s.id, { type: 'boost', on: false }, 43);
  const sct = s.pts.length;
  for (let i = 0; i < 40; i++) tickWith(sim);
  const want = 5.39 + 0.4 * Math.min(6, 1 + (sct - 2) / 106); // L12 at m = sct at the 254
  assert.equal(s.sp, want);
  if (sct === 10) assert.equal(s.sp, 5.820188679245283);
  // the plain double of the client's expression: their server sent 6189 at m = 108 (SERVER-LAWS L12 evidence)
  assert.equal(Math.trunc(1000 * slSnake.speedBase(sim.K, 108)), 6189);
});

// ------------------------------------------------------------------ L13

test('slSim L13: ramp counts at sct 2 (13 up, 10 down), steps 0.6568 and 0.8757333, ratio 0.75', () => {
  const { sim, s } = sim1({ fam: 0.9 });
  sim.setInput(s.id, { type: 'boost', on: true }, 43); // offset >= 42.67: a full first step
  const ups = [];
  let prev = s.sp;
  for (let i = 0; i < 13; i++) {
    tickWith(sim);
    ups.push(s.sp - prev);
    prev = s.sp;
  }
  assert.equal(s.pts.length, 2);
  assert.equal(s.sp, 14);
  near(ups[0], 0.6568, 1e-12, 'up step');
  near(ups[11], 0.6568, 1e-12, 'up step 12');
  assert.ok(5.79 + 12 * 0.6568 < 14, '12 steps stay under nsp3');
  sim.setInput(s.id, { type: 'boost', on: false }, 43);
  const downs = [];
  prev = s.sp;
  let n = 0;
  while (s.sp > 5.79 + 1e-12) {
    tickWith(sim);
    downs.push(prev - s.sp);
    prev = s.sp;
    n++;
  }
  assert.equal(n, 10);
  assert.equal(Math.trunc(1000 * s.sp), 5790);
  near(downs[0], 0.8757333333333333, 1e-12, 'down step');
  near(ups[0] / downs[0], 0.75, 1e-12, 'N_up / N_down');
});

test('slSim L13.first: the first ramp step is the arrival offset fraction of a full step', () => {
  const { sim, s } = sim1({ fam: 0.9 });
  sim.setInput(s.id, { type: 'boost', on: true }, 20);
  tickWith(sim);
  near(s.sp - 5.79, 0.307850949144598, 1e-12, 'first step at 20 ms');
  tickWith(sim);
  near(s.sp - 5.79, 0.307850949144598 + 0.6568, 1e-12, 'second step full');
  for (let i = 0; i < 20; i++) tickWith(sim);
  assert.equal(s.sp, 14);
  sim.setInput(s.id, { type: 'boost', on: false }, 10);
  tickWith(sim);
  near(14 - s.sp, 0.8757333333333333 * 10 / 42.67, 1e-12, 'first down step at 10 ms');
  // an offset of 0 means no step in that first update
  const b = sim1({ fam: 0.9 });
  b.sim.setInput(b.s.id, { type: 'boost', on: true }, 0);
  tickWith(b.sim);
  assert.equal(Math.trunc(1000 * b.s.sp), 5790);
  assert.equal(b.s.boosting, true);
});

// ------------------------------------------------------------------ L14

test('slSim L14: turn per ms at sct 2, 100, 300 uses K 111 and the current sct', () => {
  const want = { 2: 0.004125, 100: 0.00314655598165733, 300: 0.00163194677785894 };
  for (const sct of [2, 100, 300]) {
    const { sim, s } = sim1({ sct, ang: 0 });
    sim.setInput(s.id, { type: 'angle', q: 125 }, 0); // wang byte floor(256 x 125 / 251) = 127: just under pi
    tickWith(sim);
    assert.equal(s.dir, 2);
    near(s.ang / P, want[sct], 1e-15, 'rate at sct ' + sct);
    const neg = sim1({ sct, ang: 0 });
    neg.sim.setInput(neg.s.id, { type: 'angle', q: 130 }, 0); // byte 132: just over pi, turns the other way
    tickWith(neg.sim);
    assert.equal(neg.s.dir, 1);
    near(PI2 - neg.s.ang, want[sct] * P, 1e-12, 'rate down at sct ' + sct);
  }
  // the client's 106 would give a different rate at sct 300 (REFUTED, L14 div 106)
  const rate106 = 0.033 / 8 * (0.13 + 0.87 * Math.pow((7 - (1 + 298 / 106)) / 6, 2));
  assert.ok(Math.abs(rate106 - want[300]) > 5e-5, 'the refuted 106 is told apart at sct 300');
});

test('slSim L14: the turn stops exactly on wang', () => {
  const { sim, s } = sim1({ ang: 0 });
  sim.setInput(s.id, { type: 'angle', q: 3 }, 0); // byte 3: 0.0736 rad, under one update of turn (0.176 rad)
  tickWith(sim);
  assert.equal(s.ang, 3 * 2 * Math.PI / 256);
  assert.equal(s.turning, false);
});

// ------------------------------------------------------------------ L15

test('slSim L15: all 251 direction bytes give wang = 2 pi floor(256 b / 251) / 256', () => {
  const { sim, s } = sim1();
  const seen = new Set();
  for (let b = 0; b <= 250; b++) {
    sim.setInput(s.id, { type: 'angle', q: b }, 0);
    sim.applyInputs();
    const byte = Math.floor(256 * b / 251);
    assert.equal(s.wang, byte * 2 * Math.PI / 256, 'byte ' + b);
    seen.add(byte);
  }
  // the bytes floor can never give (FINAL-move L15 image test): 51, 102, 153, 204, 255
  const missing = [];
  for (let k = 0; k < 256; k++) if (!seen.has(k)) missing.push(k);
  assert.deepEqual(missing, [51, 102, 153, 204, 255]);
  assert.throws(() => sim.setInput(s.id, { type: 'angle', q: 251 }, 0), /range/);
});

test('slSim L15: arrow ticks move wang at the client rate mamu v scang spang, newest angle wins', () => {
  const { sim, s } = sim1({ ang: 1 });
  sim.setInput(s.id, { type: 'turn', dir: 'right', v: 10 }, 0);
  sim.applyInputs();
  near(s.wang, 1 + 0.33, 1e-12, 'right 10 ticks at sct 2'); // 0.033 x 10 x scang(1) 1 x spang 1
  sim.setInput(s.id, { type: 'turn', dir: 'left', v: 4 }, 0);
  sim.setInput(s.id, { type: 'turn', dir: 'left', v: 6 }, 0);
  sim.applyInputs();
  near(s.wang, 1, 1e-12, 'left 4 + 6 ticks');
  // an angle drops the arrow ticks before it; ticks after it are added
  sim.setInput(s.id, { type: 'turn', dir: 'right', v: 50 }, 0);
  sim.setInput(s.id, { type: 'angle', q: 0 }, 0);
  sim.setInput(s.id, { type: 'turn', dir: 'right', v: 1 }, 0);
  sim.applyInputs();
  near(s.wang, 0.033, 1e-15, 'angle then one tick');
});

// ------------------------------------------------------------------ L16

test('slSim L16: the body is pulled BEFORE each new point (gaps 1 to 3 = msl, gap 4 = msl (1 - cst / 4))', () => {
  const { sim, s } = sim1({ sct: 30, ang: 0 });
  for (let i = 0; i < 200; i++) tickWith(sim);
  const pts = s.pts;
  const n = pts.length;
  const gap = (k) => Math.hypot(pts[n - k].xx - pts[n - k - 1].xx, pts[n - k].yy - pts[n - k - 1].yy);
  near(gap(1), 42, 1e-9, 'gap 1');
  near(gap(2), 42, 1e-9, 'gap 2');
  near(gap(3), 42, 1e-9, 'gap 3');
  near(gap(4), 37.485, 1e-9, 'gap 4 = 42 (1 - 0.43 / 4)');
  // then toward msl (1 - cst) on a straight body: 32.97, 28.46, 23.94, 23.94 (SERVER-LAWS L16, two decimals)
  near(gap(5), 32.97, 0.006, 'gap 5');
  near(gap(6), 28.46, 0.006, 'gap 6');
  near(gap(7), 23.94, 0.006, 'gap 7');
  near(gap(8), 23.94, 0.006, 'gap 8');
  // negative control: the client order (push, then pull) on the same body makes gap 3 37.485, which the server's
  // data rule out (0 of 909 bodies)
  const body = pts.map((p) => ({ xx: p.xx, yy: p.yy, smu: p.smu }));
  const last = body[body.length - 1];
  const hp = slCore.headStep(last.xx, last.yy, 0, 42);
  body.push({ xx: hp[0], yy: hp[1], smu: 1 });
  body.shift();
  slCore.chainPull(body, 0.43, slCore.buildSmus(0.43));
  const m = body.length;
  near(Math.hypot(body[m - 3].xx - body[m - 4].xx, body[m - 3].yy - body[m - 4].yy), 37.485, 1e-9, 'client order gap 3');
});

test('slSim L48.abs: the first point after spawn is on integers, later points are one msl step on the 16-bit angle', () => {
  const { sim, s } = sim1({ ang: 0.3 });
  let firstSeen = false;
  for (let i = 0; i < 60; i++) {
    const before = s.pts[s.pts.length - 1];
    const bx = before.xx;
    const by = before.yy;
    const rec = tickWith(sim).updates[0];
    if (!rec.move) continue;
    if (!firstSeen) {
      firstSeen = true;
      assert.equal(rec.abs, true);
      assert.ok(Number.isInteger(rec.xx) && Number.isInteger(rec.yy));
      continue;
    }
    assert.equal(rec.abs, false);
    const hp = slCore.headStep(bx, by, rec.iang, 42);
    assert.equal(rec.xx, hp[0]);
    assert.equal(rec.yy, hp[1]);
    assert.equal(rec.iang, Math.round(s.ang * 65536 / PI2) & 65535);
  }
  assert.ok(firstSeen);
});

// ------------------------------------------------------------------ L18, L19, L34

test('slSim L18: food gain K b^2 (1 - Lq / 430)^2.25 with Lq from the fam before the eat', () => {
  const { sim, s } = sim1();
  sim.feed(s.id, 25);
  near(s.fam, 0.0788391610758393, 1e-15, 'b 25 at sct 2');
  const b = sim1({ sct: 50, fam: 0.3 });
  b.sim.feed(b.s.id, 40);
  near(b.s.fam, 0.3 + 0.154262951043299, 1e-15, 'b 40 at sct 50 fam 0.3');
  // two eats apply one after another with the multiplier recomputed from the new fam
  const c = sim1();
  c.sim.feed(c.s.id, 25);
  c.sim.feed(c.s.id, 25);
  const Lq = (Math.floor(100 * (2 - 1 + 0.0788391610758393)) + 1) / 100;
  near(c.s.fam, 0.0788391610758393 + 0.00012681186 * 625 * Math.pow(1 - Lq / 430, 2.25), 1e-15, 'second eat');
});

test('slSim L18: a point at fam 1 and one point per move while fam is above 1 and 2', () => {
  const { sim, s } = sim1({ fam: 2.5 });
  const kinds = [];
  for (let i = 0; i < 40 && kinds.length < 4; i++) {
    const rec = tickWith(sim).updates[0];
    assert.ok(rec.moves <= 1);
    if (rec.move) kinds.push([rec.grow, s.pts.length, Math.round(s.fam * 1000) / 1000]);
  }
  assert.deepEqual(kinds, [[true, 3, 1.5], [true, 4, 0.5], [false, 4, 0.5], [false, 4, 0.5]]);
  // feeding to just under 1 grows nothing; to 1 grows one point at the next move (L18.when: the regular move)
  const b = sim1({ fam: 0.999 });
  for (let i = 0; i < 30; i++) assert.equal(tickWith(b.sim).updates[0].grow, false);
  b.sim.feed(b.s.id, 10);
  let grew = 0;
  for (let i = 0; i < 30; i++) if (tickWith(b.sim).updates[0].grow) grew++;
  assert.equal(grew, 1);
  assert.equal(b.s.pts.length, 3);
});

test('slSim L19 and L34: the multiplier clamps at 0 once Lq reaches 430; prey in the L18 form with Kp', () => {
  const K = createSim(FIXTURE, { seed: 1 }).K;
  assert.equal(slSnake.famMult(K, 431, 0), 0);
  assert.equal(slSnake.famMult(K, 430, 0.99), 0); // Lq = (42999 + 1) / 100 = 430
  assert.ok(slSnake.famMult(K, 429, 0.98) > 0);
  const { sim, s } = sim1();
  sim.feedPrey(s.id, 7);
  near(s.fam, 4.66996914063923, 1e-12, 'prey rad 7 at sct 2');
});

test('slSim L48.hDefer: a fam change no record carried goes first at the snake next update', () => {
  const { sim, s } = sim1();
  let rec = tickWith(sim).updates[0];
  assert.equal(rec.h, false);
  sim.feed(s.id, 25);
  rec = tickWith(sim).updates[0];
  assert.equal(rec.h, true);
  assert.equal(rec.hFam, s.fam);
  rec = tickWith(sim).updates[0];
  assert.equal(rec.h, false);
});

// ------------------------------------------------------------------ L21, L22

test('slSim L21: no length is lost without boosting', () => {
  const { sim, s } = sim1({ sct: 20, fam: 0.4 });
  for (let i = 0; i < 2000; i++) tickWith(sim);
  assert.equal(s.pts.length, 20);
  assert.equal(s.fam, 0.4);
});

test('slSim L22: boost starts iff L > 2.14, decided at the press', () => {
  const lo = sim1({ fam: 0.139 });
  lo.sim.setInput(lo.s.id, { type: 'boost', on: true }, 10);
  tickWith(lo.sim);
  assert.equal(lo.s.boosting, false);
  assert.equal(lo.s.chargeCount, 0);
  const eq = sim1({ fam: 0.14 }); // 2 + 0.14 is exactly 2.14 as a double: not above
  eq.sim.setInput(eq.s.id, { type: 'boost', on: true }, 10);
  tickWith(eq.sim);
  assert.equal(eq.s.boosting, false);
  const hi = sim1({ fam: 0.141 });
  hi.sim.setInput(hi.s.id, { type: 'boost', on: true }, 10);
  tickWith(hi.sim);
  assert.equal(hi.s.boosting, true);
  assert.equal(hi.s.chargeCount, 1);
  // a refused press stays refused while held: growing above T starts nothing until a new 253
  lo.sim.feed(lo.s.id, 60);
  for (let i = 0; i < 5; i++) tickWith(lo.sim);
  assert.equal(lo.s.boosting, false);
  lo.sim.setInput(lo.s.id, { type: 'boost', on: false }, 0);
  lo.sim.setInput(lo.s.id, { type: 'boost', on: true }, 0);
  tickWith(lo.sim);
  assert.equal(lo.s.boosting, true);
});

// ------------------------------------------------------------------ L23

// The update at time T pays what fell in its window, the P ms before T (task T14b): a press offset ms before the first
// update is at T1 - offset, its k-th charge at T1 - offset + k x 155.2, paid by the update n whose window holds it, so
// after n updates the count is 1 + floor((offset + (n - 1) x 42.67) / 155.2).
test('slSim L23: the first charge at the press, then one per 155.2 ms on a clock started at the press offset', () => {
  const run = (offset, updates) => {
    const { sim, s } = sim1({ sct: 40, fam: 0.5 });
    sim.setInput(s.id, { type: 'boost', on: true }, offset);
    for (let i = 0; i < updates; i++) tickWith(sim);
    return s.chargeCount;
  };
  assert.equal(run(0, 1), 1);
  assert.equal(run(0, 4), 1); // 0 + 3 x 42.67 = 128.01 < 155.2
  assert.equal(run(30, 3), 1); // 30 + 85.34 = 115.34 < 155.2
  assert.equal(run(30, 4), 2); // 30 + 128.01 = 158.01 >= 155.2
  assert.equal(run(0, 5), 2); // 170.68
  assert.equal(run(0, 100), 28); // 1 + floor(4224.33 / 155.2)
  assert.equal(run(40, 100), 28); // 1 + floor(4264.33 / 155.2)
  assert.equal(run(30, 400), 110); // 1 + floor((30 + 17025.33) / 155.2) = 1 + 109
});

test('slSim L23: no charge after a 254: one due before its arrival is paid, one due after it is not', () => {
  // press at T1 (offset 0); the second charge is due at T1 + 155.2, inside update 5's window (T1 + 128.01, T1 +
  // 170.68], 27.19 ms into it
  const end = (offset) => {
    const { sim, s } = sim1({ sct: 40, fam: 0.5 });
    sim.setInput(s.id, { type: 'boost', on: true }, 0);
    for (let i = 0; i < 4; i++) tickWith(sim);
    sim.setInput(s.id, { type: 'boost', on: false }, offset);
    tickWith(sim);
    assert.equal(s.boosting, false);
    return s.chargeCount;
  };
  assert.equal(end(20), 1); // the 254 at 42.67 - 20 = 22.67 ms into the window: before the charge
  assert.equal(end(10), 2); // at 32.67 ms: after it
  assert.equal(end(16), 1); // 26.67 < 27.19
  assert.equal(end(15), 2); // 27.67 > 27.19
});

// Task T14b (seed 16 law check): every accepted 253 starts a boost run with its own first charge and its own clock
// (L22, L23), also when two boost records land inside ONE update slot.
test('slSim L23: a 254 then a 253 in one update restart the clock at the 253, with a charge at that press', () => {
  const { sim, s } = sim1({ sct: 40, fam: 0.5 });
  sim.setInput(s.id, { type: 'boost', on: true }, 0);
  for (let i = 0; i < 3; i++) tickWith(sim);
  assert.equal(s.chargeCount, 1);
  near(s.chargeMs, 2 * P, 1e-9, 'old clock'); // 85.34 from the press to the end of update 3
  sim.setInput(s.id, { type: 'boost', on: false }, 30); // arrived 30 ms before the update
  sim.setInput(s.id, { type: 'boost', on: true }, 10); // then 10 ms before it
  tickWith(sim);
  assert.equal(s.boosting, true);
  assert.equal(s.chargeCount, 2); // the charge at the new press; the old run ended at the 254
  near(s.chargeMs, 10, 1e-9, 'new clock from the 253'); // 10, not 85.34 + 42.67
  // the next charge is due 155.2 after the 253: 10 + 4 x 42.67 = 180.68 >= 155.2, 10 + 3 x 42.67 = 138.01 is not
  for (let i = 0; i < 3; i++) tickWith(sim);
  assert.equal(s.chargeCount, 2);
  tickWith(sim);
  assert.equal(s.chargeCount, 3);
  // a 253 while boosting (no 254 between) is no new press: the clock runs on
  const ms = s.chargeMs;
  sim.setInput(s.id, { type: 'boost', on: true }, 5);
  tickWith(sim);
  assert.equal(s.chargeCount, 3);
  near(s.chargeMs, ms + P, 1e-9, 'clock kept');
});

test('slSim L23: a 253, a 254 and a 253 in one update are two presses with a charge each', () => {
  const { sim, s } = sim1({ sct: 40, fam: 0.5 });
  sim.setInput(s.id, { type: 'boost', on: true }, 40);
  sim.setInput(s.id, { type: 'boost', on: false }, 25);
  sim.setInput(s.id, { type: 'boost', on: true }, 5);
  tickWith(sim);
  assert.equal(s.boosting, true);
  assert.equal(s.chargeCount, 2);
  near(s.chargeMs, 5, 1e-9, 'clock from the last 253');
  // a 253 then a 254 in one update: the press was accepted, so its charge is taken; the boost is over
  const b = sim1({ sct: 40, fam: 0.5 });
  b.sim.setInput(b.s.id, { type: 'boost', on: true }, 30);
  b.sim.setInput(b.s.id, { type: 'boost', on: false }, 10);
  tickWith(b.sim);
  assert.equal(b.s.boosting, false);
  assert.equal(b.s.chargeCount, 1);
  // each first charge pays its own mass: at sct 2 fam falls by two draws in [0.07754, 0.08892] (L23) times the L18
  // multiplier (1 - Lq / 430)^2.25, above 0.98 at L 2.5; one charge would be at most 0.08892
  const c = sim1({ fam: 0.5 });
  c.sim.setInput(c.s.id, { type: 'boost', on: true }, 40);
  c.sim.setInput(c.s.id, { type: 'boost', on: false }, 25);
  c.sim.setInput(c.s.id, { type: 'boost', on: true }, 5);
  tickWith(c.sim);
  assert.equal(c.s.chargeCount, 2);
  const paid = 0.5 - c.s.fam;
  assert.ok(paid > 2 * 0.07754 * 0.98 && paid <= 2 * 0.08892, 'two charges paid: ' + paid);
});

test('slSim L23: charge edges 0.07754 to 0.08892 at sct 2 to 6, the approved cubic above', () => {
  const K = createSim(FIXTURE, { seed: 1 }).K;
  for (const sct of [2, 4, 6]) {
    assert.equal(slSnake.chargeLo(K, sct), 0.07754);
    assert.equal(slSnake.chargeHi(K, sct), 0.08892);
  }
  near(slSnake.chargeLo(K, 330), 0.21573555862208, 1e-15, 'lo 330');
  near(slSnake.chargeHi(K, 330), 0.26095042357056003, 1e-15, 'hi 330');
  near(slSnake.chargeLo(K, 430), 0.33355290359808, 1e-15, 'lo 430 (SERVER-LAWS: 0.334)');
  near(slSnake.chargeHi(K, 430), 0.41004102560255995, 1e-15, 'hi 430 (SERVER-LAWS: 0.410)');
});

test('slSim L23: below fam 0 the tail goes (an r record), at sct 2 fam clamps to 0 and the boost ends', () => {
  const { sim, s } = sim1({ sct: 4, fam: 0.05 });
  sim.setInput(s.id, { type: 'boost', on: true }, 0);
  let tails = 0;
  let ended = -1;
  for (let i = 0; i < 400 && ended < 0; i++) {
    const rec = tickWith(sim).updates[0];
    for (const f of rec.tails) {
      tails++;
      assert.ok(f >= 0 && f < 1, 'fam after a tail loss is fam + 1');
    }
    if (!s.boosting) ended = i;
  }
  assert.equal(tails, 2);
  assert.ok(ended > 0);
  assert.equal(s.pts.length, 2);
  assert.equal(s.fam, 0);
  assert.equal(Math.trunc(1000 * s.spBase), 5790); // L12 base at m = 2 after a self-stop
  for (let i = 0; i < 20; i++) tickWith(sim);
  assert.equal(Math.trunc(1000 * s.sp), 5790);
  assert.equal(sim.grid.check().length, 0);
});

// ------------------------------------------------------------------ L24

test('slSim L24: drop byte round(84.2853 sqrt(c) + 0.1702)', () => {
  const K = createSim(FIXTURE, { seed: 1 }).K;
  assert.equal(slSnake.dropByte(K, 0.07754), 24);
  assert.equal(slSnake.dropByte(K, 0.08892), 25);
  assert.equal(slSnake.dropByte(K, 0.21573555862208), 39);
  assert.equal(slSnake.dropByte(K, 0.26095042357056003), 43);
});

test('slSim L24.Td: a charge drops one food iff L before it is above 2.14, never on the clamped charge', () => {
  const at = (sct, fam) => {
    const { sim, s } = sim1({ sct, fam });
    return { d: slSnake.charge(sim, s), sim, s };
  };
  assert.equal(at(2, 0.14).d, null); // L 2.14: not above
  assert.equal(at(2, 0.13).d, null);
  const a = at(2, 0.15);
  assert.ok(a.d && (a.d.b === 24 || a.d.b === 25), 'L 2.15 drops a byte 24 or 25 food');
  assert.equal(a.sim.log.drops.length, 1);
  const tail = a.s.pts[0];
  assert.ok(Math.hypot(a.d.x - tail.xx, a.d.y - tail.yy) <= 10, 'within the L24.place disc of the tail');
  const b = at(3, 0); // L 3: drops, and the tail point goes
  assert.ok(b.d);
  assert.equal(b.s.pts.length, 2);
  const z = at(2, 0.01); // fam below the charge at sct 2: clamped, no drop, boost off
  assert.equal(z.d, null);
  assert.equal(z.s.fam, 0);
});

test('slSim L24.colour.skin: plain colours drop their own, skins by the table, others cv mod 9', () => {
  const K = createSim(FIXTURE, { seed: 1 }).K;
  const rng = { next: () => { throw new Error('no draw expected'); } };
  for (let cv = 0; cv <= 8; cv++) assert.equal(slSnake.dropColour(K, cv, rng), cv);
  assert.equal(slSnake.dropColour(K, 19, rng), 5); // measured { 5: 1879 }
  assert.equal(slSnake.dropColour(K, 30, rng), 1); // measured { 1: 527 }
  assert.equal(slSnake.dropColour(K, 17, rng), 8); // pattern { 8: 1 }
  assert.equal(slSnake.dropColour(K, 66, rng), 3); // not in the table: 66 mod 9
  const { createRng } = require('../server/ag/agRng');
  const r = createRng(99);
  const counts = {};
  for (let i = 0; i < 20000; i++) {
    const c = slSnake.dropColour(K, 20, r); // measured { 0: 160, 3: 162 }
    counts[c] = (counts[c] || 0) + 1;
  }
  assert.deepEqual(Object.keys(counts).sort(), ['0', '3']);
  near(counts[0] / 20000, 160 / 322, 0.02, 'weight of colour 0');
});

// ------------------------------------------------------------------ max speed, hold, determinism

test('slSim L7: one point per update at the most, at nsp3, for 3000 updates', () => {
  const { sim, s } = sim1({ sct: 60, fam: 0.9 });
  sim.setInput(s.id, { type: 'boost', on: true }, 43);
  let moves = 0;
  for (let i = 0; i < 3000; i++) {
    if (i % 200 === 0) sim.feed(s.id, 255);
    const rec = tickWith(sim).updates[0];
    assert.ok(rec.moves <= 1);
    moves += rec.moves;
  }
  assert.equal(s.sp, 14);
  assert.equal(s.boosting, true);
  // travel 14 x 42.67 / 32 per update: 3000 updates add floor(3000 x 18.668... / 42) points, less the ramp
  assert.ok(moves > 1300 && moves <= Math.floor(3000 * 14 * 42.67 / 32 / 42));
  assert.equal(sim.grid.check().length, 0);
  let pts = 0;
  sim.forEachSnake((x) => { pts += x.pts.length; });
  assert.equal(sim.grid.pointTotal(), pts);
});

test('slSim hold: steering locked to the current ang byte, inputs stored to release, no boost, speed x mult', () => {
  const { sim, s } = sim1({ sct: 10, fam: 0.5, ang: 1.0 });
  sim.setInput(s.id, { type: 'boost', on: true }, 43);
  for (let i = 0; i < 5; i++) tickWith(sim);
  assert.equal(s.boosting, true);
  sim.setHold(s.id, 0.7333, 21); // the hold start ends the boost like a 254 read 21 ms before the next update
  assert.equal(s.wang, Math.floor(1.0 * 256 / PI2) * PI2 / 256); // L48.angRound floor
  assert.equal(s.boosting, true, 'the boost ends in the update, at the hold start time (task T14b)');
  const spCore = s.spCore;
  sim.setInput(s.id, { type: 'angle', q: 60 }, 0);
  sim.setInput(s.id, { type: 'boost', on: true }, 0); // arrived after the hold start: refused
  tickWith(sim);
  assert.equal(s.boosting, false, 'no boosting while holding (C_HOLD_BOOST)');
  assert.equal(s.ang, s.wang, 'locked on the byte');
  assert.ok(s.spCore < spCore, 'the boost ramp goes on down under the hold');
  assert.equal(s.sp, s.spCore * 0.7333);
  sim.setHold(s.id, null);
  assert.equal(s.wang, Math.floor(256 * 60 / 251) * PI2 / 256, 'the stored angle applies at release');
  tickWith(sim);
  assert.equal(s.sp, s.spCore);
});

// Task T14b: the hold start is an event in the update's timeline (C_HOLD_BOOST), in the room's order (inputs, then the
// hold step, then the update): a press that arrived before it starts a boost and pays its charge, then the hold ends it;
// a press that arrived after it is refused.
test('slSim hold: a hold that starts inside the update ends a boost at its own time, after an earlier press', () => {
  const a = sim1({ sct: 10, fam: 0.5 });
  a.sim.setInput(a.s.id, { type: 'boost', on: true }, 40);
  a.sim.applyInputs();
  a.sim.setHold(a.s.id, 0.9, 20);
  a.sim.step();
  assert.equal(a.s.chargeCount, 1, 'the press 40 ms before the update came before the hold (20 ms)');
  assert.equal(a.s.boosting, false, 'the hold ended it');
  const b = sim1({ sct: 10, fam: 0.5 });
  b.sim.setInput(b.s.id, { type: 'boost', on: true }, 10);
  b.sim.applyInputs();
  b.sim.setHold(b.s.id, 0.9, 30);
  b.sim.step();
  assert.equal(b.s.chargeCount, 0, 'the press 10 ms before the update came after the hold (30 ms): refused');
  assert.equal(b.s.boosting, false);
  assert.equal(b.sim.log.boosts.length, 1);
  assert.deepEqual([b.sim.log.boosts[0].on, b.sim.log.boosts[0].ok, b.sim.log.boosts[0].off], [true, false, 10]);
});

function scripted(seed) {
  const sim = createSim(FIXTURE, { seed });
  const ids = [];
  for (let k = 0; k < 6; k++) ids.push(sim.spawn({ x: C + 400 * k, y: C - 300 * k, cv: k * 7, sct: 2 + k * 9, fam: k * 0.31 }).id);
  const r = require('../server/ag/agRng').createRng(seed ^ 0x5eed);
  const logs = [];
  for (let t = 0; t < 600; t++) {
    for (const id of ids) {
      const u = r.next();
      if (u < 0.1) sim.setInput(id, { type: 'angle', q: r.int(251) }, r.int(43));
      else if (u < 0.13) sim.setInput(id, { type: 'boost', on: r.next() < 0.6 }, r.int(43));
      else if (u < 0.16) sim.setInput(id, { type: 'turn', dir: r.next() < 0.5 ? 'left' : 'right', v: r.int(20) }, r.int(43));
      else if (u < 0.2) sim.feed(id, 20 + r.int(40));
    }
    if (t === 200) sim.setHold(ids[1], 0.5, 3);
    if (t === 290) sim.setHold(ids[1], null);
    const log = tickWith(sim);
    logs.push(log.updates.map((x) => [x.id, x.h, x.tails.length, x.moves, x.xx, x.yy].join(',')).join(';') + '|' +
      log.drops.map((d) => [d.id, d.x, d.y, d.b, d.cv].join(',')).join(';'));
  }
  return { digest: sim.digest(), logs, sim };
}

test('slSim determinism: same seed and inputs give the same digest and logs twice; another seed differs', () => {
  const a = scripted(4242);
  const b = scripted(4242);
  assert.equal(a.digest, b.digest);
  assert.equal(a.logs.length, b.logs.length);
  for (let i = 0; i < a.logs.length; i++) assert.ok(a.logs[i] === b.logs[i], 'tick ' + i + ' log differs');
  const c = scripted(4243);
  assert.notEqual(a.digest, c.digest);
  assert.equal(a.sim.grid.check().length, 0);
  // the run exercised boosts with drops and tail losses
  assert.ok(a.logs.some((l) => /\|\d/.test(l)), 'some tick has a boost drop');
});

test('slSim: remove takes every point out of the grid; ids are never 0 and never a live one', () => {
  const sim = createSim(FIXTURE, { seed: 3 });
  const a = sim.spawn({ x: C, y: C, cv: 1, sct: 12 });
  const b = sim.spawn({ x: C + 900, y: C, cv: 2 });
  assert.ok(a.id > 0 && b.id > 0 && a.id !== b.id);
  assert.equal(sim.grid.pointTotal(), 14);
  assert.equal(sim.remove(a.id), true);
  assert.equal(sim.grid.pointTotal(), 2);
  assert.equal(sim.snake(a.id), null);
  assert.equal(sim.count(), 1);
  assert.equal(sim.setInput(a.id, { type: 'ping' }, 0), false);
  const blocked = createSim(FIXTURE, { seed: 3, idBlocked: (id) => id < 5 });
  assert.equal(blocked.spawn({ x: C, y: C, cv: 0 }).id, 5);
});
