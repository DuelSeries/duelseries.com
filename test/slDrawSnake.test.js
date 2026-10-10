'use strict';
// slDrawSnake self-tests: draw-snake.md 9.2 T12 (at2lt) and 9.3 F1-F30 (frame scenarios).
// Every expected value below is a literal from the spec, which took it from THEIR redraw run in a vm with a
// recording fake canvas. Nothing is read from slither-reference at test time.
//
// The recorder logs a method call as [name, ...args] and a property set as ['=' + name, value], sprite canvases by
// label, exactly like the spec's oracle. A scenario issues the two calls slDrawWorld makes before the names
// (save, strokeStyle #90C098), then drawNames, updateVisibility, drawSnakes, and hashes the list:
// sha16 = first 16 hex chars of sha256(JSON.stringify(calls)).

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const path = require('path');

const MOD = path.join(__dirname, '..', 'public', 'js', 'sl', 'slDrawSnake.js');

function loadModule() {
  delete require.cache[require.resolve(MOD)];
  const prev = globalThis.DuelSlither;
  globalThis.DuelSlither = {};
  const api = require(MOD);
  const D = globalThis.DuelSlither;
  globalThis.DuelSlither = prev;
  return { api, D };
}

const sha16 = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const shaBuf = (u8) => crypto.createHash('sha256').update(Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength)).digest('hex').slice(0, 16);

// ------------------------------------------------------------------ recording context
function makeRecorder() {
  const calls = [];
  const lab = (v) => (v && typeof v === 'object' && v.__label ? v.__label : v);
  const ctx = new Proxy({}, {
    get(t, p) {
      if (p in t) return t[p];
      return (...args) => { calls.push([p].concat(args.map(lab))); };
    },
    set(t, p, v) {
      t[p] = v;
      calls.push(['=' + p, lab(v)]);
      return true;
    },
  });
  return { ctx, calls };
}

// ------------------------------------------------------------------ sprites (labels only)
function makeSprites() {
  const pci = [];
  for (let i = 0; i < 42; i++) {
    const n = i === 36 ? 60 : 7; // draw-snake.md 2.11 step 3
    const kmcs = [];
    for (let f = 0; f < n; f++) kmcs.push({ __label: 'kmcs:' + i + ':' + f });
    pci.push({ kfmc: { __label: 'kfmc:' + i }, kmcs, klp: i !== 36 });
  }
  const named = {};
  for (const n of ['komc', 'ksmc', 'kdmc', 'jsebi', 'jsepi', 'ecmc', 'jmou', 'sest', 'acbulb', 'cdbulb']) named[n] = { __label: n };
  return { pci, named };
}

// ------------------------------------------------------------------ snake builder (the spec oracle's buildSnake)
// Colour tables, draw-snake.md 2.3.
const RRS = [192, 144, 128, 128, 238, 255, 255, 255, 224, 255, 144, 80, 255, 40, 100, 120, 72, 160, 255, 56, 56, 78,
  255, 101, 128, 60, 0, 217, 255, 144, 32, 240, 240, 240, 240, 32, 40, 104, 0, 104, 0, 128];
const GGS = [128, 153, 208, 255, 238, 160, 144, 64, 48, 255, 153, 80, 192, 136, 117, 134, 84, 80, 224, 68, 68, 35, 86,
  200, 132, 192, 255, 69, 64, 144, 32, 32, 240, 144, 32, 240, 60, 128, 0, 40, 0, 128];
const BBS = [255, 255, 208, 128, 112, 96, 144, 64, 224, 255, 255, 80, 80, 96, 255, 255, 255, 255, 64, 255, 255, 192, 9,
  232, 144, 72, 83, 69, 64, 144, 240, 32, 32, 32, 240, 32, 173, 255, 112, 170, 0, 255];
// smus with cst .43 (Float32 values), index 7 onward all 0.5699999928474426.
const SMUS = [1, 1, 1, 1, 0.8924999833106995, 0.7850000262260437, 0.6775000095367432, 0.5699999928474426];
const smuAt = (k) => (k < SMUS.length ? SMUS[k] : 0.5699999928474426);
// Custom skin colours allowed in play (csks, 2.3).
const ALLOWED = new Set([...Array(36).keys(), 37, 39, 41]);

