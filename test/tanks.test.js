'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { TanksRoom, TANKS } = require('../server/TanksRoom');

/* The REAL room. Tanks is turn-based, so unlike the arena games there is no
   clock to fake and no tick to drive: a turn is one call and one answer. */

const io = { to: () => ({ emit: () => {} }) };
let sid = 0;
const sock = () => ({ id: 's' + (++sid), join() {} });

function match(seed) {
  const r = new TanksRoom(io, 'test');
  const a = sock(), b = sock();
  r.addPlayer(a, 'Owen', 'WALLET_A');
  r.addPlayer(b, 'Rival', 'WALLET_B');
  r.start(seed || 12345);
  return { r, a, b };
}

test('a match needs two tanks, and puts them apart', () => {
  const r = new TanksRoom(io, 't');
  const a = sock();
  assert.ok(r.addPlayer(a, 'Owen'), 'the first player is seated');
  assert.equal(r.start(1), false, 'but one tank is not a match');

  const b = sock();
  assert.ok(r.addPlayer(b, 'Rival'), 'the second is seated');
  assert.ok(!r.addPlayer(sock(), 'Gatecrasher'), 'and a third is not');

  assert.equal(r.start(1), true);
  const [p1, p2] = r.fullState().players;
  assert.ok(Math.abs(p1.x - p2.x) > TANKS.W * 0.5,
    'they start on opposite sides, not next to each other');
  assert.ok(p1.health === TANKS.MAX_HEALTH && p2.health === TANKS.MAX_HEALTH);
});

test('the ground is ground: continuous, and inside its limits', () => {
  /* A heightmap made of a few big waves rather than noise. Artillery wants
     shapes to shoot over, and a jagged surface makes a shot that lands a pixel
     left of another one do something completely different. */
  const { r } = match(999);
  const g = r.fullState().ground;
  assert.equal(g.length, TANKS.COLS);
  for (const h of g) {
    assert.ok(h >= TANKS.GROUND_MIN - 1 && h <= TANKS.GROUND_MAX + 1,
      'every column is within the limits (' + h + ')');
  }
  let worstStep = 0;
  for (let i = 1; i < g.length; i++) worstStep = Math.max(worstStep, Math.abs(g[i] - g[i - 1]));
  assert.ok(worstStep < 20, 'and no column is a cliff off the last one (' + worstStep + ')');
});

test('the same seed builds the same hill', () => {
  // Both players must be looking at the same battlefield, and a match must be
  // reproducible from its seed when something goes wrong in one.
  const one = match(4242).r.fullState().ground;
  const two = match(4242).r.fullState().ground;
  assert.deepEqual(one, two);
  assert.notDeepEqual(one, match(4243).r.fullState().ground, 'and a different seed does not');
});

test('only the player whose turn it is can fire', () => {
  const { r, a, b } = match();
  const off = r.turn === a.id ? b : a;
  assert.equal(r.fire(off.id, 45, 50).ok, false, 'the other player cannot shoot');
  assert.equal(r.fire(r.turn, 45, 50).ok, true, 'the one whose turn it is can');
});

test('firing passes the turn', () => {
  const { r } = match();
  const first = r.turn;
  r.fire(first, 45, 30);
  assert.notEqual(r.turn, first, 'the other player is up');
  r.fire(r.turn, 45, 30);
  assert.equal(r.turn, first, 'and then it comes back');
});

test('the wind is re-rolled every turn', () => {
  /* The wind is what stops a duel becoming "find the number that works and
     type it every turn". */
  const { r } = match();
  /* Rolled directly rather than by taking twelve shots. Firing twelve times
     can END the match, after which nothing rolls and the test fails for a
     reason that has nothing to do with wind — which is exactly what it did. */
  const seen = new Set();
  for (let i = 0; i < 40; i++) { r.rollWind(); seen.add(r.wind); }
  assert.ok(seen.size > 3, 'it is not the same number every time (' + seen.size + ' values)');
  for (const w of seen) {
    assert.ok(Math.abs(w) <= TANKS.WIND_MAX, 'and it stays inside its limit');
  }

  // And a shot really does roll it: the turn and the wind change together.
  const w0 = r.wind;
  let changed = false;
  for (let i = 0; i < 8 && !changed; i++) {
    for (const p of r.players.values()) p.health = TANKS.MAX_HEALTH;   // keep it alive
    r.fire(r.turn, 45, 20);
    if (r.wind !== w0) changed = true;
  }
  assert.ok(changed, 'firing re-rolls it');
});

test('a shell arcs, and the server decides where it lands', () => {
  const { r } = match();
  const shot = r.fire(r.turn, 45, 70);
  assert.ok(shot.ok);
  const path = shot.result.path;
  assert.ok(path.length > 10, 'the whole flight is sent, not just the landing');

  // It must actually go up and then come down.
  const ys = path.map(p => p[1]);
  const peak = Math.max.apply(null, ys);
  assert.ok(peak > ys[0] + 40, 'it climbs');
  assert.ok(ys[ys.length - 1] < peak, 'and it falls');

  assert.ok(['ground', 'tank', 'out'].includes(shot.result.hit.type));
});

test('more power throws it further', () => {
  /* The one relationship a player has to be able to feel. If this is not
     monotonic the game is unlearnable. */
  let last = -Infinity;
  for (const power of [20, 40, 60, 80, 100]) {
    const { r } = match(777);
    r.wind = 0;                                  // isolate power from wind
    const shooter = r.turn;
    const from = r.players.get(shooter).x;
    const shot = r.fire(shooter, 45, power);
    const dist = Math.abs(shot.result.hit.x - from);
    assert.ok(dist > last, power + ' power goes further than the last (' + Math.round(dist) + ')');
    last = dist;
  }
});

