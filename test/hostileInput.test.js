'use strict';
/* One hostile message or request must never end the process.

   The server has no uncaughtException handler, and Express 4 does not catch a rejection from an
   async route, so before this a single message from a hand-made client killed every live game on
   the box, paid ones included: region ['na'] on a FREE agar or snake join threw in the owner
   notice's toUpperCase (review finding), a null message threw in every destructuring handler,
   {"toString":1} as a name, stake, lobby type or region threw in String()/Number(), region
   '__proto__' found no room and threw at addPlayer, and over HTTP ?q[]=a on the player search,
   {"stake":{"toString":1}} on /api/submit-stake and the same shape on /api/my-name and
   /api/owner/do did the same.

   This boots the REAL server as a child process (scripts/dev-local.js: in-memory database, every
   outbound call refused), throws all of that at it, and asserts after every single message that
   the process is still up and answering. It also checks that the junk lands where an honest
   value would: a free join with a junk region is seated in this server's own region. */
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
// Raw HTTP so the request is exactly what is written (query arrays, JSON shapes), each from its own IP.
function call(method, url, body) {
  const ip = '10.8.' + ((++ipSeq >> 8) & 255) + '.' + (ipSeq & 255);
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    const data = body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
    let text = '';
    s.on('connect', () => s.write(`${method} ${url} HTTP/1.1\r\nHost: localhost\r\nX-Forwarded-For: ${ip}\r\n`
      + `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(data)}\r\nConnection: close\r\n\r\n${data}`));
    s.on('data', (d) => { text += d; });
    s.on('end', () => {
      let json = null;
      try { json = JSON.parse(text.split('\r\n\r\n').slice(1).join('\r\n\r\n')); } catch (_) {}
      resolve({ status: Number(text.split(' ')[1]) || 0, json });
    });
    s.on('error', () => resolve({ status: -1, json: null }));
    s.setTimeout(5000, () => { s.destroy(); resolve({ status: -2, json: null }); });
  });
}
const alive = () => exitCode === null && srv && srv.exitCode === null;
/* Errors that escaped to the log. Paper's handlers are wrapped (paperSockets.js guard) and log
   what they catch with this tag, by design: that is a refused message, not a dying process. */
const thrown = () => out.split('\n').filter((l) => /TypeError|ReferenceError|uncaught/i.test(l) && !l.startsWith('[PAPER] handler '));
const died = () => 'server process exited (code ' + exitCode + '):\n' + out.split('\n').filter((l) => /Error|at /.test(l)).slice(0, 8).join('\n');

test.before(async () => {
  port = await freePort();
  srv = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dev-local.js')], {
    cwd: ROOT, env: { ...process.env, DEV_LOCAL_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', (d) => { out += d; });
  srv.stderr.on('data', (d) => { out += d; });
  srv.on('exit', (code) => { exitCode = code === null ? 'signal' : code; });
  for (let i = 0; i < 120; i++) {
    if (!alive()) throw new Error(died());
    if ((await call('GET', '/api/live')).status === 200) return;
    await sleep(250);
  }
  throw new Error('server did not come up');
});
test.after(() => { if (process.env.HOSTILE_LOG) require('fs').writeFileSync(process.env.HOSTILE_LOG, out); if (srv && alive()) srv.kill(); });

function connect() {
  const { io } = require('socket.io-client');
  const s = io(`http://127.0.0.1:${port}`, { transports: ['websocket'], forceNew: true, reconnection: false, timeout: 5000 });
  const got = [];
  s.onAny((ev, p) => got.push([ev, p]));
  return new Promise((res, rej) => {
    const bail = setTimeout(() => rej(new Error('socket never connected' + (alive() ? '' : ': ' + died()))), 8000);
    s.on('connect', () => { clearTimeout(bail); res({ s, got, has: (ev) => got.find((g) => g[0] === ev) }); });
    s.on('connect_error', (e) => { clearTimeout(bail); rej(e); });
  });
}
// Messages on one socket are handled in order, so an answered ping means the message before it
// has been handled (and a handler that threw would have taken the process, and this socket, down).
function handled(s) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 5000);
    s.once('pong_check', () => { clearTimeout(t); resolve(true); });
    s.emit('ping_check');
  });
}

