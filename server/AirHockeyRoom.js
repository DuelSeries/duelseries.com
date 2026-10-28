'use strict';
/* ─── One Air Hockey match ────────────────────────────────────────────────────
   Two mallets, one puck, a goal at each end. The physics are shared/ahSim.js and
   run here, server-side, at a fixed 60 steps a second; each client sends where it
   is pointing and draws what it is sent (predicting its own mallet and the puck).

   THE RULES ARE OURS (docs/airhockey-design.md): first to 7 goals; a 3, 2, 1
   before the first serve, which goes to a random seat; after a goal the puck is
   served to whoever conceded, on their own half; a mallet never crosses the
   halfway line; a puck kept on one half for 7 s goes to the other player (the
   real game's 7 second rule, and what stops a leader sitting on the puck); four
   minutes of play, then the leader wins; level at 0:00 is sudden death, one
   more minute where the next goal wins; still level after it is a draw, each
   seat refunded.

   THE SEATS AND THE MONEY ARE KNOCKOUT'S. This room extends KnockoutRoom for
   everything that decides who is owed what: addPlayer (the server-recorded
   worth from the entry token), pot(), removePlayer (walking out forfeits),
   finish() (settles exactly once, a draw refunds each seat its own stake, the
   result message carries duelMoney's display figures), the bot's neutral id
   and the watcher room. What is new here is only the game. */

const { KnockoutRoom } = require('./KnockoutRoom');
const Sim = require('../shared/ahSim');
const { AH } = Sim;

let nextId = 1;
const SNAP_EVERY = 2;            // a snapshot every second step: 30 a second
const MAX_CATCHUP_STEPS = 6;     // a stalled event loop is not replayed at speed: at most 0.1 s per tick
const WIN_HOLD_MS = 2500;        // the winning goal sits on screen this long before the result card
const BUF_MAX = 90;              // pointer samples held for steps not run yet (1.5 s)
const AHEAD_MAX = 45;            // a sample stamped further ahead than this (0.75 s) is used when it is that far ahead
const STEP_MS = AH.STEP * 1000;

/* A field from a client as a plain number, or NaN. Only a real number or a short numeric string is read: Number()
   on a client-built object calls its toString/valueOf and can THROW (the Head Soccer review's crash). */
const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.length < 16 ? Number(v) : NaN);

class AirHockeyRoom extends KnockoutRoom {
  constructor(io) {
    super(io, 'ah_' + (nextId++), 'ah');
    this.match = Sim.newMatch();
    this.score = [0, 0];
    this.msLeft = AH.MATCH_MS;
    this.sudden = false;           // level at 0:00: the next goal wins
    this.suddenMs = 0;             // sudden death played so far
    this.inputs = [{ x: AH.W / 2, y: AH.H - 130 }, { x: AH.W / 2, y: 130 }];
    this.buf = [[], []];           // [{ t, x, y }] pointer samples for steps still to come, per seat
    this.lastT = [-1, -1];         // the newest sample tick taken, per seat (samples only go forward)
    this.stall = { side: -1, ms: 0 };
    this.serveTo = 0;
    this.lastStepAt = 0;
    this.acc = 0;
    this.steps = 0;
    this.turn = 0;                 // the lobby's watch order reads it: goals scored so far
    this.lastSnap = null;
  }

  sideOfSocket(socketId) {
    const p = this.players.get(socketId);
    return p ? p.side : null;
  }

