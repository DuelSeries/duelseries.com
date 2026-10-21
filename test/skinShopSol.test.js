'use strict';
// Skins paid in SOL (SOL mode): the signed bytes must be exactly one plain SOL transfer of the row's lamports from the
// wallet to the revenue wallet, plus the memo; what landed is read from that transaction's own balances.
const test = require('node:test');
const assert = require('node:assert');
const { Keypair, Transaction, SystemProgram, TransactionInstruction, PublicKey, ComputeBudgetProgram } = require('@solana/web3.js');
const { paymentProblem, landedProblem, memoFor, MEMO_PROGRAM } = require('../server/skinShop');

const kp = Keypair.generate();
const wallet = kp.publicKey.toBase58();
const revenue = Keypair.generate().publicKey.toBase58();
const ref = 'Abcdefghijkmnopq';
const expect = { wallet, units: 9_295_000n, asset: 'sol', revenueWallet: revenue, ref, usdMicro: '1000000' };

function signed(ixs) {
  const tx = new Transaction();
  ixs.forEach((ix) => tx.add(ix));
  tx.recentBlockhash = '11111111111111111111111111111111';
  tx.feePayer = kp.publicKey;
  tx.sign(kp);
  return tx.serialize();
}
const memo = (text) => new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM), keys: [], data: Buffer.from(text, 'utf8') });
const pay = (lamports, to = revenue) => SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new PublicKey(to), lamports });

test('the exact SOL payment passes; anything else is refused before it is sent', () => {
  const cu = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100000 });
  assert.strictEqual(paymentProblem(signed([cu, pay(9_295_000), memo(memoFor(ref))]), expect), null);
  assert.strictEqual(paymentProblem(signed([pay(9_294_999), memo(memoFor(ref))]), expect), 'not the price');
  assert.strictEqual(paymentProblem(signed([pay(9_295_000, Keypair.generate().publicKey.toBase58()), memo(memoFor(ref))]), expect), 'not paid to the shop');
  assert.strictEqual(paymentProblem(signed([pay(9_295_000), memo('ds-skin:other')]), expect), 'the memo does not name this purchase');
  assert.notStrictEqual(paymentProblem(signed([pay(9_295_000), pay(9_295_000), memo(memoFor(ref))]), expect), null);
  assert.strictEqual(paymentProblem(signed([memo(memoFor(ref))]), expect), 'not exactly one payment');
  // a USDC row never accepts a SOL transfer, and a SOL row never a token one
  assert.match(paymentProblem(signed([pay(9_295_000), memo(memoFor(ref))]), Object.assign({}, expect, { asset: 'usdc' })), /does not accept/);
});

test('landed: the revenue wallet\'s gain inside this transaction, granted at the row\'s dollar price', () => {
  const keys = [wallet, revenue, '11111111111111111111111111111111', MEMO_PROGRAM];
  const tx = (gain, withMemo = true) => ({
    meta: { err: null, preBalances: [50_000_000, 10_000_000_000, 1, 1], postBalances: [50_000_000 - gain - 5000, 10_000_000_000 + gain, 1, 1] },
    transaction: { message: { staticAccountKeys: keys.map((k) => new PublicKey(k)),
      compiledInstructions: withMemo ? [{ programIdIndex: 3, accountKeyIndexes: [], data: Buffer.from(memoFor(ref)) }] : [] } },
  });
  assert.deepStrictEqual(landedProblem(tx(9_295_000), expect), { problem: null, usdc: 1 });
  assert.match(landedProblem(tx(9_294_999), expect).problem, /lamports/);
  assert.strictEqual(landedProblem(tx(9_295_000, false), expect).problem, 'memo missing');
});

test('a SOL row pays only on its own quote\'s blockhash, never on a later one from another intent', async () => {
  const { createSkinShop } = require('../server/skinShop');
  const rows = new Map();
  const store = {
    ownsItem: async () => false,
    skinOpen: async (r) => { for (const x of rows.values()) if (x.wallet === r.wallet && x.item === r.item && x.state === 'open') return x;
      const row = { ref: r.ref, wallet: r.wallet, item: r.item, game: r.game, skin: r.skin, units: r.units, state: 'open', asset: r.asset, usd_micro: r.usdMicro };
      rows.set(r.ref, row); return row; },
    skinRow: async (ref) => rows.get(ref) || null,
    skinExpire: async (ref) => { const x = rows.get(ref); if (x) x.state = 'expired'; },
  };
  let n = 0, txBh = null;
  const chain = { latestBlockhash: async () => ({ blockhash: 'BH' + (++n), lastValidBlockHeight: 100 }),
                  txInfo: () => ({ signature: 'S'.repeat(88), blockhash: txBh }) };
  const shop = createSkinShop({ store, chain, mint: 'M', revenueAta: 'A', asset: () => 'sol', solQuote: () => 9_295_000,
                                revenueWallet: revenue, log: { warn() {}, log() {} } });
  const catalog = require('../server/skinCatalog');
  const shopPrices = require('../shared/shopPrices');
  const items = [];
  for (const g of Object.keys(shopPrices.PRICES)) for (const k of Object.keys(shopPrices.PRICES[g])) if (catalog.itemOf(g, k)) items.push([g, k]);
  assert.ok(items.length >= 2, 'two skins for sale');
  const a = await shop.intent({ game: items[0][0], skin: items[0][1], wallet });
  assert.strictEqual(a.status, 200, JSON.stringify(a.body));
  assert.strictEqual(a.body.asset, 'sol');
  await shop.intent({ game: items[1][0], skin: items[1][1], wallet });   // a later blockhash, BH2
  txBh = 'BH2';
  const late = await shop.buy({ ref: a.body.ref, signedTx: 'AAAA' });
  assert.strictEqual(late.status, 400);
  assert.match(late.body.error, /old price check/);
});
