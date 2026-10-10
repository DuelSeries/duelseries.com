'use strict';
// slGrid (SERVER-DESIGN 3.1, 6.3, 6.4, 8.2; task T3): the sector index on THEIR lattice (SERVER-LAWS L1, L2).
// Done when: occupancy counts equal a brute-force recount over 10,000 random body edits.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createGrid, foodId, idSx, idSy, idRx, idRy, CELLS_PER_SECTOR } = require('../server/sl/slGrid');
const { createRng } = require('../server/sl/slRng');
const slCore = require('../shared/slCore');

// Literal law values (SERVER-LAWS L1 grd 32550, L2 sector_size 300, L5 cst 0.43 and default_msl 42).
const GRD = 32550;
const SS = 300;
const CST = 0.43;
const MSL = 42;
const PER_AXIS = 217; // L2: sector index 0 to 216 across the map

function gridOf() {
  return createGrid({ sectorSize: SS, grd: GRD });
}

// The test's own sector rule, written from L2 (floor(x / 300)), clamped to the map's 217 sectors.
function bruteSector(x, y) {
  const sx = Math.min(PER_AXIS - 1, Math.max(0, Math.floor(x / SS)));
  const sy = Math.min(PER_AXIS - 1, Math.max(0, Math.floor(y / SS)));
  return sy * PER_AXIS + sx;
}

test('lattice constants from L1 and L2', () => {
  const g = gridOf();
  assert.strictEqual(g.perAxis, 217);
  assert.strictEqual(g.sectorTotal, 47089);
  assert.strictEqual(g.cellSize, 1.171875);
  assert.strictEqual(CELLS_PER_SECTOR, 256);
  assert.strictEqual(g.sectorOf(0), 0);
  assert.strictEqual(g.sectorOf(299.999), 0);
  assert.strictEqual(g.sectorOf(300), 1);
  assert.strictEqual(g.sectorOf(32550), 108);
  assert.strictEqual(g.sectorOf(65099.99), 216);
  assert.strictEqual(g.sectorOf(65100), 216);
  assert.strictEqual(g.sectorOf(1e9), 216);
  assert.strictEqual(g.sectorOf(-0.01), 0);
  assert.strictEqual(g.sectorOf(-0), 0);
  assert.strictEqual(g.sectorOf(-1e9), 0);
  for (const bad of [NaN, Infinity, -Infinity]) assert.throws(() => g.sectorOf(bad), RangeError);
  assert.strictEqual(g.sectorAt(32550, 600), 2 * 217 + 108);
  assert.strictEqual(g.sectorIndex(108, 2), 542);
  assert.strictEqual(g.sectorX(542), 108);
  assert.strictEqual(g.sectorY(542), 2);
  assert.throws(() => createGrid({ sectorSize: 0, grd: GRD }), TypeError);
  assert.throws(() => createGrid({ sectorSize: SS }), TypeError);
  assert.throws(() => createGrid({ sectorSize: 100, grd: GRD }), RangeError); // 651 sectors do not fit a byte
});

test('food id is the client expression sx << 24 | sy << 16 | rx << 8 | ry (slApply.js:1095)', () => {
  assert.strictEqual(foodId(0, 0, 0, 0), 0);
  assert.strictEqual(foodId(216, 5, 255, 0), -670695680);
  assert.strictEqual(foodId(127, 216, 1, 2), 2144862466);
  assert.strictEqual(foodId(128, 0, 0, 0), -2147483648);
  const id = foodId(216, 5, 255, 0);
  assert.strictEqual(idSx(id), 216);
  assert.strictEqual(idSy(id), 5);
  assert.strictEqual(idRx(id), 255);
  assert.strictEqual(idRy(id), 0);
  const r = createRng(21);
  for (let i = 0; i < 10000; i++) {
    const sx = r.int(217);
    const sy = r.int(217);
    const rx = r.int(256);
    const ry = r.int(256);
    const v = foodId(sx, sy, rx, ry);
    if (v !== (sx << 24 | sy << 16 | rx << 8 | ry)) assert.fail('id differs at ' + i);
    if (idSx(v) !== sx || idSy(v) !== sy || idRx(v) !== rx || idRy(v) !== ry) assert.fail('decode differs at ' + i);
  }
});

