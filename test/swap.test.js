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
const { Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } = require('@solana/web3.js');
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

/* Jupiter v6's route instruction in the layout real orders use (discriminator bb64facc31c4af14:
   in_amount, quoted_out_amount, slippage_bps, platform_fee_bps, positive_slippage_bps, plan). */
function jupRoute(payer, { amount, quoted, slip = 47, disc = 'bb64facc31c4af14' }) {
  const d = Buffer.alloc(disc === 'd19853937cfed8e9' ? 41 : 40);
  Buffer.from(disc, 'hex').copy(d, 0);
  const at = disc === 'd19853937cfed8e9' ? { inAt: 9, qAt: 18, sAt: 26 } : { inAt: 8, qAt: 16, sAt: 24 };
  d.writeBigUInt64LE(BigInt(amount), at.inAt);
  d.writeBigUInt64LE(BigInt(quoted), at.qAt);
  d.writeUInt16LE(slip, at.sAt);
  return new TransactionInstruction({ programId: new PublicKey(S.PROGRAMS.JUPITER), keys: [{ pubkey: payer, isSigner: true, isWritable: true }], data: d });
}
const ix = (program, data, payer) => new TransactionInstruction({ programId: new PublicKey(program), keys: [{ pubkey: payer, isSigner: true, isWritable: true }], data: Buffer.from(data) });
const cuPrice = (micro) => { const b = Buffer.alloc(9); b[0] = 3; b.writeBigUInt64LE(BigInt(micro), 1); return b; };
const cuLimit = (n) => { const b = Buffer.alloc(5); b[0] = 2; b.writeUInt32LE(n, 1); return b; };

/* A real v0 transaction for `payer`, unsigned, as Jupiter hands it over: by default the compute
   budget, wrapping the SOL, Jupiter's route for `route`, and closing the wrapped SOL. */
function unsignedTx(payer, extraSigner, route, extra) {
  const p = payer.publicKey;
  const ixs = extra || [
    ix(S.PROGRAMS.COMPUTE_BUDGET, cuLimit(200_000), p),
    ix(S.PROGRAMS.COMPUTE_BUDGET, cuPrice(20_000), p),
    SystemProgram.transfer({ fromPubkey: p, toPubkey: Keypair.generate().publicKey, lamports: 1 }),
    ix(S.TOKEN_PROGRAMS[0], [17], p),
    jupRoute(p, route || { amount: 50_000_000, quoted: 10_500_000 }),
    ix(S.TOKEN_PROGRAMS[0], [9], p),
  ];
  if (extraSigner) ixs.unshift(ix(S.PROGRAMS.JUPITERZ, [1, 2, 3], extraSigner.publicKey));
  const msg = new TransactionMessage({ payerKey: extraSigner ? extraSigner.publicKey : p, recentBlockhash: BLOCKHASH, instructions: ixs }).compileToV0Message();
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
  const calls = { order: [], execute: [], simulate: 0 };
  // The transaction follows the order: Jupiter's route for its amount and quote, unless a test hands one in.
  const orderFor = (p) => {
    const o = Object.assign({
      inputMint: p.inputMint, outputMint: p.outputMint, inAmount: p.amount, taker: p.taker,
      outAmount: '10500000', otherAmountThreshold: '10450000', swapMode: 'ExactIn', feeBps: 2,
      priceImpact: -0.01, router: 'metis', requestId: 'req-' + (calls.order.length),
    }, typeof opts.order === 'function' ? opts.order(p, calls.order.length) : (opts.order || {}));
    if (!('transaction' in o)) {
      const t = typeof opts.tx === 'function' ? opts.tx(p, o, kp) : opts.tx;
      o.transaction = b64(t || unsignedTx(kp, null, { amount: p.amount, quoted: o.outAmount }));
    }
    return o;
  };
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
  return { kp, wallet, usdcAta, otherAta, receiver, calls, swap, clock, pre };
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
  assert.deepStrictEqual(Object.keys(w.calls.order[0]).sort(), ['amount', 'excludeRouters', 'inputMint', 'outputMint', 'taker']);
  assert.strictEqual(w.calls.order[0].excludeRouters, 'dflow,okx');
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
  assert.strictEqual(w.calls.order[1].slippageBps, '50');
  assert.strictEqual(w.calls.order[1].excludeRouters, 'jupiterz,dflow,okx');
  assert.strictEqual(q.minOut, '10450000');
  const still = world({ order: { otherAmountThreshold: '10300000' } });
  await refuses(still.swap.quote({ wallet: still.wallet, dir: 'toUsdc', amount: '50000000' }), /moving too much/);
  assert.strictEqual(still.calls.order.length, 2);
});

