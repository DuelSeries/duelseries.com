'use strict';
/* Night review 2026-10-29, findings 1 and 22: the Wallet tab's history let one IP burn the RPC key that stake
   verifies, submits and payouts use.

   /api/my-transfers took any wallet, and for a busy one (an exchange's) each ask made ten 1000-signature pages
   outside the read gate plus 60 transaction reads; the gate capped reads in flight, never reads a second, so one IP
   asking every 2 s kept about 28 provider calls a second going at a key that allows 10. web3.js also resent each
   throttled call 5 times inside withRetry's 6 tries.

   Now (server/rpcBudget.js, server/Usdc.js): every history call, signature pages and each retry included, takes a
   token from one server-wide bucket (HISTORY_RPS a second after a burst of HISTORY_BURST), history reads have a
   Connection of their own that never resends a 429 by itself, a busy wallet costs two pages an address, and a flood
   fails at once instead of queueing for minutes. The money paths' Connection is never touched by any of it.
   The bucket first, with its own clock, then Usdc against stubbed connections (nothing leaves the process). */
const test = require('node:test');
const assert = require('node:assert');

/* The provider, stubbed BEFORE web3.js loads: it keeps a reference to fetch from load time. Every request is counted
   here and answered 429, so nothing leaves the machine. */
const fetched = [];
globalThis.fetch = async (url, init) => {
  fetched.push({ url: String(url), body: init && init.body });
  return new Response('{"jsonrpc":"2.0","id":1,"error":{"code":429,"message":"Too many requests"}}',
    { status: 429, statusText: 'Too Many Requests', headers: { 'content-type': 'application/json' } });
};

const { Keypair } = require('@solana/web3.js');
const escrow = Keypair.generate();
process.env.ESCROW_PRIVATE_KEY = Buffer.from(escrow.secretKey).toString('base64');
delete process.env.RPC_URL;
process.env.HISTORY_RPS = '20';    // small numbers, so the pacing shows in about three seconds
process.env.HISTORY_BURST = '5';
const { createBucket, envNumber, refusalLog } = require('../server/rpcBudget');
const Usdc = require('../server/Usdc');

test('a bucket: a burst, then its rate; a refusal takes nothing; a reservation waits its turn or gives up', () => {
  let t = 1000;
  const b = createBucket({ perSec: 2, burst: 3, now: () => t });
  assert.deepStrictEqual([b.take(), b.take(), b.take(), b.take()], [true, true, true, false], 'the burst, then nothing');
  t += 499;
  assert.strictEqual(b.take(), false, 'not yet: one token every 500 ms');
  t += 1;
  assert.strictEqual(b.take(), true);
  t += 1000;                                   // two more tokens
  assert.strictEqual(b.take(3), false, 'asking for more than there is takes none of it');
  assert.strictEqual(b.take(2), true, 'so the two are still there');
  t += 10_000;
  assert.strictEqual(b.left(), 3, 'never more than the burst saved up');
  b.take(3);
  assert.deepStrictEqual([b.reserve(), b.reserve(), b.reserve()], [500, 1000, 1500], 'each waits behind the one before');
  assert.strictEqual(b.reserve(1, 1999), -1, 'past the longest wait: refused');
  assert.strictEqual(b.reserve(1, 2000), 2000, 'and the refusal took nothing, so the next in line waits the same');
  assert.strictEqual(b.reserve(), 2500);
  t += 3000;
  assert.strictEqual(b.reserve(), 0, 'paid off: a token is there again');
});

test('envNumber: a positive number from the environment, anything else is the default', () => {
  const name = 'RPC_BUDGET_TEST_' + process.pid;
  for (const v of [undefined, '', '0', '-3', 'lots', 'NaN']) {
    if (v === undefined) delete process.env[name]; else process.env[name] = v;
    assert.strictEqual(envNumber(name, 4), 4, String(v));
  }
  process.env[name] = '7.5';
  assert.strictEqual(envNumber(name, 4), 7.5);
  delete process.env[name];
});

test('a budget that refuses says so in the log once, then at most once a minute with the count', () => {
  let t = 0;
  const lines = [];
  const note = refusalLog('history reads', { log: (s) => lines.push(s), now: () => t });
  note();
  for (let i = 0; i < 50; i++) { t += 1000; note(); }
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], /^\[RPC-BUDGET\] history reads: 1 refused \(server-wide budget full\)$/);
  t += 10_000;
  note();
  assert.strictEqual(lines.length, 2);
  assert.match(lines[1], /history reads: 51 refused since the last line/);
});

test('history reads have their own Connection, and it never resends a 429 by itself', async () => {
  assert.notStrictEqual(Usdc.historyConnection, Usdc.connection, 'the money paths keep their own Connection');
  const n = fetched.length;
  await assert.rejects(Usdc.historyConnection.getSlot(), /429/);
  assert.strictEqual(fetched.length - n, 1, 'one request for one throttled call (web3.js alone used to make five)');
});