// Values a hand-made client can put in any field. JSON carries the first nine; the Buffer
// arrives as a binary attachment.
const JUNK = {
  'array': ['na'], 'empty array': [], 'object': {}, '{"toString":1}': { toString: 1 },
  '{"toString":1,"valueOf":1}': { toString: 1, valueOf: 1 }, '"__proto__"': '__proto__',
  '"constructor"': 'constructor', 'number': 1, 'true': true, 'null': null, 'buffer': Buffer.from('na'),
};
// The message itself, instead of an object.
const TOP = { 'no message': undefined, 'null': null, 'number': 5, 'string': 'x', 'array': [1, 2], 'true': true };

const SETUP = {
  none: async () => {},
  snake: async (c) => { c.s.emit('play', { name: 'h', lobbyType: 'free', region: 'na' }); await handled(c.s); },
  agar: async (c) => { c.s.emit('cell:join', { name: 'h', lobbyType: 'free', region: 'na' }); await handled(c.s); },
  shooter: async (c) => { c.s.emit('sh:join', { name: 'h' }); await handled(c.s); },
};
// Every client message the server handles, the fields each one reads, and the state it is sent in.
const EVENTS = [
  ['lobby:join', ['googleId'], 'none'],
  ['play', ['name', 'walletAddress', 'googleId', 'color', 'lobbyType', 'stake', 'entryToken', 'region', 'reconnectKey'], 'none'],
  ['cashout:start', [], 'snake'], ['cashout:cancel', [], 'snake'], ['cashout', [], 'snake'],
  ['input', ['angle', 'boost'], 'snake'],
  ['chat', ['text'], 'snake'],
  ['view', ['r', 'x', 'y'], 'none'],
  ['spectate:join:agar', ['lobbyType', 'region'], 'agar'],
  ['spectate:join', ['lobbyType', 'stake', 'region'], 'snake'],
  ['respawn', ['entryToken'], 'snake'],
  ['admin:spawnbot', ['count', 'idToken'], 'none'],
  ['cell:join', ['name', 'color', 'lobbyType', 'googleId', 'region', 'entryToken'], 'none'],
  ['cell:spawnbot', ['idToken'], 'none'],
  ['cell:input', ['mouseX', 'mouseY'], 'agar'],
  ['cell:view', ['r'], 'none'],
  ['cell:split', [], 'agar'], ['cell:respawn', ['entryToken'], 'agar'],
  ['cell:lock', [], 'agar'], ['cell:unlock', [], 'agar'], ['cell:cashout', [], 'agar'],
  ['br:start', ['proof', 'force'], 'none'],
  ['br:peek', ['wallet'], 'none'],
  ['tanks:queue', ['name', 'wallet'], 'none'], ['tanks:unqueue', [], 'none'],
  ['tanks:fire', ['angle', 'power'], 'none'], ['tanks:leave', [], 'none'],
  ['ko:queue', ['name', 'wallet', 'stake', 'entryToken'], 'none'], ['ko:unqueue', [], 'none'],
  ['ko:aim', ['aims'], 'none'], ['ko:lock', [], 'none'], ['ko:leave', [], 'none'],
  ['bs:queue', ['name', 'wallet', 'stake', 'entryToken'], 'none'], ['bs:unqueue', [], 'none'],
  ['bs:place', ['layout'], 'none'], ['bs:fire', ['cell'], 'none'], ['bs:leave', [], 'none'],
  ['sh:join', ['name', 'weapon'], 'none'],
  ['sh:input', ['up', 'down', 'left', 'right', 'fire', 'aim', 'angle'], 'shooter'],
  ['sh:weapon', ['weapon'], 'shooter'], ['sh:respawn', [], 'shooter'], ['sh:leave', [], 'shooter'],
  ['pp:join', ['stake', 'name', 'entryToken'], 'none'],
];
const JOINS = new Set(['play', 'cell:join', 'spectate:join', 'spectate:join:agar']);

