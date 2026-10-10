'use strict';
// Review pass checks (robustness fixes where ours deliberately stops a failure theirs would hit, and the Mac
// version quirk of their nsr parser). Each module runs alone with small stubs on the DuelSlither namespace.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// A fresh vm context with the given product files run in it (window = the context).
function context(files, extra) {
  const ctx = Object.assign({ console, Math, Uint8Array, Float32Array, ArrayBuffer, DataView, Error, String, Number,
    Array, Object, JSON, isFinite }, extra || {});
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of files) vm.runInContext(read(f), ctx, { filename: f });
  return ctx;
}

// ---------------------------------------------------------------- slMain: nsr and the Play lock

test('macVersion and nsr keep their parser: a version still being read at the end is dropped', () => {
  const ctx = context(['public/js/sl/slMain.js']);
  const M = ctx.DuelSlither.slMain;
  const v = (ua) => Array.from(M.macVersion(ua));
  assert.deepStrictEqual(v('mozilla/5.0 (macintosh; intel mac os x 10_11_6) chrome'), [10, 11, 6]);
  assert.deepStrictEqual(v('x mac os x 10.9.5.4)'), [10, 9, 5]);       // at most 3 numbers
  assert.deepStrictEqual(v('x mac os x 10.11'), [10]);                   // the trailing 11 is never pushed
  assert.deepStrictEqual(v('x mac os x 10;11'), [10]);                   // any other character stops
  assert.deepStrictEqual(v('x mac os x ;'), [0]);                        // an empty number is 0
  assert.deepStrictEqual(v('windows nt 10.0'), []);
  const chrome = (ua) => ({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X ' + ua, platform: 'MacIntel' });
  assert.strictEqual(M.nsrFlag(chrome('10_11_6) AppleWebKit Chrome/49 Safari/537')), true);
  assert.strictEqual(M.nsrFlag(chrome('10_12_6) AppleWebKit Chrome/60 Safari/537')), false);
  assert.strictEqual(M.nsrFlag(chrome('10.11')), false);                 // ends while reading: no version
  assert.strictEqual(M.nsrFlag({ userAgent: 'Mac OS X 10_11_6) Chrome', platform: 'Win32' }), false);
  assert.strictEqual(M.nsrFlag(chrome('10_11_6) Safari/600')), false);  // Safari, not Chrome
});

function applyWorld() {
  const ctx = context(['shared/slCore.js', 'public/js/sl/slApply.js', 'public/js/sl/slMain.js'],
    { module: undefined });
  const D = ctx.DuelSlither;
  // slCore is UMD: in a context without module it lands on DuelSlither.slCore.
  const S = { is_mobile: false };
  D.S = S;
  D.slApply.initApplyState(S);
  const log = [];
  D.slHud = { gameOver: (score, v) => log.push(['hud.gameOver', v]), resetHud: () => log.push(['resetHud']) };
  D.slNet = { hasSocket: () => false, closeSocket: () => {} };
  D.slLoop = { now: () => 5000 };
  return { D, S, log };
}

test('Play is locked from the click until gameOver, like their play_btn (game.js:1366-1370, 9046)', () => {
  const { D, S, log } = applyWorld();
  assert.strictEqual(typeof D.slCore.buildSmus, 'function');
  D.play('first');
  assert.strictEqual(S.want_play, true);
  assert.strictEqual(D.slMain.isPlayLocked(), true);
  S.want_play = false;                       // slNet.connect clears it in the next oef
  S.playing = true;                          // the life started
  D.play('second');                          // mid-life: ignored, no reset
  assert.strictEqual(S.want_play, false);
  assert.strictEqual(D.slMain.nick, 'first');
  // a death: gameOver while playing and not closing unlocks before it reads the own snake
  S.slither = { sct: 10, rsc: 0, fam: .5 };
  D.slApply.gameOver(false);
  assert.strictEqual(D.slMain.isPlayLocked(), false);
  assert.deepStrictEqual(log, [['hud.gameOver', false]]);
  assert.strictEqual(S.want_close_socket, true);
  // a second gameOver while closing does not unlock again (theirs neither); Play works once unlocked
  D.play('third');
  assert.strictEqual(D.slMain.nick, 'third');
  assert.strictEqual(D.slMain.isPlayLocked(), true);
  D.slApply.gameOver(false);
  assert.strictEqual(D.slMain.isPlayLocked(), true);
});

test('a socket that closes with no life running unlocks Play (their 3333 ms retry is not built)', () => {
  const { D, S } = applyWorld();
  D.play('me');
  S.want_play = false;
  S.connecting = true;
  D.slApply.applyClose();                    // closed before packet a
  assert.strictEqual(D.slMain.isPlayLocked(), false);
  D.play('me');
  assert.strictEqual(S.want_play, true);
});

// ---------------------------------------------------------------- slHud: one start fade at a time

test('a second init inside the 500 ms start fade stops the first interval (no orphan loginFade)', () => {
  const live = new Set();
  let next = 100;
  const cleared = [];
  const ctx = context(['public/js/sl/slHud.js'], {
    setInterval: () => { const id = next++; live.add(id); return id; },
    clearInterval: (id) => { cleared.push(id); live.delete(id); }
  });
  const D = ctx.DuelSlither;
  const el = () => ({ style: {} });
  const S = { mc: el(), lbh: el(), lbs: el(), lbn: el(), lbp: el(), lbf: el(), vcm: el(), loch: el(), login_iv: -1 };
  D.S = S;
  D.slLoop = { now: () => 1000 };
  D.slDrawWorld = { buildTilePattern() {} };
  D.slPage = { resize() {} };
  D.slHud.startShowGame();
  assert.strictEqual(S.login_iv, 100);
  D.slHud.startShowGame();
  assert.deepStrictEqual(cleared, [100]);
  assert.deepStrictEqual(Array.from(live), [101]);
  assert.strictEqual(S.login_iv, 101);
  // the idle and death-fade markers are never passed to clearInterval
  S.login_iv = -2;
  D.slHud.startShowGame();
  S.login_iv = -1;
  D.slHud.startShowGame();
  assert.deepStrictEqual(cleared, [100]);
});

// ---------------------------------------------------------------- slNet: one connection per transport

function socketIoWorld() {
  const ctx = context(['shared/slWire.js', 'public/js/sl/slNet.js']);
  const D = ctx.DuelSlither;
  const made = [];
  ctx.io = (ns, opts) => {
    const s = { ns, opts, connected: false, on: {}, emitted: [], disconnects: 0 };
    s.on = (ev, f) => { s.handlers[ev] = f; };
    s.handlers = {};
    s.emit = (ev, d) => s.emitted.push(ev);
    s.disconnect = () => { s.disconnects++; s.connected = false; };
    made.push(s);
    return s;
  };
  const calls = [];
  const t = D.slNet.makeSocketIoTransport({
    onOpen: () => calls.push('open'),
    onFrame: () => calls.push('frame'),
    onClose: () => calls.push('close')
  });
  return { D, t, made, calls };
}

test('socket.io transport: no auto reconnect, a failed connect is the close, close reported once', () => {
  const { t, made, calls } = socketIoWorld();
  t.open();
  const s = made[0];
  assert.strictEqual(s.ns, '/sl');
  assert.strictEqual(s.opts.forceNew, true);
  assert.strictEqual(s.opts.reconnection, false);
  s.handlers.connect_error(new Error('refused'));
  s.handlers.disconnect('transport close');
  assert.deepStrictEqual(calls, ['close']);
  s.connected = true;                        // a late connect after the failure is ignored
  s.handlers.connect();
  assert.deepStrictEqual(calls, ['close']);
});

test('socket.io transport: open once, nothing sent while down, no sl:leave on a dead socket', () => {
  const { t, made, calls } = socketIoWorld();
  t.open();
  const s = made[0];
  s.connected = true;
  s.handlers.connect();
  s.handlers.connect();                      // a second connect event never re-runs the open work
  assert.deepStrictEqual(calls, ['open']);
  t.join('Owen');
  t.send(new Uint8Array([1, 4]));
  s.connected = false;                       // the link dropped
  t.send(new Uint8Array([1, 4]));            // would be buffered by socket.io and sent late: dropped instead
  s.handlers.disconnect('transport close');
  assert.deepStrictEqual(calls, ['open', 'close']);
  t.close();
  assert.deepStrictEqual(s.emitted, ['sl:join', 'sl:i']);
  assert.strictEqual(s.disconnects, 1);
});

// ---------------------------------------------------------------- slWire: non-finite numbers are refused

test('slWire refuses NaN and Infinity at decode; finite raw doubles and -0 still round trip', () => {
  const W = require(path.join(ROOT, 'shared', 'slWire.js'));
  const ok = W.decodeBundle(W.encodeBundle([{ type: 'prey_move', id: 7, xx: 0.1 + 0.2, yy: -0 }], 15));
  assert.ok(Object.is(ok[0].xx, 0.1 + 0.2) && Object.is(ok[0].yy, -0));
  for (const bad of [NaN, Infinity, -Infinity]) {
    const out = W.decodeBundle(W.encodeBundle([{ type: 'pong' }, { type: 'prey_move', id: 7, xx: 1.5, yy: bad }], 15));
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].type, 'pong');
    assert.strictEqual(out[1].type, 'wire_error');
    assert.strictEqual(out[1].reason, 'value');
  }
});

