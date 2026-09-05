'use strict';
/* ─── Tanks ───────────────────────────────────────────────────────────────────
   An artillery duel. Two tanks sit on a hillside, take turns picking an angle
   and a power, and lob a shell over the ground between them. The shell arcs
   under gravity, the wind pushes it sideways, and where it lands it blows a hole
   in the hill and hurts whoever is standing near it. First to knock the other
   down to nothing wins.

   WHY THIS SHAPE. It is a duel — two people, alternating turns — so it needs
   none of the machinery the arena games need: no interest groups, no 60Hz
   snapshots, no client prediction, no reconciliation. A turn is one message.
   That is what makes it a sensible first game to add beyond the two big ones,
   and it is why almost none of this file looks like GameRoom.

   EVERYTHING THAT MATTERS IS DECIDED HERE. The client draws the terrain and
   animates the shell, but it is the server that flies it: the client is handed
   the whole trajectory after the fact and plays it back. A client cannot miss on
   purpose and report a hit, cannot claim damage it did not do, and cannot see
   where a shell will land before the server has already decided. On a product
   that pays out real money that is not paranoia, it is the only defensible
   arrangement.

   The terrain is a HEIGHTMAP — one ground height per column — rather than a
   polygon soup. Destruction is then just lowering some columns, collapse is
   just settling them, and "did the shell hit the ground" is one comparison. It
   is the oldest trick in artillery games and it is still the right one. */

const TANKS = {
  /* The battlefield, in world units. Wider than it is tall because the whole
     game is horizontal distance and the arc over it. */
  W: 1400,
  H: 700,
  COLS: 280,                  // heightmap resolution: 5 units per column
  GROUND_MIN: 90,             // never so low there is nothing to stand on
  GROUND_MAX: 430,            // nor so high a tank cannot see over it

  TANK_W: 34,
  TANK_H: 16,
  MAX_HEALTH: 100,

  GRAVITY: 220,               // units per second squared
  WIND_MAX: 55,               // sideways acceleration, re-rolled every turn
  SHELL_STEP: 1 / 120,        // seconds per physics step
  SHELL_MAX_TIME: 20,         // a shot that has not landed by now has left

  POWER_MIN: 10,
  POWER_MAX: 100,
  POWER_SCALE: 5.2,           // power 100 -> 520 units/sec muzzle speed

  BLAST_RADIUS: 52,
  DIRECT_DAMAGE: 46,          // at the centre of the blast
  TURN_MS: 45 * 1000,         // long enough to aim, short enough to keep moving
  FALL_DAMAGE_PER_UNIT: 0.12, // a tank dropped by a crater takes some of it
};

let nextId = 1;

class TanksRoom {
  constructor(io, roomId) {
    this.io = io;
    this.id = roomId || ('tanks_' + (nextId++));
    this.socketRoomName = 'tanks_' + this.id;
    this.state = 'waiting';          // waiting | playing | over
    this.players = new Map();        // socketId -> { socket, name, wallet, health, x, angle, power, side }
    this.turn = null;                // socketId whose turn it is
    this.turnEndsAt = 0;
    this.wind = 0;
    this.winner = null;
    this.stake = 0;                  // free while the mode is new
    this.ground = new Array(TANKS.COLS).fill(0);
    this.lastShot = null;
  }

  /* ── the hill ───────────────────────────────────────────────────────────
     A few sine waves of different lengths added together. Not noise: noise
     gives you gravel, and what an artillery game wants is a handful of big
     smooth shapes to shoot over and hide behind. */
  generateTerrain(seed) {
    const rnd = mulberry(seed || Date.now());
    const waves = [
      { amp: 70 + rnd() * 60, len: 1.0, phase: rnd() * Math.PI * 2 },
      { amp: 34 + rnd() * 40, len: 2.3, phase: rnd() * Math.PI * 2 },
      { amp: 16 + rnd() * 20, len: 4.7, phase: rnd() * Math.PI * 2 },
      { amp: 7 + rnd() * 10,  len: 9.1, phase: rnd() * Math.PI * 2 },
    ];
    const mid = (TANKS.GROUND_MIN + TANKS.GROUND_MAX) / 2;
    for (let i = 0; i < TANKS.COLS; i++) {
      const u = i / (TANKS.COLS - 1);
      let h = mid;
      for (const w of waves) h += Math.sin(u * Math.PI * 2 * w.len + w.phase) * w.amp;
      this.ground[i] = clamp(h, TANKS.GROUND_MIN, TANKS.GROUND_MAX);
    }
  }

  colAt(x) { return clamp(Math.round(x / TANKS.W * (TANKS.COLS - 1)), 0, TANKS.COLS - 1); }
  xOfCol(i) { return i / (TANKS.COLS - 1) * TANKS.W; }
  groundAt(x) { return this.ground[this.colAt(x)]; }

  /* ── players ────────────────────────────────────────────────────────────── */

