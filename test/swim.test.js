'use strict';
/* Swim: the shared sim, the traffic, how a race is judged, and the seat and
   money rules of its lobby (the same rules as Knockout's, see duelQueue.js). */
const test = require('node:test');
const assert = require('node:assert');
const S = require('../shared/swimSim');
const { Spawner } = require('../server/swim/swimTraffic');
const { SwimRoom, LAG_MAX } = require('../server/swim/SwimRoom');
const { SwimLobby, PAID_GIVE_UP_MS, FREE_WAIT_MS } = require('../server/swim/SwimLobby');

const fakeIo = () => {
  const sent = [];
  const room = (name) => ({
    emit: (ev, p) => sent.push({ to: name, ev, p }),
    volatile: { emit: (ev, p) => sent.push({ to: name, ev, p, volatile: true }) },
  });
  return { sent, to: room };
};
let sid = 0;
const sock = (id) => {
  const got = [];
  return { id: id || 'sock' + (++sid), got, emit: (ev, p) => got.push({ ev, p }), join() {}, leave() {} };
};

/* A room with the traffic under the test's control: no spawning, cars placed by hand. */
function bareRoom(now) {
  const io = fakeIo();
  const room = new SwimRoom(io);
  room.spawner = { run() {} };
  room.io = io;
  return { room, io, now };
}
const at = (room, tick) => room.goAt + tick * S.TICK_MS + 0.5;
/* Run the clock to `until`, each seat sending its input for the tick about to run just before
   it does (as a screen does). A seat with stall set stops sending after that tick. */
function run(room, until, codeA, codeB, stallB) {
  for (let t = room.clock + 1; t <= until && room.state === 'racing'; t++) {
    if (codeA != null) room.input('a', { t: t - 1, k: [codeA] });
    if (codeB != null && !(stallB != null && t - 1 > stallB)) room.input('b', { t: t - 1, k: [codeB] });
    room.tick(at(room, t));
  }
}
/* The tick a lone car driving straight with `code` first touches the record `rec`. */
function crashTickFor(side, rec, code) {
  const c = S.newCar(side), tr = new S.Traffic();
  tr.add(rec.slice());
  while (c.alive && c.tick < 100000) S.step(c, code, tr);
  return c.crashTick;
}

test('inputs pack and unpack', () => {
  for (const s of [-1, -0.5, 0, 0.26, 1]) for (const p of [-1, 0, 1]) {
    const c = S.packInput(s, p);
    assert.ok(S.validInput(c));
    assert.strictEqual(S.pedalOf(c), p);
    assert.ok(Math.abs(S.steerOf(c) - s) <= 1 / S.STEER_Q);
  }
  assert.strictEqual(S.validInput(-1), false);
  assert.strictEqual(S.validInput(S.INPUT_MAX + 1), false);
  assert.strictEqual(S.validInput(1.5), false);
});

test('the step is deterministic and stays on the road', () => {
  const a = S.newCar(0), b = S.newCar(0);
  const r = S.rng(7);
  for (let i = 0; i < 5000; i++) {
    const c = S.packInput(r() * 2 - 1, Math.floor(r() * 3) - 1);
    S.step(a, c, null); S.step(b, c, null);
  }
  assert.deepStrictEqual(a, b);
  assert.ok(Math.abs(a.x) <= S.WALL + 1e-9);
  assert.ok(a.v >= S.FLOOR_MIN - 1e-9 && a.v <= S.topSpeed(a.tick) + 1e-9);
});

test('a traffic car is hit only when the boxes touch', () => {
  const tr = new S.Traffic();
  tr.add([1, 1, 0, 50, 0, 0]);                     // a sedan in lane 1 at z 50 on tick 0
  const hl = S.CAR.HL + S.TYPES[0].hl;
  assert.strictEqual(tr.hitAt(S.laneX(1), 50 - hl - 0.01, 0), -1);
  assert.strictEqual(tr.hitAt(S.laneX(1), 50 - hl + 0.01, 0), 1);
  assert.strictEqual(tr.hitAt(S.laneX(2), 50, 0), -1, 'the next lane is clear');
  // It moves at its lane's speed: one second later it is LANE_V[1] further on.
  assert.strictEqual(tr.hitAt(S.laneX(1), 50 + S.LANE_V[1], 60), 1);
  // Between two cars side by side there is just room.
  tr.add([2, 2, 0, 50, 0, 0]);
  assert.strictEqual(tr.hitAt(0, 50, 0), -1);
});

