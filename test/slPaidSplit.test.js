'use strict';
// Paid slither death split (PAID-SL-DESIGN.md 4, 11.1 slPaidSplit; task T1): the shares of a dead account over its
// cash pellets sum to the account exactly, the remainder goes one micro each to the first pellets, every share is at
// least 1, and a death with no food places nothing (unplaced M).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { splitShares, foodsOf, planSplit } = require('../server/slPaid/slSplit');

const K_MAX = 2 * 430 + 1; // L39.count: 2 drops per body point at the largest length (L3 mscps 430), plus 1 at the head
// The two stakes, primes on both sides of them and of the 32-bit edge, 2^31 itself, and the smallest M that gives
// every one of 861 pellets the same share.
const MS = [500000, 1000000, 499979, 500009, 999983, 1000003, 2147483647, 2 ** 31, 580 * K_MAX];

test('every M and every k from 1 to 861: the shares sum to M, the first rem pellets hold base + 1, all >= 1', () => {
  for (const M of MS) {
    for (let k = 1; k <= K_MAX; k++) {
      const sh = splitShares(M, k);
      assert.strictEqual(sh.length, k);
      const base = Math.floor(M / k);
      const rem = M - base * k;
      let sum = 0;
      for (let i = 0; i < k; i++) {
        if (sh[i] !== base + (i < rem ? 1 : 0)) assert.fail('M ' + M + ' k ' + k + ' share ' + i + ' is ' + sh[i]);
        if (!(Number.isSafeInteger(sh[i]) && sh[i] >= 1)) assert.fail('M ' + M + ' k ' + k + ' share ' + i);
        sum += sh[i];
      }
      if (sum !== M) assert.fail('M ' + M + ' k ' + k + ' sums to ' + sum);
    }
  }
});

test('the smallest stake over the most drops still gives every pellet at least 580 micro (design 4)', () => {
  const sh = splitShares(500000, K_MAX);
  assert.strictEqual(Math.min(...sh), 580);
  assert.strictEqual(Math.max(...sh), 581);
  assert.strictEqual(sh.filter((s) => s === 581).length, 500000 - 580 * K_MAX);
  // the 581s come first, then the 580s
  const firstLow = sh.indexOf(580);
  assert.ok(sh.slice(0, firstLow).every((s) => s === 581) && sh.slice(firstLow).every((s) => s === 580));
  // $1 over 861 gives 1161 or 1162
  const one = splitShares(1000000, K_MAX);
  assert.deepStrictEqual([Math.min(...one), Math.max(...one)], [1161, 1162]);
});

test('planSplit: foods are the non-null drops in drop order; null drops take nothing; shares sum to M', () => {
  const f = (i) => ({ id: i });
  const foods = [f(1), f(2), f(3), f(4)];
  const drops = [{ food: foods[0] }, { food: null }, { food: foods[1] }, null, { food: foods[2] }, { food: foods[3] }];
  assert.deepStrictEqual(foodsOf(drops), foods);
  const p = planSplit(1000003, drops);
  assert.strictEqual(p.unplaced, 0);
  assert.deepStrictEqual(p.foods, foods);
  assert.strictEqual(p.foods[0], foods[0], 'the food objects themselves, never copies');
  assert.deepStrictEqual(p.shares, [250001, 250001, 250001, 250000]);
  assert.strictEqual(p.shares.reduce((a, b) => a + b, 0), 1000003);
});

test('k = 0: no food at all (every drop null, or no drops) places nothing and leaves M unplaced', () => {
  assert.deepStrictEqual(planSplit(500000, []), { foods: [], shares: [], unplaced: 500000 });
  assert.deepStrictEqual(planSplit(500000, [{ food: null }, { food: null }, null]), { foods: [], shares: [], unplaced: 500000 });
  assert.deepStrictEqual(planSplit(0, []), { foods: [], shares: [], unplaced: 0 });
});

test('M below k (never with a real stake): only the first M foods take one micro each, so no pellet holds 0', () => {
  const foods = [1, 2, 3, 4, 5].map((id) => ({ id }));
  const p = planSplit(3, foods.map((food) => ({ food })));
  assert.deepStrictEqual(p.foods, foods.slice(0, 3));
  assert.deepStrictEqual(p.shares, [1, 1, 1]);
  assert.strictEqual(p.unplaced, 0);
  assert.throws(() => splitShares(3, 5), /cannot each hold a micro/);
  assert.deepStrictEqual(planSplit(0, foods.map((food) => ({ food }))), { foods: [], shares: [], unplaced: 0 });
});

test('bad amounts and counts are refused, never rounded', () => {
  for (const M of [NaN, -1, 1.5, 2 ** 53, Infinity, '500000', null, undefined, {}]) {
    assert.throws(() => splitShares(M, 1), RangeError, String(M));
    assert.throws(() => planSplit(M, []), RangeError, String(M));
  }
  for (const k of [0, -1, 1.5, NaN, '3', null]) assert.throws(() => splitShares(10, k), RangeError, String(k));
  for (const d of [null, undefined, 'x', { length: 1 }]) assert.throws(() => planSplit(10, d), TypeError);
});

test('slSplit is pure: no require, no clock, no randomness, no float money', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'slPaid', 'slSplit.js'), 'utf8');
  const code = src.split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  assert.doesNotMatch(code, /require\(|Math\.random|Date\.now|new Date|performance\.now|toFixed|Math\.round/);
});
