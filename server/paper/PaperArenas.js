'use strict';
// The Paper arena directory for this region (design 6.1): arenas per rung, the seat search
// with overflow arenas, the reconnect maps, the 60 s sweep and the lobby rows. Not a
// LobbyRegistry: its sweep would delete a paid room whatever money is on its floor.
const { PaperRoom } = require('./PaperRoom');
const { MP, REASON } = require('./ArenaGame');

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
// An empty replacement of the awake free arena is woken at most this often (keepAwake, _replace; slArenas's gap).
const AWAKE_RESTART_GAP_MS = 60000;

function rungOf(stake) {
  const n = Number(stake);
  const r = RUNGS.find((x) => Math.abs(x - n) <= 1e-9);
  return r === undefined ? null : r;
}

class PaperArenas {
  // journal: the paid money journal (server/ag/agJournal.js, shared with paid agar and paid snake), or null. Every paid
  // seat's account is opened and closed in it, and a shutdown or crash closes each one 'refunded' with its owed row,
  // so the next boot's replay writes the refunds a dying process could not (security review item a).
  constructor({ region = 'na', io = null, hooks, now = Date.now, paidEnabled = process.env.PAPER_PAID === '1', autoTick = true, warm = true, awake = false, makeRoom, journal = null, botStore = null, botBank = null, botCurve = null } = {}) {
    this.region = region;
    this.io = io;
    this.hooks = hooks;
    this.now = now;
    this.paidEnabled = !!paidEnabled;
    // The owner's runtime door switch (paper:paid:off / paper:paid:on, kept across restarts by the server's switch
    // file): closed, every NEW paid join is refunded at the door ('not-open'); seated players keep playing, resume
    // and cash out. stopping: set once by shutdownSettle, the process is going down (the door refuses before it
    // spends a token, and nothing new is seated).
    this.paidOpen = this.paidEnabled;
    this.stopping = false;
    this.journal = journal;
    this.autoTick = autoTick;
    this.makeRoom = makeRoom || ((opts) => new PaperRoom(opts));
    // The free arenas' daily bot curve, () -> bots now (index.js passes botPopulation's; null: FREE_BOTS_IDLE).
    this.botCurve = typeof botCurve === 'function' ? botCurve : null;
    this.arenas = {};
    for (const s of RUNGS) this.arenas[keyOf(s)] = [];
    this.byKey = new Map(); // resumeKey -> seat
    this.bySocket = new Map(); // socketId -> seat
    this.byProof = new Map(); // sha256(entry token) -> UNCONFIRMED paid seat
    this.outcomes = new Map(); // 't:' + proof or 'k:' + resumeKey -> { why, refunded, at, extra }, oldest first
    this.releases = new Map(); // wallet -> times of its unconfirmed-seat refunds, oldest first
    this.emptySince = new Map(); // room -> ms
    // The owner's paid bots (Control, Owen 2026-10-16): stake -> n held in the rung's arena #1, saved in botStore.
    this.botStore = botStore && typeof botStore.load === 'function' ? botStore : null;
    this.botBank = botBank && typeof botBank.take === 'function' ? botBank : null;
    this.botTargets = new Map();
    if (this.paidEnabled && this.botStore) {
      let saved = null;
      try {
        saved = this.botStore.load();
      } catch (e) {
        console.error('[PAPER] paid bots: saved targets unreadable: ' + (e && e.message));
      }
      for (const st of RUNGS) {
        const n = saved && st > 0 ? saved[String(st)] : undefined;
        if (Number.isInteger(n) && n > 0 && n <= MP.FREE_BOTS_IDLE) this.botTargets.set(st, n);
      }
    }
    this.awake = false; // keepAwake: the free arena #1 ticks from boot once warmed, a replacement too
    this.awakeAt = -Infinity;
    const free = this._create(0, 0);
    if (warm && free) free.warmUp(() => { if (awake) this.keepAwake(); });
    else if (awake) this.keepAwake();
  }

