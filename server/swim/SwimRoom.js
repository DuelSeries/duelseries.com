'use strict';
/* ─── Swim: one race between two cars ─────────────────────────────────────────
   The lobby (SwimLobby.js) seats two players here, a person and a person or a
   person and the free-table bot, and ticks it. This decides who won and
   nothing else: what that is worth, and moving it, is index.js's job through
   onSettled, exactly as for Knockout (the same pot, the same seats, the same
   split, server/duelMoney.js).

   HOW A RACE IS JUDGED (shared/swimSim.js has the why). Each car is simulated
   from its own inputs, tick by tick, at the tick those inputs have reached.
   A person's car runs a little behind the server's clock (by their latency),
   and is judged against the traffic as it was on each of its own ticks, which
   is what they saw. If a person's inputs stop arriving, their car is moved on
   with their last input once it is LAG_MAX ticks behind, so a stalled
   connection cannot hold the race up or buy time. The two cars are only ever
   compared on ticks BOTH have reached: the first tick on which a car touched
   traffic, or on which one was BEHIND_LOSE metres behind the other, decides it.
   Both on the same tick is a draw.

   WHAT THE SCREENS ARE SENT.
     sw:start  once: the seats, when the race goes, and the traffic so far
     sw:s      20 a second, volatile: both cars' states (by seat) and the
               tick each has reached; a screen's own row is how it corrects
               its prediction
     sw:cars   4 a second, reliable: traffic records new since the last one.
               Never volatile, because a car a screen never heard of is a car
               it cannot dodge.
     sw:over   once: who won, why, the money for the card
   Seats, never socket ids, in everything a watcher is sent, and the bot's
   seat is a neutral id even to the players (Owen 2026-10-16). */

const crypto = require('crypto');
const S = require('../../shared/swimSim');
const { Spawner } = require('./swimTraffic');
const { SwimBot } = require('./swimBot');
const { refundBound } = require('../stakeRules');
const { duelMoney } = require('../duelMoney');

const LAG_MAX = 15;            // ticks (250 ms) a person's car may trail the server clock
const LEAD_MAX = 20;           // inputs for ticks further ahead of the clock than this are ignored
const SNAP_EVERY = 3;          // ticks between sw:s (20 a second)
const CARS_EVERY = 15;         // ticks between sw:cars (4 a second)
const HIST = 1024;             // ticks of z history kept per car, far more than LAG_MAX
const PRUNE_BEHIND = 120;      // metres behind the rear car past which traffic is forgotten
/* A safety stop, not a rule anybody should meet: 30 minutes of racing with
   both still going is called a draw (a stake is refunded), so a pair of
   flawless drivers cannot hold a room open forever. */
const MAX_TICKS = 30 * 60 * S.HZ;

const isBotId = (id) => typeof id === 'string' && id.startsWith('bot_');
const neutralId = () => crypto.randomBytes(15).toString('base64url');
function nowOr(t) { return typeof t === 'number' && Number.isFinite(t) ? t : Date.now(); }

let nextId = 1;

class SwimRoom {
  constructor(io, roomId) {
    this.io = io;
    this.id = roomId || ('sw_' + (nextId++));
    this.socketRoomName = 'sw_' + this.id;
    this.watchRoomName = 'sww_' + this.id;
    this.state = 'waiting';     // waiting | countdown | racing | over
    this.players = new Map();   // socketId -> seat (see addPlayer)
    this.seats = [];            // side -> { id, name }, kept after a seat leaves
    /* THE MONEY ON THIS TABLE, as in KnockoutRoom: the rung, and per seat what
       the SERVER recorded them staking (from the one-time entry token). */
    this.stake = 0;
    this.worth = new Map();
    this.settled = false;
    this.watchers = 0;
    this.bot = null;
    this.goAt = 0;
    this.clock = 0;             // the server's tick
    this.floor = 0;             // the clock the lag allowance is measured from (see advance)
    this.judged = 0;            // every tick up to this one has been compared
    this.traffic = new S.Traffic();
    this.seed = crypto.randomBytes(4).readUInt32LE(0);
    this.spawner = new Spawner(this.seed);
    this.fresh = [];            // records not yet sent in a sw:cars
    this.winner = null;
    this.overWhy = '';
    this.endTick = 0;
  }

  /* ── seats ──────────────────────────────────────────────────────────────── */

