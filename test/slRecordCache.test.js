'use strict';
// slither.io free room, task T2: server/sl/slRecordCache.js (SERVER-DESIGN 8.5, 18.1, 18.2 item 1).
// Cached records concatenated equal slWire.encodeBundle(events, pv) byte for byte on 10,000 seeded random event
// lists; own and other variants of snake_rot and snake_move; the kind-15 scan on a hand-made corpus built from
// slQuant, with a negative control. Values are literals or slQuant outputs; nothing is read from slither-reference.
const test = require('node:test');
const assert = require('node:assert');

const W = require('../shared/slWire.js');
const Q = require('../server/sl/slQuant.js');
const RC = require('../server/sl/slRecordCache.js');
const { createRng } = require('../server/ag/agRng.js');

const PV = 19;            // L6 protocol 19
const MSL = 42;           // L5 default_msl
const MOVE = ['g', 'G', 'n', 'N', '+', '='];

function sameBytes(a, b, msg) {
  assert.ok(a instanceof Uint8Array && b instanceof Uint8Array, msg + ': bytes');
  if (a.length !== b.length) assert.fail(msg + ': length ' + a.length + ' vs ' + b.length);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) assert.fail(msg + ': byte ' + i + ' ' + a[i] + ' vs ' + b[i]);
}

// `init` with the L1 to L6 values (realSid 0, Q12).
function initEvent(fluxGrd) {
  return { type: 'init', grd: 32550, mscps: 430, sectorSize: 300, sectorCount: 102, spangdv: 4.8, nsp1: 5.39,
    nsp2: 0.4, nsp3: 14, mamu: 0.033, mamu2: 0.029, cst: 0.43, pv: PV, defaultMsl: MSL, realSid: 0, fluxGrd: fluxGrd,
    gameMode: 1, extraB: 0 };
}

