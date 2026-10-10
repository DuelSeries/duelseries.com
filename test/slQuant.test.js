'use strict';
// slither.io free room, task T2: server/sl/slQuant.js (SERVER-DESIGN 7, 18.1; SERVER-BUILD-BRIEF section 8).
// Every quantizer returns { raw, v } with v equal to THEIR client's own expression of raw. The client expressions
// below are literals copied from the cited game.js lines; the law vectors are literals copied from
// spec/SERVER-LAWS.md by law id. Nothing is read from slither-reference at test time.
const test = require('node:test');
const assert = require('node:assert');

const Q = require('../server/sl/slQuant.js');
const { numKind } = require('../server/sl/slRecordCache.js');
const { createRng } = require('../server/ag/agRng.js');

// The client's expressions of a wire integer, in its operator order.
const PI2C = 2 * Math.PI;                                   // game.js:125
const K64A_C = PI2C / 65536;                                // game.js:127
const C = {
  ang8: (r) => r * 2 * Math.PI / 256,                       // game.js:7401
  sp18: (r) => r / 18,                                      // game.js:7405
  ang24: (r) => r * 2 * Math.PI / 16777215,                 // game.js:7558, 8423
  sp1000: (r) => r / 1E3,                                   // game.js:7566, 8430
  fam24: (r) => r / 16777215,                               // game.js:7605
  pos5: (r) => r / 5,                                       // game.js:8437
  abs: (r) => r,                                            // game.js:7713-7720
  prey: (r) => 1 + r * 3,                                   // game.js:8798
  rad5: (r) => r / 5,                                       // game.js:8610, 8893
  iang: (r) => r * K64A_C                                   // game.js:7728
};

const N = 100000;
const KIND_EVERY = 10;   // the slWire kind probe runs on every 10th value (10,000 per quantizer)

// Round-trip and expression check on N seeded raws. `u` is where inside the raw's cell the input sits: [-0.4, 0.4]
// for a nearest rule, [0.1, 0.9] for floor and trunc rules. `toInput(x)` maps a real raw position to the input.
// `grid` names the slQuant grid the value must sit on, or null for a value that never goes on the wire as a number.
function sweep(name, quant, expr, maxRaw, nearest, toInput, seed, grid) {
  const rng = createRng(seed);
  let kinds = 0;
  for (let i = 0; i < N; i++) {
    const r = 1 + rng.int(maxRaw - 1);                      // 1 .. maxRaw - 1 (edges are tested on their own)
    const u = nearest ? rng.range(-0.4, 0.4) : rng.range(0.1, 0.9);
    const q = quant(toInput(r + u));
    if (q.raw !== r) assert.fail(name + ': raw ' + q.raw + ' for ' + r + ' + ' + u);
    if (!Object.is(q.v, expr(q.raw))) assert.fail(name + ': v ' + q.v + ' is not the client value of ' + q.raw);
    if (grid !== null && i % KIND_EVERY === 0) {
      if (numKind(q.v) === 15) assert.fail(name + ': v ' + q.v + ' needs kind 15');
      if (!Q.onGrid(grid, q.v)) assert.fail(name + ': v ' + q.v + ' is off the ' + grid + ' grid');
      const half = expr(q.raw) + (expr(q.raw + 1) - expr(q.raw)) / 2;
      if (Q.onGrid(grid, half)) assert.fail(name + ': a half step ' + half + ' is on the ' + grid + ' grid');
      kinds++;
    }
  }
  assert.strictEqual(kinds, grid === null ? 0 : N / KIND_EVERY);
}

