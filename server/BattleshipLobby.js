'use strict';
/* ─── Getting two fleets onto the water ───────────────────────────────────────
   The queue, the rooms it makes, and an opponent for when nobody else is here.
   Same shape as the Knockout lobby, and deliberately so: a paid table works the
   same way in every game on this product or it does not work at all.

   PAID TABLES NEVER SEAT A BOT, for the same reason as there. A bot has no
   wallet and stakes nothing, so a paid match against one either pays out of an
   escrow nobody paid into or takes a real buy-in for a machine. A paid seat
   waits for a person, and gets its money back if none comes.

   IT LOOKS LIKE A PLAYER (Owen 2026-10-16): a person's kind of name, an
   arrival after a wait that is never the same twice, a fleet laid and shots
   fired after pauses a person would take, and no tell-tale id in anything a
   client is sent (BattleshipRoom.publicId).

   THE OPPONENT ITSELF is the interesting part here. Battleship has a known best
   way to play and it is not close: hunt on a parity lattice until something is
   hit, then work outwards from the hit until the ship is sunk. That is what a
   good human does, and it is what this does, with enough left on the table to
   be beaten — it does not weight by remaining ship sizes, which is the trick
   that makes a solver nearly unbeatable and a game joyless. */

const { BattleshipRoom, BS } = require('./BattleshipRoom');
const { refundBound } = require('./stakeRules');
const { pickName } = require('./botNames');

/* HOW LONG A REAL PERSON GETS TO TURN UP: a minute, with a countdown, then a
   bot on a free table; a paid seat keeps looking past it (Owen 2026-10-21).
   The rules and why are in server/duelQueue.js, shared with Knockout.
   BOT_AFTER_MS and BOT_AFTER_MIN_MS keep their names and are that minute. */
const duelQueue = require('./duelQueue');
const { FREE_WAIT_MS, PAID_WAIT_MS, PAID_GIVE_UP_MS } = duelQueue;
const BOT_AFTER_MIN_MS = FREE_WAIT_MS;
const BOT_AFTER_MS = FREE_WAIT_MS;

/* HOW LONG IT TAKES, drawn every time. A shot exactly 1.1 s after the turn
   opens, every turn, and a fleet down exactly 2.5 s into the match read as a
   machine. A person takes a second or two a shot, a beat longer after sinking
   something, and somewhere between a few seconds (the Random button) and a
   dozen to lay a fleet out. All of it well inside the ten second shot clock
   and the minute to place, and a fleet is never the thing keeping you waiting
   for long: once your own fleet is down, its remaining wait is cut short. */
const BOT_THINK_MIN_MS = 700;
const BOT_THINK_MAX_MS = 2600;
const BOT_AFTER_SINK_MS = 1500;   // up to this much longer after it sank a ship
const BOT_PLACE_MIN_MS = 3000;
const BOT_PLACE_MAX_MS = 12000;
const BOT_PLACE_CATCH_UP_MS = 2500; // once yours is down: done within half to twice this (drawn)

const between = (lo, hi) => lo + Math.random() * (hi - lo);

/* The stand-in's name: a person's kind of name from the shared pool
   (server/botNames.js), never the name of the person it is playing. It used to
   be one of five, and one of them was "Commodore Bot". */
