'use strict';
// slither.io free room: the pure, seeded world sim (SERVER-DESIGN 3.1, 5.3, 6; tasks T4 snake half, T6 world half).
//
// createSim(laws, {seed}) -> the sim. Deterministic: no Math.random, no Date, no io; every random draw comes from its
// own slRng stream; arrays in fixed order. The same seed and the same calls give the same digest() to the last bit.
//
// The room drives one tick as SERVER-DESIGN 5.3 says:
//   setInput(id, record, offsetMs)   on arrival, any time between ticks (merged into the snake's input slot)
//   applyInputs()                     step 1: wang (L15), arrow (L15), boost on or refused (L22), boost off
//   setHold(id, mult | null, offset)  step 2: the sim side of slHold (steering lock, speed multiplier, release)
//   step()                            step 4: every live snake updated once, in a seeded order (SERVER-DESIGN 6.2)
// step() returns the tick log (valid until the next step): the update record of each updated snake in processing
// order (slSnake newRec: fam record first, tail losses, turning, the added point) and the boost drops of the tick.
//
// Sections:
//   1. laws the sim reads
//   2. SNAKE HALF (task T4): spawn, inputs, hold, the per-snake update, feeding, removal
//   3. WORLD HALF (task T6): collisions, deaths, death drops, kills, border kill, spawn ring (not built yet)
//   4. digest

const { assertLawsComplete } = require('./slLaws');
const { streams, streamStates, shuffleInPlace } = require('./slRng');
const { createGrid } = require('./slGrid');
const slSnake = require('./slSnake');

// =====================================================================================================================
// 1. Laws the sim reads (the union of both halves; T6 adds its ids here)

const SIM_OWN_LAW_IDS = Object.freeze(['L1', 'L2.size']);
const SIM_LAW_IDS = Object.freeze(Array.from(new Set(SIM_OWN_LAW_IDS.concat(slSnake.SNAKE_LAW_IDS))));

const MAX_ID = 65535; // snake ids are u16 on the wire and never 0 (SERVER-DESIGN 6.1)

