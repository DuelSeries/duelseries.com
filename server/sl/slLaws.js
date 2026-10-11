'use strict';
// slither.io free room: the law table (SERVER-DESIGN 4, task T1). The one place every number of server/sl lives.
//
// One frozen row per id: { id, name, status, value, unit, source } plus approvedAt on APPROVED rows. Ids are the law
// ids of spec/SERVER-LAWS.md (L1 to L51, with a dotted part where one law has parts of different status, for example
// L8.snake) and our own rows (C_*, BOT_*, PICTURE_SKINS). Section N of SERVER-LAWS.md lists every row with the same id,
// value and status; the reference-side check tools/sllaws-check.js prints SLLAWS: IDENTICAL when the two agree.
//
// Statuses:
//   KNOWN       exact from their join packet or stated by their client code
//   MEASURED    a number or hard rule that passed its acceptance bar on Owen's three recordings
//   RULE        the form was found in the data with zero counter-examples and its parameters measured
//   APPROVED    an OPEN, NEEDS_MORE, SUGGESTED or PROPOSED row Owen answered in chat; approvedAt names the
//               OWNER-ANSWERS.md line (2026-10-10, and the five C_* rows Owen answered on 2026-10-11)
//   CHOSEN      ours, engineering only: a player cannot see it (caps, timers, cache sizes)
//   PROPOSED    ours, but a player can see it: waits for Owen like an OPEN row
//   SUGGESTED, OPEN, NEEDS_MORE   not settled; OPEN and NEEDS_MORE may hold no value yet
//   FIXTURE     tests only (test/slLawsFixture.js); never in this table
// A row whose behaviour is a form holds { rule: '<name>', ...params }; the names are server/sl/slRules.js.
//
// Gates: every module calls assertLawsComplete(laws, ids) with the ids it reads and assertRulesBuilt for the rule
// forms it builds. The boot calls assertShippable(LAWS): it refuses any row that is not KNOWN, MEASURED, RULE, CHOSEN
// or APPROVED with approvedAt, so the room stays closed until every row is settled. Tests use the FIXTURE table,
// which no shipped file may import.

const { isRule } = require('./slRules');

const STATUS = Object.freeze({
  KNOWN: 'KNOWN',
  MEASURED: 'MEASURED',
  RULE: 'RULE',
  APPROVED: 'APPROVED',
  CHOSEN: 'CHOSEN',
  PROPOSED: 'PROPOSED',
  SUGGESTED: 'SUGGESTED',
  OPEN: 'OPEN',
  NEEDS_MORE: 'NEEDS_MORE',
  FIXTURE: 'FIXTURE',
});
const SHIPPABLE = new Set([STATUS.KNOWN, STATUS.MEASURED, STATUS.RULE, STATUS.APPROVED, STATUS.CHOSEN]);
const ALL_STATUS = new Set(Object.keys(STATUS));
// Rows that may exist before their value does (the value comes from more play, a measurement or Owen).
const MAY_BE_EMPTY = new Set([STATUS.OPEN, STATUS.NEEDS_MORE]);

// ---------------------------------------------------------------------------------------------------------------
// Row builders. Every source starts with its status word and names the SERVER-LAWS law, the design section or the
// OWNER-ANSWERS line it comes from.

const SL = 'SERVER-LAWS ';
const OA = 'OWNER-ANSWERS.md:';
const DAY = '2026-10-10';
// The five PROPOSED rows Owen answered (OWNER-ANSWERS.md:120-126) and the room caps he chose (OWNER-ANSWERS.md:136-139).
const DAY2 = '2026-10-11';
// Provenance of the T5 prey fit rows (the reference side's tool and its output; never read at run time).
const PREY_FIT = 'the T5 fit: tools/t5-prey-fit.js, recordings/T5-prey-fit.txt';

function law(id, name, status, value, unit, source, approvedAt) {
  const e = { id, name, status, value, unit, source };
  if (approvedAt !== undefined) e.approvedAt = approvedAt;
  return e;
}
function known(id, name, value, unit, from) {
  return law(id, name, STATUS.KNOWN, value, unit, 'KNOWN: ' + SL + from);
}
function measured(id, name, value, unit, from) {
  return law(id, name, STATUS.MEASURED, value, unit, 'MEASURED: ' + SL + from);
}
function rule(id, name, value, unit, from) {
  return law(id, name, STATUS.RULE, value, unit, 'RULE FOUND: ' + SL + from);
}
// line: the OWNER-ANSWERS.md line of Owen's answer; what: his answer in short; from: where the value comes from.
function approvedOn(day, id, name, value, unit, line, what, from) {
  return law(id, name, STATUS.APPROVED, value, unit,
    'APPROVED by Owen ' + day + ' (' + OA + line + ' ' + what + '); ' + from, day + ' ' + OA + line);
}
function approved(id, name, value, unit, line, what, from) {
  return approvedOn(DAY, id, name, value, unit, line, what, from);
}
function chosen(id, name, value, unit, from) {
  return law(id, name, STATUS.CHOSEN, value, unit, 'CHOSEN: ' + from);
}
// No row is PROPOSED or NEEDS_MORE since 2026-10-11 (Owen's five answers and the 101 caps); a new one would be built
// with law(id, name, STATUS.PROPOSED, value, unit, 'PROPOSED (waits for Owen): ' + from) and keeps the room closed.

// ---------------------------------------------------------------------------------------------------------------
// Tables that are too long to sit inline.

// L24, L39 skin drop colours (SERVER-LAWS Appendix 4; Owen Q10 at OWNER-ANSWERS.md:87). Weights per dropped colour.
// measured: the 35 patterned skins seen dying (death drops, combined run). pattern: the 22 patterned skins never seen
// dying, from the frozen client's stripe table (public/js/sl/slSprites.js STRIPES): each pattern entry that is a plain
// colour 0 to 8 counts once; a skin with none drops cv mod 9. Plain colours 0 to 8 drop their own colour (MEASURED).
// Custom skins are not offered by our client, so their rows of Appendix 4 are not carried.
const SKIN_DROP = {
  rule: 'skinDropTable',
  plain: 'own',
  measured: {
    9: { 0: 92, 1: 300, 2: 18, 3: 22, 4: 11, 5: 11, 6: 79, 7: 320, 8: 21 },
    10: { 0: 2, 1: 192, 2: 14, 3: 10, 4: 22, 5: 2, 6: 7, 7: 16, 8: 2 },
    11: { 0: 3, 1: 1117, 3: 1, 4: 6 },
    13: { 3: 111, 4: 105, 5: 3, 7: 1 },
    15: { 0: 28, 1: 42, 2: 30, 3: 28, 4: 29, 5: 29, 6: 29, 7: 30, 8: 29 },
    16: { 1: 178, 2: 8, 3: 19, 4: 78, 5: 11, 7: 17, 8: 8 },
    18: { 1: 46, 2: 14, 4: 368, 7: 41 },
    19: { 5: 1879 },
    20: { 0: 160, 3: 162 },
    21: { 0: 14, 1: 1, 2: 15, 3: 2, 4: 2 },
    24: { 1: 20, 4: 53, 5: 33 },
    25: { 1: 21, 5: 23 },
    26: { 0: 124, 1: 31, 3: 137, 4: 664, 7: 10, 8: 16 },
    27: { 3: 5 },
    28: { 5: 26, 6: 13, 7: 76, 8: 17 },
    29: { 1: 6, 4: 57, 7: 3 },
    30: { 1: 527 },
    31: { 1: 299, 4: 36, 7: 111 },
    37: { 5: 101 },
    39: { 0: 372, 1: 179, 2: 7, 4: 52, 8: 112 },
    40: { 3: 50 },
    41: { 1: 7, 5: 6, 7: 26 },
    42: { 2: 25, 3: 26, 5: 26, 7: 26 },
    44: { 1: 178 },
    49: { 2: 61 },
    53: { 1: 134 },
    54: { 7: 52 },
    55: { 4: 11 },
    56: { 5: 37 },
    57: { 0: 47 },
    58: { 3: 18 },
    60: { 1: 25, 7: 26 },
    63: { 7: 100 },
    64: { 1: 281 },
    65: { 2: 619 },
  },
  pattern: {
    12: { 7: 5 }, 14: { 7: 7 }, 17: { 8: 1 }, 22: { 5: 7 }, 23: { 7: 7 }, 32: { 5: 1 }, 33: { 6: 1 }, 34: { 7: 4 },
    35: { 6: 2, 7: 2 }, 36: { 0: 1 }, 38: { 2: 1 }, 43: { 7: 1 }, 45: { 7: 6 }, 46: { 7: 1 }, 47: { 7: 8 },
    48: { 7: 1 }, 50: { 7: 8 }, 51: { 7: 3 }, 52: { 7: 9 }, 59: { 5: 1 }, 61: { 7: 1 }, 62: { 8: 1 },
  },
  otherwise: 'cvMod9',
};

