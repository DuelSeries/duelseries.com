'use strict';
/* STATUS item 7b (night queue item 5): the owed-payout drainer never queues honest payouts behind
   rows whose wallet has no USDC account, never drops one of those rows, and never pays a row twice.

   The drainer (server/payoutDrainer.js) runs against scripts/memLedgerDb.js, which applies the two
   lanes' SQL rules (server/db.js claimDuePayout, deferPayoutNoAccount, returnPayoutToLane,
   recordFailedPayout) one step at a time; the SQL text is pinned at the end. Before this change the
   drainer took the 5 oldest due rows every 30 s whatever they were, so 5 or more rows for wallets
   with no account in front held every later payout back indefinitely, and each such row was
   dropped for good after 200 attempts (100 minutes). */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createMemLedgerDb, NO_USDC_ACCOUNT } = require('../scripts/memLedgerDb');
const { createPayoutDrainer } = require('../server/payoutDrainer');

const quiet = { log() {}, warn() {}, error() {} };
const S = 1000;

// A chain: wallets in `noAccount` have no USDC account (the payout throws before signing, as
// Usdc.buildSignedUsdcPayout does); every other payout lands. Every send is recorded.
function chain(noAccount) {
  const sent = [];
  let n = 0;
  const money = {
    unit: 'USDC',
    fiatValue: (a) => a,
    async attemptPayout(row, onFreshTx) {
      if (row.signature) { sent.push({ id: row.id, wallet: row.wallet_address, rebroadcast: row.signature }); return { paid: true, sig: row.signature }; }
      if (noAccount.has(row.wallet_address)) {
        const e = new Error(NO_USDC_ACCOUNT + ': the wallet has no USDC account; paid once it has one again');
        e.code = NO_USDC_ACCOUNT;
        throw e;
      }
      const sig = 'tx' + ++n;
      await onFreshTx({ signature: sig, signedTx: 'b64', blockhash: 'bh', lastValidBlockHeight: 1 });
      sent.push({ id: row.id, wallet: row.wallet_address, amount: row.amount_sol, sig });
      return { paid: true, sig };
    },
  };
  return { money, sent };
}

function setup(noAccountWallets) {
  let t = 1e12;
  const db = createMemLedgerDb({ now: () => t });
  db.recordEarnings = async () => {};
  const { money, sent } = chain(new Set(noAccountWallets));
  const drainer = createPayoutDrainer({ db, money, noAccountCode: NO_USDC_ACCOUNT, log: quiet });
  return { db, drainer, sent, advance: (ms) => { t += ms; }, clock: () => t };
}

async function owe(db, advance, wallet, amount, reason) {
  await db.recordFailedPayout(wallet, amount, 'P', reason);
  advance(10);                              // created_at order is the order they were owed
}

test('rows for wallets with no USDC account never hold up the payouts behind them', async () => {
  const bad = Array.from({ length: 12 }, (_, i) => 'NOACC' + i);
  const w = setup(bad);
  // Twelve refund rows for no-account wallets are owed FIRST (their account state is not known
  // when they are written), then three honest cash-outs.
  for (const b of bad) await owe(w.db, w.advance, b, 0.1, 'refund unspent entry stake 0.1');
  for (const h of ['H1', 'H2', 'H3']) await owe(w.db, w.advance, h, 0.9, 'paper $0.10: rpc 503');
  const out = await w.drainer.drain();
  assert.deepStrictEqual(w.sent.map((x) => x.wallet), ['H1', 'H2', 'H3'], 'the honest rows are paid on the first tick');
  assert.strictEqual(out.normal, 3);
  assert.strictEqual(out.deferred, 12);
  const rows = await w.db.getFailedPayouts();
  for (const r of rows.filter((x) => bad.includes(x.wallet_address))) {
    assert.strictEqual(r.missing_account, true, 'moved to the slow lane');
    assert.strictEqual(r.attempts, 0, 'the look that found no account is not an attempt');
    assert.strictEqual(r.paid, false);
  }
  // From now on the normal lane never even claims them: a new honest row is paid at the next tick.
  w.advance(30 * S);
  await owe(w.db, w.advance, 'H4', 0.5, 'snake $1: timeout');
  await w.drainer.drain();
  assert.deepStrictEqual(w.sent.map((x) => x.wallet), ['H1', 'H2', 'H3', 'H4']);
});

