'use strict';
/* ─── One Crossy Road duel ────────────────────────────────────────────────────
   Two hoppers on the same seeded map (shared/crossySim.js) at the same time.
   The first one hit, drowned, carried off or taken by the eagle loses; both on
   the same tick is a draw, each seat refunded.

   THE SEATS AND THE MONEY ARE KNOCKOUT'S. This room extends KnockoutRoom for
   everything that decides who is owed what: addPlayer (the server-recorded
   worth from the entry token), pot(), removePlayer (walking out forfeits),
   finish() (settles exactly once, a draw refunds each seat its own stake, the
   result carries duelMoney's display figures), the bot's neutral id and the
   watcher room. What is new here is only the game.

   HOW A MATCH IS JUDGED (Swim's way, server/swim/SwimRoom.js). Each hopper is
   a pure function of the map and its own hops, so each is run on its own
   timeline: a person's hops arrive stamped with the tick they were pressed on,
   and their hopper is stepped as far as their hops have been heard, a little
   behind the server's clock (by their latency). If a person's hops stop
   arriving, their hopper is moved on with nothing pressed once it is LAG_MAX
   ticks behind, so a stalled connection cannot hold the match up or buy time.
   The two are only ever compared on ticks BOTH timelines have reached: the
   first tick on which one died decides it. Both on that tick: more coins wins
   (Owen 2026-10-28), equal coins is a draw.

   WHAT THE SCREENS ARE SENT.
     cr:start  once: the seed, when it goes on the server's clock, the seats
     cr:s      20 a second, volatile: both hoppers by seat and the tick each has
               reached; a screen's own row is how it checks its prediction
     cr:over   once: who won, why, both scores, the money for the card
   Seats, never socket ids, in everything a watcher is sent, and the bot's seat
   is a neutral id even to the players. */

const crypto = require('crypto');
const { KnockoutRoom } = require('../KnockoutRoom');
const S = require('../../shared/crossySim');
const { CrossyBot } = require('./crossyBot');

const LAG_MAX = 15;            // ticks (250 ms) a person's hopper may trail the server clock (Swim's)
const LEAD_MAX = 20;           // hops for ticks further ahead of the clock than this are ignored
const SNAP_EVERY = 3;          // ticks between cr:s (20 a second)
const HIST = 1024;             // ticks of presses kept per seat, far more than LAG_MAX
const MAX_HOPS_MSG = 8;        // hops one message may carry
const LEAVE_WAIT_TICKS = LAG_MAX * 2;   // how long a seat that left is kept for a death still to be judged (0.5 s)
const isBotId = (id) => typeof id === 'string' && id.startsWith('bot_');

let nextId = 1;

class CrossyRoom extends KnockoutRoom {
  constructor(io) {
    super(io, 'cr_' + (nextId++), 'cr');
    this.seed = crypto.randomBytes(4).readUInt32LE(0);
    this.world = new S.World(this.seed);
    this.goAt = 0;
    this.clock = 0;            // the server's tick
    this.floor = 0;            // the clock the lag allowance is measured from (Swim's: a stall never drives anyone blind)
    this.turn = 0;             // the lobby's match card reads it: rows the leader has reached
    this.endTick = 0;
  }

  /* A seat, as KnockoutRoom makes it, plus its hopper and what it has pressed. The bot's seat (KnockoutLobby gives it
     the socket id bot_<room>) gets the bot that drives it. */
  addPlayer(socket, name, wallet, worth, paid, skin) {
    if (!super.addPlayer(socket, name, wallet, worth, paid, skin)) return false;
    const p = this.players.get(socket.id);
    p.cr = {
      h: S.newHopper(),
      press: new Int8Array(HIST),
      pressTick: new Int32Array(HIST).fill(-1),
      heard: -1,
      bot: isBotId(socket.id) ? new CrossyBot(S.rng(this.seed ^ 0x5bd1e995)) : null,
    };
    return true;
  }

  bySide(side) {
    for (const p of this.players.values()) if (p.side === side) return p;
    return null;
  }

  start(now) {
    if (this.players.size < 2) return false;
    const t = typeof now === 'number' ? now : Date.now();
    this.state = 'countdown';
    this.goAt = t + S.DUEL.COUNTDOWN_MS;
    this.broadcast('cr:start', this.publicState(t));
    return true;
  }

