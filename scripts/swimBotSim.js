'use strict';
/* Swim tuning harness: bot against bot on the real sim and the real traffic,
   as fast as the CPU goes (no timers). Prints how long races last and how they
   end, so the density and speed curves can be tuned against numbers.
     node scripts/swimBotSim.js [races=200] [seed=1] */
const S = require('../shared/swimSim');
const { Spawner } = require('../server/swim/swimTraffic');
const { SwimBot } = require('../server/swim/swimBot');

function race(seed, maxTicks) {
  const rand = S.rng(seed * 7919 + 13);
  const traffic = new S.Traffic();
  const spawner = new Spawner(seed);
  const cars = [S.newCar(0), S.newCar(1)];
  const bots = [new SwimBot(rand), new SwimBot(rand)];
  spawner.run(traffic, 0, 0, S.V0, null);
  let spawned = 0;
  for (let t = 0; t < maxTicks; t++) {
    const lead = cars[0].z > cars[1].z ? cars[0] : cars[1];
    const before = spawner.nextId;
    spawner.run(traffic, t, lead.z, lead.v, null);
    spawned += spawner.nextId - before;
    const codes = cars.map((c, i) => bots[i].input(c, traffic, t, cars[1 - i]));
    cars.forEach((c, i) => S.step(c, codes[i], traffic));
    const dead = cars.map(c => !c.alive);
    if (dead[0] || dead[1]) return { ticks: t + 1, why: dead[0] && dead[1] ? 'both' : 'crash', z: lead.z, v: lead.v, spawned };
    if (Math.abs(cars[0].z - cars[1].z) >= S.BEHIND_LOSE) return { ticks: t + 1, why: 'behind', z: lead.z, v: lead.v, spawned };
    traffic.prune(Math.min(cars[0].z, cars[1].z) - 120, t + 1);
  }
  return { ticks: maxTicks, why: 'cap', z: 0, v: 0, spawned };
}

const N = Number(process.argv[2]) || 200;
const seed0 = Number(process.argv[3]) || 1;
const out = [];
const t0 = Date.now();
for (let i = 0; i < N; i++) out.push(race(seed0 + i, 60 * 60 * 20));
const secs = out.map(r => r.ticks / 60).sort((a, b) => a - b);
const q = (p) => secs[Math.min(secs.length - 1, Math.floor(p * secs.length))].toFixed(1);
const by = {};
for (const r of out) by[r.why] = (by[r.why] || 0) + 1;
console.log(`races ${N} in ${Date.now() - t0} ms; seconds p10 ${q(0.1)} p25 ${q(0.25)} median ${q(0.5)} p75 ${q(0.75)} p90 ${q(0.9)} max ${q(0.999)}`);
console.log('endings', JSON.stringify(by), 'mean top speed km/h', (out.reduce((a, r) => a + r.v, 0) / N * 3.6).toFixed(0));
