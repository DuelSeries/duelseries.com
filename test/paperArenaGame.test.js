'use strict';
// ArenaGame (T4, design section 4 and 9.3): the stock Paper sim run by the server with
// humans, prey-wrapped bots, the push and its veto, and no edit to any solo file.
const test = require('node:test');
const assert = require('node:assert');
const { makeArena, REASON, P, MP, flatReturn } = require('../server/paper/ArenaGame');

const C = 1000;

function at(r, a) {
  return new P.Vec2(C + Math.cos(a) * r, C + Math.sin(a) * r);
}

// A paid arena (no bots) with its wall held at `radius` until the test moves the target.
function wideArena(radius = 950) {
  const g = makeArena({ stake: 0.1, seed: 0.3 });
  g._target = radius;
  g.radiusTarget = function () { return this._target; };
  g.setRadiusNow(radius);
  return g;
}

let seqs = new Map();
function steer(g, h, angleByte, hold = false) {
  const s = ((seqs.get(h) || 0) + 1) & 255;
  seqs.set(h, s);
  g.setInput(h.id, s, angleByte, hold, g.nowMs);
}

function tick(g, n = 1) {
  for (let i = 0; i < n; i++) g.update(MP.STEP_MS);
}

function trailIsSimple(unit) {
  const segs = unit.track.polyline.segments;
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 2; j < segs.length; j++) {
      const hit = segs[i].intersect(segs[j]);
      if (hit) return { i, j, point: hit.point };
    }
  }
  return null;
}

test('two humans steer from their own bytes', () => {
  const g = wideArena();
  const a = g.spawnHuman({ name: 'a' }, at(300, 2.5));
  const b = g.spawnHuman({ name: 'b' }, at(300, -0.7));
  const a0 = a.position.clone();
  const b0 = b.position.clone();
  for (let i = 0; i < 150; i++) {
    steer(g, a, 0); // east
    steer(g, b, 127); // west: a U-turn at the turn cap first
    tick(g);
  }
  assert.ok(!a.death && !b.death);
  assert.ok(a.position.x - a0.x > 100, 'a went east');
  assert.ok(b0.x - b.position.x > 100, 'b went west');
  assert.ok(Math.abs(MP.wrapAngle(a.direction)) < 0.02 || Math.abs(MP.wrapAngle(a.direction) - Math.PI * 2) < 0.02);
  assert.ok(Math.abs(MP.wrapAngle(b.direction) - Math.PI) < 0.02);
  assert.strictEqual(a.seqAck, seqs.get(a));
});

test('a locked square does not move at all', () => {
  const g = wideArena();
  const h = g.spawnHuman({ name: 'h' }, at(200, 1.1));
  tick(g, 5);
  h.locked = true;
  const p = h.position.clone();
  for (let i = 0; i < 120; i++) { steer(g, h, 40); tick(g); }
  assert.strictEqual(h.position.distance(p).toFixed(3), '0.000');
  h.locked = false;
  tick(g, 10);
  assert.ok(h.position.distance(p) > 10, 'unlocking restores steering');
});

test('two interleaved arenas keep separate grids', () => {
  const A = wideArena();
  const B = wideArena();
  const ha = A.spawnHuman({ name: 'a' }, at(200, 0.4));
  const hb = B.spawnHuman({ name: 'b' }, at(200, 2.4));
  tick(A, 30);
  const countA = A.space.count();
  for (let i = 0; i < 200; i++) { steer(B, hb, (i >> 3) & 255); tick(B); }
  assert.strictEqual(A.space.count(), countA, 'B never touched A\'s grid');
  const countB = B.space.count();
  for (let i = 0; i < 100; i++) { steer(A, ha, 200); tick(A); steer(B, hb, 10); tick(B); }
  assert.ok(!ha.death && !hb.death);
  assert.notStrictEqual(A.space.count(), countA);
  assert.notStrictEqual(B.space.count(), countB);
  assert.strictEqual(A.space.count(), A.space.cells.reduce((n, c) => n + c.points.length, 0));
});

