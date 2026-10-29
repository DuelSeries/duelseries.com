'use strict';
/* Night review 2026-10-29, second pass on findings 1 and 22: the Wallet tab's "Looking further back" re-asks no longer
   walk the same 1000-signature pages again; the walk of an answer that stopped short is kept for the next ask.
   (This file was rpcBudgetHistoryDay.test.js. Its day's cap test went with the cap in the third pass, review problem
   0: history is now a rate that refills each second and each address's share of it, in rpcBudget.test.js.)

   Usdc against a stubbed history Connection (nothing leaves the process), with the rate out of the way. */
const test = require('node:test');
const assert = require('node:assert');

// The provider, stubbed before web3.js loads: anything that reached it would be refused here.
globalThis.fetch = async () => new Response('{"jsonrpc":"2.0","id":1,"error":{"code":429,"message":"Too many requests"}}',
  { status: 429, headers: { 'content-type': 'application/json' } });

const { Keypair } = require('@solana/web3.js');
const escrow = Keypair.generate();
process.env.ESCROW_PRIVATE_KEY = Buffer.from(escrow.secretKey).toString('base64');
delete process.env.RPC_URL;
process.env.HISTORY_RPS = '1000';      // the rate out of the way: the walk is the subject here
process.env.HISTORY_BURST = '1000';
const { UNMETERED } = require('../server/rpcBudget');
const Usdc = require('../server/Usdc');

// A transaction that never moved the wallet's money: read, kept as nothing, never a row.
const NOTHING = { meta: { err: null, preTokenBalances: [], postTokenBalances: [], preBalances: [], postBalances: [] },
  transaction: { message: { staticAccountKeys: [], compiledInstructions: [] } } };
let pages = 0, reads = 0;
const sizes = new Map();   // address -> how many signatures it has (default: more than anyone reads)
Usdc.historyConnection.getSignaturesForAddress = async (addr, { limit, before }) => {
  pages++;
  const a = addr.toString();
  const total = sizes.has(a) ? sizes.get(a) : 1e9;
  const from = before ? Number(before.split(':')[1]) + 1 : 0;
  const n = Math.max(0, Math.min(limit, total - from));
  return Array.from({ length: n }, (_, i) => ({ signature: a.slice(0, 10) + ':' + (from + i),
    slot: 1e9 - from - i, blockTime: 1_800_000_000 - from - i, err: null }));
};
Usdc.historyConnection.getTransaction = async () => { reads++; return NOTHING; };
for (const m of ['getSignaturesForAddress', 'getTransaction']) {
  Usdc.connection[m] = async () => { throw new Error('history must not use the money Connection'); };
}
// A wallet with `n` signatures on each of its two addresses (its USDC account and itself).
function wallet(n) {
  const w = Keypair.generate().publicKey.toString();
  if (n != null) { sizes.set(w, n); sizes.set(Usdc.ataFor(w), n); }
  return w;
}

test('"Looking further back": the re-asks read on without walking the signature pages again', async () => {
  assert.strictEqual(Usdc.HISTORY_PER_DAY, undefined, 'no day cap any more (third pass)');
  const W = wallet(150);                 // 300 transactions: five asks at sixty new reads each
  const perAsk = [];
  let page = { complete: false };
  for (let asks = 0; !page.complete && asks < 10; asks++) {
    const p0 = pages, r0 = reads;
    page = await Usdc.usdcTransfers(W, { budgetKey: UNMETERED });
    perAsk.push([pages - p0, reads - r0]);
  }
  assert.deepStrictEqual(perAsk, [[2, 60], [0, 60], [0, 60], [0, 60], [0, 60]],
    'one page an address on the first ask, none after it (each re-ask walked them all again)');
  // A complete answer drops the walk (the route keeps that answer itself): the next ask walks again, reads nothing.
  const p0 = pages, r0 = reads;
  await Usdc.usdcTransfers(W, { budgetKey: UNMETERED });
  assert.deepStrictEqual([pages - p0, reads - r0], [2, 0]);
});

test('a kept walk is dropped 30 s after its last ask, so a new transfer is never left out for long', async () => {
  const W = wallet(150);
  await Usdc.usdcTransfers(W, { budgetKey: UNMETERED });
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 29_000;
    let p0 = pages;
    await Usdc.usdcTransfers(W, { budgetKey: UNMETERED });
    assert.strictEqual(pages - p0, 0, 'asked again within 30 s: kept');
    Date.now = () => realNow() + 29_000 + 31_000;
    p0 = pages;
    await Usdc.usdcTransfers(W, { budgetKey: UNMETERED });
    assert.strictEqual(pages - p0, 2, 'idle past 30 s: walked again');
  } finally {
    Date.now = realNow;
  }
});
