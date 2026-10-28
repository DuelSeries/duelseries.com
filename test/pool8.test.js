'use strict';
/* 8 BALL POOL: the queue, the money, the rules and the table.

   The queue and the money are Knockout's code (Pool8Lobby extends
   KnockoutLobby, Pool8Room extends KnockoutRoom), so these hold the same rules
   through 8 Ball Pool's own classes, where a mistake in the subclass would show:
     · a paid table never seats a bot
     · a table settles exactly once, however it ended
     · walking out of a paid queue gives the stake back, once
     · walking out of a match forfeits it; walking out on the result does not
     · a restart owes every held paid seat a 100% 'agowed:' refund row
   then the rules, Miniclip 8 Ball Pool's (docs/pool8-reference.md): every foul
   gives the other player the cue ball in hand, the first legal pot after the
   break names the groups, the 8 wins only last, in the called pocket and
   without a foul, and three timed-out turns in a match lose; and the room: only
   the shooter shoots, junk is refused without throwing, a cue ball in hand goes
   only where it may, and two bots play a match to a result. */

const test = require('node:test');
const assert = require('node:assert');
const { Pool8Lobby } = require('../server/Pool8Lobby');
const { Pool8Room, P8R } = require('../server/Pool8Room');
const { PAID_GIVE_UP_MS, FREE_WAIT_MS } = require('../server/duelQueue');
const Sim = require('../shared/pool8Sim');
const Rules = require('../shared/pool8Rules');
const bot = require('../server/pool8Bot');
const { P8 } = Sim;

const io = { to: () => ({ emit: () => {}, volatile: { emit: () => {} } }) };
function sock(id) { const sent = []; return { id, sent, join() {}, leave() {}, emit(e, p) { sent.push({ e, p }); } }; }

function lobby() {
  const lob = new Pool8Lobby(io);
  const settled = [], refunds = [];
  lob.onSettled = (m) => settled.push(m);
  lob.onRefund = (m) => refunds.push(m);
  return { lob, settled, refunds };
}
function paidMatch(lob, stake) {
  const a = sock('A'), b = sock('B');
  lob.enqueue(a, 'Ann', 'WA', stake, stake, 0, stake);
  lob.enqueue(b, 'Bob', 'WB', stake, stake, 0, stake);
  const room = lob.roomOf('A');
  assert.ok(room && room === lob.roomOf('B'));
  return { room, a, b };
}
const idOf = (room, side) => room.socketOfSide(side);

/* ── the queue and the money ───────────────────────────────────────────── */

test('a paid table is never given a bot, however long it waits', () => {
  const { lob, refunds } = lobby();
  lob.enqueue(sock('A'), 'Ann', 'WA', 1, 1, 0, 1);
  lob.tick(FREE_WAIT_MS + 1000);
  assert.strictEqual(lob.roomOf('A'), null, 'still waiting, no bot');
  lob.tick(PAID_GIVE_UP_MS + 1000);
  assert.strictEqual(refunds.length, 1, 'given up on, refunded once');
  assert.strictEqual(refunds[0].amount, 1);
});

test('a free seat gets a labelled bot after its wait, and no money is on it', () => {
  const { lob, settled } = lobby();
  lob.enqueue(sock('A'), 'Ann', null, 0, 0, 0);
  lob.tick(FREE_WAIT_MS + 10);
  const room = lob.roomOf('A');
  assert.ok(room && room.bot, 'a bot sits down');
  assert.strictEqual(room.publicState(FREE_WAIT_MS + 10).vsBot, true, 'and the screen is told');
  assert.strictEqual(room.pot(), 0);
  room.finish('A', 'test');
  assert.strictEqual(settled.length, 0, 'a free table never settles money');
});

