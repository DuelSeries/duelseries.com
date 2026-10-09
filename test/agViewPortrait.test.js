'use strict';
// The phone portrait layout's view report (Owen 2026-10-08, FIX-PLAN P4): a phone held upright plays the reference
// screen turned on its side and says so on ag:portrait (one boolean, our own wire). This file follows it from the
// socket handler through the directory and the room to the view box: the box is L4's turned on its side (the same
// area, so no orientation sees more), only true or false is ever taken, the directory changes a socket's box
// orientation at most once per PORTRAIT_GAP_MS and still ends on the last report, and nothing changes for a page
// that never sends it. Run on the FIXTURE law table (L4 pad 100: half width 1010 and half height 590 at s = 1).
const test = require('node:test');
const assert = require('node:assert');
const V = require('../server/ag/agView');
const L = require('../server/ag/agLaws');
const { AgArenas, ARENA_TUNING } = require('../server/ag/agArenas');
const { AgRoom } = require('../server/ag/agRoom');
const { attachAgSockets } = require('../server/ag/agSockets');
const { FIXTURE } = require('./agLawsFixture');

const quiet = { error() {}, warn() {}, log() {} };
const L4 = FIXTURE.L4.value;
const HALF_W = (L4.baseW + L4.pad) / 2;          // 1010 at s = 1
const HALF_H = (L4.baseH + L4.pad) / 2;          // 590 at s = 1
const GAP = ARENA_TUNING.PORTRAIT_GAP_MS.value;
const BORDER = { minX: -7000, minY: -7000, maxX: 7000, maxY: 7000 };

function frame(cells) {
  return V.makeFrame({ border: BORDER, cells }, FIXTURE);
}
function food(id, x, y) {
  return { id, kind: 'food', x, y, size: 10, rgb: [7, 255, 40] };
}
function player(id, owner, x, y, size) {
  return { id, owner, kind: 'player', x, y, size, rgb: [255, 7, 100], name: 'p' + owner };
}
function sentIds(records) {
  const ids = [];
  for (const r of records) if (r.t === 'world' || r.t === 'sync') for (const c of r.cells) ids.push(c.id);
  return ids.sort((a, b) => a - b);
}
const half = (box) => [box.maxX - box.cx, box.maxY - box.cy];

test('viewBoxFor: portrait turns L4\'s box on its side, same area; false or absent is the plain box', () => {
  assert.deepStrictEqual([L4.baseW, L4.baseH], [1920, 1080], 'the fixture keeps the reference screen');
  for (const law of [L4, L.LAWS.L4.value]) {
    for (const s of [1, 0.6, 0.25]) {
      const plain = V.viewBoxFor(10, 20, s, law);
      assert.deepStrictEqual(V.viewBoxFor(10, 20, s, law, 0, false), plain);
      const p = V.viewBoxFor(10, 20, s, law, 0, true);
      assert.ok(Math.abs((p.maxX - p.minX) - (law.baseH + law.pad) / s) < 1e-9, 'baseH + pad across');
      assert.ok(Math.abs((p.maxY - p.minY) - (law.baseW + law.pad) / s) < 1e-9, 'baseW + pad down');
      const area = (b) => (b.maxX - b.minX) * (b.maxY - b.minY);
      assert.ok(Math.abs(area(p) - area(plain)) < 1e-6 * area(plain), 'the same area');
      assert.deepStrictEqual([p.cx, p.cy, p.scale], [10, 20, s]);
      // below still moves only the bottom edge
      const pb = V.viewBoxFor(10, 20, s, law, 102, true);
      assert.deepStrictEqual(pb, Object.assign({}, p, { maxY: p.maxY + 102 / s }));
    }
  }
  // The real table at s = 1: 1180.6 across, 2020.6 down, so a 1080 x 1920 portrait view keeps the measured pad.
  const real = V.viewBoxFor(0, 0, 1, L.LAWS.L4.value, 0, true);
  assert.ok(Math.abs(real.maxX * 2 - 1180.6) < 1e-9 && Math.abs(real.maxY * 2 - 2020.6) < 1e-9);
});

