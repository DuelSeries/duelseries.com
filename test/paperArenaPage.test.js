'use strict';
// The arena page (T12, design 8.5 and 8.6): paperArenaMain.js booted in a DOM double against
// the real ArenaNet and a socket double that buffers emits the way socket.io-client 4.8.3
// does (an emit made while the link is down waits in sendBuffer and is sent on the next
// connection BEFORE that connection's 'connect' event, client-dist socket.io.js onconnect ->
// emitBuffered -> emitReserved('connect')). The end cards and the leaderboard are the site's shared
// ones (public/js/shared/dsEnd.js), run for real in the same DOM double. Plus the HUD's world pass
// staying under the stock screen HUD (paperHud.js stockHudHoles).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const MP = require('../public/js/paper/mp/paperWire.js');
const Net = require('../public/js/paper/mp/paperNet.js');
const Hud = require('../public/js/paper/mp/paperHud.js');

const MAIN = fs.readFileSync(path.join(__dirname, '../public/js/paper/mp/paperArenaMain.js'), 'utf8');
const DSEND = fs.readFileSync(path.join(__dirname, '../public/js/shared/dsEnd.js'), 'utf8');
const WATCHBAR = fs.readFileSync(path.join(__dirname, '../public/js/shared/dsWatchBar.js'), 'utf8');
const RESTAKE_WAIT_MS = 120000;

function clockDouble() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    time: () => now,
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: now + (Number(ms) || 0), fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
    }
  };
}

// socket.io-client 4.8.3's Socket, as far as the page and ArenaNet use it.
function ioSocket() {
  const s = {
    id: undefined,
    connected: false,
    handlers: {},
    outgoing: [],
    sendBuffer: [],
    wire: [], // what reached the transport, in order
    on(ev, fn) {
      (this.handlers[ev] = this.handlers[ev] || []).push(fn);
      return this;
    },
    onAnyOutgoing(fn) {
      this.outgoing.push(fn);
    },
    emit(ev, ...args) {
      const packet = [ev, ...args];
      if (this.connected) this._send(packet);
      else this.sendBuffer.push(packet);
      return this;
    },
    _send(packet) {
      this.outgoing.forEach((fn) => fn(...packet));
      this.wire.push(packet);
    },
    fire(ev, p) {
      (this.handlers[ev] || []).slice().forEach((fn) => fn(p));
    },
    connect(id) {
      this.id = id;
      this.connected = true;
      const buffered = this.sendBuffer;
      this.sendBuffer = [];
      buffered.forEach((p) => this._send(p));
      this.fire('connect');
    },
    drop() {
      this.connected = false;
      this.id = undefined;
      this.fire('disconnect', 'transport close');
    }
  };
  s.volatile = { emit: (ev, ...a) => { if (s.connected) s._send([ev, ...a]); } };
  return s;
}

function storage(init) {
  const m = new Map(Object.entries(init || {}));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    entries: () => Object.fromEntries(m) // what is stored now, to seed the next page with
  };
}

