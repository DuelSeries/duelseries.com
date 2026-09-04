'use strict';
/* ─── The stake ladder ────────────────────────────────────────────────────────
   Buy-ins are a fixed set, not any amount:

     free · 0.50 · 2

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

const STAKE_TIERS = [0.50, 2];
const FREE = 0;
const ALL_STAKES = [FREE].concat(STAKE_TIERS);

const MIN_STAKE = STAKE_TIERS[0];
const MAX_STAKE = STAKE_TIERS[STAKE_TIERS.length - 1];

/* Money compared as fixed-point cents. 0.1 + 0.2 !== 0.3 in binary floats, and
   a stake that misses its tier by one ulp is a room nobody else is in. */
const cents = v => Math.round(Number(v) * 100);
const isStake = v => Number.isFinite(Number(v)) && ALL_STAKES.some(t => cents(t) === cents(v));

/* The largest tier this payment covers, or null if it covers none. */
function tierFor(paid) {
  const n = Number(paid);
  if (!Number.isFinite(n) || n < 0) return null;
  let best = null;
  for (const t of ALL_STAKES) if (cents(t) <= cents(n)) best = t;
  return best;
}

/* Returns null when the amount is an allowed buy-in, or a message saying why
   not. Used on the quote and on the request, before anything is broadcast. */
function stakeRangeError(v, { tiers = ALL_STAKES } = {}) {
  if (typeof v === 'boolean' || v === null || v === '') return 'Not an amount';
  const n = Number(v);
  if (!Number.isFinite(n)) return 'Not an amount';
  if (n < 0) return 'Not an amount';
  if (tiers.some(t => cents(t) === cents(n))) return null;
  // Whole dollars read better without the cents; anything under a dollar needs
  // them, or the ladder prints "$0.5".
  const label = t => '$' + (t < 1 ? t.toFixed(2) : String(t));
  return 'Buy-in must be one of ' + tiers.filter(t => t > 0).map(label).join(', ');
}

module.exports = { STAKE_TIERS, ALL_STAKES, FREE, MIN_STAKE, MAX_STAKE,
                   isStake, tierFor, stakeRangeError };
