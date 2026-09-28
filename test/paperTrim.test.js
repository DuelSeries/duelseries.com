'use strict';
// Territory trim (T5, design 9.4-9.6): the pure plan, the apply, vertex identity with the wall,
// the blocked and empty cases, sliding along a trimmed run, and a 300-blob fuzz.
const test = require('node:test');
const assert = require('node:assert');
const { makeArena, REASON, P, MP } = require('../server/paper/ArenaGame');
const trim = require('../server/paper/arenaTrim');

const C = 1000;
const at = (r, a) => new P.Vec2(C + Math.cos(a) * r, C + Math.sin(a) * r);

function arena(radius = 950) {
  const g = makeArena({ stake: 0.1, seed: 0.41 });
  g._target = radius;
  g.radiusTarget = function () { return this._target; };
  g.setRadiusNow(radius);
  return g;
}

function ringPts(base) {
  return base.polygon.segments.map(s => s.start);
}

function snapshot(base) {
  return ringPts(base).map(v => [v, v.x, v.y, v.segments.length]);
}

function gridHealthy(g) {
  const seen = new Map();
  for (const cell of g.space.cells) {
    for (const p of cell.points) {
      if (!p.segments.length) return 'orphan point in the grid';
      const key = p.x.toFixed(9) + ',' + p.y.toFixed(9);
      if (seen.has(key) && seen.get(key) !== p) return 'two registered points at ' + key;
      seen.set(key, p);
    }
  }
  return null;
}

// Replaces a unit's base with a ring of the given points (built in this arena's grid).
function giveBase(g, unit, pts) {
  g._enter();
  unit.track.remove();
  unit.base.remove();
  unit.base = new P.TerritoryBase(unit, pts.map(p => new P.Vec2(p.x, p.y)));
  unit.base.wireVer = 1;
  unit.in = unit.base;
  unit.lastSquare = unit.base.square;
}

function lensArea(r, R, d) {
  const a = r * r * Math.acos((d * d + r * r - R * R) / (2 * d * r));
  const b = R * R * Math.acos((d * d + R * R - r * r) / (2 * d * R));
  const c = 0.5 * Math.sqrt((-d + r + R) * (d + r - R) * (d - r + R) * (d + r + R));
  return a + b - c;
}

test('a clean base is untouched and planTrim is pure', () => {
  const g = arena();
  const h = g.spawnHuman({ name: 'c' }, at(300, 0.7));
  const before = snapshot(h.base);
  assert.strictEqual(trim.planTrim(h.base, g.border).status, 'clean');
  assert.deepStrictEqual(snapshot(h.base), before);
});

test('a circle base straddling the wall keeps the analytic lens area; identity and wall objects hold', () => {
  const g = arena(950);
  const h = g.spawnHuman({ name: 'lens' }, at(900, 0.4 + 0.5 * (Math.PI * 2 / 300)));
  const verts0 = ringPts(h.base);
  const before = snapshot(h.base);
  g.setRadiusNow(910);
  const plan = trim.planTrim(h.base, g.border);
  assert.deepStrictEqual(snapshot(h.base), before, 'planTrim mutates nothing');
  assert.strictEqual(plan.status, 'ok');
  assert.strictEqual(plan.droppedLobe, false);
  const wallObjs = new Set(g.border.polygon.segments.map(s => s.start));
  const old = new Set(verts0);
  for (const p of plan.keep) {
    const onWallVertex = [...wallObjs].some(w => Math.abs(w.x - p.x) < 1e-9 && Math.abs(w.y - p.y) < 1e-9);
    if (onWallVertex) assert.ok(wallObjs.has(p), 'a wall vertex in keep is the border object');
    if (old.has(p)) assert.ok(MP.wallInside(g.border, p.x, p.y), 'kept original vertices are inside');
  }
  const inside0 = verts0.filter(v => MP.wallInside(g.border, v.x, v.y));
  for (const v of inside0) assert.ok(plan.keep.includes(v), 'every inside vertex is kept as the same object');
  g._enter();
  trim.applyTrim(g, h.base, plan);
  const want = lensArea(30, 910 * Math.cos(Math.PI / 300), 900);
  assert.ok(Math.abs(h.base.square - want) / want < 0.005, `lens ${h.base.square} vs ${want}`);
  assert.strictEqual(trim.checkRing(h.base), null);
  assert.strictEqual(gridHealthy(g), null);
  assert.strictEqual(trim.planTrim(h.base, g.border).status, 'clean', 'a second call is clean');
  for (let i = 0; i < plan.keep.length; i++) {
    const a = plan.keep[i];
    const b = plan.keep[(i + 1) % plan.keep.length];
    assert.ok(Math.hypot(b.x - a.x, b.y - a.y) <= 20, 'no edge over 20 u');
  }
});

