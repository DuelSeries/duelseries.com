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
//   opts.view.createWorld(laws, sim) -> world                    once per room (a paid room adds { eatThenRefill: true })
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
//
// PAID (slither-reference/paid/PAID-SL-DESIGN.md 1, 3.3, 5, 6, 7, 9; task T3). A paid room is this room built with
// opts.money, the money controller of server/slPaid/slMoney.js, which the server builds and hands in: no server/sl
// file requires anything under server/slPaid (critic C-2, test/slNoMoney.test.js), and this file holds no money of
// its own. Every paid line sits behind `if (this.money)` (or a paid-only method), so a room without opts.money is the
// free room to the byte (the goldens). With money:
//   - R.humanCap is min(C_HUMAN_CAP, C_PAID_HUMAN_CAP, opts.humanCap) and R.emergencyFails is 1; no bots; the sim drops
//     on a border death and pulls drops inside flux - C_PAID_DROP_INSET (paidDrops, from the law rows)
//   - seatPaid opens the account LAST (design 3.3): a seat holds an open account or leaves no trace of itself
//   - the sim step runs in a try whose finally applies the step's money facts (sim.lastLog() and the food pass's
//     eats; M1 to M3), the completed holds cash out money first (M4), then money.endStep (M5: collusion, orphans, the
//     checker); a step that throws closes the room at once with 100% refunds through the owed lane (emergencyClose)
//   - sl:x items: {t:'room'} and the own {t:'w'} at the seat and the resume, {t:'w'} once per wake to the own seat and
//     the seats holding a changed snake and with every add of a paid snake, kept {t:'lost'}, {t:'cashed'} with the
//     90/10 numbers, kept {t:'closed'} (design 9)
//   - stop() never settles money (it alerts on a bank that still holds some); halt() stops only the clock, for the
//     planned restart after the directory settled the money; the idle pause waits for every account to close

const { performance } = require('perf_hooks');
const W = require('../../shared/slWire.js');
const slCore = require('../../shared/slCore.js');
const { assertShippable, assertLawsComplete, assertRulesBuilt, STATUS } = require('./slLaws');
const { createSim } = require('./slSim');
const { createBorder } = require('./slBorder');
const slSnake = require('./slSnake');
const slQuant = require('./slQuant');
const { preyNotShippable } = require('./slPrey');
const { createRecordCache, encodeRecord } = require('./slRecordCache');
const { createSendQueue, QUEUE_TABLE_IDS } = require('./slSendQueue');
const { createChatGuard } = require('../chatGuard');
const { createHoldBook, HOLD_LAW_IDS } = require('./slHold');
const { createSafeStats, safeCall, safeImmediate, safeTimeout, REAL_TIMERS } = require('./slSafe');
const { resumeLaws, makeKey, createWindow, WHY_GONE } = require('./slResume');
const { TickTimer } = require('../tickTimer');
const { addressGroup } = require('../clientAddr');

// The early point (turning smoothness, 2026-10-16; slSnake travel, slSim previewPoint): between updates the room
// sends a seat its own snake's new point when the head reaches it, at the end of each of the update's pieces, as
// slither.io sends a point on its own (10,933 of 12,560 own points in Owen's recordings came with no rotation). On
// the update alone the point came 0 to 1 update late and their client, which puts its head on every new point, pulled
// the head 3.4 to 4.7 units back or forward each time. Owner console sl:smooth:off turns it off in every room until a
// restart (the update then sends every point, as before).
const SMOOTH = { on: true };
function setSmooth(on) {
  SMOOTH.on = on === true;
  return SMOOTH.on;
}

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

// A paid room (PAID-SL-DESIGN 1, 3.3, 4). What the room calls on opts.money (server/slPaid/slMoney.js), checked once.
const MONEY_METHODS = Object.freeze(['attach', 'open', 'abort', 'applyFacts', 'cashOut', 'endStep', 'emergencySettle',
  'openCount', 'worthOf', 'takeChanged', 'account', 'liveStakeTotal']);
// The paid law rows the room reads (C_PAID_CASH_BYTE is the checker's, slCheck).
const PAID_LAW_IDS = Object.freeze(['C_PAID_HUMAN_CAP', 'C_PAID_DROP_INSET', 'C_PAID_BORDER_DROPS', 'C_R_MIN']);
// {t:'room', stake, cut}: the house cut in percent, the 10 of the 90/10 split the controller pays (slMoney cashOut).
const PAID_CUT_PCT = 10;

