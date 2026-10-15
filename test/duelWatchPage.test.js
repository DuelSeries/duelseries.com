'use strict';
/* The Knockout and Battleship pages in watch mode, booted under node.

   Nothing else loads these two pages in a test, so this keeps to what watch
   mode adds: the lobby's 'dsWatch' mark is read once and removed, it only
   counts when it names this game, a connect then asks to WATCH instead of
   queueing, and Lobby says unwatch and posts game:done to the lobby. The
   watching payloads fed in are made by the real lobbies, so the page is drawn
   from exactly what the server sends a watcher.

   The DOM here is a stand-in: elements are made on first lookup, every canvas
   call is a no-op, and timers and animation frames only run when a test says. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { KnockoutLobby } = require('../server/KnockoutLobby');
const { BattleshipLobby } = require('../server/BattleshipLobby');

const ROOT = path.join(__dirname, '..');
/* Compared as JSON: objects made inside the page's context have that context's
   prototypes, which deepStrictEqual counts as a difference. */
const same = (a, b) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b));

function noopProxy() {
  const fn = function () { return noopProxy(); };
  return new Proxy(fn, {
    get(t, k) {
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === Symbol.toPrimitive || k === 'then') return undefined;
      return noopProxy();
    },
    set() { return true; },
  });
}

function makeEl(id, tag) {
  const listeners = {};
  const classes = new Set();
  const props = {};
  const el = {
    id, tagName: String(tag || 'div').toUpperCase(),
    hidden: false, disabled: false, textContent: '', className: '',
    children: [], dataset: {}, attributes: {},
    width: 300, height: 300, clientWidth: 300, offsetHeight: 20, offsetWidth: 300,
    style: { setProperty(k, v) { props[k] = v; }, getPropertyValue(k) { return props[k] || ''; } },
    classList: {
      add: (...c) => c.forEach(x => classes.add(x)),
      remove: (...c) => c.forEach(x => classes.delete(x)),
      toggle(c, on) { const v = on === undefined ? !classes.has(c) : !!on; if (v) classes.add(c); else classes.delete(c); return v; },
      contains: (c) => classes.has(c),
    },
    get childElementCount() { return this.children.length; },
    set innerHTML(v) { this.children = []; },
    get innerHTML() { return ''; },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    fire(ev, e) { for (const fn of listeners[ev] || []) fn(Object.assign({ preventDefault() {}, target: el, clientX: 0, clientY: 0 }, e)); },
    click() { el.fire('click'); },
    setAttribute(k, v) { el.attributes[k] = String(v); },
    getAttribute(k) { return el.attributes[k]; },
    getContext() { return noopProxy(); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 300, height: 300 }; },
    setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture() { return false; },
    closest() { return null; },
  };
  return el;
}

/* One page, booted from its script with the given sessionStorage. */
function boot(file, storage) {
  const els = new Map();
  const byId = (id) => {
    if (!els.has(id)) {
      const el = makeEl(id);
      el.parentElement = makeEl(id + ':parent');
      els.set(id, el);
    }
    return els.get(id);
  };
  const store = new Map(Object.entries(storage || {}));
  const sessionStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const emitted = [], handlers = {}, posted = [], timers = [], frames = [];
  const sock = {
    id: 'page-socket-1',
    on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); },
    emit(ev, p) { emitted.push([ev, p]); },
  };
  const body = makeEl('body');
  const win = {
    console, Math, JSON, Date, Number, String, Array, Object, Map, Set, Promise, Symbol, Proxy,
    document: {
      body,
      getElementById: byId,
      createElement: (t) => makeEl('', t),
      querySelector: () => makeEl('q'),
    },
    sessionStorage,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    io: () => sock,
    innerWidth: 390, innerHeight: 844, devicePixelRatio: 1,
    addEventListener() {},
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    performance: { now: () => Date.now() },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    parent: { postMessage: (m) => posted.push(m) },
    location: { href: '' },
    BattleshipArt: { drawShip() {} },
    BattleshipSound: { hit() {}, miss() {}, sunk() {}, taken() {} },
  };
  win.window = win;
  const ctx = vm.createContext(win);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'js', file), 'utf8'), ctx, { filename: file });
  return {
    win, store, emitted, posted, timers, frames, $: byId, body,
    deliver(ev, p) { for (const fn of handlers[ev] || []) fn(p); },
    sent: (ev) => emitted.filter(e => e[0] === ev),
    runTimers() { const t = timers.splice(0); for (const x of t) x.fn(); return t; },
    runFrames(n) { for (let i = 0; i < n; i++) { const f = frames.splice(0); for (const fn of f) fn(); } },
  };
}

/* Real watching payloads, from the real lobbies. */
function watcherSocket() {
  const sent = [];
  return { id: 'w', sent, join() {}, leave() {}, emit(ev, p) { sent.push([ev, p]); } };
}
function koWatching(count) {
  const lob = new KnockoutLobby({ to: () => ({ emit() {} }) });
  for (let i = 0; i < count; i++) {
    lob.enqueue({ id: 'a' + i, join() {}, emit() {} }, i ? 'A' + i : 'Owen', null, 0, 0);
    lob.enqueue({ id: 'b' + i, join() {}, emit() {} }, i ? 'B' + i : 'Nia', null, 0, 0);
  }
  for (const r of lob.rooms.values()) r.tick(Date.now() + 4000);   // into the first turn
  const w = watcherSocket();
  lob.watch(w, { after: count > 1 ? [...lob.rooms.keys()].pop() : null });
  return w.sent.find(s => s[0] === 'ko:watching')[1];
}
function bsWatching() {
  const lob = new BattleshipLobby({ to: () => ({ emit() {} }) });
  lob.enqueue({ id: 'a', join() {}, emit() {} }, 'Owen', null, 0, 0);
  lob.enqueue({ id: 'b', join() {}, emit() {} }, 'Nia', null, 0, 0);
  const w = watcherSocket();
  lob.watch(w, {});
  return w.sent.find(s => s[0] === 'bs:watching')[1];
}

