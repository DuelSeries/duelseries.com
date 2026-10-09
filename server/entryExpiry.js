'use strict';
/* A paid entry token that expires unspent (review finding, night queue item 5).

   The stake landed in escrow, db.markStakeSig burned its signature, and nobody
   joined with it: the tab closed while the game loaded, a Play again stake
   landed after its page had gone, a paid table was shut. entryStore.sweep used
   to delete such a token with no refund and no record, so the player's money
   stayed in escrow as surplus nobody could trace.

   Now it is paid back: what landed, never more than the rung
   (stakeRules.refundBound), to the VERIFIED wallet the token carries (the
   on-chain payer, never a client-sent address), with no rake and no earnings
   row. entryStore hands each expired token over exactly once (it leaves the
   store first, and neither consume path ever removes an expired token), so
   this pays at most once per stake. A send that fails becomes an owed
   failed_payouts row whose reason starts with 'refund', so the drainer pays it
   later and never counts it as winnings.

   Scoped dev tokens (onlyGame) have no chain behind them and must never be
   paid from the real escrow: Paper's go through Paper's own payout (the fake
   withdraw when PAPER_DEV_TOKENS is on), anything else is logged and dropped.

   A token whose stake has a durable row (t.stakeSig, STATUS item 7a) is refunded through that
   row instead (stakeLedger.refund): the row turns 'refunded' and the owed row is written in one
   statement, and the drainer pays it. The same row is what a boot or stale sweep refunds, so the
   expiry and a sweep can never both pay: whichever commits first wins, the other finds nothing.
   The token's claimKey goes with it, so a claim whose answer was lost (the row says 'consumed'
   but the token came back to memory unspent) is refunded too, and only by this token.

   Every dependency is injected, so the tests run it with fakes. */
const { refundBound } = require('./stakeRules');

function createExpiryRefund({ money, db, devRefund = null, ledger = null, log = console }) {
  return function refundExpired(t) {
    if (!t) return Promise.resolve(null);
    const wallet = t.walletAddress;
    const amount = refundBound(t.worth, t.paid);
    const label = (t.stake !== undefined && t.stake !== null) ? 'stake ' + t.stake : 'lobby ' + t.lobbyType;
    if (t.stakeSig && !t.onlyGame) {
      const led = typeof ledger === 'function' ? ledger() : ledger;
      if (led) {
        log.log(`[ENTRY] EXPIRED unspent ${label}: owed back through its stake row`);
        return led.refund(t.stakeSig, 'refund unspent entry ' + label, t.claimKey);
      }
      log.error(`[ENTRY] CRITICAL expired durable token with no ledger (${label}); left pending for the stake sweep`);
      return Promise.resolve(null);
    }
    if (t.onlyGame) {
      /* Paper's and paid agar.io's dev tokens (PAID-AGAR-DESIGN.md 5.8): devRefund, which the server routes
         to that game's own payout (the fake withdraw when PAPER_DEV_TOKENS is on). */
      if ((t.onlyGame === 'paper' || t.onlyGame === 'agar') && typeof devRefund === 'function') {
        log.log(`[ENTRY] EXPIRED unspent dev token (${label}) -> ${t.onlyGame === 'agar' ? "agar's" : "Paper's"} own refund`);
        return Promise.resolve().then(() => devRefund(t)).catch((e) => {
          log.error('[ENTRY] dev refund failed: ' + (e && e.message));
          return null;
        });
      }
      log.warn(`[ENTRY] EXPIRED unspent scoped token (${t.onlyGame}, ${label}) dropped: no chain behind it`);
      return Promise.resolve(null);
    }
    if (typeof wallet !== 'string' || !wallet || !(amount > 0)) {
      log.error(`[ENTRY] CRITICAL expired paid token with no wallet or amount (${label}, worth ${t.worth}, paid ${t.paid})`);
      return Promise.resolve(null);
    }
    log.log(`[ENTRY] EXPIRED unspent ${label}: refunding ${amount} ${money.unit || ''} to ${wallet}`);
    return Promise.resolve()
      .then(() => money.withdraw(wallet, amount))
      .then((sig) => {
        log.log(`[ENTRY] REFUND sent ${amount} -> ${String(wallet).slice(0, 8)} sig ${String(sig).slice(0, 12)}`);
        return sig;
      })
      .catch((e) => {
        log.error(`[ENTRY] CRITICAL refund of an unspent entry failed for ${wallet}, owed ${amount}: ${e && e.message}`);
        return Promise.resolve()
          .then(() => db.recordFailedPayout(wallet, amount, 'Player', 'refund unspent entry ' + label + ': ' + (e && e.message), e && e.broadcast))
          .catch((e2) => log.error('[ENTRY] CRITICAL could not record the owed refund: ' + (e2 && e2.message)))
          .then(() => null);
      });
  };
}

module.exports = { createExpiryRefund };
