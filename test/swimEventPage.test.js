'use strict';
/* The Swim Race page (public/js/swim/swimEventMain.js), booted under node with a stand-in DOM, a fake socket and
   a no-op road (the WebGL scene is not loaded), and driven by the server's own messages:

   - the Events tab's Join (seJoin) joins on the first connect only: after Leave, a reconnect must not put the car
     back in the lobby (it used to, every time the connection blipped);
   - a racer put out while their connection was down (the 5 s ran out) gets the knockout card on reconnect, the
     se:ko it missed, instead of a frozen car with the pads still up until the race ends;
   - the owner bar shows on a device with no owner cookie (Owen's phone) when the lobby's wallet is the owner's, and
     to nobody else; a press there asks the lobby's wallet to sign. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const S = require('../shared/swimSim');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public/swimrace.html'), 'utf8');

function makeEl(id, tag) {
  const listeners = {};
  const classes = new Set();
  const el = {
    id, tagName: String(tag || 'div').toUpperCase(), hidden: false, disabled: false, className: '', innerHTML: '',
    textContent: '', style: {}, children: [], offsetWidth: 0,
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c),
      toggle: (c, on) => { const v = on === undefined ? !classes.has(c) : !!on; if (v) classes.add(c); else classes.delete(c); return v; },
    },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    fire(type, ev) { for (const fn of listeners[type] || []) fn(ev || { cancelable: false, preventDefault() {} }); },
    append(...kids) { el.children.push(...kids); },
    prepend(...kids) { el.children.unshift(...kids); },
    remove() {},
    get lastChild() { return el.children[el.children.length - 1] || null; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    setPointerCapture() {},
  };
  return el;
}

/* One page: its socket's handlers, what it emitted, its timers (run only when asked), the result card's calls. */
function boot(session, opts) {
  opts = opts || {};
  const els = new Map();
  const handlers = {};
  const emitted = [];
  const timers = [];
  const intervals = [];
  const shown = [];
  const socket = {
    connected: false,
    on(ev, fn) { handlers[ev] = fn; },
    emit(ev, p) { emitted.push({ ev, p }); },
    volatile: { emit() {} },
  };
  const store = (init) => { const m = new Map(Object.entries(init || {})); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
  /* Hidden at first where the page's markup says so (the owner bar, the pads, the banner). */
  const startHidden = new Set([...HTML.matchAll(/<[^>]*\bid="([^"]+)"[^>]*\shidden[\s>]/g)].map(m => m[1]));
  const document = {
    body: makeEl('body'),
    getElementById(id) { if (!els.has(id)) { const e = makeEl(id); e.hidden = startHidden.has(id); els.set(id, e); } return els.get(id); },
    createElement: (t) => makeEl(null, t),
    createTextNode: (t) => ({ textContent: t }),
  };
  const win = {
    document, io: () => socket, SwimSim: S,
    sessionStorage: store(session), localStorage: store(),
    matchMedia: () => ({ matches: true }),        // a phone: the touch pads are in play
    performance: { now: () => Date.now() },
    requestAnimationFrame: () => 0,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout() {}, setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; }, clearInterval() {},
    fetch: opts.fetch || (() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })),
    addEventListener() {}, removeEventListener() {},
    location: { origin: 'http://x', href: '/' },
    DSEnd: { show: (o) => shown.push(o), hide() {}, shown: () => false },
    console,
  };
  win.window = win; win.parent = opts.lobby || win;   // opts.lobby: the lobby that frames the page
  const scene = new Proxy({}, { get: () => () => ({}) });   // every scene call a no-op
  const src = fs.readFileSync(path.join(ROOT, 'public/js/swim/swimEventMain.js'), 'utf8')
    .replace(/^import \{ createScene \} from '\.\/swimScene\.js';$/m, 'const createScene = () => __scene;');
  win.__scene = scene;
  vm.createContext(win);
  vm.runInContext(src, win, { filename: 'swimEventMain.js' });
  const runTimers = () => { while (timers.length) timers.shift().fn(); };
  const fire = (ev, m) => { if (ev === 'connect') socket.connected = true; if (ev === 'disconnect') socket.connected = false; handlers[ev](m); };
  /* One run of a named interval (only that one: the others need more of a page than this stand-in has). */
  const every = (name) => { for (const t of intervals) if (t.fn.name === name) t.fn(); };
  return { win, els: (id) => document.getElementById(id), emitted, fire, runTimers, every, shown };
}