  addPlayer(socket, name, wallet) {
    if (this.players.size >= 2) return null;
    const side = this.players.size === 0 ? 'left' : 'right';
    /* Placed a little in from the edges, and never on top of each other. Firing
       from the very corner leaves no room to be pushed back by a near miss. */
    const x = side === 'left'
      ? TANKS.W * (0.10 + Math.random() * 0.10)
      : TANKS.W * (0.80 + Math.random() * 0.10);
    const p = {
      socket, name: String(name || 'Player').slice(0, 16),
      wallet: wallet || null,
      health: TANKS.MAX_HEALTH,
      x, side,
      angle: side === 'left' ? 45 : 135,     // pointing at each other to start
      power: 55,
      ready: false,
    };
    this.players.set(socket.id, p);
    socket.join(this.socketRoomName);
    return p;
  }

  removePlayer(socketId) {
    const p = this.players.get(socketId);
    if (!p) return;
    this.players.delete(socketId);
    /* Leaving mid-match is a loss. Otherwise the losing move is always to close
       the tab, which on a game with money on it is the only bug that matters. */
    if (this.state === 'playing') {
      const other = [...this.players.values()][0];
      this.finish(other ? other.socket.id : null, 'opponent left');
    }
  }

  opponentOf(socketId) {
    for (const [id, p] of this.players) if (id !== socketId) return p;
    return null;
  }

  /* ── the match ──────────────────────────────────────────────────────────── */

  start(seed) {
    if (this.players.size !== 2) return false;
    this.generateTerrain(seed);
    for (const p of this.players.values()) p.health = TANKS.MAX_HEALTH;
    this.settleTanks();
    this.state = 'playing';
    this.winner = null;
    // Whoever joined first shoots first; the wind is re-rolled every turn anyway.
    this.turn = [...this.players.keys()][0];
    this.rollWind();
    this.turnEndsAt = Date.now() + TANKS.TURN_MS;
    this.broadcast('tanks:start', this.fullState());
    return true;
  }

  rollWind() {
    this.wind = Math.round((Math.random() * 2 - 1) * TANKS.WIND_MAX);
  }

  /* Tanks sit ON the ground, so after any terrain change they drop to it. */
  settleTanks() {
    for (const p of this.players.values()) {
      const g = this.groundAt(p.x);
      const fall = Math.max(0, (p.groundY === undefined ? g : p.groundY) - g);
      p.groundY = g;
      if (fall > 4 && this.state === 'playing') {
        this.damage(p, fall * TANKS.FALL_DAMAGE_PER_UNIT, 'fall');
      }
    }
  }

  damage(p, amount, cause) {
    if (!p || p.health <= 0) return 0;
    const dealt = Math.min(p.health, Math.round(amount));
    p.health -= dealt;
    if (p.health < 0) p.health = 0;
    p._lastCause = cause;
    return dealt;
  }

  /* ── firing ─────────────────────────────────────────────────────────────── */

  /* The whole shot, computed here and sent as a finished trajectory. The client
     animates the points it is given; it does not decide any of them. */
  fire(socketId, angleDeg, power) {
    if (this.state !== 'playing') return { ok: false, why: 'not playing' };
    if (this.turn !== socketId) return { ok: false, why: 'not your turn' };
    const me = this.players.get(socketId);
    const foe = this.opponentOf(socketId);
    if (!me || !foe) return { ok: false, why: 'no opponent' };

    /* Clamped rather than rejected. A client sending 400 power is either broken
       or lying, and in both cases the sane answer is the strongest legal shot,
       not an error the player cannot understand. */
    const a = clamp(Number(angleDeg), 0, 180);
    const pw = clamp(Number(power), TANKS.POWER_MIN, TANKS.POWER_MAX);
    me.angle = a; me.power = pw;

    const rad = a * Math.PI / 180;
    const speed = pw * TANKS.POWER_SCALE;
    let x = me.x;
    let y = this.groundAt(me.x) + TANKS.TANK_H + 4;
    let vx = Math.cos(rad) * speed;
    let vy = Math.sin(rad) * speed;

    const path = [[round1(x), round1(y)]];
    let hit = null;
    const dt = TANKS.SHELL_STEP;
    /* Sampled every Nth STEP. Sampling on path.length instead was a loop that
       could never advance: the length only grows when a point is pushed, so
       length % 3 was stuck at 1 forever and the client was handed a two-point
       trajectory — start and landing, with the whole arc missing. */
    let step = 0;
    for (let t = 0; t < TANKS.SHELL_MAX_TIME; t += dt) {
      step++;
      vx += this.wind * dt;
      vy -= TANKS.GRAVITY * dt;
      x += vx * dt;
      y += vy * dt;
      if (path.length < 4000 && step % 3 === 0) path.push([round1(x), round1(y)]);

      // Off the sides or out the bottom: gone, no explosion.
      if (x < -200 || x > TANKS.W + 200 || y < -400) { hit = { type: 'out', x, y }; break; }
      if (y > TANKS.H * 3) continue;               // still climbing, ignore

      // A tank?
      const struck = this.tankAt(x, y, socketId);
      if (struck) { hit = { type: 'tank', x, y, id: struck }; break; }

      // The ground?
      if (y <= this.groundAt(x)) { hit = { type: 'ground', x, y: this.groundAt(x) }; break; }
    }
    if (!hit) hit = { type: 'out', x, y };
    path.push([round1(x), round1(y)]);

    const result = { path, hit: { type: hit.type, x: round1(hit.x), y: round1(hit.y) },
                     damage: [], wind: this.wind, by: socketId };

    if (hit.type !== 'out') {
      const before = new Map([...this.players].map(([id, p]) => [id, p.health]));
      this.explode(hit.x, hit.y);
      this.settleTanks();
      for (const [id, p] of this.players) {
        const d = before.get(id) - p.health;
        if (d > 0) result.damage.push({ id, amount: d, health: p.health });
      }
    }

    this.lastShot = result;

    // Anybody dead?
    const dead = [...this.players.entries()].filter(([, p]) => p.health <= 0);
    if (dead.length) {
      /* Both at once is a draw on damage, so the shooter does NOT win by blowing
         themselves up alongside the other. */
      const alive = [...this.players.entries()].filter(([, p]) => p.health > 0);
      this.finish(alive.length === 1 ? alive[0][0] : null, 'destroyed');
      result.state = this.fullState();
      return { ok: true, result };
    }

    this.nextTurn();
    result.state = this.fullState();
    return { ok: true, result };
  }

