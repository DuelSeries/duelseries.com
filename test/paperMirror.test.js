'use strict';
// Mirror game (T11, design 8.1-8.4 and 7.2), view null and visible false: every reliable entry is
// idempotent, the synthesised spawn circle, onScoreChanged on a percent change, the stock kill
// and capture side effects, the ring CLIP (checked against the server's own trim), and an end to
// end run of a real PaperRoom with a human and bots fed through the client net into the mirror.
const test = require('node:test');
const assert = require('node:assert');
const { PaperRoom } = require('../server/paper/PaperRoom');
const arenaTrim = require('../server/paper/arenaTrim');
const { makeArena, P, MP } = require('../server/paper/ArenaGame');
require('../public/js/paper/mp/paperPredict.js');
const Net = require('../public/js/paper/mp/paperNet.js');
const Mirror = require('../public/js/paper/mp/paperMirror.js');

const C = 1000;
const STEP = MP.STEP_MS;
const Q = 1 / MP.POS_SCALE; // one wire quantum
const QPOS = Math.SQRT2 / (2 * MP.POS_SCALE); // worst rounding of a wire position
const at = (r, a) => new P.Vec2(C + Math.cos(a) * r, C + Math.sin(a) * r);
const PAL = P.playerColorPalette;

function seeded(seed) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

// The stock spawn search and a few particle draws use Math.random: stub it for determinism.
function withRandom(seed, fn) {
  const orig = Math.random;
  Math.random = seeded(seed);
  try {
    return fn();
  } finally {
    Math.random = orig;
  }
}

function segDist(p, ring) {
  let best = Infinity;
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % ring.length];
    best = Math.min(best, MP.distToSegmentSq(p.x, p.y, a.x, a.y, b.x, b.y));
  }
  return Math.sqrt(best);
}

