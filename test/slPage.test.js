'use strict';
// slPage (build brief section 11 "slPage", spec loop-page-input.md 5 and 9.2 P1, P2, Y5; draw-world-hud.md 9.17).
// Every expected number below was produced by running THEIR resize() in a node vm (reference side);
// they are copied here as literals and compared with ===. No DOM library: a fake window, document and
// canvas record every write the module makes.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'public', 'js', 'sl', 'slPage.js');
const SRC = fs.readFileSync(FILE, 'utf8');

// Runs the browser file with `window` bound to a fake, so each test gets a fresh module.
function load(win) {
  new Function('window', SRC)(win);
  return win.DuelSlither;
}

function fakeCanvas(log) {
  let w = 850;
  let h = 700;
  const ctx = { tag: 'ctx2d' };
  const styleStore = {};
  const style = new Proxy(styleStore, {
    set(t, k, v) { t[k] = v; log.push('style.' + String(k) + '=' + v); return true; }
  });
  const mc = {
    style,
    getContext(kind) { log.push('getContext:' + kind); return ctx; },
    get width() { return w; },
    set width(v) { w = v; log.push('mc.width=' + v); },
    get height() { return h; },
    set height(v) { h = v; log.push('mc.height=' + v); }
  };
  return { mc, ctx, styleStore };
}

function setup(iw, ih) {
  const log = [];
  const cv = fakeCanvas(log);
  const win = {
    innerWidth: iw,
    innerHeight: ih,
    document: {
      querySelector(sel) { log.push('query:' + sel); return sel === '[data-sl="mc"]' ? cv.mc : null; }
    }
  };
  const D = load(win);
  const S = {};
  D.S = S;
  D.slHud = { resizeHud() { log.push('resizeHud'); } };
  D.slDrawWorld = {
    rebuildGbg() { log.push('rdgbg'); },
    redraw() { log.push('redraw'); }
  };
  D.slPage.init(S);
  log.length = 0;
  return { D, S, win, log, mc: cv.mc, ctx: cv.ctx, style: cv.styleStore };
}

function resizeTo(r, iw, ih) {
  r.win.innerWidth = iw;
  r.win.innerHeight = ih;
  r.log.length = 0;
  r.D.slPage.resize();
  return r.log.slice();
}

test('script load touches nothing but DuelSlither.slPage', () => {
  const win = {};
  Object.defineProperty(win, 'document', { get() { throw new Error('DOM read at load'); } });
  const D = load(win);
  assert.deepStrictEqual(Object.keys(win), ['DuelSlither']);
  assert.deepStrictEqual(Object.keys(D.slPage).sort(), ['init', 'install', 'resize']);
});

test('init binds the data-sl mc canvas and the load-time globals (game.js:1406-1425, 6822-6827)', () => {
  const log = [];
  const cv = fakeCanvas(log);
  const win = { innerWidth: 1279.5, innerHeight: 719.2, document: { querySelector: (s) => (s === '[data-sl="mc"]' ? cv.mc : null) } };
  const D = load(win);
  const S = {};
  D.slPage.init(S);
  assert.strictEqual(S.mc, cv.mc);
  assert.strictEqual(S.ctx, cv.ctx);
  assert.deepStrictEqual(log, ['getContext:2d']); // no size or style write at init
  const want = { mww: 850, mhh: 700, mwwp50: 900, mhhp50: 750, mwwp150: 1000, mhhp150: 850, mww2: 425, mhh2: 350,
    ww: 1279.5, hh: 719.2, lww: 0, lhh: 0, hsu: 0, wsu: 0 };
  for (const k of Object.keys(want)) assert.strictEqual(S[k], want[k], k);
  assert.ok('csc' in S);
  assert.strictEqual(S.csc, undefined);
  assert.deepStrictEqual(Object.keys(S).sort(), ['csc', 'ctx', 'hh', 'hsu', 'lhh', 'lww', 'mc', 'mhh', 'mhh2', 'mhhp150',
    'mhhp50', 'mww', 'mww2', 'mwwp150', 'mwwp50', 'wsu', 'ww'].sort());
});

