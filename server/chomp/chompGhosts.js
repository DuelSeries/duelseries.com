'use strict';
// Chomp's ghosts: the arcade's four personalities, one quartet per maze module (DOSSIER Chapter 4).
//
// On the grid a ghost only decides at a tile centre: it never reverses on its own, picks among the open exits the one
// whose next tile is closest (straight line) to its target tile, and breaks ties up, left, down, right. A forced
// reversal (scatter <-> chase, or turning blue) flips it at once. Frightened, it picks a random exit (PRNG) and, if that
// one is a wall or back the way it came, tries the next one clockwise. Eaten, its eyes run back to the house door,
// drop in, and it comes straight back out.
//
// Targets (ARENA: "Pac-Man" is the nearest player within GHOST_SENSE tiles who is not blinking safe; with nobody near,
// a ghost heads for its scatter corner):
//   Blinky  the player's tile
//   Pinky   four tiles ahead of the player (moving up: four up AND four left, the arcade's overflow bug)
//   Inky    two tiles ahead of the player (moving up: also two left), then that vector from his module's Blinky doubled
//   Clyde   the player's tile while eight tiles or more away, else his scatter corner

const R = require('../../shared/chompRules');
const Maze = require('../../shared/chompMaze');
const { opp } = require('../../shared/chompMove');

const DIRS = R.DIRS;
const KINDS = ['blinky', 'pinky', 'inky', 'clyde'];
const STATE = { active: 0, house: 1, leaving: 2, eyes: 3, entering: 4 };
const CLOCKWISE = [0, 3, 2, 1];          // up, right, down, left
const EPS = 1e-7;

function makeGhosts(A) {
  const ghosts = [];
  for (const m of A.modules) {
    m.quartet = [];
    KINDS.forEach((kind, ki) => {
      const s = Maze.GHOST_START[kind];
      const g = {
        index: ghosts.length, kind, ki, home: m,
        x: m.ox + s.x, y: m.oy + s.y,
        dir: 1,                              // DOSSIER: ghosts move left once outside
        state: kind === 'blinky' ? 'active' : 'house',
        bob: ki % 2 ? 0 : 2,                 // house bobbing: up first or down first
        fright: 0, reverse: false, dk: -1, plan: -1,
      };
      ghosts.push(g);
      m.quartet.push(g);
    });
    m.house = { dots: 0, lastDotTick: 0 };
  }
  return ghosts;
}

function scatterTile(g) {
  const s = Maze.SCATTER[g.kind];
  return [g.home.ox + s[0], g.home.oy + s[1]];
}

function aheadTile(p, n) {
  const c = Math.floor(p.x), r = Math.floor(p.y);
  const d = p.face >= 0 ? p.face : 1;
  const v = DIRS[d];
  let tx = c + v[0] * n, ty = r + v[1] * n;
  if (d === 0) tx -= n;                    // DOSSIER: the up-direction overflow bug
  return [tx, ty];
}

function targetFor(g, room, mode) {
  if (g.state === 'eyes') return [g.home.ox + Maze.HOUSE.doorX - 1, g.home.oy + Math.floor(Maze.HOUSE.outY)];
  if (mode === 'scatter') return scatterTile(g);
  const p = room.nearestPrey(g.x, g.y, R.GHOST_SENSE);
  if (!p) return scatterTile(g);
  const pc = Math.floor(p.x), pr = Math.floor(p.y);
  if (g.kind === 'blinky') return [pc, pr];
  if (g.kind === 'pinky') return aheadTile(p, R.PINKY_AHEAD);
  if (g.kind === 'inky') {
    const piv = aheadTile(p, R.INKY_AHEAD);
    const b = g.home.quartet[0];
    const bc = Math.floor(b.x), br = Math.floor(b.y);
    return [2 * piv[0] - bc, 2 * piv[1] - br];
  }
  const dx = Math.floor(g.x) - pc, dy = Math.floor(g.y) - pr;
  if (dx * dx + dy * dy >= R.CLYDE_NEAR * R.CLYDE_NEAR) return [pc, pr];
  return scatterTile(g);
}