  /* Where a client is pointing, as a few samples stamped with the steps they are for: { t, p: [x, y, x, y, ...] },
     the newest last, sample i for step t - (n - 1 - i). The page runs a little ahead of the server, so a sample
     usually arrives before its step and is applied on exactly that step, which is the step the page already drew it
     on: your own hits are never corrected. A late one is applied at once. Believed for nothing but a target: the
     sim clamps it to your half and caps how fast the mallet can get there. */
  setInput(socketId, msg) {
    const side = this.sideOfSocket(socketId);
    if (side === null || !msg || typeof msg !== 'object') return false;
    const t = Math.floor(num(msg.t));
    const pts = msg.p;
    if (!Number.isFinite(t) || t < 0 || t > 1e8 || !Array.isArray(pts) || pts.length < 2 || pts.length > 16 || pts.length % 2) return false;
    const n = pts.length / 2;
    const now = this.match.tick;
    const buf = this.buf[side];
    for (let i = 0; i < n; i++) {
      /* Clamped BEFORE it is remembered (Fable review 2026-10-28): a stamp far in the future must not become the
         newest one taken, or every honest sample after it would look stale and the seat's mallet would freeze. */
      let st = Math.min(t - (n - 1 - i), now + AHEAD_MAX);
      if (st <= this.lastT[side]) continue;
      const x = num(pts[2 * i]), y = num(pts[2 * i + 1]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 5000 || Math.abs(y) > 5000) continue;
      this.lastT[side] = st;
      if (buf.length && st < buf[buf.length - 1].t) st = buf[buf.length - 1].t;
      buf.push({ t: st, x, y });
    }
    while (buf.length > BUF_MAX) buf.shift();
    return true;
  }

  /* States: 'countdown' the 3, 2, 1 before the first serve (AirHockeyLobby.earlyEnough reads it as "not started
     yet"); 'playing'; 'goal' the moment after a goal, before the next serve; 'settling' the winning goal or the
     final buzzer on screen before the result card; 'over'. Mallets move in all of them but 'over'. */
  start(now) {
    if (this.players.size < 2) return false;
    const t = typeof now === 'number' ? now : Date.now();
    this.match = Sim.newMatch();
    this.score = [0, 0];
    this.msLeft = AH.MATCH_MS;
    this.sudden = false; this.suddenMs = 0;
    this.stall = { side: -1, ms: 0 };
    this.serveTo = Math.random() < 0.5 ? 0 : 1;
    Sim.serve(this.match, this.serveTo);
    this.match.puck.live = false;            // on its spot, still, until the countdown ends
    this.state = 'countdown';
    this.phaseEndsAt = t + AH.COUNTDOWN_MS;
    this.lastStepAt = t;
    this.broadcast('ah:start', this.publicState(t));
    return true;
  }

  tick(now) {
    const t = typeof now === 'number' ? now : Date.now();
    if (this.state === 'waiting' || this.state === 'over') return;
    if (this.state === 'countdown' && t >= this.phaseEndsAt) {
      this.state = 'playing';
      this.match.puck.live = true;
      this.broadcast('ah:play', { score: this.score.slice(), msLeft: Math.round(this.msLeft), to: this.serveTo });
      this.maybeSnap(true);
    }
    if (this.state === 'goal' && t >= this.phaseEndsAt) this.serveNow(this.serveTo, 'goal');
    if (this.state === 'settling' && t >= this.phaseEndsAt) { this.finishByScore(); return; }
    // Fixed steps for the time that has passed.
    this.acc += Math.max(0, t - this.lastStepAt) / 1000;
    this.lastStepAt = t;
    let n = 0;
    while (this.acc >= AH.STEP && n < MAX_CATCHUP_STEPS) { this.acc -= AH.STEP; n++; this.stepOnce(t); }
    if (n === MAX_CATCHUP_STEPS) this.acc = 0;
  }

  // The puck onto a seat's serve spot, live. why: 'goal' (to whoever conceded) or 'stall' (the 7 second rule).
  serveNow(side, why) {
    Sim.serve(this.match, side);
    this.serveTo = side;
    this.stall = { side: -1, ms: 0 };
    this.state = 'playing';
    this.broadcast('ah:serve', { to: side, why, score: this.score.slice(), msLeft: Math.round(this.msLeft) });
    this.maybeSnap(true);
  }

  // Each seat's pointer for the step about to run: every sample stamped for it or earlier, the newest one winning.
  takeInputs() {
    const k = this.match.tick + 1;
    for (let s = 0; s < 2; s++) {
      const buf = this.buf[s];
      let i = 0;
      while (i < buf.length && buf[i].t <= k) i++;
      if (i > 0) { const e = buf[i - 1]; this.inputs[s] = { x: e.x, y: e.y }; buf.splice(0, i); }
    }
  }

