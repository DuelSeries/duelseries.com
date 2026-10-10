'use strict';
// The moving border of the slither free room (SERVER-DESIGN 10, task T7; SERVER-LAWS L11, L51 and section M).
//
// Owen (OWNER-ANSWERS.md:31, :71-72, :77, :105): the map shrinks when quiet and grows back as snakes join, at the
// crowd per area of a real slither.io server (one snake per 1.22 M square units), the border moving at most about 47
// units per second, the smallest map sized for 22 snakes.
//
// Rule (every number by law id, read through slLaws; nothing else is a number here):
//   target   R* = sqrt(N x L51 / pi), N = live snakes (players and bots, L11.driver count 'allSnakes'), clamped to
//            [C_R_MIN, C_R_MAX]; C_R_MIN is the target radius at C_R_MIN.snakes. L11.driver says the flux is an
//            integer, so the target is R* rounded to the nearest integer (SERVER-LAWS section M's own examples round
//            this way: N 22 gives 2923).
//   motion   the integer radius moves toward the target by at most L11.step.units per check; checks run on the
//            L11.step.everyMs grid from room start (t0 + k x everyMs, so the mean period is exact). L11.driver start
//            'target': at room start the radius IS the target.
//   N        the time-weighted mean of the live count over the trailing C_N_SMOOTH_MS (so one death does not move the
//            border; SERVER-DESIGN 4.3, 10). With less history than the window, the mean is over the history there is.
//
// Clock (SERVER-DESIGN 5.1, 5.3 step 7): tick(nowMs, count) is called once per sim tick with the sim clock and the
// live snake count after that tick. A check fires on the first tick at or after its due time, at most ONE per tick,
// and the next due time is the first grid time after that tick. Checks missed by a gap longer than one period (an
// idle pause, a dropped backlog) are dropped and counted, never paid back as one big move.
//
// Pure and deterministic: no randomness, no wall clock, no io. Nothing here allocates per tick except the count ring
// growing (doubling) when the count changes more often than it ever has inside one window.
//
// Driver shape (kept for the event's own ring later, SERVER-DESIGN 10, design-ops-layer C): radius(), target(),
// due(), tick(nowMs, count), stats().

const { assertLawsComplete, assertRulesBuilt } = require('./slLaws');

const BORDER_LAW_IDS = Object.freeze([
  'L1', 'L2.size', 'L11.driver', 'L11.step', 'L51', 'C_R_MIN', 'C_R_MAX', 'C_N_SMOOTH_MS',
]);
const BUILT_RULES = Object.freeze(['crowdDensity']);

// The L11.driver form this file builds; any other parameter or value is refused (a table may not ask for a driver
// nobody wrote).
const DRIVER_FORM = Object.freeze({ rule: 'crowdDensity', count: 'allSnakes', integer: true, start: 'target' });

function isPosFinite(x) {
  return typeof x === 'number' && Number.isFinite(x) && x > 0;
}
function isPosInt(x) {
  return Number.isInteger(x) && x > 0;
}

// R* before rounding and clamping: sqrt(N x L51 / pi), L51 = area per snake (SERVER-LAWS L51, section M item 2).
function rawRadius(n, area) {
  return Math.sqrt((n * area) / Math.PI);
}

const CONFIGS = new WeakMap();

