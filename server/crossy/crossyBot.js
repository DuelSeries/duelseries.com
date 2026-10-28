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

const SKILL = {
  think: [10, 24],          // ticks between looks (0.17-0.4 s, a person's reaction; was 2-5, a machine's)
  react: [5, 10],           // ticks from deciding to pressing (0.08-0.17 s): it acts on what it saw, not what is there
  depth: 1,                 // hops looked ahead (was 3)
  stand: 24,                // ticks it checks standing still after them (was 36)
  blunder: 0.04,            // a look that hops forward checking only the next moment (was 0.005)
  freeze: 0.1,              // a look that does nothing: a hesitation
};
// The old bot, kept for the tests that need one that gets far (a lane test drives it 14 rows up the map).
const SHARP = { think: [2, 5], react: [0, 0], depth: 3, stand: 36, blunder: 0.005, freeze: 0 };

class CrossyBot {
  constructor(R, skill) {
    this.R = R;
    this.skill = Object.assign({}, SKILL, skill || {});
    this.nextLook = 0;
    this.queued = 0; this.pressAt = 0;      // a move decided, waiting out the reaction time
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
    if (this.R() < k.freeze && h.eagle < 3.5) return IN.NONE;
    if (this.R() < k.blunder) { const c = after(world, h, IN.FWD, 2); if (c.alive) return IN.FWD; }
    const full = (k.depth - 1) * 6 + 6 + k.stand;     // the least a whole look can last (moves of a wait each, then standing)
    /* The first move (best first) whose best way on lasts the whole look; failing that, the one that lasts longest. */
    let best = IN.NONE, bestLast = -1;
    for (const m of order(world, h)) {
      const c = after(world, h, m);
      if (m !== IN.NONE && c.hops === h.hops && c.alive) continue;   // that way is blocked: not a move
      const last = c.alive ? (c.tick - h.tick) + wayOn(world, c, k.depth - 1, k.stand) : c.tick - h.tick - 100;
      if (last >= full) return m;
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

module.exports = { CrossyBot, SKILL, SHARP };