test('the spawner fills to the horizon and never shuts all four lanes where it places a car', () => {
  const sp = new Spawner(99);
  const tr = new S.Traffic();
  let z = 0;
  for (let t = 0; t < 60 * 240; t++) {
    const out = [];
    sp.run(tr, t, z, 50, out);
    for (const rec of out) {
      // The car just placed: at least one other lane is open beside it.
      tr.lanes[rec[1]].splice(tr.lanes[rec[1]].indexOf(rec), 1);
      assert.strictEqual(sp.shuts(tr, rec[1], rec[3], rec[2], t), false, 'record ' + rec[0]);
      tr.lanes[rec[1]].push(rec);
      assert.ok(S.validRecord(rec));
      if (S.TYPES[rec[2]].right) assert.ok(rec[1] >= 2, 'trucks and buses keep right');
    }
    z += 50 / 60;
    tr.prune(z - 120, t);
  }
  assert.ok(tr.size > 20, 'there is traffic');
});

function racing(seats) {
  const { room } = bareRoom();
  const a = sock('a'), b = sock('b');
  room.addPlayer(a, 'Ann', seats && seats.wa, seats && seats.worth, seats && seats.worth);
  room.addPlayer(b, 'Bob', seats && seats.wb, seats && seats.worth, seats && seats.worth);
  room.stake = seats && seats.worth ? seats.worth : 0;
  room.start(1000);
  room.tick(room.goAt);
  assert.strictEqual(room.state, 'racing');
  return { room, a, b };
}

test('a crash loses, judged on the own tick of the car that crashed, even when the other trails behind', () => {
  const { room } = racing();
  const rec = [1, 1, 0, 50, 0, 0];               // a sedan in Ann's lane 50 m on
  room.traffic.add(rec.slice());
  const c = crashTickFor(0, rec, S.NEUTRAL);
  assert.ok(c > 60);
  // Bob's inputs stop well before Ann's crash, so his car trails the clock by LAG_MAX.
  run(room, c + 10, S.NEUTRAL, S.packInput(0, 1), c - 40);
  assert.strictEqual(room.bySide(0).car.alive, false);
  assert.strictEqual(room.bySide(0).car.crashTick, c);
  assert.strictEqual(room.bySide(1).car.tick, c + 10 - LAG_MAX);
  assert.strictEqual(room.state, 'racing', 'not decided until Bob reaches the crash tick');
  run(room, c + 40, null, S.packInput(0, 1));
  assert.strictEqual(room.state, 'over');
  assert.strictEqual(room.winner, 'b');
  assert.strictEqual(room.overWhy, 'crashed');
  assert.strictEqual(room.endTick, c);
});

test('a silent connection is moved on with its last input after LAG_MAX ticks', () => {
  const { room } = racing();
  run(room, 200, S.NEUTRAL, S.NEUTRAL, 10);
  assert.strictEqual(room.bySide(0).car.tick, 200);
  assert.strictEqual(room.bySide(1).car.tick, 200 - LAG_MAX);
});

test('inputs from the future, malformed ones and ones for ticks already run are ignored', () => {
  const { room } = racing();
  for (let t = 1; t <= 30; t++) room.tick(at(room, t));
  const p = room.bySide(0);
  assert.strictEqual(room.input('a', { t: 30 + 200, k: [S.packInput(1, 1)] }), false);
  assert.strictEqual(room.input('a', { t: 'x', k: [1] }), false);
  assert.strictEqual(room.input('a', { t: 40, k: new Array(13).fill(1) }), false);
  assert.strictEqual(room.input('a', null), false);
  assert.strictEqual(room.input('nobody', { t: 31, k: [1] }), false);
  room.input('a', { t: 31, k: [99999, S.packInput(1, 1)] });   // the bad code is skipped, the good one kept
  assert.strictEqual(p.codeTick[31 % 1024], 31);
  assert.strictEqual(p.codeTick[30 % 1024], -1);
});

test('200 m behind loses', () => {
  const { room } = racing();
  run(room, 3000, S.packInput(0, 1), S.packInput(0, -1));   // gas against brake
  assert.strictEqual(room.state, 'over');
  assert.strictEqual(room.winner, 'a');
  assert.strictEqual(room.overWhy, 'fell behind');
  const gapAt = room.bySide(0).zHist[room.endTick % 1024] - room.bySide(1).zHist[room.endTick % 1024];
  assert.ok(gapAt >= S.BEHIND_LOSE && gapAt < S.BEHIND_LOSE + 1);
});

