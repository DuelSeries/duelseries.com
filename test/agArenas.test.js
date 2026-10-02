'use strict';
// agar.io room directory (build brief 9.3 agArenas card), on the FIXTURE law table: one free rung, the L39 cap,
// the cap+1-th player opening room 2, watchers never opening a room, the sweep, the lobby rows, the emergency
// replacement and the law gate.
const test = require('node:test');
const assert = require('node:assert');
const W = require('../shared/agWire');
const L = require('../server/ag/agLaws');
const { AgArenas, ARENA_TUNING } = require('../server/ag/agArenas');
const { ROOM_TUNING } = require('../server/ag/agRoom');
const { FIXTURE, makeFixture } = require('./agLawsFixture');

const quiet = { error() {}, warn() {}, log() {} };

function arenas(laws, opts) {
  return new AgArenas(Object.assign({ laws: laws || FIXTURE, shippableOnly: false, autoTick: false, seed: 11, log: quiet }, opts));
}

let sn = 0;
function sock() {
  return {
    id: 'sk' + ++sn,
    conn: { writeBuffer: [] },
    got: [],
    refused: [],
    closed: false,
    emit(ev, buf) { if (ev === 'ag:f') this.got.push(W.decodeBundle(buf)); else if (ev === 'ag:refused') this.refused.push(buf); },
    disconnect() { this.closed = true; },
    last() { return this.got[this.got.length - 1]; },
  };
}

function tickAll(a) {
  for (const r of a.all()) r.tickOnce();
}

test('the directory refuses a law table that is not shippable', () => {
  assert.throws(() => new AgArenas({ laws: FIXTURE, autoTick: false, log: quiet }), /not shippable/);
  let shippable = true;
  try { L.assertShippable(L.LAWS); } catch (e) { shippable = false; }
  if (!shippable) assert.throws(() => new AgArenas({ autoTick: false, log: quiet }), /not shippable/);
});

test('one free rung, room 0 at boot, filled with bots', () => {
  const a = arenas();
  assert.strictEqual(a.all().length, 1);
  const r = a.all()[0];
  assert.strictEqual(r.index, 0);
  assert.strictEqual(r.stake, 0);
  assert.ok(r.botsAllowed());
  assert.strictEqual(a.cap, FIXTURE.L39.value);
  assert.strictEqual(r.botCount, FIXTURE.L39.value);
});

test('the cap+1-th player opens room 2; watchers never open one', () => {
  const laws = makeFixture({ L39: 2 });
  const a = arenas(laws);
  const [p1, p2, p3] = [sock(), sock(), sock()];
  for (const s of [p1, p2]) assert.strictEqual(a.connect(s), a.all()[0]);
  assert.strictEqual(a.join(p1, 'One'), 'ok');
  assert.strictEqual(a.join(p2, 'Two'), 'ok');
  assert.strictEqual(a.connect(p3), a.all()[0], 'a full room still has watcher seats');
  assert.strictEqual(a.all().length, 1, 'watching a full room opens nothing');
  tickAll(a);
  assert.strictEqual(a.join(p3, 'Three'), 'ok');
  assert.strictEqual(a.all().length, 2);
  const r2 = a.roomOfSocket(p3.id);
  assert.strictEqual(r2.index, 1);
  assert.strictEqual(r2.lobbyType, 'ag_na_s0#1');
  assert.strictEqual(a.all()[0].seatOf(p3.id), null, 'moved out of room 1');
  const before = p3.got.length;
  tickAll(a);
  // Its page held room 1's world: the first bundle from room 2 clears it, then the join order again.
  const first = p3.got[before];
  assert.deepStrictEqual(first.slice(0, 3).map((x) => x.t), ['clearAll', 'hello', 'border']);
  assert.ok(first.some((x) => x.t === 'own'));
  // A new watcher goes where a Play would land: the room with a free slot.
  const w = sock();
  assert.strictEqual(a.connect(w), r2);
  assert.strictEqual(a.liveCount(), 3);
});

