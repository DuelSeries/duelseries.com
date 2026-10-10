/* Locked games: the one switch (BACKLOG 1.1, Owen 2026-10-09).

   A locked game keeps every file it has. What changes:
   - the lobby (public/v2.html) shows its card greyed with the padlock, like the
     unreleased games, and its screen says it is not playable yet;
   - the lobby's Open lobbies list drops its pinned row (public/js/v2/board.js);
   - the server (server/index.js) builds no room for it, answers none of its
     socket messages, leaves it out of /api/live, and sends its page URLs
     (/tanks, /tanks.html, /shooter, /shooter.html) to the lobby.

   To unlock a game, take its id out of this list and deploy. Nothing else has
   to change. Ids are the lobby's GAMES ids: 'omgshooter' is Awesome Tanks,
   'tanks' is Bowmasters.

   One file for both ends: the server requires it (CommonJS) and the lobby loads
   it as a plain script from /shared, where it lands on window.DS_LOCKED. */
(function (root) {
  'use strict';
  var LOCKED_GAMES = Object.freeze([
    'omgshooter',   // Awesome Tanks
    'tanks',        // Bowmasters
  ]);
  var api = Object.freeze({
    LOCKED_GAMES: LOCKED_GAMES,
    isLocked: function (id) { return LOCKED_GAMES.indexOf(id) !== -1; },
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.DS_LOCKED = api;
})(typeof window !== 'undefined' ? window : null);
