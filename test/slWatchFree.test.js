'use strict';
// Spectate in the free room (the lobby's Spectate on slither.io's Free rung; server/sl/slSockets.js watchOf,
// slArenas.watch, slRoom seatWatch and _leaderAfter; the page side is test/slxWatch.test.js). A free socket whose
// handshake says watch 1 watches the leader (bots included) or the snake ranked after `after`, through the real
// slSockets and the free directory on the fixture table: never a seat, never counted, never steering, holding or
// chatting; 'nobody', 'full', 'closed'; money fields refused; a paid socket stays paid; a paid rung watched read only
// (watchStake, slPaidArenas.watch); the battle royale unchanged
// (test/slBr.test.js runs its own watch tests on the same seatWatch).

const test = require('node:test');
const assert = require('node:assert');
const W = require('../shared/slWire.js');
const { rig, layerMsgs } = require('./slSockFakes');
const { bareSocket } = require('./slNetFakes');
const { paidRig } = require('./slPaidFakes');

function stepRoom(r, n) {
  const P = r.laws.L7.value;
  for (let i = 0; i < (n || 1); i++) {
    r.ft.advance(P);
    r.room().wake();
    r.ft.runImmediates();
  }
}

function refusedWith(s, why) {
  const last = s.emitted[s.emitted.length - 1];
  assert.ok(last && last.name === 'sl:x', 'the last emit is the sl:x refusal');
  assert.deepStrictEqual(last.data, [{ t: 'refused', why }]);
  assert.strictEqual(s.disconnected, true);
}

// A free room with a player (Owen, the shortest) and two longer snakes standing for bots.
function freeRoom(o) {
  const r = rig(o);
  const room = r.room();
  const p = r.sock({ auth: { cv: 3 } });
  p.fire('sl:join', { nick: 'Owen' });
  const owen = room.seatOf(p.id).snakeId;
  const big = room.sim.spawn({ cv: 2, nick: 'Big Bot', sct: 60 });
  const mid = room.sim.spawn({ cv: 4, nick: 'Mid Bot', sct: 30 });
  stepRoom(r, 2);
  return { r, room, p, owen, big, mid };
}

function watchMsg(s) {
  return layerMsgs(s).filter((m) => m.t === 'watch');
}

test('a free watch socket follows the leader (a bot here) as its own snake; it is no seat and counts nowhere', () => {
  const { r, room, p, big } = freeRoom();
  const snakesBefore = room.snakes.size;
  const pushes = r.pushes.length;
  const w = r.sock({ auth: { watch: 1, cv: 5 } });
  w.fire('sl:join', { nick: 'Spy' });
  assert.strictEqual(w.disconnected, false);
  assert.strictEqual(room.watchers.size, 1);
  assert.strictEqual(room.seats.size, 1, 'only Owen holds a seat');
  assert.strictEqual(room.playerCount, 1);
  assert.strictEqual(r.arenas.humanTotal(), 1);
  assert.strictEqual(r.arenas.boardRows()[0].players, 1, 'the board row counts players only');
  assert.strictEqual(room.snakes.size, snakesBefore, 'no snake was made for the watcher');
  assert.strictEqual(room.humans.size, 1);
  assert.deepStrictEqual(watchMsg(w), [{ t: 'watch', id: big.id, name: 'Big Bot' }]);
  assert.ok(!layerMsgs(w).some((m) => m.t === 'seat' || m.t === 'back'), 'no resume key for a watcher');
  assert.ok(!layerMsgs(w).some((m) => m.t === 'br'), 'no battle royale message in the free room');
  assert.ok(w.emitted.some((e) => e.name === 'sl:f'), 'the join bundle went out');
  assert.strictEqual(r.pushes.length, pushes, 'a watcher is no join push');
  assert.strictEqual(r.sockets.stats.watches, 1);
  stepRoom(r, 3);
  assert.ok(room.sim.snake(big.id));
  assert.ok(room.seatOf(p.id) && !room.seatOf(p.id).watch);
});