function page({ stake = 0, entryToken = null, framed = true, watch = null, local = null, seed = null } = {}) {
  const clock = clockDouble();
  const sock = ioSocket();
  const byId = new Map();
  const doc = {
    activeElement: null,
    listeners: {},
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    getElementById: (id) => byId.get(id) || null,
    querySelectorAll: (sel) => all(doc.body).filter((n) => matches(n, sel)),
    querySelector: (sel) => all(doc.body).find((n) => matches(n, sel)) || null,
    createElement: () => element(),
    createTextNode: (t) => { const n = element(); n.textContent = String(t); return n; }
  };
  function matches(n, sel) {
    if (sel.charAt(0) !== '.') return n.id === sel.slice(1);
    const c = sel.slice(1);
    return n.classes.indexOf(c) >= 0 || (' ' + n.className + ' ').indexOf(' ' + c + ' ') >= 0;
  }
  function all(n) {
    return n.children.reduce((out, c) => out.concat([c], all(c)), []);
  }
  function element(id, classes, kids) {
    const n = {
      id: id || '',
      classes: classes || [],
      className: '',
      attrs: {},
      hidden: false,
      disabled: false,
      textContent: '',
      innerHTML: '',
      style: {},
      children: [],
      parent: null,
      listeners: {},
      clientWidth: 800,
      clientHeight: 600,
      classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      get parentNode() { return this.parent; },
      get firstChild() { return this.children[0] || null; },
      addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      appendChild(c) { if (c.parent) c.parent.removeChild(c); c.parent = this; this.children.push(c); return c; },
      removeChild(c) {
        this.children = this.children.filter((x) => x !== c);
        c.parent = null;
        if (c.contains(doc.activeElement)) doc.activeElement = null; // a removed node takes its focus with it
        return c;
      },
      contains(x) { for (let p = x; p; p = p.parent) if (p === this) return true; return false; },
      querySelector(sel) { return all(this).find((c) => matches(c, sel)) || null; },
      focus() { doc.activeElement = this; },
      blur() { if (doc.activeElement === this) doc.activeElement = null; },
      // A real click on a disabled button never reaches its listeners.
      click() { if (!this.disabled) this.dispatch('click'); },
      // The listeners themselves, as a stale or synthetic event would reach them.
      dispatch(t) {
        const evt = { type: t, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {} };
        (this.listeners[t] || []).forEach((fn) => fn(evt));
      }
    };
    (kids || []).forEach((k) => n.appendChild(k));
    if (id) byId.set(id, n);
    return n;
  }
  doc.head = element('head');
  doc.body = element('body', [], [
    element('view'),
    element('pp-hint'), element('pp-cash', [], [element('pp-cash-fill'), element('pp-cash-label')]),
    element('pp-connecting', [], [element('pp-connecting-text'), element('pp-connecting-sub')]),
    element('pp-reconnecting'),
    element('pp-unsupported')
  ]);
  for (const id of ['pp-reconnecting', 'pp-unsupported', 'pp-hint', 'pp-cash']) {
    byId.get(id).hidden = true;
  }

  const game = {
    renderer() {},
    loop() { this.looped = true; },
    holds: [],
    setHold(d) { this.holds.push(d); },
    player: null,
    units: [],
    topListChanged: false,
    paid: stake > 0
  };
  const P = {
    MP,
    Net,
    Hud,
    Mirror: { create: () => game },
    SkinManager: function () {},
    ColorSkinPool: function () {},
    ClassicSkinPool: function () {},
    InputController: function () {},
    pickDefaultLanguage: () => ({ strings: {} }),
    defaultPaperConfig: {},
    whenFontsReady: (d, text, cb) => cb(),
    hudPreloadText: () => '',
    skinAssetPath: '',
    skinsData: {}
  };
  const parent = { messages: [], postMessage(m) { this.messages.push(m); } };
  const winListeners = {};
  const session = { playerName: 'Tester' };
  if (stake > 0) session.stake = String(stake);
  if (entryToken) session.entryToken = entryToken;
  if (watch !== null) session.dsWatch = watch;
  if (seed) Object.assign(session, seed); // a page opened on what an earlier one left in sessionStorage
  const win = {
    document: doc,
    DuelPaperLib: P,
    io: () => sock,
    // replace(): where the page sent itself without a history entry (the end cards' Spectate)
    location: { search: '', href: '', replaced: null, replace(u) { this.replaced = String(u); } },
    performance: { now: clock.time },
    innerWidth: 1366,
    sessionStorage: storage(session),
    localStorage: storage(local || undefined),
    addEventListener(t, fn) { (winListeners[t] = winListeners[t] || []).push(fn); },
    focus() {},
    console: { error() {}, log() {} },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    URLSearchParams,
    Path2D: function () {},
    fetch: () => new Promise(() => {}),
    events: [],
    phEvent(name, props) { this.events.push([name, props]); }
  };
  win.window = win;
  win.parent = framed ? parent : win;
  vm.createContext(win);
  vm.runInContext(DSEND, win);
  vm.runInContext(WATCHBAR, win);
  vm.runInContext(MAIN, win);
  const api = P.arena;
  assert.ok(api, 'the page booted');
  const text = (n) => (n ? n.textContent + n.children.map(text).join('') : null);
  const cardEl = () => doc.querySelector('.dse');
  const inCard = (cls) => { const c = cardEl(); return c ? all(c).filter((n) => matches(n, '.' + cls)) : []; };
  return {
    win,
    doc,
    sock,
    clock,
    parent,
    api,
    game,
    $: (id) => byId.get(id),
    text,
    // The shared end card as it is on screen now (null: none), and its parts.
    card() {
      const c = cardEl();
      if (!c) return null;
      const one = (cls) => { const n = inCard(cls)[0]; return n ? text(n) : null; };
      return {
        el: c,
        tone: (/t-(\w+)/.exec(c.className) || [])[1],
        verdict: one('dse-v'),
        hero: one('dse-big'),
        unit: one('dse-unit'),
        facts: inCard('dse-facts').length ? inCard('dse-facts')[0].children.map((d) => [text(d.children[0]), text(d.children[1])]) : [],
        ledger: inCard('dse-lr').map((r) => [text(r.children[0]), text(r.children[1])]),
        status: inCard('dse-st').map((s) => ({ text: text(s), state: (/\b(ok|err)\b/.exec(s.className) || ['', 'pending'])[1],
          href: s.children[2] ? s.children[2].href : null }))[0] || null,
        notes: inCard('dse-note').map(text),
        buttons: inCard('dse-btn').map((b) => text(b))
      };
    },
    // A card button by its id ('again', 'lobby'), as it is on screen now (null: not there).
    btn: (id) => (cardEl() ? all(cardEl()).find((n) => n.getAttribute('data-dse-btn') === id) || null : null),
    lobbyButtons: () => all(doc.body).filter((n) => n.getAttribute('data-dse-btn') === 'lobby'),
    boardRows: () => {
      const b = doc.querySelector('.dsb');
      return b ? all(b).filter((n) => n.parent && n.parent.parent === b && n.parent !== b)
        .map((li) => [li.className, ...li.children.map(text)]) : [];
    },
    boardEl: () => doc.querySelector('.dsb'),
    // The shared Spectate bar (dsWatchBar.js): what it shows, and its buttons.
    bar: () => win.DSWatchBar.state(),
    barLobby: () => doc.querySelector('.dsw-lobby'),
    barPrev: () => doc.querySelector('.dsw-switch').children[0],
    barNext: () => doc.querySelector('.dsw-switch').children[2],
    keydown(evt) {
      (winListeners.keydown || []).forEach((fn) => fn(Object.assign({ preventDefault() {}, target: doc.body }, evt)));
    },
    wire: (ev) => sock.wire.filter((p) => p[0] === ev),
    // A message from the lobby frame (wallet-widget/src/main.jsx's answer to duel:restake).
    fromLobby(data) {
      (winListeners.message || []).forEach((fn) => fn({ data, source: parent }));
    },
    joined(extra) {
      sock.fire('pp:joined', Object.assign({ you: 7, resumeKey: 'rk-1', tick: 100, units: [], trails: [] }, extra));
    }
  };
}

// Paid, seated, then dead: the dead card with Play again (framed) and Lobby.
function paidDeadPage() {
  const t = page({ stake: 0.1, entryToken: 'tok-1' });
  t.sock.connect('sock-a');
  t.joined({ stake: 0.1 });
  assert.strictEqual(t.api.page.phase, 'live');
  t.sock.fire('pp:dead', { reason: 2, lostMicro: 100000 });
  t.clock.advance(1000);
  assert.strictEqual(t.api.page.screen, 'dead');
  return t;
}

test('the entry token goes out once, in the first pp:join, and leaves sessionStorage', () => {
  const t = page({ stake: 0.1, entryToken: 'tok-1' });
  assert.strictEqual(t.win.sessionStorage.getItem('entryToken'), null);
  t.sock.connect('sock-a');
  const joins = t.wire('pp:join');
  assert.strictEqual(joins.length, 1);
  assert.strictEqual(joins[0][1].entryToken, 'tok-1');
});

test('the lobby\'s bought Paper skin and pass ride the join and the respawn; without them the join is as before', () => {
  const none = page();
  none.sock.connect('sock-a');
  assert.deepStrictEqual(Object.keys(none.wire('pp:join')[0][1]).sort(), ['name', 'stake'], 'no extra fields');

  const t = page({ local: { 'duel.shop.paper': 'camo', 'duel.skinpass': 'PASS.SIG' } });
  t.sock.connect('sock-a');
  const join = t.wire('pp:join')[0][1];
  assert.strictEqual(join.shop, 'camo');
  assert.strictEqual(join.skinPass, 'PASS.SIG');
  t.joined({});
  t.sock.fire('pp:dead', { reason: 2, lostMicro: 0 });
  t.clock.advance(1000);
  t.btn('again').click();
  const respawn = t.wire('pp:respawn')[0][1];
  assert.strictEqual(respawn.shop, 'camo');
  assert.strictEqual(respawn.skinPass, 'PASS.SIG');

  // a choice that is not an id, or a pass that is too long, is not sent at all
  for (const local of [{ 'duel.shop.paper': 'Camo!', 'duel.skinpass': 'P' },
    { 'duel.shop.paper': 'camo', 'duel.skinpass': 'x'.repeat(4097) },
    { 'duel.shop.paper': 'camo' }, { 'duel.skinpass': 'P' }]) {
    const p = page({ local });
    p.sock.connect('sock-a');
    assert.strictEqual(p.wire('pp:join')[0][1].shop, undefined);
    assert.strictEqual(p.wire('pp:join')[0][1].skinPass, undefined);
  }
});

