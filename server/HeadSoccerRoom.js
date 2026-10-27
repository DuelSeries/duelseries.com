'use strict';
/* ─── One Head Soccer match ───────────────────────────────────────────────────
   Two big heads, a goal at each end, a minute on the clock. The physics are
   shared/hsSim.js and run here, server-side, at a fixed 60 steps a second; the
   clients send what they are pressing and draw what they are sent.

   THE RULES ARE HEADS ARENA EURO SOCCER'S (docs/head-soccer-reference.md):
   60 s of play shown as 90 game minutes; a 3, 2, 1, 0 countdown (2.4 s) before
   every kick-off, with the ball already dropping and nobody able to move; a goal
   stops the clock for 3 s, then both players go back to their spots; half time
   at 45:00 is the same 3 s break and kick-off; level at 90:00 is golden goal
   (2 s, then a kick-off, the clock stays at 90:00 and the next goal wins).

   THE SEATS AND THE MONEY ARE KNOCKOUT'S. This room extends KnockoutRoom for
   everything that decides who is owed what: addPlayer (the server-recorded
   worth from the entry token), pot(), removePlayer (walking out forfeits),
   finish() (settles exactly once, a draw refunds each seat its own stake, the
   result message carries duelMoney's display figures), the bot's neutral id
   and the watcher room. What is new here is only the game: the clock, the
   score, the inputs and the snapshots. */

const { KnockoutRoom } = require('./KnockoutRoom');
const Sim = require('../shared/hsSim');
const { HS } = Sim;

let nextId = 1;
const SNAP_EVERY = 2;            // a snapshot every second step: 30 a second
const MAX_CATCHUP_STEPS = 6;     // a stalled event loop is not replayed at speed: at most 0.1 s per tick
const WIN_HOLD_MS = 3000;        // the final whistle sits on screen this long before the result card
                                 // (the reference's GameUI.endScreen holds the score for 3 s)

/* A field from a client as a plain number, or NaN. Only a real number or a numeric string is read: Number() on a
   client-built object calls its toString/valueOf and can THROW (Fable review 2026-10-27: {h:{toString:1}} took the
   process down), the same guard Knockout's submitAim has. */
const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.length < 16 ? Number(v) : NaN);

// A press counter from a client: a small whole number that only ever goes up.
const count = (v, was) => {
  const n = Math.floor(num(v));
  if (!Number.isFinite(n) || n < 0 || n > 1e9) return was;
  return n > was ? Math.min(n, was + 4) : was;       // never more than a few presses a message
};

class HeadSoccerRoom extends KnockoutRoom {
  constructor(io) {
    super(io, 'hs_' + (nextId++), 'hs');
    this.match = Sim.newMatch();
    this.inputs = [{ held: 0, jumps: 0, kicks: 0, powers: 0 }, { held: 0, jumps: 0, kicks: 0, powers: 0 }];
    this.acks = [0, 0];            // the last input seq applied, per seat (a client's prediction reads its own)
    this.lastStepAt = 0;
    this.acc = 0;
    this.steps = 0;
    this.turn = 0;                 // the lobby's watch order reads it: goals scored so far
    this.lastSnap = null;
    this.goldenCalled = false;     // the golden-goal call has been made (once a match)
  }

  sideOfSocket(socketId) {
    const p = this.players.get(socketId);
    return p ? p.side : null;
  }

  /* What a client is pressing: held directions and running counts of presses (a tap shorter than a step still
     counts). Clamped and believed for nothing else: a count can only go up, a few at a time. */
  setInput(socketId, msg) {
    const side = this.sideOfSocket(socketId);
    if (side === null || !msg || typeof msg !== 'object') return false;
    const inp = this.inputs[side];
    const h = num(msg.h);
    inp.held = Number.isFinite(h) ? (h | 0) & 3 : 0;
    inp.jumps = count(msg.j, inp.jumps);
    inp.kicks = count(msg.k, inp.kicks);
    inp.powers = count(msg.p, inp.powers);
    const seq = Math.floor(num(msg.s));
    if (Number.isFinite(seq) && seq > this.acks[side] && seq < 1e9) this.acks[side] = seq;
    return true;
  }