// setSkin results for the skins the scenarios use (draw-snake.md 2.12; values only, not key order).
function applySkin(o, cv, ca, spr) {
  Object.assign(o, { rcv: cv, er: 6, pr: 3.5, pma: 2.3, ec: '#FFFFFF', ecv: 16777215, eca: .75, ppa: 1, ppc: '#000000',
    ppcv: 0, antenna: false, one_eye: false, drez: false, ed: 6, esp: 6, easp: .1, eac: false, jyt: false, jse: false,
    slg: false, eo: 0, swell: 0, cusk: false });
  if (ca && ca.length >= 10) {
    const list = [];
    let m = 8;
    while (m < ca.length) {
      const rep = ca[m++];
      if (m < ca.length) { const c = ca[m++]; if (ALLOWED.has(c)) for (let r = 0; r < rep; r++) list.push(c); }
    }
    if (list.length) { o.rbcs = list; o.cv = list[0]; o.cusk = true; }
  }
  const antenna = (f) => {
    o.antenna = true; o.atba = 0;
    Object.assign(o, f.head);
    o.atx = new Float32Array(f.jc); o.aty = new Float32Array(f.jc); o.atvx = new Float32Array(f.jc);
    o.atvy = new Float32Array(f.jc); o.atax = new Float32Array(f.jc); o.atay = new Float32Array(f.jc);
    for (let j = f.jc - 1; j >= 0; j--) { o.atx[j] = o.xx; o.aty[j] = o.yy; }
    Object.assign(o, f.tail);
  };
  if (!o.cusk) {
    let rb = null;
    let c = cv;
    switch (cv) {
      case 9: rb = [7, 9, 7, 9, 7, 9, 7, 9, 7, 9, 7, 10, 10, 10, 10, 10, 10, 10, 10, 10]; break;
      case 24:
        antenna({ jc: 8, head: { atc1: '#00688c', atc2: '#64c8e7', atwg: true, atia: .35, abrot: false },
          tail: { bulb: spr.acbulb, blbx: -10, blby: -10, blbw: 20, blbh: 20, bsc: 1, blba: .75 } });
        rb = [23, 23, 23, 23, 23, 23, 23, 23, 23, 18, 18, 18, 18, 18, 18, 18, 18, 18];
        break;
      case 25:
        o.ec = '#FF5609'; o.ecv = 16733705; o.eca = 1;
        antenna({ jc: 9, head: { atc1: '#000000', atc2: '#5630d7', atia: 1, abrot: true },
          tail: { bulb: spr.cdbulb, blbx: -5, blby: -10, blbw: 20, blbh: 20, bsc: 1.6, blba: 1 } });
        rb = [21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 22, 22, 22, 22, 22, 22, 22, 22, 22];
        break;
      case 27:
        Object.assign(o, { jse: true, one_eye: true, ebi: spr.jsebi, ebiw: 64, ebih: 64, ebisz: 29, epi: spr.jsepi, epiw: 48,
          epih: 48, episz: 14, pma: 4, swell: .06 });
        rb = [25];
        break;
      case 40: o.eac = true; o.jyt = true; rb = [26]; break;
      case 41: Object.assign(o, { ed: 34, esp: 14, eca: 1, eo: 3, er: 8, easp: .038, pr: 4.5, pma: 3, slg: true }); rb = [27]; break;
      case 60: o.drez = true; rb = [36]; break;
      case 63: Object.assign(o, { ec: '#000000', ecv: 0, eca: 1, ppc: '#CCCCCC', ppcv: 13421772, pr: 2.5 }); rb = [7, 7, 7, 11, 11, 11]; break;
      default:
        if (cv > 8) throw new Error('test builder has no table row for skin ' + cv);
        c = cv % 9;
    }
    if (rb) c = rb[0];
    o.rbcs = rb;
    o.cv = c;
  }
  o.fdhc = null; o.fdtc = null; o.fdl = 0;
  if (!o.cusk && cv === 60) { o.fdhc = 37; o.fdtc = 38; o.fdl = 30; }
}

const hex2 = (v) => { const s = '00' + Math.min(255, Math.max(0, Math.round(v))).toString(16); return s.substr(s.length - 2); };

// newSlither (rand .5: colour jitter +10) then the oracle's per-scenario fields.
function buildSnake(W, spec) {
  const n = spec.pts.length;
  const pts = [];
  for (let k = 0; k < n; k++) {
    const [x, y] = spec.pts[k];
    pts.push({ xx: x, yy: y, fx: 0, fy: 0, ltn: 1, fltn: 0, smu: 1, fsmu: 0, da: 0, dying: false });
  }
  for (let k = 0; k < n; k++) pts[n - 1 - k].smu = smuAt(Math.min(k, 99));
  const o = { id: spec.id, xx: spec.head[0], yy: spec.head[1] };
  applySkin(o, spec.cv, spec.ca || null, W.spr);
  const cv = o.cv;
  Object.assign(o, { fnfr: 0, na: 1, chl: 0, tsp: 0, sfr: 0, gptz: [], accessory: -1, kill_count: 0 });
  o.rr = Math.min(255, RRS[cv] + 10);
  o.gg = Math.min(255, GGS[cv] + 10);
  o.bb = Math.min(255, BBS[cv] + 10);
  o.cs = '#' + hex2(o.rr) + hex2(o.gg) + hex2(o.bb);
  o.csw = '#' + hex2((255 + o.rr) * .5) + hex2((255 + o.gg) * .5) + hex2((255 + o.bb) * .5);
  Object.assign(o, { sc: 1, msp: 12, fx: 0, fy: 0, fchl: 0, ehang: spec.ang, wehang: spec.ang, msl: spec.msl || 42, fam: 0,
    ang: spec.ang, wang: spec.ang, rex: 0, rey: 0, sp: 2, pts, sct: n, dead_amt: 0, alive_amt: 0 });
  W.S.slithers.splice(0, 0, o);
  o.nk = spec.nk == null ? 'Owen' : spec.nk;
  o.sp = spec.sp == null ? 5.78 : spec.sp;
  o.sc = Math.min(6, 1 + (o.sct - 2) / 106);
  o.ssp = 4.25 + .5 * o.sc;
  o.fsp = o.ssp + .1;
  o.wsep = 6 * o.sc;
  const mwsep = 4.5 / W.S.gsc;
  if (o.wsep < mwsep) o.wsep = mwsep;
  o.sep = spec.sep == null ? o.wsep : spec.sep;
  o.fam = spec.fam || 0;
  o.tl = o.sct + o.fam;
  o.cfl = W.S.render_mode == 1 ? o.tl : o.tl - .6;
  if (spec.cfl != null) o.cfl = spec.cfl;
  o.tsp = spec.tsp == null ? 0 : spec.tsp;
  o.sfr = spec.sfr || 0;
  o.alive_amt = spec.alive_amt == null ? 1 : spec.alive_amt;
  o.dead_amt = spec.dead_amt || 0;
  o.dead = !!spec.dead;
  o.ehang = o.wehang = spec.ehang == null ? spec.ang : spec.ehang;
  o.rex = spec.rex || 0;
  o.rey = spec.rey || 0;
  o.chl = spec.chl || 0;
  o.fchl = spec.fchl || 0;
  if (spec.iiv != null) o.iiv = spec.iiv;
  if (spec.fnfr != null) o.fnfr = spec.fnfr;
  return o;
}

