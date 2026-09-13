'use strict';
/* ─── Getting two fleets onto the water ───────────────────────────────────────
   The queue, the rooms it makes, and an opponent for when nobody else is here.
   Same shape as the Knockout lobby, and deliberately so: a paid table works the
   same way in every game on this product or it does not work at all.

   PAID TABLES NEVER SEAT A BOT, for the same reason as there. A bot has no
   wallet and stakes nothing, so a paid match against one either pays out of an
   escrow nobody paid into or takes a real buy-in for a machine. A paid seat
   waits for a person, and gets its money back if none comes.

   THE OPPONENT ITSELF is the interesting part here. Battleship has a known best
   way to play and it is not close: hunt on a parity lattice until something is
   hit, then work outwards from the hit until the ship is sunk. That is what a
   good human does, and it is what this does, with enough left on the table to
   be beaten — it does not weight by remaining ship sizes, which is the trick
   that makes a solver nearly unbeatable and a game joyless. */

const { BattleshipRoom, BS } = require('./BattleshipRoom');

const BOT_AFTER_MS = 6000;        // how long you wait before one turns up on a FREE table
const PAID_WAIT_MS = 60000;       // and how long a paid seat waits for a person
const BOT_THINK_MS = 1100;        // it does not answer instantly
const BOT_PLACE_MS = 2500;        // nor lay its fleet out the moment the match opens

const BOT_NAMES = ['Commodore Bot', 'Halsey', 'Nimitz', 'Rickover', 'Hopper'];

