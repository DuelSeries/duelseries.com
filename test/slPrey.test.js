'use strict';
// slPrey (SERVER-DESIGN 6.4; task T5): prey spawn (L32), per-prey updates on the L33 clock and phase, the flee rule
// (L33.flee) and the rows the T5 fit adds (slPrey PREY_ROWS: L33.form, L33.outward, L33.fleeSp, L33.afterFlee,
// L33.spont, L33.wander, L33.motion, L33.extra, L32.remove), motion between updates as their client predicts, eats.
// Vectors are literals copied from the rows by id (SERVER-LAWS section N; slither-reference recordings/T5-prey-fit.txt).
const test = require('node:test');
const assert = require('node:assert');
const { FIXTURE, makeFixture } = require('./slLawsFixture');
const { LAWS, STATUS, tableFrom } = require('../server/sl/slLaws');
const { streams, createRng } = require('../server/sl/slRng');
const Pr = require('../server/sl/slPrey');
const RC = require('../server/sl/slRecordCache');

const GRD = 32550;
const P = 42.67; // L7
const PERIOD = 337.75; // L33.period
const PASS = 503.92; // L29.period, the spawn pass clock
const PV = 19;
const PI2 = 2 * Math.PI;
const NONE = () => null;

function preyOf(seed, laws) {
  return Pr.createPrey(laws || FIXTURE, { rng: streams(seed).prey });
}

function gap(a, b) {
  let v = (a - b) % PI2;
  if (v < 0) v += PI2;
  if (v > Math.PI) v -= PI2;
  return v;
}

test('prey laws: the FIXTURE rows and the T5 rows, literally', () => {
  const K = Pr.preyLaws(FIXTURE);
  assert.strictEqual(K.grd, 32550);
  assert.strictEqual(K.sectorSize, 300);
  assert.strictEqual(K.mamu2, 0.029);
  assert.strictEqual(K.passMs, 503.92);
  assert.strictEqual(K.spawnPerMin, 0.0193);
  assert.deepStrictEqual(K.radBytes, [30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45]);
  assert.deepStrictEqual(K.radW, [45, 30, 24, 13, 21, 21, 12, 11, 7, 2, 7, 2, 5, 2, 1, 1]);
  assert.deepStrictEqual([K.colourMin, K.colourMax, K.spawnR], [0, 8, 3800]);
  assert.strictEqual(K.periodMs, 337.75);
  assert.deepStrictEqual([K.dist, K.offsetMax, K.restR, K.outR], [300, 0.25, 3800, 6060]);
  assert.deepStrictEqual([K.fleeA, K.fleeB], [2.736829476, 0.590012180]);
  assert.strictEqual(K.pOutward, 0.326);
  assert.deepStrictEqual([K.spontP, K.spontFirstR, K.spontThenR], [0.0045, 11000, 6060]);
  assert.strictEqual(K.wanderTotal, 1328);
  assert.strictEqual(K.removeAtBorder, true);
  assert.strictEqual(K.quarantineMs, 30000);
  assert.deepStrictEqual(Pr.PREY_ROW_IDS, ['L33.form', 'L33.outward', 'L33.fleeSp', 'L33.afterFlee', 'L33.spont',
    'L33.wander', 'L33.motion', 'L33.extra', 'L32.remove']);
});

test('shippable: the five SUGGESTED T5 rows keep prey closed until Owen answers; the law table wins by id', () => {
  assert.deepStrictEqual(Pr.preyNotShippable(LAWS), ['L33.spont (SUGGESTED)', 'L33.wander (SUGGESTED)',
    'L33.motion (SUGGESTED)', 'L33.extra (SUGGESTED)', 'L32.remove (SUGGESTED)']);
  assert.throws(() => Pr.assertPreyShippable(LAWS), /L33\.spont/);
  for (const id of Pr.PREY_ROW_IDS) {
    const r = Pr.PREY_ROWS[id];
    assert.ok([STATUS.RULE, STATUS.MEASURED, STATUS.SUGGESTED].includes(r.status), id);
    assert.ok(/T5-prey-fit/.test(r.source), id + ' cites the fit');
  }
  // a table that carries the five rows APPROVED (as T1 would after Owen's answer) is shippable, and its values win
  const extra = ['L33.spont', 'L33.wander', 'L33.motion', 'L33.extra', 'L32.remove'].map((id) => {
    const r = Pr.PREY_ROWS[id];
    const value = id === 'L33.spont' ? { perUpdate: 0.001, firstSp: 11, thenSp: 6.06 } : r.value;
    return { id, name: r.name, status: STATUS.APPROVED, value, unit: r.unit, source: 'test', approvedAt: '2026-10-10 test' };
  });
  const t = tableFrom(Object.keys(LAWS).map((id) => LAWS[id]).concat(extra));
  assert.deepStrictEqual(Pr.preyNotShippable(t), []);
  assert.strictEqual(Pr.preyLaws(t).spontP, 0.001);
});

