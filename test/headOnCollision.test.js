'use strict';
/* A HEAD-ON MUST NOT BE DECIDED BY WHO JOINED FIRST.

   Reported as: "I am in front of a player and it looks to me like they are
   running into me, but on their screen it is the other way around, and I end up
   dying." That reads like a prediction artifact and is not one.

   The collision pass walked every snake in turn and killed one the moment its
   head was found inside another's body. In a head-on both heads are inside each
   other — segment 0 IS the head — so the FIRST snake reached died, and the
   second was spared because its killer was already dead and dead snakes are
   skipped. `snakes` is a Map keyed by socket id, so "first reached" meant
   "joined the room first". Measured, insertion order the only variable:

       inserted first   outcome
       A                A died, B survived
       B                B died, A survived

   Completely consistent, and invisible from either screen: each player watches
   the other run into them and one is simply told they lost.

   Collisions are decided against the state at the START of the tick now and
   applied together, which is what makes the outcome independent of order.

   THE RULE ON TOP OF THAT IS SIZE: the bigger snake wins a head-on. Symmetric
   (both die) was the honest answer while there was no rule at all; size is a
   better one than a coin toss, because it is a thing you can see coming and
   play around. Dead level, both still go — there is no fair way to separate two
   identical snakes, and inventing one lands straight back on an arbitrary
   tiebreak deciding matches. */

const test = require('node:test');
const assert = require('node:assert');
const C = require('../shared/constants');
const GameRoom = require('../server/GameRoom');
const Snake = require('../server/Snake');

const io = { to: () => ({ emit: () => {} }), emit: () => {} };

function makeRoom() {
  const room = new GameRoom(io, 'free');
  room.broadcastSnapshot = () => {};
  room.topUpBots = () => {};                    // nobody else in the room
  room.foodManager.spawnInitial = () => {};
  return room;
}

/* A snake laid out straight, nose at (x,y), body trailing behind it. */
function lay(room, id, x, y, angle) {
  const s = new Snake(id, id, x, y, '#ff4040');
  s.angle = angle; s.targetAngle = angle;
  for (let i = 0; i < s.segments.length; i++) {
    s.segments[i].x = x - Math.cos(angle) * i * C.SNAKE_STORED_GAP_PER_R * C.SNAKE_HEAD_RADIUS;
    s.segments[i].y = y - Math.sin(angle) * i * C.SNAKE_STORED_GAP_PER_R * C.SNAKE_HEAD_RADIUS;
  }
  room.players.set(id, { socket: { emit: () => {} }, name: id });
  return s;
}

/* Drive two snakes nose to nose. `firstId` decides only who goes into the Map
   first; `grow` optionally makes one of them bigger. */
function headOn(firstId, opts) {
  const o = opts || {};
  const room = makeRoom();
  const A = lay(room, 'A', -30, 0, 0);            // facing +x
  const B = lay(room, 'B', 30, 0, Math.PI);       // facing -x
  if (o.growA) A._parts = (A._parts || A.length) + o.growA;
  if (o.growB) B._parts = (B._parts || B.length) + o.growB;
  if (firstId === 'A') { room.snakes.set('A', A); room.snakes.set('B', B); }
  else                 { room.snakes.set('B', B); room.snakes.set('A', A); }
  for (let t = 0; t < 200 && (A.alive || B.alive); t++) {
    room.tick();
    if (!A.alive || !B.alive) break;
  }
  return { a: A.alive, b: B.alive, lenA: A.length, lenB: B.length };
}

test('two snakes of the SAME size both die in a head-on', () => {
  for (const first of ['A', 'B']) {
    const r = headOn(first);
    assert.equal(r.lenA, r.lenB, 'the two really are the same size');
    assert.equal(r.a, false, 'A died (inserted first: ' + first + ')');
    assert.equal(r.b, false, 'B died (inserted first: ' + first + ')');
  }
});

test('the BIGGER snake wins a head-on, and the smaller one dies', () => {
  for (const first of ['A', 'B']) {
    const r = headOn(first, { growA: 40 });
    assert.ok(r.lenA > r.lenB, 'A really is bigger (' + r.lenA + ' vs ' + r.lenB + ')');
    assert.equal(r.a, true, 'the bigger snake lived (inserted first: ' + first + ')');
    assert.equal(r.b, false, 'the smaller one did not');
  }
});

test('and it is size that decides it, not which one is called A', () => {
  /* The mirror image. If the rule were quietly reading anything but size, one
     of these two rows would disagree with the other. */
  const aBigger = headOn('A', { growA: 40 });
  const bBigger = headOn('A', { growB: 40 });
  assert.deepEqual([aBigger.a, aBigger.b], [true, false], 'A bigger: A lives');
  assert.deepEqual([bBigger.a, bBigger.b], [false, true], 'B bigger: B lives');
});

test('the outcome does not depend on join order at all', () => {
  /* The regression this file exists for. Before the fix these disagreed, and
     which player was punished was decided by nothing but who had walked into
     the lobby first. Checked for both the level case and the lopsided one. */
  assert.deepEqual(headOn('A'), headOn('B'),
    'a level head-on has the same outcome regardless of insertion order');

  const x = headOn('A', { growA: 40 }), y = headOn('B', { growA: 40 });
  assert.deepEqual([x.a, x.b], [y.a, y.b],
    'and so does a lopsided one');
});

test('running into somebody s side is still your fault alone', () => {
  /* The one-sided case has to STAY one-sided, and size must not leak into it:
     clipping a BIGGER snake's tail still kills only you. If head-on-by-size
     were implemented by comparing sizes everywhere, this would invert. */
  const room = makeRoom();
  const runner = lay(room, 'runner', 0, -60, Math.PI / 2);       // heading +y
  const bystander = lay(room, 'bystander', 0, 0, 0);             // lying along +x
  runner._parts = runner.length + 60;                            // and the runner is HUGE
  room.snakes.set('runner', runner);
  room.snakes.set('bystander', bystander);

  for (let t = 0; t < 200 && runner.alive; t++) room.tick();

  assert.ok(runner.length > bystander.length, 'the runner is the bigger snake');
  assert.equal(runner.alive, false, 'and still died, because it drove into a body');
  assert.equal(bystander.alive, true, 'the one that was driven into did not');
});

test('a snake never dies on its own body', () => {
  const room = makeRoom();
  const s = lay(room, 'solo', 0, 0, 0);
  room.snakes.set('solo', s);
  for (let t = 0; t < 120; t++) room.tick();
  assert.equal(s.alive, true, 'still going');
});
