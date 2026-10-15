'use strict';
// slither.io law table (SERVER-DESIGN 4, 18.1; build brief section 8 row slLaws, slRules) and its FIXTURE twin.
// Vectors are literals copied from spec/SERVER-LAWS.md and OWNER-ANSWERS.md by law id; nothing is read from the
// reference folder at test time.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const L = require('../server/sl/slLaws');
const R = require('../server/sl/slRules');
const { FIXTURE, TEST_ONLY, makeFixture } = require('./slLawsFixture');
const slWire = require('../shared/slWire');

const ROOT = path.join(__dirname, '..');
const IDS = Object.keys(L.LAWS);

// SERVER-DESIGN 4.3 own rows (C_RATE_* is C_RATE and C_RATE_INPUT, C_GOV_* is C_GOV, BOT_* is the three BOT rows).
const OWN_ROWS = ['C_PHASES', 'C_ECHO_NOW', 'C_INPUT_OFFSET', 'C_PENDING_CAP', 'C_RESYNC_GAP_MS', 'C_STALL_KICK_MS',
  'C_ACK_LATE_MS', 'C_FLUSH_SLICE_MS', 'C_ID_QUARANTINE_MS', 'C_ROOM_CAP', 'C_HUMAN_CAP', 'C_IDLE_PAUSE_MS',
  'C_DEAD_SEAT_MS', 'C_RATE', 'C_RATE_INPUT', 'C_CONN', 'BOT_FILL', 'BOT_KINDS', 'BOT_GATES', 'C_GOV', 'C_N_SMOOTH_MS',
  'C_FOOD_FULL_FORMS', 'C_HOLD_MS', 'C_HOLD_RAMP', 'C_HOLD_SAFETY_MS', 'C_R_MIN', 'C_R_MAX', 'C_FOOD_SCALE',
  'C_HOLD_BOOST', 'C_CASHOUT_CODE', 'C_DISCONNECT', 'C_LB_BOTS', 'C_KILLFEED', 'C_HIDDEN_STREAM', 'C_RESYNC_FADE',
  'C_TIMING_BARS', 'PICTURE_SKINS', 'C_SL_PER_IP', 'C_TOP_SINCE', 'C_TOP_EXCLUDE', 'C_TOP_LANDED'];

// The five rows that were PROPOSED until Owen answered them in chat on 2026-10-11 (OWNER-ANSWERS.md:120-126), with the
// OWNER-ANSWERS.md line of each answer.
const ANSWERED_2026_10_11 = { C_TOP_EXCLUDE: 122, C_TOP_LANDED: 123, C_HIDDEN_STREAM: 124, C_RESYNC_FADE: 125,
  C_TIMING_BARS: 126 };

// The paid swap rows (PAID-SL-DESIGN 4): three CHOSEN, and the border drop row from Owen's answer of 2026-10-12
// (OWNER-ANSWERS.md:145, death money "same as the current paid snake").
const PAID_ROWS = ['C_PAID_HUMAN_CAP', 'C_PAID_DROP_INSET', 'C_PAID_CASH_BYTE', 'C_PAID_BORDER_DROPS'];
const ANSWERED_2026_10_12 = { C_PAID_BORDER_DROPS: 145 };

function withRow(id, change) {
  return L.ENTRIES.map((e) => (e.id === id ? Object.assign({}, e, change) : e));
}

test('every law L1 to L51 has a row, and every SERVER-DESIGN 4.3 own row is present with status and source', () => {
  for (let n = 1; n <= 51; n++) {
    assert.ok(IDS.some((id) => id === 'L' + n || id.startsWith('L' + n + '.')), 'L' + n + ' missing');
  }
  for (const id of OWN_ROWS) {
    assert.ok(L.LAWS[id], id + ' missing');
    assert.ok(L.LAWS[id].status && L.LAWS[id].source, id);
  }
  // No law id beyond L51, and dotted parts only on real law numbers.
  for (const id of IDS) {
    const m = /^L(\d+)(\.|$)/.exec(id);
    if (m) assert.ok(Number(m[1]) >= 1 && Number(m[1]) <= 51, id);
  }
  for (const id of PAID_ROWS) assert.ok(L.LAWS[id] && L.LAWS[id].status && L.LAWS[id].source, id + ' missing');
  // 139 + the nine T5 prey rows (fixer pass, 2026-10-10) + the four paid rows (PAID-SL-DESIGN 4, 2026-10-14)
  assert.strictEqual(IDS.length, 152);
});

