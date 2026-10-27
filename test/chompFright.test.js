'use strict';
// Owen 2026-10-26: an energizer turns EVERY ghost blue for its eater only (server/chomp/chompRoom.js blueFor). The
// server keeps each player's own fright timer, collisions use the player's own state, an eaten ghost's eyes go home
// for everyone and it comes back out normal for its eater. A fruit gives a short burst of speed.
const test = require('node:test');
const assert = require('node:assert');
const R = require('../shared/chompRules');
const Maze = require('../shared/chompMaze');
const { ChompRoom } = require('../server/chomp/chompRoom');

const quiet = { error() {}, warn() {}, log() {} };

// A walkable tile centre in the arena, far from (fx, fy) when given.
function pathTile(room, fx, fy) {
  const A = room.A;
  for (let r = 1; r < A.H; r++) for (let c = 1; c < A.W; c++) {
    if (!A.walk(c, r)) continue;
    if (fx != null && Math.abs(A.dx(fx, c + 0.5)) + Math.abs(A.dy(fy, r + 0.5)) < 30) continue;
    return [c + 0.5, r + 0.5];
  }
  throw new Error('no tile');
}

function eatEnergizer(room, p) {
  const A = room.A;
  let k = -1;
  for (let i = 0; i < room.dots.length; i++) if (room.dots[i] === Maze.ENERGIZER) { k = i; break; }
  room.eatDot(p, k, Maze.ENERGIZER);
}

test('an energizer turns every ghost blue for its eater only, near or far', () => {
  const room = new ChompRoom({ seed: 4, botFill: 0, grow: false, log: quiet });
  const a = room.addPlayer({ name: 'a' }), b = room.addPlayer({ name: 'b' });
  for (let t = 0; t < 120; t++) room.step();
  eatEnergizer(room, a);
  const live = room.ghosts.filter((g) => g.state !== 'eyes' && g.state !== 'entering');
  assert.ok(live.length >= room.ghosts.length - 1);
  assert.ok(live.every((g) => room.blueFor(a, g)), 'every ghost is blue for the eater, in every module');
  assert.ok(room.ghosts.every((g) => !room.blueFor(b, g)), 'and for nobody else');
  // b eats their own: blue for b too
  eatEnergizer(room, b);
  assert.ok(live.every((g) => room.blueFor(b, g)));
});

test('collisions use each player\'s own fright: the eater eats, the other is caught; the eyes go home for everyone', () => {
  const room = new ChompRoom({ seed: 6, botFill: 0, grow: false, log: quiet });
  const a = room.addPlayer({ name: 'a' }), b = room.addPlayer({ name: 'b' });
  for (let t = 0; t < 30; t++) room.step();
  a.safe = 0; b.safe = 0;
  eatEnergizer(room, a);
  const ga = room.ghosts.find((g) => g.kind === 'blinky');
  const gb = room.ghosts.find((g) => g.kind === 'blinky' && g !== ga);
  // a meets ga, b meets gb, far apart
  const [ax, ay] = pathTile(room);
  const [bx, by] = pathTile(room, ax, ay);
  a.x = ax; a.y = ay; ga.x = ax; ga.y = ay; ga.state = 'active';
  b.x = bx; b.y = by; gb.x = bx; gb.y = by; gb.state = 'active';
  a.dir = b.dir = -1; a.want = b.want = -1;
  room.collide();
  assert.strictEqual(ga.state, 'eyes', 'blue for a: a ate it');
  assert.strictEqual(a.dying, 0);
  assert.ok(b.dying > 0, 'not blue for b: it caught b');
  assert.strictEqual(gb.state, 'active');
  // the eyes get home, the ghost comes back out normal for a (whose power still runs), still blue for nobody
  for (let t = 0; t < R.TICK_HZ * 6 && ga.state !== 'leaving' && ga.state !== 'active'; t++) {
    require('../server/chomp/chompGhosts').step(ga, room.A, room, 1 / R.TICK_HZ);
    room.tick++;
  }
  assert.ok(ga.state === 'leaving' || ga.state === 'active', 'back home: ' + ga.state);
  assert.ok(a.power > 0 && !room.blueFor(a, ga), 'back out normal for its eater');
  // a fresh energizer makes it blue for a again
  eatEnergizer(room, a);
  assert.ok(room.blueFor(a, ga));
});

test('a ghost blue for a nearby eater takes the frightened walk for everyone; far away it hunts as usual', () => {
  const room = new ChompRoom({ seed: 8, botFill: 0, grow: false, log: quiet });
  const a = room.addPlayer({ name: 'a' });
  for (let t = 0; t < 30; t++) room.step();
  eatEnergizer(room, a);
  const near = room.ghosts.find((g) => g.state === 'active');
  near.x = a.x + 2; near.y = a.y;
  room.scareGhosts();
  assert.strictEqual(near.fright, 1);
  near.x = room.A.wx(a.x + R.FLEE_RADIUS + 20);
  room.scareGhosts();
  assert.strictEqual(near.fright, 0);
  a.power = 0;
  near.x = a.x + 2;
  room.scareGhosts();
  assert.strictEqual(near.fright, 0, 'no power, no fright');
});

test('a fruit gives its eater a 3 s burst of speed, 10% faster, gone on a death', () => {
  const room = new ChompRoom({ seed: 3, botFill: 0, grow: false, log: quiet });
  const p = room.addPlayer({ name: 'p' });
  const base = room.speedOf(p);
  const m = room.A.modules[0];
  m.fruitUntil = room.tick + 600;
  p.x = m.ox + Maze.FRUIT.x - 0.5; p.y = m.oy + Math.floor(Maze.FRUIT.y) + 0.5;
  room.checkFruit(p);
  assert.strictEqual(m.fruitUntil, 0, 'eaten');
  assert.strictEqual(p.boost, R.FRUIT_BOOST_S * R.TICK_HZ);
  assert.ok(Math.abs(room.speedOf(p) / base - R.FRUIT_BOOST) < 1e-9);
  assert.ok(R.FRUIT_BOOST <= 1.15, 'small: not a big edge');
  p.safe = 0;
  room.kill(p, null, room.ghosts[0]);
  assert.strictEqual(p.boost, 0);
});
