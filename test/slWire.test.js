'use strict';
// slither.io redo, wire card: shared/slWire.js (build brief section 7 and module card 11).
// The W1-W23 vectors byte for byte, decode equal to the 6.2 projection with Object.is on every
// number, re-encode stable, the exact-value number search, the prefix rule of 7.5, and a decoder
// that never throws and never trusts a count it cannot back with bytes.
// Inputs are literals copied from the CA fixtures (spec/core-apply-fixtures.json); nothing is read
// from slither-reference at test time.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const W = require('../shared/slWire.js');
const WIRE_FILE = path.join(__dirname, '../shared/slWire.js');

const hex = (u8) => Buffer.from(u8).toString('hex');
const fromHex = (h) => Uint8Array.from(Buffer.from(h, 'hex'));

// First difference between two values (Object.is on numbers, same key sets), or null.
function diff(a, b, p) {
  p = p || '$';
  if (typeof a === 'number' && typeof b === 'number') return Object.is(a, b) ? null : p + ': ' + a + ' vs ' + b;
  if (a === b) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    if (Array.isArray(a) !== Array.isArray(b)) return p + ': array vs object';
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    if (ka.join() !== kb.join()) return p + ': keys [' + ka.join() + '] vs [' + kb.join() + ']';
    for (const k of ka) { const d = diff(a[k], b[k], p + '.' + k); if (d) return d; }
    return null;
  }
  return p + ': ' + JSON.stringify(a) + ' vs ' + JSON.stringify(b);
}
function same(a, b, msg) { const d = diff(a, b); assert.ok(d === null, (msg ? msg + ' ' : '') + d); }

// Full reference-decoder events (extra fields included on purpose: only 6.2 fields may be read).
const W4_IN = [{ cmd: 'a', type: 'init', raw: { spangdv: 48, nsp1: 425, nsp2: 50, nsp3: 1200, mamu: 33, mamu2: 28, cst: 430 },
  grd: 16384, mscps: 411, sectorSize: 480, sectorCount: 130, spangdv: 4.8, nsp1: 4.25, nsp2: 0.5, nsp3: 12, mamu: 0.033,
  mamu2: 0.028, cst: 0.43, pv: 15, defaultMsl: 42, realSid: 7, fluxGrd: 16000,
  derived: { fluxGrd: 16000, teamMode: false, ssd256: 1.875 } }];
const W5_IN = [{ cmd: 's', ignored: false, id: 1,
  raw: { ang: 4194304, dir: 49, wang: 8388608, sp: 5780, fam: 8388607, snx: 50215, sny: 50020,
    pts: [{ x: 49800, y: 50000 }, { bx: 137, by: 127 }, { bx: 137, by: 129 }, { bx: 137, by: 125 }, { bx: 137, by: 127 },
      { bx: 137, by: 131 }, { bx: 137, by: 127 }, { iang: 0 }] },
  type: 'snake_add', ang: 1.5707964204216591, dir: 1, wang: 3.1415928408433182, sp: 5.78, fam: 0.49999997019767584, cv: 3,
  snx: 10043, sny: 10004, nick: 'abc', skin: [], cosmetic: 255, angApplied: 0,
  pts: [{ xx: 9960, yy: 10000 }, { xx: 9965, yy: 10000 }, { xx: 9970, yy: 10001 }, { xx: 9975, yy: 10000 }, { xx: 9980, yy: 10000 },
    { xx: 9985, yy: 10002 }, { xx: 9990, yy: 10002 }, { xx: 10032, yy: 10002, iang: 0 }],
  sct: 8, isOwn: true }];
const W6_IN = [{ cmd: 'G', type: 'snake_move', grow: false, ignored: false, own: true, target: 1, raw: {}, form: 'repeat',
  iangUsed: 0, head: { xx: 10074, yy: 10002 } }];
const W7_IN = [{ cmd: 'G', type: 'snake_move', grow: false, ignored: false, own: true, target: 1, raw: {}, form: 'angle',
  iang: 10000, head: { xx: 10098.131240912004, yy: 10036.375619442373 } }];
const W8_IN = [{ cmd: 'G', type: 'snake_move', grow: false, ignored: false, own: false, id: 9, target: 9, raw: { bx: 200, by: 3 },
  form: 'rel', dx: 72, dy: -125, head: { xx: 16352.400000000001, yy: 9875.6 } }];
const W9_IN = [{ cmd: 'e', type: 'snake_rot', own: false, id: 7, target: 7, raw: { ang: 70, wang: 200, sp: 90 }, dir: 1,
  ang: 1.718058482431918, wang: 4.908738521234052, sp: 5 }];
const W10_IN = [{ cmd: 'd', type: 'snake_rot', own: true, target: 1, raw: { ang: 250, wang: 5, sp: 255 }, dir: 1,
  ang: 6.135923151542564, wang: 0.1227184630308513, sp: 14.166666666666666 }];
const W11_IN = [{ cmd: 'F', type: 'food_sector', foods: [
  { cv: 3, rx: 0, ry: 255, rad: 5, raw: { rad: 25 }, xx: 9600, yy: 10558.125, id: 336920831 },
  { cv: 12, rx: 128, ry: 64, rad: 10, raw: { rad: 50 }, xx: 9840, yy: 10200, id: 336953408 },
  { cv: 9, rx: 1, ry: 2, rad: 1, raw: { rad: 5 }, xx: 9601.875, yy: 10083.75, id: 336920834 }], sx: 20, sy: 21 }];
