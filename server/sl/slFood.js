'use strict';
// slither.io free room: the food store (SERVER-DESIGN 6.4, task T5).
//
// A food IS a cell: their client id is sx << 24 | sy << 16 | rx << 8 | ry (public/js/sl/slApply.js:1095), so the store
// is the shared sector index (server/sl/slGrid.js food cells) and two foods never share a cell. On top of it:
//   - natural fill and spawn passes, targeted at the L26 NATURAL profile by fraction of the border radius
//     (C_FOOD_SCALE), sizes L27, colours L28, one pass per L29 period at the L29 rate, stopping at guardMult x the L26
//     target per sector (Owen Q2, OWNER-ANSWERS.md:78);
//   - drops (boost L24, death L39) placed by the caller, stored at the cell of their position, or at the nearest free
//     cell of that sector when it is taken (C_DROP_CELL);
//   - eats, always with an eater: no food ever expires (L30) and no food_eat without an eater ('c') is ever made, so
//     food outside a shrunk border stays until eaten (C_OUTSIDE_FOOD).
// The standing total (natural plus every drop still lying) is only reported in stats(), never targeted: old drops pile
// up by themselves (SERVER-DESIGN 6.4, SERVER-LAWS L26 "the 7.22 figure stays as the total standing food check").
//
// Records (SERVER-LAWS L25, C_FOOD_FULL_FORMS): a natural spawn is a slow pop-in food_add (their `f`, rapid false), a
// drop a fast pop-in food_add (their `b`, rapid true), a sector dump a food_sector (their `F`), an eat a food_eat `<`
// with its eater. Always the full forms. Each event object is made once and shared by every seat (slRecordCache keys
// its records by event object).
//
// Time: the caller passes the sim time in ms. The L29 pass is an accumulator clock (SERVER-DESIGN 5.1): it fires on
// the first step at or after its due time, then due += period, so the mean period is exact.
// Deterministic: every draw from the caller's 'food' stream (server/sl/slRng.js), sectors in row-major order.

const { assertLawsComplete, assertRulesBuilt } = require('./slLaws');

const FOOD_LAW_IDS = Object.freeze(['L1', 'L2.size', 'L25', 'L26', 'L27', 'L28', 'L29.period', 'L29.rate', 'L30',
  'C_FOOD_SCALE', 'C_OUTSIDE_FOOD', 'C_DROP_CELL', 'C_FOOD_FULL_FORMS']);
// The rule forms this file builds (slLaws.assertRulesBuilt refuses any other in the rows above).
const FOOD_RULES = Object.freeze(['packetByContext', 'radialProfile', 'naturalRadByte', 'weightedColour',
  'batchByDistance', 'noExpiry']);

const CELLS = 256; // food cell byte per axis inside a sector (L2; slGrid CELLS_PER_SECTOR)
const COLOURS = 9; // L28: natural food colours 0 to 8

function bad(id, what) {
  throw new Error('slFood: law ' + id + ' ' + what);
}

function bandsOf(id, v) {
  const b = v && v.bands;
  if (!Array.isArray(b) || b.length === 0) bad(id, 'needs bands');
  let last = 0;
  for (const row of b) {
    if (!Array.isArray(row) || row.length !== 2) bad(id, 'band is not [edge, value]');
    const [edge, val] = row;
    if (!(typeof edge === 'number' && edge > last && edge <= 1)) bad(id, 'band edges must rise to 1');
    if (!(typeof val === 'number' && Number.isFinite(val) && val >= 0)) bad(id, 'band value must be >= 0');
    last = edge;
  }
  if (last !== 1) bad(id, 'last band edge must be 1');
  return Object.freeze(b.map((r) => Object.freeze([r[0], r[1]])));
}

