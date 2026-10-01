'use strict';
/* Watching is for a socket with no seat (review finding on afc824c, both games).

   spectate:join and spectate:join:agar repoint the socket's room, and disconnect only clears the
   room the socket points at. So a player who sent a spectate stayed seated in the room they had
   been playing in, unsteered, for good: measured before the fix, four free agar players who each
   spectated and left were still four players in agar_na_free, and four snake players likewise in
   the free snake room. In a paid snake room that ghost holds its worth and keeps the room's
   /api/live row above 0 players, which is the row the no-push-while-paid rule reads.

   This boots the REAL server as a child process (scripts/dev-local.js: in-memory database, every
   outbound call refused) and checks, through /api/live, that a seated socket's spectate is refused
   and its seat goes when it leaves, and that a watcher who switches rooms stops being sent the
   room it left. */
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(40); }
  return fn();
};

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

let port, srv, out = '';
const live = () => new Promise((resolve) => {
  const q = http.get({ host: '127.0.0.1', port, path: '/api/live' }, (r) => {
    let d = ''; r.on('data', (c) => { d += c; });
    r.on('end', () => { try { resolve(JSON.parse(d)); } catch (_) { resolve(null); } });
  });
  q.on('error', () => resolve(null));
  q.setTimeout(4000, () => { q.destroy(); resolve(null); });
});

test.before(async () => {
  port = await freePort();
  srv = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dev-local.js')], {
    cwd: ROOT, env: { ...process.env, DEV_LOCAL_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', (d) => { out += d; });
  srv.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 160; i++) {
    if (srv.exitCode !== null) throw new Error('server exited:\n' + out.slice(-2000));
    if (await live()) return;
    await sleep(250);
  }
  throw new Error('server did not come up');
});
test.after(() => { if (srv && srv.exitCode === null) srv.kill(); });

function connect() {
  const { io } = require('socket.io-client');
  const s = io(`http://127.0.0.1:${port}`, { transports: ['websocket'], forceNew: true, reconnection: false, timeout: 5000 });
  const got = [];
  s.onAny((ev, p) => got.push([ev, p]));
  return new Promise((res, rej) => {
    const bail = setTimeout(() => rej(new Error('socket never connected')), 8000);
    s.on('connect', () => {
      clearTimeout(bail);
      res({ s, got, has: (ev, f) => got.find((g) => g[0] === ev && (!f || f(g[1]))), count: (ev) => got.filter((g) => g[0] === ev).length });
    });
    s.on('connect_error', (e) => { clearTimeout(bail); rej(e); });
  });
}
// Messages on one socket are handled in order, so an answered ping means everything sent before it was handled.
function handled(s) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 5000);
    s.once('pong_check', () => { clearTimeout(t); resolve(true); });
    s.emit('ping_check');
  });
}

// Humans in every agar room: counts.agar is all three rooms' humans plus the free row's bots, from one response.
async function agarHumans() {
  const r = await live();
  const row = (r.extras || []).find((e) => e.id === 'agar:free');
  return r.counts.agar - ((row && row.bots) || 0);
}
async function snakePlayers(id) {
  const r = await live();
  const row = (r.lobbies || []).find((l) => l.id === id);
  return row ? row.players : 0;
}

test('a seated agar player who sends spectate:join:agar is refused, and their seat goes when they leave', async () => {
  const base = await agarHumans();
  for (let i = 0; i < 3; i++) {
    const c = await connect();
    c.s.emit('cell:join', { name: 'seat' + i, lobbyType: 'free', region: 'na' });
    assert.ok(await until(() => c.has('cell:joined')), JSON.stringify(c.got.map((g) => g[0])));
    c.s.emit('spectate:join:agar', { lobbyType: 'dime', region: 'na' });
    assert.ok(await handled(c.s));
    assert.strictEqual(c.count('cell:joined'), 1, 'the spectate was refused: no second room was sent');
    assert.strictEqual(await agarHumans(), base + 1, 'one seat, in the free room');
    c.s.close();
    assert.strictEqual(await until(async () => (await agarHumans()) === base), true,
      'round ' + i + ': the seat went with the socket (it used to stay as a ghost)');
  }
});

