'use strict';
/* The food a snake appears with (night review 2026-10-29, finding 31's second half). GAME_JOINED on Play, Play again
   and a reconnect carried the whole world's food, about 600 KB, on every press, though the page draws it only until
   the first snapshot replaces it a thirtieth of a second later. GameRoom.foodAround sends the pellets within the reach
   of the first snapshot instead: every pellet that snapshot can show (its 2000 interest cell, the socket's view radius
   or 3000, a 400 margin), so the first frame is the same, and nothing past it. */
const test = require('node:test');
const assert = require('node:assert');
const C = require('../shared/constants');
const GameRoom = require('../server/GameRoom');

const io = { to: () => ({ emit: () => {} }), emit: () => {} };
function sock(id, extra = {}) {
  const s = Object.assign({ id, sent: [], join() {}, leave() {}, rooms: new Set(), volatile: { emit() {} } }, extra);
  s.emit = (e, p) => s.sent.push({ e, p });
  return s;
}
// A pellet every 250 units across 40000 x 40000: far more world than any one screen.
const PELLETS = [];
for (let x = -20000; x <= 20000; x += 250) for (let y = -20000; y <= 20000; y += 250) PELLETS.push({ id: PELLETS.length, x, y });
function room(spawn) {
  const r = new GameRoom(io, 'free');
  r.broadcastSnapshot = () => {};
  r.topUpBots = () => {};
  r.foodManager.getAll = () => PELLETS;
  r.safeSpawnPoint = () => spawn;
  return r;
}
const joined = (s) => s.sent.filter((m) => m.e === C.EVENTS.GAME_JOINED).pop().p;
/* What broadcastSnapshot's first payload can carry for a socket whose eye is at (x, y): its 2000 cell, padded by the
   view radius and the 400 margin. */
function firstSnapshotHas(f, x, y, view) {
  const ci = Math.floor(x / 2000), cj = Math.floor(y / 2000);
  const pad = view + 400, cx = ci * 2000 + 1000, cy = cj * 2000 + 1000;
  return Math.abs(f.x - cx) <= 1000 + pad && Math.abs(f.y - cy) <= 1000 + pad;
}

test('Play: the food around the spawn, everything the first snapshot shows, and not the world', () => {
  const at = { x: 1990, y: -10 };   // next to a cell edge, the worst case for the cell's reach
  const r = room(at);
  const s = sock('p1');
  r.addPlayer(s, 'P', null, null, 0);
  const food = joined(s).food;
  const ids = new Set(food.map((f) => f.id));
  for (const f of PELLETS) if (firstSnapshotHas(f, at.x, at.y, 3000)) assert.ok(ids.has(f.id), 'pellet ' + f.id + ' the first snapshot shows');
  const reach = 2000 + 3000 + 400;
  for (const f of food) assert.ok(Math.abs(f.x - at.x) <= reach && Math.abs(f.y - at.y) <= reach, 'nothing past the reach');
  assert.ok(food.length < PELLETS.length / 5, food.length + ' of ' + PELLETS.length + ' pellets');
});

test('Play again: the reported view radius widens it, and it is sent again around the new spawn', () => {
  const r = room({ x: 0, y: 0 });
  const s = sock('p2');
  r.addPlayer(s, 'P', null, null, 0);
  r.snakes.get('p2').alive = false;
  s._viewR = 8000;
  r.safeSpawnPoint = () => ({ x: -12000, y: 7000 });
  r.respawnPlayer('p2', 0);
  const food = joined(s).food;
  const ids = new Set(food.map((f) => f.id));
  for (const f of PELLETS) if (firstSnapshotHas(f, -12000, 7000, 8000)) assert.ok(ids.has(f.id));
  const reach = 2000 + 8000 + 400;
  for (const f of food) assert.ok(Math.abs(f.x + 12000) <= reach && Math.abs(f.y - 7000) <= reach);
  assert.ok(food.length < PELLETS.length, 'still not the world');
});

test('a reconnect gets the food around its snake as it is now', () => {
  const r = room({ x: 5000, y: 5000 });
  const old = sock('old');
  r.addPlayer(old, 'P', null, null, 0);
  r.markOrphan('old', 'key-f', 60_000, () => {});
  const fresh = sock('new');
  const snake = r.reattach('key-f', fresh);
  assert.ok(snake);
  const h = snake.head;
  const food = joined(fresh).food;
  const ids = new Set(food.map((f) => f.id));
  for (const f of PELLETS) if (firstSnapshotHas(f, h.x, h.y, 3000)) assert.ok(ids.has(f.id));
  assert.ok(food.length < PELLETS.length / 5);
  clearTimeout(r.orphans.get('key-f') && r.orphans.get('key-f').timer);
});

test('no spawn point to measure from: the old payload, never an empty world', () => {
  const r = room({ x: 0, y: 0 });
  assert.strictEqual(r.foodAround(sock('x'), NaN, 0), PELLETS);
});
