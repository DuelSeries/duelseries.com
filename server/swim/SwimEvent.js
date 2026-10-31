'use strict';
/* ─── Swim Race: the scheduled event ───────────────────────────────────────────
   Owen 2026-10-30: "if 20 players join, there's going to be 20 lanes". Every
   SWIM_EVENT_EVERY_HOURS (shared/constants.js) the race starts on the Eastern
   wall clock; until then anyone may join (the door opens SWIM_EVENT_OPEN_MS
   before). At the start the road gets one lane per entrant (at most MAX_FIELD;
   past that a join is told "Event full"), everyone on the start line in a lane
   of their own, a 10 second countdown, then go. Fewer than MIN_FIELD people
   and bots fill the road up to MIN_FIELD, the duel's own driver
   (server/swim/swimBot.js) through a four-lane window (BotSeat below). Nobody
   at all and the race does not run.

   THE RULES. One touch of traffic and you are out, as in the duel. The race
   is won by the first car WIN_LEAD metres ahead of every other car still in
   it, or by the last car still in it. And a car OUT_BEHIND metres behind the
   leader is out too: the traffic only ever comes from ahead, so a car that
   parked would never be hit and would outlast everyone who drove (the duel
   has its 200 m rule for the same reason, "stopping never wins"). Cars pass through each other (the
   duel's rule). Free, no prize: what the race decides is the places, and the
   top three go on the Events tab's podium. A prize can be added later at
   finish(), where the winner and every place are known once, exactly once.

   SERVER AUTHORITATIVE, AS THE DUEL (server/swim/SwimRoom.js has the why).
   Each car runs on its own timeline at the tick its inputs have reached,
   judged against the traffic on each of its own ticks; a person's car never
   trails the clock by more than LAG_MAX ticks (then it is driven on with its
   last input). Knockouts and the lead are judged only on ticks every car
   still in the race has reached, so nobody's latency decides anybody else's
   race. The road (shared/swimSim.js Traffic with N lanes) and its traffic
   (server/swim/swimTraffic.js Spawner with N lanes) are the duel's, wider.

   WHAT THE SCREENS ARE SENT (one socket.io room for racers and watchers).
     se:lobby  while waiting, on a change and every few seconds: how many are in
     se:start  once: the road, the seats (names, cars), the traffic so far
     se:you    to a racer's own socket: its seat and its reconnect key
     se:s      10 a second, volatile: every car (seat, tick, z, x, v, vx, alive,
               wall, cool), exactly (the event's cars are kept on a grid,
               shared/swimSim.js quantize, so a row is a few digits). A
               racer's screen checks its own prediction against its own row
               and takes the row when they differ. One message for
               everybody, so each socket is written once, not once for the
               field and again for its own car: on 50 sockets the writes are
               most of what a race tick costs (measured 2026-10-30).
     se:cars   4 a second, reliable: traffic records new since the last one
     se:ko     a car is out: who, their place, where
     se:over   once: the winner, why, every place
   No socket ids in anything broadcast: seats (lanes) only. */

const crypto = require('crypto');
const S = require('../../shared/swimSim');
const { Spawner } = require('./swimTraffic');
const { SwimBot, SERVER_BUDGET } = require('./swimBot');
const SwimLooks = require('../../shared/swimLooks');
const { pickName } = require('../botNames');
const { newResumeKey } = require('../duelQueue');

const MAX_FIELD = 50;          // lanes at most (Owen 2026-10-30: "cap it at 50 for now")
const MIN_FIELD = 8;           // bots fill the road to this many cars
const COUNTDOWN_MS = 10000;    // the 10 seconds on the start line
const WIN_LEAD = 500;          // metres ahead of every other car still in the race
const OUT_BEHIND = 1000;       // metres behind the leader that puts a car out
const LAG_MAX = 15, LEAD_MAX = 20, HIST = 1024;
const SNAP_EVERY = 6;          // ticks between se:s (10 a second)
/* The screens get se:s in SNAP_GROUPS groups, each on its own tick of the six (0, 2, 4), so the writes to 50
   sockets are spread over three ticks instead of piling into one (measured 2026-10-30: one socket write is most
   of what a snapshot costs, and 50 of them in one tick took 10 ms on a Windows PC). Each group's rows are the
   cars on the tick it is sent. */
