'use strict';
// One free agar.io FFA room (build brief 6, 9.1, 9.3; Phase 3 of the plan): the sim (agSim), what each socket is
// sent (agView over shared/agWire.js), the bots (agBots) and the clock. No money lives here: this build is free.
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
  constructor({ laws = LAWS, shippableOnly = true, stake = 0, region = 'na', index = 0, seed, clock = monotonicNow,
    now = Date.now, autoTick = true, log = console } = {}) {
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

    const base = seed === undefined || seed === null ? crypto.randomInt(0, SEED_SPAN) : seed;
    this.rng = createRng(base);
    this.sim = createSim({ laws, seed: this.rng.int(SEED_SPAN) });

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

  // Humans who have joined (pressed Play at least once and not left). Watchers are not players.
  get liveHumans() {
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

  // What ops.drainStatus reads: live humans, none of them holding money (this build is free).
  get snakes() {
    const m = new Map();
    for (const s of this.seats.values()) {
      if (!s.joined) continue;
      m.set('ag' + s.pid, { alive: this._alive(s.pid), isBot: false, worth: 0 });
    }
    return m;
  }

  hasSpace() {
    return !this.stopped && this.liveHumans < this.cap;
  }

  // Seated sockets that have not joined (on the menu before their first Play).
  get watcherCount() {
    return this.seats.size - this.liveHumans;
  }

  // A watcher seat is free (ROOM_TUNING WATCHERS_PER_SLOT).
  hasWatchSpace() {
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
    const had = this.seats.get(socket.id);
    if (had) return had;
    if (opts && opts.forPlay ? !this.hasSpace() : !this.hasWatchSpace()) return null;
    const pid = this.sim.addPlayer({ name: '', bot: false });
    const seat = {
      socketId: socket.id, socket, pid, viewer: agView.createViewer(pid, { laws: this.laws }),
      joined: false, spectating: false, stalled: false, spawnQueued: false, name: '',
      clearFirst: !!(opts && opts.clearFirst),
    };
    this.seats.set(socket.id, seat);
    this._ensureTicking();
    return seat;
  }

  // The socket goes (disconnect, ag:leave, a move to another room): its player and cells are removed at once
  // (LEAVE_RULE 'removeAtOnce': cells go at the next step; a player with none goes from the sim right away, so a
  // room with no seat left, which runs no step, keeps nothing of it). Returns the socket, or null.
  removeSocket(socketId) {
    const seat = this.seats.get(socketId);
    if (!seat) return null;
    this.seats.delete(socketId);
    this.sim.removePlayer(seat.pid);
    if (!this.seats.size) this._goIdle();
    return seat.socket;
  }

  // Play. 'ok' (spawn queued for the next step), 'alive' (already playing: nothing changes, so a repeated Play
  // can never rename a live player), 'full' (the room has no player slot), 'none' (no seat), 'stopped'.
  join(socketId, name) {
    if (this.stopped) return 'stopped';
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
    const seat = this.seats.get(socketId);
    if (!seat || seat.spawnQueued || this._alive(seat.pid)) return false;
    seat.spectating = true;
    return true;
  }

  // The mouse target in world units (integers, checked by agSockets).
  target(socketId, x, y) {
    const seat = this.seats.get(socketId);
    if (!seat || !seat.joined) return false;
    return this.sim.setInput(seat.pid, { x, y });
  }

  split(socketId) {
    const seat = this.seats.get(socketId);
    if (!seat || !seat.joined) return false;
    return this.sim.split(seat.pid);
  }

  eject(socketId) {
    const seat = this.seats.get(socketId);
    if (!seat || !seat.joined) return false;
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
    this._thinkBots();
    const ev = this.sim.step();
    for (const s of this.seats.values()) s.spawnQueued = false;
    for (const bot of this.bots.values()) {
      if (!this._alive(bot.pid)) this.sim.spawn(bot.pid, bot.name);   // a dead bot is back on the next step
    }
    this.fillBots();
    this._send(ev);
    this._sendEnd = this.clock();
    this.stats.ticks++;
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

  // Alive players by score (mass), biggest first; equal scores in join order.
  _ranking() {
    const out = [];
    this.sim.forEachPlayer((p) => {
      if (p.cells.length) out.push({ pid: p.pid, name: p.name, score: p.score });
    });
    out.sort((a, b) => b.score - a.score || a.pid - b.pid);
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
    const cells = [];
    this.sim.forEachCell((c) => cells.push(c));
    const frame = agView.makeFrame({ border: ev.border, cells, eats: ev.eats, removed: ev.removed }, this.laws);
    const boardDue = this._boardDue(this.sim.tick());
    let ranking = null;
    let focus;
    for (const seat of this.seats.values()) {
      if (seat.spectating && !ranking) ranking = this._ranking();
    }
    if (boardDue && !ranking) ranking = this._ranking();
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
    if (!this.stopped && !this.timer && this.seats.size) this._arm();
  }

  // ---------------------------------------------------------------------------------------------------------
  // Closing.

  // EMERGENCY_FAIL_TICKS throwing ticks in a row: the room stops for good and hands its sockets to the
  // directory, which opens a fresh room at this index and seats them there (free build: nothing is owed).
  emergencyClose() {
    if (this.closed) return;
    this.closed = true;
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
