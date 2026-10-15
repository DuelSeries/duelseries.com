'use strict';
// slither.io free room: prey (SERVER-DESIGN 6.4, task T5; SERVER-LAWS L32 to L34).
//
// Spawn (L32, Owen Q8 "as measured"): each sector the border disc touches spawns a prey with chance perSectorMinute
// per minute, checked on a pass every L29.period ms (CHOSEN: the food pass period, an engineering clock), at a uniform
// point that must lie inside the border (C_OUTSIDE_FOOD); rad byte by the measured counts, colour uniform, speed L32.sp,
// a uniform heading with ang = wang and dir 0.
// Updates (L33.period): each prey on its own phase gets one update every periodMs; the update decides the prey's
// wanted angle and speed and makes one prey_move record (their `j`).
// Between updates every prey moves each sim step exactly as their client predicts it (game.js:4972-5019, our
// public/js/sl/slLoop.js stepPrey): turn by mamu2 per 8 ms toward wang in the dir sense (snap and dir 0 on passing),
// then move sp / 32 units per ms along ang.
// Eaten by a snake (L31 eat zone, L34 value): the sim calls eat(); the record is prey_eaten.
//
// SERVER-LAWS L33 approved the flee rule and the speed levels but left "when the middle level applies and how the
// speed ramps" to be fitted from the recordings before this file (BUILD-DECISIONS T1). The fit is
// slither-reference/tools/t5-prey-fit.js (output recordings/T5-prey-fit.txt). What it found, and the rows it gives,
// are PREY_ROWS below: each is a new dotted part of L32 or L33, with status and source, to move into slLaws.js and
// SERVER-LAWS section N (T1 follow-up). The law table wins when it holds the same id. Five parts have no rule in the
// data and are SUGGESTED (Owen's approve page, Q23 style): preyNotShippable() names them, so a room that requires a
// shippable prey table stays closed until he answers.
//   L33.form      RULE      every j carries dir, ang, wang; sp only when it changed since the prey's last j
//   L33.outward   RULE      the 6.06 level heads exactly away from the map centre (866 of 866 updates)
//   L33.fleeSp    MEASURED  a fleeing prey's speed = a + b x the chasing snake's speed (96 of 98 plateaus); this is
//                           the "6.06 to 6.4" and the "11" of L33.flee: a chaser at normal speed gives 6.15 to 6.5,
//                           a boosting one 10.997, and every value between is a chaser mid boost ramp (no prey ramp)
//   L33.afterFlee MEASURED  when the threat is gone: outward with this share, else rest
//   L33.spont     SUGGESTED rest turns outward with no threat (7 of 1550 updates), first at 11.0 then 6.06
//   L33.wander    SUGGESTED rest wang step per update from the measured histogram (their walk is correlated)
//   L33.motion    SUGGESTED the client model above (their server moves prey in 48-unit steps, rule not found)
//   L33.extra     SUGGESTED no off-cycle updates (their 6.7 percent short gaps have no rule found)
//   L32.remove    SUGGESTED a prey that crosses the border is removed (none vanished in view; the outward run ends
//                           at the border; standing 0.0098 prey per watched sector)
//
// Deterministic: every draw from the caller's 'prey' stream (server/sl/slRng.js); prey kept in spawn order.

const { assertLawsComplete, assertRulesBuilt, notShippable, STATUS } = require('./slLaws');
const Q = require('./slQuant');

const PI2 = 2 * Math.PI;
const SP_SCALE = 1000; // prey sp on the wire: u16 / 1E3 (game.js:8430)
const FIT = 'slither-reference/tools/t5-prey-fit.js, recordings/T5-prey-fit.txt';

// The rows of the law table this file reads.
const PREY_TABLE_IDS = Object.freeze(['L1', 'L2.size', 'L5', 'L29.period', 'L32', 'L33.period', 'L33.flee',
  'C_OUTSIDE_FOOD', 'C_ID_QUARANTINE_MS']);
