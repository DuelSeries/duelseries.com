'use strict';
// T14 (design 11 and 12): the shrink and trim soak. A paid PaperRoom with the territory trim
// ON (injected here, so the TRIM_ON constant is not what this test depends on) fills to 16
// wandering humans (two of them wall huggers), scripted exits drive the wall from 950 down to
// 475, and joins bring it back to 950. After EVERY tick: no tick threw, no square died on its
// own push piece, every live square is inside the wall, every push that crossed its own trail
// is accounted for (the pushed square lived), every trail and every ring is simple, and the
// bank is conserved. checkRing runs on every base every 60 ticks. Three runs, each under its
// own Math.random stub (restored after).
//
// Deaths are allowed: wanderers cut each other and themselves as in the reference. What is
// never allowed is a square dying from the shrink itself (brief rule 6). A square pushed across
// ANOTHER player's trail kills that player (owner question 7, default kept): counted, allowed.
//
// PAPER_SOAK_RUNS=n runs n seeds instead of 3 (the listed seeds first, then derived ones);
// PAPER_SOAK_SEEDS=a,b,c runs exactly those.
// The three default seeds each caught a real bug before its fix: 0x51a7e the folded trail
// after a vetoed overlay in a wall corner (ArenaGame._haltMove), 0x7e57ab1e a ring vertex on
// the wall that the trim counted as inside (arenaTrim onWall), 3793674020 a trim whose new wall
// edge crossed the owner's trail (arenaTrim crossesTrail).
const test = require('node:test');
const assert = require('node:assert');
const { PaperRoom } = require('../server/paper/PaperRoom');
const arenaTrim = require('../server/paper/arenaTrim');
const { REASON, P, MP } = require('../server/paper/ArenaGame');

// Later in the list: 3793745285, 395323392 and 395345920 caught the hair-fold at a wall
// (ArenaGame._cutFold), 395370496 the flat capture (ArenaGame flatReturn), 2712184555 the
// spike a trail leaving along its own ring edge merged in (ArenaGame._despike).
const BASE_SEEDS = [0x51a7e, 0x7e57ab1e, 3793674020, 0xc0ffee, 3793674017, 2659873172, 300973056, 2659873176,
  3793745285, 395323392, 395345920, 395370496, 2712184555];
const RUNS = Math.max(1, Number(process.env.PAPER_SOAK_RUNS) || 3);
const SEEDS = [];
for (let i = 0; i < RUNS; i++) SEEDS.push(i < BASE_SEEDS.length ? BASE_SEEDS[i] : (BASE_SEEDS[i % 3] * 2654435761 + i * 7919) >>> 0);
if (process.env.PAPER_SOAK_SEEDS) SEEDS.splice(0, SEEDS.length, ...process.env.PAPER_SOAK_SEEDS.split(',').map(Number));

const TAU = Math.PI * 2;
const BBOX_EPS = 1e-6;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function boxOf(s) {
  return {
    l: Math.min(s.start.x, s.end.x) - BBOX_EPS,
    r: Math.max(s.start.x, s.end.x) + BBOX_EPS,
    t: Math.min(s.start.y, s.end.y) - BBOX_EPS,
    b: Math.max(s.start.y, s.end.y) + BBOX_EPS
  };
}

function boxesMeet(a, b) {
  return a.l <= b.r && b.l <= a.r && a.t <= b.b && b.t <= a.b;
}

// A trail is simple when no two segments at least two apart intersect (the same rule as
// paperArenaGame.test.js trailIsSimple). Checked incrementally: a segment already checked
// against every other one stays checked while both survive (a rewind only removes segments).
function trailCross(unit, memo) {
  const segs = unit.track.polyline.segments;
  const seen = memo.get(unit) || new Set();
  const next = new Set();
  const fresh = [];
  for (let i = 0; i < segs.length; i++) {
    next.add(segs[i]);
    if (!seen.has(segs[i])) fresh.push(i);
  }
  memo.set(unit, next);
  if (!fresh.length) return null;
  const boxes = segs.map(boxOf);
  for (const k of fresh) {
    for (let j = 0; j < segs.length; j++) {
      if (Math.abs(j - k) < 2) continue;
      if (!boxesMeet(boxes[k], boxes[j])) continue;
      const hit = segs[k].intersect(segs[j]);
      if (hit) return { k, j, n: segs.length, x: hit.point.x, y: hit.point.y };
    }
  }
  return null;
}