// The paid room's overrides: R with the paid cap and one failing wake to close, the sim's paidDrops, the lobbyType.
// The cap never passes C_R_MIN snakes: the border target is clamped below at that count, so with no bots the radius
// stays put and a pellet placed inside stays inside (design 1; MONEY INVARIANT 6).
function paidRoom(laws, R, o) {
  const m = o.money;
  for (const k of MONEY_METHODS) {
    if (typeof m[k] !== 'function') throw new TypeError('slRoom: opts.money needs ' + k + ' (slPaid/slMoney.js)');
  }
  // the owner's paid bots only (opts.paidBots, Owen 2026-10-16/17): they play for the gold like people, and never cash out
  if (o.bots && o.paidBots !== true) throw new Error('slRoom: a paid room keeps no bots (BRIEF answer 4)');
  // the seed drives the spawn ring, the same-step order and the drops: a paid room never falls back to the wall
  // clock's (design 1, D2-m4), the directory draws it with crypto.randomInt
  if (!Number.isSafeInteger(o.seed) || o.seed < 1) {
    throw new Error('slRoom: a paid room needs its seed, a whole number >= 1 (crypto.randomInt)');
  }
  assertLawsComplete(laws, PAID_LAW_IDS);
  const cap = laws.C_PAID_HUMAN_CAP.value;
  if (!Number.isInteger(cap) || cap < 1) bad('C_PAID_HUMAN_CAP', 'must be a whole number >= 1');
  const rMin = laws.C_R_MIN.value;
  if (!rMin || !Number.isInteger(rMin.snakes) || cap > rMin.snakes) {
    bad('C_PAID_HUMAN_CAP', 'is above C_R_MIN snakes (the border would move)');
  }
  let humanCap = Math.min(R.humanCap, cap);
  if (o.humanCap !== undefined) {
    if (!Number.isInteger(o.humanCap) || o.humanCap < 1) throw new TypeError('slRoom: opts.humanCap must be an integer >= 1');
    humanCap = Math.min(humanCap, o.humanCap);
  }
  // a paid sim that threw half way is never stepped again (design 5): its first failing wake closes the room
  if (o.emergencyFails !== undefined && o.emergencyFails !== 1) {
    throw new Error('slRoom: a paid room closes on its first failing wake (emergencyFails 1)');
  }
  const bd = laws.C_PAID_BORDER_DROPS.value;
  if (!bd || bd.border !== 'asBody' || Object.keys(bd).length !== 1) {
    bad('C_PAID_BORDER_DROPS', 'is not {border: asBody} (the only form built)');
  }
  const lobbyType = typeof o.lobbyType === 'string' && o.lobbyType ? o.lobbyType : m.label;
  if (typeof lobbyType !== 'string' || !lobbyType.startsWith('sl_')) {
    throw new Error('slRoom: a paid room needs a lobbyType sl_...');
  }
  if (m.label !== undefined && m.label !== lobbyType) {
    throw new Error('slRoom: the money controller is labelled ' + m.label + ', the room ' + lobbyType +
      ' (the journal keys records by it)');
  }
  return {
    R: Object.freeze(Object.assign({}, R, { humanCap, emergencyFails: 1 })),
    paidDrops: { border: true, inset: laws.C_PAID_DROP_INSET.value },
    lobbyType,
  };
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
  //   seed          the room seed (default: from the wall clock; tests pass one; a paid room requires it)
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
  // A paid room (PAID; the header) also takes:
  //   money         the room's money controller (server/slPaid/slMoney.js createSlMoney), attached here
  //   lobbyType     'sl_na_s0_5', 'sl_na_s0_5#1', 'sl_na_s1', ... (default money.label; the two must agree)
  //   humanCap      a cap below C_PAID_HUMAN_CAP (optional)
  //   emergencyFails  1 or absent (a paid room closes on its first failing wake)
  constructor(laws, opts) {
    const o = opts || {};
    if (o.shippableOnly !== false) assertShippable(laws);
    this.laws = laws;
    this.money = o.money || null;
    const paid = this.money ? paidRoom(laws, roomLaws(laws), o) : null;
    const R = paid ? paid.R : roomLaws(laws);
    this.R = R;
    this.P = R.P;
    this.log = o.log || console;
    this.timers = o.timers || REAL_TIMERS;
    this.clock = typeof o.clock === 'function' ? o.clock : (() => performance.now());
    this.now = typeof o.now === 'function' ? o.now : Date.now;
    this.chatGuard = o.chatGuard || createChatGuard();   // the shared chat rules (server/chatGuard.js), a bucket per seat
    this.region = typeof o.region === 'string' && o.region ? o.region : 'na';
    this.lobbyType = paid ? paid.lobbyType
      : o.br ? (typeof o.lobbyType === 'string' && o.lobbyType ? o.lobbyType : 'sl_' + this.region + '_br')
        : 'sl_' + this.region + '_s0';
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
    this.paidBots = !!(this.money && this.bots && o.paidBots === true);

    const seed = typeof o.seed === 'number' && Number.isFinite(o.seed) ? o.seed : (this.now() % 2147483647);
    const prey = o.prey !== undefined ? o.prey === true : preyNotShippable(laws).length === 0;
    this.freedAt = new Map(); // snake id -> sim ms it left the sim (C_ID_QUARANTINE_MS)
    const simOpts = { seed, world: true, prey, idBlocked: (id) => this._idBlocked(id) };
    if (paid) simOpts.paidDrops = paid.paidDrops;
    // A paid room's border is pinned at C_R_MIN (its radius for C_PAID_HUMAN_CAP snakes) whatever the snake count, so
    // the owner's bots never move it: every cash pellet stays inside flux - C_PAID_DROP_INSET (the checker's I7). The
    // free border driver, ticked with a count of 0, holds exactly that radius.
    if (paid) {
      simOpts.makeBorder = (l, bo) => {
        const b = createBorder(l, { nowMs: bo && bo.nowMs !== undefined ? bo.nowMs : 0, count: 0 });
        return { radius: () => b.radius(), target: () => b.target(), due: () => b.due(),
          tick: (nowMs) => b.tick(nowMs, 0), stats: () => b.stats() };
      };
    }
    // the battle royale (server/slBr/brMatch.js): its circle and its holdable border; never with money
    this.br = o.br || null;
    if (this.br && this.money) throw new Error('slRoom: a battle royale room holds no money');
    if (this.br) this.isBattleRoyale = true; // the owner console's label
    if (this.br) {
      simOpts.zone = this.br.zone;
      simOpts.makeBorder = this.br.makeBorder;
    }
    this.sim = createSim(laws, simOpts);
    this.K = slSnake.snakeLaws(laws);
    // a paid room's view sends the eat of a cell's food before the add that fills the cell again in the same step
    // (slView refillsOf: a gold pile, found by the paid soak); the free room's stream stays as its goldens pin it
    this.world = paid
      ? viewFactory.createWorld(laws, this.sim, { eatThenRefill: true })
      : viewFactory.createWorld(laws, this.sim);
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
    this.watchers = new Map(); // socket id -> watcher seat (the battle royale's and the free room's, seatWatch)
    this.bySnake = new Map(); // own snake id -> seat
    this.humans = new Set(); // snake ids of human snakes (seated or gliding)
    this.names = new Map(); // snake id -> nick (kill lines)
    this.orphans = new Map(); // snake id -> { locked, endSim, why, onEnd, net } (C_DISCONNECT glide)
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
      early: 0, pieceWakes: 0,
    };

    // scheduler (agar's drift-free one, server/ag/agRoom.js:932-1000)
    this.timing = new TickTimer({ periodMs: this.P, maxSteps: R.maxSteps, clock: this.clock, now: this.now });
    this.timer = null;
    this.acc = 0;
    this.last = 0;
    this.stepRealAt = 0; // clock time of the last wake that ran a step (when its records left: _steerOffsetNow)
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
    // The free room from boot (setAwake, slArenas keepAwake): it never takes the idle pause. Never a paid room or the
    // battle royale's: those pause as before.
    this.awake = false;
    this._onTimer = () => this._timerWake();
    this.pieceTimer = null;
    this._onPiece = () => this._pieceWake();
    this._scratch = { ang: 0, wang: 0, dir: 1, turning: false };
    if (this.money) {
      this.settled = null; // the emergencySettle answer ({ left: the ids it could not close, ... }), for the directory
      this.money.attach(this, { onClosed: (acct, outcome, x) => this._paidClosed(acct, outcome, x) });
    }
    if (this.br) this.br.attach(this);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // The owner console contract (server/index.js:1202-1263; SERVER-DESIGN 3.1, 12.1). A free room: no stake, no worth.
  // A paid room hands snakes, liveStakeTotal and floorWorth to its controller (in dollars, design 7.5) and has no bots.

  botsAllowed() {
    return !this.money || (this.paidBots === true && !!this.bots);
  }

  get playerCount() {
    return this.seats.size;
  }

  get botCount() {
    return this.bots && typeof this.bots.count === 'function' ? this.bots.count() : 0;
  }

  // What ops.drainStatus reads: every human seat and every bot, never worth. A paid room: every open account.
  get snakes() {
    if (this.money) return this.money.snakes;
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
    return this.money ? this.money.liveStakeTotal() : 0;
  }

  get floorWorth() {
    return this.money ? this.money.floorWorth : undefined;
  }

  // One bot by hand. Refused above C_ROOM_CAP, without a bot driver (slBots, task T12), and in a paid room.
  addBot() {
    if (this.money && this.paidBots !== true) return null;
    if (this.stopped || !this.bots || typeof this.bots.add !== 'function') return null;
    if (this.sim.count() >= this.R.roomCap) return null;
    return this.bots.add(this) || null;
  }

  // A bot leaves (the driver's takeOut). In a paid room its money goes first (slMoney retireBot: its seed back to the
  // owner's bot bank, what it picked up back to the players it came from), then the snake.
  removeBot(id) {
    if (this.money && typeof this.money.retireBot === 'function') this.money.retireBot(id);
    this.sim.remove(id);
    this.names.delete(id);
    this.freedAt.set(id, this.sim.nowMs());
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
    else if (this.money && typeof this.money.markBots === 'function') this.money.markBots(); // the floor of a room bots played in never goes to the house
    return s;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Seats (SERVER-DESIGN 12.4: one socket per life, a seat at sl:join)

  // null when a seat can be given, else the refusal reason.
  // A gliding orphan is a live human snake, so it counts toward both caps until its glide ends (fixer pass,
  // 2026-10-10: join-then-close cycles from one address kept 773 live snakes against a cap of 20).
  // info (a seat's, optional): its proven wallet, for the battle royale's one snake per person, and its address (ip).
  refusal(info) {
    if (this.stopped || this.closed) return 'closed';
    if (this.br && !this.br.acceptingPlayers()) return 'match'; // a battle royale match is under way
    // one snake per person in the battle royale: this wallet already has a living one here (brMatch.walletBusy)
    if (this.br && info && typeof this.br.walletBusy === 'function' && this.br.walletBusy(info.wallet)) return 'twice';
    // and a few per network (night review 2026-10-29, brMatch.addrFull): one address's free wallets are not a team
    if (this.br && info && typeof this.br.addrFull === 'function' && this.br.addrFull(info.ip)) return 'limit';
    const humans = this.seats.size + this.orphans.size;
    if (humans >= this.R.humanCap || humans >= this.R.roomCap) return 'full';
    return null;
  }

  // socket: the socket.io socket; info: { nick (cleaned), cv (checked) }. Returns the seat, or null when refused
  // (refusal() says why).
  seat(socket, info) {
    if (!socket || typeof socket.id !== 'string') throw new TypeError('slRoom: seat needs a socket with an id');
    if (this.money) throw new Error('slRoom: a paid room seats only through seatPaid (an account per snake)');
    if (this.seats.has(socket.id)) return this.seats.get(socket.id);
    if (this.refusal(info)) return null;
    const built = { s: null, seat: null };
    this._buildSeat(socket, info, built);
    const seat = built.seat;
    seat.queue.flush(this.clock());
    this._ensureTicking();
    return seat;
  }

  // The seat itself: the snake, the seat object and its key, queue and view, the join bundle, the key message and the
  // biggest cash-out box, all queued, nothing flushed. built.s and built.seat are set as soon as each exists, so
  // seatPaid can undo a build that threw half way.
  _buildSeat(socket, info, built) {
    const inf = info || {};
    const cv = Number.isInteger(inf.cv) && inf.cv >= 0 ? inf.cv : 0;
    const s = this.spawnSnake({ nick: inf.nick, cv, isBot: false });
    // A bought skin (docs/skin-purchases.md): its custom bytes, from slSockets after the skin pass checked out. Kept on
    // the snake for slView's snake_add only; the sim and its digest never read it. Byte values only, capped.
    if (Array.isArray(inf.skin) && inf.skin.length >= 10 && inf.skin.length <= 80
        && inf.skin.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) s.skin = inf.skin.slice();
    built.s = s;
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
      // the network it joined from (clientAddr.addressGroup of info.ip, '' unknown), for its whole life, parked and
      // gliding too: paid snake's one seat per network per room counts it (slPaidArenas _takesAddr), so a drop, another
      // wallet's join from that network and a resume cannot put two of them in one room (night review 2026-10-29)
      net: addressGroup(inf.ip),
    };
    built.seat = seat;
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
    if (this.br) {
      this.br.noteSeat(s.id, { wallet: inf.wallet, nick: s.nick, ip: typeof inf.ip === 'string' ? inf.ip : '' });
      seat.queue.message(tick, this.br.joinMsg(s.id));
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Watchers (the battle royale's, Owen 2026-10-15 "build spectate too"; and the free room's, the lobby's Spectate on
  // slither.io's Free rung, public/js/slx/slxWatch.js). Never a paid room's.
  //
  // A watcher is a seat with no snake: its view follows a living snake AS ITS OWN (createSeatView ownId), so their
  // client's camera, minimap and length line follow it exactly as for a player. It never steers, holds, chats or
  // counts as a player (playerCount, the caps, the bot fill and /api/live read seats only); its pings get their
  // pongs (their client's lag check waits on them); it gets the kill lines and every sl:x to all. When the followed
  // snake ends, their client plays its own death and closes the socket (one socket per life), and the layer
  // (public/js/slx/slxBr.js) opens a watcher on the next survivor. No resume key: a dropped watcher just ends.
  // The free room follows the leader instead (_leaderAfter), bots included: Owen plays one person among bots, so a
  // persons-first rule would mostly show nothing new. The layer's Next is a new life with info.after, the id it
  // watched last: the next snake down the board from it; its Previous the same with info.before, the one up.
  // A watcher keeps the room awake (lastHumanAt, _afterWake): a paused room would show it frozen snakes. That costs
  // what one seated player costs, and watchers are capped as seats are (the directories' watch, C_HUMAN_CAP).

  // The snake to follow: the living person asked for (follow, a snake id), else the people longest first, then the
  // bots longest first, stepped through by after and before as the free room's (_leaderAfter). null when the arena is
  // empty.
  _watchTarget(follow, after, before) {
    if (Number.isInteger(follow) && this.humans.has(follow) && this.sim.snake(follow)) return this.sim.snake(follow);
    return this._leaderAfter(after, before, true);
  }

  // The free room's snake to follow: the one right after `after` (Next), or right before `before` (Previous), both
  // snake ids, among every living snake in a fixed order (snake id), wrapping round; the leader (the leaderboard's
  // order: length, then fam, then id) when the id is not alive or not given (after wins over before). peopleFirst: the battle
  // royale's order, every person before every bot. null when the room is empty.
  _leaderAfter(after, before, peopleFirst) {
    const order = [];
    this.sim.forEachSnake((s) => { order.push(s); });
    if (!order.length) return null;
    const bot = (s) => (peopleFirst && !this.humans.has(s.id) ? 1 : 0);
    let step = Number.isInteger(after) ? 1 : Number.isInteger(before) ? -1 : 0;
    const from = step > 0 ? after : before;
    if (step && !order.some((s) => s.id === from)) step = 0;
    // Stepping goes round in a fixed order (snake id, people first in the battle royale): by live length, two snakes
    // of about the same length swap places between presses and Next bounced between them (headless, 2026-10-16).
    // With nothing to step from, the leader.
    if (step) order.sort((a, b) => (bot(a) - bot(b)) || (a.id - b.id));
    else order.sort((a, b) => (bot(a) - bot(b)) || (b.pts.length - a.pts.length) || (b.fam - a.fam) || (a.id - b.id));
    if (step) {
      for (let i = 0; i < order.length; i++) {
        if (order[i].id === from) return order[(i + step + order.length) % order.length];
      }
    }
    return order[0];
  }

  // socket: the socket.io socket; info: { follow, after, before } in the battle royale, { after, before } in the free
  // and the paid rooms (optional snake ids). Returns the watcher, or null (the room closed, or nothing alive to watch).
  // A paid room is watched too (Owen, 2026-10-15; the lobby's Spectate on a $0.50 or $1 rung, slPaidArenas.watch):
  // a watcher is never a seat, opens no account and never reaches the money controller (seatPaid is the only way in),
  // and its view is the followed player's own (createSeatView ownId, the player's view range), so it sees what that
  // player sees and nothing more.
  seatWatch(socket, info) {
    if (!socket || typeof socket.id !== 'string') throw new TypeError('slRoom: seatWatch needs a socket with an id');
    if (this.stopped || this.closed) return null;
    if (this.watchers.has(socket.id)) return this.watchers.get(socket.id);
    const ask = info || {};
    const target = this.br ? this._watchTarget(ask.follow, ask.after, ask.before)
      : this._leaderAfter(ask.after, ask.before);
    if (!target) {
      // A free room nobody woke yet has no bots (they fill as it ticks): the ask wakes it for C_IDLE_PAUSE_MS and the
      // layer asks again in a few seconds; its idle pause ends it as before when nobody stays. An empty paid room has
      // no bots to fill it, so a watcher never wakes one.
      if (!this.br && !this.money) {
        this.lastHumanAt = this.clock();
        this._ensureTicking();
      }
      return null;
    }
    const seat = {
      id: socket.id,
      socket,
      watch: true,
      snakeId: target.id,
      nick: '',
      cv: 0,
      dead: false,
      deadAt: NaN,
      cashed: false,
      closed: false,
      joinTick: this.sim.tick(),
      lastPingAt: NaN,
      lastHeard: this.clock(),
      flushHandle: null,
      pendingEcho: null,
      wakeDone: -1,
      diag: null,
      view: null,
      queue: null,
      key: null,
      prevKey: null,
      parked: false,
      heldAtPark: false,
    };
    seat.queue = createSendQueue(this.laws, {
      socket,
      ownId: target.id,
      clock: this.clock,
      stats: this.qstats,
      log: this.log,
      onKick: (reason) => this._onKick(seat, reason),
    });
    seat.view = this.viewFactory.createSeatView(this.laws, { sim: this.sim, world: this.world, ownId: target.id,
      watch: true });
    this.watchers.set(socket.id, seat);
    this.stats.watchers = (this.stats.watchers || 0) + 1;
    const tick = this.sim.tick();
    const events = seat.view.join({ tick, simMs: this.sim.nowMs(), flux: this.sim.flux(), frames: [], dead: false });
    this._pushEvents(seat, tick, events);
    seat.queue.message(tick, { t: 'watch', id: target.id, name: target.nick });
    if (this.br) seat.queue.message(tick, this.br.joinMsg());
    if (this.top) seat.queue.message(tick, this.top);
    seat.queue.flush(this.clock());
    this._ensureTicking();
    return seat;
  }

  _unwatch(seat) {
    if (!this.watchers.delete(seat.id)) return false;
    seat.closed = true;
    if (seat.flushHandle) seat.flushHandle.stop();
    seat.flushHandle = null;
    seat.queue.close();
    if (typeof seat.view.leave === 'function') safeCall(() => seat.view.leave(), 'sl.view.leave', this.safeStats, this.safeOpts);
    return true;
  }

  // A paid seat (PAID-SL-DESIGN 3.3; the door, server/slPaid/slPaidDoor.js, consumed the token). entry: { jid, micro,
  // wallet, paid, name, stakeSig }, micro from the consumed token only. The account opens LAST, so a seat either holds
  // an open account or leaves no trace of itself, and the door refunds the token exactly when no account exists
  // (MONEY INVARIANT 7; D1-C1, D2-C1):
  //   A  the seat is built as seat() builds it, with no flush and no ticking; a throw undoes it and is rethrown
  //   B  money.open (its own throw rolls its deposit back); a throw undoes the seat and is rethrown
  //   C  the commit, every call in safeCall: {t:'room'} and the own {t:'w'}, the flush, the ticking. Anything between
  //      B and C that throws anyway aborts the account (money.abort: the deposit leaves as a refund in the bank's
  //      books, the door refunds the token), undoes the seat and is rethrown.
  // Returns the account, or null when the room refuses (full, closed, settled or tainted: the door tries the next).
  seatPaid(socket, info, entry) {
    if (!this.money) throw new Error('slRoom: seatPaid needs a paid room (opts.money)');
    if (!socket || typeof socket.id !== 'string') throw new TypeError('slRoom: seatPaid needs a socket with an id');
    if (this.seats.has(socket.id)) throw new Error('slRoom: socket ' + socket.id + ' already holds a seat here');
    if (this.refusal() || this.money.stopped || this.money.tainted) return null;
    const built = { s: null, seat: null };
    try {
      this._buildSeat(socket, info, built);
    } catch (e) {
      this._undoSeat(built);
      throw e;
    }
    const id = built.s.id;
    let acct;
    try {
      acct = this.money.open(id, entry);
    } catch (e) {
      this._undoSeat(built);
      this._keepRefundAlive(entry);
      throw e;
    }
    const seat = built.seat;
    try {
      const tick = this.sim.tick();
      const room = this._roomMsg();
      const w = this._worthMsg(id);
      this._safe(() => seat.queue.message(tick, room, true), 'sl.paid.room');
      if (w) this._safe(() => seat.queue.message(tick, w), 'sl.paid.w');
      this._safe(() => seat.queue.flush(this.clock()), 'sl.paid.flush');
      this._safe(() => this._ensureTicking(), 'sl.paid.tick');
    } catch (e) {
      this.log.error('[SLP] SEAT threw after the account opened, aborted (' + this.lobbyType + '): ' +
        (e && e.message));
      try {
        this.money.abort(id);
      } catch (e2) {
        // the bank refused the withdraw: the account stays open and the door sees it and refunds nothing; the
        // controller logged it CRITICAL with its jid and micro, alerted and tainted the room (no new seat)
        this.log.error('[SLP] SEAT CRITICAL abort of snake ' + id + ' refused (' + this.lobbyType + '): ' +
          (e2 && e2.message));
      }
      this._undoSeat(built);
      this._keepRefundAlive(entry);
      throw e;
    }
    return acct;
  }

  // A seat undone while its account stayed open (the bank refused the rollback or the abort): its snake is gone, so
  // the controller's orphan check (I4, every step end) is what refunds it through the owed lane, and only a ticking
  // room has step ends. The first seat of a room had not started the clock yet (C comes last), and the idle pause
  // waits for every account to close, so the clock runs until I4 settles it or a restart's settle does.
  _keepRefundAlive(entry) {
    const jid = entry && entry.jid;
    if (typeof jid === 'string' && this._safe(() => this.money.account(jid), 'sl.paid.account')) {
      this._safe(() => this._ensureTicking(), 'sl.paid.tick');
    }
  }

  // seatPaid's undo: everything the build made goes, each part in its own try, so one failing part never keeps the
  // others (the snake, the human mark and name, the seat maps and its key, the view, the queue). Nothing was sent.
  _undoSeat(built) {
    const s = built.s;
    const seat = built.seat;
    const parts = [];
    if (s) {
      parts.push(() => this.sim.remove(s.id));
      parts.push(() => this.humans.delete(s.id));
      parts.push(() => this.names.delete(s.id));
    }
    if (seat) {
      seat.closed = true;
      parts.push(() => { if (this.seats.get(seat.id) === seat) this.seats.delete(seat.id); });
      parts.push(() => { if (this.bySnake.get(seat.snakeId) === seat) this.bySnake.delete(seat.snakeId); });
      parts.push(() => this._dropKey(seat));
      parts.push(() => { if (seat.view && typeof seat.view.leave === 'function') seat.view.leave(); });
      parts.push(() => { if (seat.queue) seat.queue.close(); });
    }
    for (const f of parts) this._safe(f, 'sl.paid.undo');
    this.stats.seats = this.seats.size;
  }

  _roomMsg() {
    return { t: 'room', stake: this.money.stake, cut: PAID_CUT_PCT };
  }

  // safeCall with the room's stats and log (the paid lines: a throw is counted by label and logged, never rethrown)
  _safe(fn, label) {
    return safeCall(fn, label, this.safeStats, this.safeOpts);
  }

  // The {t:'w'} of a paid snake (micro), or null when it has no account.
  _worthMsg(id) {
    // display: a bounty bot's worth shows like a person's (displayWorthOf); money paths read worthOf
    const v = typeof this.money.displayWorthOf === 'function' ? this.money.displayWorthOf(id) : this.money.worthOf(id);
    return v === null || v === undefined ? null : { t: 'w', id, v };
  }

  seatOf(socketOrId) {
    const id = typeof socketOrId === 'string' ? socketOrId : socketOrId && socketOrId.id;
    return id ? this.seats.get(id) || this.watchers.get(id) || null : null;
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
    if (seat.watch) return this._unwatch(seat); // a watcher has no snake: it just ends
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
      onEnd: typeof onEnd === 'function' ? onEnd : null, net: typeof seat.net === 'string' ? seat.net : '' });
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
    if (this.money) {
      // a paid seat: the room and its own worth again (design 3.3 Resume); a snake that died meanwhile has none
      first.push(this._roomMsg());
      const w = this._worthMsg(seat.snakeId);
      if (w) first.push(w);
    }
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

  // The arrival offset of a STEERING record (angle byte, arrow ticks): measured from when the last step actually ran,
  // the moment its records left and the client set its ang from them, not from that step's due time. A wake late by L
  // ms (Windows timers 15.6 ms, CPU load) otherwise made the echo jump the client forward rate x L and the next update
  // throw it back as far (task TURNING, slither-reference/recordings/TURNING.md). Equal to _offsetNow when wakes are on
  // time. Boost records keep _offsetNow (L13.first, L23 law-checked on it).
  _steerOffsetNow() {
    if (!this.ticking) return 0;
    const off = Math.round(this.stepRealAt + this.P - this.clock());
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
    if (!seat.dead && !seat.watch) this.holds.heard(seat.snakeId, this._arrivalSim(this._offsetNow()));
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
    const offSteer = this._steerOffsetNow();
    const s = seat.dead || seat.watch ? null : this.sim.snake(seat.snakeId); // a watcher's pings only
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
      this.sim.setInput(seat.snakeId, r, r.type === 'angle' || r.type === 'turn' ? offSteer : off);
      if (r.type === 'angle' || r.type === 'turn') steer = true;
    }
    if (steer && s && s.holdMult === null) this._echo(seat, s);
    this._scheduleFlush(seat);
    return true;
  }

  // The own wanted-angle echo (SERVER-DESIGN 5.2 step 3): the ang, wang and dir the snake has at this input's arrival,
  // from its slot, exactly as the next step will run it (slSnake.steerAt on a scratch copy).
  _echo(seat, s) {
    const x = this._scratch;
    const raw = slSnake.steerAt(this.K, s, this.P, x);
    if (raw < 0) return;
    // L48.rot: the echo carries the snake's ang byte too (L48.angRound), as every own rotation record of their server
    // does: S1+S2 own records are dir+ang+wang (6404), dir+ang+wang+sp (1612), ang, sp or ang+sp, never dir+wang
    // without ang; a dir+wang echo broke "ang whenever the snake is turning" on 16875 own records (task T14). That ang
    // is the one at the arrival (L14 per ms), not the last update's: a stale one threw the client back 0.06 rad on 62
    // percent of hard-turn echoes (slither-reference/recordings/TURNING.md).
    const ev = { type: 'snake_rot', id: s.id, dir: x.dir === 2 ? 2 : 1, ang: slQuant.rotAng(x.ang, this.R.angRound).v,
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
    if (seat.watch || seat.dead || !this.sim.snake(seat.snakeId)) return false;
    if (on && this.br && !this.br.allowsHold()) return false; // no leaving while the match is fought
    if (on) return this.holds.press(seat.snakeId, this._arrivalSim(this._offsetNow()));
    return this.holds.release(seat.snakeId, 'release');
  }

  // sl:vis {hidden}: the ackLate exemption, and a hidden tab ends a hold.
  onVis(socketOrSeat, hidden) {
    const seat = socketOrSeat && socketOrSeat.queue ? socketOrSeat : this.seatOf(socketOrSeat);
    if (!seat || seat.closed || seat.parked) return false;
    this._heard(seat);
    seat.queue.setHidden(!!hidden);
    if (hidden && !seat.dead && !seat.watch) this.holds.release(seat.snakeId, 'hidden');
    return true;
  }

  // sl:chat {text}: one line to every seat and watcher, after the chat guard (server/chatGuard.js: tags and hidden
  // characters gone, rate, links, wallet addresses and slurs refused, swear words masked; then C_CHAT). The line
  // carries the snake id and skin (id, cv) so pages print the name in the snake's colour. A refused line tells only
  // its sender why ({t: 'chatnote', text}); slSockets' C_RATE chat gap still runs first.
  onChat(socketOrSeat, text) {
    const seat = socketOrSeat && socketOrSeat.queue ? socketOrSeat : this.seatOf(socketOrSeat);
    if (!seat || seat.closed || seat.parked || seat.watch) return false;
    this._heard(seat);
    const r = this.chatGuard.check(seat.id, text, this.now());
    if (!r.ok) {
      if (r.note) {
        seat.queue.message(this.sim.tick(), { t: 'chatnote', text: r.note });
        this._scheduleFlush(seat);
      }
      return false;
    }
    const t = cleanChat(r.text, this.R);
    if (!t) return false;
    this.stats.chats++;
    this._messageAll({ t: 'chat', name: seat.nick, text: t, id: seat.snakeId, cv: seat.cv });
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
    for (const seat of this.watchers.values()) {
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
      this.stepRealAt = this.last;
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
      this.stepRealAt = now;
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
    if (steps > 0) this.stepRealAt = now;
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
    this.stepRealAt = this.clock();
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
      sliceStart: NaN, // when the running slice began (_jobBody), for its length at a yield or at the end
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
    job.sliceStart = sliceStart;
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
      if (this.money) this._safe(() => this._worthAll(), 'sl.paid.worth');
      job.seatList = Array.from(this.seats.values());
      for (const p of this.parked) job.seatList.push(p); // parked seats collect too (resume, see the header)
      for (const w of this.watchers.values()) job.seatList.push(w); // the watchers (seatWatch)
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

  // One slice of synchronous room time ended (the governor's slice input, slArenas). Every slice: one that yields, and
  // the last of each wake (_endJob), which a wake that never yields is all of (verifier, 2026-10-11: recorded only at
  // a yield, the slice input read 0.0 ms in every local run, also during a 40 ms burn).
  _noteSlice(sliceStart) {
    const d = this.clock() - sliceStart;
    if (d > this.stats.maxSliceMs) this.stats.maxSliceMs = d;
  }

  _yield(sliceStart) {
    this._noteSlice(sliceStart);
    this.stats.slices++;
    this._jobHandle = safeImmediate(() => this._resumeJob(), 'sl.wake.slice', this.safeStats, this.safeOpts);
  }

  _endJob(job) {
    if (this._job !== job) return;
    this._job = null;
    if (Number.isFinite(job.sliceStart)) this._noteSlice(job.sliceStart);
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
    if (this.seats.size > 0 || this.watchers.size > 0) this.lastHumanAt = now;
    if (!this.autoTick) return;
    // a paid room never pauses with money in a snake (MONEY INVARIANT 10); an awake room never pauses at all
    if (!this.awake && this.seats.size === 0 && this.orphans.size === 0 && this.parked.size === 0 &&
      (!this.money || this.money.openCount() === 0) && (!this.br || this.br.canPause()) &&
      now - this.lastHumanAt >= this.R.idleMs) {
      this._pause();
      return;
    }
    if (!this.timer) this._arm();
    this._armPiece(true);
  }

  // The next piece end of the update window that started at stepRealAt (plus 1 ms, so every steering record with a
  // window time up to that end has arrived: a later one rounds past it). Only with a seat, never the update's own end.
  _armPiece(again) {
    if (again && this.pieceTimer) {
      this.timers.clearTimeout(this.pieceTimer);
      this.pieceTimer = null;
    }
    if (!SMOOTH.on || this.pieceTimer || this.stopped || this.paused || !this.autoTick || !this.ticking) return;
    if (this.seats.size === 0) return;
    const piece = this.P / slSnake.PIECES;
    const now = this.clock();
    let k = Math.floor((now - this.stepRealAt - 1) / piece) + 1;
    if (k < 1) k = 1;
    if (k >= slSnake.PIECES) return;
    const at = this.stepRealAt + k * piece + 1;
    this.pieceTimer = this.timers.setTimeout(this._onPiece, Math.max(1, Math.ceil(at - now)));
    if (this.pieceTimer && typeof this.pieceTimer.unref === 'function') this.pieceTimer.unref();
  }

  _pieceWake() {
    this.pieceTimer = null;
    if (this.stopped || this.paused || !SMOOTH.on) return;
    this.stats.pieceWakes++;
    safeCall(() => this._earlyPoints(), 'sl.early', this.safeStats, this.safeOpts);
    this._armPiece(false);
  }

  // Each seated live snake whose walk reached its next point by now (slSim previewPoint) gets that point now, and the
  // next step places exactly it (commitPoint). Not while a wake runs (its seat part sends everything), not for a snake
  // with a hold in the book (the cash-out lock may drop the window's steering) or gliding (C_DISCONNECT).
  _earlyPoints() {
    if (this._job) return;
    const wt = this.clock() - this.stepRealAt - 1;
    if (!(wt > 0) || wt >= this.P) return;
    const tick = this.sim.tick();
    for (const seat of this.seats.values()) {
      if (seat.closed || seat.parked || seat.watch || seat.dead) continue;
      if (typeof seat.view.earlyMove !== 'function') continue;
      const id = seat.snakeId;
      if (this.holds.has(id) || this.orphans.has(id)) continue;
      const p = this.sim.previewPoint(id, wt);
      if (!p) continue;
      const ev = seat.view.earlyMove(p);
      if (!ev) continue;
      this.sim.commitPoint(id, p);
      this._pushEvents(seat, tick, [ev]);
      this.stats.early++;
      if (!seat.flushHandle) seat.queue.flush(this.clock());
    }
  }

  _pause() {
    if (this.timer) {
      this.timers.clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pieceTimer) {
      this.timers.clearTimeout(this.pieceTimer);
      this.pieceTimer = null;
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
      // the steering records still waiting in its slot never apply (the glide is straight; test/slTurning.test.js)
      slSnake.lockSteer(s, slQuant.rotAng(s.ang, R.angRound).v);
    }

    // 4-5 sim (a paid room applies the step's money facts around it, _paidStep)
    const log = this.money ? this._paidStep() : sim.step();
    frame.log = log;
    const simMs = sim.nowMs();
    for (let i = 0; i < log.deaths.length; i++) this._onDeath(log.deaths[i], frame.tick, simMs);
    // the battle royale's match reads who fell (still marked human) and moves its clock, circle and ending
    if (this.br) this.br.afterDeaths(frame, log.deaths, simMs);
    // names and the human mark go only after every death of the step (a killer may die in the same step)
    for (let i = 0; i < log.deaths.length; i++) {
      this.humans.delete(log.deaths[i].id);
      this.names.delete(log.deaths[i].id);
    }

    // 6 holds that completed (a death of this step already took its snake out: the death wins); a paid cash-out is
    // money first (M4), then the step's money end (M5: collusion, orphans, the checker), before the next sim step
    // A battle royale that went live in this step (afterDeaths) has just counted who is in and let go of every hold:
    // none completes after that, or a person counted for the prize would leave the match at its first step (review
    // 2026-10-26). The released holds end at the next step's 2.
    const done = this.br && !this.br.allowsHold() ? [] : this.holds.complete(sim, simMs);
    for (let i = 0; i < done.length; i++) this._cashOut(done[i], frame, simMs);
    if (this.money) this.money.endStep();
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
    if (frame.board && this.money) this._safe(() => this._boardWorths(frame.board), 'sl.paid.lb');

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

  // A paid room's sim step (PAID-SL-DESIGN 5): the step's money facts are applied in a finally, from sim.lastLog() and
  // the food pass's eats (slMoney.applyFacts: M1 the kill deaths, M2 the eats, M3 the other deaths, each fact in its
  // own try), so a step that throws half way still moves what it did. On that path every logged death then leaves
  // humans and names, each in its own try so nothing here hides the step's own throw, and the throw goes on to
  // _wakeFailed, which closes the room at once (R.emergencyFails 1: a paid sim that threw half way never steps again).
  // On the normal path a throw of applyFacts itself fails the wake the same way, and _onDeath and the names loop run
  // as in the free room.
  _paidStep() {
    const sim = this.sim;
    let ok = false;
    try {
      const log = sim.step();
      ok = true;
      return log;
    } finally {
      const facts = () => this.money.applyFacts(sim.lastLog(), sim.food ? sim.food.tick.eats : null);
      if (ok) {
        facts();
      } else {
        this._safe(facts, 'sl.paid.facts');
        const deaths = this._safe(() => sim.lastLog().deaths, 'sl.paid.deaths') || [];
        for (let i = 0; i < deaths.length; i++) {
          const id = deaths[i] && deaths[i].id;
          this._safe(() => this.humans.delete(id), 'sl.paid.humans');
          this._safe(() => this.names.delete(id), 'sl.paid.names');
        }
      }
    }
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
    for (const seat of this.watchers.values()) {
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
      const msg = { t: 'kill', killer: this.names.get(d.killer) || '', victim: this.names.get(id) || '', kid: d.killer, vid: id };
      for (const st of this.seats.values()) st.queue.message(tick, msg);
      for (const st of this.watchers.values()) st.queue.message(tick, msg);
      for (const st of this.parked) st.queue.message(tick, msg); // a parked seat back in time sees it (resume)
    }
  }

  // A completed hold (SERVER-DESIGN 15.3, Owen 17:00): the snake leaves at once with no food. The own seat gets
  // sl:x {t: 'cashed', len} with this step, so the flush sends it before the stream's own `dead`.
  _cashOut(id, frame, simMs) {
    const s = this.sim.snake(id);
    if (!s) return;
    if (this.money) {
      this._paidCashOut(s, frame, simMs);
      return;
    }
    this._cashedOut(id, frame, simMs, { t: 'cashed', len: this._lenOf(s) });
  }

  _lenOf(s) {
    const fam = slQuant.fam24(s.fam, this.R.famRound).v;
    return slCore.scoreOf(this.scoreTables.fmlts, this.scoreTables.fpsls, s.pts.length, fam);
  }

  // A paid cash-out (PAID-SL-DESIGN 6), money FIRST: money.cashOut withdraws the account, closes its journal record
  // and dispatches the 90/10 payout order before it returns (critic C-6). A refusal before the withdraw throws there:
  // the snake keeps playing (its hold lock and ring end; the controller logged CRITICAL and alerted). A throw with the
  // account gone is not proof the order went out: it is logged CRITICAL and alerted with the gross for the owner to
  // reconcile by hand (the journal close holds the cashoutId), and the snake leaves. Only then does the snake leave
  // the sim and the own seat get {t:'cashed', len, gross, cut, net, cid}; a throw in that part (its length included)
  // is logged CRITICAL with an alert and goes on to _wakeFailed (the emergency close), the payout already on its way.
  _paidCashOut(s, frame, simMs) {
    const id = s.id;
    const seat = this.bySnake.get(id);
    const gross = this._safe(() => this.money.worthOf(id), 'sl.paid.worth');
    let o = null;
    try {
      o = this.money.cashOut(id, seat && seat.socket ? seat.id : null);
    } catch (e) {
      if (this.money.account(id)) {
        this._safe(() => this.sim.setHold(id, null, 0), 'sl.paid.unlock');
        this._ringAll(frame.tick, id, 0);
        return;
      }
      this.log.error('[SLP] CASHOUT CRITICAL snake ' + id + ' withdrawn (' + gross + ' micro) but cashOut threw, its ' +
        'order is unconfirmed (' + this.lobbyType + '): ' + (e && e.message));
      this._paidAlert('cashout-unconfirmed', { snakeId: id, micro: gross });
    }
    try {
      const len = this._lenOf(s);
      const msg = o ? { t: 'cashed', len, gross: o.gross, cut: o.cut, net: o.net, cid: o.cid } : { t: 'cashed', len };
      this._cashedOut(id, frame, simMs, msg);
    } catch (e) {
      this.log.error('[SLP] CASHOUT CRITICAL snake ' + id + ' paid (' + (o ? o.cid : 'no order') + ') but its removal ' +
        'threw (' + this.lobbyType + '): ' + (e && e.message));
      this._paidAlert('cashout-removal', { snakeId: id });
      throw e;
    }
  }

  // A room alert through the controller's (wallets stripped, one per room per kind per 10 min); never throws.
  _paidAlert(kind, info) {
    if (typeof this.money._alert === 'function') this._safe(() => this.money._alert(kind, info), 'sl.paid.alert');
  }

  // The snake of a completed hold leaves (no food), others are told C_CASHOUT_CODE, the own seat gets msg (kept).
  _cashedOut(id, frame, simMs, msg) {
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
      seat.queue.message(frame.tick, msg, true); // kept: a resume after lost bundles still says so
    }
    this._endOrphan(id);
    this.humans.delete(id);
    this.names.delete(id);
  }

  // L9: every live snake sorted by sct then fam, both down, ties by id (deterministic); count per C_LB_BOTS.
  // A paid room ranks by money (Owen 2026-10-17: "how much they're worth... the higher the number the higher the
  // rank"): each row carries its display worth w (micro, a bounty bot's like a person's), most first, then length.
  // Display only: nothing here moves money.
  _board() {
    const order = [];
    const paid = !!this.money;
    this.sim.forEachSnake((s) => {
      const w = paid ? this._displayWorth(s.id) : 0;
      order.push({ id: s.id, sct: s.pts.length, fam: s.fam, nick: s.nick, cv: s.cv, w });
    });
    order.sort((a, b) => (b.w - a.w) || (b.sct - a.sct) || (b.fam - a.fam) || (a.id - b.id));
    let count = order.length;
    if (!this.R.lbBots) {
      count = 0;
      for (const r of order) if (this.humans.has(r.id)) count++;
    }
    return { order, count, rows: this.R.lbRows };
  }

  // A paid snake's $ for the board (micro), 0 when it has no account.
  _displayWorth(id) {
    const v = this._safe(() => (typeof this.money.displayWorthOf === 'function'
      ? this.money.displayWorthOf(id) : this.money.worthOf(id)), 'sl.paid.lb');
    return Number.isFinite(v) && v > 0 ? v : 0;
  }

  // {t:'lb'} at every L9 leaderboard of a paid room: the top rows' names and worths in the board's own order, and the
  // seat's own place and worth (me [rank, micro], or null with no live snake), so the board shows $ for snakes
  // off screen too (slxHud.js). Display only.
  _boardWorths(board) {
    const n = Math.min(board.rows, board.order.length);
    const rows = new Array(n);
    for (let i = 0; i < n; i++) rows[i] = [board.order[i].nick, board.order[i].w];
    const rankOf = new Map();
    for (let i = 0; i < board.order.length; i++) rankOf.set(board.order[i].id, i);
    const tick = this.sim.tick();
    for (const seat of this.seats.values()) {
      if (seat.closed) continue;
      const at = rankOf.get(seat.snakeId);
      const me = at === undefined ? null : [at + 1, board.order[at].w];
      seat.queue.message(tick, { t: 'lb', rows, me });
    }
    // a watcher (a paid rung's Spectate) sees the same $ board, with no own row
    for (const seat of this.watchers.values()) if (!seat.closed) seat.queue.message(tick, { t: 'lb', rows, me: null });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // The seat part (SERVER-DESIGN 5.3 steps 9 and 10)

  _seatPart(seat, job) {
    const t0 = this.clock();
    let frames = job.frames;
    if (frames.length && frames[0].tick <= seat.joinTick) frames = frames.filter((f) => f.tick > seat.joinTick);
    const tick = this.sim.tick();
    if (seat.watch && !seat.dead && !this.sim.snake(seat.snakeId)) {
      seat.dead = true; // the followed snake ended: their client runs its death, the layer watches the next
      seat.deadAt = this.clock();
    }
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
      if (ev.type === 'snake_add' || ev.type === 'snake_remove') {
        this._ringOnView(seat, tick, ev);
        if (this.money && ev.type === 'snake_add') this._safe(() => this._worthOnView(seat, tick, ev), 'sl.paid.worth');
      }
    }
  }

  // A seat that picks up a paid snake gets its worth with the add (design 9: the $ over each paid head). The own
  // snake's comes with the seat's commit, the resume and the wake's _worthAll.
  _worthOnView(seat, tick, ev) {
    if (ev.id === seat.snakeId) return;
    const w = this._worthMsg(ev.id);
    if (w) seat.queue.message(tick, w);
  }

  // {t:'w'} once per wake for every paid snake whose worth changed (design 9), before the seat part: to its own seat
  // with its delta d, and to every seat whose client holds the snake (delivered or a queued add) without it. A seat
  // that picks the snake up in this wake's collect gets it from _worthOnView. Parked seats get theirs at the resume.
  _worthAll() {
    const changed = this.money.takeChanged();
    if (!changed.length) return;
    const tick = this.sim.tick();
    for (const seat of this.seats.values()) {
      if (seat.closed) continue;
      for (let i = 0; i < changed.length; i++) {
        const c = changed[i];
        if (c.id === seat.snakeId) seat.queue.message(tick, { t: 'w', id: c.id, v: c.v, d: c.d });
        else if (seat.queue.holdsSnake(c.id)) seat.queue.message(tick, { t: 'w', id: c.id, v: c.v });
      }
    }
  }

  // The controller closed an account (slMoney onClosed; never for 'aborted', whose seat seatPaid undoes itself). The
  // own seat, seated or parked, hears it with a kept message (a resume after lost bundles still says so):
  //   died       {t:'lost', v}: the whole worth is gold on the floor now (design 4). Sent from the death fact itself,
  //              so it reaches the seat on a step that threw too.
  //   refunded   {t:'closed', why, refunded} (shutdown, crash, emergency, orphan: 100% of the current worth, micro),
  //              flushed at once while the room is being settled (the process may exit next), else on the next turn
  //   cashedout  _paidCashOut sends {t:'cashed'} with the numbers
  _paidClosed(acct, outcome, x) {
    const seat = this.bySnake.get(acct.snakeId);
    if (!seat || seat.closed) return;
    const e = x || {};
    const tick = this.sim.tick();
    if (outcome === 'died') {
      seat.queue.message(tick, { t: 'lost', v: e.lostMicro }, true);
    } else if (outcome === 'refunded') {
      seat.queue.message(tick, { t: 'closed', why: e.why, refunded: e.refundedMicro }, true);
      if (seat.parked) return;
      if (this.money.stopped) this._safe(() => seat.queue.flush(this.clock()), 'sl.paid.flush');
      else this._scheduleFlush(seat);
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
    if (this.watchers) for (const seat of this.watchers.values()) if (seat.queue.holdsSnake(id)) return true;
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

  // Keeps a free room ticking with nobody in it (no idle pause, C_IDLE_PAUSE_MS): its bots fill to the day's curve and
  // follow it, so the lobby counts real snakes before the first player comes. Refused (false) for a paid room or the
  // battle royale's, which keep their pause. Returns whether the room is awake now.
  setAwake(on) {
    // a paid room only while it holds the owner's bots (paidBots): they hold no money, so it can tick with no human
    this.awake = on === true && (!this.money || this.paidBots === true) && !this.br && !this.stopped && !this.closed;
    if (this.awake) this.start();
    return this.awake;
  }

  // A paid room: stop() never settles money (design 7.2). Its caller settles first (emergencyClose, the directory's
  // shutdownSettle or idle retire); a bank that still holds money is left to that caller, logged CRITICAL and alerted.
  stop() {
    if (this.stopped) return;
    if (this.money) this._stopCheck();
    this._stopClock();
    for (const seat of this.seats.values()) if (seat.flushHandle) seat.flushHandle.stop();
    for (const seat of Array.from(this.watchers.values())) this._unwatch(seat);
    // a stopped room never ends its glides: release every orphan's address charge now
    for (const id of Array.from(this.orphans.keys())) this._endOrphan(id);
    // and nobody can come back to it: parked seats go, their keys with them
    for (const seat of Array.from(this.parked)) this._dropParked(seat);
  }

  // The planned restart of a paid room (PAID-SL-DESIGN 7.2 step 4): the directory settled its money first
  // (money.shutdownSettle), so only the clock stops and no step runs in the exit window. Seats, glides and parked
  // seats stay as they are.
  halt() {
    if (this.stopped) return;
    this._stopClock();
  }

  _stopClock() {
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
    if (this.pieceTimer) {
      this.timers.clearTimeout(this.pieceTimer);
      this.pieceTimer = null;
    }
    this.ticking = false;
    this.timing.idle();
  }

  _stopCheck() {
    this._safe(() => {
      const open = this.money.openCount();
      const micro = this.money.bank && typeof this.money.bank.totalMicro === 'function' ?
        this.money.bank.totalMicro() : Math.round(this.money.liveStakeTotal() * 1e6);
      if (open === 0 && micro === 0) return;
      this.log.error('[SLP] STOP CRITICAL ' + this.lobbyType + ' stopped with ' + open + ' open account(s) and ' +
        micro + ' micro in its bank; not settled here, left to its caller');
      if (typeof this.money._alert === 'function') this.money._alert('stop-with-money', { accounts: open, micro });
    }, 'sl.paid.stop');
  }

  // C_EMERGENCY_FAIL_WAKES wakes in a row threw: the room stops for good and hands its sockets to slArenas
  // (onClosed), which opens a fresh one. A free room owes nobody anything. A paid room (its first failing wake)
  // settles BEFORE it stops (design 7.4): every account refunded 100% of its current worth through the owed lane,
  // the floor swept to the house, each seat told {t:'closed'} (_paidClosed); the answer stays on this.settled, whose
  // left lists any account the settle could not close (the directory keeps the room on its settling list then).
  emergencyClose() {
    if (this.closed) return;
    this.closed = true;
    // the watchers too: stop() only closes their queues, and a socket left open on a dead room freezes
    const sockets = Array.from(this.seats.values()).concat(Array.from(this.watchers.values())).map((s) => s.socket);
    this.log.error('[SL] EMERGENCY close', this.lobbyType, sockets.length + ' socket(s)');
    if (this.money) {
      try {
        this.settled = this.money.emergencySettle('emergency');
      } catch (e) {
        this.log.error('[SLP] EMERGENCY settle threw (' + this.lobbyType + '): ' + (e && e.stack ? e.stack : e));
      }
    }
    this.stop();
    if (typeof this.onClosed === 'function') safeCall(() => this.onClosed(this, sockets), 'sl.onClosed', this.safeStats, this.safeOpts);
  }

  report() {
    const r = this._report();
    if (this.money && typeof this.money.totals === 'function') r.money = this.money.totals();
    return r;
  }

  _report() {
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
  setSmooth,
  smoothOn: () => SMOOTH.on,
};
