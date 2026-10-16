'use strict';
/* SOL and USDC in the player's own wallet (server/swap.js, Owen 2026-10-15 "Accept both, play in
   USDC"). Every check that stands between Jupiter's transaction and the player's signature, each
   tried against a fake that breaks exactly one rule:
   - the order must be for what was asked (mints, amount, taker), floor within 1%, fee and price
     impact capped; a floor under the cap is asked for again with our cap, once;
   - the reserve: 0.005 SOL is never converted away;
   - the simulation, read as balances: less USDC than the floor, more SOL than asked, a new
     delegate or close authority, a drained or closed token account, a wallet that stops being a
     plain wallet, all refuse; a simulation that fails is asked for again without the RFQ router;
   - execute sends only the approved message, signed by the wallet, once, before the price expires;
   - Withdraw as SOL: the receiver gets at least the floor, the wallet loses no more than asked;
   - the Jupiter client spaces orders to the keyless limit and maps its failures to plain words. */
const test = require('node:test');
const assert = require('node:assert');
const { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } = require('@solana/web3.js');
const { getAssociatedTokenAddressSync } = require('@solana/spl-token');
const S = require('../server/swap');

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BLOCKHASH = '11111111111111111111111111111111';
const LAMPORTS = 100_000_000n;           // 0.1 SOL in the wallet before

function tokenData({ mint, owner, amount, delegate = null, closeAuthority = null }) {
  const b = Buffer.alloc(165);
  new PublicKey(mint).toBuffer().copy(b, 0);
  new PublicKey(owner).toBuffer().copy(b, 32);
  b.writeBigUInt64LE(BigInt(amount), 64);
  if (delegate) { b.writeUInt32LE(1, 72); new PublicKey(delegate).toBuffer().copy(b, 76); }
  b[108] = 1;
  if (closeAuthority) { b.writeUInt32LE(1, 129); new PublicKey(closeAuthority).toBuffer().copy(b, 133); }
  return b;
}
const sysAcct = (lamports) => ({ lamports: BigInt(lamports), owner: S.SYSTEM_PROGRAM, data: Buffer.alloc(0) });
const tokAcct = (fields) => ({ lamports: 2_039_280n, owner: S.TOKEN_PROGRAMS[0], data: tokenData(fields) });

/* A real v0 transaction for `payer`, unsigned, as Jupiter hands it over. */
function unsignedTx(payer, extraSigner) {
  const ix = SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 });
  const ixs = [ix];
  if (extraSigner) ixs.unshift(SystemProgram.transfer({ fromPubkey: extraSigner.publicKey, toPubkey: payer.publicKey, lamports: 1 }));
  const msg = new TransactionMessage({ payerKey: extraSigner ? extraSigner.publicKey : payer.publicKey, recentBlockhash: BLOCKHASH, instructions: ixs }).compileToV0Message();
  return new VersionedTransaction(msg);
}
const b64 = (tx) => Buffer.from(tx.serialize()).toString('base64');

/* One wallet with a USDC account and a second token account, a Jupiter that answers what it is
   told, and a chain whose simulation is whatever the test says the transaction does. */