test('refuses rows it has not built', () => {
  assert.throws(() => Pr.preyLaws(makeFixture({ 'L33.period': { periodMs: 337.75, phase: 'shared' } })), /phase/);
  assert.throws(() => Pr.preyLaws(makeFixture({ 'L33.flee': Object.assign({}, FIXTURE['L33.flee'].value, { turn: 'mamu' }) })),
    /mamu2/);
  assert.throws(() => Pr.preyLaws(makeFixture({ C_OUTSIDE_FOOD: { naturalInsideOnly: false, outsideStays: true } })),
    /C_OUTSIDE_FOOD/);
  assert.throws(() => Pr.preyLaws(makeFixture({ L32: Object.assign({}, FIXTURE.L32.value, { rule: 'preyNest' }) })),
    /unknown rule|not built/);
});

test('flee speed follows the chaser (L33.fleeSp): 6.153 at 5.79, 10.997 at 14, on the 0.001 step', () => {
  const prey = preyOf(1);
  assert.strictEqual(prey.fleeSpeed(5.79), 6.153);
  assert.strictEqual(prey.fleeSpeed(14), 10.997);
  // a chaser of sct 145 at its L12 normal speed 5.39 + 0.4 (1 + 143 / 106) = 6.329623 (plateau seen: 6.471)
  assert.strictEqual(prey.fleeSpeed(5.39 + 0.4 * (1 + 143 / 106)), 6.471);
  // a chaser mid boost ramp gives a value between (no prey ramp)
  assert.strictEqual(prey.fleeSpeed(10), 8.637);
});

test('every prey speed goes on the wire as its exact raw (u16 / 1000)', () => {
  const prey = preyOf(13);
  const cache = RC.createRecordCache(PV);
  prey.beginTick();
  prey.step(0, 31899, NONE);
  let n = 0;
  for (let s = 5.79; s <= 14.0001; s += 0.0137) {
    const v = prey.fleeSpeed(s);
    const r = Math.round((2.736829476 + 0.590012180 * s) * 1000);
    assert.strictEqual(v, r / 1000);
    const p = prey.spawnAt(GRD + n, GRD);
    p.spR = r;
    p.sp = v;
    const ev = prey.addEvent(p);
    const back = RC.scanBundle(RC.bundleBytes([cache.recordBytes(ev, false)])).events[0];
    assert.strictEqual(Math.round(back.sp * 1000), r);
    assert.strictEqual(back.sp, r / 1000);
    n++;
  }
  assert.ok(n > 500);
});

test('dir in their sense: 2 turns ang up, 1 down, 0 when there (game.js:4995-5017)', () => {
  assert.strictEqual(Pr.dirOf(1, 1.5), 2);
  assert.strictEqual(Pr.dirOf(1.5, 1), 1);
  assert.strictEqual(Pr.dirOf(0.1, 6.2), 1);
  assert.strictEqual(Pr.dirOf(6.2, 0.1), 2);
  assert.strictEqual(Pr.dirOf(1, 1), 0);
});

