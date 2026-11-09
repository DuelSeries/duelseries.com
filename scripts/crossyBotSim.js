'use strict';
/* Crossy Road bots, N matches.
   node scripts/crossyBotSim.js [matches] [mode] [limit] [skill]
   mode duel (default): bot against bot through the real room (server/crossy/CrossyRoom.js: its judge, its row history,
     the bot told its rival's row), on maps made from a secret key as a match's are. Says how matches end, which seat
     wins (fair: about half each), how long they last, and the widest gap each saw.
   mode idle: the bot against a seat that never moves: how long standing still lasts (the feel of BEHIND_LOSE).
   mode fast: a faster player (the bot with a short pace, or the skill given) against the free-table bot, which speeds
     up when it falls behind: the faster one should mostly win by the gap, not every time.
   mode solo: the bot alone over the full 5 minutes with the ramp: how long it lives, its rows a minute, look cost.
   limit: BEHIND_LOSE to try (default the sim's). skill: a JSON skill (solo, duel: both bots; fast: the fast one). */
const S = require('../shared/crossySim');
const { CrossyRoom } = require('../server/crossy/CrossyRoom');
const { CrossyBot } = require('../server/crossy/crossyBot');
const N = Number(process.argv[2]) || 40;
const MODE = process.argv[3] || 'duel';
if (Number(process.argv[4]) > 0) S.DUEL.BEHIND_LOSE = Number(process.argv[4]);
const SKA = process.argv[5];
const SK = SKA ? JSON.parse(SKA) : undefined;

const q = (a, p) => { if (!a.length) return NaN; const b = a.slice().sort((x, y) => x - y); return b[Math.floor((b.length - 1) * p)]; };
const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : '-');
const t0 = Date.now();

if (MODE === 'solo') {
  const lens = [], perMin = [], looks = [], why = {};
  for (let g = 0; g < N; g++) {
    const w = new S.World(1000 + g * 7919), h = S.newHopper(), bot = new CrossyBot(S.rng(g * 31 + 1), SK);
    let t = 0;
    for (; t < S.DUEL.MAX_TICKS && h.alive; t++) {
      const a = process.hrtime.bigint();
      const m = bot.input(w, h);
      looks.push(Number(process.hrtime.bigint() - a) / 1e6);
      S.step(w, h, m);
    }
    lens.push(t / 60); perMin.push(S.score(h) / (t / 3600));
    why[h.death || 'time'] = (why[h.death || 'time'] || 0) + 1;
  }
  console.log('solo', N, 'lives s p10/p50/p90', f1(q(lens, 0.1)), f1(q(lens, 0.5)), f1(q(lens, 0.9)), 'ends', JSON.stringify(why),
    'rows a minute p10/p50/p90', q(perMin, 0.1).toFixed(0), q(perMin, 0.5).toFixed(0), q(perMin, 0.9).toFixed(0),
    'look ms p99/worst', q(looks, 0.99).toFixed(2), looks.reduce((a, b) => Math.max(a, b), 0).toFixed(1));
  process.exit(0);
}

const fakeIo = () => { const r = () => ({ emit() {}, volatile: { emit() {} } }); return { to: r }; };
const sock = (id) => ({ id, emit() {}, join() {}, leave() {} });
const lens = [], gaps = [], why = {}, wins = [0, 0, 0], winGap = [];
for (let g = 0; g < N; g++) {
  const room = new CrossyRoom(fakeIo());
  const ids = MODE === 'idle' ? ['bot_a', 'idle'] : ['bot_a', 'bot_b'];
  room.addPlayer(sock(ids[0]), 'A', 'WA', 0, 0);
  room.addPlayer(sock(ids[1]), 'B', 'WB', 0, 0);
  room.stake = 0;
  const pa = room.players.get(ids[0]), pb = room.players.get(ids[1]);
  /* Seeded bots, so a run can be repeated, the seeds swapped between the seats every other match (so a seat is never
     the luckier stream); in fast mode the fast one sits in seat 0, or 1 every other match. */
  const FAST = SK || { pace: [12, 24] };
  const sa = g * 31 + 1 + (g % 2), sb = g * 31 + 2 - (g % 2);
  pa.cr.bot = new CrossyBot(S.rng(sa), MODE === 'fast' ? (g % 2 ? undefined : FAST) : SK);
  if (pb.cr.bot) pb.cr.bot = new CrossyBot(S.rng(sb), MODE === 'fast' ? (g % 2 ? FAST : undefined) : SK);
  let over = null;
  room.onSettled = (r) => { over = r; };
  room.start(0);
  let most = 0;
  for (let t = 0; t <= S.DUEL.MAX_TICKS + 5 && room.state !== 'over'; t++) {
    if (MODE === 'idle') room.input('idle', { t: Math.max(0, t - 1) });
    room.tick(room.goAt + t * S.TICK_MS + 0.5);
    most = Math.max(most, Math.abs(pa.cr.h.r - pb.cr.h.r));
  }
  lens.push(room.endTick / 60);
  gaps.push(most);
  const w = room.winner === ids[0] ? 0 : room.winner === ids[1] ? 1 : 2;
  const fast = MODE === 'fast' ? (g % 2 ? 1 : 0) : -1;
  wins[MODE === 'fast' ? (w === 2 ? 2 : w === fast ? 0 : 1) : w]++;
  why[room.overWhy] = (why[room.overWhy] || 0) + 1;
}
const who = MODE === 'fast' ? ['fast', 'free bot', 'draw'] : MODE === 'idle' ? ['bot', 'idle', 'draw'] : ['seat 0', 'seat 1', 'draw'];
console.log(MODE, N, 'limit', S.DUEL.BEHIND_LOSE, 'rows | ends', JSON.stringify(why), '| wins', who.map((n, i) => n + ' ' + wins[i]).join(', '),
  '| match s p10/p50/p90', f1(q(lens, 0.1)), f1(q(lens, 0.5)), f1(q(lens, 0.9)),
  '| widest gap p50/p90', q(gaps, 0.5), q(gaps, 0.9), '| cpu ms/match', ((Date.now() - t0) / N).toFixed(0));