  /* Hops from a page: { t: the last tick this message speaks for, h: [[tick, move], ...] }. Anything malformed is
     dropped whole; hops for ticks already stepped, or too far ahead of the clock, are ignored. A person only ever
     moves their own hopper. */
  input(socketId, msg) {
    const p = this.players.get(socketId);
    if (!p || p.cr.bot || p.cr.left || this.state !== 'playing' || !p.cr.h.alive) return false;
    if (!msg || typeof msg !== 'object') return false;
    const t = msg.t, hops = msg.h;
    if (!Number.isInteger(t) || t < 0 || t > this.clock + LEAD_MAX) return false;
    if (hops !== undefined && (!Array.isArray(hops) || hops.length > MAX_HOPS_MSG)) return false;
    const c = p.cr;
    for (const e of hops || []) {
      if (!Array.isArray(e) || e.length !== 2) continue;
      const tick = e[0], m = e[1];
      if (!Number.isInteger(tick) || tick < c.h.tick || tick > t) continue;
      if (!Number.isInteger(m) || m < 1 || m > 4) continue;
      c.press[tick % HIST] = m;
      c.pressTick[tick % HIST] = tick;
    }
    if (t > c.heard) c.heard = t;
    return true;
  }

  pressFor(c, tick) {
    return c.pressTick[tick % HIST] === tick ? c.press[tick % HIST] : 0;
  }

  /* Move one seat's hopper on, as far as its hops (or the lag allowance) let it. */
  advance(p) {
    const c = p.cr, h = c.h;
    if (c.bot) {
      while (h.tick < Math.min(this.clock, S.DUEL.MAX_TICKS + 1) && h.alive) S.step(this.world, h, c.bot.input(this.world, h));
      return;
    }
    const upTo = Math.min(this.clock, Math.max(c.heard + 1, this.floor - LAG_MAX), S.DUEL.MAX_TICKS + 1);
    while (h.tick < upTo && h.alive) S.step(this.world, h, this.pressFor(c, h.tick));
  }

  /* Decided once both timelines have reached the first death: the one that died first loses; both on the same tick
     is a draw. Returns true once it is decided. */
  judge() {
    const a = this.bySide(0), b = this.bySide(1);
    if (!a || !b) return false;
    const ha = a.cr.h, hb = b.cr.h;
    const known = (h) => (h.alive ? h.tick - 1 : Infinity);
    const crash = (h) => (h.alive ? Infinity : h.deadTick);
    const first = Math.min(crash(ha), crash(hb));
    if (first < Infinity && first <= Math.min(known(ha), known(hb))) {
      this.endTick = first;
      if (crash(ha) === crash(hb)) {
        // Both out on the same tick: the coins decide it (Owen 2026-10-28); level coins is a draw.
        if (ha.coins === hb.coins) this.finish(null, 'both out');
        else this.finish(this.seats[ha.coins > hb.coins ? 0 : 1].id, 'more coins');
      } else this.finish(this.seats[crash(ha) === first ? 1 : 0].id, why(crash(ha) === first ? ha : hb));
      return true;
    }
    // The safety stop: five minutes with both still going, the one further ahead wins, level is a draw.
    if (Math.min(known(ha), known(hb)) >= S.DUEL.MAX_TICKS) {
      this.endTick = S.DUEL.MAX_TICKS;
      const sa = S.score(ha) * 1e6 + ha.coins, sb = S.score(hb) * 1e6 + hb.coins;   // further along, then coins
      this.finish(sa === sb ? null : this.seats[sa > sb ? 0 : 1].id, 'time');
      return true;
    }
    return false;
  }

  /* One room's error must never take the server down with every other game on it (Opus review 2026-10-28): the
     room is ended as a draw, each seat refunded its own stake. */
  tick(now) {
    try { this.tickInner(now); }
    catch (e) {
      console.error('[CR] room ' + this.id + ' failed, refunding: ' + (e && e.stack ? e.stack : e));
      try { this.finish(null, 'error'); } catch (_) {}
    }
  }

