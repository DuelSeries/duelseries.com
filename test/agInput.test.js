'use strict';
// agInput (build brief 9.2 "agInput.js", client-camera-input spec section 8, Owen's Q7): keys, wheel,
// the > 25 ms mouse copy, the phone stick and the Split / Eject buttons. No DOM library: a small fake
// event target stands in for window, document, body, canvas and the buttons.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'public', 'js', 'ag', 'agInput.js');
const I = require(FILE);
const C = require(path.join(__dirname, '..', 'public', 'js', 'ag', 'agCamera.js'));

function target(extra) {
  const map = {};
  const t = Object.assign({
    addEventListener(type, fn) { (map[type] = map[type] || []).push(fn); },
    removeEventListener(type, fn) { map[type] = (map[type] || []).filter((f) => f !== fn); },
    fire(type, props) {
      const e = Object.assign({ type, defaultPrevented: false, cancelable: true,
        preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} }, props || {});
      (map[type] || []).slice().forEach((fn) => fn(e));
      return e;
    },
    count(type) { return (map[type] || []).length; }
  }, extra || {});
  return t;
}

function setup(opts) {
  opts = opts || {};
  const body = target({ onmousewheel: null });
  const doc = target({ body });
  const win = target({ document: doc, navigator: { userAgent: opts.ua || 'Chrome' }, matchMedia: () => ({ matches: !!opts.coarse }) });
  const canvas = target();
  const splitButton = target();
  const ejectButton = target();
  const log = [];
  let clock = opts.clock || 1000;
  const sink = {
    mouse: (x, y) => log.push(['mouse', x, y]),
    split: () => log.push(['split']),
    eject: () => log.push(['eject']),
    q: () => log.push(['q']),
    menu: () => log.push(['menu']),
    zoom: (n) => log.push(['zoom', n])
  };
  const ctl = I.attachInput(canvas, sink, Object.assign({
    win, doc, splitButton, ejectButton, engineNow: () => clock, canvasScale: () => opts.scale || 1
  }, opts.extra || {}));
  return { ctl, win, doc, body, canvas, splitButton, ejectButton, log, tick: (ms) => { clock += ms; } };
}

const key = (w, type, keyCode) => w.fire(type, { keyCode });

test('loads under node and registers on DuelAgarLib', () => {
  assert.strictEqual(globalThis.DuelAgarLib.agInput, I);
  assert.strictEqual(typeof I.attachInput, 'function');
  assert.strictEqual(I.STICK_DEADZONE_PX, 10);
  assert.strictEqual(I.STICK_FOLLOW_R, 60);
  assert.strictEqual(I.MOUSE_SYNC_GAP_MS, 25);
});

test('keys are installed only by enableKeys, once, and never removed by a second call', () => {
  const t = setup();
  key(t.win, 'keydown', 32);
  assert.deepStrictEqual(t.log, [], 'no key listeners before the first game');
  t.ctl.enableKeys();
  t.ctl.enableKeys();
  assert.strictEqual(t.win.count('keydown'), 1);
  key(t.win, 'keyup', 32);
  key(t.win, 'keydown', 32);
  assert.deepStrictEqual(t.log, [['split']]);
});

test('one action per physical press: Space split, W eject, Q sends Q-down only (card)', () => {
  const t = setup();
  t.ctl.enableKeys();
  key(t.win, 'keydown', 32);
  key(t.win, 'keydown', 32); // auto-repeat
  key(t.win, 'keydown', 32);
  key(t.win, 'keyup', 32);
  key(t.win, 'keydown', 32);
  key(t.win, 'keydown', 87);
  key(t.win, 'keydown', 87);
  key(t.win, 'keyup', 87);
  key(t.win, 'keydown', 87);
  key(t.win, 'keydown', 81);
  key(t.win, 'keyup', 81); // the release never sends anything
  key(t.win, 'keyup', 58);
  key(t.win, 'keydown', 81);
  assert.deepStrictEqual(t.log, [['split'], ['split'], ['eject'], ['eject'], ['q'], ['q']]);
});

test('Esc opens the menu (default prevented) without pausing; other keys do nothing', () => {
  const t = setup();
  t.ctl.enableKeys();
  t.ctl.setInGame(true);
  const e = key(t.win, 'keydown', 27);
  assert.strictEqual(e.defaultPrevented, true);
  assert.deepStrictEqual(t.log, [['menu']]);
  assert.strictEqual(key(t.win, 'keydown', 220).defaultPrevented, true, 'backslash eaten as theirs');
  key(t.win, 'keydown', 69);
  key(t.win, 'keydown', 13);
  assert.deepStrictEqual(t.log, [['menu']]);
  assert.strictEqual(t.ctl.state.inGame, true, 'Esc does not leave the game');
  assert.strictEqual(key(t.win, 'keydown', 32).defaultPrevented, false, 'Space is not prevented');
});