test('init throws a clear error when sl.html has no mc canvas', () => {
  const win = { innerWidth: 1, innerHeight: 1, document: { querySelector: () => null } };
  const D = load(win);
  assert.throws(() => D.slPage.init({}), /data-sl="mc"/);
});

// LPI 9.2 P1 plus DWH 9.17 (844 x 390, 1000 x 500): first call in a fresh page.
const P1 = [
  [1280, 720, 1280, 720, 1500, 845, 750, 422.5, 0.8520710059171598, '-110px', '-63px'],
  [1920, 1080, 1920, 1080, 1500, 845, 750, 422.5, 1.2781065088757397, '210px', '117px'],
  [1366, 768, 1366, 768, 1500, 844, 750, 422, 0.909952606635071, '-67px', '-38px'],
  [800, 600, 800, 600, 1440, 1080, 720, 540, 0.5555555555555556, '-320px', '-240px'],
  [1440, 900, 1440, 900, 1500, 938, 750, 469, 0.9594882729211087, '-30px', '-19px'],
  [390, 844, 390, 844, 695, 1500, 347.5, 750, 0.5611510791366906, '-153px', '-328px'],
  [2560, 1440, 2560, 1440, 1500, 845, 750, 422.5, 1.7041420118343196, '530px', '297px'],
  [1000, 2000, 1000, 2000, 750, 1500, 375, 750, 1.3333333333333333, '125px', '250px'],
  [1279.5, 719.2, 1280, 720, 1500, 845, 750, 422.5, 0.8520710059171598, '-110px', '-63px'],
  [844, 390, 844, 390, 1500, 695, 750, 347.5, 0.5611510791366906, '-328px', '-153px'],
  [1000, 500, 1000, 500, 1500, 750, 750, 375, 0.6666666666666666, '-250px', '-125px']
];

for (const [iw, ih, ww, hh, mww, mhh, mww2, mhh2, csc, left, top] of P1) {
  test('P1 first resize at ' + iw + ' x ' + ih, () => {
    const r = setup(850, 700);
    const calls = resizeTo(r, iw, ih);
    const S = r.S;
    assert.strictEqual(S.ww, ww);
    assert.strictEqual(S.hh, hh);
    assert.strictEqual(S.lww, ww);
    assert.strictEqual(S.lhh, hh);
    assert.strictEqual(S.hsu, 0);
    assert.strictEqual(S.mww, mww);
    assert.strictEqual(S.mhh, mhh);
    assert.strictEqual(S.mww2, mww2);
    assert.strictEqual(S.mhh2, mhh2);
    assert.strictEqual(S.mwwp50, mww + 50);
    assert.strictEqual(S.mhhp50, mhh + 50);
    assert.strictEqual(S.mwwp150, mww + 150);
    assert.strictEqual(S.mhhp150, mhh + 150);
    assert.strictEqual(S.csc, csc);
    assert.strictEqual(r.mc.width, mww);
    assert.strictEqual(r.mc.height, mhh);
    const tr = 'scale(' + csc + ',' + csc + ')';
    assert.strictEqual(r.style.transform, tr);
    assert.strictEqual(r.style.left, left);
    assert.strictEqual(r.style.top, top);
    // their order: HUD writes, mc.width, mc.height, rdgbg, transform, left, top, then redraw
    assert.deepStrictEqual(calls, ['resizeHud', 'mc.width=' + mww, 'mc.height=' + mhh, 'rdgbg',
      'style.transform=' + tr, 'style.left=' + left, 'style.top=' + top, 'redraw']);
  });
}

test('P1 transform string example (LPI 9.2)', () => {
  const r = setup(850, 700);
  resizeTo(r, 1280, 720);
  assert.strictEqual(r.style.transform, 'scale(0.8520710059171598,0.8520710059171598)');
});

test('P2 an unchanged size only redraws', () => {
  const r = setup(850, 700);
  resizeTo(r, 1280, 720);
  const csc = r.S.csc;
  const calls = resizeTo(r, 1280, 720);
  assert.deepStrictEqual(calls, ['redraw']);
  assert.strictEqual(r.S.csc, csc);
  assert.strictEqual(r.S.mww, 1500);
});

