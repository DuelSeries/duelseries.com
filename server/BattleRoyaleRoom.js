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
  SHRINK_MS:   2 * 60 * SEC,   // closing in
  ROAM_MS:     2 * 60 * SEC,   // the small circle wandering
  /* One. Owen tests this alone and there is nobody else on the game yet, so a
     two-player minimum only ever stopped him starting it. It stays a named
     constant rather than being deleted, because the day there are real players
     a lone match IS worth refusing and this is the line to change. */
  MIN_PLAYERS: 1,
  START_RADIUS: C.MAX_WORLD_RADIUS,
  FINAL_RADIUS: 420,           // about six snake-lengths across at spawn size
  /* How far the small circle wanders, as a fraction of the room it has. Kept
     below 1 so the zone can never wander off the world it was drawn in. */
  ROAM_REACH:  0.55,
  ROAM_PERIOD_MS: 46 * SEC,    // one lap of its drift path
  /* Overtime: the clock is up and more than one snake is alive, so it keeps
     closing until somebody is. Six a second, not fourteen: fourteen went from
     420 to the floor in thirty seconds, which is not a squeeze, it is a
     guillotine — and one very likely to take both finalists on the same tick.
     The floor is a circle a snake can still turn inside. */
  OVERTIME_SHRINK_PER_SEC: 6,
  OVERTIME_FLOOR: 150,
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
    if (this.state !== 'running') return false;
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

    /* Roaming. The circle holds its size and wanders on a slow looping path.
       Two frequencies that do not divide into each other, so it does not retrace
       the same oval and become predictable. */
    this.worldRadius = BR.FINAL_RADIUS;
    const roamT = t - BR.SHRINK_MS;
    const reach = BR.START_RADIUS * BR.ROAM_REACH - BR.FINAL_RADIUS;
    const a = this._roamSeed + (roamT / BR.ROAM_PERIOD_MS) * Math.PI * 2;
    this.worldCx = Math.cos(a) * reach * 0.75;
    this.worldCy = Math.sin(a * 0.61) * reach * 0.75;

    /* Overtime. The clock is up but more than one snake is alive, so the circle
       keeps wandering AND starts closing again. Owen asked for it to keep going
       until everyone dies, and a match that ends in a draw has nobody to pay. */
    const over = roamT - BR.ROAM_MS;
    if (over > 0) {
      this.worldRadius = Math.max(BR.OVERTIME_FLOOR,
        BR.FINAL_RADIUS - (over / 1000) * BR.OVERTIME_SHRINK_PER_SEC);
    }
  }

  /* ── ending ────────────────────────────────────────────────────────────── */

  /* Called after the sim has run, so the living count is this tick's truth. */
  checkForWinner() {
    if (this.state !== 'running') return;
    const alive = this.livingSnakes();
    if (alive.length > 1) { this._prevAlive = alive; return; }

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

    console.log(`[BR] ${this.lobbyType} match ${this.matchId} won by `
      + (this.winner ? this.winner.name : 'nobody') + ` after ${(this.endedAt - this.startedAt) / 1000 | 0}s`);
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
      winner: this.winner ? { name: this.winner.name } : null,
    };
  }
}

module.exports = { BattleRoyaleRoom, BR };
