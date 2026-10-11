'use strict';
// slLoad (SERVER-BUILD-BRIEF section 8, row scripts/slLoad.js and scripts/slProbe.js: "decode every bundle; unknown id
// or wire_error is a failure"; task T15).
//
// The client model every wanderer runs on every bundle (scripts/slLoad.js createTracker), on literal streams: a clean
// stream has 0 failures; an unknown snake, prey or food, a double add, a food into a cell the client already holds one
// in, a wire_error, an event before init, an own record with no own snake, a kind-15 or off-grid number each count.
// The client's body arithmetic (addEnd, movePoint) on literal points. Then a live run: our /sl on a local socket.io
// server (openSl with the FIXTURE table), four wanderers (two long-polling, two WebSocket) and the probe, every bundle
// decoded with 0 failures and no kick.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const net = require('net');
const path = require('path');

const W = require('../shared/slWire.js');
const { createTracker, addEnd, movePoint, createWanderers } = require('../scripts/slLoad');
const { probe } = require('../scripts/slProbe');

const INIT = { type: 'init', grd: 21600, mscps: 411, sectorSize: 300, sectorCount: 144, spangdv: 4.8, nsp1: 5.39,
  nsp2: 0.4, nsp3: 14, mamu: 0.033, mamu2: 0.028, cst: 0.43, pv: 19, defaultMsl: 42, realSid: 0, fluxGrd: 21600,
  gameMode: 1, extraB: 0 };
const OWN = { type: 'snake_add', id: 7, ang: 0, wang: 0, sp: 5.39, fam: 0, cv: 1, snx: 100, sny: 0, nick: 'me',
  raw: { pts: [{ x: 290, y: 0 }, { iang: 0 }] } };
const OTHER = { type: 'snake_add', id: 9, ang: 0, wang: 0, sp: 5.39, fam: 0, cv: 2, snx: 600, sny: 0, nick: 'b',
  raw: { pts: [{ x: 2500, y: 0 }, { iang: 0 }] } };
const F = { type: 'food_sector', sx: 72, sy: 72, foods: [{ cv: 3, rx: 10, ry: 20, rad: 6 }, { cv: 4, rx: 11, ry: 20, rad: 7 }] };
const bundle = (evs) => W.encodeBundle(evs, 19);

function run(evsList) {
  const t = createTracker();
  for (const evs of evsList) t.onBundle(evs instanceof Uint8Array ? evs : bundle(evs));
  return t;
}

test('a clean stream: 0 failures, the own head followed with the client arithmetic', () => {
  const t = run([
    [INIT, OWN, F, OTHER],
    [{ type: 'snake_move', cmd: 'g', own: true }, { type: 'snake_move', cmd: 'g', own: false, id: 9 },
      { type: 'food_add', rapid: false, sectorFromLast: false, sx: 72, sy: 72, rx: 12, ry: 20, cvFromLast: false, cv: 5, rad: 6 },
      { type: 'food_eat', cmd: '<', sectorFromLast: false, sx: 72, sy: 72, rx: 10, ry: 20, eater: 9 },
      { type: 'prey_add', id: 4, cv: 1, xx: 700, yy: 700, rad: 5, dir: 1, wang: 0, ang: 0, sp: 5 }],
    [{ type: 'prey_move', id: 4, xx: 703, yy: 700 }, { type: 'prey_eaten', id: 4, eater: 9 },
      { type: 'sector_remove', sx: 72, sy: 72 }, { type: 'snake_remove', id: 9, kill: true }],
  ]);
  assert.deepStrictEqual(t.samples, []);
  assert.strictEqual(t.failures(), 0);
  assert.strictEqual(t.ownId, 7);
  assert.deepStrictEqual([t.own.x, t.own.y, t.own.iang], [142, 0, 0]);
  assert.strictEqual(t.cells.size, 0, 'the sector removal dropped its foods');
  assert.strictEqual(t.snakes.size, 1);
});

