'use strict';
// slxMain and slxDirect, ACTIVE (SERVER-DESIGN 15.1, 15.3, 15.5; task T16): the layer boot on a small fake page of
// its own (never the gate's page, where the layer must stay inert, test/slxNoTouch.test.js). The frozen client is
// faked down to the seams the layer may touch (15.1): S, slLoop.hooks, DuelSlither.play, slNet.makeSocketIoTransport,
// slWire.decodeInput, and the login element of public/sl.html.
//
// Checks: menu hooks relayed and still chained; render_mode 2 on phones only; the skin cv for the handshake; the
// lobby frame plays at once under the lobby name and shows no panel; a direct visit gets the name box and Play, which
// calls their Play, says Starting, and comes back on the menu or a close before any life; key, mouse and touch events
// on the panel never reach their handlers; game:done only inside a frame; inert under a harness transport. With
// slxPaid.js between slxNet and slxMain, as the composed page loads it (PAID-SL-DESIGN 9): a paid hand-off's fields go
// into the same handshake as the cv, and a page slxPaid holds never auto-plays (the paid page itself is
// test/slxPaidPage.test.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FILES = ['slxNet.js', 'slxPaid.js', 'slxMain.js', 'slxDirect.js'];
const SRC = FILES.map((f) => [f, fs.readFileSync(path.join(ROOT, 'public/js/slx', f), 'utf8')]);

function store(init) {
  const m = Object.assign({}, init || {});
  return { getItem: (k) => (Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null), setItem: (k, v) => { m[k] = String(v); },
    removeItem: (k) => { delete m[k]; }, keys: () => Object.keys(m).sort() };
}

class El {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.listeners = {};
    this.attrs = {};
    this.style = {};
    this.className = '';
    this.textContent = '';
    this.value = '';
    this.disabled = false;
    this.focused = 0;
    this.blurred = 0;
  }
  appendChild(c) { this.children.push(c); c.parent = this; return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  addEventListener(t, f, o) { (this.listeners[t] = this.listeners[t] || []).push({ f, o }); }
  focus() { this.focused++; }
  blur() { this.blurred++; }
  getBoundingClientRect() { return { left: 100, right: 250, top: 300, bottom: 344 }; }
  // one event on this element: its own listeners; `stopped` says whether it would reach their window handlers
  fire(type, extra) {
    const e = Object.assign({ type, stopped: false, prevented: false, keyCode: 0,
      stopPropagation() { this.stopped = true; }, preventDefault() { this.prevented = true; } }, extra || {});
    for (const l of (this.listeners[type] || []).slice()) l.f(e);
    return e;
  }
}

function page(opts) {
  const o = opts || {};
  const login = new El('div');
  const made = [];
  const posted = [];
  const plays = [];
  const hookCalls = [];
  const ctx = { console, Math, JSON, Object, Array, String, Number, Error, Date, RegExp, Uint8Array };
  ctx.window = ctx;
  ctx.performance = { now: () => 1000 };
  ctx.document = {
    hidden: false,
    getElementById: (id) => (id === 'login' ? login : null),
    querySelector: (sel) => (sel === '.slx-card' && o.card ? {} : null),
    createElement: (tag) => { const e = new El(tag); made.push(e); return e; },
    addEventListener() {},
  };
  ctx.localStorage = store(o.local);
  ctx.sessionStorage = store(o.session);
  ctx.location = { origin: 'https://duelseries.com' };
  const parent = { postMessage: (m, origin) => posted.push([m, origin]) };
  ctx.parent = o.framed ? parent : ctx;
  ctx.frameElement = o.frameId ? { id: o.frameId } : null;
  const focus = { calls: 0, has: !!o.hasFocus, listeners: [] };
  if (o.focus) {
    ctx.focus = () => { focus.calls++; focus.has = true; };
    ctx.addEventListener = (type, fn, capture) => focus.listeners.push([type, fn, capture]);
    ctx.document.hasFocus = () => focus.has;
  }
  ctx.io = function () { throw new Error('no socket in this test'); };
  ctx.DuelSlitherConfig = o.transport ? { transport: o.transport } : {};
  const S = { is_mobile: !!o.mobile, render_mode: o.mobile ? 1 : 2, playing: false, slither: null };
  const hooks = {
    connect() {},
    onMenuShow: () => hookCalls.push('show'),
    onMenuFade: (fr) => hookCalls.push('fade ' + fr),
    onMenuDone: () => hookCalls.push('done'),
  };
  const ownHooks = Object.assign({}, hooks);
  ctx.DuelSlither = {
    S,
    slLoop: { hooks },
    play: (nick) => plays.push(nick),
    slNet: { makeSocketIoTransport: () => ({ open() {}, send() {}, close() {} }) },
    slWire: { decodeInput: () => [] },
  };
  vm.createContext(ctx);
  for (const [f, src] of SRC) vm.runInContext(src, ctx, { filename: f });
  return { ctx, D: ctx.DuelSlither, S, login, made, posted, plays, hooks, ownHooks, hookCalls, parent, focus };
}

