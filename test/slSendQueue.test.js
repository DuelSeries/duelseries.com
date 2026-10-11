'use strict';
// slSendQueue (SERVER-DESIGN 9, SERVER-BUILD-BRIEF 7; task T9). Fake engine.io transports from test/slNetFakes.js;
// one real socket.io polling pair proves the cork against the installed engine.io.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const W = require('../shared/slWire.js');
const Q = require('../server/sl/slQuant');
const RC = require('../server/sl/slRecordCache');
const SQ = require('../server/sl/slSendQueue');
const { makeFixture } = require('./slLawsFixture');
const { fakeSocket, bareSocket, PI2 } = require('./slNetFakes');

const LAWS = makeFixture();
const PV = 19; // L6 protocol (literal, SERVER-LAWS L6)
const P = 42.67; // L7 (literal, SERVER-LAWS L7)

const enc = (ev, own) => RC.encodeRecord(ev, !!own, PV);
function rotEv(id, wangRaw, own) {
  return { type: 'snake_rot', own: !!own, id, dir: 1, wang: wangRaw * PI2 / 256 };
}
function otherRot(id) {
  return { type: 'snake_rot', own: false, id, ang: 0 };
}
function addEv(id) {
  const body = Q.addBody([{ x: 1000, y: 1000 }, { x: 1042, y: 1000 }], 42);
  return { type: 'snake_add', id, ang: 0, wang: 0, sp: Q.sp1000(5.79).v, fam: 0, cv: 3, snx: 1050, sny: 1000,
    nick: 'n', raw: { pts: body.raw } };
}
function pushEv(q, tick, ev, own) {
  q.push(tick, ev, enc(ev, own));
}

// Every bundle the socket emitted, decoded, in order (sl:f only).
function frames(sock) {
  return sock.emitted.filter((e) => e.name === 'sl:f').map((e) => W.decodeBundle(e.data));
}

test('engine.io version: the readiness and cork reasoning was checked against 6.6.11 only', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'engine.io', 'package.json'), 'utf8'));
  assert.strictEqual(pkg.version, SQ.ENGINE_IO_VERSION);
  assert.strictEqual(SQ.ENGINE_IO_VERSION, '6.6.11');
});

test('tagOf: kinds and what each record adds or removes (literal vectors)', () => {
  const K = SQ.KIND;
  assert.deepStrictEqual(SQ.tagOf({ type: 'init' }, 5), [K.OWN, 0, 0, 0, null]);
  assert.deepStrictEqual(SQ.tagOf({ type: 'pong' }, 5), [K.PONG, 0, 0, 0, null]);
  assert.deepStrictEqual(SQ.tagOf({ type: 'snake_add', id: 5 }, 5), [K.OWN, 1, 1, 5, null]);
  assert.deepStrictEqual(SQ.tagOf({ type: 'snake_add', id: 9 }, 5), [K.ADD, 1, 1, 9, null]);
  assert.deepStrictEqual(SQ.tagOf({ type: 'snake_remove', id: 9, kill: true }, 5), [K.REMOVE, 1, -1, 9, null]);
  assert.deepStrictEqual(SQ.tagOf({ type: 'snake_move', id: 5 }, 5), [K.OWN, 0, 0, 0, null]);
  assert.deepStrictEqual(SQ.tagOf({ type: 'snake_move', id: 9 }, 5), [K.OTHER, 0, 0, 0, null]);
  assert.deepStrictEqual(SQ.tagOf({ type: 'food_sector', sx: 3, sy: 4 }, 5), [K.ADD, 2, 1, 772, null]);
  assert.deepStrictEqual(SQ.tagOf({ type: 'sector_remove', sx: 3, sy: 4 }, 5), [K.REMOVE, 2, -1, 772, null]);
  assert.deepStrictEqual(SQ.tagOf({ type: 'prey_add', id: 70 }, 5), [K.ADD, 3, 1, 70, null]);
  assert.deepStrictEqual(SQ.tagOf({ type: 'prey_remove', id: 70 }, 5), [K.REMOVE, 3, -1, 70, null]);
  assert.deepStrictEqual(SQ.tagOf({ type: 'prey_eaten', id: 70, eater: 9 }, 5), [K.OTHER, 3, -1, 70, null]);
  assert.deepStrictEqual(SQ.tagOf({ type: 'leaderboard' }, 5), [K.LATEST, 0, 0, 0, 'l']);
  assert.deepStrictEqual(SQ.tagOf({ type: 'flux' }, 5), [K.LATEST, 0, 0, 0, 'z']);
  assert.deepStrictEqual(SQ.tagOf({ type: 'minimap' }, 5), [K.MAP, 0, 0, 0, null]);
  assert.deepStrictEqual(SQ.tagOf({ type: 'dead' }, 5), [K.OWN, 0, 0, 0, null]);
  assert.deepStrictEqual(SQ.tagOf({ type: 'food_eat' }, 5), [K.OTHER, 0, 0, 0, null]);
});

