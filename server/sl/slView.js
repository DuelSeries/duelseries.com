'use strict';
// slither.io free room: what each seat is sent (SERVER-DESIGN 8, 5.3 steps 9 and 5.4; task T8).
//
// The view turns the sim's tick logs into the records each seat's client must get, on THEIR wire grid and in THEIR
// forms, and keeps per seat a mirror of what that client holds (SERVER-DESIGN 8.1).
//
// The room's contract (server/sl/slRoom.js, "THE SEAT VIEW CONTRACT"):
//   createWorld(laws, sim) -> world                      once per room; world.afterStep(frame) after every sim step
//                                                       (frame = { tick, log, clocks, board, locks, ... }: the room
//                                                       runs the L8 sweep, L9, L10 and L11 clocks and the L9 order)
//   createSeatView(laws, { sim, world, ownId }) -> v    one per seat; v.join(ctx) -> events (the join bundle),
//                                                       v.collect(ctx) -> events once per wake, v.noteOwnRot({ dir,
//                                                       wangRaw }) after an own echo, v.resync() (forget all but the
//                                                       own snake; the next collect re-adds)
// The room encodes the events (the own variant when a snake record's id is the seat's own).
//
// The core underneath (also what the tests drive, with the view's own clocks):
//   const view = createView(laws, sim, opts)     opts.room true: clocks, L9 order and hold locks come from the frames
//   const { seat, entries } = view.join(ownId)   right after sim.spawn: init, own snake_add, then the spawn set
//   view.tick(log, frame)                        after EVERY sim.step(), in order
//   view.assemble(seat) -> entries               once per wake per seat: interest changes first (removals, then adds),
//                                               then the records of every tick since the seat's last assemble
//   view.endWake()                               drops the tick records (room mode prunes by itself)
//   view.resync(seat), view.forget(seat), view.leave(seat), view.idBlocked(id), view.mirror(seat)
// Each entry is { tick, type, ev, rec, own }: rec is the record bytes (slRecordCache); a bundle is bundleOf(entries).
//
// Order of one tick's records for one seat (SERVER-DESIGN 5.4 with the T0 per-snake order L48.order):
//   per updated snake in the sim's processing order: h (fam, L48.hDefer), r (tail), rotation (L48.rot), move (L48.move,
//   L48.abs); then the ends: deaths and cash-outs in order (own: dead code 0 then own removal code 1, L41; other
//   holders: removal code 1 for a death, C_CASHOUT_CODE for a cash-out, L50); every food add of the tick (boost drops,
//   death drops after the deaths, natural spawns; L25); prey moves and removals; eats last (food then prey per eater,
//   in processing order), so an eater the seat started holding in this assemble already exists when its eat applies;
//   then leaderboard (L9), minimap (L10, stops once the own snake ended), flux (L11), kill_count (L40, own seat only).
// A snake, sector or prey the seat starts holding in an assemble gets none of that assemble's other records for it
// (the add carries the state now); eats are delivered by sector, whatever wake the eater was added in.
//
// Never sent (SERVER-DESIGN 8.4, L46, C_SEND_6): sector_add, sector_w, longest_msg, own_rsc, server_version and the
// other ignored types, the u, U and L minimaps, and food_eat 'c'. Nothing here can make one.
//
// Deterministic: no Math.random, no Date; arrays and Maps in fixed insertion order.

const slCore = require('../../shared/slCore.js');
const slQuant = require('./slQuant');
const slSnake = require('./slSnake');
const { createRecordCache, bundleBytes } = require('./slRecordCache');
const { assertLawsComplete, assertRulesBuilt, initFields, INIT_LAW_IDS } = require('./slLaws');

const PI2 = 2 * Math.PI;

// The rows this file reads (init adds INIT_LAW_IDS).
const VIEW_TABLE_IDS = Object.freeze(['L1', 'L2.size', 'L5', 'L6', 'L8.anchor', 'L8.R2', 'L8.R2.high', 'L8.R2.shrink',
  'L8.adds', 'L8.emptySector', 'L8.sweep', 'L8.linger', 'L8.snakeAdd', 'L8.snake', 'L9', 'L10', 'L10.mv',
  'L11.cadence', 'L11.slow', 'L11.fast', 'L11.T', 'L17.famRound', 'L25', 'L40', 'L41', 'L46', 'L48.move', 'L48.abs',
  'L48.rot', 'L48.order', 'L48.angRound', 'L50', 'C_CASHOUT_CODE', 'C_LB_BOTS', 'C_FOOD_FULL_FORMS', 'C_SEND_6',
  'C_ID_QUARANTINE_MS', 'C_MAX_STEPS']);
const VIEW_LAW_IDS = Object.freeze(Array.from(new Set(VIEW_TABLE_IDS.concat(INIT_LAW_IDS))));

// The rule forms this file builds (slLaws.assertRulesBuilt refuses any other in the rows above).
const VIEW_RULES_BUILT = Object.freeze(['anchorAhead', 'r2BySct', 'noFurtherStep', 'followCurrentSct', 'dumpOnEnter',
  'pulledPointInKept', 'retainAfterUnwatched', 'discRaster', 'smallerOfMV', 'zCadence', 'packetByContext',
  'killCreditOwnSeat', 'ownDeathOrder', 'angleFormOnIangChange', 'absFirstPointOnly', 'rotChanged', 'removalCodes']);

// The record order per snake inside one update (L48.order, T0 RULE); this file builds exactly this one.
const ORDER_BUILT = Object.freeze(['tailFam', 'rot', 'move', 'foodEat', 'preyEat']);

// SERVER-LAWS L41: "on the own death, send v code 0".
const DEAD_CODE = 0;

// Types this file never makes (SERVER-DESIGN 8.4; L46 never list R m S i o B; C_SEND_6 false keeps `6` out).
const NEVER_SENT = Object.freeze(['sector_add', 'sector_w', 'longest_msg', 'own_rsc', 'server_version', 'admin_info',
  'team_scores', 'session_id', 'debug_point', 'unknown', 'malformed', 'empty']);

function bad(id, what) {
  throw new Error('slView: law ' + id + ' ' + what + '; this build implements only the form SERVER-LAWS states');
}

function num(v, id, what) {
  if (typeof v !== 'number' || !Number.isFinite(v)) bad(id, what + ' is not a finite number');
  return v;
}

function pos(v, id, what) {
  if (!(num(v, id, what) > 0)) bad(id, what + ' must be > 0');
  return v;
}

// A rule row must hold exactly these keys (rule plus params); fixed params must have the built value.
function form(id, v, keys, fixed) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) bad(id, 'is not a rule row');
  for (const k of Object.keys(v)) if (k !== 'rule' && keys.indexOf(k) < 0) bad(id, 'parameter ' + k + ' is not built');
  for (const k of keys) if (!Object.prototype.hasOwnProperty.call(v, k)) bad(id, 'has no ' + k);
  const f = fixed || {};
  for (const k of Object.keys(f)) {
    if (v[k] !== f[k]) bad(id, k + ' = ' + JSON.stringify(v[k]) + ' is not built (built: ' + JSON.stringify(f[k]) + ')');
  }
  return v;
}

