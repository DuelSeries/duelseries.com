'use strict';
// agWorld (build brief 9.2 "agWorld.js"; protocol-semantics 2 to 8, client-camera-input 4,
// client-render 4): node lifecycle, interpolation, eat slide, removals, own-cell promotion.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'public', 'js', 'ag', 'agWorld.js');
const W = require(FILE);
const f32 = Math.fround;

function cell(id, x, y, size, extra) {
  return Object.assign({ id, x, y, size, virus: false, food: false, ejected: false, agitated: false,
    flag40: false, party: false }, extra || {});
}
function world(msgOpts) { return Object.assign({ t: 'world', eats: [], cells: [], removed: [] }, msgOpts); }
function make(opts) {
  let draws = 0;
  const w = W.createWorld(Object.assign({ random: () => { draws++; return 0.25; } }, opts || {}));
  const ev = {};
  for (const n of ['spawn', 'death', 'eat', 'merge', 'virusEaten', 'create', 'remove', 'delete', 'border',
    'cam', 'board', 'ready', 'name']) w.on(n, (p) => { (ev[n] = ev[n] || []).push(p); });
  return { w, ev, draws: () => draws };
}

test('card: x 0 (updateTime 1000) to x 100 shows 50 at 1050 and 100 from 1100', () => {
  const { w } = make();
  w.apply(world({ cells: [cell(7, 0, 0, 50)] }), 900);
  w.apply(world({ cells: [cell(7, 100, 0, 50)] }), 1000);
  const n = w.node(7);
  assert.strictEqual(n.updateTime, 1000);
  assert.strictEqual(n.fromX, 0);
  assert.strictEqual(n.toX, 100);
  assert.strictEqual(W.interpolate(n, 1050).x, 50);
  assert.strictEqual(W.interpolate(n, 1100).x, 100);
  assert.strictEqual(W.interpolate(n, 1300).x, 100);
  assert.strictEqual(W.interpolate(n, 1000).x, 0);
});

test('card: size 50 toward 50.005 snaps to 50.005 (|interpolated - target| < 0.01)', () => {
  const to = f32(50.005);
  const n = { fromX: 0, fromY: 0, fromSize: 50, toX: 0, toY: 0, toSize: to, updateTime: 1000 };
  for (const now of [1000, 1010, 1050, 1099]) assert.strictEqual(W.interpolate(n, now).size, to);
  // Not within 0.01: interpolated, f32 rounded.
  const m = { fromX: 0, fromY: 0, fromSize: 50, toX: 0, toY: 0, toSize: 60, updateTime: 1000 };
  assert.strictEqual(W.interpolate(m, 1050).size, 55);
  assert.strictEqual(W.interpolate(m, 1033).size, f32(0.33 * 10 + 50));
});

test('every interpolation step is an f32 rounding point', () => {
  const n = { fromX: f32(0.1), fromY: f32(-7.3), fromSize: f32(12.7), toX: f32(1234.567), toY: f32(-0.9),
    toSize: f32(40.3), updateTime: 0 };
  W.interpolate(n, 37.123);
  const t = 0.37123;
  assert.strictEqual(n.x, f32(t * f32(n.toX - n.fromX) + n.fromX));
  assert.strictEqual(n.y, f32(t * f32(n.toY - n.fromY) + n.fromY));
  assert.strictEqual(n.size, f32(t * f32(n.toSize - n.fromSize) + n.fromSize));
});

test('card: eat slide target x = f32(cos(0) * (100 + 40 * -0.5)) = 80, size 5', () => {
  const { w, ev } = make();
  w.apply(world({ cells: [cell(1, 0, 0, 100), cell(2, 150, 0, 40)] }), 1000);
  w.apply(world({ eats: [[1, 2]] }), 1200);
  const e = w.node(2);
  assert.strictEqual(e.toX, 80);
  assert.strictEqual(e.toY, 0);
  assert.strictEqual(e.toSize, 5);
  assert.strictEqual(e.updateTime, 1200);
  assert.strictEqual(e.updatable, false);
  assert.strictEqual(e.x, 150);         // re-based at receipt, the slide starts where it was shown
  assert.strictEqual(W.interpolate(e, 1250).x, 115);
  assert.strictEqual(W.interpolate(e, 1300).x, 80);
  assert.strictEqual(W.interpolate(e, 1300).size, 5);
  assert.strictEqual(ev.eat.length, 1);
  assert.ok(w.node(2), 'an eat does not delete the node');
});

