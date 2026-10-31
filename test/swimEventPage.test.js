'use strict';
/* The Swim Race page (public/js/swim/swimEventMain.js), booted under node with a stand-in DOM, a fake socket and
   a no-op road (the WebGL scene is not loaded), and driven by the server's own messages:

   - the Events tab's Join (seJoin) joins on the first connect only: after Leave, a reconnect must not put the car
     back in the lobby (it used to, every time the connection blipped);
   - a racer put out while their connection was down (the 5 s ran out) gets the knockout card on reconnect, the
     se:ko it missed, instead of a frozen car with the pads still up until the race ends. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const S = require('../shared/swimSim');

const ROOT = path.join(__dirname, '..');

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
function boot(session) {
  const els = new Map();
  const handlers = {};
  const emitted = [];
  const timers = [];
  const shown = [];
  const socket = {
    connected: false,
    on(ev, fn) { handlers[ev] = fn; },
    emit(ev, p) { emitted.push({ ev, p }); },
    volatile: { emit() {} },
  };
  const store = (init) => { const m = new Map(Object.entries(init || {})); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
  const document = {
    body: makeEl('body'),
    getElementById(id) { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
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
    clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    addEventListener() {}, removeEventListener() {},
    location: { origin: 'http://x', href: '/' },
    DSEnd: { show: (o) => shown.push(o), hide() {}, shown: () => false },
    console,
  };
  win.window = win; win.parent = win;
  const scene = new Proxy({}, { get: () => () => ({}) });   // every scene call a no-op
  const src = fs.readFileSync(path.join(ROOT, 'public/js/swim/swimEventMain.js'), 'utf8')
    .replace(/^import \{ createScene \} from '\.\/swimScene\.js';$/m, 'const createScene = () => __scene;');
  win.__scene = scene;
  vm.createContext(win);
  vm.runInContext(src, win, { filename: 'swimEventMain.js' });
  const runTimers = () => { while (timers.length) timers.shift().fn(); };
  const fire = (ev, m) => { if (ev === 'connect') socket.connected = true; if (ev === 'disconnect') socket.connected = false; handlers[ev](m); };
  return { win, els: (id) => document.getElementById(id), emitted, fire, runTimers, shown };
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
