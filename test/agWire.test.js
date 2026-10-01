'use strict';
// agar.io redo, wire card: shared/agWire.js (build brief section 8 and module card 9.2).
// Byte counts 8 / 41 / 21, round trip of every field and every bit, names under the L37 cap in
// UTF-8, and a decoder that never throws and never trusts a count it cannot back with bytes.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const W = require('../shared/agWire.js');
const WIRE_FILE = path.join(__dirname, '../shared/agWire.js');

// Deterministic generator for the fuzz runs (test-only; not the game's rng).
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Reads L37 from the shared fixture when the laws card has written it; null otherwise.
function fixtureNameCap() {
  const p = path.join(__dirname, 'agLawsFixture.js');
  if (!fs.existsSync(p)) return null;
  const mod = require(p);
  const tables = [mod, mod && mod.LAWS, mod && mod.laws, mod && mod.FIXTURE].filter(Boolean);
  for (const t of tables) {
    const e = Array.isArray(t) ? t.find((x) => x && x.id === 'L37') : t.L37;
    if (e && typeof e.value === 'number') return e.value;
  }
  return null;
}

function cell(over) {
  return Object.assign({ id: 1, x: 0, y: 0, size: 10, virus: false, food: false, ejected: false,
    agitated: false, flag40: false, party: false }, over);
}

function roundTrip(records, opts) {
  const buf = W.encodeBundle(records, opts);
  assert.strictEqual(buf.length, W.bundleSize(records, opts), 'bundleSize agrees with the encoder');
  const out = W.decodeBundle(buf);
  assert.ok(!out.some((m) => m.t === 'error'), 'no error record: ' + JSON.stringify(out[out.length - 1]));
  return { buf, out };
}

// ---------------------------------------------------------------------------------------------
// Section 8 byte self-test numbers.
// ---------------------------------------------------------------------------------------------

test('an empty world bundle is 8 bytes', () => {
  const buf = W.encodeBundle([{ t: 'world', eats: [], cells: [], removed: [] }]);
  assert.strictEqual(buf.length, 8);
  assert.deepStrictEqual(Array.from(buf), [1, 6, 0, 0, 0, 0, 0, 0]);
});

test('one eat, one cell with rgb and name "ab", one removal is 41 bytes; the cell alone is 21', () => {
  const c = cell({ id: 0x01020304, x: -5, y: 300, size: 513, food: true, rgb: [255, 7, 128], name: 'ab' });
  const rec = { t: 'world', eats: [[7, 9]], cells: [c], removed: [9] };
  const buf = W.encodeBundle([rec]);
  assert.strictEqual(buf.length, 41);
  const empty = W.bundleSize([{ t: 'world', eats: [], cells: [], removed: [] }]);
  const oneCell = W.bundleSize([{ t: 'world', eats: [], cells: [c], removed: [] }]);
  assert.strictEqual(oneCell - empty, 21);
  // Byte by byte, little endian.
  assert.deepStrictEqual(Array.from(buf), [
    1,                      // version
    6,                      // kind world
    1, 0, 7, 0, 0, 0, 9, 0, 0, 0,   // 1 eat: 7 eats 9
    1, 0,                   // 1 cell
    4, 3, 2, 1,             // id
    0xFB, 0xFF, 0xFF, 0xFF, // x -5
    0x2C, 0x01, 0, 0,       // y 300
    1, 2,                   // size 513
    2 | 64 | 128,           // food, hasRgb, hasName
    255, 7, 128,            // rgb
    2, 97, 98,              // "ab"
    1, 0, 9, 0, 0, 0        // 1 removal: 9
  ]);
  const out = W.decodeBundle(buf);
  assert.deepStrictEqual(out, [rec]);
});

