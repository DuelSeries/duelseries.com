/* Crossy Road's FREE looks (Owen 2026-10-28: two or three free critters, picked in Customize like Pac-Man's).
   Every one is an ORIGINAL voxel critter of ours, never one of Crossy Road's characters. One list for both ends:
   the lobby's chooser lists them (Nugget is the game's own look, then the rest) and the /crossy server wears only an
   id from here (server/crossy/crossyWire.js), so a page can never ask for anything else. The models are in
   public/js/crossy/crossyScene.js (critterGeo); col is the body colour the chooser previews in.
   Stored in the lobby under duel.crossy.skin and sent by the /crossy page with cr:queue. Cosmetic only. */
(function (root) {
  'use strict';
  // Nugget, our own hen, is the game's look (Owen 2026-10-28); the other free critters follow.
  var DEFAULT = { id: 'nugget', name: 'Nugget', col: '#fbd88e' };
  var SKINS = [
    { id: 'sprout', name: 'Sprout', col: '#62c84a' },
    { id: 'bloop', name: 'Bloop', col: '#9b6cff' },
    { id: 'pebble', name: 'Pebble', col: '#9aa3ad' },
  ];
  var BY = { nugget: DEFAULT };
  SKINS.forEach(function (s) { BY[s.id] = s; });
  function byId(id) {
    return typeof id === 'string' && Object.prototype.hasOwnProperty.call(BY, id) ? BY[id] : null;
  }
  var api = { DEFAULT: DEFAULT, SKINS: SKINS, byId: byId, KEY: 'duel.crossy.skin' };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.DS_CROSSY_LOOKS = api;
})(typeof window !== 'undefined' ? window : null);
