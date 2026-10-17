'use strict';
// The owner console's live alerts (security review leftover, 2026-10-15). Since item e the server registers the owner's
// alert socket only after an owner signature over 'owner:alerts' (server/socketIdentity.js), and no page sent one, so
// solvency, collusion, Paper and agar alerts reached nobody's screen. public/js/ownerAlerts.js connects a socket from
// owner.html, signs 'owner:alerts' with the page's existing silent signer on every (re)connect, and hands each alert
// to the page as plain text.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { connectOwnerAlerts, describe } = require('../public/js/ownerAlerts');

function fakeIo() {
  const sockets = [];
  const io = (opts) => {
    const s = {
      opts, handlers: {}, sent: [], connected: false,
      on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); return this; },
      emit(ev, p) { this.sent.push([ev, p]); },
      fire(ev, p) { return Promise.all((this.handlers[ev] || []).map((fn) => fn(p))); }
    };
    sockets.push(s);
    return s;
  };
  return { io, sockets };
}

test('every (re)connect signs owner:alerts and sends it with lobby:join', async () => {
  const { io, sockets } = fakeIo();
  const signs = [];
  const sign = async (action, args) => { signs.push([action, args]); return { action, args, wallet: 'OWNER', ts: signs.length, sig: 'S' }; };
  const states = [];
  connectOwnerAlerts({ io, sign, onAlert() {}, onState: (s) => states.push(s) });
  assert.equal(sockets.length, 1, 'one socket');
  const s = sockets[0];
  s.connected = true;
  await s.fire('connect');
  assert.deepEqual(signs, [['owner:alerts', {}]]);
  assert.deepEqual(s.sent, [['lobby:join', { ownerProof: { action: 'owner:alerts', args: {}, wallet: 'OWNER', ts: 1, sig: 'S' } }]]);
  // a reconnect is a new socket on the server: a fresh one-time proof
  s.connected = false;
  await s.fire('disconnect');
  s.connected = true;
  await s.fire('connect');
  assert.equal(s.sent.length, 2);
  assert.equal(s.sent[1][1].ownerProof.ts, 2);
  assert.deepEqual(states, ['listening', 'offline', 'listening']);
});

// Ticket mode (the owner session, server/ownerSession.js): no wallet, a one-time ticket from the server per connect.
test('ticket mode: every (re)connect asks for a fresh ticket and sends it as ownerTicket; no signature is made', async () => {
  const { io, sockets } = fakeIo();
  let asked = 0;
  const signs = [];
  const states = [];
  connectOwnerAlerts({ io, ticket: async () => 'T' + (++asked), sign: async (a) => { signs.push(a); return {}; },
    onAlert() {}, onState: (s) => states.push(s) });
  const s = sockets[0];
  s.connected = true;
  await s.fire('connect');
  assert.deepEqual(s.sent, [['lobby:join', { ownerTicket: 'T1' }]]);
  s.connected = false;
  await s.fire('disconnect');
  s.connected = true;
  await s.fire('connect');
  assert.deepEqual(s.sent[1], ['lobby:join', { ownerTicket: 'T2' }], 'a ticket is one-time: a new one per connect');
  assert.deepEqual(signs, [], 'the wallet is never asked while the session answers');
  assert.deepEqual(states, ['listening', 'offline', 'listening']);
});

test('ticket mode falls back to the signature when there is no session, and says unsigned when neither works', async () => {
  const { io, sockets } = fakeIo();
  connectOwnerAlerts({ io, ticket: async () => null, sign: async (action, args) => ({ action, args, sig: 'S' }),
    onAlert() {}, onState() {} });
  sockets[0].connected = true;
  await sockets[0].fire('connect');
  assert.deepEqual(sockets[0].sent, [['lobby:join', { ownerProof: { action: 'owner:alerts', args: {}, sig: 'S' } }]]);
  const states = [];
  connectOwnerAlerts({ io, ticket: async () => { throw new Error('offline'); }, onAlert() {}, onState: (st) => states.push(st) });
  sockets[1].connected = true;
  await sockets[1].fire('connect');
  assert.deepEqual(sockets[1].sent, []);
  assert.deepEqual(states, ['unsigned']);
});

