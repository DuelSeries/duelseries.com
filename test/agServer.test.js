'use strict';
/* The new agar.io game on the real server/index.js (booted by scripts/dev-local.js in this test's own process,
   every outbound call refused), opened with AG_ENABLED=1 and the dev FIXTURE law table (AG_DEV_LAWS).

   Review 2026-10-02:
   - finding 4: public/ag.html is never handed out as a static file at /ag.html; /ag.html sends the browser to
     /ag, which is the only route that serves the page (503 while the game is closed).
   - finding 1/5: the per-address connection cap holds on real socket.io sockets on the /ag namespace: past it a
     handshake is refused by the namespace middleware (connect_error, why 'limit'), other addresses are not
     affected, and a closed socket gives its place back. */
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

function get(port, url) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    let out = '';
    s.on('connect', () => s.write(`GET ${url} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`));
    s.on('data', (d) => { out += d; });
    s.on('end', () => {
      const head = out.split('\r\n\r\n')[0];
      const loc = /\r\nlocation: ([^\r\n]*)/i.exec(head);
      resolve({ status: Number(out.split(' ')[1]), location: loc ? loc[1] : null, body: out.slice(head.length + 4) });
    });
    s.on('error', reject);
    s.setTimeout(5000, () => s.destroy(new Error('timeout')));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let port;

test.before(async () => {
  port = await freePort();
  process.env.DEV_LOCAL_PORT = String(port);
  process.env.AG_ENABLED = '1';
  process.env.AG_DEV_LAWS = path.join(__dirname, 'agLawsFixture.js');
  const log = console.log; const warn = console.warn;
  console.log = () => {}; console.warn = () => {};
  try {
    require(path.join(ROOT, 'scripts', 'dev-local.js'));
  } finally {
    console.log = log; console.warn = warn;
  }
  // dev-local refuses every outbound call; this test's own sockets to the local server go through.
  const blockedRequest = http.request;
  const blockedGet = http.get;
  const local = (a) => a && typeof a === 'object' && ['localhost', '127.0.0.1'].includes(a.hostname || a.host) &&
    Number(a.port) === port;
  http.request = function (...a) { return local(a[0]) ? realRequest.apply(http, a) : blockedRequest.apply(http, a); };
  http.get = function (...a) { return local(a[0]) ? realGet.apply(http, a) : blockedGet.apply(http, a); };
  for (let i = 0; i < 60; i++) {
    try { const r = await get(port, '/api/live'); if (r.status === 200) return; } catch (_) {}
    await sleep(250);
  }
  throw new Error('server did not come up');
});

// Resolves { s, ok: true } on connect, { s, ok: false, err } on connect_error.
function open(xff) {
  const { io } = require('socket.io-client');
  const s = io(`http://127.0.0.1:${port}/ag`, { transports: ['websocket'], forceNew: true, reconnection: false,
    timeout: 5000, extraHeaders: { 'x-forwarded-for': xff } });
  return new Promise((resolve) => {
    const bail = setTimeout(() => resolve({ s, ok: false, err: new Error('no answer') }), 8000);
    s.on('connect', () => { clearTimeout(bail); resolve({ s, ok: true }); });
    s.on('connect_error', (err) => { clearTimeout(bail); resolve({ s, ok: false, err }); });
  });
}

test('/ag.html is not served as a static page: it sends the browser to /ag', async () => {
  const r = await get(port, '/ag.html');
  assert.strictEqual(r.status, 302);
  assert.strictEqual(r.location, '/ag');
  assert.doesNotMatch(r.body, /<canvas/);
  const page = await get(port, '/ag');
  assert.strictEqual(page.status, 200, 'open on the dev table: /ag serves the page');
  assert.match(page.body, /<canvas id="canvas"/);
});

test('real sockets on /ag: the per-address cap refuses the handshake past it, and a closed socket frees its place', async () => {
  const { AG_CONN } = require(path.join(ROOT, 'server', 'ag', 'agSockets.js'));
  const cap = AG_CONN.PER_IP.value;
  const mine = [];
  try {
    for (let i = 0; i < cap; i++) {
      const c = await open('10.66.0.1');
      mine.push(c.s);
      assert.ok(c.ok, 'socket ' + i + ' connected: ' + (c.err && c.err.message));
    }
    // A seated socket is sent world updates before it plays.
    const got = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 3000);
      mine[0].once('ag:f', () => { clearTimeout(t); resolve(true); });
    });
    assert.ok(got, 'a bundle arrived on ag:f');
    const over = await open('10.66.0.1');
    mine.push(over.s);
    assert.strictEqual(over.ok, false, 'the next socket from that address is refused');
    assert.deepStrictEqual(over.err.data, { why: 'limit' });
    const other = await open('10.66.0.2');
    mine.push(other.s);
    assert.ok(other.ok, 'another address is not affected');
    // One closes; once the server has seen it, the address has a place again.
    mine[0].close();
    let back = null;
    for (let i = 0; i < 40 && !(back && back.ok); i++) {
      await sleep(50);
      if (back) back.s.close();
      back = await open('10.66.0.1');
    }
    mine.push(back.s);
    assert.ok(back.ok, 'a closed socket gave its place back');
  } finally {
    for (const s of mine) s.close();
  }
});