test('exact-east from y = 1000 never hangs, and the push puts the square back inside', { timeout: 30000 }, () => {
  // Pressing exactly east into wall vertex 0 from 40 step phases: the stock slide loop would
  // hang or escape for some of them; the guard caps it. Death by the stock wall rule is allowed.
  let trips = 0;
  for (let k = 0; k < 40; k++) {
    const g = wideArena();
    const h = g.spawnHuman({ name: 'e' + k }, new P.Vec2(1880 + k * 0.0373, 1000));
    for (let i = 0; i < 90 && !h.death; i++) {
      steer(g, h, 0);
      tick(g);
      if (!h.death && h._pushedTick === g.tick) assert.ok(MP.wallInside(g.border, h.position.x, h.position.y));
    }
    trips += g.border.guardTrips;
  }
  console.log('# exact-east phases: guard trips ' + trips);
  // A square held on the axis at the wall is pushed in by a shrink, off the axis and inside.
  const g = wideArena();
  const h = g.spawnHuman({ name: 'axis' }, new P.Vec2(1880, 1000));
  for (let i = 0; i < 200 && h.position.x < 1948; i++) { steer(g, h, 0); tick(g); }
  assert.ok(!h.death && h.position.x >= 1948, 'at the wall: ' + h.position.x);
  h.locked = true;
  g._target = 900;
  let pushes = 0;
  for (let i = 0; i < 1200; i++) {
    tick(g);
    assert.ok(!h.death);
    if (h._pushedTick === g.tick) {
      pushes++;
      assert.ok(MP.wallInside(g.border, h.position.x, h.position.y), 'inside on the tick of the push, tick ' + g.tick);
    }
  }
  assert.ok(pushes > 10, 'pushed ' + pushes + ' times');
  assert.strictEqual(g.stats.pushCrossings, 0);
});

test('unit.log stays empty', () => {
  const g = makeArena({ stake: 0, seed: 0.5 });
  tick(g, 60);
  const h = g.spawnHuman({ name: 'x' });
  tick(g, 60);
  assert.ok(g.units.length > 5);
  for (const u of g.units) assert.strictEqual(u.log.length, 0);
  assert.ok(!h.death);
});

test('free arena: never more than 15 bots or 16 squares, no bot without a type', () => {
  const g = makeArena({ stake: 0, seed: 0.77 });
  const check = () => {
    const bots = g.units.filter(u => u instanceof P.BotUnit);
    assert.ok(bots.length <= 15, 'bots ' + bots.length);
    assert.ok(g.units.length <= 16, 'squares ' + g.units.length);
    for (const b of bots) assert.ok(b.type !== undefined && b.type >= 0 && b.type <= 3, 'type ' + b.type);
  };
  for (let i = 0; i < 900; i++) { tick(g); check(); }
  assert.strictEqual(g.units.length, 15);
  const humans = [g.spawnHuman({ name: 'h1' })];
  for (let i = 0; i < 300; i++) { tick(g); check(); }
  humans.push(g.spawnHuman({ name: 'h2' }));
  g.removeLowestBot();
  for (let i = 0; i < 300; i++) { tick(g); check(); }
  assert.ok(g.units.length <= 16);
});

test('bot level follows the leading live human, else the no-player level', () => {
  const g = makeArena({ stake: 0, seed: 0.9 });
  tick(g, 30);
  const a = g.spawnHuman({ name: 'a' });
  tick(g, 2);
  const p = a.percent;
  tick(g);
  assert.ok(Math.abs(g.level - P.lerp(g.config.startBotLevel, 1, p)) < 1e-9);
  const b = g.spawnHuman({ name: 'b' });
  tick(g);
  b.percent = 0.2;
  a.percent = 0.05;
  tick(g);
  assert.ok(Math.abs(g.level - P.lerp(0.1, 1, 0.2)) < 1e-9, 'strongest human leads: ' + g.level);
  g.removeHuman(a.id, REASON.LEAVE);
  g.removeHuman(b.id, REASON.LEAVE);
  tick(g);
  assert.strictEqual(g.level, g.config.noPlayerBotLevel);
});

test('the spawn row follows the level: type 1 then type 2 (row 0), not type 1 again (row 2)', () => {
  const g = makeArena({ stake: 0, seed: 0.12 });
  tick(g, 60);
  g.spawnHuman({ name: 'a' });
  while (g.removeLowestBot()) { /* empty the arena of bots */ }
  g.botSpawnLimited = true;
  g.spawnSuspend = 1e12;
  tick(g);
  assert.strictEqual(Math.round(g.level * 3), 0, 'level ' + g.level);
  g.botSpawnLimited = false;
  const spawnOne = () => {
    const n = g.units.length;
    for (let i = 0; i < 500 && g.units.length === n; i++) g.spawnBot('random');
    assert.strictEqual(g.units.length, n + 1);
    return g.units[g.units.length - 1];
  };
  assert.strictEqual(spawnOne().type, 1);
  assert.strictEqual(spawnOne().type, 2);
});

