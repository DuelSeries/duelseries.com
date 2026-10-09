'use strict';
// A small fake page for booting the agar.io client (public/js/ag/agMain.js) under node: a fake DOM, a canvas whose
// 2D context records method calls AND property writes, a virtual clock, manual animation frames, virtual timers and
// a fake socket.io. The same shape as the page in test/agMain.test.js (which keeps its own copy), with property
// writes logged so a test can see colours, line widths and alpha. Used by test/agCashoutClient.test.js.
const path = require('path');

const AG = path.join(__dirname, '..', 'public', 'js', 'ag');
require('../shared/agWire.js');
for (const f of ['agMath', 'agWorld', 'agCamera', 'agInput', 'agRender', 'agHud', 'agScreens', 'agSound', 'agNet', 'agPortrait', 'agMain']) {
  require(path.join(AG, f + '.js'));
}
const LIB = globalThis.DuelAgarLib;
const W = require('../shared/agWire.js');

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
    set(t, k, v) { props[k] = v; log.push([canvas.cid, '=' + String(k), [v]]); return true; }
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
    dispatch(type, ev) {
      (listeners[type] || []).slice().forEach((fn) => fn(Object.assign({ type, preventDefault() {}, stopPropagation() {} }, ev)));
    },
    focus() {}
  };
  if (tag === 'canvas') {
    let w = 300, h = 150;
    el.cid = 'cv' + (doc._n++);
    Object.defineProperty(el, 'width', { get() { return w; }, set(v) { doc.sizeWrites.push([el.cid, 'width', v]); w = idlDim(v, 300); } });
    Object.defineProperty(el, 'height', { get() { return h; }, set(v) { doc.sizeWrites.push([el.cid, 'height', v]); h = idlDim(v, 150); } });
    let ctx = null;
    el.getContext = () => (ctx = ctx || makeCtx(el, doc.calls));
  }
  return el;
}

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
    fire(ev, arg) { (handlers[ev] || []).forEach((fn) => fn(arg)); },
    listens(ev) { return (handlers[ev] || []).length; }
  };
}

// o: w, h, dpr, net (fake socket.io), pad (Split / Eject / Cash out buttons), cfg (extra boot config), parent
function bootPage(o) {
  o = o || {};
  const doc = makeDoc();
  const canvas = doc.body.appendChild(makeElement(doc, 'canvas'));
  canvas.setAttribute('id', 'canvas');
  if (o.pad) {
    for (const id of ['ag-cash', 'ag-split', 'ag-eject']) doc.body.appendChild(makeElement(doc, 'button')).setAttribute('id', id);
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
    fire(type, props) { (winListeners[type] || []).slice().forEach((fn) => fn(Object.assign({ type, preventDefault() {} }, props || {}))); }
  };
  if (o.parent) win.parent = o.parent;
  let ioCalls = 0;
  if (o.net) win.io = () => { ioCalls++; return sock; };
  globalThis.document = doc;
  const sound = LIB.agSound.createSound({ storage: null, createAudioContext: () => null });
  const cfg = Object.assign({ win, doc, canvas, sound, idlePass: false, net: !!o.net, engineNow: () => clock }, o.cfg || {});
  const session = LIB.agMain.boot(cfg);
  const sent = [];
  session.onSend = (kind, payload) => sent.push([kind, payload, clock]);

  function runTimers() {
    for (let guard = 0; guard < 100; guard++) {
      const due = timers.filter((t) => t.at <= clock);
      if (!due.length) return;
      timers = timers.filter((t) => t.at > clock);
      due.forEach((t) => t.fn());
    }
  }
  async function frame(ms) {
    clock += ms === undefined ? 1000 / 60 : ms;
    runTimers();
    await Promise.resolve();
    await Promise.resolve();
    if (raf) raf(clock);
  }
  async function frames(n, ms) { for (let i = 0; i < n; i++) await frame(ms); }
  const key = (type, keyCode) => win.fire(type, { keyCode });
  return { doc, canvas, win, sock, session, sent, frame, frames, key, now: () => clock, mod: session.modules, ioCalls: () => ioCalls };
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

module.exports = { LIB, W, bootPage, makeElement, makeDoc, BORDER, cell, spawn };
