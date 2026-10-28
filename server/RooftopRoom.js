'use strict';
/* ─── One Rooftop Snipers match ───────────────────────────────────────────────
   Two wobbly snipers on one roof. Jump, raise the gun, let go to fire, knock the
   other one off. First to five falls wins. The physics and the rules are
   shared/rtSim.js and run here, server-side, at a fixed 60 steps a second; the
   clients send what they are pressing and draw what they are sent.

   THE RULES ARE THE REFERENCE'S (Poki's Rooftop Snipers, docs/rooftop-reference.md):
   round one is always the plain roof and waits for both players to press jump
   (here it also starts on its own after 10 s); a player whose body drops below the
   roof's death line loses the round, the game goes into slow motion, the point
   is shown 2 s later and the next round (with its random modifiers) starts 3 s
   after the fall; reaching five ends it.

   THE SEATS AND THE MONEY ARE KNOCKOUT'S. This room extends KnockoutRoom for
   everything that decides who is owed what: addPlayer (the server-recorded
   worth from the entry token), pot(), removePlayer (walking out forfeits),
   finish() (settles exactly once, the result message carries duelMoney's
   display figures), the bot's neutral id and the watcher room. What is new here
   is only the game: the rounds, the score, the inputs and the snapshots. */

const { KnockoutRoom } = require('./KnockoutRoom');
const Sim = require('../shared/rtSim');
const { RT } = Sim;

let nextId = 1;
const SNAP_EVERY = 2;            // a snapshot every second step: 30 a second
const MAX_CATCHUP_STEPS = 6;     // a stalled event loop is not replayed at speed: at most 0.1 s per tick
const MATCH_MAX_MS = 10 * 60 * 1000;   // C: the reference has no clock, but a paid table cannot run for ever: after
                                     // ten minutes of play the leader wins, and level is a draw (each seat refunded)
const TIMEUP_HOLD_MS = 3000;
const END_HOLD_MS = 2500;        // the winning fall's slow motion and score stay up this long after the game-over
                                 // moment before the result card (C: the reference shows its menu there)

/* A field from a client as a plain number, or NaN. Only a real number or a numeric string is read: Number() on a
   client-built object calls its toString/valueOf and can throw (the Head Soccer review's lesson). */
const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.length < 16 ? Number(v) : NaN);

// A press counter from a client: a small whole number that only ever goes up, a few at a time.
const count = (v, was) => {
  const n = Math.floor(num(v));
  if (!Number.isFinite(n) || n < 0 || n > 1e9) return was;
  return n > was ? Math.min(n, was + 4) : was;
};

class RooftopRoom extends KnockoutRoom {
  constructor(io) {
    super(io, 'rt_' + (nextId++), 'rt');
    this.match = Sim.newMatch(1);
    this.inputs = [{ j: 0, d: 0, r: 0, n: 0 }, { j: 0, d: 0, r: 0, n: 0 }];
    this.acks = [0, 0];            // the last input seq applied, per seat (a client's prediction reads its own)
    this.lastStepAt = 0;
    this.acc = 0;
    this.steps = 0;
    this.turn = 0;                 // the lobby's watch order reads it: rounds finished so far
    this.lastSnap = null;
    this.readyEndsAt = 0;
    this.playSince = 0;
  }

  sideOfSocket(socketId) {
    const p = this.players.get(socketId);
    return p ? p.side : null;
  }

  /* What a client is pressing: running counts of jump presses and of the shoot button going down and up, and how
     many ticks the last shot was held (its aim). Clamped and believed for nothing else: a count only goes up, a few
     at a time, and the sim caps the hold at what the server itself saw plus a little lag. */
  setInput(socketId, msg) {
    const side = this.sideOfSocket(socketId);
    if (side === null || !msg || typeof msg !== 'object') return false;
    const inp = this.inputs[side];
    inp.j = count(msg.j, inp.j);
    inp.d = count(msg.d, inp.d);
    inp.r = count(msg.r, inp.r);
    const n = Math.floor(num(msg.n));
    inp.n = Number.isFinite(n) ? Math.max(0, Math.min(RT.MAX_HELD, n)) : inp.n;
    const seq = Math.floor(num(msg.s));
    if (Number.isFinite(seq) && seq > this.acks[side] && seq < 1e9) this.acks[side] = seq;
    return true;
  }

  /* States: 'countdown' is the first round's ready-up (KnockoutLobby.earlyEnough and the watch list read it as "not
     started yet"); 'playing' is everything after it, rounds and the slow motion between them alike; 'settling' is the
     winning fall's hold; 'over' is settled. The roof keeps moving through all of them. */
  start(now) {
    if (this.players.size < 2) return false;
    const t = typeof now === 'number' ? now : Date.now();
    this.match = Sim.newMatch((Math.random() * 4294967296) >>> 0);
    this.inputs = [{ j: 0, d: 0, r: 0, n: 0 }, { j: 0, d: 0, r: 0, n: 0 }];
    this.state = 'countdown';
    this.readyEndsAt = t + RT.READY_MS;
    this.phaseEndsAt = this.readyEndsAt;
    this.lastStepAt = t;
    this.broadcast('rt:start', this.publicState(t));
    return true;
  }

