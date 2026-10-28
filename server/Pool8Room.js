'use strict';
/* ─── One 8 Ball Pool match ───────────────────────────────────────────────────
   Two players, one table, turn by turn. The shooter aims on their own screen and
   sends one message: the angle, the power, the spin, where they put the cue ball
   when it is in hand, and the pocket they call for the 8. The SERVER plays the
   whole shot through (shared/pool8Sim.js), judges it (shared/pool8Rules.js) and
   sends both screens the tape to animate and the verdict. No client ever says
   where a ball went.

   THE RULES ARE MINICLIP 8 BALL POOL'S (docs/pool8-reference.md). The shot clock
   runs here; a turn that runs out is a foul (ball in hand to the other player)
   and the third in a row loses the match.

   THE SEATS AND THE MONEY ARE KNOCKOUT'S. This room extends KnockoutRoom for
   everything that decides who is owed what: addPlayer (the server-recorded
   worth from the entry token), pot(), removePlayer (walking out forfeits),
   finish() (settles exactly once; the result message carries duelMoney's display
   figures), the bot's neutral id and the watcher room. What is new here is only
   the game. */

const crypto = require('crypto');
const { KnockoutRoom } = require('./KnockoutRoom');
const Sim = require('../shared/pool8Sim');
const Rules = require('../shared/pool8Rules');
const { P8 } = Sim;

let nextId = 1;

const P8R = {
  VS_MS: 3000,           // the two player cards before the break (CHOSEN, see docs/pool8-reference.md)
  SHOT_MS: 25000,        // the shot clock per turn: MEASURED, the reference's timer ring runs out in about 25 s
  ROLL_PAD_MS: 400,      // after the tape's last ball stops, before the next turn opens
  WIN_HOLD_MS: 2500,     // the final shot's result sits on screen this long before the result card
};

/* A field from a client as a plain number, or NaN. Only a real number or a short numeric string is read: Number()
   on a client-built object calls its toString/valueOf and can THROW (the Head Soccer review's guard). */
const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.length < 24 ? Number(v) : NaN);
const fin = (v, d) => { const n = num(v); return Number.isFinite(n) ? n : d; };
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

class Pool8Room extends KnockoutRoom {
  constructor(io) {
    super(io, 'p8_' + (nextId++), 'p8');
    this.balls = Sim.newRack();
    this.rules = Rules.newState(0);
    this.turn = 0;                 // shots taken: the lobby's watch order and earlyEnough read it
    this.lastShot = null;          // the last tape sent, for a watcher arriving mid-roll
    this.pending = null;           // the verdict that ends the match, finished after the hold
    this.shotEndsAt = 0;
  }

  sideOfSocket(socketId) {
    const p = this.players.get(socketId);
    return p ? p.side : null;
  }

  socketOfSide(side) {
    for (const [id, p] of this.players) if (p.side === side) return id;
    return null;
  }

  start(now) {
    if (this.players.size < 2) return false;
    const t = typeof now === 'number' ? now : Date.now();
    // A rack dealt at random, as the reference deals it (shared/pool8Sim.js rackOrder).
    this.balls = Sim.newRack(Sim.rackOrder());
    // Who breaks is a coin toss.
    this.rules = Rules.newState(Math.random() < 0.5 ? 0 : 1);
    this.state = 'countdown';
    this.phaseEndsAt = t + P8R.VS_MS;
    this.broadcast('p8:start', this.publicState(t));
    return true;
  }

  tick(now) {
    const t = typeof now === 'number' ? now : Date.now();
    if (this.state === 'waiting' || this.state === 'over') return;
    if (this.state === 'countdown' && t >= this.phaseEndsAt) return this.openTurn(t, '');
    if (this.state === 'aiming' && t >= this.phaseEndsAt) return this.timedOut(t);
    if (this.state === 'rolling' && t >= this.phaseEndsAt) return this.openTurn(t, this.nextMsg || '');
    if (this.state === 'settling' && t >= this.phaseEndsAt) return this.decideNow();
  }

