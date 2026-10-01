'use strict';
// agHud (build brief 9.2 "agHud.js", client-hud sections 4, 5 and 10): leaderboard layout and
// cache, score and message panels, dim layer, the invisible arrow block, low-FPS warning.
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

// --- leaderboard layout: the brief's card numbers ---------------------------------------
test('leaderboard layout at 1920x1080 with 10 rows', () => {
  const L = H.layoutLeaderboard(1920, 1080, 10, 0);
  assert.strictEqual(L.q, 1);
  assert.strictEqual(L.scale, 1.2);
  assert.deepStrictEqual([L.width, L.height], [300, 348]);
  assert.deepStrictEqual([L.x, L.y], [1605, 15]);
  assert.strictEqual(L.titleFont, 30);
  assert.strictEqual(L.titleY, 40);
  assert.strictEqual(L.rowFont, 18);
  assert.strictEqual(L.rowX, 15);
  for (let r = 0; r < 10; r++) assert.strictEqual(L.rowY(r), 70 + 22 * r);
});

test('leaderboard layout at 1920x990 and 1366x678', () => {
  const a = H.layoutLeaderboard(1920, 990, 10, 0);
  assert.strictEqual(a.q.toFixed(6), '0.916667');
  assert.deepStrictEqual([a.width, a.height, a.x, a.y], [274, 318, 1633, 13]);
  assert.deepStrictEqual([a.titleFont, a.titleY, a.rowFont, a.rowY(0)], [27, 36, 16, 64]);
  const b = H.layoutLeaderboard(1366, 678, 10, 0);
  assert.deepStrictEqual([b.width, b.height, b.x, b.y], [187, 217, 1170, 9]);
  assert.deepStrictEqual([b.titleFont, b.titleY, b.rowFont, b.rowY(0)], [18, 25, 11, 43]);
  const c = H.layoutLeaderboard(3840, 1980, 10, 0);
  assert.deepStrictEqual([c.width, c.height, c.x, c.y], [549, 637, 3264, 27]);
});

test('leaderboard layout of the golden canvas 1280x630 (4 and 5 rows)', () => {
  assert.deepStrictEqual([H.layoutLeaderboard(1280, 630, 4, 0).width, H.layoutLeaderboard(1280, 630, 4, 0).height], [174, 109]);
  assert.strictEqual(H.layoutLeaderboard(1280, 630, 5, 0).height, 124);
  assert.strictEqual(H.layoutLeaderboard(1280, 630, 4, 0).x, 1098);
});

// --- leaderboard cache rendering -----------------------------------------------------------
test('board render: canvas size, scale 1.2, box, title, rows, own row colour', () => {
  const { rec, hud } = setup(1920, 1080);
  const before = rec.log.length;
  hud.setBoard([{ name: 'alpha' }, { name: 'beta' }, { me: true, name: 'server name ignored' }, { name: '' }], 'owen');
  const calls = rec.log.slice(before);
  const id = hud.lbCtx.canvas.id;
  assert.ok(calls.every((c) => c[0] === id));
  const q = calls.map((c) => c.slice(1));
  assert.deepStrictEqual(q.slice(0, 9), [
    ['=canvas.width', 300], ['=canvas.height', Math.trunc(1.2 * 158)],
    ['scale', 1.2, 1.2], ['=globalAlpha', 0.4], ['=fillStyle', 'rgb(0,0,0)'], ['fillRect', 0, 0, 250, 158],
    ['=globalAlpha', 1], ['=fillStyle', 'rgb(255,255,255)'], ['=font', '30px Ubuntu']]);
  assert.deepStrictEqual(q[9], ['measureText', 'Leaderboard']);
  const tw = fakeMeasure('30px', 'Leaderboard');
  assert.deepStrictEqual(q[10], ['fillText', 'Leaderboard', Math.trunc(125 - tw * 0.5), 40]);
  assert.deepStrictEqual(q.slice(11), [
    ['=fillStyle', 'rgb(255,255,255)'], ['=font', '18px Ubuntu'], ['fillText', '1. alpha', 15, 70],
    ['=fillStyle', 'rgb(255,255,255)'], ['=font', '18px Ubuntu'], ['fillText', '2. beta', 15, 92],
    ['=fillStyle', 'rgb(255,170,170)'], ['=font', '18px Ubuntu'], ['fillText', '3. owen', 15, 114],
    ['=fillStyle', 'rgb(255,255,255)'], ['=font', '18px Ubuntu'], ['fillText', '4. An unnamed cell', 15, 136]]);
});

test('board: an own row past the top 10 is drawn as an extra row with its list position', () => {
  const { rec, hud } = setup(1920, 1080);
  const rows = [];
  for (let i = 0; i < 14; i++) rows.push({ name: 'p' + i });
  rows[12] = { me: true };
  const before = rec.log.length;
  hud.setBoard(rows, 'owen');
  const texts = rec.log.slice(before).filter((c) => c[1] === 'fillText').map((c) => [c[2], c[4]]);
  assert.strictEqual(texts.length, 12);
  assert.deepStrictEqual(texts[10], ['10. p9', 268]);
  assert.deepStrictEqual(texts[11], ['13. owen', 290]);
  const sz = rec.log.slice(before).filter((c) => c[1] === '=canvas.height')[0][2];
  assert.strictEqual(sz, Math.trunc(1.2 * (11 * 22 + 70)));
});