test('fixed record sizes: hello 3, border 34 or 35, own 5, clears 1, cam 13', () => {
  const size = (r) => W.bundleSize([r]) - 1;
  assert.strictEqual(size({ t: 'hello' }), 3);
  assert.strictEqual(size({ t: 'border', minX: 0, minY: 0, maxX: 1, maxY: 1 }), 34);
  assert.strictEqual(size({ t: 'border', minX: 0, minY: 0, maxX: 1, maxY: 1, mode: 0 }), 35);
  assert.strictEqual(size({ t: 'own', id: 5 }), 5);
  assert.strictEqual(size({ t: 'clearOwn' }), 1);
  assert.strictEqual(size({ t: 'clearAll' }), 1);
  assert.strictEqual(size({ t: 'cam', x: 0, y: 0, zoom: 1 }), 13);
  assert.strictEqual(W.encodeBundle([]).length, 1);
  assert.deepStrictEqual(W.decodeBundle(W.encodeBundle([])), []);
});

// ---------------------------------------------------------------------------------------------
// Round trips.
// ---------------------------------------------------------------------------------------------

test('every record kind round trips, in order', () => {
  const records = [
    { t: 'hello', protocol: W.PROTOCOL_VERSION },
    { t: 'border', minX: -7071.067811865476, minY: -7071.067811865476, maxX: 7071.067811865476, maxY: 7071.067811865476, mode: 0 },
    { t: 'border', minX: -2000.5, minY: -1e-300, maxX: 1e300, maxY: 2000 },
    { t: 'own', id: 2001 },
    { t: 'world', eats: [], cells: [cell({ id: 2001, x: 10, y: -20, size: 45, rgb: [7, 255, 99] })], removed: [] },
    { t: 'cam', x: 1.5, y: -2.25, zoom: 0.5 },
    { t: 'board', rows: [{ name: 'alpha', rank: 1 }, { me: true }, {}, { name: '' }] },
    { t: 'clearOwn' },
    { t: 'sync', eats: [[1, 2]], cells: [cell({ id: 3, name: 'x' })], removed: [2] },
    { t: 'clearAll' }
  ];
  const { out } = roundTrip(records);
  assert.deepStrictEqual(out, records);
});

test('hello without a protocol field encodes the module protocol version', () => {
  const { out } = roundTrip([{ t: 'hello' }]);
  assert.deepStrictEqual(out, [{ t: 'hello', protocol: W.PROTOCOL_VERSION }]);
});

test('border mode absent stays absent (border-only resend); present modes 0 and 255 survive', () => {
  for (const mode of [undefined, 0, 1, 255]) {
    const r = { t: 'border', minX: -1, minY: -2, maxX: 3, maxY: 4 };
    if (mode !== undefined) r.mode = mode;
    const { out } = roundTrip([r]);
    assert.deepStrictEqual(out, [r]);
    assert.strictEqual('mode' in out[0], mode !== undefined);
  }
});

test('border corners in either order decode to min and max (their client normalises, PS 6.1)', () => {
  const buf = W.encodeBundle([{ t: 'border', minX: 50, minY: 40, maxX: -50, maxY: -40 }]);
  assert.deepStrictEqual(W.decodeBundle(buf), [{ t: 'border', minX: -50, minY: -40, maxX: 50, maxY: 40 }]);
});

test('all 256 cell bit combinations round trip exactly', () => {
  const flags = ['virus', 'food', 'ejected', 'agitated', 'flag40', 'party'];
  const cells = [];
  for (let m = 0; m < 256; m++) {
    const c = { id: m + 1, x: m * 3 - 400, y: 400 - m, size: m * 7 };
    flags.forEach((f, i) => { c[f] = (m & (1 << i)) !== 0; });
    if (m & 64) c.rgb = [m, 255 - m, 7];
    if (m & 128) c.name = 'n' + m;
    cells.push(c);
  }
  const rec = { t: 'world', eats: [], cells, removed: [] };
  const { buf, out } = roundTrip([rec]);
  assert.deepStrictEqual(out, [rec]);
  // Each flag lands on its own bit (section 8 order).
  const bitsAt = []; let p = 1 + 1 + 2 + 2;
  for (const c of cells) {
    p += 14; bitsAt.push(buf[p]); p += 1;
    if (c.rgb) p += 3;
    if (c.name !== undefined) p += 1 + Buffer.byteLength(c.name);
  }
  bitsAt.forEach((b, m) => assert.strictEqual(b, m, 'cell ' + m + ' bits byte'));
  assert.deepStrictEqual(W.CELL_BIT, { virus: 1, food: 2, ejected: 4, agitated: 8, flag40: 16, party: 32, hasRgb: 64, hasName: 128 });
});

