'use strict';
// The Phase 6 swap on the lobby side (SERVER-DESIGN 16.2, launch path C35): the lobby's Free snake opens the new
// slither.io page /sl through the own-page branch (no wallet widget, no duel:play), whenever the board's free snake row
// is the new room's 'sl:' row, and also on a cold start with no board. Paid snake, and a board that lists the old free
// rung (sl:door:off), still go through the widget to the old engine. Runs the real public/js/v2/play.js in a vm.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '../public/js/v2/play.js'), 'utf8');

function page(lobbies) {
  const els = {};
  const mk = (id) => (els[id] = els[id] || { id, value: '', style: {}, hidden: true, textContent: '', focus() {} });
  ['game-frame', 'agar-frame', 'play-msg'].forEach(mk);
  mk('play-name').value = 'Owen123';
  const store = () => { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); } }; };
  const sent = { events: [], ph: [] };
  const win = {
    duelWallet: { authenticated: true, address: 'TestWallet1111' },
    V2Board: lobbies === null ? undefined : { lobbies, load() {} },
    V2_HAS_LADDER: () => true,
    phEvent: (name, d) => sent.ph.push([name, d]),
    dispatchEvent: (e) => sent.events.push(e.type),
    addEventListener() {},
    location: { origin: 'http://localhost' },
  };
  const ctx = {
    window: win,
    document: {
      getElementById: (id) => els[id] || null,
      addEventListener() {},
      createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {} }),
      body: { classList: { add() {}, remove() {} }, appendChild() {} },
    },
    localStorage: store(),
    sessionStorage: store(),
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
    fetch: () => Promise.resolve({ ok: true, json: async () => ({}) }),
    MutationObserver: function () { this.observe = () => {}; },
    setTimeout, clearTimeout, console, alert() {},
  };
  win.window = win;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: 'play.js' });
  return { play: win.V2Play, frame: els['game-frame'], sent, msg: els['play-msg'] };
}

const SL_ROW = { id: 'sl:na:s0', game: 'snake', stake: 0, state: 'open' };
const OLD_FREE = { id: 'snake:na:s0', game: 'snake', stake: 0, state: 'open' };
const PAID = { id: 'snake:na:s0.5', game: 'snake', stake: 0.5, state: 'open' };

test('Free snake with the sl: row on the board opens /sl, never the wallet widget', () => {
  const p = page([SL_ROW, PAID]);
  p.play.enter(SL_ROW);
  assert.strictEqual(p.frame.src, '/sl');
  assert.strictEqual(p.frame.style.display, 'block');
  assert.deepStrictEqual(p.sent.events, [], 'no duel:play, so no money code is reached');
  assert.strictEqual(JSON.stringify(p.sent.ph), JSON.stringify([['game_started', { game: 'snake', lobbyType: 'free' }]]), 'PostHog snake numbers stay one game');
});

test('a cold start with no board yet opens /sl for Free snake too (C39)', () => {
  const p = page([]);
  p.play.enter({ game: 'snake', stake: 0 });
  assert.strictEqual(p.frame.src, '/sl');
  assert.deepStrictEqual(p.sent.events, []);
});

test('a board that lists the old free rung (sl:door:off rollback) goes to the old engine through the widget', () => {
  const p = page([OLD_FREE, PAID]);
  p.play.enter(OLD_FREE);
  assert.strictEqual(p.frame.src, undefined, 'no own page');
  assert.deepStrictEqual(p.sent.events, ['duel:play']);
});

test('paid snake never takes the /sl shortcut', () => {
  const p = page([SL_ROW, PAID]);
  p.play.enter(PAID);
  assert.strictEqual(p.frame.src, undefined);
  assert.deepStrictEqual(p.sent.events, ['duel:play']);
});

test('the slx layer never touches the money hand-off', () => {
  const dir = path.join(__dirname, '../public/js/slx');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const s = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/duel:restake|duel:signaction|entryToken|entrySol/.test(s), f + ' names no money message or token');
    assert.ok(!/sessionStorage[^\n]*['"]stake['"]/.test(s), f + ' reads no stake from sessionStorage');
  }
});
