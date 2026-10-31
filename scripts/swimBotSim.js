'use strict';
/* Swim tuning harness: drivers racing on the real sim and the real traffic,
   as fast as the CPU goes (no timers). Prints how long races last, how they
   end and who wins, so the density, the speed curves and the bot can be
   tuned on numbers.
     node scripts/swimBotSim.js [races=200] [seed=1] [matches=bot-bot,bot-weak] [oldRev=origin/main]
   matches: a comma list of A-B pairs, each side one of
     bot     the free-table bot (server/swim/swimBot.js, this checkout)
     old     the free-table bot as it is at git revision oldRev, to measure a change against
     strong  a strong person's stand-in (StrongDriver below): flat out, quick, smart lane changes
     ace     a skilled person's stand-in (ACE below): the bot's own driving with a person's judging errors
     weak    an average person's stand-in (WeakDriver below)
   Each pair races `races` times on seeds seed.., A taking each side half the time. It prints A's
   wins, losses and draws, how each side lost (crashed, fell 200 m behind), race seconds, each
   side's average speed and the CPU each driver took a tick. `both` is the old default. */
const S = require('../shared/swimSim');
const { Spawner } = require('../server/swim/swimTraffic');
const { SwimBot } = require('../server/swim/swimBot');

/* The bot as it is at a git revision, compiled against this checkout's sim (its only require). */
function botAt(rev) {
  const src = require('child_process').execSync('git show ' + rev + ':server/swim/swimBot.js', { cwd: __dirname, encoding: 'utf8' });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', src)((id) => (/swimSim$/.test(id) ? S : require(id)), mod, mod.exports);
  return mod.exports.SwimBot;
}

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


/* A STRONG PERSON'S STAND-IN: quick (a look every 150 to 200 ms), a good eye (the time to each car
   read within 5%, 10% late on), the gas held flat unless boxed in, and the lane picked for the most
   road ahead that it can get across to, two lanes over included. It never eases off to a cruise and
   aims at no close passes. */
class StrongDriver extends WeakDriver {
  constructor(rand) {
    super(rand);
    this.react = 9 + Math.floor(rand() * 4);
    this.error = 0.05;
  }
  look(car, traffic, tick) {
    const late = (tick * S.DT) / (tick * S.DT + 150);
    const noise = this.error * (1 + late);
    const here = this.nearestLane(car.x);
    if (this.lane < 0) this.lane = here;
    const tt = [];
    for (let l = 0; l < S.LANES; l++) tt.push(this.timeIn(traffic, l, car, tick, noise));
    const reach = (l) => {
      const dir = l > here ? 1 : -1;
      for (let k = here; k !== l + dir; k += dir) {
        if (k === here) continue;
        const cross = (Math.abs(S.laneX(k) - car.x) + (k === l ? 0 : 1.8)) / Math.max(1, S.vxMax(car.v)) + 0.15;
        if (tt[k] < 0 || tt[k] < cross + 0.25) return false;
      }
      return true;
    };
    let pick = this.lane, best = -Infinity;
    for (let l = 0; l < S.LANES; l++) {
      if (l !== here && !reach(l)) continue;
      const t = tt[l] < 0 ? -1 : Math.min(tt[l], 5);
      const score = t - 0.25 * Math.abs(l - here) + (l === this.lane ? 0.3 : 0);
      if (score > best) { best = score; pick = l; }
    }
    if (pick !== this.lane) this.offset = (this.rand() * 2 - 1) * 0.15;
    this.lane = pick;
    /* The brake only when the lane it is in or heading for comes up sooner than it can shed the speed
       (BRAKE) plus a moment to react; otherwise flat out. */
    const ahead = tt[pick] < 0 ? 0 : tt[pick], cur = tt[here] < 0 ? 0 : tt[here];
    const need = (lane) => {
      const first = traffic.aheadIn(lane, car.z, tick);
      const dv = first ? car.v - S.LANE_V[first[1]] : 0;
      return dv > 0 ? dv / (2 * S.BRAKE) + 0.3 : 0;
    };
    const rear = this.behindIn(traffic, here, car, tick);
    if (rear < 1.6 && cur > 0.5) this.pedal = 1;
    else if (ahead < need(pick) || (pick !== here && cur < need(here) && cur < 0.9)) this.pedal = -1;
    else this.pedal = 1;
  }
}

/* One race; drivers[i] drives side i. How it ended, which side won (-1: nobody), each car's distance
   and the CPU (ns) each driver took. */
