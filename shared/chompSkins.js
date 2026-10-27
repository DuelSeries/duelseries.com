/* Pac-Man's (chomp's) FREE skins (Owen, 2026-10-26: "make Customize work in Pac-Man"): a chomper colour you pick in
   Customize and keep, instead of the game's own look (yellow for you, a palette colour for everyone else).
   One list for both ends, like shared/agSkins.js: the lobby's chooser lists these (after the game's own look, before
   the Shop's locked skins) and the /chomp server accepts only an id from here (server/chomp/chompBoot.js skinOf), so a
   page can never ask for a colour that is not on it. None is a ghost's colour (red, pink, cyan, orange), so a
   chomper never reads as a ghost.

   The choice is stored in the lobby under duel.chomp.skin and sent by the /chomp page in its socket handshake
   (public/js/chomp/chompMain.js). The bought skins are shared/shopSkins.js SKINS.chomp. Cosmetic only: no money path
   reads it.

   EMPTY since 2026-10-27 (Owen: "too much going on, too many colours"): every Pac-Man is the classic yellow for now,
   so Customize offers no free colour and the server wears none (a stored id falls back to yellow). The colours it
   had were lime, emerald, mint, sky, violet, orchid, coral, tangerine, peach, lemon and snow (git history has them). */
(function (root) {
  'use strict';
  var SKINS = [];
  var BY = {};
  SKINS.forEach(function (s) { BY[s.id] = s; });
  /* The skin for an id, or null for anything not listed. */
  function byId(id) {
    return typeof id === 'string' && Object.prototype.hasOwnProperty.call(BY, id) ? BY[id] : null;
  }
  var api = { SKINS: SKINS, byId: byId, KEY: 'duel.chomp.skin' };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.DS_CHOMP_SKINS = api;
})(typeof window !== 'undefined' ? window : null);
