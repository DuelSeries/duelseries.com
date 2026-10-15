'use strict';
// slxPaidPage: the paid snake page on the new engine (PAID-SL-DESIGN.md 9, 11.1 slxPaidPage; task T6). The ACTIVE layer
// is proven on fake pages of its own (SERVER-DESIGN 15.6 item 6), never on the gate's, where it stays inert
// (test/slxNoTouch.test.js runs the whole tail, slxPaid.js included, against the goldens).
//
// Part A runs the REAL slxNet, slxPaid, slxMain, slxCard and slxSound, in the composed page's order, on the HUD fake
// page (test/slxHudFakes.js) with a fake socket.io and a small fake of their client (their Play opens a transport the
// way public/js/sl/slNet.js makeSocketIoTransport does). It checks: the token leaves sessionStorage at boot and is
// never in the URL, the DOM, a post or a fetch; it rides in the first handshake only and resume sockets say paid and
// stake alone; a page with no nonce is the free page and makes nothing; gold only on a paid page and only for sz >=
// 13.6; the $ labels, the HUD line and the +$ pop with the money chime; every card; the exit trap; Play again through
// duel:restake with its nonce rules; the reload mark.
//
// Part B is the vm check of the gold rule through the FROZEN client (test/slVmPage.js, the gate's page): a food_add
// made by slFood.drop(..., 68, ...) (the C_PAID_CASH_BYTE) is encoded on our wire, applied by their slApply, and comes
// out with sz >= 13.6 (byte 67 and the natural 47 below it), and on a paid page slxPaid's canvas draws a gold glint
// at that food's drawn position and at no food under 13.6.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { makePage, ROOT } = require('./slxHudFakes.js');

const SLX_DIR = path.join(ROOT, 'public', 'js', 'slx');
const LAYER = ['slxNet.js', 'slxPaid.js', 'slxMain.js', 'slxCard.js', 'slxSound.js'];
const plain = (x) => JSON.parse(JSON.stringify(x));
const TOKEN = 'tok-' + 'a1b2c3d4e5f6'.repeat(4);   // 52 chars, under the door's FIELD_MAX 64
const KEY = '0b5e8c1a-2f3d-4a5b-8c6d-7e8f9a0b1c2d';
const KEY2 = '1c6f9d2b-3a4e-4b6c-9d7e-8f9a0b1c2d3e';
const CID = '3f2a1b0c-9d8e-4f7a-8b6c-5d4e3f2a1b0c';
const ORIGIN = 'https://duelseries.com';
const LAUNCH = { slPaidLaunch: 'launch-nonce-1', entryToken: TOKEN, entrySol: '0.5', stake: '0.5', playerName: 'Owen' };
const GOLD = '#FFD700';

function storeOf(init) {
  const m = Object.assign({}, init || {});
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null),
    setItem: (k, v) => { m[String(k)] = String(v); },
    removeItem: (k) => { delete m[k]; },
    dump: () => Object.assign({}, m)
  };
}

// A canvas context that records every call and property write (the gold, the labels).
class Ctx {
  constructor(cv) { this.canvas = cv; this.calls = []; this.p = {}; }
}
for (const m of ['save', 'restore', 'beginPath', 'arc', 'stroke', 'clearRect', 'setTransform', 'moveTo', 'lineTo',
  'fillText', 'strokeText', 'fillRect', 'drawImage']) {
  Ctx.prototype[m] = function () { this.calls.push([m].concat([].slice.call(arguments))); };
}
for (const k of ['strokeStyle', 'fillStyle', 'lineWidth', 'globalAlpha', 'font', 'textAlign', 'textBaseline']) {
  Object.defineProperty(Ctx.prototype, k, {
    get() { return this.p[k]; },
    set(v) { this.calls.push(['set ' + k, v]); this.p[k] = v; }
  });
}

// o: { session, local, S, direct (no lobby frame), files, fetchState }
function paidPage(o) {
  const opts = o || {};
  const session = storeOf(opts.session === undefined ? LAUNCH : opts.session);
  const posts = [];
  const parent = { postMessage: (m, origin) => posts.push([plain(m), origin]) };
  const socks = [];
  const fetches = [];
  const net = { closes: 0, state: opts.fetchState || 'pending', fail: false };
  function fakeIo(uri, ioOpts) {
    const s = { n: socks.length + 1, uri, opts: plain(ioOpts || {}), l: {}, emits: [], connected: false };
    s.on = (name, fn) => { (s.l[name] = s.l[name] || []).push(fn); return s; };
    s.fire = (name, d) => { for (const fn of (s.l[name] || []).slice()) fn(d); };
    s.emit = (name, d) => { s.emits.push([name, plain(d === undefined ? null : d)]); };
    s.disconnect = () => { if (!s.connected) return; s.connected = false; s.fire('disconnect', 'io client disconnect'); };
    s.connect = () => { s.connected = true; s.fire('connect'); };
    s.drop = (reason) => { s.connected = false; s.fire('disconnect', reason || 'transport close'); };
    socks.push(s);
    return s;
  }
  function fakeFetch(url, init) {
    fetches.push([String(url), plain(init || {})]);
    if (net.fail) return Promise.reject(new Error('offline'));
    const state = net.state;
    return Promise.resolve(state === 404 ? { ok: false, status: 404, json: () => Promise.resolve({ error: 'Not found' }) }
      : { ok: true, status: 200, json: () => Promise.resolve({ state }) });
  }
  const P = makePage({
    S: Object.assign({ ww: 1000, hh: 800, mww: 1000, mhh: 800, csc: 1, gsc: 0.9, view_xx: 500, view_yy: 400,
      dead_mtm: -1, slithers: [], foods: [], foods_c: 0 }, opts.S || {}),
    framed: !opts.direct,
    win: {
      sessionStorage: session,
      localStorage: storeOf(opts.local || {}),
      parent: opts.direct ? undefined : parent,
      frameElement: opts.direct ? null : { id: 'game-frame' },
      io: fakeIo,
      fetch: fakeFetch,
      CashoutSound: { play() {} },
      location: { origin: ORIGIN, href: ORIGIN + '/sl', search: '', hash: '', assigned: [], assign(u) { this.assigned.push(String(u)); } },
      innerWidth: 1000,
      innerHeight: 800,
      devicePixelRatio: 1
    }
  });
  if (opts.direct) P.win.parent = P.win;
  P.El.prototype.getContext = function (k) {
    if (k !== '2d') throw new Error('getContext ' + k);
    return this.ctx || (this.ctx = new Ctx(this));
  };
  // their client, as far as the layer meets it: Play opens a transport the frozen way (slNet.js:133-186)
  const D = P.D;
  const S = P.S;
  delete D.slx;                                  // the real slxNet makes it
  const hooks = { onMenuShow() {}, onMenuFade() {}, onMenuDone() {} };
  D.slLoop = { hooks };
  D.slMain = { nick: '' };
  D.slWire = { decodeInput: () => [], decodeBundle: () => [], encodeInput: () => new Uint8Array(0) };
  D.slNet = {
    makeSocketIoTransport(h) {
      let sock = null;
      let opened = false;
      let closed = false;
      const closeOnce = () => { if (closed) return; closed = true; h.onClose(); };
      return {
        open() {
          const me = P.win.io('/sl', { forceNew: true, reconnection: false });
          sock = me;
          me.on('connect', () => { if (sock !== me || opened || closed) return; opened = true; h.onOpen(); });
          me.on('connect_error', () => { if (sock === me) closeOnce(); });
          me.on('sl:f', (events) => { if (sock === me) h.onFrame(events, 0); });
          me.on('disconnect', () => { if (sock === me) closeOnce(); });
        },
        join(nick) { if (sock && sock.connected) sock.emit('sl:join', { nick }); },
        send() {},
        close() { const me = sock; sock = null; if (me) { if (me.connected) me.emit('sl:leave'); me.disconnect(); } }
      };
    }
  };
  const plays = [];
  D.play = function (nick) {
    plays.push(nick);
    D.slMain.nick = nick == null ? '' : String(nick);
    let t = null;
    const h = {
      onOpen() { t.join(D.slMain.nick); },
      onFrame(events) {
        for (const ev of events) {
          if (ev.type === 'snake_add' && ev.own) {
            // their init (slApply onInit) then the own snake: playing from here
            S.playing = true;
            S.connected = true;
            S.dead_mtm = -1;
            S.slither = { id: ev.id, xx: ev.xx, yy: ev.yy, fx: 0, fy: 0, sc: ev.sc || 1 };
            S.slithers.push(S.slither);
          } else if (ev.type === 'snake_add') {
            S.slithers.push({ id: ev.id, xx: ev.xx, yy: ev.yy, fx: 0, fy: 0, sc: ev.sc || 1 });
          } else if (ev.type === 'dead') {
            S.dead_mtm = 1;
          }
        }
      },
      onClose() { net.closes++; S.connected = false; S.playing = false; }
    };
    t = P.win.DuelSlitherConfig.transport(h);
    t.open();
  };
  for (const f of opts.files || LAYER) P.load(f);
  return Object.assign(P, { session, posts, parent, socks, fetches, net, plays, hooks, sock: () => socks[socks.length - 1] });
}

