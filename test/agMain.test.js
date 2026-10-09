'use strict';
// agMain (build brief 9.1 "agMain.js": integration) booted under node in a small fake page: a fake DOM, a canvas
// whose 2D context records calls, a virtual clock, manual animation frames, virtual timers and a fake socket.io.
// Regression tests for the 2026-10-01 review of the page loop: the whole-client reset on reconnect, a death while
// the Esc menu is open, the quality setting (canvas scale and size together), resize keeping the stored scale, the
// settings block on the menu card, a collapsed 0x0 canvas, and the name cache on reconnect.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const AG = path.join(__dirname, '..', 'public', 'js', 'ag');
require('../shared/agWire.js');
// agPortrait is loaded as the shipped page loads it; it does nothing unless a boot config sets portrait (the P4 tests).
for (const f of ['agMath', 'agWorld', 'agCamera', 'agInput', 'agRender', 'agHud', 'agScreens', 'agSound', 'agNet', 'agPortrait', 'agMain']) {
  require(path.join(AG, f + '.js'));
}
const LIB = globalThis.DuelAgarLib;
const W = require('../shared/agWire.js');

// ---- fake page ------------------------------------------------------------------------------------------------
function makeCtx(canvas, log) {
  const props = {};
  return new Proxy({}, {
    get(t, k) {
      if (k === 'canvas') return canvas;
      if (k in props) return props[k];
      if (k === 'measureText') return (s) => ({ width: 10 * String(s).length });
      if (k === 'createPattern') return () => ({});
      if (k === 'then') return undefined;
      return (...a) => { log.push([canvas.cid, k, a]); };
    },
    set(t, k, v) { props[k] = v; return true; }
  });
}

function idlDim(v, dflt) {
  let n = Number(v);
  if (!Number.isFinite(n)) n = 0;
  n = ((Math.trunc(n) % 4294967296) + 4294967296) % 4294967296;
  return n <= 2147483647 ? n : dflt;
}

function makeElement(doc, tag) {
  const listeners = {};
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentNode: null,
    attributes: {},
    style: { setProperty() {} },
    hidden: false,
    textContent: '',
    value: '',
    checked: false,
    id: '',
    className: '',
    setAttribute(k, v) {
      this.attributes[k] = String(v);
      if (k === 'id') this.id = String(v);
      if (k === 'class') this.className = String(v);
      if (k === 'hidden') this.hidden = true;
      if (tag === 'canvas' && (k === 'width' || k === 'height')) this[k] = Number(v);
    },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); },
    dispatch(type, ev) { (listeners[type] || []).slice().forEach((fn) => fn(Object.assign({ type, preventDefault() {} }, ev))); },
    focus() {}
  };
  if (tag === 'canvas') {
    let w = 300, h = 150;
    el.cid = 'cv' + (doc._n++);
    // A written size is kept as the browser keeps it: WebIDL unsigned long (truncated toward zero, modulo 2^32), and
    // the canvas falls back to its default for a value past 2^31 - 1. The raw written value is logged.
    Object.defineProperty(el, 'width', { get() { return w; }, set(v) { doc.sizeWrites.push([el.cid, 'width', v]); w = idlDim(v, 300); } });
    Object.defineProperty(el, 'height', { get() { return h; }, set(v) { doc.sizeWrites.push([el.cid, 'height', v]); h = idlDim(v, 150); } });
    let ctx = null;
    el.getContext = () => (ctx = ctx || makeCtx(el, doc.calls));
  }
  return el;
}

// classList on the root element (the phone pad class); toggle writes are counted.
function fakeClassList() {
  const set = new Set();
  return {
    writes: 0,
    toggle(k, on) { this.writes++; const v = on === undefined ? !set.has(k) : !!on; if (v) set.add(k); else set.delete(k); return v; },
    contains: (k) => set.has(k)
  };
}

function makeDoc() {
  const doc = { _n: 0, calls: [], sizeWrites: [] };
  doc.createElement = (tag) => makeElement(doc, tag);
  doc.documentElement = { style: { setProperty() {} }, classList: fakeClassList() };
  doc.head = makeElement(doc, 'head');
  doc.body = makeElement(doc, 'body');
  doc.addEventListener = () => {};
  doc.removeEventListener = () => {};
  doc.getElementById = (id) => {
    const walk = (e) => {
      if (e.id === id) return e;
      for (const c of e.children) { const r = walk(c); if (r) return r; }
      return null;
    };
    return walk(doc.head) || walk(doc.body);
  };
  return doc;
}

function fakeSocket() {
  const handlers = {};
  return {
    connected: false,
    emitted: [],
    on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); },
    emit(ev, payload) { this.emitted.push([ev, payload]); },
    close() { this.connected = false; },
    fire(ev, arg) { (handlers[ev] || []).forEach((fn) => fn(arg)); }
  };
}

function makeStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m };
}

