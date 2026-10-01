'use strict';
// Seeded random numbers for the agar.io server sim (CHOSEN, parity log C11).
//
// Algorithm: mulberry32, a public-domain 32-bit generator by Tommy Ettinger; this is our own port of the published
// algorithm, the same one our replay harness seeds the reference client with. The sim never touches Math.random,
// so two sims with the same seed and inputs stay identical.
//
// Every helper below consumes exactly ONE draw, so the draw count is easy to reason about in determinism tests.

const GOLDEN_GAMMA = 0x6d2b79f5;
const TWO_32 = 4294967296;

function createRng(seed) {
  if (typeof seed !== 'number' || !Number.isFinite(seed)) {
    throw new TypeError('agRng: seed must be a finite number');
  }
  let a = seed >>> 0;

  function next() {
    a = (a + GOLDEN_GAMMA) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / TWO_32;
  }

  const rng = function () {
    return next();
  };
  rng.next = next;
  // Integer in [0, n), n a positive integer.
  rng.int = function (n) {
    if (!Number.isInteger(n) || n <= 0) throw new RangeError('agRng.int: n must be a positive integer');
    return Math.floor(next() * n);
  };
  // Real in [lo, hi).
  rng.range = function (lo, hi) {
    return lo + next() * (hi - lo);
  };
  // True with probability p.
  rng.chance = function (p) {
    return next() < p;
  };
  // Generator state (uint32) for snapshots; setState restores it exactly.
  rng.state = function () {
    return a >>> 0;
  };
  rng.setState = function (s) {
    if (typeof s !== 'number' || !Number.isFinite(s)) throw new TypeError('agRng: state must be a finite number');
    a = s >>> 0;
  };
  return rng;
}

module.exports = { createRng };
