'use strict';
/* ─── Shooter ─────────────────────────────────────────────────────────────────
   A top-down tank arena. Drive with the keys, aim with the mouse, shoot enemy
   tanks, break the walls, take their coins, and blow up their base to clear the
   level.

   ON WHAT THIS IS AND IS NOT. Owen asked for a one-to-one copy of Awesome Tanks
   2. It is not one, deliberately: that is a copyrighted commercial game and this
   product handles real money. What IS taken is the genre — a top-down tank, twin
   controls, destructible cover, coins, a base to destroy, upgrades between
   levels — because game mechanics are not what copyright covers. Every level,
   every number, every line here is ours.

   THE SERVER SIMULATES. The client sends which keys are down and where the mouse
   is; it receives positions. It never decides that a bullet hit, that a wall
   broke or that a coin was collected. This game is free today and the netcode
   would still have to be rewritten the day it is not, so it is written the right
   way round now.

   THE MAP IS A GRID. Walls are cells. Breaking one is setting it to 0, line of
   sight is a walk along cells, and enemy pathing is "which neighbouring cell is
   nearer" — all three of which are miserable with polygons and trivial here. */

const SH = {
  TILE: 40,
  COLS: 34,
  ROWS: 22,
  TICK_RATE: 30,               // this game does not need 60: nothing is twitch-precise

  TANK_R: 15,                  // collision radius
  PLAYER_SPEED: 132,           // units per second
  ENEMY_SPEED: 82,
  TURN_RATE: 5.4,              // radians a second the hull swings toward its heading

  PLAYER_HEALTH: 100,
  ENEMY_HEALTH: 45,
  BASE_HEALTH: 220,

  BULLET_SPEED: 340,
  BULLET_LIFE: 2.4,            // seconds
  ENEMY_RANGE: 420,            // it will not shoot at something it cannot see anyway
  ENEMY_FIRE_MS: 1350,
  ENEMY_DMG: 7,
  /* Enemies aim at where you are, which against a stationary player is a hit
     every time. A little error in the barrel is what makes cover and movement
     worth anything: standing in the open should be losing ground, not a timer
     counting down to a death you could not have avoided. */
  ENEMY_SPREAD: 0.10,

  COIN_VALUE: 10,
  RESPAWN_MS: 2200,
  /* You respawn in the corner you started in, and an enemy that wandered over
     to it is otherwise a death loop you cannot drive out of. */
  SPAWN_SAFE_MS: 1600,
  REPAIR_HEAL: 30,
  REPAIR_EVERY: 4,             // a repair drops on every fourth kill

  /* Wall kinds. 0 empty, 1 breakable crate, 2 solid. Solid is what stops the
     arena being sawn in half by a stray shot; breakable is what makes shooting
     the scenery worth doing. */
  EMPTY: 0, CRATE: 1, SOLID: 2,
};

/* The weapons. Three is enough to make choosing one a decision and few enough
   that every one of them is worth carrying. */
const WEAPONS = {
  cannon:  { name: 'Cannon',      cost: 0,   cooldown: 620, damage: 26, speed: 340, spread: 0,    shots: 1, radius: 5 },
  rapid:   { name: 'Machine gun', cost: 120, cooldown: 130, damage: 8,  speed: 420, spread: 0.09, shots: 1, radius: 3 },
  scatter: { name: 'Scattergun',  cost: 220, cooldown: 900, damage: 11, speed: 300, spread: 0.30, shots: 5, radius: 4 },
};

let nextId = 1;

class ShooterRoom {
  constructor(io, roomId) {
    this.io = io;
    this.id = roomId || ('sh_' + (nextId++));
    this.socketRoomName = 'sh_' + this.id;
    this.state = 'playing';        // playing | cleared | dead
    this.level = 1;
    this.coins = 0;
    this.map = [];
    this.tanks = new Map();        // id -> tank
    this.bullets = [];
    this.pickups = [];             // coins on the floor
    this.base = null;
    this.player = null;
    this.owned = new Set(['cannon']);
    this.kills = 0;
    this.weapon = 'cannon';
    this.timer = null;
    this.seq = 0;
  }

