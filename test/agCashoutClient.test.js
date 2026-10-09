'use strict';
// The agar.io page's hold-Q cash-out (Owen 2026-10-08, every room) and the paid-room display (PAID-AGAR-DESIGN 6):
// the wire (agNet ag:hold and the side events), the input (Q and the phone Cash out button as one hold), the page
// (repeat every 200 ms, movement locked, the ring in step with the server, the results screen after a cash-out, the
// paid balance, board, cell shares, away cells and the paid end card), and the free page drawing exactly as before
// when nobody holds Q.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { LIB, W, bootPage, BORDER, cell, spawn } = require('./agFakePage');

const TAU = 6.283185307179586;
const ROOT = path.join(__dirname, '..');
const holds = (p) => p.sent.filter((s) => s[0] === 'hold');
const kinds = (p, k) => p.sent.filter((s) => s[0] === k).length;
const statsTitle = (p) => p.doc.getElementById('ag-stats').children[0].children[0].textContent;

// ---- wire ------------------------------------------------------------------------------------------------------
function plainSocket() {
  const handlers = {};
  return {
    connected: true,
    emitted: [],
    on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); },
    emit(ev, payload) { this.emitted.push([ev, payload]); },
    fire(ev, arg) { (handlers[ev] || []).forEach((fn) => fn(arg)); },
    has: (ev) => !!handlers[ev]
  };
}

test('agNet: ag:hold carries { on: 1 } or { on: 0 } only; send(hold) maps onto it; nothing while the socket is down', () => {
  const s = plainSocket();
  const net = LIB.agNet.createNet({ socket: s });
  net.sendHold(true);
  net.sendHold(false);
  net.send('hold', { on: true });
  net.send('hold', {});
  net.send('hold');
  net.sendHold('yes');
  assert.deepStrictEqual(s.emitted, [['ag:hold', { on: 1 }], ['ag:hold', { on: 0 }], ['ag:hold', { on: 1 }],
    ['ag:hold', { on: 0 }], ['ag:hold', { on: 0 }], ['ag:hold', { on: 0 }]]);
  s.connected = false;
  assert.strictEqual(net.sendHold(true), false);
  assert.strictEqual(s.emitted.length, 6);
});

test('agNet: every side event reaches onEvent with its payload; others are never listened to', () => {
  const s = plainSocket();
  const got = [];
  LIB.agNet.createNet({ socket: s, onEvent: (n, p) => got.push([n, p]) });
  assert.deepStrictEqual(LIB.agNet.SIDE_EVENTS, ['ag:holding', 'ag:cashedout', 'ag:money', 'ag:joined', 'ag:dead',
    'ag:closed', 'ag:paid', 'ag:payerror', 'ag:refused', 'ag:refunded', 'ag:replaced']);
  for (const n of LIB.agNet.SIDE_EVENTS) s.fire(n, { n });
  s.fire('ag:other', {});
  assert.deepStrictEqual(got.map((g) => g[0]), LIB.agNet.SIDE_EVENTS);
  assert.deepStrictEqual(got[0][1], { n: 'ag:holding' });
  assert.strictEqual(s.has('ag:other'), false);
  const bare = plainSocket();
  LIB.agNet.createNet({ socket: bare });
  assert.strictEqual(bare.has('ag:holding'), false, 'no onEvent, no side listeners (the harness page has none)');
});

// ---- input -----------------------------------------------------------------------------------------------------
function target(extra) {
  const map = {};
  return Object.assign({
    addEventListener(type, fn) { (map[type] = map[type] || []).push(fn); },
    removeEventListener(type, fn) { map[type] = (map[type] || []).filter((f) => f !== fn); },
    fire(type, props) {
      const e = Object.assign({ type, defaultPrevented: false, cancelable: true, propagationStopped: false,
        preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.propagationStopped = true; } }, props || {});
      (map[type] || []).slice().forEach((fn) => fn(e));
      return e;
    }
  }, extra || {});
}

function inputSetup(opts) {
  opts = opts || {};
  const body = target({ onmousewheel: null, style: {} });
  const doc = target({ body, documentElement: { style: {} }, visibilityState: 'visible' });
  const win = target({ document: doc, navigator: { userAgent: 'Chrome' }, matchMedia: () => ({ matches: false }) });
  const canvas = target();
  const cashButton = target();
  const log = [];
  let can = opts.can !== false;
  const sink = { q: () => log.push(['q']), hold: (on) => log.push(['hold', on]), split: () => log.push(['split']) };
  const ctl = LIB.agInput.attachInput(canvas, sink, { win, doc, cashButton, canHold: () => can, engineNow: () => 1000 });
  ctl.enableKeys();
  return { ctl, win, doc, cashButton, log, setCan: (v) => { can = v; } };
}