  tickInner(now) {
    const t = typeof now === 'number' ? now : Date.now();
    if (this.state === 'countdown') {
      if (t < this.goAt) return;
      this.state = 'playing';
      this.broadcast('cr:go', { tick: 0 });
    }
    if (this.state !== 'playing') return;
    const clock = Math.floor((t - this.goAt) / S.TICK_MS);
    if (clock <= this.clock && this.clock > 0) return;
    const from = this.clock;
    this.clock = Math.max(this.clock, clock);
    /* At most two ticks a call, so after a stall the inputs that were sent in time are read first (Swim's); but never
       more than 2 x LAG_MAX behind the clock, so a slow event loop cannot let a silent seat trail without limit (Opus
       review 2026-10-28). */
    this.floor = Math.min(this.clock, Math.max(this.floor + 2, this.clock - 2 * LAG_MAX));
    const a = this.bySide(0), b = this.bySide(1);
    if (a) this.advance(a);
    if (b) this.advance(b);
    if (this.judge()) return;
    this.leftCheck();
    if (this.state !== 'playing') return;
    if (a && b) {
      this.turn = Math.max(S.score(a.cr.h), S.score(b.cr.h));
      this.world.forget(Math.min(a.cr.h.r, b.cr.h.r) - 12);
    }
    if (Math.floor(this.clock / SNAP_EVERY) !== Math.floor(from / SNAP_EVERY)) this.snapshot();
  }

  /* Every hopper's whole state (S.packHopper), by seat, at full precision: a screen checks its own row against its
     prediction for that tick and, if they differ, takes this one and replays its hops after it. */
  rows() {
    const out = [];
    for (const p of this.players.values()) out.push([p.side].concat(S.packHopper(p.cr.h)));
    return out;
  }

  snapshot() {
    const msg = { T: this.clock, p: this.rows() };
    if (!this.io || !this.io.to) return;
    /* VOLATILE: a page that cannot keep up drops one rather than backing the rest up behind it (the mobile netcode
       rule). Every snapshot is whole, so a dropped one costs nothing. */
    try { const to = this.io.to(this.socketRoomName); (to.volatile || to).emit('cr:s', msg); } catch (_) {}
    if (this.watchers > 0) { try { const w = this.io.to(this.watchRoomName); (w.volatile || w).emit('cr:s', msg); } catch (_) {} }
  }

  /* WALKING OUT (or a dropped connection) never changes what the timelines have already decided (Fable review
     2026-10-28). The leaver sends nothing more, so their hopper is stepped to the clock at once with what they had
     sent; if either seat's death is then decided, it is judged and settled as decided, both seats still present.
     Otherwise the seat is kept (its hopper stands still from here) and the match is judged as the stayer's hops arrive,
     for at most LEAVE_WAIT_TICKS; then the stayer is stepped to that moment with what it had sent and judged again,
     and only if both are still alive does walking out end it with the one still here winning (KnockoutRoom). Nobody
     can turn a locked-in loss into a refund, or a win, by leaving (Fable and Opus reviews 2026-10-28). */
  removePlayer(socketId) {
    const p = this.players.get(socketId);
    if (!p) return;
    if (this.state === 'playing' && !p.cr.left) {
      p.cr.left = true;
      p.cr.heard = Math.min(p.cr.heard, this.clock);     // nothing more counts from the seat that left
      const h = p.cr.h;
      while (h.tick < this.clock && h.alive) S.step(this.world, h, this.pressFor(p.cr, h.tick));
      if (this.judge()) { this.players.delete(socketId); return; }
      this.leftAt = this.clock; this.leftId = socketId;
      return;
    }
    if (this.state !== 'playing' || !this.leftId) super.removePlayer(socketId);
  }

  /* A seat that left with a death still to be judged: judged as the timelines arrive, or after the wait the old rule
     (the leaver loses) if the stayer's timeline never got there. */
  leftCheck() {
    if (!this.leftId || this.state !== 'playing') return;
    if (this.clock - this.leftAt < LEAVE_WAIT_TICKS) return;
    const id = this.leftId;
    this.leftId = null;
    // The stayer, stepped to the moment that matters with what it sent: the leave, or the leaver's death if later.
    const leaver = this.players.get(id);
    for (const q of this.players.values()) {
      if (q === leaver || q.cr.bot) continue;
      const until = Math.min(this.clock, Math.max(this.leftAt, leaver && !leaver.cr.h.alive ? leaver.cr.h.deadTick + 1 : 0));
      while (q.cr.h.tick < until && q.cr.h.alive) S.step(this.world, q.cr.h, this.pressFor(q.cr, q.cr.h.tick));
    }
    if (this.judge()) return;
    if (leaver) leaver.cr.left = false;
    super.removePlayer(id);
  }