test('eat slide uses the float atan2 and the displayed values of both nodes', () => {
  const M = require(path.join(__dirname, '..', 'public', 'js', 'ag', 'agMath.js'));
  const { w } = make();
  w.apply(world({ cells: [cell(1, -428, 37, 120), cell(2, 27, 491, 33)] }), 1000);
  w.apply(world({ eats: [[1, 2]] }), 1100);
  const e = w.node(2);
  const ang = M.atan2f(f32(491 - 37), f32(27 - -428));
  const d = f32(120 + f32(33 * -0.5));
  assert.strictEqual(e.toX, f32(Math.cos(ang) * d + -428));
  assert.strictEqual(e.toY, f32(Math.sin(ang) * d + 37));
});

test('a node being eaten ignores position and size in later records but keeps flags and colour', () => {
  const { w } = make();
  w.apply(world({ cells: [cell(1, 0, 0, 100), cell(2, 150, 0, 40)] }), 1000);
  w.apply(world({ eats: [[1, 2]] }), 1200);
  w.apply(world({ cells: [cell(2, 999, 999, 77, { virus: true, rgb: [1, 2, 3] })] }), 1240);
  const e = w.node(2);
  assert.deepStrictEqual([e.toX, e.toY, e.toSize, e.updateTime], [80, 0, 5, 1200]);
  assert.strictEqual(e.virus, true);
  assert.deepStrictEqual([e.r, e.g, e.b], [1, 2, 3]);
  // A second eat of the same node does not re-animate it.
  w.apply(world({ cells: [cell(3, -500, 0, 200)] }), 1250);
  w.apply(world({ eats: [[3, 2]] }), 1260);
  assert.deepStrictEqual([e.toX, e.updateTime], [80, 1200]);
});

test('card: an eat record with an unknown id is skipped', () => {
  const { w, ev } = make();
  w.apply(world({ cells: [cell(1, 0, 0, 100), cell(2, 150, 0, 40)] }), 1000);
  w.apply(world({ eats: [[1, 99], [99, 2]] }), 1100);
  assert.strictEqual(ev.eat, undefined);
  assert.strictEqual(w.node(2).updatable, true);
  assert.strictEqual(w.node(2).toX, 150);
});

test('card: removed 30 ms after its last update draws at alpha 0.7 and is deleted at 100 ms', () => {
  const { w, ev } = make();
  w.apply(world({ cells: [cell(5, 10, 10, 20)] }), 1000);
  w.apply(world({ cells: [cell(5, 12, 10, 20)] }), 1040);
  w.apply(world({ removed: [5] }), 1060);
  const L = w.lists();
  assert.strictEqual(L.live.length, 0);
  assert.strictEqual(L.dying.length, 1);
  const n = L.dying[0];
  assert.strictEqual(n.dying, true);
  assert.strictEqual(W.fadeAlpha(n, 1070), 0.7);
  assert.strictEqual(w.node(5), null, 'a dying node is out of the id map');
  w.cleanup(1139.999);
  assert.strictEqual(L.dying.length, 1);
  w.cleanup(1140);
  assert.strictEqual(L.dying.length, 0);
  assert.strictEqual(ev.delete.length, 1);
  assert.strictEqual(W.fadeAlpha(n, 1140), 0);
});

test('cleanup flag: armed at start, cleared by a pass; interpolateAll uses the world clock', () => {
  const { w } = make();
  w.apply(world({ cells: [cell(5, 0, 0, 20)] }), 1000);
  w.apply(world({ cells: [cell(5, 100, 0, 20)] }), 1040);
  w.apply(world({ removed: [5] }), 1060);
  assert.strictEqual(w.state().cleanupArmed, true);
  w.cleanupIfPending(1100);                  // fade not over: nothing freed, flag cleared
  assert.strictEqual(w.lists().dying.length, 1);
  assert.strictEqual(w.state().cleanupArmed, false);
  w.cleanupIfPending(1200);                  // not armed: nothing runs
  assert.strictEqual(w.lists().dying.length, 1);
  w.interpolateAll();                        // world clock = last world message (1060)
  assert.strictEqual(w.lists().dying[0].x, 20);
  w.setNow(1090);
  w.interpolateAll();
  assert.strictEqual(w.lists().dying[0].x, 50);
  w.armCleanup();
  w.cleanupIfPending();                      // world clock 1090 < 1140: kept
  assert.strictEqual(w.lists().dying.length, 1);
  w.armCleanup();
  w.cleanupIfPending(1140);
  assert.strictEqual(w.lists().dying.length, 0);
});