  openTurn(t, msg) {
    this.state = 'aiming';
    this.phaseEndsAt = t + P8R.SHOT_MS;
    this.nextMsg = '';
    this.broadcast('p8:turn', this.turnState(t, msg));
  }

  turnState(t, msg) {
    return {
      turn: this.rules.turn, inHand: this.rules.inHand, groups: this.rules.groups.slice(),
      onEight: [Rules.onEight(this.rules, this.balls, 0), Rules.onEight(this.rules, this.balls, 1)],
      ms: Math.max(0, this.phaseEndsAt - t), shotMs: P8R.SHOT_MS, broken: this.rules.broken,
      timeouts: this.rules.timeouts.slice(), msg: msg || '', balls: packBalls(this.balls), shots: this.turn,
    };
  }

  /* The live aim of the shooter, for the other screen and the watchers (Miniclip shows the opponent's cue moving).
     Display only: nothing here is kept or believed. */
  aim(socketId, msg) {
    if (this.state !== 'aiming' || !msg || typeof msg !== 'object') return false;
    const side = this.sideOfSocket(socketId);
    if (side === null || side !== this.rules.turn) return false;
    const out = { a: Math.round(fin(msg.a, 0) * 1000) / 1000, p: clamp(Math.round(fin(msg.p, 0) * 100) / 100, 0, 1) };
    if (this.rules.inHand) {
      const x = fin(msg.x, NaN), y = fin(msg.y, NaN);
      if (Number.isFinite(x) && Number.isFinite(y)) { out.x = Math.round(clamp(x, 0, P8.L)); out.y = Math.round(clamp(y, 0, P8.W)); }
    }
    if (this.io && this.io.to) {
      const to = this.io.to(this.socketRoomName);
      (to.volatile || to).emit('p8:aim', out);
      if (this.watchers > 0) { const w = this.io.to(this.watchRoomName); (w.volatile || w).emit('p8:aim', out); }
    }
    return true;
  }