test('Lobby is shut while a paid restake is with the wallet', () => {
  const t = paidDeadPage();
  t.btn('again').click();
  assert.strictEqual(t.text(t.btn('again')), 'Confirm in your wallet...');
  assert.strictEqual(t.btn('again').disabled, true);
  assert.strictEqual(t.parent.messages.length, 1);
  const ask = t.parent.messages[0];
  assert.deepStrictEqual({ type: ask.type, game: ask.game, stake: ask.stake }, { type: 'duel:restake', game: 'paper', stake: 0.1 });
  assert.ok(typeof ask.nonce === 'string' && ask.nonce.length >= 8, 'the request carries its own id');
  assert.strictEqual(t.lobbyButtons().length, 1);
  for (const b of t.lobbyButtons()) assert.strictEqual(b.disabled, true);
  assert.strictEqual(t.btn('spectate').disabled, true, 'Spectate is shut with Lobby');
  // Even a click that reaches the listener (a stale event) neither leaves nor closes the frame.
  t.btn('lobby').dispatch('click');
  t.btn('spectate').dispatch('click');
  assert.strictEqual(t.parent.messages.indexOf('game:done'), -1);
  assert.strictEqual(t.wire('pp:leave').length, 0);
  assert.strictEqual(t.win.location.replaced, null, 'no Spectate while the buy-in is with the wallet');
  assert.strictEqual(t.win.sessionStorage.getItem('dsWatch'), null);

  // An answer to some other request (another nonce) is not taken.
  t.fromLobby({ type: 'duel:restake:done', entryToken: 'tok-other', nonce: 'not-mine' });
  assert.strictEqual(t.wire('pp:respawn').length, 0);
  // The wallet answers: the new token goes straight into a respawn on the same socket.
  t.fromLobby({ type: 'duel:restake:done', entryToken: 'tok-2', nonce: ask.nonce });
  const respawns = t.wire('pp:respawn');
  assert.strictEqual(respawns.length, 1);
  assert.strictEqual(respawns[0][1].entryToken, 'tok-2');
  assert.strictEqual(t.card(), null, 'the card is gone while the new round starts');
  assert.strictEqual(t.api.page.lobbyLocked, false);
});

test('a restake error opens the way back and says why', () => {
  const t = paidDeadPage();
  t.btn('again').click();
  t.fromLobby({ type: 'duel:restake:error', message: 'Stake failed' });
  for (const b of t.lobbyButtons()) assert.strictEqual(b.disabled, false);
  assert.strictEqual(t.btn('spectate').disabled, false, 'Spectate opens with Lobby');
  assert.strictEqual(t.btn('again').disabled, false);
  assert.strictEqual(t.text(t.btn('again')), 'Play again');
  assert.deepStrictEqual(t.card().notes, ['Stake failed']);
  t.btn('lobby').click();
  assert.ok(t.parent.messages.indexOf('game:done') >= 0);
});

test('a wallet that never answers opens the way back after the safety window, and a late answer still plays', () => {
  const t = paidDeadPage();
  t.btn('again').click();
  t.clock.advance(RESTAKE_WAIT_MS - 1);
  for (const b of t.lobbyButtons()) assert.strictEqual(b.disabled, true);
  assert.strictEqual(t.btn('spectate').disabled, true);
  t.clock.advance(1);
  for (const b of t.lobbyButtons()) assert.strictEqual(b.disabled, false);
  // Lobby clears the frame, so a stake that lands late opens its round there; this page watching in the frame
  // would leave it no seat, so Spectate stays shut while the buy-in may still land.
  assert.strictEqual(t.btn('spectate').disabled, true, 'no Spectate while a buy-in may still land');
  t.btn('spectate').dispatch('click');
  assert.strictEqual(t.win.location.replaced, null);
  assert.strictEqual(t.card().notes.length, 1);
  assert.match(t.card().notes[0], /^Your wallet has not answered yet/);
  assert.strictEqual(t.text(t.btn('again')), 'Waiting for your wallet...');
  assert.strictEqual(t.btn('again').disabled, true, 'no second buy-in while one may land');
  t.fromLobby({ type: 'duel:restake:done', entryToken: 'tok-late' });
  assert.strictEqual(t.wire('pp:respawn').length, 1);
  assert.strictEqual(t.wire('pp:respawn')[0][1].entryToken, 'tok-late');
});

test('a paid join buffered while the link was down is waited for, not reported lost', () => {
  const t = paidDeadPage();
  t.sock.drop(); // on the dead card: nothing to resume
  t.btn('again').click();
  t.fromLobby({ type: 'duel:restake:done', entryToken: 'tok-2' });
  assert.strictEqual(t.wire('pp:join').length, 1, 'only the first join so far');
  t.sock.connect('sock-b'); // socket.io sends the buffered join, then fires connect
  const joins = t.wire('pp:join');
  assert.strictEqual(joins.length, 2);
  assert.strictEqual(joins[1][1].entryToken, 'tok-2');
  assert.strictEqual(t.card(), null, 'no "connection dropped while joining" card');
  assert.strictEqual(t.api.page.screen, 'connecting');
  assert.strictEqual(t.doc.activeElement, null, 'nothing on a gone card took the focus');
  t.joined({ stake: 0.1, you: 9, resumeKey: 'rk-2' });
  assert.strictEqual(t.api.page.phase, 'live');
  assert.strictEqual(t.wire('pp:leave').length, 0);
});

// Item 2 of STATUS "BEFORE PAPER_PAID IS SWITCHED ON": this page used to give up here ("If
// your entry was taken, its money dropped where your square stood") and the seat it had paid
// for was orphaned. It now asks again with the same token, once per new link, until answered.
test('a paid join lost before pp:joined is asked again with the same token on the next link', () => {
  const t = page({ stake: 0.1, entryToken: 'tok-1' });
  t.sock.connect('sock-a'); // the first join goes out on this link
  t.sock.drop(); // before pp:joined
  t.sock.connect('sock-b');
  const joins = t.wire('pp:join');
  assert.strictEqual(joins.length, 2, 'asked again on the new link');
  assert.strictEqual(joins[1][1].entryToken, 'tok-1', 'with the token that bought the seat');
  assert.strictEqual(joins[1][1].stake, 0.1);
  assert.strictEqual(t.card(), null, 'no "money dropped" card');
  assert.strictEqual(t.api.page.screen, 'connecting');
  assert.strictEqual(t.win.sessionStorage.getItem('entryToken'), null, 'still never written back to storage');
  // The server hands back the seat: live, and the token is forgotten for good.
  t.joined({ stake: 0.1 });
  assert.strictEqual(t.api.page.phase, 'live');
  t.sock.drop();
  t.sock.connect('sock-c');
  assert.strictEqual(t.wire('pp:join').length, 3, 'the reconnect after pp:joined is the resumeKey one');
  assert.strictEqual(t.wire('pp:join')[2][1].entryToken, undefined);
  assert.strictEqual(t.wire('pp:join')[2][1].resumeKey, 'rk-1');
});

