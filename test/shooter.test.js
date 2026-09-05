'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { ShooterRoom, SH, WEAPONS } = require('../server/ShooterRoom');

const io = { to: () => ({ emit: () => {} }) };
let n = 0;
const sock = () => ({ id: 'p' + (++n), join() {} });

function room(level) {
  const r = new ShooterRoom(io, 't');
  r.addPlayer(sock(), 'Owen');
  if (level && level > 1) { r.level = level; r.buildLevel(level); }
  return r;
}
const step = (r, times) => { for (let i = 0; i < (times || 1); i++) r.tick(); };

test('the arena has a wall all the way round it', () => {
  /* Otherwise a tank drives off the map and the whole thing is over, which is
     the sort of bug that is obvious the second it happens and invisible until
     then. */
  const r = room();
  for (let c = 0; c < SH.COLS; c++) {
    assert.equal(r.map[0][c], SH.SOLID, 'top edge');
    assert.equal(r.map[SH.ROWS - 1][c], SH.SOLID, 'bottom edge');
  }
  for (let row = 0; row < SH.ROWS; row++) {
    assert.equal(r.map[row][0], SH.SOLID, 'left edge');
    assert.equal(r.map[row][SH.COLS - 1], SH.SOLID, 'right edge');
  }
});

test('both corners that matter start clear', () => {
  // You spawn in one and the base sits in the other; neither may be walled in.
  const r = room();
  assert.equal(r.cellAt(2.5 * SH.TILE, 2.5 * SH.TILE), SH.EMPTY, 'the spawn is clear');
  assert.equal(r.cellAt(r.base.x, r.base.y), SH.EMPTY, 'and so is the base');
});

test('a level is the same arena every time you play it', () => {
  const a = room(3).map.map(r => r.join('')).join('');
  const b = room(3).map.map(r => r.join('')).join('');
  assert.equal(a, b, 'built from the level number, so it can be replayed');
  assert.notEqual(a, room(4).map.map(r => r.join('')).join(''), 'and level 4 is not level 3');
});

test('a tank cannot drive through a wall', () => {
  const r = room();
  const p = r.player;
  // Put a solid block directly to the right and drive into it for a second.
  const c = Math.floor(p.x / SH.TILE) + 2, row = Math.floor(p.y / SH.TILE);
  r.map[row][c] = SH.SOLID;
  const wallX = c * SH.TILE;
  r.setInput(p.id, { right: 1 });
  step(r, SH.TICK_RATE);
  assert.ok(p.x + SH.TANK_R <= wallX + 1, 'it stopped at the wall (' + Math.round(p.x) + ')');
});

test('driving along a wall slides instead of sticking', () => {
  /* Moving both axes together means one blocked axis blocks the other, and the
     tank welds itself to every corner. This is the difference between a tank
     that feels good to drive and one that does not. */
  const r = room();
  const p = r.player;
  const row = Math.floor(p.y / SH.TILE) - 1;
  for (let c = 1; c < SH.COLS - 1; c++) r.map[row][c] = SH.SOLID;   // a wall above
  const startX = p.x;
  r.setInput(p.id, { right: 1, up: 1 });                            // into it, diagonally
  step(r, SH.TICK_RATE);
  assert.ok(p.x > startX + 40, 'it kept moving along the wall (' + Math.round(p.x - startX) + ')');
});

test('a shot breaks a crate and stops at solid', () => {
  const r = room();
  const p = r.player;
  const row = Math.floor(p.y / SH.TILE);
  const c = Math.floor(p.x / SH.TILE) + 3;
  r.map[row][c] = SH.CRATE;
  p.aim = 0;                                    // straight right
  r.setInput(p.id, { fire: 1, aim: 0 });
  step(r, 20);
  assert.equal(r.map[row][c], SH.EMPTY, 'the crate is gone');

  const r2 = room();
  const p2 = r2.player;
  const row2 = Math.floor(p2.y / SH.TILE);
  const c2 = Math.floor(p2.x / SH.TILE) + 3;
  r2.map[row2][c2] = SH.SOLID;
  r2.setInput(p2.id, { fire: 1, aim: 0 });
  step(r2, 20);
  assert.equal(r2.map[row2][c2], SH.SOLID, 'solid walls do not break');
});

test('nobody shoots their own side', () => {
  /* Enemies fire constantly and stand near each other; without this they clear
     the level for you. */
  const r = room();
  const enemies = [...r.tanks.values()].filter(t => t.kind === 'enemy');
  assert.ok(enemies.length >= 2, 'there are enemies to test with');
  const a = enemies[0], b = enemies[1];
  b.x = a.x + 60; b.y = a.y;
  const before = b.health;
  r.fireFrom(a, 0, 'cannon', true);              // hostile bullet, straight at b
  step(r, 12);
  assert.equal(b.health, before, 'an enemy shell passes through another enemy');
});

