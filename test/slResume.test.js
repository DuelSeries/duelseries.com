'use strict';
// Reconnect and resume after a connection blip (task T16b; Owen Q10 "glide 3 s from the start": the snake glides
// straight about 3 s while the page reconnects, the player KEEPS it if back in time, else it dies as before).
// server/sl/slResume.js (the C_RESUME row, the key, the shapes, the per-address gate), slSendQueue (retention, detach,
// attach, resume), slRoom (park, resume, takeover, the previous key), slSockets (sl:back, 'gone', 'taken', 'flood').
//
// The room runs the REAL sim, view and send queue (test/slSockFakes.js rig: the FIXTURE table, a fake clock, no bots,
// no prey) behind the real slSockets on fake socket.io sockets. A scripted client receives each sl:f three wakes after
// it left (about 130 ms), keeps one ping in flight like their client (slInput.js:257-265), and on a blip loses every
// bundle not yet received. The checks: the own records the client applied form the server's own stream with no gap
// and no repeat (the lost bundles' own records are replayed first, exactly once), every ping got exactly one pong, and
// what the client holds (snakes, sectors) is exactly what the queue believes it delivered (no ghost, nothing missing).
const test = require('node:test');
const assert = require('node:assert');
const W = require('../shared/slWire.js');
const { rig, layerMsgs } = require('./slSockFakes');
const { bareSocket } = require('./slNetFakes');
const { makeFixture } = require('./slLawsFixture');
const R = require('../server/sl/slResume');
const Q = require('../server/sl/slSendQueue');
const { encodeRecord } = require('../server/sl/slRecordCache');
const slSnake = require('../server/sl/slSnake');

const PI2 = 2 * Math.PI;
const DELAY = 3; // wakes between a bundle leaving and the client applying it
const KEY_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function frames(s) {
  return s.emitted.filter((e) => e.name === 'sl:f').map((e) => e.data);
}
function keysOf(s) {
  return layerMsgs(s).filter((m) => m.t === 'seat' || m.t === 'back');
}
function refusal(s) {
  const m = layerMsgs(s).find((x) => x.t === 'refused');
  return m ? m.why : null;
}
const isOwn = (ev, own) => Q.tagOf(ev, own)[0] === Q.KIND.OWN;

// A scripted client of one life over any number of sockets.
function makeClient(r, ip) {
  const room = r.room();
  const c = {
    socks: [], cur: null, down: false, n: 0, p: 0, waiting: false, lastPing: -1e9, wake: 0, got: [], pongs: 0,
    key: null, seat: null, own: 0, sockN: [],
  };
  c.connect = function () {
    const s = r.sock({ ip: ip || '10.0.0.1' });
    s._seen = 0;
    s._stamp = [];
    c.socks.push(s);
    return s;
  };
  c.join = function (nick) {
    const s = c.connect();
    s.fire('sl:join', { nick: nick || 'Owen' });
    c.cur = s;
    c.seat = room.seatOf(s.id);
    c.own = c.seat.snakeId;
    c.stamp();
    c.readKey(s);
    return s;
  };
  c.readKey = function (s) {
    const k = keysOf(s);
    if (k.length) c.key = k[k.length - 1].k;
  };
  c.stamp = function () {
    for (const s of c.socks) {
      const n = frames(s).length;
      while (s._stamp.length < n) s._stamp.push(c.wake);
    }
  };
  c.receive = function (all) {
    const s = c.cur;
    if (!s || c.down) return;
    const f = frames(s);
    while (s._seen < f.length && (all || s._stamp[s._seen] <= c.wake - DELAY)) {
      const evs = W.decodeBundle(f[s._seen]);
      s._seen++;
      c.n++;
      for (const e of evs) {
        c.got.push(e);
        if (e.type === 'pong') {
          c.pongs++;
          c.waiting = false;
        }
      }
    }
    c.readKey(s);
  };
  // their client's ping clock: one in flight, 250 ms apart; while down it still "sends" (counted, never delivered)
  c.ping = function (now) {
    if (c.quiet || c.waiting || now - c.lastPing < 250) return;
    c.lastPing = now;
    c.waiting = true;
    c.p++;
    if (!c.down) c.cur.fire('sl:i', W.encodeInput([{ type: 'ping' }]));
  };
  c.input = function (recs) {
    if (!c.down) c.cur.fire('sl:i', W.encodeInput(recs));
  };
  // a blip: every bundle not yet applied is lost; seen: the server sees the drop (else it keeps the old socket)
  c.blip = function (seen) {
    c.down = true;
    c.sockN.push(c.n);
    if (seen) {
      c.cur.disconnected = true;
      c.cur.fire('disconnect', 'transport close');
    }
  };
  c.back = function (key) {
    const s = c.connect();
    s.fire('sl:back', { k: key === undefined ? c.key : key, n: c.n, p: c.p });
    c.stamp();
    if (!refusal(s)) {
      c.cur = s;
      c.down = false;
      c.readKey(s);
    }
    return s;
  };
  return c;
}

// Drives the room: wakes every P ms, the client's ping clock, an optional steer, the wall clock with it.
function makeDriver(r, c) {
  const room = r.room();
  const t0 = r.ft.clock();
  const d = { now: () => r.ft.clock() - t0 };
  d.run = function (ms, each) {
    const end = d.now() + ms;
    while (d.now() < end) {
      r.ft.advance(room.P);
      r.wall.t += room.P;
      room.wake();
      c.wake++;
      c.stamp();
      c.receive();
      if (c.seat && !c.seat.dead) c.ping(d.now());
      if (each) each(d.now());
      r.ft.runImmediates();
      c.stamp();
    }
  };
  return d;
}

// An angle toward the map centre, so a run of a few seconds never meets the border.
function home(room, id) {
  const s = room.sim.snake(id);
  const grd = room.laws.L1.value;
  let a = Math.atan2(grd - slSnake.headY(s), grd - slSnake.headX(s));
  if (a < 0) a += PI2;
  return { type: 'angle', q: Math.round(a / PI2 * 251) % 251 };
}