test('food cell position is the client one (slApply.js:1051-1052) and maps back to its own cell', () => {
  const g = gridOf();
  const id = foodId(108, 2, 3, 255);
  assert.strictEqual(g.foodX(id), 108 * 300 + 3 * 1.171875);
  assert.strictEqual(g.foodY(id), 2 * 300 + 255 * 1.171875);
  assert.strictEqual(g.foodSector(id), 2 * 217 + 108);
  for (const sx of [0, 1, 108, 215, 216]) {
    for (let rx = 0; rx < 256; rx++) {
      const want = foodId(sx, 216 - sx, rx, 255 - rx);
      if (g.foodIdAt(g.foodX(want), g.foodY(want)) !== want) assert.fail('cell does not round trip: ' + sx + ' ' + rx);
    }
  }
  // A point inside a cell maps to the cell containing it; outside the map it clamps to the edge cell.
  assert.strictEqual(g.foodIdAt(300 * 5 + 1.171875 * 7 + 1.17, 300 * 9 + 0.5), foodId(5, 9, 7, 0));
  assert.strictEqual(g.foodIdAt(-50, 70000), foodId(0, 216, 0, 255));
});

test('one food per cell: put, get, delete and per-sector counts equal a brute recount over 20,000 edits', () => {
  const g = gridOf();
  const model = new Map();
  const r = createRng(33);
  let refusals = 0;
  for (let i = 0; i < 20000; i++) {
    // A small block of sectors so cells collide often.
    const sx = 100 + r.int(4);
    const sy = 100 + r.int(4);
    const id = foodId(sx, sy, r.int(8), r.int(8));
    if (r() < 0.6) {
      const item = { n: i };
      const ok = g.foodPut(id, item);
      if (ok !== !model.has(id)) assert.fail('put result wrong at ' + i);
      if (ok) model.set(id, item);
      else refusals++;
      if (g.foodGet(id) !== model.get(id)) assert.fail('a taken cell was overwritten at ' + i);
    } else {
      const had = model.delete(id);
      if (g.foodDel(id) !== had) assert.fail('delete result wrong at ' + i);
    }
    if (g.foodHas(id) !== model.has(id)) assert.fail('has wrong at ' + i);
  }
  assert.ok(refusals > 1000);
  assert.strictEqual(g.foodTotal(), model.size);
  const brute = new Map();
  for (const id of model.keys()) {
    const si = idSy(id) * 217 + idSx(id);
    brute.set(si, (brute.get(si) || 0) + 1);
  }
  for (let sx = 100; sx < 104; sx++) {
    for (let sy = 100; sy < 104; sy++) {
      const si = sy * 217 + sx;
      assert.strictEqual(g.foodCountIn(si), brute.get(si) || 0);
      let seen = 0;
      g.forEachFoodIn(si, (id, item) => {
        assert.strictEqual(model.get(id), item);
        assert.strictEqual(g.foodSector(id), si);
        seen++;
      });
      assert.strictEqual(seen, brute.get(si) || 0);
    }
  }
  assert.strictEqual(g.foodCountIn(0), 0);
  assert.strictEqual(g.foodGet(foodId(1, 1, 1, 1)), undefined);
  assert.strictEqual(g.foodDel(foodId(1, 1, 1, 1)), false);
  assert.throws(() => g.foodPut(foodId(217, 0, 0, 0), {}), RangeError);
  assert.throws(() => g.foodGet(1.5), RangeError);
  assert.deepStrictEqual(g.check(), []);
});

