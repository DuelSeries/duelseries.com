'use strict';
/* Security review 2026-10-15, findings 3 and 5 (finder-2, refute-core): the pending-verify claim.

   /api/submit-stake used to broadcast the client's signed stake first and write the stake's row
   only after verifying it. A stake that landed after the request had already failed (a status read
   that threw, the 40-poll timeout, a lagging node, a restart in the middle: every deploy) had no
   row, no token and no refund; and the token went to whoever posted the bytes first, so someone who
   saw them on the network before they confirmed could take the seat.

   Now the row is written BEFORE the broadcast ('verifying', keyed by the signature read from the
   bytes, with the fee payer and the blockhash), and the stake sweep settles any row its request
   did not: refunded to the chain's payer if it landed (never minted late), closed if it failed,
   paid short, or can no longer land. Here: server/stakeLedger.js over scripts/memLedgerDb.js (each
   SQL rule in one step) with a fake chain, Wallet.stakeTxInfo on real signed bytes, and the SQL
   pinned at the end (no Postgres on the dev machine). test/stakePendingVerifyServer.test.js runs
   the same against the real server. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Keypair, Transaction, SystemProgram, PublicKey, VersionedTransaction, TransactionMessage } = require('@solana/web3.js');
const { createMemLedgerDb } = require('../scripts/memLedgerDb');
const { createStakeLedger } = require('../server/stakeLedger');

const quiet = { log() {}, warn() {}, error() {} };
const MIN = 60 * 1000;

function harness({ latency = null, statusOf = {}, valid = {}, owedOf = {}, inFlight = new Set(), region = 'na', bootId = 'boot-1' } = {}) {
  let t = 1e12;
  const db = createMemLedgerDb({ now: () => t, latency });
  const kicks = [];
  const reads = { status: 0, valid: 0, owed: 0 };
  const chain = {
    async status(sig) { reads.status++; const v = statusOf[sig]; return typeof v === 'function' ? v() : (v === undefined ? null : v); },
    async blockhashValid(bh) { reads.valid++; return !!valid[bh]; },
    async owed(row) {
      reads.owed++;
      const o = owedOf[row.sig];
      if (o instanceof Error) throw o;
      return o === undefined ? { payer: row.wallet_address, amount: Number(row.refund_amount) } : o;
    },
  };
  const ledger = createStakeLedger({ db, region, bootId, log: quiet, kickDrain: () => kicks.push(1), chain,
                                     inFlight: (sig) => inFlight.has(sig), now: () => t });
  return { db, ledger, kicks, reads, inFlight, advance: (ms) => { t += ms; }, clock: () => t };
}

const PAYER = 'PayerWa11et1111111111111111111111111111111';
const pre = (h, sig, extra = {}) => h.ledger.preclaim(sig, { wallet: PAYER, amount: 0.5, label: 'stake 0.5', blockhash: 'BH-' + sig, ...extra });

test('the claim is written before the broadcast, and a second submit of the same signature is refused', async () => {
  const h = harness();
  assert.deepStrictEqual(await pre(h, 'S1'), { claimed: true, durable: true });
  const row = h.db.stakes.get('S1');
  assert.deepStrictEqual(
    { state: row.state, wallet: row.wallet_address, amount: row.refund_amount, label: row.label, region: row.region, boot: row.boot_id, bh: row.blockhash },
    { state: 'verifying', wallet: PAYER, amount: 0.5, label: 'stake 0.5', region: 'na', boot: 'boot-1', bh: 'BH-S1' });
  // The same bytes again (a replay, or someone who saw them on the network): refused, nothing changed.
  assert.deepStrictEqual(await pre(h, 'S1', { wallet: 'Attacker' }), { claimed: false, durable: false });
  assert.strictEqual(h.db.stakes.get('S1').wallet_address, PAYER);
  // A verifying row is no door's and no refund's: nothing can seat it or pay it.
  assert.strictEqual(await h.db.claimStakeSeat('S1', 'k'), false);
  assert.strictEqual(await h.ledger.refund('S1', 'refund x'), 'settled');
  assert.deepStrictEqual(await h.db.listUnsettledStakes({ region: 'na', bootId: 'other', staleSeconds: 0 }), []);
});

test('the request that verified its stake turns the row into the durable stake row, and the sweep leaves it alone', async () => {
  const h = harness({ statusOf: { S1: 'landed' } });
  await pre(h, 'S1');
  assert.deepStrictEqual(await h.ledger.record('S1', { wallet: PAYER, amount: 0.5, label: 'stake 0.5', preclaimed: true }),
    { claimed: true, durable: true });
  assert.strictEqual(h.db.stakes.get('S1').state, 'pending');
  // It is now a normal stake row: a door claims it.
  assert.strictEqual(await h.db.claimStakeSeat('S1', 'key'), true);
  h.advance(10 * MIN);
  const out = await h.ledger.sweep({ boot: false });
  assert.deepStrictEqual(out.verify, { found: 0, owed: 0, closed: 0, waiting: 0, ok: true });
  assert.strictEqual(h.db.payouts.length, 0);
});

test('a stake that landed after its request failed is refunded once to the chain\'s payer, never minted late', async () => {
  const h = harness({ statusOf: { S1: 'landed' }, owedOf: { S1: { payer: PAYER, amount: 0.5 } } });
  await pre(h, 'S1');
  // The request broadcast, then its confirm poll timed out: it answered 400 and wrote nothing more.
  h.advance(1 * MIN);
  assert.strictEqual((await h.ledger.sweep({ boot: false })).verify.found, 0, 'not before two minutes');
  h.advance(2 * MIN);
  const out = (await h.ledger.sweep({ boot: false })).verify;
  assert.deepStrictEqual(out, { found: 1, owed: 1, closed: 0, waiting: 0, ok: true });
  const row = h.db.stakes.get('S1');
  assert.strictEqual(row.state, 'refunded');
  assert.strictEqual(row.wallet_address, PAYER);
  assert.deepStrictEqual(h.db.payouts.map((p) => [p.stake_sig, p.wallet_address, p.amount_sol]), [['S1', PAYER, 0.5]]);
  assert.match(h.db.payouts[0].reason, /^refund stake 0\.5 that landed after its submit failed/);
  assert.strictEqual(h.kicks.length, 1, 'the drainer is kicked');
  // The request (or a retry of it) finishing now can never mint a token for it.
  assert.deepStrictEqual(await h.ledger.record('S1', { wallet: PAYER, amount: 0.5, label: 'stake 0.5', preclaimed: true }),
    { claimed: false, durable: false });
  // And no later sweep pays it again.
  h.advance(60 * MIN);
  await h.ledger.sweep({ boot: false });
  assert.strictEqual(h.db.payouts.length, 1);
});

test('a row an earlier boot of this region wrote is settled at once; a row in flight here is never touched', async () => {
  const h = harness({ bootId: 'boot-2', statusOf: { OLD: 'landed', MINE: 'landed', EU: 'landed' } });
  h.db.seedStake({ sig: 'OLD', state: 'verifying', wallet_address: PAYER, refund_amount: 1, label: 'stake 1', region: 'na', boot_id: 'boot-1', blockhash: 'b' });
  h.db.seedStake({ sig: 'EU', state: 'verifying', wallet_address: PAYER, refund_amount: 1, label: 'stake 1', region: 'eu', boot_id: 'eu-1', blockhash: 'b' });
  await pre(h, 'MINE');
  h.inFlight.add('MINE');
  let out = (await h.ledger.sweep({ boot: true })).verify;
  assert.deepStrictEqual(out, { found: 1, owed: 1, closed: 0, waiting: 0, ok: true }, 'only the dead boot\'s row is due yet');
  assert.strictEqual(h.db.stakes.get('OLD').state, 'refunded');
  assert.strictEqual(h.db.stakes.get('EU').state, 'verifying', 'another region\'s fresh row is its own server\'s');
  h.advance(5 * MIN);
  out = (await h.ledger.sweep({ boot: false })).verify;
  assert.strictEqual(h.db.stakes.get('MINE').state, 'verifying', 'its request is still working on it');
  assert.strictEqual(h.db.stakes.get('EU').state, 'refunded', 'once old, any server settles it');
  assert.strictEqual(out.waiting, 1);
});

test('a stake that never landed is closed only once its blockhash has expired and a second look still finds nothing', async () => {
  let second = null;
  const h = harness({ statusOf: { GONE: null, LATE: () => (second === 'LATE' ? 'landed' : (second = 'LATE', null)) },
                      valid: { 'BH-GONE': true, 'BH-LATE': false } });
  await pre(h, 'GONE');
  await pre(h, 'LATE');
  h.advance(3 * MIN);
  let out = (await h.ledger.sweep({ boot: false })).verify;
  assert.strictEqual(h.db.stakes.get('GONE').state, 'verifying', 'its blockhash is still valid: it may still land');
  // LATE: blockhash expired, but the second look found it landed: left for the next sweep.
  assert.strictEqual(h.db.stakes.get('LATE').state, 'verifying');
  assert.strictEqual(out.waiting, 2);
  const h2 = harness({ statusOf: {}, valid: {} });
  await pre(h2, 'X');
  h2.advance(3 * MIN);
  out = (await h2.ledger.sweep({ boot: false })).verify;
  assert.deepStrictEqual(out, { found: 1, owed: 0, closed: 1, waiting: 0, ok: true });
  assert.strictEqual(h2.db.stakes.get('X').state, 'expired');
  assert.strictEqual(h2.db.payouts.length, 0);
  assert.strictEqual(h2.reads.status, 2, 'looked twice');
});

test('landed with an error, or paid short, is closed with nothing owed; a chain that cannot answer leaves the row', async () => {
  const h = harness({ statusOf: { F: 'failed', SHORT: 'landed', ERR: 'landed', DOWN: () => { throw new Error('rpc 503'); } },
                      owedOf: { SHORT: { reject: 'Stake too small (1 < 500000 USDC units)' }, ERR: new Error('Stake transaction not found or not yet confirmed') } });
  for (const s of ['F', 'SHORT', 'ERR', 'DOWN']) await pre(h, s);
  h.advance(3 * MIN);
  const out = (await h.ledger.sweep({ boot: false })).verify;
  assert.deepStrictEqual(['F', 'SHORT', 'ERR', 'DOWN'].map((s) => h.db.stakes.get(s).state), ['failed', 'rejected', 'verifying', 'verifying']);
  assert.deepStrictEqual(out, { found: 4, owed: 0, closed: 2, waiting: 2, ok: true });
  assert.strictEqual(h.db.payouts.length, 0);
});

test('the request and the sweep racing one row: exactly one wins in every interleaving, never a token and a refund', async () => {
  for (let a = 0; a < 4; a++) {
    for (let b = 0; b < 4; b++) {
      const h = harness({ statusOf: { R: 'landed' },
        latency: (name) => (name === 'confirmStakeVerify' ? (h && h.turn === 'req' ? a : b) : 0) });
      await pre(h, 'R');
      h.advance(3 * MIN);
      h.turn = 'req';
      const req = h.ledger.record('R', { wallet: PAYER, amount: 0.5, label: 'stake 0.5', preclaimed: true });
      h.turn = 'sweep';
      const sweep = h.ledger.sweep({ boot: false });
      const [rec] = await Promise.all([req, sweep]);
      const refunded = h.db.payouts.length;
      assert.ok((rec.claimed && refunded === 0) || (!rec.claimed && refunded === 1),
        `a=${a} b=${b}: token ${rec.claimed}, refunds ${refunded}`);
      assert.strictEqual(h.db.stakes.get('R').state, rec.claimed ? 'pending' : 'refunded');
    }
  }
});

test('without the chain, or against an old database, everything is exactly as before', async () => {
  const db = createMemLedgerDb();
  const plain = createStakeLedger({ db, region: 'na', bootId: 'b', log: quiet });
  assert.deepStrictEqual(await plain.sweep({ boot: true }), { found: 0, owed: 0, ok: true }, 'no chain: the old sweep, the old answer');
  // A stub database with no pending-verify functions: nothing is written before the broadcast,
  // and the claim after the verify is the old one.
  const old = { markStakeSig: async () => true, claimStakeSig: async () => ({ claimed: true, durable: true }) };
  const l2 = createStakeLedger({ db: old, region: 'na', bootId: 'b', log: quiet, chain: {} });
  assert.deepStrictEqual(await l2.preclaim('S', { wallet: PAYER, amount: 1 }), { claimed: true, durable: false });
  assert.deepStrictEqual(await l2.record('S', { wallet: PAYER, amount: 1, label: 'x', preclaimed: false }), { claimed: true, durable: true });
});

/* ---- Wallet.stakeTxInfo: what the bytes say, before anything is sent ------------------------- */

