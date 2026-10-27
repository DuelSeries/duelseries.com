'use strict';
/* The owner console's state v2 and its new actions on the REAL server (server/index.js as a child process, an
   owner key registered with ALLOW_TEST_OWNER, no database, no chain), so the wiring is proven and not only the
   modules (test/ownerConsole.test.js):
   - /api/owner/state answers state v2 (games and rungs, drain, battle royale, maintenance, auth), no-store;
   - maintenance and the paid Knockout door outlive a restart, and a paid Knockout join is refused at the shut door
     before its entry token is spent (the drain still counts the token);
   - bots:set holds the free agar.io room and the free Paper arena at the number asked, and auto hands them back;
   - Start alone with nobody in the arena is refused, not reported as started;
   - an announcement reaches a socket on the main namespace (where the lobby listens), cleaned, at most one per 10 s.
   Boot pattern from test/securityGamesServer.test.js. */
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const { ed25519 } = require('@noble/curves/ed25519');
const _bs58 = require('bs58');
const bs58 = (_bs58 && _bs58.default) ? _bs58.default : _bs58;
const { actionMessage } = require('../server/ownerAuth');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

const get = (url) => new Promise((res, rej) => {
  const r = http.get(url, (x) => { let d = ''; x.on('data', (c) => d += c); x.on('end', () => res({ status: x.statusCode, body: d })); });
  r.on('error', rej);
  r.setTimeout(4000, () => r.destroy(new Error('timeout')));
});

const post = (url, obj) => new Promise((res, rej) => {
  const body = JSON.stringify(obj);
  const r = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (x) => {
    let d = ''; x.on('data', (c) => d += c);
    x.on('end', () => { let json = null; try { json = JSON.parse(d); } catch (_) {} res({ status: x.statusCode, body: d, json, headers: x.headers }); });
  });
  r.on('error', rej);
  r.setTimeout(6000, () => r.destroy(new Error('timeout')));
  r.end(body);
});

async function until(fn, ms, step) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() >= end) return v;
    await sleep(step || 100);
  }
}

const ownerKey = ed25519.utils.randomPrivateKey();
const ownerAddr = bs58.encode(ed25519.getPublicKey(ownerKey));
const ownerProof = (action, args) => {
  const ts = Date.now();
  const msg = new TextEncoder().encode(actionMessage(action, args, ownerAddr, ts));
  return { action, args, wallet: ownerAddr, ts, sig: bs58.encode(ed25519.sign(msg, ownerKey)) };
};

async function boot(dir) {
  const port = await freePort();
  const env = { ...process.env, REGION: 'na', PORT: String(port), SESSION_SECRET: 'test', MONEY_MODE: 'usdc',
    DATABASE_URL: '', NTFY_DISABLED: '1', POSTHOG_DISABLED: '1', PAPER_PAID: '1', PAPER_DEV_TOKENS: '1',
    ESCROW_PRIVATE_KEY: '', ESCROW_PUBLIC_KEY: '', RPC_URL: 'https://rpc.invalid/never-called', SOLANA_NETWORK: 'devnet',
    NODE_ENV: 'test', SL_PAID: '0', AG_ENABLED: '1', AG_PAID: '1', AG_JOURNAL_PATH: path.join(dir, 'ag-money-journal.log'),
    ALLOW_TEST_OWNER: '1', TEST_OWNER_WALLET: ownerAddr };
  for (const k of ['SL_ENABLED', 'MAINTENANCE_PATH', 'KO_PAID_SWITCH_PATH', 'BS_PAID_SWITCH_PATH']) delete env[k];
  const srv = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { stdout: '', stderr: '' };
  srv.stdout.on('data', (d) => { out.stdout += d.toString(); });
  srv.stderr.on('data', (d) => { out.stderr += d.toString(); });
  for (let i = 0; i < 150; i++) {
    if (srv.exitCode !== null) break;
    try { const r = await get(`http://localhost:${port}/api/live`); if (r.status === 200) return { srv, port, out }; } catch (_) {}
    await sleep(400);
  }
  try { srv.kill('SIGKILL'); } catch (_) {}
  throw new Error('server did not come up\n' + out.stderr.slice(-1500));
}
async function stop(b) {
  b.srv.kill('SIGKILL');
  await until(() => b.srv.exitCode !== null || b.srv.signalCode !== null, 5000);
}

function requireClient(t) {
  try { return require('socket.io-client'); } catch (_) { t.skip('socket.io-client not installed'); return null; }
}
function connect(io, port) {
  const sock = io(`http://localhost:${port}`, { transports: ['websocket'], forceNew: true, reconnection: false, timeout: 5000 });
  return new Promise((res, rej) => {
    const bail = setTimeout(() => rej(new Error('socket never connected')), 10000);
    sock.on('connect', () => { clearTimeout(bail); res(sock); });
    sock.on('connect_error', (e) => { clearTimeout(bail); rej(e); });
  });
}
function first(sock, events, ms) {
  return new Promise((res, rej) => {
    const offs = [];
    const done = () => { clearTimeout(t); for (const off of offs) off(); };
    const t = setTimeout(() => { done(); rej(new Error('none of ' + events.join(', ') + ' within ' + ms + ' ms')); }, ms);
    for (const ev of events) {
      const fn = (m) => { done(); res({ ev, m }); };
      sock.on(ev, fn);
      offs.push(() => sock.off(ev, fn));
    }
  });
}

