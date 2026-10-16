'use strict';
// slither.io free room: one snake and its update (SERVER-DESIGN 6.1 and 6.2, task T4).
//
// Pure arithmetic on a snake object owned by slSim. No Math.random, no Date, no io: every random draw comes from the
// sim's named slRng streams ('charge' for the L23 charge size, 'drop' for the L24 drop colour and place), so the same
// seed and inputs give the same snake to the last bit.
//
// Every number is read from the law table by id (snakeLaws below) and every rule form is checked by name, so a table
// that names a form this file does not build is refused at createSim. The few literal numbers left are parts of the
// law formulas as SERVER-LAWS writes them (the 2 in sct - 2, the 8 ms client frame of L14, the 4 of sp / 4 per frame).
//
// One update (SERVER-DESIGN 6.2, one L7 period P), in this order:
//   0 fam record  the fam the stream has not carried yet goes first (L48.hDefer, L48.order)
//   0b boost      in time order inside the update window (the P ms before it): the slot's 253 and 254 records
//      and cost   (L22, L15), a hold's boost end (C_HOLD_BOOST) and the L23 charges: the first at each accepted
//                 press, then one per L23 period on the snake's own clock started at the press (L23.period, L23.form,
//                 L23.low, L23.edges); a drop per charge above L24.Td (L24.*); boostTimeline (task T14b)
//   1 turn rate   per ms toward wang, current sct, the speed before this update's step (L14)
//   2 speed       base from the length at spawn or boost end (the ramp's landing), never on growth (L12); boost
//                 ramp per update (L13.ramp), the first step a fraction by the input arrival offset (L13.first); times
//                 the hold multiplier (Q15)
//   3 steer       every steering record of the window takes effect at its own arrival time inside it, ang turning
//                 per ms between them (task TURNING, 2026-10-11, slither-reference/recordings/TURNING.md)
//   4 travel      the head moves sp (P / 8) / 4 over the window in PIECES straight pieces, each along the ang its
//                 turn ended on (their client turns, then moves sp / 4, every 8 ms frame, SERVER-LAWS units); the
//                 room sends the own point at the end of the piece that reached it (travel, previewPoint)
//   5 points      where that move first reaches msl from the last point: pull the chain BEFORE adding the point (L16),
//                 the point one msl step along the 16-bit angle of the chord to it (slCore.headStep, the client's own
//                 arithmetic), absolute integers for the first point after spawn (L48.abs), a grow keeps the tail when
//                 fam >= 1 (L18, L18.when), else the tail goes
// Step 6 (eating, L31, L18, L34) and the collision test belong to the world half (slSim, task T6).
//
// The body is the client's point object shape ({xx, yy, smu, iang} plus slGrid's gs and gk), tail at index 0, so
// shared/slCore.js chainPull and headStep run on it unchanged. Point objects are made at spawn and on a grow only;
// a plain move reuses the lost tail object for the new head.

const slCore = require('../../shared/slCore.js');
const slQuant = require('./slQuant');
const { assertLawsComplete, assertRulesBuilt } = require('./slLaws');

const PI2 = slCore.PI2;

// The law rows this file reads (the sim adds its own; SIM_LAW_IDS in slSim.js is the union).
const SNAKE_LAW_IDS = Object.freeze([
  'L3', 'L4', 'L5', 'L7', 'L12', 'L13.ramp', 'L13.first', 'L14', 'L15', 'L16', 'L18', 'L18.when', 'L19', 'L20',
  'L21', 'L22', 'L23.period', 'L23.form', 'L23.low', 'L23.edges', 'L24.Td', 'L24.size', 'L24.place',
  'L24.colour.skin', 'L34', 'L48.abs', 'L48.angRound', 'C_HOLD_STEER', 'C_HOLD_BOOST',
]);

// The rule forms this file builds (slLaws.assertRulesBuilt refuses any other name in SNAKE_LAW_IDS).
const SNAKE_RULES_BUILT = Object.freeze([
  'speedBase', 'rampN', 'offsetFraction', 'turnK', 'wangFromByte', 'pullBeforePush', 'famGain', 'lqClampZero',
  'noDecay', 'boostStart', 'charge', 'chargeEdgesCubic', 'dropOnCharge', 'dropByte', 'tailTipDisc', 'skinDropTable',
  'preyGain', 'absFirstPointOnly',
]);

function bad(id, what) {
  throw new Error('slSnake: law ' + id + ' ' + what + '; this build implements only the form SERVER-LAWS states');
}

function num(v, id, what) {
  if (typeof v !== 'number' || !Number.isFinite(v)) bad(id, what + ' is not a finite number');
  return v;
}

