'use strict';
/* In-memory model of the durable stake rows and the payout lanes in server/db.js (STATUS items 7a
   and 7b), for scripts/dev-local.js and the tests. There is no Postgres on the dev machine, so
   this mirrors each SQL statement's rule one for one, and each call applies its whole rule in one
   synchronous step after an await, which is what a single UPDATE (row lock, then the WHERE checked
   again against the committed row) gives in Postgres under READ COMMITTED:

   claimStakeSig      INSERT ... ON CONFLICT DO NOTHING (state 'pending' when the record is given)
   claimStakeSeat     UPDATE ... WHERE state = 'pending' OR (state = 'consumed' AND claim_key = $2)
   refundStakeOwed    WITH s AS (UPDATE ... 'refunded' WHERE pending, or consumed by this key)
                      INSERT INTO failed_payouts ... ; failed_payouts.stake_sig is UNIQUE
   listUnsettledStakes  SELECT ... WHERE state = 'pending' AND (own region, other boot) OR stale
   claimDuePayout     the two lanes; deferPayoutNoAccount, returnPayoutToLane, markPayoutPaid
   migratePayoutLanes the boot-time UPDATE at the end of PAYOUT_LANE_DDL

   `latency(name)` (optional) returns how many turns of the event loop a call waits before it
   applies, so a test can interleave a door and a sweep in any order. `now()` is injectable. */

const NO_USDC_ACCOUNT = 'recipient-no-usdc-account';