// What the client holds by the queue's own model (tagOf what/op on every applied record), against the queue. Strict
// (verifier, 2026-10-11): a removal of a snake or prey the client does not hold, or a second add of one it holds, is
// counted (P1; scripts/slLoad.js fails it as unknownSnake, unknownPrey, doubleSnake, doublePrey). Sectors are not:
// their server removes a watched sector that never had food (L8.emptySector removeOnSweep, 696 of 10707 removals).
function heldBy(c) {
  const sets = { 1: new Set(), 2: new Set(), 3: new Set() };
  const bad = { unknown: { 1: 0, 3: 0 }, double: { 1: 0, 3: 0 }, samples: [] };
  for (const e of c.got) {
    const t = Q.tagOf(e, c.own);
    if (!t[1]) continue;
    if (t[2] === 1) {
      if (t[1] !== 2 && sets[t[1]].has(t[3])) {
        bad.double[t[1]]++;
        if (bad.samples.length < 8) bad.samples.push('double ' + e.type + ' ' + t[3]);
      }
      sets[t[1]].add(t[3]);
    } else if (t[2] === -1 && !sets[t[1]].delete(t[3]) && t[1] !== 2) {
      bad.unknown[t[1]]++;
      if (bad.samples.length < 8) bad.samples.push('unknown ' + e.type + ' ' + t[3]);
    }
  }
  sets.bad = bad;
  return sets;
}
function assertStrict(h) {
  assert.deepStrictEqual(h.bad.unknown, { 1: 0, 3: 0 }, 'no removal of an id the client does not hold: ' + h.bad.samples);
  assert.deepStrictEqual(h.bad.double, { 1: 0, 3: 0 }, 'no second add of an id the client holds: ' + h.bad.samples);
}
function assertNoGhosts(c) {
  c.receive(true);                                               // everything in flight lands
  const q = c.seat.queue;
  assert.strictEqual(q.length, 0, 'nothing queued');
  const h = heldBy(c);
  assertStrict(h);
  const sorted = (s) => Array.from(s).sort((a, b) => a - b);
  assert.deepStrictEqual(sorted(h[1]), sorted(q.delivered.snakes), 'snakes: the client holds what was delivered');
  assert.deepStrictEqual(sorted(h[2]), sorted(q.delivered.sectors), 'sectors: the client holds what was delivered');
  assert.deepStrictEqual(sorted(h[3]), sorted(q.delivered.preys), 'preys');
}

// The own records of the server's stream for the seat, logged at push from the moment of the call on (an own record
// pushed is never dropped: OWN is a kept kind). Echoes go through queue.echo, not push.
function logOwn(c) {
  const out = [];
  const q = c.seat.queue;
  const push0 = q.push;
  q.push = function (tick, ev, bytes, alt) {
    if (isOwn(ev, c.own)) out.push(JSON.stringify(W.decodeBundle(Uint8Array.of(W.VERSION, ...bytes))[0]));
    return push0.call(q, tick, ev, bytes, alt);
  };
  return out;
}
const ownOf = (evs, own) => evs.filter((e) => isOwn(e, own)).map((e) => JSON.stringify(e));

// ------------------------------------------------------------------------------------------------- slResume itself

test('C_RESUME: CHOSEN with its source; read once and checked; a table row wins; junk refused', () => {
  const row = R.RESUME_ROWS.C_RESUME;
  assert.strictEqual(row.status, 'CHOSEN');
  assert.ok(/OURS-SOAK/.test(row.source) && /3,567/.test(row.source), 'the measured resync bundle is cited');
  assert.deepStrictEqual(R.resumeLaws({}), { perSeat: { max: 10, windowMs: 60000 }, badKeys: { max: 20, windowMs: 60000 } });
  const v = (value) => ({ C_RESUME: Object.assign({}, row, { value }) });
  assert.deepStrictEqual(R.resumeLaws(v({ perSeat: { max: 2, windowMs: 5 }, badKeys: { max: 3, windowMs: 7 } })).perSeat,
    { max: 2, windowMs: 5 });
  assert.throws(() => R.resumeLaws(v({ perSeat: { max: 0, windowMs: 5 }, badKeys: { max: 3, windowMs: 7 } })), /perSeat.max/);
  assert.throws(() => R.resumeLaws(v({ perSeat: { max: 1.5, windowMs: 5 }, badKeys: { max: 3, windowMs: 7 } })), /perSeat.max/);
  assert.throws(() => R.resumeLaws(v({ perSeat: { max: 1, windowMs: 5 }, badKeys: { max: 3, windowMs: 7 }, x: 1 })), /not built/);
  assert.throws(() => R.resumeLaws(v(null)), /not \{perSeat, badKeys\}/);
});

test('keys: a fresh v4 UUID each time; only that exact shape is ever looked up; counts are whole numbers in range', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const k = R.makeKey();
    assert.ok(R.isKey(k) && KEY_SHAPE.test(k), k);
    seen.add(k);
  }
  assert.strictEqual(seen.size, 200);
  const k = R.makeKey();
  for (const bad of [k.toUpperCase(), k + ' ', ' ' + k, k.slice(1), k.replace(/-/g, ''), k.slice(0, 14) + '1' + k.slice(15),
    '', null, undefined, 7, {}, [k], { toString: () => k }, new String(k), k + '\u0000', 'x'.repeat(1e6)]) {
    assert.strictEqual(R.isKey(bad), false, String(bad).slice(0, 40));
  }
  assert.deepStrictEqual([0, 1, 2147483647].map(R.count), [0, 1, 2147483647]);
  for (const bad of [-1, 1.5, 2147483648, NaN, Infinity, '3', null, undefined, true, [1], -0.5]) assert.strictEqual(R.count(bad), null);
});