// boot options: w, h, dpr, net (true = fake socket.io), fonts (a fake document.fonts), cfg (extra boot config),
// pad (the page's Split / Eject buttons)
function bootPage(o) {
  o = o || {};
  const doc = makeDoc();
  const canvas = doc.body.appendChild(makeElement(doc, 'canvas'));
  canvas.setAttribute('id', 'canvas');
  if (o.pad) {
    for (const id of ['ag-split', 'ag-eject']) doc.body.appendChild(makeElement(doc, 'button')).setAttribute('id', id);
  }
  let clock = 1000;
  let timers = [];
  let raf = null;
  const sock = fakeSocket();
  const winListeners = {};
  const win = {
    document: doc,
    innerWidth: o.w || 1280,
    innerHeight: o.h || 720,
    devicePixelRatio: o.dpr || 1,
    performance: { now: () => clock },
    setTimeout(fn, ms) { timers.push({ at: clock + (ms || 0), fn }); return timers.length; },
    requestAnimationFrame(fn) { raf = fn; return 1; },
    addEventListener(type, fn) { (winListeners[type] = winListeners[type] || []).push(fn); },
    removeEventListener(type, fn) { winListeners[type] = (winListeners[type] || []).filter((f) => f !== fn); },
    fire(type) { (winListeners[type] || []).slice().forEach((fn) => fn({ type })); }
  };
  let ioCalls = 0;
  if (o.net) win.io = () => { ioCalls++; return sock; };
  if (o.fonts) doc.fonts = o.fonts;
  if (o.matchMedia) win.matchMedia = o.matchMedia;
  if (o.top) win.top = o.top;
  globalThis.document = doc;   // the renderer's scratch canvases come from the page's document
  const sound = LIB.agSound.createSound({ storage: null, createAudioContext: () => null });
  const cfg = Object.assign({ win, doc, canvas, sound, idlePass: false, net: !!o.net, engineNow: () => clock }, o.cfg || {});
  const session = LIB.agMain.boot(cfg);
  const sent = [];
  session.onSend = (kind, payload) => sent.push([kind, payload]);

  function runTimers() {
    for (let guard = 0; guard < 100; guard++) {
      const due = timers.filter((t) => t.at <= clock);
      if (!due.length) return;
      timers = timers.filter((t) => t.at > clock);
      due.forEach((t) => t.fn());
    }
  }
  // Advance the clock by ms, run due timers, flush microtasks, then one animation frame.
  async function frame(ms) {
    clock += ms === undefined ? 1000 / 60 : ms;
    runTimers();
    await Promise.resolve();
    await Promise.resolve();
    if (raf) raf(clock);
  }
  async function frames(n, ms) { for (let i = 0; i < n; i++) await frame(ms); }
  return { doc, canvas, win, sock, session, sent, frame, frames, now: () => clock, mod: session.modules, ioCalls: () => ioCalls };
}

const BORDER = { t: 'border', minX: -7071, minY: -7071, maxX: 7071, maxY: 7071, mode: 0 };
const cell = (o) => Object.assign({ x: 0, y: 0, size: 200, virus: false, food: false, ejected: false, agitated: false,
  flag40: false, party: false, rgb: [255, 7, 100] }, o);

// Hello, border, play, ready, own cell 9 at size 200 plus a named stranger 10, then frames alive.
async function spawn(p, feed) {
  feed({ t: 'hello' });
  feed(BORDER);
  p.session.play('me');
  feed({ t: 'world', eats: [], cells: [], removed: [] });
  feed({ t: 'own', id: 9 });
  feed({ t: 'world', eats: [], cells: [cell({ id: 9 }), cell({ id: 10, x: 400, size: 50, name: 'bob' })], removed: [] });
  feed({ t: 'board', rows: [{ name: 'bob' }, { me: true }] });
  await p.frames(10);
}

test('reconnect resets this life, the HUD, the board and the name cache; the last sent target stays', async () => {
  const p = bootPage({ net: true });
  p.sock.connected = true;
  p.sock.fire('connect');
  const feed = (rec) => p.sock.fire('ag:f', W.encodeBundle([rec]));
  await spawn(p, feed);
  const { hud, stats, renderer, camera } = p.mod;
  assert.strictEqual(p.session.state().highestMass, 400);
  assert.ok(stats.history.length >= 9);
  assert.strictEqual(hud.alive, true);
  assert.strictEqual(hud.lbHasContent, true);
  assert.ok(hud.scorePanel);
  assert.strictEqual(renderer.nameCount(), 2, 'own nick and bob');
  const lastSent = [camera.lastSentX, camera.lastSentY];

  p.sock.connected = false;
  p.sock.fire('disconnect', 'transport close');
  p.sock.connected = true;
  p.sock.fire('connect');

  assert.strictEqual(p.session.state().highestMass, 0);
  assert.deepStrictEqual([stats.history.length, stats.leaderTime, stats.topPosition, stats.onBoard, stats.alive],
    [0, 0, 0, false, false]);
  assert.deepStrictEqual([hud.alive, hud.slowCount, hud.slowShown, hud.slowVisible], [false, 0, 0, false]);
  assert.deepStrictEqual([hud.lbEntries, hud.lbHasContent], [[], false]);
  assert.deepStrictEqual([hud.scorePanel, hud.hintPanel, hud.slowPanel, hud.rebootPanel], [null, null, null, null]);
  assert.strictEqual(renderer.nameCount(), 0, 'no cached name outlives the reconnect');
  assert.deepStrictEqual([camera.lastSentX, camera.lastSentY], lastSent);

  // The menu frames after the reconnect draw no score box (the old life's panel) over the menu.
  feed({ t: 'hello' });
  feed(BORDER);
  feed({ t: 'world', eats: [], cells: [], removed: [] });
  p.doc.calls.length = 0;
  await p.frames(6, 50);
  const main = p.doc.calls.filter((c) => c[0] === p.canvas.cid).map((c) => c[1]);
  assert.ok(main.length > 0, 'menu frames are drawn');
  assert.ok(!main.includes('arcTo'), 'no Score panel');

  // 50 reconnects with a new name each leave nothing behind in the name cache.
  for (let i = 0; i < 50; i++) {
    feed({ t: 'world', eats: [], cells: [cell({ id: 100 + i, name: 'n' + i })], removed: [] });
    p.sock.fire('disconnect', 'x');
    p.sock.fire('connect');
  }
  assert.strictEqual(renderer.nameCount(), 0);
});

test('a death while the Esc menu is open keeps HOME (no Match Results); a death in play shows it', async () => {
  for (const escFirst of [true, false]) {
    const p = bootPage();
    const feed = p.session.feed;
    await spawn(p, feed);
    assert.strictEqual(p.session.state().menuState, 'PLAY');
    if (escFirst) p.session.menu();
    feed({ t: 'world', eats: [], cells: [], removed: [9] });
    await p.frames(3);
    const st = p.session.state();
    const screens = p.mod.screens;
    if (escFirst) {
      assert.strictEqual(st.menuState, 'HOME');
      assert.strictEqual(screens.state, 'HOME');
      assert.strictEqual(p.doc.getElementById('ag-stats').hidden, true, 'the stats panel stays hidden');
      assert.strictEqual(p.doc.getElementById('ag-name').hidden, false, 'the name entry stays');
    } else {
      assert.strictEqual(st.menuState, 'GAMEOVER');
      assert.strictEqual(screens.state, 'GAMEOVER');
      assert.strictEqual(p.doc.getElementById('ag-stats').hidden, false);
    }
    assert.strictEqual(st.capMs, Math.fround(1000 / 25), 'the menu cap either way');
    assert.strictEqual(st.highestMass, 0, 'the life was still counted and reset');
  }
});