// ARENA: eyes run home along the shortest corridor path (a distance field from their house door, built once per
// module). The arcade's eyes aim at the door by straight-line distance like any target, which its own maze is laid out
// for; in a tiled arena that greedy rule can circle a block for ever, and eyes that never get home leave the module
// short a ghost. Eyes may turn back when home is behind them.
function homeField(A, m) {
  if (m.homeField) return m.homeField;
  const W = A.W, f = new Int32Array(W * A.H).fill(-1), q = [];
  const r = m.oy + Math.floor(Maze.HOUSE.outY);
  for (const c of [m.ox + Maze.HOUSE.doorX - 1, m.ox + Maze.HOUSE.doorX]) { f[r * W + c] = 0; q.push(r * W + c); }
  for (let h = 0; h < q.length; h++) {
    const k = q[h], kc = k % W, kr = (k - kc) / W;
    for (const [dx, dy] of DIRS) {
      const nc = kc + dx, nr = kr + dy;
      if (!A.walk(nc, nr) || f[nr * W + nc] >= 0) continue;
      f[nr * W + nc] = f[k] + 1;
      q.push(nr * W + nc);
    }
  }
  m.homeField = f;
  return f;
}

// The exit a ghost takes at the centre of tile (c, r).
function decide(g, A, room, c, r) {
  const back = opp(g.dir);
  if (g.state === 'eyes') {
    const f = homeField(A, g.home);
    let best = back, bestD = Infinity;
    for (let d = 0; d < 4; d++) {
      const nc = c + DIRS[d][0], nr = r + DIRS[d][1];
      if (!A.walk(nc, nr)) continue;
      const v = f[nr * A.W + nc];
      if (v >= 0 && v < bestD) { bestD = v; best = d; }
    }
    return best;
  }
  if (g.fright > 0 && g.state === 'active') {
    let start = CLOCKWISE.indexOf(Math.floor(room.rng() * 4));
    for (let k = 0; k < 4; k++) {
      const d = CLOCKWISE[(start + k) % 4];
      if (d === back) continue;
      if (A.walk(c + DIRS[d][0], r + DIRS[d][1])) return d;
    }
    return back;
  }
  const t = targetFor(g, room, room.mode);
  let best = -1, bestD = Infinity;
  for (let d = 0; d < 4; d++) {
    if (d === back) continue;
    const nc = c + DIRS[d][0], nr = r + DIRS[d][1];
    if (!A.walk(nc, nr)) continue;
    const dx = nc - t[0], dy = nr - t[1], dd = dx * dx + dy * dy;
    if (dd < bestD) { bestD = dd; best = d; }
  }
  return best >= 0 ? best : back;
}

function speedOf(g, A) {
  if (g.state === 'eyes' || g.state === 'entering') return R.speed(R.GHOST_EYES_SPEED);
  if (g.state === 'house' || g.state === 'leaving') return R.speed(R.GHOST_HOUSE_SPEED);
  if (A.tunnel(Math.floor(g.x), Math.floor(g.y))) return R.speed(R.GHOST_TUNNEL_SPEED);
  if (g.fright > 0) return R.speed(R.GHOST_FRIGHT_SPEED);
  return R.speed(R.GHOST_SPEED);
}

function toward(v, t, step) {
  if (v < t) return Math.min(t, v + step);
  if (v > t) return Math.max(t, v - step);
  return v;
}

