'use strict';
// slLoop (slither redo, build brief section 11 card "slLoop", spec loop-page-input.md section 9).
// Every expected number below was computed on the reference side by running their client's own
// lines in a vm; they are copied here as literals. slLoop.js is loaded into a fresh vm context per
// test with a fake clock and fake requestAnimationFrame; every other module it calls (slApply,
// slHud, slInput, slNet, slDrawWorld) is a small stub on DuelSlither, so only slLoop's own steps
// are tested. Numbers compare with Object.is (assert.strictEqual).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FILE = path.join(__dirname, '..', 'public', 'js', 'sl', 'slLoop.js');
const SRC = fs.readFileSync(FILE, 'utf8');

function load(opts) {
  opts = opts || {};
  const box = { clock: 0, rafs: [], nowCalls: 0 };
  const ctx = {
    performance: { now() { box.nowCalls++; return box.clock; } },
    requestAnimationFrame(fn) { box.rafs.push(fn); return box.rafs.length; },
  };
  if (opts.storage === 'throw') Object.defineProperty(ctx, 'localStorage', { get() { throw new Error('blocked'); } });
  else if (opts.storage) ctx.localStorage = opts.storage;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: 'slLoop.js' });
  return { ctx, D: ctx.DuelSlither, box };
}

// Ease tables (owned by slApply; built here only to feed rings like the packets do). Formulas from
// the spec (section 3), checked against its section 9.1 values in the 'feed tables' test.
function easeF32(n) {
  const t = new Float32Array(n);
  for (let i = 0; i < n; i++) t[i] = .5 * (1 - Math.cos(Math.PI * (n - 1 - i) / (n - 1)));
  return t;
}
const LFAS = easeF32(53); // = rfas = hfas
const AFAS = easeF32(26);
const VFAS = [];
for (let i = 0; i < 62; i++) {
  let j = .5 * (1 - Math.cos(Math.PI * (62 - 1 - i) / (62 - 1)));
  j += (.5 * (1 - Math.cos(Math.PI * j)) - j) * .5;
  VFAS.push(j);
}
const FLXAS = [];
for (let i = 0; i < 56; i++) FLXAS.push(.5 * (1 - Math.cos(Math.PI * i / (56 - 1))));

function deadpool() {
  return {
    os: [], end_pos: 0,
    add(o) { if (this.end_pos == this.os.length) this.os.push(o); else this.os[this.end_pos] = o; this.end_pos++; },
  };
}

// The spec's "standard snake" and body point (section 9 common setup).
function mkSnake(extra) {
  return Object.assign({
    id: 1, xx: 1000, yy: 1000, fx: 0, fy: 0, chl: 0, fchl: 0, tsp: 0, sfr: 0, sc: 1, ssp: 4.75, fsp: 4.85, msp: 12, msl: 42,
    fxs: new Float32Array(53), fys: new Float32Array(53), fchls: new Float32Array(53), fpos: 0, ftg: 0,
    fas: new Float32Array(26), fapos: 0, fatg: 0, fa: 0, ehang: 0, wehang: 0, ehl: 1, fam: 0, rsc: 0, ang: 0, eang: 0, wang: 0,
    rex: 0, rey: 0, sp: 2, pts: [], sct: 0, flpos: 0, fls: new Float32Array(53), fl: 0, fltg: 0, tl: 0, cfl: -.6, scang: 1,
    spang: 1, dead_amt: 0, alive_amt: 0, pma: 2.3, na: 1, fnfr: 0,
  }, extra || {});
}
function mkPoint(xx, yy, extra) {
  return Object.assign({ xx, yy, fx: 0, fy: 0, ltn: 1, fltn: 0, smu: 1, fsmu: 0, dying: false, da: 0, ebx: 0, eby: 0, iang: 0,
    fpos: 0, ftg: 0, fxs: new Float32Array(53), fys: new Float32Array(53), fltns: new Float32Array(53), fsmus: new Float32Array(53) }, extra || {});
}

// Standard env: frame k runs oef at ctm 1000 + 16.6667 * k, connected and playing, a pong before
// every frame unless turned off, slither null, render_mode 2, gsc = sgsc, mww2 750, mhh2 422.5.
function env(over, opts) {
  const L = load(opts);
  const { D, box } = L;
  const log = [];
  const S = {};
  D.S = S;
  const sgsc = .9 * 18 / 14;
  // keys slApply / slPage / slInput initialize (values of the spec's standard env)
  Object.assign(S, {
    grd: 16384, mamu: .033, mamu2: .028, render_mode: 2, sgsc, gsc: sgsc, follow_view: true, protocol_version: 15,
    slithers: [], slither: null, foods: [], foods_c: 0, cm1: 0, preys: [], points_dp: deadpool(),
    dead_mtm: -1, lb_fr: 1, view_xx: 0, view_yy: 0, fvx: 0, fvy: 0, fvxs: new Array(62).fill(0), fvys: new Array(62).fill(0),
    fvpos: 0, fvtg: 0, lagging: false, lag_mult: 1, wfpr: false, etm: 0, playing: true, connected: true, connecting: false,
    want_close_socket: false, flux_grd: 16000, real_flux_grd: 16000, flux_grds: [], flux_grd_pos: 0, flx_tg: -1,
    rdps: 0, apkps: 0, pkps: 0, mww2: 750, mhh2: 422.5, last_ping_mtm: 0, lpstm: 0,
  });
  D.slLoop.initLoopState(S);
  D.slLoop.buildTables(S);
  Object.assign(S, { lrd_mtm: 0, fps: 0, animating: true });
  Object.assign(S, over || {});
  let pre = null;
  const rec = (name) => function () { log.push([name].concat(Array.from(arguments))); };
  D.slApply = {
    resetGame: rec('resetGame'),
    // the container rule of brief section 9 (shared cm1)
    foodRemoveAt(i) {
      log.push(['foodRemoveAt', i]);
      if (i == S.cm1) S.foods[i] = null;
      else { S.foods[i] = S.foods[S.cm1]; S.foods[S.cm1] = null; }
      S.foods_c--; S.cm1--;
    },
  };
  D.slHud = { oefFades: rec('oefFades'), oefMinimap: rec('oefMinimap'), oefDot: rec('oefDot') };
  D.slInput = { accumulateArrowTicks: rec('accumulateArrowTicks'), stepArrowKeys: rec('stepArrowKeys'), stepPing: rec('stepPing'),
    stepBoostAndAngle: rec('stepBoostAndAngle') };
  D.slNet = { connect: rec('connect'), hasSocket() { return true; }, closeSocket: rec('closeSocket') };
  D.slDrawWorld = { redraw() {
    pre = { vfr: S.vfr, vfrb: S.vfrb, avfr: S.avfr, fr: S.fr, lag_mult: S.lag_mult };
    log.push(['redraw']);
    D.slLoop.redrawPrologue();
  } };
  const R = {
    S, D, log, box, autoPong: true,
    frame(ctm, noPong) {
      if (!noPong && R.autoPong && S.wfpr) { S.wfpr = false; if (S.lagging) { S.etm *= S.lag_mult; S.lagging = false; } }
      box.clock = ctm;
      D.slLoop.oef();
      return pre;
    },
  };
  return R;
}
const at = (k) => 1000 + 16.6667 * k;
function eqList(actual, expected, label) {
  assert.strictEqual(actual.length, expected.length, label + ' length');
  for (let i = 0; i < expected.length; i++) assert.strictEqual(actual[i], expected[i], label + ' [' + i + ']');
}