test('no socket message of any shape, in any field, ends the process', { timeout: 240000 }, async () => {
  const cases = [];
  for (const [ev, fields, setup] of EVENTS) {
    for (const [label, msg] of Object.entries(TOP)) cases.push({ ev, setup, label: 'message ' + label, msg, bare: msg === undefined });
    for (const f of fields) {
      for (const [label, v] of Object.entries(JUNK)) {
        const msg = JOINS.has(ev) ? { name: 'h', lobbyType: 'free', region: 'na' } : { name: 'h' };
        msg[f] = v;
        cases.push({ ev, setup, label: f + ' = ' + label, msg });
      }
    }
  }
  // A weapon is looked up by name, and the tank keeps it: a prototype name used to throw on the
  // first shot, inside the tick.
  for (const weapon of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    cases.push({ ev: 'sh:weapon', setup: 'shooter', label: 'weapon ' + weapon + ', then fire', msg: { weapon }, then: ['sh:input', { fire: 1, aim: 1 }] });
    cases.push({ ev: 'sh:join', setup: 'none', label: 'join with weapon ' + weapon + ', then fire', msg: { name: 'h', weapon }, then: ['sh:input', { fire: 1, aim: 1 }] });
  }
  // Owner proofs are read field by field too (ownerAuth): junk one level down.
  for (const f of ['wallet', 'sig', 'action', 'ts', 'args']) {
    cases.push({ ev: 'br:start', setup: 'none', label: 'proof.' + f + ' = {"toString":1}', msg: { proof: { wallet: 'w', sig: 's', action: 'br:start', ts: Date.now(), [f]: { toString: 1 } } } });
  }
  for (const c of cases) {
    assert.ok(alive(), died());
    const conn = await connect();
    try {
      await SETUP[c.setup](conn);
      if (c.bare) conn.s.emit(c.ev); else conn.s.emit(c.ev, c.msg);
      if (c.then) { await handled(conn.s); conn.s.emit(c.then[0], c.then[1]); await sleep(250); }
      const ok = await handled(conn.s);
      // In a game, give the room a few ticks: junk stored as input used to throw in the tick.
      if (c.setup !== 'none') await sleep(60);
      assert.ok(alive(), `${c.ev} with ${c.label}: ${died()}`);
      assert.ok(ok, `${c.ev} with ${c.label}: the server stopped answering`);
    } finally {
      conn.s.close();
    }
  }
  await sleep(300);   // a throw from a timer or a promise the last message started
  assert.ok(alive(), died());
  assert.deepStrictEqual(thrown(), [], 'no handler threw');
});

test('a free join with a junk region is seated in this server\'s own region, both games', async () => {
  for (const region of [['na'], {}, 1, '__proto__', 'constructor', { toString: 1 }]) {
    const a = await connect();
    a.s.emit('cell:join', { name: 'rgn', lobbyType: 'free', region });
    await handled(a.s);
    const joined = a.has('cell:joined');
    a.s.close();
    assert.ok(alive(), died());
    assert.ok(joined, 'agar seated with region ' + JSON.stringify(region));

    const b = await connect();
    b.s.emit('play', { name: 'rgn', lobbyType: 'free', region });
    await handled(b.s);
    const seated = b.has('game_joined');
    b.s.close();
    assert.ok(alive(), died());
    assert.ok(seated, 'snake seated with region ' + JSON.stringify(region));
  }
  // Seated means the owner notice after the seat ran too, and that notice is what used to throw.
  assert.match(out, /\[>\] rgn joins free lobby/);
});

