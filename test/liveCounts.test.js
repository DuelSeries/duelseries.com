'use strict';
// The per-game count on each lobby card: humans only, every room of a game added up.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { liveCounts } = require('../server/liveCounts');
const GameRoom = require('../server/GameRoom');

const players = (...ids) => new Map(ids.map(id => [id, {}]));

test('every snake room is summed: tiers, the event and every rung', () => {
  const rooms = [{ players: players('a', 'b') }, { players: players() }, { players: players('c') }, null];
  const c = liveCounts({ snakeRooms: rooms });
  assert.strictEqual(c.snake, 3);
});

test('bots are never counted, wherever a room keeps them', () => {
  const c = liveCounts({
    // GameRoom/AgarRoom: bots live in snakes/bots, never in players.
    snakeRooms: [{ players: players('h1'), snakes: new Map([['b1', { isBot: true }], ['b2', { isBot: true }]]), botCount: 2 }],
    agarRooms: [{ players: players('h1', 'h2'), bots: new Map([['x', { alive: true }]]), botCount: 1 },
                { players: players('h3') }],
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
  const c = liveCounts({ shooter: { humans() { throw new Error('x'); } }, paper: { humanTotal() { throw new Error('y'); } } });
  assert.strictEqual(c.omgshooter, 0);
  assert.strictEqual(c.paper, 0);
});

test('/api/live carries the counts, from the rooms it already has, with no timer of its own', () => {
  const src = fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8');
  assert.ok(/counts: liveGameCounts\(\)/.test(src), '/api/live sends counts');
  const fn = src.slice(src.indexOf('function liveGameCounts'), src.indexOf("app.get('/api/live'"));
  assert.ok(fn.includes("e.game === 'snake'") && fn.includes('gameRooms[REGION]'), 'snake counts tiers, the event and the rungs');
  assert.ok(fn.includes('agarRooms[REGION]') && fn.includes('paper: paperArenas'), 'agar every tier, paper every rung');
  assert.ok(!/setInterval|setTimeout/.test(fn), 'no polling loop of its own');
  const lib = fs.readFileSync(path.join(__dirname, '../server/liveCounts.js'), 'utf8');
  assert.ok(!/require\(/.test(lib), 'liveCounts depends on nothing, so it can expose nothing but counts');
});
