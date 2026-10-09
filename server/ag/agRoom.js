'use strict';
// One agar.io FFA room (build brief 6, 9.1, 9.3; Phase 3 of the plan): the sim (agSim), what each socket is sent
// (agView over shared/agWire.js), the bots (agBots) and the clock. A FREE room (stake 0) holds no money. A PAID room
// (stake > 0, PAID-AGAR-DESIGN.md 5.2) adds its money controller (agMoney); every paid branch below sits behind
// `if (this.money)`, so the free room runs exactly as before.
//
// Hold-Q cash-out (Owen 2026-10-08, every room, free included): ag:hold from a live player locks its movement at once
// (the sim's still set: no steering, split and eject refused), and after HOLD_TICKS held ticks with a live cell the run
// ends. Free: the cells go (sim.clearCells) and the page is told ag:cashedout { free: true } (results screen, no
// money). Paid: agMoney cashes the account out 90/10. Let go early and nothing happens; the player stays edible while
// holding, and the eats of the completing tick run first, so death wins a same-tick tie. The parity streams never hold
// Q, so none of this runs there.
//
// The room refuses to open on a law table that is not shippable (assertShippable), and the sim refuses an approved
// rule it has not built yet, so production cannot open a room on a row that is not settled and built. Tests and the
// dev-only local boot pass shippableOnly: false with the FIXTURE table, which still has to pass assertLawsComplete
// for every row the room, sim, view and bots read.
//
// Clock: one sim step is exactly one tick of L1 milliseconds. The scheduler is Paper's: fixed steps against a
// monotonic clock, every due step run on a wake (at most MAX_STEPS_PER_WAKE; a longer stall drops the rest of its
// backlog, never one long step), then a sleep until the next step is due, so ticks land every L1 on average with
// no drift. It runs while any socket is seated (watchers included) and sleeps when the last one goes.
//
// Seats: every socket on the page gets a seat the moment it connects, with its own sim player (no cells yet) and
// its own viewer, so it is sent hello, border and world updates before it ever asks to play (protocol semantics
// 2.3: the client sends Play only after its first world update). ag:join spawns that player; the viewer puts the
// own id in the same bundle, before the world record that first carries the cell (protocol semantics 2.5, 3.8).
// Watcher seats are capped per room (ROOM_TUNING WATCHERS_PER_SLOT times L39), since each costs a view per tick.
//
// THE ONE RULE (server/GameRoom.js): bots exist only where nothing is staked. botsAllowed() asks what the room
// costs, never what it is called; every bot is made through it, and a room that is not free removes every bot.
// Every room of this build is free.
//
// Laws the room reads itself (the sim, view and bots check their own rows at creation):
//   L1 tick length, L4 view range (spectate zoom), L37 name cap, L39 players per room (the cap and the bot fill),
//   U_BOARD leaderboard rows and cadence, U_SPECTATE after-death view and spectate camera, WIRE_BACKLOG the
//   socket write-buffer depth that skips a tick, LEAVE_RULE what a leaving player loses, BOT_FILL the fill rule.

const crypto = require('crypto');
const { performance } = require('perf_hooks');
const { LAWS, assertShippable, assertLawsComplete } = require('./agLaws');
const { createSim } = require('./agSim');
const agView = require('./agView');
const agBots = require('./agBots');
const { createRng } = require('./agRng');
const { TickTimer } = require('../tickTimer');
const { AgMoney, AG_MONEY } = require('./agMoney');

const ROOM_LAW_IDS = Object.freeze([
  'L1', 'L4', 'L37', 'L39', 'U_BOARD', 'U_SPECTATE', 'WIRE_BACKLOG', 'LEAVE_RULE', 'BOT_FILL',
]);

// CHOSEN room internals (ours, not agar.io's): the values are Paper's, listed in the parity log with the other
// CHOSEN rows. None of them changes a game rule.
function chosen(value, note) {
  return Object.freeze({ value, status: 'CHOSEN', note });
}
const ROOM_TUNING = Object.freeze({
  MAX_STEPS_PER_WAKE: chosen(4, "Paper's MAX_STEPS_PER_WAKE: steps run on one wake at most; a longer stall drops " +
    'the rest of its backlog'),
  EMERGENCY_FAIL_TICKS: chosen(3, "Paper's EMERGENCY_FAIL_TICKS: this many throwing ticks in a row close the room, " +
    'and the directory opens a fresh one at the same index'),
  // Every seat costs a sim player, a view build and one bundle per tick, watchers included (Paper has no watchers,
  // so there is no Paper value). Ours: a room seats at most this many watchers per player slot (L39), so it never
  // builds more than twice the views of a full room. Measured on the FIXTURE table (review 2026-10-02): 1,000
  // watchers in one room cost 12 to 16 ms of a 40 ms tick, 3,000 cost 51 ms.
  WATCHERS_PER_SLOT: chosen(1, 'watcher seats per player slot: L39 watchers beside the L39 players; a socket past ' +
    'that watches another room, or is refused and closed'),
});
const MAX_STEPS_PER_WAKE = ROOM_TUNING.MAX_STEPS_PER_WAKE.value;
const EMERGENCY_FAIL_TICKS = ROOM_TUNING.EMERGENCY_FAIL_TICKS.value;
const WATCHERS_PER_SLOT = ROOM_TUNING.WATCHERS_PER_SLOT.value;

const SEED_SPAN = 0x7fffffff;   // seeds are drawn in [0, 2^31 - 1): a range for agRng, not a game number
const U16_MAX = 65535;          // the wire's board rank field is a u16
const EVENT = 'ag:f';           // the one server-to-client event (build brief 6)
const monotonicNow = () => performance.now();
let roomSeq = 0;

function fail(msg) {
  throw new Error('agRoom: ' + msg);
}

function stakeLabel(stake) {
  return 's' + String(Number(stake)).replace('.', '_');
}

