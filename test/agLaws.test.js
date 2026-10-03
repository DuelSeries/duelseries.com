'use strict';
// agar.io law table (build brief 7.1, 9.2 agLaws card) and its FIXTURE twin.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const L = require('../server/ag/agLaws');
const { FIXTURE, SUGGESTIONS, makeFixture } = require('./agLawsFixture');

const ROOT = path.join(__dirname, '..');
const APPROVED_IDS = Object.keys(L.LAWS).filter((id) => L.LAWS[id].status === 'APPROVED');
const MEASURED_IDS = Object.keys(L.LAWS).filter((id) => L.LAWS[id].status === 'MEASURED');
// Approval rows 9, 17 and 29: Owen approved them, then chose what the recordings show (OWNER-ANSWERS 2026-10-02,
// later), so they are MEASURED rows that still name their approval row.
const CHOSE_RECORDINGS = ['L11', 'L21', 'L37'];
const APPROVAL_ROW_IDS = Object.keys(L.LAWS).filter((id) => APPROVED_IDS.includes(id) || CHOSE_RECORDINGS.includes(id));

test('size and mass helpers hit the card numbers', () => {
  assert.strictEqual(L.sizeOf(36), 60);
  assert.strictEqual(L.sizeOf(32), 56.568542494923804);
  assert.ok(Math.abs(L.sizeOf(32) - 56.56854249) < 1e-8);
  assert.strictEqual(L.massOf(60), 36);
  assert.strictEqual(L.displayMass(31), 9);
  assert.strictEqual(L.displayMass(32), 10);
  assert.strictEqual(L.displayMass(60), 36);
  assert.strictEqual(L.displayMass(141), 198);
  // The KNOWN config rows agree with the helpers.
  assert.strictEqual(L.massOf(L.LAWS.L8.value), 36);
  assert.ok(Math.abs(L.massOf(L.LAWS.L19_CFG.value) - 32) < 1e-8);
});

test('a table with L1 set to null makes assertLawsComplete throw naming L1', () => {
  const t = L.withValues(FIXTURE, { L1: null });
  assert.throws(() => L.assertLawsComplete(t, ['L1']), /L1/);
  assert.doesNotThrow(() => L.assertLawsComplete(t, ['L2']));
  assert.throws(() => L.lawValue(t, 'L1'), /L1/);
});

test('the real table is complete; assertLawsComplete names every empty or UNKNOWN id asked for', () => {
  assert.strictEqual(L.assertLawsComplete(L.LAWS), L.LAWS);
  // Empty every approved row: each one is named.
  const patch = {};
  for (const id of APPROVED_IDS) patch[id] = null;
  let msg = '';
  try {
    L.assertLawsComplete(L.withValues(L.LAWS, patch));
  } catch (e) {
    msg = e.message;
  }
  for (const id of APPROVED_IDS) assert.match(msg, new RegExp('\\b' + id + '\\b'), id + ' not named');
  // A row turned UNKNOWN is named as UNKNOWN, and only the ids asked for are checked.
  const unk = L.tableFrom(L.ENTRIES.map((e) => (e.id !== 'L5' ? e
    : Object.assign({}, e, { status: 'UNKNOWN', value: null }))));
  assert.throws(() => L.assertLawsComplete(unk, ['L8', 'L5', 'L9']),
    (e) => /L5 \(Speed vs size\) is UNKNOWN/.test(e.message) && !/L8 /.test(e.message));
  assert.doesNotThrow(() => L.assertLawsComplete(unk, ['L8', 'L9', 'K_VIEW_FLOOR', 'MAP_N_MIN']));
  assert.throws(() => L.assertLawsComplete(L.LAWS, ['NOPE']), /NOPE \(missing\)/);
  assert.throws(() => L.assertLawsComplete(L.LAWS, 'L1'), TypeError);
  assert.throws(() => L.assertLawsComplete(null, ['L1']), TypeError);
});