const W12_IN = [{ cmd: 'b', type: 'food_add', rapid: true, raw: { rad: 20 }, sx: 30, sy: 31, sectorFromLast: false, rx: 100,
  ry: 100, cv: 5, cvFromLast: false, rad: 4, xx: 14587.5, yy: 15067.5, id: 505373796 }];
const W13_IN = [{ cmd: 'f', type: 'food_add', rapid: false, raw: { rad: 15 }, sx: 30, sy: 31, sectorFromLast: true, rx: 101,
  ry: 102, cv: 5, cvFromLast: true, rad: 3, xx: 14589.375, yy: 15071.25, id: 505374054 }];
const W14_IN = [{ cmd: '<', type: 'food_eat', sx: 1, sy: 1, sectorFromLast: false, rx: 4, ry: 4, id: 16843780, eater: 1,
  eaterFromLast: false }];
const W15_IN = [{ cmd: 'l', type: 'leaderboard', ignored: false, myPos: 2, rank: 5, count: 321, rows: [
  { sct: 100, fam: 0.49999997019767584, cv: 3, nick: 'Bob 1', raw: { fam: 8388607, cv: 12 }, score: 2043 },
  { sct: 20, fam: 0, cv: 3, nick: 'abc', raw: { fam: 0, cv: 3 }, score: 296 },
  { sct: 10, fam: 1, cv: 0, nick: '12345678', raw: { fam: 16777215, cv: 9 }, score: 149 }] }];
const W16_IN = [{ cmd: 'M', type: 'minimap', raw: { size: 24 }, size: 24, pixels: [[23, 23], [17, 23], [1, 23], [0, 23]] }];
const W17_IN = [{ cmd: 'V', type: 'minimap', size: 24, toggles: [[23, 23], [22, 23]] }];
const W18_IN = [{ cmd: 'y', id: 40, type: 'prey_add', raw: { xx: 50100, yy: 50200, rad: 40, dir: 50, wang: 4194304, ang: 8388608, sp: 9100 },
  cv: 12, xx: 10020, yy: 10040, rad: 8, dir: 2, wang: 1.5707964204216591, ang: 3.1415928408433182, sp: 9.1 }];
const W19_IN = [{ cmd: 'j', type: 'prey_move', id: 40, raw: { x: 3400, y: 3500, dir: 50, ang: 100, wang: 200, sp: 1234 },
  xx: 10201, yy: 10501, dir: 2, ang: 0.00003745070506147526, wang: 0.00007490141012295051, sp: 1.234 }];

// Build brief 7.8 (COMPUTED by slwire-check.js --vectors).
const VECTORS = [
  { id: 'W1', pv: 15, events: [], hex: '01' },
  { id: 'W2', pv: 15, events: [{ type: 'pong' }], hex: '010d' },
  { id: 'W3', pv: 15, events: [{ type: 'server_version', text: 'abc' }], hex: '010000' },
  { id: 'W4', pv: 2, events: W4_IN, hex: '01018080019b03e003820105c025059a210409000c0521051c05ae03040f2a07807d' },
  { id: 'W5', pv: 15, events: W5_IN, hex: '010f010380808002038080800405942d06ffffff030300bb4e00944e036162630700888503d0860306897f8981897d897f8983897f00' },
  { id: 'W6', pv: 15, events: W6_IN, hex: '01060101' },
  { id: 'W7', pv: 15, events: W7_IN, hex: '01060103904e' },
  { id: 'W8', pv: 14, events: W8_IN, hex: '0106010809c803' },
  { id: 'W9', pv: 15, events: W9_IN, hex: '01021e0702014601c8010005' },
  { id: 'W10', pv: 15, events: W10_IN, hex: '01021f0201fa01010504ff01' },
  { id: 'W11', pv: 15, events: W11_IN, hex: '0111001415030300ff0100050c800140000a0901020001' },
  { id: 'W12', pv: 15, events: W12_IN, hex: '011200011e1f6464050004' },
  { id: 'W13', pv: 15, events: W13_IN, hex: '0112000665660003' },
  { id: 'W14', pv: 15, events: W14_IN, hex: '01130200000101040401' },
  { id: 'W15', pv: 15, events: W15_IN, hex: '01070205c102036406ffffff030c05426f62203114000003036162630a000109083132333435363738' },
  { id: 'W16', pv: 15, events: W16_IN, hex: '010e01180400050f00' },
  { id: 'W17', pv: 15, events: W17_IN, hex: '010e0218020000' },
  { id: 'W18', pv: 15, events: W18_IN, hex: '0117280c00a44e00b84e00080403808080020380808004058c47' },
  { id: 'W19', pv: 15, events: W19_IN, hex: '01142800d94f0085520f04036403c80105d209' },
  { id: 'W20', pv: 15, events: [{ type: 'snake_fam', id: 1, fam: -0 }], hex: '0103010f0000000000000080' }
];

