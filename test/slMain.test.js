// slMain: boot and Play (build brief 10.2, 10.3, 10.5, 10.6, 11 card "slMain").
// Loads every product script of sl.html, in its order, into a vm context with a small fake DOM, the way the page
// does. slMain boots at load. The test wraps each module's load step to see the boot order and to check that the
// init chain defines every key of S once (brief 10.3).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const ORDER = ['shared/slCore.js', 'shared/slWire.js', 'public/js/sl/slApply.js', 'public/js/sl/slSprites.js', 'public/js/sl/slDrawWorld.js',
  'public/js/sl/slDrawSnake.js', 'public/js/sl/slHud.js', 'public/js/sl/slLoop.js', 'public/js/sl/slPage.js', 'public/js/sl/slInput.js',
  'public/js/sl/slNet.js', 'public/js/sl/slMain.js'];
const SRC = ORDER.map((f) => [f, fs.readFileSync(path.join(ROOT, f), 'utf8')]);

// Brief 10.5 boot order.
const BOOT = ['slApply.initApplyState', 'slLoop.initLoopState', 'slLoop.buildTables', 'slInput.initInputState', 'slPage.init', 'slHud.init',
  'slDrawWorld.init', 'slSprites.buildSprites', 'slDrawSnake.initDrawSnake', 'slLoop.start', 'slInput.install', 'slPage.install'];
const INITS = BOOT.slice(0, 9);

// Brief 10.3: shared keys and their load values (all set by slApply.initApplyState).
const LOAD = { gsc: 0.9 * 18 / 14, sgsc: 0.9 * 18 / 14, render_mode: 2, follow_view: true, fvx: 0, fvy: 0, fvpos: 0, fvtg: 0, view_xx: 0, view_yy: 0,
  lagging: false, lag_mult: 1, wfpr: false, lb_fr: 0, dead_mtm: -1, playing: false, connected: false, connecting: false, mmsta: 0.475, mmrad: -1,
  mmsz: -1, mmdata: null, mmgad: false, mmbfr: 0, bgx2: 0, bgy2: 0, bgw2: 599, bgh2: 519, my_nick: '', rank: 0, best_rank: 999999999 };

