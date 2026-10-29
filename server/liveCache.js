'use strict';
/* ─── /api/live's answer, shared while the site is busy ────────────────────────
   Night review 2026-10-29 (capacity): building the lobby board costs about 1 ms
   of the main thread per request, the same thread that runs every game, and
   every lobby polls it. Unshared, a few thousand lobbies (or one client
   looping on it) is a real share of the tick budget.

   So the JSON is kept for up to ttlMs (1 s) and handed to every caller in that
   time, but only once the site is busy: the first freshPerSec requests in each
   second are always built fresh. A quiet site, the owner flipping a switch and
   reading the board, the deploy check, and the tests all see exactly what they
   saw before; a crowd costs at most about freshPerSec + 1 builds a second
   however many lobbies poll. The push to watching lobbies (live:watch) already
   builds once a second and is untouched. */

function liveCache(build, opts = {}) {
  const ttlMs = opts.ttlMs || 1000;
  const freshPerSec = opts.freshPerSec === undefined ? 10 : opts.freshPerSec;
  const now = opts.now || Date.now;
  let body = null, at = 0, winStart = -Infinity, builds = 0;
  return function liveJson() {
    const t = now();
    if (t - winStart >= 1000) { winStart = t; builds = 0; }
    if (body !== null && builds >= freshPerSec && t - at < ttlMs) return body;
    body = JSON.stringify(build());
    at = t;
    builds++;
    return body;
  };
}

module.exports = { liveCache };