// L39 death drop rad bytes (rad = byte / 5): SERVER-LAWS Appendix 2, the build rule through the measured points.
const DEATH_RAD_POINTS = [
  [89, 68], [90, 69], [127, 69], [129, 70], [147, 70], [155, 71], [168, 71], [172, 72], [180, 72], [189, 73],
  [198, 73], [214, 75], [230, 77], [237, 77], [248, 79], [262, 81],
];

// L32 prey rad bytes at spawn (204 adds, SERVER-LAWS L32): byte -> count.
const PREY_RAD_BYTES = {
  30: 45, 31: 30, 32: 24, 33: 13, 34: 21, 35: 21, 36: 12, 37: 11, 38: 7, 39: 2, 40: 7, 41: 2, 42: 5, 43: 2, 44: 1, 45: 1,
};

// ---------------------------------------------------------------------------------------------------------------
// The table.

const ENTRIES = [
  // A. Join constants (packet a)
  known('L1', 'Map centre grd; the map is the disc of radius flux_grd around (grd, grd)', 32550, 'world units',
    'L1 (packet a on 31 of 31 sockets)'),
  known('L2.size', 'Sector size', 300, 'world units', 'L2'),
  known('L2.count', 'Sector count along edge, sent as is', 102, 'sectors', 'L2 (300 x 102 is not 2 grd; sent as is)'),
  known('L3', 'mscps', 430, 'body points', 'L3'),
  known('L4', 'Speed constants', { nsp1: 5.39, nsp2: 0.4, nsp3: 14, spangdv: 4.8 }, 'speed units', 'L4'),
  known('L5', 'Turn and body constants', { mamu: 0.033, mamu2: 0.029, cst: 0.43, msl: 42 },
    'mamu, mamu2 rad per 8 ms; cst ratio; msl world units', 'L5'),
  known('L6', 'Protocol, game mode, extra byte', { protocol: 19, gameMode: 1, extraB: 0 }, 'packet fields', 'L6'),
  approved('L6.realSid', 'Server number sent in init (0 = no "server N" label)', 0, 'id', 41,
    'Q12 HUD: everything theirs except the server N label', SL + 'L6 (theirs 3619; their client prints nothing for 0)'),

  // B. Timing and what each player is sent
  measured('L7', 'Snake update period (move, turn, speed ramp); at most one own move per message', 42.67, 'ms',
    'L7 (decided 42.67 inside diag [42.647, 42.771] and verif [42.581, 42.685]; fixed, run drift not reproduced)'),
  rule('L8.anchor', 'View anchor ahead of the head',
    { rule: 'anchorAhead', from: 'continuousHead', a: 48.2, b: 7.66, lastPointA: 69.24, lastPointB: 7.727 },
    'world units; b per speed unit',
    'L8 (anchor = head + (a + b sp) along ang; from the last sent point the same anchor is lastPointA + lastPointB sp; ' +
    'which head their server uses is not separable, SERVER-LAWS L8 builds from the continuous head, CHOSEN)'),
  rule('L8.R2', 'View set: sectors i^2 + j^2 <= R2 around the anchor sector, recomputed only when the anchor enters a new sector',
    { rule: 'r2BySct', small: 13, large: 20, stepSct: 92, recompute: 'anchorSectorChange' }, 'sectors squared',
    'L8 (R2 = 20 iff own sct >= 92 at the recompute, else 13; 10406 later adds, 0 outside)'),
  approved('L8.R2.high', 'View R2 above the largest measured size (own sct over 196)', { rule: 'noFurtherStep' },
    'rule', 95, 'extra session skipped, NEEDS_MORE laws use the suggested values',
    SL + 'L8 size steps (SUGGESTED: R2 = 20 for every sct >= 92)'),
  approved('L8.R2.shrink', 'View R2 for a life that shrinks back below sct 92', { rule: 'followCurrentSct' }, 'rule',
    95, 'extra session skipped, L8 shrink-back uses the suggested value',
    SL + 'L8 size steps (SUGGESTED: R2 follows the current sct at each recompute)'),
  rule('L8.adds', 'Sector adds: a sector entering the set sends its food dump at once, nothing when empty; the whole set at spawn',
    { rule: 'dumpOnEnter', emptySends: false, spawnSet: 'whole' }, 'rule', 'L8 (1341 spawn sectors over 31 spawns)'),
  rule('L8.emptySector', 'An empty sector in the view set still counts as watched: later food records into it are sent, and it is removed on the sweep like any other',
    { watched: true, sendsFood: true, removeOnSweep: true }, 'flags',
    'L8 (T0 check, recordings/T0-checks.txt: 84 f and 161 b opened never-dumped watched sectors; 696 of 10707 removals were ' +
    'for sectors that never had food)'),
  rule('L8.sweep', 'Sector removal sweep period', 503.91, 'ms', 'L8 ([503.79, 504.02])'),
  rule('L8.linger', 'A sector outside the set goes at the first sweep after it was out this long', 2700, 'ms',
    'L8 (T in (2677.3, 2726.5]; build value 2700; 10072 removals, 0 against T)'),
  rule('L8.snakeAdd', 'Snake interest: held while a pulled body point lies in a kept sector (view set plus sectors not yet swept)',
    { rule: 'pulledPointInKept' }, 'rule', 'L8 (1360 of 1363 adds fit; 0 of 869 removals while a pulled point was watched)'),
  approved('L8.snake', 'Snake retention: code-0 removal once no pulled point lay in a kept sector for keepMs',
    { rule: 'retainAfterUnwatched', keepMs: 4400 }, 'ms', 90, 'Q12 view retention: 4.4 seconds, the longest seen, not 3',
    SL + 'L8 snakes (retention OPEN; kept up to about 4.4 s, median 3088 ms; only 3 of 597 removals end on a sweep, ' +
    'so the removal is not tied to the sweep)'),
  measured('L9', 'Leaderboard: period, rows, order', { periodMs: 3008.4, rows: 10, order: 'sctFamDesc' }, 'ms; rows',
    'L9 ([3008.31, 3008.49], 618 packets, 0 out of order)'),
  rule('L10', 'Minimap: period, size, first image full, raster of pulled body points',
    { rule: 'discRaster', periodMs: 2504.2, size: 136, firstFull: true }, 'ms; pixels',
    'L10 (pixel = floor((136 - 1) / 2 x (1 + (x - grd) / flux_grd)); 99.81 percent of pulled points on a lit pixel)'),
  chosen('L10.mv', 'Minimap after the first image: full or XOR, whichever encodes smaller', { rule: 'smallerOfMV' },
    'rule', SL + 'L10 (no visible difference; their choice matches the smaller encoding in 647 of 656)'),
  rule('L11.cadence', 'Border z per player: the first check always sends z, then only when the integer flux_grd changed',
    { rule: 'zCadence', firstCheckAlways: true, onlyOnIntegerChange: true, fastAfterDeath: true }, 'rule',
    'L11 (8 of 31 first z equal to a; 0 of 3324 repeats; 58 z after the own death)'),
  rule('L11.slow', 'Slow border check period (half slots of the leaderboard timer)', 1504.31, 'ms', 'L11 (723 of 723)'),
  rule('L11.fast', 'Fast border check period while the own head is within L11.T of the border', 127.43, 'ms',
    'L11 (pooled [127.42, 127.45])'),
  approved('L11.T', 'Fast border checks while the own head is within this distance of the border', 2500, 'world units',
    77, 'Q1 crowding [L51, L11]: like theirs', SL + 'L11 (T in (2492.6, 2534.6], SUGGESTED 2500)'),
  approved('L11.step', 'Border motion: at most this many units per fast check period', { units: 6, everyMs: 127.43 },
    'world units per ms period', 77, 'Q1 crowding: border moves at most about 47 units/s',
    SL + 'L11 and section M item 3 (the fastest the real border moved)'),
  approved('L11.driver', 'Border target R* = sqrt(N x L51 / pi) from the live snake count (players and bots); integer flux; flux = R* at room start',
    { rule: 'crowdDensity', count: 'allSnakes', integer: true, start: 'target' }, 'rule', 77,
    'Q1 crowding: like theirs, one snake per 1.22 M square units', SL + 'section M items 2, 3'),
  measured('L47', 'Ping: exactly one pong per ping while the socket is open', { rule: 'pongPerPing' }, 'rule',
    'L47 (6932 pings, 6930 pongs, 0 extra)'),
  measured('L48.move', 'Move form: angle form iff the segment angle iang changed, else the short form',
    { rule: 'angleFormOnIangChange' }, 'rule', 'L48 (96831 moves, 0 off)'),
  approved('L48.abs', 'Absolute move form only for a snake first point after spawn', { rule: 'absFirstPointOnly' },
    'rule', 89, 'Q12 technical details [L48]: their pattern', SL + 'L48 (SUGGESTED; 118 of 124 fresh spawns, 31 of 31 own)'),
  approved('L48.rot', 'Rotation records: changed bytes, ang on every packet while turning, an ang-only refresh this long after the previous rotation packet',
    { rule: 'rotChanged', angWhileTurning: true, refreshMs: 205 }, 'ms', 94,
    'Q12 direction refresh: every 0.2 s like theirs', SL + 'L48 (SUGGESTED 205; real mean 204.8, p5 187, p95 223)'),
  rule('L48.order', 'Record order per snake inside one bundle: tail removal and fam first (either order), then the rotation, then the move or grow, then that snake\'s food eats, then its prey eats',
    ['tailFam', 'rot', 'move', 'foodEat', 'preyEat'], 'order',
    'L48 (T0 check, recordings/T0-checks.txt: 406953 groups, 0 out of this order; it replaces SERVER-DESIGN 5.4\'s fam after the move)'),
  chosen('L48.hDefer', 'The fam record of an eat goes at the eater\'s next update, first among its records, never in the eat\'s own bundle',
    'nextUpdate', 'mode',
    SL + 'L48 (T0 check: an eat\'s h is never in the eat\'s message, 0 of 29445, median 36.6 ms later; the exact h cadence OPEN, invisible)'),
  chosen('L48.angRound', 'Rounding of the 8-bit rotation ang byte', 'floor', 'rounding',
    SL + 'L48 (T0 check: not separable on the wire, the two anchors disagree; floor like the L15 wang map and L17 fam, ' +
    'at most one byte for one update)'),

  // C. Movement
  rule('L12', 'Normal speed sp = nsp1 + nsp2 sc(m), sc(m) = min(scCap, 1 + (m - 2) / scDiv), m = length at spawn or boost end',
    { rule: 'speedBase', scDiv: 106, scCap: 6, setAt: 'spawnAndBoostEnd', wireS: 'trunc1000', wireRot: 'trunc18' },
    'speed units', 'L12 (never re-set on growth; 877 long s, 1404 boost ends, 0 off; trunc beats round)'),
  rule('L13.ramp', 'Boost ramp: per update sp += (nsp3 - ssp) / N_up, after boost sp -= (nsp3 - ssp) / N_down, N_up = n0 + perPoint (sct - 2) / div, N_down = downRatio N_up',
    { rule: 'rampN', n0: 12.5, perPoint: 4, div: 111, downRatio: 0.75 }, 'updates',
    'L13 (plateau nsp3 at every length; 2318 up and 2854 down runs)'),
  approved('L13.first', 'First ramp step after a 253 or 254: the step times (press to update ms) / update period',
    { rule: 'offsetFraction', periodMs: 42.67 }, 'ms', 91, 'Q12 first boost speed step: copy what slither does',
    SL + 'L13 (SUGGESTED; partial first step grows with the press delay)'),
  rule('L14', 'Turn per ms toward wang: (mamu / 8) spang scang(sc\'), sc\' = min(scCap, 1 + (sct - 2) / div), current sct',
    { rule: 'turnK', div: 111, scCap: 6, perMs: true }, 'rad per ms',
    'L14 (K 111 inside 111.1 [110.75, 111.45] and 110.5 [110.0, 111.1])'),
  rule('L15', 'Input bytes: 0 to maxAngle set wang = 2 pi floor(256 b / 251) / 256; ping, arrow turn, boost on, boost off; read in order',
    { rule: 'wangFromByte', maxAngle: 250, ping: 251, arrow: 252, boostOn: 253, boostOff: 254 }, 'bytes',
    'L15 (24425 of 24425 own wanted angles)'),
  measured('L16', 'Server body: pull the chain like the client BEFORE adding each new point', { rule: 'pullBeforePush' },
    'rule', 'L16 (909 bodies 0 off; the client order is off on all)'),

  // D. Length and growth
  known('L17', 'Length L = sct + fam and score, the client formulas', { rule: 'slCoreScore' }, 'rule', 'L17'),
  rule('L17.famRound', 'Wire fam raw = floor(min(1, fam) x 16777215)', 'floor', 'rounding',
    'L17 (T0 check, recordings/T0-checks.txt: floor 382 decisive matches, 0 misses on 138 fresh snakes; round misses 179)'),
  rule('L18', 'Food value: fam += K b^2 x (1 - Lq / mscps)^exp, Lq = (floor(100 (sct - 1 + fam)) + 1) / 100; one point per move while fam >= 1; wire fam clamped at 1',
    { rule: 'famGain', K: 1.2681186e-4, exp: 2.25 }, 'fam per rad-byte^2',
    'L18 (784 and 696 windows, 0 misses; K exact range [1.26811862e-4, 1.26811868e-4])'),
  rule('L18.when', 'A grow is the snake\'s regular msl move; it never adds an extra point between moves', 'regularMove', 'mode',
    'L18 (T0 check: grow and plain move intervals both median 1.01 of the msl travel; 0 bundles with a grow and another move)'),
  approved('L19', 'Largest length: no separate cap; the multiplier clamps at 0 once Lq >= mscps', { rule: 'lqClampZero' },
    'rule', 83, 'Q6 max length: no cap, growth slows to nothing near 430', SL + 'L19 (SUGGESTED)'),
  measured('L20', 'Spawn state: sct 2, fam 0, sp 5.79, two points msl apart in a line, ang = wang = a uniform heading',
    { sct: 2, fam: 0, sp: 5.79, points: 2, gap: 42, heading: 'uniform' }, 'mixed', 'L20 (31 of 31 own lives)'),
  approved('L21', 'Length lost without boosting: none', { rule: 'noDecay' }, 'rule', 84, 'Q7 shrinking: never without boosting',
    SL + 'L21 (no gradual decay MEASURED over 8923 s; the 2 s point loss not reproduced, SUGGESTED)'),

  // E. Boost
  measured('L22', 'Boost starts at a 253 iff L = sct + fam > minL, decided at the press', { rule: 'boostStart', minL: 2.14 },
    'length', 'L22 (558 presses, 0 counter-examples; T in (2.1091, 2.15147], decided 2.14)'),
  rule('L23.period', 'Boost charge clock: the first charge at the accepted 253, then one every period, on the snake own clock',
    { periodMs: 155.2, start: 'press' }, 'ms', 'L23 (decided 155.2 inside 155.24 [155.135, 155.346] and 155.18 [155.07, 155.30])'),
  rule('L23.form', 'Each charge: c uniform in [lo, hi], fam -= c x mult (L18 mult before the charge); fam < 0 drops the tail point and fam += 1; at sct 2 fam clamps to 0 and the boost ends with no drop',
    { rule: 'charge' }, 'rule', 'L23 (KS against uniform p 0.94 on 1786 own charges)'),
  measured('L23.low', 'Charge edges for sct 2 to maxSct', { maxSct: 6, lo: 0.07754, hi: 0.08892 }, 'mass',
    'L23 (lo [0.07753, 0.07755], hi [0.08891, 0.08893], n 1684)'),
  approved('L23.edges', 'Charge edges above sct 6: lo = lo[0] + lo[1] s^2 + lo[2] s^3, hi likewise, s = sct - 6, continued past sct 330',
    { rule: 'chargeEdgesCubic', fromSct: 6, lo: [0.07754, 9.6777e-7, 1.07617e-9], hi: [0.08892, 1.16096e-6, 1.47469e-9] },
    'mass', 88, 'Q11 boost cost: smooth curve through all measured lengths, continued past the biggest',
    SL + 'L23 (SUGGESTED fit to Appendix 1, rms 0.58 / 0.63 percent)'),
  measured('L24.Td', 'A charge drops one food at the tail iff the length before it is above minL', { rule: 'dropOnCharge', minL: 2.14 },
    'length', 'L24 (Td in (2.13739, 2.14595]; 30 charges at or below 2.13739 drop nothing)'),
  rule('L24.size', 'Boost drop rad byte = round(alpha sqrt(c) + beta), c the charge before the multiplier',
    { rule: 'dropByte', alpha: 84.2853, beta: 0.1702 }, 'rad byte', 'L24 (0 misses on 3756 and 3115 own pairs at the centre values)'),
  approved('L24.place', 'Boost drop place: the oldest pulled point plus a uniform random point in a disc of this radius',
    { rule: 'tailTipDisc', radius: 10 }, 'world units', 92, 'Q12 boost food position: at the tail tip, within 10 units',
    SL + 'L24 (SUGGESTED: at the oldest pulled point, offset by up to 10 units)'),
  approved('L24.colour.skin', 'Boost drop colour: plain colours their own; skins by the weight table', SKIN_DROP,
    'colour weights', 87, 'Q10 skin drop colours: measured for the skins seen, others the plain colours in the pattern',
    SL + 'L24 and Appendix 4 (plain colours MEASURED 2659 of 2659)'),

  // F. Food
  rule('L25', 'Food record per context: natural spawn slow pop-in, every snake drop fast pop-in, sector dump',
    { rule: 'packetByContext', natural: 'f', drop: 'b', dump: 'F' }, 'packet form',
    'L25 (natural 7720 f / 7 b, boost 23004 b, death 17533 b / 0 f)'),
  approved('L26', 'Natural food target per sector by fraction f of the border radius (band upper edge, value)',
    { rule: 'radialProfile', bands: [[0.08, 5.9], [0.16, 3.8], [0.56, 3.6], [0.72, 3.2], [0.88, 2.3], [1, 1]] },
    'foods per sector', 78, 'Q2 food: theirs scaled to our map, dense middle, sparse edge',
    SL + 'L26 (SUGGESTED; natural part 3.23 per non-empty sector; the distance table divided by flux 12500)'),
  rule('L27', 'Natural food rad byte = base + floor(span u), u uniform on [0, 1)', { rule: 'naturalRadByte', base: 15, span: 32.5 },
    'rad byte', 'L27 (9849 f, support 15 to 47, chi-square p 0.63 to 0.68)'),
  approved('L28', 'Natural food colours 0 to 8 with fixed percent weights',
    { rule: 'weightedColour', weights: [6.0, 33.3, 8.3, 9.5, 7.9, 7.1, 2.4, 19.7, 5.8] }, 'percent', 86,
    'Q9 food colours: the average mix we saw, fixed', SL + 'L28 (SUGGESTED pooled n 9457; support 0 to 8 RULE FOUND)'),
  measured('L29.period', 'Natural food spawn pass period', 503.92, 'ms', 'L29 ([503.81, 504.03])'),
  approved('L29.rate', 'Natural spawn per pass: each sector inside the border spawns one with chance rate(f) x period / 1000 while it holds fewer natural foods than guardMult x its L26 target; rate per second by fraction f of the radius (band upper edge, rate)',
    { rule: 'batchByDistance', guardMult: 2, bands: [[0.08, 0.231], [0.16, 0.155], [0.24, 0.13], [0.32, 0.083],
      [0.4, 0.083], [0.48, 0.088], [0.56, 0.067], [0.64, 0.038], [0.72, 0.048], [0.8, 0.042], [0.88, 0.022], [1, 0.018]] },
    'spawns per sector per second', 78,
    'Q2 food: their spawn rate, an area stops adding natural food at 2x the normal amount',
    SL + 'L29 (SUGGESTED; Appendix 3 rate column by distance / 12500 as L26 does; the 12000 band has no rate, so ' +
    'the 11000 value runs to the edge)'),
  approved('L30', 'Food expiry: never', { rule: 'noExpiry' }, 'rule', 79, 'Q2 food: food never expires',
    SL + 'L30 (0 decay packets; the same food seen 548 s apart)'),
  approved('L31', 'Eat zone: every food inside a disc ahead of the head, centre head + sp (k0 + k1 sc) along a direction halfway between ang and wang, radius r0 + r1 sc, every update',
    { rule: 'eatDisc', k0: 5.98, k1: 2.26, r0: 17.8, r1: 17.96, lean: 'halfway', every: 'update' }, 'world units',
    80, 'Q3 eating: their front circle exactly', SL + 'L31 (SUGGESTED; form found by both groups)'),

  // G. Prey
  approved('L32', 'Prey spawn: each sector inside the border with this chance per minute; rad byte by the counts; colour uniform 0 to 8; speed 3.8',
    { rule: 'preySpawn', perSectorMinute: 0.0193, radBytes: PREY_RAD_BYTES, colourMin: 0, colourMax: 8, sp: 3.8 }, 'mixed', 85,
    'Q8 prey: as measured', SL + 'L32 (SUGGESTED; 14 spawns, 204 adds)'),
  measured('L33.period', 'Prey update period, each prey on its own phase', { periodMs: 337.75, phase: 'perPrey' }, 'ms',
    'L33 ([337.36, 338.13]; plus 6.7 percent off-cycle extra updates, rule not found)'),
  approved('L33.flee', 'Prey flee: within dist of a head, wanted angle away from the nearest head plus a random offset up to offsetMax; restSp at rest; turning with mamu2 (the built speeds of a fleeing and an outward prey are L33.fleeSp and L33.outward; midSp and fleeSp here are the measured levels they replace)',
    { rule: 'preyFlee', dist: 300, offsetMax: 0.25, restSp: 3.8, midSp: [6.06, 6.4], fleeSp: 11, turn: 'mamu2' },
    'world units; rad; speed units', 85, 'Q8 prey: as measured',
    SL + 'L33 (SUGGESTED; the ramp between speed levels is not given there)'),
  // The T5 fit's prey rows (task T5, server/sl/slPrey.js PREY_ROWS, copied here by the fixer pass of 2026-10-10 so the
  // shipped table carries them and prey ships; a test keeps both copies equal). The five SUGGESTED ones are APPROVED
  // under Owen's prey answer "as measured" (Q8) and his approval of every open law with its suggested value.
  rule('L33.form', 'Prey update record: every j carries dir, ang and wang; sp only when it changed since the prey last j',
    { always: ['dir', 'ang', 'wang'], sp: 'onChange' }, 'form',
    'L33 (T5 fit L33.form: 3808 j, 2799 dir+ang+wang, 1009 with sp; 987 carry a new sp, the other 22 repeat it in the ' +
    'first j after a prey_add; 0 counter-examples; ' + PREY_FIT + ')'),
  rule('L33.outward', 'Prey outward run: wang exactly away from the map centre (grd, grd), at this speed',
    { sp: 6.06, from: 'centre' }, 'speed units',
    'L33 (T5 fit L33.outward: 866 of 866 updates holding sp 6.06 head away from (grd, grd) within 0.02 rad, the wire ' +
    'grid; the 6.06 level of L33.flee midSp; ' + PREY_FIT + ')'),
  measured('L33.fleeSp', 'Prey flee speed: a + b x the chasing snake current speed, rounded to the 0.001 wire step',
    { a: 2.736829476, b: 0.590012180, step: 0.001 }, 'speed units',
    'L33 (T5 fit L33.fleeSp: fixed by 6.153 at a chaser of 5.79, L20, and 10.997 at a boosting chaser of 14, nsp3; 96 ' +
    'of 98 plateau speeds inside the chaser wire interval, |residual| p50 0.009; replaces L33.flee midSp and fleeSp for ' +
    'fleeing prey; ' + PREY_FIT + ')'),
  measured('L33.afterFlee', 'When a flee ends: the prey runs outward with this chance, else rests', { pOutward: 0.326 },
    'probability', 'L33 (T5 fit L33.afterFlee: 79 outward of 242 flee ends; outward goes back to rest 4 of 792 updates; ' +
    PREY_FIT + ')'),
  approved('L33.spont', 'A resting prey turns outward with no threat with this chance per update, first at firstSp then thenSp',
    { perUpdate: 0.0045, firstSp: 11, thenSp: 6.06 }, 'probability; speed units', 85, 'Q8 prey: as measured',
    SL + 'L33 (SUGGESTED by the T5 fit L33.afterFlee: 7 of 1550 rest updates turn outward with no flee; speeds 11.0 x3, ' +
    '3.8 x3, 6.06 x1; 21 outward updates at 11.0 in all, each followed by 6.06; n is small; ' + PREY_FIT + ')'),
  approved('L33.wander', 'Resting prey: wang moves by a step drawn from this histogram at each update (bin centre plus a uniform point inside the bin)',
    {
      binWidth: 0.02,
      centres: [-0.30, -0.28, -0.26, -0.24, -0.22, -0.20, -0.18, -0.16, -0.14, -0.12, -0.10, -0.08, -0.06, -0.04, -0.02,
        0, 0.02, 0.04, 0.06, 0.08, 0.10, 0.12, 0.14, 0.16, 0.18, 0.20, 0.22, 0.24, 0.26, 0.28, 0.30],
      counts: [5, 8, 2, 9, 4, 8, 16, 18, 26, 22, 44, 71, 70, 109, 167, 226, 173, 87, 51, 58, 39, 21, 24, 20, 19, 15, 4, 5,
        3, 1, 3],
    }, 'rad', 85, 'Q8 prey: as measured',
    SL + 'L33 (SUGGESTED by the T5 fit L33.wander: 1328 of 1355 rest steps within 0.31 rad, this histogram; p5 -0.17, ' +
    'p95 0.161; their steps are serially correlated, lag-1 0.235, which independent draws do not reproduce; rule not ' +
    'found; ' + PREY_FIT + ')'),
  approved('L33.motion', 'Prey motion between updates: the client prediction model (turn mamu2 per 8 ms toward wang, move sp / 32 per ms)',
    { model: 'client' }, 'model', 85, 'Q8 prey: as measured',
    SL + 'L33 (SUGGESTED by the T5 fit L33.motion: their per-update displacement per axis is a multiple of 16 wire units ' +
    'of 3 within 1 on 2419 of 3491 updates: their server moves prey in 48-unit steps, not as their client predicts; ' +
    'rule not found; the client model is the L33 text "turning uses mamu2 like the client"; ' + PREY_FIT + ')'),
  approved('L33.extra', 'Prey off-cycle updates per regular update', { perUpdate: 0 }, 'probability', 85,
    'Q8 prey: as measured',
    SL + 'L33 (SUGGESTED by the T5 fit L33.extra: 145 of 3610 gaps under 300 ms, in every mode, not tied to a speed or ' +
    'mode change; L33.period "plus 6.7 percent off-cycle extra updates, rule not found"; ' + PREY_FIT + ')'),
  approved('L32.remove', 'A prey whose position passes the border is removed (prey_remove to every holder)',
    { atBorder: true }, 'flag', 85, 'Q8 prey: as measured',
    SL + 'L32 (SUGGESTED by the T5 fit L32.remove: 0 of 157 uneaten removals had the prey inside the watched area: no ' +
    'prey ever vanished in view; standing 0.0098 prey per watched sector, a mean stay of 0.51 min at the L32 rate; the ' +
    'outward run ends at the border; what happens there is not in the data; ' + PREY_FIT + ')'),
  rule('L34', 'Prey value: fam += Kp rad^2 x mult (L18 mult before the eat), applied once at the eat',
    { rule: 'preyGain', Kp: 0.0958111 }, 'fam per rad^2', 'L34 (rad 6 at sct 3 and 7 give 3.4492013 both)'),

  // H. Collisions and death
  approved('L35', 'Collision: the test point head + f1 sc_victim along ang dies within a sc_other of another snake body (capsules between pulled points) or head',
    { rule: 'collideB', f1: 14.5, a: 14.5, body: 'capsule' }, 'world units per sc', 95,
    'extra session skipped, L35 uses the suggested values', SL + 'L35 (form RULE FOUND; constants SUGGESTED)'),
  approved('L36', 'Head against head in the same update: only one dies; the bigger snake by L = sct + fam lives, the smaller dies; equal L a seeded coin flip, never join order',
    { rule: 'biggerWins', size: 'L', tie: 'seededCoin' }, 'rule', 93,
    'Q12 head-on at the same instant: the bigger snake wins, equal size a coin flip, never join order',
    SL + 'L36 (one victim MEASURED, 61 of 61; the tie rule is Owen\'s, replacing the deeper-test-point suggestion)'),
  measured('L37', 'A snake never dies on its own body', { rule: 'ownBodySafe' }, 'rule', 'L37 (1360 crossings, 0 deaths)'),
  approved('L38', 'Border death: |P - (grd, grd)| > flux_grd + m with P the L35 test point at f1; no drops',
    { rule: 'borderKill', f1: 14.5, m: 0 }, 'world units', 95, 'extra session skipped, L38 uses the suggested values',
    SL + 'L38 (SUGGESTED f1 14.5, m 0)'),
  approved('L39.count', 'Death drops: perPoint per body point plus extra; border deaths drop none',
    { rule: 'deathDrops', perPoint: 2, extra: 1, border: 0 }, 'foods', 81, 'Q4 death food: always 2 per segment + 1',
    SL + 'L39 (SUGGESTED 2 sct + 1; exact in 152 of 163)'),
  approved('L39.rad', 'Death drop rad byte by victim sct: round(linear interpolation through the points), below the first and above the last held',
    { rule: 'interpTable', points: DEATH_RAD_POINTS, below: 68, above: 81 }, 'rad byte', 81,
    'Q4 death food: measured sizes, smooth between', SL + 'L39 and Appendix 2 (every seen pair reproduced)'),
  approved('L39.place', 'Death drop place: perPoint drops at uniform positions along each body point stretch of the pulled body toward the head and atHead at the head, each moved by a uniform point in a disc of radius r0 + r1 (sc - 1)',
    { rule: 'alongBodyDisc', perPoint: 2, atHead: 1, r0: 20, r1: 15 }, 'world units', 81,
    'Q4 death food: spread along the body', SL + 'L39 placement (SUGGESTED fit to 6012 drops)'),
  approved('L39.colour.skin', 'Death drop colour: plain colours their own; skins by the weight table', SKIN_DROP,
    'colour weights', 87, 'Q10 skin drop colours', SL + 'L39 and Appendix 4 (plain colours MEASURED, 3610 drops 0 off)'),
  measured('L40', 'Kill credit: the killer own seat gets its kill count with the death; no count for others\' kills',
    { rule: 'killCreditOwnSeat' }, 'rule', 'L40 (32 own kills, 32 k; 192 others, 0 k)'),
  measured('L41', 'Own death: dead code 0, own removal code 1, then the drops in the same message; the client closes the socket',
    { rule: 'ownDeathOrder' }, 'rule', 'L41 (31 of 31)'),

  // I. Spawning and population
  rule('L42.ring', 'Spawn ring radius (q k + c) flux_grd from the centre, k an integer, at a uniform angle',
    { rule: 'spawnRing', q: 0.011, c: -0.002 }, 'share of flux_grd', 'L42 (31 own spawns within 0.443 units)'),
  approved('L42.k', 'Spawn ring index k, uniform', { min: 3, max: 76 }, 'ring index', 82, 'Q5 spawn: their rings',
    SL + 'L42 (SUGGESTED; k seen 3 to 76, uniform KS p 0.163)'),
  approved('L42.clear', 'Spawn clearance: draw again while another snake body point lies within this distance', 400,
    'world units', 82, 'Q5 spawn: at least 400 units from any snake', SL + 'L42 (SUGGESTED; nearest seen 402)'),
  measured('L43', 'Bots: the wire never marks a bot (ours are our own, OWNER-ANSWERS Q2)', { wireMarksBot: false },
    'flag', 'L43 (not a parity area)'),
  measured('L44', 'Players per real server (context only)', { medians: [328, 355, 438], min: 301, max: 478 }, 'snakes',
    'L44 (context; Q25 one free room as big as the server holds)'),
  measured('L45', 'Skin echoed as sent; names cut at 24 characters by their client rules', { echoSkin: true, nameMax: 24 },
    'characters', 'L45 (31 of 31; their server passes 30, Q17 keeps their client 24)'),
  measured('L46', 'Other packets their server sends: only the version answer', { sent: ['6'], never: ['R', 'm', 'S', 'i', 'o', 'B'] },
    'packet letters', 'L46 (31 of 31)'),
  approved('L49', 'Spawn protection', 0, 'ms', 82, 'Q5 spawn: no spawn protection', SL + 'L49 (SUGGESTED none; any is under 2.85 s)'),
  measured('L50', 'Snake removal codes', { rule: 'removalCodes', died: 1, leftView: 0 }, 'code', 'L50 (code 1 227 with drops; code 0 869, none with a drop)'),
  approved('L51', 'Crowd density: area per snake', 1.22e6, 'world units^2 per snake', 77,
    'Q1 crowding: one snake per 1.22 M square units', SL + 'L51 (SUGGESTED 8.2e-7 snakes per unit^2)'),

  // M. The moving border, ours on Owen's answers
  approved('C_R_MIN', 'Smallest border: the target radius at this many snakes', { snakes: 22 }, 'snakes', 105,
    'map size: the smallest map sized for 22 snakes', 'SERVER-DESIGN 4.3 (BOT_MIN 22, shared/constants.js:293)'),
  approved('C_R_MAX', 'Largest border radius', 31899, 'world units', 77, 'Q1 crowding (section M approved as one question)',
    SL + 'section M item 3 (grd x 0.98, the client own fallback)'),
  approved('C_FOOD_SCALE', 'Food profiles read by distance as a share of the current border radius', 'fractionOfRadius',
    'mode', 105, 'food pattern scaled to our map', 'SERVER-DESIGN 4.3'),
  chosen('C_OUTSIDE_FOOD', 'Natural food and prey spawn only inside the current border; food left outside stays until eaten',
    { naturalInsideOnly: true, outsideStays: true }, 'flags', SL + 'section M item 6'),
  chosen('C_N_SMOOTH_MS', 'Snake count N for the border averaged over this window', 10000, 'ms', 'SERVER-DESIGN 4.3, 10'),

  // Hold Q to cash out, ours on Owen's answers
  approved('C_HOLD_MS', 'Hold Q time to cash out', 3000, 'ms', 66, 'hold Q: the old game ramp',
    'SERVER-DESIGN 4.3 (source shared/constants.js:22 CASHOUT_HOLD_MS; never read at runtime)'),
  approved('C_HOLD_RAMP', 'Hold speed multiplier max(floor, 1 - (1 - floor) t / ms)', { rule: 'linearToFloor', floor: 0.2, ms: 3000 },
    'multiplier', 66, 'hold Q: speed like the current game', 'SERVER-DESIGN 4.3 (server/Snake.js:139-143, shared/constants.js:23)'),
  approved('C_HOLD_STEER', 'Steering while holding Q', 'locked', 'mode', 66, 'hold Q: steering is locked', 'SERVER-DESIGN 15.3'),
  approved('C_HOLD_BOOST', 'Boosting while holding Q', { allow: false }, 'flag', 99, 'hold Q: no boosting while holding',
    'SERVER-DESIGN 4.3 (the design suggested allow; Owen chose no)'),
  approved('C_HOLD_RING', 'Others see the cash-out ring while a snake holds', { others: true }, 'flag', 99,
    'hold Q: others see the ring', 'SERVER-DESIGN 15.3'),
  approved('C_CASHOUT_CODE', 'A cashed-out snake leaves others with this removal code, no food', 0, 'code', 99,
    'hold Q: the snake vanishes at once for others, no food', 'SERVER-DESIGN 4.3'),
  chosen('C_HOLD_SAFETY_MS', 'Hold safety end: no upstream packet of any kind for max(minMs, rttMult x pong RTT p95)',
    { minMs: 2000, rttMult: 3 }, 'ms', 'SERVER-DESIGN 4.3, 15.3'),

  // Players, sockets, room, ours
  approved('C_DISCONNECT', 'A live snake whose socket drops glides straight this long, then dies',
    { rule: 'glideThenDie', glideMs: 3000 }, 'ms', 108, 'Q10 connection blips: glide 3 s from the start, then dies if not back',
    'SERVER-DESIGN 4.3, 9.6'),
  approved('C_SL_PER_IP', 'Sockets per internet address on /sl, a gliding snake counted until its glide ends', 30, 'sockets', 110, 'Q11 players per internet address: 30',
    'SERVER-DESIGN 4.3, 12.2'),
  approved('C_LB_BOTS', 'Leaderboard rank and snake count include bots', true, 'flag', 32,
    'Q2 bots: no label, the screen as busy as a real server',
    SL + 'L9 (CHOSEN there: the wire never says) and section M item 2 (N counts players and bots, the same count the leaderboard sends)'),
  approved('C_KILLFEED', 'Kill line only when the killer exists and a human is involved', { rule: 'humanInvolved' }, 'rule', 44,
    'Q14 old extras: keep all, kill messages included', 'SERVER-DESIGN 4.3 (the old rule, server/GameRoom.js:753)'),
  approved('PICTURE_SKINS', 'Picture skins switch: off until Owen has reviewed each image; one switch for all 12, on only when reviewed names every one of the 12 files (slBots refuses anything else)',
    { on: false, reviewed: [] }, 'switch', 102, 'picture skins: included with one off switch, reviewed before go-live',
    'SERVER-DESIGN 4.3, 15.5'),
  approved('C_TOP_SINCE', 'Biggest cash-out box counts cash-outs since the USDC cutover, which is all-time: every rake row is later',
    '2026-06-24T21:07:21Z', 'UTC time', 101, 'biggest cash-out box: all-time',
    'SERVER-DESIGN 4.3, 15.4 (also OWNER-ANSWERS.md:70); the cutover commit 2d2c2ab, house_revenue starts 2026-07-29 (T13)'),
  approved('C_TOP_AMOUNT', 'Biggest cash-out box shows the take-home amount, every game, event prizes not counted',
    { rule: 'takeHome', rakeShare: 0.1, mult: 9, games: 'all', eventPrize: false }, 'dollars per rake dollar', 101,
    'biggest cash-out box: take-home after the 10% cut, every game, not event prizes', 'SERVER-DESIGN 15.4'),
  approvedOn(DAY2, 'C_TOP_EXCLUDE', 'Biggest cash-out box leaves out these test wallets Owen names (the owner and revenue wallets always, passed in by index.js)',
    [], 'wallets', 122, 'C_TOP_EXCLUDE: none for now, only the owner and revenue wallets index.js always excludes',
    'SERVER-DESIGN 4.3, 15.4 (brief section 11 question 5)'),
  approvedOn(DAY2, 'C_TOP_LANDED', 'Biggest cash-out box counts a rake row only when its payout landed: an earnings row of 9 x the rake within tolMicro, within windowS after it, and no failed payout in that window',
    { windowS: 600, tolMicro: 10 }, 's; micro-USDC', 123,
    'C_TOP_LANDED: only landed payouts count, matched within 10 minutes, failed never count',
    'SERVER-DESIGN 4.3, 15.4 (brief section 11 question 5; the T13 amount match)'),
  approvedOn(DAY2, 'C_HIDDEN_STREAM', 'A hidden tab keeps receiving the full stream (their behaviour)', 'full', 'mode', 124,
    'C_HIDDEN_STREAM: a hidden tab keeps receiving the full stream, like slither', 'SERVER-DESIGN 4.3, 12.4'),
  approvedOn(DAY2, 'C_RESYNC_FADE', 'A resync re-adds snakes, which fade in from transparent on the client', 'fadeIn', 'mode', 125,
    'C_RESYNC_FADE: after a reconnect the re-sent snakes fade in', 'SERVER-DESIGN 4.3, 9.3'),
  approvedOn(DAY2, 'C_TIMING_BARS', 'Law check bars for the L23 period and the L13 first step: the sim ledger plus the tick quantization bound',
    { rule: 'ledgerPlusQuantBound', quantSdMs: 12.3 }, 'ms', 126,
    'C_TIMING_BARS: the law check allows the 43 ms tick wobble on the L23 period and L13 first step',
    'SERVER-DESIGN 4.3, 18.3 (sd about P / sqrt(12))'),
  // The two caps: Owen 2026-10-11 ~14:40 ET, room "capped at 101 snakes as CHOSEN until the load test after the
  // 2026-10-15 reset" (OWNER-ANSWERS.md:136-139). The T15 load test replaces both (largest passing count minus 25 percent).
  chosen('C_ROOM_CAP', 'Room cap: snakes in the room, players and bots (the load test later sets the largest passing count minus 25 percent)',
    101, 'snakes', 'Owen ' + DAY2 + ' (' + OA + '136-139 room capped at 101 snakes as CHOSEN until the load test after ' +
    'the 2026-10-15 reset); the T15 load test replaces it (SERVER-DESIGN 14.2 item 5)'),
  chosen('C_HUMAN_CAP', 'Human cap of the room (the load test later sets it)', 101, 'players',
    'Owen ' + DAY2 + ' (' + OA + '136-139 room capped at 101 snakes as CHOSEN until the load test after the ' +
    '2026-10-15 reset; humans are snakes of that room, so the same 101); the T15 load test replaces it (SERVER-DESIGN 4.3, 14.2)'),

  // Bots, ours on Owen's answers
  approved('BOT_FILL', 'Bot count = max(0, the daily curve target - humans); real players replace bots',
    { rule: 'dailyCurveMinusHumans' }, 'rule', 71, 'bot fill: the daily curve like today, about 22 to 101',
    'SERVER-DESIGN 11 (server/botPopulation.js botTarget, BOT_MIN and BOT_MAX read at runtime)'),
  approved('BOT_KINDS', 'Bots: three personalities, ordinary names, random skins, no label',
    { personalities: ['casual', 'hunter', 'shy'], names: 'ordinary', label: false, skins: 'random' }, 'kinds', 32,
    'Q2 bots: our own, 3 personalities, normal names, random skins, no label', 'SERVER-DESIGN 11'),
  chosen('BOT_GATES', 'Bot input gates and fill pacing', { angleMs: 33, boostMs: 50, changeMs: 125, retire: 'unseen',
    spawn: 'outsideHumanViews' }, 'ms', 'SERVER-DESIGN 11 (the client own send gates, slInput.js:257-265)'),
  chosen('C_GOV', 'Bot load governor', { loopP99Ms: 15, windowMs: 30000, paidLatePoints: 1, sliceMult: 2,
    halveWhilePaid: true, stepMult: 0.9, stepMs: 30000, recoverShare: 0.5 }, 'mixed', 'SERVER-DESIGN 11'),

  // Engineering, ours
  chosen('C_PHASES', 'Phase groups per update period (every snake still updates once per period)', 1, 'groups',
    'SERVER-DESIGN 4.3, 5.1'),
  chosen('C_MAX_STEPS', 'Most due sim steps run on one wake; a longer stall drops its backlog', 4, 'steps',
    'SERVER-DESIGN 5.1 (agar ROOM_TUNING)'),
  chosen('C_ECHO_NOW', 'Pong and own wanted-angle echo join the seat queue on arrival with a flush scheduled at once', true,
    'flag', 'SERVER-DESIGN 4.3, 5.2'),
  chosen('C_INPUT_OFFSET', 'Each input carries its arrival offset into the tick (L13 first step, L23 first charge)', true,
    'flag', 'SERVER-DESIGN 4.3, 5.1'),
  chosen('C_PENDING_CAP', 'Seat queue size that triggers a resync (re-sized in T15 against a measured resync)', 65536, 'bytes',
    'SERVER-DESIGN 4.3, 9.3'),
  chosen('C_RESYNC_GAP_MS', 'A second cap hit within this long of a resync is a stall kick', 10000, 'ms', 'SERVER-DESIGN 4.3, 9.3'),
  chosen('C_STALL_KICK_MS', 'Kick after the transport was not ready this long', 15000, 'ms', 'SERVER-DESIGN 4.3, 9.3'),
  chosen('C_ACK_LATE_MS', 'ackLate: no pong owed, the last pong left over max(minMs, pingMult x median ping interval) ago, no ping since, tab not hidden',
    { minMs: 600, pingMult: 2 }, 'ms', 'SERVER-DESIGN 4.3, 9.1'),
  chosen('C_FLUSH_SLICE_MS', 'A wake yields between seat groups after this much synchronous time', 6, 'ms', 'SERVER-DESIGN 4.3, 5.1'),
  chosen('C_ID_QUARANTINE_MS', 'A snake id is reused only after this long and when no seat holds it', 30000, 'ms',
    'SERVER-DESIGN 4.3, 8.1'),
  chosen('C_IDLE_PAUSE_MS', 'With no human seated this long the room stops ticking; the first join resumes it', 60000, 'ms',
    'SERVER-DESIGN 4.3, 11'),
  chosen('C_DEAD_SEAT_MS', 'A dead seat with no ping for noPingMs is closed; capMs hard cap', { noPingMs: 5000, capMs: 60000 },
    'ms', 'SERVER-DESIGN 4.3, 12.4'),
  chosen('C_RATE', 'Per-socket event gaps', { join: 500, hold: 50, vis: 250, chat: 600, diag: 10000, leave: 500 }, 'ms',
    'SERVER-DESIGN 12.2'),
  chosen('C_RATE_INPUT', 'Input: 1 to maxBytes per emit, merged per tick; disconnect only when a windowMs average passes recordsPerSec or bytesPerSec',
    { minBytes: 1, maxBytes: 64, windowMs: 10000, recordsPerSec: 222, bytesPerSec: 16384 }, 'mixed',
    'SERVER-DESIGN 12.2 (3 x their 74 records per second; 16 KB per second)'),
  chosen('C_CONN', 'Handshake: a skin outside the shipped set becomes a random plain colour 0 to 8, as their login does; one join per socket',
    { badSkin: 'random0to8', joinOnce: true }, 'flags', 'SERVER-DESIGN 12.2'),
  chosen('C_CHAT', 'Chat text: angle brackets stripped, cut to maxLen, joined seats only', { maxLen: 120, strip: '<>' }, 'chars',
    'SERVER-DESIGN 12.2 (the old box, public/js/game.js:241)'),
  chosen('C_PUSH', 'Owner phone push: at most one per player name per perNameMs and maxPerWindow per windowMs', { perNameMs: 600000,
    windowMs: 600000, maxPerWindow: 6 }, 'ms', 'SERVER-DESIGN 13 item 9'),
  chosen('C_FOOD_FULL_FORMS', 'Food and eat records always in their full forms, never the from-last forms', true, 'flag',
    'SERVER-DESIGN 4.3, 8.3 (their server uses the short forms, T0 check L48.food; a short form is the same food on ' +
    'their client, so full forms change bytes only)'),
  chosen('C_SEND_6', 'Send the version answer record', false, 'flag', 'SERVER-DESIGN 8.4 (their client only counts it)'),
  chosen('C_DROP_CELL', 'A drop whose food cell is taken goes to the nearest free cell of that sector', 'nearestFreeInSector',
    'mode', 'SERVER-DESIGN 6.4'),
];

