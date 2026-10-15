// Phone portrait for the agar.io redo (ours: the reference page has no phone path). A touch screen
// held upright plays the portrait layout, the reference screen turned on its side (agCamera
// screenFactor and agHud hudScale with portrait set; the server sends the turned view box of the
// same area, ag:portrait), at the phone's own orientation. Turning the phone sideways gives the
// exact reference layout. There is no "turn your phone sideways" card any more (Owen 2026-10-15:
// "totally get rid of that"): the game simply plays the way the phone is held.
//
// agMain decides when the portrait layout applies (its portraitNow, the same rule as isPortrait
// below). Loaded by the shipped page only (public/ag.html); the parity harness never loads it.
(function (root) {
  'use strict';
  var A = root.DuelAgarLib = root.DuelAgarLib || {};

  // The portrait layout applies on a touch screen (coarse pointer) that is taller than wide. A
  // mouse screen of any shape keeps the reference layout, the parity harness's 390 x 844 included.
  function isPortrait(w, h, coarse) {
    return !!coarse && h > w;
  }

  A.agPortrait = { isPortrait: isPortrait };
  if (typeof module === 'object' && module.exports) module.exports = A.agPortrait;
})(typeof window !== 'undefined' ? window : globalThis);
