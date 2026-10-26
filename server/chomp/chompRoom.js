'use strict';
// Chomp's one shared arena (free, no money yet): the sim, run at TICK_HZ on the server. The browser only draws and
// predicts its own chomper with the same movement code (shared/chompMove.js); every eat, death and score is decided
// here.
//
// Rules in short (numbers and their sources in shared/chompRules.js):
//   - chompers move by the arcade's rules (tile corridors, buffered turns, cornering, a pause per dot)
//   - dots 10, energizers 50; an energizer turns nearby ghosts blue AND lets its eater eat other players for the fright
//     time, on the arcade's 200/400/800/1600 chain
//   - a ghost (or a powered player) on your tile takes a life; you come back blinking (safe) where no ghost is near
//   - three lives, one bonus life at 10,000; out of lives is game over (Play again from the page)
//   - eaten dots come back after a while, so the arena stays full; fruit appears per module after 70 and 170 dots

const R = require('../../shared/chompRules');
const Maze = require('../../shared/chompMaze');
const Move = require('../../shared/chompMove');
const Wire = require('../../shared/chompWire');
const Ghosts = require('./chompGhosts');
const Bots = require('./chompBots');
const { pickName } = require('../botNames');

const DT = 1 / R.TICK_HZ;
const SNAP_EVERY = Math.round(R.TICK_HZ / R.SNAP_HZ);
const COLORS = 8;                       // chomper colour slots (the page owns the palette)
const NAME_MAX = 15;

