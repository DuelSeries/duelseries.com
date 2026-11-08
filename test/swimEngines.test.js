// Swim's cars and engines (Owen 2026-10-28): one Customize choice of three cars, each with its own fixed paint
// and synthesized engine, free, the engine heard only by you.
//   · the list (shared/swimLooks.js) is exactly the three cars, each naming one of the three engines
//     swimEngines.js builds; anything else is the default car
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

/* Owen 2026-11-08: ten real cars, each with its own model, colour and engine; three free, the other seven only in the
   Shop; no maker named on screen (nicknames). */
test('ten cars, each with its own paint and engine, three free; the first free car is the default', () => {
  assert.deepStrictEqual(swimLooks.CARS.map((c) => [c.id, c.engine, c.free]), [
    ['civic', 'turbo4', true], ['mustang', 'v8', true], ['m3', 'inline6', true],
    ['supra', 'i6jz', false], ['gtr', 'v6tt', false], ['hellcat', 'v8sc', false], ['c8', 'v8c8', false],
    ['gt3', 'flat6', false], ['huracan', 'v10', false], ['f8', 'v8ft', false]]);
  assert.strictEqual(new Set(swimLooks.CARS.map((c) => c.engine)).size, 10, 'every car its own engine');
  assert.strictEqual(new Set(swimLooks.CARS.map((c) => c.hex)).size, 10, 'and its own paint');
  assert.strictEqual(new Set(swimLooks.CARS.map((c) => c.name)).size, 10, 'and its own nickname');
  assert.deepStrictEqual(swimLooks.FREE.map((c) => c.id), ['civic', 'mustang', 'm3'], 'the free three come first (a duel bot picks among CARS[0..2])');
  assert.deepStrictEqual(swimLooks.ENGINES.map((e) => e.id).sort(), swimLooks.CARS.map((c) => c.engine).sort());
  assert.strictEqual(swimLooks.KEY, 'duel.swim.car');
  assert.strictEqual(swimLooks.DEFAULT_CAR, 'civic');
  assert.strictEqual(swimLooks.DEFAULT, 'turbo4');
  for (const c of swimLooks.CARS) assert.ok(/^#[0-9a-f]{6}$/.test(c.hex) && swimLooks.byId(c.engine), c.id);
  assert.ok(Object.isFrozen(swimLooks.CARS) && swimLooks.CARS.every(Object.isFrozen), 'nobody can add to the list at run time');
});

test('a stored car is kept only when listed; anything else is the default car, its paint and its engine', () => {
  for (const c of swimLooks.CARS) {
    assert.strictEqual(swimLooks.carOf(c.id), c.id);
    assert.strictEqual(swimLooks.engineOf(c.id), c.engine);
    assert.strictEqual(swimLooks.paintOf(c.id), c.hex);
  }
  for (const junk of [null, undefined, '', 'limo', 'v8', 'Civic', ' m3', 'constructor', '__proto__', 12, {}]) {
    assert.strictEqual(swimLooks.carOf(junk), 'civic', JSON.stringify(String(junk)));
    assert.strictEqual(swimLooks.engineOf(junk), 'turbo4');
  }
});

test('swimEngines.js builds exactly those ten, and nothing the picker page alone needed', () => {
  const src = read('public/js/swim/swimEngines.js');
  const sandbox = {};
  new Function('window', src)(sandbox);
  assert.deepStrictEqual(sandbox.SwimEngines.ids.slice().sort(), swimLooks.ENGINES.map((e) => e.id).sort());
  assert.strictEqual(typeof sandbox.SwimEngines.make, 'function');
  assert.strictEqual(typeof sandbox.SwimEngines.prepare, 'function');
  for (const gone of ['electric', 'buildEv', 'topSpeed', 'desc:']) assert.ok(!src.includes(gone), gone + ' is gone');
  assert.strictEqual(typeof sandbox.SwimEngines.ready, 'function');
  assert.ok(/real recordings/i.test(src.slice(0, 600)) && src.slice(0, 900).includes('CREDITS.txt'), 'the header says where the sounds come from');
});

/* Owen 2026-11-08: every car its own real engine and its own backfire. Each recorded engine is one small file of
   loops (an idle and the engine held at a few rpm) and its own bangs. Every file is credited and the credits are
   linked from the waiting screen. Open licences only: CC0 or CC BY, and the GT-R's CC BY-SA (Owen: "Use the real
   GT-R"), which its own credit line says. */
test('all ten engines play their own recording (idle, rpm loops, bangs), small files, all credited', () => {
  const sandbox = {};
  new Function('window', read('public/js/swim/swimEngines.js'))(sandbox);
  const E = sandbox.SwimEngines;
  const credits = read('public/vendor/models/swim/CREDITS.txt');
  const recorded = E.ids.filter((id) => E.sample(id));
  assert.deepStrictEqual(recorded.slice().sort(), E.ids.slice().sort(), 'every car');
  let total = 0;
  for (const id of recorded) {
    const S = E.sample(id);
    assert.strictEqual(S.url, '/audio/swim/' + id + '.mp3', id);
    const file = path.join(ROOT, 'public', S.url);
    assert.ok(fs.existsSync(file), id + ' file');
    const bytes = fs.statSync(file).size;
    total += bytes;
    assert.ok(bytes < 100 * 1024, id + ' is small (' + bytes + ' B)');
    const sec = bytes * 8 / 56000;
    const kinds = S.loops.map((l) => l[0]);
    assert.strictEqual(kinds.filter((k) => k === 'idle').length, 1, id + ' one idle');
    assert.ok(kinds.filter((k) => k === 'on').length >= 2, id + ' at least two on-throttle loops');
    assert.ok(S.minRate === undefined || (S.minRate >= 0.25 && S.minRate < 1), id + ' minRate');
    for (const [k, rpm, at, len] of S.loops) {
      assert.ok(['idle', 'on', 'off'].includes(k), id + ' ' + k);
      assert.ok(rpm >= 400 && rpm <= 10000, id + ' rpm ' + rpm);
      assert.ok(len >= 0.15 && at >= 0.1 && at + len <= sec + 0.05, id + ' loop inside its file ' + [at, len, sec]);
    }
    assert.ok(S.pops.length >= 3, id + ' has its own bangs');
    for (const [at, len] of S.pops) assert.ok(len > 0.02 && len <= 0.3 && at + len <= sec + 0.05, id + ' bang inside its file');
    assert.ok(S.trim > 0 && S.trim <= 3 && S.popLevel > 0 && S.popLevel <= 1 && S.maxRate >= 1.3 && S.maxRate <= 2.5, id + ' levels');
    assert.ok(credits.includes('  ' + id + ' ('), id + ' credited');
  }
  assert.ok(total < 600 * 1024, 'all of them together stay small: ' + total + ' B');
  for (const page of ['public/swim.html', 'public/swimrace.html']) {
    assert.ok(/class="carCredit" href="\/vendor\/models\/swim\/CREDITS.txt"[^>]*>[^<]*engine sounds/.test(read(page)), page + ' links the credits');
  }
  const sounds = credits.slice(credits.indexOf('engine sounds'));
  assert.ok(/CC0|CC BY/.test(sounds) && !/NonCommercial|BY-NC/.test(sounds), 'open licences only, nothing non-commercial');
  for (const line of sounds.split(/\r?\n/).filter((l) => /BY-SA/.test(l) && /^  \w/.test(l))) assert.ok(line.startsWith('  v6tt ('), 'share-alike only for the GT-R: ' + line.slice(0, 40));
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

test('the Shop lists the three free cars then the seven Shop cars, opens on the default, and Save stores the id /swim reads', () => {
  const { list, SAVED, store } = lookListFor('swim');
  assert.deepStrictEqual(list.map((s) => s.id), ['sw:civic', 'sw:mustang', 'sw:m3', 'shop:supra', 'shop:hellcat', 'shop:gtr',
    'shop:c8', 'shop:gt3', 'shop:f8', 'shop:huracan']);
  assert.deepStrictEqual(list.slice(0, 3).map((s) => s.name), swimLooks.FREE.map((c) => c.name));
  assert.ok(list.slice(0, 3).every((s) => !s.locked && !s.price), 'the three free, nothing locked or priced');
  assert.ok(list.slice(3).every((s) => s.locked && s.price > 0), 'the seven locked, each with its price');
  assert.strictEqual(SAVED.swim.worn().id, 'sw:civic', 'nothing stored wears the default');
  SAVED.swim.put(list[1]);
  assert.strictEqual(store.get('duel.swim.car'), 'mustang');
  assert.strictEqual(SAVED.swim.worn().id, 'sw:mustang');
  SAVED.swim.put(null);
  assert.ok(!store.has('duel.swim.car'));
  assert.strictEqual(SAVED.swim.worn().id, 'sw:civic');
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