// Reads and checks every border row once per (frozen) table. Throws naming the problem.
function borderConfig(laws) {
  if (laws && typeof laws === 'object' && CONFIGS.has(laws)) return CONFIGS.get(laws);
  assertLawsComplete(laws, BORDER_LAW_IDS);
  assertRulesBuilt(laws, BORDER_LAW_IDS, BUILT_RULES);

  const driver = laws['L11.driver'].value;
  if (!driver || typeof driver !== 'object' || Array.isArray(driver)) {
    throw new TypeError('slBorder: L11.driver must be a rule row');
  }
  for (const k of Object.keys(driver)) {
    if (!Object.prototype.hasOwnProperty.call(DRIVER_FORM, k)) {
      throw new Error('slBorder: L11.driver parameter ' + k + ' is not built');
    }
  }
  for (const k of Object.keys(DRIVER_FORM)) {
    if (driver[k] !== DRIVER_FORM[k]) {
      throw new Error('slBorder: L11.driver ' + k + ' = ' + JSON.stringify(driver[k]) + ' is not built (built: ' +
        JSON.stringify(DRIVER_FORM[k]) + ')');
    }
  }

  const area = laws.L51.value;
  if (!isPosFinite(area)) throw new TypeError('slBorder: L51 (area per snake) must be a positive number');
  const rmin = laws.C_R_MIN.value;
  const minSnakes = rmin && typeof rmin === 'object' ? rmin.snakes : undefined;
  if (!isPosInt(minSnakes)) throw new TypeError('slBorder: C_R_MIN.snakes must be a positive integer');
  const rMax = laws.C_R_MAX.value;
  if (!isPosInt(rMax)) throw new TypeError('slBorder: C_R_MAX must be a positive integer radius');
  const st = laws['L11.step'].value;
  const units = st && typeof st === 'object' ? st.units : undefined;
  const everyMs = st && typeof st === 'object' ? st.everyMs : undefined;
  if (!isPosInt(units)) throw new TypeError('slBorder: L11.step.units must be a positive integer');
  if (!isPosFinite(everyMs)) throw new TypeError('slBorder: L11.step.everyMs must be a positive number');
  const smoothMs = laws.C_N_SMOOTH_MS.value;
  if (!isPosFinite(smoothMs)) throw new TypeError('slBorder: C_N_SMOOTH_MS must be a positive number');
  const grd = laws.L1.value;
  const sectorSize = laws['L2.size'].value;
  if (!isPosFinite(grd) || !isPosFinite(sectorSize)) throw new TypeError('slBorder: L1 and L2.size must be positive');

  const rMin = Math.round(rawRadius(minSnakes, area));
  if (rMin > rMax) throw new RangeError('slBorder: C_R_MIN radius ' + rMin + ' is above C_R_MAX ' + rMax);
  // The disc must stay on the lattice slGrid indexes (0 to 2 grd, L1 and L2), and SERVER-DESIGN 10: grd + C_R_MAX
  // inside 255 x sector_size, so every sector index stays a byte.
  if (rMax > grd) throw new RangeError('slBorder: C_R_MAX ' + rMax + ' leaves the map lattice (grd ' + grd + ')');
  if (grd + rMax > 255 * sectorSize) throw new RangeError('slBorder: grd + C_R_MAX is past 255 sectors');

  const cfg = Object.freeze({ area, minSnakes, rMin, rMax, units, everyMs, smoothMs });
  if (laws && typeof laws === 'object' && Object.isFrozen(laws)) CONFIGS.set(laws, cfg);
  return cfg;
}

function checkCount(n, what) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
    throw new RangeError('slBorder: ' + what + ' must be a finite number at or above 0, got ' + String(n));
  }
}

function targetOf(n, cfg) {
  const r = Math.round(rawRadius(n, cfg.area));
  return r < cfg.rMin ? cfg.rMin : r > cfg.rMax ? cfg.rMax : r;
}

// The integer radius the border moves toward for a (possibly averaged) live snake count n.
function targetRadius(n, laws) {
  checkCount(n, 'the snake count');
  return targetOf(n, borderConfig(laws));
}

// One check: the integer radius after moving from state.radius toward state.target by at most L11.step.units.
function step(state, laws) {
  const cfg = borderConfig(laws);
  const radius = state && state.radius;
  const target = state && state.target;
  if (!Number.isInteger(radius) || !Number.isInteger(target)) {
    throw new TypeError('slBorder: step needs integer radius and target');
  }
  const d = target - radius;
  return radius + (d > cfg.units ? cfg.units : d < -cfg.units ? -cfg.units : d);
}