test('P1: the phone pad shows and acts only while playing with own cells (not HOME, SPECTATE, Esc menu, GAMEOVER)', async () => {
  const p = bootPage({ pad: true });
  const feed = p.session.feed;
  const cls = p.doc.documentElement.classList;
  const split = p.doc.getElementById('ag-split'), eject = p.doc.getElementById('ag-eject');
  const acts = () => p.sent.filter((s) => s[0] === 'split' || s[0] === 'eject').length;
  async function check(label, shown) {
    await p.frames(2);
    assert.strictEqual(cls.contains('ag-alive'), shown, label + ': root class');
    const before = acts();
    split.dispatch('pointerdown', {});
    eject.dispatch('pointerdown', {});
    assert.strictEqual(acts() - before, shown ? 2 : 0, label + ': Split + Eject presses acted');
  }
  feed({ t: 'hello' });
  feed(BORDER);
  feed({ t: 'world', eats: [], cells: [], removed: [] });
  await check('HOME', false);
  p.session.spectate();
  assert.strictEqual(p.session.state().menuState, 'SPECTATE');
  await check('SPECTATE', false);
  p.session.menu();
  await check('Esc menu from spectate', false);
  p.session.play('me');
  await check('PLAY before the spawn', false);
  feed({ t: 'own', id: 9 });
  feed({ t: 'world', eats: [], cells: [cell({ id: 9 })], removed: [] });
  assert.strictEqual(cls.contains('ag-alive'), true, 'the spawn writes the class at once');
  await check('alive', true);
  p.session.menu();
  assert.strictEqual(cls.contains('ag-alive'), false, 'Esc writes it at once');
  await check('Esc menu while alive', false);
  p.session.play('me');
  await check('back in play', true);
  feed({ t: 'world', eats: [], cells: [], removed: [9] });
  assert.strictEqual(cls.contains('ag-alive'), false, 'the death writes it at once');
  await check('GAMEOVER', false);
  assert.strictEqual(p.session.state().menuState, 'GAMEOVER');
  assert.strictEqual(cls.writes, 4, 'written only on a change: spawn, Esc, Play, death');
  p.session.destroy();
  assert.strictEqual(cls.contains('ag-alive'), false);
});

test('P1: ag.css shows the phone pad only under .ag-alive, on touch screens', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'ag.css'), 'utf8');
  assert.match(css, /\.ag-pad \{[^}]*display: none;/);
  assert.match(css, /@media \(pointer: coarse\) \{\s*\.ag-alive \.ag-pad \{ display: grid; \}\s*\}/);
  const shows = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => m[1].includes('.ag-pad') && /display:/.test(m[2])).map((m) => m[2].match(/display: ([a-z]+)/)[1]);
  assert.deepStrictEqual(shows, ['none', 'grid'], 'no other rule shows the pad');
});

test('quality goes through one path: level, canvas scale and size together', async () => {
  const p = bootPage({ w: 1280, h: 720, dpr: 1 });
  assert.deepStrictEqual([p.canvas.width, p.canvas.height], [1280, 720]);
  p.session.setSettings({ quality: 4 });
  assert.deepStrictEqual([p.canvas.width, p.canvas.height], [640, 360], 'VeryLow is half size');
  assert.strictEqual(p.session.settings().quality, 'VeryLow');
  p.session.setSettings({ quality: 'Low' });
  assert.deepStrictEqual([p.canvas.width, p.canvas.height], [960, 540]);
  p.session.setSettings({ quality: 'Medium' });
  assert.deepStrictEqual([p.canvas.width, p.canvas.height], [1152, 648]);
  p.win.devicePixelRatio = 2;
  p.session.setSettings({ quality: 'Retina' });
  assert.deepStrictEqual([p.canvas.width, p.canvas.height], [2560, 1440], 'Retina reads the pixel ratio');
  p.session.setSettings({ quality: 'High' });
  assert.deepStrictEqual([p.canvas.width, p.canvas.height], [1280, 720]);
  // The mouse (copied while in a game) is scaled by the same stored value.
  p.session.setSettings({ quality: 'VeryLow' });
  p.session.play('me');
  p.canvas.dispatch('mousemove', { clientX: 600, clientY: 300 });
  await p.frames(3);
  assert.deepStrictEqual([p.mod.camera.mouseX, p.mod.camera.mouseY], [300, 150]);
});

test('a resize reuses the stored scale; the pixel ratio is read again only when quality is applied', async () => {
  const p = bootPage({ w: 1280, h: 720, dpr: 1 });
  p.win.devicePixelRatio = 2;
  p.win.fire('resize');
  assert.deepStrictEqual([p.canvas.width, p.canvas.height], [1280, 720], 'zoom or monitor change alone keeps scale 1');
  p.win.innerWidth = 1000;
  p.win.fire('resize');
  assert.deepStrictEqual([p.canvas.width, p.canvas.height], [1000, 720]);
  p.session.feed({ t: 'hello' });          // connect applies the settings again (two size writes)
  assert.deepStrictEqual([p.canvas.width, p.canvas.height], [2000, 1440]);
});

test('the settings block on the menu card shows the defaults and changes the drawing settings', () => {
  const p = bootPage({ w: 1280, h: 720 });
  const c = p.mod.screens.settingsControls;
  assert.deepStrictEqual(
    [c.boxes.names.checked, c.boxes.colors.checked, c.boxes.showMass.checked, c.boxes.dark.checked, c.quality.value],
    [true, true, false, false, 'Retina']);
  c.boxes.showMass.checked = true;
  c.boxes.showMass.dispatch('change');
  c.boxes.names.checked = false;
  c.boxes.names.dispatch('change');
  assert.deepStrictEqual(p.session.settings(), { quality: 'Retina', names: false, colors: true, showMass: true, dark: false });
  assert.strictEqual(p.mod.hud.namesEnabled, false, 'names off reaches the HUD (the board hides)');
  c.quality.value = 'Low';
  c.quality.dispatch('change');
  assert.deepStrictEqual([p.canvas.width, p.canvas.height], [960, 540]);
  p.session.setSettings({ dark: true });
  assert.strictEqual(c.boxes.dark.checked, true, 'the block follows changes made elsewhere');
});