test('a failed simulation is asked for again without the RFQ router, then refused', async () => {
  const once = world({ simErr: (n) => n === 1 });
  await once.swap.quote({ wallet: once.wallet, dir: 'toUsdc', amount: '50000000' });
  assert.strictEqual(once.calls.order[1].excludeRouters, 'jupiterz,dflow,okx');
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
    [{ status: 'Failed', code: -1000 }, /has not gone through. Check your balance in a minute/],
    [{ status: 'Failed', code: -1005 }, /expired before it went through. Nothing was converted/],
    [{ status: 'Failed', code: '__proto__' }, /did not go through. Check your balance/],
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

test('token accounts: more than can be checked is refused, but empty spam ones never count', async () => {
  const w = world();
  const many = (amount) => Array.from({ length: S.RULES.MAX_TOKEN_ACCOUNTS + 1 }, () => ({
    address: Keypair.generate().publicKey.toBase58(),
    account: tokAcct({ mint: Keypair.generate().publicKey.toBase58(), owner: w.wallet, amount }) }));
  const chainWith = (tokens) => ({ async getAccounts(a) { return a.map((x) => (x === w.wallet ? sysAcct(LAMPORTS) : null)); },
                                   async getTokenAccounts() { return tokens; },
                                   async simulate() { throw new Error('reached the simulation'); } });
  const jupiter = { async order() { throw new Error('reached Jupiter'); } };
  const full = S.createSwap({ chain: chainWith(many(1n)), jupiter, usdcMint: () => USDC });
  await refuses(full.quote({ wallet: w.wallet, dir: 'toUsdc', amount: '50000000' }), /too many token accounts/);
  // 41 empty accounts anybody could create for this wallet: not counted, so the quote goes on.
  const spam = S.createSwap({ chain: chainWith(many(0n)), jupiter, usdcMint: () => USDC });
  await assert.rejects(spam.quote({ wallet: w.wallet, dir: 'toUsdc', amount: '50000000' }), /reached Jupiter/);
});

test('the shape: only the programs Jupiter uses, its floor decoded, no nonce, no approvals', async () => {
  const p = (kp) => kp.publicKey;
  const route = (kp, o) => jupRoute(p(kp), Object.assign({ amount: 50_000_000, quoted: 10_500_000 }, o));
  const refusedThenMetis = async (name, build) => {
    const w = world({ tx: (pp, o, kp) => (pp.excludeRouters === 'jupiterz,dflow,okx' ? null : build(kp)) });
    await w.swap.quote({ wallet: w.wallet, dir: 'toUsdc', amount: '50000000' }).catch((e) => { throw new Error(name + ': ' + e.message); });
    assert.strictEqual(w.calls.order.length, 2, name + ': asked again');
    assert.strictEqual(w.calls.order[1].excludeRouters, 'jupiterz,dflow,okx', name);
    const always = world({ tx: (pp, o, kp) => build(kp) });
    await refuses(always.swap.quote({ wallet: always.wallet, dir: 'toUsdc', amount: '50000000' }), /not in a form this wallet can check/)
      .catch((e) => { throw new Error(name + ' (always): ' + e.message); });
    assert.strictEqual(always.calls.simulate, 0, name + ': never simulated, never offered');
  };
  const other = Keypair.generate().publicKey.toBase58();
  await refusedThenMetis('an unknown program', (kp) => unsignedTx(kp, null, null, [route(kp), ix(other, [1], p(kp))]));
  await refusedThenMetis('a token approval', (kp) => unsignedTx(kp, null, null, [route(kp), ix(S.TOKEN_PROGRAMS[0], [4, 1, 0, 0, 0, 0, 0, 0, 0], p(kp))]));
  await refusedThenMetis('a change of authority', (kp) => unsignedTx(kp, null, null, [route(kp), ix(S.TOKEN_PROGRAMS[0], [6, 1, 0], p(kp))]));
  await refusedThenMetis('a durable nonce', (kp) => unsignedTx(kp, null, null, [ix(S.SYSTEM_PROGRAM, Buffer.from([4, 0, 0, 0]), p(kp)), route(kp)]));
  await refusedThenMetis('a System assign', (kp) => unsignedTx(kp, null, null, [route(kp), SystemProgram.assign({ accountPubkey: p(kp), programId: new PublicKey(other) })]));
  await refusedThenMetis('a Token-2022 instruction', (kp) => unsignedTx(kp, null, null, [route(kp), ix(S.TOKEN_PROGRAMS[1], [3], p(kp))]));
  await refusedThenMetis('an unknown Jupiter instruction', (kp) => unsignedTx(kp, null, null, [route(kp, { disc: '0000000000000001' })]));
  await refusedThenMetis('a floor under the quote', (kp) => unsignedTx(kp, null, null, [route(kp, { slip: 100 })]));
  await refusedThenMetis('a different amount routed', (kp) => unsignedTx(kp, null, null, [route(kp, { amount: 49_000_000 })]));
  await refusedThenMetis('no route', (kp) => unsignedTx(kp, null, null, [SystemProgram.transfer({ fromPubkey: p(kp), toPubkey: Keypair.generate().publicKey, lamports: 1 })]));
  await refusedThenMetis('two routes', (kp) => unsignedTx(kp, null, null, [route(kp), route(kp)]));
  await refusedThenMetis('a priority fee over 0.001 SOL', (kp) => unsignedTx(kp, null, null, [
    ix(S.PROGRAMS.COMPUTE_BUDGET, cuLimit(1_400_000), p(kp)), ix(S.PROGRAMS.COMPUTE_BUDGET, cuPrice(1_000_000), p(kp)), route(kp)]));
  // The second route layout, and an RFQ fill, are read too.
  const v2 = world({ tx: (pp, o, kp) => unsignedTx(kp, null, null, [route(kp, { disc: 'd19853937cfed8e9' })]) });
  await v2.swap.quote({ wallet: v2.wallet, dir: 'toUsdc', amount: '50000000' });
  const rfq = world({ tx: (pp, o, kp) => unsignedTx(kp, null, null, [ix(S.PROGRAMS.JUPITERZ, [7, 7], p(kp))]) });
  await rfq.swap.quote({ wallet: rfq.wallet, dir: 'toUsdc', amount: '50000000' });
  assert.strictEqual(v2.calls.order.length + rfq.calls.order.length, 2, 'accepted first time');
});

test('a brand-new USDC account must come out with no delegate and no close authority', async () => {
  for (const extra of [{ delegate: true }, { closeAuthority: true }]) {
    const w = world({ usdcBefore: null, effect: (post, c) => {
      post[c.wallet] = sysAcct(c.pre[c.wallet].lamports - 52_044_280n);
      post[c.usdcAta] = tokAcct({ mint: USDC, owner: c.wallet, amount: 10_480_000n,
                                  delegate: extra.delegate ? c.receiver : null, closeAuthority: extra.closeAuthority ? c.receiver : null });
    } });
    await refuses(w.swap.quote({ wallet: w.wallet, dir: 'toUsdc', amount: '50000000' }), /someone else control your USDC account/);
  }
  const clean = world({ usdcBefore: null, effect: (post, c) => {
    post[c.wallet] = sysAcct(c.pre[c.wallet].lamports - 52_044_280n);
    post[c.usdcAta] = tokAcct({ mint: USDC, owner: c.wallet, amount: 10_480_000n });
  } });
  await clean.swap.quote({ wallet: clean.wallet, dir: 'toUsdc', amount: '50000000' });
});

test('the market price: more than 3% worse than our own feed is refused; no feed, no check', async () => {
  // 0.05 SOL for $10.50 is $210 a SOL.
  for (const [ref, ok] of [[210, true], [216, true], [217, false], [null, true], [0, true]]) {
    let threw = null;
    try { S.checkPrice('toUsdc', 50_000_000n, 10_500_000n, ref); } catch (e) { threw = e; }
    assert.strictEqual(!threw, ok, 'toUsdc at ref ' + ref);
  }
  // Withdraw as SOL: $5 for 0.0238 SOL is $210 a SOL; paying more than 3% over the feed is refused.
  assert.doesNotThrow(() => S.checkPrice('toSol', 5_000_000n, 23_809_523n, 205));
  assert.throws(() => S.checkPrice('toSol', 5_000_000n, 23_809_523n, 200), /too far from the market price/);
  // Wired into the quote: a feed far from Jupiter's price stops it before the simulation.
  const w = world();
  const swap = S.createSwap({ chain: { getAccounts: async (a) => a.map((x) => (x === w.wallet ? sysAcct(LAMPORTS) : null)),
                                       getTokenAccounts: async () => [], simulate: async () => { throw new Error('not reached'); } },
                              jupiter: { order: async (p) => ({ inputMint: p.inputMint, outputMint: p.outputMint, inAmount: p.amount, taker: p.taker,
                                outAmount: '10500000', otherAmountThreshold: '10450000', feeBps: 2, priceImpact: 0, requestId: 'r',
                                transaction: b64(unsignedTx(w.kp)) }) },
                              usdcMint: () => USDC, refSolUsd: () => 300 });
  await refuses(swap.quote({ wallet: w.wallet, dir: 'toUsdc', amount: '50000000' }), /too far from the market price/);
});

test('Withdraw as SOL goes only to a plain wallet address', async () => {
  const w = world({ usdcBefore: 10_000_000n });
  const ata = getAssociatedTokenAddressSync(new PublicKey(USDC), Keypair.generate().publicKey).toBase58();   // off the curve
  await refuses(w.swap.quote({ wallet: w.wallet, dir: 'toSol', amount: '5000000', receiver: ata }), /not a wallet/);
  const tokenAccount = Keypair.generate().publicKey.toBase58();   // on the curve, but a token account
  const t = world({ usdcBefore: 10_000_000n });
  t.pre[tokenAccount] = tokAcct({ mint: USDC, owner: Keypair.generate().publicKey.toBase58(), amount: 1n });
  await refuses(t.swap.quote({ wallet: t.wallet, dir: 'toSol', amount: '5000000', receiver: tokenAccount }), /not a wallet/);
  assert.strictEqual(w.calls.order.length + t.calls.order.length, 0);
});

test('a wallet\'s prices cannot be asked for faster than a person would', async () => {
  const w = world();
  for (let i = 0; i < S.RULES.QUOTES_PER_WALLET_MIN; i++) await w.swap.quote({ wallet: w.wallet, dir: 'toUsdc', amount: '50000000' });
  await refuses(w.swap.quote({ wallet: w.wallet, dir: 'toUsdc', amount: '50000000' }), /Too many prices/);
  w.clock.advance(60_001);
  await w.swap.quote({ wallet: w.wallet, dir: 'toUsdc', amount: '50000000' });
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
