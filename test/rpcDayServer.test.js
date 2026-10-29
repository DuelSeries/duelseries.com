'use strict';
/* Night review 2026-10-29, fourth pass on findings 1, 2 and 22 (review problem 0): the shared key's day on the real
   server (scripts/dev-local.js), every provider call stubbed.

   The server boots with its day already spent in the file (RPC_DAY_PATH), as it would after a flood and a deploy: the
   boot does not refill it. Spent, it only turns balances stale or unknown and history and the relay busy; the money
   lane (a send's blockhash, the send itself) takes nothing from it and goes on. dev-local leaves PUBLIC_RPC_URL unset,
   so the public reads share the money key, the case the day is for. Run with --test-force-exit (npm test does). */
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const realRequest = http.request;
const realGet = http.get;
const DAY_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rpcdaysrv-')), 'rpc-day.json');

let port, Wallet, Usdc, rpcDay;
const fetched = [];

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function call(method, url, body, { ip = '10.7.0.1' } = {}) {
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
  // The day as a flood left it, saved a moment before this boot.
  fs.writeFileSync(DAY_FILE, JSON.stringify({ v: 1, at: Date.now(), perDay: 10000, spent: 10000, share: 1250, keys: [] }));
  process.env.RPC_DAY_PATH = DAY_FILE;
  delete process.env.PUBLIC_RPC_URL;
  delete process.env.RPC_READS_PER_DAY;
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
  rpcDay = require(path.join(ROOT, 'server', 'rpcDay.js'));
  globalThis.fetch = async (url, init) => {
    fetched.push(JSON.parse(init.body));
    return new Response('{"jsonrpc":"2.0","id":1,"result":42}', { headers: { 'content-type': 'application/json' } });
  };
  for (let i = 0; i < 60; i++) {
    try { const r = await call('GET', '/api/live', undefined, { ip: '10.7.9.' + i }); if (r.status === 200) return; } catch (_) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not come up');
});

test('booted with its day spent in the file: the boot did not refill it, and it is the file dev-local was given', () => {
  assert.notStrictEqual(rpcDay.day, null, 'PUBLIC_RPC_URL unset: the public reads share the money key, so there is a day');
  assert.strictEqual(rpcDay.FILE, DAY_FILE);
  assert.ok(rpcDay.day.left() < 5, 'what refilled in the seconds since it was saved, no more: ' + rpcDay.day.left());
});

test('a spent day: balances 503 (or stale), the relay and history are busy, nothing is asked of the chain', async () => {
  const realSol = Wallet.getAddressBalance, realUsdc = Usdc.usdcBalanceOf;
  const realPage = Usdc.historyConnection.getSignaturesForAddress;
  const asked = [];
  Wallet.getAddressBalance = async () => { asked.push('sol'); return 0.5; };
  Usdc.usdcBalanceOf = async () => { asked.push('usdc'); return 3; };
  Usdc.historyConnection.getSignaturesForAddress = async () => { asked.push('history'); return []; };
  const W = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
  try {
    let r = await call('GET', '/api/sol-balance?address=' + W, undefined, { ip: '10.7.1.1' });
    assert.strictEqual(r.status, 503, r.text);
    assert.deepStrictEqual(r.json, { error: 'Busy, try again in a moment.' });
    assert.match(r.head, /retry-after: 60/i, 'the day refills about one call in 9 s: the browser is asked to wait a minute');
    const relayed = fetched.length;
    r = await call('POST', '/api/rpc', { jsonrpc: '2.0', id: 1, method: 'getSlot' }, { ip: '10.7.1.2' });
    assert.strictEqual(r.status, 503);
    assert.strictEqual(fetched.length, relayed, 'not relayed');
    r = await call('GET', '/api/my-transactions?wallet=' + W, undefined, { ip: '10.7.1.3' });
    assert.strictEqual(r.status, 502, 'history busy: the Wallet tab\'s "Tap refresh"');
    assert.deepStrictEqual(asked, [], 'nothing asked of the chain for any of them');
  } finally {
    Wallet.getAddressBalance = realSol;
    Usdc.usdcBalanceOf = realUsdc;
    Usdc.historyConnection.getSignaturesForAddress = realPage;
  }
});

test('a spent day never touches the money lane: a send\'s blockhash and the send itself go through', async () => {
  const realBh = Wallet.getLatestBlockhash, realSubmit = Wallet.submitStake;
  const money = [];
  Wallet.getLatestBlockhash = async () => { money.push('blockhash'); return { blockhash: 'SEND', lastValidBlockHeight: 9 }; };
  Wallet.submitStake = async (buf) => { money.push('send:' + buf.length); return 'SIG'; };
  try {
    let r = await call('GET', '/api/blockhash', undefined, { ip: '10.7.2.1' });
    assert.deepStrictEqual([r.status, r.json && r.json.blockhash], [200, 'SEND']);
    r = await call('POST', '/api/broadcast', { signedTx: Buffer.from('a signed transfer').toString('base64') }, { ip: '10.7.2.1' });
    assert.deepStrictEqual([r.status, r.json], [200, { ok: true, sig: 'SIG' }]);
    assert.deepStrictEqual(money, ['blockhash', 'send:17']);
    assert.ok(rpcDay.day.left() < 5, 'and neither took anything from the day (it had nothing to give)');
  } finally {
    Wallet.getLatestBlockhash = realBh;
    Wallet.submitStake = realSubmit;
  }
});