test('menu hooks: relayed to layer observers and their own still run', () => {
  const p = page();
  const seen = [];
  p.D.slx.on('menuShow', () => seen.push('show'));
  p.D.slx.on('menuFade', (fr) => seen.push('fade ' + fr));
  p.D.slx.on('menuDone', () => seen.push('done'));
  assert.notStrictEqual(p.hooks.onMenuShow, p.ownHooks.onMenuShow);
  p.hooks.onMenuShow();
  p.hooks.onMenuFade(0.25);
  p.hooks.onMenuDone();
  assert.deepStrictEqual(p.hookCalls, ['show', 'fade 0.25', 'done']);
  assert.deepStrictEqual(seen, ['show', 'fade 0.25', 'done']);
  assert.strictEqual(p.hooks.connect, p.ownHooks.connect, 'connect is never touched');
});

test('render_mode: 2 on phones (Owen Q8), untouched on computers', () => {
  assert.strictEqual(page({ mobile: true }).S.render_mode, 2);
  assert.strictEqual(page().S.render_mode, 2);
});

test('the skin cv for the handshake: a whole number from duel.sl.skin, else nothing (the server picks)', () => {
  const cases = [['12', '{"cv":12}'], [' 7 ', '{"cv":7}'], ['0', '{"cv":0}'], ['abc', '{}'], ['-1', '{}'], ['1.5', '{}'],
    ['', '{}'], [null, '{}'], ['99999999999999999999', '{}']];
  for (const [v, want] of cases) {
    const p = page({ local: v === null ? {} : { 'duel.sl.skin': v } });
    assert.strictEqual(JSON.stringify(p.D.slx.auth()), want, String(v));
  }
});

test('the lobby frame: Play at once under the lobby name, no name box', () => {
  const p = page({ framed: true, frameId: 'game-frame', session: { playerName: 'Owen' }, local: { duelseries_playername: 'Old' } });
  assert.deepStrictEqual(p.plays, ['Owen']);
  assert.strictEqual(p.login.children.length, 0);
  assert.strictEqual(p.D.slx.inLobby, true);
  assert.strictEqual(p.D.slx.toLobby(), true);
  assert.deepStrictEqual(p.posted, [['game:done', 'https://duelseries.com']]);
  const q = page({ framed: true, frameId: 'game-frame', local: { duelseries_playername: ' Kept ' } });
  assert.deepStrictEqual(q.plays, ['Kept'], 'the name the lobby keeps when the hand-off has none');
});

test('the lobby frame takes the keyboard: focus at boot, and a press while it lacks the focus takes it back first', () => {
  const p = page({ framed: true, frameId: 'game-frame', focus: true, session: { playerName: 'Owen' } });
  assert.strictEqual(p.focus.calls, 1, 'focused at boot');
  const down = p.focus.listeners.filter((l) => l[0] === 'mousedown');
  assert.strictEqual(down.length, 1);
  assert.strictEqual(down[0][2], true, 'capture: before their window.onmousedown, which prevents the default');
  down[0][1]({});
  assert.strictEqual(p.focus.calls, 1, 'already focused: nothing');
  p.focus.has = false;
  down[0][1]({});
  assert.strictEqual(p.focus.calls, 2, 'the focus went back to the lobby: the press takes it');
  assert.deepStrictEqual(p.plays, ['Owen']);
  // not in the lobby's frame: no focus taken, no listener
  const q = page({ framed: true, frameId: 'other', focus: true });
  assert.strictEqual(q.focus.calls, 0);
  assert.strictEqual(q.focus.listeners.filter((l) => l[0] === 'mousedown').length, 0);
});

test('another frame or no frame: the name box, no auto Play; game:done only inside a frame', () => {
  const other = page({ framed: true, frameId: 'agar-frame', session: { playerName: 'Owen' } });
  assert.deepStrictEqual(other.plays, []);
  assert.strictEqual(other.login.children.length, 1);
  const top = page({ session: { playerName: 'Owen' } });
  assert.strictEqual(top.D.slx.framed, false);
  assert.strictEqual(top.D.slx.toLobby(), false);
  assert.deepStrictEqual(top.posted, []);
});

