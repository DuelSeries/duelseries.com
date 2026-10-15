'use strict';
/* Boots the real server and plays PAID snake on the sl engine with dev tokens (PAID-SL-DESIGN.md 10 and 11.1
   slPaidJoinSmoke; task T5, critic C-8). Every other paid sl test drives the modules with fakes; only this one proves
   server/index.js wires them, and it walks the whole lever matrix of design section 10, each case reading /api/live in
   the same step: exactly one OPEN snake row per paid stake (critic C-3), the event's br still there, and the drain text
   and the solvency sum in dollars (critic C-9).
   - SL_PAID=1: a dev $0.50 'slither' token buys a seat at /sl (auth.paid hand-off), holds Q 3 s and is paid
     500000 / 50000 / 450000 through the fake withdraw; GET /api/sl/cashout/:cid says sent (404 for a cid that is not a
     lowercase uuid, or unknown); the solvency total moves by 0.5 for the seat; the drain says "1 player is still in a
     paid game" and "0.5 USDC"
   - sl:paid:off with a seated player: the next paid join is refunded not-open once; the same answer has the sl row
     closed (players 1) and the old rows open; the seated player still cashes out 90/10; then the sl row is gone
   - sl:paid:on: the sl row is open again and the empty old rows are gone; refused while stopping (a SIGINT) and when
     SL_PAID did not build the rungs, naming why
   - sl:door:off: free joins refused closed, a paid join still seated (C-1)
   - maintenance:on: a paid join consumes and refunds maintenance; maintenance:check names the seated money
   - a dropped seat glides: players and parked count it; then its gold on the floor keeps the drain unsafe
   - SL_PAID unset or empty (on by default since the switch-on commit, T9): the sl paid rows open, no old paid row, a
     slither dev-token paid socket seated in the paid room
   - SL_PAID 0 and a typo: no sl paid row, the old rows open, a slither dev-token paid socket refunded not-open once and
     never seated in the free room
   - SL_ENABLED=0 with SL_PAID=1: no sl row of any kind, the old rows open, the boot says why (C-4)
   - a broken paid directory: unknown ['slpaid'], no sl paid row, the old rows open
   - a crash of boot 1 journals the seat; boot 2 (scripts/dev-local.js, its in-memory database) writes the owed row
   - on scripts/dev-local.js (review T5-R1, T5-R2): one throwing sim step closes a $0.50 room, its seat's owed row is
     written in dollars with its key and its floor is swept once per source wallet; a SIGINT with a $1 seat writes that
     seat's row through the installed handler; boot 2 replays both keyed closes
   Boot pattern from test/agPaidJoinSmoke.test.js (a port the OS hands out, the money journal of each boot in its own
   temp dir); RPC_URL is a .invalid host, so nothing here can reach a chain. */
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
const W = require('../shared/slWire.js');

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

function request(url, method, obj) {
  return new Promise((res, rej) => {
    const body = obj === undefined ? '' : JSON.stringify(obj);
    const headers = body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {};
    const r = http.request(url, { method, headers }, (x) => {
      let d = '';
      x.on('data', (c) => { d += c; });
      x.on('end', () => res({ status: x.statusCode, body: d }));
    });
    r.on('error', rej);
    r.setTimeout(4000, () => r.destroy(new Error('timeout')));
    r.end(body);
  });
}
const get = (url) => request(url, 'GET');
const post = (url, obj) => request(url, 'POST', obj);

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
let proofSeq = 0;
// A fresh nonce in args, so two proofs signed in the same millisecond are never the same (spent) signature.
const proofBy = (key, addr) => (action, args) => {
  const ts = Date.now();
  const a = Object.assign({ n: ++proofSeq }, args);
  const msg = new TextEncoder().encode(actionMessage(action, a, addr, ts));
  return { action, args: a, wallet: addr, ts, sig: bs58.encode(ed25519.sign(msg, key)) };
};
const ownerProof = proofBy(ownerKey, ownerAddr);
// scripts/dev-local.js makes its own throwaway owner (it overwrites TEST_OWNER_WALLET) and prints its secret: sign with it.
function devLocalProof(stdout) {
  const m = /\[dev-local\] throwaway owner secret \(bs58, local only\) (\S+)/.exec(stdout);
  assert.ok(m, 'dev-local printed its owner\n' + stdout.slice(-800));
  const key = bs58.decode(m[1]);
  return proofBy(key, bs58.encode(ed25519.getPublicKey(key)));
}

