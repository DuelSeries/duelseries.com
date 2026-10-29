'use strict';
// Night review 2026-10-29, finding 16: a paid Paper arena sent every square's exact position, heading and open trail
// to every page (one frame and one trail batch for the whole room), so a userscript could draw the whole arena. A paid
// arena now sends each page only what is around its camera (ArenaWire cull, PaperRoom _culledFrames and
// _culledTrails, geo per asker, pp:follow for a watcher), and the page parks a square it stops being sent off the map
// (paperMirror _cull) and draws it again, trail whole, when it is back. A free arena is exactly as before.
const test = require('node:test');
const assert = require('node:assert');
const { makeArena, P, MP } = require('../server/paper/ArenaGame');
const { ArenaWire } = require('../server/paper/arenaWire');
const { PaperRoom } = require('../server/paper/PaperRoom');
const arenaTrim = require('../server/paper/arenaTrim');
require('../public/js/paper/mp/paperPredict.js');
const Net = require('../public/js/paper/mp/paperNet.js');
const Mirror = require('../public/js/paper/mp/paperMirror.js');

const C = 1000;
const STEP = MP.STEP_MS;
const QPOS = Math.SQRT2 / (2 * MP.POS_SCALE); // worst rounding of a wire position
const R = MP.VIEW_CULL_RADIUS;
const at = (r, a) => new P.Vec2(C + Math.cos(a) * r, C + Math.sin(a) * r);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const focusOf = (u) => ({ x: u.position.x, y: u.position.y, unit: u });

function seeded(seed) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function withRandom(seed, fn) {
  const orig = Math.random;
  Math.random = seeded(seed);
  try {
    return fn();
  } finally {
    Math.random = orig;
  }
}

// -------------------------------------------------------------------------------------------
// The wire on its own
// -------------------------------------------------------------------------------------------

function wireKit(cull) {
  const g = makeArena({ stake: 0.5, seed: 0.51 });
  g.radiusTarget = () => 950;
  g.setRadiusNow(950);
  const events = [];
  const wire = new ArenaWire(g, { queue: (e) => events.push(e), microOf: (id) => id * 1000, cull });
  return { g, wire, events };
}

let seq = 0;
function step(g, wire, inputs = []) {
  for (const [h, byte] of inputs) g.setInput(h.id, (++seq) & 255, byte, false, 0);
  g.update(MP.STEP_MS);
  wire.feed();
}

test('the cull radius covers the widest camera a page following a square has, with margin', () => {
  const halfDiagonal = Math.hypot(1366, 768) / 2 / P.defaultPaperConfig.minScale;
  assert.ok(R >= halfDiagonal + 80, R + ' against ' + halfDiagonal);
  assert.ok(R < 2 * halfDiagonal, 'still well under the arena');
});

test('cull: a far square never reaches a page (frame, join, trail batches, geo); the shared queue carries no trail', () => {
  const { g, wire, events } = wireKit(true);
  const a = g.spawnHuman({ name: 'a' }, at(600, 0));
  const near = g.spawnHuman({ name: 'near' }, at(600, 0.25));
  const far = g.spawnHuman({ name: 'far' }, at(600, Math.PI));
  a.still = true;
  near.still = true;
  // the far square goes out on a long straight run (an open trail)
  for (let i = 0; i < 90; i++) step(g, wire, [[far, MP.angleToByte(0.3)]]);
  assert.ok(far.in !== far.base && wire.state.get(far).sent > 0, 'the far square has batched trail corners');
  assert.ok(dist(a.position, far.position) > R + 100);
  assert.ok(dist(a.position, near.position) < R);
  assert.strictEqual(events.filter((e) => e[0] === 't').length, 0, 'no trail batch goes to the whole room');
  assert.ok(events.some((e) => e[0] === 'b' && e[1] === far.id), 'rings (land) are still everyone\'s');

  const seen = wire.seenBy(focusOf(a));
  assert.deepStrictEqual([...seen.keys()].sort((x, y) => x - y), [a.id, near.id].sort((x, y) => x - y));
  const frame = MP.decodeFrame(wire.frame([], seen));
  assert.deepStrictEqual(frame.units.map((u) => u.id).sort((x, y) => x - y), [a.id, near.id].sort((x, y) => x - y));

  const held = new Map();
  const join = wire.joinPayload(seen, held);
  const fj = join.units.find((u) => u.id === far.id);
  assert.deepStrictEqual([fj.hidden, fj.x, fj.y, fj.dir, fj.inId], [1, 0, 0, 0, 0], 'no position, heading or land it stands on');
  assert.strictEqual(fj.name, 'far');
  assert.strictEqual(fj.micro, far.id * 1000, 'its money still shows on the board');
  assert.strictEqual(MP.decodePoints(join.trails[join.units.indexOf(fj)]).length, 0, 'no trail');
  assert.ok(MP.decodePoints(join.rings[join.units.indexOf(fj)]).length >= 3, 'its land');
  assert.ok(!join.units.find((u) => u.id === a.id).hidden);
  assert.deepStrictEqual([...held.keys()].sort((x, y) => x - y), [a.id, near.id].sort((x, y) => x - y));

  assert.deepStrictEqual(wire.trailsFor(held, seen), [], 'nothing for squares at home');
  const geoA = wire.geo(far.id, seen);
  assert.deepStrictEqual(geoA.ev.map((e) => e[0]), ['b'], 'pp:need gets the far ring, never its trail');
  const geoAll = wire.geo(0, seen);
  assert.ok(!geoAll.ev.some((e) => e[0] === 't' && e[1] === far.id));
  assert.ok(geoAll.ev.some((e) => e[0] === 'b' && e[1] === far.id));

  // the far square's own page sees its own trail
  const heldF = new Map();
  const tf = wire.trailsFor(heldF, wire.seenBy(focusOf(far)));
  const mine = tf.filter((e) => e[1] === far.id);
  assert.strictEqual(mine.length, 1);
  assert.strictEqual(mine[0][3], 0, 'from corner 0');
  assert.strictEqual(MP.decodePoints(mine[0][4]).length, wire.state.get(far).sent);
  assert.strictEqual(wire.geo(far.id, wire.seenBy(focusOf(far))).ev.length, 2);
});