  addPlayer(socket, name, wallet, worth, paid, skin) {
    if (this.players.size >= 2) return false;
    const side = this.players.size;
    const car = S.newCar(side);
    this.players.set(socket.id, {
      socket, name: name || 'Player', wallet: wallet || null, side,
      paid: Number(paid) > 0 ? Number(paid) : undefined,
      skin: typeof skin === 'string' && skin ? skin : null,
      car,
      codes: new Int16Array(HIST).fill(-1),     // the input for tick t, at t % HIST (-1: not heard)
      codeTick: new Int32Array(HIST).fill(-1),
      heard: -1,                                // the furthest tick an input has arrived for
      last: S.NEUTRAL,                          // the input used last, repeated when one is late
      zHist: new Float64Array(HIST),            // z on each tick, for comparing the two
      bot: null,
    });
    this.worth.set(socket.id, Number(worth) > 0 ? Number(worth) : 0);
    this.seats[side] = { id: socket.id, name: name || 'Player' };
    if (socket.join) socket.join(this.socketRoomName);
    return true;
  }

  /* The free-table stand-in: a seat with no socket to send to and a driver
     that makes its inputs (server/swim/swimBot.js). */
  addBot(name) {
    const botSocket = { id: 'bot_' + this.id, join() {}, emit() {} };
    if (!this.addPlayer(botSocket, name, null)) return false;
    const seat = this.players.get(botSocket.id);
    seat.bot = new SwimBot(S.rng(this.seed ^ 0x5bd1e995));
    this.bot = { id: botSocket.id };
    return true;
  }

  publicId(socketId) {
    if (!isBotId(socketId)) return socketId;
    if (!this.botAlias) this.botAlias = neutralId();
    return this.botAlias;
  }
  sideOf(socketId) {
    const p = this.players.get(socketId);
    if (p) return p.side;
    for (let s = 0; s < this.seats.length; s++) if (this.seats[s] && this.seats[s].id === socketId) return s;
    return null;
  }
  sideNames() { return [0, 1].map(s => (this.seats[s] && this.seats[s].name) || 'Player'); }
  pot() { let n = 0; for (const v of this.worth.values()) n += v; return n; }
  opponentOf(socketId) {
    for (const id of this.players.keys()) if (id !== socketId) return id;
    return null;
  }
  bySide(side) {
    for (const p of this.players.values()) if (p.side === side) return p;
    return null;
  }

  removePlayer(socketId) {
    if (!this.players.has(socketId)) return;
    if (this.state === 'over' || this.state === 'waiting') { this.players.delete(socketId); return; }
    /* Walking out of a race ends it, and the one still here wins it, unless their car is already in a
       crash the judging had not reached yet (their own timeline ran ahead): then both are out, a draw
       that hands BOTH seats their own stake back, so it is settled while the leaver still has a seat
       (netcode review 2026-10-27; it used to hand a crashed car the race). */
    const restIds = [...this.players.keys()].filter(id => id !== socketId);
    const stay = restIds.length === 1 ? this.players.get(restIds[0]) : null;
    if (stay && !stay.car.alive) {
      this.finish(null, 'both out');
      this.players.delete(socketId);
      return;
    }
    this.players.delete(socketId);
    this.finish(stay ? restIds[0] : null, 'opponent left');
  }

  /* A chat line from a seated player to both players and the watchers, by seat
     (the same rules as KnockoutRoom.chat). */
  chat(socketId, raw, guard, now) {
    const p = this.players.get(socketId);
    if (!p) return { ok: false, note: null };
    const r = guard.check(socketId, raw, now);
    if (!r.ok) return { ok: false, note: r.note || null };
    this.broadcast('sw:chat', { name: String(p.name || 'Player').slice(0, 24), side: p.side, text: r.text });
    return { ok: true };
  }

  /* ── the race ───────────────────────────────────────────────────────────── */

  start(now) {
    if (this.players.size < 2) return false;
    this.state = 'countdown';
    this.goAt = nowOr(now) + S.COUNTDOWN_MS;
    this.spawner.run(this.traffic, 0, 0, S.V0, null);
    this.broadcast('sw:start', this.startState(now));
    return true;
  }

  startState(now) {
    return {
      id: this.id,
      state: this.state,
      goIn: Math.max(0, this.goAt - nowOr(now)),
      /* The server's clock (ms) and when the race goes on it: with sw:ping the page lines its own clock up
         with these, so it runs its car on the server's ticks. */
      goAt: this.goAt,
      now: nowOr(now),
      tick: this.clock,
      vsBot: !!this.bot,
      stake: this.stake,
      pot: this.pot(),
      players: [...this.players.entries()].map(([id, p]) => ({
        id: this.publicId(id), side: p.side, name: p.name, skin: p.skin || null,
      })),
      cars: this.traffic.all(),
      p: this.carRows(),
    };
  }

