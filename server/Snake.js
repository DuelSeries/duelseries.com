const C = require('../shared/constants');

// slither.io's own skin palette, taken from their rrs[]/ggs[]/bbs[] arrays.
// These are the plain solid colours a player can pick (their `csks` list minus
// the patterned/special skins). Full 42-entry set in
// snake-design/slither-palette.json.
const COLORS = [
  '#c080ff', '#9099ff', '#80d0d0', '#80ff80', '#eeee70',
  '#ffa060', '#ff9090', '#ff4040', '#e030e0', '#ffc050',
  '#288860', '#6475ff', '#4854ff', '#a050ff', '#ffe040',
  '#4e23c0', '#ff5609', '#65c8e8', '#3cc048', '#00ff53',
  '#d94545', '#2020f0', '#f02020', '#f0f020', '#f09020',
  '#f020f0', '#20f020', '#6880ff', '#6828aa', '#8080ff',
];

// Palette entries the shop offers as skins but that aren't in the random pool
// above. Also slither colours (index 11 of snake-design/slither-palette.json).
const SKIN_ONLY_COLORS = ['#505050'];

// The colour arrives from the CLIENT (PLAY sends whatever skin is equipped), and
// nothing used to check it — a modified client could play any colour at all,
// including near-invisible black. Everything a snake may be is a slither palette
// entry, so anything else is rejected and falls back to a random palette colour.
const ALLOWED_COLORS = new Set([...COLORS, ...SKIN_ONLY_COLORS].map(c => c.toLowerCase()));

function sanitizeColor(color) {
  if (typeof color !== 'string') return null;
  const c = color.trim().toLowerCase();
  return ALLOWED_COLORS.has(c) ? c : null;
}

const SUBDIV = C.SNAKE_CHAIN_SUBDIV;   // chain points per body part
const MIN_SEGMENTS = C.SNAKE_MIN_SEGMENTS * 2; // hard floor — can never shrink below this
// Per-tick decay factor for the boost release glide (see constants.BOOST_DECAY_MS)
const BOOST_DECAY = Math.exp(-(1000 / C.TICK_RATE) / C.BOOST_DECAY_MS);

class Snake {
  constructor(id, name, x, y, color) {
    this.id = id;
    this.name = name || 'Player';
    this.color = sanitizeColor(color) || COLORS[Math.floor(Math.random() * COLORS.length)];
    this.angle = Math.random() * Math.PI * 2;
    this.targetAngle = this.angle;
    this.boosting = false;
    this.alive = true;
    this.score = 0;

    this.segments = [];
    const spawnLen = Math.max(MIN_SEGMENTS, C.SNAKE_SPAWN_SEGMENTS * 2) * SUBDIV;   // in chain points
    for (let i = 0; i < spawnLen; i++) {
      this.segments.push({
        x: x - Math.cos(this.angle) * i * C.SNAKE_SEP_PER_SC / SUBDIV,
        y: y - Math.sin(this.angle) * i * C.SNAKE_SEP_PER_SC / SUBDIV,
      });
    }
    this.pendingGrowth = 0;
    this.boostDrops = []; // food positions to spawn when boosting
    this.worth = 0; // SOL value this snake is carrying (entry fee + eaten cash food)
  }

  get head() { return this.segments[0]; }
  // Length is counted in PARTS, which is what score, scale, boost fuel and the
  // wire all mean. The segments array holds SUBDIV chain points per part.
  get length() { return this.segments.length / SUBDIV; }

  // Boost fuel = how many segments above the minimum floor
  get boostFuel() { return Math.max(0, this.length - MIN_SEGMENTS); }
  // 0-1 ratio for the boost bar UI
  get boostRatio() {
    const max = Math.max(1, this.length - MIN_SEGMENTS + this.pendingGrowth);
    return Math.min(1, this.boostFuel / max);
  }

  // Scale grows 1 → 6 with length; drives turn heaviness, thickness, zoom & spacing.
  get scale() {
    return Math.min(6, 1 + (this.length - MIN_SEGMENTS) / C.SNAKE_SC_SEGS);
  }

  // Distance between body points. Grows with the snake, so body LENGTH grows
  // with the square of scale the way slither's does — see SNAKE_SEP_PER_SC.
  get separation() { return C.SNAKE_SEP_PER_SC * this.scale / SUBDIV; }

