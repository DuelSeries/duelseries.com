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