const Wallet = require('../server/Wallet');
function signedTransfer(payer, { legacy = true } = {}) {
  const blockhash = Keypair.generate().publicKey.toBase58();
  const ix = SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 });
  if (legacy) {
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = blockhash; tx.feePayer = payer.publicKey; tx.sign(payer);
    return { raw: tx.serialize(), blockhash };
  }
  const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message();
  const vtx = new VersionedTransaction(msg);
  vtx.sign([payer]);
  return { raw: Buffer.from(vtx.serialize()), blockhash };
}

test('stakeTxInfo reads the signature, the fee payer and the blockhash off legacy and v0 bytes, and refuses unsigned ones', () => {
  const _bs58 = require('bs58');
  const bs58 = (_bs58 && _bs58.default) ? _bs58.default : _bs58;
  for (const legacy of [true, false]) {
    const payer = Keypair.generate();
    const { raw, blockhash } = signedTransfer(payer, { legacy });
    const info = Wallet.stakeTxInfo(raw);
    assert.strictEqual(info.payer, payer.publicKey.toBase58());
    assert.strictEqual(info.blockhash, blockhash);
    assert.strictEqual(info.signature, bs58.encode(raw.subarray(1, 65)), 'the tx id sendRawTransaction returns');
    // A flipped byte in the message (inside its blockhash): the payer never signed that.
    const bad = Buffer.from(raw);
    const at = bad.indexOf(Buffer.from(bs58.decode(blockhash)));
    assert.ok(at > 65);
    bad[at + 3] ^= 1;
    assert.throws(() => Wallet.stakeTxInfo(bad), /not signed by its payer/);
    // A byte that breaks the message's shape is refused too.
    const broken = Buffer.from(raw); broken[broken.length - 1] ^= 0xff;
    assert.throws(() => Wallet.stakeTxInfo(broken));
    // An unsigned copy (all-zero signature).
    const unsigned = Buffer.from(raw); unsigned.fill(0, 1, 65);
    assert.throws(() => Wallet.stakeTxInfo(unsigned), /not signed by its payer/);
  }
  assert.throws(() => Wallet.stakeTxInfo(Buffer.from('not a transaction')), /Not a signed transaction|not signed by its payer/);
  assert.throws(() => Wallet.stakeTxInfo(Buffer.alloc(0)), /Not a signed transaction/);
});