  /* ── the arena ───────────────────────────────────────────────────────────
     A solid border, a scattering of solid pillars, and a lot of breakable
     crates. Built from a seed so a level can be replayed exactly. */
  buildLevel(level) {
    const rnd = mulberry(level * 7919 + 13);
    this.map = [];
    for (let r = 0; r < SH.ROWS; r++) {
      const row = [];
      for (let c = 0; c < SH.COLS; c++) {
        const edge = r === 0 || c === 0 || r === SH.ROWS - 1 || c === SH.COLS - 1;
        if (edge) { row.push(SH.SOLID); continue; }
        /* Pillars on a lattice, so there is always a way THROUGH the arena
           rather than a random field you can be walled into. */
        if (r % 4 === 2 && c % 5 === 3) { row.push(SH.SOLID); continue; }
        row.push(rnd() < 0.16 ? SH.CRATE : SH.EMPTY);
      }
      this.map.push(row);
    }
    // The two corners that matter are always clear.
    this.clearArea(2, 2, 3);
    this.clearArea(SH.COLS - 4, SH.ROWS - 4, 3);

    this.base = {
      x: (SH.COLS - 3.5) * SH.TILE, y: (SH.ROWS - 3.5) * SH.TILE,
      health: SH.BASE_HEALTH + level * 40, max: SH.BASE_HEALTH + level * 40,
      r: 34,
    };

    this.bullets = [];
    this.pickups = [];
    this.tanks.clear();
    if (this.player) {
      this.player.x = 2.5 * SH.TILE; this.player.y = 2.5 * SH.TILE;
      this.player.health = this.player.maxHealth;
      this.player.dead = false;
      this.player.safeUntil = Date.now() + SH.SPAWN_SAFE_MS;
      this.tanks.set(this.player.id, this.player);
    }
    // More enemies each level, and they hit a little harder.
    const n = Math.min(9, 2 + level);
    for (let i = 0; i < n; i++) this.spawnEnemy(rnd, level);
    this.state = 'playing';
  }

  clearArea(cx, cy, rad) {
    for (let r = cy - rad; r <= cy + rad; r++) {
      for (let c = cx - rad; c <= cx + rad; c++) {
        if (r <= 0 || c <= 0 || r >= SH.ROWS - 1 || c >= SH.COLS - 1) continue;
        this.map[r][c] = SH.EMPTY;
      }
    }
  }

  spawnEnemy(rnd, level) {
    for (let tries = 0; tries < 200; tries++) {
      const c = 2 + Math.floor(rnd() * (SH.COLS - 4));
      const r = 2 + Math.floor(rnd() * (SH.ROWS - 4));
      if (this.map[r][c] !== SH.EMPTY) continue;
      const x = (c + 0.5) * SH.TILE, y = (r + 0.5) * SH.TILE;
      if (this.player && Math.hypot(x - this.player.x, y - this.player.y) < 260) continue;
      const id = 'e' + (nextId++);
      this.tanks.set(id, {
        id, kind: 'enemy', x, y, angle: rnd() * Math.PI * 2, aim: 0,
        health: SH.ENEMY_HEALTH + level * 8, maxHealth: SH.ENEMY_HEALTH + level * 8,
        nextFire: 0, dead: false, wander: 0,
      });
      return;
    }
  }

  addPlayer(socket, name) {
    const p = {
      id: socket.id, kind: 'player', socket,
      name: String(name || 'Player').slice(0, 16),
      x: 2.5 * SH.TILE, y: 2.5 * SH.TILE,
      angle: 0, aim: 0,
      health: SH.PLAYER_HEALTH, maxHealth: SH.PLAYER_HEALTH,
      input: { up: 0, down: 0, left: 0, right: 0, fire: 0 },
      nextFire: 0, dead: false, deadUntil: 0, safeUntil: 0,
    };
    this.player = p;
    socket.join(this.socketRoomName);
    this.buildLevel(1);
    return p;
  }