test('agInput: Q held is one hold: q() on the press exactly as before, hold(true), then hold(false) on the release', () => {
  const t = inputSetup();
  const key = (type, keyCode) => t.win.fire(type, { keyCode });
  key('keydown', 81);
  key('keydown', 81);           // auto-repeat: nothing
  key('keydown', 81);
  assert.strictEqual(t.ctl.holding(), true);
  key('keyup', 81);
  key('keyup', 81);             // a second release: nothing
  key('keydown', 32);
  assert.deepStrictEqual(t.log, [['q'], ['hold', true], ['hold', false], ['split']]);
  assert.strictEqual(t.ctl.holding(), false);
});

test('agInput: a lost focus or a hidden page lets go at once; the late keyup changes nothing', () => {
  const t = inputSetup();
  const key = (type, keyCode) => t.win.fire(type, { keyCode });
  key('keydown', 81);
  t.win.fire('blur');
  assert.deepStrictEqual(t.log, [['q'], ['hold', true], ['hold', false]]);
  key('keyup', 81);
  assert.strictEqual(t.log.length, 3);
  key('keydown', 81);
  t.doc.visibilityState = 'hidden';
  t.doc.fire('visibilitychange');
  assert.deepStrictEqual(t.log.slice(3), [['q'], ['hold', true], ['hold', false]]);
  t.doc.fire('visibilitychange');
  assert.strictEqual(t.log.length, 6, 'a hidden page with no hold sends nothing more');
});

test('agInput: the Cash out button holds while pressed, only while canHold(); every way off it lets go; eaten either way', () => {
  for (const off of ['pointerup', 'pointercancel', 'pointerleave', 'touchend', 'touchcancel']) {
    const t = inputSetup();
    const down = t.cashButton.fire('pointerdown');
    assert.strictEqual(down.defaultPrevented, true, off + ': pointerdown eaten');
    assert.strictEqual(down.propagationStopped, true);
    t.cashButton.fire(off);
    assert.deepStrictEqual(t.log, [['hold', true], ['hold', false]], off);
  }
  const t = inputSetup({ can: false });
  const e = t.cashButton.fire('pointerdown');
  assert.strictEqual(e.defaultPrevented, true, 'a press that cannot hold is still eaten');
  assert.strictEqual(t.cashButton.fire('touchstart').defaultPrevented, true, 'no emulated mouse or steering');
  assert.strictEqual(t.cashButton.fire('contextmenu').defaultPrevented, true, 'a long press opens no menu');
  t.cashButton.fire('pointerup');
  assert.deepStrictEqual(t.log, []);
});

test('agInput: Q and the button together are one hold, off when the last lets go; releaseHold() drops both', () => {
  const t = inputSetup();
  const key = (type, keyCode) => t.win.fire(type, { keyCode });
  key('keydown', 81);
  t.cashButton.fire('pointerdown');
  key('keyup', 81);
  assert.deepStrictEqual(t.log, [['q'], ['hold', true]], 'the button still holds');
  t.cashButton.fire('pointerup');
  assert.deepStrictEqual(t.log.slice(2), [['hold', false]]);
  key('keydown', 81);
  t.cashButton.fire('pointerdown');
  t.ctl.releaseHold();
  assert.deepStrictEqual(t.log.slice(3), [['q'], ['hold', true], ['hold', false]]);
  t.cashButton.fire('pointerup');
  key('keyup', 81);
  assert.strictEqual(t.log.length, 6);
});