function setView(S, vx, vy, gsc) {
  S.view_xx = vx; S.view_yy = vy; S.gsc = gsc;
  S.bpx1 = vx - (S.mww2 / gsc + 84); S.bpy1 = vy - (S.mhh2 / gsc + 84);
  S.bpx2 = vx + (S.mww2 / gsc + 84); S.bpy2 = vy + (S.mhh2 / gsc + 84);
  S.apx1 = vx - (S.mww2 / gsc + 210); S.apy1 = vy - (S.mhh2 / gsc + 210);
  S.apx2 = vx + (S.mww2 / gsc + 210); S.apy2 = vy + (S.mhh2 / gsc + 210);
}

function makeWorld(opts) {
  const { api } = loadModule();
  const { pci, named } = makeSprites();
  const S = Object.assign({ mww2: 750, mhh2: 422.5, slithers: [], slither: null, per_color_imgs: pci,
    render_mode: opts.render_mode || 2, nsr: !!opts.nsr,
    high_quality: opts.high_quality == null ? true : opts.high_quality,
    gla: opts.gla == null ? 1 : opts.gla, qsm: opts.qsm == null ? 1 : opts.qsm }, named);
  setView(S, opts.view ? opts.view[0] : 1150, opts.view ? opts.view[1] : 1000, opts.gsc || .9);
  api.initDrawSnake(S);
  const geo = [];
  api.geoHook = (o, bp, q, wwk) => geo.push({ id: o.id, bp, q, wwk, wehang: o.wehang, sep: o.sep,
    pbx: Float32Array.from(api.pbx.subarray(0, bp)), pby: Float32Array.from(api.pby.subarray(0, bp)),
    pba: Float32Array.from(api.pba.subarray(0, bp)), pbu: Uint8Array.from(api.pbu.subarray(0, bp)) });
  return { api, S, spr: named, geo };
}

function runFrame(W) {
  const rec = makeRecorder();
  W.geo.length = 0;
  let rnd = 0;
  const rand = () => { rnd++; return .5; };
  rec.ctx.save();
  rec.ctx.strokeStyle = '#90C098';
  W.api.drawNames(W.S, rec.ctx);
  W.api.updateVisibility(W.S);
  W.api.drawSnakes(W.S, rec.ctx, rand);
  return { calls: rec.calls, rnd };
}

// ------------------------------------------------------------------ scenarios (draw-snake.md 9.3, oracle names)
const CURVE = [];
for (let k = 0; k < 12; k++) CURVE.push([1000 + 24 * k, 1000 + Math.round(30 * Math.sin(k / 3))]);
const HEAD = [CURVE[11][0] + 20, CURVE[11][1] + 3];
const BASE = { id: 7, cv: 7, ang: .125, pts: CURVE, head: HEAD, nk: 'Owen' };
const BOOST = { sp: 12, tsp: 9, sfr: 1.3 };
const with_ = (...a) => Object.assign({}, BASE, ...a);
const longPts = () => { const p = []; for (let k = 0; k < 40; k++) p.push([600 + 24 * k, 1250]); return p; };
const offPts = () => { const p = []; for (let k = 0; k < 40; k++) p.push([1150 + 24 * k, 700]); return p.reverse(); };
const SNAKE_X = () => ({ id: 1, cv: 2, ang: 0, pts: longPts(), head: [600 + 24 * 39 + 20, 1250], nk: 'X' });
const SNAKE_Y = () => ({ id: 2, cv: 5, ang: Math.PI, pts: offPts(), head: [1150 - 20, 700], nk: 'Y' });
const SNAKE_S = () => ({ id: 2, cv: 1, ang: 0, pts: [[1100, 1100], [1124, 1100]], head: [1144, 1100], nk: 'S' });

