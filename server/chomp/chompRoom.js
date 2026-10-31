'use strict';
// One Chomp arena: the sim, run at TICK_HZ on the server. The browser only draws and predicts its own chomper with the
// same movement code (shared/chompMove.js); every eat, death and score is decided here.
//
// Rules in short (numbers and their sources in shared/chompRules.js):
//   - chompers move by the arcade's rules (tile corridors, buffered turns, cornering); a dot gives a tiny speed bump
//   - dots 10, energizers 50; an energizer turns every ghost blue FOR ITS EATER (blueFor) AND lets them eat other players
//     for the fright time, on the arcade's 200/400/800/1600 chain, moving faster while it lasts; a fruit (cherry) gives
//     a big FRUIT_BOOST_S burst of speed (Owen 2026-10-30)
//   - a ghost (or a powered player) on your tile, or swapping tiles with you in one tick (passing through each other at
//     speed), takes a life; you come back blinking (safe) where no ghost is near
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
const Resize = require('./chompResize');
const { pickName } = require('../botNames');

const DT = 1 / R.TICK_HZ;
const SNAP_EVERY = Math.round(R.TICK_HZ / R.SNAP_HZ);
const COLORS = 8;                       // chomper colour slots (the page owns the palette)
const NAME_MAX = 15;
const DROP_REACH = 6;                   // CHOSEN: coins land on path tiles at most this many steps from the death tile
const EMERGENCY_FAIL_TICKS = 3;         // agRoom's: this many throwing ticks in a row close a room for good
const LATE_LOG_OF = 20;                 // CHOSEN (night review 2026-10-29): a paid seat's late turns looked at together,
const LATE_LOG_DEEP = 15;               //   and how many of them near the limit get it logged (_noteLateTurn)

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
    // a torus (Owen 2026-10-26: walk off any edge and come back on the other), unless a test asks for the sealed arena
    this.A = Maze.build(opts.mx || R.MODULES_X, opts.my || R.MODULES_Y, { wrap: opts.wrap !== false });
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
    this.layout();
    // the arena grows and shrinks with the crowd (chompResize.js), on a torus only; a test may hold it still
    this.grow = opts.grow !== false && this.A.wrap;
    this.lastResize = 0;
    this.arenaMsg = null;                   // a resize's c:arena, sent before the next snapshot

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
    this.watchAt = new Map();               // socket id -> { id?, x, y }: where a watcher's window is (_watchCentre)
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

  // What depends on the arena's shape, worked out again after a resize: the spawn candidates (every plain path tile
  // outside the ring round a house), the house rings, the bots' search buffers.
  layout() {
    this.spawnTiles = [];
    this.nearHouse = new Uint8Array(this.A.W * this.A.H);
    this._bfs = null;
    const H = Maze.HOUSE;
    for (let r = 0; r < this.A.H; r++) for (let c = 0; c < this.A.W; c++) {
      const k = r * this.A.W + c;
      const m = this.A.modules[this.A.moduleOf[k]], lc = c - m.ox, lr = r - m.oy;
      if (lc >= H.c0 - 1 && lc <= H.c1 + 1 && lr >= H.r0 - 1 && lr <= H.r1 + 1) { this.nearHouse[k] = 1; continue; }
      if (this.A.cell[k] !== Maze.PATH) continue;
      this.spawnTiles.push(k);
    }
  }

  // Grow or shrink by a module column or row where nobody can see it (chompResize.js), at most once per RESIZE_GAP_S.
  resizeCheck() {
    if (!this.grow || this.tick - this.lastResize < R.RESIZE_GAP_S * R.TICK_HZ) return false;
    const pl = Resize.plan(this);
    if (!pl) return false;
    const msg = Resize.apply(this, pl);
    if (!msg) return false;
    this.lastResize = this.tick;
    this.arenaMsg = msg;
    this.log.log('[CHOMP] ' + this.lobbyType + ' arena ' + (pl.op > 0 ? 'grew' : 'shrank') + ' to ' + msg.mx + 'x' + msg.my +
      ' (' + this.players.size + ' chompers)');
    return true;
  }

  // ---- seats
  // skin: the Customize look ('f:<id>' free, 'p:<id>' bought, '' the game's own; chompBoot skinOf checked it)
  addPlayer({ name, socketId = null, bot = false, skin = '' }) {
    if (this.players.size >= R.MAX_PLAYERS) return null;
    const id = this.nextId; this.nextId = this.nextId >= 65000 ? 1 : this.nextId + 1;
    const p = {
      id, sid: socketId, bot, name: String(name || 'Player').slice(0, NAME_MAX), color: this.colorNext++ % COLORS,
      x: 0, y: 0, dir: -1, want: -1, face: 1, pause: 0, moving: false,
      // a paid room is always one life (a catch closes the account), whatever the free room's rule
      score: 0, lives: this.money ? 1 : R.LIVES, bonus: false, power: 0, powerAt: -1, boost: 0, bump: 0, chain: 0, safe: 0, dying: 0,
      pk: -1,
      over: false,
      seq: 0, seqTick: 0, hist: [], pend: null, joinedTick: this.tick, brain: bot ? Bots.brain(this.rng) : null,
      skin: typeof skin === 'string' && /^[fp]:[a-z][a-z0-9]{0,23}$/.test(skin) ? skin : '',
    };
    this.players.set(id, p);
    if (socketId) this.bySocket.set(socketId, p);
    this.place(p);
    this.events.push({ k: 'meta', id, n: p.name, c: p.color, s: p.skin });
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
    return [...this.players.values()].map(p => ({ id: p.id, n: p.name, c: p.color, s: p.skin }));
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
      if (this.A.wc(pc + v[0] * k) === c && this.A.wr(pr + v[1] * k) === r) { p.pend = { d, c, r, until: this.tick + R.LATE_TURN_TICKS }; return; }
    }
    p.want = d;
    if (pc !== c || pr !== r) this.lateTurn(p, d, c, r);
  }

  // The page pressed in tile (c, r), which we went through in the last LATE_TURN_TICKS ticks without changing
  // direction: take the turn at the first tile from there that has the opening (where the page turned) and move on
  // from it. Movement only, and only where the same rules would have turned.
  // Lying about (c, r) still buys time: a page can hold a turn back and name the tile later, after seeing where the
  // ghosts went. So a paid room (night review 2026-10-29) takes a turn back only LATE_TURN_TICKS_PAID ticks, never
  // through a ghost or a powered chomper on the way (_lateTurnThreat), and logs a seat whose turns keep landing near
  // that limit (_noteLateTurn). A turn it does not take back waits for the next opening, as one sent too late always did.
  lateTurn(p, d, c, r) {
    const h = p.hist;
    const lo = this.money ? Math.max(0, h.length - R.LATE_TURN_TICKS_PAID) : 0;
    let i = h.length - 1, first = -1, last = -1;
    for (; i >= lo; i--) {
      if (h[i].dir !== p.dir) break;
      if (Math.floor(h[i].x) === c && Math.floor(h[i].y) === r) { first = i; if (last < 0) last = i; }
      else if (first >= 0) break;
    }
    if (first < 0) return;
    let j = first;
    for (; j < h.length; j++) if (Move.canGo(this.A, Math.floor(h[j].x), Math.floor(h[j].y), d)) break;
    if (j >= h.length) return;
    const speed = this.speedOf(p);
    // the move on from the turn, worked out first on a copy (a paid room checks it before anything moves)
    const t = { x: h[j].x, y: h[j].y, dir: d, moving: p.moving };
    const path = [];
    for (let k = j + 1; k < h.length; k++) {
      // each tick at the speed it ran at (a dot's bump, a cherry or a power pellet can start or end on the way)
      const spd = h[k].spd || speed;
      if (!h[k].paused) Move.advance(t, this.A, spd * DT);
      path.push({ x: t.x, y: t.y, dir: t.dir, paused: h[k].paused, spd });
    }
    if (this.money) {
      if (this._lateTurnThreat(p, path)) return;
      this._noteLateTurn(p, h.length - 1 - last);
    }
    p.x = t.x; p.y = t.y; p.dir = d; p.moving = t.moving;
    for (let k = 0; k < path.length; k++) h[j + 1 + k] = path[k];
    p.face = p.dir;
  }

  // Would the turn taken back carry p through something that catches it? The move on checks no catch, so a ghost
  // (not blue for p) or, p unpowered, a powered chomper standing now on a tile of that path says no. A chomper
  // blinking safe or shielded meets nothing.
  _lateTurnThreat(p, path) {
    if (!path.length || p.safe > 0 || this.shielded.has(p.id)) return false;
    const W = this.A.W, tiles = new Set();
    for (const s of path) tiles.add(Math.floor(s.y) * W + Math.floor(s.x));
    for (const g of this.ghosts) {
      if (g.state === 'active' && !this.blueFor(p, g) && tiles.has(Math.floor(g.y) * W + Math.floor(g.x))) return true;
    }
    if (p.power > 0) return false;
    for (const q of this.players.values()) {
      if (q === p || q.power <= 0 || q.dying || q.over || this.shielded.has(q.id)) continue;
      if (tiles.has(Math.floor(q.y) * W + Math.floor(q.x))) return true;
    }
    return false;
  }

  // A paid seat's last LATE_LOG_OF turns taken back, by how late each came (ticks since we left the tile it named).
  // An honest page is lined up with us and comes late only by its jitter; a page that keeps landing within 3 ticks of
  // the limit looks like one holding its turns back on purpose (or a device far too slow to keep time): logged once a
  // seat, for the owner to look at.
  _noteLateTurn(p, late) {
    const ring = p.lateTurns || (p.lateTurns = []);
    ring.push(late);
    if (ring.length > LATE_LOG_OF) ring.shift();
    if (p.lateLogged || ring.length < LATE_LOG_OF) return;
    const near = R.LATE_TURN_TICKS_PAID - 4;
    const deep = ring.filter((n) => n >= near).length;
    if (deep < LATE_LOG_DEEP) return;
    p.lateLogged = true;
    this.log.warn('[CHOMP] LATE-TURN pattern ' + this.lobbyType + ' pid ' + p.id + ' ' + JSON.stringify(p.name) + ': ' +
      deep + ' of its last ' + LATE_LOG_OF + ' turns came ' + near + '+ ticks after it left the tile (limit ' +
      (R.LATE_TURN_TICKS_PAID - 1) + ')');
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
    p.hist = []; p.pend = null; p.pk = -1;
  }

  dangerDist(x, y, self) {
    let best = Infinity;
    const A = this.A;
    for (const g of this.ghosts) {
      if (g.state !== 'active') continue;
      best = Math.min(best, Math.hypot(A.dx(x, g.x), A.dy(y, g.y)));
    }
    for (const q of this.players.values()) {
      if (q === self || q.power <= 0 || q.dying || q.over) continue;
      best = Math.min(best, Math.hypot(A.dx(x, q.x), A.dy(y, q.y)));
    }
    return best;
  }

  // The player a ghost hunts: the nearest one in range that is in play and not blinking safe (nor shielded: a paid
  // seat whose page has not drawn it yet).
  nearestPrey(x, y, range) {
    let best = null, bestD = range * range;
    for (const p of this.players.values()) {
      if (p.dying || p.over || p.safe > 0 || this.shielded.has(p.id)) continue;
      const dx = this.A.dx(x, p.x), dy = this.A.dy(y, p.y), d = dx * dx + dy * dy;
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
    this.scareGhosts();
    for (const g of this.ghosts) {
      g.pk = Math.floor(g.y) * this.A.W + Math.floor(g.x);   // the tile it left from (collide: swaps)
      Ghosts.step(g, this.A, this, DT);
    }
    this.collide();
    if (this.tick % 30 === 0) { this.respawnPellets(); this.stepFruit(); }
    if (this.tick % 15 === 0) this.fillBots(1);
    if (this.money) {
      const facts = this.moneyFacts;
      this.moneyFacts = [];
      this.money.afterStep({ money: facts });
    }
    if (this.grow && this.tick % (R.RESIZE_EVERY_S * R.TICK_HZ) === 0) this.resizeCheck();
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
    if (p.boost > 0) p.boost--;
    if (p.bump > 0) p.bump--;
    if (p.safe > 0) p.safe--;
    p.pk = Math.floor(p.y) * this.A.W + Math.floor(p.x);     // the tile it left from (collide: swaps)
    if (this.still.has(p.id)) {
      // a paid seat waiting for its page, a dropped one gone dormant, or a frozen one: it does not move
      p.moving = false;
      p.hist.push({ x: p.x, y: p.y, dir: p.dir, paused: true, spd: 0 });
      if (p.hist.length > R.LATE_TURN_TICKS) p.hist.shift();
      return;
    }
    if (p.pend && ((Math.floor(p.x) === p.pend.c && Math.floor(p.y) === p.pend.r) || this.tick >= p.pend.until)) {
      p.want = p.pend.d; p.pend = null;
    }
    const speed = this.speedOf(p);
    const paused = p.pause > 0;
    Move.tick(p, this.A, speed, DT, this.dots, (k, kind) => this.eatDot(p, k, kind));
    if (p.dir >= 0) p.face = p.dir;
    p.hist.push({ x: p.x, y: p.y, dir: p.dir, paused, spd: speed });
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
    p.bump = R.DOT_BUMP_TICKS;          // the tiny push forward, from the next tick (the page's prediction does the same)
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

  // Owen 2026-10-26: an energizer turns EVERY ghost blue for its eater only; other players still see (and meet)
  // normal ghosts unless they ate their own. The server keeps each player's own fright timer (p.power, from p.powerAt);
  // each page draws ghosts blue from its own timer (public/js/chomp/chompMain.js blueForMe, the same rule).
  powerUp(p) {
    p.power = R.FRIGHT_S * R.TICK_HZ;
    p.powerAt = this.tick;
    p.chain = 0;
    // the eater's page needs exactly which ghosts are home as eyes now (they come back out normal for it)
    const home = [];
    this.ghosts.forEach((g, i) => { if (g.state === 'eyes' || g.state === 'entering') home.push(i); });
    this.events.push({ k: 'power', id: p.id, home });
  }

  // Ghost g is blue for p while p's power lasts, unless it went home as eyes since p's energizer: it comes back out
  // normal, as in the arcade (backAt is the tick its eyes got home, chompGhosts step).
  blueFor(p, g) {
    return p.power > 0 && g.state !== 'eyes' && g.state !== 'entering' && g.backAt <= p.powerAt;
  }

  speedOf(p) {
    return R.pace(p.power > 0, p.boost > 0, p.bump > 0);
  }

  // One ghost has one body, so how it MOVES is shared: blue for somebody within FLEE_RADIUS, it takes the arcade's
  // frightened walk (random turns at half speed, reversing as it turns blue) for everyone; g.fright is that flag.
  scareGhosts() {
    const eaters = [];
    for (const p of this.players.values()) if (p.power > 0 && !p.dying && !p.over) eaters.push(p);
    const r2 = R.FLEE_RADIUS * R.FLEE_RADIUS, A = this.A;
    for (const g of this.ghosts) {
      let on = 0;
      if (g.state === 'active') {
        for (const p of eaters) {
          const dx = A.dx(p.x, g.x), dy = A.dy(p.y, g.y);
          if (dx * dx + dy * dy <= r2 && this.blueFor(p, g)) { on = 1; break; }
        }
        if (on && !g.fright) g.reverse = true;       // DOSSIER: chase/scatter -> frightened reverses
      }
      g.fright = on;
    }
  }

  addScore(p, pts) {
    p.score += pts;
    if (R.BONUS_LIFE && !this.money && !p.bonus && p.score >= R.EXTRA_LIFE_AT) {
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
    p.boost = Math.round(R.FRUIT_BOOST_S * R.TICK_HZ);
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

  // Two things meet when they stand on one tile, or when they swapped tiles this tick: heading at each other they can
  // pass through one another between two ticks (more often at a cherry's or a power pellet's speed, up to a quarter
  // tile a tick), which must still be a meeting. `swap` files each chomper that changed tile by from * N + to.
  collide() {
    const W = this.A.W, N = W * this.A.H, at = new Map(), swap = new Map();
    for (const p of this.players.values()) {
      if (p.dying || p.over || this.shielded.has(p.id)) continue;
      const k = Math.floor(p.y) * W + Math.floor(p.x);
      p.tk = k;
      const list = at.get(k);
      if (list) list.push(p); else at.set(k, [p]);
      if (p.pk >= 0 && p.pk !== k) {
        const sk = p.pk * N + k, sl = swap.get(sk);
        if (sl) sl.push(p); else swap.set(sk, [p]);
      }
    }
    if (!at.size) return;
    for (const g of this.ghosts) {
      if (g.state !== 'active') continue;
      const gk = Math.floor(g.y) * W + Math.floor(g.x);
      let list = at.get(gk);
      const crossed = g.pk >= 0 && g.pk !== gk ? swap.get(gk * N + g.pk) : null;
      if (crossed) list = list ? list.concat(crossed) : crossed;
      if (!list) continue;
      // each player's own fright decides: blue for anyone met, it is eaten (and its eyes go home for everyone); else
      // it catches everyone it met not blinking safe
      const eater = list.find((p) => !p.dying && this.blueFor(p, g));
      if (eater) { this.eatGhost(eater, g); continue; }
      for (const p of list) if (!p.dying && p.safe <= 0) this.kill(p, null, g);
    }
    for (const list of at.values()) {
      if (list.length < 2) continue;
      for (const a of list) this.eatPlayers(a, list);
    }
    for (const a of this.players.values()) {
      if (a.power <= 0 || a.dying || a.over || a.pk < 0 || a.pk === a.tk || this.shielded.has(a.id)) continue;
      const crossed = swap.get(a.tk * N + a.pk);
      if (crossed) this.eatPlayers(a, crossed);
    }
  }

  // A powered chomper a eats every chomper in list it met that is not powered, blinking safe or already caught.
  eatPlayers(a, list) {
    if (a.power <= 0 || a.dying) return;
    for (const b of list) {
      if (b === a || b.power > 0 || b.safe > 0 || b.dying) continue;
      const pts = R.PLAYER_POINTS[Math.min(a.chain, R.PLAYER_POINTS.length - 1)];
      a.chain++;
      this.addScore(a, pts);
      this.events.push({ k: 'eatp', id: a.id, v: b.id, x: b.x, y: b.y, pts });
      this.kill(b, a);
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
    p.power = 0; p.boost = 0; p.bump = 0; p.chain = 0; p.want = -1; p.moving = false;
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
    if (!A.walk(c0, r0)) { c0 = A.wc(Math.round(p.x - 0.5)); r0 = A.wr(Math.round(p.y - 0.5)); }
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
          const nc = A.wc(c + dc), nr = A.wr(r + dr), nk = nr * W + nc;
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
      if (Math.abs(this.A.dx(c + 0.5, p.x)) <= d && Math.abs(this.A.dy(r + 0.5, p.y)) <= d) return true;
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
  // Every chomper in play and every ghost, as the wire carries them.
  snapParts() {
    const ps = [];
    for (const p of this.players.values()) {
      if (p.over) continue;
      const F = Wire.F;
      ps.push({
        id: p.id, x: p.x, y: p.y, dir: p.dir < 0 ? -1 : p.dir, seq: p.seq, since: this.tick - p.seqTick,
        power: p.power,
        flags: (p.moving ? F.MOVING : 0) | (p.power > 0 ? F.POWER : 0) | (p.safe > 0 || this.shielded.has(p.id) ? F.SAFE : 0) | (p.dying ? F.DYING : 0) |
          (p.boost > 0 ? F.BOOST : 0) | (p.bump > 0 ? F.BUMP : 0),
      });
    }
    const gs = this.ghosts.map(g => ({ x: g.x, y: g.y, dir: g.dir, look: g.plan >= 0 ? g.plan : g.dir, kind: g.ki, state: Ghosts.STATE[g.state] }));
    return { ps, gs };
  }

  snapshot() {
    const { ps, gs } = this.snapParts();
    return Wire.encode(this.tick, this.mode === 'chase' ? 1 : 0, ps, gs);
  }

  // Night review 2026-10-29: one snapshot for the whole room showed every page every chomper and ghost on the maze,
  // their power and each ghost's next turn, far past any screen. A paid room whose arena is wider or taller than
  // PAID_SEND_TILES (a torus of 4 or more modules on an axis) sends each page its own instead: snapshotFor round the
  // chomper it plays, or for a watcher the one it follows (_watchCentre). A smaller arena fits every page's window
  // whole and keeps the one shared snapshot.
  culls() {
    return !!this.money && this.A.wrap && (this.A.W > R.PAID_SEND_TILES || this.A.H > R.PAID_SEND_TILES);
  }

  inWindow(centre, x, y) {
    const half = R.PAID_SEND_TILES / 2;
    return Math.abs(this.A.dx(centre.x, x)) <= half && Math.abs(this.A.dy(centre.y, y)) <= half;
  }

  // The chompers within the window round centre ({ x, y }, a chomper's own always in), and every ghost slot: a ghost
  // outside is AWAY, set half the arena off (never on any screen), so each keeps its place in the list.
  snapshotFor(centre, parts) {
    const A = this.A;
    const ps = parts.ps.filter((q) => q.id === centre.id || this.inWindow(centre, q.x, q.y));
    const fx = A.wx(centre.x + A.W / 2), fy = A.wy(centre.y + A.H / 2);
    const gs = parts.gs.map((g) => (this.inWindow(centre, g.x, g.y) ? g
      : { x: fx, y: fy, dir: 0, look: 0, kind: g.kind, state: Wire.AWAY }));
    return Wire.encode(this.tick, this.mode === 'chase' ? 1 : 0, ps, gs);
  }

  // The chomper a Spectate page follows first: the board's top (the richest), else any chomper in play.
  leader() {
    const top = this.board()[0];
    const p = top ? this.players.get(top[0]) : null;
    if (p && !p.over) return p;
    for (const q of this.players.values()) if (!q.over) return q;
    return null;
  }

  // The middle of a watcher's window: the chomper its page follows (c:watch), else the spot its own seat ended on, else
  // the room's leader. null when nobody is in play (nothing to cut).
  _watchCentre(socketId, lead) {
    const w = this.watchAt.get(socketId);
    if (w) {
      const q = w.id ? this.players.get(w.id) : null;
      if (q && !q.over) { w.x = q.x; w.y = q.y; return q; }
      if (w.x != null) return w;
    }
    return lead;
  }

  // A watcher's page follows chomper id now (its Spectate bar, chompBoot c:watch): its window moves with it. Only to a
  // chomper inside the window it is sent (the ones its page can pick), so a watcher cannot jump across the arena.
  watch(socketId, id) {
    if (!this.money || this.stopped || !this.watchers.has(socketId) || this.bySocket.has(socketId)) return false;
    const q = this.players.get(id);
    if (!q || q.over) return false;
    if (this.culls()) {
      const c = this._watchCentre(socketId, this.leader());
      if (c && !this.inWindow(c, q.x, q.y)) return false;
    }
    this.watchAt.set(socketId, { id, x: q.x, y: q.y });
    return true;
  }

  // One volatile snapshot a socket of this room, each cut to its own window.
  _flushCulled() {
    const ids = this.nsp.adapter && this.nsp.adapter.rooms ? this.nsp.adapter.rooms.get(this.ioRoom) : null;
    if (!ids || !ids.size) return;
    const parts = this.snapParts();
    const lead = this.leader();
    let whole = null;
    for (const sid of ids) {
      const s = this.nsp.sockets.get(sid);
      if (!s) continue;
      const seat = this.bySocket.get(sid);
      const centre = seat && !seat.over ? seat : this._watchCentre(sid, lead);
      let buf;
      if (centre) buf = this.snapshotFor(centre, parts);
      else buf = whole || (whole = Wire.encode(this.tick, this.mode === 'chase' ? 1 : 0, parts.ps, parts.gs));
      s.volatile.emit('c:s', Buffer.from(buf));
    }
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
      mx: this.A.mx, my: this.A.my, wrap: this.A.wrap ? 1 : 0, tick: this.tick, hz: R.TICK_HZ, metas: this.metas(),
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
    // a resize first: every position after it is in the new arena's numbers
    if (this.arenaMsg) { to().emit('c:arena', this.arenaMsg); this.arenaMsg = null; }
    if (this.culls()) this._flushCulled();
    else to().volatile.emit('c:s', Buffer.from(this.snapshot()));
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
      // still in its spawn blink (or shielded): no ghost or player can catch it yet
      safe: (pid) => {
        const p = this.players.get(pid);
        return !!(p && (p.safe > 0 || this.shielded.has(pid)));
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
    const p = this.addPlayer({ name, socketId: socket.id, skin: socket.chSkin });
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
    this.watchAt.delete(socket.id);
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
        this.watchAt.set(old.id, { x: p.x, y: p.y });   // its page stays on the spot it left
        if (this.onSeatless) this._safe(() => this.onSeatless(old, this, 'replaced'));
      }
    }
    if (this.money.resume(pid, socket.id) === false) return false;
    p.sid = socket.id;
    p.socket = socket;
    this.bySocket.set(socket.id, p);
    this.watchers.delete(socket.id);
    this.watchAt.delete(socket.id);
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
    this.watchAt.delete(socketId);
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
        if (p) this.watchAt.set(sid, { x: p.x, y: p.y });   // its page stays on the spot it ended on
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