test('fetchTicket: one same-origin POST with the owner header; null when signed out or broken', async () => {
  const { fetchTicket } = require('../public/js/ownerAlerts');
  const calls = [];
  const ok = async (url, opts) => { calls.push([url, opts]); return { ok: true, json: async () => ({ ticket: 'abc' }) }; };
  assert.equal(await fetchTicket(ok), 'abc');
  assert.equal(calls[0][0], '/api/owner/ticket');
  assert.equal(calls[0][1].method, 'POST');
  assert.equal(calls[0][1].credentials, 'same-origin');
  assert.equal(calls[0][1].headers['X-DS-Owner'], '1');
  assert.match(calls[0][1].headers['Content-Type'], /application\/json/);
  assert.equal(await fetchTicket(async () => ({ ok: false, status: 401, json: async () => ({}) })), null);
  assert.equal(await fetchTicket(async () => ({ ok: true, json: async () => ({ ticket: 7 }) })), null);
  assert.equal(await fetchTicket(async () => { throw new Error('down'); }), null);
});

test('no signature: nothing is sent and the page is told', async () => {
  const { io, sockets } = fakeIo();
  const states = [];
  connectOwnerAlerts({ io, sign: async () => null, onAlert() {}, onState: (s) => states.push(s) });
  sockets[0].connected = true;
  await sockets[0].fire('connect');
  assert.deepEqual(sockets[0].sent, []);
  assert.deepEqual(states, ['unsigned']);
});

test('solvency, collusion, Paper and agar alerts reach the page as text', async () => {
  const { io, sockets } = fakeIo();
  const got = [];
  connectOwnerAlerts({ io, sign: async () => ({}), onAlert: (a) => got.push(a), onState() {} });
  const s = sockets[0];
  await s.fire('admin:solvency_alert', { escrowSol: 10, liveStakesSol: 12.5, surplusSol: -2.5, solvent: false, ts: 1 });
  await s.fire('admin:solvency_alert', { escrowFeeSol: 0.0042, feeSolLow: true });
  await s.fire('admin:collusion_flag', { src: 'WALLETAAAA1111', dst: 'WALLETBBBB2222', netSol: 3.25, count: 7,
    oneWayRatio: 0.95, concentration: 0.8, lobbyType: 'paper_na_s1' });
  await s.fire('admin:paper_alert', { kind: 'breach', lobbyType: 'paper_na_s0_5' });
  await s.fire('admin:agar_alert', { kind: 'emergency', lobbyType: 'ag_na_s1', repeats: 2 });
  assert.deepEqual(got.map((a) => a.kind), ['solvency', 'solvency', 'collusion', 'paper', 'agar']);
  assert.match(got[0].text, /12\.50/);
  assert.match(got[0].text, /short 2\.50/);
  assert.match(got[1].text, /0\.0042 SOL/);
  assert.match(got[2].text, /WALL…1111 -> WALL…2222/);
  assert.match(got[2].text, /3\.25/);
  assert.match(got[2].text, /paper_na_s1/);
  assert.match(got[3].text, /breach in paper_na_s0_5/);
  assert.match(got[4].text, /emergency in ag_na_s1/);
  assert.match(got[4].text, /2 more held back/);
  for (const a of got) assert.ok(typeof a.at === 'number' && a.at > 0);
});

test('a payload of the wrong shape never throws and still says something', () => {
  for (const p of [null, undefined, 'x', 7, [], {}]) {
    const a = describe('solvency', p);
    assert.equal(typeof a.text, 'string');
    assert.ok(a.text.length > 0);
  }
});

test('owner.html loads the socket client and the module, and connects only once the owner is confirmed', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'owner.html'), 'utf8');
  assert.match(html, /<script src="\/socket\.io\/socket\.io\.js"><\/script>/);
  assert.match(html, /<script src="\/js\/ownerAlerts\.js"><\/script>/);
  assert.match(html, /id="alerts"/);
  // inside render's caller, after the server accepted the signed state
  const refresh = html.slice(html.indexOf('async function refresh()'), html.indexOf('function render('));
  assert.match(refresh, /render\(r\.body\);\s*startAlerts\(\);/);
  assert.match(html, /OwnerAlerts\.connectOwnerAlerts\(\{\s*io,\s*sign: signed,/);
  // what it shows is escaped
  assert.match(html, /esc\(a\.text\)/);
});

