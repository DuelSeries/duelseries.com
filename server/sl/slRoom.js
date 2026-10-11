'use strict';
// slither.io free room: the room (SERVER-DESIGN 5, 9, 12.4, 15.3; task T9). The clock, the catch-up, the slices, the
// slower clocks, input arrival offsets, the on-arrival pong and echo, holds (slHold), the connection-blip glide, the
// idle pause and the stats. It holds no money and requires no money code (test/slNoMoney.test.js, SERVER-DESIGN 13
// item 11): a free seat is worth nothing.
//
// ONE TICK (SERVER-DESIGN 5.3). A wake runs every due step (at most C_MAX_STEPS; a longer stall drops its backlog and
// counts the dropped ms), each step being the sim part, back to back:
//   0 bots      opts.bots.beforeInputs: due brains write the SAME input records a client sends (slBots)
//   1 inputs    sim.applyInputs (records were merged into each snake's slot on arrival, with their arrival offset)
//   2 hold      slHold book: ends, starts (the steering lock and its ONE rotation record, 15.3), the old ramp, the
//               safety net; then the connection-blip glide locks (C_DISCONNECT)
//   4-5 sim     sim.step: every snake once in a seeded order, eats, collisions at one instant, deaths and drops
//   6 holds     a hold that reached C_HOLD_MS with its snake alive cashes out (a death of this tick wins the tie):
//               the snake leaves the sim with no food; others are told C_CASHOUT_CODE, the own seat `dead`
//   7 clocks    the room's slower clocks on sim time: L9 leaderboard, L10 minimap, L11 slow and fast checks, L8 sweep
//   8 room      glides that ran out die (sim.kill), the kill line (C_KILLFEED), the shared view step
// then ONCE per wake the seat part, in slices of C_FLUSH_SLICE_MS (a slice yields with setImmediate):
//   9 views     each seat's view collects the records of every step of this wake
//  10 flush     records into the seat's send queue (slSendQueue), the cap and stall checks, then a flush when the
//               transport can take it
//  11 timing    TickTimer rows (server/tickTimer.js) and the room stats
//
// ON ARRIVAL (SERVER-DESIGN 5.2): an input is merged into the snake's slot now, stamped with its arrival offset (ms
// before the step that applies it; C_INPUT_OFFSET). A ping gets its pong in the queue now (L47); an angle or arrow
// turn of a live snake that is not held gets its own wanted-angle echo now (C_ECHO_NOW); then a flush is scheduled on
// setImmediate, so every record of one POST leaves in one bundle.
//
// THE SEAT VIEW CONTRACT. The room does not decide what a seat is sent; slView does (task T8). The room calls:
//   opts.view.createWorld(laws, sim) -> world                    once per room
//   world.afterStep(frame)                                        once per sim step, right after it, while sim.log
//                                                                 (frame.log) is valid: the shared records of the step
//   world.idBlocked(id)                                           (optional) true while a seat may still hold id
//   opts.view.createSeatView(laws, { sim, world, ownId }) -> view one per seat, at sl:join
//   view.join(ctx) -> events                                      the join bundle (init, own add, the world)
//   view.collect(ctx) -> events                                   once per wake: this seat's records of ctx.frames
//                                                                 (only the steps after its join), in order
//   view.noteOwnRot({ dir, wangRaw })                             (optional) the room queued an own echo
//   view.resync()                                                 the seat queue dropped what the client was going
//                                                                 to get (9.3): forget everything but the own snake;
//                                                                 the room calls collect at once to re-add
//   view.leave()                                                  (optional) the seat went (unseat)
// frame = { tick, simMs, log, locks: [rotation events], cashed: [{ id, code }], clocks: { lb, mm, zSlow, zFast,
// sweep } (true on the step the clock fired), board: null or { order: [{ id, sct, fam, nick, cv }], count } (on the
// L9 step: every live snake sorted by sct then fam, both down, ties by id) }.
// ctx = { tick, simMs, flux, frames, dead (the seat's own snake is gone) }.
// Events carry an `id` for every snake record; the room picks the own variant (slRecordCache) when the id is the
// seat's own. A minimap event may carry `full` (its M form) for the queue's coalescing. An item may instead be an
// entry { ev, rec } whose rec is that event's record bytes already made for this seat (the room then sends rec as is).
//
// Owen's answers built here: Q15 and 14:45 hold Q (slHold); 17:00 no boosting while holding, vanish on completion,
// others see the ring; Q10 (17:10) the snake glides straight about 3 s on a connection blip, then dies (C_DISCONNECT);
// Q14 kill lines and chat kept (C_KILLFEED, C_CHAT); Q2 the leaderboard counts bots (C_LB_BOTS).
//
// RESUME (task T16b, Owen Q10 "while reconnecting"; server/sl/slResume.js). Every seat gets a server-issued key at
// its join (sl:x {t: 'seat', k, ms}). A seat whose socket DROPS (reason 'disconnect', its queue not kicked, its snake
// alive or dead less than C_DEAD_SEAT_MS noPingMs ago) is PARKED, not ended: it leaves `seats`, keeps its view and
// its send queue (detached), and a live snake glides as an orphan exactly as before. Parked seats still run the seat
// part every wake (the view collects, the queue fills, nothing is sent), so no own record of the glide is lost.
// resume(socket, k, n, p) puts the seat on the new socket: the glide ends (no death), the queue replays what the lost
// bundles carried and resyncs, the view re-adds the world, the key rotates (sl:x {t: 'back', k, ms} leads that
// flush). A parked seat whose snake died stays parked C_DEAD_SEAT_MS noPingMs after the death so a late client still
// gets its own death; then it is dropped. A resume with the current key of a seat that is still on a live socket (the
// server has not seen the drop yet) takes it over and hands the old socket back to slSockets ('taken'). A leave, a
// kick or a refusal is never parked.

const { performance } = require('perf_hooks');
const W = require('../../shared/slWire.js');
const slCore = require('../../shared/slCore.js');
const { assertShippable, assertLawsComplete, assertRulesBuilt, STATUS } = require('./slLaws');
const { createSim } = require('./slSim');
const slSnake = require('./slSnake');
const slQuant = require('./slQuant');
const { preyNotShippable } = require('./slPrey');
const { createRecordCache, encodeRecord } = require('./slRecordCache');
const { createSendQueue, QUEUE_TABLE_IDS } = require('./slSendQueue');
const { createHoldBook, HOLD_LAW_IDS } = require('./slHold');
const { createSafeStats, safeCall, safeImmediate, safeTimeout, REAL_TIMERS } = require('./slSafe');
const { resumeLaws, makeKey, createWindow, WHY_GONE } = require('./slResume');
const { TickTimer } = require('../tickTimer');

const PI2 = 2 * Math.PI;

const ROOM_OWN_IDS = Object.freeze([
  'L3', 'L6', 'L7', 'L8.sweep', 'L9', 'L10', 'L11.slow', 'L11.fast', 'L17.famRound', 'L47', 'L48.angRound',
  'C_HOLD_MS', 'C_CASHOUT_CODE', 'C_DISCONNECT', 'C_LB_BOTS', 'C_KILLFEED', 'C_ROOM_CAP', 'C_HUMAN_CAP', 'C_PHASES',
  'C_MAX_STEPS', 'C_ECHO_NOW', 'C_INPUT_OFFSET', 'C_FLUSH_SLICE_MS', 'C_ID_QUARANTINE_MS', 'C_IDLE_PAUSE_MS',
  'C_DEAD_SEAT_MS', 'C_CHAT',
]);
const ROOM_TABLE_IDS = Object.freeze(Array.from(new Set(ROOM_OWN_IDS.concat(HOLD_LAW_IDS, QUEUE_TABLE_IDS))));
const ROOM_RULES_BUILT = Object.freeze(['pongPerPing', 'glideThenDie', 'humanInvolved']);
const ROOM_RULE_IDS = Object.freeze(['L47', 'C_DISCONNECT', 'C_KILLFEED']);

