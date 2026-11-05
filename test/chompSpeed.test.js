'use strict';
// Chomp speeds (Owen 2026-11-04, fewer boosts): one flat speed, powered the arcade 90%, no cherry or dot boost; two ghosts a module; and meetings that happen BETWEEN two ticks (two things passing through each other at
// speed) still count.
const test = require('node:test');
const assert = require('node:assert');
const R = require('../shared/chompRules');
const Wire = require('../shared/chompWire');
const { ChompRoom } = require('../server/chomp/chompRoom');

const quiet = { log() {}, warn() {}, error() {} };
const DT = 1 / R.TICK_HZ;

function sealedRoom(seed) {
  return new ChompRoom({ mx: 1, my: 1, botFill: 0, seed: seed || 1, grow: false, wrap: false, log: quiet });
}

test('the speeds are flat (Owen 2026-11-04): powered the arcade 90%, no cherry and no dot boost', () => {
  const base = R.pace(false, false, false);
  assert.ok(Math.abs(R.pace(true, false, false) / base - 0.9 / 0.8) < 1e-9, 'powered is the arcade 90% against 80%');
  assert.strictEqual(R.pace(false, true, false), base, 'a cherry gives no speed');
  assert.strictEqual(R.pace(false, false, true), base, 'a dot gives no speed');
  assert.strictEqual(R.DOT_BUMP_TICKS, 0);
  assert.strictEqual(R.FRUIT_BOOST_S, 0);
  assert.ok(R.pace(true, true, true) * DT < 0.5, 'the fastest chomper never skips a tile centre');
  assert.strictEqual(R.DOT_PAUSE_TICKS, 0, 'a dot does not stop you');
});

test('a dot no longer changes its eater speed, and no bump or boost goes on the wire', () => {
  const room = sealedRoom(4);
  const p = room.addPlayer({ name: 'p' });
  p.x = 3.5; p.y = 1.5; p.dir = 3; p.want = 3; p.safe = 0;
  room.dots.fill(0);
  room.dots[1 * room.A.W + 4] = 1;
  const base = room.speedOf(p);
  for (let i = 0; i < 20; i++) room.step();
  assert.strictEqual(room.dots[1 * room.A.W + 4], 0, 'the dot was eaten');
  assert.strictEqual(p.bump, 0);
  assert.ok(Math.abs(room.speedOf(p) - base) < 1e-9);
  const parts = room.snapParts();
  assert.ok(!(parts.ps.find((q) => q.id === p.id).flags & (Wire.F.BUMP | Wire.F.BOOST)), 'no bump or boost flag');
});

test('a powered chomper outruns one fleeing down the same corridor', () => {
  const room = sealedRoom(5);
  const a = room.addPlayer({ name: 'hunter' }), b = room.addPlayer({ name: 'runner' });
  // row 1 runs from column 1 to 26: the runner 6 tiles ahead, both heading right, the runner fed by dots
  room.dots.fill(0);
  for (let c = 1; c <= 26; c++) room.dots[1 * room.A.W + c] = 1;
  a.x = 2.5; a.y = 1.5; a.dir = 3; a.want = 3; a.safe = 0; a.power = R.FRIGHT_S * R.TICK_HZ;
  b.x = 8.5; b.y = 1.5; b.dir = 3; b.want = 3; b.safe = 0;
  for (const g of room.ghosts) { g.x = 14; g.y = 14.5; g.state = 'house'; }
  let t = 0;
  while (!b.dying && t++ < R.FRIGHT_S * R.TICK_HZ) {
    room.step();
    for (const g of room.ghosts) { g.state = 'house'; g.x = 14; g.y = 14.5; }
  }
  assert.ok(b.dying > 0, 'caught before the power ran out (' + t + ' ticks)');
  assert.ok(t < 4 * R.TICK_HZ, 'within 4 s from 6 tiles behind');
});

test('a ghost and a chomper that pass through each other between two ticks still meet', () => {
  const room = sealedRoom(6);
  const p = room.addPlayer({ name: 'p' });
  const g = room.ghosts.find((q) => q.kind === 'blinky');
  for (const q of room.ghosts) if (q !== g) { q.state = 'house'; }
  // heading at each other on row 1, either side of the line between columns 10 and 11: after one tick each is on
  // the other's tile, never on the same one
  p.x = 10.9; p.y = 1.5; p.dir = 3; p.want = 3; p.safe = 0;
  g.x = 11.05; g.y = 1.5; g.dir = 1; g.state = 'active'; g.fright = 0; g.plan = -1; g.dk = -1;
  room.step();
  assert.strictEqual(Math.floor(p.x), 11);
  assert.strictEqual(Math.floor(g.x), 10);
  assert.ok(p.dying > 0, 'caught');
});

test('a powered chomper eats one it passes through between two ticks', () => {
  const room = sealedRoom(7);
  const a = room.addPlayer({ name: 'a' }), b = room.addPlayer({ name: 'b' });
  for (const q of room.ghosts) { q.state = 'house'; q.x = 14; q.y = 14.5; }
  a.x = 10.9; a.y = 1.5; a.dir = 3; a.want = 3; a.safe = 0; a.power = 100;
  b.x = 11.05; b.y = 1.5; b.dir = 1; b.want = 1; b.safe = 0;
  room.step();
  assert.strictEqual(Math.floor(a.x), 11);
  assert.strictEqual(Math.floor(b.x), 10);
  assert.ok(b.dying > 0 && !a.dying, 'eaten');
});

test('two ghosts a module, the modules taking turns, so all four kinds roam the arena', () => {
  const room = new ChompRoom({ mx: 2, my: 2, botFill: 0, seed: 8, grow: false, log: quiet });
  for (const m of room.A.modules) {
    assert.strictEqual(m.quartet.length, 2);
    assert.deepStrictEqual(m.quartet.map((g) => g.kind), R.MODULE_GHOSTS[(m.i + m.j) % 2]);
  }
  assert.deepStrictEqual([...new Set(room.ghosts.map((g) => g.kind))].sort(), ['blinky', 'clyde', 'inky', 'pinky']);
  assert.ok(room.ghosts.every((g, i) => g.index === i));
  // and they all come out of their houses and play
  for (let t = 0; t < 12 * R.TICK_HZ; t++) room.step();
  assert.ok(room.ghosts.every((g) => g.state !== 'house'), 'every ghost left its house');
});
