'use strict';
// Night review 2026-10-29, on a real server: POST /api/my-name refuses staff and brand names (as "taken", 409) for
// everyone but the owner and refuses a name that was only invisible characters; /api/track/visit and /api/my-profile
// are rate limited per address. No database (DATABASE_URL ''), so a name that passes every check fails at the write
// with a 500: what matters here is which check answered.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const net = require('net');
const { ed25519 } = require('@noble/curves/ed25519');
const _bs58 = require('bs58');
const bs58 = (_bs58 && _bs58.default) ? _bs58.default : _bs58;
const { nameMessage } = require('../server/nameProof');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function request(method, url, obj, headers) {
  return new Promise((res, rej) => {
    const body = obj === undefined ? '' : JSON.stringify(obj);
    const h = Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, headers || {});
    const r = http.request(url, { method, headers: h }, (x) => {
      let d = '';
      x.on('data', (c) => { d += c; });
      x.on('end', () => { let json = null; try { json = JSON.parse(d); } catch (_) {} res({ status: x.statusCode, headers: x.headers, json }); });
    });
    r.on('error', rej);
    r.end(body);
  });
}

const key = () => { const k = ed25519.utils.randomPrivateKey(); return { k, wallet: bs58.encode(ed25519.getPublicKey(k)) }; };
function signedName(who, name) {
  const ts = Date.now();
  const sig = bs58.encode(ed25519.sign(new TextEncoder().encode(nameMessage(who.wallet, name, ts)), who.k));
  return { wallet: who.wallet, ts, sig, name };
}

test('names, the visit push and the profile read on a real server', { timeout: 120000 }, async (t) => {
  const owner = key();
  const port = await freePort();
  const env = { ...process.env, REGION: 'na', PORT: String(port), SESSION_SECRET: 'test', MONEY_MODE: 'usdc',
    DATABASE_URL: '', NTFY_DISABLED: '1', POSTHOG_DISABLED: '1', ESCROW_PRIVATE_KEY: '', ESCROW_PUBLIC_KEY: '',
    RPC_URL: 'https://rpc.invalid/never-called', SOLANA_NETWORK: 'devnet', NODE_ENV: 'test', SL_PAID: '0',
    PGCONNECT_TIMEOUT: '2', ALLOW_TEST_OWNER: '1', TEST_OWNER_WALLET: owner.wallet };
  const srv = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  srv.stdout.on('data', () => {});
  srv.stderr.on('data', (d) => { err += d.toString(); });
  t.after(() => { try { srv.kill('SIGKILL'); } catch (_) {} });
  const base = `http://localhost:${port}`;
  let up = false;
  for (let i = 0; i < 150 && !up; i++) {
    if (srv.exitCode !== null) break;
    try { up = (await request('GET', base + '/api/live')).status === 200; } catch (_) { await sleep(400); }
  }
  assert.ok(up, 'server came up\n' + err.slice(-1500));

  const someone = key();
  const name = async (who, n) => request('POST', base + '/api/my-name', signedName(who, n));
  for (const n of ['DuelSeries Support', 'Adm1n', 'TheOwner', 'Duel' + String.fromCharCode(0x200b) + 'Series']) {
    const r = await name(someone, n);
    assert.deepStrictEqual([r.status, r.json && r.json.error], [409, 'Name not allowed'], n);
  }
  const blank = await name(someone, String.fromCharCode(0x200b).repeat(4));
  assert.deepStrictEqual([blank.status, blank.json && blank.json.error], [400, 'Name too short'], 'all invisible is too short');
  const plain = await name(someone, 'Bobby');
  assert.ok(![400, 409].includes(plain.status), 'an ordinary name reaches the write: ' + plain.status);
  const own = await name(owner, 'DuelSeries');
  assert.ok(![400, 409].includes(own.status), 'the owner may: ' + own.status);

  // finding 28: the profile read has the social limiter (its headers say so)
  const prof = await request('GET', base + '/api/my-profile?wallet=' + someone.wallet);
  assert.strictEqual(prof.headers['ratelimit-limit'], '40');

  // finding 24: five visits a minute per address, then 429 (the page ignores the answer)
  const ua = { 'User-Agent': 'Mozilla/5.0' };
  for (let i = 0; i < 5; i++) {
    assert.strictEqual((await request('POST', base + '/api/track/visit', { page: '/' }, ua)).status, 200, 'visit ' + i);
  }
  assert.strictEqual((await request('POST', base + '/api/track/visit', { page: '/' }, ua)).status, 429);
  assert.strictEqual(srv.exitCode, null, 'still running\n' + err.slice(-800));
});
