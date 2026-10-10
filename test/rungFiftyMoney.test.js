'use strict';
/* BACKLOG 2.1 money proof for the games with no proof script of their own: slither.io (the paid snake
   on the old engine), Knockout and Battleship, at the new $0.50 rung. Paper and agar.io have their
   own end-to-end proofs with dev tokens (scratchpad e2e-paid.js, agario-reference agproof.js); dev
   tokens are scoped to those two games, so these three are driven with REAL entry tokens instead.

   The real server/index.js, booted by scripts/dev-local.js in this test's own process (in-memory
   database modelled by scripts/memLedgerDb.js, every outbound call refused except this test's own
   localhost sockets). Only the chain is stubbed: Wallet.submitStake (the broadcast),
   Usdc.verifyUsdcStake (what landed and who paid) and money.withdraw (every payout, recorded here in
   micro-dollars instead of sent). No real money moves.

   For each game: what went in (the stakes that landed) equals what came out (cash-outs, rake and
   refunds), the 90/10 split is exact at $0.50 (450000 + 50000 micro on a fresh seat; a $0.50
   Knockout or Battleship pot of 1.00 pays a 0.90 prize), a stale $0.10 entry is refused and never
   seated, and a $0.10 stake row left by the old process is refunded 0.10 once at boot. */
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const realRequest = http.request;
const realGet = http.get;
const C = require('../shared/constants');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

let ipSeq = 0;
function call(port, method, url, body) {
  // A fresh forwarded address per call, so the per-address stake limiter never decides a result.
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

const micro = (v) => Math.round(Number(v) * 1e6);
const until = async (fn, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); }
  return fn();
};

let port, ledgerDb, REVENUE;
let landed = 0.5;
let payer = 'Payer0';
let sigN = 0;
const deposits = [];   // [wallet, micro] for every stake that landed (the stubbed chain's side)
const sent = [];       // [wallet, micro] for every payout the server made
const tx = (s) => Buffer.from(s).toString('base64');
const wallet = (tag) => ('Rung50' + tag + '1'.repeat(44)).slice(0, 44);
const STALE = wallet('Stale');

