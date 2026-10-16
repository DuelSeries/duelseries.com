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

test('every game shows the bar, built or not (BACKLOG 2.2: one layout for every game)', () => {
  const html = v2();
  // Nothing on a playable game's screen hides the bar. A locked or unbuilt game (#detail.soon) hides it
  // with the name field, Spectate and the lobby row since 2026-10-15 (Owen: only what a shut game is).
  const hides = (html.match(/#detail\.[\w.]+ [^{]*\{display:none\}/g) || []).filter((r) => !/^#detail\.soon /.test(r));
  for (const r of hides) {
    assert.ok(!/\.lookrow(?![\w-])/.test(r.replace(/\.lookrow \.l\w+|\.lookrow canvas/g, '')),
      'nothing hides the bar: ' + r);
  }
  // Only the snake SAVES a skin (look:1). Since 2026-10-15 every other built
  // game opens the same chooser too, with its free look and its Shop skins
  // locked (Owen's ask); a game with no Shop skins stays shut, with no sentence.
  const games = [...html.matchAll(/\{id:'(\w+)'[^}]*\}/g)];
  const withLook = games.filter((m) => /\blook:1/.test(m[0])).map((m) => m[1]);
  assert.deepStrictEqual(withLook, ['snake']);
  assert.ok(html.includes('const hasLook=g=>!!(g&&(g.look||(window.V2Shop&&V2Shop.game(g.id))));'),
    'a game has a chooser if it saves a skin or the Shop has skins for it');
  assert.ok(/function openLook\(\)\{\s*if\(!hasLook\(cur\)\)return;/.test(html), 'and does not open otherwise');
  assert.ok(html.includes("det.classList.toggle('nolook',!hasLook(cur));"), 'the shut bar is a class');
  // Owen 2026-10-15: no small print. The shut bar no longer says there is nothing to change.
  assert.ok(!html.includes('Nothing to change in'), 'the shut bar carries no sentence');
  // agar.io's Customize is the same chooser as every other game's: its settings are gone (Owen 2026-10-15).
  const veil = html.slice(html.indexOf('<div id="lookveil"'), html.indexOf('<div class="ap-save-row">'));
  assert.ok(!veil.includes('agtg') && !html.includes('agset'), 'no settings band in the chooser');
  // A locked Shop skin can be looked at, never saved, and only slither stores anything.
  const close = html.slice(html.indexOf('function closeLook'), html.indexOf('function closeLook') + 400);
  assert.ok(close.includes('if(save&&s&&s.locked)return;'), 'Save on a locked skin does nothing');
  assert.ok(close.includes('if(save&&cur&&SAVED[cur.id]&&s){'), 'and only a game that keeps a skin stores one');
  const saved = html.slice(html.indexOf('const SAVED={'), html.indexOf('const wornIn='));
  assert.deepStrictEqual([...saved.matchAll(/^ {2}(\w+):\{worn:/gm)].map((m) => m[1]), ['snake', 'agar'],
    'slither.io and agar.io keep a skin, nothing else does');
  const meta = html.slice(html.indexOf('function lookMeta'), html.indexOf('function lookMeta') + 700);
  assert.ok(meta.includes('btn.disabled=!!s.locked'), 'the Save button is disabled on a locked skin');
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

// ── the chooser polish (Owen 2026-10-15) ─────────────────────────────────────────
// lookList run for real: the Shop's art and prices and agar's free list, as the page loads them.
function lookListFor(id) {
  // In node these two land on module.exports, not on the page's window globals the lobby reads.
  globalThis.DS_SHOP_PRICES = require('../shared/shopPrices.js');
  globalThis.DS_AG_SKINS = require('../shared/agSkins.js');
  require('../public/js/v2/shopArt.js');
  const html = v2();
  const src = html.slice(html.indexOf('const AGS=window.DS_AG_SKINS;'), html.indexOf('let LK=[];'));
  const fn = new Function('window', 'localStorage', 'LOOKS', 'V2Shop', 'skin', 'storeSkin',
    src.replace(/^const /gm, 'var ') + '\nreturn lookList;');
  const store = { getItem() { return null; }, setItem() {}, removeItem() {} };
  const LOOKS = V2Look.skins.map((cv) => ({ id: String(cv), cv, name: V2Look.name(cv) }));
  const lookList = fn(globalThis, store, LOOKS, globalThis.V2Shop, () => null, () => {});
  return lookList({ id, look: id === 'snake' ? 1 : 0 });
}

test('every chooser lists all its free skins first, then every paid one in one run', () => {
  for (const id of ['snake', 'agar', 'paper', 'knockout', 'battleship', 'omgshooter', 'tanks']) {
    const list = lookListFor(id);
    const firstPaid = list.findIndex((s) => s.locked);
    assert.ok(firstPaid > 0, id + ' starts with a free skin');
    assert.ok(list.slice(firstPaid).every((s) => s.locked), id + ': nothing free after the first paid skin');
    assert.strictEqual(list.length - firstPaid, globalThis.V2Shop.game(id).skins.length, id + ': every Shop skin is there');
    assert.ok(list.filter((s) => s.locked).every((s) => s.price != null), id + ': every paid skin has a price');
  }
  assert.strictEqual(lookListFor('snake').findIndex((s) => s.locked), 54, 'slither: the 54 free skins, then the paid');
  const agar = lookListFor('agar');
  assert.strictEqual(agar[0].id, 'default', 'agar.io: Random colour first');
  assert.strictEqual(agar.findIndex((s) => s.locked), 1 + require('../shared/agSkins').SKINS.length,
    'then every free colour, then the paid');
});

test('a locked skin in the middle darkens the screen and centres its padlock and price', () => {
  const html = v2();
  assert.ok(/<div class="ap-scrim" id="ap-scrim"/.test(html), 'there is a screen-wide scrim');
  assert.ok(/<div class="ap-lockfx" id="ap-lockfx"[\s\S]{0,400}<svg[\s\S]{0,400}<b id="ap-lockprice"/.test(html),
    'and a centred padlock with the price under it');
  const css = html.slice(html.indexOf('.ap-scrim{'), html.indexOf('.ap-scrim{') + 900);
  assert.ok(/\.ap-scrim\{position:absolute;inset:0;z-index:52;pointer-events:none;opacity:0/.test(css),
    'the scrim covers the screen, takes no touches and starts clear');
  assert.ok(/\.ap-lockfx\{[^}]*display:flex;align-items:center;justify-content:center;pointer-events:none;opacity:0/.test(css),
    'the seal sits dead centre of the reel box');
  // The header (Back), the arrows and Save stay above the scrim, so the way out never darkens.
  assert.ok(/\.ap-selector\{[^}]*z-index:54\}/.test(html) && /\.ap-save-row\{[^}]*z-index:53\}/.test(html));
  const show = html.slice(html.indexOf('function lockShow'), html.indexOf('function lockShow') + 600);
  assert.ok(show.includes('sc.style.opacity=k.toFixed(3)') && show.includes('fx.style.opacity=k.toFixed(3)'),
    'both follow how near the middle the paid skins are');
  // Still look only: Unlock is a dead button and no buy path exists.
  const close = html.slice(html.indexOf('function closeLook'), html.indexOf('function closeLook') + 500);
  assert.ok(!/fetch\(|\/api\/buy|purchase/i.test(close));
});

test('the preview swims with slither.io\'s own Change Skin numbers', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/v2/look.js'), 'utf8');
  // slither-reference/beautified/game.js: csk.onclick (27 points, 10 apart, rex 1.66, sep 18.25) and the
  // choosing_skin branch of the frame loop (cos(j / 4 + fr / 19) * 15 * (1 - j / pts.length), vfr = ms / 8).
  assert.ok(src.includes('var PTS = 27, GAP_U = 10, SWING = 15, RAD = 14.5, REX = 1.66;'));
  assert.ok(src.includes('var MCT = 6 / (18.25 / 6);'));
  assert.ok(src.includes('var MS_PER_FR = 8, FR_PER_RAD = 19;'));
  assert.ok(src.includes('Math.cos(j / 4 + ph) * SWING * (1 - j / PTS) * k'), 'the wave, j from the tail');
  // Eyes straight ahead: no angle in the eye maths at all, and the pupil pushed forward by rex.
  const eyes = src.slice(src.indexOf('Their eyes (drawEyes)'), src.indexOf('ctx.globalAlpha = 1;'));
  assert.ok(!/Math\.(cos|sin)|an\[0\]/.test(eyes), 'eyes face angle 0 (forward), never the wave');
  assert.ok(eyes.includes('(o.ed + 0.5 + REX) * k'), 'pupils sit forward in the whites');
  // The lobby feeds it seconds of real time, so the speed is theirs at any frame rate.
  assert.ok(v2().includes('lookT=nowMs/1000;'), 'the preview clock is in seconds');
});

test('the reel scrolls itself: momentum, a landing on a skin, no browser scroll box', () => {
  const html = v2();
  assert.ok(html.includes('const DECEL_NORMAL=0.998, DECEL_FAST=0.99;'), 'UIScrollView\'s two deceleration rates');
  const reelCss = html.slice(html.indexOf('.ap-reel{'), html.indexOf('}', html.indexOf('.ap-reel{')));
  assert.ok(!/overflow-y:auto|scroll-snap/.test(reelCss), 'no native scroll box or snapping');
  assert.ok(/#lookveil\{touch-action:none/.test(html), 'the reel owns every finger on the screen');
  // The reel moves in the same frame as the paint, before it, so no slot shows its old skin in a new place.
  const at = html.indexOf('function lobbyLoop');
  const loop = html.slice(at, html.indexOf('requestAnimationFrame(lobbyLoop);', at));
  assert.ok(loop.indexOf('reelStep(nowMs)') > 0 && loop.indexOf('reelStep(nowMs)') < loop.indexOf('paintLook(cv)'));
  // The aim: a release's natural end, rounded to a skin, reached by an ease-out that leaves at the finger's speed.
  assert.ok(html.includes('const reelAim=v=>Math.round(REEL.pos+v/LN_NORMAL);'));
  assert.ok(html.includes('T=Math.min(GLIDE_MAX_MS,Math.max(SETTLE_MS,EASE_P*d/v));'));
  assert.ok(html.includes('REEL.pos=REEL.to-(REEL.to-REEL.from)*Math.pow(1-u,EASE_P);'));
});