test('a paid join lost before pp:joined that the server refunded shows the refund, and asks no more', () => {
  const t = page({ stake: 0.1, entryToken: 'tok-1' });
  t.sock.connect('sock-a');
  t.sock.drop();
  t.sock.connect('sock-b');
  t.sock.fire('pp:refused', { why: 'join-lost', text: 'x', refunded: true });
  assert.strictEqual(t.api.page.screen, 'refused');
  assert.strictEqual(t.card().verdict, 'Could not join');
  assert.deepStrictEqual(t.card().notes, ['The connection dropped while you were joining.', 'Your entry was refunded to your wallet.']);
  assert.deepStrictEqual(t.card().buttons, ['Lobby']);
  t.sock.drop();
  t.sock.connect('sock-c');
  assert.strictEqual(t.wire('pp:join').length, 2, 'an answered token is never sent again');
});

test('a paid respawn lost before pp:joined is asked again as a join with the same token', () => {
  const t = paidDeadPage();
  t.btn('again').click();
  t.fromLobby({ type: 'duel:restake:done', entryToken: 'tok-2', nonce: t.parent.messages[0].nonce });
  assert.strictEqual(t.wire('pp:respawn').length, 1);
  t.sock.drop();
  t.sock.connect('sock-b');
  const joins = t.wire('pp:join');
  assert.strictEqual(joins.length, 2);
  assert.strictEqual(joins[1][1].entryToken, 'tok-2');
  assert.strictEqual(joins[1][1].stake, 0.1);
});

test('free: a lost join is asked again without a token; a buffered one is not doubled', () => {
  const lost = page();
  lost.sock.connect('sock-a');
  lost.sock.drop();
  lost.sock.connect('sock-b');
  const joins = lost.wire('pp:join');
  assert.strictEqual(joins.length, 2);
  assert.strictEqual(joins[1][1].entryToken, undefined);
  assert.strictEqual(lost.api.page.screen, 'connecting');

  const buffered = page();
  buffered.sock.connect('sock-a');
  buffered.joined();
  buffered.sock.fire('pp:dead', { reason: 2 });
  buffered.clock.advance(1000);
  buffered.sock.drop();
  buffered.btn('again').click(); // free: a join, buffered
  buffered.sock.connect('sock-b');
  assert.strictEqual(buffered.wire('pp:join').length, 2, 'the buffered join only, no second one');
});

test('the refused card says the reason once and the refund only when refunded', () => {
  const full = page({ stake: 0.1, entryToken: 'tok-1' });
  full.sock.connect('sock-a');
  full.sock.fire('pp:refused', { why: 'full', text: 'Every Paper table at this stake is full. Your entry was refunded.', refunded: true });
  assert.deepStrictEqual(full.card().notes, ['Every Paper table at this stake is full.', 'Your entry was refunded to your wallet.']);
  assert.strictEqual(full.doc.activeElement, full.btn('lobby'), 'the only way back has the focus');

  const maint = page();
  maint.sock.connect('sock-a');
  maint.sock.fire('pp:refused', { why: 'maintenance', text: 'DuelSeries is updating. Your entry was refunded.', refunded: false });
  assert.deepStrictEqual(maint.card().notes, ['DuelSeries is updating. Try again in a few minutes.']);

  const other = page();
  other.sock.connect('sock-a');
  other.sock.fire('pp:refused', { why: 'something-new', text: 'A new reason.', refunded: false });
  assert.deepStrictEqual(other.card().notes, ['A new reason.']);
});

// ---- The shared end cards and board (public/js/shared/dsEnd.js) -----------------------------

// Squares as the mirror keeps them (game.units, sorted by score), land as the stock plates print it.
function sq(id, name, pct, extra) {
  return Object.assign({ id, name, percent: pct / 100, bestPercent: pct / 100, death: null,
    schemes: { print() { return (this.u.percent * 100).toFixed(2) + '%'; } } }, extra || {});
}
function seat(t, mePct, others) {
  const me = sq(7, 'Tester', mePct);
  const list = others.map((p, i) => sq(20 + i, 'Bot ' + (i + 1), p)).concat([me]);
  list.forEach((u) => { u.schemes.u = u; });
  list.sort((a, b) => b.percent - a.percent);
  t.game.player = me;
  t.game.units = list;
  return me;
}
// One drawn frame (the page's renderer wrapper: the land kept for the card, the board).
function frame(t) {
  t.game.renderer(t.game);
}

test('free death: how it happened, the land at death, time and best rank; Play again respawns on the same socket', () => {
  const t = page();
  t.sock.connect('sock-a');
  t.joined();
  const me = seat(t, 18.4, [30, 12]);
  frame(t);
  t.clock.advance(65000);
  // The square dies: its land is gone from the frame by the time the card shows.
  me.percent = 0;
  me.death = true;
  t.sock.fire('pp:dead', { reason: 0, killerId: 3, killerName: '<b>Kestrel</b>' });
  assert.strictEqual(t.card(), null, 'the follow-killer glide plays first');
  t.clock.advance(2000);
  const c = t.card();
  assert.strictEqual(c.tone, 'plain');
  assert.strictEqual(c.verdict, 'Killed by <b>Kestrel</b>', 'the name is text, never markup');
  assert.strictEqual(c.hero, 'Free');   // a free game says Free; its score is the first tray row (Owen 2026-10-16)
  assert.strictEqual(c.unit, null);
  assert.deepStrictEqual(c.facts, [['Land', '18.40%'], ['Time', '1:05'], ['Top rank', '2nd']]);
  assert.deepStrictEqual(c.ledger, []);
  assert.deepStrictEqual(c.buttons, ['Lobby', 'Spectate', 'Play again']);   // the same three in every game (Owen 2026-10-16)
  assert.strictEqual(t.doc.activeElement, t.btn('again'), 'a free Play again is the keyboard default');
  t.btn('again').click();
  assert.strictEqual(t.wire('pp:respawn').length, 1, 'the same socket: a respawn');
  assert.strictEqual(t.card(), null);
  assert.strictEqual(t.api.page.screen, 'connecting');

  const self = page();
  self.sock.connect('sock-a');
  self.joined();
  seat(self, 5, []);
  frame(self);
  self.sock.fire('pp:dead', { reason: 1 });
  self.clock.advance(1000);
  assert.strictEqual(self.card().verdict, 'You crossed your own trail');
  assert.deepStrictEqual(self.card().facts, [['Land', '5.00%'], ['Time', '0:00'], ['Top rank', '1st']]);   // the land first in the tray (Owen 2026-10-16)
});

