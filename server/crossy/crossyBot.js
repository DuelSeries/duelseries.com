'use strict';
/* ─── The free-table bot: a hopper that plans its crossings ───────────────────
   Only a free table ever gets one (KnockoutLobby never gives a paid table a
   bot), and the screen says it is a bot. It plays the same map by the same
   rules (shared/crossySim.js), and the bot never touches those rules: it only
   chooses what to press.

   MEDIUM AND HARD TO KILL (Owen 2026-10-28: "make it so it doesn't die... like
   medium skill"). On grass or a lily it waits out a steady pace, then plans the
   whole way to the next grass or lily as a timed path (plan, below) and follows
   it. So it almost never dies, and a good player can still out-distance it.
   The CHOSEN numbers are in SKILL, measured with scripts/crossyBotSim.js solo
   (docs/crossy-reference.md "The bot"). */

const S = require('../../shared/crossySim');
const { IN } = S;

/* CHOSEN 2026-10-28 (Owen: "make it so it doesn't die... like medium skill"). It plans whole crossings as timed paths
   (decidePlan) and keeps a pace of about two rows a second (118 a minute). The measured numbers are in
   docs/crossy-reference.md "The bot"; the careful bot before it lived 53 s at the median and never reached 5 minutes. */
const SKILL = {
  plans: true,              // timed paths over the known traffic (decidePlan, plan)
  eagleGoal: 2.5,           // a path should end with the eagle at most this many seconds along
  paceEagle: 1.5,           // it keeps its pace only while the eagle is below this
  careful: true,            // what it does when no path is found (decideCareful)
  think: [3, 6],            // ticks between looks
  react: [0, 0],            // presses what it decided at once
  depth: 3, stand: 36,      // its plain look-ahead, used only when no whole crossing is found
  blunder: 0, freeze: 0,
  pace: [50, 70],           // ticks before it leaves grass or a lily after a forward hop (its middling pace)
  rush: 3,                  // eagle seconds past which it stops waiting for a path
  budget: 600, reach: 10,   // tries and moves the crossing search may spend (a few ms at most a look)
};
// The old bot, kept for the tests that need one that gets far (a lane test drives it 14 rows up the map).
const SHARP = { plans: false, think: [2, 5], react: [0, 0], depth: 3, stand: 36, blunder: 0.005, freeze: 0 };

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
    // A trusted path is followed press by press to its end (the lanes cannot surprise it).
    if (this.path) {
      const p = this.path;
      if (h.tick < p.end) {
        const m = p.at.get(h.tick) || IN.NONE;
        if (m === IN.FWD) this.took(m, h, this.skill.pace[0], this.skill.pace[1]);
        return m;
      }
      this.path = null;
      this.nextLook = h.tick;
      // The way on that was found from here when this path was chosen: kept for now, if no paced path turns up.
      this.next = p.next && p.next.t0 === h.tick ? p.next : null;
      // Still landing (it cannot look yet) and that way on starts now: it goes on along it.
      if (this.next && (h.wait > 1 || h.water) && trustPlan(world, h, this.next)) { const n = this.next; this.next = null; return this.follow(n, h); }
    }
    // A decided move goes in once its reaction time is up (pressed during a hop's wait, the step keeps it for after).
    if (this.queued && h.tick >= this.pressAt) { const m = this.queued; this.queued = 0; return m; }
    // (A planning bot looks on the tick its hop's wait runs out; the step lets that tick's press hop.)
    if (this.queued || h.wait > (this.skill.plans ? 1 : 0) || h.water || h.tick < this.nextLook) return IN.NONE;
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
    if (k.plans) return this.decidePlan(world, h);
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

  /* PLANS (the free-table bot since 2026-10-28, Owen: "make it so it doesn't die... like medium skill"). On grass or a
     lily it waits out its pace, then plans the whole crossing to the next grass or lily as a timed path (plan) and
     follows it; with none it waits for one while the eagle allows. Off the grass (a path that failed its replay) it
     plans to the nearest grass or lily either way; failing everything, the careful bot's own choice. */
  decidePlan(world, h) {
    const k = this.skill;
    const next = this.next && this.next.t0 === h.tick ? this.next : null;
    this.next = null;
    // Found none a moment ago: the lanes have hardly moved, so it looks again a little later (each look is a search).
    if (!next && h.tick < (this.noPathUntil || 0)) return haven(world, h) && h.eagle < k.rush ? IN.NONE : this.decideCareful(world, h);
    this.left = { n: P.LOOK };                 // the nodes this look's searches may spend between them
    if (haven(world, h)) {
      /* Its pace: no hop before `from` (a steady middling speed). Failing a paced path, any path. With none it waits
         here, safe, and looks again; once the eagle is up: the way on found from here when it chose the path that
         brought it (if it starts now), a path to grass or a lily with no way on from there found yet, or back. */
      const from = h.eagle < k.paceEagle ? this.lastFwd + k.pace[0] + (this.paceExtra || 0) : h.tick;
      const rush = h.eagle >= k.rush;
      const p = (from > h.tick && this.findPath(world, h, { from, most: P.LOOK / 2 })) || this.findPath(world, h, {})
        || (rush && ((next && trustPlan(world, h, next) && next) || this.findPath(world, h, { force: true })
          || this.findPath(world, h, { back: true, force: true })));
      if (p) return this.follow(p, h);
      this.noPathUntil = h.tick + (h.eagle < k.rush ? 12 : 6);
      if (h.eagle < k.rush) return IN.NONE;
    } else {
      const p = this.findPath(world, h, { back: true, force: true });
      if (p) return this.follow(p, h);
      this.noPathUntil = h.tick + 6;
    }
    this.fallbacks = (this.fallbacks || 0) + 1;
    return this.decideCareful(world, h);
  }
  findPath(world, h, o) {
    if (this.left.n <= 0) return null;
    const look = o.most ? { n: Math.min(o.most, this.left.n) } : this.left, had = look.n;
    const p = plan(world, h, { eagle: this.skill.eagleGoal, back: !!o.back, from: o.from, force: !!o.force, look });
    if (o.most) this.left.n -= had - look.n;
    if (!p) return null;
    if (!trustPlan(world, h, p)) { this.untrusted = (this.untrusted || 0) + 1; return null; }
    return p;
  }
  follow(p, h) {
    this.path = p;
    const m = p.at.get(h.tick) || IN.NONE;
    if (m === IN.FWD) this.took(m, h, this.skill.pace[0], this.skill.pace[1]);
    return m;
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
      // Out onto the next lane that is not grass (never onto a lily row's open water: that is no way out).
      if (nr > h.r && row && row.type === 'lily' && row.lilies.indexOf(nx) < 0) continue;
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

/* ── THE PLANNER: a whole crossing as a timed path ─────────────────────────────
   Every car, train and log is a closed-form function of the lane clock, so the bot can know where everything will
   be on every tick ahead. plan() is a breadth-first search over (row, column, tick): from where the bot stands it
   tries waiting a moment, or a hop each way, stepped tick by tick, and takes the earliest arrival on grass or a lily
   further up that leads on (a way on from there is found too), with the eagle still low. Off the water it moves on a
   grid against each lane's danger (the columns a car or train covers on a tick, worked out once and kept); on a log
   it rides it by the log's own schedule. The path found is replayed through the real rules (shared/crossySim.js step)
   before the bot trusts it, then followed press by press: the same path, nothing re-guessed on the way. Costs: a
   look is under 1 ms at the median and about 8 ms at the 99th percentile (P.NODES caps it). */
const P = { WAIT: 3, HORIZON: 480, ROWS: 16, NODES: 8000, NESTED: 2500, CHECKS: 6, PUSH: 15, LOOK: 10000 };
const DANGER = new WeakMap();
const NT = S.DUEL.MAX_TICKS + 2 * P.HORIZON;
const CARS_SEEN = [];
// A lane's danger by tick, filled in as it is asked for (null for a lane where standing is never hit).
function dangers(row) {
  if (row.kind !== 'road' && row.kind !== 'rail') return null;
  let a = DANGER.get(row);
  if (!a) { a = new Int16Array(NT).fill(-1); DANGER.set(row, a); }
  return a;
}
// The columns (bit x + 4) where standing on `row` on tick t is hit, by the step's own test (a: dangers(row)).
function danger(row, a, t) {
  if (!a) return 0;
  if (t < NT && a[t] >= 0) return a[t];
  const d = S.laneTime(t);
  let m = 0;
  if (row.kind === 'road') {
    const half = (S.C.PLAYER_W + row.car.hx) / 2;
    for (const cx of S.carsAt(row, d, CARS_SEEN)) for (let x = -4; x <= 4; x++) if (Math.abs(x - cx) < half) m |= 1 << (x + 4);
  } else {
    const tr = S.trainAt(row, d);
    if (tr.cx !== null) {
      const half = (S.C.PLAYER_W + 2 * S.C.TRAIN_HALF) / 2;
      for (let x = -4; x <= 4; x++) if (Math.abs(x - tr.cx) < half) m |= 1 << (x + 4);
    }
  }
  if (t < NT) a[t] = m;
  return m;
}
const isLog = (row) => !!row && row.type === 'log';
const onLily = (row, x) => row.lilies.indexOf(x) >= 0;
const LOGS_SEEN = [];

/* A node: standing ready to hop on tick t at row r, column x (fractional on a log), eagle e, riding log k (or -1).
   Each move below is step() for that case, tick by tick, in step()'s own order and arithmetic, so the eagle and a
   rider's x come out to the same bits (trustPlan checks that against step() itself before a path is used). */
// Standing (or riding) n ticks from node a; null when that is fatal.
function stand(world, a, n) {
  const row = world.row(a.r);
  let e = a.e, x = a.x;
  if (a.k >= 0) {
    for (let i = 0; i < n; i++) {
      const t = a.t + i;
      const now = S.logById(row, a.k, S.laneTime(t)), was = S.logById(row, a.k, S.laneTime(t - 1));
      if (!now || !was) return null;
      x += now.x - was.x;
      e += S.DT;
      if (Math.abs(x) > S.C.EDGE || e > S.C.EAGLE_S) return null;
    }
    return { r: a.r, x, t: a.t + n, e, k: a.k };
  }
  const bit = 1 << (x + 4), dz = dangers(row);
  for (let i = 0; i < n; i++) {
    e += S.DT;
    if (e > S.C.EAGLE_S || (danger(row, dz, a.t + i) & bit)) return null;
  }
  return { r: a.r, x, t: a.t + n, e, k: -1 };
}
/* A hop from node a: undefined when it is not possible there (pressing it would leave it pending), null when fatal,
   else the node once its wait is out (or, landed in the water, once the arc has ended on a log or a lily). */
function hop(world, a, m) {
  const here = world.row(a.r);
  let dx = 0, dr = 0;
  if (m === IN.RIGHT) { if (a.x < S.C.SIDE && !S.blocked(here, a.x + 1)) dx = 1; }
  else if (m === IN.LEFT) { if (a.x > -S.C.SIDE && !S.blocked(here, a.x - 1)) dx = -1; }
  else if (m === IN.FWD) { if (!S.blocked(world.row(a.r + 1), a.x)) dr = 1; }
  else if (m === IN.BACK) { if (a.r >= S.C.BACK_ROW && !S.blocked(world.row(a.r - 1), a.x)) dr = -1; }
  if (!dx && !dr) return undefined;
  const r = a.r + dr, row = world.row(r), t = a.t;
  let x = a.x + dx;
  let e = dr > 0 ? Math.max(0, a.e - 1) : dr < 0 ? a.e + 1 : a.e;
  if (row.kind !== 'water') {
    x = Math.round(x);
    const bit = 1 << (x + 4), dz = dangers(row);
    for (let i = 0; i < S.C.HOP_DELAY; i++) {
      e += S.DT;
      if (e > S.C.EAGLE_S || (danger(row, dz, t + i) & bit)) return null;
    }
    return { r, x, t: t + S.C.HOP_DELAY, e, k: -1 };
  }
  if (row.type === 'lily') {
    // Straight onto a lily, or into the water and onto the lily under it when the arc ends (x is rounded by then).
    let wait = S.C.HOP_DELAY;
    if (!onLily(row, x)) { x = Math.round(x); if (!onLily(row, x)) return null; wait = S.C.WATER_TEST; }
    for (let i = 0; i < wait; i++) { e += S.DT; if (e > S.C.EAGLE_S) return null; }
    return { r, x, t: t + wait, e, k: -1 };
  }
  /* Onto a log row: on the first log in reach, snapped to its cells (landWater); or into the water, where a log that
     comes under it before the arc ends (14 ticks, x rounded by then) still catches it. */
  let on = snapOnto(row, t, x);
  let T = t;
  if (!on) {
    if (dx && a.k >= 0) {
      // step()'s side-hop fudge off a log into the water: pushed on along the log's way.
      const L = S.logById(here, a.k, S.laneTime(t));
      if (L) {
        const v = here.dir * here.speed * (Math.abs(L.x) > S.C.EDGE + L.w / 2 ? S.C.RAPIDS : 1) * S.rampAt(t);
        if ((v < 0 && dx < 0) || (v > 0 && dx > 0)) x += v * (S.C.ARC_ATTACK + S.C.ARC_RELEASE) * 2;
      }
    }
    x = Math.round(x);
    for (let i = 0; i < S.C.WATER_TEST; i++) {
      e += S.DT;
      if (Math.abs(x) > S.C.EDGE || e > S.C.EAGLE_S) return null;
    }
    T = t + S.C.WATER_TEST;
    on = snapOnto(row, T, x);
    if (!on) return null;
    return { r, x: on.x, t: T, e, k: on.k };
  }
  x = on.x;
  for (let i = 0; i < S.C.HOP_DELAY; i++) {
    const now = S.logById(row, on.k, S.laneTime(t + i)), was = S.logById(row, on.k, S.laneTime(t + i - 1));
    if (!now || !was) return null;
    x += now.x - was.x;
    e += S.DT;
    if (Math.abs(x) > S.C.EDGE || e > S.C.EAGLE_S) return null;
  }
  return { r, x, t: t + S.C.HOP_DELAY, e, k: on.k };
}
// landWater's log test at tick t: the first log within reach of x, and x snapped to its cells; or null.
function snapOnto(row, t, x) {
  for (const L of S.logsAt(row, S.laneTime(t), LOGS_SEEN)) {
    if (Math.abs(x - L.x) < (0.05 + L.w + 0.5) / 2) {
      const g = -1.5 + L.w / 2;
      let q = x - L.x + g;
      q -= Math.round(q);
      x -= q;
      const i = Math.round(x - L.x + g + 1), n = Math.round(L.w);
      if (i < 0) x += -i;
      else if (i >= n) x -= n - i + 1;
      return { k: L.k, x };
    }
  }
  return null;
}

// maze() from a grass cell, kept per map (the grass never changes).
const LEADS = new WeakMap();
function leads(world, r, x) {
  let m = LEADS.get(world);
  if (!m) { m = new Map(); LEADS.set(world, m); }
  const k = r * 16 + x + 4;
  let v = m.get(k);
  if (v === undefined) { v = maze(world, { r, x }) !== null; m.set(k, v); }
  return v;
}

/* From a lily, along the lilies it can hop between on its row, a way up: a lily straight ahead, grass that leads on,
   or a lane that moves (whether that lane lets it through is the next path's to find). */
function lilyLeads(world, r, x) {
  const row = world.row(r), up = world.row(r + 1);
  if (!up) return false;
  for (const dir of [-1, 1]) {
    for (let c = x; row.lilies.indexOf(c) >= 0; c += dir) {
      if (up.type === 'lily' ? up.lilies.indexOf(c) >= 0 : up.kind === 'grass' ? !S.blocked(up, c) && leads(world, r + 1, c) : true) return true;
    }
  }
  return false;
}

/* The earliest timed path from h to grass or a lily further up (`back`: anywhere off this row) that leads on and
   leaves the eagle at most `eagle`; failing that, the one there with the lowest eagle (`force`: or one whose way on
   was not found). { at: Map(tick to press), end,
   r, x, e } or null. Only from a moment it may hop (not mid-hop, not in the water). */
function plan(world, h, opt) {
  if (h.wait > 1 || h.water) return null;
  const r0 = h.r, t0 = h.tick, back = !!opt.back, from = opt.from || t0;
  // One allowance of nodes for the whole look, the checks of its goals included (a few ms at most).
  const look = opt.look || { n: Infinity };
  const left = opt.left || { n: Math.min(P.NODES, look.n) }, cap = opt.nested ? Math.max(0, left.n - P.NESTED) : 0, had = left.n;
  const root = { r: h.r, x: h.log >= 0 ? h.x : Math.round(h.x), t: t0, e: h.eagle, k: h.log, parent: null, m: 0 };
  if (h.log < 0 && isLog(world.row(h.r))) return null;
  /* Best first: the node that is earliest once each row made good counts as P.PUSH ticks saved (a hop takes 9), so it
     presses on up the map before it tries every wait behind; backing out of a pocket, plain earliest first. */
  const push = back ? 0 : P.PUSH, open = new Heap();
  const seen = new Map();
  open.add(root, 0);
  let spent = 0, spare = null;
  // A node's place: tick, row and column, or on a log which log and where on it (to 1/64 of a cell).
  const key = (n) => {
    const rt = (n.t - t0) * 64 + (n.r - r0 + 8);
    return n.k >= 0 ? -((rt * 4096 + (n.k & 4095)) * 1024 + Math.round(n.x * 64) + 512) - 1 : rt * 16 + (n.x + 4);
  };
  const add = (n, parent, m) => {
    if (n.t - t0 > P.HORIZON || n.r > r0 + P.ROWS || n.r < r0 - 6) return;
    const k = key(n), old = seen.get(k);
    if (old && old.e <= n.e) return;
    n.parent = parent; n.m = m;
    if (old && !old.done) { Object.assign(old, n); return; }
    seen.set(k, n);
    open.add(n, (n.t - t0) - push * (n.r - r0));
  };
  const goal = (n) => {
    if (n.k >= 0 || n === root || (back ? n.r === r0 : n.r <= r0)) return false;
    const row = world.row(n.r);
    if (!(row.kind === 'grass' || (row.type === 'lily' && onLily(row, n.x)))) return false;
    if (n.e + 0.6 > S.C.EAGLE_S) return false;
    return row.kind === 'grass' ? leads(world, n.r, n.x) : lilyLeads(world, n.r, n.x);
  };
  /* A goal is trusted only if a way on from it is found too (a lily or a patch of grass can be a dead end: no lily
     ahead in reach, logs it cannot catch before the eagle comes). At most P.CHECKS such looks a search. */
  let checks = 0, first = null;
  const leadsOn = (n) => {
    if (opt.nested) return true;
    if (!first) first = n;
    if (checks >= P.CHECKS) return false;
    checks++;
    n.next = plan(world, { wait: 0, water: false, r: n.r, x: n.x, tick: n.t, log: -1, eagle: n.e }, { eagle: S.C.EAGLE_S, nested: true, left });
    return !!n.next;
  };
  const MOVES = [IN.FWD, IN.NONE, IN.LEFT, IN.RIGHT, IN.BACK];
  let found = null;
  while (open.size && left.n > cap) {
    const n = open.pop();
    n.done = true;
    if (goal(n)) {
      if (n.e <= opt.eagle && leadsOn(n)) { found = n; break; }
      if ((!spare || n.e < spare.e) && leadsOn(n)) spare = n;
    }
    spent++;
    left.n--;
    for (const m of MOVES) {
      if (m !== IN.NONE && n.t < from) continue;
      const o = m === IN.NONE ? stand(world, n, P.WAIT) : hop(world, n, m);
      if (o) add(o, n, m);
    }
  }
  if (!opt.nested) look.n -= had - left.n;
  // Grass or a lily with no way on found from it is taken only when nothing better will do (`force`).
  const end = found || spare || (opt.force ? first : null);
  if (!end) return null;
  const at = new Map();
  for (let n = end; n.parent; n = n.parent) if (n.m !== IN.NONE) at.set(n.parent.t, n.m);
  return { at, t0, end: end.t, r: end.r, x: end.x, e: end.e, spent, next: end.next || null };
}
// A binary heap of nodes, least first (ties: the first added).
class Heap {
  constructor() { this.a = []; this.f = []; this.o = []; this.n = 0; }
  get size() { return this.a.length; }
  less(i, j) { return this.f[i] < this.f[j] || (this.f[i] === this.f[j] && this.o[i] < this.o[j]); }
  swap(i, j) {
    const a = this.a, f = this.f, o = this.o;
    let v = a[i]; a[i] = a[j]; a[j] = v;
    v = f[i]; f[i] = f[j]; f[j] = v;
    v = o[i]; o[i] = o[j]; o[j] = v;
  }
  add(v, f) {
    let i = this.a.length;
    this.a.push(v); this.f.push(f); this.o.push(this.n++);
    while (i > 0) { const p = (i - 1) >> 1; if (!this.less(i, p)) break; this.swap(i, p); i = p; }
  }
  pop() {
    const top = this.a[0], last = this.a.length - 1;
    this.swap(0, last); this.a.pop(); this.f.pop(); this.o.pop();
    for (let i = 0; ;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < this.a.length && this.less(l, m)) m = l;
      if (r < this.a.length && this.less(r, m)) m = r;
      if (m === i) break;
      this.swap(i, m); i = m;
    }
    return top;
  }
}

// The path replayed through the real rules: alive, every press a hop, and standing where it said at the end.
function trustPlan(world, h, p) {
  const c = S.copyHopper(h);
  c.got = [];
  while (c.tick < p.end && c.alive) {
    const m = p.at.get(c.tick) || IN.NONE, hops = c.hops;
    S.step(world, c, m);
    if (m !== IN.NONE && c.hops !== hops + 1) return false;
  }
  return c.alive && c.tick === p.end && c.r === p.r && c.x === p.x && standsFor(world, c, 20);
}

module.exports = { CrossyBot, SKILL, SHARP, P, plan, trustPlan };