// ---------------------------------------------------------------------------------------------------------------
// Table building and checks.

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}

function validateEntry(e, allowFixture) {
  if (!e || typeof e !== 'object') throw new Error('slLaws: entry is not an object');
  if (typeof e.id !== 'string' || !e.id) throw new Error('slLaws: entry without an id');
  if (!ALL_STATUS.has(e.status)) throw new Error('slLaws: ' + e.id + ' has bad status ' + e.status);
  if (e.status === STATUS.FIXTURE && !allowFixture) throw new Error('slLaws: ' + e.id + ' is FIXTURE in a real table');
  if (typeof e.name !== 'string' || !e.name.trim()) throw new Error('slLaws: ' + e.id + ' has no name');
  if (typeof e.source !== 'string' || !e.source.trim()) throw new Error('slLaws: ' + e.id + ' has no source');
  if (typeof e.unit !== 'string' || !e.unit.trim()) throw new Error('slLaws: ' + e.id + ' has no unit');
  const empty = e.value === null || e.value === undefined;
  if (empty && !MAY_BE_EMPTY.has(e.status)) throw new Error('slLaws: ' + e.id + ' is ' + e.status + ' with no value');
  // An APPROVED row without approvedAt is allowed in a table (so a test can build one); assertShippable refuses it.
}

