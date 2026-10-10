'use strict';
// slInput (build brief section 11 "slInput", spec loop-page-input.md 6 and 9.4 I1-I6, plus the X3 angle case).
// Every expected value below was produced by running THEIR oef and handlers in a node vm (reference side) and
// is copied here as a literal, compared with ===. The frame driver below stands in for slLoop: it runs their
// timing (game.js:4009-4036 with lag off, which these vectors keep off) to get vfrb, then calls the four send
// steps in oef order (step 2, step 9 under "connected", step 12 under "own snake").
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'public', 'js', 'sl', 'slInput.js');
const SRC = fs.readFileSync(FILE, 'utf8');

function load(win) {
  new Function('window', SRC)(win);
  return win.DuelSlither;
}

// A fake window: event-handler properties land as plain properties; addEventListener is recorded.
function fakeWindow() {
  const listeners = {};
  return {
    document: {},
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    __listeners: listeners
  };
}

// The byte form their client sends at protocol_version >= 5 (game.js:4499-4552, 4696-4751), which the
// harness transport also uses (brief 12.2 R2). Used only to compare with the vectors.
function bytesOf(ev) {
  if (ev.type === 'angle') return [ev.q];
  if (ev.type === 'turn') return [252, ev.dir === 'left' ? ev.v : ev.v + 128];
  if (ev.type === 'boost') return [ev.on ? 253 : 254];
  if (ev.type === 'ping') return [251];
  throw new Error('unknown event ' + ev.type);
}

function snake(extra) {
  return Object.assign({ md: false, wmd: false, eang: 0, wang: 0, scang: 1, spang: 1 }, extra || {});
}

function rig(over) {
  const win = fakeWindow();
  const D = load(win);
  const S = {};
  D.S = S;
  const clock = { t: 0, ltm: 1000, fr: 0 };
  const sent = [];
  D.slLoop = { now: () => clock.t };
  D.slNet = { send(ev) { sent.push({ t: clock.t, ev: Object.assign({}, ev), bytes: bytesOf(ev) }); } };
  const I = D.slInput;
  I.initInputState(S);
  Object.assign(S, { connected: true, playing: true, slither: null, wfpr: false, mamu: .033, vfrb: 0, ww: 1280, hh: 720 },
    over || {});
  function frame(ctm) {
    clock.t = ctm;
    let vfr = (ctm - clock.ltm) / 8;
    if (vfr > 5) vfr = 5;
    if (vfr < 0) vfr = 0;
    clock.ltm = ctm;
    const lfr = clock.fr;
    clock.fr += vfr;
    S.vfrb = Math.floor(clock.fr) - Math.floor(lfr);
    const vfrb = S.vfrb;
    I.accumulateArrowTicks();
    if (S.connected) {
      I.stepArrowKeys(ctm);
      I.stepPing(ctm);
    }
    if (S.slither != null) I.stepBoostAndAngle(ctm);
    S.vfrb = 0;
    return vfrb;
  }
  return { D, S, I, win, sent, frame, clock };
}

function newBytes(r, n0) {
  return r.sent.slice(n0).map((s) => s.bytes);
}

test('script load touches nothing but DuelSlither.slInput', () => {
  const win = {};
  Object.defineProperty(win, 'document', { get() { throw new Error('DOM read at load'); } });
  const D = load(win);
  assert.deepStrictEqual(Object.keys(win), ['DuelSlither']);
  assert.deepStrictEqual(Object.keys(D.slInput).sort(), ['accumulateArrowTicks', 'initInputState', 'install',
    'setAcceleration', 'stepArrowKeys', 'stepBoostAndAngle', 'stepPing']);
});

test('initInputState sets exactly LPI 6.1 minus wfpr, at their load values', () => {
  const D = load(fakeWindow());
  const S = {};
  D.slInput.initInputState(S);
  const want = { xm: 0, ym: 0, lsxm: 0, lsym: 0, lsang: 0, want_e: false, last_e_mtm: 0, last_accel_mtm: 0,
    kd_l: false, kd_r: false, kd_u: false, kd_l_frb: 0, kd_r_frb: 0, lkstm: 0, last_ping_mtm: 0, lpstm: 0,
    dmutm: 0, ltchx: -1, ltchy: -1, ltchmtm: -1 };
  assert.deepStrictEqual(Object.keys(S).sort(), Object.keys(want).sort());
  for (const k of Object.keys(want)) assert.strictEqual(S[k], want[k], k);
  assert.ok(!('wfpr' in S));
});

