'use strict';
/* STATUS item 7a against the real server/index.js, booted by scripts/dev-local.js in this test's
   own process (in-memory database modelled by scripts/memLedgerDb.js, every outbound call refused
   except this test's own localhost socket). Only the chain is stubbed: Wallet.submitStake and
   Usdc.verifyUsdcStake. It proves the wiring the unit tests cannot:
   - at boot, a stake that an earlier boot of this server verified and never seated is owed back
     once through the owed-payout lane, and nothing else is;
   - /api/submit-stake writes the durable row (payer, what a refund pays, region, this boot);
   - a real token seated at Paper, snake (ladder and tier) and knockout claims its row first
     ('consumed'), a token sent to agar.io (the old door is gone, the new game reads none) is never
     touched, and a Paper door
     refusal pays back through the row, once. */
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const realRequest = http.request;
const realGet = http.get;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

let ipSeq = 0;
function call(port, method, url, body) {
  const ip = '10.8.' + (++ipSeq >> 8) + '.' + (ipSeq & 255);
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

const PAYER = 'DurablePayer111111111111111111111111111111';
let port, ledgerDb, ops;
let landed = 0.1;
const tx = (s) => Buffer.from(s).toString('base64');
const until = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); }
  return fn();
};

test.before(async () => {
  port = await freePort();
  process.env.DEV_LOCAL_PORT = String(port);
  process.env.DEV_LOCAL_SEED_STAKES = JSON.stringify([
    // An earlier boot of this NA server verified this stake; its token died with that process.
    { sig: 'orphan-sig', state: 'pending', wallet_address: 'OrphanWallet', refund_amount: 0.1, label: 'stake 0.1', region: 'na', boot_id: 'dead-boot' },
    // Seated before that restart: its money was in play, never refunded at boot.
    { sig: 'seated-sig', state: 'consumed', claim_key: 'k', wallet_address: 'SeatedWallet', refund_amount: 1, label: 'stake 1', region: 'na', boot_id: 'dead-boot' },
    // EU is alive and its token is live: not this server's to refund.
    { sig: 'eu-sig', state: 'pending', wallet_address: 'EuWallet', refund_amount: 0.1, label: 'stake 0.1', region: 'eu', boot_id: 'eu-boot' },
    // Written before durable rows existed.
    { sig: 'legacy-sig', state: null },
  ]);
  const log = console.log; const warn = console.warn;
  console.log = () => {}; console.warn = () => {};
  try {
    ({ ledgerDb } = require(path.join(ROOT, 'scripts', 'dev-local.js')));
  } finally {
    console.log = log; console.warn = warn;
  }
  // This test's own socket to this server is the one outbound call let through.
  const blockedRequest = http.request;
  const local = (a) => a && typeof a === 'object' && ['localhost', '127.0.0.1'].includes(a.hostname || a.host) && Number(a.port) === port;
  http.request = function (...a) { return local(a[0]) ? realRequest.apply(http, a) : blockedRequest.apply(http, a); };
  http.get = function (...a) { return local(a[0]) ? realGet.apply(http, a) : blockedRequest.apply(http, a); };
  ops = require(path.join(ROOT, 'server', 'ops.js'));
  const Wallet = require(path.join(ROOT, 'server', 'Wallet.js'));
  const Usdc = require(path.join(ROOT, 'server', 'Usdc.js'));
  let n = 0;
  Wallet.submitStake = async () => 'sig-' + ++n;
  Usdc.verifyUsdcStake = async () => ({ payer: PAYER, usdc: landed });
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

async function stake(amount, extra = {}) {
  landed = amount;
  const r = await call(port, 'POST', '/api/submit-stake', { stake: amount, signedTx: tx('t' + Math.random()), walletAddress: PAYER, ...extra });
  assert.strictEqual(r.status, 200, r.text);
  return r.json.entryToken;
}
const lastSig = () => [...ledgerDb.stakes.keys()].filter((k) => /^sig-/.test(k)).sort((a, b) => Number(a.slice(4)) - Number(b.slice(4))).pop();

test('at boot the orphaned stake is owed back once, and nothing else is', async () => {
  const owed = await until(() => ledgerDb.payouts.find((p) => p.stake_sig === 'orphan-sig'));
  assert.ok(owed, 'the boot sweep ran');
  assert.deepStrictEqual([owed.wallet_address, owed.amount_sol], ['OrphanWallet', 0.1]);
  assert.match(owed.reason, /^refund unspent entry stake 0\.1 \(the server restarted before the join\)/);
  await new Promise((r) => setTimeout(r, 200));
  assert.deepStrictEqual(ledgerDb.payouts.map((p) => p.stake_sig), ['orphan-sig']);
  assert.deepStrictEqual(['orphan-sig', 'seated-sig', 'eu-sig', 'legacy-sig'].map((s) => ledgerDb.stakes.get(s).state),
    ['refunded', 'consumed', 'pending', null]);
});

test('/wallet/debug reports the ledger flags of this boot (two booleans, STATUS item 7e)', async () => {
  const r = await call(port, 'GET', '/wallet/debug');
  assert.equal(r.status, 200);
  assert.deepStrictEqual(r.json.ledger, { durableStakes: true, payoutLanes: true });
});

test('submit-stake writes the durable row: the payer, what a refund pays, this region and this boot', async () => {
  await stake(1, { walletAddress: 'SomebodyElse' });
  const row = ledgerDb.stakes.get(lastSig());
  assert.strictEqual(row.state, 'pending');
  assert.strictEqual(row.wallet_address, PAYER, 'the verified payer, never the request');
  assert.strictEqual(row.refund_amount, 1);
  assert.strictEqual(row.region, 'na');
  assert.ok(row.boot_id && row.boot_id !== 'dead-boot');
});

test('a real token at Paper claims its row before the seat, and a refusal at the door pays back through the row once', async () => {
  const tok = await stake(0.1);
  const sig = lastSig();
  const c = await connect();
  c.s.emit('pp:join', { name: 'dur', stake: 0.1, entryToken: tok });
  assert.ok(await until(() => c.has('pp:joined'), 6000), 'seated: ' + JSON.stringify(c.got.map((g) => g[0])));
  assert.strictEqual(ledgerDb.stakes.get(sig).state, 'consumed');
  assert.ok(ledgerDb.stakes.get(sig).claim_key);
  c.s.close();

  const tok2 = await stake(0.1);
  const sig2 = lastSig();
  ops.set({ on: true, message: 'test' });
  try {
    const c2 = await connect();
    c2.s.emit('pp:join', { name: 'dur2', stake: 0.1, entryToken: tok2 });
    const refused = await until(() => c2.has('pp:refused'));
    assert.deepStrictEqual([refused[1].why, refused[1].refunded], ['maintenance', true]);
    const owed = await until(() => ledgerDb.payouts.filter((p) => p.stake_sig === sig2).length === 1 && ledgerDb.payouts.filter((p) => p.stake_sig === sig2));
    assert.deepStrictEqual(owed.map((p) => [p.wallet_address, p.amount_sol, p.reason]), [[PAYER, 0.1, 'refund paper maintenance']]);
    assert.strictEqual(ledgerDb.stakes.get(sig2).state, 'refunded');
    c2.s.close();
  } finally {
    ops.set({ on: false });
  }
});

test('a real token at the snake and knockout doors claims its row before seating; agar.io never touches a token', async () => {
  const tok = await stake(0.1);
  const sig = lastSig();
  const c = await connect();
  c.s.emit('play', { name: 'snk', stake: 0.1, entryToken: tok, region: 'na' });
  assert.ok(await until(() => c.has('game_joined'), 6000), 'snake joined: ' + JSON.stringify(c.got.map((g) => g[0])));
  assert.strictEqual(ledgerDb.stakes.get(sig).state, 'consumed');
  c.s.close();

  const tokK = await stake(0.1);
  const sigK = lastSig();
  const k = await connect();
  k.s.emit('ko:queue', { name: 'ko', stake: 0.1, entryToken: tokK });
  const queued = await until(() => k.has('ko:queued'));
  assert.ok(queued, JSON.stringify(k.got.map((g) => g[0])));
  assert.strictEqual(queued[1].worth, 0.1);
  assert.strictEqual(ledgerDb.stakes.get(sigK).state, 'consumed');
  k.s.close();

  /* The old tier door (dime), through the tier submit path. agar.io has no paid door at all now:
     the old game's cell:join is gone with it (test/agarSwap.test.js), and the new game on /ag
     reads no token. So a dime token sent to either agar door is never touched and its row stays
     pending; the same token then claims its row at the snake dime door. */
  landed = 0.1;
  const r = await call(port, 'POST', '/api/submit-stake', { lobbyType: 'dime', signedTx: tx('agar-dime'), walletAddress: PAYER });
  assert.strictEqual(r.status, 200, r.text);
  const sigA = lastSig();
  assert.strictEqual(ledgerDb.stakes.get(sigA).label, 'lobby dime');
  const a = await connect();
  a.s.emit('cell:join', { name: 'ag', lobbyType: 'dime', entryToken: r.json.entryToken, region: 'na' });
  a.s.emit('cell:respawn', { entryToken: r.json.entryToken });
  const pong = new Promise((res) => { a.s.once('pong_check', () => res(true)); setTimeout(() => res(false), 4000); });
  a.s.emit('ping_check');
  assert.ok(await pong, 'the server handled both');
  assert.ok(!a.has('cell:joined') && !a.has('cell:join:error'), 'the old agar door answers nothing: it is gone');
  assert.strictEqual(ledgerDb.stakes.get(sigA).state, 'pending');
  const { io } = require('socket.io-client');
  const g = io(`http://127.0.0.1:${port}/ag`, { transports: ['websocket'], forceNew: true, reconnection: false, timeout: 5000 });
  try {
    const frames = [];
    g.on('ag:f', (b) => frames.push(b));
    assert.ok(await until(() => g.connected), 'the new agar.io namespace is open');
    g.emit('ag:join', { name: 'paid', entryToken: r.json.entryToken, stake: 0.1 });
    const n = frames.length;
    assert.ok(await until(() => frames.length > n + 3), 'seated and sent its world, free');
  } finally {
    g.close();
  }
  assert.strictEqual(ledgerDb.stakes.get(sigA).state, 'pending', 'the new agar.io never touched the token');
  a.s.emit('play', { name: 'tier', lobbyType: 'dime', entryToken: r.json.entryToken, region: 'na' });
  await until(() => ledgerDb.stakes.get(sigA).state === 'consumed');
  assert.strictEqual(ledgerDb.stakes.get(sigA).state, 'consumed');
  a.s.close();

  // A token whose row a sweep refunded first is never seated anywhere.
  const tokR = await stake(0.1);
  const sigR = lastSig();
  await ledgerDb.refundStakeOwed(sigR, 'refund unspent entry (sweep)', null);
  const x = await connect();
  x.s.emit('play', { name: 'late', stake: 0.1, entryToken: tokR, region: 'na' });
  const err = await until(() => x.has('error'));
  assert.ok(err, JSON.stringify(x.got.map((g) => g[0])));
  assert.match(err[1].message, /already refunded/);
  assert.ok(!x.has('game_joined'));
  assert.strictEqual(ledgerDb.payouts.filter((p) => p.stake_sig === sigR).length, 1);
  x.s.close();
});
