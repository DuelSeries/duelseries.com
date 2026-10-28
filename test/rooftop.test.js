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