// A seated paid life on the newest socket: connect, the server's seat, room and worths, the own snake.
function seat(P, o) {
  const opts = o || {};
  const s = P.sock();
  s.connect();
  s.fire('sl:x', [{ t: 'seat', k: KEY, ms: 5000 }, { t: 'room', stake: opts.stake || 0.5, cut: 10 },
    { t: 'w', id: 5, v: opts.v === undefined ? 500000 : opts.v }]);
  s.fire('sl:f', [{ type: 'snake_add', own: true, id: 5, xx: 600, yy: 450 }]);
  return s;
}

function message(P, data, over) {
  const e = Object.assign({ data, source: P.parent, origin: ORIGIN }, over || {});
  for (const l of P.win.listeners.slice()) if (l.type === 'message') l.fn(e);
}
function windowEvent(P, type, init) {
  const e = Object.assign({ type, defaultPrevented: false, returnValue: undefined, preventDefault() { this.defaultPrevented = true; } }, init || {});
  for (const l of P.win.listeners.slice()) if (l.type === type) l.fn(e);
  return e;
}
const flush = () => new Promise((r) => setImmediate(r));

// Every string the page put anywhere a user, a URL or a log could see it.
function visible(P) {
  const out = [];
  const walk = (n) => {
    if (!n) return;
    if (n.nodeType === 3) { out.push(n.data); return; }
    out.push(n.className || '', JSON.stringify(n.attrs || {}), JSON.stringify(n.style || {}), String(n.value || ''),
      String(n.innerHTML || ''));
    for (const c of n.childNodes || []) walk(c);
  };
  walk(P.doc.head);
  walk(P.doc.body);
  out.push(JSON.stringify(P.win.location), JSON.stringify(P.posts), JSON.stringify(P.fetches));
  return out.join('\n');
}

function cashCanvas(P) {
  return P.find('slx-cash')[0] || null;
}
// The calls of the last drawn frame on the slx-cash canvas (from its last clearRect).
function lastFrame(cv) {
  const c = cv.ctx.calls;
  let at = -1;
  for (let i = c.length - 1; i >= 0; i--) if (c[i][0] === 'clearRect') { at = i; break; }
  return c.slice(at);
}
const sx = (S, wx) => Math.floor(S.ww / 2 - S.mww / 2) + S.mww / 2 + (wx - S.view_xx) * S.gsc * S.csc;
const sy = (S, wy) => Math.floor(S.hh / 2 - S.mhh / 2) + S.mhh / 2 + (wy - S.view_yy) * S.gsc * S.csc;

// ---------------------------------------------------------------------------------------------------------------
// Part A

test('boot: the four hand-off keys leave sessionStorage at once; the token is in no URL, DOM, post or fetch', async () => {
  const P = paidPage();
  assert.deepStrictEqual(plain(P.session.dump()), { playerName: 'Owen' }, 'slPaidLaunch, entryToken, entrySol, stake gone');
  assert.deepStrictEqual(P.plays, ['Owen'], 'the lobby frame plays the paid page at once');
  assert.strictEqual(P.socks.length, 1);
  assert.deepStrictEqual(P.socks[0].opts.auth, { paid: 1, stake: 0.5, entryToken: TOKEN }, 'the token rides the first handshake');
  assert.strictEqual(P.socks[0].uri, '/sl');
  seat(P);
  P.socks[0].fire('sl:x', [{ t: 'w', id: 5, v: 530000, d: 30000 }]);
  P.raf(3);
  P.socks[0].fire('sl:x', [{ t: 'cashed', len: 40, gross: 530000, cut: 53000, net: 477000, cid: CID }]);
  P.socks[0].fire('sl:f', [{ type: 'dead' }]);
  P.hooks.onMenuShow();
  P.raf(2, 1000);
  await flush();
  windowEvent(P, 'pagehide');
  assert.ok(P.fetches.length > 0, 'the status was asked for');
  const seen = visible(P);
  assert.ok(seen.includes('$0.53'), 'the page did draw its text');
  assert.ok(!seen.includes(TOKEN), 'the token is nowhere visible');
  assert.ok(!JSON.stringify(P.session.dump()).includes(TOKEN), 'never written back to storage');
  assert.ok(!JSON.stringify(P.D.slx.paid.state()).includes(TOKEN), 'the state accessor never holds it');
  for (const s of P.socks) assert.ok(!JSON.stringify(s.emits).includes(TOKEN), 'never in a socket message');
});

