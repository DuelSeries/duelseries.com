'use strict';
/* Night review 2026-10-29, findings 2 and 22: the public routes that read the chain, on the real server
   (scripts/dev-local.js) with every provider call stubbed.

   /wallet/debug read the escrow's signatures on every hit, with no limiter, no cache and no login. /api/sol-balance
   (two provider calls), /api/rpc and /api/blockhash shared a per-IP count of 100 per 10 s, so one IP could drive
   about 20 calls a second at the key stake verifies and payouts use, and many IPs had no limit at all.

   Now: /wallet/debug asks nothing of the chain; /api/sol-balance and /api/rpc take from one server-wide budget
   (PUBLIC_RPC_RPS after a burst of PUBLIC_RPC_BURST, refilling every second, no day's cap since the third pass) and
   answer 503 without a provider call when it is empty; the per-IP count is 40 per 10 s.
   Third pass (night review 2026-10-29, review problems 0 and 1): a send's blockhash is the money lane. It takes nothing
   from the budget (the second pass charged it there, and a spent budget left Withdraw with a 503), has a per-IP count
   of its own, and is bounded by sharing: one fetch per 5 s server-wide, one per 20 s per address. /api/sol-balance
   shares one read of an address for 10 s (1 s with fresh=1) and, when the budget refuses, answers from the address's
   last read (under 5 minutes old) marked stale. Each address's share of the budget is
   test/rpcBudgetShareServer.test.js's subject. Here the budget is a burst of 8 that barely refills, and every step
   asks from an address of its own so no share is involved. */
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const realRequest = http.request;
const realGet = http.get;

let port, Wallet, Usdc;
const fetched = [];

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function call(method, url, body, { ip = '10.8.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    const data = body === undefined ? '' : JSON.stringify(body);
    let out = '';
    s.on('connect', () => s.write(`${method} ${url} HTTP/1.1\r\nHost: localhost\r\nX-Forwarded-For: ${ip}\r\nContent-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(data)}\r\nConnection: close\r\n\r\n${data}`));
    s.on('data', (d) => { out += d; });
    s.on('end', () => {
      const head = out.split('\r\n\r\n')[0];
      const status = Number(out.split(' ')[1]);
      let text = out.split('\r\n\r\n').slice(1).join('\r\n\r\n');
      if (/transfer-encoding: chunked/i.test(head)) {
        let rest = text; text = '';
        for (;;) {
          const i = rest.indexOf('\r\n'); const n = parseInt(rest.slice(0, i), 16);
          if (!n) break; text += rest.slice(i + 2, i + 2 + n); rest = rest.slice(i + 2 + n + 2);
        }
      }
      let json = null;
      try { json = JSON.parse(text); } catch (_) {}
      resolve({ status, json, text, head });
    });
    s.on('error', reject);
    s.setTimeout(15000, () => s.destroy(new Error('timeout')));
  });
}

