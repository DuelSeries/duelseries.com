'use strict';
// agScreens (build brief 9.1 "agScreens.js", client-hud section 6, fact 2.7): per-life stats,
// the mass graph maths and calls, the death panel values and layout facts.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const S = require(path.join(__dirname, '..', 'public', 'js', 'ag', 'agScreens.js'));

function graphRecorder(w, h) {
  const calls = [];
  const r = (v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v);
  const ctx = { canvas: { width: w, height: h } };
  for (const m of ['clearRect', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'fill']) ctx[m] = (...a) => calls.push([m, ...a.map(r)]);
  for (const p of ['lineWidth', 'lineCap', 'lineJoin', 'strokeStyle', 'fillStyle', 'globalAlpha']) {
    Object.defineProperty(ctx, p, { set(v) { calls.push(['=' + p, r(v)]); } });
  }
  return { ctx, calls };
}
function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}

test('score mass per cell: floor(f32(f32(s*s)/100)) on the packet size', () => {
  assert.strictEqual(S.cellScoreMass(31), 9);
  assert.strictEqual(S.cellScoreMass(32), 10);
  assert.strictEqual(S.cellScoreMass(60), 36);
  assert.strictEqual(S.cellScoreMass(141), 198);
  assert.strictEqual(S.cellScoreMass(45), 20);
  assert.strictEqual(S.cellScoreMass(51), 26);
  assert.strictEqual(S.cellScoreMass(42), 17);
  assert.strictEqual(S.cellScoreMass(64), 40);
});

test('frame bookkeeping: history, highest mass, leaderboard time only while onBoard', () => {
  const st = S.createLifeStats();
  st.spawn(1000, [255, 7, 173]);
  assert.strictEqual(st.frame({ spectating: false, ownSizes: [], dt: 16 }), -1);
  assert.strictEqual(st.frame({ spectating: true, ownSizes: [50], dt: 16 }), -1);
  assert.strictEqual(st.frame({ spectating: false, ownSizes: [51, 42], dt: 16 }), 43);
  assert.strictEqual(st.leaderTime, 0);
  st.applyBoard([{ name: 'a' }]);
  assert.strictEqual(st.onBoard, true);
  assert.strictEqual(st.frame({ spectating: false, ownSizes: [60], dt: 16.5 }), 36);
  assert.strictEqual(st.leaderTime, 16.5);
  assert.strictEqual(st.highestMass, 43);
  assert.deepStrictEqual(st.history, [43, 36]);
});

test('board place: position is the list index of the own row; onBoard is 1 off the list (trap T5)', () => {
  assert.deepStrictEqual(S.boardPlace([]), { position: 0, onBoard: true });
  assert.deepStrictEqual(S.boardPlace([{ name: 'a' }, { me: true }]), { position: 2, onBoard: true });
  const rows = [];
  for (let i = 0; i < 12; i++) rows.push({ name: 'p' + i });
  rows[11] = { me: true };
  assert.deepStrictEqual(S.boardPlace(rows), { position: 12, onBoard: false });
  const st = S.createLifeStats();
  st.applyBoard([{ name: 'a' }, { name: 'b' }, { me: true }]);
  st.applyBoard([{ me: true }]);
  st.applyBoard([{ name: 'a' }, { me: true }]);
  assert.strictEqual(st.topPosition, 1);
});

test('eat stats follow fact 2.7 (food, 0x20 with 0x40, virus, cells)', () => {
  const st = S.createLifeStats();
  const base = { eaterOwn: true, eatenOwn: false, food: false, ejected: false, flag40: false, virus: false };
  const e = (o) => st.eat(Object.assign({}, base, o));
  assert.strictEqual(e({ food: true }), 'food');
  assert.strictEqual(e({ ejected: true, flag40: true }), 'food');
  assert.strictEqual(e({ ejected: true, flag40: false }), null);
  assert.strictEqual(e({ ejected: true, flag40: false, virus: true }), 'virus');
  assert.strictEqual(e({ virus: true }), 'virus');
  assert.strictEqual(e({}), 'cell');
  assert.strictEqual(e({ eatenOwn: true }), null);
  assert.strictEqual(e({ eaterOwn: false }), null);
  assert.deepStrictEqual([st.foodEaten, st.virusesEaten, st.cellsEaten], [2, 2, 1]);
});

test('death: snapshot then a full reset', () => {
  const st = S.createLifeStats();
  st.spawn(500, [1, 2, 3]);
  st.applyBoard([{ me: true }]);
  st.frame({ spectating: false, ownSizes: [45], dt: 10 });
  st.eat({ eaterOwn: true, food: true });
  const snap = st.death(12366.69, [{ me: true }]);
  assert.strictEqual(snap.timeAlive, 12366.69 - 500);
  assert.deepStrictEqual([snap.foodEaten, snap.highestMass, snap.leaderTime, snap.topPosition], [1, 20, 10, 1]);
  assert.deepStrictEqual(snap.rgb, [1, 2, 3]);
  assert.deepStrictEqual([st.foodEaten, st.highestMass, st.leaderTime, st.topPosition, st.history.length, st.onBoard],
    [0, 0, 0, 0, 0, false]);
});

