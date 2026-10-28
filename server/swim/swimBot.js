'use strict';
/* ─── Swim: the stand-in driver for a free table ──────────────────────────────
   A free seat alone for a minute races this (server/swim/SwimLobby.js, the
   same rule as Knockout's; a paid table never gets one). It drives the same
   car through the same physics (shared/swimSim.js step) with the same kind of
   input a phone sends: a wheel and a pedal per tick. It never moves the car
   any other way, and since 2026-10-28 it holds the gas itself (no pedal only
   coasts).

   HOW IT DRIVES (Owen 2026-10-28: "make it really good"). Every look it reads
   every traffic car within reach, several deep in each lane, where it is and
   where it will be (zAt, and xAt once the indicator is on: a car signalling
   into a lane counts in both lanes from then until it has moved over, the
   game's own rule). Then it tries plans, driving each one HORIZON ticks ahead
   on the real step against what it saw: hold the line it is on, or steer for
   any lane now or a moment later (DELAYS), with the gas held down, or a brake
   of 12, 30 or 60 ticks first to drop in behind a car alongside. On the gas a
   plan eases off behind a slower car in its line like a cruise control: it
   brakes once the gap is under ACC_GAP plus ACC_LAG s of the closing speed
   plus what it takes to shed that at ACC_BRAKE. A plan that touches anything
   with less than MX sideways or MZ lengthwise to spare is out, so it only
   cuts across when every lane on the way stays clear the whole time. Of the
   rest it takes the one that ends furthest down the road, fastest, with the
   most room left at the top speed in front of it and in the lanes beside it,
   so it moves early towards the lane with room in it rather than away from
   the nearest car, holds the top speed wherever that is safe and brakes only
   when it must.

   CLOSE PASSES. When it is about to go by a car in a lane beside the one it
   is heading for it also tries the line that leaves PASS_LO to PASS_HI m of
   daylight by its own judgement (a pass that pays a boost, shared/swimSim.js
   CLOSE_M), with PASS_MX to spare against everything, and takes it when it
   survives. Never a line that it saw touching anything.

   HOW IT LOSES. It acts on what it saw LAG ticks earlier (picked each look)
   and looks again only then; now and then (LAPSE of looks) it looks away for
   LAPSE_MIN to LAPSE_MIN + LAPSE_SPREAD ticks more. It misjudges each car (its
   own error for each, steady): how far ahead by SIGMA0 of the distance at the
   start growing towards SIGMA0 + SIGMA1, and where it is across the road by
   up to SIDE0 m growing towards SIDE0 + SIDE1 (both half way after T_ERR s).
   Its close passes are aimed by that judgement, so late on, fast and in dense
   traffic, some go closer than it meant and touch, the way a person's do. It
   keeps more room when well ahead and less when well behind.

   THE NUMBERS. LAG 7 to 10 ticks (117 to 167 ms); HORIZON 200 ticks (3.3 s);
   MX 0.3 m and MZ 1.0 m (0.22 and 0.7 when 100 m behind, 0.4 and 1.4 when
   100 m ahead); ACC_GAP 2.5 m, ACC_LAG 0.2 s, ACC_BRAKE 16 m/s^2; close passes
   aimed at 0.32 to 0.46 m, PASS_MX 0.2 m; distance error 3% rising towards 9%,
   sideways error 0.05 m rising towards 0.5 m (T_ERR 150 s); LAPSE 1.5% of
   looks, 12 to 36 ticks. Measured with scripts/swimBotSim.js, 60 races each
   (2026-10-28): bot against bot median 181 s (42 crashes, 18 fell behind,
   none under 10 s); against the old bot standing in for an average person
   it wins 58 of 60, median race 52 s, none under 10 s; alone it lasts 2 to 5
   minutes. About 37 us of CPU a tick. */

const S = require('../../shared/swimSim');

const LAG_MIN = 7, LAG_SPREAD = 4;          // 7..10 ticks between seeing and acting
const HORIZON = 200;                        // ticks each plan is driven ahead
const MX = 0.3, MZ = 1.0;                   // the room it keeps, sideways and lengthwise (m)
const PASS_MX = 0.2, PASS_LO = 0.32, PASS_HI = 0.46;
const PASS_SECS = 2.5;                      // how soon a car must be passed to try a close line by it
const PASS_BONUS = 6;                       // metres a surviving close pass is worth over the plain line
/* Ticks of braking a plan starts with (to drop in behind a car alongside), before its pedal rule:
   the gas, unless the first car ahead in its line is closer than ACC_GAP + ACC_LAG s of the closing
   speed + the distance to shed it at ACC_BRAKE, then the brake (coasting if it is not closing). */