// Reads every number the snake update needs, once, and checks the fixed parts of each form against what this file
// builds. Returns a frozen plain object (K) the hot path reads with no table lookups.
function snakeLaws(laws) {
  assertLawsComplete(laws, SNAKE_LAW_IDS);
  assertRulesBuilt(laws, SNAKE_LAW_IDS, SNAKE_RULES_BUILT);
  const v = (id) => laws[id].value;

  const L4 = v('L4');
  const L5 = v('L5');
  const L12 = v('L12');
  if (L12.setAt !== 'spawnAndBoostEnd') bad('L12', 'setAt is not spawnAndBoostEnd');
  const L13 = v('L13.ramp');
  const L13f = v('L13.first');
  const L14 = v('L14');
  if (L14.perMs !== true) bad('L14', 'is not per ms');
  const L15 = v('L15');
  const L18 = v('L18');
  if (v('L18.when') !== 'regularMove') bad('L18.when', 'is not regularMove');
  const L20 = v('L20');
  if (L20.heading !== 'uniform') bad('L20', 'heading is not uniform');
  if (!Number.isInteger(L20.sct) || L20.sct !== L20.points || L20.points < 2) bad('L20', 'sct and points differ');
  const L23p = v('L23.period');
  if (L23p.start !== 'press') bad('L23.period', 'start is not press');
  const L23low = v('L23.low');
  const L23e = v('L23.edges');
  if (!Array.isArray(L23e.lo) || L23e.lo.length !== 3 || !Array.isArray(L23e.hi) || L23e.hi.length !== 3) {
    bad('L23.edges', 'lo and hi are not three coefficients');
  }
  if (L23e.fromSct !== L23low.maxSct) bad('L23.edges', 'fromSct is not L23.low maxSct');
  const angRound = v('L48.angRound');
  if (angRound !== 'floor' && angRound !== 'round') bad('L48.angRound', 'is neither floor nor round');
  const steer = v('C_HOLD_STEER');
  if (steer !== 'locked' && steer !== 'free') bad('C_HOLD_STEER', 'is neither locked nor free');
  const holdBoost = v('C_HOLD_BOOST');
  if (typeof holdBoost.allow !== 'boolean') bad('C_HOLD_BOOST', 'allow is not a boolean');
  const skin = v('L24.colour.skin');
  if (skin.otherwise !== 'cvMod9') bad('L24.colour.skin', 'otherwise is not cvMod9');

  const K = {
    mscps: num(v('L3'), 'L3', 'mscps'),
    nsp1: num(L4.nsp1, 'L4', 'nsp1'),
    nsp2: num(L4.nsp2, 'L4', 'nsp2'),
    nsp3: num(L4.nsp3, 'L4', 'nsp3'),
    spangdv: num(L4.spangdv, 'L4', 'spangdv'),
    mamu: num(L5.mamu, 'L5', 'mamu'),
    cst: num(L5.cst, 'L5', 'cst'),
    msl: num(L5.msl, 'L5', 'msl'),
    P: num(v('L7'), 'L7', 'update period'),
    scDiv: num(L12.scDiv, 'L12', 'scDiv'),
    scCap: num(L12.scCap, 'L12', 'scCap'),
    n0: num(L13.n0, 'L13.ramp', 'n0'),
    perPoint: num(L13.perPoint, 'L13.ramp', 'perPoint'),
    rampDiv: num(L13.div, 'L13.ramp', 'div'),
    downRatio: num(L13.downRatio, 'L13.ramp', 'downRatio'),
    firstPeriodMs: num(L13f.periodMs, 'L13.first', 'periodMs'),
    turnDiv: num(L14.div, 'L14', 'div'),
    turnScCap: num(L14.scCap, 'L14', 'scCap'),
    maxAngle: num(L15.maxAngle, 'L15', 'maxAngle'),
    famK: num(L18.K, 'L18', 'K'),
    famExp: num(L18.exp, 'L18', 'exp'),
    minSct: L20.points,
    spawnFam: num(L20.fam, 'L20', 'fam'),
    spawnGap: num(L20.gap, 'L20', 'gap'),
    spawnSp: num(L20.sp, 'L20', 'sp'),
    boostMinL: num(v('L22').minL, 'L22', 'minL'),
    chargePeriod: num(L23p.periodMs, 'L23.period', 'periodMs'),
    lowMaxSct: num(L23low.maxSct, 'L23.low', 'maxSct'),
    lowLo: num(L23low.lo, 'L23.low', 'lo'),
    lowHi: num(L23low.hi, 'L23.low', 'hi'),
    edgeLo0: num(L23e.lo[0], 'L23.edges', 'lo[0]'),
    edgeLo2: num(L23e.lo[1], 'L23.edges', 'lo[1]'),
    edgeLo3: num(L23e.lo[2], 'L23.edges', 'lo[2]'),
    edgeHi0: num(L23e.hi[0], 'L23.edges', 'hi[0]'),
    edgeHi2: num(L23e.hi[1], 'L23.edges', 'hi[1]'),
    edgeHi3: num(L23e.hi[2], 'L23.edges', 'hi[2]'),
    dropMinL: num(v('L24.Td').minL, 'L24.Td', 'minL'),
    dropAlpha: num(v('L24.size').alpha, 'L24.size', 'alpha'),
    dropBeta: num(v('L24.size').beta, 'L24.size', 'beta'),
    dropRadius: num(v('L24.place').radius, 'L24.place', 'radius'),
    skinDrop: skin,
    preyKp: num(v('L34').Kp, 'L34', 'Kp'),
    angRound,
    holdSteerLocked: steer === 'locked',
    holdBoostAllow: holdBoost.allow,
    smus: slCore.buildSmus(L5.cst),
  };
  if (K.spawnGap !== K.msl) bad('L20', 'gap is not L5 msl');
  // L20 sp 5.79 is the L12 base at the spawn length (nsp1 + nsp2): the two rows must agree.
  if (Math.abs(speedBase(K, K.minSct) - K.spawnSp) > 1e-9) bad('L20', 'sp is not the L12 base at the spawn length');
  return Object.freeze(K);
}

// ------------------------------------------------------------------ the formulas, by law id

// L12 size factor of the speed (the client's sc, game.js:7844), from a length m.
function speedSc(K, m) {
  return Math.min(K.scCap, 1 + (m - 2) / K.scDiv);
}

// L12 normal speed nsp1 + nsp2 sc(m), as a plain double in the client's own order (game.js:7846). At m = 108 this is
// 6.1899999999999995, which their server sent as 6189 (SERVER-LAWS L12 evidence; analysis note "sct 108 came as 6189").
function speedBase(K, m) {
  return K.nsp1 + K.nsp2 * speedSc(K, m);
}

// L13 ramp: updates N_up from the normal speed to nsp3 at the current length; N_down = downRatio N_up.
function rampUp(K, sct) {
  return K.n0 + K.perPoint * (sct - 2) / K.rampDiv;
}

// L13.first: the first ramp step after a 253 or 254 is the step times (press to update ms) / periodMs. Our update
// runs at the start of the tick that applies the input, so press-to-update is the input's arrival offset. Clamped to
// a full step at most (CHOSEN: a step larger than a full one has no evidence).
function firstFraction(K, offsetMs) {
  const f = offsetMs / K.firstPeriodMs;
  return f < 1 ? f : 1;
}

