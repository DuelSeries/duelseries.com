'use strict';
// The frozen slither client in a node vm (SERVER-DESIGN 18.2 item 6, 15.6 item 4; task T10).
//
// A copy of the vm page of test/slParityGate.test.js (its sections 2 and 3: the hash, the fake page, the state walk,
// the DOM hash and one golden run), so the gate file is never edited. Every pinned client script of public/sl.html
// runs in page order on a small fake page with a virtual clock, a seeded Math.random and manual animation frames.
// With no options the page behaves exactly as the gate's: runGolden(name) gives the same per-frame hashes as the gate
// (test/slMirror.test.js proves it against test/slGoldenFrames.json.gz). The options only ADD:
//   scripts    the [file, source] list to boot (default: the sl.html scripts); slxNoTouch appends the layer here
//   transport  (P, handlers) -> {open, send, close, join?}: a live game socket in place of the recorded entries
//              (the mirror feeds our server's bundles through it); it may set P.socketHook for its per-frame part
//   win        extra window properties (merged before the scripts run)
// Nothing here is a test; node --test loads it and finds none.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');

// git's blob id of the LF-normalised bytes (core.autocrlf=true can check the files out as CRLF).
function blobId(bytes) {
  const lf = Buffer.from(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
  return crypto.createHash('sha1').update('blob ' + lf.length + '\0').update(lf).digest('hex');
}

// ---------------------------------------------------------------------------------------------------- hashing

// Two 32-bit lanes over 32-bit words. A regression detector, not a security hash.
const F64 = new Float64Array(1);
const W32 = new Uint32Array(F64.buffer);
function fmix(h) {
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
class Mix {
  constructor() { this.a = 0x811c9dc5 | 0; this.b = 0x6a09e667 | 0; }
  u(x) {
    this.a = Math.imul(this.a ^ x, 0x01000193);
    const b = Math.imul((this.b + x) ^ (this.b >>> 15), 0x2c1b3c6d);
    this.b = b ^ (b >>> 12);
  }
  num(v) { F64[0] = v; this.u(W32[0]); this.u(W32[1]); }   // exact bits: -0, NaN and every float differ
  str(s) {
    this.u(0x53000000 ^ s.length);
    for (let i = 0; i < s.length; i++) this.u(s.charCodeAt(i));
  }
  view(v) {   // any typed array or DataView, by its bytes
    const off = v.byteOffset, len = v.byteLength, buf = v.buffer;
    this.u(0x56000000 ^ len);
    const words = len >>> 2;
    let i = 0;
    if ((off & 3) === 0) {
      const w = new Uint32Array(buf, off, words);
      for (; i < words; i++) this.u(w[i]);
      i = words << 2;
    }
    const b = new Uint8Array(buf, off, len);
    for (; i < len; i++) this.u(b[i]);
  }
  hex() { return ((fmix(this.a) ^ fmix(this.b ^ 0x9e3779b9)) >>> 0).toString(16).padStart(8, '0'); }
}

// ---------------------------------------------------------------------------------------------------- the page

const HTML = fs.readFileSync(path.join(ROOT, 'public/sl.html'), 'utf8');
// The product scripts of sl.html, in page order (socket.io is not used: the harness transport replaces it; the sound
// engine, js/dsSfx*.js, is the layer's and not the client's, and its load-time timer would shift the timer ids the
// client keeps in its state, e.g. login_iv).
const SCRIPTS = [...HTML.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1])
  .filter((s) => !s.startsWith('/socket.io/') && !s.startsWith('/js/dsSfx'))
  .map((s) => (s.startsWith('/shared/') ? s.slice(1) : 'public' + s));
const SRC = SCRIPTS.map((f) => [f, fs.readFileSync(path.join(ROOT, f), 'utf8')]);

// Every data-sl element of sl.html in document order: tag, inline style, width and height attributes.
function camel(p) { return p.trim().replace(/-([a-z])/g, (m, c) => c.toUpperCase()); }
const PAGE_ELS = [...HTML.matchAll(/<(\w+)\b([^>]*)>/g)].map((m) => {
  const attrs = m[2], label = /\sdata-sl="([^"]+)"/.exec(attrs);
  if (!label) return null;
  const st = /\sstyle=(?:"([^"]*)"|'([^']*)')/.exec(attrs), style = {};
  if (st) for (const part of (st[1] != null ? st[1] : st[2]).split(';')) {
    const at = part.indexOf(':');
    if (at > 0) style[camel(part.slice(0, at))] = part.slice(at + 1).trim();
  }
  const w = /\swidth="(\d+)"/.exec(attrs), h = /\sheight="(\d+)"/.exec(attrs);
  return { tag: m[1].toLowerCase(), label: label[1], style, width: w ? +w[1] : null, height: h ? +h[1] : null };
}).filter(Boolean);

