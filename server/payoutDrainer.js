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
   can never lead to a second transaction for one row.

   Never two payouts for one row (security review 2026-10-15, "drainer double pay"). The normal
   lane's claim is only a 30 s lease, and building a fresh payout can take longer than that while
   the RPC is rate limiting (every read retries with backoff). Two runs could then each claim a row
   that had no saved signature yet, each build their own transaction (different blockhashes, so
   different signatures) and each send it: two real transfers for one owed row. Two guards, each
   enough on its own:
   - one run at a time: a 30 s tick or a refund kick that arrives while a run is in progress starts
     nothing beside it; all of them merge into ONE follow-up run that starts when it ends;
   - the signature save is a compare-and-set against the signature the row was claimed with
     (db.savePayoutSignature), and attemptPayout sends nothing when it did not update the row. That
     one also covers two processes sharing the database (an old and a new server during a restart). */

const SUPERSEDED = 'payout-superseded';

/* onPaid(row): optional, runs once a row's payout has landed and the row is marked paid (index.js: the
   owner's earnings push when the row was a rake sweep). A throw from it is swallowed here, so it can
   never reach the catch below and look like a failed payout. */
function createPayoutDrainer({ db, money, noAccountCode, log = console, perTick = 5, maxClaims = 40,
                               stallMs = 10 * 60 * 1000, now = () => Date.now(), onPaid = null }) {
  async function tryRow(row) {
    const slow = row.lane === 'slow';
    try {
      // Saved only if the row still holds the signature it was claimed with (null for a row that
      // never had a transaction): otherwise another attempt got there first and nothing is sent.
      const prev = row.signature || null;
      const r = await money.attemptPayout(row, (b) => db.savePayoutSignature(row.id, b, prev));
      if (r && r.paid) {
        await db.markPayoutPaid(row.id, r.sig);
        if (onPaid) { try { onPaid(row); } catch (_) { /* a lost push, never a payout */ } }
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
      if (e && e.code === SUPERSEDED) {
        // Another attempt saved its own transaction for this row first. This one sent nothing; the
        // row is finished by that transaction, which later runs re-send and never rebuild.
        log.warn(`[PAYOUT] row ${row.id}: another attempt saved its transaction first, this one sent nothing`);
        return 'superseded';
      }
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

  async function runOnce() {
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

  /* One run at a time. A call made while a run is in progress (the 30 s tick, or a kick after a
     refund) starts nothing beside it: every such call shares ONE follow-up run, which starts when
     the current one ends, and resolves with that run's result.
     A run that has not ended after stallMs (an RPC call that never answers) must not stop every
     payout for good, so the next call then starts a new run beside it, loudly. That is safe: the
     compare-and-set still allows one transaction per row, and a row whose transaction is saved is
     only ever re-sent. */
  let current = null;     // the run in progress
  let startedAt = 0;
  let followUp = null;    // the one run queued behind it
  function start() {
    const run = runOnce().finally(() => { if (current === run) current = null; });
    current = run;
    startedAt = now();
    followUp = null;
    return run;
  }
  function drain() {
    if (!current) return start();
    if (now() - startedAt > stallMs) {
      log.error(`[PAYOUT] a drain has run for over ${Math.round(stallMs / 60000)} min (an RPC call that never answers?); starting a new one beside it`);
      return start();
    }
    if (!followUp) {
      const next = () => { followUp = null; return drain(); };
      followUp = current.then(next, next);
    }
    return followUp;
  }

  return { drain, tryRow, get running() { return current !== null; } };
}

module.exports = { createPayoutDrainer, SUPERSEDED };