test('formatSeconds and the six panel values', () => {
  assert.strictEqual(S.formatSeconds(0), '0:00');
  assert.strictEqual(S.formatSeconds(-50), '0:00');
  assert.strictEqual(S.formatSeconds(999), '0:00');
  assert.strictEqual(S.formatSeconds(61000), '1:01');
  assert.strictEqual(S.formatSeconds(11866.6904), '0:11');
  assert.strictEqual(S.formatSeconds(600000), '10:00');
  const v = S.statsValues({ foodEaten: 3, highestMass: 43.9, timeAlive: 11866.69, leaderTime: 70000, cellsEaten: 1, topPosition: 0 });
  assert.deepStrictEqual(v, { food: '3', mass: '43', alive: '0:11', board: '1:10', cells: '1', top: ':(' });
  assert.strictEqual(S.statsValues({ foodEaten: 0, highestMass: 0, timeAlive: 0, leaderTime: 0, cellsEaten: 0, topPosition: 6 }).top, '6');
});

test('layout facts of the Match Results panel', () => {
  assert.deepStrictEqual([S.LAYOUT.graph.width, S.LAYOUT.graph.height], [350, 170]);
  assert.deepStrictEqual([S.LAYOUT.stats.width, S.LAYOUT.stats.height], [306, 300]);
  assert.deepStrictEqual(S.STAT_BOXES.map((b) => [b[2], b[3]]),
    [['left', 10], ['right', 10], ['left', 45], ['right', 45], ['left', 80], ['right', 80]]);
  assert.strictEqual(S.LAYOUT.nickMax, 15);
  assert.ok(/#statsGraph\{position:absolute;bottom:100px;left:0;right:0;opacity:0\.4;\}/.test(S.SCREENS_CSS));
  assert.ok(/#statsContinue\{position:absolute;width:306px;bottom:15px;height:34px;/.test(S.SCREENS_CSS));
  assert.strictEqual(S.menuScale(1920, 1080), 1);
  assert.strictEqual(S.menuScale(800, 800), 0.5);
});

test('graph maths: step, window average, scale floor 200', () => {
  assert.strictEqual(S.graphPoints([50], 350, 170), null);
  const g = S.graphPoints([50, 50], 350, 170);
  assert.strictEqual(g.top, 200);
  assert.deepStrictEqual(g.start, [0, 170 - 50 / 200 * 160 + 10]);
  assert.deepStrictEqual(g.points, [[350, 170 - 50 / 200 * 160 + 10]]);
  const h = [];
  for (let i = 0; i < 712; i++) h.push(i < 356 ? 100 : 300);
  const p = S.graphPoints(h, 350, 170);
  assert.strictEqual(p.top, 300);
  assert.strictEqual(p.points.length, 356);
  assert.deepStrictEqual(p.points.slice(0, 3).map((x) => x[0]), [0, 1, 2]);
  assert.strictEqual(p.points[355][0], Math.trunc(711 * 350 / 711));
  // centred at 355 the window 335..375 holds 21 samples of 100 and 20 of 300
  const at = p.points.find((x, i) => 1 + 2 * i === 355);
  const avg = (21 * 100 + 20 * 300) / 41;
  assert.strictEqual(at[1], 170 - avg / 300 * 160 + 10);
});

test('graph with too little history only clears', () => {
  const { ctx, calls } = graphRecorder(350, 170);
  assert.strictEqual(S.drawMassGraph(ctx, [30], [1, 2, 3]), false);
  assert.deepStrictEqual(calls, [['clearRect', 0, 0, 350, 170]]);
});

// The synthetic "full" stream's own-cell history (712 frames, frames 159 to 870, run-length
// encoded [mass, frames]); the reference client drew this graph at the death frame. Our calls
// must equal its 370 recorded calls (numbers rounded to 3 decimals like the harness recorder).
const FULL_HISTORY = [[20, 55], [22, 41], [23, 2], [24, 41], [26, 36], [40, 41], [39, 2], [38, 17], [36, 29], [43, 2],
  [34, 298], [26, 2], [34, 146]];
test('graph calls equal the reference client death frame of the full stream', () => {
  const hist = [];
  for (const [v, n] of FULL_HISTORY) for (let i = 0; i < n; i++) hist.push(v);
  assert.strictEqual(hist.length, 712);
  const { ctx, calls } = graphRecorder(350, 170);
  assert.strictEqual(S.drawMassGraph(ctx, hist, [255, 7, 173]), true);
  assert.strictEqual(calls.length, 370);
  assert.deepStrictEqual(calls.slice(0, 9), [['clearRect', 0, 0, 350, 170], ['=lineWidth', 3], ['=lineCap', 'round'],
    ['=lineJoin', 'round'], ['=strokeStyle', 'rgb(255,7,173)'], ['=fillStyle', 'rgb(255,7,173)'], ['beginPath'],
    ['moveTo', 0, 164], ['lineTo', 0, 164]]);
  assert.deepStrictEqual(calls.slice(-6), [['stroke'], ['=globalAlpha', 0.5], ['lineTo', 350, 170], ['lineTo', 0, 170],
    ['fill'], ['=globalAlpha', 1]]);
  assert.strictEqual(fnv(JSON.stringify(calls)), '777bdf14');
});

test('stats fed the same history reproduce it (f32 pushes, highest 43)', () => {
  const st = S.createLifeStats();
  // sizes that give the run masses: 45->20, 47->22, 48->23, 49->24, 51->26, 64->40, 63->39, 62->38, 60->36, 51+42->43, 59->34, 42+42->34
  const sizesFor = { 20: [45], 22: [47], 23: [48], 24: [49], 26: [51], 40: [64], 39: [63], 38: [62], 36: [60], 43: [51, 42], 34: [59] };
  for (const [v, n] of FULL_HISTORY) for (let i = 0; i < n; i++) st.frame({ ownSizes: sizesFor[v], dt: 16.6667 });
  assert.strictEqual(st.highestMass, 43);
  assert.strictEqual(st.history.length, 712);
});

test('no Math.random, no Date, no reference line citations in agScreens', () => {
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'public', 'js', 'ag', 'agScreens.js'), 'utf8');
  assert.ok(!/Math\.random|Date\.now|new Date/.test(src));
  assert.ok(!/\bD \d{4,}|\bW \d{5,}|dcmp|\.wat\b/.test(src));
});