test('ready: transport writable, empty writeBuffer and not ackLate; a polling GET parks, a send unparks', () => {
  let now = 0;
  const sock = fakeSocket('polling', () => now);
  const q = SQ.createSendQueue(LAWS, { socket: sock, ownId: 5, clock: () => now });
  assert.strictEqual(q.ready(now), false, 'no GET parked');
  pushEv(q, 1, otherRot(9));
  assert.strictEqual(q.flush(now), false);
  sock.conn.transport.park(); // the queue's ready listener flushes at once
  assert.strictEqual(frames(sock).length, 1);
  assert.strictEqual(sock.conn.transport.writable, false, 'the response used the GET');
  sock.conn.transport.writable = true;
  sock.conn.writeBuffer.push({ name: 'other' });
  assert.strictEqual(q.ready(now), false, 'engine.io still holds packets');
});

test('sl:x goes before sl:f, and both leave in ONE polling response (the cork)', () => {
  let now = 0;
  const sock = fakeSocket('polling', () => now);
  const q = SQ.createSendQueue(LAWS, { socket: sock, ownId: 5, clock: () => now });
  pushEv(q, 1, otherRot(9));
  q.message(1, { t: 'cashed', len: 10 });
  sock.conn.transport.park();
  assert.deepStrictEqual(sock.emitted.map((e) => e.name), ['sl:x', 'sl:f']);
  const sends = sock.conn.transport.sends;
  assert.strictEqual(sends.length, 1, 'one transport.send');
  assert.deepStrictEqual(sends[0].packets.map((p) => p.name + ':' + (p.part || 'json')), ['sl:x:json', 'sl:f:header', 'sl:f:attachment']);
});

