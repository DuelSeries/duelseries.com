'use strict';
const test = require('node:test');
const assert = require('node:assert');

/* The REAL room the server runs, given a stub io and stepped by hand. The zone
   is a pure function of the clock, so winding startedAt backwards plays a whole
   four-minute match in a millisecond. */
const { BattleRoyaleRoom, BR } = require('../server/BattleRoyaleRoom');

const io = { to: () => ({ emit: () => {} }) };
const snake = (id, name, score) => ({ id, name, score: score || 0, alive: true, head: { x: 0, y: 0 } });

function room(n = 2) {
  const r = new BattleRoyaleRoom(io, 'test_br');
  for (let i = 0; i < n; i++) {
    const id = 'p' + i;
    r.snakes.set(id, snake(id, 'Player' + i, i * 10));
    r.players.set(id, { walletAddress: 'WALLET_' + i });
  }
  return r;
}
/* ── the clock ────────────────────────────────────────────────────────────
   Installed once, for the whole file, because the zone is no longer a pure
   function of the match clock: the hops run on Date.now and so does
   checkForWinner. Faking it only INSIDE `at` meant the hop machine and the
   ending saw two different times, and a match that should have run out of
   clock quietly had a second left.

   Everything below shares this one clock: startMatch, the zone, the ending. */
let FAKE = Date.now();
Date.now = () => FAKE;
const tick = (ms) => { FAKE += ms; };

/* Wind the match clock to a point, advancing the wall clock with it.

   FORWARD ONLY. The hop machine is stateful — it remembers when the current leg
   started — so rewinding the match clock mid-test makes it think a leg has
   overrun and teleport to its target. Any loop that walks the roam has to walk
   it once, in order, on a fresh room. */
const at = (r, ms) => {
  tick(100);
  r.startedAt = FAKE - ms;
  r.updateZone();
};

/* Start a match and skip its countdown. Every test below is about what happens
   once the circle is moving, and the ten seconds before that is its own test. */
const go = (r, reason) => {
  const started = r.startMatch(reason || 'test');
  r.countdownUntil = Date.now() - 1;   // the count has elapsed
  r.updateZone();                      // which is what promotes it to running
  return started;
};


/* Run the zone forward, the way the tick loop does. The ring model keeps its
   own deadlines against the wall clock, so it cannot be sampled at a moment
   the way the old clock-driven zone could — it has to actually be stepped. */
const run = (r, ms, step) => {
  const dt = step || 100;
  for (let t = 0; t < ms; t += dt) { tick(dt); r.updateZone(); }
};
test('a match needs somebody in the room, and one is enough', () => {
  /* The minimum is one. There are no other players on the game yet and a
     two-player floor only ever stopped Owen testing it alone; it stays a named
     constant so the day it should be two, there is one line to change. */
  const empty = room(0);
  assert.equal(empty.canStart(), false, 'a match of nobody is not a match');
  assert.equal(empty.startMatch('test'), false, 'and starting is refused outright');
  assert.equal(empty.state, 'waiting');

  const r = room(1);
  assert.equal(r.canStart(), true, 'one player can start');
  assert.equal(r.startMatch('test'), true);
});

test('starting begins a countdown, not the closing', () => {
  /* Dropping straight into a shrinking border gives nobody time to look up,
     and the count is also what tells the room this is a match now. */
  const r = room(2);
  r.startMatch('test');
  assert.equal(r.state, 'countdown', 'it counts first');
  assert.ok(r.publicState().countdownMs > 0, 'and says how long is left');
  assert.equal(r.publicState().phase, 'countdown');

  // The zone must not start closing while the count runs.
  r.updateZone();
  assert.equal(Math.round(r.worldRadius), BR.START_RADIUS, 'the circle is still open');
  assert.equal(r.acceptingPlayers(), false, 'and the door is already shut');

  r.countdownUntil = Date.now() - 1;
  r.updateZone();
  assert.equal(r.state, 'running', 'then it goes live on its own');
  assert.ok(r.startedAt > 0, 'and the match clock starts THERE, not when start was pressed');
});