test('a row owed because the wallet has no account starts in the slow lane', async () => {
  const w = setup(['NA1']);
  await owe(w.db, w.advance, 'NA1', 0.9, 'paper $1: ' + NO_USDC_ACCOUNT + ': the wallet has no USDC account; paid once it has one again');
  await owe(w.db, w.advance, 'H', 0.9, 'paper $1: rpc');
  const [r] = await w.db.getFailedPayouts();
  assert.strictEqual(r.missing_account, true);
  assert.ok(r.next_attempt_at > w.clock(), 'first slow try is later');
  await w.drainer.drain();
  assert.deepStrictEqual(w.sent.map((x) => x.wallet), ['H']);
  assert.strictEqual((await w.db.getFailedPayouts())[0].attempts, 0);
});

test('a no-account row is never dropped: it waits with a backoff, past any attempt cap, and is paid once when the account exists', async () => {
  const noAccount = new Set(['LATE']);
  let t = 1e12;
  const db = createMemLedgerDb({ now: () => t });
  db.recordEarnings = async () => {};
  const { money, sent } = chain(noAccount);
  const drainer = createPayoutDrainer({ db, money, noAccountCode: NO_USDC_ACCOUNT, log: quiet });
  await db.recordFailedPayout('LATE', 0.1, 'P', 'refund paper full');
  const gaps = [];
  let lastTry = null;
  const origClaim = db.claimDuePayout;
  db.claimDuePayout = async (...a) => { const r = await origClaim(...a); if (r && r.wallet_address === 'LATE') { if (lastTry !== null) gaps.push(t - lastTry); lastTry = t; } return r; };
  // Three days of 30 s ticks: far past the normal lane's 200 attempts.
  for (let i = 0; i < 3 * 24 * 120; i++) { await drainer.drain(); t += 30 * S; }
  const row = (await db.getFailedPayouts())[0];
  assert.strictEqual(row.paid, false);
  assert.strictEqual(row.missing_account, true);
  assert.ok(row.attempts <= 1, 'the attempt cap was never used up: ' + row.attempts);
  assert.ok(gaps.length > 60 && gaps.length < 90, 'retried on a backoff, not every tick: ' + gaps.length);
  assert.deepStrictEqual(gaps.slice(0, 5).map((g) => Math.round(g / 60000)), [2, 4, 8, 16, 32]);
  assert.ok(gaps.slice(6).every((g) => g >= 60 * 60 * S && g <= 61 * 60 * S), 'then hourly');
  // The player opens a USDC account: the next slow try pays it, once, and it is never claimed again.
  noAccount.delete('LATE');
  for (let i = 0; i < 200; i++) { await drainer.drain(); t += 30 * S; }
  assert.strictEqual(sent.filter((x) => x.wallet === 'LATE').length, 1);
  assert.strictEqual((await db.getFailedPayouts())[0].paid, true);
});

test('a slow-lane row whose payout then fails for another reason goes back to the normal lane, and its tx is never built twice', async () => {
  let t = 1e12;
  const db = createMemLedgerDb({ now: () => t });
  db.recordEarnings = async () => {};
  const built = [];
  let phase = 'noacc';
  const money = {
    unit: 'USDC', fiatValue: (a) => a,
    async attemptPayout(row, onFreshTx) {
      if (phase === 'noacc') { const e = new Error(NO_USDC_ACCOUNT); e.code = NO_USDC_ACCOUNT; throw e; }
      if (row.signature) return { paid: true, sig: row.signature };        // the same bytes land
      built.push(row.id);
      await onFreshTx({ signature: 'only-tx', signedTx: 'b64', blockhash: 'bh', lastValidBlockHeight: 1 });
      return { paid: false };                                              // sent, not confirmed in time
    },
  };
  const drainer = createPayoutDrainer({ db, money, noAccountCode: NO_USDC_ACCOUNT, log: quiet });
  await db.recordFailedPayout('W', 0.9, 'P', 'paper: rpc');
  await drainer.drain();
  assert.strictEqual(db.payouts[0].missing_account, true);
  phase = 'account-now';
  t += 3 * 60 * S;
  await drainer.drain();
  assert.strictEqual(db.payouts[0].missing_account, false, 'back to the normal lane');
  assert.strictEqual(db.payouts[0].signature, 'only-tx');
  t += 31 * S;
  await drainer.drain();
  assert.strictEqual(db.payouts[0].paid, true);
  assert.deepStrictEqual(built, [1], 'one transaction was ever built for the row');
});

