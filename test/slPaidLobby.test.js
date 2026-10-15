'use strict';
// slPaidLobby: the lobby and the wallet widget for paid snake on the new engine (PAID-SL-DESIGN.md 2, 11.1 slPaidLobby;
// task T7). Runs the real public/js/v2/board.js and play.js with the widget's real launch code cut from main.jsx
// (test/v2LobbyHarness.js, the v2route lobby harness), and the real public/js/slx/slxPaid.js on the HUD fake page
// (test/slxHudFakes.js) wherever the question is what an /sl page would make of the hand-off left in sessionStorage.
//
// It checks: play.js picks the engine from the board's OPEN snake row at the stake and never from the row it was handed
// (an old closed row listed first still plays engine 'sl', critic C-3), and asks the wallet for nothing with no open
// row; the free /sl branch clears entryToken, entrySol, stake, slPaidLaunch and slxPaidCut before the page loads, so a
// stale token plus a Free click is a free page; the widget honours engine 'sl' for a paid snake rung only, stakes it
// on this origin and opens /sl in #game-frame with a fresh one-shot nonce; switched off, the old row plays with no
// engine; the nightly event is still watched on /game.html in the br room.
const test = require('node:test');
const assert = require('node:assert');
const { lobbyHarness } = require('./v2LobbyHarness.js');
const { makePage } = require('./slxHudFakes.js');

const plain = (x) => JSON.parse(JSON.stringify(x));   // across the vm realm
const row = (id, stake, state, players) => ({ id, game: 'snake', region: 'na', stake, players: players || 0, parked: 0,
  bots: 0, capacity: id.indexOf('sl:') === 0 && stake > 0 ? 22 : null, state });
const SL_FREE = row('sl:na:s0', 0, 'open');
const SL = (stake, state, players) => row('sl:na:s' + stake, stake, state || 'open', players);
const OLD = (stake, state, players) => row('snake:na:s' + stake, stake, state || 'open', players);
const HANDOFF = ['entryToken', 'entrySol', 'stake', 'slPaidLaunch', 'slxPaidCut'];
const STALE = 'tok-stale-' + 'f00d'.repeat(8);
const quotes = (h) => h.fetched.filter((u) => /stake-quote|submit-stake/.test(u));

// What a /sl page loaded on this sessionStorage would make of it: the real slxPaid.js on the HUD fake page.
function slPage(session) {
  const P = makePage({ win: { sessionStorage: session } });
  P.load('slxPaid.js');
  return P.D.slx;
}

test('the engine pick: the open snake row at the stake names it; sl: is engine sl, an old row none', async () => {
  // The new engine's rows open: engine 'sl', staked on this origin even with the EU region picked.
  const h = lobbyHarness([SL_FREE, SL(0.5), SL(1, 'open', 3)]);
  await h.win.V2Board.load();
  h.win.localStorage.setItem('duelseries_region', 'eu');
  h.win.V2Play.launch('snake', { stake: 0.5 });
  assert.deepStrictEqual(plain(h.plays), [{ game: 'snake', sel: { stake: 0.5, engine: 'sl' } }]);
  await assert.rejects(h.pending(), /no server here/, 'the stub server refuses the quote');
  assert.deepStrictEqual(quotes(h), ['/api/stake-quote?stake=0.5'], 'quoted where the sl door is');
  assert.strictEqual(h.el('game-frame').src, '', 'nothing opened without a stake');
  // The old engine's row open: no engine, the region's server, as before.
  const o = lobbyHarness([SL_FREE, OLD(0.5), OLD(1)]);
  await o.win.V2Board.load();
  o.win.localStorage.setItem('duelseries_region', 'eu');
  o.win.V2Play.launch('snake', { stake: 1 });
  assert.deepStrictEqual(plain(o.plays), [{ game: 'snake', sel: { stake: 1 } }]);
  await assert.rejects(o.pending(), /no server here/);
  assert.deepStrictEqual(quotes(o), ['https://eu.duelseries.com/api/stake-quote?stake=1']);
});

