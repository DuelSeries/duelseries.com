'use strict';
/* The Knockout and Battleship pages in watch mode, booted under node.

   Nothing else loads these two pages in a test, so this keeps to what watch
   mode adds: the lobby's 'dsWatch' mark is read once and removed, it only
   counts when it names this game, a connect then asks to WATCH instead of
   queueing, and Lobby says unwatch and posts game:done to the lobby. The
   watcher's controls are the shared Spectate bar (public/js/shared/dsWatchBar.js,
   loaded for real ahead of the page): its plate says whose match it is, its
   arrows ask for the match before or after, its keys do the same, and it shows
   the empty table when nothing is running. The watching payloads fed in are
   made by the real lobbies, so the page is drawn from exactly what the server
   sends a watcher.

   And the result card, which is the shared one (public/js/shared/dsEnd.js,
   loaded for real ahead of the page as the page's HTML does): what a free and
   a paid win, loss and draw put on it, that its money is the server's
   `money` figures and nothing worked out here, and a paid Play again buying a
   fresh entry through the lobby's duel:restake bridge (the spent token used
   to be re-sent and refused, leaving the player stuck waiting).

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
    hidden: false, disabled: false, className: '',
    // like a real node: its own text plus its children's (the end card's figure is text and a small $ span)
    _text: '',
    get textContent() { return this._text + this.children.map((c) => c.textContent || '').join(''); },
    set textContent(v) { this._text = String(v); this.children = []; },
    children: [], dataset: {}, attributes: {}, parentNode: null,
    width: 300, height: 300, clientWidth: 300, offsetHeight: 20, offsetWidth: 300,
    style: { setProperty(k, v) { props[k] = v; }, getPropertyValue(k) { return props[k] || ''; } },
    classList: {
      add: (...c) => c.forEach(x => classes.add(x)),
      remove: (...c) => c.forEach(x => classes.delete(x)),
      toggle(c, on) { const v = on === undefined ? !classes.has(c) : !!on; if (v) classes.add(c); else classes.delete(c); return v; },
      contains: (c) => classes.has(c),
    },
    get childElementCount() { return this.children.length; },
    get firstChild() { return this.children[0] || null; },
    set innerHTML(v) { this.children = []; },
    get innerHTML() { return ''; },
    appendChild(c) {
      if (c.parentNode && c.parentNode !== this) c.parentNode.removeChild(c);
      if (!this.children.includes(c)) this.children.push(c);
      c.parentNode = this;
      return c;
    },
    removeChild(c) { this.children = this.children.filter(x => x !== c); c.parentNode = null; return c; },
    addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    fire(ev, e) { for (const fn of listeners[ev] || []) fn(Object.assign({ preventDefault() {}, stopPropagation() {}, target: el, clientX: 0, clientY: 0 }, e)); },
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

/* The shared card's nodes, read back as what a player sees. */
function walk(n, pred, out = []) {
  if (pred(n)) out.push(n);
  for (const c of n.children || []) walk(c, pred, out);
  return out;
}
const hasClass = (n, c) => (' ' + (n.className || '') + ' ').includes(' ' + c + ' ');
function readCard(body) {
  const wrap = walk(body, n => hasClass(n, 'dse'))[0];
  if (!wrap) return null;
  const one = (c) => { const n = walk(wrap, x => hasClass(x, c))[0]; return n ? n.textContent : null; };
  const buttons = walk(wrap, x => hasClass(x, 'dse-btn'));
  return {
    tone: (/t-(\w+)/.exec(wrap.className) || [])[1],
    verdict: one('dse-v'),
    hero: one('dse-big'),
    unit: one('dse-unit'),
    facts: walk(wrap, x => x.tagName === 'DT').map(dt => [dt.textContent, dt.parentNode.children[1].textContent]),
    ledger: walk(wrap, x => hasClass(x, 'dse-lr')).map(r => [r.children[0].textContent, r.children[1].textContent]),
    notes: walk(wrap, x => hasClass(x, 'dse-note')).map(n => n.textContent),
    buttons: buttons.map(b => ({ text: b.textContent, disabled: !!b.disabled, primary: hasClass(b, 'pri') })),
    button: (text) => buttons.find(b => b.textContent === text || b.textContent.startsWith(text)),
  };
}

/* One page, booted from its script with the given sessionStorage, the shared
   result card loaded ahead of it as the page's HTML does. framed: false opens
   it on its own (no lobby around it). */
