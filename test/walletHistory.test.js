'use strict';
/* The wallet screen's transaction list (Usdc.usdcHistory), over a stubbed connection.

   It never loaded: the transactions were asked for in ONE JSON-RPC batch, and the Helius plan
   answers every batch with 429, so every retry failed the same way (measured on the server
   2026-10-15). Now each transaction is its own read, a page at a time with a cursor so the whole
   history can be walked, at most four reads in flight across every wallet, a row read once is
   kept, and a transfer to or from the escrow is marked as a game.

   The Wallet tab's "Add funds and Withdrawals" (Usdc.usdcTransfers, Owen 2026-10-15) is the same
   rows less every transfer with the house (the escrow and the revenue wallet), each with the
   other side's address, read newest first with a bounded number of new reads per ask. */
const test = require('node:test');
const assert = require('node:assert');
const { Keypair } = require('@solana/web3.js');

const escrow = Keypair.generate();
process.env.ESCROW_PRIVATE_KEY = Buffer.from(escrow.secretKey).toString('base64');
/* The server-wide history budget (night review 2026-10-29) is test/rpcBudget.test.js's subject; here it is out of
   the way, so these hundreds of reads run at the stub's speed. */
process.env.HISTORY_RPS = '1000000';
process.env.HISTORY_BURST = '1000000';
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

// A second wallet with a longer history: 130 transactions, newest first. One in five is a game
// (the escrow), one in five went to or came from the house's revenue wallet, one failed; the rest
// are the player's own money with somebody else.
const OWNER_B = Keypair.generate().publicKey.toString();
const REVENUE = Keypair.generate().publicKey.toString();
const FRIENDS = [Keypair.generate().publicKey.toString(), Keypair.generate().publicKey.toString()];
const chainB = [];
for (let i = 0; i < 130; i++) {
  const other = i % 5 === 0 ? escrow.publicKey.toString() : i % 5 === 1 ? REVENUE : FRIENDS[i % 2];
  const inbound = i % 3 !== 0;
  chainB.push({ sig: { signature: 'bsig' + String(i).padStart(3, '0'), blockTime: 1_800_000_000 - i * 60, err: i === 17 ? { x: 1 } : null },
    meta: { err: null,
      preTokenBalances: [bal(OWNER_B, 50_000_000), bal(other, 50_000_000)],
      postTokenBalances: [bal(OWNER_B, inbound ? 52_000_000 : 48_000_000), bal(other, inbound ? 48_000_000 : 52_000_000)] } });
}
// The wallets' own addresses (SOL, conversions) hold nothing here unless a test adds some.
const chains = { [Usdc.ataFor(OWNER_B)]: chainB, [OWNER_B]: [], [OWNER]: [] };

let reads = 0, inFlight = 0, peak = 0, batches = 0;
// History reads have a Connection of their own (night review 2026-10-29): it is the one stubbed.
Usdc.historyConnection.getSignaturesForAddress = async (ata, { limit, before }) => {
  const list = chains[ata.toString()] || chain;
  const from = before ? list.findIndex(c => c.sig.signature === before) + 1 : 0;
  return list.slice(from, from + limit).map(c => c.sig);
};
Usdc.historyConnection.getTransaction = async (sig) => {
  reads++; inFlight++; peak = Math.max(peak, inFlight);
  await new Promise(r => setTimeout(r, 5));
  inFlight--;
  const c = chain.find(x => x.sig.signature === sig) || chainB.find(x => x.sig.signature === sig);
  return { blockTime: c.sig.blockTime, meta: c.meta };
};
Usdc.historyConnection.getParsedTransactions = async () => { batches++; throw new Error('429 Too Many Requests'); };

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
  assert.deepStrictEqual(r0, { signature: 'sig000', at: 1_800_000_000_000, kind: 'usdc', usdc: 1.5, direction: 'in', game: true,
    peer: escrow.publicKey.toString(), sol: null });
  assert.strictEqual(seen[1].peer, STRANGER, 'each row names the other side');
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

