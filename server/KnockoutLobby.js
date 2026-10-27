'use strict';
/* ─── Getting two players onto a disc ─────────────────────────────────────────
   A queue, the rooms it makes, and an opponent for when nobody else is here.

   THE BOT IS NOT A PLACEHOLDER. This game has no players yet; a queue that can
   only ever spin is a mode nobody gets to try, which is how a new game dies
   before anyone sees it. So after a few seconds alone you are matched with one,
   and it plays the game properly rather than feeding you wins. It looks like a
   player too (Owen 2026-10-16): a person's kind of name, an arrival after a
   wait that is never the same twice, "They are ready" when it locks in, and no
   tell-tale id on the wire (KnockoutRoom.publicId). Free tables only, always.

   How it plays is the interesting part, and it is constrained by the mode
   itself: it commits blind, at the same moment you do, and it cannot see your
   arrows any more than you can see its. So it cannot aim at where you will be.
   It aims at where you ARE, picks the target that is most worth hitting, and
   misses often enough to be worth beating. Which is what a person does. */

const { KnockoutRoom, KO } = require('./KnockoutRoom');
const { refundBound } = require('./stakeRules');
const { pickName } = require('./botNames');

/* HOW LONG A REAL PERSON GETS TO TURN UP: a minute, with a countdown, and then
   a bot on a free table (Owen 2026-10-21). The wait used to be a random 9 to 22
   seconds, and two people who queued 35 s apart each got a bot of their own;
   the reasons and the rules are in server/duelQueue.js, shared with
   Battleship. BOT_AFTER_MS and BOT_AFTER_MIN_MS keep their names and are the
   same minute now: a bot that is announced has no reason to arrive on a
   random beat.

   PAID TABLES NEVER GET A BOT. The bot has no wallet and stakes nothing. Put a
   dollar in against it and either you win a dollar out of escrow that nobody
   paid in, or you lose a dollar to a machine, which is the house booking a
   wager. So a paid seat waits for a person, past its minute, until it is
   cancelled (an instant refund) or left so long that it is handed back anyway
   (PAID_GIVE_UP_MS). */
const duelQueue = require('./duelQueue');
const { FREE_WAIT_MS, PAID_WAIT_MS, PAID_GIVE_UP_MS } = duelQueue;
const BOT_AFTER_MIN_MS = FREE_WAIT_MS;
const BOT_AFTER_MS = FREE_WAIT_MS;

/* HOW FAR THIS PIECE CAN GO BEFORE THE EDGE, along the line it is about to be
   fired down. Ray against circle, solved for the positive root.

   This exists because the first bot did not have it, and measured, 87% of every
   piece lost in a bot-vs-bot match was a piece that had fired ITSELF off the
   disc — against zero knocked off by an opponent. It was not playing the game,
   it was falling over, and a player would have won every match without aiming. */
function rimDistance(px, py, ux, uy, R) {
  const b = px * ux + py * uy;
  const c = px * px + py * py - R * R;
  const disc = b * b - c;
  if (disc <= 0) return 0;
  return Math.max(0, -b + Math.sqrt(disc));
}

/* The pull that carries a piece exactly `dist` and no further. Travel under
   exponential drag settles at v/DRAG, so this inverts that. */
function pullForTravel(dist) {
  const speed = Math.max(0, dist) * KO.DRAG_PER_S;
  return KO.MAX_PULL * Math.min(1, speed / KO.MAX_SPEED);
}
/* The stand-in's name: a person's kind of name from the shared pool
   (server/botNames.js, the one the slither.io and agar.io bots use), never the
   name of the person it is sitting down against. It used to be one of five,
   and one of the five was "Sergeant Bot". */
const BOT_NAME_MAX = 15;
function botNameAgainst(entries) {
  const theirs = new Set(entries.map(e => String((e && e.name) || '').trim().toLowerCase()));
  return pickName(Math.random(), { maxLen: BOT_NAME_MAX, taken: (lc) => theirs.has(lc) });
}

/* How long a free seat waits for its bot: the minute its countdown shows. */
function botWait() {
  return FREE_WAIT_MS;
}