test('per-prey L33 phase: each prey updates on its own phase, one period apart, at the first tick at or after due', () => {
  const prey = preyOf(2);
  prey.beginTick();
  prey.step(0, 31899, NONE);
  const ps = [];
  for (let i = 0; i < 12; i++) ps.push(prey.spawnAt(GRD + i * 20, GRD - i * 15));
  const due0 = ps.map((p) => p.due);
  for (const d of due0) assert.ok(d >= 0 && d < PERIOD);
  assert.strictEqual(new Set(due0).size, 12, 'phases differ');
  const times = new Map(ps.map((p) => [p.id, []]));
  const T = Math.ceil(30000 / P);
  let all = 0;
  for (let k = 1; k <= T; k++) {
    prey.beginTick();
    prey.step(k * P, 31899, NONE);
    all += prey.tick.moves.length;
    for (const ev of prey.tick.moves) if (times.has(ev.id)) times.get(ev.id).push(k); // the pass spawns others
  }
  for (const p of ps) {
    const ks = times.get(p.id);
    const d0 = due0[ps.indexOf(p)];
    assert.ok(ks.length >= 87 && ks.length <= 89, 'updates ' + ks.length);
    for (let j = 0; j < ks.length; j++) {
      const due = d0 + j * PERIOD;
      assert.ok(ks[j] * P >= due - 1e-6 && (ks[j] - 1) * P < due + 1e-6, 'prey ' + p.id + ' update ' + j);
    }
  }
  assert.strictEqual(prey.stats().updates, all);
});

test('record form (L33.form): dir, ang and wang on every j; sp only when it changed since the last j', () => {
  const prey = preyOf(3);
  prey.beginTick();
  prey.step(0, 31899, NONE);
  const ps = [];
  for (let i = 0; i < 40; i++) ps.push(prey.spawnAt(GRD + (i % 8) * 400, GRD + Math.floor(i / 8) * 400));
  const lastSp = new Map(ps.map((p) => [p.id, p.sp]));
  let withSp = 0;
  let n = 0;
  // a chaser that comes and goes, and changes speed, so speeds change often
  const chaser = { x: GRD, y: GRD, sp: 5.79 };
  for (let k = 1; k <= 6000; k++) {
    chaser.x = GRD + 1600 * Math.cos(k / 90);
    chaser.y = GRD + 1000 + 900 * Math.sin(k / 70);
    chaser.sp = k % 400 < 120 ? 14 : 5.79;
    prey.beginTick();
    prey.step(k * P, 31899, (x, y, d) => ((x - chaser.x) ** 2 + (y - chaser.y) ** 2 <= d * d ? chaser : null));
    for (const p of prey.tick.adds) lastSp.set(p.id, p.sp); // spawned by the pass
    for (const ev of prey.tick.moves) {
      n++;
      assert.ok(ev.dir === 0 || ev.dir === 1 || ev.dir === 2);
      assert.strictEqual(typeof ev.ang, 'number');
      assert.strictEqual(typeof ev.wang, 'number');
      const p = prey.get(ev.id);
      if ('sp' in ev) {
        withSp++;
        assert.notStrictEqual(Math.round(ev.sp * 1000), Math.round(lastSp.get(ev.id) * 1000), 'sp sent unchanged');
        lastSp.set(ev.id, p.sp);
      } else {
        assert.strictEqual(p.sp, lastSp.get(ev.id), 'sp changed but not sent');
      }
    }
  }
  assert.ok(n > 1000 && withSp > 50, 'updates ' + n + ', with sp ' + withSp);
});

test('flee (L33.flee): away from the nearest head plus a uniform offset up to 0.25 rad, at the chaser speed', () => {
  const prey = preyOf(4);
  prey.beginTick();
  prey.step(0, 31899, NONE);
  const ps = [];
  for (let i = 0; i < 200; i++) ps.push(prey.spawnAt(GRD + 5000 + (i % 20) * 600, GRD + Math.floor(i / 20) * 600));
  const offs = [];
  const heads = new Map(); // each prey's own fixed chaser, 200 units to its left (inside L33.flee dist 300)
  for (const p of ps) heads.set(p.id, { x: p.x - 200, y: p.y, sp: p.id % 2 ? 14 : 5.79 });
  let checked = 0;
  for (let k = 1; k <= 10; k++) {
    prey.beginTick();
    prey.step(k * P, 31899, (x, y, d) => {
      for (const p of ps) if (p.x === x && p.y === y) return heads.get(p.id);
      return null;
    });
    for (const ev of prey.tick.moves) {
      const p = prey.get(ev.id);
      const h = heads.get(ev.id);
      const away = Math.atan2(p.y - h.y, p.x - h.x);
      const off = gap(p.wang, away);
      assert.ok(Math.abs(off) <= 0.25 + 1e-12, 'offset ' + off);
      offs.push(off);
      assert.strictEqual(p.sp, h.sp === 14 ? 10.997 : 6.153);
      assert.strictEqual(p.mode, Pr.MODES.FLEE);
      assert.strictEqual(ev.dir, Pr.dirOf(p.ang, p.wang));
      checked++;
    }
  }
  assert.ok(checked >= 200, 'checked ' + checked);
  assert.ok(Math.min(...offs) < -0.22 && Math.max(...offs) > 0.22, 'offsets span the uniform range');
  const mean = offs.reduce((a, b) => a + b, 0) / offs.length;
  assert.ok(Math.abs(mean) < 0.03, 'offset mean ' + mean);
});

