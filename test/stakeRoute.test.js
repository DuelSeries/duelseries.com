'use strict';
// STATUS "BEFORE PAPER_PAID IS SWITCHED ON" item 1 (night queue item 5): the wallet widget
// staked every buy-in on regionBase() (localStorage duelseries_region, can be EU) while the
// Paper arena page connects to its own origin, so a paid Paper token minted on EU was refused on
// NA: a stake with no seat. Knockout and Battleship had the same split (their pages call io()
// with no URL too). A buy-in is now staked on the server its page connects to.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const load = () => import(pathToFileURL(path.join(ROOT, 'wallet-widget/src/stakeRoute.mjs')).href);
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('Paper, Knockout and Battleship stake on this origin whatever region the lobby picked', async () => {
  const { stakeRoute } = await load();
  for (const game of ['paper', 'knockout', 'battleship']) {
    for (const region of ['na', 'eu', null, 'mars']) {
      assert.deepStrictEqual(stakeRoute(game, region), { base: '', region: null }, game + ' ' + region);
    }
  }
});

test('snake and agar follow the region, which is written for their page from the same answer', async () => {
  const { stakeRoute, SERVER_URLS } = await load();
  for (const game of ['snake', 'agar', undefined]) {
    assert.deepStrictEqual(stakeRoute(game, 'eu'), { base: SERVER_URLS.eu, region: 'eu' });
    assert.deepStrictEqual(stakeRoute(game, 'na'), { base: '', region: 'na' });
    assert.deepStrictEqual(stakeRoute(game, 'toString'), { base: '', region: 'na' }, 'no prototype keys');
    assert.deepStrictEqual(stakeRoute(game, null), { base: '', region: 'na' });
  }
});

// The pages really do connect the way the table above says (a page change must update it).
test('the origin games\' pages connect to their own origin; snake and agar to the region', async () => {
  const { ORIGIN_GAMES, SERVER_URLS } = await load();
  assert.deepStrictEqual(Object.keys(ORIGIN_GAMES).sort(), ['battleship', 'knockout', 'paper']);
  assert.match(read('public/js/paper/mp/paperArenaMain.js'), /var socket = root\.io\(\);/);
  assert.match(read('public/js/knockout.js'), /const socket = io\(\);/);
  assert.match(read('public/js/battleship.js'), /const socket = io\(\);/);
  assert.match(read('public/js/game.js'), /io\(SERVER_URLS\[selectedRegion\] \|\| ''\)/);
  assert.match(read('public/js/agar.js'), /io\(_SERVER_URLS\[_rgn\] \|\| ''\)/);
  for (const f of ['public/js/game.js', 'public/js/agar.js']) {
    assert.ok(read(f).includes("eu: '" + SERVER_URLS.eu + "'"), f + ' uses the same EU server');
  }
});

// The widget itself (JSX, not loadable in node): every stake goes through stakeRoute, and the
// shipped bundle is the build of this source.
test('the widget stakes through stakeRoute on every path, and the bundle carries it', () => {
  const src = read('wallet-widget/src/main.jsx');
  assert.ok(src.includes("from './stakeRoute.mjs'"));
  const stakeOnly = src.slice(src.indexOf('async function stakeOnly('), src.indexOf('async function buyCosmetic('));
  assert.ok(stakeOnly.length > 200);
  assert.ok(!/regionBase\(\)/.test(stakeOnly), 'stakeOnly no longer picks its own server');
  assert.match(stakeOnly, /async function stakeOnly\(sel, wallet, signTransaction, onStatus, base, hooks\)/);
  const play = src.slice(src.indexOf('async function stakeAndPlay('), src.indexOf('function launchStaked('));
  assert.match(play, /stakeRoute\(game, lobbyRegion\(\)\)/);
  assert.ok(play.includes('await stakeOnly(stakeSpec(sel), wallet, signTransaction, onStatus, route.base);'));
  const bridge = src.slice(src.indexOf('restakeRef.current = createRestakeBridge('));
  assert.match(bridge, /stakeRoute\(req\.game, pageRegion\(\)\)/);
  assert.match(bridge, /stakeOnly\(req\.sel, w, signRef\.current, \(\) => \{\}, route\.base, hooks\)/);
  const bundle = read('public/wallet/widget.js');
  assert.ok(bundle.includes('paper:!0,knockout:!0,battleship:!0'), 'the built widget has the origin games');
});
