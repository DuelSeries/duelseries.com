'use strict';
/* ─── Swim: the stand-in driver for a free table ──────────────────────────────
   A free seat alone for a minute races this (server/swim/SwimLobby.js, the
   same rule as Knockout's; a paid table never gets one). It drives the same
   car through the same physics (shared/swimSim.js step) with the same kind of
   input a phone sends: a wheel and a pedal per tick. It never moves the car
   any other way, and since 2026-10-28 it holds the gas itself (no pedal only
   coasts).

   HOW IT DRIVES (Owen 2026-10-30, once the full top speed was there from the
   start: "make it as good as it can get... really good and hard to beat").
   Every look it reads every traffic car within reach (never past the fog),
   several deep in each lane, where it is and where it will be (zAt, and xAt
   once the indicator is on: a car signalling into a lane counts in both lanes
   from then until it has moved over, the game's own rule). Then it SEARCHES
   for a line through them: legs of LEGS ticks, HORIZON in all, each heading
   for a lane (any lane on the first leg, the same or the next one after) on
   the gas or the brake, every leg driven on the real step against what it
   saw. A line that touches anything with less than MX sideways or MZ
   lengthwise to spare (more for a car it judged from further off, Seen.build
   u) is out. Of the rest the BEAM best in each lane at each speed
   (SPEED_BAND) go on to the next leg, so it threads a run of cars several
   lane changes deep, and a slower line that braked in time is never crowded
   out by faster ones heading into a wall. It takes the line that ends
   furthest down the road, fastest, with the most room in front of it at the
   top speed and beside it, and never one that ends cornered (a car in its
   line it could not slow for, Seen.cornered), so the next look always has a
   way out; the line it is already on, driven on, is always a candidate. On a
   gas leg it brakes only for a car in its line whose closing speed it could
   not shed in the gap left (ACC_GAP plus ACC_LAG s of it plus the distance at
   ACC_BRAKE), and not for one the wheel takes it out of the way of first
   (clears). It keeps the same room whoever leads: until 2026-10-30 it kept
   more once 100 m ahead, and that jump left the line it was on touching and
   no line at all, so it crashed while winning.

   CLOSE PASSES. When it is about to go by a car in a lane beside the one its
   line starts in, it also tries the same line with the start held beside that
   car, PASS_LO to PASS_HI m of daylight by its own judgement (a pass that
   pays a boost, shared/swimSim.js CLOSE_M), with PASS_MX to spare against
   everything, and takes it when it survives the whole way and scores better.
   Never a line that it saw touching anything.

   HOW IT LOSES. It acts on what it saw LAG ticks earlier (picked each look)
   and looks again only then; now and then (LAPSE of looks) it looks away for
   LAPSE_MIN to LAPSE_MIN + LAPSE_SPREAD ticks more. It misjudges each car (its
   own error for each, steady): how far ahead by SIGMA0 of the distance at the
   start growing towards SIGMA0 + SIGMA1, and where it is across the road by
   up to SIDE0 m growing towards SIDE0 + SIDE1 (both half way after T_ERR s).
   Its close passes are aimed by that judgement, so late on, fast and in dense
   traffic, some go closer than it meant and touch, the way a person's do.
   (Halved 2026-10-30, the look-aways cut to a third: what it sees is what a
   screen shows, it just reads it like a good player.)

   THE NUMBERS. LAG 7 to 10 ticks (117 to 167 ms); HORIZON 200 ticks (3.3 s)
   in LEGS of 12 to 72 ticks, BEAM 3 lines a lane in 10 m/s bands; MX 0.3 m
   and MZ 1.0 m; ACC_GAP 2.5 m, ACC_LAG 0.2 s, ACC_BRAKE 16 m/s^2; close
   passes aimed at 0.32 to 0.46 m, PASS_MX 0.2 m; distance error 1.5% rising
   towards 4.5%, sideways error 0.03 m rising towards 0.23 m (T_ERR 150 s);
   LAPSE 0.5% of looks, 12 to 36 ticks. Measured with scripts/swimBotSim.js,
   60 races each (2026-10-30): against the bot before this search it wins 58
   (the old one falls 200 m behind, median race 16.3 s; it crashed twice);
   against its own driving with a person's judging errors (ace) 56; against
   the strong and the average person's stand-ins 60 and 59. Alone it makes
   620 m in its first 10 s and 1,957 m in 30 (the old one 536 and 1,609;
   flat out from the start is about 800 in 10 s) and crashed in 2 of 20
   three minute runs (the old one 11). About a quarter of a millisecond of
   CPU a tick on a desktop; see Budget. */