// Size of public/hexbg.jpg from its SOF marker (the tile image, slDrawWorld.init).
function jpegSize(file) {
  const b = fs.readFileSync(file);
  for (let i = 2; i + 9 < b.length;) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1], len = b.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
    i += 2 + len;
  }
  throw new Error('no SOF in ' + file);
}
const TILE = jpegSize(path.join(ROOT, 'public/hexbg.jpg'));

// The harness's fixed browser (instrument.js section 3): desktop Chrome on Windows, English.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 2D context API: every method and property a context has (the client uses a subset; anything else throws).
const METHODS = ['arc', 'arcTo', 'beginPath', 'bezierCurveTo', 'clearRect', 'clip', 'closePath', 'createImageData',
  'createLinearGradient', 'createPattern', 'createRadialGradient', 'drawImage', 'ellipse', 'fill', 'fillRect', 'fillText',
  'getImageData', 'getLineDash', 'lineTo', 'measureText', 'moveTo', 'putImageData', 'quadraticCurveTo', 'rect',
  'resetTransform', 'restore', 'rotate', 'save', 'scale', 'setLineDash', 'setTransform', 'stroke', 'strokeRect',
  'strokeText', 'transform', 'translate'];
const PROPS = { fillStyle: '#000000', strokeStyle: '#000000', globalAlpha: 1, lineWidth: 1, lineCap: 'butt',
  lineJoin: 'miter', miterLimit: 10, lineDashOffset: 0, font: '10px sans-serif', textAlign: 'start',
  textBaseline: 'alphabetic', direction: 'inherit', globalCompositeOperation: 'source-over',
  imageSmoothingEnabled: true, imageSmoothingQuality: 'low', shadowBlur: 0, shadowColor: 'rgba(0, 0, 0, 0)',
  shadowOffsetX: 0, shadowOffsetY: 0, filter: 'none' };
const PROP_NAMES = Object.keys(PROPS);
const PROP_DEFAULTS = PROP_NAMES.map((k) => PROPS[k]);
const OP_ADD_STOP = 200, OP_CANVAS_W = 201, OP_CANVAS_H = 202;