test('settings are kept between visits only on our page (persistSettings), never on a page that boots itself', () => {
  const storage = makeStorage();
  const a = bootPage({ cfg: { persistSettings: true, storage } });
  a.session.setSettings({ dark: true, quality: 'Low' });
  assert.deepStrictEqual(JSON.parse(storage.getItem('agSettings')),
    { quality: 'Low', names: true, colors: true, showMass: false, dark: true });
  const b = bootPage({ cfg: { persistSettings: true, storage } });
  assert.deepStrictEqual(b.session.settings(), { quality: 'Low', names: true, colors: true, showMass: false, dark: true });
  assert.deepStrictEqual([b.canvas.width, b.canvas.height], [960, 540]);
  const c = bootPage({ cfg: { storage } });   // the parity harness boots like this: defaults, storage untouched
  assert.deepStrictEqual(c.session.settings(), { quality: 'Retina', names: true, colors: true, showMass: false, dark: false });
  storage.setItem('agSettings', '{not json');
  const d = bootPage({ cfg: { persistSettings: true, storage } });
  assert.strictEqual(d.session.settings().quality, 'Retina', 'a broken stored value falls back to the defaults');
});

test('a collapsed 0x0 canvas draws and sends nothing, and the game resumes when it has a size again', async () => {
  const p = bootPage({ w: 1280, h: 720 });
  await spawn(p, p.session.feed);
  p.canvas.dispatch('mousemove', { clientX: 900, clientY: 100 });
  await p.frames(5);
  p.win.innerWidth = 0;
  p.win.innerHeight = 0;
  p.win.fire('resize');
  assert.deepStrictEqual([p.canvas.width, p.canvas.height], [0, 0]);
  p.sent.length = 0;
  p.doc.calls.length = 0;
  p.canvas.dispatch('mousemove', { clientX: 10, clientY: 10 });
  await p.frames(10);
  assert.deepStrictEqual(p.sent, [], 'no target goes to the border corner');
  assert.strictEqual(p.doc.calls.filter((c) => c[0] === p.canvas.cid).length, 0, 'nothing drawn');
  assert.ok(p.mod.camera.scale > 0, 'the draw scale is kept');
  p.win.innerWidth = 1280;
  p.win.innerHeight = 720;
  p.win.fire('resize');
  await p.frames(3);
  assert.ok(p.doc.calls.some((c) => c[0] === p.canvas.cid), 'drawing resumes');
  assert.ok(p.sent.some((s) => s[0] === 'target'), 'steering resumes');
  for (const s of p.sent) {
    if (s[0] === 'target') assert.ok(s[1].x > -7071 && s[1].y > -7071, 'not the corner: ' + JSON.stringify(s[1]));
  }
});

// ---- the Ubuntu face: connect wait and the self-hosted files ---------------------------------------------------
// A fake document.fonts whose load() promise the test settles by hand.
function fakeFonts() {
  const f = { loaded: false, requests: [] };
  f.check = () => f.loaded;
  f.load = (spec) => {
    f.requests.push(spec);
    return new Promise((resolve, reject) => { f.resolve = () => { f.loaded = true; resolve([]); }; f.reject = reject; });
  };
  return f;
}

test('the socket opens when the Ubuntu face loads, once, and a Play pressed before then is sent after the hello', async () => {
  const fonts = fakeFonts();
  const p = bootPage({ net: true, fonts });
  assert.deepStrictEqual(fonts.requests, ['700 100px Ubuntu']);
  assert.strictEqual(p.ioCalls(), 0, 'no socket before the face');
  p.session.play('me');
  await p.frames(5);
  assert.strictEqual(p.ioCalls(), 0);
  fonts.resolve();
  await p.frame();
  assert.strictEqual(p.ioCalls(), 1, 'connects on the load');
  await p.frame(3000);
  assert.strictEqual(p.ioCalls(), 1, 'the wait timer does not connect again');
  p.sock.connected = true;
  p.sock.fire('connect');
  assert.ok(!p.sent.some((s) => s[0] === 'play'), 'nothing sent before the world is ready');
  p.sock.fire('ag:f', W.encodeBundle([{ t: 'hello' }, BORDER, { t: 'world', eats: [], cells: [], removed: [] }]));
  assert.deepStrictEqual(p.sent.filter((s) => s[0] === 'play'), [['play', { name: 'me' }]], 'the queued Play goes out once the world is ready');
  assert.strictEqual(p.session.state().menuState, 'PLAY');
});

test('the socket opens after 3000 ms when the face never loads; a failed load connects at once', async () => {
  const slow = fakeFonts();
  const p = bootPage({ net: true, fonts: slow });
  await p.frame(2999);
  assert.strictEqual(p.ioCalls(), 0, 'still waiting at 2999 ms');
  await p.frame(1);
  assert.strictEqual(p.ioCalls(), 1, 'connects at 3000 ms');
  slow.resolve();
  await p.frame();
  assert.strictEqual(p.ioCalls(), 1, 'a late load does not connect again');

  const bad = fakeFonts();
  const q = bootPage({ net: true, fonts: bad });
  bad.reject(new Error('blocked'));
  await q.frame();
  assert.strictEqual(q.ioCalls(), 1, 'an errored face connects right away');
});

test('no font API connects at boot; destroy before the face loads never connects', async () => {
  const p = bootPage({ net: true });
  assert.strictEqual(p.ioCalls(), 1);
  const fonts = fakeFonts();
  const q = bootPage({ net: true, fonts });
  q.session.destroy();
  fonts.resolve();
  await q.frame(3000);
  assert.strictEqual(q.ioCalls(), 0);
});

