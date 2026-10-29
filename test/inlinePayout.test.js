'use strict';
/* Night review 2026-10-29, finding 3: duel prizes and refunds (koSend) and the old snake cash-out paid with nothing
   saved first, so a restart (every push to main) or a crash mid-payout lost the winnings with no record. Now
   server/inlinePayout.js writes the owed row before anything is signed, saves the signed bytes on it before they are
   sent, and closes it once they landed. Whatever happens, the drainer settles the row exactly once.

   Runs over scripts/memLedgerDb.js (the SQL rules of server/db.js, one step at a time) and, for the crash cases, the
   REAL Wallet.withdraw and Wallet.attemptPayout on a stubbed connection with the real drainer. The SQL is pinned at
   the end. Nothing reaches a network. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Keypair } = require('@solana/web3.js');

const escrow = Keypair.generate();
process.env.ESCROW_PRIVATE_KEY = Buffer.from(escrow.secretKey).toString('base64');
process.env.ESCROW_PUBLIC_KEY = '';
process.env.RPC_URL = 'https://rpc.invalid/never-called';
process.env.SOLANA_NETWORK = 'devnet';

const _bs58 = require('bs58');
const bs58 = (_bs58 && _bs58.default) ? _bs58.default : _bs58;
const Wallet = require('../server/Wallet');
const { createMemLedgerDb, NO_USDC_ACCOUNT } = require('../scripts/memLedgerDb');
const { createPayoutDrainer } = require('../server/payoutDrainer');
const { createInlinePayout, SUPERSEDED } = require('../server/inlinePayout');

const quiet = { log() {}, warn() {}, error() {} };
const S = 1000;
const WALLET = Keypair.generate().publicKey.toBase58();
const LAMPORTS = 4_500_000;
const tick = () => new Promise((r) => setImmediate(r));
async function until(fn, n = 400) { for (let i = 0; i < n && !fn(); i++) await tick(); assert.ok(fn(), 'condition never held'); }

function setup(money) {
  let t = 1e12;
  const db = createMemLedgerDb({ now: () => t });
  const earned = [];
  db.recordEarnings = async (w, name, amount) => { earned.push([w, name, amount]); };
  const kicks = [];
  const inline = createInlinePayout({ money, db, kickDrain: () => kicks.push(1), log: quiet });
  const drainer = createPayoutDrainer({ db, money, noAccountCode: NO_USDC_ACCOUNT, log: quiet, now: () => t });
  return { db, earned, kicks, inline, drainer, advance: (ms) => { t += ms; } };
}

/* The real SOL payout path on a stubbed chain. confirmGate: when set, the inline confirmation waits for it (a
   process that died mid-confirm never gets past it). Every sent transaction lands. */
function realChain() {
  const sent = [];
  const landed = new Set();
  let confirmGate = null;
  const c = Wallet.connection;
  c.getBalance = async () => 1_000 * 1e9;
  c.getMinimumBalanceForRentExemption = async () => 890880;
  c.getLatestBlockhash = async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1000 });
  c.getBlockHeight = async () => 10;
  c.sendRawTransaction = async (raw) => { const sig = bs58.encode(Buffer.from(raw).subarray(1, 65)); sent.push(sig); landed.add(sig); return sig; };
  c.getSignatureStatus = async (sig) => ({ value: landed.has(sig) ? { confirmationStatus: 'confirmed', err: null } : null });
  c.confirmTransaction = async () => { if (confirmGate) await confirmGate; return { context: { slot: 1 }, value: { err: null } }; };
  const money = {
    unit: 'USD', fiatValue: (a) => a,
    withdraw: (w, usd, opts) => Wallet.withdraw(w, null, { lamports: LAMPORTS, beforeSend: opts && opts.beforeSend }),
    attemptPayout: (row, fn) => Wallet.attemptPayout(row, fn, () => LAMPORTS),
  };
  return { money, sent, gate(p) { confirmGate = p; } };
}

