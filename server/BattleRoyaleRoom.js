'use strict';
/* ─── Battle Royale ───────────────────────────────────────────────────────────
   The nightly event. Everyone gathers in one room, the owner starts the match,
   the border closes in and then roams, and the last snake alive wins.

   It is a GameRoom with a clock on the zone. Everything else — the sim, the
   snapshots, the collision, the food, the border kill — is the game that
   already exists. In particular the border ALREADY kills on contact at
   headDist >= worldRadius, on the server's authoritative head position, so this
   file never has to kill anybody: it only says where the circle is.

   Timings are Owen's: two minutes closing, two minutes roaming.

   The one thing he did not specify is what happens if two people are still
   alive when the four minutes are up, and "the small circle keeps moving until
   everyone dies" is what he asked for, so the roam does not stop at the buzzer.
   It goes into overtime and starts closing again, slowly, until there is one
   snake left. That way the match always ends with a winner and never with a
   draw nobody can be paid for. */

const C = require('../shared/constants');
const GameRoom = require('./GameRoom');

const SEC = 1000;

const BR = {
  /* Ten seconds between pressing start and the circle mattering. Dropping
     straight into a closing border gives nobody time to look up, and the count
     is also what tells everyone in the room that this is now a match rather
     than a lobby. */
  COUNTDOWN_MS: 10 * SEC,
  SHRINK_MS:   1 * 60 * SEC,   // closing in
  ROAM_MS:     2 * 60 * SEC,   // the small circle wandering
  /* One. Owen tests this alone and there is nobody else on the game yet, so a
     two-player minimum only ever stopped him starting it. It stays a named
     constant rather than being deleted, because the day there are real players
     a lone match IS worth refusing and this is the line to change. */
  MIN_PLAYERS: 1,
  START_RADIUS: C.MAX_WORLD_RADIUS,
  FINAL_RADIUS: 420,           // about six snake-lengths across at spawn size
  /* HOW FAR AND HOW FAST THE CIRCLE WANDERS, and both are speed limits rather
     than taste.

     A snake cruises at SNAKE_BASE_SPEED per tick — 2.22 at 60Hz, so about 133
     units a second, and roughly 337 flat out on boost. A zone whose centre
     moves faster than that cannot be followed by anyone: you watch a wall
     arrive at a speed you cannot outrun, which is not a game.

     The first version wandered 2160 units on a 46-second lap — about 295 units
     a second, more than twice cruising speed. 800 units on a 100-second lap is
     roughly 50, comfortably under half of cruising, so following the circle is
     something you do WHILE playing rather than the whole of what you do. */
  ROAM_RADIUS: 800,            // how far from the middle it will ever wander

  /* THE HOP. The circle picks somewhere to go, that somewhere is shown on
     screen as an outline before it sets off, it travels there, and it rests
     half a second before choosing again. Announcing the destination is the
     whole point: a border you can see coming is a decision, and one that just
     arrives is an accident.

     The speed is the constraint, as before. 55 units a second against a snake
     that cruises at 133 leaves room to get there and to fight on the way. */
  ROAM_HOP_SPEED: 55,          // units a second while travelling
  ROAM_HOP_HOLD_MS: 500,       // the rest once it arrives, before the next call
  ROAM_HOP_MIN_DIST: 420,      // or the hop is not worth announcing

  /* THE LAST THIRTY SECONDS. It keeps moving and closes to roughly two
     snake-lengths across.

     Two snake lengths is not a fixed number of units — a snake's length is
     whatever it has eaten — so this is set against the thing that is fixed:
     OVERTIME_FLOOR, the smallest circle a snake can still turn around inside.
     Just above it, so the endgame is desperate rather than unplayable. */
  ENDGAME_MS: 30 * SEC,
  ENDGAME_RADIUS: 165,
  /* Overtime: the clock is up and more than one snake is alive, so it keeps
     closing until somebody is. Six a second, not fourteen: fourteen went from
     420 to the floor in thirty seconds, which is not a squeeze, it is a
     guillotine — and one very likely to take both finalists on the same tick.
     The floor is a circle a snake can still turn inside. */
  OVERTIME_SHRINK_PER_SEC: 6,
  /* Below the endgame size, or overtime does nothing. It used to floor at 150
     while the endgame already closed to 165 — fifteen units of squeeze, over in
     two seconds. Overtime exists to force an ending when two players are still
     alive at the buzzer, and it cannot do that from a size they are both
     comfortably surviving in. */
  OVERTIME_FLOOR: 120,
};

