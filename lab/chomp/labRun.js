// Headless balance runs for the lab modes (all bots, no browser): node lab/chomp/labRun.js royale|duel|arena [matches]
// Prints how long rounds and matches last and how they end, so the numbers on Owen's concept page are measured.
'use strict';
var mode = process.argv[2] || 'royale', N = +(process.argv[3] || 10);

function pct(a, q) { var s = a.slice().sort(function (x, y) { return x - y; }); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0; }

if (mode === 'royale') {
  var Royale = require('./royaleSim');
  var rounds = [], matches = [], ends = { last: 0, time: 0, draw: 0 }, kos = { ghost: 0, player: 0, revenge: 0 }, bumps = 0;
  for (var m = 0; m < N; m++) {
    var S = Royale.create({ human: false, seed: 1000 + m, players: +(process.env.PLAYERS || 4) });
    var start = 0, t0 = 0;
    for (var t = 0; t < 60 * 60 * 15 && S.phase !== 'match'; t++) {
      Royale.step(S, null);
      S.events.forEach(function (e) {
        if (e.t === 'go') start = S.tick;
        if (e.t === 'round') { rounds.push((S.tick - start) / 60); if (!e.winner) ends.draw++; else if (e.timeUp) ends.time++; else ends.last++; }
        if (e.t === 'out') { if (e.by == null) kos.ghost++; }
        if (e.t === 'eat') kos.player++;
        if (e.t === 'revenge') kos.revenge++;
        if (e.t === 'bump') bumps++;
      });
      S.events.length = 0;
    }
    matches.push({ s: (S.tick - t0) / 60, rounds: S.round, winner: S.winner && S.winner.name });
  }
  console.log(JSON.stringify({
    mode: 'royale', matches: N, roundS: { p25: pct(rounds, 0.25), median: pct(rounds, 0.5), p90: pct(rounds, 0.9) },
    matchS: { median: pct(matches.map(function (x) { return x.s; }), 0.5) }, roundsPerMatch: pct(matches.map(function (x) { return x.rounds; }), 0.5),
    ends: ends, knockouts: kos, bumpsPerRound: +(bumps / rounds.length).toFixed(1),
    winners: matches.map(function (x) { return x.winner; }).join(',')
  }, null, 1));
}

if (mode === 'duel') {
  var Duel = require('./duelSim');
  var res = [];
  for (var d = 0; d < N; d++) {
    var D = Duel.create({ human: false, seed: 2000 + d, skillA: 0.85, skillB: 0.7 });
    while (D.phase !== 'over') Duel.step(D, null);
    res.push(D.boards.map(function (b) { return { score: b.score, level: b.level, deaths: b.deaths, bestChain: b.bestChain, jamsSent: b.jamsSent }; }));
  }
  console.log(JSON.stringify(res.map(function (r) { return r.map(function (b) { return b.score + ' L' + b.level + ' d' + b.deaths + ' c' + b.bestChain + ' j' + b.jamsSent; }).join('  vs  '); }), null, 1));
}

if (mode === 'arena') {
  var Arena = require('./arenaSim');
  var Z = Arena.create({ human: false, seed: 3000, bots: 6 });
  var stats = { trainKills: 0, ghostKills: 0, powerKills: 0, ownTrain: 0, cashouts: 0, maxTrain: 0, takenByTrains: 0 };
  for (var a = 0; a < 60 * 60 * (N || 3); a++) {
    Arena.step(Z, null);
    Z.events.forEach(function (e) {
      if (e.t === 'out') { if (e.how === 'train') { stats.trainKills++; stats.takenByTrains += e.v; } else if (e.how === 'ghost') stats.ghostKills++; else if (e.how === 'own') stats.ownTrain++; else stats.powerKills++; }
      if (e.t === 'cash') stats.cashouts++;
    });
    Z.events.length = 0;
    Z.players.forEach(function (p) { stats.maxTrain = Math.max(stats.maxTrain, p.train.length); });
  }
  var money = Z.players.reduce(function (s, p) { return s + p.worth; }, 0) + Z.coins.reduce(function (s, c) { return s + c.v; }, 0);
  stats.minutes = N || 3; stats.moneyInPlay = +money.toFixed(2); stats.staked = +Z.staked.toFixed(2); stats.paidOut = +Z.paidOut.toFixed(2); stats.house = +Z.house.toFixed(2);
  console.log(JSON.stringify(stats));
}