test('the slow lane has its own budget: it runs after the normal lane and cannot take its turns', async () => {
  const bad = Array.from({ length: 30 }, (_, i) => 'B' + i);
  const w = setup(bad);
  for (const b of bad) await owe(w.db, w.advance, b, 0.1, 'x: ' + NO_USDC_ACCOUNT);
  w.advance(5 * 60 * S);                                  // all 30 are due in the slow lane
  const honest = Array.from({ length: 7 }, (_, i) => 'OK' + i);
  for (const h of honest) await owe(w.db, w.advance, h, 1, 'cashout: rpc');
  let claimsSlow = 0;
  const orig = w.db.claimDuePayout;
  w.db.claimDuePayout = async (a, b, lane) => { const r = await orig(a, b, lane); if (r && lane === 'slow') claimsSlow++; return r; };
  const out = await w.drainer.drain();
  assert.deepStrictEqual(w.sent.map((x) => x.wallet), honest.slice(0, 5), 'the normal lane pays its 5 first');
  assert.strictEqual(out.slow, 5);
  assert.strictEqual(claimsSlow, 5);
  w.advance(31 * S);
  await w.drainer.drain();
  assert.deepStrictEqual(w.sent.map((x) => x.wallet), honest, 'and the rest next tick');
});

/* Rows owed before the lanes existed (review of 5e6cb3f). The old drainer counted every look at a
   wallet with no USDC account as an attempt, so a row can reach the migration at or near the
   200-attempt cap (it gave up at 200), and the same happens to a row that reached the cap while
   the lanes were off. The migration moves it to the slow lane, which has no cap. Once the account
   exists, a slow-lane payout that does not confirm in time, or fails for another reason, sends the
   row back to the normal lane; it used to keep its old count there, so the normal lane (attempts
   < 200) never took it again: a payout never retried, or a tx that landed later with the row still
   showing unpaid. A row back from the slow lane now starts a fresh normal-lane budget. */
function preLaneRow(db, t, attempts) {
  db.payouts.push({ id: 1, wallet_address: 'OLD', amount_sol: 0.9, name: 'P',
    reason: 'paper $1: ' + NO_USDC_ACCOUNT + ': the wallet has no USDC account; paid once it has one again',
    paid: false, paid_sig: null, attempts, last_attempt_at: t - 3600 * S, signature: null, signed_tx: null,
    blockhash: null, last_valid_block_height: null, missing_account: false, account_waits: 0,
    next_attempt_at: null, stake_sig: null, created_at: t - 86400 * S, seq: 1 });
}

// The account exists now. The first `fails` payout attempts do not finish (mode 'pending': a tx is
// built and sent but not confirmed in time, then its same bytes are re-sent; mode 'error': the call
// throws, e.g. escrow USDC too low), after that the payout lands. One tx is ever built.
function lateChain(mode, fails) {
  const built = [];
  let calls = 0;
  const money = {
    unit: 'USDC', fiatValue: (a) => a,
    async attemptPayout(row, onFreshTx) {
      calls++;
      const ok = calls > fails;
      if (!ok && mode === 'error') throw new Error('Escrow USDC too low');
      if (row.signature) return ok ? { paid: true, sig: row.signature } : { paid: false };
      built.push(row.id);
      await onFreshTx({ signature: 'S1', signedTx: 'b64', blockhash: 'bh', lastValidBlockHeight: 1 });
      return ok ? { paid: true, sig: 'S1' } : { paid: false };
    },
  };
  return { money, built, calls: () => calls };
}

