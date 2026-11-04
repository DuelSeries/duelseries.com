/* ─── 8 Ball Pool: where a press is, and how much power a pull is ─────────────
   Pure numbers for public/js/pool8.js, in the design frame of p8Art.js (1154 x 768, the table's left rail outer edge
   at x 105, the top bar 120 tall). Kept apart so test/pool8Controls.test.js can hold them.

   THE POWER STRIP (Owen 2026-11-04: "make the whole side of the screen, or at least make the area bigger, because
   it's really small and I keep misclicking"). Everything left of the table and under the top bar takes the pull: on
   a phone held sideways that is the whole left edge (the empty margin beside the frame included, as it maps to
   x < 0), on an upright phone (the frame turned a quarter) the whole band above the table, on a PC the whole left
   side. The old bar was 23 px wide on a phone and a tap in it set the power where it landed and shot.

   THE PULL IS RELATIVE. The power is how far the press has travelled down from where it went down, not where it
   is, so a tap, a resting thumb or a brush shoots nothing: the first DEAD units count for nothing, and a release
   under MIN is no shot. Full power is FULL units down, less when the press starts so low that FULL would run off
   the screen (never under MIN_FULL), so full power can always be reached. Back up to the start is a cancel. */
(function (root) {
  'use strict';
  const POWER = {
    zoneX: 113,       // the strip's right edge: the rail's outer edge (105) and a little
    zoneTop: 124,     // under the top bar (its menu button keeps the corner)
    dead: 10,         // travel that counts for nothing (a tap, a resting thumb)
    full: 300,        // travel for full power: 150 css px on a phone, 350 on a 1440 screen
    minFull: 160,     // a press near the bottom still gets a full pull in this much
    min: 0.02,        // the least power that shoots on release (as before)
  };
  function inPowerZone(x, y) { return x <= POWER.zoneX && y >= POWER.zoneTop; }
  // bottom: the lowest design y on the screen (the frame's foot, or past it on a tall window).
  function fullFor(y0, bottom) { return Math.max(POWER.minFull, Math.min(POWER.full, bottom - y0 - 8)); }
  function powerOf(y0, y, full) {
    const run = Math.max(1, (full || POWER.full) - POWER.dead);
    return Math.max(0, Math.min(1, (y - y0 - POWER.dead) / run));
  }
  const shoots = (p) => p >= POWER.min;
  const api = { POWER, inPowerZone, fullFor, powerOf, shoots };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.P8Controls = api;
})(typeof self !== 'undefined' ? self : this);
