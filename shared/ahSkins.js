/* Air Hockey's FREE looks (Owen, 2026-10-28: "two or three free mallet/puck looks, chosen in a Customize chooser like
   Pac-Man's, all designed by us"). Picked in the lobby's Customize and kept under duel.airhockey.skin; the /airhockey
   page reads it and draws YOUR mallet, its hit flash and the puck's trail in that colour on your own screen. The other
   player is always drawn in the rink's magenta, so the two mallets never look alike whatever either of you picks.
   None of these is magenta or near it. Cosmetic only: nothing on the server or the money path reads it.
   The game's own look (no pick) is the neon cyan in public/js/airhockey/ahArt.js. */
(function (root) {
  'use strict';
  var SKINS = [
    { id: 'gold', name: 'Gold', col: '#f0a830', trail: 'rgba(255,214,140,' },
    { id: 'lime', name: 'Lime', col: '#a6ff3c', trail: 'rgba(214,255,170,' },
    { id: 'ember', name: 'Ember', col: '#ff6a2a', trail: 'rgba(255,190,150,' },
  ];
  var BY = {};
  SKINS.forEach(function (s) { BY[s.id] = s; });
  function byId(id) {
    return typeof id === 'string' && Object.prototype.hasOwnProperty.call(BY, id) ? BY[id] : null;
  }
  var api = { SKINS: SKINS, byId: byId, KEY: 'duel.airhockey.skin', DEFAULT: { name: 'Neon cyan', col: '#2ff3ff' } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.DS_AH_SKINS = api;
})(typeof window !== 'undefined' ? window : null);
