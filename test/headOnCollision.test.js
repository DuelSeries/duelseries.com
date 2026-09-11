'use strict';
/* A HEAD-ON MUST NOT BE DECIDED BY WHO JOINED FIRST.

   Reported as: "I am in front of a player and it looks to me like they are
   running into me, but on their screen it is the other way around, and I end up
   dying." That reads like a prediction artifact and is not one.

   The collision pass walked every snake in turn, and killed a snake the moment
   its head was found inside another's body. In a head-on both heads are inside
   each other — segment 0 IS the head — so the FIRST snake reached died, and the
   second was then spared because its killer was already dead and dead snakes
   are skipped. `snakes` is a Map keyed by socket id, so "first reached" means
   "joined the room first". Measured, with two identical snakes and insertion
   order as the only variable:

       inserted first   outcome
       A                A died, B survived
       B                B died, A survived

   Completely consistent, and invisible from either screen: each player sees the
   other run into them, and one of them is simply told they lost.

   The fix is to decide every collision against the state at the START of the
   tick and apply the deaths together, so a genuine head-on kills both. Running
   into somebody's SIDE is unchanged and still one-sided: that is your fault and
   only you die. */

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
   first, which is the variable under test. */
function headOn(firstId, gap) {
  const room = makeRoom();
  const A = lay(room, 'A', -(gap / 2), 0, 0);          // facing +x
  const B = lay(room, 'B',  (gap / 2), 0, Math.PI);    // facing -x
  if (firstId === 'A') { room.snakes.set('A', A); room.snakes.set('B', B); }
  else                 { room.snakes.set('B', B); room.snakes.set('A', A); }
  for (let t = 0; t < 200 && (A.alive || B.alive); t++) {
    room.tick();
    if (!A.alive || !B.alive) break;
  }
  return { a: A.alive, b: B.alive };
}

test('a head-on kills both snakes, whoever joined first', () => {
  for (const first of ['A', 'B']) {
    const r = headOn(first, 60);
    assert.equal(r.a, false, `A died in a head-on (inserted first: ${first})`);
    assert.equal(r.b, false, `B died in a head-on (inserted first: ${first})`);
  }
});

test('and the outcome does not depend on join order at all', () => {
  /* The regression this exists for. Before the fix these two rows disagreed,
     and which player was punished was decided by nothing but who had walked
     into the lobby first. */
  const first = headOn('A', 60);
  const second = headOn('B', 60);
  assert.deepEqual(first, second,
    'the same collision has the same outcome regardless of insertion order');
});

test('running into somebody s side is still your fault alone', () => {
  /* The one-sided case has to STAY one-sided. If a head-on killing both were
     achieved by making every collision mutual, then clipping a stationary
     snake's tail would take them with you, which is worse than the bug. */
  const room = makeRoom();
  // Victim drives straight up; the other sits across its path, pointing away,
  // so only the first snake's head reaches the other's body.
  const runner = lay(room, 'runner', 0, -60, Math.PI / 2);       // heading +y
  const bystander = lay(room, 'bystander', 0, 0, 0);             // lying along +x
  room.snakes.set('runner', runner);
  room.snakes.set('bystander', bystander);

  for (let t = 0; t < 200 && runner.alive; t++) room.tick();

  assert.equal(runner.alive, false, 'the one who drove into the body died');
  assert.equal(bystander.alive, true, 'the one who was driven into did not');
});

test('a snake never dies on its own body', () => {
  const room = makeRoom();
  const s = lay(room, 'solo', 0, 0, 0);
  room.snakes.set('solo', s);
  for (let t = 0; t < 120; t++) room.tick();
  assert.equal(s.alive, true, 'still going');
});
