// Pac-Man lab core (branch chomp-rethink): the pieces every prototype mode shares. Pure sim code, no DOM, so a mode
// runs in the page for Owen to play and in node for headless balance runs (lab/chomp/labRun.js), and could move to the
// server unchanged if a mode is picked (the real game stays server-authoritative; the lab runs its sim in the page
// only so Owen can feel the loop with no server work).
//
// Movement is the real game's (shared/chompMove.js: buffered turns, cornering, the arcade tile rules). Ghost steering is
// the arcade's (target tile, no reversing, the up-left-down-right tie-break), written small here. Bots plan with a
// cost-weighted search over the maze (danger near threats costs more, a dot or a prize pulls).
(function (root) {
  'use strict';
  var isNode = typeof module === 'object' && module.exports;
  var R = isNode ? require('../../shared/chompRules') : root.ChompRules;
  var Mv = isNode ? require('../../shared/chompMove') : root.ChompMove;
  var Maze = isNode ? require('../../shared/chompMaze') : root.ChompMaze;

  var FULL = R.FULL_SPEED;              // 9.47 tiles a second = the arcade's 100%
  var DT = 1 / 60;
  var DIRS = R.DIRS;                    // up, left, down, right
  var EPS = 1e-6;
  function opp(d) { return (d + 2) & 3; }

  // ---- seeded random (mulberry32): the Train Duel gives both boards the same seed
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---- distances (the short way across a seam or through the side tunnel)
  function d2(A, ax, ay, bx, by) { var dx = A.dx(ax, bx), dy = A.dy(ay, by); return dx * dx + dy * dy; }
  function near(A, a, b, r) { return Math.abs(A.dx(a.x, b.x)) < r && Math.abs(A.dy(a.y, b.y)) < r; }

  // ---- a chomper (player or bot)
  function chomper(o) {
    var p = { id: o.id, name: o.name || '', color: o.color || '#ffff00', bot: !!o.bot, skill: o.skill == null ? 0.8 : o.skill,
      x: o.x, y: o.y, dir: o.dir == null ? 1 : o.dir, want: o.dir == null ? 1 : o.dir, pause: 0, moving: false,
      alive: true, power: 0, powerAt: -1, chain: 0, safe: 0, score: 0, dyingT: -1, trail: [], train: [], plan: 0, lastTile: -1 };
    for (var k in o.extra || {}) p[k] = o.extra[k];
    return p;
  }

  // Move a chomper one tick with the real game's movement. A one-screen maze wraps x through the side tunnel here
  // (chompMove only wraps a torus).
  function moveChomper(p, A, speed, dots, eat) {
    var kind = Mv.tick(p, A, speed, DT, null, null);
    if (A.sideWrap) { if (p.x < 0) p.x += A.W; else if (p.x >= A.W) p.x -= A.W; }
    var c = Math.floor(p.x), r = Math.floor(p.y);
    if (dots && A.inside(c, r)) {
      var k = r * A.W + c;
      if (dots[k]) { kind = dots[k]; p.pause = kind === 2 ? R.ENERGIZER_PAUSE_TICKS : 0; eat(k, kind); }
    }
    return kind;
  }

  // Trail of points every quarter tile, the path a train of ghosts walks behind its chomper.
  var TRAIL_STEP = 0.25, TRAIN_GAP = 5;            // a train ghost every 1.25 tiles
  function pushTrail(p, A, maxPts) {
    var t = p.trail, last = t[t.length - 1];
    if (!last) { t.push({ x: p.x, y: p.y }); return; }
    var dx = A.dx(last.x, p.x), dy = A.dy(last.y, p.y), d = Math.sqrt(dx * dx + dy * dy);
    if (d > 3) { t.length = 0; t.push({ x: p.x, y: p.y }); return; }   // a jump (respawn): start over
    while (d >= TRAIL_STEP) {
      var f = TRAIL_STEP / d;
      last = { x: A.wx(last.x + dx * f), y: A.wy(last.y + dy * f) };
      t.push(last);
      dx = A.dx(last.x, p.x); dy = A.dy(last.y, p.y); d = Math.sqrt(dx * dx + dy * dy);
    }
    if (t.length > maxPts) t.splice(0, t.length - maxPts);
  }
  // Put each train ghost on its spot along the trail (the first 1.25 tiles behind, the next 1.25 behind that).
  function placeTrain(p, A) {
    var t = p.trail, n = t.length;
    for (var i = 0; i < p.train.length; i++) {
      var g = p.train[i], j = Math.max(0, n - 1 - (i + 1) * TRAIN_GAP), q = t[j] || p, q2 = t[Math.min(n - 1, j + 1)] || p;
      var dx = A.dx(q.x, q2.x), dy = A.dy(q.y, q2.y);
      g.x = q.x; g.y = q.y;
      if (Math.abs(dx) + Math.abs(dy) > 1e-4) g.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 3 : 1) : (dy > 0 ? 2 : 0);
    }
  }

  // A train ghost catches its own chomper only when it is in FRONT of them (they turned back into the line). A corner
  // cut after overshooting a turn folds the path by up to half a tile, which must not count.
  function ahead(A, p, g, min) {
    var v = DIRS[p.dir >= 0 ? p.dir : 1];
    return v[0] * A.dx(p.x, g.x) + v[1] * A.dy(p.y, g.y) > (min == null ? 0.15 : min);
  }

  // Each train ghost walks the trail at its own offset; after one in front is eaten the ones behind close the gap.
  function trainFollow(p, A) {
    var t = p.trail, n = t.length;
    for (var i = 0; i < p.train.length; i++) {
      var g = p.train[i], want = (i + 1) * TRAIN_GAP;
      if (g.off > want) g.off = Math.max(want, g.off - 0.6);
      var j = Math.max(0, n - 1 - Math.round(g.off)), q = t[j] || p, q2 = t[Math.min(n - 1, j + 1)] || p;
      g.x = q.x; g.y = q.y;
      var dx = A.dx(q.x, q2.x), dy = A.dy(q.y, q2.y);
      if (Math.abs(dx) + Math.abs(dy) > 1e-4) g.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 3 : 1) : (dy > 0 ? 2 : 0);
    }
  }

  // ---- ghosts on the grid
  // g: { ki (0 red, 1 pink, 2 cyan, 3 orange), x, y, dir, state 'house' | 'leave' | 'out' | 'eyes' | 'enter', m (home
  //      module), releaseAt (tick), revivedAt (tick) }
  function ghost(ki, m, state, at) {
    var hx = m.ox + 14, hy = m.oy + 14.5;
    return { ki: ki, m: m, x: state === 'out' ? m.ox + 13.5 : hx, y: state === 'out' ? m.oy + 11.5 : hy, dir: 1, state: state || 'house',
      releaseAt: at || 0, revivedAt: -1, bob: 0, exit: 1 };
  }

  // Steer at a tile centre: the arcade's rule (never back the way you came, nearest to the target, ties up-left-down-right).
  function decide(g, A, c, r, target, scared, rnd, door) {
    var best = -1, bestD = Infinity, opts = [];
    for (var d = 0; d < 4; d++) {
      if (g.dir >= 0 && d === opp(g.dir)) continue;
      if (!A.ghostWalk(c + DIRS[d][0], r + DIRS[d][1], door)) continue;
      opts.push(d);
      if (!scared) {
        var dd = d2(A, c + DIRS[d][0] + 0.5, r + DIRS[d][1] + 0.5, target.x, target.y);
        if (dd < bestD - 1e-9) { bestD = dd; best = d; }
      }
    }
    if (!opts.length) return g.dir >= 0 ? opp(g.dir) : 1;
    if (scared) return opts[Math.floor(rnd() * opts.length)];
    return best;
  }

  // Move dist tiles, choosing a way on at every tile centre with pick(c, r).
  function moveGrid(g, A, dist, pick) {
    for (var guard = 0; dist > EPS && guard < 8; guard++) {
      var c = Math.floor(g.x), r = Math.floor(g.y), v = DIRS[g.dir];
      var ahead = v[0] ? (c + 0.5 - g.x) * v[0] : (r + 0.5 - g.y) * v[1];
      if (ahead < -EPS) ahead += 1;
      if (ahead <= EPS) {
        g.x = c + 0.5; g.y = r + 0.5;
        g.dir = pick(c, r);
        ahead = 1;
        v = DIRS[g.dir];
        if (!A.ghostWalk(c + v[0], r + v[1], g.state === 'eyes')) return;   // boxed in (cannot happen in our mazes)
      }
      var s = Math.min(dist, ahead);
      g.x = A.wx(g.x + v[0] * s); g.y = A.wy(g.y + v[1] * s);
      if (A.sideWrap) { if (g.x < 0) g.x += A.W; else if (g.x >= A.W) g.x -= A.W; }
      dist -= s;
    }
  }

  var MODES = R.MODES;
  function modeAt(tick) {
    var total = 0, i;
    for (i = 0; i < MODES.length; i++) total += MODES[i][1] * 60;
    var t = tick % total;
    for (i = 0; i < MODES.length; i++) { if (t < MODES[i][1] * 60) return MODES[i][0]; t -= MODES[i][1] * 60; }
    return 'chase';
  }

  // Where a wild ghost aims (DOSSIER chapter 4, our arena reading): the nearest chomper it can hurt within sense tiles.
  function targetFor(g, A, prey, mode, ghosts) {
    var m = g.m;
    var sc = Maze.SCATTER[['blinky', 'pinky', 'inky', 'clyde'][g.ki]];
    var scatter = { x: m.ox + sc[0] + 0.5, y: m.oy + sc[1] + 0.5 };
    if (!prey || mode === 'scatter') return scatter;
    var v = DIRS[prey.dir >= 0 ? prey.dir : 1], px = Math.floor(prey.x) + 0.5, py = Math.floor(prey.y) + 0.5;
    if (g.ki === 0) return { x: px, y: py };
    if (g.ki === 1) return { x: px + v[0] * 4, y: py + v[1] * 4 };
    if (g.ki === 2) {
      var red = null;
      for (var i = 0; i < ghosts.length; i++) if (ghosts[i].ki === 0 && ghosts[i].state === 'out') { red = ghosts[i]; break; }
      var ax = px + v[0] * 2, ay = py + v[1] * 2;
      if (!red) return { x: ax, y: ay };
      return { x: ax + A.dx(red.x, ax), y: ay + A.dy(red.y, ay) };
    }
    return d2(A, g.x, g.y, px, py) > 64 ? { x: px, y: py } : scatter;
  }

  // One tick of a wild ghost. env: { tick, speed (tiles/s, normal), prey(g) -> chomper or null, scared(g) -> bool,
  // rnd, ghosts }. Handles the house, leaving, eyes going home and coming back out.
  function stepGhost(g, A, env) {
    var m = g.m, hx = m.ox + 14, inY = m.oy + 14.5, outY = m.oy + 11.5;
    var sp = env.speed * DT;
    if (g.state === 'house') {
      g.bob = (g.bob + 1) % 32;
      g.y = inY + (g.bob < 16 ? -0.25 : 0.25) * 0.5;
      g.dir = g.bob < 16 ? 0 : 2;
      if (env.tick >= g.releaseAt) { g.state = 'leave'; g.y = inY; }
      return;
    }
    if (g.state === 'leave') {
      var hs = R.GHOST_HOUSE_SPEED * FULL * DT * 1.6;
      if (Math.abs(g.x - hx) > 1e-3) { g.x += Math.sign(hx - g.x) * Math.min(hs, Math.abs(hx - g.x)); g.dir = g.x < hx ? 3 : 1; return; }
      if (g.y > outY + 1e-3) { g.y -= Math.min(hs, g.y - outY); g.dir = 0; return; }
      // half a tile left, onto the corridor's tile centre, then out into the maze
      g.x = m.ox + (g.exit === 3 ? 14.5 : 13.5); g.y = outY; g.dir = g.exit === 3 ? 3 : 1; g.state = 'out';
      return;
    }
    if (g.state === 'enter') {
      var es = R.GHOST_EYES_SPEED * FULL * DT;
      if (Math.abs(g.x - hx) > 1e-3) { g.x += Math.sign(hx - g.x) * Math.min(es, Math.abs(hx - g.x)); return; }
      if (g.y < inY - 1e-3) { g.y += Math.min(es, inY - g.y); g.dir = 2; return; }
      g.state = 'house'; g.revivedAt = env.tick; g.releaseAt = env.tick + 60;
      return;
    }
    if (g.state === 'eyes') {
      var home = { x: m.ox + 13.5, y: m.oy + 11.5 };
      moveGrid(g, A, R.GHOST_EYES_SPEED * FULL * DT, function (c, r) {
        if ((c === m.ox + 13 || c === m.ox + 14) && r === m.oy + 11) { g.state = 'enter'; return g.dir; }
        return decide(g, A, c, r, home, false, env.rnd, false);
      });
      return;
    }
    // out in the maze
    var scared = env.scared(g);
    var c0 = Math.floor(g.x), r0 = Math.floor(g.y);
    var speed = scared ? R.GHOST_FRIGHT_SPEED * FULL : A.tunnel(c0, r0) ? R.GHOST_TUNNEL_SPEED * FULL : env.speed;
    var prey = env.prey(g), mode = env.mode || modeAt(env.tick);
    moveGrid(g, A, speed * DT, function (c, r) {
      return decide(g, A, c, r, targetFor(g, A, prey, mode, env.ghosts), scared, env.rnd, false);
    });
  }

  // ---- bot planning: a cost-weighted search (Dijkstra) from the bot's tile.
  // field(k) -> extra cost of a tile (danger); value(k) -> how much the bot wants that tile (0 nothing). Returns the
  // first direction of the best path (value per cost), or -1.
  function Heap() { this.k = []; this.v = []; }
  Heap.prototype.push = function (key, val) {
    var k = this.k, v = this.v, i = k.length; k.push(key); v.push(val);
    while (i > 0) { var p = (i - 1) >> 1; if (v[p] <= val) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  };
  Heap.prototype.pop = function () {
    var k = this.k, v = this.v, top = k[0], lk = k.pop(), lv = v.pop(), n = k.length;
    if (n) {
      var i = 0;
      while (true) {
        var l = 2 * i + 1, r = l + 1, m = i, mv = lv;
        if (l < n && v[l] < mv) { m = l; mv = v[l]; }
        if (r < n && v[r] < mv) { m = r; mv = v[r]; }
        if (m === i) break;
        k[i] = k[m]; v[i] = v[m]; i = m;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  };
  Heap.prototype.size = function () { return this.k.length; };

  var scratch = {};
  function plan(p, A, field, value, opts) {
    var N = A.W * A.H, s = scratch[N];
    if (!s) s = scratch[N] = { dist: new Float32Array(N), first: new Int8Array(N), stamp: new Uint32Array(N), gen: 0 };
    s.gen++;
    var gen = s.gen, dist = s.dist, first = s.first, stamp = s.stamp;
    var c0 = A.wc(Math.floor(p.x)), r0 = A.wr(Math.floor(p.y)), k0 = r0 * A.W + c0;
    var maxCost = (opts && opts.maxCost) || 60, noBack = opts && opts.noBack;
    var heap = new Heap();
    stamp[k0] = gen; dist[k0] = 0; first[k0] = -1;
    heap.push(k0, 0);
    var bestScore = 0, bestDir = -1;
    while (heap.size()) {
      var k = heap.pop(), dk = dist[k];
      if (dk > maxCost) break;
      var c = k % A.W, r = (k - c) / A.W;
      if (k !== k0) {
        var val = value(k);
        if (val > 0) { var sc = val / (dk + 2); if (sc > bestScore) { bestScore = sc; bestDir = first[k]; } }
      }
      for (var d = 0; d < 4; d++) {
        if (k === k0 && noBack && p.dir >= 0 && d === opp(p.dir)) continue;
        var nc = c + DIRS[d][0], nr = r + DIRS[d][1];
        if (!A.walk(nc, nr)) continue;
        var nk = A.k(nc, nr), nd = dk + 1 + field(nk);
        if (stamp[nk] === gen && dist[nk] <= nd) continue;
        stamp[nk] = gen; dist[nk] = nd; first[nk] = k === k0 ? d : first[k];
        heap.push(nk, nd);
      }
    }
    return bestDir;
  }

  // Danger field: tiles within radius of each threat cost more, the threat's own tile and the one ahead of it a lot.
  function dangerField(A, threats, radius, weight) {
    var add = new Map();
    function bump(k, v) { add.set(k, (add.get(k) || 0) + v); }
    threats.forEach(function (t) {
      var c = Math.floor(t.x), r = Math.floor(t.y);
      for (var dy = -radius; dy <= radius; dy++) for (var dx = -radius; dx <= radius; dx++) {
        var md = Math.abs(dx) + Math.abs(dy);
        if (md > radius || !A.walk(c + dx, r + dy)) continue;
        bump(A.k(c + dx, r + dy), (radius + 1 - md) * weight);
      }
      bump(A.k(c, r), 400);
      if (t.dir >= 0) { var v = DIRS[t.dir]; bump(A.k(c + v[0], r + v[1]), 250); bump(A.k(c + 2 * v[0], r + 2 * v[1]), 80); }
    });
    return function (k) { return add.get(k) || 0; };
  }

  // A path tile picked at random, at least minD tiles from every point in avoid.
  function randomTile(A, rnd, avoid, minD, ok) {
    for (var tries = 0; tries < 200; tries++) {
      var k = A.paths[Math.floor(rnd() * A.paths.length)], c = k % A.W, r = (k - c) / A.W;
      if (ok && !ok(c, r)) continue;
      var x = c + 0.5, y = r + 0.5, fine = true;
      for (var i = 0; i < (avoid || []).length; i++) if (d2(A, x, y, avoid[i].x, avoid[i].y) < minD * minD) { fine = false; break; }
      if (fine) return { x: x, y: y, c: c, r: r, k: k };
    }
    var k2 = A.paths[0], c2 = k2 % A.W;
    return { x: c2 + 0.5, y: (k2 - c2) / A.W + 0.5, c: c2, r: (k2 - c2) / A.W, k: k2 };
  }

  var Core = { FULL: FULL, DT: DT, DIRS: DIRS, opp: opp, rng: rng, d2: d2, near: near, chomper: chomper, moveChomper: moveChomper,
    pushTrail: pushTrail, ahead: ahead, trainFollow: trainFollow, placeTrain: placeTrain, TRAIN_GAP: TRAIN_GAP, TRAIL_STEP: TRAIL_STEP, ghost: ghost, stepGhost: stepGhost,
    decide: decide, moveGrid: moveGrid, modeAt: modeAt, plan: plan, dangerField: dangerField, randomTile: randomTile };
  if (isNode) module.exports = Core;
  else root.LabCore = Core;
})(typeof self !== 'undefined' ? self : this);