// A closed ring is simple when no two non-adjacent edges intersect (the rule checkRing uses),
// found by a sweep over x so a 300-vertex ring costs a few hundred intersect calls.
function ringCross(segs) {
  const n = segs.length;
  const items = segs.map((s, i) => ({ i, box: boxOf(s) }));
  items.sort((a, b) => a.box.l - b.box.l);
  const active = [];
  for (const it of items) {
    for (let a = active.length - 1; a >= 0; a--) {
      if (active[a].box.r < it.box.l) active.splice(a, 1);
    }
    for (const o of active) {
      const d = Math.abs(o.i - it.i);
      if (d < 2 || d === n - 1) continue;
      if (!boxesMeet(o.box, it.box)) continue;
      if (segs[it.i].intersect(segs[o.i])) return { i: it.i, j: o.i, n };
    }
    active.push(it);
  }
  return null;
}

function ringChanged(base, memo) {
  const segs = base.polygon.segments;
  const prev = memo.get(base);
  if (prev && prev.length === segs.length) {
    let same = true;
    for (let i = 0; i < segs.length; i++) {
      if (prev[i] !== segs[i]) { same = false; break; }
    }
    if (same) return false;
  }
  memo.set(base, segs.slice());
  return true;
}

function runSoak(seed) {
  const realRandom = Math.random;
  const realError = console.error;
  const errors = [];
  Math.random = mulberry32(seed);
  console.error = (...a) => { errors.push(a.map(String).join(' ')); };
  try {
    return soak(seed, errors);
  } finally {
    Math.random = realRandom;
    console.error = realError;
  }
}