  tick(now) {
    const t = typeof now === 'number' ? now : Date.now();
    if (this.state === 'waiting' || this.state === 'over') return;
    if (this.state === 'settling' && t >= this.phaseEndsAt) { this.finishByScore(); return; }
    if (this.state === 'playing' && this.playSince && t - this.playSince >= MATCH_MAX_MS) {
      // Time up: settled by the score as it stands (KnockoutRoom.removePlayer decides by it too from here on).
      this.state = 'settling';
      this.phaseEndsAt = t + TIMEUP_HOLD_MS;
      this.broadcast('rt:timeup', { score: this.match.score.slice(), holdMs: TIMEUP_HOLD_MS });
    }
    this.acc += Math.max(0, t - this.lastStepAt) / 1000;
    this.lastStepAt = t;
    let n = 0;
    while (this.acc >= RT.STEP && n < MAX_CATCHUP_STEPS) { this.acc -= RT.STEP; n++; this.stepOnce(t); if (this.state === 'over') return; }
    if (n === MAX_CATCHUP_STEPS) this.acc = 0;
  }

  stepOnce(t) {
    this.steps++;
    const m = this.match;
    // The first round starts when both have pressed jump, or when the ready wait runs out.
    if (this.state === 'countdown' && (m.ready[0] && m.ready[1] || t >= this.readyEndsAt)) {
      Sim.begin(m);
      this.state = 'playing';
      this.playSince = t;
      this.broadcast('rt:go', { score: m.score.slice() });
    }
    const ev = Sim.tick(m, this.inputs);
    const out = [];
    for (const e of ev) {
      if (e.e === 'fall') {
        this.turn++;
        this.broadcast('rt:fall', { s: e.s, score: e.score });
        /* The winning fall decides the match there and then: from here somebody leaving is settled by the score
           (KnockoutRoom.removePlayer -> decideNow), never handed to whoever stays. */
        if (m.winner >= 0 && this.state !== 'settling') {
          this.state = 'settling';
          this.phaseEndsAt = t + 60000;              // until the sim's game-over moment, then END_HOLD_MS
        }
      } else if (e.e === 'point') this.broadcast('rt:point', { s: e.s, score: e.score });
      else if (e.e === 'round') this.broadcast('rt:round', { r: e.r, mods: e.mods, label: Sim.modLabel(e.mods) });
      else if (e.e === 'end') { this.phaseEndsAt = t + END_HOLD_MS; this.broadcast('rt:end', { w: e.w, score: e.score }); }
      else if (e.e === 'shot') out.push(['shot', e.s, Math.round(e.f[0]), Math.round(e.f[1]), Math.round(e.h[0]), Math.round(e.h[1]), e.hit, e.strong]);
      else if (e.e === 'jump') out.push(['jump', e.s]);
      else if (e.e === 'rocket') out.push(['rocket', e.s, e.id]);
      else if (e.e === 'boom') out.push(['boom', e.s, Math.round(e.x), Math.round(e.y), e.hit]);
      else if (e.e === 'ready') out.push(['ready', e.s]);
      else if (e.e === 'go') { /* sent above */ }
    }
    if (out.length) this.broadcast('rt:ev', out);
    this.maybeSnap(ev.some(e => e.e === 'round' || e.e === 'fall'));
  }

  finishByScore() {
    const [a, b] = this.match.score;
    const bySide = (s) => { for (const [id, p] of this.players) if (p.side === s) return id; return null; };
    if (a === b) return this.finish(null, 'a draw');      // only when time ran out level: each seat refunded
    this.finish(bySide(a > b ? 0 : 1), 'first to ' + RT.PLAY_TO);
  }

  /* Somebody leaving after the winning fall: the score already decided it, with both seats still here, so it is
     settled by the score first (KnockoutRoom.removePlayer calls this while 'settling'). */
  decideNow() { this.finishByScore(); }

  overExtra() {
    return { score: this.match.score.slice() };
  }

  snapshot() {
    const s = Sim.pack(this.match);
    s.st = this.state;
    s.a = this.acks.slice();
    if (this.state === 'countdown') s.rm = Math.max(0, Math.round(this.readyEndsAt - Date.now()));
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
      (to.volatile || to).emit('rt:snap', s);
      if (this.watchers > 0) {
        const w = this.io.to(this.watchRoomName);
        (w.volatile || w).emit('rt:snap', this.forWatchers('rt:snap', s));
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
      playTo: RT.PLAY_TO,
      label: Sim.modLabel(this.match.mods),
      snap: this.lastSnap || this.snapshot(),
    };
  }

  /* ── what a watcher is told ─────────────────────────────────────────────
     Everything on the roof is on both screens already; a watcher gets the same, by seat, with no socket ids and no
     input acks. Only the events named here go to watchers at all. */
  watchState(ps) {
    return {
      id: ps.id, state: ps.state, phaseMs: ps.phaseMs,
      players: (ps.players || []).map(p => ({ side: p.side, name: p.name, skin: p.skin || null })),
      stake: ps.stake, pot: ps.pot, score: (ps.score || []).slice(), playTo: ps.playTo, label: ps.label,
      snap: ps.snap ? this.forWatchers('rt:snap', ps.snap) : null,
    };
  }

  forWatchers(event, p) {
    if (!p) return null;
    switch (event) {
      case 'rt:start':
        return this.watchState(p);
      case 'rt:snap': {
        const o = Object.assign({}, p);
        delete o.a;
        return o;
      }
      case 'rt:go':
      case 'rt:fall':
      case 'rt:point':
      case 'rt:round':
      case 'rt:end':
      case 'rt:timeup':
        return Object.assign({}, p);
      case 'rt:ev':
        return Array.isArray(p) ? p.slice() : null;
      case 'rt:chat':
        return { name: p.name, side: p.side, text: p.text };
      case 'rt:over':
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

RooftopRoom.END_HOLD_MS = END_HOLD_MS;
RooftopRoom.MATCH_MAX_MS = MATCH_MAX_MS;
RooftopRoom.TIMEUP_HOLD_MS = TIMEUP_HOLD_MS;
module.exports = { RooftopRoom, RT };