// L14 turn per ms toward wang: (mamu / 8) spang scang(sc'), sc' = min(scCap, 1 + (sct - 2) / div), current sct.
// Written in the client's order (mamu * frames * scang * spang, game.js:4788-4810 via slLoop.js:303).
function turnStep(K, sct, sp, ms) {
  const sc = Math.min(K.turnScCap, 1 + (sct - 2) / K.turnDiv);
  return K.mamu * (ms / 8) * slCore.scangOf(sc) * slCore.spangOf(sp, K.spangdv);
}

// L15 arrow key (252): the wanted angle moves by v ticks at the client rate, mamu v scang spang (game.js:4516, 4531),
// with the client's own size factor (L12 sc). Left lowers wang, right raises it.
function arrowTurn(K, sct, sp, v) {
  return K.mamu * v * slCore.scangOf(speedSc(K, sct)) * slCore.spangOf(sp, K.spangdv);
}

// L18 multiplier (1 - Lq / mscps)^exp, Lq = (floor(100 (sct - 1 + fam)) + 1) / 100, clamped at 0 once Lq >= mscps
// (L19). The same multiplier scales every L23 charge (from the fam before it) and the L34 prey value.
function famMult(K, sct, fam) {
  const Lq = (Math.floor(100 * (sct - 1 + fam)) + 1) / 100;
  if (Lq >= K.mscps) return 0;
  return Math.pow(1 - Lq / K.mscps, K.famExp);
}

// L18 value of one food of rad byte b at the given length.
function foodGain(K, sct, fam, b) {
  return K.famK * (b * b) * famMult(K, sct, fam);
}

// L34 value of one prey of radius rad: the L18 form with Kp per rad^2.
function preyGain(K, sct, fam, rad) {
  return K.preyKp * (rad * rad) * famMult(K, sct, fam);
}

// L23 charge edges at sct: the measured low band up to maxSct, the approved cubic above it (s = sct - fromSct).
function chargeLo(K, sct) {
  if (sct <= K.lowMaxSct) return K.lowLo;
  const s = sct - K.lowMaxSct;
  return K.edgeLo0 + K.edgeLo2 * s * s + K.edgeLo3 * s * s * s;
}

function chargeHi(K, sct) {
  if (sct <= K.lowMaxSct) return K.lowHi;
  const s = sct - K.lowMaxSct;
  return K.edgeHi0 + K.edgeHi2 * s * s + K.edgeHi3 * s * s * s;
}

// L24.size: drop rad byte from the charge c before the multiplier.
function dropByte(K, c) {
  return Math.round(K.dropAlpha * Math.sqrt(c) + K.dropBeta);
}

// L24.colour.skin: a snake of colour cv drops a fixed colour per skin. Measured weights first, then the weights from
// the skin's own pattern, otherwise cv mod 9 (plain colours 0 to 8 thus drop their own colour). A weighted pick
// takes ONE draw from the 'drop' stream; a fixed colour takes none.
function dropColour(K, cv, rng) {
  const t = K.skinDrop;
  const w = Object.prototype.hasOwnProperty.call(t.measured, cv) ? t.measured[cv]
    : Object.prototype.hasOwnProperty.call(t.pattern, cv) ? t.pattern[cv] : null;
  if (w === null) return cv % 9;
  const keys = Object.keys(w); // integer keys: ascending order by the language rule
  if (keys.length === 1) return Number(keys[0]);
  let total = 0;
  for (const k of keys) total += w[k];
  let u = rng.next() * total;
  for (const k of keys) {
    u -= w[k];
    if (u < 0) return Number(k);
  }
  return Number(keys[keys.length - 1]);
}

// The client's angle helpers, same arithmetic (public/js/sl/slLoop.js:113-123).
function wrapAngle(a) {
  if (a < 0 || a >= PI2) a %= PI2;
  if (a < 0) a += PI2;
  return a;
}

function angleGap(w, a) {
  let v = (w - a) % PI2;
  if (v < 0) v += PI2;
  if (v > Math.PI) v -= PI2;
  return v;
}

// ------------------------------------------------------------------ the snake object

function newPoint(x, y, iang) {
  return { xx: x, yy: y, smu: 1, iang, gs: -1, gk: -1 };
}

// The per-update record slView reads (reused every update; valid until the snake's next update).
function newRec(id) {
  return {
    id,
    h: false, // a fam record goes first (L48.hDefer: a change no record carried yet)
    hFam: 0, // its value (the true fam; the view clamps and quantizes, L17.famRound)
    tails: [], // fam after each tail point lost to a charge (each an r record, in order)
    turning: false, // ang moved this update (the view sends ang on every rotation record while turning, L48.rot)
    move: false, // a point was added
    moves: 0, // points added this update (at most 1 at every speed the laws allow; a test holds it)
    grow: false, // the point was a grow (fam >= 1 kept the tail)
    abs: false, // absolute form: the first point after spawn (L48.abs), integers
    xx: 0,
    yy: 0,
    iang: 0, // the 16-bit angle the point was stepped along (slQuant.moveIang)
    fam: 0, // fam after the update
  };
}

