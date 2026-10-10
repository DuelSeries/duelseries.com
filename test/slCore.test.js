'use strict';
// slither.io redo, core card: shared/slCore.js (build brief section 11, spec core-apply.md 2 and 12.1).
// Vectors C1-C7 plus C3b are copied here as literals. They were COMPUTED by running the reference
// client's own code in a vm, so every check is exact (strictEqual, Object.is semantics for numbers).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const C = require('../shared/slCore.js');
const CORE_FILE = path.join(__dirname, '../shared/slCore.js');

// Exact number check that also tells -0 from 0 and accepts NaN === NaN.
function same(actual, expected, label) {
  assert.ok(Object.is(actual, expected), label + ': got ' + actual + ', want ' + expected);
}

const SGSC = .9 * 18 / 14; // the client's start zoom, game.js:1788

test('exports are exactly the brief section 11 names', () => {
  assert.deepStrictEqual(Object.keys(C).sort(), [
    'K64A', 'NSEP', 'PI2', 'SC_MAX', 'SMUC', 'SMUC_M3',
    'buildScoreTables', 'buildSmus', 'chainPull', 'headStep', 'scOf', 'scangOf', 'scoreOf',
    'spangOf', 'sspOf', 'tlOf', 'wsepOf'
  ]);
});

test('constants (spec 2.1)', () => {
  same(C.PI2, 2 * Math.PI, 'PI2');
  same(C.K64A, 2 * Math.PI / 65536, 'K64A');
  same(C.NSEP, 4.5, 'NSEP');
  same(C.SMUC, 100, 'SMUC');
  same(C.SMUC_M3, 97, 'SMUC_M3');
  same(C.SC_MAX, 6, 'SC_MAX');
  same(SGSC, 1.157142857142857, 'sgsc literal');
});

test('C1: sc and scang from sct', () => {
  const rows = [
    [0, 0.9811320754716981, 1.0054803014121276],
    [1, 0.9905660377358491, 1.0027379998813335],
    [2, 1, 1],
    [3, 1.009433962264151, 0.9972663017681264],
    [10, 1.0754716981132075, 0.9782508603298921],
    [50, 1.4528301886792452, 0.8736347454610182],
    [108, 2, 0.7341666666666667],
    [300, 3.811320754716981, 0.3757188204580515],
    [531, 5.990566037735849, 0.15462479233416399],
    [532, 6, 0.15416666666666667],
    [533, 6, 0.15416666666666667],
    [1000, 6, 0.15416666666666667]
  ];
  for (const [sct, sc, scang] of rows) {
    same(C.scOf(sct), sc, 'sc sct ' + sct);
    same(C.scangOf(C.scOf(sct)), scang, 'scang sct ' + sct);
  }
});

test('C2: ssp, fsp, wsep at nsp1 4.25, nsp2 .5', () => {
  const rows = [
    [1, 1.157142857142857, 4.75, 4.85, 6],
    [1, 0.5, 4.75, 4.85, 9],
    [1.5, SGSC, 5, 5.1, 9],
    [6, SGSC, 7.25, 7.35, 36],
    [1, 0.7, 4.75, 4.85, 6.428571428571429]
  ];
  for (const [sc, gsc, ssp, fsp, wsep] of rows) {
    const s = C.sspOf(sc, 4.25, .5);
    same(s, ssp, 'ssp sc ' + sc);
    same(s + .1, fsp, 'fsp sc ' + sc);
    same(C.wsepOf(sc, gsc), wsep, 'wsep sc ' + sc + ' gsc ' + gsc);
  }
});