test('the handshake: the token goes once, with the socket that opens; a failed connect keeps it; a resume says paid and stake only', () => {
  const P = paidPage({ local: { 'duel.sl.skin': '12' } });
  const first = P.sock();
  assert.deepStrictEqual(first.opts.auth, { cv: 12, paid: 1, stake: 0.5, entryToken: TOKEN }, 'merged with the skin cv');
  first.fire('connect_error', { message: 'xhr poll error' });
  assert.strictEqual(P.D.slx.paid.state().hasToken, true, 'a socket that never opened did not spend it');
  assert.strictEqual(P.D.slx.paid.state().locked, false, 'no join went out: nothing to hold');
  const card = P.D.slx.card.state();
  assert.strictEqual(card.title, 'Connection lost');
  assert.strictEqual(card.again, 'Try again', 'the card\'s own retry sends the unspent token');
  P.D.slx.card.playAgain();
  assert.strictEqual(P.posts.length, 0, 'no buy-in for a token still unspent');
  assert.deepStrictEqual(P.sock().opts.auth, { cv: 12, paid: 1, stake: 0.5, entryToken: TOKEN });
  const s = seat(P);
  assert.deepStrictEqual(s.emits[0], ['sl:join', { nick: 'Owen' }], 'their sl:join, with no money field');
  assert.strictEqual(P.D.slx.paid.state().hasToken, false, 'dropped the moment its socket opened');
  // a blip: slxNet resumes on a new socket through the same handshake
  s.drop('transport close');
  assert.strictEqual(P.socks.length, 3, 'the resume attempt');
  assert.deepStrictEqual(P.sock().opts.auth, { cv: 12, paid: 1, stake: 0.5 }, 'paid and stake only, never the token');
  assert.deepStrictEqual(P.sock().opts.forceNew, true);
  assert.strictEqual(P.D.slx.paid.state().locked, true, 'money still in while the resume runs');
  P.sock().connect();
  assert.deepStrictEqual(P.sock().emits[0], ['sl:back', { k: KEY, n: 1, p: 0 }]);
  P.sock().fire('sl:x', [{ t: 'back', k: KEY2, ms: 5000 }]);
  P.raf(1, DROP + 100);
  assert.strictEqual(P.D.slx.paid.state().locked, true, 'resumed in time: the trap holds past DROP_MS');
  assert.strictEqual(P.D.slx.paid.state().dropped, false);
  P.sock().fire('sl:x', [{ t: 'room', stake: 0.5, cut: 10 }, { t: 'w', id: 5, v: 500000 }]);   // the resume's own items
  assert.strictEqual(P.D.slx.paid.state().locked, true);
});
const DROP = 5000;

test('no nonce: the free page; a stale token and stake are never sent, slxPaid makes nothing', () => {
  const stale = { entryToken: TOKEN, entrySol: '1', stake: '1', playerName: 'Owen' };
  const base = paidPage({ session: stale, files: ['slxNet.js'] });
  const before = { body: base.doc.body.childNodes.length, head: base.doc.head.childNodes.length,
    win: base.win.listeners.length, doc: base.doc.listeners.length, raf: base.rafCount() };
  base.load('slxPaid.js');
  assert.deepStrictEqual({ body: base.doc.body.childNodes.length, head: base.doc.head.childNodes.length,
    win: base.win.listeners.length, doc: base.doc.listeners.length, raf: base.rafCount() }, before, 'no node, listener or frame');
  assert.strictEqual(base.D.slx.paid.on, false);
  assert.strictEqual(base.D.slx.paidHold(), false);
  assert.strictEqual(base.D.slx.paidAuth(), null);
  assert.strictEqual(base.D.slx.cardLines, undefined);
  assert.strictEqual(base.D.slx.beforeAgain, undefined);
  assert.strictEqual(base.D.slx.beforeLobby, undefined);
  const P = paidPage({ session: stale });
  assert.deepStrictEqual(P.plays, ['Owen'], 'plays free at once');
  assert.deepStrictEqual(P.sock().opts.auth, {}, 'a free handshake');
  assert.deepStrictEqual(plain(P.session.dump()), stale, 'the lobby\'s keys left as they were');
  assert.strictEqual(cashCanvas(P), null, 'no gold canvas');
  assert.strictEqual(P.find('slx-paid-hud').length, 0);
  P.sock().connect();
  P.S.foods = [{ sz: 13.6, rx: 600, ry: 450, rad: 1, fr: 1, gfr: 0 }];
  P.S.foods_c = 1;
  P.raf(3);
  assert.strictEqual(cashCanvas(P), null, 'a cash-sized food draws no gold on a free page');
  windowEvent(P, 'pagehide');
  assert.strictEqual(P.session.getItem('slxPaidCut'), null, 'no reload mark from a free page');
});