test('module: one namespace, nothing runs at load, no banned calls', () => {
  const { ctx, D, box } = load();
  assert.deepStrictEqual(Object.keys(ctx).sort(), ['DuelSlither', 'performance', 'requestAnimationFrame']);
  assert.deepStrictEqual(Object.keys(D), ['slLoop']);
  assert.deepStrictEqual(Object.keys(D.slLoop).sort(),
    ['buildTables', 'hooks', 'initLoopState', 'now', 'oef', 'onSocketOpen', 'redrawPrologue', 'start']);
  assert.strictEqual(box.rafs.length, 0);
  assert.strictEqual(box.nowCalls, 0);
  assert.ok(!/Math\.random/.test(SRC));
  assert.ok(!/devicePixelRatio|imageSmoothingEnabled/.test(SRC));
  assert.ok(!SRC.includes('\u2014'));
  assert.ok(!/slither-reference/.test(SRC));
});

test('tables: p12 by iteration (9.1)', () => {
  const R = env();
  const p = R.S.p12;
  assert.strictEqual(Object.prototype.toString.call(p), '[object Float32Array]');
  assert.strictEqual(p.length, 250);
  const want = [[0, 0], [1, 0.11999999731779099], [2, 0.225600004196167], [3, 0.3185279965400696], [5, 0.47226807475090027],
    [10, 0.7214990258216858], [60, 0.9995333552360535], [249, 1]];
  for (const [i, v] of want) assert.strictEqual(p[i], v, 'p12[' + i + ']');
});

test('feed tables used by these tests match the spec (9.1)', () => {
  for (const [i, v] of [[0, 1], [1, 0.9990877509117126], [26, 0.5], [51, 0.0009122228948399425], [52, 0]]) assert.strictEqual(LFAS[i], v);
  for (const [i, v] of [[0, 1], [1, 0.9960573315620422], [12, 0.5313952565193176], [13, 0.4686047434806824], [24, 0.003942649345844984], [25, 0]]) assert.strictEqual(AFAS[i], v);
  for (const [i, v] of [[0, 1], [1, 0.9996679802484048], [30, 0.5165454040822839], [31, 0.483454595917716], [60, 0.00033201975159527497], [61, 0]]) assert.strictEqual(VFAS[i], v);
  for (const [i, v] of [[0, 0], [1, 0.0008154480369321759], [27, 0.48572197460315175], [28, 0.5142780253968481], [54, 0.9991845519630678], [55, 1]]) assert.strictEqual(FLXAS[i], v);
});

test('initLoopState: only slLoop keys, load values, want_quality from storage', () => {
  const { D, box } = load();
  const S = {};
  box.clock = 123.5;
  D.slLoop.initLoopState(S);
  const keys = ['fr', 'lfr', 'ltm', 'vfr', 'vfrb', 'avfr', 'afr', 'fr2', 'lfr2', 'vfrb2', 'high_quality', 'gla', 'wdfg', 'qsm', 'mqsm',
    'view_ang', 'view_dist', 'bpx1', 'bpy1', 'bpx2', 'bpy2', 'fpx1', 'fpy1', 'fpx2', 'fpy2', 'apx1', 'apy1', 'apx2', 'apy2',
    'animating', 'want_play', 'fgfr', 'fps', 'lrd_mtm', 'want_quality'];
  assert.deepStrictEqual(Object.keys(S).sort(), keys.slice().sort());
  assert.strictEqual(S.ltm, 123.5);
  assert.strictEqual(S.lrd_mtm, 123.5);
  for (const k of ['fr', 'lfr', 'vfr', 'vfrb', 'avfr', 'afr', 'fr2', 'lfr2', 'vfrb2', 'wdfg', 'view_ang', 'view_dist', 'fgfr', 'fps']) assert.strictEqual(S[k], 0, k);
  assert.strictEqual(S.high_quality, true);
  assert.strictEqual(S.gla, 1);
  assert.strictEqual(S.qsm, 1);
  assert.strictEqual(S.mqsm, 1.7);
  assert.strictEqual(S.animating, false);
  assert.strictEqual(S.want_play, false);
  assert.strictEqual(S.bpx1, undefined);
  assert.strictEqual(S.want_quality, 1); // no storage at all
  // never defines CA 1.4 keys or the non-globals of brief fact 24
  for (const k of ['gsc', 'lag_mult', 'lagging', 'view_xx', 'fvxs', 'render_mode', 'msl', 'snake_id', 'snake_count', 'p12']) assert.ok(!(k in S), k);
  const low = load({ storage: { qual: '0' } });
  const S2 = {}; low.D.slLoop.initLoopState(S2); assert.strictEqual(S2.want_quality, 0);
  const high = load({ storage: { qual: '1' } });
  const S3 = {}; high.D.slLoop.initLoopState(S3); assert.strictEqual(S3.want_quality, 1);
  const blocked = load({ storage: 'throw' });
  const S4 = {}; blocked.D.slLoop.initLoopState(S4); assert.strictEqual(S4.want_quality, 1);
});

test('start: animating, one rAF; oef re-arms rAF after redraw and zeroes vfr/vfrb', () => {
  const R = env({ ltm: 1000, animating: false });
  R.D.slLoop.start();
  assert.strictEqual(R.S.animating, true);
  assert.strictEqual(R.box.rafs.length, 1);
  assert.strictEqual(R.box.rafs[0], R.D.slLoop.oef);
  const p = R.frame(at(1));
  assert.strictEqual(p.vfr, 2.083337499999999);
  assert.strictEqual(R.S.vfr, 0);
  assert.strictEqual(R.S.vfrb, 0);
  assert.strictEqual(R.box.rafs.length, 2);
  assert.strictEqual(R.box.rafs[1], R.D.slLoop.oef);
});

test('L1 timing: vfr, vfrb, fr, afr, fr2', () => {
  const R = env({ ltm: 1000, connected: false, playing: false });
  const seq = [1016.6667, 1033.3334, 1050.0001, 1100.0001, 1100.0001, 1090];
  const vfr = [2.083337499999999, 2.083337499999999, 2.083337499999999, 5, 0, 0];
  const vfrb = [2, 2, 2, 5, 0, 0];
  const fr = [2.083337499999999, 4.166674999999998, 6.250012499999997, 11.250012499999997, 11.250012499999997, 11.250012499999997];
  const fr2 = [4.166674999999998, 8.333349999999996, 12.500024999999994, 22.500024999999994, 22.500024999999994, 22.500024999999994];
  seq.forEach((c, i) => {
    const p = R.frame(c);
    assert.strictEqual(p.vfr, vfr[i], 'vfr ' + i);
    assert.strictEqual(p.vfrb, vfrb[i], 'vfrb ' + i);
    assert.strictEqual(R.S.fr, fr[i], 'fr ' + i);
    assert.strictEqual(R.S.afr, fr[i], 'afr ' + i);
    assert.strictEqual(R.S.avfr, vfr[i], 'avfr ' + i);
    assert.strictEqual(R.S.fr2, fr2[i], 'fr2 ' + i);
    assert.strictEqual(R.S.vfr, 0);
    assert.strictEqual(R.S.vfrb, 0);
  });
});