function fakeCtx() {
  const t = {};
  return new Proxy(t, {
    get(o, p) {
      if (p in o) return o[p];
      if (p === 'getImageData') return (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
      if (p === 'createImageData') return (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
      if (p === 'createPattern' || p === 'createRadialGradient' || p === 'createLinearGradient') return () => ({ addColorStop() {} });
      if (p === 'measureText') return () => ({ width: 0 });
      return () => {};
    },
    set(o, p, v) { o[p] = v; return true; }
  });
}
function makeEl(tag, label) {
  const el = { tagName: tag.toUpperCase(), style: {}, label, className: '', textContent: '', innerHTML: '' };
  if (tag === 'canvas') {
    el.width = 300;
    el.height = 150;
    el.getContext = () => el.ctx || (el.ctx = fakeCtx());
    el.toDataURL = () => 'data:image/png;base64,AAAA';
  }
  if (tag === 'img') { el.src = ''; el.onload = null; }
  return el;
}

function load(opts) {
  opts = opts || {};
  const order = [];
  const firstBy = new Map();
  const twice = [];
  const listeners = [];
  const raf = [];
  const byLabel = {};
  let phase = null;   // the load step running now (writes outside a step are not checked)
  const doc = {
    readyState: 'complete',
    querySelector(sel) {
      const m = /^\[data-sl="([^"]+)"\]$/.exec(sel);
      if (!m) return null;
      const tag = m[1] === 'mc' || m[1] === 'asmc' || m[1] === 'asmc2' ? 'canvas' : m[1] === 'loc' || m[1] === 'myloc' ? 'img' : 'div';
      return byLabel[m[1]] || (byLabel[m[1]] = makeEl(tag, m[1]));
    },
    createElement: (tag) => makeEl(tag, null)
  };
  const ctx = {
    console, Math, JSON, Date, Error, TypeError, RangeError, String, Number, Array, Object, Uint8Array, Uint8ClampedArray, Float32Array,
    Float64Array, Int8Array, Int16Array, Uint16Array, Int32Array, Uint32Array, ArrayBuffer, DataView, Map, Set, Proxy, isFinite, isNaN, parseFloat, parseInt,
    document: doc, innerWidth: 1280, innerHeight: 720,
    navigator: { userAgent: opts.ua || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36', language: 'en-US', platform: opts.platform || 'Win32' },
    performance: { now: () => 0 },
    localStorage: {},
    requestAnimationFrame: (f) => { raf.push(f); return raf.length; },
    setInterval: () => 1, clearInterval: () => {}, setTimeout: () => 1, clearTimeout: () => {},
    addEventListener: (t, f) => listeners.push(t)
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  const before = new Set(Object.keys(ctx));
  for (const [f, src] of SRC) {
    if (f.endsWith('slMain.js')) wrap(ctx.DuelSlither);
    vm.runInContext(src, ctx, { filename: f });
  }
  // Wrap each load step: record the order, and record which step defines each key of S first.
  function wrap(D) {
    for (const name of BOOT) {
      const [m, fn] = name.split('.');
      const orig = D[m][fn];
      D[m][fn] = function () {
        order.push(name);
        const args = Array.prototype.slice.call(arguments);
        if (INITS.indexOf(name) < 0) return orig.apply(this, args);
        if (args[0] && typeof args[0] === 'object') args[0] = watch(args[0]);
        phase = name;
        try { return orig.apply(this, args); } finally { phase = null; }
      };
    }
  }
  // Only writes made while a load step runs count; each key must be first defined by exactly one step.
  function watch(S) {
    return new Proxy(S, {
      set(o, k, v) {
        if (phase !== null) {
          if (!firstBy.has(k)) firstBy.set(k, phase);
          else if (firstBy.get(k) !== phase) twice.push(k + ' (' + firstBy.get(k) + ', then ' + phase + ')');
        }
        o[k] = v;
        return true;
      }
    });
  }
  const added = Object.keys(ctx).filter((k) => !before.has(k));
  return { ctx, D: ctx.DuelSlither, order, firstBy, twice, listeners, raf, added, byLabel, doc };
}

let shared = null;   // one boot shared by the tests that only read it (a boot builds every sprite: about 1 s)
function booted() { return shared || (shared = load()); }

test('boot runs at load in the brief 10.5 order', () => {
  const r = booted();
  assert.deepStrictEqual(r.order.slice(), BOOT);
  assert.strictEqual(r.D.booted, true);
  assert.strictEqual(r.raf.length, 1, 'slLoop.start arms one animation frame');
});

test('the init chain defines every key of S once (brief 10.3)', () => {
  const r = booted();
  assert.deepStrictEqual(r.twice.slice(), []);
  assert.ok(r.firstBy.size > 200, 'keys seen: ' + r.firstBy.size);
  assert.strictEqual(r.firstBy.get('p12'), 'slLoop.buildTables');
  assert.strictEqual(r.firstBy.get('mc'), 'slPage.init');
  assert.strictEqual(r.firstBy.get('bg_hex'), 'slDrawWorld.init');
  assert.strictEqual(r.firstBy.get('pbx'), 'slDrawSnake.initDrawSnake');
  assert.strictEqual(r.firstBy.get('per_color_imgs'), 'slSprites.buildSprites');
});

test('shared keys have the brief 10.3 load values, set by slApply', () => {
  const r = booted();
  const S = r.D.S;
  for (const k of Object.keys(LOAD)) {
    assert.ok(Object.is(S[k], LOAD[k]) || (k === 'gsc' && S[k] === S.sgsc), k + ' = ' + S[k]);
    if (k !== 'sgsc') assert.strictEqual(r.firstBy.get(k), 'slApply.initApplyState', k);
  }
});

test('never defined on S: msl, snake_id, snake_count (brief fact 24)', () => {
  const S = booted().D.S;
  for (const k of ['msl', 'snake_id', 'snake_count']) assert.ok(!(k in S), k);
});

test('environment flags: desktop Chrome on Windows', () => {
  const S = booted().D.S;
  assert.strictEqual(S.is_mobile, false);
  assert.strictEqual(S.nsr, false);
  assert.strictEqual(S.lang, 'en');
});

test('nsr: Chrome on Mac OS X 10.11 or older only (game.js:47-76, 103-106)', () => {
  const mac = (v) => 'Mozilla/5.0 (Macintosh; Intel Mac OS X ' + v + ') AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
  assert.strictEqual(load({ ua: mac('10_11_6'), platform: 'MacIntel' }).D.S.nsr, true);
  assert.strictEqual(load({ ua: mac('10_12_6'), platform: 'MacIntel' }).D.S.nsr, false);
  assert.strictEqual(load({ ua: mac('10_11_6'), platform: 'Win32' }).D.S.nsr, false);
  const mobile = load({ ua: 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36' }).D.S;
  assert.strictEqual(mobile.is_mobile, true);
  assert.strictEqual(mobile.render_mode, 1);
});

test('the load-time resize sized the canvas (1280 x 720 gives 1500 x 845)', () => {
  const S = booted().D.S;
  assert.strictEqual(S.mc.width, 1500);
  assert.strictEqual(S.mc.height, 845);
  assert.strictEqual(S.csc, 0.8520710059171598);
});

test('window: only DuelSlither plus their handler properties; a mouseup listener', () => {
  const r = booted();
  assert.deepStrictEqual(r.added.slice().sort(), ['DuelSlither', 'oncontextmenu', 'onmousedown', 'onmousemove', 'onresize', 'ontouchend', 'ontouchmove', 'ontouchstart']);
  assert.deepStrictEqual(r.listeners.slice(), ['mouseup']);
  assert.strictEqual(typeof r.doc.onkeydown, 'function');
  assert.strictEqual(typeof r.doc.onkeyup, 'function');
  assert.deepStrictEqual(Object.keys(r.D).sort(), ['S', 'boot', 'booted', 'play', 'rand', 'slApply', 'slCore', 'slDrawSnake', 'slDrawWorld', 'slHud',
    'slInput', 'slLoop', 'slMain', 'slNet', 'slPage', 'slSprites', 'slWire', 'stats']);
});

test('boot runs once; play sets want_play and keeps the name until the socket opens (game.js:1364-1374)', () => {
  const r = load();
  r.D.boot({});
  assert.strictEqual(r.order.filter((x) => x === 'slApply.initApplyState').length, 1);
  r.D.play('Owen');
  assert.strictEqual(r.D.S.want_play, true);
  assert.strictEqual(r.D.slMain.nick, 'Owen');
  r.D.play('Other');
  assert.strictEqual(r.D.slMain.nick, 'Owen', 'a second Play while want_play is ignored');
});

test('stats start at zero', () => {
  const st = booted().D.stats;
  assert.strictEqual(JSON.stringify(st), '{"messages":0,"events":0,"wireBytes":0,"wireErrors":0,"applyThrows":0}');
});

test('Math.random appears only in rand, in slMain; no devicePixelRatio, no imageSmoothingEnabled, no em dash', () => {
  for (const [f, src] of SRC) {
    const n = (src.match(/Math\.random/g) || []).length;
    assert.strictEqual(n, f.endsWith('slMain.js') ? 1 : 0, f);
    assert.ok(!/devicePixelRatio|imageSmoothingEnabled/.test(src.replace(/\/\/.*$/gm, '')), f);
    assert.ok(!/—/.test(src), f);
  }
  const r = load();
  const calls = [];
  r.ctx.Math = Object.assign(Object.create(Math), { random: () => { calls.push(1); return 0.25; } });
  assert.strictEqual(r.D.rand(), 0.25);
  assert.strictEqual(calls.length, 1, 'rand looks Math.random up at call time');
});