const PREY_RULES = Object.freeze(['preySpawn', 'preyFlee']);

function row(id, name, status, value, unit, source) {
  return Object.freeze({ id, name, status, value: Object.freeze(value), unit, source });
}

// Rows found by the T5 fit (values carry no `rule` key: their rule names are not in slRules.js yet, T1 follow-up).
const PREY_ROWS = Object.freeze({
  'L33.form': row('L33.form', 'Prey update record: every j carries dir, ang and wang; sp only when it changed since the prey last j',
    STATUS.RULE, { always: ['dir', 'ang', 'wang'], sp: 'onChange' }, 'form',
    'RULE FOUND: T5 fit L33.form (3808 j: 2799 dir+ang+wang, 1009 with sp; 987 carry a new sp, the other 22 repeat it ' +
    'in the first j after a prey_add; 0 counter-examples); ' + FIT),
  'L33.outward': row('L33.outward', 'Prey outward run: wang exactly away from the map centre (grd, grd), at this speed',
    STATUS.RULE, { sp: 6.06, from: 'centre' }, 'speed units',
    'RULE FOUND: T5 fit L33.outward (866 of 866 updates holding sp 6.06 head away from (grd, grd) within 0.02 rad, the ' +
    'wire grid; the 6.06 level of L33.flee midSp); ' + FIT),
  'L33.fleeSp': row('L33.fleeSp', 'Prey flee speed: a + b x the chasing snake current speed, rounded to the 0.001 wire step',
    STATUS.MEASURED, { a: 2.736829476, b: 0.590012180, step: 0.001 }, 'speed units',
    'MEASURED: T5 fit L33.fleeSp (fixed by 6.153 at a chaser of 5.79, L20, and 10.997 at a boosting chaser of 14, nsp3; ' +
    '96 of 98 plateau speeds inside the chaser wire interval, |residual| p50 0.009; replaces L33.flee midSp and fleeSp ' +
    'for fleeing prey); ' + FIT),
  'L33.afterFlee': row('L33.afterFlee', 'When a flee ends: the prey runs outward with this chance, else rests',
    STATUS.MEASURED, { pOutward: 0.326 }, 'probability',
    'MEASURED: T5 fit L33.afterFlee (79 outward of 242 flee ends; outward goes back to rest 4 of 792 updates); ' + FIT),
  'L33.spont': row('L33.spont', 'A resting prey turns outward with no threat with this chance per update, first at firstSp then thenSp',
    STATUS.SUGGESTED, { perUpdate: 0.0045, firstSp: 11, thenSp: 6.06 }, 'probability; speed units',
    'SUGGESTED: T5 fit L33.afterFlee (7 of 1550 rest updates turn outward with no flee; speeds 11.0 x3, 3.8 x3, 6.06 x1; ' +
    '21 outward updates at 11.0 in all, each followed by 6.06); n is small; ' + FIT),
  'L33.wander': row('L33.wander', 'Resting prey: wang moves by a step drawn from this histogram at each update (bin centre plus a uniform point inside the bin)',
    STATUS.SUGGESTED, {
      binWidth: 0.02,
      centres: [-0.30, -0.28, -0.26, -0.24, -0.22, -0.20, -0.18, -0.16, -0.14, -0.12, -0.10, -0.08, -0.06, -0.04, -0.02,
        0, 0.02, 0.04, 0.06, 0.08, 0.10, 0.12, 0.14, 0.16, 0.18, 0.20, 0.22, 0.24, 0.26, 0.28, 0.30],
      counts: [5, 8, 2, 9, 4, 8, 16, 18, 26, 22, 44, 71, 70, 109, 167, 226, 173, 87, 51, 58, 39, 21, 24, 20, 19, 15, 4, 5,
        3, 1, 3],
    }, 'rad',
    'SUGGESTED: T5 fit L33.wander (1328 of 1355 rest steps within 0.31 rad, this histogram; p5 -0.17, p95 0.161; their ' +
    'steps are serially correlated, lag-1 0.235, which independent draws do not reproduce; rule not found); ' + FIT),
  'L33.motion': row('L33.motion', 'Prey motion between updates: the client prediction model (turn mamu2 per 8 ms toward wang, move sp / 32 per ms)',
    STATUS.SUGGESTED, { model: 'client' }, 'model',
    'SUGGESTED: T5 fit L33.motion (their per-update displacement per axis is a multiple of 16 wire units of 3 within 1 on ' +
    '2419 of 3491 updates: their server moves prey in 48-unit steps, not as their client predicts; rule not found; the ' +
    'client model is the L33 text "turning uses mamu2 like the client"); ' + FIT),
  'L33.extra': row('L33.extra', 'Prey off-cycle updates per regular update', STATUS.SUGGESTED, { perUpdate: 0 }, 'probability',
    'SUGGESTED: T5 fit L33.extra (145 of 3610 gaps under 300 ms, in every mode, not tied to a speed or mode change; ' +
    'L33.period "plus 6.7 percent off-cycle extra updates, rule not found"); ' + FIT),
  'L32.remove': row('L32.remove', 'A prey whose position passes the border is removed (prey_remove to every holder)',
    STATUS.SUGGESTED, { atBorder: true }, 'flag',
    'SUGGESTED: T5 fit L32.remove (0 of 157 uneaten removals had the prey inside the watched area: no prey ever vanished ' +
    'in view; standing 0.0098 prey per watched sector, a mean stay of 0.51 min at the L32 rate; the outward run ends at ' +
    'the border; what happens there is not in the data); ' + FIT),
});
const PREY_ROW_IDS = Object.freeze(Object.keys(PREY_ROWS));
const PREY_LAW_IDS = Object.freeze(PREY_TABLE_IDS.concat(PREY_ROW_IDS));

