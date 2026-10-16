'use strict';
// A small fake page for the T17 layer HUD tests (SERVER-DESIGN 15.6 item 6: the ACTIVE layer is proven on its own fake
// page, never by the gate). Nothing here is a test; node --test loads it and finds none.
//
// makePage(opts) -> { win, doc, S, slx, clock, raf(n), dispatch, key, load(file), sent, ... }
//   win, doc     a vm context with a DOM that keeps a real tree (parentNode, children, textContent) and runs events
//                through capture, target and bubble phases, including the on<type> properties of document and window
//                (their client's handlers are properties, public/js/sl/slInput.js:200-209)
//   S            a plain object standing for DuelSlither.S (the fields the HUD files read)
//   slx          a fake layer bus with the API slxNet and slxMain give the later layer files
//                (public/js/slx/slxNet.js header): active, on, fire, send, onSocket, connected, now, guard, toLobby,
//                lobbyName. guard copies slxMain's stops (mousedown, contextmenu, touches; keys for a text box;
//                activate on click). Socket listeners added with onSocket run through socketEvent(name, data).
//   load(file)   runs a public/js/slx file in the context; 'dsEnd.js' is the shared end screens (public/js/shared), which
//                the composed /sl page loads before the slx tail (server/sl/slBoot.js slxTail) and slxCard and slxHud
//                draw with, so a test loads it first the same way
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SHARED = ['dsEnd.js'];

