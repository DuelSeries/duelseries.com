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
     refusal pays back through the row, once;
   - paid snake on the sl engine (SL_ENABLED and SL_PAID on for this boot, PAID-SL-DESIGN.md 3.2 steps
     8 to 11, task T5): the slither door claims the row before the seat, and a refusal after the claim
     ('one-seat') pays back through the row, once. */
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
let landed = 0.5;
const tx = (s) => Buffer.from(s).toString('base64');
const until = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); }
  return fn();
};

test.before(async () => {
  port = await freePort();
  process.env.DEV_LOCAL_PORT = String(port);
  // paid snake on the sl engine, for its door's claim (this process only: every test file has its own)
  process.env.SL_ENABLED = '1';
  process.env.SL_PAID = '1';
  process.env.DEV_LOCAL_SEED_STAKES = JSON.stringify([
    // An earlier boot of this NA server verified this stake; its token died with that process. It is
    // a $0.10 stake, the rung BACKLOG 2.1 retired: the new ladder never reads a row, so it is owed
    // back exactly what it stored, 0.10, like any other (map 5a).
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
  const tok = await stake(0.5);
  const sig = lastSig();
  const c = await connect();
  c.s.emit('pp:join', { name: 'dur', stake: 0.5, entryToken: tok });
  assert.ok(await until(() => c.has('pp:joined'), 6000), 'seated: ' + JSON.stringify(c.got.map((g) => g[0])));
  assert.strictEqual(ledgerDb.stakes.get(sig).state, 'consumed');
  assert.ok(ledgerDb.stakes.get(sig).claim_key);
  c.s.close();

  const tok2 = await stake(0.5);
  const sig2 = lastSig();
  ops.set({ on: true, message: 'test' });
  try {
    const c2 = await connect();
    c2.s.emit('pp:join', { name: 'dur2', stake: 0.5, entryToken: tok2 });
    const refused = await until(() => c2.has('pp:refused'));
    assert.deepStrictEqual([refused[1].why, refused[1].refunded], ['maintenance', true]);
    const owed = await until(() => ledgerDb.payouts.filter((p) => p.stake_sig === sig2).length === 1 && ledgerDb.payouts.filter((p) => p.stake_sig === sig2));
    assert.deepStrictEqual(owed.map((p) => [p.wallet_address, p.amount_sol, p.reason]), [[PAYER, 0.5, 'refund paper maintenance']]);
    assert.strictEqual(ledgerDb.stakes.get(sig2).state, 'refunded');
    c2.s.close();
  } finally {
    ops.set({ on: false });
  }
});

test('a real token at the snake and knockout doors claims its row before seating; agar.io never touches a token', async () => {
  const tok = await stake(0.5);
  const sig = lastSig();
  const c = await connect();
  c.s.emit('play', { name: 'snk', stake: 0.5, entryToken: tok, region: 'na' });
  assert.ok(await until(() => c.has('game_joined'), 6000), 'snake joined: ' + JSON.stringify(c.got.map((g) => g[0])));
  assert.strictEqual(ledgerDb.stakes.get(sig).state, 'consumed');
  c.s.close();

  const tokK = await stake(0.5);
  const sigK = lastSig();
  const k = await connect();
  k.s.emit('ko:queue', { name: 'ko', stake: 0.5, entryToken: tokK });
  const queued = await until(() => k.has('ko:queued'));
  assert.ok(queued, JSON.stringify(k.got.map((g) => g[0])));
  assert.strictEqual(queued[1].worth, 0.5);
  assert.strictEqual(ledgerDb.stakes.get(sigK).state, 'consumed');
  k.s.close();

  /* The old tier door (dollar), through the tier submit path. agar.io has no paid door at all now:
     the old game's cell:join is gone with it (test/agarSwap.test.js), and the new game on /ag
     reads no token. So a dollar tier token sent to either agar door is never touched and its row
     stays pending; the same token then claims its row at the snake dollar door. (This used the dime
     tier until BACKLOG 2.1 retired it.) */
  landed = 1;
  const r = await call(port, 'POST', '/api/submit-stake', { lobbyType: 'dollar', signedTx: tx('agar-dollar'), walletAddress: PAYER });
  assert.strictEqual(r.status, 200, r.text);
  const sigA = lastSig();
  assert.strictEqual(ledgerDb.stakes.get(sigA).label, 'lobby dollar');
  const a = await connect();
  a.s.emit('cell:join', { name: 'ag', lobbyType: 'dollar', entryToken: r.json.entryToken, region: 'na' });
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
    g.emit('ag:join', { name: 'paid', entryToken: r.json.entryToken, stake: 1 });
    const n = frames.length;
    assert.ok(await until(() => frames.length > n + 3), 'seated and sent its world, free');
  } finally {
    g.close();
  }
  assert.strictEqual(ledgerDb.stakes.get(sigA).state, 'pending', 'the new agar.io never touched the token');
  a.s.emit('play', { name: 'tier', lobbyType: 'dollar', entryToken: r.json.entryToken, region: 'na' });
  await until(() => ledgerDb.stakes.get(sigA).state === 'consumed');
  assert.strictEqual(ledgerDb.stakes.get(sigA).state, 'consumed');
  a.s.close();

  // A token whose row a sweep refunded first is never seated anywhere.
  const tokR = await stake(0.5);
  const sigR = lastSig();
  await ledgerDb.refundStakeOwed(sigR, 'refund unspent entry (sweep)', null);
  const x = await connect();
  x.s.emit('play', { name: 'late', stake: 0.5, entryToken: tokR, region: 'na' });
  const err = await until(() => x.has('error'));
  assert.ok(err, JSON.stringify(x.got.map((g) => g[0])));
  assert.match(err[1].message, /already refunded/);
  assert.ok(!x.has('game_joined'));
  assert.strictEqual(ledgerDb.payouts.filter((p) => p.stake_sig === sigR).length, 1);
  x.s.close();
});

/* BACKLOG 2.1 retired the $0.10 rung. A page left open across the deploy still sends stake 0.1 (the
   snake page re-sends its stake on every connect). It is refused at every door, never seated free,
   never seated at $0.50, and a real token offered with it is left unspent for its own rung. */
test('a retired $0.10 join is refused at the snake and Paper doors, and the token it carried is not spent', async () => {
  const tok = await stake(0.5);
  const sig = lastSig();

  const c = await connect();
  c.s.emit('play', { name: 'old', stake: 0.1, entryToken: tok, region: 'na' });
  const err = await until(() => c.has('error'));
  assert.ok(err, JSON.stringify(c.got.map((g) => g[0])));
  assert.match(err[1].message, /no longer offered/);
  c.s.emit('play', { name: 'old', lobbyType: 'dime', entryToken: tok, region: 'na' });
  c.s.emit('spectate:join', { stake: 0.1, region: 'na' });
  const pong = new Promise((res) => { c.s.once('pong_check', () => res(true)); setTimeout(() => res(false), 4000); });
  c.s.emit('ping_check');
  assert.ok(await pong);
  assert.strictEqual(c.got.filter((g) => g[0] === 'error').length, 3, 'the dime tier and a $0.10 watch are refused too');
  assert.ok(!c.has('game_joined'), 'not seated, not even free');
  assert.strictEqual(ledgerDb.stakes.get(sig).state, 'pending', 'the token was not spent');
  c.s.close();

  const p = await connect();
  p.s.emit('pp:join', { name: 'old', stake: 0.1, entryToken: tok });
  const refused = await until(() => p.has('pp:refused'));
  assert.ok(refused, JSON.stringify(p.got.map((g) => g[0])));
  assert.strictEqual(refused[1].why, 'bad-stake');
  assert.ok(!p.has('pp:joined'));
  assert.strictEqual(ledgerDb.stakes.get(sig).state, 'pending', 'still unspent');
  assert.strictEqual(ledgerDb.payouts.filter((x) => x.stake_sig === sig).length, 0, 'and nothing owed: it is still a live token');
  p.s.close();

  // The same token at its own rung seats exactly once, at $0.50.
  const s = await connect();
  s.s.emit('play', { name: 'new', stake: 0.5, entryToken: tok, region: 'na' });
  assert.ok(await until(() => s.has('game_joined'), 6000), JSON.stringify(s.got.map((g) => g[0])));
  assert.strictEqual(ledgerDb.stakes.get(sig).state, 'consumed');
  s.s.close();

  // The board lists the new rung for every ladder game, and never the old one.
  const live = await call(port, 'GET', '/api/live');
  const ids = live.json.lobbies.map((l) => l.id);
  assert.ok(!live.json.lobbies.some((l) => Math.abs(Number(l.stake) - 0.1) < 1e-9), 'no $0.10 row: ' + ids.join(' '));
  assert.ok(!ids.some((id) => /s0[._]1\b/.test(id)), ids.join(' '));
  assert.ok(ids.includes('paper:na:s0.5'), 'paper:na:s0.5 in ' + ids.join(' '));
  /* The snake $0.50 rung is one OPEN row: the old engine's, or (this boot has SL_PAID on) the new engine's, which
     takes the old row's place while that room is empty (PAID-SL-DESIGN.md 2, critic C-3). */
  const snake = live.json.lobbies.filter((l) => l.game === 'snake' && l.stake === 0.5 && l.state !== 'closed');
  assert.deepStrictEqual(snake.map((l) => l.id).filter((id) => id === 'snake:na:s0.5' || id === 'sl:na:s0.5').length, 1,
    'one open snake $0.50 row: ' + ids.join(' '));
});

// A /sl socket. Once seated it steers its own snake toward the map centre (grd, grd) from its first snake_add, so a
// spawn on the outer ring heading out never meets the border while the test still needs it alive.
function slConnect(auth, nick) {
  const { io } = require('socket.io-client');
  const W = require(path.join(ROOT, 'shared', 'slWire.js'));
  const s = io(`http://127.0.0.1:${port}/sl`, { transports: ['websocket'], forceNew: true, reconnection: false, timeout: 5000,
    auth });
  const items = [];
  let grd = null;
  let q = null;
  s.on('sl:x', (list) => { for (const it of Array.isArray(list) ? list : []) items.push(it); });
  s.on('sl:f', (data) => {
    let evs = [];
    try { evs = W.decodeBundle(data instanceof Uint8Array ? data : new Uint8Array(data)); } catch (_) { return; }
    for (const ev of evs) {
      if (ev.type === 'init') grd = ev.grd;
      else if (ev.type === 'snake_add' && q === null && grd !== null && ev.nick === nick) {
        const th = Math.atan2(grd - ev.sny, grd - ev.snx);
        q = Math.round((((th % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI) * 251) % 251;
      }
    }
  });
  const beat = setInterval(() => {
    if (s.connected && q !== null) s.emit('sl:i', W.encodeInput([{ type: 'angle', q }]));
  }, 200);
  s.on('disconnect', () => clearInterval(beat));
  return new Promise((res, rej) => {
    const bail = setTimeout(() => rej(new Error('socket never connected')), 8000);
    s.on('connect', () => { clearTimeout(bail); res({ s, items, item: (t) => items.find((x) => x.t === t) }); });
    s.on('connect_error', (e) => { clearTimeout(bail); rej(e); });
  });
}

test('a real token at the slither door claims its row before the seat; a refusal after the claim pays back through the row once', async () => {
  const tok = await stake(0.5);
  const sig = lastSig();
  const a = await slConnect({ paid: 1, stake: 0.5, entryToken: tok, cv: 1 }, 'dursl');
  a.s.emit('sl:join', { nick: 'dursl' });
  const room = await until(() => a.item('room') || a.item('refused'), 6000);
  assert.deepStrictEqual(room, { t: 'room', stake: 0.5, cut: 10 }, JSON.stringify(a.items));
  assert.strictEqual(ledgerDb.stakes.get(sig).state, 'consumed', 'claimed before the seat');
  assert.ok(ledgerDb.stakes.get(sig).claim_key);
  assert.strictEqual(ledgerDb.payouts.filter((p) => p.stake_sig === sig).length, 0);

  // The same payer again while seated: claimed, then refused 'one-seat' (Owen: one paid snake per wallet) and paid
  // back through its own row, once, never through the payout's fake withdraw.
  const tok2 = await stake(0.5);
  const sig2 = lastSig();
  const b = await slConnect({ paid: 1, stake: 0.5, entryToken: tok2, cv: 1 }, 'dursl2');
  b.s.emit('sl:join', { nick: 'dursl2' });
  const refused = await until(() => b.item('refused') || b.item('room'), 6000);
  assert.deepStrictEqual(refused, { t: 'refused', why: 'one-seat', refunded: 500000 });
  const owed = await until(() => ledgerDb.payouts.filter((p) => p.stake_sig === sig2).length === 1 &&
    ledgerDb.payouts.filter((p) => p.stake_sig === sig2));
  assert.deepStrictEqual(owed.map((p) => [p.wallet_address, p.amount_sol, p.reason]), [[PAYER, 0.5, 'refund slither one-seat']]);
  assert.strictEqual(ledgerDb.stakes.get(sig2).state, 'refunded');
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(ledgerDb.payouts.filter((p) => p.stake_sig === sig2).length, 1, 'once');
  assert.strictEqual(ledgerDb.stakes.get(sig).state, 'consumed', 'the seated stake is untouched');

  /* The old engine's $0.50 room with a player in it while the sl row is open (a stale page, BRIEF answer 4): its row is
     listed CLOSED with its players, so rule 4b still sees them, and the sl row stays the one open snake $0.50 row. */
  const tokOld = await stake(0.5);
  const c = await connect();
  c.s.emit('play', { name: 'stale', stake: 0.5, entryToken: tokOld, region: 'na' });
  assert.ok(await until(() => c.has('game_joined'), 6000), JSON.stringify(c.got.map((g) => g[0])));
  let board = null;
  for (let i = 0; i < 40 && !board; i++) {
    const r = await call(port, 'GET', '/api/live');
    const old = r.json.lobbies.find((l) => l.id === 'snake:na:s0.5');
    if (old && old.players > 0) board = r.json;
    else await new Promise((res) => setTimeout(res, 100));
  }
  assert.ok(board, 'the old room\'s row is listed while it has a player');
  const at = (s) => board.lobbies.filter((l) => l.game === 'snake' && l.stake === s);
  assert.deepStrictEqual(at(0.5).map((l) => [l.id, l.state, l.players]).sort(),
    [['sl:na:s0.5', 'open', 1], ['snake:na:s0.5', 'closed', 1]]);
  for (const s of [0.5, 1]) assert.strictEqual(at(s).filter((l) => l.state !== 'closed').length, 1, 'one open row at $' + s);
  c.s.close();
  a.s.close();
  b.s.close();
});
