/* Swim's engines, chosen in Customize (Owen 2026-10-28: the three he picked from the engine picker, all three in the
   game, free for everyone, nothing bought). The sounds themselves are public/js/swim/swimEngines.js.

   One list for both ends, like shared/rtLooks.js: the lobby's Customize lists these three and stores the id under
   duel.swim.engine; the /swim page reads it when a race starts (public/js/swim/swimSound.js). Anything else, or
   nothing stored, is the car's own engine. Cosmetic and client-only: only you hear your own engine, the server never
   sees the pick, and no money path reads it.

   LOOK_ENGINE is each car look's own engine, so a future look plugs in with its sound. Swim draws one car today, the
   gold coupe with the big rear wing (public/js/swim/swimScene.js): the supercar, with the V12. */
(function (root) {
  'use strict';
  var ENGINES = [
    Object.freeze({ id: 'v8', name: 'Deep V8 muscle', badge: 'V8' }),
    Object.freeze({ id: 'v12', name: 'V12 scream', badge: 'V12' }),
    Object.freeze({ id: 'turbo4', name: 'Turbo four', badge: 'Turbo' }),
  ];
  Object.freeze(ENGINES);
  var LOOK_ENGINE = Object.freeze({ supercar: 'v12', muscle: 'v8', tuner: 'turbo4' });
  var LOOK = 'supercar';                      // the one car Swim draws today
  var DEFAULT = LOOK_ENGINE[LOOK];
  var BY = {};
  ENGINES.forEach(function (e) { BY[e.id] = e; });
  /* The engine for an id, or null for anything not listed. */
  function byId(id) {
    return typeof id === 'string' && Object.prototype.hasOwnProperty.call(BY, id) ? BY[id] : null;
  }
  /* What a race plays: the stored id when it is listed, else the look's own engine, else the V12. */
  function pick(id, look) {
    if (byId(id)) return id;
    var own = typeof look === 'string' && Object.prototype.hasOwnProperty.call(LOOK_ENGINE, look) ? LOOK_ENGINE[look] : null;
    return own || DEFAULT;
  }
  var api = { ENGINES: ENGINES, LOOK_ENGINE: LOOK_ENGINE, LOOK: LOOK, DEFAULT: DEFAULT, KEY: 'duel.swim.engine', byId: byId, pick: pick };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.DS_SWIM_LOOKS = api;
})(typeof window !== 'undefined' ? window : null);