test('Add funds and Withdrawals: every transfer but the house\'s, newest first, a bounded number of new reads an ask', async () => {
  Usdc.markHouseAddress(REVENUE);
  const okB = chainB.filter((c, i) => i !== 17);
  const mine = okB.filter(c => {
    const i = chainB.indexOf(c);
    return i % 5 !== 0 && i % 5 !== 1;
  });
  // The transaction list and the add funds list open together: they share every read.
  const r0 = reads;
  const [hist, first] = await Promise.all([Usdc.usdcHistory(OWNER_B, { limit: 20 }), Usdc.usdcTransfers(OWNER_B)]);
  assert.strictEqual(reads - r0, 60, 'sixty new reads in the first ask, the twenty the list wanted among them');
  assert.strictEqual(hist.rows.length, 19, 'the list page: twenty signatures less the failed one');
  assert.strictEqual(first.complete, false, 'it says it stopped short');
  const firstSigs = okB.slice(0, 60).map(c => c.sig.signature);
  assert.deepStrictEqual(first.rows.map(r => r.signature),
    mine.filter(c => firstSigs.includes(c.sig.signature)).map(c => c.sig.signature),
    'everything newer than where it stopped, no gap');
  // The next asks read on from there, and the last one says it has it all.
  let page = first, asks = 1;
  while (!page.complete && asks < 5) { page = await Usdc.usdcTransfers(OWNER_B); asks++; }
  assert.strictEqual(page.complete, true);
  assert.strictEqual(asks, 3, '129 transactions at sixty new reads an ask');
  assert.deepStrictEqual(page.rows.map(r => r.signature), mine.map(c => c.sig.signature), 'newest first, all of them');
  for (const r of page.rows) {
    assert.ok(FRIENDS.includes(r.peer), 'never the escrow or the revenue wallet: ' + r.peer);
    assert.deepStrictEqual(Object.keys(r).sort(), ['at', 'direction', 'kind', 'peer', 'signature', 'sol', 'usd', 'usdc']);
    assert.strictEqual(r.kind, 'usdc');
    assert.strictEqual(r.usdc, 2);
  }
  assert.strictEqual(page.rows[0].direction, 'in');
  assert.strictEqual(page.rows.find(r => r.signature === 'bsig003').direction, 'out');
  // Asked again, it is all kept: no reads at all.
  const r1 = reads;
  const again = await Usdc.usdcTransfers(OWNER_B);
  assert.strictEqual(reads, r1);
  assert.strictEqual(again.rows.length, mine.length);
  assert.strictEqual(batches, 0, 'never a batch');
  assert.ok(peak <= 4, 'four reads in flight at most, saw ' + peak);
});

test('Add funds and Withdrawals: a wallet with no history is an empty, complete answer', async () => {
  const none = await Usdc.usdcTransfers(Keypair.generate().publicKey.toString());
  assert.deepStrictEqual(none, { rows: [], complete: true });
});

test('Add funds and Withdrawals: an answer holds the newest 200 transfers at most', async () => {
  const whale = Keypair.generate().publicKey.toString();
  const long = [];
  for (let i = 0; i < 260; i++) {
    long.push({ sig: { signature: 'wsig' + String(i).padStart(3, '0'), blockTime: 1_800_000_000 - i, err: null },
      meta: { err: null, preTokenBalances: [bal(whale, 9_000_000), bal(STRANGER, 9_000_000)],
        postTokenBalances: [bal(whale, 10_000_000), bal(STRANGER, 8_000_000)] } });
  }
  chains[Usdc.ataFor(whale)] = long;
  chains[whale] = [];
  chainB.push(...long);   // so the stubbed getTransaction finds them
  let page = { complete: false }, asks = 0;
  while (!page.complete && asks < 10) { page = await Usdc.usdcTransfers(whale); asks++; }
  assert.strictEqual(Usdc.TRANSFER_ROWS_MAX, 200);
  assert.strictEqual(page.rows.length, 200);
  assert.strictEqual(page.rows[0].signature, 'wsig000');
  assert.strictEqual(page.rows[199].signature, 'wsig199', 'the newest 200, in order');
});
