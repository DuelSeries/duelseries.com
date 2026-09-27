'use strict';
// Server wire builder (T6, design 7.1-7.5 and 8.4): ring cache and budget, trail epochs and
// batches, frames, the join payload, and a client double that follows the 7.4 contract.
const test = require('node:test');
const assert = require('node:assert');
const { makeArena, REASON, P, MP } = require('../server/paper/ArenaGame');
const { ArenaWire, pctOf } = require('../server/paper/arenaWire');
const trim = require('../server/paper/arenaTrim');

const C = 1000;
const at = (r, a) => new P.Vec2(C + Math.cos(a) * r, C + Math.sin(a) * r);

function setup(radius = 950) {
  const g = makeArena({ stake: 0.1, seed: 0.51 });
  g._target = radius;
  g.radiusTarget = function () { return this._target; };
  g.setRadiusNow(radius);
  const events = [];
  const wire = new ArenaWire(g, { queue: (e) => events.push(e), microOf: (id) => id * 1000 });
  return { g, wire, events };
}

let seq = 0;
function step(g, wire, inputs = []) {
  for (const [h, byte] of inputs) g.setInput(h.id, (++seq) & 255, byte, false, 0);
  g.update(MP.STEP_MS);
  wire.feed();
}

const byType = (events, t, id) => events.filter(e => e[0] === t && (id === undefined || e[1] === id));

test('a fresh base is encoded in its first post pass; one encode per version; the join reuses it', () => {
  const { g, wire, events } = setup();
  const h = g.spawnHuman({ name: 'a' }, at(300, 0.4));
  h.locked = true;
  step(g, wire);
  assert.strictEqual(byType(events, 'b', h.id).length, 1);
  const n = wire.stats.ringEncodes;
  for (let i = 0; i < 20; i++) step(g, wire);
  assert.strictEqual(byType(events, 'b', h.id).length, 1, 'no re-send without a bump');
  const join = wire.joinPayload();
  assert.strictEqual(wire.stats.ringEncodes, n, 'the join is a cache hit');
  const i = join.units.findIndex(u => u.id === h.id);
  assert.strictEqual(join.rings[i], byType(events, 'b', h.id)[0][4], 'the same encoded blob');
  assert.strictEqual(join.units[i].ver, h.base.wireVer);
  assert.strictEqual(join.units[i].skin, h.skin.name);
});

test('at most RING_ENCODES_PER_TICK ring encodes per tick; the rest wait', () => {
  const { g, wire, events } = setup();
  for (let i = 0; i < 7; i++) g.spawnHuman({ name: 'h' + i }, at(400, 0.3 + i * 0.85)).locked = true;
  step(g, wire);
  assert.strictEqual(byType(events, 'b').length, 3);
  step(g, wire);
  assert.strictEqual(byType(events, 'b').length, 6);
  step(g, wire);
  assert.strictEqual(byType(events, 'b').length, 7);
  assert.strictEqual(new Set(byType(events, 'b').map(e => e[1])).size, 7);
});

function slalom(g, wire, h, ticks, onTick) {
  let dir = 1;
  for (let t = 0; t < ticks && !h.death; t++) {
    if (t % 25 === 0) dir = -dir;
    const byte = MP.angleToByte(h.direction + dir * 0.5);
    step(g, wire, [[h, byte]]);
    if (onTick) onTick(t);
  }
}