test('fade counts from the last update, not the removal (T6)', () => {
  const { w } = make();
  w.apply(world({ cells: [cell(5, 10, 10, 20)] }), 1000);
  w.apply(world({ cells: [cell(5, 10, 10, 20)] }), 1100);
  w.apply(world({ removed: [5] }), 1300);
  const n = w.lists().dying[0];
  assert.strictEqual(W.fadeAlpha(n, 1300), 0);
  w.cleanup(1300);
  assert.strictEqual(w.lists().dying.length, 0);
  // A node created and never updated has updateTime 0: it vanishes at once.
  w.apply(world({ cells: [cell(6, 0, 0, 10)] }), 2000);
  w.apply(world({ removed: [6] }), 2010);
  assert.strictEqual(W.fadeAlpha(w.lists().dying[0], 2010), 0);
});

test('card: first own record fires spawn once with camera x 0, y = cell y, draw scale 1', () => {
  const { w, ev } = make();
  w.apply(world({ cells: [cell(3, 500, -40, 10)] }), 900);
  w.apply({ t: 'own', id: 1 }, 950);
  w.apply(world({ cells: [cell(1, 1234, -567, 45, { rgb: [10, 20, 30] })] }), 1000);
  assert.strictEqual(ev.spawn.length, 1);
  const s = ev.spawn[0];
  assert.deepStrictEqual([s.camX, s.camY, s.drawScale], [0, -567, 1]);
  assert.strictEqual(s.node.id, 1);
  assert.deepStrictEqual(w.state().ownColor, [10, 20, 30]);
  assert.strictEqual(w.state().alive, true);
  assert.strictEqual(w.state().life.spawnTime, 1000);
  // A second own cell (split) is no spawn; further records are no spawn.
  w.apply({ t: 'own', id: 2 }, 1010);
  w.apply(world({ cells: [cell(1, 1234, -567, 30), cell(2, 1300, -567, 30)] }), 1040);
  w.apply(world({ cells: [cell(1, 1234, -560, 30)] }), 1080);
  assert.strictEqual(ev.spawn.length, 1);
  assert.deepStrictEqual(w.lists().own.map((n) => n.id), [1, 2]);
});

test('own needs the announcement AND a record (T4)', () => {
  const { w, ev } = make();
  w.apply(world({ cells: [cell(1, 0, 0, 40)] }), 1000);
  assert.strictEqual(w.lists().own.length, 0, 'sent but not announced');
  w.apply({ t: 'own', id: 2 }, 1010);
  w.apply(world({}), 1040);
  assert.strictEqual(w.lists().own.length, 0, 'announced but not sent');
  w.apply({ t: 'own', id: 1 }, 1050);
  assert.strictEqual(w.lists().own.length, 0, 'the record must come after');
  w.apply(world({ cells: [cell(1, 0, 0, 40)] }), 1080);
  assert.deepStrictEqual(w.lists().own.map((n) => n.id), [1]);
  assert.strictEqual(ev.spawn.length, 1);
});

test('card: removing the last own cell fires death once', () => {
  const { w, ev } = make();
  w.apply({ t: 'own', id: 1 }, 990);
  w.apply({ t: 'own', id: 2 }, 990);
  w.apply(world({ cells: [cell(1, 0, 0, 40), cell(2, 100, 0, 40), cell(9, 300, 0, 400)] }), 1000);
  w.apply(world({ eats: [[9, 1]], removed: [1] }), 1040);
  assert.strictEqual(ev.death, undefined, 'one own cell is left');
  w.apply(world({ eats: [[9, 2]] }), 1080);
  assert.strictEqual(ev.death, undefined, 'an eaten own cell stays own until removed');
  w.apply(world({ removed: [2] }), 1120);
  assert.strictEqual(ev.death.length, 1);
  assert.strictEqual(w.state().alive, false);
  w.apply(world({ removed: [9] }), 1160);
  w.apply(world({}), 1200);
  assert.strictEqual(ev.death.length, 1);
  assert.strictEqual(ev.death[0].now, 1120);
  assert.strictEqual(ev.death[0].stats.timeAlive, 120);
});

