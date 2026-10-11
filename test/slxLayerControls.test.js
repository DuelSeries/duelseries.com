'use strict';
// The layer controls (SERVER-DESIGN 15.3, 15.5, 18.4 "slxLayer" control cases; task T18): slxHold (hold Q, the phone
// hold button, the rings), slxTouch (thumb stick, heading arrow, both boost gestures) and slxSkins (the 12 picture
// canvases). Each file runs in a node vm on a small fake page of its own (never the gate's: 15.6 item 6) with a fake
// DuelSlither.slx that keeps the slxNet contract (on, send, now, fire, active). The stick test loads the REAL frozen
// public/js/sl/slInput.js, so the angle byte comes out of their own stepBoostAndAngle. Vectors are literals.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SLX = path.join(ROOT, 'public', 'js', 'slx');
const FILES = ['slxHold.js', 'slxTouch.js', 'slxSkins.js'];
const src = (f) => fs.readFileSync(path.join(SLX, f), 'utf8');
const SL_INPUT = fs.readFileSync(path.join(ROOT, 'public', 'js', 'sl', 'slInput.js'), 'utf8');
const SL_SPRITES = fs.readFileSync(path.join(ROOT, 'public', 'js', 'sl', 'slSprites.js'), 'utf8');
const PI2 = 2 * Math.PI;

// ------------------------------------------------------------------------------------------------- the fake page

// The 12 picture canvases as the frozen client makes them (public/js/sl/slSprites.js PICTURE_CANVASES).
function pictureCanvases() {
  const block = /var PICTURE_CANVASES = \[([\s\S]*?)\];/.exec(SL_SPRITES)[1];
  const out = [];
  const re = /\['(\w+)', ([\d +]+), ([\d +]+)\]/g;
  let m;
  while ((m = re.exec(block))) out.push([m[1], sum(m[2]), sum(m[3])]);
  return out;
}
function sum(s) { return s.split('+').reduce((a, b) => a + Number(b.trim()), 0); }

