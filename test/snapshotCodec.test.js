'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { encodeSnapshot, decodeSnapshot } = require('../shared/snapshotCodec');

function sample() {
  return {
    t: 123456,
    worldRadius: 2000,
    snakes: [
      { id: 'a', name: 'Alice', color: '#fff', segs: [10, 20, 13, 24, 16, 28], angle: 1.23, boosting: true,  boostRamp: 0.5, hatId: 'crown', boostId: 'fire',    score: 42, length: 3, boostRatio: 0.7, worth: 0.01 },
      { id: 'b', name: 'Bob',   color: '#000', segs: [-5, -7, -8, -9],          angle: -2.1, boosting: false, boostRamp: 0,   hatId: 'none',  boostId: 'default', score: 7,  length: 2, boostRatio: 0,   worth: 0 },
    ],
    food: [
      { id: 1, x: 100,  y: -200, color: '#f00', size: 1, dropped: false, isGolden: false },
      { id: 2, x: -300, y: 400,  color: '#0f0', size: 2, dropped: true,  isGolden: true  },
    ],
    leaderboard: [{ rank: 1, name: 'Alice', score: 42 }],
    mm: [{ x: 10, y: 20, c: '#fff', id: 'a' }],
  };
}

test('round-trips snake coordinates exactly for integer world units', () => {
  const enc = encodeSnapshot(sample());
  const out = decodeSnapshot(enc.meta, enc.coords);
  assert.deepStrictEqual(out.snakes[0].segs, [10, 20, 13, 24, 16, 28]);
  assert.deepStrictEqual(out.snakes[1].segs, [-5, -7, -8, -9]);
});

test('round-trips food coordinates and preserves food metadata', () => {
  const enc = encodeSnapshot(sample());
  const out = decodeSnapshot(enc.meta, enc.coords);
  assert.strictEqual(out.food[0].x, 100);
  assert.strictEqual(out.food[0].y, -200);
  assert.strictEqual(out.food[1].x, -300);
  assert.strictEqual(out.food[1].y, 400);
  assert.strictEqual(out.food[1].isGolden, true);
  assert.strictEqual(out.food[1].dropped, true);
  assert.strictEqual(out.food[0].color, '#f00');
});

test('preserves snake metadata (the non-coordinate fields)', () => {
  const enc = encodeSnapshot(sample());
  const out = decodeSnapshot(enc.meta, enc.coords);
  const a = out.snakes[0];
  assert.strictEqual(a.id, 'a');
  assert.strictEqual(a.name, 'Alice');
  assert.strictEqual(a.color, '#fff');
  assert.strictEqual(a.score, 42);
  assert.strictEqual(a.worth, 0.01);
  assert.strictEqual(a.boosting, true);
  assert.strictEqual(a.hatId, 'crown');
  assert.strictEqual(a.angle, 1.23);
});

test('preserves top-level fields (t, worldRadius, leaderboard, minimap)', () => {
  const enc = encodeSnapshot(sample());
  const out = decodeSnapshot(enc.meta, enc.coords);
  assert.strictEqual(out.t, 123456);
  assert.strictEqual(out.worldRadius, 2000);
  assert.deepStrictEqual(out.leaderboard, [{ rank: 1, name: 'Alice', score: 42 }]);
  assert.deepStrictEqual(out.mm, [{ x: 10, y: 20, c: '#fff', id: 'a' }]);
});

test('clamps coordinates beyond the Int16 range instead of wrapping', () => {
  const snap = sample();
  snap.snakes[0].segs = [40000, -40000];
  const enc = encodeSnapshot(snap);
  const out = decodeSnapshot(enc.meta, enc.coords);
  assert.deepStrictEqual(out.snakes[0].segs, [32767, -32768]);
});

test('handles an empty snapshot (no snakes, no food)', () => {
  const enc = encodeSnapshot({ t: 1, worldRadius: 100, snakes: [], food: [], leaderboard: [], mm: [] });
  const out = decodeSnapshot(enc.meta, enc.coords);
  assert.deepStrictEqual(out.snakes, []);
  assert.deepStrictEqual(out.food, []);
});