  // The free arena #1 keeps ticking with nobody seated once its boot warm-up is done (the server passes awake), so its
  // bots are out claiming ground when the first person arrives and Spectate always has a square to follow, as in
  // slither.io and agar.io. A replacement wakes too, at most once a minute (a
  // fault that repeats on every wake of an empty arena must not become a create, fail, close loop: people in it come
  // back through seatFor, which ticks it anyway). Paid arenas never:
  // they have no bots. Returns whether the arena is awake.
  keepAwake() {
    this.awake = true;
    this.awakeAt = this.now();
    const r = (this.arenas[keyOf(0)] || []).find((x) => x.index === 0 && !x.stopped);
    return !!(r && typeof r.setAwake === 'function' && r.setAwake(true));
  }

  // A fund from the Bot bank wallet landed: spawn the bots that were waiting for it (only counts Owen asked for).
  resumeBots() {
    if (!this.botBank || !this.botWant || this.stopping) return;
    for (const [stake, more] of Array.from(this.botWant)) {
      try {
        this._applyBots(stake, this.botCount(stake) + more);
      } catch (e) {
        this.botWant.delete(stake);
        console.error('[BOTS] paid bots not resumed at ' + stake + ': ' + (e && e.message));
      }
    }
    this._saveTargets();
  }

  startBots() {
    if (!this.botBank) return;
    for (const [stake, n] of Array.from(this.botTargets)) if (n > 0) this._applyBots(stake, n);
    this._saveTargets();
  }

  _paidRung(stake) {
    const st = RUNGS.find((s) => s > 0 && Math.abs(s - Number(stake)) <= 1e-9);
    return st === undefined || !this.paidEnabled ? null : st;
  }

  botTarget(stake) {
    const st = this._paidRung(stake);
    return st === null ? null : (this.botTargets.get(st) || 0);
  }

  botCount(stake) {
    const st = this._paidRung(stake);
    if (st === null) return 0;
    let n = 0;
    for (const r of this.arenas[keyOf(st)] || []) if (!r.stopped) n += r.botCount;
    return n;
  }

  // Bounty bots (Owen 2026-10-17), as paid slither and agar.io: n live bots in the rung's arena #1, each worth the
  // rung's stake from the owner's bot bank. Fewer: the extra bots leave (seed back, what they took back to its
  // players). More: one at a time while the bank and the daily limit allow; the first refusal says why. A bot that
  // dies is never replaced (PaperRoom._botDeath lowers the cap). -> { ok, live, held, why } or { ok: false, why }
  setBotTarget(stake, n) {
    const st = this._paidRung(stake);
    if (st === null) return { ok: false, why: 'No paid Paper.io rung at ' + stake };
    if (!this.botBank) return { ok: false, why: 'Paid Paper.io bots are not wired on this server' };
    if (this.stopping) return { ok: false, why: 'The server is stopping' };
    if (!Number.isInteger(n) || n < 0 || n > MP.FREE_BOTS_IDLE) return { ok: false, why: 'Bots: a whole number from 0 to ' + MP.FREE_BOTS_IDLE };
    let r;
    try {
      r = this._applyBots(st, n);
    } catch (e) {
      console.error('[PAPER] paid bots: set ' + st + ' to ' + n + ' failed: ' + (e && e.message));
      this._saveTargets();
      return { ok: false, why: 'Paid bots could not be changed just now: ' + String(e && e.message).slice(0, 120) };
    }
    this._saveTargets();
    return Object.assign({ ok: true, held: n }, r);
  }