test('the owed row exists before anything is signed, holds the bytes before they are sent, and is gone once they landed', async () => {
  const steps = [];
  let w;
  const money = {
    unit: 'USD', fiatValue: (a) => a,
    async withdraw(wallet, amount, opts) {
      const row = w.db.payouts.find((p) => p.wallet_address === wallet);
      steps.push(['built', !!row, row && row.signature, row && row.reason, row && row.paid]);
      assert.strictEqual(await opts.beforeSend({ signature: 'SIG1', signedTx: 'b64', blockhash: 'bh', lastValidBlockHeight: 9 }), true);
      steps.push(['saved', row.signature, row.signed_tx]);
      steps.push(['sent']);
      return 'SIG1';
    },
  };
  w = setup(money);
  const r = await w.inline.pay({ wallet: WALLET, amount: 0.9, name: 'Ann', reason: 'knockout ko_1' });
  assert.deepStrictEqual(r, { paid: true, sig: 'SIG1', earned: true });
  assert.deepStrictEqual(steps, [['built', true, null, 'knockout ko_1', false], ['saved', 'SIG1', 'b64'], ['sent']]);
  assert.strictEqual(w.db.payouts.length, 0, 'a payout that landed leaves no owed row, exactly as before');
  await tick();
  assert.deepStrictEqual(w.earned, [[WALLET, 'Ann', 0.9]], 'booked once, as winnings');
});

test('the lease: while the inline attempt runs the drainer does not take the row; 30 s later it may', async () => {
  let release;
  const w = setup({ unit: 'USD', fiatValue: (a) => a, withdraw: () => new Promise((r) => { release = r; }) });
  const p = w.inline.pay({ wallet: WALLET, amount: 0.9, name: 'Ann', reason: 'pool8 p_1' });
  await until(() => w.db.payouts.length === 1);
  assert.strictEqual(await w.db.claimDuePayout(30, 200, 'normal'), null, 'leased to the inline attempt');
  w.advance(31 * S);
  assert.ok(await w.db.claimDuePayout(30, 200, 'normal'), 'a stuck attempt does not hold it for good');
  release('SIG');
  await p;
});

test('a process that dies after the send leaves a row the drainer finishes with the SAME transaction, once', async () => {
  const chain = realChain();
  const w = setup(chain.money);
  chain.gate(new Promise(() => {}));                      // the confirmation never comes: the process is gone
  w.inline.pay({ wallet: WALLET, amount: 0.9, name: 'Ann', reason: 'swim sw_1' });
  await until(() => chain.sent.length === 1);
  const row = w.db.payouts[0];
  assert.strictEqual(row.signature, chain.sent[0], 'the bytes were saved before they were sent');
  assert.strictEqual(row.paid, false);
  // The next boot's drainer, once the lease is over.
  w.advance(31 * S);
  await w.drainer.drain();
  assert.deepStrictEqual(chain.sent, [row.signature], 'no second transfer: the saved one landed');
  assert.strictEqual(w.db.payouts[0].paid, true);
  assert.strictEqual(w.db.payouts[0].paid_sig, chain.sent[0]);
  await until(() => w.earned.length === 1);
  assert.deepStrictEqual(w.earned, [[WALLET, 'Ann', 0.9]]);
});

test('a process that dies before anything was signed leaves the row, and the drainer pays it once', async () => {
  const chain = realChain();
  const w = setup(chain.money);
  const realBlockhash = Wallet.connection.getLatestBlockhash;
  Wallet.connection.getLatestBlockhash = () => new Promise(() => {});   // dies while building
  w.inline.pay({ wallet: WALLET, amount: 0.9, name: 'Ann', reason: 'headsoccer hs_1' });
  await until(() => w.db.payouts.length === 1);
  for (let i = 0; i < 10; i++) await tick();
  assert.strictEqual(w.db.payouts[0].signature, null);
  assert.deepStrictEqual(chain.sent, []);
  Wallet.connection.getLatestBlockhash = realBlockhash;
  w.advance(31 * S);
  await w.drainer.drain();
  assert.strictEqual(chain.sent.length, 1);
  assert.strictEqual(w.db.payouts[0].paid, true);
});

test('the inline attempt and the drainer both see the one transfer land: earnings are booked once', async () => {
  for (const order of ['drainer first', 'inline first']) {
    const chain = realChain();
    const w = setup(chain.money);
    let release;
    chain.gate(new Promise((r) => { release = r; }));
    const p = w.inline.pay({ wallet: WALLET, amount: 0.9, name: 'Ann', reason: 'rooftop rt_1' });
    await until(() => chain.sent.length === 1);
    w.advance(31 * S);                                     // a slow confirmation outlasts the lease
    const claimed = await w.db.claimDuePayout(30, 200, 'normal');
    if (order === 'drainer first') {
      assert.strictEqual(await w.drainer.tryRow(claimed), 'paid');
      release();
      const r = await p;
      assert.strictEqual(r.paid, true);
      assert.strictEqual(r.earned, false, 'the drainer settled it and booked it');
      assert.strictEqual(w.db.payouts[0].paid, true);
    } else {
      release();
      const r = await p;
      assert.strictEqual(r.earned, true);
      assert.strictEqual(w.db.payouts.length, 0);
      assert.strictEqual(await w.drainer.tryRow(claimed), 'paid', 'the drainer finds it landed, sends nothing, books nothing');
    }
    for (let i = 0; i < 10; i++) await tick();
    assert.strictEqual(chain.sent.length, 1, order + ': one transfer');
    assert.strictEqual(w.earned.length, 1, order + ': booked once');
  }
});