const BOT_NAME_MAX = 15;
function botNameAgainst(entries) {
  const theirs = new Set(entries.map(e => String((e && e.name) || '').trim().toLowerCase()));
  return pickName(Math.random(), { maxLen: BOT_NAME_MAX, taken: (lc) => theirs.has(lc) });
}

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
    /* The most FREE tables this lobby runs at once: KnockoutLobby.freeRoomCap, the same rule (night review
       2026-10-29). A bot game against a player who never shoots runs for minutes, every table is kept in memory and
       sends reliable bs:state, and a free seat needs no login, so without a ceiling enough sockets queued for free play
       could fill the process every paid game shares. At the ceiling a free pair or a free seat due its bot keeps
       waiting until a table ends. Paid tables are never counted or held. Infinity is the old rule; index.js sets the
       live number. */
    this.freeRoomCap = Infinity;
  }

  /* Free tables still being played (see freeRoomCap). */
  freeRoomsRunning() {
    let n = 0;
    for (const r of this.rooms.values()) if (!(r.stake > 0) && r.state !== 'over') n++;
    return n;
  }

  /* A FREE SEAT THE CEILING HOLDS PAST ITS BOT TIME IS TOLD (KnockoutLobby.noteHeld, night review 2026-10-29): each
     time the countdown it was shown runs out, bs:queued again with a fresh FREE_WAIT_MS on the clock and busy: true.
     Free seats only: a paid seat is never held. */
  noteHeld(e, t) {
    if (!e || e.stake > 0) return;
    if (typeof e.heldNoteAt === 'number' && t - e.heldNoteAt < FREE_WAIT_MS) return;
    e.heldNoteAt = t;
    const waited = Math.max(0, t - e.since);
    send(e.socket, 'bs:queued', {
      waitingMs: waited, stake: 0, worth: 0, resumeKey: e.resumeKey,
      waitMs: waited + FREE_WAIT_MS, botAfterMs: waited + FREE_WAIT_MS, paidWaitMs: 0, busy: true,
    });
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
    /* Already at a table still being played: one seat per socket (KnockoutLobby.enqueue, night review 2026-10-29).
       Each re-queue used to get a bot table of its own and leave the last one running with the socket still seated,
       out of reach of the free seat count and of leave(). Not taken and nothing touched, so a paid caller refunds it
       through the stake row; bs:queue refuses it before this with "in a match already". */
    const seated = this.roomOf(socket.id);
    if (seated && seated.state !== 'over') return false;
    /* Queueing again from a socket that already waits on a PAID seat gives that one back first: dequeue
       alone forgot a stake that had already settled on-chain (Fable review 2026-10-21). */
    const prior = this.queue.find(e => e.socket.id === socket.id);
    if (prior && prior.worth > 0) this.refund(prior, 'left the queue');
    this.dequeue(socket.id);
    // Stopping for a restart (shutdownSettle): nothing new is held, so the caller refunds a paid seat.
    if (this.stopping) return false;
    this.unwatch(socket.id);          // watching and queueing are one or the other
    this.queue.push({
      socket, name, wallet, since: Date.now(), botWait: FREE_WAIT_MS,
      resumeKey: duelQueue.newResumeKey(),   // a reconnect shows it to take this seat back (duelQueue.resumeSeat)
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
        const room = this.startMatch([freed, mine]);
        if (room) this.moveWatchers(freed.fromRoom, room);    // the bot match's watchers follow the person
      }
    }
    /* Taken: waiting, at a table, or (a match that could not start) already refunded by startMatch. Only a
       stopping lobby, or a socket still at a table, says false, having touched nothing, so the caller refunds it
       through the stake row. */
    return true;
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
    if (this.stopping) return;
    // Same rung, two different people (two tabs of one wallet never meet), oldest first.
    for (const [a, b] of duelQueue.pairUp(this.queue)) {
      // A free pair waits while the free tables are full (freeRoomCap); both stay queued, oldest first.
      if (!(a.stake > 0) && this.freeRoomCap < Infinity && this.freeRoomsRunning() >= this.freeRoomCap) continue;
      this.dequeue(a.socket.id); this.dequeue(b.socket.id);
      this.startMatch([a, b]);
    }
  }

  /* A reconnect taking its seat back by the key it was sent (duelQueue.resumeSeat, which asks mayTakeFree before a
     free seat changes socket), and that key. */
  resume(socket, key, mayTakeFree) { return duelQueue.resumeSeat(this, socket, key, mayTakeFree); }
  resumeKeyOf(socketId) {
    const e = this.queue.find(q => q.socket.id === socketId);
    return e ? e.resumeKey : null;
  }

  /* Whether this socket's seat is held anywhere: waiting, or at a table. */
  holds(socketId) {
    return this.queue.some(e => e.socket.id === socketId) || !!this.roomOf(socketId);
  }

  /* Who is waiting at each rung, people only (duelQueue.waitingByRung). */
  waitingByRung() { return duelQueue.waitingByRung(this.queue); }

  /* A restart's owed refunds for every paid seat this process holds (duelQueue.shutdownRows). */
  shutdownSettle(why) { return duelQueue.shutdownRows(this, 'battleship', why); }

  /* makeMatch, and if it throws, nobody is left holding nothing (see KnockoutLobby.startMatch): a seat no
     registered room holds is refunded once, a free one is told the match did not start. */
  startMatch(entries, withBot, now) {
    try {
      return this.makeMatch(entries, withBot, now);
    } catch (err) {
      console.error('[BS] a match could not start: ' + (err && err.stack ? err.stack : err));
      for (const e of entries) {
        if (!e || !e.socket) continue;
        /* A match that did start holds the seat. One registered but never started (start threw) is
           taken down and marked settled, so it can neither pay nor strand the stakes it was given. */
        const rid = this.bySocket.get(e.socket.id);
        const r = rid ? this.rooms.get(rid) : null;
        if (r && r.state !== 'waiting') continue;
        if (r) { r.settled = true; this.rooms.delete(rid); }
        this.bySocket.delete(e.socket.id);
        if (e.worth > 0) this.refund(e, 'the match could not start');
        else send(e.socket, 'bs:unqueued', { refunded: false, why: 'the match could not start' });
      }
      return null;
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
    let free = -1;   // free tables running, counted once a tick and only when a bot is due (freeRoomCap)
    for (const e of [...this.queue]) {
      if (e.stake > 0) {
        // Past its minute it keeps looking (Owen 2026-10-21); only an abandoned seat is given up.
        if (t - e.since < PAID_GIVE_UP_MS) continue;
        this.dequeue(e.socket.id);
        this.refund(e, 'nobody joined that table');
        continue;
      }
      /* The minute set at enqueue; an entry without one (made by hand) waits the same. */
      const wait = typeof e.botWait === 'number' && Number.isFinite(e.botWait) ? e.botWait : BOT_AFTER_MS;
      if (t - e.since < wait) continue;
      if (this.freeRoomCap < Infinity) {
        if (free < 0) free = this.freeRoomsRunning();
        if (free >= this.freeRoomCap) { this.noteHeld(e, t); continue; }   // the free tables are full: it keeps waiting
        free++;
      }
      this.dequeue(e.socket.id);
      this.startMatch([e], true, t);
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

  makeMatch(entries, withBot, now) {
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
      const name = botNameAgainst(entries);
      room.addPlayer(botSocket, name, null, 0);
      room.bot = {
        id: botSocket.id,
        placeAt: 0, thinkAt: 0, sankLast: false,
        /* What it knows about YOUR board: hits it has landed that belong to a
           ship still afloat, and the squares it has already tried. */
        targets: [], tried: new Set(), hits: [],
      };
    }
    this.rooms.set(room.id, room);
    /* The lobby's clock, as in KnockoutLobby.makeMatch: a bot match made on tick(t) is stamped t, so a
       test driving a timeline (or a stall between two clock reads) cannot age its minute to place. */
    room.start(typeof now === 'number' ? now : Date.now());
    return room;
  }

  roomOf(socketId) {
    const id = this.bySocket.get(socketId);
    return id ? this.rooms.get(id) : null;
  }

  refund(entry, why) {
    if (!entry || entry.refunded) return;
    entry.refunded = true;
    duelQueue.noteRefund(this, entry);   // so a late reconnect is told where the money went
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
     put. `dir` 'prev' is the same walk the other way: the one made just before
     it, round to the end. Arriving fresh: the one furthest in. A match already
     settling goes to the back either way: it is three seconds from its result. */
  watchOrder(live, after, dir) {
    let order;
    const n = seqOf(after);
    if (after && Number.isFinite(n)) {
      const others = live.filter(r => r.id !== after);
      if (dir === 'prev') {
        const before = others.filter(r => seqOf(r.id) < n).reverse();
        const rest = others.filter(r => !(seqOf(r.id) < n)).reverse();
        order = before.concat(rest, live.filter(r => r.id === after));
      } else {
        const later = others.filter(r => seqOf(r.id) > n);
        const earlier = others.filter(r => !(seqOf(r.id) > n));
        order = later.concat(earlier, live.filter(r => r.id === after));
      }
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

  /* Watch a running match. opts.after is the match being moved on from and
     opts.dir 'prev' moves back from it instead of on (the Previous button of
     the shared Spectate bar). Answers on 'bs:watching', always, with one of
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
    const room = this.watchOrder(live, after, opts && opts.dir === 'prev' ? 'prev' : 'next')
      .find(r => (r.watchers || 0) < WATCH_CAP);
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

    /* It lays its fleet out after a while, not the instant the match opens. */
    if (room.state === 'placing') {
      const board = room.boards.get(room.bot.id);
      if (board && !board.placed) {
        if (!room.bot.placeAt) { room.bot.placeAt = t + between(BOT_PLACE_MIN_MS, BOT_PLACE_MAX_MS); return; }
        /* Yours is down: it finishes soon after rather than leaving you waiting. */
        const foe = room.boards.get(room.opponentOf(room.bot.id));
        if (foe && foe.placed && !room.bot.caughtUp) {
          room.bot.caughtUp = true;
          const soon = t + between(BOT_PLACE_CATCH_UP_MS / 2, BOT_PLACE_CATCH_UP_MS * 2);
          if (soon < room.bot.placeAt) room.bot.placeAt = soon;
        }
        if (t < room.bot.placeAt) return;
        board.placeRandom();
        room.sendState();
      }
      return;
    }

    if (room.state !== 'playing' || room.turn !== room.bot.id) { room.bot.thinkAt = 0; return; }
    if (!room.bot.thinkAt) {
      room.bot.thinkAt = t + between(BOT_THINK_MIN_MS, BOT_THINK_MAX_MS)
        + (room.bot.sankLast ? Math.random() * BOT_AFTER_SINK_MS : 0);
      return;
    }
    if (t < room.bot.thinkAt) return;
    room.bot.thinkAt = 0;

    const cell = this.botPick(room);
    if (cell === null) return;
    const res = room.fire(room.bot.id, cell, t);
    if (!res || !res.ok) return;
    room.bot.sankLast = !!(res.result && res.result.sunk);
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
BattleshipLobby.FREE_WAIT_MS = FREE_WAIT_MS;
BattleshipLobby.WATCH_CAP = WATCH_CAP;

module.exports = {
  BattleshipLobby, BOT_AFTER_MS, BOT_AFTER_MIN_MS, PAID_WAIT_MS, PAID_GIVE_UP_MS, FREE_WAIT_MS, WATCH_CAP, cellAt,
  BOT_THINK_MIN_MS, BOT_THINK_MAX_MS, BOT_AFTER_SINK_MS, BOT_PLACE_MIN_MS, BOT_PLACE_MAX_MS,
};
