'use strict';
/* ─── Knockout ────────────────────────────────────────────────────────────────
   Two players, two pieces each, one shrinking disc over a pit. Every turn both
   players get fifteen seconds to drag an arrow out of each of their pieces —
   direction is where it goes, length is how hard. Neither can see the other
   aiming. When the clock runs out all four launch at once, they knock each
   other around, and whatever is still on the disc when everything stops is what
   you have left. Lose both pieces and you have lost.

   WHY SIMULTANEOUS, AND WHY HIDDEN. Alternating turns would make this a game of
   reacting: the second player always knows more than the first. Committing in
   secret and resolving together turns every turn into a read — are they coming
   for my exposed piece, or protecting theirs? — and a read is a skill. That is
   the whole reason this game exists in place of the one it replaced.

   EVERYTHING IS DECIDED HERE, AND THE CLIENT IS HANDED THE RESULT. The server
   runs the entire resolution the moment the timer expires and sends the whole
   trajectory down; the client plays it back like a tape. Same arrangement as
   TanksRoom and for the same reasons. A client cannot resolve a collision in its
   own favour, cannot see where a shot will end before the server has decided,
   and cannot report a knock-off that did not happen. Two clients playing the
   same tape also cannot disagree about what they watched, which is a thing that
   matters when the two of them are about to disagree about who won.

   The physics is deliberately small: equal-mass circles, elastic bounces,
   exponential drag, and a radius test for the edge. Carrom, air hockey and
   sumo all work on exactly this, and anything more elaborate would be harder to
   read on screen without playing any better. */

const KO = {
  /* The disc, in world units. The client scales this to whatever screen it has,
     so these are proportions rather than pixels. */
  ARENA_R0: 420,              // radius at the first turn
  ARENA_SHRINK: 26,           // taken off the radius at the start of each turn
  ARENA_R_MIN: 170,           // never so small there is nowhere left to play

  PIECE_R: 26,
  PIECES_EACH: 2,

  COUNTDOWN_MS: 3000,         // the three seconds before the first turn
  AIM_MS: 15000,              // how long you have to commit

  /* Aiming. The drag is measured in world units and clamped, so a longer screen
     cannot buy a harder shot — a phone and a desktop hit exactly as hard. */
  MAX_PULL: 260,
  MAX_SPEED: 1250,            // units per second at a full-length arrow
  MIN_SPEED: 40,              // below this the arrow is treated as no move at all

  /* Resolution. Drag is exponential rather than linear because a linear stop is
     a piece that slides at a constant rate and then hits a wall, which reads as
     the animation ending rather than the piece coming to rest.

     THESE THREE DECIDE WHETHER THE GAME HAS A POSITIONING LAYER, and the first
     values I picked did not. At a restitution of 0.94 an equal-mass head-on hit
     is very nearly a perfect handover: the struck piece leaves with almost
     everything the hammer arrived with, so it travels about as far as a full
     shot would. Measured, that knocked a piece off the disc from EVERY position
     tested, including dead centre. A game where any clean contact is a kill has
     no reason for a player to think about where their pieces sit, and no reason
     for the ring to close.

     Retuned so a full-power hit at close range carries the struck piece about
     200 units. The middle of the disc is then genuinely safer than the rim, an
     exposed piece is a liability you can see coming, and the shrinking ring does
     something: it drags the safe ground out from under both players.

     It also made distance matter on its own. A shot loses speed the whole way,
     so a hit from across the disc arrives at a quarter of its muzzle speed and
     barely nudges. Closing the gap is worth a turn. */
  STEP: 1 / 60,
  DRAG_PER_S: 2.6,            // velocity multiplier per second: v *= e^(-2.6t)
  STOP_SPEED: 14,             // slower than this and it has stopped
  MAX_RESOLVE_S: 9,           // a hard ceiling, so a turn always ends
  RESTITUTION: 0.55,          // how much of the closing speed the hit hands over
};

/* A timestamp of zero is a real timestamp. `now || Date.now()` treats it as a
   missing argument, which quietly swapped the wall clock in under any harness
   that starts its clock at zero — and a room whose turn timer only works when
   it is run in real time is a room that cannot be measured. */
function nowOr(t) { return typeof t === 'number' && Number.isFinite(t) ? t : Date.now(); }

let nextId = 1;

/* ── one piece ──────────────────────────────────────────────────────────── */
class Piece {
  constructor(id, owner, x, y) {
    this.id = id;
    this.owner = owner;       // the socket id it belongs to
    this.x = x; this.y = y;
    this.vx = 0; this.vy = 0;
    this.alive = true;
    this.outAt = -1;          // the frame it left the disc, for the playback
  }
}

