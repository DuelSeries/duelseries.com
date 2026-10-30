'use strict';
// Product analytics for one paid arena life (server/analytics.js, on the one tracking plan in shared/trackPlan.js),
// shared by every arena the server pays out of: paid agar (agMoney), Chomp (chompMoney, by extension), Paper
// (PaperRoom) and paid slither (slMoney), and their doors (agPaidDoor, paperSockets, slPaidDoor). The paid
// game_started is recordEntry's (server/index.js), sent when the seat starts. These send the rest, once per life, at
// the server's own decision and after its money action, never from a payout, its retry or a drainer:
//   died        a death; amount what the server pays the player on it (0: the money stays in the room)
//   cashed_out  a finished hold; amount the dollars paid after the house cut (cashNet: paperPayout's 90/10 integers)
//   left        the server ended the life because its player left or dropped (amount: what that paid, 0 on a death)
//   refunded    a started seat handed its balance back (emergency, restart, crash, orphan), plus stake_refunded
//   ended       any other end the server decided (an emergency's cash-out, a frozen account held for a manual look)
// A seat refunded before it ever started (a release, a door refusal) sends stake_refunded only.
//
// analytics is injected (the money hooks' `analytics`, a door's `analytics` option, wired in server/index.js), never
// required here: a controller built without it (every test that does not ask for it, a dev token's arena) sends
// nothing. Nothing here throws.

const { HOUSE_CUT_DIV } = require('../paperPayout');

// The dollars a 90/10 cash-out of grossMicro pays the player: paperPayout.payCashout's own integer split.
function cashNet(grossMicro) {
  const g = Number(grossMicro);
  if (!Number.isSafeInteger(g) || g <= 0) return 0;
  return (g - Math.floor(g / HOUSE_CUT_DIV)) / 1e6;
}

// micro (integer) to dollars; anything else is 0.
function dollars(micro) {
  return Number.isSafeInteger(micro) && micro > 0 ? micro / 1e6 : 0;
}

// One life's game_ended. o: analytics.gameEnded's own object ({ wallet, game, result, stake, amount, reason, room, ...}).
function ended(analytics, o) {
  try {
    if (!analytics || typeof analytics.gameEnded !== 'function' || !o || !o.wallet) return false;
    return analytics.gameEnded(o) === true;
  } catch (_) {
    return false;
  }
}

// A buy-in handed back. p: { game, stake, amount, reason }, money in dollars; nothing is sent for 0.
function refunded(analytics, wallet, p) {
  try {
    if (!analytics || typeof analytics.track !== 'function' || !wallet || !p || !(p.amount > 0)) return false;
    return analytics.track('stake_refunded', wallet, { game: p.game, stake: p.stake, amount: p.amount, reason: p.reason }) === true;
  } catch (_) {
    return false;
  }
}

// A door's refund of a spent token it did not seat (never started): stake_refunded with what goes back, the worth
// capped at what landed on-chain (paperPayout.refund's rule). entry: the consumed token's { walletAddress, worth, paid }.
function doorRefunded(analytics, game, entry, why) {
  try {
    if (!entry || !entry.walletAddress) return false;
    const worth = Number(entry.worth);
    const paid = Number(entry.paid);
    const amount = Number.isFinite(paid) && paid > 0 ? Math.min(worth, paid) : worth;
    return refunded(analytics, entry.walletAddress, { game, stake: worth, amount, reason: why });
  } catch (_) {
    return false;
  }
}

module.exports = { cashNet, dollars, ended, refunded, doorRefunded };
