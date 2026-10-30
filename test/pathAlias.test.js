'use strict';
/* The slither path /sl-io/ on ONE engine (server/ioOptions.js; server split spec 6.1, 14.1 #7), as server/index.js
   builds it while the split is off: an express app, socket.io with IO_OPTIONS, then installPathAlias and tagEngine.

   - a long-poll handshake and a WebSocket on /sl-io/ reach the default engine (the /sl namespace's own handler sees
     the socket), and each handshake answer says x-ds-proc: main
   - /socket.io/ is served as before; express routes, a path that only contains /sl-io/ and /sl-io without its slash
     are untouched
   - aliasListener: the same server answers on a second port (127.0.0.1), express and sockets alike; a port still held
     is tried again until it frees, and given up (logged) after its window */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const net = require('net');
const express = require('express');
const { Server } = require('socket.io');
const { io: ioClient } = require('socket.io-client');
const WebSocket = require('ws');
const ioOpts = require('../server/ioOptions');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function get(port, url) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: url, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = () => { const out = []; return { out, log: (...a) => out.push(a.join(' ')), error: (...a) => out.push(a.join(' ')) }; };

let port;
let server;
let io;
const seen = []; // /sl connections the server's handler saw: [transport, auth.cv]

test.before(async () => {
  const app = express();
  app.get('/hello', (req, res) => res.type('text').send('hi ' + req.url));
  app.get('/x/sl-io/y', (req, res) => res.type('text').send('express ' + req.url));
  app.use((req, res) => res.status(404).type('text').send('nope ' + req.url));
  server = http.createServer(app);
  io = new Server(server, Object.assign({}, ioOpts.IO_OPTIONS)); // as server/index.js: a copy
  ioOpts.installPathAlias(server, ioOpts.SL_IO_PATH, '/socket.io/');
  ioOpts.tagEngine(io, 'main');
  io.of('/sl').on('connection', (s) => {
    seen.push([s.conn.transport.name, s.handshake.auth && s.handshake.auth.cv]);
    s.on('echo', (m, ack) => { if (typeof ack === 'function') ack(m); });
  });
  port = await freePort();
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
});

test.after(() => {
  io.close();
  server.close();
});

// A /sl client; resolves { s, ok, err } and answers one echo when it connected.
function open(p, opts) {
  const s = ioClient('http://127.0.0.1:' + p + '/sl', Object.assign({ forceNew: true, reconnection: false, timeout: 5000 }, opts));
  return new Promise((resolve) => {
    const bail = setTimeout(() => resolve({ s, ok: false, err: new Error('no answer') }), 8000);
    s.on('connect', () => {
      s.emit('echo', 'pong', (m) => { clearTimeout(bail); resolve({ s, ok: m === 'pong', transport: s.io.engine.transport.name }); });
    });
    s.on('connect_error', (err) => { clearTimeout(bail); resolve({ s, ok: false, err }); });
  });
}

test('the options are index.js\'s: origins, heartbeat, the 64 KB cap; the path and the keep-alive', () => {
  assert.deepStrictEqual(ioOpts.ALLOWED_ORIGINS, ['https://duelseries.com', 'https://www.duelseries.com',
    'https://eu.duelseries.com', 'http://localhost:3000']);
  assert.deepStrictEqual(ioOpts.IO_OPTIONS, { cors: { origin: ioOpts.ALLOWED_ORIGINS, credentials: true },
    pingInterval: 5000, pingTimeout: 10000, maxHttpBufferSize: 64 * 1024 });
  assert.strictEqual(ioOpts.SL_IO_PATH, '/sl-io/');
  assert.deepStrictEqual(ioOpts.KEEPALIVE, { keepAliveTimeout: 120000, headersTimeout: 121000 });
});

test('a long-poll handshake on /sl-io/ is the default engine\'s, tagged x-ds-proc: main', async () => {
  const r = await get(port, '/sl-io/?EIO=4&transport=polling');
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.startsWith('0{"sid"'), r.body.slice(0, 40));
  assert.strictEqual(r.headers['x-ds-proc'], 'main');
  const d = await get(port, '/socket.io/?EIO=4&transport=polling');
  assert.ok(d.body.startsWith('0{"sid"'), 'the default path as before');
  assert.strictEqual(d.headers['x-ds-proc'], 'main', 'one engine: the same tag on both paths');
});