// One random event of any type slWire encodes at pv 19 (numbers from slQuant, or raw doubles when `wild`).
function randomEvent(rng, wild) {
  const num = (q) => (wild && rng.chance(0.3) ? rng.range(-1e6, 1e6) : q.v);
  const id = rng.int(65536);
  const pick = (a) => a[rng.int(a.length)];
  switch (rng.int(27)) {
    case 0: return initEvent(9981 + rng.int(4000));
    case 1: case 2: {
      const ev = { type: 'snake_rot', id: id };
      if (rng.chance(0.5)) ev.dir = 1 + rng.int(2);
      if (rng.chance(0.7)) ev.ang = num(Q.rotAng(rng.range(0, 7), 'round'));
      if (rng.chance(0.5)) ev.wang = num(Q.wangFromInput(rng.int(251)));
      if (rng.chance(0.5)) ev.sp = num(Q.rotSp(rng.range(5.39, 14)));
      return ev;
    }
    case 3: return { type: 'snake_fam', id: id, fam: num(Q.fam24(rng.range(0, 2), 'round')) };
    case 4: return rng.chance(0.5) ? { type: 'snake_tail', id: id } :
      { type: 'snake_tail', id: id, fam: num(Q.fam24(rng.range(0, 1), 'floor')) };
    case 5: case 6: case 7: {
      const cmd = pick(MOVE);
      const ev = { type: 'snake_move', cmd: cmd, id: id };
      if (cmd === '+' || cmd === '=') {
        ev.iang = Q.moveIang(rng.range(0, 7)).raw;
        ev.xx = num(Q.absXY(rng.range(0, 65100)));
        ev.yy = num(Q.absXY(rng.range(0, 65100)));
      } else if (rng.chance(0.5)) {
        ev.iang = Q.moveIang(rng.range(0, 7)).raw;
      }
      if (cmd === 'n' || cmd === 'N' || cmd === '+') ev.fam = num(Q.fam24(rng.range(0, 2.5), 'round'));
      return ev;
    }
    case 8: {
      const rows = [];
      const k = rng.int(11);
      for (let i = 0; i < k; i++) {
        rows.push({ sct: 2 + rng.int(400), fam: num(Q.fam24(rng.range(0, 1), 'round')), raw: { cv: rng.int(66) },
          nick: 'n' + rng.int(1e6) });
      }
      return { type: 'leaderboard', myPos: rng.int(11), rank: rng.int(500), count: rng.int(500), rows: rows };
    }
    case 9: return { type: 'dead', code: rng.int(3) };
    case 10: return { type: 'sector_remove', sx: rng.int(217), sy: rng.int(217) };
    case 11: return { type: 'pong' };
    case 12: {
      const dim = 136, n = rng.int(60), idx = new Set();
      while (idx.size < n) idx.add(rng.int(dim * dim));
      const cells = [...idx].sort((a, b) => a - b).map((i) => [dim - 1 - (i % dim), dim - 1 - Math.floor(i / dim)]);
      return rng.chance(0.5) ? { type: 'minimap', cmd: 'M', raw: { size: dim }, size: dim, pixels: cells } :
        { type: 'minimap', cmd: 'V', size: dim, toggles: cells };
    }
    case 13: case 14: {
      const n = 2 + rng.int(30);
      const pts = [{ x: rng.range(5000, 60000), y: rng.range(5000, 60000) }];
      let a = rng.range(0, 7);
      for (let i = 1; i < n - 1; i++) {
        a += rng.range(-0.5, 0.5);
        const p = pts[i - 1];
        pts.push({ x: p.x + Math.cos(a) * 30, y: p.y + Math.sin(a) * 30 });
      }
      const iang = Q.moveIang(a).raw;
      const prev = pts[pts.length - 1];
      pts.push(Q.movePoint(prev.x, prev.y, iang, MSL));
      const body = Q.addBody(pts, MSL, iang);
      const head = body.v[body.v.length - 1];
      const ev = { type: 'snake_add', id: id, ang: num(Q.ang24(a)), wang: num(Q.ang24(rng.range(0, 7))),
        sp: num(Q.sp1000(rng.range(5.39, 14))), fam: num(Q.fam24(rng.range(0, 1), 'round')), cv: rng.int(66),
        snx: num(Q.pos5(head.x + rng.range(0, 10))), sny: num(Q.pos5(head.y + rng.range(0, 10))),
        nick: rng.chance(0.3) ? '' : 'snake' + rng.int(1000), raw: { pts: body.raw } };
      if (rng.chance(0.3)) ev.skin = Array.from({ length: rng.int(20) }, () => rng.int(256));
      return ev;
    }
    case 15: return { type: 'snake_remove', id: id, kill: rng.chance(0.5) };
    case 16: {
      const foods = [];
      const k = rng.int(12);
      for (let i = 0; i < k; i++) foods.push({ cv: rng.int(9), rx: rng.int(256), ry: rng.int(256), rad: num(Q.radByte(15 + rng.int(33))) });
      return { type: 'food_sector', sx: rng.int(217), sy: rng.int(217), foods: foods };
    }
    case 17: return { type: 'food_add', rapid: rng.chance(0.5), sectorFromLast: false, sx: rng.int(217),
      sy: rng.int(217), rx: rng.int(256), ry: rng.int(256), cvFromLast: false, cv: rng.int(9),
      rad: num(Q.radByte(rng.int(256))) };
    case 18: return { type: 'food_eat', cmd: '<', sectorFromLast: false, sx: rng.int(217), sy: rng.int(217),
      rx: rng.int(256), ry: rng.int(256), eater: rng.int(65536) };
    case 19: {
      const ev = { type: 'prey_move', id: id, xx: num(Q.preyPos(rng.range(1, 65000))),
        yy: num(Q.preyPos(rng.range(1, 65000))) };
      if (rng.chance(0.5)) ev.dir = 1 + rng.int(2);
      if (rng.chance(0.5)) ev.ang = num(Q.ang24(rng.range(0, 7)));
      if (rng.chance(0.5)) ev.wang = num(Q.ang24(rng.range(0, 7)));
      if (rng.chance(0.5)) ev.sp = num(Q.sp1000(rng.range(3.8, 11)));
      return ev;
    }
    case 20: return { type: 'prey_remove', id: id };
    case 21: return { type: 'prey_eaten', id: id, eater: rng.int(65536) };
    case 22: return { type: 'prey_add', id: id, cv: rng.int(9), xx: num(Q.pos5(rng.range(0, 65100))),
      yy: num(Q.pos5(rng.range(0, 65100))), rad: num(Q.rad5(rng.range(6, 9))), dir: rng.int(3),
      wang: num(Q.ang24(rng.range(0, 7))), ang: num(Q.ang24(rng.range(0, 7))), sp: num(Q.sp1000(3.8)) };
    case 23: return { type: 'kill_count', id: id, count: rng.int(100) };
    case 24: return { type: 'flux', fluxGrd: 9797 + rng.int(4200) };
    case 25: return { type: 'sector_add', sx: rng.int(217), sy: rng.int(217) };   // never sent; codec coverage
    default: return { type: 'longest_msg', sct: rng.int(500), fam: num(Q.fam24(rng.range(0, 1), 'round')),
      nick: 'x', msg: 'y' };
  }
}