test('L2 lag: decay per frame to .2, recovery +.05 per frame after the pong', () => {
  const R = env({ ltm: 723.3333, wfpr: true, last_ping_mtm: 0 });
  R.autoPong = false;
  const lags = [];
  const flags = [];
  const vfrs = [];
  for (let k = 0; k < 40; k++) {
    const c = 740 + 16.6667 * k;
    if (k === 30) { R.S.wfpr = false; if (R.S.lagging) { R.S.etm *= R.S.lag_mult; R.S.lagging = false; } R.S.wfpr = true; R.S.last_ping_mtm = c; }
    const p = R.frame(c, true);
    lags.push(p.lag_mult); flags.push(R.S.lagging); vfrs.push(p.vfr);
  }
  eqList(lags, [1, 0.85, 0.7224999999999999, 0.6141249999999999, 0.5220062499999999, 0.4437053124999999, 0.3771495156249999,
    0.32057708828124987, 0.2724905250390624, 0.23161694628320303, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2,
    0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.25, 0.3, 0.35, 0.39999999999999997, 0.44999999999999996, 0.49999999999999994,
    0.5499999999999999, 0.6, 0.65, 0.7000000000000001], 'lag_mult');
  assert.strictEqual(flags[0], false);
  assert.strictEqual(flags[1], true);
  assert.strictEqual(flags[29], true);
  assert.strictEqual(flags[30], false);
  assert.strictEqual(vfrs[1], 1.770836874999999);
  assert.strictEqual(vfrs[10], 0.4166674999999998);
  assert.strictEqual(vfrs[30], 0.5208343749999997);
  assert.strictEqual(R.S.etm, 0);
});

test('L3 turning: dir 1, dir 2, wraps, absent dir and dir 0', () => {
  const cases = [
    [1, 1, .5, [0.9312498625000001, 0.8624997250000002, 0.7937495875000002, 0.7249994500000003, 0.6562493125000004,
      0.5874991750000005, 0.5187490375000006, 0.5, 0.5, 0.5], [1, 1, 1, 1, 1, 1, 1, 0, 0, 0]],
    [2, .5, 1, [0.5687501374999999, 0.6375002749999998, 0.7062504124999998, 0.7750005499999997, 0.8437506874999996,
      0.9125008249999995, 0.9812509624999994, 1, 1, 1], [2, 2, 2, 2, 2, 2, 2, 0, 0, 0]],
    [1, .1, 6.2, [0.03124986250000003, 6.245685032179586, 6.2, 6.2, 6.2, 6.2, 6.2, 6.2, 6.2, 6.2], [1, 1, 0, 0, 0, 0, 0, 0, 0, 0]],
    [2, 6.2, .1, [6.2687501375000005, 0.05431496782041467, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1], [2, 2, 0, 0, 0, 0, 0, 0, 0, 0]],
    [undefined, 1, 2, new Array(10).fill(2), null],
    [0, 1, 2, new Array(10).fill(2), new Array(10).fill(0)],
  ];
  for (const [dir, a0, w, angs, dirs] of cases) {
    const R = env({ ltm: 1000 });
    const extra = { ang: a0, wang: w, sp: 4.8, spang: 1, scang: 1, sct: 10, tl: 10, cfl: 9.4 };
    if (dir !== undefined) extra.dir = dir;
    const o = mkSnake(extra);
    R.S.slithers = [o];
    for (let k = 1; k <= 10; k++) {
      R.frame(at(k));
      assert.strictEqual(o.ang, angs[k - 1], 'dir ' + dir + ' ang k' + k);
      if (dirs) assert.strictEqual(o.dir, dirs[k - 1], 'dir ' + dir + ' dir k' + k);
      else assert.ok(!('dir' in o), 'dir stays absent');
    }
  }
});

test('L4 eye chase by p12[vfrb], with the wrap case', () => {
  const R = env({ ltm: 1000 });
  const o = mkSnake({ ehang: 0, wehang: 1, sct: 10, tl: 10, cfl: 9.4 });
  R.S.slithers = [o];
  const times = [1016.6667, 1033.3334, 1041.3334, 1058.0001, 1074.6668];
  const vfrbs = [2, 2, 1, 2, 2];
  const eh = [0.225600004196167, 0.4003046464990234, 0.4722680873106323, 0.5913244090278049, 0.6835216240660031];
  times.forEach((c, i) => {
    const p = R.frame(c);
    assert.strictEqual(p.vfrb, vfrbs[i]);
    assert.strictEqual(o.ehang, eh[i]);
    assert.strictEqual(o.edir, 2);
  });
  const R2 = env({ ltm: 1000 });
  const o2 = mkSnake({ ehang: 6, wehang: .5, sct: 10, tl: 10, cfl: 9.4 });
  R2.S.slithers = [o2];
  const eh2 = [6.176686608586091, 0.030327410354167306, 0.13628554854909178];
  [1016.6667, 1033.3334, 1050.0001].forEach((c, i) => {
    R2.frame(c);
    assert.strictEqual(o2.ehang, eh2[i]);
    assert.strictEqual(o2.edir, 2);
  });
});

test('L5 speed ease, sfr, motion, chl, speed cap', () => {
  const R = env({ ltm: 1000 });
  const o = mkSnake({ sp: 11, tsp: 4.8, fsp: 4.85, ssp: 4.75, ang: .3, wang: .3, dir: 0, sct: 10, tl: 10, cfl: 9.4, xx: 1000, yy: 1000 });
  R.S.slithers = [o];
  const want = [
    [5.4201, 0.02494192488374999, 1005.4732929155127, 1001.6930879034996, 0.1364090029761904],
    [5.97819, 0.07430033610037497, 1010.9465858310255, 1003.3861758069993, 0.2728180059523808],
    [6.480471, 0.14563358501658744, 1016.4198787465382, 1005.0792637104989, 0.4092270089285712],
    [6.9325239, 0.23674418786242862, 1021.8931716620509, 1006.7723516139986, 0.5456360119047616],
  ];
  want.forEach((w, i) => {
    R.frame(at(i + 1));
    eqList([o.tsp, o.sfr, o.xx, o.yy, o.chl], w, 'k' + (i + 1));
  });
  o.sp = 4;
  const down = [[6.05266673, 0.2893609625332675], [5.436766711000001, 0.31503205748160473], [5.005636697700001, 0.3218411766241908]];
  down.forEach((w, i) => {
    R.frame(at(i + 5));
    eqList([o.tsp, o.sfr], w, 'down k' + (i + 5));
  });
  const R2 = env({ ltm: 1000 });
  const o2 = mkSnake({ sp: 200, tsp: 200, sct: 10, tl: 10, cfl: 9.4, msl: 42 });
  R2.S.slithers = [o2];
  R2.frame(1040);
  assert.strictEqual(o2.xx, 1042);
  assert.strictEqual(o2.chl, 1);
});