  setInput(id, input) {
    const t = this.tanks.get(id);
    if (!t || t.kind !== 'player') return;
    t.input = {
      up: input.up ? 1 : 0, down: input.down ? 1 : 0,
      left: input.left ? 1 : 0, right: input.right ? 1 : 0,
      fire: input.fire ? 1 : 0,
    };
    if (typeof input.aim === 'number' && isFinite(input.aim)) t.aim = input.aim;
  }

  /* ── the map ─────────────────────────────────────────────────────────────── */

  cellAt(x, y) {
    const c = Math.floor(x / SH.TILE), r = Math.floor(y / SH.TILE);
    if (r < 0 || c < 0 || r >= SH.ROWS || c >= SH.COLS) return SH.SOLID;
    return this.map[r][c];
  }
  blocked(x, y) { return this.cellAt(x, y) !== SH.EMPTY; }

  /* Slide along a wall rather than sticking to it. Moving each axis separately
     is what turns "you are stuck on a corner" into "you slide past it", and it
     is the single biggest difference between a tank that feels good to drive
     and one that does not. */
  moveTank(t, dx, dy) {
    const r = SH.TANK_R;
    if (!this.blocked(t.x + dx + Math.sign(dx) * r, t.y + r * 0.7) &&
        !this.blocked(t.x + dx + Math.sign(dx) * r, t.y - r * 0.7)) t.x += dx;
    if (!this.blocked(t.x + r * 0.7, t.y + dy + Math.sign(dy) * r) &&
        !this.blocked(t.x - r * 0.7, t.y + dy + Math.sign(dy) * r)) t.y += dy;
  }