test('the match ends the moment one snake is left, whatever the clock says', () => {
  const r = room(3);
  go(r);
  at(r, 20000);                       // twenty seconds in, nowhere near the buzzer

  r.checkForWinner();
  assert.equal(r.state, 'running', 'three alive is not an ending');

  r.snakes.get('p0').alive = false;
  r.checkForWinner();
  assert.equal(r.state, 'running', 'nor is two');

  r.snakes.get('p1').alive = false;
  r.checkForWinner();
  assert.equal(r.state, 'over', 'one is');
  assert.equal(r.winner.name, 'Player2');
  assert.equal(r.winner.wallet, 'WALLET_2', 'and they can be paid');
});

test('a double knockout still has somebody to pay', () => {
  /* The border kills instantly, so two snakes on opposite edges of a closing
     circle really do die on the same tick. "Nobody won" means a $20 prize with
     nobody to pay it to, so the higher score takes it. */
  const r = room();
  r.snakes.get('p0').score = 500;
  r.snakes.get('p1').score = 20;
  go(r);
  r.checkForWinner();                 // both alive: records them
  r.snakes.get('p0').alive = false;
  r.snakes.get('p1').alive = false;
  r.checkForWinner();

  assert.equal(r.state, 'over');
  assert.ok(r.winner, 'somebody won');
  assert.equal(r.winner.name, 'Player0', 'the better run takes it');
  assert.ok(r.winner.wallet, 'and has a wallet to be paid at');
});

test('surviving beats scoring', () => {
  // The tiebreak is ONLY for a double knockout. Being alive always wins.
  const r = room();
  r.snakes.get('p0').score = 1;
  r.snakes.get('p1').score = 9999;
  go(r);
  r.checkForWinner();
  r.snakes.get('p1').alive = false;
  r.checkForWinner();
  assert.equal(r.winner.name, 'Player0', 'the survivor wins, not the bigger score');
});


test('the public state never leaks more than it should', () => {
  const r = room();
  go(r);
  at(r, 1000);
  const s = r.publicState();
  /* The zone announces a ring before it moves, so the first thing a match is
     doing is warning about one — not closing. */
  assert.ok(['warning', 'closing', 'holding'].indexOf(s.phase) >= 0, s.phase);
  assert.equal(s.alive, 2);
  assert.equal(s.state, 'running');
  // A winner's wallet address is nobody else's business.
  r.snakes.get('p1').alive = false;
  r.checkForWinner();
  const done = r.publicState();
  assert.equal(done.winner.name, 'Player0');
  assert.equal(done.winner.wallet, undefined, 'the wallet stays on the server');
});








/* ── bots in a prize match ─────────────────────────────────────────────────
   This mode pays real money to one winner. Bots exist here so somebody who
   opens the lobby early sees a room with life in it, and that is the whole of
   their job: they have no wallet to be paid into, so anything that lets one
   reach the end as the winner is a $20 prize with nobody to give it to. */

const bot = (id, name) => ({ id, name, score: 0, alive: true, isBot: true, head: { x: 0, y: 0 } });

test('a room full of robots cannot start a match', () => {
  const r = new BattleRoyaleRoom(io, 'test_br');
  for (let i = 0; i < 8; i++) r.snakes.set('b' + i, bot('b' + i, 'Bot' + i));
  assert.equal(r.livingCount(), 8, 'the room has bodies in it');
  assert.equal(r.humanLiving(), 0, 'and nobody in it');
  assert.equal(r.canStart(), false, 'so there is no match to start');
  assert.equal(r.forceStart('owner'), false, 'not even by force');
});

test('a bot is never the winner, however long it survives', () => {
  const r = room(1);                       // one person
  for (let i = 0; i < 5; i++) r.snakes.set('b' + i, bot('b' + i, 'Bot' + i));
  r.startMatch('test');
  r.state = 'running';

  // The person dies; five robots are still driving around.
  r.snakes.get('p0').alive = false;
  r.checkForWinner();

  assert.equal(r.state, 'over', 'the match ended when the last PERSON died');
  assert.ok(!r.winner || !r.snakes.get(r.winner.id).isBot,
            'and a robot did not win it');
});

