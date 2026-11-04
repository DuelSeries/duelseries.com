// Pac-Man lab, concept "Train Arena": today's shared arena (today's maze module, the 2 x 2 torus) with ONE new idea that
// gives it a point: ghost trains are weapons.
//   - sleeping ghosts wake as you pass and follow you as a train; you can never turn back into it
//   - any OTHER chomper that touches your train is caught, and their whole worth goes to YOU (agar.io's rule: the
//     catcher takes it, server-decided), so you hunt by leading your train across a rival's path or boxing them in
//   - caught by a wild ghost (or your own train), your coins drop on the maze for anyone to grab (today's rule)
//   - a power pellet: eat rivals (take their worth) and eat any train ghost (yours or theirs) for points
//   - hold Q 3 s while moving to cash out 90/10 (today's rule)
// Money here is pretend: every seat starts at $1.00 and the lab keeps a ledger (staked, paid out, house) so the page
// can show the money always adds up. Speeds are flat: no cherry and no dot boosts. Pure sim, no DOM.
(function (root) {
  'use strict';
  var isNode = typeof module === 'object' && module.exports;
  var Core = isNode ? require('./labCore') : root.LabCore;
  var LabMaze = isNode ? require('./labMaze') : root.LabMaze;
  var FULL = Core.FULL, GAP = Core.TRAIN_GAP;
  var BOT_NAMES = ['Mara', 'Jett', 'Kofi', 'Lina', 'Ozzy', 'Pia', 'Rui', 'Suki', 'Teo'];

  function create(o) {
    o = o || {};
    var A = LabMaze.build('module', 2, 2, { wrap: true });
    var Z = {
      A: A, rnd: Core.rng(o.seed || ((Date.now() & 0xffff) + 7)), tick: 0, events: [],
      cfg: {
        pac: o.pac || 0.72, ghost: o.ghost || 0.66, powerMul: 1.12, powerS: 5, trainMax: o.trainMax || 10,
        sleepersPerModule: 5, stake: 1.0, cashHoldS: 3, dotBackS: 8, pelletBackS: 30, respawnS: 3, trains: o.trains !== false
      },
      dots: new Uint8Array(A.dot0), dotBack: [], players: [], wild: [], sleepers: [], coins: [], pendingSleep: [],
      staked: 0, paidOut: 0, house: 0
    };
    A.modules.forEach(function (m, i) {
      var g = Core.ghost((m.i + m.j) % 2, m, 'house', 60 + i * 90);
      g.exit = i % 2 ? 3 : 1;
      Z.wild.push(g);
    });
    var n = (o.human !== false ? 1 : 0) + (o.bots == null ? 6 : o.bots);
    for (var i = 0; i < n; i++) {
      var human = o.human !== false && i === 0;
      var p = Core.chomper({ id: i, name: human ? 'YOU' : BOT_NAMES[(i - 1 + BOT_NAMES.length) % BOT_NAMES.length], bot: !human,
        skill: 0.6 + Z.rnd() * 0.35, x: 0, y: 0, extra: { worth: 0, cashed: 0, cashT: 0, respawnT: 0, take: 0, holding: false } });
      Z.players.push(p);
      spawn(Z, p);
    }
    if (Z.cfg.trains) for (var s = 0; s < A.modules.length * Z.cfg.sleepersPerModule; s++) addSleeper(Z);
    return Z;
  }

  function spawn(Z, p) {
    var A = Z.A, avoid = [];
    Z.wild.forEach(function (g) { if (g.state === 'out') avoid.push(g); });
    Z.players.forEach(function (q) { if (q !== p && q.alive) { avoid.push(q); q.train.forEach(function (g) { avoid.push(g); }); } });
    var t = Core.randomTile(A, Z.rnd, avoid, 10);
    p.x = t.x; p.y = t.y; p.dir = Z.rnd() < 0.5 ? 1 : 3; p.want = p.dir; p.alive = true; p.power = 0; p.chain = 0;
    p.safe = 120; p.dyingT = -1; p.trail = []; p.train = []; p.cashT = 0; p.lastTile = -1;
    p.worth = Z.cfg.stake; Z.staked += Z.cfg.stake;
  }

  function addSleeper(Z) {
    var avoid = Z.players.filter(function (p) { return p.alive; }).concat(Z.sleepers);
    var t = Core.randomTile(Z.A, Z.rnd, avoid, 5, function (c, r) {
      var lr = r % 32, lc = c % 29;
      return !(lr >= 10 && lr <= 18 && lc >= 8 && lc <= 19);   // not in or beside a ghost house
    });
    Z.sleepers.push({ ki: Math.floor(Z.rnd() * 4), x: t.x, y: t.y });
  }

  function step(Z, input) {
    Z.tick++;
    var A = Z.A, cfg = Z.cfg, ev = Z.events;
    Z.pendingSleep = Z.pendingSleep.filter(function (t) { if (Z.tick >= t) { addSleeper(Z); return false; } return true; });
    // pellets and dots come back
    Z.dotBack = Z.dotBack.filter(function (d) {
      if (Z.tick < d.at) return true;
      var c = d.k % A.W, r = (d.k - c) / A.W;
      if (Z.players.some(function (p) { return p.alive && Math.abs(A.dx(p.x, c + 0.5)) < 4 && Math.abs(A.dy(p.y, r + 0.5)) < 4; })) { d.at = Z.tick + 60; return true; }
      Z.dots[d.k] = d.kind; return false;
    });

    Z.players.forEach(function (p) {
      if (!p.alive) {
        if (p.dyingT >= 0) p.dyingT++;
        if (--p.respawnT <= 0) spawn(Z, p);
        return;
      }
      if (!p.bot && input) { if (input.want != null) p.want = input.want; p.holding = !!input.hold; }
      if (p.bot) think(Z, p);
      if (p.safe > 0) p.safe--;
      if (p.power > 0 && --p.power === 0) p.chain = 0;
      var sp = FULL * cfg.pac * (p.power > 0 ? cfg.powerMul : 1);
      Core.moveChomper(p, A, sp, Z.dots, function (k, kind) {
        Z.dots[k] = 0;
        Z.dotBack.push({ k: k, kind: kind, at: Z.tick + (kind === 2 ? cfg.pelletBackS : cfg.dotBackS) * 60 });
        if (kind === 1) { p.score += 10; if (!p.bot) ev.push({ t: 'dot', id: p.id }); }
        else { p.score += 50; p.power = cfg.powerS * 60; p.powerAt = Z.tick; p.chain = 0; ev.push({ t: 'power', id: p.id }); }
      });
      // coins on your tile are yours
      var c = A.wc(Math.floor(p.x)), r = A.wr(Math.floor(p.y));
      for (var i = Z.coins.length - 1; i >= 0; i--) {
        var co = Z.coins[i];
        if (co.c === c && co.r === r) { p.worth += co.v; Z.coins.splice(i, 1); ev.push({ t: 'coin', id: p.id, v: co.v, x: c + 0.5, y: r + 0.5 }); }
      }
      Core.pushTrail(p, A, (p.train.length + 3) * GAP + 40);
      Core.trainFollow(p, A);
      // wake sleepers
      for (var s = Z.sleepers.length - 1; s >= 0; s--) {
        var sl = Z.sleepers[s];
        if (Core.d2(A, p.x, p.y, sl.x, sl.y) < 1.3 && p.train.length < cfg.trainMax) {
          Z.sleepers.splice(s, 1);
          var last = p.train[p.train.length - 1];
          p.train.push({ ki: sl.ki, x: sl.x, y: sl.y, dir: p.dir, off: Math.max((p.train.length + 1) * GAP, last ? last.off + GAP : GAP), joinT: Z.tick });
          ev.push({ t: 'wake', id: p.id, x: sl.x, y: sl.y, n: p.train.length });
        }
      }
      // cash out: hold while moving, after the spawn blink
      if (p.holding && p.safe <= 0) {
        if (p.moving) p.cashT++;
        if (p.cashT >= cfg.cashHoldS * 60) cashOut(Z, p);
      } else p.cashT = 0;
    });

    var env = {
      tick: Z.tick, rnd: Z.rnd, ghosts: Z.wild, speed: FULL * cfg.ghost,
      prey: function (g) {
        var best = null, bd = 22 * 22;
        Z.players.forEach(function (p) {
          if (!p.alive || (p.power > 0 && g.revivedAt < p.powerAt)) return;
          var d = Core.d2(A, g.x, g.y, p.x, p.y) + Z.rnd() * 0.01;
          if (d < bd) { bd = d; best = p; }
        });
        return best;
      },
      scared: function (g) { return Z.players.some(function (p) { return p.alive && p.power > 0 && g.revivedAt < p.powerAt && Core.d2(A, g.x, g.y, p.x, p.y) < 100; }); }
    };
    Z.wild.forEach(function (g) { Core.stepGhost(g, A, env); });
    collide(Z);
  }

  function edible(p, g) { return p.power > 0 && g.revivedAt < p.powerAt; }

  function collide(Z) {
    var A = Z.A, ps = Z.players, ev = Z.events;
    function chain(p, x, y) {
      var pts = 200 * Math.pow(2, Math.min(3, p.chain++)); p.score += pts;
      ev.push({ t: 'ghost', id: p.id, x: x, y: y, pts: pts });
    }
    ps.forEach(function (p) {
      if (!p.alive) return;
      var powered = p.power > 0;
      // trains, every one including yours
      for (var oi = 0; oi < ps.length && p.alive; oi++) {
        var o = ps[oi];
        for (var i = 0; i < o.train.length; i++) {
          var g = o.train[i];
          if (!Core.near(A, p, g, powered ? 0.6 : 0.5)) continue;
          if (powered) { chain(p, g.x, g.y); o.train.splice(i, 1); i--; Z.pendingSleep.push(Z.tick + 300); continue; }
          if (p.safe > 0 || Z.tick - g.joinT < 30) continue;
          if (o === p) { if (Core.ahead(A, p, g)) { catchBy(Z, p, null, 'own'); break; } continue; }
          catchBy(Z, p, o, 'train'); break;
        }
      }
      if (!p.alive) return;
      Z.wild.forEach(function (g) {
        if (!p.alive || g.state !== 'out' || !Core.near(A, p, g, 0.6)) return;
        if (edible(p, g)) { chain(p, g.x, g.y); g.state = 'eyes'; }
        else if (p.safe <= 0) catchBy(Z, p, null, 'ghost');
      });
    });
    // powered chompers eat unpowered ones
    for (var a = 0; a < ps.length; a++) for (var b = a + 1; b < ps.length; b++) {
      var x = ps[a], y = ps[b];
      if (!x.alive || !y.alive || (x.power > 0) === (y.power > 0) || !Core.near(A, x, y, 0.7)) continue;
      var eater = x.power > 0 ? x : y, prey = eater === x ? y : x;
      if (prey.safe > 0) continue;
      eater.score += 1000;
      catchBy(Z, prey, eater, 'power');
    }
  }

  // p is caught. by: the chomper who gets the worth (their train, or they ate p powered), or null: coins drop.
  function catchBy(Z, p, by, how) {
    var A = Z.A, ev = Z.events, w = p.worth;
    p.alive = false; p.dyingT = 0; p.respawnT = Z.cfg.respawnS * 60; p.power = 0; p.cashT = 0;
    p.worth = 0;
    if (by) { by.worth += w; by.take += w; by.score += 500; }
    else dropCoins(Z, p, w);
    // the train falls asleep again around the maze
    p.train.forEach(function () { Z.pendingSleep.push(Z.tick + 120); });
    p.train = [];
    ev.push({ t: 'out', id: p.id, by: by ? by.id : null, how: how, v: w, x: p.x, y: p.y });
  }

  // a quarter-dollar coin a tile on the path tiles nearest the catch, the catch's own tile first
  function dropCoins(Z, p, w) {
    var A = Z.A, n = Math.max(1, Math.round(w / 0.25)), v = w / n;
    var c0 = A.wc(Math.floor(p.x)), r0 = A.wr(Math.floor(p.y)), seen = new Set([A.k(c0, r0)]), q = [[c0, r0]], out = [];
    while (q.length && out.length < n) {
      var t = q.shift(); out.push(t);
      for (var d = 0; d < 4; d++) {
        var nc = t[0] + Core.DIRS[d][0], nr = t[1] + Core.DIRS[d][1];
        if (!A.walk(nc, nr)) continue;
        var nk = A.k(nc, nr);
        if (seen.has(nk)) continue;
        seen.add(nk); q.push([A.wc(nc), A.wr(nr)]);
      }
    }
    out.forEach(function (t) { Z.coins.push({ c: t[0], r: t[1], v: v }); });
  }

  function cashOut(Z, p) {
    var w = p.worth, pay = Math.round(w * 0.9 * 100) / 100;
    Z.paidOut += pay; Z.house += w - pay; p.cashed += pay;
    Z.events.push({ t: 'cash', id: p.id, v: w, pay: pay, x: p.x, y: p.y });
    p.worth = 0; p.train.forEach(function () { Z.pendingSleep.push(Z.tick + 120); }); p.train = [];
    p.alive = false; p.dyingT = -1; p.respawnT = 60;
  }

  // ---- bots: dots and coins, a train of their own, pellets to hunt, hold to cash out when rich and safe
  function think(Z, p) {
    var A = Z.A, cfg = Z.cfg;
    var k = A.k(Math.floor(p.x), Math.floor(p.y));
    if (k === p.lastTile && --p.plan > 0) return;
    p.lastTile = k; p.plan = 8;
    var powered = p.power > 60, threats = [], prize = new Map(), own = new Map();
    function at(o) { return A.k(Math.floor(o.x), Math.floor(o.y)); }
    Z.wild.forEach(function (g) { if (g.state === 'out' && !edible(p, g)) threats.push(g); else if (g.state === 'out' && powered) prize.set(at(g), 6); });
    Z.players.forEach(function (q) {
      if (q === p || !q.alive) return;
      if (q.power > 0 && p.power <= 0) threats.push(q);
      if (powered && q.power <= 0) prize.set(at(q), 30 * Math.max(0.5, q.worth));
      // hunting with a train: cut across a rival's path a few tiles ahead of them, so they run into the line
      else if (!powered && p.train.length >= 3 && q.power <= 0 && Core.d2(A, p.x, p.y, q.x, q.y) < 196) {
        var v = Core.DIRS[q.dir >= 0 ? q.dir : 1];
        for (var s2 = 2; s2 <= 4; s2++) { var ic = Math.floor(q.x) + v[0] * s2, ir = Math.floor(q.y) + v[1] * s2; if (A.walk(ic, ir)) prize.set(A.k(ic, ir), 4 + p.train.length); }
      }
      q.train.forEach(function (g) { if (powered) prize.set(at(g), 8); else threats.push(g); });
    });
    p.train.forEach(function (g) { own.set(at(g), 1); if (powered) prize.set(at(g), 8); });
    var careless = Z.rnd() > p.skill;
    var field = Core.dangerField(A, threats, careless ? 2 : 4, careless ? 4 : 10);
    var f2 = powered ? field : function (kk) { return field(kk) + (own.has(kk) ? 300 : 0); };
    var coinAt = new Map();
    Z.coins.forEach(function (c) { var ck = A.k(c.c, c.r); coinAt.set(ck, (coinAt.get(ck) || 0) + c.v); });
    var sleepAt = new Set(Z.sleepers.map(function (s) { return at(s); }));
    var dots = Z.dots, train = p.train.length;
    var d = Core.plan(p, A, f2, function (kk) {
      var v = prize.get(kk) || 0;
      if (dots[kk] === 1) v += 1; else if (dots[kk] === 2) v += powered ? 0.3 : 2 + train * 1.5;
      var cv = coinAt.get(kk); if (cv) v += 20 * cv;
      if (!powered && train < 7 && sleepAt.has(kk)) v += 5;
      return v;
    }, { maxCost: 60, noBack: !powered && train > 0 });
    if (d >= 0) p.want = d;
    // cash out once rich, with nothing near
    p.holding = p.worth >= 2.5 && !threats.some(function (t) { return Core.d2(A, p.x, p.y, t.x, t.y) < 64; });
    void cfg;
  }

  var Arena = { create: create, step: step, edible: edible };
  if (isNode) module.exports = Arena;
  else root.ArenaSim = Arena;
})(typeof self !== 'undefined' ? self : this);