test('leaving a paid queue refunds the stake once; Cancel twice is still once', () => {
  const { lob, refunds } = lobby();
  const s = sock('A');
  lob.enqueue(s, 'Owen', 'W1', 1, 1, 0, 1);
  lob.leave('A');
  lob.leave('A');
  assert.strictEqual(refunds.length, 1);
  assert.strictEqual(refunds[0].amount, 1);
  assert.ok(s.sent.some(m => m.e === 'p8:unqueued' && m.p.refunded), 'the page is told on p8:unqueued');
});

test('walking out of a paid match forfeits it to the other seat, once', () => {
  const { lob, settled } = lobby();
  const { room } = paidMatch(lob, 1);
  room.tick(P8R.VS_MS + 10);
  lob.leave('A');
  lob.leave('A');
  assert.strictEqual(settled.length, 1);
  assert.strictEqual(settled[0].winnerId, 'B');
  assert.strictEqual(settled[0].why, 'opponent left');
  assert.strictEqual(settled[0].pot, 2);
});

test('a restart owes every held paid seat a full refund row, keyed agowed:, named pool8', () => {
  const { lob } = lobby();
  paidMatch(lob, 1);
  lob.enqueue(sock('C'), 'Cy', 'WC', 0.5, 0.5, 0, 0.5);
  const rows = lob.shutdownSettle('shutdown');
  assert.strictEqual(rows.length, 3);
  for (const r of rows) {
    assert.match(r.key, /^agowed:[0-9a-f-]{36}$/);
    assert.match(r.reason, /^refund pool8 shutdown /);
  }
  assert.deepStrictEqual(rows.map(r => r.micro).sort((x, y) => x - y), [500000, 1000000, 1000000]);
  assert.strictEqual(lob.shutdownSettle('shutdown').length, 0, 'and never twice');
});

/* A table set up by hand: the 8 and one ball of each group left, groups given, the shooter on `side`. */
function lateTable(room, side, opts) {
  const o = opts || {};
  room.balls = Sim.newRack().map(b => Object.assign(b, { on: false }));
  const put = (n, x, y) => Object.assign(room.balls[n], { on: true, x, y });
  put(0, 300, P8.W / 2);
  put(8, o.eightX || 600, P8.W / 2);
  if (!o.clearMine) put(side === 0 ? 1 : 9, 200, 60);
  put(side === 0 ? 9 : 1, 200, P8.W - 60);
  room.rules = Rules.newState(side);
  room.rules.broken = true;
  room.rules.inHand = null;
  room.rules.groups = side === 0 ? ['solids', 'stripes'] : ['stripes', 'solids'];
}
function aiming(room, t) { room.state = 'aiming'; room.phaseEndsAt = t + P8R.SHOT_MS; }

test('a win settles once, to the shooter who potted the 8 in the called pocket, after the last shot rolls out', () => {
  const { lob, settled } = lobby();
  const { room } = paidMatch(lob, 1);
  lateTable(room, 0, { clearMine: true, eightX: 900 });
  aiming(room, 1000);
  room.aimError = () => 0;            // an exact shot: the server's hair of aim error off for the proof
  // Straight down the long axis into the right-hand rail: the 8 heads for the middle of the foot cushion, so aim
  // it at the bottom right corner instead.
  const e = room.balls[8], pk = Sim.POCKETS[5];
  const dx = pk.x - e.x, dy = pk.y - e.y, d = Math.hypot(dx, dy);
  const gx = e.x - dx / d * 2 * P8.R, gy = e.y - dy / d * 2 * P8.R;
  const c = room.balls[0];
  const ok = room.shoot(idOf(room, 0), { a: Math.atan2(gy - c.y, gx - c.x), p: 0.75, call: 5 }, 1000);
  assert.ok(ok, 'the shot was taken');
  assert.strictEqual(room.state, 'settling', 'decided, held while it rolls out');
  assert.strictEqual(settled.length, 0, 'nothing paid before the hold');
  room.tick(1000 + 30000);
  assert.strictEqual(room.state, 'over');
  assert.strictEqual(settled.length, 1);
  assert.strictEqual(room.seats[0].id, settled[0].winnerId, 'the seat that potted it');
  room.finish('B', 'again');
  room.removePlayer('A');
  assert.strictEqual(settled.length, 1, 'never a second time');
});