class BattleRoyaleRoom extends GameRoom {
  constructor(io, lobbyType) {
    super(io, lobbyType);
    this.isBattleRoyale = true;
    this.state = 'waiting';        // waiting | countdown | running | over
    this.countdownUntil = 0;
    this.matchId = null;
    this.startedAt = 0;
    this.endedAt = 0;
    this.winner = null;            // { id, name, wallet }
    this.worldRadius = BR.START_RADIUS;
    this._roamSeed = Math.random() * Math.PI * 2;
  }

  /* ── the clock ─────────────────────────────────────────────────────────── */

  /* Whether somebody can spawn in right now.

     Not simply 'the match is over': the moment a winner is decided the circle
     is still tiny, and letting people in then drops them into a death trap a
     few hundred units across. The door opens once the zone has actually
     reopened, which is what makes 'the circle goes back to normal and then
     people can play again' true rather than nearly true. */
  acceptingPlayers() {
    /* 'waiting' only. A countdown is the match starting, and somebody dropping
       in at three seconds has joined a match already under way. */
    return this.state === 'waiting' && this.worldRadius > BR.START_RADIUS * 0.9;
  }

  canStart() {
    return this.state === 'waiting' && this.livingCount() >= BR.MIN_PLAYERS;
  }

  livingCount() {
    let n = 0;
    for (const s of this.snakes.values()) if (s && s.alive) n++;
    return n;
  }

  /* Everyone who is still alive, which is what decides the winner. */
  livingSnakes() {
    const out = [];
    for (const s of this.snakes.values()) if (s && s.alive) out.push(s);
    return out;
  }

  startMatch(reason) {
    if (!this.canStart()) return false;
    this.state = 'countdown';
    this.countdownUntil = Date.now() + BR.COUNTDOWN_MS;
    /* How many were in it when it began, which is what decides how it can END.
       A real match is over when one is left; a match of ONE is over the instant
       it starts by that rule, because the only player is already the last one
       standing. */
    this.startedWith = this.livingCount();
    this._hopTo = null; this._hopHoldUntil = 0;   // no leftovers from the last match
    this.matchId = 'br_' + Date.now().toString(36);
    this.startedAt = 0;                 // set when the count reaches zero
    this.endedAt = 0;
    this.winner = null;
    this._prevAlive = null;
    this.worldCx = 0;
    this.worldCy = 0;
    this.worldRadius = BR.START_RADIUS;
    this.io.to(this.socketRoomName).emit('br:state', this.publicState());
    console.log(`[BR] ${this.lobbyType} match ${this.matchId} counting down (${reason || 'manual'}) `
      + `with ${this.livingCount()} players`);
    return true;
  }

  /* Called from the tick while the count runs. */
  _tickCountdown() {
    if (this.state !== 'countdown') return;
    if (Date.now() < this.countdownUntil) return;
    this.state = 'running';
    this.startedAt = Date.now();
    this.io.to(this.socketRoomName).emit('br:state', this.publicState());
    console.log(`[BR] ${this.lobbyType} match ${this.matchId} is live`);
  }

  /* Deliberately below the minimum, for testing the mode alone.

     The two-player minimum exists so a real match cannot be 'won' by the only
     person in the room, which is a rule about fairness to other players. An
     owner starting an empty evening on purpose is not that case, so it is an
     override rather than a lowering of the rule: canStart() still says no, and
     the console has to ask for this by name. */
  forceStart(reason) {
    if (this.state === 'running') return false;
    if (this.livingCount() < 1) return false;   // starting with nobody is not a match either
    this.state = 'waiting';                     // so startMatch's own guard passes
    const min = BR.MIN_PLAYERS;
    BR.MIN_PLAYERS = 1;
    try { return this.startMatch(reason || 'forced'); }
    finally { BR.MIN_PLAYERS = min; }
  }

  /* Called off. No winner, no prize — the money is only ever paid to somebody
     who actually outlasted the circle. */
  abandon() {
    /* Countdown counts. Ten seconds after pressing start is exactly when you
       notice you did not mean to, and refusing to cancel then made Stop useless
       in the one window where it is most wanted. */
    if (this.state !== 'running' && this.state !== 'countdown') return false;
    this.countdownUntil = 0;
    this.state = 'waiting';
    this.winner = null;
    this.matchId = null;
    this._prevAlive = null;
    this.io.to(this.socketRoomName).emit('br:state', this.publicState());
    return true;
  }

