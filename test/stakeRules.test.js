'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { MIN_STAKE, MAX_STAKE, stakeRangeError } = require('../server/stakeRules');

test('ordinary amounts inside the range are allowed', () => {
  for (const v of [0.10, 0.25, 1, 2.5, 37.42, 100])
    assert.equal(stakeRangeError(v), null, String(v));
});

test('the boundaries themselves are allowed', () => {
  assert.equal(stakeRangeError(MIN_STAKE), null);
  assert.equal(stakeRangeError(MAX_STAKE), null);
});

test('free play is allowed', () => {
  assert.equal(stakeRangeError(0), null);
});

test('below the floor and above the ceiling are refused', () => {
  assert.match(stakeRangeError(0.09), /Minimum/);
  assert.match(stakeRangeError(100.01), /Maximum/);
});

test('junk is refused rather than coerced into a number', () => {
  // Number('') is 0 and Number(true) is 1, so a lazy isFinite check would let
  // an empty field or a boolean through as free play or as a $1 stake.
  for (const v of ['', null, true, false, 'abc', NaN, Infinity, -Infinity, -1, -0.5])
    assert.equal(typeof stakeRangeError(v), 'string', JSON.stringify(v));
});

test('a numeric string is accepted, since query params arrive as strings', () => {
  assert.equal(stakeRangeError('2.50'), null);
  assert.match(stakeRangeError('0.01'), /Minimum/);
});

test('the range can be overridden without editing the rule', () => {
  assert.equal(stakeRangeError(5, { min: 1, max: 10 }), null);
  assert.match(stakeRangeError(50, { min: 1, max: 10 }), /Maximum/);
});
