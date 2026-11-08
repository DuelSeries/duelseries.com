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
function boot(session, opts) {
  opts = opts || {};
  const els = new Map();
  const raf = { fn: null };
  const drawn = { last: null };
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
    requestAnimationFrame: (fn) => { raf.fn = fn; return 0; },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    fetch: opts.fetch || (() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })),
    addEventListener() {}, removeEventListener() {},
    location: { origin: 'http://x', href: '/' },
    DSEnd: { show: (o) => shown.push(o), hide() {}, shown: () => false },
    console,
  };
  win.window = win; win.parent = opts.parent || win;
  // every scene call a no-op, but what a frame hands the road is kept (drawn.last)
  const scene = new Proxy({}, { get: (_, k) => (k === 'frame' ? (f) => { drawn.last = f; } : () => ({})) });
  const src = fs.readFileSync(path.join(ROOT, 'public/js/swim/swimEventMain.js'), 'utf8')
    .replace(/^import \{ createScene \} from '\.\/swimScene\.js';$/m, 'const createScene = () => __scene;');
  win.__scene = scene;
  vm.createContext(win);
  // the owner's Start now helper, loaded before the page as swimrace.html does
  if (opts.owner) vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/js/shared/dsOwnerStart.js'), 'utf8'), win, { filename: 'dsOwnerStart.js' });
  vm.runInContext(src, win, { filename: 'swimEventMain.js' });
  const runTimers = () => { while (timers.length) timers.shift().fn(); };
  const fire = (ev, m) => { if (ev === 'connect') socket.connected = true; if (ev === 'disconnect') socket.connected = false; handlers[ev](m); };
  const frame = (t) => { if (raf.fn) raf.fn(t); return drawn.last; };
  return { win, els: (id) => document.getElementById(id), emitted, fire, runTimers, shown, frame };
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

/* The owner's Start now (Owen 2026-11-08): Control's se:start, in the joined line and on the card, shown only when
   public/js/shared/dsOwnerStart.js says this device is signed into Control or the lobby's wallet is the owner's. The
   server checks the owner again on every press (/api/owner/do); these pin what each player's page draws and sends. */
const OWNER_W = 'Own3r111111111111111111111111111111111111111';
function ownerFetch(o) {
  const asked = [];
  const fetch = (url, opt) => {
    asked.push({ url, opt: opt || {} });
    let body = {};
    if (url === '/api/owner/session') body = { signedIn: !!o.session };
    else if (url === '/api/br/owner') body = { isOwner: JSON.parse(opt.body).wallet === OWNER_W };
    else if (url === '/api/owner/do') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, note: 'Swim Race starting in 15 seconds' }) });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
  return { asked, fetch };
}
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };

