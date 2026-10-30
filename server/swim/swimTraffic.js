'use strict';
/* ─── Swim: where the traffic comes from ──────────────────────────────────────
   Server only. Each lane is filled from the back of the queue to the horizon
   (H_AHEAD metres past whichever player is in front), one car at a time, a
   seeded random gap behind the last. A car is a record (shared/swimSim.js) and
   is sent to both screens once; it never changes speed, and any lane change
   it makes is planned here and written into the record.

   HARDER WITH TIME. The gap behind each car shrinks from about 95 m at the
   start towards 17 m, half way there after 75 s, and trucks and buses get more
   common, so the road is denser every second it lasts. (The players' top
   speed no longer climbs with it: it is all there from the start, Owen
   2026-10-30, shared/swimSim.js.)

   NEVER A WALL. Before a car is placed, the other three lanes are checked for
   a car alongside it, twice: where they all are now, and where they will be
   when the front car reaches this spot at its current speed. If every other
   lane would be blocked at either moment, the car waits a little further back
   instead. So there is always at least one way through: the game is hard
   because it gets fast and tight, never because the road was shut. A car
   changing lane counts as being in both lanes from its indicator until it
   has moved over, here as everywhere (shared/swimSim.js occupies).

   LANE CHANGES (Owen 2026-10-28). About 1 car in 20 at the start and up to 1
   in 6 later changes to the next lane, timed to move while the front car is
   still a good way back (between 30% and 75% of the way from its birth to
   when the front car meets it), indicator on 2.5 s before. Only where the
   target lane has room for it, ROOM metres clear end to end of every car in
   that lane from the indicator until ROOM_AFTER ticks after the front car
   meets it, each at its own speed; and every new car gets the same room in
   its own lane from cars changing into it. */

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
const LEFT_BIG = 0.35;        // how much rarer a truck or bus is in the two left lanes than the right
const ROOM = 6;               // metres clear end to end that a car changing lane, or one beside it, keeps
const ROOM_AFTER = 360;       // ticks after the front car meets a car that the room must still be there

