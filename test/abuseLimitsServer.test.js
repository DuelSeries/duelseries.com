'use strict';
/* Cheap requests that used to cost the whole server (night review 2026-10-29, group g3).

   Every game, HTTP, the owner console and the payout drainer share one Node event loop, so a
   request or a socket message that makes the server do far more work than it took to send is a
   way to freeze paid matches. Each case here was one of those; each is thrown at the REAL server
   (scripts/dev-local.js: in-memory database, every outbound call refused), and the server must
   answer it quickly and stay up.

   Sockets and requests are given an X-Forwarded-For address the way nginx gives them one (the
   TCP peer here is loopback, which server/clientAddr.js trusts as the proxy), so per-address
   limits can be exercised from one machine. */
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

let port, srv, out = '', exitCode = null;
let ipSeq = 0;
const nextIp = () => { ++ipSeq; return '203.0.' + ((ipSeq >> 8) & 255) + '.' + (ipSeq & 255); };
// Raw HTTP so the body is exactly what is written. Each call from its own address unless one is given.
function call(method, url, body, ip) {
  const from = ip || nextIp();
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.connect(port, '127.0.0.1');
    const data = body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
    let text = '';
    s.on('connect', () => s.write(`${method} ${url} HTTP/1.1\r\nHost: localhost\r\nX-Forwarded-For: ${from}\r\n`
      + `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(data)}\r\nConnection: close\r\n\r\n${data}`));
    s.on('data', (d) => { text += d; });
    s.on('end', () => {
      let json = null;
      try { json = JSON.parse(text.split('\r\n\r\n').slice(1).join('\r\n\r\n')); } catch (_) {}
      resolve({ status: Number(text.split(' ')[1]) || 0, json, ms: Date.now() - t0 });
    });
    s.on('error', () => resolve({ status: -1, json: null, ms: Date.now() - t0 }));
    s.setTimeout(8000, () => { s.destroy(); resolve({ status: -2, json: null, ms: Date.now() - t0 }); });
  });
}
const alive = () => exitCode === null && srv && srv.exitCode === null;
const died = () => 'server process exited (code ' + exitCode + '):\n' + out.split('\n').filter((l) => /Error|at /.test(l)).slice(0, 8).join('\n');

test.before(async () => {
  port = await freePort();
  srv = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dev-local.js')], {
    cwd: ROOT, env: { ...process.env, DEV_LOCAL_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', (d) => { out += d; });
  srv.stderr.on('data', (d) => { out += d; });
  srv.on('exit', (code) => { exitCode = code === null ? 'signal' : code; });
  for (let i = 0; i < 160; i++) {
    if (!alive()) throw new Error(died());
    if ((await call('GET', '/api/live')).status === 200) return;
    await sleep(250);
  }
  throw new Error('server did not come up');
});
test.after(() => { if (srv && alive()) srv.kill(); });

/* The event loop's health, seen from outside: /api/live answered, and how fast. */
async function loopAnswers() {
  const r = await call('GET', '/api/live');
  return r.status === 200 ? r.ms : -1;
}

/* ── finding 20: /api/broadcast and a body whose signedTx is an object with a huge length ────────── */
test('/api/broadcast refuses anything but a short base64 string, at once', async () => {
  for (const signedTx of [{ length: 1e8 }, { length: 3e8 }, ['AAAA'], 5, true, 'A'.repeat(4097)]) {
    const r = await call('POST', '/api/broadcast', { signedTx });
    assert.ok(alive(), died());
    assert.strictEqual(r.status, 400, JSON.stringify(signedTx).slice(0, 40) + ' answered ' + r.status);
    assert.strictEqual(r.json && r.json.error, 'Missing signed transaction');
    assert.ok(r.ms < 1500, JSON.stringify(signedTx).slice(0, 40) + ' took ' + r.ms + ' ms');
  }
  const lag = await loopAnswers();
  assert.ok(lag >= 0 && lag < 1500, 'the server still answers promptly (' + lag + ' ms)');
  // An honest-shaped string still reaches the relay (refused there as not a transaction, never as missing).
  const ok = await call('POST', '/api/broadcast', { signedTx: Buffer.from('not a transaction').toString('base64') });
  assert.strictEqual(ok.status, 400);
  assert.notStrictEqual(ok.json && ok.json.error, 'Missing signed transaction');
});

/* A socket.io client, from an address of its own unless one is given (null: no header, a local socket). */
function connect(ip, opts) {
  const { io } = require('socket.io-client');
  const headers = ip === null ? {} : { 'x-forwarded-for': ip || nextIp() };
  const s = io(`http://127.0.0.1:${port}`, Object.assign({ transports: ['websocket'], forceNew: true, reconnection: false,
    timeout: 5000, extraHeaders: headers }, opts || {}));
  const got = [];
  s.onAny((ev, p) => got.push([ev, p]));
  return new Promise((res, rej) => {
    const bail = setTimeout(() => rej(new Error('socket never connected' + (alive() ? '' : ': ' + died()))), 8000);
    s.on('connect', () => { clearTimeout(bail); res({ s, got, count: (ev) => got.filter((g) => g[0] === ev).length }); });
    s.on('connect_error', (e) => { clearTimeout(bail); rej(e); });
  });
}
// Messages on one socket are handled in order: an answered ping means everything before it was handled.
function handled(s) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 8000);
    s.once('pong_check', () => { clearTimeout(t); resolve(true); });
    s.emit('ping_check');
  });
}
async function until(fn, ms) {
  for (let i = 0; i < ms / 50; i++) { if (fn()) return true; await sleep(50); }
  return fn();
}