test('spangOf caps at 1 and has no floor; tlOf caps fam at 1', () => {
  // A2 and A8 values: sp 5.78 and 5 at spangdv 4.8 cap at 1; sp 2 gives 0.41666...
  same(C.spangOf(5.78, 4.8), 1, 'spang 5.78');
  same(C.spangOf(2, 4.8), 0.4166666666666667, 'spang 2');
  same(C.spangOf(0, 4.8), 0, 'spang 0');
  same(C.spangOf(-1, 4.8), -1 / 4.8, 'spang negative passes');
  // A2: sct 8, fam 0.49999997019767584 gives tl 8.499999970197676; A9: fam 1 gives tl 9.
  same(C.tlOf(8, 0.49999997019767584), 8.499999970197676, 'tl A2');
  same(C.tlOf(8, 1), 9, 'tl fam 1');
  same(C.tlOf(8, 1.5), 9, 'tl fam above 1');
  // A2 and A6 sizes go through the same functions.
  same(C.scOf(8), 1.0566037735849056, 'sc A2');
  same(C.scangOf(C.scOf(8)), 0.9836623353506586, 'scang A2');
  same(C.sspOf(C.scOf(8), 4.25, .5), 4.778301886792453, 'ssp A2');
  same(C.wsepOf(C.scOf(8), SGSC), 6.339622641509434, 'wsep A2');
  same(C.wsepOf(C.scOf(9), SGSC), 6.39622641509434, 'wsep A6');
});

test('C3 and C3b: buildSmus', () => {
  const t = C.buildSmus(.43);
  assert.ok(t instanceof Float32Array, 'Float32Array');
  assert.strictEqual(t.length, 100);
  const head = [1, 1, 1, 1, 0.8924999833106995, 0.7850000262260437, 0.6775000095367432,
    0.5699999928474426, 0.5699999928474426];
  for (let i = 0; i < head.length; i++) same(t[i], head[i], 'smus[' + i + ']');
  for (let i = 7; i < 100; i++) same(t[i], 0.5699999928474426, 'smus[' + i + ']');

  const h = C.buildSmus(.5);
  const headB = [1, 1, 1, 1, 0.875, 0.75, 0.625, 0.5, 0.5];
  for (let i = 0; i < headB.length; i++) same(h[i], headB[i], 'cst .5 smus[' + i + ']');
  same(h[96], 0.5, 'cst .5 smus[96]');
  same(h[97], 0.5, 'cst .5 smus[97]');
  same(h[99], 0.5, 'cst .5 smus[99]');

  assert.notStrictEqual(C.buildSmus(.43), t, 'a new array every call');
});

test('C4: buildScoreTables', () => {
  const { fmlts, fpsls } = C.buildScoreTables(411);
  assert.ok(Array.isArray(fmlts) && Array.isArray(fpsls), 'plain arrays');
  assert.strictEqual(fmlts.length, 2460);
  assert.strictEqual(fpsls.length, 2460);
  const idx = [0, 1, 2, 100, 410, 411, 2458];
  const wantM = [1, 0.9945338706539867, 0.989084380964435, 0.534031378659734,
    0.0000013147885120375383, 0.0000013147885120375383, 0.0000013147885120375383];
  const wantP = [0, 1, 2.005496172133805, 136.65462474227044, 349698.9943864127,
    1110277.589989056, 1110277.589989056];
  idx.forEach((i, n) => {
    same(fmlts[i], wantM[n], 'fmlts[' + i + ']');
    same(fpsls[i], wantP[n], 'fpsls[' + i + ']');
  });
  same(fmlts[2459], 0.0000013147885120375383, 'fmlts last');
  same(fpsls[2459], 1110277.589989056, 'fpsls last');

  const b = C.buildScoreTables(300);
  assert.strictEqual(b.fmlts.length, 2349);
  assert.strictEqual(b.fpsls.length, 2349);
  same(b.fmlts[1], 0.9925156206570065, 'mscps 300 fmlts[1]');
  same(b.fpsls[300], 546699.2527919183, 'mscps 300 fpsls[300]');
});

