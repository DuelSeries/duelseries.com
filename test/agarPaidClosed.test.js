'use strict';
/* AGAR_PAID is off: the OLD agar.io game takes no money (server/index.js, "AGAR_PAID").

   Against the real server/index.js, booted by scripts/dev-local.js in this test's own process
   (in-memory database from scripts/memLedgerDb.js, every outbound call refused except this
   test's own localhost socket). Only the chain is stubbed (Wallet.submitStake and
   Usdc.verifyUsdcStake), the same way test/durableStakeServer.test.js does it.

   It proves, with real tier tokens whose stake rows are durable:
   - a paid agar join ($0.10 or $1) is refused with the closed message and seats nobody, BEFORE
     its token is looked at: the stake row stays 'pending', nothing is owed or paid, and the very
     same token still opens the snake room of that price afterwards (so a refused agar buyer is
     never stranded: the token is used elsewhere or expires into the existing refund);
   - a paid agar respawn (a socket pointed at a paid room by spectate:join:agar) is refused the
     same way;
   - /api/submit-stake refuses an agar room name before anything is broadcast or claimed, and
     neither of its doors can name a game at all;
   - free agar still joins and respawns exactly as before. */
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const http = require('http');
const path = require('path');
const fs = require('fs');

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

const PAYER = 'AgarClosedPayer11111111111111111111111111';
let port, ledgerDb;
let landed = 0.1;
let broadcasts = 0;
const tx = (s) => Buffer.from(s).toString('base64');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(25); }
  return fn();
};

test.before(async () => {
  port = await freePort();
  process.env.DEV_LOCAL_PORT = String(port);
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
  Wallet.submitStake = async () => 'sig-' + ++broadcasts;
  Usdc.verifyUsdcStake = async () => ({ payer: PAYER, usdc: landed });
  for (let i = 0; i < 60; i++) {
    try { const r = await call(port, 'GET', '/api/live'); if (r.status === 200) return; } catch (_) {}
    await sleep(250);
  }
  throw new Error('server did not come up');
});

function connect() {
  const { io } = require('socket.io-client');
  const s = io(`http://127.0.0.1:${port}`, { transports: ['websocket'], forceNew: true, reconnection: false, timeout: 5000 });
  const got = [];
  s.onAny((ev, p) => got.push([ev, p]));
  return new Promise((res, rej) => {
    const bail = setTimeout(() => rej(new Error('socket never connected')), 8000);
    s.on('connect', () => { clearTimeout(bail); res({ s, got, has: (ev) => got.find((g) => g[0] === ev) }); });
    s.on('connect_error', (e) => { clearTimeout(bail); rej(e); });
  });
}

// A real tier token (the old door a hand-made agar client used), with its durable stake row.
async function tierToken(lobbyType, amount) {
  landed = amount;
  const r = await call(port, 'POST', '/api/submit-stake', { lobbyType, signedTx: tx('t' + Math.random()), walletAddress: PAYER });
  assert.strictEqual(r.status, 200, r.text);
  const sig = 'sig-' + broadcasts;
  assert.strictEqual(ledgerDb.stakes.get(sig).state, 'pending');
  return { token: r.json.entryToken, sig };
}

// Humans in every agar room (free, dime and dollar): /api/live counts all three, plus the free row's bots.
async function agarHumans() {
  const r = await call(port, 'GET', '/api/live');
  const row = (r.json.extras || []).find((e) => e.id === 'agar:free');
  return r.json.counts.agar - ((row && row.bots) || 0);
}

const owedFor = (sig) => ledgerDb.payouts.filter((p) => p.stake_sig === sig);

