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
   Second pass (night review 2026-10-29): a rate alone still let one address spend Helius Free's month in under two
   days, and one address could hold the public rate empty by itself, so each budget now has a day's cap behind the
   rate and gives each caller a share of both (createBudget, callerShare).
   The bucket and the budget first, with their own clock, then Usdc against stubbed connections (nothing leaves the
   process). */
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
const { createBucket, createBudget, callerShare, UNMETERED, envNumber, refusalLog, refusalLogs } = require('../server/rpcBudget');
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

test('a day\'s cap: the rate refills all day, the day only a day\'s worth (night review 2026-10-29, second pass)', () => {
  let t = 0;
  const b = createBudget({ perSec: 10, burst: 10, perDay: 100, now: () => t });
  let got = 0;
  for (let sec = 0; sec < 3600; sec++) { t += 1000; for (let i = 0; i < 20; i++) if (b.take(1) === null) got++; }
  // The rate alone would have given 36,000 in this hour.
  assert.ok(got >= 100 && got <= 105, got + ' in an hour: the day\'s 100 and its refill');
  assert.strictEqual(b.take(1), 'day', 'and the refusal says which part bit');
  // A month of the same flood, a step a minute: about 31 days' worth at most, never the rate's 26M.
  let month = 0;
  for (let min = 0; min < 30 * 24 * 60; min++) { t += 60_000; for (let i = 0; i < 20; i++) if (b.take(1) === null) month++; }
  assert.ok(month <= 31 * 100, month + ' in 30 days');
  // Without a day's cap a budget is just its rate, as before.
  const plain = createBudget({ perSec: 1, burst: 2, now: () => t });
  assert.deepStrictEqual([plain.take(1), plain.take(1), plain.take(1)], [null, null, 'rate']);
  assert.strictEqual(plain.dayLeft(), Infinity);
});

test('one address flooding the public budget gets a quarter of it: other players\' balances keep coming back', () => {
  /* The reviewer's case, at the server's defaults (index.js: PUBLIC_RPC_RPS 3, PUBLIC_RPC_BURST 40, PUBLIC_RPC_PER_DAY
     10000, each caller's share from callerShare): for 10 minutes one address asks /api/sol-balance 4 times a second,
     the most the per-IP count lets through, two calls each; a player polls every 15 s. With one server-wide bucket
     only, 1 of the player's 40 polls came back. */
  for (const attackers of [['203.0.113.9'], ['203.0.113.9', '203.0.113.10', '203.0.113.11']]) {
    let t = 1_000_000;
    const cfg = { perSec: 3, burst: 40, perDay: 10000 };
    const pub = createBudget(Object.assign({}, cfg, { perKey: callerShare(cfg), now: () => t }));
    let polls = 0, back = 0, flood = 0;
    for (let ms = 0; ms < 600_000; ms += 250) {
      t = 1_000_000 + ms;
      for (const ip of attackers) if (pub.take(2, ip) === null) flood++;
      if (ms % 15_000 === 0) { polls++; if (pub.take(2, '198.51.100.7') === null) back++; }
    }
    assert.strictEqual(polls, 40);
    // Three addresses' opening bursts (20 each) outrun the server-wide 40 in the very first instant, the player's
    // first poll with them; from then on they hold three quarters of the rate at most and every poll lands.
    assert.ok(back >= (attackers.length === 1 ? 40 : 39), attackers.length + ' flooding address(es): ' + back + ' of the player\'s 40 polls came back');
    // Each flooding address had its own burst (20) and a quarter of the rate (0.75 a second), no more.
    assert.ok(flood * 2 <= attackers.length * (20 + 0.75 * 600) + 2, 'the flood got ' + flood * 2 + ' calls');
  }
});

test('the day\'s share: past it an address reads only while the reserve is untouched, which stays for new players', () => {
  let t = 0;
  // A day of 800: each address's share is 100, and 200 are kept back for addresses inside their share.
  const b = createBudget({ perSec: 1e6, burst: 1e6, perDay: 800, perKey: callerShare({ perDay: 800 }), now: () => t });
  let a = 0;
  while (b.take(1, 'A') === null) a++;
  assert.strictEqual(a, 600, 'its own 100, then down to the reserve and no further');
  assert.strictEqual(b.take(1, 'A'), 'day');
  assert.strictEqual(b.dayLeft(), 200);
  let c = 0;
  while (b.take(1, 'C') === null) c++;
  assert.strictEqual(c, 100, 'a player who just came gets their whole share, from the reserve');
  assert.strictEqual(b.reserve(1, 1000, 'C').refused, 'day', 'reserve() refuses the same way, nothing taken');
  assert.strictEqual(b.take(1), null, 'a caller with no address of its own is counted in the day like anyone');
  // The owner's own session is the rate only: never counted in the day, never refused by it.
  for (let i = 0; i < 2000; i++) assert.strictEqual(b.take(1, UNMETERED), null);
  assert.deepStrictEqual(b.reserve(1, 1000, UNMETERED), { wait: 0 });
  assert.strictEqual(b.dayLeft(), 99);
  // A day later the day is whole again and so is every share.
  t += 86_400_000;
  assert.strictEqual(b.dayLeft(), 800);
  assert.strictEqual(b.take(1, 'A'), null);
});