// ---- the page: hold, lock and repeat ----------------------------------------------------------------------------
test('hold: Q while alive sends ag:hold on at once and every 200 ms; no target, Split or Eject while held; off on release', async () => {
  const p = bootPage({ pad: true });
  await spawn(p, p.session.feed);
  p.sent.length = 0;
  const t0 = p.now();
  p.key('keydown', 81);
  assert.deepStrictEqual(p.sent.map((s) => s[0]), ['q', 'hold'], 'q exactly as before, then the hold');
  p.canvas.dispatch('mousemove', { clientX: 1100, clientY: 90 });   // a new target that would be sent
  p.key('keydown', 32);
  p.key('keyup', 32);
  p.key('keydown', 87);
  p.key('keyup', 87);
  p.doc.getElementById('ag-split').dispatch('pointerdown', {});
  await p.frames(61);                                               // a little over 1 s
  const on = holds(p);
  assert.ok(on.every((s) => s[1].on === true));
  assert.strictEqual(on.length, 6, 'at once, then at 200, 400, 600, 800 and 1000 ms');
  for (let i = 1; i < on.length; i++) assert.ok(Math.abs(on[i][2] - on[i - 1][2] - 200) < 17, 'every 200 ms');
  assert.ok(on[0][2] === t0);
  assert.strictEqual(kinds(p, 'target'), 0, 'movement locked: no target while held');
  assert.strictEqual(kinds(p, 'split') + kinds(p, 'eject'), 0, 'Split and Eject do nothing while held');
  assert.strictEqual(p.session.state().hold.wanted, true);
  p.key('keyup', 81);
  assert.deepStrictEqual(holds(p).pop()[1], { on: false });
  const n = holds(p).length;
  await p.frames(30);
  assert.strictEqual(holds(p).length, n, 'the repeat stops');
  assert.ok(kinds(p, 'target') >= 1, 'the target goes out again');
  p.key('keydown', 32);
  assert.strictEqual(kinds(p, 'split'), 1, 'Split works again');
});

test('hold: nothing starts unless alive in play; the Esc menu or a death while holding lets go', async () => {
  const p = bootPage({ pad: true });
  const feed = p.session.feed;
  feed({ t: 'hello' });
  feed(BORDER);
  feed({ t: 'world', eats: [], cells: [], removed: [] });
  p.session.spectate();
  p.key('keydown', 81);
  p.key('keyup', 81);
  p.doc.getElementById('ag-cash').dispatch('pointerdown', {});
  p.doc.getElementById('ag-cash').dispatch('pointerup', {});
  await p.frames(20);
  assert.strictEqual(holds(p).length, 0, 'spectating: no hold');
  p.session.play('me');
  p.key('keydown', 81);
  p.key('keyup', 81);
  assert.strictEqual(holds(p).length, 0, 'before the spawn: no hold');
  feed({ t: 'own', id: 9 });
  feed({ t: 'world', eats: [], cells: [cell({ id: 9 })], removed: [] });
  await p.frames(2);
  p.doc.getElementById('ag-cash').dispatch('pointerdown', {});
  assert.deepStrictEqual(holds(p).map((s) => s[1].on), [true], 'the phone button holds');
  p.session.menu();
  assert.deepStrictEqual(holds(p).map((s) => s[1].on), [true, false], 'Esc lets go at once');
  await p.frames(30);
  assert.strictEqual(holds(p).length, 2);
  p.doc.getElementById('ag-cash').dispatch('pointerup', {});
  p.session.play('me');
  await p.frames(2);
  p.key('keydown', 81);
  feed({ t: 'world', eats: [], cells: [], removed: [9] });
  assert.deepStrictEqual(holds(p).map((s) => s[1].on), [true, false, true, false], 'a death lets go');
  p.key('keyup', 81);
  assert.strictEqual(holds(p).length, 4);
});

