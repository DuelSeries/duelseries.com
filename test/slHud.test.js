'use strict';
// slHud (build brief section 11 "slHud", spec draw-world-hud.md section 3; vectors DWH 9.9, 9.13-9.17, 9.22, 9.23 and
// core-apply.md A20). Every expected value below is a literal computed by running THEIR code (game.js) in a node vm;
// nothing is read from the reference folder at test time. A fake DOM records every inline style write, every
// innerHTML / textContent write and every canvas call, in order, the way the replay harness logs canvas calls.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'public', 'js', 'sl', 'slHud.js'));
const D = globalThis.DuelSlither;
const H = D.slHud;

const VFR = 16.6667 / 8;   // one 60 Hz frame in 8 ms ticks, the vector input of DWH 9.14

// ---- fake DOM ---------------------------------------------------------------------------------------------------
function makeDom() {
  const writes = [];   // [label, prop, value] for style, innerHTML, textContent, src, className writes
  const calls = [];    // canvas log: [canvasId, method or '=prop' or '=canvas.width', ...args]
  let made = 0;
  const canvasTag = (cv) => '<' + cv.__id + ' ' + cv.width + 'x' + cv.height + '>';
  const ser = (v) => (v && v.__canvas ? canvasTag(v) : v);
  const METHODS = ['save', 'restore', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'fill', 'stroke', 'fillRect',
    'clearRect', 'drawImage'];
  const PROPS = ['fillStyle', 'strokeStyle', 'lineWidth', 'shadowBlur', 'shadowOffsetY', 'shadowColor',
    'globalCompositeOperation', 'globalAlpha'];

  function makeStyle(label) {
    return new Proxy({}, {
      set(t, k, v) { writes.push([label, k, v]); t[k] = v; return true; }
    });
  }

  function makeEl(tag, label) {
    const el = { tagName: tag.toUpperCase(), __label: label, attrOrder: [] };
    el.style = makeStyle(label);
    const field = {};
    for (const k of ['innerHTML', 'textContent', 'src', 'className', 'translate']) {
      Object.defineProperty(el, k, {
        get() { return field[k] === undefined ? (k === 'translate' ? true : '') : field[k]; },
        set(v) {
          writes.push([label, k, v]);
          if (k === 'src' || k === 'className') { if (el.attrOrder.indexOf(k) < 0) el.attrOrder.push(k); }
          if (k === 'translate') { field[k] = !!v; return; }   // a boolean IDL property, like Chrome
          field[k] = v;
        }
      });
    }
    if (tag === 'canvas') {
      el.__canvas = true;
      el.__id = label;
      let w = 300, h = 150;
      Object.defineProperty(el, 'width', { get() { return w; }, set(v) { calls.push([el.__id, '=canvas.width', v]); w = v; } });
      Object.defineProperty(el, 'height', { get() { return h; }, set(v) { calls.push([el.__id, '=canvas.height', v]); h = v; } });
      const ctx = {};
      const p = {};
      for (const m of METHODS) ctx[m] = (...a) => { calls.push([el.__id, m, ...a.map(ser)]); };
      for (const k of PROPS) {
        Object.defineProperty(ctx, k, { get() { return p[k]; }, set(v) { calls.push([el.__id, '=' + k, v]); p[k] = v; } });
      }
      el.getContext = (kind) => { assert.strictEqual(kind, '2d'); return ctx; };
      el.toDataURL = () => 'data:' + el.__id;
    }
    return el;
  }

  const els = {};
  const TAGS = { mc: 'canvas', lbh: 'div', lbs: 'div', lbn: 'div', lbp: 'div', lbf: 'div', vcm: 'div', loch: 'div', loc: 'img',
    asmc: 'canvas', asmc2: 'canvas', sid_tf: 'div', myloc: 'img', login: 'div', lastscore: 'div' };
  for (const k of Object.keys(TAGS)) els[k] = makeEl(TAGS[k], k);
  const document = {
    querySelector(sel) {
      const m = /^\[data-sl="([^"]+)"\]$/.exec(sel);
      return m && els[m[1]] ? els[m[1]] : null;
    },
    createElement(tag) { return makeEl(tag, 'new' + (made++)); }
  };
  // created canvases are named new0, new1, ... in creation order; restartNames() starts the count again
  return { writes, calls, els, document, restartNames() { made = 0; } };
}

// Boot slHud on a fresh fake page. S holds what slApply and slPage would have set (CA 1.4, LPI 5.1).
function setup(over) {
  const dom = makeDom();
  globalThis.document = dom.document;
  const clock = { t: 0 };
  const order = [];
  const hookCalls = [];
  D.slLoop = { now: () => clock.t, hooks: {} };
  D.slDrawWorld = { buildTilePattern() { order.push('buildTilePattern'); } };
  D.slPage = { resize() { order.push('resize'); } };
  const S = Object.assign({
    lb_fr: 0, dead_mtm: -1, playing: false, mmsta: .475, mmrad: -1, mmsz: -1, mmdata: null, mmgad: false, mmbfr: 0,
    real_sid: undefined, team_mode: false, grd: 16384, flux_grd: undefined, slither: null, rank: 0, slither_count: 0,
    wumsts: false, fpsls: [], fmlts: [], hsu: 0, wsu: 0, ww: 1280, hh: 720, vfr: 0, lang: 'en',
    mc: dom.els.mc
  }, over || {});
  D.S = S;
  H.init(S);
  dom.writes.length = 0;
  dom.calls.length = 0;
  dom.restartNames();   // the dot canvas made by init was new0
  return { S, dom, clock, order, hookCalls };
}

const callsOf = (dom, id) => dom.calls.filter((c) => c[0] === id);
const strip = (list) => list.map((c) => c.slice(1));
const writesOf = (dom, label, prop) => dom.writes.filter((w) => w[0] === label && w[1] === prop).map((w) => w[2]);