test('a run wrapping ring index 0, then a capture after the trim carves without throwing', () => {
  const g = arena(950);
  // Vertex 0 of a spawn circle is at angle 0 from its centre: put the base on the east axis side.
  const h = g.spawnHuman({ name: 'wrap' }, at(905, 0.05));
  g.setRadiusNow(912);
  const plan = trim.planTrim(h.base, g.border);
  assert.strictEqual(plan.status, 'ok');
  g._enter();
  trim.applyTrim(g, h.base, plan);
  assert.strictEqual(trim.checkRing(h.base), null);
  const sq = h.base.square;
  // Leave inward and come back: a capture on the trimmed ring.
  let seq = 0;
  const go = (byte, n) => { for (let i = 0; i < n; i++) { g.setInput(h.id, (++seq) & 255, byte, false, 0); g.update(MP.STEP_MS); } };
  go(MP.angleToByte(Math.PI + 0.05), 30);
  go(MP.angleToByte(Math.PI + 0.05 + Math.PI / 2), 20);
  const home = at(905, 0.05);
  for (let i = 0; i < 300 && h.in !== h.base && !h.death; i++) {
    go(MP.angleToByte(Math.atan2(home.y - h.position.y, home.x - h.position.x)), 1);
  }
  assert.ok(!h.death);
  assert.ok(h.in === h.base && h.base.square > sq, 'captured more land');
  assert.strictEqual(trim.checkRing(h.base), null);
  assert.strictEqual(gridHealthy(g), null);
});

test('a concave U keeps the anchor prong and drops the other lobe', () => {
  const g = arena(950);
  const h = g.spawnHuman({ name: 'u' }, at(600, 1.0));
  const R = 950;
  // Local frame on the east wall: x outward, y along the wall. Prongs inside, bar outside.
  const local = [];
  const add = (x, y) => local.push({ x: C + x, y: C + y });
  for (let y = -40; y <= 40; y += 5) add(R + 10, y); // outer bar edge (outside), going +y
  for (let x = R + 10; x >= R - 30; x -= 5) add(x, 40); // prong B outer side, inward
  for (let y = 40; y >= 20; y -= 5) add(R - 30, y); // prong B tip
  for (let x = R - 30; x <= R + 2; x += 4) add(x, 20); // prong B inner side, outward
  for (let y = 20; y >= -20; y -= 5) add(R + 2, y); // inner bar (outside)
  for (let x = R + 2; x >= R - 30; x -= 4) add(x, -20); // prong A inner side, inward
  for (let y = -20; y >= -40; y -= 5) add(R - 30, y); // prong A tip
  for (let x = R - 30; x <= R + 10; x += 5) add(x, -40); // prong A outer side, outward
  const pts = [];
  for (const p of local) if (!pts.length || pts[pts.length - 1].x !== p.x || pts[pts.length - 1].y !== p.y) pts.push(p);
  if (pts[0].x === pts[pts.length - 1].x && pts[0].y === pts[pts.length - 1].y) pts.pop();
  if (trim.signedArea(pts) < 0) pts.reverse();
  giveBase(g, h, pts);
  h.position = new P.Vec2(C + R - 20, C - 30); // inside prong A
  const areaBefore = h.base.square;
  const verBefore = h.base.wireVer;
  const plan = trim.planTrim(h.base, g.border);
  assert.strictEqual(plan.status, 'ok');
  assert.strictEqual(plan.droppedLobe, true);
  g._enter();
  trim.applyTrim(g, h.base, plan);
  assert.strictEqual(trim.checkRing(h.base), null);
  assert.ok(h.base.polygon.inside(h.position), 'the anchor prong is kept');
  assert.ok(!h.base.polygon.inside(new P.Vec2(C + R - 20, C + 30)), 'the other prong is gone');
  const prong = (R * Math.cos(Math.PI / 300) - (R - 30)) * 20;
  assert.ok(Math.abs(h.base.square - prong) / prong < 0.02, `kept ${h.base.square} vs ${prong} (was ${areaBefore})`);
  assert.strictEqual(h.base.wireVer, verBefore + 1, 'a dropped lobe re-sends the ring');
  assert.strictEqual(gridHealthy(g), null);
});

