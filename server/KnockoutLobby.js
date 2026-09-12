'use strict';
/* ─── Getting two players onto a disc ─────────────────────────────────────────
   A queue, the rooms it makes, and an opponent for when nobody else is here.

   THE BOT IS NOT A PLACEHOLDER, and it is named as one on screen. This game has
   no players yet; a queue that can only ever spin is a mode nobody gets to try,
   which is how a new game dies before anyone sees it. So after a few seconds
   alone you are matched with one, and it plays the game properly rather than
   feeding you wins.

   How it plays is the interesting part, and it is constrained by the mode
   itself: it commits blind, at the same moment you do, and it cannot see your
   arrows any more than you can see its. So it cannot aim at where you will be.
   It aims at where you ARE, picks the target that is most worth hitting, and
   misses often enough to be worth beating. Which is what a person does. */

const { KnockoutRoom, KO } = require('./KnockoutRoom');

const BOT_AFTER_MS = 6000;        // how long you wait before one turns up
const BOT_NAMES = ['Sergeant Bot', 'Bishop', 'Cinder', 'Tally', 'Nine'];

class KnockoutLobby {
  constructor(io) {
    this.io = io;
    this.queue = [];              // [{ socket, name, wallet, since }]
    this.rooms = new Map();       // roomId -> KnockoutRoom
    this.bySocket = new Map();    // socketId -> roomId
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 200);
  }
  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  /* ── the queue ──────────────────────────────────────────────────────────── */

  enqueue(socket, name, wallet) {
    this.dequeue(socket.id);
    this.queue.push({ socket, name, wallet, since: Date.now() });
    this.pump();
    return this.queue.some(e => e.socket.id === socket.id);
  }

  dequeue(socketId) {
    const before = this.queue.length;
    this.queue = this.queue.filter(e => e.socket.id !== socketId);
    return this.queue.length !== before;
  }

  queuedFor(socketId) {
    const e = this.queue.find(q => q.socket.id === socketId);
    return e ? Date.now() - e.since : null;
  }

  /* Two waiting? Put them on a disc. A real opponent always beats a bot, so
     this runs before the timer that hands one out. */
  pump() {
    while (this.queue.length >= 2) {
      const a = this.queue.shift(), b = this.queue.shift();
      this.makeMatch([a, b]);
    }
  }

  tick(now) {
    const t = typeof now === 'number' ? now : Date.now();
    for (const e of [...this.queue]) {
      if (t - e.since < BOT_AFTER_MS) continue;
      this.dequeue(e.socket.id);
      this.makeMatch([e], true);
    }
    for (const room of [...this.rooms.values()]) {
      /* Aim BEFORE the clock is advanced, so the bot's arrows are in before the
         tick that resolves them. The other order has it miss a turn every time
         a match is decided on the buzzer. */
      this.botAim(room, t);
      room.tick(t);
      if (room.state === 'over') this.sweep(room);
    }
  }

  makeMatch(entries, withBot) {
    const room = new KnockoutRoom(this.io);
    for (const e of entries) {
      room.addPlayer(e.socket, e.name, e.wallet);
      this.bySocket.set(e.socket.id, room.id);
      e.socket._koRoom = room.id;
    }
    if (withBot) {
      /* A stand-in socket. It joins nothing and receives nothing: the room only
         ever calls .id and .join on it, and a bot has no client to send to. */
      const botSocket = { id: 'bot_' + room.id, join() {}, emit() {} };
      const name = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
      room.addPlayer(botSocket, name, null);
      room.bot = { id: botSocket.id, aimedTurn: 0 };
    }
    this.rooms.set(room.id, room);
    room.start(Date.now());
    return room;
  }

  roomOf(socketId) {
    const id = this.bySocket.get(socketId);
    return id ? this.rooms.get(id) : null;
  }

  leave(socketId) {
    const room = this.roomOf(socketId);
    this.dequeue(socketId);
    if (!room) return;
    room.removePlayer(socketId);
    this.bySocket.delete(socketId);
    this.sweep(room);
  }

  /* A finished or emptied room is dropped, along with the seat reservations
     pointing at it. Without this the map grows for the life of the process and
     a player who finishes a match can never be matched into a new one. */
  sweep(room) {
    const humans = [...room.players.keys()].filter(id => !String(id).startsWith('bot_'));
    if (humans.length && room.state !== 'over') return;
    for (const [sid, rid] of [...this.bySocket]) {
      if (rid === room.id) this.bySocket.delete(sid);
    }
    this.rooms.delete(room.id);
  }

  /* ── the opponent ───────────────────────────────────────────────────────── */

  /* One commitment per turn, made once and then left alone.

     It cannot read your arrows, so it plays the board in front of it: for each
     of its pieces it finds the opponent piece that is cheapest to remove, aims
     THROUGH it at the nearest edge, and throws in enough error to be beatable.
     If one of its own pieces is in real danger it spends that piece's turn
     getting back toward the middle instead, which is the same decision a person
     makes and the reason it does not simply trade itself away. */
  botAim(room, now) {
    if (!room.bot || room.state !== 'aiming') return;
    if (room.bot.aimedTurn === room.turn) return;

    /* It thinks first. Locking in the instant the turn opens is the one thing
       that would give it away every single turn: a person takes a few seconds,
       and "opponent is ready" arriving before you have finished reading the
       board reads as a machine. Long enough to be believable, short enough that
       it is never the thing keeping you waiting. */
    const t = typeof now === 'number' ? now : Date.now();
    if (!room.bot.thinkUntil || room.bot.thinkTurn !== room.turn) {
      room.bot.thinkTurn = room.turn;
      room.bot.thinkUntil = t + 2200 + Math.random() * 3400;
      return;
    }
    if (t < room.bot.thinkUntil) return;
    room.bot.aimedTurn = room.turn;

    const me = room.bot.id;
    const foe = room.opponentOf(me);
    const mine = room.piecesOf(me), theirs = room.piecesOf(foe);
    if (!mine.length) return;

    const aims = [];
    for (const p of mine) {
      const fromRim = room.arenaR - Math.hypot(p.x, p.y);

      /* Close to going off already? Get off the rim. Anything else this turn is
         a trade it is losing. */
      if (fromRim < KO.PIECE_R * 2.2 && Math.hypot(p.x, p.y) > 1) {
        const d = Math.hypot(p.x, p.y);
        const pull = KO.MAX_PULL * (0.34 + Math.random() * 0.16);
        aims.push({ pieceId: p.id, ax: (-p.x / d) * pull, ay: (-p.y / d) * pull });
        continue;
      }

      if (!theirs.length) continue;

      /* The best target is the one nearest the edge and nearest to us: it takes
         the least push to remove and the least travel to reach. */
      let best = null, bestCost = Infinity;
      for (const cand of theirs) {
        const reach = Math.hypot(cand.x - p.x, cand.y - p.y);
        const theirRim = room.arenaR - Math.hypot(cand.x, cand.y);
        const cost = reach * 0.55 + theirRim * 1.5;
        if (cost < bestCost) { bestCost = cost; best = cand; }
      }
      if (!best) continue;

      /* Aim through them toward the outside, so a hit carries them off rather
         than merely into them. */
      const tr = Math.hypot(best.x, best.y) || 1;
      const outx = best.x / tr, outy = best.y / tr;
      const aimX = best.x + outx * KO.PIECE_R * 1.4;
      const aimY = best.y + outy * KO.PIECE_R * 1.4;

      let dx = aimX - p.x, dy = aimY - p.y;
      const dist = Math.hypot(dx, dy) || 1;

      /* Never exact. A bot that cannot miss is not an opponent, it is a wall.
         The error is angular and scales with distance, which is how a human
         misses too: long shots go wide, short ones rarely do. */
      const spread = 0.055 + Math.min(0.12, dist / 4200);
      const a = Math.atan2(dy, dx) + (Math.random() * 2 - 1) * spread;

      /* Enough power to arrive with something left, and a little more the
         further it has to go. Capped, and jittered so it is not a formula. */
      const want = Math.min(1, 0.5 + dist / (KO.MAX_SPEED * 0.62));
      const pull = KO.MAX_PULL * Math.max(0.3, Math.min(1, want * (0.88 + Math.random() * 0.24)));
      aims.push({ pieceId: p.id, ax: Math.cos(a) * pull, ay: Math.sin(a) * pull });
    }

    if (aims.length) room.submitAim(me, aims);
    room.lockIn(me);
  }
}

module.exports = { KnockoutLobby, BOT_AFTER_MS };