test('spawnBot is inert in a paid arena', () => {
  const g = makeArena({ stake: 1, seed: 0.2 });
  for (let i = 0; i < 100; i++) g.spawnBot('random');
  assert.strictEqual(g.units.length, 0);
  g.spawnHuman({ name: 'p' });
  tick(g, 200);
  assert.ok(g.units.every(u => u.isHuman));
  assert.strictEqual(g.config.botsCount, 0);
});

test('the magnet path: a far long human trail pulls the nearest bot into attack', () => {
  const g = makeArena({ stake: 0, seed: 0.33 });
  tick(g, 300);
  g.botSpawnLimited = true;
  g.spawnSuspend = 1e12;
  while (g.units.filter(u => u instanceof P.BotUnit).length > 1) g.removeLowestBot();
  const bot = g.units.find(u => u instanceof P.BotUnit);
  assert.ok(bot);
  const away = new P.Vec2(C, C).sub(bot.position);
  if (away.magnitude() < 1) away.set(1, 0.3);
  away.normalize();
  const s = new P.Vec2(C + away.x * 450 + 0.7, C + away.y * 450 + 0.9);
  const h = g.spawnHuman({ name: 'long' }, s);
  h.locked = true;
  // A 1680 u serpentine that ends at the human, all of it far from the bot.
  g._enter();
  const side = new P.Vec2(-away.y, away.x);
  const pts = [];
  for (let row = 4; row >= 0; row--) {
    const off = 60 + row * 20;
    const a = s.clone().add(away.clone().mulScalar(off)).add(side.clone().mulScalar(-160));
    const b = s.clone().add(away.clone().mulScalar(off)).add(side.clone().mulScalar(160));
    if (row % 2) pts.push(a, b); else pts.push(b, a);
  }
  h.in = null;
  for (const p of pts) h.track.add(p);
  h.track.add(h.position);
  assert.ok(h.track.length > g.config.botAttackTrackLength, 'trail ' + h.track.length);
  const reach = Math.max(bot.visionRange, h.visionRange) * bot.aggro * 0.75;
  for (const p of h.track.simplified) assert.ok(bot.position.distance(p) > reach + 50, 'trail is out of aggro range');
  g._prey = h;
  assert.ok(!P.isPlayerTrackInAggroRange(bot));
  g._prey = null;
  tick(g);
  assert.strictEqual(bot.fsm.state, 'attack');
  assert.ok(h.track.simplified.includes(bot.target), 'target is a vertex of the human trail');
  tick(g);
  assert.strictEqual(bot.fsm.state, 'attack');
  assert.ok(!h.death);
});

test('onDeath once per victim; killers only for reasons 3, 4, 5', () => {
  const got = [];
  const g = makeArena({ stake: 0.1, seed: 0.4, hooks: { onDeath: (v, k, r, pos) => got.push({ v, k, r, pos }) } });
  g.radiusTarget = () => 950;
  g.setRadiusNow(950);
  const hs = [];
  for (let i = 0; i < 7; i++) hs.push(g.spawnHuman({ name: 'h' + i }, at(500, 0.3 + i * 0.8)));
  const [k, v1, v2, v3, v4, v5, v6] = hs;
  g.kill(v1, k, REASON.ENCIRCLED);
  g.kill(v1, k, REASON.EXIT_POINT_CAPTURED); // the same capture can call kill twice
  g.kill(v2, k, REASON.EXIT_POINT_CAPTURED);
  g.kill(v3, k, REASON.TRACK_CUT);
  g.kill(v4, undefined, REASON.SELF_CROSS);
  g.kill(v5, undefined, REASON.WALL);
  g.removeHuman(v6.id, REASON.DISCONNECT);
  assert.deepStrictEqual(got.map(d => [d.v.name, d.k ? d.k.name : null, d.r]), [
    ['h1', 'h0', 5], ['h2', 'h0', 4], ['h3', 'h0', 3], ['h4', null, 1], ['h5', null, 2], ['h6', null, 8]
  ]);
  assert.ok(got.every(d => typeof d.pos.x === 'number'));
  assert.strictEqual(g.humans.length, 1);
  assert.strictEqual(g.byId.has(v1.id), false);
  // A system eviction never takes a human.
  g.kill(k, undefined, REASON.SYSTEM_REMOVED);
  assert.ok(!k.death);
});