  /* An input packet: { t: the last tick it covers, k: [codes for t-k.length+1 .. t] }.
     Anything malformed is dropped whole; ticks already simulated, or too far
     ahead of the clock, are ignored. A person only ever sets their own car. */
  input(socketId, msg) {
    const p = this.players.get(socketId);
    if (!p || p.bot || this.state !== 'racing' || !p.car.alive) return false;
    if (!msg || typeof msg !== 'object') return false;
    const t = msg.t, k = msg.k;
    if (!Number.isInteger(t) || !Array.isArray(k) || k.length < 1 || k.length > 12) return false;
    if (t > this.clock + LEAD_MAX) return false;
    const first = t - k.length + 1;
    for (let i = 0; i < k.length; i++) {
      const tick = first + i;
      const code = k[i];
      if (tick < p.car.tick || !S.validInput(code)) continue;
      p.codes[tick % HIST] = code;
      p.codeTick[tick % HIST] = tick;
      if (tick > p.heard) p.heard = tick;
    }
    return true;
  }

  codeFor(p, tick) {
    if (p.codeTick[tick % HIST] === tick) return p.codes[tick % HIST];
    return p.last;
  }

  /* Move one seat's car on, as far as its inputs (or the lag allowance) let it. */
  advance(p, opp) {
    const car = p.car;
    if (p.bot) {
      while (car.tick < this.clock) {
        const code = p.bot.input(car, this.traffic, car.tick, opp ? opp.car : null);
        p.last = code;
        this.stepCar(p, code);
      }
      return;
    }
    /* The lag floor runs on this.floor, not the clock: after a server stall the clock jumps, and the
       inputs that were sent in time are still waiting to be read, so nobody is driven blind for it
       (Fable review 2026-10-27: a GC pause must not decide a paid race). */
    const upTo = Math.min(this.clock, Math.max(p.heard + 1, this.floor - LAG_MAX));
    while (car.tick < upTo) {
      const code = this.codeFor(p, car.tick);
      p.last = code;
      this.stepCar(p, code);
    }
  }

  stepCar(p, code) {
    const car = p.car;
    S.step(car, code, this.traffic);
    p.zHist[car.tick % HIST] = car.z;
  }

  /* Compare the two cars on every tick both have reached. Returns true once it is decided. */
  judge() {
    const [a, b] = [this.bySide(0), this.bySide(1)];
    if (!a || !b) return false;
    const ca = a.car, cb = b.car;
    // The tick each car's history is good up to: a crashed car's stays put after the crash.
    const reachA = ca.alive ? ca.tick : Infinity;
    const reachB = cb.alive ? cb.tick : Infinity;
    const upTo = Math.min(reachA, reachB, ca.alive || cb.alive ? Infinity : Math.max(ca.crashTick, cb.crashTick));
    const crashA = ca.alive ? Infinity : ca.crashTick;
    const crashB = cb.alive ? Infinity : cb.crashTick;
    const zA = (t) => a.zHist[Math.min(t, ca.alive ? t : ca.crashTick) % HIST];
    const zB = (t) => b.zHist[Math.min(t, cb.alive ? t : cb.crashTick) % HIST];
    /* Never further back than the history still holds (a stall longer than HIST ticks). */
    const oldest = Math.min(ca.tick, cb.tick) - HIST + 2;
    for (let t = Math.max(this.judged + 1, oldest); t <= upTo && t < Infinity; t++) {
      const hitA = crashA === t, hitB = crashB === t;
      if (hitA || hitB) {
        this.endTick = t;
        if (hitA && hitB) this.finish(null, 'both crashed');
        else this.finish(hitA ? this.seats[1].id : this.seats[0].id, 'crashed');
        return true;
      }
      const gap = zA(t) - zB(t);
      if (gap >= S.BEHIND_LOSE || -gap >= S.BEHIND_LOSE) {
        this.endTick = t;
        this.finish(gap > 0 ? this.seats[0].id : this.seats[1].id, 'fell behind');
        return true;
      }
      this.judged = t;
      if (t >= MAX_TICKS) { this.endTick = t; this.finish(null, 'time'); return true; }
    }
    return false;
  }

  tick(now) {
    const t = nowOr(now);
    if (this.state === 'countdown') {
      if (t < this.goAt) return;
      this.state = 'racing';
      this.broadcast('sw:go', { tick: 0 });
    }
    if (this.state !== 'racing') return;
    const clock = Math.floor((t - this.goAt) / S.TICK_MS);
    if (clock <= this.clock && this.clock > 0) return;
    const from = this.clock;
    this.clock = Math.max(this.clock, clock);
    /* At most two ticks a call: in steady running (a call a tick) it is the clock, and after a stall
       it catches up one tick a call while the queued inputs are read. */
    this.floor = Math.min(this.clock, this.floor + 2);
    const [a, b] = [this.bySide(0), this.bySide(1)];
    /* Traffic first, filled to the horizon past whoever is in front. */
    const lead = !a ? b : !b ? a : (a.car.z >= b.car.z ? a : b);
    if (lead) this.spawner.run(this.traffic, this.clock, lead.car.z, lead.car.v, this.fresh);
    if (a) this.advance(a, b);
    if (b) this.advance(b, a);
    if (this.judge()) return;
    // Forget what is well behind the rear car: nobody can reach it again.
    if (a && b) this.traffic.prune(Math.min(a.car.z, b.car.z) - PRUNE_BEHIND, this.clock);
    if (Math.floor(this.clock / SNAP_EVERY) !== Math.floor(from / SNAP_EVERY)) this.snapshot();
    if (this.fresh.length && Math.floor(this.clock / CARS_EVERY) !== Math.floor(from / CARS_EVERY)) {
      const add = this.fresh; this.fresh = [];
      this.broadcast('sw:cars', { add });
    }
  }