test('gold: a glint only for sz >= 13.6, at the food\'s drawn position, faded with it; labels over paid heads', () => {
  const P = paidPage();
  seat(P, { v: 530000 });
  const S = P.S;
  P.sock().fire('sl:f', [{ type: 'snake_add', id: 7, xx: 700, yy: 380, sc: 1.5 }, { type: 'snake_add', id: 9, xx: 520, yy: 420 }]);
  P.sock().fire('sl:x', [{ t: 'w', id: 7, v: 1250000 }]);
  S.foods = [
    { sz: 13.6, rx: 640, ry: 470, rad: 1, fr: 1, gfr: 0 },           // byte 68: cash
    { sz: 16.2, rx: 560, ry: 430, rad: 0.5, fr: 0.5, gfr: 13 * Math.PI },   // byte 81, popping in
    { sz: 13.4, rx: 620, ry: 460, rad: 1, fr: 1, gfr: 0 },           // byte 67
    { sz: 10.8, rx: 610, ry: 440, rad: 1, fr: 1, gfr: 0 },           // byte 54, the biggest boost drop
    { sz: 9.4, rx: 600, ry: 430, rad: 1, fr: 1, gfr: 0 },            // byte 47, the biggest natural food
    { sz: 13.6, rx: 99999, ry: 470, rad: 1, fr: 1, gfr: 0 }          // cash far off screen
  ];
  S.foods_c = 5;                                                       // the sixth is past foods_c: not live
  P.raf(1);
  const cv = cashCanvas(P);
  assert.ok(cv, 'the slx-cash canvas');
  assert.deepStrictEqual([cv.style.position, cv.style.zIndex, cv.style.pointerEvents], ['fixed', '6', 'none']);
  const calls = lastFrame(cv);
  const arcs = calls.filter((c) => c[0] === 'arc');
  assert.strictEqual(arcs.length, 2, 'two cash pellets drawn, nothing under 13.6');
  const k = S.gsc * S.csc;
  assert.deepStrictEqual(arcs.map((a) => [a[1], a[2]]), [[sx(S, 640), sy(S, 470)], [sx(S, 560), sy(S, 430)]]);
  assert.ok(Math.abs(arcs[0][3] - 13.6 * 0.95 * k) < 1e-9, 'rings the drawn dot');
  assert.ok(Math.abs(arcs[1][3] - 16.2 * 0.95 * k * 0.5) < 1e-9, 'scaled by their pop-in rad');
  assert.ok(calls.some((c) => c[0] === 'set strokeStyle' && c[1] === GOLD), 'gold #FFD700');
  const alphas = calls.filter((c) => c[0] === 'set globalAlpha').map((c) => c[1]);
  assert.ok(alphas.includes(0.5 * (0.55 + 0.45 * (0.5 + 0.5 * Math.cos(Math.PI)))), 'faded with fr and their shimmer');
  // labels: own and the other paid head, none for a snake with no worth
  const texts = calls.filter((c) => c[0] === 'fillText');
  assert.deepStrictEqual(texts.map((c) => c[1]), ['$0.53', '$1.25']);
  assert.strictEqual(texts[0][2], sx(S, 600));
  assert.strictEqual(texts[0][3], sy(S, 450) - 14.5 * 1 * k - 10, 'above the own head');
  assert.ok(calls.some((c) => c[0] === 'set fillStyle' && c[1] === '#14F195'));
  // the HUD line
  const [hud] = P.find('slx-paid-hud');
  assert.strictEqual(hud.textContent, 'Your snake $0.53, hold Q to cash out');
  assert.strictEqual(hud.style.display, 'block');
  // nothing drawn once nothing is there
  S.foods_c = 0;
  S.slithers = [];
  P.raf(1);
  assert.strictEqual(lastFrame(cv).filter((c) => c[0] === 'arc' || c[0] === 'fillText').length, 0);
});

test('worth: d > 0 on the own worth pops +$ over the head and plays the money chime; the HUD follows', () => {
  const P = paidPage();
  seat(P);
  assert.strictEqual(P.D.slx.sound.money(), 0);
  P.sock().fire('sl:x', [{ t: 'w', id: 5, v: 500580, d: 580 }]);
  P.sock().fire('sl:x', [{ t: 'w', id: 5, v: 510580, d: 10000 }]);
  P.sock().fire('sl:x', [{ t: 'w', id: 7, v: 900000 }]);   // another snake: no d
  assert.strictEqual(P.D.slx.sound.money(), 2, 'one chime per own gain');
  assert.deepStrictEqual(plain(P.D.slx.sound.played()), { join: 1, death: 0, kill: 0, cashout: 0 }, 'played() keeps its shape');
  P.raf(1);
  const texts = lastFrame(cashCanvas(P)).filter((c) => c[0] === 'fillText').map((c) => c[1]);
  assert.deepStrictEqual(texts, ['$0.51', '+$0.0005', '+$0.01'], 'the label, then the pops (cents floored, never rounded up)');
  assert.strictEqual(P.find('slx-paid-hud')[0].textContent, 'Your snake $0.51, hold Q to cash out');
  P.raf(60);
  assert.deepStrictEqual(lastFrame(cashCanvas(P)).filter((c) => c[0] === 'fillText').map((c) => c[1]), ['$0.51'], 'pops gone after 900 ms');
  // a phone says the hold button's word
  const M = paidPage({ S: { is_mobile: true } });
  seat(M);
  M.raf(1);
  assert.strictEqual(M.find('slx-paid-hud')[0].textContent, 'Your snake $0.50, hold CASH OUT to cash out');
  // dead: the HUD goes
  P.sock().fire('sl:x', [{ t: 'lost', v: 510580 }]);
  P.sock().fire('sl:f', [{ type: 'dead' }]);
  P.raf(1);
  assert.strictEqual(P.find('slx-paid-hud')[0].style.display, 'none');
});

test('cards: lost, closed, refused (with and without a refund), a drop with money in, a join cut off', () => {
  const L = paidPage();
  seat(L, { v: 530000 });
  L.sock().fire('sl:x', [{ t: 'lost', v: 530000 }]);
  L.sock().fire('sl:f', [{ type: 'dead' }]);
  L.hooks.onMenuShow();
  let st = L.D.slx.card.state();
  assert.deepStrictEqual([st.kind, st.title, st.again, st.againShown], ['dead', 'Match Results', 'Play again $0.50', true]);
  assert.deepStrictEqual(plain(st.lines), ['Your $0.53 dropped as gold for the other snakes.']);

  const C = paidPage();
  seat(C);
  C.sock().fire('sl:x', [{ t: 'closed', why: 'shutdown', refunded: 512000 }]);
  C.sock().drop('io server disconnect');
  C.hooks.onMenuShow();
  st = C.D.slx.card.state();
  assert.deepStrictEqual([st.title, st.againShown], ['Restarting', false]);
  assert.deepStrictEqual(plain(st.lines), ['DuelSeries is restarting, so your paid snake was closed.',
    'Your $0.51 goes back to your wallet in full, no house cut.']);
  assert.strictEqual(C.D.slx.paid.state().locked, false, 'closed: the trap lets go at once');

  for (const [why, refunded, title, lines] of [
    ['not-open', 500000, 'Not open', ['Paid snake rooms are not open right now.', 'Your $0.50 entry was refunded to your wallet.']],
    ['one-seat', 1000000, 'Already playing', ['This wallet already has a paid snake in a room.', 'Your $1.00 entry was refunded to your wallet.']],
    ['full', 0, 'Rooms full', ['Every paid snake room at this stake is full.',
      'An entry that was never used goes back to your wallet automatically within a few minutes.']],
    ['settled', 0, 'Already refunded', ['This entry was already refunded.']],
    ['brand-new', 0, 'Not seated', ['The room did not let you in.']]
  ]) {
    const R = paidPage();
    const s = R.sock();
    s.connect();
    s.fire('sl:x', [{ t: 'refused', why, refunded }]);
    s.drop('io server disconnect');
    st = R.D.slx.card.state();
    assert.deepStrictEqual([st.title, plain(st.lines), st.againShown], [title, lines, false], why);
    assert.strictEqual(R.D.slx.paid.state().locked, false, why + ': unlocked');
    R.D.slx.card.toLobby();
    assert.deepStrictEqual(R.posts, [['game:done', ORIGIN]], why + ': Lobby goes back');
  }

  const X = paidPage();
  seat(X, { v: 640000 });
  X.sock().drop('transport close');           // a resume starts and never connects
  X.raf(30, 250);
  X.hooks.onMenuShow();
  st = X.D.slx.card.state();
  assert.strictEqual(st.title, 'Connection lost');
  assert.deepStrictEqual(plain(st.lines), ['The connection dropped. Your snake glided on for 3 seconds, then its $0.64 dropped as ' +
    'gold unless the page came back in time.', 'If DuelSeries was restarting at that moment, it goes back to your ' +
    'wallet in full instead.'], 'a restart that caught the resume refunded it: the card does not claim gold (CLIENT-3)');
  assert.strictEqual(st.again, 'Play again $0.50');

  const J = paidPage();
  J.sock().connect();
  J.sock().drop('transport close');           // no key yet: their close at once
  st = J.D.slx.card.state();
  assert.deepStrictEqual(plain(st.lines), ['The connection dropped while you were joining.', 'If your entry never ' +
    'reached a room, it is refunded automatically. If it did, your snake was left like any lost connection: after 3 ' +
    'seconds its money dropped as gold.'], 'a seat whose first message never came holds money: no promised refund (CLIENT-3)');
});