test('statuses, sources and approvals: each source starts with its status, APPROVED rows cite Owen\'s line', () => {
  const head = { KNOWN: /^KNOWN: SERVER-LAWS L\d/, MEASURED: /^MEASURED: SERVER-LAWS L\d/, RULE: /^RULE FOUND: SERVER-LAWS L\d/,
    CHOSEN: /^CHOSEN: /, PROPOSED: /^PROPOSED \(waits for Owen\): SERVER-DESIGN/, NEEDS_MORE: /^NEEDS_MORE: set by the T15/ };
  for (const id of IDS) {
    const e = L.LAWS[id];
    assert.strictEqual(e.id, id);
    assert.ok(e.name.trim() && e.unit.trim(), id);
    assert.ok(!/—/.test(e.name + e.source + e.unit), id + ' has an em dash');
    if (e.status === 'APPROVED') {
      const m = /^(2026-10-1[012]) OWNER-ANSWERS\.md:(\d+)$/.exec(e.approvedAt);
      assert.ok(m, id + ' approvedAt ' + e.approvedAt);
      // 2026-10-10 answers sit on lines 31 to 116; the five 2026-10-11 answers on lines 122 to 126; the paid swap
      // answer of 2026-10-12 on line 145.
      if (m[1] === '2026-10-10') assert.ok(Number(m[2]) >= 31 && Number(m[2]) <= 116, id + ' line');
      else if (m[1] === '2026-10-11') assert.strictEqual(Number(m[2]), ANSWERED_2026_10_11[id], id + ' line');
      else assert.strictEqual(Number(m[2]), ANSWERED_2026_10_12[id], id + ' line');
      assert.ok(e.source.startsWith('APPROVED by Owen ' + m[1] + ' (OWNER-ANSWERS.md:' + m[2] + ' '), id);
    } else {
      assert.strictEqual(e.approvedAt, undefined, id);
      assert.match(e.source, head[e.status], id);
    }
    if (e.status === 'NEEDS_MORE') assert.strictEqual(e.value, null, id);
    else assert.notStrictEqual(e.value, null, id);
  }
  assert.deepStrictEqual(L.statusCounts(L.LAWS), { KNOWN: 8, MEASURED: 21, RULE: 28, APPROVED: 62, CHOSEN: 33,
    PROPOSED: 0, SUGGESTED: 0, OPEN: 0, NEEDS_MORE: 0, FIXTURE: 0 });
});

test('law values, literal vectors from SERVER-LAWS by id', () => {
  const v = (id) => L.lawValue(L.LAWS, id);
  const EXACT = {
    L1: 32550, 'L2.size': 300, 'L2.count': 102, L3: 430, L7: 42.67, 'L8.sweep': 503.91, 'L8.linger': 2700,
    'L11.slow': 1504.31, 'L11.fast': 127.43, 'L11.T': 2500, 'L29.period': 503.92, 'L42.clear': 400, L49: 0,
    L51: 1.22e6, C_R_MAX: 31899, 'L6.realSid': 0,
  };
  for (const id of Object.keys(EXACT)) assert.strictEqual(v(id), EXACT[id], id);
  assert.deepStrictEqual(v('L4'), { nsp1: 5.39, nsp2: 0.4, nsp3: 14, spangdv: 4.8 });
  assert.deepStrictEqual(v('L5'), { mamu: 0.033, mamu2: 0.029, cst: 0.43, msl: 42 });
  assert.deepStrictEqual(v('L6'), { protocol: 19, gameMode: 1, extraB: 0 });
  assert.deepStrictEqual(v('L8.anchor'),
    { rule: 'anchorAhead', from: 'continuousHead', a: 48.2, b: 7.66, lastPointA: 69.24, lastPointB: 7.727 });
  assert.deepStrictEqual(v('L8.R2'), { rule: 'r2BySct', small: 13, large: 20, stepSct: 92, recompute: 'anchorSectorChange' });
  assert.deepStrictEqual(v('L9'), { periodMs: 3008.4, rows: 10, order: 'sctFamDesc' });
  assert.strictEqual(v('L10').periodMs, 2504.2);
  assert.strictEqual(v('L10').size, 136);
  assert.deepStrictEqual(v('L11.step'), { units: 6, everyMs: 127.43 });
  assert.deepStrictEqual(v('L12'), { rule: 'speedBase', scDiv: 106, scCap: 6, setAt: 'spawnAndBoostEnd',
    wireS: 'trunc1000', wireRot: 'trunc18' });
  assert.deepStrictEqual(v('L13.ramp'), { rule: 'rampN', n0: 12.5, perPoint: 4, div: 111, downRatio: 0.75 });
  assert.deepStrictEqual(v('L13.first'), { rule: 'offsetFraction', periodMs: 42.67 });
  assert.deepStrictEqual(v('L14'), { rule: 'turnK', div: 111, scCap: 6, perMs: true });
  assert.deepStrictEqual(v('L15'), { rule: 'wangFromByte', maxAngle: 250, ping: 251, arrow: 252, boostOn: 253, boostOff: 254 });
  assert.deepStrictEqual(v('L18'), { rule: 'famGain', K: 1.2681186e-4, exp: 2.25 });
  assert.deepStrictEqual(v('L20'), { sct: 2, fam: 0, sp: 5.79, points: 2, gap: 42, heading: 'uniform' });
  assert.deepStrictEqual(v('L22'), { rule: 'boostStart', minL: 2.14 });
  assert.deepStrictEqual(v('L23.period'), { periodMs: 155.2, start: 'press' });
  assert.deepStrictEqual(v('L23.low'), { maxSct: 6, lo: 0.07754, hi: 0.08892 });
  assert.deepStrictEqual(v('L24.Td'), { rule: 'dropOnCharge', minL: 2.14 });
  assert.deepStrictEqual(v('L24.size'), { rule: 'dropByte', alpha: 84.2853, beta: 0.1702 });
  assert.deepStrictEqual(v('L24.place'), { rule: 'tailTipDisc', radius: 10 });
  assert.deepStrictEqual(v('L27'), { rule: 'naturalRadByte', base: 15, span: 32.5 });
  assert.deepStrictEqual(v('L28').weights, [6.0, 33.3, 8.3, 9.5, 7.9, 7.1, 2.4, 19.7, 5.8]);
  assert.deepStrictEqual(v('L31'), { rule: 'eatDisc', k0: 5.98, k1: 2.26, r0: 17.8, r1: 17.96, lean: 'halfway', every: 'update' });
  assert.strictEqual(v('L32').perSectorMinute, 0.0193);
  assert.strictEqual(v('L32').sp, 3.8);
  assert.deepStrictEqual(v('L33.period'), { periodMs: 337.75, phase: 'perPrey' });
  assert.deepStrictEqual(v('L33.flee'), { rule: 'preyFlee', dist: 300, offsetMax: 0.25, restSp: 3.8, midSp: [6.06, 6.4],
    fleeSp: 11, turn: 'mamu2' });
  assert.deepStrictEqual(v('L34'), { rule: 'preyGain', Kp: 0.0958111 });
  assert.deepStrictEqual(v('L35'), { rule: 'collideB', f1: 14.5, a: 14.5, body: 'capsule' });
  assert.deepStrictEqual(v('L38'), { rule: 'borderKill', f1: 14.5, m: 0 });
  assert.deepStrictEqual(v('L39.count'), { rule: 'deathDrops', perPoint: 2, extra: 1, border: 0 });
  assert.deepStrictEqual(v('L39.place'), { rule: 'alongBodyDisc', perPoint: 2, atHead: 1, r0: 20, r1: 15 });
  assert.deepStrictEqual(v('L42.ring'), { rule: 'spawnRing', q: 0.011, c: -0.002 });
  assert.deepStrictEqual(v('L42.k'), { min: 3, max: 76 });
  assert.deepStrictEqual(v('L48.rot'), { rule: 'rotChanged', angWhileTurning: true, refreshMs: 205 });
  assert.deepStrictEqual(v('L50'), { rule: 'removalCodes', died: 1, leftView: 0 });
  // Worked numbers SERVER-LAWS quotes from these values.
  const q = v('L42.ring');
  assert.ok(Math.abs(q.q * 76 + q.c - 0.834) < 1e-12, 'top ring 0.834 flux_grd');
  const e = v('L31');
  assert.ok(Math.abs((e.k0 + e.k1) - 8.24) < 1e-12 && Math.abs((e.r0 + e.r1) - 35.76) < 1e-12, 'eat disc at sc 1');
  // Section M examples (rounded there to within 2 units): N 22, 50, 101, 330, 478 give 2923, 4406, 6264, 11322, 13625.
  const EX = [[22, 2923], [50, 4406], [101, 6264], [330, 11322], [478, 13625]];
  for (const [n, r] of EX) assert.ok(Math.abs(Math.sqrt(n * v('L51') / Math.PI) - r) < 2, 'section M N ' + n);
  assert.strictEqual(Math.round(Math.sqrt(22 * v('L51') / Math.PI)), 2923);
  assert.strictEqual(Math.round(6 / 127.43 * 1000), 47, 'L11 step about 47 units/s');
  assert.strictEqual(Math.round(32550 * 0.98), v('C_R_MAX'));
});