test('viewer: extra.portrait sends the cells of the turned box; a bad value throws before anything is sent', () => {
  // Inside the plain box only (x 900), inside the turned box only (y 900), and inside both (y 500).
  const cells = [player(1, 7, 0, 0, 32), food(100, 900, 0), food(101, 0, 900), food(102, 0, 500), food(103, 0, -900)];
  const plain = V.createViewer(7, { laws: FIXTURE });
  assert.deepStrictEqual(sentIds(plain.build(frame(cells))), [1, 100, 102]);
  assert.deepStrictEqual(half(plain.box()), [HALF_W, HALF_H]);

  const v = V.createViewer(7, { laws: FIXTURE });
  assert.deepStrictEqual(sentIds(v.build(frame(cells), { portrait: true })), [1, 101, 102, 103]);
  assert.deepStrictEqual(half(v.box()), [HALF_H, HALF_W]);
  // Turned back: the cells only the turned box held leave the view like any other.
  const recs = v.build(frame(cells), { portrait: false });
  assert.deepStrictEqual(half(v.box()), [HALF_W, HALF_H]);
  assert.ok(recs.some((r) => r.t === 'world' && r.removed.includes(101) && r.removed.includes(103) && r.cells.some((c) => c.id === 100)));

  const w = V.createViewer(7, { laws: FIXTURE });
  for (const bad of [1, 0, 'true', null, {}, []]) {
    assert.throws(() => w.build(frame(cells), { portrait: bad }), /portrait/);
  }
  assert.strictEqual(w.build(frame(cells))[0].t, 'hello', 'the join order still starts at hello');
});

test('room: each seat\'s build gets its own orientation through portraitOf', () => {
  const on = new Map([['a', true], ['b', false]]);
  const r = new AgRoom({ laws: FIXTURE, shippableOnly: false, seed: 7, autoTick: false, log: quiet,
    portraitOf: (id) => on.get(id) === true, viewBelowOf: (id) => (id === 'a' ? 50 : 0) });
  const sock = (id) => ({ id, conn: { writeBuffer: [] }, emit() {} });
  r.addSocket(sock('a'));
  r.addSocket(sock('b'));
  r.tickOnce();
  assert.deepStrictEqual(half(r.seatOf('a').viewer.box()), [HALF_H, HALF_W + 50], 'turned, plus its rows below');
  assert.deepStrictEqual(half(r.seatOf('b').viewer.box()), [HALF_W, HALF_H]);
  on.set('a', false);
  r.tickOnce();
  assert.deepStrictEqual(half(r.seatOf('a').viewer.box()), [HALF_W, HALF_H + 50]);
  r.stop();
  // A room made without one sends the plain L4 box.
  const plain = new AgRoom({ laws: FIXTURE, shippableOnly: false, seed: 7, autoTick: false, log: quiet });
  plain.addSocket(sock('c'));
  plain.tickOnce();
  assert.deepStrictEqual(half(plain.seatOf('c').viewer.box()), [HALF_W, HALF_H]);
  plain.stop();
});

function world(opts) {
  let clock = 1000000;
  const a = new AgArenas({ laws: FIXTURE, shippableOnly: false, autoTick: false, seed: 3, log: quiet, now: () => clock });
  const rl = [];
  const socketRL = (opts && opts.socketRL) || ((socket, key, ms) => { rl.push(key); return true; });
  const sanitizeName = (n) => (typeof n === 'string' ? n.replace(/[<>]/g, '').trim().slice(0, 20) : '') || 'Player';
  const handlers = attachAgSockets(null, a, { socketRL, sanitizeName, log: quiet });
  return { a, handlers, rl, advance(ms) { clock += ms; } };
}
let sn = 0;
function sock(w) {
  ++sn;
  const s = {
    id: 'vp' + sn,
    handshake: { address: '10.8.' + (sn >> 8) + '.' + (sn & 255), headers: {} },
    conn: { writeBuffer: [] },
    handlers: {},
    on(ev, fn) { this.handlers[ev] = fn; },
    emit() {},
    fire(ev, ...args) { this.handlers[ev](...args); },
  };
  w.handlers.attach(s);
  return s;
}
function boxHalf(w, s) {
  const room = w.a.roomOfSocket(s.id);
  room.tickOnce();
  return half(room.seatOf(s.id).viewer.box());
}