function makePage(H, entries, opts) {
  const o = opts || {};
  const P = {
    vnow: 1000, frame: 0, step: H.step, slow: [], timers: [], tid: 1000000, raf: [], winListeners: {}, docListeners: {},
    loads: [], els: [], labelled: [], nextEl: 0, nextObj: 0,
    calls: new Mix(), ncalls: 0, rafCalls: 0, out: new Mix(), nsends: 0, rng: 0,
    errors: [], logs: 0,
    entries, game: null, gameSockets: 0, next: 0, created: null, opens: [], delivered: 0, serverCloses: 0,
    clientCloses: 0, sendsDropped: 0, inputWireErrors: 0, script: []
  };

  // ---- canvas
  class Ctx {
    constructor(cv) { this.canvas = cv; this.st = PROP_DEFAULTS.slice(); this.stack = []; }
  }
  function argMix(m, a) {
    if (typeof a === 'number') { m.u(1); m.num(a); return; }
    if (typeof a === 'string') { m.u(2); m.str(a); return; }
    if (a === undefined) { m.u(3); return; }
    if (a === null) { m.u(4); return; }
    if (typeof a === 'boolean') { m.u(a ? 5 : 6); return; }
    if (a instanceof El) {
      m.u(7); m.u(a.id);
      if (a.tag === 'canvas') { m.u(a._w); m.u(a._h); m.u(a.content.a); m.u(a.content.b); }
      else { m.str(a._src || ''); m.u(a.naturalWidth); m.u(a.naturalHeight); }
      return;
    }
    if (a && a.__obj) { m.u(8); m.u(a.__obj); return; }
    if (a && a.data && ArrayBuffer.isView(a.data)) { m.u(9); m.u(a.width); m.u(a.height); m.view(a.data); return; }
    if (Array.isArray(a)) { m.u(10); m.u(a.length); for (const x of a) argMix(m, x); return; }
    throw new TypeError('canvas argument the fake page does not know: ' + Object.prototype.toString.call(a));
  }
  function record(cv, op, args) {
    P.ncalls++;
    const m1 = P.calls, m2 = cv.content;
    m1.u(cv.id); m1.u(op); m2.u(op);
    for (let i = 0; i < args.length; i++) { argMix(m1, args[i]); argMix(m2, args[i]); }
    m1.u(0xffffffff); m2.u(0xffffffff);
  }
  function newObj(cv, kind) {
    const ob = { __obj: ++P.nextObj, kind };
    if (kind === 'gradient') ob.addColorStop = function (at, colour) { record(cv, OP_ADD_STOP, [ob.__obj, at, colour]); };
    return ob;
  }
  const special = {
    save() { this.stack.push(this.st.slice()); },
    restore() { if (this.stack.length) this.st = this.stack.pop(); },
    createLinearGradient() { return newObj(this.canvas, 'gradient'); },
    createRadialGradient() { return newObj(this.canvas, 'gradient'); },
    createPattern() { return newObj(this.canvas, 'pattern'); },
    getImageData(x, y, w, h) { return { width: w, height: h, data: new P.U8C(w * h * 4) }; },
    createImageData(w, h) { return { width: w, height: h, data: new P.U8C(w * h * 4) }; },
    measureText(t) { return { width: String(t).length * 6 }; },
    getLineDash() { return []; }
  };
  METHODS.forEach((name, i) => {
    Ctx.prototype[name] = function () {
      record(this.canvas, i, arguments);
      return special[name] ? special[name].apply(this, arguments) : undefined;
    };
  });
  PROP_NAMES.forEach((name, i) => {
    Object.defineProperty(Ctx.prototype, name, {
      get() { return this.st[i]; },
      set(v) { record(this.canvas, 100 + i, [v]); this.st[i] = v; }
    });
  });

  // ---- elements
  class El {
    constructor(tag, label) {
      this.id = ++P.nextEl;
      this.tag = tag;
      this.tagName = tag.toUpperCase();
      this.label = label;
      this.style = {};
      this.className = '';
      this.innerHTML = '';
      this.textContent = '';
      this.onload = null;
      if (tag === 'canvas') { this._w = 300; this._h = 150; this.content = new Mix(); this.ctx = null; }
      if (tag === 'img') { this._src = ''; this.complete = false; this.naturalWidth = 0; this.naturalHeight = 0; }
      P.els.push(this);
    }
    get width() { return this.tag === 'canvas' ? this._w : this.naturalWidth || 0; }
    set width(v) { this.resize('_w', OP_CANVAS_W, v); }
    get height() { return this.tag === 'canvas' ? this._h : this.naturalHeight || 0; }
    set height(v) { this.resize('_h', OP_CANVAS_H, v); }
    resize(k, op, v) {
      if (this.tag !== 'canvas') throw new Error('width/height written on a ' + this.tag);
      record(this, op, [v]);
      this[k] = v >>> 0;
      this.content = new Mix();                      // a size write clears the bitmap and the context state
      this.content.u(this._w); this.content.u(this._h);
      if (this.ctx) { this.ctx.st = PROP_DEFAULTS.slice(); this.ctx.stack = []; }
    }
    getContext(kind) {
      if (kind !== '2d') throw new Error('getContext ' + kind);
      return this.ctx || (this.ctx = new Ctx(this));
    }
    toDataURL() { return 'data:image/png;sl,' + this._w + 'x' + this._h + ',' + this.content.hex() + this.content.a.toString(16); }
    get src() { return this._src; }
    set src(v) {
      this._src = String(v); this.complete = false; this.naturalWidth = this.naturalHeight = 0;
      P.loads.push(this);
    }
    appendChild(c) { return c; }
    removeChild(c) { return c; }
    setAttribute() {}
    addEventListener() {}
    removeEventListener() {}
  }
  function finishLoads() {
    while (P.loads.length) {
      const img = P.loads.shift();
      let w = 0, h = 0;
      const d = /^data:image\/png;sl,(\d+)x(\d+),/.exec(img._src);
      if (d) { w = +d[1]; h = +d[2]; } else if (/hexbg\.jpg$/.test(img._src)) { w = TILE[0]; h = TILE[1]; }
      else throw new Error('image the fake page cannot load: ' + img._src);
      img.complete = true; img.naturalWidth = w; img.naturalHeight = h;
      if (typeof img.onload === 'function') {
        try { img.onload.call(img, { type: 'load', target: img }); } catch (e) { P.errors.push('onload ' + e.message); }
      }
    }
  }

  for (const d of PAGE_ELS) {
    const el = new El(d.tag, d.label);
    Object.assign(el.style, d.style);
    if (d.tag === 'canvas') { if (d.width != null) el._w = d.width; if (d.height != null) el._h = d.height; }
    P.labelled.push(el);
  }
  const byLabel = new Map(P.labelled.map((e) => [e.label, e]));

  // ---- window and document
  const doc = {
    readyState: 'complete', hidden: false, visibilityState: 'visible',
    hasFocus: () => true,
    documentElement: { clientWidth: H.vw, clientHeight: H.vh, style: {} },
    body: new El('body', null),
    querySelector(sel) {
      const m = /^\[data-sl="([^"]+)"\]$/.exec(sel);
      if (!m) throw new Error('querySelector the fake page does not know: ' + sel);
      return byLabel.get(m[1]) || null;
    },
    createElement: (tag) => new El(String(tag).toLowerCase(), null),
    addEventListener(t, f) { (P.docListeners[t] = P.docListeners[t] || []).push(f); },
    removeEventListener(t, f) { P.docListeners[t] = (P.docListeners[t] || []).filter((x) => x !== f); }
  };
  const store = {};
  if (H.ls) for (const kv of String(H.ls).split(',')) { const i = kv.indexOf(':'); if (i > 0) store[kv.slice(0, i)] = kv.slice(i + 1); }
  Object.defineProperties(store, {
    getItem: { value: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null) },
    setItem: { value: (k, v) => { store[String(k)] = String(v); } },
    removeItem: { value: (k) => { delete store[k]; } }
  });
  // instrument.js ?ua=mobile: ' Mobile' before Safari, so is_mobile is true and render_mode is 1 (the line body).
  const ua = H.ua === 'mobile' ? UA.replace(' Safari/', ' Mobile Safari/') : UA;
  const rnd = mulberry32(H.seed);
  const SeededMath = Object.create(Math);
  SeededMath.random = function () { P.rng++; return rnd(); };
  const transport = typeof o.transport === 'function' ? (handlers) => o.transport(P, handlers) : makeTransport;
  const win = {
    document: doc,
    navigator: { userAgent: ua, appVersion: ua.slice(8), platform: 'Win32', language: 'en-US', languages: ['en-US', 'en'], maxTouchPoints: 0 },
    performance: { now: () => P.vnow },
    localStorage: store,
    Math: SeededMath,
    innerWidth: H.vw, innerHeight: H.vh, outerWidth: H.vw, outerHeight: H.vh, devicePixelRatio: 1,
    screen: { width: H.vw, height: H.vh, availWidth: H.vw, availHeight: H.vh },
    location: { href: 'http://localhost/sl.html', protocol: 'http:', host: 'localhost', hostname: 'localhost', pathname: '/sl.html', search: '', hash: '' },
    console: { log() { P.logs++; }, info() { P.logs++; }, warn() { P.logs++; }, error() { P.logs++; }, debug() { P.logs++; } },
    requestAnimationFrame(cb) { P.raf.push(cb); return P.raf.length; },
    cancelAnimationFrame(id) { if (P.raf[id - 1]) P.raf[id - 1] = () => {}; },
    setTimeout(cb, ms) { const id = ++P.tid; P.timers.push({ id, due: P.vnow + (+ms || 0), cb, args: [].slice.call(arguments, 2) }); return id; },
    setInterval(cb, ms) { const id = ++P.tid; P.timers.push({ id, due: P.vnow + (+ms || 0), every: Math.max(1, +ms || 0), cb, args: [].slice.call(arguments, 2) }); return id; },
    clearTimeout(id) { P.timers = P.timers.filter((t) => t.id !== id); },
    clearInterval(id) { P.timers = P.timers.filter((t) => t.id !== id); },
    addEventListener(t, f) { (P.winListeners[t] = P.winListeners[t] || []).push(f); },
    removeEventListener(t, f) { P.winListeners[t] = (P.winListeners[t] || []).filter((x) => x !== f); },
    DuelSlitherConfig: { assetBase: '/', transport }
  };
  if (o.win) Object.assign(win, o.win);
  win.window = win;
  win.self = win;
  vm.createContext(win);
  P.U8 = vm.runInContext('Uint8Array', win);
  P.U8C = vm.runInContext('Uint8ClampedArray', win);
  P.win = win; P.doc = doc; P.El = El; P.Ctx = Ctx;

  // ---- the game socket: harness instrument.js section 5 plus ours-feed.js harnessTransport
  function makeTransport(handlers) {
    let ws = null;   // ours-feed's current socket
    return {
      open() {
        const s = { n: ++P.gameSockets, created: P.frame, state: 0, t0: null };
        P.game = s;
        if (P.created == null) P.created = P.frame;
        while (P.next < P.entries.length && P.entries[P.next][0] < s.n) P.next++;
        ws = s;
        s.onOpen = () => { if (ws === s) handlers.onOpen(); };
        s.onFrame = (events, n) => { if (ws === s) handlers.onFrame(events, n); };
        s.onClose = () => { if (ws === s) handlers.onClose(); };
      },
      send(bundle) {
        const list = P.win.DuelSlither.slWire.decodeInput(bundle);
        for (const e of list) if (e && e.type === 'wire_error') P.inputWireErrors++;
        for (let i = 0; i < list.length; i++) {
          if (!ws) { P.sendsDropped++; continue; }
          if (ws.state === 0) throw new Error('send while the socket is CONNECTING');
          if (ws.state !== 1) { P.sendsDropped++; continue; }
          P.nsends++;
        }
        P.out.u(0x4f000000 ^ P.frame);
        P.out.view(bundle);
      },
      close() {
        const s = ws;
        if (!s) return;
        if (s.state < 2) { P.clientCloses++; s.state = 2; }
        ws = null;
      }
    };
  }
  function socketHook() {
    const s = P.game;
    if (!s) return;
    if (s.state === 0 && s.created < P.frame) { s.state = 1; s.t0 = P.vnow; P.opens.push(P.frame); s.onOpen(); }
    if (s.state !== 1) return;
    while (P.next < P.entries.length && P.entries[P.next][0] === P.gameSockets && s.t0 + P.entries[P.next][1] <= P.vnow + 0.001) {
      const e = P.entries[P.next++];
      if (e[2] < 0) { s.state = 3; P.serverCloses++; s.onClose(); break; }
      P.delivered++;
      const bytes = new P.U8(Buffer.from(e[3], 'hex'));
      s.onFrame(P.win.DuelSlither.slWire.decodeBundle(bytes), e[2]);
    }
  }
  P.socketHook = socketHook;   // a live transport replaces it with its own per-frame part

  // ---- input (harness instrument.js section 7: window handlers, keys on document then window)
  function ev(e) { return Object.assign({ preventDefault() {}, stopPropagation() {} }, e); }
  function dispatchWin(type, e) {
    e.target = e.target || win;
    if (typeof win['on' + type] === 'function') win['on' + type].call(win, e);
    for (const f of (P.winListeners[type] || []).slice()) f.call(win, e);
  }
  function fire(code, a) {
    if (code === 'p') { P.win.DuelSlither.play('Owen'); return; }   // golden.js H8: our Play in the begin hooks
    if (code === 'm' || code === 'd' || code === 'u') {
      const type = code === 'm' ? 'mousemove' : code === 'd' ? 'mousedown' : 'mouseup';
      const x = +a[0], y = +a[1];
      dispatchWin(type, ev({ type, clientX: x, clientY: y, screenX: x, screenY: y, pageX: x, pageY: y, button: +(a[2] || 0), buttons: +(a[3] || 0) }));
      return;
    }
    if (code === 'k' || code === 'K') {
      const type = code === 'k' ? 'keydown' : 'keyup';
      const e = ev({ type, keyCode: +a[0], which: +a[0], key: a[1], code: a[1], target: doc });
      if (typeof doc['on' + type] === 'function') doc['on' + type].call(doc, e);
      for (const f of (P.docListeners[type] || []).slice()) f.call(doc, e);
      dispatchWin(type, e);
      return;
    }
    throw new Error('input code ' + code);
  }
  P.fire = fire;
  function inputHook() {
    while (P.script.length && P.script[0].frame <= P.frame) { const s = P.script.shift(); fire(s.code, s.args); }
  }
  P.resize = function (vw, vh) {
    win.innerWidth = win.outerWidth = vw; win.innerHeight = win.outerHeight = vh;
    doc.documentElement.clientWidth = vw; doc.documentElement.clientHeight = vh;
    dispatchWin('resize', ev({ type: 'resize' }));
  };

  // ---- one frame (harness instrument.js __step)
  function runTimers() {
    for (let guard = 0; guard < 10000; guard++) {
      let best = null;
      for (const t of P.timers) if (t.due <= P.vnow && (!best || t.due < best.due || (t.due === best.due && t.id < best.id))) best = t;
      if (!best) return;
      if (best.every) best.due += best.every; else P.timers = P.timers.filter((t) => t !== best);
      try { best.cb.apply(win, best.args); } catch (e) { P.errors.push('timer ' + e.message); }
    }
  }
  function mult(f) {
    let m = 1;
    for (const s of P.slow) if (f >= s.from && f < s.from + s.count) m = s.mult;
    return m;
  }
  P.step = function () {
    P.vnow += H.step * mult(P.frame + 1);
    P.frame++;
    runTimers();
    const cbs = P.raf; P.raf = [];
    finishLoads();
    inputHook();
    P.socketHook();
    const before = P.ncalls;
    for (const cb of cbs) { try { cb(P.vnow); } catch (e) { P.errors.push('raf ' + e.message); } }
    P.rafCalls += P.ncalls - before;
  };
  P.boot = function () {
    for (const [f, src] of (o.scripts || SRC)) vm.runInContext(src, win, { filename: f });
    finishLoads();
  };
  return P;
}

