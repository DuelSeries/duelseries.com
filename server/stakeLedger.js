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
   played. Dependencies are injected, so the tests run it against a model of the database.

   Before any of that, the pending-verify claim (security review 2026-10-15, findings 3 and 5):

     (nothing) --submit-stake, BEFORE it broadcasts the signed bytes--> verifying
     verifying --that request verified the stake (record)-------------> pending
     verifying --the sweep: it landed and nobody verified it----------> pending --refund--> refunded
     verifying --the sweep: never landed (blockhash expired), failed,
                 or paid less than it was for-------------------------> expired | failed | rejected
     verifying --the request: the node refused its bytes at preflight--> expired   (unsent, 2026-10-29)

   The request used to broadcast first and write the row only after verifying, so a stake that
   landed after the request had already failed (a status read that threw, the confirm timeout, a
   lagging node, a restart mid-request on every deploy) had no row, no token and no refund; and
   whoever posted a stake's bytes first was minted its token. Now the row exists, keyed by the
   signature read from the bytes, before anything is sent: a second submit of the same bytes is
   refused unsent, and a stake whose request did not finish is refunded by the sweep to the payer
   the chain shows, never minted late. The request and the sweep settle a row through the same
   conditional UPDATE (state = 'verifying'), so exactly one of them wins. */