test('a base owning the whole disc becomes the wall itself, made of the border objects', () => {
  const g = arena(950);
  const h = g.spawnHuman({ name: 'all' }, at(100, 0.3));
  giveBase(g, h, P.makeCirclePoints(new P.Vec2(C, C), 400, 965));
  h.position = new P.Vec2(C + 100, C + 30);
  g.setRadiusNow(900);
  const plan = trim.planTrim(h.base, g.border);
  assert.strictEqual(plan.status, 'wall');
  const wallObjs = g.border.polygon.segments.map(s => s.start);
  assert.strictEqual(plan.keep.length, 300);
  for (const p of plan.keep) assert.ok(wallObjs.includes(p));
  g._enter();
  trim.applyTrim(g, h.base, plan);
  assert.strictEqual(trim.checkRing(h.base), null);
  assert.ok(Math.abs(h.base.square - g.border.polygon.square()) < 1e-6);
  assert.strictEqual(gridHealthy(g), null);
});

test('blocked: an away owner whose exit vertex would go, and a foreign trail on a dropped vertex', () => {
  const g = arena(950);
  const h = g.spawnHuman({ name: 'away' }, at(900, 1.3));
  let seq = 0;
  for (let i = 0; i < 24; i++) { g.setInput(h.id, (++seq) & 255, MP.angleToByte(1.3), false, 0); g.update(MP.STEP_MS); }
  assert.ok(h.in !== h.base && h.track.polyline.start, 'left home outward');
  h.locked = true;
  g.setRadiusNow(912);
  const before = snapshot(h.base);
  assert.strictEqual(trim.planTrim(h.base, g.border).status, 'blocked');
  assert.deepStrictEqual(snapshot(h.base), before);

  const g2 = arena(950);
  const a = g2.spawnHuman({ name: 'a' }, at(900, 2.0));
  const b = g2.spawnHuman({ name: 'b' }, at(700, 2.0));
  g2.setRadiusNow(912);
  const outer = ringPts(a.base).find(v => !MP.wallInside(g2.border, v.x, v.y));
  g2._enter();
  b.in = null;
  b.track.add(new P.Vec2(outer.x - 40, outer.y + 3));
  b.track.add(outer); // a foreign trail through a vertex the trim would drop
  b.track.add(new P.Vec2(outer.x - 30, outer.y - 20));
  assert.strictEqual(trim.planTrim(a.base, g2.border).status, 'blocked');
});

test('blocked: a foreign trail across the new wall-run edge (crossesTrail)', () => {
  const g = arena(950);
  const a = g.spawnHuman({ name: 'a' }, at(900, 2.0));
  const b = g.spawnHuman({ name: 'b' }, at(700, 2.0));
  g.setRadiusNow(912);
  assert.strictEqual(trim.planTrim(a.base, g.border).status, 'ok', 'no trail: the trim goes through');
  g._enter();
  b.in = null;
  b.track.add(at(905, 2.0));
  b.track.add(at(925, 2.0)); // across the wall run the trim would lay, touching no ring vertex
  const before = snapshot(a.base);
  const plan = trim.planTrim(a.base, g.border);
  assert.strictEqual(plan.status, 'blocked');
  assert.strictEqual(plan.why, 'trail crosses a new edge');
  assert.deepStrictEqual(snapshot(a.base), before);
});