test('both crashing on the same tick is a draw, and a paid draw settles once with no winner', () => {
  const { room } = racing({ worth: 1, wa: 'WA', wb: 'WB' });
  const settled = [];
  room.onSettled = (x) => settled.push(x);
  /* A car in each lane, placed so both cars (same speed, driving straight) first touch theirs on
     the same tick: Ann's in lane 1 at z 150, Bob's in lane 2 at the same distance from him then. */
  room.traffic.add([1, 1, 0, 150, 0, 0]);
  const meet = crashTickFor(0, [1, 1, 0, 150, 0, 0], S.NEUTRAL);
  const dz = S.zAt([1, 1, 0, 150, 0, 0], meet);
  room.traffic.add([2, 2, 0, dz - S.LANE_V[2] * meet * S.DT, 0, 0]);
  run(room, 2000, S.NEUTRAL, S.NEUTRAL);
  assert.strictEqual(room.state, 'over');
  assert.strictEqual(room.overWhy, 'both crashed');
  assert.strictEqual(room.winner, null);
  assert.strictEqual(settled.length, 1);
  assert.strictEqual(settled[0].winnerId, null);
  assert.strictEqual(settled[0].pot, 2);
  room.finish('a', 'again');
  assert.strictEqual(settled.length, 1, 'never twice');
  const over = room.io.sent.find(m => m.ev === 'sw:over');
  assert.ok(over.p.money && over.p.money.refunded, 'the card says refunded');
  assert.ok(!JSON.stringify(over.p).includes('WA'), 'no wallet on the wire');
});

test('a paid win pays the pot less the cut on the card, and walking out loses', () => {
  const { room } = racing({ worth: 0.5, wa: 'WA', wb: 'WB' });
  const settled = [];
  room.onSettled = (x) => settled.push(x);
  for (let t = 1; t <= 30; t++) room.tick(at(room, t));
  room.removePlayer('a');
  assert.strictEqual(room.state, 'over');
  assert.strictEqual(settled.length, 1);
  assert.strictEqual(settled[0].winnerId, 'b');
  assert.strictEqual(settled[0].pot, 1);
  const over = room.io.sent.find(m => m.ev === 'sw:over');
  assert.strictEqual(over.p.money.netMicro, 900000);
  assert.strictEqual(over.p.money.cutMicro, 100000);
  assert.strictEqual(over.p.winnerSide, 1);
});

test('watchers get seats, never socket ids', () => {
  const { room } = racing();
  room.watchers = 1;
  room.broadcast('sw:chat', { name: 'Ann', side: 0, text: 'hi' });
  const snap = room.watchSnapshot(Date.now());
  assert.ok(!JSON.stringify(snap).includes('"a"') && !JSON.stringify(snap).includes('"b"'));
  assert.ok(snap.players.every(p => !('id' in p)));
});

/* ── the lobby ─────────────────────────────────────────────────────────── */
function lobbyWith() {
  const io = fakeIo();
  const lobby = new SwimLobby(io);
  const refunds = [], settles = [];
  lobby.onRefund = (r) => refunds.push(r);
  lobby.onSettled = (r) => settles.push(r);
  return { lobby, io, refunds, settles };
}

test('a free seat races the bot after a minute; a paid seat never does and is refunded after the give-up', () => {
  const { lobby, refunds } = lobbyWith();
  const f = sock(), p = sock();
  const t0 = 1e6;
  lobby.enqueue(f, 'Free', null, 0, 0, t0);
  lobby.enqueue(p, 'Paid', 'WP', 1, 1, t0, 1);
  lobby.tick(t0 + FREE_WAIT_MS - 1);
  assert.strictEqual(lobby.rooms.size, 0);
  lobby.tick(t0 + FREE_WAIT_MS + 1);
  assert.strictEqual(lobby.rooms.size, 1);
  const room = [...lobby.rooms.values()][0];
  assert.ok(room.bot && room.stake === 0 && room.players.has(f.id));
  assert.ok(lobby.queue.some(e => e.socket.id === p.id), 'the paid seat is still waiting');
  lobby.tick(t0 + PAID_GIVE_UP_MS - 1);
  assert.strictEqual(refunds.length, 0);
  lobby.tick(t0 + PAID_GIVE_UP_MS + 1);
  assert.strictEqual(refunds.length, 1);
  assert.deepStrictEqual([refunds[0].wallet, refunds[0].amount], ['WP', 1]);
  lobby.leave(p.id);
  assert.strictEqual(refunds.length, 1, 'refunded once');
});