// The body-edit model: snakes as arrays of point objects, tail first, edited the way slSnake will edit them.
function bodyRun(seed, edits, onEdit) {
  const g = gridOf();
  const r = createRng(seed);
  const smus = slCore.buildSmus(CST);
  const snakes = new Map();
  let nextSid = 1;
  const kinds = { spawn: 0, grow: 0, move: 0, tail: 0, jitter: 0, kill: 0, crossings: 0 };

  function newPoint(x, y) {
    return { xx: x, yy: y, smu: 1, gs: -1, gk: -1 };
  }

  function spawnPlace() {
    const u = r();
    if (u < 0.6) return [GRD + r.range(-900, 900), GRD + r.range(-900, 900)]; // crowded middle
    if (u < 0.75) return [r.range(-200, 700), r.range(-200, 700)]; // low corner, partly outside the map
    if (u < 0.9) return [r.range(64400, 65400), r.range(64400, 65400)]; // high corner, partly outside the map
    return [r.range(0, 65100), r.range(0, 65100)];
  }

  function pushHead(pts) {
    // L16 order: pull BEFORE the new point, with the grid re-bucketing every pulled point.
    slCore.chainPull(pts, CST, smus, (p) => {
      if (g.movePoint(p)) kinds.crossings++;
    });
    const last = pts[pts.length - 1];
    const [x, y] = slCore.headStep(last.xx, last.yy, r.int(65536), MSL);
    const p = newPoint(x, y);
    pts.push(p);
    g.addPoint(pts.sid, p);
  }

  for (let e = 0; e < edits; e++) {
    const ids = Array.from(snakes.keys());
    const u = r();
    if (ids.length < 4 || (u < 0.05 && ids.length < 30)) {
      const sid = nextSid++;
      const [x, y] = spawnPlace();
      const pts = [newPoint(x, y)];
      const [hx, hy] = slCore.headStep(x, y, r.int(65536), MSL);
      pts.push(newPoint(hx, hy));
      pts.sid = sid;
      for (const p of pts) g.addPoint(sid, p);
      snakes.set(sid, pts);
      kinds.spawn++;
    } else {
      const sid = ids[r.int(ids.length)];
      const pts = snakes.get(sid);
      if (u < 0.35) {
        pushHead(pts);
        kinds.grow++;
      } else if (u < 0.6) {
        pushHead(pts);
        g.removePoint(pts.shift());
        kinds.move++;
      } else if (u < 0.72) {
        if (pts.length > 2) g.removePoint(pts.shift());
        kinds.tail++;
      } else if (u < 0.95) {
        // Arbitrary moves, big and small, some leaving the map.
        const n = 1 + r.int(pts.length);
        for (let k = 0; k < n; k++) {
          const p = pts[r.int(pts.length)];
          const big = r() < 0.1;
          p.xx += r.range(-1, 1) * (big ? 5000 : 350);
          p.yy += r.range(-1, 1) * (big ? 5000 : 350);
          if (g.movePoint(p)) kinds.crossings++;
        }
        kinds.jitter++;
      } else {
        for (const p of pts) g.removePoint(p);
        snakes.delete(sid);
        kinds.kill++;
      }
    }
    onEdit(g, snakes, e, r);
  }
  return { g, snakes, kinds };
}

function bruteCounts(snakes) {
  const counts = new Map(); // si * 65536 + sid -> n
  let points = 0;
  for (const [sid, pts] of snakes) {
    for (const p of pts) {
      const key = bruteSector(p.xx, p.yy) * 65536 + sid;
      counts.set(key, (counts.get(key) || 0) + 1);
      points++;
    }
  }
  return { counts, points };
}

test('occupancy counts equal a brute-force recount after each of 10,000 random body edits', () => {
  let checked = 0;
  let firstBad = null;
  const { g, snakes, kinds } = bodyRun(4242, 10000, (grid, snakesNow, e) => {
    const { counts, points } = bruteCounts(snakesNow);
    if (grid.pointTotal() !== points && !firstBad) firstBad = 'edit ' + e + ': point total';
    if (grid.pairTotal() !== counts.size && !firstBad) firstBad = 'edit ' + e + ': (sector, snake) pair total';
    for (const [key, n] of counts) {
      const si = Math.floor(key / 65536);
      const sid = key % 65536;
      if (grid.countIn(si, sid) !== n && !firstBad) firstBad = 'edit ' + e + ': sector ' + si + ' snake ' + sid;
    }
    checked++;
  });
  assert.strictEqual(firstBad, null);
  assert.strictEqual(checked, 10000);
  // The run exercised every kind of edit and many sector crossings from real pulls and moves.
  for (const k of Object.keys(kinds)) assert.ok(kinds[k] > 50, k + ' ' + kinds[k]);
  assert.ok(snakes.size > 0);
  assert.deepStrictEqual(g.check(), []);
});

