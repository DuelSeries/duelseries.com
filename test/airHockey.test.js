'use strict';
/* AIR HOCKEY: the queue, the money and the match.

   The queue and the money are Knockout's code (AirHockeyLobby extends
   KnockoutLobby, AirHockeyRoom extends KnockoutRoom), so these hold the same
   rules through Air Hockey's own classes, where a mistake in the subclass would
   show: a paid table never seats a bot; a table settles exactly once, however it
   ended; a draw refunds each seat its own stake; walking out forfeits; leaving on
   the result never hands the pot to the side that lost; a restart owes every
   held paid seat a refund row. Then the game itself (docs/airhockey-design.md):
   the table holds the puck, mallets stay on their own half at a hand's speed,
   the step is the same on the server and the page, first to seven wins, the
   clock and sudden death end a level match, the 7 second rule moves a held puck,
   pointer samples are applied on the step they are stamped with and junk never
   throws, and two bots finish a match. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { AirHockeyLobby } = require('../server/AirHockeyLobby');
const { AirHockeyRoom } = require('../server/AirHockeyRoom');
const { PAID_GIVE_UP_MS, FREE_WAIT_MS } = require('../server/duelQueue');
const Sim = require('../shared/ahSim');
const ahBot = require('../server/ahBot');
const { AH } = Sim;

const io = { to: () => ({ emit: () => {}, volatile: { emit: () => {} } }) };
function sock(id) { const sent = []; return { id, sent, join() {}, leave() {}, emit(e, p) { sent.push({ e, p }); } }; }

function lobby() {
  const lob = new AirHockeyLobby(io);
  const settled = [], refunds = [];
  lob.onSettled = (m) => settled.push(m);
  lob.onRefund = (m) => refunds.push(m);
  return { lob, settled, refunds };
}
function run(room, from, ms) {
  let t = from;
  for (const end = from + ms; t < end; t += 1000 / 60) room.tick(t);
  return t;
}
function paidMatch(lob, stake) {
  const a = sock('A'), b = sock('B');
  lob.enqueue(a, 'Ann', 'WA', stake, stake, 0, stake);
  lob.enqueue(b, 'Bob', 'WB', stake, stake, 0, stake);
  const room = lob.roomOf('A');
  assert.ok(room && room === lob.roomOf('B'));
  return { room, a, b };
}
const seatOf = (room, s) => [...room.players].find(([, p]) => p.side === s)[0];
// Puts the puck just short of a goal, heading in: side is the seat that scores (0 scores in the top goal).
function shoot(room, side) {
  const p = room.match.puck;
  p.live = true; p.x = AH.W / 2; p.y = side === 0 ? 40 : AH.H - 40; p.vx = 0; p.vy = side === 0 ? -1500 : 1500;
  // Mallets out of the way.
  room.inputs = [{ x: 60, y: AH.H - 60 }, { x: 540, y: 60 }];
  room.match.m[0].x = 60; room.match.m[0].y = AH.H - 60; room.match.m[1].x = 540; room.match.m[1].y = 60;
}

/* ── the queue and the money ─────────────────────────────────────────────── */

test('a paid table is never given a bot, however long it waits', () => {
  const { lob, refunds } = lobby();
  lob.enqueue(sock('A'), 'Owen', 'W1', 1, 1, 1e6, 1);
  lob.tick(1e6 + FREE_WAIT_MS + 1);
  assert.strictEqual(lob.rooms.size, 0);
  lob.tick(1e6 + PAID_GIVE_UP_MS + 1);
  assert.strictEqual(lob.queue.length, 0);
  assert.deepStrictEqual(refunds.map(r => [r.wallet, r.amount]), [['W1', 1]]);
  assert.strictEqual(lob.makeMatch([{ socket: sock('Z'), name: 'Z', wallet: 'WZ', stake: 1, worth: 1 }], true, 0).bot, undefined);
});

test('a free seat gets a labelled bot after its wait, and no money is on it', () => {
  const { lob, settled } = lobby();
  lob.enqueue(sock('A'), 'Ann', null, 0, 0, 0);
  lob.tick(FREE_WAIT_MS + 1);
  const room = lob.roomOf('A');
  assert.ok(room && room.bot, 'a bot match');
  assert.strictEqual(room.pot(), 0);
  assert.strictEqual(room.publicState(0).vsBot, true, 'the page is told it is a bot');
  room.finish(null, 'x');
  assert.strictEqual(settled.length, 0, 'a free table never settles money');
});