// Reads every number and form the view needs, once.
function viewLaws(laws) {
  assertLawsComplete(laws, VIEW_LAW_IDS);
  assertRulesBuilt(laws, VIEW_TABLE_IDS, VIEW_RULES_BUILT);
  const v = (id) => laws[id].value;

  const an = form('L8.anchor', v('L8.anchor'), ['from', 'a', 'b', 'lastPointA', 'lastPointB']);
  if (an.from !== 'continuousHead' && an.from !== 'lastPoint') bad('L8.anchor', 'from is neither continuousHead nor lastPoint');
  const r2 = form('L8.R2', v('L8.R2'), ['small', 'large', 'stepSct', 'recompute'], { recompute: 'anchorSectorChange' });
  if (!Number.isInteger(r2.small) || !Number.isInteger(r2.large) || r2.small < 0 || r2.large < r2.small) {
    bad('L8.R2', 'small and large must be integers 0 <= small <= large');
  }
  if (!Number.isInteger(r2.stepSct) || r2.stepSct < 2) bad('L8.R2', 'stepSct must be an integer >= 2');
  form('L8.R2.high', v('L8.R2.high'), []);
  form('L8.R2.shrink', v('L8.R2.shrink'), []);
  form('L8.adds', v('L8.adds'), ['emptySends', 'spawnSet'], { emptySends: false, spawnSet: 'whole' });
  const es = v('L8.emptySector');
  if (!es || es.watched !== true || es.sendsFood !== true || es.removeOnSweep !== true || Object.keys(es).length !== 3) {
    bad('L8.emptySector', 'only watched, sendsFood and removeOnSweep all true is built');
  }
  form('L8.snakeAdd', v('L8.snakeAdd'), []);
  const keep = form('L8.snake', v('L8.snake'), ['keepMs']);
  const lb = v('L9');
  if (!lb || lb.order !== 'sctFamDesc' || !Number.isInteger(lb.rows) || lb.rows < 0 || Object.keys(lb).length !== 3) {
    bad('L9', 'only periodMs, rows and order sctFamDesc are built');
  }
  const mm = form('L10', v('L10'), ['periodMs', 'size', 'firstFull'], { firstFull: true });
  if (!Number.isInteger(mm.size) || mm.size < 2 || mm.size > 512) bad('L10', 'size must be an integer 2..512');
  form('L10.mv', v('L10.mv'), []);
  form('L11.cadence', v('L11.cadence'), ['firstCheckAlways', 'onlyOnIntegerChange', 'fastAfterDeath'],
    { firstCheckAlways: true, onlyOnIntegerChange: true, fastAfterDeath: true });
  const famRound = v('L17.famRound');
  const angRound = v('L48.angRound');
  if (slQuant.RULES.indexOf(famRound) < 0) bad('L17.famRound', 'is not a slQuant rounding rule');
  if (slQuant.RULES.indexOf(angRound) < 0) bad('L48.angRound', 'is not a slQuant rounding rule');
  form('L25', v('L25'), ['natural', 'drop', 'dump'], { natural: 'f', drop: 'b', dump: 'F' });
  form('L40', v('L40'), []);
  form('L41', v('L41'), []);
  const l46 = v('L46');
  if (!l46 || !Array.isArray(l46.never) || !Array.isArray(l46.sent)) bad('L46', 'needs sent and never lists');
  form('L48.move', v('L48.move'), []);
  form('L48.abs', v('L48.abs'), []);
  const rot = form('L48.rot', v('L48.rot'), ['angWhileTurning', 'refreshMs'], { angWhileTurning: true });
  const order = v('L48.order');
  if (!Array.isArray(order) || order.length !== ORDER_BUILT.length || order.some((x, i) => x !== ORDER_BUILT[i])) {
    bad('L48.order', 'is not ' + JSON.stringify(ORDER_BUILT));
  }
  const codes = form('L50', v('L50'), ['died', 'leftView'], { died: 1, leftView: 0 });
  const cashCode = v('C_CASHOUT_CODE');
  if (cashCode !== codes.died && cashCode !== codes.leftView) bad('C_CASHOUT_CODE', 'is neither L50 code');
  if (v('C_LB_BOTS') !== true) bad('C_LB_BOTS', 'only "rank and count include bots" (true) is built');
  if (v('C_FOOD_FULL_FORMS') !== true) bad('C_FOOD_FULL_FORMS', 'only the full food forms (true) are built');
  if (v('C_SEND_6') !== false) bad('C_SEND_6', 'only "never send 6" (false) is built');
  const L6 = v('L6');
  if (!Number.isInteger(L6.protocol)) bad('L6', 'protocol is not an integer');
  const maxSteps = v('C_MAX_STEPS');
  if (!Number.isInteger(maxSteps) || maxSteps < 1) bad('C_MAX_STEPS', 'must be an integer >= 1');

  return Object.freeze({
    grd: num(v('L1'), 'L1', 'grd'),
    sectorSize: pos(v('L2.size'), 'L2.size', 'sector size'),
    msl: pos(v('L5').msl, 'L5', 'msl'),
    pv: L6.protocol,
    anchorFromHead: an.from === 'continuousHead',
    anchorA: num(an.from === 'continuousHead' ? an.a : an.lastPointA, 'L8.anchor', 'a'),
    anchorB: num(an.from === 'continuousHead' ? an.b : an.lastPointB, 'L8.anchor', 'b'),
    r2Small: r2.small,
    r2Large: r2.large,
    r2StepSct: r2.stepSct,
    sweepMs: pos(v('L8.sweep'), 'L8.sweep', 'period'),
    lingerMs: num(v('L8.linger'), 'L8.linger', 'linger'),
    keepMs: num(keep.keepMs, 'L8.snake', 'keepMs'),
    lbMs: pos(lb.periodMs, 'L9', 'periodMs'),
    lbRows: lb.rows,
    mmMs: pos(mm.periodMs, 'L10', 'periodMs'),
    mmSize: mm.size,
    zSlowMs: pos(v('L11.slow'), 'L11.slow', 'period'),
    zFastMs: pos(v('L11.fast'), 'L11.fast', 'period'),
    zT: num(v('L11.T'), 'L11.T', 'distance'),
    famRound,
    angRound,
    rotRefreshMs: num(rot.refreshMs, 'L48.rot', 'refreshMs'),
    cashKill: cashCode === codes.died,
    quarantineMs: num(v('C_ID_QUARANTINE_MS'), 'C_ID_QUARANTINE_MS', 'quarantine'),
    maxSteps,
  });
}

// The sector offsets (i, j) with i^2 + j^2 <= r2, in the order the view walks them: nearest first, then row-major
// (CHOSEN walk order; SERVER-DESIGN 5.4 "interleaved as the view walks its sectors").
function offsetsFor(r2) {
  const out = [];
  const r = Math.floor(Math.sqrt(r2));
  for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) if (i * i + j * j <= r2) out.push([i, j]);
  out.sort((a, b) => (a[0] * a[0] + a[1] * a[1]) - (b[0] * b[0] + b[1] * b[1]) || a[1] - b[1] || a[0] - b[0]);
  return Object.freeze(out.map((o) => Object.freeze(o)));
}

// The 8-bit wire byte of an angle in [0, 2 pi). An angle that is exactly on the 8-bit grid (a wanted angle from the
// L15 map, a hold lock, a turn that snapped onto its wanted angle) is its own byte; any other angle takes the
// L48.angRound rule. slQuant.rotAng alone misreads 22 of the 256 grid angles by one byte (the division lands a hair
// below the integer before the floor), so the grid test comes first.
function byte8(a, rule) {
  const r = Math.round(a * 256 / PI2) & 255;
  if (r * 2 * Math.PI / 256 === a) return r;
  return slQuant.rotAng(a, rule).raw;
}

function ang8v(raw) {
  return raw * 2 * Math.PI / 256; // game.js:7401
}

// Unsigned LEB128, as slWire writes uv (shared/slWire.js Writer.uv).
function uvBytes(v) {
  const out = [];
  let x = v;
  for (;;) {
    const low = x % 128;
    x = (x - low) / 128;
    if (x === 0) {
      out.push(low);
      return out;
    }
    out.push(low + 128);
  }
}

