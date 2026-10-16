'use strict';
// slither.io free room: the room directory for this region (SERVER-DESIGN 12.1, 13 items 4, 8; 16.2 rollback; task
// T11). ONE free room (OWNER-ANSWERS Q25: "one free room, as many players as the server can hold"), lobbyType
// sl_<region>_s0, no overflow rooms. It holds no money (test/slNoMoney.test.js): the room's snakes carry worth 0 and
// boardRows() lists only stake 0.
//
//   all()            [room] while the directory is open (the owner console's ALL_ROOMS, ops.drainStatus)
//   room()           the room
//   boardRows()      [{id: 'sl:<region>:s0', game: 'snake', region, stake: 0, players, bots, capacity: null,
//                    state: 'open'}] while isLive(), else [] (SERVER-DESIGN 12.1, CS:363-365). NOT read by /api/live
//                    until the Phase 6 swap (SERVER-DESIGN 16.2; SERVER-BUILD-BRIEF section 3 OUT): Phase 4 is
//                    "/sl by direct URL only".
//   isLive()         the 16.2 rollback predicate: open AND the door open AND the last boardRows() call succeeded
//   door(open)       the owner console's sl:door:off / sl:door:on: off refuses new joins (slSockets 'closed'),
//                    seated players finish. In memory like agar's paid switch, so a restart reopens it.
//   humanTotal(), botTotal(), liveCounts()   the counts (humans = seats whose snake is alive or gliding)
//   keepAwake()      the free room ticks from boot and never idle-pauses (a replacement too); see the method
//   sweep(now)       the periodic check (server/index.js everyStaggered): a room that closed itself is replaced
//   setTop(msg)      the biggest cash-out box message (slTopCashout), kept for a replacement room too
//   sampleLoad(nowMs, inp)  the bot governor's once-a-second sample (SERVER-DESIGN 11, 13 item 8); also caches
//                    "a paid seat is occupied" for the room's catch-up yield (slRoom opts.paidBusy)
//   setExtraLoad(fn)  fn() -> the largest slice of the PAID sl rooms since the last sample (slPaidArenas.maxSliceMs,
//                    set by the server; PAID-SL-DESIGN 1, D2-m9): the governor sees the larger of the two, so paid
//                    tick cost on the one core holds the bots back too
//   startTimers({monitor, paidLoad, every})  the 1 Hz governor sample through slSafe.safeEvery
//   stats(), close()
//   join, leave, disconnect, input, hold, vis, chat, diag   slSockets' calls, by socket id
//   watch(socket, {after})  a watcher (the lobby's Spectate): true or 'closed' / 'full' / 'nobody'. Never a seat, so
//                    never in humanTotal, boardRows or the bot fill
//
// An emergency-closed room (C_EMERGENCY_FAIL_WAKES wakes in a row threw, slRoom.emergencyClose) is replaced by a fresh
// one at once; its sockets are disconnected, so their clients run their own close path (one socket per life,
// SERVER-DESIGN 12.4). A free room owes nobody anything.

const { assertShippable, assertLawsComplete } = require('./slLaws');
const { SlRoom } = require('./slRoom');
const { createBotDriver, createBotGovernor, createLoopProbe } = require('./slBots');
const { createSafeStats, safeCall, safeEvery } = require('./slSafe');

// SERVER-DESIGN 13 item 8: "the 1 Hz bot fill and governor"; slBots createBotGovernor: sample "once a second".
const GOVERNOR_SAMPLE_MS = 1000;
// An empty replacement of an awake room is woken at most this often (keepAwake, _replace).
const AWAKE_RESTART_GAP_MS = 60 * 1000;

class SlArenas {
  // laws: the law table. opts:
  //   region         'na' (row id sl:<region>:s0, lobbyType sl_<region>_s0)
  //   shippableOnly  false only for the dev law table (SL_DEV_LAWS) and tests
  //   bots           false: no bot driver (tests); default on
  //   seed, clock, now, timers, autoTick, view, log   handed to the room (see slRoom); seed + n for the n-th room
  //   makeRoom       (opts) -> room (tests)
  //   extraLoad      () -> ms, as setExtraLoad
  //   governor       a governor to share (the battle royale's directory takes the free room's); default its own
  //   botOpts        more createBotDriver options (the battle royale's holdFill)
  //   paidBusy       () -> "a paid seat is occupied" for the room's catch-up yield; default this directory's sample
  constructor(laws, opts) {
    const o = opts || {};
    this.shippableOnly = o.shippableOnly !== false;
    if (this.shippableOnly) assertShippable(laws);
    assertLawsComplete(laws, ['C_ROOM_CAP', 'C_HUMAN_CAP']);
    this.laws = laws;
    this.region = typeof o.region === 'string' && o.region ? o.region : 'na';
    this.log = o.log || console;
    this.opts = o;
    this.withBots = o.bots !== false;
    this.makeRoom = typeof o.makeRoom === 'function' ? o.makeRoom : ((ro) => new SlRoom(laws, ro));
    // the battle royale's directory shares the free room's governor (one core, one bot budget: server/slBr)
    this.governor = this.withBots ? (o.governor || createBotGovernor(laws)) : null;
    this.doorOpen = true;
    this.closed = false;
    this.lastBoardOk = true;
    this.paidBusyNow = false;
    this.top = null;
    this.rooms = 0;
    this.replaced = 0;
    this.safeStats = createSafeStats();
    this.timers = [];
    this.lastSample = null;
    this.maxSliceEverMs = 0;
    this.extraLoad = null;
    this.setExtraLoad(o.extraLoad);
    this.driver = null;
    this.awake = false;
    this.awakeAt = -Infinity;
    this._room = this._create();
  }

