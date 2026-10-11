'use strict';
// slither.io free room: the pure, seeded world sim (SERVER-DESIGN 3.1, 5.3, 6; tasks T4 snake half, T6 world half).
//
// createSim(laws, opts) -> the sim. Deterministic: no Math.random, no Date, no io; every random draw comes from its
// own slRng stream; arrays in fixed order. The same seed and the same calls give the same digest() to the last bit.
//
// opts:
//   seed      the room seed (required)
//   startMs   sim time of the room start (default 0); the sim clock is startMs + tick x L7
//   border    true: the sim owns the moving border (slBorder, task T7); flux() is its radius, the L38 border kill is
//             on and a spawn with no position goes on an L42 ring. false (default): no border, no border kill.
//   food      true: the sim owns the food store (slFood, task T5): L29 passes, L31 eats, boost and death drops become
//             foods. Needs the border. false (default): drops are logged only.
//   prey      true: the sim owns the prey (slPrey, task T5). Needs the border. The prey rows are SUGGESTED, so the
//             room asks slPrey.assertPreyShippable before it turns this on (BUILD-DECISIONS T5).
//   fill      the L26 initial food fill at creation (default: on when food is on)
//   world     true: shorthand for border, food, prey and fill on (each can still be turned off by name)
//   idBlocked (id) -> true for ids the room still quarantines (C_ID_QUARANTINE_MS)
// The bare sim (no options) is the snake engine with collisions between snakes, which is what the T4 tests run.
//
// The room drives one tick as SERVER-DESIGN 5.3 says:
//   setInput(id, record, offsetMs)   on arrival, any time between ticks (merged into the snake's input slot)
//   applyInputs()                     step 1: a held snake stores its steering (C_HOLD_STEER); the steering records
//                                     (L15) and the boost records wait for the update, each at its arrival time
//                                     (L22 and L23 in time order inside it, slSnake boostTimeline)
//   setHold(id, mult | null, offset)  step 2: the sim side of slHold (steering lock, speed multiplier, release)
//   step()                            steps 4, 5 and 7: every live snake updated once in a seeded order, eats,
//                                     collisions and deaths, then the food, prey and border clocks
// step() returns the tick log (valid until the next step):
//   updates  the update record of each updated snake in processing order (slSnake newRec)
//   drops    the boost drops of the tick ({kind 'boost', id, x, y, b, cv, c, food}; c the charge mass, food the placed
//            food or null)
//   boosts   the boost records the updates read (slSnake boostTimeline, task T14b): a 253 while not boosting
//            {id, on: true, off, ok, L (sct + fam at the press), frac (L13.first)}, and each boost a 254 or a hold
//            start ended {id, on: false, off, hold}; a self-stop at the minimum length is not listed
//   charges  every L23 charge of the tick, flat [id, window ms, ...]: its time is the tick's sim time - P + window ms
//   deaths   one record per death in processing order: {id, cause 'snake' | 'border' | 'kill', killer (0 = none),
//            headOn, x, y (the head), sct, fam, cv, drops [{x, y, b, cv, food}]}
// plus, when on, food.tick (adds, eats) and preys.tick (adds, moves, removes, eats) of the same tick.
//
// Sections:
//   1. laws the sim reads
//   2. SNAKE HALF (task T4): spawn, inputs, hold, the per-snake update, feeding, removal
//   3. WORLD HALF (task T6): eating, collisions, the head-on rule, deaths, death drops, kills, border kill, spawn ring
//   4. the tick
//   5. digest and checks

const { assertLawsComplete, assertRulesBuilt, STATUS } = require('./slLaws');
const { streams, streamStates, shuffleInPlace, streamSeed, createRng } = require('./slRng');
const { createGrid } = require('./slGrid');
const { createBorder } = require('./slBorder');
const { createFood } = require('./slFood');
const { createPrey } = require('./slPrey');
const slSnake = require('./slSnake');

const PI2 = 2 * Math.PI;

// =====================================================================================================================
// 1. Laws the sim reads (the union of both halves)

const SIM_OWN_LAW_IDS = Object.freeze(['L1', 'L2.size']);

// World half (T6): eat zone, collisions, head-on, own body, border kill, death drops, kill credit, spawn ring, spawn
// protection.
const WORLD_TABLE_IDS = Object.freeze(['L31', 'L35', 'L36', 'L37', 'L38', 'L39.count', 'L39.rad', 'L39.place',
  'L39.colour.skin', 'L40', 'L42.ring', 'L42.k', 'L42.clear', 'L49']);
const WORLD_RULES_BUILT = Object.freeze(['eatDisc', 'collideB', 'biggerWins', 'ownBodySafe', 'borderKill', 'deathDrops',
  'interpTable', 'alongBodyDisc', 'skinDropTable', 'killCreditOwnSeat', 'spawnRing']);

// Our own row the world half needs that the law table does not hold yet (the slPrey PREY_ROWS precedent: slLaws.js is
// not this task's file). The law table wins when it holds the same id. T1 follow-up: copy it into slLaws.js and
// SERVER-LAWS section N.
const WORLD_ROWS = Object.freeze({
  C_SPAWN_TRIES: Object.freeze({
    id: 'C_SPAWN_TRIES',
    name: 'Spawn ring draws at most this many times for the L42 clearance; when every draw fails the snake spawns at the draw farthest from any body point',
    status: STATUS.CHOSEN,
    value: 64,
    unit: 'draws',
    source: 'CHOSEN: engineering bound (task T6, BUILD-DECISIONS). L42.clear says "draw again" with no limit; a small ' +
      'map full of long snakes (2923 radius at 22 snakes) can leave no clear point at all, and an unbounded loop would ' +
      'stall the room. A player sees it only when no clear point exists.',
  }),
});
const WORLD_ROW_IDS = Object.freeze(Object.keys(WORLD_ROWS));
const WORLD_LAW_IDS = Object.freeze(WORLD_TABLE_IDS.concat(WORLD_ROW_IDS));