test('Ubuntu 700 is self-hosted: six subsets with relative urls, linked from ag.html only, before ag.css', () => {
  const fs = require('fs');
  const PUB = path.join(__dirname, '..', 'public');
  const css = fs.readFileSync(path.join(PUB, 'fonts', 'ubuntu.css'), 'utf8');
  const faces = css.split('@font-face').slice(1);
  assert.strictEqual(faces.length, 6);
  const subsets = ['cyrillic-ext', 'cyrillic', 'greek-ext', 'greek', 'latin-ext', 'latin'];
  faces.forEach((face, i) => {
    assert.match(face, /font-family: 'Ubuntu';/);
    assert.match(face, /font-weight: 700;/);
    assert.match(face, /unicode-range: U\+/);
    assert.ok(face.includes('src: url(ubuntu-700-' + subsets[i] + '.woff2) format(\'woff2\');'), subsets[i]);
    const file = fs.readFileSync(path.join(PUB, 'fonts', 'ubuntu-700-' + subsets[i] + '.woff2'));
    assert.strictEqual(file.subarray(0, 4).toString('latin1'), 'wOF2', subsets[i] + ' is a woff2 file');
    assert.strictEqual(file.readUInt32BE(8), file.length, subsets[i] + ' is complete');
  });
  assert.doesNotMatch(css, /https?:|font-display/);
  assert.ok(fs.existsSync(path.join(PUB, 'fonts', 'UBUNTU-FONT-LICENCE.txt')));
  const html = fs.readFileSync(path.join(PUB, 'ag.html'), 'utf8');
  const link = html.indexOf('<link rel="stylesheet" href="/fonts/ubuntu.css">');
  assert.ok(link > 0 && link < html.indexOf('<link rel="stylesheet" href="/css/ag.css">'));
  assert.match(html, /<canvas id="canvas"><\/canvas>\s*(<!--[\s\S]*?-->\s*)?<div class="font-family">&nbsp;<\/div>/);
  // The harness page declares its own Ubuntu face and then loads ag.css: a face or an import here would shadow it.
  const agCss = fs.readFileSync(path.join(PUB, 'css', 'ag.css'), 'utf8');
  assert.doesNotMatch(agCss, /@font-face|@import/);
  assert.match(agCss, /\.font-family \{ font-family: 'Ubuntu'; \}/);
});

// ---- canvas size, menu box scale and the ghost strip (FIX-PLAN V1, V2 with Owen's 2026-10-08 choice) ------------
const mainWrites = (p) => p.doc.sizeWrites.filter((w) => w[0] === p.canvas.cid).map((w) => [w[1], w[2]]);
const menuTransform = (p) => p.mod.screens.menu.style.transform;
function resize(p, w, h) { p.win.innerWidth = w; p.win.innerHeight = h; p.win.fire('resize'); }
// A matchMedia whose pointer kind the test switches; 'change' listeners run on a switch.
function fakePointer(coarse) {
  const listeners = [];
  const mq = {
    get matches() { return coarse; },
    addEventListener(t, fn) { if (t === 'change') listeners.push(fn); },
    removeEventListener(t, fn) { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }
  };
  return {
    matchMedia: (q) => (q === '(pointer: coarse)' ? mq : { matches: false }),
    set(c) { coarse = c; listeners.slice().forEach((fn) => fn({ matches: c })); },
    listeners
  };
}

test('the canvas size is written untruncated (the canvas truncates it, as the reference does)', () => {
  const p = bootPage({ w: 1707, h: 932, dpr: 1.5, cfg: { bannerPx: 90 } });
  assert.deepStrictEqual(mainWrites(p).slice(-2), [['width', 2560.5], ['height', 1263]]);
  assert.deepStrictEqual([p.canvas.width, p.canvas.height], [2560, 1263]);
  resize(p, 1266, 626);
  assert.deepStrictEqual(mainWrites(p).slice(-2), [['width', 1899], ['height', 804]]);
});

test('menu box scale: min(1, w / 1600, (h - strip) / 800) on mouse screens, at start-up, on resize and on quality', () => {
  const pt = fakePointer(false);
  const p = bootPage({ w: 1707, h: 932, dpr: 1.5, cfg: { bannerPx: 90 }, matchMedia: pt.matchMedia });
  assert.strictEqual(menuTransform(p), 'translate(-50%, -50%)', '1707 x 932: scale 1, no scale() part');
  resize(p, 1266, 626);
  assert.strictEqual(menuTransform(p), 'translate(-50%, -50%) scale(0.67)');
  resize(p, 801, 601);
  assert.strictEqual(menuTransform(p), 'translate(-50%, -50%) scale(0.500625)');
  resize(p, 1920, 1080);
  assert.strictEqual(menuTransform(p), 'translate(-50%, -50%)');
  resize(p, 1280, 720);
  p.mod.screens.menu.style.transform = '';
  p.session.setSettings({ quality: 'Low' });
  assert.strictEqual(menuTransform(p), 'translate(-50%, -50%) scale(0.7875)', 'a quality apply sets it again');
});

test('menu box scale: phones keep scale 1, and a pointer switch without a resize applies the right scale', () => {
  const pt = fakePointer(true);
  const p = bootPage({ w: 390, h: 844, dpr: 3, cfg: { ghostBannerPx: 90 }, matchMedia: pt.matchMedia });
  assert.strictEqual(menuTransform(p), 'translate(-50%, -50%)', 'their formula would give about 0.24 here');
  resize(p, 801, 601);
  assert.strictEqual(menuTransform(p), 'translate(-50%, -50%)');
  pt.set(false);
  assert.strictEqual(menuTransform(p), 'translate(-50%, -50%) scale(0.500625)', 'mouse now: the ghost strip counts as theirs does');
  pt.set(true);
  assert.strictEqual(menuTransform(p), 'translate(-50%, -50%)');
  p.session.destroy();
  assert.strictEqual(pt.listeners.length, 0, 'destroy stops watching the pointer');
});

// Seeded Math.random (mulberry32, as the harness), so two pages draw the same membrane wobble.
async function withSeed(fn) {
  const orig = Math.random;
  let seed = 7;
  Math.random = () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  try { return await fn(); } finally { Math.random = orig; }
}
async function playedPage(cfg) {
  const p = bootPage({ w: 1707, h: 932, dpr: 1.5, cfg });
  await spawn(p, p.session.feed);
  p.canvas.dispatch('mousemove', { clientX: 1200, clientY: 700 });
  await p.frames(20);
  return p;
}