const SCENARIOS = {
  S1_plain_hq: { opts: {}, build: (W) => [buildSnake(W, BASE)], n: 857, sha: '5f00bfad10b32acb' },
  S2_boost: { opts: {}, build: (W) => [buildSnake(W, with_(BOOST))], n: 1393, sha: 'c76ce17f91f2cf10' },
  S3_lowq: { opts: { high_quality: false, gla: .4, qsm: 1.3 }, build: (W) => [buildSnake(W, with_(BOOST))], n: 1093, sha: '04d975d806e437f4' },
  S3b_lowq_gla0: { opts: { high_quality: false, gla: 0, qsm: 1.7 }, build: (W) => [buildSnake(W, with_(BOOST))], n: 534, sha: '5353dcd9dd7bcc71' },
  S4_dying: { opts: {}, build: (W) => [buildSnake(W, with_({ dead: true, dead_amt: .3 }))], n: 1125, sha: '9ea50be3859580cf' },
  S5_spawn: { opts: {}, build: (W) => [buildSnake(W, with_({ alive_amt: .5, rex: 1.5, rey: -.75 }))], n: 857, sha: '97a4a9d44ced8ae6' },
  S6_pattern9_boost: { opts: {}, build: (W) => [buildSnake(W, with_({ cv: 9 }, BOOST))], n: 1393, sha: '1ca80e6c6d56db76' },
  S7_skin27_oneeye: { opts: {}, build: (W) => [buildSnake(W, with_({ cv: 27, rex: 1, rey: 2 }))], n: 836, sha: 'bee16a99ddba8013' },
  S8_skin60_drez: { opts: {}, build: (W) => [buildSnake(W, with_({ cv: 60 }, BOOST))], n: 1460, sha: 'c553d93f4fd4a17f' },
  S9_skin41_eyes: { opts: {}, build: (W) => [buildSnake(W, with_({ cv: 41 }))], n: 873, sha: '5d27545f92b0a477' },
  S10_mode1_boost: { opts: { render_mode: 1 }, build: (W) => [buildSnake(W, with_({ sp: 12 }))], n: 76, sha: '5ca01e38c1da929d' },
  S11_mode1_dead: { opts: { render_mode: 1 }, build: (W) => [buildSnake(W, with_({ dead: true, dead_amt: .3 }))], n: 85, sha: '1c92115e75ea163f' },
  S12_mode1_carry: {
    opts: { render_mode: 1 },
    build: (W) => [buildSnake(W, with_({ id: 1, cv: 41, nk: 'A' })),
      buildSnake(W, with_({ id: 2, cv: 3, nk: 'B', sp: 12, pts: CURVE.map(([x, y]) => [x, y + 200]), head: [HEAD[0], HEAD[1] + 200] }))],
    n: 166, sha: '4b2a4ef837773a70',
  },
  S13_stale_pbu: { opts: { view: [1150, 1000] }, build: (W) => [buildSnake(W, SNAKE_X()), buildSnake(W, SNAKE_Y())], n: 3542, sha: '40dd818096c7c04a' },
  S14_own_name: {
    opts: {},
    build: (W) => {
      const o = buildSnake(W, with_({ fnfr: 200 }));
      W.S.slither = o;
      setView(W.S, o.xx + o.fx, o.yy + o.fy, .64285 + .514285714 / Math.max(1, (o.sct + 16) / 36));
      return [o];
    },
    n: 857, sha: '045c19148a624194',
  },
  S15_sep_step: { opts: {}, build: (W) => [buildSnake(W, with_({ sep: 6 }))], n: 932, sha: 'd4f9c6b0fb7ae4d7' },
  S16_iiv_on: { opts: {}, build: (W) => [buildSnake(W, with_({ iiv: false, ehang: 2.0 }))], n: 857, sha: '5f00bfad10b32acb' },
  S17_wwk_carry: { opts: {}, build: (W) => [buildSnake(W, with_({ id: 1 })), buildSnake(W, SNAKE_S())], n: 1082, sha: '7e7607ee40b56289' },
  S13b_offbox_alone: { opts: { view: [1150, 1000] }, build: (W) => [buildSnake(W, SNAKE_Y())], n: 1688, sha: '732cad78b4b2ef34' },
  S17b_two_points_alone: { opts: {}, build: (W) => [buildSnake(W, SNAKE_S())], n: 227, sha: '861f875ada48e8d4' },
  S18_nsr: { opts: { nsr: true }, build: (W) => [buildSnake(W, BASE)], n: 804, sha: 'aa4b5bf42d716546' },
  S19_custom_skin: { opts: {}, build: (W) => [buildSnake(W, with_({ cv: 3, ca: [0, 0, 0, 0, 0, 0, 0, 0, 3, 7, 2, 11] }))], n: 857, sha: 'd700cd7bd3b8dc37' },
  S20_head_clamp: { opts: {}, build: (W) => [buildSnake(W, with_({ head: [CURVE[11][0] + 60, CURVE[11][1]] }))], n: 887, sha: 'd1aeae92cda2f631' },
  S21_antenna24_2frames: { opts: { frames: 2 }, build: (W) => [buildSnake(W, with_({ cv: 24 }))], n: 891, sha: '24252b45e5b84492' },
  S22_antenna25: { opts: {}, build: (W) => [buildSnake(W, with_({ cv: 25 }))], n: 893, sha: '9ce293e224582abf' },
  S23_jyt40: { opts: {}, build: (W) => [buildSnake(W, with_({ cv: 40, rex: 1, rey: .5 }))], n: 848, sha: 'b189cb14152eb376' },
  S24_skin63_eyes: { opts: {}, build: (W) => [buildSnake(W, with_({ cv: 63, dead: true, dead_amt: .25 }))], n: 1125, sha: '77a57b90a24e46de' },
  S25_mode1_trim: { opts: { render_mode: 1 }, build: (W) => [buildSnake(W, with_({ cfl: 5.3, chl: .4, fchl: .05 }))], n: 70, sha: 'bef50731994b27dc' },
  S26_gla_half: { opts: { high_quality: false, gla: .5, qsm: 1.2 }, build: (W) => [buildSnake(W, BASE)], n: 722, sha: 'be2cb2dc4062dd27' },
  S27_short_budget: { opts: {}, build: (W) => [buildSnake(W, with_({ cfl: 5.3 }))], n: 527, sha: 'fdbb4fe0cf6ead01' },
};