function world(opts = {}) {
  const kp = Keypair.generate();
  const wallet = kp.publicKey.toBase58();
  const usdcAta = getAssociatedTokenAddressSync(new PublicKey(USDC), kp.publicKey).toBase58();
  const otherMint = Keypair.generate().publicKey.toBase58();
  const otherAta = Keypair.generate().publicKey.toBase58();
  const receiver = Keypair.generate().publicKey.toBase58();
  const usdcBefore = 'usdcBefore' in opts ? opts.usdcBefore : 0n;
  const pre = {
    [wallet]: sysAcct(opts.lamports != null ? opts.lamports : LAMPORTS),
    [usdcAta]: usdcBefore === null ? null : tokAcct({ mint: USDC, owner: wallet, amount: usdcBefore }),
    [receiver]: sysAcct(1_000_000_000n),
  };
  const tokens = [{ address: otherAta, account: tokAcct({ mint: otherMint, owner: wallet, amount: 500n }) }];
  if (pre[usdcAta]) tokens.push({ address: usdcAta, account: pre[usdcAta] });
  const tx = opts.tx || unsignedTx(kp);
  const calls = { order: [], execute: [], simulate: 0 };
  const orderFor = (p) => Object.assign({
    inputMint: p.inputMint, outputMint: p.outputMint, inAmount: p.amount, taker: p.taker,
    outAmount: '10500000', otherAmountThreshold: '10450000', swapMode: 'ExactIn', feeBps: 2,
    priceImpact: -0.01, router: 'metis', requestId: 'req-' + (calls.order.length), transaction: b64(tx),
  }, typeof opts.order === 'function' ? opts.order(p, calls.order.length) : (opts.order || {}));
  const jupiter = {
    async order(p) { calls.order.push(p); return orderFor(p); },
    async execute(body) { calls.execute.push(body); return opts.exec ? opts.exec(body) : { status: 'Success', code: 0, signature: '5'.repeat(88), totalInputAmount: '50000000', totalOutputAmount: '10480000' }; },
  };
  // What the transaction does, as post-state: by default a clean SOL -> USDC fill.
  const effect = opts.effect || ((post, ctx) => {
    post[wallet] = sysAcct(ctx.pre[wallet].lamports - 50_000_000n - 5_000n);
    post[usdcAta] = tokAcct({ mint: USDC, owner: wallet, amount: 10_480_000n });
  });
  const chain = {
    async getAccounts(addrs) { return addrs.map((a) => pre[a] || null); },
    async getTokenAccounts() { return tokens; },
    async simulate(t, addrs) {
      calls.simulate++;
      if (opts.simErr && opts.simErr(calls.simulate)) return { err: { InstructionError: [0, 'Custom'] }, accounts: [] };
      const post = {};
      for (const a of addrs) post[a] = pre[a] || (tokens.find((x) => x.address === a) || {}).account || null;
      effect(post, { pre, wallet, usdcAta, otherAta, receiver });
      return { err: null, accounts: addrs.map((a) => post[a] || null) };
    },
  };
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const swap = S.createSwap({ chain, jupiter, usdcMint: () => USDC, now: clock.now });
  return { kp, wallet, usdcAta, otherAta, receiver, tx, calls, swap, clock, pre };
}

async function refuses(p, re) {
  await assert.rejects(p, (e) => { assert.ok(e instanceof S.SwapError, 'a SwapError, got ' + e); assert.match(e.publicMessage, re); return true; });
}

test('toUsdc: a clean quote returns the floor and remembers the approved message', async () => {
  const w = world();
  const q = await w.swap.quote({ wallet: w.wallet, dir: 'toUsdc', amount: '50000000' });
  assert.strictEqual(q.minOut, '10450000');
  assert.strictEqual(q.outAmount, '10500000');
  assert.strictEqual(q.inAmount, '50000000');
  assert.strictEqual(w.calls.order.length, 1);
  assert.deepStrictEqual(Object.keys(w.calls.order[0]).sort(), ['amount', 'inputMint', 'outputMint', 'taker']);
  assert.strictEqual(w.calls.order[0].inputMint, S.SOL_MINT);
  assert.strictEqual(w.calls.order[0].outputMint, USDC);
  assert.ok(w.swap._pending.has(q.requestId));
});

test('the reserve: 0.005 SOL is never converted away', async () => {
  const w = world();
  await refuses(w.swap.quote({ wallet: w.wallet, dir: 'toUsdc', amount: String(LAMPORTS - 4_999_999n) }), /Keep 0\.005 SOL.*0\.0950 SOL/);
  const poor = world({ lamports: 5_500_000n });
  await refuses(poor.swap.quote({ wallet: poor.wallet, dir: 'toUsdc', amount: '1000000' }), /no SOL to convert/);
  await refuses(w.swap.quote({ wallet: w.wallet, dir: 'toUsdc', amount: '999999' }), /smallest conversion/);
  assert.strictEqual(w.calls.order.length + poor.calls.order.length, 0, 'refused before Jupiter is asked');
});

test('bad requests are refused before anything is asked', async () => {
  const w = world();
  await refuses(w.swap.quote({ wallet: 'nope', dir: 'toUsdc', amount: '50000000' }), /wallet address is not valid/);
  await refuses(w.swap.quote({ wallet: w.wallet, dir: 'sideways', amount: '50000000' }), /Unknown conversion/);
  await refuses(w.swap.quote({ wallet: w.wallet, dir: 'toUsdc', amount: '-5' }), /Enter an amount/);
  await refuses(w.swap.quote({ wallet: w.wallet, dir: 'toUsdc', amount: '1e9' }), /Enter an amount/);
  await refuses(w.swap.quote({ wallet: w.wallet, dir: 'toUsdc', amount: '50000000', receiver: w.receiver }), /stays in your own wallet/);
  assert.strictEqual(w.calls.order.length, 0);
});