test('L6 length ring and cfl; the end step', () => {
  const R = env({ ltm: 1000 });
  const o = mkSnake({ sct: 10, fam: 0, tl: 10, cfl: 9.4 });
  R.S.slithers = [o];
  // the length feed of slApply's snl (spec 4.4 of core-apply), sct 10 -> 11, fam .25
  o.sct = 11; o.fam = .25;
  const orl = o.tl;
  o.tl = o.sct + Math.min(1, o.fam);
  const d = o.tl - orl;
  let k = o.flpos;
  for (let j = 0; j < 53; j++) { o.fls[k] -= d * LFAS[j]; k++; if (k >= 53) k = 0; }
  o.fl = o.fls[o.flpos]; o.fltg = 53;
  eqList([o.tl, o.fl, o.fltg, o.fls[0], o.fls[1]], [11.25, -1.25, 53, -1.25, -1.2488596439361572], 'after feed');
  const want = {
    1: [2, -1.2488596439361572, 9.401140356063843, 51], 2: [2, -1.2397624254226685, 9.410237574577332, 49],
    3: [2, -1.2217005491256714, 9.428299450874329, 47], 26: [2, 0, 10.65, 0], 27: [2, 0, 10.65, -1],
    28: [2, 0, 10.65, -1], 29: [2, 0, 10.65, -1], 30: [2, 0, 10.65, -1],
  };
  for (let f = 1; f <= 30; f++) {
    const p = R.frame(at(f));
    if (want[f]) eqList([p.vfrb, o.fl, o.cfl, o.fltg], want[f], 'k' + f);
  }
  const p = R.frame(at(30) + 1);
  eqList([o.fl, o.fltg, p.vfrb], [0, -1, 0], 'tiny frame');
});

test('L7 dying points: fade, splice from the 4th dying point, pool', () => {
  const R = env({ ltm: 1000 });
  const da = [0.99, 0.999, 0.5, 0.9995, 0.0, 0];
  const pts = [];
  for (let i = 0; i < 6; i++) { const p = mkPoint(1000 - 42 * (5 - i), 1000, { dying: i < 5, da: da[i] }); p.__i = i; pts.push(p); }
  const o = mkSnake({ pts, sct: 1, tl: 1, cfl: .4 });
  R.S.slithers = [o];
  const p = R.frame(1016.6667);
  assert.strictEqual(p.vfrb, 2);
  assert.deepStrictEqual(o.pts.map((q) => [q.__i, q.dying, q.da]), [[0, true, 0.993], [2, true, 0.503], [3, true, 1], [4, true, 0.003], [5, false, 0]]);
  assert.strictEqual(R.S.points_dp.end_pos, 1);
  assert.deepStrictEqual(R.S.points_dp.os.map((q) => [q.__i, q.dying, q.da]), [[1, false, 1]]);
});

test('L8 point, head and angle rings', () => {
  const R = env({ ltm: 1000 });
  const po = mkPoint(1000, 1000);
  for (let j = 0; j < 53; j++) { po.fxs[j] -= 10 * LFAS[j]; po.fltns[j] -= .5 * LFAS[j]; }
  po.fx = po.fxs[0]; po.fltn = po.fltns[0]; po.ftg = 53;
  const o = mkSnake({ pts: [po], sct: 1, tl: 1, cfl: .4 });
  for (let j = 0; j < 53; j++) { o.fxs[j] -= 7 * LFAS[j]; o.fchls[j] -= 1 * LFAS[j]; }
  o.fx = o.fxs[0]; o.fchl = o.fchls[0]; o.ftg = 53;
  for (let j = 0; j < 26; j++) o.fas[j] -= .4 * AFAS[j];
  o.fa = o.fas[0]; o.fatg = 26;
  R.S.slithers = [o];
  const want = {
    1: [2, -9.990877151489258, -0.4995438754558563, 51, -6.993614196777344, -0.9990877509117126, 51, -0.3984229266643524, 24],
    2: [2, -9.918099403381348, -0.49590498208999634, 49, -6.942669868469238, -0.9918099641799927, 49, -0.385955274105072, 22],
    12: [3, -5.6026835441589355, -0.2801341712474823, 28, -3.9218783378601074, -0.5602683424949646, 28, -0.0015770597383379936, 1],
    13: [2, -5, -0.25, 26, -3.5, -0.5, 26, 0, 0],
    14: [2, -4.3973164558410645, -0.2198658287525177, 24, -3.0781216621398926, -0.4397316575050354, 24, 0, -1],
    26: [2, 0, 0, 0, 0, 0, 0, 0, -1],
    27: [2, 0, 0, -1, 0, 0, -1, 0, -1],
    30: [2, 0, 0, -1, 0, 0, -1, 0, -1],
  };
  for (let f = 1; f <= 30; f++) {
    const p = R.frame(at(f));
    if (want[f]) eqList([p.vfrb, po.fx, po.fltn, po.ftg, o.fx, o.fchl, o.ftg, o.fa, o.fatg], want[f], 'k' + f);
  }
});

test('L9 pupils', () => {
  const R = env({ ltm: 1000 });
  const o = mkSnake({ eang: Math.PI / 2, pma: 2.3, rex: 0, rey: 0, sct: 1, tl: 1, cfl: .4 });
  R.S.slithers = [o];
  const want = [[1.408343819019456e-16, 0.3472229166666665], [1.408343819019456e-16, 0.694445833333333], [1.408343819019456e-16, 1.0416687499999995]];
  want.forEach((w, i) => { R.frame(at(i + 1)); eqList([o.rex, o.rey], w, 'k' + (i + 1)); });
});

test('L10 alive fade-in, dead fade-out, dead still turns, removal at 1', () => {
  const R = env({ ltm: 1000 });
  const a = mkSnake({ id: 2, alive_amt: 0, sct: 1, tl: 1, cfl: .4 });
  const d = mkSnake({ id: 3, dead: true, dead_amt: 0, dir: 1, ang: 1, wang: .5, xx: 500, yy: 500, sp: 5, sct: 1, tl: 1, cfl: .4 });
  R.S.slithers = [a, d];
  const want = {
    1: [0.03125006249999998, 0.04166674999999998, 0.9312498625000001, 500, 2],
    2: [0.06250012499999996, 0.08333349999999996, 0.8624997250000002, 500, 2],
    23: [0.7187514374999996, 0.9583352500000001, 0.5, 500, 2],
    24: [0.7500014999999995, 1.000002, 0.5, 500, 1],
    25: [0.7812515624999995, 1.000002, 0.5, 500, 1],
    26: [0.8125016249999994, 1.000002, 0.5, 500, 1],
  };
  for (let k = 1; k <= 26; k++) {
    R.frame(at(k));
    if (want[k]) eqList([a.alive_amt, d.dead_amt, d.ang, d.xx, R.S.slithers.length], want[k], 'k' + k);
  }
  assert.strictEqual(R.S.slithers[0], a);
});