test('first to seven wins: settled once, to the winner, from the pot', () => {
  const { lob, settled } = lobby();
  const { room } = paidMatch(lob, 1);
  let t = run(room, 0, AH.COUNTDOWN_MS + 100);
  assert.strictEqual(room.state, 'playing');
  room.score = [AH.TO_WIN - 1, 3];
  shoot(room, 1);                    // seat 1 scores: 6-4, play on
  t = run(room, t, 300);
  assert.deepStrictEqual(room.score, [AH.TO_WIN - 1, 4]);
  assert.strictEqual(room.state, 'goal');
  t = run(room, t, AH.GOAL_PAUSE_MS + 50);
  assert.strictEqual(room.state, 'playing', 'served again');
  shoot(room, 0);
  t = run(room, t, 300);
  assert.strictEqual(room.state, 'settling', 'the seventh goal ends it at once');
  run(room, t, AirHockeyRoom.WIN_HOLD_MS + 100);
  assert.strictEqual(room.state, 'over');
  assert.strictEqual(settled.length, 1);
  assert.strictEqual(settled[0].winnerId, seatOf(room, 0));
  assert.strictEqual(settled[0].pot, 2);
  room.finish('B', 'again'); room.removePlayer('A');
  assert.strictEqual(settled.length, 1, 'never a second time');
});

test('after a goal the puck is served on the half of whoever conceded', () => {
  const { lob } = lobby();
  const { room } = paidMatch(lob, 0.5);
  let t = run(room, 0, AH.COUNTDOWN_MS + 100);
  shoot(room, 0);                    // seat 0 scores in the top goal: seat 1 conceded, seat 1 serves
  t = run(room, t, 200 + AH.GOAL_PAUSE_MS);
  assert.strictEqual(room.state, 'playing');
  assert.ok(room.match.puck.y < AH.H / 2 && room.match.puck.live, 'on seat 1 half, live');
  shoot(room, 1);
  run(room, t, 200 + AH.GOAL_PAUSE_MS);
  assert.ok(room.match.puck.y > AH.H / 2, 'then on seat 0 half');
});

test('at 0:00 the leader wins; level is sudden death, and the next goal wins it', () => {
  const { lob, settled } = lobby();
  const { room } = paidMatch(lob, 1);
  let t = run(room, 0, AH.COUNTDOWN_MS + 100);
  room.score = [2, 2];
  room.msLeft = 20;
  t = run(room, t, 200);
  assert.strictEqual(room.sudden, true);
  assert.strictEqual(room.state, 'playing');
  assert.strictEqual(settled.length, 0);
  shoot(room, 1);
  run(room, t, 300 + AirHockeyRoom.WIN_HOLD_MS);
  assert.strictEqual(settled.length, 1);
  assert.strictEqual(settled[0].winnerId, seatOf(room, 1));

  const two = lobby();
  const r2 = paidMatch(two.lob, 1).room;
  let t2 = run(r2, 0, AH.COUNTDOWN_MS + 100);
  r2.score = [3, 1]; r2.msLeft = 20;
  run(r2, t2, 300 + AirHockeyRoom.WIN_HOLD_MS);
  assert.strictEqual(two.settled.length, 1);
  assert.strictEqual(two.settled[0].winnerId, seatOf(r2, 0), 'the leader at 0:00');
});

test('sudden death that ends level is a draw: each seat refunded its own stake', () => {
  const { lob, settled } = lobby();
  const { room } = paidMatch(lob, 0.5);
  let t = run(room, 0, AH.COUNTDOWN_MS + 100);
  room.score = [1, 1]; room.msLeft = 0; room.sudden = true; room.suddenMs = AH.SUDDEN_MS - 30;
  room.match.puck.live = false;      // nobody scores in the last half second
  run(room, t, 200 + AirHockeyRoom.WIN_HOLD_MS);
  assert.strictEqual(settled.length, 1);
  assert.strictEqual(settled[0].winnerId, null);
  assert.deepStrictEqual(settled[0].seats.map(s => s.refund).sort(), [0.5, 0.5]);
});

