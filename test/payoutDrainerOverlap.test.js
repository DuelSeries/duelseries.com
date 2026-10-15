'use strict';
/* Security review 2026-10-15, "drainer double pay" (finder-2 #2, refute-core #2).

   The normal lane's claim of an owed row is a 30 s lease. Building a fresh payout makes three RPC
   reads, each retried with backoff, so under rate limiting a build can take longer than 30 s.
   Before the fix a second drain (the next 30 s tick, or a refund kick) claimed the same row, which
   still had no saved signature, built its own transaction with a different blockhash, overwrote
   the first one's saved signature, and both runs sent: two real transfers for one owed row.

   Here the REAL attemptPayout (server/Usdc.js, and server/Wallet.js for SOL mode) runs against a
   stubbed connection whose getLatestBlockhash resolves only when the test says so, over
   scripts/memLedgerDb.js, which applies the 30 s lease and the compare-and-set exactly as the SQL
   does. A transaction counts as sent when sendRawTransaction receives it. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Keypair, PublicKey } = require('@solana/web3.js');
const { AccountLayout, ACCOUNT_SIZE, TOKEN_PROGRAM_ID } = require('@solana/spl-token');

// A throwaway escrow and an address that is never called, before the money modules load.
const escrow = Keypair.generate();
process.env.ESCROW_PRIVATE_KEY = Buffer.from(escrow.secretKey).toString('base64');
process.env.ESCROW_PUBLIC_KEY = '';
process.env.RPC_URL = 'https://rpc.invalid/never-called';
process.env.SOLANA_NETWORK = 'devnet';

const _bs58 = require('bs58');
const bs58 = (_bs58 && _bs58.default) ? _bs58.default : _bs58;
const Usdc = require('../server/Usdc');
const Wallet = require('../server/Wallet');
const { createMemLedgerDb, NO_USDC_ACCOUNT } = require('../scripts/memLedgerDb');
const { createPayoutDrainer, SUPERSEDED } = require('../server/payoutDrainer');

const quiet = { log() {}, warn() {}, error() {} };
const S = 1000;
const WALLET = Keypair.generate().publicKey.toBase58();
const tick = () => new Promise((r) => setImmediate(r));
async function until(fn, n = 200) { for (let i = 0; i < n && !fn(); i++) await tick(); assert.ok(fn(), 'condition never held'); }

function tokenAccount(owner, amount) {
  const data = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode({ mint: Usdc.USDC_MINT, owner, amount: BigInt(amount), delegateOption: 0, delegate: PublicKey.default,
    state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
  return { data, owner: TOKEN_PROGRAM_ID, lamports: 2039280, executable: false, rentEpoch: 0 };
}

/* The chain: every account exists and escrow is rich; a blockhash is handed out only when the test
   releases it (the slow build); every transaction sent lands at once. */
function stubChain(conn) {
  const sent = [];
  const gates = [];
  const landed = new Set();
  conn.getAccountInfo = async (addr) => tokenAccount(new PublicKey(addr), 1_000_000_000n);
  conn.getBalance = async () => 1_000 * 1e9;
  conn.getMinimumBalanceForRentExemption = async () => 890880;
  conn.getLatestBlockhash = () => new Promise((resolve) => gates.push(resolve));
  conn.getBlockHeight = async () => 10;
  conn.sendRawTransaction = async (raw) => {
    const sig = bs58.encode(Buffer.from(raw).subarray(1, 65));
    sent.push(sig);
    landed.add(sig);
    return sig;
  };
  conn.getSignatureStatus = async (sig) => ({ value: landed.has(sig) ? { confirmationStatus: 'confirmed', err: null } : null });
  const release = (i) => gates[i]({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1000 });
  return { sent, gates, release };
}

function setup(attempt, { oldSave = false } = {}) {
  let t = 1e12;
  const db = createMemLedgerDb({ now: () => t });
  db.recordEarnings = async () => {};
  if (oldSave) {
    // The save as it was before the fix: an unconditional UPDATE, last writer wins.
    db.savePayoutSignature = async (id, b) => {
      const r = db.payouts.find((p) => p.id === id);
      if (r) Object.assign(r, { signature: b.signature, signed_tx: b.signedTx, blockhash: b.blockhash, last_valid_block_height: b.lastValidBlockHeight });
    };
  }
  const money = { unit: 'USDC', fiatValue: (a) => a, attemptPayout: attempt };
  const errors = [];
  const make = (opts = {}) => createPayoutDrainer({ db, money, noAccountCode: NO_USDC_ACCOUNT,
    log: { ...quiet, error: (m) => errors.push(m) }, now: () => t, ...opts });
  return { db, make, errors, advance: (ms) => { t += ms; } };
}

const usdcAttempt = (row, fn) => Usdc.attemptPayout(row, fn);
const solAttempt = (row, fn) => Wallet.attemptPayout(row, fn);