class KnockoutRoom {
  constructor(io, roomId) {
    this.io = io;
    this.id = roomId || ('ko_' + (nextId++));
    this.socketRoomName = 'ko_' + this.id;

    this.state = 'waiting';   // waiting | countdown | aiming | resolving | over
    this.players = new Map(); // socketId -> { socket, name, wallet, side }
    this.pieces = [];
    this.arenaR = KO.ARENA_R0;
    this.turn = 0;
    this.phaseEndsAt = 0;
    this.winner = null;       // socketId, or null for a draw
    this.overWhy = '';
    this.stake = 0;           // free while the game is new
    this.aims = new Map();    // socketId -> [{ pieceId, ax, ay }]
    this.ready = new Set();   // who has locked in this turn
    this.lastResolve = null;
  }

  /* ── seats ──────────────────────────────────────────────────────────────── */

  addPlayer(socket, name, wallet) {
    if (this.players.size >= 2) return false;
    const side = this.players.size;        // 0 = left, 1 = right
    this.players.set(socket.id, { socket, name: name || 'Player', wallet: wallet || null, side });
    if (socket.join) socket.join(this.socketRoomName);
    return true;
  }

  removePlayer(socketId) {
    if (!this.players.has(socketId)) return;
    this.players.delete(socketId);
    /* Somebody walking out ends it. The alternative is the person still here
       staring at a fifteen second timer for an opponent who will never move. */
    if (this.state !== 'over' && this.state !== 'waiting') {
      const rest = [...this.players.keys()];
      this.finish(rest.length === 1 ? rest[0] : null, 'opponent left');
    }
  }

  opponentOf(socketId) {
    for (const id of this.players.keys()) if (id !== socketId) return id;
    return null;
  }

  piecesOf(socketId) { return this.pieces.filter(p => p.owner === socketId && p.alive); }

  /* ── the opening position ───────────────────────────────────────────────
     Facing each other across the disc, offset off the centre line so the very
     first turn is not a head-on shot down a straight line that both players can
     solve identically. */
  layOut() {
    this.pieces = [];
    let n = 0;
    const spread = this.arenaR * 0.42;
    for (const [id, p] of this.players) {
      const dir = p.side === 0 ? -1 : 1;
      for (let i = 0; i < KO.PIECES_EACH; i++) {
        const y = (i === 0 ? -1 : 1) * spread * 0.5;
        this.pieces.push(new Piece(++n, id, dir * spread, y));
      }
    }
  }

  start(now) {
    if (this.players.size < 2) return false;
    this.arenaR = KO.ARENA_R0;
    this.turn = 0;
    this.layOut();
    this.state = 'countdown';
    this.phaseEndsAt = nowOr(now) + KO.COUNTDOWN_MS;
    this.broadcast('ko:start', this.publicState());
    return true;
  }

  /* ── aiming ─────────────────────────────────────────────────────────────── */

  /* An aim is a direction and a length, both of them the client's to choose and
     neither of them the client's to be trusted about. The length is clamped to
     MAX_PULL here rather than believed, so a modified client that sends a pull
     of ten thousand gets exactly the same shot as a player who dragged to the
     edge of the screen. */
  submitAim(socketId, aims) {
    if (this.state !== 'aiming') return { ok: false, why: 'not aiming' };
    if (!this.players.has(socketId)) return { ok: false, why: 'not in this match' };
    if (!Array.isArray(aims)) return { ok: false, why: 'no aim' };

    const mine = new Map(this.piecesOf(socketId).map(p => [p.id, p]));
    const clean = [];
    for (const a of aims.slice(0, KO.PIECES_EACH * 2)) {
      if (!a || !mine.has(a.pieceId)) continue;          // not yours, or already off
      const ax = Number(a.ax), ay = Number(a.ay);
      if (!Number.isFinite(ax) || !Number.isFinite(ay)) continue;
      const len = Math.hypot(ax, ay);
      if (len < 1) continue;
      const pull = Math.min(len, KO.MAX_PULL);
      clean.push({ pieceId: a.pieceId, ax: (ax / len) * pull, ay: (ay / len) * pull });
    }
    /* One aim per piece, last one wins: the client is allowed to change its
       mind right up to the buzzer, and re-dragging the same piece is the
       obvious way a player expects to do that. */
    const byPiece = new Map();
    for (const a of clean) byPiece.set(a.pieceId, a);
    this.aims.set(socketId, [...byPiece.values()]);
    return { ok: true, count: byPiece.size };
  }

