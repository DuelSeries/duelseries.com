'use strict';
/* Bot against bot on one seeded map, N matches: how long a match lasts and how far they get.
   node scripts/crossyBotSim.js [matches] [solo] [sharp | skill json]: solo = each bot alone, how long it lives. */
const S = require('../shared/crossySim');
const { CrossyBot, SHARP } = require('../server/crossy/crossyBot');
const N = Number(process.argv[2]) || 50;
const SOLO = process.argv[3] === 'solo';
const SK = process.argv[4] === 'sharp' ? SHARP : process.argv[4] ? JSON.parse(process.argv[4]) : undefined;
const lens = [], rows = [], why = {};
const t0 = Date.now();
for (let g = 0; g < N; g++) {
  const w = new S.World(1000 + g * 7919);
  const hs = [S.newHopper(), S.newHopper()];
  const bots = [new CrossyBot(S.rng(g * 31 + 1), SK), new CrossyBot(S.rng(g * 31 + 2), SK)];
  let t = 0;
  if (SOLO) {
    for (; t < S.DUEL.MAX_TICKS && hs[0].alive; t++) S.step(w, hs[0], bots[0].input(w, hs[0]));
    lens.push(t / 60); rows.push(S.score(hs[0])); why[hs[0].death || 'time'] = (why[hs[0].death || 'time'] || 0) + 1;
    continue;
  }
  for (; t < S.DUEL.MAX_TICKS && hs[0].alive && hs[1].alive; t++) {
    for (let i = 0; i < 2; i++) S.step(w, hs[i], bots[i].input(w, hs[i]));
  }
  lens.push(t / 60); rows.push(Math.max(S.score(hs[0]), S.score(hs[1])));
  for (const h of hs) if (!h.alive) why[h.death] = (why[h.death] || 0) + 1;
}
lens.sort((a, b) => a - b); rows.sort((a, b) => a - b);
const q = (a, p) => a[Math.floor((a.length - 1) * p)];
console.log('matches', N, 'seconds p10/p50/p90', q(lens, 0.1).toFixed(1), q(lens, 0.5).toFixed(1), q(lens, 0.9).toFixed(1),
  'best score p50', q(rows, 0.5), 'deaths', JSON.stringify(why), 'cpu ms/match', ((Date.now() - t0) / N).toFixed(0));
