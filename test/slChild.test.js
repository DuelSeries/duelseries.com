'use strict';
/* The slither process itself (server/split/slChild.js; server split spec 8.1 and 14.1 #5), forked by this test as its
   main server would fork it: the IPC channel, a port of its own, DS_SPLIT_DEBUG=1, the dev fixture law table.

   - hello, then init, then ready and a snapshot every second that the envelope accepts (no money field)
   - a real socket.io client on /sl over the page's path /sl-io/: refused 'maintenance' while init says so, seated
     once an emit clears it, refused again when a load message turns it back on; a battle royale join is seated in the
     arena; a paid handshake (paid 1) and a paid watcher (any watchStake) are refused 'closed' at connect, before any
     join, so an entry token is never read here; ds:ping is answered; the default namespace is refused
   - owner commands: bots:set and br:start reply with the room's own answer and a snapshot; br:stop with no match says so
   - the require graph excludes every money, database, push, analytics, owner-session and express module, and the
     active resources at idle are its server, its channel and its sockets only
   - GET /healthz answers ok and nothing else is served there; the handshake says x-ds-proc: sl
   - it exits within 1 s of the channel closing (its main server died), and says goodbye on a shutdown */
const test = require('node:test');
const assert = require('node:assert');
const { fork } = require('child_process');
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const env = require('../server/split/ipcEnvelope');