// The prey's rows: the law table's own row when it has the id, else PREY_ROWS.
function preyTable(laws) {
  assertLawsComplete(laws, PREY_TABLE_IDS);
  const t = {};
  for (const id of PREY_TABLE_IDS) t[id] = laws[id];
  for (const id of PREY_ROW_IDS) t[id] = Object.prototype.hasOwnProperty.call(laws, id) ? laws[id] : PREY_ROWS[id];
  return t;
}

// Every prey row that is not shippable (slLaws.notShippable rules), as 'ID (reason)'.
function preyNotShippable(laws) {
  return notShippable(preyTable(laws), PREY_LAW_IDS);
}

function assertPreyShippable(laws) {
  const bad = preyNotShippable(laws);
  if (bad.length) throw new Error('slPrey: prey rows not shippable: ' + bad.join('; '));
  return laws;
}

function bad(id, what) {
  throw new Error('slPrey: law ' + id + ' ' + what);
}

function num(x, id, what) {
  if (typeof x !== 'number' || !Number.isFinite(x)) bad(id, what + ' must be a finite number');
  return x;
}

// The prey laws as plain numbers, checked once.
function preyLaws(laws) {
  const t = preyTable(laws);
  assertLawsComplete(t, PREY_LAW_IDS);
  assertRulesBuilt(t, PREY_LAW_IDS, PREY_RULES);
  const v = (id) => t[id].value;
  const s = v('L32');
  const radBytes = Object.keys(s.radBytes || {}).map(Number).sort((a, b) => a - b);
  if (!radBytes.length) bad('L32', 'needs radBytes');
  const radW = radBytes.map((k) => num(s.radBytes[k], 'L32', 'radBytes count'));
  for (const b of radBytes) if (!(Number.isInteger(b) && b > 0 && b <= 255)) bad('L32', 'rad byte must be 1..255');
  if (!(Number.isInteger(s.colourMin) && Number.isInteger(s.colourMax) && s.colourMin >= 0 && s.colourMax >= s.colourMin &&
    s.colourMax <= 255)) bad('L32', 'needs colourMin <= colourMax');
  const per = v('L33.period');
  if (per.phase !== 'perPrey') bad('L33.period', 'only the per-prey phase is built');
  const fl = v('L33.flee');
  if (fl.turn !== 'mamu2') bad('L33.flee', 'only turning with mamu2 is built');
  const form = v('L33.form');
  if (!(form.sp === 'onChange' && Array.isArray(form.always) && ['dir', 'ang', 'wang'].every((f) => form.always.includes(f)))) {
    bad('L33.form', 'only dir+ang+wang with sp on change is built');
  }
  if (v('L33.outward').from !== 'centre') bad('L33.outward', 'only the run away from the centre is built');
  if (v('L33.motion').model !== 'client') bad('L33.motion', 'only the client model is built');
  if (v('L33.extra').perUpdate !== 0) bad('L33.extra', 'off-cycle updates are not built');
  const out = v('C_OUTSIDE_FOOD');
  if (!out || out.naturalInsideOnly !== true) bad('C_OUTSIDE_FOOD', 'only naturalInsideOnly is built');
  const wd = v('L33.wander');
  if (!Array.isArray(wd.centres) || !Array.isArray(wd.counts) || wd.centres.length !== wd.counts.length ||
    !wd.counts.length) bad('L33.wander', 'needs centres and counts of one length');
  const wTotal = wd.counts.reduce((a, c) => a + num(c, 'L33.wander', 'count'), 0);
  if (!(wTotal > 0)) bad('L33.wander', 'counts sum to 0');
  const fs = v('L33.fleeSp');
  // every prey speed is held as its wire raw: u16 / 1000 (game.js:8430, P:458-467), so the step must be 0.001
  if (num(fs.step, 'L33.fleeSp', 'step') !== 0.001) bad('L33.fleeSp', 'step must be 0.001, the prey sp wire step');
  const raw = (x, id, what) => {
    const r = Math.round(num(x, id, what) * SP_SCALE);
    if (r / SP_SCALE !== x || r < 0 || r > 65535) bad(id, what + ' is not on the 0.001 wire step');
    return r;
  };
  return Object.freeze({
    grd: num(v('L1'), 'L1', 'grd'),
    sectorSize: num(v('L2.size'), 'L2.size', 'size'),
    mamu2: num(v('L5').mamu2, 'L5', 'mamu2'),
    passMs: num(v('L29.period'), 'L29.period', 'period'),
    spawnPerMin: num(s.perSectorMinute, 'L32', 'perSectorMinute'),
    radBytes: Object.freeze(radBytes),
    radW: Object.freeze(radW),
    radWTotal: radW.reduce((a, c) => a + c, 0),
    colourMin: s.colourMin,
    colourMax: s.colourMax,
    spawnR: raw(s.sp, 'L32', 'sp'),
    periodMs: num(per.periodMs, 'L33.period', 'periodMs'),
    dist: num(fl.dist, 'L33.flee', 'dist'),
    offsetMax: num(fl.offsetMax, 'L33.flee', 'offsetMax'),
    restR: raw(fl.restSp, 'L33.flee', 'restSp'),
    outR: raw(v('L33.outward').sp, 'L33.outward', 'sp'),
    fleeA: num(fs.a, 'L33.fleeSp', 'a'),
    fleeB: num(fs.b, 'L33.fleeSp', 'b'),
    pOutward: num(v('L33.afterFlee').pOutward, 'L33.afterFlee', 'pOutward'),
    spontP: num(v('L33.spont').perUpdate, 'L33.spont', 'perUpdate'),
    spontFirstR: raw(v('L33.spont').firstSp, 'L33.spont', 'firstSp'),
    spontThenR: raw(v('L33.spont').thenSp, 'L33.spont', 'thenSp'),
    wanderBin: num(wd.binWidth, 'L33.wander', 'binWidth'),
    wanderCentres: Object.freeze(wd.centres.map((c) => num(c, 'L33.wander', 'centre'))),
    wanderCounts: Object.freeze(wd.counts.slice()),
    wanderTotal: wTotal,
    removeAtBorder: v('L32.remove').atBorder === true,
    quarantineMs: num(v('C_ID_QUARANTINE_MS'), 'C_ID_QUARANTINE_MS', 'value'),
  });
}

