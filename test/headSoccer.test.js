'use strict';
/* HEAD SOCCER: the queue, the money and the match.

   The queue and the money are Knockout's code (HeadSoccerLobby extends
   KnockoutLobby, HeadSoccerRoom extends KnockoutRoom), so these hold the same
   rules through Head Soccer's own classes, where a mistake in the subclass
   would show:
     · a paid table never seats a bot
     · two seats meet only at the same rung
     · a table settles exactly once, however it ended
     · a draw refunds each seat its own stake; a win pays from the pot
     · walking out of a paid queue gives the stake back, once
     · a free table never triggers a payout
     · a restart owes every held paid seat a 100% 'agowed:' refund row
   and then the game itself (Heads Arena Euro Soccer's rules and numbers,
   docs/head-soccer-reference.md): inputs are clamped, the clock ends a match,
   half time breaks it, a goal counts, the kick is the reference's, and two bots
   finish a match with goals in it. */

const test = require('node:test');
const assert = require('node:assert');
const { HeadSoccerLobby } = require('../server/HeadSoccerLobby');
const { HeadSoccerRoom } = require('../server/HeadSoccerRoom');
const { PAID_GIVE_UP_MS, FREE_WAIT_MS } = require('../server/duelQueue');
const Sim = require('../shared/hsSim');
const hsBot = require('../server/hsBot');
const { HS } = Sim;

const io = { to: () => ({ emit: () => {}, volatile: { emit: () => {} } }) };
function sock(id) { const sent = []; return { id, sent, join() {}, leave() {}, emit(e, p) { sent.push({ e, p }); } }; }

function lobby() {
  const lob = new HeadSoccerLobby(io);
  const settled = [], refunds = [];
  lob.onSettled = (m) => settled.push(m);
  lob.onRefund = (m) => refunds.push(m);
  return { lob, settled, refunds };
}

// Runs a room's clock forward in 60 Hz ticks.
function run(room, from, ms) {
  let t = from;
  for (const end = from + ms; t < end; t += 1000 / 60) room.tick(t);
  return t;
}

test('a paid table is never given a bot, however long it waits', () => {
  const { lob, refunds } = lobby();
  const t0 = 1e6;
  lob.enqueue(sock('A'), 'Owen', 'W1', 1, 1, t0, 1);
  lob.tick(t0 + FREE_WAIT_MS + 1);
  assert.strictEqual(lob.rooms.size, 0, 'no bot match');
  assert.strictEqual(lob.queue.length, 1, 'still waiting for a person');
  lob.tick(t0 + PAID_GIVE_UP_MS + 1);
  assert.strictEqual(lob.queue.length, 0, 'given up after the quarter hour');
  assert.deepStrictEqual(refunds.map(r => [r.wallet, r.amount]), [['W1', 1]], 'and refunded in full, once');
});

test('even asked to, makeMatch seats no bot on a paid table', () => {
  const { lob } = lobby();
  const room = lob.makeMatch([{ socket: sock('A'), name: 'Owen', wallet: 'W1', stake: 0.5, worth: 0.5 }], true, 0);
  assert.ok(!room.bot);
  assert.ok(room instanceof HeadSoccerRoom);
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
  room.finish(room.players.keys().next().value, 'full time');
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
  const room = lob.roomOf('C');
  assert.strictEqual(room.stake, 0.5);
  assert.strictEqual(room.pot(), 1);
});

test('leaving a paid queue refunds the stake once; Cancel twice is still once', () => {
  const { lob, refunds } = lobby();
  const s = sock('A');
  lob.enqueue(s, 'Owen', 'W1', 1, 1, 0, 1);
  lob.leave('A');
  lob.leave('A');
  assert.strictEqual(refunds.length, 1);
  assert.strictEqual(refunds[0].amount, 1);
  assert.ok(s.sent.some(m => m.e === 'hs:unqueued' && m.p.refunded), 'the page is told on hs:unqueued');
});

test('a refund never exceeds what landed on-chain', () => {
  const { lob, refunds } = lobby();
  lob.enqueue(sock('A'), 'Owen', 'W1', 1, 1, 0, 0.6);
  lob.leave('A');
  assert.strictEqual(refunds[0].amount, 0.6);
});

function paidMatch(lob, stake) {
  const a = sock('A'), b = sock('B');
  lob.enqueue(a, 'Ann', 'WA', stake, stake, 0, stake);
  lob.enqueue(b, 'Bob', 'WB', stake, stake, 0, stake);
  const room = lob.roomOf('A');
  assert.ok(room && room === lob.roomOf('B'));
  return { room, a, b };
}