test('free cash-out: Cashed out, the best land this round; Enter plays again', () => {
  const t = page();
  t.sock.connect('sock-a');
  t.joined();
  const me = seat(t, 20, [22, 4]);
  me.bestPercent = 0.25;
  frame(t);
  t.clock.advance(3000);
  t.sock.fire('pp:cashedout', { grossMicro: 0, cutMicro: 0, netMicro: 0 });
  const c = t.card();
  assert.strictEqual(t.api.page.screen, 'cashed');
  assert.strictEqual(c.verdict, 'Cashed out');
  assert.strictEqual(c.hero, 'Free');   // a free game says Free; its score is the first tray row (Owen 2026-10-16)
  assert.strictEqual(c.unit, null);
  assert.deepStrictEqual(c.facts, [['Best land', '25.00%'], ['Time', '0:03'], ['Top rank', '2nd']]);
  assert.deepStrictEqual(c.ledger, []);
  assert.strictEqual(c.status, null);
  t.doc.activeElement = null;
  t.keydown({ key: 'Enter' });
  assert.strictEqual(t.wire('pp:respawn').length, 1);
});

test('paid death: the stake lost as the server says, how, time, rank and best land; no keyboard default', () => {
  const t = page({ stake: 0.5, entryToken: 'tok-1' });
  t.sock.connect('sock-a');
  t.joined({ stake: 0.5 });
  const me = seat(t, 12.3, [40, 30, 20]);
  frame(t);
  t.clock.advance(125000);
  me.death = true;
  t.sock.fire('pp:dead', { reason: 2, lostMicro: 500000 });
  t.clock.advance(1000);
  const c = t.card();
  assert.strictEqual(c.tone, 'loss');
  assert.strictEqual(c.verdict, 'You hit the wall');
  assert.strictEqual(c.hero, '−$0.50');
  assert.strictEqual(c.unit, null);   // money lost stands alone (Owen 2026-10-16)
  assert.deepStrictEqual(c.facts, [['Time', '2:05'], ['Top rank', '4th'], ['Best land', '12.30%']]);
  assert.deepStrictEqual(c.buttons, ['Lobby', 'Spectate', 'Play again']);   // the same three in every game (Owen 2026-10-16)
  assert.strictEqual(t.doc.activeElement, null, 'a paid Play again (a new buy-in) is never the keyboard default');
  t.doc.activeElement = null;
  t.keydown({ key: 'Enter' });
  assert.strictEqual(t.parent.messages.length, 0, 'Enter never buys a paid round');
});

test('paid cash-out: the receipt from pp:cashedout, then the payout status (sent, or delayed)', () => {
  const t = page({ stake: 0.5, entryToken: 'tok-1' });
  t.sock.connect('sock-a');
  t.joined({ stake: 0.5 });
  seat(t, 31, [10]);
  frame(t);
  t.clock.advance(61000);
  t.sock.fire('pp:cashedout', { grossMicro: 1500000, cutMicro: 150000, netMicro: 1350000 });
  let c = t.card();
  assert.strictEqual(c.tone, 'win');
  assert.strictEqual(c.verdict, 'Cashed out');
  assert.strictEqual(c.hero, '$1.35');
  assert.strictEqual(c.unit, null, 'money won stands alone (Owen: no "to your wallet")');
  assert.deepStrictEqual(c.ledger, [['Cashed out', '$1.50'], ['House 10%', '−$0.15'], ['You receive', '$1.35']]);
  assert.deepStrictEqual(c.facts, [['Time', '1:01'], ['Top rank', '1st'], ['Best land', '31.00%']]);
  assert.deepStrictEqual(c.status, { text: 'Sending to your wallet', state: 'pending', href: null });
  assert.deepStrictEqual({ ...t.win.events.find((e) => e[0] === 'cashed_out')[1] }, { game: 'paper', amount: 1.35, stake: 0.5 });
  t.sock.fire('pp:paid', { sig: 'abc' });
  c = t.card();
  assert.strictEqual(c.status.state, 'ok');
  assert.strictEqual(c.status.text, 'Sent to your wallet.View transaction');
  assert.strictEqual(c.status.href, 'https://solscan.io/tx/abc');
  t.sock.fire('pp:payerror', {});
  assert.deepStrictEqual(t.card().status, { text: 'Payout delayed. Your winnings are recorded and will be sent.', state: 'err', href: null });
  assert.deepStrictEqual(t.card().ledger.length, 3, 'the receipt stays');
});

test('Lobby on a card: pp:leave then game:done in the lobby frame, or / on its own; an unframed paid Play again cannot be pressed', () => {
  const t = page();
  t.sock.connect('sock-a');
  t.joined();
  t.sock.fire('pp:replaced');
  assert.strictEqual(t.api.page.screen, 'gone');
  assert.strictEqual(t.card().verdict, 'Disconnected');
  assert.deepStrictEqual(t.card().notes, ['This seat was taken over by a newer connection.']);
  assert.deepStrictEqual(t.card().buttons, ['Lobby']);
  t.btn('lobby').click();
  assert.strictEqual(t.wire('pp:leave').length, 1);
  assert.ok(t.parent.messages.indexOf('game:done') >= 0);

  const alone = page({ stake: 0.5, entryToken: 'tok-1', framed: false });
  alone.sock.connect('sock-a');
  alone.joined({ stake: 0.5 });
  alone.sock.fire('pp:dead', { reason: 2, lostMicro: 500000 });
  alone.clock.advance(1000);
  assert.deepStrictEqual(alone.card().buttons, ['Lobby', 'Spectate', 'Play again']);
  assert.strictEqual(alone.btn('again').disabled, true, 'no lobby wallet to buy the next round with');
  alone.btn('again').dispatch('click');
  assert.strictEqual(alone.api.page.restaking, false);
  assert.strictEqual(alone.api.page.screen, 'dead');
  assert.strictEqual(alone.btn('spectate').disabled, false);
  alone.btn('lobby').click();
  assert.strictEqual(alone.win.location.href, '/');
});

// ---- Lobby, Spectate, Play again on every card that closes a life (Owen 2026-10-16) -------------

// The card's buttons as dsEnd lays them out: [id, text, primary].
function cardButtons(t) {
  return t.card() ? t.doc.querySelectorAll('.dse-btn')
    .map((b) => [b.getAttribute('data-dse-btn'), t.text(b), /(^| )pri( |$)/.test(b.className)]) : null;
}
function freeDead() {
  const t = page();
  t.sock.connect('sock-a');
  t.joined();
  t.sock.fire('pp:dead', { reason: 2 });
  t.clock.advance(1000);
  assert.strictEqual(t.api.page.screen, 'dead');
  return t;
}
function freeCashed() {
  const t = page();
  t.sock.connect('sock-a');
  t.joined();
  t.sock.fire('pp:cashedout', { grossMicro: 0, cutMicro: 0, netMicro: 0 });
  assert.strictEqual(t.api.page.screen, 'cashed');
  return t;
}
function paidCashed() {
  const t = page({ stake: 0.5, entryToken: 'tok-1' });
  t.sock.connect('sock-a');
  t.joined({ stake: 0.5 });
  t.sock.fire('pp:cashedout', { grossMicro: 1500000, cutMicro: 150000, netMicro: 1350000 });
  assert.strictEqual(t.api.page.screen, 'cashed');
  return t;
}
const THREE = [['lobby', 'Lobby', false], ['spectate', 'Spectate', false], ['again', 'Play again', true]];