test('VERSION is 1 and the exports are the section 11 names', () => {
  assert.strictEqual(W.VERSION, 1);
  assert.deepStrictEqual(Object.keys(W).sort(),
    ['VERSION', 'decodeBundle', 'decodeInput', 'encodeBundle', 'encodeInput', 'projectEvent', 'projectFrame']);
});

for (const v of VECTORS) {
  test(v.id + ': bytes, decode equals the projection, re-encode stable', () => {
    const bytes = W.encodeBundle(v.events, v.pv);
    assert.ok(bytes instanceof Uint8Array);
    assert.strictEqual(hex(bytes), v.hex);
    assert.strictEqual(bytes.length, v.hex.length / 2);
    const back = W.decodeBundle(bytes);
    same(back, W.projectFrame(v.events, v.pv), v.id);
    assert.strictEqual(hex(W.encodeBundle(back, v.pv)), v.hex);
    assert.strictEqual(hex(W.encodeBundle(v.events, v.pv)), v.hex, 'two encodes give the same bytes');
  });
}

test('projection shapes are pinned (6.2 fields only, named as the reference decoder names them)', () => {
  same(W.decodeBundle(fromHex('01060101')), [{ type: 'snake_move', cmd: 'G', own: true }]);
  same(W.decodeBundle(fromHex('01060103904e')), [{ type: 'snake_move', cmd: 'G', own: true, iang: 10000 }]);
  same(W.decodeBundle(fromHex('0106010809c803')), [{ type: 'snake_move', cmd: 'G', own: false, id: 9, raw: { bx: 200, by: 3 } }]);
  same(W.projectFrame(W9_IN, 15), [{ type: 'snake_rot', own: false, id: 7, dir: 1, ang: 1.718058482431918,
    wang: 4.908738521234052, sp: 5 }]);
  same(W.projectFrame(W10_IN, 15), [{ type: 'snake_rot', own: true, dir: 1, ang: 6.135923151542564,
    wang: 0.1227184630308513, sp: 14.166666666666666 }]);
  same(W.projectFrame(W12_IN, 15), [{ type: 'food_add', rapid: true, sectorFromLast: false, sx: 30, sy: 31, rx: 100, ry: 100,
    cvFromLast: false, cv: 5, rad: 4 }]);
  same(W.projectFrame(W13_IN, 15), [{ type: 'food_add', rapid: false, sectorFromLast: true, rx: 101, ry: 102,
    cvFromLast: true, rad: 3 }]);
  same(W.projectFrame(W14_IN, 15), [{ type: 'food_eat', cmd: '<', sectorFromLast: false, sx: 1, sy: 1, rx: 4, ry: 4, eater: 1 }]);
  same(W.projectFrame(W11_IN, 15), [{ type: 'food_sector', sx: 20, sy: 21, foods: [
    { cv: 3, rx: 0, ry: 255, rad: 5 }, { cv: 12, rx: 128, ry: 64, rad: 10 }, { cv: 9, rx: 1, ry: 2, rad: 1 }] }]);
  same(W.projectFrame(W15_IN, 15), [{ type: 'leaderboard', myPos: 2, rank: 5, count: 321, rows: [
    { sct: 100, fam: 0.49999997019767584, nick: 'Bob 1', raw: { cv: 12 } },
    { sct: 20, fam: 0, nick: 'abc', raw: { cv: 3 } },
    { sct: 10, fam: 1, nick: '12345678', raw: { cv: 9 } }] }]);
  same(W.projectFrame(W16_IN, 15), [{ type: 'minimap', cmd: 'M', raw: { size: 24 }, size: 24,
    pixels: [[23, 23], [17, 23], [1, 23], [0, 23]] }]);
  same(W.projectFrame(W17_IN, 15), [{ type: 'minimap', cmd: 'V', size: 24, toggles: [[23, 23], [22, 23]] }]);
  same(W.projectFrame(W18_IN, 15), [{ type: 'prey_add', id: 40, cv: 12, xx: 10020, yy: 10040, rad: 8, dir: 2,
    wang: 1.5707964204216591, ang: 3.1415928408433182, sp: 9.1 }]);
  same(W.projectFrame(W19_IN, 15), [{ type: 'prey_move', id: 40, xx: 10201, yy: 10501, dir: 2,
    ang: 0.00003745070506147526, wang: 0.00007490141012295051, sp: 1.234 }]);
  same(W.projectFrame([{ type: 'server_version', text: 'abc', valid: true, decodedJs: 'x', cmd: '6' }], 15), [{ type: 'server_version' }]);
});