test('empty: a base wholly outside the new wall', () => {
  const g = arena(950);
  const h = g.spawnHuman({ name: 'out' }, at(900, 2.6));
  g.setRadiusNow(860);
  assert.strictEqual(trim.planTrim(h.base, g.border).status, 'empty');
});

test('trimBase through the arena: trimmed, then reseat for an empty base', () => {
  const g = arena(950);
  g.trim = trim;
  const h = g.spawnHuman({ name: 't' }, at(900, 4.0));
  const k = g.spawnHuman({ name: 'k' }, at(200, 1.0));
  h.locked = true;
  k.locked = true;
  g._target = 905;
  for (let i = 0; i < 1000 && (g.shrinking || g.border.radius > 905); i++) g.update(MP.STEP_MS);
  assert.strictEqual(g.border.radius, 905);
  g.update(MP.STEP_MS);
  assert.strictEqual(trim.checkRing(h.base), null);
  assert.ok(ringPts(h.base).every(v => MP.wallInside(g.border, v.x, v.y) || Math.abs(Math.hypot(v.x - C, v.y - C) - 905) < 0.01), 'no land left outside');
  g.setRadiusNow(850);
  h.base._trimDirty = true;
  const oldBase = h.base;
  g.update(MP.STEP_MS);
  assert.notStrictEqual(h.base, oldBase, 'reseated on a fresh base');
  assert.ok(!h.death, 'a reseat is not a death');
  assert.strictEqual(gridHealthy(g), null);
});

// A square slides along the wall through a neighbour's trimmed run: the wall vertices it hands
// its trail must be the very objects in the trimmed ring (else unifyHitPoints throws).
for (const dir of [1, -1]) {
  test('sliding along a trimmed wall run, direction ' + dir + ', then after growing back', () => {
    const g = arena(950);
    const owner = g.spawnHuman({ name: 'owner' }, at(905, 3.0));
    owner.locked = true;
    g.setRadiusNow(915);
    g._enter();
    trim.applyTrim(g, owner.base, trim.planTrim(owner.base, g.border));
    assert.strictEqual(trim.checkRing(owner.base), null);
    const slider = g.spawnHuman({ name: 'slider' }, at(820, 3.0 - dir * 0.25));
    let seq = 0;
    for (let round = 0; round < 2; round++) {
      for (let t = 0; t < 300 && !slider.death; t++) {
        const ang = Math.atan2(slider.position.y - C, slider.position.x - C);
        const r = Math.hypot(slider.position.x - C, slider.position.y - C);
        const heading = ang + dir * (Math.PI / 2 - (r < g.border.radius - 2 ? 0.6 : 0.15));
        g.setInput(slider.id, (++seq) & 255, MP.angleToByte(heading), false, 0);
        g.update(MP.STEP_MS); // a throw here fails the test
      }
      const ring = new Set(ringPts(owner.base));
      const ringAt = new Map([...ring].map(v => [v.x.toFixed(9) + ',' + v.y.toFixed(9), v]));
      if (!slider.death) {
        const trailPts = [slider.track.polyline.start].concat(slider.track.polyline.segments.map(s => s.end)).filter(Boolean);
        for (const v of trailPts) {
          const twin = ringAt.get(v.x.toFixed(9) + ',' + v.y.toFixed(9));
          if (twin) assert.strictEqual(twin, v, 'a shared corner is one object');
        }
      }
      assert.strictEqual(gridHealthy(g), null);
      g.setRadiusNow(950); // grow back, then slide again at the old radius
      if (slider.death) break;
    }
  });
}