test('Swim Race page: a player who is not the owner never sees Start now and never sends an owner action', async () => {
  for (const parent of [null, { duelWallet: { ready: true, authenticated: true, address: 'P1ayer11111111111111111111111111111111111111' },
    addEventListener() {}, removeEventListener() {}, postMessage() { throw new Error('nothing to sign'); } }]) {
    const f = ownerFetch({ session: false });
    const p = boot({ seJoin: '1', playerName: 'Ann' }, { fetch: f.fetch, parent: parent || undefined, owner: true });
    p.fire('connect');
    p.fire('se:joined', { state: 'waiting', lane: 0, n: 1, cars: [[0, 'Ann', 'supercar']] });
    await flush();
    assert.strictEqual(p.els('lbStart').hidden, true, 'not in the joined line');
    assert.strictEqual(p.els('seStart').hidden, true, 'not on the card');
    p.els('lbStart').fire('click');
    await flush();
    assert.ok(!f.asked.some(a => a.url === '/api/owner/do'), 'a hidden button sends nothing');
  }
  const html = fs.readFileSync(path.join(ROOT, 'public/swimrace.html'), 'utf8');
  assert.match(html, /<button type="button" class="seOwn" id="lbStart" hidden>Start now<\/button>/, 'hidden until the owner is known');
  assert.match(html, /<button type="button" class="seOwn" id="seStart" hidden>Start now<\/button>/);
  const src = fs.readFileSync(path.join(ROOT, 'public/js/swim/swimEventMain.js'), 'utf8');
  assert.ok(!/['"`]\/api\/owner\/|['"`]\/api\/br\/owner|'se:open'|'se:stop'/.test(src), 'the page calls no owner route itself and has only Start now');
  assert.match(src, /window\.DSOwnerStart\.start\('se:start', \{\}\)/, 'Start now goes through dsOwnerStart');
});

test('Swim Race page: the owner sees Start now, and a press sends Control\'s se:start and says the answer', async () => {
  // a device signed into Control: the cookie alone, nothing to sign
  const f = ownerFetch({ session: true });
  const p = boot({ seJoin: '1', playerName: 'Owen' }, { fetch: f.fetch, owner: true });
  p.fire('connect');
  p.fire('se:joined', { state: 'waiting', lane: 0, n: 1, cars: [[0, 'Owen', 'supercar']] });
  await flush();
  assert.strictEqual(p.els('lbStart').hidden, false, 'in the joined line beside Leave');
  assert.strictEqual(p.els('seStart').hidden, false, 'and on the card');
  p.els('lbStart').fire('click');
  assert.strictEqual(p.els('lbStart').disabled, true, 'one press at a time');
  await flush();
  const sent = f.asked.filter(a => a.url === '/api/owner/do');
  assert.strictEqual(sent.length, 1);
  assert.deepStrictEqual(JSON.parse(sent[0].opt.body), { action: 'se:start', args: {} });
  assert.strictEqual(sent[0].opt.credentials, 'same-origin', 'the owner session cookie goes with it');
  assert.strictEqual(sent[0].opt.headers['X-DS-Owner'], '1', 'the header a cookie write needs');
  assert.strictEqual(p.els('botNote').textContent, 'Swim Race starting in 15 seconds');
  assert.strictEqual(p.els('lbStart').disabled, false);

  // the lobby's owner wallet (no Control cookie on this device): shown once the server says it is the owner's
  const g = ownerFetch({ session: false });
  const parent = { duelWallet: { ready: true, authenticated: true, address: OWNER_W }, addEventListener() {}, removeEventListener() {} };
  const q = boot({}, { fetch: g.fetch, parent, owner: true });
  await flush();
  assert.ok(g.asked.some(a => a.url === '/api/br/owner'), 'asks about the lobby wallet');
  assert.strictEqual(q.els('seStart').hidden, false, 'the owner wallet sees it too');
});

/* Owen 2026-11-04: pressing gas in the countdown made the bots jump. The other cars were carried forward from their
   start-line rows at V0 and eased back each frame, so they sat 2 to 3 m behind the line and a slow frame (revving
   makes them) threw them forward. And the traffic was drawn (and pruned) at the countdown's negative tick, so it drove
   before go and a car the server still had ahead could be dropped. Nothing moves before go now. */
test('Swim Race page: before go every car is parked on the line, at no speed, and the traffic waits for go', () => {
  const p = boot({ seJoin: '1', playerName: 'Ann' });
  p.fire('connect');
  p.fire('se:joined', { state: 'waiting', lane: 0, n: 1, cars: [[0, 'Ann', 'supercar']] });
  const seats = [0, 1, 2].map(s => ({ seat: s, name: ['Ann', 'bot1', 'bot2'][s], car: 'supercar', out: 0 }));
  const row = (s) => [s, 0, 0, S.laneX(s), S.V0, 0, 1, 0, 0];
  /* A car 60 m up the fast lane on tick 0: 10 s back it would be 210 m behind the line (the old prune dropped it). */
  const near = [77, 0, 0, 60, 0, 3];
  const t0 = Date.now();
  p.fire('se:start', { id: 'se7', state: 'countdown', lanes: 3, goAt: t0 + 10000, now: t0, seats, cars: [near], p: [row(0), row(1), row(2)] });
  p.fire('se:you', { id: 'se7', seat: 0, key: 'k1' });
  const race = p.win.__swimraceRace();
  p.frame(t0);
  for (const dt of [16, 100, 40, 100]) {          // slow frames too: the old drawing moved with every one
    const f = p.frame(t0 + dt);
    assert.strictEqual(f.tick, 0, 'the road is drawn at tick 0 until go');
    assert.strictEqual(f.follow.z, 0); assert.strictEqual(f.follow.v, 0, 'our car shows no speed');
    const others = f.others.filter(Boolean);
    assert.strictEqual(others.length, 2, 'both bots are drawn beside us');
    for (const o of others) {
      assert.strictEqual(o.z, 0, 'a bot sits exactly on the line'); assert.strictEqual(o.v, 0);
      assert.strictEqual(o.x, S.laneX(o.seat), 'in its own lane');
    }
  }
  assert.ok(race.traffic.byId.has(77), 'the car just up the road is still there at go');
  assert.strictEqual(p.els('spdNum').textContent, '0');
  assert.strictEqual(p.els('distText').textContent, 'On the start line');
  assert.ok(p.win.document.body.classList.contains('pre'), 'before go the page shows only what a player needs');
  assert.strictEqual(p.els('countNum').textContent, 'Starting in 10');
  assert.ok(/^3 racers · drag on the left to steer$/.test(p.els('countSub').textContent), p.els('countSub').textContent);
});