test('shipped table: real statuses only, a source and unit on every entry, UNKNOWN holds null', () => {
  const ok = new Set(['KNOWN', 'MEASURED', 'APPROVED', 'CHOSEN', 'UNKNOWN']);
  for (const id of Object.keys(L.LAWS)) {
    const e = L.LAWS[id];
    assert.strictEqual(e.id, id);
    assert.ok(ok.has(e.status), id + ' status ' + e.status);
    assert.ok(typeof e.source === 'string' && e.source.trim().length > 0, id + ' source');
    assert.ok(typeof e.unit === 'string' && e.unit.trim().length > 0, id + ' unit');
    if (e.status === 'UNKNOWN') assert.strictEqual(e.value, null, id);
    else assert.notStrictEqual(e.value, null, id);
    if (e.status === 'CHOSEN') assert.match(e.source, /CHOSEN/, id);
    if (e.status === 'APPROVED') {
      // Owen's approval, the row on his page, the spec row, and where the approved suggestion came from.
      assert.match(e.source, /^APPROVED by Owen 2026-10-02 \(approval row \d+\); (server laws L\d+|PS-U\d+)/, id);
      assert.match(e.source, /\b(MEASURED|OTHER TYPE|CLIENT|MOII|CHOSEN|OWNER)\b/, id);
      if (/MEASURED/.test(e.source)) assert.match(e.source, /agar-20261001-210803 \+ agar-20261001-222428/, id);
      if (/OTHER TYPE/.test(e.source)) {
        assert.match(e.source, /OTHER TYPE \(recording agar-20261001-210803, its type-3/, id);
      }
      if (/MOII/.test(e.source)) assert.match(e.source, /MOII[^.;]*\(UNVERIFIED\)/, id);
    }
    // a MEASURED row names the recordings it came from (Owen's sessions on their FFA servers)
    if (e.status === 'MEASURED') assert.match(e.source, /^MEASURED: .*agar-20261001-210803 \+ agar-20261001-222428/, id);
  }
  // One row per server law L1 to L39 (the main id is what the server uses).
  for (let i = 1; i <= 39; i++) assert.ok(L.LAWS['L' + i], 'L' + i + ' missing');
  // The KNOWN rows hold exactly the brief 7.2 numbers.
  assert.strictEqual(L.LAWS.L8.value, 60);
  assert.strictEqual(L.LAWS.L9.value, 16);
  assert.strictEqual(L.LAWS.L14_CFG.value, 10);
  assert.strictEqual(L.LAWS.L19_CFG.value, 56.56854249);
  assert.strictEqual(L.LAWS.L37_CLIENT.value, 15);
  assert.strictEqual(L.LAWS.K_WIRE_SIZE_MAX.value, 32767);
  assert.deepStrictEqual(L.LAWS.K_VIEW_FLOOR.value, { w: 1920, h: 1080 });
});

test('every shipped entry is approved, measured, known or ours: the real table is shippable', () => {
  for (const id of Object.keys(L.LAWS)) {
    assert.ok(L.LAWS[id].status !== 'UNKNOWN' && L.LAWS[id].status !== 'FIXTURE', id + ' is ' + L.LAWS[id].status);
  }
  assert.strictEqual(L.assertShippable(L.LAWS), L.LAWS);
  const c = L.statusCounts(L.LAWS);
  assert.strictEqual(c.APPROVED, 29);
  assert.strictEqual(c.MEASURED, 15);
  assert.strictEqual(c.UNKNOWN, 0);
  assert.strictEqual(c.FIXTURE, 0);
  // Owen's 32 approval rows, each once, in the parity log's final table order (the three he later settled from the
  // recordings included).
  const rows = APPROVAL_ROW_IDS.map((id) => Number(/\(approval row (\d+)[;)]/.exec(L.LAWS[id].source)[1]));
  assert.deepStrictEqual(rows, Array.from({ length: 32 }, (_, i) => i + 1));
  // The 11 rows measured whole on FFA stay MEASURED, plus L32_GROW (the food growth rate the approved L32 rule
  // needs, measured on the same recordings after the approval and accepted by Owen) and the three approval rows
  // where Owen chose the recordings (L11, L21, L37).
  assert.deepStrictEqual(MEASURED_IDS, ['L1', 'L2', 'L11', 'L14', 'L20', 'L21', 'L23', 'L31', 'L32_GROW', 'L33', 'L36',
    'L37', 'U_ROUND', 'U_EAT_REMOVE', 'U_BOARD']);
});

test('L11, L21, L37: Owen chose the recordings over his approved value (OWNER-ANSWERS 2026-10-02, later)', () => {
  for (const id of CHOSE_RECORDINGS) {
    const e = L.LAWS[id];
    assert.strictEqual(e.status, 'MEASURED', id);
    assert.match(e.source, /Owen chose the recordings over his approved/, id);
    assert.match(e.source, /OWNER-ANSWERS 2026-10-02, later/, id);
    assert.match(e.source, /agar-20261001-210803/, id);
  }
  // L11: the measured first step on top of the fitted launch and decay, so the reach grows by about 23 units.
  const s = L.LAWS.L11.value;
  assert.deepStrictEqual(s, { velocity: 733.5, sizeExp: 0, decayDiv: 9.737, firstStep: 98.42 });
  assert.ok(Math.abs(s.firstStep - (98.07 + 98.78) / 2) < 0.006);      // the 2 FFA single splits
  const ahead = s.firstStep - s.velocity / s.decayDiv;
  assert.ok(Math.abs(ahead - 23.1) < 0.05, String(ahead));              // begins 23.1 ahead of the parent centre
  assert.ok(Math.abs(ahead + s.velocity - 756.5) < 0.1);                 // reaches 756.5 (approved 733.5)
  for (const want of ['93.91 to 102.94', '15.9 to', '756.5', 'analysis/ours/l11first.js', '9.49 to 10.00']) {
    assert.ok(L.LAWS.L11.source.includes(want), 'L11 source names ' + want);
  }
  // L21: the blob begins (size after the loss - blob size) from the centre, 8 of 8 recorded blobs.
  assert.deepStrictEqual(L.LAWS.L21.value, { velocity: 819.9, decayDiv: 10.235, spreadRad: 0.391,
    start: 'blobFarEdgeOnCellEdge' });
  for (const want of ['8 of 8 blobs', 'analysis/ours/l21start.js', '816.5 to 823.3']) {
    assert.ok(L.LAWS.L21.source.includes(want), 'L21 source names ' + want);
  }
  // L37: 15 characters of any kind (their server passed 15 characters of 26 UTF-16 units).
  assert.strictEqual(L.LAWS.L37.value, 15);
  assert.strictEqual(L.LAWS.L37.value, L.LAWS.L37_CLIENT.value);
  assert.match(L.LAWS.L37.unit, /any kind/);
  assert.ok(L.LAWS.L37.source.includes('26 UTF-16 units'));
});

test("the approved values are the ones on Owen's page (LAWS-TO-APPROVE rows 1 to 32, parity log final table)", () => {
  const expected = {
    L3: { radiusFactor: 0.5, reflectBoost: false },
    L4: { baseW: 1920, baseH: 1080, pad: 100.6, ref: 64, exp: 0.4, minScale: 0.0417 },
    L5: { coef: 83.466, exp: -0.4468, mult: 1 },
    L6: { rule: 'linearRamp', zoneSizes: 0.651 },
    L7: { minAgeTicks: 13, share: 'otherSizeSq' },
    L8_CMP: '>=',
    L9_CAP: { extraSplits: 'ignored', popLimitedToFreeSlots: true },
    L10: { newCellMassFraction: 0.5 },
    L12: { baseSec: 30, perSizeSec: 0.2 },
    L13: { rule: 'eatOverlapNoRatio', minAgeTicks: 13 },
    L15: { absorb: 1 },
    L16: { rate: 0.001994, periodTicks: 25 },
    L17: 1856,
    L18: 32,
    L19: Math.sqrt(3612.5),
    L22: { cooldownTicks: 3 },
    L24: { div: 3.04 },
    L25: { minSize: 100, maxSize: Math.sqrt(20000) },
    L26: { amount: 51, max: 100 },
    L27: { rule: 'area' },
    L28: { velocity: 798.8, decayDiv: 10.206, direction: 'lastBlob', resetToMin: true },
    L29: { rule: 'equalPieces', minPieceMass: 20 },
    L30: 1.17,
    L32: { minSize: 10, maxSize: 16, grows: 'whileUneaten' },
    L34: { amount: 2657 },
    L35: { ejectSpawnChance: 0 },
    L38: { start: 1, step: 1 },
    L39: 54,
    U_SPECTATE: { afterDeath: 'stayWhereDied', follow: 'top', zoom: 'followedPlayer' },
  };
  assert.deepStrictEqual(APPROVED_IDS, Object.keys(expected));
  for (const id of APPROVED_IDS) assert.deepStrictEqual(L.LAWS[id].value, expected[id], id);
  const v = (id) => L.LAWS[id].value;
  // The plain numbers on the page follow from them.
  const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, a + ' vs ' + b);
  near(v('L4').baseW + v('L4').pad, 2021, 0.5);                       // row 2: a box about 2,021 by 1,181
  near(v('L4').baseH + v('L4').pad, 1181, 0.5);
  assert.deepStrictEqual({ w: v('L4').baseW, h: v('L4').baseH }, v('K_VIEW_FLOOR'));
  near(v('L5').coef * Math.pow(32, v('L5').exp), 17.7, 0.05);         // row 3: 17.7 at the start
  near(v('L5').coef * Math.pow(100, v('L5').exp), 10.7, 0.05);        // row 3: 10.7 at size 100
  assert.strictEqual(Math.max(v('L12').baseSec, v('L12').perSizeSec * 170), 34);   // row 10: size 170 waits 34 s
  near(25 * v('L1'), 1000, 1);                                       // row 13: the decay step is once a second
  assert.strictEqual(Math.floor(L.massOf(v('L17'))), 34447);         // row 14: mass 34,447
  assert.strictEqual(v('L18'), v('L14'));                            // row 15: the start size
  near(v('L19'), 60.1, 0.01);                                        // row 16: size 60.1, mass 36.1
  near(L.massOf(v('L19')), 36.1, 0.05);
  near(v('L19') * v('L19'), v('L19_CLIENT'), 1e-9);
  near(L.massOf(v('L25').maxSize), 200, 1e-9);                       // row 20: fires at mass 200
  // row 22: 7 blobs of the measured size 38 (L20) make a new virus fire, 6 do not
  const fed = (n) => v('L25').minSize ** 2 + n * v('L20').blobSize ** 2;
  assert.ok(fed(6) < v('L25').maxSize ** 2 && fed(7) > v('L25').maxSize ** 2);
  assert.strictEqual(v('L30'), v('L23'));                            // row 25: the player eat rule
});