test('L11 zoom steps 2E-4 per redraw toward dgsc of the own sct', () => {
  const R = env({ ltm: 1000 });
  const o = mkSnake({ sct: 100, tl: 100, cfl: 99.4, xx: 1000, yy: 1000, sp: 0 });
  R.S.slithers = [o]; R.S.slither = o;
  const want = [1.156942857142857, 1.156742857142857, 1.156542857142857];
  want.forEach((g, i) => { R.frame(at(i + 1)); assert.strictEqual(R.S.gsc, g); });
  // extra redraws (resize) step again
  R.D.slLoop.redrawPrologue();
  assert.strictEqual(R.S.gsc, 1.156542857142857 - 2E-4);
});

test('L12 food fade-in, wobble and fly-in to the eater', () => {
  const R = env({ ltm: 1000 });
  const eater = mkSnake({ xx: 1100, yy: 1000, ang: Math.PI, wang: Math.PI, fa: .1, sp: 0, sct: 1, tl: 1, cfl: .4 });
  const f1 = { xx: 1000, yy: 1000, fr: 0, rsp: 1, gfr: 10, gr: .65 + .1 * 5, wsp: .01, rad: 0, lrrad: 0, eaten: false, rx: 0, ry: 0 };
  const f2 = { xx: 1050, yy: 990, fr: 0, rsp: 3, gfr: 20, gr: .65 + .1 * 3, wsp: -.02, rad: 0, lrrad: 0, eaten: false, rx: 0, ry: 0 };
  const f3 = { xx: 1080, yy: 1000, fr: 1, rsp: 1, gfr: 5, gr: .75, wsp: .015, rad: 1, lrrad: 1, eaten: true, eaten_fr: 0, eaten_by: eater, rx: 0, ry: 0 };
  assert.strictEqual(f2.gr, 0.9500000000000001);
  R.S.slithers = [eater]; R.S.foods = [f1, f2, f3]; R.S.foods_c = 3;
  const want = [
    [0.01388891666666666, 0.00016217178488694528, 1005.9539619549621, 1000.7418470454645, 0.04166674999999998, 0.0014841765261212735,
      0.050813109756097534, 0.9998688019671225, 1085.6086117818706, 1000.559708825933],
    [0.02777783333333332, 0.000652799185999533, 1005.9344814835598, 1000.8842677882209, 0.08333349999999996, 0.006265211260963322,
      0.10162621951219507, 0.9989504157369798, 1085.1198388208018, 1000.6553112348608],
    [0.04166674999999998, 0.0014841765261212735, 1005.9115947587958, 1001.0261809819801, 0.12500024999999995, 0.015296732635780162,
      0.1524393292682926, 0.9964576531123072, 1084.5331779055623, 1000.736369774827],
  ];
  want.forEach((w, i) => {
    R.frame(at(i + 1));
    eqList([f1.fr, f1.rad, f1.rx, f1.ry, f2.fr, f2.rad, f3.eaten_fr, f3.rad, f3.rx, f3.ry], w, 'k' + (i + 1));
  });
  assert.strictEqual(f1.lrrad, f1.rad);
});

test('L13 food container: swap-with-last removal through slApply.foodRemoveAt', () => {
  const R = env({ ltm: 1000 });
  const eater = mkSnake({ sct: 1, tl: 1, cfl: .4 });
  const mkF = (id, eaten, efr) => ({ id, xx: 0, yy: 0, fr: 1, rsp: 1, gfr: 0, gr: 1, wsp: 0, rad: 1, lrrad: 1, eaten, eaten_fr: efr, eaten_by: eaten ? eater : null, rx: 0, ry: 0 });
  R.S.slithers = [eater];
  R.S.foods = [mkF('A', true, .99), mkF('B', false, 0), mkF('C', true, .99), mkF('D', false, 0), mkF('E', true, .99)];
  R.S.foods_c = 5;
  R.frame(1016.6667);
  assert.strictEqual(R.S.foods_c, 2);
  assert.deepStrictEqual(R.S.foods.map((f) => f && f.id), ['D', 'B', null, null, null]);
  assert.deepStrictEqual(R.log.filter((x) => x[0] === 'foodRemoveAt').map((x) => x[1]), [4, 2, 0]);
});

test('L14 prey: ring, turn, move, fade-in; eaten prey', () => {
  const R = env({ ltm: 1000 });
  const pr = { xx: 2000, yy: 2000, fx: 0, fy: 0, fxs: new Float32Array(53), fys: new Float32Array(53), fpos: 0, ftg: 0, dir: 2, ang: 1,
    wang: 1.05, sp: 3, gfr: 0, gr: .6, fr: 0, rad: 0, eaten: false };
  for (let j = 0; j < 53; j++) pr.fxs[j] -= 5 * LFAS[j];
  pr.fx = pr.fxs[0]; pr.ftg = 53;
  R.S.preys = [pr];
  const want = [
    [1.05, 0, 2000.7774563172404, 2001.3553515006881, 1.2500024999999992, 0.01388891666666666, 0.00016217178488694528, -4.995438575744629, 51],
    [1.05, 0, 2001.5549126344808, 2002.7107030013763, 2.5000049999999985, 0.02777783333333332, 0.000652799185999533, -4.959049701690674, 49],
    [1.05, 0, 2002.3323689517213, 2004.0660545020644, 3.750007499999998, 0.04166674999999998, 0.0014841765261212735, -4.8868021965026855, 47],
  ];
  want.forEach((w, i) => {
    R.frame(at(i + 1));
    eqList([pr.ang, pr.dir, pr.xx, pr.yy, pr.gfr, pr.fr, pr.rad, pr.fx, pr.ftg], w, 'k' + (i + 1));
  });
  const R2 = env({ ltm: 1000 });
  const eater = mkSnake({ sct: 1, tl: 1, cfl: .4 });
  const pe = { xx: 0, yy: 0, fx: 0, fy: 0, fxs: new Float32Array(53), fys: new Float32Array(53), fpos: 0, ftg: -1, dir: 0, ang: 0, wang: 0,
    sp: 0, gfr: 0, gr: .6, fr: 1, rad: 1, eaten: true, eaten_fr: 0, eaten_by: eater };
  R2.S.slithers = [eater]; R2.S.preys = [pe];
  const want2 = [[1.0138889166666667, 0.04432632978723402, 3.333339999999998, 0.9999129065850153, 1],
    [1.0277778333333334, 0.08865265957446804, 6.666679999999996, 0.9993032526801228, 1]];
  want2.forEach((w, i) => {
    R2.frame(at(i + 1));
    eqList([pe.fr, pe.eaten_fr, pe.gfr, pe.rad, R2.S.preys.length], w, 'eaten k' + (i + 1));
  });
  // eaten prey without an eater leaves at once
  const R3 = env({ ltm: 1000 });
  const lone = Object.assign({}, pe, { eaten_by: undefined, fxs: new Float32Array(53), fys: new Float32Array(53) });
  R3.S.preys = [lone];
  R3.frame(at(1));
  assert.strictEqual(R3.S.preys.length, 0);
});