  /* THE SHOT. Checked, played through and judged here. Returns true when it was taken. */
  shoot(socketId, msg, now) {
    const t = typeof now === 'number' ? now : Date.now();
    if (this.state !== 'aiming' || !msg || typeof msg !== 'object') return false;
    if (t > this.phaseEndsAt) return false;      // the clock ran out first: the next tick times the turn out
    const side = this.sideOfSocket(socketId);
    if (side === null || side !== this.rules.turn) return false;
    let a = fin(msg.a, NaN);
    if (!Number.isFinite(a) || Math.abs(a) > 100) return false;
    const p = clamp(fin(msg.p, 0), 0, 1);
    if (p < 0.01) return false;
    let sx = clamp(fin(msg.sx, 0), -1, 1), sy = clamp(fin(msg.sy, 0), -1, 1);
    const sl = Math.hypot(sx, sy);
    if (sl > 1) { sx /= sl; sy /= sl; }

    // The cue ball: moved by the shooter only when it is in hand, and only to a legal spot.
    const cue = this.balls[0];
    if (this.rules.inHand) {
      const kitchen = this.rules.inHand === 'kitchen';
      const x = fin(msg.x, NaN), y = fin(msg.y, NaN);
      if (Number.isFinite(x) && Number.isFinite(y) && Sim.placeOk(this.balls, x, y, kitchen)) {
        cue.x = x; cue.y = y; cue.on = true;
      } else if (!cue.on || !Sim.placeOk(this.balls, cue.x, cue.y, kitchen)) {
        const spot = freeSpot(this.balls, kitchen);
        cue.x = spot.x; cue.y = spot.y; cue.on = true;
      }
    }
    if (!cue.on) { const spot = freeSpot(this.balls, false); cue.x = spot.x; cue.y = spot.y; cue.on = true; }

    // The pocket called for the 8, when the shooter is on it.
    const on8 = Rules.onEight(this.rules, this.balls, side);
    let call = null;
    if (on8) {
      const c = Math.floor(fin(msg.call, NaN));
      call = c >= 0 && c <= 5 ? c : null;
    }

    /* THE CUE IS NEVER PERFECT. The page runs the same physics, so a modified client could search shots offline on the
       positions it is sent and play the one it found to the last digit (Opus review 2026-10-28). Every shot leaves
       here with a hair of error of the server's own, from crypto: about 0.05 degrees on a soft shot and 0.15 at
       full power (CHOSEN: far under what a hand can aim, so play feels the same). */
    a += this.aimError(p);
    const before = this.balls.map(b => ({ n: b.n, x: b.x, y: b.y, on: b.on }));
    const r = Sim.simulate(before, { a, p, sx, sy });
    const v = Rules.judge(this.rules, before, r, call);
    this.balls = r.balls;
    if (v.respot8) respotEight(this.balls);
    if (r.cuePotted) this.balls[0].on = false;
    this.rules = v.st;
    this.turn++;

    this.lastShot = {
      shooter: side, cue: { x: Math.round(before[0].x * 10) / 10, y: Math.round(before[0].y * 10) / 10 },
      shot: { a: Math.round(a * 10000) / 10000, p: Math.round(p * 1000) / 1000, sx: Math.round(sx * 100) / 100, sy: Math.round(sy * 100) / 100 },
      call, tape: r.tape, ev: r.ev, foul: v.foul, msg: v.msg, keep: v.keep, pots: v.pots, respot8: v.respot8,
      groups: this.rules.groups.slice(), next: this.rules.turn, inHand: this.rules.inHand,
      over: v.over ? { winnerSide: v.over.winner, why: v.over.why } : null,
      balls: packBalls(this.balls), at: t,
    };
    this.broadcast('p8:shot', this.lastShot);
    const rollMs = r.tape.dur + P8R.ROLL_PAD_MS;
    if (v.over) return this.settle(t + rollMs, v.over), true;
    this.state = 'rolling';
    this.phaseEndsAt = t + rollMs;
    this.nextMsg = v.msg;
    return true;
  }

  // The server's own aim error for a shot of power p, in radians (a test proving an exact shot sets it to 0).
  aimError(p) { return gauss() * (0.05 + 0.1 * p) * Math.PI / 180; }

  timedOut(t) {
    const v = Rules.timeout(this.rules);
    this.rules = v.st;
    if (v.over) {
      this.broadcast('p8:timeout', { side: 1 - v.over.winner, msg: v.msg, over: true });
      return this.settle(t, v.over);
    }
    this.broadcast('p8:timeout', { side: 1 - this.rules.turn, msg: v.msg, over: false });
    this.openTurn(t, v.msg);
  }

  /* The match is decided: the verdict is kept, the last shot rolls out on the screens, and then it is finished.
     Somebody leaving in between is settled by this verdict (decideNow), never by the walk-out. */
  settle(at, over) {
    this.pending = over;
    this.state = 'settling';
    this.phaseEndsAt = at + P8R.WIN_HOLD_MS;
  }

  decideNow() {
    if (this.state === 'over' || !this.pending) return;
    /* removePlayer decides BEFORE it removes anybody, so the winner is always still seated here. finish() pays only a
       seated player, so a winner somehow gone is settled as no winner (each seat its own stake back) rather than
       paying a refund to the loser alone (both reviews 2026-10-28). */
    this.finish(this.socketOfSide(this.pending.winner) || null, this.pending.why);
  }

  /* The result's extras (never money): the groups, and each seat's group balls potted, the card's score. */
  overExtra() {
    const score = [0, 1].map(s => {
      const g = this.rules.groups[s];
      return g ? 7 - Rules.left(this.balls, g) : 0;
    });
    return { groups: this.rules.groups.slice(), score };
  }

