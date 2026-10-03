'use strict';
// agar.io socket handlers (build brief 9.3 agSockets card), on the FIXTURE law table: wrong shapes ignored,
// non-finite numbers rejected, names through sanitizeName and the L37 cap, per-event rate limits through
// socketRL, maintenance, and 10,000 random payloads that never throw and never reach the sim.
const test = require('node:test');
const assert = require('node:assert');
const W = require('../shared/agWire');
const { AgArenas } = require('../server/ag/agArenas');
const { attachAgSockets, AG_RATE, AG_CONN, cleanName, clientIp } = require('../server/ag/agSockets');
const { FIXTURE, makeFixture } = require('./agLawsFixture');
const { LAWS } = require('../server/ag/agLaws');
const fs = require('node:fs');
const path = require('node:path');

const quiet = { error() {}, warn() {}, log() {} };
const CAP = FIXTURE.L37.value;

// The server's own sanitizeName and socketRL (server/index.js), copied here because index.js boots a server.
function sanitizeName(name) {
  const s = typeof name === 'string' ? name : (typeof name === 'number' ? String(name) : '');
  return (s.replace(/[<>]/g, '').trim().slice(0, 20)) || 'Player';
}
function realSocketRL(socket, key, minMs) {
  const now = Date.now();
  if (!socket._rl) socket._rl = {};
  if (socket._rl[key] && now - socket._rl[key] < minMs) return false;
  socket._rl[key] = now;
  return true;
}

function world(opts) {
  const o = opts || {};
  const a = new AgArenas({ laws: FIXTURE, shippableOnly: false, autoTick: false, seed: 3, log: quiet });
  const rl = [];
  const socketRL = o.socketRL || ((socket, key, ms) => { rl.push([key, ms]); return true; });
  const maintenance = { on: false };
  const handlers = attachAgSockets(null, a, {
    socketRL, sanitizeName, log: quiet, ops: { get: () => ({ maintenance: maintenance.on }) },
  });
  return { a, handlers, rl, maintenance };
}

let sn = 0;
function sock(w) {
  ++sn;
  const s = {
    id: 'sk' + sn,
    handshake: { address: '10.1.' + (sn >> 8) + '.' + (sn & 255), headers: {} },   // one address each
    conn: { writeBuffer: [] },
    handlers: {},
    got: [],
    other: [],
    on(ev, fn) { this.handlers[ev] = fn; },
    emit(ev, p) { if (ev === 'ag:f') this.got.push(W.decodeBundle(p)); else this.other.push([ev, p]); },
    fire(ev, ...args) { this.handlers[ev](...args); },
  };
  w.handlers.attach(s);
  return s;
}

function roomOf(w, s) {
  return w.a.roomOfSocket(s.id);
}

function pidOf(w, s) {
  const r = roomOf(w, s);
  const seat = r && r.seatOf(s.id);
  return seat ? seat.pid : null;
}

test('a socket that connects is seated as a watcher and sent world updates before it plays', () => {
  const w = world();
  const s = sock(w);
  const r = roomOf(w, s);
  assert.ok(r);
  assert.strictEqual(r.seatOf(s.id).joined, false);
  r.tickOnce();
  assert.deepStrictEqual(s.got[0].slice(0, 3).map((x) => x.t), ['hello', 'border', 'world']);
  // The io namespace path does the same.
  const listeners = {};
  const nsp = { on(ev, fn) { listeners[ev] = fn; } };
  const a2 = new AgArenas({ laws: FIXTURE, shippableOnly: false, autoTick: false, seed: 3, log: quiet });
  attachAgSockets(nsp, a2, { socketRL: () => true, sanitizeName, log: quiet });
  const s2 = { id: 'io1', conn: { writeBuffer: [] }, handlers: {}, on(ev, fn) { this.handlers[ev] = fn; }, emit() {} };
  listeners.connection(s2);
  assert.ok(a2.roomOfSocket('io1'));
  assert.ok(s2.handlers['ag:join'] && s2.handlers.disconnect);
  s2.handlers.disconnect('transport close');
  assert.strictEqual(a2.roomOfSocket('io1'), null);
});