test('ghost strip: the whole window is canvas, and every call matches the reference canvas above a 90 px strip', async () => {
  const a = await withSeed(() => playedPage({ bannerPx: 90 }));       // their page: canvas above the strip
  const b = await withSeed(() => playedPage({ ghostBannerPx: 90 }));  // ours: no strip, sized as if it were there
  assert.deepStrictEqual([a.canvas.width, a.canvas.height], [2560, 1263]);
  assert.deepStrictEqual([b.canvas.width, b.canvas.height], [2560, 1398]);
  assert.deepStrictEqual([b.mod.camera.W, b.mod.camera.H], [2560, 1263], 'draw scale and mouse from the layout height');
  assert.strictEqual(b.mod.camera.scale, a.mod.camera.scale);
  assert.deepStrictEqual([b.mod.hud.W, b.mod.hud.H], [2560, 1263], 'HUD scale, board and bottom panels too');
  assert.ok(a.sent.some((s) => s[0] === 'target'));
  // Ours first tells the server how much map it draws under the reference view: 135 rows at draw scale 2560 / 1920
  // is 101.25 world units at zoom 1, rounded up. Their page (and ours at parity) never sends it.
  assert.deepStrictEqual(b.sent[0], ['view', { below: 102 }]);
  assert.ok(!a.sent.some((s) => s[0] === 'view'), 'nothing extra at parity');
  assert.deepStrictEqual(b.sent.slice(1), a.sent, 'the same targets go to the server');
  // Call for call (every canvas, the board and text canvases included): equal, except the three that now cover the
  // whole 1398-high canvas: the clear, the grid fill and the dim layer.
  const A = a.doc.calls, B = b.doc.calls;
  assert.strictEqual(B.length, A.length);
  const kinds = { clear: 0, grid: 0, dim: 0 };
  for (let i = 0; i < A.length; i++) {
    const x = A[i], y = B[i];
    if (JSON.stringify(x) === JSON.stringify(y)) continue;
    assert.strictEqual(y[0], b.canvas.cid, 'only the main canvas differs: ' + JSON.stringify([x, y]));
    assert.strictEqual(y[1], x[1]);
    const [ax, ay, aw, ah] = x[2], [bx, by, bw, bh] = y[2];
    assert.deepStrictEqual([bx, by, bw], [ax, ay, aw]);
    if (x[1] === 'clearRect' && ah === 1263 && bh === 1398) kinds.clear++;
    else if (x[1] === 'fillRect' && aw === 2560 && ah === 1263 && bh === 1398) kinds.dim++;
    else if (x[1] === 'fillRect' && Math.abs((bh - 50) / (ah - 50) - 1398 / 1263) < 1e-12) kinds.grid++;
    else assert.fail('unexpected difference ' + JSON.stringify([x, y]));
  }
  assert.ok(kinds.clear > 10 && kinds.grid > 10 && kinds.dim > 10, JSON.stringify(kinds));
  // The world transform is the 1263-high canvas's: centre (1280, 631), so the top 842 CSS px look like theirs.
  assert.ok(B.some((c) => c[0] === b.canvas.cid && c[1] === 'translate' && c[2][0] === 1280 && c[2][1] === 631));
});

test('ghost strip: menu scale from the window above the strip; a window shorter than the strip draws nothing', async () => {
  const p = bootPage({ w: 1266, h: 626, dpr: 1.5, cfg: { ghostBannerPx: 90 }, matchMedia: fakePointer(false).matchMedia });
  assert.deepStrictEqual([p.canvas.width, p.canvas.height], [1899, 939]);
  assert.strictEqual(menuTransform(p), 'translate(-50%, -50%) scale(0.67)', 'the same 0.67 as theirs at 1266 x 626');
  await spawn(p, p.session.feed);
  assert.deepStrictEqual([p.mod.camera.W, p.mod.camera.H], [1899, 804]);
  resize(p, 1266, 80);
  p.doc.calls.length = 0;
  await p.frames(5);
  assert.strictEqual(p.doc.calls.filter((c) => c[0] === p.canvas.cid).length, 0, 'layout height 0: nothing drawn');
  resize(p, 1266, 626);
  await p.frames(2);
  assert.ok(p.doc.calls.some((c) => c[0] === p.canvas.cid), 'drawing resumes');
});

test('ghost strip: the page reports the map it draws under the reference view, and the server view box covers it', async () => {
  const agView = require('../server/ag/agView');
  const { LAWS } = require('../server/ag/agLaws');
  const cap = LAWS.VIEW_BELOW.value.cap;
  const views = (p) => p.sock.emitted.filter((e) => e[0] === 'ag:view');
  const connect = (p) => { p.sock.connected = true; p.sock.fire('connect'); };
  const hello = (p) => p.sock.fire('ag:f', W.encodeBundle([{ t: 'hello' }, BORDER]));
  // The window sizes the review measured (box bottom row before the fix: 1418, 1321, 749 of 1398, 1398, 800).
  for (const [w, h, dpr] of [[1707, 932, 1.5], [853, 932, 1.5], [1280, 720, 1], [1280, 800, 1], [1000, 1000, 1]]) {
    const p = bootPage({ net: true, w, h, dpr, cfg: { ghostBannerPx: 90 } });
    connect(p);
    assert.deepStrictEqual(views(p), [], 'nothing before the hello');
    hello(p);
    await p.frames(4, 50);
    const sent = views(p);
    assert.strictEqual(sent.length, 1, w + 'x' + h);
    const below = sent[0][1].below;
    const cw = p.canvas.width, CH = p.canvas.height, H = Math.trunc((h - 90) * dpr);
    assert.deepStrictEqual([p.mod.camera.W, p.mod.camera.H], [cw, H], 'the camera draws on that layout');
    const f = LIB.agCamera.screenFactor(cw, H);
    assert.ok(Number.isInteger(below) && below >= (CH - H) / f && below < (CH - H) / f + 1, 'rows / f, rounded up');
    assert.ok(below <= cap, 'every window the review listed is under the VIEW_BELOW cap');
    // The canvas row of the server box bottom when the camera sits on the server's view centre at wheel 1 (client
    // zoom = s, draw scale s * f, world centre row trunc(H / 2)): past the last canvas row at every scale, by at
    // least the slack L4 gives under the reference view (50.3 world units, less half a row of centre rounding).
    for (const s of [1, 0.5, 0.2]) {
      const row = (b) => Math.trunc(H / 2) + agView.viewBoxFor(0, 0, s, LAWS.L4.value, Math.min(b, cap)).maxY * s * f;
      assert.ok((row(below) - CH) / f >= 50.3 - 0.5 / f - 1e-9, w + 'x' + h + ' s ' + s + ': ' + row(below) + ' of ' + CH);
      if (w === 853) assert.ok(row(0) < CH - 70, 'without the report the bottom band is never sent');
    }
  }

  // Sent again only when it changes, nothing while the socket is down, and again on the next hello.
  const p = bootPage({ net: true, w: 1707, h: 932, dpr: 1.5, cfg: { ghostBannerPx: 90 } });
  connect(p);
  hello(p);
  resize(p, 1707, 932);
  resize(p, 1000, 1000);                  // 1500 x 1365 layout of 1500: 135 / (1365 / 1080) = 106.8
  resize(p, 1000, 80);                    // layout height 0: nothing drawn, nothing more to send
  assert.deepStrictEqual(views(p).map((e) => e[1].below), [102, 107, 0]);
  p.sock.connected = false;
  p.sock.fire('disconnect', 'transport close');
  resize(p, 1707, 932);
  assert.strictEqual(views(p).length, 3, 'nothing while disconnected');
  connect(p);
  hello(p);
  assert.deepStrictEqual(views(p).map((e) => e[1].below), [102, 107, 0, 102]);

  // At parity (the harness page, a real strip) the page never sends it.
  const q = bootPage({ net: true, w: 1707, h: 932, dpr: 1.5, cfg: { bannerPx: 90 } });
  connect(q);
  hello(q);
  await spawn(q, (rec) => q.sock.fire('ag:f', W.encodeBundle([rec])));
  assert.deepStrictEqual(views(q), []);
  assert.ok(!q.sent.some((s) => s[0] === 'view'));
});