test('a seated snake player who sends spectate:join is refused, and their seat goes when they leave', async () => {
  const base = await snakePlayers('snake:na:s0');
  for (let i = 0; i < 3; i++) {
    const c = await connect();
    c.s.emit('play', { name: 'seat' + i, stake: 0, region: 'na' });
    assert.ok(await until(() => c.has('game_joined')), JSON.stringify(c.got.map((g) => g[0])));
    c.s.emit('spectate:join', { stake: 1, region: 'na' });
    assert.ok(await handled(c.s));
    assert.strictEqual(c.count('game_joined'), 1, 'the spectate was refused: no second room was sent');
    assert.strictEqual(await snakePlayers('snake:na:s0'), base + 1, 'one seat, in the free room');
    c.s.close();
    assert.strictEqual(await until(async () => (await snakePlayers('snake:na:s0')) === base), true,
      'round ' + i + ': the seat went with the socket (it used to stay as a ghost)');
  }
  assert.strictEqual(await snakePlayers('snake:na:s1'), 0, 'nobody was seated in the room asked to watch');
});

test('a watch-only socket still gets its room, both games', async () => {
  const a = await connect();
  a.s.emit('spectate:join:agar', { lobbyType: 'free', region: 'na' });
  assert.ok(await until(() => a.has('cell:joined')));
  a.s.close();
  const b = await connect();
  b.s.emit('spectate:join', { stake: 0, region: 'na' });
  const j = await until(() => b.has('game_joined'));
  assert.ok(j && j[1].spectateOnly === true);
  b.s.close();
});

test('an agar watcher who switches rooms stops being sent the room it left', async () => {
  const w = await connect();
  w.s.emit('spectate:join:agar', { lobbyType: 'free', region: 'na' });
  assert.ok(await until(() => w.has('cell:joined')));

  // Control: while it watches the free room, a join there reaches it.
  const p1 = await connect();
  p1.s.emit('cell:join', { name: 'p1', lobbyType: 'free', region: 'na' });
  assert.ok(await until(() => w.has('cell:playerJoined', (p) => p && p.id === p1.s.id)), 'the watcher sees the free room');

  w.s.emit('spectate:join:agar', { lobbyType: 'dime', region: 'na' });
  assert.ok(await until(() => w.count('cell:joined') === 2));
  assert.ok(await handled(w.s));
  const p2 = await connect();
  p2.s.emit('cell:join', { name: 'p2', lobbyType: 'free', region: 'na' });
  assert.ok(await until(() => p2.has('cell:joined')));
  await sleep(300);
  assert.ok(!w.has('cell:playerJoined', (p) => p && p.id === p2.s.id), 'the free room is no longer sent to it');
  for (const c of [w, p1, p2]) c.s.close();
});

test('a snake watcher who switches rooms stops being sent the room it left', async () => {
  const w = await connect();
  w.s.emit('spectate:join', { stake: 0, region: 'na' });
  assert.ok(await until(() => w.has('game_joined')));
  const p = await connect();
  p.s.emit('play', { name: 'talker', stake: 0, region: 'na' });
  assert.ok(await until(() => p.has('game_joined')));

  // Control: while it watches the free room, chat there reaches it.
  p.s.emit('chat', { text: 'before' });
  assert.ok(await until(() => w.has('chat', (m) => m && m.text === 'before')), 'the watcher hears the free room');

  w.s.emit('spectate:join', { stake: 1, region: 'na' });
  assert.ok(await until(() => w.count('game_joined') === 2));
  assert.ok(await handled(w.s));
  await sleep(700);   // past the chat throttle
  p.s.emit('chat', { text: 'after' });
  assert.ok(await until(() => p.has('chat', (m) => m && m.text === 'after')), 'the talker was not throttled');
  await sleep(300);
  assert.ok(!w.has('chat', (m) => m && m.text === 'after'), 'the free room is no longer sent to it');
  for (const c of [w, p]) c.s.close();
});