  /* [side, tick, z, x, v, vx, alive, wall] per seat. Full precision: a screen
     compares its own row to its prediction for that tick. */
  carRows() {
    const out = [];
    for (const p of this.players.values()) {
      const c = p.car;
      out.push([p.side, c.tick, c.z, c.x, c.v, c.vx, c.alive ? 1 : 0, c.wall]);
    }
    return out;
  }

  snapshot() {
    const msg = { T: this.clock, p: this.carRows() };
    if (this.io && this.io.to) {
      try { this.io.to(this.socketRoomName).volatile.emit('sw:s', msg); } catch (_) {}
      if (this.watchers > 0) { try { this.io.to(this.watchRoomName).volatile.emit('sw:s', msg); } catch (_) {} }
    }
  }

  finish(winnerId, why) {
    if (this.state === 'over') return;
    this.state = 'over';
    this.winner = winnerId || null;
    this.overWhy = why || '';
    const pot = this.pot();
    const seats = [...this.players.entries()].map(([id, p]) => ({
      id, name: p.name, wallet: p.wallet, worth: this.worth.get(id) || 0,
      refund: refundBound(this.worth.get(id) || 0, p.paid),
    }));
    /* EXACTLY ONCE PER TABLE (KnockoutRoom.finish): a crash, the 200 m rule, a
       draw and somebody closing the tab all come through here. */
    if (!this.settled) {
      this.settled = true;
      if (pot > 0 && typeof this.onSettled === 'function') {
        try {
          this.onSettled({ roomId: this.id, winnerId: winnerId || null, why: why || '', pot, seats });
        } catch (e) { console.error('[SW] settle hook failed:', e.message); }
      }
    }
    const winSide = winnerId ? this.sideOf(winnerId) : null;
    /* The card's money, keyed by seat ('s0', 's1') so no socket id goes out. */
    const bySeat = seats.map(s => Object.assign({}, s, { id: 's' + this.sideOf(s.id) }));
    const cars = [0, 1].map(s => { const p = this.bySide(s); return p ? { z: Math.round(p.car.z), v: Math.round(p.car.v * 3.6) } : null; });
    this.broadcast('sw:over', {
      winner: winnerId ? ((this.players.get(winnerId) || {}).name || (this.seats[winSide] || {}).name || null) : null,
      winnerSide: winSide,
      why: this.overWhy,
      tick: this.endTick || this.clock,
      stake: this.stake,
      pot,
      cars,
      money: duelMoney({ winnerId: winSide === null ? null : 's' + winSide, pot, seats: bySeat }),
    });
  }

  broadcast(event, payload) {
    if (this.io && this.io.to) {
      try { this.io.to(this.socketRoomName).emit(event, payload); } catch (_) {}
      if (this.watchers > 0) {
        try {
          const out = this.forWatchers(event, payload);
          if (out) this.io.to(this.watchRoomName).emit(event, out);
        } catch (e) { console.error('[SW] watcher send failed:', e.message); }
      }
    }
  }

  /* What a watcher is sent: the same moments, with every id gone. Copied by
     name, so a field added to a player message later does not reach a
     watcher until somebody adds it here. */
  forWatchers(event, p) {
    if (!p) return null;
    switch (event) {
      case 'sw:start': return this.watchState(p);
      case 'sw:go': return { tick: 0 };
      case 'sw:cars': return { add: p.add };
      case 'sw:chat': return { name: p.name, side: p.side, text: p.text };
      case 'sw:over':
        return { winner: p.winner, winnerSide: p.winnerSide, why: p.why, tick: p.tick, stake: p.stake, pot: p.pot, cars: p.cars };
      default: return null;
    }
  }

  watchState(ps) {
    return {
      id: ps.id, state: ps.state, goIn: ps.goIn, goAt: ps.goAt, now: ps.now, tick: ps.tick, stake: ps.stake, pot: ps.pot,
      players: (ps.players || []).map(q => ({ side: q.side, name: q.name, skin: q.skin || null })),
      cars: ps.cars, p: ps.p,
    };
  }

  /* Everything a watcher needs the moment they arrive, which may be a minute in. */
  watchSnapshot(now) {
    return this.watchState(this.startState(now));
  }
}

module.exports = { SwimRoom, LAG_MAX, LEAD_MAX, MAX_TICKS, HIST };
