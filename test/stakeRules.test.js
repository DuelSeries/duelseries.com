'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { STAKE_TIERS, ALL_STAKES, isStake, tierFor, stakeRangeError,
        MIN_STAKE, MAX_STAKE } = require('../server/stakeRules');

test('the ladder is exactly the agreed set', () => {
  assert.deepEqual(STAKE_TIERS, [0.10, 1]);
  assert.deepEqual(ALL_STAKES, [0, 0.10, 1]);
  assert.equal(MIN_STAKE, 0.10);
  assert.equal(MAX_STAKE, 1);
  /* The ladder and the room fee table have to agree. They did not: money.js
     has said dime 0.10 / dollar 1.00 all along while this said 0.50 / 2. */
  const fees = require('../server/money').lobbyFees;
  assert.deepEqual(STAKE_TIERS, [fees.dime, fees.dollar],
    'the ladder is the same money the rooms charge');
});

test('every rung is accepted, and free with them', () => {
  for (const v of ALL_STAKES) {
    assert.equal(isStake(v), true, String(v));
    assert.equal(stakeRangeError(v), null, String(v));
  }
});

test('an amount between rungs is refused', () => {
  // The whole point of a set: there is no "valid but absurd" buy-in.
  for (const v of [0.05, 0.11, 0.25, 0.50, 0.75, 1.5, 2, 3, 37.42, 100, 250])
    assert.match(stakeRangeError(v), /Buy-in must be one of/, String(v));
});

test('the refusal names the ladder rather than just saying no', () => {
  const msg = stakeRangeError(3);
  assert.ok(msg.includes('$0.10') && msg.includes('$1'), msg);
  assert.ok(msg.includes('$0.10'), 'sub-dollar rungs keep their cents, not "$0.1"');
  assert.ok(!/\$0\b(?!\.)/.test(msg), 'free is not offered as a buy-in');
});

test('junk is refused rather than coerced', () => {
  // Number('') is 0 and Number(true) is 1, so a lazy check would let an empty
  // field through as free play and a boolean through as a $1 buy-in.
  for (const v of ['', null, true, false, 'abc', NaN, Infinity, -1])
    assert.equal(typeof stakeRangeError(v), 'string', JSON.stringify(v));
});

test('a numeric string is accepted, since query params arrive as strings', () => {
  assert.equal(stakeRangeError('1'), null);
  assert.equal(stakeRangeError('0.10'), null);
  assert.match(stakeRangeError('0.11'), /Buy-in must be/);
});

test('float noise does not knock a stake off its rung', () => {
  // 0.7 - 0.6 is 0.09999999999999998. Compared as a float that is not 0.10
  // and the player lands in a room of their own.
  assert.equal(isStake(0.7 - 0.6), true, '0.10 the hard way');
  assert.equal(isStake(0.9 + 0.1), true, '1 the hard way');
  assert.equal(stakeRangeError(0.7 - 0.6), null);
});

test('a payment buys the largest tier it covers', () => {
  assert.equal(tierFor(0.10), 0.10);
  assert.equal(tierFor(1), 1);
  assert.equal(tierFor(0.50), 0.10, 'fifty cents is no longer a rung, so it buys the $0.10 room');
});

test('a small overpay still buys the tier, it does not fail', () => {
  // The stake has already settled on-chain by this point. Refusing it would
  // leave a player out of pocket with no seat.
  assert.equal(tierFor(1.04), 1);
  assert.equal(tierFor(0.99), 0.10, 'an underpay drops to the tier it does cover');
  assert.equal(tierFor(150), 1, 'and a large overpay caps at the top rung');
});

test('paying less than the smallest tier buys free play, not a paid seat', () => {
  assert.equal(tierFor(0.09), 0, 'covers only the free rung');
  assert.equal(tierFor(0), 0);
});

test('a nonsense payment buys nothing at all', () => {
  for (const v of [-1, NaN, Infinity, 'abc']) assert.equal(tierFor(v), null, String(v));
});