test('an order for something else is refused', async () => {
  for (const [order, re] of [
    [{ inAmount: '49000000' }, /different amount/],
    [{ outputMint: S.SOL_MINT }, /different swap/],
    [{ taker: Keypair.generate().publicKey.toBase58() }, /different wallet/],
    [{ swapMode: 'ExactOut' }, /different swap/],
    [{ feeBps: 60 }, /fee for that swap is too high/],
    [{ priceImpact: -1.5 }, /move the price too much/],
    [{ otherAmountThreshold: '10600000' }, /No price/],
    [{ transaction: '', errorCode: 2 }, /not enough SOL in your wallet for the network fee/],
    [{ transaction: '' }, /no price for that amount/],
    [{ requestId: 'bad id!' }, /No price/],
  ]) {
    const w = world({ order });
    await refuses(w.swap.quote({ wallet: w.wallet, dir: 'toUsdc', amount: '50000000' }), re);
    assert.strictEqual(w.swap._pending.size, 0);
  }
});

test('a floor more than 1% under the quote is asked for again with our cap, once', async () => {
  const w = world({ order: (p, n) => (n === 1 ? { otherAmountThreshold: '10300000' } : {}) });
  const q = await w.swap.quote({ wallet: w.wallet, dir: 'toUsdc', amount: '50000000' });
  assert.strictEqual(w.calls.order.length, 2);
  assert.strictEqual(w.calls.order[1].slippageBps, '100');
  assert.strictEqual(w.calls.order[1].excludeRouters, undefined);
  assert.strictEqual(q.minOut, '10450000');
  const still = world({ order: { otherAmountThreshold: '10300000' } });
  await refuses(still.swap.quote({ wallet: still.wallet, dir: 'toUsdc', amount: '50000000' }), /moving too much/);
  assert.strictEqual(still.calls.order.length, 2);
});

test('a failed simulation is asked for again without the RFQ router, then refused', async () => {
  const once = world({ simErr: (n) => n === 1 });
  await once.swap.quote({ wallet: once.wallet, dir: 'toUsdc', amount: '50000000' });
  assert.strictEqual(once.calls.order[1].excludeRouters, 'jupiterz');
  const always = world({ simErr: () => true });
  await refuses(always.swap.quote({ wallet: always.wallet, dir: 'toUsdc', amount: '50000000' }), /would not go through/);
  assert.strictEqual(always.calls.order.length, 2);
});

test('a transaction that is not for this wallet is refused', async () => {
  const w = world({ tx: unsignedTx(Keypair.generate()) });
  await refuses(w.swap.quote({ wallet: w.wallet, dir: 'toUsdc', amount: '50000000' }), /not for your wallet/);
  const junk = world({ order: { transaction: Buffer.from('not a tx').toString('base64') } });
  await refuses(junk.swap.quote({ wallet: junk.wallet, dir: 'toUsdc', amount: '50000000' }), /not a conversion transaction/);
});

test('a gasless order (Jupiter pays the fee, the wallet signs second) is accepted', async () => {
  const kp = Keypair.generate();
  const f = S.txFacts(b64(unsignedTx(kp, Keypair.generate())), kp.publicKey.toBase58());
  assert.strictEqual(f.signerIdx, 1);
});

