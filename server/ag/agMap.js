'use strict';
// Map shrink and border push for the agar.io server (CHOSEN, server laws 4; build brief 7.3; waiting for Owen).
//
// The map is a square centred on (0, 0). Its side follows the player count n:
//   side(n) = FULL_SIDE * sqrt(clamp(n, N_MIN, N_FULL) / N_FULL)       (same area per player, as Paper)
// It grows toward a bigger target at once, at GROW_FRAC of FULL_SIDE per second, and shrinks toward a smaller one
// at SHRINK_FRAC of FULL_SIDE per second, but only after SHRINK_DELAY_MS continuously below. Each step moves
// rate * dt, so nothing depends on the tick length. A shrinking border never kills: cells are pushed inside with
// the L3 rule (pushInside), and only food outside is removed by the sim (isOutside).
//
// Every number comes from the law table: FULL_SIDE = L2, N_FULL = L39, the rest are the MAP_* CHOSEN rows. This
// file holds no value of its own.

const { assertLawsComplete } = require('./agLaws');

const MAP_LAW_IDS = Object.freeze([
  'L2', 'L3', 'L39',
  'MAP_N_MIN', 'MAP_GROW_FRAC', 'MAP_SHRINK_FRAC', 'MAP_SHRINK_DELAY_MS', 'MAP_COUNT_BOTS', 'MAP_TARGET_ROUNDING',
]);

// Bit flags returned by pushInside so the sim can apply the L3 boost rule on the axis that was clamped.
const PUSHED_X = 1;
const PUSHED_Y = 2;

function finite(v, what) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError('agMap: ' + what + ' must be a finite number');
  return v;
}

// How many players the map is sized for (MAP_COUNT_BOTS decides whether bots count).
function countForMap(humans, bots, laws) {
  finite(humans, 'humans');
  finite(bots, 'bots');
  return laws.MAP_COUNT_BOTS.value ? humans + bots : humans;
}

function effectiveCount(n, laws) {
  finite(n, 'n');
  const lo = laws.MAP_N_MIN.value;
  const hi = laws.L39.value;
  return n < lo ? lo : n > hi ? hi : n;
}

function targetSide(n, laws) {
  return laws.L2.value * Math.sqrt(effectiveCount(n, laws) / laws.L39.value);
}

function growRate(laws) {
  return laws.L2.value * laws.MAP_GROW_FRAC.value;
}

function shrinkRate(laws) {
  return laws.L2.value * laws.MAP_SHRINK_FRAC.value;
}

function borderFor(side) {
  finite(side, 'side');
  const h = side / 2;
  return { minX: -h, minY: -h, maxX: h, maxY: h };
}

// A fresh map state for a room with n players: it starts at its target (CHOSEN), not below it.
// belowMs is null when the side is not above its target, else the time spent continuously above it.
function createMapState(laws, n) {
  assertLawsComplete(laws, MAP_LAW_IDS);
  return { side: targetSide(n === undefined ? 0 : n, laws), belowMs: null };
}

// One step of dtMs toward `target` (a side). Pure: returns a new state, never mutates the old one.
// The first step that finds the target below the side starts the wait at 0 ms; each later step adds its dt; the
// shrink applies on the first step whose wait has reached MAP_SHRINK_DELAY_MS (Paper's timing).
function stepSide(state, target, dtMs, laws) {
  finite(state && state.side, 'state.side');
  finite(target, 'target');
  finite(dtMs, 'dtMs');
  if (dtMs < 0) throw new RangeError('agMap: dtMs must not be negative');
  const side = state.side;
  if (target > side) {
    const next = side + (growRate(laws) * dtMs) / 1000;
    return { side: next < target ? next : target, belowMs: null };
  }
  if (target < side) {
    const belowMs = state.belowMs === null || state.belowMs === undefined ? 0 : state.belowMs + dtMs;
    if (belowMs >= laws.MAP_SHRINK_DELAY_MS.value) {
      const next = side - (shrinkRate(laws) * dtMs) / 1000;
      return { side: next > target ? next : target, belowMs };
    }
    return { side, belowMs };
  }
  return { side, belowMs: null };
}

// Keeps a cell's centre inside the border by the L3 rule: within [min + k * size, max - k * size] on each axis,
// k = L3 radiusFactor. Mutates cell.x / cell.y and returns PUSHED_X | PUSHED_Y for the axes it clamped (the caller
// reflects its boost on those axes when L3 reflectBoost is set). Never removes anything.
// A cell too big for the box on an axis goes to the box centre on that axis (CHOSEN; a guard only, it needs a cell
// whose k * size is over half the smallest side).
function pushInside(cell, border, laws) {
  const k = laws.L3.value.radiusFactor;
  const r = k * cell.size;
  let mask = 0;
  const loX = border.minX + r;
  const hiX = border.maxX - r;
  if (loX > hiX) {
    const c = (border.minX + border.maxX) / 2;
    if (cell.x !== c) { cell.x = c; mask |= PUSHED_X; }
  } else if (cell.x < loX) { cell.x = loX; mask |= PUSHED_X; } else if (cell.x > hiX) { cell.x = hiX; mask |= PUSHED_X; }
  const loY = border.minY + r;
  const hiY = border.maxY - r;
  if (loY > hiY) {
    const c = (border.minY + border.maxY) / 2;
    if (cell.y !== c) { cell.y = c; mask |= PUSHED_Y; }
  } else if (cell.y < loY) { cell.y = loY; mask |= PUSHED_Y; } else if (cell.y > hiY) { cell.y = hiY; mask |= PUSHED_Y; }
  return mask;
}

// True when a point lies outside the border (food outside a shrunk border is removed by the sim).
function isOutside(x, y, border) {
  return x < border.minX || x > border.maxX || y < border.minY || y > border.maxY;
}

// Food and virus targets scale with area (server laws 4.2): fullAmount * n_eff / N_FULL, rounded by
// MAP_TARGET_ROUNDING (CHOSEN 'floor').
function scaledTarget(fullAmount, n, laws) {
  finite(fullAmount, 'fullAmount');
  const v = (fullAmount * effectiveCount(n, laws)) / laws.L39.value;
  const rule = laws.MAP_TARGET_ROUNDING.value;
  if (rule === 'floor') return Math.floor(v);
  throw new Error('agMap: unsupported MAP_TARGET_ROUNDING ' + rule);
}

module.exports = {
  MAP_LAW_IDS,
  PUSHED_X,
  PUSHED_Y,
  countForMap,
  effectiveCount,
  targetSide,
  growRate,
  shrinkRate,
  borderFor,
  createMapState,
  stepSide,
  pushInside,
  isOutside,
  scaledTarget,
};
