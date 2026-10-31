// Swim's cars and engines (Owen 2026-10-28): one Customize choice of three cars, each with its own fixed paint
// and synthesized engine, free, the engine heard only by you.
//   · the list (shared/swimLooks.js) is exactly the three cars, each naming one of the three engines
//     swimEngines.js builds; anything else is the supercar (red, V12)
//   · the lobby's chooser lists the three cars and stores the id /swim reads
//   · /swim loads the list and the engines before its sound module
//   · cosmetic: no server file and no money path reads an engine
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const swimLooks = require('../shared/swimLooks');

test('three cars, each with its own paint and engine; the supercar (red, V12) is the default', () => {
  assert.deepStrictEqual(swimLooks.CARS.map((c) => [c.id, c.name, c.paint, c.engine]), [
    ['supercar', 'Supercar', 'Red', 'v12'], ['muscle', 'Muscle car', 'Blue', 'v8'], ['hatch', 'Hot hatch', 'Yellow', 'turbo4']]);
  assert.deepStrictEqual(swimLooks.ENGINES.map((e) => e.id), ['v8', 'v12', 'turbo4']);
  assert.deepStrictEqual(swimLooks.ENGINES.map((e) => e.name), ['Deep V8 muscle', 'V12 scream', 'Turbo four']);
  assert.strictEqual(swimLooks.KEY, 'duel.swim.car');
  assert.strictEqual(swimLooks.DEFAULT_CAR, 'supercar');
  assert.strictEqual(swimLooks.DEFAULT, 'v12');
  for (const c of swimLooks.CARS) assert.ok(/^#[0-9a-f]{6}$/.test(c.hex) && swimLooks.byId(c.engine), c.id);
  assert.ok(Object.isFrozen(swimLooks.CARS) && swimLooks.CARS.every(Object.isFrozen), 'nobody can add to the list at run time');
});

test('a stored car is kept only when listed; anything else is the supercar, its paint and its V12', () => {
  for (const c of swimLooks.CARS) {
    assert.strictEqual(swimLooks.carOf(c.id), c.id);
    assert.strictEqual(swimLooks.engineOf(c.id), c.engine);
    assert.strictEqual(swimLooks.paintOf(c.id), c.hex);
  }
  for (const junk of [null, undefined, '', 'limo', 'v8', 'Supercar', ' muscle', 'constructor', '__proto__', 12, {}]) {
    assert.strictEqual(swimLooks.carOf(junk), 'supercar', JSON.stringify(String(junk)));
    assert.strictEqual(swimLooks.engineOf(junk), 'v12');
  }
});

test('swimEngines.js builds exactly those three, and nothing the picker page alone needed', () => {
  const src = read('public/js/swim/swimEngines.js');
  const sandbox = {};
  new Function('window', src)(sandbox);
  assert.deepStrictEqual(sandbox.SwimEngines.ids, swimLooks.ENGINES.map((e) => e.id));
  assert.strictEqual(typeof sandbox.SwimEngines.make, 'function');
  assert.strictEqual(typeof sandbox.SwimEngines.prepare, 'function');
  for (const gone of ['rotary', 'flat6', 'electric', 'buildEv', 'topSpeed', 'desc:']) assert.ok(!src.includes(gone), gone + ' is gone');
  assert.ok(/our own synthesis/i.test(src.slice(0, 600)), 'the header says it is ours');
});

test('/swim loads the list and the engines before its sound module: your engine, and a capped few for the other cars', () => {
  const html = read('public/swim.html');
  const at = (s) => html.indexOf('<script src="' + s + '"></script>');
  for (const s of ['/shared/swimLooks.js', '/js/dsSfx.js', '/js/swim/swimEngines.js', '/js/swim/swimSound.js']) assert.ok(at(s) > 0, s);
  assert.ok(at('/shared/swimLooks.js') < at('/js/swim/swimSound.js'));
  assert.ok(at('/js/dsSfx.js') < at('/js/swim/swimEngines.js') && at('/js/swim/swimEngines.js') < at('/js/swim/swimSound.js'));
  const snd = read('public/js/swim/swimSound.js');
  /* Owen 2026-10-30: hear the other cars around you. Your own engine is made in one place; the other cars' in one
     more, never more than VOICES of them at once (2 on a phone), always quieter than yours (OTHER_MAX under 1). */
  assert.strictEqual((snd.match(/E\.make\(/g) || []).length, 2, 'your engine, and one place for the other cars');
  assert.match(snd, /const VOICES = PHONE \? 2 : 3;/);
  const om = snd.match(/const OTHER_MAX = ([0-9.]+);/);
  assert.ok(om && Number(om[1]) > 0 && Number(om[1]) < 1, 'another car is never as loud as your own');
  assert.ok(/voices\.length >= VOICES/.test(snd), 'no voice past the cap');
  assert.ok(snd.includes('S.level'), 'the engine follows the sound engine\'s level, so mute and hold reach it');
  assert.ok(snd.includes("addEventListener('pagehide'"), 'and it stops when the page leaves');
});

/* lookList run for real, the way test/rooftopLooks.test.js runs it. */
function lookListFor(id) {
  globalThis.DS_SHOP_PRICES = require('../shared/shopPrices.js');
  globalThis.DS_AG_SKINS = require('../shared/agSkins.js');
  globalThis.DS_SHOP_SKINS = require('../shared/shopSkins.js');
  globalThis.DS_SWIM_LOOKS = swimLooks;
  require('../public/js/v2/shopArt.js');
  const html = read('public/v2.html');
  const src = html.slice(html.indexOf('const AGS=window.DS_AG_SKINS;'), html.indexOf('let LK=[];'));
  const fn = new Function('window', 'localStorage', 'LOOKS', 'V2Shop', 'skin', 'storeSkin',
    src.replace(/^const /gm, 'var ') + '\nreturn [lookList, SAVED];');
  const store = new Map();
  const ls = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const [lookList, SAVED] = fn(globalThis, ls, [], globalThis.V2Shop, () => null, () => {});
  return { list: lookList({ id, look: 0 }), SAVED, store };
}

test('Customize is one choice of exactly three cars, opens on the supercar, and Save stores the id /swim reads', () => {
  const { list, SAVED, store } = lookListFor('swim');
  assert.deepStrictEqual(list.map((s) => s.id), ['sw:supercar', 'sw:muscle', 'sw:hatch']);
  assert.deepStrictEqual(list.map((s) => s.name), ['Supercar', 'Muscle car', 'Hot hatch']);
  assert.ok(list.every((s) => !s.locked && !s.price), 'all free, nothing locked or priced');
  assert.strictEqual(SAVED.swim.worn().id, 'sw:supercar', 'nothing stored wears the supercar');
  SAVED.swim.put(list[1]);
  assert.strictEqual(store.get('duel.swim.car'), 'muscle');
  assert.strictEqual(SAVED.swim.worn().id, 'sw:muscle');
  SAVED.swim.put(null);
  assert.ok(!store.has('duel.swim.car'));
  assert.strictEqual(SAVED.swim.worn().id, 'sw:supercar');
  const html = read('public/v2.html');
  assert.ok(html.includes("||(g.id==='swim'&&SW_LOOKS.length)"), 'Swim\'s Customize bar opens');
  assert.ok(!html.includes('ap-rows') && !html.includes('data-row='), 'no colour or engine rows: one choice');
  assert.ok(html.indexOf('<script src="/shared/swimLooks.js"></script>') < html.indexOf('<script src="/js/v2/shopArt.js"></script>'));
  assert.ok(html.includes("else if(cur.id==='swim')V2Shop.paintWith(cv,'swim',{car:"), 'the bar draws the car in its paint with its badge');
});

test('the engine is cosmetic: no server file and no money path reads it', () => {
  const files = fs.readdirSync(path.join(ROOT, 'server'), { recursive: true }).filter((f) => /\.js$/.test(f)).map((f) => path.join('server', f));
  /* The Swim pages read a car's engine only to play it (swimSound.js f.engine, f.others): never the server or money. */
  for (const f of files.concat(['public/js/v2/wallet.js', 'public/js/v2/play.js'])) {
    const src = read(f);
    assert.ok(!src.includes('duel.swim.engine') && !/(?:SwimLooks|swimLooks)\.(?:ENGINES|engineOf|byId)\b/.test(src) &&
      !(f.includes('swim') && /\bLOOKS\.(?:ENGINES|engineOf|byId)\b/.test(src)), f + ' never reads the engine');
  }
  for (const f of ['public/js/v2/wallet.js', 'public/js/v2/play.js']) assert.ok(!read(f).includes('swimLooks'), f + ' never reads a Swim look');
});