test('install assigns their handlers and nothing else on window', () => {
  const r = rig();
  const before = Object.keys(r.win).sort();
  r.I.install();
  const added = Object.keys(r.win).filter((k) => !before.includes(k)).sort();
  assert.deepStrictEqual(added, ['oncontextmenu', 'onmousedown', 'onmousemove', 'ontouchend', 'ontouchmove', 'ontouchstart']);
  assert.strictEqual(r.win.__listeners.mouseup.length, 1);
  assert.deepStrictEqual(Object.keys(r.win.__listeners), ['mouseup']);
  assert.deepStrictEqual(Object.keys(r.win.document).sort(), ['onkeydown', 'onkeyup']);
});

// I1 (t_loop2 I1): own snake wang 1, pings held off. Columns: x, y, bytes sent, lsang, want_e, eang, last_e_mtm.
const I1 = [
  [100, 0, [], 0, false, 0, 1016.6667],
  [0, 100, [], 0, true, 1.5707963267948966, 1016.6667],
  [0, 101, [[62]], 62, false, 1.5707963267948966, 1050.0001],
  [0, 101, [], 62, false, 1.5707963267948966, 1050.0001],
  [5, 5, [[39]], 39, false, 0.7853981633974483, 1083.3335],
  [5, 5, [], 39, false, 0.7853981633974483, 1083.3335],
  [-100, -1, [[125]], 125, false, -3.131592986903128, 1116.6669],
  [-100, -1, [], 125, false, -3.131592986903128, 1116.6669],
  [16, 0, [[39]], 39, false, 0, 1150.0003],
  [16, 1, [], 39, true, 0.06241880999595735, 1150.0003],
  [0, 0, [], 39, false, 0, 1183.3337],
  [3, 4, [], 39, true, 0.9272952180016122, 1183.3337]
];

test('I1 angle packets: 33 ms gate, dead zone resend of wang, lsang 0 quirk', () => {
  const r = rig({ last_ping_mtm: 1e9, wfpr: true });
  const o = snake({ wang: 1 });
  r.S.slither = o;
  let k = 0;
  for (const [x, y, bytes, lsang, wantE, eang, lastE] of I1) {
    k++;
    r.S.xm = x;
    r.S.ym = y;
    const n0 = r.sent.length;
    r.frame(1000 + 16.6667 * k);
    assert.deepStrictEqual(newBytes(r, n0), bytes, 'k' + k + ' bytes');
    assert.strictEqual(r.S.lsang, lsang, 'k' + k + ' lsang');
    assert.strictEqual(r.S.want_e, wantE, 'k' + k + ' want_e');
    assert.strictEqual(o.eang, eang, 'k' + k + ' eang');
    assert.strictEqual(r.S.last_e_mtm, lastE, 'k' + k + ' last_e_mtm');
  }
  assert.deepStrictEqual(r.sent.map((s) => s.ev), [{ type: 'angle', q: 62 }, { type: 'angle', q: 39 },
    { type: 'angle', q: 125 }, { type: 'angle', q: 39 }]);
});

test('X3 angle bucket 250 is sent; first bucket 0 never is', () => {
  const r = rig({ last_ping_mtm: 1e9, wfpr: true });
  r.S.slither = snake({ wang: 0 });
  r.S.xm = 100;
  r.S.ym = -0.5;
  r.frame(1016.6667);
  assert.deepStrictEqual(r.sent.map((s) => s.bytes), [[250]]);
  assert.strictEqual(r.S.lpstm, 1016.6667);
});

// I2 (t_loop2 I2): wmd per frame; columns: ctm, wmd, md after, bytes, last_accel_mtm.
const I2 = [
  [1016.6667, true, true, [[253]], 1016.6667],
  [1033.3334, false, true, [], 1016.6667],
  [1050.0001, true, true, [], 1016.6667],
  [1066.6668, true, true, [], 1016.6667],
  [1083.3335, true, true, [], 1016.6667],
  [1100.0002, false, false, [[254]], 1100.0002],
  [1116.6669, false, false, [], 1100.0002],
  [1133.3336, false, false, [], 1100.0002],
  [1150.0003, false, false, [], 1100.0002]
];

