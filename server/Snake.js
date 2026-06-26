const C = require('../shared/constants');

const COLORS = [
  '#e74c3c', '#e67e22', '#f1c40f', '#2ecc71', '#1abc9c',
  '#3498db', '#9b59b6', '#e91e63', '#ff5722', '#00bcd4',
  '#8bc34a', '#ff9800', '#673ab7', '#009688', '#f44336',
];

const MIN_SEGMENTS = C.SNAKE_MIN_SEGMENTS * 2; // hard floor — can never shrink below this

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

    // Boost ramp — boostRamp eases 0 → 1 over ~12 ticks; drives the speed target + client render.
    if (this.boosting && this.boostFuel > 0) {
      this._boostAge  = (this._boostAge  || 0) + 1; // total ticks held
      this._boostTick = (this._boostTick || 0) + 1; // resets for food drop

      this.boostRamp = this._boostAge <=  6 ? this._boostAge /  6 * 0.5
                     : this._boostAge <= 12 ? 0.5 + (this._boostAge -  6) / 6 * 0.5
                     : 1;

      // Drop 1 food at current tail every 8 ticks — 3 evenly spaced drops over 24 ticks
      if (this._boostTick % 8 === 0) {
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
      this._boostAge  = 0;
      this._boostTick = 0;
      this.boostRamp  = 0;
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
    this.pendingGrowth += amount * C.SEGMENTS_PER_FOOD;
    this.score = Math.round(this.score + amount);
  }

  die() {
    this.alive = false;
    const drops = [];
    const dropCount = Math.floor(this.length / 4);
    for (let i = 0; i < dropCount; i++) {
      const seg = this.segments[Math.floor(Math.random() * this.segments.length)];
      drops.push({
        x: seg.x + (Math.random() - 0.5) * 20,
        y: seg.y + (Math.random() - 0.5) * 20,
        value: 2,
        color: this.color,
        size: 1.5,
        dropped: true,
      });
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