test('L32_GROW: the food growth the approved L32 rule needs, measured on the same FFA recordings', () => {
  const g = L.LAWS.L32_GROW;
  assert.strictEqual(g.status, 'MEASURED');
  assert.deepStrictEqual(g.value, { rule: 'randomStep', chancePerTick: 5.38e-4, stepSize: 1 });
  // 589 steps in 1,094,783 food-ticks (analysis/laws/food.js on agar-20261001-210803 + agar-20261001-222428).
  assert.ok(Math.abs(589 / 1094783 - g.value.chancePerTick) < 5e-7);
  for (const want of ['agar-20261001-210803', 'agar-20261001-222428', '589', '4.95e-4 to 5.83e-4', 'analysis/laws/food.js',
    'accepted as measured by Owen']) {
    assert.ok(g.source.includes(want), 'source names ' + want);
  }
  // About one step every 74 s of L1 ticks; the cap is the approved L32 maxSize.
  const sec = 1 / g.value.chancePerTick * L.LAWS.L1.value / 1000;
  assert.ok(sec > 73 && sec < 75, sec);
  assert.strictEqual(L.LAWS.L32.value.grows, 'whileUneaten');
});

test('assertShippable passes the real table and refuses any null, UNKNOWN, FIXTURE or unsourced row', () => {
  assert.doesNotThrow(() => L.assertShippable(L.LAWS));
  assert.throws(() => L.assertShippable(FIXTURE), /FIXTURE/);
  // Any one row emptied is refused, naming it.
  for (const id of Object.keys(L.LAWS)) {
    const named = new RegExp('\\b' + id + ' \\(no value\\)');
    assert.throws(() => L.assertShippable(L.withValues(L.LAWS, { [id]: null })), named, id);
  }
  // Any one row turned UNKNOWN or FIXTURE is refused.
  const turn = (id, status, value) => L.tableFrom(
    L.ENTRIES.map((e) => (e.id !== id ? e : Object.assign({}, e, { status, value }))), { allowFixture: true });
  assert.throws(() => L.assertShippable(turn('L39', 'UNKNOWN', null)), /L39 \(UNKNOWN\)/);
  assert.throws(() => L.assertShippable(turn('L5', 'FIXTURE', L.LAWS.L5.value)), /L5 \(FIXTURE\)/);
  // A row without a source is refused.
  const noSource = Object.assign({}, L.LAWS, { L6: Object.assign({}, L.LAWS.L6, { source: ' ' }) });
  assert.throws(() => L.assertShippable(noSource), /L6 \(no source\)/);
});