test('Swim Race page: Join from the Events tab joins once; after Leave a reconnect does not join again', () => {
  const p = boot({ seJoin: '1', playerName: 'Ann' });
  p.fire('connect');
  assert.ok(p.emitted.some(e => e.ev === 'se:join'), 'the first connect joins');
  p.fire('se:joined', { state: 'waiting', lane: 0, n: 1, cars: [[0, 'Ann', 'supercar']] });
  p.els('lbLeave').fire('click');
  assert.ok(p.emitted.some(e => e.ev === 'se:leave'));
  p.emitted.length = 0;
  p.fire('disconnect'); p.fire('connect');
  assert.ok(p.emitted.some(e => e.ev === 'se:watch'), 'it still watches the lobby');
  assert.ok(!p.emitted.some(e => e.ev === 'se:join'), 'and does not put the car back in the lobby');

  /* Still in the lobby when the link blips: the car goes back in (the server dropped it with the socket). */
  const q = boot({ seJoin: '1', playerName: 'Bo' });
  q.fire('connect');
  q.fire('se:joined', { state: 'waiting', lane: 0, n: 1, cars: [[0, 'Bo', 'supercar']] });
  q.emitted.length = 0;
  q.fire('disconnect'); q.fire('connect');
  assert.ok(q.emitted.some(e => e.ev === 'se:join'));
});

test('Swim Race page: put out while the connection was down, the reconnect shows the knockout card', () => {
  const p = boot({ seJoin: '1', playerName: 'Ann' });
  p.fire('connect');
  p.fire('se:joined', { state: 'waiting', lane: 0, n: 1, cars: [[0, 'Ann', 'supercar']] });
  const seats = [0, 1, 2].map(s => ({ seat: s, name: ['Ann', 'kev', 'ines'][s], car: 'supercar', out: 0 }));
  const row = (s, alive) => [s, 0, 0, S.laneX(s), S.V0, 0, alive, 0, 0];
  p.fire('se:start', { id: 'se9', state: 'countdown', lanes: 3, goAt: Date.now() + 10000, now: Date.now(), seats, cars: [], p: [row(0, 1), row(1, 1), row(2, 1)] });
  p.fire('se:you', { id: 'se9', seat: 0, key: 'k1' });
  const race = p.win.__swimraceRace();
  assert.strictEqual(race.me, 0);
  assert.strictEqual(p.els('pads').hidden, false, 'racing on a phone: the pads are up');
  p.emitted.length = 0;
  p.fire('disconnect'); p.fire('connect');
  assert.deepStrictEqual(p.emitted.find(e => e.ev === 'se:rejoin').p.key, 'k1');
  /* The server held the seat 5 s, then put it out ('left'); the se:ko went out while this screen was away. */
  p.fire('se:you', { id: 'se9', seat: 0, key: 'k2' });
  p.fire('se:state', { id: 'se9', state: 'racing', lanes: 3, goAt: Date.now() - 20000, now: Date.now(), tick: 1200,
    seats: seats.map(s => Object.assign({}, s, { out: s.seat === 0 ? 3 : 0 })), cars: [], p: [row(0, 0), row(1, 1), row(2, 1)],
    ko: [{ seat: 0, name: 'Ann', place: 3, why: 'left', z: 412 }] });
  const r = p.win.__swimraceRace();
  assert.strictEqual(r.out, 3, 'the page knows its car is out, in 3rd');
  assert.strictEqual(p.els('pads').hidden, true, 'the pads go away');
  p.runTimers();
  const card = p.shown.find(o => o && o.verdict === 'You left the race');
  assert.ok(card, 'the knockout card says so');
  assert.strictEqual(card.unit, 'of 3');
  assert.ok(p.win.document.body.classList.contains('watching'), 'and the page watches the rest of the race');
});