test('windows and the per-address bad key gate: full at max inside the window, clear after it, addresses apart', () => {
  const w = R.createWindow(3, 1000);
  assert.strictEqual(w.full(0), false);
  w.add(0); w.add(10); w.add(20);
  assert.strictEqual(w.full(500), true);
  assert.strictEqual(w.full(999), true, 'the first is still inside 999 ms after it');
  assert.strictEqual(w.full(1000), false, 'and out at windowMs');
  const ipOf = (s) => s.ip;
  const g = R.createBadKeyGate({ max: 2, windowMs: 100 }, ipOf);
  const a = { ip: '1.1.1.1' };
  const b = { ip: '2.2.2.2' };
  g.add(a, 0);
  assert.strictEqual(g.blocked(a, 1), false);
  g.add(a, 1);
  assert.strictEqual(g.blocked(a, 2), true);
  assert.strictEqual(g.blocked(b, 2), false, 'another address is not affected');
  assert.strictEqual(g.blocked(a, 101), false, 'the window cleared');
  // many addresses: the map never passes MAX_ADDRESSES, and adding stays cheap (no full sweep per add)
  const many = R.createBadKeyGate({ max: 20, windowMs: 60000 }, ipOf);
  for (let i = 0; i < 20; i++) many.add({ ip: 'v6:0' }, 0);
  assert.strictEqual(many.blocked({ ip: 'v6:0' }, 0), true);
  const t0 = Date.now();
  for (let i = 1; i < R.MAX_ADDRESSES + 5000; i++) many.add({ ip: 'v6:' + i }, i / 100);
  assert.strictEqual(many.addresses(), R.MAX_ADDRESSES);
  assert.ok(Date.now() - t0 < 5000, 'took ' + (Date.now() - t0) + ' ms');
  assert.strictEqual(many.blocked({ ip: 'v6:0' }, 1), false, 'the oldest address went first');
});

// ------------------------------------------------------------------------------------------------- the send queue

function queueRig(cap) {
  const laws = makeFixture(cap ? { C_PENDING_CAP: cap } : {});
  const sock = bareSocket();
  const q = Q.createSendQueue(laws, { socket: sock, ownId: 5, clock: () => 0 });
  const rec = (ev) => encodeRecord(ev, ev.own === true, 15);
  const mv = (x) => ({ type: 'snake_move', own: true, cmd: 'rel', dx: x, dy: 0 });
  return { q, sock, rec, mv, laws };
}

test('queue: own records, pongs and removals are retained until a ping proves their bundle arrived', () => {
  const { q, sock } = queueRig();
  const own = { type: 'kill_count', id: 5, count: 1 };
  const other = { type: 'leaderboard', rank: 1, count: 1, rows: [] };
  const okBytes = (ev) => encodeRecord(ev, false, 15);
  q.push(1, own, okBytes(own));
  q.pong(1, 0);
  q.flush(0);                                                    // bundle 1: own + pong
  q.push(2, own, okBytes(own));
  q.push(2, { type: 'snake_remove', id: 9, kill: false }, okBytes({ type: 'snake_remove', id: 9, kill: false }));
  q.flush(0);                                                    // bundle 2: own + remove
  assert.strictEqual(q.sentSeq, 2);
  assert.strictEqual(q.keptLength, 4);
  q.pong(3, 10);                                                 // proves bundle 1 (the last pong left in it)
  assert.strictEqual(q.keptLength, 2, 'bundle 1 let go');
  q.flush(10);                                                   // bundle 3: the pong
  q.pong(4, 20);                                                 // proves bundle 3, so 2 as well
  assert.strictEqual(q.keptLength, 0);
  assert.strictEqual(sock.emitted.filter((e) => e.name === 'sl:f').length, 3);
  void other;
});

test('queue resume: the lost bundles\' kept records go first, once, in order; a lost ping gets one pong; then the resync', () => {
  const { q } = queueRig();
  const okBytes = (ev) => encodeRecord(ev, false, 15);
  const ev = (n) => ({ type: 'kill_count', id: 5, count: n });
  const add = { type: 'snake_add', id: 9, ang: 0, wang: 0, sp: 1, fam: 0, cv: 3, snx: 100, sny: 100, nick: 'n',
    raw: { pts: [{ x: 500, y: 500 }, { bx: 127, by: 127 }] } };
  q.push(1, ev(1), okBytes(ev(1)));
  q.push(1, add, okBytes(add));
  q.flush(0);                                                    // 1: the client got it
  q.push(2, ev(2), okBytes(ev(2)));
  q.pong(2, 0);
  q.flush(0);                                                    // 2: lost
  q.push(3, ev(3), okBytes(ev(3)));
  q.push(3, { type: 'snake_remove', id: 9, kill: false }, okBytes({ type: 'snake_remove', id: 9, kill: false }));
  q.flush(0);                                                    // 3: lost
  q.detach();
  assert.strictEqual(q.flush(0), false, 'detached: nothing leaves');
  q.push(4, ev(4), okBytes(ev(4)));                              // queued while away
  const s2 = bareSocket();
  assert.strictEqual(q.canResume(4), false, 'more bundles than were sent');
  assert.strictEqual(q.canResume(-1), false);
  assert.strictEqual(q.canResume(1.5), false);
  q.attach(s2);
  const out = q.resume(1, 2, 5, 0, [{ t: 'back', k: 'x', ms: 1 }]);
  assert.deepStrictEqual(out.snakes, [], 'snake 9 left in a replayed removal: nothing more to remove');
  q.flush(0);
  const x = s2.emitted.find((e) => e.name === 'sl:x');
  assert.deepStrictEqual(x.data[0], { t: 'back', k: 'x', ms: 1 }, 'the back leads');
  const b = W.decodeBundle(s2.emitted.find((e) => e.name === 'sl:f').data);
  assert.deepStrictEqual(b.map((e) => e.type + (e.count || '')),
    ['kill_count2', 'pong', 'kill_count3', 'snake_remove', 'kill_count4', 'pong']);
  assert.strictEqual(q.sentSeq, 2, 'the client\'s count and the server\'s agree again (1 + this bundle)');
  assert.strictEqual(q.stats.pongsAdded, 1, 'p 2 against 1 heard: one pong added');
});