test('slQuant: v is the client expression of raw on 100,000 seeded raws per quantizer, on its grid, never kind 15', () => {
  sweep('rotAng round', (a) => Q.rotAng(a, 'round'), C.ang8, 255, true, (x) => x * 2 * Math.PI / 256, 1, 'ang8');
  sweep('rotAng floor', (a) => Q.rotAng(a, 'floor'), C.ang8, 255, false, (x) => x * 2 * Math.PI / 256, 2, 'ang8');
  sweep('rotSp', Q.rotSp, C.sp18, 255, false, (x) => x / 18, 3, 'sp18');
  sweep('ang24', Q.ang24, C.ang24, 16777215, true, (x) => x * 2 * Math.PI / 16777215, 4, 'ang24');
  sweep('sp1000', Q.sp1000, C.sp1000, 65535, false, (x) => x / 1000, 5, 'sp1000');
  sweep('fam24 round', (f) => Q.fam24(f, 'round'), C.fam24, 16777215, true, (x) => x / 16777215, 6, 'fam24');
  sweep('fam24 floor', (f) => Q.fam24(f, 'floor'), C.fam24, 16777215, false, (x) => x / 16777215, 7, 'fam24');
  sweep('pos5', Q.pos5, C.pos5, 16777215, true, (x) => x / 5, 8, 'pos5');
  sweep('absXY', Q.absXY, C.abs, 65535, true, (x) => x, 9, 'u16');
  sweep('preyPos', Q.preyPos, C.prey, 65535, true, (x) => 1 + x * 3, 10, 'prey3');
  sweep('rad5', Q.rad5, C.rad5, 255, true, (x) => x / 5, 11, 'rad5');
  // iang goes on the wire as the integer itself; v is the angle the client steps along, never a wire number.
  sweep('moveIang', Q.moveIang, C.iang, 65535, true, (x) => x * 2 * Math.PI / 65536, 12, null);
});

test('slQuant: onGrid edges (-0, NaN, beyond max, unknown grid)', () => {
  for (const g of Object.keys(Q.GRIDS)) {
    assert.ok(!Q.onGrid(g, -0), g + ' -0');
    assert.ok(!Q.onGrid(g, NaN) && !Q.onGrid(g, Infinity) && !Q.onGrid(g, '1'), g + ' non-numbers');
    assert.ok(Q.onGrid(g, Q.GRIDS[g].expr(0)) && Q.onGrid(g, Q.GRIDS[g].expr(Q.GRIDS[g].max)), g + ' 0 and max');
    assert.ok(!Q.onGrid(g, Q.GRIDS[g].expr(Q.GRIDS[g].max + 1)), g + ' max + 1');
  }
  assert.ok(!Q.onGrid('prey3', 0) && Q.onGrid('prey3', 1) && Q.onGrid('prey3', 196606));
  assert.ok(Q.onGrid('init100', 5.39) && !Q.onGrid('init100', 5.391) && Q.onGrid('init1000', 0.43));
  assert.throws(() => Q.onGrid('ang16', 1), /unknown grid/);
});

test('slQuant: radByte and wangFromInput, every input', () => {
  for (let b = 0; b <= 255; b++) {
    const q = Q.radByte(b);
    assert.ok(q.raw === b && Object.is(q.v, C.rad5(b)) && numKind(q.v) !== 15, 'radByte ' + b);
  }
  const seen = new Set();
  for (let b = 0; b <= 250; b++) {
    const q = Q.wangFromInput(b);
    assert.ok(q.raw === Math.floor(256 * b / 251), 'L15 byte ' + b);
    assert.ok(Object.is(q.v, C.ang8(q.raw)) && numKind(q.v) !== 15, 'wang v ' + b);
    seen.add(q.raw);
  }
  // L15 (FM:198-199): bytes floor can never give.
  for (const never of [51, 102, 153, 204, 255]) assert.ok(!seen.has(never), 'L15 never gives ' + never);
  assert.strictEqual(seen.size, 251);
  for (const bad of [-1, 251, 252, 1.5, NaN, '3', undefined]) assert.throws(() => Q.wangFromInput(bad));
  for (const bad of [-1, 256, 2.5, NaN]) assert.throws(() => Q.radByte(bad));
});

