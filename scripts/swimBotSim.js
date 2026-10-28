'use strict';
/* Swim tuning harness: drivers racing on the real sim and the real traffic,
   as fast as the CPU goes (no timers). Prints how long races last and how they
   end, so the density, the speed curves and the bot can be tuned on numbers.
     node scripts/swimBotSim.js [races=200] [seed=1] [match=both]
   match: bot (the free-table bot against itself), weak (the bot against an
   average person's stand-in, below), or both. */
const S = require('../shared/swimSim');
const { Spawner } = require('../server/swim/swimTraffic');
const { SwimBot } = require('../server/swim/swimBot');

/* AN AVERAGE PERSON'S STAND-IN: the free-table bot as it was before
   2026-10-28 (Owen beat it inside 10 s). One look down each lane at the first
   car every 150 to 230 ms, a read of the time to it that is up to 16% out
   (more late on), no plan past the next car, no close passes. Its "leave the
   pedal" now means holding a cruise by feathering the gas, as a person does. */
class WeakDriver {
  constructor(rand) {
    this.rand = rand;
    this.react = 9 + Math.floor(rand() * 5);
    this.error = 0.16;
    this.nextLook = 0; this.lane = -1; this.pedal = 0; this.offset = 0;
  }
  nearestLane(x) {
    let best = 0, bd = Infinity;
    for (let l = 0; l < S.LANES; l++) { const d = Math.abs(x - S.laneX(l)); if (d < bd) { bd = d; best = l; } }
    return best;
  }
  timeIn(traffic, lane, car, tick, noise) {
    let best = 99;
    for (let k = lane - 1; k <= lane + 1; k++) {
      if (k < 0 || k >= S.LANES) continue;
      const list = traffic.lanes[k];
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        if (!S.occupies(r, lane, tick)) continue;
        const t = S.TYPES[r[2]], rv = S.LANE_V[r[1]];
        const c = S.zAt(r, tick);
        const back = c - t.hl, front = c + t.hl;
        if (front < car.z - S.CAR.HL - 1.5) {
          const gain = rv - car.v;
          if (gain > 0.5 && (car.z - S.CAR.HL - front) / gain < 1.3) return -1;
          continue;
        }
        if (back < car.z + S.CAR.HL + 1.5) return -1;
        const close = car.v - rv;
        if (close > 0.5) { const tt = (back - car.z - S.CAR.HL) / close; if (tt < best) best = tt; }
        break;
      }
    }
    return best >= 99 ? 99 : best * (1 + noise * (this.rand() * 2 - 1));
  }
  behindIn(traffic, lane, car, tick) {
    let best = 99;
    for (let k = lane - 1; k <= lane + 1; k++) {
      if (k < 0 || k >= S.LANES) continue;
      const list = traffic.lanes[k];
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        const front = S.zAt(r, tick) + S.TYPES[r[2]].hl;
        if (front > car.z - S.CAR.HL) break;
        if (!S.occupies(r, lane, tick)) continue;
        const gain = S.LANE_V[r[1]] - car.v;
        if (gain > 0.5) { const t = (car.z - S.CAR.HL - front) / gain; if (t < best) best = t; }
      }
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
    const reach = (l) => {
      const dir = l > here ? 1 : -1;
      for (let k = here; k !== l + dir; k += dir) {
        if (k === here) continue;
        const cross = (Math.abs(S.laneX(k) - car.x) + (k === l ? 0 : 1.8)) / Math.max(1, S.vxMax(car.v)) + 0.2;
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
    const cur = tt[here];
    if (here === this.lane && cur > 2.4 && this.rand() > 0.04) pick = here;
    if (pick !== this.lane) this.offset = (this.rand() * 2 - 1) * 0.25;
    this.lane = pick;
    const ahead = tt[pick] < 0 ? 0 : tt[pick];
    const gap = opp ? car.z - opp.z : 0;
    const rear = this.behindIn(traffic, here, car, tick);
    if (rear < 1.6 && !(tt[here] >= 0 && tt[here] < 0.9)) this.pedal = 1;
    else if (ahead < 1.15 || (tt[here] >= 0 && tt[here] < 0.75)) this.pedal = -1;
    else if (ahead > 2.6 && (gap < 25 || this.rand() < 0.55)) this.pedal = 1;
    else if (gap > 90) this.pedal = 0;
    else this.pedal = ahead > 1.8 ? 1 : 0;
  }
  input(car, traffic, tick, opp) {
    if (!car.alive) return S.NEUTRAL;
    if (tick >= this.nextLook) { this.look(car, traffic, tick, opp); this.nextLook = tick + this.react; }
    const e = S.laneX(this.lane) + this.offset - car.x;
    const reach = S.vxMax(car.v);
    const want = Math.sign(e) * Math.min(reach, Math.sqrt(2 * 0.85 * S.vxAcc(car.v) * Math.abs(e)));
    const steer = reach > 0 ? Math.max(-1, Math.min(1, (want - car.vx * 0.25) / reach)) : 0;
    const pedal = this.pedal !== 0 ? this.pedal : car.v < S.cruise(tick) ? 1 : 0;
    return S.packInput(Math.abs(e) < 0.04 && Math.abs(car.vx) < 0.3 ? 0 : steer, pedal);
  }
}

/* One race; drivers[i] drives side i. Returns how it ended and which side won (-1: nobody). */
function race(seed, maxTicks, make) {
  const rand = S.rng(seed * 7919 + 13);
  const traffic = new S.Traffic();
  const spawner = new Spawner(seed);
  const cars = [S.newCar(0), S.newCar(1)];
  const drivers = [make(0, rand), make(1, rand)];
  spawner.run(traffic, 0, 0, S.V0, null);
  let boosts = 0;
  for (let t = 0; t < maxTicks; t++) {
    const lead = cars[0].z > cars[1].z ? cars[0] : cars[1];
    spawner.run(traffic, t, lead.z, lead.v, null);
    const codes = cars.map((c, i) => drivers[i].input(c, traffic, t, cars[1 - i]));
    cars.forEach((c, i) => { S.step(c, codes[i], traffic); if (c.close >= 0) boosts++; });
    const dead = cars.map(c => !c.alive);
    if (dead[0] || dead[1]) return { ticks: t + 1, why: dead[0] && dead[1] ? 'both' : 'crash', win: dead[0] && dead[1] ? -1 : dead[0] ? 1 : 0, v: lead.v, boosts };
    if (Math.abs(cars[0].z - cars[1].z) >= S.BEHIND_LOSE) return { ticks: t + 1, why: 'behind', win: cars[0].z > cars[1].z ? 0 : 1, v: lead.v, boosts };
    traffic.prune(Math.min(cars[0].z, cars[1].z) - 120, t + 1);
  }
  return { ticks: maxTicks, why: 'cap', win: -1, v: 0, boosts };
}

function report(label, out, ms) {
  const N = out.length;
  const secs = out.map(r => r.ticks / 60).sort((a, b) => a - b);
  const q = (p) => secs[Math.min(secs.length - 1, Math.floor(p * secs.length))].toFixed(1);
  const by = {};
  for (const r of out) by[r.why] = (by[r.why] || 0) + 1;
  console.log(`${label}: races ${N} in ${ms} ms; seconds p10 ${q(0.1)} p25 ${q(0.25)} median ${q(0.5)} p75 ${q(0.75)} p90 ${q(0.9)} max ${q(0.999)}; under 10 s ${secs.filter(s => s < 10).length}`);
  console.log('  endings', JSON.stringify(by), 'mean end speed km/h', (out.reduce((a, r) => a + r.v, 0) / N * 3.6).toFixed(0),
    'close passes per race', (out.reduce((a, r) => a + r.boosts, 0) / N).toFixed(1));
}

const N = Number(process.argv[2]) || 200;
const seed0 = Number(process.argv[3]) || 1;
const match = process.argv[4] || 'both';
const CAP = 60 * 60 * 20;
if (match === 'bot' || match === 'both') {
  const t0 = Date.now(), out = [];
  for (let i = 0; i < N; i++) out.push(race(seed0 + i, CAP, (side, rand) => new SwimBot(rand)));
  report('bot v bot', out, Date.now() - t0);
}
if (match === 'weak' || match === 'both') {
  const t0 = Date.now(), out = [];
  let wins = 0, losses = 0, draws = 0, weakCrash = 0, botCrash = 0;
  for (let i = 0; i < N; i++) {
    const botSide = i % 2;                          // the bot takes each side half the time
    const r = race(seed0 + i, CAP, (side, rand) => side === botSide ? new SwimBot(rand) : new WeakDriver(rand));
    out.push(r);
    if (r.win === botSide) wins++; else if (r.win < 0) draws++; else losses++;
    if (r.why === 'crash') { if (r.win === botSide) weakCrash++; else botCrash++; }
  }
  report('bot v average', out, Date.now() - t0);
  console.log(`  bot wins ${wins} (${(100 * wins / N).toFixed(0)}%), loses ${losses}, draws ${draws}; the average driver crashed ${weakCrash}, the bot crashed ${botCrash}`);
}