test("Owen's answers win: head-on, view retention, hold, disconnect, address cap, picture skins", () => {
  assert.deepStrictEqual(L.LAWS.L36.value, { rule: 'biggerWins', size: 'L', tie: 'seededCoin' });
  assert.match(L.LAWS.L36.approvedAt, /OWNER-ANSWERS\.md:93$/);
  assert.deepStrictEqual(L.LAWS['L8.snake'].value, { rule: 'retainAfterUnwatched', keepMs: 4400 });
  assert.match(L.LAWS['L8.snake'].approvedAt, /OWNER-ANSWERS\.md:90$/);
  assert.deepStrictEqual(L.LAWS.C_HOLD_BOOST.value, { allow: false });
  assert.strictEqual(L.LAWS.C_HOLD_STEER.value, 'locked');
  assert.strictEqual(L.LAWS.C_CASHOUT_CODE.value, 0);
  assert.deepStrictEqual(L.LAWS.C_DISCONNECT.value, { rule: 'glideThenDie', glideMs: 3000 });
  assert.strictEqual(L.LAWS.C_SL_PER_IP.value, 30);
  assert.deepStrictEqual(L.LAWS.PICTURE_SKINS.value, { on: false, reviewed: [] });
  assert.deepStrictEqual(L.LAWS.C_R_MIN.value, { snakes: 22 });
  assert.strictEqual(L.LAWS.C_TOP_SINCE.value, '2026-06-24T21:07:21Z');
  assert.deepStrictEqual(L.LAWS.C_TOP_AMOUNT.value, { rule: 'takeHome', rakeShare: 0.1, mult: 9, games: 'all', eventPrize: false });
  assert.deepStrictEqual(L.LAWS.BOT_KINDS.value.personalities, ['casual', 'hunter', 'shy']);
  assert.strictEqual(L.LAWS.BOT_KINDS.value.label, false);
});

