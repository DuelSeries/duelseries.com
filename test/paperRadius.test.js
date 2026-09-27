'use strict';
// Arena radius (T4, design 9.1): grows at once, shrinks only after a delay and slowly, moves in
// quanta, keeps game.square in step, and re-sends touched rings once when a shrink ends.
const test = require('node:test');
const assert = require('node:assert');
const { makeArena, REASON, P, MP } = require('../server/paper/ArenaGame');

const C = 1000;
const at = (r, a) => new P.Vec2(C + Math.cos(a) * r, C + Math.sin(a) * r);

function paidWith(n, ring = 150) {
  const g = makeArena({ stake: 0.1, seed: 0.25 });
  const humans = [];
  for (let i = 0; i < n; i++) {
    const h = g.spawnHuman({ name: 'h' + i }, at(ring, 0.3 + (i * Math.PI * 2) / n));
    h.locked = true;
    humans.push(h);
  }
  return { g, humans };
}

function tick(g, n = 1) {
  for (let i = 0; i < n; i++) g.update(MP.STEP_MS);
}

function squareMatches(g) {
  return Math.abs(g.square - g.border.polygon.square()) < 1e-6;
}

test('growth starts at once at 60 u/s, in 0.5 u quanta, and lands exactly on the target', () => {
  const { g } = paidWith(8);
  assert.strictEqual(g.border.radius, MP.R_MIN, 'a paid arena opens at R_MIN');
  const target = MP.radiusFor(8);
  tick(g);
  assert.strictEqual(g.targetRadius, target);
  assert.ok(Math.abs(g.rCont - (MP.R_MIN + 1)) < 1e-9, 'one tick = GROW_RATE * STEP_MS = 1 u');
  const seen = [g.border.radius];
  for (let i = 0; i < 59; i++) {
    tick(g);
    if (g.border.radius !== seen[seen.length - 1]) seen.push(g.border.radius);
    assert.ok(squareMatches(g));
  }
  assert.ok(Math.abs(g.border.radius - (MP.R_MIN + 60)) <= 0.5, 'after a second: ' + g.border.radius);
  for (let i = 1; i < seen.length; i++) {
    const d = seen[i] - seen[i - 1];
    assert.ok(d > 0 && Math.abs(d / MP.RADIUS_QUANTUM - Math.round(d / MP.RADIUS_QUANTUM)) < 1e-9, 'quantum step ' + d);
  }
  tick(g, 200);
  assert.strictEqual(g.border.radius, target);
  assert.ok(squareMatches(g));
});

test('shrink waits SHRINK_DELAY_MS, then runs at 4 u/s in 0.5 u quanta', () => {
  const { g, humans } = paidWith(8);
  tick(g, 250);
  const top = MP.radiusFor(8);
  assert.strictEqual(g.border.radius, top);
  for (let i = 0; i < 4; i++) g.removeHuman(humans[i].id, REASON.LEAVE);
  const delayTicks = Math.ceil(MP.SHRINK_DELAY_MS / MP.STEP_MS);
  tick(g, delayTicks - 1);
  assert.strictEqual(g.border.radius, top, 'nothing moves inside the delay');
  assert.strictEqual(g.shrinking, false);
  let prev = g.border.radius;
  let quanta = 0;
  for (let i = 0; i < 600; i++) {
    tick(g);
    if (g.border.radius !== prev) {
      assert.ok(Math.abs(prev - g.border.radius - MP.RADIUS_QUANTUM) < 1e-9, 'one quantum at a time');
      prev = g.border.radius;
      quanta++;
    }
    assert.ok(squareMatches(g));
  }
  assert.ok(g.shrinking);
  const expected = top - (600 * MP.SHRINK_RATE * MP.STEP_MS) / 1000; // 40 u in 10 s
  assert.ok(Math.abs(g.border.radius - expected) <= MP.RADIUS_QUANTUM, 'radius ' + g.border.radius + ' vs ' + expected);
  assert.ok(quanta >= 79 && quanta <= 81, 'quanta ' + quanta);
});

test('a re-buy inside the delay cancels the shrink', () => {
  const { g, humans } = paidWith(8);
  tick(g, 250);
  const top = g.border.radius;
  g.removeHuman(humans[0].id, REASON.LEAVE);
  tick(g, 100);
  const back = g.spawnHuman({ name: 'again' }, humans[0].position.clone());
  back.locked = true;
  for (let i = 0; i < 400; i++) {
    tick(g);
    assert.strictEqual(g.border.radius, top);
    assert.strictEqual(g.shrinking, false);
  }
});

test('shrink end bumps wireVer once on every wall-touched base and clears the flag', () => {
  const g = makeArena({ stake: 0.1, seed: 0.26 });
  const inner = [];
  for (let i = 0; i < 4; i++) {
    const h = g.spawnHuman({ name: 'in' + i }, at(150, 0.3 + (i * Math.PI) / 2));
    h.locked = true;
    inner.push(h);
  }
  const edge = g.spawnHuman({ name: 'edge' }, at(440, 0.3 + Math.PI / 4));
  edge.locked = true;
  tick(g, 200);
  assert.strictEqual(g.border.radius, MP.radiusFor(5));
  const before = new Map(g.units.map(u => [u, u.base.wireVer]));
  g.removeHuman(inner[0].id, REASON.LEAVE);
  let sawTouched = false;
  let t = 0;
  do {
    tick(g);
    if (edge.base._wallTouched) sawTouched = true;
    if (g.shrinking) assert.strictEqual(edge.base.wireVer, before.get(edge), 'no re-send during the shrink');
  } while ((g.shrinking || g.border.radius > MP.R_MIN) && t++ < 2000);
  assert.strictEqual(g.border.radius, MP.R_MIN);
  assert.ok(sawTouched, 'the edge base was touched by the moving wall');
  assert.strictEqual(edge.base.wireVer, before.get(edge) + 1);
  assert.strictEqual(edge.base._wallTouched, false);
  for (const h of inner.slice(1)) {
    assert.strictEqual(h.base.wireVer, before.get(h), h.name + ' untouched');
    assert.ok(!h.base._wallTouched);
  }
  tick(g, 300);
  assert.strictEqual(edge.base.wireVer, before.get(edge) + 1, 'never re-sent twice for one shrink');
});

test('the free arena keeps R_MAX whatever the head count', () => {
  const g = makeArena({ stake: 0, seed: 0.27 });
  tick(g, 300);
  assert.strictEqual(g.border.radius, MP.R_MAX);
  const h = g.spawnHuman({ name: 'f' });
  tick(g, 300);
  g.removeHuman(h.id, REASON.LEAVE);
  tick(g, 400);
  assert.strictEqual(g.border.radius, MP.R_MAX);
  assert.strictEqual(g.shrinking, false);
});