test('submitStake runs beforeSend first and sends nothing when it throws; without opts it is the plain broadcast', async () => {
  const conn = Wallet.connection;
  const sent = [];
  conn.sendRawTransaction = async (raw) => { sent.push(raw); const _b = require('bs58'); return (_b.default || _b).encode(Buffer.from(raw).subarray(1, 65)); };
  conn.getSignatureStatus = async () => ({ value: { confirmationStatus: 'confirmed', err: null } });
  const { raw } = signedTransfer(Keypair.generate());
  const seen = [];
  await assert.rejects(Wallet.submitStake(raw, { beforeSend: async (info) => { seen.push(info.signature); throw new Error('Stake already used'); } }), /Stake already used/);
  assert.strictEqual(sent.length, 0, 'refused before the broadcast');
  const sig = await Wallet.submitStake(raw, { beforeSend: async (info) => { seen.push(info.signature); } });
  assert.strictEqual(sig, seen[1]);
  assert.strictEqual(sent.length, 1);
  await assert.rejects(Wallet.submitStake(Buffer.from('junk'), { beforeSend: async () => { seen.push('called'); } }));
  assert.strictEqual(seen.includes('called'), false, 'junk bytes never reach the claim');
  // A status read that throws is not a failed stake: the poll keeps looking.
  let n = 0;
  conn.getSignatureStatus = async () => { if (++n < 3) throw new Error('503 Service unavailable'); return { value: { confirmationStatus: 'confirmed', err: null } }; };
  assert.strictEqual(typeof await Wallet.submitStake(signedTransfer(Keypair.generate()).raw), 'string');
  assert.strictEqual(n, 3);
});