// The polling model: one-way R / 2; the client re-polls the moment a response arrives; pings go one at a time when
// the pong came back and 250 ms after the previous ping (slInput.js:257-265); one record per tick of P.
function pollingRun(R, simMs, cork) {
  let now = 0;
  const sock = fakeSocket('polling', () => now);
  const t = sock.conn.transport;
  // without a cork: a socket whose conn has no flush (corkedEmit then emits plainly)
  const qsock = cork ? sock : {
    id: sock.id,
    emit: (n, d) => sock.emit(n, d),
    disconnect: () => sock.disconnect(),
    conn: { get transport() { return sock.conn.transport; }, get writeBuffer() { return sock.conn.writeBuffer; },
      on: (e, f) => sock.conn.on(e, f), removeListener: (e, f) => sock.conn.removeListener(e, f) },
  };
  const q = SQ.createSendQueue(LAWS, { socket: qsock, ownId: 5, clock: () => now });
  const events = []; // [time, kind, data]
  const at = (time, kind, data) => events.push([time, kind, data]);
  const fifo = []; // created time of every queued record, in order
  const ages = [];
  const pongWaits = [];
  let tick = 0;
  let lastPingSent = -Infinity;
  let pongPending = false;
  t.on('sent', (packets) => {
    for (const p of packets) {
      if (p.part === 'attachment') {
        const recs = W.decodeBundle(p.data);
        for (const r of recs) {
          const c = fifo.shift();
          if (r.type === 'pong') {
            pongWaits.push(now - c);
            at(now + R / 2, 'pongAtClient');
          } else {
            ages.push(now - c);
          }
        }
      }
    }
    at(now + R, 'get'); // the client re-polls as soon as this response lands
  });
  at(R / 2, 'get');
  at(0, 'ping');
  for (let k = 1; k * P <= simMs; k++) at(k * P, 'tick');
  while (events.length) {
    events.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1));
    const [time, kind] = events.shift();
    if (time > simMs) break;
    now = time;
    if (kind === 'tick') {
      tick++;
      fifo.push(now);
      pushEv(q, tick, otherRot(9));
      q.flush(now); // the end-of-wake flush
    } else if (kind === 'get') {
      t.park();
    } else if (kind === 'ping') {
      if (pongPending || now < lastPingSent + 250) continue;
      lastPingSent = now;
      pongPending = true;
      at(now + R / 2, 'pingAtServer');
    } else if (kind === 'pingAtServer') {
      fifo.push(now);
      q.pong(tick, now);
      q.flush(now); // the on-arrival setImmediate flush
    } else if (kind === 'pongAtClient') {
      pongPending = false;
      at(Math.max(now, lastPingSent + 250), 'ping');
    }
  }
  return { ages, pongWaits };
}

test('fake POLLING by GET arrival times: data age and pong wait at most R + P (never a poll plus a tick plus a poll)', () => {
  for (const R of [150, 300, 600]) {
    const r = pollingRun(R, 6000, true);
    assert.ok(r.ages.length > 100, 'records delivered');
    assert.ok(r.pongWaits.length > 3, 'pongs delivered');
    const maxAge = Math.max(...r.ages);
    const maxPong = Math.max(...r.pongWaits);
    assert.ok(maxAge <= R + P, 'R ' + R + ': max data age ' + maxAge + ' over R + P');
    assert.ok(maxPong <= R + P, 'R ' + R + ': max pong wait ' + maxPong + ' over R + P');
  }
});

test('without the cork the attachment waits a second poll (why the queue corks)', () => {
  const R = 300;
  const r = pollingRun(R, 6000, false);
  assert.ok(Math.max(...r.ages) > R + P, 'the split binary emit adds a poll');
});

test('real socket.io polling: one flush carries sl:x and the whole sl:f (cork against the installed engine.io)', async () => {
  const { Server } = require('socket.io');
  const ioc = require('socket.io-client');
  const server = http.createServer();
  const io = new Server(server, { transports: ['polling'] });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  const flushes = [];
  let plainFlushes = null;
  const done = new Promise((resolve, reject) => {
    io.of('/slt').on('connection', (socket) => {
      socket.conn.on('flush', (wbuf) => flushes.push(wbuf.length));
      const q = SQ.createSendQueue(LAWS, { socket, ownId: 5 });
      pushEv(q, 1, otherRot(9));
      pushEv(q, 1, rotEv(5, 33, true), true);
      q.message(1, { t: 'hold', id: 5, on: 1, need: 3000 });
      const go = () => {
        q.flush(Date.now()); // the queue's own 'ready' listener may have sent it already
        if (q.length || q.layerLength) return setTimeout(go, 5);
        // a control: two plain emits on the next parked GET split into two flushes
        const wait = () => {
          if (!(socket.conn.transport.writable && socket.conn.writeBuffer.length === 0)) return setTimeout(wait, 5);
          const before = flushes.length;
          socket.emit('sl:x', [{ t: 'chat' }]);
          socket.emit('sl:f', RC.bundleBytes([enc(otherRot(9))]));
          plainFlushes = flushes.slice(before);
        };
        wait();
      };
      go();
    });
    const c = ioc('http://127.0.0.1:' + port + '/slt', { transports: ['polling'], reconnection: false });
    const got = [];
    c.on('sl:x', (m) => got.push(['x', m]));
    c.on('sl:f', (b) => got.push(['f', W.decodeBundle(new Uint8Array(b))]));
    const timer = setTimeout(() => reject(new Error('timeout: ' + JSON.stringify(got))), 8000);
    const check = setInterval(() => {
      if (got.length >= 4) {
        clearInterval(check);
        clearTimeout(timer);
        c.close();
        resolve(got);
      }
    }, 10);
  });
  const got = await done;
  io.close();
  server.close();
  assert.strictEqual(got[0][0], 'x');
  assert.strictEqual(got[1][0], 'f');
  assert.deepStrictEqual(got[1][1].map((e) => e.type), ['snake_rot', 'snake_rot']);
  // the corked flush: sl:x (1 packet) + sl:f (header + attachment) in ONE engine.io flush
  assert.ok(flushes.indexOf(3) >= 0, 'one flush of 3 packets: ' + JSON.stringify(flushes));
  assert.ok(plainFlushes && plainFlushes[0] === 1, 'plain emits: the first flush carries one packet: ' + JSON.stringify(plainFlushes));
});