function race(seed, maxTicks, make) {
  const rand = S.rng(seed * 7919 + 13);
  const traffic = new S.Traffic();
  const spawner = new Spawner(seed);
  const cars = [S.newCar(0), S.newCar(1)];
  const drivers = [make(0, rand), make(1, rand)];
  const cpu = [0, 0];
  let boosts = 0;
  const end = (t, why, win) => ({ ticks: t + 1, why, win, dead: cars.map(c => !c.alive), z: cars.map(c => c.z), boosts, cpu });
  spawner.run(traffic, 0, 0, S.V0, null);
  for (let t = 0; t < maxTicks; t++) {
    const lead = cars[0].z > cars[1].z ? cars[0] : cars[1];
    spawner.run(traffic, t, lead.z, lead.v, null);
    const codes = cars.map((c, i) => {
      const t0 = process.hrtime.bigint();
      const code = drivers[i].input(c, traffic, t, cars[1 - i]);
      cpu[i] += Number(process.hrtime.bigint() - t0);
      return code;
    });
    cars.forEach((c, i) => { S.step(c, codes[i], traffic); if (c.close >= 0) boosts++; });
    const dead = cars.map(c => !c.alive);
    if (dead[0] || dead[1]) return end(t, dead[0] && dead[1] ? 'both' : 'crash', dead[0] && dead[1] ? -1 : dead[0] ? 1 : 0);
    if (Math.abs(cars[0].z - cars[1].z) >= S.BEHIND_LOSE) return end(t, 'behind', cars[0].z > cars[1].z ? 0 : 1);
    traffic.prune(Math.min(cars[0].z, cars[1].z) - 120, t + 1);
  }
  return end(maxTicks - 1, 'cap', -1);
}

/* A SKILLED PERSON'S STAND-IN (ace): the bot's own way of driving, with a person's judging: the time to a car
   out by 3% rising to 9%, its place across the road by 5 cm rising to half a metre, and a look away now and
   then (the bot's numbers before 2026-10-30). */
const ACE = { sigma0: 0.03, sigma1: 0.06, side0: 0.05, side1: 0.45, lapse: 0.015 };

const MAKE = {
  bot: () => (side, rand) => new SwimBot(rand),
  old: (rev) => { const Old = botAt(rev); return (side, rand) => new Old(rand); },
  strong: () => (side, rand) => new StrongDriver(rand),
  ace: () => (side, rand) => new SwimBot(rand, ACE),
  weak: () => (side, rand) => new WeakDriver(rand),
};

/* A against B, n races, A on side i % 2. */
function matchup(a, b, n, seed0, rev) {
  const ma = MAKE[a](rev), mb = MAKE[b](rev);
  const t0 = Date.now();
  let win = 0, lose = 0, draw = 0, ticks = 0, cpuA = 0, cpuB = 0, distA = 0, distB = 0, boosts = 0;
  const ends = { aCrash: 0, bCrash: 0, aBehind: 0, bBehind: 0, both: 0, cap: 0 };
  const secs = [];
  for (let i = 0; i < n; i++) {
    const sa = i % 2;
    const r = race(seed0 + i, CAP, (side, rand) => (side === sa ? ma(side, rand) : mb(side, rand)));
    secs.push(r.ticks / 60); ticks += r.ticks; boosts += r.boosts;
    cpuA += r.cpu[sa]; cpuB += r.cpu[1 - sa];
    distA += r.z[sa]; distB += r.z[1 - sa];
    if (r.win === sa) win++; else if (r.win < 0) draw++; else lose++;
    if (r.why === 'crash') { if (r.dead[sa]) ends.aCrash++; else ends.bCrash++; }
    else if (r.why === 'behind') { if (r.win === sa) ends.bBehind++; else ends.aBehind++; }
    else ends[r.why]++;
  }
  secs.sort((x, y) => x - y);
  const q = (p) => secs[Math.min(n - 1, Math.floor(p * n))].toFixed(1);
  const kmh = (d) => (d / ticks * 60 * 3.6).toFixed(0);
  console.log(`${a} v ${b}: ${a} wins ${win}/${n} (${(100 * win / n).toFixed(0)}%), loses ${lose}, draws ${draw} | ` +
    `${a} crashed ${ends.aCrash}, fell behind ${ends.aBehind}; ${b} crashed ${ends.bCrash}, fell behind ${ends.bBehind}` +
    (ends.both ? `; both crashed ${ends.both}` : '') + (ends.cap ? `; hit the cap ${ends.cap}` : ''));
  console.log(`  race s p10 ${q(0.1)} median ${q(0.5)} p90 ${q(0.9)}, under 10 s ${secs.filter(x => x < 10).length} | avg km/h ${a} ${kmh(distA)} ${b} ${kmh(distB)} | ` +
    `close passes/race ${(boosts / n).toFixed(1)} | us/tick ${a} ${(cpuA / ticks / 1000).toFixed(0)} ${b} ${(cpuB / ticks / 1000).toFixed(0)} | ${Date.now() - t0} ms`);
}

const N = Number(process.argv[2]) || 200;
const seed0 = Number(process.argv[3]) || 1;
let matches = process.argv[4] || 'both';
if (matches === 'both') matches = 'bot-bot,bot-weak';
else if (matches === 'weak') matches = 'bot-weak';
else if (!matches.includes('-')) matches = matches + '-' + matches;
const rev = process.argv[5] || 'origin/main';
const CAP = 60 * 60 * 20;
for (const m of matches.split(',')) {
  const [a, b] = m.split('-');
  if (!MAKE[a] || !MAKE[b]) { console.log('unknown match ' + m); continue; }
  matchup(a, b, N, seed0, rev);
}