test('Swim Race page: the owner bar follows the lobby wallet the server says is an owner\'s, and nobody else sees it', async () => {
  const OWNER_W = 'OwnerWa11etAddre55', asks = [];
  const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };
  const server = ({ cookie = false } = {}) => (url, o) => {
    let body = {};
    if (url === '/api/owner/session') body = { signedIn: cookie };
    if (url === '/api/br/owner') { const w = JSON.parse(o.body).wallet; asks.push(w); body = { isOwner: w === OWNER_W }; }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  };
  const lobbyOf = (address) => {
    const posted = [];
    return { posted, duelWallet: address ? { ready: true, authenticated: true, address } : { ready: true, authenticated: false, address: null },
             postMessage: (m) => posted.push(m) };
  };

  /* Owen's phone: no owner cookie, the lobby signed in with the owner's wallet. The bar shows, asked once. */
  const lobby = lobbyOf(OWNER_W);
  const p = boot({}, { lobby, fetch: server() });
  await settle();
  assert.deepStrictEqual(asks, [OWNER_W], 'the lobby\'s wallet is the one asked about');
  assert.strictEqual(p.els('ownerBar').hidden, false, 'the owner sees the bar');
  assert.strictEqual(p.els('ownStart').hidden, false);
  p.every('ownerFollow'); await settle();
  assert.strictEqual(asks.length, 1, 'not asked again for the same wallet');
  /* Start now asks the lobby's wallet to sign se:start; the server checks that signature (/api/owner/do). */
  p.els('ownStart').fire('click');
  await settle();
  const ask = lobby.posted.find(m => m && m.type === 'duel:signaction');
  assert.ok(ask && ask.action === 'se:start', 'a press is signed in the lobby, not taken on the page\'s word');
  /* The lobby signs out: the bar goes. */
  lobby.duelWallet = { ready: true, authenticated: false, address: null };
  p.every('ownerFollow'); await settle();
  assert.strictEqual(p.els('ownerBar').hidden, true, 'signed out, no bar');

  /* Somebody else's wallet: asked, told no, no bar. */
  asks.length = 0;
  const q = boot({}, { lobby: lobbyOf('SomebodyE1se'), fetch: server() });
  await settle();
  assert.deepStrictEqual(asks, ['SomebodyE1se']);
  assert.strictEqual(q.els('ownerBar').hidden, true, 'a player who is not the owner never sees the bar');

  /* A signed-out lobby, and the page on its own (not in the lobby's frame): nothing to ask about, no bar. */
  asks.length = 0;
  const r = boot({}, { lobby: lobbyOf(null), fetch: server() });
  const alone = boot({}, { fetch: server() });
  await settle();
  assert.deepStrictEqual(asks, []);
  assert.strictEqual(r.els('ownerBar').hidden, true);
  assert.strictEqual(alone.els('ownerBar').hidden, true);
  /* The lobby's wallet finishing its sign-in after the page opened: the bar comes on the next look. */
  r.win.parent.duelWallet = { ready: true, authenticated: true, address: OWNER_W };
  r.every('ownerFollow'); await settle();
  assert.strictEqual(r.els('ownerBar').hidden, false, 'a wallet that loads late still gets the bar');

  /* A device signed into Control (the cookie): the bar, without asking about any wallet. */
  asks.length = 0;
  const c = boot({}, { lobby: lobbyOf(OWNER_W), fetch: server({ cookie: true }) });
  await settle();
  assert.strictEqual(c.els('ownerBar').hidden, false);
  assert.deepStrictEqual(asks, []);
});