test('fake WebSocket with late pong acks: ackLate holds data in the queue and never kicks', () => {
  let now = 0;
  const sock = fakeSocket('websocket', () => now);
  const q = SQ.createSendQueue(LAWS, { socket: sock, ownId: 5, clock: () => now });
  // normal pings every 250 ms (fast link): the median interval is 250, so the limit is max(600, 2 x 250) = 600
  for (let k = 0; k < 8; k++) {
    now = k * 250;
    q.pong(1, now);
    assert.strictEqual(q.flush(now), true);
  }
  const lastPong = now;
  // the downstream now hides 3 s in the kernel buffer: no ping comes back for 3 s, ticks keep coming, and the player's
  // inputs keep arriving (the upstream is healthy, only the pong is late)
  let held = 0;
  for (now = lastPong + P; now < lastPong + 3000; now += P) {
    q.heard(now);
    pushEv(q, 2, otherRot(9));
    if (!q.flush(now)) held++;
    assert.strictEqual(q.checkStall(now), false, 'the transport is ready: never a stall kick');
  }
  assert.ok(q.ackLate(lastPong + 700), 'late after max(600, 2 x median)');
  assert.ok(!q.ackLate(lastPong + 500));
  assert.ok(held > 40, 'data held while late: ' + held);
  assert.ok(q.stats.ackLateHolds > 0);
  assert.strictEqual(sock.disconnected, false);
  assert.strictEqual(q.stats.kicks, 0);
  // the ping arrives: the pong is owed, so the queue is not late, and everything leaves in one bundle with the pong
  const n = q.length;
  q.pong(3, now);
  assert.strictEqual(q.flush(now), true);
  const last = frames(sock).pop();
  assert.strictEqual(last.length, n + 1);
  assert.strictEqual(last[last.length - 1].type, 'pong');
  // a hidden tab stops pinging: never late while hidden
  q.setHidden(true);
  assert.strictEqual(q.ackLate(now + 10000), false);
});

