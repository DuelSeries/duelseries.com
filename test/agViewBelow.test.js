'use strict';
// The ghost strip's view report (Owen 2026-10-08, "size as if the strip were there"): our page draws map under the
// reference view and reports it on ag:view { below } (world units at zoom 1). This file follows it from the socket
// handler through the directory and the room to the view box: only the box bottom moves, by min(below, cap) / s
// (law VIEW_BELOW, CHOSEN), a bad report never reaches the view, and nothing changes for a page that sends none.
// Run on the FIXTURE law table (L4 pad 100, so the half height at s = 1 is 590); VIEW_BELOW is copied from the real
// table.
const test = require('node:test');
const assert = require('node:assert');
const V = require('../server/ag/agView');
const L = require('../server/ag/agLaws');
const { AgArenas } = require('../server/ag/agArenas');
const { AgRoom } = require('../server/ag/agRoom');
const { attachAgSockets } = require('../server/ag/agSockets');
const { FIXTURE, makeFixture } = require('./agLawsFixture');

const quiet = { error() {}, warn() {}, log() {} };
const L4 = FIXTURE.L4.value;
const HALF_H = (L4.baseH + L4.pad) / 2;          // 590 at s = 1
const CAP = FIXTURE.VIEW_BELOW.value.cap;
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

test('law VIEW_BELOW: CHOSEN, cap 180 (90 / 0.5), read by the view', () => {
  const e = L.LAWS.VIEW_BELOW;
  assert.strictEqual(e.status, 'CHOSEN');
  assert.deepStrictEqual(e.value, { cap: 180 });
  assert.strictEqual(e.value.cap, 90 / 0.5);
  assert.match(e.source, /CHOSEN/);
  assert.ok(V.VIEW_LAW_IDS.includes('VIEW_BELOW'));
  assert.doesNotThrow(() => V.createViewer(1, { laws: L.LAWS }));
  assert.throws(() => V.createViewer(1, { laws: L.withValues(FIXTURE, { VIEW_BELOW: null }) }), /VIEW_BELOW/);
  assert.throws(() => V.createViewer(1, { laws: makeFixture({ VIEW_BELOW: { cap: -1 } }) }), /VIEW_BELOW/);
  assert.throws(() => V.createViewer(1, { laws: makeFixture({ VIEW_BELOW: { cap: NaN } }) }), /VIEW_BELOW/);
  assert.throws(() => V.createViewer(1, { laws: makeFixture({ VIEW_BELOW: 180 }) }), /VIEW_BELOW/);
});

test('viewBoxFor: below moves only the bottom edge, by below / s', () => {
  for (const s of [1, 0.6, 0.25]) {
    const base = V.viewBoxFor(10, 20, s, L4);
    assert.deepStrictEqual(V.viewBoxFor(10, 20, s, L4, 0), base);
    assert.deepStrictEqual(V.viewBoxFor(10, 20, s, L4, -50), base, 'never shrinks');
    const b = V.viewBoxFor(10, 20, s, L4, 102);
    assert.deepStrictEqual(b, Object.assign({}, base, { maxY: base.maxY + 102 / s }));
  }
});

test('viewer: extra.below extends the box bottom up to the cap; cells in that band are sent only with it', () => {
  const cells = [player(1, 7, 0, 0, 32), food(100, 0, HALF_H + 60), food(101, 0, HALF_H + 150),
    food(102, 0, HALF_H + CAP + 40), food(103, 0, -HALF_H - 60), food(104, 1200, HALF_H + 60)];
  const plain = V.createViewer(7, { laws: FIXTURE });
  assert.deepStrictEqual(sentIds(plain.build(frame(cells))), [1]);
  assert.strictEqual(plain.box().maxY, HALF_H);

  const v = V.createViewer(7, { laws: FIXTURE });
  assert.deepStrictEqual(sentIds(v.build(frame(cells), { below: 102 })), [1, 100], '60 below the old edge is in');
  assert.strictEqual(v.box().maxY, HALF_H + 102);
  assert.strictEqual(v.box().minY, -HALF_H, 'top unchanged');
  // A report past the cap counts as the cap.
  v.build(frame(cells), { below: 5000 });
  assert.strictEqual(v.box().maxY, HALF_H + CAP);
  assert.ok(v.isKnown(101) && !v.isKnown(102) && !v.isKnown(103) && !v.isKnown(104));
  // Back to 0: the band's cells leave the view like any other.
  const recs = v.build(frame(cells), {});
  assert.strictEqual(v.box().maxY, HALF_H);
  assert.ok(recs.some((r) => r.t === 'world' && r.removed.includes(100) && r.removed.includes(101)));
});

test('viewer: the band scales with the view (a bigger player, s below 1)', () => {
  const sum = 400;
  const s = V.scaleFor(sum, L4);
  assert.ok(s < 1);
  const v = V.createViewer(7, { laws: FIXTURE });
  v.build(frame([player(1, 7, 0, 0, sum)]), { below: 102 });
  assert.ok(Math.abs(v.box().maxY - (HALF_H / s + 102 / s)) < 1e-9);
});

test('viewer: a bad below throws before anything is counted as sent', () => {
  const v = V.createViewer(7, { laws: FIXTURE });
  for (const bad of [-1, NaN, Infinity, '10', null, {}]) {
    assert.throws(() => v.build(frame([player(1, 7, 0, 0, 32)]), { below: bad }), /below/);
  }
  const recs = v.build(frame([player(1, 7, 0, 0, 32)]));
  assert.strictEqual(recs[0].t, 'hello', 'the join order still starts at hello');
});