const ORIGIN = 'http://lobby.test';
function boot(file, storage, { framed = true } = {}) {
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
  const emitted = [], handlers = {}, posted = [], timers = [], frames = [], replaced = [];
  const chat = { opts: null, lines: [], shown: false };
  let timerId = 0;
  const sock = {
    id: 'page-socket-1',
    on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); },
    emit(ev, p) { emitted.push([ev, p]); },
  };
  const body = makeEl('body');
  const head = makeEl('head');
  const winListeners = {};
  const win = {
    console, Math, JSON, Date, Number, String, Array, Object, Map, Set, Promise, Symbol, Proxy,
    document: {
      body, head, activeElement: null,
      getElementById: byId,
      createElement: (t) => makeEl('', t),
      createTextNode: (t) => { const n = makeEl('', '#text'); n.textContent = String(t); return n; },
      querySelector: () => makeEl('q'),
    },
    sessionStorage,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    io: () => sock,
    innerWidth: 390, innerHeight: 844, devicePixelRatio: 1,
    addEventListener(ev, fn) { (winListeners[ev] = winListeners[ev] || []).push(fn); },
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    performance: { now: () => Date.now() },
    setTimeout: (fn, ms) => { const id = ++timerId; timers.push({ id, fn, ms }); return id; },
    clearTimeout: (id) => { const i = timers.findIndex(x => x.id === id); if (i >= 0) timers.splice(i, 1); },
    setInterval: () => 0,
    clearInterval: () => {},
    location: { href: '', origin: ORIGIN, replace(u) { this.href = String(u); replaced.push(String(u)); } },
    BattleshipArt: { drawShip() {} },
    BattleshipSound: { hit() {}, miss() {}, sunk() {}, taken() {} },
    /* The shared chat box (its own DOM is not what these pages are tested on): what it was mounted with and told. */
    DSChat: {
      mount(o) {
        chat.opts = o;
        return { add: (m) => chat.lines.push(m), visible: (on) => { chat.shown = !!on; } };
      },
    },
  };
  win.parent = framed ? { postMessage: (m) => posted.push(m) } : win;
  win.window = win;
  const ctx = vm.createContext(win);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'js', 'shared', 'dsEnd.js'), 'utf8'), ctx, { filename: 'dsEnd.js' });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'js', 'shared', 'dsWatchBar.js'), 'utf8'), ctx, { filename: 'dsWatchBar.js' });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'js', file), 'utf8'), ctx, { filename: file });
  return {
    win, store, emitted, posted, timers, frames, replaced, $: byId, body, chat,
    /* The shared Spectate bar, read back as what a watcher sees and presses. */
    bar: () => {
      const one = (c) => walk(body, n => hasClass(n, c))[0];
      const round = walk(body, n => hasClass(n, 'dsw-round'));
      const s = win.DSWatchBar.state();
      return {
        on: s.on, empty: s.empty, busy: s.busy, text: s.text, presses: s.presses,
        lobby: one('dsw-lobby'), prev: round[0], next: round[1],
        plate: one('dsw-name') ? one('dsw-name').textContent : null,
      };
    },
    /* A key on the window, as the bar listens for it. */
    key(k, extra) {
      let stopped = false;
      for (const fn of winListeners.keydown || []) {
        fn(Object.assign({ key: k, target: body, repeat: false, preventDefault() {}, stopImmediatePropagation() { stopped = true; } }, extra));
        if (stopped) break;
      }
      return stopped;
    },
    /* The result card on screen, read back as text, or null. */
    card: () => readCard(body),
    /* A window message, from the lobby (the parent frame, this origin) unless told otherwise. */
    message(data, { source = win.parent, origin = ORIGIN } = {}) {
      for (const fn of winListeners.message || []) fn({ data, source, origin });
    },
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
/* One match with these two names, as a watcher is told of it. */
function koMatch(a, b) {
  const lob = new KnockoutLobby({ to: () => ({ emit() {} }) });
  lob.enqueue({ id: 'a', join() {}, emit() {} }, a, null, 0, 0);
  lob.enqueue({ id: 'b', join() {}, emit() {} }, b, null, 0, 0);
  for (const r of lob.rooms.values()) r.tick(Date.now() + 4000);
  const w = watcherSocket();
  lob.watch(w, {});
  return w.sent.find(s => s[0] === 'ko:watching')[1];
}
function bsMatch(a, b) {
  const lob = new BattleshipLobby({ to: () => ({ emit() {} }) });
  lob.enqueue({ id: 'a', join() {}, emit() {} }, a, null, 0, 0);
  lob.enqueue({ id: 'b', join() {}, emit() {} }, b, null, 0, 0);
  const w = watcherSocket();
  lob.watch(w, {});
  return w.sent.find(s => s[0] === 'bs:watching')[1];
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
  { game: 'knockout', file: 'knockout.js', p: 'ko', other: 'battleship', watching: () => koWatching(1), match: koMatch,
    hold: 1800, line: (page) => page.$('hint').textContent, overLine: 'Nia wins. Owen left the match.' },
  { game: 'battleship', file: 'battleship.js', p: 'bs', other: 'knockout', watching: () => bsWatching(), match: bsMatch,
    hold: 2500, line: (page) => page.$('watchStatus').textContent, overLine: 'Nia wins. 3 shots. Owen left the match.' },
]) {
  test(g.game + ': a paid rung Spectate asks for tables at that stake only; the stake mark is removed too', () => {
    const page = boot(g.file, { dsWatch: g.game, dsWatchStake: '0.5', playerName: 'Owen' });
    assert.strictEqual(page.store.has('dsWatchStake'), false);
    page.deliver('connect');
    same(page.sent(g.p + ':watch').pop()[1], { stake: 0.5 });
    const free = boot(g.file, { dsWatch: g.game });
    free.deliver('connect');
    same(free.sent(g.p + ':watch').pop()[1], { stake: 0 });
  });

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

  test(g.game + ': the shared bar is up at once, names the match "A vs B", Previous and Next ask for the one before and after, Lobby unwatches', () => {
    const page = boot(g.file, { dsWatch: g.game });
    let b = page.bar();
    assert.strictEqual(b.on, true, 'up before anything has been answered');
    assert.strictEqual(b.busy, true, 'its arrows wait for the first answer');
    assert.strictEqual(page.$('wait').hidden, true, 'the old wait card never shows for a watcher');
    page.deliver('connect');
    const m = g.match('Owen', 'Nia');
    page.deliver(g.p + ':watching', m);
    page.runFrames(2);                             // the draw loop runs on a watcher's view
    b = page.bar();
    assert.strictEqual(b.plate, 'Owen vs Nia');
    assert.strictEqual(b.empty, false);
    assert.strictEqual(b.busy, false);
    assert.strictEqual(page.win.__watch.mode, 'watching');
    assert.strictEqual(page.win.__watch.matchId, m.match.id);
    assert.deepStrictEqual(page.win.__watch.names, ['Owen', 'Nia']);

    /* Next: the match after this one. The arrows rest until the answer, and a second press waits for it. */
    b.next.click();
    same(page.sent(g.p + ':watch').pop()[1], { after: m.match.id, stake: 0 });
    assert.strictEqual(page.bar().busy, true);
    const asked = page.sent(g.p + ':watch').length;
    page.bar().next.click();
    page.bar().prev.click();
    assert.strictEqual(page.sent(g.p + ':watch').length, asked, 'nothing more is asked while it waits');
    const m2 = g.match('Ada', 'Bo');
    page.deliver(g.p + ':watching', m2);
    b = page.bar();
    assert.strictEqual(b.plate, 'Ada vs Bo');
    assert.strictEqual(b.busy, false, 'the answer opens the arrows again');
    assert.strictEqual(page.card(), null, 'and no card came between');

    /* Previous: the match before this one. */
    b.prev.click();
    same(page.sent(g.p + ':watch').pop()[1], { after: m2.match.id, stake: 0, dir: 'prev' });
    page.deliver(g.p + ':watching', m);
    assert.strictEqual(page.bar().plate, 'Owen vs Nia');

    /* Lobby: stop watching, back to the lobby, and the bar goes. */
    page.bar().lobby.click();
    assert.strictEqual(page.sent(g.p + ':unwatch').length, 1);
    assert.strictEqual(page.sent(g.p + ':leave').length, 0, 'a watcher has no seat to leave');
    assert.deepStrictEqual(page.posted, ['game:done']);
    assert.strictEqual(page.bar().on, false);
  });

  test(g.game + ': a buy-in Spectate steps among that buy-in\'s tables, and the keys do what the arrows do', () => {
    const page = boot(g.file, { dsWatch: g.game, dsWatchStake: '0.5' });
    page.deliver('connect');
    const m = g.match('Owen', 'Nia');
    page.deliver(g.p + ':watching', m);
    assert.strictEqual(page.key('ArrowRight'), true, 'the bar takes the key before the page does');
    same(page.sent(g.p + ':watch').pop()[1], { after: m.match.id, stake: 0.5 });
    const asked = page.sent(g.p + ':watch').length;
    assert.strictEqual(page.key('ArrowLeft'), true);
    assert.strictEqual(page.sent(g.p + ':watch').length, asked, 'a key while it waits does nothing either');
    const m2 = g.match('Ada', 'Bo');
    page.deliver(g.p + ':watching', m2);
    page.key(' ');
    same(page.sent(g.p + ':watch').pop()[1], { after: m2.match.id, stake: 0.5 });
    page.deliver(g.p + ':watching', m);
    page.key('ArrowLeft');
    same(page.sent(g.p + ':watch').pop()[1], { after: m.match.id, stake: 0.5, dir: 'prev' });
    assert.strictEqual(page.key('a'), false, 'any other key is the page\'s');
  });

  test(g.game + ': Lobby works before anything has been answered, and the arrows open on their own if no answer comes', () => {
    const early = boot(g.file, { dsWatch: g.game });
    early.bar().lobby.click();
    assert.strictEqual(early.sent(g.p + ':unwatch').length, 1);
    assert.deepStrictEqual(early.posted, ['game:done']);

    const page = boot(g.file, { dsWatch: g.game });
    page.deliver('connect');
    page.deliver(g.p + ':watching', g.match('Owen', 'Nia'));
    page.bar().next.click();
    assert.strictEqual(page.bar().busy, true);
    const ran = page.runTimers();                  // the answer never came
    assert.ok(ran.some(t => t.ms === 1500), 'the arrows give up waiting after a moment');
    assert.strictEqual(page.bar().busy, false);
    const asked = page.sent(g.p + ':watch').length;
    page.bar().next.click();
    assert.strictEqual(page.sent(g.p + ':watch').length, asked + 1, 'and can be pressed again');
  });

  test(g.game + ': Next with one match running comes back with the same one, and the board is left alone', () => {
    const page = boot(g.file, { dsWatch: g.game });
    page.deliver('connect');
    const m = g.match('Owen', 'Nia');
    page.deliver(g.p + ':watching', m);
    page.$('top').hidden = true;                   // anything the page repaints from scratch would undo this
    page.bar().next.click();
    page.deliver(g.p + ':watching', m);
    assert.strictEqual(page.$('top').hidden, true, 'not repainted');
    assert.strictEqual(page.bar().plate, 'Owen vs Nia');
    assert.strictEqual(page.bar().busy, false);
    /* A reconnect is different: the page missed things, so the answer is taken in full. */
    page.deliver('connect');
    same(page.sent(g.p + ':watch').pop()[1], { stake: 0 });
    page.deliver(g.p + ':watching', m);
    assert.strictEqual(page.$('top').hidden, false, 'repainted');
  });

  test(g.game + ': a long name gives up its end so the pair fits the plate, a short one keeps all of its own', () => {
    const page = boot(g.file, { dsWatch: g.game });
    page.deliver('connect');
    const long = 'A'.repeat(20), long2 = 'B'.repeat(20);
    const m = g.match(long, long2);
    page.deliver(g.p + ':watching', m);
    let plate = page.bar().plate;
    assert.ok(plate.length <= 32, plate);
    assert.strictEqual(plate, 'A'.repeat(13) + '… vs ' + 'B'.repeat(13) + '…');
    page.deliver(g.p + ':watching', g.match('Al', long2));
    plate = page.bar().plate;
    assert.strictEqual(plate, 'Al vs ' + 'B'.repeat(20), 'the short name loses nothing');
    page.deliver(g.p + ':watching', g.match(long, 'Bo'));
    assert.strictEqual(page.bar().plate, 'A'.repeat(20) + ' vs Bo');
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

  test(g.game + ': nothing running shows the empty table on the bar, and is asked again until a match starts', () => {
    const page = boot(g.file, { dsWatch: g.game });
    page.deliver('connect');
    for (const none of [{ none: true }, { full: true }, { refused: true, why: 'You are in a match already.' }]) {
      page.deliver(g.p + ':watching', none);
      const b = page.bar();
      assert.strictEqual(b.on, true);
      assert.strictEqual(b.empty, true);
      assert.strictEqual(b.plate, 'Nobody is playing yet');
      assert.strictEqual(b.prev.disabled, true);
      assert.strictEqual(b.next.disabled, true);
      assert.strictEqual(page.$('wait').hidden, true, 'the old wait card stays away');
    }
    page.deliver(g.p + ':watching', { none: true });
    assert.strictEqual(page.win.__watch.mode, 'none');
    const before = page.sent(g.p + ':watch').length;
    const ran = page.runTimers();
    assert.ok(ran.some(t => t.ms === 3000), 'a retry three seconds on');
    assert.strictEqual(page.sent(g.p + ':watch').length, before + 1);

    /* Lobby still works from the empty table. */
    page.bar().lobby.click();
    assert.strictEqual(page.sent(g.p + ':unwatch').length, 1);
    assert.deepStrictEqual(page.posted, ['game:done']);

    /* And the first match to start is followed by itself. */
    const again = boot(g.file, { dsWatch: g.game });
    again.deliver('connect');
    again.deliver(g.p + ':watching', { none: true });
    again.deliver(g.p + ':watching', g.match('Owen', 'Nia'));
    const b = again.bar();
    assert.strictEqual(b.empty, false);
    assert.strictEqual(b.plate, 'Owen vs Nia');
    assert.strictEqual(b.prev.disabled, false);
  });

  test(g.game + ': the end of a match is a line, not a card, and the next match follows by itself', () => {
    const page = boot(g.file, { dsWatch: g.game });
    page.deliver('connect');
    const m = g.match('Owen', 'Nia');
    page.deliver(g.p + ':watching', m);
    page.deliver(g.p + ':over', { winner: 'Nia', winnerSide: 1, why: 'opponent left', turn: 2, shots: [0, 3], reveal: [] });
    assert.strictEqual(page.card(), null, 'no card to click through');
    assert.strictEqual(g.line(page), g.overLine);
    assert.strictEqual(page.bar().on, true);
    assert.strictEqual(page.bar().plate, 'Owen vs Nia');
    assert.strictEqual(page.bar().busy, false, 'Previous and Next work while the result is up');
    const before = page.sent(g.p + ':watch').length;
    const ran = page.runTimers();
    assert.ok(ran.some(t => t.ms === g.hold), 'on to the next after a moment');
    assert.strictEqual(page.sent(g.p + ':watch').length, before + 1);
    same(page.sent(g.p + ':watch').pop()[1], { after: m.match.id, stake: 0 });

    /* The next match clears the line. */
    page.deliver(g.p + ':watching', g.match('Ada', 'Bo'));
    assert.strictEqual(page.card(), null);
    assert.strictEqual(page.bar().plate, 'Ada vs Bo');

    /* And when it was the last one running, the empty table. */
    page.deliver(g.p + ':over', { winner: 'Ada', winnerSide: 0, why: 'last one standing', turn: 3, shots: [4, 2], reveal: [] });
    page.runTimers();
    page.deliver(g.p + ':watching', { none: true });
    assert.strictEqual(page.bar().empty, true);
  });

  test(g.game + ': Previous or Next during the result moves on at once, and the moment\'s wait is dropped', () => {
    const page = boot(g.file, { dsWatch: g.game });
    page.deliver('connect');
    const m = g.match('Owen', 'Nia');
    page.deliver(g.p + ':watching', m);
    page.deliver(g.p + ':over', { winner: 'Nia', winnerSide: 1, why: 'last one standing', turn: 2, shots: [1, 3], reveal: [] });
    page.bar().prev.click();
    same(page.sent(g.p + ':watch').pop()[1], { after: m.match.id, stake: 0, dir: 'prev' });
    const asked = page.sent(g.p + ':watch').length;
    page.runTimers();
    assert.strictEqual(page.sent(g.p + ':watch').length, asked, 'nothing but the press asked');
  });

  test(g.game + ': a match that ends with no result moves straight on, with no card', () => {
    const page = boot(g.file, { dsWatch: g.game });
    page.deliver('connect');
    const m = g.match('Owen', 'Nia');
    page.deliver(g.p + ':watching', m);
    page.deliver(g.p + ':ended', { id: 'someone-elses' });
    assert.strictEqual(page.sent(g.p + ':watch').length, 1, 'another match\'s end is not ours');
    page.deliver(g.p + ':ended', { id: m.match.id });
    assert.strictEqual(page.card(), null);
    assert.strictEqual(page.sent(g.p + ':watch').length, 2, 'it asks for the next one at once');
    same(page.sent(g.p + ':watch').pop()[1], { after: m.match.id, stake: 0 });
    assert.strictEqual(page.bar().on, true);
    page.deliver(g.p + ':watching', { none: true });
    assert.strictEqual(page.bar().empty, true);
    page.bar().lobby.click();
    assert.deepStrictEqual(page.posted, ['game:done']);
    assert.strictEqual(page.sent(g.p + ':unwatch').length, 1);
  });

  test(g.game + ': the page loads the shared bar and keeps none of its old watcher controls', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public', g.game + '.html'), 'utf8');
    const empty = html.indexOf('/js/shared/dsEmptyArena.js'), bar = html.indexOf('/js/shared/dsWatchBar.js');
    const game = html.indexOf('js/' + g.file);
    assert.ok(empty > 0 && bar > empty && game > bar, 'both shared scripts, ahead of the game');
    assert.ok(!/watchNext|watchLobby|watchTag|watchLabel|watchMeta/.test(html), 'the old Next / Lobby / name are gone');
    const js = fs.readFileSync(path.join(ROOT, 'public', 'js', g.file), 'utf8');
    assert.ok(!/watchNext|watchLobby|watchTag|watchLabel|watchMeta/.test(js), 'and nothing in the script reaches for them');
  });
}

/* ── the result card, playing ────────────────────────────────────────────── */

const { KnockoutRoom } = require('../server/KnockoutRoom');
const { BattleshipRoom } = require('../server/BattleshipRoom');
const ME = 'page-socket-1';

/* The real over payload, made by the real room for a match this page's socket
   sat in: paid when stake > 0 (a dollar a seat, both with wallets). */
function koOver({ stake = 0, winner = ME, why = 'last one standing' } = {}) {
  const out = [];
  const room = new KnockoutRoom({ to: () => ({ emit: (ev, p) => out.push([ev, p]) }) }, 'k1');
  room.stake = stake;
  room.addPlayer({ id: ME, join() {}, emit() {} }, 'Owen', stake ? 'W1' : null, stake, stake);
  room.addPlayer({ id: 'them', join() {}, emit() {} }, 'Nia', stake ? 'W2' : null, stake, stake);
  room.turn = 4;
  room.finish(winner, why);
  return out.find(e => e[0] === 'ko:over')[1];
}
function bsOver({ stake = 0, winner = ME, why = 'fleet sunk' } = {}) {
  const got = {};
  const sock = (id) => ({ id, join() {}, emit: (ev, p) => { if (ev === 'bs:over') got[id] = p; } });
  const room = new BattleshipRoom({ to: () => ({ emit() {} }) }, 'b1');
  room.stake = stake;
  room.addPlayer(sock(ME), 'Owen', stake ? 'W1' : null, stake, stake);
  room.addPlayer(sock('them'), 'Nia', stake ? 'W2' : null, stake, stake);
  room.finish(winner, why);
  return Object.assign({}, got[ME], { shots: 31 });
}

for (const g of [
  { game: 'knockout', file: 'knockout.js', p: 'ko', over: koOver, hero: '4', unit: 'turns', count: 'Turns', countVal: '4', watching: () => koWatching(1) },
  { game: 'battleship', file: 'battleship.js', p: 'bs', over: bsOver, hero: '31', unit: 'shots fired', count: 'Shots', countVal: '31', watching: () => bsWatching() },
]) {
  test(g.game + ': a free result: who won, the ' + g.unit + ', and Play again queues again with no token', () => {
    const page = boot(g.file, { playerName: 'Owen' });
    page.deliver('connect');
    page.deliver(g.p + ':over', g.over());
    let c = page.card();
    assert.strictEqual(c.verdict, 'You win');
    assert.strictEqual(c.hero, 'Free');   // a free game says Free; its score is the first tray row (Owen 2026-10-16)
    assert.ok(c.facts.some((f) => f[1] === g.hero), 'the count is in the tray once');
    assert.strictEqual(c.unit, null);
    assert.strictEqual(c.tone, 'plain');
    assert.deepStrictEqual(c.ledger, [], 'no money on a free table');
    assert.deepStrictEqual(c.buttons.map(b => [b.text, b.primary]), [['Lobby', false], ['Spectate', false], ['Play again', true]]);   // Lobby left, the next step right (Owen 2026-10-16)

    const loss = boot(g.file, { playerName: 'Owen' });
    loss.deliver('connect');
    loss.deliver(g.p + ':over', g.over({ winner: 'them' }));
    assert.strictEqual(loss.card().verdict, 'Nia wins');

    const queued = page.sent(g.p + ':queue').length;
    c.button('Play again').click();
    assert.strictEqual(page.sent(g.p + ':leave').length, 1);
    assert.strictEqual(page.sent(g.p + ':queue').length, queued + 1);
    same(page.sent(g.p + ':queue').pop()[1], { name: 'Owen', wallet: null, stake: 0, entryToken: null });
    assert.strictEqual(page.card(), null, 'the card goes');
    assert.strictEqual(page.$('wait').hidden, false, 'and the wait card is up');
    assert.strictEqual(page.posted.length, 0, 'a free Play again asks the wallet for nothing');
  });

  test(g.game + ': a paid win shows the server\'s split: the net, the pot, the house cut', () => {
    const page = boot(g.file, { playerName: 'Owen', stake: '1', entryToken: 'tok-1' });
    page.deliver('connect');
    same(page.sent(g.p + ':queue').pop()[1], { name: 'Owen', wallet: null, stake: 1, entryToken: 'tok-1' });
    assert.strictEqual(page.store.has('entryToken'), false, 'spent once');
    const m = g.over({ stake: 1 });
    assert.strictEqual(m.money.netMicro, 1800000, 'the server says $1.80');
    page.deliver(g.p + ':over', m);
    const c = page.card();
    assert.strictEqual(c.verdict, 'You win');
    assert.strictEqual(c.tone, 'win');
    assert.strictEqual(c.hero, '$1.80');
    assert.strictEqual(c.unit, null, 'money won stands alone (Owen: no "to your wallet")');
    assert.deepStrictEqual(c.ledger, [['Pot', '$2.00'], ['House 10%', '−$0.20'], ['You receive', '$1.80']]);
    assert.deepStrictEqual(c.facts.find(f => f[0] === g.count), [g.count, g.countVal]);
    assert.deepStrictEqual(c.buttons.map(b => b.text), ['Lobby', 'Spectate', 'Play again $1.00']);   // Lobby left, the next step right (Owen 2026-10-16)

    /* The figures are the payload's, not the stake's: a different net on the
       wire is the net on the card. */
    const other = boot(g.file, { playerName: 'Owen', stake: '1', entryToken: 'tok-1' });
    other.deliver('connect');
    other.deliver(g.p + ':over', Object.assign({}, m, { money: Object.assign({}, m.money, { netMicro: 1234567 }) }));
    assert.strictEqual(other.card().hero, '$1.23');
  });

  test(g.game + ': a paid loss shows the stake lost', () => {
    const page = boot(g.file, { playerName: 'Owen', stake: '1', entryToken: 'tok-1' });
    page.deliver('connect');
    page.deliver(g.p + ':over', g.over({ stake: 1, winner: 'them' }));
    const c = page.card();
    assert.strictEqual(c.verdict, 'Nia wins');
    assert.strictEqual(c.tone, 'loss');
    assert.strictEqual(c.hero, '−$1.00');
    assert.strictEqual(c.unit, null);   // money lost stands alone (Owen 2026-10-16)
    assert.deepStrictEqual(c.ledger, []);
  });

  test(g.game + ': a paid Play again buys a fresh entry through the lobby, then queues with it', () => {
    const page = boot(g.file, { playerName: 'Owen', stake: '1', entryToken: 'tok-1' });
    page.deliver('connect');
    page.deliver(g.p + ':over', g.over({ stake: 1 }));
    page.card().button('Play again').click();
    const ask = page.posted.pop();
    assert.strictEqual(ask.type, 'duel:restake');
    assert.strictEqual(ask.game, g.game);
    assert.strictEqual(ask.stake, 1);
    assert.ok(typeof ask.nonce === 'string' && ask.nonce.length > 4);
    let c = page.card();
    assert.deepStrictEqual(c.buttons.map(b => [b.text, b.disabled]),
      [['Lobby', true], ['Spectate', true], ['Confirm in your wallet...', true]], 'the way back is shut while the wallet is open');
    c.button('Lobby').click();
    assert.ok(!page.posted.includes('game:done'), 'Lobby does nothing while paying');
    c.button('Spectate').click();
    assert.strictEqual(page.replaced.length, 0, 'nor does Spectate');
    assert.strictEqual(page.store.has('dsWatch'), false);

    /* Nothing but the lobby's own answer to this request counts. */
    const queued = page.sent(g.p + ':queue').length;
    page.message({ type: 'duel:restake:done', entryToken: 'x', nonce: 'wrong' });
    page.message({ type: 'duel:restake:done', entryToken: 'x', nonce: ask.nonce }, { source: {} });
    page.message({ type: 'duel:restake:done', entryToken: 'x', nonce: ask.nonce }, { origin: 'https://evil.test' });
    page.message({ type: 'duel:restake:done', entryToken: 'x' });
    assert.strictEqual(page.sent(g.p + ':queue').length, queued, 'none of those queued');
    assert.ok(page.card(), 'still on the card');

    page.message({ type: 'duel:restake:done', entryToken: 'tok-2', nonce: ask.nonce });
    assert.strictEqual(page.sent(g.p + ':leave').length, 1);
    same(page.sent(g.p + ':queue').pop()[1], { name: 'Owen', wallet: null, stake: 1, entryToken: 'tok-2' });
    assert.strictEqual(page.card(), null);
    assert.strictEqual(page.store.has('entryToken'), false, 'the fresh token is never stored');

    /* A late duplicate answer does nothing. */
    page.message({ type: 'duel:restake:done', entryToken: 'tok-3', nonce: ask.nonce });
    assert.strictEqual(page.sent(g.p + ':queue').length, queued + 1);
  });

  test(g.game + ': a refused or slow restake is said on the card, and the way back opens', () => {
    const page = boot(g.file, { playerName: 'Owen', stake: '1', entryToken: 'tok-1' });
    page.deliver('connect');
    page.deliver(g.p + ':over', g.over({ stake: 1, winner: 'them' }));
    page.card().button('Play again').click();
    let ask = page.posted.pop();
    page.message({ type: 'duel:restake:error', message: 'Not enough USDC.', nonce: ask.nonce });
    let c = page.card();
    assert.deepStrictEqual(c.buttons.map(b => [b.text, b.disabled]), [['Lobby', false], ['Spectate', false], ['Play again $1.00', false]]);   // Lobby left, the next step right (Owen 2026-10-16)
    assert.ok(c.notes.includes('Not enough USDC.'));

    c.button('Play again').click();
    ask = page.posted.pop();
    page.runTimers();                                // two minutes and no answer
    c = page.card();
    assert.deepStrictEqual(c.buttons.map(b => [b.text, b.disabled]), [['Lobby', false], ['Spectate', true], ['Waiting for your wallet...', true]]);   // Spectate shut for the whole buy-in
    assert.ok(c.notes.some(n => /has not answered yet/.test(n)));
    /* A late answer is still taken. */
    page.message({ type: 'duel:restake:done', entryToken: 'tok-late', nonce: ask.nonce });
    assert.strictEqual(page.sent(g.p + ':queue').pop()[1].entryToken, 'tok-late');
  });

  test(g.game + ': a paid card opened outside the lobby says to buy in there', () => {
    const page = boot(g.file, { playerName: 'Owen', stake: '1', entryToken: 'tok-1' }, { framed: false });
    page.deliver('connect');
    page.deliver(g.p + ':over', g.over({ stake: 1 }));
    const c = page.card();
    assert.deepStrictEqual(c.buttons.map(b => [b.text, b.primary, b.disabled]),
      [['Lobby', false, false], ['Spectate', false, false], ['Play again $1.00', true, true]]);
    assert.ok(c.notes.includes('Buy a new entry in the lobby to play again.'));
    c.button('Lobby').click();
    assert.strictEqual(page.win.location.href, '/');
  });

  /* Owen 2026-10-16: "a Lobby, Spectate and Play again button exactly the same on every single cash-out and death
     screen, including the paid ones". Spectate does what the lobby's Spectate does for the rung (play.js spectate()):
     the money keys out, the watch mark, the paid rung in dsWatchStake (never 'stake'), and this page again. */
  for (const k of [
    { name: 'a free loss', storage: { playerName: 'Owen' }, over: { winner: 'them' }, again: 'Play again', watchStake: null, ask: 0 },
    { name: 'a free win', storage: { playerName: 'Owen' }, over: {}, again: 'Play again', watchStake: null, ask: 0 },
    { name: 'a paid loss', storage: { playerName: 'Owen', stake: '1', entryToken: 'tok-1' }, over: { stake: 1, winner: 'them' },
      again: 'Play again $1.00', watchStake: '1', ask: 1 },
    { name: 'a paid win', storage: { playerName: 'Owen', stake: '1', entryToken: 'tok-1' }, over: { stake: 1 },
      again: 'Play again $1.00', watchStake: '1', ask: 1 },
  ]) {
    test(g.game + ': ' + k.name + ' has Lobby, Spectate, Play again, and Spectate reopens the page watching that rung', () => {
      const page = boot(g.file, k.storage);
      page.deliver('connect');
      page.deliver(g.p + ':over', g.over(k.over));
      const c = page.card();
      assert.deepStrictEqual(c.buttons.map(b => [b.text, b.primary, b.disabled]),
        [['Lobby', false, false], ['Spectate', false, false], [k.again, true, false]]);
      page.store.set('slPaidLaunch', '1');          // any money key a page could read goes too
      c.button('Spectate').click();
      assert.deepStrictEqual(page.replaced, ['/' + g.game], 'this page again, at the lobby\'s own address for it');
      assert.strictEqual(page.store.get('dsWatch'), g.game);
      assert.strictEqual(page.store.has('dsWatchStake') ? page.store.get('dsWatchStake') : null, k.watchStake);
      for (const key of ['stake', 'entryToken', 'entrySol', 'slPaidLaunch', 'spectateOnly']) {
        assert.strictEqual(page.store.has(key), false, key + ' is never left for a watcher');
      }
      assert.strictEqual(page.sent(g.p + ':leave').length, 1, 'the finished seat is let go');
      assert.ok(!page.posted.some(x => x && x.type === 'duel:restake'), 'no money is asked for');
      assert.ok(!page.posted.includes('game:done'));

      /* The page that comes up is a watcher of that rung, never a seat. */
      const next = boot(g.file, Object.fromEntries(page.store));
      assert.ok(next.body.classList.contains('watching'));
      next.deliver('connect');
      same(next.sent(g.p + ':watch').pop()[1], { stake: k.ask });
      assert.strictEqual(next.sent(g.p + ':queue').length, 0);
    });
  }

  // (A watcher has no result card any more, so no Play again on one: the shared Spectate bar moves on to the next
  // match by itself, Owen 2026-10-16. The watcher-card Play again tests went with the card.)

  test(g.game + ': a seat the server refuses is said on the wait card, not in the hidden bar', () => {
    const page = boot(g.file, { playerName: 'Owen', stake: '1' });
    page.deliver('connect');
    page.deliver(g.p + ':refused', { why: 'that buy-in was not paid for' });
    assert.strictEqual(page.$('wait').hidden, false);
    assert.strictEqual(page.$('waitMain').textContent, 'Not seated');
    assert.strictEqual(page.$('waitSub').textContent, 'That buy-in was not paid for.');
  });
}

test('knockout: a paid draw refunds each seat, and the card says what came back', () => {
  const page = boot('knockout.js', { playerName: 'Owen', stake: '1', entryToken: 'tok-1' });
  page.deliver('connect');
  const m = koOver({ stake: 1, winner: null, why: 'everyone went off' });
  assert.strictEqual(m.money.refunded, true);
  page.deliver('ko:over', m);
  const c = page.card();
  assert.strictEqual(c.verdict, 'Draw');
  assert.strictEqual(c.hero, '$1.00');
  assert.strictEqual(c.unit, 'refunded');
  assert.deepStrictEqual(c.ledger, []);
  assert.ok(c.notes.includes('Both sides went off on the same turn.'));
});

test('knockout and battleship: a win by walk-out says they left', () => {
  for (const [file, p, over] of [['knockout.js', 'ko', koOver], ['battleship.js', 'bs', bsOver]]) {
    const page = boot(file, { playerName: 'Owen' });
    page.deliver('connect');
    page.deliver(p + ':over', over({ why: 'opponent left' }));
    assert.strictEqual(page.card().verdict, 'You win');
    assert.ok(page.card().notes.includes('They left the match.'), file);
  }
});

/* The shared chat box on these pages: shown only while a match is on screen, typed into only by a seated player,
   a line in its seat's colour (the pair each page already draws), a refusal as a note for the sender. */
test('knockout: chat is shown in a match, sends ko:chat, colours a line by seat, and goes away with the card', () => {
  const page = boot('knockout.js', { playerName: 'Owen' });
  page.deliver('connect');
  assert.strictEqual(page.chat.shown, false, 'hidden while queued');
  assert.strictEqual(page.chat.opts.canSend(), false, 'and T does nothing there');
  page.deliver('ko:start', {
    id: 'm1', state: 'countdown', turn: 0, arenaR: 300, pieceR: 20, maxPull: 100, phaseMs: 3000, aimMs: 15000,
    players: [{ id: 'page-socket-1', name: 'Owen', side: 1, left: 2 }, { id: 'o', name: 'Nia', side: 0, left: 2 }],
    pieces: [], ready: [], stake: 0, pot: 0, ringOut: [],
  });
  assert.strictEqual(page.chat.shown, true);
  assert.strictEqual(page.chat.opts.canSend(), true);
  assert.strictEqual(page.chat.opts.send('gg'), true);
  same(page.sent('ko:chat').pop()[1], { text: 'gg' });

  page.deliver('ko:chat', { name: 'Nia', side: 0, text: 'hi' });
  page.deliver('ko:chat', { name: 'Owen', side: 1, text: 'yo' });
  page.deliver('ko:chatnote', { text: 'Slow down a little.' });
  same(page.chat.lines, [
    { name: 'Nia', color: '#e0705f', text: 'hi', me: false },
    { name: 'Owen', color: '#f4f1ea', text: 'yo', me: true },
    { kind: 'sys', text: 'Slow down a little.' },
  ]);

  page.deliver('ko:over', koOver({}));
  assert.strictEqual(page.chat.shown, false, 'not on the result card');
  assert.strictEqual(page.chat.opts.canSend(), false);
});

test('battleship: chat is shown in a match, sends bs:chat, colours a line by seat, and goes away with the card', () => {
  const page = boot('battleship.js', { playerName: 'Owen' });
  page.deliver('connect');
  assert.strictEqual(page.chat.shown, false, 'hidden while queued');
  assert.strictEqual(page.chat.opts.canSend(), false);
  page.deliver('bs:state', {
    id: 'm1', state: 'placing', phaseMs: 30000, placeMs: 30000, turnMs: 30000, grid: 10,
    fleet: [], you: { name: 'Owen', side: 1 }, them: { name: 'Nia', side: 0 }, yourTurn: false, placed: false,
    theyPlaced: false, myShips: [], shotsOnMe: [], myShots: [], sunkOfTheirs: [],
    squaresLeftMine: 17, squaresLeftTheirs: 17, lastShot: null, stake: 0, pot: 0,
  });
  assert.strictEqual(page.chat.shown, true);
  assert.strictEqual(page.chat.opts.canSend(), true);
  assert.strictEqual(page.chat.opts.send('gg'), true);
  same(page.sent('bs:chat').pop()[1], { text: 'gg' });

  page.deliver('bs:chat', { name: 'Nia', side: 0, text: 'hi' });
  page.deliver('bs:chat', { name: 'Owen', side: 1, text: 'yo' });
  page.deliver('bs:chatnote', { text: 'Slow down a little.' });
  same(page.chat.lines, [
    { name: 'Nia', color: '#e0554a', text: 'hi', me: false },
    { name: 'Owen', color: '#f5f1e8', text: 'yo', me: true },
    { kind: 'sys', text: 'Slow down a little.' },
  ]);

  page.deliver('bs:over', bsOver({}));
  assert.strictEqual(page.chat.shown, false, 'not on the result card');
  assert.strictEqual(page.chat.opts.canSend(), false);
});

test('knockout and battleship: a watcher sees the chat but cannot type, and seat 0 is the first colour', () => {
  for (const [file, p, watching, first, second] of [
    ['knockout.js', 'ko', () => koWatching(1), '#f4f1ea', '#e0705f'],
    ['battleship.js', 'bs', () => bsWatching(), '#f5f1e8', '#e0554a'],
  ]) {
    const page = boot(file, { dsWatch: file.replace('.js', '') });
    page.deliver('connect');
    page.deliver(p + ':watching', watching());
    assert.strictEqual(page.chat.shown, true, file + ': a watcher reads the chat');
    assert.strictEqual(page.chat.opts.canSend(), false, file + ': and cannot type');
    page.deliver(p + ':chat', { name: 'Owen', side: 0, text: 'one' });
    page.deliver(p + ':chat', { name: 'Nia', side: 1, text: 'two' });
    same(page.chat.lines, [
      { name: 'Owen', color: first, text: 'one', me: false },
      { name: 'Nia', color: second, text: 'two', me: false },
    ]);
    page.deliver(p + ':watching', { match: null, state: null });
    assert.strictEqual(page.chat.shown, false, file + ': nothing to watch, nothing to say');
  }
});

