'use strict';
/* The grid is rebuilt every tick, and clear() now reuses each cell's array
   instead of dropping the whole Map — thousands of fresh arrays per room per
   tick was the allocation keeping the collector busy 8.6% of wall clock.

   Reuse is only safe if a cleared grid is indistinguishable from a new one.
   A stale segment left in a cell would be an invisible body part: the next
   snake whose head passed through that spot would die to nothing. These lock
   that down, including across the periodic prune. */
const test = require('node:test');
const assert = require('node:assert');
const SpatialGrid = require('../server/SpatialGrid');

const near = (g, x, y) => { const found = []; g.forEachNear(x, y, (it) => { found.push(it); return false; }); return found; };

test('a cleared grid holds nothing — a stale item would be an invisible wall', () => {
  const g = new SpatialGrid(80);
  g.insert(100, 100, 'ghost');
  assert.deepEqual(near(g, 100, 100), ['ghost']);
  g.clear();
  assert.deepEqual(near(g, 100, 100), [], 'item survived clear()');
});

test('rebuilding after clear gives exactly the new tick\'s contents', () => {
  const g = new SpatialGrid(80);
  g.insert(100, 100, 'old');
  g.clear();
  g.insert(100, 100, 'new');
  assert.deepEqual(near(g, 100, 100), ['new']);
});

test('a cell reused many times never accumulates', () => {
  const g = new SpatialGrid(80);
  for (let i = 0; i < 50; i++) { g.clear(); g.insert(100, 100, 'tick' + i); }
  assert.deepEqual(near(g, 100, 100), ['tick49']);
});

test('correct across the periodic prune, where the map is also rewritten', () => {
  const g = new SpatialGrid(80);
  // Past the 600-tick prune threshold, so the pruning branch is exercised.
  for (let i = 0; i < 1300; i++) {
    g.clear();
    g.insert(100, 100, 'a' + i);
    g.insert(5000, 5000, 'far' + i);
  }
  assert.deepEqual(near(g, 100, 100), ['a1299']);
  assert.deepEqual(near(g, 5000, 5000), ['far1299']);
});

test('cells that stop being used are eventually dropped, so the map cannot grow forever', () => {
  const g = new SpatialGrid(80);
  // Occupy a wide spread of cells once, then only ever use one of them again.
  g.clear();
  for (let i = 0; i < 400; i++) g.insert(i * 200, 0, 'x');
  const peak = g.map.size;
  for (let i = 0; i < 1300; i++) { g.clear(); g.insert(100, 100, 'only'); }
  assert.ok(g.map.size < peak, `map did not shrink (peak ${peak}, now ${g.map.size})`);
  assert.deepEqual(near(g, 100, 100), ['only'], 'pruning must not disturb live cells');
});

test('the same array object is reused, which is the whole point', () => {
  const g = new SpatialGrid(80);
  g.insert(100, 100, 'a');
  const arr = g.map.get(g._cellKey(1, 1));
  g.clear();
  g.insert(100, 100, 'b');
  assert.strictEqual(g.map.get(g._cellKey(1, 1)), arr, 'a fresh array was allocated — the allocation is back');
});

test('multi-item cells and the 3x3 neighbourhood still behave', () => {
  const g = new SpatialGrid(80);
  g.clear();
  g.insert(100, 100, 'a');
  g.insert(110, 105, 'b');
  g.insert(20, 20, 'neighbour');     // adjacent cell, inside the 3x3 block
  g.insert(900, 900, 'distant');     // far outside it
  const found = near(g, 100, 100);
  assert.ok(found.includes('a') && found.includes('b') && found.includes('neighbour'));
  assert.ok(!found.includes('distant'));
});