test('direct visit: name box and Play inside their login layer, prefilled, capped at L45 nameMax 24, focused', () => {
  const p = page({ local: { duelseries_playername: 'abcdefghijklmnopqrstuvwxyz' } });
  assert.strictEqual(p.login.children.length, 1);
  const panel = p.login.children[0];
  assert.strictEqual(panel.className, 'slx-direct');
  const [name, play] = panel.children;
  assert.deepStrictEqual([name.className, name.type, name.maxLength, name.value, name.attrs['aria-label']],
    ['slx-direct-name', 'text', 24, 'abcdefghijklmnopqrstuvwx', 'Nickname']);
  assert.deepStrictEqual([play.className, play.type, play.textContent, play.disabled], ['slx-direct-play', 'button', 'Play', false]);
  assert.strictEqual(name.focused, 1);
  assert.strictEqual(page({ mobile: true }).login.children[0].children[0].focused, 0, 'no keyboard pop-up on a phone');
  for (const el of p.made) assert.ok(el.className.startsWith('slx-'), 'every layer element has an slx- class');
});

test('Play: their Play with the typed name, Starting until the menu shows or a close before any life', () => {
  const p = page();
  const [name, play] = p.login.children[0].children;
  name.value = 'Snek';
  const click = play.fire('click');
  assert.strictEqual(click.stopped, true);
  assert.deepStrictEqual(p.plays, ['Snek']);
  assert.deepStrictEqual([play.disabled, play.textContent], [true, 'Starting']);
  play.fire('click');
  assert.deepStrictEqual(p.plays, ['Snek'], 'one Play while starting');
  p.D.slx.fire('close', { playing: true, opened: true, sawDead: false, refused: null });
  assert.strictEqual(play.disabled, true, 'a life ended by a close: the menu brings Play back');
  p.hooks.onMenuShow();
  assert.deepStrictEqual([play.disabled, play.textContent], [false, 'Play']);
  play.fire('click');
  p.D.slx.fire('close', { playing: false, opened: true, sawDead: false, refused: 'full' });
  assert.deepStrictEqual([play.disabled, play.textContent], [false, 'Play'], 'refused before any life');
  assert.deepStrictEqual(p.plays, ['Snek', 'Snek']);
});

test('with the results card on the page (slxCard): the panel steps aside after a life or a refusal', () => {
  for (const end of ['menu', 'refused']) {
    const p = page({ card: true });
    const panel = p.login.children[0];
    const play = panel.children[1];
    play.fire('click');
    assert.strictEqual(panel.style.display, undefined, 'still there while starting');
    if (end === 'menu') p.hooks.onMenuShow();
    else p.D.slx.fire('close', { playing: false, opened: false, sawDead: false, refused: 'limit' });
    assert.strictEqual(panel.style.display, 'none', end);
    p.hooks.onMenuShow();
    assert.strictEqual(panel.style.display, 'none', 'for good');
  }
});

test('the name box: Enter plays; keys, mouse and touch stop at the box (their handlers never see them)', () => {
  const p = page();
  const [name, play] = p.login.children[0].children;
  name.value = 'Typed';
  for (const t of ['keydown', 'keyup', 'keypress']) assert.strictEqual(name.fire(t, { keyCode: 32 }).stopped, true, t);
  assert.deepStrictEqual(p.plays, []);
  const enter = name.fire('keydown', { keyCode: 13, key: 'Enter' });
  assert.deepStrictEqual([enter.stopped, enter.prevented], [true, true]);
  assert.deepStrictEqual(p.plays, ['Typed']);
  assert.strictEqual(name.blurred, 1);
  for (const t of ['mousedown', 'contextmenu', 'touchmove', 'touchend', 'touchcancel']) {
    assert.strictEqual(name.fire(t).stopped, true, 'name ' + t);
    assert.strictEqual(play.fire(t).stopped, true, 'play ' + t);
  }
  // mouseup goes on to their window listener, which only ends a boost (fixer pass, 2026-10-10)
  assert.strictEqual(name.fire('mouseup').stopped, false, 'name mouseup');
  assert.strictEqual(play.fire('mouseup').stopped, false, 'play mouseup');
  const tsName = name.fire('touchstart');
  assert.deepStrictEqual([tsName.stopped, tsName.prevented], [true, false], 'a tap still focuses the box');
  assert.strictEqual(name.listeners.touchstart[0].o.passive, false);
});

