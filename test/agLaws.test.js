'use strict';
// agar.io law table (build brief 7.1, 9.2 agLaws card) and its FIXTURE twin.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const L = require('../server/ag/agLaws');
const { FIXTURE, SUGGESTIONS, makeFixture } = require('./agLawsFixture');

const ROOT = path.join(__dirname, '..');
const UNKNOWN_IDS = Object.keys(L.LAWS).filter((id) => L.LAWS[id].status === 'UNKNOWN');

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

test('the real table cannot start a room: assertLawsComplete names every UNKNOWN id asked for', () => {
  assert.ok(UNKNOWN_IDS.length > 0);
  let msg = '';
  try {
    L.assertLawsComplete(L.LAWS);
  } catch (e) {
    msg = e.message;
  }
  for (const id of UNKNOWN_IDS) assert.match(msg, new RegExp('\\b' + id + '\\b'), id + ' not named');
  assert.throws(() => L.assertLawsComplete(L.LAWS, ['L8', 'L5', 'L9']), (e) => /L5/.test(e.message) && !/L8 /.test(e.message));
  assert.doesNotThrow(() => L.assertLawsComplete(L.LAWS, ['L8', 'L9', 'K_VIEW_FLOOR', 'MAP_N_MIN']));
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
    if (e.status === 'APPROVED') assert.match(e.source, /approved by Owen/i, id);
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

test('every shipped entry is approved or ours (fails until Owen answers UNKNOWNS.html)', { todo: 'waits for Owen' }, () => {
  for (const id of Object.keys(L.LAWS)) {
    assert.ok(L.LAWS[id].status !== 'UNKNOWN' && L.LAWS[id].status !== 'FIXTURE', id + ' is ' + L.LAWS[id].status);
  }
  assert.doesNotThrow(() => L.assertShippable(L.LAWS));
});

test('assertShippable rejects UNKNOWN and FIXTURE, passes once every UNKNOWN is APPROVED', () => {
  assert.throws(() => L.assertShippable(L.LAWS), /UNKNOWN/);
  assert.throws(() => L.assertShippable(FIXTURE), /FIXTURE/);
  const approved = L.tableFrom(L.ENTRIES.map((e) => (e.status !== 'UNKNOWN' ? e : Object.assign({}, e, {
    status: 'APPROVED', value: SUGGESTIONS[e.id].value, source: 'test: suggestion approved by Owen (simulated)',
  }))));
  assert.doesNotThrow(() => L.assertShippable(approved));
  assert.doesNotThrow(() => L.assertLawsComplete(approved));
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
  assert.strictEqual(c.UNKNOWN, UNKNOWN_IDS.length);
  assert.strictEqual(c.FIXTURE, 0);
  assert.strictEqual(L.statusCounts(FIXTURE).FIXTURE, Object.keys(FIXTURE).length);
});

test('fixture: every entry FIXTURE, every UNKNOWN filled, the rest copied from the real table', () => {
  assert.deepStrictEqual(Object.keys(SUGGESTIONS).sort(), UNKNOWN_IDS.slice().sort());
  assert.deepStrictEqual(Object.keys(FIXTURE).sort(), Object.keys(L.LAWS).sort());
  for (const id of Object.keys(FIXTURE)) {
    const e = FIXTURE[id];
    assert.strictEqual(e.status, 'FIXTURE', id);
    assert.match(e.source, /FIXTURE/, id);
    if (L.LAWS[id].status === 'UNKNOWN') assert.deepStrictEqual(e.value, SUGGESTIONS[id].value, id);
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
