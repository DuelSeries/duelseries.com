'use strict';
// Guards the parallel-route migration: the redesigned lobby has to be reachable
// on the real server without disturbing the live one. These are structural
// checks, not behaviour — the page itself is exercised in the browser.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const v2 = () => fs.readFileSync(path.join(ROOT, 'public/v2.html'), 'utf8');
const server = () => fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');

test('the redesigned lobby is served at /v2', () => {
  const s = server();
  assert.ok(/app\.get\(\s*'\/v2'/.test(s), "server/index.js registers a '/v2' route");
  assert.ok(s.includes('v2.html'), 'the route points at v2.html');
});

test('the v2 shell is intact', () => {
  const html = v2();
  assert.ok(html.includes('<title>DuelSeries</title>'), 'has the title');
  // The card art is the real game renderer, so these must keep loading.
  for (const src of ['/shared/constants.js', '/js/HexGrid.js', '/js/SnakeGL.js',
                     '/js/FoodGL.js', '/js/Renderer.js', '/js/Camera.js']) {
    assert.ok(html.includes(src), `still loads ${src}`);
  }
});

test('the live lobby is untouched by the migration', () => {
  // index.html and lobby.js stay authoritative until the cutover phase, so a
  // half-migrated push can never take the real lobby down.
  assert.ok(fs.existsSync(path.join(ROOT, 'public/index.html')), 'index.html still exists');
  assert.ok(fs.existsSync(path.join(ROOT, 'public/js/lobby.js')), 'lobby.js still exists');
  assert.ok(!server().includes("app.get('/', "), 'the root route is not redirected yet');
});

test('social data comes from the server, not from a generated roster', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/v2/social.js'), 'utf8');
  for (const ep of ['/api/earningsboard', '/api/players/search', '/api/profile/',
                    '/api/stats/winnings', '/api/money-config']) {
    assert.ok(src.includes(ep), `social.js calls ${ep}`);
  }
  const html = v2();
  for (const gone of ['mkPlayer', 'function seeded(', 'const PLAYERS=', 'const PNAMES=']) {
    assert.ok(!html.includes(gone), `the generated roster is gone: ${gone}`);
  }
});

test('the profile shows only figures the server actually records', () => {
  // getProfile returns name, totalEarnings, gamesPlayed, playTimeSeconds and
  // earnings series — no per-game win/loss, buy-in or house cut. Showing those
  // would mean inventing them, which is what the prototype did.
  const src = fs.readFileSync(path.join(ROOT, 'public/js/v2/social.js'), 'utf8');
  assert.ok(!/Win rate/.test(src), 'no win rate, the server does not record it per player');
  assert.ok(!/House cut paid/.test(src), 'no per-player house cut');
  assert.ok(src.includes('gamesPlayed') && src.includes('playTimeSeconds'),
    'shows the fields that do exist');
});

test('search is debounced and cancels the previous request', () => {
  // Without both, fast typing lands an earlier response after a later one and
  // the list shows results for a query the user has already moved past.
  const src = fs.readFileSync(path.join(ROOT, 'public/js/v2/social.js'), 'utf8');
  assert.ok(src.includes('setTimeout'), 'debounced');
  assert.ok(src.includes('AbortController'), 'aborts the in-flight request');
});

test('the skin store is shared with the live lobby', () => {
  // Both lobbies run side by side during the migration, so they have to agree
  // on the equipped skin rather than each keeping their own.
  const key = 'duelseries_skin_id';
  assert.ok(v2().includes(key), 'v2 uses the live skin key');
  assert.ok(fs.readFileSync(path.join(ROOT, 'public/js/lobby.js'), 'utf8').includes(key),
    'the live lobby uses the same key');
});

test('the wallet screen delegates to the Privy widget, not its own money code', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/v2/wallet.js'), 'utf8');
  for (const g of ['duelWalletLogin', 'duelWalletFund', 'duelWalletSend', 'duelwallet:change'])
    assert.ok(src.includes(g), `wallet.js uses ${g}`);
  // A second implementation of staking or signing here would be a second money
  // path to keep correct. There must not be one.
  for (const bad of ['submit-stake', 'stake-quote', 'signTransaction', 'Keypair'])
    assert.ok(!src.includes(bad), `wallet.js does not do its own ${bad}`);
});

test('the v2 lobby mounts the same wallet widget as the live lobby', () => {
  const html = v2();
  assert.ok(html.includes('/wallet/widget.js'), 'widget is mounted');
  assert.ok(html.includes('id="wallet-root"'), 'widget has its mount point');
  assert.ok(html.indexOf('window.global=window.global') < html.indexOf('/wallet/widget.js'),
    'the node-global shims run before the bundle, as they must');
});