test('cancel refunds at once; different rungs and the same wallet never pair; two people pair', () => {
  const { lobby, refunds } = lobbyWith();
  const a = sock(), b = sock(), c = sock(), d = sock();
  lobby.enqueue(a, 'A', 'W1', 0.5, 0.5, 1, 0.5);
  lobby.enqueue(b, 'B', 'W2', 1, 1, 2, 1);
  lobby.enqueue(c, 'C', 'W1', 0.5, 0.5, 3, 0.5);     // same wallet as A
  assert.strictEqual(lobby.rooms.size, 0);
  lobby.leave(c.id);
  assert.strictEqual(refunds.length, 1);
  lobby.enqueue(d, 'D', 'W3', 0.5, 0.5, 4, 0.5);
  assert.strictEqual(lobby.rooms.size, 1);
  const room = [...lobby.rooms.values()][0];
  assert.strictEqual(room.stake, 0.5);
  assert.strictEqual(room.pot(), 1);
  assert.ok(!room.bot);
});

test('a restart owes every paid seat it holds, queued or racing, and nothing twice', () => {
  const { lobby, refunds, settles } = lobbyWith();
  const a = sock(), b = sock(), q = sock();
  lobby.enqueue(a, 'A', 'WA', 1, 1, 1, 1);
  lobby.enqueue(b, 'B', 'WB', 1, 1, 2, 1);
  lobby.enqueue(q, 'Q', 'WQ', 0.5, 0.5, 3, 0.5);
  const rows = lobby.shutdownSettle('shutdown');
  assert.strictEqual(rows.length, 3);
  assert.deepStrictEqual(rows.map(r => r.micro).sort(), [1000000, 1000000, 500000]);
  assert.ok(rows.every(r => /^refund swim /.test(r.reason) && r.key.startsWith('agowed:')));
  assert.strictEqual(lobby.enqueue(sock(), 'Late', 'WL', 1, 1, 4, 1), false, 'nothing new is held');
  const room = [...lobby.rooms.values()][0];
  room.finish('a', 'crashed');
  assert.strictEqual(settles.length, 0, 'a settled room pays nothing after the restart owes it');
  assert.strictEqual(refunds.length, 0);
});

test('leaving mid-race gives the race to the other seat', () => {
  const { lobby, settles } = lobbyWith();
  const a = sock(), b = sock();
  lobby.enqueue(a, 'A', 'WA', 1, 1, 1, 1);
  lobby.enqueue(b, 'B', 'WB', 1, 1, 2, 1);
  const room = [...lobby.rooms.values()][0];
  lobby.tick(room.goAt + 100);
  lobby.leave(a.id);
  assert.strictEqual(settles.length, 1);
  assert.strictEqual(settles[0].winnerId, b.id);
  assert.strictEqual(lobby.rooms.size, 0);
});

test('a person turning up early in a bot race takes the bot\'s place', () => {
  const { lobby } = lobbyWith();
  const a = sock(), b = sock();
  lobby.enqueue(a, 'A', null, 0, 0, 1);
  lobby.tick(1 + FREE_WAIT_MS + 1);
  const botRoom = [...lobby.rooms.values()][0];
  assert.ok(botRoom.bot);
  lobby.enqueue(b, 'B', null, 0, 0, 2 + FREE_WAIT_MS);
  const room = [...lobby.rooms.values()][0];
  assert.ok(!room.bot && room.players.has(a.id) && room.players.has(b.id));
  assert.strictEqual(lobby.rooms.size, 1);
});

test('the bot drives a whole race on the real lobby clock', () => {
  const { lobby } = lobbyWith();
  const a = sock();
  lobby.enqueue(a, 'A', null, 0, 0, 1);
  lobby.tick(1 + FREE_WAIT_MS + 1);
  const room = [...lobby.rooms.values()][0];
  // The person sends nothing: their car runs on its last (neutral) input and soon hits something.
  let t = room.goAt;
  for (let i = 0; i < 60 * 120 && lobby.rooms.size; i++) { t += S.TICK_MS; lobby.tick(t); }
  assert.strictEqual(lobby.rooms.size, 0, 'the race ended and was swept');
});