test('the shipped page sizes as if the 90 px strip were there; the canvas element still fills the window', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'ag.html'), 'utf8');
  assert.match(html, /window\.DUEL_AGAR_CONFIG = \{ url: '\/ag', ghostBannerPx: 90, portrait: true \};/);
  assert.doesNotMatch(html, /[{,] bannerPx:/, 'no real strip on the shipped page');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'ag.css'), 'utf8');
  assert.match(css, /height: calc\(100% - var\(--ag-banner, 0px\)\);/);
  assert.match(css, /@media \(max-width: 360px\) and \(pointer: coarse\)/);
});

// ---- phone portrait (FIX-PLAN P4, Owen's 2026-10-08 design) -----------------------------------------------------
const PORTRAIT_CFG = (extra) => Object.assign({ ghostBannerPx: 90, portrait: true, tabStorage: makeStorage() }, extra || {});

test('P4 portrait: an upright phone plays the turned layout on the whole canvas; the card shows once, for 3 s', async () => {
  const pt = fakePointer(true);
  const p = bootPage({ w: 390, h: 844, dpr: 3, cfg: PORTRAIT_CFG(), matchMedia: pt.matchMedia });
  assert.deepStrictEqual([p.canvas.width, p.canvas.height], [1170, 2532]);
  assert.strictEqual(p.session.state().portrait, true);
  assert.strictEqual(p.session.state().rotatePrompt, true, 'the card is up at start-up');
  assert.ok(p.doc.documentElement.classList.contains('ag-portrait'), 'ag.css lays the pad out for it');
  await spawn(p, p.session.feed);
  const cam = p.mod.camera, hud = p.mod.hud;
  assert.deepStrictEqual([cam.W, cam.H, cam.portrait], [1170, 2532, true], 'the whole canvas, no ghost strip');
  assert.strictEqual(cam.scale, cam.zoom * 1.31875, 'max(1170 / 1080, 2532 / 1920) = 1.31875');
  const v = LIB.agCamera.visibleWorld(cam.W, cam.H, 1, true);
  assert.ok(Math.abs(v.w - 887.2) < 0.01 && Math.abs(v.h - 1920) < 1e-9, 'wheel 1, zoom 1: ' + JSON.stringify(v));
  assert.deepStrictEqual([hud.W, hud.H, hud.portrait], [1170, 2532, true]);
  // The board is drawn at the turned HUD scale (q = 1170 / 1080): 19 px rows.
  p.doc.calls.length = 0;
  p.session.feed({ t: 'board', rows: [{ name: 'bob' }, { me: true }] });
  const boardTexts = p.doc.calls.filter((c) => c[0] !== p.canvas.cid && c[1] === 'fillText');
  assert.ok(boardTexts.length >= 3, 'title and two rows drawn');
  assert.strictEqual(hud.lbCtx.font, '19px Ubuntu', 'the row font');
  // The card goes after 3 s of page time (spawn ran about 167 ms of it).
  await p.frames(28, 100);
  assert.strictEqual(p.session.state().rotatePrompt, true, 'still up just before 3 s');
  await p.frames(2, 100);
  assert.strictEqual(p.session.state().rotatePrompt, false, 'gone after 3 s');
  // Sideways: the exact reference layout (the ghost strip's 2532 x 900); upright again: straight to the layout.
  resize(p, 844, 390);
  await p.frames(2);
  assert.deepStrictEqual([cam.W, cam.H, cam.portrait, hud.portrait], [2532, 900, false, false]);
  assert.ok(!p.doc.documentElement.classList.contains('ag-portrait'));
  assert.strictEqual(cam.scale, cam.zoom * (2532 / 1920));
  resize(p, 390, 844);
  await p.frames(2);
  assert.deepStrictEqual([cam.W, cam.H, cam.portrait], [1170, 2532, true]);
  assert.strictEqual(p.session.state().rotatePrompt, false, 'no card again in the session');
});

test('P4 portrait: a lobby zoomed before the game opened can be pinched back over the card (agInput.lobbyZoomed)', () => {
  const vv = { scale: 5, addEventListener() {}, removeEventListener() {} };
  const p = bootPage({ w: 390, h: 844, dpr: 3, cfg: PORTRAIT_CFG(), matchMedia: fakePointer(true).matchMedia, top: { visualViewport: vv } });
  assert.strictEqual(p.session.state().rotatePrompt, true);
  const card = p.doc.getElementById('ag-rotate');
  const fire = (type, n) => { let k = 0; card.dispatch(type, { cancelable: true, touches: new Array(n).fill({}), preventDefault() { k++; }, stopPropagation() {} }); return k; };
  assert.deepStrictEqual([fire('touchstart', 1), fire('touchstart', 2), fire('touchend', 1), fire('touchend', 0)], [0, 0, 0, 0], 'zoomed: the pinch is left to the browser');
  vv.scale = 1;
  assert.deepStrictEqual([fire('touchstart', 1), fire('touchend', 0)], [1, 0], 'at 1: the card eats the touch, as before');
  p.session.destroy();
});