test('the drainer saved its own transaction first: the inline attempt sends nothing and leaves the row to it', async () => {
  const chain = realChain();
  const w = setup(chain.money);
  const realBlockhash = Wallet.connection.getLatestBlockhash;
  Wallet.connection.getLatestBlockhash = async () => {
    w.db.payouts[0].signature = 'DRAINERS';                // saved between this attempt's build and its save
    return realBlockhash();
  };
  const r = await w.inline.pay({ wallet: WALLET, amount: 0.9, name: 'Ann', reason: 'crossy cr_1' });
  Wallet.connection.getLatestBlockhash = realBlockhash;
  assert.strictEqual(r.paid, false);
  assert.strictEqual(r.error.code, SUPERSEDED);
  assert.deepStrictEqual(chain.sent, []);
  assert.strictEqual(w.db.payouts[0].signature, 'DRAINERS');
  assert.notStrictEqual(w.db.payouts[0].last_attempt_at, null, 'not released: the drainer is on it');
});

test('a payout that fails stays owed with its error, the lease ends and the drainer is kicked', async () => {
  const w = setup({ unit: 'USD', fiatValue: (a) => a, async withdraw() { throw Object.assign(new Error('Escrow has insufficient funds'), { code: Wallet.PAYOUT_WAIT }); } });
  const r = await w.inline.pay({ wallet: WALLET, amount: 0.9, name: 'Ann', reason: 'knockout ko_2' });
  assert.strictEqual(r.paid, false);
  assert.strictEqual(r.owed, true);
  const row = w.db.payouts[0];
  assert.strictEqual(row.reason, 'knockout ko_2: Escrow has insufficient funds', 'what recordFailedPayout used to write');
  assert.strictEqual(row.last_attempt_at, null);
  assert.strictEqual(row.paid, false);
  assert.strictEqual(w.kicks.length, 1);
  assert.ok(await w.db.claimDuePayout(30, 200, 'normal'), 'due at once, as a failed payout always was');
  assert.deepStrictEqual(w.earned, []);
});

test('a wallet with no USDC account goes to the slow lane, as recordFailedPayout puts it', async () => {
  const w = setup({ unit: 'USDC', fiatValue: (a) => a, async withdraw() { throw Object.assign(new Error(NO_USDC_ACCOUNT + ': the wallet has no USDC account'), { code: NO_USDC_ACCOUNT }); } });
  await w.inline.pay({ wallet: WALLET, amount: 0.9, name: 'Ann', reason: 'snake dollar' });
  assert.strictEqual(w.db.payouts[0].missing_account, true);
  assert.strictEqual(await w.db.claimDuePayout(30, 200, 'normal'), null, 'never in the normal lane');
});

test('a refund is owed as a refund and never booked as winnings, inline or by the drainer', async () => {
  let fail = false;
  const w = setup({ unit: 'USD', fiatValue: (a) => a,
    async withdraw(wallet, amount, opts) { if (fail) throw new Error('rpc 503'); await opts.beforeSend({ signature: 'R1' }); return 'R1'; },
    async attemptPayout() { return { paid: true, sig: 'R2' }; } });
  const r = await w.inline.pay({ wallet: WALLET, amount: 0.5, name: 'Ann', reason: 'refund knockout (draw)', earn: false });
  assert.deepStrictEqual(r, { paid: true, sig: 'R1', earned: false });
  fail = true;
  await w.inline.pay({ wallet: WALLET, amount: 0.5, name: 'Ann', reason: 'refund pool8', earn: false });
  assert.match(w.db.payouts[0].reason, /^refund pool8: rpc 503$/);
  await w.drainer.drain();
  for (let i = 0; i < 10; i++) await tick();
  assert.strictEqual(w.db.payouts[0].paid, true);
  assert.deepStrictEqual(w.earned, []);
});