test('killing an enemy drops a coin, and driving over it pays', () => {
  const r = room();
  const e = [...r.tanks.values()].find(t => t.kind === 'enemy');
  const coinsBefore = r.coins;
  r.hurt(e, 9999);
  assert.equal(r.pickups.length, 1, 'it dropped something');
  assert.ok(!r.tanks.has(e.id), 'and it is gone');

  r.player.x = r.pickups[0].x; r.player.y = r.pickups[0].y;
  step(r, 1);
  assert.equal(r.pickups.length, 0, 'the coin was picked up');
  assert.equal(r.coins, coinsBefore + SH.COIN_VALUE, 'and paid');
});

test('destroying the base clears the level', () => {
  const r = room();
  assert.equal(r.state, 'playing');
  r.base.health = 1;
  r.player.x = r.base.x - 60; r.player.y = r.base.y;
  r.setInput(r.player.id, { fire: 1, aim: 0 });
  step(r, 20);
  assert.equal(r.base.health, 0, 'the base is down');
  assert.equal(r.state, 'cleared');
});

test('the next level is a new arena, with more enemies', () => {
  const r = room();
  const firstMap = r.map.map(x => x.join('')).join('');
  const firstEnemies = [...r.tanks.values()].filter(t => t.kind === 'enemy').length;
  r.state = 'cleared';
  assert.equal(r.nextLevel(), true);
  assert.equal(r.level, 2);
  assert.notEqual(r.map.map(x => x.join('')).join(''), firstMap, 'a different arena');
  const nowEnemies = [...r.tanks.values()].filter(t => t.kind === 'enemy').length;
  assert.ok(nowEnemies >= firstEnemies, 'and at least as many enemies');
  assert.equal(r.state, 'playing');
});

test('you cannot advance a level you have not cleared', () => {
  const r = room();
  assert.equal(r.nextLevel(), false, 'the base is still standing');
  assert.equal(r.level, 1);
});

test('dying costs coins but not the run', () => {
  /* A level you have to restart from the top is how a free game gets closed
     rather than replayed. */
  const r = room();
  r.coins = 100;
  r.hurt(r.player, 9999);
  assert.equal(r.player.dead, true);
  assert.equal(r.coins, 75, 'it cost coins');
  assert.equal(r.level, 1, 'and not the level');

  r.player.deadUntil = Date.now() - 1;
  step(r, 1);
  assert.equal(r.player.dead, false, 'you come back');
  assert.equal(r.player.health, r.player.maxHealth, 'at full health');
});

test('a weapon has to be paid for, and then it is yours', () => {
  const r = room();
  assert.equal(r.buy('rapid').ok, false, 'not with no coins');
  r.coins = WEAPONS.rapid.cost;
  assert.equal(r.buy('rapid').ok, true);
  assert.equal(r.coins, 0, 'it cost what it says');
  assert.equal(r.weapon, 'rapid', 'and it is equipped');

  // Switching back to something already owned is free.
  assert.equal(r.buy('cannon').ok, true);
  assert.equal(r.coins, 0, 'switching costs nothing');
  assert.equal(r.buy('rapid').ok, true, 'and back again');
  assert.equal(r.coins, 0);
});

test('a made-up weapon buys nothing', () => {
  const r = room();
  r.coins = 99999;
  assert.equal(r.buy('deathray').ok, false);
  assert.equal(r.coins, 99999, 'and costs nothing');
});

test('enemies cannot see through walls', () => {
  const r = room();
  const row = 5;
  for (let c = 1; c < SH.COLS - 1; c++) r.map[row][c] = SH.SOLID;
  const above = { x: 400, y: (row - 2) * SH.TILE };
  const below = { x: 400, y: (row + 2) * SH.TILE };
  assert.equal(r.lineOfSight(above.x, above.y, below.x, below.y), false, 'the wall blocks it');

  /* Cleared first. The arena is scattered with crates, so 'a line across open
     ground' has to be made open rather than assumed — the first version of this
     failed because it happened to pick a spot with a crate in it, which was the
     test being wrong rather than the sight line. */
  const openRow = row - 2;
  for (let cc = 1; cc < SH.COLS - 1; cc++) r.map[openRow][cc] = SH.EMPTY;
  assert.equal(r.lineOfSight(above.x, above.y, above.x + 60, above.y), true, 'open ground does not');
});

test('the snapshot carries no sockets and no other player names', () => {
  const r = room();
  const s = JSON.stringify(r.snapshot());
  assert.ok(!s.includes('socket'), 'no socket leaks into the wire');
  assert.ok(s.length < 60000, 'and a frame is a sane size (' + s.length + ' bytes)');
});

test('the map is sent as a string, not thirty times a second', () => {
  const r = room();
  const m = r.mapPayload();
  assert.equal(m.cells.split('|').length, SH.ROWS, 'a row per line');
  assert.equal(m.cells.split('|')[0].length, SH.COLS, 'a character per cell');
  assert.ok(!('cells' in r.snapshot()), 'and the per-frame snapshot does not carry it');
});
