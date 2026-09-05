'use strict';
/* ─── OMG Shooter ─────────────────────────────────────────────────────────────
   A free-for-all tank arena. Everyone drops into one big round map, shoots
   everyone else, and banks what they are carrying by holding the square in the
   middle for five seconds.

   THE LOOP, WHICH IS THE WHOLE GAME. You carry coins. Coins come out of crates
   and out of other people, and a tank that dies drops everything it was
   carrying on the floor for whoever wants it. The only way to keep any of it is
   to drive into the middle of the map — the one place everybody can see and
   everybody is watching — and sit still for five seconds. Leaving resets the
   clock. So the richer you get, the more you have to lose by cashing out, and
   the more worth killing you are while you try.

   THE MAP IS A GRID OF 54s. That is the reference's tile size, and every wall,
   crate and barrel is one cell of it. Breaking a wall is setting a cell to 0,
   line of sight is a walk along cells, and the fog the player sees is that same
   walk run from their own tank — all three miserable with polygons, trivial
   here.

   WHAT IS AND IS NOT BORROWED. The look is Awesome Tanks 2's, measured off
   their sprite atlas (see public/js/shooterArt.js). The game is not: theirs is
   a single-player level campaign, this is a persistent arena with a bank in the
   middle. No code and no art was copied from it.

   THE SERVER SIMULATES. Clients send which keys are down and where they are
   aiming. They never say that a bullet hit, that a crate broke, that a coin was
   taken or that a cash-out finished. This mode is free today; the netcode is
   written the way it would have to be if it were not. */

const SH = {
  TILE: 54,                    // their tile, so every sprite lands on the grid
  COLS: 56, ROWS: 56,
  TICK_RATE: 30,               // nothing here is twitch-precise at 60

  /* Their body is 41 across on a 54 tile. A collision radius of 19 means a tank
     fits through a one-tile gap with a little room, which is what makes a gap a
     route rather than a fight with the geometry. */
  TANK_R: 19,
  SPEED: 158,                  // world units a second
  TURN_RATE: 6.2,              // radians a second the hull swings toward its heading
  HEALTH: 100,

  /* How far you can see down an open lane. Everything past it, and everything
     round a corner, is black. */
  SIGHT: 1000,

  RESPAWN_MS: 3200,
  SPAWN_SAFE_MS: 2000,
  SPAWN_CLEAR: 620,            // how far a spawn must be from anybody else

  /* The bank. Five seconds, and stepping out resets it — Owen's rule, and the
     reason the middle of the map is the most dangerous place on it. */
  CASHOUT_MS: 5000,
  /* Holding Q banks you where you stand. Owen asked for it in the free lobby
     and this arena is free-only, so it is always available here; the day one of
     these tables takes a stake, this is the flag that has to come off. */
  QUICK_BANK_MS: 1200,
  QUICK_BANK_ALLOWED: true,
  CASHOUT_HALF: 3 * 54,        // half-width of the square, in world units

  CRATE_COINS: 15,
  MEDKIT_HEAL: 35,
  PICKUP_R: 30,
  COIN_LIFE_MS: 45000,

  /* No bots. Owen asked for them gone: a free-for-all against robots is not
     the game, and an arena that is empty until somebody else turns up is at
     least honest about being empty. The machinery below is kept and driven by
     this one number, so putting them back is changing a 0 to a 4. */
  BOT_FLOOR: 0,

  EMPTY: 0, CRATE: 1, STONE: 2, BRICK: 3, WOOD: 4, BARREL: 5,
};

/* What it takes to break each kind. Stone is absent on purpose: a lookup that
   misses is a wall that does not break, which is exactly what stone is. */
const CELL_HP = { 1: 24, 3: 90, 4: 45, 5: 1 };

const BARREL_RADIUS = 130;
const BARREL_DAMAGE = 55;

/* ── the ten weapons ────────────────────────────────────────────────────────
   All free, and picked in the lobby rather than bought. A round is short and
   the point of ten of them is to play the same arena ten ways; putting a price
   on that would mean nine of them are things you read about rather than use.

   Four behaviours underneath: a projectile, a beam that hits down a line
   instantly, a chain that jumps between targets, and a mine that waits. */