const SIM_LAW_IDS = Object.freeze(Array.from(new Set(SIM_OWN_LAW_IDS.concat(slSnake.SNAKE_LAW_IDS, WORLD_TABLE_IDS))));

const MAX_ID = 65535; // snake ids are u16 on the wire and never 0 (SERVER-DESIGN 6.1)

function bad(id, what) {
  throw new Error('slSim: law ' + id + ' ' + what + '; this build implements only the form SERVER-LAWS states');
}

function num(v, id, what) {
  if (typeof v !== 'number' || !Number.isFinite(v)) bad(id, what + ' is not a finite number');
  return v;
}

// A rule row must hold exactly these keys (rule plus params); fixed params must have the built value.
function form(id, v, keys, fixed) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) bad(id, 'is not a rule row');
  for (const k of Object.keys(v)) if (k !== 'rule' && keys.indexOf(k) < 0) bad(id, 'parameter ' + k + ' is not built');
  for (const k of keys) if (!Object.prototype.hasOwnProperty.call(v, k)) bad(id, 'has no ' + k);
  const f = fixed || {};
  for (const k of Object.keys(f)) if (v[k] !== f[k]) bad(id, k + ' = ' + JSON.stringify(v[k]) + ' is not built (built: ' + JSON.stringify(f[k]) + ')');
  return v;
}

// The world rows: the table's row when it has the id, else WORLD_ROWS.
function worldTable(laws) {
  assertLawsComplete(laws, WORLD_TABLE_IDS);
  const t = {};
  for (const id of WORLD_TABLE_IDS) t[id] = laws[id];
  for (const id of WORLD_ROW_IDS) t[id] = Object.prototype.hasOwnProperty.call(laws, id) ? laws[id] : WORLD_ROWS[id];
  return t;
}

// Reads every number the world half needs, once, and checks each form against what this file builds.
function worldLaws(laws) {
  const t = worldTable(laws);
  assertLawsComplete(t, WORLD_LAW_IDS);
  assertRulesBuilt(t, WORLD_LAW_IDS, WORLD_RULES_BUILT);
  const v = (id) => t[id].value;

  const eat = form('L31', v('L31'), ['k0', 'k1', 'r0', 'r1', 'lean', 'every'], { lean: 'halfway', every: 'update' });
  const col = form('L35', v('L35'), ['f1', 'a', 'body'], { body: 'capsule' });
  form('L36', v('L36'), ['size', 'tie'], { size: 'L', tie: 'seededCoin' });
  form('L37', v('L37'), []);
  const bk = form('L38', v('L38'), ['f1', 'm']);
  const cnt = form('L39.count', v('L39.count'), ['perPoint', 'extra', 'border'], { border: 0 });
  const rad = form('L39.rad', v('L39.rad'), ['points', 'below', 'above']);
  const pl = form('L39.place', v('L39.place'), ['perPoint', 'atHead', 'r0', 'r1']);
  const skin = form('L39.colour.skin', v('L39.colour.skin'), ['plain', 'measured', 'pattern', 'otherwise'],
    { plain: 'own', otherwise: 'cvMod9' });
  form('L40', v('L40'), []);
  const ring = form('L42.ring', v('L42.ring'), ['q', 'c']);
  const kr = v('L42.k');
  const clear = num(v('L42.clear'), 'L42.clear', 'clearance');
  const prot = num(v('L49'), 'L49', 'spawn protection');
  const tries = v('C_SPAWN_TRIES');

  if (!Number.isInteger(cnt.perPoint) || cnt.perPoint < 0 || !Number.isInteger(cnt.extra) || cnt.extra < 0) {
    bad('L39.count', 'perPoint and extra must be integers >= 0');
  }
  if (pl.perPoint !== cnt.perPoint || pl.atHead !== cnt.extra) bad('L39.place', 'perPoint and atHead differ from L39.count');
  if (!Array.isArray(rad.points) || rad.points.length < 2) bad('L39.rad', 'needs at least two points');
  let last = -Infinity;
  for (const p of rad.points) {
    if (!Array.isArray(p) || p.length !== 2 || !Number.isInteger(p[0]) || !Number.isInteger(p[1]) || p[0] <= last) {
      bad('L39.rad', 'points must be [sct, byte] integer pairs with rising sct');
    }
    if (p[1] < 0 || p[1] > 255) bad('L39.rad', 'a byte is outside 0..255');
    last = p[0];
  }
  if (rad.below !== rad.points[0][1] || rad.above !== rad.points[rad.points.length - 1][1]) {
    bad('L39.rad', 'below and above must hold the first and last bytes');
  }
  if (!kr || !Number.isInteger(kr.min) || !Number.isInteger(kr.max) || kr.min < 0 || kr.max < kr.min) {
    bad('L42.k', 'needs integers min <= max');
  }
  if (Object.keys(kr).some((k) => k !== 'min' && k !== 'max')) bad('L42.k', 'has a parameter that is not built');
  if (!(clear >= 0)) bad('L42.clear', 'must be >= 0');
  if (!(prot >= 0)) bad('L49', 'must be >= 0');
  if (!Number.isInteger(tries) || tries < 1) bad('C_SPAWN_TRIES', 'must be an integer >= 1');

  return Object.freeze({
    eatK0: num(eat.k0, 'L31', 'k0'),
    eatK1: num(eat.k1, 'L31', 'k1'),
    eatR0: num(eat.r0, 'L31', 'r0'),
    eatR1: num(eat.r1, 'L31', 'r1'),
    f1: num(col.f1, 'L35', 'f1'),
    a: num(col.a, 'L35', 'a'),
    borderF1: num(bk.f1, 'L38', 'f1'),
    borderM: num(bk.m, 'L38', 'm'),
    perPoint: cnt.perPoint,
    atHead: cnt.extra,
    radPoints: Object.freeze(rad.points.map((p) => Object.freeze([p[0], p[1]]))),
    radBelow: rad.below,
    radAbove: rad.above,
    placeR0: num(pl.r0, 'L39.place', 'r0'),
    placeR1: num(pl.r1, 'L39.place', 'r1'),
    skinK: Object.freeze({ skinDrop: skin }), // the shape slSnake.dropColour reads
    ringQ: num(ring.q, 'L42.ring', 'q'),
    ringC: num(ring.c, 'L42.ring', 'c'),
    kMin: kr.min,
    kMax: kr.max,
    clear,
    protectMs: prot,
    spawnTries: tries,
  });
}