  /* Is (x, y) inside a tank that is not the shooter's? */
  tankAt(x, y, exceptId) {
    for (const [id, p] of this.players) {
      if (id === exceptId) continue;
      if (p.health <= 0) continue;
      const g = this.groundAt(p.x);
      if (x >= p.x - TANKS.TANK_W / 2 && x <= p.x + TANKS.TANK_W / 2 &&
          y >= g && y <= g + TANKS.TANK_H + 6) return id;
    }
    return null;
  }

  /* A crater, and damage that falls off with distance from the middle of it. */
  explode(cx, cy) {
    const r = TANKS.BLAST_RADIUS;
    const from = this.colAt(cx - r), to = this.colAt(cx + r);
    for (let i = from; i <= to; i++) {
      const dx = this.xOfCol(i) - cx;
      const inside = r * r - dx * dx;
      if (inside <= 0) continue;
      /* Take a bite out of the column: the depth of the circle at this x, but
         never below the floor of the map or the ground stops being ground. */
      const depth = Math.sqrt(inside);
      const top = cy + depth;
      if (this.ground[i] > top) continue;          // crater is under the surface
      this.ground[i] = clamp(Math.min(this.ground[i], cy - depth), 12, TANKS.GROUND_MAX);
    }
    for (const p of this.players.values()) {
      const d = Math.hypot(p.x - cx, this.groundAt(p.x) + TANKS.TANK_H / 2 - cy);
      if (d > r * 1.6) continue;
      const falloff = Math.max(0, 1 - d / (r * 1.6));
      this.damage(p, TANKS.DIRECT_DAMAGE * falloff * falloff, 'blast');
    }
  }

  nextTurn() {
    const ids = [...this.players.keys()];
    this.turn = ids.find(id => id !== this.turn) || ids[0];
    this.rollWind();
    this.turnEndsAt = Date.now() + TANKS.TURN_MS;
  }

  /* Called on a timer by the owner of the room. A turn that runs out is skipped
     rather than forfeited: standing still is punishment enough in a game where
     the other player is shooting at you. */
  tick() {
    if (this.state !== 'playing') return;
    if (Date.now() < this.turnEndsAt) return;
    this.nextTurn();
    this.broadcast('tanks:timeout', { turn: this.turn, state: this.fullState() });
  }

  finish(winnerId, why) {
    if (this.state === 'over') return;
    this.state = 'over';
    this.turn = null;
    const w = winnerId ? this.players.get(winnerId) : null;
    this.winner = w ? { id: winnerId, name: w.name, wallet: w.wallet } : null;
    this.broadcast('tanks:over', {
      winner: this.winner ? { name: this.winner.name } : null,
      why: why || 'destroyed',
      state: this.fullState(),
    });
  }

  /* ── talking to the clients ─────────────────────────────────────────────── */

  fullState() {
    return {
      id: this.id,
      state: this.state,
      w: TANKS.W, h: TANKS.H,
      ground: this.ground.map(v => Math.round(v)),
      wind: this.wind,
      turn: this.turn,
      turnMsLeft: this.state === 'playing' ? Math.max(0, this.turnEndsAt - Date.now()) : 0,
      players: [...this.players.entries()].map(([id, p]) => ({
        id, name: p.name, side: p.side,
        x: round1(p.x), health: p.health,
        angle: p.angle, power: p.power,
      })),
      winner: this.winner ? { name: this.winner.name } : null,
    };
  }

  broadcast(event, payload) {
    this.io.to(this.socketRoomName).emit(event, payload);
  }
}

/* ── small helpers ────────────────────────────────────────────────────────── */
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function round1(v) { return Math.round(v * 10) / 10; }
/* A tiny seeded generator, so a match can be replayed from its seed and so the
   terrain is not a different shape for each player. */
function mulberry(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = { TanksRoom, TANKS };