test('every decoded cell carries all six flag booleans; rgb and name only when sent', () => {
  const rec = { t: 'world', eats: [], cells: [{ id: 9, x: 1, y: 2, size: 3, virus: 1, party: 'yes' }], removed: [] };
  const [m] = W.decodeBundle(W.encodeBundle([rec]));
  assert.deepStrictEqual(m.cells[0], { id: 9, x: 1, y: 2, size: 3, virus: true, food: false, ejected: false,
    agitated: false, flag40: false, party: true });
  assert.ok(!('rgb' in m.cells[0]) && !('name' in m.cells[0]));
});

test('integer ranges at their edges', () => {
  const c = cell({ id: 4294967295, x: -2147483648, y: 2147483647, size: 65535, rgb: [0, 0, 255] });
  const c2 = cell({ id: 1, x: 2147483647, y: -2147483648, size: 0, rgb: [255, 255, 0] });
  const rec = { t: 'world', eats: [[4294967295, 1]], cells: [c, c2], removed: [4294967295, 1] };
  const { out } = roundTrip([rec, { t: 'own', id: 4294967295 }, { t: 'board', rows: [{ rank: 0 }, { rank: 65535, me: true }] }]);
  assert.deepStrictEqual(out[0], rec);
  assert.strictEqual(out[1].id, 4294967295);
  assert.deepStrictEqual(out[2].rows, [{ rank: 0 }, { rank: 65535, me: true }]);
});

test('every board row bit combination round trips; bits are me 1, hasName 2, hasRank 4', () => {
  const rows = [];
  for (let m = 0; m < 8; m++) {
    const r = {};
    if (m & 1) r.me = true;
    if (m & 2) r.name = 'p' + m;
    if (m & 4) r.rank = 100 + m;
    rows.push(r);
  }
  const { buf, out } = roundTrip([{ t: 'board', rows }]);
  assert.deepStrictEqual(out, [{ t: 'board', rows }]);
  assert.strictEqual(buf[2], 8);
  assert.strictEqual(buf[3], 0);           // row 0: no bits
  assert.strictEqual(buf[4], 1);           // row 1: me
  assert.strictEqual(buf[5], 2);           // row 2: hasName
  assert.deepStrictEqual(W.ROW_BIT, { me: 1, hasName: 2, hasRank: 4 });
  // 255 rows is the format's ceiling.
  const many = Array.from({ length: 255 }, (_, i) => ({ rank: i }));
  assert.strictEqual(roundTrip([{ t: 'board', rows: many }]).out[0].rows.length, 255);
  assert.throws(() => W.encodeBundle([{ t: 'board', rows: many.concat([{}]) }]), RangeError);
});

test('cam carries f32: f32-exact values round trip, others come back as Math.fround', () => {
  const { out } = roundTrip([{ t: 'cam', x: -1234.5, y: 0.25, zoom: 0.5 }]);
  assert.deepStrictEqual(out[0], { t: 'cam', x: -1234.5, y: 0.25, zoom: 0.5 });
  const [m] = W.decodeBundle(W.encodeBundle([{ t: 'cam', x: 0.1, y: 1 / 3, zoom: 1.1 }]));
  assert.deepStrictEqual([m.x, m.y, m.zoom], [Math.fround(0.1), Math.fround(1 / 3), Math.fround(1.1)]);
});