test('a caller\'s own rate refuses at once (reserve never waits on it); the server-wide rate is waited for in turn', () => {
  let t = 0;
  const b = createBudget({ perSec: 2, burst: 4, perKey: { perSec: 1, burst: 2 }, now: () => t });
  assert.deepStrictEqual(b.reserve(1, 5000, 'A'), { wait: 0 });
  assert.deepStrictEqual(b.reserve(1, 5000, 'A'), { wait: 0 });
  assert.deepStrictEqual(b.reserve(1, 5000, 'A'), { refused: 'key' }, 'past its own burst');
  assert.deepStrictEqual(b.reserve(1, 5000, 'B'), { wait: 0 });
  assert.deepStrictEqual(b.reserve(1, 5000, 'B'), { wait: 0 });
  assert.deepStrictEqual(b.reserve(1, 5000, 'C'), { wait: 500 }, 'the server-wide burst is spent: in turn');
  assert.deepStrictEqual(b.reserve(1, 600, 'D'), { refused: 'rate' }, 'past the longest wait');
  assert.strictEqual(b.take(1, 'D'), 'rate');
  // Shares are kept for the most recent addresses only; the longest idle starts over.
  const small = createBudget({ perSec: 100, burst: 100, perKey: { perSec: 1, burst: 1 }, maxKeys: 2, now: () => t });
  assert.strictEqual(small.take(1, 'A'), null);
  assert.strictEqual(small.take(1, 'A'), 'key');
  small.take(1, 'B'); small.take(1, 'C');
  assert.strictEqual(small.take(1, 'A'), null, 'A was the longest idle of three: its share started over');
});

test('callerShare: a quarter of the rate, half the burst (4 at least), an eighth of the day, a quarter kept back', () => {
  assert.deepStrictEqual(callerShare({ perSec: 3, burst: 40, perDay: 10000 }), { perSec: 0.75, burst: 20, perDay: 1250, reserve: 2500 });
  assert.deepStrictEqual(callerShare({ perSec: 0.01, burst: 4 }), { perSec: 0.0025, burst: 4, perDay: 0, reserve: 0 });
  assert.deepStrictEqual(callerShare({ perDay: 5000 }), { perSec: 0, burst: 4, perDay: 625, reserve: 1250 }, 'history: no rate of its own');
});

test('a month of one address flooding every public route and the history at the defaults stays a fraction of Helius Free', () => {
  /* What one address could spend before this pass: about 7 calls a second, 600k a day, the 1M month in under two
     days. Here it asks as hard as the per-IP counts allow (/api/sol-balance 4 a second at two calls; history's
     30 asks a minute at up to 64 calls), stepped every 10 s for 30 days. */
  let t = 0;
  const pubCfg = { perSec: 3, burst: 40, perDay: 10000 };
  const pub = createBudget(Object.assign({}, pubCfg, { perKey: callerShare(pubCfg), now: () => t }));
  const hist = createBudget({ perSec: 2, burst: 60, perDay: 5000, perKey: callerShare({ perDay: 5000 }), now: () => t });
  let calls = 0;
  for (let step = 0; step < 30 * 8640; step++) {
    t += 10_000;
    for (let i = 0; i < 40; i++) { if (pub.take(2, 'A') === null) calls += 2; else break; }
    for (let i = 0; i < 20; i++) { if (hist.reserve(1, 15_000, 'A').wait !== undefined) calls++; else break; }
  }
  assert.ok(calls <= 31 * 15000, calls + ' calls in 30 days');
  assert.ok(calls < 500_000, 'under half of the 1M month, the rest left to stakes and payouts: ' + calls);
});

test('refusalLogs: one line per reason, so the log says which part bit', () => {
  const lines = [];
  const logs = refusalLogs('public RPC reads', { log: (x) => lines.push(x), now: () => 0 });
  logs.rate(); logs.key(); logs.day();
  assert.deepStrictEqual(lines, [
    '[RPC-BUDGET] public RPC reads: 1 refused (server-wide budget full)',
    '[RPC-BUDGET] public RPC reads: 1 refused (one address past its share)',
    '[RPC-BUDGET] public RPC reads: 1 refused (the day\'s cap is spent)',
  ]);
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