test('rooms stop at MAX_ROOMS; a Play then is refused as full', () => {
  const a = arenas(makeFixture({ L39: 1 }));
  const max = ARENA_TUNING.MAX_ROOMS.value;
  const socks = [];
  for (let i = 0; i < max; i++) {
    const s = sock();
    socks.push(s);
    assert.strictEqual(a.join(s, 'P' + i), 'ok');
  }
  assert.strictEqual(a.all().length, max);
  const extra = sock();
  assert.strictEqual(a.join(extra, 'Late'), 'full');
  assert.strictEqual(a.all().length, max);
  // A slot frees: the late player gets it.
  a.disconnect(socks[3].id);
  assert.strictEqual(a.join(extra, 'Late'), 'ok');
  assert.strictEqual(a.roomOfSocket(extra.id).index, 3);
});

test('sweep: an empty overflow room closes after the idle time; room 0 never does', () => {
  const a = arenas(makeFixture({ L39: 1 }));
  const p = sock();
  const q = sock();
  a.join(p, 'P');
  a.join(q, 'Q');
  assert.strictEqual(a.all().length, 2);
  const over = a.roomOfSocket(q.id);
  const idle = ARENA_TUNING.SWEEP_IDLE_MS.value;
  a.sweep(0);
  assert.strictEqual(a.all().length, 2, 'a room with a socket stays');
  a.disconnect(q.id);
  a.disconnect(p.id);
  a.sweep(1000);
  a.sweep(1000 + idle - 1);
  assert.strictEqual(a.all().length, 2);
  a.sweep(1000 + idle);
  assert.strictEqual(a.all().length, 1);
  assert.strictEqual(a.all()[0].index, 0);
  assert.strictEqual(over.stopped, true);
  // A watcher resets the idle count.
  a.join(p, 'P');
  a.join(q, 'Q');
  const over2 = a.roomOfSocket(q.id);
  a.leave(q.id);
  const w = sock();
  over2.addSocket(w);
  a.sweep(0);
  a.sweep(idle * 2);
  assert.strictEqual(over2.stopped, false);
});

test('boardRows and liveCount, the way paperArenas gives them', () => {
  const a = arenas();
  const rows = a.boardRows();
  assert.deepStrictEqual(rows, [{
    id: 'ag:na:s0', game: 'agar', region: 'na', stake: 0, players: 0, bots: FIXTURE.L39.value,
    capacity: FIXTURE.L39.value, state: 'open',
  }]);
  const s = sock();
  const w = sock();
  a.connect(w);
  a.join(s, 'Human');
  tickAll(a);
  assert.strictEqual(a.liveCount(), 1, 'a watcher is not counted');
  assert.strictEqual(a.humanTotal(), 1);
  const r = a.boardRows()[0];
  assert.strictEqual(r.players, 1);
  assert.strictEqual(r.bots, FIXTURE.L39.value - 1);
  // liveCounts reads humanTotal like Paper's.
  const { liveCounts } = require('../server/liveCounts');
  assert.strictEqual(liveCounts({ paper: a }).paper, 1);
});

test('ag:leave: the player goes at once; its next seat starts with clearAll', () => {
  const a = arenas();
  const s = sock();
  a.join(s, 'Leaver');
  tickAll(a);
  const room = a.roomOfSocket(s.id);
  const pid = room.seatOf(s.id).pid;
  assert.strictEqual(a.leave(s.id), true);
  assert.strictEqual(a.roomOfSocket(s.id), null);
  tickAll(a);
  assert.strictEqual(room.sim.playerInfo(pid), null);
  const n = s.got.length;
  tickAll(a);
  assert.strictEqual(s.got.length, n, 'nothing is sent after leaving');
  assert.strictEqual(a.join(s, 'Back'), 'ok');
  tickAll(a);
  assert.strictEqual(s.last()[0].t, 'clearAll');
});

