/* How long a duel seat waits for a person before the countdown runs out: every duel
   (Knockout, Battleship, Head Soccer, Swim, Rooftop, Crossy, Air Hockey, 8 Ball Pool), server and page alike. Owen 2026-10-27: 60 s down to 20 s; 2026-10-28: 10 s, so testing the games is quicker
   while nobody plays. Changing it back is this one line: WAIT_MS = 60000.

   A free table plays a bot at 0:00; a paid table keeps looking for a person (never a bot), its one card counting
   up how long you have waited (Owen 2026-10-30), with Cancel refunding as before (server/duelQueue.js).

   Loaded as a plain script it lands on window.DS_DUEL_WAIT_MS; required, it is module.exports. */
(function (root) {
  'use strict';
  var WAIT_MS = 10000;
  if (typeof module !== 'undefined' && module.exports) module.exports = WAIT_MS;
  if (root) root.DS_DUEL_WAIT_MS = WAIT_MS;
})(typeof window !== 'undefined' ? window : null);
