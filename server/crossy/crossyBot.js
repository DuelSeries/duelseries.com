'use strict';
/* ─── The free-table bot: a hopper that looks before it hops ──────────────────
   Only a free table ever gets one (KnockoutLobby never gives a paid table a
   bot), and the screen says it is a bot. It plays the same map by the same
   rules (shared/crossySim.js): at each moment it may hop it tries each move on
   a copy of itself, runs the copy on for a moment with nothing pressed, and
   then once more with each move after that, and takes the move whose future is
   safest, preferring forward.

   IT PLAYS LIKE A PERSON, NOT A MACHINE (Owen 2026-10-28: the old one was
   "absolutely insane, they destroy me instantly"). It looks again only every
   0.17 to 0.4 s, presses 0.08 to 0.17 s after it decided (the traffic has moved
   on by then), plans one hop ahead instead of three, freezes on some looks and
   hops forward without looking on others. The CHOSEN numbers are in SKILL,
   measured with scripts/crossyBotSim.js solo (docs/crossy-reference.md). */

const S = require('../../shared/crossySim');
const { IN } = S;

/* CHOSEN 2026-10-28 evening (Owen: the person-like bot "dies way too easy"; wanted safe and middling). Careful: it plans a
   whole crossing before it leaves the grass, never blind, never frozen, at a steady pace. Solo, the full 5 minutes with
   the duel's ramp, 20 maps (scratch harness, see docs/crossy-reference.md "The bot"): lives 18 / 53 s (p10 / p50),
   116 rows a minute (the old sharp bot: 3 / 17 s and 232 a minute), deaths car 6, eagle 11, log 3. */
const SKILL = {
  careful: true,            // a whole crossing to the next grass or lily before it leaves one (decideCareful)
  think: [3, 6],            // ticks between looks
  react: [0, 0],            // presses what it decided at once
  depth: 3, stand: 36,      // its plain look-ahead, used only when no whole crossing is found
  blunder: 0, freeze: 0,
  pace: [30, 44],           // ticks it waits on the grass after a forward hop (about 1.5 rows a second at most)
  rush: 3,                  // eagle seconds past which it stops waiting
  budget: 600, reach: 10,   // tries and moves the crossing search may spend (a few ms at most a look)
};
// The old bot, kept for the tests that need one that gets far (a lane test drives it 14 rows up the map).
const SHARP = { think: [2, 5], react: [0, 0], depth: 3, stand: 36, blunder: 0.005, freeze: 0 };

class CrossyBot {
  constructor(R, skill) {
    this.R = R;
    this.skill = Object.assign({}, SKILL, skill || {});
    this.nextLook = 0;
    this.queued = 0; this.pressAt = 0;      // a move decided, waiting out the reaction time
    this.lastFwd = -1e9;                    // the tick of its last forward hop (its pace)
  }

  /* The move to press on h's next tick, or 0. */
  input(world, h) {
    if (!h.alive) return IN.NONE;
    // A decided move goes in once its reaction time is up (pressed during a hop's wait, the step keeps it for after).
    if (this.queued && h.tick >= this.pressAt) { const m = this.queued; this.queued = 0; return m; }
    if (this.queued || h.wait > 0 || h.water || h.tick < this.nextLook) return IN.NONE;
    const k = this.skill, [lo, hi] = k.think;
    this.nextLook = h.tick + lo + Math.floor(this.R() * (hi - lo + 1));
    const m = this.decide(world, h);
    if (m === IN.NONE) return IN.NONE;
    const [r0, r1] = k.react;
    const delay = r0 + Math.floor(this.R() * (r1 - r0 + 1));
    if (delay <= 0) return m;
    this.queued = m; this.pressAt = h.tick + delay;
    return IN.NONE;
  }

  decide(world, h) {
    const k = this.skill;
    if (k.careful) return this.decideCareful(world, h);
    if (this.R() < k.freeze && h.eagle < 3.5) return IN.NONE;
    if (this.R() < k.blunder) { const c = after(world, h, IN.FWD, 2); if (c.alive) return IN.FWD; }
    const full = (k.depth - 1) * 6 + 6 + k.stand;     // the least a whole look can last (moves of a wait each, then standing)
    /* Its pace: within `pace` ticks of its last forward hop it would rather stand, if standing is safe, unless the eagle
       is close. So it goes forward at a steady, middling speed and never chains quick hops it does not need. */
    let list = order(world, h);
    const [p0, p1] = k.pace || [0, 0];
    if (h.tick - this.lastFwd < p0 + (this.paceExtra || 0) && h.eagle < (k.rush || 5)) list = [IN.NONE].concat(list.filter((m) => m !== IN.NONE));
    /* The first move (best first) whose best way on lasts the whole look; failing that, the one that lasts longest. */
    let best = IN.NONE, bestLast = -1;
    for (const m of list) {
      const c = after(world, h, m);
      if (m !== IN.NONE && c.hops === h.hops && c.alive) continue;   // that way is blocked: not a move
      const last = c.alive ? (c.tick - h.tick) + wayOn(world, c, k.depth - 1, k.stand) : c.tick - h.tick - 100;
      if (last >= full) return this.took(m, h, p0, p1);
      if (last > bestLast) { bestLast = last; best = m; }
    }
    return this.took(best, h, p0, p1);
  }