const state = async (port) => (await post(`http://localhost:${port}/api/owner/state`, ownerProof('state', {})));
const act = async (port, action, args) => (await post(`http://localhost:${port}/api/owner/do`, ownerProof(action, args || {})));
const gameOf = (s, id) => s.games.find((g) => g.id === id);

test('state v2, maintenance and the paid Knockout door across a restart, bots:set, Start alone, announce', { timeout: 240000 }, async (t) => {
  const io = requireClient(t);
  if (!io) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownercon-'));
  const socks = [];
  const procs = [];
  t.after(() => {
    for (const s of socks) { try { s.close(); } catch (_) {} }
    for (const p of procs) { try { p.kill('SIGKILL'); } catch (_) {} }
  });

  const one = await boot(dir);
  procs.push(one.srv);
  let r = await state(one.port);
  assert.strictEqual(r.status, 200, r.body);
  assert.strictEqual(r.headers['cache-control'], 'no-store');
  let s = r.json;
  assert.strictEqual(s.v, 2);
  for (const k of ['region', 'uptimeSec', 'now', 'auth', 'open', 'maintenance', 'drain', 'escrow', 'bots', 'games',
    'battleRoyale', 'earnings', 'smooth', 'audit', 'rooms']) assert.ok(k in s, k);
  assert.deepStrictEqual(s.auth, { via: 'signature', device: null, exp: null });
  assert.deepStrictEqual(s.games.map((g) => g.id), ['slither', 'paper', 'agar', 'chomp', 'knockout', 'battleship', 'swim', 'headsoccer']);
  for (const g of s.games) {
    assert.deepStrictEqual(g.rungs.map((x) => x.rung), [0, 0.5, 1], g.id);
    for (const row of g.rungs) {
      for (const k of ['room', 'people', 'bots', 'money', 'botTarget', 'botsAllowed', 'botsNote']) assert.ok(k in row, g.id + ' ' + k);
      // paid duels stay people only; a paid arena rung takes the owner's bots when its paid directory is on
      if (row.rung > 0 && g.duel) assert.deepStrictEqual([row.botsAllowed, row.botsNote], [false, 'Paid duels stay people only: a bot would win or lose a real stake']);
      if (row.rung > 0 && !g.duel && row.botsAllowed) assert.match(String(row.room), /^paidbots:(sl|ag|paper):/);
    }
  }
  assert.ok(!s.games.some((g) => g.rungs.some((x) => /^na_(free|br)$/.test(String(x.room)))), 'the old tiers are not rows');
  assert.deepStrictEqual(gameOf(s, 'knockout').paid, { enabled: true, open: true, stopping: false, saved: false, action: 'ko:paid' });
  assert.strictEqual(gameOf(s, 'agar').paid.action, 'agar:paid');
  assert.strictEqual(gameOf(s, 'agar').rungs[0].room, 'ag_na_s0');
  assert.strictEqual(gameOf(s, 'paper').rungs[0].room, 'paper_na_s0');
  for (const k of ['safe', 'reason', 'people', 'paidPeople', 'moneyInPlay', 'floor', 'pending', 'duels']) assert.ok(k in s.drain, k);
  for (const k of ['state', 'phase', 'humans', 'bots', 'alive', 'minPlayers', 'canStart', 'canForce', 'countdownMs',
    'nextStartAt', 'prize', 'prizeHeld', 'engine', 'room', 'botTarget', 'winner']) assert.ok(k in s.battleRoyale, 'br ' + k);
  assert.deepStrictEqual([s.battleRoyale.humans, s.battleRoyale.canForce], [0, false]);
  assert.deepStrictEqual(Object.keys(s.maintenance).sort(), ['maintenance', 'message', 'on', 'saved', 'since', 'update']);
  assert.strictEqual(s.open, true);
  assert.deepStrictEqual(s.smooth, { on: true });

  // Start alone with nobody in the arena: refused, not "Started"
  r = await act(one.port, 'br:start', { force: true });
  assert.deepStrictEqual([r.status, r.json.error], [409, 'Nobody is in the room to start with']);

  // bots:set on the free agar.io room and the free Paper arena, then auto
  r = await act(one.port, 'bots:set', { room: 'ag_na_s0', count: 5 });
  assert.strictEqual(r.status, 200, r.body);
  assert.match(r.json.note, /5 bots now, held at 5 until you change it/);
  let row = gameOf(r.json.state, 'agar').rungs[0];
  assert.deepStrictEqual([row.bots, row.botTarget], [5, 5]);
  await sleep(500);
  row = gameOf((await state(one.port)).json, 'agar').rungs[0];
  assert.deepStrictEqual([row.bots, row.botTarget], [5, 5], 'held while the room runs');
  r = await act(one.port, 'bots:set', { room: 'ag_na_s0', auto: true });
  assert.strictEqual(r.status, 200, r.body);
  row = gameOf(r.json.state, 'agar').rungs[0];
  assert.strictEqual(row.botTarget, null);
  assert.ok(row.bots > 5, 'its own fill again: ' + row.bots);
  r = await act(one.port, 'bots:set', { room: 'paper_na_s0', count: 3 });
  assert.strictEqual(r.status, 200, r.body);
  row = gameOf(r.json.state, 'paper').rungs[0];
  assert.deepStrictEqual([row.bots, row.botTarget], [3, 3]);
  r = await act(one.port, 'bots:set', { room: 'paper_na_s0', count: 250 });
  assert.deepStrictEqual([r.status, r.json.error], [409, 'Bots: a whole number from 0 to 200']);
  r = await act(one.port, 'bots:set', { room: 'paper_na_s0', auto: true });
  assert.strictEqual(gameOf(r.json.state, 'paper').rungs[0].botTarget, null);

  // announce: reaches a main-namespace socket, cleaned; a second within 10 s is refused
  const sock = await connect(io, one.port);
  socks.push(sock);
  const heard = first(sock, ['announce'], 8000);
  r = await act(one.port, 'announce', { text: '  Back <b>soon</b>\n ' });
  assert.strictEqual(r.status, 200, r.body);
  const got = await heard;
  assert.strictEqual(got.m.text, 'Back bsoon/b');
  // No rate limit: a different line right away goes out; the same line again within a second does not.
  r = await act(one.port, 'announce', { text: 'again' });
  assert.strictEqual(r.status, 200, r.body);
  r = await act(one.port, 'announce', { text: 'again' });
  assert.strictEqual(r.status, 409);
  assert.match(r.json.error, /just sent/);

  // maintenance on and the paid Knockout door shut, both saved
  r = await act(one.port, 'maintenance:on', { message: 'Deploying' });
  assert.match(r.json.note, /stays on across restarts/);
  assert.deepStrictEqual([r.json.state.open, r.json.state.maintenance.on, r.json.state.maintenance.saved], [false, true, true]);
  assert.ok(fs.existsSync(path.join(dir, 'maintenance.json')));
  r = await act(one.port, 'ko:paid:off', {});
  assert.strictEqual(r.status, 200, r.body);
  assert.match(r.json.note, /stays closed across restarts/);
  assert.deepStrictEqual(gameOf(r.json.state, 'knockout').paid, { enabled: true, open: false, stopping: false, saved: true, action: 'ko:paid' });

  // the audit names who acted and what was asked
  s = (await state(one.port)).json;
  const set = s.audit.find((a) => a.action === 'bots:set' && a.args && a.args.count === 5);
  assert.ok(set && set.who === 'signature' && set.ok === true, JSON.stringify(s.audit.slice(0, 3)));
  await stop(one);

  // the restart (a deploy): the same data folder
  const two = await boot(dir);
  procs.push(two.srv);
  s = (await state(two.port)).json;
  assert.deepStrictEqual([s.open, s.maintenance.on, s.maintenance.message], [false, true, 'Deploying']);
  assert.strictEqual(gameOf(s, 'knockout').paid.open, false);
  assert.match(two.out.stderr + two.out.stdout, /\[KO\] paid door CLOSED at boot/);
  r = await act(two.port, 'maintenance:off', {});
  assert.deepStrictEqual([r.status, r.json.state.open, r.json.state.maintenance.saved], [200, true, false]);
  assert.ok(!fs.existsSync(path.join(dir, 'maintenance.json')));

  // a paid Knockout join at the shut door: refused before its token is touched (it is still unspent)
  const mint = await post(`http://localhost:${two.port}/api/submit-stake`, { stake: 0.5, walletAddress: 'KoClosedWa11et1111111111111111111111111111' });
  assert.strictEqual(mint.status, 200, mint.body);
  assert.strictEqual((await state(two.port)).json.drain.pendingEntries, 1);
  const k = await connect(io, two.port);
  socks.push(k);
  k.emit('ko:queue', { name: 'shut', stake: 0.5, entryToken: mint.json.entryToken });
  const told = await first(k, ['ko:refused', 'ko:queued'], 8000);
  assert.strictEqual(told.ev, 'ko:refused');
  assert.match(told.m.why, /Paid tables are closed right now/);
  s = (await state(two.port)).json;
  assert.deepStrictEqual([s.drain.pendingEntries, s.drain.safe], [1, false], 'the token was not spent, and the drain still counts it');
  r = await act(two.port, 'ko:paid:on', {});
  assert.deepStrictEqual([r.status, gameOf(r.json.state, 'knockout').paid.open, gameOf(r.json.state, 'knockout').paid.saved], [200, true, false]);
  assert.ok(!/TypeError|ReferenceError|is not a function/.test(one.out.stderr + two.out.stderr), 'no wiring error\n' + two.out.stderr.slice(-800));
});