// Build a frozen table keyed by id from a list of entries. Throws on a malformed entry or a duplicate id.
function tableFrom(entries, { allowFixture = false } = {}) {
  const t = {};
  for (const e of entries) {
    validateEntry(e, allowFixture);
    if (Object.prototype.hasOwnProperty.call(t, e.id)) throw new Error('slLaws: duplicate law id ' + e.id);
    const row = { id: e.id, name: e.name, status: e.status, value: e.value, unit: e.unit, source: e.source };
    if (e.approvedAt !== undefined) row.approvedAt = e.approvedAt;
    t[e.id] = row;
  }
  return deepFreeze(t);
}

function entriesOf(laws) {
  if (!laws || typeof laws !== 'object' || Array.isArray(laws)) {
    throw new TypeError('slLaws: law table must be an object keyed by id');
  }
  return Object.keys(laws).map((k) => laws[k]);
}

function idList(laws, ids) {
  const need = ids === undefined ? Object.keys(laws) : ids;
  if (!Array.isArray(need)) throw new TypeError('slLaws: ids must be an array of law ids');
  return need;
}

function rowOf(laws, id) {
  return Object.prototype.hasOwnProperty.call(laws, id) ? laws[id] : null;
}

// Throws naming every id in `ids` (default: every id) that is missing, has a bad status or holds no value. Any status
// with a value passes, FIXTURE included: completeness, not shippability (assertShippable is the boot guard).
function assertLawsComplete(laws, ids) {
  entriesOf(laws);
  const bad = [];
  for (const id of idList(laws, ids)) {
    const e = rowOf(laws, id);
    if (!e) { bad.push(id + ' (missing)'); continue; }
    if (!ALL_STATUS.has(e.status)) { bad.push(id + ' (bad status ' + e.status + ')'); continue; }
    if (e.value === null || e.value === undefined) bad.push(id + ' (' + e.status + ', no value)');
  }
  if (bad.length) throw new Error('slLaws: cannot start, law rows not settled: ' + bad.join('; '));
  return laws;
}