test('no open snake row at the stake: refused before the wallet, signed in or not', async () => {
  const tries = [
    ['no board at all', null],
    ['an empty board', []],
    ['the rung shut', [SL_FREE, SL(0.5, 'closed', 1), OLD(1)]],
    ['a row of another game', [SL_FREE, { id: 'ag:na:s0.5', game: 'agar', region: 'na', stake: 0.5, state: 'open' }]],
  ];
  for (const [why, rows] of tries) {
    const h = lobbyHarness(rows);
    await h.win.V2Board.load();
    let logins = 0;
    h.win.duelWalletLogin = () => { logins++; };
    h.win.V2Play.launch('snake', { stake: 0.5 });
    h.win.V2Detail = { game: 'snake', stake: 0.5 };
    h.win.V2Play.playChosen();
    h.win.duelWallet = { authenticated: false };
    h.win.V2Play.launch('snake', { stake: 0.5 });
    assert.deepStrictEqual(plain(h.plays), [], why + ': the widget is never asked');
    assert.strictEqual(logins, 0, why + ': not even a sign-in prompt');
    assert.match(h.el('play-msg').textContent, /not open right now|No room at that buy-in/, why + ': the player is told');
    assert.deepStrictEqual(quotes(h), [], why + ': nothing was quoted');
  }
  // The board check comes before the wallet: with the rung open, a signed-out player is asked to sign in.
  const ok = lobbyHarness([SL_FREE, SL(0.5)]);
  await ok.win.V2Board.load();
  let logins = 0;
  ok.win.duelWalletLogin = () => { logins++; };
  ok.win.duelWallet = { authenticated: false };
  ok.win.V2Play.launch('snake', { stake: 0.5 });
  assert.strictEqual(logins, 1);
  assert.deepStrictEqual(plain(ok.plays), []);
});

test('an old closed row listed BEFORE the open sl row still plays engine sl; a stale Enter on it asks for nothing (C-3)', async () => {
  // /api/live puts liveBoard's rows first: the old $0.50 room finishing its players, closed, then the open sl row.
  const rows = [OLD(0.5, 'closed', 2), OLD(1, 'closed', 1), SL_FREE, SL(0.5, 'open', 1), SL(1)];
  const h = lobbyHarness(rows);
  await h.win.V2Board.load();
  h.win.localStorage.setItem('duelseries_region', 'eu');
  assert.ok(!h.el('lob').innerHTML.includes('snake:na:s0.5'), 'the closed old room is not on the board to join');
  // The Enter button of the closed row (a board drawn before the switch flipped): nothing reaches the widget.
  h.win.V2Board.join('snake:na:s0.5');
  h.win.V2Board.join('snake:na:s1');
  assert.deepStrictEqual(plain(h.plays), [], 'a stale Enter is refused before the widget');
  // The detail screen's Play: playChosen hands launch the FIRST row at the stake, the closed old one.
  h.win.V2Detail = { game: 'snake', stake: 0.5 };
  h.win.V2Play.playChosen();
  assert.deepStrictEqual(plain(h.plays), [{ game: 'snake', sel: { stake: 0.5, engine: 'sl' } }], 'the open sl row decides');
  await assert.rejects(h.pending(), /no server here/);
  // Handing launch the closed row itself changes nothing: it never trusts the row.
  h.win.V2Play.enter(rows[1]);
  assert.deepStrictEqual(plain(h.plays[1]), { game: 'snake', sel: { stake: 1, engine: 'sl' } });
  await assert.rejects(h.pending(), /no server here/);
  assert.deepStrictEqual(quotes(h), ['/api/stake-quote?stake=0.5', '/api/stake-quote?stake=1'], 'both on this origin');
  assert.strictEqual(h.el('game-frame').src, '');
});

test('switched off (sl:paid:off): the sl row is closed and the old row plays with no engine, whichever comes first', async () => {
  for (const rows of [[SL(0.5, 'closed', 1), SL_FREE, OLD(0.5, 'open', 2)], [OLD(0.5), SL_FREE, SL(0.5, 'closed', 1)]]) {
    const h = lobbyHarness(rows);
    await h.win.V2Board.load();
    h.win.localStorage.setItem('duelseries_region', 'eu');
    h.win.V2Board.join('sl:na:s0.5');
    assert.deepStrictEqual(plain(h.plays), [], 'a stale Enter on the closed sl row asks for nothing');
    h.win.V2Detail = { game: 'snake', stake: 0.5 };
    h.win.V2Play.playChosen();
    assert.deepStrictEqual(plain(h.plays), [{ game: 'snake', sel: { stake: 0.5 } }], 'the old engine, no engine named');
    await assert.rejects(h.pending(), /no server here/);
    assert.deepStrictEqual(quotes(h), ['https://eu.duelseries.com/api/stake-quote?stake=0.5'], 'on the region, as before');
  }
});