test('records keep their order: own before the world record that carries the cell', () => {
  const recs = [{ t: 'own', id: 5 }, { t: 'world', eats: [], cells: [cell({ id: 5, rgb: [1, 2, 3] })], removed: [] }, { t: 'own', id: 6 }];
  assert.deepStrictEqual(roundTrip(recs).out.map((m) => m.t + (m.id || '')), ['own5', 'world', 'own6']);
});

// ---------------------------------------------------------------------------------------------
// Names: UTF-8 and the L37 cap (an input, never a number in the module).
// ---------------------------------------------------------------------------------------------

test('UTF-8 names round trip (multi-byte, emoji, empty)', () => {
  const names = ['', 'owen', 'Zoë', '日本語', 'a😀b', 'x'.repeat(255)];
  const rec = { t: 'world', eats: [], cells: names.map((n, i) => cell({ id: i + 1, name: n })), removed: [] };
  const { out } = roundTrip([rec, { t: 'board', rows: names.map((n) => ({ name: n })) }]);
  assert.deepStrictEqual(out[0].cells.map((c) => c.name), names);
  assert.deepStrictEqual(out[1].rows.map((r) => r.name), names);
});

test('names are cut to maxNameBytes on a UTF-8 character boundary', () => {
  const enc = (name, cap) => W.decodeBundle(W.encodeBundle(
    [{ t: 'world', eats: [], cells: [cell({ name })], removed: [] }, { t: 'board', rows: [{ name }] }],
    { maxNameBytes: cap }));
  for (const [name, cap, want] of [
    ['abcdef', 4, 'abcd'],
    ['aé', 2, 'a'],          // é is 2 bytes; never half of it
    ['aé', 3, 'aé'],
    ['日本', 5, '日'],        // 3 + 3 bytes
    ['😀x', 3, ''],          // a 4-byte emoji does not fit in 3
    ['😀x', 4, '😀'],
    ['abc', 0, '']
  ]) {
    const out = enc(name, cap);
    assert.strictEqual(out[0].cells[0].name, want, name + ' cap ' + cap);
    assert.strictEqual(out[1].rows[0].name, want, name + ' cap ' + cap + ' (board)');
    assert.ok(Buffer.byteLength(want) <= cap);
  }
});

test('the format ceiling is 255 bytes; a larger cap is clamped, a bad cap throws', () => {
  const long = 'é'.repeat(200);          // 400 bytes
  const [m] = W.decodeBundle(W.encodeBundle([{ t: 'board', rows: [{ name: long }] }], { maxNameBytes: 1000 }));
  assert.strictEqual(Buffer.byteLength(m.rows[0].name), 254);   // 127 whole characters
  const [d] = W.decodeBundle(W.encodeBundle([{ t: 'board', rows: [{ name: long }] }]));
  assert.strictEqual(d.rows[0].name, m.rows[0].name, 'no option = the 255-byte format ceiling');
  for (const bad of [-1, 1.5, NaN, '15']) {
    assert.throws(() => W.encodeBundle([], { maxNameBytes: bad }), RangeError);
  }
});

test('names up to the fixture L37 cap pass whole; one byte over is cut', (t) => {
  const cap = fixtureNameCap();
  if (cap === null) { t.skip('test/agLawsFixture.js (laws card) not written yet'); return; }
  const fits = 'n'.repeat(cap), over = 'n'.repeat(cap + 1);
  const [m] = W.decodeBundle(W.encodeBundle([{ t: 'world', eats: [], cells: [cell({ name: fits }), cell({ id: 2, name: over })], removed: [] }], { maxNameBytes: cap }));
  assert.strictEqual(m.cells[0].name, fits);
  assert.strictEqual(m.cells[1].name, fits);
});

// ---------------------------------------------------------------------------------------------
// The encoder refuses what the wire cannot carry (server bugs fail loudly, nothing is rounded).
// ---------------------------------------------------------------------------------------------