const SNAP_GROUPS = 3;
const CARS_EVERY = 15;         // ticks between se:cars (4 a second), 3 ticks off se:s so the two never share a tick
const PRUNE_BEHIND = 120;      // metres behind the rearmost car still racing that traffic is forgotten
/* Traffic is forgotten this far behind the leader even while a car is still back there: a guard on memory (a
   car that far back cannot win unless every car ahead crashes, and still has its own road to drive). */
const KEEP_BEHIND = 2500;
const MAX_TICKS = 10 * 60 * S.HZ;   // ten minutes and nobody has pulled away: the leader wins
const OVER_MS = 45000;         // the results stay up this long before the doors reopen
const GRACE_MS = 5000;         // a racer's dropped connection is held this long (the duel's 5 s)
const LOBBY_EVERY_MS = 3000;
const PERF_N = 1800;           // ticks the meter keeps (30 s)

let nextRace = 1;

/* A bot drives a four-lane window of the wide road, the carriageway its lane is in: lanes 4k to 4k + 3 are the
   duel's road exactly (same lane speeds, no lane change crosses into or out of them), so the duel's driver runs
   on it unchanged, seeing the records moved over by 4k lanes and its car by 4k * 3.6 m. A road whose lane count
   is not a multiple of four has a narrower last carriageway; bots are only ever seated in full ones (pickLanes).
   Its car is shown to it inside its four lanes' barriers: the real road goes on past them, so a car that drifts
   over the line is still one the driver knows how to steer back. It shares the server's one CPU budget for bot
   searching with every duel's bot (swimBot.js SERVER_BUDGET), as SwimRoom's bots do. */
class BotSeat {
  constructor(lane, seed, opts) {
    this.base = lane & ~3;
    this.dx = this.base * S.LANE_W;
    this.win = new S.Traffic(4);
    this.bot = new SwimBot(S.rng(seed), { budget: opts && opts.noBudget ? null : SERVER_BUDGET });
    this.view = S.newCar(0);
    this.opp = S.newCar(1);
  }
  covers(lane) { return lane >= this.base && lane < this.base + 4; }
  see(rec) {
    if (!this.covers(rec[1])) return;
    const r = rec.slice();
    r[1] -= this.base;
    if (r.length === 8) r[7] -= this.base;
    this.win.add(r);
  }
  input(car, tick, rival) {
    const v = S.copyCar(car, this.view);
    v.x = car.x - this.dx;
    if (v.x > S.WALL) { v.x = S.WALL; if (v.vx > 0) v.vx = 0; } else if (v.x < -S.WALL) { v.x = -S.WALL; if (v.vx < 0) v.vx = 0; }
    let opp = null;
    if (rival) { opp = S.copyCar(rival, this.opp); opp.x = rival.x - this.dx; }
    return this.bot.input(v, this.win, tick, opp);
  }
}

class SwimEvent {
  /* opts (tests and tools): { now: () => ms, manual: no timer of its own, maxTicks: a shorter cap } */
  constructor(io, opts) {
    this.io = io;
    this.opts = opts || {};
    this.channel = 'swev';
    this.joins = 0;             // round robin into the snapshot groups (SNAP_GROUPS)
    this.entrants = new Map();  // socketId -> { socket, name, wallet, look, at }
    this.doorOpen = false;      // index.js opens it SWIM_EVENT_OPEN_MS before the slot
    this.reset();
    this.last = null;           // the last race's result (podium), kept across races; index.js persists it
    this.timer = null;
    this.lobbyAt = 0;
    this.lobbyDirty = true;
  }