// A new snake in the L20 spawn state at head (x, y) with heading ang: sct points gap apart in a straight line, the
// head on the last one, ang = wang, fam, speed the L12 base at the spawn length. sct and fam other than the L20 values
// are for tests and tools only (the room never passes them).
function createSnake(K, id, o) {
  const sct = o.sct === undefined ? K.minSct : o.sct;
  const fam = o.fam === undefined ? K.spawnFam : o.fam;
  if (!Number.isInteger(sct) || sct < K.minSct) throw new RangeError('slSnake: sct must be an integer >= ' + K.minSct);
  if (typeof fam !== 'number' || !Number.isFinite(fam) || fam < 0) throw new RangeError('slSnake: fam must be >= 0');
  const ang = wrapAngle(o.ang);
  const q = slQuant.moveIang(ang);
  const cx = Math.cos(q.v);
  const cy = Math.sin(q.v);
  const pts = new Array(sct);
  for (let i = 0; i < sct; i++) {
    const back = sct - 1 - i;
    pts[i] = back === 0 ? newPoint(o.x, o.y, q.raw)
      : newPoint(o.x - cx * K.spawnGap * back, o.y - cy * K.spawnGap * back, q.raw);
  }
  const sp = speedBase(K, sct);
  return {
    id,
    cv: o.cv,
    nick: o.nick,
    alive: true,
    pts,
    spare: [], // point objects lost to charges, reused by grows
    fam,
    famSent: fam, // the fam the stream carries now (snake_add carries the spawn fam)
    ang,
    wang: ang,
    dir: 1, // last turn direction for the wire (1 lowers ang, 2 raises it); CHOSEN 1 before any turn
    turning: false,
    spBase: sp, // L12, set at spawn and at boost end only (the boost ends when the ramp down lands)
    rampDown: false, // L12, L13: ramping down after a boost; the landing speed follows the length until it lands
    spCore: sp, // L12 / L13 speed before the hold multiplier
    sp, // the speed the snake moves at and the wire carries
    holdMult: null, // null = not held; else the multiplier slHold computed for this update
    boosting: false,
    rampFrac: 1, // L13.first fraction of the next ramp step
    chargeMs: 0, // ms on the snake's charge clock since the last charge, at the end of the last update window
    // the hold as this update's boost records saw it (boostTimeline): held at the end of the last update, and the
    // offsets of a hold start or release since then (-1: none)
    slotHeld: false,
    holdStartOff: -1,
    holdRelOff: -1,
    chargeCount: 0,
    // the continuous head (headX, headY): it runs on the path of the turn, the points follow it (steps 3 to 5)
    cx: o.x,
    cy: o.y,
    absDone: false, // L48.abs: the first point after spawn has been added
    // input slot for the next update (SERVER-DESIGN 5.2): steering records flat [kind (0 angle byte, 1 signed arrow
    // ticks), value, offsetMs, ...] in arrival order (queueSteer), each applied at its own time in the window
    inSteer: [],
    inBoost: [], // flat [on (1 or 0), offsetMs, ...] in arrival order, repeats collapsed
    // inputs stored while held with steering locked; the newest applies at release (SERVER-DESIGN 15.3)
    heldAngle: -1,
    heldTurn: 0,
    rec: newRec(id),
    commit: null, // the point the room sent early this window (travel places it; slSim previewPoint)
  };
}

// The server's head (SERVER-DESIGN 7, snx and sny): it runs on its own path (travel), the last point lies behind it on
// that path, under msl away.
function headX(s) {
  return s.cx;
}

function headY(s) {
  return s.cy;
}

// ------------------------------------------------------------------ inputs (applied at the tick start)

// Sets wang and the turn direction by the shortest way round (their client turns by dir until it passes wang,
// game.js:4788-4810). A zero gap is no turn and keeps the last wire dir.
function setWang(s, wang) {
  s.wang = wang;
  const g = angleGap(wang, s.ang);
  if (g < 0) {
    s.dir = 1;
    s.turning = true;
  } else if (g > 0) {
    s.dir = 2;
    s.turning = true;
  } else {
    s.turning = false;
  }
}

// L15 direction byte b (0 to maxAngle): wang on the 8-bit grid (slQuant.wangFromInput is the L15 map).
function applyAngle(K, s, b) {
  setWang(s, slQuant.wangFromInput(b).v);
}

// L15 arrow ticks, summed and signed (left negative, right positive), relative to the current wang.
function applyTurn(K, s, ticks) {
  if (ticks === 0) return;
  const amount = arrowTurn(K, s.pts.length, s.sp, ticks < 0 ? -ticks : ticks);
  setWang(s, wrapAngle(ticks < 0 ? s.wang - amount : s.wang + amount));
}

// L22: a 253 starts the boost iff L = sct + fam > minL, decided at the press; refused while held when C_HOLD_BOOST
// forbids it (held: the hold as it stood when the press arrived, boostTimeline). The first L23 charge is at the press
// (boostTimeline pays it) and the charge clock starts there. The first L13 ramp step is the offset fraction (L13.first).
function boostOn(K, s, offsetMs, held) {
  if (s.boosting) return false;
  if (held && !K.holdBoostAllow) return false;
  if (!(s.pts.length + s.fam > K.boostMinL)) return false;
  s.boosting = true;
  s.rampFrac = firstFraction(K, offsetMs);
  return true;
}

// A 254 (or a hold start, or the sct floor): the boost ends and the ramp goes down; the next ramp step down is frac
// of a full one. The L12 base follows the length until the ramp lands (stepSpeed).
function boostOff(K, s, frac) {
  if (!s.boosting) return false;
  s.boosting = false;
  s.rampDown = true;
  s.spBase = speedBase(K, s.pts.length);
  s.rampFrac = frac;
  return true;
}

// Steering records kept per update window; past it the oldest takes effect at once, at the window start (CHOSEN: a
// bound for floods; their client sends at most 2 angle bytes (33 ms gate) and 1 arrow record (50 ms gate) per
// 42.67 ms update, slInput.js).
const STEER_MAX = 16;

// Applies one steering record now: an angle byte (L15) or signed arrow ticks (L15, at length n and speed sp). s may be
// a scratch {ang, wang, dir, turning} (steerAt).
function applySteer(K, s, kind, value, n, sp) {
  if (kind === 0) {
    applyAngle(K, s, value);
  } else if (value !== 0) {
    const amount = arrowTurn(K, n, sp, value < 0 ? -value : value);
    setWang(s, wrapAngle(value < 0 ? s.wang - amount : s.wang + amount));
  }
}