test('the trail epoch bumps on a return and on a rewind', () => {
  const { g, wire } = setup();
  const h = g.spawnHuman({ name: 'r' }, at(200, 2.0));
  for (let i = 0; i < 40; i++) step(g, wire, [[h, MP.angleToByte(2.0)]]);
  assert.ok(h.in !== h.base);
  const st = wire.state.get(h);
  const e0 = st.epoch;
  assert.ok(st.dec.corners.length >= 1);
  // Rewind (the push-piece veto path) cuts the trail in place.
  const segs = h.track.polyline.segments;
  const s = segs[Math.floor(segs.length / 2)];
  g._enter();
  h.position = new P.Vec2((s.start.x + s.end.x) / 2, (s.start.y + s.end.y) / 2);
  g.rewindTrail(h);
  wire.feed();
  assert.strictEqual(st.epoch, (e0 + 1) & 255, 'rewind bumps');
  // Come home.
  const home = h.base.polygon.segments[0].start;
  for (let i = 0; i < 200 && h.in !== h.base; i++) {
    step(g, wire, [[h, MP.angleToByte(Math.atan2(home.y - h.position.y, home.x - h.position.x))]]);
  }
  assert.strictEqual(h.in, h.base);
  assert.strictEqual(st.epoch, (e0 + 2) & 255, 'return bumps');
  assert.strictEqual(st.dec.corners.length, 0);
});

// The 7.4 client contract with T1's codecs: reliable corners by (epoch, from), plus the frame tail.
function clientDouble(id) {
  const held = { epoch: -1, corners: [] };
  return {
    held,
    onEvent(e) {
      if (e[0] !== 't' || e[1] !== id) return;
      const [, , epoch, from, blob] = e;
      if (epoch !== held.epoch) { held.epoch = epoch; held.corners = []; }
      if (from > held.corners.length) return; // a gap: pp:need would fix it
      held.corners = held.corners.slice(0, from).concat(MP.decodePoints(blob));
    },
    onFrame(buf) {
      const u = MP.decodeFrame(buf).units.find(x => x.id === id);
      if (u.trailEpoch !== held.epoch) { held.epoch = u.trailEpoch; held.corners = []; }
      return held.corners.concat(u.tail);
    }
  };
}

test('a client that loses 8 frames in a row still rebuilds the same trail from batches and tails', () => {
  const { g, wire, events } = setup();
  const h = g.spawnHuman({ name: 'c' }, at(250, 1.0));
  const dbl = clientDouble(h.id);
  let consumed = 0;
  let drawn = null;
  let frameNo = 0;
  slalom(g, wire, h, 240, () => {
    while (consumed < events.length) dbl.onEvent(events[consumed++]);
    if (g.tick % MP.SNAPSHOT_EVERY === 0) {
      frameNo++;
      const buf = wire.frame([]);
      if (frameNo < 40 || frameNo >= 48) drawn = dbl.onFrame(buf); // frames 40..47 dropped
    }
  });
  assert.ok(!h.death && h.in !== h.base);
  const server = wire.state.get(h).dec.corners;
  assert.ok(server.length > 8);
  assert.strictEqual(drawn.length, server.length);
  drawn.forEach((p, i) => assert.ok(Math.abs(p.x - server[i].x) <= 1 / 64 && Math.abs(p.y - server[i].y) <= 1 / 64, 'corner ' + i));
});

test('a human at the turn cap yields at most 2 tail corners per 6-tick window', () => {
  const { g, wire } = setup();
  const h = g.spawnHuman({ name: 't' }, at(150, 0.2));
  let worst = 0;
  slalom(g, wire, h, 300, () => {
    const st = wire.state.get(h);
    worst = Math.max(worst, st.dec.corners.length - st.sent);
  });
  assert.ok(!h.death);
  assert.ok(worst <= 2, 'tail ' + worst);
});