test('a paid agar join is refused before its token is touched, and the token still opens the snake room of that price', async () => {
  const before = await agarHumans();
  for (const [type, amount] of [['dime', 0.1], ['dollar', 1]]) {
    const { token, sig } = await tierToken(type, amount);
    const a = await connect();
    a.s.emit('cell:join', { name: 'paid', lobbyType: type, entryToken: token, region: 'na', googleId: PAYER });
    const err = await until(() => a.has('cell:join:error'));
    assert.ok(err, type + ': ' + JSON.stringify(a.got.map((g) => g[0])));
    assert.match(err[1].message, /Paid agar\.io is closed/);
    assert.strictEqual(err[1].closed, true);
    await sleep(150);
    assert.ok(!a.has('cell:joined'), type + ' seated nobody');
    assert.strictEqual(ledgerDb.stakes.get(sig).state, 'pending', type + ': the stake row was never claimed');
    assert.deepStrictEqual(owedFor(sig), [], type + ': nothing owed or paid');
    assert.strictEqual(await agarHumans(), before, type + ': no human in any agar room');

    // Never spent: the same token opens the snake room of that price.
    a.s.emit('play', { name: 'snk', lobbyType: type, entryToken: token, region: 'na' });
    assert.ok(await until(() => a.has('game_joined'), 6000), type + ' snake: ' + JSON.stringify(a.got.map((g) => g[0])));
    assert.strictEqual(await until(() => ledgerDb.stakes.get(sig).state === 'consumed' && 'consumed'), 'consumed');
    a.s.close();
  }

  // No token at all: refused with the same message, not "Entry fee not verified".
  const b = await connect();
  b.s.emit('cell:join', { name: 'nofee', lobbyType: 'dollar', region: 'na' });
  const err = await until(() => b.has('cell:join:error'));
  assert.match(err[1].message, /Paid agar\.io is closed/);
  b.s.close();
});

test('a paid agar respawn is refused before its token is touched', async () => {
  const { token, sig } = await tierToken('dime', 0.1);
  const c = await connect();
  // The one way left to point a socket at a paid agar room.
  c.s.emit('spectate:join:agar', { lobbyType: 'dime', region: 'na' });
  assert.ok(await until(() => c.has('cell:joined')), JSON.stringify(c.got.map((g) => g[0])));
  c.s.emit('cell:respawn', { entryToken: token });
  const err = await until(() => c.has('cell:join:error'));
  assert.ok(err, JSON.stringify(c.got.map((g) => g[0])));
  assert.match(err[1].message, /Paid agar\.io is closed/);
  await sleep(150);
  assert.strictEqual(ledgerDb.stakes.get(sig).state, 'pending');
  assert.deepStrictEqual(owedFor(sig), []);
  c.s.close();
});

test('/api/submit-stake refuses an agar room name before anything is broadcast or claimed', async () => {
  const sent = broadcasts;
  const rows = ledgerDb.stakes.size;
  for (const lobbyType of ['agar_dime', 'agar_na_dollar', 'agar']) {
    const r = await call(port, 'POST', '/api/submit-stake', { lobbyType, signedTx: tx('agar-' + lobbyType), walletAddress: PAYER });
    assert.strictEqual(r.status, 400, lobbyType + ': ' + r.text);
    assert.match(r.json.error, /Not a paid lobby/);
  }
  assert.strictEqual(broadcasts, sent, 'nothing was broadcast');
  assert.strictEqual(ledgerDb.stakes.size, rows, 'no stake row was written');

  // Neither door takes a game: a token is bought for a price, never "for agar", which is why the
  // gate is cell:join and cell:respawn. If a game field ever appears here, this must be revisited.
  const src = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  const head = src.match(/app\.post\('\/api\/submit-stake'[^\n]*\n\s*const \{([^}]*)\} = req\.body/);
  assert.ok(head, 'submit-stake destructures its body');
  assert.deepStrictEqual(head[1].split(',').map((s) => s.trim()).sort(), ['lobbyType', 'signedTx', 'stake', 'walletAddress']);
});

test('free agar still joins and respawns', async () => {
  const before = await agarHumans();
  const f = await connect();
  f.s.emit('cell:join', { name: 'free', lobbyType: 'free', region: 'na' });
  const joined = await until(() => f.has('cell:joined'));
  assert.ok(joined, JSON.stringify(f.got.map((g) => g[0])));
  assert.ok(!f.has('cell:join:error'));
  let humans = before;
  for (let i = 0; i < 40 && humans !== before + 1; i++) { await sleep(50); humans = await agarHumans(); }
  assert.strictEqual(humans, before + 1, 'seated in the free room');
  f.s.emit('cell:respawn', {});
  await sleep(200);
  assert.ok(!f.has('cell:join:error'), 'a free respawn is not refused');
  f.s.close();

  // A missing type lands in the free room for nothing, as it always has.
  const g = await connect();
  g.s.emit('cell:join', { name: 'notype', region: 'na' });
  assert.ok(await until(() => g.has('cell:joined')), JSON.stringify(g.got.map((x) => x[0])));
  assert.ok(!g.has('cell:join:error'));
  g.s.close();
});
