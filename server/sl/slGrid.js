'use strict';
// Sector index for the slither free room sim (SERVER-DESIGN 3.1, 6.3, 6.4, 8.2; task T3).
//
// One grid, cut on THEIR sector lattice (SERVER-LAWS L2: sector_size 300, sector index = floor(x / 300), 0 to 216
// across the map of L1, grd 32550). It holds three things per sector:
//   1. food cells: one food per cell, keyed by the client's own food id sx << 24 | sy << 16 | rx << 8 | ry
//      (public/js/sl/slApply.js:1095), the cell position being sx * sector_size + rx * sector_size / 256
//      (slApply.js:1051-1052, L2 "a grid of 300 / 256 = 1.171875 units inside a sector");
//   2. body-point occupancy counted per snake (slView's candidate set is the union over its watched sectors, SD 8.2);
//   3. the body points themselves, for collision tests (SD 6.3). The collision buckets are the L2 sectors, so no new
//      cell size is invented: the largest collision reach (L35, a times sc, sc at most 6) is well under one sector.
//
// shared/slCore.js chainPull moves EVERY pulled point on each push (shared/slCore.js:128-152), not only the new head
// and the lost tail, so a point is re-bucketed whenever it moves: pass grid.pullHook as chainPull's onMove argument.
// The grid writes two fields on each point object it holds: gs (its sector index, -1 once removed) and gk (its slot in
// that sector's bucket). Nothing here allocates per call except the first bucket of a sector and Map growth.
//
// Iteration order is insertion order (with swap-remove for points), so it is the same for the same edit sequence.
// The caller reads sectorSize and grd through slLaws (L2, L1) and passes the numbers in.

const CELLS_PER_SECTOR = 256; // the food cell byte rx, ry (L2; slApply.js:1051-1052)

