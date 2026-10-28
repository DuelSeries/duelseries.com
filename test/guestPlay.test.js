'use strict';
/* Guests (Owen 2026-10-26, "yes, free only"): signed out, the free rooms play at once under a Guest name
   (public/js/v2/play.js guestFree, guestName, openGuestTable). A paid rung, the battle royale, or anything the
   widget would have to stake for still asks to sign in, and a guest launch never reaches the wallet widget. */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PLAY = fs.readFileSync(path.join(ROOT, 'public/js/v2/play.js'), 'utf8');

function memStore(init) {
  const m = new Map(Object.entries(init || {}));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), map: m };
}

// A lobby with play.js loaded: signed out unless wallet is given.
function lobby({ wallet = null, local = {} } = {}) {
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, style: { display: '' }, src: '', value: '', textContent: '', hidden: true,
    classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {} });
  const events = [];
  let logins = 0;
  const win = {
    localStorage: memStore(local), sessionStorage: memStore({ googleId: 'OLD', walletAddress: 'OLD' }), console,
    document: { getElementById: el, addEventListener() {}, readyState: 'complete', activeElement: null,
      body: { classList: { add() {}, remove() {} } } },
    addEventListener() {}, MutationObserver: class { observe() {} },
    CustomEvent: class { constructor(type, o) { this.type = type; this.detail = o && o.detail; } },
    dispatchEvent: (e) => { events.push(e); return true; },
    duelWalletLogin: () => { logins++; },
    setTimeout: () => 0,
  };
  if (wallet) win.duelWallet = { ready: true, authenticated: true, address: wallet };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(PLAY, win, { filename: 'play.js' });
  return { win, els, events, logins: () => logins, ss: win.sessionStorage, ls: win.localStorage };
}
const shown = (L, id) => !!L.els[id] && L.els[id].style.display === 'block';

test('a guest plays every free room at once, as Guest####, with no wallet and no widget', () => {
  const cases = [
    ['snake', { stake: 0 }, 'game-frame', '/sl'],
    ['paper', { stake: 0 }, 'game-frame', '/paper-arena'],
    ['agar', { stake: 0 }, 'agar-frame', '/ag'],
    ['chomp', { stake: 0 }, 'game-frame', '/chomp'],
    ['knockout', { lobbyType: 'free' }, 'game-frame', '/knockout'],
    ['battleship', { lobbyType: 'free' }, 'game-frame', '/battleship'],
    ['headsoccer', { lobbyType: 'free' }, 'game-frame', '/headsoccer'],
    ['pool8', { lobbyType: 'free' }, 'game-frame', '/pool8'],
  ];
  for (const [game, sel, frame, page] of cases) {
    const L = lobby();
    L.win.V2Play.launch(game, sel);
    assert.ok(shown(L, frame), game + ' opens its frame');
    assert.strictEqual(L.els[frame].src, page, game);
    assert.match(L.ss.getItem('playerName'), /^Guest\d{4}$/, game + ' plays as a guest');
    assert.strictEqual(L.ss.getItem('googleId'), null, game + ': no identity left over');
    assert.strictEqual(L.ss.getItem('walletAddress'), null, game + ': no wallet left over');
    assert.strictEqual(L.events.length, 0, game + ': the wallet widget is never asked');
    assert.strictEqual(L.logins(), 0, game + ': no sign in');
    if (game === 'paper' || game === 'agar') {
      assert.deepStrictEqual([L.ss.getItem('stake'), L.ss.getItem('entryToken'), L.ss.getItem('entrySol')], ['0', '', '0'],
        game + ': the free hand-off, an empty token');
    }
  }
});

test('the guest name sticks for the visit, and a name typed before on this device wins', () => {
  const L = lobby();
  L.win.V2Play.launch('agar', { stake: 0 });
  const first = L.ss.getItem('playerName');
  assert.strictEqual(L.ls.getItem('duelseries_guestname'), first);
  assert.strictEqual(L.ls.getItem('duelseries_playername'), null, 'never the account name key');
  const again = lobby({ local: { duelseries_guestname: first } });
  again.win.V2Play.launch('paper', { stake: 0 });
  assert.strictEqual(again.ss.getItem('playerName'), first);
  const named = lobby({ local: { duelseries_playername: 'Owen' } });
  named.win.V2Play.launch('snake', { stake: 0 });
  assert.strictEqual(named.ss.getItem('playerName'), 'Owen');
});

test('signed out, a paid rung or the battle royale still asks to sign in and opens nothing', () => {
  for (const [game, sel] of [['paper', { stake: 0.5 }], ['agar', { stake: 1 }], ['chomp', { stake: 0.5 }], ['knockout', { stake: 0.5 }],
    ['battleship', { lobbyType: 'dollar' }], ['snake', { lobbyType: 'br' }], ['snake', { lobbyType: 'free' }], ['paper', { lobbyType: 'free' }]]) {
    const L = lobby();
    L.win.V2Board = { lobbies: [{ game, stake: sel.stake, id: game + ':na:s' + sel.stake, state: 'open' }], playableStakes: () => [sel.stake] };
    L.win.V2Event = { engine: () => 'sl', pull() {} };
    L.win.V2Play.launch(game, sel);
    assert.ok(!shown(L, 'game-frame') && !shown(L, 'agar-frame'), game + ' ' + JSON.stringify(sel) + ': no frame');
    assert.strictEqual(L.events.length, 0, 'no stake asked for');
    assert.ok(L.logins() === 1 || /not open|not available|exist/.test(L.els['play-msg'].textContent),
      game + ' ' + JSON.stringify(sel) + ': sign in (or the rung is refused first)');
  }
});

test('signed in, a free Paper table still goes through the widget as before', () => {
  const L = lobby({ wallet: 'Wa11et', local: { duelseries_playername: 'Owen' } });
  L.els['play-name'] = { value: 'Owen', style: {}, classList: { add() {}, remove() {}, toggle() {} } };
  L.win.V2Play.launch('paper', { stake: 0 });
  assert.strictEqual(L.events.length, 1);
  assert.strictEqual(L.events[0].type, 'duel:play');
  assert.strictEqual(JSON.stringify(L.events[0].detail), JSON.stringify({ game: 'paper', stake: 0 }));
  assert.ok(!shown(L, 'game-frame'), 'the widget opens the page, not play.js');
});
