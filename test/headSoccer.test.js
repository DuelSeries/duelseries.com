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
   golden goal settles a level one, a goal counts, the kick is the reference's, and two bots
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
  assert.strictEqual(settled.length, 0, 'no result at 0:00 while level');
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

test('no half time: the clock runs 2:00 down to 0:00 with no break, then a decided match settles once', () => {
  const { lob, settled } = lobby();
  const { room } = paidMatch(lob, 1);
  let t = run(room, 0, HS.COUNTDOWN_MS + 100);
  assert.strictEqual(room.state, 'playing');
  room.match.score = [1, 0];
  const states = new Set();
  for (const end = t + HS.MATCH_MS + 200; t < end; t += 1000 / 60) { room.tick(t); states.add(room.state); }
  assert.ok(!states.has('half') && !states.has('kickoff'), 'no break on the way: ' + [...states].join(','));
  assert.strictEqual(room.match.msLeft, 0);
  assert.strictEqual(room.state, 'settling', 'the whistle at 0:00');
  run(room, t, HeadSoccerRoom.WIN_HOLD_MS + 200);
  assert.strictEqual(settled.length, 1, 'settled once');
  assert.strictEqual(settled[0].winnerId, room.players.get('A').side === 0 ? 'A' : 'B');
});

test('a free match also ends at 0:00 and settles once, with no money on it', () => {
  const room = new HeadSoccerRoom(io);
  room.addPlayer(sock('A'), 'A', null);
  room.addPlayer(sock('B'), 'B', null);
  const fin = room.finish.bind(room);
  let finishes = 0;
  room.finish = (...a) => { finishes++; return fin(...a); };
  let t = 0;
  room.start(t);
  t = run(room, t, HS.COUNTDOWN_MS + 100);
  room.match.score = [0, 2];
  t = run(room, t, HS.MATCH_MS + 200 + HeadSoccerRoom.WIN_HOLD_MS + 200);
  assert.strictEqual(room.state, 'over');
  assert.strictEqual(finishes, 1);
});