test('the simulation, read as balances: each broken rule refuses', async () => {
  const cases = [
    ['less USDC than the floor', (post, c) => { post[c.wallet] = sysAcct(c.pre[c.wallet].lamports - 50_005_000n); post[c.usdcAta] = tokAcct({ mint: USDC, owner: c.wallet, amount: 10_449_999n }); }, /less USDC than quoted/],
    ['no USDC account after', (post, c) => { post[c.wallet] = sysAcct(c.pre[c.wallet].lamports - 50_005_000n); }, /less USDC than quoted/],
    ['more SOL than asked', (post, c) => { post[c.wallet] = sysAcct(c.pre[c.wallet].lamports - 54_000_001n); post[c.usdcAta] = tokAcct({ mint: USDC, owner: c.wallet, amount: 10_480_000n }); }, /more SOL than you asked/],
    ['a delegate on the USDC account', (post, c) => { post[c.wallet] = sysAcct(c.pre[c.wallet].lamports - 50_005_000n); post[c.usdcAta] = tokAcct({ mint: USDC, owner: c.wallet, amount: 10_480_000n, delegate: c.receiver }); }, /someone else spend/, { usdcBefore: 1n }],
    ['the USDC account handed over', (post, c) => { post[c.wallet] = sysAcct(c.pre[c.wallet].lamports - 50_005_000n); post[c.usdcAta] = tokAcct({ mint: USDC, owner: c.receiver, amount: 10_480_000n }); }, /someone else/, { usdcBefore: 1n }],
    ['a new USDC account owned by someone else', (post, c) => { post[c.wallet] = sysAcct(c.pre[c.wallet].lamports - 50_005_000n); post[c.usdcAta] = tokAcct({ mint: USDC, owner: c.receiver, amount: 10_480_000n }); }, /change your USDC account/, { usdcBefore: null }],
    ['a close authority', (post, c) => { post[c.wallet] = sysAcct(c.pre[c.wallet].lamports - 50_005_000n); post[c.usdcAta] = tokAcct({ mint: USDC, owner: c.wallet, amount: 10_480_000n }); post[c.otherAta] = tokAcct({ mint: S.SOL_MINT, owner: c.wallet, amount: 500n }); }, /change one of your token accounts/],
    ['another token drained', (post, c) => {
      post[c.wallet] = sysAcct(c.pre[c.wallet].lamports - 50_005_000n);
      post[c.usdcAta] = tokAcct({ mint: USDC, owner: c.wallet, amount: 10_480_000n });
      const t = S.readTokenAccount(post[c.otherAta].data);
      post[c.otherAta] = tokAcct({ mint: t.mint, owner: c.wallet, amount: 499n });
    }, /take tokens it should not/],
    ['another token closed', (post, c) => { post[c.wallet] = sysAcct(c.pre[c.wallet].lamports - 50_005_000n); post[c.usdcAta] = tokAcct({ mint: USDC, owner: c.wallet, amount: 10_480_000n }); post[c.otherAta] = null; }, /close one of your token accounts/],
    ['the wallet assigned to a program', (post, c) => { post[c.wallet] = { lamports: c.pre[c.wallet].lamports - 50_005_000n, owner: S.TOKEN_PROGRAMS[0], data: Buffer.alloc(0) }; post[c.usdcAta] = tokAcct({ mint: USDC, owner: c.wallet, amount: 10_480_000n }); }, /change your wallet/],
  ];
  for (const [name, effect, re, extra] of cases) {
    const w = world(Object.assign({ effect }, extra || {}));
    await refuses(w.swap.quote({ wallet: w.wallet, dir: 'toUsdc', amount: '50000000' }), re).catch((e) => { throw new Error(name + ': ' + e.message); });
    assert.strictEqual(w.swap._pending.size, 0, name);
  }
});

test('execute: only the approved message, signed by the wallet, once, before it expires', async () => {
  const w = world();
  const q = await w.swap.quote({ wallet: w.wallet, dir: 'toUsdc', amount: '50000000' });
  // Unsigned: refused, and the price is still there for the real signature.
  await refuses(w.swap.execute({ requestId: q.requestId, signedTransaction: q.transaction }), /not signed by your wallet/);
  // A different message signed by the wallet: refused.
  const other = unsignedTx(w.kp); other.sign([w.kp]);
  await refuses(w.swap.execute({ requestId: q.requestId, signedTransaction: b64(other) }), /not the conversion you were shown/);
  // Signed by someone else over the right message: refused.
  const forged = VersionedTransaction.deserialize(Buffer.from(q.transaction, 'base64'));
  forged.signatures[0] = Keypair.generate().secretKey.slice(0, 64);
  await refuses(w.swap.execute({ requestId: q.requestId, signedTransaction: b64(forged) }), /not signed by your wallet/);
  assert.strictEqual(w.calls.execute.length, 0);
  // The real one goes once.
  const good = VersionedTransaction.deserialize(Buffer.from(q.transaction, 'base64'));
  good.sign([w.kp]);
  const r = await w.swap.execute({ requestId: q.requestId, signedTransaction: b64(good) });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.outAmount, '10480000');
  assert.strictEqual(w.calls.execute.length, 1);
  assert.deepStrictEqual(Object.keys(w.calls.execute[0]).sort(), ['requestId', 'signedTransaction']);
  await refuses(w.swap.execute({ requestId: q.requestId, signedTransaction: b64(good) }), /expired/);
  assert.strictEqual(w.calls.execute.length, 1, 'never sent twice');
  // Expiry.
  const late = world();
  const q2 = await late.swap.quote({ wallet: late.wallet, dir: 'toUsdc', amount: '50000000' });
  const s2 = VersionedTransaction.deserialize(Buffer.from(q2.transaction, 'base64')); s2.sign([late.kp]);
  late.clock.advance(S.RULES.QUOTE_TTL_MS + 1);
  await refuses(late.swap.execute({ requestId: q2.requestId, signedTransaction: b64(s2) }), /expired/);
  assert.strictEqual(late.calls.execute.length, 0);
  await refuses(late.swap.execute({ requestId: '../etc', signedTransaction: b64(s2) }), /not valid/);
});