test('cashed: gross, the house 10%, you receive, then GET /api/sl/cashout/:cid every 2 s until sent', async () => {
  const P = paidPage({ fetchState: 'pending' });
  seat(P, { v: 530000 });
  P.sock().fire('sl:x', [{ t: 'cashed', len: 40, gross: 530000, cut: 53000, net: 477000, cid: CID }]);
  P.sock().fire('sl:f', [{ type: 'dead' }]);
  assert.strictEqual(P.D.slx.paid.state().locked, false, 'cashed: unlocked');
  P.hooks.onMenuShow();
  let st = P.D.slx.card.state();
  assert.deepStrictEqual([st.title, st.again], ['Cashed Out', 'Play again $0.50']);
  assert.deepStrictEqual(plain(st.lines), ['Cash-out: $0.53', 'House 10%: $0.05', 'You receive: $0.47', 'Sending to your wallet...']);
  const notes = P.find('slx-card-note');
  assert.deepStrictEqual(notes.map((n) => n.className), ['slx-card-note', 'slx-card-note', 'slx-card-note slx-paid-take',
    'slx-card-note slx-paid-status']);
  assert.strictEqual(P.fetches.length, 0, 'the first ask waits POLL_MS');
  P.raf(1, 2000);
  await flush();
  assert.deepStrictEqual(P.fetches.map((f) => f[0]), ['/api/sl/cashout/' + CID]);
  assert.deepStrictEqual(P.fetches[0][1], { cache: 'no-store', credentials: 'same-origin' });
  P.raf(1, 2000);
  await flush();
  assert.strictEqual(P.fetches.length, 2, 'pending: asked again 2 s later');
  P.net.state = 'sent';
  P.raf(1, 2000);
  await flush();
  st = P.D.slx.card.state();
  assert.strictEqual(plain(st.lines)[3], 'Sent to your wallet.');
  P.raf(5, 2000);
  await flush();
  assert.strictEqual(P.fetches.length, 3, 'stops once sent');
  // delayed is final too; a status that never settles stops at 60 s
  const Q = paidPage({ fetchState: 'delayed' });
  seat(Q);
  Q.sock().fire('sl:x', [{ t: 'cashed', len: 9, gross: 500000, cut: 50000, net: 450000, cid: CID }]);
  Q.raf(1, 2000);
  await flush();
  assert.strictEqual(Q.D.slx.paid.state().status, 'delayed');
  const R = paidPage({ fetchState: 404 });
  seat(R);
  R.sock().fire('sl:x', [{ t: 'cashed', len: 9, gross: 500000, cut: 50000, net: 450000, cid: CID }]);
  for (let i = 0; i < 40; i++) { R.raf(1, 2000); await flush(); }
  assert.strictEqual(R.D.slx.paid.state().status, 'slow');
  assert.ok(R.fetches.length >= 29 && R.fetches.length <= 31, 'about 30 asks in 60 s: ' + R.fetches.length);
  // a cid that is not a lowercase uuid never goes into the path, and a cash-out with no order says so
  const B = paidPage();
  seat(B);
  B.sock().fire('sl:x', [{ t: 'cashed', len: 9, gross: 500000, cut: 50000, net: 450000, cid: '../admin' }]);
  B.raf(5, 2000);
  await flush();
  assert.strictEqual(B.fetches.length, 0);
  const N = paidPage();
  seat(N);
  N.sock().fire('sl:x', [{ t: 'cashed', len: 9 }]);
  N.sock().fire('sl:f', [{ type: 'dead' }]);
  N.hooks.onMenuShow();
  assert.deepStrictEqual(plain(N.D.slx.card.state().lines), ['Your cash-out is being checked. It reaches your wallet once confirmed.']);
  assert.strictEqual(N.D.slx.sound.played().cashout, 1);
});

