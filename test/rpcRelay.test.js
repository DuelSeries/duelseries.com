'use strict';
/* Security review 2026-10-15, "open Helius relay" (finder-2 #1, refute-core #1).

   /api/rpc forwarded any JSON body to our paid RPC key: any method, and JSON-RPC batch arrays, so
   one 100 kB post fanned out into hundreds of billed calls (getProgramAccounts, getBlock with full
   transactions...), with no timeout and the whole reply buffered in memory. /api/my-transactions
   (about 37 provider calls each) had no limiter at all. A key run into 429s breaks every money
   path, and is what the drainer double pay needed.

   Now: one request per call, only the methods the wallet widget's Privy SDK calls (read off the
   built widget) plus a few cheap reads, a 10 s timeout and a 2 MB reply cap; /api/my-transactions
   has a limiter, refuses what is not a Solana address, and shares one answer per wallet for 30 s.
   Units first, then the real server (scripts/dev-local.js) with fetch stubbed. */
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const realRequest = http.request;
const realGet = http.get;

// What the widget's Privy SDK (@solana/kit) calls, found in public/wallet/widget.js.
const WIDGET_METHODS = ['getAccountInfo', 'getBalance', 'getFeeForMessage', 'getGenesisHash', 'getLatestBlockhash',
  'getMultipleAccounts', 'getTokenAccountsByOwner', 'getTransaction', 'sendTransaction', 'simulateTransaction',
  'getSignatureStatuses', 'getEpochInfo', 'getBlockHeight', 'getSlot'];
const EXPENSIVE = ['getProgramAccounts', 'getBlock', 'getBlocks', 'getBlocksWithLimit', 'getSignaturesForAddress',
  'getLargestAccounts', 'getSupply', 'getTokenLargestAccounts', 'getVoteAccounts', 'getClusterNodes', 'getLeaderSchedule',
  'requestAirdrop', 'getInflationReward', 'getConfirmedSignaturesForAddress2', 'getAssetsByOwner', 'getBlockProduction'];

// dev-local must load before anything else requires the server modules (test.before below).
let port, Wallet, Usdc;
const fetched = [];
let fetchReply = () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: { blockhash: 'BH', lastValidBlockHeight: 9 } } }),
  { headers: { 'content-type': 'application/json' } });

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function call(method, url, body, { ip = '10.7.0.1', raw = null, type = 'application/json' } = {}) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    const data = raw !== null ? raw : (body === undefined ? '' : JSON.stringify(body));
    let out = '';
    s.on('connect', () => s.write(`${method} ${url} HTTP/1.1\r\nHost: localhost\r\nX-Forwarded-For: ${ip}\r\nContent-Type: ${type}\r\n` +
      `Content-Length: ${Buffer.byteLength(data)}\r\nConnection: close\r\n\r\n${data}`));
    s.on('data', (d) => { out += d; });
    s.on('end', () => {
      const status = Number(out.split(' ')[1]);
      let text = out.split('\r\n\r\n').slice(1).join('\r\n\r\n');
      if (/transfer-encoding: chunked/i.test(out.split('\r\n\r\n')[0])) {
        let rest = text; text = '';
        for (;;) {
          const i = rest.indexOf('\r\n'); const n = parseInt(rest.slice(0, i), 16);
          if (!n) break; text += rest.slice(i + 2, i + 2 + n); rest = rest.slice(i + 2 + n + 2);
        }
      }
      let json = null;
      try { json = JSON.parse(text); } catch (_) {}
      resolve({ status, json, text });
    });
    s.on('error', reject);
    s.setTimeout(15000, () => s.destroy(new Error('timeout')));
  });
}

test.before(async () => {
  port = await freePort();
  process.env.DEV_LOCAL_PORT = String(port);
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
  // The provider, stubbed: every relayed call is recorded and answered here, nothing leaves.
  globalThis.fetch = async (url, init) => { fetched.push({ url: String(url), init, body: JSON.parse(init.body) }); return fetchReply(init); };
  for (let i = 0; i < 60; i++) {
    try { const r = await call('GET', '/api/live', undefined, { ip: '10.7.9.' + i }); if (r.status === 200) return; } catch (_) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not come up');
});

test('rpcRequestError: one request, an allowed method, positional params, a plain id', () => {
  for (const m of WIDGET_METHODS) assert.strictEqual(Wallet.rpcRequestError({ jsonrpc: '2.0', id: '1', method: m, params: [] }), null, m);
  for (const m of EXPENSIVE) assert.strictEqual(Wallet.rpcRequestError({ jsonrpc: '2.0', id: 1, method: m, params: [] }), 'RPC method not allowed', m);
  assert.strictEqual(Wallet.rpcRequestError([{ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [] }]), 'Batch requests are not supported');
  assert.strictEqual(Wallet.rpcRequestError([]), 'Batch requests are not supported');
  for (const body of [null, undefined, 'x', 5, true]) assert.strictEqual(Wallet.rpcRequestError(body), 'Not a JSON-RPC request', String(body));
  assert.strictEqual(Wallet.rpcRequestError({}), 'RPC method not allowed');
  assert.strictEqual(Wallet.rpcRequestError({ method: 'toString' }), 'RPC method not allowed', 'an own allowlist, not a prototype lookup');
  assert.strictEqual(Wallet.rpcRequestError({ method: 'getBalance', params: { 0: 'x' } }), 'Not a JSON-RPC request');
  assert.strictEqual(Wallet.rpcRequestError({ method: 'getBalance', id: { a: 1 } }), 'Not a JSON-RPC request');
  assert.strictEqual(Wallet.rpcRequestError({ method: 'getHealth' }), null, 'params may be left out');
});

test('/api/rpc refuses batches and unlisted methods with 400 and never reaches the provider', async () => {
  const n = fetched.length;
  const batch = Array.from({ length: 50 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'getBalance', params: ['11111111111111111111111111111111'] }));
  let r = await call('POST', '/api/rpc', batch, { ip: '10.7.1.1' });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.json.error, 'Batch requests are not supported');
  r = await call('POST', '/api/rpc', { jsonrpc: '2.0', id: 1, method: 'getProgramAccounts', params: ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'] }, { ip: '10.7.1.2' });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.json.error, 'RPC method not allowed');
  r = await call('POST', '/api/rpc', { jsonrpc: '2.0', id: 1, method: 'getBlock', params: [1, { transactionDetails: 'full' }] }, { ip: '10.7.1.3' });
  assert.strictEqual(r.status, 400);
  r = await call('POST', '/api/rpc', null, { ip: '10.7.1.4', raw: 'getBalance', type: 'text/plain' });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(fetched.length, n, 'nothing was relayed');
});

test('/api/rpc relays an allowed call as one rebuilt JSON-RPC request with a timeout', async () => {
  const n = fetched.length;
  const r = await call('POST', '/api/rpc', { jsonrpc: '2.0', id: 'k7', method: 'getLatestBlockhash', params: [{ commitment: 'confirmed' }], extra: 'x'.repeat(50) }, { ip: '10.7.2.1' });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.json.result.value.blockhash, 'BH');
  assert.strictEqual(fetched.length, n + 1);
  const f = fetched[fetched.length - 1];
  assert.deepStrictEqual(f.body, { jsonrpc: '2.0', id: 'k7', method: 'getLatestBlockhash', params: [{ commitment: 'confirmed' }] }, 'only the four JSON-RPC fields go out');
  assert.ok(f.init.signal instanceof AbortSignal, 'the provider call has a deadline');
});