/* ── finding 12: ko:lock repeated in a loop during the opponent's aim ────────────────────────────── */
test('a loop of ko:lock tells the opponent once, not once per packet', { timeout: 60000 }, async () => {
  const a = await connect(), b = await connect();
  try {
    a.s.emit('ko:queue', { name: 'lockA' });
    await sleep(1100);   // ko:queue is one a second per socket; b queues after a is waiting
    b.s.emit('ko:queue', { name: 'lockB' });
    assert.ok(await until(() => a.count('ko:turn') > 0 && b.count('ko:turn') > 0, 10000), 'the two met and the first turn began');
    for (let i = 0; i < 500; i++) a.s.emit('ko:lock');
    assert.ok(await handled(a.s));
    await sleep(300);
    assert.strictEqual(b.count('ko:ready'), 1, 'one ko:ready for one lock-in, however many packets');
    assert.ok(alive(), died());
  } finally { a.s.close(); b.s.close(); }
});

/* An owner proof signed with dev-local's throwaway owner key (it prints it, local only). */
function ownerProof(action) {
  const m = /throwaway owner secret \(bs58, local only\) (\S+)/.exec(out);
  assert.ok(m, 'dev-local printed its throwaway owner key');
  const { ed25519 } = require('@noble/curves/ed25519');
  const _bs58 = require('bs58');
  const bs58 = (_bs58 && _bs58.default) ? _bs58.default : _bs58;
  const { actionMessage } = require('../server/ownerAuth');
  const secret = bs58.decode(m[1]);
  const wallet = bs58.encode(ed25519.getPublicKey(secret));
  const ts = Date.now();
  const sig = bs58.encode(ed25519.sign(new TextEncoder().encode(actionMessage(action, {}, wallet, ts)), secret));
  return { action, args: {}, wallet, ts, sig };
}

/* ── finding 21: GET /api/debug/tick?recent=all, unauthenticated and unlimited ───────────────────── */
test('/api/debug/tick is the owner\'s: anyone else gets a quick 403 and no report, then the limiter', async () => {
  const ip = nextIp();
  const first = await call('GET', '/api/debug/tick?recent=all', undefined, ip);
  assert.strictEqual(first.status, 403);
  assert.ok(first.json && !first.json.rooms && !first.json.heap, 'nothing of the report is built or sent');
  let limited = false;
  for (let i = 0; i < 40 && !limited; i++) limited = (await call('GET', '/api/debug/tick?recent=all', undefined, ip)).status === 429;
  assert.ok(limited, 'one address is cut off after 30 a minute (sigLimiter)');
  // The owner still reads all of it.
  const mine = await call('GET', '/api/debug/tick?recent=all', ownerProof('debug:tick'));
  assert.strictEqual(mine.status, 200);
  assert.ok(mine.json && mine.json.rooms && Object.keys(mine.json.rooms).length > 0 && mine.json.heap, 'the full report for the owner');
});