function createGrid(opts) {
  const sectorSize = opts && opts.sectorSize;
  const grd = opts && opts.grd;
  if (!(typeof sectorSize === 'number' && sectorSize > 0 && Number.isFinite(sectorSize))) {
    throw new TypeError('slGrid: sectorSize must be a positive finite number (L2)');
  }
  if (!(typeof grd === 'number' && grd > 0 && Number.isFinite(grd))) {
    throw new TypeError('slGrid: grd must be a positive finite number (L1)');
  }
  // L2: "Sector index = floor(x / 300), 0 to 216 across the map" (2 grd / 300 = 217 per axis).
  const perAxis = Math.ceil((2 * grd) / sectorSize);
  if (perAxis > 256) throw new RangeError('slGrid: more than 256 sectors per axis do not fit the food id byte');
  const cellSize = sectorSize / CELLS_PER_SECTOR;
  const sectorTotal = perAxis * perAxis;
  const buckets = new Array(sectorTotal).fill(null);
  let pointTotal = 0;
  let pairTotal = 0; // (sector, snake) pairs with a count above 0
  let foodTotal = 0;

  function bucketAt(si) {
    let b = buckets[si];
    if (b === null) {
      b = { pts: [], sids: [], counts: new Map(), food: null };
      buckets[si] = b;
    }
    return b;
  }

  // Sector coordinate of a world coordinate, clamped to the map's sectors. Non-finite input is a sim bug: it throws.
  function sectorOf(v) {
    if (!Number.isFinite(v)) throw new RangeError('slGrid: non-finite coordinate ' + v);
    const s = Math.floor(v / sectorSize);
    return s > 0 ? (s >= perAxis ? perAxis - 1 : s) : 0; // also turns -0 into 0
  }

  function sectorIndex(sx, sy) {
    return sy * perAxis + sx;
  }

  function sectorAt(x, y) {
    return sectorOf(y) * perAxis + sectorOf(x);
  }

  function sectorX(si) {
    return si % perAxis;
  }

  function sectorY(si) {
    return (si - (si % perAxis)) / perAxis;
  }

  // ---- food cells ----

  // The cell byte of a coordinate inside sector s: the lattice cell containing it, clamped to 0 to 255.
  function cellByte(v, s) {
    const r = Math.floor((v - s * sectorSize) / cellSize);
    return r > 0 ? (r > CELLS_PER_SECTOR - 1 ? CELLS_PER_SECTOR - 1 : r) : 0;
  }

  // The client food id of the cell containing (x, y).
  function foodIdAt(x, y) {
    const sx = sectorOf(x);
    const sy = sectorOf(y);
    return foodId(sx, sy, cellByte(x, sx), cellByte(y, sy));
  }

  // The client's position of a food id (slApply.js:1051-1052).
  function foodX(id) {
    return idSx(id) * sectorSize + idRx(id) * cellSize;
  }

  function foodY(id) {
    return idSy(id) * sectorSize + idRy(id) * cellSize;
  }

  function foodSector(id) {
    return idSy(id) * perAxis + idSx(id);
  }

  function checkFoodId(id) {
    if (!Number.isInteger(id) || idSx(id) >= perAxis || idSy(id) >= perAxis) {
      throw new RangeError('slGrid: bad food id ' + id);
    }
  }

  // Puts item in its cell. Returns false (and changes nothing) when the cell already holds a food.
  function foodPut(id, item) {
    checkFoodId(id);
    const b = bucketAt(foodSector(id));
    if (b.food === null) b.food = new Map();
    if (b.food.has(id)) return false;
    b.food.set(id, item);
    foodTotal++;
    return true;
  }

  function foodGet(id) {
    checkFoodId(id);
    const b = buckets[foodSector(id)];
    return b === null || b.food === null ? undefined : b.food.get(id);
  }

  function foodHas(id) {
    checkFoodId(id);
    const b = buckets[foodSector(id)];
    return b !== null && b.food !== null && b.food.has(id);
  }

  // Removes the food in a cell. Returns true when one was there.
  function foodDel(id) {
    checkFoodId(id);
    const b = buckets[foodSector(id)];
    if (b === null || b.food === null || !b.food.delete(id)) return false;
    foodTotal--;
    return true;
  }

  function foodCountIn(si) {
    const b = buckets[si];
    return b === null || b.food === null ? 0 : b.food.size;
  }

  function forEachFoodIn(si, fn) {
    const b = buckets[si];
    if (b === null || b.food === null) return;
    for (const [id, item] of b.food) fn(id, item);
  }

  // ---- body points ----

  function addPoint(sid, p) {
    if (!Number.isInteger(sid)) throw new TypeError('slGrid: snake id must be an integer');
    if (p.gs >= 0) throw new Error('slGrid: point already held');
    const si = sectorAt(p.xx, p.yy);
    place(si, sid, p);
    pointTotal++;
  }

  function place(si, sid, p) {
    const b = bucketAt(si);
    p.gs = si;
    p.gk = b.pts.length;
    b.pts.push(p);
    b.sids.push(sid);
    const n = b.counts.get(sid);
    if (n === undefined) {
      b.counts.set(sid, 1);
      pairTotal++;
    } else {
      b.counts.set(sid, n + 1);
    }
  }

  // Takes p out of its bucket (swap-remove) and returns its snake id.
  function lift(p) {
    const b = buckets[p.gs];
    const k = p.gk;
    if (b === null || b.pts[k] !== p) throw new Error('slGrid: point not held where it says');
    const sid = b.sids[k];
    const last = b.pts.length - 1;
    if (k !== last) {
      const moved = b.pts[last];
      b.pts[k] = moved;
      b.sids[k] = b.sids[last];
      moved.gk = k;
    }
    b.pts.pop();
    b.sids.pop();
    const n = b.counts.get(sid);
    if (n === 1) {
      b.counts.delete(sid);
      pairTotal--;
    } else {
      b.counts.set(sid, n - 1);
    }
    return sid;
  }

  function removePoint(p) {
    if (!(p.gs >= 0)) throw new Error('slGrid: point not held');
    lift(p);
    p.gs = -1;
    p.gk = -1;
    pointTotal--;
  }

  // Re-buckets p after its xx, yy changed. Returns true when its sector changed.
  function movePoint(p) {
    if (!(p.gs >= 0)) throw new Error('slGrid: point not held');
    const si = sectorAt(p.xx, p.yy);
    if (si === p.gs) return false;
    const sid = lift(p);
    place(si, sid, p);
    return true;
  }

  // chainPull's onMove(point, dx, dy, dsmu) (shared/slCore.js:128): re-bucket the pulled point.
  function pullHook(p) {
    movePoint(p);
  }

  function countIn(si, sid) {
    const b = buckets[si];
    if (b === null) return 0;
    const n = b.counts.get(sid);
    return n === undefined ? 0 : n;
  }

  function snakeCountIn(si) {
    const b = buckets[si];
    return b === null ? 0 : b.counts.size;
  }

  function pointCountIn(si) {
    const b = buckets[si];
    return b === null ? 0 : b.pts.length;
  }

  // fn(sid, count) for every snake with a point in sector si.
  function forEachSnakeIn(si, fn) {
    const b = buckets[si];
    if (b === null) return;
    for (const [sid, n] of b.counts) fn(sid, n);
  }

  // fn(point, sid) for every point in every sector touching the box (no distance filter; the caller tests distance).
  function forEachPointInBox(x0, y0, x1, y1, fn) {
    const sx0 = sectorOf(Math.min(x0, x1));
    const sx1 = sectorOf(Math.max(x0, x1));
    const sy0 = sectorOf(Math.min(y0, y1));
    const sy1 = sectorOf(Math.max(y0, y1));
    for (let sy = sy0; sy <= sy1; sy++) {
      for (let sx = sx0; sx <= sx1; sx++) {
        const b = buckets[sy * perAxis + sx];
        if (b === null) continue;
        const pts = b.pts;
        const sids = b.sids;
        for (let k = 0; k < pts.length; k++) fn(pts[k], sids[k]);
      }
    }
  }

  // Sectors that hold a point or a food (allocates; for stats and invariant checks, never per tick).
  function occupiedSectors() {
    const out = [];
    for (let si = 0; si < sectorTotal; si++) {
      const b = buckets[si];
      if (b !== null && (b.pts.length > 0 || (b.food !== null && b.food.size > 0))) out.push(si);
    }
    return out;
  }

  // Self-check of every bucket against its own points (for the soak's per-tick invariants). Returns problem strings.
  function check() {
    const problems = [];
    let pts = 0;
    let pairs = 0;
    let foods = 0;
    for (let si = 0; si < sectorTotal; si++) {
      const b = buckets[si];
      if (b === null) continue;
      const recount = new Map();
      for (let k = 0; k < b.pts.length; k++) {
        const p = b.pts[k];
        if (p.gs !== si || p.gk !== k) problems.push('sector ' + si + ' slot ' + k + ': stale gs/gk');
        if (sectorAt(p.xx, p.yy) !== si) problems.push('sector ' + si + ' slot ' + k + ': point moved without movePoint');
        recount.set(b.sids[k], (recount.get(b.sids[k]) || 0) + 1);
      }
      if (recount.size !== b.counts.size) problems.push('sector ' + si + ': snake count differs');
      for (const [sid, n] of recount) {
        if (b.counts.get(sid) !== n) problems.push('sector ' + si + ' snake ' + sid + ': count differs');
      }
      pts += b.pts.length;
      pairs += b.counts.size;
      if (b.food !== null) {
        for (const id of b.food.keys()) if (foodSector(id) !== si) problems.push('food ' + id + ' in sector ' + si);
        foods += b.food.size;
      }
    }
    if (pts !== pointTotal) problems.push('point total differs');
    if (pairs !== pairTotal) problems.push('pair total differs');
    if (foods !== foodTotal) problems.push('food total differs');
    return problems;
  }

  return {
    sectorSize,
    grd,
    perAxis,
    cellSize,
    sectorTotal,
    sectorOf,
    sectorIndex,
    sectorAt,
    sectorX,
    sectorY,
    foodIdAt,
    foodX,
    foodY,
    foodSector,
    foodPut,
    foodGet,
    foodHas,
    foodDel,
    foodCountIn,
    forEachFoodIn,
    foodTotal: () => foodTotal,
    addPoint,
    removePoint,
    movePoint,
    pullHook,
    countIn,
    snakeCountIn,
    pointCountIn,
    forEachSnakeIn,
    forEachPointInBox,
    pointTotal: () => pointTotal,
    pairTotal: () => pairTotal,
    occupiedSectors,
    check,
  };
}

// The client's food id expression, exactly (slApply.js:1095). Signed for sx >= 128, as on the client.
function foodId(sx, sy, rx, ry) {
  return (sx << 24) | (sy << 16) | (rx << 8) | ry;
}

function idSx(id) {
  return (id >>> 24) & 255;
}

function idSy(id) {
  return (id >>> 16) & 255;
}

function idRx(id) {
  return (id >>> 8) & 255;
}

function idRy(id) {
  return id & 255;
}

module.exports = { createGrid, foodId, idSx, idSy, idRx, idRy, CELLS_PER_SECTOR };