test('encoder throws on id 0, non-integers, out-of-range and non-finite values', () => {
  const world = (over, extra) => [Object.assign({ t: 'world', eats: [], cells: [cell(over)], removed: [] }, extra)];
  const bad = [
    world({ id: 0 }),
    world({ id: 4294967296 }),
    world({ x: 1.5 }),
    world({ y: 2147483648 }),
    world({ size: 10.2 }),
    world({ size: -1 }),
    world({ size: 65536 }),
    world({ x: NaN }),
    world({ rgb: [256, 0, 0] }),
    world({ rgb: [1, 2] }),
    world({}, { eats: [[0, 1]] }),
    world({}, { eats: [[1]] }),
    world({}, { removed: [0] }),
    world({}, { removed: [-3] }),
    [{ t: 'own', id: 0 }],
    [{ t: 'border', minX: NaN, minY: 0, maxX: 1, maxY: 1 }],
    [{ t: 'border', minX: 0, minY: 0, maxX: Infinity, maxY: 1 }],
    [{ t: 'border', minX: 0, minY: 0, maxX: 1, maxY: 1, mode: 256 }],
    [{ t: 'cam', x: 0, y: 0, zoom: Infinity }],
    [{ t: 'board', rows: [{ rank: 70000 }] }],
    [{ t: 'board', rows: 'x' }],
    [{ t: 'hello', protocol: -1 }],
    [{ t: 'nope' }],
    [null],
    'not an array'
  ];
  bad.forEach((recs, i) => assert.throws(() => W.encodeBundle(recs), /agWire/, 'case ' + i));
});

test('more than 65535 cells, eats or removals in one record throws (u16 counts)', () => {
  const big = new Array(65536).fill(1);
  assert.throws(() => W.encodeBundle([{ t: 'world', eats: [], cells: [], removed: big }]), RangeError);
});

// ---------------------------------------------------------------------------------------------
// The decoder never throws and never over-allocates.
// ---------------------------------------------------------------------------------------------

function richBundle() {
  return W.encodeBundle([
    { t: 'hello' },
    { t: 'border', minX: -3000, minY: -2000, maxX: 3000, maxY: 2000, mode: 0 },
    { t: 'own', id: 2001 },
    { t: 'world', eats: [[2001, 5001], [3101, 4001]],
      cells: [cell({ id: 2001, x: 5, y: 6, size: 51, rgb: [255, 7, 40], name: 'owen' }), cell({ id: 3101, size: 104, virus: true, rgb: [51, 255, 51] })],
      removed: [5001, 4001] },
    { t: 'cam', x: 1, y: 2, zoom: 0.5 },
    { t: 'board', rows: [{ name: 'giant', rank: 1 }, { me: true, name: 'Zoë' }] },
    { t: 'sync', eats: [], cells: [cell({ id: 7, name: '日本' })], removed: [] },
    { t: 'clearOwn' }, { t: 'clearAll' }
  ]);
}

test('every truncation of a bundle decodes to a prefix of its records plus one error record', () => {
  const full = richBundle();
  const whole = W.decodeBundle(full);
  assert.strictEqual(whole.length, 9);
  for (let n = 0; n < full.length; n++) {
    const out = W.decodeBundle(full.subarray(0, n));
    const last = out[out.length - 1];
    const body = out.slice(0, -1);
    if (n === 0) { assert.strictEqual(last.reason, 'empty bundle'); continue; }
    // A cut that lands exactly between records is a valid shorter bundle; otherwise one error record.
    if (!last || last.t !== 'error') {
      assert.deepStrictEqual(out, whole.slice(0, out.length), 'clean cut at ' + n);
      continue;
    }
    assert.deepStrictEqual(body, whole.slice(0, body.length), 'prefix at ' + n);
    assert.ok(Number.isInteger(last.offset) && last.offset < n && typeof last.reason === 'string');
    assert.strictEqual(out.filter((m) => m.t === 'error').length, 1);
  }
});