test('wind pushes the shell, and which way is not a coin toss', () => {
  const shoot = (wind) => {
    const { r } = match(555);
    r.wind = wind;
    const shooter = r.turn;
    return r.fire(shooter, 60, 70).result.hit.x;
  };
  const left = shoot(-TANKS.WIND_MAX);
  const none = shoot(0);
  const right = shoot(TANKS.WIND_MAX);
  assert.ok(left < none && none < right,
    'a headwind lands it shorter and a tailwind further (' +
    [left, none, right].map(Math.round).join(' < ') + ')');
});

test('a hit hurts, and a direct hit hurts most', () => {
  const { r } = match();
  const shooter = r.turn;
  const foe = r.opponentOf(shooter);
  const before = foe.health;

  // Drop a shell straight onto the opponent by exploding at their feet.
  r.explode(foe.x, r.groundAt(foe.x) + TANKS.TANK_H / 2);
  assert.ok(foe.health < before, 'a blast at their feet takes health');
  const direct = before - foe.health;

  const { r: r2 } = match();
  const s2 = r2.turn, f2 = r2.opponentOf(s2);
  const h2 = f2.health;
  r2.explode(f2.x + TANKS.BLAST_RADIUS * 1.4, r2.groundAt(f2.x) + TANKS.TANK_H / 2);
  const glancing = h2 - f2.health;

  assert.ok(direct > glancing, 'and being further away hurts less');
  assert.ok(glancing >= 0, 'but a near miss never heals anybody');
});

test('a blast digs a hole where it lands', () => {
  const { r } = match(31337);
  const x = TANKS.W / 2;
  const before = r.groundAt(x);
  r.explode(x, before);
  assert.ok(r.groundAt(x) < before, 'the ground is lower after an explosion');

  // And it does not dig a trench across the whole map.
  const far = r.groundAt(x + TANKS.BLAST_RADIUS * 3);
  const farBefore = r.ground[r.colAt(x + TANKS.BLAST_RADIUS * 3)];
  assert.equal(far, farBefore, 'ground well away from the blast is untouched');
});

test('the ground can be dug away but never through the floor', () => {
  const { r } = match();
  const x = TANKS.W / 2;
  for (let i = 0; i < 40; i++) r.explode(x, r.groundAt(x));
  assert.ok(r.groundAt(x) > 0, 'there is always some ground left to stand on');
});

test('running out of health ends the match, and names the winner', () => {
  const { r } = match();
  const shooter = r.turn;
  const foe = r.opponentOf(shooter);
  foe.health = 1;
  r.explode(foe.x, r.groundAt(foe.x) + TANKS.TANK_H / 2);

  // The room only checks for a death as part of a shot, so take one.
  r.fire(shooter, 90, TANKS.POWER_MIN);
  assert.equal(r.state, 'over');
  assert.ok(r.winner, 'somebody won');
  assert.equal(r.winner.id, shooter, 'and it is the one still standing');
});

test('blowing up both tanks at once is a draw, not a win', () => {
  /* Otherwise the winning move in a losing position is to kill yourself along
     with them, which is not a game. */
  const { r } = match();
  const shooter = r.turn;
  for (const p of r.players.values()) p.health = 1;
  const mid = (([...r.players.values()][0].x) + ([...r.players.values()][1].x)) / 2;
  for (const p of r.players.values()) p.x = mid;   // stand them together
  r.settleTanks();
  r.explode(mid, r.groundAt(mid) + TANKS.TANK_H / 2);
  r.fire(shooter, 90, TANKS.POWER_MIN);
  assert.equal(r.state, 'over');
  assert.equal(r.winner, null, 'nobody wins a mutual destruction');
});

test('leaving mid-match hands the win to whoever stayed', () => {
  /* Or the losing move is always to close the tab, which on a game with money
     on it is the only bug that really matters. */
  const { r, a, b } = match();
  r.removePlayer(a.id);
  assert.equal(r.state, 'over');
  assert.equal(r.winner.id, b.id);
});

test('a wild power or angle is clamped, not obeyed', () => {
  /* A client sending 400 power is broken or lying. Either way the answer is the
     strongest legal shot rather than an error nobody can act on. */
  const { r } = match();
  const shooter = r.turn;
  const shot = r.fire(shooter, 9999, 9999);
  assert.ok(shot.ok);
  const me = r.players.get(shooter);
  assert.ok(me.power <= TANKS.POWER_MAX && me.power >= TANKS.POWER_MIN);
  assert.ok(me.angle >= 0 && me.angle <= 180);
});

test('a turn that runs out is skipped, not forfeited', () => {
  const { r } = match();
  const first = r.turn;
  r.turnEndsAt = Date.now() - 1;
  r.tick();
  assert.notEqual(r.turn, first, 'the turn passes');
  assert.equal(r.state, 'playing', 'but the match carries on');
  for (const p of r.players.values()) {
    assert.equal(p.health, TANKS.MAX_HEALTH, 'and nobody is punished for it');
  }
});

test('the state sent to players carries no wallets', () => {
  const { r } = match();
  const s = JSON.stringify(r.fullState());
  assert.ok(!s.includes('WALLET_A') && !s.includes('WALLET_B'),
    'a wallet address is nobody else\'s business');
});
