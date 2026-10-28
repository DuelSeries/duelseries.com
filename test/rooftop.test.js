'use strict';
/* ROOFTOP SNIPERS: the queue, the money and the match.

   The queue and the money are Knockout's code (RooftopLobby extends
   KnockoutLobby, RooftopRoom extends KnockoutRoom), so these hold the same rules
   through Rooftop's own classes, where a mistake in the subclass would show:
     · a paid table never seats a bot
     · two seats meet only at the same rung
     · a table settles exactly once, however it ended, to the side that reached five
     · walking out of a paid queue gives the stake back, once; walking out of a match forfeits it
     · the winner leaving during the winning fall's hold still wins
     · a free table never triggers a payout
     · a restart owes every held paid seat a 100% 'agowed:' refund row
   and then the game itself (the reference's rules and numbers, docs/rooftop-reference.md): the
   physics settles a player standing on the roof, a jump is the reference's, a shot pushes, a fall
   past the death line scores for the other side, inputs are clamped, and two bots finish a match. */

const test = require('node:test');
const assert = require('node:assert');
const { RooftopLobby } = require('../server/RooftopLobby');
const { RooftopRoom } = require('../server/RooftopRoom');
const { PAID_GIVE_UP_MS, FREE_WAIT_MS } = require('../server/duelQueue');
const Sim = require('../shared/rtSim');
const rtBot = require('../server/rtBot');
const { RT } = Sim;