// The minimap background drawn by setMinimapSize at radius r (game.js:2043-2078), for canvas `id`.
function backgroundCalls(r) {
  const c = 12 + r;
  const size = r * 2 + 24;
  return [
    ['=canvas.height', size], ['=canvas.width', size],
    ['save'], ['=fillStyle', '#202630'], ['=shadowBlur', 12], ['=shadowOffsetY', 3], ['=shadowColor', '#000000'],
    ['beginPath'], ['arc', c, c, r, 0, 6.283185307179586], ['fill'], ['restore'],
    ['=fillStyle', '#404650'], ['beginPath'], ['moveTo', c, c], ['arc', c, c, r, 0, 1.5707963267948966], ['lineTo', c, c],
    ['fill'], ['beginPath'], ['moveTo', c, c], ['arc', c, c, r, 3.141592653589793, 4.71238898038469], ['lineTo', c, c],
    ['fill'], ['=strokeStyle', '#202630'], ['=lineWidth', 1], ['beginPath'], ['moveTo', c, c - r], ['lineTo', c, c + r],
    ['stroke'], ['beginPath'], ['moveTo', c - r, c], ['lineTo', c + r, c], ['stroke']
  ];
}

// ---- init ---------------------------------------------------------------------------------------------------------
test('init binds the HUD, sets only its own keys, header text by lang, translate quirk, the dot image', () => {
  const { S, dom } = setup();
  for (const k of ['lbh', 'lbs', 'lbn', 'lbp', 'lbf', 'vcm', 'loch', 'loc', 'asmc', 'asmc2', 'sid_tf', 'myloc', 'login',
    'lastscore']) assert.strictEqual(S[k], dom.els[k], k);
  assert.deepStrictEqual(S.u_m, [64, 32, 16, 8, 4, 2, 1]);
  assert.deepStrictEqual([S.lgbsc, S.lgcsc, S.login_fr, S.llgmtm, S.login_iv, S.mmal, S.locu_mtm], [1, 1, 0, 0, -1, 0, 0]);
  assert.strictEqual(S.lb_fr, 0, 'lb_fr is slApply\'s (game.js:1114), not touched');
  assert.strictEqual(S.lbh.textContent, 'Leaderboard');
  assert.strictEqual(S.lbn.translate, true, 'lbn.translate = "no" sets the boolean property to true (game.js:1472)');
  for (const [lang, t] of [['de', 'Bestenliste'], ['fr', 'Gagnants'], ['pt', 'Líderes'], ['es', 'Leaderboard'],
    ['en', 'Leaderboard']]) assert.strictEqual(setup({ lang }).S.lbh.textContent, t, lang);
});

test('init draws the 14 x 14 dot and sets myloc src, class, then styles in their order', () => {
  const dom = makeDom();
  globalThis.document = dom.document;
  D.slLoop = { now: () => 5, hooks: {} };
  const S = { lang: 'en', mc: dom.els.mc };
  H.init(S);
  assert.deepStrictEqual(strip(callsOf(dom, 'new0')), [
    ['=canvas.height', 14], ['=canvas.width', 14], ['=fillStyle', '#FFFFFF'], ['=strokeStyle', '#000000'],
    ['=lineWidth', 2], ['beginPath'], ['arc', 7, 7, 2.5, 0, 6.283185307179586], ['stroke'], ['fill']]);
  assert.strictEqual(S.myloc.src, 'data:new0');
  assert.deepStrictEqual(S.myloc.attrOrder, ['src', 'className']);
  assert.strictEqual(S.myloc.className, 'nsi');
  assert.strictEqual(JSON.stringify(S.myloc.style),
    '{"position":"absolute","left":"0px","top":"0px","opacity":1,"zIndex":13,"transform":"translateZ(0)"}');
  assert.strictEqual(S.llgmtm, 5);
});

// ---- minimap size (DWH 9.16) --------------------------------------------------------------------------------------
test('setMinimapSize(24, true): holder, label, background, both canvases', () => {
  const { S, dom } = setup({ real_sid: 0 });
  H.setMinimapSize(24, true);
  assert.deepStrictEqual([S.mmrad, S.mmsz], [12, 24]);
  assert.ok(S.mmdata instanceof Uint8Array);
  assert.strictEqual(S.mmdata.length, 576);
  assert.deepStrictEqual([S.loch.style.width, S.loch.style.height], ['48px', '48px']);
  assert.deepStrictEqual([S.sid_tf.style.width, S.sid_tf.style.top, S.sid_tf.textContent], ['48px', '41px', '']);
  assert.deepStrictEqual(strip(callsOf(dom, 'new0')), backgroundCalls(12));
  assert.strictEqual(S.loc.src, 'data:new0');
  assert.strictEqual(S.loc.className, 'nsi');
  assert.strictEqual(JSON.stringify(S.loc.style),
    '{"position":"absolute","left":"0px","top":"0px","opacity":0.45,"zIndex":11,"transform":"translateZ(0)"}');
  assert.deepStrictEqual(dom.calls.filter((c) => c[0] === 'asmc' || c[0] === 'asmc2'), [
    ['asmc', '=canvas.width', 24], ['asmc', '=canvas.height', 24], ['asmc2', '=canvas.width', 24],
    ['asmc2', '=canvas.height', 24]]);
  // chained left = top: top is written first (game.js:2090)
  assert.strictEqual(JSON.stringify(S.asmc.style), '{"position":"absolute","top":"12px","left":"12px","zIndex":12,"opacity":0.475}');
  assert.strictEqual(JSON.stringify(S.asmc2.style), '{"position":"absolute","top":"12px","left":"12px","zIndex":13,"opacity":0.475}');
  assert.deepStrictEqual([S.asmc.className, S.asmc2.className], ['nsi', 'nsi']);
  // holder: height then width (chained, game.js:2036)
  assert.deepStrictEqual(dom.writes.filter((w) => w[0] === 'loch').map((w) => w[1]), ['height', 'width']);

  // same radius, no force: nothing at all, label unchanged even with a new real_sid
  S.real_sid = 7;
  dom.writes.length = 0; dom.calls.length = 0;
  H.setMinimapSize(24, false);
  assert.deepStrictEqual([dom.writes.length, dom.calls.length, S.sid_tf.textContent], [0, 0, '']);

  H.setMinimapSize(80, false);
  assert.deepStrictEqual([S.loch.style.width, S.sid_tf.style.width, S.sid_tf.style.top, S.sid_tf.textContent],
    ['104px', '104px', '97px', 'server 7']);
  assert.deepStrictEqual(strip(callsOf(dom, 'new1')), backgroundCalls(40));

  // team mode blanks the label (game.js:2039-2042)
  S.team_mode = true;
  H.setMinimapSize(24, true);
  assert.strictEqual(S.sid_tf.textContent, '');
});