// The food laws as plain numbers, checked once.
function foodLaws(laws) {
  assertLawsComplete(laws, FOOD_LAW_IDS);
  assertRulesBuilt(laws, FOOD_LAW_IDS, FOOD_RULES);
  const v = (id) => laws[id].value;
  const l25 = v('L25');
  if (l25.natural !== 'f' || l25.drop !== 'b' || l25.dump !== 'F') bad('L25', 'must map natural f, drop b, dump F');
  const l27 = v('L27');
  if (!(Number.isInteger(l27.base) && l27.base >= 0 && typeof l27.span === 'number' && l27.span > 0 &&
    l27.base + Math.floor(l27.span) <= 255)) bad('L27', 'needs base and span inside a byte');
  const w = v('L28').weights;
  if (!Array.isArray(w) || w.length !== COLOURS || !w.every((x) => typeof x === 'number' && x >= 0)) {
    bad('L28', 'needs 9 weights >= 0');
  }
  const wTotal = w.reduce((s, x) => s + x, 0);
  if (!(wTotal > 0)) bad('L28', 'weights sum to 0');
  const period = v('L29.period');
  if (!(typeof period === 'number' && period > 0 && Number.isFinite(period))) bad('L29.period', 'must be a positive number');
  const rate = v('L29.rate');
  if (!(typeof rate.guardMult === 'number' && rate.guardMult > 0)) bad('L29.rate', 'needs guardMult > 0');
  if (v('C_FOOD_SCALE') !== 'fractionOfRadius') bad('C_FOOD_SCALE', 'only fractionOfRadius is built');
  const out = v('C_OUTSIDE_FOOD');
  if (!out || out.naturalInsideOnly !== true || out.outsideStays !== true) {
    bad('C_OUTSIDE_FOOD', 'only naturalInsideOnly and outsideStays are built');
  }
  if (v('C_DROP_CELL') !== 'nearestFreeInSector') bad('C_DROP_CELL', 'only nearestFreeInSector is built');
  if (v('C_FOOD_FULL_FORMS') !== true) bad('C_FOOD_FULL_FORMS', 'only the full forms are built');
  return Object.freeze({
    grd: v('L1'),
    sectorSize: v('L2.size'),
    radBase: l27.base,
    radSpan: l27.span,
    weights: Object.freeze(w.slice()),
    wTotal,
    period,
    guardMult: rate.guardMult,
    targetBands: bandsOf('L26', v('L26')),
    rateBands: bandsOf('L29.rate', rate),
  });
}

// The value of the band holding fraction f: bands are [upper edge, value], a band is [previous edge, edge). f at or
// past 1 (a sector whose centre lies outside the border but which the border still cuts) takes the last band.
function bandValue(bands, f) {
  for (let i = 0; i < bands.length; i++) if (f < bands[i][0]) return bands[i][1];
  return bands[bands.length - 1][1];
}