test('an emergency-closed room is replaced at its index with its sockets seated again', () => {
  const a = arenas();
  const s = sock();
  a.join(s, 'Survivor');
  tickAll(a);
  const old = a.all()[0];
  old.sim.step = () => { throw new Error('boom'); };
  old.tickOnce();
  old.tickOnce();
  old.tickOnce();
  assert.strictEqual(old.stopped, true);
  assert.strictEqual(a.all().length, 1);
  const fresh = a.all()[0];
  assert.notStrictEqual(fresh, old);
  assert.strictEqual(fresh.index, 0);
  assert.strictEqual(a.roomOfSocket(s.id), fresh);
  fresh.tickOnce();
  assert.strictEqual(s.last()[0].t, 'clearAll');
  assert.strictEqual(a.join(s, 'Survivor'), 'ok');
});

// Review 2026-10-02, finding 1/5: watchers spread over the rooms with a watcher seat, never open one, and are
// refused past every room's watcher seats; a Play still finds a player slot.
test('watchers spread over the rooms with a watcher seat and are refused past them; a Play still lands', () => {
  const laws = makeFixture({ L39: 2 });
  const a = arenas(laws);
  const watch = Math.floor(2 * ROOM_TUNING.WATCHERS_PER_SLOT.value);
  const r0 = a.all()[0];
  // Two players in room 0 and one in an overflow room: room 1 is where a Play would land.
  const [p1, p2, p3] = [sock(), sock(), sock()];
  a.join(p1, 'One');
  a.join(p2, 'Two');
  a.join(p3, 'Three');
  const r1 = a.roomOfSocket(p3.id);
  assert.strictEqual(r1.index, 1);
  const ws = [];
  for (let i = 0; i < watch * 2; i++) {
    const w = sock();
    ws.push(w);
    assert.ok(a.connect(w), 'watcher ' + i + ' seated');
  }
  assert.strictEqual(r1.watcherCount, watch, 'the room a Play would land in fills first');
  assert.strictEqual(r0.watcherCount, watch, 'then the other room');
  const late = sock();
  assert.strictEqual(a.connect(late), null, 'no watcher seat anywhere');
  assert.strictEqual(a.roomOfSocket(late.id), null);
  assert.strictEqual(a.all().length, 2, 'a watcher never opens a room');
  // A socket with no seat that presses Play is seated on a player slot (here room 1 has one).
  assert.strictEqual(a.join(late, 'Late'), 'ok');
  assert.strictEqual(a.roomOfSocket(late.id), r1);
  // A watcher in a room with no player slot moves on its Play even when the target's watcher seats are full.
  const w0 = ws.find((w) => a.roomOfSocket(w.id) === r0);
  assert.strictEqual(a.join(w0, 'Mover'), 'ok');
  assert.notStrictEqual(a.roomOfSocket(w0.id), r0);
  for (const r of a.all()) assert.ok(r.watcherCount <= r.watchCap);
});

test('an emergency close re-seats its sockets within the watcher seats and refuses the rest', () => {
  const laws = makeFixture({ L39: 2 });
  const a = arenas(laws);
  const old = a.all()[0];
  const socks = [];
  for (let i = 0; i < 2; i++) { const s = sock(); socks.push(s); assert.strictEqual(a.join(s, 'P' + i), 'ok'); }
  for (let i = 0; i < old.watchCap; i++) { const s = sock(); socks.push(s); assert.ok(a.connect(s)); }
  tickAll(a);
  old.sim.step = () => { throw new Error('boom'); };
  old.tickOnce();
  old.tickOnce();
  old.tickOnce();
  const fresh = a.all()[0];
  assert.notStrictEqual(fresh, old);
  // Every socket comes back as a watcher; the fresh room has watchCap watcher seats and no other room exists.
  const seated = socks.filter((s) => a.roomOfSocket(s.id));
  const refused = socks.filter((s) => !a.roomOfSocket(s.id));
  assert.strictEqual(seated.length, fresh.watchCap);
  assert.strictEqual(refused.length, socks.length - fresh.watchCap);
  for (const s of refused) {
    assert.deepStrictEqual(s.refused, [{ why: 'full' }]);
    assert.strictEqual(s.closed, true, 'a socket with no seat is closed');
  }
  for (const s of seated) assert.strictEqual(s.closed, false);
  assert.ok(fresh.watcherCount <= fresh.watchCap);
});