// One steering record on arrival (slSim.setInput): kind 0 an angle byte q, kind 1 signed arrow ticks, offsetMs its
// arrival offset (C_INPUT_OFFSET). Records of one arrival share the offset (one POST or WebSocket burst): an angle
// replaces what came with it, arrow ticks of one arrival add up (L15 turn is additive).
function queueSteer(K, s, kind, value, offsetMs) {
  const q = s.inSteer;
  if (kind === 0) {
    while (q.length && q[q.length - 1] === offsetMs) q.length -= 3;
  } else if (q.length && q[q.length - 1] === offsetMs && q[q.length - 3] === 1) {
    q[q.length - 2] += value;
    return;
  }
  q.push(kind, value, offsetMs);
  if (q.length > 3 * STEER_MAX) {
    applySteer(K, s, q[0], q[1], s.pts.length, s.sp);
    q.splice(0, 3);
  }
}

// Steering is locked (a hold start, a connection-blip glide): the records of this window never apply, as the lock set
// at the update start overrode them before; then wang = the lock angle.
function lockSteer(s, wang) {
  s.inSteer.length = 0;
  setWang(s, wang);
}

// The input slot at the update start. While held with steering locked, angle and arrow records are stored and the
// newest applies at release. Otherwise the steering records stay in the slot for the update (travel applies each at
// its own time) and the boost records for its timeline (boostTimeline, with the L23 charges in time order).
function applyInputSlot(K, s) {
  if (!(s.holdMult !== null && K.holdSteerLocked)) return;
  const q = s.inSteer;
  for (let i = 0; i < q.length; i += 3) {
    if (q[i] === 0) {
      s.heldAngle = q[i + 1];
      s.heldTurn = 0;
    } else {
      s.heldTurn += q[i + 1];
    }
  }
  q.length = 0;
}

// ------------------------------------------------------------------ hold (sim side of slHold, SERVER-DESIGN 15.3)

// mult a number in (0, 1]: the snake is held this update with that speed multiplier (slHold computes it from
// C_HOLD_RAMP). The first such call locks steering (C_HOLD_STEER): wang = the current 8-bit ang byte (L48.angRound),
// and ends a boost when C_HOLD_BOOST forbids boosting, as a 254 read offsetMs before the update: boostTimeline ends it
// at that time, after the charges due before it.
// mult null: release; the newest stored angle and arrow inputs apply now and the speed snaps back. Boost records of
// this update that arrived at or before the release (offsetMs) were still held.
function setHold(K, s, mult, offsetMs) {
  if (mult === null) {
    if (s.holdMult === null) return false;
    s.holdMult = null;
    s.holdRelOff = offsetMs;
    if (s.heldAngle >= 0) applyAngle(K, s, s.heldAngle);
    if (s.heldTurn !== 0) applyTurn(K, s, s.heldTurn);
    s.heldAngle = -1;
    s.heldTurn = 0;
    return true;
  }
  if (typeof mult !== 'number' || !(mult > 0 && mult <= 1)) throw new RangeError('slSnake: hold multiplier must be in (0, 1]');
  const starting = s.holdMult === null;
  s.holdMult = mult;
  if (starting) {
    if (K.holdSteerLocked) lockSteer(s, slQuant.rotAng(s.ang, K.angRound).v);
    s.holdStartOff = offsetMs;
  }
  return starting;
}

// Was the snake held (for C_HOLD_BOOST) when something arrived offsetMs before the update? Held at the end of the last
// update and not yet released (a release at offset r frees what arrived after it, offset below r), or a hold that
// started at or before it since then.
function heldAt(s, offsetMs) {
  if (s.slotHeld && !(s.holdRelOff >= 0 && offsetMs < s.holdRelOff)) return true;
  return s.holdStartOff >= 0 && offsetMs <= s.holdStartOff;
}

// ------------------------------------------------------------------ the update

// L14 for T ms on the angle alone: ang moves toward wang at rate (rad per ms) and stops on it (the client's steer,
// game.js:4788-4810, in continuous time). s may be a scratch {ang, wang, dir, turning} (steerAt). Returns the ms spent
// turning (T when wang was not reached, 0 when not turning).
function turnFor(s, T, rate) {
  if (!s.turning || !(rate > 0)) return 0;
  const reach = Math.abs(angleGap(s.wang, s.ang)) / rate;
  if (reach <= T) {
    s.ang = s.wang;
    s.turning = false;
    return reach;
  }
  s.ang = wrapAngle(s.dir === 1 ? s.ang - rate * T : s.ang + rate * T);
  return T;
}

// Steps 3 to 5 over the update window (the P ms before the update). 3: every steering record of the slot takes effect
// at its arrival time (windowAt) and ang turns toward wang between them (turnFor; L14 is per ms, their server turns from
// the input's arrival). 4: then the head moves v P straight along the ang the turn ended on (turn, then move, once per
// update). 5: a point wherever that segment first reaches msl from the last point (exact, the quadratic root), one msl
// step on the 16-bit angle of the chord to it; the head keeps what it ran past the point (L12 travel 1.0009).
// Measured against Owen's slither.io recordings with their client's own prediction (the head reset to each new point,
// ang set from each packet, game.js:4788-4860, 7860-7863): their new points sit 0.01 to 0.27 units inside the head the
// client predicted (medians, hard turns, boost and normal); this order gives -0.02 to -0.06, a continuous arc -2.8 to
// -3.4 (the client starts from the point with the ang of a head already past it), the old point along ang +17.
// recordings/TURNING.md. The turn rate and the arrow amounts read the length and the speed before this update's step
// (n0, sp0), as when the slot was applied at the update start. True when ang moved in this update (L48.rot).
//
// The window runs as PIECES straight pieces of P / PIECES ms each (turning smoothness task, 2026-10-16), each one turn,
// then move, so the head path is a polygon close to the arc the client draws (their client turns, then moves, every
// 8 ms frame) instead of one chord per update. The first PIECES - 1 pieces move at the speed before this update's
// step (sp0, the speed the client was sent and moves at); the last piece moves the rest of sp (P / 8) / 4, so the
// window's travel is the L12 / L13 amount exactly (never below 0). The pieces are fixed in window time, so the room
// can work out a point before the update (previewPoint, the same walk on a copy) and send it when the head reaches
// it: on 42.67 ms updates alone a point reached the client 0 to 1 update late, the client put its head back on it,
// and the head was yanked 3.4 to 4.7 units back or forward on every point (live, 2026-10-16: 692 points, along-track
// jump tracking msl - v dt with corr 0.96; slither.io sends each point on its own, 10,933 of 12,560 with no rotation).
// s.commit: the point the room already sent this window (previewPoint's iang); the walk places that one.
const PIECES = 4;