  /* ── the loop ────────────────────────────────────────────────────────────── */

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 1000 / SH.TICK_RATE);
  }
  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  tick() {
    const dt = 1 / SH.TICK_RATE;
    const now = Date.now();
    if (this.state === 'playing') {
      this.stepPlayer(dt, now);
      this.stepEnemies(dt, now);
      this.stepBullets(dt);
      this.stepPickups();
    }
    this.broadcast();
  }

  stepPlayer(dt, now) {
    const p = this.player;
    if (!p) return;
    if (p.dead) {
      if (now >= p.deadUntil) {
        p.dead = false; p.health = p.maxHealth;
        p.x = 2.5 * SH.TILE; p.y = 2.5 * SH.TILE;
        p.safeUntil = now + SH.SPAWN_SAFE_MS;
        this.tanks.set(p.id, p);
      }
      return;
    }
    const i = p.input;
    let dx = (i.right - i.left), dy = (i.down - i.up);
    if (dx || dy) {
      const len = Math.hypot(dx, dy);
      dx /= len; dy /= len;
      this.moveTank(p, dx * SH.PLAYER_SPEED * dt, dy * SH.PLAYER_SPEED * dt);
      /* The hull turns TOWARD where it is going rather than snapping. The
         turret is the mouse; the hull is the momentum. */
      p.angle = turnToward(p.angle, Math.atan2(dy, dx), SH.TURN_RATE * dt);
    }
    if (i.fire && now >= p.nextFire) {
      this.fireFrom(p, p.aim, this.weapon);
      p.nextFire = now + WEAPONS[this.weapon].cooldown;
    }
  }

  stepEnemies(dt, now) {
    const p = this.player;
    for (const t of this.tanks.values()) {
      if (t.kind !== 'enemy' || t.dead) continue;
      if (!p || p.dead) continue;
      const dist = Math.hypot(p.x - t.x, p.y - t.y);
      const sees = dist < SH.ENEMY_RANGE && this.lineOfSight(t.x, t.y, p.x, p.y);

      if (sees) {
        /* Close, but not on top of you: an enemy that drives into your barrel
           is free damage rather than a threat. It holds a firing distance. */
        const want = 190;
        const dir = dist > want ? 1 : -1;
        const a = Math.atan2(p.y - t.y, p.x - t.x);
        this.moveTank(t, Math.cos(a) * dir * SH.ENEMY_SPEED * dt,
                         Math.sin(a) * dir * SH.ENEMY_SPEED * dt);
        t.angle = turnToward(t.angle, a, SH.TURN_RATE * dt);
        t.aim = a;
        if (now >= t.nextFire) {
          this.fireFrom(t, a + (Math.random() - 0.5) * SH.ENEMY_SPREAD, 'cannon', true);
          t.nextFire = now + SH.ENEMY_FIRE_MS;
        }
      } else {
        // Wander, and change its mind now and then rather than pacing a groove.
        t.wander -= dt;
        if (t.wander <= 0) { t.wander = 1 + Math.random() * 2.5; t.angle = Math.random() * Math.PI * 2; }
        const before = { x: t.x, y: t.y };
        this.moveTank(t, Math.cos(t.angle) * SH.ENEMY_SPEED * 0.6 * dt,
                         Math.sin(t.angle) * SH.ENEMY_SPEED * 0.6 * dt);
        if (Math.hypot(t.x - before.x, t.y - before.y) < 0.4) t.wander = 0;  // wall: pick again
        t.aim = t.angle;
      }
    }
  }

  /* Walk the line in small steps and stop at the first wall. Coarse on purpose:
     an enemy that can shoot you through the corner of a crate is annoying, and
     one that needs a perfect view is a statue. */
  lineOfSight(x0, y0, x1, y1) {
    const d = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.ceil(d / (SH.TILE * 0.5));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      if (this.blocked(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)) return false;
    }
    return true;
  }

  fireFrom(t, angle, weaponKey, hostile) {
    const w = WEAPONS[weaponKey] || WEAPONS.cannon;
    for (let s = 0; s < w.shots; s++) {
      const spread = w.shots === 1 ? (Math.random() - 0.5) * w.spread
                                   : (s / (w.shots - 1) - 0.5) * w.spread * 2;
      const a = angle + spread;
      this.bullets.push({
        x: t.x + Math.cos(a) * (SH.TANK_R + 6),
        y: t.y + Math.sin(a) * (SH.TANK_R + 6),
        vx: Math.cos(a) * w.speed, vy: Math.sin(a) * w.speed,
        life: SH.BULLET_LIFE, dmg: hostile ? SH.ENEMY_DMG : w.damage,
        hostile: !!hostile, r: w.radius, from: t.id,
      });
    }
  }

  stepBullets(dt) {
    const keep = [];
    for (const b of this.bullets) {
      b.life -= dt;
      if (b.life <= 0) continue;
      b.x += b.vx * dt; b.y += b.vy * dt;

      // A wall? Crates break; solid stops it.
      const c = Math.floor(b.x / SH.TILE), r = Math.floor(b.y / SH.TILE);
      if (r < 0 || c < 0 || r >= SH.ROWS || c >= SH.COLS) continue;
      const cell = this.map[r][c];
      if (cell === SH.CRATE) { this.map[r][c] = SH.EMPTY; continue; }
      if (cell === SH.SOLID) continue;

      // A tank?
      let hitSomething = false;
      for (const t of this.tanks.values()) {
        if (t.dead) continue;
        if (b.hostile !== (t.kind === 'player')) continue;      // no friendly fire
        if (Math.hypot(t.x - b.x, t.y - b.y) > SH.TANK_R + b.r) continue;
        /* Just respawned: the shell is stopped, not ignored. Letting it pass
           through would have it carry on and hit you a frame after the shield
           expired, which is the same death with an extra step. */
        if (t.safeUntil && Date.now() < t.safeUntil) { hitSomething = true; break; }
        this.hurt(t, b.dmg);
        hitSomething = true;
        break;
      }
      if (hitSomething) continue;

      // The base?
      if (!b.hostile && this.base && this.base.health > 0 &&
          Math.hypot(this.base.x - b.x, this.base.y - b.y) < this.base.r + b.r) {
        this.base.health = Math.max(0, this.base.health - b.dmg);
        if (this.base.health === 0) this.clearLevel();
        continue;
      }
      keep.push(b);
    }
    this.bullets = keep;
  }

  hurt(t, dmg) {
    t.health -= dmg;
    if (t.health > 0) return;
    t.health = 0;
    t.dead = true;
    if (t.kind === 'enemy') {
      this.tanks.delete(t.id);
      this.pickups.push({ x: t.x, y: t.y, kind: 'coin', value: SH.COIN_VALUE });
      /* Every fourth kill, not a dice roll. A run where the health you get back
         depends on luck is a run you cannot plan, and a countable drop is one
         the player can hold out for. */
      this.kills++;
      if (this.kills % SH.REPAIR_EVERY === 0) {
        this.pickups.push({ x: t.x + 22, y: t.y, kind: 'repair', value: 0 });
      }
    } else {
      t.deadUntil = Date.now() + SH.RESPAWN_MS;
      /* Dying costs coins rather than the run. A level you have to restart from
         the top is how a free game gets closed rather than replayed. */
      this.coins = Math.max(0, this.coins - 25);
    }
  }

  stepPickups() {
    const p = this.player;
    if (!p || p.dead) return;
    this.pickups = this.pickups.filter(c => {
      if (Math.hypot(c.x - p.x, c.y - p.y) > 26) return true;
      /* A repair you cannot use is left on the floor, so it is still there
         when it is worth something. Driving over it at full health and
         silently wasting it is the sort of thing a player never forgives. */
      if (c.kind === 'repair') {
        if (p.health >= p.maxHealth) return true;
        p.health = Math.min(p.maxHealth, p.health + SH.REPAIR_HEAL);
        return false;
      }
      this.coins += c.value;
      return false;
    });
  }

  clearLevel() {
    this.state = 'cleared';
    this.coins += 60 + this.level * 15;
    this.broadcast('sh:cleared');
  }

  nextLevel() {
    if (this.state !== 'cleared') return false;
    this.level++;
    this.buildLevel(this.level);
    return true;
  }

  buy(key) {
    const w = WEAPONS[key];
    if (!w) return { ok: false, why: 'no such weapon' };
    if (this.owned.has(key)) { this.weapon = key; return { ok: true, equipped: key }; }
    if (this.coins < w.cost) return { ok: false, why: 'not enough coins' };
    this.coins -= w.cost;
    this.owned.add(key);
    this.weapon = key;
    return { ok: true, equipped: key };
  }

  /* ── talking to the client ───────────────────────────────────────────────── */

  snapshot() {
    const p = this.player;
    return {
      seq: ++this.seq,
      state: this.state,
      level: this.level,
      coins: this.coins,
      weapon: this.weapon,
      owned: [...this.owned],
      you: p ? { x: r1(p.x), y: r1(p.y), angle: r2(p.angle), aim: r2(p.aim),
                 health: Math.round(p.health), max: p.maxHealth, dead: !!p.dead,
                 safe: !!(p.safeUntil && Date.now() < p.safeUntil) } : null,
      tanks: [...this.tanks.values()].filter(t => t.kind === 'enemy').map(t => ({
        x: r1(t.x), y: r1(t.y), angle: r2(t.angle), aim: r2(t.aim),
        health: Math.round(t.health), max: t.maxHealth,
      })),
      bullets: this.bullets.map(b => [r1(b.x), r1(b.y), b.r, b.hostile ? 1 : 0]),
      coinsOnFloor: this.pickups.map(c => [r1(c.x), r1(c.y), c.kind === 'repair' ? 1 : 0]),
      base: this.base ? { x: r1(this.base.x), y: r1(this.base.y),
                          health: this.base.health, max: this.base.max, r: this.base.r } : null,
    };
  }

  /* The map is only sent when it changes shape, not thirty times a second. */
  mapPayload() {
    return { cols: SH.COLS, rows: SH.ROWS, tile: SH.TILE,
             cells: this.map.map(row => row.join('')).join('|'), level: this.level };
  }

  broadcast(extra) {
    this.io.to(this.socketRoomName).emit('sh:state', this.snapshot());
    if (extra) this.io.to(this.socketRoomName).emit(extra, {});
  }
}

function turnToward(a, target, max) {
  let d = target - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + Math.max(-max, Math.min(max, d));
}
function r1(v) { return Math.round(v * 10) / 10; }
function r2(v) { return Math.round(v * 100) / 100; }
function mulberry(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = { ShooterRoom, SH, WEAPONS };