function readRoomLaws(laws) {
  assertLawsComplete(laws, ROOM_LAW_IDS);
  const tickMs = laws.L1.value;
  if (typeof tickMs !== 'number' || !Number.isFinite(tickMs) || !(tickMs > 0)) fail('law L1 must be a number above 0');
  const cap = laws.L39.value;
  if (!Number.isInteger(cap) || cap < 1) fail('law L39 must be a whole number of players above 0');
  const backlog = laws.WIRE_BACKLOG.value;
  if (!Number.isInteger(backlog) || backlog < 0) fail('law WIRE_BACKLOG must be a whole number');
  const board = laws.U_BOARD.value;
  if (!board || typeof board !== 'object') fail('law U_BOARD must be { rows, periodMs, ownRowWhenOutside }');
  if (!Number.isInteger(board.rows) || board.rows < 1 || board.rows > 254) fail('law U_BOARD rows must be 1 to 254');
  if (typeof board.periodMs !== 'number' || !Number.isFinite(board.periodMs) || !(board.periodMs > 0)) {
    fail('law U_BOARD periodMs must be a number above 0');
  }
  if (typeof board.ownRowWhenOutside !== 'boolean') fail('law U_BOARD ownRowWhenOutside must be true or false');
  // U_BOARD was measured as every 25 world updates (periodMs is 25 ticks of L1): when periodMs is a whole number of
  // ticks the board is counted in ticks, so floating point can never move one by a tick.
  const perTicks = board.periodMs / tickMs;
  const boardTicks = Math.round(perTicks);
  const boardEvery = boardTicks >= 1 && Math.abs(perTicks - boardTicks) <= 1e-9 * boardTicks ? boardTicks : null;
  const spect = laws.U_SPECTATE.value;
  if (!spect || typeof spect !== 'object') fail('law U_SPECTATE must be { afterDeath, follow, zoom }');
  // The rules this file implements; any other approved rule must be built before a room can run on it.
  if (spect.afterDeath !== 'stayWhereDied') fail("law U_SPECTATE afterDeath '" + spect.afterDeath + "' is not built");
  if (spect.follow !== 'top') fail("law U_SPECTATE follow '" + spect.follow + "' is not built");
  if (spect.zoom !== 'followedPlayer') fail("law U_SPECTATE zoom '" + spect.zoom + "' is not built");
  if (laws.LEAVE_RULE.value !== 'removeAtOnce') fail("law LEAVE_RULE '" + laws.LEAVE_RULE.value + "' is not built");
  return { tickMs, cap, backlog, board, boardEvery, view: laws.L4.value };
}

class AgRoom {
  // laws: the law table (LAWS by default; the FIXTURE table in tests and the dev-only boot)
  // shippableOnly: true refuses any table assertShippable rejects (production); false only for tests and dev
  // stake: 0 in this build (money is out); kept so THE ONE RULE asks the room what it costs
  // clock: the monotonic clock the tick loop runs on; now: the wall clock (bot pause window)
  // autoTick: false in tests, which call wake() or tickOnce() themselves
  // viewBelowOf(socketId): the rows that socket's page reports under the reference view (ag:view, world units at
  // zoom 1), kept by the directory across rooms; every build hands it to the viewer (extra.below). Absent: 0
  // portraitOf(socketId): true while that socket's page plays the phone portrait layout (ag:portrait, as the
  // directory settled it); every build hands it to the viewer (extra.portrait). Absent: false
  // moneyHooks (paid rooms only, required there): agMoney's hooks, built by the directory (payout, collusion, the
  // one-seat-per-wallet map, remembered outcomes). onSeatless(socket, room, outcome): the directory forgets a paid
  // socket whose account just closed (death, cash-out, release, refund) or that another socket replaced.
  constructor({ laws = LAWS, shippableOnly = true, stake = 0, region = 'na', index = 0, seed, clock = monotonicNow,
    now = Date.now, autoTick = true, log = console, viewBelowOf = null, portraitOf = null, moneyHooks = null,
    onSeatless = null } = {}) {
    if (shippableOnly) assertShippable(laws);
    const R = readRoomLaws(laws);
    this.laws = laws;
    this.tickMs = R.tickMs;
    this.cap = R.cap;
    this.watchCap = Math.floor(R.cap * WATCHERS_PER_SLOT);
    this.backlog = R.backlog;
    this.boardLaw = R.board;
    this.boardEvery = R.boardEvery;
    this.viewLaw = R.view;
    this.stake = Number(stake) || 0;
    this.paid = this.stake > 0;
    this.region = region;
    this.index = index;
    this.lobbyType = 'ag_' + region + '_' + stakeLabel(this.stake) + (index > 0 ? '#' + index : '');
    this.id = ++roomSeq;
    this.clock = clock;
    this.now = now;
    this.autoTick = autoTick;
    this.log = log || console;
    this.viewBelowOf = typeof viewBelowOf === 'function' ? viewBelowOf : null;
    this.portraitOf = typeof portraitOf === 'function' ? portraitOf : null;

    const base = seed === undefined || seed === null ? crypto.randomInt(0, SEED_SPAN) : seed;
    this.rng = createRng(base);
    // The hold-Q freeze (every room) and, in a paid room, the shield (design 3.3): Sets the sim reads and the room
    // (free hold) or agMoney (paid) writes. Both empty: the sim runs exactly as it did without them.
    this.still = new Set();
    this.shielded = null;
    this.money = null;
    this.onSeatless = typeof onSeatless === 'function' ? onSeatless : null;
    this._holders = new Set();  // free rooms: seats with a hold message or a running hold
    if (this.paid) {
      if (!moneyHooks || typeof moneyHooks !== 'object') fail('a paid room needs its money hooks');
      this.shielded = new Set();
      this.sim = createSim({ laws, seed: this.rng.int(SEED_SPAN), paid: { shielded: this.shielded, still: this.still } });
      this.money = new AgMoney({
        sim: this.sim, stake: this.stake, label: this.lobbyType, hooks: moneyHooks, shielded: this.shielded,
        still: this.still, now, log: this.log,
        tell: (socketId, event, payload) => this._tell(socketId, event, payload),
        onClosed: (acct, outcome, extra) => this._paidClosed(acct, outcome, extra),
      });
    } else {
      this.sim = createSim({ laws, seed: this.rng.int(SEED_SPAN), still: this.still });
    }

    this.seats = new Map();     // socketId -> seat
    this.bots = new Map();      // sim pid -> { pid, name, brain, manual }
    this.stopped = false;
    this.closed = false;
    this.onClosed = null;       // set by the directory: (room, sockets) after an emergency close
    this.failCount = 0;
    this.timer = null;
    this._onWake = () => this._timerWake();
    this.acc = 0;
    this.last = 0;
    this._botsPausedUntil = 0;  // the owner console's Clear keeps the fill off until then (wall clock)
    this.stats = { ticks: 0, bundles: 0, bytes: 0, skipped: 0, resyncs: 0, buildErrors: 0, emitErrors: 0,
      viewRestarts: 0 };
    // Tick timing for GET /api/debug/tick (server/tickTimer.js): wake lateness, steps per wake, step cost, send
    // times, dropped backlog. _dueAt is when the armed timer's step is due; _nextDue the step tickOnce runs next
    // (NaN outside a wake); _sendEnd when the last step's bundles finished going out (all monotonic ms).
    this.timing = new TickTimer({ periodMs: this.tickMs, maxSteps: MAX_STEPS_PER_WAKE, clock, now });
    this._dueAt = NaN;
    this._nextDue = NaN;
    this._sendEnd = NaN;
    // Kept across ticks so a send allocates almost nothing for cells that did not change (S3, polish/FIX-PLAN.md):
    // the frame cache (agView.createFrameCache) and the array the sim's cells are listed into.
    this._frameCache = agView.createFrameCache();
    this._frameCells = [];
    this.fillBots();
  }