test('the free /sl branch clears the paid hand-off before the page loads: a stale token plus Free is a free page', async () => {
  const seed = (ss) => {
    ss.setItem('entryToken', STALE);
    ss.setItem('entrySol', '0.5');
    ss.setItem('stake', '0.5');
    ss.setItem('slPaidLaunch', 'stale-nonce');
    ss.setItem('slxPaidCut', '1');
  };
  // The counterfactual first: that hand-off on an /sl page IS paid (so the clearing below is what makes Free free).
  const raw = lobbyHarness([]).win.sessionStorage;
  seed(raw);
  assert.deepStrictEqual(plain(slPage(raw).paidAuth()), { paid: 1, stake: 0.5, entryToken: STALE });

  const h = lobbyHarness([SL_FREE, SL(0.5), OLD(0.5, 'closed', 1)]);
  await h.win.V2Board.load();
  const ss = h.win.sessionStorage;
  seed(ss);
  const frame = h.el('game-frame');
  let atLoad = null;
  Object.defineProperty(frame, 'src', {
    get() { return this._src || ''; },
    set(v) { atLoad = HANDOFF.filter((k) => ss.getItem(k) !== null); this._src = v; }
  });
  h.win.V2Board.join('sl:na:s0');                       // the free row's Enter
  assert.strictEqual(frame.src, '/sl');
  assert.deepStrictEqual(plain(atLoad), [], 'every paid key was gone before the page was set');
  assert.strictEqual(ss.getItem('playerName'), 'Tester');
  assert.deepStrictEqual(plain(h.plays), [], 'Free never reaches the widget');
  const slx = slPage(ss);
  assert.strictEqual(slx.paidAuth(), null, 'no paid auth: the stale token is never sent');
  assert.strictEqual(slx.paidHold(), false, 'and no reload notice holds the free page');
  assert.strictEqual(slx.paid.on, false);
});