  // Turn rate degrades with size on a quadratic curve — small snakes are nimble, giants turn
  // wide and heavy. Factor is 1.0 at scale 1, easing to ~0.15 at scale 6.
  get turnRate() {
    const sc = this.scale;
    const scang = 0.13 + 0.87 * Math.pow((7 - sc) / 6, 2);
    return C.MAX_TURN_RATE * scang;
  }

  /* speedMult is deliberately NOT taken from the client any more.

     It only ever carried the cash-out slowdown, and letting the client send it
     meant the one penalty that makes banking a snake risky was optional: a
     modified client simply kept sending 1 and crawled for nobody. The server
     derives it from its own cash-out clock instead (see cashoutSpeed), so the
     player who is banking is slow whatever their client says. */
  setInput(targetAngle, boosting) {
    this.targetAngle = targetAngle;
    this.boosting = boosting && this.boostFuel > 0;
  }

  /* Ramps from full speed down to CASHOUT_MIN_SPEED_MULT across the hold, and
     snaps straight back to 1 the moment the hold is released. */
  get speedMult() {
    if (!this.cashoutStartedAt) return 1;
    const t = Math.min(1, (Date.now() - this.cashoutStartedAt) / C.CASHOUT_HOLD_MS);
    return Math.max(C.CASHOUT_MIN_SPEED_MULT, 1 - (1 - C.CASHOUT_MIN_SPEED_MULT) * t);
  }

