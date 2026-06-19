'use strict';
const test = require('node:test');
const assert = require('node:assert');
const AgarRoom = require('../server/AgarRoom');

// Minimal Socket.IO stand-in — AgarRoom only needs to(room).emit() and sockets.sockets.get().
const mockIo = { to: () => ({ emit() {} }), sockets: { sockets: { get: () => null } } };
const cell = (x, y, mass) => ({ id: 0, x, y, mass, vx: 0, vy: 0, mergeTimer: 0 });

test('a much larger overlapping cell eats a smaller one (grid player-eating)', () => {
  const room = new AgarRoom(mockIo, 'agar_na_free');
  const big = room.addBot(), small = room.addBot();
  big.cells   = [cell(1000, 1000, 100)];
  small.cells = [cell(1005, 1005, 20)];
  big.alive = small.alive = true;
  const before = big.cells[0].mass;
  room._checkPlayerEating();
  assert.ok(big.cells[0].mass > before, 'eater grew');
  assert.strictEqual(small.alive, false, 'eaten entity died');
  assert.strictEqual(small.cells.length, 0);
});

test('similar-size cells do NOT eat each other (needs 1.25x mass)', () => {
  const room = new AgarRoom(mockIo, 'agar_na_free');
  const a = room.addBot(), b = room.addBot();
  a.cells = [cell(0, 0, 50)];
  b.cells = [cell(5, 5, 50)];
  a.alive = b.alive = true;
  room._checkPlayerEating();
  assert.ok(a.alive && b.alive, 'both survive');
});

test('worth transfers from the eaten cell to the eater (money invariant)', () => {
  const room = new AgarRoom(mockIo, 'agar_na_free');
  const big = room.addBot(), small = room.addBot();
  big.cells = [cell(0, 0, 100)];  big.worth = 0;
  small.cells = [cell(3, 3, 20)]; small.worth = 0.05;
  big.alive = small.alive = true;
  room._checkPlayerEating();
  assert.ok(Math.abs(big.worth - 0.05) < 1e-9, 'eater gained the worth');
  assert.ok(Math.abs(small.worth) < 1e-9, 'target lost its worth');
});

test('a cell eats nearby food and the food is removed (grid food-eating)', () => {
  const room = new AgarRoom(mockIo, 'agar_na_free');
  const bot = room.addBot();
  bot.cells = [cell(500, 500, 100)]; // radius 100
  bot.alive = true;
  room.foods.clear();
  room.foods.set(99999, { id: 99999, x: 520, y: 500, color: '#fff', r: 10 });
  const before = bot.cells[0].mass;
  room._checkFoodEating();
  assert.ok(bot.cells[0].mass > before, 'cell grew from food');
  assert.ok(!room.foods.has(99999), 'food consumed');
});

test('AOI broadcast culls a distant player from a near player\'s payload', () => {
  // Rich io stub that captures per-room emits and exposes the room membership the broadcaster reads.
  const emitted = [];
  const sockets = new Map();
  const rooms = new Map();
  const io = {
    to: (room) => ({ volatile: { emit: (ev, payload) => emitted.push({ room, ev, payload }) } }),
    sockets: { adapter: { rooms }, sockets },
  };
  const mkSock = (id) => ({ id, _agarViewR: 1000, _agarCellRoom: null, join() {}, leave() {}, volatile: { emit() {} } });

  const room = new AgarRoom(io, 'agar_na_free');
  // Two players far apart (well beyond view 1000 + margin).
  room.players.set('A', { id: 'A', name: 'A', color: '#fff', alive: true, score: 0, worth: 0, cells: [cell(100, 100, 30)] });
  room.players.set('B', { id: 'B', name: 'B', color: '#000', alive: true, score: 0, worth: 0, cells: [cell(10000, 10000, 30)] });
  sockets.set('A', mkSock('A'));
  sockets.set('B', mkSock('B'));
  rooms.set('agar_na_free', new Set(['A', 'B']));

  room._broadcast();

  const idsByRoom = {};
  for (const e of emitted) idsByRoom[e.room] = e.payload.players.map(p => p.id).sort();
  const aRoom = 'aoi_agar_na_free_0,0';        // A is at (100,100) -> cell 0,0
  const bRoom = 'aoi_agar_na_free_6,6';        // B is at (10000,10000) -> cell 6,6
  assert.deepStrictEqual(idsByRoom[aRoom], ['A'], 'A only sees itself');
  assert.deepStrictEqual(idsByRoom[bRoom], ['B'], 'B only sees itself');
});

test('food far outside every cell radius is not eaten', () => {
  const room = new AgarRoom(mockIo, 'agar_na_free');
  const bot = room.addBot();
  bot.cells = [cell(0, 0, 100)]; // radius 100
  bot.alive = true;
  room.foods.clear();
  room.foods.set(42, { id: 42, x: 5000, y: 5000, color: '#fff', r: 10 });
  room._checkFoodEating();
  assert.ok(room.foods.has(42), 'distant food survives');
});