test('ag:join: names through sanitizeName and the L37 cap; wrong shapes ignored', () => {
  const w = world();
  const join = (payload) => {
    const s = sock(w);
    s.fire('ag:join', payload);
    const r = roomOf(w, s);
    const seat = r.seatOf(s.id);
    return { s, r, seat };
  };
  let j = join({ name: '  <b>Owen</b>  ' });
  assert.strictEqual(j.seat.joined, true);
  assert.strictEqual(j.seat.name, 'bOwen/b');
  j = join({ name: 'x'.repeat(40) });
  assert.strictEqual(j.seat.name, 'x'.repeat(CAP));
  // L37: CAP characters of any kind, not the shared sanitizeName's 20 UTF-16 units (that cut left 10 emoji).
  j = join({ name: '\u{1F600}'.repeat(30) });
  assert.strictEqual(j.seat.name, '\u{1F600}'.repeat(CAP));
  j = join({ name: 'a' + '\u{1F600}'.repeat(30) });
  assert.strictEqual(j.seat.name, 'a' + '\u{1F600}'.repeat(CAP - 1));
  j = join({ name: '   ' });
  assert.strictEqual(j.seat.joined, true);
  assert.strictEqual(j.seat.name, '', 'a blank name stays blank (an unnamed cell)');
  j = join(undefined);
  assert.strictEqual(j.seat.joined, true);
  assert.strictEqual(j.seat.name, '');
  for (const bad of [null, 5, 'Owen', ['Owen'], { name: 5 }, { name: { toString: 1 } }, { name: null },
    Buffer.from('x'), new Uint8Array(3)]) {
    j = join(bad);
    assert.strictEqual(j.seat.joined, false, 'ignored: ' + String(bad && JSON.stringify(bad)));
  }
  // The name reaches the wire: tick and read it back.
  const s = sock(w);
  s.fire('ag:join', { name: 'Wired' });
  const r = roomOf(w, s);
  r.tickOnce();
  const id = s.got[0].find((x) => x.t === 'own').id;
  const cell = s.got[0].filter((x) => x.t === 'world').flatMap((x) => x.cells).find((c) => c.id === id);
  assert.strictEqual(cell.name, 'Wired');
  assert.strictEqual(cleanName('a'.repeat(99), CAP, sanitizeName).length, CAP);
});

test('L37 on the real table: names keep 15 characters of any kind; the shared sanitizeName is unchanged for the other games', () => {
  const cap = LAWS.L37.value;
  assert.strictEqual(cap, 15);
  assert.strictEqual(LAWS.L37.status, 'MEASURED');
  const clean = (n) => cleanName(n, cap, sanitizeName);
  const smile = '\u{1F600}';
  // 15 emoji (30 UTF-16 units, 60 bytes) stay 15; 16 are cut to 15 (their server passed 15 characters of 26 units)
  assert.strictEqual(clean(smile.repeat(15)), smile.repeat(15));
  assert.strictEqual(clean(smile.repeat(16)), smile.repeat(15));
  assert.strictEqual(Array.from(clean(smile.repeat(15))).length, 15);
  // the recorded shape: 15 characters, 26 UTF-16 units (11 emoji among 4 letters)
  const mixed = 'ab' + smile.repeat(11) + 'cd';
  assert.strictEqual(mixed.length, 26);
  assert.strictEqual(clean(mixed), mixed);
  // Cyrillic and CJK
  assert.strictEqual(clean('Ж'.repeat(20)), 'Ж'.repeat(15));
  assert.strictEqual(clean('猫'.repeat(15)), '猫'.repeat(15));
  // the helper's own rules still apply: markup brackets go, outer spaces go, inner spaces stay, blank stays blank
  assert.strictEqual(clean('  <b>' + smile.repeat(14) + '</b>  '), 'b' + smile.repeat(14));
  assert.strictEqual(clean('Big  Owen'), 'Big  Owen');
  assert.strictEqual(clean('<>'), 'Player');
  assert.strictEqual(clean('   '), '');
  // a lone half of a character is dropped, never counted
  assert.strictEqual(clean('\uD83D' + 'abc'), 'abc');
  // if the shared helper ever changes a piece (a rule it gains later), agar follows the helper's result (cut at its
  // 20 units: 'max' + 8 emoji + half of one, the x and the half dropped)
  const stripsX = (n) => sanitizeName(n).replace(/x/g, '') || 'Player';
  assert.strictEqual(cleanName('max' + smile.repeat(20), cap, stripsX), 'ma' + smile.repeat(8));
  // The server's sanitizeName (shared by every game) still cuts at 20 UTF-16 units, as the copy above does.
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  const m = /function sanitizeName\(name\) \{([\s\S]*?)\n\}/.exec(src);
  assert.ok(m, 'server/index.js sanitizeName found');
  assert.ok(m[1].includes(".replace(/[<>]/g, '').trim().slice(0, 20)) || 'Player'"), 'shared helper unchanged');
  assert.strictEqual(sanitizeName(smile.repeat(15)), smile.repeat(10), 'the other games still get 20 units');
});

