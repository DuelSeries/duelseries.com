'use strict';
// agHud (build brief 9.2 "agHud.js", client-hud sections 4, 5 and 10): score and message panels, dim layer, the
// invisible arrow block, low-FPS warning. The leaderboard is the shared DOM board now (agScreens.createBoard,
// test/agScreens.test.js), so the HUD draws none.
// A fake 2D context records calls the way the replay harness does (method calls, property
// writes and canvas size writes, in order).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const H = require(path.join(__dirname, '..', 'public', 'js', 'ag', 'agHud.js'));

// --- fake canvas recorder ---------------------------------------------------------------
function makeRecorder(measure) {
  const log = [];
  let n = 0;
  const PROPS = ['font', 'fillStyle', 'strokeStyle', 'globalAlpha', 'lineWidth', 'lineCap', 'lineJoin', 'textBaseline'];
  const METHODS = ['save', 'restore', 'scale', 'translate', 'rotate', 'fillRect', 'clearRect', 'beginPath', 'closePath',
    'moveTo', 'lineTo', 'arcTo', 'fill', 'stroke', 'fillText', 'strokeText', 'drawImage'];
  const ser = (v) => (v && v.__canvas ? '<canvas ' + v.width + 'x' + v.height + '>' : v);
  function createContext(w, h) {
    const id = 'c' + (n++);
    const canvas = { __canvas: true, id, _w: w || 300, _h: h || 150 };
    Object.defineProperty(canvas, 'width', { get() { return this._w; }, set(v) { log.push([id, '=canvas.width', v]); this._w = v; } });
    Object.defineProperty(canvas, 'height', { get() { return this._h; }, set(v) { log.push([id, '=canvas.height', v]); this._h = v; } });
    const ctx = { canvas, _p: {} };
    for (const p of PROPS) {
      Object.defineProperty(ctx, p, { get() { return this._p[p]; }, set(v) { log.push([id, '=' + p, v]); this._p[p] = v; } });
    }
    for (const m of METHODS) ctx[m] = (...a) => { log.push([id, m, ...a.map(ser)]); };
    ctx.measureText = (t) => { log.push([id, 'measureText', t]); return { width: measure(ctx._p.font, t) }; };
    canvas.getContext = () => ctx;
    return ctx;
  }
  return { log, createContext };
}
// Deterministic text width: 0.55 em per character.
const fakeMeasure = (font, t) => parseInt(font, 10) * 0.55 * t.length;

function setup(W, Hh, opts) {
  const rec = makeRecorder(fakeMeasure);
  const main = rec.createContext(W, Hh);
  const hud = H.createHud(Object.assign({ createContext: () => rec.createContext() }, opts || {}));
  hud.frameStart(W, Hh);
  return { rec, main, hud };
}
const mainCalls = (rec, main) => rec.log.filter((c) => c[0] === main.canvas.id);
const baseState = (over) => Object.assign({ mode: 0, state: 0, spectating: false, connected: true, ownCount: 1,
  fadeout: false, highestMass: 0, camX: 0, camY: 0, target: null }, over || {});

// --- no board on the canvas (Owen 2026-10-16: the shared board) ------------------------------------------------
test('the HUD draws no leaderboard: no board cache, no blit, no board API', () => {
  const { rec, main, hud } = setup(1920, 1080);
  for (const k of ['setBoard', 'lbCtx', 'lbEntries', 'lbHasContent', 'setLocalNick']) assert.strictEqual(hud[k], undefined, k);
  for (const k of ['layoutLeaderboard', 'fitRow']) assert.strictEqual(H[k], undefined, k);
  assert.strictEqual(H.TEXT.title, undefined);
  rec.log.length = 0;
  hud.render(main, baseState({ highestMass: 20 }));
  const m = mainCalls(rec, main).map((c) => c[1]);
  assert.ok(m.indexOf('drawImage') > m.indexOf('arcTo'), 'the first image is the score text, inside its panel');
  assert.ok(!rec.log.some((c) => c[1] === 'fillText' && c[2] === 'Leaderboard'));
});

test('frameStart reports a size change and draws nothing', () => {
  const { rec, hud } = setup(1920, 1080);
  const n = rec.log.length;
  assert.strictEqual(hud.frameStart(1920, 1080), false);
  assert.strictEqual(hud.frameStart(1366, 678), true);
  assert.strictEqual(rec.log.length, n, 'no canvas writes');
  assert.deepStrictEqual([hud.W, hud.H], [1366, 678]);
});