test('L15 (slLoop part): the frame the death fade ends, the socket closes and resetGame runs', () => {
  const R = env({ ltm: 1000, dead_mtm: 1000, want_close_socket: true });
  const o = mkSnake({ sct: 10, tl: 10, cfl: 9.4 });
  R.S.slithers = [o]; R.S.slither = o;
  let endAt = 215;
  let k = 0;
  // stand-in for slHud.oefFades: the fade ends (dead_mtm -1, playing false) in frame endAt
  R.D.slHud.oefFades = function (ctm) {
    R.log.push(['oefFades', ctm]);
    if (k === endAt) { R.S.dead_mtm = -1; R.S.playing = false; }
  };
  R.D.slApply.resetGame = function () { R.log.push(['resetGame']); R.S.slither = null; R.S.slithers = []; };
  for (k = 1; k < endAt; k++) R.frame(at(k));
  assert.strictEqual(R.log.some((x) => x[0] === 'closeSocket' || x[0] === 'resetGame'), false);
  assert.strictEqual(R.S.want_close_socket, true);
  R.log.length = 0;
  R.frame(at(endAt));
  // still connected at step 2; closed at step 8, so step 9 and (no own snake) step 12 are skipped
  assert.deepStrictEqual(R.log.map((x) => x[0]), ['accumulateArrowTicks', 'oefFades', 'closeSocket', 'resetGame', 'oefDot', 'redraw']);
  assert.strictEqual(R.log[1][1], at(endAt));
  assert.strictEqual(R.S.want_close_socket, false);
  assert.strictEqual(R.S.connected, false);
  assert.strictEqual(R.S.playing, false);
  // no transport: no close call, connected untouched, resetGame still runs
  const R2 = env({ ltm: 1000, want_close_socket: true });
  R2.D.slNet.hasSocket = () => false;
  R2.frame(at(1));
  assert.deepStrictEqual(R2.log.map((x) => x[0]).slice(0, 4), ['oefFades', 'resetGame', 'stepArrowKeys', 'stepPing']);
  assert.strictEqual(R2.S.connected, true);
});

test('L17 border ring: whole ticks, last slot shown, slot refilled with the target', () => {
  const R = env({ ltm: 1000 });
  R.S.flux_grds = new Array(56).fill(16000);
  R.S.flux_grd = 16000; R.S.real_flux_grd = 16000; R.S.flux_grd_pos = 0;
  // the z feed (slApply's, game.js:8919-8928) with 15000
  R.S.real_flux_grd = 15000;
  let k = R.S.flux_grd_pos;
  for (let j = 0; j < 56; j++) { R.S.flux_grds[k] = R.S.flux_grds[k] + (R.S.real_flux_grd - R.S.flux_grds[k]) * FLXAS[j]; k++; if (k >= 56) k = 0; }
  R.S.flx_tg = 56;
  const want = { 1: [2, 15999.184551963068, 54, 2], 2: [2, 15992.676917923847, 52, 4], 27: [2, 15000, 0, 0], 28: [2, 15000, -1, 0],
    29: [2, 15000, -1, 0], 30: [2, 15000, -1, 0] };
  for (let f = 1; f <= 30; f++) {
    const p = R.frame(at(f));
    if (want[f]) eqList([p.vfrb, R.S.flux_grd, R.S.flx_tg, R.S.flux_grd_pos], want[f], 'k' + f);
  }
  // not while disconnected
  const R2 = env({ ltm: 1000, connected: false, flx_tg: 56, flux_grds: new Array(56).fill(1), flux_grd: 5 });
  R2.frame(at(1));
  assert.strictEqual(R2.S.flx_tg, 56);
  assert.strictEqual(R2.S.flux_grd, 5);
});

test('L18 (slLoop part): minimap fades only while connected, after the ring; the dot every frame', () => {
  const R = env({ ltm: 1000 });
  const o = mkSnake({ sct: 10, tl: 10, cfl: 9.4 });
  R.S.slithers = [o]; R.S.slither = o;
  R.frame(at(1));
  assert.deepStrictEqual(R.log.map((x) => x[0]),
    ['accumulateArrowTicks', 'oefFades', 'stepArrowKeys', 'stepPing', 'oefMinimap', 'oefDot', 'stepBoostAndAngle', 'redraw']);
  for (const x of R.log) if (x[0] !== 'accumulateArrowTicks' && x[0] !== 'oefMinimap' && x[0] !== 'redraw') assert.strictEqual(x[1], at(1), x[0]);
  const R2 = env({ ltm: 1000, connected: false });
  R2.frame(at(1));
  assert.deepStrictEqual(R2.log.map((x) => x[0]), ['oefFades', 'oefDot', 'redraw']);
});

test('L19 fl end step on a vfrb 0 frame; the other rings wait for a tick', () => {
  const R = env({ ltm: 1000, fr: 10.5 });
  const o = mkSnake({ sct: 10, tl: 10, cfl: 9.4, fltg: 0, fl: -0.5, ftg: 0, fx: -0.25, fatg: 0, fa: 0.1 });
  const po = mkPoint(0, 0, { ftg: 0, fx: 3 });
  o.pts = [po];
  R.S.slithers = [o];
  let p = R.frame(1002);
  eqList([p.vfrb, o.fl, o.fltg, o.cfl, o.fx, o.ftg, o.fa, o.fatg, po.fx, po.ftg], [0, 0, -1, 9.4, -0.25, 0, 0.1, 0, 3, 0], 'vfrb 0');
  p = R.frame(1012);
  eqList([p.vfrb, o.fx, o.ftg, o.fa, o.fatg, po.fx, po.ftg], [2, 0, -1, 0, -1, 0, -1], 'vfrb 2');
});

test('L20 edir is created lazily', () => {
  const R = env({ ltm: 1000 });
  const o = mkSnake({ sct: 10, tl: 10, cfl: 9.4, ehang: 1, wehang: 1 });
  R.S.slithers = [o];
  R.frame(1016.6667);
  assert.ok(!('edir' in o));
  o.wehang = 1.2;
  R.frame(1033.3334);
  assert.strictEqual(o.edir, 2);
  assert.strictEqual(o.ehang, 1.0451200008392334);
});