test('bots fill the lobby and never join a match already running', () => {
  /* This room inherits the free-lobby top-up, and `br` IS a free lobby type,
     so without a guard the moment the bot floor went up a prize match would
     have found twenty robots arriving mid-round. */
  /* na_br, not test_br: whether a room takes bots is decided by its lobby
     TYPE against the shared free list, and 'test_br' is not a lobby type the
     product has. The guard was right to refuse it. */
  const r = new BattleRoyaleRoom(io, 'na_br');
  r.stop();
  r.topUpBots();
  const filled = r.botCount;
  assert.ok(filled > 0, 'the waiting lobby fills (' + filled + ')');

  r.state = 'running';
  for (const [id, sn] of [...r.snakes]) if (sn.isBot) r.snakes.delete(id);
  r.topUpBots();
  assert.equal(r.botCount, 0, 'and a running match gets none');
});

/* ── the wall, and whether anything can outrun it ────────────────────────── */

const Bot = require('../server/Bot');
const CC = require('../shared/constants');

test('the wall never closes faster than a snake can swim', () => {
  /* The close is eased, so its rate peaks at the very end at
     2*(START-FINAL)/SHRINK_MS. That used to be 186 units a second against a
     snake that cruises at 133: the only way to survive the last seconds was to
     boost, which costs body, and a bot never boosts to escape.

     The duration is derived from the speed now rather than the other way round,
     so this asserts the property rather than a number of seconds. */
  const cruise = CC.SNAKE_BASE_SPEED * CC.TICK_RATE;
  assert.ok(BR.CLOSE_SPEED < cruise,
    'wall ' + BR.CLOSE_SPEED.toFixed(0) + '/s vs cruise ' + cruise.toFixed(0) + '/s');
  /* And with room to spare, or you can only ever escape it in a straight line
     with nothing else going on. */
  assert.ok(BR.CLOSE_SPEED < cruise * 0.8, 'and with margin to fight in');
  /* There is no separate wander speed any more: the centre travels as part of
     the ring move, under the same cap, which is asserted for real against a
     running zone in 'the wall never moves faster than a snake can swim'. */
});

test('a bot runs toward the circle, not toward the origin', () => {
  /* The bug that actually killed them. Border avoidance measured from (0,0) and
     steered at (0,0), which is right in every room except the one where the
     border matters: a battle royale's circle roams up to 800 units off centre,
     so a bot fleeing the wall ran toward where the circle used to be, often
     straight through it and out the far side. */
  const bot = new Bot('b', 0, 0);
  const R = 1000;
  const cx = 800, cy = 0;

  /* OFF the line through the origin and the circle. The first version put the
     bot, the circle and the origin all on the x-axis, where 'toward the
     circle' and 'toward the origin' are the same direction — so the test could
     not tell the fixed code from the broken code, and said so. */
  bot.head.x = cx; bot.head.y = cy + 900;   // straight out from the circle
  bot.updateAI([], R, [bot], cx, cy);

  /* Shortest angle between two headings. JavaScript's % keeps the sign of the
     dividend, so the usual one-liner returns something near -2PI for a
     negative difference and Math.abs then reports it as 6.28 radians out. The
     first version of this test did exactly that and failed a bot that was
     pointing precisely where it should. */
  const angleGap = (a, b) => {
    let d = (a - b + Math.PI) % (Math.PI * 2);
    if (d < 0) d += Math.PI * 2;
    return Math.abs(d - Math.PI);
  };

  const toCircle = Math.atan2(cy - bot.head.y, cx - bot.head.x);
  const off = angleGap(bot.targetAngle, toCircle);
  assert.ok(off < 0.01, 'it heads for the circle (off by ' + off.toFixed(3) + ' rad)');

  /* And that is NOT the direction the origin is in, or the test would pass on
     the broken code too. */
  const toOrigin = Math.atan2(-bot.head.y, -bot.head.x);
  assert.ok(angleGap(toCircle, toOrigin) > 0.01,
    'and the two directions really are different here');
});

test('a bot keeps going until it is properly inside, not just barely', () => {
  /* One threshold made it flee until a unit inside the line, resume wandering
     outward, and cross again — a twitch rather than a journey, holding station
     while the wall came in. Latched, it keeps swimming until it is safe. */
  const bot = new Bot('b', 0, 0);
  const R = 1000;

  bot.head.x = 850; bot.head.y = 0;          // outside caution (0.78)
  bot.updateAI([], R, [bot], 0, 0);
  assert.equal(bot._fleeing, true, 'it starts running');

  bot.head.x = 700; bot.head.y = 0;          // inside caution, outside safe
  bot.updateAI([], R, [bot], 0, 0);
  assert.equal(bot._fleeing, true, 'and is still running at 0.70R');

  bot.head.x = 500; bot.head.y = 0;          // inside safe (0.55)
  bot.updateAI([], R, [bot], 0, 0);
  assert.equal(bot._fleeing, false, 'and stops once it is properly clear');
});

