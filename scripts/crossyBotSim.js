'use strict';
/* Bot against bot on one map, N matches: how long a match lasts and how far they get.
   node scripts/crossyBotSim.js [matches] [solo] [sharp | skill json] [keyed]
   solo = each bot alone over the full 5 minutes with the ramp: how long it lives, how many reach the stop, its rows a
   minute and the time one look takes. keyed = maps made from a secret key as a match's are (CrossyRoom), not a seed. */
const crypto = require('crypto');
const S = require('../shared/crossySim');
const { CrossyBot, SHARP } = require('../server/crossy/crossyBot');
const N = Number(process.argv[2]) || 50;
const SOLO = process.argv[3] === 'solo';
const SK = process.argv[4] === 'sharp' ? SHARP : process.argv[4] && process.argv[4] !== 'keyed' ? JSON.parse(process.argv[4]) : undefined;
const KEYED = process.argv.includes('keyed');
function map(g) {
  if (!KEYED) return new S.World(1000 + g * 7919);
  const key = crypto.createHash('sha256').update('crossyBotSim' + g).digest();
  const h = (s) => crypto.createHmac('sha256', key).update(s).digest().readUInt32LE(0);
  let n = 0;
  return new S.World({ chunk: () => h('chunk:' + (n++)) / 4294967296, row: (r) => h('row:' + r) });
}
const lens = [], rows = [], perMin = [], looks = [], why = {};
const t0 = Date.now();
for (let g = 0; g < N; g++) {
  const w = map(g);
  const hs = [S.newHopper(), S.newHopper()];
  const bots = [new CrossyBot(S.rng(g * 31 + 1), SK), new CrossyBot(S.rng(g * 31 + 2), SK)];
  let t = 0;
  if (SOLO) {
    for (; t < S.DUEL.MAX_TICKS && hs[0].alive; t++) {
      const a = process.hrtime.bigint();
      const m = bots[0].input(w, hs[0]);
      looks.push(Number(process.hrtime.bigint() - a) / 1e6);
      S.step(w, hs[0], m);
    }
    lens.push(t / 60); rows.push(S.score(hs[0])); perMin.push(S.score(hs[0]) / (t / 3600));
    why[hs[0].death || 'time'] = (why[hs[0].death || 'time'] || 0) + 1;
    continue;
  }
  for (; t < S.DUEL.MAX_TICKS && hs[0].alive && hs[1].alive; t++) {
    for (let i = 0; i < 2; i++) S.step(w, hs[i], bots[i].input(w, hs[i]));
  }
  lens.push(t / 60); rows.push(Math.max(S.score(hs[0]), S.score(hs[1])));
  for (const h of hs) if (!h.alive) why[h.death] = (why[h.death] || 0) + 1;
}
const q = (a, p) => { const b = a.slice().sort((x, y) => x - y); return b[Math.floor((b.length - 1) * p)]; };
console.log('matches', N, KEYED ? 'keyed' : 'seeded', 'seconds p10/p50/p90', q(lens, 0.1).toFixed(1), q(lens, 0.5).toFixed(1), q(lens, 0.9).toFixed(1),
  'best score p50', q(rows, 0.5), 'deaths', JSON.stringify(why), 'cpu ms/match', ((Date.now() - t0) / N).toFixed(0));
if (SOLO) {
  console.log('alive at the 5-minute stop', (why.time || 0) + '/' + N, 'rows a minute p10/p50/p90', q(perMin, 0.1).toFixed(0),
    q(perMin, 0.5).toFixed(0), q(perMin, 0.9).toFixed(0), 'look ms p99/worst', q(looks, 0.99).toFixed(2), looks.reduce((a, b) => Math.max(a, b), 0).toFixed(1),
    'looks over 10 ms', looks.filter((v) => v > 10).length);
}