function soak(seed, errors) {
  const rnd = mulberry32(seed ^ 0x9e3779b9); // the driver's own stream
  let now = 7000000;
  const calls = { cashout: 0, transfer: 0, refund: 0, sweep: 0, breach: [] };
  const hooks = {
    onCashout: () => { calls.cashout++; },
    onTransfer: () => { calls.transfer++; },
    onRefund: () => { calls.refund++; },
    onSweep: () => { calls.sweep++; },
    onBreach: (b) => { calls.breach.push(b); }
  };
  const io = { to: () => ({ emit() {}, volatile: { emit() {} } }) };
  const trimCounts = {};
  const trim = {
    trimBase(game, unit) {
      const s = arenaTrim.trimBase(game, unit);
      trimCounts[s] = (trimCounts[s] || 0) + 1;
      return s;
    }
  };
  const room = new PaperRoom({ stake: 0.1, io, hooks, now: () => now, autoTick: false, trim });
  const g = room.game;
  const bank = room.bank;
  const C = g.border.center;

  // Instrumentation (instance wraps only; no server file changes behaviour for the test).
  const crossUnits = [];
  const pieceFor = g._pushPieceFor.bind(g);
  g._pushPieceFor = (unit) => {
    const before = g.stats.pushCrossings;
    const piece = pieceFor(unit);
    if (g.stats.pushCrossings !== before) crossUnits.push(unit);
    return piece;
  };
  let moving = null;
  const dispatch = g.dispatchBucket.bind(g);
  g.dispatchBucket = (bucket, unit, move) => {
    const prev = moving;
    moving = { unit, move };
    try {
      return dispatch(bucket, unit, move);
    } finally {
      moving = prev;
    }
  };
  const bad = [];
  const deaths = {};
  let pushKills = 0;
  const deadThisTick = [];
  const onDeath = room.onDeath.bind(room);
  room.onDeath = (victim, killer, reason, at) => {
    deaths[reason] = (deaths[reason] || 0) + 1;
    deadThisTick.push({ victim, killer, reason });
    if (victim._inPush) bad.push('tick ' + g.tick + ': ' + victim.name + ' died on its own push piece, reason ' + reason);
    if (moving && moving.move && moving.move === moving.unit._pushPiece) {
      if (victim === moving.unit) bad.push('tick ' + g.tick + ': ' + victim.name + ' died while its push piece was dispatched');
      else pushKills++;
    }
    const hit = victim._selfHit;
    if (!killer && hit && hit.segment && victim._pushEnds && victim._pushEnds.has(hit.segment.end)) {
      bad.push('tick ' + g.tick + ': ' + victim.name + ' died crossing a piece a push laid');
    }
    onDeath(victim, killer, reason, at);
  };

  // Seats and steering.
  const humans = [];
  let sockN = 0;
  let nameN = 0;
  function sock() {
    return { id: 'soak' + seed + '-' + ++sockN, join() {}, leave() {}, emit() {} };
  }
  function liveHumans() {
    return humans.filter((h) => !h.u.death);
  }
  function join() {
    const spot = room.findSpawn();
    if (!spot) return false;
    const huggers = liveHumans().filter((h) => h.kind === 'hugger').length;
    const s = sock();
    const micro = rnd() < 0.5 ? 100000 : 1000000;
    const seat = room.addHuman(s, { name: 'h' + ++nameN, micro, wallet: 'W' + s.id, spot });
    humans.push({
      s,
      seat,
      u: seat.unit,
      seq: 0,
      kind: huggers < 2 ? 'hugger' : 'wander',
      state: 'home',
      heading: 0,
      until: 0,
      maxLen: 0,
      dir: rnd() < 0.5 ? 1 : -1,
      exit: null,
      lastByte: 0
    });
    return true;
  }
  let exitN = 0;
  function exitOne() {
    const pool = liveHumans().filter((h) => h.kind !== 'hugger' && !h.exit);
    if (!pool.length) return false;
    const h = pool[Math.floor(rnd() * pool.length)];
    const how = ['hold', 'grace', 'leave'][exitN++ % 3];
    h.exit = how;
    if (how === 'grace') room.beginGrace(h.seat);
    else if (how === 'leave') room.removeHuman(h.u.id, REASON.LEAVE);
    return true;
  }
  const phiOf = (u) => Math.atan2(u.position.y - C.y, u.position.x - C.x);
  const toWallOf = (u) => g.border.radius - u.position.distance(C);
  function homeAngle(u) {
    let best = null;
    let bestD = Infinity;
    for (const s of u.base.polygon.segments) {
      const d = s.start.distanceSq(u.position);
      if (d < bestD) { bestD = d; best = s.start; }
    }
    return Math.atan2(best.y - u.position.y, best.x - u.position.x);
  }
  function steerOf(h) {
    const u = h.u;
    const home = u.in === u.base;
    if (h.kind === 'hugger') {
      if (h.state === 'home') {
        if (!home) return homeAngle(u);
        h.state = 'toWall';
        h.dir = rnd() < 0.5 ? 1 : -1;
      }
      if (h.state === 'toWall') {
        if (toWallOf(u) > 3) return phiOf(u);
        h.state = 'slide';
        h.until = g.tick + 300 + Math.floor(rnd() * 600);
      }
      if (g.tick >= h.until) {
        h.state = 'home';
        return homeAngle(u);
      }
      const bias = toWallOf(u) > 2 ? 0.6 : 0.15;
      return phiOf(u) + h.dir * (Math.PI / 2 - bias);
    }
    if (h.state === 'home') {
      if (!home) return homeAngle(u);
      h.state = 'out';
      h.heading = rnd() * TAU;
      h.until = g.tick + 60 + Math.floor(rnd() * 240);
      h.maxLen = 200 + rnd() * 700;
    }
    if (g.tick >= h.until || u.track.length > h.maxLen) {
      h.state = 'home';
      return homeAngle(u);
    }
    h.heading += (rnd() - 0.5) * 0.12;
    return h.heading;
  }

  // The script: fill to 16 at 950, shrink to 8 then 4 (475), hold, grow back to 16 (950), hold.
  const phases = ['fill', 'hold1', 'shrinkA', 'shrinkB', 'bottom', 'regrow', 'hold2', 'done'];
  let phase = 0;
  let phaseTick = 0;
  let lastJoin = -1000;
  let lastExit = -1000;
  let minR = Infinity;
  let maxR = 0;
  let reachedMin = false;
  let regrewMax = false;
  const trailMemo = new Map();
  const ringMemo = new Map();
  let maxTrail = 0;
  let maxRing = 0;
  let ringChecks = 0;
  const MAX_TICKS = 20000;

  const t0 = Date.now();
  let t = 0;
  for (; t < MAX_TICKS && phases[phase] !== 'done'; t++) {
    const live = liveHumans();
    const n = live.length;
    const R = g.border.radius;
    const name = phases[phase];
    const next = () => { phase++; phaseTick = t; };
    if (name === 'fill') {
      if (n < 16 && t - lastJoin >= 10 && join()) lastJoin = t;
      if (n === 16 && R === MP.R_MAX) next();
    } else if (name === 'hold1') {
      if (n < 16 && t - lastJoin >= 10 && join()) lastJoin = t;
      if (t - phaseTick >= 600) next();
    } else if (name === 'shrinkA') {
      if (n > 8 && t - lastExit >= 20 && exitOne()) lastExit = t;
      if (n < 4 && t - lastJoin >= 10 && join()) lastJoin = t;
      if (R <= 700) next();
    } else if (name === 'shrinkB') {
      if (n > 4 && t - lastExit >= 20 && exitOne()) lastExit = t;
      if (n < 4 && t - lastJoin >= 10 && join()) lastJoin = t;
      if (R === MP.R_MIN) { reachedMin = true; next(); }
    } else if (name === 'bottom') {
      if (n < 4 && t - lastJoin >= 10 && join()) lastJoin = t;
      if (t - phaseTick >= 300) next();
    } else if (name === 'regrow') {
      if (n < 16 && t - lastJoin >= 20 && join()) lastJoin = t;
      if (n === 16 && R === MP.R_MAX) { regrewMax = true; next(); }
    } else if (name === 'hold2') {
      if (n < 16 && t - lastJoin >= 10 && join()) lastJoin = t;
      if (t - phaseTick >= 300) next();
    }

    for (const h of liveHumans()) {
      if (!h.seat.socketId) continue; // in grace: the square keeps its last steering
      const hold = h.exit === 'hold';
      const byte = hold ? h.lastByte : MP.angleToByte(steerOf(h));
      h.lastByte = byte;
      h.seq = (h.seq + 1) & 255;
      room.setInput(h.s.id, MP.encodeInput(h.seq, byte, hold));
    }

    crossUnits.length = 0;
    deadThisTick.length = 0;
    const crossBefore = g.stats.pushCrossings;
    now += MP.STEP_MS;
    const ok = room.tickOnce();
    const at = 'seed ' + seed + ' tick ' + g.tick + ' (' + name + ', r ' + g.border.radius + ')';

    assert.ok(ok, 'the tick threw at ' + at + ': ' + errors.slice(-3).join(' | '));
    assert.strictEqual(room.failCount, 0, at);
    assert.deepStrictEqual(bad, [], at);
    for (const u of g.units) {
      if (u.death) continue;
      assert.ok(MP.wallInside(g.border, u.position.x, u.position.y), u.name + ' outside the wall at ' + at);
    }
    assert.strictEqual(g.stats.pushCrossings - crossBefore, crossUnits.length, 'pushCrossings at ' + at);
    for (const u of crossUnits) {
      const d = deadThisTick.find((x) => x.victim === u);
      assert.ok(!d || d.killer, u.name + ' died on a push that crossed its trail at ' + at + ' (reason ' + (d && d.reason) + ')');
    }
    for (const u of g.units) {
      if (u.death) continue;
      const tc = trailCross(u, trailMemo);
      assert.strictEqual(tc, null, u.name + ' trail not simple at ' + at + ': ' + JSON.stringify(tc));
      if (u.track.polyline.segments.length > maxTrail) maxTrail = u.track.polyline.segments.length;
      const base = u.base;
      if (base.polygon.segments.length > maxRing) maxRing = base.polygon.segments.length;
      if (ringChanged(base, ringMemo)) {
        const rc = ringCross(base.polygon.segments);
        assert.strictEqual(rc, null, u.name + ' ring not simple at ' + at + ': ' + JSON.stringify(rc));
      }
    }
    if (g.tick % 60 === 0) {
      for (const u of g.units) {
        if (u.death) continue;
        ringChecks++;
        const why = arenaTrim.checkRing(u.base);
        assert.strictEqual(why, null, u.name + ' checkRing at ' + at + ': ' + why);
      }
    }
    assert.strictEqual(bank.totalMicro(), bank.ledger.inMicro - bank.ledger.outMicro, 'bank at ' + at);
    assert.ok(Math.abs(room.liveStakeTotal() * 1e6 - (bank.accountsMicro() + bank.floorMicro())) < 1e-3, 'liability at ' + at);
    assert.deepStrictEqual(calls.breach, [], at);

    for (let i = humans.length - 1; i >= 0; i--) {
      if (humans[i].u.death) {
        trailMemo.delete(humans[i].u);
        humans.splice(i, 1);
      }
    }
    if (g.border.radius < minR) minR = g.border.radius;
    if (g.border.radius > maxR) maxR = g.border.radius;
  }

  const critical = errors.filter((e) => e.includes('TICK threw') || e.includes('CRITICAL') || e.includes('LEDGER'));
  assert.deepStrictEqual(critical, []);
  assert.strictEqual(phases[phase], 'done', 'the script finished inside ' + MAX_TICKS + ' ticks, stuck in ' + phases[phase]);
  assert.ok(reachedMin && minR === MP.R_MIN, 'the wall reached 475: ' + minR);
  assert.ok(regrewMax && maxR === MP.R_MAX && g.border.radius === MP.R_MAX, 'the wall grew back to 950');
  assert.ok(trimCounts.trimmed > 0, 'the trim really cut land: ' + JSON.stringify(trimCounts));
  assert.ok(calls.cashout > 0, 'a scripted exit cashed out');
  const report = {
    seed,
    ticks: t,
    ms: Date.now() - t0,
    deaths,
    pushCrossings: g.stats.pushCrossings,
    shrinkVetoes: g.stats.shrinkVetoes,
    foldCuts: g.stats.foldCuts,
    flatReturns: g.stats.flatReturns,
    despiked: g.stats.despiked,
    pushKills,
    trim: trimCounts,
    gaveUp: errors.filter((e) => e.includes('TRIM gave up')).length,
    ringChecks,
    maxTrail,
    maxRing,
    joins: nameN,
    cashouts: calls.cashout,
    transfers: calls.transfer,
    sweeps: calls.sweep
  };
  console.log('# soak ' + JSON.stringify(report));
  return report;
}

for (const seed of SEEDS) {
  test('soak seed ' + seed + ': 16 wanderers, 950 to 475 and back with the trim on', { timeout: 300000 }, () => {
    const before = Math.random;
    runSoak(seed);
    assert.ok(Math.random === before, 'Math.random restored');
  });
}

test('the trim is switched on for every room by default (T14 ship gate)', () => {
  const { TRIM_ON } = require('../server/paper/PaperRoom');
  assert.strictEqual(TRIM_ON, true);
  const io = { to: () => ({ emit() {}, volatile: { emit() {} } }) };
  const hooks = { onCashout() {}, onTransfer() {}, onRefund() {}, onSweep() {}, onBreach() {} };
  const room = new PaperRoom({ stake: 0.1, io, hooks, autoTick: false });
  assert.ok(room.game.trim === arenaTrim, 'a default room trims through arenaTrim');
  const off = new PaperRoom({ stake: 0.1, io, hooks, autoTick: false, trim: null });
  assert.ok(off.game.trim === null, 'trim: null still turns it off');
});