  _saveTargets() {
    for (const st of RUNGS) {
      if (!(st > 0)) continue;
      // bots still waiting for their seed to reach escrow count too, so a restart meanwhile keeps them
      const live = this.botCount(st) + ((this.botWant && this.botWant.get(st)) || 0);
      if (live > 0) this.botTargets.set(st, live);
      else this.botTargets.delete(st);
    }
    if (!this.botStore || typeof this.botStore.save !== 'function') return false;
    const obj = {};
    for (const [k, v] of this.botTargets) obj[String(k)] = v;
    try {
      return this.botStore.save(obj) !== false;
    } catch (e) {
      return false;
    }
  }

  // -> { live, why }
  _applyBots(stake, n) {
    // a count still waiting on a seed moving from the Bot bank wallet (resumeBots finishes it once it lands)
    if (!this.botWant) this.botWant = new Map();
    this.botWant.delete(stake);
    const list = this.arenas[keyOf(stake)] || [];
    let room = list.find((r) => r.index === 0 && !r.stopped) || null;
    if (!room && n > 0) room = this._create(stake, 0);
    if (!room || room.paidBots !== true) return { live: 0, why: n > 0 ? 'The arena takes no bots' : null };
    while (room.botCount > n && room.game.removeLowestBot()) { /* each leaves through retireBot */ }
    const seed = Math.round(stake * 1e6);
    let why = null;
    for (let i = room.botCount; i < n; i++) {
      const no = this.botBank.whyNot(seed);
      if (no) {
        // only the bots still to come (a bot killed meanwhile is not replaced: no respawn)
        if (no === 'funding') this.botWant.set(stake, n - (Number(room.botCount) || 0));
        why = no === 'cap' ? 'The daily bot limit is reached' : no === 'funding'
          ? 'The rest join in a few seconds, once their money has moved from the Bot bank wallet to escrow'
          : 'The bot bank cannot cover another $' + stake + ' bot';
        break;
      }
      room.game.setBotCap(room.botFrom.size + 1); // the stock spawn places a bot only under the arena's count
      const u = room.addBot();
      if (!u) {
        why = 'The arena would not take another bot just now';
        break;
      }
      if (!this.botBank.take(seed, room.lobbyType)) {
        room.game.kill(u, undefined, REASON.SYSTEM_REMOVED);
        why = 'The bot bank refused the seed';
        break;
      }
      try {
        room.seedBot(u, seed);
      } catch (e) {
        this.botBank.giveBack(seed, 'seed-failed', room.lobbyType, true);
        room.game.kill(u, undefined, REASON.SYSTEM_REMOVED);
        console.error('[PAPER] paid bots: seed refused, given back: ' + (e && e.message));
        why = 'The arena refused the seed';
        break;
      }
    }
    // the arena tops up to people + its cap: the cap is exactly the seeded bots, so it never adds one of its own
    room.game.setBotCap(room.botFrom.size);
    room.setAwake(room.botCount > 0);
    return { live: room.botCount, why };
  }

  _create(stake, index) {
    const room = this.makeRoom({
      paidBots: stake > 0 && index === 0,
      stake,
      region: this.region,
      index,
      io: this.io,
      hooks: this.hooks,
      now: this.now,
      directory: this,
      autoTick: this.autoTick,
      botCurve: stake > 0 ? null : this.botCurve
    });
    room.onClosed = (closed) => this._replace(closed);
    const list = this.arenas[keyOf(stake)];
    list.push(room);
    list.sort((a, b) => a.index - b.index);
    return room;
  }

  // Every sweep (60 s): a replacement of the awake free arena that _replace left asleep (created within a minute of
  // the last wake) wakes now, so one early fault never loses the warm arena for the life of the process.
  _rewake() {
    if (!this.awake) return;
    const r = (this.arenas[keyOf(0)] || []).find((x) => x.index === 0 && !x.stopped);
    if (!r || r.awake || r.warming || typeof r.setAwake !== 'function') return;
    const t = this.now();
    if (t - this.awakeAt < AWAKE_RESTART_GAP_MS) return;
    this.awakeAt = t;
    r.setAwake(true);
  }