test('execute: a failure from Jupiter says whether anything moved', async () => {
  for (const [res, re] of [
    [{ status: 'Failed', code: -1000 }, /Nothing was converted/],
    [{ status: 'Failed', code: -2004 }, /price changed. Nothing was converted/],
    [{ status: 'Failed', code: -1001, signature: '4'.repeat(88) }, /Check your balance/],
  ]) {
    const w = world({ exec: () => res });
    const q = await w.swap.quote({ wallet: w.wallet, dir: 'toUsdc', amount: '50000000' });
    const s = VersionedTransaction.deserialize(Buffer.from(q.transaction, 'base64')); s.sign([w.kp]);
    await refuses(w.swap.execute({ requestId: q.requestId, signedTransaction: b64(s) }), re);
  }
});

test('toSol (Withdraw as SOL): the receiver gets at least the floor, the wallet loses no more than asked', async () => {
  const ok = (post, c) => {
    post[c.usdcAta] = tokAcct({ mint: USDC, owner: c.wallet, amount: 5_000_000n });
    post[c.receiver] = sysAcct(c.pre[c.receiver].lamports + 10_460_000n);
    post[c.wallet] = sysAcct(c.pre[c.wallet].lamports - 5_000n);
  };
  const order = { outAmount: '10500000', otherAmountThreshold: '10450000' };
  const w = world({ usdcBefore: 10_000_000n, effect: ok, order });
  const q = await w.swap.quote({ wallet: w.wallet, dir: 'toSol', amount: '5000000', receiver: w.receiver });
  assert.strictEqual(w.calls.order[0].receiver, w.receiver);
  assert.strictEqual(w.calls.order[0].inputMint, USDC);
  assert.strictEqual(w.calls.order[0].outputMint, S.SOL_MINT);
  assert.strictEqual(q.receiver, w.receiver);

  const bad = [
    ['receiver short', (post, c) => { ok(post, c); post[c.receiver] = sysAcct(c.pre[c.receiver].lamports + 10_449_999n); }, /less SOL than quoted/],
    ['more USDC taken', (post, c) => { ok(post, c); post[c.usdcAta] = tokAcct({ mint: USDC, owner: c.wallet, amount: 4_999_999n }); }, /more USDC than you asked/],
    ['SOL taken from the wallet too', (post, c) => { ok(post, c); post[c.wallet] = sysAcct(c.pre[c.wallet].lamports - 4_000_001n); }, /more SOL than the network fee/],
  ];
  for (const [name, effect, re] of bad) {
    const b = world({ usdcBefore: 10_000_000n, effect, order });
    await refuses(b.swap.quote({ wallet: b.wallet, dir: 'toSol', amount: '5000000', receiver: b.receiver }), re).catch((e) => { throw new Error(name + ': ' + e.message); });
  }
  const r = world({ usdcBefore: 10_000_000n, effect: ok, order });
  await refuses(r.swap.quote({ wallet: r.wallet, dir: 'toSol', amount: '5000000' }), /not a Solana address/);
  await refuses(r.swap.quote({ wallet: r.wallet, dir: 'toSol', amount: '5000000', receiver: r.wallet }), /own address/);
  await refuses(r.swap.quote({ wallet: r.wallet, dir: 'toSol', amount: '5000000', receiver: USDC }), /not a wallet address/);
  await refuses(r.swap.quote({ wallet: r.wallet, dir: 'toSol', amount: '999999', receiver: r.receiver }), /smallest withdrawal as SOL is \$1\.00/);
  await refuses(r.swap.quote({ wallet: r.wallet, dir: 'toSol', amount: '10000001', receiver: r.receiver }), /more USDC than you have/);
  assert.strictEqual(r.calls.order.length, 0);
});

