'use strict';
/* The owner's own activity stays off his phone (2026-10-29), on the real server/index.js booted by scripts/dev-local.js
   in this test's own process (pushes captured, every outbound call refused but this test's own localhost socket):
   - a visit (POST /api/track/visit) carrying his live owner console cookie is not pushed; a visitor is, and so is a
     forged cookie, his cookie sent cross-site, and a body that says it is the owner;
   - a free join from a socket whose handshake carries that cookie is not pushed, on the main namespace (a Knockout
     queue) and on a game namespace (/ag); a player's is, and so is one from a socket with a forged cookie or one that
     says it is the owner in its join.
   The unit tests (joinAlerts, ownerPushes, ownerSession) cover the paid payer-wallet path and the rules one by one;
   this proves the cookie really reaches the route and the handshakes. */
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const realRequest = http.request;
const realGet = http.get;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

let ipSeq = 0;
const nextIp = () => '10.9.' + (++ipSeq >> 8) + '.' + (ipSeq & 255);
function call(port, method, url, body, headers = {}) {
  const extra = Object.entries(headers).map(([k, v]) => k + ': ' + v + '\r\n').join('');
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    const data = body === undefined ? '' : JSON.stringify(body);
    let out = '';
    s.on('connect', () => s.write(`${method} ${url} HTTP/1.1\r\nHost: localhost\r\nX-Forwarded-For: ${nextIp()}\r\n`
      + 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)\r\nContent-Type: application/json\r\n' + extra
      + `Content-Length: ${Buffer.byteLength(data)}\r\nConnection: close\r\n\r\n${data}`));
    s.on('data', (d) => { out += d; });
    s.on('end', () => resolve({ status: Number(out.split(' ')[1]) }));
    s.on('error', reject);
    s.setTimeout(5000, () => s.destroy(new Error('timeout')));
  });
}

let port;
let OWNER_COOKIE;
const pushes = [];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownerskip-'));
const until = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(25); }
  return fn();
};

test.before(async () => {
  port = await freePort();
  process.env.DEV_LOCAL_PORT = String(port);
  process.env.OWNER_SESSIONS_PATH = path.join(dir, 'owner-sessions.json');
  process.env.OWNER_SESSION_KEY = 'owner-alert-skip-test-key';
  require(path.join(ROOT, 'server', 'notify.js')).pushOwner = (m, o) => pushes.push({ m, o: o || {} });
  const log = console.log; const warn = console.warn;
  console.log = () => {}; console.warn = () => {};
  try {
    require(path.join(ROOT, 'scripts', 'dev-local.js'));
  } finally {
    console.log = log; console.warn = warn;
  }
  const blockedRequest = http.request;
  const local = (a) => a && typeof a === 'object' && ['localhost', '127.0.0.1'].includes(a.hostname || a.host) && Number(a.port) === port;
  http.request = function (...a) { return local(a[0]) ? realRequest.apply(http, a) : blockedRequest.apply(http, a); };
  http.get = function (...a) { return local(a[0]) ? realGet.apply(http, a) : blockedRequest.apply(http, a); };

  /* A live session for the owner wallet dev-local registered, made by the real module with the server's own file and
     key, before the server reads the file (it reads it at the first cookie it sees), so the server holds it. */
  const { createOwnerSessions, CREATE_ACTION } = require(path.join(ROOT, 'server', 'ownerSession.js'));
  const owner = process.env.TEST_OWNER_WALLET;
  const minter = createOwnerSessions({ file: process.env.OWNER_SESSIONS_PATH, production: false,
    isOwner: (w) => w === owner, verifyProof: () => owner, log: { warn() {}, error() {} } });
  const host = 'localhost';
  const ch = minter.challenge({ headers: { host } });
  const res = minter.login({ method: 'POST', body: { action: CREATE_ACTION, args: { nonce: ch.nonce, host } },
    headers: { host, origin: 'http://' + host, 'x-ds-owner': '1', 'content-type': 'application/json',
      cookie: ch.cookie.split(';')[0] } });
  assert.ok(res.ok, JSON.stringify(res));
  OWNER_COOKIE = res.cookie.split(';')[0];
  assert.match(OWNER_COOKIE, /^ds_owner=/);

  for (let i = 0; i < 60; i++) {
    try { if ((await call(port, 'GET', '/api/live')).status === 200) return; } catch (_) {}
    await sleep(250);
  }
  throw new Error('server did not come up');
});