// L39.rad: the death drop rad byte of a victim of length sct: the byte linearly interpolated between the measured
// (sct, byte) points and rounded (half up), the first byte below the first point and the last above the last.
function deathRadByte(W, sct) {
  const p = W.radPoints;
  if (sct <= p[0][0]) return W.radBelow;
  if (sct >= p[p.length - 1][0]) return W.radAbove;
  for (let i = 0; i < p.length - 1; i++) {
    const s1 = p[i + 1][0];
    if (sct <= s1) {
      const s0 = p[i][0];
      const b0 = p[i][1];
      return Math.round(b0 + (p[i + 1][1] - b0) * (sct - s0) / (s1 - s0));
    }
  }
  return W.radAbove;
}

// ------------------------------------------------------------------ geometry (pure)

// Squared distance from point (px, py) to the segment (ax, ay)-(bx, by).
function pointSegDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = 0;
  if (l2 > 0) {
    t = ((px - ax) * dx + (py - ay) * dy) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  const ex = ax + t * dx - px;
  const ey = ay + t * dy - py;
  return ex * ex + ey * ey;
}

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

// Squared distance between the segments p0-p1 and a-b (closest points of two segments, Ericson 5.1.9).
function segSegDist2(p0x, p0y, p1x, p1y, ax, ay, bx, by) {
  const d1x = p1x - p0x;
  const d1y = p1y - p0y;
  const d2x = bx - ax;
  const d2y = by - ay;
  const rx = p0x - ax;
  const ry = p0y - ay;
  const a = d1x * d1x + d1y * d1y;
  const e = d2x * d2x + d2y * d2y;
  const f = d2x * rx + d2y * ry;
  let s;
  let t;
  if (a === 0 && e === 0) return rx * rx + ry * ry;
  if (a === 0) {
    s = 0;
    t = clamp01(f / e);
  } else {
    const c = d1x * rx + d1y * ry;
    if (e === 0) {
      t = 0;
      s = clamp01(-c / a);
    } else {
      const b = d1x * d2x + d1y * d2y;
      const denom = a * e - b * b;
      s = denom > 0 ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp01(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp01((b - c) / a);
      }
    }
  }
  const qx = p0x + d1x * s - (ax + d2x * t);
  const qy = p0y + d1y * s - (ay + d2y * t);
  return qx * qx + qy * qy;
}