// A wallet with a long history on both its addresses (an exchange's): pages of 1000 for as far back as anyone asks.
const BUSY = Keypair.generate().publicKey.toString();
const calls = [];
let readsInFlight = 0, readsPeak = 0;
const money = { touched: 0 };
for (const m of ['getSignaturesForAddress', 'getTransaction']) {
  Usdc.connection[m] = async () => { money.touched++; throw new Error('history must not use the money Connection'); };
}
function busyPages(addr, { limit, before }) {
  const from = before ? Number(before.split(':')[1]) + 1 : 0;
  return Array.from({ length: limit }, (_, i) => ({ signature: addr.toString().slice(0, 8) + ':' + (from + i),
    slot: 1e9 - from - i, blockTime: 1_800_000_000 - from - i, err: null }));
}
// A transaction that never moved the wallet's money: read, kept as nothing, never a row.
const NOTHING = { meta: { err: null, preTokenBalances: [], postTokenBalances: [], preBalances: [], postBalances: [] },
  transaction: { message: { staticAccountKeys: [], compiledInstructions: [] } } };

test('a busy wallet: two signature pages an address, sixty reads, every one of them paced by the server-wide budget', async () => {
  Usdc.historyConnection.getSignaturesForAddress = async (addr, o) => { calls.push({ at: Date.now(), kind: 'page' }); return busyPages(addr, o); };
  Usdc.historyConnection.getTransaction = async () => {
    calls.push({ at: Date.now(), kind: 'read' });
    readsInFlight++; readsPeak = Math.max(readsPeak, readsInFlight);
    await new Promise((r) => setTimeout(r, 5));
    readsInFlight--;
    return NOTHING;
  };
  assert.strictEqual(Usdc.HISTORY_RPS, 20);
  assert.strictEqual(Usdc.HISTORY_BURST, 5);
  assert.strictEqual(Usdc.TRANSFER_SIGS_MAX, 2000);
  const t0 = Date.now();
  const page = await Usdc.usdcTransfers(BUSY);
  const ms = Date.now() - t0;
  assert.strictEqual(page.complete, false, 'stopped short, as before: the next ask reads on');
  assert.strictEqual(calls.filter((c) => c.kind === 'page').length, 4, 'two pages of 1000 for each address (was up to ten)');
  assert.strictEqual(calls.filter((c) => c.kind === 'read').length, 60, 'the same sixty new reads an ask');
  assert.ok(readsPeak <= 4, 'four reads in flight at most: ' + readsPeak);
  // 64 calls: 5 at once, then 20 a second, so about 2.95 s.
  assert.ok(ms >= 2700, 'held to the rate: ' + ms + ' ms');
  for (const c of calls) {
    const inSecond = calls.filter((d) => d.at >= c.at && d.at < c.at + 1000).length;
    assert.ok(inSecond <= 5 + 20 + 1, inSecond + ' calls within one second');
  }
  assert.strictEqual(money.touched, 0, 'the money Connection was never asked');
});

test('a flood fails at once ("history reads busy", the route\'s 502) instead of queueing for minutes', async () => {
  // Signature pages answer at once with 20 transactions each; reads never answer (a provider stuck under load).
  let n = 0;
  Usdc.historyConnection.getSignaturesForAddress = async () => Array.from({ length: 20 }, () =>
    ({ signature: 'flood:' + (n++), slot: 1, blockTime: 1, err: null }));
  Usdc.historyConnection.getTransaction = () => new Promise(() => {});
  const ASKS = 40;
  const t0 = Date.now();
  const refused = [];
  for (let i = 0; i < ASKS; i++) {
    Usdc.usdcHistory(Keypair.generate().publicKey.toString(), { limit: 20 })
      .then(() => assert.fail('a read that never answers cannot finish a page'), (e) => refused.push({ e, at: Date.now() - t0 }));
  }
  // The pages take tokens at 20 a second (about 2 s for 40); then the reads fill four slots and the queue.
  const fit = Math.ceil((4 + Usdc.HISTORY_QUEUE_MAX) / 20);
  const want = ASKS - fit;
  for (let i = 0; i < 100 && refused.length < want; i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(refused.length >= want, refused.length + ' refused, wanted ' + want);
  for (const r of refused) {
    assert.strictEqual(r.e.message, 'history reads busy');
    assert.ok(r.at < 5000, 'refused at ' + r.at + ' ms, not after a long wait');
  }
  assert.strictEqual(money.touched, 0);
  // The asks that fit stay waiting on reads that never come; nothing here holds a timer, so the file ends.
});