// ---------------------------------------------------------------- slPage: a window with no area

function pageWorld(iw, ih) {
  const log = [];
  let w = 850, h = 700;
  const mc = { style: {}, getContext: () => ({}),
    get width() { return w; }, set width(v) { w = v; log.push('w=' + v); },
    get height() { return h; }, set height(v) { h = v; log.push('h=' + v); } };
  const win = { innerWidth: iw, innerHeight: ih, document: { querySelector: () => mc } };
  new Function('window', read('public/js/sl/slPage.js'))(win);
  const D = win.DuelSlither;
  const S = {};
  D.S = S;
  D.slHud = { resizeHud() {} };
  D.slDrawWorld = { rebuildGbg() { log.push('rdgbg ' + S.mww + 'x' + S.mhh); }, redraw() { log.push('redraw'); } };
  D.slPage.init(S);
  return { D, S, win, log };
}

test('a 0-wide or 0-high window keeps the last backing size; the next real size works as before', () => {
  const { D, S, win, log } = pageWorld(1280, 720);
  D.slPage.resize();
  assert.deepStrictEqual([S.mww, S.mhh], [1500, 845]);
  log.length = 0;
  win.innerWidth = 0;
  D.slPage.resize();
  assert.deepStrictEqual([S.mww, S.mhh], [1500, 845]);
  assert.deepStrictEqual(log, ['redraw']);   // no 0-sized backing store, no glow rebuild
  win.innerWidth = 0;
  win.innerHeight = 0;
  D.slPage.resize();
  assert.deepStrictEqual([S.mww, S.mhh], [1500, 845]);
  win.innerWidth = 800;
  win.innerHeight = 600;
  log.length = 0;
  D.slPage.resize();
  assert.deepStrictEqual([S.mww, S.mhh], [1440, 1080]);
  assert.deepStrictEqual(log, ['w=1440', 'h=1080', 'rdgbg 1440x1080', 'redraw']);
});