/* ---- the SQL (no Postgres on the dev machine) and the wiring ---------------------------------- */

test('db.js: each pending-verify step is one conditional statement on state = verifying', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'db.js'), 'utf8');
  const fn = (name) => src.slice(src.indexOf('async function ' + name), src.indexOf('\n}\n', src.indexOf('async function ' + name)));
  assert.match(fn('claimStakeVerify'), /INSERT INTO used_stake_sigs \(sig, state, wallet_address, refund_amount, label, region, boot_id, blockhash\)\s*VALUES \(\$1, 'verifying'/);
  assert.match(fn('claimStakeVerify'), /ON CONFLICT DO NOTHING RETURNING sig/);
  assert.match(fn('confirmStakeVerify'), /UPDATE used_stake_sigs SET state = 'pending', wallet_address = \$2, refund_amount = \$3, label = \$4\s*WHERE sig = \$1 AND state = 'verifying'/);
  assert.match(fn('closeStakeVerify'), /UPDATE used_stake_sigs SET state = \$2, settled_at = NOW\(\)\s*WHERE sig = \$1 AND state = 'verifying'/);
  assert.match(fn('listStakeVerifies'), /WHERE state = 'verifying'/);
  assert.match(fn('listStakeVerifies'), /region = \$1::text AND boot_id IS DISTINCT FROM \$2::text/);
  assert.match(src, /ALTER TABLE used_stake_sigs ADD COLUMN IF NOT EXISTS blockhash TEXT/);
  // Nothing that came before reads a verifying row: every door and refund is on pending/consumed.
  assert.match(fn('claimStakeSeat'), /state = 'pending' OR \(state = 'consumed'/);
  assert.match(fn('listUnsettledStakes'), /WHERE state = 'pending'/);
});