function runScenario(name) {
  const sc = SCENARIOS[name];
  const W = makeWorld(sc.opts);
  const snakes = sc.build(W);
  let fr = runFrame(W);
  for (let f = 1; f < (sc.opts.frames || 1); f++) fr = runFrame(W);
  return { W, snakes, calls: fr.calls, rnd: fr.rnd, geo: W.geo.slice() };
}

module.exports = { SCENARIOS, runScenario, makeRecorder, sha16 };

// ------------------------------------------------------------------ tests

const countOf = (calls, pred) => calls.filter(pred).length;
const isDraw = (label) => (c) => c[0] === 'drawImage' && String(c[1]).split(':')[0] === label;
const geoOf = (r, id) => r.geo.find((g) => g.id === id);

test('T12 at2lt table', () => {
  const { api } = loadModule();
  const S = {};
  api.initDrawSnake(S);
  const t = api.at2lt;
  assert.strictEqual(t.length, 65536);
  assert.strictEqual(S.at2lt, t);
  const at = (y, x) => t[(y << 8) | x];
  assert.ok(Object.is(at(0, 0), -2.356194496154785));
  assert.ok(Object.is(at(128, 128), 0));
  assert.ok(Object.is(at(128, 255), 0));
  assert.ok(Object.is(at(255, 128), 1.5707963705062866));
  assert.ok(Object.is(at(64, 200), -0.726642370223999));
  assert.ok(Object.is(at(129, 128), 1.5707963705062866));
  assert.strictEqual(shaBuf(t), '80cb5f7e9a4269a4');
  assert.ok(api.pbx instanceof Float32Array && api.pbx.length === 32767);
  assert.ok(api.pbu instanceof Uint8Array && api.pbu.length === 32767);
});

for (const name of Object.keys(SCENARIOS)) {
  test('scenario ' + name + ': call count and sha16', () => {
    const r = runScenario(name);
    const sc = SCENARIOS[name];
    assert.strictEqual(r.calls.length, sc.n);
    assert.strictEqual(sha16(JSON.stringify(r.calls)), sc.sha);
  });
}

test('F1 base: buffers, angles, counts and sample calls', () => {
  const r = runScenario('S1_plain_hq');
  const g = geoOf(r, 7);
  assert.strictEqual(g.bp, 53);
  assert.ok(g.pbu.every((v) => v === 2));
  assert.strictEqual(g.pbx[0], 1284);
  assert.strictEqual(g.pby[0], 988);
  assert.strictEqual(g.pbx[1], 1278.617431640625);
  assert.strictEqual(g.pby[1], 987.3836669921875);
  assert.strictEqual(g.pbx[52], 997.5790405273438);
  assert.strictEqual(g.pby[52], 998.9912719726562);
  assert.strictEqual(g.pba[0], -3.027585744857788);
  assert.strictEqual(g.pba[1], -3.027585744857788);
  assert.strictEqual(shaBuf(g.pbx), '980023640329796a');
  assert.strictEqual(shaBuf(g.pby), '01423724f8d864a8');
  assert.strictEqual(shaBuf(g.pba), '4cdf06c0b65cb07b');
  assert.strictEqual(r.snakes[0].wehang, 0.11400690873200503);
  assert.strictEqual(countOf(r.calls, isDraw('komc')), 57);
  assert.strictEqual(countOf(r.calls, isDraw('ksmc')), 62);
  assert.strictEqual(countOf(r.calls, isDraw('kmcs')), 53);
  assert.strictEqual(countOf(r.calls, (c) => c[0] === 'rotate'), 53);
  assert.strictEqual(countOf(r.calls, (c) => c[0] === 'arc'), 4);
  assert.deepStrictEqual(r.calls[8], ['fillText', 'Owen', 870.6, 454.53396226415094]);
  assert.deepStrictEqual(r.calls[11], ['translate', 750, 422.5]);
  assert.deepStrictEqual(r.calls[12], ['=globalAlpha', 1]);
  assert.deepStrictEqual(r.calls[15], ['drawImage', 'komc', -23.20683962264151, -23.20683962264151, 46.41367924528302, 46.41367924528302]);
  assert.deepStrictEqual(r.calls[246], ['=globalAlpha', 5.777777777777778]);
  assert.deepStrictEqual(r.calls.slice(825, 831), [['save'], ['=globalAlpha', 1], ['translate', 120.60000000000001, -10.8],
    ['rotate', -3.027585744857788], ['drawImage', 'kmcs:7:0', -14.281132075471698, -14.281132075471698, 28.562264150943395, 28.562264150943395],
    ['restore']]);
  assert.strictEqual(r.rnd, 0);
});

