'use strict';
// spectateLobby: the lobby's Spectate in every game (Owen 2026-10-15: "in every single game"). Runs the real
// public/js/v2/board.js and play.js (test/v2LobbyHarness.js) and reads public/v2.html for the button.
//
// It checks: Spectate opens each game's own page in the right frame with the watch mark that page reads (dsWatch =
// the game id; agar.io and the old snake engine keep spectateOnly), with every money key gone first so a watch page
// can never be a paid hand-off; the free snake watch goes to /sl only while the board's free snake row is the new
// engine's; a Play after a Spectate whose page never booted takes the mark out, so it is a plain Play; a game that
// is not open is refused; and the button is on the Free rung of every game, shut on a game that is not open.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { lobbyHarness } = require('./v2LobbyHarness.js');

const ROOT = path.join(__dirname, '..');
const row = (id, game, stake) => ({ id, game, region: 'na', stake, players: 1, parked: 0, bots: 0, state: 'open' });
const SL_FREE = row('sl:na:s0', 'snake', 0);
const OLD_FREE = row('snake:na:s0', 'snake', 0);
const MONEY = ['entryToken', 'entrySol', 'stake', 'slPaidLaunch', 'slxPaidCut', 'slBr', 'spectateOnly'];

function stale(h) {
  const s = h.win.sessionStorage;
  for (const k of MONEY) s.setItem(k, k === 'spectateOnly' ? 'true' : 'stale-' + k);
}

test('Spectate opens each game\'s own page with its watch mark, and no money key survives', async () => {
  for (const [game, page] of [['snake', '/sl'], ['paper', '/paper-arena'], ['knockout', '/knockout'],
    ['battleship', '/battleship'], ['headsoccer', '/headsoccer']]) {
    const h = lobbyHarness([SL_FREE]);
    await h.win.V2Board.load();
    stale(h);
    h.win.V2Play.spectate(game);
    assert.strictEqual(h.el('game-frame').src, page, game);
    assert.strictEqual(h.el('game-frame').style.display, 'block', game);
    assert.strictEqual(h.el('agar-frame').src, '', game + ': never the agar frame');
    assert.strictEqual(h.win.sessionStorage.getItem('dsWatch'), game, game + ': the mark names the game');
    for (const k of MONEY) assert.strictEqual(h.win.sessionStorage.getItem(k), null, game + ': ' + k + ' is gone');
    assert.deepStrictEqual(h.plays, [], game + ': the wallet is never asked');
  }
});

test('agar.io keeps its own flag; the snake falls back to the old engine while the board says so', async () => {
  const a = lobbyHarness([SL_FREE]);
  await a.win.V2Board.load();
  a.win.V2Play.spectate('agar');
  assert.strictEqual(a.el('agar-frame').src, '/ag');
  assert.strictEqual(a.win.sessionStorage.getItem('spectateOnly'), 'true');
  assert.strictEqual(a.win.sessionStorage.getItem('dsWatch'), null);
  const o = lobbyHarness([OLD_FREE]);
  await o.win.V2Board.load();
  o.win.V2Play.spectate('snake');
  assert.strictEqual(o.el('game-frame').src, '/game.html', 'the old free room is watched on its own page');
  assert.strictEqual(o.win.sessionStorage.getItem('spectateOnly'), 'true');
  // The old engine's event watch is unchanged.
  const b = lobbyHarness([SL_FREE]);
  b.win.V2Play.spectate('snake', 'br');
  assert.strictEqual(b.el('game-frame').src, '/game.html');
  assert.strictEqual(b.win.sessionStorage.getItem('lobbyType'), 'br');
});

/* The old engine's free room is the ladder's Free rung (snake:na:s0), which Free Play reaches by stake 0. A Spectate
   that sent no stake made /game.html default to lobbyType 'free', the off-board fixed tier, so the viewer watched an
   empty world reading "No players to spectate" beside a row of ~48 playing. It names the rung as Play does, and a
   lobbyType left by an earlier event watch cannot point it at the battle royale instead. */
test('the old engine\'s free snake is watched on the Free rung Play joins, never the off-board free tier', async () => {
  const h = lobbyHarness([OLD_FREE]);
  await h.win.V2Board.load();
  h.win.sessionStorage.setItem('lobbyType', 'br');   // left by an earlier old-engine event watch
  h.win.V2Play.spectate('snake');
  assert.strictEqual(h.el('game-frame').src, '/game.html');
  assert.strictEqual(h.win.sessionStorage.getItem('spectateOnly'), 'true');
  assert.strictEqual(h.win.sessionStorage.getItem('stake'), '0', 'the Free rung, as Free Play names it');
  assert.strictEqual(h.win.sessionStorage.getItem('lobbyType'), null, 'no tier name to land it elsewhere');
  // /game.html sends that stake with the watch, and the server's stake lookup (getRoomForJoin) is the rung's room.
  const game = fs.readFileSync(path.join(ROOT, 'public/js/game.js'), 'utf8');
  assert.match(game, /const lobbyType\s+= sessionStorage\.getItem\('lobbyType'\)\s+\|\| \(stake === null \? 'free' : null\);/);
  assert.match(game, /socket\.emit\('spectate:join', \{ lobbyType, stake, region: selectedRegion \}\);/);
});