test('a key released while unfocused stays blocked until pressed and released again', () => {
  const t = setup();
  t.ctl.enableKeys();
  key(t.win, 'keydown', 87);
  // keyup lost
  key(t.win, 'keydown', 87);
  assert.deepStrictEqual(t.log, [['eject']]);
  key(t.win, 'keyup', 87);
  key(t.win, 'keydown', 87);
  assert.deepStrictEqual(t.log, [['eject'], ['eject']]);
});

test('mouse copy: only in game, only after more than 25 ms, in canvas px (card)', () => {
  const t = setup({ scale: 1.5 });
  t.canvas.fire('mousemove', { clientX: 100.4, clientY: 50 });
  assert.strictEqual(t.ctl.frame(), false, 'not in game: nothing copied');
  t.ctl.setInGame(true);
  assert.strictEqual(t.ctl.frame(), true, 'first copy: 1000 - 0 > 25');
  t.tick(25);
  assert.strictEqual(t.ctl.frame(), false, 'exactly 25 ms is not more than 25');
  t.tick(1);
  t.canvas.fire('mousemove', { clientX: 200, clientY: 10 });
  assert.strictEqual(t.ctl.frame(), true, '26 ms');
  t.tick(16);
  assert.strictEqual(t.ctl.frame(), false);
  t.tick(17);
  assert.strictEqual(t.ctl.frame(), true, 'every second 60 Hz frame');
  assert.deepStrictEqual(t.log, [['mouse', 100.4 * 1.5, 75], ['mouse', 300, 15], ['mouse', 300, 15]]);
  t.ctl.setInGame(false);
  t.tick(100);
  assert.strictEqual(t.ctl.frame(), false, 'dead: the copy stops (the game still sends its own target)');
});

test('a mouse that never moved over the canvas copies as 0, 0', () => {
  const t = setup();
  t.ctl.setInGame(true);
  t.ctl.frame();
  assert.deepStrictEqual(t.log, [['mouse', 0, 0]]);
});

test('the mouse copy reaches the camera as int32 and drives the target', () => {
  const t = setup({ scale: 2 });
  const cam = C.createCamera();
  cam.setCanvasSize(2560, 1260);
  cam.setBorder(-5000, -5000, 5000, 5000, 0);
  cam.stepZoom([]);
  const ctl2 = I.attachInput(t.canvas, { mouse: cam.setMouse }, { win: t.win, doc: t.doc, engineNow: () => 5000, canvasScale: () => 2 });
  ctl2.setInGame(true);
  t.canvas.fire('mousemove', { clientX: 700.7, clientY: 315 });
  ctl2.frame();
  assert.deepStrictEqual([cam.mouseX, cam.mouseY], [1401, 630]);
  const sent = [];
  cam.sendTarget((x, y) => sent.push([x, y]));
  assert.deepStrictEqual(sent, [[Math.trunc(121 / cam.scale), 0]]);
});

test('wheel: legacy rule wheelDelta / -120, else detail; body mousewheel or Firefox DOMMouseScroll', () => {
  assert.strictEqual(I.legacyWheelSteps({ wheelDelta: 120 }), -1);
  assert.strictEqual(I.legacyWheelSteps({ wheelDelta: -240 }), 2);
  assert.strictEqual(I.legacyWheelSteps({ detail: 3 }), 3);
  assert.strictEqual(I.legacyWheelSteps({ wheelDelta: 0, detail: 0 }), 0);
  const t = setup();
  assert.strictEqual(t.body.count('mousewheel'), 1);
  assert.strictEqual(t.body.count('wheel') + t.doc.count('wheel') + t.doc.count('DOMMouseScroll'), 0);
  t.body.fire('mousewheel', { wheelDelta: 120 });
  t.body.fire('mousewheel', { wheelDelta: -120 });
  assert.deepStrictEqual(t.log, [['zoom', -1], ['zoom', 1]], 'active before any game too');
  const ff = setup({ ua: 'Mozilla/5.0 Firefox/130.0' });
  assert.strictEqual(ff.doc.count('DOMMouseScroll'), 1);
  assert.strictEqual(ff.body.count('mousewheel'), 0);
  ff.doc.fire('DOMMouseScroll', { detail: -3 });
  assert.deepStrictEqual(ff.log, [['zoom', -3]]);
  const e = t.body.fire('mousewheel', { wheelDelta: 120 });
  assert.strictEqual(e.defaultPrevented, false, 'no preventDefault on the wheel');
});