// The rows of `ids` (default: every row) that are not shippable, each as 'ID (reason)'. Shippable = KNOWN, MEASURED,
// RULE, CHOSEN, or APPROVED with approvedAt, with a value and a source.
function notShippable(laws, ids) {
  entriesOf(laws);
  const bad = [];
  for (const id of idList(laws, ids)) {
    const e = rowOf(laws, id);
    if (!e) { bad.push(id + ' (missing)'); continue; }
    if (!SHIPPABLE.has(e.status)) bad.push(id + ' (' + e.status + ')');
    else if (e.value === null || e.value === undefined) bad.push(id + ' (no value)');
    else if (typeof e.source !== 'string' || !e.source.trim()) bad.push(id + ' (no source)');
    else if (e.status === STATUS.APPROVED && !(typeof e.approvedAt === 'string' && e.approvedAt.trim())) {
      bad.push(id + ' (APPROVED without approvedAt)');
    }
  }
  return bad;
}

// The production guard. Throws on any OPEN, NEEDS_MORE, SUGGESTED, PROPOSED or FIXTURE row, on an APPROVED row with
// no approvedAt, and on an empty or unsourced row, naming every one.
function assertShippable(laws, ids) {
  const bad = notShippable(laws, ids);
  if (bad.length) throw new Error('slLaws: law table is not shippable: ' + bad.join('; '));
  return laws;
}

