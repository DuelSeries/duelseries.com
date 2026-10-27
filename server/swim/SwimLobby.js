'use strict';
/* ─── Swim: getting two cars onto the road ────────────────────────────────────
   The queue, the races it makes, and watching them. This is Knockout's lobby
   (server/KnockoutLobby.js) with a race in place of a disc, and every rule
   about seats and money is the same rule, most of it the very same code
   (server/duelQueue.js):

   - a free seat waits a minute, with a countdown, then races the bot (said on
     screen: "Playing a bot"); a person arriving while a bot race has barely
     begun takes the bot's place;
   - a PAID SEAT NEVER GETS A BOT. It waits for a person past its minute, with
     Cancel refunding at once, and is handed back after PAID_GIVE_UP_MS;
   - two seats are paired only at the same rung and never with themselves;
   - every stake handed back goes through onRefund, every result through the
     room's onSettled, each exactly once; a restart turns every paid seat it is
     holding into an owed refund row (shutdownSettle).

   The only new part is the clock: a race is simulated 60 times a second, so
   the lobby ticks at that rate (the queue does not need it, and costs nothing
   checked that often).

   And one rule Knockout does not have: a seat whose connection drops mid-race
   is held for five seconds (drop), driving straight, for a reconnect that
   shows its key to take back (rejoin). Past that, the tick makes it the leave
   it used to be at once. A queued seat and a watcher still leave at once. */

const { SwimRoom } = require('./SwimRoom');
const { refundBound } = require('../stakeRules');
const { pickName } = require('../botNames');
const duelQueue = require('../duelQueue');
const { FREE_WAIT_MS, PAID_WAIT_MS, PAID_GIVE_UP_MS } = duelQueue;
const BOT_AFTER_MS = FREE_WAIT_MS;

const TICK_MS = 1000 / 60;
const RESCUE_TICKS = 4 * 60;     // a bot race this young gives its person up to a real opponent
const WATCH_CAP = 50;
const BOT_NAME_MAX = 15;
const ENDED_REMEMBER_MS = 5 * 60000;   // how long a seat's key can still fetch the result of a race that ended
const isKey = (k) => typeof k === 'string' && /^[0-9a-f]{32}$/.test(k);

function botNameAgainst(entries) {
  const theirs = new Set(entries.map(e => String((e && e.name) || '').trim().toLowerCase()));
  return pickName(Math.random(), { maxLen: BOT_NAME_MAX, taken: (lc) => theirs.has(lc) });
}
const watchAfter = (v) => (typeof v === 'string' && v.length > 0 && v.length <= 40 ? v : null);
const seqOf = (id) => {
  const m = /(\d+)$/.exec(String(id || ''));
  return m ? Number(m[1]) : NaN;
};
function send(socket, ev, payload) {
  try { if (socket && typeof socket.emit === 'function') socket.emit(ev, payload); } catch (_) {}
}

