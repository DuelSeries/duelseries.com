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
for (const f of ['agMath', 'agWorld', 'agCamera', 'agInput', 'agRender', 'agHud', 'agScreens', 'agSound', 'agNet', 'agMain']) {
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

function makeDoc() {
  const doc = { _n: 0, calls: [], sizeWrites: [] };
  doc.createElement = (tag) => makeElement(doc, tag);
  doc.documentElement = { style: { setProperty() {} } };
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

// boot options: w, h, dpr, net (true = fake socket.io), fonts (a fake document.fonts), cfg (extra boot config)
function bootPage(o) {
  o = o || {};
  const doc = makeDoc();
  const canvas = doc.body.appendChild(makeElement(doc, 'canvas'));
  canvas.setAttribute('id', 'canvas');
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
  assert.deepStrictEqual(b.sent, a.sent, 'the same targets go to the server');
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

test('the shipped page sizes as if the 90 px strip were there; the canvas element still fills the window', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'ag.html'), 'utf8');
  assert.match(html, /window\.DUEL_AGAR_CONFIG = \{ url: '\/ag', ghostBannerPx: 90 \};/);
  assert.doesNotMatch(html, /[{,] bannerPx:/, 'no real strip on the shipped page');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'ag.css'), 'utf8');
  assert.match(css, /height: calc\(100% - var\(--ag-banner, 0px\)\);/);
  assert.match(css, /@media \(max-width: 360px\) and \(pointer: coarse\)/);
});