test('I2 boost packets at most every > 50 ms', () => {
  const r = rig({ last_ping_mtm: 1e9, wfpr: true });
  const o = snake();
  r.S.slither = o;
  let k = 0;
  for (const [ctm, wmd, md, bytes, lam] of I2) {
    k++;
    o.wmd = wmd;
    const n0 = r.sent.length;
    const c = 1000 + 16.6667 * k;
    assert.strictEqual(+c.toFixed(4), ctm);
    r.frame(c);
    assert.strictEqual(o.md, md, 'k' + k + ' md');
    assert.deepStrictEqual(newBytes(r, n0), bytes, 'k' + k);
    assert.strictEqual(r.S.last_accel_mtm, lam, 'k' + k + ' last_accel_mtm');
  }
  assert.deepStrictEqual(r.sent.map((s) => s.ev), [{ type: 'boost', on: true }, { type: 'boost', on: false }]);
});

// I3 (t_loop2 I3): scang 1, spang .5, mouse at the centre. Columns: keys, vfrb, kd_l_frb, kd_r_frb, bytes, lkstm.
const I3 = [
  ['L', 2, 0, 0, [[252, 2]], 1016.6667],
  ['L', 2, 2, 0, [], 1016.6667],
  ['L', 2, 4, 0, [], 1016.6667],
  ['L', 2, 0, 0, [[252, 6]], 1066.6668],
  ['L', 2, 2, 0, [], 1066.6668],
  ['LR', 2, 4, 2, [], 1066.6668],
  ['LR', 2, 0, 0, [[252, 2]], 1116.6669],
  ['LR', 2, 2, 2, [], 1116.6669],
  ['R', 2, 2, 4, [], 1116.6669],
  ['R', 2, 0, 0, [[252, 132]], 1166.667],
  ['R', 2, 0, 2, [], 1166.667],
  ['', 3, 0, 2, [], 1166.667],
  ['', 2, 0, 0, [[252, 130]], 1216.6671],
  ['', 2, 0, 0, [], 1216.6671]
];

test('I3 arrow keys: 252 turn packets with tick counts, left first, every > 50 ms', () => {
  const r = rig({ last_ping_mtm: 1e9, wfpr: true });
  const o = snake({ scang: 1, spang: .5 });
  r.S.slither = o;
  let k = 0;
  for (const [keys, vfrb, kl, kr, bytes, lkstm] of I3) {
    k++;
    r.S.kd_l = keys.includes('L');
    r.S.kd_r = keys.includes('R');
    const n0 = r.sent.length;
    assert.strictEqual(r.frame(1000 + 16.6667 * k), vfrb, 'k' + k + ' vfrb');
    assert.strictEqual(r.S.kd_l_frb, kl, 'k' + k + ' kd_l_frb');
    assert.strictEqual(r.S.kd_r_frb, kr, 'k' + k + ' kd_r_frb');
    assert.deepStrictEqual(newBytes(r, n0), bytes, 'k' + k);
    assert.strictEqual(r.S.lkstm, lkstm, 'k' + k + ' lkstm');
  }
  assert.deepStrictEqual(r.sent.map((s) => s.ev), [{ type: 'turn', dir: 'left', v: 2 }, { type: 'turn', dir: 'left', v: 6 },
    { type: 'turn', dir: 'left', v: 2 }, { type: 'turn', dir: 'right', v: 4 }, { type: 'turn', dir: 'right', v: 2 }]);
  // I3eang: the turn nudge to eang is overwritten in the same frame by the angle step
  assert.strictEqual(o.eang, 0);
});