test('queue: retention is capped (oldest first) and a resume from before what was dropped is refused', () => {
  const { q } = queueRig(4096);
  const okBytes = (ev) => encodeRecord(ev, false, 15);
  for (let i = 0; i < 2000; i++) {
    q.push(i, { type: 'kill_count', id: 5, count: i % 1000 }, okBytes({ type: 'kill_count', id: 5, count: i % 1000 }));
    q.flush(0);
  }
  assert.ok(q.keptBytes <= 4096, 'kept ' + q.keptBytes);
  assert.ok(q.lostThrough > 0);
  assert.strictEqual(q.canResume(q.lostThrough - 1), false);
  assert.strictEqual(q.canResume(q.lostThrough), true);
  assert.strictEqual(q.canResume(q.sentSeq), true);
});

test('queue: a detached queue over the cap resyncs, never kicks; a sticky layer message of a lost bundle comes back', () => {
  const { q } = queueRig(4096);
  const okBytes = (ev) => encodeRecord(ev, false, 15);
  q.message(1, { t: 'cashed', len: 77 }, true);
  q.message(1, { t: 'kill', killer: 'a', victim: 'b' });
  q.push(1, { type: 'dead', code: 0 }, okBytes({ type: 'dead', code: 0 }));
  q.flush(0);                                                    // 1: lost, with its cashed
  assert.strictEqual(q.keptLayerLength, 1);
  q.detach();
  const sec = (k) => ({ type: 'food_sector', sx: k, sy: 1, foods: [] });
  const over = () => {
    for (let i = 0; q.bytes <= 4096; i++) q.push(2, sec(i % 200), okBytes(sec(i % 200)));
  };
  over();
  assert.strictEqual(q.checkCap(2, 0), 'resync');
  assert.strictEqual(q.checkCap(2, 1), 'ok');
  over();
  assert.strictEqual(q.checkCap(2, 2), 'resync', 'inside C_RESYNC_GAP_MS: a seated queue would kick');
  assert.strictEqual(q.closed, false);
  const s2 = bareSocket();
  q.attach(s2);
  q.resume(0, 0, 3, 0, [{ t: 'back', k: 'y', ms: 1 }]);
  q.flush(0);
  const x = s2.emitted.find((e) => e.name === 'sl:x').data;
  assert.deepStrictEqual(x.slice(0, 2), [{ t: 'back', k: 'y', ms: 1 }, { t: 'cashed', len: 77 }]);
  assert.ok(!x.some((m) => m.t === 'kill'), 'a plain layer message of a lost bundle is not sent again');
  const b = W.decodeBundle(s2.emitted.find((e) => e.name === 'sl:f').data);
  assert.strictEqual(b[0].type, 'dead', 'the own death of the lost bundle first');
});

test('queue resume: what the lost bundles changed in the delivered set is undone exactly (an add never seen is not removed)', () => {
  const { q, rec } = queueRig();
  const add = (id) => ({ type: 'snake_add', id, ang: 0, wang: 0, sp: 1, fam: 0, cv: 3, snx: 100, sny: 100, nick: 'n',
    raw: { pts: [{ x: 500, y: 500 }, { bx: 127, by: 127 }] } });
  const rem = (id) => ({ type: 'snake_remove', id, kill: false });
  const food = (sx) => ({ type: 'food_add', rapid: false, sectorFromLast: false, sx, sy: 1, rx: 3, ry: 4, cvFromLast: false, cv: 2, rad: 10 });
  const sector = (sx) => ({ type: 'food_sector', sx, sy: 1, foods: [] });
  const send = (evs) => {
    for (const e of evs) q.push(1, e, rec(e));
    q.flush(0);
  };
  send([add(5), add(9), add(11), sector(7), { type: 'prey_add', id: 3, cv: 1, xx: 700, yy: 700, rad: 5, dir: 1, wang: 0, ang: 0, sp: 5 }]);
  //                                                             1: received (own 5, snakes 9 and 11, sector 7, prey 3)
  send([add(10), rem(9), food(7), food(8), { type: 'prey_eaten', id: 3, eater: 11 }]); // 2: lost
  send([rem(11), add(11), rem(10)]);                             // 3: lost (11 off and on again, 10 on and off)
  assert.ok(q.changesLength > 0);
  q.detach();
  const s2 = bareSocket();
  q.attach(s2);
  const out = q.resume(1, 0, 4, 0, []);
  assert.deepStrictEqual(out, { snakes: [], sectors: [7 * 256 + 1], preys: [3] },
    'the client holds 9, 11, sector 7 and prey 3: 9 and 11 go in their replayed removals, the rest here; 10 and sector 8 it never had');
  assert.strictEqual(q.changesLength, 0);
  q.flush(0);
  const b = W.decodeBundle(s2.emitted.find((e) => e.name === 'sl:f').data);
  const removed = b.filter((e) => e.type === 'snake_remove').map((e) => e.id);
  assert.deepStrictEqual(removed, [9, 11], 'each held snake removed once; the lost removal of 10 (never held) is dropped');
  assert.deepStrictEqual(b.filter((e) => e.type === 'sector_remove').map((e) => e.sx), [7]);
  assert.deepStrictEqual(b.filter((e) => e.type === 'prey_remove').map((e) => e.id), [3]);
  assert.deepStrictEqual(Array.from(q.delivered.snakes).sort((a, b2) => a - b2), [5], 'only the own snake is held now');
});

