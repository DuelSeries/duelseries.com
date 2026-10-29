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
   Second pass (night review 2026-10-29): each caller got a share of the rate (callerShare), and a day's cap went
   behind each rate. Third pass (review problems 0 and 1): the day's caps are gone. They lived in memory, so every
   deploy refilled them, and anyone could spend them, so a flood or three honest tabs could leave players without a
   balance for the rest of the day. A budget is now a rate that refills each second and each caller's share of it,
   and these tests show what that costs and what it no longer allows.
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
const { createBucket, createBudget, callerShare, UNMETERED, envNumber, refusalLog, refusalLogs, usageLog } = require('../server/rpcBudget');
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

test('no day\'s cap: a budget is its rate, and a restart refills one burst, never a day (night review 2026-10-29, third pass, problem 0)', () => {
  /* The reviewer's case: an attacker on 16 addresses floods the public budget at the defaults (3 a second, a burst of
     40, each address a quarter of the rate) while the server restarts every 12 minutes, as a busy night of pushes
     does. With a day's cap kept in memory each restart handed over a fresh day (444k calls a day). Now a restart
     hands over one burst, so 6 hours cost the rate's 6 hours and at most one burst a restart on top. */
  const cfg = { perSec: 3, burst: 40 };
  const ips = Array.from({ length: 16 }, (_, i) => '203.0.113.' + i);
  function flood(restartEveryMs) {
    let t = 0, spent = 0, restarts = 0;
    let b = createBudget(Object.assign({}, cfg, { perKey: callerShare(cfg), now: () => t }));
    for (let ms = 0; ms < 6 * 3_600_000; ms += 250) {
      t = ms;
      if (restartEveryMs && ms > 0 && ms % restartEveryMs === 0) {
        restarts++;
        b = createBudget(Object.assign({}, cfg, { perKey: callerShare(cfg), now: () => t }));
      }
      for (const ip of ips) if (b.take(2, ip) === null) spent += 2;
    }
    return { spent, restarts };
  }
  const plain = flood(0);
  const restarted = flood(12 * 60_000);
  assert.strictEqual(restarted.restarts, 29);
  assert.ok(plain.spent <= 3 * 6 * 3600 + 40, plain.spent + ' calls in 6 hours: the rate and one burst');
  assert.ok(restarted.spent - plain.spent <= restarted.restarts * 40,
    'each restart is worth one burst (40) at most: ' + (restarted.spent - plain.spent) + ' more over ' + restarted.restarts);
  // Nothing in a budget counts a day any more.
  const b = createBudget({ perSec: 1, burst: 2, perDay: 1, now: () => 0 });
  assert.ok(!('dayLeft' in b) && !('perDay' in b));
  assert.deepStrictEqual([b.take(1), b.take(1), b.take(1)], [null, null, 'rate'], 'a perDay is ignored: the rate only');
});

