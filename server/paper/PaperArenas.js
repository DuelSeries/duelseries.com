'use strict';
// The Paper arena directory for this region (design 6.1): arenas per rung, the seat search
// with overflow arenas, the reconnect maps, the 60 s sweep and the lobby rows. Not a
// LobbyRegistry: its sweep would delete a paid room whatever money is on its floor.
const { PaperRoom } = require('./PaperRoom');
const { MP } = require('./ArenaGame');

const RUNGS = [0, 0.1, 1];

function keyOf(stake) {
  return Number(stake).toFixed(2);
}

class PaperArenas {
  constructor({ region = 'na', io = null, hooks, now = Date.now, paidEnabled = process.env.PAPER_PAID === '1', autoTick = true, warm = true, makeRoom } = {}) {
    this.region = region;
    this.io = io;
    this.hooks = hooks;
    this.now = now;
    this.paidEnabled = !!paidEnabled;
    this.autoTick = autoTick;
    this.makeRoom = makeRoom || ((opts) => new PaperRoom(opts));
    this.arenas = {};
    for (const s of RUNGS) this.arenas[keyOf(s)] = [];
    this.byKey = new Map(); // resumeKey -> seat
    this.bySocket = new Map(); // socketId -> seat
    this.emptySince = new Map(); // room -> ms
    const free = this._create(0, 0);
    if (warm && free) free.warmUp();
  }

  _create(stake, index) {
    const room = this.makeRoom({
      stake,
      region: this.region,
      index,
      io: this.io,
      hooks: this.hooks,
      now: this.now,
      directory: this,
      autoTick: this.autoTick
    });
    room.onClosed = (closed) => this._replace(closed);
    const list = this.arenas[keyOf(stake)];
    list.push(room);
    list.sort((a, b) => a.index - b.index);
    return room;
  }

  // An emergency-closed arena gives its index to a fresh one.
  _replace(closed) {
    const list = this.arenas[keyOf(closed.stake)];
    const i = list.indexOf(closed);
    if (i === -1) return;
    list.splice(i, 1);
    this.emptySince.delete(closed);
    this._create(closed.stake, closed.index);
  }

  _freeIndex(list) {
    const used = new Set(list.map((r) => r.index));
    let n = 0;
    while (used.has(n)) n++;
    return n;
  }

  // -> { room, spot } | null. A pure query unless it has to open an overflow arena.
  seatFor(stake, preferred) {
    const list = this.arenas[keyOf(stake)];
    if (!list) return null;
    if (preferred && list.includes(preferred) && !preferred.stopped && preferred.liveHumans < MP.MAX_HUMANS) {
      const spot = preferred.findSpawn();
      if (spot) return { room: preferred, spot };
    }
    const open = list
      .filter((r) => !r.stopped && r.liveHumans < MP.MAX_HUMANS)
      .sort((a, b) => b.liveHumans - a.liveHumans || (b.bank.floorMicro() > 0) - (a.bank.floorMicro() > 0) || a.index - b.index);
    for (const room of open) {
      const spot = room.findSpawn();
      if (spot) return { room, spot };
    }
    if (list.length < MP.MAX_ARENAS_PER_STAKE) {
      const room = this._create(Number(stake), this._freeIndex(list));
      const spot = room.findSpawn();
      if (spot) return { room, spot };
    }
    return null;
  }

  seatByKey(resumeKey) {
    const seat = this.byKey.get(resumeKey);
    return seat && !seat.room.stopped && !seat.unit.death ? seat : null;
  }

  seatOfSocket(socketId) {
    return this.bySocket.get(socketId) || null;
  }

  // Kept in step by the rooms.
  _seatAdded(seat) {
    this.byKey.set(seat.resumeKey, seat);
    if (seat.socketId) this.bySocket.set(seat.socketId, seat);
  }

  _seatSocket(seat, prevSocketId) {
    if (prevSocketId && this.bySocket.get(prevSocketId) === seat) this.bySocket.delete(prevSocketId);
    if (seat.socketId) this.bySocket.set(seat.socketId, seat);
  }

  _seatFreed(seat) {
    if (this.byKey.get(seat.resumeKey) === seat) this.byKey.delete(seat.resumeKey);
    for (const [sid, s] of this.bySocket) if (s === seat) this.bySocket.delete(sid);
  }

  all() {
    const out = [];
    for (const k of Object.keys(this.arenas)) out.push(...this.arenas[k]);
    return out;
  }

  // Every 60 s: (1) an empty OVERFLOW arena with nothing on its floor for ARENA_SWEEP_MS goes;
  // (2) an arena that is not ticking still gets its hour sweep of floor coins.
  sweep(now) {
    for (const key of Object.keys(this.arenas)) {
      const list = this.arenas[key];
      for (const room of list.slice()) {
        if (!room.timer && room.bank.pickups().length) room.sweepPickups(now);
        const empty = room.liveHumans === 0 && room.bank.totalMicro() === 0;
        if (room.index === 0 || !empty) {
          this.emptySince.delete(room);
          continue;
        }
        if (!this.emptySince.has(room)) this.emptySince.set(room, now);
        if (now - this.emptySince.get(room) >= MP.ARENA_SWEEP_MS) {
          room.stop();
          list.splice(list.indexOf(room), 1);
          this.emptySince.delete(room);
        }
      }
    }
  }

  // /api/live rows (design 10): free always, the paid rungs only with PAPER_PAID=1.
  boardRows() {
    const rows = [];
    for (const stake of RUNGS) {
      if (stake > 0 && !this.paidEnabled) continue;
      const list = this.arenas[keyOf(stake)];
      let players = 0;
      let bots = 0;
      for (const r of list) {
        if (r.stopped) continue;
        players += r.liveHumans;
        bots += r.botCount;
      }
      rows.push({
        id: 'paper:' + this.region + ':s' + stake,
        game: 'paper',
        region: this.region,
        stake,
        players,
        bots: stake > 0 ? 0 : players > 0 ? bots : MP.FREE_BOTS_IDLE,
        capacity: MP.MAX_HUMANS,
        state: 'open'
      });
    }
    return rows;
  }

  get warming() {
    const free = this.arenas[keyOf(0)][0];
    return !!(free && free.warming);
  }
}

module.exports = { PaperArenas, keyOf, RUNGS };
