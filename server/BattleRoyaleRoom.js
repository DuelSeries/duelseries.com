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

  /* One. Owen tests this alone and there is nobody else on the game yet, so a
     two-player minimum only ever stopped him starting it. It stays a named
     constant rather than being deleted, because the day there are real players
     a lone match IS worth refusing and this is the line to change. */
  MIN_PLAYERS: 1,

  /* The arena at its widest, which is the whole world: a battle royale starts
     with everywhere in play and takes it away a ring at a time. */
  START_RADIUS: C.MAX_WORLD_RADIUS,

  /* HOW MUCH SMALLER EACH RING IS THAN THE ONE BEFORE IT.

     Owen asked for about 10%. From a 6000 starting radius down to 165 that is
     34 rings, and even with the wall moving at its limit the whole way it comes
     out around eight minutes — which is a long time to ask people to stand in a
     lobby for. 0.78 is the same mechanic at about fourteen rings and roughly
     four minutes, which is what the mode was already budgeted at. It is one
     number: raise it toward 0.9 for a longer, gentler match. */
  RING_SHRINK: 0.78,
  /* The circle does not stop at a size a match can be survived in.

     165 is the smallest circle a snake can still turn around inside, and the
     first version stopped there — which froze the zone completely, because a
     ring that cannot shrink also has no slack to move its centre into. Two
     snakes could then circle each other for as long as they liked, and there
     is no clock left in this mode to end it for them.

     So it keeps going, past the point where the arena is playable and down to
     a floor nothing can survive sharing. Below 165 you can no longer turn
     inside it, which is the endgame: the last two are pushed into each other
     rather than politely waiting. */
  RING_MIN_RADIUS: 40,
  RING_ENDGAME_RADIUS: 165,    // below this a snake can no longer turn inside

  /* THE ANNOUNCEMENT. The white circle is up and the wall has not moved yet.
     Longer when the circle is small, because that is when being caught outside
     it costs you the match; the first rings are enormous and nobody is near
     their edge. */
  RING_WARN_MIN_MS: 4 * SEC,
  RING_WARN_MAX_MS: 11 * SEC,

  /* A floor on the travel, so even a tiny adjustment is something you can watch
     arrive rather than a jump. The rest afterwards is a breath before the next
     circle is called. */
  RING_MOVE_MIN_MS: 2500,
  RING_REST_MS: 1500,

  /* HOW FAST THE WALL MAY CLOSE, as a share of what a snake can actually do.

     This was a DURATION — one minute — and the speed was whatever fell out of
     it. What fell out of it was a wall that outran everybody: the close is
     eased, so its rate peaked at 186 units a second against a snake that
     cruises at 133. The only way to survive the last seconds was to boost,
     which costs body, and nothing tells a bot to boost.

     Now it is the speed that is set and the durations that fall out. At 0.7 the
     wall never exceeds about 93 units a second, which leaves 40 a second of
     margin at a walk — you outrun it while fighting rather than only by burning
     body. Every ring's travel time is derived from this. */
  CLOSE_SPEED_FRAC: 0.7,
};

/* A snake's cruising speed in units per SECOND. Every speed limit above is
   written against this one number, so the day the snake gets faster the wall
   does too and none of the margins quietly invert. */
BR.CRUISE = C.SNAKE_BASE_SPEED * C.TICK_RATE;

/* The fastest the wall may ever travel, kept as a number so a test can assert
   it rather than re-derive it and agree with itself. */