test('the winner leaving during the result hold still wins: the verdict decides, not who stayed', () => {
  const { lob, settled } = lobby();
  const { room } = paidMatch(lob, 1);
  room.tick(P8R.VS_MS + 10);
  room.pending = { winner: 0, why: 'potted the 8' };
  room.state = 'settling';
  room.phaseEndsAt = Date.now() + 99999;
  const winner = room.seats[0].id;
  lob.leave(winner);
  assert.strictEqual(settled.length, 1);
  assert.strictEqual(settled[0].winnerId, winner);
  assert.strictEqual(settled[0].why, 'potted the 8');
});

/* ── the rules ─────────────────────────────────────────────────────────── */

const r0 = (o) => Object.assign({ potted: [], first: 1, railAfter: true, railBalls: 4, cuePotted: false }, o);
const st = (o) => Object.assign(Rules.newState(0), { broken: true, inHand: null }, o);
const full = () => Sim.newRack();

test('no ball hit is a foul: the other player gets the cue ball in hand anywhere', () => {
  const v = Rules.judge(st(), full(), r0({ first: null, railAfter: false }), null);
  assert.strictEqual(v.foul, 'nohit');
  assert.strictEqual(v.st.turn, 1);
  assert.strictEqual(v.st.inHand, 'table');
});

test('potting the cue ball is a foul even when a ball went down with it', () => {
  const v = Rules.judge(st(), full(), r0({ cuePotted: true, potted: [{ n: 3, p: 0, t: 1 }, { n: 0, p: 2, t: 2 }] }), null);
  assert.strictEqual(v.foul, 'scratch');
  assert.strictEqual(v.st.turn, 1);
  assert.strictEqual(v.st.inHand, 'table');
  assert.deepStrictEqual(v.st.groups, [null, null], 'and no group is given on a foul');
});

test('on an open table the 8 may not be hit first', () => {
  const v = Rules.judge(st(), full(), r0({ first: 8 }), null);
  assert.strictEqual(v.foul, 'wrongball');
  assert.strictEqual(v.st.turn, 1);
});

test('with groups set, hitting the other group first is a foul', () => {
  const v = Rules.judge(st({ groups: ['solids', 'stripes'] }), full(), r0({ first: 12 }), null);
  assert.strictEqual(v.foul, 'wrongball');
  assert.strictEqual(v.st.inHand, 'table');
});

test('no cushion after contact and nothing potted is a foul', () => {
  const v = Rules.judge(st(), full(), r0({ railAfter: false }), null);
  assert.strictEqual(v.foul, 'norail');
});

test('a legal shot that pots nothing passes the turn without ball in hand', () => {
  const v = Rules.judge(st(), full(), r0(), null);
  assert.strictEqual(v.foul, null);
  assert.strictEqual(v.st.turn, 1);
  assert.strictEqual(v.st.inHand, null);
});

test('the first legal pot after the break names the groups, and the shooter goes again', () => {
  const v = Rules.judge(st(), full(), r0({ first: 11, potted: [{ n: 11, p: 1, t: 5 }, { n: 2, p: 4, t: 9 }] }), null);
  assert.deepStrictEqual(v.st.groups, ['stripes', 'solids'], 'the first ball to drop names it');
  assert.strictEqual(v.keep, true);
  assert.strictEqual(v.st.turn, 0);
});

test('balls potted on the break give no group; the breaker goes again', () => {
  const s = Rules.newState(0);
  const v = Rules.judge(s, full(), r0({ potted: [{ n: 5, p: 0, t: 300 }] }), null);
  assert.deepStrictEqual(v.st.groups, [null, null]);
  assert.strictEqual(v.keep, true);
  assert.strictEqual(v.st.turn, 0);
  assert.strictEqual(v.st.broken, true);
});