// The L9 order (sctFamDesc): sct, then the true fam, both descending; equal ones by the lower id (CHOSEN tie break,
// the room's too; invisible on the wire).
function lbCompare(a, b) {
  return b.sct - a.sct || b.fam - a.fam || a.id - b.id;
}

function createView(laws, sim, opts) {
  const o = opts || {};
  const V = viewLaws(laws);
  if (!sim || typeof sim.step !== 'function' || typeof sim.snake !== 'function') throw new TypeError('slView: needs the sim');
  if (!sim.border) throw new Error('slView: the sim needs its border (init and z carry the flux)');
  const grid = sim.grid;
  if (grid.sectorSize !== V.sectorSize || grid.grd !== V.grd) throw new Error('slView: sim grid is not on the L1 and L2 lattice');
  const food = sim.food || null;
  const preys = sim.preys || null;
  const roomMode = o.room === true;
  const cache = createRecordCache(V.pv);
  const OFF_S = offsetsFor(V.r2Small);
  const OFF_L = offsetsFor(V.r2Large);
  const perAxis = grid.perAxis;
  const startMs = o.startMs === undefined ? sim.nowMs() : o.startMs;
  if (typeof startMs !== 'number' || !Number.isFinite(startMs)) throw new TypeError('slView: startMs must be finite');

  // the view's own clocks when the room does not run them (SERVER-DESIGN 5.1 accumulators: the first tick at or after
  // due fires, then due += period); L8.sweep is one room clock (SERVER-DESIGN 5.1)
  const clock = {
    lb: startMs + V.lbMs,
    mm: startMs + V.mmMs,
    zSlow: startMs + V.zSlowMs,
    zFast: startMs + V.zFastMs,
    sweep: startMs + V.sweepMs,
  };
  const known = new Map(); // snake id -> view state (vs)
  const endedAt = new Map(); // snake id -> ms it ended (C_ID_QUARANTINE_MS)
  const seats = [];
  let groups = []; // tick groups not yet pruned
  let lastTick = sim.tick();
  let assembleStamp = 0;
  let preyIndexTick = -1;
  const preyIndex = new Map(); // sector -> prey list, rebuilt once per sim tick when a seat asks
  const st = { ticks: 0, records: 0, bytes: 0, joins: 0, adds: 0, removes: 0, dumps: 0, sweeps: 0, resyncs: 0, mmM: 0,
    mmV: 0, locks: 0, cashouts: 0, staleSeats: 0, staleCollects: 0 };

  // ---------------------------------------------------------------- snakes the view knows

  function register(s) {
    let vs = known.get(s.id);
    if (vs && vs.s === s) return vs;
    vs = {
      id: s.id,
      s,
      // L48.rot: the bytes of the snake's last rotation record (as if one went out when the view first saw it)
      a8: byte8(s.ang, V.angRound),
      w8: byte8(s.wang, V.angRound),
      s18: slQuant.rotSp(s.sp).raw,
      dir: s.dir,
      lastMs: sim.nowMs(),
      addEv: null,
      addTick: -1,
      holders: 0,
      ended: false,
    };
    known.set(s.id, vs);
    endedAt.delete(s.id);
    return vs;
  }

  function endSnake(vs, now) {
    if (vs.ended) return;
    vs.ended = true;
    endedAt.set(vs.id, now);
  }

  // The snake_add of a snake as it stands now (L8 adds carry the current state), made once per sim tick and shared.
  // snx, sny: the continuous head on the u24 / 5 grid (SERVER-DESIGN 7); body from the pulled body, ending
  // angle-coded with the head point's own iang (slQuant.addBody); fam min(1, fam) by L17.famRound.
  function addEvent(vs) {
    const t = sim.tick();
    if (vs.addEv && vs.addTick === t) return vs.addEv;
    const s = vs.s;
    const pts = s.pts;
    const n = pts.length;
    const body = new Array(n);
    for (let i = 0; i < n; i++) body[i] = { x: pts[i].xx, y: pts[i].yy };
    // The client rebuilds the add's last point one msl step along the head's iang from the point before it, and every
    // later move steps from there. The server's head is exactly that step from the point before it (chainPull never
    // moves the newest three points) except while the head is the absolute first point (L48.abs, integers: up to 0.5
    // off the step). Then the point before it is sent where the step back from the head lands, so the client's last
    // point is the server's head within the body grid (0.25), not 0.75 off for the rest of the life (found by T10).
    const head = pts[n - 1];
    const before = pts[n - 2];
    const hs = slCore.headStep(before.xx, before.yy, head.iang, V.msl);
    if (hs[0] !== head.xx || hs[1] !== head.yy) {
      const a = head.iang * slCore.K64A;
      body[n - 2] = { x: head.xx - Math.cos(a) * V.msl, y: head.yy - Math.sin(a) * V.msl };
    }
    const b = slQuant.addBody(body, V.msl, head.iang);
    vs.addEv = {
      type: 'snake_add',
      id: s.id,
      ang: slQuant.ang24(s.ang).v,
      wang: slQuant.ang24(s.wang).v,
      sp: slQuant.sp1000(s.sp).v,
      fam: slQuant.fam24(s.fam, V.famRound).v,
      cv: s.cv,
      snx: slQuant.pos5(slSnake.headX(s)).v,
      sny: slQuant.pos5(slSnake.headY(s)).v,
      nick: s.nick,
      raw: { pts: b.raw },
    };
    vs.addTick = t;
    return vs.addEv;
  }

  // ---------------------------------------------------------------- one tick's shared records

  // L48.rot for one update: a record when the wanted byte or dir (dir + wang) or the speed byte (sp) changed since the
  // snake's last rotation record, carrying ang while the snake turns or when its byte changed; otherwise ang alone
  // once refreshMs passed since the last record and the ang byte changed since it. A hold lock (the room's lock
  // record, SERVER-DESIGN 15.3) is that update's record, with sp added when the speed byte changed. Every record is
  // one of the seven legal field sets and dir is the sim's 1 or 2. Returns the event or null; u gets the full dir and
  // wang for seats that still need them (rotFor).
  function rotation(vs, rec, now, u, lock) {
    const s = vs.s;
    const a8 = byte8(s.ang, V.angRound);
    const w8 = byte8(s.wang, V.angRound);
    const s18 = slQuant.rotSp(s.sp).raw;
    const sp = s18 !== vs.s18;
    if (lock) {
      const lw = byte8(slQuant.wrapAngle(lock.wang), V.angRound);
      const ev = { type: 'snake_rot', id: s.id, dir: lock.dir, ang: lock.ang, wang: lock.wang };
      if (sp) ev.sp = s18 / 18;
      u.dir = lock.dir;
      u.w8 = lw;
      vs.a8 = byte8(slQuant.wrapAngle(lock.ang), V.angRound);
      vs.w8 = lw;
      vs.s18 = s18;
      vs.dir = lock.dir;
      vs.lastMs = now;
      st.locks++;
      return ev;
    }
    const dir = s.dir;
    u.dir = dir;
    u.w8 = w8;
    const dw = w8 !== vs.w8 || dir !== vs.dir;
    let withAng;
    if (dw || sp) withAng = rec.turning || a8 !== vs.a8;
    else withAng = a8 !== vs.a8 && now - vs.lastMs >= V.rotRefreshMs;
    if (!dw && !sp && !withAng) return null;
    const ev = { type: 'snake_rot', id: s.id };
    if (dw) ev.dir = dir;
    if (withAng) ev.ang = ang8v(a8);
    if (dw) ev.wang = ang8v(w8);
    if (sp) ev.sp = s18 / 18; // game.js:7405
    vs.a8 = a8;
    vs.w8 = w8;
    vs.s18 = s18;
    vs.dir = dir;
    vs.lastMs = now;
    return ev;
  }

  // L48.move: grow n / +, plain g / =; absolute (+, =) only for the first point after spawn (L48.abs, the sim's
  // rec.abs, integers stored back in the sim); otherwise the angle form iff the point's iang differs from the
  // previous head point's (the client's last point), else the short form.
  function moveEvent(vs, rec) {
    const s = vs.s;
    if (rec.moves !== 1) throw new Error('slView: snake ' + s.id + ' added ' + rec.moves + ' points in one update');
    const ev = { type: 'snake_move', id: s.id, cmd: rec.grow ? (rec.abs ? '+' : 'n') : (rec.abs ? '=' : 'g') };
    if (rec.abs) {
      ev.iang = rec.iang;
      ev.xx = rec.xx;
      ev.yy = rec.yy;
    } else {
      const prev = s.pts[s.pts.length - 2];
      if (rec.iang !== prev.iang) ev.iang = rec.iang;
    }
    if (rec.grow) ev.fam = slQuant.fam24(rec.fam, V.famRound).v;
    return ev;
  }

  // L10 raster: a pixel lit where a pulled body point of any snake lies, pixel = floor((size - 1) / 2 x (1 + (x - grd)
  // / flux)) with the current flux; a point mapping outside the image (a tail past a shrinking border) lights nothing.
  function raster(flux) {
    const N = V.mmSize;
    const half = (N - 1) / 2;
    const bits = new Uint8Array(N * N);
    sim.forEachSnake((s) => {
      const pts = s.pts;
      for (let i = 0; i < pts.length; i++) {
        const px = Math.floor(half * (1 + (pts[i].xx - V.grd) / flux));
        const py = Math.floor(half * (1 + (pts[i].yy - V.grd) / flux));
        if (px >= 0 && px < N && py >= 0 && py < N) bits[py * N + px] = 1;
      }
    });
    return { bits, m: null, v: new Map() };
  }

  // Cells of a bit image in their backward scan order (shared/slWire.js putCells: from (N - 1, N - 1), x going down).
  function cellsOf(bits, other) {
    const N = V.mmSize;
    const out = [];
    for (let y = N - 1; y >= 0; y--) {
      for (let x = N - 1; x >= 0; x--) {
        const k = y * N + x;
        if (other ? bits[k] !== other[k] : bits[k] === 1) out.push([x, y]);
      }
    }
    return out;
  }

  function mEvent(img) {
    if (!img.m) img.m = { type: 'minimap', cmd: 'M', raw: { size: V.mmSize }, size: V.mmSize, pixels: cellsOf(img.bits, null) };
    return img.m;
  }

  // L10 firstFull, L10.mv: the full image to a seat with none yet; else the full image or the XOR against the image the
  // seat holds, whichever record is smaller (equal: the full one). Shared per (previous, new) pair. A V carries its
  // M form as `full` (the room's queue coalesces a missed V into an M, SERVER-DESIGN 9.1).
  function minimapFor(prev, img) {
    const m = mEvent(img);
    if (prev === null) return m;
    let ev = img.v.get(prev);
    if (ev === undefined) {
      const x = { type: 'minimap', cmd: 'V', size: V.mmSize, toggles: cellsOf(img.bits, prev.bits), full: m };
      ev = cache.recordBytes(x).length < cache.recordBytes(m).length ? x : m;
      img.v.set(prev, ev);
    }
    return ev;
  }

  // L9: every live snake in the L9 order (C_LB_BOTS: bots included in rank and count); the room passes the order it
  // made at its L9 step. Rows are the top lbRows, rank and myPos per seat.
  function leaderboard(board) {
    let order;
    let count;
    if (board) {
      order = board.order;
      count = board.count;
    } else {
      order = [];
      sim.forEachSnake((s) => order.push({ id: s.id, sct: s.pts.length, fam: s.fam, nick: s.nick, cv: s.cv }));
      order.sort(lbCompare);
      count = order.length;
    }
    const n = Math.min(V.lbRows, order.length);
    const rows = new Array(n);
    for (let i = 0; i < n; i++) {
      const r = order[i];
      rows[i] = { sct: r.sct, fam: slQuant.fam24(r.fam, V.famRound).v, raw: { cv: r.cv }, nick: r.nick };
    }
    const rankOf = new Map();
    for (let i = 0; i < order.length; i++) rankOf.set(order[i].id, i + 1);
    const base = { type: 'leaderboard', myPos: 0, rank: 0, count, rows };
    const rec = cache.recordBytes(base);
    // the per-seat fields lead the record (SERVER-DESIGN 8.3): [type][uv myPos][uv rank][shared tail]
    return { rows, rankOf, count, head: rec[0], tail: rec.subarray(3), topN: n };
  }

  // The rank a snake had when it ended (L9 after the own death: rank stays the value it had then, 13 of 13 sockets with
  // two or more leaderboards after v; T8 check on S1+S2+S3): 1 + the live snakes ahead of it in the L9 order.
  function rankAt(sct, fam, id) {
    let r = 1;
    const me = { sct, fam, id };
    sim.forEachSnake((s) => {
      if (lbCompare({ sct: s.pts.length, fam: s.fam, id: s.id }, me) < 0) r++;
    });
    return r;
  }

  function fire(name, now) {
    if (now < clock[name]) return false;
    const period = name === 'lb' ? V.lbMs : name === 'mm' ? V.mmMs : name === 'zSlow' ? V.zSlowMs
      : name === 'zFast' ? V.zFastMs : V.sweepMs;
    while (clock[name] <= now) clock[name] += period;
    return true;
  }

  // One sim step's shared records. frame (room mode): { clocks: { lb, mm, zSlow, zFast, sweep }, board, locks }.
  function tick(log, frame) {
    if (!log || log.tick !== lastTick + 1 || log.tick !== sim.tick()) {
      throw new Error('slView: tick() must follow every sim.step() in order (expected tick ' + (lastTick + 1) + ')');
    }
    const f = frame || null;
    if (roomMode && !(f && f.clocks)) throw new Error('slView: in room mode every step needs its frame clocks');
    lastTick = log.tick;
    st.ticks++;
    const now = sim.nowMs();
    const g = {
      tick: log.tick,
      nowMs: now,
      flux: sim.flux(),
      upd: [],
      ends: [],
      foodAdds: food ? food.tick.adds.slice() : [],
      preyMoves: preys ? preys.tick.moves.slice() : [],
      preyRemoves: preys ? preys.tick.removes.slice() : [],
      eats: [],
      kills: null,
      lb: null,
      mm: null,
      zSlow: false,
      zFast: false,
      sweep: false,
    };
    let locks = null;
    if (f && Array.isArray(f.locks) && f.locks.length) {
      locks = new Map();
      for (const ev of f.locks) locks.set(ev.id, ev);
    }

    // per updated snake: h, r, rotation, move (each sim snake owns its update record object, so a record is matched to
    // its snake even when the snake left the sim later in this step)
    for (let i = 0; i < log.updates.length; i++) {
      const rec = log.updates[i];
      const vs = known.get(rec.id);
      if (!vs || vs.ended || vs.s.rec !== rec) {
        const s = sim.snake(rec.id);
        // first seen now: its state is the post-update state and no seat holds it yet (or it spawned and left in this
        // step before the view saw it: no seat ever held it)
        if (s && s.rec === rec) register(s);
        continue;
      }
      const u = { id: rec.id, h: null, tails: null, rot: null, move: null, dir: 0, w8: 0, rotNoDw: null, rotDw: null };
      if (rec.h) u.h = { type: 'snake_fam', id: rec.id, fam: slQuant.fam24(rec.hFam, V.famRound).v };
      if (rec.tails.length) {
        u.tails = [];
        for (let k = 0; k < rec.tails.length; k++) {
          u.tails.push({ type: 'snake_tail', id: rec.id, fam: slQuant.fam24(rec.tails[k], V.famRound).v });
        }
      }
      u.rot = rotation(vs, rec, now, u, locks ? locks.get(rec.id) : undefined);
      if (rec.move) u.move = moveEvent(vs, rec);
      g.upd.push(u);
    }

    // the ends: deaths in processing order (L41, L50; kill credit L40), then snakes the room took out with no death
    // record (a cash-out, C_CASHOUT_CODE; a leave)
    const died = new Set();
    for (let i = 0; i < log.deaths.length; i++) {
      const d = log.deaths[i];
      died.add(d.id);
      const vs = known.get(d.id);
      if (vs) endSnake(vs, now);
      else endedAt.set(d.id, now);
      const rm = { type: 'snake_remove', id: d.id, kill: true };
      g.ends.push({ id: d.id, cash: false, x: d.x, y: d.y, rank: rankAt(d.sct, d.fam, d.id), rm, rmOwn: rm });
      if (d.killer) {
        const k = known.get(d.killer);
        const ks = k ? k.s : sim.snake(d.killer);
        if (ks) {
          if (g.kills === null) g.kills = new Map();
          g.kills.set(d.killer, ks.kills);
        }
      }
    }
    for (const vs of known.values()) {
      if (vs.ended || died.has(vs.id) || sim.snake(vs.id) === vs.s) continue;
      endSnake(vs, now);
      const s = vs.s;
      g.ends.push({ id: vs.id, cash: true, x: slSnake.headX(s), y: slSnake.headY(s),
        rank: rankAt(s.pts.length, s.fam, vs.id),
        rm: { type: 'snake_remove', id: vs.id, kill: V.cashKill },
        rmOwn: { type: 'snake_remove', id: vs.id, kill: true } });
      st.cashouts++;
    }

    // eats: per eater in processing order, its foods then its prey (L48.order foodEat, preyEat); eats go last
    const fe = food ? food.tick.eats : [];
    const pe = preys ? preys.tick.eats : [];
    let fi = 0;
    let pi = 0;
    for (let i = 0; i < log.updates.length; i++) {
      const id = log.updates[i].id;
      while (fi < fe.length && fe[fi].eater === id) {
        g.eats.push({ food: fe[fi].food, prey: 0, ev: fe[fi].ev });
        fi++;
      }
      while (pi < pe.length && pe[pi].eater === id) {
        g.eats.push({ food: null, prey: pe[pi].id, ev: pe[pi].ev });
        pi++;
      }
    }
    for (; fi < fe.length; fi++) g.eats.push({ food: fe[fi].food, prey: 0, ev: fe[fi].ev });
    for (; pi < pe.length; pi++) g.eats.push({ food: null, prey: pe[pi].id, ev: pe[pi].ev });

    // the clocks: the room's (room mode) or the view's own
    const c = f && f.clocks ? f.clocks : null;
    if (c ? c.lb : fire('lb', now)) g.lb = leaderboard(f && f.board ? f.board : null);
    if (c ? c.mm : fire('mm', now)) g.mm = raster(g.flux);
    g.zSlow = c ? !!c.zSlow : fire('zSlow', now);
    g.zFast = c ? !!c.zFast : fire('zFast', now);
    g.sweep = c ? !!c.sweep : fire('sweep', now);
    groups.push(g);
    if (roomMode) prune();
    return g;
  }

  // Room mode: a wake runs at most C_MAX_STEPS steps and the room finishes a wake's seat part before the next wake's
  // first step, so a group older than twice that is never asked for again.
  function prune() {
    const keep = lastTick - 2 * V.maxSteps;
    let k = 0;
    while (k < groups.length && groups[k].tick <= keep) k++;
    if (k) {
      groups = groups.slice(k);
      housekeeping();
    }
  }

  function housekeeping() {
    const now = sim.nowMs();
    // Room mode: the room collects every open seat once per wake and has no leave call, so a seat with no collect for
    // twice the pruning window has gone (CHOSEN); letting it go frees the snakes it held.
    if (roomMode) {
      const stale = lastTick - 4 * V.maxSteps;
      for (const seat of seats.slice()) {
        if (seat.lastTick < stale) {
          leave(seat);
          st.staleSeats++;
        }
      }
    }
    for (const [id, vs] of known) if (vs.ended && vs.holders <= 0) known.delete(id);
    for (const [id, t] of endedAt) if (now - t >= V.quarantineMs && !known.has(id)) endedAt.delete(id);
  }

  // ---------------------------------------------------------------- seats

  function push(out, tickNo, ev, own) {
    const rec = cache.recordBytes(ev, own);
    out.push({ tick: tickNo, type: ev.type, ev, rec, own: own === true });
    st.records++;
    st.bytes += rec.length;
  }

  function pushLb(out, tickNo, lb, myPos, rank) {
    const a = uvBytes(myPos);
    const b = uvBytes(rank);
    const rec = new Uint8Array(1 + a.length + b.length + lb.tail.length);
    rec[0] = lb.head;
    rec.set(a, 1);
    rec.set(b, 1 + a.length);
    rec.set(lb.tail, 1 + a.length + b.length);
    const ev = { type: 'leaderboard', myPos, rank, count: lb.count, rows: lb.rows };
    out.push({ tick: tickNo, type: ev.type, ev, rec, own: false });
    st.records++;
    st.bytes += rec.length;
  }

  function hold(seat, vs, stamp) {
    seat.holds.set(vs.id, { added: stamp, seen: stamp, unseenSince: -1, synced: false });
    vs.holders++;
  }

  function release(seat, id) {
    if (!seat.holds.delete(id)) return;
    const vs = known.get(id);
    if (vs) vs.holders--;
  }

  function ownSnake(seat) {
    if (seat.gone) return null;
    const s = sim.snake(seat.ownId);
    const vs = known.get(seat.ownId);
    return s && vs && vs.s === s ? s : null;
  }

  // L8 anchor: the continuous head (or the last point) plus a + b sp along the heading (ang, not wang).
  function anchorSector(s) {
    const last = s.pts[s.pts.length - 1];
    const x0 = V.anchorFromHead ? slSnake.headX(s) : last.xx;
    const y0 = V.anchorFromHead ? slSnake.headY(s) : last.yy;
    const k = V.anchorA + V.anchorB * s.sp;
    return grid.sectorIndex(grid.sectorOf(x0 + k * Math.cos(s.ang)), grid.sectorOf(y0 + k * Math.sin(s.ang)));
  }

  // L8.R2 at a recompute: the set of sectors (i, j) around the anchor sector with i^2 + j^2 <= R2, R2 large iff the
  // own sct is at least stepSct NOW (L8.R2.shrink: back to small when it shrank; L8.R2.high: no further step); sct
  // null keeps the seat's R2 (a frozen anchor). Sectors leaving the set start lingering; sectors entering it that the
  // seat did not keep are new (dumped in this assemble).
  function recompute(seat, sct, asi, now) {
    seat.anchor = asi;
    if (sct !== null) seat.r2 = sct >= V.r2StepSct ? V.r2Large : V.r2Small;
    const offs = seat.r2 === V.r2Large ? OFF_L : OFF_S;
    const ax = grid.sectorX(asi);
    const ay = grid.sectorY(asi);
    const stamp = ++assembleStamp;
    seat.setList.length = 0;
    for (let i = 0; i < offs.length; i++) {
      const sx = ax + offs[i][0];
      const sy = ay + offs[i][1];
      if (sx < 0 || sy < 0 || sx >= perAxis || sy >= perAxis) continue;
      const si = grid.sectorIndex(sx, sy);
      seat.setList.push(si);
      let e = seat.kept.get(si);
      if (!e) {
        e = { inSet: true, outSince: 0, stamp };
        seat.kept.set(si, e);
        seat.dumped.add(si);
      } else {
        e.inSet = true;
        e.stamp = stamp;
      }
    }
    for (const e of seat.kept.values()) {
      if (e.inSet && e.stamp !== stamp) {
        e.inSet = false;
        e.outSince = now;
      }
    }
  }

  function preysBySector() {
    const t = sim.tick();
    if (preyIndexTick === t) return preyIndex;
    preyIndex.clear();
    if (preys) {
      preys.forEachPrey((p) => {
        const si = grid.sectorAt(p.x, p.y);
        let l = preyIndex.get(si);
        if (!l) {
          l = [];
          preyIndex.set(si, l);
        }
        l.push(p);
      });
    }
    preyIndexTick = t;
    return preyIndex;
  }

  // The adds walk (L8.adds, L8.snakeAdd, prey by sector): kept sectors in walk order (the set nearest first, then the
  // lingering ones); per sector its F dump when it is new in this assemble and holds food (none when empty), the
  // snakes with a pulled point in it the seat does not hold yet, the prey in it the seat does not hold yet.
  let walkSeat = null;
  let walkOut = null;
  let walkStamp = 0;
  function visitAdd(sid) {
    const seat = walkSeat;
    const h = seat.holds.get(sid);
    if (h) {
      h.seen = walkStamp;
      return;
    }
    const s = sim.snake(sid);
    if (!s) return;
    const vs = register(s);
    push(walkOut, sim.tick(), addEvent(vs), false);
    hold(seat, vs, seat.stamp);
    st.adds++;
  }

  function markSeen(sid) {
    const h = walkSeat.holds.get(sid);
    if (h) h.seen = walkStamp;
  }

  function walkSector(seat, out, si, pIndex) {
    if (seat.dumped.has(si) && food) {
      const ev = food.dumpEvent(si);
      if (ev) {
        push(out, sim.tick(), ev, false);
        st.dumps++;
      }
    }
    walkSeat = seat;
    walkOut = out;
    grid.forEachSnakeIn(si, visitAdd);
    walkSeat = null;
    walkOut = null;
    const pl = pIndex.get(si);
    if (pl) {
      for (let k = 0; k < pl.length; k++) {
        const p = pl[k];
        if (seat.prey.has(p.id)) continue;
        push(out, sim.tick(), preys.addEvent(p), false);
        seat.prey.set(p.id, seat.stamp);
        st.adds++;
      }
    }
  }

  function walkAdds(seat, out) {
    const pIndex = preysBySector();
    walkStamp = seat.stamp;
    for (let i = 0; i < seat.setList.length; i++) walkSector(seat, out, seat.setList[i], pIndex);
    for (const [si, e] of seat.kept) if (!e.inSet) walkSector(seat, out, si, pIndex);
  }

  function seatOf(ownId) {
    const seat = {
      ownId,
      gone: false, // own snake ended (its dead went out); the anchor freezes, the minimap stops
      frozenRank: 0,
      fx: 0, // where the own head ended (L11 fast checks go on after the own death)
      fy: 0,
      anchor: -1,
      r2: V.r2Small,
      rebuild: false, // the next assemble builds the set from scratch (after forget)
      setList: [],
      kept: new Map(), // sector -> { inSet, outSince, stamp }
      dumped: new Set(), // sectors new in the current assemble (their F carries the state now)
      holds: new Map(), // snake id -> { added, seen, unseenSince, synced }
      prey: new Map(), // prey id -> stamp added
      stamp: 0,
      fromTick: sim.tick(),
      lastTick: sim.tick(),
      zDone: false,
      lastFlux: 0,
      lastMap: null,
      memDir: 0, // own dir and wang byte the client holds (echoes and own rotation records)
      memW8: -1,
      left: false,
      ownEcho: null,
      pong: null,
    };
    seat.ownEcho = (dir, wang) => ownEcho(seat, dir, wang);
    seat.pong = () => pongEntry(seat);
    return seat;
  }

  // The join bundle (SERVER-DESIGN 5.4, C18): init (L6 forms, the current integer flux), the own snake_add (their
  // client takes the first snake_add after init as its own), then the whole spawn set (L8.adds spawnSet whole) as the
  // view walks it. No leaderboard, no minimap, no z: those wait for the room clocks.
  function join(ownId) {
    const s = sim.snake(ownId);
    if (!s) throw new Error('slView: join needs a live own snake (spawn it first)');
    for (const t of seats) if (!t.left && t.ownId === ownId && !t.gone) throw new Error('slView: snake ' + ownId + ' already has a seat');
    const seat = seatOf(ownId);
    seat.stamp = ++assembleStamp;
    const out = [];
    const vs = register(s);
    push(out, sim.tick(), initFields(laws, sim.flux()), false);
    push(out, sim.tick(), addEvent(vs), false);
    hold(seat, vs, seat.stamp);
    recompute(seat, s.pts.length, anchorSector(s), sim.nowMs());
    walkAdds(seat, out);
    seat.dumped.clear();
    seats.push(seat);
    st.joins++;
    return { seat, entries: out };
  }

  // The client now holds this own dir and wang byte (an echo on arrival, SERVER-DESIGN 5.2 item 3): a tick record
  // carrying the same dir and wang to this seat drops them.
  function noteOwnRot(seat, dir, w8) {
    seat.memDir = dir;
    seat.memW8 = w8;
    const h = seat.holds.get(seat.ownId);
    if (h) h.synced = true;
  }

  // The own wanted-angle echo as an entry (the core API; the room makes its own and calls noteOwnRot).
  function ownEcho(seat, dir, wang) {
    if (dir !== 1 && dir !== 2) throw new RangeError('slView: echo dir must be 1 or 2');
    const w8 = byte8(slQuant.wrapAngle(wang), V.angRound);
    noteOwnRot(seat, dir, w8);
    const out = [];
    push(out, sim.tick(), { type: 'snake_rot', id: seat.ownId, dir, wang: ang8v(w8) }, true);
    return out[0];
  }

  function pongEntry() {
    const out = [];
    push(out, sim.tick(), { type: 'pong' }, false);
    return out[0];
  }

  // The rotation record of update u as this seat gets it. A seat that holds the snake but never got its dir (their
  // client snaps ang to wang while dir is absent, slLoop.js:158-174) gets dir and wang added to the first record (a
  // legal set; held bytes repeat in their stream too, L48 "2323 of 230287"). The own seat drops dir and wang that
  // equal what its client holds from an echo; with nothing left, no record.
  function rotFor(seat, h, u, own) {
    let ev = u.rot;
    let dw = ev.dir !== undefined;
    if (!h.synced && !dw) {
      if (!u.rotDw) {
        u.rotDw = { type: 'snake_rot', id: u.id, dir: u.dir };
        if (ev.ang !== undefined) u.rotDw.ang = ev.ang;
        u.rotDw.wang = ang8v(u.w8);
        if (ev.sp !== undefined) u.rotDw.sp = ev.sp;
      }
      ev = u.rotDw;
      dw = true;
    } else if (own && dw && h.synced && seat.memDir === u.dir && seat.memW8 === u.w8) {
      if (ev.ang === undefined && ev.sp === undefined) return null;
      if (!u.rotNoDw) {
        u.rotNoDw = { type: 'snake_rot', id: u.id };
        if (ev.ang !== undefined) u.rotNoDw.ang = ev.ang;
        if (ev.sp !== undefined) u.rotNoDw.sp = ev.sp;
      }
      ev = u.rotNoDw;
      dw = false;
    }
    if (dw) {
      h.synced = true;
      if (own) {
        seat.memDir = u.dir;
        seat.memW8 = u.w8;
      }
    }
    return ev;
  }

  function sectorLive(seat, si) {
    return seat.kept.has(si) && !seat.dumped.has(si);
  }

  // L11 cadence: the first check after the join always sends z; later checks only when the integer flux changed.
  function zCheck(seat, out, g) {
    if (seat.zDone && g.flux === seat.lastFlux) return;
    seat.zDone = true;
    seat.lastFlux = g.flux;
    push(out, g.tick, { type: 'flux', fluxGrd: g.flux }, false);
  }

  // L11 fast checks apply while the own head (once the own snake ended: where it ended) is within L11.T of the border.
  function nearBorder(seat, flux) {
    let x;
    let y;
    const s = ownSnake(seat);
    if (s) {
      x = slSnake.headX(s);
      y = slSnake.headY(s);
    } else {
      x = seat.fx;
      y = seat.fy;
    }
    const dx = x - V.grd;
    const dy = y - V.grd;
    return flux - Math.sqrt(dx * dx + dy * dy) <= V.zT;
  }

  // Interest at the wake end (L8): the anchor recompute (live own snake only; the anchor freezes when it ends), the
  // sweep, snake retention, prey removals. Appends the removal records; the adds walk follows.
  function interest(seat, out, ended, now, sweepAt) {
    const s = ownSnake(seat);
    if (seat.rebuild) {
      seat.rebuild = false;
      const asi = s ? anchorSector(s) : seat.anchor;
      if (asi >= 0) recompute(seat, s ? s.pts.length : null, asi, now);
    } else if (s) {
      const asi = anchorSector(s);
      if (asi !== seat.anchor) recompute(seat, s.pts.length, asi, now);
    }
    // the sweep (L8.sweep, L8.linger; L8.emptySector removeOnSweep): a sector out of the set this long goes
    if (sweepAt !== null) {
      st.sweeps++;
      for (const [si, e] of seat.kept) {
        if (e.inSet || sweepAt - e.outSince < V.lingerMs) continue;
        seat.kept.delete(si);
        push(out, sim.tick(), { type: 'sector_remove', sx: grid.sectorX(si), sy: grid.sectorY(si) }, false);
        st.removes++;
      }
    }
    // snakes (L8.snakeAdd, L8.snake): seen = a pulled point in a kept sector now
    const stamp = seat.stamp;
    walkStamp = stamp;
    walkSeat = seat;
    for (const si of seat.kept.keys()) grid.forEachSnakeIn(si, markSeen);
    walkSeat = null;
    for (const [id, h] of seat.holds) {
      const vs = known.get(id);
      // a snake that ended goes with its end record (this wake's, or the next step's for one taken out since)
      if (!vs || vs.ended || sim.snake(id) !== vs.s || ended.has(id)) continue;
      if (h.seen === stamp || id === seat.ownId) {
        h.unseenSince = -1;
        continue;
      }
      if (h.unseenSince < 0) h.unseenSince = now;
      if (now - h.unseenSince >= V.keepMs) {
        push(out, sim.tick(), { type: 'snake_remove', id, kill: false }, false);
        release(seat, id);
        st.removes++;
      }
    }
    // prey: held while it lies in a kept sector (SERVER-DESIGN 8.2, C21)
    for (const id of Array.from(seat.prey.keys())) {
      const p = preys ? preys.get(id) : null;
      if (!p) {
        if (ended.has(-id - 1)) continue; // its eat or removal record in this wake removes it
      } else if (seat.kept.has(grid.sectorAt(p.x, p.y))) {
        continue;
      }
      push(out, sim.tick(), { type: 'prey_remove', id }, false);
      seat.prey.delete(id);
      st.removes++;
    }
  }

  // One wake for one seat (SERVER-DESIGN 5.3 step 9): interest changes, then the records of every tick since the
  // seat's last assemble.
  function assemble(seat) {
    if (seat.left) throw new Error('slView: that seat left');
    const out = [];
    const now = sim.nowMs();
    seat.stamp = ++assembleStamp;
    seat.dumped.clear();
    // the ticks this seat has not had, what ended in them, the last sweep among them
    const ended = new Set();
    let sweepAt = null;
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (g.tick <= seat.lastTick || g.tick <= seat.fromTick) continue;
      for (let k = 0; k < g.ends.length; k++) ended.add(g.ends[k].id);
      for (let k = 0; k < g.eats.length; k++) if (g.eats[k].prey) ended.add(-g.eats[k].prey - 1);
      for (let k = 0; k < g.preyRemoves.length; k++) ended.add(-g.preyRemoves[k].id - 1);
      if (g.sweep) sweepAt = g.nowMs;
    }
    interest(seat, out, ended, now, sweepAt);
    walkAdds(seat, out);
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (g.tick <= seat.lastTick || g.tick <= seat.fromTick) continue;
      deliver(seat, out, g);
    }
    seat.lastTick = sim.tick();
    seat.dumped.clear();
    return out;
  }

  function deliver(seat, out, g) {
    const stamp = seat.stamp;
    const t = g.tick;
    // updates: h, r, rotation, move per held snake (not one added in this assemble)
    for (let i = 0; i < g.upd.length; i++) {
      const u = g.upd[i];
      const h = seat.holds.get(u.id);
      if (!h || h.added === stamp) continue;
      const own = u.id === seat.ownId;
      if (u.h) push(out, t, u.h, false);
      if (u.tails) for (let k = 0; k < u.tails.length; k++) push(out, t, u.tails[k], false);
      if (u.rot) {
        const ev = rotFor(seat, h, u, own);
        if (ev) push(out, t, ev, own);
      }
      if (u.move) push(out, t, u.move, own);
    }
    // ends: own dead code 0 then own removal code 1 (L41, a cash-out too, SERVER-DESIGN 15.3); other holders removal
    // code 1 for a death (L50), C_CASHOUT_CODE for a cash-out
    for (let i = 0; i < g.ends.length; i++) {
      const d = g.ends[i];
      if (!seat.holds.has(d.id)) continue;
      if (d.id === seat.ownId) {
        push(out, t, { type: 'dead', code: DEAD_CODE }, false);
        push(out, t, d.rmOwn, false);
        seat.gone = true;
        seat.fx = d.x;
        seat.fy = d.y;
        seat.frozenRank = d.rank;
      } else {
        push(out, t, d.rm, false);
      }
      release(seat, d.id);
    }
    // food adds (L25: natural f, drops b; the death drops follow the deaths), by kept sector
    for (let i = 0; i < g.foodAdds.length; i++) {
      const f = g.foodAdds[i];
      if (sectorLive(seat, f.si)) push(out, t, food.addEvent(f), false);
    }
    // prey updates and removals (L33, L32.remove) to the seats holding the prey
    for (let i = 0; i < g.preyMoves.length; i++) {
      const ev = g.preyMoves[i];
      const a = seat.prey.get(ev.id);
      if (a !== undefined && a !== stamp) push(out, t, ev, false);
    }
    for (let i = 0; i < g.preyRemoves.length; i++) {
      const r = g.preyRemoves[i];
      if (seat.prey.has(r.id)) {
        push(out, t, r.ev, false);
        seat.prey.delete(r.id);
      }
    }
    // eats last: foods by kept sector, prey by holding
    for (let i = 0; i < g.eats.length; i++) {
      const e = g.eats[i];
      if (e.food) {
        if (sectorLive(seat, e.food.si)) push(out, t, e.ev, false);
      } else if (seat.prey.has(e.prey)) {
        push(out, t, e.ev, false);
        seat.prey.delete(e.prey);
      }
    }
    // leaderboard (L9): myPos 0 and the rank frozen at the end once the own snake ended
    if (g.lb) {
      let myPos = 0;
      let rank = seat.frozenRank;
      if (!seat.gone) {
        const r = g.lb.rankOf.get(seat.ownId);
        if (r !== undefined) {
          rank = r;
          myPos = r <= g.lb.topN ? r : 0;
        }
      }
      pushLb(out, t, g.lb, myPos, rank);
    }
    // minimap (L10, L10.mv): stops once the own dead went out
    if (g.mm && !seat.gone) {
      const ev = minimapFor(seat.lastMap, g.mm);
      if (ev.cmd === 'M') st.mmM++;
      else st.mmV++;
      seat.lastMap = g.mm;
      push(out, t, ev, false);
    }
    // flux (L11): slow slots for every seat, fast checks near the border
    if (g.zSlow || (g.zFast && nearBorder(seat, g.flux))) zCheck(seat, out, g);
    // kill_count (L40): the killer's own seat only
    if (g.kills && !seat.gone && g.kills.has(seat.ownId)) {
      push(out, t, { type: 'kill_count', id: seat.ownId, count: g.kills.get(seat.ownId) }, false);
    }
  }

  // Forget everything the seat's client may hold except its own snake (SERVER-DESIGN 9.3: the queue removes what was
  // delivered or queued); the next assemble re-adds from the anchor as at a join (no init) and sends a full minimap.
  function forget(seat) {
    if (seat.left) throw new Error('slView: that seat left');
    seat.kept.clear();
    for (const id of Array.from(seat.holds.keys())) if (id !== seat.ownId) release(seat, id);
    seat.prey.clear();
    seat.dumped.clear();
    seat.setList.length = 0;
    seat.lastMap = null;
    seat.rebuild = true;
    st.resyncs++;
  }

  // The core resync: removal records for everything the view's mirror holds but the own snake, then forget and the
  // re-adds. The send queue adds removals for what it delivered that is not here.
  function resync(seat) {
    if (seat.left) throw new Error('slView: that seat left');
    const out = [];
    for (const si of seat.kept.keys()) {
      push(out, sim.tick(), { type: 'sector_remove', sx: grid.sectorX(si), sy: grid.sectorY(si) }, false);
    }
    for (const id of seat.holds.keys()) {
      if (id !== seat.ownId) push(out, sim.tick(), { type: 'snake_remove', id, kill: false }, false);
    }
    for (const id of seat.prey.keys()) push(out, sim.tick(), { type: 'prey_remove', id }, false);
    forget(seat);
    const again = assemble(seat);
    for (let i = 0; i < again.length; i++) out.push(again[i]);
    return out;
  }

  function leave(seat) {
    if (seat.left) return;
    seat.left = true;
    for (const id of Array.from(seat.holds.keys())) release(seat, id);
    seat.prey.clear();
    seat.kept.clear();
    const i = seats.indexOf(seat);
    if (i >= 0) seats.splice(i, 1);
  }

  // The core's wake end: the tick records go (room mode prunes by itself).
  function endWake() {
    groups = [];
    cache.clear();
    housekeeping();
  }

  // C_ID_QUARANTINE_MS (SERVER-DESIGN 8.1): an id is free only after the quarantine and when no seat holds it.
  function idBlocked(id) {
    const vs = known.get(id);
    if (vs && vs.holders > 0) return true;
    const t = endedAt.get(id);
    return t !== undefined && sim.nowMs() - t < V.quarantineMs;
  }

  // The seat's mirror of its client (SERVER-DESIGN 8.1), for the send queue and the tests (allocates).
  function mirror(seat) {
    return {
      ownId: seat.ownId,
      gone: seat.gone,
      anchor: seat.anchor,
      r2: seat.r2,
      set: seat.setList.slice(),
      kept: Array.from(seat.kept.keys()),
      lingering: Array.from(seat.kept).filter((e) => !e[1].inSet).map((e) => e[0]),
      snakes: Array.from(seat.holds.keys()),
      prey: Array.from(seat.prey.keys()),
      lastFlux: seat.zDone ? seat.lastFlux : null,
      hasMap: seat.lastMap !== null,
    };
  }

  return {
    V,
    laws,
    sim,
    join,
    tick,
    assemble,
    endWake,
    resync,
    forget,
    leave,
    noteOwnRot,
    idBlocked,
    mirror,
    seats: () => seats.slice(),
    groups: () => groups.length,
    noteStaleCollect: () => {
      st.staleCollects++;
    },
    stats: () => Object.assign({ known: known.size, seats: seats.length }, st),
    minimapFor,
    offsets: (r2) => (r2 === V.r2Large ? OFF_L : r2 === V.r2Small ? OFF_S : offsetsFor(r2)),
  };
}