// Review fix: the whole-client reset on every connect and disconnect zeroes this life's numbers, so the next life
// never starts from the old highest mass, leaderboard time or top position.
test('reset zeroes every per-life number without a death', () => {
  const st = S.createLifeStats();
  st.spawn(500, [1, 2, 3]);
  st.applyBoard([{ me: true }]);
  for (let i = 0; i < 10; i++) st.frame({ spectating: false, ownSizes: [200], dt: 16 });
  st.eat({ eaterOwn: true, food: true });
  st.eat({ eaterOwn: true, virus: true });
  st.eat({ eaterOwn: true });
  assert.strictEqual(st.highestMass, 400);
  st.reset();
  assert.deepStrictEqual([st.spawnTime, st.foodEaten, st.highestMass, st.leaderTime, st.cellsEaten, st.virusesEaten,
    st.topPosition, st.onBoard, st.history.length, st.alive], [0, 0, 0, 0, 0, 0, 0, false, 0, false]);
});

// Review fix (legal line, build brief 4): the name entry is ours. None of the reference menu's own values may come
// back in our stylesheet; the Match Results values (client-hud 6.3) stay.
test('the name entry carries none of the reference menu look; the panel facts stay', () => {
  const css = S.SCREENS_CSS;
  for (const banned of [/#54c800/i, /#a2a2a2/i, /width:243px/, /width:180px/, /line-height:1\.5;/, /#777\b/]) {
    assert.doesNotMatch(css, banned);
  }
  const rule = (sel) => (css.split('\n').find((l) => l.startsWith(sel + '{')) || '');
  assert.match(rule('#ag-play'), /background:#f0a830/);
  assert.match(rule('#ag-nick'), /font-size:16px/);   // 16 px: phones do not zoom into the field
  assert.match(rule('#ag-card'), /background-color:#fff;border-radius:10px;margin:5px 0;width:325px;height:302px;/);
  assert.match(rule('#ag-stats'), /width:306px;height:300px;overflow:hidden/);
  assert.match(rule('.ag-btn-primary'), /background-color:#428bca;border-color:#357ebd/);
});

test('settings defaults are the reference defaults (names, colours on; mass, dark off; Retina)', () => {
  assert.deepStrictEqual(S.SETTINGS_DEFAULTS, { names: true, colors: true, showMass: false, dark: false, quality: 'Retina' });
  assert.deepStrictEqual(S.SETTING_BOXES.map((b) => b[0]), ['names', 'colors', 'showMass', 'dark']);
  assert.deepStrictEqual(S.QUALITY_OPTIONS.map((q) => q[0]), ['Retina', 'High', 'Medium', 'Low', 'VeryLow']);
});