  /* Locking in early. The fifteen seconds is a DEADLINE, not a wait: when both
     players are done there is nothing left to look at, and against a bot that
     would be twelve seconds of staring at a timer every single turn. */
  lockIn(socketId) {
    if (this.state !== 'aiming' || !this.players.has(socketId)) return false;
    this.ready.add(socketId);
    return true;
  }

  bothReady() {
    for (const id of this.players.keys()) if (!this.ready.has(id)) return false;
    return this.players.size === 2;
  }

  /* ── the turn clock ─────────────────────────────────────────────────────── */

  tick(now) {
    const t = nowOr(now);
    if (this.state === 'countdown') {
      if (t >= this.phaseEndsAt) this.beginTurn(t);
      return;
    }
    if (this.state === 'aiming') {
      if (t >= this.phaseEndsAt || this.bothReady()) this.resolve(t);
      return;
    }
    if (this.state === 'resolving') {
      /* Only once the tape has finished playing. Deciding the match the instant
         the maths is done would put the result card on screen over the top of
         the collision that caused it, and the collision is the part worth
         watching. */
      if (t >= this.phaseEndsAt && !this.checkOver()) this.beginTurn(t);
      return;
    }
  }

  /* A turn opens by closing the ring. Shrinking here rather than after the
     collisions means you always aim inside the disc you are actually playing
     on, which is the difference between a shrinking arena and a trapdoor. */
  beginTurn(now) {
    const t = nowOr(now);
    this.turn++;
    if (this.turn > 1) {
      this.arenaR = Math.max(KO.ARENA_R_MIN, this.arenaR - KO.ARENA_SHRINK);
      /* Anything the ring closed past goes now, before anybody aims at it. */
      for (const p of this.pieces) {
        if (p.alive && Math.hypot(p.x, p.y) > this.arenaR) p.alive = false;
      }
      if (this.checkOver()) return;
    }
    this.aims.clear();
    this.ready.clear();
    this.state = 'aiming';
    this.phaseEndsAt = t + KO.AIM_MS;
    this.broadcast('ko:turn', this.publicState());
  }

  /* ── the reveal ─────────────────────────────────────────────────────────── */

  /* Launch everything, run it to a standstill, and hand back the tape. */
  resolve(now) {
    const t = nowOr(now);

    for (const [id, aims] of this.aims) {
      for (const a of aims) {
        const p = this.pieces.find(q => q.id === a.pieceId && q.alive && q.owner === id);
        if (!p) continue;
        const pull = Math.hypot(a.ax, a.ay);
        const speed = (pull / KO.MAX_PULL) * KO.MAX_SPEED;
        if (speed < KO.MIN_SPEED) continue;               // a twitch is not a move
        p.vx = (a.ax / pull) * speed;
        p.vy = (a.ay / pull) * speed;
      }
    }

    const tape = this.simulate();
    this.lastResolve = tape;
    this.state = 'resolving';
    /* Held for as long as the tape takes to play, plus a beat to read the
       result, so the next aiming phase does not open over a moving board. */
    this.phaseEndsAt = t + Math.round(tape.frames.length * KO.STEP * 1000) + 900;
    this.broadcast('ko:resolve', Object.assign({ state: this.publicState() }, tape));
  }

  /* The whole resolution, run flat out. Returns the frames to play back.

     Positions are rounded to whole units on the way out. At this scale that is
     well under a pixel on any screen this is drawn at, and it roughly halves
     the size of the message. */
  simulate() {
    const frames = [];
    const order = this.pieces.map(p => p.id);
    const maxFrames = Math.round(KO.MAX_RESOLVE_S / KO.STEP);
    const decay = Math.exp(-KO.DRAG_PER_S * KO.STEP);
    const R = this.arenaR;
    /* Only what goes off during THIS reveal. Reading it off the pieces instead
       would re-report every piece lost earlier in the match, every turn, and
       the client would replay an old knock-off animation each time. */
    const wentOut = [];

    for (let f = 0; f < maxFrames; f++) {
      for (const p of this.pieces) {
        p.x += p.vx * KO.STEP;
        p.y += p.vy * KO.STEP;
      }
      this.collide();
      let moving = false;
      for (const p of this.pieces) {
        p.vx *= decay; p.vy *= decay;
        if (Math.hypot(p.vx, p.vy) < KO.STOP_SPEED) { p.vx = 0; p.vy = 0; }
        else moving = true;

        /* Off the edge when the CENTRE passes it. A piece teetering with half
           of itself over the drop is still on the disc, which is both the
           readable rule and the one that makes the last inch worth fighting
           over. Once it is off it keeps its speed and sails away, so the fall
           is something you watch rather than something you are told about. */
        if (p.alive && Math.hypot(p.x, p.y) > R) {
          p.alive = false;
          p.outAt = f;
          wentOut.push({ id: p.id, frame: f });
        }
      }
      frames.push(this.snapshotFrame());
      if (!moving) break;
    }

    return { order, frames, out: wentOut, arenaR: Math.round(R) };
  }

