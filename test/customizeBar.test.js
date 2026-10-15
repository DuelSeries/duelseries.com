// BACKLOG 3.1: the Customize bar under Play in every game, and the slither.io skin it stores for /sl.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const v2 = () => fs.readFileSync(path.join(ROOT, 'public/v2.html'), 'utf8');

// look.js reads the frozen client's tables off globalThis.DuelSlither, so load that first, as the page does.
require('../public/js/sl/slSprites.js');
require('../public/js/v2/look.js');
const V2Look = globalThis.V2Look;

test('Customize offers exactly the skins the /sl server accepts', () => {
  const { botSkins } = require('../server/sl/slBots');
  const { LAWS } = require('../server/sl/slLaws');
  // Anything outside this set the server swaps for a random plain colour (slSockets skinOf), so the
  // two lists must agree. If the picture skins are ever switched on this fails until the lobby lists them.
  assert.deepStrictEqual(V2Look.skins.slice(), botSkins(LAWS).slice());
  assert.strictEqual(V2Look.skins.length, 54);
});

test('the plain skins keep their old names, the striped ones are numbered', () => {
  assert.deepStrictEqual([0, 6, 8].map(V2Look.name), ['Purple', 'Coral', 'Magenta']);
  assert.strictEqual(V2Look.name(9), 'Skin 10');
  assert.strictEqual(V2Look.name(65), 'Skin 54');
});

test('the first nine old colours are cv 0 to 8 in order, so the old-engine fallback gets the same colour', () => {
  const sp = globalThis.DuelSlither.slSprites;
  const html = v2();
  const list = html.slice(html.indexOf('const AVATAR_LOOKS=['), html.indexOf('];', html.indexOf('const AVATAR_LOOKS=[')));
  const colours = [...list.matchAll(/color:'(#[0-9a-f]{6})'/g)].map((m) => m[1]);
  assert.deepStrictEqual(colours.slice(0, 9), sp.ccs.slice(0, 9));
});

test('every built game shows the bar; only an unbuilt one hides it', () => {
  const html = v2();
  for (const kind of ['duel', 'solo', 'nolook']) {
    const rules = html.match(new RegExp('#detail\\.' + kind + ' [^{]*\\{display:none\\}', 'g')) || [];
    for (const r of rules) {
      assert.ok(!/\.lookrow(?![\w-])/.test(r.replace(/\.lookrow \.l\w+|\.lookrow canvas/g, '')),
        kind + ' must not hide the bar: ' + r);
    }
  }
  assert.ok(/#detail\.soon [^{]*\.lookrow[^{]*\{display:none\}/.test(html), 'an unbuilt game has no play column at all');
  // Only the snake has something to change today; every other game says so.
  const games = [...html.matchAll(/\{id:'(\w+)'[^}]*\}/g)];
  const withLook = games.filter((m) => /\blook:1/.test(m[0])).map((m) => m[1]);
  assert.deepStrictEqual(withLook, ['snake']);
  assert.ok(html.includes("'Nothing to change in '+(cur?cur.name:'this game')+' yet'"), 'the shut bar says so');
  assert.ok(/function openLook\(\)\{\s*if\(!\(cur&&cur\.look&&LOOKS\.length\)\)return;/.test(html), 'and does not open');
});

test('the bar is called Customize and the lobby loads the frozen skin file read-only', () => {
  const html = v2();
  assert.ok(html.includes('<span class="lkt"><b>Customize</b>'), 'Owen named it Customize (2026-10-10)');
  const sprites = html.indexOf('<script src="/js/sl/slSprites.js"></script>');
  const look = html.indexOf('<script src="/js/v2/look.js"></script>');
  assert.ok(sprites > 0 && look > sprites, 'slSprites before look.js');
});

test('the skin choice is cosmetic: no money path reads it', () => {
  const money = ['public/js/slx/slxPaid.js', 'wallet-widget/src/main.jsx', 'public/js/v2/wallet.js', 'public/js/v2/play.js'];
  for (const f of money) {
    assert.ok(!fs.readFileSync(path.join(ROOT, f), 'utf8').includes('duel.sl.skin'), f + ' does not read the skin');
  }
});