  // An emergency-closed arena gives its index to a fresh one.
  _replace(closed) {
    const list = this.arenas[keyOf(closed.stake)];
    const i = list.indexOf(closed);
    if (i === -1) return;
    list.splice(i, 1);
    this.emptySince.delete(closed);
    const room = this._create(closed.stake, closed.index);
    if (this.awake && closed.stake === 0 && closed.index === 0 && room && typeof room.setAwake === 'function') {
      const t = this.now();
      if (!(t - this.awakeAt < AWAKE_RESTART_GAP_MS)) {
        this.awakeAt = t;
        room.setAwake(true);
      }
    }
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
    if (rung > 0 && this.stopping) return null; // settled for a restart: nothing paid is seated (or created) now
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

  // The arena a watcher is sent to (the lobby's Spectate, any rung: Owen 2026-10-15 opened the $0.50 and $1 ones too):
  // the open arena of that rung with the most live players, the lowest index on a tie; on Free with nobody playing,
  // the awake free arena #1 and its bots (keepAwake: it ticks anyway). A pure query: never seatFor, never a new arena,
  // and null when no arena of the rung has a player and none is awake (an arena ticks only while someone is seated or
  // it is awake, and watchers alone must never cost a tick). A watcher of a paid arena is read only exactly as on Free
  // (PaperRoom.addWatcher): every player there is already sent the whole arena, so it learns nothing they do not.
  watchFor(stake) {
    const rung = rungOf(stake);
    if (rung === null || !this.arenas[keyOf(rung)]) return null;
    let best = null;
    let awake = null;
    for (const r of this.arenas[keyOf(rung)]) {
      if (r.stopped || r.warming) continue;
      if (r.awake === true && !r.paid && !awake) awake = r;
      if (!(r.liveHumans > 0)) continue;
      if (!best || r.liveHumans > best.liveHumans || (r.liveHumans === best.liveHumans && r.index < best.index)) best = r;
    }
    return best || awake;
  }

  // io 'disconnect' of a watcher: out of whichever arena it watched (the socket object is gone, so every arena is
  // asked; there are at most a few dozen).
  watcherGone(socketId) {
    let n = 0;
    for (const room of this.all()) if (typeof room.removeWatcher === 'function' && room.removeWatcher(socketId)) n++;
    return n > 0;
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
    this._journalOpen(seat);
  }

  // The money journal (agJournal): a paid seat's account open, and its one close. A failed write is logged by the
  // journal itself and never reaches a money path (as agar's: server/ag/agArenas.js _journal), with one exception: a
  // seat whose door journaled its jid first (seat.door) THROWS when its own open is not written, so the room refuses
  // it (addHuman rolls back, the door refunds 'seat-failed'). Otherwise the door's record would stand as the jid's last
  // open and the boot replay would refund the stake of a seated account (as slMoney.open for paid snake).
  _journalOpen(seat) {
    const j = this.journal;
    if (!j || !seat || !seat.jid || !seat.room || !seat.room.paid) return;
    let ok = false;
    try {
      const acct = { jid: seat.jid, wallet: seat.wallet, deposit: seat.deposit, name: seat.name };
      if (seat.stakeSig) acct.stakeSig = seat.stakeSig;
      ok = j.open(acct, seat.room.lobbyType) !== false;
    } catch (e) {
      console.error('[PAPER] journal open', e && e.message);
    }
    if (!ok && seat.door) {
      console.error('[PAPER] JOURNAL open of ' + seat.jid + ' not written (' + seat.room.lobbyType + '); the seat is refused');
      throw new Error('PaperArenas: the journal did not write the seat open record');
    }
  }

  // An arena's floor coins at a restart or crash (PaperRoom._shutdownFloor): true when the journal took the record.
  _journalFloor(rec) {
    const j = this.journal;
    if (!j || typeof j.floor !== 'function') return false;
    try {
      return j.floor(rec) !== false;
    } catch (e) {
      console.error('[PAPER] journal floor', e && e.message);
      return false;
    }
  }

  // seat.exit: { outcome, why, key?, refundedMicro?, reason? }, set by the room as the seat leaves. Once per seat.
  _journalClose(seat) {
    const j = this.journal;
    if (!j || !seat || !seat.jid || seat.journalClosed || !seat.room || !seat.room.paid) return;
    const x = seat.exit || { outcome: 'closed', why: '' };
    // a door seat that never seated (addHuman rolled it back): the door refunds it and closes the jid once that refund
    // answered, so a crash before then still finds the jid open
    if (seat.door && x.outcome === 'aborted') return;
    seat.journalClosed = true;
    try {
      j.close({ jid: seat.jid, wallet: seat.wallet, deposit: seat.deposit, name: seat.name }, x.outcome, x,
        seat.room.lobbyType);
    } catch (e) {
      console.error('[PAPER] journal close', e && e.message);
    }
  }

  // The player steered (or came back with its resumeKey): the token no longer names the seat.
  // This is also when a paid buy-in counts as played: the stake row is written here, not at
  // the consume, so a seat refunded before its first input leaves no buy-in on the player's
  // profile (review finding). The room calls this once per seat (latched by seat.confirmed).
  _seatConfirmed(seat) {
    if (seat.proof && this.byProof.get(seat.proof) === seat) this.byProof.delete(seat.proof);
    if (seat.room && seat.room.paid && seat.wallet && seat.deposit > 0 && this.hooks && typeof this.hooks.onStake === 'function') {
      try {
        this.hooks.onStake({ wallet: seat.wallet, worth: seat.deposit / 1e6, label: seat.room.lobbyType, name: seat.name,
          stake: seat.room.stake });
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
    this._journalClose(seat);
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

  // A planned restart ('shutdown') or a crash ('crash'), as paid agar and paid snake (Owen Q6, security review item a):
  // the door shuts for good (stopping), every paid arena stops ticking, and every open paid account is withdrawn and
  // closed in the journal 'refunded' with its owed row: 100% of the CURRENT balance, no rake (an unconfirmed seat's
  // buy-in part bounded by what landed, PaperRoom._shutdownOwed). The rows come back for the caller to write
  // (installAgShutdown: db.recordOwedOnce, one row per key; the crash path leaves them to the journal replay).
  // Floor coins go to the house as one journaled floor record per arena, booked once by the replay. Rows only:
  // nothing is paid here, nothing waits.
  shutdownSettle(why = 'shutdown') {
    this.stopping = true;
    this.paidOpen = false;
    const rows = [];
    for (const room of this.all()) {
      if (!room.paid) continue;
      try {
        rows.push(...room.shutdownSettle(why));
      } catch (e) {
        console.error('[PAPER] SHUTDOWN settle threw', room.lobbyType, e && e.stack ? e.stack : e);
      }
    }
    return rows;
  }

  // Open paid accounts across every arena (the shutdown's count and the owner page).
  paidOpenCount() {
    let n = 0;
    for (const room of this.all()) if (room.paid) n += room.bank.openIds().length;
    return n;
  }

  // Every 60 s: (1) an empty OVERFLOW arena with nothing on its floor for ARENA_SWEEP_MS goes;
  // (2) an arena that is not ticking still gets its hour sweep of floor coins.
  sweep(now) {
    this._rewake();
    if (!this.stopping) this._saveTargets(); // no respawn: the saved counts follow the live bounty bots
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
        bots: stake > 0 || this.botCurve ? bots : players > 0 ? bots : MP.FREE_BOTS_IDLE,
        capacity: MP.MAX_HUMANS,
        // a paid rung under paper:paid:off (or a restart) stays listed, its seated players counted, but closed: the
        // lobby draws it struck through and asks for no money (board.js isOpen / playableStakes)
        state: stake > 0 && (!this.paidOpen || this.stopping) ? 'closed' : 'open'
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