test('F2 boost: underlay and overlay', () => {
  const r = runScenario('S2_boost');
  assert.strictEqual(countOf(r.calls, isDraw('kfmc')), 106);
  assert.strictEqual(countOf(r.calls, (c) => c[0] === '=globalCompositeOperation' && c[1] === 'lighter'), 2);
  assert.deepStrictEqual(r.calls[15], ['=globalAlpha', 0.23078549337075055]);
  assert.deepStrictEqual(r.calls[17], ['drawImage', 'kfmc:7', -36.76237436011447, -36.76237436011447, 73.52474872022894, 73.52474872022894]);
  const ov = r.calls.slice(1101, 1106);
  assert.deepStrictEqual(ov[0], ['save']);
  assert.deepStrictEqual(ov[1], ['translate', -137.17886352539062, -0.9078552246093751]);
  assert.deepStrictEqual(ov[2], ['=globalAlpha', 0.17785300751932653]);
  assert.strictEqual(ov[3][1], 'kfmc:7');
  assert.strictEqual(ov[3][2], -28.562264150943395);
  assert.strictEqual(ov[3][4], 57.12452830188679);
  assert.deepStrictEqual(ov[4], ['restore']);
});

test('F3, F4, F29 low quality', () => {
  const r3 = runScenario('S3_lowq');
  assert.strictEqual(geoOf(r3, 7).bp, 41);
  assert.strictEqual(r3.snakes[0].wehang, 0.09671727021271792);
  assert.strictEqual(countOf(r3.calls, isDraw('kfmc')), 82);
  assert.strictEqual(countOf(r3.calls, isDraw('komc')), 45);
  const r4 = runScenario('S3b_lowq_gla0');
  assert.strictEqual(geoOf(r4, 7).bp, 32);
  assert.strictEqual(countOf(r4.calls, isDraw('komc')), 0);
  assert.strictEqual(countOf(r4.calls, isDraw('kfmc')), 32);
  assert.strictEqual(countOf(r4.calls, isDraw('ksmc')), 28);
  const r29 = runScenario('S26_gla_half');
  assert.strictEqual(geoOf(r29, 7).bp, 44);
  assert.ok(r29.calls.some((c, i) => c[0] === '=globalAlpha' && c[1] === .5 && r29.calls[i - 1][0] === 'translate'));
});

test('F5 dying: death flash', () => {
  const r = runScenario('S4_dying');
  assert.strictEqual(countOf(r.calls, isDraw('kdmc')), 53);
  const i = r.calls.findIndex(isDraw('kdmc'));
  assert.deepStrictEqual(r.calls.slice(i - 3, i + 2), [['save'], ['=globalAlpha', 0.0871785157769282],
    ['translate', -137.17886352539062, -0.9078552246093751],
    ['drawImage', 'kdmc', -14.281132075471698, -14.281132075471698, 28.562264150943395, 28.562264150943395], ['restore']]);
});

test('F7 stripes use o.cv frames (K10)', () => {
  const r = runScenario('S6_pattern9_boost');
  const body = r.calls.filter(isDraw('kmcs'));
  assert.strictEqual(body[0][1], 'kmcs:10:3'); // j 52: rbcs[52 % 20] = 10, frame 13 - 10 = 3
});

test('F8 skin 27 one eye', () => {
  const r = runScenario('S7_skin27_oneeye');
  const i = r.calls.findIndex(isDraw('jsebi'));
  assert.deepStrictEqual(r.calls.slice(i - 1, i + 3), [['=globalAlpha', 1],
    ['drawImage', 'jsebi', 0, 0, 64, 64, 859.2505312205303, 397.7872464763797, 28.562264150943395, 28.562264150943395],
    ['drawImage', 'jsepi', 0, 0, 48, 48, 867.7561760188138, 407.16068133897164, 13.788679245283019, 13.788679245283019],
    ['=globalAlpha', 1]]);
});

test('F9 skin 60 drez and fades', () => {
  const r = runScenario('S8_skin60_drez');
  const g = geoOf(r, 7);
  assert.strictEqual(g.bp, 104);
  for (let j = 0; j < g.bp; j++) assert.strictEqual(g.pbu[j], j % 3 === 0 ? 2 : 1);
  assert.strictEqual(countOf(r.calls, isDraw('kmcs')), 163);
  assert.strictEqual(countOf(r.calls, isDraw('kfmc')), 70);
  assert.strictEqual(r.snakes[0].wehang, 0.14888993104035464);
});

