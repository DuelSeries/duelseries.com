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

  /* Stepped, not sampled: the hops advance on the wall clock, so one jump to
     t+45s would leave the machine on its very first leg. */
  let farthest = 0;
  for (let ms = BR.SHRINK_MS; ms <= BR.SHRINK_MS + 45000; ms += 100) {
    at(r, ms);
    farthest = Math.max(farthest, Math.hypot(r.worldCx, r.worldCy));
  }
  assert.ok(Math.abs(r.worldRadius - BR.FINAL_RADIUS) < 1, 'it holds its size while hopping');
  /* The FARTHEST it got, not where it happens to be right now: a leg can pass
     straight through the middle on its way somewhere else, so sampling one
     instant is a coin toss rather than a test. */
  assert.ok(farthest > 300, 'and it travels (farthest ' + Math.round(farthest) + ')');

  /* The one thing a roaming zone must never do is leave the world it is drawn
     in, which would put the circle somewhere no snake can follow it.

     A FRESH room, walked once from the start. Re-walking the same room rewinds
     its hop clock, which makes the machine think the current leg overran and
     teleport — a measurement artefact that looks exactly like the bug this
     whole file exists to catch. */
  const r2 = room(1);
  go(r2);
  let worst = 0;
  for (let ms = BR.SHRINK_MS; ms <= BR.SHRINK_MS + BR.ROAM_MS; ms += 100) {
    at(r2, ms);
    worst = Math.max(worst, Math.hypot(r2.worldCx, r2.worldCy) + r2.worldRadius);
  }
  assert.ok(worst < BR.START_RADIUS, 'and never wanders outside the world');
});

test('the clock running out starts sudden death, and does not end anything', () => {
  /* The buzzer used to end the match. It begins the part that ends it: the
     circle holds at its smallest and hunts faster every second, so there is a
     point past which nobody can stay ahead of it. Shrinking further was the old
     answer and it was wrong — crushing a circle two snake-lengths across just
     kills everyone at once. */
  const full = BR.SHRINK_MS + BR.ROAM_MS;
  const r = room(2);
  go(r);

  at(r, full + 3000);
  assert.equal(r.state, 'running', 'the buzzer does not end it');
  assert.equal(Math.round(r.worldRadius), BR.ENDGAME_RADIUS, 'and it stops shrinking');
  assert.equal(r.publicState().phase, 'sudden', 'the phase says what this is');

  at(r, full + 120000);
  assert.equal(Math.round(r.worldRadius), BR.ENDGAME_RADIUS,
    'two minutes later it is still exactly that size');

  /* And it really does accelerate — this is the only thing guaranteeing the
     match ends at all. A snake tops out at SNAKE_MAX_SPEED; the hunt must pass
     it. */
  const C = require('../shared/constants');
  const boost = C.SNAKE_MAX_SPEED * C.TICK_RATE;
  assert.ok(r.huntSpeed(full + 1000, 0) < boost, 'it starts slower than a boosting snake');
  assert.ok(r.huntSpeed(full + 90000, 0) > boost,
    'and outruns one before long, so the match cannot last forever');
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

test('a solo run keeps going past the buzzer, until the circle gets you', () => {
  /* "Last one standing" is true the moment a one-player match begins, so this
     used to end before the countdown had even cleared. Then it ended on the
     buzzer — which meant the one person who can test this never saw sudden
     death, the part worth testing. It ends when the circle gets you. */
  const r = room(1);
  go(r);
  assert.equal(r.isSoloRun(), true, 'it knows it started alone');

  for (const ms of [1000, BR.SHRINK_MS, BR.SHRINK_MS + BR.ROAM_MS + 1000,
                    BR.SHRINK_MS + BR.ROAM_MS + 60000]) {
    at(r, ms);
    r.checkForWinner();
    assert.equal(r.state, 'running', 'still going at ' + ms / 1000 + 's');
  }

  r.snakes.get('p0').alive = false;
  r.checkForWinner();
  assert.equal(r.state, 'over', 'and it ends when the player dies');
  assert.equal(r.soloRun, true, 'marked as a solo run, so no prize is paid');
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
  assert.ok(worst > 5, 'and it does actually move (' + Math.round(worst) + ' u/s)');
  assert.ok(worst < cruise * 0.75,
    'the zone moves at ' + Math.round(worst) + ' u/s, well under a snake at ' + Math.round(cruise));

  // It still has to be a threat: standing still must eventually leave you out.
  const r3 = room(1); go(r3);
  const sample3 = (ms) => { at(r3, ms); return { cx: r3.worldCx, cy: r3.worldCy, rad: r3.worldRadius }; };
  let stranded = null;
  for (let ms = BR.SHRINK_MS; ms <= BR.SHRINK_MS + BR.ROAM_MS && stranded === null; ms += 100) {
    const p = sample3(ms);
    if (Math.hypot(p.cx, p.cy) > p.rad) stranded = (ms - BR.SHRINK_MS) / 1000;
  }
  assert.ok(stranded !== null && stranded >= 3,
    'a player who never moves is left outside, but not instantly (was ' + stranded + 's)');

  // And it still cannot wander out of the world it is drawn in.
  const r4 = room(1); go(r4);
  let worstOut = 0;
  for (let ms = BR.SHRINK_MS; ms <= BR.SHRINK_MS + BR.ROAM_MS; ms += 100) {
    at(r4, ms);
    worstOut = Math.max(worstOut, Math.hypot(r4.worldCx, r4.worldCy) + r4.worldRadius);
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

test('the ring shows the size the wall will be, not the size it is', () => {
  /* Owen watched the endgame start and died before he could see it work. The
     ring was drawn at the CURRENT radius, so during the last thirty seconds it
     showed a circle bigger than the one that actually arrives — it promised
     room that would not be there by the time he got to it. */
  const r = room(1);
  go(r);

  // Well before the endgame, the two agree: nothing is shrinking yet.
  for (let ms = BR.SHRINK_MS; ms <= BR.SHRINK_MS + 20000; ms += 100) at(r, ms);
  let to = r.hopTarget();
  if (to) assert.ok(Math.abs(to.r - r.worldRadius) < 1,
    'outside the endgame the ring is simply the current size');

  // Inside it, the ring must be SMALLER than the wall is right now.
  const total = BR.SHRINK_MS + BR.ROAM_MS;
  let warned = 0, samples = 0;
  for (let ms = BR.SHRINK_MS + 20100; ms <= total; ms += 100) {
    at(r, ms);
    if (ms < total - BR.ENDGAME_MS) continue;
    to = r.hopTarget();
    if (!to) continue;
    samples++;
    if (to.r < r.worldRadius) warned++;
  }
  assert.ok(samples > 0, 'there are hops during the endgame at all');
  assert.ok(warned / samples > 0.8,
    'and the ring is smaller than the wall for most of it (' + warned + '/' + samples + ')');
});

test('a leg length can never be NaN, which would freeze the zone', () => {
  /* This is not hypothetical. Dropping the clock argument from one recursive
     call made the endgame factor NaN, which made the hop speed NaN, which made
     the leg duration NaN — and every comparison against NaN is false, so the
     circle sat on one leg for the whole match while looking perfectly healthy.
     Two hops in three minutes instead of nine. A silent freeze is worse than a
     crash, so the guard stays. */
  const r = room(1);
  go(r);
  r._hopTo = null;
  r._stepHop(undefined);              // the exact mistake, made on purpose
  assert.ok(isFinite(r._hopMs), 'a missing clock cannot produce a NaN leg');
  assert.ok(r._hopMs >= 1200, 'and it falls back to a real duration');
});