test('exit trap: Lobby refused and beforeunload set while money is in; free again on lost, or 5 s after a drop', () => {
  const P = paidPage();
  P.sock().connect();
  assert.strictEqual(P.D.slx.paid.state().locked, true, 'the token went out: a join is in flight');
  P.D.slx.card.toLobby();
  assert.strictEqual(P.find('slx-paid-note')[0].textContent, 'Your seat is being set up. Try again in a moment.');
  P.sock().fire('sl:x', [{ t: 'room', stake: 0.5, cut: 10 }]);
  P.D.slx.card.toLobby();
  assert.deepStrictEqual(P.posts, [], 'no game:done while money is in');
  const [note] = P.find('slx-paid-note');
  assert.strictEqual(note.textContent, 'Hold Q to cash out first');
  assert.strictEqual(note.style.display, 'block');
  assert.deepStrictEqual(P.win.location.assigned, [], 'and no fallback to the lobby page either');
  const e = windowEvent(P, 'beforeunload');
  assert.strictEqual(e.defaultPrevented, true);
  assert.strictEqual(e.returnValue, '');
  P.raf(1, 3100);
  assert.strictEqual(note.style.display, 'none', 'the note goes after 3 s');
  P.sock().fire('sl:x', [{ t: 'lost', v: 500000 }]);
  assert.strictEqual(windowEvent(P, 'beforeunload').defaultPrevented, false);
  P.D.slx.card.toLobby();
  assert.deepStrictEqual(P.posts, [['game:done', ORIGIN]]);
  // a drop with no back: held for DROP_MS, then free
  const Q = paidPage({ S: { is_mobile: true } });
  seat(Q);
  Q.sock().drop('transport close');
  Q.D.slx.card.toLobby();
  assert.strictEqual(Q.find('slx-paid-note')[0].textContent, 'Your snake is still in the room. Try again in a few seconds.');
  Q.raf(1, 4900);
  assert.strictEqual(Q.D.slx.paid.state().locked, true);
  Q.raf(1, 200);
  assert.deepStrictEqual([Q.D.slx.paid.state().locked, Q.D.slx.paid.state().dropped], [false, true]);
  Q.D.slx.card.toLobby();
  assert.deepStrictEqual(Q.posts, [['game:done', ORIGIN]]);
  // a phone is told the button's word
  const M = paidPage({ S: { is_mobile: true } });
  seat(M);
  M.D.slx.card.toLobby();
  assert.strictEqual(M.find('slx-paid-note')[0].textContent, 'Hold CASH OUT to cash out first');
});

test('Play again: duel:restake with a fresh nonce; only the parent, this origin and that nonce answer; the new token plays', () => {
  const P = paidPage();
  seat(P);
  P.sock().fire('sl:x', [{ t: 'lost', v: 500000 }]);
  P.sock().fire('sl:f', [{ type: 'dead' }]);
  P.hooks.onMenuShow();
  P.D.slx.card.playAgain();
  assert.strictEqual(P.posts.length, 1);
  const [msg, origin] = P.posts[0];
  assert.deepStrictEqual(Object.keys(msg).sort(), ['engine', 'game', 'nonce', 'stake', 'type']);
  assert.deepStrictEqual([msg.type, msg.game, msg.engine, msg.stake, origin], ['duel:restake', 'snake', 'sl', 0.5, ORIGIN]);
  assert.ok(typeof msg.nonce === 'string' && msg.nonce.length >= 2);
  let st = P.D.slx.card.state();
  assert.deepStrictEqual([st.again, st.againDisabled], ['Confirm in your wallet...', true]);
  assert.strictEqual(P.D.slx.paid.state().locked, true, 'the Lobby waits for the wallet');
  P.D.slx.card.toLobby();
  assert.strictEqual(P.find('slx-paid-note')[0].textContent, 'Finish the stake in your wallet first');
  P.D.slx.card.playAgain();
  assert.strictEqual(P.posts.length, 1, 'one buy-in at a time');
  const NEW = 'new-token-xyz';
  message(P, { type: 'duel:restake:done', entryToken: NEW, nonce: msg.nonce }, { source: P.win });
  message(P, { type: 'duel:restake:done', entryToken: NEW, nonce: msg.nonce }, { origin: 'https://evil.example' });
  message(P, { type: 'duel:restake:done', entryToken: NEW, nonce: 'other' });
  message(P, { type: 'duel:restake:done', entryToken: NEW });
  message(P, { type: 'duel:restake:done', entryToken: 'x'.repeat(65), nonce: msg.nonce });
  assert.deepStrictEqual(P.plays, ['Owen'], 'none of those is the answer');
  message(P, { type: 'duel:restake:done', entryToken: NEW, nonce: msg.nonce });
  assert.deepStrictEqual(P.plays, ['Owen', 'Owen'], 'the round starts under the same name');
  assert.strictEqual(P.D.slx.card.state().again, 'Starting');
  assert.deepStrictEqual(P.sock().opts.auth, { paid: 1, stake: 0.5, entryToken: NEW });
  message(P, { type: 'duel:restake:done', entryToken: 'again', nonce: msg.nonce });
  assert.strictEqual(P.plays.length, 2, 'a second answer to a spent nonce does nothing');
  assert.ok(!visible(P).includes(NEW), 'the new token is nowhere visible either');
  // an error answer: back to Play again with the wallet's words
  const E = paidPage();
  seat(E);
  E.sock().fire('sl:x', [{ t: 'lost', v: 500000 }]);
  E.sock().fire('sl:f', [{ type: 'dead' }]);
  E.hooks.onMenuShow();
  E.D.slx.card.playAgain();
  message(E, { type: 'duel:restake:error', message: 'User rejected the request.', nonce: E.posts[0][0].nonce });
  st = E.D.slx.card.state();
  assert.deepStrictEqual([st.again, st.againDisabled], ['Play again $0.50', false]);
  assert.deepStrictEqual(plain(st.lines), ['Your $0.50 dropped as gold for the other snakes.', 'User rejected the request.']);
  assert.strictEqual(E.D.slx.paid.state().locked, false);
  // no answer for 2 minutes: the way back opens, a late answer still starts the round
  const W = paidPage();
  seat(W);
  W.sock().fire('sl:x', [{ t: 'lost', v: 500000 }]);
  W.sock().fire('sl:f', [{ type: 'dead' }]);
  W.hooks.onMenuShow();
  W.D.slx.card.playAgain();
  W.raf(1, 120000);
  st = W.D.slx.card.state();
  assert.deepStrictEqual([st.again, st.againDisabled, W.D.slx.paid.state().locked], ['Waiting for your wallet...', true, false]);
  message(W, { type: 'duel:restake:done', entryToken: NEW, nonce: W.posts[0][0].nonce });
  assert.strictEqual(W.plays.length, 2);
  // a page outside the lobby frame has no wallet to ask
  const O = paidPage({ direct: true });
  O.D.play('Solo');
  seat(O);
  O.sock().fire('sl:x', [{ t: 'lost', v: 500000 }]);
  O.sock().fire('sl:f', [{ type: 'dead' }]);
  O.hooks.onMenuShow();
  st = O.D.slx.card.state();
  assert.strictEqual(st.againShown, false);
  assert.deepStrictEqual(plain(st.lines), ['Your $0.50 dropped as gold for the other snakes.', 'Buy a new entry in the lobby to play again.']);
});