  /* CAREFUL (the free-table bot since 2026-10-28 evening, Owen: "dies way too easy", wanted safe and middling).
     Standing on grass or a lily it waits out its pace, then leaves only along a whole crossing it has found to the next
     grass or lily (hops and waits, each checked tick by tick, ending on a cell safe to stand on); with none it waits on
     the grass for a gap, until the eagle is close. Off the grass it follows such a crossing from where it is; failing
     one, the safest move it can see. */
  decideCareful(world, h) {
    const k = this.skill;
    const [p0, p1] = k.pace || [0, 0];
    const rush = h.eagle >= (k.rush || 3.5);
    if (haven(world, h)) {
      if (!rush && h.tick - this.lastFwd < p0 + (this.paceExtra || 0)) return IN.NONE;
      // Through the trees first: the way round them over the grass (nothing moves there) to the next lane that is not
      // grass, or 4 rows on; only a hop up out of the grass is the crossing's to judge (pockets in the trees are a trap).
      const e = maze(world, h);
      if (e !== null && e !== IN.FWD) return this.took(e, h, p0, p1);
      if (e === null) {
        // A pocket in the trees with traffic behind: back out over it, to grass that leads on.
        const out = crossing(world, h, k.budget || 400, k.reach || 10, true);
        if (out !== null) return this.took(out, h, p0, p1);
      }
      const m = crossing(world, h, k.budget || 400, k.reach || 10);
      if (m !== null && (e === null || m === IN.FWD)) return this.took(m, h, p0, p1);
      if (!rush) return IN.NONE;
    } else {
      const m = crossing(world, h, k.budget || 400, k.reach || 10);
      if (m !== null) return this.took(m, h, p0, p1);
    }
    // No whole crossing: the safest move it can see (the plain look-ahead), never into a pocket of trees.
    const full = (k.depth - 1) * 6 + 6 + k.stand;
    let best = IN.NONE, bestLast = -1;
    for (const m of order(world, h)) {
      const c = after(world, h, m);
      if (m !== IN.NONE && c.hops === h.hops && c.alive) continue;
      const pocket = m !== IN.NONE && c.alive && c.r !== h.r && haven(world, c) && world.row(c.r).kind === 'grass' && maze(world, c) === null;
      const last = (c.alive ? (c.tick - h.tick) + wayOn(world, c, k.depth - 1, k.stand) : c.tick - h.tick - 100) - (pocket ? 200 : 0);
      if (last >= full) return this.took(m, h, p0, p1);
      if (last > bestLast) { bestLast = last; best = m; }
    }
    return this.took(best, h, p0, p1);
  }

  took(m, h, p0, p1) {
    if (m === IN.FWD) { this.lastFwd = h.tick; this.paceExtra = Math.floor(this.R() * (p1 - p0 + 1)); }
    return m;
  }
}

/* The moves worth trying, best first: forward; then sideways toward the nearest gap in the row ahead when forward
   is blocked, or waiting when it is not (unless the eagle is close); then back. */
function order(world, h) {
  const ahead = world.row(h.r + 1);
  const x = Math.round(h.x);
  let toward = x > 0 ? -1 : 1;
  if (S.blocked(ahead, x)) {
    for (let k = 1; k <= 8; k++) {
      if (!S.blocked(ahead, x - k) && x - k >= -4) { toward = -1; break; }
      if (!S.blocked(ahead, x + k) && x + k <= 4) { toward = 1; break; }
    }
    const side = toward < 0 ? [IN.LEFT, IN.RIGHT] : [IN.RIGHT, IN.LEFT];
    return [side[0], IN.FWD, IN.NONE, side[1], IN.BACK];
  }
  const side = toward < 0 ? [IN.LEFT, IN.RIGHT] : [IN.RIGHT, IN.LEFT];
  return h.eagle > 3.6 ? [IN.FWD, side[0], side[1], IN.NONE, IN.BACK] : [IN.FWD, IN.NONE, side[0], side[1], IN.BACK];
}

/* A copy of h after pressing m, run on to the next moment it could move again (a wait is a third of a hop). */
function after(world, h, m, cap) {
  const c = S.copyHopper(h);
  S.step(world, c, m);
  const n = cap || (m === IN.NONE ? 6 : 40);
  for (let i = 1; i < n && c.alive && (i < 2 || c.wait > 0 || c.water || (c.pend && i < 12)); i++) S.step(world, c, IN.NONE);
  return c;
}