  /* States: 'countdown' is the opening one only (HeadSoccerLobby.earlyEnough reads it as "not kicked off yet");
     'kickoff' is the same countdown after a goal, half time or the golden-goal call; 'goal', 'half' and 'golden'
     are the breaks before it; 'settling' is the final whistle. The pitch keeps moving through all of them with
     nobody's input, as the reference's does (its input is disabled, its physics is not). */
  start(now) {
    if (this.players.size < 2) return false;
    const t = typeof now === 'number' ? now : Date.now();
    this.match = Sim.newMatch();
    this.goldenCalled = false;
    this.state = 'countdown';
    this.phaseEndsAt = t + HS.COUNTDOWN_MS;
    this.lastStepAt = t;
    this.broadcast('hs:start', this.publicState(t));
    return true;
  }

  // S: full time level -> flashGoldenGoal, then goldenGoalKickoff 2 s later. Once a match.
  callGolden(t) {
    this.goldenCalled = true;
    this.state = 'golden';
    this.phaseEndsAt = t + HS.GOLDEN_FLASH_MS;
    this.broadcast('hs:golden', { score: this.match.score.slice() });
  }

  // Back to the spots and the countdown (S: GameplayHandler.kickoff / goldenGoalKickoff).
  kickoffCount(t) {
    Sim.kickoff(this.match);
    this.state = 'kickoff';
    this.phaseEndsAt = t + HS.COUNTDOWN_MS;
    this.broadcast('hs:count', { ms: HS.COUNTDOWN_MS, score: this.match.score.slice(), msLeft: Math.round(this.match.msLeft) });
    this.maybeSnap(true);
  }

  tick(now) {
    const t = typeof now === 'number' ? now : Date.now();
    if (this.state === 'waiting' || this.state === 'over') return;
    if ((this.state === 'countdown' || this.state === 'kickoff') && t >= this.phaseEndsAt) {
      this.state = 'playing';
      this.broadcast('hs:kickoff', { score: this.match.score.slice(), msLeft: Math.round(this.match.msLeft) });
    }
    if ((this.state === 'goal' || this.state === 'half' || this.state === 'golden') && t >= this.phaseEndsAt) {
      // An equaliser on the 90:00 whistle still gets the golden-goal call before its kick-off.
      if (this.state === 'goal' && this.match.msLeft <= 0 && this.match.score[0] === this.match.score[1] && !this.goldenCalled) this.callGolden(t);
      else this.kickoffCount(t);
    }
    if (this.state === 'settling' && t >= this.phaseEndsAt) { this.finishByScore(); return; }
    // Fixed steps for the time that has passed.
    this.acc += Math.max(0, t - this.lastStepAt) / 1000;
    this.lastStepAt = t;
    let n = 0;
    while (this.acc >= HS.STEP && n < MAX_CATCHUP_STEPS) { this.acc -= HS.STEP; n++; this.stepOnce(t); }
    if (n === MAX_CATCHUP_STEPS) this.acc = 0;
  }

  stepOnce(t) {
    this.steps++;
    const live = this.state === 'playing';
    /* Sudden death is the clock ALREADY at 0:00 when this step began. Read after the step, a goal in the very step
       that took the clock to 0:00 (an equaliser on the buzzer) would end a level match as a draw instead of going
       to sudden death (review 2026-10-27). */
    const golden = live && this.match.msLeft <= 0 && HS.TIE === 'golden';
    const before = this.match.msLeft;
    // Input only while play is live; in every break the pitch still moves (S: disableInput, the physics runs on).
    const ev = Sim.step(this.match, this.inputs, HS.STEP, live, live);
    for (const e of ev) {
      if (e.e === 'goal' && live) {
        this.turn++;
        this.state = 'goal';
        this.phaseEndsAt = t + HS.GOAL_PAUSE_MS;
        this.broadcast('hs:goal', { s: e.s, score: this.match.score.slice() });
        if (golden) { this.whistle(t); return; }
        break;
      }
    }
    if (ev.length) this.sendEvents(ev);
    if (live && this.state === 'playing') {
      // Half time: the step that takes the clock past 45:00 (S: Timer halftime callback, kickoff 3 s later).
      if (before > HS.HALF_MS && this.match.msLeft <= HS.HALF_MS) {
        this.state = 'half';
        this.phaseEndsAt = t + HS.HALF_PAUSE_MS;
        this.broadcast('hs:half', { score: this.match.score.slice(), msLeft: Math.round(this.match.msLeft) });
      } else if (this.match.msLeft <= 0) {
        const [a, b] = this.match.score;
        // Level at 90:00 is golden goal (the clock sits at 90:00 and the next goal wins), with a safety stop that
        // makes it a draw, refunded, after GOLDEN_MAX_MS. A draw rule instead ends it here.
        if (a !== b || HS.TIE === 'draw' || this.match.goldenMs >= HS.GOLDEN_MAX_MS) { this.whistle(t); return; }
        if (!this.goldenCalled) this.callGolden(t);
      }
    }
    this.maybeSnap();
  }

