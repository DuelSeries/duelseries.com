'use strict';
// The per-game count on each lobby card: every human in every room of a game,
// plus the bots in that game's board rows, so the card agrees with the rows.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { liveCounts, withBoardBots } = require('../server/liveCounts');
const GameRoom = require('../server/GameRoom');

const players = (...ids) => new Map(ids.map(id => [id, {}]));

test('every snake room is summed: tiers, the event and every rung', () => {
  const rooms = [{ players: players('a', 'b') }, { players: players() }, { players: players('c') }, null];
  const c = liveCounts({ snakeRooms: rooms });
  assert.strictEqual(c.snake, 3);
});

test('bots are never counted, wherever a room keeps them', () => {
  const c = liveCounts({
    // GameRoom: bots live in snakes, never in players.
    snakeRooms: [{ players: players('h1'), snakes: new Map([['b1', { isBot: true }], ['b2', { isBot: true }]]), botCount: 2 }],
    // agar.io (server/ag AgArenas): the registry counts the humans who pressed Play.
    agar: { humanTotal: () => 3, botCount: 20 },
    shooter: { humans: () => 2, bots: () => 5, playerCount: 2, botCount: 5 },
    // Bowmasters puts a bot stand-in straight into a room's players map.
    tanks: { queue: [{ socket: { id: 'q1' } }], rooms: new Map([['r', { players: players('p1', 'bot_r') }]]) },
    knockout: { queue: [], rooms: new Map([['r', { players: players('bot_r', 'k1') }], ['s', { players: players('k2', 'k3') }]]) },
    battleship: { queue: [{ socket: { id: 'w1' } }, { socket: { id: 'w2' } }], rooms: new Map() },
    paper: { humanTotal: () => 6 },
  });
  assert.deepStrictEqual(c, { snake: 1, agar: 3, omgshooter: 2, tanks: 2, knockout: 3, battleship: 2, paper: 6 });
});

test('a real GameRoom with bots reports zero humans', () => {
  const io = { to: () => ({ emit() {} }), in: () => ({ emit() {} }), emit() {} };
  const r = new GameRoom(io, 'na_free');
  r.snakes.set('bot_1', { isBot: true, alive: true });
  assert.strictEqual(r.botCount, 1);
  assert.strictEqual(liveCounts({ snakeRooms: [r] }).snake, 0);
});

test('missing or broken rooms report 0 rather than throwing', () => {
  assert.deepStrictEqual(liveCounts(), { snake: 0, agar: 0, omgshooter: 0, tanks: 0, knockout: 0, battleship: 0, paper: 0 });
  const c = liveCounts({ shooter: { humans() { throw new Error('x'); } }, paper: { humanTotal() { throw new Error('y'); } },
    agar: { humanTotal() { throw new Error('z'); } } });
  assert.strictEqual(c.omgshooter, 0);
  assert.strictEqual(c.paper, 0);
  assert.strictEqual(c.agar, 0);
  assert.strictEqual(liveCounts({ agar: null }).agar, 0, 'agar.io closed (AG off): 0, not a throw');
});

test('agar.io counts real rooms of the new game: Play pressed counts, a watcher on the menu and a bot do not', () => {
  const { AgArenas } = require('../server/ag/agArenas');
  const { FIXTURE } = require('./agLawsFixture');
  const arenas = new AgArenas({ region: 'na', laws: FIXTURE, shippableOnly: false, autoTick: false, seed: 7,
    log: { log() {}, warn() {}, error() {} } });
  try {
    const sock = (id) => ({ id, emit() {}, disconnect() {}, join() {}, leave() {} });
    const a = sock('a'), b = sock('b');
    assert.ok(arenas.connect(a) && arenas.connect(b), 'two sockets seated as watchers');
    assert.strictEqual(liveCounts({ agar: arenas }).agar, 0, 'watchers on the menu are not playing');
    assert.strictEqual(arenas.join(a, 'one'), 'ok');
    assert.strictEqual(liveCounts({ agar: arenas }).agar, 1, 'the one who pressed Play is');
    const rows = arenas.boardRows();
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].game, 'agar', 'the rows are the lobby card\'s game key');
    // The card is the humans plus the bots of its row, the same rule as every other card.
    assert.strictEqual(withBoardBots(liveCounts({ agar: arenas }), rows).agar, 1 + rows[0].bots);
    arenas.disconnect('a');
    assert.strictEqual(liveCounts({ agar: arenas }).agar, 0, 'and goes when they leave');
  } finally {
    arenas.stop();
  }
});