class BattleshipLobby {
  constructor(io) {
    this.io = io;
    this.queue = [];
    this.rooms = new Map();
    this.bySocket = new Map();
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 200);
  }
  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  /* ── the queue ──────────────────────────────────────────────────────────── */

  enqueue(socket, name, wallet, stake, worth) {
    this.dequeue(socket.id);
    this.queue.push({
      socket, name, wallet, since: Date.now(),
      stake: Number(stake) > 0 ? Number(stake) : 0,
      worth: Number(worth) > 0 ? Number(worth) : 0,
    });
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

  /* Matched by RUNG. Two seats that paid different amounts have no honest way
     to split a pot. */
  pump() {
    const byStake = new Map();
    for (const e of this.queue) {
      const k = String(e.stake || 0);
      if (!byStake.has(k)) byStake.set(k, []);
      byStake.get(k).push(e);
    }
    for (const group of byStake.values()) {
      while (group.length >= 2) {
        const a = group.shift(), b = group.shift();
        this.dequeue(a.socket.id); this.dequeue(b.socket.id);
        this.makeMatch([a, b]);
      }
    }
  }

  tick(now) {
    const t = typeof now === 'number' ? now : Date.now();
    for (const e of [...this.queue]) {
      if (e.stake > 0) {
        if (t - e.since < PAID_WAIT_MS) continue;
        this.dequeue(e.socket.id);
        this.refund(e, 'nobody joined that table');
        continue;
      }
      if (t - e.since < BOT_AFTER_MS) continue;
      this.dequeue(e.socket.id);
      this.makeMatch([e], true);
    }
    for (const room of [...this.rooms.values()]) {
      this.botTurn(room, t);
      room.tick(t);
      if (room.state === 'over') this.sweep(room);
    }
  }

  makeMatch(entries, withBot) {
    const room = new BattleshipRoom(this.io);
    room.stake = entries.length ? (entries[0].stake || 0) : 0;
    room.onSettled = this.onSettled || null;
    for (const e of entries) {
      room.addPlayer(e.socket, e.name, e.wallet, e.worth);
      this.bySocket.set(e.socket.id, room.id);
      e.socket._bsRoom = room.id;
    }
    /* The one line between a real buy-in and an opponent that cannot cover it. */
    if (withBot && room.stake > 0) withBot = false;
    if (withBot) {
      const botSocket = { id: 'bot_' + room.id, join() {}, emit() {} };
      const name = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
      room.addPlayer(botSocket, name, null, 0);
      room.bot = {
        id: botSocket.id,
        placeAt: 0, thinkAt: 0,
        /* What it knows about YOUR board: hits it has landed that belong to a
           ship still afloat, and the squares it has already tried. */
        targets: [], tried: new Set(), hits: [],
      };
    }
    this.rooms.set(room.id, room);
    room.start(Date.now());
    return room;
  }

  roomOf(socketId) {
    const id = this.bySocket.get(socketId);
    return id ? this.rooms.get(id) : null;
  }

  refund(entry, why) {
    if (!entry || entry.refunded) return;
    entry.refunded = true;
    try { entry.socket.emit('bs:unqueued', { refunded: entry.worth > 0, why: why || '' }); } catch (_) {}
    if (entry.worth > 0 && typeof this.onRefund === 'function') {
      try { this.onRefund({ wallet: entry.wallet, name: entry.name, amount: entry.worth, why: why || '' }); }
      catch (e) { console.error('[BS] refund hook failed:', e.message); }
    }
  }

  leave(socketId) {
    const room = this.roomOf(socketId);
    const waiting = this.queue.find(e => e.socket.id === socketId);
    if (waiting) this.refund(waiting, 'left the queue');
    this.dequeue(socketId);
    if (!room) return;
    room.removePlayer(socketId);
    this.bySocket.delete(socketId);
    this.sweep(room);
  }

  sweep(room) {
    const humans = [...room.players.keys()].filter(id => !String(id).startsWith('bot_'));
    if (humans.length && room.state !== 'over') return;
    for (const [sid, rid] of [...this.bySocket]) if (rid === room.id) this.bySocket.delete(sid);
    this.rooms.delete(room.id);
  }

  /* ── the opponent ───────────────────────────────────────────────────────── */

  botTurn(room, now) {
    if (!room.bot) return;
    const t = typeof now === 'number' ? now : Date.now();

    /* It lays its fleet out after a beat, not the instant the match opens. */
    if (room.state === 'placing') {
      const board = room.boards.get(room.bot.id);
      if (board && !board.placed) {
        if (!room.bot.placeAt) { room.bot.placeAt = t + BOT_PLACE_MS; return; }
        if (t < room.bot.placeAt) return;
        board.placeRandom();
        room.sendState();
      }
      return;
    }

    if (room.state !== 'playing' || room.turn !== room.bot.id) { room.bot.thinkAt = 0; return; }
    if (!room.bot.thinkAt) { room.bot.thinkAt = t + BOT_THINK_MS; return; }
    if (t < room.bot.thinkAt) return;
    room.bot.thinkAt = 0;

    const cell = this.botPick(room);
    if (cell === null) return;
    const res = room.fire(room.bot.id, cell, t);
    if (!res || !res.ok) return;
    this.botLearn(room, cell, res.result);
  }

  /* WHERE IT SHOOTS.

     With something wounded, finish it: work along the line if two hits already
     line up, otherwise try the four squares around the hit. With nothing
     wounded, hunt on a parity lattice — the smallest ship is two squares, so
     every ship must touch a square where (x+y) is even, and checking the other
     half of the board first is wasted breath. */
  botPick(room) {
    const foe = room.opponentOf(room.bot.id);
    const board = room.boards.get(foe);
    if (!board) return null;
    const free = (c) => c >= 0 && c < BS.CELLS && !board.shotsAt.has(c);

    /* Nulls can reach this list: cellAt returns one for a square off the edge,
       and a wounded ship next to a wall produces exactly that. A null here
       would be fired as a shot and refused, wasting the turn. */
    while (room.bot.targets.length) {
      const c = room.bot.targets.shift();
      if (c !== null && free(c)) return c;
    }

    const open = [];
    const parity = [];
    for (let c = 0; c < BS.CELLS; c++) {
      if (!free(c)) continue;
      open.push(c);
      const x = c % BS.GRID, y = Math.floor(c / BS.GRID);
      if ((x + y) % 2 === 0) parity.push(c);
    }
    const pool = parity.length ? parity : open;
    if (!pool.length) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /* What that shot taught it. */
  botLearn(room, cell, result) {
    const b = room.bot;
    if (!result || !result.hit) return;

    if (result.sunk) {
      /* Done with that one. Anything it was chasing that belonged to the sunk
         ship is dropped, so it does not keep poking at a wreck. */
      const gone = new Set(result.sunk.cells);
      b.hits = b.hits.filter(c => !gone.has(c));
      b.targets = b.targets.filter(c => !gone.has(c));
      /* Whatever is left in hits belongs to something still afloat, so pick
         that trail back up rather than going back to hunting. */
      for (const h of b.hits) this.pushNeighbours(b, h);
      return;
    }

    b.hits.push(cell);
    const x = cell % BS.GRID, y = Math.floor(cell / BS.GRID);

    /* Two hits in a line say which way the ship runs, so try the ends of that
       line before anything else. That is the difference between finishing a
       carrier in five shots and in fifteen. */
    const inLine = b.hits.filter(c => (c % BS.GRID === x) || (Math.floor(c / BS.GRID) === y));
    const sameRow = inLine.filter(c => Math.floor(c / BS.GRID) === y);
    const sameCol = inLine.filter(c => c % BS.GRID === x);

    if (sameRow.length >= 2) {
      const xs = sameRow.map(c => c % BS.GRID).sort((a, c) => a - c);
      pushFirst(b, [cellAt(xs[xs.length - 1] + 1, y), cellAt(xs[0] - 1, y)]);
      return;
    }
    if (sameCol.length >= 2) {
      const ys = sameCol.map(c => Math.floor(c / BS.GRID)).sort((a, c) => a - c);
      pushFirst(b, [cellAt(x, ys[ys.length - 1] + 1), cellAt(x, ys[0] - 1)]);
      return;
    }
    this.pushNeighbours(b, cell);
  }

  pushNeighbours(b, cell) {
    const x = cell % BS.GRID, y = Math.floor(cell / BS.GRID);
    for (const c of [cellAt(x + 1, y), cellAt(x - 1, y), cellAt(x, y + 1), cellAt(x, y - 1)]) {
      if (c !== null && !b.targets.includes(c)) b.targets.push(c);
    }
  }
}

/* Null rather than a wrapped index: x = -1 is off the left edge, not the right
   edge of the row above. */
function pushFirst(b, cells) {
  for (const c of cells) if (c !== null && !b.targets.includes(c)) b.targets.unshift(c);
}

function cellAt(x, y) {
  if (x < 0 || y < 0 || x >= BS.GRID || y >= BS.GRID) return null;
  return y * BS.GRID + x;
}

BattleshipLobby.PAID_WAIT_MS = PAID_WAIT_MS;

module.exports = { BattleshipLobby, BOT_AFTER_MS, PAID_WAIT_MS, cellAt };