// A ring vertex exactly on the wall with both ring neighbours inside is a lone touch, not a
// wall run: with a real bump outside elsewhere the trim must still go through (review probe:
// it once failed 'wall walk met an exit' every tick until the retry limit gave up).
for (const mode of ['edge midpoint', 'wall vertex']) {
  for (const order of [1, -1]) {
    test('a lone on-wall vertex plus a bump outside trims cleanly (' + mode + ', order ' + order + ')', () => {
      const g = arena(950);
      const h = g.spawnHuman({ name: 'w' }, at(700, 0.5));
      const ws = g.border.polygon.segments;
      const a = ws[10].start;
      const b = ws[10].end;
      const q = mode === 'wall vertex' ? { x: a.x, y: a.y } : { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const ang = Math.atan2(q.y - C, q.x - C);
      const d = 10 / 950;
      let pts = [q];
      for (let t = 1; t <= 3; t++) pts.push(at(940, ang + t * d));
      for (let t = 4; t <= 8; t++) pts.push(at(960, ang + t * d));
      for (let t = 9; t <= 11; t++) pts.push(at(940, ang + t * d));
      for (let t = 11; t >= -3; t--) pts.push(at(925, ang + t * d));
      for (let t = -3; t <= -1; t++) pts.push(at(940, ang + t * d));
      if (order < 0) pts = pts.reverse();
      giveBase(g, h, pts);
      h.position = at(932, ang + 5 * d);
      const touch = ringPts(h.base).find(v => v.x === q.x && v.y === q.y);
      assert.ok(touch, 'the touch vertex is in the ring');
      const sq0 = h.base.square;
      const plan = trim.planTrim(h.base, g.border);
      assert.strictEqual(plan.status, 'ok', 'plan ' + plan.why);
      assert.ok(plan.keep.includes(touch), 'the lone touch vertex is kept');
      assert.strictEqual(trim.trimBase(g, h), 'trimmed');
      assert.strictEqual(trim.checkRing(h.base), null);
      assert.ok(h.base.square < sq0 - 300 && h.base.square > sq0 - 600, 'the bump went: ' + sq0 + ' -> ' + h.base.square);
      assert.strictEqual(trim.planTrim(h.base, g.border).status, 'clean', 'second call');
      assert.strictEqual(gridHealthy(g), null);
    });
  }
}

test('fuzz: 300 random blobs at random radii, zero throws, every applied ring checks', () => {
  let s = 99;
  const rand = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; };
  const g = arena(950);
  const counts = {};
  for (let i = 0; i < 300; i++) {
    const R = 700 + rand() * 250;
    g.setRadiusNow(950);
    const ang = rand() * Math.PI * 2;
    const r0pre = 20 + rand() * 50;
    const d = Math.min(R - 80 + rand() * 120, 985 - r0pre * 1.6);
    const cx = C + Math.cos(ang) * d;
    const cy = C + Math.sin(ang) * d;
    const r0 = r0pre;
    const a1 = rand() * 0.3, a2 = rand() * 0.25, p1 = rand() * 6.3, p2 = rand() * 6.3;
    const n = Math.max(12, Math.min(200, Math.ceil((2 * Math.PI * r0 * 1.4) / 7)));
    const pts = [];
    for (let k = 0; k < n; k++) {
      const th = (k / n) * Math.PI * 2;
      const rr = r0 * (1 + a1 * Math.sin(2 * th + p1) + a2 * Math.sin(3 * th + p2));
      pts.push({ x: cx + Math.cos(th) * rr, y: cy + Math.sin(th) * rr });
    }
    const h = g.spawnHuman({ name: 'f' + i }, at(100, 0.5));
    giveBase(g, h, pts);
    h.position = new P.Vec2(cx + 0.3, cy + 0.2);
    g.setRadiusNow(R);
    const plan = trim.planTrim(h.base, g.border);
    counts[plan.status] = (counts[plan.status] || 0) + 1;
    if (plan.status === 'ok' || plan.status === 'wall') {
      g._enter();
      trim.applyTrim(g, h.base, plan);
      assert.strictEqual(trim.checkRing(h.base), null, 'blob ' + i);
      assert.strictEqual(trim.planTrim(h.base, g.border).status, 'clean', 'blob ' + i + ' second call');
    }
    g.removeHuman(h.id, REASON.LEAVE);
  }
  assert.strictEqual(gridHealthy(g), null);
  console.log('# fuzz statuses ' + JSON.stringify(counts));
  assert.ok((counts.ok || 0) > 100, 'most blobs straddle the wall');
});
