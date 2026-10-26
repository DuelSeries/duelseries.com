'use strict';
// One Chomp arena: the sim, run at TICK_HZ on the server. The browser only draws and predicts its own chomper with the
// same movement code (shared/chompMove.js); every eat, death and score is decided here.
//
// Rules in short (numbers and their sources in shared/chompRules.js):
//   - chompers move by the arcade's rules (tile corridors, buffered turns, cornering, a pause per dot)
//   - dots 10, energizers 50; an energizer turns nearby ghosts blue AND lets its eater eat other players for the fright
//     time, on the arcade's 200/400/800/1600 chain
//   - a ghost (or a powered player) on your tile takes a life; you come back blinking (safe) where no ghost is near
//   - one life (Owen 2026-10-25); out of lives is game over (Play again from the page)
//   - eaten dots come back after a while, so the arena stays full; fruit appears per module after 70 and 170 dots
//
// FREE (stake 0) holds no money and runs exactly as it always has. PAID (stake > 0, a $0.50 or $1 rung, built by the
// directory, server/chomp/chompArenas.js): the money controller (chompMoney.js, agar.io's reused) and every paid branch
// below sits behind `if (this.money)`. A paid seat is bought only at the paid door (agPaidDoor): addPaidHuman opens
// it shielded (no ghost or player can catch it, it catches nobody) and still until the page says c:ready; then the
// money facts: a paid player or a bounty bot caught drops its coins on the tiles around it ('drop'), a chomper that
// steps on a coin's tile takes it ('pick'). Paid rooms never fill bots on their own: only the owner's bounty bots
// (Control, room #0 of a rung), which are never back once caught.

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
const DROP_REACH = 6;                   // CHOSEN: coins land on path tiles at most this many steps from the death tile
const EMERGENCY_FAIL_TICKS = 3;         // agRoom's: this many throwing ticks in a row close a room for good

