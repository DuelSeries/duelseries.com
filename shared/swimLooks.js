/* Swim's looks, chosen in Customize: three cars, three paints and three engines, all free for everyone, nothing
   bought (Owen 2026-10-28: exactly three of each). The engine sounds are public/js/swim/swimEngines.js, the car
   models public/js/swim/swimScene.js.

   One list for both ends, like shared/rtLooks.js: the lobby's Customize lists these and stores the ids under
   duel.swim.car, duel.swim.colour and duel.swim.engine.
   - The CAR and the PAINT are what the other player and the watchers see: /swim sends them in sw:queue, and the
     server keeps them only through clean() (anything not listed becomes the default; free text never passes) and
     shows them in the seats of sw:start and the watcher state, by seat. LOOKS ONLY: every model is drawn to the
     same 4.3 m by 1.8 m footprint and races on the same hitbox and handling, because nothing in
     shared/swimSim.js reads a look (test/swim.test.js steps a race with three looks bit for bit against one
     with none).
   - The ENGINE is client-only: only you hear your own engine, the server never sees the pick, and no money
     path reads it.

   LOOK_ENGINE is each car's own engine (kept for pick()). Nothing stored is the supercar, gold, the V12. */
(function (root) {
  'use strict';
  var ENGINES = [
    Object.freeze({ id: 'v8', name: 'Deep V8 muscle', badge: 'V8' }),
    Object.freeze({ id: 'v12', name: 'V12 scream', badge: 'V12' }),
    Object.freeze({ id: 'turbo4', name: 'Turbo four', badge: 'Turbo' }),
  ];
  Object.freeze(ENGINES);
  /* The three cars, our own low-poly shapes, no real make's design and no badges. */
  var CARS = [
    Object.freeze({ id: 'muscle', name: 'Muscle car' }),
    Object.freeze({ id: 'supercar', name: 'Supercar' }),
    Object.freeze({ id: 'hatch', name: 'Hot hatch' }),
  ];
  Object.freeze(CARS);
  /* The three paints, picked to read on the dusk road, solid or as the other car's see-through ghost. */
  var PAINTS = [
    Object.freeze({ id: 'gold', name: 'Gold', hex: '#e8b84a' }),
    Object.freeze({ id: 'crimson', name: 'Crimson', hex: '#d42f3c' }),
    Object.freeze({ id: 'teal', name: 'Teal', hex: '#2fc4c0' }),
  ];
  Object.freeze(PAINTS);
  var LOOK_ENGINE = Object.freeze({ supercar: 'v12', muscle: 'v8', hatch: 'turbo4' });
  var LOOK = 'supercar';                      // the default car
  var DEFAULT = LOOK_ENGINE[LOOK];
  var DEFAULT_CAR = 'supercar', DEFAULT_PAINT = 'gold';
  var BY = {}, CAR_BY = {}, PAINT_BY = {};
  ENGINES.forEach(function (e) { BY[e.id] = e; });
  CARS.forEach(function (c) { CAR_BY[c.id] = c; });
  PAINTS.forEach(function (c) { PAINT_BY[c.id] = c; });
  var own = function (o, k) { return typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k); };
  function carById(id) { return own(CAR_BY, id) ? CAR_BY[id] : null; }
  function paintById(id) { return own(PAINT_BY, id) ? PAINT_BY[id] : null; }
  /* What a seat wears: only listed ids, each else its default. A new object of our own strings, never the
     caller's, so nothing sent in is ever echoed. */
  function clean(o) {
    var car = o && typeof o === 'object' ? o.car : null, colour = o && typeof o === 'object' ? o.colour : null;
    return { car: carById(car) ? CAR_BY[car].id : DEFAULT_CAR, colour: paintById(colour) ? PAINT_BY[colour].id : DEFAULT_PAINT };
  }
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
  var api = { ENGINES: ENGINES, CARS: CARS, PAINTS: PAINTS, LOOK_ENGINE: LOOK_ENGINE, LOOK: LOOK, DEFAULT: DEFAULT,
    DEFAULT_CAR: DEFAULT_CAR, DEFAULT_PAINT: DEFAULT_PAINT,
    KEY: 'duel.swim.engine', CAR_KEY: 'duel.swim.car', PAINT_KEY: 'duel.swim.colour',
    byId: byId, carById: carById, paintById: paintById, clean: clean, pick: pick };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.DS_SWIM_LOOKS = api;
})(typeof window !== 'undefined' ? window : null);