test('ag:target: integers only; wrong shapes and non-finite numbers never reach the sim', () => {
  const w = world();
  const s = sock(w);
  s.fire('ag:join', { name: 'T' });
  const r = roomOf(w, s);
  r.tickOnce();
  const pid = pidOf(w, s);
  const calls = [];
  const setInput = r.sim.setInput;
  r.sim.setInput = (p, input) => { if (p === pid) calls.push(input); return setInput(p, input); };
  for (const bad of [undefined, null, 1, 'x', [1, 2], { x: 1 }, { y: 1 }, { x: NaN, y: 0 }, { x: 0, y: Infinity },
    { x: -Infinity, y: 0 }, { x: 1.5, y: 2 }, { x: '1', y: '2' }, { x: 2 ** 31, y: 0 }, { x: 0, y: -(2 ** 31) - 1 },
    { x: { valueOf: () => 1 }, y: 0 }, { x: true, y: false }, { x: 1n, y: 2n }, new Float64Array(2)]) {
    s.fire('ag:target', bad);
  }
  assert.strictEqual(calls.length, 0);
  s.fire('ag:target', { x: -2147483648, y: 2147483647 });
  s.fire('ag:target', { x: 120, y: -40, extra: { deep: [1, 2, 3] } });
  assert.deepStrictEqual(calls, [{ x: -2147483648, y: 2147483647 }, { x: 120, y: -40 }]);
  // A watcher (no Play yet) steers nothing.
  const watcher = sock(w);
  watcher.fire('ag:target', { x: 1, y: 1 });
  assert.strictEqual(calls.length, 2);
});

test('every event is rate limited through socketRL with its own key', () => {
  const w = world();
  const s = sock(w);
  s.fire('ag:join', { name: 'R' });
  s.fire('ag:spectate');
  s.fire('ag:target', { x: 1, y: 2 });
  s.fire('ag:split');
  s.fire('ag:eject');
  s.fire('ag:q');
  s.fire('ag:leave');
  assert.deepStrictEqual(w.rl, [
    ['agjoin', AG_RATE.join.value], ['agspectate', AG_RATE.spectate.value], ['agtarget', AG_RATE.target.value],
    ['agsplit', AG_RATE.split.value], ['ageject', AG_RATE.eject.value], ['agq', AG_RATE.q.value],
    ['agleave', AG_RATE.leave.value],
  ]);
  for (const k of Object.keys(AG_RATE)) assert.strictEqual(AG_RATE[k].status, 'CHOSEN');

  // With the server's real limiter a burst of splits within one window gets one through.
  const w2 = world({ socketRL: realSocketRL });
  const s2 = sock(w2);
  s2.fire('ag:join', { name: 'Burst' });
  const r2 = roomOf(w2, s2);
  let splits = 0;
  const split = r2.sim.split;
  r2.sim.split = (pid) => { splits++; return split(pid); };
  for (let i = 0; i < 50; i++) s2.fire('ag:split');
  assert.strictEqual(splits, 1);
});

