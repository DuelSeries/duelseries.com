/* Swim's cars, chosen in the Shop (the lobby's chooser): TEN real, recognizable cars, each with its own model, paint
   and engine sound (Owen 2026-11-08: "actual models of cars... you look at the car and you know exactly what car it
   is"). Three are free, the other seven only in the Shop. The models are licensed downloads (public/js/swim/swimHiFi.js,
   credits in public/vendor/models/swim/CREDITS.txt) with every maker's badge and logo taken off the models.

   THE NAMES PLAYERS SEE (Owen 2026-11-08: "name the car the proper names, the actual name of the car, we can always
   change it back later"): each car's `name` is its real name (`full`) while REAL_NAMES below is true, and its old
   nickname (`nick`) when it is false. That one switch is the only change needed to swap back: the Shop
   (shared/shopSkins.js, public/js/v2/shopArt.js) and the lobby read `name` from here. `real` is the exact model, for
   this file and the credits.

     id        nickname        real car                      paint                engine
     civic     FK8 Hatch       Honda Civic Type R (FK8)      Championship white   turbo four             free (default)
     mustang   Pony GT         Ford Mustang GT (S550)        Grabber blue         V8 rumble              free
     m3        G80 Sedan       BMW M3 Competition (G80)      Isle of Man green    twin-turbo straight-6  free
     supra     A80 Coupe       Toyota Supra (A80, mk4)       Orange               2JZ straight-6         Shop
     gtr       R35 Coupe       Nissan GT-R (R35)             Gunmetal             twin-turbo V6          Shop
     hellcat   Blower          Dodge Challenger SRT Hellcat  Plum purple          supercharged V8 whine  Shop
     c8        C8              Chevrolet Corvette C8         Accelerate yellow    mid-engine V8          Shop
     gt3       992 Track       Porsche 911 GT3 (992)         GT silver            high-rev flat-6        Shop
     huracan   Toro V10        Lamborghini Huracán           Verde lime           V10                    Shop
     f8        Rosso V8        Ferrari 488 GTB            Rosso red            twin-turbo flat-plane V8  Shop

   The Shop cars' prices are shared/shopPrices.js (swim), their Shop entries shared/shopSkins.js (swim), and buying
   one is the paid-skin flow every game uses (docs/skin-purchases.md).

   One list for both ends: the lobby lists the ten and stores the id under duel.swim.car. /swim sends it in sw:queue
   (and /swimrace in se:join) with the lobby's skin pass, so the other player and the watchers see your car, and plays
   its engine for you alone. WHO MAY DRIVE A SHOP CAR IS DECIDED BY THE SERVER, at the socket (server/index.js
   swimCarOf, allowed() below): a free car always, a Shop car only when the skin pass proves the wallet owns
   swim:<car>, anything else the default. clean() then only keeps the shape of a look (a listed id, else the default;
   free text never passes, and a colour sent by an older page is ignored) wherever a look is stored. The three cars
   Swim had before (supercar, muscle, hatch) are read as the free car nearest them, so nothing stored is lost.

   LOOKS ONLY: every car is drawn on the same 4.3 m footprint and races on the same hitbox and handling, because
   nothing in shared/swimSim.js reads a look (test/swim.test.js steps a race with different cars bit for bit against
   one with none). No money path reads a look; buying one is a skin purchase like any other. */