test('cull: a square whose open trail reaches into the circle is seen even with its head far away', () => {
  const { g, wire } = wireKit(true);
  const h = g.spawnHuman({ name: 'h' }, at(500, Math.PI));
  const start = h.position.clone();
  for (let i = 0; i < 330 && !h.death; i++) step(g, wire, [[h, MP.angleToByte(0)]]);
  assert.ok(!h.death && h.in !== h.base);
  assert.ok(dist(start, h.position) > R + 50, 'the head ran ' + dist(start, h.position));
  assert.ok(wire.seenBy({ x: start.x + 40, y: start.y, unit: null }).has(h.id), 'its trail is in view');
  assert.ok(!wire.seenBy({ x: start.x, y: start.y + R + 60, unit: null }).has(h.id), 'nothing of it is in view');
  assert.strictEqual(wire.seenBy(null).size, 0, 'no focus, nothing');
});

test('cull: a square standing on the viewer\'s land is seen (the minimap\'s red frame), wherever it is', () => {
  const { g, wire } = wireKit(true);
  const a = g.spawnHuman({ name: 'a' }, at(600, 0));
  const b = g.spawnHuman({ name: 'b' }, at(600, Math.PI));
  b.in = a.base; // as the sim marks an invader
  assert.ok(wire.seenBy(focusOf(a)).has(b.id));
  b.in = b.base;
  assert.ok(!wire.seenBy(focusOf(a)).has(b.id));
});

test('trailsFor: increments while seen, forgotten while not, from corner 0 when seen again; the page rebuilds the trail', () => {
  const { g, wire } = wireKit(true);
  const h = g.spawnHuman({ name: 'h' }, at(200, 2.0));
  const held = new Map();
  const page = { epoch: -1, corners: [] };
  const take = (ev) => {
    for (const e of ev) {
      const [, , epoch, from, blob] = e;
      if (from === 0) page.corners = [];
      assert.strictEqual(from, page.corners.length, 'never a gap');
      page.epoch = epoch;
      page.corners = page.corners.concat(MP.decodePoints(blob));
    }
  };
  const near = () => wire.seenBy({ x: h.position.x, y: h.position.y, unit: null });
  const away = () => wire.seenBy({ x: h.position.x + R + 500, y: h.position.y, unit: null });
  let froms = [];
  for (let i = 0; i < 60; i++) {
    step(g, wire, [[h, MP.angleToByte(2.0 + (i % 50 < 25 ? 0.4 : -0.4))]]);
    const ev = wire.trailsFor(held, near());
    froms = froms.concat(ev.map((e) => e[3]));
    take(ev);
  }
  assert.ok(froms.length >= 3 && froms[0] === 0 && froms.slice(1).every((f) => f > 0), 'increments: ' + froms);
  const st = wire.state.get(h);
  assert.strictEqual(page.corners.length, st.sent);
  for (let i = 0; i < 40; i++) {
    step(g, wire, [[h, MP.angleToByte(2.0 + (i % 50 < 25 ? 0.4 : -0.4))]]);
    assert.deepStrictEqual(wire.trailsFor(held, away()), []);
  }
  assert.ok(!held.has(h.id), 'forgotten while not seen');
  page.corners = []; // the page drops a square's trail when it stops being sent (paperMirror _cull)
  const back = wire.trailsFor(held, near());
  assert.strictEqual(back.length, 1);
  assert.strictEqual(back[0][3], 0, 'from corner 0 again');
  take(back);
  assert.strictEqual(page.corners.length, st.sent);
  page.corners.forEach((p, i) => assert.ok(Math.abs(p.x - st.dec.corners[i].x) <= 1 / 64 && Math.abs(p.y - st.dec.corners[i].y) <= 1 / 64));
});