test('a Play after a Spectate whose page never booted is a plain Play', async () => {
  const h = lobbyHarness([SL_FREE]);
  await h.win.V2Board.load();
  h.win.sessionStorage.setItem('dsWatch', 'knockout');   // left by a watch page that never loaded
  h.win.V2Play.launch('knockout', { lobbyType: 'free' });
  assert.strictEqual(h.el('game-frame').src, '/knockout');
  assert.strictEqual(h.win.sessionStorage.getItem('dsWatch'), null, 'the mark is gone before the page loads');
});

test('a game that is not open cannot be watched', () => {
  const h = lobbyHarness([SL_FREE]);
  h.win.V2_IS_SOON = (id) => id === 'omgshooter';
  h.win.V2Play.spectate('omgshooter');
  assert.strictEqual(h.el('game-frame').src, '');
  assert.strictEqual(h.win.sessionStorage.getItem('dsWatch'), null);
});

test('the button: beside Play on every rung of every game (paid too, Owen 2026-10-15), shut on a game that is not open', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/v2.html'), 'utf8');
  assert.match(html, /<div class="gorow">[\s\S]*?id="gobtn"[\s\S]*?<button type="button" class="spec" id="specbtn" onclick="spectateFromDetail\(\)"/);
  assert.ok(!html.includes("det.classList.toggle('agar'"), 'no longer agar.io only');
  assert.match(html, /\.spec\{display:flex;/, 'shown on every rung');
  assert.ok(!html.includes('#detail.freerung .spec{display:flex}'), 'no longer Free only');
  assert.match(html, /specBtn\.disabled=locked;/, 'shut like Play on a game that is not open');
  const fn = html.slice(html.indexOf('function spectateFromDetail(){'), html.indexOf('function goBack('));
  assert.match(fn, /if\(!cur\|\|\(cur\.soon&&!cur\.built\)\)return;/);
  assert.match(fn, /V2Play\.spectate\(cur\.id,null,st>0\?st:0\);/, 'the chosen rung goes with it');
});

// Spectate on a paid rung (Owen, 2026-10-15): the same pages, read only, the rung under its own key (never 'stake').
test('a paid rung: each game opens its watch page with dsWatchStake and no money key; nobody playing is a toast on a table game only', async () => {
  const rows = [SL_FREE, row('sl:na:s0.5', 'snake', 0.5), row('paper:na:s0.5', 'paper', 0.5), row('ag:na:s0.5', 'agar', 0.5),
    row('knockout:na:s0.5', 'knockout', 0.5), row('battleship:na:s0.5', 'battleship', 0.5)];
  for (const [game, page, frame] of [['snake', '/sl', 'game-frame'], ['paper', '/paper-arena', 'game-frame'],
    ['knockout', '/knockout', 'game-frame'], ['battleship', '/battleship', 'game-frame'], ['agar', '/ag', 'agar-frame']]) {
    const h = lobbyHarness(rows);
    await h.win.V2Board.load();
    stale(h);
    h.win.V2Play.spectate(game, null, 0.5);
    assert.strictEqual(h.el(frame).src, page, game);
    assert.strictEqual(h.win.sessionStorage.getItem('dsWatchStake'), '0.5', game + ': the rung to watch');
    for (const k of MONEY) {
      if (game === 'agar' && k === 'spectateOnly') continue; // agar.io's own watch flag
      assert.strictEqual(h.win.sessionStorage.getItem(k), null, game + ': ' + k + ' is gone');
    }
    assert.deepStrictEqual(h.plays, [], game + ': the wallet is never asked');
  }
  // nobody at $1: a table game opens nothing and says so
  const h = lobbyHarness(rows);
  await h.win.V2Board.load();
  const said = [];
  h.win.DSToast = { line: (t) => said.push(t) };
  h.win.V2Play.spectate('knockout', null, 1);
  assert.strictEqual(h.el('game-frame').src, '');
  assert.deepStrictEqual(said, ['Nobody is playing at $1.00 right now.']);
  // an arena game opens its watch page anyway: the whole map until somebody joins (Owen 2026-10-16)
  for (const [game, page, frame] of [['paper', '/paper-arena', 'game-frame'], ['agar', '/ag', 'agar-frame']]) {
    const a = lobbyHarness(rows);
    await a.win.V2Board.load();
    const told = [];
    a.win.DSToast = { line: (t) => told.push(t) };
    a.win.V2Play.spectate(game, null, 1);
    assert.strictEqual(a.el(frame).src, page, game + ' opens at an empty rung');
    assert.strictEqual(a.win.sessionStorage.getItem('dsWatchStake'), '1', game);
    assert.deepStrictEqual(told, [], game + ': no toast');
  }
  // a Free watch after a paid one carries no stake
  const f = lobbyHarness(rows);
  await f.win.V2Board.load();
  f.win.sessionStorage.setItem('dsWatchStake', '1');
  f.win.V2Play.spectate('paper');
  assert.strictEqual(f.win.sessionStorage.getItem('dsWatchStake'), null);
});