  stepOnce(t) {
    this.steps++;
    const live = this.state === 'playing';
    this.takeInputs();
    const ev = Sim.step(this.match, this.inputs, true);
    let goal = null;
    const sounds = [];
    for (const e of ev) {
      if (e.e === 'goal') goal = e;
      else if (live) sounds.push(e);
    }
    if (sounds.length) this.sendEvents(sounds);
    /* The step's time comes off the clock BEFORE its goal is judged, so a goal on the last step is a goal at 0:00 and
       is decided at once (scored), never left in a goal break a leader could forfeit by leaving (Opus review 2026-10-28). */
    if (live && !this.sudden) this.msLeft = Math.max(0, this.msLeft - STEP_MS);
    if (goal && live) { this.scored(goal.s, t); return; }
    if (live) {
      if (this.sudden) {
        this.suddenMs += STEP_MS;
        if (this.suddenMs >= AH.SUDDEN_MS) { this.whistle(t, 'time'); return; }
      } else {
        if (this.msLeft <= 0) {
          if (this.score[0] !== this.score[1]) { this.whistle(t, 'time'); return; }
          this.sudden = true;
          this.broadcast('ah:sudden', { score: this.score.slice(), ms: AH.SUDDEN_MS });
        }
      }
      // The 7 second rule: a puck that stays on one half that long goes to the other player.
      const half = Sim.halfOf(this.match.puck);
      if (half === this.stall.side) this.stall.ms += STEP_MS;
      else this.stall = { side: half, ms: 0 };
      if (this.stall.ms >= AH.STALL_MS) {
        this.broadcast('ah:stall', { from: half });
        this.serveNow(1 - half, 'stall');
        return;
      }
    }
    this.maybeSnap();
  }

  scored(side, t) {
    this.score[side]++;
    this.turn++;
    this.serveTo = 1 - side;
    this.stall = { side: -1, ms: 0 };
    this.broadcast('ah:goal', { s: side, score: this.score.slice() });
    // First to seven, or any goal in sudden death, ends it.
    if (this.score[side] >= AH.TO_WIN || this.sudden) { this.whistle(t, 'goal'); return; }
    /* A goal at 0:00: a lead wins now; an equaliser goes to sudden death after the goal break, served as usual. */
    if (this.msLeft <= 0) {
      if (this.score[0] !== this.score[1]) { this.whistle(t, 'time'); return; }
      this.sudden = true;
      this.broadcast('ah:sudden', { score: this.score.slice(), ms: AH.SUDDEN_MS });
    }
    this.state = 'goal';
    this.phaseEndsAt = t + AH.GOAL_PAUSE_MS;
    this.maybeSnap(true);
  }

  whistle(t, how) {
    this.state = 'settling';
    this.match.puck.live = false;
    this.phaseEndsAt = t + WIN_HOLD_MS;
    this.broadcast('ah:whistle', { score: this.score.slice(), how, holdMs: WIN_HOLD_MS });
    this.maybeSnap(true);
  }

  finishByScore() {
    const [a, b] = this.score;
    const bySide = (s) => { for (const [id, p] of this.players) if (p.side === s) return id; return null; };
    if (a === b) return this.finish(null, 'a draw');
    this.finish(bySide(a > b ? 0 : 1), a >= AH.TO_WIN || b >= AH.TO_WIN ? 'first to ' + AH.TO_WIN : 'full time');
  }

  /* Somebody leaving during the hold after the winning goal: the score already decided it, with both seats still
     here, so it is settled by the score first (KnockoutRoom.removePlayer calls this). Walking out on the result
     never hands the pot to the side that lost. */
  decideNow() { this.finishByScore(); }

  overExtra() {
    return { score: this.score.slice() };
  }

  // Hits, rails and posts, to both screens and watchers: a page plays its own predicted ones at once and the other
  // player's hits from here. [kind, seat or -1, strength, x, y].
  sendEvents(ev) {
    const out = ev.map(e => [e.e === 'hit' ? 'h' : e.e === 'post' ? 'p' : 'r', e.s === undefined ? -1 : e.s, e.v | 0, e.x | 0, e.y | 0]);
    if (!out.length || !this.io || !this.io.to) return;
    const to = this.io.to(this.socketRoomName);
    (to.volatile || to).emit('ah:ev', out);
    if (this.watchers > 0) {
      const w = this.io.to(this.watchRoomName);
      (w.volatile || w).emit('ah:ev', out);
    }
  }

