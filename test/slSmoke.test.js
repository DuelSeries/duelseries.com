'use strict';
/* The new slither.io free room on the real server/index.js (task T11 done-when; SERVER-DESIGN 19 T11): booted by
   scripts/dev-local.js in this test's own process (every outbound call refused), with SL_ENABLED=1 and the dev
   FIXTURE law table (SL_DEV_LAWS; the real table is refused until Owen approves its last rows and T15 sets the caps).

   - /sl serves public/sl.html composed with the layer tail; every spelling of /sl.html still sends the browser to /sl.
   - A real socket.io client joins /sl over WebSocket and over long-polling (what production runs) and gets init, its
     own snake_add, and the world (food sectors), every bundle decoding with no wire_error.
   - A money field in sl:join is refused: sl:x {t: 'refused', why: 'not-open'}, then the disconnect.
   - The per-address cap (C_SL_PER_IP, 30): the next handshake from that address is refused { why: 'limit' }.
   - Hidden: /api/live lists no sl: row (the board row waits for the Phase 6 swap). */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const W = require(path.join(ROOT, 'shared', 'slWire.js'));
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
      const cache = /\r\ncache-control: ([^\r\n]*)/i.exec(head);
      resolve({ status: Number(out.split(' ')[1]), location: loc ? loc[1] : null, cache: cache ? cache[1] : null,
        body: out.slice(head.length + 4) });
    });
    s.on('error', reject);
    s.setTimeout(5000, () => s.destroy(new Error('timeout')));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let port;
let ownerSecret = null; // dev-local's throwaway owner key (local only), read from its own boot line