function mulberry(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function stakeLabel(stake) {
  return 's' + String(Number(stake)).replace('.', '_');
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
    // bots wanted: a number (tests) or a function read each fill (the day curve, server/botPopulation.js)
    this.botFill = opts.botFill != null ? opts.botFill : R.BOT_FILL;
    for (const m of this.A.modules) { m.fruitCount = 0; m.fruitUntil = 0; }
    // spawn candidates: every plain path tile outside the ring around the house
    this.spawnTiles = [];
    this.nearHouse = new Uint8Array(this.A.W * this.A.H);
    const H = Maze.HOUSE;
    for (let r = 0; r < this.A.H; r++) for (let c = 0; c < this.A.W; c++) {
      const k = r * this.A.W + c;
      const m = this.A.modules[this.A.moduleOf[k]], lc = c - m.ox, lr = r - m.oy;
      if (lc >= H.c0 - 1 && lc <= H.c1 + 1 && lr >= H.r0 - 1 && lr <= H.r1 + 1) { this.nearHouse[k] = 1; continue; }
      if (this.A.cell[k] !== Maze.PATH) continue;
      this.spawnTiles.push(k);
    }

    // ---- paid (see the header)
    this.stake = Number(opts.stake) > 0 ? Number(opts.stake) : 0;
    this.region = opts.region || 'na';
    this.index = Number.isInteger(opts.index) ? opts.index : 0;
    this.lobbyType = this.stake > 0
      ? 'ch_' + this.region + '_' + stakeLabel(this.stake) + (this.index > 0 ? '#' + this.index : '')
      : 'ch_' + this.region + '_free';
    this.ioRoom = opts.ioRoom || (this.stake > 0 ? 'p' + this.stake + ':' + this.index : 'free');
    this.log = opts.log || console;
    this.now = typeof opts.now === 'function' ? opts.now : Date.now;
    this.onSeatless = typeof opts.onSeatless === 'function' ? opts.onSeatless : null;
    this.paidBots = opts.paidBots === true && this.stake > 0;
    this.watchers = new Map();              // socket id -> socket: a paid room's read-only sockets
    this.shielded = new Set();
    this.still = new Set();
    this.moneyFacts = [];
    this.money = null;
    this.stopped = false;
    this.closed = false;
    this.onClosed = null;                   // set by the directory: (room) after an emergency close
    this.failCount = 0;
    this.awake = this.stake === 0;          // a paid room ticks only while it has someone (needsTick)
    if (this.stake > 0) {
      const { ChompMoney } = require('./chompMoney');
      this.botFill = 0;
      this.money = new ChompMoney({
        sim: this.moneyView(), stake: this.stake, label: this.lobbyType, hooks: opts.moneyHooks,
        shielded: this.shielded, still: this.still, now: this.now, log: this.log,
        tell: (sid, event, payload) => this._tell(sid, event === 'ag:holding' ? 'c:holding' : event, payload),
        onClosed: (acct, outcome, extra) => this._paidClosed(acct, outcome, extra),
      });
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
    if (p.sid && this.bySocket.get(p.sid) === p) this.bySocket.delete(p.sid);
    this.shielded.delete(p.id);
    this.still.delete(p.id);
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
    if (this.money && !this._paidInputOk(p)) return;
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

  // The player a ghost hunts: the nearest one in range that is in play and not blinking safe (nor shielded: a paid
  // seat whose page has not drawn it yet).
  nearestPrey(x, y, range) {
    let best = null, bestD = range * range;
    for (const p of this.players.values()) {
      if (p.dying || p.over || p.safe > 0 || this.shielded.has(p.id)) continue;
      const dx = p.x - x, dy = p.y - y, d = dx * dx + dy * dy;
      if (d <= bestD) { bestD = d; best = p; }
    }
    return best;
  }

  // ---- the tick
  step() {
    this.tick++;
    if (this.money) this.money.holdTick();
    this.stepMode();
    Ghosts.releaseHouses(this.A, this);
    for (const p of this.players.values()) {
      if (p.bot && !p.dying && !p.over) Bots.think(this, p);
      this.stepPlayer(p);
    }
    for (const g of this.ghosts) Ghosts.step(g, this.A, this, DT);
    this.collide();
    if (this.tick % 30 === 0) { this.respawnPellets(); this.stepFruit(); }
    if (this.tick % 15 === 0) this.fillBots(1);
    if (this.money) {
      const facts = this.moneyFacts;
      this.moneyFacts = [];
      this.money.afterStep({ money: facts });
    }
  }

  // A tick that throws EMERGENCY_FAIL_TICKS times in a row closes the room for good (agRoom's rule): a paid room
  // first refunds every open balance in full and gives every coin back (chompMoney emergencySettle).
  safeStep() {
    if (this.stopped) return false;
    try {
      this.step();
    } catch (e) {
      this.failCount++;
      this.log.error('[CHOMP] TICK threw', this.lobbyType, this.failCount, e && e.stack ? e.stack : e);
      if (this.failCount >= EMERGENCY_FAIL_TICKS) this.emergencyClose();
      return false;
    }
    this.failCount = 0;
    return true;
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
    if (this.still.has(p.id)) {
      // a paid seat waiting for its page, a dropped one gone dormant, or a frozen one: it does not move
      p.moving = false;
      p.hist.push({ x: p.x, y: p.y, dir: p.dir, paused: true });
      if (p.hist.length > R.LATE_TURN_TICKS) p.hist.shift();
      return;
    }
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
    if (this.money && !this.shielded.has(p.id)) {
      const k = Math.floor(p.y) * this.A.W + Math.floor(p.x);
      if (this.money.hasCoinAt(k)) this.moneyFacts.push({ t: 'pick', pid: p.id, k });
    }
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
    if (R.BONUS_LIFE && !p.bonus && p.score >= R.EXTRA_LIFE_AT) {
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
      if (p.dying || p.over || this.shielded.has(p.id)) continue;
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
        if (p.safe <= 0) this.kill(p, null, g);
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

  kill(p, by, ghost) {
    p.dying = Math.round(R.DEATH_S * R.TICK_HZ);
    p.killedBy = by ? by.name : '';
    p.killedByGhost = !by && !!ghost;
    p.lives--;
    p.power = 0; p.chain = 0; p.want = -1; p.moving = false;
    this.events.push({ k: 'die', id: p.id, by: by ? by.id : 0 });
    // paid: everything this chomper holds drops as coins around it (chompMoney _drop, after the step)
    if (this.money) {
      this.moneyFacts.push({ t: 'drop', victim: p.id, spots: this.dropSpots(p), by: by ? by.id : 0,
        byName: by ? by.name : '', ghost: !by && !!ghost });
    }
  }

  // Where a death's coins land: the death tile first, then the nearest path tiles by corridor steps (breadth first,
  // at most DROP_REACH steps), never inside the ring around a ghost house. -> [[c, r, k], ...]
  dropSpots(p) {
    const A = this.A, W = A.W;
    let c0 = Math.floor(p.x), r0 = Math.floor(p.y);
    if (!A.walk(c0, r0)) { c0 = Math.round(p.x - 0.5); r0 = Math.round(p.y - 0.5); }
    const out = [];
    if (!A.walk(c0, r0)) return out;
    const seen = new Set([r0 * W + c0]);
    let ring = [[c0, r0]];
    for (let step = 0; step <= DROP_REACH && ring.length; step++) {
      const next = [];
      for (const [c, r] of ring) {
        const k = r * W + c;
        if (!this.nearHouse[k] || step === 0) out.push([c, r, k]);
        for (const [dc, dr] of R.DIRS) {
          const nc = c + dc, nr = r + dr, nk = nr * W + nc;
          if (!A.walk(nc, nr) || seen.has(nk)) continue;
          seen.add(nk);
          next.push([nc, nr]);
        }
      }
      ring = next;
    }
    return out;
  }

  gameOver(p) {
    p.over = true;
    if (this.money) {
      // a paid player's page heard its end when the money closed (c:dead); a bounty bot is never back
      if (p.bot) this._removeBot(p);
      else this.removePlayer(p);
      return;
    }
    const rank = this.rankOf(p);
    this.events.push({ k: 'over', id: p.id });
    if (p.sid && this.nsp) {
      const s = this.nsp.sockets.get(p.sid);
      if (s) s.emit('c:over', { score: p.score, rank, of: this.players.size, secs: Math.round((this.tick - p.joinedTick) / R.TICK_HZ), by: p.killedBy || '', ghost: !!p.killedByGhost });
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

  // Top the room up to the bot target, at most `step` bots a call (the room calls it every 250 ms with 1, the way
  // agar.io's free room fills, so bots arrive one at a time). Bots over the target are not removed: they leave as
  // they are caught (one life), like agar.io's. A paid room never fills (botFill 0): its bots are the owner's.
  fillBots(step = Infinity) {
    let humans = 0, bots = [];
    for (const p of this.players.values()) { if (p.bot) bots.push(p); else humans++; }
    const target = typeof this.botFill === 'function' ? this.botFill() : this.botFill;
    const want = Math.max(0, target - humans);
    let added = 0;
    while (bots.length < want && added++ < step) {
      const b = this._spawnBot();
      if (!b) break;
      bots.push(b);
    }
  }

  _spawnBot() {
    const taken = new Set([...this.players.values()].map(p => p.name.toLowerCase()));
    const name = pickName(this.rng(), { maxLen: NAME_MAX, taken: n => taken.has(n) });
    return this.addPlayer({ name, bot: true });
  }

  // A bot leaves (Control lowered the count, or it was caught): a bounty bot's money first (agMoney retireBot: seed
  // back to the bot bank, what it took back to its players; nothing when its coins already dropped).
  _removeBot(p) {
    if (this.money && this.money.bots.has(p.id)) this.money.retireBot(p.id, 'removed');
    this.removePlayer(p);
  }

  // The owner's bounty bots in this paid room (room #0 of a rung): the live ones, newest first.
  paidBotList() {
    const out = [];
    for (const p of this.players.values()) if (p.bot && !p.over) out.push(p);
    return out.sort((a, b) => b.id - a.id);
  }

  get botCount() {
    let n = 0;
    for (const p of this.players.values()) if (p.bot && !p.over) n++;
    return n;
  }

  get humanCount() {
    let n = 0;
    for (const p of this.players.values()) if (!p.bot && !p.over) n++;
    return n;
  }

  hasSpace() {
    return !this.stopped && this.players.size < R.MAX_PLAYERS;
  }

  // ---- the owner console, the solvency sum and the drain (the same reads every game's rooms answer)
  get playerCount() {
    return this.money ? this.money.openCount() : this.humanCount;
  }

  // Bots are never added by hand here: the free arena's follow the day curve, a paid rung's come from Control's
  // bounty-bot row (chompArenas setBotTarget).
  botsAllowed() {
    return false;
  }

  liveStakeTotal() {
    return this.money ? this.money.liveStakeTotal() : 0;
  }

  get snakes() {
    return this.money ? this.money.snakes : new Map();
  }

  get floorWorth() {
    return this.money ? this.money.floorWorth : 0;
  }

  // A paid room ticks while anyone is in it (a seat, an open account, a watcher, a bounty bot); a free room always.
  needsTick() {
    if (this.stopped) return false;
    if (!this.money) return true;
    return this.awake || this.players.size > 0 || this.watchers.size > 0;
  }

  setAwake(on) {
    this.awake = on === true && !this.stopped && (!this.money || this.paidBots);
    return this.awake;
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
        flags: (p.moving ? F.MOVING : 0) | (p.power > 0 ? F.POWER : 0) | (p.safe > 0 || this.shielded.has(p.id) ? F.SAFE : 0) | (p.dying ? F.DYING : 0),
      });
    }
    const gs = this.ghosts.map(g => ({ x: g.x, y: g.y, dir: g.dir, look: g.plan >= 0 ? g.plan : g.dir, kind: g.ki, state: Ghosts.STATE[g.state], fright: g.fright }));
    return Wire.encode(this.tick, this.mode === 'chase' ? 1 : 0, ps, gs);
  }

  // Free: the top 10 by score, [[id, score]]. Paid: by money, [[id, micro]] (people and bounty bots alike).
  board() {
    if (this.money) {
      return [...this.players.values()].filter(p => !p.over && !p.dying)
        .map(p => [p.id, this.money.balance(p.id)]).filter(r => r[1] > 0)
        .sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 10);
    }
    return [...this.players.values()].filter(p => !p.over).sort((a, b) => b.score - a.score).slice(0, 10).map(p => [p.id, p.score]);
  }

  init() {
    const out = {
      mx: this.A.mx, my: this.A.my, tick: this.tick, hz: R.TICK_HZ, metas: this.metas(),
      dots: Buffer.from(this.dots), fruit: this.A.modules.filter(m => this.tick < m.fruitUntil).map(m => m.index),
    };
    if (this.money) {
      out.stake = this.stake;
      out.coins = this.money.coins().map(c => [c.pid, c.k, c.micro]);
    }
    return out;
  }

  // Flush what changed since the last call (the sockets layer sends it).
  drain() {
    const out = { dots: null, events: null, coins: null };
    if (this.dotsGone.length || this.dotsBack.length) {
      out.dots = { e: this.dotsGone, b: this.dotsBack };
      this.dotsGone = []; this.dotsBack = [];
    }
    if (this.events.length) { out.events = this.events; this.events = []; }
    if (this.money) {
      const ce = this.money.takeCoinEvents();
      if (ce) {
        const a = [], r = [];
        for (const e of ce) {
          if (e.a) a.push([e.a.pid, e.a.k, e.a.micro]);
          else r.push([e.r, e.by || 0]);
        }
        out.coins = { a, r };
      }
    }
    return out;
  }

  // One snapshot to this room's sockets (chompBoot calls it every SNAP_EVERY ticks). The volatile snapshot goes
  // first: a volatile packet is dropped when the socket is still busy writing, so after any other emit in the same
  // moment it would almost always be lost.
  flush() {
    if (!this.nsp) return;
    const to = () => this.nsp.to(this.ioRoom);
    to().volatile.emit('c:s', Buffer.from(this.snapshot()));
    const d = this.drain();
    if (d.dots) to().emit('c:dots', d.dots);
    if (d.events) to().emit('c:ev', d.events);
    if (d.coins) to().emit('c:coins', d.coins);
    if (this.tick % R.TICK_HZ === 0) to().emit('c:lb', this.board());
    if (this.tick % (R.TICK_HZ / 4) === 0) {
      for (const [sid, p] of this.bySocket) {
        const s = this.nsp.sockets.get(sid);
        if (!s) continue;
        const me = { s: p.score, l: p.lives, rk: this.rankOf(p), n: this.players.size };
        if (this.money) {
          me.m = this.money.balance(p.id);
          me.rk = this.moneyRank(p);
        }
        s.emit('c:me', me);
      }
    }
  }

  moneyRank(p) {
    const mine = this.money.balance(p.id);
    let rank = 1;
    for (const q of this.players.values()) if (q !== p && !q.over && this.money.balance(q.id) > mine) rank++;
    return rank;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Sockets and paid seats (agRoom's contract, for the directory and the paid door).

  // This socket sees this room: it joins the room's socket.io room (leaving the one it saw before) and gets c:init.
  attach(socket) {
    if (!socket) return;
    if (socket._chRoom === this.ioRoom) return;
    if (socket._chRoom && typeof socket.leave === 'function') {
      try { socket.leave(socket._chRoom); } catch (e) { /* gone */ }
    }
    socket._chRoom = this.ioRoom;
    if (typeof socket.join === 'function') socket.join(this.ioRoom);
    this._emit(socket, 'c:init', this.init());
  }

  detach(socket) {
    if (!socket || socket._chRoom !== this.ioRoom) return;
    socket._chRoom = null;
    if (typeof socket.leave === 'function') {
      try { socket.leave(this.ioRoom); } catch (e) { /* gone */ }
    }
  }

  // The money's view of the sim (chompMoney sim): what it reads and the two things it asks the room to do.
  moneyView() {
    return {
      alive: (pid) => {
        const p = this.players.get(pid);
        return !!(p && !p.dying && !p.over);
      },
      // The newcomer's tile is clear of every ghost and powered player; else it moves to the best spawn tile, which
      // must be clear too.
      clearToStart: (pid) => {
        const p = this.players.get(pid);
        if (!p) return false;
        if (this.dangerDist(p.x, p.y, p) >= R.SPAWN_GHOST_CLEAR) return true;
        this.place(p);
        this.events.push({ k: 'spawn', id: p.id });
        return this.dangerDist(p.x, p.y, p) >= R.SPAWN_GHOST_CLEAR;
      },
      // ready: the blink of a fresh spawn starts now, on the player's own screen
      confirmed: (pid) => {
        const p = this.players.get(pid);
        if (p) p.safe = Math.round(R.SPAWN_SAFE_S * R.TICK_HZ);
      },
      takeMoneyEvents: () => {
        const money = this.moneyFacts;
        this.moneyFacts = [];
        return { money };
      },
    };
  }

  _paidInputOk(p) {
    const acct = this.money.account(p.id);
    return !!(acct && acct.state === 'live' && acct.socketId === p.sid);
  }

  seatOf(socketId) {
    const p = this.bySocket.get(socketId);
    return p ? { pid: p.id, player: p } : null;
  }

  isWatchOnly(socketId) {
    return this.watchers.has(socketId);
  }

  openAccounts() {
    return this.money ? this.money.openCount() : 0;
  }

  // A bought seat (agRoom.addPaidHuman's contract): a spawn tile clear of ghosts, the seat, the account (unconfirmed:
  // shielded and still until c:ready). Returns the account, or 'stopped', 'full', 'seated' or 'no-room', with nothing
  // opened. Throws only after cleaning up, for the door to refund.
  // entry: { name, micro, wallet, paid, proof, ip } (micro and wallet from the consumed token only)
  addPaidHuman(socket, entry) {
    if (!this.money) throw new Error('chompRoom: addPaidHuman in a free room');
    if (this.stopped) return 'stopped';
    if (!socket || typeof socket.id !== 'string') throw new Error('chompRoom: addPaidHuman needs a socket');
    if (this.bySocket.has(socket.id)) return 'seated';
    if (!this.hasSpace()) return 'full';
    const e = entry || {};
    const name = typeof e.name === 'string' && e.name ? e.name : 'Player';
    const p = this.addPlayer({ name, socketId: socket.id });
    if (!p) return 'full';
    if (this.dangerDist(p.x, p.y, p) < R.SPAWN_GHOST_CLEAR) {
      this.removePlayer(p);
      return 'no-room';
    }
    p.socket = socket;
    let acct = null;
    try {
      acct = this.money.open({ pid: p.id, socketId: socket.id, wallet: e.wallet, name: p.name, micro: e.micro,
        paid: e.paid, proof: e.proof, ip: e.ip });
    } catch (err) {
      if (acct && this.money.account(p.id)) this.money.abort(p.id);
      this.removePlayer(p);
      throw err;
    }
    this.watchers.delete(socket.id);
    this.attach(socket);
    return acct;
  }

  // A socket takes an open account back (agRoom.resumePaid's contract): by resume key, by an unconfirmed seat's
  // entry token (byToken), or by a new token from the same wallet. The socket that held it is told c:replaced.
  resumePaid(socket, pid, opts) {
    if (!this.money || this.stopped || !socket || typeof socket.id !== 'string') return false;
    const acct = this.money.account(pid);
    const p = this.players.get(pid);
    if (!acct || !p || acct.state === 'frozen') return false;
    if (opts && opts.byToken && acct.state !== 'unconfirmed') return false;
    if (this.bySocket.has(socket.id)) return false;
    const prev = acct.socketId;
    if (prev && prev !== socket.id) {
      const old = p.socket;
      if (this.bySocket.get(prev) === p) this.bySocket.delete(prev);
      if (old) {
        this._emit(old, 'c:replaced', {});
        this.watchers.set(old.id, old);
        if (this.onSeatless) this._safe(() => this.onSeatless(old, this, 'replaced'));
      }
    }
    if (this.money.resume(pid, socket.id) === false) return false;
    p.sid = socket.id;
    p.socket = socket;
    this.bySocket.set(socket.id, p);
    this.watchers.delete(socket.id);
    this.attach(socket);
    this._emit(socket, 'c:joined', this.joinedPayload(acct, true));
    return true;
  }

  joinedPayload(acct, resumed) {
    return { stake: this.stake, micro: this.money.balance(acct.pid), resumeKey: acct.resumeKey, resumed: !!resumed,
      confirmed: acct.state !== 'unconfirmed', holdTicks: this.money.holdNeed, tickMs: 1000 / R.TICK_HZ,
      id: acct.pid, metas: this.metas() };
  }

  ready(socketId) {
    if (!this.money) return false;
    const p = this.bySocket.get(socketId);
    return p ? this.money.confirm(p.id, socketId) : false;
  }

  hold(socketId, on) {
    if (!this.money) return false;
    const p = this.bySocket.get(socketId);
    return p ? this.money.setHold(p.id, socketId, on === true) : false;
  }

  canChat(socketId) {
    const p = this.bySocket.get(socketId);
    if (!p || p.dying || p.over) return false;
    if (!this.money) return true;
    return this._paidInputOk(p);
  }

  // A read-only socket in a paid room (the lobby's Spectate on a paid rung, or a seat that ended and stays to watch).
  addWatcher(socket) {
    if (!socket || this.stopped) return false;
    this.watchers.set(socket.id, socket);
    this.attach(socket);
    return true;
  }

  // The socket went (disconnect, or a move elsewhere): a paid seat with an open account goes into its disconnect grace
  // (an unconfirmed one is refunded at once, agMoney beginGrace); a free player leaves at once.
  removeSocket(socketId) {
    this.watchers.delete(socketId);
    const p = this.bySocket.get(socketId);
    if (!p) return null;
    this.bySocket.delete(socketId);
    const acct = this.money ? this.money.account(p.id) : null;
    if (acct && acct.socketId === socketId) {
      p.sid = null;
      p.socket = null;
      this.money.beginGrace(p.id);
    } else if (!acct) {
      this.removePlayer(p);
    }
    return p;
  }

  // The seat of a paid account the money just closed: the page hears what happened, the socket is seatless (it stays
  // here watching), and the chomper goes (a caught one after its death animation, gameOver).
  _paidClosed(acct, outcome, extra) {
    const p = this.players.get(acct.pid);
    const sid = acct.socketId || (p && p.sid) || null;
    const socket = p && p.socket ? p.socket : null;
    const x = extra || {};
    if (socket && sid && this.bySocket.get(sid) === p) {
      this.bySocket.delete(sid);
      if (outcome === 'eaten') {
        this._emit(socket, 'c:dead', { lostMicro: x.lostMicro || 0, by: x.by || '', ghost: x.ghost === true,
          score: p.score, secs: Math.round((this.tick - p.joinedTick) / R.TICK_HZ) });
      } else if (outcome === 'released') {
        this._emit(socket, 'c:refused', { why: x.why || 'released', refunded: !!x.refunded, closed: true });
      } else if (outcome === 'refunded') {
        this._emit(socket, 'c:closed', { refundedMicro: x.refundedMicro || 0, why: x.why || 'emergency' });
      } else if (outcome === 'frozen-settled') {
        this._emit(socket, 'c:closed', { refundedMicro: 0, why: outcome });
      }
      // 'cashedout' and 'settled': the payout tells the page (c:cashedout, then c:paid or c:payerror)
      if (outcome !== 'aborted') {
        this.watchers.set(sid, socket);
        if (this.onSeatless) this._safe(() => this.onSeatless(socket, this, outcome));
      }
    }
    if (!p) return;
    p.sid = null;
    p.socket = null;
    if (outcome === 'eaten' && p.dying > 0) return;    // gameOver removes it once the death animation ends
    this.removePlayer(p);
  }

  _tell(socketId, event, payload) {
    const p = socketId ? this.bySocket.get(socketId) : null;
    if (p && p.socket) this._emit(p.socket, event, payload);
  }

  _emit(socket, event, payload) {
    if (!socket || typeof socket.emit !== 'function') return;
    try {
      socket.emit(event, payload);
    } catch (e) {
      this.log.error('[CHOMP] emit ' + event, e && e.message);
    }
  }

  _safe(fn) {
    try {
      fn();
    } catch (e) {
      this.log.error('[CHOMP] directory hook', e && e.stack ? e.stack : e);
    }
  }

  // EMERGENCY_FAIL_TICKS throwing ticks in a row: the room stops for good. A paid room first refunds every open
  // balance in full and gives every coin back (Owen Q6 for agar: a crash is our fault); the directory opens a fresh
  // room at this index and keeps this one on its settling list while its bank still holds money.
  emergencyClose() {
    if (this.closed) return;
    this.closed = true;
    if (this.money) {
      try {
        this.money.emergencySettle();
      } catch (e) {
        this.log.error('[CHOMP] EMERGENCY settle threw', this.lobbyType, e && e.stack ? e.stack : e);
      }
      for (const [sid, socket] of Array.from(this.watchers)) {
        this.watchers.delete(sid);
        this.detach(socket);
        if (this.onSeatless) this._safe(() => this.onSeatless(socket, this, 'emergency'));
      }
    }
    this.log.error('[CHOMP] EMERGENCY close', this.lobbyType);
    this.stop();
    if (typeof this.onClosed === 'function') {
      try {
        this.onClosed(this);
      } catch (e) {
        this.log.error('[CHOMP] replace failed', e && e.stack ? e.stack : e);
      }
    }
  }

  stop() {
    this.stopped = true;
    this.awake = false;
  }
}

module.exports = { ChompRoom, SNAP_EVERY, COLORS, NAME_MAX, stakeLabel, DROP_REACH };
