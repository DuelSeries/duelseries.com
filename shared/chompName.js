/* The name players see for Chomp. Owen 2026-10-26: "just change it to Pac-Man for now... we'll change it back
   later". Changing it back is this one line: NAME = 'Chomp'.

   Everything a player reads takes it from here: the lobby card (public/v2.html), the game page's title, title card
   and paid cards (public/js/chomp/chompMain.js, chompPaid.js), the paid door's refusals (server/chomp/chompBoot.js)
   and the join and earnings pushes (server/joinAlerts.js, server/earnAlerts.js). Ids, routes, keys and the owner's
   console stay 'chomp'. Shared links keep their plain word (shared/shareGames.js names no other publisher's game).
   ASCII only: the pushes put it in an ntfy Title header.

   Loaded as a plain script it lands on window.DS_CHOMP_NAME; required, it is module.exports. */
(function (root) {
  'use strict';
  var NAME = 'Pac-Man';
  if (typeof module !== 'undefined' && module.exports) module.exports = NAME;
  if (root) root.DS_CHOMP_NAME = NAME;
})(typeof window !== 'undefined' ? window : null);