// Fixer pass (2026-10-10): a late UPSTREAM (a lost segment holds every upstream byte behind it) must not hold a
// healthy downstream. Pings every 250 ms on a fast link; then one ping and every input behind it land 600 ms late.
test('ackLate: an upstream-only delay (ping and inputs late together) holds nothing; inputs that keep coming without the ping do', () => {
  let now = 0;
  const sock = fakeSocket('websocket', () => now);
  const q = SQ.createSendQueue(LAWS, { socket: sock, ownId: 5, clock: () => now });
  for (let k = 0; k < 8; k++) {
    now = k * 250;
    q.heard(now);
    q.pong(1, now);
    assert.strictEqual(q.flush(now), true);
  }
  const lastPong = now;
  // the next ping would land at lastPong + 250; it and every input sent after lastPong land at lastPong + 850 instead
  let sent = 0;
  for (now = lastPong + P; now < lastPong + 850; now += P) {
    pushEv(q, 2, otherRot(9));
    if (q.flush(now)) sent++;
  }
  assert.strictEqual(q.stats.ackLateHolds, 0, 'nothing held while only the upstream is late');
  assert.ok(sent >= 19, 'every tick left: ' + sent);
  assert.strictEqual(q.ackLate(lastPong + 849), false);
  now = lastPong + 850;
  q.heard(now);
  q.pong(3, now);
  assert.strictEqual(q.flush(now), true);
  // the same silence, but an input lands after the deadline while the ping does not: the client never got the pong
  const pong2 = now;
  q.heard(pong2 + 650);
  assert.strictEqual(q.ackLate(pong2 + 650), true, 'upstream flows, ping missing: the downstream is late');
  pushEv(q, 4, otherRot(9));
  assert.strictEqual(q.flush(pong2 + 650), false);
  assert.strictEqual(q.stats.ackLateHolds, 1);
  // an input that came before the deadline proves nothing
  const q2 = SQ.createSendQueue(LAWS, { socket: fakeSocket('websocket', () => now), ownId: 5, clock: () => now });
  q2.pong(1, 0);
  q2.flush(0);
  q2.heard(500);
  assert.strictEqual(q2.ackLate(5000), false, 'only an arrival after the 600 ms limit counts');
});

// A client mirror of the own wanted angle: their client overwrites o.wang on every own rotation record with a wang
// (slApply.js:567-570), in order.
function ownWang(bundles) {
  let w = null;
  for (const b of bundles) for (const e of b) if (e.type === 'snake_rot' && e.own && e.wang !== undefined) w = e.wang;
  return w;
}

test('echo order across a not-ready tick, a drain and a new input: the client ends on the server wang', () => {
  let now = 0;
  const sock = fakeSocket('polling', () => now);
  const q = SQ.createSendQueue(LAWS, { socket: sock, ownId: 5, clock: () => now });
  const w = (raw) => raw * PI2 / 256;
  // tick 10 (not ready): the sim's own rotation with wang 40
  pushEv(q, 10, rotEv(5, 40, true), true);
  // an input arrives: echo 50
  q.echo(10, enc(rotEv(5, 50, true), true));
  // tick 11: the sim applied 50, its own record carries 50 again
  pushEv(q, 11, rotEv(5, 50, true), true);
  // two more inputs before the GET: 60 then 70; the queued echo is replaced and goes LAST
  q.echo(11, enc(rotEv(5, 60, true), true));
  q.echo(11, enc(rotEv(5, 70, true), true));
  assert.strictEqual(q.stats.echoReplaced, 2);
  sock.conn.transport.park(); // the drain
  let got = frames(sock);
  assert.strictEqual(got.length, 1);
  assert.deepStrictEqual(got[0].map((e) => Math.round(e.wang * 256 / PI2)), [40, 50, 70]);
  // a new input after the drain (not ready again): echo 90, then the tick that applies it
  q.echo(12, enc(rotEv(5, 90, true), true));
  pushEv(q, 12, rotEv(5, 90, true), true);
  sock.conn.transport.park();
  got = frames(sock);
  assert.strictEqual(ownWang(got), w(90), 'the client ends on the server wang');
});

function mirror(bundles) {
  const m = { snakes: new Set(), sectors: new Set(), preys: new Set() };
  for (const b of bundles) {
    for (const e of b) {
      assert.notStrictEqual(e.type, 'wire_error');
      if (e.type === 'snake_add') m.snakes.add(e.id);
      else if (e.type === 'snake_remove') m.snakes.delete(e.id);
      else if (e.type === 'food_sector') m.sectors.add(e.sx * 256 + e.sy);
      else if (e.type === 'sector_remove') m.sectors.delete(e.sx * 256 + e.sy);
      else if (e.type === 'prey_add') m.preys.add(e.id);
      else if (e.type === 'prey_remove') m.preys.delete(e.id);
    }
  }
  return m;
}

function preyEv(id) {
  return { type: 'prey_add', id, cv: 2, xx: 500, yy: 600, rad: 3, dir: 1, wang: 0, ang: 0, sp: 4 };
}