function createMemLedgerDb({ now = () => Date.now(), latency = null } = {}) {
  const stakes = new Map();     // sig -> row
  const payouts = [];           // failed_payouts rows
  let nextId = 1;

  const wait = async (name) => {
    const turns = latency ? latency(name) : 0;
    for (let i = 0; i < turns; i++) await new Promise((r) => setImmediate(r));
    await Promise.resolve();
  };

  function seedStake(row) {
    stakes.set(row.sig, Object.assign({ state: 'pending', claim_key: null, created_at: now(), settled_at: null }, row));
  }

  async function claimStakeSig(sig, meta) {
    await wait('claimStakeSig');
    if (stakes.has(sig)) return { claimed: false, durable: false };
    const amount = meta ? Number(meta.amount) : 0;
    if (meta && typeof meta.wallet === 'string' && meta.wallet && Number.isFinite(amount) && amount > 0) {
      seedStake({ sig, state: 'pending', wallet_address: meta.wallet, refund_amount: amount,
                  label: String(meta.label || '').slice(0, 100), region: meta.region || null, boot_id: meta.bootId || null });
      return { claimed: true, durable: true };
    }
    stakes.set(sig, { sig, state: null, created_at: now() });
    return { claimed: true, durable: false };
  }

  async function markStakeSig(sig) {
    return (await claimStakeSig(sig, null)).claimed;
  }

  async function claimStakeSeat(sig, claimKey) {
    await wait('claimStakeSeat');
    const r = stakes.get(sig);
    const key = String(claimKey);
    if (!r || !(r.state === 'pending' || (r.state === 'consumed' && r.claim_key === key))) return false;
    r.state = 'consumed'; r.claim_key = key; r.settled_at = now();
    return true;
  }

  async function refundStakeOwed(sig, reason, claimKey) {
    await wait('refundStakeOwed');
    const r = stakes.get(sig);
    const key = claimKey ? String(claimKey) : null;
    if (!r || !r.wallet_address || !(Number(r.refund_amount) > 0)) return null;
    if (!(r.state === 'pending' || (key !== null && r.state === 'consumed' && r.claim_key === key))) return null;
    if (payouts.some((p) => p.stake_sig === sig)) {
      const e = new Error('duplicate key value violates unique constraint "failed_payouts_stake_sig_uniq"');
      e.code = '23505';
      throw e;                                     // the whole statement fails: the UPDATE too
    }
    r.state = 'refunded'; r.settled_at = now();
    const row = newPayout(r.wallet_address, Number(r.refund_amount), 'Player', String(reason || 'refund').slice(0, 500));
    row.stake_sig = sig;
    return { id: row.id, wallet_address: row.wallet_address, amount_sol: row.amount_sol };
  }

  async function listUnsettledStakes({ region = null, bootId = null, staleSeconds = 1800, limit = 200 } = {}) {
    await wait('listUnsettledStakes');
    const cutoff = now() - staleSeconds * 1000;
    return [...stakes.values()]
      .filter((r) => r.state === 'pending'
        && ((region !== null && r.region === region && r.boot_id !== bootId) || r.created_at < cutoff))
      .sort((a, b) => a.created_at - b.created_at)
      .slice(0, limit)
      .map((r) => ({ sig: r.sig, wallet_address: r.wallet_address, refund_amount: Number(r.refund_amount),
                     label: r.label, region: r.region, boot_id: r.boot_id, created_at: r.created_at }));
  }

  function newPayout(wallet, amount, name, reason) {
    const row = { id: nextId++, wallet_address: wallet, amount_sol: amount, name: name || null, reason,
                  paid: false, paid_sig: null, attempts: 0, last_attempt_at: null, signature: null, signed_tx: null,
                  blockhash: null, last_valid_block_height: null, missing_account: false, account_waits: 0,
                  next_attempt_at: null, stake_sig: null, created_at: now(), seq: nextId };
    payouts.push(row);
    return row;
  }

  async function recordFailedPayout(wallet, amount, name, reason, broadcast) {
    await wait('recordFailedPayout');
    const b = broadcast || {};
    const row = newPayout(wallet, amount, name, (reason || '').slice(0, 500));
    Object.assign(row, { signature: b.signature || null, signed_tx: b.signedTx || null, blockhash: b.blockhash || null,
                         last_valid_block_height: b.lastValidBlockHeight || null });
    if (row.reason.includes(NO_USDC_ACCOUNT)) {
      row.missing_account = true; row.account_waits = 1; row.next_attempt_at = now() + 120 * 1000;
    }
  }

  const byAge = (a, b) => (a.created_at - b.created_at) || (a.seq - b.seq);

  async function claimDuePayout(retrySeconds = 30, maxAttempts = 200, lane = 'normal') {
    await wait('claimDuePayout');
    const t = now();
    let row;
    if (lane === 'slow') {
      row = payouts.filter((p) => !p.paid && p.missing_account === true && (p.next_attempt_at === null || p.next_attempt_at <= t))
        .sort((a, b) => ((a.next_attempt_at === null ? -Infinity : a.next_attempt_at) - (b.next_attempt_at === null ? -Infinity : b.next_attempt_at)) || byAge(a, b))[0];
      if (!row) return null;
      row.last_attempt_at = t; row.next_attempt_at = t + 600 * 1000;
      return Object.assign({}, row, { lane: 'slow' });
    }
    row = payouts.filter((p) => !p.paid && p.attempts < maxAttempts
        && (p.last_attempt_at === null || p.last_attempt_at < t - retrySeconds * 1000)
        && p.missing_account !== true)
      .sort(byAge)[0];
    if (!row) return null;
    row.attempts += 1; row.last_attempt_at = t;
    return Object.assign({}, row, { lane: 'normal' });
  }

  async function deferPayoutNoAccount(id) {
    await wait('deferPayoutNoAccount');
    const r = payouts.find((p) => p.id === id && !p.paid);
    if (!r) return;
    if (r.missing_account !== true) r.attempts = Math.max(r.attempts - 1, 0);
    const waits = r.account_waits || 0;
    r.missing_account = true;
    r.account_waits = waits + 1;
    r.next_attempt_at = now() + Math.min(3600, 120 * Math.pow(2, Math.min(waits, 5))) * 1000;
  }

  // The last statement of PAYOUT_LANE_DDL, which runs at every boot (db.init).
  async function migratePayoutLanes() {
    await wait('migratePayoutLanes');
    for (const p of payouts) {
      if (!p.paid && p.missing_account !== true && (p.account_waits || 0) === 0 && String(p.reason || '').includes(NO_USDC_ACCOUNT)) {
        p.missing_account = true;
      }
    }
  }

  async function returnPayoutToLane(id) {
    await wait('returnPayoutToLane');
    const r = payouts.find((p) => p.id === id && p.missing_account === true);
    if (r) { r.missing_account = false; r.next_attempt_at = null; r.attempts = 0; r.account_waits = Math.max(r.account_waits || 0, 1); }
  }

  async function savePayoutSignature(id, b) {
    const r = payouts.find((p) => p.id === id);
    if (r) Object.assign(r, { signature: b.signature || null, signed_tx: b.signedTx || null, blockhash: b.blockhash || null,
                              last_valid_block_height: b.lastValidBlockHeight || null });
  }

  async function markPayoutPaid(id, sig) {
    const r = payouts.find((p) => p.id === id);
    if (r) { r.paid = true; r.paid_sig = sig || null; }
  }

  async function getFailedPayouts() {
    return payouts.map((p) => Object.assign({}, p));
  }

  return {
    stakes, payouts, seedStake,
    claimStakeSig, markStakeSig, claimStakeSeat, refundStakeOwed, listUnsettledStakes,
    recordFailedPayout, claimDuePayout, deferPayoutNoAccount, returnPayoutToLane, migratePayoutLanes,
    savePayoutSignature, markPayoutPaid, getFailedPayouts,
    features: { durableStakes: true, payoutLanes: true }, NO_USDC_ACCOUNT,
  };
}

module.exports = { createMemLedgerDb, NO_USDC_ACCOUNT };
