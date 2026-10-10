'use strict';
/* Night queue item 5, review findings on /api/stake-quote and /api/submit-stake, against the real
   server/index.js booted by scripts/dev-local.js (in-memory db, every outbound call refused) in
   this test's own process. Only the chain is stubbed: Wallet.submitStake (the broadcast) and
   Usdc.verifyUsdcStake (the landed amount and payer).
   - An off-rung stake (0.50499) is neither quoted nor minted (0.10499 used to be quoted 104990
     units and then bought the then $0.10 rung).
   - The retired $0.10 rung (BACKLOG 2.1) and the retired dime tier are refused at the quote and
     at the submit, before anything is broadcast; so is any stake while maintenance is on.
   - The verifier is asked for the exact rung, and a short payment is never rounded up to it.
   - A request naming another wallet than the on-chain payer is minted to the payer instead of
     refused after the signature was claimed (which stranded the stake with no token, no retry). */
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

// dev-local refuses http.request in this process, so requests go over a raw socket. Each
// request comes from its own forwarded address, so the 10-a-minute entry limiter never trips.
let ipSeq = 0;
function call(port, method, url, body) {
  const ip = '10.9.' + (++ipSeq >> 8) + '.' + (ipSeq & 255);
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    const data = body === undefined ? '' : JSON.stringify(body);
    let out = '';
    s.on('connect', () => s.write(`${method} ${url} HTTP/1.1\r\nHost: localhost\r\nX-Forwarded-For: ${ip}\r\nContent-Type: application/json\r\n` +
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
    s.setTimeout(5000, () => s.destroy(new Error('timeout')));
  });
}

let port;
const PAYER = 'PayerWa11et1111111111111111111111111111111';
const OTHER = 'OtherWa11et111111111111111111111111111111';
const verifyAsked = [];
let landed = 1; // what the stubbed chain says landed in escrow
let broadcasts = 0; // signed transfers the server sent to the chain

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
  const Wallet = require(path.join(ROOT, 'server', 'Wallet.js'));
  const Usdc = require(path.join(ROOT, 'server', 'Usdc.js'));
  let n = 0;
  Wallet.submitStake = async () => { broadcasts++; return 'sig-' + ++n; };
  Usdc.verifyUsdcStake = async (sig, min) => {
    verifyAsked.push(min);
    return { payer: PAYER, usdc: landed };
  };
  for (let i = 0; i < 60; i++) {
    try { const r = await call(port, 'GET', '/api/live'); if (r.status === 200) return; } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('server did not come up');
});

const tx = (s) => Buffer.from(s).toString('base64');

test('an off-rung stake is refused at the quote and at the submit, and a rung is minted as the rung', async () => {
  for (const stake of ['0.50499', '1.00499', '0.004', '0.505']) {
    const q = await call(port, 'GET', '/api/stake-quote?stake=' + stake);
    assert.strictEqual(q.status, 400, 'quote ' + stake);
    assert.match(q.json.error, /Buy-in must be one of/);
  }
  for (const stake of [0.50499, 1.00499, 0.004]) {
    const r = await call(port, 'POST', '/api/submit-stake', { stake, signedTx: tx('off' + stake), walletAddress: PAYER });
    assert.strictEqual(r.status, 400, 'submit ' + stake);
    assert.match(r.json.error, /Buy-in must be one of/);
    // The dev-token door too.
    const d = await call(port, 'POST', '/api/submit-stake', { stake, walletAddress: 'DevWallet' });
    assert.strictEqual(d.status, 400, 'dev submit ' + stake);
  }
  landed = 0.5;
  const ok = await call(port, 'POST', '/api/submit-stake', { stake: 0.5, signedTx: tx('rung-0.5'), walletAddress: PAYER });
  assert.strictEqual(ok.status, 200, ok.text);
  assert.strictEqual(ok.json.stake, 0.5);
  assert.strictEqual(ok.json.worth, 0.5);
});

test('the verifier is asked for the exact rung, and a short payment never buys the rung above it', async () => {
  verifyAsked.length = 0;
  landed = 1;
  const full = await call(port, 'POST', '/api/submit-stake', { stake: 1, signedTx: tx('full-1'), walletAddress: PAYER });
  assert.strictEqual(full.status, 200, full.text);
  assert.deepStrictEqual(verifyAsked, [1], 'no 1 percent tolerance');
  // Even if a short transfer got past the verifier, the rung is never rounded up to.
  landed = 0.995;
  const short = await call(port, 'POST', '/api/submit-stake', { stake: 1, signedTx: tx('short-1'), walletAddress: PAYER });
  assert.strictEqual(short.status, 200, short.text);
  assert.strictEqual(short.json.stake, 0.5, '0.995 buys the $0.50 rung, never the $1 seat');
  assert.strictEqual(short.json.paid, 0.995);
});

test('a request naming a different wallet than the payer is minted to the payer, not stranded', async () => {
  landed = 1;
  const r = await call(port, 'POST', '/api/submit-stake', { stake: 1, signedTx: tx('mismatch-1'), walletAddress: OTHER });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.json.ok, true);
  assert.ok(typeof r.json.entryToken === 'string' && r.json.entryToken.length > 0, 'a token exists for the stake');
  const src = require('fs').readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  assert.doesNotMatch(src, /Stake was paid by a different wallet/, 'no path refuses after the claim');
  assert.match(src, /entryStore\.mint\(\{ stake: rung, worth: rung, paid: worth, walletAddress: payer,\s*stakeSig: rec\.durable \? sig : undefined \}\)/, 'minted to the verified payer');
});

