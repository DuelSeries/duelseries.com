'use strict';
// Chomp's arena grows and shrinks with the crowd (Owen 2026-10-26: "add blocks where nobody is", starting at 2 x 2).
// The arena is a torus of maze modules (shared/chompMaze.js wrap). A resize adds or removes one whole column (or row)
// of modules, and never moves anybody:
//
//   1. pick the seam: for a new column, the module boundary farthest (the short way round) from every person; for a
//      removed column, the module column with no person in it and the most room round it. Every person must be at
//      least SEAM_CLEAR tiles from it, so it happens off to the side of everybody's screen; else nothing changes this
//      time. Bots do not watch: one standing in a removed column is put back on the maze elsewhere (as a respawn).
//   2. turn the torus so that seam is its edge: every position and tile moves by the same shift (x -> x - shift, round
//      the old width), which changes nothing anybody sees, only the numbers.
//   3. cut or add at the edge: a new column of modules (its dots, its four ghosts in their house) goes after the last
//      one; a removed column is the last one, its ghosts go with it, a ghost of another module standing in it goes
//      back to its own house, and every coin lying in it moves to the nearest path tile outside it (coins are money:
//      moved, never dropped, so the bank's books do not change).
//   4. tell the pages: c:arena { axis, shift, mx, my, dots, coins, fruit, gmap }, before the next snapshot.
//
// plan(room) -> { axis, op, seam } or null; apply(room, plan) -> the c:arena message (or null when it cannot).

const R = require('../../shared/chompRules');
const Maze = require('../../shared/chompMaze');
const Ghosts = require('./chompGhosts');

const SPAN_X = Maze.MW + Maze.GAP;
const SPAN_Y = Maze.MH + Maze.GAP;
// the snapshot carries positions in 1/64 tile as int16 (shared/chompWire.js): no axis may pass 511 tiles
const WIRE_TILES = 511;

function mod(a, n) { return ((a % n) + n) % n; }

// The module count the crowd asks for: PLAYERS_PER_MODULE chompers a module, at least 2 x 2.
function wantModules(n) {
  return Math.max(4, Math.min(R.MODULES_MAX, Math.ceil(n / R.PLAYERS_PER_MODULE)));
}

// Every chomper in play (people and bots, the dying too): the crowd the size follows.
function chompers(room) {
  const out = [];
  for (const p of room.players.values()) if (!p.over) out.push(p);
  return out;
}

// Who must not see a resize: the people (a paid seat away from its page included; bots do not watch).
function watchers(room) {
  return chompers(room).filter((p) => !p.bot);
}

// The shortest distance from position v to the band [b0, b1) on a ring of length n (0 inside it).
function bandDist(v, b0, b1, n) {
  const len = b1 - b0;
  const t = mod(v - b0, n);
  if (t < len) return 0;
  return Math.min(t - len, n - t);
}

// Grow or shrink, which axis first, and where. The grid stays near square: a column is added while it is not wider
// than tall (in modules), a row otherwise; removal the other way round. The other axis is the fallback.
function plan(room) {
  const A = room.A;
  if (!A.wrap) return null;
  const n = chompers(room).length;
  const list = watchers(room);
  const M = A.mx * A.my;
  const want = wantModules(n);
  let op = 0;
  if (want > M) op = 1;
  else if (M > 4) op = -1;
  if (!op) return null;
  const axes = op > 0 ? (A.mx <= A.my ? ['x', 'y'] : ['y', 'x']) : (A.mx > A.my ? ['x', 'y'] : ['y', 'x']);
  for (const axis of axes) {
    const m = axis === 'x' ? A.mx : A.my, other = axis === 'x' ? A.my : A.mx;
    const after = (m + op) * other;
    if (op < 0) {
      if (m <= 2) continue;
      // shrink only with room to spare on THIS axis (PLAYERS_PER_MODULE x the smaller grid, less 2): no flapping
      if (n > after * R.PLAYERS_PER_MODULE - 2) continue;
    } else {
      if (after > R.MODULES_MAX) continue;
      if ((m + 1) * (axis === 'x' ? SPAN_X : SPAN_Y) > WIRE_TILES) continue;   // the wire's reach
      if (m + 1 > other + 1) continue;                                         // the grid stays near square
    }
    const span = axis === 'x' ? SPAN_X : SPAN_Y, len = axis === 'x' ? A.W : A.H;
    let best = -1, bestD = -1;
    for (let s = 0; s < m; s++) {
      // grow: the boundary at s * span (a band of width 0); shrink: module s's whole column [s * span, (s + 1) * span)
      const b0 = s * span, b1 = op > 0 ? b0 : b0 + span;
      let d = Infinity;
      for (const p of list) d = Math.min(d, bandDist(axis === 'x' ? p.x : p.y, b0, b1, len));
      if (op < 0 && !ghostsUnseen(room, axis, s, list)) continue;
      if (d > bestD) { bestD = d; best = s; }
    }
    if (best >= 0 && bestD >= R.SEAM_CLEAR) return { axis, op, seam: best };
  }
  return null;
}

