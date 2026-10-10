'use strict';
// slRng (SERVER-DESIGN 3.1 and 5.3, task T3): mulberry32 reused from agar, one independent stream per sim job.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  createRng,
  STREAM_NAMES,
  streamSeed,
  streams,
  streamStates,
  setStreamStates,
  shuffleInPlace,
} = require('../server/sl/slRng');
const agRng = require('../server/ag/agRng');

test('createRng is the agar mulberry32 (seed 7 card numbers, server/ag/agRng.js:13)', () => {
  assert.strictEqual(createRng, agRng.createRng);
  const r = createRng(7);
  assert.strictEqual(r(), 0.011704753153026104);
  assert.strictEqual(r(), 0.06195825757458806);
  assert.strictEqual(r.next(), 0.97690763277933);
});

test('the seven named streams of SERVER-DESIGN 3.1', () => {
  assert.strictEqual(STREAM_NAMES.join(','), 'spawn,food,drop,charge,prey,order,bot');
  assert.ok(Object.isFrozen(STREAM_NAMES));
  const st = streams(1);
  assert.ok(Object.isFrozen(st));
  assert.strictEqual(Object.keys(st).join(','), STREAM_NAMES.join(','));
  for (const n of STREAM_NAMES) assert.strictEqual(typeof st[n], 'function');
});

test('stream seeds are pinned literals (a change re-cuts every sim golden)', () => {
  const want = {
    0: [2098537844, 2049291518, 2363053908, 3152835442, 1459518685, 1199979096, 1827523752],
    1: [1026571056, 378589390, 3075985160, 3290605097, 2183414434, 3732540236, 737749733],
    7: [2446547071, 1498021564, 676506013, 3312878375, 2412905932, 2522966191, 2279017575],
    12345: [1135050821, 1525188678, 4093929306, 491876204, 3300033669, 262818624, 3710202491],
  };
  for (const seed of Object.keys(want)) {
    for (let i = 0; i < STREAM_NAMES.length; i++) {
      assert.strictEqual(streamSeed(Number(seed), STREAM_NAMES[i]), want[seed][i], seed + ' ' + STREAM_NAMES[i]);
    }
  }
  // First two draws of each stream for room seed 1.
  const draws = {
    spawn: [0.47587548149749637, 0.4079794592689723],
    food: [0.11240508547052741, 0.5483722169883549],
    drop: [0.965819762321189, 0.7652825384866446],
    charge: [0.36068664235062897, 0.6884109945967793],
    prey: [0.7521055010147393, 0.16696763481013477],
    order: [0.16172229149378836, 0.0994975077919662],
    bot: [0.5764979426749051, 0.8642668288666755],
  };
  const st = streams(1);
  for (const n of STREAM_NAMES) {
    assert.strictEqual(st[n](), draws[n][0], n);
    assert.strictEqual(st[n](), draws[n][1], n);
  }
  // Seeds go through >>> 0, as agRng does: 1.9 -> 1, -1 -> 4294967295.
  assert.strictEqual(streamSeed(1.9, 'food'), 378589390);
  assert.strictEqual(streamSeed(-1, 'food'), 263771099);
  assert.strictEqual(streamSeed(4294967295, 'food'), 263771099);
});

test('a new draw on one stream never moves another (every ordered pair)', () => {
  for (const seed of [0, 1, 7, 12345, 4294967295]) {
    for (const busy of STREAM_NAMES) {
      const a = streams(seed);
      const b = streams(seed);
      for (let i = 0; i < 1000; i++) a[busy]();
      a[busy].int(17);
      a[busy].range(-3, 3);
      a[busy].chance(0.5);
      for (const other of STREAM_NAMES) {
        if (other === busy) continue;
        assert.strictEqual(a[other].state(), b[other].state(), seed + ' ' + busy + ' moved ' + other);
        for (let i = 0; i < 100; i++) {
          if (a[other]() !== b[other]()) assert.fail(seed + ': drawing ' + busy + ' changed ' + other + ' at ' + i);
        }
      }
    }
  }
});