(function (root) {
  'use strict';
  var ENGINES = [
    Object.freeze({ id: 'turbo4', name: 'Turbo four', badge: 'Turbo' }),
    Object.freeze({ id: 'v8', name: 'V8 rumble', badge: 'V8' }),
    Object.freeze({ id: 'inline6', name: 'Twin-turbo straight-6', badge: 'I6' }),
    Object.freeze({ id: 'i6jz', name: 'Big-turbo straight-6', badge: '2JZ' }),
    Object.freeze({ id: 'v6tt', name: 'Twin-turbo V6', badge: 'V6' }),
    Object.freeze({ id: 'v8sc', name: 'Supercharged V8 whine', badge: 'SC V8' }),
    Object.freeze({ id: 'v8c8', name: 'Mid-engine V8', badge: 'V8' }),
    Object.freeze({ id: 'flat6', name: 'High-rev flat-6', badge: 'F6' }),
    Object.freeze({ id: 'v10', name: 'V10 shriek', badge: 'V10' }),
    Object.freeze({ id: 'v8ft', name: 'Twin-turbo flat-plane V8', badge: 'V8' }),
  ];
  Object.freeze(ENGINES);
  /* The ten cars. free: driven by anyone; the rest are Shop cars. The three free ones stay FIRST: a free table's duel
     bot drives CARS[seed % 3] (server/swim/SwimRoom.js). The paints are each car's best-known colour, picked so the
     ten tell apart at a glance on the dusk road, solid or as the other car's see-through ghost. */
  var REAL_NAMES = true;   // false: every car goes back to its nickname, everywhere players see it
  function car(c) { c.name = REAL_NAMES ? c.full : c.nick; return Object.freeze(c); }
  var CARS = [
    car({ id: 'civic', nick: 'FK8 Hatch', full: 'Honda Civic Type R', real: 'Honda Civic Type R (FK8)', paint: 'White', hex: '#eeeeea', engine: 'turbo4', free: true }),
    car({ id: 'mustang', nick: 'Pony GT', full: 'Ford Mustang GT', real: 'Ford Mustang GT (S550)', paint: 'Blue', hex: '#2a86d8', engine: 'v8', free: true }),
    car({ id: 'm3', nick: 'G80 Sedan', full: 'BMW M3 Competition', real: 'BMW M3 Competition (G80)', paint: 'Green', hex: '#1c6a52', engine: 'inline6', free: true }),
    car({ id: 'supra', nick: 'A80 Coupe', full: 'Toyota Supra (A80)', real: 'Toyota Supra (A80)', paint: 'Orange', hex: '#f2701c', engine: 'i6jz', free: false }),
    car({ id: 'gtr', nick: 'R35 Coupe', full: 'Nissan GT-R', real: 'Nissan GT-R (R35)', paint: 'Gunmetal', hex: '#5a5f67', engine: 'v6tt', free: false }),
    car({ id: 'hellcat', nick: 'Blower', full: 'Dodge Challenger SRT Hellcat', real: 'Dodge Challenger SRT Hellcat', paint: 'Purple', hex: '#5f2c99', engine: 'v8sc', free: false }),
    car({ id: 'c8', nick: 'C8', full: 'Chevrolet Corvette C8', real: 'Chevrolet Corvette C8', paint: 'Yellow', hex: '#f2c014', engine: 'v8c8', free: false }),
    car({ id: 'gt3', nick: '992 Track', full: 'Porsche 911 GT3', real: 'Porsche 911 GT3 (992)', paint: 'Silver', hex: '#bfc4cb', engine: 'flat6', free: false }),
    car({ id: 'huracan', nick: 'Toro V10', full: 'Lamborghini Huracán', real: 'Lamborghini Huracán', paint: 'Lime', hex: '#62bd2c', engine: 'v10', free: false }),
    car({ id: 'f8', nick: 'Rosso V8', full: 'Ferrari 488 GTB', real: 'Ferrari 488 GTB', paint: 'Red', hex: '#d10f12', engine: 'v8ft', free: false }),
  ];
  Object.freeze(CARS);
  var FREE = Object.freeze(CARS.filter(function (c) { return c.free; }));
  var SHOP = Object.freeze(CARS.filter(function (c) { return !c.free; }));
  var DEFAULT_CAR = 'civic';
  /* The cars Swim had before 2026-11-08, read as the free car nearest them (a stored choice, an older page). */
  var LEGACY = { supercar: 'civic', muscle: 'mustang', hatch: 'civic' };
  var BY = {}, CAR_BY = {};
  ENGINES.forEach(function (e) { BY[e.id] = e; });
  CARS.forEach(function (c) { CAR_BY[c.id] = c; });
  var own = function (o, k) { return typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k); };
  /* The car for an id (an older car's id reads as its free stand-in), or null for anything not listed. */
  function carById(id) { return own(CAR_BY, id) ? CAR_BY[id] : own(LEGACY, id) ? CAR_BY[LEGACY[id]] : null; }
  /* The engine for an id, or null for anything not listed. */
  function byId(id) { return own(BY, id) ? BY[id] : null; }
  /* A car id that is listed, else the default. */
  function carOf(id) { var c = carById(id); return c ? c.id : DEFAULT_CAR; }
  /* True for one of the three free cars. */
  function isFree(id) { var c = carById(id); return !!(c && c.free); }
  /* The car a join may drive (the server, at the socket): a free car as asked; a Shop car only when `proved` is that
     same id (the skin pass's answer for swim:<car>, server/skinPass.js wornFrom); anything else the default. */
  function allowed(id, proved) {
    var c = carById(id);
    if (!c) return DEFAULT_CAR;
    if (c.free) return c.id;
    return typeof proved === 'string' && proved === c.id ? c.id : DEFAULT_CAR;
  }
  /* What a seat wears: { car } only, a listed id else the default. A new object of our own string, never the
     caller's, so nothing sent in is ever echoed; any colour or other field is dropped. */
  function clean(o) { return { car: carOf(o && typeof o === 'object' ? o.car : null) }; }
  /* The car's own paint (#rrggbb) and engine id. */
  function paintOf(id) { return CAR_BY[carOf(id)].hex; }
  function engineOf(id) { return CAR_BY[carOf(id)].engine; }
  var api = { ENGINES: ENGINES, CARS: CARS, FREE: FREE, SHOP: SHOP, DEFAULT_CAR: DEFAULT_CAR, DEFAULT: engineOf(DEFAULT_CAR),
    KEY: 'duel.swim.car', REAL_NAMES: REAL_NAMES, byId: byId, carById: carById, carOf: carOf, isFree: isFree, allowed: allowed, clean: clean,
    paintOf: paintOf, engineOf: engineOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.DS_SWIM_LOOKS = api;
})(typeof window !== 'undefined' ? window : null);
