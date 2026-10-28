// Swim's engines (Owen 2026-10-28): three synthesized engines, picked free in Customize, heard only by you.
//   · the list (shared/swimLooks.js) is exactly the three engines swimEngines.js builds, and anything else is the V12
//   · the lobby's chooser lists the three and stores the id /swim reads
//   · /swim loads the list and the engines before its sound module
//   · cosmetic and client-only: no server file and no money path reads the pick
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const swimLooks = require('../shared/swimLooks');

test('the list is the three picked engines, the V12 first choice for the one car', () => {
  assert.deepStrictEqual(swimLooks.ENGINES.map((e) => e.id), ['v8', 'v12', 'turbo4']);
  assert.deepStrictEqual(swimLooks.ENGINES.map((e) => e.name), ['Deep V8 muscle', 'V12 scream', 'Turbo four']);
  assert.strictEqual(swimLooks.KEY, 'duel.swim.engine');
  assert.strictEqual(swimLooks.DEFAULT, 'v12');
  assert.deepStrictEqual({ ...swimLooks.LOOK_ENGINE }, { supercar: 'v12', muscle: 'v8', hatch: 'turbo4' });
  assert.ok(Object.isFrozen(swimLooks.ENGINES) && swimLooks.ENGINES.every(Object.isFrozen), 'nobody can add to the list at run time');
});

test('a stored id is kept only when listed; anything else is the look\'s own engine, else the V12', () => {
  for (const id of ['v8', 'v12', 'turbo4']) assert.strictEqual(swimLooks.pick(id), id);
  for (const junk of [null, undefined, '', 'rotary', 'flat6', 'electric', 'V8', ' v8', 'constructor', '__proto__', 12, {}]) {
    assert.strictEqual(swimLooks.pick(junk), 'v12', JSON.stringify(String(junk)));
  }
  assert.strictEqual(swimLooks.pick(null, 'muscle'), 'v8');
  assert.strictEqual(swimLooks.pick('turbo4', 'muscle'), 'turbo4', 'the pick wins over the look');
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

test('/swim loads the list and the engines before its sound module, and plays one engine', () => {
  const html = read('public/swim.html');
  const at = (s) => html.indexOf('<script src="' + s + '"></script>');
  for (const s of ['/shared/swimLooks.js', '/js/dsSfx.js', '/js/swim/swimEngines.js', '/js/swim/swimSound.js']) assert.ok(at(s) > 0, s);
  assert.ok(at('/shared/swimLooks.js') < at('/js/swim/swimSound.js'));
  assert.ok(at('/js/dsSfx.js') < at('/js/swim/swimEngines.js') && at('/js/swim/swimEngines.js') < at('/js/swim/swimSound.js'));
  const snd = read('public/js/swim/swimSound.js');
  assert.strictEqual((snd.match(/E\.make\(/g) || []).length, 1, 'one engine, your own: no second one for the other car');
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
    src.replace(/^const /gm, 'var ') + '\nreturn [lookList, SAVED, (k) => { swRow = k; }];');
  const store = new Map();
  const ls = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const [lookList, SAVED, setRow] = fn(globalThis, ls, [], globalThis.V2Shop, () => null, () => {});
  const row = (k) => { setRow(k); return lookList({ id, look: 0 }); };
  return { list: lookList({ id, look: 0 }), SAVED, store, row, setRow };
}

test('Customize has three rows of exactly three: cars, colours, engines; defaults supercar, gold, V12', () => {
  const { row, SAVED, store } = lookListFor('swim');
  assert.deepStrictEqual(row('car').map((s) => s.id), ['swc:muscle', 'swc:supercar', 'swc:hatch']);
  assert.strictEqual(SAVED.swim.worn().id, 'swc:supercar');
  assert.deepStrictEqual(row('colour').map((s) => s.id), ['swp:gold', 'swp:crimson', 'swp:teal']);
  assert.strictEqual(SAVED.swim.worn().id, 'swp:gold');
  SAVED.swim.put(row('colour')[2]);
  assert.strictEqual(store.get('duel.swim.colour'), 'teal');
  SAVED.swim.put(row('car')[0]);
  assert.strictEqual(store.get('duel.swim.car'), 'muscle');
  assert.strictEqual(SAVED.swim.worn().id, 'swc:muscle');
  store.set('duel.swim.car', 'limo');
  assert.strictEqual(SAVED.swim.worn().id, 'swc:supercar', 'anything unlisted is the default');
  for (const k of ['car', 'colour', 'engine']) assert.strictEqual(row(k).length, 3, k + ': exactly three');
  const html = read('public/v2.html');
  for (const k of ['car', 'colour', 'engine']) assert.ok(html.includes('data-row="' + k + '"'), 'a tab for ' + k);
});

test('Customize lists the three engines, opens on the V12, and Save stores the id /swim reads', () => {
  const { row, SAVED, store } = lookListFor('swim');
  const list = row('engine');
  assert.deepStrictEqual(list.map((s) => s.id), ['sw:v8', 'sw:v12', 'sw:turbo4']);
  assert.deepStrictEqual(list.map((s) => s.name), ['Deep V8 muscle', 'V12 scream', 'Turbo four']);
  assert.ok(list.every((s) => !s.locked && !s.price), 'all free, nothing locked or priced');
  assert.strictEqual(SAVED.swim.worn().id, 'sw:v12', 'nothing stored wears the V12');
  SAVED.swim.put(list[0]);
  assert.strictEqual(store.get('duel.swim.engine'), 'v8');
  assert.strictEqual(SAVED.swim.worn().id, 'sw:v8');
  SAVED.swim.put(null);
  assert.ok(!store.has('duel.swim.engine'));
  assert.strictEqual(SAVED.swim.worn().id, 'sw:v12');
  const html = read('public/v2.html');
  assert.ok(html.includes("||(g.id==='swim'&&SW_LOOKS.length)"), 'Swim\'s Customize bar opens');
  assert.ok(html.indexOf('<script src="/shared/swimLooks.js"></script>') < html.indexOf('<script src="/js/v2/shopArt.js"></script>'));
  assert.ok(html.includes("else if(cur.id==='swim')V2Shop.paintWith(cv,'swim',swSpec(s),"), 'the bar draws the car, its paint and its badge');
});

test('the engine is cosmetic: no server file and no money path reads it', () => {
  const files = fs.readdirSync(path.join(ROOT, 'server'), { recursive: true }).filter((f) => /\.js$/.test(f)).map((f) => path.join('server', f));
  for (const f of files.concat(['public/js/v2/wallet.js', 'public/js/v2/play.js', 'public/js/swim/swimMain.js'])) {
    const src = read(f);
    assert.ok(!src.includes('duel.swim.engine') && !/(?:SwimLooks|swimLooks)\.(?:KEY|ENGINES|pick|byId)\b/.test(src) &&
      !(f.includes('swim') && /\bLOOKS\.(?:KEY|ENGINES|pick|byId)\b/.test(src)), f + ' never reads the engine');
  }
  for (const f of ['public/js/v2/wallet.js', 'public/js/v2/play.js']) assert.ok(!read(f).includes('swimLooks'), f + ' never reads a Swim look');
});