for (const [mode, conn, attempt] of [['USDC', Usdc.connection, usdcAttempt], ['SOL', Wallet.connection, solAttempt]]) {
  test(`${mode}: a tick and a kick during a build that outlasts the 30 s lease start no second drain, and the row is paid once`, async () => {
    const chain = stubChain(conn);
    const w = setup(attempt);
    await w.db.recordFailedPayout(WALLET, 0.5, 'P', 'refund unspent entry stake 0.5');   // no signature yet
    const drainer = w.make();
    const first = drainer.drain();
    await until(() => chain.gates.length === 1);                 // the build is waiting on the RPC
    w.advance(31 * S);                                           // the claim's lease has run out
    const tickRun = drainer.drain();                             // the next 30 s tick
    const kickRun = drainer.drain();                             // a refund kick
    assert.strictEqual(tickRun, kickRun, 'the tick and the kick share one follow-up run');
    for (let i = 0; i < 20; i++) await tick();
    assert.strictEqual(chain.gates.length, 1, 'no second build started beside the first');
    assert.strictEqual(w.db.payouts[0].attempts, 1, 'and the row was not claimed a second time');
    chain.release(0);
    await first;
    await tickRun;
    assert.strictEqual(drainer.running, false);
    assert.strictEqual(chain.sent.length, 1, 'one transaction sent: ' + chain.sent.join(', '));
    assert.strictEqual(w.db.payouts[0].paid, true);
    assert.strictEqual(w.db.payouts[0].paid_sig, chain.sent[0]);
  });

  for (const firstDone of ['A', 'B']) {
    test(`${mode}: two drainers sharing the database (an old and a new process) both claim the row; the compare-and-set lets one send (${firstDone}'s build finishes first)`, async () => {
      const chain = stubChain(conn);
      const w = setup(attempt);
      await w.db.recordFailedPayout(WALLET, 0.5, 'P', 'snake $1: rpc 429');
      const A = w.make(), B = w.make();
      const runA = A.drain();
      await until(() => chain.gates.length === 1);
      w.advance(31 * S);
      const runB = B.drain();
      await until(() => chain.gates.length === 2);
      assert.strictEqual(w.db.payouts[0].attempts, 2, 'the lease ran out and the second process claimed the same row');
      if (firstDone === 'A') { chain.release(0); chain.release(1); } else { chain.release(1); chain.release(0); }
      await Promise.all([runA, runB]);
      assert.strictEqual(chain.sent.length, 1, 'exactly one transfer for the one owed row: ' + chain.sent.join(', '));
      const row = w.db.payouts[0];
      assert.strictEqual(row.signature, chain.sent[0], 'the saved signature is the one that was sent');
      assert.strictEqual(row.paid, true);
      assert.strictEqual(row.paid_sig, chain.sent[0]);
    });
  }

  test(`${mode}: the run guard alone holds one process to one transfer, even with the old unconditional save`, async () => {
    const chain = stubChain(conn);
    const w = setup(attempt, { oldSave: true });
    await w.db.recordFailedPayout(WALLET, 0.5, 'P', 'refund unspent entry stake 0.5');
    const drainer = w.make();
    const first = drainer.drain();
    await until(() => chain.gates.length === 1);
    w.advance(31 * S);
    const again = drainer.drain();
    for (let i = 0; i < 20; i++) await tick();
    chain.release(0);
    await first; await again;
    assert.strictEqual(chain.gates.length, 1);
    assert.strictEqual(chain.sent.length, 1);
  });

  test(`${mode}: the harness catches the bug: with the old unconditional save and no run guard, the same race sends two transfers`, async () => {
    const chain = stubChain(conn);
    const w = setup(attempt, { oldSave: true });
    await w.db.recordFailedPayout(WALLET, 0.5, 'P', 'snake $1: rpc 429');
    const A = w.make(), B = w.make();
    const runA = A.drain();
    await until(() => chain.gates.length === 1);
    w.advance(31 * S);
    const runB = B.drain();
    await until(() => chain.gates.length === 2);
    chain.release(0); chain.release(1);
    await Promise.all([runA, runB]);
    assert.strictEqual(new Set(chain.sent).size, 2, 'two different transactions were sent for one row');
  });
}

test('a run stuck on an RPC call that never answers does not stop payouts for good, and the row is still paid once', async () => {
  const chain = stubChain(Usdc.connection);
  const w = setup(usdcAttempt);
  await w.db.recordFailedPayout(WALLET, 0.5, 'P', 'snake $1: rpc');
  await w.db.recordFailedPayout(Keypair.generate().publicKey.toBase58(), 0.9, 'Q', 'snake $1: rpc');
  const drainer = w.make({ stallMs: 10 * 60 * S });
  const stuck = drainer.drain();
  await until(() => chain.gates.length === 1);                  // first row's build: never answers
  w.advance(5 * 60 * S);
  drainer.drain();
  for (let i = 0; i < 20; i++) await tick();
  assert.strictEqual(chain.gates.length, 1, 'five minutes in: still one run');
  w.advance(6 * 60 * S);                                        // past the stall limit
  const fresh = drainer.drain();
  assert.match(w.errors.join('\n'), /a drain has run for over 10 min/);
  // The new run claims the first row again (its lease is long gone) and builds: release it, and
  // the second row's build too.
  await until(() => chain.gates.length === 2);
  chain.release(1);
  await until(() => chain.gates.length === 3);
  chain.release(2);
  await fresh;
  assert.strictEqual(chain.sent.length, 2, 'both rows paid by the new run');
  assert.ok(w.db.payouts.every((p) => p.paid));
  // The stuck call finally answers: its row was paid meanwhile, so it sends nothing.
  chain.release(0);
  await stuck;
  assert.strictEqual(chain.sent.length, 2, 'still one transfer per row: ' + chain.sent.join(', '));
});