test('db.js: the pending-verify functions fall back cleanly without the ledger columns', async () => {
  const db = require('../server/db');
  const seen = [];
  db.pool.query = async (sql, params) => { seen.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params }); return { rows: [{ sig: params && params[0] }], rowCount: 1 }; };
  db.features.durableStakes = true;
  assert.deepStrictEqual(await db.claimStakeVerify('S', { wallet: 'W', amount: 0.5, label: 'stake 0.5', region: 'na', bootId: 'b', blockhash: 'BH' }),
    { claimed: true, durable: true });
  assert.deepStrictEqual(seen[0].params, ['S', 'W', 0.5, 'stake 0.5', 'na', 'b', 'BH']);
  assert.deepStrictEqual(await db.confirmStakeVerify('S', { wallet: 'W', amount: 0.5, label: 'stake 0.5' }), { claimed: true, durable: true });
  assert.deepStrictEqual(await db.confirmStakeVerify('S', { wallet: '', amount: 0.5 }), { claimed: true, durable: false });
  assert.match(seen[2].sql, /SET state = NULL WHERE sig = \$1 AND state = 'verifying'/);
  // A missing column at the claim: nothing written, durable off, the caller keeps the old flow.
  db.pool.query = async () => { throw Object.assign(new Error('column "blockhash" does not exist'), { code: '42703' }); };
  const { error } = console; console.error = () => {};
  try {
    assert.deepStrictEqual(await db.claimStakeVerify('S2', { wallet: 'W', amount: 1 }), { claimed: true, durable: false });
  } finally { console.error = error; }
  assert.strictEqual(db.features.durableStakes, false);
  assert.deepStrictEqual(await db.claimStakeVerify('S3', { wallet: 'W', amount: 1 }), { claimed: true, durable: false });
  assert.deepStrictEqual(await db.listStakeVerifies({}), []);
  db.features.durableStakes = true;
});