test('findSpawn is bounded and never on an axis', () => {
  const g = makeArena({ stake: 0, seed: 0.61 });
  tick(g, 200);
  const t0 = Date.now();
  let found = 0;
  for (let i = 0; i < 300; i++) {
    const p = g.findSpawn();
    if (!p) continue;
    found++;
    assert.ok(Math.abs(p.x - C) >= MP.SPAWN_AXIS_GUARD && Math.abs(p.y - C) >= MP.SPAWN_AXIS_GUARD);
    assert.ok(p.distance(new P.Vec2(C, C)) <= 950 - 60);
  }
  assert.ok(found > 50, 'found ' + found);
  assert.ok(Date.now() - t0 < 3000);
  const paid = makeArena({ stake: 0.1, seed: 0.62 });
  for (let n = 0; n < 10; n++) {
    const p = paid.findSpawn();
    assert.ok(p, 'paid spawn ' + n);
    const limit = MP.radiusFor(Math.max(MP.N_BASE, paid.units.length + 1 - MP.SPAWN_SAFE_LOOKAHEAD)) - MP.SPAWN_SAFE_MARGIN;
    assert.ok(p.distance(new P.Vec2(C, C)) <= limit + 1e-9);
    paid.spawnHuman({ name: 'p' + n }, p);
    paid.setRadiusNow(MP.radiusFor(paid.units.length));
  }
});

test('70000 addUnit calls never hand out 0 or a live or reserved id', () => {
  const reserved = new Set([3, 70, 65535]);
  const g = makeArena({ stake: 0.1, seed: 0.1, hooks: { idReserved: (id) => reserved.has(id) } });
  const live = [];
  let wrapped = false;
  let prev = 0;
  for (let i = 0; i < 70000; i++) {
    const stub = {};
    g.addUnit(stub);
    const id = stub.id;
    assert.ok(Number.isInteger(id) && id >= 1 && id <= MP.UNIT_ID_MAX, 'id ' + id);
    assert.ok(!reserved.has(id));
    assert.ok(!live.some(u => u.id === id));
    if (id < prev) wrapped = true;
    prev = id;
    if (i % 1000 === 0 && live.length < 40) {
      live.push(stub);
    } else {
      g.units.splice(g.units.indexOf(stub), 1);
      g.byId.delete(id);
    }
  }
  assert.ok(wrapped, 'the counter wrapped');
  assert.strictEqual(live.length, 40);
});

test('the push-piece veto: reason 2 on the push piece rewinds, on a stock piece it kills', () => {
  const deaths = [];
  const g = wideArena();
  g.hooks.onDeath = (v, k, r) => deaths.push(r);
  const h = g.spawnHuman({ name: 'w' }, at(700, 1.0));
  for (let i = 0; i < 40; i++) { steer(g, h, MP.angleToByte(1.0)); tick(g); }
  assert.ok(h.in !== h.base && h.track.polyline.segments.length > 2, 'away with a trail');
  const segs = h.track.polyline.segments;
  const s = segs[1];
  g._enter();
  h.position = new P.Vec2((s.start.x + s.end.x) / 2, (s.start.y + s.end.y) / 2);
  h._inPush = true;
  g.kill(h, undefined, REASON.WALL);
  h._inPush = false;
  assert.ok(!h.death, 'vetoed');
  assert.strictEqual(deaths.length, 0);
  assert.strictEqual(h.track.polyline.segments.length, 2, 'cut back to the crossing');
  assert.ok(h.track.polyline.end.equal(h.position));
  assert.strictEqual(trailIsSimple(h), null);
  g.kill(h, undefined, REASON.WALL); // the same reason on a stock piece: the overlay U-turn death
  assert.ok(h.death);
  assert.deepStrictEqual(deaths, [REASON.WALL]);
});