function step(g, A, room, dt) {
  if (g.fright > 0) g.fright--;
  let rem = speedOf(g, A) * dt;
  const H = Maze.HOUSE, ox = g.home.ox, oy = g.home.oy;
  if (g.state === 'house') {
    // bob between half a tile above and below the middle row
    const lo = oy + H.inY - 0.5, hi = oy + H.inY + 0.5;
    g.dir = g.bob;
    if (g.bob === 0) { g.y -= rem; if (g.y <= lo) { g.y = lo; g.bob = 2; } }
    else { g.y += rem; if (g.y >= hi) { g.y = hi; g.bob = 0; } }
    return;
  }
  if (g.state === 'leaving') {
    const dx = ox + H.doorX;
    if (Math.abs(g.x - dx) > EPS) { g.dir = g.x < dx ? 3 : 1; g.x = toward(g.x, dx, rem); return; }
    if (Math.abs(g.y - (oy + H.inY)) > EPS && g.y > oy + H.inY) { g.dir = 0; g.y = toward(g.y, oy + H.inY, rem); return; }
    g.dir = 0;
    g.y = toward(g.y, oy + H.outY, rem);
    if (Math.abs(g.y - (oy + H.outY)) <= EPS) { g.state = 'active'; g.dir = 1; g.dk = -1; g.reverse = false; g.plan = -1; }
    return;
  }
  if (g.state === 'entering') {
    const dx = ox + H.doorX;
    if (Math.abs(g.x - dx) > EPS) { g.dir = g.x < dx ? 3 : 1; g.x = toward(g.x, dx, rem); return; }
    g.dir = 2;
    g.y = toward(g.y, oy + H.inY, rem);
    if (Math.abs(g.y - (oy + H.inY)) <= EPS) { g.state = 'leaving'; g.fright = 0; }
    return;
  }
  // active or eyes: on the grid
  for (let guard = 0; guard < 4 && rem > EPS; guard++) {
    if (g.reverse) { g.reverse = false; if (g.state === 'active') { g.dir = opp(g.dir); g.dk = -1; g.plan = -1; } }
    const c = Math.floor(g.x), r = Math.floor(g.y), k = r * A.W + c;
    const cx = c + 0.5, cy = r + 0.5, v = DIRS[g.dir];
    const along = (cx - g.x) * v[0] + (cy - g.y) * v[1];
    const atCentre = along >= -EPS && along <= rem && (along > EPS || g.dk !== k);
    if (atCentre) {
      g.x = cx; g.y = cy; rem -= Math.max(0, along); g.dk = k;
      if (g.state === 'eyes' && r === oy + Math.floor(H.outY) && (c === ox + H.doorX - 1 || c === ox + H.doorX)) {
        g.state = 'entering';
        return;
      }
      // DOSSIER Chapter 3, "Looking Ahead": a ghost chooses its exit from the NEXT tile as it arrives in this one, and
      // its eyes point that way before it turns (jspacman Ghost.js). The plan made one tile back is the move now.
      const back = opp(g.dir), pd = g.plan;
      g.dir = pd >= 0 && pd !== back && A.walk(c + DIRS[pd][0], r + DIRS[pd][1]) ? pd : decide(g, A, room, c, r);
      const nc = c + DIRS[g.dir][0], nr = r + DIRS[g.dir][1];
      g.plan = A.walk(nc, nr) ? decide(g, A, room, nc, nr) : -1;
      continue;
    }
    g.x += v[0] * rem; g.y += v[1] * rem; rem = 0;
  }
}

// Ghosts leave the house one at a time, Pinky, Inky, Clyde, on the module's dot count or after HOUSE_TIMER_S without
// a dot eaten in the module (DOSSIER Chapter 4).
function releaseHouses(A, room) {
  for (const m of A.modules) {
    const waiting = m.quartet.find(g => g.state === 'house');
    if (!waiting) continue;
    const limit = R.HOUSE_DOT_LIMIT[waiting.kind] || 0;
    const idle = room.tick - m.house.lastDotTick >= R.HOUSE_TIMER_S * R.TICK_HZ;
    if (m.house.dots >= limit || idle) {
      waiting.state = 'leaving';
      m.house.lastDotTick = room.tick;
    }
  }
}

module.exports = { KINDS, STATE, makeGhosts, step, decide, targetFor, releaseHouses, scatterTile };