test.before(async () => {
  port = await freePort();
  process.env.DEV_LOCAL_PORT = String(port);
  process.env.SL_ENABLED = '1';
  process.env.SL_DEV_LAWS = path.join(__dirname, 'slLawsFixture.js');
  const log = console.log; const warn = console.warn;
  console.log = (...a) => {
    const m = /throwaway owner secret \(bs58, local only\) (\S+)/.exec(a.join(' '));
    if (m) ownerSecret = m[1];
  };
  console.warn = () => {};
  try {
    require(path.join(ROOT, 'scripts', 'dev-local.js'));
  } finally {
    console.log = log; console.warn = warn;
  }
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

// Resolves { s, ok } on connect or connect_error.
function open(opts) {
  const o = opts || {};
  const { io } = require('socket.io-client');
  const s = io(`http://127.0.0.1:${port}/sl`, { transports: [o.transport || 'websocket'], forceNew: true,
    reconnection: false, timeout: 5000, extraHeaders: o.xff ? { 'x-forwarded-for': o.xff } : {}, auth: o.auth });
  return new Promise((resolve) => {
    const bail = setTimeout(() => resolve({ s, ok: false, err: new Error('no answer') }), 8000);
    s.on('connect', () => { clearTimeout(bail); resolve({ s, ok: true }); });
    s.on('connect_error', (err) => { clearTimeout(bail); resolve({ s, ok: false, err }); });
  });
}

// Joins and collects decoded events until `done(events)` or the time runs out.
async function joinAndCollect(transport, xff) {
  const c = await open({ transport, xff, auth: { cv: 7 } });
  assert.ok(c.ok, transport + ' connected: ' + (c.err && c.err.message));
  const events = [];
  let bundles = 0;
  const finished = new Promise((resolve) => {
    const t = setTimeout(resolve, 6000);
    c.s.on('sl:f', (data) => {
      bundles++;
      const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
      for (const ev of W.decodeBundle(u8)) events.push(ev);
      if (bundles >= 2 && events.some((e) => e.type === 'snake_move' && e.own)) { clearTimeout(t); resolve(); }
    });
  });
  c.s.emit('sl:join', { nick: 'smoke ' + transport });
  await finished;
  c.s.close();
  return { events, bundles };
}

function checkJoin(r, transport) {
  assert.ok(r.bundles >= 2, transport + ': bundles keep arriving after the join (' + r.bundles + ')');
  assert.strictEqual(r.events.filter((e) => e.type === 'wire_error').length, 0, transport + ': no wire_error');
  assert.strictEqual(r.events[0].type, 'init', transport + ': the first event is init');
  const own = r.events[1];
  assert.strictEqual(own.type, 'snake_add', transport + ': then the own snake');
  assert.strictEqual(own.nick, 'smoke ' + transport, transport + ': with the name as sent');
  assert.strictEqual(own.cv, 7, transport + ': with the skin from the handshake');
  const food = r.events.filter((e) => e.type === 'food_sector').length;
  assert.ok(food > 0, transport + ': the world arrives (' + food + ' food sectors)');
  assert.ok(r.events.some((e) => e.type === 'snake_move' && e.own), transport + ': the own snake moves');
}

test('/sl serves the client page composed with the layer tail; /sl.html sends the browser to /sl', async () => {
  const { composePage } = require(path.join(ROOT, 'server', 'sl', 'slBoot.js'));
  const html = fs.readFileSync(path.join(ROOT, 'public', 'sl.html'), 'utf8');
  const r = await get(port, '/sl');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.cache, 'no-store');
  assert.strictEqual(r.body, composePage(html), 'the composed page, byte for byte');
  assert.ok(r.body.indexOf('/js/sl/slMain.js') < r.body.indexOf('</body>'), 'the frozen scripts are all there');
  for (const p of ['/sl.html', '/./sl.html', '/SL.html']) {
    const x = await get(port, p);
    assert.strictEqual(x.status, 302, p);
    assert.strictEqual(x.location, '/sl', p);
  }
});

test('a socket.io client joins /sl over WebSocket: init, own snake_add, the world', async () => {
  checkJoin(await joinAndCollect('websocket', '10.77.0.1'), 'websocket');
});

test('a socket.io client joins /sl over long-polling (production): init, own snake_add, the world', async () => {
  checkJoin(await joinAndCollect('polling', '10.77.0.2'), 'polling');
});

test('a money field in sl:join is refused (not-open), then the socket is disconnected', async () => {
  const c = await open({ xff: '10.77.0.3' });
  assert.ok(c.ok);
  const got = await new Promise((resolve) => {
    const out = { x: null, closed: false, frames: 0 };
    const t = setTimeout(() => resolve(out), 4000);
    c.s.on('sl:x', (m) => { out.x = m; });
    c.s.on('sl:f', () => { out.frames++; });
    c.s.on('disconnect', () => { out.closed = true; clearTimeout(t); resolve(out); });
    c.s.emit('sl:join', { nick: 'cash', entryToken: 'abc' });
  });
  assert.deepStrictEqual(got.x, [{ t: 'refused', why: 'not-open' }]);
  assert.strictEqual(got.closed, true, 'then disconnected');
  assert.strictEqual(got.frames, 0, 'never seated');
});

test('per address: C_SL_PER_IP sockets, then the handshake is refused { why: limit }', async () => {
  const { LAWS } = require(path.join(ROOT, 'server', 'sl', 'slLaws.js'));
  const cap = LAWS.C_SL_PER_IP.value;
  assert.strictEqual(cap, 30);
  const mine = [];
  try {
    for (let i = 0; i < cap; i++) {
      const c = await open({ xff: '10.77.1.1' });
      mine.push(c.s);
      assert.ok(c.ok, 'socket ' + i);
    }
    const over = await open({ xff: '10.77.1.1' });
    mine.push(over.s);
    assert.strictEqual(over.ok, false);
    assert.deepStrictEqual(over.err.data, { why: 'limit' });
    const other = await open({ xff: '10.77.1.2' });
    mine.push(other.s);
    assert.ok(other.ok, 'another address is not affected');
  } finally {
    for (const s of mine) s.close();
  }
});

test('hidden: /api/live lists no sl: row (the board row waits for the Phase 6 swap)', async () => {
  const r = await get(port, '/api/live');
  const j = JSON.parse(r.body);
  assert.ok(Array.isArray(j.lobbies));
  assert.strictEqual(j.lobbies.filter((x) => String(x.id).startsWith('sl:')).length, 0);
});

// ─── The owner console (SERVER-DESIGN 13 items 4, 5) ──────────────────────────────────────────────────────────────

function ownerDo(action, args) {
  const { ed25519 } = require('@noble/curves/ed25519');
  const b = require('bs58');
  const bs58 = b && b.default ? b.default : b;
  const { actionMessage } = require(path.join(ROOT, 'server', 'ownerAuth.js'));
  const key = bs58.decode(ownerSecret);
  const wallet = bs58.encode(ed25519.getPublicKey(key));
  const ts = Date.now();
  const sig = bs58.encode(ed25519.sign(new TextEncoder().encode(actionMessage(action, args, wallet, ts)), key));
  const body = JSON.stringify({ action, args, wallet, ts, sig });
  return new Promise((resolve, reject) => {
    const req = realRequest({ hostname: '127.0.0.1', port, path: '/api/owner/do', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let out = '';
      res.on('data', (d) => { out += d; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(out) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// One socket: connect, optionally join, and report what came back within ms.
async function tryJoin(xff, ms) {
  const c = await open({ xff });
  assert.ok(c.ok);
  const out = { x: [], frames: 0, closed: false, maintenance: null, announce: null };
  c.s.on('sl:x', (m) => { out.x.push(...m); });
  c.s.on('sl:f', () => { out.frames++; });
  c.s.on('disconnect', () => { out.closed = true; });
  c.s.emit('sl:join', { nick: 'console' });
  await sleep(ms || 400);
  c.s.close();
  return out;
}

test('owner console: the room is listed by name, the door closes and reopens it, bots by hand, maintenance and announce reach /sl', async () => {
  assert.ok(ownerSecret, 'dev-local printed its throwaway owner key');
  const st = await ownerDo('maintenance:check', {});
  assert.strictEqual(st.status, 200, JSON.stringify(st.json).slice(0, 200));
  const row = st.json.state.rooms.find((r) => r.id === 'sl_na_s0');
  assert.ok(row, 'the console lists the room');
  assert.strictEqual(row.label, 'slither.io (new) · Free');
  assert.strictEqual(row.game, 'slither.io (new)');
  assert.strictEqual(row.takesBots, true);

  const off = await ownerDo('sl:door:off', {});
  assert.strictEqual(off.status, 200);
  assert.match(off.json.note, /until the next restart/);
  const refused = await tryJoin('10.78.0.1');
  assert.deepStrictEqual(refused.x, [{ t: 'refused', why: 'closed' }]);
  assert.strictEqual(refused.closed, true);
  assert.strictEqual(refused.frames, 0);
  assert.strictEqual((await ownerDo('sl:door:on', {})).status, 200);
  const back = await tryJoin('10.78.0.2');
  assert.ok(back.frames > 0, 'open again, no restart');

  // Bots by hand reach the room through the console. Under a loaded test run the bot governor may be engaged
  // (event-loop p99 over C_GOV.loopP99Ms), and then addBot refuses by design and the console says so (409).
  const add = await ownerDo('bots:add', { room: 'sl_na_s0', count: 2 });
  const byHand = add.status === 200 ? 2 : 0;
  if (add.status === 200) assert.match(add.json.note, /Added 2 bot\(s\) to sl_na_s0/);
  else assert.strictEqual(add.json.error, 'That room would not take any bots', JSON.stringify(add.json).slice(0, 200));
  const clr = await ownerDo('bots:clear', { room: 'sl_na_s0' });
  assert.strictEqual(clr.status, 200);
  const removed = /Removed (\d+) bot\(s\) from sl_na_s0/.exec(clr.json.note);
  assert.ok(removed && Number(removed[1]) >= byHand, 'the bots by hand and any the daily curve added: ' + clr.json.note);

  const c = await open({ xff: '10.78.0.3' });
  const got = { maintenance: null, announce: null };
  c.s.on('maintenance', (m) => { got.maintenance = m; });
  c.s.on('announce', (m) => { got.announce = m; });
  await sleep(100);
  assert.strictEqual((await ownerDo('maintenance:on', { message: 'back soon' })).status, 200);
  try {
    const m = await tryJoin('10.78.0.4');
    assert.deepStrictEqual(m.x, [{ t: 'refused', why: 'maintenance' }]);
    assert.strictEqual((await ownerDo('announce', { text: 'hello' })).status, 200);
    await sleep(200);
    assert.ok(got.maintenance && got.maintenance.maintenance === true, 'maintenance reached /sl');
    assert.strictEqual(got.announce && got.announce.text, 'hello', 'announce reached /sl');
  } finally {
    await ownerDo('maintenance:off', {});
    c.s.close();
  }
});