test('a free arena is untouched: one frame of every square, trail batches to the whole room, every trail on pp:need', () => {
  const { g, wire, events } = wireKit(false);
  const a = g.spawnHuman({ name: 'a' }, at(600, 0));
  const far = g.spawnHuman({ name: 'far' }, at(600, Math.PI));
  a.still = true;
  for (let i = 0; i < 60; i++) step(g, wire, [[far, MP.angleToByte(0.3)]]);
  assert.ok(events.some((e) => e[0] === 't' && e[1] === far.id));
  assert.strictEqual(MP.decodeFrame(wire.frame([])).units.length, 2);
  assert.ok(!wire.joinPayload().units.some((u) => u.hidden));
  assert.strictEqual(wire.geo(far.id).ev.length, 2);
});

// -------------------------------------------------------------------------------------------
// A paid room with real sockets: per-page frames, trails, pp:need and watchers
// -------------------------------------------------------------------------------------------

function roomKit({ stake = 0.5, seed = 0.3 } = {}) {
  let t = 5000000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const sockets = new Map();
  const shared = [];
  const io = {
    sockets: { sockets },
    to: (target) => {
      const send = (ev, p) => {
        const s = sockets.get(target);
        if (s) return s.got.push([ev, p]);
        shared.push([target, ev, p]);
        for (const x of sockets.values()) if (x.rooms.has(target)) x.got.push([ev, p]);
      };
      return { emit: send, volatile: { emit: send } };
    }
  };
  const hooks = {};
  for (const h of ['onCashout', 'onTransfer', 'onRefund', 'onSweep', 'onBreach']) hooks[h] = () => {};
  const room = new PaperRoom({ stake, io, hooks, now: clock.now, autoTick: false, seed });
  room.game.radiusTarget = () => 950;
  room.game.setRadiusNow(950);
  let n = 0;
  function sock() {
    const s = {
      id: 'k' + ++n,
      rooms: new Set(),
      got: [],
      join(r) { this.rooms.add(r); },
      leave(r) { this.rooms.delete(r); },
      emit(ev, p) { this.got.push([ev, p]); },
      all(ev) { return this.got.filter((x) => x[0] === ev).map((x) => x[1]); }
    };
    sockets.set(s.id, s);
    return s;
  }
  function seat(spot, name) {
    const s = sock();
    const st = room.addHuman(s, { name: name || s.id, micro: stake > 0 ? 500000 : 0, wallet: 'W' + s.id, spot });
    st.unit.locked = false;
    room._confirm(st);
    return { s, seat: st, u: st.unit };
  }
  function tick(k = 1) {
    for (let i = 0; i < k; i++) {
      clock.advance(STEP);
      room.tickOnce();
    }
  }
  const frames = (s) => s.all('pp:s').map((b) => MP.decodeFrame(b));
  const trails = (s) => s.all('pp:ev').flatMap((b) => MP.unpackBin(b).ev).filter((e) => e[0] === 't');
  return { room, g: room.game, io, sockets, shared, clock, sock, seat, tick, frames, trails };
}

test('a paid room: each page gets its own frame of what is around it, its own trails, and pp:need answers the same', () => {
  const k = roomKit();
  const a = k.seat(at(600, 0), 'a');
  const b = k.seat(at(600, Math.PI), 'b');
  let sq = 0;
  for (let i = 0; i < 90; i++) {
    k.g.setInput(b.u.id, (++sq) & 255, MP.angleToByte(0.3), false, k.clock.now());
    k.g.setInput(a.u.id, sq & 255, MP.angleToByte(Math.PI + 0.3), false, k.clock.now());
    k.tick();
  }
  assert.ok(!a.u.death && !b.u.death);
  assert.ok(dist(a.u.position, b.u.position) > R + 200);
  assert.ok(a.u.in !== a.u.base && b.u.in !== b.u.base, 'both out on trails');
  assert.ok(!k.shared.some((x) => x[1] === 'pp:s'), 'no frame goes to the whole room');
  const fa = k.frames(a.s);
  const fb = k.frames(b.s);
  assert.ok(fa.length >= 40 && fb.length >= 40);
  assert.ok(fa.every((f) => f.units.some((u) => u.id === a.u.id) && !f.units.some((u) => u.id === b.u.id)), 'a never sees b');
  assert.ok(fb.every((f) => f.units.some((u) => u.id === b.u.id) && !f.units.some((u) => u.id === a.u.id)), 'b never sees a');
  const ta = k.trails(a.s);
  assert.ok(ta.length > 0 && ta.every((e) => e[1] === a.u.id), 'a gets only its own trail batches');
  assert.ok(k.trails(b.s).every((e) => e[1] === b.u.id));
  const shared = k.shared.filter((x) => x[1] === 'pp:ev').flatMap((x) => MP.unpackBin(x[2]).ev);
  assert.ok(!shared.some((e) => e[0] === 't'), 'no trail batch to the whole room');
  const joinedA = MP.unpackBin(a.s.all('pp:joined')[0]);
  assert.ok(joinedA.units.every((u) => u.id === a.u.id || u.hidden === 1), 'the join hid what a cannot see');
  // pp:need: the far square's ring, never its trail
  const geo = k.room.geo(b.u.id, a.s.id);
  assert.deepStrictEqual(geo.ev.map((e) => e[0]), ['b']);
  assert.ok(k.room.geo(0, a.s.id).ev.every((e) => e[0] === 'b' || e[1] === a.u.id));
  assert.strictEqual(k.room.geo(b.u.id, b.s.id).ev.length, 2);
  assert.strictEqual(k.room.geo(b.u.id, 'nobody').ev.length, 1, 'a socket this arena does not know sees nothing');
});

