'use strict';
// Chomp (the hidden Pac-Man-style arena): maze shape, movement rules, ghost targeting, and a bot-only arena run.
const test = require('node:test');
const assert = require('node:assert');
const R = require('../shared/chompRules');
const Maze = require('../shared/chompMaze');
const Move = require('../shared/chompMove');
const Wire = require('../shared/chompWire');
const Ghosts = require('../server/chomp/chompGhosts');
const { ChompRoom } = require('../server/chomp/chompRoom');

function walkable(A) {
  const out = [];
  for (let r = 0; r < A.H; r++) for (let c = 0; c < A.W; c++) if (A.walk(c, r)) out.push([c, r]);
  return out;
}

test('the module is 28 x 31, mirror symmetric, with four energizers', () => {
  assert.strictEqual(Maze.MODULE.length, 31);
  for (const row of Maze.MODULE) {
    assert.strictEqual(row.length, 28);
    assert.strictEqual(row, row.split('').reverse().join(''));
  }
  assert.strictEqual(Maze.MODULE.join('').split('o').length - 1, 4);
});

test('the arena is one connected maze with no dead ends, no open 2x2 and no one-tile-thin walls', () => {
  for (const [mx, my] of [[1, 1], [3, 3], [2, 4]]) {
    const A = Maze.build(mx, my);
    const tiles = walkable(A);
    const seen = new Set([tiles[0].join()]);
    const q = [tiles[0]];
    while (q.length) {
      const [c, r] = q.pop();
      for (const [dc, dr] of R.DIRS) {
        const k = (c + dc) + ',' + (r + dr);
        if (A.walk(c + dc, r + dr) && !seen.has(k)) { seen.add(k); q.push([c + dc, r + dr]); }
      }
    }
    assert.strictEqual(seen.size, tiles.length, `${mx}x${my} connected`);
    for (const [c, r] of tiles) {
      const n = R.DIRS.filter(([dc, dr]) => A.walk(c + dc, r + dr)).length;
      assert.ok(n >= 2, `${mx}x${my}: dead end at ${c},${r}`);
      assert.ok(!(A.walk(c + 1, r) && A.walk(c, r + 1) && A.walk(c + 1, r + 1)), `open 2x2 at ${c},${r}`);
    }
    for (let r = 1; r < A.H - 1; r++) for (let c = 1; c < A.W - 1; c++) {
      if (A.cell[r * A.W + c] !== Maze.WALL) continue;
      assert.ok(!(A.walk(c - 1, r) && A.walk(c + 1, r)), `thin wall at ${c},${r}`);
      assert.ok(!(A.walk(c, r - 1) && A.walk(c, r + 1)), `thin wall at ${c},${r}`);
    }
  }
});

test('modules join through the side and border tunnels', () => {
  const A = Maze.build(2, 2);
  assert.strictEqual(A.W, 28 * 2 + 1, 'one spacer column between modules');
  assert.ok(A.walk(27, 14) && A.walk(28, 14) && A.walk(29, 14), 'side tunnel left-right through the spacer');
  assert.ok(A.walk(5, 30) && A.walk(5, 31) && A.walk(5, 32), 'border tunnel up-down through the spacer');
  assert.ok(!A.walk(0, 14) && !A.walk(A.W - 1, 14), 'outer side tunnels sealed');
  assert.ok(!A.walk(5, 0) && !A.walk(5, A.H - 1), 'outer border tunnels sealed');
  assert.ok(!A.walk(28, 13) && !A.walk(28, 15), 'the spacer is wall beside the tunnel');
});