test('paid rows: the cap is the C_R_MIN snake count, the cash byte is the lowest death drop byte, border deaths drop', () => {
  // C_PAID_HUMAN_CAP must equal C_R_MIN.snakes: at that many snakes or fewer the border target is its floor (2923),
  // so a paid room's border never moves and a pellet placed inside stays inside (PAID-SL-DESIGN 1).
  assert.strictEqual(L.LAWS.C_PAID_HUMAN_CAP.value, 22);
  assert.strictEqual(L.LAWS.C_PAID_HUMAN_CAP.value, L.LAWS.C_R_MIN.value.snakes);
  assert.strictEqual(Math.round(Math.sqrt(L.LAWS.C_PAID_HUMAN_CAP.value * L.LAWS.L51.value / Math.PI)), 2923);
  // C_PAID_CASH_BYTE is the lowest death drop rad byte: the smallest byte of the L39.rad table, and the smallest
  // slSim's own interpolation gives at any length a snake can reach (L3 mscps, plus the one point the last grow adds).
  const rad = L.LAWS['L39.rad'].value;
  assert.strictEqual(L.LAWS.C_PAID_CASH_BYTE.value, 68);
  assert.strictEqual(L.LAWS.C_PAID_CASH_BYTE.value, Math.min(rad.below, rad.above, ...rad.points.map((p) => p[1])));
  const { deathRadByte, worldLaws } = require('../server/sl/slSim');
  const W = worldLaws(L.LAWS);
  let low = Infinity;
  for (let sct = 2; sct <= L.LAWS.L3.value + 1; sct++) low = Math.min(low, deathRadByte(W, sct));
  assert.strictEqual(low, L.LAWS.C_PAID_CASH_BYTE.value);
  // Nothing else reaches it: natural food tops out at L27 base + ceil(span) - 1 (47), and a boost drop at the largest
  // L23 charge edge of any reachable length (54); the full sweep of every charge is slPaidBytes.
  const nat = L.LAWS.L27.value;
  assert.strictEqual(nat.base + Math.ceil(nat.span) - 1, 47);
  const e = L.LAWS['L23.edges'].value;
  const size = L.LAWS['L24.size'].value;
  let hi = L.LAWS['L23.low'].value.hi;
  for (let sct = e.fromSct; sct <= L.LAWS.L3.value + 1; sct++) {
    const s = sct - e.fromSct;
    hi = Math.max(hi, e.hi[0] + e.hi[1] * s * s + e.hi[2] * s * s * s);
  }
  assert.strictEqual(Math.round(size.alpha * Math.sqrt(hi) + size.beta), 54);
  assert.ok(47 < L.LAWS.C_PAID_CASH_BYTE.value && 54 < L.LAWS.C_PAID_CASH_BYTE.value);
  // Border deaths drop in a paid room (Owen's answer 1); the free room's own row still drops nothing there.
  assert.deepStrictEqual(L.LAWS.C_PAID_BORDER_DROPS.value, { border: 'asBody' });
  assert.deepStrictEqual(L.LAWS['L39.count'].value, { rule: 'deathDrops', perPoint: 2, extra: 1, border: 0 });
  assert.strictEqual(L.LAWS.C_PAID_DROP_INSET.value, 60); // raised from 40 by T2 (test/slPaidSim.test.js reachability)
  for (const id of ['C_PAID_HUMAN_CAP', 'C_PAID_DROP_INSET', 'C_PAID_CASH_BYTE']) {
    assert.strictEqual(L.LAWS[id].status, 'CHOSEN', id);
    assert.match(L.LAWS[id].source, /^CHOSEN: PAID-SL-DESIGN [14]/, id);
  }
  assert.strictEqual(L.LAWS.C_PAID_BORDER_DROPS.status, 'APPROVED');
  assert.strictEqual(L.LAWS.C_PAID_BORDER_DROPS.approvedAt, '2026-10-12 OWNER-ANSWERS.md:145');
  assert.deepStrictEqual(L.notShippable(L.LAWS, PAID_ROWS), []);
});

test('reference check T0 rows: fam floor, ang byte floor, the measured record order, grow on the regular move', () => {
  assert.strictEqual(L.LAWS['L17.famRound'].value, 'floor');
  assert.strictEqual(L.LAWS['L17.famRound'].status, 'RULE');
  assert.strictEqual(L.LAWS['L48.angRound'].value, 'floor');
  assert.strictEqual(L.LAWS['L48.angRound'].status, 'CHOSEN');
  assert.deepStrictEqual(L.LAWS['L48.order'].value, ['tailFam', 'rot', 'move', 'foodEat', 'preyEat']);
  assert.strictEqual(L.LAWS['L48.hDefer'].value, 'nextUpdate');
  assert.strictEqual(L.LAWS['L18.when'].value, 'regularMove');
  assert.deepStrictEqual(L.LAWS['L8.emptySector'].value, { watched: true, sendsFood: true, removeOnSweep: true });
  // slQuant takes the two rounding rows as they are.
  const Q = require('../server/sl/slQuant');
  assert.ok(Q.RULES.includes(L.LAWS['L17.famRound'].value) && Q.RULES.includes(L.LAWS['L48.angRound'].value));
  assert.strictEqual(Q.fam24(0.5, L.LAWS['L17.famRound'].value).raw, Math.floor(0.5 * 16777215));
  assert.strictEqual(Q.rotAng(Math.PI, L.LAWS['L48.angRound'].value).raw, 128);
});

test('the biggest cash-out rows equal the values slTopCashout reads today (one copy until it reads this table)', () => {
  const T = require('../server/sl/slTopCashout');
  for (const id of T.TOP_LAW_IDS) {
    assert.ok(L.LAWS[id], id);
    assert.strictEqual(JSON.stringify(L.LAWS[id].value), JSON.stringify(T.TOP_ROWS[id].value), id);
  }
  assert.strictEqual(L.LAWS.C_TOP_AMOUNT.value.mult, 9);
});