// --- score panel ------------------------------------------------------------------------------
function scoreCalls(W, Hh, mass) {
  const { rec, main, hud } = setup(W, Hh);
  hud.render(main, baseState({ highestMass: mass }));
  return { calls: rec.log, main, hud };
}

test('score panel at 1920x990: font 22, box height 31, box y 944, radius 7', () => {
  const { calls, main } = scoreCalls(1920, 990, 123.9);
  const m = calls.filter((c) => c[0] === main.canvas.id).map((c) => c.slice(1));
  const i = m.findIndex((c) => c[0] === '=globalAlpha' && c[1] === 0.3);
  assert.ok(i >= 0);
  const fs = 22, pad = 2 * 0.2 * fs;
  const w = Math.trunc(pad + pad + fs * fakeMeasure('100px', 'Score: 123') / 100);
  assert.deepStrictEqual(m.slice(i, i + 11), [
    ['=globalAlpha', 0.3], ['=fillStyle', 'rgb(0,0,0)'], ['beginPath'],
    ['moveTo', 15 + 7, 944], ['arcTo', 15 + w, 944, 15 + w, 944 + 31, 7], ['arcTo', 15 + w, 975, 15, 975, 7],
    ['arcTo', 15, 975, 15, 944, 7], ['arcTo', 15, 944, 15 + w, 944, 7], ['fill'], ['closePath'], ['=globalAlpha', 1]]);
  const fonts = calls.filter((c) => c[1] === '=font').map((c) => c[2]);
  assert.ok(fonts.includes('22px Ubuntu'));
  assert.ok(calls.some((c) => c[1] === 'fillText' && c[2] === 'Score: 123'));
});

test('score panel at 1366x678: font 15, box height 21, box y 642', () => {
  const { calls, main } = scoreCalls(1366, 678, 50);
  const m = calls.filter((c) => c[0] === main.canvas.id);
  const mv = m.find((c) => c[1] === 'moveTo');
  assert.strictEqual(mv[3], 642);
  const arc = m.find((c) => c[1] === 'arcTo');
  assert.strictEqual(arc[5] - mv[3], 21);
  assert.ok(calls.some((c) => c[1] === '=font' && c[2] === '15px Ubuntu'));
});

test('score panel creation: template measure, then two fresh canvases sized 300x150 (client-hud 4.3)', () => {
  const { calls, main, hud } = scoreCalls(1280, 630, 16);
  const labelId = hud.arrowLabel.ctx.canvas.id;
  const off = calls.filter((c) => c[0] !== main.canvas.id && c[0] !== labelId);
  assert.deepStrictEqual(off.slice(0, 6).map((c) => c.slice(1)), [
    ['=font', '100px Ubuntu'], ['measureText', 'Score: 16'],
    ['=canvas.width', 300], ['=canvas.height', 150], ['=canvas.width', 300], ['=canvas.height', 150]]);
  assert.notStrictEqual(off[0][0], off[2][0]);
  assert.notStrictEqual(off[2][0], off[4][0]);
  // the kept line renders with outline ratio 0.2 (lineWidth = 14 * 0.2) and text at x = trunc(2 * 0.2 * 14)
  const r = off.slice(6).map((c) => c.slice(1));
  assert.deepStrictEqual(r.slice(0, 2), [['=font', '14px Ubuntu'], ['measureText', 'Score: 16']]);
  assert.ok(r.some((c) => c[0] === '=lineWidth' && Math.abs(c[1] - 2.8) < 1e-12));
  assert.deepStrictEqual(r[r.length - 1], ['fillText', 'Score: 16', 5, 9]);
  assert.ok(!r.some((c) => c[0] === 'strokeText'));
  const m = calls.filter((c) => c[0] === main.canvas.id);
  const di = m.find((c) => c[1] === 'drawImage' && c.length === 11);
  assert.deepStrictEqual(di.slice(3, 11), [0, 0, di[5], 19, 15, 596, di[5], 19]);
});

test('score: hidden while spectating, at 0, and outside state 0; text changes re-measure only once', () => {
  const { rec, main, hud } = setup(1920, 1080);
  hud.render(main, baseState({ highestMass: 0 }));
  assert.ok(!rec.log.some((c) => c[1] === 'fillText' && /Score/.test(c[2])));
  hud.render(main, baseState({ highestMass: 50, spectating: true, state: 8 }));
  assert.ok(!rec.log.some((c) => c[1] === 'fillText' && /Score/.test(c[2])));
  hud.render(main, baseState({ highestMass: 50 }));
  rec.log.length = 0;
  hud.render(main, baseState({ highestMass: 50 }));
  assert.ok(!rec.log.some((c) => c[1] === 'measureText'));
  hud.render(main, baseState({ highestMass: 51.7 }));
  assert.strictEqual(rec.log.filter((c) => c[1] === 'measureText' && c[2] === 'Score: 51').length, 2);
});