test('the 8 potted on the break comes back to the foot spot and play goes on', () => {
  const v = Rules.judge(Rules.newState(1), full(), r0({ potted: [{ n: 8, p: 2, t: 400 }] }), null);
  assert.strictEqual(v.over, null);
  assert.strictEqual(v.respot8, true);
});

test('potting only an opponent ball passes the turn', () => {
  const v = Rules.judge(st({ groups: ['solids', 'stripes'] }), full(), r0({ first: 2, potted: [{ n: 10, p: 1, t: 5 }] }), null);
  assert.strictEqual(v.foul, null);
  assert.strictEqual(v.keep, false);
  assert.strictEqual(v.st.turn, 1);
});

function eightTable(side) {
  const balls = Sim.newRack().map(b => Object.assign(b, { on: false }));
  balls[0].on = true; balls[8].on = true; balls[side === 0 ? 9 : 1].on = true;
  return balls;
}
const eightState = (side) => st({ turn: side, groups: side === 0 ? ['solids', 'stripes'] : ['stripes', 'solids'] });

test('the 8 in the called pocket after clearing the group wins', () => {
  const v = Rules.judge(eightState(0), eightTable(0), r0({ first: 8, potted: [{ n: 8, p: 3, t: 5 }] }), 3);
  assert.deepStrictEqual(v.over, { winner: 0, why: 'potted the 8' });
});

test('the 8 in a pocket that was not called loses', () => {
  const v = Rules.judge(eightState(0), eightTable(0), r0({ first: 8, potted: [{ n: 8, p: 2, t: 5 }] }), 3);
  assert.strictEqual(v.over.winner, 1);
  assert.match(v.over.why, /wrong pocket/);
});

test('the 8 with the cue ball after it loses', () => {
  const v = Rules.judge(eightState(1), eightTable(1), r0({ first: 8, cuePotted: true, potted: [{ n: 8, p: 0, t: 5 }, { n: 0, p: 5, t: 9 }] }), 0);
  assert.strictEqual(v.over.winner, 0);
});

test('the 8 potted before the group is cleared loses', () => {
  const v = Rules.judge(st({ groups: ['solids', 'stripes'] }), full(), r0({ first: 3, potted: [{ n: 8, p: 2, t: 5 }] }), null);
  assert.strictEqual(v.over.winner, 1);
  assert.match(v.over.why, /too early/);
});

test('on the 8, hitting a group ball first is a foul', () => {
  const v = Rules.judge(eightState(0), eightTable(0), r0({ first: 9 }), 1);
  assert.strictEqual(v.foul, 'wrongball');
  assert.strictEqual(v.over, null);
});

test('running out of time is a foul with ball in hand, and the third in the match loses: shots between do not reset it', () => {
  let s = st();
  let v = Rules.timeout(s);
  assert.strictEqual(v.foul, 'time');
  assert.strictEqual(v.st.turn, 1);
  assert.strictEqual(v.st.inHand, 'table');
  s = Object.assign(v.st, { turn: 0 });
  v = Rules.timeout(s); s = Object.assign(v.st, { turn: 0 });
  // A tap between them (a foul of its own) does not wipe the count: two timeouts and a tap cannot stall a table.
  v = Rules.judge(s, full(), r0({ first: null, railAfter: false }), null);
  assert.strictEqual(v.st.timeouts[0], 2, 'still two');
  s = Object.assign(v.st, { turn: 0 });
  v = Rules.timeout(s);
  assert.strictEqual(v.over.winner, 1);
  assert.match(v.over.why, /3 times/);
});

test('a shot that arrives after the clock ran out is refused: the turn is timed out', () => {
  const room = freeRoom();
  const shooter = idOf(room, room.rules.turn);
  assert.strictEqual(room.shoot(shooter, { a: 0, p: 0.5 }, room.phaseEndsAt + 1), false);
  assert.strictEqual(room.state, 'aiming');
  room.tick(room.phaseEndsAt + 1);
  assert.strictEqual(room.rules.timeouts[1 - room.rules.turn], 1, 'counted as the timeout it was');
});