// The client's angle helpers, exactly (game.js:4995-5019; slLoop.js wrapAngle, angleGap).
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

// dir for a new wanted angle, in their sense: 2 turns ang up, 1 turns it down, 0 when already there.
function dirOf(ang, wang) {
  const g = angleGap(wang, ang);
  return g > 0 ? 2 : g < 0 ? 1 : 0;
}

const REST = 0;
const FLEE = 1;
const OUT = 2;
const MAX_ID = 65535; // prey ids are u16 on the wire

// opts: rng (the sim's 'prey' stream), startMs (sim time of the room start).
function createPrey(laws, opts) {
  const o = opts || {};
  const K = preyLaws(laws);
  const rng = o.rng;
  if (typeof rng !== 'function' || typeof rng.next !== 'function') throw new TypeError('slPrey: needs a seeded rng stream');
  const startMs = o.startMs === undefined ? 0 : o.startMs;
  if (typeof startMs !== 'number' || !Number.isFinite(startMs)) throw new TypeError('slPrey: startMs must be a finite number');
  // the battle royale only (slSim opts.zone): (x, y) -> false refuses a spawn there AFTER its draws (the stream is the
  // same with or without it) and takes out a prey that is there, as the border does. Absent: as before.
  const accept = typeof o.accept === 'function' ? o.accept : null;

  const SS = K.sectorSize;
  const mapMax = 2 * K.grd; // the map square (L1) a prey can never leave
  const perAxis = Math.ceil(mapMax / SS);
  const live = new Map(); // id -> prey, spawn order
  const freedAt = new Map(); // id -> sim ms it was freed (C_ID_QUARANTINE_MS)
  let nextId = 1;
  let nowMs = startMs;
  let lastMs = startMs;
  let spawnDue = startMs + K.passMs;
  let tickNo = 0;
  const st = { spawned: 0, eaten: 0, removed: 0, updates: 0, passes: 0, outside: 0 };
  const tick = { adds: [], moves: [], removes: [], eats: [] };
  const scratch = [];

  function takeId() {
    for (let tries = 0; tries < MAX_ID; tries++) {
      const id = nextId;
      nextId = nextId >= MAX_ID ? 1 : nextId + 1;
      if (live.has(id)) continue;
      const f = freedAt.get(id);
      if (f !== undefined) {
        if (nowMs - f < K.quarantineMs) continue;
        freedAt.delete(id);
      }
      return id;
    }
    return 0;
  }

  function free(p) {
    live.delete(p.id);
    freedAt.set(p.id, nowMs);
    p.alive = false;
  }

  function needFlux(flux) {
    if (!(typeof flux === 'number' && flux > 0 && Number.isFinite(flux))) throw new RangeError('slPrey: flux must be > 0');
    return flux;
  }

  // ---- spawn (L32)

  function radByteDraw() {
    let u = rng.next() * K.radWTotal;
    for (let i = 0; i < K.radBytes.length - 1; i++) {
      u -= K.radW[i];
      if (u < 0) return K.radBytes[i];
    }
    return K.radBytes[K.radBytes.length - 1];
  }

  // A new prey at (x, y) in the L32 state; draws: rad byte, colour, heading, phase.
  function spawnAt(x, y) {
    const id = takeId();
    if (id === 0) return null;
    const b = radByteDraw();
    const cv = K.colourMin + rng.int(K.colourMax - K.colourMin + 1);
    const ang = rng.next() * PI2;
    const p = {
      id,
      x,
      y,
      b,
      rad: b / 5, // prey_add rad byte / 5 (game.js:8893)
      cv,
      ang,
      wang: ang,
      dir: 0,
      spR: K.spawnR, // speed as its wire raw (sp x 1000); sp = spR / 1000
      sp: K.spawnR / SP_SCALE,
      spJR: K.spawnR, // the raw the prey's last record carried (L33.form)
      mode: REST,
      burst: false, // the first update of a no-threat outward run (L33.spont)
      due: nowMs + rng.next() * K.periodMs, // L33.period: its own phase
      alive: true,
      addEv: null,
      addEvTick: -1,
    };
    live.set(id, p);
    st.spawned++;
    tick.adds.push(p);
    return p;
  }

  // One spawn pass: every sector the border disc touches, row-major; one draw each, then on a spawn x and y and
  // spawnAt's four (rad byte, colour, heading, phase). A point outside the border spawns nothing (C_OUTSIDE_FOOD).
  function pass(flux) {
    needFlux(flux);
    st.passes++;
    const chance = K.spawnPerMin * K.passMs / 60000;
    const c = K.grd;
    const s0 = Math.max(0, Math.floor((c - flux) / SS));
    const s1 = Math.min(perAxis - 1, Math.floor((c + flux) / SS));
    const r2 = flux * flux;
    for (let sy = s0; sy <= s1; sy++) {
      const y0 = sy * SS;
      const dy = c < y0 ? y0 - c : c > y0 + SS ? c - y0 - SS : 0;
      for (let sx = s0; sx <= s1; sx++) {
        const x0 = sx * SS;
        const dx = c < x0 ? x0 - c : c > x0 + SS ? c - x0 - SS : 0;
        if (dx * dx + dy * dy > r2) continue;
        if (!(rng.next() < chance)) continue;
        const x = x0 + rng.next() * SS;
        const y = y0 + rng.next() * SS;
        if ((x - c) * (x - c) + (y - c) * (y - c) > r2 || (accept !== null && !accept(x, y))) {
          st.outside++;
          continue;
        }
        spawnAt(x, y);
      }
    }
  }

  // ---- behaviour at an update (L33.flee and the T5 rows)

  // L33.fleeSp on the 0.001 wire step, as a raw
  function fleeRaw(chaserSp) {
    const r = Math.round((K.fleeA + K.fleeB * chaserSp) * SP_SCALE);
    return r < 0 ? 0 : r > 65535 ? 65535 : r;
  }

  function setSp(p, r) {
    p.spR = r;
    p.sp = r / SP_SCALE;
  }

  // The client's expression of a speed raw (u16 / 1E3)
  function spV(r) {
    return Q.intField(r, Q.U16, 'prey sp') / 1E3;
  }

  function outwardAngle(p) {
    return wrapAngle(Math.atan2(p.y - K.grd, p.x - K.grd));
  }

  function wanderStep() {
    let u = rng.next() * K.wanderTotal;
    let i = 0;
    for (; i < K.wanderCounts.length - 1; i++) {
      u -= K.wanderCounts[i];
      if (u < 0) break;
    }
    return K.wanderCentres[i] + (rng.next() - 0.5) * K.wanderBin;
  }

  // threat(x, y, dist) -> {x, y, sp} of the nearest snake head within dist, or null (the sim's heads; a test's fake).
  function decide(p, threat) {
    const t = threat(p.x, p.y, K.dist);
    if (t) {
      p.mode = FLEE;
      p.wang = wrapAngle(Math.atan2(p.y - t.y, p.x - t.x) + (rng.next() * 2 - 1) * K.offsetMax);
      setSp(p, fleeRaw(t.sp));
    } else if (p.mode === FLEE) {
      if (rng.next() < K.pOutward) {
        p.mode = OUT;
        p.wang = outwardAngle(p);
        setSp(p, K.outR);
      } else {
        p.mode = REST;
        setSp(p, K.restR);
      }
    } else if (p.mode === OUT) {
      p.wang = outwardAngle(p);
      setSp(p, p.burst ? K.spontThenR : K.outR);
      p.burst = false;
    } else if (rng.next() < K.spontP) {
      p.mode = OUT;
      p.wang = outwardAngle(p);
      setSp(p, K.spontFirstR);
      p.burst = true;
    } else {
      p.wang = wrapAngle(p.wang + wanderStep());
      setSp(p, K.restR);
    }
    p.dir = dirOf(p.ang, p.wang);
  }

  // The prey_move of an update (L33.form): position on their 1 + 3 u16 grid, u24 angles, sp only on change.
  function moveEvent(p) {
    const ev = { type: 'prey_move', id: p.id, xx: Q.preyPos(p.x).v, yy: Q.preyPos(p.y).v, dir: p.dir,
      ang: Q.ang24(p.ang).v, wang: Q.ang24(p.wang).v };
    if (p.spR !== p.spJR) {
      ev.sp = spV(p.spR);
      p.spJR = p.spR;
    }
    return ev;
  }

  // ---- motion between updates (L33.motion: their client's own prediction, game.js:4972-5019)

  // In their operation order: mang = mamu2 x vfr and csp = sp x vfr / 4, vfr = dt / 8 (game.js:4973-4974).
  function move(p, dt) {
    const vfr = dt / 8;
    const mang = K.mamu2 * vfr;
    if (p.dir === 1) {
      p.ang = wrapAngle(p.ang - mang);
      if (angleGap(p.wang, p.ang) > 0) {
        p.ang = p.wang;
        p.dir = 0;
      }
    } else if (p.dir === 2) {
      p.ang = wrapAngle(p.ang + mang);
      if (angleGap(p.wang, p.ang) < 0) {
        p.ang = p.wang;
        p.dir = 0;
      }
    } else {
      p.ang = p.wang;
    }
    const csp = p.sp * vfr / 4;
    p.x += Math.cos(p.ang) * csp;
    p.y += Math.sin(p.ang) * csp;
  }

  function removeOne(p) {
    free(p);
    st.removed++;
    tick.removes.push({ id: p.id, ev: { type: 'prey_remove', id: p.id } });
  }

  // ---- the step (SERVER-DESIGN 5.3 step 7)

  function beginTick() {
    tickNo++;
    tick.adds.length = 0;
    tick.moves.length = 0;
    tick.removes.length = 0;
    tick.eats.length = 0;
  }

  // nowMs: sim time; flux: the current border radius; threat: as in decide. Order: every prey moves by the time since
  // the last step, prey past the border (L32.remove) or the map go, due updates run (one per prey per step), then
  // the spawn pass when due.
  function step(now, flux, threat) {
    if (typeof now !== 'number' || !Number.isFinite(now) || now < lastMs) throw new RangeError('slPrey: time must not go back');
    needFlux(flux);
    if (typeof threat !== 'function') throw new TypeError('slPrey: needs a threat lookup');
    nowMs = now;
    const dt = now - lastMs;
    lastMs = now;
    const c = K.grd;
    const r2 = flux * flux;
    for (const p of live.values()) {
      if (dt > 0) move(p, dt);
      const dx = p.x - c;
      const dy = p.y - c;
      if ((K.removeAtBorder && dx * dx + dy * dy > r2) || (accept !== null && !accept(p.x, p.y)) ||
        p.x < 0 || p.y < 0 || p.x >= mapMax || p.y >= mapMax) {
        removeOne(p);
        continue;
      }
      if (now >= p.due) {
        decide(p, threat);
        tick.moves.push(moveEvent(p));
        st.updates++;
        p.due += K.periodMs;
      }
    }
    if (now >= spawnDue) {
      pass(flux);
      spawnDue += K.passMs;
    }
  }

  // ---- eats (L31 zone and L34 value are the sim's)

  function eat(p, eater) {
    if (!Number.isInteger(eater) || eater < 1 || eater > 65535) throw new RangeError('slPrey: eater must be a snake id');
    if (!p || live.get(p.id) !== p) throw new Error('slPrey: that prey is not live');
    free(p);
    st.eaten++;
    const ev = { type: 'prey_eaten', id: p.id, eater };
    tick.eats.push({ id: p.id, eater, ev });
    return ev;
  }

  // fn(prey) for every live prey within r of (cx, cy), spawn order; collected first so fn may eat. Returns the count.
  function forEachInDisc(cx, cy, r, fn) {
    if (!(Number.isFinite(cx) && Number.isFinite(cy) && Number.isFinite(r) && r >= 0)) {
      throw new RangeError('slPrey: disc must be finite');
    }
    scratch.length = 0;
    const r2 = r * r;
    for (const p of live.values()) {
      const dx = p.x - cx;
      const dy = p.y - cy;
      if (dx * dx + dy * dy <= r2) scratch.push(p);
    }
    const n = scratch.length;
    for (let i = 0; i < n; i++) fn(scratch[i]);
    scratch.length = 0;
    return n;
  }

  // ---- records

  // The prey_add of a prey's current state (a seat starts holding it), made once per tick per prey.
  function addEvent(p) {
    if (p.addEvTick !== tickNo || !p.addEv) {
      p.addEv = { type: 'prey_add', id: p.id, cv: p.cv, xx: Q.pos5(p.x).v, yy: Q.pos5(p.y).v, rad: Q.radByte(p.b).v,
        dir: p.dir, wang: Q.ang24(p.wang).v, ang: Q.ang24(p.ang).v, sp: spV(p.spR) };
      p.addEvTick = tickNo;
    }
    return p.addEv;
  }

  // ---- reads

  function get(id) {
    return live.get(id) || null;
  }

  function forEachPrey(fn) {
    for (const p of live.values()) fn(p);
  }

  function stats() {
    return Object.assign({ live: live.size, spawnDue }, st);
  }

  // FNV-1a 32 over every live prey (id order) and the clocks; for the sim digest.
  const F64 = new Float64Array(1);
  const B8 = new Uint8Array(F64.buffer);
  function digest() {
    let h = 0x811c9dc5;
    const mix = (x) => {
      F64[0] = x;
      for (let i = 0; i < 8; i++) {
        h ^= B8[i];
        h = Math.imul(h, 0x01000193);
      }
    };
    const ids = Array.from(live.keys()).sort((a, b) => a - b);
    for (const id of ids) {
      const p = live.get(id);
      mix(id);
      mix(p.x);
      mix(p.y);
      mix(p.ang);
      mix(p.wang);
      mix(p.dir);
      mix(p.spR);
      mix(p.mode);
      mix(p.due);
      mix(p.b);
      mix(p.cv);
    }
    mix(spawnDue);
    mix(nextId);
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  return {
    K,
    tick,
    step,
    pass,
    beginTick,
    spawnAt,
    eat,
    forEachInDisc,
    addEvent,
    get,
    forEachPrey,
    count: () => live.size,
    stats,
    digest,
    fleeSpeed: (chaserSp) => fleeRaw(chaserSp) / SP_SCALE,
  };
}

module.exports = {
  createPrey,
  preyLaws,
  preyTable,
  preyNotShippable,
  assertPreyShippable,
  wrapAngle,
  angleGap,
  dirOf,
  PREY_ROWS,
  PREY_ROW_IDS,
  PREY_TABLE_IDS,
  PREY_LAW_IDS,
  PREY_RULES,
  MODES: Object.freeze({ REST, FLEE, OUT }),
};