function makePage(o) {
  const opt = o || {};
  const P = { now: 1000, raf: [], listeners: 0, created: [], images: [], sends: [], subs: {}, gameSends: [] };

  class Ctx {
    constructor(cv) { this.canvas = cv; this.calls = []; this.p = {}; }
  }
  for (const m of ['save', 'restore', 'beginPath', 'arc', 'stroke', 'clearRect', 'setTransform', 'drawImage', 'fillRect']) {
    Ctx.prototype[m] = function () { this.calls.push([m].concat([].slice.call(arguments))); };
  }
  for (const k of ['lineCap', 'strokeStyle', 'lineWidth', 'shadowColor', 'shadowBlur', 'fillStyle', 'globalAlpha']) {
    Object.defineProperty(Ctx.prototype, k, {
      get() { return this.p[k]; },
      set(v) { this.calls.push(['set ' + k, v]); this.p[k] = v; }
    });
  }

  class Node {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.style = {};
      this.className = '';
      this.attrs = {};
      this.children = [];
      this.parentNode = null;
      this.ls = {};
      this.textContent = '';
      this.innerHTML = '';
      if (this.tagName === 'CANVAS') { this._w = 300; this._h = 150; this.ctx = null; }
      if (this.tagName === 'IMG') { this._src = ''; this.onload = null; }
    }
    get width() { return this._w; }
    set width(v) { this._w = v; }
    get height() { return this._h; }
    set height(v) { this._h = v; }
    getContext(k) {
      if (k !== '2d') throw new Error('getContext ' + k);
      return this.ctx || (this.ctx = new Ctx(this));
    }
    get src() { return this._src; }
    set src(v) { this._src = String(v); P.images.push(this); }
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return k === 'class' ? this.className : Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    addEventListener(t, f, op) {
      P.listeners++;
      (this.ls[t] = this.ls[t] || []).push({ f, capture: op === true || !!(op && op.capture) });
    }
    removeEventListener(t, f) { this.ls[t] = (this.ls[t] || []).filter((x) => x.f !== f); }
  }

  const doc = new Node('#document');
  doc.hidden = false;
  doc.visibilityState = 'visible';
  doc.body = doc.appendChild(new Node('body'));
  doc.createElement = (tag) => { const n = new Node(tag); P.created.push(n); return n; };
  doc.getElementById = () => null;

  const win = new Node('#window');
  Object.assign(win, {
    document: doc,
    innerWidth: 1000, innerHeight: 800, devicePixelRatio: 1,
    performance: { now: () => P.now },
    requestAnimationFrame(cb) { P.raf.push(cb); return P.raf.length; },
    setTimeout() { throw new Error('the layer controls use no timer'); },
    setInterval() { throw new Error('the layer controls use no timer'); },
    console: { log() {}, warn() {}, error() {} }
  });
  doc.parentNode = win;
  win.window = win;
  win.self = win;
  win.Math = Object.create(Math);
  win.Math.random = () => { throw new Error('Math.random in the layer'); };
  vm.createContext(win);

  // their state, the fields the controls read (BUILD-BRIEF 10.2)
  const S = {
    is_mobile: !!opt.mobile, render_mode: opt.mobile ? 1 : 2,
    slither: null, slithers: [], connected: false, playing: false, dead_mtm: -1,
    ww: 1000, hh: 800, mww: 1000, mhh: 800, csc: 1, gsc: 0.9, view_xx: 500, view_yy: 400
  };
  for (const [name, w, h] of pictureCanvases()) {
    const c = new Node('canvas');
    c._w = w; c._h = h;
    S[name] = c;
  }
  const D = win.DuelSlither = { S };
  if (opt.slInput) {
    D.slLoop = { now: () => P.now };
    D.slNet = { send: (ev) => P.gameSends.push(Object.assign({}, ev)) };
    vm.runInContext(SL_INPUT, win, { filename: 'slInput.js' });
    D.slInput.initInputState(S);
    D.slInput.install();
  } else {
    D.slInput = { setAcceleration: (m) => { P.acc = (P.acc || []).concat(m); if (S.slither) S.slither.wmd = m == 1; } };
  }
  if (opt.slx !== null) {
    D.slx = opt.slx || {
      active: true,
      errors: 0,
      on(name, fn) {
        const list = P.subs[name] = P.subs[name] || [];
        list.push(fn);
        return () => { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); };
      },
      fire(name, a, b) { for (const f of (P.subs[name] || []).slice()) f(a, b); },
      send(name, payload) { P.sends.push(name + ' ' + JSON.stringify(payload)); return true; },
      now: () => P.now
    };
  }

  P.win = win; P.doc = doc; P.S = S; P.D = D; P.Node = Node;
  P.load = (files) => { for (const f of files || FILES) vm.runInContext(src(f), win, { filename: f }); };
  P.step = () => {
    P.now += 16;
    const cbs = P.raf; P.raf = [];
    for (const cb of cbs) cb(P.now);
  };
  P.fire = (name, a, b) => D.slx.fire(name, a, b);
  P.live = () => {
    S.slither = { id: 5, xx: 600, yy: 450, fx: 0, fy: 0, sc: 1, ang: 0, wang: 0, eang: 0, md: false, wmd: false };
    S.slithers = [S.slither];
    S.connected = true;
    S.playing = true;
    S.dead_mtm = -1;
  };
  // A DOM event: capture from the window down, the target, then bubble up (on<type> properties included).
  P.dispatch = (target, type, init) => {
    const e = Object.assign({
      type, target, cancelable: true, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.stopped = true; }
    }, init);
    const pathList = [];
    for (let n = target; n; n = n.parentNode) pathList.push(n);
    const run = (node, phase) => {
      for (const l of (node.ls[type] || []).slice()) {
        if (phase === 'capture' && !l.capture) continue;
        if (phase === 'bubble' && l.capture) continue;
        l.f.call(node, e);
      }
      if (phase !== 'capture' && typeof node['on' + type] === 'function') node['on' + type].call(node, e);
    };
    for (let i = pathList.length - 1; i >= 1 && !e.stopped; i--) run(pathList[i], 'capture');
    if (!e.stopped) run(pathList[0], 'target');
    for (let i = 1; i < pathList.length && !e.stopped; i++) run(pathList[i], 'bubble');
    return e;
  };
  // A touch event on `target`: ids and points of the fingers that changed, and every finger now down.
  P.touch = (target, type, changed, down) => P.dispatch(target, type, {
    changedTouches: changed.map(([identifier, clientX, clientY]) => ({ identifier, clientX, clientY })),
    touches: down.map(([identifier, clientX, clientY]) => ({ identifier, clientX, clientY }))
  });
  P.key = (type, keyCode, extra) => P.dispatch(doc, type, Object.assign({ keyCode, which: keyCode }, extra));
  // the game canvas the touches land on (their mc, class nsi)
  P.mc = doc.body.appendChild(new Node('canvas'));
  P.mc.className = 'nsi';
  return P;
}

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, (msg || '') + ': ' + a + ' vs ' + b);
const ofLayer = (P, cls) => P.created.find((n) => n.className === cls);