test('each failure kind is caught', () => {
  const cases = [
    ['unknownSnake', [[INIT, OWN, { type: 'snake_move', cmd: 'g', own: false, id: 9 }]]],
    ['unknownSnake', [[INIT, OWN, { type: 'snake_remove', id: 9, kill: false }]]],
    ['doubleSnake', [[INIT, OWN, OTHER, OTHER]]],
    ['unknownFood', [[INIT, OWN, { type: 'food_eat', cmd: '<', sectorFromLast: false, sx: 72, sy: 72, rx: 10, ry: 20, eater: 7 }]]],
    ['unknownFood', [[INIT, OWN, F, { type: 'sector_remove', sx: 72, sy: 72 },
      { type: 'food_eat', cmd: '<', sectorFromLast: false, sx: 72, sy: 72, rx: 10, ry: 20, eater: 7 }]]],
    ['doubleFood', [[INIT, OWN, F,
      { type: 'food_add', rapid: true, sectorFromLast: false, sx: 72, sy: 72, rx: 10, ry: 20, cvFromLast: false, cv: 5, rad: 6 }]]],
    ['doubleFood', [[INIT, OWN, F, F]]],
    ['unknownPrey', [[INIT, OWN, { type: 'prey_remove', id: 4 }]]],
    ['doublePrey', [[INIT, OWN, { type: 'prey_add', id: 4, cv: 1, xx: 7, yy: 7, rad: 5, dir: 1, wang: 0, ang: 0, sp: 5 },
      { type: 'prey_add', id: 4, cv: 1, xx: 7, yy: 7, rad: 5, dir: 1, wang: 0, ang: 0, sp: 5 }]]],
    ['beforeInit', [[OWN]]],
    ['badInit', [[INIT, INIT]]],
    ['noOwn', [[INIT, { type: 'snake_move', cmd: 'g', own: true }]]],
    ['emptyBody', [[INIT, Object.assign({}, OWN, { raw: { pts: [{ x: 290, y: 0 }] } })]]],
    ['killCount', [[INIT, OWN, { type: 'kill_count', id: 9, count: 1 }]]],
    ['offGrid', [[INIT, OWN, OTHER, { type: 'snake_rot', own: false, id: 9, wang: 0.1234567 }]]],
    ['kind15', [[INIT, OWN, OTHER, { type: 'snake_fam', id: 9, fam: Math.PI / 10 }]]],
    ['wireError', [[INIT, OWN], Uint8Array.from([99, 1, 2])]],
  ];
  for (const [kind, list] of cases) {
    const t = run(list);
    assert.ok(t.fail[kind] >= 1, kind + ' not caught: ' + JSON.stringify(t.fail));
  }
});

test('the client body arithmetic: an add ends where buildBody ends, moves step msl along the angle', () => {
  assert.deepStrictEqual(addEnd([{ x: 290, y: 0 }, { iang: 0 }], 42), { x: 100, y: 0, iang: 0 });
  assert.deepStrictEqual(addEnd([{ x: 500, y: 500 }, { bx: 131, by: 123 }], 42), { x: 102, y: 98, iang: undefined });
  assert.deepStrictEqual(movePoint({ cmd: 'g' }, { x: 100, y: 0, iang: 0 }, 42), { x: 142, y: 0, iang: 0 });
  assert.deepStrictEqual(movePoint({ cmd: '=', xx: 5, yy: 6, iang: 3 }, { x: 100, y: 0, iang: 0 }, 42), { x: 5, y: 6, iang: 3 });
  // a quarter turn: iang 16384 of 65536
  const q = movePoint({ cmd: 'n', iang: 16384 }, { x: 0, y: 0, iang: 0 }, 42);
  assert.strictEqual(q.iang, 16384);
  assert.ok(Math.abs(q.x) < 1e-12 && q.y === 42);
});

// ---------------------------------------------------------------------------------------------------- live

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