  publicState(now) {
    const t = typeof now === 'number' ? now : Date.now();
    return {
      id: this.id,
      state: this.state,
      phaseMs: Math.max(0, this.phaseEndsAt - t),
      vsBot: !!this.bot,
      players: [...this.players.entries()].map(([id, p]) => ({
        id: this.publicId(id), name: p.name, side: p.side, skin: p.skin || null,
      })),
      stake: this.stake,
      pot: this.pot(),
      table: tableInfo(),
      rules: this.turnState(t, ''),
    };
  }

  /* ── what a watcher is told ─────────────────────────────────────────────
     Everything on the table is on both screens already; a watcher gets the same, by seat, with no socket ids. Only
     the events named here go to watchers at all. */
  watchState(ps) {
    return {
      id: ps.id, state: ps.state, phaseMs: ps.phaseMs,
      players: (ps.players || []).map(p => ({ side: p.side, name: p.name, skin: p.skin || null })),
      stake: ps.stake, pot: ps.pot, table: ps.table, rules: ps.rules,
    };
  }

  forWatchers(event, p) {
    if (!p) return null;
    switch (event) {
      case 'p8:start':
        return this.watchState(p);
      case 'p8:turn':
      case 'p8:shot':
      case 'p8:timeout':
        return Object.assign({}, p);
      case 'p8:chat':
        return { name: p.name, side: p.side, text: p.text };
      case 'p8:over':
        return {
          winner: p.winner || null,
          winnerSide: p.winnerId ? this.sideOf(p.winnerId) : null,
          why: p.why, stake: p.stake, pot: p.pot, groups: p.groups,
        };
      default:
        return null;
    }
  }

  watchSnapshot(now) {
    return this.watchState(this.publicState(now));
  }
}

// A standard normal draw from crypto (Box-Muller).
function gauss() {
  const u = (crypto.randomInt(1, 2 ** 31) / 2 ** 31), v = crypto.randomInt(0, 2 ** 31) / 2 ** 31;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// The balls on the wire: [n, x*10, y*10, on] flat.
function packBalls(balls) {
  const out = [];
  for (const b of balls) out.push(b.n, Math.round(b.x * 10), Math.round(b.y * 10), b.on ? 1 : 0);
  return out;
}

function tableInfo() {
  return { L: P8.L, W: P8.W, R: P8.R, HEAD_X: P8.HEAD_X, FOOT_X: P8.FOOT_X };
}

/* The first free spot for the cue ball: the break spot, else along the baulk line, else anywhere on a grid. */
function freeSpot(balls, kitchen) {
  const hx = P8.HEAD_X * P8.L, cy = P8.W / 2;
  const tries = [[hx, cy]];
  for (let k = 1; k < 12; k++) { tries.push([hx, cy - k * P8.R * 2.2]); tries.push([hx, cy + k * P8.R * 2.2]); }
  for (const [x, y] of tries) if (Sim.placeOk(balls, x, y, kitchen)) return { x, y };
  for (let x = P8.R * 2; x < (kitchen ? hx : P8.L - P8.R); x += P8.R * 2) {
    for (let y = P8.R * 2; y < P8.W - P8.R; y += P8.R * 2) if (Sim.placeOk(balls, x, y, kitchen)) return { x, y };
  }
  return { x: hx, y: cy };
}

/* The 8 back on the foot spot, or the nearest free point behind it on the long axis. */
function respotEight(balls) {
  const eight = balls.find(b => b.n === 8);
  if (!eight) return;
  const y = P8.W / 2;
  for (let x = P8.FOOT_X * P8.L; x < P8.L - P8.R; x += 1) {
    let clear = true;
    for (const b of balls) {
      if (!b.on || b.n === 8) continue;
      if ((b.x - x) ** 2 + (b.y - y) ** 2 < 4 * P8.R * P8.R) { clear = false; break; }
    }
    if (clear) { eight.x = x; eight.y = y; eight.on = true; return; }
  }
  eight.x = P8.FOOT_X * P8.L; eight.y = y; eight.on = true;
}

Pool8Room.P8R = P8R;
module.exports = { Pool8Room, P8R, packBalls, freeSpot };