test('L21 auto quality windows, gla and qsm fades, window counters', () => {
  const R = env({ ltm: 0, lrd_mtm: 0 });
  const fpsList = [60, 20, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 28];
  const wdfg = [0, 1, 0.887, 0.7754690000000001, 0.6653879030000001, 0.556737860261, 0.449500268077607, 0.3436567645925981,
    0.2391892266528943, 0.13607976670640667, 0.03431072973922339, -0.06613530974738652, -0.06613530974738652];
  const hq = [true, false, false, false, false, false, false, false, false, false, false, true, true];
  let t = 0;
  fpsList.forEach((f, i) => {
    t += 1000.5;
    R.S.fps = f;
    R.S.apkps = 3; R.S.pkps = 4; R.S.rdps = 5;
    R.frame(t);
    assert.strictEqual(R.S.wdfg, wdfg[i], 'wdfg ' + i);
    assert.strictEqual(R.S.high_quality, hq[i], 'hq ' + i);
    assert.strictEqual(R.S.fps, 1, 'fps ' + i);
    eqList([R.S.apkps, R.S.pkps, R.S.rdps, R.S.lrd_mtm], [0, 0, 0, t], 'counters ' + i);
  });
  // no window before > 1000 ms
  const R1 = env({ ltm: 0, lrd_mtm: 0 });
  R1.S.apkps = 7;
  R1.frame(1000);
  assert.strictEqual(R1.S.apkps, 7);
  assert.strictEqual(R1.S.lrd_mtm, 0);
  const G = env({ ltm: 1000, high_quality: false, gla: 1, qsm: 1 });
  G.frame(at(1)); eqList([G.S.gla, G.S.qsm], [0.98437496875, 1.0000833335], 'k1');
  G.frame(at(2)); eqList([G.S.gla, G.S.qsm], [0.9687499374999999, 1.0001666669999998], 'k2');
  G.S.high_quality = true; G.S.gla = .5; G.S.qsm = 1.5;
  G.frame(at(3)); eqList([G.S.gla, G.S.qsm], [0.51562503125, 1.4999166665], 'k3');
  // not while playing is false
  const N = env({ ltm: 1000, playing: false, high_quality: false, gla: 1, qsm: 1 });
  N.frame(at(1));
  eqList([N.S.gla, N.S.qsm], [1, 1], 'not playing');
});

test('L22 camera ring per redraw, view, boxes, zoom snap, not animating', () => {
  const camRing = (S, dx, dy) => {
    let k = S.fvpos;
    for (let j = 0; j < 62; j++) { S.fvxs[k] -= dx * VFAS[j]; S.fvys[k] -= dy * VFAS[j]; k++; if (k >= 62) k = 0; }
    S.fvtg = 62;
  };
  const R = env({ ltm: 1000 });
  const o = mkSnake({ sct: 10, tl: 10, cfl: 9.4, xx: 1000, yy: 1000, sp: 0 });
  R.S.slithers = [o]; R.S.slither = o;
  R.frame(at(1));
  camRing(R.S, 3, -2);
  eqList([R.S.fvtg, R.S.fvpos, R.S.fvxs[0], R.S.fvxs[1], R.S.fvxs[30], R.S.fvxs[61], R.S.fvys[0]],
    [62, 0, -3, -2.9990039407452143, -1.5496362122468517, 0, 2], 'fed');
  const want = {
    1: [-3, 2, 997, 1002, 61, 1],
    2: [-2.9990039407452143, 1.9993359604968095, 997.0009960592548, 1001.9993359604969, 60, 2],
    3: [-2.9959989146547574, 1.9973326097698383, 997.0040010853453, 1001.9973326097698, 59, 3],
    31: [-1.5496362122468517, 1.0330908081645678, 998.4503637877532, 1001.0330908081646, 31, 31],
    32: [-1.450363787753148, 0.966909191835432, 998.5496362122468, 1000.9669091918354, 30, 32],
    61: [-0.000996059254785825, 0.0006640395031905499, 999.9990039407452, 1000.0006640395031, 1, 61],
    62: [0, 0, 1000, 1000, 0, 0], 63: [0, 0, 1000, 1000, 0, 0], 65: [0, 0, 1000, 1000, 0, 0],
  };
  for (let k = 2; k <= 66; k++) {
    R.frame(at(k));
    const w = want[k - 1];
    if (w) eqList([R.S.fvx, R.S.fvy, R.S.view_xx, R.S.view_yy, R.S.fvtg, R.S.fvpos], w, 'redraw ' + (k - 1));
  }
  // overlap: a second feed while the first is half consumed
  const R2 = env({ ltm: 1000 });
  const o2 = mkSnake({ sct: 10, tl: 10, cfl: 9.4, xx: 1000, yy: 1000, sp: 0 });
  R2.S.slithers = [o2]; R2.S.slither = o2;
  camRing(R2.S, 4, 0);
  for (let k = 1; k <= 10; k++) R2.frame(at(k));
  camRing(R2.S, -1, 0);
  const s2 = [[-2.8495988133332113, 61, 11], [-2.8141485874658905, 60, 12], [-2.7744476850598527, 59, 13]];
  s2.forEach((w, i) => { R2.frame(at(11 + i)); eqList([R2.S.fvx, R2.S.fvtg, R2.S.fvpos], w, 'overlap ' + i); });
  // boxes
  const B = env({ ltm: 1000, gsc: 1.157135714 });
  const ob = mkSnake({ sct: 10, tl: 10, cfl: 9.4, xx: 1000, yy: 2000, sp: 0 });
  B.S.slithers = [ob]; B.S.slither = ob;
  B.frame(at(1));
  assert.strictEqual(B.S.gsc, 1.157135714);
  eqList([B.S.view_xx, B.S.view_yy], [1000, 2000], 'view');
  eqList([B.S.bpx1, B.S.bpy1, B.S.bpx2, B.S.bpy2], [267.8478507526214, 1550.87428925731, 1732.1521492473785, 2449.12571074269], 'bp');
  eqList([B.S.fpx1, B.S.fpy1, B.S.fpx2, B.S.fpy2], [327.8478507526214, 1610.87428925731, 1672.1521492473785, 2389.12571074269], 'fp');
  eqList([B.S.apx1, B.S.apy1, B.S.apx2, B.S.apy2], [141.8478507526214, 1424.87428925731, 1858.1521492473785, 2575.12571074269], 'ap');
  assert.strictEqual(B.S.view_ang, -2.389774982284176);
  assert.strictEqual(B.S.view_dist, 21061.028274991702);
  // zoom snap from sgsc on the first redraw with a short own snake
  const Z = env({ ltm: 1000 });
  const oz = mkSnake({ sct: 10, tl: 10, cfl: 9.4, sp: 0 });
  Z.S.slithers = [oz]; Z.S.slither = oz;
  assert.strictEqual(Z.S.gsc, 1.157142857142857);
  Z.frame(at(1));
  assert.strictEqual(Z.S.gsc, 1.157135714);
  // dgsc per sct, seen through a snap from 1E-4 above it
  for (const [sct, dg] of [[10, 1.157135714], [20, 1.157135714], [21, 1.1432361001081082], [532, 0.676635192890511], [10000, 0.6446984710167732]]) {
    oz.sct = sct;
    Z.S.gsc = dg + 1E-4;
    Z.D.slLoop.redrawPrologue();
    assert.strictEqual(Z.S.gsc, dg, 'dgsc sct ' + sct);
  }
  // not animating: only fps++ (the 1 s window at lrd_mtm 0 resets fps first)
  const A = env({ ltm: 1000, animating: false, fps: 5 });
  const oa = mkSnake({ sct: 100, tl: 100, cfl: 99.4, sp: 0 });
  A.S.slithers = [oa]; A.S.slither = oa;
  A.frame(at(1));
  eqList([A.S.fps, A.S.gsc, A.S.view_xx], [1, 1.157142857142857, 0], 'not animating');
  assert.strictEqual(A.D.slLoop.redrawPrologue(), null);
  assert.strictEqual(A.S.fps, 2);
});

