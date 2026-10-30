'use strict';
// The Phase 6 swap on the lobby side (SERVER-DESIGN 16.2, launch path C35): the lobby's Free snake opens the new
// slither.io page /sl through the own-page branch (no wallet widget, no duel:play), whenever the board's free snake row
// is the new room's 'sl:' row, and also on a cold start with no board. A board that lists the old free rung
// (sl:door:off) still goes through the widget to the old engine; paid snake always goes through the widget (to the new
// engine's /sl with engine 'sl' when its open row is an 'sl:' row, PAID-SL-DESIGN 2). Runs the real
// public/js/v2/play.js in a vm.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '../public/js/v2/play.js'), 'utf8');

function page(lobbies) {
  const els = {};
  const mk = (id) => (els[id] = els[id] || { id, value: '', style: {}, hidden: true, textContent: '', focus() {},
    on: {}, addEventListener(t, fn, o) { (this.on[t] = this.on[t] || []).push([fn, o]); },
    contentWindow: { focused: 0, focus() { this.focused++; } } });
  ['game-frame', 'agar-frame', 'play-msg'].forEach(mk);
  mk('play-name').value = 'Owen123';
  const store = () => { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); },
    removeItem: (k) => { delete m[k]; } }; };
  const sent = { events: [], details: [], ph: [] };
  const win = {
    duelWallet: { authenticated: true, address: 'TestWallet1111' },
    V2Board: lobbies === null ? undefined : { lobbies, load() {} },
    V2_HAS_LADDER: () => true,
    phEvent: (name, d) => sent.ph.push([name, d]),
    DSTrack: { event: (name, d) => sent.ph.push([name, d]) },
    dispatchEvent: (e) => { sent.events.push(e.type); sent.details.push(e.detail); },
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
  // Play pressed (shared/trackPlan.js); the page sends game_started once it is really in a game
  assert.strictEqual(JSON.stringify(p.sent.ph), JSON.stringify([['play_clicked', { game: 'snake', paid: false, stake: 0, mode: 'free', guest: false, engine: 'sl' }]]), 'PostHog snake numbers stay one game');
});

test('Free snake hands the keyboard to the game: the frame takes the focus once it loads, and again a moment later', async () => {
  const p = page([SL_ROW, PAID]);
  p.play.enter(SL_ROW);
  const loads = p.frame.on.load || [];
  assert.strictEqual(loads.length, 1, 'one load listener');
  assert.strictEqual(loads[0][1].once, true, 'once');
  assert.strictEqual(p.frame.contentWindow.focused, 0, 'not before the page loads');
  loads[0][0]();
  assert.strictEqual(p.frame.contentWindow.focused, 1, 'on load');
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(p.frame.contentWindow.focused, 2, 'and again 150 ms later');
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

// Rewritten for paid snake on the new engine (PAID-SL-DESIGN 2 and 11.2, task T7). It said only "paid snake never takes
// the /sl shortcut", and with an old $0.50 row on the board that is still so. Now the board can list the new engine's
// paid row ('sl:na:s0.5') instead, and a paid sl buy-in DOES open /sl, but through the widget (duel:play with engine
// 'sl': stake, token, nonce, then /sl), never through the own-page shortcut, which opens a page with no stake taken. The
// engine comes from the board's open row at the stake: the old row plays with none.
const SL_PAID = { id: 'sl:na:s0.5', game: 'snake', stake: 0.5, state: 'open' };

test('paid snake never takes the /sl shortcut: an open sl: row goes to the widget with engine sl, an old row without', () => {
  const p = page([SL_ROW, PAID]);
  p.play.enter(PAID);
  assert.strictEqual(p.frame.src, undefined);
  assert.deepStrictEqual(p.sent.events, ['duel:play']);
  assert.strictEqual(JSON.stringify(p.sent.details), JSON.stringify([{ game: 'snake', stake: 0.5 }]), 'the old engine: no engine named');
  const s = page([SL_ROW, SL_PAID]);
  s.play.enter(SL_PAID);
  assert.strictEqual(s.frame.src, undefined, 'no own page: the widget stakes first');
  assert.deepStrictEqual(s.sent.events, ['duel:play']);
  assert.strictEqual(JSON.stringify(s.sent.details), JSON.stringify([{ game: 'snake', stake: 0.5, engine: 'sl' }]));
});

// The one carve-out (PAID-SL-DESIGN 9, 11.2): slxPaid.js IS the paid page's hand-off. It reads the lobby's entry token,
// stake and one-shot nonce once at boot (and removes them), and buys Play again through duel:restake. Every other
// layer file still names no money message or token; slxPaid.js itself never signs, never plays through the widget and
// never writes a token back to storage.
const PAID_FILE = 'slxPaid.js';

test('the slx layer never touches the money hand-off, slxPaid.js aside', () => {
  const dir = path.join(__dirname, '../public/js/slx');
  const files = fs.readdirSync(dir).filter((x) => x.endsWith('.js'));
  assert.ok(files.includes(PAID_FILE));
  for (const f of files) {
    if (f === PAID_FILE) continue;
    const s = fs.readFileSync(path.join(dir, f), 'utf8');
    // the battle royale's page signs its identity and the owner's start through the bridge (test/slxSurface.test.js)
    const re = f === 'slxBr.js' ? /duel:restake|entryToken|entrySol/ : /duel:restake|duel:signaction|entryToken|entrySol/;
    assert.ok(!re.test(s), f + ' names no money message or token');
    assert.ok(!/sessionStorage[^\n]*['"]stake['"]/.test(s), f + ' reads no stake from sessionStorage');
  }
  const paid = fs.readFileSync(path.join(dir, PAID_FILE), 'utf8');
  assert.ok(!/duel:signaction|duel:play\b/.test(paid), PAID_FILE + ' never signs and never launches through the widget');
  assert.ok(!/setItem\([^)]*(?:entryToken|stake|slPaidLaunch)/.test(paid), PAID_FILE + ' never writes the hand-off back');
  assert.ok(!/\b(?:console|log)\.\w+\([^)]*token/i.test(paid), PAID_FILE + ' never logs the token');
});