function makePage(opts) {
  const o = opts || {};
  const clock = { now: 1000 };
  const rafs = [];
  const timers = [];
  let tid = 0;

  // ---- DOM
  class Node0 {
    constructor(doc) {
      this.ownerDocument = doc;
      this.parentNode = null;
      this.childNodes = [];
    }
    get firstChild() { return this.childNodes[0] || null; }
    get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
    appendChild(c) {
      if (c.parentNode) c.parentNode.removeChild(c);
      c.parentNode = this;
      this.childNodes.push(c);
      return c;
    }
    removeChild(c) {
      const at = this.childNodes.indexOf(c);
      if (at < 0) throw new Error('removeChild: not a child');
      this.childNodes.splice(at, 1);
      c.parentNode = null;
      return c;
    }
    get textContent() {
      return this.childNodes.map((c) => c.textContent).join('');
    }
    set textContent(v) {
      for (const c of this.childNodes) c.parentNode = null;
      this.childNodes = [];
      const s = String(v);
      if (s) this.appendChild(new Text0(this.ownerDocument, s));
    }
  }
  class Text0 {
    constructor(doc, s) { this.ownerDocument = doc; this.parentNode = null; this.data = s; this.nodeType = 3; }
    get textContent() { return this.data; }
  }
  class El extends Node0 {
    constructor(doc, tag) {
      super(doc);
      this.tagName = String(tag).toUpperCase();
      this.nodeType = 1;
      this.style = {};
      this.className = '';
      this.attrs = {};
      this.listeners = [];
      this.scrollTop = 0;
      this.clientHeight = 144;
      this.scrollHeight = 0;
      this.value = '';
      this.disabled = false;
      this.innerHTML = '';
    }
    get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    addEventListener(type, fn, opt) { addL(this, type, fn, opt); }
    removeEventListener(type, fn) { removeL(this, type, fn); }
    focus() {
      const prev = doc.activeElement;
      if (prev === this) return;
      doc.activeElement = this;
      if (prev && prev !== doc.body && prev.dispatchEvent) dispatch(prev, 'blur', {}, { bubbles: false });
      dispatch(this, 'focus', {}, { bubbles: false });
    }
    blur() {
      if (doc.activeElement !== this) return;
      doc.activeElement = doc.body;
      dispatch(this, 'blur', {}, { bubbles: false });
    }
    dispatchEvent(ev) { return dispatch(this, ev.type, ev); }
    getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 30, width: 100, height: 30 }; }
  }

  function addL(node, type, fn, opt) {
    const capture = opt === true || !!(opt && opt.capture);
    const once = !!(opt && opt.once);
    node.listeners.push({ type, fn, capture, once, passive: !!(opt && opt.passive) });
  }
  function removeL(node, type, fn) {
    node.listeners = node.listeners.filter((l) => !(l.type === type && l.fn === fn));
  }

  const doc = new Node0(null);
  doc.listeners = [];
  doc.nodeType = 9;
  doc.ownerDocument = doc;
  doc.createElement = (tag) => new El(doc, tag);
  doc.createTextNode = (s) => new Text0(doc, String(s));
  doc.addEventListener = (type, fn, opt) => addL(doc, type, fn, opt);
  doc.removeEventListener = (type, fn) => removeL(doc, type, fn);
  doc.hidden = false;
  doc.visibilityState = 'visible';
  const html = new El(doc, 'html');
  doc.appendChild(html);
  doc.head = html.appendChild(new El(doc, 'head'));
  doc.body = html.appendChild(new El(doc, 'body'));
  doc.activeElement = doc.body;
  doc.getElementById = (id) => {
    const walk = (n) => {
      if (n.attrs && n.attrs.id === id) return n;
      for (const c of n.childNodes || []) { const f = c.nodeType === 1 ? walk(c) : null; if (f) return f; }
      return null;
    };
    return walk(html);
  };

  // ---- window
  const win = {
    document: doc,
    listeners: [],
    performance: { now: () => clock.now },
    requestAnimationFrame(cb) { rafs.push(cb); return rafs.length; },
    setTimeout(cb, ms) { timers.push({ id: ++tid, due: clock.now + (+ms || 0), cb }); return tid; },
    clearTimeout(id) { const at = timers.findIndex((t) => t.id === id); if (at >= 0) timers.splice(at, 1); },
    addEventListener(type, fn, opt) { addL(win, type, fn, opt); },
    removeEventListener(type, fn) { removeL(win, type, fn); },
    location: { assigned: [], assign(u) { this.assigned.push(String(u)); } },
    console
  };
  win.window = win;
  win.self = win;
  win.parent = win;
  if (o.win) Object.assign(win, o.win);
  vm.createContext(win);

  // ---- events: capture (window, document, ancestors), target, bubble (ancestors, document, window)
  function dispatch(target, type, init, flags) {
    const bubbles = !(flags && flags.bubbles === false);
    const ev = Object.assign({ key: undefined, keyCode: 0 }, init || {}, {
      type,
      target,
      defaultPrevented: false,
      stopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.stopped = true; }
    });
    const chain = [];
    for (let n = target.parentNode; n && n !== doc; n = n.parentNode) chain.push(n);
    const path = [win, doc].concat(chain.slice().reverse());
    function run(node, phase) {
      const list = (node.listeners || []).slice();
      for (const l of list) {
        if (l.type !== type) continue;
        if (phase === 'capture' && !l.capture) continue;
        if (phase === 'bubble' && l.capture) continue;
        if (l.once) removeL(node, type, l.fn);
        ev.currentTarget = node;
        l.fn.call(node, ev);
      }
      if (phase !== 'capture' && typeof node['on' + type] === 'function') node['on' + type].call(node, ev);
    }
    for (const n of path) {
      run(n, 'capture');
      if (ev.stopped) return !ev.defaultPrevented;
    }
    run(target, 'target');
    if (ev.stopped || !bubbles) return !ev.defaultPrevented;
    for (const n of path.slice().reverse()) {
      run(n, 'bubble');
      if (ev.stopped) break;
    }
    return !ev.defaultPrevented;
  }

  // ---- the frozen client's state, as far as the HUD reads it
  const lastscore = new El(doc, 'div');
  const vcm = new El(doc, 'div');
  const S = Object.assign({ playing: false, connected: false, slither: null, is_mobile: false, lagging: false,
    lastscore, vcm }, o.S || {});
  const stats = { messages: 0, events: 0, wireBytes: 0, wireErrors: 0, applyThrows: 0 };
  const plays = [];
  const D = { S, stats, play(nick) { plays.push(nick == null ? '' : String(nick)); } };
  win.DuelSlither = D;

  // ---- the fake layer bus (slxNet's API)
  const subs = {};
  const sockSubs = [];
  const sent = [];
  const lobbyPosts = [];
  let live = o.connected !== undefined ? !!o.connected : true;
  function guard(el, g) {
    const opts = g || {};
    const stop = (e) => e.stopPropagation();
    // slxMain's list (mouseup goes on since the fixer pass of 2026-10-10)
    for (const t of ['mousedown', 'contextmenu', 'touchmove', 'touchend', 'touchcancel']) el.addEventListener(t, stop);
    el.addEventListener('touchstart', (e) => { e.stopPropagation(); if (!opts.typing) e.preventDefault(); }, { passive: false });
    if (typeof opts.activate === 'function') el.addEventListener('click', (e) => { e.stopPropagation(); opts.activate(e); });
    if (opts.typing) for (const t of ['keydown', 'keyup', 'keypress']) el.addEventListener(t, stop);
    return el;
  }
  const slx = {
    active: true,
    errors: 0,
    on(name, fn) { (subs[name] = subs[name] || []).push(fn); return () => {}; },
    fire(name, a, b) { for (const fn of (subs[name] || []).slice()) fn(a, b); },
    send(name, payload) { if (!live) return false; sent.push([name, JSON.parse(JSON.stringify(payload))]); return true; },
    onSocket(name, fn) { sockSubs.push([name, fn]); },
    connected() { return live; },
    now() { return clock.now; },
    rtt: -1,
    guard,
    toLobby() { if (o.framed === false) return false; lobbyPosts.push('game:done'); return true; },
    lobbyName() { return o.lobbyName === undefined ? 'Owen' : o.lobbyName; },
    framed: o.framed !== false,
    inLobby: o.framed !== false
  };
  D.slx = slx;

  const P = {
    win, doc, S, D, slx, clock, sent, plays, lobbyPosts, stats, El,
    dispatch,
    setConnected(v) { live = !!v; },
    socketEvent(name, data) { for (const [n, fn] of sockSubs) if (n === name) fn(data); },
    // Advance the clock by ms in steps, running timers and one animation frame per step.
    raf(n, stepMs) {
      for (let i = 0; i < (n || 1); i++) {
        clock.now += stepMs === undefined ? 16 : stepMs;
        for (const t of timers.slice().sort((a, b) => a.due - b.due)) {
          if (t.due <= clock.now) { timers.splice(timers.indexOf(t), 1); t.cb(); }
        }
        const list = rafs.splice(0, rafs.length);
        for (const cb of list) cb(clock.now);
      }
    },
    rafCount() { return rafs.length; },
    key(target, type, init) { return dispatch(target, type, init); },
    load(file) {
      const dir = SHARED.includes(file) ? 'shared' : 'slx';
      const src = fs.readFileSync(path.join(ROOT, 'public', 'js', dir, file), 'utf8');
      vm.runInContext(src, win, { filename: file });
    },
    // Every element in the body whose className has this class.
    find(cls) {
      const out = [];
      const walk = (n) => {
        if (n.nodeType === 1 && (' ' + n.className + ' ').indexOf(' ' + cls + ' ') >= 0) out.push(n);
        for (const c of n.childNodes || []) if (c.nodeType === 1) walk(c);
      };
      walk(doc.body);
      return out;
    },
    // The shared card's button of this id in the body (dsEnd marks each with data-dse-btn), or null.
    button(id) {
      const walk = (n) => {
        if (n.nodeType === 1 && n.attrs && n.attrs['data-dse-btn'] === id) return n;
        for (const c of n.childNodes || []) { const f = c.nodeType === 1 ? walk(c) : null; if (f) return f; }
        return null;
      };
      return walk(doc.body);
    },
    styleText() {
      return doc.head.children.filter((e) => e.tagName === 'STYLE').map((e) => e.textContent).join('\n');
    }
  };
  return P;
}

module.exports = { makePage, ROOT };