test('after a flee (L33.afterFlee): outward with the measured share, exactly away from the centre, kept until a threat', () => {
  const prey = preyOf(5);
  prey.beginTick();
  prey.step(0, 31899, NONE);
  const ps = [];
  for (let i = 0; i < 1500; i++) ps.push(prey.spawnAt(GRD + 3000 + (i % 50) * 120, GRD - 3000 + Math.floor(i / 50) * 120));
  // one update with a threat at each prey, then none
  let k = 0;
  const firstDone = new Set();
  while (firstDone.size < ps.length) {
    k++;
    prey.beginTick();
    prey.step(k * P, 31899, (x, y) => ({ x: x - 100, y, sp: 5.79 }));
    for (const ev of prey.tick.moves) firstDone.add(ev.id);
  }
  const after = new Map();
  const outwardRuns = new Map();
  for (let j = 0; j < 80; j++) {
    k++;
    prey.beginTick();
    prey.step(k * P, 31899, NONE);
    for (const ev of prey.tick.moves) {
      const p = prey.get(ev.id);
      if (!after.has(ev.id)) after.set(ev.id, p.mode);
      if (p.mode === Pr.MODES.OUT) {
        assert.ok(Math.abs(gap(p.wang, Math.atan2(p.y - GRD, p.x - GRD))) < 1e-12, 'outward exactly');
        if (after.get(ev.id) === Pr.MODES.OUT) outwardRuns.set(ev.id, (outwardRuns.get(ev.id) || 0) + 1);
        if (!p.burst) assert.ok(p.sp === 6.06 || p.sp === 11, 'outward sp ' + p.sp);
      }
    }
  }
  const modes = [...after.values()];
  const share = modes.filter((m) => m === Pr.MODES.OUT).length / modes.length;
  assert.ok(Math.abs(share - 0.326) < 0.04, 'outward share ' + share);
  assert.ok(modes.every((m) => m === Pr.MODES.OUT || m === Pr.MODES.REST));
  // an outward prey stays outward with no threat (while it is inside the border)
  for (const [id, m] of after) {
    if (m !== Pr.MODES.OUT) continue;
    const p = prey.get(id);
    if (p) assert.strictEqual(p.mode, Pr.MODES.OUT);
  }
  assert.ok(outwardRuns.size > 100);
});

test('rest (L33.spont, L33.wander): rare outward turns at 11.0 then 6.06; wander steps from the histogram', () => {
  const prey = preyOf(6);
  prey.beginTick();
  prey.step(0, 31899, NONE);
  for (let i = 0; i < 400; i++) prey.spawnAt(GRD + (i % 20) * 300 - 3000, GRD + Math.floor(i / 20) * 300 - 3000);
  const prev = new Map();
  let restUpdates = 0;
  let turned = 0;
  const steps = [];
  for (let k = 1; k <= 8000; k++) {
    prey.beginTick();
    const before = new Map();
    prey.forEachPrey((p) => before.set(p.id, { mode: p.mode, wang: p.wang, sp: p.sp, burst: p.burst }));
    prey.step(k * P, 31899, NONE);
    for (const ev of prey.tick.moves) {
      const b = before.get(ev.id);
      const p = prey.get(ev.id);
      if (!b || !p) continue;
      if (b.mode === Pr.MODES.REST) {
        restUpdates++;
        if (p.mode === Pr.MODES.OUT) {
          turned++;
          assert.strictEqual(p.sp, 11);
          assert.strictEqual(ev.sp, 11);
        } else {
          assert.strictEqual(p.sp, 3.8);
          const d = gap(p.wang, b.wang);
          assert.ok(Math.abs(d) <= 0.31 + 1e-12, 'wander step ' + d);
          steps.push(d);
        }
      } else if (b.mode === Pr.MODES.OUT && b.burst) {
        assert.strictEqual(p.sp, 6.06, 'second outward update at 6.06');
      }
      prev.set(ev.id, p.mode);
    }
  }
  const rate = turned / restUpdates;
  assert.ok(rate > 0.0025 && rate < 0.0065, 'outward turns per rest update ' + rate);
  // the measured histogram: p50 near 0, about 16.6 percent inside +-0.01 (226 of 1328), tails to 0.31
  const inner = steps.filter((d) => Math.abs(d) < 0.01).length / steps.length;
  assert.ok(Math.abs(inner - 226 / 1328) < 0.015, 'centre bin share ' + inner);
  const wide = steps.filter((d) => Math.abs(d) > 0.21).length / steps.length;
  assert.ok(Math.abs(wide - 39 / 1328) < 0.01, 'tail share ' + wide);
});