/* How many people can watch one match. Each watcher is one more copy of every
   message the match sends, so a number has to exist; fifty is far more than
   this game will see and far fewer than would cost anything. */
const WATCH_CAP = 50;

/* The match id a watcher names as the one they are moving on from. Only ever a
   short string; it is looked up, never trusted, and anything else is ignored. */
const watchAfter = (v) => (typeof v === 'string' && v.length > 0 && v.length <= 40 ? v : null);

/* The number on the end of a room id ('ko_12' is 12), which is the order the
   rooms were made in. Used to step to the NEXT match even when the one being
   left has already been swept away and is no longer there to be found. */
const seqOf = (id) => {
  const m = /(\d+)$/.exec(String(id || ''));
  return m ? Number(m[1]) : NaN;
};

function send(socket, ev, payload) {
  try { if (socket && typeof socket.emit === 'function') socket.emit(ev, payload); } catch (_) {}
}

class KnockoutLobby {
  /* opts lets another real-time duel (Head Soccer, server/HeadSoccerLobby.js) run on this same queue, refund and
     watch code rather than a copy of it: its own event prefix, game name for restart refunds, log tag and room
     class. Knockout passes nothing and is exactly what it was. */
  constructor(io, opts) {
    const o = opts || {};
    this.ev = o.ev || 'ko';
    this.game = o.game || 'knockout';
    this.tag = o.tag || '[KO]';
    this.Room = o.Room || KnockoutRoom;
    this.io = io;
    this.queue = [];              // [{ socket, name, wallet, since }]
    this.rooms = new Map();       // roomId -> KnockoutRoom
    this.bySocket = new Map();    // socketId -> roomId
    /* socketId -> { socket, roomId, channel }. Somebody watching a match, who
       is in neither of the two above and in no room's players. See watch(). */
    this.watchers = new Map();
    this.liveKey = '';            // which matches were running, for telling watchers
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 200);
  }
  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  /* ── the queue ──────────────────────────────────────────────────────────── */

  /* `worth` is what the SERVER recorded this player staking, already taken out
     of a one-time entry token by the caller. Zero means a free seat. */
  /* `now` is only for tests, and it is the same seam tick() already has.

     Without it a test has to say `tick(Date.now() + PAID_WAIT_MS - 1)`, which
     reads the clock a SECOND time: the gap between enqueue stamping `since` and
     that line running is added to the wait, so on a loaded machine a seat one
     millisecond short of giving up had already given up. That is a test failing
     for a reason that has nothing to do with the thing it is testing, and it
     was doing it in the middle of the pre-deploy run. */
  /* paid: what landed on-chain for this seat (the entry token's paid), which bounds a refund.
     skin: the bought skin this seat wears, already proved against the skin pass by the caller; null is the free look. */
  enqueue(socket, name, wallet, stake, worth, now, paid, skin) {
    /* Queueing again from a socket that already waits on a PAID seat gives that one back first: dequeue
       alone forgot a stake that had already settled on-chain (Fable review 2026-10-21). */
    const prior = this.queue.find(e => e.socket.id === socket.id);
    if (prior && prior.worth > 0) this.refund(prior, 'left the queue');
    this.dequeue(socket.id);
    // Stopping for a restart (shutdownSettle): nothing new is held, so the caller refunds a paid seat.
    if (this.stopping) return false;
    /* Watching and queueing are one or the other. Somebody who was watching
       and pressed Play stops watching first, so the two never overlap. */
    this.unwatch(socket.id);
    this.queue.push({
      socket, name, wallet, since: typeof now === 'number' ? now : Date.now(), botWait: botWait(),
      resumeKey: duelQueue.newResumeKey(),   // a reconnect shows it to take this seat back (duelQueue.resumeSeat)
      stake: Number(stake) > 0 ? Number(stake) : 0,
      worth: Number(worth) > 0 ? Number(worth) : 0,
      paid: Number(paid) > 0 ? Number(paid) : undefined,
      skin: typeof skin === 'string' && skin ? skin : null,
    });
    this.pump(typeof now === 'number' ? now : undefined);
    /* Still waiting after that? Somebody may be in a bot match that has only
       just started, and two people beats two bots. */
    const mine = this.queue.find(e => e.socket.id === socket.id);
    if (mine) {
      const freed = this.rescueFromBot(mine);
      if (freed) {
        this.dequeue(socket.id);
        const room = this.startMatch([freed, mine], false, now);
        /* Anybody who was watching the bot match was watching that person,
           and the person is here now, so the watchers come too. */
        if (room) this.moveWatchers(freed.fromRoom, room);
      }
    }
    /* Taken: waiting, at a table, or (a match that could not start) already refunded by startMatch. Only a
       stopping lobby says false, having touched nothing, so the caller refunds it through the stake row. */
    return true;
  }

  /* A reconnect taking its seat back by the key it was sent (duelQueue.resumeSeat), and that key. */
  resume(socket, key) { return duelQueue.resumeSeat(this, socket, key); }
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
  shutdownSettle(why) { return duelQueue.shutdownRows(this, this.game, why); }

  /* makeMatch, and if it throws, nobody is left holding nothing. The entries
     are already out of the queue by now, so a throw used to be a paid seat
     that was neither queued, at a table, nor refunded (the token-to-queue gap,
     2026-09-22). A seat no registered room holds is refunded, once; a free one
     is told the match did not start. */
  startMatch(entries, withBot, now) {
    try {
      return this.makeMatch(entries, withBot, now);
    } catch (err) {
      console.error(this.tag + ' a match could not start: ' + (err && err.stack ? err.stack : err));
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
        else send(e.socket, this.ev + ':unqueued', { refunded: false, why: 'the match could not start' });
      }
      return null;
    }
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

  /* Two waiting AT THE SAME BUY-IN? Put them on a disc.

     Matched by rung rather than by who is next, because a table where the two
     seats paid different amounts has no honest way to split the pot. A real
     opponent always beats a bot, so this runs before the timer that hands one
     out. */
  pump(now) {
    if (this.stopping) return;
    // Same rung, two different people (two tabs of one wallet never meet), oldest first.
    for (const [a, b] of duelQueue.pairUp(this.queue)) {
      this.dequeue(a.socket.id); this.dequeue(b.socket.id);
      this.startMatch([a, b], false, now);
    }
  }

  tick(now) {
    const t = typeof now === 'number' ? now : Date.now();
    /* PAIR PEOPLE FIRST, EVERY TICK. The loop below hands out one bot per
       waiting seat, so two people who were both in the queue when the timer
       came round got a bot each instead of getting each other. pump() only ran
       on enqueue, which is exactly the moment the second of them was not there
       yet. */
    this.pump(t);
    for (const e of [...this.queue]) {
      /* A paid seat waits for a person, and then gives up and gets its money
         back. A free one gets a bot, because there is nothing to lose. */
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
      this.dequeue(e.socket.id);
      this.startMatch([e], true, t);
    }
    for (const room of [...this.rooms.values()]) {
      /* Aim BEFORE the clock is advanced, so the bot's arrows are in before the
         tick that resolves them. The other order has it miss a turn every time
         a match is decided on the buzzer. */
      this.botAim(room, t);
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
      if (!this.earlyEnough(room)) continue;
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
      console.log(this.tag + ' pairing ' + seat.name + ' with ' + entry.name
        + ' instead of a bot');
      /* fromRoom says which match this was, so its watchers can follow the
         person into the new one (moveWatchers). */
      return { socket: seat.socket, name: seat.name, wallet: seat.wallet,
               since: Date.now(), stake: 0, worth: 0, fromRoom: room.id, skin: seat.skin || null };
    }
    return null;
  }

  /* A bot match its human can still be pulled out of: it has barely begun. */
  earlyEnough(room) {
    return room.state === 'countdown' || (room.state === 'aiming' && (room.turn || 0) <= 1);
  }

  makeMatch(entries, withBot, now) {
    const room = new this.Room(this.io);
    room.stake = entries.length ? (entries[0].stake || 0) : 0;
    room.onSettled = this.onSettled || null;
    for (const e of entries) {
      room.addPlayer(e.socket, e.name, e.wallet, e.worth, e.paid, e.skin);
      this.bySocket.set(e.socket.id, room.id);
      e.socket._koRoom = room.id;
    }
    /* Belt and braces over the rule above: a paid room can never be given a
       bot, whatever the caller asked for. This is the one line standing between
       a real stake and an opponent that cannot cover it. */
    if (withBot && room.stake > 0) withBot = false;
    if (withBot) {
      /* A stand-in socket. It joins nothing and receives nothing: the room only
         ever calls .id and .join on it, and a bot has no client to send to. */
      const botSocket = { id: 'bot_' + room.id, join() {}, emit() {} };
      const name = botNameAgainst(entries);
      room.addPlayer(botSocket, name, null);
      room.bot = { id: botSocket.id, aimedTurn: 0 };
    }
    this.rooms.set(room.id, room);
    /* THE ROOM'S CLOCK MUST BE THE LOBBY'S CLOCK.

       This read Date.now() while the lobby around it was running on whatever
       time tick() was handed, so a test driving a synthetic timeline got a room
       stamped with the real one and the two drifted by however long the gap
       between the two reads was.

       It survived only because BOT_AFTER_MS happened to be 15 seconds, which is
       how big a stall it took to break: measured, the countdown assertion flips
       at 15009 ms. That margin is an accident of a constant that used to be
       6000 and could be lowered again, and at a few hundred milliseconds it
       would sit inside stalls that really do happen. */
    room.start(typeof now === 'number' ? now : Date.now());
    return room;
  }

  /* Handing a stake back, once. Whoever set onRefund owns actually moving it;
     this only says who is owed what and why, which keeps every path that moves
     money in one file. */
  refund(entry, why) {
    if (!entry || entry.refunded) return;
    entry.refunded = true;
    duelQueue.noteRefund(this, entry);   // so a late reconnect is told where the money went
    try { entry.socket.emit(this.ev + ':unqueued', { refunded: entry.worth > 0, why: why || '' }); }
    catch (_) {}
    if (entry.worth > 0 && typeof this.onRefund === 'function') {
      try {
        this.onRefund({ wallet: entry.wallet, name: entry.name, amount: refundBound(entry.worth, entry.paid), why: why || '' });
      } catch (e) { console.error(this.tag + ' refund hook failed:', e.message); }
    }
  }

  roomOf(socketId) {
    const id = this.bySocket.get(socketId);
    return id ? this.rooms.get(id) : null;
  }

  leave(socketId) {
    this.unwatch(socketId);
    const room = this.roomOf(socketId);
    /* Backing out of a PAID queue is a refund, not just a dequeue. The stake
       has already settled on-chain by the time they are standing in it. */
    const waiting = this.queue.find(e => e.socket.id === socketId);
    if (waiting) this.refund(waiting, 'left the queue');
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
    this.dropWatchers(room);
    this.rooms.delete(room.id);
  }

  /* ── watching ─────────────────────────────────────────────────────────────
     Somebody with no seat looking at a match that is already being played.

     READ-ONLY, AND KEPT APART. A watcher is never in the queue, never in a
     room's players and never in bySocket, so nothing that counts people or
     moves money can see one: the live counts read the queue and the players,
     and a payout or a refund reads the players and the queue entries. A watcher
     is not in the players' socket.io room either. They are in a room of their
     own (room.watchRoomName) that the match writes to explicitly, in a form
     with every socket id swapped for a seat (KnockoutRoom.forWatchers). And a
     watcher is never told anything a player is not: the board, who has locked
     in, and the arrows only once the turn has closed. */

  /* The matches somebody could watch right now, oldest first. */
  runningRooms() {
    return [...this.rooms.values()].filter(r => r.state !== 'waiting' && r.state !== 'over');
  }

  /* Which match to show, best first. Moving on from `after`: the next one made
     after it, round to the start again, and `after` itself last of all so a
     Next with only one match running stays where it is. `dir` 'prev' is the
     same walk the other way: the one made just before it, round to the end.
     Arriving fresh: the one furthest in, because that is the one with the most
     going on. Either way a match already settling goes to the back, since it
     is three seconds from its result card and watching it is watching it end. */
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
      const rank = (r) => (r.state === 'countdown' ? 0 : 1) * 1000 + (r.turn || 0);
      order = live.slice().sort((a, b) => rank(b) - rank(a));
    }
    return order.filter(r => r.state !== 'settling').concat(order.filter(r => r.state === 'settling'));
  }

  /* What the page shows about the match it is on: who, the stake, how far in,
     and where it sits among the matches running (for Next match). */
  matchCard(room, live) {
    const list = live || this.runningRooms();
    return {
      id: room.id, names: room.sideNames(), stake: room.stake, pot: room.pot(), turn: room.turn,
      index: list.indexOf(room) + 1, count: list.length,
    };
  }

  /* Watch a running match. opts.after is the match being moved on from and
     opts.dir 'prev' moves back from it instead of on (the Previous button of
     the shared Spectate bar). Answers on 'ko:watching', always, with one of:
       { match, state }   watching it (state is KnockoutRoom.watchSnapshot)
       { none: true }     nothing is running
       { full: true }     everything running already has WATCH_CAP watchers
       { refused: true }  this socket is queued or seated, and is a player */
  watch(socket, opts) {
    if (!socket || typeof socket.id !== 'string') return { ok: false, why: 'no socket' };
    const id = socket.id;
    if (this.bySocket.has(id) || this.queue.some(e => e.socket.id === id)) {
      send(socket, this.ev + ':watching', { refused: true, why: 'You are in a match already.' });
      return { ok: false, why: 'seated' };
    }
    const after = watchAfter(opts && opts.after);
    this.unwatch(id);
    /* opts.stake (the lobby's Spectate on a buy-in, Owen 2026-10-15): only
       tables at that stake, Free or paid. Without one, every table as before.
       What a watcher is sent does not change with the stake. */
    const stake = typeof (opts && opts.stake) === 'number' && Number.isFinite(opts.stake) ? opts.stake : null;
    const live = this.runningRooms().filter(r => stake === null || Math.abs(Number(r.stake) - stake) < 1e-9);
    if (!live.length) { send(socket, this.ev + ':watching', { none: true }); return { ok: false, why: 'none' }; }
    const room = this.watchOrder(live, after, opts && opts.dir === 'prev' ? 'prev' : 'next')
      .find(r => (r.watchers || 0) < WATCH_CAP);
    if (!room) { send(socket, this.ev + ':watching', { full: true }); return { ok: false, why: 'full' }; }
    this.attachWatcher(socket, room, live);
    return { ok: true, roomId: room.id };
  }

  attachWatcher(socket, room, live) {
    this.watchers.set(socket.id, { socket, roomId: room.id, channel: room.watchRoomName });
    room.watchers = (room.watchers || 0) + 1;
    try { if (typeof socket.join === 'function') socket.join(room.watchRoomName); } catch (_) {}
    send(socket, this.ev + ':watching', { match: this.matchCard(room, live), state: room.watchSnapshot() });
  }

  /* Stop watching. Safe to call for anybody, watching or not. */
  unwatch(socketId) {
    const w = this.watchers.get(socketId);
    if (!w) return false;
    this.watchers.delete(socketId);
    const room = this.rooms.get(w.roomId);
    if (room && room.watchers > 0) room.watchers--;
    try { if (w.socket && typeof w.socket.leave === 'function') w.socket.leave(w.channel); } catch (_) {}
    return true;
  }

  /* A bot match dissolved so its human could play a person (rescueFromBot):
     its watchers go to the new match, told with a fresh 'ko:watching'. */
  moveWatchers(fromId, room) {
    if (!fromId || !room) return;
    let live = null;
    for (const [sid, w] of [...this.watchers]) {
      if (w.roomId !== fromId) continue;
      this.unwatch(sid);
      if ((room.watchers || 0) >= WATCH_CAP) { send(w.socket, this.ev + ':ended', { id: fromId }); continue; }
      if (!live) live = this.runningRooms();
      this.attachWatcher(w.socket, room, live);
    }
  }

  /* A room going away. Its watchers were sent ko:over by the room if it
     finished; if it went any other way they are told it ended, so the page is
     never left looking at a match that is not there. Then they are let go, and
     the page asks for the next one. */
  dropWatchers(room) {
    for (const [sid, w] of [...this.watchers]) {
      if (w.roomId !== room.id) continue;
      if (room.state !== 'over') send(w.socket, this.ev + ':ended', { id: room.id });
      this.unwatch(sid);
    }
  }

  /* Every tick: anybody watching a room that is no longer in the map (however
     it went) is told and let go, and when the set of running matches changes
     each watched match is told where it now sits, so Next match is only on
     offer when there is a next match. */
  tickWatchers() {
    if (!this.watchers.size) { this.liveKey = ''; return; }
    for (const [sid, w] of [...this.watchers]) {
      if (this.rooms.has(w.roomId)) continue;
      send(w.socket, this.ev + ':ended', { id: w.roomId });
      this.unwatch(sid);
    }
    const live = this.runningRooms();
    const key = live.map(r => r.id).join(',');
    if (key === this.liveKey) return;
    this.liveKey = key;
    for (const r of live) {
      if (!(r.watchers > 0) || !this.io || !this.io.to) continue;
      try {
        this.io.to(r.watchRoomName).emit(this.ev + ':matches', { index: live.indexOf(r) + 1, count: live.length });
      } catch (_) {}
    }
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
         further it has to go. Jittered so it is not a formula. */
      const want = Math.min(1, 0.5 + dist / (KO.MAX_SPEED * 0.62));
      let pull = KO.MAX_PULL * Math.max(0.3, Math.min(1, want * (0.88 + Math.random() * 0.24)));

      /* AND NOT ONE UNIT HARDER THAN THE DISC WILL TAKE.

         This is the whole difference between an opponent and a piece that
         throws itself into the pit. The cap is worked out from where the rim
         actually is along this exact line, so a shot across the middle can be
         full power and a shot at something parked on the edge cannot. It is
         conservative on purpose: it assumes the shot meets nothing, and a
         collision only ever takes speed away. */
      const ux = Math.cos(a), uy = Math.sin(a);
      const room2rim = rimDistance(p.x, p.y, ux, uy, room.arenaR);
      const safe = Math.max(0, room2rim - KO.PIECE_R * 1.8);
      pull = Math.min(pull, pullForTravel(safe));

      /* If there is no shot down this line that keeps the piece on the disc,
         do not take a weak one: back off toward the middle and live. A person
         in that spot does the same thing. */
      if (pull < KO.MAX_PULL * 0.16) {
        const d = Math.hypot(p.x, p.y) || 1;
        const back = KO.MAX_PULL * (0.3 + Math.random() * 0.18);
        aims.push({ pieceId: p.id, ax: (-p.x / d) * back, ay: (-p.y / d) * back });
        continue;
      }
      aims.push({ pieceId: p.id, ax: ux * pull, ay: uy * pull });
    }

    if (aims.length) room.submitAim(me, aims);
    /* Locking in tells the other screen, exactly as a person's lock does
       (index.js ko:lock). Without it "They are ready" never showed against the
       stand-in, which gave it away every turn. */
    if (room.lockIn(me) && typeof room.broadcast === 'function') {
      room.broadcast('ko:ready', { ready: [...room.ready] });
    }
  }
}

/* Hung off the class as well as exported, so a caller that already has the
   class does not need a second import just to say how long a paid seat waits. */
KnockoutLobby.PAID_WAIT_MS = PAID_WAIT_MS;
KnockoutLobby.FREE_WAIT_MS = FREE_WAIT_MS;
KnockoutLobby.WATCH_CAP = WATCH_CAP;

module.exports = { KnockoutLobby, BOT_AFTER_MS, BOT_AFTER_MIN_MS, PAID_WAIT_MS, PAID_GIVE_UP_MS, FREE_WAIT_MS, WATCH_CAP };