  /* c: the clock's ms left; sd: in sudden death, its minute's ms left; sl: the 7 second rule's [half, ms] once it
     is past its warning. */
  snapshot() {
    const m = this.match;
    const s = {
      k: m.tick, c: Math.round(this.msLeft), st: this.state,
      pk: Sim.packPuck(m.puck), m: [Sim.packMallet(m.m[0]), Sim.packMallet(m.m[1])],
      sc: this.score.slice(),
    };
    if (this.sudden) s.sd = Math.round(Math.max(0, AH.SUDDEN_MS - this.suddenMs));
    if (this.stall.ms >= AH.STALL_WARN_MS && this.state === 'playing') s.sl = [this.stall.side, Math.round(this.stall.ms)];
    /* bw: the free table's bot, where its hand is heading and how fast ([seat, x, y, units/s]), so a player's page
       predicts the bot's swings instead of seeing the puck jump when one lands. Players only (watchers interpolate). */
    const ai = this.bot && this.bot.ai;
    if (ai && ai.want) {
      const bs = this.sideOfSocket(this.bot.id);
      if (bs !== null) s.bw = [bs, Math.round(ai.want[0]), Math.round(ai.want[1]), Math.round(ai.want[2])];
    }
    return s;
  }

  maybeSnap(force) {
    if (!force && (this.steps % SNAP_EVERY) !== 0) return;
    const s = this.snapshot();
    this.lastSnap = s;
    /* VOLATILE: a client that cannot keep up drops a frame rather than backing the rest up behind it (the
       mobile netcode rule). Every snapshot is a whole state, so a dropped one costs nothing. */
    if (this.io && this.io.to) {
      const to = this.io.to(this.socketRoomName);
      (to.volatile || to).emit('ah:snap', s);
      if (this.watchers > 0) {
        const w = this.io.to(this.watchRoomName);
        (w.volatile || w).emit('ah:snap', this.forWatchers('ah:snap', s));
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
      score: this.score.slice(),
      msLeft: Math.round(this.msLeft),
      sudden: this.sudden,
      serveTo: this.serveTo,
      snap: this.lastSnap || this.snapshot(),
    };
  }

  /* ── what a watcher is told ─────────────────────────────────────────────
     Everything on the table is on both screens already; a watcher gets the same, by seat, with no socket ids.
     Only the events named here go to watchers at all. */
  watchState(ps) {
    return {
      id: ps.id, state: ps.state, phaseMs: ps.phaseMs,
      players: (ps.players || []).map(p => ({ side: p.side, name: p.name, skin: p.skin || null })),
      stake: ps.stake, pot: ps.pot, score: (ps.score || []).slice(), msLeft: ps.msLeft, sudden: !!ps.sudden,
      serveTo: ps.serveTo,
      snap: ps.snap ? this.forWatchers('ah:snap', ps.snap) : null,
    };
  }

  forWatchers(event, p) {
    if (!p) return null;
    switch (event) {
      case 'ah:start':
        return this.watchState(p);
      case 'ah:snap': {
        const o = { k: p.k, c: p.c, st: p.st, pk: p.pk, m: p.m, sc: p.sc };
        if (p.sd !== undefined) o.sd = p.sd;
        if (p.sl !== undefined) o.sl = p.sl;
        return o;
      }
      case 'ah:play':
      case 'ah:serve':
      case 'ah:sudden':
      case 'ah:stall':
      case 'ah:goal':
      case 'ah:whistle':
        return Object.assign({}, p);
      case 'ah:chat':
        return { name: p.name, side: p.side, text: p.text };
      case 'ah:over':
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

AirHockeyRoom.WIN_HOLD_MS = WIN_HOLD_MS;
module.exports = { AirHockeyRoom, AH };
