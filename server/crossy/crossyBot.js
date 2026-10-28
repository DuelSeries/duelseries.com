'use strict';
/* ─── The free-table bot: a hopper that looks before it hops ──────────────────
   Only a free table ever gets one (KnockoutLobby never gives a paid table a
   bot), and the screen says it is a bot. It plays the same map by the same
   rules (shared/crossySim.js): at each moment it may hop it tries each move on
   a copy of itself, runs the copy on for a moment with nothing pressed, and
   then once more with each move after that, and takes the move whose future is
   safest, preferring forward. Like a person it hesitates (it only looks again
   every few ticks) and now and then it hops without looking, so it can be
   beaten; scripts/crossyBotSim.js measures how long it lasts. */

const S = require('../../shared/crossySim');
const { IN } = S;

const STAND = 36;           // and then standing still this long
const FULL = 2 * 6 + 6 + STAND; // the least a whole look can last (three moves of at least a wait each, then standing)
const DEPTH = 3;            // hops looked ahead: a move is taken only if some way on from it stays alive this long
const SKILL = {
  think: [2, 5],            // ticks between looks while it waits (measured: alone it lasts 30 s median, 65 s p90)
  blunder: 0.005,           // chance a look hops forward checking only the next moment, not the way on
};

class CrossyBot {
  constructor(R, skill) {
    this.R = R;
    this.skill = Object.assign({}, SKILL, skill || {});
    this.nextLook = 0;
  }

  /* The move to press on h's next tick, or 0. */
  input(world, h) {
    if (!h.alive || h.wait > 0 || h.water) return IN.NONE;
    if (h.tick < this.nextLook) return IN.NONE;
    const [lo, hi] = this.skill.think;
    this.nextLook = h.tick + lo + Math.floor(this.R() * (hi - lo + 1));
    if (this.R() < this.skill.blunder) { const c = after(world, h, IN.FWD, 2); if (c.alive) return IN.FWD; }
    /* The first move (best first) whose best way on lasts the whole look; failing that, the one that lasts longest. */
    let best = IN.NONE, bestLast = -1;
    for (const m of order(world, h)) {
      const c = after(world, h, m);
      if (m !== IN.NONE && c.hops === h.hops && c.alive) continue;   // that way is blocked: not a move
      const last = c.alive ? (c.tick - h.tick) + wayOn(world, c, DEPTH - 1) : c.tick - h.tick - 100;
      if (last >= FULL) return m;
      if (last > bestLast) { bestLast = last; best = m; }
    }
    return best;
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
function wayOn(world, c, depth) {
  if (depth <= 0) {
    const n = S.copyHopper(c);
    let i = 0;
    for (; i < STAND && n.alive; i++) S.step(world, n, IN.NONE);
    return i;
  }
  let most = 0;
  for (const m of order(world, c)) {
    const n = after(world, c, m);
    if (m !== IN.NONE && n.hops === c.hops && n.alive) continue;
    const got = n.alive ? (n.tick - c.tick) + wayOn(world, n, depth - 1) : n.tick - c.tick;
    if (got > most) most = got;
    if (got >= (depth - 1) * 6 + STAND + 6 && n.alive) return got;
  }
  return most;
}

module.exports = { CrossyBot, SKILL };
