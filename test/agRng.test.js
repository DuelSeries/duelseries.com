'use strict';
// Sim rng (CHOSEN mulberry32, build brief 9.2 agRng card).
const test = require('node:test');
const assert = require('node:assert');
const { createRng } = require('../server/ag/agRng');

test('seed 7 gives the card numbers', () => {
  const r = createRng(7);
  assert.strictEqual(r(), 0.011704753153026104);
  assert.strictEqual(r(), 0.06195825757458806);
  assert.strictEqual(r.next(), 0.97690763277933);
});

test('same seed, same stream; different seeds differ; values stay in [0, 1)', () => {
  const a = createRng(12345);
  const b = createRng(12345);
  const c = createRng(12346);
  let same = true;
  for (let i = 0; i < 10000; i++) {
    const x = a();
    assert.strictEqual(x, b());
    assert.ok(x >= 0 && x < 1);
    if (x !== c()) same = false;
  }
  assert.strictEqual(same, false);
});

test('state round trip resumes the exact stream', () => {
  const a = createRng(7);
  for (let i = 0; i < 37; i++) a();
  const s = a.state();
  const want = [a(), a(), a()];
  const b = createRng(1);
  b.setState(s);
  assert.deepStrictEqual([b(), b(), b()], want);
  assert.strictEqual(createRng(7).state(), 7);
  assert.strictEqual(createRng(-1).state(), 4294967295);
});

test('helpers consume exactly one draw each', () => {
  const a = createRng(99);
  const b = createRng(99);
  const n = a.int(10);
  assert.strictEqual(n, Math.floor(b() * 10));
  const x = a.range(-5, 5);
  assert.strictEqual(x, -5 + b() * 10);
  const p = a.chance(0.5);
  assert.strictEqual(p, b() < 0.5);
  assert.strictEqual(a.state(), b.state());
  assert.throws(() => a.int(0), RangeError);
  assert.throws(() => a.int(2.5), RangeError);
});

test('a seed must be a finite number (no silent Math.random fallback)', () => {
  for (const bad of [undefined, null, '7', NaN, Infinity, {}]) assert.throws(() => createRng(bad), TypeError);
  assert.throws(() => createRng(1).setState(NaN), TypeError);
});

test('never touches Math.random', () => {
  const orig = Math.random;
  Math.random = () => { throw new Error('Math.random used'); };
  try {
    const r = createRng(3);
    for (let i = 0; i < 1000; i++) r.range(0, 1);
  } finally {
    Math.random = orig;
  }
});
