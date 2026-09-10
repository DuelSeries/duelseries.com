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

/* How many STORED points make up one body part. Derived, not chosen: a part is
   SNAKE_SEP_PER_SC of body and a stored gap is SNAKE_STORED_GAP_PER_R body
   radii, so 4.83 / (0.663 * 10) = 0.73 points per part. Coarse on purpose. A
   100-part snake stores about 73 points where the old fine version stored 400,
   and that coarseness IS the coil (see the constants). */
const POINTS_PER_PART = C.SNAKE_SEP_PER_SC / (C.SNAKE_STORED_GAP_PER_R * C.SNAKE_HEAD_RADIUS);
const MIN_SEGMENTS = C.SNAKE_MIN_SEGMENTS * 2; // hard floor — can never shrink below this

/* slither's mass tables, built exactly the way their client builds them. Read
   out of their live bundle rather than reconstructed:

     fmlts[i] = (1 - i/mscps)^2.25            growth falloff at i parts
     fpsls[i] = fpsls[i-1] + 1/fmlts[i-1]     cumulative FOOD to reach i parts
     score    = floor((fpsls[sct] + fam/fmlts[sct] - 1) * 15 - 5)

   fmlts is already what grow() curves by. fpsls is its running total, and
   that is the useful one here: fpsls[sct] is how much food it takes to build
   a body of sct parts, which is the only honest answer to what a corpse is
   worth. It is steep — a 403-part body is 41,500 food units against 12 for a
   fresh one — which is exactly why a per-segment corpse was wrong at both
   ends at once. */