test('wheel: standard event fallback (CHOSEN) only where no legacy event exists', () => {
  assert.strictEqual(I.standardWheelSteps({ deltaY: 100, deltaMode: 0 }), 1);
  assert.strictEqual(I.standardWheelSteps({ deltaY: -3, deltaMode: 1 }), -1);
  assert.strictEqual(I.standardWheelSteps({ deltaY: 1, deltaMode: 2 }), 1);
  assert.strictEqual(I.standardWheelSteps({ deltaY: 53, deltaMode: 0, wheelDelta: 120 }), -1, 'legacy value wins');
  const body = target(); // no onmousewheel property
  const doc = target({ body });
  const win = target({ document: doc, navigator: { userAgent: 'Safari' } });
  const log = [];
  I.attachInput(target(), { zoom: (n) => log.push(n) }, { win, doc });
  assert.strictEqual(body.count('wheel'), 1);
  body.fire('wheel', { deltaY: -200, deltaMode: 0 });
  assert.deepStrictEqual(log, [-2]);
});

test('camera wheel from input: up zooms in, down never below the automatic zoom', () => {
  const cam = C.createCamera();
  cam.setCanvasSize(1920, 1080);
  cam.stepZoom([]);
  const t = setup({ extra: {} });
  const ctl = I.attachInput(t.canvas, { zoom: cam.wheel }, { win: t.win, doc: t.doc });
  assert.ok(ctl);
  t.body.fire('mousewheel', { wheelDelta: 120 });
  assert.ok(Math.abs(cam.wheelFactor - 1 / 0.9) < 1e-15);
  t.body.fire('mousewheel', { wheelDelta: -120 });
  t.body.fire('mousewheel', { wheelDelta: -120 });
  cam.clampWheel();
  assert.strictEqual(cam.wheelFactor, 1);
});

test('phone stick: dead zone 10 px, anchor follows at 60 px, direction kept after lift (card)', () => {
  const st = I.createStick();
  st.down(100, 100);
  st.move(108, 100);
  assert.strictEqual(st.dir, null, '8 px: inside the dead zone');
  st.move(110, 100);
  assert.strictEqual(st.dir, null, 'exactly 10 px is not past it');
  st.move(111, 100);
  assert.deepStrictEqual(st.dir, { x: 1, y: 0 });
  st.move(200, 100); // 100 px: anchor dragged to 60 px behind
  assert.deepStrictEqual([st.ax, st.ay], [140, 100]);
  st.move(140, 60); // straight up from the anchor
  assert.deepStrictEqual(st.dir, { x: 0, y: -1 });
  st.down(10, 10); // a fresh stick asks for nothing new
  assert.deepStrictEqual(st.dir, { x: 0, y: -1 });
});

