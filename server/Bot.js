const Snake = require('./Snake');

// slither.io's skin palette, same set the real snakes use (see Snake.js) so bots
// are indistinguishable from players.
const BOT_COLORS = [
  '#c080ff', '#9099ff', '#80d0d0', '#80ff80', '#eeee70',
  '#ffa060', '#ff9090', '#ff4040', '#e030e0', '#ffc050',
  '#6475ff', '#a050ff', '#ffe040', '#65c8e8', '#3cc048',
  '#00ff53', '#d94545', '#f0f020', '#f09020', '#8080ff',
];

const BOT_NAMES = [
  'aidan6969', 'jacobtheweiner78', 'quantum', 'Mr-1221z', 'slitherkinggg',
  'xX_snake_Xx', 'noodleman', 'cobrakai99', 'bigworm42', 'snek_lord',
  'viper0011', 'hisssss', 'eaturdust', 'n00bslayer', 'wormhole_',
  'slurpmaster', 'gg_no_re', 'tryhard99', 'just_a_worm', 'toxic_snek',
  'GigaWorm', 'boostgang', 'curvy_boi', 'nomnom_snek', 'ieatbots',
  'deathcoil', 'zoomzoom22', 'slimy_steve', 'wiggleking', 'ouroboros_',
  'snekattack', 'longneck', 'ratboi420', 'fastaf_boii', 'lmaosnek',
  'noobmaster_', 'slitherio_pro', 'wormy_mcworm', 'danger_noodle', 'mr_slithers',
];

const usedNames = new Set();

function pickBotName() {
  const available = BOT_NAMES.filter(n => !usedNames.has(n));
  const pool = available.length > 0 ? available : BOT_NAMES;
  const name = pool[Math.floor(Math.random() * pool.length)];
  usedNames.add(name);
  return name;
}

class Bot extends Snake {
  constructor(id, x, y) {
    const color = BOT_COLORS[Math.floor(Math.random() * BOT_COLORS.length)];
    super(id, pickBotName(), x, y, color);
    this.isBot = true;
    this._turnDir    = (Math.random() < 0.5 ? 1 : -1);
    this._turnTimer  = 80 + Math.random() * 120;
    this._aggro      = false;
    this._aggroTarget = null;
    this._aggroTimer  = 0;
    this._aggroCooldown = 0;
  }

  updateAI(foodList, worldRadius, allSnakes) {
    if (!this.alive) return;

    // ── 1. Border avoidance ──────────────────────────────────────────────────
    const distFromCenter = Math.hypot(this.head.x, this.head.y);
    if (distFromCenter > worldRadius * 0.82) {
      this.targetAngle = Math.atan2(-this.head.y, -this.head.x);
      this.boosting = false;
      this._aggro = false;
      return;
    }

    // ── 2. Body collision avoidance ──────────────────────────────────────────
    const DANGER_R  = 130;
    const SCAN_R    = DANGER_R * 2.5; // broad phase — skip snakes further than this
    let avoidX = 0, avoidY = 0, inDanger = false;

    for (const other of allSnakes) {
      if (other.id === this.id || !other.alive) continue;

      const hdx = this.head.x - other.head.x;
      const hdy = this.head.y - other.head.y;
      const hd  = Math.hypot(hdx, hdy);

      // Broad-phase: skip entirely if snake is far away
      if (hd > SCAN_R) continue;

      // Avoid head
      if (hd > 0 && hd < DANGER_R) {
        const w = (1 - hd / DANGER_R) * 2.0;
        avoidX += (hdx / hd) * w;
        avoidY += (hdy / hd) * w;
        inDanger = true;
      }

      // Avoid body segments — only sample nearby snakes, every 6th segment
      for (let i = 0; i < other.segments.length; i += 6) {
        const seg = other.segments[i];
        const sdx = this.head.x - seg.x;
        const sdy = this.head.y - seg.y;
        const sd  = Math.hypot(sdx, sdy);
        if (sd > 0 && sd < DANGER_R) {
          const w = (1 - sd / DANGER_R) * 2.5;
          avoidX += (sdx / sd) * w;
          avoidY += (sdy / sd) * w;
          inDanger = true;
        }
      }
    }

    if (inDanger) {
      this.targetAngle = Math.atan2(avoidY, avoidX);
      this.boosting    = false;
      this._aggro      = false;
      return;
    }

    // ── 3. Aggressive mode — randomly charge at nearest player ───────────────
    if (this._aggroCooldown > 0) this._aggroCooldown--;

    if (!this._aggro && this._aggroCooldown <= 0 && this.boostFuel > 20) {
      if (Math.random() < 0.003) {
        // Find the nearest human player
        let bestTarget = null, bestDist = 700;
        for (const other of allSnakes) {
          if (other.isBot || !other.alive) continue;
          const d = Math.hypot(this.head.x - other.head.x, this.head.y - other.head.y);
          if (d < bestDist) { bestDist = d; bestTarget = other; }
        }
        if (bestTarget) {
          this._aggro       = true;
          this._aggroTarget = bestTarget.id;
          this._aggroTimer  = 120 + Math.floor(Math.random() * 180); // 2–5 sec
        }
      }
    }

    if (this._aggro) {
      this._aggroTimer--;
      const target = allSnakes.find(s => s.id === this._aggroTarget && s.alive);

      if (!target || this._aggroTimer <= 0 || this.boostFuel <= 5) {
        // Give up
        this._aggro       = false;
        this._aggroTimer  = 0;
        this._aggroCooldown = 200 + Math.floor(Math.random() * 160); // 3–6 sec cooldown
        this.boosting     = false;
      } else {
        const dx   = target.head.x - this.head.x;
        const dy   = target.head.y - this.head.y;
        const dist = Math.hypot(dx, dy);
        this.targetAngle = Math.atan2(dy, dx);
        // Boost when close enough and have fuel
        this.boosting = dist < 450 && this.boostFuel > 10;
        return;
      }
    }

    // ── 4. Seek nearest food ─────────────────────────────────────────────────
    let nearestFood = null, nearestDist = 280;
    for (const f of foodList) {
      const d = Math.hypot(this.head.x - f.x, this.head.y - f.y);
      if (d < nearestDist) { nearestDist = d; nearestFood = f; }
    }

    if (nearestFood) {
      this.targetAngle = Math.atan2(
        nearestFood.y - this.head.y,
        nearestFood.x - this.head.x
      );
    } else {
      // ── 5. Wander ──────────────────────────────────────────────────────────
      this._turnTimer--;
      if (this._turnTimer <= 0) {
        this._turnDir   = -this._turnDir;
        this._turnTimer = 80 + Math.random() * 120;
      }
      this.targetAngle += this._turnDir * 0.018;
    }

    this.boosting = false;
  }
}

module.exports = Bot;