test('P4 portrait: the server is told (ag:portrait, one boolean) on the hello and on every change only', async () => {
  const sent = (p) => p.sock.emitted.filter((e) => e[0] === 'ag:portrait' || e[0] === 'ag:view');
  const connect = (p) => { p.sock.connected = true; p.sock.fire('connect'); };
  const hello = (p) => p.sock.fire('ag:f', W.encodeBundle([{ t: 'hello' }, BORDER]));
  const p = bootPage({ net: true, w: 390, h: 844, dpr: 3, cfg: PORTRAIT_CFG(), matchMedia: fakePointer(true).matchMedia });
  connect(p);
  assert.deepStrictEqual(sent(p), [], 'nothing before the hello');
  hello(p);
  assert.deepStrictEqual(sent(p), [['ag:portrait', true]], 'upright: no rows below, so no ag:view');
  assert.deepStrictEqual(p.sent.filter((s) => s[0] === 'portrait'), [['portrait', { on: true }]]);
  resize(p, 390, 844);
  assert.strictEqual(sent(p).length, 1, 'no change, nothing sent');
  // Sideways: the reference layout and its ghost rows, 270 rows / (2532 / 1920) = 204.7, rounded up.
  resize(p, 844, 390);
  assert.deepStrictEqual(sent(p).slice(1), [['ag:portrait', false], ['ag:view', { below: 205 }]]);
  resize(p, 390, 844);
  assert.deepStrictEqual(sent(p).slice(3), [['ag:portrait', true], ['ag:view', { below: 0 }]]);
  p.sock.connected = false;
  p.sock.fire('disconnect', 'transport close');
  resize(p, 844, 390);
  resize(p, 390, 844);
  assert.strictEqual(sent(p).length, 5, 'nothing while disconnected');
  connect(p);
  hello(p);
  assert.deepStrictEqual(sent(p).slice(5), [['ag:portrait', true]], 'a new socket starts sideways: told again');

  // A phone that starts sideways, and a mouse screen upright (the harness phone config), never send it.
  for (const [w, h, coarse] of [[844, 390, true], [390, 844, false]]) {
    const q = bootPage({ net: true, w, h, dpr: 3, cfg: PORTRAIT_CFG(), matchMedia: fakePointer(coarse).matchMedia });
    connect(q);
    hello(q);
    await spawn(q, (rec) => q.sock.fire('ag:f', W.encodeBundle([rec])));
    const tag = w + 'x' + h + (coarse ? ' touch' : ' mouse');
    assert.deepStrictEqual(sent(q).map((e) => e[0]), ['ag:view'], tag);
    assert.strictEqual(q.session.state().rotatePrompt, false, tag);
  }
});

test('P4 portrait: sideways, on a mouse screen and at parity the page is call for call the page without it', async () => {
  async function played(w, h, coarse, cfg) {
    const p = bootPage({ w, h, dpr: 3, cfg, matchMedia: fakePointer(coarse).matchMedia });
    await spawn(p, p.session.feed);
    p.canvas.dispatch('mousemove', { clientX: w * 0.7, clientY: h * 0.3 });
    await p.frames(20);
    resize(p, w + 1, h);
    await p.frames(5);
    return p;
  }
  for (const [w, h, coarse, base] of [[844, 390, true, { ghostBannerPx: 90 }], [390, 844, false, { ghostBannerPx: 90 }],
    [390, 844, false, { bannerPx: 90 }], [1707, 932, false, { ghostBannerPx: 90 }]]) {
    const a = await withSeed(() => played(w, h, coarse, base));
    const b = await withSeed(() => played(w, h, coarse, Object.assign({}, base, { portrait: true, tabStorage: makeStorage() })));
    const tag = w + 'x' + h + ' ' + JSON.stringify(base);
    assert.strictEqual(b.session.state().portrait, false, tag);
    assert.ok(a.doc.calls.length > 1000, tag);
    assert.ok(JSON.stringify(b.doc.calls) === JSON.stringify(a.doc.calls), tag + ': canvas calls');
    assert.deepStrictEqual(b.doc.sizeWrites, a.doc.sizeWrites, tag + ': size writes');
    assert.deepStrictEqual(b.sent, a.sent, tag + ': outbound');
    assert.strictEqual(b.doc.getElementById('ag-rotate'), null, tag + ': no card');
  }
});

test('P4 portrait: a pointer switch turns the layout on or off without a resize; destroy removes the card', async () => {
  const pt = fakePointer(true);
  const p = bootPage({ w: 390, h: 844, dpr: 3, cfg: PORTRAIT_CFG(), matchMedia: pt.matchMedia });
  assert.strictEqual(p.session.state().portrait, true);
  assert.ok(p.doc.getElementById('ag-rotate'));
  pt.set(false);
  assert.strictEqual(p.session.state().portrait, false);
  assert.deepStrictEqual([p.canvas.width, p.canvas.height], [1170, 2532], 'the canvas fills the window either way');
  assert.strictEqual(p.session.state().rotatePrompt, false, 'a mouse screen gets no card');
  await p.frames(2, 50);
  assert.deepStrictEqual([p.mod.camera.W, p.mod.camera.H], [1170, 2262], 'the ghost layout again');
  assert.notStrictEqual(menuTransform(p), 'translate(-50%, -50%)', 'mouse: the reference menu scale');
  pt.set(true);
  await p.frames(2, 50);
  assert.deepStrictEqual([p.mod.camera.W, p.mod.camera.H, p.session.state().portrait], [1170, 2532, true]);
  assert.strictEqual(menuTransform(p), 'translate(-50%, -50%)');
  const card = p.doc.getElementById('ag-rotate');
  p.session.destroy();
  assert.strictEqual(card.parentNode, null);
  assert.strictEqual(pt.listeners.length, 0);
});