test('a win settles once, to the winner, from the pot', () => {
  const { lob, settled } = lobby();
  const { room } = paidMatch(lob, 1);
  let t = run(room, 0, HS.COUNTDOWN_MS + 100);
  room.match.score = [2, 1];
  room.match.msLeft = 10;
  t = run(room, t, 200 + HeadSoccerRoom.WIN_HOLD_MS);
  assert.strictEqual(room.state, 'over');
  assert.strictEqual(settled.length, 1);
  const sideA = room.players.get('A').side;
  const winnerId = sideA === 0 ? 'A' : 'B';
  assert.strictEqual(settled[0].winnerId, winnerId);
  assert.strictEqual(settled[0].pot, 2);
  room.finish('A', 'again');
  room.removePlayer('A');
  assert.strictEqual(settled.length, 1, 'never a second time');
});

test('level at full time is sudden death: nothing settles, and the next goal wins it', () => {
  const { lob, settled } = lobby();
  const { room } = paidMatch(lob, 0.5);
  let t = run(room, 0, HS.COUNTDOWN_MS + 100);
  room.match.score = [1, 1];
  room.match.msLeft = 10;
  t = run(room, t, 200);
  assert.strictEqual(room.state, 'golden', 'the golden-goal call');
  t = run(room, t, HS.GOLDEN_FLASH_MS + HS.COUNTDOWN_MS + 200);
  assert.strictEqual(settled.length, 0, 'no result at 90:00 while level');
  assert.strictEqual(room.state, 'playing');
  // A goal for the right-hand seat (into the left goal).
  const b = room.match.ball;
  b.x = -HS.GOAL_LINE_X - 30; b.y = HS.SHELF_Y - HS.BALL_R - 5; b.vx = -40; b.vy = 0;
  run(room, t, 200 + HeadSoccerRoom.WIN_HOLD_MS);
  assert.strictEqual(settled.length, 1);
  const right = [...room.players].find(([, p]) => p.side === 1)[0];
  assert.strictEqual(settled[0].winnerId, right);
});

test('sudden death that never ends is stopped as a draw: each seat refunded its own stake', () => {
  const { lob, settled } = lobby();
  const { room } = paidMatch(lob, 0.5);
  let t = run(room, 0, HS.COUNTDOWN_MS + 100);
  room.match.score = [2, 2];
  room.match.msLeft = 0;
  room.match.goldenMs = HS.GOLDEN_MAX_MS;
  run(room, t, 200 + HeadSoccerRoom.WIN_HOLD_MS);
  assert.strictEqual(settled.length, 1);
  assert.strictEqual(settled[0].winnerId, null);
  assert.deepStrictEqual(settled[0].seats.map(s => s.refund).sort(), [0.5, 0.5]);
});

test('walking out of a paid match forfeits it to the other seat, once', () => {
  const { lob, settled } = lobby();
  const { room } = paidMatch(lob, 1);
  run(room, 0, HS.COUNTDOWN_MS + 500);
  lob.leave('A');
  lob.leave('A');
  assert.strictEqual(settled.length, 1);
  assert.strictEqual(settled[0].winnerId, 'B');
  assert.strictEqual(settled[0].why, 'opponent left');
});

test('a restart owes every held paid seat a full refund row, keyed agowed:, named headsoccer', () => {
  const { lob } = lobby();
  paidMatch(lob, 1);
  lob.enqueue(sock('C'), 'Cy', 'WC', 0.5, 0.5, 0, 0.5);
  const rows = lob.shutdownSettle('shutdown');
  assert.strictEqual(rows.length, 3);
  for (const r of rows) {
    assert.match(r.key, /^agowed:[0-9a-f-]{36}$/);
    assert.match(r.reason, /^refund headsoccer shutdown /);
  }
  assert.deepStrictEqual(rows.map(r => r.micro).sort((x, y) => x - y), [500000, 1000000, 1000000]);
  assert.strictEqual(lob.shutdownSettle('shutdown').length, 0, 'and never twice');
  assert.strictEqual(lob.enqueue(sock('D'), 'D', 'WD', 1, 1, 0, 1), false, 'a stopping lobby seats nobody');
});

test('inputs are clamped: counts only go up, a few at a time; junk is ignored', () => {
  const room = new HeadSoccerRoom(io);
  room.addPlayer(sock('A'), 'A', null);
  room.addPlayer(sock('B'), 'B', null);
  room.setInput('A', { h: 0xffff, j: 1e12, k: 3, p: -5, s: 7 });
  const side = room.players.get('A').side;
  const inp = room.inputs[side];
  assert.strictEqual(inp.held, 3, 'only the two arrow bits');
  assert.strictEqual(inp.jumps, 0, 'an absurd count is refused');
  assert.strictEqual(inp.kicks, 3);
  assert.strictEqual(inp.powers, 0);
  room.setInput('A', { k: 100 });
  assert.strictEqual(inp.kicks, 7, 'at most four presses a message');
  assert.strictEqual(room.setInput('nobody', { h: 1 }), false, 'a socket with no seat moves nothing');
  assert.strictEqual(room.setInput('A', 'junk'), false);
});