// The real server (server/index.js as a child process, the boot of test/securityGamesServer.test.js): the page's module
// over a real socket.io client, signing with the owner key, is registered (no refusal); a non-owner key is refused.
test('on the real server the owner\'s signed lobby:join is accepted and a stranger\'s is refused', { timeout: 120000 }, async (t) => {
  let ioClient;
  try { ioClient = require('socket.io-client'); } catch (_) { return t.skip('socket.io-client not installed'); }
  const { spawn } = require('child_process');
  const http = require('http');
  const net = require('net');
  const os = require('os');
  const { ed25519 } = require('@noble/curves/ed25519');
  const _bs58 = require('bs58');
  const bs58 = (_bs58 && _bs58.default) ? _bs58.default : _bs58;
  const { actionMessage } = require('../server/ownerAuth');
  const ROOT = path.join(__dirname, '..');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const keyPair = () => { const k = ed25519.utils.randomPrivateKey(); return { k, addr: bs58.encode(ed25519.getPublicKey(k)) }; };
  const signer = ({ k, addr }) => async (action, args) => {
    const ts = Date.now();
    const sig = bs58.encode(ed25519.sign(new TextEncoder().encode(actionMessage(action, args, addr, ts)), k));
    return { action, args, wallet: addr, ts, sig };
  };
  const owner = keyPair();
  const port = await new Promise((res, rej) => {
    const s = net.createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
  const get = (p) => new Promise((res, rej) => {
    const r = http.get(`http://localhost:${port}${p}`, (x) => { let d = ''; x.on('data', (c) => d += c); x.on('end', () => res({ status: x.statusCode, body: d })); });
    r.on('error', rej);
    r.setTimeout(4000, () => r.destroy(new Error('timeout')));
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owneralerts-'));
  const env = { ...process.env, REGION: 'na', PORT: String(port), SESSION_SECRET: 'test', MONEY_MODE: 'usdc',
    DATABASE_URL: '', NTFY_DISABLED: '1', POSTHOG_DISABLED: '1', ESCROW_PRIVATE_KEY: '', ESCROW_PUBLIC_KEY: '',
    RPC_URL: 'https://rpc.invalid/never-called', SOLANA_NETWORK: 'devnet', NODE_ENV: 'test', SL_PAID: '0', AG_PAID: '0',
    AG_JOURNAL_PATH: path.join(dir, 'ag-money-journal.log'), ALLOW_TEST_OWNER: '1', TEST_OWNER_WALLET: owner.addr };
  const srv = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { text: '' };
  srv.stdout.on('data', (d) => { out.text += d.toString(); });
  srv.stderr.on('data', (d) => { out.text += d.toString(); });
  const socks = [];
  t.after(() => {
    for (const s of socks) { try { s.close(); } catch (_) {} }
    try { srv.kill('SIGKILL'); } catch (_) {}
  });
  let up = false;
  for (let i = 0; i < 150 && !up && srv.exitCode === null; i++) {
    try { up = (await get('/api/live')).status === 200; } catch (_) { /* booting */ }
    if (!up) await sleep(400);
  }
  assert.ok(up, 'server came up\n' + out.text.slice(-1500));
  const js = await get('/js/ownerAlerts.js');
  assert.equal(js.status, 200, 'the page can load the module');
  assert.match(js.body, /connectOwnerAlerts/);
  const io = () => {
    const s = ioClient(`http://localhost:${port}`, { forceNew: true, reconnection: false, timeout: 5000 });
    socks.push(s);
    return s;
  };
  const listen = (sign) => new Promise((res) => {
    connectOwnerAlerts({ io, sign, onAlert() {}, onState: (st) => { if (st === 'listening') res(st); } });
  });
  const refused = () => (out.text.match(/owner alerts refused/g) || []).length;
  await listen(signer(owner));
  await sleep(800);
  assert.equal(refused(), 0, 'the owner\'s proof was accepted');
  await listen(signer(keyPair()));
  for (let i = 0; i < 20 && refused() === 0; i++) await sleep(200);
  assert.equal(refused(), 1, 'a stranger\'s proof was refused');
});