  decideNow() { this.judge(); }

  /* A held seat (KnockoutLobby's reconnect grace): while it is away its hopper is moved on with nothing pressed once
     it trails LAG_MAX (advance), so it stands still and is judged as usual. A seat that has already left (removePlayer
     above, kept only for a death still to be judged) is never handed to a new socket. */
  rekey(oldId, socket) {
    const p = this.players.get(oldId);
    if (!p || (p.cr && p.cr.left)) return false;
    return super.rekey(oldId, socket);
  }

  /* Both held seats ran out together: each hopper is stepped to the clock with what it had sent, as a leaver's is,
     and judged; only if neither timeline has decided it is it the draw KnockoutRoom calls it. */
  bothGone() {
    if (this.state !== 'playing') { super.bothGone(); return; }
    for (const p of this.players.values()) {
      if (p.cr.bot) continue;
      const h = p.cr.h;
      p.cr.heard = Math.min(p.cr.heard, this.clock);
      while (h.tick < this.clock && h.alive) S.step(this.world, h, this.pressFor(p.cr, h.tick));
    }
    if (this.judge()) return;
    super.bothGone();
  }

  overExtra() {
    const sc = [0, 1].map(s => { const p = this.bySide(s); return p ? S.score(p.cr.h) : 0; });
    const deaths = [0, 1].map(s => { const p = this.bySide(s); return p && !p.cr.h.alive ? p.cr.h.death : null; });
    return { score: sc, deaths, tick: this.endTick || this.clock };
  }

  publicState(now) {
    const t = typeof now === 'number' ? now : Date.now();
    return {
      id: this.id,
      state: this.state,
      seed: this.seed,
      v: S.VERSION,
      /* The server's clock (ms) and when the match goes on it: with ping_check the page lines its own clock up with
         these, so it runs its hopper on the server's ticks. */
      goAt: this.goAt,
      now: t,
      tick: this.clock,
      vsBot: !!this.bot,
      players: [...this.players.entries()].map(([id, p]) => ({
        id: this.publicId(id), name: p.name, side: p.side, skin: p.skin || null,
      })),
      stake: this.stake,
      pot: this.pot(),
      p: this.rows(),
    };
  }

  /* ── what a watcher is told: the same moments, by seat, with every id gone ── */
  watchState(ps) {
    return {
      id: ps.id, state: ps.state, seed: ps.seed, v: ps.v, goAt: ps.goAt, now: ps.now, tick: ps.tick,
      players: (ps.players || []).map(q => ({ side: q.side, name: q.name, skin: q.skin || null })),
      stake: ps.stake, pot: ps.pot, p: ps.p,
    };
  }

  forWatchers(event, p) {
    if (!p) return null;
    switch (event) {
      case 'cr:start': return this.watchState(p);
      case 'cr:go': return { tick: 0 };
      case 'cr:chat': return { name: p.name, side: p.side, text: p.text };
      case 'cr:over':
        return {
          winner: p.winner || null,
          winnerSide: p.winnerId ? this.sideOf(p.winnerId) : null,
          why: p.why, stake: p.stake, pot: p.pot, score: (p.score || []).slice(), deaths: (p.deaths || []).slice(), tick: p.tick,
        };
      default: return null;
    }
  }

  watchSnapshot(now) {
    return this.watchState(this.publicState(now));
  }
}

// What a hopper died of, in the words the result card uses.
function why(h) {
  return ({ car: 'hit by a car', train: 'hit by a train', water: 'fell in the river', log: 'carried off the edge', eagle: 'taken by the eagle' })[h.death] || 'out';
}

module.exports = { CrossyRoom, LAG_MAX, LEAD_MAX, HIST };