test('a watcher never steers, holds or chats; its pings get their pongs', () => {
  const { r, room, p, big } = freeRoom();
  const w = r.sock({ auth: { watch: 1 } });
  w.fire('sl:join', {});
  const drops = room.stats.inputDrops;
  const pongs = room.stats.pongs;
  const fBefore = w.emitted.filter((e) => e.name === 'sl:f').length;
  w.fire('sl:i', W.encodeInput([{ type: 'ping' }, { type: 'angle', q: 100 }, { type: 'boost', on: true }]));
  r.ft.runImmediates();
  assert.strictEqual(room.stats.pongs, pongs + 1, 'one pong');
  assert.strictEqual(room.stats.inputDrops, drops + 2, 'the angle and the boost are dropped');
  assert.ok(w.emitted.filter((e) => e.name === 'sl:f').length > fBefore, 'the pong went out');
  const s = room.sim.snake(big.id);
  const wang = s.wang;
  stepRoom(r, 3);
  assert.strictEqual(s.boosting, false, 'the watched snake does not boost');
  assert.strictEqual(s.wang, wang, 'nor turn');
  w.fire('sl:hold', { on: 1 });
  stepRoom(r, 2);
  assert.strictEqual(room.holds.holding(big.id), false, 'no hold');
  const chats = room.stats.chats;
  w.fire('sl:chat', { text: 'hello' });
  assert.strictEqual(room.stats.chats, chats);
  assert.ok(!layerMsgs(p).some((m) => m.t === 'chat'), 'nobody got a line from the watcher');
});

// Next and Previous go round in a fixed order (snake id), so two snakes of about the same length never make Next bounce
// between them; with nothing to step from, the leader.
test('after: the next snake in id order, wrapping round; a gone after means the leader', () => {
  const { r, room, owen, big, mid } = freeRoom();
  const at = (after) => {
    const w = room.seatWatch(bareSocket(), { after });
    return w && w.snakeId;
  };
  const ids = [owen, big.id, mid.id].sort((a, b) => a - b);
  const next = (id) => ids[(ids.indexOf(id) + 1) % ids.length];
  assert.strictEqual(at(undefined), big.id, 'no after: the leader');
  for (const id of ids) assert.strictEqual(at(id), next(id), 'bots and people in one order, wrapping');
  assert.strictEqual(at(65000), big.id, 'not alive: the leader');
  // through the handshake
  const w = r.sock({ auth: { watch: 1, after: mid.id } });
  w.fire('sl:join', {});
  assert.strictEqual(watchMsg(w)[0].id, next(mid.id));
});

test('before (Previous): the one before in id order, wrapping round; after wins over before; bad is the leader', () => {
  const { r, room, owen, big, mid } = freeRoom();
  const at = (info) => {
    const w = room.seatWatch(bareSocket(), info);
    return w && w.snakeId;
  };
  const ids = [owen, big.id, mid.id].sort((a, b) => a - b);
  const prev = (id) => ids[(ids.indexOf(id) + ids.length - 1) % ids.length];
  const next = (id) => ids[(ids.indexOf(id) + 1) % ids.length];
  for (const id of ids) assert.strictEqual(at({ before: id }), prev(id), 'wrapping');
  assert.strictEqual(at({ before: 65000 }), big.id, 'not alive: the leader');
  assert.strictEqual(at({ after: big.id, before: owen }), next(big.id), 'after wins');
  // through the handshake, checked as after is
  const w = r.sock({ auth: { watch: 1, before: owen } });
  w.fire('sl:join', {});
  assert.strictEqual(watchMsg(w)[0].id, prev(owen));
  for (const b of ['5', 5.5, -1, 0, 65536, NaN, {}, [owen], null, true]) {
    const s = r.sock({ auth: { watch: 1, before: b } });
    s.fire('sl:join', {});
    assert.strictEqual(watchMsg(s)[0].id, big.id, 'before ' + String(b) + ': the leader');
    s.fire('disconnect', 'client namespace disconnect');
  }
  const auth = Object.create(null);
  auth.watch = 1;
  Object.defineProperty(auth, 'before', { enumerable: true, get() { throw new Error('getter called'); } });
  const g = r.sock({ auth });
  g.fire('sl:join', {});
  assert.strictEqual(watchMsg(g)[0].id, big.id, 'a getter is never called');
});