test('every death and cash-out card, paid and free, has Lobby, Spectate and Play again in that order', () => {
  for (const [name, t] of [['free death', freeDead()], ['free cash-out', freeCashed()],
    ['paid death', paidDeadPage()], ['paid cash-out', paidCashed()]]) {
    assert.deepStrictEqual(cardButtons(t), THREE, name);
    for (const id of ['lobby', 'spectate', 'again']) assert.strictEqual(t.btn(id).disabled, false, name + ' ' + id);
  }
  // The notice cards keep only the way back.
  const gone = page();
  gone.sock.connect('sock-a');
  gone.joined();
  gone.sock.fire('pp:replaced');
  assert.deepStrictEqual(cardButtons(gone), [['lobby', 'Lobby', true]]);
});

test('Spectate on a free card: pp:leave, the lobby\'s watch mark, and the page opens again watching the free table', () => {
  for (const t of [freeDead(), freeCashed()]) {
    t.win.sessionStorage.setItem('spectateOnly', 'true'); // any money key a page could read goes, as the lobby does
    t.btn('spectate').click();
    assert.strictEqual(t.wire('pp:leave').length, 1, 'the seat is let go, as Lobby lets it go');
    assert.strictEqual(t.win.sessionStorage.getItem('dsWatch'), 'paper');
    assert.strictEqual(t.win.sessionStorage.getItem('dsWatchStake'), null, 'the free table');
    assert.strictEqual(t.win.sessionStorage.getItem('spectateOnly'), null);
    assert.strictEqual(t.win.location.replaced, '/paper-arena', 'the page the lobby\'s Spectate opens');
    assert.strictEqual(t.parent.messages.indexOf('game:done'), -1, 'the frame stays: it is watching now');
    // The page that opens is a watcher: one pp:watch for the free table, no join.
    const w = page({ seed: t.win.sessionStorage.entries() });
    w.sock.connect('sock-w');
    assert.strictEqual(w.api.page.watch, true);
    assert.deepStrictEqual(w.sock.wire.map((p) => p[0]), ['pp:watch']);
    assert.deepStrictEqual({ ...w.wire('pp:watch')[0][1] }, { stake: 0 });
  }
});

test('Spectate on a paid card watches the same rung read only: dsWatchStake, never stake, no token', () => {
  for (const t of [paidDeadPage(), paidCashed()]) {
    const stake = t.api.page.stake;
    t.win.sessionStorage.setItem('entryToken', 'tok-stale');
    t.btn('spectate').click();
    const ss = t.win.sessionStorage;
    assert.strictEqual(ss.getItem('dsWatch'), 'paper');
    assert.strictEqual(ss.getItem('dsWatchStake'), String(stake), 'the table to watch, its own key');
    assert.strictEqual(ss.getItem('stake'), null, 'never a buy-in');
    assert.strictEqual(ss.getItem('entryToken'), null);
    assert.strictEqual(t.wire('pp:leave').length, 1);
    assert.strictEqual(t.parent.messages.length, 0, 'no game:done and no restake');
    assert.strictEqual(t.win.location.replaced, '/paper-arena');
    const w = page({ seed: ss.entries() });
    w.sock.connect('sock-w');
    assert.deepStrictEqual(w.sock.wire.map((p) => p[0]), ['pp:watch']);
    assert.deepStrictEqual({ ...w.wire('pp:watch')[0][1] }, { stake });
    assert.ok(!JSON.stringify(w.sock.wire).includes('tok'), 'no entry token leaves the watcher');
    assert.strictEqual(w.api.session.stake, 0);
  }
});

test('the board: the stock plates never draw, the shared board ranks the live squares by land with yours pinned', () => {
  const t = page();
  assert.strictEqual(t.boardEl().style.display, 'none', 'no board before there is a square');
  t.sock.connect('sock-a');
  t.joined();
  const others = [30, 28, 26, 24, 22, 20, 18, 16, 14, 12, 10];
  seat(t, 2, others);
  t.game.units.push(sq(99, 'Gone', 50, { death: true })); // a dead square is not ranked
  t.game.units[0].schemes.u = t.game.units[0];
  t.game.topListChanged = true;
  assert.strictEqual(t.game.topListChanged, false, 'paperRender.js never sees the flag up, so the plates never draw');
  frame(t);
  assert.strictEqual(t.boardEl().style.display, '');
  const rows = t.boardRows();
  assert.strictEqual(rows.length, 12, 'ten rows (PC), the gap, then yours');
  assert.deepStrictEqual(rows[0], ['', '1', 'Bot 1', '30.00%']);
  assert.deepStrictEqual(rows[9], ['', '10', 'Bot 10', '12.00%']);
  assert.strictEqual(rows[10][0], 'gap');
  assert.deepStrictEqual(rows[11], ['me', '12', 'Tester', '2.00%']);
  // The board redraws on the next raise, at most every 200 ms.
  t.game.player.percent = 0.5;
  t.game.units.sort((a, b) => (a.death ? 1 : 0) - (b.death ? 1 : 0) || b.percent - a.percent);
  t.game.topListChanged = true;
  frame(t);
  assert.deepStrictEqual(t.boardRows()[11], ['me', '12', 'Tester', '2.00%'], 'not yet');
  t.clock.advance(200);
  frame(t);
  assert.deepStrictEqual(t.boardRows()[0], ['me', '1', 'Tester', '50.00%']);
  assert.strictEqual(t.boardRows().length, 10);
  // A new round starting covers the board with the connecting layer.
  t.sock.fire('pp:dead', { reason: 2 });
  t.clock.advance(1000);
  t.btn('again').click();
  frame(t);
  assert.strictEqual(t.boardEl().style.display, 'none');
});

test('a paid board ranks the live squares by their $ (bots too), most first, with yours pinned by worth', () => {
  const t = page({ stake: 0.5, entryToken: 'tok-1' });
  t.sock.connect('sock-a');
  t.joined({ stake: 0.5 });
  const me = seat(t, 40, [30, 20, 10]);
  const micro = { 20: 300000, 21: 1250000, 22: 0 };
  for (const u of t.game.units) u.micro = u === me ? 450000 : micro[u.id];
  frame(t);
  assert.ok(t.boardEl().className.split(' ').includes('money'), 'the gold money board');
  assert.deepStrictEqual(t.boardRows().map((r) => r.slice(1)), [['1', 'Bot 2', '$1.25'], ['2', 'Tester', '$0.45'],
    ['3', 'Bot 1', '$0.30'], ['4', 'Bot 3', '$0.00']], 'by money, not land');
  assert.strictEqual(t.boardRows()[1][0], 'me');
  // money moves with no stock raise: redrawn within 200 ms all the same
  me.micro = 2000000;
  t.clock.advance(200);
  frame(t);
  assert.deepStrictEqual(t.boardRows()[0], ['me', '1', 'Tester', '$2.00']);
});

// ---- Watch mode (the lobby's Spectate) -------------------------------------------------------