function createStakeLedger({ db, region, bootId, log = console, kickDrain = () => {}, staleMs = 30 * 60 * 1000,
                             chain = null, inFlight = () => false, verifyAfterMs = 2 * 60 * 1000, now = () => Date.now() }) {
  // Refunds the database could not take yet (it was unreachable), retried by retryQueued().
  const retry = new Map();   // sig -> { sig, reason, claimKey }
  let bootSwept = false;

  /* /api/submit-stake, BEFORE it broadcasts: the pending-verify row. info is read from the signed
     bytes (Wallet.stakeTxInfo): wallet = the fee payer, blockhash; amount is the least the verify
     must see land, label names the rung or tier. Returns { claimed, durable }: claimed false means
     this signature has a row already (nothing may be sent); durable false (old database, or a
     stub) means nothing was written and record() makes the old claim after the verify. */
  async function preclaim(sig, { wallet, amount, label, blockhash } = {}) {
    if (typeof db.claimStakeVerify !== 'function') return { claimed: true, durable: false };
    const r = await db.claimStakeVerify(sig, { wallet, amount, label, region, bootId, blockhash });
    const claimed = !!(r && r.claimed);
    return { claimed, durable: claimed && !!r.durable };
  }

  /* /api/submit-stake, when the node refused this request's own bytes at preflight (night review
     2026-10-29, finding 23; Wallet.submitStake sets e.stakeUnsent): nothing was forwarded and only
     this server sends stakes, so they can never land. Its row is closed 'expired' at once, the state
     the sweep would give it minutes later, instead of queueing, oldest first, ahead of real late
     stakes. Only a row this request wrote (preclaim durable). Never rejects. */
  async function unsent(sig) {
    if (typeof db.closeStakeVerify !== 'function') return false;
    try {
      return !!(await db.closeStakeVerify(sig, 'expired'));
    } catch (e) {
      log.warn(`[STAKE] ${String(sig).slice(0, 12)} refused unsent, left for the sweep: ${e && e.message}`);
      return false;
    }
  }

  /* /api/submit-stake, after the stake is verified. amount is what a refund pays (what landed,
     capped at the rung). Returns { claimed, durable }: claimed false means the signature was
     used already; durable false (old database, or a stub) means the token works exactly as it
     did before this change, memory only. preclaimed: this request wrote the pending-verify row
     (preclaim durable), so the claim is that row's 'verifying' -> 'pending'; false only if the
     sweep settled it first. */
  async function record(sig, { wallet, amount, label, preclaimed = false } = {}) {
    if (preclaimed && typeof db.confirmStakeVerify === 'function') {
      const r = await db.confirmStakeVerify(sig, { wallet, amount, label });
      const claimed = !!(r && r.claimed);
      return { claimed, durable: claimed && !!r.durable };
    }
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
    const out = { found: rows.length, owed, ok: true };
    if (chain) out.verify = await sweepVerifying();
    return out;
  }

  /* The pending-verify sweep, run with every sweep (at boot and every 5 minutes) when a chain is
     given. It looks at 'verifying' rows older than verifyAfterMs (their request has given up) and
     at rows an earlier boot of this region's server wrote (their request died with it), skipping
     any this process is still working on (inFlight). chain: { status(sig) -> 'landed' | 'failed' |
     null, blockhashValid(blockhash) -> boolean, owed(row) -> { payer, amount } or { reject } }.
     A chain read that throws leaves the row for the next sweep. Never rejects. */
  async function sweepVerifying() {
    const out = { found: 0, owed: 0, closed: 0, waiting: 0, ok: true };
    if (!chain || typeof db.listStakeVerifies !== 'function') return out;
    let rows;
    try {
      rows = await db.listStakeVerifies({ region, bootId, olderThanSeconds: Math.round(verifyAfterMs / 1000), limit: 50 });
    } catch (e) {
      log.error('[STAKE] pending-verify sweep could not read the rows: ' + (e && e.message));
      return { ...out, ok: false };
    }
    out.found = rows.length;
    for (const r of rows) {
      if (inFlight(r.sig)) { out.waiting++; continue; }
      let res;
      try {
        res = await settleVerifying(r);
      } catch (e) {
        res = 'waiting';
        log.warn(`[STAKE] pending-verify ${String(r.sig).slice(0, 12)} not settled yet: ${e && e.message}`);
      }
      if (res === 'owed') out.owed++;
      else if (res === 'closed') out.closed++;
      else if (res === 'waiting') out.waiting++;
    }
    if (rows.length) log.warn(`[STAKE] pending-verify sweep: ${rows.length} row(s), ${out.owed} refund(s) owed, ${out.closed} closed, ${out.waiting} waiting`);
    return out;
  }

  async function settleVerifying(r) {
    const tag = String(r.sig).slice(0, 12);
    const status = await chain.status(r.sig);
    if (status === 'failed') {
      return (await db.closeStakeVerify(r.sig, 'failed')) ? 'closed' : 'settled';
    }
    if (status === 'landed') {
      // What the chain says landed, to whom; a refund pays that, capped at what it was for.
      const o = await chain.owed(r);
      const amount = o ? Number(o.amount) : 0;
      if (!o || o.reject || typeof o.payer !== 'string' || !o.payer || !(amount > 0)) {
        log.warn(`[STAKE] pending-verify ${tag} landed but nothing is owed (${(o && o.reject) || 'no amount'}): closed`);
        return (await db.closeStakeVerify(r.sig, 'rejected')) ? 'closed' : 'settled';
      }
      if (r.wallet_address && r.wallet_address !== o.payer) {
        log.error(`[STAKE] pending-verify ${tag}: the bytes named payer ${String(r.wallet_address).slice(0, 8)} but the chain shows ${o.payer.slice(0, 8)}; refunding the chain's payer`);
      }
      // Same UPDATE the request's own record() makes: if the request got there first, it minted.
      const c = await db.confirmStakeVerify(r.sig, { wallet: o.payer, amount, label: r.label });
      if (!c || !c.claimed || !c.durable) return 'settled';
      const why = `refund ${r.label || 'stake'} that landed after its submit failed (no token was minted)`;
      const res = await refund(r.sig, why, null);
      return (res === 'owed' || res === 'queued') ? 'owed' : 'settled';
    }
    // Not seen on the chain. Closed only once it can never land: its blockhash has expired (asked
    // of the finalized bank) and a second look still does not find it. Never before it is 3 minutes
    // old: a row an earlier boot left seconds after its broadcast can still be settling, and a
    // blockhash younger than the finalized root reads as invalid there.
    const age = now() - new Date(r.created_at).getTime();
    if (!(Number.isFinite(age) && age >= Math.max(verifyAfterMs, 3 * 60 * 1000))) return 'waiting';
    if (!r.blockhash) {
      const created = new Date(r.created_at).getTime();
      if (!(Number.isFinite(created) && now() - created > 15 * 60 * 1000)) return 'waiting';
    } else if (await chain.blockhashValid(r.blockhash)) {
      return 'waiting';
    }
    if ((await chain.status(r.sig)) !== null) return 'waiting';   // landed meanwhile: the next sweep
    return (await db.closeStakeVerify(r.sig, 'expired')) ? 'closed' : 'settled';
  }

  return { preclaim, unsent, record, claimSeat, refund, retryQueued, sweep, sweepVerifying,
           get queued() { return retry.size; }, bootId, region };
}

module.exports = { createStakeLedger };