test('index.js: both submit-stake paths claim before the broadcast, settle the same row after the verify, and the sweep has a chain', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  const route = src.slice(src.indexOf("app.post('/api/submit-stake'"), src.indexOf('\n});\n', src.indexOf("app.post('/api/submit-stake'")));
  assert.strictEqual((route.match(/Wallet\.submitStake\(Buffer\.from\(signedTx, 'base64'\),\s*\{ beforeSend: preclaimStake\(/g) || []).length, 2);
  assert.strictEqual((route.match(/preclaimed: pre\.durable \}\)/g) || []).length, 2);
  assert.strictEqual((route.match(/finally \{\s*if \(pre\.sig\) stakeInFlight\.delete\(pre\.sig\);/g) || []).length, 2);
  assert.match(src, /preclaimStake\(money\.amountFor\(want\), 'stake ' \+ want, pre\)/);
  assert.match(src, /preclaimStake\(money\.feeFor\(lobbyType\), 'lobby ' \+ lobbyType, pre\)/);
  assert.match(src, /chain: \{\s*status: \(sig\) => Wallet\.stakeSigStatus\(sig\),\s*blockhashValid: \(blockhash\) => Wallet\.blockhashValid\(blockhash\),\s*owed: \(row\) => owedForLateStake\(row\),\s*\},\s*inFlight: \(sig\) => stakeInFlight\.has\(sig\),/);
  // /api/broadcast relays a player's own cash-out and stays a plain broadcast.
  assert.match(src, /app\.post\('\/api\/broadcast'[\s\S]{0,400}Wallet\.submitStake\(Buffer\.from\(signedTx, 'base64'\)\);/);
});

test('a row under 3 minutes old, or one the chain has seen at processed, is never closed as expired', async () => {
  const h = harness({ statusOf: { YOUNG: null, SEEN: 'seen' }, valid: {} });
  await pre(h, 'YOUNG');
  h.advance(1 * MIN);
  let out = (await h.ledger.sweep({ boot: true })).verify;
  assert.strictEqual(h.db.stakes.get('YOUNG').state, 'verifying', 'a restart seconds after the broadcast must not expire it');
  await pre(h, 'SEEN');
  h.advance(10 * MIN);
  out = (await h.ledger.sweep({ boot: false })).verify;
  assert.strictEqual(h.db.stakes.get('SEEN').state, 'verifying', 'processed but not confirmed: still settling');
  assert.strictEqual(h.db.stakes.get('YOUNG').state, 'expired', 'old enough, blockhash gone, never seen: closed');
  assert.strictEqual(h.db.payouts.length, 0);
});

/* Night review 2026-10-29, finding 23: bytes the node refused at preflight were never forwarded, and only the server
   sends stakes, so their row is closed at once ('expired', the sweep's own verdict minutes later) instead of waiting,
   oldest first, in front of real late stakes. Only a 'verifying' row; a database error leaves it for the sweep. */
test('unsent: a row whose bytes the node refused is closed at once; a settled row and a database error are left alone', async () => {
  const h = harness();
  await pre(h, 'J1');
  assert.strictEqual(await h.ledger.unsent('J1'), true);
  assert.strictEqual(h.db.stakes.get('J1').state, 'expired');
  // Already settled (the request verified it): nothing changes.
  await pre(h, 'J2');
  await h.ledger.record('J2', { wallet: PAYER, amount: 0.5, label: 'stake 0.5', preclaimed: true });
  assert.strictEqual(await h.ledger.unsent('J2'), false);
  assert.strictEqual(h.db.stakes.get('J2').state, 'pending');
  // The database did not answer: never rejects, and the sweep still has the row.
  await pre(h, 'J3');
  const close = h.db.closeStakeVerify;
  h.db.closeStakeVerify = async () => { throw new Error('db down'); };
  assert.strictEqual(await h.ledger.unsent('J3'), false);
  h.db.closeStakeVerify = close;
  assert.strictEqual(h.db.stakes.get('J3').state, 'verifying');
});

test('Wallet.preflightRefused: only a preflight refusal the node never forwarded, never "already processed" or a timeout', () => {
  const Wallet = require('../server/Wallet');
  const { SendTransactionError } = require('@solana/web3.js');
  const sim = (why) => new SendTransactionError({ action: 'simulate', signature: '', transactionMessage: why, logs: [] });
  assert.strictEqual(Wallet.preflightRefused(sim('Transaction simulation failed: Blockhash not found')), true);
  assert.strictEqual(Wallet.preflightRefused(sim('Transaction simulation failed: Attempt to debit an account but found no record of a prior credit.')), true);
  assert.strictEqual(Wallet.preflightRefused(sim('Transaction signature verification failure')), true);
  assert.strictEqual(Wallet.preflightRefused(sim('Transaction simulation failed: This transaction has already been processed')), false);
  assert.strictEqual(Wallet.preflightRefused(sim('Node is behind by 120 slots')), false, 'a node health error proves less: left for the sweep');
  assert.strictEqual(Wallet.preflightRefused(new SendTransactionError({ action: 'send', signature: 'x', transactionMessage: 'Transaction simulation failed: x' })), false);
  assert.strictEqual(Wallet.preflightRefused(new Error('Simulation failed. \nMessage: Transaction simulation failed: x')), false, 'not from web3.js');
  assert.strictEqual(Wallet.preflightRefused(new Error('429 Too Many Requests')), false);
  assert.strictEqual(Wallet.preflightRefused(new Error('fetch failed')), false);
});
