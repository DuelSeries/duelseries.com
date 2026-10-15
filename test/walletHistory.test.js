'use strict';
/* The wallet screen's transaction list (Usdc.usdcHistory), over a stubbed connection.

   It never loaded: the transactions were asked for in ONE JSON-RPC batch, and the Helius plan
   answers every batch with 429, so every retry failed the same way (measured on the server
   2026-10-15). Now each transaction is its own read, a page at a time with a cursor so the whole
   history can be walked, at most four reads in flight across every wallet, a row read once is
   kept, and a transfer to or from the escrow is marked as a game. */
const test = require('node:test');
const assert = require('node:assert');
const { Keypair } = require('@solana/web3.js');

const escrow = Keypair.generate();
process.env.ESCROW_PRIVATE_KEY = Buffer.from(escrow.secretKey).toString('base64');
const Usdc = require('../server/Usdc');

const OWNER = Keypair.generate().publicKey.toString();
const STRANGER = Keypair.generate().publicKey.toString();
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const bal = (owner, amount) => ({ owner, mint: MINT, uiTokenAmount: { amount: String(amount) } });

// 45 transactions, newest first: every third one with the escrow, one failed, one that does not
// move the owner's USDC at all.
const chain = [];
for (let i = 0; i < 45; i++) {
  const other = i % 3 === 0 ? escrow.publicKey.toString() : STRANGER;
  const inbound = i % 2 === 0;
  const sig = 'sig' + String(i).padStart(3, '0');
  const meta = i === 7 ? { err: null, preTokenBalances: [bal(OWNER, 5)], postTokenBalances: [bal(OWNER, 5)] }
    : { err: null,
        preTokenBalances: [bal(OWNER, 10_000_000), bal(other, 10_000_000)],
        postTokenBalances: [bal(OWNER, inbound ? 11_500_000 : 8_500_000), bal(other, inbound ? 8_500_000 : 11_500_000)] };
  chain.push({ sig: { signature: sig, blockTime: 1_800_000_000 - i * 60, err: i === 11 ? { x: 1 } : null }, meta });
}

let reads = 0, inFlight = 0, peak = 0, batches = 0;
Usdc.connection.getSignaturesForAddress = async (_ata, { limit, before }) => {
  const from = before ? chain.findIndex(c => c.sig.signature === before) + 1 : 0;
  return chain.slice(from, from + limit).map(c => c.sig);
};
Usdc.connection.getTransaction = async (sig) => {
  reads++; inFlight++; peak = Math.max(peak, inFlight);
  await new Promise(r => setTimeout(r, 5));
  inFlight--;
  const c = chain.find(x => x.sig.signature === sig);
  return { blockTime: c.sig.blockTime, meta: c.meta };
};
Usdc.connection.getParsedTransactions = async () => { batches++; throw new Error('429 Too Many Requests'); };

test('the whole history walks page by page with single reads, never a batch', async () => {
  const seen = [];
  let before, pages = 0;
  do {
    const p = await Usdc.usdcHistory(OWNER, { limit: 20, before });
    seen.push(...p.rows);
    before = p.next;
    pages++;
  } while (before && pages < 10);
  assert.strictEqual(batches, 0, 'no JSON-RPC batch is ever sent');
  assert.strictEqual(pages, 3);
  // 45 transactions, less the failed one and the one that moved nothing.
  assert.strictEqual(seen.length, 43);
  assert.deepStrictEqual(seen.map(r => r.signature), chain.filter((c, i) => i !== 7 && i !== 11).map(c => c.sig.signature));
  assert.ok(peak <= 4, 'at most four reads in flight, saw ' + peak);
  const r0 = seen[0];
  assert.deepStrictEqual(r0, { signature: 'sig000', at: 1_800_000_000_000, usdc: 1.5, direction: 'in', game: true });
  assert.strictEqual(seen[1].game, false);
  assert.strictEqual(seen[1].direction, 'out');
});

test('a row read once is kept: the first page again costs no transaction reads', async () => {
  const before = reads;
  const p = await Usdc.usdcHistory(OWNER, { limit: 20 });
  assert.strictEqual(p.rows.length, 18);   // 20 signatures less the failed and the empty one
  assert.strictEqual(reads, before);
});

test('two wallets paging at once still keep four reads in flight in total', async () => {
  peak = 0;
  const other = Keypair.generate().publicKey.toString();
  await Promise.all([Usdc.usdcHistory(other, { limit: 20 }), Usdc.usdcHistory(STRANGER, { limit: 20 })]);
  assert.ok(peak <= 4, 'peak ' + peak);
});