test('tableFrom rejects malformed entries', () => {
  const base = { id: 'X', name: 'x', value: 1, unit: 'u', status: 'KNOWN', source: 's' };
  assert.doesNotThrow(() => L.tableFrom([base]));
  assert.throws(() => L.tableFrom([Object.assign({}, base, { status: 'FIXTURE' })]), /FIXTURE/);
  assert.throws(() => L.tableFrom([Object.assign({}, base, { status: 'MAYBE' })]), /bad status/);
  assert.throws(() => L.tableFrom([Object.assign({}, base, { source: ' ' })]), /no source/);
  assert.throws(() => L.tableFrom([Object.assign({}, base, { status: 'UNKNOWN' })]), /has a value/);
  assert.throws(() => L.tableFrom([Object.assign({}, base, { value: null })]), /no value/);
  assert.throws(() => L.tableFrom([base, base]), /duplicate/);
});

test('the tables are frozen', () => {
  assert.throws(() => { L.LAWS.L8.value = 61; }, TypeError);
  assert.throws(() => { L.LAWS.K_VIEW_FLOOR.value.w = 1; }, TypeError);
  assert.throws(() => { FIXTURE.L3.value.radiusFactor = 1; }, TypeError);
  assert.throws(() => { L.LAWS.NEW = {}; }, TypeError);
});