test('slQuant: law vectors (L4, L5, L12, L13, L15, L18, L20)', () => {
  // L15 WANG_MAP floor(256 b / 251).
  assert.strictEqual(Q.wangFromInput(0).raw, 0);
  assert.strictEqual(Q.wangFromInput(1).raw, 1);
  assert.strictEqual(Q.wangFromInput(125).raw, 127);
  assert.strictEqual(Q.wangFromInput(126).raw, 128);
  assert.strictEqual(Q.wangFromInput(250).raw, 254);
  // L20 spawn speed 5.79 = nsp1 + nsp2, raw 5790; L12 rotation byte trunc(18 sp).
  assert.strictEqual(Q.sp1000(5.39 + 0.4).raw, 5790);
  assert.strictEqual(Q.sp1000(5.79).v, 5.79);
  assert.strictEqual(Q.rotSp(5.79).raw, 104);
  assert.strictEqual(Q.rotSp(5.79).v, 104 / 18);
  // L13 plateau nsp3 14 = byte 252.
  assert.strictEqual(Q.rotSp(14).raw, 252);
  assert.strictEqual(Q.sp1000(14).raw, 14000);
  // L12 trunc, not round: 18 x 5.8 = 104.4 and 18 x 5.83 = 104.94 both give 104.
  assert.strictEqual(Q.rotSp(5.83).raw, 104);
  assert.strictEqual(Q.sp1000(6.1999).raw, 6199);
  // L4, L5 init numbers on their wire grid (game.js:7292-7305).
  const init = { spangdv: [4.8, 48], nsp1: [5.39, 539], nsp2: [0.4, 40], nsp3: [14, 1400], mamu: [0.033, 33],
    mamu2: [0.029, 29], cst: [0.43, 430] };
  for (const k of Object.keys(init)) {
    const q = Q.initNum(k, init[k][0]);
    assert.strictEqual(q.raw, init[k][1], k);
    assert.ok(Object.is(q.v, init[k][0]), k + ' v');
    assert.notStrictEqual(numKind(q.v), 15, k + ' kind');
  }
  assert.throws(() => Q.initNum('nsp1', 5.391), /not on its wire grid/);
  assert.throws(() => Q.initNum('spangdv', 25.6), /outside/);
  assert.throws(() => Q.initNum('grd', 32550), /unknown init/);
  // L18: fam above 1, even 2, goes on the wire as the clamped raw 16777215 (FG:179-182).
  for (const f of [1, 1 + 1e-9, 1.5, 2, 2.75]) {
    for (const rule of ['round', 'floor']) {
      const q = Q.fam24(f, rule);
      assert.strictEqual(q.raw, 16777215, rule + ' ' + f);
      assert.strictEqual(q.v, 1);
    }
  }
  assert.strictEqual(Q.fam24(0.5, 'round').raw, 8388608);
  assert.strictEqual(Q.fam24(0.5, 'floor').raw, 8388607);
});