// Our own row the room needs that the law table does not hold (the slSim WORLD_ROWS precedent). The table wins
// when it has the id. T1 follow-up: copy it into slLaws.js and SERVER-LAWS N.
const ROOM_ROWS = Object.freeze({
  C_EMERGENCY_FAIL_WAKES: Object.freeze({
    id: 'C_EMERGENCY_FAIL_WAKES',
    name: 'This many wakes in a row that throw close the room (slArenas opens a fresh one)',
    status: STATUS.CHOSEN,
    value: 3,
    unit: 'wakes',
    source: "CHOSEN: SERVER-DESIGN 17 (agar's EMERGENCY_FAIL_TICKS, server/ag/agRoom.js:60-61, Paper's value); task T9",
  }),
});
const ROOM_ROW_IDS = Object.freeze(Object.keys(ROOM_ROWS));
const ROOM_LAW_IDS = Object.freeze(ROOM_TABLE_IDS.concat(ROOM_ROW_IDS));

const VARIANT = Object.freeze({ snake_rot: true, snake_move: true });

function bad(id, what) {
  throw new Error('slRoom: law ' + id + ' ' + what);
}

function num(v, id, what) {
  if (typeof v !== 'number' || !Number.isFinite(v)) bad(id, what + ' is not a finite number');
  return v;
}

function posNum(v, id, what) {
  if (num(v, id, what) <= 0) bad(id, what + ' must be above 0');
  return v;
}

function roomTable(laws) {
  assertLawsComplete(laws, ROOM_TABLE_IDS);
  const t = {};
  for (const id of ROOM_TABLE_IDS) t[id] = laws[id];
  for (const id of ROOM_ROW_IDS) t[id] = Object.prototype.hasOwnProperty.call(laws, id) ? laws[id] : ROOM_ROWS[id];
  return t;
}

// Every value the room reads itself, once (the sim, view, queue and hold check their own).
function roomLaws(laws) {
  const t = roomTable(laws);
  assertRulesBuilt(t, ROOM_RULE_IDS, ROOM_RULES_BUILT);
  const v = (id) => t[id].value;
  const L9 = v('L9');
  const L10 = v('L10');
  if (!L9 || typeof L9 !== 'object') bad('L9', 'is not {periodMs, rows, order}');
  if (L9.order !== 'sctFamDesc') bad('L9', 'order ' + JSON.stringify(L9.order) + ' is not built (built: sctFamDesc)');
  if (!L10 || typeof L10 !== 'object') bad('L10', 'is not the minimap row');
  const disc = v('C_DISCONNECT');
  if (disc.rule !== 'glideThenDie') bad('C_DISCONNECT', 'is not glideThenDie');
  for (const k of Object.keys(disc)) if (k !== 'rule' && k !== 'glideMs') bad('C_DISCONNECT', 'parameter ' + k + ' is not built');
  const kf = v('C_KILLFEED');
  for (const k of Object.keys(kf)) if (k !== 'rule') bad('C_KILLFEED', 'parameter ' + k + ' is not built');
  const dead = v('C_DEAD_SEAT_MS');
  const chat = v('C_CHAT');
  if (!chat || typeof chat.strip !== 'string' || !Number.isInteger(chat.maxLen) || chat.maxLen <= 0) bad('C_CHAT', 'is not {maxLen, strip}');
  if (v('C_PHASES') !== 1) bad('C_PHASES', 'is ' + v('C_PHASES') + '; only 1 is built (every snake every tick)');
  if (v('C_ECHO_NOW') !== true) bad('C_ECHO_NOW', 'is not true (the only mode built)');
  if (v('C_INPUT_OFFSET') !== true) bad('C_INPUT_OFFSET', 'is not true (the only mode built)');
  if (typeof v('C_LB_BOTS') !== 'boolean') bad('C_LB_BOTS', 'is not a boolean');
  const maxSteps = v('C_MAX_STEPS');
  if (!Number.isInteger(maxSteps) || maxSteps < 1) bad('C_MAX_STEPS', 'must be a whole number >= 1');
  const fails = v('C_EMERGENCY_FAIL_WAKES');
  if (!Number.isInteger(fails) || fails < 1) bad('C_EMERGENCY_FAIL_WAKES', 'must be a whole number >= 1');
  const angRound = v('L48.angRound');
  if (angRound !== 'floor' && angRound !== 'round') bad('L48.angRound', 'is neither floor nor round');
  const famRound = v('L17.famRound');
  return Object.freeze({
    P: posNum(v('L7'), 'L7', 'update period'),
    pv: v('L6').protocol,
    mscps: v('L3'),
    lbMs: posNum(L9.periodMs, 'L9', 'periodMs'),
    lbRows: L9.rows,
    mmMs: posNum(L10.periodMs, 'L10', 'periodMs'),
    zSlowMs: zSlowPeriod(posNum(v('L11.slow'), 'L11.slow', 'period'), posNum(L9.periodMs, 'L9', 'periodMs')),
    zFastMs: posNum(v('L11.fast'), 'L11.fast', 'period'),
    sweepMs: posNum(v('L8.sweep'), 'L8.sweep', 'period'),
    holdMs: posNum(v('C_HOLD_MS'), 'C_HOLD_MS', 'hold time'),
    cashCode: v('C_CASHOUT_CODE'),
    glideMs: posNum(disc.glideMs, 'C_DISCONNECT', 'glideMs'),
    lbBots: v('C_LB_BOTS'),
    roomCap: v('C_ROOM_CAP'),
    humanCap: v('C_HUMAN_CAP'),
    maxSteps,
    sliceMs: posNum(v('C_FLUSH_SLICE_MS'), 'C_FLUSH_SLICE_MS', 'slice'),
    quarantineMs: num(v('C_ID_QUARANTINE_MS'), 'C_ID_QUARANTINE_MS', 'quarantine'),
    idleMs: posNum(v('C_IDLE_PAUSE_MS'), 'C_IDLE_PAUSE_MS', 'idle pause'),
    deadNoPingMs: posNum(dead.noPingMs, 'C_DEAD_SEAT_MS', 'noPingMs'),
    deadCapMs: posNum(dead.capMs, 'C_DEAD_SEAT_MS', 'capMs'),
    chatMax: chat.maxLen,
    chatStrip: chat.strip,
    emergencyFails: fails,
    angRound,
    famRound,
    resume: resumeLaws(laws),
  });
}

// L11.slow: the slow border checks run on the half slots of the L9 leaderboard timer (RULE, SERVER-LAWS L11: 723 of
// 723), so the clock is half the L9 period from the same start and the two never drift apart (task T14: a clock of its
// own at 1504.31 ms drifted 0.11 ms per slot off the leaderboard grid, and 279 of 570 slow z of a 15 minute local run
// left their slot). The measured period must agree with that (CHOSEN check bound 0.5 ms).
function zSlowPeriod(slowMs, lbMs) {
  if (Math.abs(slowMs - lbMs / 2) > 0.5) bad('L11.slow', 'is not half the L9 leaderboard period');
  return lbMs / 2;
}

// A clock on sim time: it fires on the first step at or after its due time, then due += period (SERVER-DESIGN 5.1),
// so its mean period is exact and the sim stays deterministic. Steps never jump more than one period here (every
// period is above L7), but a gap is still handled: each missed due time is counted, never paid back.
function makeClock(periodMs, startMs) {
  return { period: periodMs, due: startMs + periodMs, fires: 0, missed: 0, lastFire: NaN };
}

function fireClock(c, simMs) {
  if (simMs < c.due) return false;
  c.lastFire = simMs;
  c.fires++;
  c.due += c.period;
  while (simMs >= c.due) {
    c.due += c.period;
    c.missed++;
  }
  return true;
}

function cleanChat(text, R) {
  let s = typeof text === 'string' ? text : '';
  for (const ch of R.chatStrip) s = s.split(ch).join('');
  s = s.trim();
  if (s.length > R.chatMax) s = s.slice(0, R.chatMax);
  return s;
}

