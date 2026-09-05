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
// Wind the match clock to a given point and let the zone catch up.
const at = (r, ms) => { r.startedAt = Date.now() - ms; r.updateZone(); };

/* Start a match and skip its countdown. Every test below is about what happens
   once the circle is moving, and the ten seconds before that is its own test. */
const go = (r, reason) => {
  const started = r.startMatch(reason || 'test');
  r.countdownUntil = Date.now() - 1;   // the count has elapsed
  r.updateZone();                      // which is what promotes it to running
  return started;
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

test('the zone closes, then roams, on the clock', () => {
  const r = room();
  go(r);

  at(r, 0);
  assert.equal(Math.round(r.worldRadius), BR.START_RADIUS, 'it opens at full size');

  at(r, BR.SHRINK_MS - 10);
  assert.ok(Math.abs(r.worldRadius - BR.FINAL_RADIUS) < 5, 'and is closed by two minutes');
  assert.ok(r.worldCx === 0 && r.worldCy === 0, 'closing in on the middle');

  at(r, BR.SHRINK_MS + 45000);
  assert.ok(Math.abs(r.worldRadius - BR.FINAL_RADIUS) < 1, 'then holds its size');
  assert.ok(Math.hypot(r.worldCx, r.worldCy) > 100, 'and wanders off centre');

  /* The one thing a roaming zone must never do is leave the world it is drawn
     in, which would put the circle somewhere no snake can follow it. */
  let worst = 0;
  for (let s = 0; s < 240; s += 2) {
    at(r, BR.SHRINK_MS + s * 1000);
    worst = Math.max(worst, Math.hypot(r.worldCx, r.worldCy) + r.worldRadius);
  }
  assert.ok(worst < BR.START_RADIUS, 'and never wanders outside the world');
});

test('overtime squeezes, and leaves a circle somebody can survive in', () => {
  /* At 14 units a second this went from 420 to the floor in thirty seconds — a
     guillotine, and one likely to take both finalists at once. */
  const r = room();
  go(r);
  at(r, BR.SHRINK_MS + BR.ROAM_MS + 30000);
  assert.ok(r.worldRadius < BR.FINAL_RADIUS, 'overtime keeps closing');
  assert.ok(r.worldRadius > BR.OVERTIME_FLOOR, 'but has not bottomed out in thirty seconds');
  at(r, BR.SHRINK_MS + BR.ROAM_MS + 10 * 60 * 1000);
  assert.equal(Math.round(r.worldRadius), BR.OVERTIME_FLOOR, 'and stops at the floor');
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

test('nobody joins a match under way, or a circle that has not reopened', () => {
  const r = room();
  assert.equal(r.acceptingPlayers(), true, 'the door is open before it starts');

  go(r);
  assert.equal(r.acceptingPlayers(), false, 'and shut while it runs');

  at(r, BR.SHRINK_MS + 30000);        // zone now small
  r.snakes.get('p1').alive = false;
  r.checkForWinner();
  assert.equal(r.state, 'over');
  /* The match is decided but the circle is still tiny. Letting people in here
     drops them into a few hundred units of death trap. */
  r.state = 'waiting';
  assert.equal(r.acceptingPlayers(), false, 'still shut while the circle is small');

  for (let i = 0; i < 500; i++) r.updateZone();
  assert.ok(r.worldRadius > BR.START_RADIUS * 0.9, 'the circle reopens on its own');
  assert.equal(r.acceptingPlayers(), true, 'and then people can play again');
});

test('the public state never leaks more than it should', () => {
  const r = room();
  go(r);
  at(r, 1000);
  const s = r.publicState();
  assert.equal(s.phase, 'closing');
  assert.equal(s.alive, 2);
  assert.equal(s.state, 'running');
  // A winner's wallet address is nobody else's business.
  r.snakes.get('p1').alive = false;
  r.checkForWinner();
  const done = r.publicState();
  assert.equal(done.winner.name, 'Player0');
  assert.equal(done.winner.wallet, undefined, 'the wallet stays on the server');
});

test('a solo run plays the whole clock instead of ending the instant it starts', () => {
  /* "Last one standing" is true the moment a one-player match begins, so the
     match ended before the countdown had cleared and the mode could not be
     tested by the only person on the game. A solo run is scored against the
     ZONE instead: it ends when the player dies, or when the full four minutes
     are up and they are still alive. */
  const r = room(1);
  go(r);
  assert.equal(r.isSoloRun(), true, 'it knows it started alone');

  at(r, 1000);
  r.checkForWinner();
  assert.equal(r.state, 'running', 'one second in, it is still going');

  at(r, BR.SHRINK_MS);
  r.checkForWinner();
  assert.equal(r.state, 'running', 'two minutes in, still going');

  at(r, BR.SHRINK_MS + BR.ROAM_MS + 1000);
  r.checkForWinner();
  assert.equal(r.state, 'over', 'and it ends when the clock does');
  assert.ok(r.winner, 'surviving the whole thing counts as winning it');
  assert.equal(r.soloRun, true, 'and it is marked as a solo run');
});

test('a solo run ends early if the circle gets you', () => {
  const r = room(1);
  go(r);
  at(r, 30000);
  r.snakes.get('p0').alive = false;
  r.checkForWinner();
  assert.equal(r.state, 'over', 'dying still ends it');
  assert.equal(r.soloRun, true);
});

test('a real match is unaffected by any of that', () => {
  // Two players still ends the moment one is left, at any point on the clock.
  const r = room(2);
  go(r);
  assert.equal(r.isSoloRun(), false);
  at(r, 5000);
  r.checkForWinner();
  assert.equal(r.state, 'running');
  r.snakes.get('p1').alive = false;
  r.checkForWinner();
  assert.equal(r.state, 'over', 'one left ends it');
  assert.equal(r.soloRun, false, 'and it is a real match, so it can be paid');
});

test('the zone can be followed, and never teleports out from under you', () => {
  /* Two failures that made the mode unplayable, both about SPEED.

     A snake cruises at SNAKE_BASE_SPEED per tick — about 133 units a second at
     60Hz. The first roam wandered 2160 units on a 46-second lap, roughly 295 a
     second: more than twice cruising, so the wall arrived at a speed nobody
     could outrun.

     And the centre jumped straight from (0,0) to wherever the path happened to
     begin the instant the closing finished, which killed whoever was standing
     in the middle — the exact thing that happened at the two-minute mark. */
  const C = require('../shared/constants');
  const cruise = C.SNAKE_BASE_SPEED * C.TICK_RATE;

  const r = room(1);
  go(r);

  const sample = (ms) => { at(r, ms); return { cx: r.worldCx, cy: r.worldCy, rad: r.worldRadius }; };

  // No jump at the handover: the wander starts exactly where the closing ended.
  const before = sample(BR.SHRINK_MS - 50);
  const after  = sample(BR.SHRINK_MS + 50);
  assert.ok(Math.hypot(after.cx - before.cx, after.cy - before.cy) < 30,
    'the circle does not teleport when it stops closing');

  // And it never outruns a snake.
  let worst = 0, prev = sample(BR.SHRINK_MS);
  for (let ms = BR.SHRINK_MS + 100; ms <= BR.SHRINK_MS + BR.ROAM_MS; ms += 100) {
    const p = sample(ms);
    worst = Math.max(worst, Math.hypot(p.cx - prev.cx, p.cy - prev.cy) / 0.1);
    prev = p;
  }
  assert.ok(worst < cruise * 0.75,
    'the zone moves at ' + Math.round(worst) + ' u/s, well under a snake at ' + Math.round(cruise));

  // It still has to be a threat: standing still must eventually leave you out.
  let stranded = null;
  for (let s = 0; s <= BR.ROAM_MS / 1000 && stranded === null; s++) {
    const p = sample(BR.SHRINK_MS + s * 1000);
    if (Math.hypot(p.cx, p.cy) > p.rad) stranded = s;
  }
  assert.ok(stranded !== null && stranded >= 6,
    'a player who never moves is left outside, but not instantly (was ' + stranded + 's)');

  // And it still cannot wander out of the world it is drawn in.
  let worstOut = 0;
  for (let s = 0; s <= BR.ROAM_MS / 1000; s++) {
    const p = sample(BR.SHRINK_MS + s * 1000);
    worstOut = Math.max(worstOut, Math.hypot(p.cx, p.cy) + p.rad);
  }
  assert.ok(worstOut < BR.START_RADIUS, 'the circle stays inside the world');
});

test('the closing takes a minute', () => {
  assert.equal(BR.SHRINK_MS, 60 * 1000, 'one minute of closing, not two');
  const r = room(1);
  go(r);
  at(r, BR.SHRINK_MS - 10);
  assert.ok(Math.abs(r.worldRadius - BR.FINAL_RADIUS) < 5, 'and it is fully closed by then');
});