// --- spectate hint ------------------------------------------------------------------------
test('spectating at 1920x1080: hint box 700 x 70 at (610, 995), radius 8, alpha 0.3', () => {
  const { rec, main, hud } = setup(1920, 1080);
  hud.render(main, baseState({ state: 8, spectating: true, ownCount: 0 }));
  const m = mainCalls(rec, main).map((c) => c.slice(1));
  const i = m.findIndex((c) => c[0] === '=globalAlpha' && c[1] === 0.3);
  assert.deepStrictEqual(m.slice(i, i + 5), [['=globalAlpha', 0.3], ['=fillStyle', 'rgb(0,0,0)'], ['beginPath'],
    ['moveTo', 618, 995], ['arcTo', 1310, 995, 1310, 1065, 8]]);
  assert.ok(rec.log.some((c) => c[1] === 'fillText' && c[2] === "Press 'Q' to change Spectate Mode"));
  // the text image is centred on the box
  const di = m.find((c) => c[0] === 'drawImage' && c.length === 10);
  const dw = di[8];
  assert.strictEqual(di[6], 960 + dw * -0.5);
});

// --- dim layer ---------------------------------------------------------------------------
test('dim layer: after a death the alpha goes 0 to 0.5 in 60 drawn frames (+1/60 each, fact 2.6)', () => {
  const { rec, main, hud } = setup(1920, 1080);
  for (let i = 0; i < 25; i++) hud.render(main, baseState({ ownCount: 1 }));
  assert.strictEqual(hud.debug().level, 0);
  hud.onDeath();
  const alphas = [];
  for (let f = 1; f <= 61; f++) {
    rec.log.length = 0;
    hud.render(main, baseState({ ownCount: 0 }));
    const m = mainCalls(rec, main);
    const k = m.findIndex((c) => c[1] === 'fillRect');
    alphas.push(m[k - 2][2]);
    assert.deepStrictEqual(m[k].slice(1), ['fillRect', 0, 0, 1920, 1080]);
  }
  for (let f = 1; f < 60; f++) {
    assert.ok(Math.abs(alphas[f - 1] - f / 120) < 1e-12, 'frame ' + f);
    assert.ok(alphas[f - 1] < 0.5);
  }
  assert.strictEqual(alphas[59], 0.5);
  assert.strictEqual(alphas[60], 0.5);
  // without a fresh death a fade-in steps 0.05; alive it fades out 0.05 per frame
  hud.render(main, baseState({ ownCount: 1 }));
  assert.strictEqual(hud.debug().level, 0.95);
  hud.render(main, baseState({ ownCount: 0, fadeout: true }));
  assert.strictEqual(hud.debug().level, 1);
});

test('dim layer: alpha-0 fillRect runs every frame while alive (fact 2.20)', () => {
  const { rec, main, hud } = setup(1280, 630);
  for (let i = 0; i < 30; i++) hud.render(main, baseState());
  rec.log.length = 0;
  hud.render(main, baseState());
  const m = mainCalls(rec, main).map((c) => c.slice(1));
  assert.deepStrictEqual(m.slice(0, 4), [['=globalAlpha', 0], ['=fillStyle', 'rgb(0,0,0)'], ['fillRect', 0, 0, 1280, 630], ['=globalAlpha', 1]]);
});

test('start-up background: cover fit, drawn only before the first play and while fading in', () => {
  const img = { complete: true, width: 2048, height: 1536, __canvas: true };
  const { rec, main, hud } = setup(1280, 630, { menuImage: img });
  hud.render(main, baseState({ connected: false, ownCount: 0 }));
  const m = mainCalls(rec, main).map((c) => c.slice(1));
  assert.deepStrictEqual(m.slice(0, 6), [['=globalAlpha', 1], ['drawImage', '<canvas 2048x1536>', 0, 0, 2048, 1536, 0, -165, 1280, 960],
    ['=globalAlpha', 0.5], ['=fillStyle', 'rgb(0,0,0)'], ['fillRect', 0, 0, 1280, 630], ['=globalAlpha', 1]]);
  hud.onPlay();
  rec.log.length = 0;
  hud.render(main, baseState({ ownCount: 0 }));
  assert.ok(!mainCalls(rec, main).some((c) => c[1] === 'drawImage' && c[2] === '<canvas 2048x1536>'));
});