const PROGRAMS = [0, 12, 30, 60];
const ACC_GAP = 2.5, ACC_LAG = 0.2, ACC_BRAKE = 16;
const DELAYS = [0, 30];                     // ticks before the wheel turns to another lane
const BEHIND = 60;                          // metres behind the car it keeps watching
const ROOM_CAP = 4;                         // seconds of room past which more is no better
const W_ROOM = 14, W_SIDE = 4, W_SPEED = 1, LANE_COST = 1.5, KEEP = 2;
const SIGMA0 = 0.03, SIGMA1 = 0.06, T_ERR = 150;
const LAPSE = 0.015, LAPSE_MIN = 12, LAPSE_SPREAD = 25;
/* How far off it judges each car's place across the road (its own for each car), up to SIDE0 m at
   the start, towards SIDE0 + SIDE1 late on (half way at T_ERR s). It aims its close passes by it. */
const SIDE0 = 0.05, SIDE1 = 0.45;

const HL = S.CAR.HL, HW = S.CAR.HW;

/* A steady number in [-1, 1) for a traffic car, its own for each bot: how this bot misjudges that car. */
function unit(id, seed) {
  let h = Math.imul((id | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967296) * 2 - 1;
}

/* The bot's own steering: towards x = tx, slowing the wheel so it stops on it. The same function
   drives the car and every plan it tries, so a plan drives exactly as it was tried. */
function steerTo(car, tx) {
  const e = tx - car.x;
  const reach = S.vxMax(car.v);
  if (reach <= 0 || (Math.abs(e) < 0.04 && Math.abs(car.vx) < 0.3)) return 0;
  const want = Math.sign(e) * Math.min(reach, Math.sqrt(2 * 0.85 * S.vxAcc(car.v) * Math.abs(e)));
  const s = (want - car.vx * 0.25) / reach;
  return s < -1 ? -1 : s > 1 ? 1 : s;
}

/* What the bot saw on one look: each car within reach with where it thinks it is. It answers the
   step's two questions (hitAt with the bot's margins, closeAt) so a plan is tried on the real step. */
class Seen {
  constructor() { this.obs = []; this.mx = MX; this.mz = MZ; }
  build(traffic, car, tick, sigma, sideErr, seed, rand) {
    const obs = this.obs;
    obs.length = 0;
    const ahead = (car.v + S.BOOST_MAX - S.LANE_V[S.LANES - 1]) * HORIZON * S.DT + 40;
    for (let l = 0; l < S.LANES; l++) {
      const list = traffic.lanes[l];
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        const zc = S.zAt(r, tick), d = zc - car.z;
        if (d > ahead) break;                                   // sorted: the rest are further on
        if (d < -BEHIND) continue;
        const t = S.TYPES[r[2]];
        const err = sigma * (unit(r[0], seed) + 0.3 * (rand() * 2 - 1));
        const o = { id: r[0], z0: car.z + d * (1 + err), T: tick, v: S.LANE_V[r[1]], hl: t.hl, hw: t.hw,
                    lo: S.laneX(r[1]), hi: S.laneX(r[1]), until: Infinity, end: S.laneX(r[1]) };
        /* Its indicator is on, or it is moving over: in both lanes until it is across. */
        if (r.length >= 8 && tick >= r[6] - S.SIGNAL) {
          const xb = S.laneX(r[7]);
          if (tick >= r[6] + S.MOVE) { o.lo = o.hi = o.end = xb; }
          else { o.lo = Math.min(o.lo, xb); o.hi = Math.max(o.hi, xb); o.until = r[6] + S.MOVE; o.end = xb; }
        }
        const ex = sideErr * unit(r[0], seed ^ 0x51ed27);
        o.lo += ex; o.hi += ex; o.end += ex;
        obs.push(o);
      }
    }
  }
  /* How far (sideways, beyond touching) x is from car o on tick n. */
  static side(o, x, n) {
    const lo = n < o.until ? o.lo : o.end, hi = n < o.until ? o.hi : o.end;
    return (x < lo ? lo - x : x > hi ? x - hi : 0) - (HW + o.hw);
  }
  static zOf(o, n) { return o.z0 + o.v * ((n - o.T) * S.DT); }
  hitAt(x, z, n) {
    const obs = this.obs;
    for (let i = 0; i < obs.length; i++) {
      const o = obs[i];
      const dz = Seen.zOf(o, n) - z, lim = HL + o.hl + this.mz;
      if (dz <= -lim || dz >= lim) continue;
      if (Seen.side(o, x, n) < this.mx) return o.id;
    }
    return -1;
  }
  closeAt(x, z0, z1, n) {
    const rear0 = z0 - HL, rear1 = z1 - HL;
    let best = -1;
    for (let i = 0; i < this.obs.length; i++) {
      const o = this.obs[i];
      if (Seen.zOf(o, n + 1) + o.hl >= rear1 || Seen.zOf(o, n) + o.hl < rear0) continue;
      const gap = Seen.side(o, x, n + 1);
      if (gap >= 0 && gap < S.CLOSE_M && (best < 0 || gap < best)) best = gap;
    }
    return best;
  }
  /* Seconds a car at (x, z, v) on tick n can hold that line before it reaches a car in it, or one
     coming up from behind reaches it; 0 with one alongside; ROOM_CAP when nothing is in the way. */
  room(x, z, v, n) {
    let best = ROOM_CAP;
    for (let i = 0; i < this.obs.length; i++) {
      const o = this.obs[i];
      if (Seen.side(o, x, n) >= MX) continue;
      const zo = Seen.zOf(o, n);
      const gap = zo - o.hl - (z + HL);
      if (gap > 0) { if (v > o.v) { const t = gap / (v - o.v); if (t < best) best = t; } continue; }
      const back = z - HL - (zo + o.hl);
      if (back > 0) { if (o.v > v) { const t = back / (o.v - v); if (t < best) best = t; } continue; }
      return 0;
    }
    return best;
  }
}