// ------------------------------------------------------------------ the room's contract (server/sl/slRoom.js)

// One per room: the view in room mode (the room's clocks, L9 order and hold locks come with each step's frame).
function createWorld(laws, sim) {
  const view = createView(laws, sim, { room: true });
  return {
    view,
    afterStep(frame) {
      if (!frame || !frame.log) throw new TypeError('slView: afterStep needs the frame with its step log');
      view.tick(frame.log, frame);
    },
  };
}

function eventsOf(entries) {
  const out = new Array(entries.length);
  for (let i = 0; i < entries.length; i++) out[i] = entries[i].ev;
  return out;
}

// One per seat, at sl:join. join(ctx) gives the join bundle's events, collect(ctx) one wake's events, noteOwnRot an
// echo the room queued, resync() forgets all but the own snake (the next collect re-adds). The view knows the frames
// of every step through world.afterStep, so ctx is read for nothing but checks.
function createSeatView(laws, opts) {
  const o = opts || {};
  const world = o.world;
  if (!world || !world.view || typeof world.afterStep !== 'function') throw new TypeError('slView: createSeatView needs the world');
  const view = world.view;
  if (o.sim && o.sim !== view.sim) throw new Error('slView: the seat view and the world have different sims');
  if (laws && laws !== view.laws) throw new Error('slView: the seat view and the world have different law tables');
  const ownId = o.ownId;
  let seat = null;
  return {
    get seat() {
      return seat;
    },
    join() {
      if (seat) throw new Error('slView: join once per seat view');
      const j = view.join(ownId);
      seat = j.seat;
      return eventsOf(j.entries);
    },
    collect() {
      if (!seat) throw new Error('slView: collect before join');
      if (seat.left) {
        view.noteStaleCollect();
        return [];
      }
      return eventsOf(view.assemble(seat));
    },
    noteOwnRot(r) {
      if (!seat || !r) return;
      if (r.dir !== 1 && r.dir !== 2) throw new RangeError('slView: noteOwnRot dir must be 1 or 2');
      if (!Number.isInteger(r.wangRaw) || r.wangRaw < 0 || r.wangRaw > 255) throw new RangeError('slView: noteOwnRot wangRaw must be a byte');
      view.noteOwnRot(seat, r.dir, r.wangRaw);
    },
    resync() {
      if (seat && !seat.left) view.forget(seat);
    },
    leave() {
      if (seat) view.leave(seat);
    },
    mirror() {
      return seat ? view.mirror(seat) : null;
    },
  };
}

// A seat's bundle from its entries, in order: [version] + records (byte-identical to slWire.encodeBundle of the
// events at the room's pv, slRecordCache).
function bundleOf(entries) {
  const recs = new Array(entries.length);
  for (let i = 0; i < entries.length; i++) recs[i] = entries[i].rec;
  return bundleBytes(recs);
}

module.exports = {
  createView,
  createWorld,
  createSeatView,
  bundleOf,
  viewLaws,
  byte8,
  uvBytes,
  offsetsFor,
  lbCompare,
  VIEW_LAW_IDS,
  VIEW_TABLE_IDS,
  VIEW_RULES_BUILT,
  ORDER_BUILT,
  NEVER_SENT,
  DEAD_CODE,
};
