'use strict';
// rakeSweep.js: sweepRake, moved out of server/index.js (unchanged) so its success and failure paths can be tested.
//
// Move a rake cut out of the escrow to the revenue wallet. Best-effort + non-blocking: the player's
// payout already happened, so a failed sweep is queued to the failed-payout drainer (retried
// idempotently, money never lost). The very first sweep also creates the revenue wallet's USDC ATA.
//
// onSwept(amount, label) runs once the withdraw has landed (the owner's "you made money" push,
// server/earnAlerts.js). It is called outside the promise chain's catch: a throw from it can never
// look like a failed sweep, so it can never queue a second sweep of the same cut.

function createRakeSweeper({ money, db, revenueWallet, onSwept = null, log = console }) {
  function swept(amount, label) {
    if (!onSwept) return;
    try { onSwept(amount, label); } catch (_) { /* a lost push, never a lost or doubled sweep */ }
  }
  return function sweepRake(amountUsdc, label) {
    if (!(amountUsdc > 0)) return;
    money.withdraw(revenueWallet, amountUsdc)
      .then((sig) => {
        log.log(`[RAKE] swept ${Number(amountUsdc).toFixed(6)} ${money.unit} -> revenue wallet (${label}) sig ${String(sig).slice(0, 12)}`);
        swept(amountUsdc, label);
      }, (e) => {
        log.error(`[RAKE] sweep failed (${label}) for ${amountUsdc}: ${e.message}`);
        db.recordFailedPayout(revenueWallet, amountUsdc, 'rake-sweep', `rake ${label}: ${e.message}`, e.broadcast).catch(() => {});
      });
  };
}

module.exports = { createRakeSweeper };