test('walking out of a paid match forfeits it to the other seat, once', () => {
  const { lob, settled } = lobby();
  paidMatch(lob, 1);
  lob.tick(AH.COUNTDOWN_MS + 500);
  lob.leave('A'); lob.leave('A');
  assert.strictEqual(settled.length, 1);
  assert.strictEqual(settled[0].winnerId, 'B');
  assert.strictEqual(settled[0].why, 'opponent left');
});

test('the winner leaving during the hold after the winning goal still wins', () => {
  const { lob, settled } = lobby();
  const { room } = paidMatch(lob, 1);
  let t = run(room, 0, AH.COUNTDOWN_MS + 100);
  room.score = [AH.TO_WIN - 1, 0];
  shoot(room, 0);
  run(room, t, 300);
  assert.strictEqual(room.state, 'settling');
  const winner = seatOf(room, 0);
  lob.leave(winner);
  assert.strictEqual(settled.length, 1);
  assert.strictEqual(settled[0].winnerId, winner, 'the score decides, not who stayed');
});

test('a restart owes every held paid seat a full refund row, keyed agowed:, named airhockey', () => {
  const { lob } = lobby();
  paidMatch(lob, 1);
  lob.enqueue(sock('C'), 'Cy', 'WC', 0.5, 0.5, 0, 0.5);
  const rows = lob.shutdownSettle('shutdown');
  assert.strictEqual(rows.length, 3);
  for (const r of rows) { assert.match(r.key, /^agowed:[0-9a-f-]{36}$/); assert.match(r.reason, /^refund airhockey shutdown /); }
  assert.deepStrictEqual(rows.map(r => r.micro).sort((x, y) => x - y), [500000, 1000000, 1000000]);
  assert.strictEqual(lob.shutdownSettle('shutdown').length, 0);
});

/* ── the 7 second rule ────────────────────────────────────────────────────── */

test('a puck held on one half for 7 seconds is served to the other player', () => {
  const { lob } = lobby();
  const { room } = paidMatch(lob, 0.5);
  let t = run(room, 0, AH.COUNTDOWN_MS + 100);
  // Pinned still in seat 0's corner, out of every mallet's way.
  room.serveNow(0, 'test');
  const p = room.match.puck; p.x = 80; p.y = AH.H - 80; p.vx = 0; p.vy = 0;
  room.inputs = [{ x: 500, y: AH.H - 300 }, { x: 300, y: 100 }];
  t = run(room, t, AH.STALL_MS - 300);
  assert.ok(room.match.puck.y > AH.H / 2, 'still seat 0 puck just before 7 s');
  assert.ok(room.snapshot().sl, 'the warning ring is in the snapshot');
  run(room, t, 600);
  assert.ok(room.match.puck.y < AH.H / 2 && room.match.puck.x === AH.W / 2, 'served on seat 1 half');
});

/* ── input ────────────────────────────────────────────────────────────────── */

test('a pointer sample is applied on the step it is stamped with, early or late', () => {
  const room = new AirHockeyRoom(io);
  room.addPlayer(sock('A'), 'A', null); room.addPlayer(sock('B'), 'B', null);
  room.start(0);
  const k = room.match.tick;
  room.setInput('A', { t: k + 5, p: [100, 800] });
  for (let i = 0; i < 4; i++) room.stepOnce(0);
  assert.notDeepStrictEqual(room.inputs[0], { x: 100, y: 800 }, 'held until its step');
  room.stepOnce(0);
  assert.deepStrictEqual(room.inputs[0], { x: 100, y: 800 }, 'applied on it');
  room.setInput('A', { t: 2, p: [200, 700] });   // stale stamp: older than one already taken, ignored
  room.stepOnce(0);
  assert.deepStrictEqual(room.inputs[0], { x: 100, y: 800 });
  room.setInput('A', { t: k + 6, p: [300, 650] });   // late (that step has run): applied at once
  room.stepOnce(0);
  assert.deepStrictEqual(room.inputs[0], { x: 300, y: 650 });
});