test('every shot leaves with a hair of the server\'s own aim error, never more than a fraction of a degree', () => {
  const room = freeRoom();
  const errs = [];
  for (let i = 0; i < 400; i++) errs.push(Math.abs(room.aimError(1)) * 180 / Math.PI);
  assert.ok(errs.some(e => e > 0.01), 'there is some');
  assert.ok(Math.max(...errs) < 0.8, 'and it stays tiny: ' + Math.max(...errs).toFixed(3));
});

test('a restart in the result hold pays the result: one owed row to the winner for the pot less the cut, none to the loser', () => {
  const { lob, settled } = lobby();
  const { room } = paidMatch(lob, 1);
  room.tick(P8R.VS_MS + 10);
  room.pending = { winner: 1, why: 'potted the 8' };
  room.state = 'settling';
  room.phaseEndsAt = Date.now() + 99999;
  const winnerWallet = room.players.get(room.socketOfSide(1)).wallet;
  const rows = lob.shutdownSettle('shutdown');
  assert.strictEqual(rows.length, 1, JSON.stringify(rows));
  assert.strictEqual(rows[0].wallet, winnerWallet);
  assert.strictEqual(rows[0].micro, 1800000);
  assert.match(rows[0].key, /^agowed:[0-9a-f-]{36}$/);
  assert.strictEqual(settled.length, 0, 'nothing paid twice: the owed row is the payment');
  assert.strictEqual(lob.shutdownSettle('shutdown').length, 0, 'and never twice');
});

/* ── the room ──────────────────────────────────────────────────────────── */

function freeRoom() {
  const room = new Pool8Room(io);
  room.addPlayer(sock('A'), 'Ann', null);
  room.addPlayer(sock('B'), 'Bob', null);
  room.start(0);
  room.tick(P8R.VS_MS + 1);
  return room;
}

test('only the shooter shoots, and junk is refused without throwing', () => {
  const room = freeRoom();
  const shooter = idOf(room, room.rules.turn), other = idOf(room, 1 - room.rules.turn);
  assert.strictEqual(room.shoot(other, { a: 0, p: 1 }), false, 'not your turn');
  const evil = { toString() { throw new Error('boom'); }, valueOf() { throw new Error('boom'); } };
  assert.strictEqual(room.shoot(shooter, { a: evil, p: evil }), false);
  assert.strictEqual(room.shoot(shooter, { a: 'NaN', p: 1 }), false);
  assert.strictEqual(room.shoot(shooter, { a: 1e9, p: 1 }), false);
  assert.strictEqual(room.shoot(shooter, null), false);
  assert.doesNotThrow(() => room.aim(shooter, { a: evil, p: evil, x: evil, y: evil }));
  assert.strictEqual(room.state, 'aiming', 'nothing was played');
});

test('the break: the cue ball may be put down only behind the baulk line, and power is clamped', () => {
  const room = freeRoom();
  const shooter = idOf(room, room.rules.turn);
  assert.strictEqual(room.rules.inHand, 'kitchen');
  room.shoot(shooter, { a: 0, p: 9, x: 700, y: 250 }, 5000);
  assert.ok(room.lastShot.cue.x <= P8.HEAD_X * P8.L, 'put back behind the line, not where it was asked');
  assert.strictEqual(room.lastShot.shot.p, 1, 'power never past full');
});

test('a cue ball in hand goes only to a free spot', () => {
  const room = freeRoom();
  const shooter = idOf(room, room.rules.turn);
  room.rules.broken = true; room.rules.inHand = 'table';
  const b = room.balls.find(x => x.n === 5);
  room.shoot(shooter, { a: 0, p: 0.2, x: b.x + 3, y: b.y }, 5000);
  const c = room.lastShot.cue;
  assert.ok(Math.hypot(c.x - b.x, c.y - b.y) >= 2 * P8.R - 1e-6, 'never on top of another ball');
});