class SwimBot {
  constructor(rand, opts) {
    const o = opts || {};
    this.rand = rand || Math.random;
    this.seed = Math.floor(this.rand() * 4294967296) | 0;
    this.sigma0 = o.sigma0 != null ? o.sigma0 : SIGMA0;
    this.sigma1 = o.sigma1 != null ? o.sigma1 : SIGMA1;
    this.lapse = o.lapse != null ? o.lapse : LAPSE;
    this.side0 = o.side0 != null ? o.side0 : SIDE0;
    this.side1 = o.side1 != null ? o.side1 : SIDE1;
    this.seen = new Seen();
    this.sim = S.newCar(0);
    this.base = S.newCar(0);
    this.plan = null;
    this.pending = null;
    this.nextLook = 0;
  }

  /* The packed input a plan gives on the car's tick. */
  codeOf(p, car) {
    const k = car.tick - p.at;
    let pedal = 1;
    if (k < p.b) pedal = -1;
    else {
      const obs = this.seen.obs, n = car.tick;
      for (let i = 0; i < obs.length; i++) {
        const o = obs[i];
        const gap = Seen.zOf(o, n) - o.hl - (car.z + HL);
        if (gap < 0 || Seen.side(o, car.x, n) >= p.mx) continue;
        const dv = car.v - o.v;
        if (gap < ACC_GAP + (dv > 0 ? dv * ACC_LAG + dv * dv / (2 * ACC_BRAKE) : 0)) { pedal = dv > 0 ? -1 : 0; break; }
      }
    }
    return S.packInput(steerTo(car, k < p.d ? p.from : p.tx), pedal);
  }
  /* Where a plan is steering on tick n. */
  static aim(p, n) { return n - p.at < p.d ? p.from : p.tx; }

  /* Drive plan p from the car `start` (on tick p.at) HORIZON ticks on what was seen. */
  tryPlan(start, p, mx, mz) {
    const sim = S.copyCar(start, this.sim), seen = this.seen;
    seen.mx = mx; seen.mz = mz;
    const end = p.at + HORIZON;
    let boosts = 0;
    while (sim.tick < end) {
      S.step(sim, this.codeOf(p, sim), seen);
      if (!sim.alive) return { p, alive: false, ticks: sim.tick - p.at, score: -1e9 + (sim.tick - p.at) };
      if (sim.close >= 0) boosts++;
    }
    const x = sim.x, n = sim.tick, top = Math.max(sim.v, S.topSpeed(n));
    let side = 0;
    const lane = nearestLane(x);
    for (const k of [lane - 1, lane + 1]) {
      if (k >= 0 && k < S.LANES) { const r = seen.room(S.laneX(k), sim.z, top, n); if (r > side) side = r; }
    }
    /* Room is reckoned at the top speed: sitting behind a car is no room at all. */
    const score = sim.z + W_SPEED * sim.v + W_ROOM * seen.room(x, sim.z, top, n) + W_SIDE * side + (boosts ? PASS_BONUS : 0);
    return { p, alive: true, ticks: HORIZON, score, boosts };
  }

