'use strict';
// Server view (build brief 9.1 and the 9.2 agView card; protocol semantics 2, 3.8, 13; server law L4), run on the
// FIXTURE law table: L4 { baseW 1920, baseH 1080, pad 100, ref 64, exp 0.4, minScale 0.15 }, U_ROUND 'nearest',
// U_EAT_REMOVE 'sameBundle', L37 15. A small model of their client's stream rules (protocol semantics 3) checks
// that what the client ends up holding is exactly the player's view, through the real wire bytes.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const V = require('../server/ag/agView');
const agWire = require('../shared/agWire');
const { withValues } = require('../server/ag/agLaws');
const { createRng } = require('../server/ag/agRng');
const { FIXTURE, makeFixture } = require('./agLawsFixture');

const L4 = FIXTURE.L4.value;
const BORDER = { minX: -7000, minY: -7000, maxX: 7000, maxY: 7000 };
const HALF_W = (L4.baseW + L4.pad) / 1 / 2;    // 1010 at s = 1
const HALF_H = (L4.baseH + L4.pad) / 1 / 2;    // 590 at s = 1

function player(id, owner, x, y, size, extra) {
  return Object.assign({ id, owner, kind: 'player', x, y, size, rgb: [255, 7, 100], name: 'p' + owner }, extra);
}
function food(id, x, y, size) {
  return { id, kind: 'food', x, y, size: size || 10, rgb: [7, 255, 40] };
}
function frame(cells, extra) {
  return V.makeFrame(Object.assign({ border: BORDER, cells }, extra), FIXTURE);
}
function worldOf(records) {
  const w = records.filter((r) => r.t === 'world' || r.t === 'sync');
  return w[w.length - 1];
}
function cellIn(records, id) {
  for (const r of records) {
    if (r.t !== 'world' && r.t !== 'sync') continue;
    const c = r.cells.find((x) => x.id === id);
    if (c) return c;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Card numbers.

test('a food pellet one unit past the view edge is not sent; one inside is sent once, then only on change', () => {
  const v = V.createViewer(1, { laws: FIXTURE });
  // Player 1 has one cell of size 64 at the origin: s = 1, the box is +-1010 by +-590.
  const me = player(10, 1, 0, 0, 64);
  const out = food(20, HALF_W + 10 + 1, 0, 10);      // nearest edge at 1011
  const touch = food(21, 0, HALF_H + 10, 10);        // nearest edge exactly on the box edge
  const inside = food(22, 500, 200, 10);
  let recs = v.build(frame([me, out, touch, inside]));
  assert.deepStrictEqual(v.box(), { minX: -1010, minY: -590, maxX: 1010, maxY: 590, cx: 0, cy: 0, scale: 1 });
  assert.strictEqual(cellIn(recs, 20), null, 'one unit past the edge is not sent');
  assert.ok(cellIn(recs, 21), 'touching the edge is in view');
  const first = cellIn(recs, 22);
  assert.deepStrictEqual(first, { id: 22, x: 500, y: 200, size: 10, virus: false, food: true, ejected: false,
    agitated: false, flag40: false, party: false, rgb: [7, 255, 40] });
  const mine = cellIn(recs, 10);
  assert.deepStrictEqual(mine.rgb, [255, 7, 100]);
  assert.strictEqual(mine.name, 'p1', 'a named cell carries its name on its first record');

  // Nothing changed: an empty world record, still one per tick.
  recs = v.build(frame([me, out, touch, inside]));
  assert.deepStrictEqual(recs, [{ t: 'world', eats: [], cells: [], removed: [] }]);

  // A move that rounds to the same integers is not sent; a real move is sent without colour or name.
  recs = v.build(frame([me, out, touch, food(22, 500.4, 199.6, 10.2)]));
  assert.deepStrictEqual(worldOf(recs).cells, []);
  recs = v.build(frame([player(10, 1, 3, 0, 64), out, touch, food(22, 501, 200, 10)]));
  assert.deepStrictEqual(cellIn(recs, 22), { id: 22, x: 501, y: 200, size: 10, virus: false, food: true,
    ejected: false, agitated: false, flag40: false, party: false });
  assert.deepStrictEqual(Object.keys(cellIn(recs, 10)).sort(), ['agitated', 'ejected', 'flag40', 'food', 'id',
    'party', 'size', 'virus', 'x', 'y']);

  // Colour change sends rgb only; name change sends the name only; an empty name is never sent.
  recs = v.build(frame([player(10, 1, 3, 0, 64, { rgb: [255, 7, 9] }), out, touch, food(22, 501, 200, 10)]));
  assert.deepStrictEqual(cellIn(recs, 10).rgb, [255, 7, 9]);
  assert.strictEqual(cellIn(recs, 10).name, undefined);
  recs = v.build(frame([player(10, 1, 3, 0, 64, { rgb: [255, 7, 9], name: 'zed' }), out, touch,
    food(22, 501, 200, 10)]));
  assert.strictEqual(cellIn(recs, 10).name, 'zed');
  assert.strictEqual(cellIn(recs, 10).rgb, undefined);
  recs = v.build(frame([player(10, 1, 3, 0, 64, { rgb: [255, 7, 9], name: '' }), out, touch,
    food(22, 501, 200, 10)]));
  assert.deepStrictEqual(worldOf(recs).cells, [], 'an empty name cannot clear one, so nothing is sent');
});

test('a cell leaving the view is removed, and comes back as a full first record', () => {
  const v = V.createViewer(1, { laws: FIXTURE });
  const me = player(10, 1, 0, 0, 64);
  let recs = v.build(frame([me, player(30, 2, 900, 0, 50)]));
  assert.ok(cellIn(recs, 30));
  recs = v.build(frame([me, player(30, 2, 1100, 0, 50)]));      // nearest edge 1050, past 1010
  assert.deepStrictEqual(worldOf(recs).removed, [30]);
  assert.strictEqual(v.isKnown(30), false);
  recs = v.build(frame([me, player(30, 2, 1000, 0, 50)]));
  assert.deepStrictEqual(cellIn(recs, 30).rgb, [255, 7, 100]);
  assert.strictEqual(cellIn(recs, 30).name, 'p2');
});

test('join order: hello, border with the FFA mode, a world, then own ids before the world that carries them', () => {
  // Spawning on the very first bundle still puts a world record before the own id.
  const v = V.createViewer(1, { laws: FIXTURE });
  const recs = v.build(frame([player(10, 1, 0, 0, 32), food(22, 5, 5)]));
  assert.deepStrictEqual(recs.map((r) => r.t), ['hello', 'border', 'world', 'own', 'world']);
  assert.deepStrictEqual(recs[1], { t: 'border', minX: -7000, minY: -7000, maxX: 7000, maxY: 7000, mode: 0 });
  assert.deepStrictEqual(recs[2], { t: 'world', eats: [], cells: [], removed: [] });
  assert.deepStrictEqual(recs[3], { t: 'own', id: 10 });
  assert.ok(cellIn([recs[4]], 10));

  // The usual case: connect first (pre-spawn world), spawn later; the own id comes in the spawn bundle, before its
  // world record, and only once.
  const w = V.createViewer(1, { laws: FIXTURE });
  let r = w.build(frame([food(22, 5, 5)]));
  assert.deepStrictEqual(r.map((x) => x.t), ['hello', 'border', 'world']);
  r = w.build(frame([food(22, 5, 5)]));
  assert.deepStrictEqual(r.map((x) => x.t), ['world']);
  r = w.build(frame([food(22, 5, 5), player(11, 1, 50, 60, 32)]));
  assert.deepStrictEqual(r.map((x) => x.t), ['own', 'world']);
  assert.strictEqual(r[0].id, 11);
  r = w.build(frame([food(22, 5, 5), player(11, 1, 52, 60, 32)]));
  assert.deepStrictEqual(r.map((x) => x.t), ['world'], 'never announced twice');
  // A split: the new own cell is announced in the same bundle, before the world record.
  r = w.build(frame([food(22, 5, 5), player(11, 1, 52, 60, 22), player(12, 1, 90, 60, 22)]));
  assert.deepStrictEqual(r.map((x) => x.t), ['own', 'world']);
  assert.strictEqual(r[0].id, 12);
});

test('colour is always on the first record, even for cells first seen long after they were made', () => {
  const v = V.createViewer(1, { laws: FIXTURE });
  v.build(frame([player(10, 1, 0, 0, 64)]));
  for (let t = 0; t < 5; t++) v.build(frame([player(10, 1, t * 400, 0, 64), food(500, 3000, 0)]));
  const recs = v.build(frame([player(10, 1, 2400, 0, 64), food(500, 3000, 0)]));
  assert.deepStrictEqual(cellIn(recs, 500).rgb, [7, 255, 40]);
  assert.throws(() => frame([{ id: 7, kind: 'food', x: 0, y: 0, size: 10 }]), /rgb/);
});

// ---------------------------------------------------------------------------------------------------------------
// Eats, removals, merges.

test('an eat is sent only when the client knows both cells; the eaten id is removed in the same bundle', () => {
  const v = V.createViewer(1, { laws: FIXTURE });
  v.build(frame([player(10, 1, 0, 0, 100), food(20, 50, 0), food(21, 900, 0), player(30, 2, 300, 0, 80)]));
  // 10 eats 20 (both known), 40 (unknown) eats 21 (known), 10 eats 99 (unknown eaten).
  const recs = v.build(frame([player(10, 1, 0, 0, 101), player(30, 2, 300, 0, 80),
    player(40, 3, 2000, 0, 200)], { eats: [[10, 20], [40, 21], [10, 99]], removed: [20, 21, 99] }));
  const w = worldOf(recs);
  assert.deepStrictEqual(w.eats, [[10, 20]]);
  assert.deepStrictEqual(w.removed.slice().sort((a, b) => a - b), [20, 21]);
  assert.ok(!w.cells.some((c) => c.id === 20 || c.id === 21));
});

test('a merge passes through as an eat between two own cells, and the eaten own id is removed', () => {
  const v = V.createViewer(1, { laws: FIXTURE });
  v.build(frame([player(10, 1, 0, 0, 50), player(11, 1, 30, 0, 50)]));
  assert.ok(v.isAnnounced(10) && v.isAnnounced(11));
  const recs = v.build(frame([player(10, 1, 10, 0, 70.71)], { eats: [[10, 11]], removed: [11] }));
  const w = worldOf(recs);
  assert.deepStrictEqual(w.eats, [[10, 11]]);
  assert.deepStrictEqual(w.removed, [11]);
  assert.strictEqual(cellIn(recs, 10).size, 71);
  assert.strictEqual(v.isAnnounced(11), false);
});

test('an eaten id still listed by the sim is removed anyway and not re-sent in that bundle', () => {
  const v = V.createViewer(1, { laws: FIXTURE });
  v.build(frame([player(10, 1, 0, 0, 100), food(20, 50, 0)]));
  const recs = v.build(frame([player(10, 1, 0, 0, 100), food(20, 60, 0)], { eats: [[10, 20], [10, 20]] }));
  assert.deepStrictEqual(worldOf(recs).eats, [[10, 20]], 'a repeated eat is sent once');
  assert.deepStrictEqual(worldOf(recs).removed, [20]);
  assert.strictEqual(cellIn(recs, 20), null);
});

test('death: removing the last own cell; then the view stays where the player died, or follows a focus', () => {
  const v = V.createViewer(1, { laws: FIXTURE });
  v.build(frame([player(10, 1, 3000, 2000, 128)]));
  const s128 = Math.max(Math.pow(64 / 128, 0.4), 0.15);
  assert.strictEqual(v.box().scale, s128);
  assert.strictEqual(s128, 0.757858283255199);
  let recs = v.build(frame([player(50, 2, 3000, 2100, 300)], { eats: [[50, 10]], removed: [10] }));
  assert.deepStrictEqual(worldOf(recs).removed, [10]);
  assert.deepStrictEqual(worldOf(recs).eats, []);           // the eater was not known yet
  assert.ok(cellIn(recs, 50));
  recs = v.build(frame([player(50, 2, 3000, 2100, 300)]));
  assert.strictEqual(v.box().cx, 3000);
  assert.strictEqual(v.box().cy, 2000);
  assert.strictEqual(v.box().scale, s128, 'stays where it died');
  // A spectate focus from the room: centre and scale follow it, and a cam record goes out.
  recs = v.build(frame([player(50, 2, 3000, 2100, 300)]), { focus: { x: -100, y: 50, zoom: 0.5 } });
  assert.deepStrictEqual(recs[recs.length - 1], { t: 'cam', x: -100, y: 50, zoom: 0.5 });
  assert.deepStrictEqual(worldOf(recs).removed, [50]);
  assert.strictEqual(v.box().scale, 0.5);
  assert.strictEqual(v.box().maxX, -100 + 1010 / 0.5);
  recs = v.build(frame([]), { focus: { x: 0, y: 0, zoom: 0.01 } });
  assert.strictEqual(v.box().scale, 0.15, 'a focus zoom is held to the L4 minScale');
  // Respawn: a fresh id is announced again.
  recs = v.build(frame([player(60, 1, 0, 0, 32)]));
  assert.deepStrictEqual(recs.map((r) => r.t), ['own', 'world']);
});

test('the border is sent with the mode once, then without the mode only when it changes', () => {
  const v = V.createViewer(1, { laws: FIXTURE });
  v.build(frame([]));
  let recs = v.build(frame([]));
  assert.ok(!recs.some((r) => r.t === 'border'));
  const b2 = { minX: -6990.5, minY: -6990.5, maxX: 6990.5, maxY: 6990.5 };
  recs = v.build(V.makeFrame({ border: b2, cells: [] }, FIXTURE));
  assert.deepStrictEqual(recs[0], Object.assign({ t: 'border' }, b2));
  recs = v.build(V.makeFrame({ border: Object.assign({}, b2), cells: [] }, FIXTURE));
  assert.ok(!recs.some((r) => r.t === 'border'));
});

test('a deleted id reused in the same tick is removed and then sent as a new node in a second world record', () => {
  const v = V.createViewer(1, { laws: FIXTURE });
  v.build(frame([player(10, 1, 0, 0, 64), food(20, 50, 0)]));
  const recs = v.build(frame([player(10, 1, 0, 0, 64), food(20, -300, 40, 12)], { removed: [20] }));
  assert.deepStrictEqual(recs.map((r) => r.t), ['world', 'world']);
  assert.deepStrictEqual(recs[0].removed, [20]);
  assert.deepStrictEqual(recs[1].cells, [{ id: 20, x: -300, y: 40, size: 12, virus: false, food: true,
    ejected: false, agitated: false, flag40: false, party: false, rgb: [7, 255, 40] }]);
  // Own id reused: removed (which also drops it from the client's own-id list), announced again, then sent.
  const recs2 = v.build(frame([player(10, 1, 9, 0, 64), food(20, -300, 40, 12)], { removed: [10] }));
  assert.deepStrictEqual(recs2.map((r) => r.t), ['world', 'own', 'world']);
  assert.deepStrictEqual(recs2[0].removed, [10]);
});

test('own cells are always sent, even outside the view box', () => {
  const v = V.createViewer(1, { laws: FIXTURE });
  const recs = v.build(frame([player(10, 1, -5000, 0, 40), player(11, 1, 5000, 0, 40)]));
  assert.ok(cellIn(recs, 10) && cellIn(recs, 11));
  assert.deepStrictEqual(recs.filter((r) => r.t === 'own').map((r) => r.id), [10, 11]);
});

test('flags: kinds map to wire bits, and WIRE_FLAGS gates the CHOSEN ones', () => {
  const v = V.createViewer(1, { laws: FIXTURE });
  const recs = v.build(frame([
    { id: 5, kind: 'virus', x: 0, y: 0, size: 100, rgb: [51, 255, 51] },
    { id: 6, kind: 'ejected', x: 10, y: 0, size: 36.06, rgb: [255, 7, 9], owner: 2, agitated: true, party: true },
  ]));
  assert.strictEqual(cellIn(recs, 5).virus, true);
  assert.strictEqual(cellIn(recs, 6).ejected, true);
  assert.strictEqual(cellIn(recs, 6).agitated, false, 'WIRE_FLAGS agitated false');
  assert.strictEqual(cellIn(recs, 6).party, false, 'WIRE_FLAGS party false');
  const t = makeFixture({ WIRE_FLAGS: { agitated: true, ejectedOnBlobs: false, flag40: true, party: true } });
  const w = V.createViewer(1, { laws: t });
  const r2 = w.build(V.makeFrame({ border: BORDER, cells: [
    { id: 6, kind: 'ejected', x: 10, y: 0, size: 36, rgb: [1, 2, 3], agitated: true, flag40: true, party: true },
  ] }, t));
  assert.deepStrictEqual(cellIn(r2, 6), { id: 6, x: 10, y: 0, size: 36, virus: false, food: false, ejected: false,
    agitated: true, flag40: true, party: true, rgb: [1, 2, 3] });
  // A flag change alone is a change on the wire.
  const r3 = w.build(V.makeFrame({ border: BORDER, cells: [
    { id: 6, kind: 'ejected', x: 10, y: 0, size: 36, rgb: [1, 2, 3], agitated: false, flag40: true, party: true },
  ] }, t));
  assert.strictEqual(cellIn(r3, 6).agitated, false);
});

test('view scale follows L4: sums of 64 or less give 1, 128 gives 0.7578..., huge sums stop at minScale', () => {
  assert.strictEqual(V.scaleFor(0, L4), 1);
  assert.strictEqual(V.scaleFor(32, L4), 1);
  assert.strictEqual(V.scaleFor(64, L4), 1);
  assert.strictEqual(V.scaleFor(128, L4), 0.757858283255199);
  assert.strictEqual(V.scaleFor(1000, L4), 0.33302128296074923);
  assert.strictEqual(V.scaleFor(1e7, L4), 0.15);
  const b = V.viewBoxFor(0, 0, V.scaleFor(128, L4), L4);
  assert.strictEqual(b.maxX, 2020 / V.scaleFor(128, L4) / 2);
  assert.strictEqual(b.maxY, 1180 / V.scaleFor(128, L4) / 2);
  // The view covers the least the client can show (1920/z by 1080/z) whenever s equals the client zoom target.
  for (const sum of [32, 64, 100, 200, 400, 800, 1600, 3200]) {
    const s = V.scaleFor(sum, L4);
    const z = Math.pow(Math.min(64 / sum, 1), 0.4);
    if (s === z) {
      const box = V.viewBoxFor(0, 0, s, L4);
      assert.ok(box.maxX * 2 >= 1920 / z && box.maxY * 2 >= 1080 / z);
    }
  }
  // Before any spawn the view is the border centre at s = 1.
  const v = V.createViewer(1, { laws: FIXTURE });
  v.build(V.makeFrame({ border: { minX: 0, minY: 0, maxX: 2000, maxY: 1000 }, cells: [] }, FIXTURE));
  assert.deepStrictEqual(v.box(), { minX: 1000 - 1010, minY: 500 - 590, maxX: 1000 + 1010, maxY: 500 + 590,
    cx: 1000, cy: 500, scale: 1 });
});

// ---------------------------------------------------------------------------------------------------------------
// Laws: nothing runs on an unapproved row, and the approved rules are the ones used.

test('creation refuses UNKNOWN or unsupported laws', () => {
  for (const id of V.VIEW_LAW_IDS) {
    assert.throws(() => V.createViewer(1, { laws: withValues(FIXTURE, { [id]: null }) }), new RegExp(id));
  }
  assert.throws(() => V.makeFrame({ border: BORDER, cells: [] }, withValues(FIXTURE, { U_ROUND: null })),
    /U_ROUND/);
  assert.throws(() => V.createViewer(1, { laws: makeFixture({ U_EAT_REMOVE: 'later' }) }), /U_EAT_REMOVE/);
  assert.throws(() => V.createViewer(1, { laws: makeFixture({ U_ROUND: 'bankers' }) }), /U_ROUND/);
  assert.throws(() => V.createViewer(1, { laws: makeFixture({ L4: Object.assign({}, L4, { pad: -1 }) }) }),
    /K_VIEW_FLOOR/);
  assert.throws(() => V.createViewer(1, { laws: makeFixture({ L37: -1 }) }), /maxNameBytes/);
  assert.throws(() => V.createViewer(undefined, { laws: FIXTURE }), TypeError);
  // The real table has L4 UNKNOWN, so the server cannot build a view on it.
  const { LAWS } = require('../server/ag/agLaws');
  assert.throws(() => V.createViewer(1, { laws: LAWS }), /L4/);
});

test('rounding follows U_ROUND', () => {
  const cells = [food(1, 2.5, -2.5, 10.5), food(2, -0.4, 0.6, 9.49)];
  const pick = (rule) => {
    const t = makeFixture({ U_ROUND: rule });
    const r = V.createViewer(9, { laws: t }).build(V.makeFrame({ border: BORDER, cells }, t));
    return [1, 2].map((id) => { const c = cellIn(r, id); return [c.x, c.y, c.size]; });
  };
  assert.deepStrictEqual(pick('nearest'), [[3, -2, 11], [0, 1, 9]]);
  assert.deepStrictEqual(pick('floor'), [[2, -3, 10], [-1, 0, 9]]);
  assert.deepStrictEqual(pick('trunc'), [[2, -2, 10], [0, 0, 9]]);
  assert.ok(Object.is(pick('nearest')[1][0], 0), 'no -0 on the wire');
});

test('names are capped at L37 bytes by the wire, and long names round-trip cut', () => {
  const v = V.createViewer(1, { laws: FIXTURE });
  const recs = v.build(frame([player(10, 2, 0, 0, 40, { name: 'abcdefghijklmnopqrstuvwxyz' })]));
  const back = agWire.decodeBundle(v.encode(recs));
  const c = back.find((r) => r.t === 'world' && r.cells.length).cells[0];
  assert.strictEqual(c.name, 'abcdefghijklmno');
  assert.strictEqual(Buffer.byteLength(c.name), FIXTURE.L37.value);
});

test('sync sends every visible cell in full, so a client that drops unlisted nodes ends up right', () => {
  const v = V.createViewer(1, { laws: FIXTURE });
  v.build(frame([player(10, 1, 0, 0, 64), food(20, 50, 0), player(30, 2, 300, 0, 50)]));
  v.resync();
  const recs = v.build(frame([player(10, 1, 0, 0, 64), food(20, 50, 0), player(30, 2, 300, 0, 50)]));
  const s = recs.find((r) => r.t === 'sync');
  assert.ok(s);
  assert.deepStrictEqual(s.cells.map((c) => c.id), [10, 20, 30]);
  assert.ok(s.cells.every((c) => Array.isArray(c.rgb)));
  assert.strictEqual(s.cells.find((c) => c.id === 30).name, 'p2');
  const next = v.build(frame([player(10, 1, 0, 0, 64), food(20, 50, 0), player(30, 2, 300, 0, 50)]));
  assert.deepStrictEqual(next, [{ t: 'world', eats: [], cells: [], removed: [] }]);
  assert.strictEqual(v.build(frame([]), { sync: true }).find((r) => r.t === 'sync').removed.length, 3);
});

test('board rows pass through after the world record', () => {
  const v = V.createViewer(1, { laws: FIXTURE });
  const recs = v.build(frame([]), { board: [{ name: 'a' }, { me: true }] });
  assert.deepStrictEqual(recs[recs.length - 1], { t: 'board', rows: [{ name: 'a' }, { me: true }] });
});

test('frames reject bad sim output loudly', () => {
  assert.throws(() => frame([food(1, 0, 0), food(1, 5, 5)]), /twice/);
  assert.throws(() => frame([food(0, 0, 0)]), /id/);
  assert.throws(() => frame([food(3, NaN, 0)]), /finite/);
  assert.throws(() => frame([{ id: 3, kind: 'blob', x: 0, y: 0, size: 1, rgb: [0, 0, 0] }]), /kind/);
  assert.throws(() => frame([{ id: 3, x: 0, y: 0, size: 1, rgb: [0, 0, 256] }]), /colour/);
  assert.throws(() => frame([], { eats: [[1]] }), /eat/);
  assert.throws(() => V.makeFrame({ cells: [] }, FIXTURE), /border/);
  const v = V.createViewer(1, { laws: FIXTURE });
  assert.throws(() => v.build({ border: BORDER, cells: [] }), /makeFrame/);
  assert.throws(() => v.build(frame([]), { focus: { x: 0, y: 0, zoom: 0 } }), /zoom/);
});

// ---------------------------------------------------------------------------------------------------------------
// A model of their client's stream rules (protocol semantics 3.2 to 3.6, 4; build brief section 8 for sync),
// fed the real bytes.

function makeClient() {
  const c = { nodes: new Map(), ownIds: [], ownNodes: new Set(), worlds: 0, hello: false, border: null, mode: null,
    skippedEats: 0, appliedEats: [], errors: [] };
  c.apply = function (bytes) {
    for (const rec of agWire.decodeBundle(bytes)) {
      switch (rec.t) {
        case 'error': c.errors.push(rec); break;
        case 'hello': c.hello = true; break;
        case 'border':
          c.border = rec;
          if (rec.mode !== undefined) c.mode = rec.mode;
          break;
        case 'own':
          if (!c.worlds) c.errors.push('own before any world');
          c.ownIds.push(rec.id);
          break;
        case 'cam': c.cam = rec; break;
        case 'board': c.board = rec.rows; break;
        case 'world':
        case 'sync': {
          c.worlds++;
          for (const [a, b] of rec.eats) {
            if (c.nodes.has(a) && c.nodes.has(b)) c.appliedEats.push([a, b]); else c.skippedEats++;
          }
          const listed = new Set();
          for (const cell of rec.cells) {
            listed.add(cell.id);
            let n = c.nodes.get(cell.id);
            if (!n) { n = { rgb: [0, 0, 0], name: '' }; c.nodes.set(cell.id, n); }
            Object.assign(n, { x: cell.x, y: cell.y, size: cell.size, virus: cell.virus, food: cell.food,
              ejected: cell.ejected, agitated: cell.agitated, flag40: cell.flag40, party: cell.party });
            if (cell.rgb) n.rgb = cell.rgb;
            if (cell.name && !c.ownIds.includes(cell.id)) n.name = cell.name;
            if (c.ownIds.includes(cell.id)) c.ownNodes.add(cell.id);
          }
          const drop = (id) => {
            c.nodes.delete(id);
            if (c.ownNodes.delete(id)) c.ownIds = c.ownIds.filter((x) => x !== id);
          };
          for (const id of rec.removed) drop(id);
          if (rec.t === 'sync') for (const id of Array.from(c.nodes.keys())) if (!listed.has(id)) drop(id);
          break;
        }
        default: c.errors.push('unexpected ' + rec.t);
      }
    }
  };
  return c;
}

// A toy world driven by the seeded rng: players with 1 to 6 cells that move, split, merge, eat and die; food that
// is eaten and respawns; viruses; ejected blobs; colour and name changes; id reuse; a shrinking border.
function toyWorld(seed) {
  const rng = createRng(seed);
  const w = { cells: new Map(), nextId: 1, border: { minX: -4000, minY: -3000, maxX: 4000, maxY: 3000 } };
  const add = (c) => { c.id = c.id || w.nextId++; w.cells.set(c.id, c); return c; };
  const rnd = (lo, hi) => lo + rng() * (hi - lo);
  const colour = () => [255, 7, 8 + rng.int(247)];
  for (let i = 0; i < 300; i++) add({ kind: 'food', x: rnd(-4000, 4000), y: rnd(-3000, 3000), size: 10 + rng.int(11), rgb: colour() });
  for (let i = 0; i < 6; i++) add({ kind: 'virus', x: rnd(-3000, 3000), y: rnd(-2000, 2000), size: 100, rgb: [51, 255, 51] });
  const spawn = (owner) => add({ kind: 'player', owner, x: rnd(-1500, 1500), y: rnd(-1000, 1000), size: rnd(32, 150),
    rgb: colour(), name: 'n' + owner });
  for (let p = 1; p <= 5; p++) spawn(p);

  w.step = function () {
    const eats = [];
    const removed = [];
    const list = Array.from(w.cells.values());
    for (const c of list) {
      if (c.kind === 'player' || c.kind === 'ejected') { c.x += rnd(-40, 40); c.y += rnd(-40, 40); }
      if (c.kind === 'player' && rng.chance(0.05)) c.size = Math.max(10, c.size + rnd(-3, 6));
    }
    // Eats: a player cell eats something near it.
    for (let k = 0; k < 6; k++) {
      const eater = list[rng.int(list.length)];
      if (eater.kind !== 'player' || !w.cells.has(eater.id)) continue;
      let best = null;
      for (const o of w.cells.values()) {
        if (o === eater || o.kind === 'virus') continue;
        if (Math.hypot(o.x - eater.x, o.y - eater.y) < eater.size * 3 && o.size < eater.size) { best = o; break; }
      }
      if (!best) continue;
      eats.push([eater.id, best.id]);
      removed.push(best.id);
      w.cells.delete(best.id);
      eater.size = Math.sqrt(eater.size * eater.size + best.size * best.size);
    }
    // Splits and ejects.
    for (const c of Array.from(w.cells.values())) {
      if (c.kind !== 'player') continue;
      if (c.size > 60 && rng.chance(0.03)) {
        c.size /= Math.SQRT2;
        add({ kind: 'player', owner: c.owner, x: c.x + rnd(-80, 80), y: c.y + rnd(-80, 80), size: c.size,
          rgb: c.rgb, name: c.name });
      }
      if (c.size > 50 && rng.chance(0.02)) {
        add({ kind: 'ejected', owner: c.owner, x: c.x + 60, y: c.y, size: 36.06, rgb: c.rgb });
      }
    }
    // Merges (own-own eats).
    const byOwner = new Map();
    for (const c of w.cells.values()) if (c.kind === 'player') (byOwner.get(c.owner) || byOwner.set(c.owner, []).get(c.owner)).push(c);
    for (const [, cs] of byOwner) {
      if (cs.length > 1 && rng.chance(0.05)) {
        const [a, b] = cs;
        eats.push([a.id, b.id]);
        removed.push(b.id);
        w.cells.delete(b.id);
        a.size = Math.sqrt(a.size * a.size + b.size * b.size);
      }
    }
    // A kill now and then: every cell of one player is eaten by another player's cell.
    w.ticks = (w.ticks || 0) + 1;
    if (w.ticks % 25 === 0) {
      const victim = 1 + rng.int(5);
      const killer = Array.from(w.cells.values()).find((c) => c.kind === 'player' && c.owner !== victim);
      if (killer) {
        for (const c of Array.from(w.cells.values())) {
          if (c.kind !== 'player' || c.owner !== victim) continue;
          eats.push([killer.id, c.id]);
          removed.push(c.id);
          w.cells.delete(c.id);
        }
        byOwner.delete(victim);
      }
    }
    // Deaths and respawns.
    for (let p = 1; p <= 5; p++) if (!byOwner.has(p) && rng.chance(0.2)) spawn(p);
    // Food respawn, colour and name changes, id reuse, border shrink.
    while (Array.from(w.cells.values()).filter((c) => c.kind === 'food').length < 300) {
      add({ kind: 'food', x: rnd(-4000, 4000), y: rnd(-3000, 3000), size: 10, rgb: colour() });
    }
    if (rng.chance(0.1)) { const cs = Array.from(w.cells.values()); cs[rng.int(cs.length)].rgb = colour(); }
    if (rng.chance(0.05)) { const ps = Array.from(w.cells.values()).filter((c) => c.kind === 'player'); if (ps.length) ps[0].name = 'r' + rng.int(1000); }
    if (rng.chance(0.2)) {
      const fs2 = Array.from(w.cells.values()).filter((c) => c.kind === 'food');
      const old = fs2[rng.int(fs2.length)];
      w.cells.delete(old.id);
      removed.push(old.id);
      add({ id: old.id, kind: 'food', x: rnd(-4000, 4000), y: rnd(-3000, 3000), size: 12, rgb: colour() });
    }
    if (rng.chance(0.05)) {
      w.border = { minX: w.border.minX + 7.25, minY: w.border.minY + 7.25, maxX: w.border.maxX - 7.25, maxY: w.border.maxY - 7.25 };
    }
    return { border: w.border, cells: Array.from(w.cells.values()), eats, removed };
  };
  return w;
}

function mine0(c, p) { return c.kind === 'player' && c.owner === p; }

// The view the client should hold, computed independently by a plain scan of every cell.
function expectedView(input, owner, box) {
  const out = new Map();
  for (const c of input.cells) {
    const touches = c.x - c.size <= box.maxX && c.x + c.size >= box.minX && c.y - c.size <= box.maxY &&
      c.y + c.size >= box.minY;
    if (touches || (c.kind === 'player' && c.owner === owner)) out.set(c.id, c);
  }
  return out;
}

test('a client following the stream holds exactly each player\'s view, tick after tick (3 viewers, 600 ticks)', () => {
  for (const seed of [7, 8]) {
    const world = toyWorld(seed);
    const viewers = [1, 2, 3].map((p) => ({ p, v: V.createViewer(p, { laws: FIXTURE }), c: makeClient() }));
    let merges = 0, reborns = 0, deaths = 0;
    for (let tick = 0; tick < 600; tick++) {
      const input = world.step();
      const f = V.makeFrame(input, FIXTURE);
      for (const x of viewers) {
        const knownBefore = new Set(x.c.nodes.keys());
        const ownBefore = x.c.ownNodes.size;
        const dead = !input.cells.some((c) => c.kind === 'player' && c.owner === x.p);
        const focus = dead && tick % 3 === 0 ? { x: 100, y: -50, zoom: 0.6 } : undefined;
        const recs = x.v.build(f, { focus });
        reborns += recs.filter((r) => r.t === 'world').length - 1 - (tick === 0 && recs.some((r) => r.t === 'own') ? 1 : 0);
        for (const r of recs) {
          if (r.t === 'world') merges += r.eats.filter(([a, b]) => x.c.ownNodes.has(a) && x.c.ownNodes.has(b)).length;
        }
        x.c.apply(x.v.encode(recs));
        assert.deepStrictEqual(x.c.errors, [], 'seed ' + seed + ' tick ' + tick);
        const want = expectedView(input, x.p, x.v.box());
        assert.deepStrictEqual(Array.from(x.c.nodes.keys()).sort((a, b) => a - b),
          Array.from(want.keys()).sort((a, b) => a - b), 'seed ' + seed + ' tick ' + tick + ' player ' + x.p);
        for (const [id, c] of want) {
          const n = x.c.nodes.get(id);
          assert.deepStrictEqual([n.x, n.y, n.size], [Math.round(c.x) + 0, Math.round(c.y) + 0, Math.round(c.size)]);
          assert.deepStrictEqual(n.rgb, c.rgb);
          assert.strictEqual(n.virus, c.kind === 'virus');
          assert.strictEqual(n.food, c.kind === 'food');
          assert.strictEqual(n.ejected, c.kind === 'ejected');
          if (!mine0(c, x.p) && c.name) assert.strictEqual(n.name, c.name);
        }
        const mine = input.cells.filter((c) => c.kind === 'player' && c.owner === x.p).map((c) => c.id).sort((a, b) => a - b);
        assert.deepStrictEqual(Array.from(x.c.ownNodes).sort((a, b) => a - b), mine, 'own cells');
        assert.strictEqual(new Set(x.c.ownIds).size, x.c.ownIds.length, 'no id announced twice');
        // Every eaten id the client knew is gone after this bundle, and every eat sent was applied.
        for (const [, eatenId] of input.eats) if (knownBefore.has(eatenId)) assert.ok(!x.c.nodes.has(eatenId));
        assert.strictEqual(x.c.skippedEats, 0);
        if (ownBefore > 0 && x.c.ownNodes.size === 0) deaths++;
        if (focus) assert.deepStrictEqual(x.c.cam, { t: 'cam', x: 100, y: -50, zoom: Math.fround(0.6) });
      }
    }
    const all = viewers.reduce((n, x) => n + x.c.appliedEats.length, 0);
    assert.ok(all > 50, 'eats exercised (' + all + ')');
    assert.ok(reborns > 0, 'id reuse exercised');
    assert.ok(deaths > 0, 'deaths exercised');
    assert.ok(merges > 0, 'merges exercised (' + merges + ')');
  }
});

test('the spatial index gives the same records as a plain scan, and two runs give the same bytes', () => {
  const run = () => {
    const world = toyWorld(11);
    const v = V.createViewer(2, { laws: FIXTURE });
    const out = [];
    for (let t = 0; t < 300; t++) out.push(Buffer.from(v.bundle(V.makeFrame(world.step(), FIXTURE))).toString('hex'));
    return out;
  };
  assert.deepStrictEqual(run(), run());

  // Big cells (spanning more than the index's span limit) and boxes that cover the whole index.
  const cells = [player(1, 7, 0, 0, 40000, { name: '' }), food(2, 9000, 9000), food(3, -20000, 300), food(4, 1e6, 1e6)];
  const v = V.createViewer(7, { laws: FIXTURE });
  const recs = v.build(frame(cells));
  const ids = worldOf(recs).cells.map((c) => c.id);
  const want = Array.from(expectedView({ cells }, 7, v.box()).keys()).sort((a, b) => a - b);
  assert.deepStrictEqual(ids, want);
});

test('hygiene: no reference citations, no fixture import, no randomness or clock in the shipped file', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'ag', 'agView.js'), 'utf8');
  assert.ok(!/\b[DW] \d{3,}/.test(src), 'no D/W line citations');
  assert.ok(!/agLawsFixture/.test(src));
  assert.ok(!/Math\.random|Date\.now|new Date|setTimeout|setInterval/.test(src));
  assert.ok(!/\bf_[a-z]{1,3}\b/.test(src), 'no decompiler identifiers');
  for (const n of ['1920', '1080', '0.15', '0.4']) assert.ok(!src.includes(n), 'no L4 candidate ' + n + ' in code');
});
