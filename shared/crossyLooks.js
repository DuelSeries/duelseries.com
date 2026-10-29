/* Crossy Road's FREE looks: voxel animals picked in Customize like Pac-Man's (Owen 2026-10-28: a chicken by default,
   a cat and a few more, replacing the first critters). Every one is an ORIGINAL design of ours, never one of Crossy
   Road's characters. One list for both ends: the lobby's chooser lists them (the chicken is the game's own look, then
   the rest) and the /crossy server wears only an id from here (server/crossy/crossyWire.js), so a page can never ask
   for anything else; an old id (nugget, sprout, bloop, pebble) is simply not here, so it wears the chicken. The
   models are shared/crossyCast.js; col is the body colour the chooser previews in.
   Stored in the lobby under duel.crossy.skin and sent by the /crossy page with cr:queue. Cosmetic only. */
(function (root) {
  'use strict';
  // The chicken is the game's look; the other animals follow.
  var DEFAULT = { id: 'chicken', name: 'Chicken', col: '#f8f8f3' };
  var SKINS = [
    { id: 'cat', name: 'Cat', col: '#f2a046' },
    { id: 'dog', name: 'Dog', col: '#d9a35e' },
    { id: 'pig', name: 'Pig', col: '#ffb6c4' },
    { id: 'frog', name: 'Frog', col: '#6fcf4a' },
  ];
  var BY = { chicken: DEFAULT };
  SKINS.forEach(function (s) { BY[s.id] = s; });
  function byId(id) {
    return typeof id === 'string' && Object.prototype.hasOwnProperty.call(BY, id) ? BY[id] : null;
  }
  var api = { DEFAULT: DEFAULT, SKINS: SKINS, byId: byId, KEY: 'duel.crossy.skin' };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.DS_CROSSY_LOOKS = api;
})(typeof window !== 'undefined' ? window : null);