test('movement: speed, stopping at a wall, buffered turns, reversing, cornering and the dot pause', () => {
  const A = Maze.build(1, 1);
  const dt = 1 / R.TICK_HZ;
  // row 1 runs from col 1 to col 12; start at col 3 moving left
  const p = { x: 3.5, y: 1.5, dir: 1, want: -1, pause: 0 };
  const v = R.speed(R.PAC_SPEED);
  Move.tick(p, A, v, dt, null);
  assert.ok(Math.abs(p.x - (3.5 - v * dt)) < 1e-9, '80% of 75.76 px/s');
  for (let i = 0; i < 60; i++) Move.tick(p, A, v, dt, null);
  assert.strictEqual(p.x, 1.5, 'stops at the centre of the last tile');
  assert.strictEqual(p.moving, false);
  // reverse at once
  p.want = 3; Move.tick(p, A, v, dt, null);
  assert.strictEqual(p.dir, 3);
  // buffered turn: want down while on row 1 heading right; col 5 is the first opening down
  p.x = 3.5; p.want = 2;
  for (let i = 0; i < 40 && p.dir !== 2; i++) Move.tick(p, A, v, dt, null);
  assert.strictEqual(p.dir, 2);
  assert.strictEqual(Math.floor(p.x), 5, 'turns in the tile that has the opening');
  // cornering: turned early, it slides onto the column's centre while moving down
  const q = { x: 5.2, y: 1.5, dir: 3, want: 2, pause: 0 };
  Move.tick(q, A, v, dt, null);
  assert.strictEqual(q.dir, 2);
  assert.ok(q.x > 5.2 && q.y > 1.5, 'moves on both axes while cornering');
  // dot pause: one tick per dot, three per energizer
  const dots = new Uint8Array(A.dot0);
  dots[3 * A.W + 1] = 0;
  const e = { x: 1.5, y: 3.6, dir: 2, want: -1, pause: 0 };       // (1, 4) below is an energizer
  const eaten = [];
  for (let i = 0; i < 10 && !eaten.length; i++) Move.tick(e, A, v, dt, dots, (k, kind) => { dots[k] = 0; eaten.push(kind); });
  assert.deepStrictEqual(eaten, [2]);
  assert.strictEqual(e.pause, R.ENERGIZER_PAUSE_TICKS);
});

test('ghost targets follow the dossier, the up-direction bug included', () => {
  const room = new ChompRoom({ mx: 1, my: 1, botFill: 0, seed: 7 });
  room.mode = 'chase';
  const p = room.addPlayer({ name: 'p' });
  p.x = 14.5; p.y = 23.5; p.face = 0; p.safe = 0;
  const [blinky, pinky, inky, clyde] = room.A.modules[0].quartet;
  assert.deepStrictEqual(Ghosts.targetFor(blinky, room, 'chase'), [14, 23]);
  assert.deepStrictEqual(Ghosts.targetFor(pinky, room, 'chase'), [10, 19], 'four up and four left');
  p.face = 3;
  assert.deepStrictEqual(Ghosts.targetFor(pinky, room, 'chase'), [18, 23]);
  blinky.x = 10.5; blinky.y = 20.5;
  assert.deepStrictEqual(Ghosts.targetFor(inky, room, 'chase'), [2 * 16 - 10, 2 * 23 - 20]);
  clyde.x = 14.5; clyde.y = 20.5;
  assert.deepStrictEqual(Ghosts.targetFor(clyde, room, 'chase'), [0, 32], 'under eight tiles: his corner');
  clyde.y = 5.5;
  assert.deepStrictEqual(Ghosts.targetFor(clyde, room, 'chase'), [14, 23]);
  assert.deepStrictEqual(Ghosts.targetFor(blinky, room, 'scatter'), [25, -3]);
});

test('a ghost never reverses on its own and breaks ties up, left, down, right', () => {
  // one sealed module, as the arcade's (on a torus Clyde's corner below would be just above, across the seam)
  const room = new ChompRoom({ mx: 1, my: 1, botFill: 0, seed: 3, wrap: false });
  const g = room.A.modules[0].quartet[0];
  g.dir = 3;               // heading right at (5, 4): exits up/down/left/right; target straight below
  g.x = 5.5; g.y = 4.5;
  room.mode = 'scatter';
  g.kind = 'clyde';        // Clyde's corner (0, 32) is below-left
  const d = Ghosts.decide(g, room.A, room, 5, 4);
  assert.notStrictEqual(d, 1, 'never back the way it came');
  assert.strictEqual(d, 2);
});