test('I3 cap: 145 held ticks go out as 127 then 18', () => {
  const r = rig({ last_ping_mtm: 1e12, wfpr: true, lkstm: 1e9 });
  r.S.slither = snake();
  r.S.kd_l = true;
  for (let i = 1; i <= 70; i++) r.frame(1000 + 16.6667 * i);
  assert.strictEqual(r.S.kd_l_frb, 145);
  assert.strictEqual(r.sent.length, 0);
  r.S.lkstm = 0;
  r.S.kd_l = false;
  const want = [[18, [[252, 127]]], [18, []], [18, []], [0, [[252, 18]]], [0, []], [0, []]];
  let i = 71;
  for (const [left, bytes] of want) {
    const n0 = r.sent.length;
    r.frame(1000 + 16.6667 * i);
    assert.strictEqual(r.S.kd_l_frb, left, 'frame ' + i);
    assert.deepStrictEqual(newBytes(r, n0), bytes, 'frame ' + i);
    i++;
  }
});

test('equal left and right counts do not cancel: left goes first, right waits (game.js:4504-4512)', () => {
  const r = rig({ last_ping_mtm: 1e9, wfpr: true });
  r.S.slither = snake();
  r.S.kd_l_frb = 3;
  r.S.kd_r_frb = 3;
  r.I.stepArrowKeys(1000);
  assert.deepStrictEqual(r.sent.map((s) => s.ev), [{ type: 'turn', dir: 'left', v: 3 }]);
  assert.strictEqual(r.S.kd_r_frb, 3);
  r.I.stepArrowKeys(1050);
  assert.strictEqual(r.sent.length, 1); // 50 is not > 50
  r.I.stepArrowKeys(1050.5);
  assert.deepStrictEqual(r.sent[1].ev, { type: 'turn', dir: 'right', v: 3 });
});

test('I4 ping every > 250 ms, only when no ping is pending', () => {
  const r = rig({ last_ping_mtm: 0, wfpr: false });
  const pings = [];
  let pongAt = null;
  for (let k = 1; k <= 40; k++) {
    const c = 1000 + 16.6667 * k;
    if (pongAt !== null && c >= pongAt) {
      r.S.wfpr = false;
      pongAt = null;
    }
    const n0 = r.sent.length;
    r.frame(c);
    const b = newBytes(r, n0);
    if (b.length) {
      pings.push([k, +c.toFixed(4), b]);
      pongAt = c + 40;
      assert.strictEqual(r.S.wfpr, true);
      assert.strictEqual(r.S.last_ping_mtm, c);
      assert.strictEqual(r.S.lpstm, c);
    }
  }
  assert.deepStrictEqual(pings, [[1, 1016.6667, [[251]]], [16, 1266.6672, [[251]]], [31, 1516.6677, [[251]]]]);
  assert.deepStrictEqual(r.sent[0].ev, { type: 'ping' });
});

test('I5 one frame with everything due sends TURN, PING, BOOST, ANGLE in that order', () => {
  const r = rig({ last_ping_mtm: 0, wfpr: false, lkstm: 0, last_accel_mtm: 0, last_e_mtm: 0 });
  r.S.slither = snake({ md: false, wmd: true });
  r.S.kd_r = true;
  r.S.kd_r_frb = 3;
  r.S.xm = 0;
  r.S.ym = -50;
  r.frame(1016.6667);
  assert.deepStrictEqual(r.sent.map((s) => s.bytes), [[252, 133], [251], [253], [188]]);
  assert.deepStrictEqual(r.sent.map((s) => s.ev), [{ type: 'turn', dir: 'right', v: 5 }, { type: 'ping' },
    { type: 'boost', on: true }, { type: 'angle', q: 188 }]);
});

// I6 (t_loop2 I6touch, I6mouse): ww 1280, hh 720. Columns: t, x, y, xm, ym, wmd, dmutm.
const I6 = [
  [0, 700, 400, 60, 40, false, 1500],
  [300, 710, 410, 70, 50, true, 1800],
  [800, 712, 409, 72, 49, false, 2300],
  [950, 740, 400, 100, 40, false, 2450],
  [1100, 741, 401, 101, 41, true, 2600]
];