const WEAPONS = {
  minigun:      { name: 'Minigun',      cooldown: 95,   damage: 6,  speed: 520, spread: 0.10, shots: 1, radius: 4 },
  shotgun:      { name: 'Shotgun',      cooldown: 780,  damage: 10, speed: 380, spread: 0.42, shots: 7, radius: 4, life: 0.42 },
  ricochet:     { name: 'Ricochet',     cooldown: 520,  damage: 18, speed: 420, spread: 0,    shots: 1, radius: 5, bounce: 4, life: 3.4 },
  flamethrower: { name: 'Flamethrower', cooldown: 50,   damage: 4,  speed: 300, spread: 0.30, shots: 1, radius: 9, life: 0.28 },
  cannon:       { name: 'Cannon',       cooldown: 640,  damage: 34, speed: 400, spread: 0,    shots: 1, radius: 6 },
  shock:        { name: 'Shock',        cooldown: 900,  damage: 24, kind: 'chain', chain: 3, range: 300 },
  rockets:      { name: 'Rockets',      cooldown: 880,  damage: 22, speed: 300, spread: 0.02, shots: 1, radius: 7, splash: 95, splashDmg: 34 },
  laser:        { name: 'Laser',        cooldown: 620,  damage: 30, kind: 'beam', range: 760 },
  railgun:      { name: 'Railgun',      cooldown: 1500, damage: 78, kind: 'beam', range: 1500, breaks: 1 },
  mines:        { name: 'Mines',        cooldown: 900,  damage: 70, kind: 'mine', radius: 105, arm: 900, life: 30 },
};
const WEAPON_KEYS = Object.keys(WEAPONS);

/* Effects the client draws for a few frames and then forgets. A beam and a
   chain land instantly, so there is no projectile to watch: without these the
   railgun would be a health bar dropping for no visible reason. */
const FX_BEAM = 0, FX_ZAP = 1, FX_BOOM = 2;
const FX_MS = 140;

const BOT_NAMES = ['Rusty', 'Crank', 'Bolt', 'Dozer', 'Wrench', 'Sparks',
                   'Grit', 'Tread', 'Piston', 'Scrap'];

let nextId = 1;

class ShooterRoom {
  constructor(io, roomId) {
    this.io = io;
    this.id = roomId || ('sh_' + (nextId++));
    this.socketRoomName = 'sh_' + this.id;
    this.tanks = new Map();        // id -> tank (players and bots alike)
    this.bullets = [];
    this.mines = [];
    this.pickups = [];
    this.fx = [];
    this.dirty = [];               // cells changed since the last broadcast
    this.timer = null;
    this.seq = 0;
    this.buildMap();
  }

  /* Every deadline in here — cooldowns, respawns, the spawn shield, the coin
     that fades off the floor — is read through this one method. Tests drive a
     room by stepping a fake clock; against a real Date.now() a synchronous tick
     loop advances no time at all, so nothing with a cooldown ever fires twice
     and a passing test proves nothing. */
  now() {
    return Date.now();
  }

  /* ── the arena ───────────────────────────────────────────────────────────
     Round, because a square arena has four corners nobody ever fights over.
     Stone outside the circle; inside, a ring of rooms, scattered cover, and the
     bank in the middle behind four walls with four ways in.

     Built from a fixed seed: the map is the same every round, which is what
     lets people learn it. An arena you cannot learn is one you cannot get good
     at, and getting good at it is the entire reason to come back. */
  buildMap() {
    const rnd = mulberry(20260905);
    const { COLS, ROWS } = SH;
    const cx = (COLS - 1) / 2, cy = (ROWS - 1) / 2;
    const R = Math.min(cx, cy) - 1.5;

    this.map = [];
    this.hp = [];
    for (let r = 0; r < ROWS; r++) {
      const row = [], hrow = [];
      for (let c = 0; c < COLS; c++) {
        row.push(Math.hypot(c - cx, r - cy) > R ? SH.STONE : SH.EMPTY);
        hrow.push(0);
      }
      this.map.push(row); this.hp.push(hrow);
    }

    const put = (c, r, v) => {
      if (c < 1 || r < 1 || c >= COLS - 1 || r >= ROWS - 1) return;
      if (Math.hypot(c - cx, r - cy) > R - 0.5) return;
      this.map[r][c] = v;
      this.hp[r][c] = CELL_HP[v] || 0;
    };

    /* Eight rooms round the ring, each a stone box with one side missing, so
       every one of them is a place to hide that is also a place to be cornered. */
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + 0.2;
      const rc = Math.round(cx + Math.cos(a) * R * 0.62);
      const rr2 = Math.round(cy + Math.sin(a) * R * 0.62);
      const w = 4 + Math.floor(rnd() * 3), h = 4 + Math.floor(rnd() * 3);
      const gap = Math.floor(rnd() * 4);
      for (let dc = -w; dc <= w; dc++) {
        for (let dr = -h; dr <= h; dr++) {
          if (Math.abs(dc) !== w && Math.abs(dr) !== h) continue;
          if (gap === 0 && dr === -h && Math.abs(dc) < 2) continue;
          if (gap === 1 && dr === h && Math.abs(dc) < 2) continue;
          if (gap === 2 && dc === -w && Math.abs(dr) < 2) continue;
          if (gap === 3 && dc === w && Math.abs(dr) < 2) continue;
          put(rc + dc, rr2 + dr, rnd() < 0.72 ? SH.STONE : SH.BRICK);
        }
      }
      // Something worth going in for.
      put(rc, rr2, SH.CRATE);
      put(rc + 1, rr2, rnd() < 0.5 ? SH.CRATE : SH.BARREL);
    }