test.before(async () => {
  port = await freePort();
  process.env.DEV_LOCAL_PORT = String(port);
  process.env.DEV_LOCAL_SEED_STAKES = JSON.stringify([
    // A $0.10 stake the old process verified (before BACKLOG 2.1) and never seated: its token died
    // with that process. The new boot must owe it back, 0.10, once.
    { sig: 'stale-dime-sig', state: 'pending', wallet_address: STALE, refund_amount: 0.1, label: 'stake 0.1', region: 'na', boot_id: 'boot-before-2.1' },
  ]);
  const log = console.log; const warn = console.warn;
  console.log = () => {}; console.warn = () => {};
  try {
    ({ ledgerDb } = require(path.join(ROOT, 'scripts', 'dev-local.js')));
  } finally {
    console.log = log; console.warn = warn;
  }
  const blockedRequest = http.request;
  const local = (a) => a && typeof a === 'object' && ['localhost', '127.0.0.1'].includes(a.hostname || a.host) && Number(a.port) === port;
  http.request = function (...a) { return local(a[0]) ? realRequest.apply(http, a) : blockedRequest.apply(http, a); };
  http.get = function (...a) { return local(a[0]) ? realGet.apply(http, a) : blockedRequest.apply(http, a); };
  const Wallet = require(path.join(ROOT, 'server', 'Wallet.js'));
  const Usdc = require(path.join(ROOT, 'server', 'Usdc.js'));
  const money = require(path.join(ROOT, 'server', 'money.js'));
  Wallet.submitStake = async () => 'r50-sig-' + ++sigN;
  Usdc.verifyUsdcStake = async () => { deposits.push([payer, micro(landed)]); return { payer, usdc: landed }; };
  money.withdraw = async (w, amt) => { sent.push([w, micro(amt)]); return 'DEVSIG-' + sent.length; };
  REVENUE = require('fs').readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8').match(/const REVENUE_WALLET = '([^']+)'/)[1];
  for (let i = 0; i < 60; i++) {
    try { const r = await call(port, 'GET', '/api/live'); if (r.status === 200) return; } catch (_) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not come up');
});

function connect() {
  const { io } = require('socket.io-client');
  const parser = require('socket.io-parser');
  class Decoder extends parser.Decoder {
    constructor(o) { super(Object.assign({ maxAttachments: 100000 }, typeof o === 'object' ? o : {})); }
  }
  const s = io(`http://127.0.0.1:${port}`, { transports: ['websocket'], forceNew: true, reconnection: false, timeout: 5000,
    parser: { ...parser, Decoder } });
  const got = [];
  s.onAny((ev, p) => got.push([ev, p]));
  return new Promise((res, rej) => {
    const bail = setTimeout(() => rej(new Error('socket never connected')), 8000);
    s.on('connect', () => { clearTimeout(bail); res({ s, got, has: (ev) => got.find((g) => g[0] === ev) }); });
    s.on('connect_error', (e) => { clearTimeout(bail); rej(e); });
  });
}

async function stake(amount, who) {
  landed = amount;
  payer = who;
  const r = await call(port, 'POST', '/api/submit-stake', { stake: amount, signedTx: tx('t' + Math.random()), walletAddress: who });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.json.stake, amount);
  return r.json.entryToken;
}
const sentTo = (w) => sent.filter((x) => x[0] === w).map((x) => x[1]);
const depositsBy = (ws) => deposits.filter((d) => ws.includes(d[0])).reduce((n, d) => n + d[1], 0);

test('boot: the old process\'s $0.10 stake row is owed back 0.10 once, to its payer, and never seated', async () => {
  const owed = await until(() => ledgerDb.payouts.find((p) => p.stake_sig === 'stale-dime-sig'));
  assert.ok(owed, 'the boot sweep ran');
  assert.deepStrictEqual([owed.wallet_address, micro(owed.amount_sol)], [STALE, 100000], 'exactly what it stored, not the new rung');
  assert.match(owed.reason, /^refund unspent entry stake 0\.1 \(the server restarted before the join\)$/);
  assert.strictEqual(ledgerDb.stakes.get('stale-dime-sig').state, 'refunded');
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(ledgerDb.payouts.filter((p) => p.stake_sig === 'stale-dime-sig').length, 1, 'once');
  // A $0.10 cannot be bought again: refused before the broadcast.
  const before = sigN;
  const r = await call(port, 'POST', '/api/submit-stake', { stake: 0.1, signedTx: tx('stale'), walletAddress: STALE });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(sigN, before, 'nothing was broadcast');
});

test('slither.io at $0.50: 500000 in, a held cash-out pays 450000 to the player and 50000 rake; a $0.10 join is refused', async () => {
  const W = wallet('Snake');
  const tok = await stake(0.5, W);
  const sig = 'r50-sig-' + sigN;
  assert.strictEqual(ledgerDb.stakes.get(sig).refund_amount, 0.5, 'its row refunds at most 0.50');

  // The stale $0.10 page first: refused, not seated, the token untouched.
  const old = await connect();
  old.s.emit('play', { name: 'old', stake: 0.1, entryToken: tok, region: 'na', walletAddress: W, googleId: W });
  const err = await until(() => old.has('error'));
  assert.ok(err && /no longer offered/.test(err[1].message), JSON.stringify(old.got.map((g) => g[0])));
  assert.ok(!old.has('game_joined'));
  assert.strictEqual(ledgerDb.stakes.get(sig).state, 'pending');
  old.s.close();

  const c = await connect();
  c.s.emit('play', { name: 'snk', stake: 0.5, entryToken: tok, region: 'na', walletAddress: W, googleId: W });
  assert.ok(await until(() => c.has('game_joined'), 8000), JSON.stringify(c.got.map((g) => g[0])));
  assert.strictEqual(ledgerDb.stakes.get(sig).state, 'consumed');
  c.s.emit('cashout:start');
  const res = await until(() => c.has('cashout:result'), C.CASHOUT_HOLD_MS + 4000);
  assert.ok(res, 'cashed out after the hold: ' + JSON.stringify(c.got.map((g) => g[0]).filter((e) => /cash|died/.test(e))));
  assert.deepStrictEqual([micro(res[1].gross), micro(res[1].cut), micro(res[1].earnedSol)], [500000, 50000, 450000]);
  await until(() => sentTo(W).length && sentTo(REVENUE).length);
  assert.deepStrictEqual(sentTo(W), [450000], '90 percent to the player');
  assert.deepStrictEqual(sentTo(REVENUE), [50000], '10 percent to the house');
  assert.strictEqual(depositsBy([W]), 500000);
  assert.strictEqual(depositsBy([W]), sentTo(W)[0] + sentTo(REVENUE)[0], 'deposit = cash-out + rake');
  c.s.close();
});

async function duel(game, pre) {
  const A = wallet(pre + 'A'), B = wallet(pre + 'B'), Q = wallet(pre + 'Q');
  const revBefore = sentTo(REVENUE).length;
  const tokA = await stake(0.5, A);
  const tokB = await stake(0.5, B);
  const a = await connect(), b = await connect();
  // A stale $0.10 seat is refused, and the $0.50 token it carried is not spent.
  a.s.emit(game + ':queue', { name: 'a', stake: 0.1, entryToken: tokA });
  const no = await until(() => a.has(game + ':refused'));
  assert.ok(no && /no longer offered/.test(no[1].why), game + ' $0.10 refused as a retired buy-in');
  assert.ok(!a.has(game + ':queued'));
  await new Promise((r) => setTimeout(r, 1100));   // the queue's own rate limit
  a.s.emit(game + ':queue', { name: 'a', stake: 0.5, entryToken: tokA });
  // B names the rung with float noise inside the token's 1e-9 match. It is queued at the ladder's own
  // 0.5, so it is matched with A (keyed by the client's number, it sat in a bucket of its own).
  b.s.emit(game + ':queue', { name: 'b', stake: 0.5000000005, entryToken: tokB });
  const qa = await until(() => a.has(game + ':queued'));
  assert.ok(qa, JSON.stringify(a.got.map((g) => g[0])));
  assert.deepStrictEqual([qa[1].stake, qa[1].worth], [0.5, 0.5]);
  const qb = await until(() => b.has(game + ':queued'));
  assert.ok(qb, JSON.stringify(b.got.map((g) => g[0])));
  assert.deepStrictEqual([qb[1].stake, qb[1].worth], [0.5, 0.5], 'queued at the rung itself, not the number sent');
  const started = game === 'ko' ? 'ko:start' : 'bs:state';
  assert.ok(await until(() => a.has(started) && b.has(started), 8000), 'matched: ' + JSON.stringify(a.got.map((g) => g[0])));
  // A walks out of the match: the table is B's. Pot 1.00, prize 0.90, rake 0.10.
  a.s.emit(game + ':leave');
  await until(() => sentTo(B).length && sentTo(REVENUE).length > revBefore);
  assert.deepStrictEqual(sentTo(B), [900000], 'the winner is paid 90 percent of the 1.00 pot');
  assert.deepStrictEqual(sentTo(REVENUE).slice(revBefore), [100000], 'the house keeps 10 percent');
  assert.deepStrictEqual(sentTo(A), [], 'the loser is paid nothing');

  // A paid seat that backs out of the queue gets its 0.50 back, once.
  const tokQ = await stake(0.5, Q);
  const q = await connect();
  q.s.emit(game + ':queue', { name: 'q', stake: 0.5, entryToken: tokQ });
  assert.ok(await until(() => q.has(game + ':queued')));
  q.s.emit(game + ':unqueue');
  await until(() => sentTo(Q).length);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepStrictEqual(sentTo(Q), [500000], 'refunded the whole stake, no rake');

  const inMicro = depositsBy([A, B, Q]);
  const outMicro = sentTo(A).concat(sentTo(B), sentTo(Q), sentTo(REVENUE).slice(revBefore)).reduce((n, m) => n + m, 0);
  assert.strictEqual(inMicro, 1500000);
  assert.strictEqual(outMicro, inMicro, 'deposits = prize + rake + refunds');
  for (const s of [a, b, q]) s.s.close();
}

test('Knockout at $0.50: two 500000 stakes, the winner takes 900000 and the house 100000; a queue refund is 500000', async () => {
  await duel('ko', 'Ko');
});

test('Battleship at $0.50: the same split through its own lobby', async () => {
  await duel('bs', 'Bs');
});

test('every payout this run is accounted for: nothing paid that did not land', () => {
  const inMicro = deposits.reduce((n, d) => n + d[1], 0);
  const outMicro = sent.reduce((n, s) => n + s[1], 0);
  assert.strictEqual(outMicro, inMicro, JSON.stringify({ deposits, sent }));
  // 100000 appears only as the house's 10 percent of a 1.00 duel pot, never as a player's stake back.
  assert.ok(sent.every((s) => s[1] !== 100000 || s[0] === REVENUE), 'no player was paid or refunded the retired $0.10');
});