  reset() {
    this.state = 'waiting';     // waiting | countdown | racing | over
    this.id = 'se' + (nextRace++);
    this.racers = [];           // by seat (= lane)
    this.bySocket = new Map();  // socketId -> racer
    this.keys = new Map();      // reconnect key -> racer
    this.lanes = 0;
    this.goAt = 0;
    this.clock = 0;
    this.floor = 0;
    this.judged = 0;
    this.out = 0;               // racers out so far
    this.fresh = [];
    this.traffic = null;
    this.spawner = null;
    this.botSeats = [];
    this.winner = null;
    this.overMsg = null;
    this.overAt = 0;
    this.endTick = 0;
  }

  now() { return this.opts.now ? this.opts.now() : Date.now(); }

  /* ── the door ──────────────────────────────────────────────────────────── */

  /* A person asks to race. Returns { ok } or { ok: false, why } in words for the page. `wallet` is only what the
     page claimed (nothing here proves it): kept for a prize later, which must prove it first, as the battle
     royale's does (play:identify), and never used for anything now. */
  join(socket, name, wallet, look) {
    if (!socket || typeof socket.id !== 'string') return { ok: false, why: 'not connected' };
    if (this.state !== 'waiting') return { ok: false, why: this.state === 'over' ? 'the race just ended' : 'the race has started', started: true };
    if (!this.doorOpen) return { ok: false, why: 'joining opens before the start', closed: true };
    if (this.entrants.has(socket.id)) return { ok: true, again: true };
    if (this.entrants.size >= MAX_FIELD) return { ok: false, why: 'Event full', full: true };
    if (wallet) for (const e of this.entrants.values()) if (e.wallet === wallet) return { ok: false, why: 'you are already in this race', twice: true };
    this.entrants.set(socket.id, { socket, name: name || 'Player', wallet: wallet || null, look: SwimLooks.clean(look), at: this.now() });
    this.enter(socket);
    this.lobbyDirty = true;
    return { ok: true };
  }

  leave(socketId) {
    if (this.entrants.delete(socketId)) this.lobbyDirty = true;
    const r = this.bySocket.get(socketId);
    if (r && !r.bot && (this.state === 'countdown' || this.state === 'racing') && r.car.alive && !r.outPlace) {
      this.knockOut(r, 'left');
    }
  }

  /* The socket went: a waiting entrant is simply gone; a racer's seat is held GRACE_MS for its reconnect, its car
     driven straight with no pedal meanwhile (the duel's rule). */
  drop(socketId) {
    if (this.state === 'waiting') { this.leave(socketId); return; }
    const r = this.bySocket.get(socketId);
    if (!r || r.bot || r.outPlace || (this.state !== 'countdown' && this.state !== 'racing')) return;
    r.away = this.now() + GRACE_MS;
    r.last = S.NEUTRAL;
  }

  /* A reconnect that shows its seat's key takes the seat over on the new socket. */
  rejoin(socket, key) {
    if (typeof key !== 'string' || !this.keys.has(key)) return null;
    const r = this.keys.get(key);
    if (!r || r.bot || (this.state !== 'countdown' && this.state !== 'racing')) return null;
    if (this.bySocket.has(socket.id)) return null;
    this.bySocket.delete(r.id);
    r.id = socket.id; r.socket = socket; r.away = 0;
    this.bySocket.set(socket.id, r);
    this.enter(socket);
    this.issueKey(r);
    return r;
  }

  issueKey(r) {
    if (r.key) this.keys.delete(r.key);
    r.key = newResumeKey();
    this.keys.set(r.key, r);
    try { r.socket.emit('se:you', { seat: r.seat, key: r.key, id: this.id }); } catch (_) {}
  }

  /* Into the race's channel, and one of its snapshot groups. */
  enter(socket) {
    if (!socket.join) return;
    socket.join(this.channel);
    socket.join(this.channel + ':' + (this.joins++ % SNAP_GROUPS));
  }

  watch(socket) {
    this.enter(socket);
    try { socket.emit('se:state', this.publicState(true)); } catch (_) {}
  }
  unwatch(socket) {
    if (this.entrants.has(socket.id) || this.bySocket.has(socket.id)) return;
    if (socket.leave) try { socket.leave(this.channel); for (let g = 0; g < SNAP_GROUPS; g++) socket.leave(this.channel + ':' + g); } catch (_) {}
  }