test('slRecordCache: records concatenated equal encodeBundle(events, pv) on 10,000 random lists', () => {
  const rng = createRng(7);
  const cache = RC.createRecordCache(PV);
  let pool = [];
  let checked = 0, joins = 0, scanned = 0;
  for (let t = 0; t < 10000; t++) {
    if (t % 50 === 0) { cache.clear(); pool = []; }             // a new tick: 50 seats' lists share its events
    const tame = Math.floor(t / 50) % 3 !== 0;                  // every third tick also carries raw doubles
    const n = rng.int(40);
    const list = [];
    for (let i = 0; i < n; i++) {
      // reuse an event of this tick (another seat gets the same event) or make a new one
      const ev = pool.length > 0 && rng.chance(0.4) ? pool[rng.int(pool.length)] : randomEvent(rng, !tame);
      if (pool.indexOf(ev) < 0) pool.push(ev);
      list.push({ ev: ev, own: rng.chance(0.3) });
    }
    // a join bundle starts with init; then the client's pv before it does not matter
    const join = rng.chance(0.1);
    if (join) list.unshift({ ev: initEvent(12000 + rng.int(100)), own: false });
    const records = list.map((x) => cache.recordBytes(x.ev, x.own));
    const variants = list.map((x) => RC.variantOf(x.ev, x.own));
    const got = RC.bundleBytes(records);
    sameBytes(got, W.encodeBundle(variants, PV), 'list ' + t);
    if (join) {
      sameBytes(got, W.encodeBundle(variants, 1), 'join list ' + t + ' at a held pv of 1');
      joins++;
    }
    // lists built only from slQuant values (no event of this tick was made wild) carry no off-grid number
    if (tame && t % 5 === 1) {
      const scan = RC.scanBundle(got);
      assert.ok(scan.wireError === null && scan.kind15.length === 0 && scan.offGrid.length === 0,
        'list ' + t + ' ' + JSON.stringify(scan.offGrid.slice(0, 3)));
      scanned++;
    }
    checked++;
  }
  assert.strictEqual(checked, 10000);
  assert.ok(scanned > 300, 'scanned ' + scanned);
  assert.ok(joins > 500, 'join lists ' + joins);
  assert.ok(cache.stats.hits > 10000 && cache.stats.misses > 10000, JSON.stringify(cache.stats));
});