test('slQuant: edges 0, -0, max, 2 pi wrap', () => {
  const zeroIn = [0, -0];
  for (const z of zeroIn) {
    for (const [name, q, expect] of [
      ['rotAng round', Q.rotAng(z, 'round'), 0], ['rotAng floor', Q.rotAng(z, 'floor'), 0],
      ['rotSp', Q.rotSp(z), 0], ['ang24', Q.ang24(z), 0], ['sp1000', Q.sp1000(z), 0],
      ['fam24', Q.fam24(z, 'round'), 0], ['pos5', Q.pos5(z), 0], ['absXY', Q.absXY(z), 0],
      ['rad5', Q.rad5(z), 0], ['moveIang', Q.moveIang(z), 0], ['preyPos', Q.preyPos(z), 1]
    ]) {
      assert.ok(Object.is(q.raw, 0), name + ' raw of ' + (Object.is(z, -0) ? '-0' : '0'));
      assert.ok(Object.is(q.v, expect), name + ' v is ' + (Object.is(q.v, -0) ? '-0' : q.v));
      assert.notStrictEqual(numKind(q.v), 15, name + ' kind');
    }
  }
  assert.ok(Object.is(Q.wrapAngle(-0), 0));
  assert.ok(Object.is(Q.wrapAngle(-1e-300), 0));
  assert.ok(Object.is(Q.preyPos(1).raw, 0));
  // max raws
  assert.strictEqual(Q.rotAng(2 * Math.PI - 1e-9, 'floor').raw, 255);
  assert.strictEqual(Q.rotAng(2 * Math.PI - 1e-9, 'round').raw, 0);        // round up to 256 is direction 0
  assert.strictEqual(Q.rotSp(255 / 18).raw, 255);
  assert.throws(() => Q.rotSp(256 / 18), /outside/);
  assert.strictEqual(Q.ang24(2 * Math.PI - 1e-12).raw, 16777215);         // 2 pi itself: a legal raw
  assert.strictEqual(Q.ang24(2 * Math.PI - 1e-12).v, C.ang24(16777215));
  assert.strictEqual(Q.sp1000(65.535).raw, 65535);
  assert.throws(() => Q.sp1000(65.536), /outside/);
  assert.strictEqual(Q.pos5(3355443).raw, 16777215);
  assert.throws(() => Q.pos5(3355443.2), /outside/);
  assert.strictEqual(Q.absXY(65535).raw, 65535);
  assert.throws(() => Q.absXY(65536), /outside/);
  assert.throws(() => Q.absXY(-1), /outside/);
  assert.strictEqual(Q.preyPos(196606).raw, 65535);
  assert.throws(() => Q.preyPos(196609), /outside/);
  assert.strictEqual(Q.rad5(51).raw, 255);
  assert.throws(() => Q.rad5(51.2), /outside/);
  assert.strictEqual(Q.moveIang(2 * Math.PI - 1e-9).raw, 0);
  assert.strictEqual(Q.moveIang(2 * Math.PI - 2.2 * 2 * Math.PI / 65536).raw, 65534);
  // 2 pi wrap: any turn count, either sign
  for (const k of [-3, -1, 1, 2, 7]) {
    const off = k * 2 * Math.PI;
    assert.strictEqual(Q.rotAng(off + Math.PI, 'round').raw, 128, 'rotAng ' + k);
    assert.strictEqual(Q.moveIang(off + Math.PI).raw, 32768, 'moveIang ' + k);
    assert.strictEqual(Q.ang24(off + Math.PI / 2).raw, Math.round(16777215 / 4), 'ang24 ' + k);
  }
  assert.strictEqual(Q.rotAng(2 * Math.PI, 'round').raw, 0);
  assert.strictEqual(Q.rotAng(2 * Math.PI, 'floor').raw, 0);
  assert.strictEqual(Q.rotAng(-Math.PI / 2, 'round').raw, 192);
  assert.strictEqual(Q.ang24(2 * Math.PI).raw, 0);
  assert.strictEqual(Q.moveIang(-Math.PI / 2).raw, 49152);
});