test('no HTTP request of any shape ends the process', { timeout: 120000 }, async () => {
  const toStr = { toString: 1 };
  const posts = [
    ['/api/submit-stake', { stake: toStr, walletAddress: 'W'.repeat(40) }],
    ['/api/submit-stake', { stake: 0.1, signedTx: 'AAAA', walletAddress: toStr }],
    ['/api/submit-stake', { lobbyType: toStr, signedTx: 'AAAA' }],
    ['/api/submit-stake', { lobbyType: 'constructor', signedTx: 'AAAA' }],
    ['/api/submit-stake', { stake: [0.1], signedTx: 'AAAA' }],
    ['/api/my-name', { name: toStr }],
    ['/api/my-name', { wallet: toStr, sig: 's', ts: Date.now(), name: 'abc' }],
    ['/api/my-name', { wallet: 'w', sig: toStr, ts: toStr, name: 'abc' }],
    ['/api/owner/do', { action: toStr }],
    ['/api/owner/do', { wallet: toStr, sig: toStr, action: 'x', ts: toStr }],
    ['/api/owner/state', { wallet: toStr }],
    ['/api/owner/diagnose', { wallet: toStr }],
  ];
  for (const [url, body] of posts) {
    const r = await call('POST', url, body);
    assert.ok(alive(), `POST ${url} ${JSON.stringify(body)}: ${died()}`);
    assert.ok(r.status >= 200 && r.status < 500, `POST ${url} ${JSON.stringify(body)} answered ${r.status}`);
  }
  for (const top of ['null', '[]', '"x"', '5']) {
    for (const url of ['/api/submit-stake', '/api/my-name', '/api/owner/do', '/api/broadcast']) {
      await call('POST', url, top);
      assert.ok(alive(), `POST ${url} ${top}: ${died()}`);
    }
  }
  for (const url of ['/api/players/search?q[]=a&q[]=b', '/api/players/search?q[a]=1',
                     '/api/my-profile?wallet[]=a', '/api/my-profile?wallet[a]=1',
                     '/api/my-transactions?wallet[]=a', '/api/my-transactions?wallet[a]=1',
                     '/api/stake-quote?stake[]=1', '/api/stake-quote?lobbyType[]=dime', '/api/stake-quote?lobbyType=constructor']) {
    const r = await call('GET', url);
    assert.ok(alive(), `GET ${url}: ${died()}`);
    assert.ok(r.status > 0, `GET ${url} got no answer`);
  }
  // Refused at the door, before the signed transaction is broadcast: the junk wallet used to get
  // past the stake's one-time claim and then throw.
  const r = await call('POST', '/api/submit-stake', { stake: 0.1, signedTx: 'AAAA', walletAddress: toStr });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.json && r.json.error, 'Malformed request');
  assert.deepStrictEqual(thrown(), [], 'no route threw');
});

/* The duel rooms read their two numbers themselves, so they are checked directly: a match is two
   sockets the same client can own, and a throw here ended the process mid-match. */
test('the duel and arena rooms take junk numbers without throwing', () => {
  const { KnockoutRoom, KO } = require('../server/KnockoutRoom');
  const { TanksRoom } = require('../server/TanksRoom');
  const { ShooterRoom, SH } = require('../server/ShooterRoom');
  const io = { to: () => ({ emit: () => {} }) };
  const sock = (id) => ({ id, join() {}, emit() {}, rooms: new Set(), volatile: { emit() {} } });

  const ko = new KnockoutRoom(io, 'hostile');
  ko.addPlayer(sock('A'), 'A', null);
  ko.addPlayer(sock('B'), 'B', null);
  ko.start(1000);
  for (let i = 0; i < 4; i++) ko.tick(1000 + KO.COUNTDOWN_MS + 1);
  assert.strictEqual(ko.state, 'aiming');
  const piece = ko.piecesOf('A')[0].id;
  for (const v of Object.values(JUNK)) {
    assert.doesNotThrow(() => ko.submitAim('A', [{ pieceId: piece, ax: v, ay: 1 }, { pieceId: piece, ax: 1, ay: v }]));
  }
  assert.strictEqual(ko.submitAim('A', [{ pieceId: piece, ax: '40', ay: 0 }]).count, 1, 'a numeric string still aims');

  const tanks = new TanksRoom(io, 'hostile');
  tanks.addPlayer(sock('t1'), 'A', null);
  tanks.addPlayer(sock('t2'), 'B', null);
  tanks.start(7);
  for (const v of Object.values(JUNK)) {
    assert.doesNotThrow(() => tanks.fire(tanks.turn, v, 50));
    assert.doesNotThrow(() => tanks.fire(tanks.turn, 45, v));
  }

  class Room extends ShooterRoom {
    constructor() { super(io, 'hostile'); this.t = 1e9; }
    now() { return this.t; }
  }
  const sh = new Room();
  sh.stop();
  for (const w of ['constructor', '__proto__', 'toString', { toString: 1 }]) {
    const t = sh.addPlayer(sock('s' + String(typeof w === 'string' ? w : 'obj')), 'A', w);
    sh.stop();
    assert.strictEqual(t.weapon, 'cannon', 'an unknown weapon is the cannon');
    assert.strictEqual(sh.setWeapon(t.id, w), false);
    sh.setInput(t.id, { fire: 1, aim: 0.5 });
  }
  assert.doesNotThrow(() => { for (let i = 0; i < 120; i++) { sh.t += 1000 / SH.TICK_RATE; sh.tick(); } });
});
