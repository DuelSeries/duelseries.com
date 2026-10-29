'use strict';
// Night review 2026-10-29, the review of finding 16 (paperCull.test.js has the finding itself). Paid Paper watchers
// were still sent their followed square's surroundings live, with no cap per address, so a script on a second address
// could pin one watcher on each square and rebuild the whole map. Now:
// - a paid arena's watcher is sent everything PaperRoom WATCH_DELAY_MS late, in order, byte for byte what a live
//   watcher gets (state, frames, bundles, its own trails, pp:need answers, chat); free arenas and players stay live;
// - one address holds at most two paid watchers;
// - a dead page is shown around its killer DEAD_VIEW_TICKS at most;
// - a square is seen by its trail only when the trail itself (not its box) comes near the page's camera.
const test = require('node:test');
const assert = require('node:assert');
const { makeArena, P, MP } = require('../server/paper/ArenaGame');
const { ArenaWire } = require('../server/paper/arenaWire');
const { PaperRoom, WATCH_DELAY_MS } = require('../server/paper/PaperRoom');
const createPaperSockets = require('../server/paperSockets');
const { PaperArenas } = require('../server/paper/PaperArenas');
const { isStake } = require('../server/stakeRules');

const C = 1000;
const STEP = MP.STEP_MS;
const R = MP.VIEW_CULL_RADIUS;
const LAG = Math.ceil(WATCH_DELAY_MS / STEP);
const at = (r, a) => new P.Vec2(C + Math.cos(a) * r, C + Math.sin(a) * r);

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