// ---- map packets ---------------------------------------------------------------------------------------------------
test('CA A20: M size 24 then V on the 24 map', () => {
  const { S, dom } = setup({ real_sid: 0 });
  H.setMinimapSize(24, true);
  dom.calls.length = 0;
  H.onMinimap({ type: 'minimap', cmd: 'M', raw: { size: 24 }, size: 24, pixels: [[23, 23], [17, 23], [1, 23], [0, 23]] });
  assert.deepStrictEqual(dom.calls, [
    ['asmc2', 'clearRect', 0, 0, 24, 24], ['asmc2', '=fillStyle', '#FFFFFF'], ['asmc2', 'fillRect', 23, 23, 1, 1],
    ['asmc2', 'fillRect', 17, 23, 1, 1], ['asmc2', 'fillRect', 1, 23, 1, 1], ['asmc2', 'fillRect', 0, 23, 1, 1],
    ['asmc', 'clearRect', 0, 0, 24, 24], ['asmc', 'drawImage', '<asmc2 24x24>', 0, 0]]);
  assert.deepStrictEqual([S.mmgad, S.mmbfr, S.asmc.style.opacity, S.asmc2.style.opacity], [true, 0, .475, 0]);
  dom.calls.length = 0;
  H.onMinimap({ type: 'minimap', cmd: 'V', size: 24, toggles: [[23, 23], [22, 23]] });
  assert.deepStrictEqual(dom.calls, [
    ['asmc', 'clearRect', 0, 0, 24, 24], ['asmc', 'drawImage', '<asmc2 24x24>', 0, 0], ['asmc2', '=fillStyle', '#FFFFFF'],
    ['asmc2', 'clearRect', 23, 23, 1, 1], ['asmc2', 'fillRect', 22, 23, 1, 1]]);
  const set = [];
  for (let i = 0; i < S.mmdata.length; i++) if (S.mmdata[i] === 1) set.push([i % 24, Math.floor(i / 24)]);
  assert.deepStrictEqual(set, [[0, 23], [1, 23], [17, 23], [22, 23]]);
});

