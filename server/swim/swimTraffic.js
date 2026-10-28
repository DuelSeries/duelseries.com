'use strict';
/* ─── Swim: where the traffic comes from ──────────────────────────────────────
   Server only. Each lane is filled from the back of the queue to the horizon
   (H_AHEAD metres past whichever player is in front), one car at a time, a
   seeded random gap behind the last. A car is a record (shared/swimSim.js) and
   is sent to both screens once; it never changes lane or speed after that.

   HARDER WITH TIME. The gap behind each car shrinks from about 95 m at the
   start towards 17 m, half way there after 75 s, and trucks and buses get more
   common. With the cruise speed climbing at the same time, the road is denser
   and closing faster every second it lasts.

   NEVER A WALL. Before a car is placed, the other three lanes are checked for
   a car alongside it, twice: where they all are now, and where they will be
   when the front car reaches this spot at its current speed. If every other
   lane would be blocked at either moment, the car waits a little further back
   instead. So there is always at least one way through: the game is hard
   because it gets fast and tight, never because the road was shut. */

const S = require('../../shared/swimSim');

/* Metres past the front car that the road is filled to: a car is born there,
   out in the fog (public/js/swim/swimScene.js FOG_FAR is 60 m short of it),
   and is in clear view for over 4 s before a car flat out (about 350 km/h)
   reaches it in the slowest lane. */
const H_AHEAD = 520;
const START_CLEAR = 130;      // nothing within this of the start line
const G0 = 95, GMIN = 17, TG = 75;
const WIN = 7.5;              // the clear length a car needs to slip between two
const COLOURS = 10;           // how many paint colours a screen picks from

function laneGap(tick) {
  const t = Math.max(0, tick) * S.DT;
  return GMIN + (G0 - GMIN) * TG / (TG + t);
}
const r2 = (v) => Math.round(v * 100) / 100;

class Spawner {
  constructor(seed) {
    this.rand = S.rng(seed);
    this.nextId = 1;
    this.last = new Array(S.LANES).fill(null);
    // The first car in each lane lands somewhere in its first gap past the start.
    this.need = [];
    for (let l = 0; l < S.LANES; l++) this.need.push(this.rand() * G0);
  }

  pickType(lane, tick) {
    const big = S.LANES - lane <= 2;                       // the two right lanes
    const later = (tick * S.DT) / (tick * S.DT + 120);     // 0 at the start, towards 1
    let total = 0;
    const w = S.TYPES.map((t) => {
      if (t.right && !big) return 0;
      const k = t.right ? t.w * (1 + 0.8 * later) : t.w;
      total += k;
      return k;
    });
    let x = this.rand() * total;
    for (let i = 0; i < w.length; i++) { x -= w[i]; if (x < 0) return i; }
    return 0;
  }

  /* Would a car of `type` with its centre at z in `lane` shut all four lanes
     on `tick`? Another lane is blocked when one of its cars overlaps this one
     lengthways with less than WIN to spare. */
  shuts(traffic, lane, z, type, tick) {
    const hl = S.TYPES[type].L / 2;
    for (let l = 0; l < S.LANES; l++) {
      if (l === lane) continue;
      let blocked = false;
      for (const r of traffic.lanes[l]) {
        const c = S.zAt(r, tick), h = S.TYPES[r[2]].L / 2;
        if (c - h < z + hl + WIN && c + h > z - hl - WIN) { blocked = true; break; }
      }
      if (!blocked) return false;
    }
    return true;
  }

  /* Fill every lane up to the horizon on this tick. `leadZ` is the furthest any
     player has got, `leadV` that player's speed. New records are pushed onto
     `out` as well as into `traffic`. */
  run(traffic, tick, leadZ, leadV, out) {
    const horizon = leadZ + H_AHEAD;
    for (let l = 0; l < S.LANES; l++) {
      for (let guard = 0; guard < 12; guard++) {
        const last = this.last[l];
        const back = last ? S.zAt(last, tick) + S.TYPES[last[2]].L / 2 : START_CLEAR;
        const type = this.pickType(l, tick);
        const z = back + this.need[l] + S.TYPES[type].L / 2;
        if (z > horizon) break;
        /* Where this car will be when the front car gets to it, if both keep going as they are. */
        const close = Math.max(4, (leadV || S.V0) - S.LANE_V[l]);
        const meet = tick + Math.round(((z - leadZ) / close) * S.HZ);
        if (this.shuts(traffic, l, z, type, tick) || this.shuts(traffic, l, z + S.LANE_V[l] * (meet - tick) * S.DT, type, meet)) {
          this.need[l] += 5 + this.rand() * 9;   // wait a few metres and try again
          continue;
        }
        const rec = [this.nextId++, l, type, r2(z), tick, Math.floor(this.rand() * COLOURS)];
        traffic.add(rec);
        if (out) out.push(rec);
        this.last[l] = rec;
        this.need[l] = laneGap(tick) * (0.55 + this.rand() * 0.9);
      }
    }
  }
}

module.exports = { Spawner, H_AHEAD, START_CLEAR, laneGap, COLOURS };