  // The free room from boot (server/index.js, slBoot openSl awake): it ticks before anybody comes and never takes the
  // idle pause (slRoom setAwake), so its bots fill to the day's curve at once and follow it all day, and the lobby
  // card counts real snakes from the first poll instead of 0 until somebody joins (Owen, 2026-10-15). Measured on the
  // live box (t3.micro, unlimited credits) the same night, nobody seated, 60 s each: 22 bots 4.6%, 60 bots 5.9%,
  // 90 bots 7.5% of one vCPU, about 3% of the instance on the day's average, which keeps the box's daily average
  // (5 to 6%) under the t3.micro baseline of 10%. The old engine's free room kept its bots running the same way.
  // A replacement room is woken too, at once when people were in the closed one, else at most once a minute (a fault
  // on every wake of an empty room must not become a create, fail, close loop). Returns whether the room is awake.
  keepAwake() {
    if (this.closed) return false;
    this.awake = true;
    this.awakeAt = this._nowMs();
    const r = this._room;
    return !!(r && typeof r.setAwake === 'function' && r.setAwake(true));
  }

  _nowMs() {
    return typeof this.opts.now === 'function' ? this.opts.now() : Date.now();
  }

  _create() {
    const o = this.opts;
    const driver = this.withBots
      ? createBotDriver(this.laws, Object.assign({ governor: this.governor, now: o.now }, o.botOpts)) : null;
    const ro = {
      region: this.region,
      shippableOnly: this.shippableOnly,
      log: this.log,
      bots: driver,
      // the battle royale's directory passes the free one's (it runs no governor timer of its own)
      paidBusy: typeof o.paidBusy === 'function' ? o.paidBusy : () => this.paidBusyNow,
    };
    for (const k of ['clock', 'now', 'timers', 'autoTick', 'view', 'prey']) if (o[k] !== undefined) ro[k] = o[k];
    if (typeof o.seed === 'number' && Number.isFinite(o.seed)) ro.seed = o.seed + this.rooms;
    const room = this.makeRoom(ro);
    this.rooms++;
    this.driver = driver;
    room.onClosed = (closed, sockets) => this._replace(closed, sockets);
    if (this.top) safeCall(() => room.setTop(this.top), 'sl.arenas.setTop', this.safeStats, { log: this.log });
    return room;
  }

  // The room closed itself: a fresh one takes its place now; its sockets are let go.
  _replace(closed, sockets) {
    if (this.closed || closed !== this._room) return;
    this.replaced++;
    this._room = this._create();
    for (const s of sockets || []) {
      try {
        if (s && typeof s.disconnect === 'function') s.disconnect(true);
      } catch (e) { /* already gone */ }
    }
    if (this.awake) {
      const t = this._nowMs();
      const people = Array.isArray(sockets) && sockets.length > 0;
      if (people || !(t - this.awakeAt < AWAKE_RESTART_GAP_MS)) {
        this.awakeAt = t;
        safeCall(() => this._room.setAwake(true), 'sl.arenas.awake', this.safeStats, { log: this.log });
      }
    }
  }

  all() {
    return this.closed || !this._room ? [] : [this._room];
  }

  room() {
    return this._room;
  }

  // Joins are taken: the directory and its room open, and the door on.
  isOpen() {
    const r = this._room;
    return !this.closed && this.doorOpen && !!r && !r.stopped && !r.closed;
  }

  isLive() {
    return !this.closed && this.doorOpen && this.lastBoardOk;
  }