test('hold ramp: 0.7333, 0.4667, 0.2 at 1, 2, 3 s, and the cut-time match with the old game constants', () => {
  const r = L.LAWS.C_HOLD_RAMP.value;
  const mult = (t) => Math.max(r.floor, 1 - (1 - r.floor) * Math.min(1, t / r.ms));
  assert.strictEqual(mult(0), 1);
  assert.ok(Math.abs(mult(1000) - 0.7333) < 1e-4);
  assert.ok(Math.abs(mult(2000) - 0.4667) < 1e-4);
  assert.ok(Math.abs(mult(3000) - 0.2) < 1e-12);
  assert.ok(Math.abs(mult(4000) - 0.2) < 1e-12);
  const C = require('../shared/constants');
  assert.strictEqual(L.LAWS.C_HOLD_MS.value, C.CASHOUT_HOLD_MS);
  assert.strictEqual(r.ms, C.CASHOUT_HOLD_MS);
  assert.strictEqual(r.floor, C.CASHOUT_MIN_SPEED_MULT);
});

test('L23 edges: the smooth curve meets the low band at sct 6 and continues to lo 0.334, hi 0.410 at sct 430', () => {
  const e = L.LAWS['L23.edges'].value;
  const low = L.LAWS['L23.low'].value;
  const at = (c, sct) => { const s = sct - e.fromSct; return c[0] + c[1] * s * s + c[2] * s * s * s; };
  assert.strictEqual(at(e.lo, 6), low.lo);
  assert.strictEqual(at(e.hi, 6), low.hi);
  assert.strictEqual(Math.round(at(e.lo, 430) * 1000) / 1000, 0.334);
  assert.strictEqual(Math.round(at(e.hi, 430) * 1000) / 1000, 0.41);
  // Appendix 1 at sct 330 (0.21869 to 0.26494): the fit is inside 2 percent there.
  assert.ok(Math.abs(at(e.lo, 330) / 0.21869 - 1) < 0.02);
  assert.ok(Math.abs(at(e.hi, 330) / 0.26494 - 1) < 0.02);
});

test('L39 rad: the interpolation through the measured points gives the Appendix 2 build table', () => {
  const r = L.LAWS['L39.rad'].value;
  const byte = (sct) => {
    const p = r.points;
    if (sct <= p[0][0]) return r.below;
    if (sct >= p[p.length - 1][0]) return r.above;
    for (let i = 1; i < p.length; i++) {
      if (sct <= p[i][0]) return Math.round(p[i - 1][1] + (p[i][1] - p[i - 1][1]) * (sct - p[i - 1][0]) / (p[i][0] - p[i - 1][0]));
    }
    throw new Error('unreachable');
  };
  // SERVER-LAWS Appendix 2 build table: first sct of each band and its rad.
  const BANDS = [[2, 13.6], [90, 13.8], [128, 14.0], [151, 14.2], [170, 14.4], [185, 14.6], [202, 14.8], [210, 15.0],
    [218, 15.2], [226, 15.4], [240, 15.6], [246, 15.8], [252, 16.0], [259, 16.2]];
  for (let i = 0; i < BANDS.length; i++) {
    const end = i + 1 < BANDS.length ? BANDS[i + 1][0] - 1 : 430;
    for (let sct = BANDS[i][0]; sct <= end; sct++) {
      assert.strictEqual(byte(sct) / 5, BANDS[i][1], 'sct ' + sct);
    }
  }
});

test('food tables: L26 and L29 bands rise to 1, L28 weights sum to 100, L32 prey bytes count 204 adds', () => {
  for (const id of ['L26', 'L29.rate']) {
    const b = L.LAWS[id].value.bands;
    for (let i = 1; i < b.length; i++) assert.ok(b[i][0] > b[i - 1][0], id);
    assert.strictEqual(b[b.length - 1][0], 1, id);
  }
  assert.deepStrictEqual(L.LAWS.L26.value.bands, [[0.08, 5.9], [0.16, 3.8], [0.56, 3.6], [0.72, 3.2], [0.88, 2.3], [1, 1]]);
  assert.deepStrictEqual(L.LAWS['L29.rate'].value.bands.map((x) => x[1]),
    [0.231, 0.155, 0.13, 0.083, 0.083, 0.088, 0.067, 0.038, 0.048, 0.042, 0.022, 0.018]);
  assert.strictEqual(L.LAWS['L29.rate'].value.guardMult, 2);
  const w = L.LAWS.L28.value.weights;
  assert.strictEqual(w.length, 9);
  assert.ok(Math.abs(w.reduce((a, b) => a + b, 0) - 100) < 1e-9);
  const rb = L.LAWS.L32.value.radBytes;
  assert.strictEqual(Object.keys(rb).reduce((a, k) => a + rb[k], 0), 204);
  assert.deepStrictEqual(Object.keys(rb).map(Number), [30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45]);
});