class SlRoom {
  // laws: the law table. opts:
  //   seed          the room seed (default: from the wall clock; tests pass one)
  //   view          the seat view factory (the contract above); default require('./slView')
  //   bots          optional bot driver { beforeInputs(room, tickSimMs), afterStep(room, log, simMs), add(room),
  //                 clear(room), count(), isBot(id) } (slBots; task T12)
  //   region        'na' (lobbyType sl_<region>_s0)
  //   clock         monotonic ms (default performance.now); now: wall ms (default Date.now)
  //   timers        { setTimeout, clearTimeout, setImmediate, clearImmediate } (default the real ones)
  //   autoTick      false: nothing ticks by itself (tests call wake() or tickOnce())
  //   shippableOnly false: tests and the dev boot run a FIXTURE table (assertLawsComplete still holds)
  //   prey          true or false (default: on only when every prey row is shippable, BUILD-DECISIONS T5)
  //   paidBusy      () -> true while a paid seat is occupied (ops.drainStatus): catch-up sim steps then yield
  //   log           { log, warn, error }
  constructor(laws, opts) {
    const o = opts || {};
    if (o.shippableOnly !== false) assertShippable(laws);
    this.laws = laws;
    const R = roomLaws(laws);
    this.R = R;
    this.P = R.P;
    this.log = o.log || console;
    this.timers = o.timers || REAL_TIMERS;
    this.clock = typeof o.clock === 'function' ? o.clock : (() => performance.now());
    this.now = typeof o.now === 'function' ? o.now : Date.now;
    this.region = typeof o.region === 'string' && o.region ? o.region : 'na';
    this.lobbyType = 'sl_' + this.region + '_s0';
    this.autoTick = o.autoTick !== false;
    this.paidBusy = typeof o.paidBusy === 'function' ? o.paidBusy : null;
    this.safeStats = createSafeStats();
    this.safeOpts = { timers: this.timers, log: this.log };

    const viewFactory = o.view || require('./slView');
    if (!viewFactory || typeof viewFactory.createSeatView !== 'function' || typeof viewFactory.createWorld !== 'function') {
      throw new TypeError('slRoom: the view factory needs createWorld and createSeatView (the contract in slRoom.js)');
    }
    this.viewFactory = viewFactory;
    this.bots = o.bots || null;

    const seed = typeof o.seed === 'number' && Number.isFinite(o.seed) ? o.seed : (this.now() % 2147483647);
    const prey = o.prey !== undefined ? o.prey === true : preyNotShippable(laws).length === 0;
    this.freedAt = new Map(); // snake id -> sim ms it left the sim (C_ID_QUARANTINE_MS)
    this.sim = createSim(laws, { seed, world: true, prey, idBlocked: (id) => this._idBlocked(id) });
    this.K = slSnake.snakeLaws(laws);
    this.world = viewFactory.createWorld(laws, this.sim);
    this.holds = createHoldBook(laws);
    this.scoreTables = slCore.buildScoreTables(R.mscps);

    const t0 = this.sim.nowMs();
    this.clocks = {
      lb: makeClock(R.lbMs, t0),
      mm: makeClock(R.mmMs, t0),
      zSlow: makeClock(R.zSlowMs, t0),
      zFast: makeClock(R.zFastMs, t0),
      sweep: makeClock(R.sweepMs, t0),
    };

    this.seats = new Map(); // socket id -> seat
    this.bySnake = new Map(); // own snake id -> seat
    this.humans = new Set(); // snake ids of human snakes (seated or gliding)
    this.names = new Map(); // snake id -> nick (kill lines)
    this.orphans = new Map(); // snake id -> { locked, endSim } (C_DISCONNECT glide)
    this.parked = new Set(); // seats whose socket dropped, waiting for a resume (task T16b)
    this.keys = new Map(); // resume key -> seat (seated or parked)
    this.top = null; // the biggest cash-out box message (slTopCashout), sent to every seat at join

    this.cache = createRecordCache(R.pv);
    this.qstats = {};
    this.stats = {
      wakes: 0, steps: 0, droppedSteps: 0, droppedMs: 0, simMs: 0, viewMs: 0, flushMs: 0, maxSliceMs: 0, slices: 0,
      seats: 0, joins: 0, leaves: 0, glides: 0, glideDeaths: 0, cashouts: 0, deaths: 0, resyncs: 0, kicks: 0,
      echoes: 0, pongs: 0, inputs: 0, inputDrops: 0, holdsStarted: 0, holdsEnded: 0, killLines: 0, chats: 0,
      failedWakes: 0, pauses: 0, resumes: 0, diag: { applyThrows: 0, wireErrors: 0, reports: 0 },
      parks: 0, backs: 0, backsDead: 0, takeovers: 0, parkedDropped: 0, backsRefused: { gone: 0, flood: 0 },
    };

    // scheduler (agar's drift-free one, server/ag/agRoom.js:932-1000)
    this.timing = new TickTimer({ periodMs: this.P, maxSteps: R.maxSteps, clock: this.clock, now: this.now });
    this.timer = null;
    this.acc = 0;
    this.last = 0;
    this.ticking = false;
    this.paused = false;
    this.stopped = false;
    this.closed = false;
    this.onClosed = null;
    this.failRun = 0;
    this._dueAt = NaN;
    this._job = null;
    this._jobHandle = null;
    this.lastHumanAt = this.clock();
    this._onTimer = () => this._timerWake();
    this._scratch = { ang: 0, wang: 0, dir: 1, turning: false };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // The owner console contract (server/index.js:1202-1263; SERVER-DESIGN 3.1, 12.1). A free room: no stake, no worth.

  botsAllowed() {
    return true;
  }

  get playerCount() {
    return this.seats.size;
  }

  get botCount() {
    return this.bots && typeof this.bots.count === 'function' ? this.bots.count() : 0;
  }

  // What ops.drainStatus reads: every human seat and every bot, never worth.
  get snakes() {
    const m = new Map();
    for (const seat of this.seats.values()) {
      m.set('sl' + seat.snakeId, { alive: !!this.sim.snake(seat.snakeId), isBot: false, worth: 0 });
    }
    this.sim.forEachSnake((s) => {
      if (this.humans.has(s.id)) return;
      m.set('sl' + s.id, { alive: true, isBot: true, worth: 0 });
    });
    return m;
  }

  liveStakeTotal() {
    return 0;
  }

  get floorWorth() {
    return undefined;
  }

  // One bot by hand. Refused above C_ROOM_CAP, and without a bot driver (slBots, task T12).
  addBot() {
    if (this.stopped || !this.bots || typeof this.bots.add !== 'function') return null;
    if (this.sim.count() >= this.R.roomCap) return null;
    return this.bots.add(this) || null;
  }

  clearBots() {
    if (!this.bots || typeof this.bots.clear !== 'function') return 0;
    return this.bots.clear(this) || 0;
  }

  // A snake for a seat or a bot (the bot driver spawns through this, so names are known for kill lines).
  spawnSnake(spec) {
    const s = this.sim.spawn({ cv: spec.cv, nick: spec.nick === undefined ? '' : String(spec.nick) });
    this.names.set(s.id, s.nick);
    if (!spec.isBot) this.humans.add(s.id);
    return s;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Seats (SERVER-DESIGN 12.4: one socket per life, a seat at sl:join)

  // null when a seat can be given, else the refusal reason.
  // A gliding orphan is a live human snake, so it counts toward both caps until its glide ends (fixer pass,
  // 2026-10-10: join-then-close cycles from one address kept 773 live snakes against a cap of 20).
  refusal() {
    if (this.stopped || this.closed) return 'closed';
    const humans = this.seats.size + this.orphans.size;
    if (humans >= this.R.humanCap || humans >= this.R.roomCap) return 'full';
    return null;
  }

  // socket: the socket.io socket; info: { nick (cleaned), cv (checked) }. Returns the seat, or null when refused
  // (refusal() says why).
  seat(socket, info) {
    if (!socket || typeof socket.id !== 'string') throw new TypeError('slRoom: seat needs a socket with an id');
    if (this.seats.has(socket.id)) return this.seats.get(socket.id);
    if (this.refusal()) return null;
    const inf = info || {};
    const cv = Number.isInteger(inf.cv) && inf.cv >= 0 ? inf.cv : 0;
    const s = this.spawnSnake({ nick: inf.nick, cv, isBot: false });
    const seat = {
      id: socket.id,
      socket,
      snakeId: s.id,
      nick: s.nick,
      cv,
      dead: false,
      deadAt: NaN,
      cashed: false,
      closed: false,
      joinTick: this.sim.tick(),
      lastPingAt: NaN,
      lastHeard: this.clock(),
      flushHandle: null,
      pendingEcho: null,
      wakeDone: -1, // the job serial whose seat part ran for this seat
      diag: null,
      view: null,
      queue: null,
      key: makeKey(), // the resume key (slResume), rotated on every resume
      prevKey: null, // the key the last resume used, good until the new socket is heard (see resume)
      parked: false,
      heldAtPark: false,
      backs: createWindow(this.R.resume.perSeat.max, this.R.resume.perSeat.windowMs),
    };
    this.keys.set(seat.key, seat);
    seat.queue = createSendQueue(this.laws, {
      socket,
      ownId: s.id,
      clock: this.clock,
      stats: this.qstats,
      log: this.log,
      onKick: (reason) => this._onKick(seat, reason),
    });
    seat.view = this.viewFactory.createSeatView(this.laws, { sim: this.sim, world: this.world, ownId: s.id });
    this.seats.set(socket.id, seat);
    this.bySnake.set(s.id, seat);
    this.stats.joins++;
    this.stats.seats = this.seats.size;
    this.lastHumanAt = this.clock();
    const tick = this.sim.tick();
    const events = seat.view.join({ tick, simMs: this.sim.nowMs(), flux: this.sim.flux(), frames: [], dead: false });
    this._pushEvents(seat, tick, events);
    seat.queue.message(tick, this._keyMsg('seat', seat));
    if (this.top) seat.queue.message(tick, this.top);
    seat.queue.flush(this.clock());
    this._ensureTicking();
    return seat;
  }

  seatOf(socketOrId) {
    const id = typeof socketOrId === 'string' ? socketOrId : socketOrId && socketOrId.id;
    return id ? this.seats.get(id) || null : null;
  }

  // The socket went (disconnect, sl:leave, kick). A live snake glides straight for C_DISCONNECT glideMs, then dies
  // with its drops (Owen Q10, 17:10). Returns 'glide' when the seat's live snake now glides, true when a seat went
  // with no snake to glide, false when there was no seat. onEnd (optional): called once when that glide ends (death,
  // cash-out or the room stopping), so slSockets keeps the snake charged to its address until then.
  // A transport drop ('disconnect') of a seat whose queue was not kicked is PARKED (resume, see the header) when its
  // snake lives (the same glide, but the seat waits for its key) or died less than C_DEAD_SEAT_MS noPingMs ago (the
  // bundle with its own death may be among the lost ones: a client back in time still gets its own death and card).
  unseat(socketOrId, reason, onEnd) {
    const seat = this.seatOf(socketOrId);
    if (!seat) return false;
    const s = this.sim.snake(seat.snakeId);
    const recent = seat.dead && this.clock() - seat.deadAt <= this.R.deadNoPingMs;
    const park = reason === 'disconnect' && !seat.queue.closed && !!seat.key && ((!!s && !seat.dead) || recent);
    seat.closed = !park;
    this.seats.delete(seat.id);
    if (seat.flushHandle) seat.flushHandle.stop();
    seat.flushHandle = null;
    seat.pendingEcho = null;
    if (park) {
      seat.parked = true;
      seat.socket = null;
      seat.queue.detach();
      this.parked.add(seat);
      this.stats.parks++;
    } else {
      this.bySnake.delete(seat.snakeId);
      this._dropKey(seat);
      seat.queue.close();
      if (typeof seat.view.leave === 'function') safeCall(() => seat.view.leave(), 'sl.view.leave', this.safeStats, this.safeOpts);
    }
    this.stats.leaves++;
    this.stats.seats = this.seats.size;
    if (s) {
      this._glide(seat, reason, onEnd);
      if (this.seats.size === 0) this.lastHumanAt = this.clock();
      return 'glide';
    }
    this.humans.delete(seat.snakeId);
    if (this.seats.size === 0) this.lastHumanAt = this.clock();
    return true;
  }

  // C_DISCONNECT: the seat's live snake glides straight glideMs, then dies (step 2 locks it, step 8 kills it).
  _glide(seat, reason, onEnd) {
    seat.heldAtPark = this.holds.holding(seat.snakeId);
    this.holds.release(seat.snakeId, 'disconnect');
    // no input can come any more: the boost ends at the next step, steering locks at step 2
    this.sim.setInput(seat.snakeId, { type: 'boost', on: false }, 0);
    this.orphans.set(seat.snakeId, { locked: false, endSim: NaN, why: typeof reason === 'string' ? reason : 'leave',
      onEnd: typeof onEnd === 'function' ? onEnd : null });
    this.stats.glides++;
  }

  _dropKey(seat) {
    if (seat.key && this.keys.get(seat.key) === seat) this.keys.delete(seat.key);
    seat.key = null;
    this._dropPrevKey(seat);
  }

  _dropPrevKey(seat) {
    if (seat.prevKey && this.keys.get(seat.prevKey) === seat) this.keys.delete(seat.prevKey);
    seat.prevKey = null;
  }

  // The sl:x message that hands the seat its key: 'seat' at the join, 'back' at a resume. ms is how long after a drop
  // the key can still bring the life back (the glide, then the dead seat's no-ping limit): the layer stops trying then.
  _keyMsg(t, seat) {
    return { t, k: seat.key, ms: this.R.glideMs + this.R.deadNoPingMs };
  }

  // A parked seat's wait is over (its snake died noPingMs ago, or the room stopped): the seat goes for good.
  _dropParked(seat) {
    if (!this.parked.delete(seat)) return;
    seat.parked = false;
    seat.closed = true;
    if (this.bySnake.get(seat.snakeId) === seat) this.bySnake.delete(seat.snakeId);
    this._dropKey(seat);
    seat.queue.close();
    if (typeof seat.view.leave === 'function') safeCall(() => seat.view.leave(), 'sl.view.leave', this.safeStats, this.safeOpts);
    this.stats.parkedDropped++;
  }

  // sl:back (slSockets checked the shapes): socket asks for the seat of key, having got n bundles and sent p pings
  // this life. Returns { seat, replaced } (replaced: the old socket when the seat was still on one, for slSockets to
  // refuse 'taken'), or the refusal why: 'gone' (no seat holds that key, or n cannot continue its stream) or 'flood'
  // (C_RESUME perSeat). Nothing the client sent is believed beyond choosing what to send again.
  // The key: the seat's current one; or, while the seat is PARKED, the one its last resume used if the new socket was
  // never heard from (prevKey): the 'back' that carried the new key leads one flush, and a socket that died before
  // delivering it (the layer drops an attempt it has waited RESUME_TRY_MS on) would otherwise end the life with the
  // client still holding the key the server had just replaced. The first upstream message on the new socket proves
  // the client read 'back' (the layer sends nothing there before it), and the old key goes (_heard). A seat on a live
  // socket takes only its current key, so two sockets presenting one key get one seat between them and the other is
  // refused 'gone'.
  resume(socket, key, n, p) {
    if (!socket || typeof socket.id !== 'string') throw new TypeError('slRoom: resume needs a socket with an id');
    if (this.stopped || this.closed) return this._backRefused(WHY_GONE);
    const seat = typeof key === 'string' ? this.keys.get(key) : undefined;
    if (!seat || seat.closed || (seat.key !== key && !(seat.parked && seat.prevKey === key)) || seat.socket === socket ||
      this.seats.has(socket.id)) {
      return this._backRefused(WHY_GONE);
    }
    const now = this.clock();
    if (seat.backs.full(now)) return this._backRefused('flood');
    if (this._job) this._finishJob(); // a sliced wake still running: its seat part first, as a new wake does
    if (seat.closed || !seat.queue.canResume(n)) return this._backRefused(WHY_GONE);
    let replaced = null;
    if (seat.parked) {
      this.parked.delete(seat);
      seat.parked = false;
      this._endOrphan(seat.snakeId); // the glide ends with no death; its owner releases the old socket's charge
    } else {
      // still on a socket: a drop the server has not seen yet, or a second tab with the key. The new socket wins.
      replaced = seat.socket;
      this.seats.delete(seat.id);
      if (seat.flushHandle) seat.flushHandle.stop();
      seat.flushHandle = null;
      seat.pendingEcho = null;
      if (this.sim.snake(seat.snakeId)) {
        if (this.holds.holding(seat.snakeId)) seat.heldAtPark = true;
        this.holds.release(seat.snakeId, 'disconnect');
      }
      seat.queue.detach();
      this.stats.takeovers++;
    }
    seat.backs.add(now);
    seat.id = socket.id;
    seat.socket = socket;
    seat.lastHeard = now;
    seat.queue.attach(socket);
    this.seats.set(socket.id, seat);
    this.bySnake.set(seat.snakeId, seat);
    this._dropKey(seat);
    seat.key = makeKey();
    seat.prevKey = key;
    this.keys.set(seat.key, seat);
    this.keys.set(key, seat);
    const tick = this.sim.tick();
    const first = [this._keyMsg('back', seat)];
    if (seat.heldAtPark) first.push({ t: 'hold', id: seat.snakeId, on: 0 }); // the own ring the drop ended
    seat.heldAtPark = false;
    if (this.top) first.push(this.top);
    seat.queue.resume(n, Number.isInteger(p) ? p : 0, tick, now, first);
    this.stats.resyncs++;
    seat.view.resync();
    const again = seat.view.collect({ tick, simMs: this.sim.nowMs(), flux: this.sim.flux(), frames: [], dead: seat.dead });
    this._pushEvents(seat, tick, again);
    this.stats.backs++;
    if (seat.dead) this.stats.backsDead++;
    this.stats.seats = this.seats.size;
    this.lastHumanAt = now;
    this._ensureTicking();
    seat.queue.flush(now);
    return { seat, replaced };
  }

  _backRefused(why) {
    this.stats.backsRefused[why] = (this.stats.backsRefused[why] || 0) + 1;
    return why;
  }

  // An orphan's glide is over (its snake died, cashed out, or the room stopped): forget it and tell its owner once.
  _endOrphan(id) {
    const g = this.orphans.get(id);
    if (!g) return null;
    this.orphans.delete(id);
    if (g.onEnd) {
      const f = g.onEnd;
      g.onEnd = null;
      safeCall(f, 'sl.orphan.end', this.safeStats, this.safeOpts);
    }
    return g;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // On arrival (SERVER-DESIGN 5.2)

  // ms from now to the start of the step that will apply something arriving now (C_INPUT_OFFSET), 0 when idle or late.
  _offsetNow() {
    if (!this.ticking) return 0;
    const due = this.last + this.P - this.acc;
    const off = Math.round(due - this.clock());
    return off > 0 ? (off < this.P ? off : Math.round(this.P)) : 0;
  }

  // Sim time of something arriving now: the next step's sim time minus its offset.
  _arrivalSim(off) {
    return this.sim.nowMs() + this.P - off;
  }

  _heard(seat) {
    if (seat.prevKey) this._dropPrevKey(seat); // the client read 'back' and holds the new key (resume)
    seat.lastHeard = this.clock();
    seat.queue.heard(seat.lastHeard); // ackLate reads a missing ping as a late downstream only while upstream flows
    if (!seat.dead) this.holds.heard(seat.snakeId, this._arrivalSim(this._offsetNow()));
  }

  // sl:i: bytes of one input bundle (shared/slWire.js encodeInput); slSockets checked its size.
  onInput(socketOrSeat, bytes) {
    const seat = socketOrSeat && socketOrSeat.queue ? socketOrSeat : this.seatOf(socketOrSeat);
    if (!seat || seat.closed || seat.parked) return false;
    this._heard(seat);
    const recs = W.decodeInput(bytes);
    const now = this.clock();
    const tick = this.sim.tick();
    const off = this._offsetNow();
    const s = seat.dead ? null : this.sim.snake(seat.snakeId);
    let steer = false;
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      if (r.type === 'wire_error') break;
      this.stats.inputs++;
      if (r.type === 'ping') {
        seat.queue.pong(tick, now); // L47: one pong per ping, on arrival
        seat.lastPingAt = now;
        this.stats.pongs++;
        continue;
      }
      if (!s) {
        this.stats.inputDrops++;
        continue;
      }
      this.sim.setInput(seat.snakeId, r, off);
      if (r.type === 'angle' || r.type === 'turn') steer = true;
    }
    if (steer && s && s.holdMult === null) this._echo(seat, s);
    this._scheduleFlush(seat);
    return true;
  }

  // The own wanted-angle echo (SERVER-DESIGN 5.2 step 3): the wang and dir the next step's applyInputs will give, from
  // the snake's merged slot, computed with slSnake's own setWang on a scratch copy.
  _echo(seat, s) {
    const x = this._scratch;
    x.ang = s.ang;
    x.wang = s.wang;
    x.dir = s.dir;
    x.turning = s.turning;
    let raw = -1;
    if (s.inAngle >= 0) {
      const w = slQuant.wangFromInput(s.inAngle);
      slSnake.setWang(x, w.v);
      raw = w.raw;
    }
    if (s.inTurn !== 0) {
      const amount = slSnake.arrowTurn(this.K, s.pts.length, s.sp, s.inTurn < 0 ? -s.inTurn : s.inTurn);
      slSnake.setWang(x, slSnake.wrapAngle(s.inTurn < 0 ? x.wang - amount : x.wang + amount));
      raw = slQuant.rotAng(x.wang, this.R.angRound).raw;
    }
    if (raw < 0) return;
    // L48.rot: the echo carries the snake's ang byte too (L48.angRound), as every own rotation record of their server
    // does: S1+S2 own records are dir+ang+wang (6404), dir+ang+wang+sp (1612), ang, sp or ang+sp, never dir+wang
    // without ang; a dir+wang echo broke "ang whenever the snake is turning" on 16875 own records (task T14)
    const ev = { type: 'snake_rot', id: s.id, dir: x.dir === 2 ? 2 : 1, ang: slQuant.rotAng(s.ang, this.R.angRound).v,
      wang: raw * PI2 / 256 };
    const bytes = encodeRecord(ev, true, this.R.pv);
    const echo = { tick: this.sim.tick(), bytes, dir: ev.dir, wangRaw: raw };
    if (this._seatPending(seat)) {
      seat.pendingEcho = echo; // after this wake's records, so it never goes ahead of them
      return;
    }
    this._queueEcho(seat, echo);
  }

  _queueEcho(seat, echo) {
    seat.queue.echo(echo.tick, echo.bytes);
    this.stats.echoes++;
    if (typeof seat.view.noteOwnRot === 'function') seat.view.noteOwnRot({ dir: echo.dir, wangRaw: echo.wangRaw });
  }

  // true while a wake has run sim steps whose records this seat has not been given yet
  _seatPending(seat) {
    const j = this._job;
    return !!j && j.ran > 0 && seat.wakeDone !== j.serial;
  }

  // sl:hold {on}: a press starts a hold at the next step, a release ends it (SERVER-DESIGN 15.3).
  onHold(socketOrSeat, on) {
    const seat = socketOrSeat && socketOrSeat.queue ? socketOrSeat : this.seatOf(socketOrSeat);
    if (!seat || seat.closed || seat.parked) return false;
    this._heard(seat);
    if (seat.dead || !this.sim.snake(seat.snakeId)) return false;
    if (on) return this.holds.press(seat.snakeId, this._arrivalSim(this._offsetNow()));
    return this.holds.release(seat.snakeId, 'release');
  }

  // sl:vis {hidden}: the ackLate exemption, and a hidden tab ends a hold.
  onVis(socketOrSeat, hidden) {
    const seat = socketOrSeat && socketOrSeat.queue ? socketOrSeat : this.seatOf(socketOrSeat);
    if (!seat || seat.closed || seat.parked) return false;
    this._heard(seat);
    seat.queue.setHidden(!!hidden);
    if (hidden && !seat.dead) this.holds.release(seat.snakeId, 'hidden');
    return true;
  }

  // sl:chat {text}: one line to every seat (C_CHAT; the rate is slSockets').
  onChat(socketOrSeat, text) {
    const seat = socketOrSeat && socketOrSeat.queue ? socketOrSeat : this.seatOf(socketOrSeat);
    if (!seat || seat.closed || seat.parked) return false;
    this._heard(seat);
    const t = cleanChat(text, this.R);
    if (!t) return false;
    this.stats.chats++;
    this._messageAll({ t: 'chat', name: seat.nick, text: t });
    return true;
  }

  // sl:diag: the layer's counters (slSockets checked the shape).
  onDiag(socketOrSeat, d) {
    const seat = socketOrSeat && socketOrSeat.queue ? socketOrSeat : this.seatOf(socketOrSeat);
    if (!seat || seat.closed || seat.parked || !d || typeof d !== 'object') return false;
    this._heard(seat);
    seat.diag = d;
    this.stats.diag.reports++;
    if (Number.isFinite(d.applyThrows) && d.applyThrows > 0) this.stats.diag.applyThrows += d.applyThrows;
    if (Number.isFinite(d.wireErrors) && d.wireErrors > 0) this.stats.diag.wireErrors += d.wireErrors;
    if (Number.isFinite(d.pongP95)) seat.queue.reportRtt(d.pongP95);
    return true;
  }

  // The biggest cash-out box (slTopCashout pushes it): kept for new seats and sent to every seat now.
  setTop(msg) {
    this.top = msg && typeof msg === 'object' ? msg : null;
    if (this.top) this._messageAll(this.top);
  }

  _messageAll(msg) {
    const tick = this.sim.tick();
    for (const seat of this.seats.values()) {
      seat.queue.message(tick, msg);
      this._scheduleFlush(seat);
    }
  }

  _scheduleFlush(seat) {
    if (seat.flushHandle || seat.closed) return;
    seat.flushHandle = safeImmediate(() => {
      seat.flushHandle = null;
      if (seat.closed || this._seatPending(seat)) return; // the wake's seat part flushes it
      seat.queue.flush(this.clock());
    }, 'sl.flush.arrival', this.safeStats, this.safeOpts);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // The clock (agar's drift-free scheduler) and the idle pause (C_IDLE_PAUSE_MS)

  // The room clock runs from the first seat (or from start()); the timer is armed only with autoTick.
  _ensureTicking() {
    if (this.stopped) return;
    if (this.paused) {
      this.paused = false;
      this.stats.resumes++;
    }
    if (!this.ticking) {
      this.ticking = true;
      this.last = this.clock();
      this.acc = 0;
    }
    if (!this.autoTick || this.timer || this._job) return;
    this._arm();
  }

  _arm() {
    const due = Math.max(0, this.P - this.acc - (this.clock() - this.last));
    this._dueAt = this.clock() + due;
    this.timer = this.timers.setTimeout(this._onTimer, Math.max(1, Math.ceil(due)));
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
  }

  // The timer's wake: a throw is caught and counted here (the process has no uncaughtException handler), and the
  // next timer is armed by the failed wake's own bookkeeping (_wakeFailed).
  _timerWake() {
    this.timer = null;
    if (this.stopped) return;
    safeCall(() => this.wake(), 'sl.wake', this.safeStats, this.safeOpts);
    if (!this.stopped && !this.closed && !this.timer && !this._job && !this.paused && this.autoTick) this._arm();
  }

  // Runs every due step (at most C_MAX_STEPS) and then the seat part once. Returns the steps run.
  wake() {
    if (this.stopped) return 0;
    if (this._job) this._finishJob(); // a sliced wake still running: finish it first
    const now = this.clock();
    if (!this.ticking) {
      this.ticking = true;
      this.last = now;
      this.acc = 0;
    }
    const firstDue = this.last + this.P - this.acc;
    this.acc += now - this.last;
    this.last = now;
    let steps = Math.floor(this.acc / this.P);
    let dropped = 0;
    if (steps > this.R.maxSteps) {
      dropped = steps - this.R.maxSteps;
      steps = this.R.maxSteps;
      this.acc %= this.P;
    } else {
      this.acc -= steps * this.P;
    }
    this.timing.wakeBegin(now, this._dueAt);
    this._dueAt = NaN;
    if (dropped) {
      this.timing.dropped(dropped, dropped * this.P);
      this.stats.droppedSteps += dropped;
      this.stats.droppedMs += dropped * this.P;
    }
    this.stats.wakes++;
    this._startJob(steps, firstDue);
    return steps;
  }

  // One step and its seat part, now (tests and tools; no scheduler bookkeeping).
  tickOnce() {
    if (this.stopped) return 0;
    if (this._job) this._finishJob();
    this.timing.wakeBegin(this.clock(), NaN);
    this.stats.wakes++;
    this._startJob(1, NaN);
    if (this._job) this._finishJob();
    return 1;
  }

  _startJob(steps, firstDue) {
    this._jobSerial = (this._jobSerial || 0) + 1;
    this._job = {
      serial: this._jobSerial,
      steps,
      ran: 0,
      firstDue,
      frames: [],
      seatList: null,
      seatIdx: 0,
      last: null, // [due, start, end] of the last step (its timing row is written when the sends end)
    };
    this._runJob(false);
  }

  // Finishes a sliced job synchronously (a new wake, tickOnce, or stop).
  _finishJob() {
    if (this._jobHandle) {
      this._jobHandle.stop();
      this._jobHandle = null;
    }
    while (this._job) this._runJob(true);
  }

  _resumeJob() {
    this._jobHandle = null;
    if (this._job) this._runJob(false);
  }

  // Runs the job until it ends or a slice yields. sync: never yield.
  _runJob(sync) {
    const job = this._job;
    if (!job) return;
    let ok = false;
    try {
      const yielded = this._jobBody(job, sync);
      ok = true;
      if (yielded) return;
    } finally {
      if (!ok) this._wakeFailed(job);
    }
    this._endJob(job);
  }

  _jobBody(job, sync) {
    const sliceStart = this.clock();
    // sim part: the due steps back to back (catch-up steps yield between each other while a paid seat is occupied)
    while (job.ran < job.steps && !this.stopped) {
      const due = Number.isFinite(job.firstDue) ? job.firstDue + job.ran * this.P : NaN;
      const t0 = this.clock();
      this._simStep(job);
      const t1 = this.clock();
      this.stats.simMs += t1 - t0;
      if (job.last) this.timing.step(job.last[0], job.last[1], NaN, job.last[2]);
      job.last = [due, t0, t1];
      job.ran++;
      if (!sync && job.ran < job.steps && this.paidBusy && safeCall(this.paidBusy, 'sl.paidBusy', this.safeStats, this.safeOpts)) {
        this._yield(sliceStart);
        return true;
      }
    }
    // seat part: once per wake, sliced
    if (job.ran === 0) return false;
    if (!job.seatList) {
      job.seatList = Array.from(this.seats.values());
      for (const p of this.parked) job.seatList.push(p); // parked seats collect too (resume, see the header)
    }
    const list = job.seatList;
    while (job.seatIdx < list.length) {
      const seat = list[job.seatIdx++];
      if (seat.closed || seat.wakeDone === job.serial) continue;
      if (seat.parked) this._parkedPart(seat, job);
      else this._seatPart(seat, job);
      if (!sync && job.seatIdx < list.length && this.clock() - sliceStart >= this.R.sliceMs) {
        this._yield(sliceStart);
        return true;
      }
    }
    return false;
  }

  _yield(sliceStart) {
    const d = this.clock() - sliceStart;
    if (d > this.stats.maxSliceMs) this.stats.maxSliceMs = d;
    this.stats.slices++;
    this._jobHandle = safeImmediate(() => this._resumeJob(), 'sl.wake.slice', this.safeStats, this.safeOpts);
  }

  _endJob(job) {
    if (this._job !== job) return;
    this._job = null;
    const end = this.clock();
    if (job.last) this.timing.step(job.last[0], job.last[1], end, end);
    this.timing.wakeEnd(job.ran);
    this.cache.clear();
    this.failRun = 0;
    this._afterWake();
  }

  _wakeFailed(job) {
    this._job = null;
    if (this._jobHandle) {
      this._jobHandle.stop();
      this._jobHandle = null;
    }
    this.cache.clear();
    this.stats.failedWakes++;
    this.failRun++;
    if (this.failRun >= this.R.emergencyFails) {
      this.emergencyClose();
      return;
    }
    this._afterWake();
  }

  // After every wake: the idle pause, then the next timer.
  _afterWake() {
    if (this.stopped) return;
    const now = this.clock();
    if (this.seats.size > 0) this.lastHumanAt = now;
    if (!this.autoTick) return;
    if (this.seats.size === 0 && this.orphans.size === 0 && this.parked.size === 0 && now - this.lastHumanAt >= this.R.idleMs) {
      this._pause();
      return;
    }
    if (!this.timer) this._arm();
  }

  _pause() {
    if (this.timer) {
      this.timers.clearTimeout(this.timer);
      this.timer = null;
    }
    this._dueAt = NaN;
    this.ticking = false;
    this.paused = true;
    this.stats.pauses++;
    this.timing.idle();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // One sim step (SERVER-DESIGN 5.3 steps 0 to 8)

  _simStep(job) {
    const sim = this.sim;
    const R = this.R;
    const tickSim = sim.nowMs() + this.P; // the sim time of the step about to run
    const frame = { tick: sim.tick() + 1, simMs: tickSim, log: null, locks: [], cashed: [], clocks: null, board: null };

    // 0 bots, 1 inputs
    if (this.bots && typeof this.bots.beforeInputs === 'function') this.bots.beforeInputs(this, tickSim);
    sim.applyInputs();

    // 2 holds: ends, starts (each start's lock record goes to every holder through the view), ramp, safety
    const h = this.holds.step(sim, tickSim, (id) => this._rttOf(id));
    for (const e of h.ended) {
      this.stats.holdsEnded++;
      this._ringAll(frame.tick, e.id, 0);
    }
    for (const st of h.started) {
      this.stats.holdsStarted++;
      frame.locks.push(st.lock);
      this._ringAll(frame.tick, st.id, 1);
    }
    // glide locks (C_DISCONNECT): steering locked to the current ang byte, as the hold lock does
    for (const [id, g] of this.orphans) {
      if (g.locked) continue;
      const s = sim.snake(id);
      if (!s) continue;
      g.locked = true;
      g.endSim = tickSim + R.glideMs;
      slSnake.setWang(s, slQuant.rotAng(s.ang, R.angRound).v);
    }

    // 4-5 sim
    const log = sim.step();
    frame.log = log;
    const simMs = sim.nowMs();
    for (let i = 0; i < log.deaths.length; i++) this._onDeath(log.deaths[i], frame.tick, simMs);
    // names and the human mark go only after every death of the step (a killer may die in the same step)
    for (let i = 0; i < log.deaths.length; i++) {
      this.humans.delete(log.deaths[i].id);
      this.names.delete(log.deaths[i].id);
    }

    // 6 holds that completed (a death of this step already took its snake out: the death wins)
    const done = this.holds.complete(sim, simMs);
    for (let i = 0; i < done.length; i++) this._cashOut(done[i], frame, simMs);
    this._pruneFreed(simMs);

    // 7 clocks
    const c = this.clocks;
    frame.clocks = {
      lb: fireClock(c.lb, simMs),
      mm: fireClock(c.mm, simMs),
      zSlow: fireClock(c.zSlow, simMs),
      zFast: fireClock(c.zFast, simMs),
      sweep: fireClock(c.sweep, simMs),
    };
    if (frame.clocks.lb) frame.board = this._board();

    // 8 glides that ran out die at the start of the next step (sim.kill), the bot driver, the shared view step
    for (const [id, g] of this.orphans) {
      if (g.locked && simMs >= g.endSim && !g.killed) {
        g.killed = true;
        sim.kill(id);
      }
    }
    if (this.bots && typeof this.bots.afterStep === 'function') this.bots.afterStep(this, log, simMs);
    this.world.afterStep(frame);
    frame.log = null; // valid only during the step
    job.frames.push(frame);
    this.stats.steps++;
  }

  _rttOf(snakeId) {
    const seat = this.bySnake.get(snakeId);
    return seat ? seat.queue.rttP95() : 0;
  }

  // The ring messages (SERVER-DESIGN 15.3): to every seat holding the snake (C_HOLD_RING others), the own seat always.
  _ringAll(tick, id, on) {
    const msg = on ? { t: 'hold', id, on: 1, need: this.R.holdMs } : { t: 'hold', id, on: 0 };
    const others = this.holds.H.ringOthers;
    for (const seat of this.seats.values()) {
      if (seat.snakeId === id || (others && seat.queue.holdsSnake(id))) seat.queue.message(tick, msg);
    }
  }

  _onDeath(d, tick, simMs) {
    this.stats.deaths++;
    const id = d.id;
    if (this.holds.holding(id)) this._ringAll(tick, id, 0);
    this.holds.drop(id);
    this._freeId(id, simMs);
    const g = this._endOrphan(id);
    if (g && d.cause === 'kill') this.stats.glideDeaths++;
    const seat = this.bySnake.get(id);
    if (seat) {
      seat.dead = true;
      seat.deadAt = this.clock();
    }
    // C_KILLFEED humanInvolved: the killer exists and a human is the killer or the victim
    if (d.killer && (this.humans.has(id) || this.humans.has(d.killer))) {
      this.stats.killLines++;
      const msg = { t: 'kill', killer: this.names.get(d.killer) || '', victim: this.names.get(id) || '' };
      for (const st of this.seats.values()) st.queue.message(tick, msg);
      for (const st of this.parked) st.queue.message(tick, msg); // a parked seat back in time sees it (resume)
    }
  }

  // A completed hold (SERVER-DESIGN 15.3, Owen 17:00): the snake leaves at once with no food. The own seat gets
  // sl:x {t: 'cashed', len} with this step, so the flush sends it before the stream's own `dead`.
  _cashOut(id, frame, simMs) {
    const s = this.sim.snake(id);
    if (!s) return;
    const fam = slQuant.fam24(s.fam, this.R.famRound).v;
    const len = slCore.scoreOf(this.scoreTables.fmlts, this.scoreTables.fpsls, s.pts.length, fam);
    this.sim.remove(id);
    this.stats.cashouts++;
    this._freeId(id, simMs);
    frame.cashed.push({ id, code: this.R.cashCode });
    this._ringAll(frame.tick, id, 0);
    const seat = this.bySnake.get(id);
    if (seat) {
      seat.dead = true;
      seat.cashed = true;
      seat.deadAt = this.clock();
      seat.queue.message(frame.tick, { t: 'cashed', len }, true); // kept: a resume after lost bundles still says so
    }
    this._endOrphan(id);
    this.humans.delete(id);
    this.names.delete(id);
  }

  // L9: every live snake sorted by sct then fam, both down, ties by id (deterministic); count per C_LB_BOTS.
  _board() {
    const order = [];
    this.sim.forEachSnake((s) => {
      order.push({ id: s.id, sct: s.pts.length, fam: s.fam, nick: s.nick, cv: s.cv });
    });
    order.sort((a, b) => (b.sct - a.sct) || (b.fam - a.fam) || (a.id - b.id));
    let count = order.length;
    if (!this.R.lbBots) {
      count = 0;
      for (const r of order) if (this.humans.has(r.id)) count++;
    }
    return { order, count, rows: this.R.lbRows };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // The seat part (SERVER-DESIGN 5.3 steps 9 and 10)

  _seatPart(seat, job) {
    const t0 = this.clock();
    let frames = job.frames;
    if (frames.length && frames[0].tick <= seat.joinTick) frames = frames.filter((f) => f.tick > seat.joinTick);
    const tick = this.sim.tick();
    const ctx = { tick, simMs: this.sim.nowMs(), flux: this.sim.flux(), frames, dead: seat.dead };
    const events = seat.view.collect(ctx);
    this._pushEvents(seat, tick, events);
    seat.wakeDone = job.serial;
    if (seat.pendingEcho) {
      const e = seat.pendingEcho;
      seat.pendingEcho = null;
      this._queueEcho(seat, e);
    }
    const t1 = this.clock();
    this.stats.viewMs += t1 - t0;
    const cap = seat.queue.checkCap(tick, t1);
    if (cap === 'kick') return;
    if (cap === 'resync') {
      this.stats.resyncs++;
      seat.view.resync();
      const again = seat.view.collect({ tick, simMs: ctx.simMs, flux: ctx.flux, frames: [], dead: seat.dead });
      this._pushEvents(seat, tick, again);
    }
    if (seat.queue.checkStall(t1)) return;
    if (this._deadSeatDone(seat, t1)) return;
    seat.queue.flush(this.clock());
    this.stats.flushMs += this.clock() - t1;
  }

  // A parked seat's wake: its view collects and its queue fills exactly as a seated one (so the resume replays no
  // gap), over the cap it sheds like a resync, nothing is flushed; noPingMs after its snake died it is dropped.
  _parkedPart(seat, job) {
    let frames = job.frames;
    if (frames.length && frames[0].tick <= seat.joinTick) frames = frames.filter((f) => f.tick > seat.joinTick);
    const tick = this.sim.tick();
    const ctx = { tick, simMs: this.sim.nowMs(), flux: this.sim.flux(), frames, dead: seat.dead };
    this._pushEvents(seat, tick, seat.view.collect(ctx));
    seat.wakeDone = job.serial;
    const now = this.clock();
    if (seat.queue.checkCap(tick, now) === 'resync') {
      this.stats.resyncs++;
      seat.view.resync();
      this._pushEvents(seat, tick, seat.view.collect({ tick, simMs: ctx.simMs, flux: ctx.flux, frames: [], dead: seat.dead }));
    }
    if (seat.dead && now - seat.deadAt > this.R.deadNoPingMs) this._dropParked(seat);
  }

  _pushEvents(seat, tick, events) {
    if (!Array.isArray(events)) throw new TypeError('slRoom: a view must return an array of events');
    const own = seat.snakeId;
    for (let i = 0; i < events.length; i++) {
      const item = events[i];
      const entry = item && item.ev && item.rec instanceof Uint8Array;
      const ev = entry ? item.ev : item;
      let bytes;
      if (entry) {
        bytes = item.rec;
      } else {
        const isOwn = VARIANT[ev.type] ? ev.id === own : false;
        bytes = this.cache.recordBytes(ev, VARIANT[ev.type] ? isOwn : undefined);
      }
      let alt;
      if (ev.type === 'minimap' && ev.full) alt = this.cache.recordBytes(ev.full);
      seat.queue.push(tick, ev, bytes, alt);
      if (ev.type === 'snake_add' || ev.type === 'snake_remove') this._ringOnView(seat, tick, ev);
    }
  }

  // Others see the cash-out ring while it holds (Owen 17:00, C_HOLD_RING): a seat that picks up a holding snake after
  // its hold started gets the ring with the time already held (elapsed), and a seat whose view drops a holding snake
  // gets the ring's end, so a stale ring never shows when it comes back (fixer pass, 2026-10-10). The sl:x batch leaves
  // before the sl:f of the same flush, so the ring is known when the add lands.
  _ringOnView(seat, tick, ev) {
    if (ev.id === seat.snakeId || !this.holds.H.ringOthers || !this.holds.holding(ev.id)) return;
    if (ev.type === 'snake_add') {
      const held = Math.round(this.holds.heldMs(ev.id, this.sim.nowMs()));
      seat.queue.message(tick, { t: 'hold', id: ev.id, on: 1, need: this.R.holdMs,
        elapsed: held < 0 ? 0 : (held > this.R.holdMs ? this.R.holdMs : held) });
    } else {
      seat.queue.message(tick, { t: 'hold', id: ev.id, on: 0 });
    }
  }

  // C_DEAD_SEAT_MS: a dead seat with no ping for noPingMs (since its death) is closed; capMs is a hard cap.
  _deadSeatDone(seat, now) {
    if (!seat.dead) return false;
    const since = Number.isFinite(seat.lastPingAt) && seat.lastPingAt > seat.deadAt ? seat.lastPingAt : seat.deadAt;
    if (now - since > this.R.deadNoPingMs || now - seat.deadAt > this.R.deadCapMs) {
      seat.queue.flush(now);
      seat.queue.kick('dead');
      return true;
    }
    return false;
  }

  _onKick(seat, reason) {
    this.stats.kicks++;
    this.unseat(seat, 'kick:' + reason);
  }

  // freedAt in time order: a re-freed id moves to the end, so _pruneFreed can stop at the first young entry.
  _freeId(id, simMs) {
    this.freedAt.delete(id);
    this.freedAt.set(id, simMs);
  }

  // An entry at least C_ID_QUARANTINE_MS old blocks nothing (_idBlocked below deletes it on sight with the same test),
  // so every step drops those from the front. Without this an entry stayed until its id came round again (up to
  // 65535 entries, one per freed id; the 30 minute soak's heap bar, T8b). The bot driver appends with the current
  // sim time too (slBots takeOut), so the order holds; an entry out of order only waits, it is never dropped early.
  _pruneFreed(simMs) {
    const q = this.R.quarantineMs;
    for (const [id, at] of this.freedAt) {
      if (simMs - at < q) break;
      this.freedAt.delete(id);
    }
  }

  // C_ID_QUARANTINE_MS: an id is reused only after this long and when no seat's delivered or queued records hold it
  // (SERVER-DESIGN 8.1; their client keeps both objects on a duplicate id).
  _idBlocked(id) {
    const at = this.freedAt.get(id);
    if (at !== undefined) {
      if (this.sim && this.sim.nowMs() - at < this.R.quarantineMs) return true;
      this.freedAt.delete(id);
    }
    if (this.world && typeof this.world.idBlocked === 'function' && this.world.idBlocked(id)) return true;
    if (!this.seats) return false;
    for (const seat of this.seats.values()) if (seat.queue.holdsSnake(id)) return true;
    // a parked client still holds what it was sent (resume): its ids stay blocked until it is back or dropped
    if (this.parked) for (const seat of this.parked) if (seat.queue.holdsSnake(id)) return true;
    return false;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Life

  start() {
    this.autoTick = true;
    this._ensureTicking();
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this._jobHandle) {
      this._jobHandle.stop();
      this._jobHandle = null;
    }
    this._job = null;
    if (this.timer) {
      this.timers.clearTimeout(this.timer);
      this.timer = null;
    }
    this.ticking = false;
    this.timing.idle();
    for (const seat of this.seats.values()) if (seat.flushHandle) seat.flushHandle.stop();
    // a stopped room never ends its glides: release every orphan's address charge now
    for (const id of Array.from(this.orphans.keys())) this._endOrphan(id);
    // and nobody can come back to it: parked seats go, their keys with them
    for (const seat of Array.from(this.parked)) this._dropParked(seat);
  }

  // C_EMERGENCY_FAIL_WAKES wakes in a row threw: the room stops for good and hands its sockets to slArenas
  // (onClosed), which opens a fresh one. A free room owes nobody anything.
  emergencyClose() {
    if (this.closed) return;
    this.closed = true;
    const sockets = Array.from(this.seats.values()).map((s) => s.socket);
    this.log.error('[SL] EMERGENCY close', this.lobbyType, sockets.length + ' socket(s)');
    this.stop();
    if (typeof this.onClosed === 'function') safeCall(() => this.onClosed(this, sockets), 'sl.onClosed', this.safeStats, this.safeOpts);
  }

  report() {
    const q = this.qstats;
    return {
      lobbyType: this.lobbyType,
      seats: this.seats.size,
      snakes: this.sim.count(),
      orphans: this.orphans.size,
      parked: this.parked.size,
      holds: this.holds.size(),
      paused: this.paused,
      tick: this.sim.tick(),
      room: Object.assign({}, this.stats, { diag: Object.assign({}, this.stats.diag) }),
      queue: Object.assign({}, q, { safe: undefined }),
      hold: Object.assign({}, this.holds.stats),
      safe: { total: this.safeStats.total, byLabel: Object.assign({}, this.safeStats.byLabel) },
      clocks: { lb: this.clocks.lb.fires, mm: this.clocks.mm.fires, zSlow: this.clocks.zSlow.fires,
        zFast: this.clocks.zFast.fires, sweep: this.clocks.sweep.fires },
      timing: this.timing.report({ recent: 0 }),
    };
  }
}

module.exports = {
  SlRoom,
  ROOM_LAW_IDS,
  ROOM_TABLE_IDS,
  ROOM_ROWS,
  roomLaws,
  makeClock,
  fireClock,
  cleanChat,
};