test('redrawPrologue hands back the view from before the camera step, in one reused object', () => {
  const R = env({ ltm: 1000, view_xx: 5, view_yy: 6 });
  const o = mkSnake({ sct: 10, tl: 10, cfl: 9.4, xx: 1000, yy: 2000, sp: 0 });
  R.S.slither = o;
  const a = R.D.slLoop.redrawPrologue();
  assert.strictEqual(a.lvx, 5);
  assert.strictEqual(a.lvy, 6);
  assert.strictEqual(R.S.view_xx, 1000);
  const b = R.D.slLoop.redrawPrologue();
  assert.strictEqual(b, a);
  assert.strictEqual(b.lvx, 1000);
  // no own snake: view and boxes untouched
  R.S.slither = null;
  R.S.view_xx = 7;
  const c = R.D.slLoop.redrawPrologue();
  assert.strictEqual(c.lvx, 7);
  assert.strictEqual(R.S.view_xx, 7);
});

test('Y1 render_mode 1: cfl without -.6, wehang from the last point, then the chase', () => {
  const R = env({ ltm: 1000, render_mode: 1 });
  const po = mkPoint(990, 1003, { ebx: 2, eby: -1 });
  const o = mkSnake({ xx: 1000, yy: 1000, sct: 10, tl: 10, fl: 0, cfl: 10, ehl: .5, ehang: 0, wehang: 0, pts: [po], sp: 0 });
  R.S.slithers = [o];
  R.frame(1016.6667);
  eqList([o.cfl, o.ehl, o.wehang, o.edir, o.ehang], [10, 0.5625001249999999, -0.3061538950569396, 1, 6.214116987170068], 'Y1');
});

test('Y2 socket-open quality init', () => {
  const want = [[1, 2, true, 1, 0, 1], [1, 1, false, 0, 0, 1], [0, 2, false, 0, 0, 1.7], [0, 1, false, 0, 0, 1.7]];
  for (const [wq, rm, hq, gla, wdfg, qsm] of want) {
    const R = env({ high_quality: false, gla: .3, wdfg: 4, qsm: 1.2, want_quality: wq, render_mode: rm, lpstm: 0 });
    R.box.clock = 777;
    R.D.slLoop.onSocketOpen();
    eqList([R.S.high_quality, R.S.gla, R.S.wdfg, R.S.qsm, R.S.lpstm], [hq, gla, wdfg, qsm, 777], 'wq ' + wq + ' rm ' + rm);
  }
});

test('Y3 per-frame rules at 60, 144 and 240 Hz over the same 100 ms', () => {
  const run = (step, n) => {
    const R = env({ ltm: 1000, lag_mult: .2, mmgad: true, mmal: 0, mmbfr: 1 });
    const o = mkSnake({ sp: 11, tsp: 4.8, fsp: 4.85, ang: 0, wang: 0, dir: 0, sct: 10, tl: 10, cfl: 9.4, xx: 1000, yy: 1000 });
    R.S.slithers = [o];
    for (let k = 1; k <= n; k++) R.frame(1000 + step * k);
    return [o.tsp, o.sfr, o.xx, R.S.lag_mult, R.S.fr, R.log.filter((x) => x[0] === 'oefMinimap').length];
  };
  eqList(run(16.6667, 6), [7.705534359, 0.19392842149981718, 1012.8906507812502, 0.49999999999999994, 4.687509374999998, 6], '60 Hz');
  eqList(run(6.9444, 14), [9.582410099867866, 0.5163101830719466, 1019.216456875, 0.9000000000000002, 6.987802500000011, 14], '144 Hz');
  eqList(run(4.1667, 24), [10.506368286480312, 0.8889430790715094, 1025.78145625, 1, 9.37507500000001, 24], '240 Hz');
});

test('Y4 no lag while want_play; Play connects only when no death fade runs', () => {
  const R = env({ ltm: 1000, wfpr: true, last_ping_mtm: 0, want_play: true, connected: false, playing: false });
  R.autoPong = false;
  R.frame(1016.6667, true);
  eqList([R.S.lagging, R.S.lag_mult], [false, 1], 'Y4');
  assert.deepStrictEqual(R.log.map((x) => x[0]), ['connect', 'oefFades', 'oefDot', 'redraw']);
  const R2 = env({ ltm: 1000, want_play: true, dead_mtm: 1000, connected: false });
  R2.frame(at(1));
  assert.strictEqual(R2.log.some((x) => x[0] === 'connect'), false);
  // hooks.connect is replaceable and looked up at call time
  const R3 = env({ ltm: 1000, want_play: true, connected: false });
  let n = 0;
  R3.D.slLoop.hooks.connect = () => { n++; };
  R3.frame(at(1));
  assert.strictEqual(n, 1);
});

test('DWH 9.8 food update at vfr exactly 16.6667 / 8', () => {
  const R = env({ ltm: 0, connected: false, playing: false });
  const step = () => { R.S.ltm = 0; R.frame(16.6667); };
  const fo = { xx: 1000, yy: 2000, rx: 1000, ry: 2000, rsp: 1, rad: 1e-5, lrrad: 1e-5, fr: 0, gfr: 10, gr: 0.65 + 0.1 * 5, wsp: 0.01,
    eaten: false, eaten_fr: 0 };
  const fo3 = Object.assign({}, fo, { rsp: 3 });
  R.S.foods = [fo, fo3]; R.S.foods_c = 2;
  step();
  eqList([fo.fr, fo.rad, fo.rx, fo.ry, fo.gfr], [0.013888916666666666, 0.00016217178488694528, 1005.9539619549621, 2000.7418470454645,
    12.395838125], 'slow frame 1');
  eqList([fo3.fr, fo3.rad], [0.041666749999999995, 0.0014841765261212735], 'rapid frame 1');
  for (let f = 2; f <= 6; f++) step();
  eqList([fo.fr, fo.rad], [0.08333349999999999, 0.006265211260963341], 'slow frame 6');
  const e = { xx: 1000, yy: 2000, rx: 1000, ry: 2000, rad: 1, lrrad: 1, fr: 1, gfr: 10, gr: 0.75, wsp: 0.01, eaten: true, eaten_fr: 0.25,
    eaten_by: { xx: 1010, yy: 2005, fx: 0.5, fy: 0.5, ang: 0.3, fa: 0 } };
  R.S.foods = [e]; R.S.foods_c = 1;
  step();
  eqList([e.eaten_fr, e.rad, e.rx, e.ry], [0.30081310975609754, 0.9727798647955402, 1008.327343495322, 2001.9746693775608], 'eaten step');
  const mk = (id, done) => ({ id, xx: 0, yy: 0, rx: 0, ry: 0, rad: 1, lrrad: 1, fr: 1, gfr: 0, gr: 0, wsp: 0, eaten: done,
    eaten_fr: done ? 0.99 : 0, eaten_by: done ? null : undefined });
  R.S.foods = [mk('A', true), mk('B', false), mk('C', true), mk('D', false)]; R.S.foods_c = 4;
  step();
  assert.deepStrictEqual(R.S.foods.map((f) => (f ? f.id : null)), ['D', 'B', null, null]);
  assert.strictEqual(R.S.foods_c, 2);
});