test('queue: the change log is let go with its bundles (the proof of a ping, or the retention cap)', () => {
  const { q, rec } = queueRig(4096);
  const sector = (sx) => ({ type: 'food_sector', sx, sy: 1, foods: [] });
  q.push(1, sector(1), rec(sector(1)));
  q.pong(1, 0);
  q.flush(0);
  q.push(2, sector(2), rec(sector(2)));
  q.push(2, sector(2), rec(sector(2)));                          // a second add of a held id changes nothing
  q.flush(0);
  assert.strictEqual(q.changesLength, 2);
  q.pong(3, 10);                                                 // proves bundle 1
  assert.strictEqual(q.changesLength, 1);
  for (let i = 0; i < 3000; i++) {
    const own = { type: 'kill_count', id: 5, count: i % 1000 };
    q.push(4, own, rec(own));
    q.push(4, sector(10 + (i % 150)), rec(sector(10 + (i % 150))));
    q.push(4, { type: 'sector_remove', sx: 10 + (i % 150), sy: 1 }, rec({ type: 'sector_remove', sx: 10 + (i % 150), sy: 1 }));
    q.flush(0);
  }
  assert.ok(q.lostThrough > 2);
  assert.ok(q.changesLength <= 2 * (q.sentSeq - q.lostThrough), 'only the bundles a resume could still need: ' + q.changesLength);
});

// ------------------------------------------------------------------------------------------------- the room and sockets

test('a seat gets its key (sl:x seat) on its own socket only; the window is the glide plus the dead seat limit', () => {
  const r = rig({ seed: 21 });
  const c = makeClient(r);
  const a = c.join('Owen');
  const other = makeClient(r, '10.0.0.2');
  other.join('Other');
  const k = keysOf(a);
  assert.strictEqual(k.length, 1);
  assert.strictEqual(k[0].t, 'seat');
  assert.ok(KEY_SHAPE.test(k[0].k));
  const laws = r.laws;
  assert.strictEqual(k[0].ms, laws.C_DISCONNECT.value.glideMs + laws.C_DEAD_SEAT_MS.value.noPingMs);
  assert.strictEqual(k[0].ms, 8000);
  assert.ok(!layerMsgs(other.socks[0]).some((m) => m.k === k[0].k), 'nobody else is told');
  assert.notStrictEqual(keysOf(other.socks[0])[0].k, k[0].k);
});

test('drop at 1 s and back at 2 s: the player KEEPS the snake; no gap, no repeat, every ping answered, no ghosts', () => {
  const r = rig({ seed: 22 });
  const room = r.room();
  const c = makeClient(r);
  const a = c.join('Owen');
  const id = c.own;
  const d = makeDriver(r, c);
  c.input([home(room, id)]);
  d.run(1000, (t) => { if (Math.floor(t / 300) !== Math.floor((t - room.P) / 300)) c.input([home(room, id)]); });
  const sentToA = frames(a).length;
  c.blip(true);
  const lostAtDrop = sentToA - c.n;
  assert.ok(lostAtDrop >= 1, 'bundles were in flight: ' + lostAtDrop);
  assert.strictEqual(room.parked.size, 1);
  assert.strictEqual(room.seats.size, 0);
  assert.ok(room.orphans.has(id), 'it glides');
  const after = logOwn(c);
  const s = room.sim.snake(id);
  const lock = Math.round(s.wang * 256 / PI2) & 255;
  d.run(1000);
  assert.ok(room.sim.snake(id), 'alive after a 1 s glide');
  assert.strictEqual(Math.round(s.wang * 256 / PI2) & 255, lock, 'straight while away');
  const k0 = c.key;
  const b = c.back();
  assert.strictEqual(refusal(b), null);
  assert.strictEqual(room.seatOf(b.id), c.seat, 'the same seat on the new socket');
  assert.strictEqual(c.seat.snakeId, id, 'the same snake');
  assert.ok(room.sim.snake(id), 'alive');
  assert.strictEqual(room.parked.size, 0);
  assert.ok(!room.orphans.has(id), 'the glide ended without a death');
  const x = layerMsgs(b);
  assert.strictEqual(x[0].t, 'back', 'back leads the first sl:x');
  assert.ok(KEY_SHAPE.test(x[0].k) && x[0].k !== k0, 'a new key');
  assert.strictEqual(c.key, x[0].k);
  d.run(600);
  // the stream: the lost bundles' own records came again first, exactly once, in order
  const lost = [];
  for (const f of frames(a).slice(c.sockN[0])) lost.push(...ownOf(W.decodeBundle(f), id));
  const onB = [];
  for (const f of frames(b)) onB.push(...ownOf(W.decodeBundle(f), id));
  assert.ok(lost.length > 0, 'own records were lost');
  assert.deepStrictEqual(onB.slice(0, lost.length), lost, 'replayed first, in order');
  // then every own record made since the drop, no gap and no repeat (no input since the drop: no echoes)
  assert.ok(after.length >= 3, 'own records were made while away and since: ' + after.length);
  assert.deepStrictEqual(onB.slice(lost.length), after);
  // steering works again
  c.input([{ type: 'angle', q: 100 }]);
  d.run(1000);
  assert.ok(room.sim.snake(id));
  assert.notStrictEqual(Math.round(s.wang * 256 / PI2) & 255, lock, 'the snake answers the new socket\'s input');
  c.quiet = true;                                                // no new ping: the one in flight lands
  d.run(300);
  assert.strictEqual(c.pongs, c.p, 'every ping got exactly one pong (' + c.p + ')');
  assert.ok(c.seat.queue.stats.pongsAdded + c.seat.queue.stats.replayed > 0);
  assertNoGhosts(c);
  assert.strictEqual(room.stats.backs, 1);
  assert.strictEqual(r.sockets.stats.backs, 1);
  assert.strictEqual(room.stats.glideDeaths, 0);
});