test('a row whose saved tx expired: the rebuild is compared against that old signature, and a second rebuild sends nothing', async () => {
  const chain = stubChain(Usdc.connection);
  Usdc.connection.getBlockHeight = async () => 5000;            // past the old tx's last valid height
  const w = setup(usdcAttempt);
  await w.db.recordFailedPayout(WALLET, 0.9, 'P', 'snake $1: timeout',
    { signature: 'OLDSIG', signedTx: 'AA==', blockhash: 'bh', lastValidBlockHeight: 100 });
  const A = w.make(), B = w.make();
  const runA = A.drain();
  await until(() => chain.gates.length === 1);
  w.advance(31 * S);
  const runB = B.drain();
  await until(() => chain.gates.length === 2);
  chain.release(0); chain.release(1);
  await Promise.all([runA, runB]);
  assert.strictEqual(chain.sent.length, 1, chain.sent.join(', '));
  assert.strictEqual(w.db.payouts[0].paid_sig, chain.sent[0]);
});

test('a superseded attempt is reported as such, and the drainer moves on without an error', async () => {
  let t = 1e12;
  const db = createMemLedgerDb({ now: () => t });
  db.recordEarnings = async () => {};
  await db.recordFailedPayout('W', 1, 'P', 'snake: rpc');
  // Someone else saved a tx for the row between this attempt's claim and its save.
  const money = {
    unit: 'USDC', fiatValue: (a) => a,
    async attemptPayout(row, onFreshTx) {
      db.payouts[0].signature = 'OTHER';
      const saved = await onFreshTx({ signature: 'MINE', signedTx: 'b64', blockhash: 'bh', lastValidBlockHeight: 1 });
      assert.strictEqual(saved, false);
      const e = new Error('superseded'); e.code = Usdc.PAYOUT_SUPERSEDED; throw e;
    },
  };
  const drainer = createPayoutDrainer({ db, money, noAccountCode: NO_USDC_ACCOUNT, log: quiet });
  const row = await db.claimDuePayout(30, 200, 'normal');
  assert.strictEqual(await drainer.tryRow(row), 'superseded');
  assert.strictEqual(db.payouts[0].signature, 'OTHER', 'the other attempt\'s transaction is kept');
  assert.strictEqual(db.payouts[0].paid, false);
});

test('the one error code: payoutDrainer, Usdc and Wallet agree', () => {
  assert.strictEqual(SUPERSEDED, Usdc.PAYOUT_SUPERSEDED);
  assert.strictEqual(SUPERSEDED, Wallet.PAYOUT_SUPERSEDED);
});

test('db.js: savePayoutSignature is a compare-and-set against the signature the row was claimed with', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'db.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function savePayoutSignature'), src.indexOf('\n}\n', src.indexOf('async function savePayoutSignature')));
  assert.match(fn, /WHERE id = \$1 AND paid = false AND signature IS NOT DISTINCT FROM \$6::text/);
  assert.match(fn, /return r\.rowCount > 0;/);
  const db = require('../server/db');
  const seen = [];
  let rowCount = 1;
  db.pool.query = async (sql, params) => { seen.push({ sql, params }); return { rows: [], rowCount }; };
  assert.strictEqual(await db.savePayoutSignature(7, { signature: 'S', signedTx: 'T', blockhash: 'B', lastValidBlockHeight: 9 }, null), true);
  assert.deepStrictEqual(seen[0].params, [7, 'S', 'T', 'B', 9, null]);
  rowCount = 0;
  assert.strictEqual(await db.savePayoutSignature(7, { signature: 'S2' }, 'S'), false);
  assert.deepStrictEqual(seen[1].params.slice(-1), ['S']);
  // The drainer passes the signature the row was claimed with.
  const drainerSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'payoutDrainer.js'), 'utf8');
  assert.match(drainerSrc, /const prev = row\.signature \|\| null;\s*const r = await money\.attemptPayout\(row, \(b\) => db\.savePayoutSignature\(row\.id, b, prev\)\);/);
  // And both attemptPayouts send nothing when it answers false.
  for (const f of ['Usdc.js', 'Wallet.js']) {
    const s = fs.readFileSync(path.join(__dirname, '..', 'server', f), 'utf8');
    const body = s.slice(s.indexOf('async function attemptPayout'));
    const save = body.indexOf('const saved = await onFreshTx(');
    const check = body.indexOf('if (saved === false)');
    const send = body.indexOf('connection.sendRawTransaction(built.raw');
    assert.ok(save > 0 && check > save && send > check, f + ': save, then the check, then the send');
  }
});