// One piece's straight move of len from (st.cx, st.cy) along st.ang: every place it first reaches msl from the last
// point (the quadratic root past the last point placed) goes to onPoint(iang, u); returns false when onPoint stops.
function pieceMove(K, st, pts, len, onPoint) {
  const ux = Math.cos(st.ang);
  const uy = Math.sin(st.ang);
  const msl2 = K.msl * K.msl;
  let done = 0; // of len, up to the last point placed on this piece
  for (;;) {
    const last = pts[pts.length - 1];
    const ex = st.cx + ux * len - last.xx;
    const ey = st.cy + uy * len - last.yy;
    if (ex * ex + ey * ey < msl2) break;
    // the head at u along the piece: |(cx - last) + u (ux, uy)|^2 = msl^2, the root past done
    const dx = st.cx - last.xx;
    const dy = st.cy - last.yy;
    const bb = dx * ux + dy * uy;
    const cc = dx * dx + dy * dy - msl2;
    let u = -bb + Math.sqrt(bb * bb - cc);
    if (!(u > done)) u = done;
    if (u > len) u = len;
    const px = st.cx + ux * u;
    const py = st.cy + uy * u;
    if (onPoint(slQuant.moveIang(Math.atan2(py - last.yy, px - last.xx)).raw, u) === false) return false;
    done = u;
    if (done >= len) break;
  }
  st.cx += ux * len;
  st.cy += uy * len;
  return true;
}

// The window walk shared by travel and previewPoint: st {ang, wang, dir, turning, cx, cy} turns and moves, q the
// steering records, upto the pieces to run (PIECES for the whole window). Returns whether ang moved.
function walkWindow(K, st, q, P, n0, sp0, spEnd, upto, pts, onPoint) {
  const rate = turnStep(K, n0, sp0, 1);
  const piece = P / PIECES;
  const lenPiece = sp0 * (piece / 8) / 4; // their client: sp / 4 per 8 ms frame (game.js:4757, 4855-4860)
  const lenAll = spEnd * (P / 8) / 4;
  let t = 0;
  let i = 0;
  let moved = 0;
  let turned = false;
  for (let k = 1; k <= upto; k++) {
    const tk = k === PIECES ? P : piece * k;
    for (; i < q.length; i += 3) {
      const w = windowAt(q[i + 2], P);
      if (w > tk) break;
      if (w > t) {
        if (turnFor(st, w - t, rate) > 0) turned = true;
        t = w;
      }
      applySteer(K, st, q[i], q[i + 1], n0, sp0);
    }
    if (tk > t) {
      if (turnFor(st, tk - t, rate) > 0) turned = true;
      t = tk;
    }
    let len = k === PIECES ? lenAll - moved : lenPiece;
    if (!(len > 0)) len = 0;
    if (!pieceMove(K, st, pts, len, onPoint)) return turned;
    moved += len;
  }
  return turned;
}

function travel(sim, s, P, sp0) {
  const K = sim.K;
  const n0 = s.pts.length;
  const commit = s.commit;
  s.commit = null;
  let placed = false;
  const turned = walkWindow(K, s, s.inSteer, P, n0, sp0, s.sp, PIECES, s.pts, (iang) => {
    if (commit && !placed) {
      if (iang !== commit.iang) sim.commitStats.moved++;
      iang = commit.iang;
    }
    placed = true;
    if (commit && commit.grow !== (s.fam >= 1)) sim.commitStats.grow++;
    addPoint(sim, s, iang, commit ? commit.grow : undefined);
  });
  s.inSteer.length = 0;
  // a point the room sent that this walk did not reach (a hold or glide lock dropped the window's steering after the
  // room had sent it): it stands, at the end of the window
  if (commit && !placed) {
    sim.commitStats.late++;
    addPoint(sim, s, commit.iang, commit.grow);
  }
  return turned;
}

// The point this window's walk reaches by window time wt, before the update (the room's early send): the same walk
// on a copy, over the pieces that end by wt and are not the last (the last piece's length waits for the update's
// speed step). Returns the first point's iang, or null. Reads s, never writes it.
const previewScratch = { ang: 0, wang: 0, dir: 0, turning: false, cx: 0, cy: 0 };
function previewPoint(K, s, P, wt) {
  const upto = Math.min(PIECES - 1, Math.floor(wt / (P / PIECES)));
  if (upto < 1 || s.commit) return null;
  const st = previewScratch;
  st.ang = s.ang;
  st.wang = s.wang;
  st.dir = s.dir;
  st.turning = s.turning;
  st.cx = s.cx;
  st.cy = s.cy;
  let found = null;
  walkWindow(K, st, s.inSteer, P, s.pts.length, s.sp, s.sp, upto, s.pts, (iang) => {
    found = iang;
    return false;
  });
  return found;
}

// The steering the snake has at the newest record of its slot (the moment it arrived), angle only, exactly as travel
// will run it: for the room's on-arrival echo (C_ECHO_NOW), whose ang must be the server's ang at that moment (L14 per
// ms), not the ang of the last update (that echo threw the client back 0.06 rad on 62 percent of hard-turn echoes,
// recordings/TURNING.md). Writes ang, wang, dir and turning into x; returns the wang byte to echo (L15 floor for an
// angle byte, L48.angRound for arrow ticks), or -1 with no steering record.
function steerAt(K, s, P, x) {
  x.ang = s.ang;
  x.wang = s.wang;
  x.dir = s.dir;
  x.turning = s.turning;
  const q = s.inSteer;
  if (!q.length) return -1;
  const n0 = s.pts.length;
  const rate = turnStep(K, n0, s.sp, 1);
  let t = 0;
  for (let i = 0; i < q.length; i += 3) {
    const w = windowAt(q[i + 2], P);
    if (w > t) {
      turnFor(x, w - t, rate); // as travel
      t = w;
    }
    applySteer(K, x, q[i], q[i + 1], n0, s.sp);
  }
  const k = q.length - 3;
  return q[k] === 0 ? slQuant.wangFromInput(q[k + 1]).raw : slQuant.rotAng(x.wang, K.angRound).raw;
}