for (const g of [
  { game: 'knockout', file: 'knockout.js', p: 'ko', other: 'battleship', watching: () => koWatching(1) },
  { game: 'battleship', file: 'battleship.js', p: 'bs', other: 'knockout', watching: () => bsWatching() },
]) {
  test(g.game + ': the watch mark is read once, removed, and a connect asks to watch', () => {
    const page = boot(g.file, { dsWatch: g.game, playerName: 'Owen' });
    assert.strictEqual(page.store.has('dsWatch'), false, 'the mark is gone as soon as it is read');
    assert.ok(page.body.classList.contains('watching'));
    page.deliver('connect');
    assert.strictEqual(page.sent(g.p + ':watch').length, 1, 'it asks to watch');
    assert.strictEqual(page.sent(g.p + ':queue').length, 0, 'and never queues');
    page.deliver('connect');                       // a reconnect asks again
    assert.strictEqual(page.sent(g.p + ':watch').length, 2);
    assert.strictEqual(page.sent(g.p + ':queue').length, 0);
  });

  test(g.game + ': a mark for another game, or none, is a normal Play', () => {
    for (const storage of [{ dsWatch: g.other }, {}]) {
      const page = boot(g.file, storage);
      assert.strictEqual(page.store.has('dsWatch'), false);
      assert.ok(!page.body.classList.contains('watching'));
      page.deliver('connect');
      assert.strictEqual(page.sent(g.p + ':queue').length, 1, 'it queues');
      assert.strictEqual(page.sent(g.p + ':watch').length, 0);
    }
  });

  test(g.game + ': a match is shown by name, Next asks for the one after it, Lobby unwatches', () => {
    const page = boot(g.file, { dsWatch: g.game });
    page.deliver('connect');
    const m = g.watching();
    page.deliver(g.p + ':watching', m);
    page.runFrames(2);                             // the draw loop runs on a watcher's view
    assert.strictEqual(page.$('watchLabel').textContent, 'Watching Owen vs Nia');
    assert.strictEqual(page.win.__watch.mode, 'watching');
    assert.strictEqual(page.win.__watch.matchId, m.match.id);
    assert.deepStrictEqual(page.win.__watch.names, ['Owen', 'Nia']);
    assert.strictEqual(page.$('watchNext').disabled, true, 'one match: no next');

    page.deliver(g.p + ':matches', { index: 1, count: 2 });
    assert.strictEqual(page.$('watchNext').disabled, false, 'two matches: next is on offer');
    page.$('watchNext').click();
    same(page.sent(g.p + ':watch').pop()[1], { after: m.match.id });

    page.$('watchLobby').click();
    assert.strictEqual(page.sent(g.p + ':unwatch').length, 1);
    assert.strictEqual(page.sent(g.p + ':leave').length, 0, 'a watcher has no seat to leave');
    assert.deepStrictEqual(page.posted, ['game:done']);
  });

  test(g.game + ': none of the play controls does anything while watching', () => {
    const page = boot(g.file, { dsWatch: g.game });
    page.deliver('connect');
    page.deliver(g.p + ':watching', g.watching());
    if (g.p === 'ko') {
      page.$('board').fire('pointerdown', { clientX: 195, clientY: 600, pointerId: 1 });
      page.$('board').fire('pointerup', { clientX: 250, clientY: 650, pointerId: 1 });
      page.$('lock').click();
    } else {
      for (let i = 0; i < 2; i++) page.$('theirs').click();
      page.$('theirs').fire('dblclick');
      page.$('mine').fire('pointerdown');
      page.$('auto').click();
      page.$('confirm').click();
    }
    const acted = page.emitted.filter(e => /:(aim|lock|place|fire|queue|leave)$/.test(e[0]));
    assert.strictEqual(acted.length, 0, 'sent: ' + acted.map(e => e[0]).join(', '));
  });

  test(g.game + ': nothing running is said, and asked again a few seconds later', () => {
    const page = boot(g.file, { dsWatch: g.game });
    page.deliver('connect');
    page.deliver(g.p + ':watching', { none: true });
    assert.strictEqual(page.$('waitMain').textContent, 'Nobody is playing right now');
    assert.strictEqual(page.$('wait').hidden, false);
    assert.strictEqual(page.win.__watch.mode, 'none');
    const before = page.sent(g.p + ':watch').length;
    const ran = page.runTimers();
    assert.ok(ran.some(t => t.ms === 3000), 'a retry three seconds on');
    assert.strictEqual(page.sent(g.p + ':watch').length, before + 1);
  });

  test(g.game + ': the end of a match moves on to the next one', () => {
    const page = boot(g.file, { dsWatch: g.game });
    page.deliver('connect');
    const m = g.watching();
    page.deliver(g.p + ':watching', m);
    page.deliver(g.p + ':over', { winner: 'Nia', winnerSide: 1, why: 'opponent left', turn: 2, shots: [0, 0], reveal: [] });
    assert.strictEqual(page.$('over').hidden, false);
    assert.strictEqual(page.$('overWho').textContent, 'Nia wins');
    assert.match(page.$('overWhy').textContent, /^Owen left the match\./);
    page.runTimers();
    same(page.sent(g.p + ':watch').pop()[1], { after: m.match.id });
  });
}