test('streams differ from each other and from other room seeds; same seed repeats exactly', () => {
  for (const seed of [0, 1, 7, 12345]) {
    const seeds = new Set(STREAM_NAMES.map((n) => streamSeed(seed, n)));
    assert.strictEqual(seeds.size, STREAM_NAMES.length);
    const st = streams(seed);
    const firsts = new Set(STREAM_NAMES.map((n) => st[n]()));
    assert.strictEqual(firsts.size, STREAM_NAMES.length);
  }
  const a = streams(42);
  const b = streams(42);
  const c = streams(43);
  let differ = 0;
  for (let i = 0; i < 5000; i++) {
    for (const n of STREAM_NAMES) {
      const x = a[n]();
      if (x !== b[n]()) assert.fail('same seed diverged on ' + n + ' at ' + i);
      if (x !== c[n]()) differ++;
      if (!(x >= 0 && x < 1)) assert.fail('out of [0, 1): ' + x);
    }
  }
  assert.ok(differ > 0);
});

test('a stream seed depends on its name only, never on the list (adding a stream shifts nothing)', () => {
  const st = streams(9);
  for (const n of STREAM_NAMES) assert.strictEqual(st[n].state(), streamSeed(9, n));
  // A future stream name gets its own seed and leaves the seven untouched.
  const extra = streamSeed(9, 'future');
  for (const n of STREAM_NAMES) assert.notStrictEqual(extra, streamSeed(9, n));
});

test('state snapshot round trip resumes every stream exactly', () => {
  const a = streams(5);
  for (const n of STREAM_NAMES) for (let i = 0; i < 13; i++) a[n]();
  const snap = streamStates(a);
  assert.strictEqual(snap.length, STREAM_NAMES.length);
  const want = STREAM_NAMES.map((n) => [a[n](), a[n]()]);
  const b = streams(999);
  setStreamStates(b, snap);
  STREAM_NAMES.forEach((n, i) => {
    assert.strictEqual(b[n](), want[i][0]);
    assert.strictEqual(b[n](), want[i][1]);
  });
  assert.throws(() => setStreamStates(b, [1, 2]), TypeError);
  assert.throws(() => setStreamStates(b, null), TypeError);
});

test('seed and name are validated (no silent Math.random fallback)', () => {
  for (const bad of [undefined, null, '7', NaN, Infinity, {}]) {
    assert.throws(() => streams(bad), TypeError);
    assert.throws(() => streamSeed(bad, 'food'), TypeError);
  }
  assert.throws(() => streamSeed(1, ''), TypeError);
  assert.throws(() => streamSeed(1, 3), TypeError);
});

test('shuffleInPlace: a seeded permutation that takes n - 1 draws', () => {
  const arr = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const r = createRng(7);
  assert.strictEqual(shuffleInPlace(r, arr), arr);
  assert.strictEqual(arr.join(','), '6,5,8,1,2,3,4,7,9,0');
  const r2 = createRng(7);
  for (let i = 0; i < 9; i++) r2();
  assert.strictEqual(r.state(), r2.state());
  const r3 = createRng(3);
  shuffleInPlace(r3, []);
  shuffleInPlace(r3, ['x']);
  assert.strictEqual(r3.state(), 3);
  // Every position is reachable: 6000 shuffles of 3 items hit all 6 orders.
  const seen = new Set();
  const r4 = createRng(11);
  for (let i = 0; i < 6000; i++) seen.add(shuffleInPlace(r4, ['a', 'b', 'c']).join(''));
  assert.strictEqual(seen.size, 6);
});

test('slRng never uses Math.random or Date', () => {
  // Code only: the comments may name what is banned.
  const src = fs
    .readFileSync(path.join(__dirname, '../server/sl/slRng.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  assert.ok(!/Math\.random|Date\.|new Date/.test(src));
  const orig = Math.random;
  Math.random = () => {
    throw new Error('Math.random used');
  };
  try {
    const st = streams(3);
    for (const n of STREAM_NAMES) st[n]();
    shuffleInPlace(st.order, [1, 2, 3]);
  } finally {
    Math.random = orig;
  }
});
