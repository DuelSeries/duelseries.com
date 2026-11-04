// Pac-Man lab, concept "Ghost Train Duel": a 1v1 score race. Each player runs their OWN copy of the same maze from the
// same seed (so both get the same sleeping-ghost spots and the same ghost luck to start with), side by side.
//   - sleeping ghosts wake when you pass and fall in behind you as a train (CE DX's best idea). Turning back into your
//     own train is a catch, so a long train means you can never turn round
//   - a power pellet turns your train blue: turn round and eat the whole line, 200, 400, 800, 1600, 3200, 3200...
//   - clear one half of the maze and it refills, your speed level goes up (faster and more points); a catch costs a
//     level and your train (speed is earned, not given)
//   - eat 4 ghosts on one pellet and a grey slow-blob drops into your rival's maze (it slows them, it never kills:
//     Pac-Man 99's red jammers that kill on touch were its top complaint)
// Highest score at the buzzer wins. Pure sim, no DOM.
(function (root) {
  'use strict';
  var isNode = typeof module === 'object' && module.exports;
  var Core = isNode ? require('./labCore') : root.LabCore;
  var LabMaze = isNode ? require('./labMaze') : root.LabMaze;
  var FULL = Core.FULL, GAP = Core.TRAIN_GAP;

  function create(o) {
    o = o || {};
    var seed = o.seed || ((Date.now() & 0xffff) + 1);
    var A = LabMaze.build(LabMaze.BRICK, 1, 1);
    var D = {
      A: A, tick: 0, phase: 'ready', phaseT: 120, events: [],
      cfg: {
        base: o.base || 0.68,        // level 1 speed (the arcade's level 1 is 0.80)
        perLevel: o.perLevel || 0.035,
        maxSpeed: 1.0,
        ghostRatio: 0.93,            // wild ghosts against your current level speed
        matchS: o.matchS || 150,
        sleepers: 10,
        trainMax: 24,
        powerS: function (lvl) { return Math.max(3, 6.5 - 0.35 * (lvl - 1)); }
      },
      boards: []
    };
    D.boards.push(board(D, seed, 0, o.human !== false ? null : (o.skillA || 0.85), o.nameA || 'YOU'));
    D.boards.push(board(D, seed, 1, o.skillB || 0.75, o.nameB || 'BOT'));
    return D;
  }

  function board(D, seed, idx, skill, name) {
    var A = D.A, m = A.modules[0];
    var b = {
      idx: idx, name: name, bot: skill != null, skill: skill || 0, rnd: Core.rng(seed),
      dots: new Uint8Array(A.dot0), p: Core.chomper({ id: idx, x: LabMaze.START.x, y: LabMaze.START.y, dir: 1 }),
      wild: [Core.ghost(0, m, 'house', 3 * 60), Core.ghost(1, m, 'house', 6 * 60)],
      sleepers: [], jams: [], pendingSleep: [], level: 1, score: 0, deaths: 0, bestChain: 0, jamsSent: 0, slow: 0, respawnT: 0,
      left: [0, 0], wantTrain: 4 + Math.round((skill || 0.8) * 8)
    };
    b.wild[1].exit = 3;
    for (var k = 0; k < A.W * A.H; k++) if (b.dots[k]) b.left[(k % A.W) < 14 ? 0 : 1]++;
    for (var i = 0; i < D.cfg.sleepers; i++) addSleeper(D, b);
    return b;
  }

  function sleepOk(c, r) { return !(r >= 10 && r <= 18 && c >= 8 && c <= 19); }
  function addSleeper(D, b) {
    var avoid = [b.p].concat(b.sleepers);
    var t = Core.randomTile(D.A, b.rnd, avoid, 4, sleepOk);
    b.sleepers.push({ ki: Math.floor(b.rnd() * 4), x: t.x, y: t.y });
  }

  function levelSpeed(D, b) { return Math.min(D.cfg.maxSpeed, D.cfg.base + D.cfg.perLevel * (b.level - 1)); }

  function step(D, input) {
    D.tick++;
    if (D.phase === 'over') return;
    if (D.phase === 'ready') { if (--D.phaseT <= 0) { D.phase = 'play'; D.playTick = D.tick; D.events.push({ t: 'go' }); } return; }
    D.boards.forEach(function (b) { stepBoard(D, b, b.bot ? null : input); });
    if ((D.tick - D.playTick) >= D.cfg.matchS * 60) {
      D.phase = 'over';
      var a = D.boards[0], c = D.boards[1];
      D.winner = a.score > c.score ? a : c.score > a.score ? c : null;
      D.events.push({ t: 'over', winner: D.winner });
    }
  }
  function timeLeft(D) { return D.phase === 'ready' ? D.cfg.matchS : Math.max(0, D.cfg.matchS - (D.tick - D.playTick) / 60); }

  function stepBoard(D, b, input) {
    var A = D.A, p = b.p, cfg = D.cfg, ev = D.events;
    // sleepers coming back after being eaten
    b.pendingSleep = b.pendingSleep.filter(function (t) { if (D.tick >= t) { addSleeper(D, b); return false; } return true; });
    if (!p.alive) {
      if (--b.respawnT <= 0) {
        p.alive = true; p.x = LabMaze.START.x; p.y = LabMaze.START.y; p.dir = 1; p.want = 1; p.safe = 120; p.trail = []; p.dyingT = -1;
        b.wild.forEach(function (g, i) { g.state = 'house'; g.x = g.m.ox + 14; g.y = g.m.oy + 14.5; g.releaseAt = D.tick + 120 + i * 120; });
      } else { p.dyingT++; return; }
    }
    if (input && input.want != null) p.want = input.want;
    if (b.bot) think(D, b);
    if (p.safe > 0) p.safe--;
    if (b.slow > 0) b.slow--;
    if (p.power > 0 && --p.power === 0) p.chain = 0;
    var lv = levelSpeed(D, b);
    var sp = FULL * lv * (p.power > 0 ? 1.1 : 1) * (b.slow > 0 ? 0.6 : 1);
    Core.moveChomper(p, A, sp, b.dots, function (k, kind) {
      b.dots[k] = 0;
      var half = (k % A.W) < 14 ? 0 : 1;
      b.left[half]--;
      if (kind === 1) { b.score += 10; if (!b.bot) ev.push({ t: 'dot', b: b.idx }); }
      else { b.score += 50; p.power = Math.round(cfg.powerS(b.level) * 60); p.powerAt = D.tick; p.chain = 0; ev.push({ t: 'power', b: b.idx }); }
      if (b.left[half] === 0) clearHalf(D, b, half);
    });
    Core.pushTrail(p, A, (b.p.train.length + 3) * GAP + 40);
    Core.trainFollow(p, A);

    // wake sleepers you pass
    for (var i = b.sleepers.length - 1; i >= 0; i--) {
      var s = b.sleepers[i];
      if (Core.d2(A, p.x, p.y, s.x, s.y) < 1.3 && p.train.length < cfg.trainMax) {
        b.sleepers.splice(i, 1);
        var last = p.train[p.train.length - 1];
        p.train.push({ ki: s.ki, x: s.x, y: s.y, dir: p.dir, off: Math.max((p.train.length + 1) * GAP, last ? last.off + GAP : GAP), joinT: D.tick });
        ev.push({ t: 'wake', b: b.idx, x: s.x, y: s.y, n: p.train.length });
      }
    }

    // wild ghosts
    var env = {
      tick: D.tick, rnd: b.rnd, ghosts: b.wild, speed: FULL * lv * cfg.ghostRatio,
      prey: function () { return p.alive ? p : null; },
      scared: function (g) { return p.power > 0 && g.revivedAt < p.powerAt; }
    };
    b.wild.forEach(function (g) { Core.stepGhost(g, A, env); });
    // slow-blobs wander at random
    b.jams = b.jams.filter(function (j) { return D.tick < j.until; });
    b.jams.forEach(function (j) {
      Core.moveGrid(j, A, 0.5 * FULL * Core.DT, function (c, r) { return Core.decide(j, A, c, r, { x: 0, y: 0 }, true, b.rnd, false); });
    });
    collide(D, b);
  }

  function chainPts(b, i) { return Math.round(200 * Math.pow(2, Math.min(4, i)) * (1 + 0.2 * (b.level - 1)) / 10) * 10; }

  function collide(D, b) {
    var A = D.A, p = b.p, ev = D.events;
    if (!p.alive) return;
    var powered = p.power > 0;
    function eatOne(x, y) {
      var pts = chainPts(b, p.chain); p.chain++; b.score += pts; b.bestChain = Math.max(b.bestChain, p.chain);
      ev.push({ t: 'chain', b: b.idx, x: x, y: y, pts: pts, n: p.chain });
      if (p.chain === 4 || p.chain === 8 || p.chain === 12 || p.chain === 16) sendJam(D, b);
    }
    // own train: eaten when powered, a catch when not
    for (var i = 0; i < p.train.length; i++) {
      var g = p.train[i];
      if (!Core.near(A, p, g, powered ? 0.6 : 0.5)) continue;
      if (powered) { eatOne(g.x, g.y); p.train.splice(i, 1); i--; b.pendingSleep.push(D.tick + 240); }
      else if (p.safe <= 0 && D.tick - g.joinT > 30 && Core.ahead(A, p, g)) { die(D, b, 'train'); return; }
    }
    b.wild.forEach(function (g) {
      if (!p.alive || g.state !== 'out' || !Core.near(A, p, g, 0.6)) return;
      if (powered && g.revivedAt < p.powerAt) { eatOne(g.x, g.y); g.state = 'eyes'; }
      else if (p.safe <= 0) die(D, b, 'ghost');
    });
    if (!p.alive) return;
    for (var j = b.jams.length - 1; j >= 0; j--) {
      var jm = b.jams[j];
      if (!Core.near(A, p, jm, 0.65)) continue;
      if (powered) { b.score += 300; ev.push({ t: 'jamEat', b: b.idx, x: jm.x, y: jm.y }); b.jams.splice(j, 1); }
      else if (b.slow <= 0) { b.slow = 120; ev.push({ t: 'slowed', b: b.idx }); }
    }
  }

  function sendJam(D, b) {
    var o = D.boards[1 - b.idx], m = D.A.modules[0];
    o.jams.push({ x: m.ox + (o.jams.length % 2 ? 14.5 : 13.5), y: m.oy + 11.5, dir: o.jams.length % 2 ? 3 : 1, until: D.tick + 15 * 60, ki: 9 });
    b.jamsSent++;
    D.events.push({ t: 'jam', from: b.idx, to: o.idx });
  }

  function clearHalf(D, b, half) {
    var A = D.A;
    for (var k = 0; k < A.W * A.H; k++) if (A.dot0[k] && ((k % A.W) < 14 ? 0 : 1) === half) { b.dots[k] = A.dot0[k]; b.left[half]++; }
    b.level = Math.min(10, b.level + 1);
    var bonus = 500 * b.level;
    b.score += bonus;
    D.events.push({ t: 'clear', b: b.idx, half: half, level: b.level, pts: bonus });
  }

  function die(D, b, how) {
    var p = b.p;
    p.alive = false; p.power = 0; p.chain = 0; p.dyingT = 0;
    b.deaths++; b.respawnT = 100; b.level = Math.max(1, b.level - 1); b.slow = 0;
    // the train falls asleep again around the maze
    p.train.forEach(function () { b.pendingSleep.push(D.tick + 60); });
    p.train = [];
    D.events.push({ t: 'die', b: b.idx, how: how, x: p.x, y: p.y });
  }

  // ---- the bot: dots and halves, wake a train of the size it likes, then a pellet and turn round on it
  function think(D, b) {
    var A = D.A, p = b.p;
    if (!p.alive) return;
    var k = A.k(Math.floor(p.x), Math.floor(p.y));
    if (k === p.lastTile && --p.plan > 0) return;
    p.lastTile = k; p.plan = 8;
    var powered = p.power > 60;
    var threats = [];
    b.wild.forEach(function (g) { if (g.state === 'out' && !(p.power > 0 && g.revivedAt < p.powerAt)) threats.push(g); });
    var careless = b.rnd() > b.skill;
    var field = Core.dangerField(A, threats, careless ? 2 : 4, careless ? 4 : 10);
    var trainAt = new Map(), sleepAt = new Map(), jamAt = new Map();
    p.train.forEach(function (g) { trainAt.set(A.k(Math.floor(g.x), Math.floor(g.y)), 1); });
    b.sleepers.forEach(function (s) { sleepAt.set(A.k(Math.floor(s.x), Math.floor(s.y)), 1); });
    b.jams.forEach(function (j) { jamAt.set(A.k(Math.floor(j.x), Math.floor(j.y)), 1); });
    var fewer = b.left[0] <= b.left[1] ? 0 : 1, dots = b.dots, train = p.train.length, wantMore = train < b.wantTrain;
    var f2 = powered ? field : function (kk) { return field(kk) + (trainAt.has(kk) ? 300 : 0) + (jamAt.has(kk) ? 6 : 0); };
    var d = Core.plan(p, A, f2, function (kk) {
      var v = 0;
      if (dots[kk] === 1) v += ((kk % A.W) < 14 ? 0 : 1) === fewer ? 1.5 : 1;
      else if (dots[kk] === 2) v += powered ? 0 : (train >= b.wantTrain ? 8 + train * 1.5 : 0.3);
      if (!powered && wantMore && sleepAt.has(kk)) v += 4;
      if (powered) { if (trainAt.has(kk)) v += 18; if (jamAt.has(kk)) v += 4; }
      return v;
    }, { maxCost: 70, noBack: !powered && train > 0 });
    if (d >= 0) p.want = d;
  }

  var Duel = { create: create, step: step, timeLeft: timeLeft, levelSpeed: levelSpeed };
  if (isNode) module.exports = Duel;
  else root.DuelSim = Duel;
})(typeof self !== 'undefined' ? self : this);