test('a wallet with more token accounts than can be checked is refused', async () => {
  const w = world();
  const chain = { async getAccounts(a) { return a.map(() => sysAcct(LAMPORTS)); },
                  async getTokenAccounts() { return Array.from({ length: S.RULES.MAX_TOKEN_ACCOUNTS + 1 }, () => ({ address: Keypair.generate().publicKey.toBase58(), account: null })); },
                  async simulate() { throw new Error('not reached'); } };
  const swap = S.createSwap({ chain, jupiter: { order() { throw new Error('not reached'); } }, usdcMint: () => USDC });
  await refuses(swap.quote({ wallet: w.wallet, dir: 'toUsdc', amount: '50000000' }), /too many token accounts/);
});

test('Jupiter client: orders are spaced to the keyless limit, the key is sent, failures are plain words', async () => {
  let t = 0; const slept = [];
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, headers: init.headers }); return { ok: true, status: 200, text: async () => '{"ok":1}' }; };
  const j = S.createJupiter({ fetchImpl, now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; } });
  await j.order({ inputMint: 'a', amount: '1' });
  await j.order({ inputMint: 'a', amount: '1' });
  assert.deepStrictEqual(slept, [2100]);
  assert.match(seen[0].url, /^https:\/\/api\.jup\.ag\/swap\/v2\/order\?inputMint=a&amount=1$/);
  assert.strictEqual(seen[0].headers['x-api-key'], undefined);
  // A queue too long is refused, not held.
  const k = S.createJupiter({ fetchImpl, now: () => 0, sleep: async () => {} });
  for (let i = 0; i < 6; i++) await k.order({});
  await refuses(k.order({}), /busy/);

  const keyed = S.createJupiter({ apiKey: 'k1', fetchImpl, now: () => 0, sleep: async () => {} });
  await keyed.execute({ requestId: 'r', signedTransaction: 's' });
  assert.strictEqual(seen[seen.length - 1].headers['x-api-key'], 'k1');
  assert.match(seen[seen.length - 1].url, /\/swap\/v2\/execute$/);

  const busy = S.createJupiter({ fetchImpl: async () => ({ ok: false, status: 429, text: async () => '{}' }), now: () => 0, sleep: async () => {} });
  await refuses(busy.order({}), /busy/);
  const down = S.createJupiter({ fetchImpl: async () => { throw new Error('ECONNRESET secret-host'); }, now: () => 0, sleep: async () => {} });
  await refuses(down.order({}), /Could not reach/);
  await refuses(down.execute({}), /still confirming/);
  // A failed execute comes back as its body, so its code can be read.
  const failed = S.createJupiter({ fetchImpl: async () => ({ ok: false, status: 400, text: async () => '{"status":"Failed","code":-1000}' }), now: () => 0, sleep: async () => {} });
  assert.deepStrictEqual(await failed.execute({}), { status: 'Failed', code: -1000 });
});

test('the routes: rate limited, USDC mode only, small bodies, and no key in what the page gets', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(src, /app\.get\('\/api\/swap\/quote', swapQuoteLimiter, async/);
  assert.match(src, /app\.post\('\/api\/swap\/execute', swapExecLimiter, express\.json\(\{ limit: '16kb' \}\), async/);
  const at = (s) => src.indexOf(s);
  const quote = src.slice(at("app.get('/api/swap/quote'"), at("app.post('/api/swap/execute'"));
  assert.match(quote, /if \(money\.mode !== 'usdc'\) return res\.status\(400\)/);
  const exec = src.slice(at("app.post('/api/swap/execute'"), at("app.post('/api/swap/execute'") + 600);
  assert.match(exec, /if \(money\.mode !== 'usdc'\) return res\.status\(400\)/);
  assert.match(src, /createJupiter\(\{ apiKey: process\.env\.JUP_API_KEY \|\| '' \}\)/);
  const cfg = src.slice(at("app.get('/api/money-config'"), at("app.get('/api/money-config'") + 900);
  assert.doesNotMatch(cfg, /JUP_API_KEY|apiKey/);
});

test('the swap module never touches the escrow, a stake or a payout', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server', 'swap.js'), 'utf8');
  assert.doesNotMatch(src, /require\(['"]\.\/(Wallet|Usdc|money|stakeLedger|entryStore|payoutDrainer)['"]\)/);
  assert.doesNotMatch(src, /ESCROW|escrow\w*\(/);
});