test('the clock counts down from 2:00 to 0:00, and the kick is the reference one', () => {
  assert.strictEqual(HS.MATCH_MS, 120000);
  assert.strictEqual(Sim.clockDigits(HS.MATCH_MS), '0200');
  assert.strictEqual(Sim.clockDigits(HS.MATCH_MS - 1), '0200', 'a second shows until it has gone');
  assert.strictEqual(Sim.clockDigits(HS.MATCH_MS - 1000), '0159');
  assert.strictEqual(Sim.clockDigits(60000), '0100');
  assert.strictEqual(Sim.clockDigits(400), '0001');
  assert.strictEqual(Sim.clockDigits(0), '0000');
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

test('golden goal lasts one minute of play: the board counts it down, and still level it is a refunded draw', () => {
  const { lob, settled } = lobby();
  const { room } = paidMatch(lob, 0.5);
  let t = run(room, 0, HS.COUNTDOWN_MS + 100);
  room.match.score = [1, 1];
  room.match.msLeft = 10;
  t = run(room, t, 200);
  assert.strictEqual(room.state, 'golden');
  assert.strictEqual(room.snapshot().g, HS.GOLDEN_MAX_MS, 'the board shows the full minute');
  t = run(room, t, HS.GOLDEN_FLASH_MS + HS.COUNTDOWN_MS + 200);
  assert.strictEqual(room.state, 'playing');
  // Keep the ball out of both goals for the minute.
  const hold = () => { const b = room.match.ball; b.x = 0; b.y = 300; b.vx = 0; b.vy = 0; };
  let half = null;
  for (const end = t + HS.GOLDEN_MAX_MS - 2000; t < end; t += 1000 / 60) {
    hold(); room.tick(t);
    if (half === null && room.match.goldenMs >= 30000) half = room.snapshot().g;
  }
  assert.ok(Math.abs(half - 30000) < 100, 'half way: ' + half);
  assert.strictEqual(settled.length, 0, 'still playing with 2 s left');
  for (const end = t + 2500; t < end; t += 1000 / 60) { hold(); room.tick(t); }
  assert.strictEqual(room.state, 'settling', 'the whistle after the minute');
  run(room, t, HeadSoccerRoom.WIN_HOLD_MS + 200);
  assert.strictEqual(settled.length, 1);
  assert.strictEqual(settled[0].winnerId, null);
  assert.deepStrictEqual(settled[0].seats.map(s => s.refund).sort(), [0.5, 0.5]);
});

/* ── the contact engine (HS.CONTACT_P2): the reference's numbers, and lockstep ─────────────────────────────────
   Set up as the measuring harness did (players placed, 30 settle steps, then the scenario); the reference values
   are Heads Arena Euro Soccer stepped one p2 step at a time (docs/head-soccer-reference.md, "Contacts"). */
const IDLE = () => [{ held: 0, jumps: 0, kicks: 0, powers: 0 }, { held: 0, jumps: 0, kicks: 0, powers: 0 }];
function settled(x0, y0, x1, y1, ball) {
  const m = Sim.newMatch();
  [[x0, y0], [x1, y1]].forEach(([x, y], i) => Object.assign(m.p[i], { x, y, vx: 0, vy: 0, ground: true, jc: 0, left: i === 1, cf: true }));
  Object.assign(m.ball, { x: 400, y: HS.PITCH_Y - HS.BALL_R, vx: 0, vy: 0 });
  for (let i = 0; i < 30; i++) Sim.step(m, IDLE(), HS.STEP, false, true);
  if (ball) Object.assign(m.ball, ball);
  return m;
}
const near = (v, ref, pct, what) => assert.ok(Math.abs(v - ref) <= Math.abs(ref) * pct / 100, what + ': ' + v + ' vs the reference ' + ref);

test('contact engine: the ball rolls and bounces, and a released run slides, as the reference measured', () => {
  assert.strictEqual(HS.CONTACT_P2, true, 'on by default');
  const stand = HS.PITCH_Y - HS.FOOT, shelf = HS.SHELF_Y - HS.FOOT, rest = HS.PITCH_Y - HS.BALL_R;
  // Rolling: friction takes 8 u/s a step until the ball spins up (the rigid model kept 1350).
  let m = settled(-1150, shelf, 1150, shelf, { x: -900, y: rest, vx: 1500, vy: 0 });
  for (let i = 0; i < 60; i++) Sim.step(m, IDLE(), HS.STEP, false, true);
  near(m.ball.vx, 901.2, 0.5, 'rolling 1500, speed after 60 steps');
  assert.ok(m.ball.spin > 15, 'and it spins the way it rolls: ' + m.ball.spin);
  // Bouncing: restitution on a first impact only, from the start-of-step speed (the rigid model lost 24% by peak 6).
  m = settled(-495, stand, 495, stand, { x: 0, y: 576, vx: 0, vy: 0 });
  const peaks = [];
  let prev = m.ball.y, prevVy = m.ball.vy;
  for (let i = 0; i < 900; i++) {
    Sim.step(m, IDLE(), HS.STEP, false, true);
    if (m.ball.y > prev && prevVy < 0) peaks.push(rest - prev);
    prev = m.ball.y; prevVy = m.ball.vy;
  }
  near(peaks[1], 270.6, 0.5, 'bounce peak 2'); near(peaks[5], 32.8, 1, 'bounce peak 6');
  // A run released: the soft friction row (the players' hidden inertia) slides 40.23 (the rigid model 36.94).
  m = settled(-800, stand, 800, stand);
  const R = IDLE(); R[0].held = Sim.IN.RIGHT;
  for (let i = 0; i < 40; i++) Sim.step(m, R, HS.STEP, false, true);
  const x40 = m.p[0].x;
  for (let i = 0; i < 100; i++) Sim.step(m, IDLE(), HS.STEP, false, true);
  near(m.p[0].x - x40, 40.23, 1, 'stopping distance');
});

// Presses for both seats, step by step, from a fixed seed (counts only ever go up).
function script(n, seed) {
  let s = seed >>> 0;
  const r = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
  const c = IDLE(), out = [];
  for (let i = 0; i < n; i++) {
    for (const x of c) { if (r() < 0.1) x.held = Math.floor(r() * 3); if (r() < 0.04) x.jumps++; if (r() < 0.08) x.kicks++; }
    out.push(c.map(x => Object.assign({}, x)));
  }
  return out;
}
// held is only the last input's echo (every step overwrites it from its input), so it is not compared
const bodies = (m) => JSON.stringify([m.p[0], m.p[1], m.ball], (k, v) => (k === 'held' ? undefined : v));
const wireOf = (m) => JSON.stringify([Sim.packPlayer(m.p[0]), Sim.packPlayer(m.p[1]), Sim.packBall(m.ball)]);
function fromWire(m) {
  const w = JSON.parse(wireOf(m)), o = Sim.newMatch();
  o.p = [Sim.unpackPlayer(w[0], 0), Sim.unpackPlayer(w[1], 1)]; o.ball = Sim.unpackBall(w[2]); o.tick = m.tick;
  return o;
}

test('contact engine: a match stepped from its own snapshot gives the same states, bit for bit', () => {
  const inp = script(1800, 7);
  const a = Sim.newMatch();
  let i0 = 0, run3 = 0;
  // play on until the ball has been on something for a few steps, so the snapshot must carry the engine's memory
  while (i0 < 300 || run3 < 3) { Sim.step(a, inp[i0++], HS.STEP, false, true); run3 = (a.ball.touch & ~1) ? run3 + 1 : 0; }   // not the top edge (restitution 0)
  assert.ok(i0 < 1200, 'the ball rested on something by step ' + i0);
  Sim.snapToWire(a);
  const b = fromWire(a);                 // the page's copy, from the wire
  assert.strictEqual(bodies(b), bodies(a), 'the snapshot carries the whole state');
  const other = Sim.newMatch();          // another match stepped in between: nothing is shared between matches
  let touching = 0;
  for (let i = i0; i < i0 + 600; i++) {
    const ea = Sim.step(a, inp[i], HS.STEP, false, true);
    Sim.step(other, inp[(i * 7) % 1800], HS.STEP, false, true);
    const eb = Sim.step(b, inp[i], HS.STEP, false, true);
    assert.deepStrictEqual(eb, ea, 'events, step ' + i);
    assert.strictEqual(bodies(b), bodies(a), 'state, step ' + i);
    if (a.ball.touch || a.p[0].touch || a.p[1].touch) touching++;
  }
  assert.ok(touching > 200, 'contacts happened: ' + touching);
  // And the memory is needed: a ball resting on the grass, replayed without its touch bits, takes its rest for a
  // first impact (restitution .8) and moves; with them it sits as the server's does.
  const kept = fromWire(settled(-800, HS.PITCH_Y - HS.FOOT, 800, HS.PITCH_Y - HS.FOOT)), lost = fromWire(kept);
  assert.ok(kept.ball.touch, 'resting on the grass');
  lost.ball.touch = 0;
  for (let i = 0; i < 5; i++) { Sim.step(kept, IDLE(), HS.STEP, false, true); Sim.step(lost, IDLE(), HS.STEP, false, true); }
  assert.notStrictEqual(bodies(lost), bodies(kept), 'without the touch bits the replay goes wrong, so they ride the wire');
});

test("the page's replay from each snapshot is the server's next states, bit for bit", () => {
  const room = new HeadSoccerRoom(io);
  room.addPlayer(sock('A'), 'A', null);
  room.addPlayer(sock('B'), 'B', null);
  room.start(0);
  const t = run(room, 0, HS.COUNTDOWN_MS + 100);
  assert.strictEqual(room.state, 'playing');
  room.maybeSnap(true);   // a snapshot of this very tick to start from
  const inp = script(900, 11);
  let page = null, based = null, compared = 0;
  for (let i = 0; i < 900; i++) {
    if (room.lastSnap && room.lastSnap !== based) {
      // What the page does with a snapshot (onSnap + loadBase), from the JSON the socket carries.
      const s = JSON.parse(JSON.stringify(room.lastSnap));
      page = Sim.newMatch();
      page.ball = Sim.unpackBall(s.b); page.p = [Sim.unpackPlayer(s.p[0], 0), Sim.unpackPlayer(s.p[1], 1)]; page.tick = s.k;
      based = room.lastSnap;
    }
    for (let k = 0; k < 2; k++) Object.assign(room.inputs[k], inp[i][k]);
    const enabled = room.state === 'playing';
    room.stepOnce(t);
    Sim.step(page, inp[i], HS.STEP, false, enabled);   // the page's stepSim, both seats' presses known
    assert.strictEqual(page.tick, room.match.tick);
    assert.strictEqual(wireOf(page), wireOf(room.match), 'tick ' + page.tick);
    if (room.lastSnap === based) assert.strictEqual(bodies(page), bodies(room.match), 'full precision, tick ' + page.tick);
    compared++;
  }
  assert.strictEqual(compared, 900);
});