test('slQuant: bad input throws (non-finite, negative fam, missing or unknown rule)', () => {
  for (const bad of [NaN, Infinity, -Infinity, undefined, null, '1', {}]) {
    assert.throws(() => Q.rotAng(bad, 'round'), TypeError);
    assert.throws(() => Q.rotSp(bad), TypeError);
    assert.throws(() => Q.ang24(bad), TypeError);
    assert.throws(() => Q.sp1000(bad), TypeError);
    assert.throws(() => Q.fam24(bad, 'round'), TypeError);
    assert.throws(() => Q.pos5(bad), TypeError);
    assert.throws(() => Q.absXY(bad), TypeError);
    assert.throws(() => Q.preyPos(bad), TypeError);
    assert.throws(() => Q.rad5(bad), TypeError);
    assert.throws(() => Q.moveIang(bad), TypeError);
  }
  for (const rule of [undefined, null, 'ceil', 'trunc', 'Round', 1, 'toString', '__proto__']) {
    assert.throws(() => Q.rotAng(1, rule), /L48\.angRound/);
    assert.throws(() => Q.fam24(0.5, rule), /L17\.famRound/);
  }
  assert.throws(() => Q.fam24(-1e-9, 'round'), /negative/);
  assert.throws(() => Q.rotSp(-0.1), /outside/);
  assert.throws(() => Q.sp1000(-0.01), /outside/);
  assert.throws(() => Q.movePoint(0, 0, 65536, 42), RangeError);
  assert.throws(() => Q.movePoint(0, 0, 1.5, 42), RangeError);
  assert.throws(() => Q.intField(-1, 255, 'x'), RangeError);
  assert.throws(() => Q.intField(256, 255, 'x'), RangeError);
  assert.ok(Object.is(Q.intField(-0, 255, 'x'), 0));
  assert.strictEqual(Q.intField(13974, 16777215, 'flux'), 13974);
});

test('slQuant: movePoint is the client head step', () => {
  const rng = createRng(21);
  for (let i = 0; i < 10000; i++) {
    const x = rng.range(1000, 64000), y = rng.range(1000, 64000), ia = rng.int(65536);
    const p = Q.movePoint(x, y, ia, 42);
    const a = ia * K64A_C;                                     // game.js:7727-7731
    assert.ok(Object.is(p.x, x + Math.cos(a) * 42) && Object.is(p.y, y + Math.sin(a) * 42), 'step ' + i);
  }
});

// The client's rebuild of an `s` body from its wire integers (game.js:8470-8534), written out here.
function clientBody(raw, msl) {
  const out = [];
  let x = 0, y = 0;
  for (let i = 0; i < raw.length; i++) {
    const e = raw[i];
    if (i === 0) { x = e.x / 5; y = e.y / 5; }
    else if (e.iang !== undefined) { const a = e.iang * K64A_C; x += Math.cos(a) * msl; y += Math.sin(a) * msl; }
    else { x += (e.bx - 127) / 2; y += (e.by - 127) / 2; }
    out.push({ x: x, y: y });
  }
  return out;
}

// A body the way the sim makes one: points at most msl apart, the head one exact msl step along a 16-bit angle.
function makeBody(rng, n, msl) {
  const pts = [{ x: rng.range(5000, 60000), y: rng.range(5000, 60000) }];
  let a = rng.range(0, 2 * Math.PI);
  for (let i = 1; i < n - 1; i++) {
    a += rng.range(-0.6, 0.6);
    const d = rng.range(0.2 * msl, msl);
    const p = pts[i - 1];
    pts.push({ x: p.x + Math.cos(a) * d, y: p.y + Math.sin(a) * d });
  }
  const iang = rng.int(65536);
  const prev = pts[pts.length - 1];
  const h = Q.movePoint(prev.x, prev.y, iang, msl);
  pts.push({ x: h.x, y: h.y });
  return { pts: pts, iang: iang };
}