// ------------------------------------------------------------------------------------------------------- inert

test('inert: with no slx or an inactive slx the three files make no listener, frame, node or image', () => {
  for (const slx of [null, { active: false }]) {
    for (const mobile of [false, true]) {
      const P = makePage({ slx, mobile });
      const before = P.listeners;
      P.load();
      assert.strictEqual(P.listeners - before, 0, 'listeners');
      assert.strictEqual(P.raf.length, 0, 'animation frames');
      assert.strictEqual(P.created.length, 0, 'nodes');
      assert.strictEqual(P.images.length, 0, 'images');
      assert.strictEqual(P.S.render_mode, mobile ? 1 : 2, 'render_mode untouched');
      assert.strictEqual(P.D.slx === null || P.D.slx === undefined || P.D.slx.hold === undefined, true, 'no slx.hold');
    }
  }
});

// -------------------------------------------------------------------------------------------------------- hold Q

test('hold Q: one press per hold, no repeat, keyup releases; not while dead or typing', () => {
  const P = makePage();
  P.load();
  P.key('keydown', 81);
  assert.deepStrictEqual(P.sends, [], 'no snake: nothing');
  P.live();
  P.key('keydown', 81);
  P.key('keydown', 81, { repeat: true });
  P.key('keydown', 81);
  assert.deepStrictEqual(P.sends, ['sl:hold {"on":1}']);
  assert.strictEqual(P.D.slx.hold.held(), true);
  P.key('keyup', 81);
  P.key('keyup', 81);
  assert.deepStrictEqual(P.sends, ['sl:hold {"on":1}', 'sl:hold {"on":0}']);
  P.sends.length = 0;
  P.key('keydown', 81, { ctrlKey: true });
  P.key('keydown', 81, { target: new P.Node('input') });
  P.key('keydown', 32);
  assert.deepStrictEqual(P.sends, [], 'ctrl, a text box, other keys');
  P.S.dead_mtm = 4000;
  P.key('keydown', 81);
  assert.deepStrictEqual(P.sends, [], 'dying');
  P.S.dead_mtm = -1;
  P.S.connected = false;
  P.key('keydown', 81);
  assert.deepStrictEqual(P.sends, [], 'not connected');
});

test('hold Q: blur, hidden, own death, close and the frame check each release once', () => {
  const ends = {
    blur: (P) => P.dispatch(P.win, 'blur', {}),
    hidden: (P) => { P.doc.hidden = true; P.doc.visibilityState = 'hidden'; P.dispatch(P.doc, 'visibilitychange', {}); },
    ownDead: (P) => P.fire('ownDead', { type: 'dead', code: 0 }),
    close: (P) => P.fire('close', { playing: true, opened: true, sawDead: false, refused: null }),
    frame: (P) => { P.S.dead_mtm = 5000; P.step(); }
  };
  for (const name of Object.keys(ends)) {
    const P = makePage();
    P.load();
    P.live();
    P.key('keydown', 81);
    ends[name](P);
    assert.deepStrictEqual(P.sends, ['sl:hold {"on":1}', 'sl:hold {"on":0}'], name);
    assert.strictEqual(P.D.slx.hold.held(), false, name);
    P.key('keyup', 81);
    assert.strictEqual(P.sends.length, 2, name + ': the keyup after it sends nothing');
  }
});