test('hostile watch handshakes: a bad watch is no watcher, a bad after is the leader, nothing throws', () => {
  const { r, room, big } = freeRoom();
  const guarded = r.sockets.stats.guarded;
  // watch must be exactly 1: anything else is a plain free player, as before
  for (const v of [true, '1', 2, 0, null, {}, [1]]) {
    const s = r.sock({ auth: { watch: v } });
    s.fire('sl:join', { nick: 'x' });
    assert.ok(room.seatOf(s.id) && !room.seatOf(s.id).watch, 'watch ' + JSON.stringify(v) + ' is a player');
    s.fire('sl:leave');
    s.fire('disconnect', 'client namespace disconnect');
  }
  const bad = ['5', 5.5, -1, 0, 65536, NaN, Infinity, {}, [big.id], null, true, 1e300];
  for (const a of bad) {
    const s = r.sock({ auth: { watch: 1, after: a } });
    s.fire('sl:join', {});
    assert.strictEqual(watchMsg(s)[0].id, big.id, 'after ' + String(a) + ': the leader');
    s.fire('disconnect', 'client namespace disconnect');
  }
  // a getter is never called; a null-prototype auth is read like a plain one
  const auth = Object.create(null);
  auth.watch = 1;
  Object.defineProperty(auth, 'after', { enumerable: true, get() { throw new Error('getter called'); } });
  const g = r.sock({ auth });
  g.fire('sl:join', {});
  assert.strictEqual(watchMsg(g)[0].id, big.id);
  // auth that is no plain object: a plain player, as before
  for (const a of ['watch', 1, [1], null]) {
    const s = r.sock({ auth: a });
    s.fire('sl:join', {});
    assert.ok(room.seatOf(s.id) && !room.seatOf(s.id).watch);
    s.fire('disconnect', 'client namespace disconnect');
  }
  // junk joins on a watch socket
  const j = r.sock({ auth: { watch: 1 } });
  j.fire('sl:join', 'nick');
  j.fire('sl:join', [1]);
  assert.strictEqual(watchMsg(j).length, 0, 'a junk sl:join is ignored');
  j.fire('sl:join', {});
  assert.strictEqual(watchMsg(j).length, 1);
  assert.strictEqual(r.sockets.stats.guarded, guarded, 'no handler threw');
});

test('nobody to watch in an empty room (and the ask wakes it), full at C_HUMAN_CAP watchers, closed and maintenance', () => {
  const r = rig({ patch: { C_HUMAN_CAP: 2 } });
  const room = r.room();
  assert.strictEqual(room.ticking, false, 'nobody woke the room yet');
  const n = r.sock({ auth: { watch: 1 } });
  n.fire('sl:join', {});
  refusedWith(n, 'nobody');
  assert.strictEqual(room.ticking, true, 'the ask wakes it, so its bots can fill');
  assert.strictEqual(room.watchers.size, 0);
  room.sim.spawn({ cv: 1, nick: 'B', sct: 10 });
  for (let i = 0; i < 2; i++) r.sock({ auth: { watch: 1 } }).fire('sl:join', {});
  assert.strictEqual(room.watchers.size, 2);
  const f = r.sock({ auth: { watch: 1 } });
  f.fire('sl:join', {});
  refusedWith(f, 'full');
  // the watchers never took a player's place: two players still sit (C_HUMAN_CAP 2)
  for (let i = 0; i < 2; i++) {
    const s = r.sock({ auth: {} });
    s.fire('sl:join', { nick: 'P' + i });
    assert.strictEqual(s.disconnected, false, 'player ' + i + ' seated');
  }
  assert.strictEqual(room.seats.size, 2);
  r.ops.maintenance = true;
  const m = r.sock({ auth: { watch: 1 } });
  m.fire('sl:join', {});
  refusedWith(m, 'maintenance');
  r.ops.maintenance = false;
  r.arenas.door(false);
  const c = r.sock({ auth: { watch: 1 } });
  c.fire('sl:join', {});
  refusedWith(c, 'closed');
});

test('money fields with watch are refused not-open, never watched and never seated', () => {
  const { r, room } = freeRoom();
  const cases = [{ paid: 1 }, { paid: 0 }, { stake: 0.5 }, { entryToken: 'tok' }, { resumeKey: 'k' }, { idProof: {} }];
  for (const extra of cases) {
    const s = r.sock({ auth: Object.assign({ watch: 1 }, extra) });
    s.fire('sl:join', {});
    refusedWith(s, 'not-open');
  }
  const m = r.sock({ auth: { watch: 1 } });
  m.fire('sl:join', { stake: 1 });
  refusedWith(m, 'not-open');
  assert.strictEqual(room.watchers.size, 0);
  assert.strictEqual(room.seats.size, 1);
});

