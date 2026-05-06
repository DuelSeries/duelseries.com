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

  // Turn rate degrades as snake grows, recovers when boosting/shrinking
  get turnRate() {
    // Base rate degrades by up to 55% at 500 segments, recovers proportionally
    const sizePenalty = Math.min(0.55, (this.length - MIN_SEGMENTS) / 500);
    return C.MAX_TURN_RATE * (1 - sizePenalty);
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

    // Boost ramp — clean integer phases, no fractional alternation
    let steps = 1;
    if (this.boosting && this.boostFuel > 0) {
      this._boostAge  = (this._boostAge  || 0) + 1; // total ticks held
      this._boostTick = (this._boostTick || 0) + 1; // resets for food drop

      if      (this._boostAge <=  6) steps = 1;
      else if (this._boostAge <= 12) steps = 2;
      else                           steps = 3;

      // boostRamp drives client-side rendering (0 → 0.5 → 1)
      this.boostRamp = this._boostAge <=  6 ? this._boostAge /  6 * 0.5
                     : this._boostAge <= 12 ? 0.5 + (this._boostAge -  6) / 6 * 0.5
                     : 1;

      if (this._boostTick >= 24) {
        this._boostTick = 0;
        const dropped = this.segments.pop();
        if (dropped) this.boostDrops.push({ x: dropped.x, y: dropped.y, value: 0.15, color: this.color, dropped: true });
      }
    } else {
      if (this.boosting) this.boosting = false;
      this._boostAge  = 0;
      this._boostTick = 0;
      this.boostRamp  = 0;
    }

    // Movement accumulator (handles speedMult < 1)
    const mult = this.speedMult || 1;
    if (this._moveAccum === undefined) this._moveAccum = 0;
    this._moveAccum += mult;
    if (this._moveAccum < 1) return;
    this._moveAccum -= 1;

    const speed = C.SNAKE_BASE_SPEED;
    for (let s = 0; s < steps; s++) {
      this.segments.unshift({
        x: this.segments[0].x + Math.cos(this.angle) * speed,
        y: this.segments[0].y + Math.sin(this.angle) * speed,
      });
      if (this.pendingGrowth > 0) {
        this.pendingGrowth--;
      } else {
        this.segments.pop();
      }
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
        size: 3,
        dropped: true,
      });
    }
    return drops;
  }

  serialize() {
    const segs = [];
    for (let i = 0; i < this.segments.length; i += 2) {
      segs.push(this.segments[i].x, this.segments[i].y);
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