// Every rule name in rows of `ids` (default: every row) must be a slRules name; with `built` (names the caller has
// written), it must also be one of those. Throws naming each offending id and rule.
function assertRulesBuilt(laws, ids, built) {
  entriesOf(laws);
  const have = built === undefined ? null : new Set(built);
  const bad = [];
  for (const id of idList(laws, ids)) {
    const e = rowOf(laws, id);
    if (!e) { bad.push(id + ' (missing)'); continue; }
    const v = e.value;
    if (!v || typeof v !== 'object' || Array.isArray(v) || !Object.prototype.hasOwnProperty.call(v, 'rule')) continue;
    if (!isRule(v.rule)) bad.push(id + ' (unknown rule ' + JSON.stringify(v.rule) + ')');
    else if (have && !have.has(v.rule)) bad.push(id + ' (rule ' + v.rule + ' is not built)');
  }
  if (bad.length) throw new Error('slLaws: rule forms not built: ' + bad.join('; '));
  return laws;
}

// Reads one value, throwing when the row is missing or empty (same rule as assertLawsComplete).
function lawValue(laws, id) {
  assertLawsComplete(laws, [id]);
  return laws[id].value;
}

// A copy of a table with some values replaced ({ id: value }); statuses and sources kept. Validation is skipped on
// purpose, so a test can set a value to null and prove the checks catch it.
function withValues(laws, patch) {
  entriesOf(laws);
  for (const id of Object.keys(patch)) {
    if (!Object.prototype.hasOwnProperty.call(laws, id)) throw new Error('slLaws: withValues on unknown id ' + id);
  }
  const t = {};
  for (const e of entriesOf(laws)) {
    t[e.id] = Object.assign({}, e, Object.prototype.hasOwnProperty.call(patch, e.id) ? { value: patch[e.id] } : null);
  }
  return deepFreeze(t);
}