for (const [attempts, mode] of [[200, 'pending'], [200, 'error'], [199, 'pending'], [150, 'error']]) {
  test(`a pre-lane row at ${attempts} attempts whose slow-lane payout ${mode === 'pending' ? 'did not confirm' : 'threw'} is retried in the normal lane and paid once`, async () => {
    let t = 1e12;
    const db = createMemLedgerDb({ now: () => t });
    db.recordEarnings = async () => {};
    preLaneRow(db, t, attempts);
    await db.migratePayoutLanes();
    assert.strictEqual(db.payouts[0].missing_account, true, 'the migration moved it to the slow lane');
    const c = lateChain(mode, 3);
    const drainer = createPayoutDrainer({ db, money: c.money, noAccountCode: NO_USDC_ACCOUNT, log: quiet });
    for (let i = 0; i < 2880; i++) { await drainer.drain(); t += 30 * S; }     // one day of ticks
    const row = db.payouts[0];
    assert.strictEqual(row.paid, true, 'paid: ' + JSON.stringify({ calls: c.calls(), attempts: row.attempts, missing_account: row.missing_account }));
    assert.strictEqual(row.paid_sig, 'S1');
    assert.strictEqual(c.calls(), 4, 'one slow-lane try, two more that did not finish, then paid, and never tried again');
    assert.deepStrictEqual(c.built, [1], 'one transaction was ever built for the row');
    assert.strictEqual(row.missing_account, false);
  });
}

test('a pre-lane row that went back to the normal lane stays there when a later boot runs the migration again', async () => {
  let t = 1e12;
  const db = createMemLedgerDb({ now: () => t });
  db.recordEarnings = async () => {};
  preLaneRow(db, t, 200);
  await db.migratePayoutLanes();
  const c = lateChain('pending', 1e9);
  const drainer = createPayoutDrainer({ db, money: c.money, noAccountCode: NO_USDC_ACCOUNT, log: quiet });
  await drainer.drain();
  assert.strictEqual(db.payouts[0].missing_account, false, 'back to the normal lane');
  assert.strictEqual(db.payouts[0].attempts, 0, 'with a fresh normal-lane budget');
  t += 31 * S;
  await drainer.drain();
  assert.strictEqual(db.payouts[0].attempts, 1, 'the normal lane takes it');
  await db.migratePayoutLanes();            // a push restarts the server and db.init runs the DDL again
  assert.strictEqual(db.payouts[0].missing_account, false, 'the migration moves a row once, not at every boot');
  assert.strictEqual(db.payouts[0].attempts, 1, 'and its count is not reset again');
});

test('db.js: the lanes\' SQL, and the no-account marker agrees with Usdc.js', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'db.js'), 'utf8');
  const fn = (name) => src.slice(src.indexOf('async function ' + name), src.indexOf('\n}\n', src.indexOf('async function ' + name)));
  const claim = fn('claimDuePayout');
  assert.match(claim, /WHERE paid = false AND missing_account IS TRUE\s*AND \(next_attempt_at IS NULL OR next_attempt_at <= NOW\(\)\)/);
  assert.match(claim, /\$\{features\.payoutLanes \? 'AND missing_account IS NOT TRUE' : ''\}/);
  assert.match(claim, /LIMIT 1 FOR UPDATE SKIP LOCKED/);
  assert.match(fn('deferPayoutNoAccount'), /LEAST\(3600, 120 \* POWER\(2, LEAST\(COALESCE\(account_waits, 0\), 5\)\)\)/);
  assert.match(fn('recordFailedPayout'), /features\.payoutLanes && why\.includes\(NO_USDC_ACCOUNT\)/);
  assert.match(fn('returnPayoutToLane'),
    /SET missing_account = false, next_attempt_at = NULL,\s*attempts = 0, account_waits = GREATEST\(COALESCE\(account_waits, 0\), 1\)\s*WHERE id = \$1 AND missing_account IS TRUE/);
  // The migration memLedgerDb.migratePayoutLanes models.
  assert.match(src, /UPDATE failed_payouts SET missing_account = true\s*WHERE paid = false AND missing_account IS NOT TRUE AND COALESCE\(account_waits, 0\) = 0\s*AND reason LIKE '%\$\{NO_USDC_ACCOUNT\}%'`,\s*\];/);
  const Usdc = require('../server/Usdc');
  const db = require('../server/db');
  assert.strictEqual(db.NO_USDC_ACCOUNT, Usdc.RECIPIENT_NO_USDC_ACCOUNT);
  assert.strictEqual(NO_USDC_ACCOUNT, Usdc.RECIPIENT_NO_USDC_ACCOUNT);
  const idx = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(idx, /createPayoutDrainer\(\{\s*db,\s*money,\s*noAccountCode: Usdc\.RECIPIENT_NO_USDC_ACCOUNT/);
  assert.doesNotMatch(idx, /db\.claimDuePayout\(/, 'index.js has no drainer loop of its own any more');
});
