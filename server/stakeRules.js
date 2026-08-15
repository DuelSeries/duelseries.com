'use strict';
/* ─── What a stake is allowed to be ───────────────────────────────────────────
   One place, because the same limits are applied at three points and they must
   not drift apart:

     1. the quote, so a player is never asked to sign a transfer for an amount
        that will be refused afterwards
     2. the submitted request, before anything is broadcast
     3. the amount that actually landed on-chain, which is the only one of the
        three the client did not choose

   The third check is the one that matters. The first two are courtesy.

   The floor matches the lowest tier the game already sells, so nothing becomes
   cheaper than it is today. The ceiling caps what one player can put at risk in
   a single room, which caps how far a single bug or a single bad beat can move
   real money. Both were unset in the spec and are chosen here; they are meant
   to be tuned, not treated as physics. */

const MIN_STAKE = 0.10;
const MAX_STAKE = 100;

/* Returns null when the amount is allowed, or a message saying why not.
   Zero is free play and always allowed. */
function stakeRangeError(v, { min = MIN_STAKE, max = MAX_STAKE } = {}) {
  const n = Number(v);
  if (typeof v === 'boolean' || v === null || v === '' ) return 'Not an amount';
  if (!isFinite(n)) return 'Not an amount';
  if (n < 0) return 'Not an amount';
  if (n === 0) return null;                       // free play
  if (n < min) return `Minimum stake is ${min.toFixed(2)}`;
  if (n > max) return `Maximum stake is ${max.toFixed(2)}`;
  return null;
}

module.exports = { MIN_STAKE, MAX_STAKE, stakeRangeError };