test('a paid room: a dead page looks at its killer; a page that left gets nothing; a free room is one shared frame', () => {
  const k = roomKit();
  const a = k.seat(at(600, 0), 'a');
  const b = k.seat(at(600, Math.PI), 'b');
  k.tick(2);
  // a dies (the sim's own kill path), killed by b far away: its page's frames follow b from then on
  k.room.onDeath(a.u, b.u, 1, a.u.position);
  k.g.removeHuman(a.u.id, 1);
  a.s.got.length = 0;
  k.tick(4);
  const f = k.frames(a.s);
  assert.ok(f.length >= 1 && f.every((x) => x.units.some((u) => u.id === b.u.id)), 'the killer the camera glides to');
  // a's page leaves the arena: no more frames, its records go
  a.s.leave(k.room.ioRoom);
  a.s.got.length = 0;
  k.tick(4);
  assert.strictEqual(k.frames(a.s).length, 0);
  assert.ok(!k.room.views.has(a.s.id) && !k.room.deadViews.has(a.s.id));

  const free = roomKit({ stake: 0 });
  const x = free.seat(at(600, 0), 'x');
  free.seat(at(600, Math.PI), 'y');
  free.tick(4);
  const sf = free.shared.filter((s) => s[1] === 'pp:s').map((s) => MP.decodeFrame(s[2]));
  const ids = (fr) => fr.units.map((u) => u.id);
  assert.ok(sf.length >= 2 && sf.every((fr) => ids(fr).includes(x.u.id) && fr.units.length >= 2), 'both, to the room');
  assert.strictEqual(sf[sf.length - 1].units.length, free.g.units.length, 'every square (the bots too)');
  assert.strictEqual(x.s.all('pp:s').length, sf.length, 'every frame it got was the shared one');
});

test('a paid room\'s watcher is sent what is around the square it follows; pp:follow moves it, only to a live square', () => {
  const createPaperSockets = require('../server/paperSockets');
  const k = roomKit();
  const a = k.seat(at(600, 0), 'a');
  const b = k.seat(at(600, Math.PI), 'b');
  const arenas = { watchFor: () => k.room, all: () => [k.room] };
  const paper = createPaperSockets({ arenas, ops: { get: () => ({ maintenance: false }) }, socketRL: () => true,
    sanitizeName: (x) => String(x || ''), isStake: () => true, consumePaidEntryAtStake: () => ({ ok: false }),
    entryStore: { consumeAtStake: () => ({ ok: false }) }, payout: { refund() {} }, paidEnabled: true });
  const w = k.sock();
  w.handlers = {};
  w.on = function (ev, fn) { this.handlers[ev] = fn; };
  w.fire = function (ev, p) { this.handlers[ev](p); };
  paper.attach(w);
  w.fire('pp:watch', { stake: 0.5, after: a.u.id }); // the square ranked after a
  const watching = MP.unpackBin(w.all('pp:watching')[0]);
  const followed = watching.follow;
  assert.ok(followed === a.u.id || followed === b.u.id);
  const other = followed === a.u.id ? b.u : a.u;
  assert.ok(watching.units.find((u) => u.id === other.id).hidden, 'the watch state hides the far square too');
  k.tick(4);
  let f = k.frames(w);
  assert.ok(f.length && f.every((x) => x.units.some((u) => u.id === followed) && !x.units.some((u) => u.id === other.id)));
  w.fire('pp:follow', { id: other.id });
  w.got.length = 0;
  k.tick(4);
  f = k.frames(w);
  assert.ok(f.length && f.every((x) => x.units.some((u) => u.id === other.id) && !x.units.some((u) => u.id === followed)));
  assert.ok(k.trails(w).every((e) => e[1] === other.id));
  // junk, a square that is not here, and a socket that is not a watcher change nothing
  for (const bad of [null, 5, {}, { id: 'x' }, { id: -1 }, { id: 1.5 }, { id: 60000 }]) w.fire('pp:follow', bad);
  assert.strictEqual(k.room.watchFollow.get(w.id), other.id);
  assert.strictEqual(k.room.followWatch(a.s.id, b.u.id), false, 'a seat is not a watcher');
  // the followed square dies: its killer, then nothing once the record is old
  k.room.onDeath(other, null, 1, other.position);
  k.g.removeHuman(other.id, 1);
  w.got.length = 0;
  k.tick(2);
  assert.ok(k.frames(w).every((x) => !x.units.length), 'where it died: nobody near');
  assert.strictEqual(k.room.followWatch(w.id, other.id), false, 'a dead square is never followed');
  k.room.removeWatcher(w.id);
  assert.ok(!k.room.watchFollow.has(w.id) && !k.room.views.has(w.id));
});