  door(open) {
    if (open === true || open === false) this.doorOpen = open;
    return this.doorOpen;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Seats (slSockets, by socket id)

  // true when seated, else the refusal: 'closed' or the room's ('full', 'closed').
  join(socket, info) {
    if (!this.isOpen()) return 'closed';
    const room = this._room;
    const seat = room.seat(socket, info);
    if (seat) return true;
    return room.refusal() || 'full';
  }

  // A watcher (slSockets: a free socket whose handshake says watch 1; slRoom seatWatch): info { after }, the snake id
  // watched last (the layer's Next). true, or 'closed', 'full' (as many watchers as C_HUMAN_CAP: each costs a view and
  // a send queue like a seat, and the players' cap never counts them) or 'nobody' (nothing alive to watch).
  watch(socket, info) {
    if (!this.isOpen()) return 'closed';
    const room = this._room;
    if (room.watchers.size >= room.R.humanCap) return 'full';
    return room.seatWatch(socket, info) ? true : 'nobody';
  }

  // onEnd: called once when the seat's gliding snake ends (slRoom.unseat returns 'glide'); slSockets keeps that snake
  // charged to its address until then.
  leave(socketId, onEnd) {
    return this._room ? this._room.unseat(socketId, 'leave', onEnd) : false;
  }

  disconnect(socketId, onEnd) {
    return this._room ? this._room.unseat(socketId, 'disconnect', onEnd) : false;
  }

  input(socketId, bytes) {
    return this._room ? this._room.onInput(socketId, bytes) : false;
  }

  hold(socketId, on) {
    return this._room ? this._room.onHold(socketId, on) : false;
  }

  vis(socketId, hidden) {
    return this._room ? this._room.onVis(socketId, hidden) : false;
  }

  chat(socketId, text) {
    return this._room ? this._room.onChat(socketId, text) : false;
  }

  diag(socketId, d) {
    return this._room ? this._room.onDiag(socketId, d) : false;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Counts and the board

  // Humans with a live or gliding snake (a dead seat waiting for its own close does not count).
  humanTotal() {
    const r = this._room;
    if (this.closed || !r || r.stopped) return 0;
    let n = 0;
    for (const seat of r.seats.values()) if (!seat.dead) n++;
    return n + r.orphans.size;
  }

  botTotal() {
    const r = this._room;
    if (this.closed || !r || r.stopped) return 0;
    return r.botCount;
  }

  liveCounts() {
    return { humans: this.humanTotal(), bots: this.botTotal() };
  }

  boardRows() {
    if (this.closed || !this.doorOpen) return [];
    try {
      const row = {
        id: 'sl:' + this.region + ':s0',
        game: 'snake',
        region: this.region,
        stake: 0,
        players: this.humanTotal(),
        bots: this.botTotal(),
        capacity: null,
        state: 'open',
      };
      this.lastBoardOk = true;
      return [row];
    } catch (e) {
      this.lastBoardOk = false;
      this.log.error('[SL] board row', e && e.message);
      return [];
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Periodic

  sweep(now) {
    if (this.closed) return { replaced: false };
    const r = this._room;
    if (!r || r.closed) {
      // its watchers' sockets go too (emergencyClose hands both): a socket left open on a dead room freezes
      const seated = r ? Array.from(r.seats.values()).concat(r.watchers ? Array.from(r.watchers.values()) : []) : [];
      this._replace(r, seated.map((s) => s.socket));
      return { replaced: true, at: now };
    }
    return { replaced: false, at: now };
  }

  setTop(msg) {
    this.top = msg && typeof msg === 'object' ? msg : null;
    if (this._room && this.top) this._room.setTop(this.top);
  }

  // The paid rooms' slice reader (see the header); anything but a function clears it.
  setExtraLoad(fn) {
    this.extraLoad = typeof fn === 'function' ? fn : null;
    return !!this.extraLoad;
  }

  // inp: { loopP99Ms, paidPlayers, paid: [{latePct, baselinePct}], loopRawP99Ms?, loopFloorMs? }. loopP99Ms is the
  // loop delay p99 above this process's idle floor (slBots createLoopProbe); the raw p99 and the floor ride along for
  // the log and the console only. The room's largest synchronous slice since the last sample is read and reset here
  // (room.stats.maxSliceMs then means "since the last governor sample").
  sampleLoad(nowMs, inp) {
    const i = inp || {};
    const paidPlayers = Number.isInteger(i.paidPlayers) && i.paidPlayers > 0 ? i.paidPlayers : 0;
    this.paidBusyNow = paidPlayers > 0;
    const r = this._room;
    let slice = 0;
    if (r && r.stats) {
      slice = Number.isFinite(r.stats.maxSliceMs) ? r.stats.maxSliceMs : 0;
      if (slice > this.maxSliceEverMs) this.maxSliceEverMs = slice;
      r.stats.maxSliceMs = 0;
    }
    // the paid rooms' slice since the last sample (read and reset by its reader); a fault reads as 0
    let extra = 0;
    if (this.extraLoad) {
      const x = safeCall(this.extraLoad, 'sl.extraLoad', this.safeStats, { log: this.log });
      if (Number.isFinite(x) && x > 0) extra = x;
    }
    if (extra > slice) slice = extra;
    if (!this.governor) return null;
    const loop = Number.isFinite(i.loopP99Ms) && i.loopP99Ms >= 0 ? i.loopP99Ms : 0;
    const paid = Array.isArray(i.paid) ? i.paid : [];
    const out = this.governor.sample(nowMs, { loopP99Ms: loop, sliceMaxMs: slice, paidPlayers, paid });
    const rawLoop = Number.isFinite(i.loopRawP99Ms) ? i.loopRawP99Ms : null;
    const floorLoop = Number.isFinite(i.loopFloorMs) ? i.loopFloorMs : null;
    this.lastSample = { at: nowMs, loopP99Ms: loop, loopRawP99Ms: rawLoop, loopFloorMs: floorLoop, sliceMaxMs: slice,
      paidSliceMs: extra, paidPlayers, result: out };
    if (out === 'engaged' || out === 'recovered') {
      const seen = rawLoop !== null && floorLoop !== null
        ? ' (raw ' + rawLoop.toFixed(1) + ' over an idle floor of ' + floorLoop.toFixed(1) + ')' : '';
      this.log.warn('[SL] bot governor ' + out + ' (loop p99 ' + loop.toFixed(1) + ' ms' + seen + ', slice ' +
        slice.toFixed(1) + ' ms, paid players ' + paidPlayers + ', mult ' + this.governor.mult().toFixed(3) + ')');
    }
    return out;
  }

  // monitor: a perf_hooks.monitorEventLoopDelay histogram (resolution slBots LOOP_RESOLUTION_MS; enabled here);
  // elu: optional () -> {idle, active} (tests; default perf_hooks eventLoopUtilization, slBots createLoopProbe);
  // paidLoad() -> {paidPlayers, paid};
  // every: optional (fn, ms, label) -> {stop} (tests); default slSafe.safeEvery. now: wall ms (default Date.now).
  startTimers(o) {
    const opt = o || {};
    if (this.timers.length) return;
    const now = typeof opt.now === 'function' ? opt.now : Date.now;
    let probe = null;
    if (opt.monitor && this.governor) {
      if (typeof opt.monitor.enable === 'function') opt.monitor.enable();
      probe = createLoopProbe(opt.monitor, this.laws, opt.elu);
    }
    const paidLoad = typeof opt.paidLoad === 'function' ? opt.paidLoad : null;
    const tick = () => {
      const t = now();
      const p = paidLoad ? paidLoad() : null;
      // The probe's first read starts the histogram afresh (it was enabled during the server's boot, whose
      // require-time stalls are not game load) and answers 0.
      const loop = probe ? probe.read(t) : 0;
      const ls = probe ? probe.stats() : null;
      this.sampleLoad(t, {
        loopP99Ms: loop,
        loopRawP99Ms: ls ? ls.rawP99Ms : null,
        loopFloorMs: ls ? ls.floorMs : null,
        paidPlayers: p && Number.isInteger(p.paidPlayers) ? p.paidPlayers : 0,
        paid: p && Array.isArray(p.paid) ? p.paid : [],
      });
    };
    const every = typeof opt.every === 'function'
      ? opt.every
      : (fn, ms, label) => safeEvery(fn, ms, label, this.safeStats, { log: this.log });
    this.timers.push(every(tick, GOVERNOR_SAMPLE_MS, 'sl.governor'));
    this.monitor = opt.monitor || null;
  }

  stats() {
    const r = this._room;
    return {
      region: this.region,
      door: this.doorOpen,
      live: this.isLive(),
      open: this.isOpen(),
      rooms: this.rooms,
      replaced: this.replaced,
      humans: this.humanTotal(),
      bots: this.botTotal(),
      maxSliceEverMs: this.maxSliceEverMs,
      governor: this.governor ? this.governor.stats() : null,
      lastSample: this.lastSample,
      botDriver: this.driver && typeof this.driver.stats === 'function' ? this.driver.stats() : null,
      safe: { total: this.safeStats.total, byLabel: Object.assign({}, this.safeStats.byLabel) },
      room: r ? r.report() : null,
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.timers) {
      try {
        if (t && typeof t.stop === 'function') t.stop();
      } catch (e) { /* gone */ }
    }
    this.timers = [];
    if (this.monitor && typeof this.monitor.disable === 'function') {
      try { this.monitor.disable(); } catch (e) { /* gone */ }
    }
    if (this._room) this._room.stop();
  }
}

module.exports = { SlArenas, GOVERNOR_SAMPLE_MS };