test('the Play button on a phone: a tap that ends on it plays, one that slides off does not', () => {
  const p = page({ mobile: true });
  const play = p.login.children[0].children[1];
  let ts = play.fire('touchstart');
  assert.deepStrictEqual([ts.stopped, ts.prevented], [true, true], 'no compatibility mouse event, no boost');
  play.fire('touchend', { changedTouches: [{ clientX: 400, clientY: 320 }] });
  assert.deepStrictEqual(p.plays, []);
  ts = play.fire('touchstart');
  play.fire('touchend', { changedTouches: [{ clientX: 120, clientY: 320 }] });
  assert.deepStrictEqual(p.plays, ['']);
});

test('inert under a harness transport: no panel, no Play, hooks and render_mode untouched', () => {
  const p = page({ mobile: true, transport: () => ({}), framed: true, frameId: 'game-frame', session: { playerName: 'Owen' } });
  assert.strictEqual(p.D.slx.active, false);
  assert.strictEqual(p.login.children.length, 0);
  assert.deepStrictEqual(p.plays, []);
  assert.strictEqual(p.S.render_mode, 1);
  assert.strictEqual(p.hooks.onMenuShow, p.ownHooks.onMenuShow);
  assert.strictEqual(p.made.length, 0);
});

// ------------------------------------------------------------------------------------------------- the paid hand-off

const LAUNCH = { slPaidLaunch: 'n0nce', entryToken: 'tok-123', entrySol: '0.5', stake: '0.5', playerName: 'Owen' };

test('paid hand-off: the token, stake and paid flag join the cv in one handshake; the four keys are gone; Play at once', () => {
  const p = page({ framed: true, frameId: 'game-frame', session: LAUNCH, local: { 'duel.sl.skin': '12' } });
  assert.deepStrictEqual(p.plays, ['Owen'], 'the lobby frame plays the paid page as the free one');
  assert.strictEqual(JSON.stringify(p.D.slx.auth()), '{"cv":12,"paid":1,"stake":0.5,"entryToken":"tok-123"}');
  assert.deepStrictEqual(p.ctx.sessionStorage.keys(), ['playerName'], 'slPaidLaunch, entryToken, entrySol and stake removed');
  assert.strictEqual(p.D.slx.paidHold(), false);
  assert.strictEqual(p.D.slx.paid.on, true);
  assert.strictEqual(JSON.stringify(p.D.slx.paid.state()).includes('tok-123'), false, 'the state never holds the token');
});

test('no nonce: the free page, a stale token and stake left alone and never sent', () => {
  const p = page({ framed: true, frameId: 'game-frame', session: { entryToken: 'stale', stake: '1', playerName: 'Owen' },
    local: { 'duel.sl.skin': '3' } });
  assert.deepStrictEqual(p.plays, ['Owen']);
  assert.strictEqual(JSON.stringify(p.D.slx.auth()), '{"cv":3}');
  assert.strictEqual(p.D.slx.paidAuth(), null);
  assert.deepStrictEqual(p.ctx.sessionStorage.keys(), ['entryToken', 'playerName', 'stake']);
  assert.strictEqual(p.D.slx.paid.on, false);
  assert.strictEqual(p.D.slx.cardLines, undefined, 'no card hook on a free page');
});

test('a page slxPaid holds never auto-plays: the reload mark, or a nonce with no usable token or stake', () => {
  const cases = [
    ['reload mark', { slxPaidCut: '1', playerName: 'Owen' }],
    ['bad stake', { slPaidLaunch: 'n', entryToken: 'tok', stake: '0.25', playerName: 'Owen' }],
    ['no token', { slPaidLaunch: 'n', stake: '0.5', playerName: 'Owen' }],
    ['long token', { slPaidLaunch: 'n', entryToken: 'x'.repeat(65), stake: '1', playerName: 'Owen' }]
  ];
  for (const [name, session] of cases) {
    const p = page({ framed: true, frameId: 'game-frame', session });
    assert.deepStrictEqual(p.plays, [], name + ': no free Play');
    assert.strictEqual(p.D.slx.paidHold(), true, name);
    assert.strictEqual(p.D.slx.paidAuth(), null, name + ': nothing paid in the handshake');
    assert.deepStrictEqual(p.ctx.sessionStorage.keys(), ['playerName'], name + ': the mark and the launch keys taken out');
  }
});