/* ── the rings ─────────────────────────────────────────────────────────────
   A white circle appears inside the current one and a little smaller, sits
   there long enough to be read, and then the wall travels to it. Again and
   again until one snake is left. Nothing here runs on a match clock. */

test('every ring is smaller than the last, down to the floor and no further', () => {
  const r = room(2);
  go(r);
  const seen = [];
  let last = Infinity;
  for (let i = 0; i < 400; i++) {
    run(r, 500);
    const t = r.hopTarget();
    if (t && (!seen.length || seen[seen.length - 1] !== t.r)) seen.push(t.r);
  }
  assert.ok(seen.length >= 5, 'it keeps calling new rings (' + seen.length + ')');
  seen.forEach(v => {
    assert.ok(v <= last + 1e-9, 'rings never grow: ' + v + ' after ' + last);
    assert.ok(v >= BR.RING_MIN_RADIUS - 1e-9, 'and never go under the floor: ' + v);
    last = v;
  });
});

test('the next circle is always wholly inside the one it replaces', () => {
  /* The invariant the whole model rests on: ground that is safe now was safe a
     moment ago, so running for the white circle can never take you through the
     wall. If the ring could poke outside, the border would have to EXPAND
     somewhere, and a battle royale that gives ground back is not one. */
  const r = room(2);
  go(r);
  for (let i = 0; i < 300; i++) {
    run(r, 500);
    const t = r.hopTarget();
    if (!t) continue;
    const d = Math.hypot(t.x - r.worldCx, t.y - r.worldCy);
    assert.ok(d + t.r <= r.worldRadius + 1e-6,
      'ring at ' + d.toFixed(0) + ' with r=' + t.r.toFixed(0) +
      ' escapes a wall of ' + r.worldRadius.toFixed(0));
  }
});

test('the wall never moves faster than a snake can swim, at any point on it', () => {
  /* Not just the radius: a point on the boundary moves by the shrink AND by
     however far the centre travelled, and it is that sum a player has to
     outrun. Sampling both together is the only honest measure. */
  const r = room(2);
  go(r);
  let prev = { x: r.worldCx, y: r.worldCy, rad: r.worldRadius };
  let worst = 0;
  const STEP = 100;
  for (let i = 0; i < 2000; i++) {
    run(r, STEP, STEP);
    const moved = Math.hypot(r.worldCx - prev.x, r.worldCy - prev.y) +
                  Math.abs(r.worldRadius - prev.rad);
    worst = Math.max(worst, moved / (STEP / 1000));
    prev = { x: r.worldCx, y: r.worldCy, rad: r.worldRadius };
  }
  const cruise = BR.CRUISE;
  assert.ok(worst <= BR.CLOSE_SPEED + 1, 'worst ' + worst.toFixed(1) + '/s vs cap ' + BR.CLOSE_SPEED.toFixed(1));
  assert.ok(worst < cruise, 'and under a snake at a walk (' + cruise.toFixed(0) + '/s)');
});

test('the zone never teleports out from under you', () => {
  const r = room(2);
  go(r);
  let prev = { x: r.worldCx, y: r.worldCy, rad: r.worldRadius };
  for (let i = 0; i < 1500; i++) {
    run(r, 100, 100);
    const jump = Math.hypot(r.worldCx - prev.x, r.worldCy - prev.y);
    assert.ok(jump < 40, 'the centre jumped ' + jump.toFixed(0) + ' units in a tenth of a second');
    prev = { x: r.worldCx, y: r.worldCy, rad: r.worldRadius };
  }
});

test('the white circle says exactly where the wall is going to stop', () => {
  /* A ring that promises room it does not deliver is worse than no ring. */
  const r = room(2);
  go(r);
  let target = null;
  for (let i = 0; i < 600 && !target; i++) { run(r, 200); target = r.hopTarget(); }
  assert.ok(target, 'a ring is announced');
  const want = { x: target.x, y: target.y, r: target.r };

  // Run until it has arrived and the ring is withdrawn.
  for (let i = 0; i < 2000 && r.hopTarget(); i++) run(r, 100, 100);
  assert.ok(Math.abs(r.worldRadius - want.r) < 1, 'stopped at the promised size');
  assert.ok(Math.hypot(r.worldCx - want.x, r.worldCy - want.y) < 1,
    'and in the promised place');
});

