'use strict';
/* ─── Getting two tanks into a room ───────────────────────────────────────────
   A queue, the rooms it creates, and an opponent for when nobody else is here.

   THE BOT IS NOT A PLACEHOLDER. A duel needs two people, and this game has none
   yet — a queue that can only ever spin is a game nobody can try, which is how a
   new mode dies before anybody sees it. So after a few seconds alone you are
   matched with one, it is named as one on screen, and it plays properly rather
   than missing on purpose.

   How it plays is the interesting part. It does what a person does: fire, see
   where that landed, and correct. It does not compute the exact solution — that
   is trivial with a closed-form trajectory and would make it unbeatable and
   joyless. It walks its shots in, and it is allowed to keep missing. */

const { TanksRoom, TANKS } = require('./TanksRoom');

const BOT_AFTER_MS = 8000;        // how long you wait before one turns up
const BOT_THINK_MS = 1400;        // it does not answer instantly

class TanksLobby {
  constructor(io) {
    this.io = io;
    this.queue = [];              // [{ socket, name, wallet, since }]
    this.rooms = new Map();       // roomId -> TanksRoom
    this.bySocket = new Map();    // socketId -> roomId
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 500);
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

  /* Two waiting? Put them in a room. */
  pump() {
    while (this.queue.length >= 2) {
      const a = this.queue.shift(), b = this.queue.shift();
      this.makeMatch([a, b]);
    }
  }

  tick() {
    // Anybody who has waited long enough gets a bot rather than a spinner.
    const now = Date.now();
    for (const e of [...this.queue]) {
      if (now - e.since < BOT_AFTER_MS) continue;
      this.dequeue(e.socket.id);
      this.makeMatch([e], true);
    }
    for (const room of this.rooms.values()) {
      room.tick();
      this.botTurn(room);
    }
  }

  makeMatch(entries, withBot) {
    const room = new TanksRoom(this.io);
    for (const e of entries) {
      room.addPlayer(e.socket, e.name, e.wallet);
      this.bySocket.set(e.socket.id, room.id);
      e.socket._tanksRoom = room.id;
    }
    if (withBot) {
      /* A stand-in socket. It joins nothing and receives nothing — the room only
         ever calls .id and .join on it, and a bot has no client to send to. */
      const botSocket = { id: 'bot_' + room.id, join() {}, emit() {} };
      room.addPlayer(botSocket, 'Sergeant Bot', null);
      room.bot = { id: botSocket.id, lastError: null, thinkAt: 0 };
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
    // Once nobody human is left, the room goes.
    const humans = [...room.players.keys()].filter(id => !String(id).startsWith('bot_'));
    if (!humans.length) this.rooms.delete(room.id);
  }

  /* ── the opponent ───────────────────────────────────────────────────────── */

  /* Fire when it is the bot's turn and it has had a moment to think.

     The aim is deliberately imperfect and deliberately IMPROVES. A first shot is
     a guess with a wide error; each subsequent one corrects toward where the
     last landed, the way a person ranges in. That makes an opening exchange
     survivable and a long game dangerous, which is the shape an artillery duel
     should have. */
  botTurn(room) {
    if (!room.bot || room.state !== 'playing') return;
    if (room.turn !== room.bot.id) { room.bot.thinkAt = 0; return; }
    if (!room.bot.thinkAt) { room.bot.thinkAt = Date.now() + BOT_THINK_MS; return; }
    if (Date.now() < room.bot.thinkAt) return;
    room.bot.thinkAt = 0;

    const me = room.players.get(room.bot.id);
    const foe = room.opponentOf(room.bot.id);
    if (!me || !foe) return;

    const dx = foe.x - me.x;
    const dir = dx >= 0 ? 1 : -1;
    /* Start from the textbook 45 degrees and solve for the power that would
       carry the horizontal distance with no wind, then spoil it. */
    const angle = dir > 0 ? 45 : 135;
    const range = Math.abs(dx);
    const g = TANKS.GRAVITY;
    // range = v^2 * sin(2*45) / g  ->  v = sqrt(range * g)
    const ideal = Math.sqrt(Math.max(1, range * g)) / TANKS.POWER_SCALE;

    let power = ideal;
    if (room.bot.lastError !== null) {
      // Correct toward the last miss, but only most of the way.
      power = room.bot.lastPower * (1 - 0.55 * (room.bot.lastError / Math.max(range, 1)));
    }
    // And never perfectly: a bot that cannot miss is not an opponent, it is a wall.
    const spoil = 1 + (Math.random() * 2 - 1) * 0.10;
    power = Math.max(TANKS.POWER_MIN, Math.min(TANKS.POWER_MAX, power * spoil));

    const shot = room.fire(room.bot.id, angle, power);
    if (!shot.ok) return;
    room.bot.lastPower = power;
    room.bot.lastError = (shot.result.hit.x - foe.x) * dir;   // + means it went long
    room.broadcast('tanks:shot', shot.result);
  }
}

module.exports = { TanksLobby, BOT_AFTER_MS };
