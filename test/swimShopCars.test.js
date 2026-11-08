// Swim's Shop cars (Owen 2026-11-08: ten cars, three free, the other seven only in the Shop). A Shop car is proved,
// not claimed: the race drives it only when the lobby's skin pass lists swim:<car>, the same check every game makes
// before wearing a paid skin (docs/skin-purchases.md); a free car needs nothing; anything else is the default car.
//   · shared/swimLooks.js allowed() and server/skinPass.js together, with real passes
//   · server/index.js decides it once, at the socket, for sw:queue and se:join (swimCarOf)
//   · the seven are sold at the prices in shared/shopPrices.js, through the one catalog the server reads
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const SwimLooks = require('../shared/swimLooks');
const { createSkinPass } = require('../server/skinPass');
const catalog = require('../server/skinCatalog');

const W = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const ROOT = path.join(__dirname, '..');

test('a free car is driven as asked; a Shop car only with a pass that lists it; anything else is the default car', () => {
  const P = createSkinPass({ secret: 'test secret' });
  const pass = P.mint(W, ['swim:huracan', 'knockout:ruby']).pass;
  const drive = (car, token) => SwimLooks.allowed(car, P.wornFrom('swim', { shop: car, skinPass: token }));
  for (const c of SwimLooks.FREE) assert.strictEqual(drive(c.id, null), c.id, c.id + ' is free');
  assert.strictEqual(drive('huracan', pass), 'huracan', 'owned and proved');
  assert.strictEqual(drive('huracan', null), 'civic', 'no pass');
  assert.strictEqual(drive('gt3', pass), 'civic', 'a pass that does not list it');
  assert.strictEqual(drive('huracan', createSkinPass({ secret: 'someone else' }).mint(W, ['swim:huracan']).pass), 'civic', 'a pass from another key');
  assert.strictEqual(drive('huracan', pass.slice(0, -2) + 'xx'), 'civic', 'a pass tampered with');
  const late = createSkinPass({ secret: 'test secret', now: () => 0 }).mint(W, ['swim:huracan']).pass;
  assert.strictEqual(drive('huracan', late), 'civic', 'an expired pass');
  for (const junk of [null, undefined, '', 'limo', '__proto__', 'constructor', 7, {}, ['huracan']]) {
    assert.strictEqual(SwimLooks.allowed(junk, 'huracan'), 'civic', JSON.stringify(String(junk)));
  }
  assert.strictEqual(SwimLooks.allowed('huracan', { toString: () => 'huracan' }), 'civic', 'the proof is the pass check\'s string only');
});

test('the server decides the car once, at the socket, for the duel and the Swim Race alike', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
  assert.ok(/function swimCarOf\(car, skinPass\) \{\n  const id = typeof car === 'string' \? car\.slice\(0, 24\) : null;\n  return SwimLooks\.allowed\(id, skinPasses\.wornFrom\('swim', \{ shop: id, skinPass: typeof skinPass === 'string' \? skinPass : null \}\)\);\n\}/.test(src),
    'swimCarOf: the pass check, then allowed()');
  assert.ok(/on\('sw:queue', \(\{[^}]*\bskinPass\b[^}]*\} = \{\}\) =>/.test(src) && src.includes('{ car: swimCarOf(car, skinPass) }'), 'sw:queue');
  assert.ok(/on\('se:join', \(\{[^}]*\bskinPass\b[^}]*\} = \{\}\) =>/.test(src) && src.includes('const look = { car: swimCarOf(car, skinPass) };'), 'se:join');
  const lobby = fs.readFileSync(path.join(ROOT, 'public/js/swim/swimMain.js'), 'utf8');
  assert.ok(lobby.includes('skinPass: mySkinPass()'), '/swim sends the pass with its car');
  const race = fs.readFileSync(path.join(ROOT, 'public/js/swim/swimEventMain.js'), 'utf8');
  assert.ok(race.includes("socket.emit('se:join', { name: myName, wallet: myWallet, car: look.car, skinPass, v: S.VERSION });"), '/swimrace too');
});

test('the seven Shop cars are for sale at their prices; the three free ones are not', () => {
  for (const c of SwimLooks.SHOP) {
    const it = catalog.itemOf('swim', c.id);
    assert.ok(it && it.units > 0n, c.id + ' sells');
    assert.strictEqual(it.item, 'swim:' + c.id);
  }
  for (const c of SwimLooks.FREE) assert.strictEqual(catalog.itemOf('swim', c.id), null, c.id + ' is never sold');
  assert.deepStrictEqual(catalog.skinsOf('swim').sort(), SwimLooks.SHOP.map((c) => c.id).sort());
});

test('every car has its own model, its own engine and its own paint; old ids read as a free car', () => {
  for (const c of SwimLooks.CARS) {
    for (const f of [c.id + '.glb', c.id + '-lo.glb']) assert.ok(fs.existsSync(path.join(ROOT, 'public/vendor/models/swim/cars', f)), f);
    assert.ok(fs.existsSync(path.join(ROOT, 'public/img/swim-cars', c.id + '.webp')), c.id + ' Shop picture');
    assert.ok(fs.existsSync(path.join(ROOT, 'public/img/swim-cars', c.id + '-3d.webp')), c.id + ' Shop 3D turntable strip');
  }
  assert.strictEqual(new Set(SwimLooks.CARS.map((c) => c.engine)).size, 10);
  assert.strictEqual(new Set(SwimLooks.CARS.map((c) => c.hex)).size, 10);
  for (const [old, now] of [['supercar', 'civic'], ['muscle', 'mustang'], ['hatch', 'civic']]) assert.strictEqual(SwimLooks.carOf(old), now, old);
  /* Owen 2026-11-08: "name the car the proper names ... we can always change it back later". The real names show
     while REAL_NAMES is on; the nicknames (no maker named) are kept beside them, one switch away. */
  assert.strictEqual(SwimLooks.REAL_NAMES, true);
  assert.deepStrictEqual(SwimLooks.CARS.map((c) => c.name), ['Honda Civic Type R', 'Ford Mustang GT', 'BMW M3 Competition',
    'Toyota Supra (A80)', 'Nissan GT-R', 'Dodge Challenger SRT Hellcat', 'Chevrolet Corvette C8', 'Porsche 911 GT3',
    'Lamborghini Huracán', 'Ferrari 488 GTB']);
  assert.ok(SwimLooks.CARS.every((c) => c.name === c.full && c.nick && !/honda|ford|bmw|toyota|nissan|dodge|chevrolet|porsche|lamborghini|ferrari|corvette|mustang|supra|civic|hurac|911|gt-r/i.test(c.nick)),
    'the nicknames, kept for the switch back, name no maker');
  const SK = require('../shared/shopSkins.js');
  assert.deepStrictEqual(SK.SKINS.swim.map((s) => s.name), SK.SKINS.swim.map((s) => SwimLooks.carById(s.id).name), 'the Shop reads its names from here');
});