test('a signed-out wallet never shows a fabricated balance', () => {
  // "$0.00" and "not connected" mean very different things about someone's
  // money. The mock hardcoded $12.40 into the markup; nothing may do that.
  const html = v2();
  assert.ok(!/\$12\.40/.test(html), 'no hardcoded balance in the markup');
  assert.ok(!html.includes('C5cnQ7v2'), 'no hardcoded deposit address');
});

test('stats show profit only when buy-ins are actually recorded', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/v2/stats.js'), 'utf8');
  assert.ok(src.includes('/api/my-profile'), 'reads the real profile');
  // Profit is real now that stakes_history exists, but only for games played
  // since. Showing earnings-minus-nothing would read as pure profit.
  assert.ok(src.includes('stakesTracked'), 'checks whether buy-ins exist');
  assert.ok(/if \(tracked\)/.test(src), 'and gates the profit tile on it');
  assert.ok(src.includes('not recorded yet'), 'says so when they are not');
  // Win rate and per-game house cut still are not derivable per player.
  for (const bad of ['Win rate', 'House cut paid'])
    assert.ok(!src.includes(bad), `stats.js still does not claim ${bad}`);
});

test('buy-ins are recorded at the single point every paid entry passes', () => {
  // Four handlers consume entry tokens. Recording at each would let one drift
  // or be forgotten; recording inside consumePaidEntry cannot.
  const src = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
  assert.ok(/function consumePaidEntry\(entryToken, shortType, game\)/.test(src),
    'consumePaidEntry takes the game');
  assert.ok(/db\.recordStake\(/.test(src), 'and records the stake');
  assert.equal((src.match(/db\.recordStake\(/g) || []).length, 1,
    'recorded in exactly one place');
  // A failed stats write must never cost someone their seat.
  const i = src.indexOf('db.recordStake(');
  assert.ok(src.slice(i, i + 200).includes('.catch('), 'and never throws into the join path');
  assert.ok(!/await db\.recordStake/.test(src), 'and is never awaited');
});

test('the profile series are read from where the server actually puts them', () => {
  // getProfile nests week/month/sixMonth/allTime under `history`. Reading them
  // flat silently yields no chart at all, which is exactly what happened.
  const src = fs.readFileSync(path.join(ROOT, 'public/js/v2/social.js'), 'utf8');
  assert.ok(/p\.history/.test(src), 'social.js reads p.history');
  const db = fs.readFileSync(path.join(ROOT, 'server/db.js'), 'utf8');
  assert.ok(/history: \{/.test(db), 'and the server really does nest them');
});

test('no invented game history survives in the shell', () => {
  const html = v2();
  for (const gone of ['const SESSIONS=', 'const ROWS=', 'const CUM=', 'function drawStats',
                      'function drawChart', "const RAKE=0.10"])
    assert.ok(!html.includes(gone), `gone: ${gone}`);
});

test('the board reads /api/live and invents no counts of its own', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/v2/board.js'), 'utf8');
  assert.ok(src.includes('/api/live'), 'reads the live board');
  const html = v2();
  assert.ok(!html.includes('const LOBBIES=['), 'the hand-written lobby rows are gone');
  assert.ok(!/cap:30/.test(html), 'and the invented capacity with them');
});

test('the server reports capacity as null, not an invented seat count', () => {
  // Persistent rooms have no seat limit: the world grows with the crowd. A
  // number here would put a fake "7 of 30" in front of someone about to stake.
  const src = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
  assert.ok(/capacity: null/.test(src), 'capacity is null');
  assert.ok(src.includes("app.get('/api/live'"), '/api/live exists');
});

test('bots are reported separately and not folded into the player count', () => {
  // "12 playing" when eleven are bots is a lie told to someone about to stake.
  const src = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
  assert.ok(/players: hit \? hit\.players/.test(src), 'players is the real count');
  assert.ok(/bots: hit \?/.test(src), 'bots are their own field');
  const board = fs.readFileSync(path.join(ROOT, 'public/js/v2/board.js'), 'utf8');
  assert.ok(!/players\s*\+\s*.*bots|bots\s*\+\s*.*players/.test(board),
    'the client never adds them together');
});

test('play delegates to the widget and never stakes on its own', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/v2/play.js'), 'utf8');
  assert.ok(src.includes("'duel:play'"), 'fires the same event the live lobby fires');
  for (const bad of ['submit-stake', 'stake-quote', 'signTransaction'])
    assert.ok(!src.includes(bad), `play.js does not do its own ${bad}`);
});

test('a launch that does not name a room is refused, not defaulted', () => {
  // The widget defaults a missing lobbyType to 'dime'. Dispatching without
  // naming a room would silently charge ten cents for one nobody chose.
  const src = fs.readFileSync(path.join(ROOT, 'public/js/v2/play.js'), 'utf8');
  assert.ok(/if \(!hasStake && !hasTier\)/.test(src), 'an unnamed room is checked for');
  const guard = src.indexOf('if (!hasStake && !hasTier)');
  const fire = src.indexOf("new CustomEvent('duel:play'");
  assert.ok(guard > -1 && fire > guard, 'and checked before anything is dispatched');
  // Exactly one selector goes out, so the server never has to guess.
  assert.ok(/\{ game: game, stake: Number\(sel\.stake\) \}/.test(src), 'sends a rung');
  assert.ok(/\{ game: game, lobbyType: sel\.lobbyType \}/.test(src), 'or a tier, not both');
});

test('a respawn re-buys the room the player is already in', () => {
  // Taken from socket._stake, not from anything the client sends at respawn
  // time, so nobody dies in the $0.25 room and respawns into the $20 one.
  const src = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
  assert.ok(/consumePaidEntryAtStake\(entryToken, socket\._stake/.test(src),
    'respawn uses the socket\'s own rung');
});

test('the ladder door demands a token bought for that exact rung', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
  assert.ok(/consumePaidEntryAtStake\(entryToken, Number\(stake\)/.test(src),
    'join checks the token against the rung');
  const store = fs.readFileSync(path.join(ROOT, 'server/entryStore.js'), 'utf8');
  assert.ok(/Math\.abs\(t\.stake - stake\) > EPS/.test(store),
    'and the store compares the amounts rather than trusting the request');
});

test('the lobby pauses its animations while the game is up', () => {
  // The game shares the main thread. Animating behind it is what produced the
  // 30fps drop that took a day to trace to the lobby's preview snake.
  const html = v2();
  assert.ok(html.includes('window._pauseLobbyAnims'), 'publishes the pause hook');
  assert.ok(html.includes('window._resumeLobbyAnims'), 'and the resume hook');
  assert.ok(html.includes('body.ingame .tkrun'), 'the ticker stops too');
  // _paused must be declared before the frame loop that reads it, or the whole
  // script dies in the temporal dead zone on the first frame.
  assert.ok(html.indexOf('let _paused=false;') < html.indexOf('(function loop(t){'),
    '_paused is declared above the loop');
});

test('the game iframe keeps the id the wallet widget looks up', () => {
  const html = v2();
  assert.ok(html.includes('id="game-frame"'), 'the frame exists under the expected id');
  const widget = fs.readFileSync(path.join(ROOT, 'public/wallet/widget.js'), 'utf8');
  assert.ok(widget.includes('game-frame'), 'and the widget really does look it up');
});

test('the wallet widget can stake by ladder rung as well as by tier', () => {
  // The bundle is generated, so this checks the built artefact rather than the
  // source: a stale bundle is the failure mode that matters.
  const b = fs.readFileSync(path.join(ROOT, 'public/wallet/widget.js'), 'utf8');
  assert.ok(b.includes('/api/stake-quote?stake='), 'quotes by rung');
  assert.ok(b.includes('/api/stake-quote?lobbyType='), 'and still by tier');
  assert.ok(/stake:.{0,20}signedTx/.test(b), 'submits a rung');
  assert.ok(/lobbyType:.{0,20}signedTx/.test(b), 'and still submits a tier');
});

test('the widget source and the shipped bundle have not drifted apart', () => {
  // A source edit that was never rebuilt ships nothing. Both must mention the
  // ladder or the bundle is stale.
  const src = fs.readFileSync(path.join(ROOT, 'wallet-widget/src/main.jsx'), 'utf8');
  const bundle = fs.readFileSync(path.join(ROOT, 'public/wallet/widget.js'), 'utf8');
  assert.ok(src.includes('/api/stake-quote?stake='), 'source has the ladder path');
  assert.ok(bundle.includes('/api/stake-quote?stake='), 'and so does the bundle');
});

test('the lobby makes no claim about money it cannot honour', () => {
  // The prototype's tournament block advertised a live $20 prize with a running
  // countdown and a podium of winners. There is no tournament system. In front
  // of players staking real money that is a promise, not a placeholder.
  const html = v2();
  for (const claim of ['winner takes all', 'top three split', 'Ends in', 'chip live'])
    assert.ok(!html.includes(claim), `no fabricated tournament claim: ${claim}`);
  // The handlers must be gone as code, not merely unmentioned: a comment naming
  // them is fine, a live onclick or definition is not.
  for (const fn of ['enterTournament', 'remindMe']) {
    assert.ok(!html.includes(`onclick="${fn}`), `nothing calls ${fn}`);
    assert.ok(!html.includes(`function ${fn}(`), `${fn} is not defined`);
  }
  // The section still exists and says what it is.
  assert.ok(html.includes('Not running yet'), 'it says the events are not running');
  assert.ok(/Planned/.test(html), 'and marks them planned');
});