test('a bot arena runs: ghosts stay on the maze, bots score, die and come back', () => {
  const room = new ChompRoom({ botFill: 8, seed: 11 });
  room.fillBots();
  assert.strictEqual(room.players.size, 8);
  let deaths = 0, eatenGhosts = 0, powers = 0;
  for (let t = 0; t < R.TICK_HZ * 120; t++) {
    room.step();
    for (const g of room.ghosts) {
      assert.ok(Number.isFinite(g.x) && Number.isFinite(g.y), 'ghost position finite');
      if (g.state === 'active' || g.state === 'eyes') {
        assert.ok(room.A.walk(Math.floor(g.x), Math.floor(g.y)), `ghost ${g.index} ${g.state} off the maze at ${g.x},${g.y}`);
      }
    }
    for (const p of room.players.values()) {
      assert.ok(room.A.walk(Math.floor(p.x), Math.floor(p.y)), `chomper off the maze at ${p.x},${p.y}`);
    }
    const d = room.drain();
    for (const e of d.events || []) {
      if (e.k === 'die') deaths++;
      if (e.k === 'eatg') eatenGhosts++;
      if (e.k === 'power') powers++;
    }
    if (t % 3 === 0) assert.ok(Wire.decode(room.snapshot()));
  }
  const total = [...room.players.values()].reduce((s, p) => s + p.score, 0);
  assert.ok(total > 2000, `bots scored ${total}`);
  assert.ok(deaths > 0, 'ghosts caught someone');
  assert.ok(powers > 0, 'someone ate an energizer');
  assert.ok(room.ghosts.filter(g => g.state === 'house').length < room.ghosts.length / 2, 'ghosts left their houses');
  console.log(`  bots: score ${total}, deaths ${deaths}, ghosts eaten ${eatenGhosts}, energizers ${powers}`);
});

test('eaten ghosts get home: eyes reach the house door from anywhere in the arena', () => {
  const room = new ChompRoom({ botFill: 0, seed: 9 });
  for (const g of room.ghosts) {
    g.state = 'eyes'; g.fright = 0; g.dk = -1;
    // start each pair of eyes at a random walkable tile anywhere
    let k;
    do { k = Math.floor(room.rng() * room.A.W * room.A.H); } while (!room.A.walk(k % room.A.W, Math.floor(k / room.A.W)));
    g.x = k % room.A.W + 0.5; g.y = Math.floor(k / room.A.W) + 0.5;
  }
  for (let t = 0; t < R.TICK_HZ * 20; t++) for (const g of room.ghosts) Ghosts.step(g, room.A, room, 1 / R.TICK_HZ);
  assert.strictEqual(room.ghosts.filter(g => g.state === 'eyes').length, 0, 'every pair of eyes got home within 20 s');
});

test('the wire round-trips', () => {
  const buf = Wire.encode(123456, 1, [{ id: 9, x: 12.25, y: 40.5, dir: 2, flags: 5, seq: 77, since: 3, power: 120 }],
    [{ x: 3.5, y: 4.75, dir: 1, kind: 2, state: 3, fright: 36 }]);
  const s = Wire.decode(buf);
  assert.strictEqual(s.tick, 123456);
  assert.deepStrictEqual(s.players[0], { id: 9, x: 12.25, y: 40.5, dir: 2, flags: 5, seq: 77, since: 3, power: 120 });
  assert.deepStrictEqual(s.ghosts[0], { x: 3.5, y: 4.75, dir: 1, look: 1, kind: 2, state: 3, fright: 36 });
});

test('late turn: a turn the page took a tick ago is honoured at that tile', () => {
  const room = new ChompRoom({ mx: 1, my: 1, botFill: 0, seed: 5 });
  const p = room.addPlayer({ name: 'p' });
  p.x = 3.5; p.y = 1.5; p.dir = 3; p.safe = 0;
  for (let i = 0; i < 30 && Math.floor(p.x) < 6; i++) room.stepPlayer(p);
  assert.strictEqual(Math.floor(p.x), 6, 'past the opening at col 5');
  room.input(p, 2, 1, 5, 1);
  assert.strictEqual(p.dir, 2);
  assert.ok(Math.abs(p.x - 5.5) < 0.6 && p.y > 1.5, `turned down at col 5 (${p.x}, ${p.y})`);
  const q = room.addPlayer({ name: 'q' });
  q.x = 3.5; q.y = 1.5; q.dir = 3;
  for (let i = 0; i < 30 && Math.floor(q.x) < 7; i++) room.stepPlayer(q);
  room.input(q, 2, 2, 9, 1);
  assert.strictEqual(q.dir, 3, 'a tile it never passed: no rewind, the turn waits');
});