test('resync with a queued leave and a death: zero ghosts; a second cap hit within 10 s kicks', () => {
  const L = makeFixture({ C_PENDING_CAP: 400 });
  let now = 0;
  const sock = fakeSocket('polling', () => now);
  const q = SQ.createSendQueue(L, { socket: sock, ownId: 5, clock: () => now });
  // delivered: the own snake, snakes 10, 11, 12, sector (3, 4), prey 70
  for (const id of [5, 10, 11, 12]) pushEv(q, 1, addEv(id), id === 5);
  pushEv(q, 1, { type: 'food_sector', sx: 3, sy: 4, foods: [{ cv: 1, rx: 10, ry: 20, rad: 2 }] });
  pushEv(q, 1, preyEv(70));
  sock.conn.transport.park();
  assert.deepStrictEqual(Array.from(q.delivered.snakes).sort((a, b) => a - b), [5, 10, 11, 12]);
  // not ready: an add, a leave (code 0), a death (code 1), a new sector and prey, own records, a pong, filler
  pushEv(q, 2, addEv(13));
  pushEv(q, 2, { type: 'snake_remove', id: 10, kill: false });
  pushEv(q, 2, { type: 'snake_remove', id: 11, kill: true });
  pushEv(q, 2, { type: 'food_sector', sx: 5, sy: 5, foods: [{ cv: 2, rx: 1, ry: 2, rad: 2 }] });
  pushEv(q, 2, preyEv(71));
  pushEv(q, 2, rotEv(5, 12, true), true);
  q.pong(2, now);
  q.message(2, { t: 'kill', killer: 'a', victim: 'b' });
  let k = 0;
  while (q.bytes <= q.Q.cap) pushEv(q, 3, otherRot(200 + (k++ % 50)));
  now = 1000;
  assert.strictEqual(q.checkCap(3, now), 'resync');
  // kept: the two removals, the own rotation and the pong, then the resync removals
  const types = [];
  // the view re-adds what is still in view: snake 12, a new 14, sector (3, 4)
  pushEv(q, 3, addEv(12));
  pushEv(q, 3, addEv(14));
  pushEv(q, 3, { type: 'food_sector', sx: 3, sy: 4, foods: [{ cv: 1, rx: 10, ry: 20, rad: 2 }] });
  sock.conn.transport.park();
  const all = frames(sock);
  for (const e of all[1]) types.push(e.type);
  assert.deepStrictEqual(types.slice(0, 4), ['snake_remove', 'snake_remove', 'snake_rot', 'pong']);
  const m = mirror(all);
  assert.deepStrictEqual(Array.from(m.snakes).sort((a, b) => a - b), [5, 12, 14], 'no ghost snake');
  assert.deepStrictEqual(Array.from(m.sectors), [3 * 256 + 4], 'no ghost sector');
  assert.deepStrictEqual(Array.from(m.preys), [], 'no ghost prey');
  assert.strictEqual(sock.emitted.filter((e) => e.name === 'sl:x').length, 1, 'layer messages kept');
  // a second cap hit inside C_RESYNC_GAP_MS is a stall kick
  while (q.bytes <= q.Q.cap) pushEv(q, 4, otherRot(300));
  now = 1000 + 9999;
  assert.strictEqual(q.checkCap(4, now), 'kick');
  assert.strictEqual(sock.disconnected, true);
  assert.strictEqual(q.closed, true);
});

