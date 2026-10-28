'use strict';
/* ─── Swim: the stand-in driver for a free table ──────────────────────────────
   A free seat alone for a minute races this (server/swim/SwimLobby.js, the
   same rule as Knockout's). It drives the same car through the same physics
   (shared/swimSim.js step) with the same kind of input a phone sends: a wheel
   and a pedal per tick. It never moves the car any other way.

   HOW IT DRIVES. Every few ticks (its reaction time) it looks down each lane
   for the first car ahead and works out how long until it would reach it at
   the speed it is closing. It keeps to its lane while that is comfortable,
   otherwise moves to the lane with the most time in it that it can reach
   without cutting across a car beside it, and brakes when nothing ahead
   gives it enough time. Between looks it steers smoothly to the middle of the
   lane it picked.

   HOW IT LOSES. It reads the time to each car with an error that grows as the
   road gets faster, and only looks again after its reaction time, so in the
   late game it starts misjudging gaps and reacting late, the same way a
   person does. It pushes on when it is behind and eases off when it is well
   ahead, so it races rather than cruises. */

const S = require('../../shared/swimSim');

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

class SwimBot {
  constructor(rand, opts) {
    const o = opts || {};
    this.rand = rand || Math.random;
    this.react = o.react || (9 + Math.floor(this.rand() * 5));   // ticks between looks: 150 to 230 ms
    this.error = o.error != null ? o.error : 0.16;                  // how wrong a read can be, at the start
    this.nextLook = 0;
    this.lane = -1;
    this.pedal = 0;
    this.offset = 0;
  }

  nearestLane(x) {
    let best = 0, bd = Infinity;
    for (let l = 0; l < S.LANES; l++) {
      const d = Math.abs(x - S.laneX(l));
      if (d < bd) { bd = d; best = l; }
    }
    return best;
  }

  /* Seconds until the car reaches the first traffic car in `lane`, read with an
     error; -1 when one is alongside right now; 99 when the lane is open. */
  timeIn(traffic, lane, car, tick, noise) {
    const list = traffic.lanes[lane];
    for (let i = 0; i < list.length; i++) {
      const r = list[i], t = S.TYPES[r[2]];
      const c = S.zAt(r, tick);
      const back = c - t.hl, front = c + t.hl;
      if (front < car.z - S.CAR.HL - 1.5) {
        /* Behind us, and coming up because we are slower than its lane: too close to pull in front of. */
        const gain = S.LANE_V[lane] - car.v;
        if (gain > 0.5 && (car.z - S.CAR.HL - front) / gain < 1.3) return -1;
        continue;
      }
      if (back < car.z + S.CAR.HL + 1.5) return -1;              // alongside
      const close = car.v - S.LANE_V[lane];
      if (close <= 0.5) return 99;
      const tt = (back - car.z - S.CAR.HL) / close;
      return tt * (1 + noise * (this.rand() * 2 - 1));
    }
    return 99;
  }

  /* Seconds until the nearest car behind us in `lane` touches our back (99 when nothing is gaining on us). */
  behindIn(traffic, lane, car, tick) {
    const gain = S.LANE_V[lane] - car.v;
    if (gain <= 0.5) return 99;
    const list = traffic.lanes[lane];
    let best = 99;
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      const front = S.zAt(r, tick) + S.TYPES[r[2]].hl;
      if (front > car.z - S.CAR.HL) break;
      best = (car.z - S.CAR.HL - front) / gain;
    }
    return best;
  }

  look(car, traffic, tick, opp) {
    const late = (tick * S.DT) / (tick * S.DT + 150);
    const noise = this.error * (1 + 2.2 * late);
    const here = this.nearestLane(car.x);
    if (this.lane < 0) this.lane = here;
    const tt = [];
    for (let l = 0; l < S.LANES; l++) tt.push(this.timeIn(traffic, l, car, tick, noise));

    /* A lane is reachable if every lane on the way, and the lane itself, has
       nobody alongside and enough time to get across before its car arrives. */
    const reach = (l) => {
      const dir = l > here ? 1 : -1;
      for (let k = here; k !== l + dir; k += dir) {
        if (k === here) continue;
        /* Until the car is all the way out the far side of that lane, not just at its middle. */
        const cross = (Math.abs(S.laneX(k) - car.x) + (k === l ? 0 : 1.8)) / S.vxMax(car.v) + 0.2;
        if (tt[k] < 0 || tt[k] < cross + 0.45) return false;
      }
      return true;
    };

    let pick = this.lane, best = -Infinity;
    for (let l = 0; l < S.LANES; l++) {
      if (l !== here && !reach(l)) continue;
      const t = tt[l] < 0 ? -1 : Math.min(tt[l], 6);
      const score = t - 0.35 * Math.abs(l - here) + (l === this.lane ? 0.4 : 0);
      if (score > best) { best = score; pick = l; }
    }
    /* Stay put while the lane we are in is comfortable. */
    const cur = tt[here];
    if (here === this.lane && cur > 2.4 && this.rand() > 0.04) pick = here;
    if (pick !== this.lane) this.offset = (this.rand() * 2 - 1) * 0.25;
    this.lane = pick;

    const ahead = tt[pick] < 0 ? 0 : tt[pick];
    const gap = opp ? car.z - opp.z : 0;
    /* Something coming up from behind in our own lane (we braked below it): get going again. */
    const rear = this.behindIn(traffic, here, car, tick);
    if (rear < 1.6 && !(tt[here] >= 0 && tt[here] < 0.9)) this.pedal = 1;
    else if (ahead < 1.15 || (tt[here] >= 0 && tt[here] < 0.75)) this.pedal = -1;
    else if (ahead > 2.6 && (gap < 25 || this.rand() < 0.55)) this.pedal = 1;
    else if (gap > 90) this.pedal = 0;
    else this.pedal = ahead > 1.8 ? 1 : 0;
  }

  /* The packed input for this tick (shared/swimSim.js packInput). */
  input(car, traffic, tick, opp) {
    if (!car.alive) return S.NEUTRAL;
    if (tick >= this.nextLook) {
      this.look(car, traffic, tick, opp);
      this.nextLook = tick + this.react;
    }
    /* Steer to the lane's middle with a speed that can still stop on it (the wheel is heavier the faster it goes). */
    const e = S.laneX(this.lane) + this.offset - car.x;
    const reach = S.vxMax(car.v);
    const want = Math.sign(e) * Math.min(reach, Math.sqrt(2 * 0.85 * S.vxAcc(car.v) * Math.abs(e)));
    const steer = clamp((want - car.vx * 0.25) / reach, -1, 1);
    return S.packInput(Math.abs(e) < 0.04 && Math.abs(car.vx) < 0.3 ? 0 : steer, this.pedal);
  }
}

module.exports = { SwimBot };