test('room: each seat\'s build gets its own report through viewBelowOf', () => {
  const reports = new Map([['a', 102], ['b', 0]]);
  const r = new AgRoom({ laws: FIXTURE, shippableOnly: false, seed: 7, autoTick: false, log: quiet,
    viewBelowOf: (id) => reports.get(id) || 0 });
  const sock = (id) => ({ id, conn: { writeBuffer: [] }, emit() {} });
  r.addSocket(sock('a'));
  r.addSocket(sock('b'));
  r.tickOnce();
  const a = r.seatOf('a').viewer.box(), b = r.seatOf('b').viewer.box();
  assert.strictEqual(a.maxY - a.cy, HALF_H + 102);
  assert.strictEqual(b.maxY - b.cy, HALF_H);
  reports.set('a', 7);
  r.tickOnce();
  assert.strictEqual(r.seatOf('a').viewer.box().maxY - r.seatOf('a').viewer.box().cy, HALF_H + 7);
  r.stop();
  // A room made without one (tests, tools) sends the plain L4 box.
  const plain = new AgRoom({ laws: FIXTURE, shippableOnly: false, seed: 7, autoTick: false, log: quiet });
  plain.addSocket(sock('c'));
  plain.tickOnce();
  assert.strictEqual(plain.seatOf('c').viewer.box().maxY - plain.seatOf('c').viewer.box().cy, HALF_H);
  plain.stop();
});

function world(opts) {
  const a = new AgArenas({ laws: FIXTURE, shippableOnly: false, autoTick: false, seed: 3, log: quiet });
  const rl = [];
  const socketRL = (opts && opts.socketRL) || ((socket, key, ms) => { rl.push(key); return true; });
  const sanitizeName = (n) => (typeof n === 'string' ? n.replace(/[<>]/g, '').trim().slice(0, 20) : '') || 'Player';
  const handlers = attachAgSockets(null, a, { socketRL, sanitizeName, log: quiet });
  return { a, handlers, rl };
}
let sn = 0;
function sock(w) {
  ++sn;
  const s = {
    id: 'vb' + sn,
    handshake: { address: '10.9.' + (sn >> 8) + '.' + (sn & 255), headers: {} },
    conn: { writeBuffer: [] },
    handlers: {},
    on(ev, fn) { this.handlers[ev] = fn; },
    emit() {},
    fire(ev, ...args) { this.handlers[ev](...args); },
  };
  w.handlers.attach(s);
  return s;
}
function bottom(w, s) {
  const room = w.a.roomOfSocket(s.id);
  room.tickOnce();
  const box = room.seatOf(s.id).viewer.box();
  return box.maxY - box.cy;
}

test('ag:view: whole numbers 0 or more reach the box; every other shape is ignored; never rate limited', () => {
  const w = world();
  const s = sock(w);
  assert.strictEqual(bottom(w, s), HALF_H);
  s.fire('ag:view', { below: 102 });
  assert.strictEqual(w.a.viewBelow.get(s.id), 102);
  assert.strictEqual(bottom(w, s), HALF_H + 102);
  for (const bad of [undefined, null, 5, 'x', [], { below: -1 }, { below: 1.5 }, { below: '50' }, { below: NaN },
    { below: Infinity }, { below: 2 ** 31 }, { below: null }, {}, new Uint8Array(4)]) {
    s.fire('ag:view', bad, () => {});
    assert.strictEqual(w.a.viewBelow.get(s.id), 102, JSON.stringify(bad));
  }
  s.fire('ag:view', { below: 5000 });
  assert.strictEqual(bottom(w, s), HALF_H + CAP, 'capped by the view');
  s.fire('ag:view', { below: 0 });
  assert.strictEqual(w.a.viewBelow.has(s.id), false, '0 keeps nothing');
  assert.strictEqual(bottom(w, s), HALF_H);
  assert.deepStrictEqual(w.rl.filter((k) => /view/.test(k)), [], 'no socketRL key for ag:view');
  // With the server's real limiter in place, a burst of reports (one polling packet) still leaves the last standing.
  const realRL = (socket, key, ms) => {
    const now = Date.now();
    socket._rl = socket._rl || {};
    if (socket._rl[key] && now - socket._rl[key] < ms) return false;
    socket._rl[key] = now;
    return true;
  };
  const w2 = world({ socketRL: realRL });
  const s2 = sock(w2);
  for (let i = 1; i <= 20; i++) s2.fire('ag:view', { below: i });
  assert.strictEqual(w2.a.viewBelow.get(s2.id), 20);
});

test('ag:view: kept across ag:leave and a Play, dropped on disconnect', () => {
  const w = world();
  const s = sock(w);
  s.fire('ag:view', { below: 116 });
  s.fire('ag:join', { name: 'Owen' });
  assert.strictEqual(bottom(w, s), HALF_H + 116);
  s.fire('ag:leave');
  assert.strictEqual(w.a.roomOfSocket(s.id), null);
  assert.strictEqual(w.a.viewBelow.get(s.id), 116, 'kept while the socket is connected');
  s.fire('ag:join', { name: 'Owen' });
  assert.strictEqual(bottom(w, s), HALF_H + 116, 'the next seat uses it');
  s.fire('disconnect', 'transport close');
  assert.strictEqual(w.a.viewBelow.has(s.id), false);
  assert.strictEqual(w.a.view(42, 10), false, 'a socket id is a string');
});
