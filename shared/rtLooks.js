/* Rooftop Snipers' FREE looks (Owen 2026-10-28: "two or three free looks for your shooter, chosen in Customize the
   way Pac-Man's free colours were"). Each one is one of our own eight snipers (public/js/rooftop/rtArt.js CAST,
   drawn in code square by square, never a copy of the reference's characters), worn every round in place of the
   sniper the round deals at random. The three are the cast's most different shapes: the hard hat with its brim,
   the tall white hat and the round helmet.

   One list for both ends, like shared/chompSkins.js: the lobby's Customize lists "Random" (the game's own look, a
   different sniper each round) and then these; the /rooftop page sends the stored id in rt:queue; the server keeps
   it only when it is on this list (pick) and the room carries it per seat in players[], so both players and every
   watcher draw the same sniper. A seat without one, and the bot, stay random. Stored in the lobby under
   duel.rooftop.look. Cosmetic only: no money path reads it, and the hitbox and the physics never change. */
(function (root) {
  'use strict';
  var LOOKS = [
    Object.freeze({ id: 'builder', name: 'Builder' }),
    Object.freeze({ id: 'chef', name: 'Chef' }),
    Object.freeze({ id: 'astronaut', name: 'Astronaut' }),
  ];
  Object.freeze(LOOKS);
  var BY = {};
  LOOKS.forEach(function (l) { BY[l.id] = l; });
  /* The look for an id, or null for anything not listed. */
  function byId(id) {
    return typeof id === 'string' && Object.prototype.hasOwnProperty.call(BY, id) ? BY[id] : null;
  }
  /* What the server keeps from a page's claim: a listed id, else null (the random look). */
  function pick(id) { return byId(id) ? id : null; }
  var api = { LOOKS: LOOKS, byId: byId, pick: pick, KEY: 'duel.rooftop.look' };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.DS_RT_LOOKS = api;
})(typeof window !== 'undefined' ? window : null);