test('rewindTrail keeps the trail simple and the crossing log and `in` consistent', () => {
  const g = wideArena();
  const other = g.spawnHuman({ name: 'o' }, at(400, 3.0));
  const h = g.spawnHuman({ name: 'h' }, at(400, 0.2));
  g._enter();
  h.in = null;
  h.track.remove();
  const pts = [new P.Vec2(1400, 1200), new P.Vec2(1450, 1200), new P.Vec2(1450, 1260), new P.Vec2(1400, 1260), new P.Vec2(1400, 1320), new P.Vec2(1480, 1320)];
  for (const p of pts) h.track.add(p);
  h.track.intersections = [
    { point: pts[1], intersections: [{ intersection: {}, base: other.base, enter: true }] },
    { point: pts[4], intersections: [{ intersection: {}, base: other.base, enter: false }] }
  ];
  h.position = new P.Vec2(1450, 1230); // on segment 1, as a stock crossing leaves it
  assert.strictEqual(g.rewindTrail(h), true);
  const got = [h.track.polyline.start].concat(h.track.polyline.segments.map(x => x.end)).map(p => [p.x, p.y]);
  assert.deepStrictEqual(got, [[1400, 1200], [1450, 1200], [1450, 1230]]);
  assert.strictEqual(trailIsSimple(h), null);
  assert.strictEqual(h.track.intersections.length, 1, 'the log entry past the cut is gone');
  assert.strictEqual(h.in, other.base, 'inside the base it entered and never left');
  assert.ok(Math.abs(h.track.length - 80) < 1e-9);
});

// The wall shrinks from 950 to 850 over 1500 ticks while one square presses straight out (a
// FIXED byte, as near an edge normal as the 254-step byte gets: a presser that re-aims every
// tick reverses its slide along the wall, which is the stock U-turn death even on a static
// wall) and another slides along it clockwise.
test('a wall-presser and a wall-slider survive 1500 shrink ticks inside the wall with simple trails', { timeout: 60000 }, () => {
  const deaths = [];
  const g = wideArena(950);
  g.hooks.onDeath = (v, k, r) => deaths.push([v.name, r]);
  const presser = g.spawnHuman({ name: 'presser' }, at(780, 167.5 * Math.PI * 2 / 300));
  const pressByte = MP.angleToByte(167.5 * Math.PI * 2 / 300); // behind the clockwise slider
  const slider = g.spawnHuman({ name: 'slider' }, at(780, 2.2));
  const sliderBase0 = slider.base.square;
  g._target = 850;
  const phi = (u) => Math.atan2(u.position.y - C, u.position.x - C);
  let onWall = false;
  for (let t = 0; t < 180 + 1500; t++) {
    steer(g, presser, pressByte);
    const toWall = g.border.radius - presser.position.distance(new P.Vec2(C, C));
    const bias = slider.position.distance(new P.Vec2(C, C)) < g.border.radius - 2 ? 0.6 : 0.15;
    steer(g, slider, MP.angleToByte(phi(slider) - Math.PI / 2 + bias));
    tick(g);
    assert.deepStrictEqual(deaths, [], 'tick ' + t);
    for (const u of [presser, slider]) {
      assert.ok(MP.wallInside(g.border, u.position.x, u.position.y), u.name + ' outside at tick ' + t);
    }
    if (toWall < 1) onWall = true;
  }
  assert.ok(onWall);
  assert.ok(g.border.radius <= 850.5, 'radius ' + g.border.radius);
  // A push whose three candidates all cross the trail (the presser's zigzag) goes ahead and
  // is vetoed with a rewind: counted here, never a death, and the trails stay simple.
  console.log('# pushCrossings ' + g.stats.pushCrossings + ', shrink vetoes ' + g.stats.shrinkVetoes);
  for (const u of [presser, slider]) assert.strictEqual(trailIsSimple(u), null, u.name + ' trail');
  assert.ok(slider.track.length > 1000, 'the slider really slid: ' + slider.track.length);

  // The slider heads home and captures. The wall is static again, so the presser stops pressing:
  // sliding along a static wall into its own old trail is the stock wall death, not the shrink.
  presser.locked = true;
  let home = false;
  for (let t = 0; t < 1500 && !home; t++) {
    const c = slider.base.polygon.segments[0].start;
    const bc = slider.base.polygon.bounds;
    const tx = (bc.left + bc.right) / 2;
    const ty = (bc.top + bc.bottom) / 2;
    steer(g, slider, MP.angleToByte(Math.atan2(ty - slider.position.y, tx - slider.position.x)));
    tick(g);
    assert.deepStrictEqual(deaths, []);
    if (slider.in === slider.base) home = true;
    void c;
  }
  assert.ok(home, 'slider returned');
  assert.ok(slider.base.square > sliderBase0 * 5, 'captured land: ' + slider.base.square);
  assert.ok(Math.abs(slider.base.square - slider.base.polygon.square()) < 1e-6 * slider.base.square);
});

