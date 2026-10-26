'use strict';
// House bots for Chomp's free arena (all CHOSEN): they play like chompers, pressing a direction at each new tile.
//   - a ghost (not blue) or a powered player close by: run, taking the exit that keeps the most room from it
//   - powered: hunt the nearest blue ghost or player within reach
//   - in a paid room: the nearest coin within reach (money on the maze)
//   - otherwise: the nearest dot, energizer or fruit by corridor distance (breadth-first, bounded)
// Each bot has its own slips (sometimes it misses a threat, sometimes it wanders), so they can be caught and beaten.

const R = require('../../shared/chompRules');
const Maze = require('../../shared/chompMaze');
const { opp } = require('../../shared/chompMove');

const DIRS = R.DIRS;
const DANGER = 6;          // tiles: a threat this close is run from
const HUNT = 12;           // tiles: how far a powered bot looks for prey
const SEARCH = 900;        // tiles: the dot search stops after this many
const COIN_SEARCH = 400;   // tiles: how far a paid room's bot looks for coins

function brain(rng) {
  return {
    miss: 0.08 + rng() * 0.17,      // chance to overlook a threat at a decision
    wander: 0.03 + rng() * 0.07,    // chance to take a random exit
    lastK: -1, nextThink: 0,
  };
}

function bfsBuffers(room) {
  if (!room._bfs) {
    const n = room.A.W * room.A.H;
    room._bfs = { mark: new Int32Array(n), first: new Int8Array(n), q: new Int32Array(n), stamp: 0 };
  }
  return room._bfs;
}

// Breadth-first from tile (c, r): the first direction toward the nearest tile goal(k) says yes to, or -1.
function firstStep(room, c, r, goal, limit, avoidBack, backDir) {
  const A = room.A, W = A.W, b = bfsBuffers(room);
  const stamp = ++b.stamp;
  let head = 0, tail = 0;
  const k0 = r * W + c;
  b.mark[k0] = stamp;
  for (let d = 0; d < 4; d++) {
    if (avoidBack && d === backDir) continue;
    const nc = c + DIRS[d][0], nr = r + DIRS[d][1];
    if (!A.walk(nc, nr)) continue;
    const k = nr * W + nc;
    if (b.mark[k] === stamp) continue;
    b.mark[k] = stamp; b.first[k] = d; b.q[tail++] = k;
  }
  while (head < tail && head < limit) {
    const k = b.q[head++];
    if (goal(k)) return b.first[k];
    const kc = k % W, kr = (k - kc) / W;
    for (let d = 0; d < 4; d++) {
      const nc = kc + DIRS[d][0], nr = kr + DIRS[d][1];
      if (!A.walk(nc, nr)) continue;
      const nk = nr * W + nc;
      if (b.mark[nk] === stamp) continue;
      b.mark[nk] = stamp; b.first[nk] = b.first[k]; b.q[tail++] = nk;
    }
  }
  return -1;
}

function threats(room, p) {
  if (p.safe > 0) return [];
  const out = [];
  for (const g of room.ghosts) {
    if (g.state !== 'active' || g.fright > 0) continue;
    if (Math.abs(g.x - p.x) + Math.abs(g.y - p.y) <= DANGER) out.push(g);
  }
  if (p.power <= 0) {
    for (const q of room.players.values()) {
      if (q === p || q.power <= 0 || q.dying || q.over) continue;
      if (Math.abs(q.x - p.x) + Math.abs(q.y - p.y) <= DANGER) out.push(q);
    }
  }
  return out;
}

function think(room, p) {
  const A = room.A, br = p.brain;
  const c = Math.floor(p.x), r = Math.floor(p.y), k = r * A.W + c;
  if (k === br.lastK && p.dir >= 0 && room.tick < br.nextThink) return;
  br.lastK = k;
  br.nextThink = room.tick + 20;
  const rng = room.rng;
  const exits = [];
  for (let d = 0; d < 4; d++) if (A.walk(c + DIRS[d][0], r + DIRS[d][1])) exits.push(d);
  if (!exits.length) return;

  const danger = threats(room, p);
  if (danger.length && rng() > br.miss) {
    let best = exits[0], bestS = -Infinity;
    for (const d of exits) {
      const nx = c + 0.5 + DIRS[d][0] * 2, ny = r + 0.5 + DIRS[d][1] * 2;
      let s = Infinity;
      for (const t of danger) s = Math.min(s, Math.abs(t.x - nx) + Math.abs(t.y - ny));
      if (s > bestS) { bestS = s; best = d; }
    }
    p.want = best;
    return;
  }
  if (rng() < br.wander) { p.want = exits[Math.floor(rng() * exits.length)]; return; }

  if (p.power > R.TICK_HZ) {
    const prey = new Set();
    for (const g of room.ghosts) {
      if (g.state === 'active' && g.fright > R.TICK_HZ && Math.abs(g.x - p.x) + Math.abs(g.y - p.y) <= HUNT) {
        prey.add(Math.floor(g.y) * A.W + Math.floor(g.x));
      }
    }
    for (const q of room.players.values()) {
      if (q === p || q.power > 0 || q.safe > 0 || q.dying || q.over) continue;
      if (Math.abs(q.x - p.x) + Math.abs(q.y - p.y) <= HUNT) prey.add(Math.floor(q.y) * A.W + Math.floor(q.x));
    }
    if (prey.size) {
      const d = firstStep(room, c, r, kk => prey.has(kk), 400, false, -1);
      if (d >= 0) { p.want = d; return; }
    }
  }

  // a paid room's bounty bot goes for coins on the maze first (they are money, chompMoney)
  if (room.money) {
    const d = firstStep(room, c, r, kk => room.money.hasCoinAt(kk), COIN_SEARCH, false, -1);
    if (d >= 0) { p.want = d; return; }
  }

  const fruitAt = new Set();
  for (const m of A.modules) {
    if (room.tick < m.fruitUntil) {
      const fr = m.oy + Math.floor(Maze.FRUIT.y);
      fruitAt.add(fr * A.W + m.ox + Maze.FRUIT.x - 1);
      fruitAt.add(fr * A.W + m.ox + Maze.FRUIT.x);
    }
  }
  const back = p.dir >= 0 ? opp(p.dir) : -1;
  let d = firstStep(room, c, r, kk => room.dots[kk] > 0 || fruitAt.has(kk), SEARCH, true, back);
  if (d < 0) d = firstStep(room, c, r, kk => room.dots[kk] > 0, SEARCH, false, -1);
  if (d < 0) d = p.dir >= 0 && exits.includes(p.dir) ? p.dir : exits[Math.floor(rng() * exits.length)];
  p.want = d;
}

module.exports = { brain, think, firstStep };
