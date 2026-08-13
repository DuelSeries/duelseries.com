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

const MIN_SEGMENTS = C.SNAKE_MIN_SEGMENTS * 2; // hard floor — can never shrink below this
// Per-tick decay factor for the boost release glide (see constants.BOOST_DECAY_MS)
const BOOST_DECAY = Math.exp(-(1000 / C.TICK_RATE) / C.BOOST_DECAY_MS);

class Snake {
  constructor(id, name, x, y, color, hatId, boostId) {
    this.id = id;
    this.name = name || 'Player';
    this.color = color || COLORS[Math.floor(Math.random() * COLORS.length)];
    this.hatId   = hatId   || 'none';
    this.boostId = boostId || 'default';
    this.angle = Math.random() * Math.PI * 2;
    this.targetAngle = this.angle;
    this.boosting = false;
    this.alive = true;
    this.score = 0;

    this.segments = [];
    const spawnLen = Math.max(MIN_SEGMENTS, C.SNAKE_SPAWN_SEGMENTS * 2);
    for (let i = 0; i < spawnLen; i++) {
      this.segments.push({
        x: x - Math.cos(this.angle) * i * C.SNAKE_SEGMENT_SPACING,
        y: y - Math.sin(this.angle) * i * C.SNAKE_SEGMENT_SPACING,
      });
    }
    this.pendingGrowth = 0;
    this.boostDrops = []; // food positions to spawn when boosting
    this.worth = 0; // SOL value this snake is carrying (entry fee + eaten cash food)
  }

  get head() { return this.segments[0]; }
  get length() { return this.segments.length; }

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

  // Turn rate degrades with size on a quadratic curve — small snakes are nimble, giants turn
  // wide and heavy. Factor is 1.0 at scale 1, easing to ~0.15 at scale 6.
  get turnRate() {
    const sc = this.scale;
    const scang = 0.13 + 0.87 * Math.pow((7 - sc) / 6, 2);
    return C.MAX_TURN_RATE * scang;
  }

  setInput(targetAngle, boosting, speedMult) {
    this.targetAngle = targetAngle;
    this.boosting = boosting && this.boostFuel > 0;
    this.speedMult = (typeof speedMult === 'number') ? Math.max(0.2, Math.min(1, speedMult)) : 1;
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
        this.segments.pop();
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

    // Move the head CONTINUOUSLY by speedThisTick so it tracks the client's smooth local prediction
    // exactly (quantizing the head to fixed 3-unit steps drifted against the prediction and read as
    // lag). Then drop frozen trail points behind it at SNAKE_BASE_SPEED spacing, popping to hold length.
    const head = this.segments[0];
    head.x += Math.cos(this.angle) * speedThisTick;
    head.y += Math.sin(this.angle) * speedThisTick;

    if (this._segAccum === undefined) this._segAccum = 0;
    this._segAccum += speedThisTick;
    while (this._segAccum >= C.SNAKE_BASE_SPEED) {
      this._segAccum -= C.SNAKE_BASE_SPEED;
      const p1 = this.segments[1];
      const dx = head.x - p1.x, dy = head.y - p1.y;
      const d  = Math.hypot(dx, dy) || 1;
      const t  = C.SNAKE_BASE_SPEED / d;
      this.segments.splice(1, 0, { x: p1.x + dx * t, y: p1.y + dy * t });
      if (this.pendingGrowth > 0) this.pendingGrowth--; else this.segments.pop();
    }
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
    const stepUnits   = Math.max(orbR * 1.1, C.SNAKE_SEGMENT_SPACING);
    const segsPerStep = Math.max(1, Math.round(stepUnits / C.SNAKE_SEGMENT_SPACING));
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
    // Adaptive thinning — spline renderer handles gaps smoothly
    const step = len < 400 ? 2 : len < 800 ? 3 : 4;
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
      hatId: this.hatId,
      boostId: this.boostId,
      score: Math.floor(this.score),
      length: this.length,
      boostRatio: this.boostRatio,
      worth: this.worth,
      speedMult: this.speedMult || 1,
    };
  }
}

module.exports = Snake;