test('clearOwn turns own cells into ordinary cells, no death, no deletion', () => {
  const { w, ev } = make();
  w.apply({ t: 'own', id: 1 }, 990);
  w.apply(world({ cells: [cell(1, 0, 0, 40), cell(2, 9, 9, 10)] }), 1000);
  w.apply({ t: 'clearOwn' }, 1010);
  const L = w.lists();
  assert.strictEqual(L.own.length, 0);
  assert.strictEqual(L.ownIds.length, 0);
  assert.strictEqual(L.live.length, 2);
  assert.strictEqual(ev.death, undefined);
  w.apply(world({ removed: [1] }), 1040);
  assert.strictEqual(ev.death, undefined);
});

test('card: clearAll deletes every node with no fade and empties both own lists', () => {
  const { w, ev } = make();
  w.apply({ t: 'own', id: 1 }, 990);
  w.apply(world({ cells: [cell(1, 0, 0, 40), cell(2, 9, 9, 10), cell(3, 50, 50, 10)] }), 1000);
  w.apply(world({ removed: [3] }), 1040);
  w.apply({ t: 'clearAll' }, 1050);
  const L = w.lists();
  assert.deepStrictEqual([L.live.length, L.dying.length, L.own.length, L.ownIds.length], [0, 0, 0, 0]);
  assert.strictEqual(w.node(1), null);
  assert.strictEqual(w.node(2), null);
  assert.strictEqual(ev.death, undefined);
  // The next own record is a spawn again (the client never saw a death).
  w.apply({ t: 'own', id: 4 }, 1060);
  w.apply(world({ cells: [cell(4, 7, 8, 40)] }), 1080);
  assert.strictEqual(ev.spawn.length, 2);
});

test('card: a removed id that comes back is a new node while the old one keeps fading (T12)', () => {
  const { w, ev } = make();
  w.apply(world({ cells: [cell(8, 0, 0, 30)] }), 1000);
  w.apply(world({ cells: [cell(8, 10, 0, 30)] }), 1040);
  w.apply(world({ removed: [8], cells: [] }), 1060);
  const old = w.lists().dying[0];
  w.apply(world({ cells: [cell(8, 500, 500, 30)] }), 1080);
  const fresh = w.node(8);
  assert.notStrictEqual(fresh, old);
  assert.strictEqual(w.lists().dying[0], old);
  assert.strictEqual(fresh.updateTime, 0);
  assert.strictEqual(ev.create.length, 2);
  // Deleting the old one must not drop the new one from the id map.
  w.cleanup(1200);
  assert.strictEqual(w.lists().dying.length, 0);
  assert.strictEqual(w.node(8), fresh);
  // Removing the id again removes the NEW node.
  w.apply(world({ removed: [8] }), 1300);
  assert.strictEqual(w.lists().dying[0], fresh);
});

test('removal is swap-with-last in the live list; own lists keep their order', () => {
  const { w } = make();
  for (const id of [1, 2, 3]) w.apply({ t: 'own', id }, 990);
  w.apply(world({ cells: [1, 2, 3, 4, 5].map((i) => cell(i, i, 0, 10 * i)) }), 1000);
  w.apply(world({ removed: [1] }), 1040);
  assert.deepStrictEqual(w.lists().live.map((n) => n.id), [5, 2, 3, 4]);
  assert.deepStrictEqual(w.lists().own.map((n) => n.id), [2, 3]);
  assert.deepStrictEqual(w.lists().ownIds, [2, 3]);
  w.apply(world({ removed: [3, 2] }), 1080);
  assert.deepStrictEqual(w.lists().live.map((n) => n.id), [5, 4]);
  assert.deepStrictEqual(w.lists().dying.map((n) => n.id), [1, 3, 2]);
  w.cleanup(2000);
  assert.deepStrictEqual(w.lists().dying.map((n) => n.id), []);
});