test('slRecordCache: own and other variants of snake_rot and snake_move', () => {
  const cache = RC.createRecordCache(PV);
  for (const [cmd, ownCmd, otherCmd] of [['g', 'G', 'g'], ['G', 'G', 'g'], ['n', 'N', 'n'], ['N', 'N', 'n'],
    ['+', '+', '+'], ['=', '=', '=']]) {
    const ev = { type: 'snake_move', cmd: cmd, id: 77, iang: 1234 };
    if (cmd === '+' || cmd === '=') { ev.xx = 100; ev.yy = 200; }
    if (cmd === 'n' || cmd === 'N' || cmd === '+') ev.fam = Q.fam24(0.25, 'round').v;
    const own = W.decodeBundle(RC.bundleBytes([cache.recordBytes(ev, true)]))[0];
    const other = W.decodeBundle(RC.bundleBytes([cache.recordBytes(ev, false)]))[0];
    assert.strictEqual(own.cmd, ownCmd);
    assert.strictEqual(own.own, true);
    assert.strictEqual(own.id, undefined);
    assert.strictEqual(other.cmd, otherCmd);
    assert.strictEqual(other.own, false);
    assert.strictEqual(other.id, 77);
    assert.strictEqual(own.iang, 1234);
    assert.strictEqual(ev.cmd, cmd, 'the shared event is not changed');
  }
  const rot = { type: 'snake_rot', id: 9, dir: 2, ang: Q.rotAng(1, 'round').v };
  const a = cache.recordBytes(rot, true), b = cache.recordBytes(rot, false);
  assert.strictEqual(cache.recordBytes(rot, true), a, 'own variant cached');
  assert.strictEqual(cache.recordBytes(rot, false), b, 'other variant cached');
  assert.strictEqual(a.length + 1, b.length, 'the own record drops the one-byte id');
  // other event types ignore `own` and share one record
  const pong = { type: 'pong' };
  assert.strictEqual(cache.recordBytes(pong, true), cache.recordBytes(pong, false));
  assert.strictEqual(cache.recordBytes(pong), cache.recordBytes(pong, false));
  // refusals
  assert.throws(() => cache.recordBytes(rot), /own true or false/);
  assert.throws(() => cache.recordBytes({ type: 'snake_move', cmd: 'x', id: 1 }, false), /not a move/);
  assert.throws(() => cache.recordBytes(null, false), TypeError);
  assert.throws(() => cache.recordBytes({ type: 'init', grd: 1, mscps: 1, sectorSize: 1, sectorCount: 1, spangdv: 1,
    nsp1: 1, nsp2: 1, nsp3: 1, mamu: 1, mamu2: 1, cst: 1, pv: 18 }, false), /pv 18/);
  assert.throws(() => RC.createRecordCache(1.5), RangeError);
  assert.throws(() => RC.bundleBytes([[1, 2]]), TypeError);
  // clear() drops the cached bytes
  const before = cache.recordBytes(pong, false);
  cache.clear();
  assert.notStrictEqual(cache.recordBytes(pong, false), before);
});