test('live: four wanderers and the probe on a local /sl, every bundle decoded, 0 failures, no kick', { timeout: 60000 }, async () => {
  const { Server } = require('socket.io');
  const port = await freePort();
  const server = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  const io = new Server(server, { pingInterval: 5000, pingTimeout: 10000 });
  const quiet = { log() {}, warn() {}, error() {} };
  const opened = require('../server/sl/slBoot').openSl({
    env: { SL_ENABLED: '1', SL_DEV_LAWS: path.join(__dirname, 'slLawsFixture.js') }, io, region: 'na', seed: 3, log: quiet,
    helpers: {
      socketRL: (s, k, ms) => {
        const now = Date.now();
        if (!s._rl) s._rl = {};
        if (s._rl[k] && now - s._rl[k] < ms) return false;
        s._rl[k] = now;
        return true;
      },
      ops: require('../server/ops'), notifyJoin() {}, paidLoad: () => ({ paidPlayers: 0, paid: [] }),
    },
  });
  assert.ok(opened.arenas, 'the room opened: ' + opened.why);
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + port;
  try {
    const run = createWanderers({ url, clients: 4, polling: 0.5, seed: 2 });
    run.start();
    const pr = probe({ url, ms: 6000, transport: 'polling' });
    await new Promise((r) => setTimeout(r, 6000));
    run.stop();
    const sum = run.summary();
    const ps = await pr;
    assert.deepStrictEqual(sum.samples, []);
    assert.strictEqual(sum.failures, 0);
    assert.ok(sum.joins >= 4, 'joins ' + sum.joins);
    assert.strictEqual(sum.polling, 2);
    assert.ok(sum.bundles > 200, 'bundles ' + sum.bundles);
    assert.ok((sum.byType.snake_move || 0) > 100 && (sum.byType.pong || 0) > 20, JSON.stringify(sum.byType));
    assert.strictEqual(sum.kickTotal, 0, JSON.stringify(sum.kicks));
    assert.strictEqual(sum.dropTotal, 0, JSON.stringify(sum.drops));
    assert.strictEqual(sum.refusalTotal, 0, JSON.stringify(sum.refusals));
    assert.deepStrictEqual(ps.samples, []);
    assert.strictEqual(ps.failures, 0);
    assert.ok(ps.joins >= 1 && ps.bundles > 50, 'probe joins ' + ps.joins + ', bundles ' + ps.bundles);
  } finally {
    opened.arenas.close();
    io.close();
    server.close();
  }
});

test('a long-polling wanderer keeps its HTTP connections (keep-alive, as a browser): no TCP connection per request', { timeout: 30000 }, async () => {
  // engine.io-client's node XHR opens one TCP connection per request unless given an agent; 15 wanderers that way
  // ran the soak out of loopback ports on Windows (thousands of 'transport error' drops, 2026-10-11).
  const { Server } = require('socket.io');
  const port = await freePort();
  const server = http.createServer();
  let tcp = 0;
  let requests = 0;
  server.on('connection', () => { tcp++; });
  const io = new Server(server, { pingInterval: 5000, pingTimeout: 10000 });
  server.on('request', () => { requests++; }); // after engine.io's own handler (it takes over the earlier ones)
  const timers = [];
  io.of('/sl').on('connection', (sock) => {
    // a message every 20 ms: each one answers the pending GET, so the client polls again at once
    timers.push(setInterval(() => sock.emit('sl:x', []), 20));
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try {
    const run = createWanderers({ url: 'http://127.0.0.1:' + port, clients: 1, polling: 1, seed: 4 });
    run.start();
    await new Promise((r) => setTimeout(r, 2000));
    run.stop();
    const sum = run.summary();
    assert.strictEqual(sum.polling, 1);
    assert.strictEqual(sum.connects, 1, 'one life, connected once');
    assert.strictEqual(sum.dropTotal, 0, JSON.stringify(sum.drops));
    assert.ok(requests >= 40, requests + ' HTTP requests');
    assert.ok(tcp <= 3, tcp + ' TCP connections for ' + requests + ' requests');
  } finally {
    for (const t of timers) clearInterval(t);
    io.close();
    server.close();
  }
});