// Full state walk: every own enumerable key in insertion order, cycles by first-visit index. Elements, contexts,
// gradients and patterns by their id (their content is in the call and DOM hashes); functions by kind only.
function walkState(P, root) {
  const m = new Mix(), seen = new Map();
  const toStr = Object.prototype.toString;
  (function walk(v) {
    switch (typeof v) {
      case 'number': m.u(1); m.num(v); return;
      case 'string': m.u(2); m.str(v); return;
      case 'boolean': m.u(v ? 3 : 4); return;
      case 'undefined': m.u(5); return;
      case 'function': m.u(6); return;
      case 'bigint': case 'symbol': throw new Error('state holds a ' + typeof v);
    }
    if (v === null) { m.u(7); return; }
    const at = seen.get(v);
    if (at !== undefined) { m.u(8); m.u(at); return; }
    seen.set(v, seen.size);
    if (v instanceof P.El) { m.u(9); m.u(v.id); return; }
    if (v instanceof P.Ctx) { m.u(10); m.u(v.canvas.id); return; }
    if (v.__obj) { m.u(11); m.u(v.__obj); return; }
    if (ArrayBuffer.isView(v)) { m.u(12); m.str(toStr.call(v)); m.view(v); return; }
    if (Array.isArray(v)) { m.u(13); m.u(v.length); for (let i = 0; i < v.length; i++) walk(v[i]); return; }
    const tag = toStr.call(v);
    if (tag === '[object Map]') { m.u(14); m.u(v.size); for (const [k, x] of v) { walk(k); walk(x); } return; }
    if (tag === '[object Set]') { m.u(15); m.u(v.size); for (const x of v) walk(x); return; }
    const keys = Object.keys(v);
    m.u(16); m.u(keys.length);
    for (const k of keys) { m.str(k); walk(v[k]); }
  })(root);
  return m.hex();
}

