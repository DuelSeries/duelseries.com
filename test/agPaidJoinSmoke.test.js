'use strict';
/* Boots the real server and plays PAID agar.io on it with dev tokens (PAID-AGAR-DESIGN.md 5.7, checklist step 9).
   Every other paid-agar test drives the modules with fakes; only this one proves server/index.js wires them:
   - AG_PAID unset, 0 and a typo keep the paid rungs off (fails closed) and /api/live lists no paid agar row;
   - with AG_PAID=1 and PAPER_DEV_TOKENS=1 a dev agar token (devGame 'agar') buys a $0.10 seat through the paid door
     on /ag (auth.paid hand-off), the page readies, holds Q for 3 s and is paid 90/10 through the fake withdraw;
   - a Paper-scoped dev token does not open the agar door; a token is one-time;
   - /api/live's paid row counts an away player (players and parked), the drain says do not restart while money is
     seated, and solvency includes agar;
   - the owner console's agar:paid:off refunds the next join and keeps the seated player; on reopens it;
   - the owner alert never carries a wallet (checked on the source: ntfy topics are public).
   Boot pattern from test/paperJoinSmoke.test.js, on a port the OS hands out (no clash with parallel files). */
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

async function boot(extra) {
  const port = await freePort();
  // the paid money journal of this boot only, never the checkout's server/data
  const journal = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agsmoke-')), 'ag-money-journal.log');
  const env = { ...process.env, REGION: 'na', PORT: String(port), SESSION_SECRET: 'test', MONEY_MODE: 'usdc', DATABASE_URL: '',
    NTFY_DISABLED: '1', POSTHOG_DISABLED: '1', PAPER_PAID: '0', PAPER_DEV_TOKENS: '', ESCROW_PRIVATE_KEY: '', NODE_ENV: 'test',
    AG_ENABLED: '1', AG_PAID: '', AG_JOURNAL_PATH: journal, ...extra };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const srv = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { stdout: '', stderr: '' };
  srv.stdout.on('data', (d) => { out.stdout += d.toString(); });
  srv.stderr.on('data', (d) => { out.stderr += d.toString(); });
  for (let i = 0; i < 80; i++) {
    if (srv.exitCode !== null) break;
    try { const r = await get(`http://localhost:${port}/api/live`); if (r.status === 200) return { srv, port, out, journal }; } catch (_) {}
    await new Promise((r) => setTimeout(r, 400));
  }
  try { srv.kill('SIGKILL'); } catch (_) {}
  throw new Error('server did not come up\n' + out.stderr.slice(-1500));
}

function requireClient(t) {
  try { return require('socket.io-client'); } catch (_) { t.skip('socket.io-client not installed'); return null; }
}