test.before(async () => {
  port = await freePort();
  process.env.DEV_LOCAL_PORT = String(port);
  process.env.PUBLIC_RPC_RPS = '0.01';   // one token in 100 s: nothing refills while these steps run
  process.env.PUBLIC_RPC_BURST = '8';
  const log = console.log; const warn = console.warn;
  console.log = () => {}; console.warn = () => {};
  try {
    require(path.join(ROOT, 'scripts', 'dev-local.js'));
  } finally {
    console.log = log; console.warn = warn;
  }
  const blockedRequest = http.request;
  const local = (a) => a && typeof a === 'object' && ['localhost', '127.0.0.1'].includes(a.hostname || a.host) && Number(a.port) === port;
  http.request = function (...a) { return local(a[0]) ? realRequest.apply(http, a) : blockedRequest.apply(http, a); };
  http.get = function (...a) { return local(a[0]) ? realGet.apply(http, a) : blockedRequest.apply(http, a); };
  Wallet = require(path.join(ROOT, 'server', 'Wallet.js'));
  Usdc = require(path.join(ROOT, 'server', 'Usdc.js'));
  // The relay's provider, stubbed: every relayed call is recorded and answered here, nothing leaves.
  globalThis.fetch = async (url, init) => {
    fetched.push(JSON.parse(init.body));
    return new Response('{"jsonrpc":"2.0","id":1,"result":42}', { headers: { 'content-type': 'application/json' } });
  };
  for (let i = 0; i < 60; i++) {
    try { const r = await call('GET', '/api/live', undefined, { ip: '10.8.9.' + i }); if (r.status === 200) return; } catch (_) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not come up');
});

test('/wallet/debug asks nothing of the chain: the ledger flags and the escrow address only', async () => {
  let asked = 0;
  const real = Wallet.getRecentSigs;
  Wallet.getRecentSigs = async () => { asked++; return []; };
  const sigsReal = Wallet.connection.getSignaturesForAddress;
  Wallet.connection.getSignaturesForAddress = async () => { asked++; return []; };
  try {
    for (let i = 0; i < 5; i++) {
      const r = await call('GET', '/wallet/debug', undefined, { ip: '10.8.1.1' });
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(Object.keys(r.json.ledger).sort(), ['durableStakes', 'payoutLanes']);
      assert.ok(!('sigs' in r.json), 'no signatures, so no provider call');
    }
    assert.strictEqual(asked, 0);
  } finally {
    Wallet.getRecentSigs = real;
    Wallet.connection.getSignaturesForAddress = sigsReal;
  }
});

/* The server's own clock, moved on by `ms` while `fn` runs: index.js reads Date.now() for the blockhash it shares and
   the balances it keeps, so time can pass here without waiting for it. The budgets keep their own clock (they hold a
   reference to the real Date.now), so nothing refills meanwhile. */
async function withClock(fn) {
  const realNow = Date.now;
  let skew = 0;
  Date.now = () => realNow() + skew;
  try { return await fn((ms) => { skew += ms; }); } finally { Date.now = realNow; }
}

test('/api/blockhash is the money lane: shared, at most one fetch per 5 s, one per 20 s per address, never the public budget', async () => {
  const real = Wallet.getLatestBlockhash;
  let asked = 0, fail = false;
  Wallet.getLatestBlockhash = async () => {
    asked++;
    await new Promise((r) => setTimeout(r, 40));
    if (fail) throw new Error('503 Service unavailable');
    return { blockhash: 'BH' + asked, lastValidBlockHeight: 9 };
  };
  try {
    await withClock(async (pass) => {
      const first = await Promise.all([1, 2, 3].map((i) => call('GET', '/api/blockhash', undefined, { ip: '10.8.3.' + i })));
      assert.deepStrictEqual(first.map((r) => [r.status, r.json.blockhash]), [[200, 'BH1'], [200, 'BH1'], [200, 'BH1']]);
      let r = await call('GET', '/api/blockhash', undefined, { ip: '10.8.3.4' });
      assert.strictEqual(r.json.blockhash, 'BH1');
      assert.strictEqual(asked, 1, 'four asks, one provider call');
      pass(5100);
      r = await call('GET', '/api/blockhash', undefined, { ip: '10.8.3.5' });
      assert.strictEqual(r.json.blockhash, 'BH2', 'a fresh one past 5 s');
      pass(5100);
      r = await call('GET', '/api/blockhash', undefined, { ip: '10.8.3.5' });
      assert.deepStrictEqual([r.status, r.json.blockhash, asked], [200, 'BH2', 2],
        'the address that fetched one 5 s ago gets the shared one (under 20 s old), not another fetch');
      r = await call('GET', '/api/blockhash', undefined, { ip: '10.8.3.6' });
      assert.deepStrictEqual([r.json.blockhash, asked], ['BH3', 3], 'another address may start one');
      pass(21_000);
      r = await call('GET', '/api/blockhash', undefined, { ip: '10.8.3.6' });
      assert.deepStrictEqual([r.json.blockhash, asked], ['BH4', 4], 'past 20 s old, anyone gets a fresh one');
      // A failed fetch hands out the last good one while it is under 20 s old, and is not kept.
      pass(5100);
      fail = true;
      r = await call('GET', '/api/blockhash', undefined, { ip: '10.8.3.7' });
      assert.deepStrictEqual([r.status, r.json.blockhash, asked], [200, 'BH4', 5]);
      fail = false;
      r = await call('GET', '/api/blockhash', undefined, { ip: '10.8.3.8' });
      assert.deepStrictEqual([r.status, r.json.blockhash, asked], [200, 'BH6', 6], 'the failure was not kept: asked again');
      // With nothing under 20 s old to hand out, a failed fetch is the provider's error, as it always was.
      pass(25_000);
      fail = true;
      r = await call('GET', '/api/blockhash', undefined, { ip: '10.8.3.9' });
      assert.strictEqual(r.status, 500);
      fail = false;
    });
  } finally {
    Wallet.getLatestBlockhash = real;
  }
});

test('/api/sol-balance: one read an address shares for 10 s (fresh=1: 1 s), the budget for the rest, the last read when it is empty', async () => {
  const realSol = Wallet.getAddressBalance;
  const realUsdc = Usdc.usdcBalanceOf;
  const provider = [];
  let usdcNow = 3;
  Wallet.getAddressBalance = async (a, o) => { provider.push('sol:' + (o && o.lane)); return 0.5; };
  Usdc.usdcBalanceOf = async (a, o) => { provider.push('usdc:' + (o && o.lane)); return usdcNow; };
  const W = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
  const W2 = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
  try {
    await withClock(async (pass) => {
      // Refused before the budget: a junk address or method costs nothing.
      let r = await call('GET', '/api/sol-balance?address=not-an-address', undefined, { ip: '10.8.2.1' });
      assert.strictEqual(r.status, 400);
      r = await call('POST', '/api/rpc', { jsonrpc: '2.0', id: 1, method: 'getProgramAccounts', params: [] }, { ip: '10.8.2.1' });
      assert.strictEqual(r.status, 400);
      // The budget's whole burst of 8 is here: the blockhash steps before took none of it.
      r = await call('POST', '/api/rpc', { jsonrpc: '2.0', id: 1, method: 'getSlot' }, { ip: '10.8.2.2' });
      assert.strictEqual(r.status, 200, r.text);                       // 8 -> 7
      r = await call('GET', '/api/sol-balance?address=' + W, undefined, { ip: '10.8.2.3' });
      assert.strictEqual(r.status, 200, r.text);                       // 7 -> 5: two provider calls
      assert.deepStrictEqual(r.json, { address: W, sol: 3, balance: 3, unit: 'USDC', solNative: 0.5 }, 'the answer as it always was');
      assert.deepStrictEqual(provider, ['usdc:public', 'sol:public'], 'both on the public lane (PUBLIC_RPC_URL\'s key when set)');
      // Another tab, another address: the same read, nothing asked of the chain or the budget.
      usdcNow = 4;
      r = await call('GET', '/api/sol-balance?address=' + W, undefined, { ip: '10.8.2.4' });
      assert.deepStrictEqual([r.status, r.json.balance, provider.length], [200, 3, 2]);
      r = await call('GET', '/api/sol-balance?address=' + W + '&fresh=1', undefined, { ip: '10.8.2.4' });
      assert.deepStrictEqual([r.status, r.json.balance, provider.length], [200, 3, 2], 'fresh=1 still shares a read under 1 s old');
      pass(1100);
      r = await call('GET', '/api/sol-balance?address=' + W + '&fresh=1', undefined, { ip: '10.8.2.4' });
      assert.deepStrictEqual([r.status, r.json.balance, provider.length], [200, 4, 4], 'fresh=1 past 1 s: read again');  // 5 -> 3
      r = await call('GET', '/api/sol-balance?address=' + W, undefined, { ip: '10.8.2.5' });
      assert.deepStrictEqual([r.json.balance, provider.length], [4, 4], 'and that read is the one everyone shares now');
      pass(10_100);
      usdcNow = 5;
      r = await call('GET', '/api/sol-balance?address=' + W, undefined, { ip: '10.8.2.5' });
      assert.deepStrictEqual([r.status, r.json.balance, provider.length], [200, 5, 6], 'past 10 s: read again');    // 3 -> 1
      // One token left and a balance is two calls. An address never read lately is refused as before.
      r = await call('GET', '/api/sol-balance?address=' + W2, undefined, { ip: '10.8.2.6' });
      assert.strictEqual(r.status, 503);
      assert.deepStrictEqual(r.json, { error: 'Busy, try again in a moment.' });
      assert.match(r.head, /retry-after: 1/i);
      // A player's address read lately is answered from that read, marked stale, never refused.
      pass(10_100);
      usdcNow = 6;
      r = await call('GET', '/api/sol-balance?address=' + W, undefined, { ip: '10.8.2.7' });
      assert.deepStrictEqual([r.status, r.json.balance, r.json.stale], [200, 5, true]);
      assert.strictEqual(provider.length, 6, 'nothing asked of the chain');
      r = await call('POST', '/api/rpc', { jsonrpc: '2.0', id: 1, method: 'getSlot' }, { ip: '10.8.2.8' });
      assert.strictEqual(r.status, 200);                               // 1 -> 0
      const relayed = fetched.length;
      r = await call('POST', '/api/rpc', { jsonrpc: '2.0', id: 1, method: 'getSlot' }, { ip: '10.8.2.9' });
      assert.strictEqual(r.status, 503);
      assert.strictEqual(fetched.length, relayed, 'not relayed');
      // The last read is good for 5 minutes, no longer.
      pass(5 * 60_000);
      r = await call('GET', '/api/sol-balance?address=' + W, undefined, { ip: '10.8.2.10' });
      assert.strictEqual(r.status, 503, 'over 5 minutes old: refused like any other');
      // With the budget empty, a send's blockhash is still fetched: it is the money lane.
      const realBh = Wallet.getLatestBlockhash;
      let fresh = 0;
      Wallet.getLatestBlockhash = async () => { fresh++; return { blockhash: 'NEW', lastValidBlockHeight: 9 }; };
      try {
        r = await call('GET', '/api/blockhash', undefined, { ip: '10.8.2.11' });
        assert.deepStrictEqual([r.status, r.json.blockhash, fresh], [200, 'NEW', 1]);
      } finally {
        Wallet.getLatestBlockhash = realBh;
      }
    });
  } finally {
    Wallet.getAddressBalance = realSol;
    Usdc.usdcBalanceOf = realUsdc;
  }
});

test('one address gets 40 balance and relay asks per 10 s, and a send\'s blockhash has a count of its own', async () => {
  // Asks the count sees but the budget never does (a junk address is refused before it), so the budget being empty
  // here takes no part.
  const statuses = [];
  for (let i = 0; i < 41; i++) statuses.push((await call('GET', '/api/sol-balance?address=not-an-address', undefined, { ip: '10.8.4.1' })).status);
  assert.ok(statuses.slice(0, 40).every((s) => s === 400), statuses.join(','));
  assert.strictEqual(statuses[40], 429);
  let r = await call('POST', '/api/rpc', { jsonrpc: '2.0', id: 1, method: 'getSlot' }, { ip: '10.8.4.1' });
  assert.strictEqual(r.status, 429, 'the balance and the relay share one count');
  // The polling used that count up; the blockhash a Withdraw is built on is not in it (20 per 10 s of its own).
  const real = Wallet.getLatestBlockhash;
  Wallet.getLatestBlockhash = async () => ({ blockhash: 'MINE', lastValidBlockHeight: 9 });
  try {
    const bh = [];
    for (let i = 0; i < 21; i++) bh.push((await call('GET', '/api/blockhash', undefined, { ip: '10.8.4.1' })).status);
    assert.ok(bh.slice(0, 20).every((s) => s === 200), bh.join(','));
    assert.strictEqual(bh[20], 429);
  } finally {
    Wallet.getLatestBlockhash = real;
  }
});