test('reload mark: pagehide with money in writes slxPaidCut; the reloaded page shows the notice and never plays free', () => {
  const P = paidPage();
  seat(P);
  windowEvent(P, 'pagehide');
  assert.strictEqual(P.session.getItem('slxPaidCut'), '1');
  windowEvent(P, 'pageshow', { persisted: true });
  assert.strictEqual(P.session.getItem('slxPaidCut'), null, 'back from the back/forward cache: alive, no mark');
  windowEvent(P, 'pagehide');
  // the reload: no nonce, the mark
  const R = paidPage({ session: { slxPaidCut: '1', playerName: 'Owen' } });
  assert.deepStrictEqual(R.plays, [], 'no free auto Play');
  assert.deepStrictEqual(plain(R.session.dump()), { playerName: 'Owen' }, 'the mark is taken out');
  assert.strictEqual(R.D.slx.paidHold(), true);
  assert.strictEqual(R.D.slx.card.state().kind, '', 'the notice waits for every layer file');
  R.raf(1);
  const st = R.D.slx.card.state();
  assert.deepStrictEqual([st.kind, st.title, st.againShown, st.opacity], ['paid', 'Paid snake left', false, '1']);
  assert.deepStrictEqual(plain(st.lines), ['Your paid snake was left when the page closed.', 'Like any lost connection, it ' +
    'glided for 3 seconds, then its money dropped as gold. If it never reached a room, your entry is refunded automatically.']);
  assert.strictEqual(cashCanvas(R), null, 'nothing paid is drawn');
  R.D.slx.card.toLobby();
  assert.deepStrictEqual(R.posts, [['game:done', ORIGIN]]);
  // a page closed before its token went out says so
  const T = paidPage();
  T.sock().fire('connect_error', {});
  windowEvent(T, 'pagehide');
  assert.strictEqual(T.session.getItem('slxPaidCut'), '2');
  const U = paidPage({ session: { slxPaidCut: '2' } });
  U.raf(1);
  assert.deepStrictEqual([U.D.slx.card.state().title, U.D.slx.card.state().lines[0]], ['Paid game not started',
    'The page closed before your paid game started.']);
  // after the life ended, nothing to mark
  const V2 = paidPage();
  seat(V2);
  V2.sock().fire('sl:x', [{ t: 'cashed', len: 9, gross: 500000, cut: 50000, net: 450000, cid: CID }]);
  windowEvent(V2, 'pagehide');
  assert.strictEqual(V2.session.getItem('slxPaidCut'), null);
  // a paid launch wins over a stale mark; a launch it cannot read holds the page
  const W = paidPage({ session: Object.assign({ slxPaidCut: '1' }, LAUNCH) });
  assert.deepStrictEqual(W.plays, ['Owen']);
  assert.strictEqual(W.session.getItem('slxPaidCut'), null);
  const B = paidPage({ session: { slPaidLaunch: 'n', entryToken: TOKEN, stake: '2', playerName: 'Owen' } });
  B.raf(1);
  assert.deepStrictEqual(B.plays, []);
  assert.deepStrictEqual([B.D.slx.card.state().title, B.D.slx.card.state().lines[0]], ['Paid game not started',
    'This paid game could not start.']);
  assert.deepStrictEqual(plain(B.session.dump()), { playerName: 'Owen' });
});

test('surfaces: the free card is unchanged with slxPaid loaded (no hook answers), and slxPaid stays out of storage', () => {
  const P = paidPage({ session: { playerName: 'Owen' } });
  P.sock().connect();
  P.sock().fire('sl:f', [{ type: 'snake_add', own: true, id: 3, xx: 1, yy: 1 }, { type: 'dead' }]);
  P.S.lastscore.innerHTML = '<span>Your final length was </span><b>12</b>';
  P.hooks.onMenuShow();
  const st = P.D.slx.card.state();
  assert.deepStrictEqual([st.title, st.length, st.again, st.againShown, plain(st.lines)], ['Match Results', '12', 'Play again', true, []]);
  assert.strictEqual(P.find('slx-card-notes').length, 0, 'no lines box on a free card');
  assert.strictEqual(P.D.slx.card.element.textContent, 'Match ResultsYour final length was 12Play againLobby');
  const src = fs.readFileSync(path.join(SLX_DIR, 'slxPaid.js'), 'utf8');
  assert.ok(!/localStorage/.test(src.replace(/\/\/.*$/gm, '')), 'slxPaid never touches localStorage');
  assert.ok(!src.includes(String.fromCharCode(0x2014)), 'no em dash');
});

// ---------------------------------------------------------------------------------------------------------------
// Part B: the gold rule through the frozen client

const V = require('./slVmPage.js');
const slWire = require('../shared/slWire.js');
const { createSim } = require('../server/sl/slSim');
const { FIXTURE } = require('./slLawsFixture');
const B_LAYER = ['slxNet.js', 'slxPaid.js', 'slxMain.js'];

// The food_add slFood makes for a drop of rad byte b (the paid death drop is C_PAID_CASH_BYTE 68).
function dropEvent(b) {
  const sim = createSim(FIXTURE, { seed: 3, border: true, food: true, fill: false });
  const C = FIXTURE.L1.value;
  const f = sim.food.drop(C, C, b, 4);
  return Object.assign({}, sim.food.addEvent(f));
}

