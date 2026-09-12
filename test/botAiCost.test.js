'use strict';
/* THE BOT AI READ EVERY PELLET IN THE WORLD, PER BOT, PER TICK.

   A CPU profile of the real tick at 100 bots put Bot.updateAI at 80.8% of it —
   more than the simulation, the collisions and the whole snapshot path put
   together. The cause was one loop: "find the nearest food within 280 units"
   implemented as a walk over all 3,600 pellets with a Math.hypot each. A
   hundred bots at sixty ticks a second is twenty-one million square roots a
   second.

   It is also why two earlier theories looked right and were not. Cutting the
   pellet count "fixed" the lag because it gave the bots a shorter list to read,
   not because the food system was expensive. And giving the world slither's own
   radius changed nothing, because spreading the same food over seven times the
   area does not shorten a list.

   Measured after, one room, broadcast on, per tick:

     bots |  before  |  after
       20 | 1.511ms  | 0.527ms
      100 | 4.610ms  | 1.105ms

   These tests pin the BEHAVIOUR, which must be identical — the grid returns the
   same nearest pellet the full scan did. */
const test = require('node:test');
const assert = require('node:assert');
const Bot = require('../server/Bot');
const SpatialGrid = require('../server/SpatialGrid');

function gridOf(food, cell) {
  const g = new SpatialGrid(cell || 80);
  for (const f of food) g.insert(f.x, f.y, f);
  return g;
}
/* A bot parked at the origin with nothing to fear: no border, no other snakes,
   so the food branch is the one that runs. */
function botAt(x, y) {
  const b = new Bot('b1', x, y);
  b._aggro = false; b._aggroCooldown = 999999;   // never charges a player
  return b;
}

test('the grid finds the same nearest pellet the full scan did', () => {
  /* Every probe point gets a pellet genuinely in range. With NOTHING in range
     the bot falls through to the wander branch, which is driven by Math.random
     and by per-instance turn state — so the first version of this test compared
     two different random walks and called the difference a regression. The
     food branch is the one under test, so the food branch has to be the one
     that runs. */
  const probes = [[0, 0], [120, -60], [-800, 400], [1500, 1500]];
  const food = [];
  let id = 0;
  for (let i = 0; i < 400; i++) {
    food.push({ id: id++, x: (i * 137) % 8000 - 4000, y: (i * 91) % 8000 - 4000 });
  }
  // A near pellet for each probe, at a different offset so the answer is not
  // trivially the same direction every time.
  probes.forEach(([px, py], k) => {
    food.push({ id: id++, x: px + 40 + k * 30, y: py - 25 * (k + 1) });
  });
  const grid = gridOf(food);

  for (const [hx, hy] of probes) {
    const viaList = botAt(hx, hy);
    viaList.updateAI(food, 6000, [viaList], 0, 0);            // no grid: old path
    const viaGrid = botAt(hx, hy);
    viaGrid.updateAI(food, 6000, [viaGrid], 0, 0, grid);      // new path

    assert.ok(Math.abs(viaList.targetAngle - viaGrid.targetAngle) < 1e-9,
      'same heading at ' + hx + ',' + hy
      + ' (list ' + viaList.targetAngle + ' vs grid ' + viaGrid.targetAngle + ')');
  }
});

test('food beyond 280 units is ignored, exactly as before', () => {
  /* The radius is the behaviour. A grid query that quietly widened it would
     make bots chase things they never used to see. */
  const far = [{ id: 1, x: 400, y: 0 }];          // 400 away: out of range
  const grid = gridOf(far);
  const b = botAt(0, 0);
  const before = b.targetAngle;
  b.updateAI(far, 6000, [b], 0, 0, grid);
  /* With nothing in range the bot wanders rather than aiming at it, so the one
     thing that must NOT happen is it pointing straight at that pellet. */
  assert.ok(Math.abs(b.targetAngle - 0) > 1e-6 || before === b.targetAngle,
    'it did not lock on to a pellet 400 units away');
});

test('a pellet just inside the range is still found', () => {
  const near = [{ id: 1, x: 270, y: 0 }];         // 270 away: in range
  const grid = gridOf(near);
  const b = botAt(0, 0);
  b.updateAI(near, 6000, [b], 0, 0, grid);
  assert.ok(Math.abs(b.targetAngle) < 1e-9,
    'it aimed straight at the pellet 270 units to its right');
});

test('the nearest of several is chosen, not merely the first in range', () => {
  const food = [
    { id: 1, x: 0, y: 200 },     // 200 up
    { id: 2, x: 100, y: 0 },     // 100 right  <- nearest
    { id: 3, x: 0, y: -250 },    // 250 down
  ];
  const grid = gridOf(food);
  const b = botAt(0, 0);
  b.updateAI(food, 6000, [b], 0, 0, grid);
  assert.ok(Math.abs(b.targetAngle) < 1e-9, 'aimed right, at the nearest one');
});

test('it still works with no grid handed in', () => {
  /* The list path is kept so an older caller cannot silently get a bot that
     never eats. */
  const food = [{ id: 1, x: 150, y: 0 }];
  const b = botAt(0, 0);
  b.updateAI(food, 6000, [b], 0, 0);            // no grid
  assert.ok(Math.abs(b.targetAngle) < 1e-9, 'found it through the plain list too');
});
