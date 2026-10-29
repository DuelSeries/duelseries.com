/* Head Soccer's FREE heads (Owen 2026-10-28: "a head chooser", several heads in the game's caricature style). Every
   face is invented, nobody real and no lookalike. One list for both ends, like shared/crossyLooks.js: the lobby's
   Customize lists them after the game's own look (Classic: each seat's own face), the /headsoccer page sends the
   chosen id with hs:queue, and the server wears only an id from here (server/index.js, as the seat's skin; Head
   Soccer sells no Shop skins), so a page can never ask for anything else. Your head is drawn on both screens and for
   anyone watching. The faces are public/js/headsoccer/hsFaces.js. Stored in the lobby under duel.headsoccer.head.
   Looks only: no rule, no hitbox and no money path reads it. */
(function (root) {
  'use strict';
  var DEFAULT = { id: 'classic', name: 'Classic' };
  var HEADS = [
    { id: 'beard', name: 'Beard' },
    { id: 'spikes', name: 'Spikes' },
    { id: 'flattop', name: 'Flat-top' },
    { id: 'afro', name: 'Afro' },
    { id: 'tash', name: 'Moustache' },
    { id: 'bowl', name: 'Bowl cut' },
  ];
  var BY = {};
  HEADS.forEach(function (h) { BY[h.id] = h; });
  /* The head for an id, or null for anything not listed (Classic included: nothing to send). */
  function byId(id) {
    return typeof id === 'string' && Object.prototype.hasOwnProperty.call(BY, id) ? BY[id] : null;
  }
  var api = { DEFAULT: DEFAULT, HEADS: HEADS, byId: byId, KEY: 'duel.headsoccer.head' };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.DS_HS_HEADS = api;
})(typeof window !== 'undefined' ? window : null);