test('a paid socket that also says watch stays a paid socket (seated, never a watcher)', () => {
  const r = paidRig();
  const s = r.join(r.mint(), { auth: { watch: 1 }, nick: 'Payer' });
  assert.strictEqual(s.disconnected, false);
  assert.strictEqual(r.arenas.room().watchers.size, 0, 'not a free watcher');
  const rooms = r.paid.rooms();
  const seated = rooms.filter((room) => room.seatOf(s.id));
  assert.strictEqual(seated.length, 1, 'seated in a paid room');
  assert.strictEqual(seated[0].seatOf(s.id).watch, undefined);
  assert.ok(!watchMsg(s).length);
  for (const room of rooms) assert.strictEqual(room.watchers.size, 0);
});

// Spectate on a paid rung (Owen, 2026-10-15): watchStake 0.5 or 1 watches that rung's busiest room, read only.
test('a paid rung watcher (watchStake) follows a paying player as its own view: no seat, no account, no money call', async () => {
  const r = paidRig();
  const payer = r.join(r.mint({ stake: 1, worth: 1, paid: 1 }), { auth: { stake: 1 }, nick: 'Payer' });
  await r.settle();
  const room = r.paid.rooms().find((x) => x.seatOf(payer.id));
  assert.ok(room, 'the payer is seated at $1');
  const opens = room.money.openCount();
  const w = r.sock({ ip: '10.0.0.2', auth: { watch: 1, watchStake: 1 } });   // another address than the payer's
  w.fire('sl:join', {});
  assert.strictEqual(w.disconnected, false);
  assert.strictEqual(room.watchers.size, 1, 'watching the $1 room');
  assert.strictEqual(room.seats.size, 1, 'still one seat');
  assert.strictEqual(room.money.openCount(), opens, 'no account opened');
  assert.strictEqual(r.arenas.room().watchers.size, 0, 'not the free room');
  const m = watchMsg(w);
  assert.strictEqual(m.length, 1);
  assert.strictEqual(m[0].id, room.seatOf(payer.id).snakeId, 'following the paying player');
  // its calls go to the paid directory and reach nothing but the view
  w.fire('sl:hold', true);
  w.fire('sl:chat', 'hi');
  assert.strictEqual(room.money.openCount(), opens);
  // the board counts players only
  const row = r.paid.boardRows().find((x) => x.stake === 1);
  assert.strictEqual(row.players, 1);
  // leaving ends the view; the paid directory finds the watcher's socket
  w.disconnect();
  assert.strictEqual(room.watchers.size, 0);
});

test('a paid rung watcher\'s Previous and Next: after and before reach the room\'s seatWatch as snake ids, nothing more', async () => {
  const r = paidRig();
  const payer = r.join(r.mint({ stake: 1, worth: 1, paid: 1 }), { auth: { stake: 1 }, nick: 'Payer' });
  await r.settle();
  const room = r.paid.rooms().find((x) => x.seatOf(payer.id));
  const id = room.seatOf(payer.id).snakeId;
  const asks = [];
  const real = room.seatWatch.bind(room);
  room.seatWatch = (socket, info) => { asks.push(Object.assign({}, info)); return real(socket, info); };
  const opens = room.money.openCount();
  for (const auth of [{ before: id }, { after: id }, { before: 'x' }]) {
    const w = r.sock({ ip: '10.0.0.2', auth: Object.assign({ watch: 1, watchStake: 1 }, auth) });
    w.fire('sl:join', {});
    assert.strictEqual(watchMsg(w)[0].id, id, 'one player: Previous and Next wrap to them');
    w.disconnect();
  }
  assert.deepStrictEqual(asks, [{ after: null, before: id }, { after: id, before: null }, { after: null, before: null }]);
  assert.strictEqual(room.seats.size, 1);
  assert.strictEqual(room.money.openCount(), opens, 'no account opened');
});