// Fixer pass (2026-10-10, T15's finding): an eaten prey leaves the client, so a resync after its delivered prey_eaten
// sends no prey_remove for it; a prey_eaten the resync dropped (never delivered) still gets its prey_remove.
test('resync after a delivered prey_eaten: no prey_remove for that prey; an undelivered prey_eaten keeps it', () => {
  let now = 0;
  const sock = fakeSocket('polling', () => now);
  const q = SQ.createSendQueue(LAWS, { socket: sock, ownId: 5, clock: () => now });
  pushEv(q, 1, preyEv(70));
  pushEv(q, 1, preyEv(71));
  pushEv(q, 1, preyEv(72));
  sock.conn.transport.park();
  assert.deepStrictEqual(Array.from(q.delivered.preys).sort((a, b) => a - b), [70, 71, 72]);
  pushEv(q, 2, { type: 'prey_eaten', id: 70, eater: 9 });
  sock.conn.transport.park();
  assert.deepStrictEqual(Array.from(q.delivered.preys).sort((a, b) => a - b), [71, 72], 'delivery took 70 out');
  pushEv(q, 3, { type: 'prey_eaten', id: 71, eater: 9 }); // queued, then dropped by the resync
  const out = q.resync(3, now);
  assert.deepStrictEqual(out.preys, [71, 72]);
  sock.conn.transport.park();
  const last = frames(sock).pop();
  assert.deepStrictEqual(last.filter((e) => e.type === 'prey_remove').map((e) => e.id), [71, 72]);
  assert.strictEqual(last.filter((e) => e.type === 'prey_eaten').length, 0, 'the dropped eat never left');
});

test('a cap hit after C_RESYNC_GAP_MS resyncs again; a minimap replaced while queued goes full; latest values coalesce', () => {
  const L = makeFixture({ C_PENDING_CAP: 300 });
  let now = 0;
  const sock = fakeSocket('polling', () => now);
  const q = SQ.createSendQueue(L, { socket: sock, ownId: 5, clock: () => now });
  while (q.bytes <= q.Q.cap) pushEv(q, 1, otherRot(9));
  assert.strictEqual(q.checkCap(1, 0), 'resync');
  while (q.bytes <= q.Q.cap) pushEv(q, 2, otherRot(9));
  assert.strictEqual(q.checkCap(2, 10001), 'resync');
  assert.strictEqual(sock.disconnected, false);
  // latest-value records replaced in place
  const q2 = SQ.createSendQueue(L, { socket: bareSocket(), ownId: 5, clock: () => now });
  const lb = (n) => ({ type: 'leaderboard', myPos: n, rank: n, count: n, rows: [] });
  pushEv(q2, 1, lb(1));
  pushEv(q2, 1, otherRot(9));
  pushEv(q2, 2, lb(2));
  pushEv(q2, 2, { type: 'flux', fluxGrd: 3000 });
  pushEv(q2, 3, { type: 'flux', fluxGrd: 3001 });
  assert.strictEqual(q2.length, 3);
  assert.strictEqual(q2.stats.latestReplaced, 2);
  // a minimap pushed while an older one is still queued: the older goes and the newer is sent as its full form
  const mFull = new Uint8Array([99]);
  q2.push(3, { type: 'minimap' }, new Uint8Array([1]));
  q2.push(4, { type: 'minimap' }, new Uint8Array([2]), mFull);
  assert.strictEqual(q2.length, 4);
  assert.strictEqual(q2.stats.mapsToFull, 1);
  q2.flush(now);
  const b = q2.stats.bytes;
  assert.ok(b > 0);
});

test('stall kick: the transport not ready for longer than C_STALL_KICK_MS (15000)', () => {
  let now = 0;
  const sock = fakeSocket('polling', () => now);
  const q = SQ.createSendQueue(LAWS, { socket: sock, ownId: 5, clock: () => now });
  assert.strictEqual(q.checkStall(0), false);
  assert.strictEqual(q.checkStall(15000), false);
  sock.conn.transport.park();
  assert.strictEqual(q.checkStall(15001), false, 'ready resets the clock');
  sock.conn.transport.writable = false;
  assert.strictEqual(q.checkStall(16000), false);
  assert.strictEqual(q.checkStall(31000), false);
  assert.strictEqual(q.checkStall(31001), true);
  assert.strictEqual(sock.disconnected, true);
});

