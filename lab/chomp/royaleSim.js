// Pac-Man lab, concept "Royale Rounds": 2 to 4 chompers on ONE screen-sized maze, last one standing wins the round,
// first to 3 rounds takes the match. Ideas taken from the research (side-session-notes pacman-rethink-research.md):
//   - one fewer power pellet than chompers alive (Pac-Man Battle Royale), so a pellet is a contest
//   - powered you are faster and you eat rivals; two chompers in the same state BUMP (both turn round), so you can
//     knock a rival into a ghost
//   - knocked out you come back as a GHOST you steer (Party Royale): catch a chomper to knock them out too
//   - after HURRY_S the ghosts speed up and a third comes out, so a round always ends
// Pure sim, no DOM: the page (royale.js) draws it, node runs it headless (labRun.js).
(function (root) {
  'use strict';
  var isNode = typeof module === 'object' && module.exports;
  var Core = isNode ? require('./labCore') : root.LabCore;
  var LabMaze = isNode ? require('./labMaze') : root.LabMaze;
  var Maze = isNode ? require('../../shared/chompMaze') : root.ChompMaze;
  var FULL = Core.FULL;

  var COLORS = ['#ffff00', '#00ff00', '#47b8ff', '#dedeff'];
  var NAMES = ['YOU', 'GREEN', 'BLUE', 'WHITE'];

  function create(o) {
    o = o || {};
    var S = {
      A: LabMaze.build(LabMaze.BRICK, 1, 1),
      rnd: Core.rng(o.seed || (Date.now() & 0xffff)),
      cfg: {
        pac: o.pac || 0.75,              // base speed, fraction of the arcade's 100% (the arcade's level 1 is 0.80)
        ghost: o.ghost || 0.70,          // wild ghosts (the arcade's 0.75)
        hurryGhost: 0.86,
        powerMul: 1.15,                  // powered chompers are 15% faster (BR doubles size and speed)
        powerS: 5,
        firstPelletS: 6,                 // the first pellets show this long after GO: the opening is dots and positioning
        roundS: o.roundS || 90,
        hurryS: o.hurryS || 45,
        toWin: o.toWin || 3,
        ghostPlayerMul: 0.92,            // a knocked-out player's ghost, against the base speed
        pelletBackS: 8,
        // contact false = the paid-safe version (concept panel, twist B): chompers pass through each other, and every
        // ghost you eat comes back out hunting your rivals (Pac-Man 99's attack inside one maze), harmless to you
        contact: o.contact !== false,
        sentS: 15
      },
      tick: 0, roundTick: 0, round: 0, phase: 'ready', phaseT: 0, events: [], banner: null,
      players: [], ghosts: [], dots: null, pelletSpots: [], pelletWait: 0, winner: null, roundWinner: null, human: o.human !== false
    };
    var n = Math.max(2, Math.min(4, o.players || 4));
    for (var i = 0; i < n; i++) {
      var bot = i > 0 || !S.human;
      S.players.push(Core.chomper({ id: i, name: NAMES[i], color: COLORS[i], bot: bot, skill: o.skill == null ? 0.8 : o.skill,
        x: 0, y: 0, extra: { wins: 0, roundPts: 0, kos: 0, ghostMe: null, outAt: -1, bumpT: 0 } }));
    }
    newRound(S);
    return S;
  }

  function newRound(S) {
    var A = S.A;
    S.round++;
    S.roundTick = 0; S.phase = 'ready'; S.phaseT = 120; S.roundWinner = null;
    S.dots = new Uint8Array(A.dot0);
    // energizer spots: the four in the table; one fewer pellet than chompers
    S.pelletSpots = [];
    for (var k = 0; k < A.W * A.H; k++) if (A.dot0[k] === 2) { S.pelletSpots.push(k); S.dots[k] = 0; }
    S.pelletWait = -1;                 // none yet: the first set comes firstPelletS after GO
    var m = A.modules[0];
    // both ghosts leave together, one each way, so no corner is nearer the first ghost than another
    S.ghosts = [Core.ghost(0, m, 'house', 0), Core.ghost(1, m, 'house', 0)];
    S.ghosts[1].exit = 3;
    S.ghostsAt = 3 * 60;
    // a drawn round is followed by sudden death: HURRY from the first second
    S.hurryAt = S.sudden ? 0 : S.cfg.hurryS * 60;
    // two players: the top corners, mirror images in a left-right symmetric maze (fair for a paid duel)
    var C4 = LabMaze.CORNERS, spots = S.players.length === 2 ? [C4[0], C4[2]] : C4;
    // seats move round one corner a round, so over a match nobody keeps the best corner
    var rot = (S.round - 1) % spots.length;
    S.players.forEach(function (p, i) {
      var s = spots[(i + rot) % spots.length];
      p.x = s.x; p.y = s.y; p.dir = s.x < 14 ? 3 : 1; p.want = p.dir; p.pause = 0; p.alive = true; p.power = 0; p.powerAt = -1;
      p.chain = 0; p.safe = 90; p.dyingT = -1; p.roundPts = 0; p.ghostMe = null; p.outAt = -1; p.bumpT = 0; p.lastTile = -1;
    });
    S.events.push({ t: 'ready' });
  }

  function placePellets(S, n) {
    var spots = S.pelletSpots.slice(), A = S.A;
    // a 1v1: a mirror pair (the maze is left-right symmetric), so neither seat is nearer its pellet. The first pair is
    // the row away from the seats; later pairs top or bottom at random.
    if (S.players.length === 2) {
      var bottom = S.pelletWait < 0 || S.rnd() < 0.5;
      spots.forEach(function (k) { if ((k >= A.W * 15) === bottom) S.dots[k] = 2; });
      S.pelletWait = 0;
      return;
    }
    for (var i = spots.length - 1; i > 0; i--) { var j = Math.floor(S.rnd() * (i + 1)), t = spots[i]; spots[i] = spots[j]; spots[j] = t; }
    for (var q = 0; q < Math.max(1, n) && q < spots.length; q++) S.dots[spots[q]] = 2;
    S.pelletWait = 0;
    void A;
  }

  function alive(S) { return S.players.filter(function (p) { return p.alive; }); }
  function pelletsOut(S) { var n = 0; S.pelletSpots.forEach(function (k) { if (S.dots[k] === 2) n++; }); return n; }

  // A ghost eaten in the no-contact version hunts everyone but its eater for a while.
  function sentBy(S, g) { return g.sentBy != null && S.tick < g.sentUntil ? g.sentBy : null; }

  // Can chomper p eat wild ghost g right now?
  function eats(p, g) { return p.alive && p.power > 0 && g.revivedAt < p.powerAt; }

  function step(S, input) {
    S.tick++;
    if (S.phase === 'match') return;
    if (S.phase === 'ready' || S.phase === 'between') {
      if (--S.phaseT <= 0) {
        if (S.phase === 'between') {
          if (S.winner) { S.phase = 'match'; S.events.push({ t: 'match', winner: S.winner }); return; }
          newRound(S); return;
        }
        S.phase = 'play';
        S.ghosts.forEach(function (g) { g.releaseAt = S.tick + S.ghostsAt; });
        S.events.push({ t: 'go' });
      }
      return;
    }
    var A = S.A, cfg = S.cfg;
    S.roundTick++;
    var hurry = S.roundTick >= S.hurryAt;
    if (S.roundTick === Math.max(1, S.hurryAt)) {
      S.events.push({ t: 'hurry' });
      S.ghosts.push(Core.ghost(2, A.modules[0], 'house', S.tick + 30));
    }

    // inputs and bots
    S.players.forEach(function (p) {
      if (!p.bot && input) {
        if (p.alive) { if (input.want != null) p.want = input.want; }
        else if (p.ghostMe && input.want != null) p.ghostMe.want = input.want;
      }
      if (p.bot) think(S, p);
    });

    // chompers move
    S.players.forEach(function (p) {
      if (p.bumpT > 0) p.bumpT--;
      if (!p.alive) { stepOut(S, p); return; }
      if (p.safe > 0) p.safe--;
      if (p.power > 0 && --p.power === 0) p.chain = 0;
      var sp = FULL * cfg.pac * (p.power > 0 ? cfg.powerMul : 1);
      Core.moveChomper(p, A, sp, S.dots, function (k, kind) {
        S.dots[k] = 0;
        if (kind === 1) { p.roundPts += 10; p.score += 10; S.events.push({ t: 'dot', id: p.id }); }
        else {
          p.power = cfg.powerS * 60; p.powerAt = S.tick; p.chain = 0; p.roundPts += 50; p.score += 50;
          S.events.push({ t: 'power', id: p.id });
        }
      });
    });

    // wild ghosts
    var env = {
      tick: S.tick, rnd: S.rnd, ghosts: S.ghosts,
      speed: FULL * (hurry ? cfg.hurryGhost : cfg.ghost),
      prey: function (g) {
        var best = null, bd = 22 * 22;
        S.players.forEach(function (p) {
          if (!p.alive || eats(p, g) || sentBy(S, g) === p.id) return;
          var d = Core.d2(A, g.x, g.y, p.x, p.y) + S.rnd() * 0.01;
          if (d < bd) { bd = d; best = p; }
        });
        return best;
      },
      scared: function (g) {
        return S.players.some(function (p) { return eats(p, g) && Core.d2(A, g.x, g.y, p.x, p.y) < 100; });
      },
      mode: hurry ? 'chase' : null
    };
    S.ghosts.forEach(function (g) { Core.stepGhost(g, A, env); });

    collide(S);

    // pellets come back once every one is gone and nobody is powered
    if (S.pelletWait < 0) { if (S.roundTick >= cfg.firstPelletS * 60) { placePellets(S, alive(S).length - 1); S.events.push({ t: 'pellets' }); } }
    else if (!pelletsOut(S) && !S.players.some(function (p) { return p.alive && p.power > 0; })) {
      if (++S.pelletWait >= cfg.pelletBackS * 60) { placePellets(S, alive(S).length - 1); S.events.push({ t: 'pellets' }); }
    }

    // round over?
    var left = alive(S);
    var timeUp = S.roundTick >= cfg.roundS * 60;
    if (left.length <= 1 || timeUp) {
      var w = null;
      if (left.length === 1) w = left[0];
      else if (left.length > 1) {
        left.sort(function (a, b) { return b.roundPts - a.roundPts; });
        if (left[0].roundPts > left[1].roundPts) w = left[0];
      }
      S.roundWinner = w;
      S.sudden = !w;
      if (w) { w.wins++; if (w.wins >= cfg.toWin) S.winner = w; }
      S.phase = 'between'; S.phaseT = 180;
      S.events.push({ t: 'round', winner: w, timeUp: timeUp && left.length > 1 });
    }
  }

  // A knocked-out chomper: the death animation, then a ghost that player steers out of the house.
  function stepOut(S, p) {
    var A = S.A, cfg = S.cfg;
    if (p.dyingT >= 0) {
      p.dyingT++;
      if (p.dyingT > 100) {
        p.dyingT = -1;
        var m = A.modules[0];
        p.ghostMe = { ki: 3, x: m.ox + 13.5, y: m.oy + 11.5, dir: 1, want: 1, pause: 0, state: 'out', eyesT: 0, revivedAt: S.tick, owner: p.id };
        S.events.push({ t: 'ghostme', id: p.id });
      }
      return;
    }
    var gm = p.ghostMe;
    if (!gm) return;
    if (gm.state === 'eyes') {
      if (--gm.eyesT <= 0) { gm.state = 'out'; gm.x = 13.5; gm.y = 11.5; gm.dir = 1; gm.want = 1; gm.revivedAt = S.tick; }
      return;
    }
    if (p.bot) thinkGhost(S, p, gm);
    Core.moveChomper(gm, A, FULL * cfg.pac * cfg.ghostPlayerMul, null, null);
  }

  function knockOut(S, p, by) {
    p.alive = false; p.power = 0; p.dyingT = 0; p.outAt = S.tick; p.train = [];
    S.events.push({ t: 'out', id: p.id, by: by ? by.id : null, x: p.x, y: p.y });
  }

  function collide(S) {
    var A = S.A, ps = S.players;
    ps.forEach(function (p) {
      if (!p.alive) return;
      // wild ghosts
      S.ghosts.forEach(function (g) {
        if (g.state !== 'out' || !Core.near(A, p, g, 0.6)) return;
        if (sentBy(S, g) === p.id) return;
        if (eats(p, g)) {
          var pts = 200 * Math.pow(2, Math.min(3, p.chain++));
          p.roundPts += pts; p.score += pts; g.state = 'eyes';
          if (!S.cfg.contact) { g.sentBy = p.id; g.sentUntil = S.tick + S.cfg.sentS * 60; }
          S.events.push({ t: 'ghost', id: p.id, x: g.x, y: g.y, pts: pts });
        } else if (p.safe <= 0) knockOut(S, p, null);
      });
      if (!p.alive) return;
      // ghosts steered by knocked-out players
      ps.forEach(function (q) {
        var gm = q.ghostMe;
        if (!gm || gm.state !== 'out' || !p.alive || !Core.near(A, p, gm, 0.6)) return;
        if (p.power > 0 && gm.revivedAt < p.powerAt) {
          var pts = 200 * Math.pow(2, Math.min(3, p.chain++));
          p.roundPts += pts; p.score += pts; gm.state = 'eyes'; gm.eyesT = 180;
          S.events.push({ t: 'ghost', id: p.id, x: gm.x, y: gm.y, pts: pts });
        } else if (p.safe <= 0) {
          q.kos++; q.score += 500;
          knockOut(S, p, q);
          S.events.push({ t: 'revenge', id: q.id, x: p.x, y: p.y });
        }
      });
    });
    // chomper against chomper: powered eats unpowered, two alike bump (not in the no-contact version)
    if (!S.cfg.contact) return;
    for (var i = 0; i < ps.length; i++) for (var j = i + 1; j < ps.length; j++) {
      var a = ps[i], b = ps[j];
      if (!a.alive || !b.alive || !Core.near(A, a, b, 0.75)) continue;
      var ap = a.power > 0, bp = b.power > 0;
      if (ap !== bp) {
        var eater = ap ? a : b, prey = ap ? b : a;
        if (prey.safe > 0) continue;
        eater.roundPts += 1000; eater.score += 1000; eater.kos++;
        S.events.push({ t: 'eat', id: eater.id, x: prey.x, y: prey.y });
        knockOut(S, prey, eater);
      } else if (a.bumpT <= 0 && b.bumpT <= 0) {
        // only when closing on each other: reverse whoever was heading at the other
        var dx = A.dx(a.x, b.x), dy = A.dy(a.y, b.y);
        var va = Core.DIRS[a.dir], vb = Core.DIRS[b.dir];
        var aTo = va[0] * dx + va[1] * dy > 0, bTo = -(vb[0] * dx + vb[1] * dy) > 0;
        if (aTo) { a.dir = Core.opp(a.dir); a.want = a.dir; }
        if (bTo) { b.dir = Core.opp(b.dir); b.want = b.dir; }
        if (aTo || bTo) { a.bumpT = b.bumpT = 20; S.events.push({ t: 'bump', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }); }
      }
    }
  }

  // ---- bots
  function think(S, p) {
    var A = S.A;
    var c = Math.floor(p.x), r = Math.floor(p.y), k = A.k(c, r);
    if (!p.alive) return;
    if (k === p.lastTile && --p.plan > 0) return;
    p.lastTile = k; p.plan = 8;
    var threats = [];
    var powered = p.power > 0, powerLeft = p.power / 60;
    S.ghosts.forEach(function (g) { if (g.state === 'out' && !eats(p, g) && sentBy(S, g) !== p.id) threats.push(g); });
    S.players.forEach(function (q) {
      if (q === p) return;
      if (S.cfg.contact && q.alive && q.power > 0 && !powered) threats.push(q);
      if (q.ghostMe && q.ghostMe.state === 'out' && !(powered && q.ghostMe.revivedAt < p.powerAt)) threats.push(q.ghostMe);
    });
    var careless = S.rnd() > p.skill;
    var field = Core.dangerField(A, threats, careless ? 2 : 5, careless ? 4 : 10);
    var prize = new Map();
    if (powered && powerLeft > 1.2) {
      if (S.cfg.contact) S.players.forEach(function (q) {
        if (q !== p && q.alive && q.power <= 0) prize.set(A.k(Math.floor(q.x), Math.floor(q.y)), 40);
      });
      S.ghosts.forEach(function (g) { if (g.state === 'out' && eats(p, g)) prize.set(A.k(Math.floor(g.x), Math.floor(g.y)), S.cfg.contact ? 8 : 24); });
    }
    var rivalsNear = S.players.some(function (q) { return q !== p && q.alive && Core.d2(A, p.x, p.y, q.x, q.y) < 144; });
    var dots = S.dots;
    var d = Core.plan(p, A, field, function (kk) {
      var v = prize.get(kk) || 0;
      if (dots[kk] === 1) v += 1;
      else if (dots[kk] === 2) v += powered ? 0.5 : rivalsNear ? 18 : 7;
      return v;
    }, { maxCost: 70 });
    if (d >= 0) p.want = d;
  }

  function thinkGhost(S, p, gm) {
    var A = S.A, k = A.k(Math.floor(gm.x), Math.floor(gm.y));
    if (k === gm.lastTile && --gm.plan > 0) return;
    gm.lastTile = k; gm.plan = 6;
    var threats = [], prey = new Map();
    S.players.forEach(function (q) {
      if (!q.alive) return;
      var qk = A.k(Math.floor(q.x), Math.floor(q.y));
      if (q.power > 0 && gm.revivedAt < q.powerAt) threats.push(q);
      else prey.set(qk, 30);
    });
    var field = Core.dangerField(A, threats, 5, 10);
    var d = Core.plan(gm, A, field, function (kk) { return prey.get(kk) || 0; }, { maxCost: 90 });
    if (d >= 0) gm.want = d;
    else if (S.rnd() < 0.05) gm.want = Math.floor(S.rnd() * 4);
  }

  var Royale = { create: create, step: step, eats: eats, sentBy: sentBy, COLORS: COLORS, NAMES: NAMES, alive: alive };
  if (isNode) module.exports = Royale;
  else root.RoyaleSim = Royale;
  void Maze;
})(typeof self !== 'undefined' ? self : this);
