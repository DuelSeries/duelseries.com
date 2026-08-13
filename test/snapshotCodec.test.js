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

function roundTrip(snap) {
  const enc = encodeSnapshot(snap);
  return decodeSnapshot(enc.meta, enc.coords);
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
  assert.strictEqual(out.food[0].dropped, false);
  assert.strictEqual(out.food[0].isGolden, false);
  assert.strictEqual(out.food[0].color, '#f00');
  assert.strictEqual(out.food[1].color, '#0f0');
});

test('round-trips food ids (packed as Uint32, so they must be integers)', () => {
  const snap = sample();
  snap.food[0].id = 1;
  snap.food[1].id = 4294967295;          // max Uint32
  const out = roundTrip(snap);
  assert.strictEqual(out.food[0].id, 1);
  assert.strictEqual(out.food[1].id, 4294967295);
});

test('food size survives quantization within half a step', () => {
  const snap = sample();
  // the real range: normal 0.5-0.9, golden 2.2-2.8, death drops up to ~4.0
  const sizes = [0.5, 0.73, 0.9, 2.2, 2.86, 4.0];
  snap.food = sizes.map((size, i) => ({ id: i + 1, x: 0, y: 0, color: '#f00', size, dropped: false, isGolden: false }));
  const out = roundTrip(snap);
  const halfStep = 1 / 50 / 2 + 1e-9;    // SIZE_Q is 50, so a step is 0.02
  for (let i = 0; i < sizes.length; i++) {
    assert.ok(Math.abs(out.food[i].size - sizes[i]) <= halfStep,
      `size ${sizes[i]} came back as ${out.food[i].size}`);
  }
});

test('colour palette dedupes and handles more colours than a byte could index', () => {
  const snap = sample();
  const many = [];
  for (let i = 0; i < 600; i++) {
    many.push({ id: i + 1, x: i, y: -i, color: '#' + i.toString(16).padStart(6, '0'),
                size: 1, dropped: false, isGolden: false });
  }
  // plus 400 pellets that all reuse one colour, to prove the palette dedupes
  for (let i = 0; i < 400; i++) {
    many.push({ id: 1000 + i, x: 0, y: 0, color: '#abcdef', size: 1, dropped: false, isGolden: false });
  }
  snap.food = many;
  const enc = encodeSnapshot(snap);
  assert.strictEqual(enc.meta.fc.length, 601, 'palette should hold one entry per distinct colour');
  const out = decodeSnapshot(enc.meta, enc.coords);
  assert.strictEqual(out.food[0].color, '#000000');
  assert.strictEqual(out.food[599].color, '#' + (599).toString(16).padStart(6, '0'));
  assert.strictEqual(out.food[999].color, '#abcdef');
});

test('food costs 12 bytes on the wire and carries no per-pellet JSON', () => {
  const snap = sample();
  snap.snakes = [];
  snap.food = [];
  for (let i = 0; i < 1000; i++) {
    snap.food.push({ id: i + 1, x: i, y: -i, color: '#ff4040', size: 0.7, dropped: false, isGolden: false });
  }
  const enc = encodeSnapshot(snap);
  assert.strictEqual(enc.coords.byteLength, 1000 * 12);
  assert.strictEqual(enc.meta.food, undefined, 'food must not ride along as a JSON array');
  // the whole metadata object for 1000 pellets should now be tiny
  assert.ok(JSON.stringify(enc.meta).length < 1000,
    'meta was ' + JSON.stringify(enc.meta).length + ' bytes; the packing did not take effect');
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