test('I6 touch double tap boosts; mousedown is suppressed for 1500 ms after a touch', () => {
  const r = rig();
  r.I.install();
  r.S.slither = { wmd: false };
  let pd = 0;
  for (const [t, x, y, xm, ym, wmd, dmutm] of I6) {
    r.clock.t = t;
    r.win.ontouchstart({ touches: [{ clientX: x, clientY: y }], preventDefault() { pd++; } });
    assert.strictEqual(r.S.xm, xm, 't' + t + ' xm');
    assert.strictEqual(r.S.ym, ym, 't' + t + ' ym');
    assert.strictEqual(r.S.slither.wmd, wmd, 't' + t + ' wmd');
    assert.strictEqual(r.S.dmutm, dmutm, 't' + t + ' dmutm');
    r.win.ontouchend();
    assert.strictEqual(r.S.slither.wmd, false);
  }
  assert.strictEqual(pd, 5);
  r.clock.t = 2000;
  r.S.slither.wmd = false;
  let mpd = 0;
  r.win.onmousedown({ clientX: 100, clientY: 100, preventDefault() { mpd++; } });
  assert.strictEqual(r.S.slither.wmd, false);
  assert.strictEqual(mpd, 0);
  r.clock.t = 2700;
  r.win.onmousedown({ clientX: 100, clientY: 100, preventDefault() { mpd++; } });
  assert.strictEqual(r.S.slither.wmd, true);
  assert.strictEqual(r.S.xm, -540);
  assert.strictEqual(r.S.ym, -260);
  assert.strictEqual(r.S.dmutm, 0);
  assert.strictEqual(mpd, 1);
  r.win.__listeners.mouseup[0]({});
  assert.strictEqual(r.S.slither.wmd, false);
});

test('mousedown goes through whatever window.onmousemove holds (game.js:7016)', () => {
  const r = rig();
  r.I.install();
  r.S.slither = { wmd: false };
  const seen = [];
  r.win.onmousemove = (e) => seen.push(e.clientX);
  r.win.onmousedown({ clientX: 7, clientY: 8, preventDefault() {} });
  assert.deepStrictEqual(seen, [7]);
  assert.strictEqual(r.S.slither.wmd, true);
});

test('mouse position is tracked on the menu too (no own snake)', () => {
  const r = rig();
  r.I.install();
  r.win.onmousemove({ clientX: 650, clientY: 300 });
  assert.strictEqual(r.S.xm, 10);
  assert.strictEqual(r.S.ym, -60);
  r.win.onmousemove({});
  assert.strictEqual(r.S.xm, 10);
  // mousedown without an own snake: dmutm reset, nothing else, no preventDefault
  r.S.dmutm = 5;
  r.clock.t = 6;
  let pd = 0;
  r.win.onmousedown({ clientX: 0, clientY: 0, preventDefault() { pd++; } });
  assert.strictEqual(r.S.dmutm, 0);
  assert.strictEqual(r.S.xm, 10);
  assert.strictEqual(pd, 0);
});

test('touch without an own snake only arms the mouse suppression', () => {
  const r = rig();
  r.I.install();
  r.clock.t = 100;
  let pd = 0;
  r.win.ontouchstart({ touches: [{ clientX: 1, clientY: 1 }], preventDefault() { pd++; } });
  r.win.ontouchmove({ touches: [{ clientX: 1, clientY: 1 }] });
  assert.strictEqual(r.S.dmutm, 1600);
  assert.strictEqual(r.S.xm, 0);
  assert.strictEqual(r.S.ltchx, -1);
  assert.strictEqual(pd, 0);
});

test('touchmove steers from the centre, falling back to pageX/pageY', () => {
  const r = rig();
  r.I.install();
  r.S.slither = { wmd: false };
  r.clock.t = 10;
  r.win.ontouchmove({ touches: [{ clientX: 700, clientY: 400 }] });
  assert.deepStrictEqual([r.S.xm, r.S.ym, r.S.dmutm], [60, 40, 1510]);
  r.win.ontouchmove({ touches: [{ pageX: 600, pageY: 300 }] });
  assert.deepStrictEqual([r.S.xm, r.S.ym], [-40, -60]);
});