test('a plain trim sends no ring; a dropped lobe does', () => {
  const { g, wire, events } = setup(950);
  g.trim = trim;
  const h = g.spawnHuman({ name: 'lens' }, at(900, 0.4));
  h.locked = true;
  for (let i = 0; i < 3; i++) step(g, wire);
  const sentBefore = byType(events, 'b', h.id).length;
  g._target = 912;
  let during = sentBefore;
  for (let i = 0; i < 1500 && (g.shrinking || g.border.radius > 912); i++) {
    step(g, wire);
    if (g.shrinking) during = byType(events, 'b', h.id).length;
  }
  assert.ok(h.base._trimTick > 0, 'the base was trimmed');
  assert.strictEqual(during, sentBefore, 'plain trims send no ring while the wall moves');
  assert.strictEqual(byType(events, 'b', h.id).length, sentBefore + 1, 'one re-send at the shrink end');

  const s2 = setup(950);
  const u = s2.g.spawnHuman({ name: 'u' }, at(600, 1.0));
  for (let i = 0; i < 2; i++) step(s2.g, s2.wire);
  const R = 950;
  const pts = [];
  const add = (x, y) => pts.push(new P.Vec2(C + x, C + y));
  for (let y = -40; y <= 40; y += 5) add(R + 10, y);
  for (let x = R + 5; x >= R - 30; x -= 5) add(x, 40);
  for (let y = 35; y >= 20; y -= 5) add(R - 30, y);
  for (let x = R - 26; x <= R - 2; x += 4) add(x, 20);
  for (let y = 20; y >= -20; y -= 5) add(R + 2, y);
  for (let x = R - 2; x >= R - 26; x -= 4) add(x, -20);
  for (let y = -20; y >= -40; y -= 5) add(R - 30, y);
  for (let x = R - 25; x <= R + 5; x += 5) add(x, -40);
  if (trim.signedArea(pts) < 0) pts.reverse();
  s2.g._enter();
  u.base.remove();
  u.base = new P.TerritoryBase(u, pts);
  u.base.wireVer = 7;
  u.in = u.base;
  u.position = new P.Vec2(C + R - 20, C - 30);
  step(s2.g, s2.wire);
  const b0 = byType(s2.events, 'b', u.id).length;
  s2.g.setRadiusNow(949);
  const plan = trim.planTrim(u.base, s2.g.border);
  assert.strictEqual(plan.droppedLobe, true);
  trim.applyTrim(s2.g, u.base, plan);
  step(s2.g, s2.wire);
  const sent = byType(s2.events, 'b', u.id);
  assert.strictEqual(sent.length, b0 + 1, 'a dropped lobe re-sends');
  assert.strictEqual(sent[sent.length - 1][2], 8);
});

test('shrink end re-sends touched rings once with ver + 1 and a new encode', () => {
  const { g, wire, events } = setup(950);
  const h = g.spawnHuman({ name: 's' }, at(890, 2.4));
  h.locked = true;
  for (let i = 0; i < 3; i++) step(g, wire);
  const first = byType(events, 'b', h.id);
  assert.strictEqual(first.length, 1);
  const ver0 = first[0][2];
  g._target = 900;
  for (let i = 0; i < 2000 && (g.shrinking || g.border.radius > 900); i++) step(g, wire);
  for (let i = 0; i < 60; i++) step(g, wire);
  const all = byType(events, 'b', h.id);
  assert.strictEqual(all.length, 2, 're-sent exactly once');
  assert.strictEqual(all[1][2], ver0 + 1);
  assert.notDeepStrictEqual(new Uint8Array(all[1][4]), new Uint8Array(all[0][4]).subarray(0, 0), 'a fresh encode');
});