test('the ball past the mouth under the bar is a goal for the other side', () => {
  const m = Sim.newMatch();
  m.ball.x = -HS.GOAL_LINE_X - 2; m.ball.y = HS.SHELF_Y - HS.BALL_R - 5; m.ball.vx = -50; m.ball.vy = 0;
  const ev = Sim.step(m, null, HS.STEP, true);
  assert.ok(ev.some(e => e.e === 'goal' && e.s === 1));
  assert.deepStrictEqual(m.score, [0, 1]);
});

test('two bots play a whole match to a result, with goals and kicks in it', () => {
  // The reference's CPU against itself can stall 0-0 into golden goal, so up to three matches for one with goals.
  let goals = 0, kicks = 0, ended = 0;
  for (let g = 0; g < 3 && goals === 0; g++) {
    const room = new HeadSoccerRoom(io);
    room.addPlayer({ id: 'bot_a', join() {}, emit() {} }, 'A', null);
    room.addPlayer({ id: 'bot_b', join() {}, emit() {} }, 'B', null);
    const ba = { id: 'bot_a' }, bb = { id: 'bot_b' };
    room.sendEvents = (ev) => { for (const e of ev) if (e.e === 'kick') kicks++; };
    let t = 0;
    room.start(t);
    while (room.state !== 'over' && t < 400000) { t += 1000 / 60; hsBot.drive(room, t, ba); hsBot.drive(room, t, bb); room.tick(t); }
    if (room.state === 'over') ended++;
    goals += room.match.score[0] + room.match.score[1];
  }
  assert.ok(ended > 0, 'a match ended');
  assert.ok(goals > 0, 'somebody scored');
  assert.ok(kicks > 0, 'and the bots kick');
});

test('half time: the step past 45:00 stops play for 3 s, then both go back to their spots and count down', () => {
  const room = new HeadSoccerRoom(io);
  room.addPlayer(sock('A'), 'A', null);
  room.addPlayer(sock('B'), 'B', null);
  let t = 0;
  room.start(t);
  t = run(room, t, HS.COUNTDOWN_MS + 100);
  assert.strictEqual(room.state, 'playing');
  room.match.msLeft = HS.HALF_MS + 5;
  room.match.p[0].x = 300;
  t = run(room, t, 100);
  assert.strictEqual(room.state, 'half');
  assert.strictEqual(Sim.clockDigits(room.match.msLeft).slice(0, 2), '45');
  t = run(room, t, HS.HALF_PAUSE_MS + 50);
  assert.strictEqual(room.state, 'kickoff');
  assert.ok(Math.abs(room.match.p[0].x + HS.START_X) < 1, 'back on the spot');
  const frozen = room.match.msLeft;
  for (let i = 0; i < 400 && room.state !== 'playing'; i++) { t += 1000 / 60; room.tick(t); }
  assert.strictEqual(room.state, 'playing');
  assert.ok(Math.abs(room.match.msLeft - frozen) < 40, 'the clock did not run through the break');
});

test('the clock shows 90 game minutes over the 60 s, and the kick is the reference one', () => {
  assert.strictEqual(Sim.clockDigits(HS.MATCH_MS), '0000');
  assert.strictEqual(Sim.clockDigits(HS.MATCH_MS - 1000), '0130');
  assert.strictEqual(Sim.clockDigits(0), '9000');
  // Measured in the reference: a grounded player facing right, ball 150 ahead and 50 up -> (437, -2007).
  const p = Sim.newPlayer(0); p.ground = true; p.left = false;
  const aim = Sim.kickAim(p, { x: p.x + 150, y: p.y - 50 });
  const v = Sim.kickVelocity(p, aim[0], aim[1]);
  assert.ok(Math.abs(v[0] - 437) < 3 && Math.abs(v[1] + 2007) < 3, JSON.stringify(v));
  assert.strictEqual(Sim.kickVelocity(p, p.x + 300, p.y), null, 'out of reach');
});

test('a client-built object in hs:in cannot throw (Number() on {toString} would)', () => {
  const room = new HeadSoccerRoom(io);
  room.addPlayer(sock('A'), 'A', null);
  room.addPlayer(sock('B'), 'B', null);
  const evil = { toString: 1, valueOf: 1 };
  assert.doesNotThrow(() => room.setInput('A', { h: evil, j: evil, k: evil, p: evil, s: evil }));
  assert.doesNotThrow(() => room.setInput('A', { h: [1], j: '9'.repeat(40), k: null, p: undefined, s: Symbol.iterator }));
  const inp = room.inputs[room.players.get('A').side];
  assert.deepStrictEqual([inp.held, inp.jumps, inp.kicks, inp.powers], [0, 0, 0, 0]);
});