const forged = () => OWNER_COOKIE.slice(0, -4) + (OWNER_COOKIE.endsWith('AAAA') ? 'BBBB' : 'AAAA');
const visits = () => pushes.filter((p) => p.o.title === 'Site visit').map((p) => p.m);

test('a visit with the owner cookie is not pushed; a visitor, a forged cookie, a cross-site one and a body flag are', async () => {
  const before = visits().length;
  const v = (page, headers, body) => call(port, 'POST', '/api/track/visit', Object.assign({ page }, body), headers);
  assert.equal((await v('/owner-own', { Cookie: OWNER_COOKIE, Origin: 'http://localhost', 'Sec-Fetch-Site': 'same-origin' })).status, 200);
  assert.equal((await v('/owner-bare', { Cookie: OWNER_COOKIE })).status, 200);
  await v('/visitor', {});
  await v('/forged', { Cookie: forged() });
  await v('/crosssite', { Cookie: OWNER_COOKIE, 'Sec-Fetch-Site': 'cross-site' });
  await v('/flag', {}, { owner: true, isOwner: true });
  const got = visits().slice(before);
  assert.deepStrictEqual(got, ['/visitor', '/forged', '/crosssite', '/flag'].map((p) => 'Someone opened your site (' + p + ')'));
});

function connect(ns, cookie) {
  const { io } = require('socket.io-client');
  const extraHeaders = { 'X-Forwarded-For': nextIp() };
  if (cookie) extraHeaders.Cookie = cookie;
  const s = io(`http://127.0.0.1:${port}${ns}`, { transports: ['websocket'], forceNew: true, reconnection: false,
    timeout: 5000, extraHeaders });
  const got = [];
  s.onAny((ev, p) => got.push([ev, p]));
  return new Promise((res, rej) => {
    const bail = setTimeout(() => rej(new Error('socket never connected')), 8000);
    s.on('connect', () => { clearTimeout(bail); res({ s, got, has: (ev) => got.find((g) => g[0] === ev) }); });
    s.on('connect_error', (e) => { clearTimeout(bail); rej(e); });
  });
}
const freeJoins = () => pushes.filter((p) => /^Free join: /.test(p.o.title || '')).map((p) => p.m);

test('free joins: the owner cookie on the handshake mutes his own, main namespace and /ag; others still push', async (t) => {
  const socks = [];
  t.after(() => { for (const c of socks) c.s.disconnect(); });
  const ko = async (name, cookie, extra) => {
    const c = await connect('', cookie);
    socks.push(c);
    c.s.emit('ko:queue', Object.assign({ name, stake: 0 }, extra));
    // queued, or matched at once with the one waiting: either way the join path ran
    assert.ok(await until(() => c.got.some(([ev]) => /^ko:(queued|start|match)/.test(ev))), name + ' queued: ' + JSON.stringify(c.got.map((g) => g[0])));
  };
  const ag = async (name, cookie, extra) => {
    const c = await connect('/ag', cookie);
    socks.push(c);
    c.s.emit('ag:join', Object.assign({ name }, extra));
    assert.ok(await until(() => c.got.some(([ev]) => /^ag:/.test(ev))), name + ' answered');
    assert.ok(!c.has('ag:refused'), name + ' seated: ' + JSON.stringify(c.has('ag:refused')));
  };
  await ko('OwnKo', OWNER_COOKIE);
  await ag('OwnAg', OWNER_COOKIE);
  await ko('PlayerKo');
  await ag('PlayerAg');
  await ko('ForgedKo', forged());
  await ko('FlagKo', null, { owner: true, isOwner: true });
  await until(() => freeJoins().some((m) => m.startsWith('FlagKo ')));
  await sleep(100);
  const names = freeJoins().map((m) => m.split(' ')[0]);
  for (const n of ['PlayerKo', 'PlayerAg', 'ForgedKo', 'FlagKo']) assert.ok(names.includes(n), n + ' pushed: ' + JSON.stringify(names));
  for (const n of ['OwnKo', 'OwnAg']) assert.ok(!names.includes(n), n + ' was not pushed: ' + JSON.stringify(names));
});