// --- arrow --------------------------------------------------------------------------------
test('arrow block runs every frame at alpha 0 without a target (golden 1280x630 values)', () => {
  const { rec, main, hud } = setup(1280, 630);
  hud.render(main, baseState());
  rec.log.length = 0;
  hud.render(main, baseState());
  const m = mainCalls(rec, main).map((c) => c.slice(1));
  const s = m.findIndex((c) => c[0] === 'save');
  const blk = m.slice(s);
  assert.deepStrictEqual(blk.slice(0, 6), [['save'], ['=globalAlpha', 0], ['=fillStyle', 'rgb(0,0,0)'],
    ['translate', 1251, 315], ['rotate', 0], ['save']]);
  assert.deepStrictEqual(blk[6], ['rotate', 4.712389]);
  assert.strictEqual(blk[7][0], 'drawImage');
  assert.strictEqual(blk[7].length, 4);
  assert.deepStrictEqual(blk.slice(8), [['restore'], ['scale', 29, 29], ['=lineCap', 'round'], ['=lineJoin', 'round'],
    ['=strokeStyle', 'rgb(255,255,255)'], ['=lineWidth', 0.15], ['beginPath'],
    ['moveTo', -0.4999999999999998, 0.8660254037844388], ['lineTo', -0.5000000000000004, -0.8660254037844384],
    ['lineTo', 1, 0], ['lineTo', -0.4999999999999998, 0.8660254037844388], ['=globalAlpha', 0], ['fill'], ['stroke'], ['restore']]);
  // label: "An unnamed cell", stroked, fitted to trunc(q*200) = 116 px wide
  const lab = hud.arrowLabel;
  assert.strictEqual(lab.text, 'An unnamed cell');
  assert.ok(lab.ctx.canvas.width <= 116);
  assert.ok(rec.log.length > 0);
});

test('arrow with a target eases its alpha toward 0.4 by 0.1 per frame and points at it', () => {
  const { main, hud } = setup(1920, 1080);
  const t = { x: 1000, y: 0, name: 'x' };
  hud.render(main, baseState({ target: t }));
  assert.ok(Math.abs(hud.debug().arrowAlpha - 0.04) < 1e-15);
  assert.strictEqual(hud.debug().arrowAngle, 0);
  hud.render(main, baseState({ target: { x: 0, y: 1000 } }));
  const a = hud.debug().arrowAngle;
  assert.ok(a > 0 && a < 0.1);
});

// --- low-FPS warning ----------------------------------------------------------------------
test('low-FPS warning: shown on the 6th slow second, hidden after 10 more, never again', () => {
  const { rec, main, hud } = setup(1920, 1080);
  hud.onSpawn();
  for (let i = 0; i < 5; i++) { hud.everySecond(10); assert.strictEqual(hud.debug().slowVisible, false); }
  hud.everySecond(19);
  assert.strictEqual(hud.debug().slowVisible, true);
  rec.log.length = 0;
  hud.render(main, baseState({ state: 8, spectating: true }));
  const texts = rec.log.filter((c) => c[1] === 'fillText').map((c) => c[2]);
  assert.ok(texts.includes('Your computer is running slow'));
  assert.ok(!texts.includes("Press 'Q' to change Spectate Mode"));
  for (let i = 0; i < 9; i++) { hud.everySecond(60); assert.strictEqual(hud.debug().slowVisible, true); }
  hud.everySecond(60);
  assert.strictEqual(hud.debug().slowVisible, false);
  for (let i = 0; i < 20; i++) hud.everySecond(5);
  assert.strictEqual(hud.debug().slowVisible, false);
});

test('low-FPS warning needs the player alive; a fast second resets the count', () => {
  const { hud } = setup(1920, 1080);
  for (let i = 0; i < 10; i++) hud.everySecond(5);
  assert.strictEqual(hud.debug().slowVisible, false);
  hud.onSpawn();
  for (let i = 0; i < 5; i++) hud.everySecond(5);
  hud.everySecond(30);
  hud.everySecond(5);
  assert.strictEqual(hud.debug().slowVisible, false);
});

test('frame order: score, dim layer, arrow', () => {
  const { rec, main, hud } = setup(1280, 630);
  hud.render(main, baseState({ highestMass: 20 }));
  rec.log.length = 0;
  hud.render(main, baseState({ highestMass: 20 }));
  const m = mainCalls(rec, main).map((c) => c[1]);
  const iBox = m.indexOf('arcTo');
  const iDim = m.indexOf('fillRect');
  const iArrow = m.indexOf('save');
  assert.ok(iBox >= 0 && iBox < iDim && iDim < iArrow);
});

