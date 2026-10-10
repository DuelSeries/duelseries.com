'use strict';
// The Paper arena directory for this region (design 6.1): arenas per rung, the seat search
// with overflow arenas, the reconnect maps, the 60 s sweep and the lobby rows. Not a
// LobbyRegistry: its sweep would delete a paid room whatever money is on its floor.
const { PaperRoom } = require('./PaperRoom');
const { MP } = require('./ArenaGame');

// The ladder (free, $0.50, $1.00) from the one list every game reads (shared/stakeLadder.js via
// stakeRules). Paper used to keep its own copy, which would have refused every $0.50 join as full.
const RUNGS = require('../stakeRules').ALL_STAKES.slice();
// What became of a paid join whose answer may never have reached the player (its link dropped
// before pp:joined, or its refusal was lost): kept this long, at most this many, so a page that
// asks again with its entry token or resumeKey hears the real outcome. Longer than an entry
// token lives (5 minutes), far longer than a reconnect takes.
const OUTCOME_TTL_MS = 10 * 60 * 1000;
const OUTCOME_MAX = 5000;
// A wallet whose paid joins were refunded before their first input (join-lost, join-timeout)
// this many times within the window is refused, with a full refund, until the oldest falls
// out: an unconfirmed seat's loss is refunded while its win is kept, so an unbounded run of
// them is a free option (review finding). An honest bad link loses nothing, it waits.
const RELEASE_MAX = 2;
const RELEASE_WINDOW_MS = 10 * 60 * 1000;
const RELEASE_WALLETS_MAX = 5000;

function keyOf(stake) {
  return Number(stake).toFixed(2);
}

// The ladder's own number for a stake, or null. Arenas are built only from RUNGS, never from
// a number a message carried (review finding: 0.10499 became the then $0.10 arena's stake).
function rungOf(stake) {
  const n = Number(stake);
  const r = RUNGS.find((x) => Math.abs(x - n) <= 1e-9);
  return r === undefined ? null : r;
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
    this.byProof = new Map(); // sha256(entry token) -> UNCONFIRMED paid seat
    this.outcomes = new Map(); // 't:' + proof or 'k:' + resumeKey -> { why, refunded, at, extra }, oldest first
    this.releases = new Map(); // wallet -> times of its unconfirmed-seat refunds, oldest first
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
    const rung = rungOf(stake);
    if (rung === null) return null;
    const list = this.arenas[keyOf(rung)];
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
      const room = this._create(rung, this._freeIndex(list));
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

  // An unconfirmed paid seat, named by the sha256 of the entry token that bought it.
  seatByProof(proof) {
    const seat = this.byProof.get(proof);
    return seat && !seat.room.stopped && !seat.unit.death && !seat.confirmed && !seat.released ? seat : null;
  }

  // -> { why, refunded, ...extra } | null, for 't:' + proof or 'k:' + resumeKey.
  outcomeOf(key) {
    const o = this.outcomes.get(key);
    if (!o) return null;
    if (this.now() - o.at > OUTCOME_TTL_MS) {
      this.outcomes.delete(key);
      return null;
    }
    return Object.assign({}, o.extra || {}, { why: o.why, refunded: o.refunded });
  }

  // extra: display facts a page asking again is told (a cash-out's gross and id).
  rememberOutcome(key, why, refunded, extra) {
    if (typeof key !== 'string' || !key) return;
    this.outcomes.delete(key);
    this.outcomes.set(key, { why, refunded: !!refunded, at: this.now(), extra: extra || null });
    while (this.outcomes.size > OUTCOME_MAX) this.outcomes.delete(this.outcomes.keys().next().value);
  }

  // True while this wallet has had RELEASE_MAX unconfirmed-seat refunds within the window.
  releaseCooldown(wallet) {
    if (typeof wallet !== 'string' || !wallet) return false;
    const list = this.releases.get(wallet);
    if (!list) return false;
    const now = this.now();
    while (list.length && now - list[0] >= RELEASE_WINDOW_MS) list.shift();
    if (!list.length) {
      this.releases.delete(wallet);
      return false;
    }
    return list.length >= RELEASE_MAX;
  }

  _noteRelease(wallet) {
    if (typeof wallet !== 'string' || !wallet) return;
    const list = this.releases.get(wallet) || [];
    list.push(this.now());
    while (list.length > RELEASE_MAX) list.shift();
    this.releases.delete(wallet); // re-inserted newest, so the map drops the stalest wallet first
    this.releases.set(wallet, list);
    while (this.releases.size > RELEASE_WALLETS_MAX) this.releases.delete(this.releases.keys().next().value);
  }

  // Kept in step by the rooms.
  _seatAdded(seat) {
    this.byKey.set(seat.resumeKey, seat);
    if (seat.socketId) this.bySocket.set(seat.socketId, seat);
    if (seat.proof && !seat.confirmed) this.byProof.set(seat.proof, seat);
  }

  // The player steered (or came back with its resumeKey): the token no longer names the seat.
  // This is also when a paid buy-in counts as played: the stake row is written here, not at
  // the consume, so a seat refunded before its first input leaves no buy-in on the player's
  // profile (review finding). The room calls this once per seat (latched by seat.confirmed).
  _seatConfirmed(seat) {
    if (seat.proof && this.byProof.get(seat.proof) === seat) this.byProof.delete(seat.proof);
    if (seat.room && seat.room.paid && seat.wallet && seat.deposit > 0 && this.hooks && typeof this.hooks.onStake === 'function') {
      try {
        this.hooks.onStake({ wallet: seat.wallet, worth: seat.deposit / 1e6, label: seat.room.lobbyType });
      } catch (e) {
        console.error('[PAPER] stake row', e && e.message);
      }
    }
  }

  // An unconfirmed seat refunded by its room: a page asking again hears that, by either proof.
  _rememberRelease(seat, why, refunded) {
    if (seat.proof) this.rememberOutcome('t:' + seat.proof, why, refunded);
    this.rememberOutcome('k:' + seat.resumeKey, why, refunded);
    if (refunded && (why === 'join-lost' || why === 'join-timeout')) this._noteRelease(seat.wallet);
  }

  _seatSocket(seat, prevSocketId) {
    if (prevSocketId && this.bySocket.get(prevSocketId) === seat) this.bySocket.delete(prevSocketId);
    if (seat.socketId) this.bySocket.set(seat.socketId, seat);
  }

  _seatFreed(seat) {
    if (this.byKey.get(seat.resumeKey) === seat) this.byKey.delete(seat.resumeKey);
    for (const [sid, s] of this.bySocket) if (s === seat) this.bySocket.delete(sid);
    if (seat.proof && this.byProof.get(seat.proof) === seat) {
      this.byProof.delete(seat.proof);
      // Gone by the game's own rules before its player ever steered, its money dropped where
      // it stood; an outcome the room already recorded for it (cut by a player) is kept.
      if (!seat.released && !this.outcomeOf('t:' + seat.proof)) this.rememberOutcome('t:' + seat.proof, 'expired', false);
    }
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

  // Humans seated across every Paper arena and rung (the lobby card's count). Bots are not seats.
  humanTotal() {
    let n = 0;
    for (const key of Object.keys(this.arenas)) {
      for (const r of this.arenas[key]) if (!r.stopped) n += r.liveHumans;
    }
    return n;
  }

  get warming() {
    const free = this.arenas[keyOf(0)][0];
    return !!(free && free.warming);
  }
}

module.exports = { PaperArenas, keyOf, RUNGS, RELEASE_MAX, RELEASE_WINDOW_MS };