test('ag:portrait: only true or false is taken; every other shape is ignored; no socketRL key', () => {
  assert.strictEqual(ARENA_TUNING.PORTRAIT_GAP_MS.status, 'CHOSEN');
  assert.strictEqual(GAP, 1000);
  const w = world();
  const s = sock(w);
  assert.deepStrictEqual(boxHalf(w, s), [HALF_W, HALF_H], 'sideways until told');
  for (const bad of [undefined, null, 1, 0, 'true', 'portrait', [], [true], { on: true }, { portrait: true },
    new Uint8Array([1]), NaN, { w: 1080, h: 1920 }]) {
    s.fire('ag:portrait', bad, () => {});
    assert.strictEqual(w.a.portraitOf(s.id), false, JSON.stringify(bad));
  }
  assert.strictEqual(w.a.portraitState.size, 0, 'nothing kept for a bad report');
  s.fire('ag:portrait', false);
  assert.strictEqual(w.a.portraitState.size, 0, 'false is the start: nothing to keep');
  s.fire('ag:portrait', true);
  assert.strictEqual(w.a.portraitOf(s.id), true);
  assert.deepStrictEqual(boxHalf(w, s), [HALF_H, HALF_W]);
  assert.deepStrictEqual(w.rl.filter((k) => /portrait/.test(k)), [], 'the directory limits it, socketRL never drops it');
  assert.strictEqual(w.a.portrait(42, true), false, 'a socket id is a string');
  assert.strictEqual(w.a.portrait(s.id, 'true'), false, 'the directory checks the boolean too');
});

test('ag:portrait: at most one box orientation change per PORTRAIT_GAP_MS, and the last report always wins', () => {
  const w = world();
  const s = sock(w);
  s.fire('ag:portrait', true);
  assert.strictEqual(w.a.portraitOf(s.id), true, 'the first change is at once');
  w.advance(GAP / 2);
  s.fire('ag:portrait', false);
  assert.strictEqual(w.a.portraitOf(s.id), true, 'too soon: waits');
  assert.deepStrictEqual(boxHalf(w, s), [HALF_H, HALF_W]);
  w.advance(GAP / 2 - 1);
  assert.strictEqual(w.a.portraitOf(s.id), true);
  w.advance(1);
  assert.strictEqual(w.a.portraitOf(s.id), false, 'applied once the gap is up, with no new report');
  assert.deepStrictEqual(boxHalf(w, s), [HALF_W, HALF_H]);

  // A flood of flips, one every 10 ms for 5 s: the box changes orientation at most once a second, and ends on the
  // last report once the gap is up.
  let changes = 0;
  let prev = w.a.portraitOf(s.id);
  let last = prev;
  for (let i = 0; i < 500; i++) {
    w.advance(10);
    last = i % 2 === 0;
    s.fire('ag:portrait', last);
    const now = w.a.portraitOf(s.id);
    if (now !== prev) changes++;
    prev = now;
  }
  assert.ok(changes <= 5, 'changes ' + changes);
  w.advance(GAP);
  assert.strictEqual(w.a.portraitOf(s.id), last);
  assert.strictEqual(w.a.portraitState.size, 1, 'one entry per socket, however many reports');
});

test('ag:portrait: kept across ag:leave and a Play, dropped on disconnect; other sockets keep their own', () => {
  const w = world();
  const s = sock(w);
  s.fire('ag:portrait', true);
  s.fire('ag:join', { name: 'Owen' });
  assert.deepStrictEqual(boxHalf(w, s), [HALF_H, HALF_W]);
  s.fire('ag:leave');
  assert.strictEqual(w.a.portraitOf(s.id), true, 'kept while the socket is connected');
  s.fire('ag:join', { name: 'Owen' });
  assert.deepStrictEqual(boxHalf(w, s), [HALF_H, HALF_W], 'the next seat uses it');
  // Another socket in the same room is not affected.
  const t = sock(w);
  assert.deepStrictEqual(boxHalf(w, t), [HALF_W, HALF_H]);
  s.fire('disconnect', 'transport close');
  assert.strictEqual(w.a.portraitState.has(s.id), false);
  assert.strictEqual(w.a.portraitOf(s.id), false);
});