  /* ── the start ─────────────────────────────────────────────────────────── */

  /* Which lane each car gets: people in random lanes across the whole road, then bots in the lanes left, in full
     carriageways only (BotSeat). With fewer than MIN_FIELD people the road is MIN_FIELD lanes, all full. */
  pickLanes(people, bots, lanes, rand) {
    const order = [];
    for (let l = 0; l < lanes; l++) order.push(l);
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = order[i]; order[i] = order[j]; order[j] = t; }
    const full = (l) => (l & ~3) + 4 <= lanes;
    /* Bots first take the lanes in full carriageways, then people take what is left. */
    const botLanes = [], rest = [];
    for (const l of order) (botLanes.length < bots && full(l) ? botLanes : rest).push(l);
    return { botLanes, personLanes: rest.slice(0, people) };
  }

  /* The slot: build the road and the field and start the 10 s countdown. Returns why not, or ''. */
  start(why, fill) {
    if (this.state !== 'waiting') return 'not waiting';
    const people = [...this.entrants.entries()].slice(0, MAX_FIELD);
    if (!people.length && !(fill > 0)) { this.entrants.clear(); return 'nobody joined'; }
    const want = Math.min(MAX_FIELD, Math.max(fill > 0 ? fill : 0, people.length, MIN_FIELD));
    const lanes = want;
    const bots = lanes - people.length;
    const seed = crypto.randomBytes(4).readUInt32LE(0);
    const rand = S.rng(seed ^ 0x9e3779b9);
    const { botLanes, personLanes } = this.pickLanes(people.length, bots, lanes, rand);
    this.lanes = lanes;
    this.traffic = new S.Traffic(lanes);
    /* How far back a car may still be coming when a lane change's room must last: the whole lead that wins. */
    this.spawner = new Spawner(seed, { lanes, behind: WIN_LEAD + 100 });
    this.racers = new Array(lanes).fill(null);
    const taken = new Set(people.map(([, e]) => String(e.name).toLowerCase()));
    people.forEach(([id, e], i) => this.seat(personLanes[i], { id, socket: e.socket, name: e.name, wallet: e.wallet, look: e.look }));
    botLanes.forEach((lane, i) => {
      const name = pickName(rand(), { maxLen: 16, taken: (n) => taken.has(n) });
      taken.add(name.toLowerCase());
      const bs = new BotSeat(lane, seed + 7919 * (i + 1));
      this.botSeats.push(bs);
      this.seat(lane, { id: 'bot_' + this.id + '_' + lane, socket: null, name, wallet: null,
        look: SwimLooks.clean({ car: SwimLooks.CARS[(seed + i) % SwimLooks.CARS.length].id }), bot: bs });
    });
    this.entrants.clear();
    this.state = 'countdown';
    this.why = why || '';
    this.goAt = this.now() + COUNTDOWN_MS;
    this.feed(this.spawner, 0, 0, S.V0);
    this.broadcast('se:start', this.publicState(false));
    this.fresh = [];                                  // all of it went in se:start
    for (const r of this.racers) if (r && !r.bot) this.issueKey(r);
    this.ensureTimer();
    return '';
  }

  seat(lane, p) {
    const car = S.newCar(0);
    car.x = S.laneX(lane);
    S.quantize(car);
    const r = {
      seat: lane, id: p.id, socket: p.socket, name: p.name, wallet: p.wallet, look: p.look, bot: p.bot || null,
      car, codes: new Int16Array(HIST).fill(-1), codeTick: new Int32Array(HIST).fill(-1), heard: -1, last: S.NEUTRAL,
      zHist: new Float64Array(HIST), key: null, away: 0, outPlace: 0, outTick: -1, outWhy: '', outZ: 0,
    };
    this.racers[lane] = r;
    if (!r.bot) this.bySocket.set(p.id, r);
  }

  /* Run the spawner and hand every new record to the bots' windows. */
  feed(spawner, tick, leadZ, leadV) {
    const before = this.fresh.length;
    spawner.run(this.traffic, tick, leadZ, leadV, this.fresh);
    for (let i = before; i < this.fresh.length; i++) for (const b of this.botSeats) b.see(this.fresh[i]);
  }

  /* ── the race ──────────────────────────────────────────────────────────── */

  input(socketId, msg) {
    const r = this.bySocket.get(socketId);
    if (!r || this.state !== 'racing' || !r.car.alive || r.outPlace) return false;
    if (!msg || typeof msg !== 'object') return false;
    const t = msg.t, k = msg.k;
    if (!Number.isInteger(t) || !Array.isArray(k) || k.length < 1 || k.length > 12) return false;
    if (t > this.clock + LEAD_MAX) return false;
    const first = t - k.length + 1;
    for (let i = 0; i < k.length; i++) {
      const tick = first + i, code = k[i];
      if (tick < r.car.tick || !S.validInput(code)) continue;
      r.codes[tick % HIST] = code;
      r.codeTick[tick % HIST] = tick;
      if (tick > r.heard) r.heard = tick;
    }
    return true;
  }

  codeFor(r, tick) {
    if (r.codeTick[tick % HIST] === tick) return r.codes[tick % HIST];
    return r.away ? S.NEUTRAL : r.last;
  }

  /* Move one car on as far as its inputs (or the lag allowance) let it. A car that is out stays where it was. */
  advance(r, rival) {
    const car = r.car;
    if (!car.alive || r.outPlace) return;
    if (r.bot) {
      while (car.tick < this.clock && car.alive) {
        const code = r.bot.input(car, car.tick, rival ? rival.car : null);
        r.last = code;
        this.stepCar(r, code);
      }
      return;
    }
    const upTo = Math.min(this.clock, Math.max(r.heard + 1, this.floor - LAG_MAX));
    while (car.tick < upTo && car.alive) {
      const code = this.codeFor(r, car.tick);
      r.last = code;
      this.stepCar(r, code);
    }
  }

  stepCar(r, code) {
    S.quantize(S.step(r.car, code, this.traffic));   // on the grid both ends keep (shared/swimSim.js quantize)
    r.zHist[r.car.tick % HIST] = r.car.z;
  }

  zOf(r, t) {
    const c = r.car;
    if (!c.alive && t >= c.crashTick) return r.zHist[c.crashTick % HIST];
    return r.zHist[t % HIST];
  }

  /* A car is out: its place is the number of cars still in the race before it went (the last car out on a tick
     gets the better place when two go on the same tick: the one further down the road). */
  knockOut(r, why, t) {
    if (r.outPlace) return;
    const standing = this.racers.filter(q => q && !q.outPlace).length;
    r.outPlace = standing;
    r.outTick = t === undefined ? this.judged : t;
    r.outWhy = why;
    r.outZ = Math.round(r.car.z);
    if (r.car.alive) { r.car.alive = false; r.car.crashTick = r.outTick; }
    this.out++;
    this.broadcast('se:ko', { seat: r.seat, name: r.name, place: r.outPlace, why, z: r.outZ, tick: r.outTick, left: standing - 1 });
  }

  /* Judge every tick every car still in the race has reached: knockouts, then the lead, then the last car. */
  judge() {
    const live = this.racers.filter(r => r && !r.outPlace);
    if (!live.length) return false;
    let upTo = Infinity, lastCrash = -1;
    for (const r of live) {
      if (r.car.alive) { if (r.car.tick < upTo) upTo = r.car.tick; }
      else if (r.car.crashTick > lastCrash) lastCrash = r.car.crashTick;
    }
    if (upTo === Infinity) upTo = lastCrash;
    const oldest = this.clock - HIST + 2;
    for (let t = Math.max(this.judged + 1, oldest); t <= upTo; t++) {
      const going = this.racers.filter(r => r && !r.outPlace);
      const hit = going.filter(r => !r.car.alive && r.car.crashTick === t).sort((a, b) => this.zOf(a, t) - this.zOf(b, t));
      if (hit.length === going.length) {
        /* Every car left went out on the same tick: the one furthest down the road wins it. */
        const best = hit.pop();
        for (const r of hit) this.knockOut(r, 'crashed', t);
        this.endTick = t;
        this.finish(best, 'last car');
        return true;
      }
      for (const r of hit) this.knockOut(r, 'crashed', t);
      const still = going.filter(r => !r.outPlace);
      if (still.length === 1 && this.racers.filter(Boolean).length > 1) {
        this.endTick = t;
        this.finish(still[0], 'last car');
        return true;
      }
      let a = null, za = -Infinity, zb = -Infinity;
      for (const r of still) {
        const z = this.zOf(r, t);
        if (z > za) { zb = za; za = z; a = r; } else if (z > zb) zb = z;
      }
      if (still.length > 1 && za - zb >= WIN_LEAD) { this.endTick = t; this.finish(a, 'lead'); return true; }
      /* Too far behind the leader: out, the furthest back first (it went out first). */
      const behind = still.filter(r => za - this.zOf(r, t) >= OUT_BEHIND).sort((x, y) => this.zOf(x, t) - this.zOf(y, t));
      if (behind.length) {
        for (const r of behind) this.knockOut(r, 'fell behind', t);
        const left = still.filter(r => !r.outPlace);
        if (left.length === 1) { this.endTick = t; this.finish(left[0], 'last car'); return true; }
      }
      this.judged = t;
      if (t >= (this.opts.maxTicks || MAX_TICKS)) { this.endTick = t; this.finish(a, 'time'); return true; }
    }
    return false;
  }

  tick(now) {
    const t = typeof now === 'number' ? now : this.now();
    if (this.state === 'waiting') {
      if (this.lobbyDirty || t - this.lobbyAt >= LOBBY_EVERY_MS) this.lobby(t);
      return;
    }
    if (this.state === 'over') {
      if (t - this.overAt >= OVER_MS) { this.reset(); this.lobby(t); }
      return;
    }
    if (this.state === 'countdown') {
      this.dueAway(t);
      if (t < this.goAt) return;
      this.state = 'racing';
      this.broadcast('se:go', { tick: 0 });
    }
    const clock = Math.floor((t - this.goAt) / S.TICK_MS);
    if (clock <= this.clock && this.clock > 0) return;
    const from = this.clock;
    this.clock = Math.max(this.clock, clock);
    this.floor = Math.min(this.clock, this.floor + 2);
    this.dueAway(t);
    /* The leader and the rearmost car still racing: traffic fills to the horizon past the one, and is forgotten
       well behind the other. */
    let lead = null, rear = Infinity;
    for (const r of this.racers) {
      if (!r || r.outPlace) continue;
      if (!lead || r.car.z > lead.car.z) lead = r;
      if (r.car.z < rear) rear = r.car.z;
    }
    if (lead) this.feed(this.spawner, this.clock, lead.car.z, lead.car.v);
    /* A bot keeps an eye on the car in front of the field (or the second, when it is the one in front). */
    let second = null;
    for (const r of this.racers) if (r && !r.outPlace && r !== lead && (!second || r.car.z > second.car.z)) second = r;
    for (const r of this.racers) if (r) this.advance(r, r === lead ? second : lead);
    if (this.judge()) return;
    if (lead) {
      const minZ = Math.max(rear, lead.car.z - KEEP_BEHIND) - PRUNE_BEHIND;
      this.traffic.prune(minZ, this.clock);
      for (const b of this.botSeats) b.win.prune(minZ, this.clock);
    }
    /* Each group on its own tick of the six: group g when the tick, less 2g, crosses a multiple of six. */
    for (let g = 0; g < SNAP_GROUPS; g++) {
      const o = 2 * g;
      if (Math.floor((this.clock - o) / SNAP_EVERY) !== Math.floor((from - o) / SNAP_EVERY)) this.snapshot(g);
    }
    if (this.fresh.length && Math.floor((this.clock + 3) / CARS_EVERY) !== Math.floor((from + 3) / CARS_EVERY)) {
      const add = this.fresh; this.fresh = [];
      this.broadcast('se:cars', { add });
    }
  }

  dueAway(t) {
    for (const r of this.racers) if (r && r.away && t >= r.away && !r.outPlace) { r.away = 0; this.knockOut(r, 'left'); }
  }

  /* ── what goes out ─────────────────────────────────────────────────────── */

  /* [seat, tick, z, x, v, vx, alive, wall, cool], exact: the cars are on the grid (stepCar). */
  row(r) {
    const c = r.car;
    return [r.seat, c.tick, c.z, c.x, c.v, c.vx, c.alive && !r.outPlace ? 1 : 0, c.wall, c.cool];
  }
  snapshot(g) {
    const p = [];
    for (const r of this.racers) if (r) p.push(this.row(r));
    if (this.io && this.io.to) { try { this.io.to(this.channel + ':' + g).volatile.emit('se:s', { T: this.clock, p }); } catch (_) {} }
  }

  /* Everything a screen needs at the start, or arriving late (a watcher, a rejoin). `late`: a full picture. */
  publicState(late) {
    const base = { id: this.id, state: this.state, now: this.now(), last: this.last };
    if (this.state === 'waiting') return Object.assign(base, this.lobbyMsg());
    if (this.state === 'over') return Object.assign(base, { over: this.overMsg, lanes: this.lanes });
    const out = Object.assign(base, {
      lanes: this.lanes, goAt: this.goAt, tick: this.clock, winLead: WIN_LEAD, outBehind: OUT_BEHIND,
      seats: this.racers.filter(Boolean).map(r => ({ seat: r.seat, name: r.name, car: r.look.car, out: r.outPlace || 0 })),
      cars: this.traffic.all(),
      p: this.racers.filter(Boolean).map(r => this.row(r)),
    });
    if (late) out.ko = this.racers.filter(r => r && r.outPlace).map(r => ({ seat: r.seat, name: r.name, place: r.outPlace, why: r.outWhy, z: r.outZ }));
    return out;
  }

  lobbyMsg() {
    const names = [];
    for (const e of this.entrants.values()) names.push(e.name);
    return { n: this.entrants.size, max: MAX_FIELD, min: MIN_FIELD, open: this.doorOpen, names };
  }
  lobby(t) {
    this.lobbyAt = t; this.lobbyDirty = false;
    this.broadcast('se:lobby', this.lobbyMsg());
  }

  finish(winner, why) {
    if (this.state === 'over') return;
    const end = this.endTick || this.clock;
    /* Everyone still in the race is placed by how far down the road they were on the deciding tick. */
    const still = this.racers.filter(r => r && !r.outPlace && r !== winner).sort((a, b) => this.zOf(b, end) - this.zOf(a, end));
    if (winner) { winner.outPlace = 1; winner.outZ = Math.round(this.zOf(winner, end)); winner.outWhy = 'won'; }
    still.forEach((r, i) => { r.outPlace = 2 + i; r.outZ = Math.round(this.zOf(r, end)); r.outWhy = 'finished'; });
    this.state = 'over';
    this.overAt = this.now();
    const places = this.racers.filter(Boolean).sort((a, b) => a.outPlace - b.outPlace)
      .map(r => ({ seat: r.seat, name: r.name, place: r.outPlace, z: r.outZ, why: r.outWhy }));
    const podium = places.slice(0, 3).map(p => p.name);
    this.winner = winner || null;
    this.overMsg = {
      id: this.id, why, tick: end, lanes: this.lanes,
      winner: winner ? { seat: winner.seat, name: winner.name } : null,
      places, podium,
    };
    /* What the Events tab shows until the next race (display only: nothing reads it back for anything). */
    this.last = { id: this.id, at: this.overAt, lanes: this.lanes, why, podium, winner: winner ? winner.name : null,
      people: this.racers.filter(r => r && !r.bot).length };
    this.broadcast('se:over', this.overMsg);
    for (const r of this.racers) if (r && r.key) this.keys.delete(r.key);
    if (typeof this.onFinish === 'function') {
      /* The one place a prize would be paid from later: the winner's seat and wallet, known exactly once. */
      try { this.onFinish({ id: this.id, why, winner: winner ? { name: winner.name, wallet: winner.wallet, bot: !!winner.bot } : null, last: this.last }); }
      catch (e) { console.error('[SE] finish hook failed:', e.message); }
    }
  }

  /* An emergency stop (the owner, or a restart): the race is called off with no result. */
  abort(why) {
    if (this.state !== 'countdown' && this.state !== 'racing') return false;
    this.broadcast('se:over', { id: this.id, why: why || 'stopped', void: true, places: [], podium: [] });
    this.state = 'over';
    this.overAt = this.now() - OVER_MS + 5000;
    return true;
  }

  broadcast(event, payload) {
    if (this.io && this.io.to) { try { this.io.to(this.channel).emit(event, payload); } catch (_) {} }
  }
  volatile(event, payload) {
    if (this.io && this.io.to) { try { this.io.to(this.channel).volatile.emit(event, payload); } catch (_) {} }
  }

  ensureTimer() {
    if (this.timer || this.opts.manual) return;
    this.timer = setInterval(() => {
      const busy = this.state === 'countdown' || this.state === 'racing';
      const a = busy ? process.hrtime.bigint() : 0n;
      try { this.tick(); } catch (e) { console.error('[SE] tick failed:', e && e.stack ? e.stack : e); }
      if (busy) this.meter(Number(process.hrtime.bigint() - a) / 1e6);
    }, S.TICK_MS);
  }

  /* What a tick costs while a race is on (the last PERF_N ticks), for /api/debug/tick and the capacity runs. */
  meter(ms) {
    if (!this.ring) { this.ring = new Float64Array(PERF_N); this.ringN = 0; this.ringAt = 0; this.ticksRun = 0; this.worst = 0; }
    this.ring[this.ringAt] = ms;
    this.ringAt = (this.ringAt + 1) % PERF_N;
    if (this.ringN < PERF_N) this.ringN++;
    this.ticksRun++;
    if (ms > this.worst) this.worst = ms;
  }
  perf() {
    const n = this.ringN || 0;
    const v = n ? Array.from(this.ring.subarray(0, n)).sort((a, b) => a - b) : [];
    const q = (p) => (n ? Math.round(v[Math.min(n - 1, Math.floor(p * n))] * 1000) / 1000 : null);
    const sum = v.reduce((a, b) => a + b, 0);
    return { state: this.state, lanes: this.lanes, cars: this.racers.filter(Boolean).length,
      left: this.racers.filter(r => r && !r.outPlace).length, traffic: this.traffic ? this.traffic.size : 0,
      ticks: this.ticksRun || 0, avgMs: n ? Math.round(sum / n * 1000) / 1000 : null, p50Ms: q(0.5), p90Ms: q(0.9), p99Ms: q(0.99),
      over5: v.filter(x => x > 5).length,
      maxMs: n ? Math.round(v[n - 1] * 100) / 100 : null, worstMs: Math.round((this.worst || 0) * 100) / 100 };
  }
  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  /* For /api/live and the Events tab. */
  liveState() {
    const going = this.racers.filter(r => r && !r.outPlace).length;
    return {
      state: this.state, id: this.id, lanes: this.lanes, entrants: this.entrants.size, max: MAX_FIELD, min: MIN_FIELD,
      left: this.state === 'countdown' || this.state === 'racing' ? going : 0,
      people: this.state === 'waiting' ? this.entrants.size : this.racers.filter(r => r && !r.bot && !r.outPlace).length,
      goIn: this.state === 'countdown' ? Math.max(0, this.goAt - this.now()) : 0,
      podium: this.state === 'over' && this.overMsg ? this.overMsg.podium : (this.last ? this.last.podium : null),
      last: this.last,
    };
  }
  humanTotal() {
    if (this.state === 'waiting') return this.entrants.size;
    return this.racers.filter(r => r && !r.bot && !r.outPlace && !r.away).length;
  }
}

module.exports = { SwimEvent, BotSeat, MAX_FIELD, MIN_FIELD, COUNTDOWN_MS, WIN_LEAD, OUT_BEHIND, MAX_TICKS, OVER_MS, LAG_MAX, HIST };