const S = require('../../shared/swimSim');

const LAG_MIN = 7, LAG_SPREAD = 4;          // 7..10 ticks between seeing and acting
const HORIZON = 200;                        // ticks each plan is driven ahead
const MX = 0.3, MZ = 1.0;                   // the room it keeps, sideways and lengthwise (m)
const PASS_MX = 0.2, PASS_LO = 0.32, PASS_HI = 0.46;
const PASS_SECS = 2.5;                      // how soon a car must be passed to try a close line by it
const PASS_BONUS = 6;                       // metres a surviving close pass is worth over the plain line
/* The search's legs (ticks each, HORIZON in all: short first, where it matters most), the pedals a
   leg may have (0: the gas with the follow rule below, -1: the brake), and how many lines it keeps
   going in each lane after every leg. */
const LEGS = [12, 12, 16, 20, 28, 40, 72];
const PEDALS = [0, -1];
const BEAM = 3, SPEED_BAND = 10;
const CORNERED = 400;                      // metres a line is marked down for ending cornered (Seen.cornered)
/* The follow rule on a gas leg: the gas, unless the first car ahead in its line is closer than
   ACC_GAP + ACC_LAG s of the closing speed + the distance to shed it at ACC_BRAKE, then the brake
   (coasting if it is not closing). */
const ACC_GAP = 2.5, ACC_LAG = 0.2, ACC_BRAKE = 16;
const BEHIND = 60;                          // metres behind the car it keeps watching
const ROOM_CAP = 4;                         // seconds of room past which more is no better
const W_ROOM = 14, W_SIDE = 4, W_SPEED = 1, LANE_COST = 1.5;
const SIGMA0 = 0.015, SIGMA1 = 0.03, T_ERR = 150;
const LAPSE = 0.005, LAPSE_MIN = 12, LAPSE_SPREAD = 25;
/* How far off it judges each car's place across the road (its own for each car), up to SIDE0 m at
   the start, towards SIDE0 + SIDE1 late on (half way at T_ERR s). It aims its close passes by it. */
const SIDE0 = 0.03, SIDE1 = 0.2;

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

/* The leg of plan p k ticks after it starts; past the last, its line held on the gas. */
function legAt(p, k) {
  const legs = p.legs;
  for (let i = 0; i < legs.length; i++) { if (k < legs[i].n) return legs[i]; k -= legs[i].n; }
  return p.hold || (p.hold = { tx: legs[legs.length - 1].tx, ped: 0, n: Infinity });
}
/* The legs left after the first `skip` ticks. */
function legsAfter(legs, skip) {
  const out = [];
  for (const l of legs) {
    if (skip >= l.n) { skip -= l.n; continue; }
    out.push(skip > 0 ? { tx: l.tx, ped: l.ped, n: l.n - skip } : l);
    skip = 0;
  }
  return out;
}

/* A SHARED CPU BUDGET (2026-10-30). The search costs several times what the old one-lane plans did (about
   a quarter of a millisecond a tick per bot on a desktop, 6.6 times the old bot; 3 times with one line a
   lane), and up to 75 free tables can run at once (server/index.js freeRoomCap). SwimRoom hands every bot on
   the server the one SERVER_BUDGET: once the bots together have spent more than busyMs of the last second
   searching (level 1), each look keeps BEAM_BUSY lines a lane instead of BEAM; past twice that (level 2) it
   also looks half as often. Still better than the old bot at level 1 (measured: 566 m in its first 10 s
   against the old bot's 536, no crash in 20 runs of 3 minutes against its 11). A bot made without a budget
   (the tests, the harness) always searches in full. */