// Time-weighted mean of a piecewise-constant count over the trailing window. Change points live in a ring
// (time, count); a count holds from its time until the next point's time (or now).
function createCountMean(windowMs, t0, n0) {
  let cap = 64;
  let ts = new Float64Array(cap);
  let ns = new Float64Array(cap);
  let head = 0;
  let len = 0;
  let lastT = t0;

  function at(i) {
    return (head + i) % cap;
  }
  function grow() {
    const nts = new Float64Array(cap * 2);
    const nns = new Float64Array(cap * 2);
    for (let i = 0; i < len; i++) {
      nts[i] = ts[at(i)];
      nns[i] = ns[at(i)];
    }
    ts = nts;
    ns = nns;
    head = 0;
    cap *= 2;
  }
  function push(t, n) {
    if (len === cap) grow();
    const j = at(len);
    ts[j] = t;
    ns[j] = n;
    len++;
  }
  // Drops points that ended at or before the window start (the newest one at or before it stays: it covers the start).
  function prune(now) {
    const lo = now - windowMs;
    while (len >= 2 && ts[at(1)] <= lo) {
      head = (head + 1) % cap;
      len--;
    }
  }

  push(t0, n0);

  return {
    observe(t, n) {
      if (t < lastT) throw new RangeError('slBorder: the clock went back from ' + lastT + ' to ' + t);
      lastT = t;
      const j = at(len - 1);
      if (ns[j] !== n) {
        if (ts[j] === t) ns[j] = n;
        else push(t, n);
      }
      prune(t);
    },
    value(now) {
      const lo = Math.max(t0, now - windowMs);
      const span = now - lo;
      if (!(span > 0)) return ns[at(len - 1)];
      let sum = 0;
      for (let i = 0; i < len; i++) {
        const j = at(i);
        const a = ts[j] > lo ? ts[j] : lo;
        const b = i + 1 < len ? ts[at(i + 1)] : now;
        if (b > a) sum += ns[j] * (b - a);
      }
      return sum / span;
    },
    points() {
      return len;
    },
  };
}

// The border driver for one room. opts: { nowMs, count } = the sim clock and live snake count at room start.
function createBorder(laws, opts) {
  const cfg = borderConfig(laws);
  const t0 = opts && opts.nowMs !== undefined ? opts.nowMs : 0;
  const n0 = opts && opts.count;
  if (typeof t0 !== 'number' || !Number.isFinite(t0)) throw new TypeError('slBorder: nowMs must be a finite number');
  if (!Number.isInteger(n0) || n0 < 0) throw new RangeError('slBorder: count must be an integer at or above 0');

  const mean = createCountMean(cfg.smoothMs, t0, n0);
  let now = t0;
  let radius = targetOf(n0, cfg); // L11.driver start 'target'
  let idx = 1; // next check on the grid t0 + idx x everyMs
  let due = t0 + cfg.everyMs;
  let checks = 0;
  let dropped = 0;

  // The smallest grid index whose time is after t (the float division is fixed up so due is always > t).
  function nextIndexAfter(t) {
    let k = Math.floor((t - t0) / cfg.everyMs) + 1;
    while (t0 + k * cfg.everyMs <= t) k++;
    while (k > 1 && t0 + (k - 1) * cfg.everyMs > t) k--;
    return k;
  }

  return {
    radius() {
      return radius;
    },
    // The integer target from the mean count at the last tick.
    target() {
      return targetOf(mean.value(now), cfg);
    },
    due() {
      return due;
    },
    // Once per sim tick, after the tick's deaths and spawns. Returns true when a check fired on this tick.
    tick(nowMs, count) {
      if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
        throw new TypeError('slBorder: nowMs must be a finite number');
      }
      if (!Number.isInteger(count) || count < 0) throw new RangeError('slBorder: count must be an integer at or above 0');
      mean.observe(nowMs, count);
      now = nowMs;
      if (nowMs < due) return false;
      const next = nextIndexAfter(nowMs);
      dropped += next - idx - 1;
      idx = next;
      due = t0 + idx * cfg.everyMs;
      checks++;
      const target = targetOf(mean.value(nowMs), cfg);
      const d = target - radius;
      radius += d > cfg.units ? cfg.units : d < -cfg.units ? -cfg.units : d;
      return true;
    },
    stats() {
      return { radius, target: targetOf(mean.value(now), cfg), meanCount: mean.value(now), checks, dropped, due };
    },
  };
}

module.exports = {
  BORDER_LAW_IDS,
  BUILT_RULES,
  borderConfig,
  targetRadius,
  step,
  createBorder,
  createCountMean,
};