test('the winner leaving during the full-time hold still wins: the score decides, not who stayed', () => {
  const { lob, settled } = lobby();
  const { room } = paidMatch(lob, 1);
  let t = run(room, 0, HS.COUNTDOWN_MS + 100);
  const sideA = room.players.get('A').side;
  room.match.score = sideA === 0 ? [2, 1] : [1, 2];   // A is ahead
  room.match.msLeft = 10;
  t = run(room, t, 300);
  assert.strictEqual(room.state, 'settling');
  lob.leave('A');
  assert.strictEqual(settled.length, 1);
  assert.strictEqual(settled[0].winnerId, 'A', 'the side that won is paid');
  assert.strictEqual(settled[0].why, 'full time');
});

test('an equaliser in the very step the clock reaches 0:00 goes to sudden death, not a draw', () => {
  const { lob, settled } = lobby();
  const { room } = paidMatch(lob, 1);
  let t = run(room, 0, HS.COUNTDOWN_MS + 100);
  room.match.score = [1, 0];
  room.match.msLeft = HS.STEP * 1000 * 0.5;          // this step takes it to 0:00
  const b = room.match.ball;                          // and this step's ball crosses into the left goal: 1-1
  b.x = -HS.GOAL_LINE_X + 0.5; b.y = HS.SHELF_Y - HS.BALL_R; b.vx = -60; b.vy = 0;
  room.stepOnce(t);
  assert.deepStrictEqual(room.match.score, [1, 1]);
  assert.strictEqual(room.state, 'goal', 'a goal pause, then play on');
  t = run(room, t, HS.GOAL_PAUSE_MS + HS.GOLDEN_FLASH_MS + HS.COUNTDOWN_MS + 500);
  assert.strictEqual(settled.length, 0, 'no draw was settled');
  assert.strictEqual(room.state, 'playing', 'sudden death');
});

test('a ball resting on the crossbar does not ring the post every step', () => {
  const m = Sim.newMatch();
  m.p[0].x = 0; m.p[1].x = 400;
  m.ball.x = -HS.BAR_X; m.ball.y = HS.BAR_Y - HS.BAR_H / 2 - HS.BALL_R - 4; m.ball.vx = 0; m.ball.vy = 0;
  let posts = 0;
  for (let i = 0; i < 120; i++) for (const e of Sim.step(m, null, HS.STEP, false)) if (e.e === 'post') posts++;
  assert.ok(posts <= 1, 'posts: ' + posts);
});

test('a winning goal on the buzzer whistles at once: the scorer leaving in the break still wins', () => {
  const { lob, settled } = lobby();
  const { room } = paidMatch(lob, 1);
  let t = run(room, 0, HS.COUNTDOWN_MS + 100);
  room.match.score = [0, 0];
  room.match.msLeft = HS.STEP * 1000 * 0.5;          // this step takes it to 0:00
  const b = room.match.ball;                          // and this step's ball crosses into the left goal: 0-1
  b.x = -HS.GOAL_LINE_X + 0.5; b.y = HS.SHELF_Y - HS.BALL_R; b.vx = -60; b.vy = 0;
  room.stepOnce(t);
  assert.deepStrictEqual(room.match.score, [0, 1]);
  assert.strictEqual(room.state, 'settling', 'decided: straight to the whistle');
  const scorer = [...room.players].find(([, p]) => p.side === 1)[0];
  lob.leave(scorer);
  assert.strictEqual(settled.length, 1);
  assert.strictEqual(settled[0].winnerId, scorer, 'paid to the side that scored, not the one who stayed');
});

test('a goal in the step that crosses half time still gets the half-time break', () => {
  const { lob } = lobby();
  const { room } = paidMatch(lob, 1);
  let t = run(room, 0, HS.COUNTDOWN_MS + 100);
  room.match.msLeft = HS.HALF_MS + HS.STEP * 1000 * 0.5;
  const b = room.match.ball;
  b.x = -HS.GOAL_LINE_X + 0.5; b.y = HS.SHELF_Y - HS.BALL_R; b.vx = -60; b.vy = 0;
  room.stepOnce(t);
  assert.strictEqual(room.state, 'goal');
  let sawHalf = false;
  for (const end = t + HS.GOAL_PAUSE_MS + 500; t < end; t += 1000 / 60) { room.tick(t); if (room.state === 'half') sawHalf = true; }
  assert.ok(sawHalf, 'half time after the goal break');
});