test('sl:vis: a hidden tab releases the hold here; the visibility report itself is slxNet\'s, never sent twice', () => {
  const P = makePage();
  P.load();
  P.live();
  P.doc.hidden = true;
  P.doc.visibilityState = 'hidden';
  P.dispatch(P.doc, 'visibilitychange', {});
  P.doc.hidden = false;
  P.doc.visibilityState = 'visible';
  P.dispatch(P.doc, 'visibilitychange', {});
  assert.deepStrictEqual(P.sends, [], 'no hold: nothing, and slxHold never emits sl:vis');
  for (const f of FILES) assert.ok(!/sl:vis'/.test(src(f).replace(/\/\/.*$/gm, '')), f + ' emits no sl:vis');
});

test('with the real slxNet: hold and release reach the /sl socket, a hidden tab sends one sl:vis then the release', (t) => {
  const net = path.join(SLX, 'slxNet.js');
  if (!fs.existsSync(net)) { t.skip('public/js/slx/slxNet.js not built yet (T16)'); return; }
  const P = makePage({ slx: null });
  const sockets = [];
  P.win.io = function (uri) {
    const s = { uri, connected: true, emits: [], handlers: {},
      on(n, f) { (this.handlers[n] = this.handlers[n] || []).push(f); },
      emit(n, p) { this.emits.push(n + ' ' + JSON.stringify(p)); } };
    sockets.push(s);
    return s;
  };
  P.D.slNet = { makeSocketIoTransport() { P.win.io('/sl', {}); return { open() {}, send() {}, close() {} }; } };
  P.D.slWire = { decodeInput: () => [] };
  vm.runInContext(fs.readFileSync(net, 'utf8'), P.win, { filename: 'slxNet.js' });
  assert.strictEqual(P.D.slx.active, true);
  P.load(['slxHold.js']);
  P.win.DuelSlitherConfig.transport({ onOpen() {}, onFrame() {}, onClose() {} });
  const s = sockets[0];
  P.live();
  P.key('keydown', 81);
  P.key('keyup', 81);
  P.key('keydown', 81);
  P.doc.hidden = true;
  P.doc.visibilityState = 'hidden';
  P.dispatch(P.doc, 'visibilitychange', {});
  assert.deepStrictEqual(s.emits, ['sl:hold {"on":1}', 'sl:hold {"on":0}', 'sl:hold {"on":1}', 'sl:vis {"hidden":1}',
    'sl:hold {"on":0}']);
  for (const f of s.handlers['sl:x']) f([{ t: 'hold', id: 5, on: 1, need: 3000 }]);
  assert.deepStrictEqual(Array.from(P.D.slx.hold.rings()), [5], 'a ring from the socket sl:x');
});

// ----------------------------------------------------------------------------------------------- the hold button

test('phone hold button: only on phones, shown while alive, touch press and release, never reaches their handlers', () => {
  const desk = makePage();
  desk.load();
  assert.strictEqual(ofLayer(desk, 'slx-hold'), undefined, 'no button on a computer');

  const P = makePage({ mobile: true, slInput: true });
  P.load();
  const b = ofLayer(P, 'slx-hold');
  assert.ok(b && b.tagName === 'BUTTON' && b.parentNode === P.doc.body);
  assert.strictEqual(b.textContent, 'CASH OUT');
  P.step();
  assert.strictEqual(b.style.display, 'none', 'hidden with no snake');
  P.live();
  P.step();
  assert.strictEqual(b.style.display, 'flex', 'shown while alive');
  const ltch = P.S.ltchmtm;
  const e1 = P.touch(b, 'touchstart', [[3, 500, 760]], [[3, 500, 760]]);
  assert.strictEqual(e1.defaultPrevented, true);
  assert.strictEqual(e1.stopped, true);
  assert.deepStrictEqual(P.sends, ['sl:hold {"on":1}']);
  assert.strictEqual(b.style.transform, 'translateX(-50%) scale(0.94)', 'pressed look');
  assert.strictEqual(P.S.ltchmtm, ltch, 'their ontouchstart never ran');
  assert.strictEqual(P.D.slx.touch.state().own, 0, 'the stick did not take it');
  const e2 = P.touch(b, 'touchend', [[3, 500, 760]], []);
  assert.strictEqual(e2.stopped, true);
  assert.deepStrictEqual(P.sends, ['sl:hold {"on":1}', 'sl:hold {"on":0}']);
  assert.strictEqual(b.style.transform, 'translateX(-50%)');
  for (const type of ['mousedown', 'mouseup', 'contextmenu']) {
    assert.strictEqual(P.dispatch(b, type, {}).stopped, true, type + ' stops at the button');
  }
  assert.strictEqual(P.S.slither.wmd, false, 'no boost from the button');
  P.touch(b, 'touchstart', [[4, 500, 760]], [[4, 500, 760]]);
  P.touch(b, 'touchcancel', [[4, 500, 760]], []);
  assert.deepStrictEqual(P.sends.slice(2), ['sl:hold {"on":1}', 'sl:hold {"on":0}'], 'touchcancel releases');
  P.S.dead_mtm = 9000;
  P.step();
  assert.strictEqual(b.style.display, 'none', 'hidden once dying');
});

// ---------------------------------------------------------------------------------------------------------- rings

test('rings: sl:x hold draws the old ring at the snake head, filling over need; on 0, unknown ids and junk draw none', () => {
  for (const mobile of [false, true]) {
    const P = makePage({ mobile });
    P.load();
    P.live();
    const ring = ofLayer(P, 'slx-ring');
    assert.ok(ring && ring.style.pointerEvents === 'none' && ring.style.zIndex === '6');
    P.fire('x:hold', { t: 'hold', id: 5, on: 1, need: 3000 });          // t0 = 1000
    P.fire('x:hold', { t: 'hold', id: 9, on: 1 });                      // no need: ignored
    P.fire('x:hold', { t: 'hold', id: 'x', on: 1, need: 3000 });       // not an id: ignored
    assert.deepStrictEqual(Array.from(P.D.slx.hold.rings()), [5]);
    P.now = 2484;
    P.step();                                                           // now 2500: half way
    const calls = ring.ctx.calls;
    const arcs = calls.filter((c) => c[0] === 'arc');
    assert.strictEqual(arcs.length, 2, 'track and arc');
    // head (600, 450), view (500, 400), gsc 0.9, csc 1, 1000 x 800: (590, 445); head radius 14.5 x 0.9 = 13.05
    near(arcs[0][1], 590, 'x');
    near(arcs[0][2], 445, 'y');
    near(arcs[0][3], 22.8375, 'ring radius 1.75 head radii');
    near(arcs[0][4], 0, 'track start');
    near(arcs[0][5], PI2, 'track end');
    near(arcs[1][4], -Math.PI / 2, 'arc from the top');
    near(arcs[1][5], Math.PI / 2, 'half filled');
    const widths = calls.filter((c) => c[0] === 'set lineWidth').map((c) => c[1]);
    near(widths[0], 3.654, 'line 0.28 head radii');
    assert.deepStrictEqual(calls.filter((c) => c[0] === 'set strokeStyle').map((c) => c[1]), ['rgba(255,255,255,0.15)', '#14F195']);
    const blur = calls.filter((c) => c[0] === 'set shadowBlur').map((c) => c[1]);
    if (mobile) assert.deepStrictEqual(blur, [], 'no glow on phones');
    else near(blur[0], 15.66, 'glow 1.2 head radii');

    P.now = 9000;
    ring.ctx.calls = [];
    P.step();
    near(ring.ctx.calls.filter((c) => c[0] === 'arc')[1][5], 1.5 * Math.PI, 'full at need and after');

    P.fire('x:hold', { t: 'hold', id: 5, on: 0 });
    ring.ctx.calls = [];
    P.step();
    assert.deepStrictEqual(ring.ctx.calls.map((c) => c[0]), ['setTransform', 'clearRect'], 'cleared once');
    ring.ctx.calls = [];
    P.step();
    assert.deepStrictEqual(ring.ctx.calls, [], 'then idle');

    P.fire('x:hold', { t: 'hold', id: 5, on: 1, need: 3000 });
    P.S.slithers = [];
    ring.ctx.calls = [];
    P.step();
    assert.strictEqual(ring.ctx.calls.filter((c) => c[0] === 'arc').length, 0, 'snake not in view: no ring');
    assert.deepStrictEqual(Array.from(P.D.slx.hold.rings()), [5], 'kept until on 0');
    P.S.slithers = [P.S.slither];
    P.fire('close', {});
    assert.deepStrictEqual(Array.from(P.D.slx.hold.rings()), [], 'close forgets the rings');
  }
});

// ---------------------------------------------------------------------------------------------- stick and arrow

test('stick: the old anchored stick gives the expected byte through their real stepBoostAndAngle', () => {
  const P = makePage({ mobile: true, slInput: true });
  P.load();
  P.live();
  const ltch = P.S.ltchmtm;
  const dmu = P.S.dmutm;
  const e = P.touch(P.mc, 'touchstart', [[0, 300, 300]], [[0, 300, 300]]);
  assert.strictEqual(e.defaultPrevented, true, 'no compatibility mouse event');
  assert.strictEqual(e.stopped, true);
  assert.strictEqual(P.S.ltchmtm, ltch, 'their ontouchstart never ran');
  assert.strictEqual(P.S.dmutm, dmu);
  assert.deepStrictEqual([P.S.xm, P.S.ym], [0, 0], 'landing asks for no turn');

  P.touch(P.mc, 'touchmove', [[0, 340, 340]], [[0, 340, 340]]);
  near(P.S.xm, 70.71067811865476, 'xm 100 px along pi / 4');
  near(P.S.ym, 70.71067811865474, 'ym');
  P.D.slInput.stepBoostAndAngle(2000);
  assert.deepStrictEqual(P.gameSends, [{ type: 'angle', q: 31 }]);

  // past 60 px the anchor follows to (323.517, 382.309)
  P.touch(P.mc, 'touchmove', [[0, 340, 440]], [[0, 340, 440]]);
  P.D.slInput.stepBoostAndAngle(2100);
  const st = P.D.slx.touch.state();
  near(st.anchorX, 323.5167323261573, 'anchor x');
  near(st.anchorY, 382.3085631415506, 'anchor y');
  // back up 60 px: from the followed anchor this is a little up and right (byte 245); from the landing point it
  // would be down and right (byte 44)
  P.touch(P.mc, 'touchmove', [[0, 340, 380]], [[0, 340, 380]]);
  P.D.slInput.stepBoostAndAngle(2200);
  assert.deepStrictEqual(P.gameSends.slice(1).map((s) => s.q), [51, 245]);

  // lift: carry on along the snake's real heading (ang 1 rad: byte 39)
  P.S.slither.ang = 1;
  P.touch(P.mc, 'touchend', [[0, 340, 380]], []);
  P.D.slInput.stepBoostAndAngle(2300);
  assert.deepStrictEqual(P.gameSends.slice(3), [{ type: 'angle', q: 39 }]);

  // a new landing inside the 10 px dead zone keeps the line
  const xm = P.S.xm;
  const ym = P.S.ym;
  P.now = 5000;
  P.touch(P.mc, 'touchstart', [[1, 100, 100]], [[1, 100, 100]]);
  P.touch(P.mc, 'touchmove', [[1, 105, 105]], [[1, 105, 105]]);
  assert.deepStrictEqual([P.S.xm, P.S.ym], [xm, ym]);
  P.touch(P.mc, 'touchend', [[1, 105, 105]], []);
  assert.strictEqual(P.S.slither.wmd, false, 'no boost on the way');
});

test('boost: a second finger held, and their double tap held, both through setAcceleration', () => {
  const P = makePage({ mobile: true, slInput: true });
  P.load();
  P.live();
  // second finger
  P.touch(P.mc, 'touchstart', [[0, 300, 300]], [[0, 300, 300]]);
  P.now += 1000;
  P.touch(P.mc, 'touchstart', [[1, 700, 600]], [[0, 300, 300], [1, 700, 600]]);
  assert.strictEqual(P.S.slither.wmd, true, 'pedal down');
  P.D.slInput.stepBoostAndAngle(P.now);
  assert.deepStrictEqual(P.gameSends.filter((s) => s.type === 'boost'), [{ type: 'boost', on: true }]);
  P.touch(P.mc, 'touchmove', [[1, 650, 600]], [[0, 300, 300], [1, 650, 600]]);
  assert.deepStrictEqual([P.S.xm, P.S.ym], [0, 0], 'the pedal never steers');
  P.touch(P.mc, 'touchend', [[1, 650, 600]], [[0, 300, 300]]);
  assert.strictEqual(P.S.slither.wmd, false, 'pedal up');
  P.touch(P.mc, 'touchend', [[0, 300, 300]], []);

  // double tap: within 24 px in x and in y and under 400 ms (slInput.js:133)
  const cases = [[[210, 190], 300, true], [[230, 200], 300, false], [[210, 225], 300, false], [[200, 200], 400, false]];
  for (const [[x, y], dt, boost] of cases) {
    const Q = makePage({ mobile: true, slInput: true });
    Q.load();
    Q.live();
    Q.touch(Q.mc, 'touchstart', [[0, 200, 200]], [[0, 200, 200]]);
    Q.touch(Q.mc, 'touchend', [[0, 200, 200]], []);
    assert.strictEqual(Q.S.slither.wmd, false, 'one tap: no boost');
    Q.now += dt;
    Q.touch(Q.mc, 'touchstart', [[1, x, y]], [[1, x, y]]);
    assert.strictEqual(Q.S.slither.wmd, boost, 'tap at ' + x + ',' + y + ' after ' + dt + ' ms');
    Q.touch(Q.mc, 'touchmove', [[1, x + 40, y]], [[1, x + 40, y]]);
    assert.strictEqual(Q.S.slither.wmd, boost, 'held while the finger stays');
    Q.touch(Q.mc, 'touchend', [[1, x + 40, y]], []);
    assert.strictEqual(Q.S.slither.wmd, false, 'lift ends it');
  }
});

test('stick: a new life drops a held boost; with no snake the touch is left to their handlers', () => {
  const P = makePage({ mobile: true, slInput: true });
  P.load();
  const e = P.touch(P.mc, 'touchstart', [[0, 300, 300]], [[0, 300, 300]]);
  assert.strictEqual(e.stopped, false, 'no snake: not taken');
  P.touch(P.mc, 'touchend', [[0, 300, 300]], []);
  P.live();
  P.step();
  P.touch(P.mc, 'touchstart', [[1, 300, 300]], [[1, 300, 300]]);
  P.touch(P.mc, 'touchstart', [[2, 600, 300]], [[1, 300, 300], [2, 600, 300]]);
  assert.strictEqual(P.D.slx.touch.boosting(), true);
  P.S.slither = null;
  P.step();
  assert.strictEqual(P.D.slx.touch.boosting(), false);
  assert.strictEqual(P.D.slx.touch.state().own, 0);
});

test('heading arrow: at the own head along its heading while a finger steers, hidden otherwise', () => {
  const P = makePage({ mobile: true, slInput: true });
  P.load();
  P.live();
  const a = ofLayer(P, 'slx-arrow');
  assert.ok(a && a.style.pointerEvents === 'none' && /<svg/.test(a.innerHTML));
  P.step();
  assert.strictEqual(a.style.opacity, '0');
  P.touch(P.mc, 'touchstart', [[0, 300, 300]], [[0, 300, 300]]);
  P.S.slither.ang = 0.5;
  P.step();
  assert.strictEqual(a.style.opacity, '1');
  assert.strictEqual(a.style.transform, 'translate(-50%, -50%) translate(590px, 445px) rotate(0.5rad) translateX(46px)');
  P.touch(P.mc, 'touchend', [[0, 300, 300]], []);
  P.step();
  assert.strictEqual(a.style.opacity, '0');
});

test('computers: no stick, no arrow, their touch and mouse handlers run as before', () => {
  const P = makePage({ slInput: true });
  const before = P.listeners;
  P.load(['slxTouch.js']);
  assert.strictEqual(P.listeners - before, 0);
  assert.strictEqual(P.created.length, 0);
  assert.strictEqual(P.raf.length, 0);
  assert.strictEqual(P.D.slx.touch, undefined);
  P.live();
  P.now = 7000;
  const e = P.touch(P.mc, 'touchstart', [[0, 520, 380]], [[0, 520, 380]]);
  assert.strictEqual(e.stopped, false);
  assert.strictEqual(P.S.ltchmtm, 7000, 'their ontouchstart ran');
  assert.deepStrictEqual([P.S.xm, P.S.ym], [20, -20]);
});

// ------------------------------------------------------------------------------------------------- picture skins

const PICTURE_FILES = ['kwk6.png', 'jmou3.png', 'pewd.png', 'sest5.png', 'play.png', 'bonkers2.png', 'leaf.png', 'swiss.png',
  'moldova.png', 'vietnam.png', 'argentina.png', 'mov2.png'];
const PICTURE_CVS = [37, 39, 40, 41, 42, 45, 46, 47, 48, 49, 59, 62];

test('picture skins: nothing loads while the server sends no picture skin (PICTURE_SKINS off)', () => {
  const P = makePage();
  P.load();
  for (let cv = 0; cv <= 65; cv++) if (!PICTURE_CVS.includes(cv)) P.fire('frame', [{ type: 'snake_add', id: 1, cv }]);
  P.fire('frame', [{ type: 'leaderboard', rows: [{ raw: { cv: 37 } }] }]);
  assert.strictEqual(P.images.length, 0);
  assert.strictEqual(P.D.slx.skins.painted(), false);
  for (const [name] of pictureCanvases()) assert.strictEqual(P.S[name].ctx, null, name + ' untouched');
});

test('picture skins: the first picture skin loads the 12 files once; each canvas equals their onload sequence', () => {
  const P = makePage();
  P.load();
  P.fire('frame', [{ type: 'snake_add', id: 1, cv: 3 }, { type: 'snake_add', id: 2, cv: 59 }]);
  P.fire('frame', [{ type: 'snake_add', id: 3, cv: 37 }]);
  assert.deepStrictEqual(P.images.map((i) => i.src), PICTURE_FILES.map((f) => '/img/slx/' + f));
  const canvases = pictureCanvases();
  assert.deepStrictEqual(canvases.map((c) => c[0]), ['kwkbulb', 'jmou', 'pwdbulb', 'sest', 'playbulb', 'bonkbulb', 'leafbulb',
    'swissbulb', 'moldovabulb', 'vietnambulb', 'argentinabulb', 'movbulb'], 'their load order, the frozen canvases');
  const imgs = P.images.slice();
  for (let i = 0; i < imgs.length; i++) {
    const [name, w, h] = canvases[i];
    const target = P.S[name];
    const made = P.created.length;
    imgs[i].onload();
    const calls = target.ctx.calls;
    if (name === 'jmou' || name === 'sest') {
      assert.strictEqual(calls.length, 1, name);
      assert.deepStrictEqual(calls[0].slice(0, 1).concat(calls[0].slice(2)), ['drawImage', 0, 0], name);
      assert.strictEqual(calls[0][1], imgs[i], name + ' draws its own image');
      assert.strictEqual(P.created.length, made, name + ': no temp canvas');
    } else {
      const tmc = P.created[made];
      assert.ok(tmc && tmc.tagName === 'CANVAS', name + ': a temp canvas');
      assert.deepStrictEqual([tmc.width, tmc.height], [w, h], name + ': temp canvas of the bulb size');
      assert.strictEqual(tmc.ctx.calls.length, 1);
      assert.strictEqual(tmc.ctx.calls[0][1], imgs[i]);
      assert.deepStrictEqual([tmc.ctx.calls[0][0], tmc.ctx.calls[0][2], tmc.ctx.calls[0][3]], ['drawImage', 21, 21]);
      assert.deepStrictEqual(calls.slice(0, 2), [['set shadowColor', '#000000'], ['set shadowBlur', 20]], name);
      assert.strictEqual(calls.length, 3, name);
      assert.deepStrictEqual([calls[2][0], calls[2][2], calls[2][3]], ['drawImage', 0, 0], name);
      assert.strictEqual(calls[2][1], tmc, name + ' draws the padded canvas');
    }
  }
  assert.strictEqual(P.D.slx.skins.loads(), 12);
  P.fire('frame', [{ type: 'snake_add', id: 4, cv: 62 }]);
  assert.strictEqual(P.images.length, 12, 'once only');
});

test('picture skins: the 12 ids are the server\'s (slBots PICTURE_SKIN_CVS) and every own-snake id is one', () => {
  assert.deepStrictEqual(Array.from(require('../server/sl/slBots.js').PICTURE_SKIN_CVS), PICTURE_CVS);
  for (const cv of PICTURE_CVS) {
    const P = makePage();
    P.load();
    P.fire('frame', [{ type: 'snake_add', id: 9, cv }]);
    assert.strictEqual(P.images.length, 12, 'cv ' + cv);
  }
  // an image file ships only once Owen has looked at it: every file in public/img/slx/ is named in the PICTURE_SKINS
  // row's reviewed list (SERVER-DESIGN 15.5; today the list is empty, so the folder holds nothing)
  const row = require('../server/sl/slLaws.js').LAWS.PICTURE_SKINS.value;
  const dir = path.join(ROOT, 'public', 'img', 'slx');
  const present = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  for (const f of present) assert.ok(row.reviewed.includes(f), f + ' is in public/img/slx/ but not on the reviewed list');
  for (const f of row.reviewed) assert.ok(PICTURE_FILES.includes(f), f + ' is not one of the 12 picture files');
});

// --------------------------------------------------------------------------------------------- surfaces and rules

test('surfaces: the three files touch only DuelSlither.S, slx and slInput.setAcceleration; slx- classes; no Math.random', () => {
  for (const f of FILES) {
    const code = src(f).replace(/\/\/.*$/gm, '');
    assert.ok(!/Math\.random/.test(code), f + ': Math.random');
    const uses = new Set((code.match(/\bD\.(\w+)/g) || []));
    for (const u of uses) assert.ok(['D.slx', 'D.S', 'D.slInput'].includes(u), f + ' uses ' + u);
    for (const m of code.match(/\bD\.slInput\.(\w+)/g) || []) assert.strictEqual(m, 'D.slInput.setAcceleration', f);
    for (const m of code.match(/className = '([^']*)'/g) || []) assert.ok(/className = 'slx-/.test(m), f + ' ' + m);
    assert.ok(!/data-sl\b/.test(code), f + ': no data-sl attribute');
    assert.ok(/if \(!D \|\| !D\.slx \|\| !D\.slx\.active\) return;/.test(code), f + ': starts with the active check');
  }
});