test('skin drop colours: 35 measured skins, 22 more from the frozen client stripe table, one table for boost and death', () => {
  const t = L.LAWS['L24.colour.skin'].value;
  assert.strictEqual(L.LAWS['L39.colour.skin'].value, t);
  assert.strictEqual(t.plain, 'own');
  assert.strictEqual(t.otherwise, 'cvMod9');
  const meas = Object.keys(t.measured).map(Number);
  const pat = Object.keys(t.pattern).map(Number);
  assert.strictEqual(meas.length, 35);
  assert.strictEqual(pat.length, 22);
  const all = meas.concat(pat).sort((a, b) => a - b);
  assert.deepStrictEqual(all, Array.from({ length: 57 }, (_, i) => i + 9));
  assert.deepStrictEqual(t.measured[19], { 5: 1879 });
  assert.deepStrictEqual(t.measured[9], { 0: 92, 1: 300, 2: 18, 3: 22, 4: 11, 5: 11, 6: 79, 7: 320, 8: 21 });
  for (const cv of meas.concat(pat)) {
    const row = t.measured[cv] || t.pattern[cv];
    for (const c of Object.keys(row)) {
      assert.ok(Number(c) >= 0 && Number(c) <= 8 && Number.isInteger(row[c]) && row[c] > 0, cv + ':' + c);
    }
  }
  // The pattern rows recomputed from the frozen client's STRIPES literal: entries 0 to 8 count once, else cv mod 9.
  const src = fs.readFileSync(path.join(ROOT, 'public/js/sl/slSprites.js'), 'utf8');
  const a = src.indexOf('var STRIPES = {');
  const b = src.indexOf('};', a);
  assert.ok(a > 0 && b > a);
  const STRIPES = vm.runInNewContext('(' + src.slice(a + 'var STRIPES = '.length, b + 1) + ')');
  for (const cv of pat) {
    const list = [];
    for (const e of STRIPES[cv]) {
      if (typeof e === 'number') list.push(e);
      else for (let q = 0; q < e[1]; q++) list.push(e[0]);
    }
    const plain = list.filter((c) => c >= 0 && c <= 8);
    const want = {};
    if (plain.length) for (const c of plain) want[c] = (want[c] || 0) + 1;
    else want[cv % 9] = 1;
    assert.deepStrictEqual(t.pattern[cv], want, 'skin ' + cv);
  }
});