/* ── finding 29: a loop of lobby:join, each one a full LOBBY_STATE to every lobby socket ─────────── */
test('a loop of lobby:join is not a LOBBY_STATE per message to every lobby socket', { timeout: 60000 }, async () => {
  const watcher = await connect(), flooder = await connect();
  try {
    watcher.s.emit('lobby:join', {});
    assert.ok(await until(() => watcher.count('lobby_state') >= 2, 3000), 'the watcher is told the lobby changed (its own join)');
    const before = watcher.count('lobby_state');
    for (let i = 0; i < 2000; i++) flooder.s.emit('lobby:join', {});
    assert.ok(await handled(flooder.s));
    await sleep(1500);
    const sent = watcher.count('lobby_state') - before;
    assert.ok(sent >= 1, 'the flooder\'s first join still reaches the lobby');
    assert.ok(sent <= 3, sent + ' LOBBY_STATEs for 2000 lobby:join');
    const last = watcher.got.filter((g) => g[0] === 'lobby_state').pop()[1];
    assert.ok(last.lobbyCount >= 2, 'and it carries the count as it is now');
    assert.ok(alive(), died());
  } finally { watcher.s.close(); flooder.s.close(); }
});

/* ── finding 31: free RESPAWN, a direct owner phone push every time, no rate limit ───────────────── */
test('play again still works, and a free one goes through the capped join alerts, not straight to the owner\'s phone', { timeout: 60000 }, async () => {
  const c = await connect();
  try {
    c.s.emit('play', { name: 'again', lobbyType: 'free', region: 'na' });
    assert.ok(await until(() => c.count('game_joined') === 1, 5000), 'seated');
    c.s.emit('cashout:start');   // a free snake's hold ends it after CASHOUT_HOLD_MS
    const C = require('../shared/constants');
    await sleep(C.CASHOUT_HOLD_MS + 600);
    c.s.emit('respawn', {});
    c.s.emit('respawn', {});
    assert.ok(await handled(c.s));
    assert.ok(await until(() => c.count('game_joined') === 2, 3000), 'one press of Play again is one respawn');
    await sleep(800);
    assert.strictEqual(c.count('game_joined'), 2, 'the second press, inside half a second, waited and found the snake alive');
    assert.ok(alive(), died());
  } finally { c.s.close(); }
  const fs = require('fs');
  const src = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  const h = src.slice(src.indexOf('on(C.EVENTS.RESPAWN'), src.indexOf("on('ping_check'"));
  assert.match(h, /^on\(C\.EVENTS\.RESPAWN, \(msg\) => \{\s*if \(socketRL\(socket, 'respawn', 500\)\) \{ respawn\(msg\); return; \}\s*if \(socket\._respawnLater\) return;/,
    'once each half second, and at most one press waiting');
  assert.match(h, /if \(entry\.worth > 0\) \{\s*notify\.pushOwner\(/, 'only a paid play again pushes directly');
  assert.match(h, /\} else \{[\s\S]*joinAlerts\.joined\(\{ game: room\.isBattleRoyale \? 'br' : 'snake', stake: 0,/, 'a free one is a capped join alert');
  assert.strictEqual((h.match(/notify\.pushOwner\(/g) || []).length, 1);
});

/* The review of that fix (night review 2026-10-29): the page clears isDead and hides its death screen BEFORE it sends,
   so a press the half second dropped left a player who died within half a second of a respawn with no snake and no
   death screen. Such a press is now kept and runs when the half second is up. */
test('a Play again pressed inside the half second after the last one is kept and runs, not dropped', { timeout: 60000 }, async () => {
  const C = require('../shared/constants');
  const c = await connect();
  try {
    c.s.emit('play', { name: 'quick', lobbyType: 'free', region: 'na' });
    assert.ok(await until(() => c.count('game_joined') === 1, 5000), 'seated');
    c.s.emit('cashout:start');   // a free snake's hold ends it after CASHOUT_HOLD_MS
    assert.ok(await until(() => c.count('cashout:started') === 1, 3000));
    await sleep(C.CASHOUT_HOLD_MS - 250);
    const t1 = Date.now();
    c.s.emit('respawn', {});     // still alive: nothing, but the half second counts from this press
    assert.ok(await handled(c.s));
    assert.ok(await until(() => c.count('cashout:result') === 1, 3000), 'the hold ended the snake');
    const t2 = Date.now();
    c.s.emit('respawn', {});     // the death screen's Play again, pressed at once
    assert.ok(t2 - t1 < 450, 'the second press was inside the half second (' + (t2 - t1) + ' ms), so this tests the wait');
    assert.ok(await until(() => c.count('game_joined') === 2, 2000), 'it ran when the half second was up');
    await sleep(700);
    assert.strictEqual(c.count('game_joined'), 2, 'once');
    assert.ok(alive(), died());
  } finally { c.s.close(); }
});

/* ── finding 13: no per-address cap on the main namespace, and free duel seats without limit ─────── */
test('one address holds at most 40 sockets here; a place frees when one closes; local sockets are never counted', { timeout: 90000 }, async () => {
  const ip = nextIp();
  const held = [];
  try {
    for (let i = 0; i < 40; i++) held.push(await connect(ip));
    await assert.rejects(connect(ip), /too many connections/, 'the 41st from that address is refused at the handshake');
    const other = await connect();   // another address is its own count
    held.push(other);
    held.shift().s.close();
    await sleep(300);
    held.push(await connect(ip));
    await assert.rejects(connect(ip), /too many connections/);
    const local = [];
    for (let i = 0; i < 45; i++) local.push(await connect(null));
    held.push(...local);
    assert.ok(await handled(local[44].s), 'sockets from this box itself are never limited');
    assert.ok(alive(), died());
  } finally { for (const c of held) c.s.close(); }
  await sleep(300);
});

test('one address holds at most 10 free duel seats across every duel; another address, and a freed seat, still play', { timeout: 90000 }, async () => {
  const ip = nextIp();
  const socks = [];
  try {
    // Ten free seats: nine Head Soccer, one Knockout. The same wallet string keeps them from pairing with each other.
    for (let i = 0; i < 10; i++) {
      const c = await connect(ip);
      socks.push(c);
      c.s.emit(i === 9 ? 'ko:queue' : 'hs:queue', { name: 'seat' + i, wallet: 'SameWa11et' });
      assert.ok(await handled(c.s));
    }
    assert.strictEqual(socks.filter((c) => c.count('hs:queued') === 1 || c.count('ko:queued') === 1).length, 10, 'ten seats taken');
    const eleventh = await connect(ip);
    socks.push(eleventh);
    eleventh.s.emit('ah:queue', { name: 'seat10', wallet: 'SameWa11et' });
    assert.ok(await handled(eleventh.s));
    const refused = eleventh.got.find((g) => g[0] === 'ah:refused');
    assert.ok(refused && /Too many free games/.test(refused[1].why), 'the eleventh is refused, with a reason');
    assert.strictEqual(eleventh.count('ah:queued'), 0);
    // Queueing again where it already waits is not a new seat.
    await sleep(1100);
    socks[0].s.emit('hs:queue', { name: 'seat0', wallet: 'SameWa11et' });
    assert.ok(await handled(socks[0].s));
    assert.strictEqual(socks[0].count('hs:refused'), 0, 'its own seat is replaced, not counted twice');
    // Another address plays as normal.
    const elsewhere = await connect();
    socks.push(elsewhere);
    elsewhere.s.emit('ah:queue', { name: 'other', wallet: 'OtherWa11et' });
    assert.ok(await handled(elsewhere.s));
    assert.strictEqual(elsewhere.count('ah:queued'), 1);
    // One of the ten leaves: the eleventh gets its seat.
    socks[1].s.emit('hs:unqueue');
    assert.ok(await handled(socks[1].s));
    await sleep(1100);
    eleventh.s.emit('ah:queue', { name: 'seat10', wallet: 'SameWa11et' });
    assert.ok(await handled(eleventh.s));
    assert.ok(await until(() => eleventh.count('ah:queued') === 1 || eleventh.count('ah:start') === 1, 2000), 'a freed seat is a seat again');
    assert.ok(alive(), died());
  } finally { for (const c of socks) c.s.close(); }
});

/* The review of that fix (night review 2026-10-29): a key moves a seat to ANY socket, and the queue handlers took a
   resume before the free seat count was reached, so address A could queue its seats, hand them to sockets on address B
   by their resume keys, queue more, and so on (reproduced: B held 18 free Head Soccer seats against a limit of 6). A
   rejoin key moved a seat at a table the same way. Rooftop and 8 Ball Pool here, which no test above queues in. */
test('free seats cannot be carried past an address limit by their resume or rejoin keys; a reconnect still can', { timeout: 120000 }, async () => {
  const CAP = 10;
  const A = nextIp(), B = nextIp();
  const all = [];
  const keyOf = (c, ev) => { const q = c.got.filter((g) => g[0] === ev + ':queued').pop(); return q ? q[1].resumeKey : null; };
  try {
    // A queues ten free Rooftop seats (one wallet string, so they never pair with each other).
    const a = [];
    for (let i = 0; i < CAP; i++) {
      const c = await connect(A); all.push(c); a.push(c);
      c.s.emit('rt:queue', { name: 'a' + i, wallet: 'CarryWa11et' });
      assert.ok(await handled(c.s));
      assert.match(keyOf(c, 'rt') || '', /^[0-9a-f]{32}$/, 'seat ' + (i + 1) + ' queued');
    }
    // A reconnect from A itself, at its limit, takes its own seat back: it brings no extra seat.
    const a0 = await connect(A); all.push(a0);
    a0.s.emit('rt:queue', { name: 'a0', wallet: 'CarryWa11et', resume: keyOf(a[0], 'rt') });
    assert.ok(await handled(a0.s));
    assert.strictEqual(a0.count('rt:refused'), 0, 'same address, same seat');
    assert.strictEqual(a0.count('rt:queued'), 1);
    a[0] = a0;
    // B takes the ten over by their keys, each within its own limit.
    for (let i = 0; i < CAP; i++) {
      const c = await connect(B); all.push(c);
      c.s.emit('rt:queue', { name: 'b' + i, wallet: 'CarryWa11et', resume: keyOf(a[i], 'rt') });
      assert.ok(await handled(c.s));
      assert.strictEqual(c.count('rt:queued'), 1, 'B seat ' + (i + 1) + ' is within its limit');
    }
    // A, holding none now, queues one more. B cannot take it: B is at its limit.
    await sleep(1100);   // rtq: once a second a socket
    a[1].s.emit('rt:queue', { name: 'a-more', wallet: 'CarryWa11et' });
    assert.ok(await handled(a[1].s));
    assert.strictEqual(a[1].count('rt:refused'), 0, 'A holds none of its old seats now');
    const more = keyOf(a[1], 'rt');
    const b11 = await connect(B); all.push(b11);
    b11.s.emit('rt:queue', { name: 'b10', wallet: 'CarryWa11et', resume: more });
    assert.ok(await handled(b11.s));
    const refused = b11.got.find((g) => g[0] === 'rt:refused');
    assert.ok(refused && /Too many free games/.test(refused[1].why), 'the eleventh, carried by its key, is refused with a reason');
    assert.strictEqual(b11.count('rt:queued'), 0);
    // A seat at a free 8 Ball Pool table: two of A's sockets meet (two wallets), each is sent its seat key.
    const p = [];
    for (let i = 0; i < 2; i++) {
      const c = await connect(A); all.push(c); p.push(c);
      c.s.emit('p8:queue', { name: 'p' + i, wallet: 'PoolWa11et' + i });
      assert.ok(await handled(c.s));
    }
    assert.ok(await until(() => p.every((c) => c.count('p8:seat') >= 1), 3000), 'both seated with a key');
    const seatKey = p[0].got.filter((g) => g[0] === 'p8:seat').pop()[1].key;
    await sleep(3300);   // past the player cards (Pool8Room VS_MS)
    const b12 = await connect(B); all.push(b12);
    b12.s.emit('p8:rejoin', { key: seatKey });
    assert.ok(await handled(b12.s));
    assert.strictEqual(b12.count('p8:rejoinfail'), 1, 'B, at its limit, cannot take a free table seat by its key');
    assert.strictEqual(b12.count('p8:rejoined'), 0);
    // One of B's seats goes: the same key now works (the seat stayed where it was, the key alive).
    all[CAP + 1].s.emit('rt:unqueue');
    assert.ok(await handled(all[CAP + 1].s));
    await sleep(1100);   // p8rejoin: once a second a socket
    b12.s.emit('p8:rejoin', { key: seatKey });
    assert.ok(await handled(b12.s));
    assert.strictEqual(b12.count('p8:rejoined'), 1, 'a seat freed is a seat again');
    assert.ok(alive(), died());
  } finally { for (const c of all) c.s.close(); }
});