test('motion between updates is their client prediction exactly (game.js:4972-5019)', () => {
  const prey = preyOf(7);
  prey.beginTick();
  prey.step(0, 31899, NONE);
  const p = prey.spawnAt(GRD + 1000, GRD + 1000);
  p.due = 1e12; // no update during the check: only motion
  p.wang = 1.234;
  p.ang = 5.9;
  p.dir = Pr.dirOf(p.ang, p.wang);
  p.sp = 6.153;
  // the client loop, one call per step of dt ms (mamu2 0.029 per 8 ms, sp / 4 per 8 ms)
  const c = { x: p.x, y: p.y, ang: p.ang, wang: p.wang, dir: p.dir, sp: p.sp };
  for (let k = 1; k <= 300; k++) {
    const dt = k * P - (k - 1) * P; // the module's own step: now - last
    const mang = 0.029 * (dt / 8);
    const csp = c.sp * (dt / 8) / 4;
    if (c.dir == 1) {
      c.ang -= mang;
      if (c.ang < 0 || c.ang >= PI2) c.ang %= PI2;
      if (c.ang < 0) c.ang += PI2;
      let v = (c.wang - c.ang) % PI2;
      if (v < 0) v += PI2;
      if (v > Math.PI) v -= PI2;
      if (v > 0) { c.ang = c.wang; c.dir = 0; }
    } else if (c.dir == 2) {
      c.ang += mang;
      if (c.ang < 0 || c.ang >= PI2) c.ang %= PI2;
      if (c.ang < 0) c.ang += PI2;
      let v = (c.wang - c.ang) % PI2;
      if (v < 0) v += PI2;
      if (v > Math.PI) v -= PI2;
      if (v < 0) { c.ang = c.wang; c.dir = 0; }
    } else c.ang = c.wang;
    c.x += Math.cos(c.ang) * csp;
    c.y += Math.sin(c.ang) * csp;
    prey.beginTick();
    prey.step(k * P, 31899, NONE);
    assert.ok(p.x === c.x && p.y === c.y, 'position at step ' + k);
    assert.ok(p.ang === c.ang && p.dir === c.dir, 'heading at step ' + k);
  }
  assert.strictEqual(p.dir, 0);
  assert.strictEqual(p.ang, 1.234);
});