  /* Called from the tick. Owns worldRadius and worldCx/worldCy for this room. */
  updateZone() {
    this._tickCountdown();
    if (this.state !== 'running') {
      // Between matches the arena sits open at full size so people can gather.
      this.worldCx = 0; this.worldCy = 0;
      this.worldRadius += (BR.START_RADIUS - this.worldRadius) * 0.02;
      return;
    }

    const t = Date.now() - this.startedAt;

    if (t < BR.SHRINK_MS) {
      /* Closing. Eased rather than linear: it barely moves for the first while,
         which gives people time to find each other, then closes hard at the end
         when the fight is the point. */
      const k = t / BR.SHRINK_MS;
      const eased = k * k;
      this.worldRadius = BR.START_RADIUS + (BR.FINAL_RADIUS - BR.START_RADIUS) * eased;
      this.worldCx = 0; this.worldCy = 0;
      return;
    }

    /* Roaming: a sequence of announced hops, and a hard close at the end. */
    const full = BR.SHRINK_MS + BR.ROAM_MS;
    const leftMs = full - t;
    /* The last thirty seconds close it the rest of the way while it is still
       moving, so the end is a shrinking target rather than a stationary one. */
    this.worldRadius = leftMs > BR.ENDGAME_MS
      ? BR.FINAL_RADIUS
      : BR.FINAL_RADIUS + (BR.ENDGAME_RADIUS - BR.FINAL_RADIUS)
        * (1 - Math.max(0, leftMs) / BR.ENDGAME_MS);
    this._stepHop();

    /* Overtime. The clock is up but more than one snake is alive, so the circle
       keeps hopping AND keeps closing. Owen asked for it to run until everyone
       dies, and a match that ends in a draw has nobody to pay.

       Measured off `t`, not the roam-local clock the smooth version used — that
       variable went with it, and the runtime caught the reference on the first
       call rather than silently doing nothing. Overtime picks up from the
       endgame size rather than jumping back to the full one. */
    const over = t - (BR.SHRINK_MS + BR.ROAM_MS);
    if (over > 0) {
      this.worldRadius = Math.max(BR.OVERTIME_FLOOR,
        BR.ENDGAME_RADIUS - (over / 1000) * BR.OVERTIME_SHRINK_PER_SEC);
    }
  }

  /* Somewhere new to go: inside the wander radius, far enough to be worth
     announcing, and never so far out that the circle leaves the world. */
  _pickHop() {
    const cx = this.worldCx, cy = this.worldCy;
    for (let i = 0; i < 24; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * BR.ROAM_RADIUS;   // even by area
      const x = Math.cos(a) * r, y = Math.sin(a) * r;
      if (Math.hypot(x - cx, y - cy) < BR.ROAM_HOP_MIN_DIST) continue;
      if (Math.hypot(x, y) + BR.FINAL_RADIUS > BR.START_RADIUS) continue;
      return { x, y };
    }
    return { x: 0, y: 0 };            // give up and go back to the middle
  }

  /* One hop: travel, arrive, rest, choose again.

     The first leg begins wherever the closing left the circle, which is the
     middle, so there is no jump into the roam — the property the smooth version
     had to be engineered to keep, this one gets for free. */
  _stepHop() {
    const now = Date.now();
    if (!this._hopTo) {
      this._hopFrom = { x: this.worldCx, y: this.worldCy };
      this._hopTo = this._pickHop();
      const d = Math.hypot(this._hopTo.x - this._hopFrom.x, this._hopTo.y - this._hopFrom.y);
      this._hopMs = Math.max(1200, (d / BR.ROAM_HOP_SPEED) * 1000);
      this._hopStart = now;
      this._hopHoldUntil = 0;
      return;
    }
    if (this._hopHoldUntil && now < this._hopHoldUntil) {
      this.worldCx = this._hopTo.x; this.worldCy = this._hopTo.y;
      return;
    }
    if (this._hopHoldUntil) { this._hopTo = null; this._stepHop(); return; }

    const k = Math.min(1, (now - this._hopStart) / this._hopMs);
    const ease = k * k * (3 - 2 * k);      // no lurch at either end of a leg
    this.worldCx = this._hopFrom.x + (this._hopTo.x - this._hopFrom.x) * ease;
    this.worldCy = this._hopFrom.y + (this._hopTo.y - this._hopFrom.y) * ease;
    if (k >= 1) this._hopHoldUntil = now + BR.ROAM_HOP_HOLD_MS;
  }