test('walls are drawn by the arcade rules measured from the 1x captures (docs/chomp-look.md)', () => {
  const Walls = require('../shared/chompWalls');
  const A = Maze.build(1, 1);
  const w = Walls.build(A);
  const at = (x, y) => w.mask[y * w.PW + x];
  const rows = (x0, y0, ww, hh) => { const o = []; for (let y = y0; y < y0 + hh; y++) { let s = ''; for (let x = x0; x < x0 + ww; x++) s += at(x, y) === 1 ? 'B' : at(x, y) === 2 ? 'P' : '.'; o.push(s); } return o; };
  // the frame's top-left corner, exactly as on the arcade screen (Level 256 capture and the Commons recreation, y 24..29)
  assert.deepStrictEqual(rows(0, 0, 6, 6), ['....BB', '..BB..', '.B....', '.B...B', 'B...B.', 'B..B..']);
  // one pixel lines everywhere: no 2 x 2 block of wall pixels
  for (let y = 0; y < w.PH - 1; y++) for (let x = 0; x < w.PW - 1; x++) {
    assert.ok(!(at(x, y) === 1 && at(x + 1, y) === 1 && at(x, y + 1) === 1 && at(x + 1, y + 1) === 1), `2x2 wall at ${x},${y}`);
  }
  // a block (rows 2-3, cols 2-4): top/left edges 4 px into the tile, bottom/right 3 px, corners cut by one diagonal pixel
  assert.deepStrictEqual(rows(19, 19, 18, 10), [
    '..................', '...BBBBBBBBBBBB...', '..B............B..', '.B..............B.', '.B..............B.',
    '.B..............B.', '.B..............B.', '..B............B..', '...BBBBBBBBBBBB...', '..................']);
  // the double line runs straight past the 2-tile stub under the top border (as the arcade's does over its own)
  for (let x = 96; x < 128; x++) assert.strictEqual(at(x, 0), 1, `outer line over the stub at x ${x}`);
  // the house: double box with square corners and a 16 x 2 door (pixel counts as measured: rows 124/127/152/155 of the
  // arcade screen are the house's rows 100/103/128/131 here, 24 px of score rows above the maze)
  const count = (y) => { let n = 0; for (let x = 80; x < 144; x++) if (at(x, y) === 1) n++; return n; };
  assert.deepStrictEqual([100, 103, 128, 131].map(count), [40, 36, 52, 56]);
  let door = 0; for (let y = 96; y < 104; y++) for (let x = 100; x < 124; x++) if (at(x, y) === 2) door++;
  assert.strictEqual(door, 32);
});

test('the torus: off one edge and on at the other, through the tunnels, with no dead end and no seam in the walls', () => {
  const A = Maze.build(2, 2, { wrap: true });
  assert.strictEqual(A.W, (Maze.MW + Maze.GAP) * 2);
  assert.ok(A.walk(A.W - 1, 14) && A.walk(0, 14) && A.walk(-1, 14), 'the side tunnel runs on across the seam');
  assert.ok(A.walk(5, A.H - 1) && A.walk(5, 0) && A.walk(5, -1), 'the border tunnel runs on across the seam');
  assert.strictEqual(A.dx(A.W - 1, 1), 2, 'the short way across');
  const p = { x: A.W - 0.5, y: 14.5, dir: 3, want: -1, pause: 0 };
  const v = R.speed(R.PAC_SPEED), dt = 1 / R.TICK_HZ;
  for (let i = 0; i < 20; i++) Move.tick(p, A, v, dt, null);
  assert.ok(p.x > 0 && p.x < 3, 'came back on the left: ' + p.x);
  // the walls a torus draws are the same on both sides of the seam as anywhere else: the 2 x 2 torus's left column
  // of pixels matches what a 3 x 2 sealed arena draws inside, where the same modules meet
  const Wl = require('../shared/chompWalls');
  const m = Wl.build(A);
  let wallPx = 0;
  for (let y = 0; y < m.PH; y++) if (m.mask[y * m.PW]) wallPx++;
  assert.ok(wallPx > 0, 'the seam column is drawn');
});

test('ghosts and bots play on a torus: every chomper and active ghost stays on the map', () => {
  const room = new ChompRoom({ mx: 2, my: 2, botFill: 8, seed: 19 });
  for (let t = 0; t < 4000; t++) {
    room.step();
    if (t % 250 === 0) {
      for (const g of room.ghosts) assert.ok(g.x >= 0 && g.x < room.A.W && g.y >= 0 && g.y < room.A.H, 'ghost on the map');
      for (const p of room.players.values()) assert.ok(p.x >= 0 && p.x < room.A.W && p.y >= 0 && p.y < room.A.H, 'chomper on the map');
    }
  }
  assert.ok([...room.players.values()].some((p) => p.score > 0), 'bots scored');
});
