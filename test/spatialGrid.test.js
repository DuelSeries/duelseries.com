'use strict';
const test = require('node:test');
const assert = require('node:assert');
const SpatialGrid = require('../server/SpatialGrid');

test('finds items in the 3x3 neighbourhood and ignores distant ones', () => {
  const g = new SpatialGrid(80);
  g.insert(0, 0, 'origin');
  g.insert(50, 50, 'near');        // same cell as origin
  g.insert(100, 100, 'adjacent');  // diagonally adjacent cell (still within 3x3)
  g.insert(5000, 5000, 'far');     // way outside the neighbourhood
  const found = [];
  g.forEachNear(0, 0, (it) => { found.push(it); return false; });
  assert.ok(found.includes('origin'));
  assert.ok(found.includes('near'));
  assert.ok(found.includes('adjacent'));
  assert.ok(!found.includes('far'));
});

test('clear() empties the grid', () => {
  const g = new SpatialGrid(80);
  g.insert(0, 0, 'x');
  g.clear();
  let n = 0;
  g.forEachNear(0, 0, () => { n++; return false; });
  assert.strictEqual(n, 0);
});

test('a callback returning true stops the scan early', () => {
  const g = new SpatialGrid(80);
  g.insert(0, 0, 'a');
  g.insert(1, 1, 'b');
  g.insert(2, 2, 'c');
  let count = 0;
  g.forEachNear(0, 0, () => { count++; return true; });
  assert.strictEqual(count, 1);
});

test('handles negative coordinates without key collisions', () => {
  const g = new SpatialGrid(80);
  g.insert(-1000, -1000, 'neg');
  g.insert(1000, 1000, 'pos');
  const near = [];
  g.forEachNear(-1000, -1000, (it) => { near.push(it); return false; });
  assert.deepStrictEqual(near, ['neg']);
});