// Night review 2026-10-29 (finding 6): a seated payer's address cannot watch its own rung (a second tab could step round
// every other snake), a payer seated from a watcher's address ends that watcher (the door's onSeatedSocket), and an
// address whose snake is gone watches again; another rung, and another address, are not touched.
test('a paid rung watch from the address of a seated payer is refused nobody; a buy-in from that of a watcher ends it', async () => {
  const r = paidRig({ door: { onSeatedSocket: (s, stake) => r.sockets.paidSeated(s, stake) } });
  const payer = r.join(r.mint({ stake: 1, worth: 1, paid: 1 }), { ip: '10.0.0.7', auth: { stake: 1 }, nick: 'Payer' });
  await r.settle();
  const room = r.paid.rooms().find((x) => x.seatOf(payer.id));
  assert.ok(room, 'the payer is seated at $1');
  const twin = r.sock({ ip: '10.0.0.7', auth: { watch: 1, watchStake: 1 } });
  twin.fire('sl:join', {});
  refusedWith(twin, 'nobody');
  assert.strictEqual(room.watchers.size, 0);
  const other = r.sock({ ip: '10.0.0.2', auth: { watch: 1, watchStake: 1 } });
  other.fire('sl:join', {});
  assert.strictEqual(room.watchers.size, 1, 'another address watches');
  // a watcher first, then that address buys in at the same rung: the watcher goes
  const spy = r.sock({ ip: '10.0.0.8', auth: { watch: 1, watchStake: 1 } });
  spy.fire('sl:join', {});
  assert.strictEqual(room.watchers.size, 2);
  const late = r.join(r.mint({ stake: 1, worth: 1, paid: 1 }), { ip: '10.0.0.8', auth: { stake: 1 }, nick: 'Late' });
  await r.settle();
  assert.ok(r.paid.rooms().some((x) => x.seatOf(late.id)), 'the late payer is seated');
  refusedWith(spy, 'nobody');
  assert.strictEqual(room.watchers.size, 1);
  assert.strictEqual(other.disconnected, false, 'the other address keeps watching');
  // the first payer's snake dies: that address may watch again
  const seat = room.seatOf(payer.id);
  room.sim.kill(seat.snakeId);
  r.step(4);
  assert.ok(!room.seatOf(payer.id) || room.seatOf(payer.id).dead, 'the payer is out');
  const again = r.sock({ ip: '10.0.0.7', auth: { watch: 1, watchStake: 1 } });
  again.fire('sl:join', {});
  assert.strictEqual(again.disconnected, false, 'its address watches once its snake is gone');
});

test('a paid life resumed from an address ends the watcher of the rung from that address (the park is no way round it)', async () => {
  const r = paidRig();
  const payer = r.join(r.mint({ stake: 1, worth: 1, paid: 1 }), { ip: '10.0.0.7', auth: { stake: 1 }, nick: 'Payer' });
  await r.settle();
  const room = r.paid.rooms().find((x) => x.seatOf(payer.id));
  r.step(3);
  // the drop: no sl:leave, so the seat is parked (no socket) and its snake glides
  payer.disconnected = true;
  payer.fire('disconnect', 'transport close');
  assert.strictEqual(room.parked.size, 1);
  const spy = r.sock({ ip: '10.0.0.7', auth: { watch: 1, watchStake: 1 } });
  spy.fire('sl:join', {});
  assert.strictEqual(room.watchers.size, 1, 'a parked seat has no socket, so the watch is let in');
  const other = r.sock({ ip: '10.0.0.2', auth: { watch: 1, watchStake: 1 } });
  other.fire('sl:join', {});
  const keys = layerMsgs(payer).filter((x) => x.t === 'seat' || x.t === 'back');
  const back = r.sock({ ip: '10.0.0.7', auth: { paid: 1, stake: 1, cv: 3 } });
  back.fire('sl:back', { k: keys[keys.length - 1].k, n: payer.emitted.filter((e) => e.name === 'sl:f').length, p: 0 });
  assert.ok(room.seatOf(back.id) && !room.seatOf(back.id).watch, 'resumed');
  refusedWith(spy, 'nobody');
  assert.strictEqual(other.disconnected, false, 'another address keeps watching');
  assert.strictEqual(room.watchers.size, 1);
});

test('a paid rung watch: nobody playing is nobody to watch (no room opened); a bad watchStake is refused not-open', () => {
  const r = paidRig();
  const before = r.paid.rooms().length;
  const a = r.sock({ auth: { watch: 1, watchStake: 0.5 } });
  a.fire('sl:join', {});
  refusedWith(a, 'nobody');
  assert.strictEqual(r.paid.rooms().length, before, 'a watcher opens no room');
  for (const bad of [0.25, '1', -1, 1e9, null, true]) {
    const s = r.sock({ auth: { watch: 1, watchStake: bad } });
    s.fire('sl:join', {});
    refusedWith(s, 'not-open');
  }
  // money fields beside watchStake are still refused
  const m = r.sock({ auth: { watch: 1, watchStake: 1, entryToken: 'tok' } });
  m.fire('sl:join', {});
  refusedWith(m, 'not-open');
});