test('split, eject, spectate and leave reach the room; q is accepted and ignored', () => {
  const w = world();
  const s = sock(w);
  s.fire('ag:join', { name: 'Act' });
  const r = roomOf(w, s);
  r.tickOnce();
  const pid = pidOf(w, s);
  const seen = [];
  r.sim.split = ((f) => (p) => { if (p === pid) seen.push('split'); return f(p); })(r.sim.split);
  r.sim.eject = ((f) => (p) => { if (p === pid) seen.push('eject'); return f(p); })(r.sim.eject);
  s.fire('ag:split', 'ignored payload');
  s.fire('ag:eject', { any: 'thing' });
  s.fire('ag:q');
  assert.deepStrictEqual(seen, ['split', 'eject']);
  s.fire('ag:spectate');
  assert.strictEqual(r.seatOf(s.id).spectating, false, 'alive: no spectate');
  s.fire('ag:leave');
  assert.strictEqual(w.a.roomOfSocket(s.id), null);
  s.fire('ag:spectate');
  assert.strictEqual(w.a.roomOfSocket(s.id).seatOf(s.id).spectating, true, 'back as a spectator');
  s.fire('disconnect', 'client namespace disconnect');
  assert.strictEqual(w.a.roomOfSocket(s.id), null);
});

test('maintenance refuses a Play', () => {
  const w = world();
  w.maintenance.on = true;
  const s = sock(w);
  s.fire('ag:join', { name: 'M' });
  assert.strictEqual(roomOf(w, s).seatOf(s.id).joined, false);
  assert.deepStrictEqual(s.other, [['ag:refused', { why: 'maintenance' }]]);
  w.maintenance.on = false;
  s.fire('ag:join', { name: 'M' });
  assert.strictEqual(roomOf(w, s).seatOf(s.id).joined, true);
});

// A seeded generator of hostile payloads: strings, NaN, Infinity, nested objects, huge arrays, buffers.
function payloads(seed) {
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const huge = new Array(1e6);
  const sparse = [];
  sparse[2 ** 31] = 1;
  const nums = [NaN, Infinity, -Infinity, -0, 0, 1e308, -1e308, 2 ** 53, 2 ** 31, -(2 ** 31) - 1, 0.5, 3, -7, 1e-320];
  const atoms = () => pick([undefined, null, true, false, '', 'x', 'name', '\u0000￿', '<script>', 'a'.repeat(5000),
    pick(nums), Symbol('s'), () => 1, 10n, huge, sparse, Buffer.alloc(16), new Uint8Array(4), new ArrayBuffer(8),
    new Date(0), /re/, new Map(), new Set([1])]);
  function value(depth) {
    const k = rnd();
    if (depth > 3 || k < 0.45) return atoms();
    if (k < 0.6) return Array.from({ length: Math.floor(rnd() * 4) }, () => value(depth + 1));
    if (k < 0.8) return { x: value(depth + 1), y: value(depth + 1), name: value(depth + 1) };
    const o = Object.create(null);
    o.x = pick(nums);
    o.y = pick(nums);
    o.name = value(depth + 1);
    o.__proto__ = value(depth + 1);
    return o;
  }
  return () => value(0);
}

test('10,000 random payloads never throw and never reach the sim with a bad value', () => {
  const w = world();
  const room = w.a.all()[0];
  const bad = [];
  const sim = room.sim;
  const okInt = (v) => Number.isInteger(v) && v >= -2147483648 && v <= 2147483647;
  const wrap = (name, check) => {
    const f = sim[name];
    sim[name] = (...args) => { const why = check(...args); if (why) bad.push(name + ': ' + why); return f(...args); };
  };
  const humanPids = () => new Set(Array.from(room.seats.values()).map((s) => s.pid));
  wrap('setInput', (pid, input) => {
    if (!humanPids().has(pid)) return null;   // bots steer through the same call
    if (!input || typeof input !== 'object') return 'not an object';
    if (!okInt(input.x) || !okInt(input.y)) return 'target ' + String(input.x) + ',' + String(input.y);
    if (input.split || input.eject) return 'a target carried an action';
    return null;
  });
  wrap('spawn', (pid, name) => {
    if (!humanPids().has(pid)) return null;
    if (typeof name !== 'string') return 'name not a string';
    if (Array.from(name).length > CAP) return 'name over the cap';
    if (/[<>]/.test(name)) return 'markup in a name';
    return null;
  });
  const events = ['ag:join', 'ag:spectate', 'ag:target', 'ag:split', 'ag:eject', 'ag:q', 'ag:leave', 'ag:nope'];
  const next = payloads(20261002);
  const socks = [sock(w), sock(w), sock(w)];
  const realError = console.error;
  const errors = [];
  console.error = (...a) => errors.push(a.join(' '));
  try {
    for (let i = 0; i < 10000; i++) {
      const s = socks[i % socks.length];
      const ev = events[Math.floor((i * 7919) % events.length)];
      const h = s.handlers[ev];
      if (!h) continue;
      // Handlers must not throw even when called with extra arguments or an ack function.
      assert.doesNotThrow(() => h(next(), next(), () => {}));
      if (i % 25 === 0) for (const r of w.a.all()) r.tickOnce();
    }
  } finally {
    console.error = realError;
  }
  assert.deepStrictEqual(bad, []);
  assert.deepStrictEqual(errors, []);
  for (const r of w.a.all()) {
    assert.strictEqual(r.failCount, 0);
    r.sim.forEachCell((c) => assert.ok(Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.size)));
  }
  // The sockets still work after all that.
  const s = socks[0];
  s.fire('ag:leave');
  s.fire('ag:join', { name: 'Still fine' });
  assert.strictEqual(roomOf(w, s).seatOf(s.id).joined, true);
});