test('board blit: drawn top-right only with content and names on (traps T4, T8)', () => {
  const { rec, main, hud } = setup(1920, 1080);
  hud.render(main, baseState());
  assert.ok(!mainCalls(rec, main).some((c) => c[1] === 'drawImage' && String(c[2]).startsWith('<canvas 300')));
  hud.setBoard([{ name: 'a' }], 'me');
  rec.log.length = 0;
  hud.render(main, baseState());
  const blit = mainCalls(rec, main)[0];
  assert.deepStrictEqual(blit.slice(1), ['drawImage', '<canvas 300x' + Math.trunc(1.2 * 92) + '>', 1920 - (300 + 15), 15]);
  hud.setNames(false);
  rec.log.length = 0;
  hud.render(main, baseState());
  assert.notStrictEqual(mainCalls(rec, main)[0][1], 'drawImage');
  hud.setNames(true);
  hud.setBoard([], 'me');
  rec.log.length = 0;
  hud.render(main, baseState());
  assert.notStrictEqual(mainCalls(rec, main)[0][1], 'drawImage');
});

test('board is re-rendered when the canvas size changes', () => {
  const { rec, hud } = setup(1920, 1080);
  hud.setBoard([{ name: 'a' }], 'me');
  const n = rec.log.length;
  assert.strictEqual(hud.frameStart(1920, 1080), false);
  assert.strictEqual(rec.log.length, n);
  assert.strictEqual(hud.frameStart(1366, 678), true);
  assert.deepStrictEqual(rec.log[n].slice(1), ['=canvas.width', 187]);
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

test('frame order: board blit, score, dim layer, arrow', () => {
  const { rec, main, hud } = setup(1280, 630);
  hud.setBoard([{ name: 'a' }], 'me');
  hud.render(main, baseState({ highestMass: 20 }));
  rec.log.length = 0;
  hud.render(main, baseState({ highestMass: 20 }));
  const m = mainCalls(rec, main).map((c) => c[1]);
  const iBlit = m.indexOf('drawImage');
  const iBox = m.indexOf('arcTo');
  const iDim = m.indexOf('fillRect');
  const iArrow = m.indexOf('save');
  assert.ok(iBlit === 0 && iBlit < iBox && iBox < iDim && iDim < iArrow);
});

test('no Math.random, no Date in the HUD', () => {
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'public', 'js', 'ag', 'agHud.js'), 'utf8');
  assert.ok(!/Math\.random|Date\.now|new Date/.test(src));
  assert.ok(!/\bD \d{4,}|\bW \d{5,}|dcmp|\.wat\b/.test(src), 'no reference line citations in shipped files');
});

// Review fix: the whole-client reset on every connect and disconnect (client-camera-input 2) clears the alive flag,
// the low-FPS counters (the warning can show again), the board list and its content flag, and drops the panels.
test('reset: alive, low-FPS counters, board and panels go back to their start values', () => {
  const { rec, main, hud } = setup(1920, 990);
  hud.onSpawn();
  hud.setBoard([{ name: 'a' }, { me: true }], 'me');
  rec.log.length = 0;
  hud.render(main, baseState({ highestMass: 400 }));
  assert.ok(hud.scorePanel, 'the score panel exists after a frame alive');
  const blitsAlive = mainCalls(rec, main).filter((c) => c[1] === 'drawImage').length;
  for (let i = 0; i < 6; i++) hud.everySecond(5);
  for (let i = 0; i < 11; i++) hud.everySecond(60);
  assert.strictEqual(hud.debug().slowShown, -1, 'used up for the session');
  assert.strictEqual(hud.debug().lbHasContent, true);
  hud.reset();
  assert.strictEqual(hud.alive, false);
  assert.deepStrictEqual([hud.slowCount, hud.slowShown, hud.slowVisible], [0, 0, false]);
  assert.deepStrictEqual(hud.lbEntries, []);
  assert.strictEqual(hud.lbHasContent, false);
  assert.deepStrictEqual([hud.scorePanel, hud.hintPanel, hud.slowPanel, hud.rebootPanel], [null, null, null, null]);
  // Nothing of the old life draws over the menu: no score box, no board blit.
  rec.log.length = 0;
  hud.render(main, baseState({ ownCount: 0, highestMass: 0, fadeout: true }));
  const m = mainCalls(rec, main).map((c) => c[1]);
  assert.ok(!m.includes('arcTo'), 'no score panel');
  assert.strictEqual(m.filter((c) => c === 'drawImage').length, blitsAlive - 2, 'no leaderboard blit and no score text (the arrow label block still runs)');
  // The warning can show again after a reconnect.
  hud.onSpawn();
  for (let i = 0; i < 6; i++) hud.everySecond(5);
  assert.strictEqual(hud.debug().slowVisible, true);
});