test('per-sector snake sets, point buckets and box queries equal brute force during the edits', () => {
  let boxes = 0;
  let firstBad = null;
  const fail = (msg) => {
    if (!firstBad) firstBad = msg;
  };
  bodyRun(777, 10000, (grid, snakesNow, e, r) => {
    if (e % 50 !== 49) return;
    const problems = grid.check();
    if (problems.length) fail('edit ' + e + ': ' + problems[0]);
    // Every sector that brute force says holds points: the snake set and point count match.
    const bySector = new Map(); // si -> {pts, sids:Map}
    for (const [sid, pts] of snakesNow) {
      for (const p of pts) {
        const si = bruteSector(p.xx, p.yy);
        let s = bySector.get(si);
        if (!s) bySector.set(si, (s = { pts: 0, sids: new Map() }));
        s.pts++;
        s.sids.set(sid, (s.sids.get(sid) || 0) + 1);
      }
    }
    for (const [si, s] of bySector) {
      if (grid.pointCountIn(si) !== s.pts) fail('edit ' + e + ': points in ' + si);
      if (grid.snakeCountIn(si) !== s.sids.size) fail('edit ' + e + ': snakes in ' + si);
      let seen = 0;
      grid.forEachSnakeIn(si, (sid, n) => {
        if (s.sids.get(sid) !== n) fail('edit ' + e + ': snake ' + sid + ' in ' + si);
        seen++;
      });
      if (seen !== s.sids.size) fail('edit ' + e + ': snake set size in ' + si);
    }
    const occupied = grid.occupiedSectors();
    if (occupied.length !== bySector.size) fail('edit ' + e + ': occupied sector count');
    // Box queries around a random head: exactly the points whose sector the box touches, each with its owner.
    const sids = Array.from(snakesNow.keys());
    const pts = snakesNow.get(sids[r.int(sids.length)]);
    const h = pts[pts.length - 1];
    const reach = r.range(0, 700);
    const x0 = h.xx - reach;
    const x1 = h.xx + reach;
    const y0 = h.yy - reach;
    const y1 = h.yy + reach;
    const sx0 = Math.min(216, Math.max(0, Math.floor(x0 / SS)));
    const sx1 = Math.min(216, Math.max(0, Math.floor(x1 / SS)));
    const sy0 = Math.min(216, Math.max(0, Math.floor(y0 / SS)));
    const sy1 = Math.min(216, Math.max(0, Math.floor(y1 / SS)));
    const want = new Map();
    for (const [sid, list] of snakesNow) {
      for (const p of list) {
        const si = bruteSector(p.xx, p.yy);
        const sx = si % 217;
        const sy = (si - sx) / 217;
        if (sx >= sx0 && sx <= sx1 && sy >= sy0 && sy <= sy1) want.set(p, sid);
      }
    }
    let got = 0;
    grid.forEachPointInBox(x1, y1, x0, y0, (p, sid) => {
      if (want.get(p) !== sid) fail('edit ' + e + ': box gave a wrong point or owner');
      got++;
    });
    if (got !== want.size) fail('edit ' + e + ': box gave ' + got + ' of ' + want.size);
    boxes++;
  });
  assert.strictEqual(firstBad, null);
  assert.strictEqual(boxes, 200);
});

test('point misuse is refused and a move without movePoint is caught by check()', () => {
  const g = gridOf();
  const p = { xx: 100, yy: 100 };
  assert.throws(() => g.removePoint(p), Error);
  assert.throws(() => g.movePoint(p), Error);
  assert.throws(() => g.addPoint(1.5, p), TypeError);
  g.addPoint(1, p);
  assert.strictEqual(p.gs, 0);
  assert.strictEqual(p.gk, 0);
  assert.throws(() => g.addPoint(1, p), Error);
  assert.throws(() => g.addPoint(2, { xx: NaN, yy: 0 }), RangeError);
  assert.strictEqual(g.pointTotal(), 1);
  p.xx = 400;
  assert.strictEqual(g.check().length, 1);
  assert.strictEqual(g.movePoint(p), true);
  assert.strictEqual(g.movePoint(p), false);
  assert.strictEqual(p.gs, 1);
  assert.deepStrictEqual(g.check(), []);
  g.pullHook(p);
  g.removePoint(p);
  assert.strictEqual(p.gs, -1);
  assert.strictEqual(g.pointTotal(), 0);
  assert.strictEqual(g.pairTotal(), 0);
  assert.strictEqual(g.occupiedSectors().length, 0);
  // A removed point can be held again.
  g.addPoint(3, p);
  assert.strictEqual(g.countIn(1, 3), 1);
  assert.strictEqual(g.countIn(1, 1), 0);
  assert.strictEqual(g.countIn(5000, 3), 0);
});

test('same edit sequence, same buckets in the same order (determinism)', () => {
  const order = (g) => {
    const out = [];
    for (const si of g.occupiedSectors()) out.push(si + ':' + g.pointCountIn(si));
    g.forEachPointInBox(GRD - 3000, GRD - 3000, GRD + 3000, GRD + 3000, (p, sid) => out.push(sid + '@' + p.xx + ',' + p.yy));
    return out.join(';');
  };
  const a = bodyRun(99, 3000, () => {});
  const b = bodyRun(99, 3000, () => {});
  const sa = order(a.g);
  assert.ok(sa.length > 1000);
  assert.ok(sa === order(b.g));
});

test('slGrid never uses Math.random or Date', () => {
  // Code only: the comments may name what is banned.
  const src = fs
    .readFileSync(path.join(__dirname, '../server/sl/slGrid.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  assert.ok(!/Math\.random|Date\.|new Date/.test(src));
});