function createSim(laws, opts) {
  const o = opts || {};
  if (typeof o.seed !== 'number' || !Number.isFinite(o.seed)) throw new TypeError('slSim: seed must be a finite number');
  assertLawsComplete(laws, SIM_LAW_IDS);
  const K = slSnake.snakeLaws(laws);
  const W = worldLaws(laws);
  const grd = laws.L1.value;
  const grid = createGrid({ sectorSize: laws['L2.size'].value, grd });
  const rng = streams(o.seed);
  // Two streams of the world half, keyed by name like slRng's own (a new stream never shifts another): 'death' for
  // the L39 drop places and colours, 'coin' for the L36 equal-size coin. The spawn ring draws from 'spawn'.
  const wrng = Object.freeze({
    death: createRng(streamSeed(o.seed, 'death')),
    coin: createRng(streamSeed(o.seed, 'coin')),
  });
  // The room may block ids a seat could still hold (C_ID_QUARANTINE_MS, SERVER-DESIGN 8.1); the sim never reuses a
  // live id either way.
  const idBlocked = typeof o.idBlocked === 'function' ? o.idBlocked : null;
  const startMs = o.startMs === undefined ? 0 : o.startMs;
  if (typeof startMs !== 'number' || !Number.isFinite(startMs)) throw new TypeError('slSim: startMs must be a finite number');
  const pick = (name) => (o[name] === undefined ? o.world === true : o[name] === true);
  const hasBorder = pick('border');
  const hasFood = pick('food');
  const hasPrey = pick('prey');
  if ((hasFood || hasPrey) && !hasBorder) throw new Error('slSim: food and prey need the border (their passes read the flux)');
  const doFill = o.fill === undefined ? hasFood : o.fill === true;
  if (doFill && !hasFood) throw new Error('slSim: fill needs the food store');

  const live = []; // live snakes in spawn order
  const byId = new Map();
  const order = []; // reused per tick: the seeded update order
  const victims = []; // reused per tick
  const pendingKills = []; // ids sim.kill() asked for; they die at the start of the next step
  const log = { tick: 0, updates: [], drops: [], deaths: [], boosts: [], charges: [] };
  let tick = 0;
  let nowMs = startMs;
  let nextId = 1;

  const border = hasBorder ? createBorder(laws, { nowMs: startMs, count: 0 }) : null;
  const food = hasFood ? createFood(laws, { grid, rng: rng.food, startMs }) : null;
  const preys = hasPrey ? createPrey(laws, { rng: rng.prey, startMs }) : null;
  if (doFill) food.fill(border.radius());

  const sim = { K, W, grid, rng, wrng, log };

  // ===================================================================================================================
  // 2. SNAKE HALF (task T4)

  function takeId() {
    for (let tries = 0; tries < MAX_ID; tries++) {
      const id = nextId;
      nextId = nextId >= MAX_ID ? 1 : nextId + 1;
      if (byId.has(id)) continue;
      if (idBlocked && idBlocked(id)) continue;
      return id;
    }
    throw new Error('slSim: no free snake id');
  }

  function finite(v, what) {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError('slSim: ' + what + ' must be a finite number');
    return v;
  }

  // A new snake in the L20 spawn state. x, y: the head; both absent = an L42 ring point (needs the border). ang:
  // heading; absent = uniform over 0 to 2 pi from the 'spawn' stream (L20). cv: colour or skin (checked by the
  // handshake, L45 and C_CONN). sct and fam other than L20 are for tests and tools only.
  function spawn(spec) {
    const p = spec || {};
    let x = p.x;
    let y = p.y;
    if (x === undefined && y === undefined) {
      if (!border) throw new TypeError('slSim: spawn needs x and y when the sim has no border (the L42 ring reads the flux)');
      ringPoint();
      x = ringAt[0];
      y = ringAt[1];
    } else if (x === undefined || y === undefined) {
      throw new TypeError('slSim: spawn needs both x and y, or neither');
    }
    finite(x, 'spawn x');
    finite(y, 'spawn y');
    const ang = p.ang === undefined ? rng.spawn.next() * 2 * Math.PI : finite(p.ang, 'spawn ang');
    if (!Number.isInteger(p.cv) || p.cv < 0) throw new TypeError('slSim: cv must be an integer >= 0');
    const id = takeId();
    const s = slSnake.createSnake(K, id, { x, y, ang, cv: p.cv, nick: p.nick === undefined ? '' : String(p.nick), sct: p.sct, fam: p.fam });
    for (let i = 0; i < s.pts.length; i++) {
      s.pts[i].seq = i;
      grid.addPoint(id, s.pts[i]);
    }
    worldFields(s);
    live.push(s);
    byId.set(id, s);
    return s;
  }

  // One decoded input record (shared/slWire.js decodeInput) for snake id, offsetMs = ms from its arrival to the start
  // of the tick that applies it (C_INPUT_OFFSET, SERVER-DESIGN 5.1). Steering (angle bytes, arrow ticks) is kept in
  // arrival order with its offset and each takes effect at its own arrival time inside the update (slSnake queueSteer,
  // travel; their server turns per ms from the arrival, recordings/TURNING.md); records of one arrival collapse (an
  // angle replaces what came with it, arrow ticks add up). Boost on and off kept in arrival order with repeats
  // collapsed. A ping is the room's (L47). Returns false when the snake is gone.
  function setInput(id, rec, offsetMs) {
    const s = byId.get(id);
    if (!s) return false;
    if (!rec || typeof rec !== 'object') throw new TypeError('slSim: input record must be an object');
    const off = offsetMs === undefined ? 0 : offsetMs;
    if (typeof off !== 'number' || !Number.isFinite(off) || off < 0) throw new RangeError('slSim: offsetMs must be >= 0');
    if (rec.type === 'angle') {
      if (!Number.isInteger(rec.q) || rec.q < 0 || rec.q > K.maxAngle) throw new RangeError('slSim: angle byte out of range');
      slSnake.queueSteer(K, s, 0, rec.q, off);
    } else if (rec.type === 'turn') {
      if (!Number.isInteger(rec.v) || rec.v < 0) throw new RangeError('slSim: turn ticks must be an integer >= 0');
      if (rec.dir === 'left') slSnake.queueSteer(K, s, 1, -rec.v, off);
      else if (rec.dir === 'right') slSnake.queueSteer(K, s, 1, rec.v, off);
      else throw new RangeError('slSim: turn dir must be left or right');
    } else if (rec.type === 'boost') {
      if (typeof rec.on !== 'boolean') throw new TypeError('slSim: boost on must be a boolean');
      const b = s.inBoost;
      const on = rec.on ? 1 : 0;
      if (b.length === 0 || b[b.length - 2] !== on) b.push(on, off);
    } else if (rec.type !== 'ping') {
      throw new RangeError('slSim: unknown input type ' + String(rec.type));
    }
    return true;
  }

  // Step 1 of the tick: every snake's slot applied, in spawn order.
  function applyInputs() {
    for (let i = 0; i < live.length; i++) slSnake.applyInputSlot(K, live[i]);
  }

  // Step 2 (sim side of slHold): mult in (0, 1] holds the snake this update, null releases it.
  function setHold(id, mult, offsetMs) {
    const s = byId.get(id);
    if (!s) return false;
    const off = offsetMs === undefined ? 0 : offsetMs;
    if (typeof off !== 'number' || !Number.isFinite(off) || off < 0) throw new RangeError('slSim: offsetMs must be >= 0');
    slSnake.setHold(K, s, mult, off);
    return true;
  }

  // L18 and L34 eats (the world half calls slSnake directly from the eat zone; tests and tools call these).
  function feed(id, b) {
    const s = byId.get(id);
    if (!s) return false;
    if (!Number.isInteger(b) || b < 0 || b > 255) throw new RangeError('slSim: food rad byte must be 0..255');
    slSnake.feedFood(K, s, b);
    return true;
  }

  function feedPrey(id, rad) {
    const s = byId.get(id);
    if (!s) return false;
    finite(rad, 'prey radius');
    slSnake.feedPrey(K, s, rad);
    return true;
  }

  // Takes a snake out of the world: every point out of the grid, out of the live list.
  function takeOut(s) {
    for (const p of s.pts) grid.removePoint(p);
    s.alive = false;
    byId.delete(s.id);
    live.splice(live.indexOf(s), 1);
    const k = pendingKills.indexOf(s.id);
    if (k >= 0) pendingKills.splice(k, 1);
  }

  // Takes a snake out of the world with no drops and no record (a leave or a cash-out, C_CASHOUT_CODE). The room
  // sends its removal.
  function remove(id) {
    const s = byId.get(id);
    if (!s) return false;
    takeOut(s);
    return true;
  }

  function snake(id) {
    return byId.get(id) || null;
  }

  function forEachSnake(fn) {
    for (let i = 0; i < live.length; i++) fn(live[i]);
  }

  // ===================================================================================================================
  // 3. WORLD HALF (task T6)
  //
  // The tick (section 4) runs the world in three phases, so every snake that dies dies at the SAME instant, the end
  // of the update all snakes share (Owen, OWNER-ANSWERS.md:93: "head-on at the same instant: the bigger snake wins"):
  //   A  each snake in the seeded order: its eat zone taken where the update starts, its update (T4), its boost drops
  //      placed, then its eats in that zone (L31, L18, L34; the eat's fam goes out at the next update, L48.hDefer)
  //   B  each snake: its L35 test point against every other snake's body as it stands after A (capsules between the
  //      pulled points and from the newest point to the head); L37 skips its own body; L38 the border
  //   C  L36: when two snakes would kill each other in the same update, only one dies: the smaller by L = sct + fam,
  //      equal L a coin from the 'coin' stream, never the join order. Then each victim dies in the processing order:
  //      L39 drops (none at the border), L40 kill credit, out of the world.
  // A snake killed in C still counted as a body for every test of B (same instant), so the outcome never depends on
  // the update order.

  // Per-snake fields the world half keeps (set at spawn).
  function worldFields(s) {
    s.kills = 0; // L40: kills credited to this snake
    s.bornMs = nowMs; // L49
    s.sc = slSnake.speedSc(K, s.pts.length); // the client's size factor (SERVER-LAWS units, the L12 sc)
    s.ez = { x: 0, y: 0, ang: 0, wang: 0, sp: 0, sct: 0 }; // L31: the state the eat zone is taken from
    s.hx = slSnake.headX(s);
    s.hy = slSnake.headY(s);
    s.tpx = s.hx + W.f1 * s.sc * Math.cos(s.ang); // the L35 test point of the last test (the sweep start)
    s.tpy = s.hy + W.f1 * s.sc * Math.sin(s.ang);
    s.ord = -1; // index in this tick's processing order
    s.hits = []; // ids of the snakes the test point touched this tick
    s.hitD2 = []; // squared distance to each
    s.hitN = 0;
    s.outB = false; // L38 this tick
    s.headOn = false; // lost an L36 head-on this tick
  }

  // ------------------------------------------------------------------ L31 eat zone

  let eater = null;
  function eatFood(f) {
    food.eat(f, eater.id);
    slSnake.feedFood(K, eater, f.b);
  }

  function eatPrey(p) {
    preys.eat(p, eater.id);
    slSnake.feedPrey(K, eater, p.rad);
  }

  // The eat zone is taken from the snake as the update STARTS (head, ang, wang, sp, length), the moment the update's
  // records leave: judged where the update ends, every eat came one update early on the client's clock, and the law
  // check (task T14, analysis/laws/food.js L31zone on our recordings) put the zone centre 1.6 to 1.8 sp further ahead
  // than on Owen's slither.io recordings (10.03 x sp at sc 1 against their 8.235); taken at the start it is 8.45.
  // The wang is the one this update's steering records give (the zone as T14 checked it, when the slot applied at the
  // update start; the turn itself now runs from each record's arrival, slSnake travel).
  const ezSteer = { ang: 0, wang: 0, dir: 1, turning: false };
  function eatFrom(s) {
    const e = s.ez;
    e.x = slSnake.headX(s);
    e.y = slSnake.headY(s);
    e.ang = s.ang;
    e.wang = slSnake.steerAt(K, s, K.P, ezSteer) >= 0 ? ezSteer.wang : s.wang;
    e.sp = s.sp;
    e.sct = s.pts.length;
  }

  // Every food inside the disc ahead of the head: centre head + sp (k0 + k1 sc) along the direction halfway between
  // ang and wang (the shortest way), radius r0 + r1 sc, every update, from the state eatFrom took. Foods one at a time
  // (the L18 multiplier is recomputed after each), then prey (L34), the order their server sends the eats in
  // (L48.order).
  function eatZone(s) {
    const e = s.ez;
    const sc = slSnake.speedSc(K, e.sct);
    const dir = e.ang + slSnake.angleGap(e.wang, e.ang) / 2;
    const ahead = e.sp * (W.eatK0 + W.eatK1 * sc);
    const cx = e.x + Math.cos(dir) * ahead;
    const cy = e.y + Math.sin(dir) * ahead;
    const r = W.eatR0 + W.eatR1 * sc;
    eater = s;
    if (food) food.forEachInDisc(cx, cy, r, eatFood);
    if (preys) preys.forEachInDisc(cx, cy, r, eatPrey);
    eater = null;
  }

  // ------------------------------------------------------------------ L35, L37 collision test

  // The longest gap of the capsule chain is msl (spawn points are msl apart, chainPull only shortens gaps, the head is
  // under msl past the newest point), and the largest radius is a x scCap. A point farther than that from the test
  // segment's box cannot reach it.
  const reach = W.a * K.scCap + K.msl;
  let tv = null; // the victim under test
  let t0x = 0;
  let t0y = 0;
  let t1x = 0;
  let t1y = 0;
  let tSweep = false;
  let probeBest = null;
  let probeD2 = 0;

  function capsuleD2(ax, ay, bx, by) {
    return tSweep ? segSegDist2(t0x, t0y, t1x, t1y, ax, ay, bx, by) : pointSegDist2(t1x, t1y, ax, ay, bx, by);
  }

  // Squared distance from the test segment to the capsules touching body point p of snake o: (previous, p) and
  // (p, next), the newest point's next being the head.
  function chainD2At(o, p) {
    const pts = o.pts;
    const i = p.seq - pts[0].seq;
    let d2 = Infinity;
    if (i > 0) {
      const q = pts[i - 1];
      d2 = capsuleD2(q.xx, q.yy, p.xx, p.yy);
    }
    const n = i < pts.length - 1 ? capsuleD2(p.xx, p.yy, pts[i + 1].xx, pts[i + 1].yy) : capsuleD2(p.xx, p.yy, o.hx, o.hy);
    return n < d2 ? n : d2;
  }

  function addHit(v, id, d2) {
    for (let k = 0; k < v.hitN; k++) {
      if (v.hits[k] === id) {
        if (d2 < v.hitD2[k]) v.hitD2[k] = d2;
        return;
      }
    }
    v.hits[v.hitN] = id;
    v.hitD2[v.hitN] = d2;
    v.hitN++;
  }

  function visitHit(p, sid) {
    if (sid === tv.id) return; // L37: the own body never kills
    const o = byId.get(sid);
    const r = W.a * o.sc;
    const d2 = chainD2At(o, p);
    if (d2 <= r * r) addHit(tv, sid, d2);
  }

  function visitProbe(p, sid) {
    if (tv !== null && sid === tv.id) return;
    const o = byId.get(sid);
    const r = W.a * o.sc;
    const d2 = chainD2At(o, p);
    if (d2 <= r * r && (probeBest === null || d2 < probeD2)) {
      probeBest = o;
      probeD2 = d2;
    }
  }

  function setSegment(x0, y0, x1, y1) {
    t0x = x0;
    t0y = y0;
    t1x = x1;
    t1y = y1;
    // SERVER-DESIGN 6.3: the swept segment is tested when one update's travel exceeds the smallest collision distance
    // (a at sc 1); at nsp3 the test point moves 14 x 42.67 / 32 = 18.67 > 14.5, so a boosting head could step over
    // the round end of a thin body between two updates.
    const dx = x1 - x0;
    const dy = y1 - y0;
    tSweep = dx * dx + dy * dy > W.a * W.a;
  }

  function visitBox(fn) {
    grid.forEachPointInBox(Math.min(t0x, t1x) - reach, Math.min(t0y, t1y) - reach, Math.max(t0x, t1x) + reach,
      Math.max(t0y, t1y) + reach, fn);
  }

  // Phase B for one snake: hits (L35, L37) and the border (L38).
  function testSnake(v) {
    const c = Math.cos(v.ang);
    const s = Math.sin(v.ang);
    const x1 = v.hx + W.f1 * v.sc * c;
    const y1 = v.hy + W.f1 * v.sc * s;
    v.hitN = 0;
    v.headOn = false;
    setSegment(v.tpx, v.tpy, x1, y1);
    tv = v;
    visitBox(visitHit);
    tv = null;
    v.tpx = x1;
    v.tpy = y1;
    v.outB = false;
    if (border) {
      const bx = v.hx + W.borderF1 * v.sc * c - grd;
      const by = v.hy + W.borderF1 * v.sc * s - grd;
      const lim = border.radius() + W.borderM;
      v.outB = bx * bx + by * by > lim * lim;
    }
  }

  // The nearest snake (other than exceptId) whose body the segment (x0, y0)-(x1, y1) touches by the L35 rule, as
  // {id, d} or null. The same search the tick runs (for tests and tools; reads the bodies as they stand now).
  function probe(x0, y0, x1, y1, exceptId) {
    for (let i = 0; i < live.length; i++) {
      const s = live[i];
      s.sc = slSnake.speedSc(K, s.pts.length);
      s.hx = slSnake.headX(s);
      s.hy = slSnake.headY(s);
    }
    t0x = x0;
    t0y = y0;
    t1x = x1;
    t1y = y1;
    tSweep = x0 !== x1 || y0 !== y1;
    tv = exceptId === undefined ? null : byId.get(exceptId) || null;
    probeBest = null;
    visitBox(visitProbe);
    tv = null;
    const out = probeBest === null ? null : { id: probeBest.id, d: Math.sqrt(probeD2) };
    probeBest = null;
    return out;
  }

  // ------------------------------------------------------------------ L36 head-on, then the deaths

  function hitIndex(v, id) {
    for (let k = 0; k < v.hitN; k++) if (v.hits[k] === id) return k;
    return -1;
  }

  // L36: two snakes that would kill each other in the same update. The smaller by L = sct + fam dies; equal L is one
  // draw on the 'coin' stream (below 0.5: the one earlier in the seeded order dies). The winner's hit on the loser is
  // cancelled, so the loser alone dies of this pair.
  function resolveHeadOns() {
    for (let i = 0; i < order.length; i++) {
      const v = order[i];
      if (!v.alive) continue;
      for (let k = 0; k < v.hitN; k++) {
        const id = v.hits[k];
        if (id === 0) continue;
        const o = byId.get(id);
        if (o.ord <= v.ord) continue; // each pair once, from its earlier member
        const back = hitIndex(o, v.id);
        if (back < 0) continue;
        const lv = v.pts.length + v.fam;
        const lo = o.pts.length + o.fam;
        const vDies = lv < lo ? true : lv > lo ? false : wrng.coin.next() < 0.5;
        if (vDies) {
          o.hits[back] = 0; // the winner o keeps living as far as v is concerned
          v.headOn = true;
        } else {
          v.hits[k] = 0;
          o.headOn = true;
        }
      }
    }
  }

  // The nearest remaining hit of v (its killer), or null.
  function killerOf(v) {
    let best = null;
    let bd2 = Infinity;
    for (let k = 0; k < v.hitN; k++) {
      if (v.hits[k] === 0) continue;
      if (v.hitD2[k] < bd2) {
        bd2 = v.hitD2[k];
        best = byId.get(v.hits[k]);
      }
    }
    return best;
  }

  // L39 drops of a death: perPoint at uniform places along each body point's stretch of the pulled body toward the
  // head (the newest point's stretch ends at the head), then atHead at the head; each moved by a uniform point in a
  // disc of radius r0 + r1 (sc - 1). Rad byte by L39.rad, colour by L39.colour.skin. Draws per drop, on the 'death'
  // stream: the place along the stretch (body drops only), the disc radius, the disc angle, then the colour (a
  // weighted skin only).
  function deathDrops(s, hx, hy, out) {
    const pts = s.pts;
    const n = pts.length;
    const b = deathRadByte(W, n);
    const R = W.placeR0 + W.placeR1 * (slSnake.speedSc(K, n) - 1);
    const r = wrng.death;
    const put = (x, y) => {
      const d = R * Math.sqrt(r.next());
      const th = PI2 * r.next();
      const cv = slSnake.dropColour(W.skinK, s.cv, r);
      const dx = x + d * Math.cos(th);
      const dy = y + d * Math.sin(th);
      out.push({ x: dx, y: dy, b, cv, food: food ? food.drop(dx, dy, b, cv) : null });
    };
    for (let i = 0; i < n; i++) {
      const ax = pts[i].xx;
      const ay = pts[i].yy;
      const bx = i < n - 1 ? pts[i + 1].xx : hx;
      const by = i < n - 1 ? pts[i + 1].yy : hy;
      for (let k = 0; k < W.perPoint; k++) {
        const t = r.next();
        put(ax + t * (bx - ax), ay + t * (by - ay));
      }
    }
    for (let k = 0; k < W.atHead; k++) put(hx, hy);
  }

  // One death: the record, the drops (none at the border, L39.count border 0), the kill credit (L40), out of the
  // world. cause 'snake' (killer given), 'border' or 'kill' (sim.kill: a disconnect after its glide, C_DISCONNECT).
  function die(s, cause, killer) {
    const hx = slSnake.headX(s);
    const hy = slSnake.headY(s);
    const d = { id: s.id, cause, killer: killer ? killer.id : 0, headOn: s.headOn, x: hx, y: hy, sct: s.pts.length,
      fam: s.fam, cv: s.cv, drops: [] };
    if (cause !== 'border') deathDrops(s, hx, hy, d.drops);
    if (killer) killer.kills++;
    log.deaths.push(d);
    takeOut(s);
    return d;
  }

  // The room's kill (C_DISCONNECT: a snake whose socket dropped dies after its glide): the snake dies at the start of
  // the next step, with L39 drops and no killer, so its record is in that tick's log. Returns false when it is gone.
  function kill(id) {
    if (!byId.has(id)) return false;
    if (pendingKills.indexOf(id) < 0) pendingKills.push(id);
    return true;
  }

  // ------------------------------------------------------------------ L42 spawn ring

  const ringAt = [0, 0];
  let nearX = 0;
  let nearY = 0;
  let nearD2 = Infinity;
  function visitNear(p) {
    const dx = p.xx - nearX;
    const dy = p.yy - nearY;
    const d2 = dx * dx + dy * dy;
    if (d2 < nearD2) nearD2 = d2;
  }

  // Squared distance from (x, y) to the nearest body point of any snake within reach r, else Infinity.
  function nearestPointD2(x, y, r) {
    nearX = x;
    nearY = y;
    nearD2 = Infinity;
    grid.forEachPointInBox(x - r, y - r, x + r, y + r, visitNear);
    return nearD2;
  }

  // A head point on ring k: r = (q k + c) flux from (grd, grd), k uniform in [kMin, kMax], angle uniform (L42.ring,
  // L42.k); drawn again while another snake's body point lies within L42.clear of it, at most C_SPAWN_TRIES draws,
  // then the draw farthest from any body point. Two 'spawn' draws per try (k, then the angle).
  function ringPoint() {
    const flux = border.radius();
    const span = W.kMax - W.kMin + 1;
    const c2 = W.clear * W.clear;
    let bestD2 = -1;
    for (let t = 0; t < W.spawnTries; t++) {
      const k = W.kMin + rng.spawn.int(span);
      const th = rng.spawn.next() * PI2;
      const r = (W.ringQ * k + W.ringC) * flux;
      const x = grd + r * Math.cos(th);
      const y = grd + r * Math.sin(th);
      const d2 = nearestPointD2(x, y, W.clear);
      if (d2 > c2) {
        ringAt[0] = x;
        ringAt[1] = y;
        return;
      }
      if (d2 > bestD2) {
        bestD2 = d2;
        ringAt[0] = x;
        ringAt[1] = y;
      }
    }
  }

  // ------------------------------------------------------------------ the prey's threat lookup (L33.flee)

  const threatOut = { x: 0, y: 0, sp: 0 };
  // The nearest snake head within dist of (x, y) as {x, y, sp}, or null; ties go to the earlier spawn.
  function threat(x, y, dist) {
    let best = null;
    let bd2 = dist * dist;
    for (let i = 0; i < live.length; i++) {
      const s = live[i];
      const dx = s.hx - x;
      const dy = s.hy - y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bd2 || (best === null && d2 === bd2)) {
        best = s;
        bd2 = d2;
      }
    }
    if (best === null) return null;
    threatOut.x = best.hx;
    threatOut.y = best.hy;
    threatOut.sp = best.sp;
    return threatOut;
  }

  // ===================================================================================================================
  // 4. The tick: SERVER-DESIGN 5.3 steps 4 (sim), 5 (deaths) and 7 (clocks)

  function step() {
    tick++;
    nowMs = startMs + tick * K.P;
    log.tick = tick;
    log.updates.length = 0;
    log.drops.length = 0;
    log.boosts.length = 0;
    log.charges.length = 0;
    log.deaths.length = 0;
    if (food) food.beginTick();
    if (preys) preys.beginTick();

    // the room's kills since the last step die first, before anyone moves
    while (pendingKills.length) {
      const s = byId.get(pendingKills[0]);
      if (s) {
        s.headOn = false;
        die(s, 'kill', null);
      } else {
        pendingKills.shift();
      }
    }

    // Phase A: one update per live snake in a seeded permutation (the 'order' stream, n - 1 draws), so no snake is
    // ever first by join order (L36, SERVER-DESIGN 5.3); its boost drops placed; then its eats.
    order.length = live.length;
    for (let i = 0; i < live.length; i++) order[i] = live[i];
    shuffleInPlace(rng.order, order);
    for (let i = 0; i < order.length; i++) {
      const s = order[i];
      s.ord = i;
      const d0 = log.drops.length;
      if (food || preys) eatFrom(s);
      const rec = slSnake.updateSnake(sim, s, K.P);
      log.updates.push(rec);
      // body point sequence numbers (the capsule test finds a point's neighbours by them): the moves of this update
      // are the newest points
      const pts = s.pts;
      const n = pts.length;
      for (let j = n - rec.moves; j < n; j++) pts[j].seq = pts[j - 1].seq + 1;
      for (let j = d0; j < log.drops.length; j++) {
        const d = log.drops[j];
        d.food = food ? food.drop(d.x, d.y, d.b, d.cv) : null;
      }
      if (food || preys) eatZone(s);
    }

    // Phase B: every snake's test at the same instant (heads and sizes first, so every test reads the same bodies).
    for (let i = 0; i < order.length; i++) {
      const s = order[i];
      s.sc = slSnake.speedSc(K, s.pts.length);
      s.hx = slSnake.headX(s);
      s.hy = slSnake.headY(s);
    }
    for (let i = 0; i < order.length; i++) testSnake(order[i]);

    // Phase C: the head-on rule, then the deaths in processing order (a snake hit wins over the border: its killer
    // is credited and its drops fall).
    resolveHeadOns();
    victims.length = 0;
    for (let i = 0; i < order.length; i++) {
      const s = order[i];
      if (nowMs - s.bornMs < W.protectMs) continue; // L49
      const k = killerOf(s);
      if (k !== null) {
        victims.push(s, k);
      } else if (s.outB) {
        victims.push(s, null);
      }
    }
    for (let i = 0; i < victims.length; i += 2) {
      const s = victims[i];
      const k = victims[i + 1];
      die(s, k !== null ? 'snake' : 'border', k);
    }
    victims.length = 0;
    for (let i = 0; i < order.length; i++) order[i].headOn = false;

    // Step 7: the L29 food pass, the L33 prey step, the L11 border check (with the count after the deaths)
    const flux = border ? border.radius() : 0;
    if (food) food.step(nowMs, flux);
    if (preys) preys.step(nowMs, flux, threat);
    if (border) border.tick(nowMs, live.length);
    order.length = 0;
    return log;
  }

  // ===================================================================================================================
  // 5. Digest: FNV-1a 32 over the float64 bytes of the whole state, in id order, plus every stream state, the food,
  //    prey and border state. check(): invariants for the tests and the soak.

  const F64 = new Float64Array(1);
  const B8 = new Uint8Array(F64.buffer);
  function mix(h, x) {
    F64[0] = x;
    for (let i = 0; i < 8; i++) {
      h ^= B8[i];
      h = Math.imul(h, 0x01000193);
    }
    return h;
  }

  function mixHex(h, hex) {
    return mix(h, parseInt(hex, 16));
  }

  function digest() {
    let h = 0x811c9dc5;
    h = mix(h, tick);
    const ids = Array.from(byId.keys()).sort((a, b) => a - b);
    for (const id of ids) {
      const s = byId.get(id);
      h = mix(h, id);
      h = mix(h, s.cv);
      h = mix(h, s.fam);
      h = mix(h, s.famSent);
      h = mix(h, s.ang);
      h = mix(h, s.wang);
      h = mix(h, s.dir);
      h = mix(h, s.turning ? 1 : 0);
      h = mix(h, s.spBase);
      h = mix(h, s.spCore);
      h = mix(h, s.sp);
      h = mix(h, s.holdMult === null ? -1 : s.holdMult);
      h = mix(h, s.boosting ? 1 : 0);
      h = mix(h, s.chargeMs);
      h = mix(h, s.chargeCount);
      h = mix(h, s.cx);
      h = mix(h, s.cy);
      h = mix(h, s.pts.length);
      for (const p of s.pts) {
        h = mix(h, p.xx);
        h = mix(h, p.yy);
        h = mix(h, p.iang);
      }
      h = mix(h, s.kills);
      h = mix(h, s.tpx);
      h = mix(h, s.tpy);
      h = mix(h, s.bornMs);
    }
    for (const st of streamStates(rng)) h = mix(h, st);
    h = mix(h, grid.pointTotal());
    h = mix(h, wrng.death.state());
    h = mix(h, wrng.coin.state());
    for (const id of pendingKills) h = mix(h, id);
    if (food) h = mixHex(h, food.digest());
    if (preys) h = mixHex(h, preys.digest());
    if (border) {
      h = mix(h, border.radius());
      h = mix(h, border.due());
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  // Problems found (allocates; tests and the soak only): grid and food invariants, body sequence numbers, finite
  // state, heads inside the map.
  function check() {
    const problems = food ? food.check() : grid.check();
    for (const s of live) {
      const pts = s.pts;
      for (let i = 0; i < pts.length; i++) {
        if (pts[i].seq !== pts[0].seq + i) {
          problems.push('snake ' + s.id + ' point ' + i + ': seq ' + pts[i].seq + ' after ' + pts[0].seq);
          break;
        }
        if (!Number.isFinite(pts[i].xx) || !Number.isFinite(pts[i].yy)) problems.push('snake ' + s.id + ': non-finite point');
      }
      if (pts.length < K.minSct) problems.push('snake ' + s.id + ': fewer than ' + K.minSct + ' points');
      for (const k of ['fam', 'ang', 'wang', 'sp', 'cx', 'cy']) if (!Number.isFinite(s[k])) problems.push('snake ' + s.id + ': ' + k + ' not finite');
    }
    let pts = 0;
    for (const s of live) pts += s.pts.length;
    if (pts !== grid.pointTotal()) problems.push('grid point total differs from the bodies');
    return problems;
  }

  Object.assign(sim, {
    laws,
    spawn,
    setInput,
    applyInputs,
    setHold,
    step,
    feed,
    feedPrey,
    remove,
    kill,
    snake,
    forEachSnake,
    probe,
    food,
    preys,
    border,
    flux: () => (border ? border.radius() : null),
    count: () => live.length,
    tick: () => tick,
    nowMs: () => nowMs,
    digest,
    check,
  });
  return sim;
}

module.exports = {
  createSim,
  SIM_LAW_IDS,
  WORLD_LAW_IDS,
  WORLD_TABLE_IDS,
  WORLD_RULES_BUILT,
  WORLD_ROWS,
  worldLaws,
  deathRadByte,
  pointSegDist2,
  segSegDist2,
};
