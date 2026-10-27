/* How long a duel seat waits for a person before the countdown runs out: Knockout, Battleship, Head Soccer and
   Swim, server and page alike. Owen 2026-10-27: 60 s back down to 20 s so testing the games is quicker. Changing
   it back is this one line: WAIT_MS = 60000.

   A free table plays a bot at 0:00; a paid table only shows the countdown and keeps looking for a person (never a
   bot), with Cancel refunding as before (server/duelQueue.js).

   Loaded as a plain script it lands on window.DS_DUEL_WAIT_MS; required, it is module.exports. */
(function (root) {
  'use strict';
  var WAIT_MS = 20000;
  if (typeof module !== 'undefined' && module.exports) module.exports = WAIT_MS;
  if (root) root.DS_DUEL_WAIT_MS = WAIT_MS;
})(typeof window !== 'undefined' ? window : null);
