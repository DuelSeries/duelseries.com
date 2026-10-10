// slither.io redo: the pure math both ends must compute the same way (build brief section 11,
// spec core-apply.md section 2). The server requires this file (CommonJS) and the browser loads it
// as a plain script from /shared, where it lands on DuelSlither.slCore.
//
// Rules this module keeps:
// - Pure: no DOM, no timers, no random, no state of its own. Callers own every stored value
//   (slApply keeps S.smus, S.mscps, S.fmlts, S.fpsls; the server keeps its own copies).
// - Same arithmetic, same order as the reference client, so every result matches to the last bit
//   (no regrouping, Math.pow kept where they use it, float32 storage only where they use it).
// - No lower clamp on the size factor: sct 0 gives sc 0.98..., exactly as theirs.
(function (root, factory) {
  'use strict';
  var core = factory();
  var D = root.DuelSlither = root.DuelSlither || {};
  D.slCore = core;
  if (typeof module === 'object' && module && module.exports) module.exports = core;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var PI2 = 2 * Math.PI;      // game.js:125
  var K64A = PI2 / 65536;     // game.js:127, radians per unit of a 16-bit angle
  var NSEP = 4.5;             // game.js:1808, never written again
  var SMUC = 100;             // game.js:1909, length of the smus table
  var SMUC_M3 = SMUC - 3;     // game.js:1910, last index the chain pull walks to
  var SC_MAX = 6;             // game.js:7844, size factor ceiling
  var SMUS_FLAT = 4;          // game.js:1917, leading smus entries held at 1
  var SCORE_PAD = 2048;       // game.js:2003, copies of the last entry appended to both score tables

  // Size factor from the body count (game.js:7844, same text at 7625, 8500 and 8564).
  function scOf(sct) {
    return Math.min(SC_MAX, 1 + (sct - 2) / 106);
  }

  // Turn rate factor from the size factor (game.js:7845).
  function scangOf(sc) {
    return .13 + .87 * Math.pow((7 - sc) / 6, 2);
  }

  // Base speed from the size factor (game.js:7846). The boost speed fsp is this plus .1 (7847).
  function sspOf(sc, nsp1, nsp2) {
    return nsp1 + nsp2 * sc;
  }

  // Draw spacing between body circles, floored by the zoom (game.js:7848-7850).
  // gsc is the client zoom of that moment; the server never needs this value.
  function wsepOf(sc, gsc) {
    var w = 6 * sc;
    var floor = NSEP / gsc;
    if (w < floor) w = floor;
    return w;
  }

  // Speed as a fraction of spangdv, capped at 1 above, no floor (game.js:7591-7592, 8561-8562).
  function spangOf(sp, spangdv) {
    var v = sp / spangdv;
    if (v > 1) v = 1;
    return v;
  }

  // Length used by the tail ease: whole points plus the fill fraction, capped at 1 (game.js:2796).
  // Not for a new snake: there the client adds fam with no cap (game.js:2739, slApply's job).
  function tlOf(sct, fam) {
    return sct + Math.min(1, fam);
  }

  // The per-point spacing multipliers (game.js:1914-1926). A NEW Float32Array on every call, as
  // theirs: a reference kept across an init packet is stale, so callers read S.smus at use time.
  // Entries 0..3 are 1; after that the step grows by cst / 4 for four entries and then holds.
  function buildSmus(cst) {
    var table = new Float32Array(SMUC);
    var drop = 0;
    for (var i = 0; i < SMUC; i++) {
      var past = i - SMUS_FLAT + 1;          // 1 for the first entry after the flat part
      if (past <= 0) {
        table[i] = 1;
        continue;
      }
      if (past <= 4) drop = cst * past / 4;
      table[i] = 1 - drop;
    }
    return table;
  }

  // The two score tables for a given mscps (game.js:1990-2008), as plain float64 arrays.
  // Entries 0..mscps, then SCORE_PAD copies of the last entry of each. The caller decides whether
  // to rebuild (theirs only rebuilds when the value changed, game.js:1991).
  // Quirk kept: mscps 0 gives fmlts [undefined x 2049] and fpsls [0 x 2049].
  function buildScoreTables(mscps) {
    var mult = [];
    var sum = [];
    var i;
    // Pass 1: the score multiplier of each length step, (1 - i / mscps) ^ 2.25. The entry at mscps repeats the
    // one before it.
    for (i = 0; i <= mscps; i++) mult.push(i >= mscps ? mult[i - 1] : Math.pow(1 - i / mscps, 2.25));
    // Pass 2: running sums of 1 / multiplier, from 0, each adding the PREVIOUS step's term.
    for (i = 0; i <= mscps; i++) sum.push(i == 0 ? 0 : sum[i - 1] + 1 / mult[i - 1]);
    // Pad both with copies of their last entry.
    var lastMult = mult[mult.length - 1];
    var lastSum = sum[sum.length - 1];
    for (i = 0; i < SCORE_PAD; i++) {
      mult.push(lastMult);
      sum.push(lastSum);
    }
    return { fmlts: mult, fpsls: sum };
  }

  // Displayed length from the tables (game.js:6708, 7931, 8037, 9048). NaN past the table end, and NaN
  // before any table exists, exactly like theirs. (Their trailing "/ 1" changes no number.)
  function scoreOf(fmlts, fpsls, sct, fam) {
    return Math.floor((fpsls[sct] + fam / fmlts[sct] - 1) * 15 - 5);
  }

  // New head point one step of length msl from the last point along a 16-bit angle
  // (game.js:7728-7731 move packets, 8501-8506 last point of a new snake). The angle is computed
  // once and fed to both cos and sin. Returns [xx, yy].
  function headStep(lpoXX, lpoYY, iang, msl) {
    var a = iang * K64A;
    return [lpoXX + Math.cos(a) * msl, lpoYY + Math.sin(a) * msl];
  }

  // Pull every body point toward its headward neighbour after a new head point was pushed
  // (game.js:7801-7843). pts: tail at index 0, head last. The 3 headmost points never move; the
  // anchor is the third from the head. The pull strength grows by cst / 4 for the first 4 pulled
  // points and then holds at cst. Each pulled point also takes its spacing multiplier from smus,
  // walking indexes 3, 4, ... up to SMUC_M3 and then holding there. Dying points are pulled too.
  // onMove(point, dx, dy, dsmu) is optional: the client uses it to feed the point's ease rings
  // when the snake is in view; the server passes nothing.
  function chainPull(pts, cst, smus, onMove) {
    var anchor = pts.length - 3;
    if (anchor < 1) return;
    var ahead = pts[anchor];
    var pull = 0;
    var smuAt = 3;
    for (var i = anchor - 1, pulled = 1; i >= 0; i--, pulled++) {
      var p = pts[i];
      var wasX = p.xx;
      var wasY = p.yy;
      if (pulled <= 4) pull = cst * pulled / 4;
      p.xx += (ahead.xx - p.xx) * pull;
      p.yy += (ahead.yy - p.yy) * pull;
      var want = smus[smuAt];
      var smuShift = 0;
      if (p.smu != want) {
        var before = p.smu;
        p.smu = want;
        smuShift = p.smu - before;
      }
      if (smuAt < SMUC_M3) smuAt++;
      if (onMove) onMove(p, p.xx - wasX, p.yy - wasY, smuShift);
      ahead = p;
    }
  }

  return {
    PI2: PI2,
    K64A: K64A,
    NSEP: NSEP,
    SMUC: SMUC,
    SMUC_M3: SMUC_M3,
    SC_MAX: SC_MAX,
    scOf: scOf,
    scangOf: scangOf,
    sspOf: sspOf,
    wsepOf: wsepOf,
    spangOf: spangOf,
    tlOf: tlOf,
    buildSmus: buildSmus,
    buildScoreTables: buildScoreTables,
    scoreOf: scoreOf,
    headStep: headStep,
    chainPull: chainPull
  };
});