test('each new node draws exactly one random number, at creation, for its ring', () => {
  const { w, draws } = make();
  w.apply(world({ cells: [cell(1, 0, 0, 10), cell(2, 5, 5, 20), cell(3, 1, 1, 30)] }), 1000);
  assert.strictEqual(draws(), 3);
  w.apply(world({ cells: [cell(1, 3, 0, 10), cell(2, 5, 6, 20)] }), 1040);
  assert.strictEqual(draws(), 3);
  const p = w.node(2).points;
  assert.strictEqual(p.length, 1);
  assert.deepStrictEqual(p[0], { cid: 2, px: 5, py: 5, cx: 0, sy: 0, r: 20, v: f32(0.25 - 0.5) });
  // Default source is Math.random, looked up when called (the harness seeds it).
  const real = Math.random;
  let n = 0;
  Math.random = () => { n++; return 0.5; };
  try {
    const w2 = W.createWorld();
    w2.apply(world({ cells: [cell(1, 0, 0, 10)] }), 0);
  } finally { Math.random = real; }
  assert.strictEqual(n, 1);
});

test('new nodes: packet position at once, black without colour, flags every record, colour and name sticky', () => {
  const { w, ev } = make();
  w.apply(world({ cells: [cell(1, -3, 4, 25, { virus: true })] }), 1000);
  const n = w.node(1);
  assert.deepStrictEqual([n.x, n.y, n.size, n.fromX, n.toSize, n.updateTime], [-3, 4, 25, -3, 25, 0]);
  assert.deepStrictEqual([n.r, n.g, n.b], [0, 0, 0]);
  assert.strictEqual(W.interpolate(n, 1000).x, -3);
  w.apply(world({ cells: [cell(1, -3, 4, 25, { rgb: [255, 7, 99], name: 'bob' })] }), 1040);
  assert.strictEqual(n.virus, false, 'a record without the virus bit clears it (T2)');
  assert.deepStrictEqual([n.r, n.g, n.b, n.name], [255, 7, 99, 'bob']);
  w.apply(world({ cells: [cell(1, -3, 4, 25, { name: '', food: true, party: true, ejected: true, flag40: true,
    agitated: true })] }), 1080);
  assert.deepStrictEqual([n.r, n.g, n.b, n.name], [255, 7, 99, 'bob']);
  assert.deepStrictEqual([n.food, n.highlight, n.ejected, n.flag40, n.agitated], [true, true, true, true, true]);
  assert.strictEqual(ev.name.length, 1);
});

test('own cells always show the local nickname; server names for own ids are ignored (T3)', () => {
  const { w, ev } = make({ nick: 'owen' });
  w.apply({ t: 'own', id: 1 }, 990);
  w.apply(world({ cells: [cell(1, 0, 0, 40, { name: 'server name' })] }), 1000);
  assert.strictEqual(w.node(1).name, 'owen');
  assert.ok(ev.name.every((e) => e.name === 'owen' && e.own));
  w.setNick('other');
  w.apply(world({}), 1040);
  assert.strictEqual(w.node(1).name, 'other');
});

test('life stats: food, cells and viruses eaten, with the 0x20 / 0x40 food rule', () => {
  const { w, ev } = make();
  w.apply({ t: 'own', id: 1 }, 990);
  w.apply({ t: 'own', id: 2 }, 990);
  const others = [
    cell(10, 50, 0, 10, { food: true }),
    cell(11, 50, 0, 10, { ejected: true, flag40: true }),       // counts as food
    cell(12, 50, 0, 10, { ejected: true }),                     // counts nothing
    cell(13, 50, 0, 100, { ejected: true, virus: true }),       // virus
    cell(14, 50, 0, 100, { virus: true }),                      // virus
    cell(15, 50, 0, 30)                                         // cell
  ];
  w.apply(world({ cells: [cell(1, 0, 0, 200), cell(2, 0, 0, 200), cell(20, 900, 0, 50)].concat(others) }), 1000);
  w.apply(world({ eats: [[1, 10], [1, 11], [2, 12], [1, 13], [2, 14], [1, 15], [20, 15], [1, 2]] }), 1040);
  const L = w.state().life;
  assert.deepStrictEqual([L.foodEaten, L.virusesEaten, L.cellsEaten], [2, 2, 1]);
  assert.strictEqual(ev.merge.length, 1);
  assert.strictEqual(ev.virusEaten.length, 2);
  const sounds = ev.eat.map((e) => e.sound);
  assert.deepStrictEqual(sounds, [null, null, null, null, null, 'eatCell', 'eatCell', 'eatCell']);
});