function statusCounts(laws) {
  const c = {};
  for (const s of Object.keys(STATUS)) c[s] = 0;
  for (const e of entriesOf(laws)) if (Object.prototype.hasOwnProperty.call(c, e.status)) c[e.status]++;
  return c;
}

// The init event (packet a) fields from the table, plus the current integer border radius. Field names are the ones
// shared/slWire.js encodes; the optional tail pv, defaultMsl, realSid, fluxGrd, gameMode, extraB is complete, so
// the client never falls back to its own defaults.
const INIT_LAW_IDS = Object.freeze(['L1', 'L2.size', 'L2.count', 'L3', 'L4', 'L5', 'L6', 'L6.realSid']);
function initFields(laws, fluxGrd) {
  assertLawsComplete(laws, INIT_LAW_IDS);
  if (!Number.isInteger(fluxGrd) || fluxGrd <= 0) throw new TypeError('slLaws: initFields needs the integer flux_grd');
  const sp = laws.L4.value;
  const tb = laws.L5.value;
  const pk = laws.L6.value;
  return {
    type: 'init',
    grd: laws.L1.value,
    mscps: laws.L3.value,
    sectorSize: laws['L2.size'].value,
    sectorCount: laws['L2.count'].value,
    spangdv: sp.spangdv,
    nsp1: sp.nsp1,
    nsp2: sp.nsp2,
    nsp3: sp.nsp3,
    mamu: tb.mamu,
    mamu2: tb.mamu2,
    cst: tb.cst,
    pv: pk.protocol,
    defaultMsl: tb.msl,
    realSid: laws['L6.realSid'].value,
    fluxGrd,
    gameMode: pk.gameMode,
    extraB: pk.extraB,
  };
}

const LAWS = tableFrom(ENTRIES);

module.exports = {
  STATUS,
  LAWS,
  ENTRIES: deepFreeze(ENTRIES.map((e) => Object.assign({}, e))),
  INIT_LAW_IDS,
  tableFrom,
  assertLawsComplete,
  assertShippable,
  notShippable,
  assertRulesBuilt,
  lawValue,
  withValues,
  statusCounts,
  initFields,
};