    /* Scatter: crates to break, barrels to set off, wood and brick to hide
       behind until somebody takes it away from you. */
    for (let r = 2; r < ROWS - 2; r++) {
      for (let c = 2; c < COLS - 2; c++) {
        if (this.map[r][c] !== SH.EMPTY) continue;
        if (Math.hypot(c - cx, r - cy) > R - 2) continue;
        /* Density varies across the map instead of being the same everywhere.
           A uniform scatter gives you one texture of cover from wall to wall,
           and nowhere that feels like anything: no open ground to be caught
           on, no thicket to lose somebody in. Two slow waves crossed give
           plazas and tangles without hand-placing either. */
        const wave = Math.sin(c * 0.21 + 1.3) * Math.cos(r * 0.18)
                   + 0.5 * Math.sin((c + r) * 0.11);
        const dense = 0.5 + 0.42 * wave;              // about 0.05 .. 0.95
        const k = rnd() / (0.30 + dense * 1.15);   // ~4% cover in a plaza, ~25% in a thicket
        if (k < 0.035) put(c, r, SH.CRATE);
        else if (k < 0.055) put(c, r, SH.BARREL);
        else if (k < 0.085) put(c, r, SH.WOOD);
        else if (k < 0.105) put(c, r, SH.BRICK);
        else if (k < 0.125) put(c, r, SH.STONE);
      }
    }

    /* The bank, and the walls that make holding it a fight rather than a wait.
       Four short stone walls with a gap in the middle of each: cover from every
       direction and an approach from every direction, so nobody can seal it. */
    this.bank = { x: (cx + 0.5) * SH.TILE, y: (cy + 0.5) * SH.TILE, half: SH.CASHOUT_HALF };
    const mid = { c: Math.round(cx), r: Math.round(cy) }, outer = 5;
    for (let d = -outer; d <= outer; d++) {
      if (Math.abs(d) <= 1) continue;                // the way in
      put(mid.c + d, mid.r - outer, SH.STONE);
      put(mid.c + d, mid.r + outer, SH.STONE);
      put(mid.c - outer, mid.r + d, SH.STONE);
      put(mid.c + outer, mid.r + d, SH.STONE);
    }
    for (let r = mid.r - 4; r <= mid.r + 4; r++) {
      for (let c = mid.c - 4; c <= mid.c + 4; c++) {
        this.map[r][c] = SH.EMPTY; this.hp[r][c] = 0;
      }
    }