test('assertShippable passes on the shipped table: Owen\'s five 2026-10-11 answers and the 101 caps; one open row closes it', () => {
  assert.deepStrictEqual(L.notShippable(L.LAWS), []);
  assert.strictEqual(L.assertShippable(L.LAWS), L.LAWS);
  // The five rows Owen answered on 2026-10-11 (OWNER-ANSWERS.md:120-126), with the values he approved.
  for (const id of Object.keys(ANSWERED_2026_10_11)) {
    assert.strictEqual(L.LAWS[id].status, 'APPROVED', id);
    assert.strictEqual(L.LAWS[id].approvedAt, '2026-10-11 OWNER-ANSWERS.md:' + ANSWERED_2026_10_11[id], id);
  }
  assert.deepStrictEqual(L.LAWS.C_TOP_EXCLUDE.value, []);
  assert.deepStrictEqual(L.LAWS.C_TOP_LANDED.value, { windowS: 600, tolMicro: 10 });
  assert.strictEqual(L.LAWS.C_HIDDEN_STREAM.value, 'full');
  assert.strictEqual(L.LAWS.C_RESYNC_FADE.value, 'fadeIn');
  assert.deepStrictEqual(L.LAWS.C_TIMING_BARS.value, { rule: 'ledgerPlusQuantBound', quantSdMs: 12.3 });
  // The caps: 101 CHOSEN by Owen 2026-10-11 until the load test (OWNER-ANSWERS.md:136-139).
  for (const id of ['C_ROOM_CAP', 'C_HUMAN_CAP']) {
    assert.strictEqual(L.LAWS[id].status, 'CHOSEN', id);
    assert.strictEqual(L.LAWS[id].value, 101, id);
    assert.match(L.LAWS[id].source, /^CHOSEN: Owen 2026-10-11 \(OWNER-ANSWERS\.md:136-139 room capped at 101 snakes/, id);
  }
  // One unsettled row (a PROPOSED row, or a cap back to NEEDS_MORE before a load test) closes the room again.
  const open = L.tableFrom(withRow('C_TIMING_BARS', { status: 'PROPOSED', approvedAt: undefined }).map((e) =>
    (e.id === 'C_ROOM_CAP' ? Object.assign({}, e, { status: 'NEEDS_MORE', value: null }) : e)));
  assert.deepStrictEqual(L.notShippable(open), ['C_TIMING_BARS (PROPOSED)', 'C_ROOM_CAP (NEEDS_MORE)']);
  assert.throws(() => L.assertShippable(open), /C_TIMING_BARS \(PROPOSED\); C_ROOM_CAP \(NEEDS_MORE\)/);
});

test('assertShippable throws on OPEN, NEEDS_MORE, SUGGESTED, PROPOSED, FIXTURE and on APPROVED without approvedAt', () => {
  for (const status of ['OPEN', 'NEEDS_MORE', 'SUGGESTED', 'PROPOSED']) {
    const t = L.tableFrom(withRow('L7', { status }));
    assert.throws(() => L.assertShippable(t, ['L7']), new RegExp('L7 \\(' + status + '\\)'), status);
  }
  assert.throws(() => L.assertShippable(FIXTURE, ['L7']), /L7 \(FIXTURE\)/);
  assert.throws(() => L.assertShippable(FIXTURE), /not shippable/);
  const noAt = L.tableFrom(withRow('L51', { approvedAt: undefined }).map((e) => {
    if (e.id !== 'L51') return e;
    const c = Object.assign({}, e);
    delete c.approvedAt;
    return c;
  }));
  assert.throws(() => L.assertShippable(noAt, ['L51']), /L51 \(APPROVED without approvedAt\)/);
  const empty = L.tableFrom(withRow('L51', { approvedAt: '  ' }));
  assert.throws(() => L.assertShippable(empty, ['L51']), /without approvedAt/);
  // Values and sources are checked too.
  assert.throws(() => L.assertShippable(L.withValues(L.LAWS, { L7: null }), ['L7']), /L7 \(no value\)/);
  assert.throws(() => L.assertShippable(L.LAWS, ['NOPE']), /NOPE \(missing\)/);
  assert.throws(() => L.assertShippable(L.LAWS, 'L7'), TypeError);
});

test('assertLawsComplete and lawValue name missing and empty rows; any status with a value passes', () => {
  assert.strictEqual(L.assertLawsComplete(L.LAWS, ['L7', 'L36']), L.LAWS);
  assert.strictEqual(L.assertLawsComplete(L.LAWS), L.LAWS);
  const capsOpen = L.tableFrom(L.ENTRIES.map((e) => (e.id === 'C_ROOM_CAP' || e.id === 'C_HUMAN_CAP'
    ? Object.assign({}, e, { status: 'NEEDS_MORE', value: null }) : e)));
  assert.throws(() => L.assertLawsComplete(capsOpen), /C_ROOM_CAP \(NEEDS_MORE, no value\); C_HUMAN_CAP/);
  const t = L.withValues(L.LAWS, { L7: null });
  assert.throws(() => L.assertLawsComplete(t, ['L1', 'L7']), (e) => /L7 \(MEASURED, no value\)/.test(e.message) &&
    !/L1 /.test(e.message));
  assert.throws(() => L.lawValue(t, 'L7'), /L7/);
  assert.strictEqual(L.lawValue(L.LAWS, 'L7'), 42.67);
  assert.throws(() => L.assertLawsComplete(L.LAWS, ['NOPE']), /NOPE \(missing\)/);
  assert.throws(() => L.assertLawsComplete(null, ['L1']), TypeError);
  assert.throws(() => L.assertLawsComplete([], ['L1']), TypeError);
  assert.strictEqual(L.assertLawsComplete(FIXTURE), FIXTURE);
  const prop = L.tableFrom(withRow('L7', { status: 'PROPOSED' }));
  assert.strictEqual(L.assertLawsComplete(prop, ['L7']), prop);
  assert.throws(() => L.withValues(L.LAWS, { NOPE: 1 }), /NOPE/);
});

test('rule forms: every rule a row names is a slRules name, every slRules name is used, unknown and unbuilt refused', () => {
  assert.strictEqual(L.assertRulesBuilt(L.LAWS), L.LAWS);
  const used = new Set();
  for (const id of IDS) {
    const val = L.LAWS[id].value;
    if (val && typeof val === 'object' && !Array.isArray(val) && val.rule !== undefined) {
      used.add(val.rule);
      assert.strictEqual(typeof val.rule, 'string', id);
    }
  }
  assert.deepStrictEqual([...used].sort(), R.RULE_NAMES.slice().sort());
  for (const name of R.RULE_NAMES) {
    const rr = R.RULES[name];
    assert.ok(Object.isFrozen(rr) && rr.law && rr.module && rr.what, name);
    assert.ok(IDS.includes(rr.law), name + ' serves ' + rr.law);
    assert.strictEqual(L.LAWS[rr.law].value.rule, name, name);
  }
  assert.ok(R.isRule('collideB') && !R.isRule('nope') && !R.isRule(undefined) && !R.isRule('toString'));
  const unknown = L.tableFrom(withRow('L35', { value: { rule: 'nope', f1: 14.5 } }));
  assert.throws(() => L.assertRulesBuilt(unknown), /L35 \(unknown rule "nope"\)/);
  assert.throws(() => L.assertRulesBuilt(unknown, ['L35']), /unknown rule/);
  assert.doesNotThrow(() => L.assertRulesBuilt(unknown, ['L36']));
  assert.throws(() => L.assertRulesBuilt(L.LAWS, ['L35', 'L36'], ['collideB']), (e) =>
    /L36 \(rule biggerWins is not built\)/.test(e.message) && !/L35/.test(e.message));
  assert.doesNotThrow(() => L.assertRulesBuilt(L.LAWS, ['L35', 'L36', 'L7'], ['collideB', 'biggerWins']));
  assert.throws(() => L.assertRulesBuilt(L.LAWS, ['NOPE']), /NOPE \(missing\)/);
});

test('tableFrom rejects malformed entries', () => {
  const base = L.ENTRIES[0];
  const bad = (change) => [Object.assign({}, base, change)];
  assert.throws(() => L.tableFrom(bad({ status: 'NOPE' })), /bad status/);
  assert.throws(() => L.tableFrom(bad({ status: 'FIXTURE' })), /FIXTURE in a real table/);
  assert.doesNotThrow(() => L.tableFrom(bad({ status: 'FIXTURE' }), { allowFixture: true }));
  assert.throws(() => L.tableFrom(bad({ source: ' ' })), /no source/);
  assert.throws(() => L.tableFrom(bad({ unit: '' })), /no unit/);
  assert.throws(() => L.tableFrom(bad({ name: '' })), /no name/);
  assert.throws(() => L.tableFrom(bad({ id: '' })), /without an id/);
  assert.throws(() => L.tableFrom(bad({ value: null })), /KNOWN with no value/);
  assert.doesNotThrow(() => L.tableFrom(bad({ status: 'OPEN', value: null })));
  assert.throws(() => L.tableFrom([base, base]), /duplicate law id L1/);
  assert.throws(() => L.tableFrom([null]), /not an object/);
});

test('the tables are frozen all the way down', () => {
  assert.ok(Object.isFrozen(L.LAWS) && Object.isFrozen(L.LAWS.L4) && Object.isFrozen(L.LAWS.L4.value));
  assert.ok(Object.isFrozen(L.LAWS['L24.colour.skin'].value.measured[9]));
  assert.ok(Object.isFrozen(L.LAWS['L39.rad'].value.points[0]));
  assert.ok(Object.isFrozen(L.ENTRIES) && Object.isFrozen(L.STATUS) && Object.isFrozen(R.RULES));
  assert.ok(Object.isFrozen(FIXTURE) && Object.isFrozen(L.withValues(L.LAWS, { L7: 1 })));
  assert.throws(() => { 'use strict'; L.LAWS.L7.value = 1; }, TypeError);
});

test('initFields: the full init event, encoded and decoded by slWire unchanged, floats on the client scale grid', () => {
  const ev = L.initFields(L.LAWS, 2923);
  assert.deepStrictEqual(ev, { type: 'init', grd: 32550, mscps: 430, sectorSize: 300, sectorCount: 102, spangdv: 4.8,
    nsp1: 5.39, nsp2: 0.4, nsp3: 14, mamu: 0.033, mamu2: 0.029, cst: 0.43, pv: 19, defaultMsl: 42, realSid: 0,
    fluxGrd: 2923, gameMode: 1, extraB: 0 });
  const out = slWire.decodeBundle(slWire.encodeBundle([ev], 19));
  assert.strictEqual(out.length, 1);
  assert.deepStrictEqual(out[0], ev);
  // Each number is one their packet could carry: an integer over 1, 10, 100 or 1000 gives back the same double.
  for (const k of Object.keys(ev)) {
    if (typeof ev[k] !== 'number') continue;
    assert.ok([1, 10, 100, 1000].some((d) => Object.is(Math.round(ev[k] * d) / d, ev[k])), k);
  }
  assert.throws(() => L.initFields(L.LAWS, 2923.5), TypeError);
  assert.throws(() => L.initFields(L.LAWS), TypeError);
  assert.throws(() => L.initFields(L.withValues(L.LAWS, { L3: null }), 3000), /L3/);
  assert.deepStrictEqual(L.initFields(FIXTURE, 3000).fluxGrd, 3000);
});

test('fixture: every entry FIXTURE, values equal the real table, the two caps hold test numbers', () => {
  assert.deepStrictEqual(Object.keys(FIXTURE), IDS);
  for (const id of IDS) {
    const f = FIXTURE[id];
    assert.strictEqual(f.status, 'FIXTURE', id);
    assert.match(f.source, /^FIXTURE \(test only\): /, id);
    if (Object.prototype.hasOwnProperty.call(TEST_ONLY, id)) assert.strictEqual(f.value, TEST_ONLY[id].value, id);
    else assert.strictEqual(JSON.stringify(f.value), JSON.stringify(L.LAWS[id].value), id);
  }
  assert.deepStrictEqual(Object.keys(TEST_ONLY), ['C_ROOM_CAP', 'C_HUMAN_CAP']);
  const p = makeFixture({ L7: 50 });
  assert.strictEqual(p.L7.value, 50);
  assert.strictEqual(p.L7.status, 'FIXTURE');
  assert.throws(() => makeFixture({ NOPE: 1 }), /NOPE/);
  assert.strictEqual(L.assertLawsComplete(FIXTURE), FIXTURE);
  assert.strictEqual(L.assertRulesBuilt(FIXTURE), FIXTURE);
});

function walk(dir, out) {
  let list;
  try {
    list = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const d of list) {
    if (d.name === 'node_modules' || d.name.startsWith('.')) continue;
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p, out);
    else if (/\.(c|m)?js$|\.html?$/.test(d.name)) out.push(p);
  }
  return out;
}