  // ---------------------------------------------------------------------------------------------------------
  // THE ONE RULE and the owner console contract (playerCount, botCount, botsAllowed, addBot, clearBots,
  // lobbyType).

  isFree() {
    return Number(this.stake) === 0;
  }

  botsAllowed() {
    return this.isFree();
  }

  // Humans who have joined (pressed Play at least once and not left). Watchers are not players. In a paid room:
  // every open account, away (grace, dormant) and frozen ones included, so the L39 cap, the lobby row and rule 4b
  // count parked money (design 5.2).
  get liveHumans() {
    if (this.money) return this.money.openCount();
    let n = 0;
    for (const s of this.seats.values()) if (s.joined) n++;
    return n;
  }

  get playerCount() {
    return this.liveHumans;
  }

  get botCount() {
    return this.bots.size;
  }

  // What ops.drainStatus reads: live humans; a free room's hold no money, a paid room's every open account with its
  // real worth (agMoney.snakes).
  get snakes() {
    if (this.money) return this.money.snakes;
    const m = new Map();
    for (const s of this.seats.values()) {
      if (!s.joined) continue;
      m.set('ag' + s.pid, { alive: this._alive(s.pid), isBot: false, worth: 0 });
    }
    return m;
  }

  // The solvency sum's share of this room, in dollars (0 in a free room), and floor money (none in agar).
  liveStakeTotal() {
    return this.money ? this.money.liveStakeTotal() : 0;
  }

  get floorWorth() {
    return this.money ? this.money.floorWorth : undefined;
  }

  // Open paid accounts (0 in a free room): a room with any never idles, sweeps or stops ticking (design 5.2).
  openAccounts() {
    return this.money ? this.money.openCount() : 0;
  }

  hasSpace() {
    return !this.stopped && this.liveHumans < this.cap;
  }

  // Seated sockets that have not joined (on the menu before their first Play). A paid room has no watchers.
  get watcherCount() {
    if (this.money) return 0;
    return this.seats.size - this.liveHumans;
  }

  // A watcher seat is free (ROOM_TUNING WATCHERS_PER_SLOT). Never in a paid room (no ghosting, design 8 #13).
  hasWatchSpace() {
    if (this.money) return false;
    return !this.stopped && this.watcherCount < this.watchCap;
  }

  // One bot by hand (the console marks the returned object manual, so the fill leaves it alone).
  addBot() {
    if (!this.botsAllowed() || this.stopped) return null;
    return this._spawnBot(true);
  }

  // Every bot, manual ones included; returns how many went.
  clearBots() {
    let n = 0;
    for (const bot of Array.from(this.bots.values())) {
      this._removeBot(bot);
      n++;
    }
    return n;
  }

  // Bots fill the room to the BOT_FILL rule (L39 minus the humans who joined); a paused fill adds none, and a
  // room that is not free has none at all.
  fillBots() {
    if (!this.botsAllowed()) {
      this.clearBots();
      return;
    }
    const auto = [];
    for (const b of this.bots.values()) if (!b.manual) auto.push(b);
    const plan = agBots.planBotFill({ humans: this.liveHumans, bots: auto.length, botsAllowed: true }, this.laws);
    if (plan.remove > 0) {
      auto.sort((a, b) => b.pid - a.pid);   // the newest automatic bots go first
      for (let i = 0; i < plan.remove && i < auto.length; i++) this._removeBot(auto[i]);
    }
    if (plan.add > 0 && !(this._botsPausedUntil > this.now())) {
      for (let i = 0; i < plan.add; i++) this._spawnBot(false);
    }
  }

  _spawnBot(manual) {
    const name = agBots.botName(this.rng);
    const pid = this.sim.addPlayer({ name, bot: true });
    const brain = agBots.createBotBrain({ laws: this.laws, seed: this.rng.int(SEED_SPAN) });
    const bot = { pid, name, brain, manual: manual === true };
    this.bots.set(pid, bot);
    this.sim.spawn(pid, name);
    return bot;
  }

  _removeBot(bot) {
    this.bots.delete(bot.pid);
    this.sim.removePlayer(bot.pid);
  }

  // ---------------------------------------------------------------------------------------------------------
  // Seats.

  _alive(pid) {
    const info = this.sim.playerInfo(pid);
    return !!(info && info.cells.length);
  }

  seatOf(socketId) {
    return this.seats.get(socketId) || null;
  }