test('F10 skin 41 eyes and side images', () => {
  const r = runScenario('S9_skin41_eyes');
  const want = [['=fillStyle', '#FFFFFF'], ['=lineWidth', 2.7], ['=strokeStyle', '#000000'], ['=globalAlpha', 1], ['beginPath'],
    ['arc', 902.0503138160275, 430.0025412525795, 7.879245283018868, 0, 6.283185307179586], ['closePath'], ['stroke'], ['fill']];
  const i = r.calls.findIndex((c) => c[0] === 'arc' && c[1] === 902.0503138160275);
  assert.deepStrictEqual(r.calls.slice(i - 5, i + 4), want);
  const rot = r.calls.filter((c) => c[0] === 'rotate').slice(-2).map((c) => c[1]);
  assert.deepStrictEqual(rot, [-0.275, 0.525]);
  assert.deepStrictEqual(r.calls.filter(isDraw('sest'))[0],
    ['drawImage', 'sest', -6.8943396226415095, -10.833962264150944, 25.85377358490566, 21.66792452830189]);
});

test('F11, F12, F28 render_mode 1', () => {
  const r = runScenario('S10_mode1_boost');
  assert.deepStrictEqual(r.calls.find((c) => c[0] === 'moveTo'), ['moveTo', 870.6, 411.7]);
  assert.deepStrictEqual(r.calls.find((c) => c[0] === 'lineTo'), ['lineTo', 861.6, 410.35]);
  assert.strictEqual(countOf(r.calls, (c) => c[0] === 'quadraticCurveTo'), 11);
  const i = r.calls.findIndex((c) => c[0] === '=shadowBlur');
  assert.deepStrictEqual(r.calls.slice(i - 1, i + 4), [['=lineWidth', 26.762264150943395], ['=shadowBlur', 27],
    ['=shadowColor', 'rgba(255,74,74, 1)'], ['stroke'], ['stroke']]);
  const r12 = runScenario('S11_mode1_dead');
  assert.strictEqual(countOf(r12.calls, (c) => c[0] === 'stroke'), 6);
  assert.strictEqual(countOf(r12.calls, (c) => c[0] === '=globalCompositeOperation' && c[1] === 'lighter'), 1);
  const r28 = runScenario('S25_mode1_trim');
  assert.strictEqual(countOf(r28.calls, (c) => c[0] === 'lineTo'), 1);
  const q = r28.calls.filter((c) => c[0] === 'quadraticCurveTo');
  assert.strictEqual(q.length, 5);
  assert.deepStrictEqual(q[4], ['quadraticCurveTo', 767.8199999999999, 441.76, 758.6399999999999, 443.67249999999996]);
  assert.ok(r28.calls.some((c) => c[0] === '=shadowColor' && c[1] === 'rgba(255,74,74, 0.1365)'));
});

test('F13 mode 1 carry: 12 strokes', () => {
  const r = runScenario('S12_mode1_carry');
  assert.strictEqual(countOf(r.calls, (c) => c[0] === 'stroke'), 12);
});

test('F14, F15 stale pbu (K1)', () => {
  const r = runScenario('S13_stale_pbu');
  assert.strictEqual(geoOf(r, 1).bp, 114);
  const g2 = geoOf(r, 2);
  assert.strictEqual(g2.bp, 114);
  assert.ok(g2.pbu.every((v) => v === 2));
  assert.strictEqual(r.snakes[0].wehang, 6.283185394602366);
  assert.strictEqual(r.snakes[0].sep, 8.150943396226415);
  const r15 = runScenario('S13b_offbox_alone');
  const pbu = Array.from(geoOf(r15, 2).pbu).join('');
  assert.ok(pbu.endsWith('220000'));
});

test('F16 own name fade', () => {
  const r = runScenario('S14_own_name');
  assert.strictEqual(r.snakes[0].fnfr, 201);
  assert.strictEqual(r.snakes[0].na, 0.996);
  assert.deepStrictEqual(r.calls[3], ['=globalAlpha', 0.498]);
  assert.deepStrictEqual(r.calls[8], ['fillText', 'Owen', 750, 468.4292940666415]);
});

test('F17 sep step, F18 iiv turning on', () => {
  const r = runScenario('S15_sep_step');
  assert.strictEqual(r.snakes[0].sep, 6.0035);
  assert.strictEqual(geoOf(r, 7).bp, 58);
  assert.strictEqual(r.snakes[0].wehang, 0.12023320992524233);
  const r18 = runScenario('S16_iiv_on');
  assert.strictEqual(r18.snakes[0].iiv, true);
  assert.strictEqual(r18.snakes[0].ehang, 0.125);
});

test('F19, F20 wwk carries between snakes (K3)', () => {
  const r = runScenario('S17_wwk_carry');
  const g = geoOf(r, 2);
  assert.strictEqual(g.bp, 11);
  assert.strictEqual(g.wwk, 12.965517241379311);
  assert.strictEqual(shaBuf(g.pbx), 'c17a0a07821e21f4');
  const r20 = runScenario('S17b_two_points_alone');
  const g20 = geoOf(r20, 2);
  assert.strictEqual(g20.bp, 11);
  assert.strictEqual(g20.wwk, undefined);
  assert.strictEqual(shaBuf(g20.pbx), '0c4fff41ea152979');
  assert.strictEqual(g20.pbx[1], 1137.5369873046875);
});