test('game-over sound only when a foreign eater takes the last own cell', () => {
  const { w, ev } = make();
  w.apply({ t: 'own', id: 1 }, 990);
  w.apply(world({ cells: [cell(1, 0, 0, 40), cell(9, 60, 0, 400)] }), 1000);
  w.apply(world({ eats: [[9, 1]], removed: [1] }), 1040);
  assert.strictEqual(ev.eat[0].sound, 'gameOver');
  assert.strictEqual(ev.death.length, 1);
  assert.strictEqual(w.state().life.foodEaten, 0, 'life stats start again after a death');
});

test('death zeroes the life stats after handing them over', () => {
  const { w, ev } = make();
  w.apply({ t: 'board', rows: [{ name: 'a' }, { me: true }] }, 900);
  w.apply({ t: 'own', id: 1 }, 990);
  w.apply(world({ cells: [cell(1, 0, 0, 200), cell(2, 9, 0, 10, { food: true })] }), 1000);
  w.apply(world({ eats: [[1, 2]], removed: [2] }), 1040);
  w.state().life.highestMass = 400;
  w.apply({ t: 'board', rows: [{ me: true }] }, 1050);
  w.apply(world({ removed: [1] }), 1080);
  const d = ev.death[0];
  assert.deepStrictEqual([d.stats.foodEaten, d.stats.highestMass, d.stats.topPosition, d.stats.timeAlive],
    [1, 400, 1, 80]);
  const L = w.state().life;
  assert.deepStrictEqual([L.foodEaten, L.highestMass, L.topPosition, L.spawnTime, L.massHistory.length],
    [0, 0, 0, 0, 0]);
});

test('board: list positions give the best position and the on-board flag', () => {
  const { w } = make();
  const rows = (k) => Array.from({ length: 12 }, (_, i) => (i === k ? { me: true } : { name: 'x' }));
  w.apply({ t: 'board', rows: rows(11) }, 0);
  assert.deepStrictEqual([w.state().life.topPosition, w.state().life.onBoard], [12, false]);
  w.apply({ t: 'board', rows: rows(3) }, 0);
  assert.deepStrictEqual([w.state().life.topPosition, w.state().life.onBoard], [4, true]);
  w.apply({ t: 'board', rows: rows(6) }, 0);
  assert.deepStrictEqual([w.state().life.topPosition, w.state().life.onBoard], [4, true]);
  w.apply({ t: 'board', rows: [{ name: 'x' }] }, 0);
  assert.strictEqual(w.state().life.onBoard, true, 'absent counts as on the board');
});

test('border: normalised, first one moves the camera target and cuts when there are no own cells', () => {
  const { w, ev } = make();
  w.apply({ t: 'border', minX: 3000, minY: 2000, maxX: -3000, maxY: -1000, mode: 0 }, 0);
  assert.deepStrictEqual(w.state().border, { minX: -3000, minY: -1000, maxX: 3000, maxY: 2000 });
  assert.deepStrictEqual(w.state().arena, w.state().border);
  const b = ev.border[0];
  assert.deepStrictEqual([b.first, b.camTargetX, b.camTargetY, b.noCellsZoomBase, b.snapCamera],
    [true, 0, 500, 1, true]);
  w.apply({ t: 'border', minX: -10, minY: -10, maxX: 10, maxY: 10 }, 0);
  assert.strictEqual(ev.border[1].first, false);
  assert.deepStrictEqual(w.state().arena, { minX: -3000, minY: -1000, maxX: 3000, maxY: 2000 },
    'a border without a mode moves only the border');
});

test('cam: spectate point and zoom are float32 values', () => {
  const { w, ev } = make();
  w.apply({ t: 'cam', x: 0.1, y: -2.5, zoom: 0.3 }, 0);
  assert.deepStrictEqual(ev.cam[0], { x: f32(0.1), y: -2.5, zoom: f32(0.3) });
});