test('the widget: engine sl only for a paid snake rung; staked on this origin; /sl in #game-frame with a fresh nonce', async () => {
  const h = lobbyHarness([]);
  h.win.localStorage.setItem('duelseries_region', 'eu');
  const play = async (detail) => {
    h.win.dispatchEvent(new h.win.CustomEvent('duel:play', { detail }));
    await assert.rejects(h.pending(), /no server here/, JSON.stringify(detail));
  };
  await play({ game: 'snake', stake: 0.5, engine: 'sl' });
  await play({ game: 'snake', stake: 0.5 });
  await play({ game: 'snake', stake: 0.5, engine: 'old' });
  await play({ game: 'paper', stake: 0.5, engine: 'sl' });
  await play({ game: 'agar', stake: 1, engine: 'sl' });
  await play({ game: 'snake', lobbyType: 'dollar', engine: 'sl' });
  assert.deepStrictEqual(plain(h.plays.map((p) => p.sel)),
    [{ stake: 0.5, engine: 'sl' }, { stake: 0.5 }, { stake: 0.5 }, { stake: 0.5 }, { stake: 1 }, { lobbyType: 'dollar' }],
    'the engine rides only on a snake rung');
  assert.deepStrictEqual(quotes(h), [
    '/api/stake-quote?stake=0.5',
    'https://eu.duelseries.com/api/stake-quote?stake=0.5',
    'https://eu.duelseries.com/api/stake-quote?stake=0.5',
    '/api/stake-quote?stake=0.5',
    '/api/stake-quote?stake=1',
    'https://eu.duelseries.com/api/stake-quote?lobbyType=dollar',
  ]);

  // The page: a paid round on the new engine (what stakeAndPlay and the restake relaunch both call).
  const ss = h.win.sessionStorage;
  h.win.localStorage.setItem('duelseries_playername', 'Tester');   // the lobby saves it on every Play
  const wallet = { address: 'WALLET1' };
  let launched = 0;
  h.win.launchStaked('snake', { stake: 0.5, engine: 'sl' }, { entryToken: 'TOK-1', worth: 0.5, stake: 0.5, region: null },
    wallet, () => { launched++; });
  assert.strictEqual(launched, 1);
  assert.strictEqual(h.el('game-frame').src, '/sl', 'the new engine\'s page');
  assert.strictEqual(h.el('game-frame').style.display, 'block', 'in the snake frame');
  assert.strictEqual(h.el('agar-frame').src, '', 'and not the agar frame');
  const nonce1 = ss.getItem('slPaidLaunch');
  assert.match(nonce1, /^[0-9a-f]{24}$/, 'a random one-shot nonce');
  assert.deepStrictEqual([ss.getItem('entryToken'), ss.getItem('entrySol'), ss.getItem('stake'), ss.getItem('lobbyType'),
    ss.getItem('walletAddress'), ss.getItem('spectateOnly')], ['TOK-1', '0.5', '0.5', null, 'WALLET1', null]);
  // The hand-off reaches the /sl page as money exactly once, and leaves sessionStorage.
  const slx = slPage(ss);
  assert.deepStrictEqual(plain(slx.paidAuth()), { paid: 1, stake: 0.5, entryToken: 'TOK-1' });
  assert.deepStrictEqual(HANDOFF.slice(0, 4).map((k) => ss.getItem(k)), [null, null, null, null]);
  h.win.launchStaked('snake', { stake: 1, engine: 'sl' }, { entryToken: 'TOK-2', worth: 1, stake: 1, region: null }, wallet, () => {});
  assert.notStrictEqual(ss.getItem('slPaidLaunch'), nonce1, 'every launch its own nonce');

  // Every other launch clears the mark and opens its own page: no engine, Free, a tier, another game.
  const others = [
    ['snake', { stake: 0.5 }, '/game.html', 'game-frame'],
    ['snake', { stake: 0.5, engine: 'old' }, '/game.html', 'game-frame'],
    ['snake', { stake: 0, engine: 'sl' }, '/game.html', 'game-frame'],
    ['snake', { lobbyType: 'dollar', engine: 'sl' }, '/game.html', 'game-frame'],
    ['paper', { stake: 0.5, engine: 'sl' }, '/paper-arena', 'game-frame'],
    ['agar', { stake: 0.5, engine: 'sl' }, '/ag', 'agar-frame'],
  ];
  for (const [game, sel, page, frame] of others) {
    ss.setItem('slPaidLaunch', 'left-over');
    h.win.launchStaked(game, sel, { entryToken: 'T', worth: 0.5, stake: 0.5, region: 'na' }, wallet, () => {});
    assert.strictEqual(h.el(frame).src, page, game + ' ' + JSON.stringify(sel));
    assert.strictEqual(ss.getItem('slPaidLaunch'), null, 'no mark beside a token the new engine was not bought for');
  }
});

test('spectateEvent still opens /game.html in the br room; an engine sl launch never opens /game.html', async () => {
  const h = lobbyHarness([SL_FREE, SL(0.5), SL(1)]);
  await h.win.V2Board.load();
  h.win.V2Play.spectateEvent();
  assert.strictEqual(h.el('game-frame').src, '/game.html', 'the event is the old engine\'s br room');
  assert.strictEqual(h.win.sessionStorage.getItem('lobbyType'), 'br');
  assert.strictEqual(h.win.sessionStorage.getItem('spectateOnly'), 'true');

  // Every way a paid sl round is opened lands on /sl: the lobby's launch (stakeAndPlay -> launchStaked) and a Play
  // again paid for after its page went (the bridge's relaunch -> launchStaked with the rung it kept, engine and all).
  const g = lobbyHarness([SL_FREE, SL(0.5), SL(1)]);
  g.win.localStorage.setItem('duelseries_playername', 'Tester');
  const opened = [];
  Object.defineProperty(g.el('game-frame'), 'src', { get() { return opened[opened.length - 1] || ''; }, set(v) { opened.push(v); } });
  for (const stake of [0.5, 1]) {
    g.win.launchStaked('snake', { stake, engine: 'sl' }, { entryToken: 'T' + stake, worth: stake, stake, region: null },
      { address: 'WALLET1' }, () => {});
  }
  assert.deepStrictEqual(opened, ['/sl', '/sl']);
  assert.ok(!opened.includes('/game.html'));
});