const ROOT = path.join(__dirname, '..');
const CHILD = path.join(ROOT, 'server', 'split', 'slChild.js');
const W = require(path.join(ROOT, 'shared', 'slWire.js'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function until(fn, ms) {
  const end = Date.now() + (ms || 10000);
  for (;;) {
    const v = await fn();
    if (v || Date.now() >= end) return v;
    await sleep(50);
  }
}

function httpGet(port, p) {
  return new Promise((resolve, reject) => {
    const r = http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    r.on('error', reject);
    r.setTimeout(4000, () => r.destroy(new Error('timeout')));
  });
}

// The real child, forked as slLink forks it. -> { c, port, msgs, out, send, next(t), call(op, args) }
async function startChild(extraEnv) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slchild-'));
  const e = Object.assign({}, process.env, { SL_ENABLED: '1', SL_DEV_LAWS: path.join(__dirname, 'slLawsFixture.js'),
    SL_CHILD_PORT: String(port), DS_SPLIT_DEBUG: '1', ESCROW_PRIVATE_KEY: '', DATABASE_URL: '', NODE_ENV: 'test' },
  extraEnv || {});
  const c = fork(CHILD, [], { env: e, execArgv: ['--max-old-space-size=192'], serialization: 'json',
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const out = { text: '' };
  c.stdout.on('data', (d) => { out.text += d; });
  c.stderr.on('data', (d) => { out.text += d; });
  const msgs = [];
  c.on('message', (m) => msgs.push(m));
  let id = 0;
  const h = {
    c, port, msgs, out, dir,
    send: (m) => c.send(Object.assign({ v: 1 }, m)),
    next: (t, after) => until(() => msgs.slice(after || 0).find((m) => m.t === t), 15000),
    async call(op, args) {
      const re = ++id;
      h.send({ t: 'cmd', id: re, op, args: args || {} });
      return until(() => msgs.find((m) => m.t === 'reply' && m.re === re), 10000);
    },
  };
  return h;
}

function initMsg(h, o) {
  return Object.assign({ t: 'init', region: 'na', owners: ['OWNERWALLET1111111111111111111111111111111'],
    ops: { maintenance: true, message: 'closed for a test' }, smooth: true, door: true, brOnNew: true,
    podiumFile: path.join(h.dir, 'br-last-podium.json'), botsPauseMs: 900000,
    load: { paidPlayers: 0, extraSliceMs: 0, maintenance: true } }, o || {});
}

function client(port, auth) {
  const { io } = require('socket.io-client');
  const s = io(`http://127.0.0.1:${port}/sl`, { path: '/sl-io/', transports: ['websocket'], forceNew: true,
    reconnection: false, timeout: 5000, auth });
  const c = { s, items: [], frames: 0, events: [], gone: null, connected: false };
  s.on('sl:x', (list) => { for (const it of Array.isArray(list) ? list : []) c.items.push(it); });
  s.on('sl:f', (data) => {
    c.frames++;
    try { for (const ev of W.decodeBundle(data instanceof Uint8Array ? data : new Uint8Array(data))) c.events.push(ev); } catch (_) {}
  });
  s.on('disconnect', (why) => { c.gone = String(why); });
  c.ready = new Promise((resolve) => {
    s.on('connect', () => { c.connected = true; resolve(true); });
    s.on('connect_error', (err) => resolve(err));
  });
  return c;
}

const refusedWhy = (c) => (c.items.find((x) => x.t === 'refused') || {}).why;

let H = null;
test.after(() => { if (H && H.c.exitCode === null) H.c.kill('SIGKILL'); });

test('hello, init, ready, then a snapshot every second that the envelope accepts', { timeout: 60000 }, async () => {
  H = await startChild();
  const hello = await H.next('hello');
  assert.ok(hello, 'hello\n' + H.out.text);
  assert.deepStrictEqual(env.check('toMain', hello), { ok: true, why: '' });
  assert.match(hello.boot, /^[0-9a-f-]{36}$/);
  assert.strictEqual(hello.pid, H.c.pid);
  H.send(initMsg(H));
  const ready = await H.next('ready');
  assert.ok(ready, 'ready\n' + H.out.text);
  assert.deepStrictEqual([ready.boot, ready.port, ready.dev], [hello.boot, H.port, true]);
  const first = await H.next('snap');
  assert.ok(first);
  await sleep(2200);
  const snaps = H.msgs.filter((m) => m.t === 'snap');
  assert.ok(snaps.length >= 3, 'about one a second: ' + snaps.length);
  for (const s of snaps) assert.deepStrictEqual(env.check('toMain', s), { ok: true, why: '' });
  const seqs = snaps.map((s) => s.seq);
  assert.deepStrictEqual(seqs, seqs.slice().sort((a, b) => a - b), 'seq rises');
  const s = snaps[snaps.length - 1];
  assert.strictEqual(s.boot, hello.boot);
  assert.deepStrictEqual(s.rooms.map((r) => [r.lobbyType, r.kind]), [['sl_na_s0', 'free'], ['sl_na_br', 'br']]);
  assert.strictEqual(s.door, true);
  assert.strictEqual(s.free.live, true);
  assert.deepStrictEqual(s.free.rows.map((r) => [r.id, r.stake]), [['sl:na:s0', 0]]);
  assert.strictEqual(s.br.match.state, 'waiting');
  assert.strictEqual(s.br.decided, null);
  assert.strictEqual(typeof s.proc.rssMb, 'number');
  assert.ok(!/"(worth|money|liveStakeTotal|floorWorth|entryToken|balance)"/.test(JSON.stringify(s)), 'no money field');
});

test('/sl over /sl-io/: maintenance refuses until an emit clears it, a load turns it back; paid handshakes refused closed', { timeout: 60000 }, async () => {
  assert.ok(H, 'the child is up');
  const proc = await httpGet(H.port, '/sl-io/?EIO=4&transport=polling');
  assert.strictEqual(proc.status, 200);
  assert.strictEqual(proc.headers['x-ds-proc'], 'sl');
  assert.match(proc.body, /^0\{"sid"/);
  assert.deepStrictEqual([(await httpGet(H.port, '/healthz')).status, (await httpGet(H.port, '/healthz')).body], [200, 'ok']);
  assert.strictEqual((await httpGet(H.port, '/')).status, 404);
  assert.strictEqual((await httpGet(H.port, '/socket.io/?EIO=4&transport=polling')).status, 404, 'only /sl-io/');

  // maintenance from init: refused
  const m1 = client(H.port, { cv: 3 });
  assert.strictEqual(await m1.ready, true);
  m1.s.emit('sl:join', { nick: 'early' });
  await until(() => refusedWhy(m1), 5000);
  assert.strictEqual(refusedWhy(m1), 'maintenance');
  m1.s.close();

  // the main server opens it (emitMaintenance): seated, frames flow
  H.send({ t: 'emit', ev: 'maintenance', data: { maintenance: false, message: '' } });
  const a = client(H.port, { cv: 3 });
  assert.strictEqual(await a.ready, true);
  const got = new Promise((resolve) => a.s.on('maintenance', resolve));
  a.s.emit('sl:join', { nick: 'freeone' });
  await until(() => a.events.some((e) => e.type === 'snake_add' && e.nick === 'freeone'), 8000);
  assert.ok(a.events.some((e) => e.type === 'snake_add' && e.nick === 'freeone'), 'seated: ' + JSON.stringify(a.items));
  assert.ok(a.frames >= 1);
  // the emit reaches every /sl socket here
  H.send({ t: 'emit', ev: 'maintenance', data: { maintenance: false, message: 'still open' } });
  assert.deepStrictEqual(await Promise.race([got, sleep(3000)]), { maintenance: false, message: 'still open' });
  // ds:ping (the readout every game shows)
  const pong = await Promise.race([new Promise((resolve) => a.s.emit('ds:ping', () => resolve('pong'))), sleep(3000)]);
  assert.strictEqual(pong, 'pong');

  // load turns maintenance back on: the next join is refused
  H.send({ t: 'load', paidPlayers: 1, extraSliceMs: 0, maintenance: true });
  await sleep(100);
  const b = client(H.port, { cv: 3 });
  assert.strictEqual(await b.ready, true);
  b.s.emit('sl:join', { nick: 'late' });
  await until(() => refusedWhy(b), 5000);
  assert.strictEqual(refusedWhy(b), 'maintenance');
  b.s.close();
  H.send({ t: 'load', paidPlayers: 0, extraSliceMs: 0, maintenance: false });
  await sleep(100);

  // the battle royale: seated in the arena
  const br = client(H.port, { br: 1, cv: 2 });
  assert.strictEqual(await br.ready, true);
  br.s.emit('sl:join', { nick: 'brone' });
  await until(() => br.events.some((e) => e.type === 'snake_add' && e.nick === 'brone'), 8000);
  assert.ok(br.events.some((e) => e.type === 'snake_add' && e.nick === 'brone'), 'BR seated: ' + JSON.stringify(br.items.slice(-3)));
  assert.ok(br.items.some((x) => x.t === 'br'), 'the arena\'s state');
  const after = await until(() => {
    const s = H.msgs.filter((m) => m.t === 'snap').pop();
    return s && s.br.humans >= 1 && s.free.humans >= 1 ? s : null;
  }, 4000);
  assert.ok(after, 'the snapshot counts both seats');
  const joins = H.msgs.filter((m) => m.t === 'join');
  assert.deepStrictEqual(joins.map((j) => [j.name, j.where]), [['freeone', 'free'], ['brone', 'br']]);
  for (const j of joins) assert.deepStrictEqual(Object.keys(j.h).filter((k) => !['host', 'origin', 'sec-fetch-site', 'cookie'].includes(k)), []);

  // a paid seat and paid watchers belong to the main server: refused closed at connect, the token never read
  for (const auth of [{ paid: 1, stake: 0.5, entryToken: 'tok' }, { watch: 1, watchStake: 0.5 }, { watch: 1, watchStake: 0 },
    { br: 1, watch: 1, watchStake: 1 }]) {
    const p = client(H.port, auth);
    await p.ready;
    await until(() => p.gone || refusedWhy(p), 5000);
    assert.strictEqual(refusedWhy(p), 'closed', JSON.stringify(auth));
    await until(() => p.gone, 3000);
    assert.ok(p.gone, 'and disconnected: ' + JSON.stringify(auth));
    p.s.close();
  }
  // the default namespace is not served here
  const { io } = require('socket.io-client');
  const root = io(`http://127.0.0.1:${H.port}/`, { path: '/sl-io/', transports: ['websocket'], forceNew: true, reconnection: false });
  const rootAns = await new Promise((resolve) => { root.on('connect', () => resolve('connected')); root.on('connect_error', (e) => resolve(e.message)); });
  assert.strictEqual(rootAns, 'no');
  root.close();
  a.s.close();
  br.s.close();
});

test('owner commands: bots:set, br:start and br:stop answer with the room\'s own words and a snapshot', { timeout: 60000 }, async () => {
  assert.ok(H);
  const set = await H.call('bots:set', { room: 'sl_na_s0', count: 4 });
  assert.ok(set, 'a reply');
  assert.strictEqual(set.ok, true, JSON.stringify(set));
  assert.strictEqual(set.result.held, 4);
  assert.deepStrictEqual(env.check('toMain', set), { ok: true, why: '' });
  assert.ok(set.snap && set.snap.t === 'snap', 'a snapshot rides on the reply');
  assert.strictEqual(set.snap.rooms.find((r) => r.lobbyType === 'sl_na_s0').botTarget, 4);
  const none = await H.call('bots:set', { room: 'sl_na_s9', count: 4 });
  assert.deepStrictEqual([none.ok, none.why], [false, 'No room called sl_na_s9']);
  const stop = await H.call('br:stop', {});
  assert.deepStrictEqual([stop.ok, stop.why], [false, 'No match is running']);
  // the arena fills with bots from boot (brOnNew), so after a few seconds it can start
  const canStart = await until(() => {
    const s = H.msgs.filter((m) => m.t === 'snap').pop();
    return s && s.br.match.canStart;
  }, 10000);
  const start = await H.call('br:start', { force: false });
  assert.ok(start);
  assert.ok(canStart, 'the arena filled with bots');
  assert.strictEqual(start.ok, true, JSON.stringify([start.note, start.why]));
  assert.match(start.note, /^Started with \d+ player\(s\) and \d+ bot\(s\)$/);
  assert.strictEqual(start.snap.br.match.state, 'countdown');
  // the slot timer's start, decided on a snapshot a second old: checked again here, never a second match
  const slot = await H.call('br:autoStart', { why: 'auto 14:00 ET' });
  assert.deepStrictEqual([slot.ok, slot.why, slot.snap.br.match.state], [false, 'state changed', 'countdown']);
  assert.ok(await until(() => /slot start not made: the arena is countdown/.test(H.out.text), 3000), 'logged');
  const again = await H.call('br:start', { force: false });
  assert.deepStrictEqual([again.ok, again.why], [false, 'A match is already running. You can start the next one once a single snake is left.']);
  const stopped = await H.call('br:stop', {});
  assert.deepStrictEqual([stopped.ok, stopped.note], [true, 'Match stopped, no prize paid']);
  assert.strictEqual(stopped.snap.br.match.state, 'waiting');
  const door = await H.call('door', { open: false });
  assert.deepStrictEqual([door.ok, door.result.door, door.snap.door, door.snap.free.live], [true, false, false, false]);
  await H.call('door', { open: true });
  // a command the child does not know never runs (the envelope refuses it first)
  const before = H.msgs.length;
  H.send({ t: 'cmd', id: 999, op: 'eval', args: {} });
  await sleep(300);
  assert.ok(!H.msgs.slice(before).some((m) => m.t === 'reply' && m.re === 999));
});

const NOT_HERE = ['server/money.js', 'server/Usdc.js', 'server/Wallet.js', 'server/db.js', 'server/notify.js',
  'server/rpcDay.js', 'server/rpcBudget.js', 'server/prices.js', 'server/solPrice.js', 'server/analytics.js',
  'server/ownerSession.js', 'server/botBank.js', 'server/botWallet.js', 'server/ag/agJournal.js', 'server/entryStore.js',
  'server/stakeLedger.js', 'server/index.js'];
const NO_PACKAGE = ['pg', 'express', '@solana/web3.js', '@privy-io/server-auth', 'dotenv'];

test('the require graph holds no money, database, push, analytics, owner session or express; idle resources are few', { timeout: 30000 }, async () => {
  assert.ok(H);
  const r = await H.call('debug.modules', {});
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const mods = r.result.modules.map((m) => m.replace(/\\/g, '/'));
  assert.ok(mods.some((m) => m.endsWith('server/split/slChild.js')), 'the list is real');
  assert.ok(mods.some((m) => m.endsWith('server/sl/slRoom.js')));
  for (const f of NOT_HERE) {
    const hit = mods.filter((m) => m.endsWith('/' + f));
    assert.deepStrictEqual(hit, [], f + ' is not loaded');
  }
  for (const p of NO_PACKAGE) {
    const hit = mods.filter((m) => m.includes('/node_modules/' + p + '/'));
    assert.deepStrictEqual(hit, [], p + ' is not loaded');
  }
  // the resources keeping it alive: its server and channel (and the sockets of this test's clients), and timers
  // only as handles: every sl timer is unref'd and the room ticks are timers too
  const kinds = r.result.resources;
  const allowed = ['PipeWrap', 'TCPServerWrap', 'TCPSocketWrap', 'TCPWRAP', 'TCPWrap', 'TTYWrap', 'Timeout', 'Immediate',
    'FSReqCallback', 'ProcessWrap'];
  assert.deepStrictEqual(kinds.filter((k) => !allowed.includes(k)), [], JSON.stringify(kinds));
  assert.ok(kinds.includes('PipeWrap'), 'the IPC channel');
  assert.ok(kinds.includes('TCPServerWrap'), 'its listener');
  assert.ok(kinds.filter((k) => k === 'Timeout').length <= 8, 'a few timers: ' + JSON.stringify(kinds));
  // off without DS_SPLIT_DEBUG
  const plain = await startChild({ DS_SPLIT_DEBUG: '' });
  await plain.next('hello');
  plain.send(initMsg(plain));
  await plain.next('ready');
  const off = await plain.call('debug.modules', {});
  assert.deepStrictEqual([off.ok, off.why], [false, 'off']);
  plain.c.kill('SIGKILL');
});

test('a shutdown says goodbye and exits 0; the channel closing (main died) ends it within 1 s', { timeout: 60000 }, async () => {
  assert.ok(H);
  const t0 = Date.now();
  const gone = new Promise((resolve) => H.c.once('exit', (code) => resolve(code)));
  H.c.disconnect();
  const code = await Promise.race([gone, sleep(3000).then(() => 'still running')]);
  assert.strictEqual(code, 0);
  assert.ok(Date.now() - t0 < 1000, 'within 1 s: ' + (Date.now() - t0) + ' ms');

  const g = await startChild();
  await g.next('hello');
  g.send(initMsg(g));
  await g.next('ready');
  const exited = new Promise((resolve) => g.c.once('exit', (c) => resolve(c)));
  g.send({ t: 'shutdown', why: 'test' });
  const bye = await g.next('bye');
  assert.deepStrictEqual([bye && bye.t, bye && bye.why], ['bye', 'shutdown']);
  assert.strictEqual(await Promise.race([exited, sleep(3000).then(() => 'still running')]), 0);

  // no init within 10 s: it exits 1 (the main server backs off and forks another)
  const n = await startChild();
  await n.next('hello');
  const noInit = await Promise.race([new Promise((resolve) => n.c.once('exit', resolve)), sleep(14000).then(() => 'still running')]);
  assert.strictEqual(noInit, 1);
  assert.match(n.out.text, /no init from the main server within 10 s/);
});