test('hostile counts fail fast with no big allocation', () => {
  const cases = [
    [1, 6, 0xFF, 0xFF],                              // 65535 eats, no bytes
    [1, 6, 0, 0, 0xFF, 0xFF, 1, 2, 3],               // 65535 cells, 3 bytes
    [1, 6, 0, 0, 0, 0, 0xFF, 0xFF],                  // 65535 removals, none present
    [1, 8, 255, 0],                                  // 255 board rows, 1 byte
    [1, 8, 1, 2, 200, 97]                            // name length 200, 1 byte present
  ];
  for (const bytes of cases) {
    const out = W.decodeBundle(Uint8Array.from(bytes));
    assert.strictEqual(out.length, 1, JSON.stringify(bytes));
    assert.strictEqual(out[0].t, 'error');
    assert.match(out[0].reason, /truncated/);
  }
});

test('bad version, unknown kind, id 0 and a bad border mode flag give error records', () => {
  assert.match(W.decodeBundle(Uint8Array.from([2, 5]))[0].reason, /version/);
  const unk = W.decodeBundle(Uint8Array.from([1, 4, 99, 0]));
  assert.deepStrictEqual(unk.map((m) => m.t), ['clearOwn', 'error']);
  assert.deepStrictEqual([unk[1].kind, unk[1].offset], [99, 2]);
  assert.match(W.decodeBundle(Uint8Array.from([1, 3, 0, 0, 0, 0]))[0].reason, /id 0/);
  assert.match(W.decodeBundle(Uint8Array.from([1, 6, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0]))[0].reason, /id 0/);
  const b = W.encodeBundle([{ t: 'border', minX: 0, minY: 0, maxX: 1, maxY: 1 }]);
  b[b.length - 1] = 2;
  assert.match(W.decodeBundle(b)[0].reason, /mode flag/);
});

test('non-binary input gives an error record, never a throw', () => {
  for (const v of [undefined, null, 0, 'abc', {}, [1, 6, 0, 0], { length: 5 }, true]) {
    const out = W.decodeBundle(v);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].t, 'error');
  }
});

test('ArrayBuffer, DataView and an offset Buffer slice all decode (browser and node inputs)', () => {
  const full = richBundle();
  const want = W.decodeBundle(full);
  const ab = full.buffer.slice(full.byteOffset, full.byteOffset + full.length);
  assert.deepStrictEqual(W.decodeBundle(ab), want);
  assert.deepStrictEqual(W.decodeBundle(new DataView(ab)), want);
  const padded = Buffer.alloc(full.length + 7);
  padded.set(full, 5);
  assert.deepStrictEqual(W.decodeBundle(padded.subarray(5, 5 + full.length)), want);
});

test('20,000 random and mutated buffers never throw; decoded entries never outnumber the bytes', () => {
  const r = rng(7);
  const base = richBundle();
  for (let i = 0; i < 20000; i++) {
    let b;
    if (i % 2) {
      b = new Uint8Array(Math.floor(r() * 64));
      for (let j = 0; j < b.length; j++) b[j] = Math.floor(r() * 256);
      if (b.length && r() < 0.7) b[0] = 1;
      if (b.length > 1 && r() < 0.7) b[1] = 1 + Math.floor(r() * 9);
    } else {
      b = Uint8Array.from(base);
      for (let k = 0, n = 1 + Math.floor(r() * 4); k < n; k++) b[Math.floor(r() * b.length)] = Math.floor(r() * 256);
      b = b.subarray(0, Math.floor(r() * (b.length + 1)));
    }
    let out;
    assert.doesNotThrow(() => { out = W.decodeBundle(b); });
    assert.ok(Array.isArray(out));
    let entries = 0;
    for (const m of out) {
      if (m.t === 'error') continue;
      entries += 1 + (m.cells ? m.cells.length : 0) + (m.eats ? m.eats.length : 0) +
        (m.removed ? m.removed.length : 0) + (m.rows ? m.rows.length : 0);
    }
    assert.ok(entries <= b.length, 'entries ' + entries + ' > bytes ' + b.length);
    assert.ok(out.filter((m) => m.t === 'error').length <= 1);
  }
});