test('statusCounts adds up', () => {
  const c = L.statusCounts(L.LAWS);
  assert.strictEqual(c.KNOWN + c.MEASURED + c.APPROVED + c.CHOSEN + c.UNKNOWN + c.FIXTURE, Object.keys(L.LAWS).length);
  assert.strictEqual(c.UNKNOWN, 0);
  assert.strictEqual(c.APPROVED, APPROVED_IDS.length);
  assert.strictEqual(c.FIXTURE, 0);
  assert.strictEqual(L.statusCounts(FIXTURE).FIXTURE, Object.keys(FIXTURE).length);
});

test('fixture: every entry FIXTURE, approved rows hold fixed test numbers, the rest copied from the real table', () => {
  // One fixed test number per approval row (the three Owen later settled from the recordings keep theirs too).
  assert.deepStrictEqual(Object.keys(SUGGESTIONS).sort(), APPROVAL_ROW_IDS.slice().sort());
  assert.deepStrictEqual(Object.keys(FIXTURE).sort(), Object.keys(L.LAWS).sort());
  for (const id of Object.keys(FIXTURE)) {
    const e = FIXTURE[id];
    assert.strictEqual(e.status, 'FIXTURE', id);
    assert.match(e.source, /FIXTURE/, id);
    if (SUGGESTIONS[id]) assert.deepStrictEqual(e.value, SUGGESTIONS[id].value, id);
    else assert.deepStrictEqual(e.value, L.LAWS[id].value, id);
  }
  assert.doesNotThrow(() => L.assertLawsComplete(FIXTURE));
  // Spot values the sim card leans on (brief 9.2 agSim).
  assert.strictEqual(FIXTURE.L8_CMP.value, '>=');
  assert.strictEqual(FIXTURE.L10.value.newCellMassFraction, 0.5);
  assert.strictEqual(FIXTURE.L23.value, L.LAWS.L23.value);   // MEASURED, copied from the real table
  assert.strictEqual(FIXTURE.L24.value.div, 3);
  assert.strictEqual(FIXTURE.L15.value.absorb, 1);
  assert.strictEqual(FIXTURE.L2.value, L.LAWS.L2.value);
  assert.strictEqual(FIXTURE.L39.value, 50);
  // Fixed test numbers, not the approved ones.
  assert.strictEqual(FIXTURE.L5.value.coef, 2.2);
  assert.strictEqual(L.LAWS.L5.value.coef, 83.466);
  assert.strictEqual(FIXTURE.L14.value, L.LAWS.L14.value);
  // Overrides make a fresh table and refuse ids that do not exist.
  const t = makeFixture({ L8_CMP: '>' });
  assert.strictEqual(t.L8_CMP.value, '>');
  assert.strictEqual(FIXTURE.L8_CMP.value, '>=');
  assert.throws(() => makeFixture({ NOPE: 1 }), /NOPE/);
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
  const pull = /require\s*\([^)]*agLawsFixture|import\s*\([^)]*agLawsFixture|from\s*['"][^'"]*agLawsFixture|src\s*=\s*['"][^'"]*agLawsFixture/;
  const offenders = files.filter((f) => pull.test(fs.readFileSync(f, 'utf8')));
  assert.ok(pull.test("const x = require('../../test/agLawsFixture');"));
  assert.deepStrictEqual(offenders.map((f) => path.relative(ROOT, f)), []);
});

test('clean room: law, rng and map files carry no reference line citations and no candidate numbers', () => {
  const files = ['server/ag/agLaws.js', 'server/ag/agMap.js', 'server/ag/agRng.js'].map((f) => path.join(ROOT, f));
  const candidates = ['14142', '7071', '31.62', '780', '0.0122', '36.06', '42.43', '141.42', '1500', '22500', '0.002'];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /\b[DW]\s+\d{3,}/, f + ' cites D/W lines');
    assert.doesNotMatch(src, /\.wat\b|\.dcmp\b|agario-reference/, f + ' names reference files');
    for (const c of candidates) assert.ok(!src.includes(c), f + ' holds candidate number ' + c);
  }
});