/* devGame (PAID-AGAR-DESIGN.md 5.7): the one game field submit-stake reads, and only to scope an unbacked DEV token
   (PAPER_DEV_TOKENS). It is pinned before anything reads it: an object, a number or an unknown string is a 400, and
   the process lives on (the route is async and Express 4 would not catch a throw). dev-local runs without
   PAPER_DEV_TOKENS here, so a valid devGame is simply ignored on the real path. */
test('devGame of an object, a number or an unknown string is refused with 400 before anything else, and nothing crashes', async () => {
  for (const devGame of [{ toString: 1 }, 5, 'snake', '', ['agar'], null]) {
    const r = await call(port, 'POST', '/api/submit-stake', { stake: 0.5, signedTx: tx('dg-' + JSON.stringify(devGame)), walletAddress: PAYER, devGame });
    assert.strictEqual(r.status, 400, JSON.stringify(devGame) + ' ' + r.text);
    assert.strictEqual(r.json && r.json.error, 'Malformed request');
  }
  const ok = await call(port, 'POST', '/api/submit-stake', { stake: 0.5, signedTx: tx('dg-agar'), walletAddress: PAYER, devGame: 'agar' });
  assert.strictEqual(ok.status, 200, ok.text);
  assert.strictEqual(ok.json.dev, undefined, 'no dev token without PAPER_DEV_TOKENS: the real path ran');
  const live = await call(port, 'GET', '/api/live');
  assert.strictEqual(live.status, 200, 'the server is still up');
});

/* BACKLOG 2.1: the $0.10 rung and the dime tier are retired. A lobby page or a signed transfer left
   over from before the deploy must be refused before the wallet prompt (the quote) or before the
   broadcast (the submit), so nothing lands for it and nothing is minted. */
test('the retired $0.10 rung and dime tier are refused at the quote and at the submit, before any broadcast', async () => {
  for (const q of ['/api/stake-quote?stake=0.1', '/api/stake-quote?stake=0.10', '/api/stake-quote?lobbyType=dime']) {
    const r = await call(port, 'GET', q);
    assert.strictEqual(r.status, 400, q + ' ' + r.text);
    assert.ok(!r.json.units && !r.json.escrowAta && !r.json.escrowAddress, 'no transfer target is handed out: ' + q);
  }
  assert.match((await call(port, 'GET', '/api/stake-quote?stake=0.1')).json.error, /^Buy-in must be one of \$0\.50, \$1$/);
  assert.strictEqual((await call(port, 'GET', '/api/stake-quote?lobbyType=dime')).json.error, 'Unknown lobby');
  const before = broadcasts;
  landed = 0.1;
  for (const body of [{ stake: 0.1 }, { stake: '0.10' }, { lobbyType: 'dime' }]) {
    const r = await call(port, 'POST', '/api/submit-stake', Object.assign({ signedTx: tx('retired-' + JSON.stringify(body)), walletAddress: PAYER }, body));
    assert.strictEqual(r.status, 400, JSON.stringify(body) + ' ' + r.text);
    assert.ok(!r.json.entryToken, 'no token');
  }
  // The dev-token door too.
  const d = await call(port, 'POST', '/api/submit-stake', { stake: 0.1, walletAddress: 'DevWallet' });
  assert.strictEqual(d.status, 400);
  assert.strictEqual(broadcasts, before, 'nothing was broadcast, so nothing landed');
  // The new rung quotes exactly 500000 units, the transfer the widget signs.
  const q5 = await call(port, 'GET', '/api/stake-quote?stake=0.5');
  if (q5.status === 200) {
    assert.strictEqual(q5.json.stake, 0.5);
    if (q5.json.units !== undefined) assert.strictEqual(q5.json.units, '500000');
  }
});

test('maintenance refuses a paid quote and a submit before the broadcast; free still quotes', async () => {
  const ops = require(path.join(ROOT, 'server', 'ops.js'));
  ops.set({ on: true, message: 'Deploying.' });
  try {
    const before = broadcasts;
    for (const q of ['/api/stake-quote?stake=0.5', '/api/stake-quote?stake=1', '/api/stake-quote?lobbyType=dollar']) {
      const r = await call(port, 'GET', q);
      assert.strictEqual(r.status, 503, q + ' ' + r.text);
      assert.strictEqual(r.json.maintenance, true);
      assert.match(r.json.error, /^Paid games are paused for maintenance\. Deploying\.$/);
    }
    const free = await call(port, 'GET', '/api/stake-quote?stake=0');
    assert.strictEqual(free.status, 200, 'free moves no money and still answers');
    landed = 0.5;
    for (const body of [{ stake: 0.5 }, { stake: 1 }, { lobbyType: 'dollar' }, { stake: 0.5, devGame: 'agar' }]) {
      const r = await call(port, 'POST', '/api/submit-stake', Object.assign({ signedTx: tx('maint-' + JSON.stringify(body)), walletAddress: PAYER }, body));
      assert.strictEqual(r.status, 503, JSON.stringify(body) + ' ' + r.text);
      assert.ok(!r.json.entryToken);
    }
    assert.strictEqual(broadcasts, before, 'a transfer signed before maintenance is never sent');
  } finally {
    ops.set({ on: false });
  }
  landed = 0.5;
  const ok = await call(port, 'POST', '/api/submit-stake', { stake: 0.5, signedTx: tx('after-maint'), walletAddress: PAYER });
  assert.strictEqual(ok.status, 200, 'and stakes open again once it is off: ' + ok.text);
});