test('a stamp far in the future cannot freeze a seat: later honest samples still move the mallet (Fable review)', () => {
  const room = new AirHockeyRoom(io);
  room.addPlayer(sock('A'), 'A', null); room.addPlayer(sock('B'), 'B', null);
  room.start(0);
  room.setInput('A', { t: 1e8 - 1, p: [100, 900] });
  for (let i = 0; i < 60; i++) room.stepOnce(0);
  room.setInput('A', { t: room.match.tick + 1, p: [500, 700] });
  for (let i = 0; i < 5; i++) room.stepOnce(0);
  assert.deepStrictEqual(room.inputs[0], { x: 500, y: 700 }, 'the honest sample after it is taken');
});

test('junk input never throws and never moves a mallet off its half or faster than a hand', () => {
  const room = new AirHockeyRoom(io);
  room.addPlayer(sock('A'), 'A', null); room.addPlayer(sock('B'), 'B', null);
  room.start(0);
  const evil = { toString() { throw new Error('boom'); }, valueOf() { throw new Error('boom'); } };
  for (const m of [null, 1, 'x', [], { t: evil, p: [1, 2] }, { t: 5, p: [evil, evil] }, { t: 5, p: new Array(40).fill(1) },
    { t: 5, p: [1] }, { t: -1, p: [1, 2] }, { t: 1e12, p: [1, 2] }, { t: '7', p: ['1e9', 'NaN'] }, { t: 9, p: [{}, []] }]) {
    assert.doesNotThrow(() => room.setInput('A', m));
  }
  assert.strictEqual(room.setInput('nobody', { t: 1, p: [1, 2] }), false);
  // Point seat 0 at the far end: it stops at the halfway line.
  room.setInput('A', { t: room.match.tick + 1, p: [300, -500] });
  const y0 = room.match.m[0].y;
  room.stepOnce(0);
  assert.ok(y0 - room.match.m[0].y <= AH.MALLET_MAX * AH.STEP + 1e-6, 'a hand\'s speed at most');
  for (let i = 0; i < 60; i++) room.stepOnce(0);
  assert.ok(room.match.m[0].y >= AH.H / 2 + AH.HALF_GAP - 1e-9, 'never over the halfway line');
});

test('index.js: the ah: input handler drops a flood and only reads a seated socket', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  const h = src.slice(src.indexOf("on('ah:in'"), src.indexOf("on('ah:leave'"));
  assert.match(h, /\+\+socket\._ahIn\.n > 40/);
  assert.match(h, /airHockeyLobby\.roomOf\(socket\.id\)/);
  assert.match(h, /try \{ if \(room\) room\.setInput/);
});

/* ── the physics ─────────────────────────────────────────────────────────── */

test('the table holds the puck: random play never loses it, never passes the speed cap', () => {
  const m = Sim.newMatch();
  Sim.serve(m, 0);
  let seed = 3;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  let goals = 0;
  for (let i = 0; i < 40000; i++) {
    if (i % 7 === 0) { m.m[0].tx = 0; }
    const inputs = [{ x: rnd() * 700 - 50, y: 400 + rnd() * 700 }, { x: rnd() * 700 - 50, y: rnd() * 600 - 50 }];
    const ev = Sim.step(m, inputs, true);
    const p = m.puck;
    if (ev.some(e => e.e === 'goal')) { goals++; Sim.serve(m, rnd() < 0.5 ? 0 : 1); continue; }
    const inSlot = p.y < 0 || p.y > AH.H;
    assert.ok(p.x >= AH.PUCK_R - 1e-6 && p.x <= AH.W - AH.PUCK_R + 1e-6, 'inside the side rails at step ' + i);
    if (inSlot) assert.ok(p.x > AH.GOAL_X0 && p.x < AH.GOAL_X1, 'only through the mouth');
    assert.ok(Math.hypot(p.vx, p.vy) <= AH.PUCK_MAX + 1e-6);
    for (let s = 0; s < 2; s++) {
      const q = m.m[s];
      assert.ok(s === 0 ? q.y >= AH.H / 2 + AH.HALF_GAP - 1e-9 : q.y <= AH.H / 2 - AH.HALF_GAP + 1e-9, 'own half');
    }
  }
  assert.ok(goals > 0, 'and goals happen');
});