class Budget {
  constructor(busyMs) { this.busyMs = busyMs; this.spent = 0; this.last = 0; this.since = -Infinity; }
  level() { return this.last > 2 * this.busyMs ? 2 : this.last > this.busyMs ? 1 : 0; }
  add(ms, now) {
    if (now - this.since >= 1000) { this.last = this.spent; this.spent = 0; this.since = now; }
    this.spent += ms;
  }
}
const BUSY_MS = 150, BEAM_BUSY = 1;
const SERVER_BUDGET = new Budget(BUSY_MS);

/* What the bot saw on one look: each car within reach with where it thinks it is. It answers the
   step's two questions (hitAt with the bot's margins, closeAt) so a plan is tried on the real step. */
class Seen {
  constructor() { this.obs = []; this.sub = []; this.act = this.obs; this.mx = MX; this.mz = MZ; }
  build(traffic, car, tick, sigma, sideErr, seed, rand) {
    const obs = this.obs;
    obs.length = 0;
    this.act = obs;
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
        /* u: how far out it knows that guess can be (the most its error can come to at this distance),
           kept as extra room lengthwise, so it never plans a line that only works if it judged right. */
        const o = { id: r[0], z0: car.z + d * (1 + err), u: Math.abs(d) * sigma * 1.3, T: tick, v: S.LANE_V[r[1]], hl: t.hl, hw: t.hw,
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
  /* Narrow hitAt, closeAt and the follow rule (act) to the cars that a leg of n ticks from `car`,
     steering for tx, could touch, pass close or have to slow for: across the road, those reaching
     into the band from where it is to tx (and a little either side, for the slide it may still have);
     along it, those over the stretch it can cover on the leg, plus its stopping distance ahead and a
     second of the fastest traffic behind (all that cornered asks about at the leg's end). The same
     answers as asking every car, for a fraction of the work. all() puts every car back. */
  focus(car, tx, n) {
    const act = this.act = this.sub;
    act.length = 0;
    const room = (this.mx > S.CLOSE_M ? this.mx : S.CLOSE_M) + HW + 1.2;
    const xl = (car.x < tx ? car.x : tx) - room, xh = (car.x > tx ? car.x : tx) + room;
    const v = car.v + S.BOOST_MAX, n0 = car.tick, n1 = n0 + n;
    const zl = car.z - HL - S.LANE_V[0], zh = car.z + v * n * S.DT + HL + ACC_GAP + v * ACC_LAG + v * v / (2 * ACC_BRAKE);
    const obs = this.obs;
    for (let i = 0; i < obs.length; i++) {
      const o = obs[i];
      if (Math.max(o.hi, o.end) + o.hw < xl || Math.min(o.lo, o.end) - o.hw > xh) continue;
      const a = Seen.zOf(o, n0), b = Seen.zOf(o, n1), w = o.hl + o.u + this.mz;
      if ((a > b ? a : b) + w < zl || (a < b ? a : b) - w > zh) continue;
      act.push(o);
    }
  }
  all() { this.act = this.obs; }
  hitAt(x, z, n) {
    const obs = this.act;
    for (let i = 0; i < obs.length; i++) {
      const o = obs[i];
      const dz = Seen.zOf(o, n) - z, lim = HL + o.hl + this.mz + o.u;
      if (dz <= -lim || dz >= lim) continue;
      if (Seen.side(o, x, n) < this.mx) return o.id;
    }
    return -1;
  }
  closeAt(x, z0, z1, n) {
    const rear0 = z0 - HL, rear1 = z1 - HL;
    let best = -1;
    const obs = this.act;
    for (let i = 0; i < obs.length; i++) {
      const o = obs[i];
      if (Seen.zOf(o, n + 1) + o.hl >= rear1 || Seen.zOf(o, n) + o.hl < rear0) continue;
      const gap = Seen.side(o, x, n + 1);
      if (gap >= 0 && gap < S.CLOSE_M && (best < 0 || gap < best)) best = gap;
    }
    return best;
  }
  /* Whether a car at (x, z, v) on tick n is cornered in its line: a car ahead in it that it could not
     shed the closing speed for at ACC_BRAKE in the room there is, or one coming up from behind that
     would reach it inside a second. A line may end anywhere but there, so the next look always has a
     way out (the brake, if nothing else). */
  cornered(x, z, v, n) {
    const obs = this.act;
    for (let i = 0; i < obs.length; i++) {
      const o = obs[i];
      if (Seen.side(o, x, n) >= this.mx) continue;
      const zo = Seen.zOf(o, n);
      const gap = zo - o.hl - (z + HL) - o.u;
      if (gap >= 0) { const dv = v - o.v; if (dv > 0 && gap < ACC_GAP + dv * dv / (2 * ACC_BRAKE)) return true; continue; }
      const back = z - HL - (zo + o.hl) - o.u;
      if (back >= 0) { if (o.v > v && back < (o.v - v) * 1) return true; continue; }
      return true;
    }
    return false;
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
    this.budget = o.budget || null;
    this.seen = new Seen();
    this.sim = S.newCar(0);
    this.base = S.newCar(0);
    this.plan = null;
    this.pending = null;
    this.nextLook = 0;
  }

  /* The packed input a plan gives on the car's tick: the wheel for its leg's line, and the brake on a
     braking leg; on any other leg the gas, unless a car in its line comes up faster than it can shed
     the difference (ACC_*) and the wheel does not take it out of that car's way first (clears). */
  codeOf(p, car) {
    const k = car.tick - p.at;
    const leg = legAt(p, k);
    let pedal = 1;
    if (leg.ped < 0) pedal = -1;
    else {
      const obs = this.seen.act, n = car.tick;
      for (let i = 0; i < obs.length; i++) {
        const o = obs[i];
        const gap = Seen.zOf(o, n) - o.hl - (car.z + HL) - o.u;
        if (gap < 0 || Seen.side(o, car.x, n) >= p.mx) continue;
        const dv = car.v - o.v;
        if (gap >= ACC_GAP + (dv > 0 ? dv * ACC_LAG + dv * dv / (2 * ACC_BRAKE) : 0)) continue;
        if (dv > 0 && SwimBot.clears(p, car, o, k, gap / dv)) continue;
        pedal = dv > 0 ? -1 : 0;
        break;
      }
    }
    return S.packInput(steerTo(car, leg.tx), pedal);
  }
  /* Whether the wheel on plan p's line now (k ticks in) takes the car out of car o's way sideways by
     the time it would reach it, `secs` from now at this closing speed: at the most sideways speed
     this forward speed allows, after a moment to wind it on. Only the leg it is on counts, never a
     later one, so a line drives exactly as the search tried it leg by leg. */
  static clears(p, car, o, k, secs) {
    const tx = legAt(p, k).tx;
    const reach = S.vxMax(car.v) * Math.max(0, secs - 0.2);
    const e = tx - car.x;
    const x = car.x + (e > reach ? reach : e < -reach ? -reach : e);
    return Seen.side(o, x, car.tick + Math.round(secs * S.HZ)) >= p.mx;
  }

  /* How a plan that ends at `sim` scores: the road it made, its speed, the room in front of it at the
     top speed (sitting behind a car is no room at all) and in the lane beside it, a close pass, and a
     little for every lane change (so it does not weave for nothing). */
  score(sim, boosts, changes) {
    const seen = this.seen, x = sim.x, n = sim.tick, top = Math.max(sim.v, S.topSpeed(n));
    let side = 0;
    const lane = nearestLane(x);
    for (const k of [lane - 1, lane + 1]) {
      if (k >= 0 && k < S.LANES) { const r = seen.room(S.laneX(k), sim.z, top, n); if (r > side) side = r; }
    }
    return sim.z + W_SPEED * sim.v + W_ROOM * seen.room(x, sim.z, top, n) + W_SIDE * side
      + (boosts ? PASS_BONUS : 0) - LANE_COST * changes - (seen.cornered(x, sim.z, sim.v, n) ? CORNERED : 0);
  }

  /* Drive plan p from the car `start` (on tick p.at) HORIZON ticks on what was seen. */
  tryPlan(start, p, changes) {
    const sim = S.copyCar(start, this.sim);
    const end = p.at + HORIZON;
    let boosts = 0;
    while (sim.tick < end) {
      S.step(sim, this.codeOf(p, sim), this.seen);
      if (!sim.alive) return { p, alive: false, ticks: sim.tick - p.at, score: -1e9 + (sim.tick - p.at) };
      if (sim.close >= 0) boosts++;
    }
    return { p, alive: true, ticks: HORIZON, score: this.score(sim, boosts, changes), boosts, changes };
  }

  look(car, traffic, tick, opp) {
    const t0 = this.budget ? performance.now() : 0;
    const busy = this.budget ? this.budget.level() : 0;
    const width = busy ? BEAM_BUSY : BEAM;
    const lag = LAG_MIN + Math.floor(this.rand() * LAG_SPREAD);
    const at = tick + lag;
    const t = tick * S.DT;
    const late = t / (t + T_ERR);
    const sigma = this.sigma0 + this.sigma1 * late;
    const seen = this.seen;
    seen.build(traffic, car, tick, sigma, this.side0 + this.side1 * late, this.seed, this.rand);
    /* The same room kept whoever leads: room that jumps the moment it gets 100 m ahead turns the line
       it is on, clear a moment ago, into one that touches, and leaves it no line at all (it used to). */
    const mx = MX, mz = MZ;
    seen.mz = mz;

    /* Where the car will be when this look's plan takes over: the current plan driven on to then, with
       the room that plan keeps (a close pass keeps less, PASS_MX: judged by the usual room, a pass it is
       half way through would look like a touch, and it would have no line it thought clear). */
    const cur = this.plan;
    seen.mx = cur.mx;
    const base = S.copyCar(car, this.base);
    while (base.tick < at) {
      S.step(base, this.codeOf(cur, base), seen);
      if (!base.alive) {                       // it saw itself hit something before it can act: drive on blind
        S.copyCar(car, base);
        while (base.tick < at) S.step(base, this.codeOf(cur, base), null);
        break;
      }
    }
    const here = nearestLane(legAt(cur, at - cur.at).tx);
    seen.mx = mx;

    /* THE SEARCH. Legs of LEGS ticks each; every leg of every line kept goes on in the lane it is in or
       the next one either way, on the gas or the brake, driven on the real step against what it saw.
       A line that touches anything is dropped; of the rest the BEAM best in each lane go on, judged by
       the road they have made plus what their speed makes of the time left. So it finds its way
       through a run of cars several lane changes deep and only brakes where no line on the gas gets
       through. If no line lasts the whole way, it takes the one that lasted longest. */
    let beam = [{ sim: S.copyCar(base), legs: [], lane: here, boosts: 0, changes: 0 }];
    let used = 0, longest = null;
    for (let d = 0; d < LEGS.length && beam.length; d++) {
      const n = LEGS[d];
      used += n;
      const next = [];
      for (const node of beam) {
        /* The first leg may head for any lane (straight there, not a lane at a time); later ones for
           the lane they are in or the next. */
        const lo = d ? node.lane - 1 : 0, hi = d ? node.lane + 1 : S.LANES - 1;
        for (let l = lo; l <= hi; l++) {
          if (l < 0 || l >= S.LANES) continue;
          for (const ped of PEDALS) {
            const legs = node.legs.concat({ tx: S.laneX(l), ped, n });
            const p = { at, legs, mx };
            const sim = S.copyCar(node.sim);
            seen.focus(sim, S.laneX(l), n);
            let boosts = node.boosts, alive = true;
            for (let i = 0; i < n; i++) {
              S.step(sim, this.codeOf(p, sim), seen);
              if (!sim.alive) { alive = false; break; }
              if (sim.close >= 0) boosts++;
            }
            const child = { sim, legs, lane: l, boosts, changes: node.changes + Math.abs(l - node.lane), p };
            if (!alive) { if (!longest || sim.tick > longest.sim.tick) longest = child; continue; }
            child.est = sim.z + sim.v * (HORIZON - used) * S.DT - LANE_COST * child.changes
              - (seen.cornered(sim.x, sim.z, sim.v, sim.tick) ? CORNERED : 0);
            next.push(child);
          }
        }
      }
      /* Keep the best in each lane at each speed (SPEED_BAND m/s bands), BEAM a lane at most, so a
         slower line that has braked in time is not crowded out by faster ones heading into a wall
         further on. */
      next.sort((a, b) => b.est - a.est);
      const kept = [], per = [0, 0, 0, 0], band = new Set();
      for (const c of next) {
        const key = c.lane * 64 + Math.floor(c.sim.v / SPEED_BAND);
        if (per[c.lane] >= width || band.has(key)) continue;
        band.add(key); per[c.lane]++; kept.push(c);
      }
      beam = kept;
    }
    seen.all();
    let best = null;
    for (const node of beam) {
      const score = this.score(node.sim, node.boosts, node.changes);
      if (!best || score > best.score) best = { p: node.p, alive: true, score, changes: node.changes };
    }
    /* The line it is already on, driven on: a line that was clear a moment ago is a candidate still
       (the search's legs start afresh every look and need not line up with it). */
    const rest = legsAfter(cur.legs, at - cur.at);
    seen.mx = cur.mx;
    const go = this.tryPlan(base, { at, legs: rest.length ? rest : [legAt(cur, at - cur.at)], mx: cur.mx }, 0);
    seen.mx = mx;
    if (go.alive ? !best || go.score >= best.score : !best && (!longest || go.ticks > longest.sim.tick - at)) best = go;
    if (!best) best = { p: longest.p, alive: false, score: -1e9 };

    /* A close pass by the nearest car about to go by on each side of the lane its line starts in: the
       same line, but the first part of it held beside that car with a little daylight, kept when it
       survives the whole way and pays. */
    if (best.alive && best.p.legs[0].ped >= 0) {
      const lane = nearestLane(best.p.legs[0].tx);
      for (const dir of [-1, 1]) {
        const m = lane + dir;
        if (m < 0 || m >= S.LANES) continue;
        let pick = null, pickT = PASS_SECS;
        for (const o of seen.obs) {
          if (o.until !== Infinity || nearestLane(o.lo) !== m) continue;
          const gap = Seen.zOf(o, at) + o.hl - (base.z - HL);      // its front to our rear
          if (gap <= 0 || base.v <= o.v) continue;
          const secs = gap / (base.v - o.v);
          if (secs < pickT) { pickT = secs; pick = o; }
        }
        if (!pick) continue;
        const g = PASS_LO + this.rand() * (PASS_HI - PASS_LO);
        const tx = pick.lo - dir * (HW + pick.hw + g);              // where it judges that car to be
        const hold = Math.min(HORIZON, Math.ceil(pickT * S.HZ) + 6);
        const p = { at, legs: [{ tx, ped: 0, n: hold }].concat(legsAfter(best.p.legs, hold)), mx: PASS_MX };
        seen.mx = PASS_MX;
        const r = this.tryPlan(base, p, best.changes);
        seen.mx = mx;
        if (r.alive && r.boosts && r.score > best.score) best = r;
      }
    }
    this.pending = { plan: best.p, at };
    let next = busy === 2 ? 2 * lag : lag;
    if (this.rand() < this.lapse) next += LAPSE_MIN + Math.floor(this.rand() * LAPSE_SPREAD);
    this.nextLook = tick + next;
    if (this.budget) { const now = performance.now(); this.budget.add(now - t0, now); }
  }

  /* The packed input for this tick (shared/swimSim.js packInput). */
  input(car, traffic, tick, opp) {
    if (!car.alive) return S.NEUTRAL;
    if (!this.plan) this.plan = { at: tick, legs: [{ tx: S.laneX(nearestLane(car.x)), ped: 0, n: Infinity }], mx: MX };
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

module.exports = { SwimBot, Budget, SERVER_BUDGET, HORIZON, MX, MZ, PASS_LO, PASS_HI };
