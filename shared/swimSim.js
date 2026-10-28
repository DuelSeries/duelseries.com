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
   never changes speed: it is born at z0 on tick t0 in a lane, and its
   position on any tick is z0 + laneSpeed * (tick - t0) * DT (zAt). Some cars
   change lane once, at a tick fixed when they were born, and say so in their
   record; xAt gives any car's x on any tick. So the server sends each car once
   (when it appears on the horizon, server/swim/swimTraffic.js) and every
   screen works out where it is from then on, for free and in perfect
   agreement.

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
  const VERSION = 4;

  const HZ = 60;
  const DT = 1 / HZ;
  const TICK_MS = 1000 / HZ;
  const COUNTDOWN_MS = 3000;
  const BEHIND_LOSE = 200;            // metres behind the other car that ends it

  /* ── the road ─────────────────────────────────────────────────────────────
     Four lanes one way, 3.6 m each (a real highway lane). Lane 0 is the left
     lane and the fastest, as on a real road; the right lane is the slow one,
     and trucks and buses keep mostly to the two right lanes. */
  const LANES = 4;
  const LANE_W = 3.6;
  const ROAD_HALF = LANES * LANE_W / 2;                  // 7.2
  const laneX = (l) => (l - (LANES - 1) / 2) * LANE_W;   // -5.4, -1.8, 1.8, 5.4
  const LANE_V = [27, 24, 21, 18];                       // m/s, left to right

  /* The players' car. Its hitbox is a touch smaller than the body drawn, so a
     pass that LOOKS clean is clean. Traffic hitboxes are 1 cm inside the body
     each side (Owen 2026-10-28, was 6 cm): between two sedans side by side
     there are 5 cm to spare each side, and an SUV, a van, a truck or a bus
     alongside shuts the gap. The line between two lanes is a squeeze to
     time, never a safe corridor. */
  const CAR = { L: 4.3, W: 1.8, HL: 2.06, HW: 0.84 };
  const WALL = ROAD_HALF + 0.3 - CAR.W / 2;             // where the barrier stops the car's centre

  /* Traffic. L, W, H in metres; `right`: trucks and buses, mostly in the two
     right lanes (the spawner, server/swim/swimTraffic.js). */
  const TYPES = [
    { id: 'sedan', L: 4.5, W: 1.84, H: 1.42, w: 34, right: false },
    { id: 'hatch', L: 3.9, W: 1.76, H: 1.52, w: 22, right: false },
    { id: 'suv',   L: 4.8, W: 1.95, H: 1.78, w: 20, right: false },
    { id: 'van',   L: 5.3, W: 2.0,  H: 2.25, w: 10, right: false },
    { id: 'truck', L: 9.6, W: 2.45, H: 3.3,  w: 9,  right: true },
    { id: 'bus',   L: 12,  W: 2.5,  H: 3.2,  w: 5,  right: true },
  ];
  for (const t of TYPES) { t.hl = t.L / 2 - 0.08; t.hw = t.W / 2 - 0.01; }
  const MAX_HL = Math.max(...TYPES.map(t => t.hl));

  /* ── speed ────────────────────────────────────────────────────────────────
     The road gets faster for as long as the match lasts: a cruise speed that
     starts at 130 km/h and climbs towards 302, half way there after 70 s. W
     pushes up to 16% over it (about 350 km/h late on, Owen 2026-10-28), S
     brakes all the way down to 54 km/h at any stage, and with neither the car
     settles back to it. Braking is the way out of a box: slow enough to drop
     in behind a car alongside and pull out behind it. It costs ground, which
     is the whole game against the 200 m rule; and sit slower than a lane's
     traffic for long and it comes up behind you, and touching it from behind
     counts the same. */
  const V0 = 36, V1 = 84, T_HALF = 70;
  const TOP_K = 1.16, FLOOR_MIN = 15;
  const GAS = 11, BRAKE = 22, EASE = 3.2, SCRAPE = 9;

  /* THE WHEEL GETS HEAVIER WITH SPEED (Owen 2026-10-28). Sideways speed at
     full lock is 11.5 - 0.075 v, held between 4.5 and 10.5 m/s: about 8.8 at
     the start (a lane in half a second), 5.2 at the late cruise, 4.5 flat
     out. How fast it answers the wheel scales with it, so full lock is always
     reached in about 0.19 s. Only * - and comparisons, so every engine agrees. */
  const VX_0 = 11.5, VX_K = 0.075, VX_LO = 4.5, VX_HI = 10.5;
  const VX_RISE = 46 / 8.6;           // sideways acceleration per m/s of sideways top speed
  function vxMax(v) {
    const m = VX_0 - VX_K * v;
    return m < VX_LO ? VX_LO : m > VX_HI ? VX_HI : m;
  }
  function vxAcc(v) { return vxMax(v) * VX_RISE; }

  /* A CLOSE PASS PAYS (Owen 2026-10-28). A traffic car that goes by with less
     than CLOSE_M of daylight between the two, measured side to side on the
     tick its front slips behind our rear, adds up to BOOST_MAX m/s at once:
     all of it for a pass with no daylight at all, nothing at CLOSE_M. Touching
     is still a crash. The boost can carry the car past its top speed, never
     more than BOOST_MAX over it, and above the top it bleeds off at OVER_EASE
     m/s every second, gas or not: a surge, not a new top speed. After a boost
     there is no other for BOOST_COOL ticks (1.2 s), so a run of cars cannot be
     strung into one long surge; a pass inside that time is not a close pass
     at all (no boost, no "Close"). The step works it out from the car and the
     traffic alone; the cooldown is a car field (`cool`, ticks left) that the
     server sends in its rows, so every screen agrees on it. */
  const CLOSE_M = 0.6, BOOST_MAX = 14, OVER_EASE = 4, BOOST_COOL = 72;

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
     moves it to tick + 1. Side 0 starts in lane 1, side 1 in lane 2. `cool`
     is the ticks left before another boost may come. `close` is what the
     last step saw (the clearance of a close pass that boosted, else -1) and
     is never read back, so a car rebuilt from the server's row (tick, z, x,
     v, vx, alive, wall, cool) steps exactly as the one it came from. */
  function newCar(side) {
    return { tick: 0, z: 0, x: side === 1 ? laneX(2) : laneX(1), v: V0, vx: 0,
             alive: true, crashTick: -1, hit: -1, wall: 0, cool: 0, close: -1 };
  }
  function copyCar(c, out) {
    const o = out || {};
    o.tick = c.tick; o.z = c.z; o.x = c.x; o.v = c.v; o.vx = c.vx;
    o.alive = c.alive; o.crashTick = c.crashTick; o.hit = c.hit; o.wall = c.wall;
    o.cool = c.cool || 0;
    o.close = c.close === undefined ? -1 : c.close;
    return o;
  }

  function step(car, code, traffic) {
    const n = car.tick;
    car.close = -1;
    if (!car.alive) { car.tick = n + 1; return car; }
    let cool = car.cool > 0 ? car.cool - 1 : 0;
    const steer = steerOf(code), pedal = pedalOf(code);
    const hi = topSpeed(n), lo = floorSpeed(n), mid = cruise(n);

    let v = car.v;
    if (pedal < 0) { v -= BRAKE * DT; if (v < lo) v = lo; }
    else if (v > hi) { v -= OVER_EASE * DT; if (v < hi) v = hi; }   // a boost bleeding off
    else if (pedal > 0) { v += GAS * DT; if (v > hi) v = hi; }
    else if (v < mid) { v += EASE * DT; if (v > mid) v = mid; }
    else if (v > mid) { v -= EASE * DT; if (v < mid) v = mid; }
    if (v < lo) v = lo;

    const reach = vxMax(v);
    const want = steer * reach;
    let vx = car.vx;
    const dv = reach * VX_RISE * DT;
    if (vx < want) { vx += dv; if (vx > want) vx = want; }
    else if (vx > want) { vx -= dv; if (vx < want) vx = want; }
    let x = car.x + vx * DT;
    let wall = 0;
    /* The barrier stops you and scrubs a little speed while you lean on it.
       It never ends the match: the rule is about traffic. */
    if (x > WALL) { x = WALL; if (vx > 0) vx = 0; wall = 1; }
    else if (x < -WALL) { x = -WALL; if (vx < 0) vx = 0; wall = -1; }
    if (wall !== 0 && steer * wall > 0) { v -= SCRAPE * DT; if (v < lo) v = lo; }

    const z0 = car.z;
    car.z = z0 + v * DT;
    car.x = x; car.v = v; car.vx = vx; car.wall = wall;
    car.tick = n + 1;
    if (traffic) {
      const hit = traffic.hitAt(car.x, car.z, car.tick);
      if (hit >= 0) { car.alive = false; car.crashTick = car.tick; car.hit = hit; }
      else if (cool === 0) {
        const gap = traffic.closeAt(car.x, z0, car.z, n);
        if (gap >= 0) {
          let b = v + BOOST_MAX * (1 - gap / CLOSE_M);
          if (b > hi + BOOST_MAX) b = hi + BOOST_MAX;
          if (b > v) car.v = b;
          car.close = gap;
          cool = BOOST_COOL;
        }
      }
    }
    car.cool = cool;
    return car;
  }

  /* ── the traffic ─────────────────────────────────────────────────────────
     A record is [id, lane, type, z0, t0, colour], or with a lane change
     [id, lane, type, z0, t0, colour, changeTick, toLane]. A car stays in its
     own lane's list and keeps its own lane's speed for life, even after it has
     moved over, and the cars were added front-most last, so each list stays
     sorted by z from the back of the queue to the front.

     A LANE CHANGE (Owen 2026-10-28). To the next lane only. The indicator
     flashes from SIGNAL ticks before changeTick (2.5 s); the move takes MOVE
     ticks (1.5 s), x easing over on 3s^2 - 2s^3 (only + - * /). From the
     indicator until the move is done the car counts as being in BOTH lanes
     (occupies) for the bot, the spawner and anything that asks what is in a
     lane; the hit test only ever uses where it really is (xAt). */
  const SIGNAL = 150, MOVE = 90;
  function zAt(rec, tick) { return rec[3] + LANE_V[rec[1]] * ((tick - rec[4]) * DT); }
  const changes = (rec) => rec.length >= 8;
  /* Where a traffic car is across the road on a tick. */
  function xAt(rec, tick) {
    const x0 = laneX(rec[1]);
    if (rec.length < 8) return x0;
    const k = tick - rec[6];
    if (k <= 0) return x0;
    const x1 = laneX(rec[7]);
    if (k >= MOVE) return x1;
    const s = k / MOVE;
    return x0 + (x1 - x0) * (s * s * (3 - 2 * s));
  }
  /* The ticks [from, to) in which a car counts as being in a lane (empty: from >= to). */
  function occFrom(rec, lane) {
    if (lane === rec[1]) return -Infinity;
    return changes(rec) && lane === rec[7] ? rec[6] - SIGNAL : Infinity;
  }
  function occTo(rec, lane) {
    if (lane === rec[1]) return changes(rec) ? rec[6] + MOVE : Infinity;
    return changes(rec) && lane === rec[7] ? Infinity : -Infinity;
  }
  function occupies(rec, lane, tick) { return tick >= occFrom(rec, lane) && tick < occTo(rec, lane); }
  /* The indicator (-1 left, 1 right) on a tick, else 0; and whether the brake lamps are lit (the last second before the move). */
  function signalAt(rec, tick) {
    if (rec.length < 8 || tick < rec[6] - SIGNAL || tick >= rec[6] + MOVE) return 0;
    return rec[7] > rec[1] ? 1 : -1;
  }
  /* Traffic never slows, so its brake lamps never light (Owen: lit when a car slows down; Fable review
     2026-10-28: a lamp on a car that keeps its speed misleads a player timing a pass). */
  function brakingAt() { return false; }
  function validRecord(r) {
    return Array.isArray(r) && (r.length === 6 || r.length === 8) && Number.isInteger(r[0]) && r[0] >= 0
      && Number.isInteger(r[1]) && r[1] >= 0 && r[1] < LANES
      && Number.isInteger(r[2]) && r[2] >= 0 && r[2] < TYPES.length
      && Number.isFinite(r[3]) && Number.isInteger(r[4]) && Number.isInteger(r[5])
      && (r.length === 6 || (Number.isInteger(r[6]) && r[6] >= r[4]
        && Number.isInteger(r[7]) && r[7] >= 0 && r[7] < LANES && (r[7] - r[1] === 1 || r[1] - r[7] === 1)));
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
        const list = this.lanes[l];
        for (let i = 0; i < list.length; i++) {
          const r = list[i], t = TYPES[r[2]];
          const dz = zAt(r, tick) - z;
          if (dz > CAR.HL + MAX_HL) break;            // sorted: everything after is further ahead
          if (dz <= -(CAR.HL + t.hl) || dz >= CAR.HL + t.hl) continue;
          if (Math.abs(x - xAt(r, tick)) < CAR.HW + t.hw) return r[0];
        }
      }
      return -1;
    }
    /* A close pass between ticks n and n + 1, for a car whose centre went from
       z0 to z1 and is at x on n + 1. Of the traffic cars whose front was at or
       ahead of our rear on n and is behind it on n + 1, the smallest side to
       side clearance on n + 1, when it is under CLOSE_M; else -1. Below 0 is a
       touch, never a pass (hitAt has already called it a crash). */
    closeAt(x, z0, z1, n) {
      const rear0 = z0 - CAR.HL, rear1 = z1 - CAR.HL;
      let best = -1;
      for (let l = 0; l < LANES; l++) {
        const list = this.lanes[l];
        for (let i = 0; i < list.length; i++) {
          const r = list[i];
          const c1 = zAt(r, n + 1);
          if (c1 >= rear1) break;                     // sorted: neither this nor any after is behind us yet
          const t = TYPES[r[2]];
          if (c1 + t.hl >= rear1 || zAt(r, n) + t.hl < rear0) continue;
          const gap = Math.abs(x - xAt(r, n + 1)) - (CAR.HW + t.hw);
          if (gap >= 0 && gap < CLOSE_M && (best < 0 || gap < best)) best = gap;
        }
      }
      return best;
    }
    /* The nearest car ahead of z (its back) that is in a lane on this tick, a car changing into or out
       of it included, for the bot and the HUD. */
    aheadIn(lane, z, tick) {
      let best = null, bestBack = Infinity;
      for (let k = lane - 1; k <= lane + 1; k++) {
        if (k < 0 || k >= LANES) continue;
        const list = this.lanes[k];
        for (let i = 0; i < list.length; i++) {
          const r = list[i];
          if (!occupies(r, lane, tick)) continue;
          const back = zAt(r, tick) - TYPES[r[2]].hl;
          if (back + TYPES[r[2]].L > z - CAR.HL) {           // not yet fully behind us
            if (back < bestBack) { bestBack = back; best = r; }
            break;                                          // sorted: the first one in a list is its nearest
          }
        }
      }
      return best;
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
    V0, V1, T_HALF, TOP_K, FLOOR_MIN, GAS, BRAKE, VX_LO, VX_HI, CLOSE_M, BOOST_MAX, OVER_EASE, BOOST_COOL,
    cruise, topSpeed, floorSpeed, vxMax, vxAcc, SIGNAL, MOVE,
    STEER_Q, INPUT_MAX, packInput, steerOf, pedalOf, NEUTRAL, validInput,
    newCar, copyCar, step, zAt, xAt, changes, occFrom, occTo, occupies, signalAt, brakingAt, validRecord, Traffic, rng, kmh,
  };
});
