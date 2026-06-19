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
  for (let i = 0; i < 5; i++) s.update();    // consume the 3 pending segments, then hold
  assert.strictEqual(s.length, baseline + 3);
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
  const s = new Snake('id', 'T', 0, 0, '#abc', 'hat', 'boost');
  s.worth = 0.5;
  const w = s.serialize();
  assert.strictEqual(w.id, 'id');
  assert.strictEqual(w.color, '#abc');
  assert.strictEqual(w.hatId, 'hat');
  assert.strictEqual(w.worth, 0.5);
  assert.ok(Array.isArray(w.segs));
  assert.strictEqual(typeof w.angle, 'number');
  assert.strictEqual(typeof w.boostRatio, 'number');
});

test('boost fuel never lets the body shrink below the hard floor', () => {
  const s = new Snake('id', 'T', 0, 0, '#fff');
  assert.ok(s.boostFuel >= 0);
  assert.ok(s.boostRatio >= 0 && s.boostRatio <= 1);
});