test('C5: scoreOf with mscps 411, then the mscps 0 quirk', () => {
  const { fmlts, fpsls } = C.buildScoreTables(411);
  const rows = [
    [0, 0, -20], [1, 0, -5], [2, 0, 10], [2, .5, 17], [10, 0, 133], [10, .999, 149],
    [20, .25, 300], [100, 0, 2029], [411, 0, 16654143], [411, .5, 22358483],
    [2459, 0, 16654143], [2460, 0, NaN]
  ];
  for (const [sct, fam, want] of rows) same(C.scoreOf(fmlts, fpsls, sct, fam), want, 'score ' + sct + ' ' + fam);

  // Before any init packet the tables are empty: every score is NaN.
  same(C.scoreOf([], [], 10, 0), NaN, 'score with empty tables');

  const z = C.buildScoreTables(0);
  assert.strictEqual(z.fmlts.length, 2049);
  assert.strictEqual(z.fpsls.length, 2049);
  same(z.fmlts[0], undefined, 'mscps 0 fmlts[0]');
  same(z.fmlts[2048], undefined, 'mscps 0 fmlts[2048]');
  same(z.fpsls[0], 0, 'mscps 0 fpsls[0]');
  same(z.fpsls[2048], 0, 'mscps 0 fpsls[2048]');
});

test('C6: headStep from (10012, 10000.5), msl 42', () => {
  const rows = [
    [0, 10054, 10000.5],
    [1, 10053.999999806972, 10000.504026699562],
    [16384, 10012, 10042.5],
    [32768, 9970, 10000.5],
    [49152, 10012, 9958.5],
    [12345, 10027.860414653938, 10039.390194741158],
    [65535, 10053.999999806972, 10000.495973300438]
  ];
  for (const [iang, x, y] of rows) {
    const p = C.headStep(10012, 10000.5, iang, 42);
    same(p[0], x, 'x iang ' + iang);
    same(p[1], y, 'y iang ' + iang);
  }
  // A4 second move: iang 10000 from (10074, 10002) at default_msl 42.
  const q = C.headStep(10074, 10002, 10000, 42);
  same(q[0], 10098.131240912004, 'A4 x');
  same(q[1], 10036.375619442373, 'A4 y');
});

test('C7: chainPull on the SPAWN body after one head step', () => {
  const s = C.buildSmus(.43);
  const pt = (xx, yy, smu) => ({ xx, yy, smu });
  const pts = [
    pt(9960, 10000, s[7]), pt(9965, 10000, s[6]), pt(9970, 10001, s[5]), pt(9975, 10000, s[4]),
    pt(9980, 10000, 1), pt(9985, 10002, 1), pt(9990, 10002, 1), pt(10032, 10002, 1), pt(10074, 10002, 1)
  ];
  const calls = [];
  C.chainPull(pts, .43, s, (p, dx, dy, dsmu) => calls.push([pts.indexOf(p), dx, dy, dsmu]));

  const want = [
    [9963.630767259492, 10000.116418633224, 0.5699999928474426],
    [9968.443644789515, 10000.2707410075, 0.5699999928474426],
    [9973.008476254687, 10000.62963025, 0.6775000095367432],
    [9976.99645640625, 10000.138675, 0.7850000262260437],
    [9981.1905625, 10000.43, 0.8924999833106995],
    [9985.5375, 10002, 1],
    [9990, 10002, 1],
    [10032, 10002, 1],
    [10074, 10002, 1]
  ];
  want.forEach(([x, y, smu], i) => {
    same(pts[i].xx, x, 'pts[' + i + '].xx');
    same(pts[i].yy, y, 'pts[' + i + '].yy');
    same(pts[i].smu, smu, 'pts[' + i + '].smu');
  });

  // Callback order is headward first (index 5 down to 0); dsmu as listed in C7.
  assert.deepStrictEqual(calls.map((c) => c[0]), [5, 4, 3, 2, 1, 0]);
  const wantDsmu = { 5: 0, 4: -0.10750001668930054, 3: -0.10749995708465576, 2: -0.10750001668930054,
    1: -0.10750001668930054, 0: 0 };
  for (const c of calls) same(c[3], wantDsmu[c[0]], 'dsmu pts[' + c[0] + ']');
  // dx, dy are the move each point just made (A5 feeds them to the rings).
  same(calls[0][1], 9985.5375 - 9985, 'dx pts[5]');
  same(calls[0][2], 0, 'dy pts[5]');
  same(calls[5][1], 9963.630767259492 - 9960, 'dx pts[0]');
});