test('the ring is on screen while it is announced and while it travels', () => {
  /* It is a destination, not a countdown: taking it away the moment the wall
     starts moving would hide the thing you are running toward. */
  const r = room(2);
  go(r);
  let sawWarning = false, sawClosing = false;
  for (let i = 0; i < 800; i++) {
    run(r, 200);
    const phase = r.zonePhase();
    if (phase === 'warning') { sawWarning = true; assert.ok(r.hopTarget(), 'shown while warning'); }
    if (phase === 'closing') { sawClosing = true; assert.ok(r.hopTarget(), 'shown while closing'); }
  }
  assert.ok(sawWarning && sawClosing, 'both phases happen');
});

test('the zone keeps calling rings forever, so a match ends by players not by clock', () => {
  /* At the floor it stops shrinking but it does not stop MOVING. There is no
     buzzer in this mode: the match is over when one snake is left, and the
     circle has to keep applying pressure until then however long that takes. */
  const r = room(2);
  go(r);
  /* The schedule, computed from the constants rather than guessed at: worst
     case the circle passes below the size a snake can turn in at about 4.8
     minutes and reaches the floor at 6.3. Worst case because each ring's
     travel time comes from how far its centre moves, and that is random — a
     real match runs faster than this. The bounds below are the worst case
     with room on top, so the test is about the property and not about
     agreeing with a stopwatch. */
  run(r, 5.5 * 60 * 1000, 200);
  const mid = r.worldRadius;
  assert.ok(mid < BR.RING_ENDGAME_RADIUS,
    'by five and a half minutes it is past the point a snake can turn inside' +
    ' (' + mid.toFixed(0) + ')');

  run(r, 4 * 60 * 1000, 200);
  assert.ok(Math.abs(r.worldRadius - BR.RING_MIN_RADIUS) < 1,
    'and eventually sits on the floor (' + r.worldRadius.toFixed(0) + ')');
  assert.ok(r.worldRadius < mid, 'having kept closing the whole way');
});

test('nobody joins a match under way, or a circle that has not reopened', () => {
  const r = room(2);
  go(r);
  run(r, 5000);
  assert.equal(r.acceptingPlayers(), false, 'not while it is running');
  r.state = 'waiting';
  r.worldRadius = BR.START_RADIUS * 0.5;
  assert.equal(r.acceptingPlayers(), false, 'nor into a circle still reopening');
  r.worldRadius = BR.START_RADIUS;
  assert.equal(r.acceptingPlayers(), true, 'but yes once it is open again');
});

/* ── the ending ──────────────────────────────────────────────────────────────
   What happens between "one snake left" and "the next match can start". It was
   a bare fifteen-second setTimeout back to 'waiting', which ignored where the
   circle actually was: the room could call itself open while the arena was
   still three hundred units across, and the next arrival spawned into a death
   trap. The sequence is on the tick now — freeze, cash out, reopen. */

/* Start a match, then kill everyone but one and decide it. */
function endedMatch(n) {
  const r = room(n || 3);
  go(r);
  run(r, 20000);                                  // let the circle actually close a bit
  const survivor = [...r.snakes.values()][0];
  for (const s of r.snakes.values()) if (s !== survivor) s.alive = false;
  r.checkForWinner();
  return { r, survivor };
}

test('the wall stops dead the moment the match is decided', () => {
  /* It used to fall straight through to the reopening ease, so the winner's
     final ring grew out from under them the instant they won — and the frame
     before that, the wall was still closing in on somebody who had already
     won it. */
  const { r } = endedMatch(3);
  assert.equal(r.state, 'over');
  const at = { r: r.worldRadius, x: r.worldCx, y: r.worldCy };
  assert.ok(at.r < BR.START_RADIUS, 'the circle had actually closed');

  run(r, 4000);                                   // inside the winner's five seconds
  assert.equal(r.state, 'over', 'still holding');
  assert.equal(r.worldRadius, at.r, 'the radius has not moved');
  assert.equal(r.worldCx, at.x, 'nor the centre');
  assert.equal(r.worldCy, at.y);
});