  // A connected socket starts watching: its own sim player (no cells) and viewer. clearFirst puts a clearAll
  // in front of its first bundle (a socket that came from another room, or back after ag:leave, still holds
  // the old world on its page). A watcher needs a free watcher seat; forPlay (a socket whose Play comes next)
  // needs a free player slot instead. Returns the seat, or null when the room is stopped or has no seat for it.
  addSocket(socket, opts) {
    if (this.stopped || !socket || typeof socket.id !== 'string') return null;
    if (this.money) return null;   // a paid seat is made only by the door (addPaidHuman, resumePaid)
    const had = this.seats.get(socket.id);
    if (had) return had;
    if (opts && opts.forPlay ? !this.hasSpace() : !this.hasWatchSpace()) return null;
    const pid = this.sim.addPlayer({ name: '', bot: false });
    const seat = this._newSeat(socket, pid, !!(opts && opts.clearFirst));
    this._ensureTicking();
    return seat;
  }

  _newSeat(socket, pid, clearFirst) {
    const seat = {
      socketId: socket.id, socket, pid, viewer: agView.createViewer(pid, { laws: this.laws }),
      joined: false, spectating: false, stalled: false, spawnQueued: false, name: '',
      clearFirst: clearFirst === true,
      holdAt: 0, holding: false, holdTicks: 0,   // the free room's hold-Q state (a paid seat's lives in agMoney)
    };
    this.seats.set(socket.id, seat);
    return seat;
  }