function mulberry(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

class ChompRoom {
  constructor(opts = {}) {
    this.nsp = opts.nsp || null;           // socket.io namespace (null in tests)
    this.rng = opts.rng || mulberry(opts.seed || (Date.now() & 0xffffff));
    this.A = Maze.build(opts.mx || R.MODULES_X, opts.my || R.MODULES_Y);
    this.dots = new Uint8Array(this.A.dot0);
    this.ghosts = Ghosts.makeGhosts(this.A);
    this.players = new Map();               // id -> player
    this.bySocket = new Map();              // socket id -> player
    this.tick = 0;
    this.modeIdx = 0;
    this.modeLeft = R.MODES[0][1] * R.TICK_HZ;
    this.mode = R.MODES[0][0];
    this.nextId = 1;
    this.colorNext = 0;
    this.respawnQ = { 1: [], 2: [] };
    this.dotsGone = [];
    this.dotsBack = [];
    this.events = [];
    this.botFill = opts.botFill != null ? opts.botFill : R.BOT_FILL;
    for (const m of this.A.modules) { m.fruitCount = 0; m.fruitUntil = 0; }
    // spawn candidates: every plain path tile outside the ring around the house
    this.spawnTiles = [];
    const H = Maze.HOUSE;
    for (let r = 0; r < this.A.H; r++) for (let c = 0; c < this.A.W; c++) {
      if (this.A.cell[r * this.A.W + c] !== Maze.PATH) continue;
      const lc = c % Maze.MW, lr = r % Maze.MH;
      if (lc >= H.c0 - 1 && lc <= H.c1 + 1 && lr >= H.r0 - 1 && lr <= H.r1 + 1) continue;
      this.spawnTiles.push(r * this.A.W + c);
    }
  }

  // ---- seats
  addPlayer({ name, socketId = null, bot = false }) {
    if (this.players.size >= R.MAX_PLAYERS) return null;
    const id = this.nextId; this.nextId = this.nextId >= 65000 ? 1 : this.nextId + 1;
    const p = {
      id, sid: socketId, bot, name: String(name || 'Player').slice(0, NAME_MAX), color: this.colorNext++ % COLORS,
      x: 0, y: 0, dir: -1, want: -1, face: 1, pause: 0, moving: false,
      score: 0, lives: R.LIVES, bonus: false, power: 0, chain: 0, safe: 0, dying: 0, over: false,
      seq: 0, seqTick: 0, hist: [], pend: null, joinedTick: this.tick, brain: bot ? Bots.brain(this.rng) : null,
    };
    this.players.set(id, p);
    if (socketId) this.bySocket.set(socketId, p);
    this.place(p);
    this.events.push({ k: 'meta', id, n: p.name, c: p.color });
    return p;
  }

  removePlayer(p) {
    if (!p || !this.players.has(p.id)) return;
    this.players.delete(p.id);
    if (p.sid) this.bySocket.delete(p.sid);
    this.events.push({ k: 'gone', id: p.id });
  }

  metas() {
    return [...this.players.values()].map(p => ({ id: p.id, n: p.name, c: p.color }));
  }

  // ---- input. d: 0 up, 1 left, 2 down, 3 right. s: the browser's input number. c, r: its tile when the key went down.
  // The browser runs its own chomper a little ahead or behind ours (network jitter), so a turn is lined up with the
  // tile the key went down in: pressed in a tile we have not reached yet, it waits until we get there; pressed in one
  // we already went through, lateTurn takes it there. Reversing needs no lining up.
  input(p, d, s, c, r) {
    if (!p || p.over) return;
    p.seq = s & 0xffff;
    p.seqTick = this.tick;
    if (p.dying) return;
    const hasTile = Number.isInteger(c) && Number.isInteger(r);
    p.pend = null;
    if (p.dir < 0 || d === p.dir || d === Move.opp(p.dir) || !hasTile) { p.want = d; return; }
    const pc = Math.floor(p.x), pr = Math.floor(p.y), v = R.DIRS[p.dir];
    for (let k = 1; k <= 3; k++) {
      if (pc + v[0] * k === c && pr + v[1] * k === r) { p.pend = { d, c, r, until: this.tick + R.LATE_TURN_TICKS }; return; }
    }
    p.want = d;
    if (pc !== c || pr !== r) this.lateTurn(p, d, c, r);
  }

  // The page pressed in tile (c, r), which we went through in the last LATE_TURN_TICKS ticks without changing
  // direction: take the turn at the first tile from there that has the opening (where the page turned) and move on
  // from it. Movement only, and only where the same rules would have turned, so lying about (c, r) gains nothing.
  lateTurn(p, d, c, r) {
    const h = p.hist;
    let i = h.length - 1, first = -1;
    for (; i >= 0; i--) {
      if (h[i].dir !== p.dir) break;
      if (Math.floor(h[i].x) === c && Math.floor(h[i].y) === r) first = i;
      else if (first >= 0) break;
    }
    if (first < 0) return;
    let j = first;
    for (; j < h.length; j++) if (Move.canGo(this.A, Math.floor(h[j].x), Math.floor(h[j].y), d)) break;
    if (j >= h.length) return;
    const speed = R.speed(p.power > 0 ? R.PAC_FRIGHT_SPEED : R.PAC_SPEED);
    p.x = h[j].x; p.y = h[j].y; p.dir = d;
    for (let k = j + 1; k < h.length; k++) {
      if (!h[k].paused) Move.advance(p, this.A, speed * DT);
      h[k] = { x: p.x, y: p.y, dir: p.dir, paused: h[k].paused };
    }
    p.face = p.dir;
  }

  // ---- placement
  place(p) {
    let best = -1, bestD = -1;
    for (let tries = 0; tries < 40; tries++) {
      const k = this.spawnTiles[Math.floor(this.rng() * this.spawnTiles.length)];
      const c = k % this.A.W, r = Math.floor(k / this.A.W);
      const d = this.dangerDist(c + 0.5, r + 0.5, p);
      if (d >= R.SPAWN_GHOST_CLEAR) { best = k; break; }
      if (d > bestD) { bestD = d; best = k; }
    }
    const c = best % this.A.W, r = Math.floor(best / this.A.W);
    p.x = c + 0.5; p.y = r + 0.5;
    p.dir = -1; p.want = -1; p.face = 1; p.pause = 0; p.moving = false;
    p.safe = Math.round(R.SPAWN_SAFE_S * R.TICK_HZ);
    p.hist = []; p.pend = null;
  }

  dangerDist(x, y, self) {
    let best = Infinity;
    for (const g of this.ghosts) {
      if (g.state !== 'active' || g.fright > 0) continue;
      best = Math.min(best, Math.hypot(g.x - x, g.y - y));
    }
    for (const q of this.players.values()) {
      if (q === self || q.power <= 0 || q.dying || q.over) continue;
      best = Math.min(best, Math.hypot(q.x - x, q.y - y));
    }
    return best;
  }

  // The player a ghost hunts: the nearest one in range that is in play and not blinking safe.
  nearestPrey(x, y, range) {
    let best = null, bestD = range * range;
    for (const p of this.players.values()) {
      if (p.dying || p.over || p.safe > 0) continue;
      const dx = p.x - x, dy = p.y - y, d = dx * dx + dy * dy;
      if (d <= bestD) { bestD = d; best = p; }
    }
    return best;
  }

  // ---- the tick
  step() {
    this.tick++;
    this.stepMode();
    Ghosts.releaseHouses(this.A, this);
    for (const p of this.players.values()) {
      if (p.bot && !p.dying && !p.over) Bots.think(this, p);
      this.stepPlayer(p);
    }
    for (const g of this.ghosts) Ghosts.step(g, this.A, this, DT);
    this.collide();
    if (this.tick % 30 === 0) { this.respawnPellets(); this.stepFruit(); }
    if (this.tick % 120 === 0) this.fillBots();
  }

  stepMode() {
    if (--this.modeLeft > 0) return;
    this.modeIdx = (this.modeIdx + 1) % R.MODES.length;
    const next = R.MODES[this.modeIdx];
    this.modeLeft = next[1] * R.TICK_HZ;
    if (next[0] !== this.mode) {
      // DOSSIER: scatter <-> chase forces every ghost outside the house to reverse (not frightened ones)
      for (const g of this.ghosts) if (g.state === 'active' && g.fright <= 0) g.reverse = true;
    }
    this.mode = next[0];
  }

  stepPlayer(p) {
    if (p.over) return;
    if (p.dying > 0) {
      if (--p.dying === 0) {
        if (p.lives > 0) { this.place(p); this.events.push({ k: 'spawn', id: p.id }); }
        else this.gameOver(p);
      }
      return;
    }
    if (p.power > 0 && --p.power === 0) p.chain = 0;
    if (p.safe > 0) p.safe--;
    if (p.pend && ((Math.floor(p.x) === p.pend.c && Math.floor(p.y) === p.pend.r) || this.tick >= p.pend.until)) {
      p.want = p.pend.d; p.pend = null;
    }
    const speed = R.speed(p.power > 0 ? R.PAC_FRIGHT_SPEED : R.PAC_SPEED);
    const paused = p.pause > 0;
    Move.tick(p, this.A, speed, DT, this.dots, (k, kind) => this.eatDot(p, k, kind));
    if (p.dir >= 0) p.face = p.dir;
    p.hist.push({ x: p.x, y: p.y, dir: p.dir, paused });
    if (p.hist.length > R.LATE_TURN_TICKS) p.hist.shift();
    this.checkFruit(p);
  }

  eatDot(p, k, kind) {
    this.dots[k] = 0;
    this.dotsGone.push(k);
    this.addScore(p, kind === Maze.ENERGIZER ? R.ENERGIZER_POINTS : R.DOT_POINTS);
    const delay = kind === Maze.ENERGIZER ? R.ENERGIZER_RESPAWN_S : R.DOT_RESPAWN_S;
    this.respawnQ[kind].push({ k, at: this.tick + delay * R.TICK_HZ });
    const m = this.A.modules[this.A.moduleOf[k]];
    m.house.dots++;
    m.house.lastDotTick = this.tick;
    m.fruitCount++;
    if (R.FRUIT_AT.includes(m.fruitCount) && this.tick >= m.fruitUntil) {
      const s = R.FRUIT_S[0] + this.rng() * (R.FRUIT_S[1] - R.FRUIT_S[0]);
      m.fruitUntil = this.tick + Math.round(s * R.TICK_HZ);
      this.events.push({ k: 'fruit', m: m.index, on: 1 });
    }
    if (m.fruitCount >= R.FRUIT_AT[R.FRUIT_AT.length - 1]) m.fruitCount = 0;
    if (kind === Maze.ENERGIZER) this.powerUp(p);
  }

  powerUp(p) {
    const t = R.FRIGHT_S * R.TICK_HZ;
    p.power = t;
    p.chain = 0;
    const r2 = R.FRIGHT_RADIUS * R.FRIGHT_RADIUS;
    for (const g of this.ghosts) {
      if (g.state !== 'active' && g.state !== 'house' && g.state !== 'leaving') continue;
      const dx = g.x - p.x, dy = g.y - p.y;
      if (dx * dx + dy * dy > r2) continue;
      g.fright = t;
      if (g.state === 'active') g.reverse = true;     // DOSSIER: chase/scatter -> frightened reverses
    }
    this.events.push({ k: 'power', id: p.id });
  }

  addScore(p, pts) {
    p.score += pts;
    if (!p.bonus && p.score >= R.EXTRA_LIFE_AT) {
      p.bonus = true; p.lives++;
      this.events.push({ k: 'life', id: p.id });
    }
  }

  checkFruit(p) {
    const m = this.A.moduleAt(p.x, p.y);
    if (this.tick >= m.fruitUntil) return;
    const r = m.oy + Math.floor(Maze.FRUIT.y), c = Math.floor(p.x);
    if (Math.floor(p.y) !== r || (c !== m.ox + Maze.FRUIT.x - 1 && c !== m.ox + Maze.FRUIT.x)) return;
    m.fruitUntil = 0;
    this.addScore(p, R.FRUIT_POINTS);
    this.events.push({ k: 'fruit', m: m.index, on: 0, id: p.id, pts: R.FRUIT_POINTS });
  }

  stepFruit() {
    for (const m of this.A.modules) {
      if (m.fruitUntil && this.tick >= m.fruitUntil) {
        m.fruitUntil = 0;
        this.events.push({ k: 'fruit', m: m.index, on: 0 });
      }
    }
  }

  collide() {
    const W = this.A.W, at = new Map();
    for (const p of this.players.values()) {
      if (p.dying || p.over) continue;
      const k = Math.floor(p.y) * W + Math.floor(p.x);
      const list = at.get(k);
      if (list) list.push(p); else at.set(k, [p]);
    }
    if (!at.size) return;
    for (const g of this.ghosts) {
      if (g.state !== 'active') continue;
      const list = at.get(Math.floor(g.y) * W + Math.floor(g.x));
      if (!list) continue;
      for (const p of list) {
        if (p.dying) continue;
        if (g.fright > 0) { this.eatGhost(p, g); break; }
        if (p.safe <= 0) this.kill(p, null);
      }
    }
    for (const list of at.values()) {
      if (list.length < 2) continue;
      for (const a of list) {
        if (a.power <= 0 || a.dying) continue;
        for (const b of list) {
          if (b === a || b.power > 0 || b.safe > 0 || b.dying) continue;
          const pts = R.PLAYER_POINTS[Math.min(a.chain, R.PLAYER_POINTS.length - 1)];
          a.chain++;
          this.addScore(a, pts);
          this.events.push({ k: 'eatp', id: a.id, v: b.id, x: b.x, y: b.y, pts });
          this.kill(b, a);
        }
      }
    }
  }

  eatGhost(p, g) {
    const pts = R.GHOST_POINTS[Math.min(p.chain, R.GHOST_POINTS.length - 1)];
    p.chain++;
    this.addScore(p, pts);
    g.state = 'eyes'; g.fright = 0; g.dk = -1;
    this.events.push({ k: 'eatg', id: p.id, g: g.index, x: g.x, y: g.y, pts });
  }

  kill(p, by) {
    p.dying = Math.round(R.DEATH_S * R.TICK_HZ);
    p.lives--;
    p.power = 0; p.chain = 0; p.want = -1; p.moving = false;
    this.events.push({ k: 'die', id: p.id, by: by ? by.id : 0 });
  }

  gameOver(p) {
    p.over = true;
    const rank = this.rankOf(p);
    this.events.push({ k: 'over', id: p.id });
    if (p.sid && this.nsp) {
      const s = this.nsp.sockets.get(p.sid);
      if (s) s.emit('c:over', { score: p.score, rank, of: this.players.size, secs: Math.round((this.tick - p.joinedTick) / R.TICK_HZ) });
    }
    this.removePlayer(p);
  }

  rankOf(p) {
    let rank = 1;
    for (const q of this.players.values()) if (q !== p && !q.over && q.score > p.score) rank++;
    return rank;
  }

  respawnPellets() {
    for (const kind of [1, 2]) {
      const q = this.respawnQ[kind];
      let n = q.length;
      while (n-- > 0 && q.length && q[0].at <= this.tick) {
        const e = q.shift();
        if (this.someoneNear(e.k, R.RESPAWN_CLEAR)) { e.at = this.tick + 2 * R.TICK_HZ; q.push(e); continue; }
        this.dots[e.k] = kind;
        this.dotsBack.push(e.k);
      }
    }
  }

  someoneNear(k, d) {
    const c = k % this.A.W, r = Math.floor(k / this.A.W);
    for (const p of this.players.values()) {
      if (Math.abs(p.x - c - 0.5) <= d && Math.abs(p.y - r - 0.5) <= d) return true;
    }
    return false;
  }

  fillBots() {
    let humans = 0, bots = [];
    for (const p of this.players.values()) { if (p.bot) bots.push(p); else humans++; }
    const want = Math.max(0, this.botFill - humans);
    while (bots.length < want) {
      const taken = new Set([...this.players.values()].map(p => p.name.toLowerCase()));
      const name = pickName(this.rng(), { maxLen: NAME_MAX, taken: n => taken.has(n) });
      const b = this.addPlayer({ name, bot: true });
      if (!b) break;
      bots.push(b);
    }
    if (bots.length > want) {
      bots.sort((a, b) => a.score - b.score);
      for (const b of bots.slice(0, bots.length - want)) if (!b.dying) this.removePlayer(b);
    }
  }

  // ---- what goes out
  snapshot() {
    const ps = [];
    for (const p of this.players.values()) {
      if (p.over) continue;
      const F = Wire.F;
      ps.push({
        id: p.id, x: p.x, y: p.y, dir: p.dir < 0 ? -1 : p.dir, seq: p.seq, since: this.tick - p.seqTick,
        power: p.power,
        flags: (p.moving ? F.MOVING : 0) | (p.power > 0 ? F.POWER : 0) | (p.safe > 0 ? F.SAFE : 0) | (p.dying ? F.DYING : 0),
      });
    }
    const gs = this.ghosts.map(g => ({ x: g.x, y: g.y, dir: g.dir, kind: g.ki, state: Ghosts.STATE[g.state], fright: g.fright }));
    return Wire.encode(this.tick, this.mode === 'chase' ? 1 : 0, ps, gs);
  }

  board() {
    return [...this.players.values()].filter(p => !p.over).sort((a, b) => b.score - a.score).slice(0, 10).map(p => [p.id, p.score]);
  }

  init() {
    return {
      mx: this.A.mx, my: this.A.my, tick: this.tick, hz: R.TICK_HZ, metas: this.metas(),
      dots: Buffer.from(this.dots), fruit: this.A.modules.filter(m => this.tick < m.fruitUntil).map(m => m.index),
    };
  }

  // Flush what changed since the last call (the sockets layer sends it).
  drain() {
    const out = { dots: null, events: null };
    if (this.dotsGone.length || this.dotsBack.length) {
      out.dots = { e: this.dotsGone, b: this.dotsBack };
      this.dotsGone = []; this.dotsBack = [];
    }
    if (this.events.length) { out.events = this.events; this.events = []; }
    return out;
  }
}

module.exports = { ChompRoom, SNAP_EVERY, COLORS, NAME_MAX };
