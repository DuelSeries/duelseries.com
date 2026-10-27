'use strict';
/* ─── Swim: the one simulation every side of the game runs ───────────────────
   A 1v1 race down an endless one-way highway. Both cars drive the same road
   through the same traffic; touching any traffic car loses at once, and being
   BEHIND_LOSE metres behind the other car loses too. It goes on, faster and
   denser, until one of those happens.

   THE SAME CODE ON BOTH ENDS. The server (server/swim/SwimRoom.js) runs this
   to decide everything; the page runs the exact same step on its own inputs so
   its car answers the keys at once, and corrects itself whenever the server's
   copy disagrees. Only + - * / and comparisons are used in a step (no sin, no
   exp), so the two agree to the last bit in every browser and in Node.

   THE TRAFFIC IS A LIST OF RECORDS, NOT A STREAM OF POSITIONS. A traffic car
   never changes lane or speed: it is born at z0 on tick t0 in a lane, and its
   position on any tick is z0 + laneSpeed * (tick - t0) * DT. So the server
   sends each car once (when it appears on the horizon, server/swim/
   swimTraffic.js) and every screen works out where it is from then on, for
   free and in perfect agreement.

   EACH CAR IS ITS OWN TIMELINE. The two players never touch each other (they
   pass through, drawn as ghosts when they overlap) and the traffic does not
   care where they are, so a car's whole drive is decided by its own inputs,
   tick by tick. The server can run each player at the tick their inputs have
   reached, judge them against the traffic AT THAT TICK (what they saw), and
   compare the two only on ticks both have reached. Latency then never makes
   somebody hit a car they had already dodged on their own screen.

   Units: metres, metres per second, ticks of 1/60 s. x is across the road
   (right is +), z is down it (forward is +). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SwimSim = api;
})(typeof window !== 'undefined' ? window : null, function () {
  /* The name players see, in one place (Owen's working title). */
  const NAME = 'Swim';
  /* Bumped whenever the step or the traffic rules change: a page left open across a deploy runs the old
     step and would disagree with the server on every tick, so the server turns it away (sw:queue). */
  const VERSION = 1;

  const HZ = 60;
  const DT = 1 / HZ;
  const TICK_MS = 1000 / HZ;
  const COUNTDOWN_MS = 3000;
  const BEHIND_LOSE = 200;            // metres behind the other car that ends it

  /* ── the road ─────────────────────────────────────────────────────────────
     Four lanes one way, 3.6 m each (a real highway lane). Lane 0 is the left
     lane and the fastest, as on a real road; the right lane is the slow one,
     and the only place trucks and buses drive. */
  const LANES = 4;
  const LANE_W = 3.6;
  const ROAD_HALF = LANES * LANE_W / 2;                  // 7.2
  const laneX = (l) => (l - (LANES - 1) / 2) * LANE_W;   // -5.4, -1.8, 1.8, 5.4
  const LANE_V = [23, 20.5, 18, 15.5];                   // m/s, left to right

  /* The players' car. Its hitbox is a touch smaller than the body drawn, so a
     pass that LOOKS clean is clean. Between two ordinary cars side by side
     there is 0.1 m to spare each side: a squeeze, never a gift. */
  const CAR = { L: 4.3, W: 1.8, HL: 2.06, HW: 0.84 };
  const WALL = ROAD_HALF + 0.3 - CAR.W / 2;             // where the barrier stops the car's centre

  /* Traffic. L, W, H in metres; trucks and buses only in the two right lanes. */
  const TYPES = [
    { id: 'sedan', L: 4.5, W: 1.84, H: 1.42, w: 34, right: false },
    { id: 'hatch', L: 3.9, W: 1.76, H: 1.52, w: 22, right: false },
    { id: 'suv',   L: 4.8, W: 1.95, H: 1.78, w: 20, right: false },
    { id: 'van',   L: 5.3, W: 2.0,  H: 2.25, w: 10, right: false },
    { id: 'truck', L: 9.6, W: 2.45, H: 3.3,  w: 9,  right: true },
    { id: 'bus',   L: 12,  W: 2.5,  H: 3.2,  w: 5,  right: true },
  ];
  for (const t of TYPES) { t.hl = t.L / 2 - 0.08; t.hw = t.W / 2 - 0.06; }
  const MAX_HL = Math.max(...TYPES.map(t => t.hl));

  /* ── speed ────────────────────────────────────────────────────────────────
     The road gets faster for as long as the match lasts: a cruise speed that
     starts at 108 km/h and climbs towards 266, half way there after 80 s. W
     pushes up to 28% over it, S brakes all the way down to 43 km/h at any
     stage, and with neither the car settles back to it. Braking is the way out of a
     box: slow enough to drop in behind a car alongside and pull out behind it.
     It costs ground, which is the whole game against the 200 m rule; and sit
     slower than a lane's traffic for long and it comes up behind you, and
     touching it from behind counts the same. */
  const V0 = 30, V1 = 74, T_HALF = 80;
  const TOP_K = 1.28, FLOOR_MIN = 12;
  const GAS = 9.5, BRAKE = 20, EASE = 3.2, SCRAPE = 9;
  const VX_MAX = 8.6;                 // sideways m/s at full lock: a lane in about half a second
  const VX_ACC = 46;                  // how fast the sideways speed answers the wheel

  function cruise(tick) {
    const t = (tick > 0 ? tick : 0) * DT;
    return V0 + (V1 - V0) * t / (t + T_HALF);
  }
  function topSpeed(tick) { return cruise(tick) * TOP_K; }
  /* Always below every lane's traffic, so braking can always drop you in behind a car. */
  function floorSpeed() { return FLOOR_MIN; }

  /* ── inputs ───────────────────────────────────────────────────────────────
     One small integer per tick: the wheel in 101 steps (-1 left to +1 right;
     keys send the ends, a phone anything between) and the pedal (-1 brake, 0
     none, +1 gas). */
  const STEER_Q = 50;
  const INPUT_MAX = (2 * STEER_Q) * 3 + 2;
  function packInput(steer, pedal) {
    const s = Math.round(Math.max(-1, Math.min(1, Number(steer) || 0)) * STEER_Q);
    const p = pedal > 0 ? 1 : pedal < 0 ? -1 : 0;
    return (s + STEER_Q) * 3 + (p + 1);
  }
  const steerOf = (code) => (Math.floor(code / 3) - STEER_Q) / STEER_Q;
  const pedalOf = (code) => (code % 3) - 1;
  const NEUTRAL = packInput(0, 0);
  const validInput = (c) => Number.isInteger(c) && c >= 0 && c <= INPUT_MAX;

  /* ── a player's car ──────────────────────────────────────────────────────
     `tick` is the tick this state is AT: step() applies that tick's input and
     moves it to tick + 1. Side 0 starts in lane 1, side 1 in lane 2. */
  function newCar(side) {
    return { tick: 0, z: 0, x: side === 1 ? laneX(2) : laneX(1), v: V0, vx: 0,
             alive: true, crashTick: -1, hit: -1, wall: 0 };
  }
  function copyCar(c, out) {
    const o = out || {};
    o.tick = c.tick; o.z = c.z; o.x = c.x; o.v = c.v; o.vx = c.vx;
    o.alive = c.alive; o.crashTick = c.crashTick; o.hit = c.hit; o.wall = c.wall;
    return o;
  }

  function step(car, code, traffic) {
    const n = car.tick;
    if (!car.alive) { car.tick = n + 1; return car; }
    const steer = steerOf(code), pedal = pedalOf(code);
    const hi = topSpeed(n), lo = floorSpeed(n), mid = cruise(n);

    let v = car.v;
    if (pedal > 0) { v += GAS * DT; if (v > hi) v = hi; }
    else if (pedal < 0) { v -= BRAKE * DT; if (v < lo) v = lo; }
    else if (v < mid) { v += EASE * DT; if (v > mid) v = mid; }
    else if (v > mid) { v -= EASE * DT; if (v < mid) v = mid; }
    if (v < lo) v = lo;

    const want = steer * VX_MAX;
    let vx = car.vx;
    const dv = VX_ACC * DT;
    if (vx < want) { vx += dv; if (vx > want) vx = want; }
    else if (vx > want) { vx -= dv; if (vx < want) vx = want; }
    let x = car.x + vx * DT;
    let wall = 0;
    /* The barrier stops you and scrubs a little speed while you lean on it.
       It never ends the match: the rule is about traffic. */
    if (x > WALL) { x = WALL; if (vx > 0) vx = 0; wall = 1; }
    else if (x < -WALL) { x = -WALL; if (vx < 0) vx = 0; wall = -1; }
    if (wall !== 0 && steer * wall > 0) { v -= SCRAPE * DT; if (v < lo) v = lo; }

    car.z += v * DT;
    car.x = x; car.v = v; car.vx = vx; car.wall = wall;
    car.tick = n + 1;
    if (traffic) {
      const hit = traffic.hitAt(car.x, car.z, car.tick);
      if (hit >= 0) { car.alive = false; car.crashTick = car.tick; car.hit = hit; }
    }
    return car;
  }

  /* ── the traffic ─────────────────────────────────────────────────────────
     A record is [id, lane, type, z0, t0, colour]. Within a lane every car
     moves at the lane's speed and they were added front-most last, so each
     lane's list stays sorted by z from the back of the queue to the front. */
  function zAt(rec, tick) { return rec[3] + LANE_V[rec[1]] * ((tick - rec[4]) * DT); }
  function validRecord(r) {
    return Array.isArray(r) && r.length >= 6 && Number.isInteger(r[0]) && r[0] >= 0
      && Number.isInteger(r[1]) && r[1] >= 0 && r[1] < LANES
      && Number.isInteger(r[2]) && r[2] >= 0 && r[2] < TYPES.length
      && Number.isFinite(r[3]) && Number.isInteger(r[4]) && Number.isInteger(r[5]);
  }

  class Traffic {
    constructor() {
      this.byId = new Map();
      this.lanes = [];
      for (let l = 0; l < LANES; l++) this.lanes.push([]);
    }
    add(rec) {
      if (!validRecord(rec) || this.byId.has(rec[0])) return false;
      this.byId.set(rec[0], rec);
      const list = this.lanes[rec[1]];
      /* Normally the newest is the front-most and goes on the end; a record
         that arrives out of order (a screen catching up) is put in its place. */
      let i = list.length;
      while (i > 0 && zAt(list[i - 1], 0) > zAt(rec, 0)) i--;
      list.splice(i, 0, rec);
      return true;
    }
    get size() { return this.byId.size; }
    /* Every car whose back is behind minZ on this tick is gone for good. */
    prune(minZ, tick) {
      for (const list of this.lanes) {
        let k = 0;
        while (k < list.length && zAt(list[k], tick) + TYPES[list[k][2]].hl < minZ) {
          this.byId.delete(list[k][0]); k++;
        }
        if (k) list.splice(0, k);
      }
    }
    /* The id of the traffic car a player's car at (x, z) touches on this tick, or -1. */
    hitAt(x, z, tick) {
      for (let l = 0; l < LANES; l++) {
        const dx = Math.abs(x - laneX(l));
        if (dx >= CAR.HW + 1.25) continue;            // no traffic car is that wide
        const list = this.lanes[l];
        for (let i = 0; i < list.length; i++) {
          const r = list[i], t = TYPES[r[2]];
          const dz = zAt(r, tick) - z;
          if (dz > CAR.HL + MAX_HL) break;            // sorted: everything after is further ahead
          if (dz <= -(CAR.HL + t.hl) || dz >= CAR.HL + t.hl) continue;
          if (dx < CAR.HW + t.hw) return r[0];
        }
      }
      return -1;
    }
    /* Each lane's nearest car ahead of z (its back), for the bot and the HUD. */
    aheadIn(lane, z, tick) {
      const list = this.lanes[lane];
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        const back = zAt(r, tick) - TYPES[r[2]].hl;
        if (back + TYPES[r[2]].L > z - CAR.HL) return r;   // not yet fully behind us
      }
      return null;
    }
    all() { return [...this.byId.values()]; }
  }

  /* ── a small seeded generator (mulberry32) ────────────────────────────── */
  function rng(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const kmh = (v) => v * 3.6;

  return {
    NAME, VERSION, HZ, DT, TICK_MS, COUNTDOWN_MS, BEHIND_LOSE,
    LANES, LANE_W, ROAD_HALF, LANE_V, laneX, CAR, WALL, TYPES, MAX_HL,
    V0, V1, T_HALF, TOP_K, FLOOR_MIN, VX_MAX,
    cruise, topSpeed, floorSpeed,
    STEER_Q, INPUT_MAX, packInput, steerOf, pedalOf, NEUTRAL, validInput,
    newCar, copyCar, step, zAt, validRecord, Traffic, rng, kmh,
  };
});