function domHash(P) {
  const m = new Mix();
  for (const el of P.labelled) {
    m.u(el.id); m.str(el.label);
    const ks = Object.keys(el.style);
    m.u(ks.length);
    for (const k of ks) { m.str(k); m.str(String(el.style[k])); }
    m.str(String(el.innerHTML)); m.str(String(el.textContent)); m.str(String(el.className));
    if (el.tag === 'img') { m.str(el._src); m.u(el.complete ? 1 : 0); }
    if (el.tag === 'canvas') { m.u(el._w); m.u(el._h); }
  }
  return m.hex();
}

// ---------------------------------------------------------------------------------------------------- goldens

const NAMES = ['full', 'beh-twolives', 'beh-close', 'beh-arrows', 'beh-resize', 'beh-autoq', 'beh-lowq', 'beh-pong',
  'beh-240hz', 'synth-60hz', 'full-mobile'];
// A golden run on another golden's stream with one page change (the review pass probe rv-mobile, IDENTICAL to theirs).
const VARIANTS = { 'full-mobile': { stream: 'full', ua: 'mobile' } };
const STREAMS_FILE = path.join(__dirname, 'slGoldenStreams.json.gz');
const FRAMES_FILE = path.join(__dirname, 'slGoldenFrames.json.gz');

let streamsCache = null;
function loadStreams() {
  if (!streamsCache) streamsCache = JSON.parse(zlib.gunzipSync(fs.readFileSync(STREAMS_FILE)).toString('utf8'));
  return streamsCache;
}
function loadFrames() {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(FRAMES_FILE)).toString('utf8'));
}