test('without the paid directory a watchStake is refused, never sent to the free room', () => {
  const { r, room } = freeRoom();
  const s = r.sock({ auth: { watch: 1, watchStake: 1 } });
  s.fire('sl:join', {});
  refusedWith(s, 'not-open');
  assert.strictEqual(room.watchers.size, 0);
});

test('a watch socket never becomes a player: sl:back is refused gone, a second sl:join does nothing', () => {
  const { r, room, p } = freeRoom();
  const key = layerMsgs(p).find((m) => m.t === 'seat').k;
  const b = r.sock({ auth: { watch: 1 } });
  b.fire('sl:back', { k: key, n: 0, p: 0 });
  refusedWith(b, 'gone');
  assert.strictEqual(room.seatOf(p.id).socket, p, 'the player keeps the seat');
  const w = r.sock({ auth: { watch: 1 } });
  w.fire('sl:join', {});
  w.fire('sl:join', { nick: 'Again' });
  w.fire('sl:back', { k: key, n: 0, p: 0 });
  assert.strictEqual(room.watchers.size, 1);
  assert.strictEqual(room.seats.size, 1);
  assert.ok(room.seatOf(w.id).watch);
  // and a player's socket never becomes a watcher
  p.fire('sl:join', { nick: 'Owen' });
  assert.ok(!room.seatOf(p.id).watch);
  assert.strictEqual(room.watchers.size, 1);
});

test('the watched snake ends: the watcher sees its own death and the room lets its socket go; a leave ends only the view', () => {
  const { r, room, big, mid } = freeRoom();
  const w = r.sock({ auth: { watch: 1 } });
  w.fire('sl:join', {});
  const other = r.sock({ auth: { watch: 1, after: big.id } });
  other.fire('sl:join', {});
  assert.strictEqual(watchMsg(other)[0].id, mid.id);
  room.sim.kill(big.id);
  stepRoom(r, 3);
  const seat = room.seatOf(w.id);
  assert.strictEqual(seat.dead, true, 'the watcher is dead with its snake');
  const evs = [];
  for (const e of w.emitted) if (e.name === 'sl:f') for (const x of W.decodeBundle(e.data)) evs.push(x);
  assert.ok(evs.some((x) => x.type === 'dead'), 'their client gets the own dead and runs its death');
  assert.strictEqual(room.seatOf(other.id).dead, false, 'the other watcher follows a living snake');
  // a client that never closes is let go by the dead-seat limit
  for (let i = 0; i < 400 && !w.disconnected; i++) stepRoom(r, 1);
  assert.strictEqual(w.disconnected, true);
  assert.strictEqual(room.seatOf(w.id), null);
  other.fire('sl:leave');
  other.fire('disconnect', 'client namespace disconnect');
  assert.strictEqual(room.watchers.size, 0);
  assert.ok(room.sim.snake(mid.id), 'the snake it watched lives on');
  assert.strictEqual(room.seats.size, 1);
});

test('a watcher keeps the free room awake while it watches; the room pauses once it goes', () => {
  const r = rig({ arenas: { autoTick: true }, patch: { C_IDLE_PAUSE_MS: 1500 } });
  const room = r.room();
  const grd = r.laws.L1.value;
  const bot = room.sim.spawn({ cv: 2, nick: 'Bot', sct: 20, x: grd, y: grd });
  const w = r.sock({ auth: { watch: 1 } });
  w.fire('sl:join', {});
  const idle = room.R.idleMs;
  assert.strictEqual(idle, 1500);
  r.ft.run(idle * 3);
  assert.ok(room.stats.wakes > 0, 'the room ticked');
  assert.ok(room.sim.snake(bot.id) && room.seatOf(w.id), 'still watching a living snake');
  assert.strictEqual(room.paused, false, 'still running with a watcher');
  w.fire('sl:leave');
  w.fire('disconnect', 'client namespace disconnect');
  r.ft.run(idle * 3);
  assert.ok(room.paused, 'paused once nobody watches');
});

test('the directory sweep lets go of a closed room\'s watchers too', () => {
  const { r, room } = freeRoom();
  const w = r.sock({ auth: { watch: 1 } });
  w.fire('sl:join', {});
  room.closed = true;
  r.arenas.sweep(Date.now());
  assert.notStrictEqual(r.arenas.room(), room, 'replaced');
  assert.strictEqual(w.disconnected, true, 'the watcher socket is let go');
});