test('real socket.io: a paid arena finds its pages through the adapter, and each page gets only its own frame', async () => {
  const http = require('http');
  const { Server } = require('socket.io');
  const ioc = require('socket.io-client');
  const srv = http.createServer();
  const io = new Server(srv);
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const port = srv.address().port;
  const onServer = [];
  io.on('connection', (s) => onServer.push(s));
  const clients = [0, 1].map(() => ioc('http://127.0.0.1:' + port, { transports: ['websocket'], forceNew: true }));
  const got = clients.map(() => []);
  clients.forEach((c, i) => c.on('pp:s', (b) => got[i].push(MP.decodeFrame(b))));
  let t = 9000000;
  const hooks = {};
  for (const h of ['onCashout', 'onTransfer', 'onRefund', 'onSweep', 'onBreach']) hooks[h] = () => {};
  const room = new PaperRoom({ stake: 0.5, io, hooks, now: () => t, autoTick: false, seed: 0.3 });
  try {
    for (let i = 0; i < 100 && onServer.length < 2; i++) await new Promise((res) => setTimeout(res, 20));
    assert.strictEqual(onServer.length, 2, 'both connected');
    const byClient = clients.map((c) => onServer.find((s) => s.id === c.id));
    room.game.radiusTarget = () => 950;
    room.game.setRadiusNow(950);
    const seats = [at(600, 0), at(600, Math.PI)].map((spot, i) => {
      const st = room.addHuman(byClient[i], { name: 'p' + i, micro: 500000, wallet: 'W' + i, spot });
      st.unit.locked = false;
      room._confirm(st);
      return st;
    });
    assert.strictEqual(room._members().size, 2, 'the adapter knows the io room');
    for (let i = 0; i < 12; i++) {
      await new Promise((res) => setTimeout(res, 10)); // a volatile emit needs a writable transport (a turn apart)
      t += STEP;
      room.tickOnce();
    }
    for (let i = 0; i < 100 && (got[0].length < 3 || got[1].length < 3); i++) await new Promise((res) => setTimeout(res, 20));
    assert.ok(got[0].length >= 3 && got[1].length >= 3, 'frames arrived: ' + got[0].length + ', ' + got[1].length);
    const [a, b] = seats.map((s) => s.unit.id);
    assert.ok(got[0].every((f) => f.units.length === 1 && f.units[0].id === a), 'page 0 sees only its own square');
    assert.ok(got[1].every((f) => f.units.length === 1 && f.units[0].id === b), 'page 1 sees only its own square');
  } finally {
    room.stop();
    clients.forEach((c) => c.close());
    io.close();
    await new Promise((res) => srv.close(() => res()));
  }
});

