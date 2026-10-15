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
// out with sz >= 13.6 (byte 67 and the natural 47 below it), and on a paid page slxPaid's canvas draws gold at that
// food's drawn position and at no food under 13.6 (here without slxCoin.js: the plain gold disc; the coin itself is
// test/slxCoin.test.js and the coin test of Part A).
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

// A canvas context that records every call and property write (the gold, the coins' atlas, the labels).
class Ctx {
  constructor(cv) { this.canvas = cv; this.calls = []; this.p = {}; }
  getTransform() { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; }
}
for (const m of ['save', 'restore', 'beginPath', 'arc', 'stroke', 'clearRect', 'setTransform', 'moveTo', 'lineTo',
  'fillText', 'strokeText', 'fillRect', 'drawImage', 'fill', 'rect', 'clip', 'translate', 'scale', 'ellipse',
  'bezierCurveTo', 'quadraticCurveTo', 'closePath']) {
  Ctx.prototype[m] = function () { this.calls.push([m].concat([].slice.call(arguments))); };
}
for (const m of ['createLinearGradient', 'createRadialGradient', 'createConicGradient']) {
  Ctx.prototype[m] = function () { this.calls.push([m]); return { addColorStop() {} }; };
}
for (const k of ['strokeStyle', 'fillStyle', 'lineWidth', 'globalAlpha', 'font', 'textAlign', 'textBaseline', 'lineCap',
  'lineJoin', 'globalCompositeOperation']) {
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

// The cash foods of the gold tests: two cash (one popping in), two under the line, one past foods_c.
function cashFoods(S) {
  S.foods = [
    { id: 4101, xx: 640, yy: 470, sz: 13.6, rx: 640, ry: 470, rad: 1, fr: 1, gfr: 0 },      // byte 68: cash
    { id: 4102, xx: 560, yy: 430, sz: 16.2, rx: 560, ry: 430, rad: 0.5, fr: 0.5, gfr: 13 * Math.PI },   // byte 81, popping in
    { id: 4103, sz: 13.4, rx: 620, ry: 460, rad: 1, fr: 1, gfr: 0 },     // byte 67
    { id: 4104, sz: 10.8, rx: 610, ry: 440, rad: 1, fr: 1, gfr: 0 },     // byte 54, the biggest boost drop
    { id: 4105, sz: 9.4, rx: 600, ry: 430, rad: 1, fr: 1, gfr: 0 },      // byte 47, the biggest natural food
    { id: 4106, sz: 13.6, rx: 99999, ry: 470, rad: 1, fr: 1, gfr: 0 }    // cash far off screen
  ];
  S.foods_c = 5;                                                       // the sixth is past foods_c: not live
}

test('gold: a turning coin (slxCoin.js) on each cash pellet only, centred on its drawn dot, as big as it, faded with it', () => {
  const P = paidPage({ files: LAYER.concat(['slxCoin.js']) });
  assert.strictEqual(P.D.slx.paid.look('coin'), 'coin');
  seat(P, { v: 530000 });
  const S = P.S;
  const coin = P.D.slx.coin;
  assert.ok(coin, 'slx.coin');
  cashFoods(S);
  P.raf(1);
  const cv = cashCanvas(P);
  const calls = lastFrame(cv);
  const imgs = calls.filter((c) => c[0] === 'drawImage');
  assert.strictEqual(imgs.length, 2, 'two coins, nothing under 13.6, nothing off screen');
  assert.strictEqual(calls.filter((c) => c[0] === 'arc' && c[3] > 5).length, 0, 'no plain disc: both coins came from the atlas');
  const k = S.gsc * S.csc;
  const st = coin.stats();
  assert.strictEqual(st.buckets.length, 1, 'the popping-in coin borrows the size of the grown coin, it makes no atlas of its own');
  assert.strictEqual(st.broken, false);
  const bk = st.buckets[0];
  const want = [[sx(S, 640), sy(S, 470), 13.6 * 0.95 * k], [sx(S, 560), sy(S, 430), 16.2 * 0.95 * k * 0.5]];
  imgs.forEach((c, i) => {
    const [, img, , , sw, sh, dx, dy, dw, dh] = c;
    assert.strictEqual(img.tagName, 'CANVAS', 'from the atlas canvas');
    assert.deepStrictEqual([sw, sh], [bk.cell, bk.cell]);
    assert.ok(Math.abs(dx + dw / 2 - want[i][0]) < 1e-9 && Math.abs(dy + dh / 2 - want[i][1]) < 1e-9, 'centred on the dot ' + i);
    assert.ok(Math.abs(dw / sw * bk.br - want[i][2]) < 1e-9, 'coin radius = the dot radius ' + i);
  });
  const alphas = calls.filter((c) => c[0] === 'set globalAlpha').map((c) => c[1]);
  assert.ok(alphas.includes(1) && alphas.includes(0.5), 'faded with their fr');
  // it turns: a quarter turn later every coin shows another atlas cell
  const cells0 = imgs.map((c) => c[2] + ',' + c[3]);
  P.raf(1, coin.SPIN_MS / 4);
  const cells1 = lastFrame(cv).filter((c) => c[0] === 'drawImage').map((c) => c[2] + ',' + c[3]);
  assert.strictEqual(cells1.length, 2);
  assert.ok(cells1.every((c, i) => c !== cells0[i]), 'a new spin frame for each coin');
  assert.notStrictEqual(cells0[0], cells0[1], 'the two coins are not in step');
  assert.strictEqual(P.D.slx.errors, 0);
});

test('gold under snakes: a live body over the coins erases them along its length; a far snake erases nothing; an eaten coin is sucked in', () => {
  const P = paidPage({ files: LAYER.concat(['slxCoin.js']) });
  P.D.slx.paid.look('coin');
  seat(P, { v: 530000 });
  const S = P.S;
  cashFoods(S);
  const near = { id: 21, xx: 660, yy: 470, fx: 0, fy: 0, sc: 1.2, alive_amt: 1, dead_amt: 0.25,
    pts: [{ xx: 600, yy: 470, fx: 0, fy: 0 }, { xx: 630, yy: 472, fx: 0, fy: 0 }] };
  const far = { id: 22, xx: 5000, yy: 5000, fx: 0, fy: 0, sc: 1, alive_amt: 1, dead_amt: 0, pts: [{ xx: 5040, yy: 5000 }] };
  S.slithers = [near, far];
  P.raf(1);
  const cv = cashCanvas(P);
  const k = S.gsc * S.csc;
  let calls = lastFrame(cv);
  const cut = calls.findIndex((c) => c[0] === 'set globalCompositeOperation' && c[1] === 'destination-out');
  assert.ok(cut > calls.findIndex((c) => c[0] === 'drawImage'), 'the coins first, then the cut');
  const after = calls.slice(cut);
  assert.deepStrictEqual(after.filter((c) => c[0] === 'moveTo').map((c) => c.slice(1)), [[sx(S, 660), sy(S, 470)]], 'only the near snake, from its head');
  assert.deepStrictEqual(after.filter((c) => c[0] === 'lineTo').map((c) => c.slice(1)),
    [[sx(S, 630), sy(S, 472)], [sx(S, 600), sy(S, 470)]], 'down its body to the tail');
  assert.ok(after.some((c) => c[0] === 'set lineWidth' && Math.abs(c[1] - 29 * 1.2 * k) < 1e-9), 'as wide as the body');
  assert.ok(after.some((c) => c[0] === 'set globalAlpha' && c[1] === 0.75), 'faded as the body is');
  assert.ok(after.some((c) => c[0] === 'stroke'));
  // nobody near the money: no cut
  S.slithers = [far];
  P.raf(1);
  calls = lastFrame(cv);
  assert.ok(!calls.some((c) => c[0] === 'set globalCompositeOperation' && c[1] === 'destination-out'), 'no cut with no body near');
  // eaten: the coin goes with their dot into the mouth, as big as their shrinking rad, not faded (the head hides it)
  S.slithers = [];
  S.foods[0].eaten = true;
  S.foods[0].eaten_fr = 0.5;
  S.foods[0].rad = 0.4;
  P.raf(1);
  calls = lastFrame(cv);
  const eaten = calls.filter((c) => c[0] === 'drawImage');
  assert.strictEqual(eaten.length, 2, 'the eaten coin is still drawn');
  assert.ok(Math.abs(eaten[0][8] / eaten[0][4] * coinBr(P) - 13.6 * 0.95 * S.gsc * S.csc * 0.4) < 1e-9, 'shrunk with rad');
  assert.ok(calls.filter((c) => c[0] === 'set globalAlpha').every((c) => c[1] === 1 || c[1] === 0.5), 'not faded beyond fr');
  assert.strictEqual(P.D.slx.errors, 0);
});

test('gold: their own pellet under a coin goes blank (same sprite sizes), nothing else of any food changes', () => {
  const P = paidPage({ files: LAYER.concat(['slxCoin.js']) });
  P.D.slx.paid.look('coin');
  seat(P, { v: 530000 });
  const S = P.S;
  const sprite = (side) => { const c = P.doc.createElement('canvas'); c.width = side; c.height = side; c.tag = 'theirs'; return c; };
  const tiers = () => ({ fi: sprite(12), fw: 12, ofi: sprite(31), ofw: 31, gfi: sprite(102), gfw: 102, g2fi: sprite(157), g2fw: 157 });
  const cash = Object.assign({ id: 4201, xx: 640, yy: 470, sz: 13.6, rx: 640, ry: 470, rad: 1, fr: 0.7, gfr: 3, cv: 5 }, tiers());
  const food = Object.assign({ id: 4202, xx: 600, yy: 430, sz: 9.4, rx: 600, ry: 430, rad: 1, fr: 1, gfr: 3, cv: 5 }, tiers());
  const before = JSON.stringify([cash, food], (k, v) => (/fi$/.test(k) ? undefined : v));
  const keep = { fi: food.fi, ofi: food.ofi, gfi: food.gfi, g2fi: food.g2fi };
  S.foods = [cash, food];
  S.foods_c = 2;
  P.raf(1);
  for (const [img, side] of [['fi', 12], ['ofi', 31], ['gfi', 102], ['g2fi', 157]]) {
    assert.strictEqual(cash[img].tagName, 'CANVAS');
    assert.notStrictEqual(cash[img].tag, 'theirs', img + ' swapped');
    assert.deepStrictEqual([cash[img].width, cash[img].height], [side, side], img + ' keeps its size');
    assert.strictEqual(food[img], keep[img], 'a normal food keeps its ' + img);
  }
  assert.strictEqual(JSON.stringify([cash, food], (k, v) => (/fi$/.test(k) ? undefined : v)), before,
    'position, size, fade, shimmer and colour untouched');
  assert.strictEqual(cash.fi.getContext('2d').calls.length, 0, 'the blank is never drawn on');
  // once only: the next frames keep the same blanks
  const blanks = [cash.fi, cash.ofi, cash.gfi, cash.g2fi];
  P.raf(3);
  assert.deepStrictEqual([cash.fi, cash.ofi, cash.gfi, cash.g2fi], blanks);
  assert.strictEqual(P.D.slx.errors, 0);
});

// The bucket radius of the one coin atlas (for coin sizes).
function coinBr(P) { return P.D.slx.coin.stats().buckets[0].br; }

test('gold look (the default): their pellet turns gold (same sprites sizes, their shadow), breathes, and a switch to the coin and back is clean', () => {
  const P = paidPage({ files: LAYER.concat(['slxCoin.js']) });
  assert.strictEqual(P.D.slx.paid.look(), 'gold');
  seat(P, { v: 530000 });
  const S = P.S;
  const sprite = (side) => { const c = P.doc.createElement('canvas'); c.width = side; c.height = side; c.tag = 'theirs'; return c; };
  // their recipe's sizes at cv2 5 (step 7.8), gcv 6 (8.8) and g2cv 12 (14.8)
  const tiers = () => ({ cv2: 5, gcv: 6, g2cv: 12, fi: sprite(11), fw: 11, ofi: sprite(33), ofw: 33, gfi: sprite(77), gfw: 77,
    g2fi: sprite(125), g2fw: 125 });
  const cash = Object.assign({ id: 4301, xx: 640, yy: 470, sz: 13.6, rx: 640, ry: 470, rad: 1, fr: 1, gfr: 3, cv: 5 }, tiers());
  const food = Object.assign({ id: 4302, xx: 600, yy: 430, sz: 9.4, rx: 600, ry: 430, rad: 1, fr: 1, gfr: 3, cv: 5 }, tiers());
  const before = JSON.stringify([cash, food], (k, v) => (/fi$/.test(k) ? undefined : v));
  const theirs = { fi: cash.fi, ofi: cash.ofi, gfi: cash.gfi, g2fi: cash.g2fi };
  const keep = { fi: food.fi, ofi: food.ofi, gfi: food.gfi, g2fi: food.g2fi };
  S.foods = [cash, food];
  S.foods_c = 2;
  P.raf(1);
  for (const [img, side] of [['fi', 11], ['gfi', 77], ['g2fi', 125]]) {
    assert.notStrictEqual(cash[img], theirs[img], img + ' is gold now');
    assert.strictEqual(cash[img].width, side, img + ' keeps its size');
    assert.ok(cash[img].ctx.calls.some((c) => c[0] === 'createRadialGradient'), img + ' painted with their gradient');
    assert.ok(cash[img].ctx.calls.some((c) => c[0] === 'set fillStyle'), img);
  }
  assert.strictEqual(cash.ofi, theirs.ofi, 'their shadow (black whatever the colour)');
  for (const k of ['fi', 'ofi', 'gfi', 'g2fi']) assert.strictEqual(food[k], keep[k], 'a normal food keeps its ' + k);
  assert.strictEqual(JSON.stringify([cash, food], (k, v) => (/fi$/.test(k) ? undefined : v)), before, 'nothing else changes');
  const cv = cashCanvas(P);
  assert.strictEqual(P.D.slx.coin.stats().made, 0, 'no coin in the gold look');
  // the breath: at rest nothing is added; at the top a bigger, lighter core and both glows over it
  const ph = (() => { let v = cash.id | 0; v = Math.imul(v ^ (v >>> 16), 0x45d9f3b); v = Math.imul(v ^ (v >>> 16), 0x45d9f3b); return ((v ^ (v >>> 16)) >>> 0) / 4294967296; })();
  const at = (b) => { const u = Math.acos(1 - 2 * b) / (2 * Math.PI); return ((u - ph) % 1 + 1) % 1 * 1200; };
  const base = Math.ceil(P.clock.now / 1200) * 1200 + 2400;
  P.raf(1, base + at(0) - P.clock.now);
  assert.strictEqual(lastFrame(cv).filter((c) => c[0] === 'drawImage').length, 0, 'at rest: their gold pellet alone');
  P.raf(1, base + 1200 + at(1) - P.clock.now);
  const top = lastFrame(cv).filter((c) => c[0] === 'drawImage');
  assert.strictEqual(top.length, 3, 'core and two glows');
  assert.strictEqual(top[0][1], cash.fi, 'the gold core');
  assert.ok(Math.abs(top[0][4] - 11 * 1.2 * S.csc) < 1e-6, 'a fifth bigger at the top of the breath');
  assert.strictEqual(top[1][1], cash.gfi);
  assert.strictEqual(top[2][1], cash.g2fi);
  assert.ok(lastFrame(cv).some((c) => c[0] === 'set globalCompositeOperation' && c[1] === 'lighter'));
  // to the coin: all four blank, their shadow too; back to gold: their shadow again
  P.D.slx.paid.look('coin');
  P.raf(1);
  for (const k of ['fi', 'ofi', 'gfi', 'g2fi']) assert.notStrictEqual(cash[k].tag, 'theirs', k + ' blank');
  assert.strictEqual(cash.ofi.width, 33);
  P.D.slx.paid.look('gold');
  P.raf(1);
  assert.strictEqual(cash.ofi, theirs.ofi, 'their shadow is back');
  assert.strictEqual(cash.fi.width, 11);
  assert.strictEqual(P.D.slx.paid.look('nonsense'), 'gold', 'only the two looks');
  assert.strictEqual(P.D.slx.errors, 0);
});

test('gold without the coin file: a plain gold disc only for sz >= 13.6, at the food\'s drawn position, faded with it; labels over paid heads', () => {
  const P = paidPage();
  P.D.slx.paid.look('coin');
  seat(P, { v: 530000 });
  const S = P.S;
  P.sock().fire('sl:f', [{ type: 'snake_add', id: 7, xx: 700, yy: 380, sc: 1.5 }, { type: 'snake_add', id: 9, xx: 520, yy: 420 }]);
  P.sock().fire('sl:x', [{ t: 'w', id: 7, v: 1250000 }]);
  cashFoods(S);
  P.raf(1);
  const cv = cashCanvas(P);
  assert.ok(cv, 'the slx-cash canvas');
  assert.deepStrictEqual([cv.style.position, cv.style.zIndex, cv.style.pointerEvents], ['fixed', '6', 'none']);
  const calls = lastFrame(cv);
  const arcs = calls.filter((c) => c[0] === 'arc');
  assert.strictEqual(arcs.length, 2, 'two cash pellets drawn, nothing under 13.6');
  const k = S.gsc * S.csc;
  assert.deepStrictEqual(arcs.map((a) => [a[1], a[2]]), [[sx(S, 640), sy(S, 470)], [sx(S, 560), sy(S, 430)]]);
  assert.ok(Math.abs(arcs[0][3] - 13.6 * 0.95 * k) < 1e-9, 'covers the drawn dot');
  assert.ok(Math.abs(arcs[1][3] - 16.2 * 0.95 * k * 0.5) < 1e-9, 'scaled by their pop-in rad');
  assert.ok(calls.some((c) => c[0] === 'set fillStyle' && c[1] === GOLD), 'gold #FFD700');
  assert.strictEqual(calls.filter((c) => c[0] === 'drawImage').length, 0, 'no coin without slxCoin.js');
  const alphas = calls.filter((c) => c[0] === 'set globalAlpha').map((c) => c[1]);
  assert.ok(alphas.includes(0.5) && alphas.includes(1), 'faded with their fr');
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

test('frozen client + slxPaid: the gold sits on the cash food\'s drawn position, on no food under 13.6', () => {
  const r = runGold(Object.assign({}, LAUNCH), [[68, 40, -30], [67, -60, 20], [47, 30, 50]]);
  assert.deepStrictEqual(r.socks[0].opts.auth, { paid: 1, stake: 0.5, entryToken: TOKEN });
  assert.strictEqual(r.store.getItem('entryToken'), null);
  const cv = r.P.els.find((e) => e.className === 'slx-cash');
  assert.ok(cv, 'the slx-cash canvas on a paid page');
  // the gold look (the default): their pellet in gold, their shadow, every other food its own
  for (let i = 0; i < 30; i++) r.P.step();
  {
    const S0 = r.D.S;
    const g68 = foodById(S0, r.injected[0]);
    const own = (fo) => S0.per_color_imgs[fo.cv];
    for (const [img, list, w] of [['fi', 'imgs', 'fw'], ['gfi', 'gimgs', 'gfw'], ['g2fi', 'gimgs', 'g2fw']]) {
      assert.ok(!own(g68)[list].includes(g68[img]), 'gold ' + img);
      assert.strictEqual(g68[img].width, g68[w], 'gold ' + img + ' of their size');
    }
    assert.ok(own(g68).oimgs.includes(g68.ofi), 'their shadow');
    for (const ev of r.injected.slice(1)) {
      const fo = foodById(S0, ev);
      for (const [img, list] of [['fi', 'imgs'], ['ofi', 'oimgs'], ['gfi', 'gimgs'], ['g2fi', 'gimgs']]) {
        assert.ok(own(fo)[list].includes(fo[img]), 'sz ' + fo.sz + ' keeps its own ' + img);
      }
    }
  }
  // the coin look (here without slxCoin.js: the plain disc)
  r.D.slx.paid.look('coin');
  const arcs = [];
  const c = cv.getContext('2d');
  const arc0 = c.arc;
  c.arc = function (x, y, rr) { arcs.push({ frame: r.P.frame, x, y, r: rr, style: c.fillStyle }); return arc0.apply(this, arguments); };
  for (let i = 0; i < 30; i++) r.P.step();
  const S = r.D.S;
  const k = S.gsc * S.csc;
  const last = arcs.filter((a) => a.frame === r.P.frame);
  const f68 = foodById(S, r.injected[0]);
  assert.ok(f68, 'the cash food is held');
  const want = { x: Math.floor(S.ww / 2 - S.mww / 2) + S.mww / 2 + (f68.rx - S.view_xx) * k,
    y: Math.floor(S.hh / 2 - S.mhh / 2) + S.mhh / 2 + (f68.ry - S.view_yy) * k };
  const mine = last.filter((a) => Math.abs(a.x - want.x) < 1e-6 && Math.abs(a.y - want.y) < 1e-6);
  assert.strictEqual(mine.length, 1, 'one gold disc on the cash food');
  assert.strictEqual(mine[0].style, GOLD);
  assert.ok(Math.abs(mine[0].r - 13.6 * 0.95 * k * f68.rad) < 1e-9);
  // all the gold of the frame is on foods at or over 13.6 that their client holds
  const cash = [];
  for (let i = 0; i < S.foods_c; i++) if (S.foods[i].sz >= 13.6) cash.push(S.foods[i]);
  for (const a of last) {
    assert.ok(cash.some((f) => Math.abs(a.x - (Math.floor(S.ww / 2 - S.mww / 2) + S.mww / 2 + (f.rx - S.view_xx) * k)) < 1e-6),
      'gold with no cash food under it at ' + a.x);
  }
  for (const ev of r.injected.slice(1)) {
    const f = foodById(S, ev);
    const x = Math.floor(S.ww / 2 - S.mww / 2) + S.mww / 2 + (f.rx - S.view_xx) * k;
    assert.ok(!last.some((a) => Math.abs(a.x - x) < 1e-6), 'no gold on sz ' + f.sz);
  }
  // their own pellet under the gold draws nothing: its four sprites are blanks of their sizes; the others keep theirs
  const set = (fo) => S.per_color_imgs[fo.cv];
  for (const [img, list, w] of [['fi', 'imgs', 'fw'], ['ofi', 'oimgs', 'ofw'], ['gfi', 'gimgs', 'gfw'], ['g2fi', 'gimgs', 'g2fw']]) {
    assert.ok(!set(f68)[list].includes(f68[img]), 'the cash food\'s ' + img + ' is not one of their sprites');
    assert.strictEqual(f68[img].width, f68[w], img + ' keeps its size');
    for (const ev of r.injected.slice(1)) {
      const fo = foodById(S, ev);
      assert.ok(set(fo)[list].includes(fo[img]), 'sz ' + fo.sz + ' keeps its own ' + img);
    }
  }
  assert.deepStrictEqual(r.P.errors, []);
  assert.strictEqual(r.D.slx.errors, 0);
});
