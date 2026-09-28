'use strict';
/* The durable record of every verified stake (STATUS item 7a, night queue item 5).

   The problem it closes: an entry token lived only in server memory, so a restart or a crash
   between a stake landing in escrow and its join (a push to main restarts the server) lost the
   token and the player's money with it.

   The record is the row /api/submit-stake already writes to claim the stake's signature once
   (used_stake_sigs), extended with who the stake is owed to, what a refund pays, and a state:

     pending  --a door claims it, before anything is seated-->  consumed
     pending  --a refund claims it (with its owed row)------->  refunded
     consumed --the SAME door's claim, when it could not seat->  refunded

   Every arrow is one conditional UPDATE in the database, so for one stake exactly one of them can
   ever win, on any server: a door racing a boot refund, NA and EU sharing the database, the unspent
   token expiry (entryExpiry) racing a boot or stale sweep. A refund is never paid here: it becomes
   an owed failed_payouts row in the same statement, and the drainer pays that row with its
   idempotent, signature-first payout. A failed_payouts unique index on the stake allows one such
   row per stake whatever happens.

   Who refunds a pending row:
   - the server that holds its token, when the token expires unspent (entryExpiry);
   - at boot, every pending row of THIS region written by an EARLIER boot of this server: its
     tokens died with that process, so nobody can spend them;
   - every 5 minutes, any pending row older than 30 minutes, from any server (a token lives 5).

   What a door claim means: the row is 'consumed' before the seat exists, and seating follows in
   the same turn. A crash after that point is a crash with a seated player, the same as any seated
   player at a crash; the boot refund never touches it, so it can never pay a stake that was
   played. Dependencies are injected, so the tests run it against a model of the database. */

function createStakeLedger({ db, region, bootId, log = console, kickDrain = () => {}, staleMs = 30 * 60 * 1000 }) {
  // Refunds the database could not take yet (it was unreachable), retried by retryQueued().
  const retry = new Map();   // sig -> { sig, reason, claimKey }
  let bootSwept = false;

  /* /api/submit-stake, after the stake is verified. amount is what a refund pays (what landed,
     capped at the rung). Returns { claimed, durable }: claimed false means the signature was
     used already; durable false (old database, or a stub) means the token works exactly as it
     did before this change, memory only. */
  async function record(sig, { wallet, amount, label } = {}) {
    if (typeof db.claimStakeSig !== 'function') {
      return { claimed: !!(await db.markStakeSig(sig)), durable: false };
    }
    const r = await db.claimStakeSig(sig, { wallet, amount, label, region, bootId });
    const claimed = !!(r && r.claimed);
    return { claimed, durable: claimed && !!r.durable };
  }

  /* A door, before it seats: 'ok' (this token owns the stake now), 'settled' (it was refunded
     already: seat nothing) or 'error' (the database did not answer: seat nothing, and the door
     puts the token back, since nothing was spent). */
  async function claimSeat(entry) {
    try {
      return (await db.claimStakeSeat(entry.stakeSig, entry.claimKey)) ? 'ok' : 'settled';
    } catch (e) {
      log.error(`[STAKE] claim failed for ${String(entry.stakeSig).slice(0, 12)} (token kept): ${e && e.message}`);
      return 'error';
    }
  }

  /* Refund a stake through the owed-payout lane. claimKey is passed only by the holder of the
     token (a door that claimed and could not seat, or the token's own expiry). Resolves:
     'owed' (the owed row was written, the drainer pays it), 'settled' (nothing to do: it was
     seated or refunded already) or 'queued' (the database did not answer; retried). Never
     rejects. */
  async function refund(sig, reason, claimKey = null) {
    const why = String(reason || '').startsWith('refund') ? String(reason) : 'refund ' + String(reason || '');
    try {
      const row = await db.refundStakeOwed(sig, why, claimKey || null);
      retry.delete(sig);
      if (!row) {
        log.log(`[STAKE] ${String(sig).slice(0, 12)} already settled, nothing owed (${why})`);
        return 'settled';
      }
      log.log(`[STAKE] REFUND owed ${row.amount_sol} -> ${String(row.wallet_address).slice(0, 8)} row ${row.id} (${why})`);
      try { kickDrain(); } catch (_) {}
      return 'owed';
    } catch (e) {
      retry.set(sig, { sig, reason: why, claimKey: claimKey || null });
      log.error(`[STAKE] CRITICAL refund of ${String(sig).slice(0, 12)} not recorded yet, retrying: ${e && e.message}`);
      return 'queued';
    }
  }

  async function retryQueued() {
    for (const q of [...retry.values()]) await refund(q.sig, q.reason, q.claimKey);
    return retry.size;
  }

  /* The boot sweep (boot true: this region's rows from earlier boots, and stale rows) and the
     periodic one (stale rows only, once a boot sweep has gone through). */
  async function sweep({ boot = false } = {}) {
    const own = boot || !bootSwept;
    let rows;
    try {
      rows = await db.listUnsettledStakes({ region: own ? region : null, bootId, staleSeconds: Math.round(staleMs / 1000), limit: 500 });
    } catch (e) {
      log.error('[STAKE] sweep could not read the stakes: ' + (e && e.message));
      return { found: 0, owed: 0, ok: false };
    }
    let owed = 0;
    for (const r of rows) {
      const mine = r.region === region && r.boot_id !== bootId;
      const why = 'refund unspent entry ' + (r.label || '') + (mine ? ' (the server restarted before the join)' : ' (never joined)');
      if ((await refund(r.sig, why, null)) === 'owed') owed++;
    }
    if (own) bootSwept = true;
    await retryQueued();
    if (rows.length) log.warn(`[STAKE] ${boot ? 'boot' : 'periodic'} sweep: ${rows.length} unspent stake(s), ${owed} refund(s) owed`);
    return { found: rows.length, owed, ok: true };
  }

  return { record, claimSeat, refund, retryQueued, sweep, get queued() { return retry.size; }, bootId, region };
}

module.exports = { createStakeLedger };