test('W5 snake_add: own spawn keeps raw wire points; decode.js extras (dir, pts, sct, cosmetic) are dropped', () => {
  const [ev] = W.decodeBundle(W.encodeBundle(W5_IN, 15));
  same(ev, { type: 'snake_add', id: 1, ang: 1.5707964204216591, wang: 3.1415928408433182, sp: 5.78, fam: 0.49999997019767584,
    cv: 3, snx: 10043, sny: 10004, nick: 'abc', skin: [],
    raw: { pts: [{ x: 49800, y: 50000 }, { bx: 137, by: 127 }, { bx: 137, by: 129 }, { bx: 137, by: 125 }, { bx: 137, by: 127 },
      { bx: 137, by: 131 }, { bx: 137, by: 127 }, { iang: 0 }] } });
  assert.ok(!('dir' in ev) && !('pts' in ev) && !('sct' in ev) && !('cosmetic' in ev) && !('angApplied' in ev));
  // no skin field (pv < 11), no points, and a body without the iang point
  const bare = Object.assign({}, W5_IN[0], { skin: undefined, raw: { pts: [] } });
  same(W.decodeBundle(W.encodeBundle([bare], 10))[0].raw, { pts: [] });
  assert.ok(!('skin' in W.decodeBundle(W.encodeBundle([bare], 10))[0]));
  const noIang = Object.assign({}, W5_IN[0], { raw: { pts: [{ x: 1, y: 2 }, { bx: 3, by: 4 }] } });
  same(W.decodeBundle(W.encodeBundle([noIang], 14))[0].raw, { pts: [{ x: 1, y: 2 }, { bx: 3, by: 4 }] });
  assert.throws(() => W.encodeBundle([Object.assign({}, W5_IN[0], { raw: { pts: [{ x: 1, y: 2 }, { iang: 3 }, { bx: 1, by: 1 }] } })], 15));
  assert.throws(() => W.encodeBundle([Object.assign({}, W5_IN[0], { raw: { pts: [{ bx: 1, by: 2 }] } })], 15));
  assert.throws(() => W.encodeBundle([Object.assign({}, W5_IN[0], { skin: [256] })], 15));
});

test('input vectors W21-W23 and their decode', () => {
  const cases = [
    ['W21', [{ type: 'ping' }], '0104'],
    ['W22', [{ type: 'turn', dir: 'left', v: 5 }, { type: 'ping' }, { type: 'boost', on: true }, { type: 'angle', q: 125 }], '010205040301017d'],
    ['W23', [{ type: 'turn', dir: 'right', v: 127 }, { type: 'boost', on: false }], '0102ff0300']
  ];
  for (const [id, list, h] of cases) {
    const b = W.encodeInput(list);
    assert.strictEqual(hex(b), h, id);
    same(W.decodeInput(b), list, id);
  }
  // the turn byte is the one their client puts after 252 (game.js:4514-4536): right adds 128
  assert.strictEqual(hex(W.encodeInput([{ type: 'turn', dir: 'right', v: 5 }])), '010285');
  assert.strictEqual(hex(W.encodeInput([{ type: 'angle', q: 250 }, { type: 'angle', q: 0 }])), '0101fa0100');
  for (const bad of [{ type: 'angle', q: 251 }, { type: 'angle', q: 1.5 }, { type: 'turn', dir: 'up', v: 1 },
    { type: 'turn', dir: 'left', v: 128 }, { type: 'boost', on: 1 }, { type: 'victory_message', msg: 'x' }, null]) {
    assert.throws(() => W.encodeInput([bad]), undefined, JSON.stringify(bad));
  }
  same(W.decodeInput(new Uint8Array(0)), [{ type: 'wire_error', reason: 'version', offset: 0 }]);
  same(W.decodeInput(fromHex('010401fb')), [{ type: 'ping' }, { type: 'wire_error', reason: 'value', offset: 2 }]);
  same(W.decodeInput(fromHex('0104fb')), [{ type: 'ping' }, { type: 'wire_error', reason: 'type', offset: 2 }]);
  same(W.decodeInput(fromHex('010302')), [{ type: 'wire_error', reason: 'value', offset: 1 }]);
  same(W.decodeInput(fromHex('0109')), [{ type: 'wire_error', reason: 'type', offset: 1 }]);
  same(W.decodeInput(fromHex('0101')), [{ type: 'wire_error', reason: 'short', offset: 1 }]);
});

test('7.5 robustness: every proper prefix of W5 ends with exactly one wire_error; 01 is []; empty is a version error', () => {
  const w5 = fromHex(VECTORS[4].hex);
  for (let n = 2; n < w5.length; n++) {
    let out;
    assert.doesNotThrow(() => { out = W.decodeBundle(w5.subarray(0, n)); });
    assert.strictEqual(out.length, 1, 'prefix ' + n);
    assert.strictEqual(out[0].type, 'wire_error', 'prefix ' + n);
    assert.strictEqual(out[0].offset, 1, 'prefix ' + n);
    assert.strictEqual(typeof out[0].reason, 'string');
  }
  same(W.decodeBundle(fromHex('01')), []);
  same(W.decodeBundle(new Uint8Array(0)), [{ type: 'wire_error', reason: 'version', offset: 0 }]);
  same(W.decodeBundle(fromHex('020d')), [{ type: 'wire_error', reason: 'version', offset: 0 }]);
  same(W.decodeBundle(null), [{ type: 'wire_error', reason: 'input', offset: 0 }]);
  same(W.decodeBundle('010d'), [{ type: 'wire_error', reason: 'input', offset: 0 }]);
  // the events before the bad record are kept
  same(W.decodeBundle(fromHex('010d0d63')), [{ type: 'pong' }, { type: 'pong' }, { type: 'wire_error', reason: 'type', offset: 3 }]);
  // ArrayBuffer, Buffer and an offset view all decode the same
  const b = W.encodeBundle(W15_IN, 15);
  same(W.decodeBundle(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)), W.projectFrame(W15_IN, 15));
  same(W.decodeBundle(Buffer.from(b)), W.projectFrame(W15_IN, 15));
  const padded = new Uint8Array(b.length + 7); padded.set(b, 7);
  same(W.decodeBundle(padded.subarray(7)), W.projectFrame(W15_IN, 15));
});

