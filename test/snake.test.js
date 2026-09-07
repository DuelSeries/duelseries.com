'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Snake = require('../server/Snake');
const C = require('../shared/constants');

test('spawns alive with the spawn length and zero score/worth', () => {
  const s = new Snake('id1', 'Test', 0, 0, '#fff', 'none', 'default');
  assert.strictEqual(s.alive, true);
  assert.strictEqual(s.score, 0);
  assert.strictEqual(s.worth, 0);
  assert.ok(s.length >= C.SNAKE_MIN_SEGMENTS * 2, 'at least the minimum length');
  assert.ok(s.head && typeof s.head.x === 'number');
});

test('grow() raises the score and lengthens the body as growth is consumed', () => {
  const s = new Snake('id', 'T', 0, 0, '#fff');
  s.angle = 0; s.targetAngle = 0;
  const baseline = s.length;
  /* Growth is granted one segment per body point laid down, and points are laid
     every `separation` units of travel — which scales with the snake. So this
     drains the pending growth rather than assuming a fixed number of ticks
     covers it; a hardcoded tick count silently encodes the speed and spacing of
     the day it was written. */
  const settle = () => { for (let i = 0; i < 200 && s.pendingGrowth > 0; i++) s.update(); };

  s.grow(3);
  assert.strictEqual(s.score, 3);
  // slither.io growth curve: at spawn (sct=2) food converts at (1-2/411)^2.25 ≈ 0.9891,
  // so 3 food ≈ 2.97 segments → 2 whole segments now, ~0.97 banked in the fraction.
  settle();
  assert.strictEqual(s.length, baseline + 2);
  s.grow(3); // banked fraction tips over: ~0.97 + ~2.95 → 3 more whole segments
  settle();
  assert.strictEqual(s.length, baseline + 5);
});

test('growth stops entirely at the slither part cap (411 parts); score keeps rising', () => {
  const s = new Snake('id', 'T', 0, 0, '#fff');
  /* Stuff the body to the cap: 411 parts = MIN_SEGMENTS + 409.
     Parts are the gameplay length and are set directly. The stored points are
     derived from parts (roughly 0.73 of a point per part), so pushing segments
     no longer changes length and looping on it would never terminate. */
  const capLen = C.SNAKE_MIN_SEGMENTS * 2 + 409;
  s._parts = capLen;
  const scoreBefore = s.score;
  s.grow(50);
  assert.strictEqual(s.pendingGrowth, 0, 'no segments granted past the cap');
  assert.ok(s.score > scoreBefore, 'score still accumulates past the cap');
});

test('update() moves the head forward along its angle', () => {
  const s = new Snake('id', 'T', 0, 0, '#fff');
  s.angle = 0; s.targetAngle = 0;            // face +x
  const x0 = s.head.x;
  s.update();
  assert.ok(s.head.x > x0, 'head advanced in +x');
});

test('die() marks the snake dead and returns food drops', () => {
  const s = new Snake('id', 'T', 0, 0, '#fff');
  const drops = s.die();
  assert.strictEqual(s.alive, false);
  assert.ok(Array.isArray(drops));
  assert.ok(drops.length > 0);
  assert.ok(drops.every(d => typeof d.x === 'number' && typeof d.y === 'number'));
});

test('serialize() exposes the wire fields the codec/client expect', () => {
  const s = new Snake('id', 'T', 0, 0, '#c080ff');
  s.worth = 0.5;
  const w = s.serialize();
  assert.strictEqual(w.id, 'id');
  assert.strictEqual(w.color, '#c080ff');
  assert.strictEqual(w.worth, 0.5);
  assert.ok(Array.isArray(w.segs));
  assert.strictEqual(typeof w.angle, 'number');
  assert.strictEqual(typeof w.boostRatio, 'number');
});

test('only slither palette colours are accepted from the client', () => {
  // From the module itself, not snake-design/slither-palette.json — that folder
  // is reference material outside this repo, so requiring it would fail on a
  // fresh checkout.
  const palette = [...Snake.COLORS, ...Snake.SKIN_ONLY_COLORS];

  // every skin the shop offers survives untouched
  for (const c of ['#c080ff', '#ff4040', '#505050', '#6828aa', '#20f020']) {
    assert.strictEqual(new Snake('i', 'T', 0, 0, c).color, c,
      c + ' is a slither colour and should be kept as-is');
  }
  // case and whitespace are normalized rather than rejected
  assert.strictEqual(new Snake('i', 'T', 0, 0, ' #C080FF ').color, '#c080ff');

  // anything off-palette falls back to a random palette colour — a modified
  // client must not be able to play e.g. near-invisible black or a colour
  // that isn't slither's
  for (const bad of ['#000000', '#abc', '#3B82F6', 'red', '', null, undefined, 42, {}]) {
    const got = new Snake('i', 'T', 0, 0, bad).color;
    assert.ok(palette.includes(got),
      JSON.stringify(bad) + ' should fall back to a palette colour, got ' + got);
    assert.notStrictEqual(got, bad);
  }
});