// A paid rung through the real PaperArenas and paperSockets, sockets with addresses (night review 2026-10-29, with
// findings 6 and 8): a live square's address cannot watch its rung, and a square seated from a watcher's address ends
// that watch.
test('a paid rung is never watched from the address of a live square there; a buy-in ends that address\'s watch', () => {
  const createPaperSockets = require('../server/paperSockets');
  const { PaperArenas } = require('../server/paper/PaperArenas');
  const { isStake } = require('../server/stakeRules');
  const sockets = new Map();
  const io = {
    sockets: { sockets },
    to(target) {
      const send = (ev, p) => {
        const s = sockets.get(target);
        if (s) return s.got.push([ev, p]);
        for (const x of sockets.values()) if (x.rooms.has(target)) x.got.push([ev, p]);
      };
      return { emit: send, volatile: { emit: send } };
    }
  };
  const hooks = { onCashout() {}, onTransfer() {}, onRefund() {}, onSweep() {}, onBreach() {} };
  const arenas = new PaperArenas({ io, hooks, now: () => 1000000, paidEnabled: true, autoTick: false, warm: false });
  const tokens = new Map();
  const take = (token, stake) => {
    const tk = typeof token === 'string' && tokens.get(token);
    if (!tk || Math.abs(tk.stake - Number(stake)) > 1e-9) return { ok: false, worth: 0 };
    tokens.delete(token);
    return { ok: true, worth: tk.worth, paid: tk.paid, walletAddress: tk.walletAddress };
  };
  const paper = createPaperSockets({ arenas, ops: { get: () => ({ maintenance: false }) }, socketRL: () => true,
    sanitizeName: (x) => String(x || 'P'), isStake, consumePaidEntryAtStake: take,
    entryStore: { consumeAtStake: take }, payout: { refund() {} }, paidEnabled: true });
  let tn = 0;
  const mint = () => {
    const t = 'tok' + ++tn;
    tokens.set(t, { stake: 0.5, worth: 0.5, paid: 0.5, walletAddress: 'W' + tn });
    return t;
  };
  let sn = 0;
  function sock(ip) {
    const s = {
      id: 'ip' + ++sn, handshake: { address: ip, headers: {} }, handlers: {}, got: [], rooms: new Set(),
      on(ev, fn) { this.handlers[ev] = fn; },
      emit(ev, p) { this.got.push([ev, p]); },
      join(r) { this.rooms.add(r); },
      leave(r) { this.rooms.delete(r); },
      fire(ev, p) { this.handlers[ev](p); },
      last(ev) { const g = this.got.filter((x) => x[0] === ev); return g.length ? MP.unpackBin(g[g.length - 1][1]) : null; }
    };
    sockets.set(s.id, s);
    paper.attach(s);
    return s;
  }
  const a = sock('203.0.113.1');
  a.fire('pp:join', { name: 'a', stake: 0.5, entryToken: mint() });
  assert.ok(a.last('pp:joined'), 'a pays in from .1');
  const room = a._ppRoom;
  const twin = sock('203.0.113.1');
  twin.fire('pp:watch', { stake: 0.5 });
  assert.deepStrictEqual([twin.last('pp:watching').none, twin.last('pp:watching').why], [true, 'seated']);
  assert.strictEqual(room.watchers.size, 0);
  const other = sock('203.0.113.2');
  other.fire('pp:watch', { stake: 0.5 });
  assert.ok(!other.last('pp:watching').none, 'another address watches');
  const spy = sock('203.0.113.3');
  spy.fire('pp:watch', { stake: 0.5 });
  assert.ok(!spy.last('pp:watching').none);
  assert.strictEqual(room.watchers.size, 2);
  const b = sock('203.0.113.3');
  b.fire('pp:join', { name: 'b', stake: 0.5, entryToken: mint() });
  assert.ok(b.last('pp:joined'), 'b pays in from .3');
  assert.deepStrictEqual([spy.last('pp:watching').none, spy.last('pp:watching').why], [true, 'seated'], 'its watch ends');
  assert.ok(!spy._ppWatch && ![...arenas.all()].some((r) => r.watchers.has(spy.id)));
  assert.ok(room.watchers.has(other.id), 'the other address keeps watching');
  // a's square leaves: its address may watch again
  a.fire('pp:leave');
  twin.fire('pp:watch', { stake: 0.5 });
  assert.ok(!twin.last('pp:watching').none, 'watching once its square is gone');
});

// -------------------------------------------------------------------------------------------
// The page: a real paid PaperRoom through the net into the mirror
// -------------------------------------------------------------------------------------------

function paidArena(seed) {
  const clock = { t: 1000000 };
  const q = [];
  const sockets = new Map();
  const io = {
    sockets: { sockets },
    to: (target) => ({
      emit: (ev, p) => q.push([target, ev, p]),
      volatile: { emit: (ev, p) => q.push([target, ev, p]) }
    })
  };
  const hooks = {};
  for (const h of ['onCashout', 'onTransfer', 'onRefund', 'onSweep', 'onBreach']) hooks[h] = () => {};
  const room = new PaperRoom({ stake: 0.5, io, hooks, now: () => clock.t, autoTick: false, seed, trim: arenaTrim });
  room.game.radiusTarget = () => 950;
  room.game.setRadiusNow(950);
  const server = {
    id: 'c1',
    rooms: new Set(),
    join(r) { this.rooms.add(r); },
    leave(r) { this.rooms.delete(r); },
    emit(ev, p) { q.push(['c1', ev, p]); }
  };
  sockets.set('c1', server);
  const handlers = {};
  const sent = [];
  const client = {
    on(ev, fn) { handlers[ev] = fn; },
    emit(ev, p) {
      sent.push([ev, p]);
      if (ev === 'pp:need') q.push(['c1', 'pp:geo', room.geo(p.id, 'c1')]);
    },
    volatile: {
      emit(ev, p) {
        sent.push([ev, p]);
        if (ev === 'pp:in') room.setInput('c1', p);
      }
    }
  };
  const log = [];
  function deliver() {
    while (q.length) {
      const [target, ev, p] = q.shift();
      const mine = target === 'c1' || (target === room.ioRoom && server.rooms.has(room.ioRoom));
      if (!mine) continue;
      log.push([ev, MP.unpackBin(p)]);
      if (handlers[ev]) handlers[ev](p);
    }
  }
  return { clock, room, g: room.game, server, client, sent, log, deliver, sockets };
}

