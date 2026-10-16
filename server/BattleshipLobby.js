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
const { refundBound } = require('./stakeRules');

/* HOW LONG A REAL PERSON GETS TO TURN UP.

   Six seconds, which is what this was, sounds like plenty and is not. Owen and
   a friend pressed Play "at the same time" and both ended up against bots:
   between opening the page, the socket connecting and the widget settling,
   two people clicking together land in the queue several seconds apart, and
   whoever got there first was already in a bot match before the second arrived.

   Fifteen is long enough for two people coordinating over a phone call and
   still short enough that somebody alone is not left staring. It matters less
   than it looks, because a second person arriving inside the first minute now
   pulls the first out of their bot match anyway — see rescueFromBot. */
const BOT_AFTER_MS = 15000;        // how long you wait before one turns up on a FREE table
const PAID_WAIT_MS = 60000;       // and how long a paid seat waits for a person
const BOT_THINK_MS = 1100;        // it does not answer instantly
const BOT_PLACE_MS = 2500;        // nor lay its fleet out the moment the match opens

const BOT_NAMES = ['Commodore Bot', 'Halsey', 'Nimitz', 'Rickover', 'Hopper'];

/* Watching, the same rules as the Knockout lobby: a cap per match, a short
   string for the match being moved on from, and the number on the end of a
   room id as the order the matches were made in. */
const WATCH_CAP = 50;
const watchAfter = (v) => (typeof v === 'string' && v.length > 0 && v.length <= 40 ? v : null);
const seqOf = (id) => {
  const m = /(\d+)$/.exec(String(id || ''));
  return m ? Number(m[1]) : NaN;
};
function send(socket, ev, payload) {
  try { if (socket && typeof socket.emit === 'function') socket.emit(ev, payload); } catch (_) {}
}