test('phone: the stick puts the target at full deflection on the visible edge (card)', () => {
  const cam = C.createCamera();
  cam.setCanvasSize(800, 400);
  cam.setBorder(-1e5, -1e5, 1e5, 1e5, 1);
  cam.stepZoom([]);
  const own = [{ x: 0, y: 0, size: 40 }];
  cam.stepCamera(own);
  const t = setup({ coarse: true });
  const sent = [];
  let now = 9000;
  const ctl = I.attachInput(t.canvas, { mouse: cam.setMouse }, { win: t.win, doc: t.doc, engineNow: () => (now += 40) });
  assert.strictEqual(ctl.touchMode(), true, 'coarse pointer: touch first');
  ctl.setInGame(true);
  const edge = (ux, uy) => cam.stickPoint(own, ux, uy);
  // No direction yet: the target is the cells themselves (they stand still), not the 0,0 corner.
  ctl.frame(edge);
  cam.sendTarget((x, y) => sent.push([x, y]));
  assert.deepStrictEqual(sent, [], 'cells at 0,0 = last sent 0,0');
  const touch = (type, x, y, id) => {
    const pt = { identifier: id || 0, clientX: x, clientY: y };
    return t.canvas.fire(type, { touches: type === 'touchend' ? [] : [pt], changedTouches: [pt] });
  };
  assert.strictEqual(touch('touchstart', 600, 300).defaultPrevented, true);
  touch('touchmove', 600, 250); // up
  ctl.frame(edge);
  cam.sendTarget((x, y) => sent.push([x, y]));
  assert.deepStrictEqual(sent, [[0, Math.trunc(-200 / cam.scale)]], 'top edge straight up');
  touch('touchend', 600, 250);
  touch('touchstart', 300, 300, 1);
  touch('touchmove', 380, 300, 1); // right
  ctl.frame(edge);
  cam.sendTarget((x, y) => sent.push([x, y]));
  assert.deepStrictEqual(sent[1], [Math.trunc(400 / cam.scale), 0], 'right edge');
  touch('touchend', 380, 300, 1);
  assert.deepStrictEqual(ctl.stickDir(), { x: 1, y: 0 }, 'kept after the thumb lifts');
  // A second finger is not a second stick.
  touch('touchstart', 100, 100, 5);
  const pt2 = { identifier: 6, clientX: 0, clientY: 300 };
  t.canvas.fire('touchstart', { touches: [{ identifier: 5, clientX: 100, clientY: 100 }, pt2], changedTouches: [pt2] });
  t.canvas.fire('touchmove', { touches: [pt2], changedTouches: [{ identifier: 6, clientX: 0, clientY: 0 }] });
  assert.deepStrictEqual(ctl.stickDir(), { x: 1, y: 0 });
});

test('a real mouse takes steering back from the stick', () => {
  const t = setup();
  assert.strictEqual(t.ctl.touchMode(), false, 'fine pointer: mouse first');
  t.ctl.setInGame(true);
  const pt = { identifier: 0, clientX: 50, clientY: 50 };
  t.canvas.fire('touchstart', { touches: [pt], changedTouches: [pt] });
  assert.strictEqual(t.ctl.touchMode(), true);
  t.canvas.fire('touchend', { touches: [], changedTouches: [pt] });
  t.canvas.fire('mousemove', { clientX: 10, clientY: 20 });
  assert.strictEqual(t.ctl.touchMode(), false);
  assert.strictEqual(t.ctl.stickDir(), null);
  t.ctl.frame(() => ({ x: 999, y: 999 }));
  assert.deepStrictEqual(t.log, [['mouse', 10, 20]]);
});

test('Split and Eject buttons send the same actions as Space and W, one per press (card)', () => {
  const t = setup();
  const e = t.splitButton.fire('pointerdown');
  assert.strictEqual(e.defaultPrevented, true);
  t.ejectButton.fire('pointerdown');
  t.ejectButton.fire('pointerdown');
  assert.strictEqual(t.splitButton.fire('touchstart').defaultPrevented, true, 'no emulated mouse or zoom');
  assert.deepStrictEqual(t.log, [['split'], ['eject'], ['eject']]);
});

test('sound cue gates: split needs 1 to 15 cells and a size above 60; eject needs size^2 above 3612.5', () => {
  const sz = (arr) => arr.map((s) => ({ size: s }));
  assert.strictEqual(I.splitSoundDue(sz([60])), false);
  assert.strictEqual(I.splitSoundDue(sz([60.01])), true);
  assert.strictEqual(I.splitSoundDue(sz([])), false);
  assert.strictEqual(I.splitSoundDue(sz(new Array(15).fill(10).concat([]).map((s, i) => (i === 3 ? 61 : s)))), true);
  assert.strictEqual(I.splitSoundDue(sz(new Array(16).fill(100))), false, '16 cells: no sound');
  assert.strictEqual(I.ejectSoundDue(sz([60.10407])), false);
  assert.strictEqual(I.ejectSoundDue(sz([10, 60.105])), true);
  assert.strictEqual(I.ejectSoundDue(sz([60.104])), false);
});

test('dispose removes every listener', () => {
  const t = setup();
  t.ctl.enableKeys();
  t.ctl.dispose();
  assert.strictEqual(t.win.count('keydown') + t.canvas.count('mousemove') + t.body.count('mousewheel') +
    t.splitButton.count('pointerdown'), 0);
});

test('clean room: no randomness and no D/W line citations in the shipped file', () => {
  const src = fs.readFileSync(FILE, 'utf8');
  assert.ok(!/Math\.random/.test(src));
  assert.ok(!/\b[DW]\s+\d{3,}/.test(src) && !/dcmp|\.wat\b|f_[a-z]{2}\b|mc\.js|start\.js/.test(src));
});