test('drop and back at 3.5 s: the snake died at the glide end; the client still gets its own death (the normal card)', () => {
  const r = rig({ seed: 23 });
  const room = r.room();
  const c = makeClient(r);
  c.join('Owen');
  const id = c.own;
  const d = makeDriver(r, c);
  c.input([home(room, id)]);
  d.run(600);
  c.blip(true);
  d.run(3500);
  assert.strictEqual(room.sim.snake(id), null, 'dead');
  assert.ok(c.seat.dead);
  assert.strictEqual(room.stats.glideDeaths, 1);
  assert.strictEqual(room.parked.size, 1, 'still parked for its own death');
  const b = c.back();
  assert.strictEqual(refusal(b), null);
  d.run(500);
  const deaths = c.got.filter((e) => e.type === 'dead');
  assert.strictEqual(deaths.length, 1, 'the own death arrived once');
  assert.strictEqual(room.stats.backsDead, 1);
  assertNoGhosts(c);
});

test('back after the window (8.5 s): refused gone, sl:x then disconnect; the seat and key are gone for good', () => {
  const r = rig({ seed: 24 });
  const room = r.room();
  const c = makeClient(r);
  c.join('Owen');
  const d = makeDriver(r, c);
  c.input([home(room, c.own)]);
  d.run(500);
  c.blip(true);
  d.run(8500);
  assert.strictEqual(room.parked.size, 0, 'dropped noPingMs after its death');
  assert.strictEqual(room.keys.size, 0);
  const b = c.back();
  assert.strictEqual(refusal(b), 'gone');
  assert.strictEqual(b.disconnected, true);
  assert.strictEqual(room.seats.size, 0);
  assert.strictEqual(r.sockets.stats.backsBad, 1);
});

test('two tabs fighting over one key: one seat between them, the other refused; the old key never works again', () => {
  const r = rig({ seed: 25 });
  const room = r.room();
  const c = makeClient(r);
  const a = c.join('Owen');
  const d = makeDriver(r, c);
  c.input([home(room, c.own)]);
  d.run(500);
  const k1 = c.key;
  c.blip(true);
  d.run(300);
  // two tabs present the same key: the first gets the seat, the second is refused
  const b = r.sock({ ip: '10.0.0.1' });
  const t2 = r.sock({ ip: '10.0.0.1' });
  b.fire('sl:back', { k: k1, n: c.n, p: c.p });
  t2.fire('sl:back', { k: k1, n: c.n, p: c.p });
  assert.strictEqual(room.seatOf(b.id), c.seat);
  assert.strictEqual(refusal(t2), 'gone');
  assert.strictEqual(t2.disconnected, true);
  assert.strictEqual(room.seatOf(t2.id), null);
  const k2 = keysOf(b)[0].k;
  // the winner is heard from: the old key is gone even if b drops again
  b.fire('sl:i', W.encodeInput([{ type: 'ping' }]));
  r.wall.t += 1000;
  // a third tab with the CURRENT key while b is live: it takes the seat over, b is refused taken (one seat, one tab)
  const t3 = r.sock({ ip: '10.0.0.1' });
  t3.fire('sl:back', { k: k2, n: frames(a).slice(0, c.n).length + frames(b).length, p: c.p + 1 });
  assert.strictEqual(room.seatOf(t3.id), c.seat, 'the current key takes the seat (a drop the server had not seen)');
  assert.strictEqual(refusal(b), 'taken');
  assert.strictEqual(b.disconnected, true);
  assert.strictEqual(room.seatOf(b.id), null, 'b\'s disconnect is a leave of nothing');
  assert.ok(room.sim.snake(c.own), 'the snake lives on');
  assert.strictEqual(room.parked.size, 0, 'b\'s close never parked the seat');
  // b (or anyone) with k1 or k2 now: gone
  for (const k of [k1, k2]) {
    const t = r.sock({ ip: '10.0.0.1' });
    t.fire('sl:back', { k, n: 0, p: 0 });
    assert.strictEqual(refusal(t), 'gone', 'an old key');
  }
  assert.strictEqual(room.stats.takeovers, 1);
  assert.strictEqual(r.sockets.stats.takeovers, 1);
  assert.strictEqual(r.sockets.gate.count('10.0.0.1'), 1, 'only t3 is charged to the address');
});

test('a resume the server had not seen the drop of: the new socket takes the seat, the old one is refused taken', () => {
  const r = rig({ seed: 26 });
  const room = r.room();
  const c = makeClient(r);
  const a = c.join('Owen');
  const id = c.own;
  const d = makeDriver(r, c);
  c.input([home(room, id)]);
  d.run(1000);
  c.blip(false);                                                 // the client's socket died; the server still flushes to a
  d.run(1000);
  assert.strictEqual(room.seatOf(a.id), c.seat, 'the server still has a');
  const b = c.back();
  assert.strictEqual(refusal(b), null);
  assert.strictEqual(refusal(a), 'taken');
  assert.strictEqual(a.disconnected, true);
  assert.strictEqual(room.seatOf(b.id), c.seat);
  assert.ok(room.sim.snake(id));
  d.run(1000);
  c.quiet = true;
  d.run(300);
  assert.strictEqual(c.pongs, c.p, 'every ping got exactly one pong');
  assertNoGhosts(c);
});