const WATCH_STATE = { tick: 100, radius: 950, targetRadius: 950, follow: 2, units: [], rings: [], trails: [], pickups: [] };

// A watch page with a mirror double that follows like the real one: Next and Previous walk the given squares.
function watchPage(squares = [{ id: 2, name: 'bob' }, { id: 3, name: 'cat' }, { id: 4, name: '' }]) {
  const t = page({ watch: 'paper', stake: 0.5, entryToken: 'tok-stale' });
  const g = t.game;
  g.player = null;
  const step = (d) => function () {
    const i = squares.indexOf(this.player);
    this.player = squares[(i + d + squares.length) % squares.length];
    if (this.onFollow) this.onFollow(this.player);
    return this.player;
  };
  g.followNext = step(1);
  g.followPrev = step(-1);
  t.state = () => {
    g.player = squares[0];
    t.sock.fire('pp:watching', WATCH_STATE);
  };
  return t;
}

const FINDING = 'Finding a player'; // the bar's plate before a table
const shown = (b) => ({ on: b.on, empty: b.empty, busy: b.busy, text: b.text });

test('watch mode: the mark is read once and removed, no pp:join, no token, one pp:watch { stake: 0 }', () => {
  const t = watchPage();
  assert.strictEqual(t.win.sessionStorage.getItem('dsWatch'), null, 'removed at boot');
  assert.strictEqual(t.api.page.watch, true);
  assert.strictEqual(t.api.page.stake, 0);
  t.sock.connect('sock-w');
  assert.deepStrictEqual(t.sock.wire.map((p) => p[0]), ['pp:watch']);
  assert.deepStrictEqual({ ...t.wire('pp:watch')[0][1] }, { stake: 0 });
  assert.ok(!JSON.stringify(t.sock.wire).includes('tok-stale'), 'no entry token ever leaves a watch page');
  // The shared bar from the start: its Lobby works, it is finding a player with the arrows off until a table.
  assert.deepStrictEqual(shown(t.bar()), { on: true, empty: false, busy: true, text: FINDING });
  assert.strictEqual(t.barNext().disabled, true);
  assert.strictEqual(t.barPrev().disabled, true);
  assert.match(t.barLobby().style.top, /^\d+px$/, 'Lobby sits under the stock score stack');

  // Any other mark plays as usual, and is removed too.
  const other = page({ watch: 'slither' });
  assert.strictEqual(other.win.sessionStorage.getItem('dsWatch'), null);
  assert.strictEqual(other.api.page.watch, false);
  other.sock.connect('sock-o');
  assert.strictEqual(other.wire('pp:join').length, 1);
  assert.strictEqual(other.wire('pp:watch').length, 0);
  assert.strictEqual(other.bar().on, false, 'no bar on a playing page');
});

test('watch mode: the bar names the followed square, Next and Previous switch at once, never live, Lobby leaves', () => {
  const t = watchPage();
  t.sock.connect('sock-w');
  t.state();
  assert.strictEqual(t.api.page.watchLive, true);
  assert.strictEqual(t.api.page.phase, 'watch');
  assert.strictEqual(t.$('pp-connecting').hidden, true);
  assert.deepStrictEqual(shown(t.bar()), { on: true, empty: false, busy: false, text: 'bob' });
  assert.deepStrictEqual({ ...t.api.watchState() }, { watching: true, live: true, followId: 2, followName: 'bob', followDead: false });
  // No Play, cash-out or hold control, and the hold never reaches the game.
  assert.strictEqual(t.$('pp-cash').hidden, true);
  assert.strictEqual(t.$('pp-hint').hidden, true);
  t.api.setHold(true);
  assert.deepStrictEqual(t.game.holds, []);
  t.barNext().click();
  assert.strictEqual(t.bar().text, 'cat');
  assert.strictEqual(t.api.watchState().followId, 3);
  t.barNext().click();
  assert.strictEqual(t.bar().text, 'Player', 'a nameless square gets the default name');
  t.barPrev().click();
  assert.strictEqual(t.bar().text, 'cat');
  t.barPrev().click();
  t.barPrev().click();
  assert.strictEqual(t.bar().text, 'Player', 'Previous from the leader goes round to the last');
  // PC keys: Right and Space are next, Left is previous.
  const key = (k) => t.keydown({ key: k, stopImmediatePropagation() {} });
  key('ArrowRight');
  assert.strictEqual(t.bar().text, 'bob');
  key(' ');
  assert.strictEqual(t.bar().text, 'cat');
  key('ArrowLeft');
  assert.strictEqual(t.bar().text, 'bob');
  // The mirror moving on by itself (the followed square died) updates the plate too.
  t.game.player = { id: 9, name: 'zed' };
  t.game.onFollow(t.game.player);
  assert.strictEqual(t.bar().text, 'zed');
  // Nobody alive on the shown table: the empty table.
  t.game.player = null;
  t.game.onFollow(null);
  assert.deepStrictEqual(shown(t.bar()), { on: true, empty: true, busy: false, text: 'Nobody is playing yet' });
  assert.strictEqual(t.wire('pp:join').length + t.wire('pp:respawn').length + t.wire('pp:in').length, 0);
  t.barLobby().click();
  assert.strictEqual(t.wire('pp:leave').length, 1);
  assert.ok(t.parent.messages.indexOf('game:done') >= 0);
  assert.strictEqual(t.api.net.watching, false);
  assert.strictEqual(t.bar().on, false, 'the bar closes with the watch');
  // Gone for good: no more asks.
  t.clock.advance(10000);
  assert.strictEqual(t.wire('pp:watch').length, 1);
});

