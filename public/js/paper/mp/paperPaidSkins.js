// Paper multiplayer: bought skins in the skin manager (docs/skin-purchases.md). A bought skin is worn as
// 'paper:<id>' (shared/shopSkins.js SKINS.paper): its colours come from the shop's one colour exactly as a plain
// colour skin's come from its hex, and in a browser its territory is filled with the shop's design as a repeating
// canvas pattern. This is a new file and not an edit of paperSkins.js because the solo files stay byte-identical to the
// golden-run build (paperParityGate.test.js); it only adds methods to the stock P.SkinManager, so the solo game
// never meets them. Needs paperSkins.js first. Loaded by the arena page and by the server (loadPaperLib.js).
(function (root) {
  'use strict';
  var P = root.DuelPaperLib;
  if (!P || !P.SkinManager || !P.SkinManagerBase || !P.ColorSkinPool) {
    throw new Error('paperPaidSkins: load paperSkins.js first');
  }
  var SM = P.SkinManager.prototype;
  if (SM.registerPaidByName) return; // loaded twice

  // A bought skin's name on the wire and in the manager. A palette skin is named by its hex, so this never collides.
  var PREFIX = 'paper:';
  // The lobby's preview (public/js/v2/shopArt.js paintPaper) draws a skin's design across a 15 world-unit square beside
  // an 8 unit track; a territory repeats that same square, so the design keeps the preview's proportions in play.
  var TILE_UNITS = 15;

  // The stock colour skin for `hex`, named `name`. The pool's own add() builds it (colours derived from the hex, and on
  // a page the head's layers, which need canvases), run on a throwaway pool so nothing is added to the real one.
  function colorAsset(config, hex, name) {
    var pool = Object.create(P.ColorSkinPool.prototype);
    pool.name = 'colors';
    pool.config = typeof document === 'undefined' ? undefined : config; // no canvases on the server: colours only
    pool.assets = [];
    pool.add([hex]);
    var asset = pool.assets[0];
    asset.name = name;
    return asset;
  }

  /* The territory fill of a bought skin: its colour with its design over it, as a repeating canvas pattern in the
     shape the stock SkinPattern leaves (`.pattern`, the CanvasPattern the renderer fills with). The design is drawn by
     shared/shopSkins.js paperArt, the very code the lobby's preview uses, in the preview's ink (the side colour, or
     white for the stars). `k` is the shop's { id, col, art }; `shop` is that file's api. Browser only: with no canvas
     (the server, a node test) it is null and the skin is its plain colour. */
  function patternFor(config, k, shop, back) {
    try {
      if (typeof document === 'undefined' || typeof shop.paperArt !== 'function') return null;
      var maxScale = (config && config.maxScale) || P.defaultPaperConfig.maxScale;
      var res = maxScale * 2; // twice the closest zoom, so a close-up stays sharp
      var size = Math.max(16, Math.round(TILE_UNITS * res));
      var tile = document.createElement('canvas');
      tile.width = size;
      tile.height = size;
      var ctx = tile.getContext('2d');
      if (!ctx) return null;
      ctx.fillStyle = k.col;
      ctx.fillRect(0, 0, size, size);
      // The design with its eight neighbours too: a dot or star over the edge of one tile is the other side's
      // spill-over in the next, so the repeat has no half shapes at the seams.
      var ink = k.art === 'stars' ? '#ffffff' : back;
      for (var dx = -1; dx <= 1; dx++) {
        for (var dy = -1; dy <= 1; dy++) shop.paperArt(ctx, k, dx * size, dy * size, size, ink);
      }
      var pattern = ctx.createPattern(tile, 'repeat');
      var inverse = 1 / res; // the pattern is in world units, as SkinPattern's is
      if (!pattern || typeof pattern.setTransform !== 'function' || typeof DOMMatrix !== 'function') return null;
      pattern.setTransform(new DOMMatrix([inverse, 0, 0, inverse, 0, 0]));
      return { pattern: pattern, ready: true };
    } catch (e) {
      return null;
    }
  }

  /* Registers the bought skin the NAME on the wire ('paper:camo') stands for, once, from the shop's look (`shop` is
     shared/shopSkins.js's api; `config` the game's). It goes in `assets` ONLY, never `unusedAssets`, so a bot or a
     random get() can never be dealt it, and get(name) hands each wearer its own UnitSkin, so any number of players can
     wear the same one. -> true when the name is a bought skin that is registered now or was before; false for any
     other name (nothing is registered). */
  SM.registerPaidByName = function (name, shop, config) {
    if (typeof name !== 'string' || name.indexOf(PREFIX) !== 0) return false;
    if (this.assets[name]) return true; // built already, for an earlier wearer
    if (!shop || typeof shop.byId !== 'function') return false;
    var k = shop.byId('paper', name.slice(PREFIX.length));
    if (!k) return false;
    var asset = colorAsset(config, k.col, name);
    var pattern = patternFor(config, k, shop, asset.content.colors.back);
    if (pattern) asset.content.pattern = pattern;
    this.assets[name] = { asset: asset, tag: 'paid' };
    return true;
  };

  /* The stock release puts a skin's name back into the pool of free ones once nobody wears it, and throws for a skin
     already released. A bought skin must do neither: several players share it, a kill and then the arena stopping
     release the same skin twice, and it is never free for a bot or a random pick. */
  var stockRelease = P.SkinManagerBase.prototype.release;
  SM.release = function (skin) {
    var name = skin && skin.name;
    var entry = typeof name === 'string' ? this.assets[name] : null;
    if (!entry || entry.tag !== 'paid') return stockRelease.call(this, skin);
    var wearers = this.usedBy[name];
    if (!wearers) return;
    this.usedBy[name] = wearers.filter(function (other) { return other != skin; });
    if (this.usedBy[name].length == 0) delete this.usedBy[name];
  };

  P.PAID_SKIN_PREFIX = PREFIX;
})(typeof window !== 'undefined' ? window : globalThis);