test('/api/live carries the counts, from the rooms it already has, with no timer of its own', () => {
  const src = fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8');
  assert.ok(/counts: withBoardBots\(liveGameCounts\(\), lobbies\.concat\(extras\)\)/.test(src),
    '/api/live sends counts built from the same rows it sends');
  const fn = src.slice(src.indexOf('function liveGameCounts'), src.indexOf("app.get('/api/live'"));
  assert.ok(fn.includes("e.game === 'snake'") && fn.includes('gameRooms[REGION]'), 'snake counts tiers, the event and the rungs');
  assert.ok(fn.includes('agar: agArenas') && fn.includes('paper: paperArenas'), 'agar.io every room of the new game, paper every rung');
  assert.ok(!fn.includes('agarRooms'), 'the old agar rooms are gone');
  /* The agar.io rows the card's bots come from are the registry's own board rows, one per rung, in
     `lobbies` like Paper's (PAID-AGAR-DESIGN.md 5.7): the free rung ag:na:s0 is the row the lobby
     pins. They are NOT also in liveExtras, where withBoardBots would add the same bots twice. */
  assert.ok(/const agRows = agArenas \? agArenas\.boardRows\(\) : \[\];/.test(src)
    && /const lobbies = liveBoard\(\)\.concat\(paperArenas\.boardRows\(\), agRows\);/.test(src),
  'every agar.io rung row is in lobbies');
  const ex = src.slice(src.indexOf('function liveExtras'), src.indexOf('function liveBattleRoyale'));
  assert.ok(!/agArenas|game: 'agar'|agar:free/.test(ex), 'and none is in the extras');
  assert.ok(!/setInterval|setTimeout/.test(fn), 'no polling loop of its own');
  const lib = fs.readFileSync(path.join(__dirname, '../server/liveCounts.js'), 'utf8');
  assert.ok(!/require\(/.test(lib), 'liveCounts depends on nothing, so it can expose nothing but counts');
});

test('the card adds the bots of its own rows, so it agrees with them', () => {
  const humans = { snake: 0, agar: 0, paper: 0, omgshooter: 0, tanks: 1 };
  const rows = [
    { game: 'snake', players: 0, bots: 39 },            // the free rung
    { game: 'snake', players: 0, bots: 0 },             // an empty paid rung
    { game: 'paper', players: 0, bots: 15 },
    { game: 'agar', players: 0, bots: 20 },
    { game: 'omgshooter', players: 0, bots: 5 },        // the idle arena's floor
    { game: 'tanks', players: 1, bots: 1 },             // Bowmasters' stand-in
    { game: 'swim', players: 0, bots: 9 },              // not counted: left alone
    { game: 'agar', bots: '<x>' }, { game: 'agar', bots: -3 }, null,
  ];
  const c = withBoardBots(humans, rows);
  assert.deepStrictEqual(c, { snake: 39, agar: 20, paper: 15, omgshooter: 5, tanks: 2 });
  // Every card is at least every row of its game.
  for (const r of rows) if (r && c[r.game] !== undefined && Number.isFinite(r.bots) && r.bots > 0)
    assert.ok(c[r.game] >= (r.players || 0) + r.bots, r.game);
  assert.strictEqual(humans.snake, 0, 'the human counts are not mutated');
  assert.strictEqual(withBoardBots(null, rows), null, 'no counts stays no counts');
});

test('a human in a room that is not on the board still counts', () => {
  // A snake fixed tier has no row; its player is still playing slither.io.
  const c = withBoardBots(liveCounts({ snakeRooms: [{ players: players('h1'), botCount: 20 }, { players: players('h2') }] }),
    [{ game: 'snake', players: 1, bots: 20 }]);
  assert.strictEqual(c.snake, 22);
});

test('Bowmasters puts its bot stand-in under bots, so row total and card agree', () => {
  const src = fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8');
  const fn = src.slice(src.indexOf("if (typeof tanksLobby !== 'undefined' && tanksLobby) {"), src.indexOf("if (typeof knockoutLobby !== 'undefined'"));
  assert.ok(/startsWith\('bot_'\)\) bots\+\+; else humans\+\+/.test(fn), 'bot_ ids go to bots');
  assert.ok(/players: humans, bots \}/.test(fn), 'the row carries both');
});