test('the database is down when the row should be written: the payout goes out exactly the old way', async () => {
  const calls = [];
  const money = { unit: 'USD', fiatValue: (a) => a,
    async withdraw(wallet, amount, opts) { calls.push(opts); if (amount > 1) { const e = new Error('rpc'); e.broadcast = { signature: 'B' }; throw e; } return 'OLD'; } };
  const w = setup(money);
  w.db.recordPayoutIntent = async () => { throw new Error('db down'); };
  const failed = [];
  w.db.recordFailedPayout = async (...a) => { failed.push(a); };
  assert.deepStrictEqual(await w.inline.pay({ wallet: WALLET, amount: 0.9, name: 'Ann', reason: 'battleship b_1' }), { paid: true, sig: 'OLD', earned: true });
  assert.strictEqual(calls[0], undefined, 'no beforeSend: nothing to save it on');
  await tick();
  assert.deepStrictEqual(w.earned, [[WALLET, 'Ann', 0.9]]);
  const r = await w.inline.pay({ wallet: WALLET, amount: 2, name: 'Ann', reason: 'battleship b_2' });
  assert.strictEqual(r.paid, false);
  await tick();
  assert.deepStrictEqual(failed, [[WALLET, 2, 'Ann', 'battleship b_2: rpc', { signature: 'B' }]]);
});

test('index.js: every duel payout and the old snake cash-out go through the owed-row-first path; refunds are refunds', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8').replace(/\r\n/g, '\n');
  const body = (name, close = '\n}\n') => { const i = src.indexOf(name); const end = src.indexOf(close, i); assert.ok(i >= 0 && end > i, name); return src.slice(i, end); };
  const ko = body('function koSend(');
  assert.match(ko, /inlinePayout\.pay\(\{ wallet, amount, name: name \|\| 'Player', reason, earn: !refund \}\)/);
  assert.match(ko, /agInflight\.track\(/, 'a shutdown waits on it like the paid games\' money');
  assert.ok(!/money\.withdraw\(/.test(ko), 'no payout that saves nothing first');
  // '<game> refund ...' is owed as 'refund <game> ...' (the drainer's rule for "not winnings").
  const m = /const reason = refund \? note\.replace\((\/.*\/), '(refund \$1)'\) : note;/.exec(ko);
  assert.ok(m, 'the refund reason');
  const re = new RegExp(m[1].slice(1, -1));
  assert.strictEqual('knockout refund (draw)'.replace(re, m[2]), 'refund knockout (draw)');
  assert.strictEqual('airhockey refund'.replace(re, m[2]), 'refund airhockey');
  assert.ok(!re.test('knockout ko_1') && !re.test('pool8 pool8_na_1'), 'a prize is not a refund');
  const cash = body('async function doCashout(', '\n  }\n');   // nested in the connection handler
  assert.match(cash, /inlinePayout\.pay\(\{ wallet, amount: playerShare, name: snake\.name, reason: `snake \$\{room\.lobbyType\}` \}\)/);
  assert.ok(!/money\.withdraw\(/.test(cash));
});

test('db.js: the owed row is written leased, closed only while unpaid, and markPayoutPaid settles a row once', async () => {
  const db = require('../server/db');
  const seen = [];
  let rowCount = 1;
  db.pool.query = async (sql, params) => { seen.push({ sql, params }); return { rows: [{ id: 42 }], rowCount }; };
  assert.strictEqual(await db.recordPayoutIntent('W', 0.9, 'Ann', 'knockout ko_1'), 42);
  assert.match(seen[0].sql, /INSERT INTO failed_payouts \(wallet_address, amount_sol, name, reason, last_attempt_at\)\s+VALUES \(\$1, \$2, \$3, \$4, NOW\(\)\)\s+RETURNING id/);
  assert.deepStrictEqual(seen[0].params, ['W', 0.9, 'Ann', 'knockout ko_1']);
  assert.strictEqual(await db.closePayoutIntent(42), true);
  assert.match(seen[1].sql, /^DELETE FROM failed_payouts WHERE id = \$1 AND paid = false RETURNING id$/);
  assert.strictEqual(await db.markPayoutPaid(42, 'S'), true);
  assert.match(seen[2].sql, /UPDATE failed_payouts SET paid = true, paid_sig = \$2 WHERE id = \$1 AND paid = false/);
  rowCount = 0;
  assert.strictEqual(await db.closePayoutIntent(42), false);
  assert.strictEqual(await db.markPayoutPaid(42, 'S'), false);
  await db.releasePayoutIntent(42, 'rpc 503');
  const rel = seen[seen.length - 1];
  assert.match(rel.sql, /SET reason = left\(reason \|\| \$2::text, 500\), last_attempt_at = NULL WHERE id = \$1 AND paid = false/);
  assert.deepStrictEqual(rel.params, [42, ': rpc 503']);
});