// The verifier's attack (2026-10-11): with bots around, a bundle lost in a blip carries snake_adds of other snakes.
// Before the change log, resume() undid only the lost removals, so the resync removed snakes the client never got:
// 2 to 4 unknown snake removals per parked resume and 3 to 7 per takeover, on every seed.
test('with bots: a resume after lost bundles never removes an id the client does not hold, parked or taken over', () => {
  let lostAdds = 0;
  for (const seed of [41, 42, 43]) {
    for (const kind of ['parked', 'takeover']) {
      const r = rig({ seed, bots: true });
      const room = r.room();
      const c = makeClient(r);
      c.join('Owen');
      const id = c.own;
      const d = makeDriver(r, c);
      const steer = (t) => {
        if (Math.floor(t / 300) !== Math.floor((t - room.P) / 300) && !c.down && room.sim.snake(id)) c.input([home(room, id)]);
      };
      c.input([home(room, id)]);
      d.run(4000, steer);
      assert.ok(room.sim.count() > 5, 'bots are in the room: ' + room.sim.count());
      c.blip(false);                                             // silent loss: the server still flushes to the old socket
      d.run(kind === 'parked' ? 1000 : 2000, steer);
      if (kind === 'parked') {
        c.socks[0].disconnected = true;                          // then it sees the drop and parks the seat
        c.socks[0].fire('disconnect', 'transport close');
        assert.strictEqual(room.parked.size, 1);
        d.run(500, steer);
      }
      for (const fr of frames(c.socks[0]).slice(c.sockN[0])) {
        for (const e of W.decodeBundle(fr)) if (e.type === 'snake_add' && e.id !== id) lostAdds++;
      }
      const b = c.back();
      const where = seed + ' ' + kind;
      assert.strictEqual(refusal(b), null, where);
      assert.ok(room.sim.snake(id), where + ': the snake is kept');
      d.run(2000, steer);
      c.quiet = true;
      d.run(400);
      c.receive(true);
      assertStrict(heldBy(c));
      assertNoGhosts(c);
      assert.strictEqual(c.pongs, c.p, where + ': every ping got exactly one pong');
    }
  }
  assert.ok(lostAdds >= 6, 'the lost bundles carried adds of other snakes: ' + lostAdds);
});

test('a lost back: the attempt socket dies before the client read it; the previous key brings the parked seat back', () => {
  const r = rig({ seed: 27 });
  const room = r.room();
  const c = makeClient(r);
  c.join('Owen');
  const d = makeDriver(r, c);
  c.input([home(room, c.own)]);
  d.run(500);
  c.blip(true);
  d.run(500);
  const k1 = c.key;
  const n = c.n;
  const b = r.sock({ ip: '10.0.0.1' });
  b.fire('sl:back', { k: k1, n, p: c.p });                       // resumed, 'back' k2 sent, never read
  assert.strictEqual(room.seatOf(b.id), c.seat);
  b.disconnected = true;
  b.fire('disconnect', 'transport close');                       // parked again, unheard
  assert.strictEqual(room.parked.size, 1);
  const t = r.sock({ ip: '10.0.0.1' });
  t.fire('sl:back', { k: k1, n, p: c.p });
  assert.strictEqual(refusal(t), null, 'the previous key, the seat parked and the new socket never heard from');
  assert.strictEqual(room.seatOf(t.id), c.seat);
  // once heard, the previous key is gone, even if the seat parks again
  t.fire('sl:i', W.encodeInput([{ type: 'ping' }]));
  t.disconnected = true;
  t.fire('disconnect', 'transport close');
  const u = r.sock({ ip: '10.0.0.1' });
  u.fire('sl:back', { k: k1, n, p: c.p });
  assert.strictEqual(refusal(u), 'gone');
  const k3 = keysOf(t)[0].k;
  const v = r.sock({ ip: '10.0.0.2' });
  v.fire('sl:back', { k: k3, n: n + frames(t).length, p: c.p + 1 });
  assert.strictEqual(refusal(v), null, 'the current key still works');
});

test('hostile sl:back: bad shapes, junk counts, getters, a second try, after a join: refused or ignored, nothing seated', () => {
  const r = rig({ seed: 28 });
  const room = r.room();
  const c = makeClient(r);
  c.join('Owen');
  const k = c.key;
  c.blip(true);
  const ip = (i) => '10.5.' + (i >> 8) + '.' + (i & 255);
  let i = 0;
  const tryBack = (msg) => {
    const s = r.sock({ ip: ip(i++) });
    s.fire('sl:back', msg);
    return s;
  };
  const getter = {};
  Object.defineProperty(getter, 'k', { get() { throw new Error('read'); }, enumerable: true });
  const proto = Object.create({ k, n: 0, p: 0 });
  const bad = [undefined, null, 5, 'x', k, [k, 0, 0], { k: k.toUpperCase(), n: 0, p: 0 }, { k: k + 'x', n: 0, p: 0 },
    { k: { toString: () => k }, n: 0, p: 0 }, { k, n: -1, p: 0 }, { k, n: 1.5, p: 0 }, { k, n: '0', p: 0 },
    { k, n: 2147483648, p: 0 }, { k, n: 0, p: -1 }, { k, n: 0, p: NaN }, { k, n: 0, p: 'a' }, { k }, getter, proto,
    { k, n: 999999, p: 0 }, { k: R.makeKey(), n: 0, p: 0 }];
  for (let j = 0; j < bad.length; j++) {
    const s = tryBack(bad[j]);
    assert.strictEqual(refusal(s), 'gone', 'hostile payload ' + j);
    assert.strictEqual(s.disconnected, true);
  }
  assert.strictEqual(room.seats.size, 0);
  assert.strictEqual(room.parked.size, 1, 'the real seat still waits');
  // once per socket, and never after a join
  const j = r.sock({ ip: ip(i++) });
  j.fire('sl:join', { nick: 'j' });
  j.fire('sl:back', { k, n: 0, p: 0 });
  assert.strictEqual(refusal(j), null, 'ignored');
  assert.ok(room.seatOf(j.id).snakeId !== c.own);
  const ok = r.sock({ ip: ip(i++) });
  ok.fire('sl:back', { k, n: c.n, p: c.p });
  assert.strictEqual(room.seatOf(ok.id), c.seat);
  ok.fire('sl:back', { k: keysOf(ok)[0].k, n: 0, p: 0 });
  ok.fire('sl:join', { nick: 'again' });
  assert.strictEqual(room.seatOf(ok.id), c.seat, 'a second sl:back or a join on that socket changes nothing');
  assert.strictEqual(room.seats.size, 2);
  // the money door: resumeKey in sl:join is still refused not-open
  const m = r.sock({ ip: ip(i++) });
  m.fire('sl:join', { nick: 'm', resumeKey: k });
  assert.strictEqual(refusal(m), 'not-open');
});