  look(car, traffic, tick, opp) {
    const lag = LAG_MIN + Math.floor(this.rand() * LAG_SPREAD);
    const at = tick + lag;
    const t = tick * S.DT;
    const late = t / (t + T_ERR);
    const sigma = this.sigma0 + this.sigma1 * late;
    this.seen.build(traffic, car, tick, sigma, this.side0 + this.side1 * late, this.seed, this.rand);
    /* Keep more room well ahead, less well behind. */
    const lead = opp ? car.z - opp.z : 0;
    const mx = lead > 100 ? 0.4 : lead < -100 ? 0.22 : MX;
    const mz = lead > 100 ? 1.4 : lead < -100 ? 0.7 : MZ;

    /* Where the car will be when this look's plan takes over: the current plan driven on to then. */
    const cur = this.plan;
    const base = S.copyCar(car, this.base);
    this.seen.mx = mx; this.seen.mz = mz;
    while (base.tick < at) {
      S.step(base, this.codeOf(cur, base), this.seen);
      if (!base.alive) {                       // it saw itself hit something before it can act: drive on blind
        S.copyCar(car, base);
        while (base.tick < at) S.step(base, this.codeOf(cur, base), null);
        break;
      }
    }
    const from = SwimBot.aim(cur, at);
    const here = nearestLane(from);
    let best = null;
    const consider = (r, cost) => { r.score -= cost; if (!best || r.score > best.score) best = r; return r; };

    /* Hold the current line (a close-pass line included), then every lane centre. */
    consider(this.tryPlan(base, { at, b: 0, d: 0, tx: from, from, mx }, mx, mz), -KEEP);
    for (let l = 0; l < S.LANES; l++) {
      const tx = S.laneX(l), cost = LANE_COST * Math.abs(l - here);
      const delays = l === here ? [0] : DELAYS;
      for (const d of delays) {
        let first = true, done = false;
        for (const b of PROGRAMS) {
          const r = consider(this.tryPlan(base, { at, b, d, tx, from, mx }, mx, mz), cost + (d ? 0.5 : 0));
          if (r.alive) { done = first; break; }
          first = false;
        }
        if (done) break;                     // turning now on the gas survives: no need to wait
      }
    }

    /* A close pass by the nearest car about to go by on each side of the lane it is heading for. */
    if (best.alive && best.p.b === 0) {
      const lane = nearestLane(best.p.tx);
      for (const dir of [-1, 1]) {
        const m = lane + dir;
        if (m < 0 || m >= S.LANES) continue;
        let pick = null, pickT = PASS_SECS;
        for (const o of this.seen.obs) {
          if (o.until !== Infinity || nearestLane(o.lo) !== m) continue;
          const gap = Seen.zOf(o, at) + o.hl - (base.z - HL);      // its front to our rear
          if (gap <= 0 || base.v <= o.v) continue;
          const secs = gap / (base.v - o.v);
          if (secs < pickT) { pickT = secs; pick = o; }
        }
        if (!pick) continue;
        const g = PASS_LO + this.rand() * (PASS_HI - PASS_LO);
        const tx = pick.lo - dir * (HW + pick.hw + g);              // where it judges that car to be
        const r = this.tryPlan(base, { at, b: 0, d: 0, tx, from, mx: PASS_MX }, PASS_MX, mz);
        if (r.alive && r.boosts) consider(r, LANE_COST * Math.abs(lane - here));
      }
    }
    this.pending = { plan: best.p, at };
    let next = lag;
    if (this.rand() < this.lapse) next += LAPSE_MIN + Math.floor(this.rand() * LAPSE_SPREAD);
    this.nextLook = tick + next;
  }

  /* The packed input for this tick (shared/swimSim.js packInput). */
  input(car, traffic, tick, opp) {
    if (!car.alive) return S.NEUTRAL;
    if (!this.plan) { const x = S.laneX(nearestLane(car.x)); this.plan = { at: tick, b: 0, d: 0, tx: x, from: x, mx: MX }; }
    if (this.pending && tick >= this.pending.at) { this.plan = this.pending.plan; this.pending = null; }
    if (tick >= this.nextLook && !this.pending) this.look(car, traffic, tick, opp);
    return this.codeOf(this.plan, car);
  }
}

function nearestLane(x) {
  let best = 0, bd = Infinity;
  for (let l = 0; l < S.LANES; l++) {
    const d = Math.abs(x - S.laneX(l));
    if (d < bd) { bd = d; best = l; }
  }
  return best;
}

module.exports = { SwimBot, HORIZON, MX, MZ, PASS_LO, PASS_HI };