test('the page: a far square is never drawn, comes back with its whole trail when near, and goes again when it leaves', () => {
  withRandom(11, () => {
    const k = paidArena(0.42);
    const net = new Net.ArenaNet({ socket: k.client, now: () => k.clock.t, onError: (w, e) => { throw e; } });
    const m = Mirror.create({ net, seed: 0.5 });
    m.onError = (e) => { throw e; };
    net.join({ name: 'me', stake: 0.5, entryToken: 'tok' });
    const seat = k.room.addHuman(k.server, { name: 'me', micro: 500000, wallet: 'W1', spot: at(500, 0) });
    k.deliver();
    const other = { id: 'c2', rooms: new Set(), join(r) { this.rooms.add(r); }, leave(r) { this.rooms.delete(r); }, emit() {} };
    k.sockets.set('c2', other);
    const bs = k.room.addHuman(other, { name: 'far', micro: 500000, wallet: 'W2', spot: at(500, Math.PI) });
    bs.unit.locked = false;
    k.room._confirm(bs);
    k.deliver();
    const me = seat.unit;
    const b = bs.unit;
    const home = b.position.clone();
    let bseq = 0;
    let bAim = () => 0;
    const steerMe = (tick) => (tick * 2 * Math.PI) / 180; // a small loop out of the own base and home again
    function run(n) {
      for (let i = 0; i < n; i++) {
        m.direction = new P.Vec2(Math.cos(steerMe(k.g.tick)), Math.sin(steerMe(k.g.tick)));
        k.clock.t += STEP;
        m.update(STEP);
        k.room.setInput('c2', MP.encodeInput((++bseq) & 255, MP.angleToByte(bAim()), false));
        k.room.tickOnce();
        k.deliver();
      }
    }
    function syncToNewest() {
      const T = net.lastFrameTick;
      const want = (T + 1e-6 + (MP.INTERP_DELAY_MS + net.jitterBuf) / STEP) * STEP - net.clockOffset;
      k.clock.t = Math.max(k.clock.t, want);
      m.update(1e-4);
      return T;
    }
    const mb = () => m.byId.get(b.id);
    const sawB = () => k.log.some(([ev, p]) => ev === 'pp:s' ? MP.decodeFrame(p).units.some((u) => u.id === b.id) : false);
    const trailB = () => k.log.some(([ev, p]) => (ev === 'pp:ev' || ev === 'pp:geo') && p.ev.some((e) => e[0] === 't' && e[1] === b.id));
    const joined = k.log.find((l) => l[0] === 'pp:joined')[1];
    assert.ok(joined.units.find((u) => u.id === b.id) === undefined || joined.units.find((u) => u.id === b.id).hidden);

    // 1. b circles at home, a whole arena away: the page never gets it and never draws it
    bAim = () => (k.g.tick * 2 * Math.PI) / 200;
    run(240);
    assert.ok(!b.death && !me.death);
    assert.ok(dist(me.position, b.position) > R + 300);
    assert.strictEqual(sawB(), false, 'no frame ever carried b');
    assert.strictEqual(trailB(), false, 'no trail of b ever came');
    syncToNewest();
    assert.ok(mb() && mb()._culled, 'b is known (name, land, money) but culled');
    assert.ok(mb().position.x < -1000 && mb().track.polyline.start === null && mb().in === null, 'parked off the map, no trail');
    assert.strictEqual(mb().name, 'far');

    // 2. b runs at the page's square until it is well in view: drawn where the server has it, its trail whole
    bAim = () => Math.atan2(me.position.y - b.position.y, me.position.x - b.position.x);
    let n = 0;
    while (dist(me.position, b.position) > 200 && n++ < 900) run(1);
    assert.ok(!b.death && !me.death && b.in !== b.base, 'b is out on a long trail, near');
    run(8);
    if (k.g.tick % MP.SNAPSHOT_EVERY) run(1); // end on a snapshot tick
    const T = syncToNewest();
    assert.strictEqual(k.g.tick, T);
    const u = mb();
    assert.ok(!u._culled, 'drawn again');
    assert.ok(dist(u.position, b.position) <= QPOS + 1e-9, 'where the server has it: ' + dist(u.position, b.position));
    const corners = k.room.wire.state.get(b).dec.corners;
    const pts = m._stable(u).pts;
    assert.ok(corners.length > 5, 'a long trail: ' + corners.length);
    const rec = net.newest().byId.get(b.id);
    if (rec.tail.length < MP.TRAIL_TAIL_MAX) assert.strictEqual(pts.length, corners.length, 'the whole trail');
    for (let i = 0; i < pts.length; i++) assert.ok(dist(pts[i], corners[i]) <= QPOS + 1e-9, 'trail corner ' + i);
    assert.ok(u.track.polyline.start, 'its trail is drawn');

    // 3. b goes home the long way round (north, west, then down into its base, never across its own trail): while its
    // open trail still reaches the page's view it is sent; once home (the trail closed) and far, it is parked again
    let leg = 'north';
    bAim = () => {
      if (leg === 'north' && b.position.y < 700) leg = 'west';
      if (leg === 'west' && b.position.x < 560) leg = 'home';
      if (leg === 'north') return -Math.PI / 2;
      if (leg === 'west') return Math.PI;
      return Math.atan2(home.y - b.position.y, home.x - b.position.x);
    };
    n = 0;
    while (b.in !== b.base && !b.death && n++ < 1500) run(1);
    assert.ok(!b.death && b.in === b.base, 'b is home');
    assert.ok(dist(me.position, b.position) > R + 300);
    run(30);
    syncToNewest();
    assert.ok(!b.death);
    assert.ok(mb()._culled && mb().position.x < -1000 && mb().track.polyline.start === null, 'culled again');
    assert.strictEqual(m.errors, 0);
    assert.strictEqual(net.stats.badFrames, 0);
    assert.ok(net.stats.needs <= 2, 'the trail came whole without a resync: ' + net.stats.needs);
    console.log('# cull e2e ' + JSON.stringify({ ticks: k.g.tick, frames: net.stats.frames, needs: net.stats.needs,
      trailAtReturn: corners.length, units: m.units.length }));
    assert.ok(m.player && m.player.id === me.id && !m.player._culled, 'the own square is never culled');
  });
});