test('DWH 9.16: M size 4 resizes first, then V toggles', () => {
  const { S, dom } = setup({ real_sid: 0 });
  H.setMinimapSize(24, true);
  dom.calls.length = 0;
  H.onMinimap({ type: 'minimap', cmd: 'M', raw: { size: 4 }, size: 4,
    pixels: [[3, 3], [1, 2], [1, 1], [0, 1], [3, 0], [2, 0], [1, 0], [0, 0]] });
  assert.deepStrictEqual(strip(callsOf(dom, 'new1')), backgroundCalls(2));
  assert.deepStrictEqual(dom.calls.filter((c) => c[0] === 'asmc' || c[0] === 'asmc2'), [
    ['asmc', '=canvas.width', 4], ['asmc', '=canvas.height', 4], ['asmc2', '=canvas.width', 4], ['asmc2', '=canvas.height', 4],
    ['asmc2', 'clearRect', 0, 0, 4, 4], ['asmc2', '=fillStyle', '#FFFFFF'],
    ['asmc2', 'fillRect', 3, 3, 1, 1], ['asmc2', 'fillRect', 1, 2, 1, 1], ['asmc2', 'fillRect', 1, 1, 1, 1],
    ['asmc2', 'fillRect', 0, 1, 1, 1], ['asmc2', 'fillRect', 3, 0, 1, 1], ['asmc2', 'fillRect', 2, 0, 1, 1],
    ['asmc2', 'fillRect', 1, 0, 1, 1], ['asmc2', 'fillRect', 0, 0, 1, 1],
    ['asmc', 'clearRect', 0, 0, 4, 4], ['asmc', 'drawImage', '<asmc2 4x4>', 0, 0]]);
  assert.deepStrictEqual(Array.from(S.mmdata), [1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1]);
  assert.deepStrictEqual([S.mmgad, S.mmbfr, S.asmc.style.opacity, S.asmc2.style.opacity], [true, 0, .475, 0]);
  dom.calls.length = 0;
  H.onMinimap({ type: 'minimap', cmd: 'V', size: 4, toggles: [[3, 3], [2, 3]] });
  assert.deepStrictEqual(dom.calls, [
    ['asmc', 'clearRect', 0, 0, 4, 4], ['asmc', 'drawImage', '<asmc2 4x4>', 0, 0], ['asmc2', '=fillStyle', '#FFFFFF'],
    ['asmc2', 'clearRect', 3, 3, 1, 1], ['asmc2', 'fillRect', 2, 3, 1, 1]]);
  assert.deepStrictEqual(Array.from(S.mmdata), [1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
  assert.deepStrictEqual([S.mmgad, S.mmbfr], [true, 0]);
});

test('DWH 9.16: U copies before only on the first map (quirk), second U has no copies', () => {
  const { S, dom } = setup({ real_sid: 0 });
  H.setMinimapSize(24, true);
  dom.calls.length = 0;
  H.onMinimap({ type: 'minimap', cmd: 'U', raw: { size: 3 }, size: 3, pixels: [[2, 2], [2, 1]] });
  assert.deepStrictEqual(strip(callsOf(dom, 'new1')), backgroundCalls(1.5));
  assert.deepStrictEqual(dom.calls.filter((c) => c[0] === 'asmc' || c[0] === 'asmc2'), [
    ['asmc', '=canvas.width', 3], ['asmc', '=canvas.height', 3], ['asmc2', '=canvas.width', 3], ['asmc2', '=canvas.height', 3],
    ['asmc', 'clearRect', 0, 0, 3, 3], ['asmc', 'drawImage', '<asmc2 3x3>', 0, 0],
    ['asmc2', 'clearRect', 0, 0, 3, 3], ['asmc2', '=fillStyle', '#FFFFFF'], ['asmc2', 'fillRect', 2, 2, 1, 1],
    ['asmc2', 'fillRect', 2, 1, 1, 1], ['asmc', 'clearRect', 0, 0, 3, 3], ['asmc', 'drawImage', '<asmc2 3x3>', 0, 0]]);
  assert.strictEqual(S.mmgad, true);
  assert.strictEqual(S.loch.style.width, '27px');
  dom.calls.length = 0;
  H.onMinimap({ type: 'minimap', cmd: 'U', raw: { size: 3 }, size: 3,
    pixels: [[2, 2], [1, 2], [0, 2], [2, 1], [1, 1], [0, 1], [2, 0]] });
  assert.deepStrictEqual(dom.calls, [
    ['asmc2', 'clearRect', 0, 0, 3, 3], ['asmc2', '=fillStyle', '#FFFFFF'], ['asmc2', 'fillRect', 2, 2, 1, 1],
    ['asmc2', 'fillRect', 1, 2, 1, 1], ['asmc2', 'fillRect', 0, 2, 1, 1], ['asmc2', 'fillRect', 2, 1, 1, 1],
    ['asmc2', 'fillRect', 1, 1, 1, 1], ['asmc2', 'fillRect', 0, 1, 1, 1], ['asmc2', 'fillRect', 2, 0, 1, 1]]);
});

test('DWH 9.16: u sets mmgad first, forces an 80 map, draws on the front canvas, no opacity writes', () => {
  const { S, dom } = setup({ real_sid: 0 });
  H.setMinimapSize(24, true);
  dom.calls.length = 0; dom.writes.length = 0;
  H.onMinimap({ type: 'minimap', cmd: 'u', size: 80, pixels: [[79, 0]] });
  assert.deepStrictEqual([S.mmgad, S.mmsz, S.mmrad], [true, 80, 40]);
  assert.deepStrictEqual(strip(callsOf(dom, 'new1')), backgroundCalls(40));
  assert.deepStrictEqual(dom.calls.filter((c) => c[0] === 'asmc' || c[0] === 'asmc2'), [
    ['asmc', '=canvas.width', 80], ['asmc', '=canvas.height', 80], ['asmc2', '=canvas.width', 80],
    ['asmc2', '=canvas.height', 80], ['asmc', 'clearRect', 0, 0, 80, 80], ['asmc', '=fillStyle', '#FFFFFF'],
    ['asmc', 'fillRect', 79, 0, 1, 1]]);
  // the only opacity writes are setMinimapSize's own (mmsta), none from the packet
  assert.deepStrictEqual(writesOf(dom, 'asmc', 'opacity'), [.475]);
  assert.deepStrictEqual(writesOf(dom, 'asmc2', 'opacity'), [.475]);
  // a second u at 80: no resize, mmgad set before anything
  dom.calls.length = 0;
  H.onMinimap({ type: 'minimap', cmd: 'u', size: 80, pixels: [] });
  assert.deepStrictEqual(dom.calls, [['asmc', 'clearRect', 0, 0, 80, 80], ['asmc', '=fillStyle', '#FFFFFF']]);
});

test('DWH 9.23: L team map, one team then two teams (save left open)', () => {
  const { S, dom } = setup({ real_sid: 0 });
  H.setMinimapSize(24, true);
  dom.calls.length = 0;
  H.onMinimap({ type: 'minimap', cmd: 'L', teamCount: 1, raw: { size: 3 }, size: 3, teams: [[[2, 2], [2, 1]]] });
  assert.deepStrictEqual(strip(callsOf(dom, 'new1')), backgroundCalls(1.5));
  assert.strictEqual(S.loch.style.width, '27px');
  assert.deepStrictEqual(dom.calls.filter((c) => (c[0] === 'asmc' || c[0] === 'asmc2') && c[1].indexOf('=canvas') !== 0), [
    ['asmc2', 'clearRect', 0, 0, 3, 3], ['asmc2', '=fillStyle', '#FFFFFF'], ['asmc2', 'fillRect', 2, 2, 1, 1],
    ['asmc2', 'fillRect', 2, 1, 1, 1], ['asmc', 'clearRect', 0, 0, 3, 3], ['asmc', 'drawImage', '<asmc2 3x3>', 0, 0]]);
  assert.deepStrictEqual([S.mmgad, S.mmsz, S.mmbfr, S.asmc.style.opacity, S.asmc2.style.opacity], [true, 3, 0, .475, 0]);
  dom.calls.length = 0;
  H.onMinimap({ type: 'minimap', cmd: 'L', teamCount: 2, raw: { size: 3 }, size: 3,
    teams: [[[2, 2], [1, 2], [0, 2], [2, 1], [1, 1], [0, 1], [2, 0]], [[2, 2]]] });
  assert.deepStrictEqual(dom.calls, [
    ['asmc', 'clearRect', 0, 0, 3, 3], ['asmc', 'drawImage', '<asmc2 3x3>', 0, 0], ['asmc2', 'clearRect', 0, 0, 3, 3],
    ['asmc2', 'save'], ['asmc2', '=globalCompositeOperation', 'lighter'], ['asmc2', '=fillStyle', '#FF8080'],
    ['asmc2', 'fillRect', 2, 2, 1, 1], ['asmc2', 'fillRect', 1, 2, 1, 1], ['asmc2', 'fillRect', 0, 2, 1, 1],
    ['asmc2', 'fillRect', 2, 1, 1, 1], ['asmc2', 'fillRect', 1, 1, 1, 1], ['asmc2', 'fillRect', 0, 1, 1, 1],
    ['asmc2', 'fillRect', 2, 0, 1, 1], ['asmc2', '=fillStyle', '#99AAFF'], ['asmc2', 'fillRect', 2, 2, 1, 1]]);
  // two teams with no cells for team 2: the colour is still set (game.js:8152-8154)
  dom.calls.length = 0;
  H.onMinimap({ type: 'minimap', cmd: 'L', teamCount: 2, raw: { size: 3 }, size: 3, teams: [[], []] });
  assert.deepStrictEqual(dom.calls.slice(-2), [['asmc2', '=fillStyle', '#FF8080'], ['asmc2', '=fillStyle', '#99AAFF']]);
});

// ---- fades (DWH 9.14, 9.22) ---------------------------------------------------------------------------------------
test('leaderboard fade-in from lb_fr 0', () => {
  const { S } = setup({ dead_mtm: -1, lb_fr: 0, vfr: VFR });
  const seen = [];
  let f = 0;
  while (S.lb_fr !== 1 && f < 60) {
    f++;
    H.oefFades(0);
    if (f <= 3) seen.push([S.lb_fr, S.lbh.style.opacity, S.lbs.style.opacity, S.vcm.style.opacity]);
  }
  assert.deepStrictEqual(seen, [
    [0.020833374999999998, 0.017708368749999998, 0.020833374999999998, 0.020833374999999998],
    [0.041666749999999995, 0.035416737499999996, 0.041666749999999995, 0.041666749999999995],
    [0.06250012499999999, 0.05312510624999999, 0.06250012499999999, 0.06250012499999999]]);
  assert.strictEqual(f, 48);
  assert.deepStrictEqual([S.lbh.style.opacity, S.lbn.style.opacity, S.lbp.style.opacity, S.lbf.style.opacity], [.85, 1, 1, 1]);
  // at 1: no more writes
  const before = S.lbh.style.opacity;
  S.lbh.style.opacity = 'X';
  H.oefFades(0);
  assert.strictEqual(S.lbh.style.opacity, 'X');
  assert.strictEqual(before, .85);
});

test('lb_fr -1 writes nothing while alive', () => {
  const { S, dom } = setup({ dead_mtm: -1, lb_fr: -1, vfr: VFR });
  H.oefFades(100);
  assert.deepStrictEqual([dom.writes.length, S.lb_fr], [0, -1]);
});

test('death hold then death fade', () => {
  const { S } = setup({ dead_mtm: 1000, lb_fr: 1, playing: true, vfr: VFR });
  S.login_fr = 1; S.login_iv = -1; S.mmal = 1;
  H.oefFades(2600);   // exactly 1600 ms: not past the hold
  assert.deepStrictEqual([S.login_iv, S.login_fr], [-1, 1]);
  const rows = {};
  for (let f = 1; f <= 130; f++) {
    H.oefFades(2600 + f * 16.6667);
    if (f <= 2 || f === 60 || f === 120 || S.login_fr === 0) {
      rows[f] = [S.login_iv, S.login_fr, S.lb_fr, S.mc.style.opacity, S.loch.style.opacity, S.lbh.style.opacity,
        S.lbs.style.opacity, S.login.style.opacity, S.login.style.transform, S.login.style.display, S.dead_mtm, S.playing];
    }
    if (S.login_fr === 0) break;
  }
  assert.deepStrictEqual(rows[1], [-2, 0.99166665, 0.99166665, 0.99166665, 0.99166665, 0.8429166524999999, 0.99166665,
    0.008333350000000017, 'scale(1.09834,1.09834)', 'inline', 1000, true]);
  assert.deepStrictEqual(rows[2], [-2, 0.9833333, 0.9833333, 0.9833333, 0.9833333, 0.835833305, 0.9833333,
    0.016666700000000034, 'scale(1.09669,1.09669)', 'inline', 1000, true]);
  assert.deepStrictEqual(rows[60], [-2, 0.49999899999999897, 0.49999899999999897, 0.49999899999999897,
    0.49999899999999897, 0.4249991499999991, 0.49999899999999897, 0.500001000000001, 'scale(1.025,1.025)', 'inline', 1000,
    true]);
  assert.deepStrictEqual(rows[120], [-2, 0, -1, 0, 0, -0.85, -1, 1, '', 'inline', -1, false]);
  assert.deepStrictEqual(Object.keys(rows).map(Number), [1, 2, 60, 120]);
});

test('DWH 9.22: a death during the start fade writes nothing until the start fade ends', () => {
  const { S, dom } = setup({ dead_mtm: 1000, lb_fr: .5, vfr: VFR });
  S.login_fr = .7; S.login_iv = 17; S.mmal = 0;
  H.oefFades(3000);
  assert.deepStrictEqual([S.login_iv, S.login_fr, S.lb_fr, dom.writes.length], [17, .7, .5, 0]);
});

test('minimap holder fade-in (per frame) and crossfade (per vfr)', () => {
  const { S } = setup({ mmgad: true, mmbfr: 0, vfr: VFR });
  S.mmal = 0;
  const rows = {};
  for (let f = 1; f <= 120; f++) {
    H.oefMinimap();
    if ([1, 2, 40, 41, 110, 111].indexOf(f) >= 0) {
      rows[f] = [S.mmal, S.loch.style.opacity, S.mmbfr, S.asmc.style.opacity, S.asmc2.style.opacity];
    }
  }
  assert.deepStrictEqual(rows[1], [0.025, 0.025, 0.009057989130434782, 0.47069745516304345, 0.0081287061226617]);
  assert.deepStrictEqual(rows[2], [0.05, 0.05, 0.018115978260869563, 0.46639491032608693, 0.01612632607978237]);
  assert.deepStrictEqual(rows[40], [1, 1, 0.3623195652173911, 0.30289820652173916, 0.24688186874335993]);
  assert.deepStrictEqual(rows[41], [1, 1, 0.3713775543478259, 0.2985956616847827, 0.2515016356171148]);
  assert.deepStrictEqual(rows[110], [1, 1, 0.9963788043478246, 0.001720067934783337, 0.4740954083751908]);
  assert.deepStrictEqual(rows[111], [1, 1, 1, 0, 0.475]);
});

test('no minimap fade before the first map', () => {
  const { dom } = setup({ mmgad: false, vfr: VFR });
  H.oefMinimap();
  assert.strictEqual(dom.writes.length, 0);
});

test('start fade: loginFade every 25 ms of wall time', () => {
  const { S, clock } = setup();
  const cleared = [];
  const realClear = globalThis.clearInterval;
  globalThis.clearInterval = (id) => { cleared.push(id); };
  try {
    S.login_fr = 0; S.llgmtm = 0; S.mmal = 0; S.lgbsc = 1; S.login_iv = 17;
    const rows = {};
    for (const t of [25, 50, 300, 475, 500, 525]) {
      clock.t = t;
      H.loginFade();
      rows[t] = [S.login_fr, S.mc.style.opacity, S.loch.style.opacity, S.login.style.opacity, S.login.style.transform,
        S.login.style.display, S.login_iv];
    }
    assert.deepStrictEqual(rows[25], [0.05, 0.05, 0, 0.95, 'scale(1.00025,1.00025)', undefined, 17]);
    assert.deepStrictEqual(rows[50], [0.1, 0.1, 0, 0.9, 'scale(1.001,1.001)', undefined, 17]);
    assert.deepStrictEqual(rows[300], [0.6, 0.6, 0, 0.4, 'scale(1.036,1.036)', undefined, 17]);
    assert.deepStrictEqual(rows[475], [0.95, 0.95, 0, 0.050000000000000044, 'scale(1.09025,1.09025)', undefined, 17]);
    assert.deepStrictEqual(rows[500], [1, 1, 0, 1, 'scale(1.09025,1.09025)', 'none', -1]);
    assert.deepStrictEqual(rows[525], [1, 1, 0, 1, 'scale(1.09025,1.09025)', 'none', -1]);
    assert.deepStrictEqual(cleared, [17, -1]);
  } finally {
    globalThis.clearInterval = realClear;
  }
});

// ---- packet a: onInit and startShowGame ----------------------------------------------------------------------------
test('onInit (packet a): order of writes, then startShowGame with a real 25 ms interval', () => {
  const { S, dom, order, clock } = setup({ real_sid: 3, mmsta: .7, lb_fr: .4 });
  clock.t = 1234;
  const realSet = globalThis.setInterval;
  const timers = [];
  globalThis.setInterval = (fn, ms) => { timers.push([fn, ms]); order.push('setInterval'); return 42; };
  try {
    H.onInit();
  } finally {
    globalThis.setInterval = realSet;
  }
  assert.deepStrictEqual(timers.map((t) => t[1]), [25]);
  assert.strictEqual(timers[0][0], H.loginFade);
  assert.deepStrictEqual(order, ['setInterval', 'buildTilePattern', 'resize']);
  assert.deepStrictEqual([S.mmsta, S.mmsz, S.mmrad, S.login_iv, S.llgmtm, S.lb_fr], [.475, 24, 12, 42, 1234, -1]);
  assert.strictEqual(S.sid_tf.textContent, 'server 3');
  const w = dom.writes.filter((x) => x[1] !== 'src' && x[1] !== 'className' && !(x[0] === 'loc') &&
    !(x[0] === 'asmc' || x[0] === 'asmc2'));
  assert.deepStrictEqual(w, [
    ['lbf', 'left', '8px'], ['lbf', 'bottom', '4px'], ['lbf', 'height', '37px'],
    ['loch', 'height', '48px'], ['loch', 'width', '48px'], ['sid_tf', 'width', '48px'], ['sid_tf', 'top', '41px'],
    ['sid_tf', 'textContent', 'server 3'],
    ['lbh', 'display', 'inline'], ['lbs', 'display', 'inline'], ['lbn', 'display', 'inline'], ['lbp', 'display', 'inline'],
    ['lbf', 'display', 'inline'], ['vcm', 'display', 'inline'], ['loch', 'display', 'inline'],
    ['mc', 'opacity', 0], ['mc', 'display', 'inline'],
    ['vcm', 'opacity', 0], ['lbf', 'opacity', 0], ['lbp', 'opacity', 0], ['lbn', 'opacity', 0], ['lbs', 'opacity', 0],
    ['lbh', 'opacity', 0], ['loch', 'opacity', 0]]);
  // the map canvases take the NEW mmsta (written before setMinimapSize)
  assert.deepStrictEqual([S.asmc.style.opacity, S.asmc2.style.opacity], [.475, .475]);
});

// ---- own dot (DWH 9.15) --------------------------------------------------------------------------------------------
test('own dot position, scaled by flux_grd, throttled at 150 ms', () => {
  const cases = [
    [12, 16384, 16384, '17px', '17px'], [40, 20000, 15000, '54px', '41.6px'], [40, 32440, 16384, '85px', '45px'],
    [100, 1234.5, 30000.25, '10.6px', '189.8px']];
  for (const [mmrad, xx, yy, left, top] of cases) {
    const { S, clock } = setup({ grd: 16384, flux_grd: 16056.32 });
    clock.t = 1000;
    S.mmrad = mmrad; S.slither = { xx, yy }; S.locu_mtm = 0;
    H.oefDot(151);
    assert.deepStrictEqual([S.myloc.style.left, S.myloc.style.top, S.locu_mtm], [left, top, 1000]);
  }
  const { S, dom } = setup({ grd: 16384, flux_grd: 16056.32 });
  S.mmrad = 12; S.slither = { xx: 1, yy: 1 }; S.locu_mtm = 0;
  H.oefDot(150);
  assert.strictEqual(dom.writes.length, 0);
  S.slither = null;
  H.oefDot(1E6);
  assert.strictEqual(dom.writes.length, 0);
  S.slither = { xx: 1, yy: 1 }; S.grd = 2147483647;
  H.oefDot(1E6);
  assert.strictEqual(dom.writes.length, 0);
});

// ---- length box (DWH 9.9) ------------------------------------------------------------------------------------------
// Entries of setMscps(300) (game.js:1990-2008) run in a vm: index -> [fpsls, fmlts].
const TABLE300 = { 10: [10.34947990734712, 0.9265581322740843], 64: [83.58896771789209, 0.5828129371334763],
  66: [87.03707226924719, 0.5717587979609354], 300: [546699.2527919183, 0.0000026697904601496656] };
function tables() {
  const fpsls = [], fmlts = [];
  for (const k of Object.keys(TABLE300)) { fpsls[k] = TABLE300[k][0]; fmlts[k] = TABLE300[k][1]; }
  return { fpsls, fmlts };
}
const LBF = (score, rank, count) => '<span style="font-size: 14px;"><span style="opacity: .4;">Your length: </span>' +
  '<span style="opacity: .8; font-weight: bold;">' + score + '</span></span><BR><span style="opacity: .3;">Your rank: ' +
  '</span><span style="opacity: .35;">' + rank + '</span><span style="opacity: .3;"> of </span><span style="opacity: .35;">' +
  count + '</span>';

test('length box rebuild', () => {
  const rows = [[10, 0, 0, 1, 1, 135], [10, .5, 0, 3, 57, 143], [64, .2399, 0, 12, 400, 1240], [64, .2399, 2, 12, 400, 1291],
    [300, .75, 0, 1, 2, 12414282]];
  for (const [sct, fam, rsc, rank, count, score] of rows) {
    const { S } = setup(Object.assign(tables(), { wumsts: true, rank, slither_count: count, playing: true,
      slither: { sct, fam, rsc } }));
    H.updateLengthBox();
    assert.strictEqual(S.lbf.innerHTML, LBF(score, rank, count));
    assert.strictEqual(S.wumsts, false);
  }
  // the exact first-row string of DWH 9.9
  assert.strictEqual(LBF(135, 1, 1), '<span style="font-size: 14px;"><span style="opacity: .4;">Your length: </span><span ' +
    'style="opacity: .8; font-weight: bold;">135</span></span><BR><span style="opacity: .3;">Your rank: </span><span ' +
    'style="opacity: .35;">1</span><span style="opacity: .3;"> of </span><span style="opacity: .35;">1</span>');
  // any gate false: no write, wumsts kept
  for (const over of [{ rank: 0 }, { slither_count: 0 }, { playing: false }, { wumsts: false }]) {
    const { S, dom } = setup(Object.assign(tables(), { wumsts: true, rank: 1, slither_count: 1, playing: true,
      slither: { sct: 10, fam: 0, rsc: 0 } }, over));
    H.updateLengthBox();
    assert.strictEqual(dom.writes.length, 0);
    assert.strictEqual(S.wumsts, over.wumsts === false ? false : true);
  }
  // languages
  const { S } = setup(Object.assign(tables(), { lang: 'es', wumsts: true, rank: 2, slither_count: 9, playing: true,
    slither: { sct: 10, fam: 0, rsc: 0 } }));
  H.updateLengthBox();
  assert.ok(S.lbf.innerHTML.indexOf('>Tu longitud: <') > 0 && S.lbf.innerHTML.indexOf('>Tu rango: <') > 0 &&
    S.lbf.innerHTML.indexOf('> de <') > 0);
  const de = setup(Object.assign(tables(), { lang: 'de', wumsts: true, rank: 2, slither_count: 9, playing: true,
    slither: { sct: 10, fam: 0, rsc: 0 } }));
  H.updateLengthBox();
  assert.ok(de.S.lbf.innerHTML.indexOf('>Deine Länge: <') > 0 && de.S.lbf.innerHTML.indexOf('>Dein rang: <') > 0 &&
    de.S.lbf.innerHTML.indexOf('> von <') > 0);
});

// ---- death text (DWH 9.13) -----------------------------------------------------------------------------------------
test('gameOver writes the last score', () => {
  const { S } = setup();
  H.gameOver(135, false);
  assert.strictEqual(S.lastscore.innerHTML, '<span style="opacity: .45;">Your final length was </span><b>135</b>');
  H.gameOver(13257045, false);
  assert.strictEqual(S.lastscore.innerHTML, '<span style="opacity: .45;">Your final length was </span><b>13257045</b>!');
  H.gameOver(1272, true);
  assert.strictEqual(S.lastscore.innerHTML, '<span style="opacity: .45;">Your final length was </span><b>1272</b>!');
  H.gameOver(1000, false);
  assert.strictEqual(S.lastscore.innerHTML, '<span style="opacity: .45;">Your final length was </span><b>1000</b>');
  const fr = setup({ lang: 'fr' });
  H.gameOver(7, false);
  assert.strictEqual(fr.S.lastscore.innerHTML, '<span style="opacity: .45;">Votre longueur finale était de </span><b>7</b>');
  const es = setup({ lang: 'es' });
  H.gameOver(7, false);
  assert.strictEqual(es.S.lastscore.innerHTML, '<span style="opacity: .45;">Your final length was </span><b>7</b>');
});

// ---- leaderboard and vcm writes ------------------------------------------------------------------------------------
test('setLeaderboard writes lbs, lbn, lbp in that order; setVcm writes vcm', () => {
  const { dom } = setup();
  H.setLeaderboard('A', 'B', 'C');
  H.setVcm('V');
  assert.deepStrictEqual(dom.writes, [['lbs', 'innerHTML', 'A'], ['lbn', 'innerHTML', 'B'], ['lbp', 'innerHTML', 'C'],
    ['vcm', 'innerHTML', 'V']]);
});

// ---- resetGame HUD part --------------------------------------------------------------------------------------------
test('resetHud clears asmc then asmc2 at mmsz, nothing else', () => {
  const { S, dom } = setup({ real_sid: 0 });
  H.setMinimapSize(80, true);
  dom.calls.length = 0; dom.writes.length = 0;
  H.resetHud();
  assert.deepStrictEqual(dom.calls, [['asmc', 'clearRect', 0, 0, 80, 80], ['asmc2', 'clearRect', 0, 0, 80, 80]]);
  assert.strictEqual(dom.writes.length, 0);
  assert.strictEqual(S.mmsz, 80);
});

// ---- resize writes (DWH 3.9, 9.17) ---------------------------------------------------------------------------------
test('resizeHud: positions, login width, login scale and top', () => {
  const sizes = [[1280, 720, 1, '', '0px'], [844, 390, 0.6964285714285714, 'scale(0.69643,0.69643)', '-118.39286px'],
    [1000, 500, 0.8928571428571429, 'scale(0.89286,0.89286)', '-53.57143px'], [390, 844, 1, '', '0px']];
  for (const [ww, hh, lgbsc, tr, top] of sizes) {
    const { S, dom } = setup({ ww, hh });
    H.resizeHud();
    assert.strictEqual(S.lgbsc, lgbsc);
    const sc = lgbsc === 1;
    assert.deepStrictEqual(dom.writes, [
      ['loch', 'bottom', '16px'], ['lbf', 'bottom', '4px'], ['lbf', 'height', '37px'], ['lbh', 'right', '4px'],
      ['lbs', 'right', '4px'], ['lbn', 'right', '64px'], ['lbp', 'right', '260px'], ['loch', 'right', '16px'],
      ['login', 'width', ww + 'px']].concat(sc ? [['login', 'transform', tr], ['login', 'top', top]] :
      [['login', 'top', top], ['login', 'transform', tr]]));
  }
  // lgcsc from a running fade multiplies in; tiny heights are floored at 50 px
  const { S } = setup({ ww: 300, hh: 20 });
  S.lgcsc = 1.1;
  H.resizeHud();
  assert.strictEqual(S.lgbsc, 50 / 560);
  assert.strictEqual(S.login.style.transform, 'scale(' + Math.round(50 / 560 * 1.1 * 1E5) / 1E5 + ',' +
    Math.round(50 / 560 * 1.1 * 1E5) / 1E5 + ')');
});

// ---- optional menu hooks -------------------------------------------------------------------------------------------
test('menu hooks are optional and called where the menu writes sit', () => {
  const { S } = setup({ dead_mtm: 0, lb_fr: 1, playing: true, vfr: 125 });
  const seen = [];
  D.slLoop.hooks = { onMenuShow: () => seen.push('show'), onMenuFade: (v) => seen.push(['fade', v]),
    onMenuDone: () => seen.push('done') };
  S.login_fr = 1; S.login_iv = -1; S.mmal = 1;
  H.oefFades(1601);   // login_fr 1 - .004 * 125 = .5
  H.oefFades(1700);   // to 0: done
  assert.deepStrictEqual(seen, ['show', ['fade', 0.5], 'done', ['fade', 0]]);
  D.slLoop.hooks = {};
});

// ---- page shell (DWH 4, brief 10.8) --------------------------------------------------------------------------------
test('sl.html: no doctype, their viewport, body order, loch children inline, lastscore text, script order', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'sl.html'), 'utf8');
  assert.ok(html.startsWith('<html xmlns="http://www.w3.org/1999/xhtml">'), 'no doctype: quirks mode like theirs');
  assert.ok(html.indexOf('<!') < 0);
  assert.ok(html.indexOf('<meta name="viewport" content="minimal-ui, user-scalable=no, initial-scale=0.7, ' +
    'maximum-scale=0.7, width=device-width" />') > 0);
  assert.ok(html.indexOf('<body style="background: #161c22;">') > 0);
  assert.ok(html.toLowerCase().indexOf('slither') < 0, 'no slither.io text on the page');
  const labels = [];
  html.replace(/data-sl="([^"]+)"/g, (m, l) => { labels.push(l); return m; });
  assert.deepStrictEqual(labels, ['login', 'lastscore', 'mc', 'lbh', 'lbs', 'lbn', 'lbp', 'lbf', 'vcm', 'loch', 'loc', 'asmc',
    'asmc2', 'sid_tf', 'myloc']);
  // loch children: no whitespace between them, loc / asmc / asmc2 / myloc carry only data-sl
  assert.ok(/<div data-sl="loch"[^>]*><img data-sl="loc"><canvas data-sl="asmc"><\/canvas><canvas data-sl="asmc2"><\/canvas><div data-sl="sid_tf" class="nsi" style='[^']*'><\/div><img data-sl="myloc"><\/div>/.test(html));
  const sid = /data-sl="sid_tf" class="nsi" style='([^']*)'/.exec(html)[1];
  assert.strictEqual(sid, 'position: absolute; left: 0px; top: 0px; width: 200px; height: 37px; color: rgb(255, 255, 255); ' +
    'font-family: Arial, "Helvetica Neue", Helvetica, sans-serif; font-size: 14px; overflow: hidden; opacity: 0.5; ' +
    'text-align: center; cursor: default; text-shadow: rgb(0, 0, 0) 0px 1px 8px; transform: translateZ(0px);');
  // lastscore content: newline, 3 spaces, &nbsp;, newline, 2 spaces
  const ls = /<div id="lastscore"[^>]*>([\s\S]*?)<\/div>/.exec(html)[1].replace(/\r\n/g, '\n');
  assert.strictEqual(ls, '\n   &nbsp;\n  ');
  // canvases carry no id (the harness names unnamed canvases by id)
  assert.ok(!/<canvas[^>]*\sid=/.test(html));
  const scripts = [];
  html.replace(/<script src="([^"]+)"><\/script>/g, (m, s) => { scripts.push(s); return m; });
  assert.deepStrictEqual(scripts, ['/socket.io/socket.io.js', '/shared/slCore.js', '/shared/slWire.js', '/js/sl/slApply.js',
    '/js/sl/slSprites.js', '/js/sl/slDrawWorld.js', '/js/sl/slDrawSnake.js', '/js/sl/slHud.js', '/js/sl/slLoop.js',
    '/js/sl/slPage.js', '/js/sl/slInput.js', '/js/sl/slNet.js', '/js/sl/slMain.js']);
  assert.ok(html.indexOf('href="/css/sl.css"') > 0);
  const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'sl.css'), 'utf8').replace(/\s+/g, ' ').trim();
  assert.strictEqual(css, '.nsi { -webkit-user-select: none; -khtml-user-select: none; -moz-user-select: none; ' +
    '-o-user-select: none; user-select: none; }');
});

test('slHud.js hygiene: no Math.random, no devicePixelRatio, no imageSmoothingEnabled, nothing from the reference', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'sl', 'slHud.js'), 'utf8');
  for (const bad of ['Math.random', 'devicePixelRatio', 'imageSmoothingEnabled', 'slither-reference', 'require(']) {
    assert.ok(src.indexOf(bad) < 0, bad);
  }
  assert.ok(src.indexOf(String.fromCharCode(0x2014)) < 0, 'no em dash');
});