// A removed column's own ghosts go with it: true when none of them is where a person could see it go (out of its band
// and within GHOST_SEEN tiles of a person).
const GHOST_SEEN = 20;   // CHOSEN: about half a screen
// Also a ghost of another module standing in the removed band goes home: the same test for it.
function ghostsUnseen(room, axis, s, people) {
  const A = room.A, span = axis === 'x' ? SPAN_X : SPAN_Y, len = axis === 'x' ? A.W : A.H;
  for (const g of room.ghosts) {
    const own = (axis === 'x' ? g.home.i : g.home.j) === s;
    const inBand = bandDist(axis === 'x' ? g.x : g.y, s * span, (s + 1) * span, len) === 0;
    if (own === inBand) continue;   // goes with its column unseen, or stays where it is
    for (const p of people) if (Math.hypot(A.dx(p.x, g.x), A.dy(p.y, g.y)) < GHOST_SEEN) return false;
  }
  return true;
}

// The nearest path tile outside the removed band [cut, len) of the OLD arena (after the turn), by corridor steps
// across the seam. -> [c, r] in the old arena's turned coordinates (the caller wraps them)
function nearestKept(A, axis, c0, r0, keep) {
  const seen = new Set([A.k(c0, r0)]);
  let ring = [[c0, r0]];
  for (let step = 0; step < A.W + A.H && ring.length; step++) {
    const next = [];
    for (const [c, r] of ring) {
      if (keep(c, r)) return [c, r];
      for (const [dc, dr] of R.DIRS) {
        const nc = A.wc(c + dc), nr = A.wr(r + dr), k = A.k(nc, nr);
        if (!A.walk(nc, nr) || seen.has(k)) continue;
        seen.add(k);
        next.push([nc, nr]);
      }
    }
    ring = next;
  }
  return null;
}