test('the step is the same everywhere: the page replays exactly what the server ran', () => {
  const a = Sim.newMatch(), b = Sim.newMatch();
  Sim.serve(a, 1); Sim.serve(b, 1);
  for (let i = 0; i < 3000; i++) {
    const inp = [{ x: 300 + 250 * Math.sin(i / 17), y: 800 + 150 * Math.cos(i / 11) }, { x: 300 + 200 * Math.cos(i / 13), y: 200 + 120 * Math.sin(i / 7) }];
    Sim.step(a, inp, true); Sim.step(b, inp, false);
    if (!a.puck.live) { Sim.serve(a, 0); Sim.serve(b, 0); }
  }
  assert.deepStrictEqual(JSON.stringify(a.m), JSON.stringify(b.m));
  // Packed and unpacked (a snapshot), the state is good to a tenth of a unit.
  const q = Sim.unpackPuck(Sim.packPuck(a.puck));
  assert.ok(Math.abs(q.x - a.puck.x) <= 0.05 && Math.abs(q.vy - a.puck.vy) <= 0.05);
});

test('a swing puts the mallet\'s speed into the puck', () => {
  const m = Sim.newMatch();
  m.puck.live = true; m.puck.x = 300; m.puck.y = 700; m.puck.vx = 0; m.puck.vy = 0;
  m.m[0].x = m.m[0].tx = 300; m.m[0].y = m.m[0].ty = 820;
  let hit = null;
  for (let i = 0; i < 10 && !hit; i++) {
    const ev = Sim.step(m, [{ x: 300, y: 820 - 30 * (i + 1) }, null], true);   // 1800 units/s up the table
    hit = ev.find(e => e.e === 'hit');
  }
  assert.ok(hit && hit.s === 0, 'a hit, by seat 0');
  assert.ok(m.puck.vy < -2000, 'the puck leaves faster than the swing: ' + m.puck.vy);
});

/* ── the bot ─────────────────────────────────────────────────────────────── */

test('two bots play a whole match to a result, with hits and goals in it', () => {
  const room = new AirHockeyRoom(io);
  room.addPlayer(sock('bot_a'), 'A', null); room.addPlayer(sock('bot_b'), 'B', null);
  room.start(0);
  let t = 0;
  while (room.state !== 'over' && t < 400000) {
    t += 1000 / 60;
    ahBot.drive(room, t, { id: 'bot_a' }); ahBot.drive(room, t, { id: 'bot_b' });
    room.tick(t);
  }
  assert.strictEqual(room.state, 'over');
  assert.ok(room.score[0] + room.score[1] >= 3, 'goals: ' + room.score);
});

test('the lobby only swaps a bot match for a person while it is young and 0-0', () => {
  const { lob } = lobby();
  lob.enqueue(sock('A'), 'Ann', null, 0, 0, 0);
  lob.tick(FREE_WAIT_MS + 1);
  const room = lob.roomOf('A');
  assert.ok(lob.earlyEnough(room), 'in its countdown');
  run(room, FREE_WAIT_MS + 1, AH.COUNTDOWN_MS + 2000);
  assert.ok(lob.earlyEnough(room), 'two seconds in, 0-0');
  room.score = [1, 0];
  assert.ok(!lob.earlyEnough(room), 'not after a goal');
});

/* ── wiring ──────────────────────────────────────────────────────────────── */

test('index.js wires Air Hockey like Head Soccer: page, queue, door, settle, journal, shutdown, disconnect', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(src, /app\.get\('\/airhockey'/);
  assert.match(src, /case 'ah:paid:off':/);
  assert.match(src, /airHockeyLobby\.onSettled = /);
  assert.match(src, /airHockeyLobby\.journal = agJournal;/);
  assert.match(src, /headSoccerLobby, [^\]]*airHockeyLobby\];/);
  assert.match(src, /airHockeyLobby\.leave\(socket\.id\);\r?\n\s*knockoutLobby\.unwatch/);
  assert.match(src, /airHockeyLobby\.start\(\);/);
  assert.match(src, /consumePaidEntryAtStake\(entryToken, want, 'airhockey'\)/);
  assert.match(src, /if \(!AH_PAID_ON \|\| !ahPaidOpen\) \{ socket\.emit\('ah:refused'/);
});