  /* One row of the tape: every piece's position, in the order `order` lists
     them, flat rather than as objects because this is the part of the message
     there are several hundred of. */
  snapshotFrame() {
    const row = new Array(this.pieces.length * 2);
    for (let i = 0; i < this.pieces.length; i++) {
      row[i * 2] = Math.round(this.pieces[i].x);
      row[i * 2 + 1] = Math.round(this.pieces[i].y);
    }
    return row;
  }

  /* Equal-mass elastic collisions, resolved pairwise.

     Only the components ALONG the line between two centres are exchanged; the
     sideways components are untouched, which is what makes a glancing hit
     glance instead of stopping dead. Overlap is pushed apart first, because two
     circles that are already inside each other will otherwise swap velocities
     again on the next step and stick together vibrating. */
  collide() {
    const n = this.pieces.length;
    for (let i = 0; i < n; i++) {
      const a = this.pieces[i];
      if (!a.alive) continue;
      for (let j = i + 1; j < n; j++) {
        const b = this.pieces[j];
        if (!b.alive) continue;
        let dx = b.x - a.x, dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        const min = KO.PIECE_R * 2;
        if (d >= min || d === 0) continue;

        const nx = dx / d, ny = dy / d;
        const push = (min - d) / 2;
        a.x -= nx * push; a.y -= ny * push;
        b.x += nx * push; b.y += ny * push;

        const avn = a.vx * nx + a.vy * ny;
        const bvn = b.vx * nx + b.vy * ny;
        if (avn - bvn <= 0) continue;        // already separating; nothing to do
        const e = KO.RESTITUTION;
        const da = (bvn - avn) * e;
        a.vx += nx * da; a.vy += ny * da;
        b.vx -= nx * da; b.vy -= ny * da;
      }
    }
  }

  /* ── the end ────────────────────────────────────────────────────────────── */

  checkOver() {
    if (this.state === 'over') return true;
    const standing = [];
    for (const id of this.players.keys()) {
      if (this.piecesOf(id).length > 0) standing.push(id);
    }
    if (standing.length === 1) { this.finish(standing[0], 'last one standing'); return true; }
    if (standing.length === 0 && this.players.size) {
      /* Both sides cleared on the same reveal. It happens: two pieces trade a
         hit at the edge and leave together. Nobody won it, and calling it for
         whoever the loop reached first would be inventing a result. */
      this.finish(null, 'everyone went off');
      return true;
    }
    return false;
  }

  finish(winnerId, why) {
    if (this.state === 'over') return;
    this.state = 'over';
    this.winner = winnerId || null;
    this.overWhy = why || '';
    this.broadcast('ko:over', {
      winner: winnerId ? (this.players.get(winnerId) || {}).name || null : null,
      winnerId: winnerId || null,
      why: this.overWhy,
      turn: this.turn,
    });
  }

  /* ── what the clients are told ──────────────────────────────────────────
     Never anybody's aim. That is the entire point of the mode: two players
     commit blind, and a state message carrying the other side's arrows would
     hand it to anyone willing to read a websocket frame. */
  publicState() {
    return {
      id: this.id,
      state: this.state,
      turn: this.turn,
      arenaR: Math.round(this.arenaR),
      pieceR: KO.PIECE_R,
      maxPull: KO.MAX_PULL,
      phaseMs: Math.max(0, this.phaseEndsAt - Date.now()),
      aimMs: KO.AIM_MS,
      players: [...this.players.entries()].map(([id, p]) => ({
        id, name: p.name, side: p.side, left: this.piecesOf(id).length,
      })),
      pieces: this.pieces.map(p => ({
        id: p.id, owner: p.owner, x: Math.round(p.x), y: Math.round(p.y), alive: p.alive,
      })),
      /* Who has committed, but NOT what they committed. Worth showing: an
         opponent who has locked in is information you are allowed to have, and
         it is what makes the last few seconds of a turn tense. */
      ready: [...this.ready],
      stake: this.stake,
    };
  }

  broadcast(event, payload) {
    if (this.io && this.io.to) this.io.to(this.socketRoomName).emit(event, payload);
  }
}

module.exports = { KnockoutRoom, KO };
