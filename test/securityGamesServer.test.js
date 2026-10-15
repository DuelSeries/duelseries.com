'use strict';
/* The games-money security fixes of 2026-10-15 on the REAL server (server/index.js and scripts/dev-local.js as child
   processes), so the wiring in index.js is proven, not only the modules:
   - item a: a seated paid Paper balance survives a restart (SIGINT: one [AG] SHUTDOWN-OWED row, written again by the
     next boot's journal replay at most once) and a crash (the crash settle journals it, the next boot owes it once);
     before, both lost it;
   - item b: the owner's agar:paid:off and paper:paid:off outlive a restart (the paid rows stay closed and a new paid
     join is refunded 'not-open' until :on);
   - item e: PLAY with a claimed googleId writes nothing to that wallet's stats; a socket that proves its wallet does.
   Boot pattern from test/slPaidJoinSmoke.test.js (its test-only preload triggers the SIGINT and the crash in-process,
   which also works on Windows, where a real SIGINT from outside cannot be caught). */
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
const { identityMessage } = require('../server/nameProof');
const MP = require('../public/js/paper/mp/paperWire.js');
const C = require('../shared/constants');

const ROOT = path.join(__dirname, '..');
const PRELOAD = path.join(__dirname, 'slPaidSmoke.preload.js');
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
    let d = ''; x.on('data', (c) => d += c); x.on('end', () => res({ status: x.statusCode, body: d }));
  });
  r.on('error', rej);
  r.setTimeout(4000, () => r.destroy(new Error('timeout')));
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

// opts: { script ('server/index.js' | 'scripts/dev-local.js'), preload (the trigger preload), journal (reuse a path) }
async function boot(extra, opts) {
  const o = opts || {};
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secgames-'));
  const journal = o.journal || path.join(dir, 'ag-money-journal.log');
  const env = { ...process.env, REGION: 'na', PORT: String(port), SESSION_SECRET: 'test', MONEY_MODE: 'usdc',
    DATABASE_URL: '', NTFY_DISABLED: '1', POSTHOG_DISABLED: '1', PAPER_PAID: '1', PAPER_DEV_TOKENS: '1',
    ESCROW_PRIVATE_KEY: '', ESCROW_PUBLIC_KEY: '', RPC_URL: 'https://rpc.invalid/never-called', SOLANA_NETWORK: 'devnet',
    NODE_ENV: 'test', SL_PAID: '0', AG_JOURNAL_PATH: journal, ALLOW_TEST_OWNER: '1', TEST_OWNER_WALLET: ownerAddr,
    SLP_SMOKE_TRIGGER: dir, DEV_LOCAL_PORT: String(port), ...extra };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const args = (o.preload ? ['-r', PRELOAD] : []).concat(path.join(ROOT, o.script || 'server/index.js'));
  const srv = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { stdout: '', stderr: '' };
  srv.stdout.on('data', (d) => { out.stdout += d.toString(); });
  srv.stderr.on('data', (d) => { out.stderr += d.toString(); });
  for (let i = 0; i < 150; i++) {
    if (srv.exitCode !== null) break;
    try { const r = await get(`http://localhost:${port}/api/live`); if (r.status === 200) return { srv, port, out, journal, dir }; } catch (_) {}
    await sleep(400);
  }
  try { srv.kill('SIGKILL'); } catch (_) {}
  throw new Error('server did not come up\n' + out.stderr.slice(-1500));
}

function requireClient(t) {
  try { return require('socket.io-client'); } catch (_) { t.skip('socket.io-client not installed'); return null; }
}

// pp:joined carries its rings and trails as binary attachments: lift the node parser's cap, as the browser has none.
function browserLikeParser() {
  const parser = require('socket.io-parser');
  class Decoder extends parser.Decoder {
    constructor(opts) { super(Object.assign({ maxAttachments: 500000 }, typeof opts === 'object' ? opts : {})); }
  }
  return { ...parser, Decoder };
}