// The 'full' golden stream on the frozen client with the layer, on a fake socket.io; at entry `at` of socket 1 the
// server's paid items and a bundle with the given foods (placed around the camera) are put in.
function runGold(session, foods) {
  const all = V.loadStreams();
  const g = all.streams.full;
  const H = g.harness;
  const socks = [];
  let P = null;
  function fakeIo(uri, ioOpts) {
    const s = { n: socks.length + 1, uri, opts: plain(ioOpts || {}), created: P.frame, state: 0, t0: 0, l: {}, connected: false, emits: [], next: 0 };
    s.on = (n, fn) => { (s.l[n] = s.l[n] || []).push(fn); return s; };
    s.fire = (n, d) => { for (const fn of (s.l[n] || []).slice()) fn(d); };
    s.emit = (n, d) => { s.emits.push([n, d]); };
    s.disconnect = () => { if (s.state >= 2) return; s.state = 2; s.connected = false; s.fire('disconnect', 'io client disconnect'); };
    socks.push(s);
    return s;
  }
  const store = storeOf(session);
  P = V.makePage(H, g.entries, {
    scripts: V.SRC.concat(B_LAYER.map((f) => [f, fs.readFileSync(path.join(SLX_DIR, f), 'utf8')])),
    win: { io: fakeIo, sessionStorage: store, DuelSlitherConfig: { assetBase: '/' } }
  });
  const injected = [];
  const AT = 40;
  P.socketHook = function () {
    const s = socks[socks.length - 1];
    if (!s) return;
    if (s.state === 0 && s.created < P.frame) { s.state = 1; s.connected = true; s.t0 = P.vnow; s.fire('connect'); }
    if (s.state !== 1) return;
    const mine = g.entries.filter((e) => e[0] === s.n);
    while (s.next < mine.length && s.t0 + mine[s.next][1] <= P.vnow + 0.001) {
      const at = s.next++;
      const e = mine[at];
      if (s.n === 1 && at === AT) {
        const DS = P.win.DuelSlither.S;
        s.fire('sl:x', [{ t: 'room', stake: 0.5, cut: 10 }, { t: 'w', id: DS.slither.id, v: 500000 }]);
        const pv = DS.protocol_version;
        assert.ok(pv >= 14, 'the sector food form');
        const ss = DS.sector_size;
        const evs = foods.map(([b, dx, dy]) => {
          const x = DS.view_xx + dx;
          const y = DS.view_yy + dy;
          const ev = dropEvent(b);
          const fsx = Math.floor(x / ss);
          const fsy = Math.floor(y / ss);
          return Object.assign(ev, { sx: fsx, sy: fsy, rx: Math.round((x - fsx * ss) / DS.ssd256), ry: Math.round((y - fsy * ss) / DS.ssd256) });
        });
        for (const ev of evs) injected.push(ev);
        s.fire('sl:f', new P.U8(slWire.encodeBundle(evs, pv)));
      }
      if (e[2] < 0) { s.state = 3; s.connected = false; s.fire('disconnect', 'transport close'); break; }
      s.fire('sl:f', new P.U8(Buffer.from(e[3], 'hex')));
    }
  };
  P.boot();
  const D = P.win.DuelSlither;
  assert.strictEqual(D.slx.active, true);
  while (P.frame < H.warm) P.step();
  D.play('Owen');
  // their loop connects once their start fade ended; run to a few frames past the injected bundle
  const end = P.frame + H.frames;
  while (P.frame < end && !(socks[0] && socks[0].next > AT + 1)) P.step();
  assert.ok(socks[0] && socks[0].next > AT + 1, 'the stream reached the injected bundle');
  return { P, D, socks, injected, store };
}

function foodById(S, ev) {
  const id = ev.sx << 24 | ev.sy << 16 | ev.rx << 8 | ev.ry;
  for (let i = 0; i < S.foods_c; i++) if (S.foods[i].id === id) return S.foods[i];
  return null;
}

test('frozen slApply: a food_add of slFood.drop(..., 68, ...) arrives with sz >= 13.6; 67 and the natural 47 below it', () => {
  const ev68 = dropEvent(FIXTURE.C_PAID_CASH_BYTE.value);
  assert.strictEqual(FIXTURE.C_PAID_CASH_BYTE.value, 68);
  assert.strictEqual(ev68.rad, 13.6, 'their rad byte / 5, carried exact by our wire');
  assert.deepStrictEqual(plain(slWire.decodeBundle(slWire.encodeBundle([ev68], 15))), [plain(ev68)]);
  const r = runGold({ playerName: 'Owen' }, [[68, 40, -30], [67, -60, 20], [47, 30, 50]]);
  for (let i = 0; i < 5; i++) r.P.step();
  const S = r.D.S;
  const [f68, f67, f47] = r.injected.map((ev) => foodById(S, ev));
  assert.ok(f68 && f67 && f47, 'their client holds the three foods');
  assert.strictEqual(f68.sz, 13.6);
  assert.ok(f68.sz >= 13.6, 'cash: at the gold threshold');
  assert.ok(f67.sz < 13.6 && f47.sz < 13.6);
  assert.deepStrictEqual(r.P.errors, []);
  assert.strictEqual(r.P.els.filter((e) => e.className === 'slx-cash').length, 0, 'a free page has no gold canvas');
  assert.deepStrictEqual(r.socks[0].opts.auth, {}, 'and a free handshake');
});

test('frozen client + slxPaid: the gold glint sits on the cash food\'s drawn position, on no food under 13.6', () => {
  const r = runGold(Object.assign({}, LAUNCH), [[68, 40, -30], [67, -60, 20], [47, 30, 50]]);
  assert.deepStrictEqual(r.socks[0].opts.auth, { paid: 1, stake: 0.5, entryToken: TOKEN });
  assert.strictEqual(r.store.getItem('entryToken'), null);
  const cv = r.P.els.find((e) => e.className === 'slx-cash');
  assert.ok(cv, 'the slx-cash canvas on a paid page');
  const arcs = [];
  const c = cv.getContext('2d');
  const arc0 = c.arc;
  c.arc = function (x, y, rr) { arcs.push({ frame: r.P.frame, x, y, r: rr, style: c.strokeStyle }); return arc0.apply(this, arguments); };
  for (let i = 0; i < 30; i++) r.P.step();
  const S = r.D.S;
  const k = S.gsc * S.csc;
  const last = arcs.filter((a) => a.frame === r.P.frame);
  const f68 = foodById(S, r.injected[0]);
  assert.ok(f68, 'the cash food is held');
  const want = { x: Math.floor(S.ww / 2 - S.mww / 2) + S.mww / 2 + (f68.rx - S.view_xx) * k,
    y: Math.floor(S.hh / 2 - S.mhh / 2) + S.mhh / 2 + (f68.ry - S.view_yy) * k };
  const mine = last.filter((a) => Math.abs(a.x - want.x) < 1e-6 && Math.abs(a.y - want.y) < 1e-6);
  assert.strictEqual(mine.length, 1, 'one glint on the cash food');
  assert.strictEqual(mine[0].style, GOLD);
  assert.ok(Math.abs(mine[0].r - 13.6 * 0.95 * k * f68.rad) < 1e-9);
  // every glint of the frame is on a food at or over 13.6 that their client holds
  const cash = [];
  for (let i = 0; i < S.foods_c; i++) if (S.foods[i].sz >= 13.6) cash.push(S.foods[i]);
  for (const a of last) {
    assert.ok(cash.some((f) => Math.abs(a.x - (Math.floor(S.ww / 2 - S.mww / 2) + S.mww / 2 + (f.rx - S.view_xx) * k)) < 1e-6),
      'a glint with no cash food under it at ' + a.x);
  }
  for (const ev of r.injected.slice(1)) {
    const f = foodById(S, ev);
    const x = Math.floor(S.ww / 2 - S.mww / 2) + S.mww / 2 + (f.rx - S.view_xx) * k;
    assert.ok(!last.some((a) => Math.abs(a.x - x) < 1e-6), 'no glint on sz ' + f.sz);
  }
  assert.deepStrictEqual(r.P.errors, []);
  assert.strictEqual(r.D.slx.errors, 0);
});
