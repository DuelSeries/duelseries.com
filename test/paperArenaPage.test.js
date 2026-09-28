'use strict';
// The arena page (T12, design 8.5 and 8.6): paperArenaMain.js booted in a DOM double against
// the real ArenaNet and a socket double that buffers emits the way socket.io-client 4.8.3
// does (an emit made while the link is down waits in sendBuffer and is sent on the next
// connection BEFORE that connection's 'connect' event, client-dist socket.io.js onconnect ->
// emitBuffered -> emitReserved('connect')). Plus the HUD's world pass staying under the stock
// screen HUD (paperHud.js stockHudHoles).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const MP = require('../public/js/paper/mp/paperWire.js');
const Net = require('../public/js/paper/mp/paperNet.js');
const Hud = require('../public/js/paper/mp/paperHud.js');

const MAIN = fs.readFileSync(path.join(__dirname, '../public/js/paper/mp/paperArenaMain.js'), 'utf8');
const RESTAKE_WAIT_MS = 120000;

function clockDouble() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
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
    removeItem: (k) => m.delete(k)
  };
}

function page({ stake = 0, entryToken = null, framed = true } = {}) {
  const clock = clockDouble();
  const sock = ioSocket();
  const byId = new Map();
  const doc = {
    activeElement: null,
    listeners: {},
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    getElementById: (id) => byId.get(id) || null,
    querySelectorAll: (sel) => all(doc.body).filter((n) => matches(n, sel)),
    createElement: () => element()
  };
  function matches(n, sel) {
    return sel.charAt(0) === '.' ? n.classes.indexOf(sel.slice(1)) >= 0 : n.id === sel.slice(1);
  }
  function all(n) {
    return n.children.reduce((out, c) => out.concat([c], all(c)), []);
  }
  function element(id, classes, kids) {
    const n = {
      id: id || '',
      classes: classes || [],
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
      addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
      setAttribute() {},
      appendChild(c) { c.parent = this; this.children.push(c); return c; },
      contains(x) { for (let p = x; p; p = p.parent) if (p === this) return true; return false; },
      querySelector(sel) { return all(this).find((c) => matches(c, sel)) || null; },
      focus() { doc.activeElement = this; },
      blur() { if (doc.activeElement === this) doc.activeElement = null; },
      // A real click on a disabled button never reaches its listeners.
      click() { if (!this.disabled) this.dispatch('click'); },
      // The listeners themselves, as a stale or synthetic event would reach them.
      dispatch(t) {
        const evt = { type: t, target: this, currentTarget: this, preventDefault() {} };
        (this.listeners[t] || []).forEach((fn) => fn(evt));
      }
    };
    (kids || []).forEach((k) => n.appendChild(k));
    if (id) byId.set(id, n);
    return n;
  }
  const btn = (cls) => element('', cls);
  doc.body = element('body', [], [
    element('view'),
    element('pp-hint'), element('pp-cash', [], [element('pp-cash-fill'), element('pp-cash-label')]),
    element('pp-connecting', [], [element('pp-connecting-text'), element('pp-connecting-sub')]),
    element('pp-reconnecting'),
    element('pp-refused', [], [element('pp-refused-text'), element('pp-refused-refund'), btn(['pp-lobby'])]),
    element('pp-dead', [], [element('pp-dead-title'), element('pp-dead-big'), element('pp-dead-line'),
      element('pp-dead-error'), btn(['pp-again', 'pp-primary']), btn(['pp-lobby'])]),
    element('pp-cashed', [], [element('pp-cashed-title'), element('pp-cashed-big'),
      element('pp-receipt', [], [element('pp-gross'), element('pp-cut'), element('pp-net')]),
      element('pp-pay-status'), element('pp-cashed-error'), btn(['pp-again', 'pp-primary']), btn(['pp-lobby'])]),
    element('pp-gone', [], [element('pp-gone-title'), element('pp-gone-text'), btn(['pp-lobby'])]),
    element('pp-unsupported')
  ]);
  for (const id of ['pp-reconnecting', 'pp-refused', 'pp-dead', 'pp-cashed', 'pp-gone', 'pp-unsupported',
    'pp-hint', 'pp-cash', 'pp-refused-refund', 'pp-dead-error', 'pp-receipt', 'pp-pay-status', 'pp-cashed-error']) {
    byId.get(id).hidden = true;
  }

  const game = {
    renderer() {},
    loop() { this.looped = true; },
    holds: [],
    setHold(d) { this.holds.push(d); },
    player: null,
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
  const win = {
    document: doc,
    DuelPaperLib: P,
    io: () => sock,
    location: { search: '', href: '' },
    sessionStorage: storage(session),
    localStorage: storage(),
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
  vm.runInContext(MAIN, win);
  const api = P.arena;
  assert.ok(api, 'the page booted');
  return {
    win,
    doc,
    sock,
    clock,
    parent,
    api,
    game,
    $: (id) => byId.get(id),
    lobbyButtons: () => doc.querySelectorAll('.pp-lobby'),
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

// Paid, seated, then dead: the dead screen with Play again (framed) and Back to the lobby.
function paidDeadPage() {
  const t = page({ stake: 0.1, entryToken: 'tok-1' });
  t.sock.connect('sock-a');
  t.joined({ stake: 0.1 });
  assert.strictEqual(t.api.page.phase, 'live');
  t.sock.fire('pp:dead', { reason: 2, lostMicro: 100000 });
  t.clock.advance(1000);
  assert.strictEqual(t.api.page.screen, t.$('pp-dead'));
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

test('Back to the lobby is shut while a paid restake is with the wallet', () => {
  const t = paidDeadPage();
  const dead = t.$('pp-dead');
  dead.querySelector('.pp-again').click();
  assert.strictEqual(JSON.stringify(t.parent.messages), JSON.stringify([{ type: 'duel:restake', game: 'paper', stake: 0.1 }]));
  for (const b of t.lobbyButtons()) assert.strictEqual(b.disabled, true);
  // Even a click that reaches the listener (a stale event) neither leaves nor closes the frame.
  dead.querySelector('.pp-lobby').dispatch('click');
  assert.strictEqual(t.parent.messages.indexOf('game:done'), -1);
  assert.strictEqual(t.wire('pp:leave').length, 0);

  // The wallet answers: the new token goes straight into a respawn on the same socket.
  t.fromLobby({ type: 'duel:restake:done', entryToken: 'tok-2' });
  const respawns = t.wire('pp:respawn');
  assert.strictEqual(respawns.length, 1);
  assert.strictEqual(respawns[0][1].entryToken, 'tok-2');
  for (const b of t.lobbyButtons()) assert.strictEqual(b.disabled, false);
});

test('a restake error opens the way back and says why', () => {
  const t = paidDeadPage();
  t.$('pp-dead').querySelector('.pp-again').click();
  t.fromLobby({ type: 'duel:restake:error', message: 'Stake failed' });
  for (const b of t.lobbyButtons()) assert.strictEqual(b.disabled, false);
  assert.strictEqual(t.$('pp-dead').querySelector('.pp-again').disabled, false);
  assert.strictEqual(t.$('pp-dead-error').textContent, 'Stake failed');
  assert.strictEqual(t.$('pp-dead-error').hidden, false);
  t.$('pp-dead').querySelector('.pp-lobby').click();
  assert.ok(t.parent.messages.indexOf('game:done') >= 0);
});

test('a wallet that never answers opens the way back after the safety window, and a late answer still plays', () => {
  const t = paidDeadPage();
  t.$('pp-dead').querySelector('.pp-again').click();
  t.clock.advance(RESTAKE_WAIT_MS - 1);
  for (const b of t.lobbyButtons()) assert.strictEqual(b.disabled, true);
  t.clock.advance(1);
  for (const b of t.lobbyButtons()) assert.strictEqual(b.disabled, false);
  assert.strictEqual(t.$('pp-dead-error').hidden, false);
  assert.strictEqual(t.$('pp-dead').querySelector('.pp-again').disabled, true, 'no second buy-in while one may land');
  t.fromLobby({ type: 'duel:restake:done', entryToken: 'tok-late' });
  assert.strictEqual(t.wire('pp:respawn').length, 1);
  assert.strictEqual(t.wire('pp:respawn')[0][1].entryToken, 'tok-late');
});

test('a paid join buffered while the link was down is waited for, not reported lost', () => {
  const t = paidDeadPage();
  t.sock.drop(); // on the dead screen: nothing to resume
  t.$('pp-dead').querySelector('.pp-again').click();
  t.fromLobby({ type: 'duel:restake:done', entryToken: 'tok-2' });
  assert.strictEqual(t.wire('pp:join').length, 1, 'only the first join so far');
  t.sock.connect('sock-b'); // socket.io sends the buffered join, then fires connect
  const joins = t.wire('pp:join');
  assert.strictEqual(joins.length, 2);
  assert.strictEqual(joins[1][1].entryToken, 'tok-2');
  assert.strictEqual(t.$('pp-gone').hidden, true, 'no "connection dropped while joining" screen');
  assert.strictEqual(t.api.page.screen, t.$('pp-connecting'));
  assert.notStrictEqual(t.doc.activeElement, t.$('pp-gone').querySelector('.pp-lobby'));
  t.joined({ stake: 0.1, you: 9, resumeKey: 'rk-2' });
  assert.strictEqual(t.api.page.phase, 'live');
  assert.strictEqual(t.wire('pp:leave').length, 0);
});

test('a paid join that went out before the link dropped is reported, never resent', () => {
  const t = page({ stake: 0.1, entryToken: 'tok-1' });
  t.sock.connect('sock-a'); // the first join goes out on this link
  t.sock.drop(); // before pp:joined
  t.sock.connect('sock-b');
  assert.strictEqual(t.wire('pp:join').length, 1);
  assert.strictEqual(t.$('pp-gone').hidden, false);
  assert.strictEqual(t.api.page.screen, t.$('pp-gone'));
});

test('free: a lost join is asked again without a token; a buffered one is not doubled', () => {
  const lost = page();
  lost.sock.connect('sock-a');
  lost.sock.drop();
  lost.sock.connect('sock-b');
  const joins = lost.wire('pp:join');
  assert.strictEqual(joins.length, 2);
  assert.strictEqual(joins[1][1].entryToken, undefined);
  assert.strictEqual(lost.api.page.screen, lost.$('pp-connecting'));

  const buffered = page();
  buffered.sock.connect('sock-a');
  buffered.joined();
  buffered.sock.fire('pp:dead', { reason: 2 });
  buffered.clock.advance(1000);
  buffered.sock.drop();
  buffered.$('pp-dead').querySelector('.pp-again').click(); // free: a join, buffered
  buffered.sock.connect('sock-b');
  assert.strictEqual(buffered.wire('pp:join').length, 2, 'the buffered join only, no second one');
});

test('the refused screen says the reason once and the refund only when refunded', () => {
  const full = page({ stake: 0.1, entryToken: 'tok-1' });
  full.sock.connect('sock-a');
  full.sock.fire('pp:refused', { why: 'full', text: 'Every Paper table at this stake is full. Your entry was refunded.', refunded: true });
  assert.strictEqual(full.$('pp-refused-text').textContent, 'Every Paper table at this stake is full.');
  assert.strictEqual(full.$('pp-refused-refund').hidden, false);

  const maint = page();
  maint.sock.connect('sock-a');
  maint.sock.fire('pp:refused', { why: 'maintenance', text: 'DuelSeries is updating. Your entry was refunded.', refunded: false });
  assert.ok(!/refund/i.test(maint.$('pp-refused-text').textContent));
  assert.strictEqual(maint.$('pp-refused-refund').hidden, true);

  const other = page();
  other.sock.connect('sock-a');
  other.sock.fire('pp:refused', { why: 'something-new', text: 'A new reason.', refunded: false });
  assert.strictEqual(other.$('pp-refused-text').textContent, 'A new reason.');
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

test('the stock HUD holes match paperRender.js at 1366 x 768 and never overlap (even-odd clip)', () => {
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
  // five plates plus the unlisted player's in slot 6; the leader's plate is the full bar
  assert.strictEqual(holes.rects.length, 3 + 6);
  assert.strictEqual(holes.rects[3][0], 1366 - 340);
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