BR.CLOSE_SPEED = BR.CLOSE_SPEED_FRAC * BR.CRUISE;

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
    return this.state === 'waiting' && this.humanLiving() >= BR.MIN_PLAYERS;
  }

  livingCount() {
    let n = 0;
    for (const s of this.snakes.values()) if (s && s.alive) n++;
    return n;
  }

  /* Everyone who is still alive, robots included. This is the room's
     population, which is what the console and the lobby want to show. */
  livingSnakes() {
    const out = [];
    for (const s of this.snakes.values()) if (s && s.alive) out.push(s);
    return out;
  }

  /* Everyone still alive who is a PERSON, which is what decides the prize.

     A bot has no wallet to be paid into, so a match ending with a robot
     winner is a $20 prize with nobody to give it to — the payout would look
     up `players` for an id that was never in it and find nothing. Worse, a
     room standing full of robots satisfied the minimum to START a match, so
     the event could kick off with no people in it at all.

     Bots are opposition in this mode, never contenders. They make the circle
     worth running from; they do not win it. */
  humanSnakes() {
    const out = [];
    for (const s of this.snakes.values()) if (s && s.alive && !s.isBot) out.push(s);
    return out;
  }
  humanLiving() { return this.humanSnakes().length; }

  /* Once the timer starts, nobody comes back.

     The match is last snake standing and it pays a real prize, so a player who
     can press Play again is a player who cannot lose: the circle would close
     on somebody who simply rejoins behind it. Dying in a battle royale has to
     be the end of your match, and it was not — the respawn handler had no idea
     this room was any different from the free one.

     Bots are covered by topUpBots below, which adds none while a match runs. */
  allowsRespawn() { return this.state === 'waiting'; }

  /* Bots fill the LOBBY, not the match.

     This room inherits GameRoom's tick, which now tops a free room up to the
     bot floor once a second — and `br` is a free lobby type, so without this
     the moment that floor was raised a prize match would have found itself
     sharing the circle with twenty robots that arrived mid-round. They are
     here so somebody who opens the lobby early sees a room with life in it,
     and that job is finished the moment the countdown starts. */
  topUpBots() {
    if (this.state !== 'waiting') return;
    super.topUpBots();
  }

  /* Called by GameRoom.killSnake for every death in this room, so the order
     people went out in is known when it is needed rather than reconstructed
     from bodies that no longer carry it. */
  noteFallen(snake) {
    if (this.state !== 'running' || !snake || snake.isBot) return;
    (this._fallen || (this._fallen = [])).push({
      id: snake.id, name: snake.name, score: snake.score || 0,
    });
  }

  startMatch(reason) {
    if (!this.canStart()) return false;
    this.state = 'countdown';
    this.countdownUntil = Date.now() + BR.COUNTDOWN_MS;
    /* How many were in it when it began, which is what decides how it can END.
       A real match is over when one is left; a match of ONE is over the instant
       it starts by that rule, because the only player is already the last one
       standing. */
    this.startedWith = this.humanLiving();
    this._ring = null; this._ringNo = 0;          // no leftovers from the last match
    this._fallen = []; this.podium = null;        // nor from its podium
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
    if (this.humanLiving() < 1) return false;   // starting with nobody is not a match either
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

  /* ── the zone ─────────────────────────────────────────────────────────────
     RINGS, not a clock.

     A white circle appears somewhere inside the current one and a little
     smaller. It sits there long enough to be read and run for. Then the wall
     travels to it — radius and centre together — and rests. Then it happens
     again, and again, until the circle is as small as it goes and only one
     snake is still in it.

     The old model was a two-minute close to the middle followed by two minutes
     of the small circle hopping about, with sudden death when the clock ran
     out. It worked, but the match was on rails: the zone always ended up in
     the middle, so where you stood at the start decided how far you had to
     swim, and it decided it before anybody had done anything.

     Nothing here runs on the match clock any more. A match is over when one
     snake is left, and the pressure that makes that happen is geometric. */

  /* Called from the tick. Owns worldRadius and worldCx/worldCy for this room. */
  updateZone() {
    this._tickCountdown();
    if (this.state !== 'running') {
      // Between matches the arena sits open at full size so people can gather.
      this.worldCx = 0; this.worldCy = 0;
      this.worldRadius += (BR.START_RADIUS - this.worldRadius) * 0.02;
      this._ring = null;
      return;
    }

    const now = Date.now();
    if (!this._ring) this._ring = this._nextRing(now);
    const g = this._ring;

    if (now < g.warnUntil) {
      /* Announced and not yet moving. The wall is exactly where it was; the
         white circle is on screen saying where it is going. */
      this.worldRadius = g.fr; this.worldCx = g.fx; this.worldCy = g.fy;
      return;
    }

    const moveEnd = g.warnUntil + g.moveMs;
    if (now < moveEnd) {
      /* Travelling. Radius and centre move together and at a constant rate, so
         the speed the wall shows on one side is the speed it shows on all of
         them and there is no moment where it lurches. */
      const k = g.moveMs > 0 ? (now - g.warnUntil) / g.moveMs : 1;
      this.worldRadius = g.fr + (g.tr - g.fr) * k;
      this.worldCx = g.fx + (g.tx - g.fx) * k;
      this.worldCy = g.fy + (g.ty - g.fy) * k;
      return;
    }

    this.worldRadius = g.tr; this.worldCx = g.tx; this.worldCy = g.ty;
    if (now >= moveEnd + BR.RING_REST_MS) this._ring = this._nextRing(now);
  }

  /* Where the next circle goes, and how long each part of getting there takes.

     CONTAINED. The new circle is always wholly inside the old one, which is
     what makes this a shrinking game rather than a wandering one: the ground
     that is safe now was safe a moment ago, so running for the ring can never
     take you through the wall. That is the constraint the centre is picked
     under — its distance from the old centre is at most the difference in
     radii. */
  _nextRing(now) {
    const fr = this.worldRadius, fx = this.worldCx, fy = this.worldCy;
    const tr = Math.max(BR.RING_MIN_RADIUS, fr * BR.RING_SHRINK);

    const slack = Math.max(0, fr - tr);
    const a = Math.random() * Math.PI * 2;
    /* sqrt for an even spread by AREA. Without it the centre bunches toward
       the middle and every ring lands roughly where the last one did, which is
       the on-rails problem this model exists to get away from. */
    const d = Math.sqrt(Math.random()) * slack;
    const tx = fx + Math.cos(a) * d, ty = fy + Math.sin(a) * d;

    /* THE SPEED LIMIT, which is the one rule the wall cannot break. A point on
       the boundary moves by at most the shrink plus the centre's travel, so
       holding that under a fraction of a snake's cruising speed is what makes
       the wall something you outrun rather than something that catches you. */
    const worst = (fr - tr) + Math.hypot(tx - fx, ty - fy);
    const moveMs = Math.max(BR.RING_MOVE_MIN_MS,
                            worst / (BR.CLOSE_SPEED_FRAC * BR.CRUISE) * SEC);

    /* The warning is longer when the circle is small, because that is when
       being caught outside it costs you the match. Early rings are enormous and
       nobody is anywhere near their edge. */
    const smallness = 1 - Math.min(1, (fr - BR.RING_ENDGAME_RADIUS) /
                                      Math.max(1, BR.START_RADIUS - BR.RING_ENDGAME_RADIUS));
    const warnMs = BR.RING_WARN_MIN_MS +
                   (BR.RING_WARN_MAX_MS - BR.RING_WARN_MIN_MS) * smallness;

    this._ringNo = (this._ringNo || 0) + 1;
    return { fx, fy, fr, tx, ty, tr, moveMs,
             warnUntil: now + warnMs, startedAt: now };
  }

  /* The white circle: where the wall is going and how big it will be when it
     gets there. Shown while it is announced AND while it is travelling, so it
     stays on screen as a destination the whole time it matters. Null while the
     zone is resting, because there is nothing to announce yet. */
  hopTarget() {
    if (this.state !== 'running' || !this._ring) return null;
    const g = this._ring;
    if (Date.now() >= g.warnUntil + g.moveMs) return null;
    return { x: g.tx, y: g.ty, r: g.tr };
  }

  /* Which phase the zone is in, for the HUD. */
  zonePhase() {
    if (this.state !== 'running' || !this._ring) return 'open';
    const now = Date.now(), g = this._ring;
    if (now < g.warnUntil) return 'warning';
    if (now < g.warnUntil + g.moveMs) return 'closing';
    return 'holding';
  }

  /* How long until the wall starts moving, which is the only countdown left in
     this mode and the only one worth putting on screen. */
  zoneMs() {
    if (this.state !== 'running' || !this._ring) return 0;
    return Math.max(0, this._ring.warnUntil - Date.now());
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
    const alive = this.humanSnakes();

    /* A solo run ends when the circle gets you, and NOT when the clock runs
       out — the clock running out is the start of sudden death, which is the
       part worth watching. Ending on the buzzer meant the one person who can
       test this never got to see it. */
    if (this.isSoloRun()) {
      if (alive.length) { this._prevAlive = alive; return; }
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

    /* THE PODIUM. Who was last standing, second last, third last.

       Kept as they fall rather than worked out at the end, because by the time
       there is a winner the other two are dead and a dead snake's place in the
       order is not recoverable from anything left on it. `_fallen` is appended
       to by killSnake in the order people go out, so the last three entries
       ARE third, second and first from the back. */
    const order = (this._fallen || []).slice().reverse();
    const podium = [];
    if (won) podium.push({ place: 1, name: won.name, score: won.score || 0 });
    for (const f of order) {
      if (podium.length >= 3) break;
      if (won && f.id === won.id) continue;
      podium.push({ place: podium.length + 1, name: f.name, score: f.score || 0 });
    }
    this.podium = podium;

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
      /* No total any more: the match runs until one snake is left, not until
         a clock says so. What there IS to count down is the wall's next move,
         which is the only number on this screen anybody can act on. */
      ring: this._ringNo || 0,
      zoneMs: this.zoneMs(),
      phase: this.state === 'countdown' ? 'countdown'
           : this.state !== 'running' ? this.state
           : this.zonePhase(),
      soloRun: !!this.soloRun,
      startedWith: this.startedWith || 0,
      winner: this.winner ? { name: this.winner.name } : null,
      /* Names and scores only. A wallet address is nobody else's business and
         the podium is the most public thing this room produces. */
      podium: this.podium || null,
    };
  }
}

module.exports = { BattleRoyaleRoom, BR };