test('hostile counts stop before any loop (no allocation beyond the buffer)', () => {
  // leaderboard claiming 2^32 - 1 rows
  same(W.decodeBundle(fromHex('0107000000ffffffff0f')), [{ type: 'wire_error', reason: 'count', offset: 1 }]);
  // nick length beyond the bytes left
  same(W.decodeBundle(fromHex('010c0000057f61')), [{ type: 'wire_error', reason: 'count', offset: 1 }]);
  // minimap M with 300 cells and 2 bytes left
  same(W.decodeBundle(fromHex('010e0118ac020000')), [{ type: 'wire_error', reason: 'count', offset: 1 }]);
  // L with a huge team count
  same(W.decodeBundle(fromHex('010e0418ffffffff0f')), [{ type: 'wire_error', reason: 'count', offset: 1 }]);
  // snake_add with 100 deltas and 4 bytes left
  const head = '010f01' + '0000' + '0000' + '0000' + '0000' + '00' + '0000' + '0000' + '00';
  same(W.decodeBundle(fromHex(head + '02' + '0102' + '64' + '01020304')), [{ type: 'wire_error', reason: 'count', offset: 1 }]);
  // uv longer than 32 bits
  same(W.decodeBundle(fromHex('0108ffffffff10')), [{ type: 'wire_error', reason: 'value', offset: 1 }]);
  same(W.decodeBundle(fromHex('0108ffffffff0f')), [{ type: 'dead', code: 4294967295 }]);
  // cell index beyond the grid (24 x 24 = 576 cells)
  same(W.decodeBundle(fromHex('010e011801c004')), [{ type: 'wire_error', reason: 'value', offset: 1 }]);
  same(W.decodeBundle(fromHex('010e011801bf04')), [{ type: 'minimap', cmd: 'M', raw: { size: 24 }, size: 24, pixels: [[0, 0]] }]);
});

test('number kinds: the 7.3 search order, the f64 fallback, Object.is round trip', () => {
  const kindOf = (v) => {
    const b = W.encodeBundle([{ type: 'snake_fam', id: 1, fam: v }], 15);
    const back = W.decodeBundle(b)[0].fam;
    assert.ok(Object.is(back, v), 'round trip ' + v + ' got ' + back);
    return b[3];
  };
  assert.strictEqual(kindOf(0), 0);
  assert.strictEqual(kindOf(12), 0);
  assert.strictEqual(kindOf(Math.PI), 1);                               // 128 * 2 * pi / 256 is exactly Math.PI
  assert.strictEqual(kindOf(4294967295), 0);
  assert.strictEqual(kindOf(70 * 2 * Math.PI / 256), 1);                // game.js:7401
  assert.strictEqual(kindOf(40000 * 2 * Math.PI / 65535), 2);           // game.js:7540
  assert.strictEqual(kindOf(4194304 * 2 * Math.PI / 16777215), 3);      // game.js:8423
  assert.strictEqual(kindOf(255 / 18), 4);                              // game.js:7405
  assert.strictEqual(kindOf(0.5), 4);                                   // 9 / 18 comes before 500 / 1E3
  assert.strictEqual(kindOf(4.8), 5);                                   // 4800 / 1E3 comes before 48 / 10
  assert.strictEqual(kindOf(8388607 / 16777215), 6);                    // game.js:7605
  assert.strictEqual(kindOf(50215 / 5), 0);                             // an integer: kind 0 wins
  assert.strictEqual(kindOf(50216 / 5), 5);                             // 10043200 / 1E3 is the same double
  assert.strictEqual(kindOf(30000001 / 5), 7);                          // game.js:8437; d1000 would need a raw above 2^32
  assert.strictEqual(kindOf(50000001 / 10), 9);                         // game.js:7292
  assert.strictEqual(kindOf(500000001 / 100), 10);                      // game.js:7294
  assert.strictEqual(kindOf(1 + 3400 * 3), 0);                          // an integer: kind 0 wins
  assert.strictEqual(kindOf(4294967296), 8);                            // game.js:8798: 1 + 1431655765 * 3, too big for kind 0
  for (const v of [-0, -1, -5.5, 0.1 + 0.2, Math.E, 1e300, 5e-324, 4294967298]) {
    assert.strictEqual(kindOf(v), 15, String(v));
  }
  // NaN and Infinity still encode as kind 15, but the decoder refuses them (review pass): the record and the
  // rest of the bundle become one wire_error.
  for (const v of [NaN, Infinity, -Infinity]) {
    const b = W.encodeBundle([{ type: 'snake_fam', id: 1, fam: v }, { type: 'pong' }], 15);
    assert.strictEqual(b[3], 15, String(v));
    same(W.decodeBundle(b), [{ type: 'wire_error', reason: 'value', offset: 1 }]);
  }
  // kind 8 (prey) and the d10 / d100 kinds through prey_move, init
  const pm = W.decodeBundle(W.encodeBundle([{ type: 'prey_move', id: 1, xx: 1 + 3401 * 3 + 0.5, yy: 2.5 }], 15))[0];
  assert.ok(Object.is(pm.xx, 1 + 3401 * 3 + 0.5) && Object.is(pm.yy, 2.5));
  const init = { type: 'init', grd: 1, mscps: 2, sectorSize: 3, sectorCount: 4, spangdv: 4.9, nsp1: 4.27, nsp2: 0.51,
    nsp3: 12.34, mamu: 0.033, mamu2: 0.028, cst: 0.43 };
  same(W.decodeBundle(W.encodeBundle([init], 2)), W.projectFrame([init], 2));
  assert.strictEqual(W.decodeBundle(W.encodeBundle([init], 2))[0].nsp3, 12.34);
  // a number field must be a number
  assert.throws(() => W.encodeBundle([{ type: 'snake_fam', id: 1, fam: '0.5' }], 15));
  assert.throws(() => W.encodeBundle([{ type: 'snake_fam', id: 1 }], 15));
});