  /* Where it is heading, for the outline on screen. Null while it is resting,
     because there is nothing to announce until it has chosen. */
  hopTarget() {
    if (this.state !== 'running') return null;
    if (!this._hopTo || this._hopHoldUntil) return null;
    return this._hopTo;
  }

  /* ── ending ────────────────────────────────────────────────────────────── */

  /* Called after the sim has run, so the living count is this tick's truth. */
  /* A match that began with one player. Owen is the only person on the game, so
     without this the mode cannot be tested at all: 'last one standing' is true
     the moment a solo match starts and it ends before the countdown clears.

     A solo run is scored against the ZONE instead of against other people. It
     ends when the player dies, or when the full four minutes are up and they
     are still alive — which is the real test of the thing anyway, since what is
     being tested is the closing circle and not the fighting.

     It pays NOTHING. Winning $20 for outlasting nobody is escrow paying a
     player to be alone in a room, and the payout reads this flag. */
  isSoloRun() { return this.startedWith === 1; }

  checkForWinner() {
    if (this.state !== 'running') return;
    const alive = this.livingSnakes();

    if (this.isSoloRun()) {
      const t = Date.now() - this.startedAt;
      const timeUp = t >= BR.SHRINK_MS + BR.ROAM_MS;
      if (alive.length && !timeUp) { this._prevAlive = alive; return; }
      // Died, or survived the whole thing. Either way it is over.
    } else if (alive.length > 1) { this._prevAlive = alive; return; }

    /* The previous tick's survivors, kept because the count can go straight
       from two to zero. The border kills instantly, so two snakes on opposite
       edges of a closing circle really do die on the same tick — and 'nobody
       won' means a $20 prize with nobody to pay it to.

       When it happens, the higher score takes it. The circle took them both, so
       the better run wins, which is the only tiebreak here that is about how
       they played rather than which one the loop happened to reach first. */
    let won = alive[0] || null;
    if (!won && this._prevAlive && this._prevAlive.length) {
      won = this._prevAlive.slice().sort((a, b) => (b.score || 0) - (a.score || 0))[0];
    }
    this._prevAlive = alive;
    this.state = 'over';
    this.endedAt = Date.now();
    this.winner = (won && this.snakes.has(won.id)) ? {
      id: won.id,
      name: won.name,
      wallet: (this.players.get(won.id) || {}).walletAddress || null,
    } : null;

    this.soloRun = this.isSoloRun();
    console.log(`[BR] ${this.lobbyType} match ${this.matchId}`
      + (this.soloRun ? ' (solo test run, no prize)' : '')
      + ` won by ` + (this.winner ? this.winner.name : 'nobody')
      + ` after ${(this.endedAt - this.startedAt) / 1000 | 0}s`);
    this.io.to(this.socketRoomName).emit('br:state', this.publicState());

    /* The room reopens for the next one. The prize is not paid here — that is
       phase 4, and it will be triggered from the server off this.winner, never
       from anything the winning client sends. */
    setTimeout(() => {
      if (this.state === 'over') {
        this.state = 'waiting';
        this.io.to(this.socketRoomName).emit('br:state', this.publicState());
      }
    }, 15 * SEC);
  }

  /* What the lobby and the game are allowed to know. */
  publicState() {
    const t = this.state === 'running' ? Date.now() - this.startedAt : 0;
    return {
      state: this.state,
      countdownMs: this.state === 'countdown'
        ? Math.max(0, this.countdownUntil - Date.now()) : 0,
      matchId: this.matchId,
      alive: this.livingCount(),
      players: this.snakes.size,
      minPlayers: BR.MIN_PLAYERS,
      canStart: this.canStart(),
      elapsedMs: t,
      totalMs: BR.SHRINK_MS + BR.ROAM_MS,
      phase: this.state === 'countdown' ? 'countdown'
           : this.state !== 'running' ? this.state
           : t < BR.SHRINK_MS ? 'closing'
           : t < BR.SHRINK_MS + BR.ROAM_MS ? 'roaming' : 'overtime',
      soloRun: !!this.soloRun,
      startedWith: this.startedWith || 0,
      winner: this.winner ? { name: this.winner.name } : null,
    };
  }
}

module.exports = { BattleRoyaleRoom, BR };
