'use strict';
/* Night review 2026-10-29, second pass on findings 2 and 22: one address could hold the public budget empty for
   everyone. The per-IP count allowed 40 asks per 10 s and a balance is two provider calls, twice the whole
   server-wide rate (4 a second), so a single curl loop on /api/sol-balance left 1 of 40 honest balance polls coming
   back, and in SOL mode Withdraw, a skin buy and Add from a linked wallet read that balance first ('Could not read
   your balance').

   Now each address has a share of the budget (rpcBudget.callerShare: a quarter of the rate, half the burst): past it
   the address alone is refused, with a 429, and the rest of the budget stays for everyone else. The real server
   (scripts/dev-local.js), every provider call stubbed. */
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
  process.env.PUBLIC_RPC_RPS = '0.4';    // each address's share: 0.1 a second, so nothing of it refills while these steps run
  process.env.PUBLIC_RPC_BURST = '40';   // each address's share: a burst of 20, ten balances
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


const A = '10.9.1.1';        // the flood
const W = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

test('one address flooding /api/sol-balance gets its share; every other address still gets its balance', async () => {
  const realSol = Wallet.getAddressBalance;
  const realUsdc = Usdc.usdcBalanceOf;
  const provider = [];
  Wallet.getAddressBalance = async (a) => { provider.push('sol:' + a); return 0.5; };
  Usdc.usdcBalanceOf = async (a) => { provider.push('usdc:' + a); return 3; };
  try {
    const flood = [];
    for (let i = 0; i < 20; i++) flood.push(await call('GET', '/api/sol-balance?address=' + W, undefined, { ip: A }));
    assert.deepStrictEqual(flood.map((r) => r.status), [...Array(10).fill(200), ...Array(10).fill(429)],
      'ten balances (its burst of 20 calls), then refused');
    const no = flood[10];
    assert.deepStrictEqual(no.json, { error: 'Too many requests. Slow down.' });
    assert.match(no.head, /retry-after: 5/i, 'its share refused it, not the per-IP count');
    assert.match(no.head, /ratelimit-remaining: [1-9]\d*/i, 'which still had room');
    assert.strictEqual(provider.length, 20, 'the refused ones asked nothing of the chain');
    // Everyone else: the budget's other 20 are theirs.
    for (const ip of ['10.9.2.1', '10.9.2.2', '10.9.2.3', '10.9.2.4']) {
      const r = await call('GET', '/api/sol-balance?address=' + W, undefined, { ip });
      assert.strictEqual(r.status, 200, ip + ': ' + r.text);
      assert.strictEqual(r.json.balance, 3);
    }
    // The relay is the same share: refused for the flood, open for anyone else.
    let r = await call('POST', '/api/rpc', { jsonrpc: '2.0', id: 1, method: 'getSlot' }, { ip: A });
    assert.strictEqual(r.status, 429);
    const relayed = fetched.length;
    r = await call('POST', '/api/rpc', { jsonrpc: '2.0', id: 1, method: 'getSlot' }, { ip: '10.9.2.5' });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(fetched.length, relayed + 1);
  } finally {
    Wallet.getAddressBalance = realSol;
    Usdc.usdcBalanceOf = realUsdc;
  }
});

test('a fresh blockhash is counted to whoever asked for it; a shared one costs nobody anything', async () => {
  const real = Wallet.getLatestBlockhash;
  let asked = 0;
  Wallet.getLatestBlockhash = async () => { asked++; return { blockhash: 'BH' + asked, lastValidBlockHeight: 9 }; };
  try {
    let r = await call('GET', '/api/blockhash', undefined, { ip: A });
    assert.strictEqual(r.status, 503, 'its share is spent and there is no blockhash to share yet');
    assert.deepStrictEqual(r.json, { error: 'Busy, try again in a moment.' });
    assert.strictEqual(asked, 0);
    r = await call('GET', '/api/blockhash', undefined, { ip: '10.9.3.1' });
    assert.deepStrictEqual([r.status, r.json.blockhash], [200, 'BH1']);
    r = await call('GET', '/api/blockhash', undefined, { ip: A });
    assert.deepStrictEqual([r.status, r.json.blockhash], [200, 'BH1'], 'the shared one, within its 2 s');
    assert.strictEqual(asked, 1);
  } finally {
    Wallet.getLatestBlockhash = real;
  }
});