test('rate limits (C_RESUME): 20 unusable keys from one address block its sl:back for the window; 10 resumes of a seat a minute', () => {
  const r = rig({ seed: 29 });
  const room = r.room();
  const c = makeClient(r, '10.7.7.7');
  c.join('Owen');
  const k = c.key;
  c.blip(true);
  for (let i = 0; i < 20; i++) {
    const s = r.sock({ ip: '10.6.6.6' });
    s.fire('sl:back', { k: R.makeKey(), n: 0, p: 0 });
    assert.strictEqual(refusal(s), 'gone');
  }
  const blocked = r.sock({ ip: '10.6.6.6' });
  blocked.fire('sl:back', { k, n: c.n, p: c.p });
  assert.strictEqual(refusal(blocked), 'flood', 'even a good key from that address, inside the window');
  assert.strictEqual(room.parked.size, 1, 'and it did not take the seat');
  const elsewhere = r.sock({ ip: '10.7.7.7' });
  elsewhere.fire('sl:back', { k, n: c.n, p: c.p });
  assert.strictEqual(refusal(elsewhere), null, 'another address is not affected');
  r.wall.t += 60001;
  const later = r.sock({ ip: '10.6.6.6' });
  later.fire('sl:back', { k: R.makeKey(), n: 0, p: 0 });
  assert.strictEqual(refusal(later), 'gone', 'the window cleared: an answer, not flood');
  // per seat: ten resumes inside a minute, the eleventh is flood (and is not a bad key)
  let cur = elsewhere;
  let key = keysOf(cur)[0].k;
  let n = c.n;
  for (let i = 1; i < 10; i++) {
    n += frames(cur).length;
    cur.disconnected = true;
    cur.fire('disconnect', 'transport close');
    const s = r.sock({ ip: '10.7.7.7' });
    s.fire('sl:back', { k: key, n, p: c.p });
    assert.strictEqual(refusal(s), null, 'resume ' + (i + 1));
    cur = s;
    key = keysOf(s)[0].k;
  }
  n += frames(cur).length;
  cur.disconnected = true;
  cur.fire('disconnect', 'transport close');
  const eleventh = r.sock({ ip: '10.7.7.7' });
  eleventh.fire('sl:back', { k: key, n, p: c.p });
  assert.strictEqual(refusal(eleventh), 'flood');
  assert.strictEqual(room.parked.size, 1, 'still parked: the glide goes on');
  assert.strictEqual(room.stats.backsRefused.flood, 1);
});

test('never parked: a leave, a flood kick, a queue kick; their snake glides and dies, their key is gone', () => {
  const r = rig({ seed: 30 });
  const room = r.room();
  // a leave then the close
  const c1 = makeClient(r, '10.1.1.1');
  const a1 = c1.join('Leaver');
  r.wall.t += 1000;
  a1.fire('sl:leave');
  a1.disconnect();
  assert.strictEqual(room.parked.size, 0);
  assert.ok(room.orphans.has(c1.own));
  // the input flood kick
  const c2 = makeClient(r, '10.1.1.2');
  const a2 = c2.join('Flooder');
  const big = W.encodeInput(Array(16).fill({ type: 'angle', q: 3 }));
  for (let i = 0; i < 4000 && !a2.disconnected; i++) a2.fire('sl:i', big);
  assert.strictEqual(refusal(a2), 'flood');
  assert.strictEqual(room.parked.size, 0, 'a refused socket is never parked');
  // the queue's own kick (stall)
  const c3 = makeClient(r, '10.1.1.3');
  const a3 = c3.join('Staller');
  a3.conn.transport.writable = false;
  for (let i = 0; i < 400 && !a3.disconnected; i++) {
    r.ft.advance(room.P);
    room.wake();
  }
  assert.strictEqual(a3.disconnected, true, 'stall kicked');
  assert.strictEqual(room.parked.size, 0);
  for (const c of [c1, c2, c3]) {
    const s = r.sock({ ip: '10.2.2.2' });
    s.fire('sl:back', { k: c.key, n: 1, p: 0 });
    assert.strictEqual(refusal(s), 'gone');
  }
});

test('the address charge moves with the life: the old socket\'s charge goes at the resume, the new one holds it', () => {
  const r = rig({ seed: 31 });
  const room = r.room();
  const ip = '10.3.3.3';
  const c = makeClient(r, ip);
  c.join('Owen');
  const d = makeDriver(r, c);
  c.input([home(room, c.own)]);
  d.run(300);
  c.blip(true);
  assert.strictEqual(r.sockets.gate.count(ip), 1, 'the glide keeps the dropped socket charged');
  d.run(300);
  c.back();
  assert.strictEqual(r.sockets.gate.count(ip), 1, 'only the new socket');
  assert.strictEqual(room.refusal(), null);
  c.cur.disconnect();
  assert.strictEqual(r.sockets.gate.count(ip), 1, 'parked again (a server namespace drop is a drop): charged by its glide');
});

test('a room with only a parked seat keeps ticking (the glide runs out), and a stopped room drops its parked seats', () => {
  const r = rig({ seed: 32, patch: { C_IDLE_PAUSE_MS: 100 } });
  const room = r.room();
  room.autoTick = true;
  const c = makeClient(r);
  c.join('Owen');
  c.blip(true);
  r.ft.run(2000);
  assert.strictEqual(room.paused, false);
  assert.strictEqual(room.parked.size, 1);
  room.stop();
  assert.strictEqual(room.parked.size, 0);
  assert.strictEqual(room.keys.size, 0);
  const s = r.sock();
  s.fire('sl:back', { k: c.key, n: c.n, p: c.p });
  assert.strictEqual(refusal(s), 'gone');
});