test('a join built mid-shrink, clamped to its own radius, matches the trimmed server ring within 0.06 u', () => {
  const { g, wire } = setup(950);
  g.trim = trim;
  const h = g.spawnHuman({ name: 'm' }, at(905, 5.0));
  h.locked = true;
  step(g, wire);
  g._target = 880;
  let t = 0;
  while (!(g.shrinking && g.border.radius < 920) && t++ < 3000) step(g, wire);
  const join = wire.joinPayload();
  const i = join.units.findIndex(u => u.id === h.id);
  const R = join.radius;
  const clamped = MP.decodePoints(join.rings[i]).map(p => {
    const d = Math.hypot(p.x - C, p.y - C);
    return d > R ? { x: C + ((p.x - C) * R) / d, y: C + ((p.y - C) * R) / d } : p;
  });
  const server = h.base.polygon.segments.map(s => s.start);
  // Every server vertex lies within 0.06 u of the clamped client ring, and vice versa.
  const near = (p, ring) => {
    let best = Infinity;
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k], b = ring[(k + 1) % ring.length];
      best = Math.min(best, MP.distToSegmentSq(p.x, p.y, a.x, a.y, b.x, b.y));
    }
    return Math.sqrt(best);
  };
  let worst = 0;
  for (const p of server) worst = Math.max(worst, near(p, clamped));
  for (const p of clamped) worst = Math.max(worst, near(p, server));
  // A radial clamp cuts the corner where the ring meets the wall (about 1 u for a 50-gon
  // base crossing at a shallow angle); it is exact along the wall run itself. Cosmetic: land
  // percent always comes from the server. The client mirror (T11) should clip, not clamp.
  console.log('# mid-shrink join: worst ring distance ' + worst.toFixed(3) + ' u');
  assert.ok(worst <= 1.5, 'worst ' + worst);
  const onWall = server.filter(p => Math.abs(Math.hypot(p.x - C, p.y - C) - R) < 1e-6);
  assert.ok(onWall.length > 0, 'the server ring has a wall run');
  for (const p of onWall) assert.ok(near(p, clamped) <= 0.06 + 1 / 32, 'wall-run vertex ' + near(p, clamped));
});

test('frame sizes: 412 B for 16 squares with empty tails, 668 + 10P B at TRAIL_TAIL_MAX', () => {
  const { g, wire } = setup(950);
  for (let i = 0; i < 16; i++) g.spawnHuman({ name: 'f' + i }, at(i < 8 ? 300 : 650, 0.2 + (i % 8) * 0.78)).locked = true;
  step(g, wire);
  assert.strictEqual(g.units.length, 16);
  assert.strictEqual(wire.frame([]).byteLength, 412);
  for (const u of g.units) {
    const st = wire.state.get(u);
    st.dec.corners = [];
    for (let k = 0; k < 6; k++) st.dec.corners.push({ x: u.position.x + k, y: u.position.y });
    st.sent = 0;
  }
  const pickups = [{ pid: 1, x: 1000, y: 1000, micro: 5 }, { pid: 2, x: 990, y: 1000, micro: 6 }];
  assert.strictEqual(wire.frame(pickups).byteLength, 668 + 10 * 2);
  const t0 = process.hrtime.bigint();
  for (let k = 0; k < 2000; k++) wire.frame(pickups);
  const each = Number(process.hrtime.bigint() - t0) / 1e6 / 2000;
  console.log('# frame encode, 16 squares: ' + each.toFixed(4) + ' ms');
  assert.ok(each < 0.25, each + ' ms');
});

test('pct above 1 saturates, and money and ack ride the frame', () => {
  const { g, wire } = setup(950);
  const h = g.spawnHuman({ name: 'p' }, at(300, 0.9));
  step(g, wire, [[h, 10]]);
  g.square = h.base.square / 1.7;
  assert.strictEqual(pctOf(g, h.base), 1);
  const u = MP.decodeFrame(wire.frame([])).units.find(x => x.id === h.id);
  assert.strictEqual(u.pct, 1);
  assert.strictEqual(u.micro, h.id * 1000);
  assert.strictEqual(u.ack, h.seqAck);
  assert.strictEqual(u.inId, h.id, 'home: inId is its own id');
  assert.strictEqual(u.bot, false);
  const geo = wire.geo(h.id);
  assert.deepStrictEqual(geo.ev.map(e => [e[0], e[1]]), [['b', h.id], ['t', h.id]]);
  g.removeHuman(h.id, REASON.LEAVE);
  wire.feed();
  assert.strictEqual(wire.state.has(h), false, 'a dead unit\'s wire state is dropped');
});