// A socket from one address, with disconnect() firing the handlers the way socket.io's does.
function ipSock(handlers, address, xff) {
  ++sn;
  const s = {
    id: 'ip' + sn,
    handshake: { address, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } },
    conn: { writeBuffer: [] },
    handlers: {},
    other: [],
    closed: false,
    on(ev, fn) { this.handlers[ev] = fn; },
    emit(ev, p) { if (ev !== 'ag:f') this.other.push([ev, p]); },
    disconnect() { if (this.closed) return; this.closed = true; if (this.handlers.disconnect) this.handlers.disconnect('server namespace disconnect'); },
  };
  handlers.attach(s);
  return s;
}

// Review 2026-10-02, finding 1/5: connections per address are capped on the /ag namespace itself.
test('connections per address: the namespace middleware and the connection handler both hold the cap', () => {
  assert.strictEqual(AG_CONN.PER_IP.status, 'CHOSEN');
  const cap = AG_CONN.PER_IP.value;
  assert.ok(Number.isInteger(cap) && cap >= 1);
  const a = new AgArenas({ laws: FIXTURE, shippableOnly: false, autoTick: false, seed: 3, log: quiet });
  assert.ok(cap < a.all()[0].watchCap, 'one address can never hold every watcher seat of a room (FIXTURE L39)');
  const used = [];
  const nsp = { on(ev, fn) { this.conn = fn; }, use(fn) { used.push(fn); } };
  const h = attachAgSockets(nsp, a, { socketRL: () => true, sanitizeName, log: quiet });
  assert.strictEqual(used.length, 1, 'a middleware on the namespace (io.use on / does not cover /ag)');
  const admit = used[0];
  const admitted = (sock) => { let r; admit(sock, (err) => { r = err || null; }); return r; };
  const mine = [];
  for (let i = 0; i < cap; i++) {
    const probe = { handshake: { address: '203.0.113.9', headers: {} } };
    assert.strictEqual(admitted(probe), null, 'handshake ' + i + ' admitted');
    mine.push(ipSock(h, '203.0.113.9'));
  }
  assert.strictEqual(h.gate.count('203.0.113.9'), cap);
  for (const m of mine) assert.ok(a.roomOfSocket(m.id), 'seated');
  // The next handshake from that address is refused before any connection exists.
  const err = admitted({ handshake: { address: '203.0.113.9', headers: {} } });
  assert.ok(err instanceof Error);
  assert.deepStrictEqual(err.data, { why: 'limit' });
  // Handshakes in flight together all pass the middleware: the connection handler refuses the extra one.
  const extra = ipSock(h, '203.0.113.9');
  assert.deepStrictEqual(extra.other, [['ag:refused', { why: 'limit' }]]);
  assert.strictEqual(extra.closed, true);
  assert.strictEqual(a.roomOfSocket(extra.id), null, 'no seat, no sim player');
  assert.strictEqual(h.gate.count('203.0.113.9'), cap, 'a refused socket is not counted');
  // IPv4-mapped is the same address; another address is not affected.
  assert.strictEqual(ipSock(h, '::ffff:203.0.113.9').closed, true);
  assert.strictEqual(ipSock(h, '198.51.100.4').closed, false);
  // A socket that closes frees its place.
  mine[0].disconnect();
  assert.strictEqual(h.gate.count('203.0.113.9'), cap - 1);
  assert.strictEqual(admitted({ handshake: { address: '203.0.113.9', headers: {} } }), null);
  const back = ipSock(h, '203.0.113.9');
  assert.strictEqual(back.closed, false);
  for (const m of mine.slice(1).concat([back])) m.disconnect();
  assert.strictEqual(h.gate.count('203.0.113.9'), 0);
  assert.strictEqual(h.gate.addresses(), 1, 'only 198.51.100.4 is still open');
});