test('no Math.random, no Date in the HUD', () => {
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'public', 'js', 'ag', 'agHud.js'), 'utf8');
  assert.ok(!/Math\.random|Date\.now|new Date/.test(src));
  assert.ok(!/\bD \d{4,}|\bW \d{5,}|dcmp|\.wat\b/.test(src), 'no reference line citations in shipped files');
});

// Review fix: the whole-client reset on every connect and disconnect (client-camera-input 2) clears the alive flag,
// the low-FPS counters (the warning can show again) and drops the panels.
test('reset: alive, low-FPS counters and panels go back to their start values', () => {
  const { rec, main, hud } = setup(1920, 990);
  hud.onSpawn();
  rec.log.length = 0;
  hud.render(main, baseState({ highestMass: 400 }));
  assert.ok(hud.scorePanel, 'the score panel exists after a frame alive');
  const blitsAlive = mainCalls(rec, main).filter((c) => c[1] === 'drawImage').length;
  for (let i = 0; i < 6; i++) hud.everySecond(5);
  for (let i = 0; i < 11; i++) hud.everySecond(60);
  assert.strictEqual(hud.debug().slowShown, -1, 'used up for the session');
  hud.reset();
  assert.strictEqual(hud.alive, false);
  assert.deepStrictEqual([hud.slowCount, hud.slowShown, hud.slowVisible], [0, 0, false]);
  assert.deepStrictEqual([hud.scorePanel, hud.hintPanel, hud.slowPanel, hud.rebootPanel], [null, null, null, null]);
  // Nothing of the old life draws over the menu: no score box.
  rec.log.length = 0;
  hud.render(main, baseState({ ownCount: 0, highestMass: 0, fadeout: true }));
  const m = mainCalls(rec, main).map((c) => c[1]);
  assert.ok(!m.includes('arcTo'), 'no score panel');
  assert.strictEqual(m.filter((c) => c === 'drawImage').length, blitsAlive - 1, 'no score text (the arrow label block still runs)');
  // The warning can show again after a reconnect.
  hud.onSpawn();
  for (let i = 0; i < 6; i++) hud.everySecond(5);
  assert.strictEqual(hud.debug().slowVisible, true);
});

// Owen 2026-10-08, "size as if the strip were there": the shipped page's canvas is 2560 x 1398 at 1707 x 932 DPR 1.5,
// but the HUD is laid out for the 2560 x 1263 canvas the reference has above its 90 px strip. Only the dim layer covers
// the whole canvas; the score panel (anchored to the canvas bottom) stays where that 1263-high canvas puts it.
test('ghost strip: HUD laid out on the layout height, dim layer over the whole canvas', () => {
  const rec = makeRecorder(fakeMeasure);
  const main = rec.createContext(2560, 1398);
  const hud = H.createHud({ createContext: () => rec.createContext() });
  hud.frameStart(2560, 1263, 1398);
  hud.render(main, baseState({ highestMass: 123.9 }));
  const m = mainCalls(rec, main).map((c) => c.slice(1));
  assert.deepStrictEqual(m.find((c) => c[0] === 'fillRect'), ['fillRect', 0, 0, 2560, 1398]);
  // q = min(1263 / 1080, 2560 / 1920) = 1.1694...: box height trunc(q * 34) = 39, box top 1263 - (15 + 39) = 1209.
  const mv = m.find((c) => c[0] === 'moveTo');
  assert.strictEqual(mv[2], 1209);
  assert.strictEqual(hud.debug().H, 1263);
  // Without a whole-canvas height (the parity harness), the dim layer is the layout height, as before.
  const rec2 = makeRecorder(fakeMeasure);
  const main2 = rec2.createContext(2560, 1263);
  const hud2 = H.createHud({ createContext: () => rec2.createContext() });
  hud2.frameStart(2560, 1263);
  hud2.render(main2, baseState({ highestMass: 123.9 }));
  const m2 = mainCalls(rec2, main2).map((c) => c.slice(1));
  assert.deepStrictEqual(m2.find((c) => c[0] === 'fillRect'), ['fillRect', 0, 0, 2560, 1263]);
  assert.deepStrictEqual(m2.filter((c) => c[0] !== 'fillRect'), m.filter((c) => c[0] !== 'fillRect'), 'every other HUD call is the same');
});