// opts: grid (slGrid, built on L1 and L2), rng (the sim's 'food' stream), startMs (sim time of the room start; the
// first pass is one L29 period later).
function createFood(laws, opts) {
  const o = opts || {};
  const K = foodLaws(laws);
  const grid = o.grid;
  const rng = o.rng;
  if (!grid || typeof grid.foodPut !== 'function') throw new TypeError('slFood: needs the sim grid');
  if (grid.sectorSize !== K.sectorSize || grid.grd !== K.grd) throw new Error('slFood: grid is not on the L1 and L2 lattice');
  if (typeof rng !== 'function' || typeof rng.next !== 'function') throw new TypeError('slFood: needs a seeded rng stream');
  const startMs = o.startMs === undefined ? 0 : o.startMs;
  if (typeof startMs !== 'number' || !Number.isFinite(startMs)) throw new TypeError('slFood: startMs must be a finite number');

  const SS = K.sectorSize;
  const CELL = SS / CELLS;
  const natCount = new Int32Array(grid.sectorTotal); // natural foods per sector (the L29 guard counts these only)
  const st = { natural: 0, drops: 0, spawned: 0, filled: 0, dropped: 0, eatenNatural: 0, eatenDrop: 0, passes: 0,
    outside: 0, moved: 0, lost: 0 };
  let due = startMs + K.period;
  // per-tick lists (reused): foods added this tick (spawns and drops, in call order) and eats ({food, eater, ev})
  const tick = { adds: [], eats: [] };
  const dumps = new Map(); // sector -> food_sector event, made once per tick
  const scratch = [];

  // ---- placement

  // The free cell of sector (sx, sy) nearest to (rx, ry), the cell itself first (C_DROP_CELL). Rings by Chebyshev
  // distance k; inside the search the smallest Euclidean distance wins, ties to the first in scan order (rows, then
  // columns); the search stops once no farther ring can hold a nearer cell (every cell of ring k is at least k away).
  // Returns the food id (signed for sx >= 128, as the client's), or null when the whole sector is full.
  function freeCell(sx, sy, rx, ry) {
    const id0 = cellId(sx, sy, rx, ry);
    if (!grid.foodHas(id0)) return id0;
    let best = null;
    let bestD2 = Infinity;
    for (let k = 1; k < CELLS; k++) {
      if (k * k > bestD2) break;
      for (let y = ry - k; y <= ry + k; y++) {
        if (y < 0 || y >= CELLS) continue;
        const edgeRow = y === ry - k || y === ry + k;
        for (let x = rx - k; x <= rx + k; x += edgeRow ? 1 : 2 * k) {
          if (x < 0 || x >= CELLS) continue;
          const d2 = (x - rx) * (x - rx) + (y - ry) * (y - ry);
          if (d2 >= bestD2) continue;
          const id = cellId(sx, sy, x, y);
          if (!grid.foodHas(id)) {
            best = id;
            bestD2 = d2;
          }
        }
      }
    }
    return best;
  }

  function cellId(sx, sy, rx, ry) {
    return (sx << 24) | (sy << 16) | (rx << 8) | ry;
  }

  function makeFood(id, cv, b, nat) {
    const sx = (id >>> 24) & 255;
    const sy = (id >>> 16) & 255;
    const rx = (id >>> 8) & 255;
    const ry = id & 255;
    const food = {
      id,
      sx,
      sy,
      rx,
      ry,
      x: grid.foodX(id), // the client's own position of the cell (slApply.js:1051-1052)
      y: grid.foodY(id),
      si: grid.foodSector(id),
      cv,
      b,
      rad: b / 5, // the client's rad = byte / 5 (game.js:8610)
      nat,
      ev: null,
    };
    if (!grid.foodPut(id, food)) throw new Error('slFood: cell ' + id + ' taken');
    if (nat) {
      natCount[food.si]++;
      st.natural++;
    } else {
      st.drops++;
    }
    return food;
  }

  // ---- the border disc and its sectors (C_FOOD_SCALE: fraction of the current border radius)

  function needFlux(flux) {
    if (!(typeof flux === 'number' && flux > 0 && Number.isFinite(flux))) throw new RangeError('slFood: flux must be > 0');
    return flux;
  }

  // fn(sx, sy, si, f) for every sector the border disc touches, row-major; f = the sector centre's distance from
  // (grd, grd) as a fraction of the border radius.
  function forEachBorderSector(flux, fn) {
    const c = K.grd;
    const s0x = grid.sectorOf(c - flux);
    const s1x = grid.sectorOf(c + flux);
    const r2 = flux * flux;
    for (let sy = s0x; sy <= s1x; sy++) {
      const y0 = sy * SS;
      const dy = c < y0 ? y0 - c : c > y0 + SS ? c - y0 - SS : 0;
      for (let sx = s0x; sx <= s1x; sx++) {
        const x0 = sx * SS;
        const dx = c < x0 ? x0 - c : c > x0 + SS ? c - x0 - SS : 0;
        if (dx * dx + dy * dy > r2) continue;
        const cx = x0 + SS / 2 - c;
        const cy = y0 + SS / 2 - c;
        fn(sx, sy, sy * grid.perAxis + sx, Math.sqrt(cx * cx + cy * cy) / flux);
      }
    }
  }

  function inside(x, y, flux) {
    const dx = x - K.grd;
    const dy = y - K.grd;
    return dx * dx + dy * dy <= flux * flux;
  }

  // ---- natural food (L27 size, L28 colour), four draws: rx, ry, size, colour

  function radByteDraw() {
    return K.radBase + Math.floor(K.radSpan * rng.next());
  }

  function colourDraw() {
    let u = rng.next() * K.wTotal;
    for (let i = 0; i < COLOURS - 1; i++) {
      u -= K.weights[i];
      if (u < 0) return i;
    }
    return COLOURS - 1;
  }

  // One natural food at a uniform cell of sector (sx, sy). A cell outside the border disc spawns nothing (the draws
  // are spent): no natural food outside the border (C_OUTSIDE_FOOD). Returns the food or null.
  function naturalIn(sx, sy, flux) {
    const rx = rng.int(CELLS);
    const ry = rng.int(CELLS);
    const b = radByteDraw();
    const cv = colourDraw();
    if (!inside(sx * SS + rx * CELL, sy * SS + ry * CELL, flux)) {
      st.outside++;
      return null;
    }
    const id = freeCell(sx, sy, rx, ry);
    if (id === null) {
      st.lost++;
      return null;
    }
    if (id !== cellId(sx, sy, rx, ry)) st.moved++;
    return makeFood(id, cv, b, true);
  }

  // Knuth's Poisson draw (mean lam), for the initial fill only.
  function poisson(lam) {
    if (!(lam > 0)) return 0;
    const L = Math.exp(-lam);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= rng.next();
    } while (p > L);
    return k - 1;
  }

  // Initial fill at room start: every sector the border touches gets a Poisson count with the L26 target as its mean
  // (the measured value is a mean per sector), each a natural food as a pass would make it. No records: nobody is
  // seated yet; the sector dumps carry it. Returns the number placed.
  function fill(flux) {
    needFlux(flux);
    let n = 0;
    forEachBorderSector(flux, (sx, sy, si, f) => {
      const k = poisson(bandValue(K.targetBands, f));
      for (let i = 0; i < k; i++) if (naturalIn(sx, sy, flux)) n++;
    });
    st.filled += n;
    return n;
  }

  // One L29 pass: each sector the border touches that holds fewer natural foods than guardMult x its L26 target
  // spawns one with chance rate(f) x period / 1000 (L29.rate). One draw per such sector, four more on a spawn.
  function pass(flux) {
    needFlux(flux);
    st.passes++;
    const per = K.period / 1000;
    forEachBorderSector(flux, (sx, sy, si, f) => {
      if (natCount[si] >= K.guardMult * bandValue(K.targetBands, f)) return;
      if (!(rng.next() < bandValue(K.rateBands, f) * per)) return;
      const food = naturalIn(sx, sy, flux);
      if (food) {
        st.spawned++;
        tick.adds.push(food);
      }
    });
  }

  // Runs the L29 pass when due (one per call). Returns true when a pass ran.
  function step(nowMs, flux) {
    if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) throw new TypeError('slFood: nowMs must be a finite number');
    if (nowMs < due) return false;
    pass(flux);
    due += K.period;
    return true;
  }

  function beginTick() {
    tick.adds.length = 0;
    tick.eats.length = 0;
    dumps.clear();
  }

  // ---- drops (L24 boost, L39 death): the caller places them; the food goes to the cell of (x, y), clamped to the
  // map, or the nearest free cell of that sector. b: rad byte; cv: colour 0 to 8 (L24.colour.skin, L39.colour.skin).
  function drop(x, y, b, cv) {
    if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) {
      throw new TypeError('slFood: drop position must be finite');
    }
    if (!Number.isInteger(b) || b < 0 || b > 255) throw new RangeError('slFood: drop rad byte must be 0..255');
    if (!Number.isInteger(cv) || cv < 0 || cv >= COLOURS) throw new RangeError('slFood: drop colour must be 0..8');
    const id0 = grid.foodIdAt(x, y);
    const id = freeCell((id0 >>> 24) & 255, (id0 >>> 16) & 255, (id0 >>> 8) & 255, id0 & 255);
    if (id === null) {
      st.lost++;
      return null;
    }
    if (id !== id0) st.moved++;
    const food = makeFood(id, cv, b, false);
    st.dropped++;
    tick.adds.push(food);
    return food;
  }

  // ---- eats: every eat has an eater (never 'c', L30)

  function eat(food, eater) {
    if (!Number.isInteger(eater) || eater < 1 || eater > 65535) throw new RangeError('slFood: eater must be a snake id');
    if (!food || grid.foodGet(food.id) !== food) throw new Error('slFood: that food is not on the map');
    grid.foodDel(food.id);
    if (food.nat) {
      natCount[food.si]--;
      st.natural--;
      st.eatenNatural++;
    } else {
      st.drops--;
      st.eatenDrop++;
    }
    const ev = { type: 'food_eat', cmd: '<', sectorFromLast: false, sx: food.sx, sy: food.sy, rx: food.rx, ry: food.ry,
      eater };
    tick.eats.push({ food, eater, ev });
    return ev;
  }

  // fn(food) for every food whose cell position lies within r of (cx, cy) (distance <= r), in sector row-major order
  // and the grid's order inside a sector. Collected first, so fn may eat. Returns the count.
  function forEachInDisc(cx, cy, r, fn) {
    if (!(Number.isFinite(cx) && Number.isFinite(cy) && Number.isFinite(r) && r >= 0)) {
      throw new RangeError('slFood: disc must be finite');
    }
    scratch.length = 0;
    const r2 = r * r;
    const sx0 = grid.sectorOf(cx - r);
    const sx1 = grid.sectorOf(cx + r);
    const sy0 = grid.sectorOf(cy - r);
    const sy1 = grid.sectorOf(cy + r);
    for (let sy = sy0; sy <= sy1; sy++) {
      for (let sx = sx0; sx <= sx1; sx++) {
        grid.forEachFoodIn(sy * grid.perAxis + sx, (id, food) => {
          const dx = food.x - cx;
          const dy = food.y - cy;
          if (dx * dx + dy * dy <= r2) scratch.push(food);
        });
      }
    }
    const n = scratch.length;
    for (let i = 0; i < n; i++) fn(scratch[i]);
    scratch.length = 0;
    return n;
  }

  // ---- records

  // The food's food_add (L25: natural `f` slow pop-in, drop `b` fast pop-in), full form, made once per food.
  function addEvent(food) {
    if (!food.ev) {
      food.ev = { type: 'food_add', rapid: !food.nat, sectorFromLast: false, sx: food.sx, sy: food.sy, rx: food.rx,
        ry: food.ry, cvFromLast: false, cv: food.cv, rad: food.rad };
    }
    return food.ev;
  }

  // The sector dump (L25 `F`) of sector si, or null when it holds no food (L8.adds: nothing when empty). Made once per
  // tick per sector.
  function dumpEvent(si) {
    if (!Number.isInteger(si) || si < 0 || si >= grid.sectorTotal) throw new RangeError('slFood: bad sector ' + si);
    if (dumps.has(si)) return dumps.get(si);
    let ev = null;
    if (grid.foodCountIn(si) > 0) {
      const foods = [];
      grid.forEachFoodIn(si, (id, f) => foods.push({ cv: f.cv, rx: f.rx, ry: f.ry, rad: f.rad }));
      ev = { type: 'food_sector', sx: grid.sectorX(si), sy: grid.sectorY(si), foods };
    }
    dumps.set(si, ev);
    return ev;
  }

  // ---- reads

  function get(id) {
    return grid.foodGet(id);
  }

  function forEachFood(fn) {
    for (let si = 0; si < grid.sectorTotal; si++) if (grid.foodCountIn(si) > 0) grid.forEachFoodIn(si, (id, f) => fn(f));
  }

  function naturalIn_(si) {
    return natCount[si];
  }

  // Report only (the standing total is never a target).
  function stats() {
    return Object.assign({ standing: st.natural + st.drops, due }, st);
  }

  // Invariants for the soak: every food sits in its own cell at the client position of its id, the per-sector natural
  // counts equal a recount, totals agree. Returns problem strings (allocates; never per tick).
  function check() {
    const problems = grid.check();
    const nat = new Int32Array(grid.sectorTotal);
    let n = 0;
    let d = 0;
    forEachFood((f) => {
      if (grid.foodGet(f.id) !== f) problems.push('food ' + f.id + ' not in its cell');
      if (f.x !== grid.foodX(f.id) || f.y !== grid.foodY(f.id)) problems.push('food ' + f.id + ' off its cell position');
      if (f.nat) {
        nat[f.si]++;
        n++;
      } else {
        d++;
      }
    });
    for (let si = 0; si < grid.sectorTotal; si++) if (nat[si] !== natCount[si]) problems.push('sector ' + si + ' natural count');
    if (n !== st.natural) problems.push('natural total differs');
    if (d !== st.drops) problems.push('drop total differs');
    if (n + d !== grid.foodTotal()) problems.push('grid food total differs');
    return problems;
  }

  // FNV-1a 32 over every food (sector order) and the pass clock; for the sim digest.
  function digest() {
    let h = 0x811c9dc5;
    const mix = (x) => {
      h ^= x & 255;
      h = Math.imul(h, 0x01000193);
      h ^= (x >>> 8) & 255;
      h = Math.imul(h, 0x01000193);
      h ^= (x >>> 16) & 255;
      h = Math.imul(h, 0x01000193);
      h ^= (x >>> 24) & 255;
      h = Math.imul(h, 0x01000193);
    };
    forEachFood((f) => {
      mix(f.id);
      mix(f.cv | (f.b << 8) | (f.nat ? 1 << 16 : 0));
    });
    mix(st.passes);
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  return {
    K,
    tick,
    fill,
    pass,
    step,
    beginTick,
    drop,
    eat,
    forEachInDisc,
    addEvent,
    dumpEvent,
    get,
    forEachFood,
    naturalCountIn: naturalIn_,
    targetAt: (f) => bandValue(K.targetBands, f),
    rateAt: (f) => bandValue(K.rateBands, f),
    forEachBorderSector,
    stats,
    check,
    digest,
    due: () => due,
  };
}

module.exports = { createFood, foodLaws, bandValue, FOOD_LAW_IDS, FOOD_RULES };