/* The share of new cars that change lane: 5% at the start, towards 17%. */
function changeChance(tick) {
  const t = Math.max(0, tick) * S.DT;
  return 0.05 + 0.12 * t / (t + 120);
}
/* The lanes (a bit mask) a car in lane, changing to `to` at ct (to -1: never), is in on tick. */
function occMask(lane, to, ct, tick) {
  let m = 1 << lane;
  if (to >= 0 && tick >= ct - S.SIGNAL) {
    m |= 1 << to;
    if (tick >= ct + S.MOVE) m &= ~(1 << lane);
  }
  return m;
}

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
    /* The type of each lane's next car, picked once and kept until it is placed. Picking afresh on
       every try let the shortest car that fitted under the horizon win each time, so trucks and buses
       almost never came (2026-10-28: 1 truck in 240 s of a test road for 198 sedans and 226 hatchbacks). */
    this.nextType = new Array(S.LANES).fill(-1);
    this.nextTo = new Array(S.LANES).fill(-1);       // and the lane it means to change to (-1: none)
    this.nextF = new Array(S.LANES).fill(0);         // and when, as a share of the way to meeting the front car
  }

  /* Trucks and buses mostly keep right, but any lane can have one (Owen
     2026-10-28: the line between the two left lanes is no safe corridor). */
  pickType(lane, tick) {
    const big = S.LANES - lane <= 2;                       // the two right lanes
    const later = (tick * S.DT) / (tick * S.DT + 120);     // 0 at the start, towards 1
    let total = 0;
    const w = S.TYPES.map((t) => {
      const k = t.right ? t.w * (1 + 0.8 * later) * (big ? 1 : LEFT_BIG) : t.w;
      total += k;
      return k;
    });
    let x = this.rand() * total;
    for (let i = 0; i < w.length; i++) { x -= w[i]; if (x < 0) return i; }
    return 0;
  }

  /* Would a car of `type` with its centre at z shut all four lanes on
     `tick`? `occ` is the lanes it is in itself then (occMask). Every other
     lane is blocked when a car in it then (one changing into or out of it
     included) overlaps this one lengthways with less than WIN to spare. */
  shuts(traffic, occ, z, type, tick) {
    const hl = S.TYPES[type].L / 2;
    for (let l = 0; l < S.LANES; l++) {
      if (occ & (1 << l)) continue;
      let blocked = false;
      for (let k = l - 1; k <= l + 1 && !blocked; k++) {
        if (k < 0 || k >= S.LANES) continue;
        for (const r of traffic.lanes[k]) {
          if (!S.occupies(r, l, tick)) continue;
          const c = S.zAt(r, tick), h = S.TYPES[r[2]].L / 2;
          if (c - h < z + hl + WIN && c + h > z - hl - WIN) { blocked = true; break; }
        }
      }
      if (!blocked) return false;
    }
    return true;
  }

  /* Is `lane` clear, from tick `from` to `until`, for a car whose centre is
     at z on `tick` and goes v m/s with half length hl? Every car in that lane
     at any moment in between (one changing into or out of it included) has
     to stay ROOM metres clear of it end to end. Both go in straight lines in
     time, so it is enough that it is clear, on the same side, at both ends. */
  roomIn(traffic, lane, z, v, hl, tick, from, until) {
    for (let k = lane - 1; k <= lane + 1; k++) {
      if (k < 0 || k >= S.LANES) continue;
      for (const r of traffic.lanes[k]) {
        const a = Math.max(from, S.occFrom(r, lane)), b = Math.min(until, S.occTo(r, lane));
        if (a > b) continue;
        const need = hl + S.TYPES[r[2]].L / 2 + ROOM;
        const da = z + v * ((a - tick) * S.DT) - S.zAt(r, a), db = z + v * ((b - tick) * S.DT) - S.zAt(r, b);
        if (!((da >= need && db >= need) || (da <= -need && db <= -need))) return false;
      }
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
        if (this.nextType[l] < 0) {
          this.nextType[l] = this.pickType(l, tick);
          this.nextTo[l] = -1;
          if (this.rand() < changeChance(tick)) {
            this.nextTo[l] = l === 0 ? 1 : l === S.LANES - 1 ? l - 1 : l + (this.rand() < 0.5 ? -1 : 1);
            this.nextF[l] = 0.3 + this.rand() * 0.45;
          }
        }
        const type = this.nextType[l];
        const v = S.LANE_V[l], hl = S.TYPES[type].L / 2;
        const z = back + this.need[l] + hl;
        if (z > horizon) break;
        /* When the front car gets to this one, if both keep going as they are. */
        const close = Math.max(4, (leadV || S.V0) - v);
        const meet = Math.max(tick + 1, tick + Math.round(((z - leadZ) / close) * S.HZ));
        /* The room must last until the rear car can arrive too: it may be up to BEHIND_LOSE behind the
           front one at the same closing speed (Fable review 2026-10-28; a fixed 6 s left a slow rear car
           meeting a changed car that had driven into the one ahead of it). */
        const after = Math.max(ROOM_AFTER, Math.round((S.BEHIND_LOSE / close) * S.HZ) + 60);
        /* Its lane change, if it means to make one and the next lane has room for it all the way. */
        let to = this.nextTo[l], ct = -1;
        if (to >= 0) {
          ct = tick + Math.max(S.SIGNAL + 30, Math.round(this.nextF[l] * (meet - tick)));
          if (!this.roomIn(traffic, to, z, v, hl, tick, ct - S.SIGNAL, Math.max(meet, ct + S.MOVE) + after)) { to = -1; ct = -1; }
        }
        if (!this.roomIn(traffic, l, z, v, hl, tick, tick, to >= 0 ? ct + S.MOVE : meet + after)
            || this.shuts(traffic, occMask(l, to, ct, tick), z, type, tick)
            || this.shuts(traffic, occMask(l, to, ct, meet), z + v * (meet - tick) * S.DT, type, meet)) {
          this.need[l] += 5 + this.rand() * 9;   // wait a few metres and try again
          continue;
        }
        const rec = [this.nextId++, l, type, r2(z), tick, Math.floor(this.rand() * COLOURS)];
        if (to >= 0) rec.push(ct, to);
        traffic.add(rec);
        if (out) out.push(rec);
        this.last[l] = rec;
        this.nextType[l] = -1;
        this.need[l] = laneGap(tick) * (0.55 + this.rand() * 0.9);
      }
    }
  }
}

module.exports = { Spawner, H_AHEAD, START_CLEAR, laneGap, COLOURS, ROOM, ROOM_AFTER, changeChance, occMask };