function createSim(laws, opts) {
  const o = opts || {};
  if (typeof o.seed !== 'number' || !Number.isFinite(o.seed)) throw new TypeError('slSim: seed must be a finite number');
  assertLawsComplete(laws, SIM_LAW_IDS);
  const K = slSnake.snakeLaws(laws);
  const grid = createGrid({ sectorSize: laws['L2.size'].value, grd: laws.L1.value });
  const rng = streams(o.seed);
  // The room may block ids a seat could still hold (C_ID_QUARANTINE_MS, SERVER-DESIGN 8.1); the sim never reuses a
  // live id either way.
  const idBlocked = typeof o.idBlocked === 'function' ? o.idBlocked : null;

  const live = []; // live snakes in spawn order
  const byId = new Map();
  const order = []; // reused per tick: the seeded update order
  const log = { tick: 0, updates: [], drops: [] };
  let tick = 0;
  let nextId = 1;

  const sim = { K, grid, rng, log };

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

  // A new snake in the L20 spawn state. x, y: the head (the T6 spawn ring will fill them when absent). ang: heading;
  // absent = uniform over 0 to 2 pi from the 'spawn' stream (L20). cv: colour or skin (checked by the handshake,
  // L45 and C_CONN). sct and fam other than L20 are for tests and tools only.
  function spawn(spec) {
    const p = spec || {};
    if (p.x === undefined || p.y === undefined) throw new TypeError('slSim: spawn needs x and y (the spawn ring is T6)');
    finite(p.x, 'spawn x');
    finite(p.y, 'spawn y');
    const ang = p.ang === undefined ? rng.spawn.next() * 2 * Math.PI : finite(p.ang, 'spawn ang');
    if (!Number.isInteger(p.cv) || p.cv < 0) throw new TypeError('slSim: cv must be an integer >= 0');
    const id = takeId();
    const s = slSnake.createSnake(K, id, { x: p.x, y: p.y, ang, cv: p.cv, nick: p.nick === undefined ? '' : String(p.nick), sct: p.sct, fam: p.fam });
    for (const pt of s.pts) grid.addPoint(id, pt);
    live.push(s);
    byId.set(id, s);
    return s;
  }

  // One decoded input record (shared/slWire.js decodeInput) for snake id, offsetMs = ms from its arrival to the start
  // of the tick that applies it (C_INPUT_OFFSET, SERVER-DESIGN 5.1). Merged per SERVER-DESIGN 5.2: the newest angle
  // wins and drops the arrow ticks before it; arrow ticks after it are summed; boost on and off kept in arrival order
  // with repeats collapsed. A ping is the room's (L47). Returns false when the snake is gone.
  function setInput(id, rec, offsetMs) {
    const s = byId.get(id);
    if (!s) return false;
    if (!rec || typeof rec !== 'object') throw new TypeError('slSim: input record must be an object');
    const off = offsetMs === undefined ? 0 : offsetMs;
    if (typeof off !== 'number' || !Number.isFinite(off) || off < 0) throw new RangeError('slSim: offsetMs must be >= 0');
    if (rec.type === 'angle') {
      if (!Number.isInteger(rec.q) || rec.q < 0 || rec.q > K.maxAngle) throw new RangeError('slSim: angle byte out of range');
      s.inAngle = rec.q;
      s.inTurn = 0;
    } else if (rec.type === 'turn') {
      if (!Number.isInteger(rec.v) || rec.v < 0) throw new RangeError('slSim: turn ticks must be an integer >= 0');
      if (rec.dir === 'left') s.inTurn -= rec.v;
      else if (rec.dir === 'right') s.inTurn += rec.v;
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

  // Step 4: one update per live snake in a seeded permutation (the 'order' stream, n - 1 draws), so no snake is ever
  // first by join order (L36, SERVER-DESIGN 5.3).
  function step() {
    tick++;
    log.tick = tick;
    log.updates.length = 0;
    log.drops.length = 0;
    order.length = live.length;
    for (let i = 0; i < live.length; i++) order[i] = live[i];
    shuffleInPlace(rng.order, order);
    for (let i = 0; i < order.length; i++) {
      const s = order[i];
      if (!s.alive) continue;
      log.updates.push(slSnake.updateSnake(sim, s, K.P));
      // T6: eating (L31, L18, L34) and the collision test of this snake against bodies as they stand (L35 to L38).
    }
    return log;
  }

  // L18 and L34 eats (the world half calls these from the eat zone; tests call them directly).
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

  // Takes a snake out of the world with no drops (a leave or a cash-out, C_CASHOUT_CODE). Deaths with drops are T6.
  function remove(id) {
    const s = byId.get(id);
    if (!s) return false;
    for (const p of s.pts) grid.removePoint(p);
    s.alive = false;
    byId.delete(id);
    live.splice(live.indexOf(s), 1);
    return true;
  }

  function snake(id) {
    return byId.get(id) || null;
  }

  function forEachSnake(fn) {
    for (let i = 0; i < live.length; i++) fn(live[i]);
  }

  // ===================================================================================================================
  // 3. WORLD HALF (task T6): collisions (L35, L37, L38, L49), seeded head-on rule (L36), deaths and death drops (L39),
  //    kill credit (L40), border kill, spawn ring (L42). Not built yet.

  // ===================================================================================================================
  // 4. Digest: FNV-1a 32 over the float64 bytes of the whole state, in id order, plus every stream state.

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
      h = mix(h, s.d);
      h = mix(h, s.pts.length);
      for (const p of s.pts) {
        h = mix(h, p.xx);
        h = mix(h, p.yy);
        h = mix(h, p.iang);
      }
    }
    for (const st of streamStates(rng)) h = mix(h, st);
    h = mix(h, grid.pointTotal());
    return (h >>> 0).toString(16).padStart(8, '0');
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
    snake,
    forEachSnake,
    count: () => live.length,
    tick: () => tick,
    digest,
  });
  return sim;
}

module.exports = { createSim, SIM_LAW_IDS };