class BattleshipLobby {
  constructor(io) {
    this.io = io;
    this.queue = [];
    this.rooms = new Map();
    this.bySocket = new Map();
    /* socketId -> { socket, roomId, channel }: watching, not playing. See watch(). */
    this.watchers = new Map();
    this.liveKey = '';
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 200);
  }
  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  /* ── the queue ──────────────────────────────────────────────────────────── */

  /* paid: what landed on-chain for this seat (the entry token's paid), which bounds a refund.
     skin: the bought skin this seat wears, already proved against the skin pass by the caller; null is the free look. */
  enqueue(socket, name, wallet, stake, worth, paid, skin) {
    this.dequeue(socket.id);
    this.unwatch(socket.id);          // watching and queueing are one or the other
    this.queue.push({
      socket, name, wallet, since: Date.now(),
      stake: Number(stake) > 0 ? Number(stake) : 0,
      worth: Number(worth) > 0 ? Number(worth) : 0,
      paid: Number(paid) > 0 ? Number(paid) : undefined,
      skin: typeof skin === 'string' && skin ? skin : null,
    });
    this.pump();
    /* Still waiting after that? Somebody may be in a bot match that has only
       just started, and two people beats two bots. */
    const mine = this.queue.find(e => e.socket.id === socket.id);
    if (mine) {
      const freed = this.rescueFromBot(mine);
      if (freed) {
        this.dequeue(socket.id);
        const room = this.makeMatch([freed, mine]);
        this.moveWatchers(freed.fromRoom, room);    // the bot match's watchers follow the person
      }
    }
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
    /* PAIR PEOPLE FIRST, EVERY TICK. The loop below hands out one bot per
       waiting seat, so two people who were both in the queue when the timer
       came round got a bot each instead of getting each other. pump() only ran
       on enqueue, which is exactly the moment the second of them was not there
       yet. */
    this.pump();
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
    this.tickWatchers();
  }

  /* SOMEBODY WAITING BEATS A BOT, EVEN A LITTLE LATE.

     With two people on the whole game, the common case is a friend arriving
     twenty seconds after you did — by which time you are in a bot match and
     they get one of their own, and the two of you sit in separate rooms playing
     machines. So a human joining the queue looks for another human in a bot
     match that has barely begun, dissolves it, and takes them along.

     Only while it has barely begun. Pulling somebody out of a match they are
     three turns into is worse than the problem: they lose a position they have
     been working on, to be handed an opponent they did not ask for. */
  rescueFromBot(entry) {
    if (!entry || entry.stake > 0) return null;        // paid tables never had a bot
    for (const room of this.rooms.values()) {
      if (!room.bot) continue;
      if (room.stake > 0) continue;
      const early = room.state === 'placing' || room.state === 'countdown';
      if (!early) continue;
      const human = [...room.players.keys()].find(id => !String(id).startsWith('bot_'));
      if (!human || human === entry.socket.id) continue;
      const seat = room.players.get(human);
      if (!seat || !seat.socket) continue;

      /* Take the room away without finishing it: finish() would broadcast a
         result for a match that is not over and did not happen. */
      this.rooms.delete(room.id);
      for (const [sid, rid] of [...this.bySocket]) {
        if (rid === room.id) this.bySocket.delete(sid);
      }
      console.log('[BS] pairing ' + seat.name + ' with ' + entry.name
        + ' instead of a bot');
      return { socket: seat.socket, name: seat.name, wallet: seat.wallet,
               since: Date.now(), stake: 0, worth: 0, fromRoom: room.id, skin: seat.skin || null };
    }
    return null;
  }

  makeMatch(entries, withBot) {
    const room = new BattleshipRoom(this.io);
    room.stake = entries.length ? (entries[0].stake || 0) : 0;
    room.onSettled = this.onSettled || null;
    for (const e of entries) {
      room.addPlayer(e.socket, e.name, e.wallet, e.worth, e.paid, e.skin);
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
      try { this.onRefund({ wallet: entry.wallet, name: entry.name, amount: refundBound(entry.worth, entry.paid), why: why || '' }); }
      catch (e) { console.error('[BS] refund hook failed:', e.message); }
    }
  }

  leave(socketId) {
    this.unwatch(socketId);
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
    this.dropWatchers(room);
    this.rooms.delete(room.id);
  }

  /* ── watching ─────────────────────────────────────────────────────────────
     Somebody with no seat looking at a match already under way. The same
     arrangement as the Knockout lobby, for the same reasons, and here it
     matters more: this game is ONE secret, and a watcher is a third person who
     must learn it no sooner than the players do.

     A watcher is never in the queue, a room's players or bySocket, so nothing
     that counts people or moves money can see one. They are in a socket.io room
     of their own (room.watchRoomName), sent BattleshipRoom.spectatorView and
     never viewFor: both boards as shots and sunk ships only, and both fleets in
     full only in the result, when the players get them too. */

  runningRooms() {
    return [...this.rooms.values()].filter(r => r.state !== 'waiting' && r.state !== 'over');
  }

  /* Best first. Moving on from `after`: the next match made after it, round to
     the start, and `after` itself last so a Next with one match running stays
     put. Arriving fresh: the one furthest in. A match already settling goes to
     the back either way: it is three seconds from its result. */
  watchOrder(live, after) {
    let order;
    const n = seqOf(after);
    if (after && Number.isFinite(n)) {
      const others = live.filter(r => r.id !== after);
      const later = others.filter(r => seqOf(r.id) > n);
      const earlier = others.filter(r => !(seqOf(r.id) > n));
      order = later.concat(earlier, live.filter(r => r.id === after));
    } else {
      const stage = { placing: 0, countdown: 1, playing: 2, settling: 2 };
      const rank = (r) => (stage[r.state] || 0) * 1000 + (r.shotLog ? r.shotLog.length : 0);
      order = live.slice().sort((a, b) => rank(b) - rank(a));
    }
    return order.filter(r => r.state !== 'settling').concat(order.filter(r => r.state === 'settling'));
  }

  matchCard(room, live) {
    const list = live || this.runningRooms();
    return {
      id: room.id, names: room.sideNames(), stake: room.stake, pot: room.pot(),
      turn: room.state === 'playing' ? room.sideOf(room.turn) : null,
      index: list.indexOf(room) + 1, count: list.length,
    };
  }

  /* Watch a running match. Answers on 'bs:watching', always, with one of
     { match, state } (state is spectatorView), { none: true }, { full: true },
     or { refused: true } for a socket that is queued or seated. */
  watch(socket, opts) {
    if (!socket || typeof socket.id !== 'string') return { ok: false, why: 'no socket' };
    const id = socket.id;
    if (this.bySocket.has(id) || this.queue.some(e => e.socket.id === id)) {
      send(socket, 'bs:watching', { refused: true, why: 'You are in a match already.' });
      return { ok: false, why: 'seated' };
    }
    const after = watchAfter(opts && opts.after);
    this.unwatch(id);
    /* opts.stake (the lobby's Spectate on a buy-in, Owen 2026-10-15): only
       tables at that stake, Free or paid. Without one, every table as before.
       What a watcher is sent does not change with the stake. */
    const stake = typeof (opts && opts.stake) === 'number' && Number.isFinite(opts.stake) ? opts.stake : null;
    const live = this.runningRooms().filter(r => stake === null || Math.abs(Number(r.stake) - stake) < 1e-9);
    if (!live.length) { send(socket, 'bs:watching', { none: true }); return { ok: false, why: 'none' }; }
    const room = this.watchOrder(live, after).find(r => (r.watchers || 0) < WATCH_CAP);
    if (!room) { send(socket, 'bs:watching', { full: true }); return { ok: false, why: 'full' }; }
    this.attachWatcher(socket, room, live);
    return { ok: true, roomId: room.id };
  }

  attachWatcher(socket, room, live) {
    this.watchers.set(socket.id, { socket, roomId: room.id, channel: room.watchRoomName });
    room.watchers = (room.watchers || 0) + 1;
    try { if (typeof socket.join === 'function') socket.join(room.watchRoomName); } catch (_) {}
    send(socket, 'bs:watching', { match: this.matchCard(room, live), state: room.spectatorView() });
  }

  unwatch(socketId) {
    const w = this.watchers.get(socketId);
    if (!w) return false;
    this.watchers.delete(socketId);
    const room = this.rooms.get(w.roomId);
    if (room && room.watchers > 0) room.watchers--;
    try { if (w.socket && typeof w.socket.leave === 'function') w.socket.leave(w.channel); } catch (_) {}
    return true;
  }

  moveWatchers(fromId, room) {
    if (!fromId || !room) return;
    let live = null;
    for (const [sid, w] of [...this.watchers]) {
      if (w.roomId !== fromId) continue;
      this.unwatch(sid);
      if ((room.watchers || 0) >= WATCH_CAP) { send(w.socket, 'bs:ended', { id: fromId }); continue; }
      if (!live) live = this.runningRooms();
      this.attachWatcher(w.socket, room, live);
    }
  }

  dropWatchers(room) {
    for (const [sid, w] of [...this.watchers]) {
      if (w.roomId !== room.id) continue;
      if (room.state !== 'over') send(w.socket, 'bs:ended', { id: room.id });
      this.unwatch(sid);
    }
  }

  tickWatchers() {
    if (!this.watchers.size) { this.liveKey = ''; return; }
    for (const [sid, w] of [...this.watchers]) {
      if (this.rooms.has(w.roomId)) continue;
      send(w.socket, 'bs:ended', { id: w.roomId });
      this.unwatch(sid);
    }
    const live = this.runningRooms();
    const key = live.map(r => r.id).join(',');
    if (key === this.liveKey) return;
    this.liveKey = key;
    for (const r of live) {
      if (!(r.watchers > 0) || !this.io || !this.io.to) continue;
      try {
        this.io.to(r.watchRoomName).emit('bs:matches', { index: live.indexOf(r) + 1, count: live.length });
      } catch (_) {}
    }
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
BattleshipLobby.WATCH_CAP = WATCH_CAP;

module.exports = { BattleshipLobby, BOT_AFTER_MS, PAID_WAIT_MS, WATCH_CAP, cellAt };