// Step 2, L12 and L13: one ramp step per update, (nsp3 - ssp) / N with ssp and N at the current sct (the fit in
// analysis/laws/move.js uses the current length), the first one a fraction; capped at nsp3 going up, landing exactly
// on the L12 base going down. Then the hold multiplier.
function stepSpeed(K, s) {
  const sct = s.pts.length;
  if (s.boosting) {
    if (s.spCore < K.nsp3) {
      s.spCore += (K.nsp3 - speedBase(K, sct)) / rampUp(K, sct) * s.rampFrac;
      if (s.spCore > K.nsp3) s.spCore = K.nsp3;
    }
  } else if (s.rampDown) {
    // L12 and L13: the way down lands on the base at the length WHEN IT LANDS, so a snake that grows while ramping
    // down lands on the new length's base (S1+S2+S3: 47 of 47 boost ends whose snake grew to another speed byte during
    // the ramp landed on the landing length's base, 0 on the 254's; task T14). After the landing the base stays put
    // while the snake grows (L12, never re-set on growth).
    s.spBase = speedBase(K, sct);
    if (s.spCore > s.spBase) {
      s.spCore -= (K.nsp3 - s.spBase) / (K.downRatio * rampUp(K, sct)) * s.rampFrac;
      if (s.spCore < s.spBase) s.spCore = s.spBase;
    } else {
      // A boost that ended before any step up, at a length whose base is above the old one: land on the base (CHOSEN;
      // no ramp up to a normal speed was ever measured).
      s.spCore = s.spBase;
    }
    if (s.spCore === s.spBase) s.rampDown = false;
  }
  s.rampFrac = 1;
  s.sp = s.holdMult === null ? s.spCore : s.spCore * s.holdMult;
}

// Takes the tail point out of the body and the grid; returns it.
function dropTail(sim, s) {
  const p = s.pts.shift();
  sim.grid.removePoint(p);
  return p;
}

// One L23 charge. c uniform in [lo, hi] (one 'charge' draw); fam -= c x mult (L18 mult from the fam before it). Below
// zero the tail point goes (an r record carrying the new fam) and fam += 1; at the minimum length fam clamps to 0 and
// the boost ends, with no drop. A drop (L24) iff L before the charge > L24.Td minL: rad byte from c, colour by the
// skin table, placed at the oldest pulled point (before the charge) plus a uniform point in the L24.place disc.
function charge(sim, s) {
  const K = sim.K;
  const sct = s.pts.length;
  const fam0 = s.fam;
  const lBefore = sct + fam0;
  const lo = chargeLo(K, sct);
  const c = lo + (chargeHi(K, sct) - lo) * sim.rng.charge.next();
  let fam = fam0 - c * famMult(K, sct, fam0);
  s.chargeCount++;
  if (fam < 0 && sct <= K.minSct) {
    s.fam = 0;
    boostOff(K, s, 1); // a self-stop has no key read: the next ramp step down is a full one (CHOSEN)
    return null;
  }
  const tail = s.pts[0];
  const tx = tail.xx;
  const ty = tail.yy;
  if (fam < 0) {
    s.spare.push(dropTail(sim, s));
    fam += 1;
    s.fam = fam;
    s.famSent = fam;
    s.rec.tails.push(fam);
  } else {
    s.fam = fam;
  }
  if (!(lBefore > K.dropMinL)) return null;
  const rng = sim.rng.drop;
  const cv = dropColour(K, s.cv, rng);
  const r = K.dropRadius * Math.sqrt(rng.next());
  const th = PI2 * rng.next();
  // c: the charge mass the byte came from (for tools and tests: the L24 size rule is checked against it)
  const drop = { kind: 'boost', id: s.id, x: tx + r * Math.cos(th), y: ty + r * Math.sin(th), b: dropByte(K, c), cv, c };
  sim.log.drops.push(drop);
  return drop;
}

// L23: pays every charge due on the snake's own clock between window times from and to (ms into the update window)
// while it boosts, and moves the clock to `to` (s.chargeMs: ms since the last charge, at window time from).
function payCharges(sim, s, from, to) {
  const period = sim.K.chargePeriod;
  let t = from;
  while (s.boosting && s.chargeMs + (to - t) >= period) {
    t += period - s.chargeMs;
    s.chargeMs = 0;
    charge(sim, s);
    if (sim.log.charges) sim.log.charges.push(s.id, t);
  }
  if (s.boosting) s.chargeMs += to - t;
}

// Window time of something that arrived offsetMs before the update (the window is the P ms before it; the room's
// whole-ms offsets reach round(P), clamped to the window start).
function windowAt(offsetMs, P) {
  const t = P - offsetMs;
  return t > 0 ? (t < P ? t : P) : 0;
}

// A hold that started this update ends a boost (C_HOLD_BOOST) as a 254 read offsetMs before the update.
function holdEnd(sim, s, at, offsetMs, P) {
  const w = windowAt(offsetMs, P);
  const t = w > at ? w : at;
  payCharges(sim, s, at, t);
  if (boostOff(sim.K, s, firstFraction(sim.K, offsetMs)) && sim.log.boosts) {
    sim.log.boosts.push({ id: s.id, on: false, off: offsetMs, hold: true });
  }
  return t;
}

