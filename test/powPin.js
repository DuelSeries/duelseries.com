'use strict';
// Math.pow pinned for the slither.io goldens (test/slSimGolden.json, test/slViewGolden.json and the synth-60hz row of
// test/slGoldenFrames.json.gz), so they replay on any host.
//
// Node 24's V8 hands Math.pow to the host's C library (the V8 flag --use-std-math-pow is on by default), and the host
// libraries do not round every pow alike. The goldens were cut on Owen's Windows box; the full suite runs on Linux
// (glibc), where two of the pows those runs make come out one ulp away from the cut:
//
//   pow(1 - 1.5 / 430, 2.25)  server/sl/slSnake.js famMult (L18 growth) at Lq 1.5. The exact value is 0.5001 ulp
//                             above glibc's 0.9921682701033643; the cut has the correctly rounded 0.9921682701033644.
//   pow(1 - 49 / 411, 2.25)   shared/slCore.js buildScoreTables, entry 49 at mscps 411 (the client's score table).
//                             glibc gives the correctly rounded 0.7515366844514406 (the exact value is 0.4999 ulp
//                             above it); the cut has the next double up, 0.7515366844514407.
//
// One ulp in a fam or in a score table entry moves every hash after it, so on Linux slSimGolden (seed 1 from window
// 801-900), slViewGolden (seed 31 from window 9) and the synth-60hz client golden (slParityGate, slMirror's vm page
// copy, slxNoTouch: frame 5 on) failed with no game code changed; they fail the same way at the commits that cut
// them. Found by recording every Math.pow input of those runs and checking each result against the exact value; with
// these two inputs pinned to the cut's values every golden passes, and each pin alone fixes its own goldens.
//
// On the cut's host the pin returns what its pow returns anyway. Every other input goes to the real Math.pow, so a
// change to what the game computes still moves the hashes. A golden that fails on one OS only: record the run's
// Math.pow inputs the same way before re-cutting anything.
//
// The goldens need Node 24 (Owen's 24.13.1). Node 22's V8 uses its own pow, which rounds many more of these inputs
// differently: every slither.io client golden and agFreeGolden fail there, pin or not.

const PINS = [
  [1 - 1.5 / 430, 2.25, 0.9921682701033644],
  [1 - 49 / 411, 2.25, 0.7515366844514407],
];

if (!Math.pow.__goldenPin) {
  const hostPow = Math.pow;
  const pinned = function pow(x, y) {
    for (let i = 0; i < PINS.length; i++) {
      if (x === PINS[i][0] && y === PINS[i][1]) return PINS[i][2];
    }
    return hostPow(x, y);
  };
  Object.defineProperty(pinned, '__goldenPin', { value: true });
  Object.defineProperty(Math, 'pow', { value: pinned, writable: true, configurable: true, enumerable: false });
}

module.exports = { PINS };