test('keys: arrows set the hold flags, up and space boost, others do nothing', () => {
  const r = rig();
  r.I.install();
  r.S.slither = { wmd: false };
  const doc = r.win.document;
  doc.onkeydown({ keyCode: 37 });
  doc.onkeydown({ keyCode: 39 });
  assert.deepStrictEqual([r.S.kd_l, r.S.kd_r, r.S.kd_u, r.S.slither.wmd], [true, true, false, false]);
  doc.onkeydown({ keyCode: 32 });
  assert.deepStrictEqual([r.S.kd_u, r.S.slither.wmd], [true, true]);
  doc.onkeyup({ keyCode: 32 });
  assert.deepStrictEqual([r.S.kd_u, r.S.slither.wmd], [false, false]);
  doc.onkeydown({ keyCode: 38 });
  assert.strictEqual(r.S.slither.wmd, true);
  doc.onkeyup({ keyCode: 38 });
  assert.strictEqual(r.S.slither.wmd, false);
  doc.onkeyup({ keyCode: 37 });
  doc.onkeyup({ keyCode: 39 });
  assert.deepStrictEqual([r.S.kd_l, r.S.kd_r], [false, false]);
  const snap = JSON.stringify(r.S);
  for (const code of [13, 10, 8, 16, 27, 48, 65, 87]) {
    doc.onkeydown({ keyCode: code });
    doc.onkeyup({ keyCode: code });
  }
  assert.strictEqual(JSON.stringify(r.S), snap);
  assert.strictEqual(r.sent.length, 0);
});

test('contextmenu is blocked', () => {
  const r = rig();
  r.I.install();
  const log = [];
  const ret = r.win.oncontextmenu({ preventDefault() { log.push('pd'); }, stopPropagation() { log.push('sp'); } });
  assert.strictEqual(ret, false);
  assert.deepStrictEqual(log, ['pd', 'sp']);
});

test('setAcceleration writes wmd only when there is an own snake', () => {
  const r = rig();
  r.I.setAcceleration(1);
  assert.strictEqual(r.S.slither, null);
  r.S.slither = { wmd: false };
  r.I.setAcceleration(1);
  assert.strictEqual(r.S.slither.wmd, true);
  r.I.setAcceleration(0);
  assert.strictEqual(r.S.slither.wmd, false);
});

test('the steps keep their own gates when called ungated', () => {
  const r = rig({ connected: false, kd_l: true, vfrb: 4 });
  r.S.slither = snake({ wmd: true });
  r.I.accumulateArrowTicks();
  assert.strictEqual(r.S.kd_l_frb, 0);
  r.S.kd_l_frb = 4;
  r.I.stepArrowKeys(5000);
  r.I.stepPing(5000);
  assert.strictEqual(r.sent.length, 0);
  // the boost and angle step runs connected or not, whenever there is an own snake
  r.S.xm = 100;
  r.S.ym = 100;
  r.I.stepBoostAndAngle(5000);
  assert.deepStrictEqual(r.sent.map((s) => s.ev), [{ type: 'boost', on: true }, { type: 'angle', q: 31 }]);
  r.S.slither = null;
  r.S.xm = -100;
  r.I.stepBoostAndAngle(6000);
  assert.strictEqual(r.sent.length, 2);
});

test('the turn nudges eang by mamu * v * scang * spang before the angle step overwrites it', () => {
  const r = rig({ last_ping_mtm: 1e9, wfpr: true });
  const o = snake({ eang: 1, scang: 1, spang: .5 });
  r.S.slither = o;
  r.S.kd_l_frb = 2;
  r.I.stepArrowKeys(1000);
  assert.strictEqual(o.eang, 1 - .033 * 2 * 1 * .5);
  r.S.kd_r_frb = 2;
  r.I.stepArrowKeys(1100);
  assert.strictEqual(o.eang, 1 - .033 * 2 * 1 * .5 + .033 * 2 * 1 * .5);
});

test('slNet and slLoop are looked up at call time', () => {
  const r = rig();
  const got = [];
  r.D.slNet = { send(ev) { got.push(ev.type); } };
  r.D.slLoop = { now: () => 42 };
  r.I.stepPing(1000);
  assert.deepStrictEqual(got, ['ping']);
  r.I.install();
  r.win.ontouchend();
  r.win.ontouchmove({ touches: [{ clientX: 0, clientY: 0 }] });
  assert.strictEqual(r.S.dmutm, 1542);
});

test('clean-room hygiene: no random, no reference import, no em dash', () => {
  assert.ok(!/Math\.random/.test(SRC));
  assert.ok(!/slither-reference/.test(SRC));
  assert.ok(!/require\(/.test(SRC));
  assert.ok(!/devicePixelRatio/.test(SRC));
  assert.ok(!SRC.includes(String.fromCharCode(0x2014)));
});