// ---- the ring ---------------------------------------------------------------------------------------------------
test('ring: only while the server reports the hold and Q is down, round the biggest own cell, full on the cash-out tick', async () => {
  const p = bootPage();
  await spawn(p, p.session.feed);
  p.session.feed({ t: 'own', id: 11 });
  p.session.feed({ t: 'world', eats: [], cells: [cell({ id: 11, x: -400, size: 120 })], removed: [] });
  await p.frames(10);
  const rings = [];
  const r = p.mod.renderer;
  const draw = r.drawHoldRing;
  r.drawHoldRing = function (ctx, view, n, progress, st) { rings.push({ id: n.id, progress, t: p.now() }); return draw.apply(this, arguments); };
  p.key('keydown', 81);
  await p.frames(3);
  assert.strictEqual(rings.length, 0, 'no ring before the server says the hold runs');
  p.session.sideEvent('ag:holding', { on: 1, need: 75 });
  const at = p.now();
  await p.frames(1, 40);
  assert.strictEqual(rings.length, 1);
  assert.strictEqual(rings[0].id, 9, 'the biggest own cell');
  const expect = (t) => Math.min(1, (1 + (t - at) / 40.014) / 75);
  assert.ok(Math.abs(rings[0].progress - expect(rings[0].t)) < 1e-9);
  await p.frames(73, 40.014);
  const last = rings[rings.length - 1];
  assert.ok(last.progress > 0.98 && last.progress < 1, 'one tick short of full: ' + last.progress);
  await p.frames(2, 40.014);
  assert.strictEqual(rings[rings.length - 1].progress, 1, 'full at need ticks');
  // the drawing: one arc from 12 o'clock, clockwise, in the player's colour, a thin HUD-scaled stroke
  const calls = p.doc.calls.filter((c) => c[0] === p.canvas.cid);
  const arc = calls.filter((c) => c[1] === 'arc' && c[2][3] === -TAU / 4).pop();
  assert.ok(arc, 'the ring arc');
  const s = p.session.state().camera.scale;
  const k = Math.min(720 / 1080, 1280 / 1920);
  const lw = (LIB.agRender.HOLD_RING_PX * k) / s;
  const i = calls.lastIndexOf(arc);
  const after = calls.slice(i, i + 6).map((c) => c[1] + (c[1].startsWith('=') ? ':' + c[2][0] : ''));
  assert.deepStrictEqual(after, ['arc', '=lineWidth:' + lw, '=lineCap:round', '=strokeStyle:rgb(255,7,100)', 'stroke', 'restore']);
  assert.ok(Math.abs(arc[2][2] - (200 + 5 + (LIB.agRender.HOLD_RING_GAP_PX * k) / s + lw / 2)) < 1e-6, 'radius');
  assert.ok(Math.abs(arc[2][4] - (-TAU / 4 + TAU)) < 1e-9, 'a full circle at the end');
  assert.strictEqual(arc[2][5], false, 'clockwise');
  const n = rings.length;
  p.key('keyup', 81);
  await p.frames(3);
  assert.strictEqual(rings.length, n, 'release: gone on the next frame, before the server answers');
  p.key('keydown', 81);
  await p.frames(3);
  assert.strictEqual(rings.length, n, 'a new hold waits for the server again');
  p.session.sideEvent('ag:holding', { on: 1, need: 75 });
  await p.frames(1);
  assert.strictEqual(rings.length, n + 1);
  p.session.sideEvent('ag:holding', { on: 0 });
  await p.frames(3);
  assert.strictEqual(rings.length, n + 1, 'the server ending the hold removes it too');
});

// ---- free cash-out results --------------------------------------------------------------------------------------
test('free cash-out: after ag:cashedout { free } the cells go and the Match Results panel shows under "Cashed Out"', async () => {
  const p = bootPage();
  const feed = p.session.feed;
  await spawn(p, feed);
  p.key('keydown', 81);
  p.session.sideEvent('ag:holding', { on: 1, need: 75 });
  await p.frames(5);
  const before = holds(p).length;
  p.session.sideEvent('ag:cashedout', { free: true });
  assert.strictEqual(p.session.state().hold.wanted, false, 'the hold is over');
  p.key('keyup', 81);
  assert.strictEqual(holds(p).length, before, 'nothing more is sent: the server ended it');
  feed({ t: 'world', eats: [], cells: [], removed: [9] });
  assert.strictEqual(p.session.state().menuState, 'GAMEOVER');
  assert.strictEqual(p.doc.getElementById('ag-stats').hidden, false);
  assert.strictEqual(statsTitle(p), 'Cashed Out');
  assert.strictEqual(LIB.agScreens.CASHED_OUT_TITLE, 'Cashed Out');
  assert.strictEqual(p.doc.getElementById('ag-paid-end'), null, 'no paid card in the free room');
  p.doc.getElementById('statsContinue').dispatch('click', {});
  p.session.play('me');
  feed({ t: 'own', id: 12 });
  feed({ t: 'world', eats: [], cells: [cell({ id: 12 })], removed: [] });
  await p.frames(5);
  feed({ t: 'world', eats: [], cells: [], removed: [12] });
  assert.strictEqual(statsTitle(p), 'Match Results', 'a plain death keeps the reference title');
});