test('ints, signed dir, strings: what can be carried and what throws', () => {
  for (const v of [0, 1, 127, 128, 16383, 16384, 2097151, 2097152, 268435455, 268435456, 4294967295]) {
    same(W.decodeBundle(W.encodeBundle([{ type: 'flux', fluxGrd: v }], 15)), [{ type: 'flux', fluxGrd: v }]);
  }
  assert.strictEqual(hex(W.encodeBundle([{ type: 'flux', fluxGrd: 4294967295 }], 15)), '0119ffffffff0f');
  for (const v of [-1, 1.5, -0, 4294967296, NaN, '1', null, true]) {
    assert.throws(() => W.encodeBundle([{ type: 'flux', fluxGrd: v }], 15), undefined, String(v));
  }
  // dir is `u8 - 48` at pv < 3 (game.js:7553), so -48..207, zigzag coded
  for (const d of [-48, -1, 0, 1, 2, 207]) {
    const ev = { type: 'snake_rot', own: false, id: 3, dir: d };
    same(W.decodeBundle(W.encodeBundle([ev], 2)), [ev]);
  }
  assert.strictEqual(hex(W.encodeBundle([{ type: 'snake_rot', own: false, id: 3, dir: -1 }], 2)), '0102020301');
  assert.throws(() => W.encodeBundle([{ type: 'snake_rot', own: false, id: 3, dir: -0 }], 2));
  assert.throws(() => W.encodeBundle([{ type: 'snake_rot', own: 1, id: 3 }], 2));
  // strings are one char per wire byte (0..255)
  const all = Array.from({ length: 256 }, (_, i) => String.fromCharCode(i)).join('');
  const lm = { type: 'longest_msg', sct: 16777215, fam: 1, nick: all, msg: '' };
  same(W.decodeBundle(W.encodeBundle([lm], 15)), [lm]);
  assert.throws(() => W.encodeBundle([{ type: 'longest_msg', sct: 1, fam: 1, nick: 'Ā', msg: '' }], 15));
  assert.throws(() => W.encodeBundle([{ type: 'longest_msg', sct: 1, fam: 1, nick: 5, msg: '' }], 15));
});