// Fixer pass (2026-10-10): a healthy long-polling seat whose round trip is above one tick. Each GET comes back R ms
// after the response that used the previous one; the queue's own 'ready' listener answers it at once (a tick's records
// are always queued), so no GET is ever parked at a wake. Wakes every P push records and run checkStall, as slRoom's
// seat part does. stopAt: the client stops polling from then on (the GETs never come back).
function pollingStallRun(R, runMs, stopAt) {
  let now = 0;
  const sock = fakeSocket('polling', () => now);
  const t = sock.conn.transport;
  const q = SQ.createSendQueue(LAWS, { socket: sock, ownId: 5, clock: () => now });
  const events = [];
  const at = (time, kind) => events.push([time, kind]);
  t.on('sent', () => at(now + R, 'get'));
  at(R / 2, 'get');
  for (let k = 1; k * P <= runMs; k++) at(k * P, 'tick');
  let kickedAt = NaN;
  let parkedAtWake = 0;
  let tick = 0;
  while (events.length) {
    events.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1));
    const [time, kind] = events.shift();
    now = time;
    if (kind === 'get') {
      if (now < stopAt) t.park();
    } else {
      tick++;
      pushEv(q, tick, rotEv(5, tick % 256, true), true);
      if (q.transportReady()) parkedAtWake++;
      if (q.checkStall(now)) {
        kickedAt = now;
        break;
      }
      q.flush(now);
    }
  }
  return { kickedAt, parkedAtWake, kicks: q.stats.kicks, disconnected: sock.disconnected, bundles: frames(sock).length };
}

test('stall kick: a healthy polling seat at a 150 or 300 ms round trip is never kicked in 60 s (GETs never parked at a wake)', () => {
  for (const R of [150, 300]) {
    const r = pollingStallRun(R, 60000, Infinity);
    assert.strictEqual(r.parkedAtWake, 0, 'R ' + R + ': the case under test (no GET parked at any wake)');
    assert.strictEqual(r.kicks, 0, 'R ' + R + ': kicked at ' + r.kickedAt);
    assert.strictEqual(r.disconnected, false);
    assert.ok(r.bundles > 60000 / (R + P) * 0.9, 'R ' + R + ': bundles kept flowing: ' + r.bundles);
  }
});

test('stall kick: the same seat whose GETs stop is kicked about C_STALL_KICK_MS (15000) later', () => {
  const r = pollingStallRun(300, 60000, 20000);
  assert.strictEqual(r.kicks, 1);
  assert.strictEqual(r.disconnected, true);
  // the last GET lands before 20000 + 300; the first wake after it starts the clock; the kick is the first wake past 15000
  assert.ok(r.kickedAt > 20000 + 15000 - 300 && r.kickedAt <= 20000 + 300 + 15000 + 2 * P, 'kicked at ' + r.kickedAt);
});

test('upgrade: the ready listener moves to the new transport', () => {
  let now = 0;
  const sock = fakeSocket('polling', () => now);
  const q = SQ.createSendQueue(LAWS, { socket: sock, ownId: 5, clock: () => now });
  const { FakeTransport } = require('./slNetFakes');
  const ws = new FakeTransport('websocket', () => now);
  sock.conn.upgrade(ws);
  pushEv(q, 1, otherRot(9));
  ws.writable = true;
  ws.emit('ready');
  assert.strictEqual(frames(sock).length, 1);
  assert.strictEqual(q.stats.readyFlushes, 1);
});

test('pongs: one per ping, in order with everything else; rttP95 from the ping intervals or the layer report', () => {
  const sock = bareSocket();
  const q = SQ.createSendQueue(LAWS, { socket: sock, ownId: 5 });
  q.pong(1, 0);
  pushEv(q, 1, otherRot(9));
  q.pong(1, 300);
  q.pong(1, 700);
  q.flush(800);
  const b = frames(sock)[0];
  assert.deepStrictEqual(b.map((e) => e.type), ['pong', 'snake_rot', 'pong', 'pong']);
  assert.strictEqual(q.medianPingGap(), 350);
  assert.ok(Math.abs(q.rttP95() - 395) < 1e-9); // p95 of [300, 400] = 300 + 0.95 x 100
  q.reportRtt(222);
  assert.strictEqual(q.rttP95(), 222);
});