  update() {
    if (!this.alive) return;

    // Turn toward target
    let delta = this.targetAngle - this.angle;
    while (delta >  Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    const tr = this.turnRate;
    if (Math.abs(delta) > tr) {
      this.angle += Math.sign(delta) * tr;
    } else {
      this.angle = this.targetAngle;
    }

    // Boost ramp — slither.io speed dynamics: linear ramp 0 → 1 over BOOST_RAMP_TICKS while
    // held, and an exponential glide back toward 0 on release (never an instant stop — the
    // old boostRamp = 0 snap read as a harsh brake). Food cost/drops stay tied to the INPUT,
    // so releasing stops the shedding immediately even while the speed is still gliding down.
    if (this.boosting && this.boostFuel > 0) {
      this._boostTick = (this._boostTick || 0) + 1; // resets for food drop
      this.boostRamp = Math.min(1, (this.boostRamp || 0) + 1 / C.BOOST_RAMP_TICKS);

      // Drop 1 food at the current tail every 4 ticks — 6 evenly spaced drops over
      // 24 ticks, twice the previous rate (was every 8). The shrink rate below is
      // unchanged, so boosting costs the same length; it just leaves more behind.
      if (this._boostTick % 4 === 0) {
        const tail = this.segments[this.segments.length - 1];
        if (tail) this.boostDrops.push({ x: tail.x, y: tail.y, value: 0.15, color: this.color, dropped: true });
      }
      // Shrink once per 24 ticks — same rate as before
      if (this._boostTick >= 24) {
        this._boostTick = 0;
        for (let k = 0; k < SUBDIV; k++) this.segments.pop();   // one PART, not one chain point
      }
    } else {
      if (this.boosting) this.boosting = false;
      this._boostTick = 0;
      this.boostRamp = (this.boostRamp || 0) * BOOST_DECAY;
      if (this.boostRamp < 0.02) this.boostRamp = 0;
    }

    // Per-tick speed: base rises a little with size; boost eases toward a fixed cap, so the boost
    // *ratio* shrinks as you grow. speedMult (<1) still handles the cashout slowdown.
    const sc = this.scale;
    const baseSpeed = C.SNAKE_BASE_SPEED + C.SNAKE_SPEED_PER_SC * (sc - 1);
    const targetSpeed = baseSpeed + (C.SNAKE_MAX_SPEED - baseSpeed) * this.boostRamp;
    const speedThisTick = targetSpeed * (this.speedMult || 1);

    /* THE BODY IS A CHAIN, NOT A REPLAY OF WHERE THE HEAD HAS BEEN.

       It used to freeze a point behind the head every few units and never touch
       it again, so the body traced the head's exact route. Circling therefore
       laid every loop on the same circle and read as one flat ring, and nothing
       tuned elsewhere could change that: the shape was baked in by construction.

       Now each point is held exactly one separation behind the point ahead of
       it, in whatever direction it already lies. That single rule is what makes
       a snake coil. The link is a straight chord across the arc its leader is
       sweeping, so every point rides a little inside the one ahead of it, and
       holding a turn winds the body steadily inward until the loops nest.

       The drift works out to pi * separation per revolution, which is why the
       separation constant is the coil's strength. At our sizes that is about
       three quarters of a body width per lap, so a sustained turn stacks
       visible rings instead of one thick circle.

       Link lengths are exact rather than eased, so the body can neither creep
       nor bunch: total length is always (points - 1) * separation. The soft
       version of this, each point pulled a fraction of the way toward the one
       ahead, was built and measured first. It cuts corners only to second order,
       about 1% inward, which is invisible. */
    const head = this.segments[0];
    head.x += Math.cos(this.angle) * speedThisTick;
    head.y += Math.sin(this.angle) * speedThisTick;

    /* THE BODY IS A FROZEN TRAIL, NOT A SOLVED CHAIN.

       A point is laid one separation behind the head and then never moved
       again. The body is therefore exactly the path the head has walked.

       This replaces a rigid chain that re-solved every point every tick. The
       chain cut every corner, so in a turn the body rode an inner ring and the
       tail covered only 71% of the ground the head did. Owen kept reporting
       that as the tail stopping while the head carried on, and he was right.

       On a frozen trail the tail cannot lag: it advances exactly one stored
       point for every point the head lays, so it travels at the head speed by
       construction, not by tuning.

       This is what slither does. Their points are pushed at the head position
       and then only nudged toward the point ahead by their cst pull, which was
       measured here as about 1% of inward drift across a whole body. That is
       under a hundredth of the corner cutting a rigid chain does, so the pull
       is deliberately left out: it costs a rebuild of the spacing model (it
       compresses stored points to about 57% and their draw code compensates via
       an smu table) to buy a difference below 1%.

       Which means a circling snake coils only as tightly as the HEAD spirals.
       That is also true of slither: hold a perfectly constant turn and you get
       one ring, and the nested coil comes from the player progressively
       tightening. If more coil than that is ever wanted, it is a body pull that
       has to come back, and the spacing compensation with it. */
    const segs = this.segments;
    const sep  = this.separation;
    this._segAccum = (this._segAccum || 0) + speedThisTick;
    while (this._segAccum >= sep) {
      this._segAccum -= sep;
      const p1 = segs[1] || head;
      const dx = head.x - p1.x, dy = head.y - p1.y;
      const d  = Math.hypot(dx, dy) || 1;
      const t  = sep / d;
      segs.splice(1, 0, { x: p1.x + dx * t, y: p1.y + dy * t });

      /* GROWTH IS THE ABSENCE OF RETIREMENT.

         Eating does not push anything onto the tail. It simply stops the tail
         point being retired, so the tail stays exactly where it is and the
         snake lengthens from the head end. That is slither's mechanism (their
         sct++ keeps an extra already-placed point) and it removes the tail
         flinging backward on a big feed without needing a rate limiter, since
         growth is now paced by how fast the head lays new body down.

         Spent per chain point rather than per part so a part arrives smoothly. */
      if (this.pendingGrowth > 0) this.pendingGrowth -= 1 / SUBDIV;
      else segs.pop();
    }
    if (this.pendingGrowth < 1e-9) this.pendingGrowth = 0;
  }

  grow(amount) {
    // slither.io's exact growth curve: food converts to parts at rate (1 - sct/mscps)^2.25,
    // where sct is the slither part-count equivalent of our length (spawn here = sct 2 there).
    // Hits 0 at 411 parts — growth stops, score keeps accumulating (exactly like slither).
    // Accumulate fractionally so pendingGrowth stays a whole-segment counter.
    const sct = this.length - MIN_SEGMENTS + 2;
    const falloff = Math.pow(Math.max(0, 1 - sct / C.GROWTH_MSCPS), C.GROWTH_EXP);
    this._growFrac = (this._growFrac || 0) + amount * C.SEGMENTS_PER_FOOD * falloff;
    if (this._growFrac >= 1) {
      const whole = Math.floor(this._growFrac);
      this.pendingGrowth += whole;
      this._growFrac     -= whole;
    }
    this.score = Math.round(this.score + amount);
  }

  die() {
    this.alive = false;
    // slither.io-style corpse food: big bright orbs laid ALONG the body (tracing the
    // corpse's shape), not randomly scattered. Bigger snakes drop bigger orbs. NOT
    // flagged `dropped` — that flag dims boost-trail crumbs to 55% alpha, and corpse
    // food in slither is the biggest, brightest food in the game.
    const drops = [];
    const segs = this.segments;
    const n = segs.length;
    if (n === 0) return drops;

    const sizeMul = Math.min(1.6, 0.9 + 0.14 * this.scale); // giants drop visibly bigger orbs
    const bodyR   = C.SNAKE_HEAD_RADIUS * this.scale;       // half the snake's width

    // Space the orbs by ARC LENGTH, not by segment index. Segments sit only
    // SNAKE_SEGMENT_SPACING (3) units apart while an orb renders about 7 units
    // across, so index-spacing packed them on top of each other and the corpse
    // read as one clump. Stepping by roughly an orb diameter lays a readable
    // trail down the body instead.
    const orbR        = C.FOOD_RADIUS * 2.0 * sizeMul;
    // Points are further apart on a bigger snake, so the index step that covers
    // one orb width has to come from the LIVE separation, not the scale-1 value.
    const sep         = this.separation;
    const stepUnits   = Math.max(orbR * 1.1, sep);
    const segsPerStep = Math.max(1, Math.round(stepUnits / sep));
    const PER_STEP    = 2;   // orbs laid across the width at each step

    for (let i = 0; i < n; i += segsPerStep) {
      // local body direction, so the scatter runs ACROSS the snake rather than
      // in a square box around each point
      const nxt = segs[Math.min(n - 1, i + 1)];
      const prv = segs[Math.max(0, i - 1)];
      const dx = nxt.x - prv.x, dy = nxt.y - prv.y;
      const L = Math.hypot(dx, dy) || 1;
      const px = -dy / L, py = dx / L;      // unit perpendicular
      for (let k = 0; k < PER_STEP; k++) {
        // One orb to each side of the spine, each at least 15% of the body radius
        // off centre. Independent random offsets let the pair land on the same
        // spot, which is the clumping this is meant to avoid.
        const side = k === 0 ? -1 : 1;
        const off  = side * bodyR * (0.15 + Math.random() * 0.85);
        drops.push({
          x: segs[i].x + px * off,
          y: segs[i].y + py * off,
          value: 2,
          color: this.color,
          size: (2.0 + Math.random() * 0.5) * sizeMul,
          dropped: false,
        });
      }
    }
    return drops;
  }

  serialize() {
    const segs = [];
    const len  = this.segments.length;
    /* Adaptive thinning, counted in PARTS, so the wire carries the same number
       of points it always did however finely the chain is subdivided below it.
       Reading it off the raw point count instead would send SUBDIV times more
       points and, worse, leave the client rebuilding its chain at a different
       resolution from the server's. */
    const parts = this.length;
    const step = (parts < 400 ? 2 : parts < 800 ? 3 : 4) * SUBDIV;
    for (let i = 0; i < len; i += step) {
      segs.push(Math.round(this.segments[i].x * 10) / 10,
                Math.round(this.segments[i].y * 10) / 10);
    }
    return {
      id: this.id,
      name: this.name,
      color: this.color,
      segs,
      angle: this.angle,
      boosting: this.boosting,
      boostRamp: this.boostRamp || 0,
      score: Math.floor(this.score),
      length: this.length,
      boostRatio: this.boostRatio,
      worth: this.worth,
      speedMult: this.speedMult || 1,
    };
  }
}

// Exposed as statics so tests (and any future caller) can check a colour against
// the same list the server enforces, rather than re-declaring it or reading
// snake-design/slither-palette.json — that folder is reference material and is
// NOT part of this repo, so anything importing it breaks on a fresh checkout.
Snake.COLORS = COLORS;
Snake.SKIN_ONLY_COLORS = SKIN_ONLY_COLORS;
Snake.sanitizeColor = sanitizeColor;

module.exports = Snake;
