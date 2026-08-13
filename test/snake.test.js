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
  s.grow(3);
  assert.strictEqual(s.score, 3);
  // slither.io growth curve: at spawn (sct=2) food converts at (1-2/411)^2.25 ≈ 0.9891,
  // so 3 food ≈ 2.97 segments → 2 whole segments now, ~0.97 banked in the fraction.
  for (let i = 0; i < 5; i++) s.update();
  assert.strictEqual(s.length, baseline + 2);
  s.grow(3); // banked fraction tips over: ~0.97 + ~2.95 → 3 more whole segments
  for (let i = 0; i < 5; i++) s.update();
  assert.strictEqual(s.length, baseline + 5);
});

test('growth stops entirely at the slither part cap (411 parts); score keeps rising', () => {
  const s = new Snake('id', 'T', 0, 0, '#fff');
  // Stuff the body to the cap: 411 parts = MIN_SEGMENTS + 409 segments here
  const capLen = C.SNAKE_MIN_SEGMENTS * 2 + 409;
  while (s.length < capLen) s.segments.push({ x: 0, y: 0 });
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
  const s = new Snake('id', 'T', 0, 0, '#c080ff', 'hat', 'boost');
  s.worth = 0.5;
  const w = s.serialize();
  assert.strictEqual(w.id, 'id');
  assert.strictEqual(w.color, '#c080ff');
  assert.strictEqual(w.hatId, 'hat');
  assert.strictEqual(w.worth, 0.5);
  assert.ok(Array.isArray(w.segs));
  assert.strictEqual(typeof w.angle, 'number');
  assert.strictEqual(typeof w.boostRatio, 'number');
});

test('only slither palette colours are accepted from the client', () => {
  const palette = require('../../snake-design/slither-palette.json')
    .map(p => p.hex.toLowerCase());

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