test('watch mode in a paid arena: a pick that is not sent yet is asked for and followed once a frame brings it', () => {
  const sent = [];
  let now = 0;
  const net = {
    follow(id) { sent.push(id); return true; },
    forget() {},
    now() { return now; }
  };
  const m = Mirror.create({ seed: 0.5 });
  m.onError = (e) => { throw e; };
  m.net = net;
  const ring = (x, y) => MP.encodePoints(P.makeCirclePoints(new P.Vec2(x, y), 50, 30).map((p) => ({ x: p.x, y: p.y })));
  m.applyWatching({
    arenaId: 't', stake: 0.5, tick: 100, radius: 950, targetRadius: 950, holdTicks: MP.HOLD_TICKS, follow: 1,
    units: [
      { id: 1, name: 'one', skin: null, bot: false, x: 700, y: 700, dir: 0, inId: 1, micro: 0, pct: 0.01, ver: 1, epoch: 0 },
      { id: 2, name: 'two', skin: null, bot: false, x: 0, y: 0, dir: 0, inId: 0, micro: 0, pct: 0.005, ver: 1, epoch: 0, hidden: 1 }
    ],
    rings: [ring(700, 700), ring(1300, 1300)],
    trails: [MP.encodePoints([]), MP.encodePoints([])],
    pickups: []
  });
  assert.strictEqual(m.player.id, 1);
  assert.ok(m.byId.get(2)._culled);
  sent.length = 0;
  assert.ok(m.followNext());
  assert.strictEqual(m.player.id, 1, 'the camera stays until two is sent');
  assert.deepStrictEqual(sent, [2], 'the server is told');
  const rec = (id, x, y) => ({ id, x, y, dir: 0, bot: false, holding: false, pushed: false, hold: 0, ack: 0, trailEpoch: 0,
    pct: 0.01, inId: id, baseVer: 1, trailCount: 0, micro: 0, tail: [] });
  const frame = (units) => ({ tick: 102, byId: new Map(units.map((u) => [u.id, u])), units, pickups: [] });
  // still not in a frame: asked again after FOLLOW_ASK_MS, never more often
  m._placeRemotes({ before: frame([rec(1, 700, 700)]), after: null, alpha: 0, extMs: 0 });
  assert.deepStrictEqual(sent, [2]);
  now += 300;
  m._placeRemotes({ before: frame([rec(1, 700, 700)]), after: null, alpha: 0, extMs: 0 });
  assert.deepStrictEqual(sent, [2, 2]);
  m._watchStep(5000);
  assert.strictEqual(m.player.id, 1, 'a pick on its way is never overtaken');
  // the next frame brings it: followed, drawn
  m._placeRemotes({ before: frame([rec(2, 1300, 1300)]), after: null, alpha: 0, extMs: 0 });
  assert.strictEqual(m.player.id, 2);
  assert.ok(!m.byId.get(2)._culled && m.byId.get(2).position.x === 1300);
  m._placeRemotes({ before: frame([rec(2, 1300, 1300)]), after: null, alpha: 0, extMs: 0 });
  assert.ok(m.byId.get(1)._culled, 'and the square it left, now out of the frames, is parked');
  // a free arena: nothing is told, the switch is at once
  m.paid = false;
  sent.length = 0;
  m.follow(1);
  assert.strictEqual(m.player.id, 1);
  assert.deepStrictEqual(sent, []);
});