// Do it. -> the c:arena message, or null (nothing changed).
function apply(room, pl) {
  const A = room.A, axis = pl.axis, op = pl.op;
  const isX = axis === 'x';
  const span = isX ? SPAN_X : SPAN_Y;
  const mOld = isX ? A.mx : A.my;
  // the turn: the chosen seam (grow) or the chosen module column (shrink: it becomes the last one)
  const shiftM = op > 0 ? pl.seam : pl.seam + 1;
  const shift = shiftM * span;
  const Wo = A.W, Ho = A.H;
  const mx2 = isX ? A.mx + op : A.mx, my2 = isX ? A.my : A.my + op;
  const A2 = Maze.build(mx2, my2, { wrap: true });
  // positions and tiles, old -> new (a shrink's removed band is [len - span, len) after the turn)
  const fx = (x) => (isX ? mod(x - shift, Wo) : x);
  const fy = (y) => (isX ? y : mod(y - shift, Ho));
  const fc = (c) => (isX ? mod(c - shift, Wo) : c);
  const fr = (r) => (isX ? r : mod(r - shift, Ho));
  const cutAt = op < 0 ? (isX ? Wo : Ho) - span : Infinity;   // turned coordinates at or past this are removed
  const removed = (c, r) => (isX ? fc(c) : fr(r)) >= cutAt;

  // modules: old (i, j) -> new, carrying the house, fruit and quartet
  const modMap = new Map();   // old module -> new module (or null: removed)
  for (const m of A.modules) {
    const i2 = isX ? mod(m.i - shiftM, mOld) : m.i;
    const j2 = isX ? m.j : mod(m.j - shiftM, mOld);
    if (i2 >= mx2 || j2 >= my2) { modMap.set(m, null); continue; }
    const m2 = A2.modules[j2 * mx2 + i2];
    m2.house = m.house; m2.fruitCount = m.fruitCount || 0; m2.fruitUntil = m.fruitUntil || 0;
    modMap.set(m, m2);
  }

  // ghosts: kept ones in their old order, then the new modules' quartets; gmap old index -> new index or -1
  const gmap = new Array(room.ghosts.length).fill(-1);
  const ghosts = [];
  for (const g of room.ghosts) {
    const m2 = modMap.get(g.home);
    if (!m2) continue;
    gmap[g.index] = ghosts.length;
    g.index = ghosts.length;
    g.home = m2;
    g.dk = -1;
    if (removed(Math.floor(g.x), Math.floor(g.y))) {
      // a ghost of a kept module standing in the removed band (nobody can see it there): back in its own house
      const s = Maze.GHOST_START.pinky;
      g.x = m2.ox + s.x; g.y = m2.oy + s.y; g.state = 'house'; g.fright = 0; g.plan = -1;
    } else {
      g.x = fx(g.x); g.y = fy(g.y);
    }
    ghosts.push(g);
  }
  for (const m2 of A2.modules) {
    if (!m2.house) {
      m2.fruitCount = 0; m2.fruitUntil = 0;
      ghosts.push(...Ghosts.makeModuleGhosts(m2, ghosts.length));
      m2.house.lastDotTick = room.tick;   // the house timer starts now (DOSSIER: 4 s without a dot), not at tick 0
    } else m2.quartet = [];
  }
  for (const g of ghosts) if (g.home.quartet && !g.home.quartet.includes(g)) g.home.quartet.push(g);
  // a kept module's quartet keeps the arcade's order (Blinky first: Inky's target reads it)
  for (const m2 of A2.modules) m2.quartet.sort((a, b) => a.ki - b.ki);

  // chompers: the same turn (no person is in a removed band: plan() made sure); a bot standing in one goes back on
  // the maze elsewhere once the arena has its new shape (below)
  const moveBots = [];
  for (const p of room.players.values()) {
    if (p.bot && removed(Math.floor(p.x), Math.floor(p.y))) { moveBots.push(p); continue; }
    p.x = fx(p.x); p.y = fy(p.y);
    for (const h of p.hist) { h.x = fx(h.x); h.y = fy(h.y); }
    if (p.pend) { p.pend.c = fc(p.pend.c); p.pend.r = fr(p.pend.r); }
    if (p.brain) p.brain.lastK = -1;
  }

  // dots: kept tiles carried over, a new module's laid fresh
  const dots = new Uint8Array(A2.dot0);
  for (let r = 0; r < Ho; r++) for (let c = 0; c < Wo; c++) {
    if (removed(c, r)) continue;
    const k2 = fr(r) * A2.W + fc(c);
    dots[k2] = A2.dot0[k2] ? room.dots[r * Wo + c] : 0;
  }
  // pellets waiting to come back: their tiles carried, a removed one dropped
  for (const kind of [1, 2]) {
    room.respawnQ[kind] = room.respawnQ[kind].filter((e) => !removed(e.k % Wo, Math.floor(e.k / Wo)))
      .map((e) => ({ k: fr(Math.floor(e.k / Wo)) * A2.W + fc(e.k % Wo), at: e.at }));
  }
  room.dotsGone = []; room.dotsBack = [];   // the page gets every dot in c:arena

  // coins (paid rooms): moved with the turn; one lying in the removed band to the nearest kept path tile
  if (room.money) {
    room.money.bank.remapCoins((coin) => {
      let c = coin.x, r = coin.y;
      if (removed(c, r)) {
        const to = nearestKept(A, axis, c, r, (cc, rr) => !removed(cc, rr));
        if (!to) return null;
        [c, r] = to;
      }
      const c2 = fc(c), r2 = fr(r);
      return { x: c2, y: r2, k: r2 * A2.W + c2 };
    });
    room.money.takeCoinEvents();             // the page gets every coin in c:arena
  }

  // events not sent yet: positions turned, fruit by its new module
  const modIndex = new Map();
  for (const [m, m2] of modMap) if (m2) modIndex.set(m.index, m2.index);
  room.events = room.events.filter((e) => e.k !== 'fruit' || modIndex.has(e.m)).map((e) => {
    if (e.k === 'fruit') return Object.assign({}, e, { m: modIndex.get(e.m) });
    if (typeof e.x === 'number' && typeof e.y === 'number') return Object.assign({}, e, { x: fx(e.x), y: fy(e.y) });
    return e;
  });

  room.A = A2;
  room.dots = dots;
  room.ghosts = ghosts;
  room.layout();
  // a bot from the removed band: back on the maze elsewhere, catchable at once (a bounty bot gets no free shield);
  // one in its death animation simply goes (its coins already lie on the maze)
  for (const b of moveBots) {
    if (b.dying > 0) { room._removeBot(b); continue; }
    room.place(b);
    b.safe = 0;
    room.events.push({ k: 'spawn', id: b.id });
  }
  return {
    axis, shift, mx: mx2, my: my2, tick: room.tick, dots: Buffer.from(dots),
    coins: room.money ? room.money.coins().map((c) => [c.pid, c.k, c.micro]) : [],
    fruit: A2.modules.filter((m) => room.tick < m.fruitUntil).map((m) => m.index),
    gmap,
  };
}

module.exports = { plan, apply, wantModules, bandDist, SPAN_X, SPAN_Y };