class SwimLobby {
  constructor(io) {
    this.io = io;
    this.queue = [];              // [{ socket, name, wallet, since, stake, worth, paid, skin, resumeKey }]
    this.rooms = new Map();       // roomId -> SwimRoom
    this.bySocket = new Map();    // socketId -> roomId
    this.watchers = new Map();    // socketId -> { socket, roomId, channel }
    this.ended = new Map();       // seat key -> { over, side, at }: races that ended, for a late reconnect
    this.liveKey = '';
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try { this.tick(); } catch (e) { console.error('[SW] tick failed:', e && e.stack ? e.stack : e); }
    }, TICK_MS);
  }
  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  /* ── the queue (KnockoutLobby.enqueue, the same contract) ───────────────── */
  enqueue(socket, name, wallet, stake, worth, now, paid, skin) {
    /* Already in a race: one seat per socket (Fable review 2026-10-27). Not taken, so a paid caller
       refunds it through the stake row (enterPaid), and the race in progress is left alone. */
    if (this.roomOf(socket.id)) return false;
    const prior = this.queue.find(e => e.socket.id === socket.id);
    if (prior && prior.worth > 0) this.refund(prior, 'left the queue');
    this.dequeue(socket.id);
    if (this.stopping) return false;
    this.unwatch(socket.id);
    this.queue.push({
      socket, name, wallet, since: typeof now === 'number' ? now : Date.now(), botWait: FREE_WAIT_MS,
      resumeKey: duelQueue.newResumeKey(),
      stake: Number(stake) > 0 ? Number(stake) : 0,
      worth: Number(worth) > 0 ? Number(worth) : 0,
      paid: Number(paid) > 0 ? Number(paid) : undefined,
      skin: typeof skin === 'string' && skin ? skin : null,
    });
    this.pump(typeof now === 'number' ? now : undefined);
    const mine = this.queue.find(e => e.socket.id === socket.id);
    if (mine) {
      const freed = this.rescueFromBot(mine);
      if (freed) {
        this.dequeue(socket.id);
        const room = this.startMatch([freed, mine], false, now);
        if (room) this.moveWatchers(freed.fromRoom, room);
      }
    }
    return true;
  }

  resume(socket, key) { return duelQueue.resumeSeat(this, socket, key); }
  resumeKeyOf(socketId) {
    const e = this.queue.find(q => q.socket.id === socketId);
    return e ? e.resumeKey : null;
  }
  holds(socketId) { return this.queue.some(e => e.socket.id === socketId) || !!this.roomOf(socketId); }
  waitingByRung() { return duelQueue.waitingByRung(this.queue); }
  shutdownSettle(why) { return duelQueue.shutdownRows(this, 'swim', why); }

  startMatch(entries, withBot, now) {
    try {
      return this.makeMatch(entries, withBot, now);
    } catch (err) {
      console.error('[SW] a race could not start: ' + (err && err.stack ? err.stack : err));
      for (const e of entries) {
        if (!e || !e.socket) continue;
        const rid = this.bySocket.get(e.socket.id);
        const r = rid ? this.rooms.get(rid) : null;
        if (r && r.state !== 'waiting') continue;
        if (r) { r.settled = true; this.rooms.delete(rid); }
        this.bySocket.delete(e.socket.id);
        if (e.worth > 0) this.refund(e, 'the match could not start');
        else send(e.socket, 'sw:unqueued', { refunded: false, why: 'the match could not start' });
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

  pump(now) {
    if (this.stopping) return;
    for (const [a, b] of duelQueue.pairUp(this.queue)) {
      this.dequeue(a.socket.id); this.dequeue(b.socket.id);
      this.startMatch([a, b], false, now);
    }
  }

  tick(now) {
    const t = typeof now === 'number' ? now : Date.now();
    this.pump(t);
    for (const e of [...this.queue]) {
      if (e.stake > 0) {
        if (t - e.since < PAID_GIVE_UP_MS) continue;
        this.dequeue(e.socket.id);
        this.refund(e, 'nobody joined that table');
        continue;
      }
      const wait = typeof e.botWait === 'number' && Number.isFinite(e.botWait) ? e.botWait : BOT_AFTER_MS;
      if (t - e.since < wait) continue;
      this.dequeue(e.socket.id);
      this.startMatch([e], true, t);
    }
    for (const room of [...this.rooms.values()]) {
      try { room.tick(t); } catch (err) {
        /* A race that throws is called off as a draw (finish refunds a paid
           table through onSettled) rather than left running broken. */
        console.error('[SW] ' + room.id + ' tick threw: ' + (err && err.stack ? err.stack : err));
        try { room.finish(null, 'error'); } catch (_) {}
      }
      if (room.state === 'over') { this.sweep(room); continue; }
      /* After the race's own tick, so a crash judged on the last tick of a grace is still a crash. */
      this.expire(room, t);
    }
    this.tickWatchers();
  }

  /* ── a dropped connection mid-race (see SwimRoom's header) ─────────────── */

  /* The socket's disconnect. A seat in a race that is on is held for its
     grace; everything else (a queued seat, a watcher, a room not racing) is
     the leave it always was. */
  drop(socketId, now) {
    const room = this.roomOf(socketId);
    if (room && room.away(socketId, typeof now === 'number' ? now : Date.now())) {
      this.unwatch(socketId);
      return true;
    }
    this.leave(socketId);
    return false;
  }

  /* A held seat whose five seconds are up leaves, exactly as a disconnect did
     before: removePlayer gives the race to the other seat (or calls it a draw
     if that car had already crashed). Only a room still in the lobby and
     still on: one that ended in the grace was swept and is never reached. */
  expire(room, t) {
    const due = room.awayDue(t);
    if (!due.length || this.rooms.get(room.id) !== room || room.state === 'over') return;
    /* Both gone on the same deadline: neither is the one who stayed, so it is a draw, not whichever
       seat the map happens to list first (Fable review 2026-10-27). */
    if (due.length === 2 && room.players.get(due[0]).away === room.players.get(due[1]).away) {
      console.log('[SW] ' + room.id + ': both dropped seats ran out together');
      room.finish(null, 'both out');
      this.sweep(room);
      return;
    }
    due.sort((a, b) => room.players.get(a).away - room.players.get(b).away);
    const id = due[0];
    /* The seat still here has already crashed but the judging has not reached it (it trails by up
       to LAG_MAX ticks): wait for judge to settle that crash rather than turn it into a draw at the
       deadline, which a player could time (Fable review 2026-10-27). */
    const other = room.players.get(room.opponentOf(id));
    if (other && !other.car.alive && room.state !== 'over') return;
    console.log('[SW] ' + room.id + ': a dropped seat did not come back in time');
    this.leave(id);
  }

  /* A RECONNECT TAKES ITS SEAT BACK. The key (sent only to the seat's own
     socket, sw:seat) is the only proof. A socket that holds a seat or a queue
     place already cannot take another. On success the new socket gets the race
     as it is now (sw:rejoined, sw:start's shape plus its side) and a fresh key,
     and the used one is dead. A key whose race has ended gets that race's
     result instead (it may have been decided while the link was down). */
  rejoin(socket, key, now) {
    const fail = (extra) => { send(socket, 'sw:rejoinfail', extra || {}); return { ok: false }; };
    // Restarting: every paid seat was turned into an owed refund (shutdownSettle), so the page says so.
    if (this.stopping) return fail({ restart: true });
    if (!socket || typeof socket.id !== 'string' || !isKey(key)) return fail();
    if (this.holds(socket.id)) return fail();
    for (const room of this.rooms.values()) {
      if (!room.keys || !room.keys.has(key)) continue;
      const found = room.seatByKey(key);
      if (!found || (room.state !== 'countdown' && room.state !== 'racing')) {
        return fail(room.overMsg ? { over: room.overMsg, side: room.keys.get(key) } : null);
      }
      const oldId = found.id;
      if (!room.rekey(oldId, socket)) return fail();
      this.bySocket.delete(oldId);
      this.bySocket.set(socket.id, room.id);
      this.unwatch(socket.id);
      const p = found.p;
      console.log('[SW] ' + room.id + ': ' + p.name + ' reconnected');
      send(socket, 'sw:rejoined', Object.assign(room.startState(now), { side: p.side }));
      room.issueKey(p);
      return { ok: true, room, side: p.side, wallet: p.wallet, worth: room.worth.get(socket.id) || 0 };
    }
    const gone = this.ended.get(key);
    if (gone) { this.ended.delete(key); return fail({ over: gone.over, side: gone.side }); }
    return fail();
  }

  /* A swept room's keys keep its result for a few minutes (rejoin above). */
  rememberEnded(room) {
    if (!room.overMsg || !room.keys || !room.keys.size) return;
    const t = Date.now();
    for (const [k, v] of this.ended) if (t - v.at > ENDED_REMEMBER_MS) this.ended.delete(k);
    for (const [k, side] of room.keys) this.ended.set(k, { over: room.overMsg, side, at: t });
  }

  /* A person arriving while a bot race has barely begun takes the bot's place. */
  rescueFromBot(entry) {
    if (!entry || entry.stake > 0) return null;
    for (const room of this.rooms.values()) {
      if (!room.bot || room.stake > 0) continue;
      const early = room.state === 'countdown' || (room.state === 'racing' && room.clock <= RESCUE_TICKS);
      if (!early) continue;
      const human = [...room.players.keys()].find(id => !String(id).startsWith('bot_'));
      if (!human || human === entry.socket.id) continue;
      const seat = room.players.get(human);
      /* A seat held for its reconnect has no live socket to move: pairing a newcomer with it would
         race them against a car nobody is driving, with no grace left to end it. */
      if (!seat || !seat.socket || seat.away) continue;
      this.rooms.delete(room.id);
      for (const [sid, rid] of [...this.bySocket]) if (rid === room.id) this.bySocket.delete(sid);
      room.state = 'over';            // its tick stops; no result was decided, so none is sent
      console.log('[SW] pairing ' + seat.name + ' with ' + entry.name + ' instead of a bot');
      return { socket: seat.socket, name: seat.name, wallet: seat.wallet,
               since: Date.now(), stake: 0, worth: 0, fromRoom: room.id, skin: seat.skin || null };
    }
    return null;
  }

  makeMatch(entries, withBot, now) {
    const room = new SwimRoom(this.io);
    room.stake = entries.length ? (entries[0].stake || 0) : 0;
    room.onSettled = this.onSettled || null;
    for (const e of entries) {
      room.addPlayer(e.socket, e.name, e.wallet, e.worth, e.paid, e.skin);
      this.bySocket.set(e.socket.id, room.id);
    }
    /* A paid room can never be given a bot, whatever the caller asked for. */
    if (withBot && room.stake > 0) withBot = false;
    if (withBot) room.addBot(botNameAgainst(entries));
    this.rooms.set(room.id, room);
    room.start(typeof now === 'number' ? now : Date.now());
    return room;
  }

  refund(entry, why) {
    if (!entry || entry.refunded) return;
    entry.refunded = true;
    duelQueue.noteRefund(this, entry);
    try { entry.socket.emit('sw:unqueued', { refunded: entry.worth > 0, why: why || '' }); } catch (_) {}
    if (entry.worth > 0 && typeof this.onRefund === 'function') {
      try {
        this.onRefund({ wallet: entry.wallet, name: entry.name, amount: refundBound(entry.worth, entry.paid), why: why || '' });
      } catch (e) { console.error('[SW] refund hook failed:', e.message); }
    }
  }

  roomOf(socketId) {
    const id = this.bySocket.get(socketId);
    return id ? this.rooms.get(id) : null;
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
    if (room.state !== 'over' && room.state !== 'waiting') room.finish(null, 'opponent left');
    if (this.rooms.get(room.id) === room) this.rememberEnded(room);
    for (const [sid, rid] of [...this.bySocket]) if (rid === room.id) this.bySocket.delete(sid);
    this.dropWatchers(room);
    this.rooms.delete(room.id);
  }

  /* ── watching (KnockoutLobby's, read-only and kept apart) ───────────────── */
  runningRooms() {
    return [...this.rooms.values()].filter(r => r.state === 'countdown' || r.state === 'racing');
  }

  watchOrder(live, after, dir) {
    const n = seqOf(after);
    if (after && Number.isFinite(n)) {
      const others = live.filter(r => r.id !== after);
      if (dir === 'prev') {
        const before = others.filter(r => seqOf(r.id) < n).reverse();
        const rest = others.filter(r => !(seqOf(r.id) < n)).reverse();
        return before.concat(rest, live.filter(r => r.id === after));
      }
      const later = others.filter(r => seqOf(r.id) > n);
      const earlier = others.filter(r => !(seqOf(r.id) > n));
      return later.concat(earlier, live.filter(r => r.id === after));
    }
    // Arriving fresh: the race furthest in, because that is the one with the most going on.
    return live.slice().sort((a, b) => (b.state === 'racing' ? b.clock + 1 : 0) - (a.state === 'racing' ? a.clock + 1 : 0));
  }

  matchCard(room, live) {
    const list = live || this.runningRooms();
    return { id: room.id, names: room.sideNames(), stake: room.stake, pot: room.pot(), tick: room.clock,
             index: list.indexOf(room) + 1, count: list.length };
  }

  watch(socket, opts) {
    if (!socket || typeof socket.id !== 'string') return { ok: false, why: 'no socket' };
    const id = socket.id;
    if (this.bySocket.has(id) || this.queue.some(e => e.socket.id === id)) {
      send(socket, 'sw:watching', { refused: true, why: 'You are in a race already.' });
      return { ok: false, why: 'seated' };
    }
    const after = watchAfter(opts && opts.after);
    this.unwatch(id);
    const stake = typeof (opts && opts.stake) === 'number' && Number.isFinite(opts.stake) ? opts.stake : null;
    const live = this.runningRooms().filter(r => stake === null || Math.abs(Number(r.stake) - stake) < 1e-9);
    if (!live.length) { send(socket, 'sw:watching', { none: true }); return { ok: false, why: 'none' }; }
    const room = this.watchOrder(live, after, opts && opts.dir === 'prev' ? 'prev' : 'next')
      .find(r => (r.watchers || 0) < WATCH_CAP);
    if (!room) { send(socket, 'sw:watching', { full: true }); return { ok: false, why: 'full' }; }
    this.attachWatcher(socket, room, live);
    return { ok: true, roomId: room.id };
  }

  attachWatcher(socket, room, live) {
    this.watchers.set(socket.id, { socket, roomId: room.id, channel: room.watchRoomName });
    room.watchers = (room.watchers || 0) + 1;
    try { if (typeof socket.join === 'function') socket.join(room.watchRoomName); } catch (_) {}
    send(socket, 'sw:watching', { match: this.matchCard(room, live), state: room.watchSnapshot() });
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
      if ((room.watchers || 0) >= WATCH_CAP) { send(w.socket, 'sw:ended', { id: fromId }); continue; }
      if (!live) live = this.runningRooms();
      this.attachWatcher(w.socket, room, live);
    }
  }

  dropWatchers(room) {
    for (const [sid, w] of [...this.watchers]) {
      if (w.roomId !== room.id) continue;
      if (room.state !== 'over') send(w.socket, 'sw:ended', { id: room.id });
      this.unwatch(sid);
    }
  }

  tickWatchers() {
    if (!this.watchers.size) { this.liveKey = ''; return; }
    for (const [sid, w] of [...this.watchers]) {
      if (this.rooms.has(w.roomId)) continue;
      send(w.socket, 'sw:ended', { id: w.roomId });
      this.unwatch(sid);
    }
    const live = this.runningRooms();
    const key = live.map(r => r.id).join(',');
    if (key === this.liveKey) return;
    this.liveKey = key;
    for (const r of live) {
      if (!(r.watchers > 0) || !this.io || !this.io.to) continue;
      try { this.io.to(r.watchRoomName).emit('sw:matches', { index: live.indexOf(r) + 1, count: live.length }); } catch (_) {}
    }
  }
}

SwimLobby.PAID_WAIT_MS = PAID_WAIT_MS;
SwimLobby.FREE_WAIT_MS = FREE_WAIT_MS;
SwimLobby.WATCH_CAP = WATCH_CAP;

module.exports = { SwimLobby, BOT_AFTER_MS, PAID_WAIT_MS, PAID_GIVE_UP_MS, FREE_WAIT_MS, WATCH_CAP };
