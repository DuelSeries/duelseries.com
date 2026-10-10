'use strict';
/* ─── The stake ladder ────────────────────────────────────────────────────────
   Buy-ins are a fixed set, not any amount:

     free · 0.50 · 1

   Cut from nine rungs to three. Nine gave the buy-in control a stepper and a
   row of dots to page through, and split what few players there are across
   rooms nobody picked for a reason. Three fit on screen at once as three
   buttons, which is the whole control.

   A closed set is materially safer than a range. A range has to be checked at
   the edges and trusted in the middle; a set is either matched or refused, so
   there is no "valid but absurd" amount like 37.42 to reason about, and no
   ladder of near-identical rooms splitting the player base across amounts
   nobody chose deliberately.

   Free is kept because it already exists and the board should always have
   something joinable with nobody online.

   WHY SNAP-DOWN, AND NOT EXACT MATCH
   The amount that reaches the server is what actually landed on-chain, and the
   verifier tolerates a small overpay. Requiring exact equality would refuse a
   stake that has already settled, leaving a player out of pocket with no seat.
   So a payment buys the largest tier it covers: pay 1.00 and you get the $1
   room; pay 1.04 and you still get the $1 room, with the excess left in escrow.
   Paying less than the smallest tier buys nothing, which is the only case where
   refusing is the right answer, and the client cannot get there because it is
   quoted a tier before it signs anything. */

/* Fifty cents and a dollar (BACKLOG 2.1, Owen 2026-10-09): ten cents could not cover what a
   paid room costs to run. The rungs live in ONE file, shared/stakeLadder.js, which the lobby
   reads too, so the server and the buy-in buttons cannot drift apart. The old fixed tiers in
   money.js (dime 0.10, dollar 1.00) used to sit beside this ladder as a second table; the
   dime is gone with the ten cent rung. */
const STAKE_TIERS = require('../shared/stakeLadder').PAID_RUNGS.slice();
const FREE = 0;
const ALL_STAKES = [FREE].concat(STAKE_TIERS);

const MIN_STAKE = STAKE_TIERS[0];
const MAX_STAKE = STAKE_TIERS[STAKE_TIERS.length - 1];

/* A stake names a rung only when it IS the rung, up to float noise (0.7 - 0.6 is
   0.09999999999999998, 2e-17 off). This used to round to cents, so 0.10499 named the
   $0.10 rung (a rung until BACKLOG 2.1) and 0.004 the free one: a Paper join with no token and no money at 0.10499
   opened the $0.10 arena with that number as its stake, and every honest player seated
   there was then quoted 0.10499 on Play again (review finding, night queue item 5). An
   honest client only ever sends a number the server gave it, so an exact match refuses
   nobody honest. rungOf hands back the ladder's OWN number, which is what every door
   uses from then on, never the request's. */
const RUNG_EPS = 1e-9;
function rungOf(v) {
  /* A number or a string, nothing else. The value is a client's, and Number() on an object it
     built can THROW ({"toString":1}), which inside a socket handler ended the whole process; an
     array of one number ([0.1]) also used to name that rung. */
  if ((typeof v !== 'number' && typeof v !== 'string') || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const t = ALL_STAKES.find(r => Math.abs(r - n) <= RUNG_EPS);
  return t === undefined ? null : t;
}
const isStake = v => rungOf(v) !== null;

/* Money compared as whole micro-dollars (USDC has 6 decimals, so what landed is an exact
   count of them). Never rounded up to a rung: comparing rounded cents let 0.099 buy the
   then $0.10 rung and 0.995 the $1 rung, a seat worth more than was paid (review finding). */
const micro = v => Math.round(Number(v) * 1e6);

/* The largest tier this payment covers, or null if it covers none. */
function tierFor(paid) {
  const n = Number(paid);
  if (!Number.isFinite(n) || n < 0) return null;
  let best = null;
  for (const t of ALL_STAKES) if (micro(t) <= micro(n)) best = t;
  return best;
}

/* Returns null when the amount is an allowed buy-in, or a message saying why
   not. Used on the quote and on the request, before anything is broadcast. */
function stakeRangeError(v, { tiers = ALL_STAKES } = {}) {
  if (typeof v === 'boolean' || v === null || v === '') return 'Not an amount';
  const n = Number(v);
  if (!Number.isFinite(n)) return 'Not an amount';
  if (n < 0) return 'Not an amount';
  if (tiers.some(t => Math.abs(t - n) <= RUNG_EPS)) return null;
  // Whole dollars read better without the cents; anything under a dollar needs
  // them, or the ladder prints "$0.5".
  const label = t => '$' + (t < 1 ? t.toFixed(2) : String(t));
  return 'Buy-in must be one of ' + tiers.filter(t => t > 0).map(label).join(', ');
}

/* What a refund of a seat may pay: its stake, never more than what landed on-chain. The
   verifier accepted a USDC payment up to 1 percent under the rung until night item 5, and
   SOL mode still allows 5 percent (the token's paid), so refunding
   the rung itself would mint the difference out of escrow on every refund. paid unknown or
   not a positive number (a free seat, an old caller): the stake, as before. */
function refundBound(worth, paid) {
  const w = Number(worth) > 0 ? Number(worth) : 0;
  const p = Number(paid);
  return Number.isFinite(p) && p > 0 ? Math.min(w, p) : w;
}

module.exports = { STAKE_TIERS, ALL_STAKES, FREE, MIN_STAKE, MAX_STAKE,
                   isStake, rungOf, tierFor, stakeRangeError, refundBound };
