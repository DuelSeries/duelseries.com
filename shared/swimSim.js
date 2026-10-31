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
  const VERSION = 6;

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
  /* A WIDER ROAD (the Swim Race event, server/swim/SwimEvent.js): any number of
     lanes, lane 0 still at -5.4 and each next one 3.6 m further right, so the
     duel's road is lanes 0 to 3 of it. It is four-lane carriageways side by
     side: lane l goes at LANE_V[l & 3] (fast on the left of each four), and
     the traffic never changes lane across a carriageway line
     (server/swim/swimTraffic.js), so any four lanes from a multiple of four
     are the duel's road exactly. A Traffic knows how many lanes it has, and
     where its barriers are. */
  const laneV = (l) => LANE_V[l & 3];

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
     FULL SPEED FROM THE FIRST SECOND (Owen 2026-10-30: "make it so my car can
     go through all the gears and actually reach top speed from the start").
     Both cars start on tick 0 at V0 (130 km/h) and the gas takes them to TOP
     (V1 * TOP_K, about 351 km/h) in about 5.6 s, through every gear. Until
     then the top speed was tied to the clock, 16% over cruise(), so it was
     150 km/h at the start and still only 305 after four minutes. cruise() is
     now only the steady pace of the tuning script's plain driver
     (scripts/swimBotSim.js); the road still gets harder with time through the
     traffic, which gets denser (server/swim/swimTraffic.js).

     NO AUTO-THROTTLE (Owen 2026-10-28: "letting go of W can still speed you
     up"). The car only gains speed while the gas is held, up to topSpeed. Let
     go and it coasts down on engine braking plus drag, COAST + DRAG v^2 m/s
     every second (1.65 at the start, 2.5 at 216 km/h, 4.5 flat out), all the
     way to a stop if you wait; S brakes at BRAKE, far harder. There is no
     floor: a stopped or slow car is a sitting target for the traffic coming up
     behind it, and touching that from behind counts the same as any touch.
     Braking is still the way out of a box (drop in behind a car alongside and
     pull out behind it), but it costs ground, which is the whole game against
     the 200 m rule.

     STOPPING NEVER WINS (shared rules, judged in server/swim/SwimRoom.js). A
     car that stops or crawls falls BEHIND_LOSE metres back from one that keeps
     driving within seconds and loses, or is hit by traffic from behind first.
     If BOTH crawl and neither ever falls 200 m back or touches anything, the
     30 minute cap calls it a draw and refunds both stakes: nobody profits, so
     it is no way to win and no way to take money (test/swim.test.js). */
  const V0 = 36, V1 = 84, T_HALF = 70;
  const TOP_K = 1.16, TOP = V1 * TOP_K;
  const GAS = 11, BRAKE = 22, COAST = 1.2, DRAG = 0.00035, SCRAPE = 9;

  /* THE WHEEL GETS HEAVIER WITH SPEED (Owen 2026-10-28). Sideways speed at
     full lock is 11.5 - 0.075 v, held between 4.5 and 10.5 m/s: about 8.8 at
     the start (a lane in half a second), 5.2 at the late cruise, 4.5 flat
     out. How fast it answers the wheel scales with it, so full lock is always
     reached in about 0.19 s. Only * - and comparisons, so every engine agrees.
     Below about 15 m/s (only reachable since the floor went, 2026-10-28) it is
     also held to VX_SLIP times the speed, so a stopped car cannot slide across
     the road out of the way of traffic coming up behind it. */
  const VX_0 = 11.5, VX_K = 0.075, VX_LO = 4.5, VX_HI = 10.5, VX_SLIP = 0.7;
  const VX_RISE = 46 / 8.6;           // sideways acceleration per m/s of sideways top speed
  function vxMax(v) {
    let m = VX_0 - VX_K * v;
    m = m < VX_LO ? VX_LO : m > VX_HI ? VX_HI : m;
    const slip = VX_SLIP * v;
    return slip < m ? slip : m;
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
  /* The same on every tick; callers still pass the tick, which it ignores. */
  function topSpeed() { return TOP; }
  /* What the car loses in a second with no pedal at speed v: engine braking plus drag. */
  function coastDecel(v) { return COAST + DRAG * v * v; }

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
  /* THE EVENT'S CARS ARE KEPT ON A GRID (server/swim/SwimEvent.js, public/js/swim/swimEventMain.js): after every
     step, z and v to 0.1 mm, x and vx to 0.01 mm. Both ends do it the same way after the same step, so they still
     agree to the last bit, and a car's row is exact in a few digits: a screen that predicted right sees exactly
     its own row, and one that was corrected is exactly back on the server's car (the duel never calls it). */
  function quantize(c) {
    c.z = Math.round(c.z * 1e4) / 1e4; c.v = Math.round(c.v * 1e4) / 1e4;
    c.x = Math.round(c.x * 1e5) / 1e5; c.vx = Math.round(c.vx * 1e5) / 1e5;
    return c;
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
    const hi = TOP;

    let v = car.v;
    if (pedal < 0) v -= BRAKE * DT;
    else if (pedal > 0) {
      if (v > hi) { v -= OVER_EASE * DT; if (v < hi) v = hi; }   // a boost bleeding off to the top speed
      else { v += GAS * DT; if (v > hi) v = hi; }
    } else {
      /* Coasting; a boost never bleeds off slower with the foot off than on the gas. */
      let d = coastDecel(v);
      if (v > hi && d < OVER_EASE) d = OVER_EASE;
      v -= d * DT;
    }
    if (v < 0) v = 0;

    const reach = vxMax(v);
    const want = steer * reach;
    let vx = car.vx;
    const dv = reach * VX_RISE * DT;
    if (vx < want) { vx += dv; if (vx > want) vx = want; }
    else if (vx > want) { vx -= dv; if (vx < want) vx = want; }
    /* Never more sideways speed than this forward speed allows, so a car that stops does not keep sliding (Fable review 2026-10-28). */
    if (vx > reach) vx = reach; else if (vx < -reach) vx = -reach;
    let x = car.x + vx * DT;
    let wall = 0;
    /* The barrier stops you and scrubs a little speed while you lean on it.
       It never ends the match: the rule is about traffic. A wider road's
       barriers come with its traffic (Traffic wallL, wallR). */
    const wr = traffic && traffic.wallR !== undefined ? traffic.wallR : WALL;
    const wl = traffic && traffic.wallL !== undefined ? traffic.wallL : -WALL;
    if (x > wr) { x = wr; if (vx > 0) vx = 0; wall = 1; }
    else if (x < wl) { x = wl; if (vx < 0) vx = 0; wall = -1; }
    if (wall !== 0 && steer * wall > 0) { v -= SCRAPE * DT; if (v < 0) v = 0; }

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
  function zAt(rec, tick) { return rec[3] + LANE_V[rec[1] & 3] * ((tick - rec[4]) * DT); }
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
  function validRecord(r, lanes) {
    const n = lanes > 0 ? lanes : LANES;
    return Array.isArray(r) && (r.length === 6 || r.length === 8) && Number.isInteger(r[0]) && r[0] >= 0
      && Number.isInteger(r[1]) && r[1] >= 0 && r[1] < n
      && Number.isInteger(r[2]) && r[2] >= 0 && r[2] < TYPES.length
      && Number.isFinite(r[3]) && Number.isInteger(r[4]) && Number.isInteger(r[5])
      && (r.length === 6 || (Number.isInteger(r[6]) && r[6] >= r[4]
        && Number.isInteger(r[7]) && r[7] >= 0 && r[7] < n && (r[7] - r[1] === 1 || r[1] - r[7] === 1)));
  }
  /* The most lanes a road may have (the event's cap is under it). */
  const MAX_LANES = 64;
  /* Where the right barrier stops a car's centre on a road of n lanes. */
  const wallRightOf = (n) => (n === LANES ? WALL : WALL + (n - LANES) * LANE_W);
  /* The lane nearest x on any road (it may be off the road: callers clamp). */
  const laneOfX = (x) => Math.round(x / LANE_W + (LANES - 1) / 2);
  /* The first index in a lane's list whose car is at or past z on this tick:
     every car in one list goes the same speed, so a list sorted by z stays
     sorted on every tick. */
  function firstFrom(list, z, tick) {
    let lo = 0, hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (zAt(list[mid], tick) < z) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  class Traffic {
    /* lanes: how many (the duel's 4 when left out). */
    constructor(lanes) {
      const n = Number.isInteger(lanes) && lanes > 0 && lanes <= MAX_LANES ? lanes : LANES;
      this.n = n;
      this.wallL = -WALL;
      this.wallR = wallRightOf(n);
      this.byId = new Map();
      this.lanes = [];
      for (let l = 0; l < n; l++) this.lanes.push([]);
    }
    add(rec) {
      if (!validRecord(rec, this.n) || this.byId.has(rec[0])) return false;
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
    /* Only the lists a car near x can be in matter: a car moves one lane at
       most, so two lanes either side of the nearest is every car that can
       reach x (3.6 m a lane, under 2.7 m to touch or pass close). Each list is
       searched from just behind z: the answer is what scanning every lane
       from its back would give, on any road. */
    hitAt(x, z, tick) {
      const lc = laneOfX(x), l0 = lc - 2 < 0 ? 0 : lc - 2, l1 = lc + 2 >= this.n ? this.n - 1 : lc + 2;
      for (let l = l0; l <= l1; l++) {
        const list = this.lanes[l];
        for (let i = firstFrom(list, z - (CAR.HL + MAX_HL) - 1, tick); i < list.length; i++) {
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
      const lc = laneOfX(x), l0 = lc - 2 < 0 ? 0 : lc - 2, l1 = lc + 2 >= this.n ? this.n - 1 : lc + 2;
      for (let l = l0; l <= l1; l++) {
        const list = this.lanes[l];
        for (let i = firstFrom(list, rear0 - MAX_HL - 1, n + 1); i < list.length; i++) {
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
        if (k < 0 || k >= this.n) continue;
        const list = this.lanes[k];
        for (let i = firstFrom(list, z - CAR.HL - MAX_HL * 2 - 1, tick); i < list.length; i++) {
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
    LANES, LANE_W, ROAD_HALF, LANE_V, laneX, laneV, laneOfX, MAX_LANES, wallRightOf, firstFrom, CAR, WALL, TYPES, MAX_HL,
    V0, V1, T_HALF, TOP_K, TOP, GAS, BRAKE, COAST, DRAG, VX_LO, VX_HI, VX_SLIP, CLOSE_M, BOOST_MAX, OVER_EASE, BOOST_COOL,
    cruise, topSpeed, coastDecel, vxMax, vxAcc, SIGNAL, MOVE,
    STEER_Q, INPUT_MAX, packInput, steerOf, pedalOf, NEUTRAL, validInput,
    newCar, copyCar, quantize, step, zAt, xAt, changes, occFrom, occTo, occupies, signalAt, brakingAt, validRecord, Traffic, rng, kmh,
  };
});
