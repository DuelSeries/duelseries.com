'use strict';
/* The owed-payout drainer (NA only), moved out of server/index.js so it can be tested directly.

   Retries payouts that failed (an RPC outage, a wallet with no USDC account) so a player's money
   is never stranded. money.attemptPayout is idempotent: it only ever re-broadcasts the SAME signed
   tx (so it cannot double-pay) and saves a freshly built tx BEFORE sending it. The DB row claim
   (SKIP LOCKED plus the retry spacing) keeps two ticks or two servers off the same row.

   Two lanes (STATUS item 7b, night queue item 5). A wallet with no USDC account cannot be paid
   (escrow never pays a player's account rent, Usdc.js), and those rows used to sit in the one
   oldest-first queue, 5 rows per 30 s, so a player who left many of them could hold every honest
   payout behind them. Now:
   - normal lane: every other row, oldest first, perTick real attempts a tick. A row found to have
     no account is moved to the slow lane on the spot: it failed before anything was signed, so it
     does not use up one of those attempts (maxClaims bounds the whole tick).
   - slow lane: only rows waiting for an account, with a growing backoff, its own budget after the
     normal lane, and no attempt cap (never dropped). Once the account exists it is paid there; a
     payout that then fails for another reason goes back to the normal lane with a fresh attempt
     budget (a row owed before the lanes existed can arrive with the old cap used up).
   A row is only ever moved between lanes after an attempt that signed nothing new, so a lane move
   can never lead to a second transaction for one row. */

function createPayoutDrainer({ db, money, noAccountCode, log = console, perTick = 5, maxClaims = 40 }) {
  async function tryRow(row) {
    const slow = row.lane === 'slow';
    try {
      const r = await money.attemptPayout(row, (b) => db.savePayoutSignature(row.id, b));
      if (r && r.paid) {
        await db.markPayoutPaid(row.id, r.sig);
        // Earnings count on actual payout: record now that the recovery landed (it was not
        // recorded at failure time), so the board reflects this real payout exactly once.
        // Not for a refund (reason begins 'refund'): that is the player's own entry going home.
        if (!String(row.reason || '').startsWith('refund')) {
          Promise.resolve()
            .then(() => db.recordEarnings(row.wallet_address, row.name, row.amount_sol, money.fiatValue(row.amount_sol)))
            .catch(() => {});
        }
        log.log(`[PAYOUT] recovered ${row.amount_sol} ${money.unit || ''} -> ${String(row.wallet_address).slice(0, 8)}... sig ${String(r.sig).slice(0, 12)} (attempt ${row.attempts}${slow ? ', slow lane' : ''})`);
        return 'paid';
      }
      if (slow) await db.returnPayoutToLane(row.id);
      log.warn(`[PAYOUT] ${row.amount_sol} ${money.unit || ''} to ${String(row.wallet_address).slice(0, 8)}... still pending (attempt ${row.attempts})`);
      return 'pending';
    } catch (e) {
      if (noAccountCode && e && e.code === noAccountCode) {
        try { await db.deferPayoutNoAccount(row.id); } catch (e2) { log.error('[PAYOUT] could not defer row ' + row.id + ': ' + e2.message); }
        log.warn(`[PAYOUT] ${row.amount_sol} to ${String(row.wallet_address).slice(0, 8)}... waits for a USDC account (slow lane, row ${row.id})`);
        return 'no-account';
      }
      if (slow) { try { await db.returnPayoutToLane(row.id); } catch (_) {} }
      log.error(`[PAYOUT] retry errored for ${String(row.wallet_address).slice(0, 8)}...: ${e && e.message}`);
      return 'error';
    }
  }

  async function drain() {
    const out = { normal: 0, deferred: 0, slow: 0 };
    try {
      let tried = 0, claims = 0;
      while (tried < perTick && claims < maxClaims) {
        const row = await db.claimDuePayout(30, 200, 'normal');
        if (!row) break;
        claims++;
        const r = await tryRow(row);
        if (r === 'no-account') out.deferred++;
        else { tried++; out.normal++; }
      }
      for (let i = 0; i < perTick; i++) {
        const row = await db.claimDuePayout(30, 200, 'slow');
        if (!row) break;
        row.lane = 'slow';
        await tryRow(row);
        out.slow++;
      }
    } catch (e) {
      log.error('[PAYOUT] drainer tick failed: ' + (e && e.message));
    }
    return out;
  }

  return { drain, tryRow };
}

module.exports = { createPayoutDrainer };
