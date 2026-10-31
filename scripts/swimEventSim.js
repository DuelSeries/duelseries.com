'use strict';
/* Swim Race event, headless, in-process: N bots on an N-lane road, the real room (server/swim/SwimEvent.js) on a
   fake clock, ticked as fast as it goes. Reports how the race went and what a tick costs.
     node scripts/swimEventSim.js [cars=8] [races=3] [--real]
   --real ticks on the wall clock at 60 Hz (the server's own pace) instead, so the time per tick is what the box
   would see with nothing else running. */
const { SwimEvent } = require('../server/swim/SwimEvent');
const S = require('../shared/swimSim');

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const N = Number(args[0]) || 8, RACES = Number(args[1]) || 3, REAL = process.argv.includes('--real');

function fakeIo() {
  let bytes = 0, msgs = 0;
  const count = (ev, p) => { msgs++; try { bytes += JSON.stringify(p).length; } catch (_) {} };
  const room = { emit: count, volatile: { emit: count } };
  return { to: () => room, stats: () => ({ bytes, msgs }), reset() { bytes = 0; msgs = 0; } };
}

async function race(k) {
  let t = 1e6;
  const io = fakeIo();
  const ev = new SwimEvent(io, { now: () => t, manual: true });
  ev.doorOpen = true;
  const why = ev.start('sim', N);
  if (why) throw new Error(why);
  const ticks = [];
  const t0 = process.hrtime.bigint();
  let lastWall = Date.now();
  io.reset();
  while (ev.state !== 'over') {
    if (REAL) {
      await new Promise(r => setTimeout(r, Math.max(0, S.TICK_MS - (Date.now() - lastWall))));
      lastWall = Date.now();
    }
    t += S.TICK_MS;
    const a = process.hrtime.bigint();
    ev.tick(t);
    ticks.push(Number(process.hrtime.bigint() - a) / 1e6);
    if (ev.clock > 12 * 60 * 60) break;
  }
  const wall = Number(process.hrtime.bigint() - t0) / 1e9;
  ticks.sort((a, b) => a - b);
  const q = (p) => ticks[Math.min(ticks.length - 1, Math.floor(p * ticks.length))];
  const avg = ticks.reduce((a, b) => a + b, 0) / ticks.length;
  const m = ev.overMsg || {};
  const secs = (m.tick || ev.clock) / S.HZ;
  const st = io.stats();
  const mem = process.memoryUsage();
  console.log(`race ${k + 1}: ${N} cars, ${ev.lanes} lanes, ${m.why} after ${secs.toFixed(0)} s, winner ${m.winner ? m.winner.name : '-'}` +
    `, out ${ev.out}; tick avg ${avg.toFixed(3)} ms p50 ${q(0.5).toFixed(3)} p99 ${q(0.99).toFixed(3)} max ${q(1).toFixed(2)}` +
    `; traffic now ${ev.traffic.size}; sent ${(st.bytes / secs / 1024).toFixed(1)} kB/s in ${(st.msgs / secs).toFixed(0)} msgs/s` +
    ` (one copy); heap ${(mem.heapUsed / 1048576).toFixed(1)} MB rss ${(mem.rss / 1048576).toFixed(0)} MB; wall ${wall.toFixed(1)} s`);
  return { secs, avg, why: m.why };
}

(async () => {
  for (let k = 0; k < RACES; k++) await race(k);
})();