test('no shipped file imports the FIXTURE table', () => {
  const files = [];
  for (const dir of ['server', 'shared', 'public', 'scripts']) walk(path.join(ROOT, dir), files);
  files.push(path.join(ROOT, 'package.json'));
  assert.ok(files.length > 10);
  // A mention in a comment is fine; a require, an import or a script tag is not.
  const pull = /require\s*\([^)]*slLawsFixture|import\s*\([^)]*slLawsFixture|from\s*['"][^'"]*slLawsFixture|src\s*=\s*['"][^'"]*slLawsFixture/;
  assert.ok(pull.test("const x = require('../../test/slLawsFixture');"));
  const offenders = files.filter((f) => pull.test(fs.readFileSync(f, 'utf8')));
  assert.deepStrictEqual(offenders.map((f) => path.relative(ROOT, f)), []);
});

test('the law files hold no randomness, no clock, no money and no reference-folder path', () => {
  for (const f of ['server/sl/slLaws.js', 'server/sl/slRules.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.doesNotMatch(src, /Math\.random|Date\.now|new Date/, f);
    assert.doesNotMatch(src, /slither-reference|beautified/, f);
    const reqs = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    assert.ok(reqs.every((r) => r === './slRules'), f + ' requires ' + reqs.join(', '));
  }
});