test('F21 nsr: no rotate; F22 custom skin frame 0', () => {
  const r = runScenario('S18_nsr');
  assert.strictEqual(countOf(r.calls, (c) => c[0] === 'rotate'), 0);
  const r22 = runScenario('S19_custom_skin');
  assert.ok(r22.calls.filter(isDraw('kmcs')).every((c) => c[1].endsWith(':0')));
});

test('F23 head clamp', () => {
  const r = runScenario('S20_head_clamp');
  const g = geoOf(r, 7);
  assert.strictEqual(g.bp, 55);
  assert.strictEqual(g.pbx[0], 1324);
  assert.deepStrictEqual(Array.from(g.pbx.subarray(1, 6)), [1317.0244140625, 1310.0201416015625, 1302.9583740234375, 1295.8104248046875, 1288.547607421875]);
  assert.strictEqual(r.snakes[0].wehang, 6.283185394602366);
});

test('F24, F25 antenna', () => {
  const r = runScenario('S21_antenna24_2frames');
  const o = r.snakes[0];
  assert.strictEqual(r.rnd, 14);
  assert.strictEqual(o.antenna_shown, true);
  assert.strictEqual(o.atba, 0);
  assert.strictEqual(o.atx[0], 1275.3135986328125);
  assert.strictEqual(o.aty[0], 986.9085083007812);
  const i = r.calls.findIndex((c) => c[0] === '=strokeStyle' && c[1] === '#00688c');
  assert.deepStrictEqual(r.calls.slice(i - 1, i + 6), [['=globalAlpha', 1], ['=strokeStyle', '#00688c'], ['=lineWidth', 4.9245283018867925],
    ['=lineCap', 'round'], ['=lineJoin', 'round'], ['beginPath'], ['moveTo', 85.42078857421875, -15.22430419921875]]);
  assert.strictEqual(countOf(r.calls, isDraw('acbulb')), 1);
  const r25 = runScenario('S22_antenna25');
  assert.strictEqual(r25.rnd, 16);
  assert.strictEqual(r25.snakes[0].atba, -0.45205799537360103);
  const j = r25.calls.findIndex(isDraw('cdbulb'));
  assert.deepStrictEqual(r25.calls.slice(j - 3, j + 2), [['save'], ['translate', 81.51317138671875, -15.72626953125],
    ['rotate', -0.45205799537360103], ['drawImage', 'cdbulb', -7.879245283018868, -15.758490566037736, 31.516981132075472, 31.516981132075472],
    ['restore']]);
});

test('F26 skin 40 jyt, F27 skin 63 eyes while dying', () => {
  const r = runScenario('S23_jyt40');
  assert.strictEqual(countOf(r.calls, (c) => c[0] === 'arc'), 0);
  const i = r.calls.findIndex(isDraw('ecmc'));
  assert.deepStrictEqual(r.calls.slice(i - 2, i + 1), [['translate', 869.9592812689484, 405.0396302176889], ['rotate', 0.125],
    ['drawImage', 'ecmc', -5.909433962264151, -5.909433962264151, 11.818867924528302, 11.818867924528302]]);
  assert.deepStrictEqual(r.calls.find(isDraw('jmou')),
    ['drawImage', 'jmou', -6.303396226415094, -10.243018867924528, 12.449207547169811, 20.486037735849056]);
  const r27 = runScenario('S24_skin63_eyes');
  const k = r27.calls.findIndex((c) => c[0] === '=fillStyle' && c[1] === '#000000');
  assert.deepStrictEqual(r27.calls[k + 1], ['=globalAlpha', 0.8660254037844386]);
  const p = r27.calls.findIndex((c) => c[0] === '=fillStyle' && c[1] === '#CCCCCC');
  assert.deepStrictEqual(r27.calls[p - 1], ['=globalAlpha', 0.8660254037844386]);
  assert.strictEqual(r27.calls[p + 2][3], 2.4622641509433962);
  assert.strictEqual(countOf(r27.calls, isDraw('kdmc')), 53);
});

test('F30 short length budget', () => {
  const r = runScenario('S27_short_budget');
  const g = geoOf(r, 7);
  assert.strictEqual(g.bp, 31);
  assert.strictEqual(g.pbx[30], 1143.9791259765625);
  assert.strictEqual(g.pby[30], 1026.7535400390625);
  assert.strictEqual(shaBuf(g.pbx), 'd49d77d02bb60d3b');
});

test('drawSnakes never calls Math.random and skips snakes that are not in view', () => {
  const real = Math.random;
  let n = 0;
  Math.random = () => { n++; return real(); };
  try {
    runScenario('S21_antenna24_2frames');
    runScenario('S22_antenna25');
  } finally {
    Math.random = real;
  }
  assert.strictEqual(n, 0);
  const W = makeWorld({});
  const o = buildSnake(W, Object.assign({}, BASE, { pts: CURVE.map(([x, y]) => [x + 9000, y]), head: [HEAD[0] + 9000, HEAD[1]] }));
  const fr = runFrame(W);
  assert.strictEqual(o.iiv, false);
  assert.deepStrictEqual(fr.calls, [['save'], ['=strokeStyle', '#90C098']]);
});
