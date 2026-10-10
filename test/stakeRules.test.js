'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { STAKE_TIERS, ALL_STAKES, isStake, tierFor, stakeRangeError,
        MIN_STAKE, MAX_STAKE } = require('../server/stakeRules');

test('the ladder is exactly the agreed set', () => {
  // BACKLOG 2.1 (Owen 2026-10-09): Free, $0.50 and $1.00 in every game. $0.10 is retired.
  assert.deepEqual(STAKE_TIERS, [0.50, 1]);
  assert.deepEqual(ALL_STAKES, [0, 0.50, 1]);
  assert.equal(MIN_STAKE, 0.50);
  assert.equal(MAX_STAKE, 1);
  /* The old tier table keeps only the dollar beside the ladder. The dime (0.10) is gone with
     its rung, so nothing can quote, stake or mint it. */
  const fees = require('../server/money').lobbyFees;
  assert.strictEqual(fees.dollar, MAX_STAKE, 'the dollar tier is the same money as the $1 rung');
  assert.ok(!Object.prototype.hasOwnProperty.call(fees, 'dime'), 'the dime tier is retired');
  for (const v of Object.values(fees)) assert.ok(v === 0 || ALL_STAKES.includes(v), 'no tier prices an amount off the ladder: ' + v);
});

test('one ladder file: the server, Paper and the lobby all read shared/stakeLadder.js', () => {
  const ROOT = path.join(__dirname, '..');
  const L = require('../shared/stakeLadder');
  assert.deepEqual([...L.PAID_RUNGS], [0.50, 1]);
  assert.deepEqual([...L.LADDER], [0, 0.50, 1]);
  assert.ok(Object.isFrozen(L.PAID_RUNGS) && Object.isFrozen(L.LADDER), 'nothing can push a rung onto it at run time');
  assert.deepEqual(STAKE_TIERS, [...L.PAID_RUNGS], 'stakeRules is the shared list');
  assert.deepEqual(ALL_STAKES, [...L.LADDER]);
  // Paper's arenas used to keep their own copy, which would have refused every $0.50 join as full.
  const { RUNGS } = require('../server/paper/PaperArenas');
  assert.deepEqual(RUNGS, ALL_STAKES, 'Paper builds its arenas from the same rungs');
  const pa = fs.readFileSync(path.join(ROOT, 'server/paper/PaperArenas.js'), 'utf8');
  assert.ok(/const RUNGS = require\('\.\.\/stakeRules'\)\.ALL_STAKES/.test(pa), 'and does not hard-code them');
  const sr = fs.readFileSync(path.join(ROOT, 'server/stakeRules.js'), 'utf8');
  assert.ok(/const STAKE_TIERS = require\('\.\.\/shared\/stakeLadder'\)\.PAID_RUNGS/.test(sr));
  // The lobby loads the same file and draws every game's buttons, and the duel stepper, from it.
  const html = fs.readFileSync(path.join(ROOT, 'public/v2.html'), 'utf8');
  assert.ok(html.includes('<script src="/shared/stakeLadder.js"></script>'), 'the lobby loads the ladder');
  assert.ok(html.indexOf('/shared/stakeLadder.js') < html.indexOf('const LADDER='), 'before the code that reads it');
  assert.ok(/const LADDER=\(\(window\.DS_LADDER&&window\.DS_LADDER\.LADDER\)\|\|\[0\]\)\.slice\(\);/.test(html),
    'LADDER is the shared list, or Free alone if it did not load');
  assert.ok(/const DUEL_LADDER=LADDER\.slice\(\);/.test(html), 'the duel stepper is the same ladder');
  assert.ok(!/const (DUEL_)?LADDER=\[/.test(html), 'no hard-coded ladder is left in the lobby');
  // Run in a window: the browser global lands where the lobby reads it.
  const win = {};
  new Function('window', fs.readFileSync(path.join(ROOT, 'shared/stakeLadder.js'), 'utf8').replace("typeof module !== 'undefined'", 'false'))(win);
  assert.deepEqual([...win.DS_LADDER.LADDER], [0, 0.50, 1]);
});

test('every rung is accepted, and free with them', () => {
  for (const v of ALL_STAKES) {
    assert.equal(isStake(v), true, String(v));
    assert.equal(stakeRangeError(v), null, String(v));
  }
});

test('the retired $0.10 rung is refused everywhere a stake is read', () => {
  const { rungOf } = require('../server/stakeRules');
  for (const v of [0.1, 0.10, '0.1', '0.10', 0.7 - 0.6]) {
    assert.equal(isStake(v), false, String(v));
    assert.equal(rungOf(v), null, String(v));
    assert.match(stakeRangeError(v), /Buy-in must be one of \$0\.50, \$1$/, String(v));
  }
  // A $0.10 payment now covers no paid rung: it buys free play, never a $0.50 seat.
  assert.equal(tierFor(0.1), 0);
});

test('an amount between rungs is refused', () => {
  // The whole point of a set: there is no "valid but absurd" buy-in.
  for (const v of [0.05, 0.10, 0.11, 0.25, 0.49, 0.51, 0.75, 1.5, 2, 3, 37.42, 100, 250])
    assert.match(stakeRangeError(v), /Buy-in must be one of/, String(v));
});

test('the refusal names the ladder rather than just saying no', () => {
  const msg = stakeRangeError(3);
  assert.ok(msg.includes('$0.50') && msg.includes('$1'), msg);
  assert.ok(!msg.includes('$0.10'), 'the retired rung is not offered');
  assert.ok(!msg.includes('$0.5,') && !/\$0\.5$/.test(msg), 'sub-dollar rungs keep their cents, not "$0.5"');
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
  assert.equal(stakeRangeError('0.50'), null);
  assert.equal(stakeRangeError('0.5'), null);
  assert.match(stakeRangeError('0.51'), /Buy-in must be/);
});

test('float noise does not knock a stake off its rung', () => {
  // 0.3 + 0.2 is exact, but 0.1 * 5 and 1.1 - 0.6 are not: compared as floats they are not
  // 0.50 and the player lands in a room of their own.
  assert.equal(isStake(1.1 - 0.6), true, '0.50 the hard way');
  assert.equal(isStake(0.9 + 0.1), true, '1 the hard way');
  assert.equal(stakeRangeError(1.1 - 0.6), null);
});

test('a payment buys the largest tier it covers', () => {
  assert.equal(tierFor(0.50), 0.50);
  assert.equal(tierFor(1), 1);
  assert.equal(tierFor(0.75), 0.50, 'seventy-five cents is not a rung, so it buys the $0.50 room');
});

test('a small overpay still buys the tier, it does not fail', () => {
  // The stake has already settled on-chain by this point. Refusing it would
  // leave a player out of pocket with no seat.
  assert.equal(tierFor(1.04), 1);
  assert.equal(tierFor(0.52), 0.50);
  assert.equal(tierFor(0.99), 0.50, 'an underpay drops to the tier it does cover');
  assert.equal(tierFor(150), 1, 'and a large overpay caps at the top rung');
});

test('paying less than the smallest tier buys free play, not a paid seat', () => {
  assert.equal(tierFor(0.49), 0, 'covers only the free rung');
  assert.equal(tierFor(0.10), 0, 'the retired ten cents too');
  assert.equal(tierFor(0), 0);
});

test('a nonsense payment buys nothing at all', () => {
  for (const v of [-1, NaN, Infinity, 'abc']) assert.equal(tierFor(v), null, String(v));
});

test('a stake off a rung by more than float noise is refused, however it rounds to cents', () => {
  // Review finding (night queue item 5): cents rounding made 0.10499 the then $0.10 rung and
  // 0.004 the free one, and a Paper join with no token at 0.10499 then set that arena's stake.
  const { rungOf } = require('../server/stakeRules');
  for (const v of [0.50499, 1.00499, 0.5049, 0.004, 0.0049, 0.505, 0.4999, 1.004, 0.995]) {
    assert.equal(isStake(v), false, String(v));
    assert.equal(rungOf(v), null, String(v));
    assert.match(stakeRangeError(v), /Buy-in must be one of/, String(v));
  }
  // What a door uses from here on is the ladder's own number, never the request's.
  assert.equal(rungOf('0.50'), ALL_STAKES[1]);
  assert.equal(rungOf(1.1 - 0.6), 0.5);
  assert.equal(Object.is(rungOf(1.1 - 0.6), ALL_STAKES[1]), true);
  assert.equal(rungOf(0), 0);
  for (const v of ['', null, undefined, true, false, 'abc', NaN, Infinity]) assert.equal(rungOf(v), null, String(v));
});
