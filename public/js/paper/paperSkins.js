// Paper clone: game config defaults, colour palette, unit skins, skin pools, the skin manager and the
// avatar layer classes (offscreen bitmaps that the renderer stamps for each unit's head).
(function (root) {
  'use strict';
  var P = root.DuelPaperLib = root.DuelPaperLib || {};

  // ---------------------------------------------------------------------------------------------
  // Image loading.
  // The shipped game has no image skins, so nothing is ever requested. If a page installs image-skin
  // entries without a loader, a request simply never completes, which is the state the renderer handles
  // for an image that has not arrived yet: layers without a bitmap are skipped, territory uses colors.main.
  // A host page may install DuelPaperLib.skinImageLoader = function (url) -> Promise<image or canvas>.
  // ---------------------------------------------------------------------------------------------
  function requestSkinImage(url) {
    var loader = P.skinImageLoader;
    if (typeof loader === 'function') return loader(url);
    return new Promise(function () {});
  }

  function pixelWidthOf(source) { return source.naturalWidth || source.width; }
  function pixelHeightOf(source) { return source.naturalHeight || source.height; }

  // ---------------------------------------------------------------------------------------------
  // Avatar layers
  // ---------------------------------------------------------------------------------------------
  class AvatarLayer {
    constructor(config, layerDef, onLoaded) {
      this.level = 0;
      this.scale = 1;
      this.x = 0;
      this.y = 0;
      this.direction = '';
      this.rotation = 0;
      this.url = '';
      this.src = null;
      this.image = null;
      this.config = config;
      Object.assign(this, layerDef);
      this.pivot = Object.assign({ x: 0.5, y: 0.5 }, layerDef.pivot);

      var pending = null;
      if (this.url) pending = requestSkinImage(this.url);
      else if (this.src) pending = Promise.resolve(this.src);
      if (pending) {
        pending.then((loaded) => {
          this.src = loaded;
          this.rescale(1);
          if (onLoaded) onLoaded(this);
        });
      }
    }

    // Bakes the source into a bitmap sized for the closest camera zoom.
    rescale(displayScale) {
      var config = this.config;
      var basePixels = config.trackWidth * config.maxScale;
      var source = this.src;
      var sourceW = pixelWidthOf(source);
      var sourceH = pixelHeightOf(source);
      var factor = (basePixels * displayScale * this.scale) / sourceW;
      var outW = ~~(sourceW * factor);
      var outH = ~~(sourceH * factor);
      var scaleX = outW / sourceW;
      var scaleY = outH / sourceH;
      var bitmap = document.createElement('canvas');
      bitmap.width = outW;
      bitmap.height = outH;
      var ctx = bitmap.getContext('2d');
      ctx.scale(scaleX, scaleY);
      ctx.drawImage(source, 0, 0);
      this.image = bitmap;
    }
  }

  var svgMatrixFactory = null;

  // Repeating territory texture of an image skin.
  class SkinPattern {
    constructor(config, viewCanvas, basePath, patternDef, onReady) {
      if (patternDef === undefined) patternDef = {};
      this.url = basePath + patternDef.url;
      this.scale = patternDef.scale || 1;
      this.src = null;
      this.ready = false;
      var maxScale = config.maxScale;
      requestSkinImage(this.url).then((loaded) => {
        this.src = loaded;
        var sourceW = ~~pixelWidthOf(loaded);
        var sourceH = ~~pixelHeightOf(loaded);
        var factor = (100 * maxScale * this.scale) / sourceW;
        var tileW = Math.floor(sourceW * factor) || 1;
        var tileH = Math.floor(sourceH * factor) || 1;
        var tile = document.createElement('canvas');
        tile.width = tileW;
        tile.height = tileH;
        tile.getContext('2d').drawImage(loaded, 0, 0, tileW + 1, tileH + 1);
        this.pattern = viewCanvas.getContext('2d').createPattern(tile, 'repeat');
        var inverse = 1 / maxScale;
        if (!svgMatrixFactory) svgMatrixFactory = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        var matrix = svgMatrixFactory.createSVGMatrix().scale(inverse, inverse);
        if (this.pattern.setTransform) this.pattern.setTransform(matrix);
        this.ready = true;
        if (onReady) onReady();
      });
    }
  }

  class AvatarDisplay {
    constructor(config, basePath, avatarDef, onReady) {
      this.layers = [];
      this.scale = 1;
      this.x = 0;
      this.y = 0;
      this.ready = false;
      Object.assign(this, avatarDef);

      var loadedCount = 0;
      var layerLoaded = (layer) => {
        layer.rescale(this.scale);
        if (this.layers.length === ++loadedCount) {
          this.ready = true;
          if (onReady) onReady();
        }
      };

      this.layers = (this.layers || []).map(function (def) {
        var resolved = Object.assign({}, def, { url: def.url && '' + basePath + def.url });
        return new P.AvatarLayer(config, resolved, layerLoaded);
      });
      this.frontLayers = this.layers
        .filter(function (layer) { return layer.level >= 1; })
        .sort(function (a, b) { return a.level - b.level; });
      this.backLayers = this.layers
        .filter(function (layer) { return layer.level < 1; })
        .sort(function (a, b) { return b.level - a.level; });
    }
  }

  function collectEntries(displays, listName) {
    var groups = displays.map(function (display) {
      return display[listName].map(function (layer) { return { display: display, layer: layer }; });
    });
    return [].concat(...groups);
  }

  class AvatarLayerContainer {
    constructor() {
      this.displays = [];
      this.frontLayers = [];
      this.backLayers = [];
      this.maxScale = 0;
    }

    get ready() {
      return this.displays.every(function (display) { return display.ready; });
    }

    sort() {
      this.frontLayers = collectEntries(this.displays, 'frontLayers')
        .sort(function (a, b) { return a.layer.level - b.layer.level; });
      // Back layers are painted behind existing pixels, so the highest level goes first.
      this.backLayers = collectEntries(this.displays, 'backLayers')
        .sort(function (a, b) { return b.layer.level - a.layer.level; });
      this.maxScale = Math.max(...this.frontLayers.map(function (entry) {
        return entry.display.scale * entry.layer.scale;
      }));
    }

    add(display) {
      this.displays.push(display);
      this.sort();
    }

    remove(display) {
      this.displays = this.displays.filter(function (other) { return other !== display; });
      this.sort();
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Config defaults and the plain colour palette (order matters: the skin rng indexes into it)
  // ---------------------------------------------------------------------------------------------
  var defaultPaperConfig = {
    arenaSize: 2000,
    quadSize: 20,
    borderPoints: 300,
    prepareMult: 3,
    prepareBatchCount: 5,
    maxPreparingTime: 500,
    baseRadius: 30,
    baseCount: 50,
    minScale: 3,
    maxScale: 4.5,
    observerScale: 2.5,
    trackWidth: 8,
    unitSpeed: 90,
    spawnTimeout: 3000,
    prepareCounter: 6000,
    prepareAcceleration: 30,
    baseHeight: 2,
    botsCount: 15,
    botLevel: -1,
    startBotLevel: 0.1,
    noPlayerBotLevel: 0.5,
    nearPlayerBotSpawnCount: 1,
    followKiller: true,
    selfKillDelay: 1000,
    enemyKillDelay: 2000,
    arenaColor: '#e7fff4',
    borderColor: '#88a799',
    backgroundTopColor: '#2d6998',
    backgroundBottomColor: '#81faff',
    platesStrokeWidth: 0,
    botAggroMin: 0.2,
    botAggroMax: 1,
    botDefMin: 1.2,
    botDefMax: 0.6,
    botGreedMin: 0.1,
    botGreedMax: 0.6,
    botSafetyMin: 0.5,
    botSafetyMax: 1,
    botAttackTrackLength: 1500,
    font: 'PT Sans Caption'
  };

  var playerColorPalette = [
    '#3b5998', '#8b9dc3', '#2a4d69', '#4b86b4', '#8dbdff', '#64a1f4',
    '#3b7dd8', '#843b62', '#8874a3', '#8d5524', '#c68642', '#f1c27d',
    '#f77f00', '#fcbf49', '#ffe066', '#65737e', '#a7adba', '#4a7c59',
    '#1a936f', '#88d498', '#2a9d8f', '#68b0ab', '#99e550', '#6abe30',
    '#4b692f', '#8f974a', '#8a6f30', '#524b24', '#d62828', '#fe4a49',
    '#ed6a5a', '#ff3377', '#ff77aa', '#ff99cc', '#b23a48', '#fcb9b2'
  ];

  // ---------------------------------------------------------------------------------------------
  // Colour helpers that the geometry module does not export
  // ---------------------------------------------------------------------------------------------
  function hexByte(value) {
    var text = value.toString(16);
    return text.length < 2 ? '0' + text : text;
  }
  function rgbToHex(rgb) {
    return '#' + hexByte(rgb.r) + hexByte(rgb.g) + hexByte(rgb.b);
  }
  function hsvToHex(hsv) {
    return rgbToHex(P.hsvToRgb(hsv));
  }

  // ---------------------------------------------------------------------------------------------
  // Skin, assets and pools
  // ---------------------------------------------------------------------------------------------
  class UnitSkin {
    constructor() {
      this.config = undefined;
      this.user = undefined;
      this.name = undefined;
      this.assets = [];
      this.colors = { main: 'black', back: 'black', nick: 'black', plate: 'black', particles: ['black'] };
      this.pattern = null;
      this.container = new P.AvatarLayerContainer();
    }

    addAsset(asset) {
      var content = asset.content;
      if (content.colors) this.colors = content.colors;
      if (content.pattern) this.pattern = content.pattern;
      if (content.display) this.container.add(content.display);
      this.assets.push(asset);
    }
  }

  class SkinAssetBase {
    constructor(name) {
      this.pool = undefined;
      this.loadingStarted = false;
      this.name = name;
      this.content = {};
      this.ready = false;
    }

    load() {}
  }

  class ColorSkinAsset extends SkinAssetBase {
    constructor(pool, name, source) {
      super(name);
      this.pool = pool;
      this.source = source;
    }
  }

  class ClassicSkinAsset extends SkinAssetBase {
    constructor(pool, name, source) {
      super(name);
      this.pool = pool;
      this.source = source;
    }

    // Lazy: runs the first time the manager hands this skin out.
    load() {
      if (this.loadingStarted) return;
      this.loadingStarted = true;
      var content = this.content;
      var updateReady = () => {
        this.ready = content.display.ready && (content.pattern ? content.pattern.ready : true);
      };
      var source = this.source;
      var pool = this.pool;
      if (source.colors) {
        content.colors = Object.assign(
          { main: '#000000', back: '#000000', nick: '#000000', plate: '#000000', particles: ['#000000'] },
          source.colors
        );
      }
      if (source.pattern) {
        content.pattern = new P.SkinPattern(pool.config, pool.view, pool.path, source.pattern, updateReady);
      }
      if (source.avatar) {
        content.display = new P.AvatarDisplay(pool.config, pool.path, source.avatar, updateReady);
      }
    }
  }

  class SkinAssetPool {
    constructor(name) {
      this.config = undefined;
      this.name = name;
      this.assets = [];
    }

    get(name, requireReady) {
      var found = this.assets.find(function (asset) {
        return asset.name === name && (requireReady ? asset.ready === true : true);
      });
      if (!found) return null;
      found.load();
      return found;
    }
  }

  // Everything a plain colour skin shows is derived from its one hex value.
  function deriveColorSet(mainHex) {
    var rgb = P.hexToRgb(mainHex);
    var hsv = P.rgbToHsv(rgb);
    var backHex = hsvToHex(P.hsvScaleValue(hsv, 0.75));
    var nickHex = hsvToHex(P.hsvScaleValue(hsv, 0.5));
    var lighterHex = hsvToHex(P.hsvLightenValue(hsv, 2));
    var particleValues = [100, 90, 80, 70, 60, 50, 40, 30, 20];
    return {
      main: mainHex,
      back: backHex,
      nick: nickHex,
      plate: hsv.v > 50 ? nickHex : lighterHex,
      particles: particleValues.map(function (value) { return hsvToHex(P.hsvWithValue(hsv, value)); })
    };
  }

  class ColorSkinPool extends SkinAssetPool {
    constructor(config) {
      super('colors');
      this.config = config;
      this.add(P.playerColorPalette);
    }

    add(hexList) {
      var config = this.config;
      var pool = this;
      var created = (hexList || []).map(function (mainHex) {
        var colors = deriveColorSet(mainHex);
        var asset = new P.ColorSkinAsset(pool, mainHex, colors);
        asset.content.colors = colors;
        if (config) {
          asset.content.display = new P.AvatarDisplay(config, '', {
            layers: [
              { src: makeSquareAvatarCanvas(colors.nick, colors.nick) },
              { level: 1, src: makeSquareAvatarCanvas(colors.main, colors.back) }
            ]
          });
        }
        asset.ready = true;
        asset.name = mainHex;
        return asset;
      });
      this.assets.push(...created);
    }

    loadAsset(asset) {
      return asset;
    }
  }

  class ClassicSkinPool extends SkinAssetPool {
    constructor(config, view, path, skinDefs, preloadAll) {
      super('classic');
      this.config = config;
      this.view = view;
      this.path = path;
      this.add(skinDefs);
      if (preloadAll) {
        for (var asset of this.assets) asset.load();
      }
    }

    add(skinDefs) {
      var pool = this;
      this.assets.push(...(skinDefs || []).map(function (def) {
        return new P.ClassicSkinAsset(pool, def.name, def);
      }));
    }
  }

  // 100 px source for a plain colour head: outer frame colour with an 80 px centre.
  function makeSquareAvatarCanvas(innerColor, outerColor) {
    var canvas = document.createElement('canvas');
    canvas.width = 100;
    canvas.height = 100;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = outerColor;
    ctx.fillRect(0, 0, 100, 100);
    ctx.fillStyle = innerColor;
    ctx.fillRect(10, 10, 80, 80);
    return canvas;
  }

  // ---------------------------------------------------------------------------------------------
  // Skin manager. unusedAssets is an insertion-ordered map: a released skin goes back in at the END,
  // and the rng indexes into that key order, so the delete / re-add semantics are load-bearing.
  // ---------------------------------------------------------------------------------------------
  class SkinManagerBase {
    constructor(seed) {
      this.usedBy = {};
      this.assets = {};
      this.unusedAssets = {};
      this.rng = P.createSeededRng(seed);
    }

    registerAsset(asset, tag) {
      this.unusedAssets[asset.name] = this.assets[asset.name] = { asset: asset, tag: tag };
    }

    registerAssets(pool, tag) {
      for (var asset of pool.assets) this.registerAsset(asset, tag);
    }

    available(tag) {
      var entries = Object.values(this.unusedAssets);
      if (tag) return entries.filter(function (entry) { return entry.tag == tag; }).length;
      return entries.length;
    }

    has(name) {
      return name in this.unusedAssets;
    }

    // Always one rng draw, even when the candidate list is empty.
    randomAssetName(tag, unusedOnly) {
      if (unusedOnly === undefined) unusedOnly = true;
      var map = unusedOnly ? this.unusedAssets : this.assets;
      var names = Object.keys(map);
      if (tag) names = names.filter(function (name) { return map[name].tag == tag; });
      var index = this.rng(names.length);
      return names[index];
    }

    get(name, tag) {
      if (!name) name = this.randomAssetName(tag);
      var asset = this.assets[name].asset;
      delete this.unusedAssets[name];
      asset.load();
      var skin = new P.UnitSkin();
      skin.addAsset(asset);
      skin.name = name;
      this.usedBy[name] = (this.usedBy[name] || []).concat(skin);
      return skin;
    }

    release(skin) {
      var name = skin.name;
      this.usedBy[name] = this.usedBy[name].filter(function (other) { return other != skin; });
      if (this.usedBy[name].length == 0) {
        delete this.usedBy[name];
        this.unusedAssets[name] = this.assets[name];
      }
    }

    // Moves every current wearer of a skin onto a fresh random one so the player can take it.
    reskin(name) {
      var wearers = this.usedBy[name];
      if (wearers) {
        for (var skin of wearers) skin.user.setSkin(this.get());
        delete this.usedBy[name];
      }
    }
  }

  class SkinManager extends SkinManagerBase {
    constructor(colorPool, classicPool, seed) {
      super(seed);
      this.registerAssets(colorPool, 'colored');
      this.registerAssets(classicPool, 'classic');
    }

    getPlayerSkin(name) {
      if (!name) return this.get(null, 'colored');
      this.reskin(name);
      return this.get(name);
    }

    getBotSkin() {
      var order = this.rng() < 0.25 ? ['colored', 'classic'] : ['classic', 'colored'];
      var name = this.randomAssetName(order[0], true) || this.randomAssetName(order[1]);
      return this.get(name);
    }
  }

  // Same wiring the boot code uses: colour pool first, then the image-skin entries (none shipped), rng seed 1.
  function createSkinManager(config, view) {
    var colorPool = new P.ColorSkinPool(config);
    var classicPool = new P.ClassicSkinPool(config, view, P.skinAssetPath, P.skinsData);
    return new P.SkinManager(colorPool, classicPool, 1);
  }

  // ---------------------------------------------------------------------------------------------
  // Shipped skin data: colour skins only. The image-skin pool is EMPTY, so the manager always falls
  // through to the colour pool (getBotSkin tries both tags) and every unit gets a plain square head
  // built from generated canvases: nothing is fetched and nothing can be left undrawn.
  // The palette has 36 colours for at most botsCount + 1 = 16 units, so a free colour always exists.
  // A page may install its own entries on DuelPaperLib.skinsData / DuelPaperLib.skinAssetPath BEFORE this file loads.
  // ---------------------------------------------------------------------------------------------
  var DEFAULT_SKINS_DATA = [];
  var DEFAULT_SKIN_ASSET_PATH = '';

  P.AvatarLayer = AvatarLayer;
  P.SkinPattern = SkinPattern;
  P.AvatarDisplay = AvatarDisplay;
  P.AvatarLayerContainer = AvatarLayerContainer;
  P.defaultPaperConfig = defaultPaperConfig;
  P.playerColorPalette = playerColorPalette;
  P.UnitSkin = UnitSkin;
  P.SkinAssetBase = SkinAssetBase;
  P.ColorSkinAsset = ColorSkinAsset;
  P.ClassicSkinAsset = ClassicSkinAsset;
  P.SkinAssetPool = SkinAssetPool;
  P.ColorSkinPool = ColorSkinPool;
  P.ClassicSkinPool = ClassicSkinPool;
  P.makeSquareAvatarCanvas = makeSquareAvatarCanvas;
  P.SkinManagerBase = SkinManagerBase;
  P.SkinManager = SkinManager;
  P.createSkinManager = createSkinManager;
  P.skinsData = P.skinsData || DEFAULT_SKINS_DATA;
  P.skinAssetPath = P.skinAssetPath || DEFAULT_SKIN_ASSET_PATH;
  P.rgbToHex = P.rgbToHex || rgbToHex;
  P.hsvToHex = P.hsvToHex || hsvToHex;
})(typeof window !== 'undefined' ? window : globalThis);
