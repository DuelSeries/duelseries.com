/* The stake ladder: the one list of buy-ins (BACKLOG 2.1, Owen 2026-10-09).

   Free, $0.50 and $1.00, in every game mode. $0.10 was retired because it
   could not cover what a paid room costs to run.

   Who reads it:
   - the server (server/stakeRules.js), which every paid door, the stake quote,
     the stake submit, the entry tokens, the room ids (s0.5) and the lobby rows
     derive from. Paper's arenas (server/paper/PaperArenas.js) read it through
     stakeRules too;
   - the lobby (public/v2.html), which loads this file from /shared as a plain
     script, where it lands on window.DS_LADDER. Its buy-in buttons for every
     game, and the stepper on the coming duel games, are drawn from LADDER.

   To change a rung, change PAID_RUNGS here and deploy. Nothing else holds a
   copy. A retired rung is refused everywhere: it cannot be quoted, staked,
   minted, seated or listed. Same shape as shared/lockedGames.js. */
(function (root) {
  'use strict';
  var PAID_RUNGS = Object.freeze([0.50, 1]);
  var LADDER = Object.freeze([0].concat(PAID_RUNGS));
  var api = Object.freeze({
    PAID_RUNGS: PAID_RUNGS,
    LADDER: LADDER,
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.DS_LADDER = api;
})(typeof window !== 'undefined' ? window : null);