/* Our spawn is slither's sct 2, which is the anchor grow() curves against. */
const SPAWN_SCT = 2;
const FMLTS = [], FPSLS = [];
for (let i = 0; i <= C.GROWTH_MSCPS; i++) {
  FMLTS.push(i >= C.GROWTH_MSCPS ? FMLTS[i - 1]
                                 : Math.pow(1 - i / C.GROWTH_MSCPS, C.GROWTH_EXP));
  FPSLS.push(i === 0 ? 0 : FPSLS[i - 1] + 1 / FMLTS[i - 1]);
}
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
    const spawnLen = Math.round(Math.max(MIN_SEGMENTS, C.SNAKE_SPAWN_SEGMENTS * 2) * POINTS_PER_PART);
    for (let i = 0; i < spawnLen; i++) {
      this.segments.push({
        x: x - Math.cos(this.angle) * i * C.SNAKE_STORED_GAP_PER_R * C.SNAKE_HEAD_RADIUS,
        y: y - Math.sin(this.angle) * i * C.SNAKE_STORED_GAP_PER_R * C.SNAKE_HEAD_RADIUS,
      });
    }
    /* PARTS are the gameplay length and stay a whole number. Stored points are
       derived from it (about 0.73 per part), not the other way round. Deriving
       parts from the point count instead made length jump in steps of 1.37. */
    this._parts = Math.max(MIN_SEGMENTS, C.SNAKE_SPAWN_SEGMENTS * 2);
    this.pendingGrowth = 0;
    this.boostDrops = []; // food positions to spawn when boosting
    this.worth = 0; // SOL value this snake is carrying (entry fee + eaten cash food)
  }

  get head() { return this.segments[0]; }
  // Length is counted in PARTS, which is what score, scale, boost fuel and the
  // wire all mean. The segments array holds POINTS_PER_PART stored points per part.
  get length() { return this._parts; }

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
  /* Where a new point is LAID. The pull then compresses the body, so points are
     laid further apart than they settle. settledGap gives the resting gap. */
  get settledGap() { return C.SNAKE_STORED_GAP_PER_R * C.SNAKE_HEAD_RADIUS * this.scale; }
  get separation() { return this.settledGap * C.SNAKE_INSERT_COMPENSATION; }

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
        // Drop a whole part; the stored points follow from the target count.
        if (this._parts > MIN_SEGMENTS) this._parts -= 1;
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
      /* CLAMPED, because a body point in front of the head is not a body.

         This lays the new point one separation behind the head measured from
         p1 — but sep/d is greater than 1 whenever the head is closer to p1
         than a separation, and then the point lands PAST the head. The stored
         path then runs forward from the head and immediately doubles back, and
         the resampler that draws the body walks that fold and puts the first
         drawn point almost on top of the head. A kink in the neck, every
         frame, which is what Owen has been looking at.

         The head gets closer to p1 than a separation for two reasons. Turning
         is the small one: the accumulator counts arc travelled while this
         measures the straight line, and a chord is shorter than its arc. On
         the client the large one is _lCorrect, which used to slide the
         predicted head back toward the server's without moving the body with
         it. Both are fixed at their source; this is the guard that makes the
         geometry impossible rather than merely unlikely. */
      const t  = Math.min(1, sep / d);
      segs.splice(1, 0, { x: p1.x + dx * t, y: p1.y + dy * t });

      /* GROWTH IS THE ABSENCE OF RETIREMENT.

         Eating does not push anything onto the tail. It simply stops the tail
         point being retired, so the tail stays exactly where it is and the
         snake lengthens from the head end. That is slither's mechanism (their
         sct++ keeps an extra already-placed point) and it removes the tail
         flinging backward on a big feed without needing a rate limiter, since
         growth is now paced by how fast the head lays new body down.

         Spent per chain point rather than per part so a part arrives smoothly. */
      /* One part per point laid, so growth is paced by how far the snake has
         travelled. Growing raises the target point count, so the tail simply is
         not retired and stays where it is, which is slither's mechanism. */
      if (this.pendingGrowth >= 1) { this.pendingGrowth -= 1; this._parts += 1; }
      const target = Math.max(4, Math.round(this._parts * POINTS_PER_PART));
      while (segs.length > target) segs.pop();

      /* THE PULL. This is the coil.

         Each stored point moves toward the point ahead, which is a chord across
         the arc its leader swept, so every point ends up slightly inside the one
         ahead and a held turn winds the body inward. Eased over the first four
         so the neck stays loose. Toward the leader's position at the START of
         the pass: cascading within a pass compounds the compression past theirs.

         Applied once per point laid. Spreading the same total continuously per
         tick was tried and is worse: it smooths the tail (11% of a body radius
         instead of 36%) but throws the head gap to 63% and shifts the settled
         gap off 0.663 to 0.823. */
      const pull = C.SNAKE_BODY_PULL;
      let leadX = segs[0].x, leadY = segs[0].y;
      for (let i = 1; i < segs.length; i++) {
        const p = segs[i];
        const oldX = p.x, oldY = p.y;
        const mv = pull * (i < 4 ? i / 4 : 1);
        p.x += (leadX - p.x) * mv;
        p.y += (leadY - p.y) * mv;
        leadX = oldX; leadY = oldY;
      }

    }
    if (this.pendingGrowth < 1e-9) this.pendingGrowth = 0;

  }

  /* slither's growth curve, integrated rather than sampled.

     Their rule is that one more part costs 1/fmlts[sct] food AT THE SIZE YOU
     CURRENTLY ARE, which is why fpsls is a running sum of exactly that. This
     used to read fmlts ONCE, at the size the snake was before eating, and
     apply it to the whole mouthful — so a snake that ate a lot in one go grew
     at its starting rate the whole way up, as though it had never got bigger.

     Eating one pellet at a time that error is invisible, which is why it sat
     here unnoticed. It stopped being invisible the moment a corpse orb could
     be worth thousands of food units: a spawn snake eating a 250-part corpse
     came back as 357 parts, bigger than the snake that died.

     Spending the food one part at a time makes this match fpsls by
     construction: the cost of going from A parts to B is the sum of 1/fmlts
     over that range, which IS fpsls[B] - fpsls[A]. */
  grow(amount) {
    this.score = Math.round(this.score + amount);
    if (!(amount > 0)) return;

    /* Where the body will be once what is already owed has been laid down.
       Growth queued but not yet grown still counts as size, or a big meal
       eaten in two mouthfuls would be cheaper than the same meal in one. */
    let sct = Math.min(C.GROWTH_MSCPS, this.sct + this.pendingGrowth);
    let food = amount * C.SEGMENTS_PER_FOOD;
    let parts = 0;

    /* Bounded by the part cap: there is no amount of food that can buy more
       than GROWTH_MSCPS parts, so this cannot spin however much is eaten. */
    while (food > 0 && sct < C.GROWTH_MSCPS) {
      const rate = FMLTS[sct];
      if (!(rate > 0)) break;                       // at the cap: score only
      const need = (1 - (this._growFrac || 0)) / rate;   // food to finish this part
      if (food < need) {
        this._growFrac = (this._growFrac || 0) + food * rate;
        food = 0;
        break;
      }
      food -= need;
      this._growFrac = 0;
      parts++;
      sct++;
    }
    this.pendingGrowth += parts;
  }

  /* slither's part count for this body. Our spawn is their sct 2, which is the
     same anchor grow() curves against. */
  get sct() {
    return Math.max(0, Math.min(C.GROWTH_MSCPS, this.length - MIN_SEGMENTS + 2));
  }

  /* What this body cost to build, in food units.

     A function of SIZE alone, so two snakes the same length are worth the same
     however long one has been farming — score keeps climbing after the part
     cap and a corpse priced off it would make a veteran's body absurd.

     The WHOLE body, spawn parts included, so every corpse leaves food on the
     floor. Owen's call, and the right one: a body that vanishes without a
     trace is a body nobody believes died there. Pricing only the earned part
     made a spawn-size corpse worth exactly nothing.

     A spawn body is worth 2.0 food units, of which a corpse drops the ratio —
     enough to be worth driving over, and enough that dying at spawn size and
     eating yourself comes back ONE part up. That is the whole of the surplus,
     against losing your position and your speed and respawning somewhere else,
     and it is a rounding error next to the 4.85x this replaced. */
  get mass() { return FPSLS[this.sct]; }

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

    /* The corpse is worth a share of the BODY, split evenly across however
       many orbs it takes to trace it. The orb count is a drawing decision —
       it follows the shape of the snake — so it must not be what decides the
       value, which is the mistake this replaces: value per orb was a constant
       and the total was therefore whatever the geometry happened to produce. */
    const steps = Math.max(1, Math.ceil(n / segsPerStep));
    const orbValue = (this.mass * C.CORPSE_DROP_RATIO) / (steps * PER_STEP);

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
          value: orbValue,
          color: this.color,
          size: (2.0 + Math.random() * 0.5) * sizeMul,
          dropped: false,
        });
      }
    }
    return drops;
  }

  /* The body as it should be DRAWN: uniformly spaced, anchored at the head, and
     ending exactly at the snake's true length.

     The stored points cannot be drawn raw. They are laid at discrete intervals
     while the head moves continuously, so the gap between the head and the first
     stored point cycles from zero to a full separation. At a big size that is 24
     units, more than a body radius, so the first segment stretches and snaps
     every cycle: the head appears to blink, and the angle reference jumping
     between points makes it look like it spins through a turn. The tail does the
     same at the other end whenever the point count rounds up or down and a whole
     point pops in or out.

     Resampling fixes both. The path is identical, so the coil is untouched; only
     the sample positions change. The first gap becomes constant, and the last
     point lands at the exact fractional body length, so the tail slides out and
     back continuously instead of popping a whole point. */
  drawPoints() {
    const segs = this.segments;
    const gap  = this.settledGap;
    const sepInsert = this.separation;
    const out  = [segs[0].x, segs[0].y];
    let cx = segs[0].x, cy = segs[0].y;
    let need = gap;
    for (let i = 1; i < segs.length; ) {
      const dx = segs[i].x - cx, dy = segs[i].y - cy;
      const d  = Math.hypot(dx, dy);
      if (d < 1e-9) { i++; continue; }
      if (d >= need) {
        const t = need / d;
        cx += dx * t; cy += dy * t;
        out.push(cx, cy);
        need = gap;
      } else {
        need -= d; cx = segs[i].x; cy = segs[i].y; i++;
      }
    }
    /* THE TAIL SLIDES, IT DOES NOT POP.

       A trail retires its tail one whole point at a time. At the old fine
       spacing that step was 2 units and invisible; at this coarse spacing it is
       21, about a full body radius, and it read as the tail glitching and
       blinking every time a point was laid.

       slither solves this by never popping either: it flags the tail point
       'dying' and fades it out over about five seconds instead. The drawing
       equivalent is to put the tail END at a fraction between the last two
       stored points, advanced by the same accumulator that drives insertion. By
       the moment a point is actually popped the drawn tail has already reached
       the next point, so the handover is seamless and the tail never jumps.

       An earlier version stopped at a THEORETICAL body length, which the stored
       body cannot reach while coiled (it compresses up to 28%). Crossing that
       boundary threw the tail 33 units in one tick. */
    const n = segs.length;
    if (n >= 2) {
      const frac = Math.min(1, Math.max(0, (this._segAccum || 0) / sepInsert));
      const a = segs[n - 1], bpt = segs[n - 2];
      const tx = a.x + (bpt.x - a.x) * frac;
      const ty = a.y + (bpt.y - a.y) * frac;
      if (Math.hypot(tx - out[out.length - 2], ty - out[out.length - 1]) > 1e-6) out.push(tx, ty);
    }
    return out;
  }

  serialize() {
    /* The wire carries the DRAWN body: uniformly sampled and head-anchored, not
       the raw stored points. See drawPoints() for why the raw ones cannot be
       drawn directly. No thinning; at this coarseness the whole body fits. */
    const pts = this.drawPoints();
    const segs = new Array(pts.length);
    for (let i = 0; i < pts.length; i++) segs[i] = Math.round(pts[i] * 10) / 10;
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