/* How many ticks the best way on from c lives: `depth` more moves, then standing still for up to STAND ticks. */
function wayOn(world, c, depth, stand) {
  if (depth <= 0) {
    const n = S.copyHopper(c);
    let i = 0;
    for (; i < stand && n.alive; i++) S.step(world, n, IN.NONE);
    return i;
  }
  let most = 0;
  for (const m of order(world, c)) {
    const n = after(world, c, m);
    if (m !== IN.NONE && n.hops === c.hops && n.alive) continue;
    const got = n.alive ? (n.tick - c.tick) + wayOn(world, n, depth - 1, stand) : n.tick - c.tick;
    if (got > most) most = got;
    if (got >= (depth - 1) * 6 + stand + 6 && n.alive) return got;
  }
  return most;
}

/* The first move of the shortest way through the trees, over grass rows only, from h to the first open cell of the
   next lane that is not grass, or of the row 4 on (a breadth-first search over the cells from 3 rows behind), or null. */
function maze(world, h) {
  const r0 = h.r - 3, r1 = h.r + 4, key = (x, r) => (r - r0) * 9 + x + 4;
  const sx = Math.round(h.x), first = new Map([[key(sx, h.r), 0]]), q = [[sx, h.r]];
  const steps = [[0, 1, IN.FWD], [-1, 0, IN.LEFT], [1, 0, IN.RIGHT], [0, -1, IN.BACK]];
  while (q.length) {
    const [x, r] = q.shift(), f0 = first.get(key(x, r));
    for (const [dx, dr, m] of steps) {
      const nx = x + dx, nr = r + dr;
      if (nr < r0 || nr > r1 || Math.abs(nx) > 4 || first.has(key(nx, nr))) continue;
      const row = world.row(nr);
      if (S.blocked(row, nx)) continue;
      if (nr === r1 || (nr > h.r && row && row.kind !== 'grass')) return f0 || m;
      if (!row || row.kind !== 'grass') continue;
      first.set(key(nx, nr), f0 || m);
      q.push([nx, nr]);
    }
  }
  return null;
}

/* Grass or a lily, with nothing on it to hit: a cell to stand on as long as it likes (the eagle aside). */
function haven(world, h) {
  if (!h.alive || h.water || h.log >= 0) return false;
  const row = world.row(h.r);
  return !!row && (row.kind === 'grass' || (row.type === 'lily' && h.lily));
}
// Alive standing still for n ticks.
function standsFor(world, c, n) {
  const t = S.copyHopper(c);
  for (let i = 0; i < n && t.alive; i++) S.step(world, t, IN.NONE);
  return t.alive;
}
/* The first move of a crossing from h to a haven further up the map: a depth-first search over hop forward, wait a
   moment, hop left, hop right, each stepped tick by tick on a copy, the end a haven it can stand on for half a second.
   At most `budget` tries and `reach` moves; null when there is none within them. */
function crossing(world, h, budget, reach, back) {
  let tries = 0;
  // A haven further up (or, backing out of a pocket, anywhere off this row) that is no pocket itself: grass the trees let
  // it walk on from (maze), or a lily.
  const goal = (c) => (back ? c.r !== h.r : c.r > h.r) && haven(world, c) && standsFor(world, c, 30)
    && (world.row(c.r).kind !== 'grass' || maze(world, c) !== null);
  const moves = back ? [IN.BACK, IN.NONE, IN.LEFT, IN.RIGHT, IN.FWD] : [IN.FWD, IN.NONE, IN.LEFT, IN.RIGHT];
  function dfs(c, depth, lastWait) {
    if (depth >= reach || tries > budget) return false;
    for (const m of moves) {
      // Waits up to 4 moments in a row (2/3 s); on a log up to 10 (it may need to drift to a lily or a gap).
      if (m === IN.NONE && lastWait > (c.log >= 0 ? 9 : 3)) continue;
      if (++tries > budget) return false;
      const n = after(world, c, m);
      if (!n.alive) continue;
      if (m !== IN.NONE && n.hops === c.hops) continue;              // blocked
      if (goal(n)) return true;
      if (dfs(n, depth + 1, m === IN.NONE ? lastWait + 1 : 0)) return true;
    }
    return false;
  }
  for (const m of back ? [IN.BACK, IN.LEFT, IN.RIGHT] : [IN.FWD, IN.LEFT, IN.RIGHT, IN.NONE]) {
    if (++tries > budget) break;
    const n = after(world, h, m);
    if (!n.alive || (m !== IN.NONE && n.hops === h.hops)) continue;
    if (m === IN.NONE && haven(world, h)) continue;                   // on grass, waiting is the caller's choice
    if (goal(n) || dfs(n, 1, m === IN.NONE ? 1 : 0)) return m;
  }
  return null;
}

module.exports = { CrossyBot, SKILL, SHARP };