function area(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

function circle(x, y, r = 30, n = 50) {
  return P.makeCirclePoints(new P.Vec2(x, y), n, r).map(p => ({ x: p.x, y: p.y }));
}

function mirror() {
  const m = Mirror.create({ seed: 0.5 });
  m.onError = (e) => { throw e; };
  return m;
}

// A hand-built pp:joined payload. units: { id, name, skin, x, y, pct, ver, epoch, inId, ring, trail }
function payload(you, units, extra = {}) {
  return Object.assign({
    you,
    arenaId: 'test',
    stake: 0,
    tick: 100,
    radius: 950,
    targetRadius: 950,
    holdTicks: MP.HOLD_TICKS,
    resumeKey: 'RK',
    resumed: false,
    units: units.map(u => ({
      id: u.id, name: u.name || 'u' + u.id, skin: u.skin || null, bot: !!u.bot, x: u.x, y: u.y, dir: u.dir || 0,
      inId: u.inId === undefined ? u.id : u.inId, micro: u.micro || 0, pct: u.pct || 0.001, ver: u.ver || 1, epoch: u.epoch || 0
    })),
    rings: units.map(u => MP.encodePoints(u.ring || circle(u.x, u.y))),
    trails: units.map(u => MP.encodePoints(u.trail || [])),
    pickups: []
  }, extra);
}

function three() {
  return payload(1, [
    { id: 1, name: 'me', skin: PAL[0], x: 700, y: 700 },
    { id: 2, name: 'two', skin: PAL[1], x: 1300, y: 700, ver: 5, epoch: 3, inId: 0,
      trail: [{ x: 1300, y: 740 }, { x: 1310, y: 760 }, { x: 1320, y: 770 }, { x: 1330, y: 790 }] },
    { id: 3, name: 'three', skin: PAL[2], x: 1000, y: 1300, inId: 1 }
  ]);
}

// Plain data only (never units or games in an assert diff).
function snap(m) {
  const units = m.units.slice().sort((a, b) => a.id - b.id).map(u => ({
    id: u.id,
    name: u.name,
    bot: u.bot,
    micro: u.micro,
    ver: u.ver,
    pct: u.percent,
    x: u.position.x,
    y: u.position.y,
    skin: u.skin ? u.skin.name : null,
    inOwner: u.in ? u.in.unit.id : 0,
    ring: u.ringPoints().map(p => [p.x, p.y]),
    trail: [u.trail.epoch, u.trail.corners.map(p => [p.x, p.y])],
    kills: u.statistics.kills,
    labels: u.labels.map(l => l.text)
  }));
  return {
    units,
    player: m.player ? m.player.id : 0,
    playerDead: !!(m.player && m.player.death),
    playerLabels: m.player ? m.player.labels.map(l => l.text) : [],
    pickups: [...m.pickups.values()].sort((a, b) => a.pid - b.pid),
    gone: [...m.gone.entries()].sort((a, b) => a[0] - b[0])
  };
}

function applyAll(m, entries, tick) {
  return entries.map(e => m.applyEntry(e, tick));
}

// -------------------------------------------------------------------------------------------
// A real arena, a fake io that captures every emit, a client socket double wired to the room
// -------------------------------------------------------------------------------------------

function arena({ seed = 0.42, warm = 200, trim = arenaTrim } = {}) {
  const clock = { t: 1000000 };
  const q = [];
  const io = {
    to: (target) => ({
      emit: (ev, p) => q.push([target, ev, p]),
      volatile: { emit: (ev, p) => q.push([target, ev, p]) }
    })
  };
  const hooks = {};
  for (const h of ['onCashout', 'onTransfer', 'onRefund', 'onSweep', 'onBreach']) hooks[h] = () => {};
  const room = new PaperRoom({ stake: 0, io, hooks, now: () => clock.t, autoTick: false, seed, trim });
  for (let i = 0; i < warm; i++) {
    clock.t += STEP;
    room.tickOnce();
  }
  q.length = 0;
  const server = {
    id: 'c1',
    rooms: new Set(),
    join(r) { this.rooms.add(r); },
    leave(r) { this.rooms.delete(r); },
    emit(ev, p) { q.push(['c1', ev, p]); }
  };
  const handlers = {};
  const sent = [];
  const client = {
    on(ev, fn) { handlers[ev] = fn; },
    emit(ev, p) {
      sent.push([ev, p]);
      if (ev === 'pp:need') q.push(['c1', 'pp:geo', room.geo(p.id)]);
    },
    volatile: {
      emit(ev, p) {
        sent.push([ev, p]);
        if (ev === 'pp:in') room.setInput('c1', p);
      }
    }
  };
  const log = [];
  function deliver() {
    while (q.length) {
      const [target, ev, p] = q.shift();
      const mine = target === 'c1' || (target === room.ioRoom && server.rooms.has(room.ioRoom));
      if (!mine) continue;
      log.push([ev, MP.unpackBin(p)]); // captured payloads carry one packed attachment
      if (handlers[ev]) handlers[ev](p);
    }
  }
  return { clock, room, g: room.game, server, client, sent, log, deliver, handlers };
}

function connect(k, { name = 'me', spot = null, withNet = true } = {}) {
  let net = null;
  let m;
  if (withNet) {
    net = new Net.ArenaNet({ socket: k.client, now: () => k.clock.t, onError: (w, e) => { throw e; } });
    m = Mirror.create({ net, seed: 0.5 });
  } else {
    m = Mirror.create({ seed: 0.5 });
  }
  m.onError = (e) => { throw e; };
  if (net) net.join({ name, stake: 0, entryToken: 'tok' });
  const seat = k.room.addHuman(k.server, { name, micro: 0, wallet: null, spot: spot || k.room.findSpawn() });
  k.deliver();
  return { net, mirror: m, seat };
}

function run(k, c, n, steer) {
  for (let i = 0; i < n; i++) {
    if (steer) {
      const a = steer(k.g.tick);
      c.mirror.direction = new P.Vec2(Math.cos(a), Math.sin(a));
    }
    k.clock.t += STEP;
    c.mirror.update(STEP);
    k.room.tickOnce();
    k.deliver();
  }
}

// Moves the page clock so renderTick lands on the newest frame, and runs one mirror update.
function syncToNewest(k, c) {
  const net = c.net;
  const T = net.lastFrameTick;
  const want = (T + 1e-6 + (MP.INTERP_DELAY_MS + net.jitterBuf) / STEP) * STEP - net.clockOffset;
  k.clock.t = Math.max(k.clock.t, want);
  c.mirror.update(1e-4);
  return T;
}

// Mirror against server at the newest frame tick. Returns counts for the caller's asserts.
function compare(k, c, acc) {
  const g = k.g;
  const m = c.mirror;
  const T = syncToNewest(k, c);
  assert.strictEqual(g.tick, T, 'the server has not moved past the newest frame');
  assert.ok(Math.abs(m.renderTickNow - T) < 1e-3, 'renderTick is on the newest frame');
  const me = m.player && !m.player.death ? m.player : null;
  const sIds = g.units.map(u => u.id).sort((a, b) => a - b);
  const mIds = m.units.map(u => u.id).sort((a, b) => a - b);
  assert.deepStrictEqual(mIds, sIds, 'the same squares at tick ' + T);
  assert.strictEqual(m.border.radius, g.border.radius, 'the same wall');
  const R = g.border.radius;
  for (const su of g.units) {
    const mu = m.byId.get(su.id);
    assert.ok(mu, 'square ' + su.id);
    const st = k.room.wire.state.get(su);
    // Position: remotes within the wire rounding; the own square by its acked prediction.
    if (mu === me) {
      const rec = c.net.newest().byId.get(su.id);
      const e = m.predictor.entry(rec.ack);
      assert.ok(e, 'the acked input is in the ring');
      const err = Math.hypot(e.after.x - su.position.x, e.after.y - su.position.y);
      assert.ok(err < MP.RECONCILE_POS_EPS, 'own acked state ' + err);
      acc.local++;
    } else {
      const err = Math.hypot(mu.position.x - su.position.x, mu.position.y - su.position.y);
      assert.ok(err <= QPOS + 1e-9, 'square ' + su.id + ' position off by ' + err);
      acc.worstPos = Math.max(acc.worstPos, err);
      acc.remote++;
    }
    assert.ok(Math.abs(mu.percent - MP.clampPct(su.base.square / g.square)) <= 1 / MP.PCT_SCALE, 'percent of ' + su.id);
    if (mu.name !== '') assert.strictEqual(mu.name, su.name, 'name of ' + su.id);
    else acc.adopted.add(su.id);
    // Ring: skip a base the server has not trimmed yet (budget, blocked) or not re-sent yet.
    if (su.base._trimDirty || !st || st.sentVer !== su.base.wireVer) {
      acc.ringSkipped++;
    } else {
      assert.strictEqual(mu.ver, su.base.wireVer & 0xFFFF, 'ring version of ' + su.id);
      const sr = su.base.polygon.segments.map(s => s.start);
      const mr = mu.ringPoints();
      let worst = 0;
      for (const p of sr) worst = Math.max(worst, segDist(p, mr));
      for (const p of mr) worst = Math.max(worst, segDist(p, sr));
      assert.ok(worst <= MP.RING_TOL + Q, 'ring of ' + su.id + ' off by ' + worst);
      acc.worstRing = Math.max(acc.worstRing, worst);
      for (const p of sr) {
        if (Math.abs(Math.hypot(p.x - C, p.y - C) - R) > 1e-6) continue;
        const d = segDist(p, mr);
        assert.ok(d <= 0.06 + MP.RING_TOL, 'wall run of ' + su.id + ' off by ' + d);
        acc.onWall++;
        acc.worstWall = Math.max(acc.worstWall, d);
      }
      for (const p of mr) {
        if (!MP.wallInside(g.border, p.x, p.y)) acc.outside++;
      }
      acc.rings++;
    }
    // Trail: reliable corners + tail are the server's wire corners, within the rounding.
    const away = su.in !== su.base;
    const corners = st ? st.dec.corners : [];
    if (mu === me) {
      if (!away) continue;
      const pts = m._stable(mu).pts;
      assert.strictEqual(pts.length, corners.length, 'own trail length');
      for (let i = 0; i < pts.length; i++) assert.ok(Math.hypot(pts[i].x - corners[i].x, pts[i].y - corners[i].y) <= QPOS + 1e-9);
      acc.trails++;
      continue;
    }
    if (!away) {
      assert.strictEqual(mu.track.polyline.start, null, 'no trail drawn at home for ' + su.id);
      continue;
    }
    const pts = m._stable(mu).pts;
    const rec = c.net.newest().byId.get(su.id);
    if (rec.tail.length < MP.TRAIL_TAIL_MAX) assert.strictEqual(pts.length, corners.length, 'trail length of ' + su.id);
    else assert.ok(pts.length <= corners.length);
    for (let i = 0; i < pts.length; i++) {
      const d = Math.hypot(pts[i].x - corners[i].x, pts[i].y - corners[i].y);
      assert.ok(d <= QPOS + 1e-9, 'trail corner ' + i + ' of ' + su.id + ' off by ' + d);
      acc.worstTrail = Math.max(acc.worstTrail, d);
    }
    const poly = mu.track.polyline;
    assert.ok(poly.end === mu.position || corners.length === 0 || poly.segments.length === pts.length - 1, 'the live head closes the trail');
    acc.trails++;
  }
  acc.checks++;
  return T;
}

function newAcc() {
  return { checks: 0, remote: 0, local: 0, worstPos: 0, rings: 0, worstRing: 0, onWall: 0, worstWall: 0, outside: 0, ringSkipped: 0, trails: 0, worstTrail: 0, adopted: new Set() };
}

// -------------------------------------------------------------------------------------------

test('applying the first bundle twice changes nothing (a real join, and every entry type)', () => {
  withRandom(3, () => {
    const k = arena({ seed: 0.31, warm: 120 });
    const c = connect(k, { withNet: false });
    const joined = k.log.find(l => l[0] === 'pp:joined')[1];
    let first = null;
    for (let i = 0; i < 20 && !first; i++) {
      k.clock.t += STEP;
      k.room.tickOnce();
      k.deliver();
      first = k.log.find(l => l[0] === 'pp:ev');
    }
    assert.ok(first, 'a bundle arrived');
    const m = mirror();
    m.applyJoined(joined);
    assert.strictEqual(m.units.length, k.g.units.length);
    const bundle = first[1];
    applyAll(m, bundle.ev, bundle.tick);
    const s1 = snap(m);
    applyAll(m, bundle.ev, bundle.tick);
    assert.deepStrictEqual(snap(m), s1, 'the real first bundle, twice');
    // pp:joined itself (a resume) twice gives the same state.
    const m2 = mirror();
    m2.applyJoined(joined);
    const j1 = snap(m2);
    m2.applyJoined(joined);
    assert.deepStrictEqual(snap(m2), j1);
    assert.strictEqual(m2.units.length, j1.units.length, 'no second copy of anything');
  });

  const m = mirror();
  m.applyJoined(three());
  const ring30 = MP.encodePoints(circle(600, 600, 31, 40));
  const bundle = [
    ['j', { id: 30, name: 'new', skin: PAL[5], bot: false, micro: 0, x: 600, y: 600 }],
    ['b', 30, 1, 0.002, ring30],
    ['t', 2, 3, 4, MP.encodePoints([{ x: 1340, y: 800 }, { x: 1350, y: 815 }])],
    ['m', 2, 777],
    ['p+', 9, 700, 700, 1234],
    ['p+', 10, 710, 700, 55],
    ['p-', 9, 1, 1234],
    ['cap', 1, 0.0123],
    ['mv', 3, 800, 800],
    ['k', 3, 1, 3, 0, 0]
  ];
  const r1 = applyAll(m, bundle, 120);
  assert.ok(r1.every(Boolean), 'every entry applied the first time: ' + r1);
  const s1 = snap(m);
  const r2 = applyAll(m, bundle, 120);
  assert.deepStrictEqual(snap(m), s1, 'the same bundle again changes nothing');
  assert.deepStrictEqual(r2.map((v, i) => [bundle[i][0], v]).filter(x => x[1]).map(x => x[0]), ['j', 'm', 'p+', 'p+', 'p-'],
    'only the absolute or keyed entries re-apply, to the same values');
  assert.deepStrictEqual(s1.playerLabels, ['+1.23%', 'Kill'], 'one capture label and one kill label');
  assert.deepStrictEqual(s1.pickups, [{ pid: 10, x: 710, y: 700, micro: 55 }]);
});

test("['j'] for a known id never creates a second unit, and the local square is never rebuilt", () => {
  const m = mirror();
  m.applyJoined(three());
  const me = m.player;
  const two = m.byId.get(2);
  assert.ok(me && me.isPlayer && m.units.includes(me));
  assert.strictEqual(m.applyEntry(['j', { id: 2, name: 'renamed', skin: PAL[1], bot: true, micro: 5, x: 1, y: 1 }], 101), true);
  assert.strictEqual(m.applyEntry(['j', { id: 1, name: 'me again', skin: PAL[0], bot: false, micro: 9, x: 5, y: 5 }], 101), true);
  assert.strictEqual(m.units.length, 3);
  assert.ok(m.byId.get(2) === two, 'the same object');
  assert.strictEqual(two.name, 'renamed');
  assert.strictEqual(two.micro, 5);
  assert.ok(m.player === me && m.units.includes(me), 'player is still the unit in units');
  assert.strictEqual(me.position.x, 700, 'a ["j"] never moves or rebuilds the local square');
  assert.strictEqual(m.units.filter(u => u.id === 1).length, 1);
});

test("['k'] and ['p-'] for unknown ids are ignored (never reach spawnDeathParticles)", () => {
  const m = mirror();
  m.visible = true; // the burst would read the missing unit's schemes and skin
  m.applyJoined(three());
  const s0 = snap(m);
  assert.strictEqual(m.applyEntry(['k', 99, 1, 3, 0, 0], 101), false);
  assert.strictEqual(m.applyEntry(['k', 99, 0, 1, 0, 0], 101), false);
  assert.strictEqual(m.applyEntry(['p-', 77, 1, 5], 101), false);
  assert.strictEqual(m.applyEntry(['p-', 77, 0, 5], 101), false);
  assert.strictEqual(m.errors, 0);
  assert.deepStrictEqual(snap(m), s0);
  assert.strictEqual(m.particles.length, 0);
  // A known victim bursts (visible) and is gone; a second ['k'] for it is then unknown.
  assert.strictEqual(m.applyEntry(['k', 2, 3, 3, 0, 0], 102), true);
  assert.ok(m.particles.length > 0, 'the stock burst ran');
  assert.strictEqual(m.byId.get(3).statistics.kills, 1);
  assert.strictEqual(m.applyEntry(['k', 2, 3, 3, 0, 0], 102), false);
  assert.strictEqual(m.byId.get(3).statistics.kills, 1);
});

test("stale ['b'] and ['t'] are ignored; newer ones apply; a gap waits for the resync", () => {
  const m = mirror();
  m.applyJoined(three());
  const two = m.byId.get(2);
  const ring0 = snap(m).units[1].ring;
  const blob = (r) => MP.encodePoints(circle(1300, 700, r));
  assert.strictEqual(m.applyEntry(['b', 2, 5, 0.3, blob(40)], 101), false, 'same version');
  assert.strictEqual(m.applyEntry(['b', 2, 4, 0.3, blob(40)], 101), false, 'older version');
  assert.strictEqual(m.applyEntry(['b', 2, 65535, 0.3, blob(40)], 101), false, 'older across the u16 wrap');
  assert.deepStrictEqual(snap(m).units[1].ring, ring0);
  assert.strictEqual(m.applyEntry(['b', 2, 6, 0.3, blob(40)], 101), true);
  assert.strictEqual(two.ver, 6);
  assert.deepStrictEqual(two.ringPoints().map(p => [p.x, p.y]), MP.decodePoints(blob(40)).map(p => [p.x, p.y]));
  assert.strictEqual(two.percent, Math.round(0.3 * MP.PCT_SCALE) / MP.PCT_SCALE);

  const pts = (n, x0) => MP.encodePoints(Array.from({ length: n }, (_, i) => ({ x: x0 + i, y: 800 })));
  const corners = () => two.trail.corners.map(p => p.x);
  assert.strictEqual(two.trail.epoch, 3);
  assert.strictEqual(two.trail.corners.length, 4);
  assert.strictEqual(m.applyEntry(['t', 2, 2, 0, pts(9, 0)], 101), false, 'older epoch');
  assert.strictEqual(m.applyEntry(['t', 2, 3, 0, pts(4, 0)], 101), false, 'nothing newer');
  assert.strictEqual(m.applyEntry(['t', 2, 3, 6, pts(2, 0)], 101), false, 'a gap');
  assert.strictEqual(two.trail.corners.length, 4);
  assert.strictEqual(m.applyEntry(['t', 2, 3, 4, pts(2, 100)], 101), true);
  assert.deepStrictEqual(corners().slice(4), [100, 101]);
  assert.strictEqual(m.applyEntry(['t', 2, 3, 3, pts(4, 200)], 101), true, 'an overlap appends only the new part');
  assert.deepStrictEqual(corners().slice(4), [100, 101, 203]);
  assert.strictEqual(m.applyEntry(['t', 2, 4, 1, pts(2, 0)], 101), false, 'a new epoch not from 0');
  assert.strictEqual(m.applyEntry(['t', 2, 4, 0, pts(1, 500)], 101), true);
  assert.deepStrictEqual(corners(), [500]);
  assert.strictEqual(two.trail.epoch, 4);
  assert.strictEqual(m.applyEntry(['t', 2, 3, 0, pts(9, 0)], 101), false, 'the old epoch is gone for good');
  assert.strictEqual(m.applyEntry(['t', 42, 0, 0, pts(2, 0)], 101), false, 'unknown id');
});

test("a ['j'] square gets the synthesised spawn circle (the server's own ring) and the first ['b'] replaces it", () => {
  withRandom(5, () => {
    const k = arena({ seed: 0.33, warm: 60 });
    const c = connect(k, { withNet: false });
    const joined = k.log.find(l => l[0] === 'pp:joined')[1];
    const m = mirror();
    m.applyJoined(joined);
    // A second human joins: the room flushes ['j'] to the members already there.
    const other = { id: 'c2', rooms: new Set(), join(r) { this.rooms.add(r); }, leave() {}, emit() {} };
    const n0 = k.log.length;
    const seat = k.room.addHuman(other, { name: 'second', micro: 0, wallet: null, spot: k.room.findSpawn() });
    k.deliver();
    const j = k.log.slice(n0).find(l => l[0] === 'pp:ev' && l[1].ev.some(e => e[0] === 'j'));
    assert.ok(j, 'the members got the join');
    const entry = j[1].ev.find(e => e[0] === 'j');
    assert.strictEqual(entry[1].id, seat.unit.id);
    assert.strictEqual(m.applyEntry(entry, j[1].tick), true);
    const u = m.byId.get(seat.unit.id);
    assert.ok(u && u.name === 'second');
    assert.strictEqual(u.skin.name, seat.unit.skin.name, 'the wire skin name through the real SkinManager');
    const serverRing = seat.unit.base.polygon.segments.map(s => [s.start.x, s.start.y]);
    assert.deepStrictEqual(u.ringPoints().map(p => [p.x, p.y]), serverRing, 'bit for bit the server ring');
    const cfg = P.defaultPaperConfig;
    const synth = P.makeCirclePoints(new P.Vec2(entry[1].x, entry[1].y), cfg.baseCount, cfg.baseRadius).map(p => [p.x, p.y]);
    assert.deepStrictEqual(u.ringPoints().map(p => [p.x, p.y]), synth);
    // The first ['b'] for it replaces the circle.
    let b = null;
    for (let i = 0; i < 10 && !b; i++) {
      k.clock.t += STEP;
      k.room.tickOnce();
      const n1 = k.log.length;
      k.deliver();
      for (const l of k.log.slice(n1)) {
        if (l[0] !== 'pp:ev') continue;
        const e = l[1].ev.find(x => x[0] === 'b' && x[1] === seat.unit.id);
        if (e) b = [e, l[1].tick];
      }
    }
    assert.ok(b, 'its ring was sent');
    assert.strictEqual(u.ver, 0);
    assert.strictEqual(m.applyEntry(b[0], b[1]), true);
    assert.strictEqual(u.ver, b[0][2]);
    assert.deepStrictEqual(u.ringPoints().map(p => [p.x, p.y]), MP.decodePoints(b[0][4]).map(p => [p.x, p.y]));
  });
});

test('onScoreChanged fires on a percent change (frame and ring), a join and a drop, never on the same percent', () => {
  const clock = { t: 100 * STEP };
  const handlers = {};
  const socket = { on(ev, fn) { handlers[ev] = fn; }, emit() {}, volatile: { emit() {} } };
  const net = new Net.ArenaNet({ socket, now: () => clock.t, onError: (w, e) => { throw e; } });
  const m = Mirror.create({ net, seed: 0.5 });
  m.onError = (e) => { throw e; };
  handlers['pp:joined'](three());
  const two = m.byId.get(2);
  let calls = 0;
  const stock = two.onScoreChanged;
  two.onScoreChanged = function () {
    calls++;
    return stock.call(this);
  };
  const fr = (tick, pct) => MP.encodeFrame({
    tick, radius: 950, targetRadius: 950, pickups: [],
    units: [
      { id: 1, x: 700, y: 700, dir: 0, pct: 0.001, baseVer: 1, inId: 1 },
      { id: 2, x: 1300, y: 700, dir: 0, pct, baseVer: 5, trailEpoch: 3, trailCount: 4 },
      { id: 3, x: 1000, y: 1300, dir: 0, pct: 0.001, baseVer: 1, inId: 1 }
    ]
  });
  const feed = (tick, pct) => {
    clock.t = tick * STEP;
    handlers['pp:s'](fr(tick, pct));
    clock.t = tick * STEP + MP.INTERP_DELAY_MS + 1;
    m.topListChanged = false;
    m.update(STEP);
  };
  feed(102, 0.001);
  assert.strictEqual(calls, 0, 'the same percent');
  feed(104, 0.05);
  assert.strictEqual(calls, 1, 'a changed percent');
  assert.strictEqual(m.topListChanged, true, 'the stock rule flags the leaderboard');
  feed(106, 0.05);
  feed(108, 0.05);
  assert.strictEqual(calls, 1, 'unchanged again');
  feed(110, 0.06);
  assert.strictEqual(calls, 2);
  // A ring with the same percent (as the frame quantises it) does not fire; a new one does.
  m.applyEntry(['b', 2, 6, 0.06, MP.encodePoints(circle(1300, 700, 35))], 110);
  assert.strictEqual(calls, 2);
  m.applyEntry(['b', 2, 7, 0.07, MP.encodePoints(circle(1300, 700, 36))], 110);
  assert.strictEqual(calls, 3);
  // A join and a drop flag the list.
  m.topListChanged = false;
  m.applyEntry(['j', { id: 40, name: 'x', skin: null, bot: true, micro: 0, x: 400, y: 400 }], 111);
  assert.strictEqual(m.topListChanged, true);
  m.topListChanged = false;
  m.applyEntry(['k', 2, 0, 1, 0, 0], 111);
  assert.strictEqual(calls, 4, 'the victim');
  assert.strictEqual(m.topListChanged, true);
});

test('coins: membership by the entries, position from the frames (a shrink moves them with no event)', () => {
  const clock = { t: 100 * STEP };
  const handlers = {};
  const socket = { on(ev, fn) { handlers[ev] = fn; }, emit() {}, volatile: { emit() {} } };
  const net = new Net.ArenaNet({ socket, now: () => clock.t, onError: (w, e) => { throw e; } });
  const m = Mirror.create({ net, seed: 0.5 });
  m.onError = (e) => { throw e; };
  const p = three();
  p.pickups = [{ pid: 4, x: 1900, y: 1000, micro: 250000 }];
  handlers['pp:joined'](p);
  assert.deepStrictEqual([...m.pickups.values()], [{ pid: 4, x: 1900, y: 1000, micro: 250000 }]);
  const fr = (tick, x) => MP.encodeFrame({
    tick, radius: 950, targetRadius: 950,
    units: [{ id: 1, x: 700, y: 700, dir: 0, pct: 0.001, baseVer: 1, inId: 1 }],
    pickups: [{ pid: 4, x, y: 1000, micro: 250000 }, { pid: 5, x: 10, y: 10, micro: 1 }]
  });
  clock.t = 102 * STEP;
  handlers['pp:s'](fr(102, 1880.5));
  clock.t = 102 * STEP + MP.INTERP_DELAY_MS + 1;
  m.update(STEP);
  const coin = m.pickups.get(4);
  assert.strictEqual(coin.x, 1880.5, 'moved by the frame');
  assert.ok(!m.pickups.has(5), 'a coin appears only through its ["p+"]');
  m.applyEntry(['p-', 4, 1, 250000], 103);
  assert.strictEqual(m.pickups.size, 0);
});

test('a kill and a capture drive the stock labels and counters; a local death keeps player for the follow-killer', () => {
  const m = mirror();
  m.applyJoined(three());
  const me = m.player;
  const three3 = m.byId.get(3);
  assert.ok(three3.in === me.base, 'in resolves to the owner base');
  // 3 stands on my land; I kill it.
  m.applyEntry(['k', 3, 1, 3, 0, 0], 101);
  assert.strictEqual(me.statistics.kills, 1);
  assert.deepStrictEqual(me.labels.map(l => l.text), ['Kill']);
  assert.ok(!m.byId.has(3) && !m.units.includes(three3) && three3.death === true);
  m.applyEntry(['cap', 1, 0.0321], 102);
  assert.deepStrictEqual(me.labels.map(l => l.text), ['Kill', '+3.21%']);
  m.applyEntry(['cap', 2, 0.5], 102);
  assert.deepStrictEqual(m.byId.get(2).labels, [], 'only the own square shows the capture label');
  m.update(STEP);
  assert.strictEqual(m.labels.length, 2, 'the cosmetic tick turned them into floating labels');
  assert.strictEqual(me.labels.length, 0);
  // I die to 2: player stays for the stock follow-killer glide.
  m.applyEntry(['k', 1, 2, 3, 0, 0], 103);
  assert.ok(m.player === me && me.death === true && me.killer === m.byId.get(2));
  assert.ok(!m.units.includes(me));
  assert.strictEqual(m.byId.get(2).statistics.kills, 1);
  m.update(STEP);
  assert.strictEqual(m.errors, 0);
});

test("a square the server never announced is adopted from its first ['b']; a ring after its ['k'] never resurrects it", () => {
  const m = mirror();
  m.applyJoined(three());
  const blob = MP.encodePoints(circle(500, 1400, 30));
  assert.strictEqual(m.applyEntry(['b', 50, 3, 0.01, blob], 120), true);
  const u = m.byId.get(50);
  assert.ok(u && u.name === '' && u.ver === 3 && u.skin && u.skin.colors);
  assert.strictEqual(u.trail.epoch, -1, 'any trail from 0 is taken');
  assert.strictEqual(m.applyEntry(['t', 50, 7, 0, MP.encodePoints([{ x: 500, y: 1440 }])], 121), true);
  assert.strictEqual(m.applyEntry(['b', 50, 3, 0.01, blob], 121), false);
  assert.strictEqual(m.applyEntry(['k', 50, 0, 2, 0, 0], 130), true);
  assert.strictEqual(m.applyEntry(['b', 50, 4, 0.01, blob], 129), false, 'a ring older than the kill');
  assert.strictEqual(m.applyEntry(['b', 50, 4, 0.01, blob], 130), false, 'same tick as the kill');
  assert.ok(!m.byId.has(50));
  assert.strictEqual(m.applyEntry(['b', 50, 1, 0.01, blob], 400), true, 'a later reuse of the id');
});

test('clipRing is the server trim: crossings plus the wall run, where a radial clamp cuts the corner', () => {
  const g = makeArena({ stake: 0.1, seed: 0.51 });
  g.radiusTarget = () => 950;
  g.setRadiusNow(950);
  const h = g.spawnHuman({ name: 'edge' }, at(905, 5.0));
  const ring = h.base.polygon.segments.map(s => ({ x: s.start.x, y: s.start.y }));
  let worstClip = 0;
  let worstClamp = 0;
  for (const R of [931.5, 925, 918, 910.5, 900]) {
    g.setRadiusNow(R);
    const plan = arenaTrim.planTrim(h.base, g.border);
    assert.strictEqual(plan.status, 'ok', 'the server plans a plain trim at ' + R + ': ' + plan.status + ' ' + plan.why);
    const keep = plan.keep.map(p => ({ x: p.x, y: p.y }));
    const clip = Mirror.clipRing(ring, g.border);
    assert.ok(clip && clip !== ring);
    for (const p of clip) assert.ok(MP.wallInside(g.border, p.x, p.y), 'every clipped vertex is inside the wall');
    let worst = 0;
    for (const p of keep) worst = Math.max(worst, segDist(p, clip));
    for (const p of clip) worst = Math.max(worst, segDist(p, keep));
    assert.ok(worst < 1e-5, 'clip vs server trim at R=' + R + ': ' + worst);
    assert.ok(Math.abs(area(clip) - area(keep)) < 1e-3, 'same area');
    const wallRun = keep.filter(p => Math.abs(Math.hypot(p.x - C, p.y - C) - R) < 1e-9);
    assert.ok(wallRun.length >= 1, 'a wall run at ' + R);
    for (const w of wallRun) assert.ok(segDist(w, clip) < 1e-9, 'the wall run is the own vertices of the border');
    worstClip = Math.max(worstClip, worst);
    const clamp = ring.map(p => {
      const d = Math.hypot(p.x - C, p.y - C);
      return d > R ? { x: C + ((p.x - C) * R) / d, y: C + ((p.y - C) * R) / d } : p;
    });
    for (const p of keep) worstClamp = Math.max(worstClamp, segDist(p, clamp));
  }
  console.log('# clip vs server trim ' + worstClip.toExponential(2) + ' u; radial clamp ' + worstClamp.toFixed(3) + ' u');
  assert.ok(worstClamp > 0.3, 'the radial clamp really does cut the corner (' + worstClamp + ')');
  g.stop();

  const wall = MP.guardedBorder(new P.Vec2(C, C), 300, 950);
  const inner = circle(1200, 1000, 30);
  assert.ok(Mirror.clipRing(inner, wall) === inner, 'all inside: the same array');
  assert.strictEqual(Mirror.clipRing(circle(C + 1100, C, 30), wall), null, 'all outside: nothing');
  // An edge whose two ends are outside but whose middle dips inside (a long chord).
  const tri = [{ x: 1940, y: 600 }, { x: 1940, y: 1400 }, { x: 1500, y: 1000 }];
  const cut = Mirror.clipRing(tri, wall);
  for (const p of cut) assert.ok(MP.wallInside(wall, p.x, p.y));
  const onChord = cut.filter(p => Math.abs(p.x - 1940) < 1e-6);
  assert.strictEqual(onChord.length, 2, 'both crossings of the dipping edge');
  // Sutherland-Hodgman against the 300 half-planes: exact for this connected result.
  let sh = tri.slice();
  const wv = wall.polygon.segments.map(s => s.start);
  for (let i = 0; i < wv.length; i++) {
    const a = wv[i];
    const b = wv[(i + 1) % wv.length];
    const side = (p) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    const next = [];
    for (let j = 0; j < sh.length; j++) {
      const p = sh[j];
      const q = sh[(j + 1) % sh.length];
      const sp = side(p);
      const sq = side(q);
      if (sp >= 0) next.push(p);
      if ((sp >= 0) !== (sq >= 0)) {
        const t = sp / (sp - sq);
        next.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
      }
    }
    sh = next;
  }
  assert.ok(Math.abs(area(cut) - area(sh)) < 1e-4, 'area ' + area(cut) + ' vs ' + area(sh));
  let worst = 0;
  for (const p of sh) worst = Math.max(worst, segDist(p, cut));
  for (const p of cut) worst = Math.max(worst, segDist(p, sh));
  assert.ok(worst < 1e-5, 'shape ' + worst);
});

test('end to end: a real PaperRoom with a human and bots, fed through the net into the mirror, matches the server', () => {
  const acc = newAcc();
  const counts = { k: 0, b: 0, t: 0, cap: 0, j: 0, mv: 0 };
  const rebases = [];
  withRandom(7, () => {
    const k = arena({ seed: 0.42, warm: 200 });
    // The human spawns against the west wall, so the shrink below cuts its base.
    const c = connect(k, { spot: new P.Vec2(C - 905, C) });
    // Every re-base of the own square must be one the design accepts: the first compare after
    // the join (the server moves the square before the first input lands) or a wall quantum
    // step while the square is pressed against the moving wall.
    const pr = c.mirror.predictor;
    const reconcile = pr.reconcile.bind(pr);
    pr.reconcile = function (own) {
      const r = reconcile(own);
      if (r !== 'ok') {
        const f = c.net.newest();
        const d = Math.hypot(own.x - C, own.y - C);
        rebases.push({ r, first: pr.stats.compares === 1, wall: f.radius - d, shrinking: f.shrinking });
      }
      return r;
    };
    assert.strictEqual(k.sent[0][0], 'pp:join');
    assert.strictEqual(c.net.you, c.seat.unit.id);
    assert.ok(c.mirror.player && c.mirror.player.id === c.net.you);
    const steer = (tick) => (tick * 2 * Math.PI) / 180; // a 43 u circle: out and home again
    run(k, c, 150, steer);
    compare(k, c, acc);
    // A second human arrives (a ['j'] on the wire).
    const other = { id: 'c2', rooms: new Set(), join(r) { this.rooms.add(r); }, leave() {}, emit() {} };
    k.room.addHuman(other, { name: 'second', micro: 0, wallet: null, spot: k.room.findSpawn() });
    k.deliver();
    for (let i = 0; i < 3; i++) {
      run(k, c, 50, steer);
      compare(k, c, acc);
    }
    // The wall moves in: frames carry the falling radius and the mirror clips its rings.
    k.g.radiusTarget = () => 905;
    for (let i = 0; i < 1000; i++) {
      const before = k.g.border.radius;
      run(k, c, 1, steer);
      if (k.g.tick % 2 === 0 && k.g.border.radius < before && i % 40 < 6) compare(k, c, acc);
    }
    run(k, c, 60, steer);
    compare(k, c, acc);
    for (const [ev, p] of k.log) {
      if (ev !== 'pp:ev') continue;
      for (const e of p.ev) if (e[0] in counts) counts[e[0]]++;
    }
    assert.strictEqual(k.g.border.radius, 905);
    assert.strictEqual(c.mirror.errors, 0);
    assert.strictEqual(c.net.stats.badFrames, 0);
    assert.strictEqual(c.net.stats.needs, 0, 'a clean stream never needs a resync');
    assert.strictEqual(c.mirror.predictor.stats.snaps, 0);
    for (const rb of rebases) {
      assert.strictEqual(rb.r, 'rebase');
      assert.ok(rb.first || (rb.shrinking && rb.wall < 2), 'an accepted re-base: ' + JSON.stringify(rb));
    }
    assert.ok(rebases.filter(rb => !rb.first).length <= 30, 'only at wall quanta: ' + rebases.length);
    const ins = k.sent.filter(s => s[0] === 'pp:in').length;
    assert.ok(Math.abs(ins - k.g.tick + 200) < 60, 'one pp:in per predicted tick: ' + ins);
  });
  console.log('# e2e ' + JSON.stringify({
    checks: acc.checks, remote: acc.remote, local: acc.local, worstPos: +acc.worstPos.toFixed(4),
    rings: acc.rings, worstRing: +acc.worstRing.toFixed(4), onWall: acc.onWall, worstWall: +acc.worstWall.toFixed(4),
    ringSkipped: acc.ringSkipped, trails: acc.trails, worstTrail: +acc.worstTrail.toFixed(4), adopted: acc.adopted.size, counts,
    rebases: rebases.length
  }));
  assert.ok(acc.checks >= 10, 'checkpoints ' + acc.checks);
  assert.ok(acc.local >= 5, 'the own square was compared ' + acc.local);
  assert.ok(acc.onWall >= 5, 'wall-run vertices compared ' + acc.onWall);
  assert.strictEqual(acc.outside, 0, 'no mirror ring vertex outside the wall');
  assert.ok(acc.trails > 50, 'trails compared ' + acc.trails);
  assert.ok(counts.k > 0 && counts.b > 0 && counts.t > 0 && counts.cap > 0 && counts.j > 0, JSON.stringify(counts));
});

test('renderGameFrame draws the mirror through the stock renderer, unchanged (stub canvas)', () => {
  const saved = { document: globalThis.document, dpr: globalThis.devicePixelRatio, path: globalThis.Path2D, window: globalThis.window };
  let calls = 0;
  function ctxFor(canvas) {
    const store = { canvas };
    return new Proxy(store, {
      get(t, key) {
        if (key in t) return t[key];
        if (key === 'measureText') return () => ({ width: 10 });
        if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => ({ addColorStop() {} });
        if (key === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
        return () => { calls++; };
      },
      set(t, key, v) {
        t[key] = v;
        return true;
      }
    });
  }
  function canvas() {
    const c = { width: 300, height: 150, clientWidth: 1366, clientHeight: 768 };
    c.getContext = () => c.ctx || (c.ctx = ctxFor(c));
    return c;
  }
  globalThis.document = { createElement: () => canvas() };
  globalThis.devicePixelRatio = 1;
  globalThis.window = globalThis; // the stock FloatingLabel.draw reads window directly
  globalThis.Path2D = function Path2D() {
    return new Proxy({}, { get: (t, key) => (key in t ? t[key] : () => {}) });
  };
  try {
    require('../public/js/paper/paperRender.js');
    assert.strictEqual(typeof P.renderGameFrame, 'function');
    withRandom(11, () => {
      const k = arena({ seed: 0.44, warm: 150 });
      const net = new Net.ArenaNet({ socket: k.client, now: () => k.clock.t, onError: (w, e) => { throw e; } });
      const skinManager = new P.SkinManager(new P.ColorSkinPool(undefined), new P.ClassicSkinPool(undefined, null, '', []), 1);
      const m = Mirror.create({ net, view: canvas(), skinManager, seed: 0.5 });
      m.onError = (e) => { throw e; };
      assert.strictEqual(m.visible, true);
      net.join({ name: 'me', stake: 0, entryToken: 'tok' });
      k.room.addHuman(k.server, { name: 'me', micro: 0, wallet: null, spot: k.room.findSpawn() });
      k.deliver();
      const c = { net, mirror: m };
      for (let i = 0; i < 400; i++) {
        run(k, c, 1, (tick) => (tick * 2 * Math.PI) / 150);
        if (i % 4 === 0) m.render();
      }
      assert.strictEqual(m.errors, 0);
      assert.ok(calls > 1000, 'the renderer drew: ' + calls);
      assert.ok(m.origin && Number.isFinite(m.origin.x), 'the camera followed the own square');
    });
  } finally {
    if (saved.document === undefined) delete globalThis.document;
    else globalThis.document = saved.document;
    if (saved.dpr === undefined) delete globalThis.devicePixelRatio;
    else globalThis.devicePixelRatio = saved.dpr;
    if (saved.path === undefined) delete globalThis.Path2D;
    else globalThis.Path2D = saved.path;
    if (saved.window === undefined) delete globalThis.window;
    else globalThis.window = saved.window;
  }
});

test("a coin the local square collects before its ['p+'] is due never stays behind (real net and mirror)", () => {
  const clock = { t: 100 * STEP };
  const handlers = {};
  const socket = { on(ev, fn) { handlers[ev] = fn; }, emit() {}, volatile: { emit() {} } };
  const net = new Net.ArenaNet({ socket, now: () => clock.t, onError: (w, e) => { throw e; } });
  const m = Mirror.create({ net, seed: 0.5 });
  m.onError = (e) => { throw e; };
  const applied = [];
  m.onApplied = (e, tick) => applied.push([tick, e[0], e[1]]);
  handlers['pp:joined'](payload(1, [
    { id: 1, name: 'me', x: 700, y: 700 },
    { id: 2, name: 'two', x: 760, y: 700, micro: 5000 },
    { id: 3, name: 'three', x: 1300, y: 700 }
  ]));
  const fr = (tick) => MP.encodeFrame({
    tick, radius: 950, targetRadius: 950,
    units: [1, 3].map(id => ({ id, x: id === 1 ? 700 : 1300, y: 700, dir: 0, pct: 0.001, baseVer: 1, inId: id })),
    pickups: []
  });
  clock.t = 101 * STEP;
  // 2 dies and drops a coin at tick 102; I pick it up at 104, before renderTick reaches 102.
  handlers['pp:ev']({ tick: 102, ev: [['p+', 7, 760, 700, 5000], ['k', 2, 0, 2, 5000, 7]] });
  handlers['pp:ev']({ tick: 104, ev: [['p-', 7, 1, 5000], ['m', 1, 5000]] });
  assert.deepStrictEqual([...m.pickups.keys()], []);
  assert.deepStrictEqual(applied, [[102, 'p+', 7], [104, 'p-', 7], [104, 'm', 1]], 'the pickup still reports (a HUD floater)');
  assert.strictEqual(m.player.micro, 5000);
  // A coin 3 collects: shown from its tick until the ['p-'] is due.
  handlers['pp:ev']({ tick: 106, ev: [['p+', 8, 1300, 760, 10]] });
  handlers['pp:ev']({ tick: 110, ev: [['p-', 8, 3, 10]] });
  const seen = [];
  for (let t = 102; t < 140; t += 2) {
    clock.t = t * STEP;
    handlers['pp:s'](fr(t));
    m.update(STEP);
    seen.push([Math.floor(m.renderTickNow), [...m.pickups.keys()].join(',')]);
  }
  assert.deepStrictEqual([...m.pickups.keys()], [], 'no coin left behind: ' + JSON.stringify(seen));
  assert.ok(seen.some(([, k]) => k === '8'), 'the other square\'s coin was shown until it went');
  assert.ok(!m.byId.has(2));
  assert.strictEqual(m.errors, 0);
});

// -------------------------------------------------------------------------------------------
// The same arena behind a link with latency: every emit lands oneWay ms later, a broadcast
// reaches the sockets in its room when it is SENT (as Socket.IO does), pp:in can be stalled,
// and the link can drop (the server starts the grace, the client sees 'disconnect') and come
// back on a new socket (the client's 'connect' sends the resume, the server resumes the seat).
// -------------------------------------------------------------------------------------------

function lagArena({ oneWay = 50, seed = 0.42, warm = 200 } = {}) {
  const clock = { t: 1000000 };
  const down = []; // [at, ev, p] towards the client
  const up = []; // [at, ev, p] towards the server
  let link = true;
  let upStall = false;
  let sock = null;
  const toClient = (target, ev, p) => {
    if (sock && (target === sock.id || (target === room.ioRoom && sock.rooms.has(target)))) down.push([clock.t + oneWay, ev, p]);
  };
  const io = {
    to: (target) => ({ emit: (ev, p) => toClient(target, ev, p), volatile: { emit: (ev, p) => toClient(target, ev, p) } })
  };
  const hooks = {};
  for (const h of ['onCashout', 'onTransfer', 'onRefund', 'onSweep', 'onBreach']) hooks[h] = () => {};
  const room = new PaperRoom({ stake: 0, io, hooks, now: () => clock.t, autoTick: false, seed, trim: arenaTrim });
  for (let i = 0; i < warm; i++) {
    clock.t += STEP;
    room.tickOnce();
  }
  let sockets = 0;
  const newSocket = () => {
    const id = 'c' + ++sockets;
    return { id, rooms: new Set(), join(r) { this.rooms.add(r); }, leave(r) { this.rooms.delete(r); }, emit(ev, p) { toClient(id, ev, p); } };
  };
  const handlers = {};
  const k = { clock, room, g: room.game, handlers, ins: [], out: 0, results: [] };
  const client = {
    on(ev, fn) { handlers[ev] = fn; },
    emit(ev, p) { if (link) up.push([clock.t + oneWay, ev, p]); },
    volatile: {
      emit(ev, p) {
        if (ev === 'pp:in') k.out++;
        if (link && !(upStall && ev === 'pp:in')) up.push([clock.t + oneWay, ev, p]);
      }
    }
  };
  function deliver() {
    while (up.length && up[0][0] <= clock.t) {
      const [, ev, p] = up.shift();
      if (ev === 'pp:in') {
        const alive = !k.seat.unit.death;
        k.ins.push({ seq: MP.decodeInput(p).seq, ok: room.setInput(sock.id, p), alive });
      } else if (ev === 'pp:join' && p.resumeKey) {
        assert.ok(!('entryToken' in p), 'a resume carries no token');
        assert.ok(room.resume(sock, k.seat), 'the seat is resumed');
      } else if (ev === 'pp:need') {
        sock.emit('pp:geo', room.geo(p.id));
      }
    }
    while (down.length && down[0][0] <= clock.t) {
      const [, ev, p] = down.shift();
      if (link && handlers[ev]) handlers[ev](p);
    }
  }
  k.connect = () => {
    sock = newSocket();
    const net = new Net.ArenaNet({ socket: client, now: () => clock.t, onError: (w, e) => { throw e; } });
    const m = Mirror.create({ net, seed: 0.5 });
    m.onError = (e) => { throw e; };
    net.join({ name: 'me', stake: 0, entryToken: 'tok' });
    k.seat = room.addHuman(sock, { name: 'me', micro: 0, wallet: null, spot: room.findSpawn() });
    k.net = net;
    k.mirror = m;
  };
  // One page frame and one server tick per step; every own compare is kept as [tick, result].
  k.step = (n, steer) => {
    for (let i = 0; i < n; i++) {
      const a = steer(k.g.tick);
      k.mirror.direction = new P.Vec2(Math.cos(a), Math.sin(a));
      clock.t += STEP;
      k.mirror.update(STEP);
      room.tickOnce();
      const frames = k.net.stats.frames;
      deliver();
      if (k.net.stats.frames !== frames) k.results.push([k.g.tick, k.mirror.lastReconcile]);
    }
  };
  k.drop = () => {
    link = false;
    down.length = 0;
    up.length = 0;
    handlers.disconnect('transport close');
    room.beginGrace(k.seat);
  };
  k.restore = () => {
    link = true;
    sock = newSocket();
    handlers.connect();
  };
  k.stallUp = (on) => { upStall = on; };
  return k;
}

const slowCircle = (tick) => (tick * 2 * Math.PI) / 360;

test('a resume behind 50 ms of latency: no fresh input is refused and prediction comes straight back', () => {
  // Seed 12: under seed 11 a bot cuts the square's trail at tick 821 once inputs count ticks
  // at STEP_MS (night queue item 3); the resume itself behaves the same under every seed tried.
  withRandom(12, () => {
    const k = lagArena({ oneWay: 50 });
    k.connect();
    const pr = k.mirror.predictor;
    k.step(300, slowCircle);
    const oldSeq = pr.seq;
    assert.ok(oldSeq > 0 && oldSeq < 128, 'the old stream would shut the fresh one out: ' + oldSeq);
    k.drop();
    k.step(60, slowCircle); // a second with the link down; the square drives on in its grace
    assert.strictEqual(k.net.resuming, true);
    assert.strictEqual(pr.seq, oldSeq, 'nothing is predicted while the resume is pending');
    const out0 = k.out;
    const ins0 = k.ins.length;
    const snaps0 = pr.stats.snaps;
    const res0 = k.results.length;
    k.restore();
    let waited = 0;
    while (k.net.resuming && waited < 60) {
      k.step(1, slowCircle);
      waited++;
    }
    assert.ok(!k.net.resuming && waited > 0, 'the resume was joined after ' + waited + ' ticks');
    assert.strictEqual(k.out, out0, 'no pp:in between the disconnect and pp:joined');
    k.step(300, slowCircle);
    assert.ok(!k.seat.unit.death, 'the square is still alive (the run means something)');
    const fresh = k.ins.slice(ins0);
    assert.ok(fresh.length > 250, 'inputs after the resume ' + fresh.length);
    assert.strictEqual(fresh[0].seq, 0, 'the fresh stream starts at 0');
    assert.deepStrictEqual(fresh.filter(r => !r.ok).map(r => r.seq), [], 'no fresh input refused');
    assert.strictEqual(pr.stats.snaps - snaps0, 0, 'no snap after the resume');
    const post = k.results.slice(res0).map(r => r[1]);
    assert.strictEqual(post[0], 'stale', 'the old stream\'s ack is not compared');
    const firstReal = post.findIndex(r => r !== 'stale');
    assert.ok(firstReal > 0 && firstReal <= 8, 'compares resume within an RTT: ' + post.slice(0, 12).join(','));
    const tail = k.results.filter(r => r[0] > k.g.tick - 150).map(r => r[1]);
    assert.ok(tail.length >= 70 && tail.every(r => r === 'ok'), 'steady prediction: ' + tail.join(','));
    const rec = k.net.newest().byId.get(k.seat.unit.id);
    assert.ok(pr.entry(rec.ack), 'the acked input is in the ring');
    assert.strictEqual(k.mirror.errors, 0);
  });
});

test('an uplink stall past the 64-entry input ring: snaps stop as soon as acks come back', () => {
  withRandom(11, () => {
    const k = lagArena({ oneWay: 50 });
    k.connect();
    const pr = k.mirror.predictor;
    k.step(300, slowCircle);
    assert.strictEqual(pr.stats.snaps, 0);
    k.stallUp(true);
    k.step(72, slowCircle); // 1.2 s of pp:in lost; frames keep coming
    k.stallUp(false);
    assert.ok(pr.stats.snaps > 0, 'the stall did miss');
    const end = k.g.tick;
    k.step(200, slowCircle);
    assert.ok(!k.seat.unit.death, 'the square is still alive (the run means something)');
    const late = k.results.filter(r => r[0] > end + 20 && r[1] === 'snap');
    assert.deepStrictEqual(late, [], 'no snap once the acks are back in the ring');
    const tail = k.results.filter(r => r[0] > k.g.tick - 150).map(r => r[1]);
    assert.ok(tail.length >= 70 && tail.every(r => r === 'ok'), 'steady prediction: ' + tail.join(','));
    const rec = k.net.newest().byId.get(k.seat.unit.id);
    assert.ok(pr.entry(rec.ack), 'the acked input is in the ring');
    assert.strictEqual(k.mirror.errors, 0);
  });
});