// ---- the free page is untouched when nobody holds ---------------------------------------------------------------
// The membranes draw random wobble (the renderer's Math.random), so both runs get the same seeded generator.
function seeded(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function freeRun(noise) {
  const real = Math.random;
  Math.random = seeded(7);
  try {
    return await freeRunSeeded(noise);
  } finally {
    Math.random = real;
  }
}

async function freeRunSeeded(noise) {
  const p = bootPage({ pad: true });
  const feed = p.session.feed;
  if (noise) {
    p.session.sideEvent('ag:holding', { on: 1, need: 75 });   // no hold here: ignored
    p.session.sideEvent('ag:refused', { why: 'x' });
    p.doc.getElementById('ag-cash').dispatch('pointerdown', {});   // not alive: eaten, nothing starts
    p.doc.getElementById('ag-cash').dispatch('pointerup', {});
  }
  await spawn(p, feed);
  p.canvas.dispatch('mousemove', { clientX: 900, clientY: 200 });
  await p.frames(20);
  if (noise) p.session.sideEvent('ag:holding', { on: 0 });
  p.key('keydown', 32);
  p.key('keyup', 32);
  await p.frames(20);
  feed({ t: 'world', eats: [], cells: [], removed: [9] });
  await p.frames(10, 50);
  return { calls: JSON.stringify(p.doc.calls), sizes: JSON.stringify(p.doc.sizeWrites), sent: JSON.stringify(p.sent),
    title: statsTitle(p) };
}

test('free page: hold events that do not apply leave every canvas call, size write and send exactly as without them', async () => {
  const a = await freeRun(false);
  const b = await freeRun(true);
  assert.ok(a.calls.length > 10000);
  assert.strictEqual(b.calls, a.calls);
  assert.strictEqual(b.sizes, a.sizes);
  assert.strictEqual(b.sent, a.sent);
  assert.strictEqual(a.title, 'Match Results');
});

// ---- paid display -----------------------------------------------------------------------------------------------
const MONEY = { me: 140000, rank: 1, cells: [9, 140000, 10, 60000], board: [['me', 140000], ['bob', 60000]], away: [10] };

test('paid: balance over the score, the money board, each known cell\'s share under its name, away cells faded', async () => {
  const p = bootPage();
  await spawn(p, p.session.feed);
  assert.strictEqual(p.session.state().paid, false);
  p.session.sideEvent('ag:joined', { stake: 0.1, micro: 100000, resumeKey: 'k', resumed: false, confirmed: false,
    holdTicks: 75, tickMs: 40.014 });
  assert.strictEqual(p.session.state().paid, true);
  p.doc.calls.length = 0;
  p.session.sideEvent('ag:money', MONEY);
  await p.frames(12);
  const texts = p.doc.calls.filter((c) => c[1] === 'fillText').map((c) => c[2][0]);
  for (const t of ['Balance: $0.14', '1. me', '$0.14', '2. bob', '$0.06']) assert.ok(texts.includes(t), 'drawn: ' + t);
  assert.ok(texts.filter((t) => t === '$0.14').length >= 2, 'board amount and the own cell\'s share');
  assert.ok(texts.includes('$0.06'), 'the stranger\'s share');
  const main = p.doc.calls.filter((c) => c[0] === p.canvas.cid);
  assert.ok(main.some((c) => c[1] === '=globalAlpha' && c[2][0] === LIB.agRender.AWAY_ALPHA), 'away cell at half opacity');
  assert.strictEqual(LIB.agRender.AWAY_ALPHA, 0.5);
  // the own balance panel sits right above the score panel (both bottom-left)
  const boxes = main.filter((c) => c[1] === 'moveTo').map((c) => c[2][1]);
  assert.ok(boxes.length >= 2);
  // a share that goes away stops being drawn; money cleared on a reconnect-style reset
  p.session.sideEvent('ag:money', Object.assign({}, MONEY, { cells: [9, 140000], away: [] }));
  p.doc.calls.length = 0;
  await p.frames(3);
  const later = p.doc.calls.filter((c) => c[1] === 'fillText').map((c) => c[2][0]);
  assert.ok(!later.includes('$0.06'));
  assert.ok(!p.doc.calls.some((c) => c[0] === p.canvas.cid && c[1] === '=globalAlpha' && c[2][0] === 0.5));
});

test('paid end card: the receipt with the server\'s numbers, the explorer link, a delayed payout, and never Match Results', async () => {
  const posted = [];
  const p = bootPage({ parent: { postMessage: (m) => posted.push(m) } });
  const events = [];
  p.win.phEvent = (name, props) => events.push([name, props]);
  await spawn(p, p.session.feed);
  p.session.sideEvent('ag:joined', { stake: 1, micro: 1000000, holdTicks: 75, tickMs: 40.014 });
  p.session.sideEvent('ag:money', MONEY);
  p.key('keydown', 81);
  p.session.sideEvent('ag:holding', { on: 1, need: 75 });
  await p.frames(3);
  p.session.sideEvent('ag:cashedout', { grossMicro: 1400000, cutMicro: 140000, netMicro: 1260000, cashoutId: 'c1' });
  const card = p.doc.getElementById('ag-paid-end');
  assert.ok(card && card.hidden === false);
  assert.strictEqual(card.getAttribute('data-kind'), 'cashed');
  assert.strictEqual(p.doc.getElementById('ag-pe-title').textContent, 'Cashed out');
  assert.strictEqual(p.doc.getElementById('ag-pe-amount').textContent, '$1.26');
  assert.strictEqual(p.doc.getElementById('ag-pe-sub').textContent, 'Cashed out $1.40, you receive $1.26 (10% house)');
  const ledger = p.doc.getElementById('ag-pe-ledger').children.map((row) => row.children[1].textContent);
  assert.deepStrictEqual(ledger, ['$1.40', '-$0.14', '$1.26']);
  assert.strictEqual(p.doc.getElementById('ag-pe-settle').getAttribute('data-state'), 'pending');
  assert.deepStrictEqual(events, [['cashed_out', { game: 'agar', amount: 1.26, stake: 1 }]], "Paper's properties");
  p.session.feed({ t: 'world', eats: [], cells: [], removed: [9] });
  assert.strictEqual(p.doc.getElementById('ag-stats').hidden, true, 'never the Match Results panel in a paid room');
  assert.strictEqual(p.session.state().menuState, 'GAMEOVER');
  assert.strictEqual(p.doc.getElementById('ag-menu').hidden, true);
  p.session.sideEvent('ag:paid', { sig: '5Abc', netMicro: 1260000 });
  assert.strictEqual(p.doc.getElementById('ag-pe-settle').getAttribute('data-state'), 'done');
  const tx = p.doc.getElementById('ag-pe-tx');
  assert.strictEqual(tx.hidden, false);
  assert.strictEqual(tx.getAttribute('href'), 'https://solscan.io/tx/5Abc');
  assert.strictEqual(tx.getAttribute('rel'), 'noopener noreferrer');
  p.doc.getElementById('ag-pe-lobby').dispatch('click', {});
  assert.deepStrictEqual(posted, ['game:done'], 'back to the lobby the way the Lobby button goes');

  const q = bootPage();
  await spawn(q, q.session.feed);
  q.session.sideEvent('ag:cashedout', { grossMicro: 100000, cutMicro: 10000, netMicro: 90000 });
  q.session.sideEvent('ag:payerror', { message: 'Payout delayed. Your winnings are recorded and will be sent.' });
  assert.strictEqual(q.doc.getElementById('ag-pe-settle').getAttribute('data-state'), 'fail');
  assert.strictEqual(q.doc.getElementById('co-settle-text').textContent, 'Payout delayed. Your winnings are recorded and will be sent.');
  assert.strictEqual(q.doc.getElementById('ag-pe-tx').hidden, true);
});

test('paid end card: a death says what was lost and to whom; a closed room says the whole balance comes back', async () => {
  const p = bootPage();
  await spawn(p, p.session.feed);
  p.session.sideEvent('ag:joined', { stake: 0.1, micro: 100000 });
  p.session.feed({ t: 'world', eats: [], cells: [], removed: [9] });
  assert.strictEqual(p.doc.getElementById('ag-stats').hidden, true, 'the death before ag:dead shows no panel either');
  p.session.sideEvent('ag:dead', { lostMicro: 100000, by: 'bob' });
  const card = p.doc.getElementById('ag-paid-end');
  assert.strictEqual(card.getAttribute('data-kind'), 'dead');
  assert.strictEqual(p.doc.getElementById('ag-pe-title').textContent, 'Eaten');
  assert.strictEqual(p.doc.getElementById('ag-pe-sub').textContent, 'You lost $0.10 to bob');
  assert.strictEqual(p.doc.getElementById('ag-pe-ledger').hidden, true);
  assert.strictEqual(p.doc.getElementById('ag-pe-settle').hidden, true);
  p.session.sideEvent('ag:closed', { refundedMicro: 250000, why: 'emergency' });
  assert.strictEqual(card.getAttribute('data-kind'), 'closed');
  assert.strictEqual(p.doc.getElementById('ag-pe-amount').textContent, '$0.25');
  assert.match(p.doc.getElementById('ag-pe-sub').textContent, /whole balance goes back to your wallet, no house cut/);
  const q = bootPage();
  q.session.sideEvent('ag:dead', { lostMicro: 100000, by: '' });
  assert.strictEqual(q.doc.getElementById('ag-pe-sub').textContent, 'You lost $0.10');
});

// ---- the socket path ---------------------------------------------------------------------------------------------
test('socket: side events arrive through agNet; a disconnect while holding ends the hold and the money shown', async () => {
  const p = bootPage({ net: true });
  p.sock.connected = true;
  p.sock.fire('connect');
  const feed = (rec) => p.sock.fire('ag:f', W.encodeBundle([rec]));
  await spawn(p, feed);
  p.sock.fire('ag:money', MONEY);
  p.key('keydown', 81);
  p.sock.fire('ag:holding', { on: 1, need: 75 });
  await p.frames(15);
  assert.deepStrictEqual(p.session.state().hold.server, true);
  const emitted = p.sock.emitted.filter((e) => e[0] === 'ag:hold');
  assert.ok(emitted.length >= 2 && emitted.every((e) => e[1].on === 1), 'ag:hold { on: 1 } on the socket');
  p.sock.connected = false;
  p.sock.fire('disconnect', 'transport close');
  assert.strictEqual(p.session.state().hold.wanted, false);
  assert.strictEqual(p.mod.hud.money, null);
  const n = holds(p).length;
  await p.frames(40);
  assert.strictEqual(holds(p).length, n, 'no repeat after the disconnect');
  p.key('keyup', 81);
  assert.strictEqual(holds(p).length, n);
});

// ---- the HUD money board ----------------------------------------------------------------------------------------
function hudRecorder() {
  const log = [];
  let n = 0;
  function createContext() {
    const id = 'c' + (n++);
    const canvas = { id, width: 300, height: 150 };
    const p = {};
    const ctx = new Proxy({ canvas }, {
      get(t, k) {
        if (k === 'canvas') return canvas;
        if (k in p) return p[k];
        if (k === 'measureText') return (s) => ({ width: (parseInt(p.font, 10) || 10) * 0.55 * String(s).length });
        return (...a) => log.push([id, k, ...a]);
      },
      set(t, k, v) { p[k] = v; log.push([id, '=' + String(k), v]); return true; }
    });
    return ctx;
  }
  return { log, createContext };
}

test('money board: by money, amounts right-aligned in the 250-unit width, long names cut, own row coloured, own rank past 10 added', () => {
  const rec = hudRecorder();
  const hud = LIB.agHud.createHud({ createContext: rec.createContext });
  hud.frameStart(1920, 1080);
  hud.setLocalNick('me');
  const board = [];
  for (let i = 0; i < 14; i++) board.push(['p' + i, 2000000 - i * 100000]);
  board[0][0] = 'a very long name indeed';
  rec.log.length = 0;
  hud.setMoney({ me: 800000, rank: 13, board });
  const texts = rec.log.filter((c) => c[1] === 'fillText');
  assert.strictEqual(texts.length, 1 + 11 * 2, 'title, 10 rows and the own extra row, each name + amount');
  const lay = LIB.agHud.layoutLeaderboard(1920, 1080, 14, 1, false, false);
  const amounts = texts.filter((c) => /^\$/.test(c[2]));
  assert.deepStrictEqual(amounts.map((c) => c[2]).slice(0, 2), ['$2.00', '$1.90']);
  for (const a of amounts) {
    const w = lay.rowFont * 0.55 * a[2].length;
    assert.strictEqual(a[3], Math.trunc(lay.innerW - lay.rowX - w), 'right-aligned');
  }
  const first = texts[1][2];
  assert.ok(first.startsWith('1. a very') && first.endsWith('…'), 'cut with an ellipsis: ' + first);
  const room = lay.innerW - lay.rowX - lay.rowFont * 0.55 * 5 - Math.trunc(lay.q * 8) - lay.rowX;
  assert.ok(lay.rowFont * 0.55 * first.length <= room, 'the cut name fits before its amount');
  assert.deepStrictEqual(texts[texts.length - 2].slice(2, 4), ['13. p12', lay.rowX]);
  assert.strictEqual(texts[texts.length - 1][2], '$0.80', 'the own row shows the own balance');
  const fills = rec.log.filter((c) => c[1] === '=fillStyle').map((c) => c[2]);
  assert.strictEqual(fills.filter((f) => f === 'rgb(255,170,170)').length, 1, 'only the own row is coloured');
  // null goes back to the plain board, call for call as a hud that never had money
  hud.setBoard([{ name: 'x' }, { me: true }], 'me');
  rec.log.length = 0;
  hud.setMoney(null);
  const plain = rec.log.map((c) => JSON.stringify(c.slice(1)));
  const rec2 = hudRecorder();
  const hud2 = LIB.agHud.createHud({ createContext: rec2.createContext });
  hud2.frameStart(1920, 1080);
  rec2.log.length = 0;
  hud2.setBoard([{ name: 'x' }, { me: true }], 'me');
  assert.deepStrictEqual(plain, rec2.log.map((c) => JSON.stringify(c.slice(1))));
  assert.strictEqual(LIB.agHud.fitRow({ measureText: (s) => ({ width: s.length }) }, '1. ', 'abcdef', 3), '1. …');
});

test('own balance panel: only with money, alive and not spectating; never in a free HUD', () => {
  const rec = hudRecorder();
  const hud = LIB.agHud.createHud({ createContext: rec.createContext });
  const main = rec.createContext();
  hud.frameStart(1920, 1080);
  const state = (o) => Object.assign({ mode: 0, state: 0, spectating: false, connected: true, ownCount: 1, fadeout: false,
    highestMass: 400, camX: 0, camY: 0, target: null }, o || {});
  const panels = () => rec.log.filter((c) => c[0] === main.canvas.id && c[1] === 'arcTo').length / 4;
  hud.render(main, state());
  const free = panels();
  assert.strictEqual(free, 1, 'the score panel only');
  hud.setMoney({ me: 100000, rank: 1, board: [['me', 100000]] });
  rec.log.length = 0;
  hud.render(main, state());
  assert.strictEqual(panels(), 2, 'score and balance');
  const ys = rec.log.filter((c) => c[0] === main.canvas.id && c[1] === 'arcTo').filter((c, i) => i % 4 === 0).map((c) => c[3]);
  const q = 1, h = Math.trunc(q * 34);
  assert.deepStrictEqual(ys, [1080 - (15 + h), 1080 - (15 + h + 8 + h)], 'balance stacked right above the score');
  rec.log.length = 0;
  hud.render(main, state({ ownCount: 0 }));
  assert.strictEqual(panels(), 1);
  rec.log.length = 0;
  hud.render(main, state({ spectating: true, highestMass: 0 }));
  assert.strictEqual(panels(), 0);
  hud.reset();
  assert.strictEqual(hud.money, null, 'a reconnect forgets the money');
});

// ---- screens ------------------------------------------------------------------------------------------------------
test('Match Results keeps its title unless a cash-out asks; the paid card is built only when used', () => {
  const p = bootPage();
  const screens = p.mod.screens;
  const snap = { food: 0, mass: 0, aliveMs: 0, topPosition: 0, cells: 0, leaderMs: 0 };
  screens.showStats(snap, { title: 'Cashed Out' });
  assert.strictEqual(statsTitle(p), 'Cashed Out');
  screens.showStats(snap);
  assert.strictEqual(statsTitle(p), 'Match Results');
  assert.strictEqual(p.doc.getElementById('ag-paid-end'), null);
});

// ---- the page files -------------------------------------------------------------------------------------------------
test('ag.html: the Cash out button leads the phone pad; the shared end card styles are linked; the pad keeps to the safe area', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'ag.html'), 'utf8');
  const pad = html.slice(html.indexOf('<div class="ag-pad"'), html.indexOf('</div>', html.indexOf('<div class="ag-pad"')));
  const ids = [...pad.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(ids, ['ag-cash', 'ag-split', 'ag-eject']);
  assert.ok(html.indexOf('/css/cashout.css') > html.indexOf('/css/ag.css'));
  const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'ag.css'), 'utf8');
  assert.match(css, /\.ag-pad \{[^}]*right: calc\(16px \+ env\(safe-area-inset-right, 0px\)\);/);
  assert.match(css, /\.ag-pad \{[^}]*bottom: calc\(16px \+ var\(--ag-banner, 0px\) \+ env\(safe-area-inset-bottom, 0px\)\);/);
  assert.match(css, /#ag-paid-end\[hidden\],\s*#ag-paid-end \[hidden\] \{ display: none; \}/);
});

test('the client hold constants match the server: 200 ms repeat inside the 500 ms stale window, 75 ticks of 40.014 ms', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'ag', 'agMain.js'), 'utf8');
  const { AG_MONEY } = require('../server/ag/agMoney');
  const { LAWS } = require('../server/ag/agLaws');
  assert.match(src, /var HOLD_REPEAT_MS = 200;/);
  assert.ok(200 < AG_MONEY.HOLD_INPUT_STALE_MS.value / 2, 'two repeats can be lost before the server drops the hold');
  assert.match(src, new RegExp('var HOLD_TICKS = ' + AG_MONEY.HOLD_TICKS.value + ';'));
  assert.match(src, new RegExp('var HOLD_TICK_MS = ' + String(LAWS.L1.value).replace('.', '\\.') + ';'));
});