test('the winner is cashed out five seconds later, exactly once', () => {
  const { r, survivor } = endedMatch(3);
  const paid = [];
  r.onWinnerCashout = (w, id) => paid.push({ name: w && w.name, id });

  run(r, 4000);
  assert.equal(paid.length, 0, 'not before the five seconds are up');

  run(r, 2000);
  assert.equal(paid.length, 1, 'cashed out once the delay has passed');
  assert.equal(paid[0].name, survivor.name, 'and it is the winner');
  assert.equal(paid[0].id, r.matchId, 'keyed to this match');

  run(r, 10000);
  assert.equal(paid.length, 1, 'and never a second time, however long it runs');
});

test('a winner who has already left does not stop the room reopening', () => {
  /* The hook reaches for a socket that may be gone. If that threw, the room
     would be stuck at 'over' forever and the event would never run again. */
  const { r } = endedMatch(3);
  r.onWinnerCashout = () => { throw new Error('they disconnected'); };
  run(r, 8000);
  assert.notEqual(r.state, 'over', 'the room moved on regardless');
});

test('then the arena reopens, and only then does the door', () => {
  const { r } = endedMatch(3);
  r.onWinnerCashout = () => {};
  run(r, 6000);
  assert.equal(r.state, 'reopening', 'the circle is travelling back out');
  assert.equal(r.acceptingPlayers(), false, 'and nobody may join a half-open arena');
  assert.equal(r.allowsRespawn(), false, 'nor respawn into one');
  assert.equal(r.canStart(), false, 'nor start the next match yet');

  const partway = r.worldRadius;
  run(r, 1000);
  assert.ok(r.worldRadius > partway, 'it is actually growing');

  run(r, 30000);                                   // let it finish
  assert.equal(r.state, 'waiting', 'the arena is open');
  assert.equal(r.worldRadius, BR.START_RADIUS, 'at full size, exactly');
  assert.equal(r.worldCx, 0, 'and back in the middle');
  assert.equal(r.worldCy, 0);
  assert.equal(r.acceptingPlayers(), true, 'NOW people can come in');
  assert.equal(r.allowsRespawn(), true);
});

test('the reopening is reported so the loader can show real progress', () => {
  const { r } = endedMatch(3);
  r.onWinnerCashout = () => {};
  run(r, 6000);
  const early = r.publicState();
  assert.equal(early.state, 'reopening');
  assert.ok(early.reopenPct > 0 && early.reopenPct < 1,
    'a fraction of the way open, not a fake timer');
  /* Sampled while it is still travelling. The first version stepped 8s and the
     arena had already finished, so reopenPct had fallen back to 0 for a room
     that was simply done — the assertion was reading the wrong moment. */
  run(r, 1000);
  const later = r.publicState();
  assert.equal(later.state, 'reopening', 'still opening at this point');
  assert.ok(later.reopenPct > early.reopenPct, 'and it climbs');
});

test('the winner countdown is reported while it runs', () => {
  const { r } = endedMatch(3);
  const s = r.publicState();
  assert.equal(s.state, 'over');
  assert.ok(s.cashoutMs > 0 && s.cashoutMs <= BR.CASHOUT_DELAY_MS,
    'the five seconds are on the wire, not guessed at by the client');
});

test('stopping a match that is ending releases the wall', () => {
  /* abandon() only knew about running and countdown, so a match called off
     while it was ending left the circle pinned wherever it had frozen and the
     room could never reopen. */
  const { r } = endedMatch(3);
  assert.equal(r.abandon(), true, 'a match that is ending can still be called off');
  assert.equal(r.state, 'waiting');
  run(r, 30000);
  assert.ok(r.worldRadius > BR.START_RADIUS * 0.9, 'and the arena comes back');
});

test('a new match does not inherit the last one s frozen wall', () => {
  const { r } = endedMatch(3);
  r.onWinnerCashout = () => {};
  run(r, 40000);                                   // all the way back to waiting
  for (const s of r.snakes.values()) s.alive = true;
  go(r);
  assert.equal(r.state, 'running');
  assert.equal(r.worldRadius, BR.START_RADIUS, 'the next match starts wide open');
  run(r, 20000);
  assert.ok(r.worldRadius < BR.START_RADIUS, 'and its circle closes normally');
});