test('a socket.io client on /sl over /sl-io/ connects (polling then upgrade, and WebSocket alone) and is the /sl handler\'s', async () => {
  const before = seen.length;
  const a = await open(port, { path: '/sl-io/', auth: { cv: 4 } });
  assert.ok(a.ok, 'polling first: ' + (a.err && a.err.message));
  const b = await open(port, { path: '/sl-io/', transports: ['websocket'], auth: { cv: 5 } });
  assert.ok(b.ok, 'websocket: ' + (b.err && b.err.message));
  assert.strictEqual(b.transport, 'websocket');
  const c = await open(port, { auth: { cv: 6 } });
  assert.ok(c.ok, 'the default path still connects');
  assert.deepStrictEqual(seen.slice(before).map((x) => x[1]), [4, 5, 6]);
  for (const x of [a, b, c]) x.s.close();
});

test('a raw WebSocket handshake on /sl-io/ is upgraded by engine.io and carries x-ds-proc', async () => {
  const ws = new WebSocket('ws://127.0.0.1:' + port + '/sl-io/?EIO=4&transport=websocket');
  const got = await new Promise((resolve) => {
    const out = { header: null, first: null };
    ws.on('upgrade', (res) => { out.header = res.headers['x-ds-proc']; });
    ws.on('message', (d) => { out.first = String(d); ws.close(); resolve(out); });
    ws.on('error', (e) => resolve(Object.assign(out, { err: e.message })));
  });
  assert.strictEqual(got.err, undefined);
  assert.strictEqual(got.header, 'main');
  assert.ok(got.first.startsWith('0{"sid"'), got.first);
});

test('express is untouched: its routes, a path that only contains /sl-io/, and /sl-io with no slash', async () => {
  assert.deepStrictEqual(await get(port, '/hello').then((r) => [r.status, r.body]), [200, 'hi /hello']);
  assert.deepStrictEqual(await get(port, '/x/sl-io/y').then((r) => [r.status, r.body]), [200, 'express /x/sl-io/y']);
  const r = await get(port, '/sl-io?EIO=4&transport=polling');
  assert.deepStrictEqual([r.status, r.body], [404, 'nope /sl-io?EIO=4&transport=polling']);
  assert.strictEqual(r.headers['x-ds-proc'], undefined);
});

test('aliasListener: the same server on a second port, 127.0.0.1 only, sockets and express alike', async () => {
  const p2 = await freePort();
  const lg = quiet();
  const alias = ioOpts.aliasListener(server, p2, lg);
  try {
    await new Promise((r) => (alias.listening ? r() : alias.once('listening', r)));
    assert.strictEqual(alias.address().address, '127.0.0.1');
    assert.deepStrictEqual(lg.out, ['[SL-IO] /sl-io/ also served on 127.0.0.1:' + p2]);
    const h = await get(p2, '/sl-io/?EIO=4&transport=polling');
    assert.ok(h.body.startsWith('0{"sid"'));
    assert.strictEqual(h.headers['x-ds-proc'], 'main');
    assert.deepStrictEqual(await get(p2, '/hello').then((r) => r.body), 'hi /hello');
    const before = seen.length;
    const a = await open(p2, { path: '/sl-io/', transports: ['websocket'], auth: { cv: 7 } });
    assert.ok(a.ok, 'a socket through the second port: ' + (a.err && a.err.message));
    assert.deepStrictEqual(seen.slice(before).map((x) => x[1]), [7]);
    a.s.close();
  } finally {
    alias.close();
  }
});

test('aliasListener: a held port is tried again until it frees; held past the window it logs and gives up', async () => {
  const p2 = await freePort();
  const holder = net.createServer();
  await new Promise((r) => holder.listen(p2, '127.0.0.1', r));
  const lg = quiet();
  const alias = ioOpts.aliasListener(server, p2, lg, { everyMs: 50, forMs: 5000 });
  await sleep(180);
  assert.strictEqual(alias.listening, false, 'not while the port is held');
  await new Promise((r) => holder.close(r));
  for (let i = 0; i < 40 && !alias.listening; i++) await sleep(50);
  assert.strictEqual(alias.listening, true, 'bound once it freed');
  alias.close();

  const p3 = await freePort();
  const holder3 = net.createServer();
  await new Promise((r) => holder3.listen(p3, '127.0.0.1', r));
  const lg3 = quiet();
  const gone = ioOpts.aliasListener(server, p3, lg3, { everyMs: 30, forMs: 120 });
  for (let i = 0; i < 40 && !lg3.out.length; i++) await sleep(25);
  assert.strictEqual(gone.listening, false);
  assert.strictEqual(lg3.out.length, 1);
  assert.match(lg3.out[0], new RegExp('^\\[SL-IO\\] the slither path is not served on 127\\.0\\.0\\.1:' + p3 +
    ' \\(.*EADDRINUSE.*\\); nginx falls back to the main port$'));
  await sleep(100);
  assert.strictEqual(lg3.out.length, 1, 'given up: no more tries');
  await new Promise((r) => holder3.close(r));
  gone.close();
});