// Step 0b, L22 and L23 (task T14b): the update window is the P ms before the update; a boost record that arrived
// offsetMs before the update sits at window time P - offsetMs. In time order: the slot's boost records (arrival
// order), the boost end of a hold that started this update, and every L23 charge due inside the window on the snake's
// own clock, a charge due at or before a record first. So a charge is paid only while boosting (none after a 254:
// paying the window AFTER the update put 293 of 1,892 boost ends on seed 16 one charge past their 254), each accepted
// 253 pays its first charge at once (a 253, 254, 253 inside one update: two runs, two charges) and a later press reads
// L after the earlier charges (L22). The records go out with the update: 0 to P after their true time, as the room's
// clocks (C_TIMING_BARS).
function boostTimeline(sim, s, P) {
  const K = sim.K;
  const b = s.inBoost;
  const log = sim.log.boosts;
  let hs = K.holdBoostAllow ? -1 : s.holdStartOff;
  let at = 0;
  for (let i = 0; i < b.length; i += 2) {
    const off = b[i + 1];
    if (hs >= 0 && off < hs) {
      at = holdEnd(sim, s, at, hs, P);
      hs = -1;
    }
    const w = windowAt(off, P);
    const t = w > at ? w : at; // read in arrival order: never before the record read last
    payCharges(sim, s, at, t);
    at = t;
    if (b[i] === 1) {
      if (s.boosting) continue; // a 253 while boosting is no press
      const L = s.pts.length + s.fam;
      const ok = boostOn(K, s, off, heldAt(s, off));
      if (log) log.push({ id: s.id, on: true, off, ok, L, frac: s.rampFrac });
      if (ok) {
        s.chargeMs = 0;
        charge(sim, s);
        if (sim.log.charges) sim.log.charges.push(s.id, t);
      }
    } else if (boostOff(K, s, firstFraction(K, off)) && log) {
      log.push({ id: s.id, on: false, off, hold: false });
    }
  }
  if (hs >= 0) at = holdEnd(sim, s, at, hs, P);
  payCharges(sim, s, at, P);
  b.length = 0;
  s.slotHeld = s.holdMult !== null;
  s.holdStartOff = -1;
  s.holdRelOff = -1;
}

// Step 5, L16 and L48.abs: pull, then one msl step from the last point along the 16-bit angle iang (travel: the chord
// from the last point to where the head's path reaches msl; slCore.headStep, the client's own arithmetic).
// growSent: the grow (or plain move) the room already sent with this point (s.commit). It stands even when a boost
// press since then paid a charge that took fam under 1: the tail then goes as a charge's does (L23.form: fam < 0
// drops the tail point and fam += 1) with its r record, so every client ends on the same body and fam.
function addPoint(sim, s, iang, growSent) {
  const K = sim.K;
  const pts = s.pts;
  const last = pts[pts.length - 1];
  slCore.chainPull(pts, K.cst, K.smus, sim.grid.pullHook); // L16: BEFORE the new point
  const hp = slCore.headStep(last.xx, last.yy, iang, K.msl);
  let x = hp[0];
  let y = hp[1];
  const abs = !s.absDone;
  if (abs) {
    x = slQuant.absXY(x).v;
    y = slQuant.absXY(y).v;
    s.absDone = true;
  }
  const grow = growSent === undefined ? s.fam >= 1 : growSent;
  let p;
  if (grow) {
    s.fam -= 1;
    s.famSent = s.fam;
    p = s.spare.length ? s.spare.pop() : newPoint(0, 0, 0);
  } else {
    p = dropTail(sim, s);
  }
  p.xx = x;
  p.yy = y;
  p.smu = 1;
  p.iang = iang;
  pts.push(p);
  sim.grid.addPoint(s.id, p);
  const rec = s.rec;
  if (s.fam < 0) {
    s.spare.push(dropTail(sim, s));
    s.fam += 1;
    s.famSent = s.fam;
    rec.tails.push(s.fam);
  }
  rec.move = true;
  rec.moves++;
  rec.grow = grow;
  rec.abs = abs;
  rec.xx = x;
  rec.yy = y;
  rec.iang = iang;
}

// One update of one snake (SERVER-DESIGN 6.2 steps 1 to 5; the world half adds eating and the collision test).
function updateSnake(sim, s, P) {
  const K = sim.K;
  const rec = s.rec;
  rec.tails.length = 0;
  rec.move = false;
  rec.moves = 0;
  rec.grow = false;
  rec.abs = false;
  // 0: a fam the stream has not carried (an eat or a charge without a tail loss) goes first (L48.hDefer, L48.order)
  rec.h = s.fam !== s.famSent;
  rec.hFam = s.fam;
  s.famSent = s.fam;
  boostTimeline(sim, s, P); // 0b: boost records, a hold's boost end and the L23 charges, in time order
  const sp0 = s.sp; // 1: the turn rate reads the speed before the step
  stepSpeed(K, s); // 2
  // 3 to 5: turn, travel and the points on the way (at most one point per update at nsp3: 14 x 42.67 / 32 = 18.7 < msl)
  rec.turning = travel(sim, s, P, sp0) || s.turning; // ang moved, or a record set a turn at the window end (L48.rot)
  rec.fam = s.fam;
  return rec;
}

// L18 eat of one food of rad byte b, and L34 eat of one prey of radius rad: fam grows, one item at a time with the
// multiplier recomputed; the record waits for the snake's next update (L48.hDefer).
function feedFood(K, s, b) {
  s.fam += foodGain(K, s.pts.length, s.fam, b);
}

function feedPrey(K, s, rad) {
  s.fam += preyGain(K, s.pts.length, s.fam, rad);
}

module.exports = {
  SNAKE_LAW_IDS,
  SNAKE_RULES_BUILT,
  snakeLaws,
  speedSc,
  speedBase,
  rampUp,
  firstFraction,
  turnStep,
  arrowTurn,
  famMult,
  foodGain,
  preyGain,
  chargeLo,
  chargeHi,
  PIECES,
  previewPoint,
  dropByte,
  dropColour,
  wrapAngle,
  angleGap,
  createSnake,
  headX,
  headY,
  setWang,
  applySteer,
  queueSteer,
  steerAt,
  lockSteer,
  applyInputSlot,
  boostOn,
  boostOff,
  setHold,
  charge,
  updateSnake,
  feedFood,
  feedPrey,
};
