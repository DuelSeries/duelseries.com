/* 8 Ball Pool's FREE looks (Owen 2026-10-28: "two or three free looks, cues and/or cloth colours, chosen in a
   Customize chooser like Pac-Man's"): a cloth colour and a cue you pick in Customize and keep, instead of the game's
   own look (the reference's blue cloth and maple cue). All of them are ours; none is Miniclip's.

   One list for both ends, like shared/chompSkins.js: the lobby's chooser lists these after the game's own look, the
   /pool8 page sends the chosen id in its queue message, and the server wears only an id from here (anything else is
   the classic look), so a page can never ask for something that is not on it. The cloth is drawn on your own
   screen; your cue is drawn on both screens and for anyone watching. Cosmetic only: no rule and no money path reads
   it. Stored in the lobby under duel.pool8.look. */
(function (root) {
  'use strict';
  var LOOKS = [
    { id: 'green', name: 'Tournament green',
      cloth: { hi: '#7fcf86', mid: '#3a9a50', lo: '#15542b', cushion: '#2f8a45', cushionHi: '#8fd99a' },
      cue: { shaft: '#e4c48e', butt: '#2b1a10', joint: '#c9a23a' }, col: '#3a9a50' },
    { id: 'wine', name: 'Wine red',
      cloth: { hi: '#d07a82', mid: '#93323d', lo: '#47101a', cushion: '#86303b', cushionHi: '#e09aa2' },
      cue: { shaft: '#d9b27c', butt: '#151515', joint: '#e8e8e8' }, col: '#93323d' },
    { id: 'midnight', name: 'Midnight',
      cloth: { hi: '#8796b3', mid: '#46536f', lo: '#1b2131', cushion: '#40506c', cushionHi: '#a3b2cf' },
      cue: { shaft: '#cfd6e0', butt: '#0f2a4a', joint: '#ffd34d' }, col: '#46536f' },
  ];
  var BY = {};
  LOOKS.forEach(function (s) { BY[s.id] = s; });
  /* The look for an id, or null for anything not listed. */
  function byId(id) {
    return typeof id === 'string' && Object.prototype.hasOwnProperty.call(BY, id) ? BY[id] : null;
  }
  var api = { LOOKS: LOOKS, byId: byId, KEY: 'duel.pool8.look' };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.DS_POOL8_LOOKS = api;
})(typeof window !== 'undefined' ? window : null);