test('ready fires once at the first world message; reset starts over', () => {
  const { w, ev } = make();
  w.apply({ t: 'border', minX: -1, minY: -1, maxX: 1, maxY: 1, mode: 0 }, 0);
  assert.strictEqual(ev.ready, undefined);
  w.apply(world({}), 10);
  w.apply(world({}), 20);
  assert.strictEqual(ev.ready.length, 1);
  w.apply(world({ cells: [cell(1, 0, 0, 10)] }), 30);
  w.reset();
  assert.strictEqual(w.lists().live.length, 0);
  assert.strictEqual(w.state().ready, false);
  w.apply({ t: 'border', minX: -1, minY: -1, maxX: 1, maxY: 1 }, 40);
  assert.strictEqual(ev.border[1].first, true);
});

test('sync: known live nodes not listed are removed after the records, with no camera snap', () => {
  const { w, ev } = make();
  w.apply({ t: 'own', id: 1 }, 990);
  w.apply(world({ cells: [cell(1, 0, 0, 40), cell(2, 9, 9, 10), cell(3, 50, 50, 10)] }), 1000);
  w.apply({ t: 'sync', eats: [], cells: [cell(1, 5, 0, 40), cell(4, 70, 70, 10)], removed: [] }, 1040);
  assert.deepStrictEqual(w.lists().live.map((n) => n.id).sort(), [1, 4]);
  assert.deepStrictEqual(w.lists().dying.map((n) => n.id).sort(), [2, 3]);
  assert.strictEqual(ev.spawn.length, 1);
  w.apply({ t: 'sync', eats: [], cells: [cell(4, 70, 70, 10)], removed: [] }, 1080);
  assert.strictEqual(ev.death.length, 1, 'an own cell missing from a sync is a removal');
});

test('arrival statistics run only while alive, using the clock before the message', () => {
  const { w } = make();
  w.apply({ t: 'own', id: 1 }, 0);
  w.apply(world({ cells: [cell(1, 0, 0, 40)] }), 1000);
  w.setNow(1016);
  w.apply(world({}), 1040);
  w.setNow(1056);
  w.apply(world({}), 1080);
  w.setNow(1100);
  w.apply(world({}), 1120);
  const S = w.state().msgStats;
  // intervals 1016 - 1000 = 16, 1056 - 1016 = 40, 1100 - 1056 = 44
  assert.strictEqual(S.count, 3);
  assert.ok(Math.abs(S.mean - 100 / 3) < 1e-12);
});

test('debugLists gives [x, y, size, toX, toY, toSize] for the live and dying lists', () => {
  const { w } = make();
  w.apply(world({ cells: [cell(1, 0, 0, 10), cell(2, 4, 5, 6)] }), 1000);
  w.apply(world({ cells: [cell(1, 100, 0, 10)], removed: [2] }), 1050);
  assert.deepStrictEqual(w.debugLists(), { listA: [[0, 0, 10, 100, 0, 10]], listB: [[4, 5, 6, 4, 5, 6]] });
});

test('browser load: wrapper sets DuelAgarLib.agWorld with only window and agMath', () => {
  const vm = require('vm');
  const ctx = { Math, Map, Set, Array, Object };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'ag', 'agMath.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(FILE, 'utf8'), ctx);
  const lib = ctx.DuelAgarLib.agWorld;
  assert.strictEqual(typeof lib.createWorld, 'function');
  const w = lib.createWorld({ random: () => 0.5 });
  w.apply({ t: 'world', eats: [], cells: [{ id: 1, x: 0, y: 0, size: 100 }, { id: 2, x: 150, y: 0, size: 40 }],
    removed: [] }, 1000);
  w.apply({ t: 'world', eats: [[1, 2]], cells: [], removed: [] }, 1100);
  assert.strictEqual(w.node(2).toX, 80);
});

test('hygiene: no reference line citations or paths, no fixture import, no clock reads', () => {
  const src = fs.readFileSync(FILE, 'utf8');
  assert.ok(!/\b[DW] \d{3,}/.test(src), 'no D/W line citations');
  assert.ok(!/\bf_[a-z]{2,3}\b/.test(src), 'no reference function names');
  assert.ok(!/agario-reference/.test(src), 'never names the reference tree');
  assert.ok(!/agLawsFixture/.test(src));
  assert.ok(!/Date\.now|performance\.now/.test(src));
});