test('forwardRpc: the provider gets 10 s, and a reply over 2 MB is dropped, not buffered', async () => {
  const realTimeout = AbortSignal.timeout;
  let asked = null;
  AbortSignal.timeout = (ms) => { asked = ms; return realTimeout.call(AbortSignal, 20); };
  const saved = fetchReply;
  try {
    fetchReply = (init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason || new Error('aborted')));
    });
    const t0 = Date.now();
    await assert.rejects(Wallet.forwardRpc({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [] }));
    assert.strictEqual(asked, 10000);
    assert.ok(Date.now() - t0 < 5000, 'gave up at the deadline');
  } finally {
    AbortSignal.timeout = realTimeout;
  }
  try {
    // A streamed reply with no length header that grows past the cap.
    let pulled = 0;
    fetchReply = () => new Response(new ReadableStream({
      pull(ctrl) { pulled++; ctrl.enqueue(new Uint8Array(256 * 1024)); if (pulled > 64) ctrl.close(); },
    }));
    await assert.rejects(Wallet.forwardRpc({ method: 'getAccountInfo', params: ['x'] }), /too large/);
    assert.ok(pulled <= 12, 'stopped reading at the cap: ' + pulled + ' chunks');
    // A declared length over the cap is refused before reading.
    fetchReply = () => new Response('{}', { headers: { 'content-length': String(Wallet.RPC_RELAY_MAX_BYTES + 1) } });
    await assert.rejects(Wallet.forwardRpc({ method: 'getAccountInfo', params: ['x'] }), /too large/);
    // Under the cap: passed through as text.
    fetchReply = () => new Response('{"jsonrpc":"2.0","id":1,"result":42}');
    assert.strictEqual(await Wallet.forwardRpc({ method: 'getSlot' }), '{"jsonrpc":"2.0","id":1,"result":42}');
  } finally {
    fetchReply = saved;
  }
});

test('/api/my-transactions: a wallet must be an address, one answer per wallet is shared for 30 s, and the route is rate limited', async () => {
  const real = Usdc.usdcHistory;
  const asked = [];
  Usdc.usdcHistory = async (w) => { asked.push(w); return [{ signature: 's', at: 1, usdc: 1, direction: 'in' }]; };
  try {
    let r = await call('GET', '/api/my-transactions?wallet=not-a-wallet', undefined, { ip: '10.7.3.1' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(asked.length, 0, 'nothing asked of the chain');
    const W = 'Bv1nRbcm1zZ8y6aWvzt4gBBZW2fFy1E3fC2CqgGFhb9A';
    const [a, b] = await Promise.all([
      call('GET', '/api/my-transactions?wallet=' + W, undefined, { ip: '10.7.3.2' }),
      call('GET', '/api/my-transactions?wallet=' + W, undefined, { ip: '10.7.3.3' })]);
    assert.strictEqual(a.status, 200);
    assert.strictEqual(b.status, 200);
    assert.deepStrictEqual(a.json.transactions, b.json.transactions);
    r = await call('GET', '/api/my-transactions?wallet=' + W, undefined, { ip: '10.7.3.4' });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(asked, [W], 'one chain lookup for three asks within 30 s');
    // One IP looping over wallets: the limiter stops it.
    const statuses = [];
    const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    for (let i = 0; i < 31; i++) {
      const w = W.slice(0, -2) + B58[i % B58.length] + B58[Math.floor(i / B58.length)];
      statuses.push((await call('GET', '/api/my-transactions?wallet=' + w, undefined, { ip: '10.7.4.1' })).status);
    }
    assert.ok(statuses.slice(0, 30).every((s) => s === 200), statuses.join(','));
    assert.strictEqual(statuses[30], 429);
  } finally {
    Usdc.usdcHistory = real;
  }
});