// preload: test/slPaidSmoke.preload.js, with its own env switches in extra; script: the entry (server/index.js)
async function boot(extra, opts) {
  const o = opts || {};
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slpsmoke-'));
  const journal = o.journal || path.join(dir, 'ag-money-journal.log');
  const env = { ...process.env, REGION: 'na', PORT: String(port), SESSION_SECRET: 'test', MONEY_MODE: 'usdc',
    DATABASE_URL: '', NTFY_DISABLED: '1', POSTHOG_DISABLED: '1', PAPER_PAID: '0', PAPER_DEV_TOKENS: '1',
    ESCROW_PRIVATE_KEY: '', ESCROW_PUBLIC_KEY: '', RPC_URL: 'https://rpc.invalid/never-called', SOLANA_NETWORK: 'devnet',
    NODE_ENV: 'test', SL_ENABLED: '1', SL_PAID: '1', SL_DEV_LAWS: '', AG_JOURNAL_PATH: journal, ALLOW_TEST_OWNER: '1',
    TEST_OWNER_WALLET: ownerAddr, SLP_SMOKE_TRIGGER: dir, DEV_LOCAL_PORT: String(port), ...extra };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const args = (o.preload === false ? [] : ['-r', PRELOAD]).concat(path.join(ROOT, o.script || 'server/index.js'));
  const srv = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { stdout: '', stderr: '' };
  srv.stdout.on('data', (d) => { out.stdout += d.toString(); });
  srv.stderr.on('data', (d) => { out.stderr += d.toString(); });
  for (let i = 0; i < 100; i++) {
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

const live = async (port) => JSON.parse((await get(`http://localhost:${port}/api/live`)).body);
const snakeRows = (b) => b.lobbies.filter((l) => l.game === 'snake');
const slPaidRows = (b) => snakeRows(b).filter((l) => /^sl:/.test(l.id) && l.stake > 0).map((l) => [l.id, l.state, l.players]);
const oldPaidRows = (b) => snakeRows(b).filter((l) => /^snake:/.test(l.id) && l.stake > 0).map((l) => [l.id, l.state]);
// Missing state counts as open (public/js/v2/board.js).
const openAt = (b, stake) => snakeRows(b).filter((l) => Math.abs(l.stake - stake) < 1e-9 && l.state !== 'closed');

// Every /api/live answer this file reads: exactly one OPEN snake row per paid stake, and the event's br.
function board(b, why) {
  for (const s of [0.5, 1]) {
    const open = openAt(b, s);
    assert.strictEqual(open.length, 1, why + ': one open snake row at $' + s + ', got ' +
      JSON.stringify(snakeRows(b).map((l) => [l.id, l.state])));
  }
  assert.ok(b.br && typeof b.br.state === 'string', why + ': br is still on the board');
  return b;
}

const ownerDo = async (port, action, args) => {
  const r = await post(`http://localhost:${port}/api/owner/do`, ownerProof(action, args || {}));
  return { status: r.status, body: r.body, text: (() => { try { const j = JSON.parse(r.body); return j.note || j.error || r.body; } catch (_) { return r.body; } })() };
};

async function solvency(port) {
  const r = await request(`http://localhost:${port}/api/admin/solvency`, 'GET', ownerProof('solvency', {}));
  assert.strictEqual(r.status, 200, r.body);
  const j = JSON.parse(r.body);
  assert.strictEqual(typeof j.liveStakesSol, 'number', 'solvency computed: ' + r.body);
  return j.liveStakesSol;
}

async function mint(port, wallet, stake) {
  const r = await post(`http://localhost:${port}/api/submit-stake`, { stake: stake || 0.5, walletAddress: wallet, devGame: 'slither' });
  assert.strictEqual(r.status, 200, r.body);
  const j = JSON.parse(r.body);
  assert.strictEqual(j.dev, true);
  return j.entryToken;
}

// One /sl socket. A paid one (token) sends { paid: 1, stake, entryToken }; it steers its own snake toward the map
// centre (grd, grd) from its first snake_add (snx, sny), so it never meets the border while the test needs it alive,
// and sends an input every 200 ms (the hold's safety net needs upstream).
function slSocket(io, port, auth, nick) {
  const s = io(`http://localhost:${port}/sl`, { transports: ['websocket'], forceNew: true, reconnection: false, timeout: 5000,
    auth });
  const h = { s, nick, items: [], grd: null, own: null, q: null, beat: null };
  s.on('sl:x', (list) => { for (const it of Array.isArray(list) ? list : []) h.items.push(it); });
  s.on('sl:f', (data) => {
    let evs = [];
    try { evs = W.decodeBundle(data instanceof Uint8Array ? data : new Uint8Array(data)); } catch (_) { return; }
    for (const ev of evs) {
      if (ev.type === 'init') h.grd = ev.grd;
      else if (ev.type === 'snake_add' && !h.own && ev.nick === nick && h.grd !== null) {
        h.own = ev;
        const th = Math.atan2(h.grd - ev.sny, h.grd - ev.snx);
        const turn = ((th % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        h.q = Math.round(turn / (2 * Math.PI) * 251) % 251;
      }
    }
  });
  h.beat = setInterval(() => {
    if (!s.connected) return;
    try { s.emit('sl:i', W.encodeInput([h.q === null ? { type: 'ping' } : { type: 'angle', q: h.q }])); } catch (_) {}
  }, 200);
  h.close = () => { clearInterval(h.beat); try { s.close(); } catch (_) {} };
  h.item = (pred, ms) => until(() => h.items.find(pred), ms || 6000);
  return new Promise((res, rej) => {
    const bail = setTimeout(() => rej(new Error('socket never connected')), 10000);
    s.on('connect', () => { clearTimeout(bail); res(h); });
    s.on('connect_error', (e) => { clearTimeout(bail); rej(e); });
  });
}

async function paidJoin(io, port, token, nick, socks, stake) {
  const h = await slSocket(io, port, { paid: 1, stake: stake || 0.5, entryToken: token, cv: 1 }, nick);
  socks.push(h);
  h.s.emit('sl:join', { nick });
  const first = await h.item((x) => x.t === 'room' || x.t === 'refused');
  assert.ok(first, nick + ': an answer from the paid door');
  return { h, first };
}

const count = (text, re) => (text.match(re) || []).length;

test('SL_PAID=1, dev tokens: the whole lever matrix on one boot, each step reading /api/live, drain and solvency', { timeout: 240000 }, async (t) => {
  const io = requireClient(t);
  if (!io) return;
  const b = await boot({ SLP_SMOKE_ESCROW: '100' });
  const { srv, port, out } = b;
  const socks = [];
  t.after(() => {
    for (const h of socks) h.close();
    try { srv.kill('SIGKILL'); } catch (_) {}
  });
  assert.ok(out.stdout.includes('[SLP] paid snake on the new engine on'), 'boot says on\n' + out.stdout.slice(-800));

  // Open: both sl paid rows open, the empty old paid rows handed over.
  let lb = board(await live(port), 'boot');
  assert.deepStrictEqual(slPaidRows(lb), [['sl:na:s0.5', 'open', 0], ['sl:na:s1', 'open', 0]]);
  assert.deepStrictEqual(oldPaidRows(lb), [], 'no old paid row while the sl rows are open and the old rooms empty');
  assert.strictEqual(lb.unknown, undefined);
  const s0 = await solvency(port);

  // A dev $0.50 seat. Worth and wallet from the token only.
  const W1 = 'SlDevWa11et11111111111111111111111111111111';
  const p1 = await paidJoin(io, port, await mint(port, W1), 'payone', socks);
  assert.deepStrictEqual(p1.first, { t: 'room', stake: 0.5, cut: 10 });
  await until(() => p1.h.q !== null, 4000);
  lb = board(await live(port), 'seated');
  assert.deepStrictEqual(slPaidRows(lb), [['sl:na:s0.5', 'open', 1], ['sl:na:s1', 'open', 0]]);
  assert.strictEqual(lb.counts.snake >= 1, true, 'the card counts the paid seat');
  assert.strictEqual(Math.round((await solvency(port) - s0) * 1e6), 500000, 'the solvency total moves by 0.5 USDC (dollars)');
  let chk = await ownerDo(port, 'maintenance:check');
  assert.match(chk.text, /1 player is still in a paid game/);
  assert.match(chk.text, /\(0\.5 USDC in memory\)/);
  const st = JSON.parse((await post(`http://localhost:${port}/api/owner/state`, ownerProof('state', {}))).body);
  const roomView = st.rooms.find((r) => r.id === 'sl_na_s0_5');
  assert.ok(roomView, 'the paid room is in the owner view');
  assert.strictEqual(roomView.label, 'slither.io (new) · $0.50');
  assert.strictEqual(roomView.takesBots, false);
  assert.strictEqual(st.drain.paid, 1);
  assert.strictEqual(st.drain.paidWorth, 0.5);

  // sl:paid:off with a seated player: the next join refunded not-open once; in the SAME answer the sl row says closed
  // (players 1) and the old rows are open.
  const off = await ownerDo(port, 'sl:paid:off');
  assert.strictEqual(off.status, 200, off.body);
  assert.match(off.text, /closed/i);
  const W2 = 'SlDevWa11et22222222222222222222222222222222';
  const p2 = await paidJoin(io, port, await mint(port, W2), 'paytwo', socks);
  assert.deepStrictEqual(p2.first, { t: 'refused', why: 'not-open', refunded: 500000 });
  await until(() => out.stdout.includes('[SLP] REFUND sent 500000 micro -> ' + W2.slice(0, 8)), 4000);
  assert.strictEqual(count(out.stdout, new RegExp('\\[SLP\\] REFUND ' + W2 + ' 500000 not-open', 'g')), 1, 'refunded once');
  lb = board(await live(port), 'switched off');
  assert.deepStrictEqual(slPaidRows(lb), [['sl:na:s0.5', 'closed', 1]], 'listed closed while its account is open');
  assert.deepStrictEqual(oldPaidRows(lb), [['snake:na:s0.5', 'open'], ['snake:na:s1', 'open']]);

  // The seated player still holds Q and is paid 90/10.
  p1.h.s.emit('sl:hold', { on: 1 });
  const cashed = await p1.h.item((x) => x.t === 'cashed' || x.t === 'lost', 8000);
  assert.ok(cashed, 'the hold finished');
  assert.deepStrictEqual([cashed.t, cashed.gross, cashed.cut, cashed.net], ['cashed', 500000, 50000, 450000]);
  assert.match(cashed.cid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  const sent = await until(async () => {
    const r = await get(`http://localhost:${port}/api/sl/cashout/${cashed.cid}`);
    return r.status === 200 && JSON.parse(r.body).state === 'sent' ? r : null;
  }, 5000, 200);
  assert.ok(sent, 'GET /api/sl/cashout/:cid says sent');
  assert.strictEqual((await get(`http://localhost:${port}/api/sl/cashout/${cashed.cid.toUpperCase()}`)).status, 404, 'not lowercase');
  assert.strictEqual((await get(`http://localhost:${port}/api/sl/cashout/not-a-uuid`)).status, 404);
  assert.strictEqual((await get(`http://localhost:${port}/api/sl/cashout/00000000-0000-4000-8000-000000000000`)).status, 404, 'unknown');
  assert.ok(new RegExp('\\[SLP\\] CASHOUT 450000 micro -> ' + W1.slice(0, 8) + ' \\(sl_na_s0_5\\) sig DEV').test(out.stdout),
    'paid through the dev money\n' + out.stdout.slice(-800));
  assert.strictEqual(count(out.stdout, /\[SLP\] CASHOUT-ORDER /g), 1, 'one order');
  p1.h.close();
  lb = board(await live(port), 'cashed out, still off');
  assert.deepStrictEqual(slPaidRows(lb), [], 'no account left: the closed sl row is gone');
  assert.deepStrictEqual(oldPaidRows(lb), [['snake:na:s0.5', 'open'], ['snake:na:s1', 'open']]);

  // sl:paid:on: the sl rows are open again and the empty old rows are gone.
  const on = await ownerDo(port, 'sl:paid:on');
  assert.strictEqual(on.status, 200, on.body);
  lb = board(await live(port), 'switched on');
  assert.deepStrictEqual(slPaidRows(lb), [['sl:na:s0.5', 'open', 0], ['sl:na:s1', 'open', 0]]);
  assert.deepStrictEqual(oldPaidRows(lb), []);

  // sl:door:off is the free room's lever: free joins refused closed, a paid join still seated (C-1).
  const W3 = 'SlDevWa11et33333333333333333333333333333333';
  const tok3 = await mint(port, W3);
  const W4 = 'SlDevWa11et44444444444444444444444444444444';
  const tok4 = await mint(port, W4); // before maintenance: the stake route refuses new stakes under it
  assert.strictEqual((await ownerDo(port, 'sl:door:off')).status, 200);
  const free = await slSocket(io, port, { cv: 1 }, 'freebie');
  socks.push(free);
  free.s.emit('sl:join', { nick: 'freebie' });
  assert.deepStrictEqual(await free.item((x) => x.t === 'refused' || x.t === 'seat'), { t: 'refused', why: 'closed' });
  const p3 = await paidJoin(io, port, tok3, 'paythree', socks);
  assert.deepStrictEqual(p3.first, { t: 'room', stake: 0.5, cut: 10 });
  lb = board(await live(port), 'door off');
  assert.deepStrictEqual(slPaidRows(lb), [['sl:na:s0.5', 'open', 1], ['sl:na:s1', 'open', 0]]);
  assert.strictEqual((await ownerDo(port, 'sl:door:on')).status, 200);

  // maintenance:on: a paid join consumes and refunds maintenance; maintenance:check names the seated money.
  assert.strictEqual((await ownerDo(port, 'maintenance:on', { message: 'smoke' })).status, 200);
  const p4 = await paidJoin(io, port, tok4, 'payfour', socks);
  assert.deepStrictEqual(p4.first, { t: 'refused', why: 'maintenance', refunded: 500000 });
  await until(() => out.stdout.includes('[SLP] REFUND sent 500000 micro -> ' + W4.slice(0, 8)), 4000);
  assert.strictEqual(count(out.stdout, new RegExp('\\[SLP\\] REFUND ' + W4 + ' 500000 maintenance', 'g')), 1);
  chk = await ownerDo(port, 'maintenance:check');
  assert.match(chk.text, /1 player is still in a paid game/);
  assert.match(chk.text, /\(0\.5 USDC in memory\)/);
  lb = board(await live(port), 'maintenance');
  assert.strictEqual(Math.round((await solvency(port) - s0) * 1e6), 500000, 'one seated $0.50 in the solvency sum');
  assert.strictEqual((await ownerDo(port, 'maintenance:off')).status, 200);

  // A dropped seat glides: players and parked count it (rule 4b), then it dies and its gold lies on the floor.
  await until(() => p3.h.q !== null, 4000);
  p3.h.close();
  const parked = await until(async () => {
    const x = await live(port);
    const row = x.lobbies.find((l) => l.id === 'sl:na:s0.5');
    return row && row.parked === 1 ? x : null;
  }, 2500, 50);
  assert.ok(parked, 'the gliding seat is counted parked');
  board(parked, 'parked');
  assert.strictEqual(parked.lobbies.find((l) => l.id === 'sl:na:s0.5').players, 1, 'and still a player');
  const dead = await until(async () => {
    const x = await live(port);
    const row = x.lobbies.find((l) => l.id === 'sl:na:s0.5');
    return row && row.players === 0 ? x : null;
  }, 9000, 250);
  assert.ok(dead, 'the glide ended in a death');
  board(dead, 'gold on the floor');
  chk = await ownerDo(port, 'maintenance:check');
  assert.match(chk.text, /USDC on paid floors/, 'the floor gold keeps the drain unsafe: ' + chk.text);
  const st2 = JSON.parse((await post(`http://localhost:${port}/api/owner/state`, ownerProof('state', {}))).body);
  const floor = st2.rooms.find((r) => r.id === 'sl_na_s0_5').floorWorth;
  assert.ok(floor > 0 && floor <= 0.5, 'floorWorth in dollars: ' + floor);
  assert.strictEqual(Math.round((await solvency(port) - s0) * 1e6), Math.round(floor * 1e6), 'the floor is in the solvency sum');

  // A SIGINT (the shutdown settle): stopping. sl:paid:on is refused naming why; the sl rows are gone, the old rows open.
  fs.writeFileSync(path.join(b.dir, 'sigint'), '');
  assert.ok(await until(() => out.stderr.includes('[SLP] SHUTDOWN-FLOOR '), 5000), 'the floor is booked at the shutdown\n' +
    out.stderr.slice(-800));
  const again = await ownerDo(port, 'sl:paid:on');
  assert.notStrictEqual(again.status, 200);
  assert.match(again.text, /restarting/);
  lb = board(await live(port), 'stopping');
  assert.deepStrictEqual(slPaidRows(lb), []);
  assert.deepStrictEqual(oldPaidRows(lb), [['snake:na:s0.5', 'open'], ['snake:na:s1', 'open']]);

  // The money journal of this boot: one open per seat, its close, and nothing for the two refused at the door.
  const recs = fs.readFileSync(b.journal, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const opens = recs.filter((r) => r.t === 'open');
  assert.deepStrictEqual(Array.from(new Set(opens.map((r) => r.wallet))), [W1, W3]);
  const closeOf = (w) => recs.filter((x) => x.t === 'close' && opens.some((o) => o.wallet === w && o.jid === x.jid))
    .map((x) => x.outcome);
  assert.deepStrictEqual(closeOf(W1), ['cashedout']);
  assert.deepStrictEqual(closeOf(W3), ['died']);
  assert.ok(!/is not a function|TypeError|ReferenceError/.test(out.stderr), 'no wiring error\n' + out.stderr.slice(-800));
});

/* The switch-on (T9): production env is only the box's .env, so the paid rungs are ON when SL_PAID is unset or
   empty (the agar and Paper pattern). */
test('SL_PAID unset or empty opens the paid rungs: the sl rows open, no old paid row, a paid socket seated paid', { timeout: 120000 }, async (t) => {
  const io = requireClient(t);
  if (!io) return;
  for (const value of [undefined, '']) {
    const { srv, port, out } = await boot({ SL_PAID: value });
    const socks = [];
    t.after(() => {
      for (const h of socks) h.close();
      try { srv.kill('SIGKILL'); } catch (_) {}
    });
    const name = 'SL_PAID=' + JSON.stringify(value);
    assert.ok(out.stdout.includes('[SLP] paid snake on the new engine on (/sl paid rungs $0.50 and $1)'), name + ': boot says on');
    assert.ok(!out.stderr.includes('is not a switch value'), name + ': no complaint');
    const lb = board(await live(port), name);
    assert.deepStrictEqual(slPaidRows(lb), [['sl:na:s0.5', 'open', 0], ['sl:na:s1', 'open', 0]], name);
    assert.deepStrictEqual(oldPaidRows(lb), [], name + ': no old paid row while the sl rows are open and the old rooms empty');
    const W = 'SlDevWa11etOn' + (value === undefined ? 'Unset' : 'Empty') + '1111111111111111111111111';
    const p = await paidJoin(io, port, await mint(port, W), 'onpay', socks);
    assert.deepStrictEqual(p.first, { t: 'room', stake: 0.5, cut: 10 }, name);
    assert.deepStrictEqual(slPaidRows(board(await live(port), name + ' seated'))[0], ['sl:na:s0.5', 'open', 1], name + ': seated paid');
    for (const h of socks) h.close();
    try { srv.kill('SIGKILL'); } catch (_) {}
  }
});

test('SL_PAID 0 or a typo: no sl paid row, the old rows open, a paid socket refunded not-open once, never seated free', { timeout: 240000 }, async (t) => {
  const io = requireClient(t);
  if (!io) return;
  for (const value of ['0', 'maybe']) {
    const { srv, port, out } = await boot({ SL_PAID: value });
    const socks = [];
    t.after(() => {
      for (const h of socks) h.close();
      try { srv.kill('SIGKILL'); } catch (_) {}
    });
    const name = 'SL_PAID=' + JSON.stringify(value);
    assert.ok(out.stdout.includes('[SLP] paid snake on the new engine OFF'), name + ': boot says OFF');
    assert.strictEqual(out.stderr.includes('is not a switch value'), value === 'maybe', name + ': names a typo only');
    let lb = board(await live(port), name);
    assert.deepStrictEqual(slPaidRows(lb), [], name + ': no sl paid row');
    assert.deepStrictEqual(oldPaidRows(lb), [['snake:na:s0.5', 'open'], ['snake:na:s1', 'open']]);
    assert.ok(lb.lobbies.some((l) => l.id === 'sl:na:s0'), name + ': the free sl room is there');
    const W = 'SlDevWa11etOff' + String(value).replace(/\W/g, '') + '1111111111111111111111111';
    const p = await paidJoin(io, port, await mint(port, W), 'offpay', socks);
    assert.deepStrictEqual(p.first, { t: 'refused', why: 'not-open', refunded: 500000 }, name);
    await until(() => out.stdout.includes('[SLP] REFUND sent 500000 micro -> ' + W.slice(0, 8)), 4000);
    assert.strictEqual(count(out.stdout, new RegExp('\\[SLP\\] REFUND ' + W + ' 500000 not-open', 'g')), 1, name + ': once');
    lb = board(await live(port), name + ' after the refusal');
    assert.strictEqual(lb.lobbies.find((l) => l.id === 'sl:na:s0').players, 0, name + ': never seated in the free room');
    const on = await ownerDo(port, 'sl:paid:on');
    assert.notStrictEqual(on.status, 200);
    assert.match(on.text, /not on \(SL_PAID\)/, name + ': the owner text names why');
    const off = await ownerDo(port, 'sl:paid:off');
    assert.match(off.text, /not on \(SL_PAID\)/);
    for (const h of socks) h.close();
    try { srv.kill('SIGKILL'); } catch (_) {}
  }
});

test('SL_ENABLED=0 with SL_PAID=1: no sl row of any kind, the old rows open, and the boot says why (C-4)', { timeout: 60000 }, async (t) => {
  const { srv, port, out } = await boot({ SL_ENABLED: '0', SL_PAID: '1' });
  t.after(() => { try { srv.kill('SIGKILL'); } catch (_) {} });
  assert.ok(out.stdout.includes('[SLP] paid snake on the new engine not built: /sl is not open (SL_ENABLED off or refused), ' +
    'SL_PAID ignored; paid snake stays on the old engine'), out.stdout.slice(-800));
  const lb = board(await live(port), 'SL_ENABLED=0');
  assert.deepStrictEqual(lb.lobbies.filter((l) => /^sl:/.test(l.id)), []);
  assert.deepStrictEqual(snakeRows(lb).map((l) => [l.id, l.state]).sort(),
    [['snake:na:s0', 'open'], ['snake:na:s0.5', 'open'], ['snake:na:s1', 'open']]);
  const on = await ownerDo(port, 'sl:paid:on');
  assert.match(on.text, /not on \(SL_PAID\)/);
  assert.strictEqual((await get(`http://localhost:${port}/api/sl/cashout/00000000-0000-4000-8000-000000000000`)).status, 404);
});

test('a broken paid directory: /api/live says unknown slpaid, lists no sl paid row and keeps the old rows open', { timeout: 60000 }, async (t) => {
  const { srv, port, out } = await boot({ SL_PAID: '1', SLP_SMOKE_BOARD_FAULT: '1' });
  t.after(() => { try { srv.kill('SIGKILL'); } catch (_) {} });
  const lb = board(await live(port), 'fault');
  assert.deepStrictEqual(lb.unknown, ['slpaid']);
  assert.deepStrictEqual(slPaidRows(lb), []);
  assert.deepStrictEqual(oldPaidRows(lb), [['snake:na:s0.5', 'open'], ['snake:na:s1', 'open']]);
  assert.ok(lb.lobbies.some((l) => l.id === 'sl:na:s0') && lb.lobbies.some((l) => l.game === 'paper'), 'the other rows stay');
  assert.ok(out.stderr.includes('[LIVE] sl paid rows test fault'), 'and the fault is logged');
});

test('a crash of boot 1 journals the seated balance; boot 2 replays it into one owed row', { timeout: 120000 }, async (t) => {
  const io = requireClient(t);
  if (!io) return;
  const one = await boot({ SL_PAID: '1' });
  const socks = [];
  t.after(() => {
    for (const h of socks) h.close();
    try { one.srv.kill('SIGKILL'); } catch (_) {}
  });
  const WC = 'SlDevWa11etCrash111111111111111111111111111';
  const p = await paidJoin(io, one.port, await mint(one.port, WC), 'crashme', socks);
  assert.deepStrictEqual(p.first, { t: 'room', stake: 0.5, cut: 10 });
  fs.writeFileSync(path.join(one.dir, 'crash'), '');
  assert.ok(await until(() => one.srv.exitCode !== null, 10000), 'boot 1 died');
  assert.match(one.out.stderr, new RegExp('\\[AG\\] CRASH-OWED ' + WC + ' 500000 micro refund slither crash sl_na_s0_5 agowed:'));
  const recs = fs.readFileSync(one.journal, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const close = recs.find((r) => r.t === 'close');
  assert.deepStrictEqual([close.outcome, close.why, close.wallet, close.micro], ['refunded', 'crash', WC, 500000]);
  for (const h of socks) h.close();
  // boot 2: scripts/dev-local.js (the in-memory database, every outbound call refused) on the same journal path
  const two = await boot({ SL_PAID: '', SL_ENABLED: '' }, { script: 'scripts/dev-local.js', preload: false, journal: one.journal });
  t.after(() => { try { two.srv.kill('SIGKILL'); } catch (_) {} });
  const done = await until(() => /\[AG\] JOURNAL replay \{[^\n]*\}/.exec(two.out.stdout), 15000, 200);
  assert.ok(done, 'the boot replayed the journal\n' + two.out.stdout.slice(-1500));
  const sum = JSON.parse(done[0].slice('[AG] JOURNAL replay '.length));
  assert.deepStrictEqual([sum.files, sum.owed, sum.existed, sum.failed, sum.unsettled], [1, 1, 0, 0, 0]);
  assert.ok(two.out.stderr.includes('[AG] JOURNAL owed ' + WC + ' 500000 micro ' + close.reason), 'the owed row\n' +
    two.out.stderr.slice(-800));
  assert.ok(fs.readdirSync(path.dirname(one.journal)).some((n) => n.endsWith('.done')), 'the replay file is done');
});

// The owed rows in dev-local's in-memory database (scripts/memLedgerDb.js keeps the key in stake_sig), through the
// owner's failed-payouts route.
async function owedRows(port, proof) {
  const r = await request(`http://localhost:${port}/api/admin/failed-payouts`, 'GET', proof('failed-payouts', {}));
  assert.strictEqual(r.status, 200, r.body);
  return JSON.parse(r.body).filter((p) => /^agowed:/.test(p.stake_sig || ''));
}

/* Review T5-R1 and T5-R2: the live owed lane and the real SIGINT install, through server/index.js's own wiring and
   dev-local's in-memory database (no other test runs either line). A dropped $0.50 seat dies and leaves its gold on the
   floor, a second $0.50 seat and a $1 seat play on; one throwing sim step closes the $0.50 room (design 7.4), then a
   SIGINT settles the $1 seat (7.2). */
test('dev-local, SL_PAID=1: an emergency close and a SIGINT with a seat write their owed rows through the real wiring', { timeout: 150000 }, async (t) => {
  const io = requireClient(t);
  if (!io) return;
  const one = await boot({}, { script: 'scripts/dev-local.js' });
  const { port, out } = one;
  const socks = [];
  t.after(() => {
    for (const h of socks) h.close();
    try { one.srv.kill('SIGKILL'); } catch (_) {}
  });
  const proof = devLocalProof(out.stdout);
  assert.deepStrictEqual(await owedRows(port, proof), [], 'no owed row at boot');

  // B's gold on the $0.50 floor: seated, dropped, glides, dies.
  const WB = 'SlDevWa11etFloor11111111111111111111111111';
  const pb = await paidJoin(io, port, await mint(port, WB), 'payfloor', socks);
  assert.deepStrictEqual(pb.first, { t: 'room', stake: 0.5, cut: 10 });
  await until(() => pb.h.q !== null, 4000);
  pb.h.close();
  const dead = await until(async () => {
    const row = (await live(port)).lobbies.find((l) => l.id === 'sl:na:s0.5');
    return row && row.players === 0 ? row : null;
  }, 12000, 250);
  assert.ok(dead, 'the dropped seat died');

  // A seated in the same $0.50 room, D in the $1 room.
  const WA = 'SlDevWa11etEmerg11111111111111111111111111';
  const pa = await paidJoin(io, port, await mint(port, WA), 'payemerg', socks);
  assert.deepStrictEqual(pa.first, { t: 'room', stake: 0.5, cut: 10 });
  const WD = 'SlDevWa11etStop111111111111111111111111111';
  const pd = await paidJoin(io, port, await mint(port, WD, 1), 'paystop', socks, 1);
  assert.deepStrictEqual(pd.first, { t: 'room', stake: 1, cut: 10 });
  await until(() => pa.h.q !== null && pd.h.q !== null, 4000);

  // One throwing sim step in the $0.50 room: A refunded 100% of the current balance through the owed lane, the floor
  // swept to the house through slPayout.sweepFloor once per source wallet.
  fs.writeFileSync(path.join(one.dir, 'stepfault'), 'sl_na_s0_5');
  const closedA = await pa.h.item((x) => x.t === 'closed', 6000);
  assert.ok(closedA, 'the seat is told closed\n' + out.stderr.slice(-800));
  assert.strictEqual(closedA.why, 'emergency');
  const RA = closedA.refunded;
  assert.ok(Number.isSafeInteger(RA) && RA >= 500000, 'the current balance, at least the deposit: ' + RA);
  let recs = fs.readFileSync(one.journal, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const jidOf = (w) => recs.find((r) => r.t === 'open' && r.wallet === w).jid;
  const keyA = 'agowed:' + jidOf(WA);
  const rowsA = await until(async () => {
    const rows = (await owedRows(port, proof)).filter((p) => p.stake_sig === keyA);
    return rows.length ? rows : null;
  }, 5000, 100);
  assert.ok(rowsA, 'the owed row is written\n' + out.stderr.slice(-800));
  assert.deepStrictEqual(rowsA.map((p) => [p.wallet_address, p.amount_sol, p.name, p.reason]),
    [[WA, RA / 1e6, 'payemerg', 'refund slither emergency sl_na_s0_5 ' + keyA]], 'one row, in dollars, in recordOwedOnce\'s order');
  const closeA = recs.find((r) => r.t === 'close' && r.jid === jidOf(WA));
  assert.deepStrictEqual([closeA.outcome, closeA.why, closeA.key, closeA.micro], ['refunded', 'emergency', keyA, RA]);
  const sweeps = out.stdout.match(/\[SLP\] SWEEP sl_na_s0_5 emergency \d+ \S+/g) || [];
  assert.deepStrictEqual(sweeps.map((l) => l.split(' ').pop()), [WB], 'one sweep, for the one source wallet\n' +
    out.stdout.slice(-800));
  const swept = Number(sweeps[0].split(' ')[4]);
  assert.strictEqual(RA + swept, 1000000, 'the two $0.50 deposits: owed to A plus swept to the house');
  assert.ok(out.stdout.includes('[SLP] DEV earning slither_floor ' + swept / 1e6 + ' (sl_na_s0_5) not recorded'),
    'booked as slither floor income');
  assert.ok(!out.stderr.includes('[SLP] OWED CRITICAL'), 'the write landed');
  board(await live(port), 'after the emergency close');

  // A SIGINT with D still seated: one [AG] SHUTDOWN-OWED line, written through installAgShutdown's writeRow.
  fs.writeFileSync(path.join(one.dir, 'sigint'), '');
  recs = await until(() => {
    const r = fs.readFileSync(one.journal, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    return r.some((x) => x.t === 'close' && x.wallet === WD) ? r : null;
  }, 5000, 100);
  assert.ok(recs, 'the shutdown closed the $1 seat\n' + out.stderr.slice(-800));
  const keyD = 'agowed:' + jidOf(WD);
  const line = '[AG] SHUTDOWN-OWED ' + WD + ' 1000000 micro refund slither shutdown sl_na_s1 ' + keyD;
  assert.ok(await until(() => out.stderr.includes(line), 3000), 'the shutdown line\n' + out.stderr.slice(-800));
  assert.strictEqual(count(out.stderr, /\[AG\] SHUTDOWN-OWED /g), 1, 'one seat open, one line');
  const rowsD = await until(async () => {
    const rows = (await owedRows(port, proof)).filter((p) => p.stake_sig === keyD);
    return rows.length ? rows : null;
  }, 5000, 100);
  assert.ok(rowsD, 'the shutdown row is written\n' + out.stderr.slice(-800));
  assert.deepStrictEqual(rowsD.map((p) => [p.wallet_address, p.amount_sol, p.name, p.reason]),
    [[WD, 1, 'paystop', 'refund slither shutdown sl_na_s1 ' + keyD]]);
  const closeD = recs.find((r) => r.t === 'close' && r.jid === jidOf(WD));
  assert.deepStrictEqual([closeD.outcome, closeD.why, closeD.key, closeD.micro], ['refunded', 'shutdown', keyD, 1000000]);
  assert.deepStrictEqual((await owedRows(port, proof)).map((p) => p.stake_sig).sort(), [keyA, keyD].sort(),
    'no other owed row (B died: its money is the floor\'s)');
  assert.ok(!out.stderr.includes('SHUTDOWN-OWED write failed'), 'the write landed');
  assert.ok(!/is not a function|TypeError|ReferenceError/.test(out.stderr), 'no wiring error\n' + out.stderr.slice(-800));
  for (const h of socks) h.close();
  try { one.srv.kill('SIGKILL'); } catch (_) {}

  // boot 2 on the same journal: both keyed closes replay (dev-local's database is new, so each is owed again here;
  // against the real one, a row that landed answers exists), B's death none.
  const two = await boot({ SL_PAID: '', SL_ENABLED: '' }, { script: 'scripts/dev-local.js', preload: false, journal: one.journal });
  t.after(() => { try { two.srv.kill('SIGKILL'); } catch (_) {} });
  const done = await until(() => /\[AG\] JOURNAL replay \{[^\n]*\}/.exec(two.out.stdout), 15000, 200);
  assert.ok(done, 'the boot replayed the journal\n' + two.out.stdout.slice(-1500));
  const sum = JSON.parse(done[0].slice('[AG] JOURNAL replay '.length));
  assert.deepStrictEqual([sum.files, sum.owed, sum.existed, sum.failed, sum.unsettled], [1, 2, 0, 0, 0]);
  for (const key of [keyA, keyD]) {
    assert.strictEqual(count(two.out.stderr, new RegExp('\\[AG\\] JOURNAL owed \\S+ \\d+ micro [^\\n]*' + key, 'g')), 1, key);
  }
});