test('boost fuel never lets the body shrink below the hard floor', () => {
  const s = new Snake('id', 'T', 0, 0, '#fff');
  assert.ok(s.boostFuel >= 0);
  assert.ok(s.boostRatio >= 0 && s.boostRatio <= 1);
});

/* ─── What a corpse is worth ─────────────────────────────────────────────────
   The bug this pins down: a corpse used to be priced per SEGMENT, so a
   spawn-size snake dropped 4.85x its own mass and you could die at minimum
   size, eat your own body and come back several times bigger. The same formula
   gave a 411-part snake 0.03x, because real mass explodes near the part cap
   while segment count does not.

   slither's own tables, read out of their live client bundle:
     fmlts[i] = (1 - i/mscps)^2.25
     fpsls[i] = fpsls[i-1] + 1/fmlts[i-1]
   and fpsls[sct] is the food it takes to build a body of sct parts. */

function grown(parts) {
  const s = new Snake('t', 'T', 0, 0, '#c080ff');
  let guard = 0;
  while (s.length < parts && guard++ < 20000) { s.grow(40); s.update(); }
  return s;
}
const corpseValue = s => s.die().reduce((n, d) => n + (d.value || 0), 0);

test('a corpse is worth a fixed share of the body, at every size', () => {
  [30, 60, 120, 250, 400].forEach(parts => {
    const s = grown(parts);
    const mass = s.mass;
    const got = corpseValue(s);
    assert.ok(mass > 0, parts + ' parts has mass');
    /* Exactly the ratio, not roughly: the orb COUNT is a drawing decision that
       follows the shape of the snake, and it must not be what decides the
       value. That it used to was the whole bug. */
    assert.ok(Math.abs(got / mass - C.CORPSE_DROP_RATIO) < 1e-6,
      parts + ' parts dropped ' + (got / mass).toFixed(3) + 'x, wanted ' + C.CORPSE_DROP_RATIO);
  });
});

test('a snake that never ate anything leaves nothing behind', () => {
  /* The reported exploit, at its root. The spawn body is given away free, so
     there is nothing owed on it and nothing to drop. */
  const s = new Snake('t', 'T', 0, 0, '#c080ff');
  assert.equal(s.mass, 0, 'a fresh snake has earned no mass');
  assert.equal(corpseValue(s), 0, 'and its corpse is worth nothing');
});

test('eating a whole corpse never gets you as big as the snake that died', () => {
  /* The invariant that makes dying a loss instead of a move. It has to hold at
     every size, because the failure was size-dependent in both directions. */
  [30, 60, 120, 250, 400].forEach(parts => {
    const victim = grown(parts);
    const was = victim.length;
    const food = corpseValue(victim);

    const eater = new Snake('e', 'E', 0, 0, '#c080ff');
    eater.grow(food);
    for (let i = 0; i < 5000 && eater.pendingGrowth > 0; i++) eater.update();
    assert.ok(eater.length < was,
      'a spawn snake ate a ' + was + '-part corpse and reached ' + eater.length);
  });
});

test('growth is integrated, so one big meal is worth exactly what many small ones are', () => {
  /* grow() used to read the falloff ONCE, at the size before eating, and apply
     it to the whole mouthful — so a snake that ate a lot in one go grew at its
     starting rate the whole way up. Invisible one pellet at a time, which is
     why it sat here unnoticed until a corpse orb could be worth thousands. */
  const TOTAL = 400;

  const oneGo = new Snake('a', 'A', 0, 0, '#c080ff');
  oneGo.grow(TOTAL);
  for (let i = 0; i < 5000 && oneGo.pendingGrowth > 0; i++) oneGo.update();

  const nibbling = new Snake('b', 'B', 0, 0, '#c080ff');
  for (let i = 0; i < TOTAL; i++) {
    nibbling.grow(1);
    nibbling.update();
  }
  for (let i = 0; i < 5000 && nibbling.pendingGrowth > 0; i++) nibbling.update();

  assert.ok(Math.abs(oneGo.length - nibbling.length) <= 1,
    'one mouthful gave ' + oneGo.length + ', four hundred gave ' + nibbling.length);
});