test('every event type round trips, including the pv < 14 food forms and the L and u minimaps', () => {
  const list = [
    [2, { type: 'snake_tail', id: 5 }],
    [15, { type: 'snake_tail', id: 5, fam: 0.25 }],
    [15, { type: 'own_rsc', rsc: 7 }],
    [15, { type: 'dead', code: 2 }],
    [15, { type: 'sector_add', sx: 3, sy: 4 }],
    [15, { type: 'sector_remove', sx: 255, sy: 0 }],
    [7, { type: 'sector_w', mode: 1, sx: 65535, sy: 2 }],
    [15, { type: 'snake_remove', id: 9, kill: true }],
    [15, { type: 'snake_remove', id: 9, kill: false }],
    [15, { type: 'prey_remove', id: 40 }],
    [15, { type: 'prey_eaten', id: 40, eater: 3 }],
    [15, { type: 'kill_count', id: 3, count: 16777215 }],
    [15, { type: 'snake_move', cmd: '+', own: true, iang: 65535, xx: 65535, yy: 0, fam: 0.75 }],
    [15, { type: 'snake_move', cmd: '=', own: false, id: 2, iang: 1, xx: 2, yy: 3 }],
    [14, { type: 'snake_move', cmd: 'n', own: false, id: 2, xx: 2, yy: 3, fam: 1 }],
    [14, { type: 'snake_move', cmd: 'N', own: true, raw: { bx: 0, by: 255 }, fam: 0 }],
    [2, { type: 'snake_move', cmd: 'g', own: false, id: 2, xx: 3333333 / 5, yy: 0.2 }],
    [13, { type: 'food_sector', foods: [{ cv: 1, xx: 65535, yy: 2, rad: 0.2 }, { cv: 2, xx: 3, yy: 4, rad: 51 }] }],
    [3, { type: 'food_sector', sx: 65535, sy: 1, foods: [{ id: 16777215, cv: 1, rx: 2, ry: 3, rad: 4.4 }] }],
    [4, { type: 'food_add', rapid: false, cv: 3, noop: true }],
    [4, { type: 'food_add', rapid: true, cv: 3, xx: 1, yy: 2, rad: 3.2 }],
    [2, { type: 'food_add', rapid: true, id: 77, noop: true }],
    [2, { type: 'food_add', rapid: false, id: 77, cv: 1, sx: 2, sy: 3, rx: 4, ry: 5, rad: 1.4 }],
    [15, { type: 'food_eat', cmd: 'c', sectorFromLast: true, rx: 1, ry: 2 }],
    [15, { type: 'food_eat', cmd: 'C', sectorFromLast: false, sx: 3, sy: 4, rx: 1, ry: 2 }],
    [13, { type: 'food_eat', cmd: 'c', xx: 1, yy: 2, eater: 3 }],
    [3, { type: 'food_eat', cmd: 'c', id: 16777215, eater: 65535 }],
    [15, { type: 'minimap', cmd: 'U', raw: { size: 600 }, size: 512, pixels: [[511, 511], [0, 511], [511, 0], [0, 0]] }],
    [15, { type: 'minimap', cmd: 'U', raw: { size: 0 }, size: 0, pixels: [] }],
    [15, { type: 'minimap', cmd: 'u', size: 80, pixels: [[0, 0], [79, 0], [0, 1], [79, 79]] }],
    [15, { type: 'minimap', cmd: 'L', teamCount: 2, raw: { size: 24 }, size: 24, teams: [[[23, 23], [0, 0]], []] }],
    [15, { type: 'minimap', cmd: 'L', teamCount: 0, raw: { size: 30 }, size: 30, teams: [] }],
    [15, { type: 'prey_move', id: 1, xx: 4, yy: 7 }],
    [15, { type: 'prey_add', id: 1, cv: 255, xx: 0, yy: 0.2, rad: 51, dir: -48, wang: 0, ang: -0, sp: 65.535 }]
  ];
  for (const [pv, ev] of list) {
    const b = W.encodeBundle([ev], pv);
    same(W.decodeBundle(b), [ev], JSON.stringify(ev));
    same(W.projectEvent(ev, pv), ev, 'projection of ' + JSON.stringify(ev));
    assert.strictEqual(hex(W.encodeBundle(W.decodeBundle(b), pv)), hex(b));
  }
  for (const t of ['server_version', 'admin_info', 'team_scores', 'session_id', 'debug_point', 'unknown', 'malformed', 'empty']) {
    same(W.decodeBundle(W.encodeBundle([{ type: t, cmd: 'q', hex: 'ff' }], 15)), [{ type: t }]);
  }
});

test('food form follows the pv the client holds, and an init carrying pv switches it mid-bundle', () => {
  const fe = { type: 'food_eat', cmd: 'c', sectorFromLast: false, sx: 1, sy: 2, rx: 3, ry: 4, xx: 5, yy: 6, id: 7, eater: 8 };
  const formAt = (pv) => W.encodeBundle([fe], pv)[3];
  assert.deepStrictEqual([15, 14, 13, 4, 3, 2].map(formAt), [0, 0, 1, 1, 2, 2]);   // game.js:8736, 8758
  same(W.projectEvent(fe, 14), { type: 'food_eat', cmd: 'c', sectorFromLast: false, sx: 1, sy: 2, rx: 3, ry: 4 });
  same(W.projectEvent(fe, 8), { type: 'food_eat', cmd: 'c', xx: 5, yy: 6, eater: 8 });
  same(W.projectEvent(fe, 2), { type: 'food_eat', cmd: 'c', id: 7, eater: 8 });
  // W4's init carries pv 15, so the food event after it uses form 0 although the bundle started at pv 2
  const frame = [W4_IN[0], fe];
  const out = W.decodeBundle(W.encodeBundle(frame, 2));
  same(out, W.projectFrame(frame, 2));
  same(out[1], { type: 'food_eat', cmd: 'c', sectorFromLast: false, sx: 1, sy: 2, rx: 3, ry: 4 });
  // an init without pv keeps the current pv
  const noPv = Object.assign({}, W4_IN[0]);
  for (const k of ['pv', 'defaultMsl', 'realSid', 'fluxGrd']) delete noPv[k];
  same(W.decodeBundle(W.encodeBundle([noPv, fe], 2))[1], { type: 'food_eat', cmd: 'c', id: 7, eater: 8 });
  assert.throws(() => W.encodeBundle([fe], undefined));
  assert.throws(() => W.projectEvent(fe, '15'));
});