test('watch mode: nobody playing shows the empty table and asks again every 3 s, never while the link is down', () => {
  const t = watchPage();
  t.sock.connect('sock-w');
  t.sock.fire('pp:watching', { none: true, why: 'nobody', text: 'Nobody is playing right now.' });
  assert.deepStrictEqual(shown(t.bar()), { on: true, empty: true, busy: false, text: 'Nobody is playing yet' });
  assert.strictEqual(t.$('pp-connecting-text').textContent, 'Nobody is playing right now');
  t.clock.advance(2999);
  assert.strictEqual(t.wire('pp:watch').length, 1);
  t.clock.advance(1);
  assert.strictEqual(t.wire('pp:watch').length, 2);
  t.clock.advance(3000);
  assert.strictEqual(t.wire('pp:watch').length, 3);
  t.state();
  assert.deepStrictEqual(shown(t.bar()), { on: true, empty: false, busy: false, text: 'bob' });
  t.clock.advance(9000);
  assert.strictEqual(t.wire('pp:watch').length, 3, 'a table is shown: no more asks');
  // The server lets the watcher go (the last player left): the empty table again, and asks again.
  t.sock.fire('pp:watching', { none: true, why: 'nobody' });
  assert.strictEqual(t.api.page.watchLive, false);
  assert.strictEqual(t.bar().empty, true);
  t.clock.advance(3000);
  assert.strictEqual(t.wire('pp:watch').length, 4);
  // Any other reason keeps its own words on show, the bar finding a player with the arrows off.
  t.sock.fire('pp:watching', { none: true, why: 'full' });
  assert.strictEqual(t.$('pp-connecting-text').textContent, 'Too many people are watching right now');
  assert.deepStrictEqual(shown(t.bar()), { on: true, empty: false, busy: true, text: FINDING });
  t.state();
  // The link drops: Reconnecting, the plate kept with the arrows off, nothing asked while down, one ask when back.
  t.sock.drop();
  assert.strictEqual(t.$('pp-connecting-text').textContent, 'Reconnecting...');
  assert.deepStrictEqual(shown(t.bar()), { on: true, empty: false, busy: true, text: 'bob' });
  t.barNext().click();
  assert.strictEqual(t.bar().text, 'bob', 'no switch while the link is down');
  t.clock.advance(9000);
  const asked = t.wire('pp:watch').length;
  assert.strictEqual(t.sock.sendBuffer.length, 0, 'no pile of asks waiting for the link');
  t.sock.connect('sock-w2');
  assert.strictEqual(t.wire('pp:watch').length, asked + 1);
  assert.deepStrictEqual({ ...t.wire('pp:watch')[asked][1] }, { stake: 0 });
  t.state();
  assert.strictEqual(t.$('pp-connecting').hidden, true);
  assert.deepStrictEqual(shown(t.bar()), { on: true, empty: false, busy: false, text: 'bob' });
  assert.strictEqual(t.wire('pp:join').length, 0);
});

// ---- HUD: the world pass stays under the stock screen HUD ----------------------------------

function hudGame(vw, vh) {
  const schemes = (v) => ({ scores: () => v, print: () => (v * 100).toFixed(2) + '%' });
  const player = {
    id: 1, micro: 100000, position: { x: 1000, y: 1000 }, schemes: schemes(0.1),
    statistics: { kills: 3 }, death: null, holding: false
  };
  const others = [0.3, 0.2, 0.15, 0.12, 0.11].map((v, i) => ({
    id: 10 + i, micro: 0, position: { x: 1200 + i * 10, y: 1000 }, schemes: schemes(v), death: null
  }));
  const units = others.concat([player]);
  return {
    view: null,
    origin: { x: 1000, y: 1000 },
    scale: 1,
    config: { font: 'PT Sans Caption', trackWidth: 10 },
    units,
    player,
    pickups: new Map([[1, { pid: 1, x: 1010, y: 1010, micro: 50000 }]]),
    space: { width: 2000, height: 2000 },
    border: { center: { x: 1000, y: 1000 }, radius: 1000 },
    language: { bestTxt: 'Best' },
    best: 0.2,
    isPlayer(u) { return u === player; },
    byId: new Map(units.map((u) => [u.id, u])),
    vw,
    vh
  };
}

function overlaps(a, b) {
  return a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
}

test('the stock HUD holes match paperRender.js at 1366 x 768, leave the top right open, and never overlap', () => {
  const ctx = { save() {}, restore() {}, font: '', measureText: (s) => ({ width: s.length * 9 }) };
  const g = hudGame(1366, 768);
  const holes = Hud.stockHudHoles(ctx, g, 1366, 768, 1);
  // drawPlayerScoreBar: fontSize 19, padding 16, backHeight 4, barHeight 28, barWidth 341
  assert.deepStrictEqual(holes.rects[0], [0, 16, 341, 32]);
  // renderMinimap: size 1366 / 8, at the bottom right inside the padding, the disc inscribed
  const size = 1366 / Hud.calcMult(1366, 768, 8, 3);
  assert.ok(Math.abs(holes.disc.cx - (1366 - 16 - size / 2)) < 1e-9);
  assert.ok(Math.abs(holes.disc.cy - (768 - 16 - size / 2)) < 1e-9);
  assert.ok(holes.disc.rx > size / 2 && holes.disc.rx < size / 2 + 4);
  // the score bar, the best line and the kill pill only: the leaderboard plates are off on the arena page (its
  // board is the shared DOM one), so nothing at the top right is cut out of the world pass
  assert.strictEqual(holes.rects.length, 3);
  for (const r of holes.rects) assert.ok(r[0] + r[2] <= 341, 'every hole is in the top-left stack');
  for (const [w, h, s] of [[1366, 768, 1], [375, 812, 0.66], [812, 375, 0.66], [3840, 2160, 2.81]]) {
    const hs = Hud.stockHudHoles(ctx, g, w, h, s);
    for (let i = 0; i < hs.rects.length; i++) {
      for (let j = i + 1; j < hs.rects.length; j++) {
        assert.ok(!overlaps(hs.rects[i], hs.rects[j]), `holes ${i} and ${j} overlap at ${w}x${h}`);
      }
    }
  }
});

test('coins, money labels and rings are drawn inside the clip; the minimap dots and hold line are not', () => {
  const ops = [];
  const stack = [];
  let clipped = false;
  const path = [];
  const ctx = {
    font: '',
    save() { stack.push(clipped); },
    restore() { clipped = stack.pop(); },
    resetTransform() {}, translate() {}, scale() {}, setLineDash() {},
    beginPath() { path.length = 0; },
    rect(...a) { path.push(['rect', ...a]); },
    moveTo() {},
    ellipse(...a) { path.push(['ellipse', ...a]); },
    arc() {},
    clip(rule) { clipped = true; ops.push(['clip', rule, path.slice()]); },
    fill() { ops.push(['fill', clipped]); },
    stroke() { ops.push(['stroke', clipped]); },
    fillText(text) { ops.push(['text', clipped, text]); },
    strokeText() {},
    measureText: (s) => ({ width: s.length * 9 })
  };
  const g = hudGame(1366, 768);
  g.view = { width: 1366, height: 768, getContext: () => ctx };
  const hud = Hud.create({ now: () => 0 });
  hud.draw(g);
  const clip = ops.find((o) => o[0] === 'clip');
  assert.ok(clip, 'the world pass is clipped');
  assert.strictEqual(clip[1], 'evenodd');
  assert.deepStrictEqual(clip[2][0], ['rect', 0, 0, 1366, 768]);
  assert.ok(clip[2].some((p) => p[0] === 'ellipse'), 'the minimap disc is cut out');
  const clipAt = ops.indexOf(clip);
  const texts = ops.filter((o) => o[0] === 'text');
  const coinDollar = texts.find((o) => o[2] === '$');
  const moneyLabel = texts.find((o) => o[2] === '$0.10');
  assert.ok(coinDollar && coinDollar[1], 'the coin is drawn under the clip');
  assert.ok(moneyLabel && moneyLabel[1], 'the money label is drawn under the clip');
  assert.ok(ops.indexOf(coinDollar) > clipAt);
  // After the world pass: the minimap coin dots are screen HUD, drawn with no clip.
  const lastFill = ops.filter((o) => o[0] === 'fill').pop();
  assert.strictEqual(lastFill[1], false);
});