test('slRecordCache: kind-15 free on a hand-made corpus from slQuant; the scan catches an off-grid number', () => {
  const head = Q.movePoint(32000, 33000, 9000, MSL);
  const body = Q.addBody([{ x: 31950, y: 32980 }, { x: 31980.3, y: 32991.9 }, { x: 32000, y: 33000 }, head], MSL, 9000);
  const own = [
    { type: 'init', grd: 32550, mscps: 430, sectorSize: 300, sectorCount: 102, spangdv: Q.initNum('spangdv', 4.8).v,
      nsp1: Q.initNum('nsp1', 5.39).v, nsp2: Q.initNum('nsp2', 0.4).v, nsp3: Q.initNum('nsp3', 14).v,
      mamu: Q.initNum('mamu', 0.033).v, mamu2: Q.initNum('mamu2', 0.029).v, cst: Q.initNum('cst', 0.43).v, pv: PV,
      defaultMsl: MSL, realSid: 0, fluxGrd: Q.intField(12345, Q.U24, 'flux'), gameMode: 1, extraB: 0 },
    { type: 'snake_add', id: 5, ang: Q.ang24(body.ang).v, wang: Q.ang24(Q.wangFromInput(37).v).v,
      sp: Q.sp1000(5.39 + 0.4).v, fam: Q.fam24(0, 'round').v, cv: 19,
      snx: Q.pos5(head.x + 3.2).v, sny: Q.pos5(head.y - 1.1).v, nick: 'Owen', raw: { pts: body.raw } },
    { type: 'food_sector', sx: 106, sy: 109, foods: [{ cv: 3, rx: 12, ry: 200, rad: Q.radByte(40).v },
      { cv: 0, rx: 255, ry: 0, rad: Q.radByte(15).v }] },
    { type: 'prey_add', id: 3, cv: 4, xx: Q.pos5(32111.13).v, yy: Q.pos5(32999.99).v, rad: Q.rad5(7.31).v, dir: 0,
      wang: Q.ang24(2.5).v, ang: Q.ang24(-0.7).v, sp: Q.sp1000(3.8).v },
    { type: 'snake_rot', id: 5, dir: 1, ang: Q.rotAng(2.2, 'round').v, wang: Q.wangFromInput(250).v,
      sp: Q.rotSp(9.3).v },
    { type: 'snake_rot', id: 5, ang: Q.rotAng(-0, 'floor').v },
    { type: 'snake_move', cmd: 'n', id: 5, iang: Q.moveIang(1.1).raw, fam: Q.fam24(1.7, 'round').v },
    { type: 'snake_move', cmd: '+', id: 5, iang: Q.moveIang(1.1).raw, xx: Q.absXY(32041.6).v, yy: Q.absXY(33000.4).v,
      fam: Q.fam24(0.999999999, 'floor').v },
    { type: 'snake_fam', id: 5, fam: Q.fam24(2.4, 'round').v },
    { type: 'snake_tail', id: 5, fam: Q.fam24(0.3333, 'floor').v },
    { type: 'food_add', rapid: true, sectorFromLast: false, sx: 106, sy: 109, rx: 1, ry: 2, cvFromLast: false, cv: 5,
      rad: Q.radByte(Math.round(84.2853 * Math.sqrt(0.0815) + 0.1702)).v },
    { type: 'prey_move', id: 3, xx: Q.preyPos(32111.13).v, yy: Q.preyPos(32999.99).v, dir: 2, ang: Q.ang24(1).v,
      wang: Q.ang24(1.3).v, sp: Q.sp1000(6.06).v },
    { type: 'leaderboard', myPos: 1, rank: 1, count: 40, rows: [{ sct: 163, fam: Q.fam24(0.42, 'round').v,
      raw: { cv: 19 }, nick: 'Owen' }] },
    { type: 'flux', fluxGrd: 12339 },
    { type: 'food_eat', cmd: '<', sectorFromLast: false, sx: 106, sy: 109, rx: 12, ry: 200, eater: 5 },
    { type: 'kill_count', id: 5, count: 1 },
    { type: 'dead', code: 0 },
    { type: 'snake_remove', id: 5, kill: true }
  ];
  const cache = RC.createRecordCache(PV);
  const bundle = RC.bundleBytes(own.map((ev) => cache.recordBytes(ev, ev.type === 'snake_rot' || ev.type === 'snake_move' ? ev.id === 5 : false)));
  const scan = RC.scanBundle(bundle);
  assert.strictEqual(scan.wireError, null);
  assert.strictEqual(scan.events.length, own.length);
  assert.strictEqual(scan.kind15.length, 0, JSON.stringify(scan.kind15));
  assert.strictEqual(scan.offGrid.length, 0, JSON.stringify(scan.offGrid));
  // the decoded snake_add body rebuilds to the slQuant points
  const add = scan.events[1];
  assert.strictEqual(add.raw.pts.length, 4);
  assert.strictEqual(add.raw.pts[3].iang, 9000);
  // negative control: unquantized numbers are found, by field
  const bad = RC.bundleBytes([
    RC.encodeRecord({ type: 'snake_rot', id: 5, ang: 1.2345 }, false, PV),
    RC.encodeRecord({ type: 'prey_add', id: 3, cv: 4, xx: 1.3, yy: 2, rad: 7.31, dir: 0, wang: 2.5, ang: 0, sp: 3.8 },
      false, PV),
    RC.encodeRecord({ type: 'leaderboard', myPos: 1, rank: 1, count: 1, rows: [{ sct: 9, fam: 0.123456789,
      raw: { cv: 1 }, nick: 'a' }] }, false, PV),
    RC.encodeRecord({ type: 'snake_fam', id: 1, fam: -0 }, false, PV)
  ]);
  const s2 = RC.scanBundle(bad);
  // 1.3, 7.31 and 2.5 find the /10 and /100 kinds, so only the grid test catches them
  assert.deepStrictEqual(s2.kind15.map((k) => k.type + '.' + k.field),
    ['snake_rot.ang', 'leaderboard.rows[0].fam', 'snake_fam.fam']);
  assert.deepStrictEqual(s2.offGrid.map((k) => k.type + '.' + k.field),
    ['snake_rot.ang', 'prey_add.xx', 'prey_add.rad', 'prey_add.wang', 'leaderboard.rows[0].fam', 'snake_fam.fam']);
  // a truncated bundle reports its wire error
  const cut = RC.scanBundle(bundle.subarray(0, bundle.length - 1));
  assert.strictEqual(cut.wireError.type, 'wire_error');
  assert.strictEqual(RC.numKind(0), 0);
  assert.strictEqual(RC.numKind(-0), RC.KIND_F64);
  assert.strictEqual(RC.numKind(Q.rotAng(1, 'round').v), 1);
});