test('spawn (L32): only inside the border, at the measured rate, sizes, colours, speed and heading', () => {
  const prey = preyOf(8);
  const flux = 6264;
  let n = 0;
  const bytes = new Map();
  const cols = new Array(9).fill(0);
  const T = Math.ceil(2 * 3600 * 1000 / P); // two hours of sim
  for (let k = 1; k <= T; k++) {
    prey.beginTick();
    prey.step(k * P, flux, NONE);
    for (const p of prey.tick.adds) {
      n++;
      assert.ok((p.x - GRD) ** 2 + (p.y - GRD) ** 2 <= flux * flux, 'spawned outside the border');
      bytes.set(p.b, (bytes.get(p.b) || 0) + 1);
      cols[p.cv]++;
      assert.strictEqual(p.sp, 3.8);
      assert.strictEqual(p.ang, p.wang);
      assert.strictEqual(p.dir, 0);
      assert.strictEqual(p.rad, p.b / 5);
    }
  }
  // sectors the border touches at 6264: 1457 (row-major count); expected spawns = 1457 x 0.0193 x 120 min, less the
  // share of edge-sector points that fall outside the disc
  const expected = 1457 * 0.0193 * 120;
  assert.ok(n > 0.85 * expected && n < 1.05 * expected, 'spawns ' + n + ' expected about ' + expected);
  for (const b of bytes.keys()) assert.ok(b >= 30 && b <= 45);
  assert.ok(bytes.get(30) > bytes.get(45), 'byte 30 is the most common');
  assert.ok(cols.every((c) => c > 0));
  const st = prey.stats();
  assert.ok(st.passes === Math.floor(T * P / PASS), 'passes ' + st.passes);
  assert.throws(() => Pr.preyLaws(makeFixture({ L32: Object.assign({}, FIXTURE.L32.value, { sp: 3.8004 }) })), /wire step/);
});

test('border (L32.remove): a prey that crosses the border goes with a prey_remove; no live prey outside', () => {
  const prey = preyOf(9);
  prey.beginTick();
  prey.step(0, 3000, NONE);
  const p = prey.spawnAt(GRD + 2900, GRD);
  p.ang = 0;
  p.wang = 0;
  p.dir = 0;
  p.due = 1e12;
  let removedAt = 0;
  for (let k = 1; k <= 200 && !removedAt; k++) {
    prey.beginTick();
    prey.step(k * P, 3000, NONE);
    if (prey.tick.removes.length) {
      assert.deepStrictEqual(prey.tick.removes[0].ev, { type: 'prey_remove', id: p.id });
      removedAt = k;
    }
  }
  // 100 units at 3.8: 3.8 / 32 units per ms, 842 ms, 20 steps
  assert.strictEqual(removedAt, 20);
  assert.strictEqual(prey.get(p.id), null);
  assert.strictEqual(p.alive, false);
});

test('20,000 ticks with moving chasers, eats and a moving border: every prey inside, ids unique, records clean', () => {
  const prey = preyOf(10);
  const t = createRng(77);
  const cache = RC.createRecordCache(PV);
  const chasers = Array.from({ length: 12 }, (_, i) => ({ x: GRD, y: GRD, sp: 5.79, a: i }));
  let flux = 2923;
  let eaten = 0;
  let records = 0;
  for (let k = 1; k <= 20000; k++) {
    if (k % 3000 === 0) flux = flux === 2923 ? 6264 : 2923;
    for (const c of chasers) {
      c.x = GRD + (flux - 200) * 0.7 * Math.cos(k / 300 + c.a);
      c.y = GRD + (flux - 200) * 0.7 * Math.sin(k / 410 + 2 * c.a);
      c.sp = (k + c.a * 50) % 600 < 150 ? 14 : 5.79;
    }
    prey.beginTick();
    // the sim's eat step comes first (SERVER-DESIGN 5.3 step 4), then the prey clock (step 7)
    for (const c of chasers) {
      prey.forEachInDisc(c.x, c.y, 40, (p) => {
        prey.eat(p, 1 + c.a);
        eaten++;
      });
    }
    prey.step(k * P, flux, (x, y, d) => {
      let best = null;
      let bd = d * d;
      for (const c of chasers) {
        const q = (x - c.x) ** 2 + (y - c.y) ** 2;
        if (q <= bd) { bd = q; best = c; }
      }
      return best;
    });
    const evs = [];
    for (const p of prey.tick.adds) evs.push(prey.addEvent(p));
    for (const ev of prey.tick.moves) evs.push(ev);
    for (const r of prey.tick.removes) evs.push(r.ev);
    for (const e of prey.tick.eats) evs.push(e.ev);
    if (evs.length && (k % 50 === 0 || k < 2000)) {
      const scan = RC.scanBundle(RC.bundleBytes(evs.map((e) => cache.recordBytes(e, false))));
      assert.strictEqual(scan.wireError, null);
      assert.deepStrictEqual(scan.kind15, []);
      assert.deepStrictEqual(scan.offGrid, []);
      records += evs.length;
    }
    const ids = new Set();
    prey.forEachPrey((p) => {
      assert.ok(!ids.has(p.id));
      ids.add(p.id);
      assert.ok((p.x - GRD) ** 2 + (p.y - GRD) ** 2 <= flux * flux, 'live prey outside the border');
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.ang));
    });
    cache.clear();
  }
  const st = prey.stats();
  assert.ok(st.spawned > 50 && eaten > 0 && st.removed > 0 && records > 500, JSON.stringify(st) + ' eaten ' + eaten);
  assert.strictEqual(st.eaten, eaten);
  assert.strictEqual(st.spawned - st.eaten - st.removed, prey.count());
});