const io = { to: () => ({ emit: () => {}, volatile: { emit: () => {} } }) };
function sock(id) { const sent = []; return { id, sent, join() {}, leave() {}, emit(e, p) { sent.push({ e, p }); } }; }
function lobby() {
  const lob = new RooftopLobby(io);
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
// Push a seat off the roof: carry its body past the death line on the next step.
function dropOff(room, side) {
  const b = room.match.p[side].body;
  b.x = (side === 0 ? -1 : 1) * 700; b.y = RT.DEATH_Y + 5; b.vy = 50;
}

test('a paid table is never given a bot, however long it waits', () => {
  const { lob, refunds } = lobby();
  const t0 = 1e6;
  lob.enqueue(sock('A'), 'Owen', 'W1', 1, 1, t0, 1);
  lob.tick(t0 + FREE_WAIT_MS + 1);
  assert.strictEqual(lob.rooms.size, 0, 'no bot match');
  lob.tick(t0 + PAID_GIVE_UP_MS + 1);
  assert.strictEqual(lob.queue.length, 0, 'given up after the quarter hour');
  assert.deepStrictEqual(refunds.map(r => [r.wallet, r.amount]), [['W1', 1]], 'and refunded in full, once');
});

test('even asked to, makeMatch seats no bot on a paid table', () => {
  const { lob } = lobby();
  const room = lob.makeMatch([{ socket: sock('A'), name: 'Owen', wallet: 'W1', stake: 0.5, worth: 0.5 }], true, 0);
  assert.ok(!room.bot);
  assert.ok(room instanceof RooftopRoom);
});

test('a free seat gets a labelled bot after its minute, and no money is on it', () => {
  const { lob, settled } = lobby();
  const t0 = 2e6;
  lob.enqueue(sock('A'), 'Owen', null, 0, 0, t0);
  lob.tick(t0 + FREE_WAIT_MS + 1);
  const room = lob.roomOf('A');
  assert.ok(room && room.bot, 'a bot match');
  assert.strictEqual(room.pot(), 0);
  assert.strictEqual(room.publicState(t0).vsBot, true, 'the screen is told it is a bot');
  assert.ok(!room.publicState(t0).players.some(p => String(p.id).startsWith('bot_')), 'no bot_ id on the wire');
  room.finish(room.players.keys().next().value, 'first to 5');
  assert.strictEqual(settled.length, 0, 'a free table never settles money');
});

test('two seats meet only at the same rung, and two tabs of one wallet never meet', () => {
  const { lob } = lobby();
  lob.enqueue(sock('A'), 'A', 'WA', 0.5, 0.5, 0, 0.5);
  lob.enqueue(sock('B'), 'B', 'WB', 1, 1, 0, 1);
  assert.strictEqual(lob.rooms.size, 0, 'different rungs wait apart');
  lob.enqueue(sock('A2'), 'A again', 'WA', 0.5, 0.5, 0, 0.5);
  assert.strictEqual(lob.rooms.size, 0, 'the same wallet twice is not a match');
  lob.enqueue(sock('C'), 'C', 'WC', 0.5, 0.5, 0, 0.5);
  assert.strictEqual(lob.rooms.size, 1);
  assert.strictEqual(lob.roomOf('C').pot(), 1);
});

test('leaving a paid queue refunds the stake once, and never more than landed', () => {
  const { lob, refunds } = lobby();
  const s = sock('A');
  lob.enqueue(s, 'Owen', 'W1', 1, 1, 0, 0.6);
  lob.leave('A');
  lob.leave('A');
  assert.strictEqual(refunds.length, 1);
  assert.strictEqual(refunds[0].amount, 0.6);
  assert.ok(s.sent.some(m => m.e === 'rt:unqueued' && m.p.refunded), 'the page is told on rt:unqueued');
});

test('the fifth fall settles once, to the side that reached five, after the hold', () => {
  const { lob, settled } = lobby();
  const { room } = paidMatch(lob, 1);
  let t = run(room, 0, RT.READY_MS + 200);
  assert.strictEqual(room.state, 'playing', 'the ready wait runs out on its own');
  room.match.score = [4, 3];
  dropOff(room, 1);                          // blue falls: red reaches five
  t = run(room, t, 100);
  assert.strictEqual(room.state, 'settling', 'decided at the fall');
  assert.deepStrictEqual(room.match.score, [5, 3]);
  assert.strictEqual(settled.length, 0, 'not paid until the hold is over');
  t = run(room, t, 30000);
  assert.strictEqual(room.state, 'over');
  assert.strictEqual(settled.length, 1);
  const redId = room.players.get('A').side === 0 ? 'A' : 'B';
  assert.strictEqual(settled[0].winnerId, redId);
  assert.strictEqual(settled[0].pot, 2);
  room.finish('B', 'again');
  room.removePlayer('A');
  assert.strictEqual(settled.length, 1, 'never a second time');
});

test('the winner leaving during the winning fall still wins: the score decides, not who stayed', () => {
  const { lob, settled } = lobby();
  const { room } = paidMatch(lob, 0.5);
  let t = run(room, 0, RT.READY_MS + 200);
  room.match.score = [2, 4];
  dropOff(room, 0);                          // red falls: blue reaches five
  t = run(room, t, 100);
  const blueId = room.players.get('A').side === 1 ? 'A' : 'B';
  lob.leave(blueId);
  assert.strictEqual(settled.length, 1);
  assert.strictEqual(settled[0].winnerId, blueId);
  void t;
});

test('a fall that does not reach five is a point and a new round, with no money moving', () => {
  const { lob, settled } = lobby();
  const { room } = paidMatch(lob, 1);
  let t = run(room, 0, RT.READY_MS + 200);
  dropOff(room, 0);
  t = run(room, t, 200);
  assert.deepStrictEqual(room.match.score, [0, 1]);
  assert.strictEqual(room.state, 'playing');
  assert.strictEqual(room.match.phase, 'down');
  t = run(room, t, 8000);                     // slow motion, the point, then the next round
  assert.strictEqual(room.match.round, 2);
  assert.strictEqual(room.match.phase, 'play');
  assert.strictEqual(settled.length, 0);
});

test('both off on the same step: the lower one loses, never a fixed seat', () => {
  const m = Sim.newMatch(5);
  Sim.begin(m);
  m.p[0].body.y = RT.DEATH_Y + 3; m.p[0].body.x = -700;
  m.p[1].body.y = RT.DEATH_Y + 9; m.p[1].body.x = 700;
  Sim.tick(m, [null, null]);
  assert.deepStrictEqual(m.score, [1, 0], 'blue was lower, so red scores');
});

test('walking out of a paid match forfeits it to the other seat, once', () => {
  const { lob, settled } = lobby();
  const { room } = paidMatch(lob, 1);
  run(room, 0, 500);
  lob.leave('A');
  lob.leave('A');
  assert.strictEqual(settled.length, 1);
  assert.strictEqual(settled[0].winnerId, 'B');
  assert.strictEqual(settled[0].why, 'opponent left');
});

test('a restart owes every held paid seat a full refund row, keyed agowed:, named rooftop', () => {
  const { lob } = lobby();
  paidMatch(lob, 1);
  lob.enqueue(sock('C'), 'Cy', 'WC', 0.5, 0.5, 0, 0.5);
  const rows = lob.shutdownSettle('shutdown');
  assert.strictEqual(rows.length, 3);
  for (const r of rows) {
    assert.match(r.key, /^agowed:[0-9a-f-]{36}$/);
    assert.match(r.reason, /^refund rooftop shutdown /);
  }
  assert.strictEqual(lob.shutdownSettle('shutdown').length, 0, 'and never twice');
});

test('inputs are clamped: counts only go up a few at a time, the hold is capped, junk cannot throw', () => {
  const room = new RooftopRoom(io);
  room.addPlayer(sock('A'), 'A', null);
  room.addPlayer(sock('B'), 'B', null);
  room.start(0);
  room.setInput('A', { s: 1, j: 100, d: 2, r: 1, n: 999 });
  const side = room.players.get('A').side;
  assert.deepStrictEqual(room.inputs[side], { j: 4, d: 2, r: 1, n: RT.MAX_HELD });
  room.setInput('A', { s: 2, j: 1, d: 0, r: 0, n: -5 });
  assert.deepStrictEqual(room.inputs[side], { j: 4, d: 2, r: 1, n: 0 }, 'counts never go down');
  const evil = { toString() { throw new Error('boom'); }, valueOf() { throw new Error('boom'); } };
  assert.doesNotThrow(() => room.setInput('A', { s: evil, j: evil, d: evil, r: evil, n: evil }));
  assert.strictEqual(room.setInput('nobody', { j: 1 }), false);
});

test('the aim is the hold the server saw: a hold the client claims is never believed', () => {
  const m = Sim.newMatch(9);
  Sim.begin(m);
  for (let i = 0; i < 90; i++) Sim.tick(m, null);
  Sim.tick(m, [{ d: 1 }, null]);                          // press: the arm starts at about -25
  const base = m.p[0].armBase;
  Sim.tick(m, [{ d: 1, r: 1, n: 38 }, null]);             // released one tick later, claiming 38 ticks
  assert.ok(Math.abs(m.p[0].arm - (base + 6)) < 1e-6, 'one tick of hold, whatever was claimed');
});

test('a backlog of jump presses is one jump: no stacked "super jump"', () => {
  const m = Sim.newMatch(4);
  for (let i = 0; i < 240; i++) Sim.tick(m, null);
  Sim.begin(m);
  for (let i = 0; i < 6; i++) Sim.tick(m, [{ j: 4 }, null]);
  assert.strictEqual(m.p[0].nj, 4);
  assert.ok(m.p[0].body.vy > -RT.JUMP - 1, 'one impulse only: ' + m.p[0].body.vy);
});

test('a new round never replays the presses of the last one', () => {
  const room = new RooftopRoom(io);
  room.addPlayer(sock('A'), 'A', null);
  room.addPlayer(sock('B'), 'B', null);
  let t = 0;
  room.start(t);
  t = run(room, t, RT.READY_MS + 200);
  const side = room.players.get('A').side;
  room.setInput('A', { s: 1, j: 2, d: 3, r: 3 });
  t = run(room, t, 300);
  dropOff(room, 1 - side);
  const shots = [];
  const orig = room.broadcast.bind(room);
  room.broadcast = (e, p) => { if (e === 'rt:ev') for (const x of p) if (x[0] === 'shot' || x[0] === 'jump') shots.push(x); return orig(e, p); };
  t = run(room, t, 9000);                                 // the fall, the slow motion, the next round
  assert.strictEqual(room.match.round, 2);
  assert.strictEqual(shots.filter(x => x[1] === side).length, 0, 'no phantom shot or jump in the new round');
  const p = room.match.p[side];
  assert.deepStrictEqual([p.nj, p.nd, p.nr], [2, 3, 3], 'the counts carried over');
});

test('time up is final: a fall during the hold changes nothing, and a level score refunds', () => {
  const { lob, settled } = lobby();
  const { room } = paidMatch(lob, 1);
  let t = run(room, 0, RT.READY_MS + 200);
  room.match.score = [3, 3];
  t = room.playSince + RooftopRoom.MATCH_MAX_MS + 50;
  room.lastStepAt = t - 20; room.tick(t);
  assert.strictEqual(room.state, 'settling');
  dropOff(room, 1);                                       // blue goes over the line in the hold
  t = run(room, t, 600);
  assert.deepStrictEqual(room.match.score, [3, 3], 'no point is scored in the hold');
  assert.strictEqual(room.setInput('A', { s: 9, j: 1 }), false, 'and no input is taken');
  t = run(room, t, RooftopRoom.TIMEUP_HOLD_MS);
  assert.strictEqual(settled.length, 1);
  assert.strictEqual(settled[0].winnerId, null, 'the announced draw stays a draw');
});

test('a player dropped on the roof comes to rest standing on it', () => {
  const m = Sim.newMatch(3);
  for (let i = 0; i < 240; i++) Sim.tick(m, null);
  for (const p of m.p) {
    assert.ok(Math.abs(p.body.y - (Sim.ROOF_TOP - 28)) < 1.5, 'its feet on the roof: ' + p.body.y);
    assert.ok(Math.abs(p.body.a) < 0.02, 'upright');
    assert.ok(p.grounded, 'its foot rays touch the roof');
  }
});

test('a jump is the reference one: 500 into the body and its arm (476 up), 161 high, 83 frames up, only near the ground', () => {
  const m = Sim.newMatch(4);
  for (let i = 0; i < 240; i++) Sim.tick(m, null);
  Sim.begin(m);
  const y0 = m.p[0].body.y;
  Sim.tick(m, [{ j: 1 }, null]);
  assert.ok(Math.abs(m.p[0].body.vy + RT.JUMP / (RT.MASS + RT.ARM_MASS)) < 1, 'the impulse is 500 up on 1.05');
  let top = y0;
  for (let i = 0; i < 15; i++) { Sim.tick(m, [{ j: 1 }, null]); top = Math.min(top, m.p[0].body.y); }
  for (let i = 0; i < 15; i++) { Sim.tick(m, [{ j: 2 }, null]); top = Math.min(top, m.p[0].body.y); }
  assert.strictEqual(m.p[0].nj, 2, 'the second press was taken');
  assert.ok(m.p[0].body.vy > -RT.JUMP + 100, 'but did nothing in the air');
  for (let i = 0; i < 60; i++) { Sim.tick(m, [{ j: 2 }, null]); top = Math.min(top, m.p[0].body.y); }
  assert.ok(Math.abs(y0 - top - 161) < 3, 'apex ' + (y0 - top) + ' (measured on the real build: 161)');
});

test('a level shot knocks the other player back', () => {
  const m = Sim.newMatch(6);
  for (let i = 0; i < 240; i++) Sim.tick(m, null);
  Sim.begin(m);
  const x0 = m.p[0].body.x;
  Sim.tick(m, [null, { d: 1 }]);
  for (let i = 0; i < 17; i++) Sim.tick(m, null);
  const ev = Sim.tick(m, [null, { d: 1, r: 1, n: 18 }]);
  const shot = ev.find(e => e.e === 'shot');
  assert.ok(shot && shot.hit === 1, 'blue hits red at about 83 degrees');
  for (let i = 0; i < 30; i++) Sim.tick(m, null);
  assert.ok(m.p[0].body.x < x0 - 60, 'red was pushed left: ' + (m.p[0].body.x - x0));
});

test('the first round is the plain roof; later rounds roll the reference modifiers and say so', () => {
  const m = Sim.newMatch(11);
  assert.deepStrictEqual(m.mods, [0, 0, 0, 0, 0]);
  assert.strictEqual(Sim.modLabel(m.mods), 'Normal');
  assert.strictEqual(Sim.modLabel([0, 1, 0, 1, 1]), 'Strong Snipers + Slippery + Athlete');
  const seen = new Set();
  for (let i = 0; i < 400; i++) seen.add(Sim.modLabel(Sim.rollMods(m)));
  assert.ok(seen.has('Normal') && seen.has('Athlete') && seen.has('Slippery') && seen.has('Strong Snipers'));
});

test('a snapshot round-trips: a client rebuilding from it steps exactly as the server does', () => {
  const a = Sim.newMatch(21);
  for (let i = 0; i < 200; i++) Sim.tick(a, null);
  Sim.begin(a);
  Sim.tick(a, [{ j: 1 }, { d: 1 }]);
  const b = Sim.newMatch(1);
  Sim.unpack(b, JSON.parse(JSON.stringify(Sim.pack(a))));
  b.pairs = JSON.parse(JSON.stringify(a.pairs));
  for (let i = 0; i < 40; i++) { Sim.tick(a, [{ j: 1 }, { d: 1, r: i > 20 ? 1 : 0, n: 20 }]); Sim.tick(b, [{ j: 1 }, { d: 1, r: i > 20 ? 1 : 0, n: 20 }]); }
  for (let s = 0; s < 2; s++) {
    assert.ok(Math.abs(a.p[s].body.x - b.p[s].body.x) < 0.05 && Math.abs(a.p[s].body.y - b.p[s].body.y) < 0.05, 'seat ' + s);
  }
});

test('two bots play a whole match to five, shooting and falling off', () => {
  const room = new RooftopRoom(io);
  const settled = [];
  room.onSettled = (x) => settled.push(x);
  room.addPlayer({ id: 'bot_a', join() {}, emit() {} }, 'A', null);
  room.addPlayer({ id: 'bot_b', join() {}, emit() {} }, 'B', null);
  const ba = { id: 'bot_a' }, bb = { id: 'bot_b' };
  let t = 1000, shots = 0;
  room.start(t);
  const orig = room.broadcast.bind(room);
  room.broadcast = (e, p) => { if (e === 'rt:ev') shots += p.filter(x => x[0] === 'shot').length; return orig(e, p); };
  for (let i = 0; i < 60 * 900 && room.state !== 'over'; i++) { t += 1000 / 60; rtBot.drive(room, t, ba); rtBot.drive(room, t, bb); room.tick(t); }
  assert.strictEqual(room.state, 'over');
  assert.ok(Math.max(...room.match.score) === RT.PLAY_TO, 'someone reached five: ' + room.match.score);
  assert.ok(shots > 10, 'they shot: ' + shots);
  assert.strictEqual(settled.length, 0, 'no money on a bot table');
});

test('ten minutes of play without a winner: the leader wins, level is a draw that refunds each seat its own stake', () => {
  for (const [score, want] of [[[3, 1], 'red'], [[2, 2], 'draw']]) {
    const { lob, settled } = lobby();
    const { room } = paidMatch(lob, 1);
    let t = run(room, 0, RT.READY_MS + 200);
    room.match.score = score.slice();
    // Hold both on the roof: the clock alone ends it.
    t = room.playSince + RooftopRoom.MATCH_MAX_MS + 50;
    room.lastStepAt = t - 20; room.tick(t);
    assert.strictEqual(room.state, 'settling');
    t = run(room, t, RooftopRoom.TIMEUP_HOLD_MS + 500);
    assert.strictEqual(room.state, 'over');
    assert.strictEqual(settled.length, 1);
    if (want === 'draw') {
      assert.strictEqual(settled[0].winnerId, null, 'nobody wins a level table');
      assert.deepStrictEqual(settled[0].seats.map(s => s.refund), [1, 1], 'each seat its own stake back');
    } else {
      assert.strictEqual(settled[0].winnerId, room.players.get('A').side === 0 ? 'A' : 'B');
    }
  }
});

test('Rocket Launchers: a rocket flies from the launcher, blasts the other player along its flight, and is gone', () => {
  const m = Sim.newMatch(8);
  for (let i = 0; i < 240; i++) Sim.tick(m, null);
  Sim.begin(m);
  m.mods[1] = 2;
  const x0 = m.p[0].body.x;
  Sim.tick(m, [null, { d: 1 }]);
  for (let i = 0; i < 17; i++) Sim.tick(m, null);
  const ev = Sim.tick(m, [null, { d: 1, r: 1, n: 18 }]);
  assert.ok(ev.some(e => e.e === 'rocket') && m.objs.length === 1, 'a rocket, no ray');
  assert.ok(Math.abs(Math.hypot(m.objs[0].body.vx, m.objs[0].body.vy) - RT.ROCKET_SPEED) < 1, 'at 750');
  let boom = null;
  for (let i = 0; i < 120 && !boom; i++) boom = Sim.tick(m, null).find(e => e.e === 'boom');
  assert.ok(boom && boom.hit === 1, 'it hit red');
  assert.strictEqual(m.objs.length, 0, 'and is gone');
  for (let i = 0; i < 30; i++) Sim.tick(m, null);
  assert.ok(m.p[0].body.x < x0 - 150, 'red was blown left: ' + (m.p[0].body.x - x0));
});

// ── the round modifiers: Tomahawks, Civilians, Beach Balls, the four maps (docs/rooftop-reference.md) ──
// A round with the given modifiers, through the same startRound the match uses (only the roll is skipped).
function roundWith(seed, mods) {
  const m = Sim.newMatch(seed);
  Sim.begin(m);
  Sim.startRound(m, false, mods);
  return m;
}

test('Tomahawks: thrown at 900 along the arm and spinning, a hit knocks the other player back; it lasts 15 s', () => {
  const m = roundWith(8, [0, 3, 0, 0, 0]);
  for (let i = 0; i < 120; i++) Sim.tick(m, null);
  const x0 = m.p[0].body.x;
  Sim.tick(m, [null, { d: 1 }]);
  for (let i = 0; i < 19; i++) Sim.tick(m, null);
  const ev = Sim.tick(m, [null, { d: 1, r: 1 }]);                      // released at about 95 degrees: level
  assert.ok(ev.some(e => e.e === 'toss') && m.objs.length === 1 && m.objs[0].k === 1, 'a tomahawk, no ray, no rocket');
  const t = m.objs[0].body;
  assert.ok(Math.abs(Math.hypot(t.vx, t.vy) - RT.TOM_SPEED) < 15, 'at 900 (one step of gravity on it): ' + Math.hypot(t.vx, t.vy));
  assert.strictEqual(t.w, -RT.TOM_SPIN, 'blue faces left, its arm is not mirrored: -16 rad/s');
  assert.strictEqual(t.sh.length, 2, 'two boxes, the handle and the head');
  assert.strictEqual(m.p[1].reloaded, false);
  for (let i = 0; i < 11; i++) Sim.tick(m, null);
  assert.strictEqual(m.p[1].reloaded, false, 'still reloading after 0.18 s (the tomahawk takes 0.2)');
  for (let i = 0; i < 39; i++) Sim.tick(m, null);
  assert.ok(m.p[0].body.x < x0 - 60, 'red was knocked left: ' + (m.p[0].body.x - x0));
  for (let i = 0; i < 60 * 15; i++) Sim.tick(m, null);
  assert.strictEqual(m.objs.filter(o => o.k === 1).length, 0, 'gone after 15 s');
});

test('Tomahawks never touch their thrower, and a mirrored arm throws it turned half round, spinning the other way', () => {
  const m = roundWith(8, [0, 3, 0, 0, 0]);
  for (let i = 0; i < 120; i++) Sim.tick(m, null);
  Sim.tick(m, [{ d: 1 }, null]);
  Sim.tick(m, [{ d: 1, r: 1 }, null]);                                  // red throws straight down at its own feet
  const o = m.objs[0];
  assert.strictEqual(o.fl, 1, 'red faces right: its arm is mirrored');
  assert.strictEqual(o.body.w, RT.TOM_SPIN);
  const armA = Sim.armAngle(m.p[0]);
  assert.ok(Math.abs(Math.cos(o.a0 - (armA + Math.PI))) > 0.9999, 'turned as the mirrored spot: the arm plus PI');
  for (let i = 0; i < 30; i++) Sim.tick(m, null);
  assert.ok(!Object.keys(m.pairs).some(k => k.startsWith('p0:r' + o.id)), 'no pair with its own thrower');
});

test('Civilians fall from 1000 above the camera, within 700 of it, and come to rest on the roof', () => {
  const m = roundWith(2, [0, 0, 1, 0, 0]);
  const ev = Sim.tick(m, null);                                         // the first one at once (wait_time starts at 0)
  assert.ok(ev.some(e => e.e === 'drop' && e.k === 2));
  const c = m.objs[0];
  assert.strictEqual(c.body.y, m.cam.y + RT.FALL_DY);
  assert.ok(Math.abs(c.body.x - m.cam.x) <= RT.FALL_DX);
  assert.ok(c.ch >= 0 && c.ch < RT.CHARS, 'a random look');
  assert.ok(m.fall.due >= 0 && m.fall.due < RT.FALL_WAIT, 'the next within 5 s');
  m.fall.k = 0;                                                         // just this one, so nothing lands on it
  for (let i = 0; i < 300; i++) Sim.tick(m, null);
  const b = c.body;
  assert.ok(Math.abs(b.vx) < 5 && Math.abs(b.vy) < 5, 'at rest');
  // lying on its side its 36 px wide box is under the origin: the origin 18 above the roof
  const bottom = Math.max(...[[-18, -100], [18, -100], [-18, 28], [18, 28]].map(([x, y]) => Sim.toWorld(b, x, y)[1]));
  assert.ok(Math.abs(bottom - Sim.ROOF_TOP) < 1, 'its lowest corner on the roof: ' + bottom);
  for (let i = 0; i < 60 * 8; i++) Sim.tick(m, null);
  assert.ok(!m.objs.includes(c), 'gone after 10 s');
});

test('Beach Balls fall at 200 px/s to start, bounce, and settle on the roof a radius above it', () => {
  const m = roundWith(12, [0, 0, 2, 0, 0]);
  Sim.tick(m, null);
  const ball = m.objs[0];
  assert.strictEqual(ball.k, 3);
  assert.strictEqual(ball.body.sh[0].r, RT.BALL_R);
  assert.ok(Math.abs(ball.body.vy - RT.BALL_VY) < 6, 'its scene starts it at 200 down: ' + ball.body.vy);
  m.fall.k = 0;
  let bounced = false, prev = 0;
  for (let i = 0; i < 700; i++) { Sim.tick(m, null); if (prev > 100 && ball.body.vy < 0) bounced = true; prev = ball.body.vy; }
  assert.ok(bounced, 'it bounced');
  if (Math.abs(ball.body.x) < 600) assert.ok(Math.abs(ball.body.y - (Sim.ROOF_TOP - RT.BALL_R)) < 1, 'resting on the roof: ' + ball.body.y);
});

test('the winning fall rains civilians from 2 s on (S: game_over calls create_falling(1))', () => {
  const m = roundWith(3, [0, 0, 0, 0, 0]);
  for (let i = 0; i < 60; i++) Sim.tick(m, null);
  m.score = [4, 0];
  m.p[1].body.x = 700; m.p[1].body.y = RT.DEATH_Y + 5;
  Sim.tick(m, null);
  assert.strictEqual(m.winner, 0);
  assert.strictEqual(m.fall.k, 0, 'nothing falls in a plain round');
  let civ = 0;
  for (let i = 0; i < 60 * 12 && !civ; i++) { civ = Sim.tick(m, null).filter(e => e.e === 'drop' && e.k === 2).length; if (civ) assert.ok(m.timer >= RT.POINT_AFTER); }
  assert.ok(m.pointShown && m.fall.k === 1 && civ > 0, 'civilians after the point');
});

test('each map: its spawn, a player resting on its roof, and its own death line', () => {
  // T: the roof each spawn drops onto: MainBuilding's top, the House's flat roof (-115 x 0.75 + 74.8837), the Blimp's
  // top (-396 + 374.567), the Cabin's eave slope between (233.293, -209.777) and (745.133, -171.5) x 0.75 + 74.8837
  const roof = [() => Sim.ROOF_TOP, () => Sim.ROOF_TOP, () => -115 * 0.75 + 74.8837, () => -396 + 374.567,
    (x) => { const ax = 233.293 * 0.75, ay = -209.777 * 0.75 + 74.8837, bx = 745.133 * 0.75, by = -171.5 * 0.75 + 74.8837;
      return ay + (by - ay) * (Math.abs(x) - ax) / (bx - ax); }];
  const want = [[250, -200, 75, 640], [250, -200, 75, 640], [246.965, -131.784, 83.0374, 555.464], [250, -144.136, 248.984, 613.4],
    [263.138, -175.084, 75, 557.925]];
  for (let map = 0; map < 5; map++) {
    const m = roundWith(4, [map, 0, 0, 0, 0]);
    const mp = Sim.mapOf(m);
    assert.deepStrictEqual([mp.spawn[0], mp.spawn[1], mp.death, mp.edge], want[map], 'map ' + map);
    assert.deepStrictEqual([m.p[0].body.x, m.p[1].body.x, m.p[0].body.y], [-want[map][0], want[map][0], want[map][1]], 'spawn ' + map);
    for (let i = 0; i < 300; i++) Sim.tick(m, null);
    for (const p of m.p) {
      const feet = Sim.toWorld(p.body, 0, 28);
      assert.ok(p.grounded, 'map ' + map + ': its foot rays touch');
      assert.ok(Math.abs(feet[1] - roof[map](feet[0])) < 1.5, 'map ' + map + ': standing on the roof: ' + feet[1] + ' vs ' + roof[map](feet[0]));
      assert.ok(Math.abs(p.body.a) < 0.1, 'map ' + map + ': upright');
    }
    assert.strictEqual(m.phase, 'play', 'nobody fell');
    m.p[0].body.x = -1200; m.p[0].body.y = want[map][2] - 2; m.p[0].body.vy = 0; Sim.tick(m, null);
    assert.strictEqual(m.phase, 'play', 'above the death line is still in');
    m.p[0].body.y = want[map][2] + 1; m.p[0].body.vy = 50; Sim.tick(m, null);
    assert.deepStrictEqual(m.score, [0, 1], 'map ' + map + ': below its death line red loses');
  }
});

test('the Elevator: its car rests level with the roof, then carries whoever stands on it down to a fall', () => {
  const m = roundWith(9, [1, 0, 0, 0, 0]);
  const lift = m.world.find(w => w.kin);
  assert.ok(lift && lift.sh.length === 2, 'a kinematic body of two boxes');
  assert.ok(Math.abs(lift.y + lift.sh[1].oy - lift.sh[1].hy - (-50.06)) < 0.01, 'its floor 1.1 px above the roof');
  assert.strictEqual(Sim.liftAt(6.5), 60);
  assert.strictEqual(Sim.liftAt(1), 0); assert.strictEqual(Sim.liftAt(11), 0);
  m.p[1].body.x = 0; m.p[1].body.y = -150;                              // blue drops into the shaft, onto the car
  let fellAt = -1;
  for (let i = 0; i < 400 && fellAt < 0; i++) { if (Sim.tick(m, null).some(e => e.e === 'fall' && e.s === 1)) fellAt = m.anim; if (i === 100) assert.ok(m.p[1].grounded, 'standing on the car'); }
  assert.ok(fellAt > 2 && fellAt < 3.5, 'down with it after 2 s: ' + fellAt);
  assert.ok(Math.abs(lift.y - (-180 + Sim.LIFT.S * Sim.liftAt(m.anim))) < 1e-9, 'the car follows its animation');
  assert.ok(lift.y > -170, 'on its way down: ' + lift.y);
});

test('the full roll: every map, weapon, falling object, weather and ability, at the reference odds', () => {
  assert.deepStrictEqual(Sim.MOD_BUILT.map(b => b.length), [5, 4, 3, 2, 2], 'every choice is built');
  const m = Sim.newMatch(31), seen = new Set(), plain = [0, 0, 0, 0, 0], N = 6000;
  for (let i = 0; i < N; i++) {
    const c = Sim.rollMods(m);
    for (let s = 0; s < 5; s++) { if (c[s]) seen.add(Sim.MOD_NAMES[s][c[s] - 1]); else plain[s]++; }
  }
  for (const names of Sim.MOD_NAMES) for (const n of names) assert.ok(seen.has(n), n);
  // S: plain with chance (2 / (n + 1) + 1) / 3
  [4, 3, 2, 1, 1].forEach((n, s) => assert.ok(Math.abs(plain[s] / N - (2 / (n + 1) + 1) / 3) < 0.03, 'slot ' + s));
});

test('a snapshot with a map, tomahawks, civilians and balls round-trips: the client steps as the server does', () => {
  for (const mods of [[1, 3, 1, 0, 0], [2, 3, 2, 1, 0], [4, 3, 1, 1, 1]]) {
    const a = roundWith(17, mods);
    const inp = (i) => [{ d: i > 20 ? 1 : 0, r: i > 40 ? 1 : 0 }, { d: i > 30 ? 1 : 0, r: i > 52 ? 1 : 0 }];
    for (let i = 0; i < 150; i++) Sim.tick(a, inp(i));
    const b = Sim.newMatch(1);
    Sim.unpack(b, JSON.parse(JSON.stringify(Sim.pack(a))));
    b.pairs = JSON.parse(JSON.stringify(a.pairs));
    assert.deepStrictEqual(b.mods, a.mods);
    assert.strictEqual(b.world.length, a.world.length, 'the same map');
    assert.deepStrictEqual(b.objs.map(o => o.k), a.objs.map(o => o.k));
    for (let i = 150; i < 170; i++) { Sim.tick(a, inp(i)); Sim.tick(b, inp(i)); }
    for (let s = 0; s < 2; s++) assert.ok(Math.hypot(a.p[s].body.x - b.p[s].body.x, a.p[s].body.y - b.p[s].body.y) < 0.05, mods + ' seat ' + s);
    a.objs.forEach((o, k) => assert.ok(Math.hypot(o.body.x - b.objs[k].body.x, o.body.y - b.objs[k].body.y) < 0.5, mods + ' object ' + k));
    assert.deepStrictEqual([b.cam.x, b.cam.y], [a.cam.x, a.cam.y]);
  }
});

test('a crowded Tomahawks round (60+ objects) goes out in about 2 KB and the client still steps as the server does', () => {
  // [0, 3, 1, 0, 0]: Tomahawks with civilians falling; [0, 2, 2, 1, 0]: Rocket Launchers, beach balls, Slippery
  for (const [mods, want] of [[[0, 3, 1, 0, 0], 60], [[0, 2, 2, 1, 0], 8]]) {
    const a = roundWith(17, mods);
    const inp = [{ d: 0, r: 0 }, { d: 0, r: 0 }];
    let rockets = 0;
    for (let i = 0; i < 3000 && (a.objs.length < want || (mods[1] === 2 && !rockets)); i++) {
      if (i % 15 === 0) { inp[0].d++; inp[1].d++; }                   // a throw every quarter second each (spamming)
      if (i % 15 === 2) { inp[0].r++; inp[1].r++; }
      for (const s of [0, 1]) {                                        // keep both on the roof so the round lasts
        const p = a.p[s].body;
        if (p.y > -60 || Math.abs(p.x) > 600) { p.x = s ? 300 : -300; p.y = -120; p.vx = p.vy = p.w = 0; p.a = 0; }
      }
      Sim.tick(a, inp);
      rockets = a.objs.filter(o => o.k === 0).length;
    }
    assert.ok(a.objs.length >= want, mods + ': ' + a.objs.length + ' objects');
    const snap = JSON.parse(JSON.stringify(Sim.pack(a)));
    assert.strictEqual(typeof snap.ob, 'string');
    if (want === 60) assert.ok(JSON.stringify(snap).length < 2300, 'the whole snapshot: ' + JSON.stringify(snap).length);
    const b = Sim.newMatch(1);
    Sim.unpack(b, snap);
    b.pairs = JSON.parse(JSON.stringify(a.pairs));
    const who = (m) => m.objs.map(o => [o.id, o.k, o.side, o.fl, o.ch]);
    assert.deepStrictEqual(who(b), who(a), mods + ': the same objects');
    a.objs.forEach((o, n) => {
      const q = b.objs[n], p = o.body, c = q.body;
      assert.ok(Math.abs(p.x - c.x) <= 0.005 && Math.abs(p.y - c.y) <= 0.005 && Math.abs(p.a - c.a) <= 5e-5, mods + ' place ' + n);
      assert.ok(Math.abs(p.vx - c.vx) <= 0.005 && Math.abs(p.vy - c.vy) <= 0.005 && Math.abs(p.w - c.w) <= 5e-5, mods + ' motion ' + n);
      assert.ok(Math.abs((o.t || 0) - q.t) <= RT.STEP / 20 && (o.k !== 1 || Math.abs(o.a0 - q.a0) <= 5e-5), mods + ' age ' + n);
      assert.ok(Math.abs(c.ii - p.ii) <= 1e-3 * p.ii && c.im === p.im && c.ly === p.ly && c.mk === p.mk && c.fr === p.fr, mods + ' body ' + n);
    });
    assert.strictEqual(Sim.pack(b).ob, snap.ob, 'what came back writes the same string');
    for (let i = 0; i < 12; i++) { Sim.tick(a, inp); Sim.tick(b, inp); }
    for (let s = 0; s < 2; s++) assert.ok(Math.hypot(a.p[s].body.x - b.p[s].body.x, a.p[s].body.y - b.p[s].body.y) < 0.05, mods + ' seat ' + s);
    const byId = new Map(b.objs.map(o => [o.id, o]));
    assert.ok(a.objs.length >= want - 4, 'still crowded');
    a.objs.forEach((o) => {
      const q = byId.get(o.id);
      assert.ok(q, mods + ' object ' + o.id + ' still there');
      assert.ok(Math.hypot(o.body.x - q.body.x, o.body.y - q.body.y) < 1, mods + ' object ' + o.id + ' within a pixel');
    });
  }
});