test('slQuant: addBody rebuilds on the client within 0.25 per axis and ends angle-coded', () => {
  const msl = 42;                                             // L5 default_msl
  const rng = createRng(33);
  for (let t = 0; t < 3000; t++) {
    const n = 2 + rng.int(120);
    const body = makeBody(rng, n, msl);
    const q = Q.addBody(body.pts, msl, t % 2 ? body.iang : undefined);
    assert.strictEqual(q.raw.length, n);
    assert.ok(Number.isInteger(q.raw[0].x) && Number.isInteger(q.raw[0].y) && q.raw[0].iang === undefined);
    for (let i = 1; i < n - 1; i++) {
      const e = q.raw[i];
      assert.ok(Number.isInteger(e.bx) && e.bx >= 0 && e.bx <= 255 && Number.isInteger(e.by) && e.by >= 0 &&
        e.by <= 255 && e.iang === undefined, 'delta ' + i);
    }
    assert.strictEqual(q.raw[n - 1].iang, body.iang, 'head iang (given or from the segment) ' + t);
    const cb = clientBody(q.raw, msl);
    for (let i = 0; i < n; i++) {
      if (!Object.is(cb[i].x, q.v[i].x) || !Object.is(cb[i].y, q.v[i].y)) assert.fail('v is not the client point ' + i);
    }
    for (let i = 0; i < n - 1; i++) {
      const dx = Math.abs(q.v[i].x - body.pts[i].x), dy = Math.abs(q.v[i].y - body.pts[i].y);
      if (dx > 0.25 || dy > 0.25) assert.fail('point ' + i + ' off by ' + dx + ', ' + dy);
    }
    // The head is one msl step from the rebuilt point, so it carries the same offset (it never grows).
    const ox = q.v[n - 2].x - body.pts[n - 2].x, oy = q.v[n - 2].y - body.pts[n - 2].y;
    const hx = q.v[n - 1].x - body.pts[n - 1].x, hy = q.v[n - 1].y - body.pts[n - 1].y;
    assert.ok(Math.abs(hx - ox) < 1e-9 && Math.abs(hy - oy) < 1e-9, 'head offset ' + t);
    assert.ok(Object.is(q.ang, body.iang * K64A_C));
  }
});

test('slQuant: addBody spawn shape (L20) and refusals', () => {
  // L20: two points msl = 42 apart in a straight line.
  const head = Q.movePoint(32550, 32550, 16384, 42);
  const q = Q.addBody([{ x: 32550, y: 32550 }, head], 42, 16384);
  assert.strictEqual(q.raw.length, 2);
  assert.strictEqual(q.raw[0].x, 162750);
  assert.strictEqual(q.raw[0].y, 162750);
  assert.strictEqual(q.raw[1].iang, 16384);
  assert.ok(Object.is(q.v[1].x, head.x) && Object.is(q.v[1].y, head.y));
  assert.throws(() => Q.addBody([{ x: 1, y: 1 }], 42), /at least 2/);
  assert.throws(() => Q.addBody([], 42), /at least 2/);
  // a gap the byte offset cannot carry is a sim bug: it throws
  assert.throws(() => Q.addBody([{ x: 1000, y: 1000 }, { x: 1070, y: 1000 }, { x: 1112, y: 1000 }], 42), /delta/);
  assert.throws(() => Q.addBody([{ x: 1000, y: NaN }, { x: 1042, y: 1000 }], 42), TypeError);
});

test('slQuant: food cells (L2 sector 300, cell 300 / 256)', () => {
  const ss = 300;                                             // L2 SECTOR_SIZE
  const ssd256 = ss / 256;                                    // game.js:7288
  const rng = createRng(44);
  for (let i = 0; i < 20000; i++) {
    const x = rng.range(0, 65100);
    const c = Q.foodCell(x, ss);
    assert.ok(Number.isInteger(c.s) && c.s >= 0 && c.s <= 255 && Number.isInteger(c.r) && c.r >= 0 && c.r <= 255);
    assert.ok(Object.is(c.v, c.s * ss + c.r * ssd256), 'client expression game.js:8680');
    assert.ok(c.v <= x + 1e-9 && x < c.v + ssd256 + 1e-9, 'cell holds x ' + x);
    assert.ok(Object.is(Q.foodPos(c.s, c.r, ss), c.v));
  }
  assert.strictEqual(Q.foodPos(108, 128, ss), 108 * 300 + 150);
  assert.ok(Object.is(Q.foodCell(-0, ss).v, 0));
  assert.throws(() => Q.foodPos(256, 0, ss), RangeError);
  assert.throws(() => Q.foodPos(0, -1, ss), RangeError);
  assert.throws(() => Q.foodCell(-1, ss), RangeError);
  assert.throws(() => Q.foodCell(NaN, ss), TypeError);
});
