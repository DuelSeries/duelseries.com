'use strict';
/* Night review 2026-10-29, findings 2 and 22: the public routes that read the chain, on the real server
   (scripts/dev-local.js) with every provider call stubbed.

   /wallet/debug read the escrow's signatures on every hit, with no limiter, no cache and no login. /api/sol-balance
   (two provider calls), /api/rpc and /api/blockhash shared a per-IP count of 100 per 10 s, so one IP could drive
   about 20 calls a second at the key stake verifies and payouts use, and many IPs had no limit at all.

   Now: /wallet/debug asks nothing of the chain; /api/sol-balance and /api/rpc take from one server-wide budget
   (PUBLIC_RPC_RPS after a burst of PUBLIC_RPC_BURST) and answer 503 without a provider call when it is empty;
   /api/blockhash shares one answer every 2 s, so it needs no budget and works when the budget is empty; the per-IP
   count is 40 per 10 s. Here the budget is a burst of 4 that barely refills, so each step is exact. */
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
  process.env.PUBLIC_RPC_BURST = '4';
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

test('/api/sol-balance and /api/rpc share one server-wide budget: empty, they answer 503 and ask nothing', async () => {
  const realSol = Wallet.getAddressBalance;
  const realUsdc = Usdc.usdcBalanceOf;
  const provider = [];
  Wallet.getAddressBalance = async (a) => { provider.push('sol:' + a); return 0.5; };
  Usdc.usdcBalanceOf = async (a) => { provider.push('usdc:' + a); return 3; };
  const W = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
  try {
    // Refused before the budget: a junk address or method costs nothing.
    let r = await call('GET', '/api/sol-balance?address=not-an-address', undefined, { ip: '10.8.2.1' });
    assert.strictEqual(r.status, 400);
    r = await call('POST', '/api/rpc', { jsonrpc: '2.0', id: 1, method: 'getProgramAccounts', params: [] }, { ip: '10.8.2.1' });
    assert.strictEqual(r.status, 400);
    // A burst of 4 tokens, each from its own address, so no per-IP count is involved.
    r = await call('POST', '/api/rpc', { jsonrpc: '2.0', id: 1, method: 'getSlot' }, { ip: '10.8.2.2' });
    assert.strictEqual(r.status, 200, r.text);                       // 4 -> 3
    r = await call('GET', '/api/sol-balance?address=' + W, undefined, { ip: '10.8.2.3' });
    assert.strictEqual(r.status, 200, r.text);                       // 3 -> 1: two provider calls
    assert.strictEqual(r.json.balance, 3);
    assert.strictEqual(provider.length, 2);
    r = await call('GET', '/api/sol-balance?address=' + W, undefined, { ip: '10.8.2.4' });
    assert.strictEqual(r.status, 503, 'one token left, and a balance is two calls');
    assert.deepStrictEqual(r.json, { error: 'Busy, try again in a moment.' });
    assert.match(r.head, /retry-after: 1/i);
    assert.strictEqual(provider.length, 2, 'nothing asked of the chain');
    r = await call('POST', '/api/rpc', { jsonrpc: '2.0', id: 1, method: 'getSlot' }, { ip: '10.8.2.5' });
    assert.strictEqual(r.status, 200);                               // 1 -> 0
    const relayed = fetched.length;
    r = await call('POST', '/api/rpc', { jsonrpc: '2.0', id: 1, method: 'getSlot' }, { ip: '10.8.2.6' });
    assert.strictEqual(r.status, 503);
    assert.strictEqual(fetched.length, relayed, 'not relayed');
    assert.strictEqual(fetched.length, 2, 'the two that fit were relayed once each');
  } finally {
    Wallet.getAddressBalance = realSol;
    Usdc.usdcBalanceOf = realUsdc;
  }
});

test('/api/blockhash: one provider call per 2 s shared by every asker, and it still answers with the budget empty', async () => {
  const real = Wallet.getLatestBlockhash;
  let asked = 0, fail = false;
  Wallet.getLatestBlockhash = async () => {
    asked++;
    await new Promise((r) => setTimeout(r, 40));
    if (fail) throw new Error('503 Service unavailable');
    return { blockhash: 'BH' + asked, lastValidBlockHeight: 9 };
  };
  try {
    const first = await Promise.all([1, 2, 3].map((i) => call('GET', '/api/blockhash', undefined, { ip: '10.8.3.' + i })));
    assert.deepStrictEqual(first.map((r) => [r.status, r.json.blockhash]), [[200, 'BH1'], [200, 'BH1'], [200, 'BH1']]);
    let r = await call('GET', '/api/blockhash', undefined, { ip: '10.8.3.4' });
    assert.strictEqual(r.json.blockhash, 'BH1');
    assert.strictEqual(asked, 1, 'four asks, one provider call');
    await new Promise((res) => setTimeout(res, 2100));
    r = await call('GET', '/api/blockhash', undefined, { ip: '10.8.3.5' });
    assert.strictEqual(r.json.blockhash, 'BH2', 'a fresh one after 2 s');
    // A failed fetch is not kept: the next ask tries again.
    await new Promise((res) => setTimeout(res, 2100));
    fail = true;
    r = await call('GET', '/api/blockhash', undefined, { ip: '10.8.3.6' });
    assert.strictEqual(r.status, 500);
    fail = false;
    r = await call('GET', '/api/blockhash', undefined, { ip: '10.8.3.7' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.blockhash, 'BH4');
  } finally {
    Wallet.getLatestBlockhash = real;
  }
});

test('one address gets 40 of these routes per 10 s, not 100', async () => {
  const real = Wallet.getLatestBlockhash;
  Wallet.getLatestBlockhash = async () => ({ blockhash: 'BH', lastValidBlockHeight: 9 });
  try {
    const statuses = [];
    for (let i = 0; i < 41; i++) statuses.push((await call('GET', '/api/blockhash', undefined, { ip: '10.8.4.1' })).status);
    assert.ok(statuses.slice(0, 40).every((s) => s === 200), statuses.join(','));
    assert.strictEqual(statuses[40], 429);
    const r = await call('GET', '/api/sol-balance?address=7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', undefined, { ip: '10.8.4.1' });
    assert.strictEqual(r.status, 429, 'the count is shared by the three routes');
  } finally {
    Wallet.getLatestBlockhash = real;
  }
});