test('steady tick with 16 squares', () => {
  const g = makeArena({ stake: 0, seed: 0.55 });
  tick(g, 600);
  g.spawnHuman({ name: 'h' });
  tick(g, 120);
  const t0 = process.hrtime.bigint();
  tick(g, 600);
  const perTick = Number(process.hrtime.bigint() - t0) / 1e6 / 600;
  console.log('# steady tick with ' + g.units.length + ' squares: ' + perTick.toFixed(3) + ' ms');
  assert.ok(perTick < 1, perTick + ' ms');
});

// The two capture fixes the default soak seeds never reach (review): each built directly.
function giveSquareBase(g, h, pts) {
  g._enter();
  h.track.remove();
  h.base.remove();
  h.base = new P.TerritoryBase(h, pts.map(p => new P.Vec2(p[0], p[1])));
  h.base.wireVer = 1;
  h.in = h.base;
  return h.base.polygon.segments.map(s => s.start);
}

function fakeTrail(pts) {
  return { start: pts[0], end: pts[pts.length - 1], segments: pts.slice(1).map(p => ({ end: p })) };
}

test('flatReturn: a trail home along the ring edge captures nothing and keeps the ring', () => {
  const g = wideArena();
  const h = g.spawnHuman({ name: 'flat' }, at(300, 1.0));
  const ring = giveSquareBase(g, h, [[600, 600], [700, 600], [700, 700], [600, 700]]);
  const flat = fakeTrail([ring[0], new P.Vec2(650, 600), new P.Vec2(700, 600), new P.Vec2(700, 650), ring[2]]);
  const bulge = fakeTrail([ring[0], new P.Vec2(650, 550), new P.Vec2(750, 650), ring[2]]);
  assert.strictEqual(flatReturn({ track: { polyline: flat }, base: h.base }), true);
  assert.strictEqual(flatReturn({ track: { polyline: bulge }, base: h.base }), false);
  const before = h.base.polygon.segments.map(s => [s.start, s.end]);
  const sq = h.base.square;
  const ver = h.base.wireVer;
  const r = g.handleReturn({ death: null, track: { polyline: flat }, base: h.base });
  assert.strictEqual(r, undefined);
  assert.strictEqual(g.stats.flatReturns, 1);
  assert.deepStrictEqual(h.base.polygon.segments.map(s => [s.start, s.end]), before);
  assert.strictEqual(h.base.square, sq);
  assert.strictEqual(h.base._trimDirty, true);
  assert.strictEqual(h.base.wireVer, ver + 1);
});

test('_despike: a zero-width spike tip is dropped with no area change', () => {
  const g = wideArena();
  const h = g.spawnHuman({ name: 'spike' }, at(300, 1.0));
  // (700,700) runs out to the tip (550,700) and straight back to (600,700).
  const ring = giveSquareBase(g, h, [[600, 600], [700, 600], [700, 700], [550, 700], [600, 700]]);
  const tip = ring[3];
  const sq = h.base.square;
  g._despike(h.base, h.track.polyline);
  const after = h.base.polygon.segments.map(s => s.start);
  assert.strictEqual(g.stats.despiked, 1);
  assert.strictEqual(after.length, 4);
  assert.ok(!after.includes(tip), 'the tip is gone');
  for (const v of [ring[0], ring[1], ring[2], ring[4]]) assert.ok(after.includes(v), 'kept vertices are the same objects');
  assert.ok(Math.abs(h.base.square - sq) < 1e-9 && Math.abs(h.base.square - 10000) < 1e-9, 'area ' + sq + ' -> ' + h.base.square);
  const segs = h.base.polygon.segments;
  for (let i = 0; i < segs.length; i++) assert.strictEqual(segs[i].end, segs[(i + 1) % segs.length].start, 'closed at ' + i);
  g._despike(h.base, h.track.polyline);
  assert.strictEqual(g.stats.despiked, 1, 'nothing left to drop');
});
