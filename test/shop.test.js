/* The Shop tab's skins and prices (Owen, 2026-10-15): look only, nothing for
   sale. Prices live in shared/shopPrices.js, the one file Owen edits; the
   skins and their previews in public/js/v2/shopArt.js. */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PR = require(path.join(ROOT, 'shared/shopPrices.js'));

/* The art files are browser scripts: run them in one sandbox standing in for
   the lobby page, with the scripts the lobby loads before them. */
function page() {
  const box = { console, Math, JSON };
  box.window = box; box.globalThis = box;
  vm.createContext(box);
  for (const f of ['shared/shopPrices.js', 'shared/shopSkins.js', 'public/js/shooterArt.js', 'public/js/battleshipArt.js', 'public/js/v2/shopArt.js'])
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), box, { filename: f });
  return box;
}
/* A 2D context that accepts every call and remembers nothing, so a preview
   can be run end to end without a real canvas. */
function fakeCanvas() {
  const grad = { addColorStop() {} };
  const ctx = new Proxy({}, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => grad;
      return () => {};
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  return { width: 200, height: 160, getContext: () => ctx };
}
function lobbyGames() {
  const html = fs.readFileSync(path.join(ROOT, 'public/v2.html'), 'utf8');
  const list = html.slice(html.indexOf('const GAMES=['), html.indexOf('\n];', html.indexOf('const GAMES=[')));
  // a name is a literal, or Pac-Man's one constant (window.DS_CHOMP_NAME||'Chomp', shared/chompName.js)
  return [...list.matchAll(/\{id:'(\w+)',name:(?:'[^']*'|window\.\w+\|\|'[^']*')[^\n]*/g)]
    .filter(m => !/\bsoon:1\b/.test(m[0])).map(m => m[1])
    /* Head Soccer's Shop heads are coming (Owen 2026-10-27: "add heads later"), and 8 Ball Pool's cues with them; until they are, neither is held to this. */
    .filter(id => id !== 'headsoccer' && id !== 'pool8')
    /* Air Hockey's mallets come later too (built 2026-10-27 with no Shop look yet). */
    .filter(id => id !== 'airhockey')
    .filter(id => id !== 'rooftop');   // Rooftop Snipers: its looks are free ones in Customize (shared/rtLooks.js)
}

test('every game in the lobby that has been built has its own skins in the Shop', () => {
  const S = page().V2Shop;
  const built = lobbyGames();
  assert.ok(built.length >= 7, 'found the lobby games: ' + built.join(', '));
  for (const id of built) assert.ok(S.game(id), id + ' has a Shop section');
  assert.strictEqual(S.games.map(g => g.id).sort().join(), built.slice().sort().join(), 'and nothing else does');
});

test('8 skins per game, each with its own id and name', () => {
  for (const g of page().V2Shop.games) {
    assert.strictEqual(g.skins.length, 8, g.id + ' has 8 skins (Owen, 2026-10-15)');
    assert.strictEqual(new Set(g.skins.map(k => k.id)).size, 8, g.id + ' ids are distinct');
    assert.strictEqual(new Set(g.skins.map(k => k.name)).size, 8, g.id + ' names are distinct');
  }
});

test('every skin has a price, every price has a skin, all in whole or cent dollars', () => {
  const S = page().V2Shop;
  for (const g of S.games)
    for (const k of g.skins) {
      const p = PR.price(g.id, k.id);
      assert.ok(typeof p === 'number' && p > 0, g.id + '/' + k.id + ' has a price in shared/shopPrices.js');
      assert.strictEqual(Math.round(p * 100), p * 100, g.id + '/' + k.id + ' is whole cents');
    }
  for (const gid of Object.keys(PR.PRICES))
    for (const kid of Object.keys(PR.PRICES[gid]))
      assert.ok(S.game(gid) && S.game(gid).by[kid], gid + '/' + kid + ' in shopPrices.js is a real skin');
});

test('rarity comes from the price', () => {
  assert.deepStrictEqual(PR.TIERS.map(t => t.name), ['Common', 'Rare', 'Epic', 'Legendary']);
  for (let i = 1; i < PR.TIERS.length; i++) assert.ok(PR.TIERS[i].from > PR.TIERS[i - 1].from, 'tiers climb');
  assert.strictEqual(PR.tier(PR.TIERS[0].from), 0);
  assert.strictEqual(PR.tier(PR.TIERS[3].from + 10), 3);
  assert.strictEqual(PR.tier(null), null);
  assert.strictEqual(PR.price('snake', 'nope'), null);
});

test('a slither skin is one the real game could draw: only custom-skin colours', () => {
  /* slither's custom skins may use colours 0 to 35, 37, 39 and 41
     (public/js/sl/slSprites.js csks); anything else setSkin drops. */
  const ok = new Set([...Array(36).keys(), 37, 39, 41]);
  for (const k of page().V2Shop.game('snake').skins) {
    assert.ok(Array.isArray(k.runs) && k.runs.length, k.id + ' is stripe runs');
    for (const [count, col] of k.runs) {
      assert.ok(Number.isInteger(count) && count >= 1 && count <= 255, k.id + ' run length');
      assert.ok(ok.has(col), k.id + ' colour ' + col + ' is one a custom skin may use');
    }
  }
});

test('every preview draws without throwing, and Battleship gets its own colours back', () => {
  const box = page();
  const S = box.V2Shop;
  const hull = JSON.stringify(box.BattleshipArt.HULL);
  for (const g of S.games) {
    if (g.id === 'snake') continue;                   // drawn by V2Look over slither's sprites, checked in the browser
    for (const k of g.skins) { S.paint(fakeCanvas(), g.id, k.id, 1.5, false); S.paint(fakeCanvas(), g.id, k.id, 1.5, false, true); }
    S.paint(fakeCanvas(), g.id, g.skins[0].id, 0, true);
    /* Customize's free look for the game, drawn alone in the chooser. */
    assert.ok(S.defaultName(g.id), g.id + ' has a free look with a name');
    S.paint(fakeCanvas(), g.id, 'default', 3.3, false, true);
  }
  assert.strictEqual(JSON.stringify(box.BattleshipArt.HULL), hull, 'the game\'s HULL is unchanged after the shop drew');
  assert.ok(box.ShooterArt.TEAMS.you && box.ShooterArt.TEAMS.foe, 'the shooter\'s own teams are untouched');
});

test('the server reads the prices in exactly one place, and never the lobby\'s art', () => {
  /* Skins are sold since 2026-10-16 (docs/skin-purchases.md). The price of a
     sale comes from server/skinCatalog.js alone, so no other server file can
     charge a different number; no server file reads the lobby's preview code. */
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []);
  for (const f of walk(path.join(ROOT, 'server'))) {
    const src = fs.readFileSync(f, 'utf8'), rel = path.relative(ROOT, f).replace(/\\/g, '/');
    assert.ok(!/shopArt|V2Shop/.test(src), rel + ' does not touch the lobby\'s shop art');
    if (rel !== 'server/skinCatalog.js') assert.ok(!/shopPrices/.test(src), rel + ' does not read the prices itself');
  }
});
