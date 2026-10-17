'use strict';
/* Watching Knockout and Battleship through the REAL server: the socket
   handlers in server/index.js (ko:watch, ko:unwatch, bs:watch, bs:unwatch),
   their shape checks and rate limits, the disconnect cleanup, and the live
   board, which must not count a watcher as a player.

   Boots the server as a child process the same way test/spectateSeat.test.js
   does (scripts/dev-local.js: in-memory database, every outbound call
   refused), seats two real sockets against each other, and watches them with
   a third. */
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 6000) => {
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
      res({
        s, got,
        has: (ev, f) => got.find((g) => g[0] === ev && (!f || f(g[1]))),
        all: (ev) => got.filter((g) => g[0] === ev).map((g) => g[1]),
      });
    });
    s.on('connect_error', (e) => { clearTimeout(bail); rej(e); });
  });
}
function handled(s) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 5000);
    s.once('pong_check', () => { clearTimeout(t); resolve(true); });
    s.emit('ping_check');
  });
}
async function counted(game) {
  const r = await live();
  const row = (r.extras || []).concat(r.lobbies || []).find((e) => e.id === game + ':free');
  return { row: row ? row.players : null, card: r.counts ? r.counts[game] : null };
}

for (const g of [
  { game: 'knockout', p: 'ko', started: 'ko:start' },
  { game: 'battleship', p: 'bs', started: 'bs:state' },
]) {
  test(g.game + ': a watcher on the real server is not counted, is told no socket id, and a player cannot watch', { timeout: 60000 }, async () => {
    const base = await counted(g.game);
    const A = await connect(), B = await connect();
    /* One after the other, so Owen is seat 0: two sockets' messages can reach
       the server in either order. */
    A.s.emit(g.p + ':queue', { name: 'Owen' });
    assert.ok(await until(() => A.has(g.p + ':queued')), 'Owen is queued');
    B.s.emit(g.p + ':queue', { name: 'Nia' });
    assert.ok(await until(() => A.has(g.started) && B.has(g.started)), 'the two are matched');
    const seated = await counted(g.game);
    assert.strictEqual(seated.row, base.row + 2, 'two players on the board');

    const W = await connect();
    W.s.emit(g.p + ':watch', {});
    const w = await until(() => W.has(g.p + ':watching', (m) => m && m.match));
    assert.ok(w, 'the watcher is told what it is watching');
    assert.deepStrictEqual(w[1].match.names, ['Owen', 'Nia']);
    const j = JSON.stringify(w[1]);
    assert.ok(!j.includes(A.s.id) && !j.includes(B.s.id), 'no socket id');
    if (g.p === 'bs') assert.ok(!/myShips|shotsOnMe|sunkOfTheirs/.test(j), 'no player view');
    assert.deepStrictEqual(await counted(g.game), seated, 'watching is not playing: the counts do not move');

    /* A seated player asking to watch is told no, and keeps their seat. */
    A.s.emit(g.p + ':watch', {});
    assert.ok(await until(() => A.has(g.p + ':watching', (m) => m && m.refused === true)));
    assert.deepStrictEqual(await counted(g.game), seated);

    /* Junk, each past the 100 ms limit so its shape is really read. The
       message itself is dropped by on() unless it is a plain object; a field
       that is not a short string is ignored. Either way the server answers,
       and the watcher is still watching the same match. */
    for (const msg of [5, 'x', [1, 2], null, true, { after: { toString: 1 } }, { after: ['ko_1'] }, { after: 'z'.repeat(5000) }]) {
      W.s.emit(g.p + ':watch', msg);
      W.s.emit(g.p + ':unwatch', msg);
      assert.ok(await handled(W.s), 'still answering after ' + JSON.stringify(msg).slice(0, 30));
      await sleep(120);
    }
    const n = W.all(g.p + ':watching').length;
    W.s.emit(g.p + ':watch', {});
    assert.ok(await until(() => W.all(g.p + ':watching').length > n), 'a plain watch still works after all that');
    assert.strictEqual(W.all(g.p + ':watching').pop().match.id, w[1].match.id, 'and it is watching the same match');

    /* A second watcher that stops watching hears nothing more. */
    const W2 = await connect();
    W2.s.emit(g.p + ':watch', {});
    assert.ok(await until(() => W2.has(g.p + ':watching', (m) => m && m.match)));
    W2.s.emit(g.p + ':unwatch');
    assert.ok(await handled(W2.s));
    const heard = W2.got.length;

    /* A player leaves: the watcher gets the result, by seat. */
    A.s.close();
    const over = await until(() => W.has(g.p + ':over'));
    assert.ok(over, 'the watcher is told the match is over');
    assert.strictEqual(over[1].winnerSide, 1);
    assert.strictEqual(over[1].winner, 'Nia');
    assert.ok(!JSON.stringify(over[1]).includes(B.s.id));
    await sleep(300);
    assert.strictEqual(W2.got.length, heard, 'the one who stopped watching was sent nothing more');

    /* The watcher's own disconnect costs the board nothing either way. */
    W.s.close();
    W2.s.close();
    B.s.close();
    assert.ok(await until(async () => (await counted(g.game)).row === base.row), 'back to where it started');
    assert.ok(srv.exitCode === null, 'the server is still up');
  });

  test(g.game + ': on the real server Previous and Next step between two live matches, round the ends, and a junk dir is Next', { timeout: 60000 }, async () => {
    const A = await connect(), B = await connect(), C = await connect(), D = await connect();
    /* Two matches, each queued one after the other so the pairs form in order. */
    for (const [x, y, nx, ny] of [[A, B, 'Ann', 'Ben'], [C, D, 'Cy', 'Di']]) {
      x.s.emit(g.p + ':queue', { name: nx });
      assert.ok(await until(() => x.has(g.p + ':queued')), nx + ' is queued');
      y.s.emit(g.p + ':queue', { name: ny });
      assert.ok(await until(() => x.has(g.started) && y.has(g.started)), 'a match is made');
    }
    const W = await connect();
    const ask = async (msg) => {
      await sleep(130);                                     // past the 100 ms limit between asks
      const n = W.all(g.p + ':watching').length;
      W.s.emit(g.p + ':watch', msg);
      assert.ok(await until(() => W.all(g.p + ':watching').length > n), 'answered ' + JSON.stringify(msg));
      return W.all(g.p + ':watching').pop();
    };
    const first = await ask({});
    assert.ok(first.match && first.match.count === 2, 'two matches are running');
    const a = first.match.id;
    const second = await ask({ after: a });
    const b = second.match.id;
    assert.notStrictEqual(a, b, 'Next is the other match');
    assert.strictEqual((await ask({ after: b, dir: 'prev' })).match.id, a, 'Previous from the second is the first');
    assert.strictEqual((await ask({ after: a, dir: 'prev' })).match.id, b, 'and from the first it wraps to the last');
    assert.strictEqual((await ask({ after: b, dir: 'next' })).match.id, a, 'dir next is Next');
    assert.strictEqual((await ask({ after: a, dir: 'sideways' })).match.id, b, 'a junk dir is Next');
    assert.strictEqual((await ask({ after: a, dir: { toString: 1 } })).match.id, b, 'so is an object');
    assert.strictEqual((await ask({ after: b, dir: 'prev', stake: 0 })).match.id, a, 'Previous at Free stays at Free');
    const none = await ask({ after: b, dir: 'prev', stake: 0.5 });
    assert.deepStrictEqual(none, { none: true }, 'no table at a buy-in nobody is playing: nothing, not a seat');
    for (const x of [A, B, C, D, W]) x.s.close();
  });
}
