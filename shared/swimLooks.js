/* Swim's cars, chosen in Customize: ONE choice of three cars, each with its own fixed paint and engine, all free
   for everyone, nothing bought (Owen 2026-10-28). The engine sounds are public/js/swim/swimEngines.js, the car
   models public/js/swim/swimScene.js.

     Supercar    red      V12 scream       (the default)
     Muscle car  blue     Deep V8 muscle
     Hot hatch   yellow   Turbo four

   One list for both ends, like shared/rtLooks.js: the lobby's Customize lists the three and stores the id under
   duel.swim.car. /swim sends it in sw:queue so the other player and the watchers see your car (and so its paint),
   and plays the car's engine for you alone. The server keeps the car only through clean() (anything not listed is
   the supercar; free text never passes, and a colour sent by an older page is ignored) and shows it in the seats
   of sw:start and the watcher state, by seat.

   LOOKS ONLY: every model is drawn to the same 4.3 m by 1.8 m footprint and races on the same hitbox and
   handling, because nothing in shared/swimSim.js reads a look (test/swim.test.js steps a race with three
   different cars bit for bit against one with none). No money path reads it. */
(function (root) {
  'use strict';
  var ENGINES = [
    Object.freeze({ id: 'v8', name: 'Deep V8 muscle', badge: 'V8' }),
    Object.freeze({ id: 'v12', name: 'V12 scream', badge: 'V12' }),
    Object.freeze({ id: 'turbo4', name: 'Turbo four', badge: 'Turbo' }),
  ];
  Object.freeze(ENGINES);
  /* The three cars, our own low-poly shapes, no real make's design and no badges. The paints are picked to read
     on the dusk road, solid or as the other car's see-through ghost. */
  var CARS = [
    Object.freeze({ id: 'supercar', name: 'Supercar', paint: 'Red', hex: '#e2363f', engine: 'v12' }),
    Object.freeze({ id: 'muscle', name: 'Muscle car', paint: 'Blue', hex: '#3f86f4', engine: 'v8' }),
    Object.freeze({ id: 'hatch', name: 'Hot hatch', paint: 'Yellow', hex: '#f4c531', engine: 'turbo4' }),
  ];
  Object.freeze(CARS);
  var DEFAULT_CAR = 'supercar';
  var BY = {}, CAR_BY = {};
  ENGINES.forEach(function (e) { BY[e.id] = e; });
  CARS.forEach(function (c) { CAR_BY[c.id] = c; });
  var own = function (o, k) { return typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k); };
  /* The car for an id, or null for anything not listed. */
  function carById(id) { return own(CAR_BY, id) ? CAR_BY[id] : null; }
  /* The engine for an id, or null for anything not listed. */
  function byId(id) { return own(BY, id) ? BY[id] : null; }
  /* A car id that is listed, else the default. */
  function carOf(id) { return carById(id) ? CAR_BY[id].id : DEFAULT_CAR; }
  /* What a seat wears: { car } only, a listed id else the supercar. A new object of our own string, never the
     caller's, so nothing sent in is ever echoed; any colour or other field is dropped. */
  function clean(o) { return { car: carOf(o && typeof o === 'object' ? o.car : null) }; }
  /* The car's own paint (#rrggbb) and engine id. */
  function paintOf(id) { return CAR_BY[carOf(id)].hex; }
  function engineOf(id) { return CAR_BY[carOf(id)].engine; }
  var api = { ENGINES: ENGINES, CARS: CARS, DEFAULT_CAR: DEFAULT_CAR, DEFAULT: engineOf(DEFAULT_CAR), KEY: 'duel.swim.car',
    byId: byId, carById: carById, carOf: carOf, clean: clean, paintOf: paintOf, engineOf: engineOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.DS_SWIM_LOOKS = api;
})(typeof window !== 'undefined' ? window : null);