test('eats: prey_eaten with the eater; ids come back only after the quarantine (C_ID_QUARANTINE_MS 30000)', () => {
  const prey = preyOf(11);
  prey.beginTick();
  prey.step(0, 31899, NONE);
  const a = prey.spawnAt(GRD, GRD);
  assert.strictEqual(a.id, 1);
  assert.deepStrictEqual(prey.eat(a, 9), { type: 'prey_eaten', id: 1, eater: 9 });
  assert.throws(() => prey.eat(a, 9), /not live/);
  assert.throws(() => prey.eat(prey.spawnAt(GRD, GRD), 0), /eater/);
  // fill every other id, so the next spawn must wrap to id 1
  for (let i = 0; i < 65533; i++) prey.spawnAt(GRD + (i % 100), GRD + Math.floor(i / 100) % 100);
  assert.strictEqual(prey.count(), 65534);
  assert.strictEqual(prey.spawnAt(GRD, GRD), null, 'id 1 is quarantined at 0 ms');
  prey.beginTick();
  prey.step(29999, 31899, NONE); // the spawn pass runs here too and finds no free id
  assert.strictEqual(prey.get(1), null);
  assert.strictEqual(prey.spawnAt(GRD, GRD), null, 'still quarantined at 29999 ms');
  prey.beginTick();
  prey.step(30000, 31899, NONE); // the pass may take id 1 first
  const b = prey.get(1) || prey.spawnAt(GRD, GRD);
  assert.ok(b && b.id === 1, 'id 1 back at 30000 ms');
});

test('records: prey_add and prey_move on their wire grid, one add event per prey per tick', () => {
  const prey = preyOf(12);
  prey.beginTick();
  prey.step(0, 31899, NONE);
  const p = prey.spawnAt(32111.13, 32999.99);
  const e1 = prey.addEvent(p);
  assert.strictEqual(prey.addEvent(p), e1);
  assert.deepStrictEqual(Object.keys(e1), ['type', 'id', 'cv', 'xx', 'yy', 'rad', 'dir', 'wang', 'ang', 'sp']);
  assert.strictEqual(e1.sp, 3.8);
  assert.strictEqual(e1.xx, Math.round(5 * 32111.13) / 5);
  prey.beginTick();
  prey.step(P, 31899, NONE);
  assert.notStrictEqual(prey.addEvent(p), e1, 'a new tick, a new add event');
  let mv = null;
  for (let k = 2; !mv; k++) {
    prey.beginTick();
    prey.step(k * P, 31899, NONE);
    mv = prey.tick.moves[0] || null;
  }
  assert.strictEqual(mv.xx, 1 + Math.round((p.x - 1) / 3) * 3);
  const cache = RC.createRecordCache(PV);
  const scan = RC.scanBundle(RC.bundleBytes([prey.addEvent(p), mv].map((e) => cache.recordBytes(e, false))));
  assert.strictEqual(scan.wireError, null);
  assert.deepStrictEqual(scan.kind15, []);
  assert.deepStrictEqual(scan.offGrid, []);
});

test('same seed, same calls: same digest; another seed differs', () => {
  const run = (seed) => {
    const prey = preyOf(seed);
    const c = { x: GRD + 500, y: GRD, sp: 14 };
    for (let k = 1; k <= 4000; k++) {
      prey.beginTick();
      c.x = GRD + 1500 * Math.cos(k / 200);
      prey.step(k * P, 2923, (x, y, d) => ((x - c.x) ** 2 + (y - c.y) ** 2 <= d * d ? c : null));
    }
    return prey.digest();
  };
  assert.strictEqual(run(21), run(21));
  assert.notStrictEqual(run(21), run(22));
});
