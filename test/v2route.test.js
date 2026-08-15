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