test('chainPull: fewer than 4 points do nothing, no callback needed', () => {
  const s = C.buildSmus(.43);
  const three = [{ xx: 0, yy: 0, smu: .5 }, { xx: 10, yy: 0, smu: .5 }, { xx: 20, yy: 0, smu: .5 }];
  C.chainPull(three, .43, s);
  assert.deepStrictEqual(three.map((p) => [p.xx, p.yy, p.smu]), [[0, 0, .5], [10, 0, .5], [20, 0, .5]]);

  // 4 points: only index 0 moves, toward index 1 at cst / 4, smu from smus[3] (= 1).
  const four = [{ xx: 0, yy: 0, smu: .5 }, { xx: 10, yy: 4, smu: 1 }, { xx: 20, yy: 0, smu: 1 }, { xx: 30, yy: 0, smu: 1 }];
  C.chainPull(four, .43, s);
  same(four[0].xx, 0 + (10 - 0) * (.43 * 1 / 4), 'four[0].xx');
  same(four[0].yy, 0 + (4 - 0) * (.43 * 1 / 4), 'four[0].yy');
  same(four[0].smu, 1, 'four[0].smu');
  same(four[1].xx, 10, 'anchor unchanged');
});

test('chainPull: smus index walks 3..97 then holds; pull strength holds at cst', () => {
  const s = new Float32Array(100);
  for (let i = 0; i < 100; i++) s[i] = i; // index markers to see which entry each point took
  const pts = [];
  for (let i = 0; i < 120; i++) pts.push({ xx: i, yy: 0, smu: -1 });
  C.chainPull(pts, .43, s);
  const k = pts.length - 3; // anchor index 117
  for (let m = k - 1, n2 = 3; m >= 0; m--) {
    same(pts[m].smu, n2, 'smu index at pts[' + m + ']');
    if (n2 < 97) n2++;
  }
  // The 5th pulled point and later use mv = cst exactly.
  // pts[112] started at 112 and its neighbour pts[113] already moved; recompute in order.
  const ref = [];
  for (let i = 0; i < 120; i++) ref.push(i);
  let prev = ref[k];
  let mv = 0;
  for (let m = k - 1, n = 1; m >= 0; m--, n++) {
    if (n <= 4) mv = .43 * n / 4;
    ref[m] += (prev - ref[m]) * mv;
    prev = ref[m];
  }
  for (let i = 0; i < 120; i++) same(pts[i].xx, ref[i], 'xx pts[' + i + ']');
});

test('browser load: attaches DuelSlither.slCore with no module object', () => {
  const src = fs.readFileSync(CORE_FILE, 'utf8');
  const win = {};
  win.window = win;
  vm.runInNewContext(src, win);
  assert.ok(win.DuelSlither && win.DuelSlither.slCore, 'DuelSlither.slCore set');
  assert.deepStrictEqual(Object.keys(win.DuelSlither.slCore).sort(), Object.keys(C).sort());
  same(win.DuelSlither.slCore.scOf(0), 0.9811320754716981, 'browser copy computes the same');
  // Only DuelSlither is added to the window.
  assert.deepStrictEqual(Object.keys(win).sort(), ['DuelSlither', 'window']);
});

test('pure module: no random, no timers, no DOM, nothing from slither-reference', () => {
  const src = fs.readFileSync(CORE_FILE, 'utf8');
  assert.ok(!/Math\.random/.test(src), 'no Math.random');
  assert.ok(!/setTimeout|setInterval|requestAnimationFrame|performance\.now|Date\.now/.test(src), 'no timers or clocks');
  assert.ok(!/document\.|getContext|localStorage/.test(src), 'no DOM');
  assert.ok(!/slither-reference|require\(/.test(src), 'no imports');
  assert.ok(!src.includes(String.fromCharCode(0x2014)), 'no em dashes');
});