test('P2 fractional sizes that round up to the same size only redraw', () => {
  const r = setup(850, 700);
  resizeTo(r, 1280, 720);
  assert.deepStrictEqual(resizeTo(r, 1279.5, 719.2), ['redraw']);
});

// LPI 9.5 Y5: one page, four resizes.
test('Y5 resize sequence: same backing size rewrites csc and position only', () => {
  const r = setup(850, 700);
  const want = [
    [1280, 720, ['mc.width=1500', 'mc.height=845', 'rdgbg', 'redraw'], 0.8520710059171598, '-110px', '-63px'],
    [1920, 1080, ['redraw'], 1.2781065088757397, '210px', '117px'],
    [1920, 1080, ['redraw'], 1.2781065088757397, '210px', '117px'],
    [800, 600, ['mc.width=1440', 'mc.height=1080', 'rdgbg', 'redraw'], 0.5555555555555556, '-320px', '-240px']
  ];
  let i = 0;
  for (const [iw, ih, calls, csc, left, top] of want) {
    const got = resizeTo(r, iw, ih).filter((c) => c === 'redraw' || c === 'rdgbg' || c.startsWith('mc.'));
    assert.deepStrictEqual(got, calls, 'step ' + i);
    assert.strictEqual(r.S.csc, csc, 'csc step ' + i);
    assert.strictEqual(r.style.left, left);
    assert.strictEqual(r.style.top, top);
    assert.strictEqual(r.style.transform, 'scale(' + csc + ',' + csc + ')');
    i++;
  }
});

test('Y5 the same-backing step still writes the HUD and the style, not the canvas size', () => {
  const r = setup(850, 700);
  resizeTo(r, 1280, 720);
  assert.deepStrictEqual(resizeTo(r, 1920, 1080), ['resizeHud', 'style.transform=scale(1.2781065088757397,1.2781065088757397)',
    'style.left=210px', 'style.top=117px', 'redraw']);
});

test('wsu is cut from ww after lww is stored (game.js:6833-6849)', () => {
  const r = setup(850, 700);
  r.S.wsu = 20;
  resizeTo(r, 1300, 720);
  assert.strictEqual(r.S.lww, 1300);
  assert.strictEqual(r.S.ww, 1280);
  assert.strictEqual(r.S.csc, 0.8520710059171598);
  assert.strictEqual(r.style.left, '-110px');
  assert.deepStrictEqual(resizeTo(r, 1300, 720), ['redraw']);
});

test('install sets window.onresize, then runs the load-time resize once', () => {
  const r = setup(850, 700);
  r.win.innerWidth = 1280;
  r.win.innerHeight = 720;
  r.D.slPage.install();
  assert.strictEqual(typeof r.win.onresize, 'function');
  assert.deepStrictEqual(r.log, ['resizeHud', 'mc.width=1500', 'mc.height=845', 'rdgbg',
    'style.transform=scale(0.8520710059171598,0.8520710059171598)', 'style.left=-110px', 'style.top=-63px', 'redraw']);
  r.log.length = 0;
  r.win.innerWidth = 1920;
  r.win.innerHeight = 1080;
  r.win.onresize();
  assert.strictEqual(r.S.csc, 1.2781065088757397);
  assert.strictEqual(r.log[r.log.length - 1], 'redraw');
});

test('collaborators are looked up on DuelSlither at call time', () => {
  const r = setup(850, 700);
  const seen = [];
  r.D.slDrawWorld = { rebuildGbg() { seen.push('gbg2'); }, redraw() { seen.push('redraw2'); } };
  r.D.slHud = { resizeHud() { seen.push('hud2'); } };
  resizeTo(r, 800, 600);
  assert.deepStrictEqual(seen, ['hud2', 'gbg2', 'redraw2']);
});

test('clean-room hygiene: no random, no devicePixelRatio, no smoothing write, no reference import', () => {
  assert.ok(!/Math\.random/.test(SRC));
  assert.ok(!/devicePixelRatio/.test(SRC));
  assert.ok(!/imageSmoothingEnabled/.test(SRC));
  assert.ok(!/slither-reference/.test(SRC));
  assert.ok(!/require\(/.test(SRC));
  assert.ok(!SRC.includes(String.fromCharCode(0x2014)));
});