  whistle(t) {
    this.state = 'settling';
    this.phaseEndsAt = t + WIN_HOLD_MS;
    this.broadcast('hs:whistle', { score: this.match.score.slice(), holdMs: WIN_HOLD_MS });
    this.maybeSnap(true);
  }

  finishByScore() {
    const [a, b] = this.match.score;
    const bySide = (s) => { for (const [id, p] of this.players) if (p.side === s) return id; return null; };
    if (a === b) return this.finish(null, 'a draw');
    this.finish(bySide(a > b ? 0 : 1), 'full time');
  }

  /* Somebody leaving during the full-time hold: the score already decided it, with both seats still here, so it is
     settled by the score first. Walking out on the whistle never hands the pot to the side that lost (Fable review
     2026-10-27). */
  decideNow() { this.finishByScore(); }

  overExtra() {
    return { score: this.match.score.slice() };
  }

  // The sounds of a step (kick, swing, jump, head, bounce, post, net), to both screens, reliable but small.
  sendEvents(ev) {
    const out = ev.filter(e => e.e !== 'goal').map(e => (e.s === undefined ? [e.e] : e.v ? [e.e, e.s, e.v] : [e.e, e.s]));
    if (out.length) this.broadcast('hs:ev', out);
  }

  snapshot() {
    const m = this.match;
    return {
      k: m.tick, c: Math.round(m.msLeft), st: this.state,
      b: Sim.packBall(m.ball), p: [Sim.packPlayer(m.p[0]), Sim.packPlayer(m.p[1])],
      sc: m.score.slice(), a: this.acks.slice(),
    };
  }

  maybeSnap(force) {
    if (!force && (this.steps % SNAP_EVERY) !== 0) return;
    const s = this.snapshot();
    this.lastSnap = s;
    /* VOLATILE: a client that cannot keep up drops a frame rather than backing the rest up behind it (the
       mobile netcode rule). Every snapshot is a whole state, so a dropped one costs nothing. */
    if (this.io && this.io.to) {
      const to = this.io.to(this.socketRoomName);
      (to.volatile || to).emit('hs:snap', s);
      if (this.watchers > 0) {
        const w = this.io.to(this.watchRoomName);
        (w.volatile || w).emit('hs:snap', this.forWatchers('hs:snap', s));
      }
    }
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
      score: this.match.score.slice(),
      msLeft: Math.round(this.match.msLeft),
      snap: this.lastSnap || this.snapshot(),
    };
  }

  /* ── what a watcher is told ─────────────────────────────────────────────
     Everything on the pitch is on both screens already; a watcher gets the same, by seat, with no socket ids
     and no input acks. Only the events named here go to watchers at all. */
  watchState(ps) {
    return {
      id: ps.id, state: ps.state, phaseMs: ps.phaseMs,
      players: (ps.players || []).map(p => ({ side: p.side, name: p.name, skin: p.skin || null })),
      stake: ps.stake, pot: ps.pot, score: (ps.score || []).slice(), msLeft: ps.msLeft,
      snap: ps.snap ? this.forWatchers('hs:snap', ps.snap) : null,
    };
  }

  forWatchers(event, p) {
    if (!p) return null;
    switch (event) {
      case 'hs:start':
        return this.watchState(p);
      case 'hs:snap':
        return { k: p.k, c: p.c, st: p.st, b: p.b, p: p.p, sc: p.sc };
      case 'hs:kickoff':
      case 'hs:count':
      case 'hs:half':
      case 'hs:golden':
      case 'hs:power':
      case 'hs:goal':
      case 'hs:whistle':
        return Object.assign({}, p);
      case 'hs:ev':
        return Array.isArray(p) ? p.slice() : null;
      case 'hs:chat':
        return { name: p.name, side: p.side, text: p.text };
      case 'hs:over':
        return {
          winner: p.winner || null,
          winnerSide: p.winnerId ? this.sideOf(p.winnerId) : null,
          why: p.why, stake: p.stake, pot: p.pot, score: (p.score || []).slice(),
        };
      default:
        return null;
    }
  }

  watchSnapshot(now) {
    return this.watchState(this.publicState(now));
  }
}

HeadSoccerRoom.WIN_HOLD_MS = WIN_HOLD_MS;
module.exports = { HeadSoccerRoom, HS };