// ---------------------------------------------------------------- slLoop: a throwing frame does not stop the loop

test('oef: a frame that throws still asks for the next frame and leaves vfr and vfrb at 0', () => {
  const rafs = [];
  let clock = 0;
  const ctx = context(['public/js/sl/slLoop.js'], {
    performance: { now: () => clock },
    requestAnimationFrame: (fn) => { rafs.push(fn); return rafs.length; }
  });
  const D = ctx.DuelSlither;
  const S = { lag_mult: 1, lagging: false, wfpr: false, want_play: false, dead_mtm: -1, playing: false, connected: false,
    slither: null, slithers: [], preys: [], foods: [], foods_c: 0, want_close_socket: false };
  D.S = S;
  D.slLoop.initLoopState(S);
  D.slLoop.buildTables(S);
  let boom = true;
  D.slHud = { oefFades() {}, oefMinimap() {}, oefDot() {} };
  D.slInput = {};
  D.slApply = { foodRemoveAt() {} };
  D.slDrawWorld = { redraw() { if (boom) throw new Error('canvas gone'); } };
  clock = 16.6667;
  assert.throws(() => D.slLoop.oef(), /canvas gone/);
  assert.strictEqual(rafs.length, 1);
  assert.strictEqual(S.vfr, 0);
  assert.strictEqual(S.vfrb, 0);
  boom = false;
  clock = 33.3333;
  rafs[0]();
  assert.strictEqual(rafs.length, 2);
  assert.ok(S.fr > 4);                       // the second frame ran its timing step
});