test('one address flooding the public budget gets a quarter of it: other players\' balances keep coming back', () => {
  /* At the server's defaults (index.js: PUBLIC_RPC_RPS 3, PUBLIC_RPC_BURST 40, each caller's share from callerShare):
     for 10 minutes one address asks /api/sol-balance 4 times a second, the most the per-IP count lets through, two
     calls each; a player polls every 15 s. With one server-wide bucket only, 1 of the player's 40 polls came back. */
  for (const attackers of [['203.0.113.9'], ['203.0.113.9', '203.0.113.10', '203.0.113.11']]) {
    let t = 1_000_000;
    const cfg = { perSec: 3, burst: 40 };
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

test('the reviewer\'s day (problem 1): honest tabs never run anything dry, and a flood stops biting the second it stops', () => {
  const cfg = { perSec: 3, burst: 40 };
  // (c) Three tabs open all day, each polling a balance (two calls) every 15 s from its own address: every poll lands.
  {
    let t = 0;
    const pub = createBudget(Object.assign({}, cfg, { perKey: callerShare(cfg), now: () => t }));
    let polls = 0, back = 0;
    for (let ms = 0; ms < 86_400_000; ms += 15_000) {
      t = ms;
      for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) { polls++; if (pub.take(2, ip) === null) back++; }
    }
    assert.strictEqual(back, polls, back + ' of ' + polls + ' polls in a day (the day\'s cap had half of them failing by evening)');
  }
  // (a) Eight addresses flood at the per-IP count's rate for 23 hours. The rate is theirs while they flood (the
  // server then answers a player from the last read of their address), and the moment they stop it is back: a player's
  // poll a second later lands, where the day's cap stayed empty until the next day.
  {
    let t = 0;
    const pub = createBudget(Object.assign({}, cfg, { perKey: callerShare(cfg), now: () => t }));
    const ips = Array.from({ length: 8 }, (_, i) => '203.0.113.' + i);
    for (let ms = 0; ms < 23 * 3_600_000; ms += 250) { t = ms; for (const ip of ips) pub.take(2, ip); }
    t += 1000;
    assert.strictEqual(pub.take(2, '198.51.100.7'), null, 'one second after the flood, a balance');
    t += 15_000;
    assert.strictEqual(pub.left(), 40, 'and 15 s later the whole burst, for page loads, as on a quiet day');
  }
});

test('a caller\'s own share: take refuses at once, reserve waits for it in turn (history is paced, not refused)', () => {
  let t = 0;
  const b = createBudget({ perSec: 4, burst: 6, perKey: { perSec: 1, burst: 2 }, now: () => t });
  assert.deepStrictEqual(b.reserve(1, 5000, 'A'), { wait: 0 });
  assert.deepStrictEqual(b.reserve(1, 5000, 'A'), { wait: 0 });
  assert.deepStrictEqual(b.reserve(1, 5000, 'A'), { wait: 1000 }, 'past its own burst: in turn, at its own rate');
  assert.deepStrictEqual(b.reserve(1, 5000, 'A'), { wait: 2000 });
  assert.deepStrictEqual(b.reserve(1, 1500, 'A'), { refused: 'key' }, 'past the longest wait on its own share');
  assert.deepStrictEqual(b.reserve(1, 5000, 'B'), { wait: 0 }, 'another address is not behind it in its own share');
  assert.deepStrictEqual(b.reserve(1, 5000, 'C'), { wait: 0 });
  assert.deepStrictEqual(b.reserve(1, 5000, 'D'), { wait: 250 }, 'the server-wide burst is spent: in turn');
  assert.deepStrictEqual(b.reserve(1, 200, 'E'), { refused: 'rate' }, 'past the longest wait on the server-wide rate');
  assert.strictEqual(b.take(1, 'E'), 'rate');
  assert.strictEqual(b.take(1, 'A'), 'key', 'take never waits: past its share it is refused');
  // The owner's own session is the server-wide rate only, never a share.
  t += 10_000;
  for (let i = 0; i < 6; i++) assert.strictEqual(b.take(1, UNMETERED), null);
  assert.strictEqual(b.take(1, UNMETERED), 'rate');
  assert.strictEqual(b.spent(), 4 + 1 + 1 + 1 + 6, 'every token let through is counted for the usage line');
  // Shares are kept for the most recent addresses only; the longest idle starts over.
  const small = createBudget({ perSec: 100, burst: 100, perKey: { perSec: 1, burst: 1 }, maxKeys: 2, now: () => t });
  assert.strictEqual(small.take(1, 'A'), null);
  assert.strictEqual(small.take(1, 'A'), 'key');
  small.take(1, 'B'); small.take(1, 'C');
  assert.strictEqual(small.take(1, 'A'), null, 'A was the longest idle of three: its share started over');
});

test('callerShare: a quarter of the rate and half the burst (4 at least), and nothing about a day', () => {
  assert.deepStrictEqual(callerShare({ perSec: 3, burst: 40 }), { perSec: 0.75, burst: 20 });
  assert.deepStrictEqual(callerShare({ perSec: 0.01, burst: 4 }), { perSec: 0.0025, burst: 4 });
  assert.deepStrictEqual(callerShare({ perSec: 3, burst: 40, perDay: 10000 }), { perSec: 0.75, burst: 20 });
});

test('the history budget: one address flooding it is paced at half, and the other half stays for everyone else', () => {
  // As Usdc.js builds it: HISTORY_RPS 2 after a burst of 60, each address half the rate with the whole burst.
  let t = 0;
  const hist = createBudget({ perSec: 2, burst: 60, perKey: { perSec: 1, burst: 60 }, now: () => t });
  let flood = 0, theirs = 0, asked = 0;
  for (let ms = 0; ms < 3_600_000; ms += 100) {
    t = ms;
    // The flood asks for more than it can ever get (30 asks a minute at up to 64 calls), waiting up to 15 s.
    for (let i = 0; i < 3; i++) if (hist.reserve(1, 15_000, '203.0.113.9').wait !== undefined) flood++;
    // A player opens a wallet screen of 20 reads every 5 minutes, from an address of their own.
    if (ms % 300_000 === 150_000) for (let i = 0; i < 20; i++) { asked++; const r = hist.reserve(1, 15_000, '198.51.100.' + (ms / 300_000 | 0)); if (r.wait !== undefined) theirs++; }
  }
  assert.ok(flood <= 60 + 15 + 3600 + 1, 'an hour of flood got ' + flood + ' calls: about its own half of the rate');
  assert.strictEqual(theirs, asked, theirs + ' of ' + asked + ' of the players\' reads went ahead (none refused)');
});

test('usageLog: one line an hour with what a budget let through, none for an hour of nothing', () => {
  let t = 0;
  const b = createBudget({ perSec: 100, burst: 100, now: () => t });
  const lines = [];
  let tick = null;
  const ret = usageLog('public RPC reads', b, { log: (x) => lines.push(x), every: (fn, ms) => { tick = fn; assert.strictEqual(ms, 3_600_000); return { unref() {} }; } });
  assert.strictEqual(ret, tick);
  b.take(2); b.take(3);
  tick();
  tick();
  b.take(1, UNMETERED);
  tick();
  assert.deepStrictEqual(lines, [
    '[RPC-USAGE] public RPC reads: 5 provider calls in the last 60 min',
    '[RPC-USAGE] public RPC reads: 1 provider calls in the last 60 min',
  ]);
});

test('the cost of everything one address can do, a day, and of everyone at once: a rate, never more', () => {
  /* With no day's cap, what bounds the credits strangers spend is the rate each lane allows, refilling each second.
     One address: its quarter of the public rate, half the history rate, and one fresh blockhash per 20 s (index.js
     sharedBlockhash, money lane); everyone at once: the two rates and one blockhash per 5 s. These are what
     PUBLIC_RPC_URL takes off the money key and what the plan must be sized for. Stepped every second for a day. */
  let t = 0;
  const pubCfg = { perSec: 3, burst: 40 };
  const pub = createBudget(Object.assign({}, pubCfg, { perKey: callerShare(pubCfg), now: () => t }));
  const hist = createBudget({ perSec: 2, burst: 60, perKey: { perSec: 1, burst: 60 }, now: () => t });
  let calls = 0;
  for (let s = 0; s < 86_400; s++) {
    t = s * 1000;
    for (let i = 0; i < 4; i++) if (pub.take(2, 'A') === null) calls += 2;
    for (let i = 0; i < 4; i++) if (hist.reserve(1, 15_000, 'A').wait !== undefined) calls++;
  }
  calls += 86_400 / 20;   // the blockhash it can make the server fetch
  // its share's burst (20) and the history burst (60) once, and the 15 s of history it may have waiting
  assert.ok(calls <= (0.75 + 1) * 86_400 + 20 + 60 + 15 + 4320 + 1, calls + ' calls in a day from one address');
  assert.ok(calls < 160_000, 'one address: about 155k a day at most');
  const everyone = (3 + 2) * 86_400 + 86_400 / 5;
  assert.strictEqual(everyone, 449_280, 'everyone at once: the two rates and one blockhash per 5 s, about 450k a day');
});

test('refusalLogs: one line per reason, so the log says which part bit', () => {
  const lines = [];
  const logs = refusalLogs('public RPC reads', { log: (x) => lines.push(x), now: () => 0 });
  logs.rate(); logs.key();
  assert.deepStrictEqual(Object.keys(logs).sort(), ['key', 'rate'], 'no day\'s reason any more');
  assert.deepStrictEqual(lines, [
    '[RPC-BUDGET] public RPC reads: 1 refused (server-wide budget full)',
    '[RPC-BUDGET] public RPC reads: 1 refused (one address past its share)',
  ]);
});

test('history reads have their own Connection, and it never resends a 429 by itself', async () => {
  assert.notStrictEqual(Usdc.historyConnection, Usdc.connection, 'the money paths keep their own Connection');
  // No PUBLIC_RPC_URL (test/rpcPublicLane.test.js sets one): a visitor's balance reads use the money paths' key, as before.
  assert.strictEqual(Usdc.publicConnection, Usdc.connection);
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

// Two wallets for the share test: one reads twenty transactions, the other two.
const SHARE_A = Keypair.generate().publicKey.toString();
const SHARE_B = Keypair.generate().publicKey.toString();

test('history: an address past its share waits for it without holding a read slot, so another address goes first', async () => {
  /* Third pass (night review 2026-10-29): each asking address has half the history rate (here 10 a second, a burst of
     5). A reads 20 transactions: 5 at once, the rest paced at its own 10 a second. B asks for 2 while A waits. Before,
     a read held its gate slot while it waited for its token, so B's reads queued behind all of A's. */
  await new Promise((r) => setTimeout(r, 400));                   // the server-wide burst back after the test before
  const done = { A: [], B: [] };
  const t0 = Date.now();
  Usdc.historyConnection.getSignaturesForAddress = async (addr) => {
    const who = addr.toString() === SHARE_A ? 'A' : 'B';
    return Array.from({ length: who === 'A' ? 20 : 2 }, (_, i) => ({ signature: 'share' + who + ':' + i, slot: 1e6 - i, blockTime: 1, err: null }));
  };
  Usdc.historyConnection.getTransaction = async (sig) => {
    await new Promise((r) => setTimeout(r, 5));
    done[sig.startsWith('shareA') ? 'A' : 'B'].push(Date.now() - t0);
    return NOTHING;
  };
  await Promise.all([
    Usdc.usdcHistory(SHARE_A, { limit: 25, sol: true, budgetKey: '203.0.113.9' }),
    Usdc.usdcHistory(SHARE_B, { limit: 25, sol: true, budgetKey: '198.51.100.7' }),
  ]);
  assert.strictEqual(done.A.length, 20);
  assert.strictEqual(done.B.length, 2);
  const lastA = Math.max(...done.A), lastB = Math.max(...done.B);
  assert.ok(lastA >= 1300, 'A was paced at its own share: its last read at ' + lastA + ' ms');
  assert.ok(lastB < lastA - 300, 'B\'s reads were not stuck behind A\'s: ' + lastB + ' ms against ' + lastA + ' ms');
  assert.strictEqual(money.touched, 0);
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