  // The socket goes (disconnect, ag:leave, a move to another room): its player and cells are removed at once
  // (LEAVE_RULE 'removeAtOnce': cells go at the next step; a player with none goes from the sim right away, so a
  // room with no seat left, which runs no step, keeps nothing of it). Returns the socket, or null.
  // In a paid room a seat with an open account keeps its player: the account goes into its disconnect grace (an
  // unconfirmed one is refunded at once), and the room keeps ticking while any account is open (design 5.2).
  removeSocket(socketId) {
    const seat = this.seats.get(socketId);
    if (!seat) return null;
    this.seats.delete(socketId);
    const acct = this.money ? this.money.account(seat.pid) : null;
    if (acct && acct.socketId === socketId) this.money.beginGrace(seat.pid);
    else if (!acct) this.sim.removePlayer(seat.pid);
    if (!this.seats.size && !this.openAccounts()) this._goIdle();
    return seat.socket;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Paid seats (design 5.2). Only the paid door (agPaidDoor) calls these.

  // A bought seat: a spawn point clear of every cell that could eat it (design 3.3.5), the seat, the account
  // (unconfirmed: shielded and still until ag:ready), the spawn. Returns the account, or 'stopped', 'full', 'seated'
  // (this socket already sits here) or 'no-room' (no clear point), with nothing opened. Throws only after cleaning up
  // (no seat, no player, no account), for the door to refund.
  // entry: { name, micro, wallet, paid, proof, ip } (micro and wallet from the consumed token only)
  addPaidHuman(socket, entry) {
    if (!this.money) throw new Error('agRoom: addPaidHuman in a free room');
    if (this.stopped) return 'stopped';
    if (!socket || typeof socket.id !== 'string') throw new Error('agRoom: addPaidHuman needs a socket');
    if (this.seats.has(socket.id)) return 'seated';
    if (!this.hasSpace()) return 'full';
    const e = entry || {};
    const pt = this.sim.findSpawnPoint(this.sim.startSize(), AG_MONEY.SPAWN_CLEAR.value, AG_MONEY.SPAWN_TRIES.value);
    if (!pt) return 'no-room';
    const name = typeof e.name === 'string' ? e.name : '';
    const pid = this.sim.addPlayer({ name, bot: false });
    const seat = this._newSeat(socket, pid, true);
    seat.joined = true;
    seat.name = name;
    let acct = null;
    try {
      acct = this.money.open({ pid, socketId: socket.id, wallet: e.wallet, name, micro: e.micro, paid: e.paid,
        proof: e.proof, ip: e.ip });
      if (!this.sim.spawn(pid, name, pt)) throw new Error('spawn refused');
    } catch (err) {
      if (acct && this.money.account(pid)) this.money.abort(pid);
      if (this.seats.get(socket.id) === seat) this.seats.delete(socket.id);
      this.sim.removePlayer(pid);
      throw err;
    }
    this._ensureTicking();
    return acct;
  }

  // A socket takes an open account back (design 3.4 resume): by its resume key, by the entry token of an unconfirmed
  // seat (byToken), or by a new token from the same wallet. The socket that held it, if any, is told ag:replaced and
  // loses its seat. A frozen account cannot be taken. The page is sent ag:joined { resumed: true } and a fresh view
  // (clearAll first). True when the socket now holds the seat.
  resumePaid(socket, pid, opts) {
    if (!this.money || this.stopped || !socket || typeof socket.id !== 'string') return false;
    const acct = this.money.account(pid);
    if (!acct || acct.state === 'frozen') return false;
    if (opts && opts.byToken && acct.state !== 'unconfirmed') return false;
    if (this.seats.has(socket.id)) return false;    // this socket sits here already (the door drops that first)
    const prev = acct.socketId;
    if (prev && prev !== socket.id) {
      const old = this.seats.get(prev);
      if (old && old.pid === pid) {
        this.seats.delete(prev);
        this._emit(old.socket, 'ag:replaced', {});
        if (this.onSeatless) this._safe(() => this.onSeatless(old.socket, this, 'replaced'));
      }
    }
    if (this.money.resume(pid, socket.id) === false) return false;
    const seat = this._newSeat(socket, pid, true);
    seat.joined = true;
    seat.name = acct.name;
    this._ensureTicking();
    this._emit(socket, 'ag:joined', this.joinedPayload(acct, true));
    return true;
  }

  // What ag:joined carries (design 4 step 4): the resume key (the page keeps it in sessionStorage), the rung, the
  // seat's money and the hold length the ring fills over.
  joinedPayload(acct, resumed) {
    return { stake: this.stake, micro: this.money.balance(acct.pid), resumeKey: acct.resumeKey, resumed: !!resumed,
      confirmed: acct.state !== 'unconfirmed', holdTicks: AG_MONEY.HOLD_TICKS.value, tickMs: this.tickMs };
  }

  // ag:ready (design 3.4 confirm): the page drew a frame with its own cell; the shield and the freeze go.
  ready(socketId) {
    if (!this.money) return false;
    const seat = this.seats.get(socketId);
    if (!seat) return false;
    return this.money.confirm(seat.pid, socketId);
  }

  // ag:hold { on } (Owen 2026-10-08). Free: a live joined player only; paid: agMoney decides (a confirmed live account
  // with its socket attached and a live cell).
  hold(socketId, on) {
    const seat = this.seats.get(socketId);
    if (!seat || !seat.joined) return false;
    if (this.money) return this.money.setHold(seat.pid, socketId, on === true);
    if (on === true) {
      if (seat.spawnQueued || !this._alive(seat.pid)) return false;
      seat.holdAt = this.now();
      this._holders.add(seat);
    } else {
      seat.holdAt = 0;
    }
    return true;
  }

  // The seat of a paid account the controller just closed (agMoney onClosed): the page hears what happened, the
  // seat goes (the socket is seatless now: the directory is told) and so does the sim player (a player with cells
  // left goes at the next step, before any eat).
  _paidClosed(acct, outcome, extra) {
    const seat = acct.socketId ? this.seats.get(acct.socketId) : null;
    if (seat && seat.pid === acct.pid) {
      this.seats.delete(seat.socketId);
      const x = extra || {};
      if (outcome === 'eaten') this._emit(seat.socket, 'ag:dead', { lostMicro: x.lostMicro || 0, by: x.by || '' });
      else if (outcome === 'released') {
        this._emit(seat.socket, 'ag:refused', { why: x.why || 'released', refunded: !!x.refunded });
      } else if (outcome === 'refunded') {
        this._emit(seat.socket, 'ag:closed', { refundedMicro: x.refundedMicro || 0, why: x.why || 'emergency' });
      } else if (outcome === 'frozen-settled') {
        this._emit(seat.socket, 'ag:closed', { refundedMicro: 0, why: outcome });
      }
      // 'cashedout' and 'settled': the payout tells the page (ag:cashedout, then ag:paid or ag:payerror).
      // 'aborted': the seat never opened (the door refuses and refunds it).
      if (this.onSeatless && outcome !== 'aborted') this._safe(() => this.onSeatless(seat.socket, this, outcome));
    }
    this.sim.removePlayer(acct.pid);
  }

  _tell(socketId, event, payload) {
    const seat = socketId ? this.seats.get(socketId) : null;
    if (seat) this._emit(seat.socket, event, payload);
  }

  _emit(socket, event, payload) {
    if (!socket || typeof socket.emit !== 'function') return;
    try {
      socket.emit(event, payload);
    } catch (e) {
      this.log.error('[AG] emit ' + event, e && e.message);
    }
  }

  _safe(fn) {
    try {
      fn();
    } catch (e) {
      this.log.error('[AG] directory hook', e && e.stack ? e.stack : e);
    }
  }

  // Play. 'ok' (spawn queued for the next step), 'alive' (already playing: nothing changes, so a repeated Play
  // can never rename a live player), 'full' (the room has no player slot), 'none' (no seat), 'stopped'.
  // 'paid': a paid room never takes a Play (a paid seat is bought at the door; a dead seat is gone).
  join(socketId, name) {
    if (this.stopped) return 'stopped';
    if (this.money) return 'paid';
    const seat = this.seats.get(socketId);
    if (!seat) return 'none';
    if (!seat.joined && this.liveHumans >= this.cap) return 'full';
    if (seat.spawnQueued || this._alive(seat.pid)) return 'alive';
    const nm = typeof name === 'string' ? name : '';
    seat.joined = true;
    seat.spectating = false;
    seat.spawnQueued = true;
    seat.name = nm;
    this.sim.spawn(seat.pid, nm);
    return 'ok';
  }

  // Spectate (their op 1): only without live cells (a seated live player cannot spectate).
  spectate(socketId) {
    if (this.money) return false;    // no spectate on a paid rung, a dead seat included (design 8 #13)
    const seat = this.seats.get(socketId);
    if (!seat || seat.spawnQueued || this._alive(seat.pid)) return false;
    seat.spectating = true;
    return true;
  }

  // Paid inputs count only from a confirmed live account (targets before ag:ready are ignored, design 4 step 5).
  _paidInputOk(seat) {
    const acct = this.money.account(seat.pid);
    return !!(acct && acct.state === 'live' && acct.socketId === seat.socketId);
  }

  // A held player is still and cannot split or eject (Owen 2026-10-08): free seats here, paid ones in agMoney.
  _holdingNow(seat) {
    if (this.money) {
      const acct = this.money.account(seat.pid);
      return !!(acct && acct.holding);
    }
    return seat.holding === true;
  }

  // The mouse target in world units (integers, checked by agSockets). Kept while holding (the sim skips steering), so
  // a released hold carries on toward the mouse.
  target(socketId, x, y) {
    const seat = this.seats.get(socketId);
    if (!seat || !seat.joined) return false;
    if (this.money && !this._paidInputOk(seat)) return false;
    return this.sim.setInput(seat.pid, { x, y });
  }

  split(socketId) {
    const seat = this.seats.get(socketId);
    if (!seat || !seat.joined) return false;
    if (this.money && !this._paidInputOk(seat)) return false;
    if (this._holdingNow(seat)) return false;
    return this.sim.split(seat.pid);
  }

  eject(socketId) {
    const seat = this.seats.get(socketId);
    if (!seat || !seat.joined) return false;
    if (this.money && !this._paidInputOk(seat)) return false;
    if (this._holdingNow(seat)) return false;
    return this.sim.eject(seat.pid);
  }

  // Q: the client sends it as theirs does; our FFA server ignores it (law Q_KEY 'ignore', checked by the sim).
  q() {
    return false;
  }

  // ---------------------------------------------------------------------------------------------------------
  // One tick: bots think, the sim steps, dead bots respawn and the fill runs, then every seat gets its bundle.

  tickOnce() {
    if (this.stopped) return false;
    const start = this.clock();
    this._sendEnd = NaN;
    try {
      this._step();
    } catch (e) {
      this.failCount++;
      this.log.error('[AG] TICK threw', this.lobbyType, this.failCount, e && e.stack ? e.stack : e);
      if (this.failCount >= EMERGENCY_FAIL_TICKS) this.emergencyClose();
      return false;
    }
    this.failCount = 0;
    this.timing.step(this._nextDue, start, this._sendEnd, this.clock());
    return true;
  }

  _step() {
    if (this.money) this.money.holdTick();
    else if (this._holders.size) this._holdTickFree();
    this._thinkBots();
    const ev = this.sim.step();
    for (const s of this.seats.values()) s.spawnQueued = false;
    // Money after the step, in sim order (design 3.4); free holds after the eats too, so death wins a tie.
    if (this.money) this.money.afterStep(ev);
    else if (this._holders.size) this._holdDoneFree();
    for (const bot of this.bots.values()) {
      if (!this._alive(bot.pid)) this.sim.spawn(bot.pid, bot.name);   // a dead bot is back on the next step
    }
    this.fillBots();
    this._send(ev);
    this._sendEnd = this.clock();
    this.stats.ticks++;
  }

  // Free hold-Q, before the step: a seat holds while it has a fresh hold message and a live cell; the first such tick
  // locks its movement (the still set) and tells the page, every held tick counts. Anything else ends the hold with
  // nothing done.
  _holdTickFree() {
    const now = this.now();
    const stale = AG_MONEY.HOLD_INPUT_STALE_MS.value;
    for (const seat of Array.from(this._holders)) {
      const seated = this.seats.get(seat.socketId) === seat;
      const want = seated && seat.holdAt > 0 && now - seat.holdAt <= stale && this._alive(seat.pid);
      if (want) {
        if (!seat.holding) {
          seat.holding = true;
          seat.holdTicks = 0;
          this.still.add(seat.pid);
          this._emit(seat.socket, 'ag:holding', { on: 1, need: AG_MONEY.HOLD_TICKS.value });
        }
        seat.holdTicks++;
      } else {
        this._endFreeHold(seat, seated);
      }
    }
  }

  _endFreeHold(seat, tellIt) {
    const was = seat.holding;
    seat.holding = false;
    seat.holdTicks = 0;
    seat.holdAt = 0;
    this.still.delete(seat.pid);
    this._holders.delete(seat);
    if (was && tellIt) this._emit(seat.socket, 'ag:holding', { on: 0 });
  }

  // Free hold-Q, after the step: HOLD_TICKS held ticks with a live cell end the run (Owen 2026-10-08: the free room
  // has no money, the page shows its results screen). The cells go at the next step, before anything can eat them.
  _holdDoneFree() {
    for (const seat of Array.from(this._holders)) {
      if (!seat.holding || seat.holdTicks < AG_MONEY.HOLD_TICKS.value) continue;
      const seated = this.seats.get(seat.socketId) === seat;
      if (!seated || !this._alive(seat.pid)) {          // eaten in the completing tick: death wins
        this._endFreeHold(seat, seated);
        continue;
      }
      seat.holding = false;
      this._endFreeHold(seat, false);
      this.sim.clearCells(seat.pid);
      this._emit(seat.socket, 'ag:cashedout', { free: true });
    }
  }

  // Each bot sees every cell its brain could sense (agBots SENSE_*), in the sim's deterministic order. A brain only
  // re-decides every few ticks (its reaction time); in between the sim keeps its last target, so no view is built.
  _thinkBots() {
    if (!this.bots.size) return;
    const tick = this.sim.tick();
    const border = this.sim.border();
    const T = agBots.BOT_TUNING;
    for (const bot of this.bots.values()) {
      if (!bot.brain.wantsThink(tick)) continue;
      const info = this.sim.playerInfo(bot.pid);
      if (!info || !info.cells.length) continue;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, biggest = 0;
      for (const id of info.cells) {
        const c = this.sim.getCell(id);
        if (!c) continue;
        if (c.x < minX) minX = c.x;
        if (c.x > maxX) maxX = c.x;
        if (c.y < minY) minY = c.y;
        if (c.y > maxY) maxY = c.y;
        if (c.size > biggest) biggest = c.size;
      }
      if (!(biggest > 0)) continue;
      const reach = T.SENSE_BASE.value + T.SENSE_PER_SIZE.value * biggest + biggest;
      const cells = [];
      this.sim.forEachCellInRect(minX - reach, minY - reach, maxX + reach, maxY + reach, (c) => {
        cells.push({ id: c.id, owner: c.kind === 'ejected' ? c.ejectedBy : c.owner, x: c.x, y: c.y, size: c.size,
          kind: c.kind });
      });
      const d = bot.brain.think({ playerId: bot.pid, tick, border, cells });
      if (!d) continue;
      this.sim.setInput(bot.pid, { x: d.tx, y: d.ty, split: d.split === true, eject: d.eject === true });
    }
  }

  // Alive players by score (mass), biggest first; equal scores in join order. A paid room sorts by money first, then
  // score (design 5.2).
  _ranking() {
    const out = [];
    this.sim.forEachPlayer((p) => {
      if (p.cells.length) out.push({ pid: p.pid, name: p.name, score: p.score });
    });
    if (this.money) {
      for (const r of out) r.micro = this.money.balance(r.pid);
      out.sort((a, b) => b.micro - a.micro || b.score - a.score || a.pid - b.pid);
      return out;
    }
    out.sort((a, b) => b.score - a.score || a.pid - b.pid);
    return out;
  }

  // ag:money (design 6): the viewer's own balance and rank, each player cell it knows with its share of its owner's
  // money (floor shares in id order, the last cell of an owner takes the remainder, so the shares add up to the
  // total), the money board (top U_BOARD rows, name and micro), and the known cells whose owner is away (not yet
  // confirmed, disconnected, dormant or frozen: still and edible or shielded; the page draws them faded). Display
  // only; nothing here moves money.
  _moneyPayload(seat, ranking, shares, away) {
    const me = this.money.balance(seat.pid);
    let rank = 0;
    for (let i = 0; i < ranking.length; i++) {
      if (ranking[i].pid === seat.pid) {
        rank = i + 1;
        break;
      }
    }
    const cells = [];
    const gone = [];
    for (const id of seat.viewer.knownIds()) {
      const v = shares.get(id);
      if (v !== undefined) cells.push(id, v);
      if (away && away.has(id)) gone.push(id);
    }
    const board = [];
    for (let i = 0; i < ranking.length && i < this.boardLaw.rows; i++) board.push([ranking[i].name || '', ranking[i].micro]);
    return { me, rank, cells, board, away: gone };
  }

  // The cell ids of every open account that is not live: unconfirmed (shielded until ag:ready), grace and dormant
  // (disconnected), frozen (the zombie backstop). Display only (ag:money away).
  _awayCells() {
    const out = new Set();
    for (const acct of this.money.accounts.values()) {
      if (acct.state === 'live') continue;
      const info = this.sim.playerInfo(acct.pid);
      if (!info) continue;
      for (const id of info.cells) out.add(id);
    }
    return out;
  }

  // cell id -> its display share, for every player cell of an open account.
  _cellShares() {
    const out = new Map();
    for (const acct of this.money.accounts.values()) {
      const info = this.sim.playerInfo(acct.pid);
      if (!info || !info.cells.length) continue;
      const bal = this.money.balance(acct.pid);
      const ids = info.cells.slice().sort((a, b) => a - b);
      let sum = 0;
      const sq = [];
      for (const id of ids) {
        const c = this.sim.getCell(id);
        const s = c ? c.size * c.size : 0;
        sq.push(s);
        sum += s;
      }
      let given = 0;
      for (let i = 0; i < ids.length; i++) {
        const v = i === ids.length - 1 ? bal - given : sum > 0 ? Math.floor((bal * sq[i]) / sum) : 0;
        out.set(ids[i], v);
        given += v;
      }
    }
    return out;
  }

  // U_BOARD cadence: a board goes out on every boardEvery-th tick when periodMs is a whole number of ticks (the real
  // table: every 25), else on the tick whose end crosses a multiple of periodMs of room time.
  _boardDue(ticksDone) {
    if (this.boardEvery !== null) return ticksDone > 0 && ticksDone % this.boardEvery === 0;
    const p = this.boardLaw.periodMs;
    return Math.floor((ticksDone * this.tickMs) / p) > Math.floor(((ticksDone - 1) * this.tickMs) / p);
  }

  // The rows one socket sees: the top U_BOARD rows, its own row flagged; with ownRowWhenOutside, its own row
  // appended (with its rank) when it is alive and outside the top. An empty name is not sent (their client
  // shows its own placeholder).
  _rowsFor(ranking, seat) {
    const n = this.boardLaw.rows;
    const row = (p, me) => {
      const r = {};
      if (p.name) r.name = p.name;
      if (me) r.me = true;
      return r;
    };
    const rows = [];
    for (let i = 0; i < ranking.length && i < n; i++) rows.push(row(ranking[i], ranking[i].pid === seat.pid));
    if (this.boardLaw.ownRowWhenOutside) {
      for (let i = n; i < ranking.length; i++) {
        if (ranking[i].pid !== seat.pid) continue;
        const r = row(ranking[i], true);
        r.rank = Math.min(i + 1, U16_MAX);
        rows.push(r);
        break;
      }
    }
    return rows;
  }

  // U_SPECTATE follow 'top' with zoom 'followedPlayer': the camera sits on the plain average of the top
  // player's cells (the view centre rule of agView) at the scale that player's own view uses (L4).
  _topFocus(ranking) {
    const top = ranking.length ? ranking[0] : null;
    if (!top) return null;
    const info = this.sim.playerInfo(top.pid);
    if (!info || !info.cells.length) return null;
    let sx = 0, sy = 0, sum = 0, n = 0;
    for (const id of info.cells) {
      const c = this.sim.getCell(id);
      if (!c) continue;
      sx += c.x;
      sy += c.y;
      sum += c.size;
      n++;
    }
    if (!n) return null;
    return { x: sx / n, y: sy / n, zoom: agView.scaleFor(sum, this.viewLaw) };
  }

  _backedUp(socket) {
    const wb = socket && socket.conn && socket.conn.writeBuffer;
    return !!(wb && typeof wb.length === 'number' && wb.length > this.backlog);
  }

  // One bundle per seat per tick (reliable, ordered: one emit per socket per tick). A socket whose write buffer
  // is deeper than WIRE_BACKLOG is skipped (its viewer is not built, so nothing it was not sent is assumed) and
  // gets a sync record once it drains.
  _send(ev) {
    if (!this.seats.size) return;
    const cells = this._frameCells;
    let n = 0;
    this.sim.forEachCell((c) => { cells[n++] = c; });
    while (cells.length > n) cells.pop();
    const frame = agView.makeFrame({ border: ev.border, cells, eats: ev.eats, removed: ev.removed }, this.laws,
      this._frameCache);
    const boardDue = this._boardDue(this.sim.tick());
    let ranking = null;
    let focus;
    for (const seat of this.seats.values()) {
      if (seat.spectating && !ranking) ranking = this._ranking();
    }
    if (boardDue && !ranking) ranking = this._ranking();
    // Paid rooms: ag:money on the board's cadence (every 25 ticks, U_BOARD), to a seat only right after its own
    // bundle went out, from the same ranking (a backed-up seat that skips its bundle skips its money too).
    const moneyDue = this.money !== null && boardDue;
    const shares = moneyDue ? this._cellShares() : null;
    const away = moneyDue ? this._awayCells() : null;
    for (const seat of Array.from(this.seats.values())) {
      const socket = seat.socket;
      if (this._backedUp(socket)) {
        seat.stalled = true;
        this.stats.skipped++;
        continue;
      }
      if (seat.stalled) {
        seat.stalled = false;
        seat.viewer.resync();
        this.stats.resyncs++;
      }
      const extra = {};
      if (boardDue) extra.board = this._rowsFor(ranking, seat);
      const below = this.viewBelowOf ? this.viewBelowOf(seat.socketId) : 0;
      if (below > 0) extra.below = below;
      if (this.portraitOf && this.portraitOf(seat.socketId) === true) extra.portrait = true;
      if (seat.spectating && !this._alive(seat.pid)) {
        if (focus === undefined) focus = this._topFocus(ranking);
        if (focus) extra.focus = focus;
      }
      let buf;
      try {
        const records = seat.viewer.build(frame, extra);
        if (seat.clearFirst) {
          records.unshift({ t: 'clearAll' });
          seat.clearFirst = false;
        }
        buf = seat.viewer.encode(records);
      } catch (e) {
        // Never seen in tests; the viewer may have counted this bundle as sent, so the page starts over.
        this.stats.buildErrors++;
        this._restartView(seat);
        this.log.error('[AG] bundle failed', this.lobbyType, e && e.message);
        continue;
      }
      try {
        socket.emit(EVENT, buf);
      } catch (e) {
        // The viewer already counts this bundle's records as delivered (an own id, a new cell's colour), and a
        // sync record would not announce an own id again: the page starts over instead.
        this.stats.emitErrors++;
        this._restartView(seat);
        this.log.error('[AG] emit failed', this.lobbyType, e && e.message);
        continue;
      }
      this.stats.bundles++;
      this.stats.bytes += buf.length;
      if (moneyDue) this._emit(socket, 'ag:money', this._moneyPayload(seat, ranking, shares, away));
    }
  }

  // A bundle that never reached the page (a build or emit that threw): what the viewer thinks the page holds is
  // no longer known, so the seat gets a fresh viewer and its next bundle starts with clearAll, then the join
  // order again (hello, border, world, own ids before their cells), the same as a socket moved in from another
  // room.
  _restartView(seat) {
    seat.viewer = agView.createViewer(seat.pid, { laws: this.laws });
    seat.clearFirst = true;
    seat.stalled = false;
    this.stats.viewRestarts++;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Clock (Paper's drift-free scheduler, at the law table's L1).

  _ensureTicking() {
    if (this.timer || this.stopped || !this.autoTick) return;
    this.last = this.clock();
    this.acc = 0;
    this._arm();
  }

  // Milliseconds until the next step is due (0 when one already is).
  _dueIn() {
    return Math.max(0, this.tickMs - this.acc - (this.clock() - this.last));
  }

  // Timers are whole milliseconds: sleep to the first one at or after the due time. The due time itself is kept,
  // so the wake can record how late the event loop let it run.
  _arm() {
    const dueIn = this._dueIn();
    this._dueAt = this.clock() + dueIn;
    this.timer = setTimeout(this._onWake, Math.max(1, Math.ceil(dueIn)));
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
  }

  _goIdle() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this._dueAt = NaN;
    this.timing.idle();
  }

  // Runs every step that is due; returns how many ran.
  wake() {
    const now = this.clock();
    const firstDue = this.last + this.tickMs - this.acc;   // when the first of the steps below was due
    this.acc += now - this.last;
    this.last = now;
    let steps = Math.floor(this.acc / this.tickMs);
    let dropped = 0;
    if (steps > MAX_STEPS_PER_WAKE) {
      dropped = steps - MAX_STEPS_PER_WAKE;
      steps = MAX_STEPS_PER_WAKE;
      this.acc %= this.tickMs;     // extra backlog is dropped, never one long step
    } else {
      this.acc -= steps * this.tickMs;
    }
    this.timing.wakeBegin(now, this._dueAt);
    this._dueAt = NaN;
    if (dropped) this.timing.dropped(dropped, dropped * this.tickMs);
    let ran = 0;
    while (steps-- > 0 && !this.stopped) {
      this._nextDue = firstDue + ran * this.tickMs;
      this.tickOnce();
      ran++;
    }
    this._nextDue = NaN;
    this.timing.wakeEnd(ran);
    return ran;
  }

  _timerWake() {
    this.timer = null;
    if (this.stopped) return;
    this.wake();
    // A paid room keeps ticking while any account is open, seated or not (grace and dormant timers, design 5.2).
    if (!this.stopped && !this.timer && (this.seats.size || this.openAccounts())) this._arm();
  }

  // ---------------------------------------------------------------------------------------------------------
  // Closing.

  // EMERGENCY_FAIL_TICKS throwing ticks in a row: the room stops for good and hands its sockets to the
  // directory, which opens a fresh room at this index and seats them there (a free room owes nothing). A paid room
  // first refunds every open balance in full (Owen Q6: a crash is our fault; agMoney.emergencySettle), which tells
  // each seated page ag:closed and makes its socket seatless; the directory keeps this room on its settling list
  // while any account could not be settled.
  emergencyClose() {
    if (this.closed) return;
    this.closed = true;
    if (this.money) {
      try {
        this.money.emergencySettle();
      } catch (e) {
        this.log.error('[AG] EMERGENCY settle threw', this.lobbyType, e && e.stack ? e.stack : e);
      }
      // A seat left without an account (none should be) is told and dropped too.
      for (const seat of Array.from(this.seats.values())) {
        this.seats.delete(seat.socketId);
        this._emit(seat.socket, 'ag:closed', { refundedMicro: 0, why: 'emergency' });
        if (this.onSeatless) this._safe(() => this.onSeatless(seat.socket, this, 'emergency'));
      }
    }
    const sockets = Array.from(this.seats.values()).map((s) => s.socket);
    this.log.error('[AG] EMERGENCY close', this.lobbyType, sockets.length + ' socket(s) moved');
    this.stop();
    if (typeof this.onClosed === 'function') {
      try {
        this.onClosed(this, sockets);
      } catch (e) {
        this.log.error('[AG] replace failed', e && e.stack ? e.stack : e);
      }
    }
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this._goIdle();
  }
}

module.exports = { AgRoom, ROOM_LAW_IDS, ROOM_TUNING, stakeLabel };
