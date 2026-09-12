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

/* WHEN A BOT RUNS FOR THE MIDDLE, AND WHEN IT STOPS.

   Two thresholds rather than one, and the second is the whole point. With a
   single line the bot fled until it was one unit inside it, went straight back
   to wandering — outward as often as not — fell outside again, and fled again.
   Traced against a closing circle its distance from the centre sat flat at
   ~2540 for the whole match while the wall came in at up to 93 units a second,
   so it oscillated on the threshold making no headway and the wall took it.
   Every bot in a twenty-bot match died that way, none to another snake.

   So: start running at CAUTION, and keep running until comfortably inside at
   SAFE. The gap between them is what turns a twitch into a journey. */
const BORDER_CAUTION = 0.78;   // outside this, head for the middle
const BORDER_SAFE    = 0.55;   // and keep heading there until inside this
const BORDER_PANIC   = 0.92;   // outside this, spend body to get there

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
    this._fleeing = false;   // latched by the border thresholds below
  }

  /* `cx`/`cy` are where the circle actually IS.

     This used to measure from the origin and steer toward the origin, which is
     correct in every room except the one where the border matters. A battle
     royale's circle roams up to 800 units off centre, so a bot fleeing the
     wall ran toward where the circle used to be — often straight through it
     and out the far side. That is why they died to the border in a heap. */
  updateAI(foodList, worldRadius, allSnakes, cx, cy, foodGrid) {
    if (!this.alive) return;

    // ── 1. Border avoidance ──────────────────────────────────────────────────
    const zx = cx || 0, zy = cy || 0;
    const bx = this.head.x - zx, by = this.head.y - zy;
    const distFromCenter = Math.hypot(bx, by);

    /* Latched. Crossing CAUTION starts the run; only reaching SAFE ends it. */
    if (distFromCenter > worldRadius * BORDER_CAUTION) this._fleeing = true;
    else if (distFromCenter < worldRadius * BORDER_SAFE) this._fleeing = false;

    if (this._fleeing) {
      this.targetAngle = Math.atan2(-by, -bx);
      /* Boost only when it is genuinely about to be caught. A bot that boosts
         the moment it gets near the edge burns its body for nothing; one that
         never boosts dies to a wall it could have outrun. */
      this.boosting = distFromCenter > worldRadius * BORDER_PANIC && this.boostFuel > 15;
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
      /* Broad-phase on the SQUARE, before any square root. This tested
         Math.hypot(...) > SCAN_R, so the reject paid for the sqrt it existed to
         avoid — on every other snake in the room, for every bot, every tick. */
      const hd2 = hdx * hdx + hdy * hdy;
      if (hd2 > SCAN_R * SCAN_R) continue;
      const hd = Math.sqrt(hd2);

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

    /* ── 4. Seek nearest food ──────────────────────────────────────────────
       THE ONE THAT COSTS EVERYTHING.

       This read EVERY pellet in the world to find the nearest one within 280
       units, with a Math.hypot each. At a hundred bots and 3,600 pellets that
       is twenty-one million square roots a second, and a CPU profile of the
       real tick put updateAI at 80.8% of it — more than the simulation, the
       collisions and the whole snapshot path put together.

       It is also exactly why cutting the pellet count appeared to fix the lag:
       it was not making the food system cheaper, it was giving the bots less to
       read. And it is why a bigger world did nothing — spreading the same food
       over seven times the area does not shorten a list.

       The grid is already built for the magnetism pass a few lines up, and 280
       units spans nine cells across rather than the whole map. Same answer,
       same behaviour: still the nearest pellet within 280 units.

       `foodList` is still accepted so an older caller keeps working, and is
       used only when no grid is handed in. */
    let nearestFood = null, nearestD2 = 280 * 280;
    const hx = this.head.x, hy = this.head.y;
    if (foodGrid) {
      foodGrid.forEachInRange(hx, hy, 280, (f) => {
        const dx = hx - f.x, dy = hy - f.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < nearestD2) { nearestD2 = d2; nearestFood = f; }
        return false;                       // keep scanning the rest
      });
    } else {
      for (const f of foodList) {
        const dx = hx - f.x, dy = hy - f.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < nearestD2) { nearestD2 = d2; nearestFood = f; }
      }
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