test('the client address is read the way express reads req.ip under trust proxy 1', () => {
  assert.strictEqual(clientIp({ handshake: { address: '127.0.0.1', headers: { 'x-forwarded-for': '1.1.1.1, 9.9.9.9' } } }), '9.9.9.9');
  assert.strictEqual(clientIp({ handshake: { address: '127.0.0.1', headers: { 'x-forwarded-for': ' 8.8.8.8 ' } } }), '8.8.8.8');
  assert.strictEqual(clientIp({ handshake: { address: '::ffff:10.0.0.7', headers: {} } }), '10.0.0.7');
  assert.strictEqual(clientIp({ handshake: { address: '2001:db8::1', headers: { 'x-forwarded-for': '' } } }), '2001:db8::1');
  assert.strictEqual(clientIp({}), '');
  // Behind the proxy every socket shares its address: the forwarded one is what is counted.
  const a = new AgArenas({ laws: FIXTURE, shippableOnly: false, autoTick: false, seed: 3, log: quiet });
  const h = attachAgSockets(null, a, { socketRL: () => true, sanitizeName, log: quiet });
  for (let i = 0; i < AG_CONN.PER_IP.value + 3; i++) assert.strictEqual(ipSock(h, '127.0.0.1', '10.20.0.' + i).closed, false);
});

test('a connection no room has a watcher seat for is refused and closed', () => {
  const laws = makeFixture({ L39: 1 });
  const a = new AgArenas({ laws, shippableOnly: false, autoTick: false, seed: 3, log: quiet });
  const h = attachAgSockets(null, a, { socketRL: () => true, sanitizeName, log: quiet });
  const room = a.all()[0];
  const first = ipSock(h, '192.0.2.1');
  assert.strictEqual(first.closed, false);
  assert.strictEqual(room.watcherCount, room.watchCap);
  const second = ipSock(h, '192.0.2.2');
  assert.deepStrictEqual(second.other, [['ag:refused', { why: 'full' }]]);
  assert.strictEqual(second.closed, true);
  assert.strictEqual(h.gate.count('192.0.2.2'), 0, 'its place is given back');
  assert.strictEqual(a.all().length, 1, 'a watcher never opens a room');
  // Once the first one plays, its watcher seat is free again.
  first.handlers['ag:join']({ name: 'One' });
  assert.strictEqual(ipSock(h, '192.0.2.3').closed, false);
});

// Review 2026-10-02, finding 5: a join dropped by the rate limit never cleans its name.
test('ag:join checks the rate limit before it cleans the name', () => {
  let cleaned = 0;
  const counting = (n) => { cleaned++; return sanitizeName(n); };
  let allow = false;
  const a = new AgArenas({ laws: FIXTURE, shippableOnly: false, autoTick: false, seed: 3, log: quiet });
  const h = attachAgSockets(null, a, { socketRL: () => allow, sanitizeName: counting, log: quiet });
  const s = ipSock(h, '192.0.2.50');
  const big = 'x'.repeat(1 << 20);
  for (let i = 0; i < 20; i++) s.handlers['ag:join']({ name: big });
  assert.strictEqual(cleaned, 0, 'no rate-limited join reached sanitizeName');
  assert.strictEqual(a.roomOfSocket(s.id).seatOf(s.id).joined, false);
  allow = true;
  s.handlers['ag:join']({ name: big });
  // one helper check per 9-character piece of the CAP-character name (L37 wrap in cleanName)
  assert.strictEqual(cleaned, Math.ceil(CAP / 9));
  assert.strictEqual(a.roomOfSocket(s.id).seatOf(s.id).name, 'x'.repeat(CAP));
});