    this.sealPockets();
  }

  /* Scattering walls at random into a round arena leaves pockets: little bits
     of empty ground with no way in or out. On this map that was 169 cells, and
     a player who spawned in one could never reach the bank, never meet anybody,
     and never work out why. Filling them in is the honest fix — a sealed room
     is not a hiding place, it is a bug you can stand in.

     Flood from the bank rather than from a corner, because the bank is the one
     cell every player has to be able to reach. */
  sealPockets() {
    const C = SH.COLS, R = SH.ROWS;
    const seen = new Uint8Array(C * R);
    const start = Math.floor(this.bank.y / SH.TILE) * C + Math.floor(this.bank.x / SH.TILE);
    const q = [start];
    seen[start] = 1;
    while (q.length) {
      const k = q.pop(), r = (k / C) | 0, c = k % C;
      const nb = [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]];
      for (const [nr, nc] of nb) {
        if (nr < 0 || nc < 0 || nr >= R || nc >= C) continue;
        const nk = nr * C + nc;
        if (seen[nk] || this.map[nr][nc] !== SH.EMPTY) continue;
        seen[nk] = 1;
        q.push(nk);
      }
    }
    for (let r = 0; r < R; r++) {
      for (let c = 0; c < C; c++) {
        if (this.map[r][c] === SH.EMPTY && !seen[r * C + c]) {
          this.map[r][c] = SH.STONE; this.hp[r][c] = 0;
        }
      }
    }
  }

  /* ── cells ───────────────────────────────────────────────────────────────── */

  cellAt(x, y) {
    const c = Math.floor(x / SH.TILE), r = Math.floor(y / SH.TILE);
    if (r < 0 || c < 0 || r >= SH.ROWS || c >= SH.COLS) return SH.STONE;
    return this.map[r][c];
  }
  blocked(x, y) { return this.cellAt(x, y) !== SH.EMPTY; }

  setCell(r, c, v) {
    this.map[r][c] = v;
    this.hp[r][c] = CELL_HP[v] || 0;
    this.dirty.push(r * SH.COLS + c, v);
  }

  /* Everything that breaks, breaks here. Stone returns false and is the reason
     an arena stays an arena. */
  damageCell(r, c, dmg) {
    if (r < 0 || c < 0 || r >= SH.ROWS || c >= SH.COLS) return false;
    const v = this.map[r][c];
    if (v === SH.EMPTY || v === SH.STONE) return false;
    if (v === SH.BARREL) { this.blowBarrel(r, c); return true; }
    this.hp[r][c] -= dmg;
    if (this.hp[r][c] > 0) return true;
    this.setCell(r, c, SH.EMPTY);
    const x = (c + 0.5) * SH.TILE, y = (r + 0.5) * SH.TILE;
    /* A crate is worth opening: coins, and a med kit, which is the only way to
       get health back in an arena with no regeneration at all. */
    if (v === SH.CRATE) {
      this.pickups.push(coin(x - 12, y, SH.CRATE_COINS, this.now()));
      this.pickups.push({ x: x + 14, y, kind: 'medkit', born: this.now() });
    }
    return true;
  }

  blowBarrel(r, c) {
    this.setCell(r, c, SH.EMPTY);
    this.explode((c + 0.5) * SH.TILE, (r + 0.5) * SH.TILE,
                 BARREL_RADIUS, BARREL_DAMAGE, null);
  }

  /* A blast is nobody's side: it takes whoever set it off too, which is the
     whole reason standing next to a barrel is a decision. */
  explode(x, y, radius, dmg, byId) {
    this.addFx(FX_BOOM, [Math.round(x), Math.round(y), Math.round(radius)]);
    const now = this.now();
    for (const t of [...this.tanks.values()]) {
      if (t.dead || (t.safeUntil && now < t.safeUntil)) continue;
      const d = Math.hypot(t.x - x, t.y - y);
      if (d > radius) continue;
      this.hurt(t, Math.round(dmg * (1 - d / radius) * 1.25) || 1, byId);
    }
    const rad = Math.ceil(radius / SH.TILE);
    const cc = Math.floor(x / SH.TILE), cr = Math.floor(y / SH.TILE);
    for (let r = cr - rad; r <= cr + rad; r++) {
      for (let c = cc - rad; c <= cc + rad; c++) {
        if (Math.hypot((c + 0.5) * SH.TILE - x, (r + 0.5) * SH.TILE - y) > radius) continue;
        this.damageCell(r, c, dmg);
      }
    }
  }

  addFx(kind, args) { this.fx.push({ k: kind, a: args, until: this.now() + FX_MS }); }

  /* ── who is in it ────────────────────────────────────────────────────────── */

  makeTank(id, name, weapon, bot) {
    const t = {
      id, name: String(name || 'Player').slice(0, 16),
      bot: !!bot,
      weapon: WEAPONS[weapon] ? weapon : 'cannon',
      x: 0, y: 0, hull: 0, aim: 0, roll: 0,
      health: SH.HEALTH, maxHealth: SH.HEALTH,
      coins: 0, banked: 0, kills: 0, deaths: 0,
      input: { up: 0, down: 0, left: 0, right: 0, fire: 0, bank: 0 },
      nextFire: 0, dead: false, deadUntil: 0, safeUntil: 0,
      cashMs: 0, quickMs: 0, wander: 0, waiting: false,
    };
    this.tanks.set(id, t);
    this.place(t);
    return t;
  }

  addPlayer(socket, name, weapon) {
    const t = this.makeTank(socket.id, name, weapon, false);
    t.socket = socket;
    socket.join(this.socketRoomName);
    this.topUpBots();
    this.start();
    return t;
  }

  removePlayer(id) {
    const t = this.tanks.get(id);
    if (!t) return;
    /* Whatever they were carrying stays on the floor. Quitting is not a way to
       keep coins you have not banked — that would make the bank optional, and
       the bank is the game. */
    if (!t.dead && t.coins > 0) this.pickups.push(coin(t.x, t.y, t.coins, this.now()));
    this.tanks.delete(id);
    /* An empty arena still ticks thirty times a second and still drives five
       bots around, for nobody. The room is one per region and lives for the
       life of the process, so it has to know how to go quiet. */
    if (this.humans() === 0) {
      this.stop();
      this.tanks.clear();
      this.bullets.length = 0; this.mines.length = 0;
      this.pickups.length = 0; this.fx.length = 0;
      this.buildMap();
      return;
    }
    this.topUpBots();
  }

  humans() { let n = 0; for (const t of this.tanks.values()) if (!t.bot) n++; return n; }

  /* An arena with one person in it is not an arena. Bots keep it populated to a
     floor and stand down as real players arrive, so the first person through
     the door still has a game and the tenth is not fighting robots. */
  topUpBots() {
    const want = Math.max(0, SH.BOT_FLOOR - this.humans() + 1);
    const bots = [...this.tanks.values()].filter(t => t.bot);
    for (let i = bots.length; i < want; i++) {
      this.makeTank('bot' + (nextId++),
        BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)],
        WEAPON_KEYS[Math.floor(Math.random() * WEAPON_KEYS.length)], true);
    }
    for (let i = bots.length; i > want; i--) this.tanks.delete(bots[i - 1].id);
  }

  /* Somewhere empty, and away from everybody. Dropping in next to a full-health
     tank holding a railgun is not a spawn, it is a death. */
  place(t) {
    const cx = (SH.COLS - 1) / 2, cy = (SH.ROWS - 1) / 2;
    const R = Math.min(cx, cy) - 3;
    for (let tries = 0; tries < 400; tries++) {
      const a = Math.random() * Math.PI * 2;
      const d = (0.45 + Math.random() * 0.5) * R;         // never in the middle
      const c = Math.round(cx + Math.cos(a) * d), r = Math.round(cy + Math.sin(a) * d);
      if (r < 1 || c < 1 || r >= SH.ROWS - 1 || c >= SH.COLS - 1) continue;
      if (this.map[r][c] !== SH.EMPTY) continue;
      const x = (c + 0.5) * SH.TILE, y = (r + 0.5) * SH.TILE;
      let near = false;
      for (const o of this.tanks.values()) {
        if (o === t || o.dead) continue;
        if (Math.hypot(o.x - x, o.y - y) < SH.SPAWN_CLEAR) { near = true; break; }
      }
      if (near && tries < 300) continue;
      t.x = x; t.y = y;
      t.health = t.maxHealth;
      t.dead = false;
      t.cashMs = 0;
      t.safeUntil = this.now() + SH.SPAWN_SAFE_MS;
      return;
    }
    t.x = (cx + 0.5) * SH.TILE; t.y = (cy + 0.5) * SH.TILE;
    t.dead = false; t.health = t.maxHealth;
  }

  setInput(id, input) {
    const t = this.tanks.get(id);
    if (!t || t.bot) return;
    t.input = {
      up: input.up ? 1 : 0, down: input.down ? 1 : 0,
      left: input.left ? 1 : 0, right: input.right ? 1 : 0,
      fire: input.fire ? 1 : 0, bank: input.bank ? 1 : 0,
    };
    if (typeof input.aim === 'number' && isFinite(input.aim)) t.aim = input.aim;
  }

  setWeapon(id, key) {
    const t = this.tanks.get(id);
    if (!t || !WEAPONS[key]) return false;
    t.weapon = key;
    return true;
  }

  /* ── moving ──────────────────────────────────────────────────────────────
     Each axis separately, so a tank slides along a wall instead of welding
     itself to every corner. This is the single biggest difference between a
     tank that feels good to drive and one that does not. */
  moveTank(t, dx, dy) {
    const r = SH.TANK_R;
    const x0 = t.x, y0 = t.y;
    if (!this.blocked(t.x + dx + Math.sign(dx) * r, t.y + r * 0.7) &&
        !this.blocked(t.x + dx + Math.sign(dx) * r, t.y - r * 0.7)) t.x += dx;
    if (!this.blocked(t.x + r * 0.7, t.y + dy + Math.sign(dy) * r) &&
        !this.blocked(t.x - r * 0.7, t.y + dy + Math.sign(dy) * r)) t.y += dy;
    return Math.hypot(t.x - x0, t.y - y0);
  }

  /* ── the loop ────────────────────────────────────────────────────────────── */

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 1000 / SH.TICK_RATE);
  }
  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  tick() {
    const dt = 1 / SH.TICK_RATE;
    const now = this.now();
    for (const t of this.tanks.values()) {
      /* A dead player stays dead until they ask to come back. Being thrown
         into the arena again the instant you die takes the decision away from
         you, and the decision is the whole of "do I want another go". */
      if (t.dead) { if (t.bot && now >= t.deadUntil) this.place(t); continue; }
      if (t.bot) this.driveBot(t, dt, now); else this.drivePlayer(t, dt, now);
      this.stepCashout(t, dt);
    }
    this.stepBullets(dt, now);
    this.stepMines(now);
    this.stepPickups(now);
    if (this.fx.length) this.fx = this.fx.filter(f => f.until > now);
    this.broadcast();
    this.dirty.length = 0;
  }

  drivePlayer(t, dt, now) {
    const i = t.input;
    let dx = (i.right - i.left), dy = (i.down - i.up);
    if (dx || dy) {
      const len = Math.hypot(dx, dy);
      dx /= len; dy /= len;
      t.roll += this.moveTank(t, dx * SH.SPEED * dt, dy * SH.SPEED * dt);
      /* The hull turns TOWARD where it is going rather than snapping. The
         turret is the mouse; the hull is the momentum. */
      t.hull = turnToward(t.hull, Math.atan2(dy, dx), SH.TURN_RATE * dt);
    }
    if (i.fire && now >= t.nextFire) {
      this.fireFrom(t, t.aim, t.weapon);
      t.nextFire = now + WEAPONS[t.weapon].cooldown;
    }
  }

  /* Bots are not meant to be good. They are meant to make an empty arena feel
     like an arena: they wander, they shoot at what they can actually see, and
     they mostly lose. A bot that plays well in a free-for-all is a bot that
     farms the one human in the room. */
  driveBot(t, dt, now) {
    let target = null, best = 620;
    for (const o of this.tanks.values()) {
      if (o === t || o.dead) continue;
      const d = Math.hypot(o.x - t.x, o.y - t.y);
      if (d >= best || !this.lineOfSight(t.x, t.y, o.x, o.y)) continue;
      target = o; best = d;
    }
    if (target) {
      const a = Math.atan2(target.y - t.y, target.x - t.x);
      const dir = best > 230 ? 1 : -1;
      t.roll += this.moveTank(t, Math.cos(a) * dir * SH.SPEED * 0.62 * dt,
                                 Math.sin(a) * dir * SH.SPEED * 0.62 * dt);
      t.hull = turnToward(t.hull, a, SH.TURN_RATE * dt);
      t.aim = a + (Math.random() - 0.5) * 0.16;
      if (now >= t.nextFire) {
        this.fireFrom(t, t.aim, t.weapon);
        t.nextFire = now + WEAPONS[t.weapon].cooldown * 1.6;
      }
      return;
    }
    t.wander -= dt;
    if (t.wander <= 0) { t.wander = 1.2 + Math.random() * 2.5; t.hull = Math.random() * Math.PI * 2; }
    const moved = this.moveTank(t, Math.cos(t.hull) * SH.SPEED * 0.5 * dt,
                                   Math.sin(t.hull) * SH.SPEED * 0.5 * dt);
    t.roll += moved;
    if (moved < 0.4) t.wander = 0;                    // a wall: pick again
    t.aim = t.hull;
  }

  /* ── the bank ───────────────────────────────────────────────────────────── */

  inBank(t) {
    return Math.abs(t.x - this.bank.x) <= this.bank.half &&
           Math.abs(t.y - this.bank.y) <= this.bank.half;
  }

  stepCashout(t, dt) {
    /* Two ways to bank, and they share one bar so the screen only ever has one
       thing to say. Standing in the square is the slow public one everybody can
       see you doing; holding Q is the quick private one, and it exists because
       this table is free and a free game should not make you drive across a map
       to keep fifteen coins. */
    if (t.coins <= 0) { t.cashMs = 0; t.quickMs = 0; return; }

    if (SH.QUICK_BANK_ALLOWED && t.input && t.input.bank) {
      t.quickMs += dt * 1000;
      t.cashMs = 0;
      if (t.quickMs >= SH.QUICK_BANK_MS) this.bankCoins(t, 'held Q');
      return;
    }
    t.quickMs = 0;

    if (!this.inBank(t)) { t.cashMs = 0; return; }
    t.cashMs += dt * 1000;
    if (t.cashMs >= SH.CASHOUT_MS) this.bankCoins(t, 'the middle');
  }

  /* Named bankCoins, not bank: this.bank is already the square in the middle
     of the map, and a method that shares a name with a property is a method the
     property quietly deletes. The tests caught it; nothing else would have. */
  bankCoins(t, how) {
    const took = t.coins;
    if (took <= 0) return;
    t.banked += took;
    t.coins = 0;
    t.cashMs = 0;
    t.quickMs = 0;
    t.bankedAt = this.now();
    t.bankedLast = took;
    this.io.to(this.socketRoomName).emit('sh:banked',
      { name: t.name, amount: took, total: t.banked, how });
  }

  /* Asked for by a dead player, so nothing puts them back in the arena until
     they say so. Refused for anybody who is not actually dead. */
  respawn(id) {
    const t = this.tanks.get(id);
    if (!t || !t.dead) return false;
    this.place(t);
    return true;
  }

  /* ── shooting ───────────────────────────────────────────────────────────── */

  lineOfSight(x0, y0, x1, y1) {
    const d = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.ceil(d / (SH.TILE * 0.5));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      if (this.blocked(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)) return false;
    }
    return true;
  }

  fireFrom(t, angle, weaponKey) {
    const w = WEAPONS[weaponKey] || WEAPONS.cannon;
    if (w.kind === 'beam') return this.fireBeam(t, angle, w);
    if (w.kind === 'chain') return this.fireChain(t, w);
    if (w.kind === 'mine') return this.dropMine(t, w);

    const shots = w.shots || 1;
    for (let s = 0; s < shots; s++) {
      const spread = shots === 1 ? (Math.random() - 0.5) * (w.spread || 0)
                                 : (s / (shots - 1) - 0.5) * (w.spread || 0) * 2;
      const a = angle + spread;
      this.bullets.push({
        x: t.x + Math.cos(a) * (SH.TANK_R + 8),
        y: t.y + Math.sin(a) * (SH.TANK_R + 8),
        vx: Math.cos(a) * w.speed, vy: Math.sin(a) * w.speed,
        life: w.life || 2.4, dmg: w.damage, r: w.radius, from: t.id,
        bounce: w.bounce || 0, splash: w.splash || 0, splashDmg: w.splashDmg || 0,
      });
    }
  }

  /* Instant, down a line, and the only thing that stops it is stone — except
     the railgun, which takes the brick with it. */
  fireBeam(t, angle, w) {
    const dx = Math.cos(angle), dy = Math.sin(angle);
    const hit = new Set();
    let end = w.range;
    for (let d = SH.TANK_R; d <= w.range; d += 7) {
      const x = t.x + dx * d, y = t.y + dy * d;
      const c = Math.floor(x / SH.TILE), r = Math.floor(y / SH.TILE);
      if (r < 0 || c < 0 || r >= SH.ROWS || c >= SH.COLS) { end = d; break; }
      const cell = this.map[r][c];
      if (cell === SH.STONE) { end = d; break; }
      if (cell !== SH.EMPTY) {
        this.damageCell(r, c, w.damage);
        if (!w.breaks) { end = d; break; }
      }
      for (const o of this.tanks.values()) {
        if (o === t || o.dead || hit.has(o.id)) continue;
        if (Math.hypot(o.x - x, o.y - y) > SH.TANK_R) continue;
        hit.add(o.id);
        this.hurt(o, w.damage, t.id);
      }
    }
    this.addFx(FX_BEAM, [Math.round(t.x), Math.round(t.y),
                         Math.round(t.x + dx * end), Math.round(t.y + dy * end),
                         w.breaks ? 1 : 0]);
  }

  /* Finds a target rather than being aimed at one, then jumps. Its weakness is
     that it needs something to jump TO, which is the trade for never having to
     aim it. */
  fireChain(t, w) {
    const pts = [Math.round(t.x), Math.round(t.y)];
    let from = t;
    const hit = new Set();
    for (let n = 0; n < w.chain; n++) {
      let best = null, bestD = w.range;
      for (const o of this.tanks.values()) {
        if (o === t || o.dead || hit.has(o.id)) continue;
        const d = Math.hypot(o.x - from.x, o.y - from.y);
        if (d >= bestD || !this.lineOfSight(from.x, from.y, o.x, o.y)) continue;
        best = o; bestD = d;
      }
      if (!best) break;
      hit.add(best.id);
      pts.push(Math.round(best.x), Math.round(best.y));
      this.hurt(best, w.damage, t.id);
      from = best;
    }
    if (pts.length > 2) this.addFx(FX_ZAP, pts);
  }

  dropMine(t, w) {
    const now = this.now();
    this.mines.push({ x: t.x, y: t.y, from: t.id, armAt: now + w.arm,
                      dieAt: now + w.life * 1000, radius: w.radius, damage: w.damage });
  }

  stepMines(now) {
    if (!this.mines.length) return;
    const keep = [];
    for (const m of this.mines) {
      if (now > m.dieAt) continue;
      if (now >= m.armAt) {
        let tripped = false;
        for (const t of this.tanks.values()) {
          if (t.dead || t.id === m.from) continue;
          if (Math.hypot(t.x - m.x, t.y - m.y) > 34) continue;
          tripped = true; break;
        }
        if (tripped) { this.explode(m.x, m.y, m.radius, m.damage, m.from); continue; }
      }
      keep.push(m);
    }
    this.mines = keep;
  }

  stepBullets(dt, now) {
    const keep = [];
    for (const b of this.bullets) {
      b.life -= dt;
      if (b.life <= 0) continue;
      const px = b.x, py = b.y;
      b.x += b.vx * dt; b.y += b.vy * dt;

      const c = Math.floor(b.x / SH.TILE), r = Math.floor(b.y / SH.TILE);
      if (r < 0 || c < 0 || r >= SH.ROWS || c >= SH.COLS) continue;
      const cell = this.map[r][c];
      if (cell !== SH.EMPTY) {
        if (cell === SH.STONE && b.bounce > 0) {
          /* Which wall it met, decided by which axis crossed a tile line. On a
             grid this is exact and free; working it out from a surface normal
             is neither. */
          if (Math.floor(px / SH.TILE) !== c) b.vx = -b.vx; else b.vy = -b.vy;
          b.x = px; b.y = py;
          b.bounce--;
          keep.push(b);
          continue;
        }
        if (cell !== SH.STONE) this.damageCell(r, c, b.dmg);
        if (b.splash) this.explode(b.x, b.y, b.splash, b.splashDmg, b.from);
        continue;
      }

      let done = false;
      for (const t of this.tanks.values()) {
        if (t.dead || t.id === b.from) continue;
        if (Math.hypot(t.x - b.x, t.y - b.y) > SH.TANK_R + b.r) continue;
        /* Just respawned: the shell is stopped, not ignored. Letting it pass
           through would hit them a frame after the shield expired, which is the
           same death with an extra step. */
        if (t.safeUntil && now < t.safeUntil) { done = true; break; }
        if (b.splash) this.explode(b.x, b.y, b.splash, b.splashDmg, b.from);
        else this.hurt(t, b.dmg, b.from);
        done = true;
        break;
      }
      if (done) continue;
      keep.push(b);
    }
    this.bullets = keep;
  }

  hurt(t, dmg, byId) {
    if (t.dead) return;
    t.health -= dmg;
    if (t.health > 0) return;
    t.health = 0;
    t.dead = true;
    t.deaths++;
    t.deadUntil = this.now() + SH.RESPAWN_MS;
    t.cashMs = 0;
    /* Everything they were carrying hits the floor as one coin, worth what the
       tank was worth. That is the whole economy: you are not paid for the kill,
       you are paid for driving over what fell out of it. */
    if (t.coins > 0) {
      this.pickups.push(coin(t.x, t.y, t.coins, this.now()));
      t.coins = 0;
    }
    const killer = byId && byId !== t.id ? this.tanks.get(byId) : null;
    if (killer) killer.kills++;
    this.io.to(this.socketRoomName).emit('sh:killed',
      { name: t.name, by: killer ? killer.name : null });
  }

  stepPickups(now) {
    if (!this.pickups.length) return;
    this.pickups = this.pickups.filter(p => {
      if (p.kind === 'coin' && now - p.born > SH.COIN_LIFE_MS) return false;
      for (const t of this.tanks.values()) {
        if (t.dead) continue;
        if (Math.hypot(p.x - t.x, p.y - t.y) > SH.PICKUP_R) continue;
        if (p.kind === 'medkit') {
          /* A med kit you cannot use is left where it is, so it is still there
             when it is worth something. Driving over it at full health and
             silently wasting it is the sort of thing nobody forgives. */
          if (t.health >= t.maxHealth) continue;
          t.health = Math.min(t.maxHealth, t.health + SH.MEDKIT_HEAL);
        } else {
          t.coins += p.value;
        }
        return false;
      }
      return true;
    });
  }

  /* ── talking to the client ───────────────────────────────────────────────
     Everyone's position goes to everyone, because the minimap shows every tank
     by design — Owen's rule, and the thing that stops a big arena becoming
     twenty minutes of driving. The fog is about SIGHT LINES: you know roughly
     where people are and still cannot shoot round a corner at them. */

  snapshot(forId) {
    const me = this.tanks.get(forId);
    const now = this.now();
    return {
      seq: ++this.seq,
      you: me ? {
        x: r1(me.x), y: r1(me.y), hull: r2(me.hull), aim: r2(me.aim), roll: r1(me.roll),
        hp: Math.round(me.health), max: me.maxHealth,
        coins: me.coins, banked: me.banked, kills: me.kills, weapon: me.weapon,
        dead: !!me.dead, respawn: me.dead ? Math.max(0, me.deadUntil - now) : 0,
        safe: !!(me.safeUntil && now < me.safeUntil),
        cash: me.cashMs > 0 ? Math.min(1, me.cashMs / SH.CASHOUT_MS) : 0,
        quick: me.quickMs > 0 ? Math.min(1, me.quickMs / SH.QUICK_BANK_MS) : 0,
        banked_ms: me.bankedAt ? now - me.bankedAt : 99999,
        banked_last: me.bankedLast || 0,
      } : null,
      tanks: [...this.tanks.values()].filter(t => t.id !== forId && !t.dead).map(t => ({
        id: t.id, n: t.name, x: r1(t.x), y: r1(t.y), h: r2(t.hull), a: r2(t.aim),
        hp: Math.round(t.health), max: t.maxHealth, w: t.weapon, r: r1(t.roll),
        c: t.cashMs > 0 ? 1 : 0,
      })),
      bullets: this.bullets.map(b => [r1(b.x), r1(b.y), b.r]),
      mines: this.mines.map(m => [r1(m.x), r1(m.y), now >= m.armAt ? 1 : 0]),
      pickups: this.pickups.map(p => [r1(p.x), r1(p.y), p.kind === 'medkit' ? 1 : 0, p.value || 0]),
      fx: this.fx.map(f => [f.k].concat(f.a)),
      cells: this.dirty.length ? this.dirty.slice() : null,
      board: [...this.tanks.values()]
        .sort((a, b) => (b.banked - a.banked) || (b.kills - a.kills))
        .slice(0, 6)
        .map(t => ({ n: t.name, b: t.banked, k: t.kills, me: t.id === forId ? 1 : 0 })),
    };
  }

  /* The map is sent once, as a string, and patched by `cells` after that. */
  mapPayload() {
    return {
      cols: SH.COLS, rows: SH.ROWS, tile: SH.TILE,
      cells: this.map.map(row => row.join('')).join('|'),
      bank: { x: this.bank.x, y: this.bank.y, half: this.bank.half },
      cashoutMs: SH.CASHOUT_MS,
      sight: SH.SIGHT,
    };
  }

  /* One encode per socket, because every snapshot carries that player's own
     `you`. With ten tanks in a room that is ten small encodes a frame, which is
     nothing; the interest-group machinery the snake game needs starts paying
     for itself at a hundred, and this arena does not hold a hundred. */
  broadcast() {
    for (const t of this.tanks.values()) {
      if (!t.socket) continue;
      t.socket.volatile.emit('sh:state', this.snapshot(t.id));
    }
  }
}

function coin(x, y, value, at) { return { x, y, kind: 'coin', value, born: at }; }
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

module.exports = { ShooterRoom, SH, WEAPONS, WEAPON_KEYS, CELL_HP };