function connect(io, port, paid) {
  const s = io(`http://localhost:${port}/ag`, { transports: ['websocket'], forceNew: true, reconnection: false, timeout: 5000,
    auth: paid ? { paid: 1 } : {} });
  return new Promise((res, rej) => {
    const bail = setTimeout(() => rej(new Error('socket never connected')), 10000);
    s.on('connect', () => { clearTimeout(bail); res(s); });
    s.on('connect_error', (e) => { clearTimeout(bail); rej(e); });
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

const ownerKey = ed25519.utils.randomPrivateKey();
const ownerAddr = bs58.encode(ed25519.getPublicKey(ownerKey));
const ownerProof = (action, args) => {
  const ts = Date.now();
  const msg = new TextEncoder().encode(actionMessage(action, args, ownerAddr, ts));
  return { action, args, wallet: ownerAddr, ts, sig: bs58.encode(ed25519.sign(msg, ownerKey)) };
};

const agPaidRows = (live) => live.lobbies.filter((l) => l.game === 'agar' && l.stake > 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('AG_PAID unset, 0 or a typo: the paid rungs stay off and /api/live lists no paid agar row', { timeout: 90000 }, async (t) => {
  for (const [value, line] of [['', '[AG] paid rungs OFF'], ['0', '[AG] paid rungs OFF'], ['maybe', '[AG] paid rungs OFF']]) {
    const { srv, port, out } = await boot({ AG_PAID: value });
    t.after(() => { try { srv.kill('SIGKILL'); } catch (_) {} });
    const live = JSON.parse((await get(`http://localhost:${port}/api/live`)).body);
    assert.deepStrictEqual(agPaidRows(live), [], 'AG_PAID=' + JSON.stringify(value));
    assert.ok(live.extras.some((e) => e.id === 'agar:free'), 'the free card row is still there');
    assert.ok(out.stdout.includes(line), 'boot says ' + line);
    if (value === 'maybe') assert.ok(out.stderr.includes('is not a switch value'), 'and names the bad value');
    try { srv.kill('SIGKILL'); } catch (_) {}
  }
});

test('dev agar $0.10: hand-off, door, ready, hold Q 3 s, paid 90/10; away seat counted; drain refuses; off switch refunds', { timeout: 120000 }, async (t) => {
  const io = requireClient(t);
  if (!io) return;
  const { srv, port, out, journal } = await boot({ AG_PAID: '1', PAPER_DEV_TOKENS: '1', ALLOW_TEST_OWNER: '1', TEST_OWNER_WALLET: ownerAddr });
  const socks = [];
  t.after(() => {
    for (const s of socks) { try { s.close(); } catch (_) {} }
    try { srv.kill('SIGKILL'); } catch (_) {}
  });
  assert.ok(out.stdout.includes('[AG] paid rungs on'), 'boot says the paid rungs are on');
  let live = JSON.parse((await get(`http://localhost:${port}/api/live`)).body);
  assert.deepStrictEqual(agPaidRows(live).map((r) => [r.id, r.players, r.state]), [['ag:na:s0.1', 0, 'open'], ['ag:na:s1', 0, 'open']]);

  const W1 = 'AgDevWa11et11111111111111111111111111111111';
  const mint = async (wallet, devGame) => {
    const r = await post(`http://localhost:${port}/api/submit-stake`, { stake: 0.1, walletAddress: wallet, devGame });
    assert.strictEqual(r.status, 200, r.body);
    return JSON.parse(r.body).entryToken;
  };

  // A Paper-scoped dev token does not open the agar door.
  const a = await connect(io, port, true);
  socks.push(a);
  const paperTok = await mint(W1, undefined);
  a.emit('ag:join', { stake: 0.1, entryToken: paperTok, name: 'pp' });
  const wrong = await first(a, ['ag:refused', 'ag:joined'], 5000);
  assert.strictEqual(wrong.ev, 'ag:refused');
  assert.strictEqual(wrong.m.why, 'entry');

  // An agar dev token buys the seat; worth and wallet from the token only.
  await sleep(300);
  const tok = await mint(W1, 'agar');
  a.emit('ag:join', { stake: 0.1, entryToken: tok, name: 'dev', worth: 50, walletAddress: 'EVIL' });
  const j = await first(a, ['ag:joined', 'ag:refused'], 5000);
  assert.strictEqual(j.ev, 'ag:joined', JSON.stringify(j.m));
  assert.deepStrictEqual([j.m.stake, j.m.micro, j.m.resumed, j.m.confirmed, j.m.holdTicks], [0.1, 100000, false, false, 75]);
  await first(a, ['ag:f'], 5000);
  await sleep(200);
  a.emit('ag:ready');
  await sleep(200);
  live = JSON.parse((await get(`http://localhost:${port}/api/live`)).body);
  assert.strictEqual(agPaidRows(live)[0].players, 1);

  // One-time: the same token on another socket buys nothing (and names no confirmed seat).
  const replay = await connect(io, port, true);
  socks.push(replay);
  replay.emit('ag:join', { stake: 0.1, entryToken: tok, name: 'again' });
  const rp = await first(replay, ['ag:refused', 'ag:joined'], 5000);
  assert.strictEqual(rp.ev, 'ag:refused');

  // The drain refuses a restart while money is seated, and names it.
  const chk = await post(`http://localhost:${port}/api/owner/do`, ownerProof('maintenance:check', {}));
  assert.ok(/paid game/.test(chk.body), 'drain: ' + chk.body);

  // ag:leave is refused while seated.
  a.emit('ag:leave');
  const lv = await first(a, ['ag:refused'], 3000);
  assert.strictEqual(lv.m.why, 'cash-out-to-leave');

  // Hold Q for 3 s (repeated every 200 ms, as the page does): 90/10 through the fake withdraw.
  let holding = true;
  const rep = setInterval(() => { if (holding) a.emit('ag:hold', { on: 1 }); }, 200);
  a.emit('ag:hold', { on: 1 });
  const c = await first(a, ['ag:cashedout'], 6000);
  holding = false;
  clearInterval(rep);
  assert.deepStrictEqual([c.m.grossMicro, c.m.cutMicro, c.m.netMicro], [100000, 10000, 90000]);
  const paid = await first(a, ['ag:paid', 'ag:payerror'], 5000);
  assert.strictEqual(paid.ev, 'ag:paid');
  assert.match(String(paid.m.sig), /^DEV/, 'the fake withdraw');
  assert.ok(out.stdout.includes('[AG] DEV withdraw') || out.stdout.includes('DEV withdraw'), 'paid through the dev money');

  // An away seat: counted on the row (players and parked); solvency includes it.
  const W2 = 'AgDevWa11et22222222222222222222222222222222';
  const b = await connect(io, port, true);
  socks.push(b);
  b.emit('ag:join', { stake: 0.1, entryToken: await mint(W2, 'agar'), name: 'away' });
  assert.strictEqual((await first(b, ['ag:joined', 'ag:refused'], 5000)).ev, 'ag:joined');
  await first(b, ['ag:f'], 5000);
  await sleep(150);
  b.emit('ag:ready');
  await sleep(200);
  b.close();
  await sleep(300);
  live = JSON.parse((await get(`http://localhost:${port}/api/live`)).body);
  const row = agPaidRows(live)[0];
  assert.deepStrictEqual([row.players, row.parked], [1, 1], 'an away player is still a player (rule 4b) and parked');
  const st = await post(`http://localhost:${port}/api/owner/state`, ownerProof('state', {}));
  const state = JSON.parse(st.body);
  const agRoom = state.rooms.find((r) => r.id === 'ag_na_s0_1');
  assert.ok(agRoom, 'the paid room is in the owner view');
  assert.strictEqual(agRoom.label, 'agar.io · $0.10');
  assert.strictEqual(agRoom.parked, 1);
  assert.strictEqual(state.drain.safe, false, 'not safe to restart with money parked');

  // The off switch: the next paid join is refunded at the door, the row says closed; on reopens.
  const off = await post(`http://localhost:${port}/api/owner/do`, ownerProof('agar:paid:off', {}));
  assert.ok(/closed/i.test(off.body), off.body);
  const W3 = 'AgDevWa11et33333333333333333333333333333333';
  const d = await connect(io, port, true);
  socks.push(d);
  d.emit('ag:join', { stake: 0.1, entryToken: await mint(W3, 'agar'), name: 'late' });
  const nr = await first(d, ['ag:refused', 'ag:joined'], 5000);
  assert.deepStrictEqual([nr.ev, nr.m.why, nr.m.refunded], ['ag:refused', 'not-open', true]);
  await sleep(200);
  assert.ok(/\[AG\] REFUND AgDevWa11et3+ 100000 not-open/.test(out.stdout), 'refunded through agar\'s payout\n' + out.stdout.slice(-600));
  live = JSON.parse((await get(`http://localhost:${port}/api/live`)).body);
  assert.strictEqual(agPaidRows(live)[0].state, 'closed');
  assert.strictEqual(agPaidRows(live)[0].players, 1, 'the seated (away) player keeps the seat');
  const on = await post(`http://localhost:${port}/api/owner/do`, ownerProof('agar:paid:on', {}));
  assert.ok(/open/i.test(on.body), on.body);
  live = JSON.parse((await get(`http://localhost:${port}/api/live`)).body);
  assert.strictEqual(agPaidRows(live)[0].state, 'open');
  // The money journal (review fix, Owen Q6): every seat's open and close, written by the real boot.
  const recs = fs.readFileSync(journal, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const opens = recs.filter((r) => r.t === 'open');
  assert.deepStrictEqual(opens.map((r) => [r.wallet, r.micro, r.room]), [[W1, 100000, 'ag_na_s0_1'], [W2, 100000, 'ag_na_s0_1']]);
  const closeOf = (r) => recs.find((x) => x.t === 'close' && x.jid === r.jid);
  assert.strictEqual(closeOf(opens[0]).outcome, 'cashedout');
  assert.strictEqual(closeOf(opens[1]), undefined, 'the away seat is still open');
  assert.ok(!/is not a function|TypeError|ReferenceError/.test(out.stderr), 'no wiring error\n' + out.stderr.slice(-800));
});

test('the agar owner alert never puts a wallet on ntfy, and solvency counts agar rooms', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  const al = fs.readFileSync(path.join(ROOT, 'server', 'ag', 'agAlert.js'), 'utf8');
  const fn = al.slice(al.indexOf('function createAgOwnerAlert'));
  assert.ok(fn.length > 100, 'createAgOwnerAlert is there');
  assert.match(src, /const agOwnerAlert = require\('\.\/ag\/agAlert'\)\.createAgOwnerAlert\(/, 'the server uses it');
  assert.doesNotMatch(fn, /JSON\.stringify\(i\)|JSON\.stringify\(info\)/, 'never the raw info');
  assert.match(al, /const SAFE_KEYS = Object\.freeze\(\['micro', 'accounts', 'totalMicro', 'inMicro', 'outMicro', 'ceiling', 'phase', 'was'\]\)/,
    'only amounts and kinds are copied');
  assert.match(fn, /for \(const k of SAFE_KEYS\)/);
  assert.doesNotMatch(fn, /\bi\.(wallet|srcWallet|dstWallet)\b|['"](wallet|srcWallet|dstWallet)['"]/, 'no wallet field is ever read or copied');
  assert.match(src, /if \(agArenas\) for \(const r of agArenas\.all\(\)\) total \+= r\.liveStakeTotal \? r\.liveStakeTotal\(\) : 0;/);
});