test('a shot rolls out, then the next turn opens with a fresh clock; a turn left alone times out', () => {
  const room = freeRoom();
  const shooter = idOf(room, room.rules.turn);
  room.shoot(shooter, { a: 0, p: 1, x: 200, y: P8.W / 2 }, 5000);
  assert.strictEqual(room.state, 'rolling');
  const dur = room.lastShot.tape.dur;
  room.tick(5000 + dur + P8R.ROLL_PAD_MS + 1);
  assert.strictEqual(room.state, 'aiming');
  const turn = room.rules.turn;
  room.tick(5000 + dur + P8R.ROLL_PAD_MS + 1 + P8R.SHOT_MS + 1);
  assert.strictEqual(room.rules.turn, 1 - turn, 'the clock ran out: the other player');
  assert.strictEqual(room.rules.inHand, 'table', 'with the cue ball in hand');
});

test('the same shot on the same table always plays out the same', () => {
  const balls = Sim.newRack();
  const a = Sim.simulate(balls, { a: 0.01, p: 1, sx: 0.3, sy: -0.4 });
  const b = Sim.simulate(balls, { a: 0.01, p: 1, sx: 0.3, sy: -0.4 });
  assert.deepStrictEqual(a.balls, b.balls);
  assert.deepStrictEqual(a.tape.kf, b.tape.kf);
});

test('a hundred random shots: every ball ends on the cloth or in a pocket, never lost', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let balls = Sim.newRack();
  for (let i = 0; i < 100; i++) {
    if (!balls[0].on) Object.assign(balls[0], { on: true, x: 200, y: P8.W / 2 });
    if (balls.filter(b => b.on).length < 3) balls = Sim.newRack();
    const r = Sim.simulate(balls, { a: rnd() * 6.283, p: 0.2 + rnd() * 0.8, sx: rnd() * 2 - 1, sy: rnd() * 2 - 1 });
    assert.ok(r.tape.dur < P8.MAX_T * 1000, 'every shot comes to rest');
    for (const b of r.balls) {
      if (!b.on) continue;
      assert.ok(b.x >= -P8.R && b.x <= P8.L + P8.R && b.y >= -P8.R && b.y <= P8.W + P8.R, 'ball ' + b.n + ' on the table');
    }
    balls = r.balls;
  }
});

test('two bots play a whole match to a result', () => {
  const { lob, settled } = lobby();
  const room = new Pool8Room(io);
  room.addPlayer(sock('A'), 'Ann', null);
  room.addPlayer(sock('B'), 'Bob', null);
  room.onSettled = (m) => settled.push(m);
  let over = null;
  const bc = room.broadcast.bind(room);
  room.broadcast = (e, p) => { if (e === 'p8:over') over = p; return bc(e, p); };
  let t = 0;
  room.start(t);
  let shots = 0;
  while (room.state !== 'over' && shots < 300) {
    t += 200;
    room.tick(t);
    if (room.state === 'aiming') {
      const side = room.rules.turn;
      room.shoot(idOf(room, side), bot.decide(room, side), t);
      shots++;
    }
  }
  assert.ok(over, 'it finished after ' + shots + ' shots');
  assert.ok(over.winnerId, 'with a winner');
  assert.strictEqual(settled.length, 0, 'and a free table paid nothing');
  void lob;
});

test('watchers are told by seat: no socket id in what they get', () => {
  const room = freeRoom();
  room.watchers = 1;
  const out = room.watchSnapshot(Date.now());
  assert.ok(!JSON.stringify(out).includes('"A"') && !JSON.stringify(out).includes('"B"'));
  assert.strictEqual(room.forWatchers('p8:somethingnew', { a: 1 }), null, 'an event not on the list never reaches them');
  const o = room.forWatchers('p8:over', { winner: 'Ann', winnerId: 'A', why: 'potted the 8', stake: 0, pot: 0, money: { x: 1 } });
  assert.strictEqual(o.winnerSide, room.sideOf('A'));
  assert.strictEqual(o.money, undefined, 'never the money split');
  assert.strictEqual(o.winnerId, undefined);
});