test('encode throws on values it cannot carry', () => {
  const bad = [
    { type: 'init', grd: 1, mscps: 2, sectorSize: 3, sectorCount: 4, spangdv: 1, nsp1: 1, nsp2: 1, nsp3: 1, mamu: 1, mamu2: 1,
      cst: 1, defaultMsl: 42 },                                                    // optional fields not a prefix
    { type: 'minimap', cmd: 'M', raw: { size: 24 }, size: 24, pixels: [[0, 23], [1, 23]] },   // out of scan order
    { type: 'minimap', cmd: 'M', raw: { size: 24 }, size: 24, pixels: [[1, 23], [1, 23]] },   // repeated cell
    { type: 'minimap', cmd: 'M', raw: { size: 24 }, size: 24, pixels: [[24, 0]] },            // outside the grid
    { type: 'minimap', cmd: 'M', raw: { size: 24 }, size: 24, pixels: [[1.5, 0]] },
    { type: 'minimap', cmd: 'M', raw: { size: 600 }, size: 600, pixels: [] },                 // size must be min(512, raw)
    { type: 'minimap', cmd: 'u', size: 24, pixels: [] },                                      // u is 80
    { type: 'minimap', cmd: 'u', size: 80, pixels: [[1, 0], [0, 0]] },                        // forward order
    { type: 'minimap', cmd: 'L', teamCount: 2, raw: { size: 24 }, size: 24, teams: [[]] },
    { type: 'minimap', cmd: 'V', size: -1, toggles: [] },
    { type: 'minimap', cmd: 'X', size: 24, pixels: [] },
    { type: 'snake_move', cmd: 'x', own: true },
    { type: 'snake_move', cmd: 'n', own: true },                                              // grow needs fam
    { type: 'snake_move', cmd: 'G', own: true, raw: { bx: 256, by: 0 } },
    { type: 'snake_rot', own: false },                                                        // id needed when not own
    { type: 'snake_remove', id: 1, kill: 1 },
    { type: 'food_add', rapid: 'yes', sectorFromLast: false, cvFromLast: false, sx: 1, sy: 1, rx: 1, ry: 1, cv: 1, rad: 1 },
    { type: 'leaderboard', myPos: 1, rank: 1, count: 1, rows: [{ sct: 1, fam: 1, nick: 'a' }] },  // row needs raw.cv
    { type: 'leaderboard', myPos: 1, rank: 1, count: 1, rows: [{ sct: 1, fam: 1, nick: 'a', raw: { cv: 256 } }] },
    { type: 'wire_error', reason: 'x', offset: 0 },
    { type: 'nope' }
  ];
  for (const ev of bad) assert.throws(() => W.encodeBundle([ev], 15), RangeError, JSON.stringify(ev));
  assert.throws(() => W.encodeBundle('x', 15));
  assert.throws(() => W.encodeBundle([null], 15));
});

test('fuzz: mutated and cut bundles never throw; at most one wire_error, always last', () => {
  let s = 20261010 >>> 0;
  const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const seeds = VECTORS.filter((v) => v.events.length).map((v) => fromHex(v.hex));
  const all = new Uint8Array(seeds.reduce((n, b) => n + b.length - 1, 1));
  all[0] = 1; let at = 1;
  for (const b of seeds) { all.set(b.subarray(1), at); at += b.length - 1; }
  same(W.decodeBundle(all), [].concat(...VECTORS.map((v) => W.projectFrame(v.events, v.pv))), 'concatenated W vectors');
  for (let n = 0; n < 5000; n++) {
    const m = Uint8Array.from(all);
    const k = 1 + Math.floor(rnd() * 4);
    for (let i = 0; i < k; i++) m[1 + Math.floor(rnd() * (m.length - 1))] = Math.floor(rnd() * 256);
    const cut = rnd() < 0.3 ? m.subarray(0, Math.floor(rnd() * (m.length + 1))) : m;
    let out;
    assert.doesNotThrow(() => { out = W.decodeBundle(cut); });
    assert.ok(out.length <= Math.max(1, cut.length));
    const errs = out.filter((e) => e.type === 'wire_error');
    assert.ok(errs.length <= 1);
    if (errs.length) assert.strictEqual(out[out.length - 1].type, 'wire_error');
    if (!errs.length) assert.strictEqual(hex(W.encodeBundle(out, 15).subarray(0, 1)), '01');
    let inp;
    assert.doesNotThrow(() => { inp = W.decodeInput(cut); });
    assert.ok(inp.length <= Math.max(1, cut.length));
  }
});

test('browser load: lands on DuelSlither.slWire and defines no other global', () => {
  const src = fs.readFileSync(WIRE_FILE, 'utf8');
  const ctx = vm.createContext({});
  ctx.window = ctx;
  vm.runInContext(src, ctx);
  assert.deepStrictEqual(Object.keys(ctx).sort(), ['DuelSlither', 'window']);
  assert.strictEqual(typeof ctx.DuelSlither.slWire.encodeBundle, 'function');
  assert.strictEqual(ctx.DuelSlither.slWire.VERSION, 1);
  const b = ctx.DuelSlither.slWire.encodeBundle(W5_IN, 15);
  assert.strictEqual(Buffer.from(b).toString('hex'), VECTORS[4].hex);
  // an existing namespace is kept
  const ctx2 = vm.createContext({});
  ctx2.window = ctx2;
  ctx2.DuelSlither = { S: { a: 1 } };
  vm.runInContext(src, ctx2);
  assert.strictEqual(ctx2.DuelSlither.S.a, 1);
  assert.strictEqual(typeof ctx2.DuelSlither.slWire.decodeBundle, 'function');
});

test('clean room: no Math.random, no reference-side imports', () => {
  const src = fs.readFileSync(WIRE_FILE, 'utf8');
  assert.ok(!/Math\.random/.test(src));
  assert.ok(!/slither-reference/.test(src));
  assert.ok(!/require\s*\(/.test(src));
  assert.ok(!src.includes(String.fromCharCode(0x2014)), "no em dashes");
});