// A room with sockets that record every send and the room tick it went out at.
function roomKit({ stake = 0.5, watchDelayMs } = {}) {
  let t = 5000000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const sockets = new Map();
  let room = null;
  const io = {
    sockets: { sockets },
    to: (target) => {
      const send = (ev, p) => {
        const s = sockets.get(target);
        if (s) return s.take(ev, p);
        for (const x of sockets.values()) if (x.rooms.has(target)) x.take(ev, p);
      };
      return { emit: send, volatile: { emit: send } };
    }
  };
  const hooks = {};
  for (const h of ['onCashout', 'onTransfer', 'onRefund', 'onSweep', 'onBreach']) hooks[h] = () => {};
  const opts = { stake, io, hooks, now: clock.now, autoTick: false, seed: 0.3 };
  if (watchDelayMs !== undefined) opts.watchDelayMs = watchDelayMs;
  room = new PaperRoom(opts);
  room.game.radiusTarget = () => 950;
  room.game.setRadiusNow(950);
  let n = 0;
  function sock(ip) {
    const s = {
      id: 'k' + ++n,
      handshake: { address: ip || '', headers: {} },
      rooms: new Set(),
      got: [],
      handlers: {},
      take(ev, p) { this.got.push([ev, p, room.game.tick]); },
      join(r) { this.rooms.add(r); },
      leave(r) { this.rooms.delete(r); },
      emit(ev, p) { this.take(ev, p); },
      on(ev, fn) { this.handlers[ev] = fn; },
      fire(ev, p) { this.handlers[ev](p); },
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
  return { room, g: room.game, sockets, clock, sock, seat, tick };
}

// What a send carries, comparable across two rooms: buffers as hex, everything else as JSON.
function sig(ev, p) {
  const hex = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('hex');
  return ev + ':' + (ArrayBuffer.isView(p) ? hex(p) : JSON.stringify(p, (k, v) => (ArrayBuffer.isView(v) ? hex(v) : v)));
}

// One scripted game: two squares near each other out on trails, a watcher from tick 2, a chat line and a pp:need on
// the way. -> what the watcher got, in order, with the tick each went out at.
function play(watchDelayMs) {
  return withRandom(7, () => {
    const k = roomKit({ watchDelayMs });
    const a = k.seat(at(300, 0), 'a');
    const b = k.seat(at(300, 0.9), 'b');
    k.tick(2);
    const w = k.sock('198.51.100.9');
    assert.strictEqual(k.room.addWatcher(w, 0), true);
    let sq = 0;
    for (let i = 0; i < 900; i++) {
      sq = (sq + 1) & 255;
      // both run loops out of their land and back (captures, trails, land changing)
      k.g.setInput(a.u.id, sq, MP.angleToByte(i * 0.02), false, k.clock.now());
      k.g.setInput(b.u.id, sq, MP.angleToByte(1 - i * 0.025), false, k.clock.now());
      if (i === 200) k.room.chat(a.s.id, 'gg');
      if (i === 300) k.room.answerNeed(w, 0);
      if (i === 301) k.room.answerNeed(w, b.u.id);
      k.tick();
    }
    assert.ok(!a.u.death && !b.u.death, 'both still playing');
    return { k, w, got: w.got.map(([ev, p, tick]) => ({ s: sig(ev, p), ev, tick })) };
  });
}

test('a paid watcher gets exactly what a live watcher gets, in the same order, WATCH_DELAY_MS later', () => {
  assert.ok(WATCH_DELAY_MS >= 3000 && WATCH_DELAY_MS <= 5000, 'a square crosses a view in this time');
  const live = play(0);
  const late = play();
  assert.strictEqual(late.k.room.watchLagTicks, LAG);
  assert.strictEqual(live.k.room.watchLagTicks, 0);
  assert.ok(!late.w.rooms.has(late.k.room.ioRoom), 'never in the io room');
  assert.ok(live.w.rooms.has(live.k.room.ioRoom));
  const kinds = new Set(live.got.map((x) => x.ev));
  for (const ev of ['pp:watching', 'pp:s', 'pp:ev', 'pp:chat', 'pp:geo']) assert.ok(kinds.has(ev), 'the script covers ' + ev);
  assert.strictEqual(late.got[0].ev, 'pp:watching', 'the state first');
  assert.ok(late.got[0].tick >= 2 + LAG, 'and only a delay after the watch began');
  // everything the late watcher got is the live watcher's stream, from the start, in order, byte for byte
  assert.ok(late.got.length > 300, 'about ten seconds of it: ' + late.got.length);
  late.got.forEach((x, i) => {
    assert.strictEqual(x.s, live.got[i].s, 'send ' + i + ' (' + x.ev + ') is the same');
    const behind = x.tick - live.got[i].tick;
    assert.ok(behind >= LAG && behind <= LAG + MP.SNAPSHOT_EVERY, 'send ' + i + ' is ' + behind + ' ticks behind');
  });
  // what is still queued is the last WATCH_DELAY_MS of it
  const q = late.k.room.lagged.get(late.w.id).q;
  assert.strictEqual(late.got.length + q.length, live.got.length);
  assert.ok(q.every((e) => e.at > late.k.g.tick - LAG));
  // frames keep their volatile mark
  assert.ok(q.filter((e) => e.ev === 'pp:s').every((e) => e.vol) && q.filter((e) => e.ev !== 'pp:s').every((e) => !e.vol));
});

test('players and free watchers stay live; a paid watcher that leaves, or is let go, drops its queue', () => {
  const k = roomKit();
  const a = k.seat(at(400, 0), 'a');
  k.tick(2);
  const n = a.s.got.length;
  k.tick(2);
  assert.ok(a.s.got.length > n, 'a player gets its frame at once');
  const w = k.sock();
  k.room.addWatcher(w, 0);
  k.tick(10);
  assert.strictEqual(w.got.length, 0, 'nothing before the delay');
  assert.ok(k.room.lagged.get(w.id).q.length > 5);
  k.room.removeWatcher(w.id);
  assert.ok(!k.room.lagged.has(w.id) && !k.room.views.has(w.id));
  k.tick(LAG + 4);
  assert.strictEqual(w.got.length, 0, 'never sent after it left');
  // let go when the arena empties: told at once, its queue gone
  const w2 = k.sock();
  k.room.addWatcher(w2, 0);
  k.tick(4);
  k.room.removeHuman(a.u.id, 9);
  k.tick(2);
  assert.ok(!k.room.lagged.has(w2.id));
  assert.deepStrictEqual(w2.got.map((x) => [x[0], x[1].none, x[1].why]), [['pp:watching', true, 'nobody']]);

  const free = roomKit({ stake: 0 });
  free.seat(at(400, 0), 'x');
  const fw = free.sock();
  free.room.addWatcher(fw, 0);
  assert.strictEqual(free.room.watchLagTicks, 0);
  assert.ok(fw.rooms.has(free.room.ioRoom) && fw.all('pp:watching').length === 1, 'a free watcher is live as before');
});

test('a paid watcher asking again while its first state is on its way keeps its place; a flood is let go as full', () => {
  const k = roomKit();
  k.seat(at(400, 0), 'a').u.still = true; // stays home, alive, so the arena keeps its watcher
  k.tick(2);
  const w = k.sock();
  assert.strictEqual(k.room.addWatcher(w, 0), true);
  const first = k.room.lagged.get(w.id).q[0];
  k.tick(Math.floor(LAG / 2));
  assert.ok(k.room.watchStarting(w.id));
  assert.strictEqual(k.room.addWatcher(w, 0), true, 'the page asks again (every 3 s)');
  assert.strictEqual(k.room.lagged.get(w.id).q[0], first, 'the same watch, never restarted');
  k.tick(LAG);
  assert.strictEqual(w.all('pp:watching').length, 1);
  assert.ok(!k.room.watchStarting(w.id), 'shown');
  // pp:need on every id, far more than any page asks: let go at the next release, told 'full'
  for (let i = 0; i < 1600; i++) k.room.answerNeed(w, 1 + (i % 40));
  k.tick(2);
  assert.ok(!k.room.watchers.has(w.id) && !k.room.lagged.has(w.id));
  const last = w.got[w.got.length - 1];
  assert.deepStrictEqual([last[0], last[1].none, last[1].why], ['pp:watching', true, 'full']);
});

test('one address holds at most two paid watchers (every paid rung together); free watches are not counted', () => {
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
    if (Number(stake) === 0) return { ok: true, worth: 0 };
    const tk = typeof token === 'string' && tokens.get(token);
    if (!tk || Math.abs(tk.stake - Number(stake)) > 1e-9) return { ok: false, worth: 0 };
    tokens.delete(token);
    return { ok: true, worth: tk.worth, paid: tk.paid, walletAddress: tk.walletAddress };
  };
  const paper = createPaperSockets({ arenas, ops: { get: () => ({ maintenance: false }) }, socketRL: () => true,
    sanitizeName: (x) => String(x || 'P'), isStake, consumePaidEntryAtStake: take,
    entryStore: { consumeAtStake: take }, payout: { refund() {} }, paidEnabled: true });
  let tn = 0;
  const mint = (stake) => {
    const t = 'tok' + ++tn;
    tokens.set(t, { stake, worth: stake, paid: stake, walletAddress: 'W' + tn });
    return t;
  };
  let sn = 0;
  function sock(ip) {
    const s = {
      id: 'c' + ++sn, handshake: { address: ip, headers: {} }, handlers: {}, got: [], rooms: new Set(),
      on(ev, fn) { this.handlers[ev] = fn; },
      emit(ev, p) { this.got.push([ev, p]); },
      join(r) { this.rooms.add(r); },
      leave(r) { this.rooms.delete(r); },
      fire(ev, p) { this.handlers[ev](p); },
      lastWatching() { const g = this.got.filter((x) => x[0] === 'pp:watching'); return g.length ? g[g.length - 1][1] : null; }
    };
    sockets.set(s.id, s);
    paper.attach(s);
    return s;
  }
  for (const stake of [0.5, 1]) {
    const p = sock('203.0.113.50');
    p.fire('pp:join', { name: 'p' + stake, stake, entryToken: mint(stake) });
    assert.ok(p.got.some((x) => x[0] === 'pp:joined'), 'someone plays at ' + stake);
  }
  const free = sock('203.0.113.50');
  free.fire('pp:join', { name: 'f', stake: 0 });
  const freeRoom = free._ppRoom;
  const paidWatchers = () => arenas.all().filter((r) => r.stake > 0).reduce((n, r) => n + r.watchers.size, 0);
  const one = sock('198.51.100.7');
  one.fire('pp:watch', { stake: 0.5 });
  const two = sock('198.51.100.7');
  two.fire('pp:watch', { stake: 1 });
  assert.strictEqual(paidWatchers(), 2, 'two from one address, on two rungs');
  assert.strictEqual(one.lastWatching(), null, 'its state is on its way (WATCH_DELAY_MS)');
  const three = sock('198.51.100.7');
  three.fire('pp:watch', { stake: 0.5 });
  assert.deepStrictEqual([three.lastWatching().none, three.lastWatching().why], [true, 'full'], 'a third is refused');
  assert.strictEqual(paidWatchers(), 2);
  one.fire('pp:watch', { stake: 0.5 });
  assert.strictEqual(one.lastWatching(), null, 'one of the two asking again is still watching');
  assert.ok(one._ppWatch && one._ppWatch.watchers.has(one.id));
  const elsewhere = sock('198.51.100.8');
  elsewhere.fire('pp:watch', { stake: 0.5 });
  assert.strictEqual(paidWatchers(), 3, 'another address watches');
  const freeWatch = sock('198.51.100.7');
  freeWatch.fire('pp:watch', { stake: 0 });
  assert.ok(freeWatch.lastWatching() && !freeWatch.lastWatching().none, 'a free watch is not capped');
  assert.ok(freeRoom.watchers.has(freeWatch.id));
  // one of the two leaves: that address may watch again
  two.fire('pp:leave');
  three.fire('pp:watch', { stake: 0.5 });
  assert.ok(three._ppWatch && three._ppWatch.watchers.has(three.id));
  // pp:need from a paid watcher waits in its queue
  const before = three.got.length;
  three.fire('pp:need', { id: 0 });
  assert.strictEqual(three.got.length, before, 'no pp:geo now');
  assert.strictEqual(three._ppWatch.lagged.get(three.id).q.slice(-1)[0].ev, 'pp:geo');
});

test('a dead page is shown around its killer DEAD_VIEW_TICKS, then only where it died', () => {
  const k = roomKit();
  const a = k.seat(at(600, 0), 'a');
  const b = k.seat(at(600, Math.PI), 'b');
  b.u.still = true;
  k.tick(2);
  k.room.onDeath(a.u, b.u, 1, a.u.position);
  k.g.removeHuman(a.u.id, 1);
  const frames = () => a.s.all('pp:s').map((x) => MP.decodeFrame(x));
  a.s.got.length = 0;
  k.tick(4);
  assert.ok(frames().length && frames().every((f) => f.units.some((u) => u.id === b.u.id)), 'the killer first');
  k.tick(Math.round(15000 / STEP));
  a.s.got.length = 0;
  k.tick(4);
  assert.ok(frames().length && frames().every((f) => !f.units.length), 'then only where it died: nobody there');
  assert.ok(!b.u.death && Math.hypot(b.u.position.x - a.u.position.x, b.u.position.y - a.u.position.y) > R);
  // a watcher's dead square keeps its killer for the delay on top (the page sees the death that much later)
  assert.strictEqual(k.room.deathViewTicks, Math.round(10000 / STEP) + LAG);
});

test('a square is seen by its trail only where the trail runs, never by an empty corner of its box', () => {
  const g = makeArena({ stake: 0.5, seed: 0.51 });
  g.radiusTarget = () => 950;
  g.setRadiusNow(950);
  const wire = new ArenaWire(g, { queue: () => {}, cull: true });
  const h = g.spawnHuman({ name: 'h' }, at(520, Math.PI));
  let sq = 0;
  const run = (angle, ticks) => {
    for (let i = 0; i < ticks && !h.death; i++) {
      g.setInput(h.id, (++sq) & 255, MP.angleToByte(angle), false, 0);
      g.update(STEP);
      wire.feed();
    }
  };
  run(0, 360); // east
  run(-Math.PI / 2, 360); // then north: an L, the box's top-left corner empty
  assert.ok(!h.death && h.in !== h.base, 'out on one open trail');
  const b = h.track.polyline.bounds;
  const tw = g.config.trackWidth;
  const corner = { x: b.left, y: b.top, unit: null };
  assert.ok(b.right - b.left > R + tw + 20 && b.bottom - b.top > R + tw + 20, 'both arms longer than the view: ' + [b.right - b.left, b.bottom - b.top]);
  assert.ok(!wire.seenBy(corner).has(h.id), 'the empty corner of its box sees nothing of it');
  assert.ok(wire.seenBy({ x: (b.left + b.right) / 2, y: b.bottom + R - 30, unit: null }).has(h.id), 'below the east arm');
  assert.ok(wire.seenBy({ x: b.right - R + 30, y: (b.top + b.bottom) / 2, unit: null }).has(h.id), 'beside the north arm');
  assert.ok(wire.seenBy({ x: h.position.x, y: h.position.y - R + 20, unit: null }).has(h.id), 'its head');
  assert.ok(wire.seenBy({ x: b.left - R + 40, y: b.bottom, unit: null }).has(h.id), 'where the trail began');
});