// ---------------------------------------------------------------------------------------------
// One module for both ends, and clean-room hygiene of the shipped file.
// ---------------------------------------------------------------------------------------------

test('loads as a plain browser script onto DuelAgarLib.agWire and agrees with the node build', () => {
  const src = fs.readFileSync(WIRE_FILE, 'utf8');
  const win = {};
  const ctx = vm.createContext({ window: win, TextEncoder, TextDecoder });
  vm.runInContext(src, ctx, { filename: 'agWire.js' });
  const BW = win.DuelAgarLib && win.DuelAgarLib.agWire;
  assert.ok(BW && typeof BW.decodeBundle === 'function');
  const full = richBundle();
  // The browser receives an ArrayBuffer from socket.io.
  const ab = full.buffer.slice(full.byteOffset, full.byteOffset + full.length);
  const fromBrowser = JSON.parse(JSON.stringify(BW.decodeBundle(ab)));
  assert.deepStrictEqual(fromBrowser, JSON.parse(JSON.stringify(W.decodeBundle(full))));
  const reenc = BW.encodeBundle(fromBrowser);
  assert.deepStrictEqual(Array.from(reenc), Array.from(full));
});

test('shipped file carries no reference line citations, no reference identifiers, no fixture values', () => {
  const src = fs.readFileSync(WIRE_FILE, 'utf8');
  assert.doesNotMatch(src, /`[DW]`|\b[DW] \d{3,}|\bf_[a-z]{2}\b|\bMC \d|\bEND \d|agLawsFixture|FIXTURE|agario-reference/);
  assert.doesNotMatch(src, /Math\.random|Date\.now/);
});

// Review fix (robustness): a non-finite cam or border value, or a cam zoom that is not above 0, only comes from a
// server bug and would stick in the client camera, so decode refuses it with an error record (records before it kept).
test('non-finite cam and border values and a zoom not above 0 decode as error records', () => {
  const camBundle = (patch) => {
    const b = Buffer.from(W.encodeBundle([{ t: 'own', id: 5 }, { t: 'cam', x: 1, y: 2, zoom: 0.5 }]));
    const v = new DataView(b.buffer, b.byteOffset, b.length);
    patch(v, 1 + 5 + 1);                            // version, own record (5 bytes), cam kind byte
    return b;
  };
  const cases = [
    (v, o) => v.setFloat32(o, NaN, true),
    (v, o) => v.setFloat32(o + 4, Infinity, true),
    (v, o) => v.setFloat32(o + 8, NaN, true),
    (v, o) => v.setFloat32(o + 8, -Infinity, true),
    (v, o) => v.setFloat32(o + 8, 0, true),
    (v, o) => v.setFloat32(o + 8, -0.5, true)
  ];
  for (const patch of cases) {
    const out = W.decodeBundle(camBundle(patch));
    assert.deepStrictEqual(out[0], { t: 'own', id: 5 });
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[1].t, 'error');
    assert.strictEqual(out[1].reason, 'bad cam value');
  }
  assert.deepStrictEqual(W.decodeBundle(camBundle(() => {}))[1], { t: 'cam', x: 1, y: 2, zoom: 0.5 });

  for (let k = 0; k < 4; k++) {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const b = Buffer.from(W.encodeBundle([{ t: 'border', minX: -10, minY: -10, maxX: 10, maxY: 10, mode: 0 }]));
      new DataView(b.buffer, b.byteOffset, b.length).setFloat64(2 + 8 * k, bad, true);
      const out = W.decodeBundle(b);
      assert.strictEqual(out.length, 1);
      assert.strictEqual(out[0].t, 'error');
      assert.strictEqual(out[0].reason, 'non-finite border');
    }
  }
});
