'use strict';
/* Buying skins (server/skinShop.js, docs/skin-purchases.md) on fakes: a model of the database with the same
   one-time rules as the SQL (UNIQUE signature, one live row per wallet and item, conditional state moves) and a
   model of the chain. Real signed transactions are built with throwaway keys; nothing touches a network or money. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram, VersionedTransaction } = require('@solana/web3.js');
const { createTransferCheckedInstruction, getAssociatedTokenAddressSync } = require('@solana/spl-token');
const Wallet = require('../server/Wallet');
const { createSkinShop, paymentProblem, landedProblem, preflightRefused, MEMO_PROGRAM } = require('../server/skinShop');
const { createSkinPass } = require('../server/skinPass');

const MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const REVENUE = Keypair.generate().publicKey;
const REVENUE_ATA = getAssociatedTokenAddressSync(MINT, REVENUE);
const BLOCKHASH = Keypair.generate().publicKey.toBase58();

function payTx(payer, { ref, units = 1000000n, dest = REVENUE_ATA, mint = MINT, memo, extra = [], noMemo = false, twice = false, signer = payer } = {}) {
  const tx = new Transaction();
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = BLOCKHASH;
  const from = getAssociatedTokenAddressSync(mint, payer.publicKey);
  tx.add(createTransferCheckedInstruction(from, mint, dest, payer.publicKey, units, 6));
  if (twice) tx.add(createTransferCheckedInstruction(from, mint, dest, payer.publicKey, units, 6));
  if (!noMemo) tx.add(new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM), keys: [], data: Buffer.from(memo || 'ds-skin:' + ref, 'utf8') }));
  for (const ix of extra) tx.add(ix);
  tx.sign(signer);
  return tx.serialize();
}
const b64 = (raw) => Buffer.from(raw).toString('base64');

// What getTransaction answers for these bytes having landed, crediting the revenue account `delta` units.
function landedOf(raw, delta, { err = null } = {}) {
  const v = VersionedTransaction.deserialize(raw);
  const keys = v.message.staticAccountKeys.map((k) => k.toBase58());
  const ix = keys.indexOf(REVENUE_ATA.toBase58());
  const bal = (n) => ({ accountIndex: ix, mint: MINT.toBase58(), owner: REVENUE.toBase58(), uiTokenAmount: { amount: String(n) } });
  return { meta: { err, preTokenBalances: [bal(7000000n)], postTokenBalances: [bal(7000000n + BigInt(delta))], loadedAddresses: { writable: [], readonly: [] } },
           transaction: { message: v.message } };
}

// The database, as the SQL behaves.
function fakeStore() {
  const rows = new Map();          // ref -> row
  const owned = new Map();         // wallet -> Set(item)
  const ledger = [];
  const sigs = new Set();
  const live = (w, item) => [...rows.values()].find((r) => r.wallet === w && r.item === item && (r.state === 'open' || r.state === 'submitted'));
  return {
    rows, ownedMap: owned, ledger,
    async ownsItem(w, item) { return !!(owned.get(w) && owned.get(w).has(item)); },
    async owned(w) { return [...(owned.get(w) || [])]; },
    async skinOpen(r) {
      const l = live(r.wallet, r.item);
      if (l) return { ...l };
      const row = { ...r, state: 'open', sig: null, blockhash: null, submittedAt: null, createdAt: Date.now() };
      rows.set(r.ref, row);
      return { ...row };
    },
    async skinRow(ref) { const r = rows.get(ref); return r ? { ...r } : null; },
    async skinSubmit(ref, sig, bh) {
      const r = rows.get(ref);
      if (!r || r.state !== 'open' || sigs.has(sig)) return false;
      sigs.add(sig);
      Object.assign(r, { state: 'submitted', sig, blockhash: bh, submittedAt: Date.now() });
      return true;
    },
    async skinReopen(ref, sig) {
      const r = rows.get(ref);
      if (!r || r.sig !== sig || r.state !== 'submitted') return false;
      sigs.delete(sig);
      Object.assign(r, { state: 'open', sig: null, blockhash: null });
      return true;
    },
    async skinClose(ref, sig, state) {
      const r = rows.get(ref);
      if (!r || r.sig !== sig || r.state !== 'submitted') return false;
      r.state = state;
      return true;
    },
    async skinGrant(ref, sig, { usdc }) {
      const r = rows.get(ref);
      if (!r || r.sig !== sig || r.state !== 'submitted') return { granted: false };
      r.state = 'paid';
      if (!owned.has(r.wallet)) owned.set(r.wallet, new Set());
      owned.get(r.wallet).add(r.item);
      ledger.push({ source: 'cosmetic', game: r.game, amount: usdc, wallet: r.wallet, item: r.item, sig });
      return { granted: true };
    },
    async skinDue({ olderThanMs }) { return [...rows.values()].filter((r) => r.state === 'submitted' && Date.now() - r.submittedAt >= olderThanMs).map((r) => ({ ...r })); },
    async skinExpire(ref) { const r = rows.get(ref); if (!r || r.state !== 'open') return false; r.state = 'expired'; return true; },
    async skinExpireOpen() { return 0; },
  };
}

// The chain: send records the bytes; what each signature does is scripted per test.
function fakeChain() {
  const c = {
    sent: [],
    outcome: new Map(),        // sig -> { status, tx }
    sendError: null,
    blockhashOk: true,
    txInfo: (raw) => Wallet.stakeTxInfo(raw),
    async send(raw) {
      c.sent.push(raw);
      if (c.sendError) { const e = c.sendError; throw e; }
      return Wallet.stakeTxInfo(raw).signature;
    },
    async status(sig) { const o = c.outcome.get(sig); return o ? o.status : null; },
    async getTx(sig) { const o = c.outcome.get(sig); return o ? o.tx : null; },
    async blockhashValid() { return c.blockhashOk; },
    async latestBlockhash() { return { blockhash: BLOCKHASH }; },
  };
  return c;
}

function shop(opts = {}) {
  const store = opts.store || fakeStore();
  const chain = opts.chain || fakeChain();
  const paid = [];
  const s = createSkinShop({ store, chain, mint: MINT.toBase58(), revenueAta: REVENUE_ATA.toBase58(),
    paused: opts.paused || (() => false), ready: opts.ready || (() => true),
    log: { log() {}, warn() {}, error() {} }, sleep: async () => {}, confirmMs: opts.confirmMs || 0, now: opts.now,
    onPaid: (p) => paid.push(p), sweepAfterMs: 0 });
  return { s, store, chain, paid };
}

async function openFor(s, payer, game = 'snake', skin = 'candycane') {
  const r = await s.intent({ game, skin, wallet: payer.publicKey.toBase58() });
  assert.equal(r.status, 200);
  return r.body;
}
// Script: these bytes land, crediting `delta`.
function willLand(chain, raw, delta) {
  const sig = Wallet.stakeTxInfo(raw).signature;
  chain.outcome.set(sig, { status: 'landed', tx: landedOf(raw, delta) });
  return sig;
}

test('intent: the server prices the skin, not the page; unknown, locked and odd ids are refused', async () => {
  const { s } = shop();
  const p = Keypair.generate();
  const q = await openFor(s, p, 'paper', 'gold');
  assert.equal(q.units, '5000000');
  assert.equal(q.amountUsdc, 5);
  assert.equal(q.payTo, REVENUE_ATA.toBase58());
  assert.equal(q.memo, 'ds-skin:' + q.ref);
  const w = p.publicKey.toBase58();
  for (const [game, skin] of [['snake', 'nope'], ['tanks', 'gold'], ['omgshooter', 'desert'], ['snake', 'constructor'], ['__proto__', 'x'], ['snake', 'toString']]) {
    const r = await s.intent({ game, skin, wallet: w, price: 0.01 });
    assert.equal(r.status, 400, game + ':' + skin);
  }
  assert.equal((await s.intent({ game: 'snake', skin: 'candycane', wallet: 'notawallet' })).status, 400);
  assert.equal((await s.intent({ game: { toString: 1 }, skin: 'candycane', wallet: w })).status, 400);
  assert.equal((await s.intent(null)).status, 400);
});

test('intent: paused or not ready sells nothing; owned answers owned', async () => {
  const p = Keypair.generate();
  assert.equal((await shop({ paused: () => true }).s.intent({ game: 'snake', skin: 'candycane', wallet: p.publicKey.toBase58() })).status, 503);
  assert.equal((await shop({ ready: () => false }).s.intent({ game: 'snake', skin: 'candycane', wallet: p.publicKey.toBase58() })).status, 503);
  const { s, store } = shop();
  store.ownedMap.set(p.publicKey.toBase58(), new Set(['snake:candycane']));
  const r = await s.intent({ game: 'snake', skin: 'candycane', wallet: p.publicKey.toBase58() });
  assert.deepEqual(r.body, { owned: true, item: 'snake:candycane' });
});

test('a price change closes the old open row: the quote is always today\'s price', async () => {
  const { s, store } = shop();
  const p = Keypair.generate();
  const q = await openFor(s, p);
  store.rows.get(q.ref).units = '3000000';          // opened before Owen changed the price list
  const q2 = await openFor(s, p);
  assert.notEqual(q2.ref, q.ref);
  assert.equal(q2.units, '1000000');
  assert.equal(store.rows.get(q.ref).state, 'expired');
});

test('a double click opens one row: the second intent gets the same ref', async () => {
  const { s } = shop();
  const p = Keypair.generate();
  const [a, b] = await Promise.all([openFor(s, p), openFor(s, p)]);
  assert.equal(a.ref, b.ref);
});

test('happy path: checked, claimed, sent once, verified, owned, one ledger row', async () => {
  const { s, store, chain, paid } = shop();
  const p = Keypair.generate();
  const q = await openFor(s, p);
  const raw = payTx(p, { ref: q.ref });
  const sig = willLand(chain, raw, 1000000n);
  const r = await s.buy({ ref: q.ref, signedTx: b64(raw) });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, state: 'paid', item: 'snake:candycane' });
  assert.equal(chain.sent.length, 1);
  assert.ok(store.ownedMap.get(p.publicKey.toBase58()).has('snake:candycane'));
  assert.equal(store.ledger.length, 1);
  assert.equal(store.ledger[0].amount, 1);
  assert.equal(store.ledger[0].sig, sig);
  assert.equal(paid.length, 1);
  // The same bytes again: answered paid, nothing sent.
  const again = await s.buy({ ref: q.ref, signedTx: b64(raw) });
  assert.equal(again.body.state, 'paid');
  assert.equal(chain.sent.length, 1);
  // A new intent for an owned skin: owned, no new row to pay.
  assert.equal((await s.intent({ game: 'snake', skin: 'candycane', wallet: p.publicKey.toBase58() })).body.owned, true);
});

test('bytes that are not exactly this payment are refused BEFORE anything is sent', async () => {
  const p = Keypair.generate();
  const other = Keypair.generate();
  const cases = {
    'short amount': (ref) => payTx(p, { ref, units: 999999n }),
    'over amount': (ref) => payTx(p, { ref, units: 2000000n }),
    'wrong destination': (ref) => payTx(p, { ref, dest: getAssociatedTokenAddressSync(MINT, other.publicKey) }),
    'wrong mint': (ref) => payTx(p, { ref, mint: Keypair.generate().publicKey, dest: REVENUE_ATA }),
    'no memo': (ref) => payTx(p, { ref, noMemo: true }),
    'another ref in the memo': () => payTx(p, { ref: '1111111111111111111111' }),
    'two payments': (ref) => payTx(p, { ref, twice: true }),
    'an extra SOL transfer out': (ref) => payTx(p, { ref, extra: [SystemProgram.transfer({ fromPubkey: p.publicKey, toPubkey: other.publicKey, lamports: 5 })] }),
    'another wallet pays': (ref) => payTx(other, { ref }),
  };
  for (const [name, build] of Object.entries(cases)) {
    const { s, chain, store } = shop();
    const q = await openFor(s, p);
    const r = await s.buy({ ref: q.ref, signedTx: b64(build(q.ref)) });
    assert.equal(r.status, 400, name);
    assert.equal(chain.sent.length, 0, name + ': nothing sent');
    assert.equal(store.rows.get(q.ref).state, 'open', name + ': row still open');
  }
});

test('unsigned or garbage bytes are refused unsent; malformed bodies are 400', async () => {
  const { s, chain } = shop();
  const p = Keypair.generate();
  const q = await openFor(s, p);
  const tx = new Transaction();
  tx.feePayer = p.publicKey;
  tx.recentBlockhash = BLOCKHASH;
  tx.add(new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM), keys: [], data: Buffer.from('ds-skin:' + q.ref) }));
  const unsigned = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  assert.equal((await s.buy({ ref: q.ref, signedTx: b64(unsigned) })).status, 400);
  assert.equal((await s.buy({ ref: q.ref, signedTx: 'AAAA' })).status, 400);
  assert.equal((await s.buy({ ref: q.ref, signedTx: 'x'.repeat(5000) })).status, 400);
  assert.equal((await s.buy({ ref: '../etc', signedTx: 'AAAA' })).status, 400);
  assert.equal((await s.buy({ ref: { toString: 1 }, signedTx: 'AAAA' })).status, 400);
  assert.equal((await s.buy({ ref: '1111111111111111111111', signedTx: 'AAAA' })).status, 404);
  assert.equal(chain.sent.length, 0);
});

test('a double submit of the same bytes sends once and grants once', async () => {
  const { s, chain, store, paid } = shop();
  const p = Keypair.generate();
  const q = await openFor(s, p);
  const raw = payTx(p, { ref: q.ref });
  willLand(chain, raw, 1000000n);
  const [a, b] = await Promise.all([s.buy({ ref: q.ref, signedTx: b64(raw) }), s.buy({ ref: q.ref, signedTx: b64(raw) })]);
  assert.equal(chain.sent.length, 1);
  assert.equal(paid.length, 1);
  assert.equal(store.ledger.length, 1);
  assert.ok([a.status, b.status].includes(200));
});

test('a second, different payment for a row already on its way is refused unsent', async () => {
  const { s, chain } = shop({ confirmMs: 0 });
  const p = Keypair.generate();
  const q = await openFor(s, p);
  const first = payTx(p, { ref: q.ref });
  const r1 = await s.buy({ ref: q.ref, signedTx: b64(first) });     // never lands yet: pending
  assert.equal(r1.status, 202);
  const second = payTx(p, { ref: q.ref, extra: [new TransactionInstruction({ programId: new PublicKey('ComputeBudget111111111111111111111111111111'), keys: [], data: Buffer.from([3, 1, 0, 0, 0, 0, 0, 0, 0]) })] });
  const r2 = await s.buy({ ref: q.ref, signedTx: b64(second) });
  assert.equal(r2.status, 409);
  assert.equal(chain.sent.length, 1);
  // And a new intent for the same skin points at the payment on its way, not a new row.
  const r3 = await s.intent({ game: 'snake', skin: 'candycane', wallet: p.publicKey.toBase58() });
  assert.deepEqual(r3.body, { pending: true, ref: q.ref, item: 'snake:candycane' });
});

test('a preflight refusal (no USDC) reopens the row: nothing moved, the player can try again', async () => {
  const { s, chain, store } = shop();
  const p = Keypair.generate();
  const q = await openFor(s, p);
  chain.sendError = new Error('failed to send transaction: Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1');
  const r = await s.buy({ ref: q.ref, signedTx: b64(payTx(p, { ref: q.ref })) });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Not enough USDC/);
  assert.equal(store.rows.get(q.ref).state, 'open');
  chain.sendError = null;
  const raw = payTx(p, { ref: q.ref, extra: [new TransactionInstruction({ programId: new PublicKey('ComputeBudget111111111111111111111111111111'), keys: [], data: Buffer.from([2, 64, 13, 3, 0]) })] });
  willLand(chain, raw, 1000000n);
  assert.equal((await s.buy({ ref: q.ref, signedTx: b64(raw) })).body.state, 'paid');
});

test('no SOL for the fee says so', async () => {
  const { s, chain } = shop();
  const p = Keypair.generate();
  const q = await openFor(s, p);
  chain.sendError = new Error('Transaction simulation failed: Attempt to debit an account but found no record of a prior credit.');
  const r = await s.buy({ ref: q.ref, signedTx: b64(payTx(p, { ref: q.ref })) });
  assert.match(r.body.error, /SOL for the network fee/);
});

test('an unclear send that lands later is granted by the page asking again or by the sweep, once', async () => {
  const { s, chain, store, paid } = shop({ confirmMs: 0 });
  const p = Keypair.generate();
  const q = await openFor(s, p);
  chain.sendError = new Error('fetch failed: ETIMEDOUT');
  const raw = payTx(p, { ref: q.ref });
  const r = await s.buy({ ref: q.ref, signedTx: b64(raw) });
  assert.equal(r.status, 202);
  assert.equal(store.rows.get(q.ref).state, 'submitted');
  // Still nowhere: the page hears pending.
  assert.equal((await s.purchase(q.ref)).body.state, 'pending');
  willLand(chain, raw, 1000000n);
  // The sweep and a reloaded page race: one grant.
  const [sw, pg] = await Promise.all([s.sweep(), s.purchase(q.ref)]);
  assert.ok(sw.settled === 1 || pg.body.state === 'paid' || pg.body.state === 'pending');
  await s.sweep();
  assert.equal(store.rows.get(q.ref).state, 'paid');
  assert.equal(paid.length, 1);
  assert.equal(store.ledger.length, 1);
});

test('failed on-chain closes the row failed, nothing owned', async () => {
  const { s, chain, store } = shop();
  const p = Keypair.generate();
  const q = await openFor(s, p);
  const raw = payTx(p, { ref: q.ref });
  chain.outcome.set(Wallet.stakeTxInfo(raw).signature, { status: 'failed' });
  const r = await s.buy({ ref: q.ref, signedTx: b64(raw) });
  assert.equal(r.body.state, 'failed');
  assert.equal(store.rows.get(q.ref).state, 'failed');
  assert.equal(store.ownedMap.size, 0);
  // The wallet can start again with a new row.
  const q2 = await openFor(s, p);
  assert.notEqual(q2.ref, q.ref);
});

test('never landed and its blockhash expired: expired; the same signature can never settle another row', async () => {
  const { s, chain, store } = shop({ confirmMs: 0 });
  const p = Keypair.generate();
  const q = await openFor(s, p);
  const raw = payTx(p, { ref: q.ref });
  assert.equal((await s.buy({ ref: q.ref, signedTx: b64(raw) })).status, 202);
  chain.blockhashOk = false;
  await s.sweep();
  assert.equal(store.rows.get(q.ref).state, 'expired');
  const q2 = await openFor(s, p);
  // Old bytes against the new row: refused (its memo names the old ref), nothing sent.
  const sent = chain.sent.length;
  assert.equal((await s.buy({ ref: q2.ref, signedTx: b64(raw) })).status, 400);
  assert.equal(chain.sent.length, sent);
});

test('a landed tx that does not show the payment is never granted (review)', async () => {
  const { s, chain, store, paid } = shop();
  const p = Keypair.generate();
  const q = await openFor(s, p);
  const raw = payTx(p, { ref: q.ref });
  willLand(chain, raw, 999999n);           // the chain shows less than the price arriving
  const r = await s.buy({ ref: q.ref, signedTx: b64(raw) });
  assert.equal(r.body.state, 'review');
  assert.equal(store.rows.get(q.ref).state, 'review');
  assert.equal(paid.length, 0);
  assert.equal(store.ownedMap.size, 0);
});

test('a node a little behind (status landed, transaction not readable yet) stays pending, then grants', async () => {
  const { s, chain, store } = shop({ confirmMs: 0 });
  const p = Keypair.generate();
  const q = await openFor(s, p);
  const raw = payTx(p, { ref: q.ref });
  const sig = Wallet.stakeTxInfo(raw).signature;
  chain.outcome.set(sig, { status: 'landed', tx: null });
  assert.equal((await s.buy({ ref: q.ref, signedTx: b64(raw) })).status, 202);
  chain.outcome.set(sig, { status: 'landed', tx: landedOf(raw, 1000000n) });
  await s.sweep();
  assert.equal(store.rows.get(q.ref).state, 'paid');
});

test('owned items list and malformed wallet', async () => {
  const { s, store } = shop();
  const w = Keypair.generate().publicKey.toBase58();
  store.ownedMap.set(w, new Set(['snake:candycane', 'paper:gold']));
  assert.deepEqual((await s.owned(w)).body.items.sort(), ['paper:gold', 'snake:candycane']);
  assert.equal((await s.owned('x'.repeat(200))).status, 400);
  assert.equal((await s.owned(undefined)).status, 400);
});

test('paymentProblem and landedProblem on their own', () => {
  const p = Keypair.generate();
  const ref = '2222222222222222222222';
  const expect = { wallet: p.publicKey.toBase58(), units: 1000000n, mint: MINT.toBase58(), revenueAta: REVENUE_ATA.toBase58(), ref };
  const raw = payTx(p, { ref });
  assert.equal(paymentProblem(raw, expect), null);
  assert.equal(paymentProblem(Buffer.from([1, 2, 3]), expect), 'not a transaction');
  assert.equal(landedProblem(landedOf(raw, 1000000n), expect).problem, null);
  assert.equal(landedProblem(landedOf(raw, 1000000n), expect).usdc, 1);
  assert.ok(landedProblem(landedOf(raw, 1000000n, { err: { InstructionError: [0, 'x'] } }), expect).problem);
  assert.ok(landedProblem(landedOf(raw, 1000000n), { ...expect, ref: '3333333333333333333333' }).problem);
  assert.ok(landedProblem(landedOf(raw, 1000000n), { ...expect, wallet: Keypair.generate().publicKey.toBase58() }).problem);
  assert.ok(landedProblem(null, expect).problem);
  assert.equal(preflightRefused(new Error('Transaction simulation failed: insufficient funds')), true);
  assert.equal(preflightRefused(new Error('fetch failed')), false);
  assert.equal(preflightRefused(new Error('Transaction simulation failed ... ETIMEDOUT')), false);
});

test('the wallet widget builds exactly the payment the server accepts (skinPay.mjs from a real quote)', async () => {
  const { buildSkinPayment } = await import('../wallet-widget/src/skinPay.mjs');
  const { s } = shop();
  const p = Keypair.generate();
  const q = await openFor(s, p, 'paper', 'gold');
  const unsigned = buildSkinPayment(q, p.publicKey.toBase58());
  const tx = Transaction.from(Buffer.from(unsigned));
  tx.sign(p);
  const expect = { wallet: p.publicKey.toBase58(), units: 5000000n, mint: MINT.toBase58(), revenueAta: REVENUE_ATA.toBase58(), ref: q.ref };
  assert.equal(paymentProblem(tx.serialize(), expect), null);
  // A quote that was tampered with on the way is refused before anything is signed.
  assert.throws(() => buildSkinPayment({ ...q, memo: 'ds-skin:other' }, p.publicKey.toBase58()));
  assert.throws(() => buildSkinPayment({ ...q, units: '-5' }, p.publicKey.toBase58()));
  assert.throws(() => buildSkinPayment(q, ''));
});

test('the lobby flow: intent, sign, buy, owned; a reload mid-purchase resumes; cancel sends nothing', async () => {
  const { createSkinBuy } = require('../public/js/v2/skinBuy.js');
  const { buildSkinPayment } = await import('../wallet-widget/src/skinPay.mjs');
  let clock = 1e12;
  const { s, chain, store } = shop({ now: () => clock });
  const p = Keypair.generate();
  const w = p.publicKey.toBase58();
  // fetch against the shop's own functions, the way the routes call them; every call is 4 s later (the server asks
  // the chain for one purchase at most once per 3 s)
  const fetch = async (url, o) => {
    clock += 4000;
    const body = o && o.body ? JSON.parse(o.body) : null;
    let r;
    if (url === '/api/skins/intent') r = await s.intent(body);
    else if (url === '/api/skins/buy') r = await s.buy(body);
    else if (url.startsWith('/api/skins/purchase/')) r = await s.purchase(decodeURIComponent(url.split('/').pop()));
    else if (url.startsWith('/api/skins/owned')) r = await s.owned(decodeURIComponent(url.split('=')[1]));
    else r = { status: 404, body: {} };
    return { status: r.status, json: async () => r.body };
  };
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  const signSkin = async (q) => {
    const tx = Transaction.from(Buffer.from(buildSkinPayment(q, w)));
    tx.sign(p);
    const raw = tx.serialize();
    willLand(chain, raw, BigInt(q.units));
    return Buffer.from(raw).toString('base64');
  };
  const ui = createSkinBuy({ fetch, storage, wallet: () => ({ address: w }), signSkin, signAction: async () => null, sleep: async () => {}, pollMs: 1 });
  await ui.refresh();
  assert.equal(ui.owns('snake', 'candycane'), false);
  const r = await ui.buy('snake', 'candycane');
  assert.deepEqual(r, { ok: true, item: 'snake:candycane' });
  assert.equal(ui.owns('snake', 'candycane'), true);
  assert.equal(storage.getItem('duel.skinbuy'), null, 'nothing left to resume');
  // Cancel in the wallet: nothing sent, the row stays open.
  const sentBefore = chain.sent.length;
  const ui2 = createSkinBuy({ fetch, storage, wallet: () => ({ address: w }), signSkin: async () => { throw new Error('User rejected'); }, signAction: async () => null });
  await assert.rejects(ui2.buy('snake', 'rainbow'), (e) => e.cancelled === true);
  assert.equal(chain.sent.length, sentBefore);
  // A reload after the payment went out but before the answer: the saved ref finishes it.
  chain.sendError = new Error('fetch failed');
  let late = null;
  const signLate = async (q) => {
    const tx = Transaction.from(Buffer.from(buildSkinPayment(q, w)));
    tx.sign(p);
    late = tx.serialize();
    return Buffer.from(late).toString('base64');
  };
  const ui3 = createSkinBuy({ fetch, storage, wallet: () => ({ address: w }), signSkin: signLate, signAction: async () => null, sleep: async () => {}, pollMs: 1, pollFor: 0 });
  const pending = await ui3.buy('paper', 'gold');
  assert.equal(pending.pending, true);
  assert.ok(storage.getItem('duel.skinbuy'), 'saved for the reload');
  willLand(chain, late, 5000000n);          // it lands while the page is gone
  const fresh = createSkinBuy({ fetch, storage, wallet: () => ({ address: w }), signSkin, signAction: async () => null, sleep: async () => {}, pollMs: 1 });
  const done = await fresh.resume();
  assert.equal(done.ok, true);
  assert.equal(done.game, 'paper');
  assert.ok(store.ownedMap.get(w).has('paper:gold'));
});

test('skin pass: genuine, listing the item, unexpired, or the free look', () => {
  let t = 1000;
  const sp = createSkinPass({ secret: 'test secret', now: () => t, ttlMs: 5000 });
  const w = Keypair.generate().publicKey.toBase58();
  const { pass } = sp.mint(w, ['snake:candycane', 'paper:gold']);
  assert.equal(sp.wornSkin('snake', 'candycane', pass), 'candycane');
  assert.equal(sp.wornSkin('paper', 'gold', pass), 'gold');
  assert.equal(sp.wornFrom('paper', { shop: 'gold', skinPass: pass }), 'gold');
  assert.equal(sp.wornSkin('snake', 'rainbow', pass), null);          // not owned
  assert.equal(sp.wornSkin('knockout', 'gold', pass), null);          // owned in another game only
  assert.equal(sp.wornSkin('snake', 'nope', pass), null);
  assert.equal(sp.wornSkin('snake', 'candycane', ''), null);
  assert.equal(sp.wornSkin('snake', 'candycane', undefined), null);
  assert.equal(sp.wornFrom('snake', null), null);
  // Edited payload, same mac: refused.
  const [body, mac] = pass.split('.');
  const forged = Buffer.from(JSON.stringify({ v: 1, w, i: ['snake:rainbow'], x: 999999 })).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  assert.equal(sp.wornSkin('snake', 'rainbow', forged + '.' + mac), null);
  assert.equal(sp.read(body + '.' + mac + 'x'), null);
  // Another server's key: refused.
  const other = createSkinPass({ secret: 'other', now: () => t });
  assert.equal(other.wornSkin('snake', 'candycane', pass), null);
  // Expired.
  t += 6000;
  assert.equal(sp.wornSkin('snake', 'candycane', pass), null);
  assert.equal(sp.read('a'.repeat(5000)), null);
});