// One golden: boot, warm-up, Play, record. Returns the per-frame hashes and the run totals (the gate's runGolden; opts
// pass to makePage, so a caller can boot extra scripts after the pinned ones).
function runGolden(name, opts) {
  const all = loadStreams();
  const v = VARIANTS[name] || {};
  const g = all.streams[v.stream || name];
  const src = g.same ? all.streams[g.same] : g;
  const H = Object.assign({}, g.harness, v.ua ? { ua: v.ua } : {});
  const P = makePage(H, src.entries, opts);
  const frames = [];
  let chain = new Mix(), totalCalls = 0;
  function endFrame() {
    const D = P.win.DuelSlither;
    const sm = new Mix();
    sm.str(walkState(P, D.S)); sm.str(walkState(P, D.stats));
    sm.u(D.slMain.isPlayLocked() ? 1 : 0); sm.str(D.slMain.nick);
    sm.num(P.vnow); sm.u(P.rng); sm.u(P.timers.length); sm.u(P.raf.length);
    const row = P.calls.hex() + sm.hex() + domHash(P) + P.out.hex();
    totalCalls += P.ncalls;
    P.calls = new Mix(); P.ncalls = 0; P.out = new Mix();
    return row;
  }
  P.boot();
  chain.str(endFrame());                              // frame 0: the boot (sprites, tables, images)
  const toFrame = (f) => { while (P.frame < f) { P.step(); chain.str(endFrame()); } };
  toFrame(H.warm);                                    // golden.js: warm-up frames
  if (H.openFrame - 2 > P.frame) toFrame(H.openFrame - 2);
  P.win.DuelSlither.play('Owen');                     // golden.js oursGolden: Play after frame openFrame - 2
  for (let k = 0; k < 1200 && P.created == null; k++) { P.step(); chain.str(endFrame()); }
  if (P.created == null) throw new Error(name + ': no game socket');
  const pre = chain.hex();
  const base = P.created;                             // golden.js recordPart: frame 1 = the socket-open frame
  P.script = src.input.split(' ').filter(Boolean).map((t) => {
    const p = t.split(',');
    return { frame: +p[0] + base, code: p[1], args: p.slice(2) };
  }).sort((a, b) => a.frame - b.frame);
  P.slow = (H.slow || []).map((s) => ({ from: base + s.from, count: s.count, mult: s.mult }));
  const resizes = (H.resize || []).filter((r) => r.i - 1 > 0 && r.i - 1 < H.frames);
  P.rafCalls = 0;
  while (P.frame < base + H.frames) {
    P.step();
    frames.push(endFrame());
    for (const r of resizes) if (base + r.i - 1 === P.frame) P.resize(r.vw, r.vh);
  }
  const D = P.win.DuelSlither;
  const totals = {
    socketMade: base, opens: P.opens.join(' '), frames: frames.length, calls: totalCalls, rafCalls: P.rafCalls, delivered: P.delivered,
    messages: D.stats.messages, events: D.stats.events, applyThrows: D.stats.applyThrows, wireErrors: D.stats.wireErrors,
    sends: P.nsends, sendsDropped: P.sendsDropped, inputWireErrors: P.inputWireErrors, serverCloses: P.serverCloses,
    clientCloses: P.clientCloses, rng: P.rng, errors: P.errors.length, logs: P.logs, playing: !!D.S.playing
  };
  return { pre, frames, totals, errors: P.errors.slice(0, 5) };
}

// The first differing frame of a run against a cut golden, or null when every frame, the pre chain and the totals
// are identical (the gate's comparison).
const KINDS = ['calls', 'state', 'dom', 'outbound'];
function compareGolden(want, r) {
  const rows = want.frames.match(/.{32}/g);
  for (let i = 0; i < Math.max(rows.length, r.frames.length); i++) {
    if (rows[i] === r.frames[i]) continue;
    const a = rows[i] || '', b = r.frames[i] || '';
    return 'frame ' + (i + 1) + ' differs in ' + KINDS.filter((k, j) => a.substr(8 * j, 8) !== b.substr(8 * j, 8)).join(', ');
  }
  if (r.pre !== want.pre) return 'the frames before the socket opened differ (boot, menu, Play)';
  if (JSON.stringify(r.totals) !== JSON.stringify(want.totals)) return 'the run totals differ';
  return null;
}

module.exports = {
  ROOT, HTML, SCRIPTS, SRC, UA, NAMES, VARIANTS, KINDS,
  blobId, fmix, Mix, mulberry32, makePage, walkState, domHash, loadStreams, loadFrames, runGolden, compareGolden
};