function connect(io, port, nsp, auth) {
  const sock = io(`http://localhost:${port}${nsp || ''}`, { transports: ['websocket'], forceNew: true, reconnection: false,
    timeout: 5000, parser: browserLikeParser(), auth: auth || {} });
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

async function mint(port, wallet, devGame) {
  const r = await post(`http://localhost:${port}/api/submit-stake`, { stake: 0.5, walletAddress: wallet, devGame });
  assert.strictEqual(r.status, 200, r.body);
  return JSON.parse(r.body).entryToken;
}

// A paid Paper seat on the $0.50 rung, steered once (that confirms it, as the page does after pp:joined).
async function paperSeat(io, port, wallet, name, socks) {
  const s = await connect(io, port);
  socks.push(s);
  s.emit('pp:join', { stake: 0.5, name, entryToken: await mint(port, wallet) });
  const j = await first(s, ['pp:joined', 'pp:refused'], 15000);
  assert.strictEqual(j.ev, 'pp:joined', JSON.stringify(j.m));
  s.emit('pp:in', MP.encodeInput(1, 0, false));
  await sleep(300);
  return s;
}

const replayOf = (out) => {
  const m = /\[AG\] JOURNAL replay (\{[^\n]*\})/.exec(out.stdout);
  return m ? JSON.parse(m[1]) : null;
};
const live = async (port) => JSON.parse((await get(`http://localhost:${port}/api/live`)).body);

test('paid Paper at a restart and at a crash: the seated balance is owed once at the next boot (item a)', { timeout: 240000 }, async (t) => {
  const io = requireClient(t);
  if (!io) return;
  const socks = [];
  const procs = [];
  t.after(() => {
    for (const s of socks) { try { s.close(); } catch (_) {} }
    for (const p of procs) { try { p.kill('SIGKILL'); } catch (_) {} }
  });
  // boot 1: a seated $0.50 Paper balance, then the restart's SIGINT
  const one = await boot({ AG_PAID: '0' }, { preload: true });
  procs.push(one.srv);
  const W1 = 'PpRestartWa11et111111111111111111111111111';
  const s1 = await paperSeat(io, one.port, W1, 'restart', socks);
  const told = first(s1, ['pp:refused'], 10000);
  fs.writeFileSync(path.join(one.dir, 'sigint'), '');
  const owedLine = new RegExp('\\[AG\\] SHUTDOWN-OWED ' + W1 + ' 500000 micro refund paper shutdown paper_na_s0_5 agowed:[0-9a-f-]{36}');
  assert.ok(await until(() => owedLine.test(one.out.stderr), 10000), 'the restart owes the seat\n' + one.out.stderr.slice(-1500));
  const tell = await told;
  assert.deepStrictEqual([tell.m.why, tell.m.refunded], ['restarting', true], 'and tells the player');
  const recs = fs.readFileSync(one.journal, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const open = recs.find((r) => r.t === 'open' && r.wallet === W1);
  const close = recs.find((r) => r.t === 'close' && r.jid === open.jid);
  assert.deepStrictEqual([open.micro, open.room, close.outcome, close.why, close.micro], [500000, 'paper_na_s0_5', 'refunded', 'shutdown', 500000]);
  one.srv.kill('SIGKILL');
  await until(() => one.srv.exitCode !== null || one.srv.signalCode !== null, 5000);
  // boot 2 (dev-local: the in-memory database) on the same journal: the owed row is written once
  const two = await boot({}, { script: 'scripts/dev-local.js', preload: true, journal: one.journal });
  procs.push(two.srv);
  const sum2 = await until(() => replayOf(two.out), 15000, 200);
  assert.ok(sum2, 'the boot replayed the journal\n' + two.out.stdout.slice(-1500));
  assert.deepStrictEqual([sum2.files, sum2.owed + sum2.existed, sum2.failed, sum2.unsettled], [1, 1, 0, 0]);
  assert.ok(two.out.stderr.includes('[AG] JOURNAL owed ' + W1 + ' 500000 micro ' + close.reason) || sum2.existed === 1,
    'the owed row\n' + two.out.stderr.slice(-800));
  // a second seat on boot 2, then a crash
  const W2 = 'PpCrashWa11et22222222222222222222222222222';
  await paperSeat(io, two.port, W2, 'crash', socks);
  fs.writeFileSync(path.join(two.dir, 'crash'), '');
  assert.ok(await until(() => two.srv.exitCode !== null, 10000), 'boot 2 died');
  assert.match(two.out.stderr, new RegExp('\\[AG\\] CRASH-OWED ' + W2 + ' 500000 micro refund paper crash paper_na_s0_5 agowed:'));
  // boot 3: the crash's row is owed once
  const three = await boot({}, { script: 'scripts/dev-local.js', journal: one.journal });
  procs.push(three.srv);
  const sum3 = await until(() => replayOf(three.out), 15000, 200);
  assert.ok(sum3, 'boot 3 replayed\n' + three.out.stdout.slice(-1500));
  assert.deepStrictEqual([sum3.files, sum3.owed, sum3.failed, sum3.unsettled], [1, 1, 0, 0]);
  assert.match(three.out.stderr, new RegExp('\\[AG\\] JOURNAL owed ' + W2 + ' 500000 micro refund paper crash paper_na_s0_5 agowed:'));
  assert.ok(!/TypeError|ReferenceError|is not a function/.test(one.out.stderr + two.out.stderr + three.out.stderr),
    'no wiring error\n' + three.out.stderr.slice(-800));
});

test('agar:paid:off and paper:paid:off outlive a restart: rows closed, new paid joins refunded not-open (item b)', { timeout: 180000 }, async (t) => {
  const io = requireClient(t);
  if (!io) return;
  const socks = [];
  const procs = [];
  t.after(() => {
    for (const s of socks) { try { s.close(); } catch (_) {} }
    for (const p of procs) { try { p.kill('SIGKILL'); } catch (_) {} }
  });
  const paidRows = (b, game) => b.lobbies.filter((l) => l.game === game && l.stake > 0);
  const one = await boot({ AG_PAID: '1', AG_ENABLED: '1' });
  procs.push(one.srv);
  for (const a of ['agar:paid:off', 'paper:paid:off']) {
    const r = await post(`http://localhost:${one.port}/api/owner/do`, ownerProof(a, {}));
    assert.strictEqual(r.status, 200, r.body);
    assert.match(r.body, /stays closed across restarts/, a);
  }
  one.srv.kill('SIGKILL');
  await until(() => one.srv.exitCode !== null || one.srv.signalCode !== null, 5000);
  // the restart (a deploy): the same server/data, so the same switch files
  const two = await boot({ AG_PAID: '1', AG_ENABLED: '1' }, { journal: one.journal });
  procs.push(two.srv);
  assert.match(two.out.stderr + two.out.stdout, /\[AG\] paid door CLOSED at boot \(owner\)/);
  assert.match(two.out.stderr + two.out.stdout, /\[PAPER\] paid door CLOSED at boot \(owner\)/);
  let b = await live(two.port);
  for (const g of ['agar', 'paper']) {
    const rows = paidRows(b, g);
    assert.ok(rows.length >= 2 && rows.every((r) => r.state === 'closed'), g + ' paid rows closed: ' + JSON.stringify(rows));
  }
  const st = JSON.parse((await post(`http://localhost:${two.port}/api/owner/state`, ownerProof('state', {}))).body);
  assert.deepStrictEqual([st.agPaid.open, st.agPaid.saved, st.paperPaid.open, st.paperPaid.saved], [false, true, false, true]);
  // a new paid Paper join: refunded at the door
  const WP = 'PpClosedWa11et33333333333333333333333333333';
  const p = await connect(io, two.port);
  socks.push(p);
  p.emit('pp:join', { stake: 0.5, name: 'late', entryToken: await mint(two.port, WP) });
  const pr = await first(p, ['pp:refused', 'pp:joined'], 10000);
  assert.deepStrictEqual([pr.ev, pr.m.why, pr.m.refunded], ['pp:refused', 'not-open', true]);
  assert.ok(await until(() => new RegExp('\\[PAPER\\] REFUND ' + WP + ' 500000 not-open').test(two.out.stdout), 5000),
    'refunded through Paper\'s payout\n' + two.out.stdout.slice(-600));
  // a new paid agar join: refunded at the door
  const WA = 'AgClosedWa11et44444444444444444444444444444';
  const a = await connect(io, two.port, '/ag', { paid: 1 });
  socks.push(a);
  a.emit('ag:join', { stake: 0.5, entryToken: await mint(two.port, WA, 'agar'), name: 'late' });
  const ar = await first(a, ['ag:refused', 'ag:joined'], 10000);
  assert.deepStrictEqual([ar.ev, ar.m.why, ar.m.refunded], ['ag:refused', 'not-open', true]);
  // :on reopens both and clears the saved close
  for (const a2 of ['agar:paid:on', 'paper:paid:on']) {
    const r = await post(`http://localhost:${two.port}/api/owner/do`, ownerProof(a2, {}));
    assert.strictEqual(r.status, 200, r.body);
  }
  b = await live(two.port);
  for (const g of ['agar', 'paper']) assert.ok(paidRows(b, g).every((r) => r.state === 'open'), g + ' reopened');
  const st2 = JSON.parse((await post(`http://localhost:${two.port}/api/owner/state`, ownerProof('state', {}))).body);
  assert.deepStrictEqual([st2.agPaid.saved, st2.paperPaid.saved], [false, false]);
  assert.ok(!/TypeError|ReferenceError|is not a function/.test(one.out.stderr + two.out.stderr), two.out.stderr.slice(-800));
});

test('PLAY with a claimed googleId writes nothing to that wallet; a socket that proves its wallet is credited (item e)', { timeout: 120000 }, async (t) => {
  const io = requireClient(t);
  if (!io) return;
  const socks = [];
  const srv = await boot({}, { script: 'scripts/dev-local.js' });
  t.after(() => {
    for (const s of socks) { try { s.close(); } catch (_) {} }
    try { srv.srv.kill('SIGKILL'); } catch (_) {}
  });
  const profile = async (w) => JSON.parse((await get(`http://localhost:${srv.port}/api/my-profile?wallet=${w}`)).body);
  const playOnce = async (msg) => {
    const s = await connect(io, srv.port);
    socks.push(s);
    s.emit('lobby:join', { googleId: msg.googleId });
    s.emit(C.EVENTS.PLAY, Object.assign({ name: 'idtest', color: '#c080ff', stake: 0, entryToken: '', region: 'na' }, msg));
    await sleep(1500);
    s.close();
    await sleep(800);
  };
  const VICTIM = 'VictimWa11et5555555555555555555555555555555';
  await playOnce({ googleId: VICTIM, walletAddress: VICTIM });
  assert.strictEqual((await profile(VICTIM)).gamesPlayed, 0, 'a claimed googleId wrote nothing to the victim');
  // the same game with a proof of a wallet the socket really holds
  const secret = ed25519.utils.randomPrivateKey();
  const wallet = bs58.encode(ed25519.getPublicKey(secret));
  const ts = Date.now();
  const idProof = { wallet, ts, sig: bs58.encode(ed25519.sign(new TextEncoder().encode(identityMessage(wallet, ts)), secret)) };
  await playOnce({ googleId: VICTIM, idProof });
  assert.strictEqual((await profile(wallet)).gamesPlayed, 1, 'the proven wallet is credited');
  assert.strictEqual((await profile(VICTIM)).gamesPlayed, 0, 'and the claimed one still is not');
  // the shape public/js/game.js sends: the lobby widget's duelWalletSignAction('play:identify', {})
  const k2 = ed25519.utils.randomPrivateKey();
  const w2 = bs58.encode(ed25519.getPublicKey(k2));
  const ts2 = Date.now();
  const widget = { action: 'play:identify', args: {}, wallet: w2, ts: ts2,
    sig: bs58.encode(ed25519.sign(new TextEncoder().encode(actionMessage('play:identify', {}, w2, ts2)), k2)) };
  await playOnce({ idProof: widget });
  assert.strictEqual((await profile(w2)).gamesPlayed, 1, 'the widget-signed proof credits its wallet');
  assert.strictEqual(srv.srv.exitCode, null, 'the server is up');
  assert.ok(!/TypeError|ReferenceError|is not a function/.test(srv.out.stderr), srv.out.stderr.slice(-800));
});
