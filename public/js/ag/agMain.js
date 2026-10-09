// Session and frame loop for the agar.io redo client. It owns nothing of the game rules: the
// server simulates, this page decodes (agNet + agWire), keeps the client world (agWorld),
// eases the camera (agCamera), draws the world (agRender) and the canvas HUD (agHud), shows the
// menu and the death panel (agScreens), plays our own sounds (agSound) and reads input
// (agInput). This file only wires them together in the reference client's frame order.
//
// Frame order (client-render 1, client-camera-input 3, client-hud 3), one animation frame:
//   app layer   input.frame(edge)           the mouse copy; runs on every frame, capped or not
//   step 1      FPS cap gate                whole milliseconds since the last drawn frame
//   step 2      canvas size                 camera + HUD relayout on a change
//   step 3      clearRect
//   step 4      stop until the canvas has a real size
//   step 5      now = performance.now()     also the world clock
//   step 6      sort the live list by displayed size
//   step 7      target send gate            uses the previous frame's camera and scale
//   step 8      text stagger counter
//   step 9      membrane update             previous frame's view
//   step 10-11  wheel clamp, zoom, own cells interpolated, camera
//   step 12-13  grid and world pass
//   step 14     HUD, then the per-life bookkeeping
//   step 15     membranes allowed again, dying-node clean-up
// After the frame, an idle pass (requestIdleCallback, at least 2 ms of idle time) runs the
// membrane update if the frame did not, re-interpolates every node at the client clock and
// runs the clean-up: the same idle step the reference page runs from its own idle callback
// (client-render 1.1). It is CHOSEN to ship (PARITY-LOG): browsers without
// requestIdleCallback get the step-9 update only.
//
// Messages (mirror messages, build brief 6) are applied the moment they arrive, on frames the
// cap does not draw too; only the drawing is skipped. Game-state changes reach the FPS cap one
// task later (a 0 ms timer), as the reference page's menu watcher does.
//
// Session API (build brief 6): window.duelAgar = { feed(msg), play(name), spectate(),
// debugLists(), state(), onSend, config, on(event, fn), menu(), destroy() }.
(function (root) {
  'use strict';
  var A = root.DuelAgarLib = root.DuelAgarLib || {};

  // Frame pacing (client-camera-input 7.3, build brief fact 2.4).
  var CAP_START_MS = Math.fround(33.333332); // before the first game-state change
  var MENU_FPS = 25;                          // every state but play and spectate
  var IDLE_MIN_MS = 2;                        // the idle pass needs this much idle time
  var SECOND_MS = 1000;                       // the once-a-second tick
  var NICK_MAX = 15;                          // name box cap (build brief 7.2, L37 client half)
  // The shipped page connects once the Ubuntu face has loaded, or after this long without it
  // (CHOSEN, Owen 2026-10-08, PARITY-LOG). The reference page has no such wait; it only keeps
  // canvas text off until the face is in, which fontsReady() below does here too.
  var FONT_WAIT_MS = 3000;
  var FONT_PROBE = '700 100px Ubuntu';
  // Canvas backing scale per quality setting (client-camera-input 7.1); "Retina" is the default
  // and uses the device pixel ratio read when the quality is applied.
  var QUALITY_SCALE = { High: 1, Medium: 0.9, Low: 0.75, VeryLow: 0.5 };
  var QUALITY_LEVEL = { Retina: 0, High: 1, Medium: 2, Low: 3, VeryLow: 4 };
  var QUALITY_NAMES = ['Retina', 'High', 'Medium', 'Low', 'VeryLow'];
  // Our page keeps the drawing settings between visits (CHOSEN; a per-viewer convenience).
  var SETTINGS_KEY = 'agSettings';
  var SETTING_FLAGS = ['names', 'colors', 'showMass', 'dark'];

  function capFor(fps) { return fps > 0 ? Math.fround(1000 / fps) : -1; }

  // A quality name from a name or a level number; anything else is the default.
  function qualityName(q) {
    if (typeof q === 'number') return QUALITY_NAMES[q] || 'Retina';
    return Object.prototype.hasOwnProperty.call(QUALITY_LEVEL, q) ? q : 'Retina';
  }

  // The monotonic clock in whole nanoseconds, built the way the reference splits it (seconds,
  // then the nanosecond remainder), so the cap's whole-millisecond test matches it.
  function clockNs(ms) {
    var sec = Math.trunc(ms / 1000);
    return sec * 1e9 + Math.trunc((ms - sec * 1000) * 1000 * 1000);
  }

  function lib(name) {
    var m = A[name];
    if (!m) throw new Error('agMain: ' + name + ' is not loaded');
    return m;
  }

  function boot(cfg) {
    cfg = cfg || {};
    var win = cfg.win || root;
    var doc = cfg.doc || win.document;
    var perf = win.performance || { now: function () { return new Date().getTime(); } };
    function perfNow() { return perf.now(); }

    var agWorld = lib('agWorld'), agCamera = lib('agCamera'), agRender = lib('agRender');
    var agHud = lib('agHud'), agScreens = lib('agScreens'), agSound = lib('agSound'), agInput = lib('agInput');

    var canvas = cfg.canvas || doc.getElementById('canvas');
    if (!canvas) throw new Error('agMain: no #canvas');
    var ctx = canvas.getContext('2d');
    var bannerPx = cfg.bannerPx | 0;          // 90 on the harness page (fact 2.2), 0 shipped
    // Owen 2026-10-08 ("size as if the strip were there"): the shipped page draws on the whole
    // window, but every size the reference derives from its canvas (draw scale, HUD scale,
    // leaderboard, bottom panels, menu scale) comes from the canvas it would have above its
    // 90 px ad strip, and the world uses the transform of that canvas. The extra rows at the
    // bottom just show more map. 90 on the shipped page, 0 on the harness page (which has the
    // real strip instead, bannerPx).
    var ghostBannerPx = Math.max(0, cfg.ghostBannerPx | 0);
    var layoutH = 0;                          // the ghost layout's canvas height, canvas px
    // Phone portrait (ours, Owen 2026-10-08, FIX-PLAN P4; the shipped page only: cfg.portrait). A
    // touch screen held upright plays the reference screen turned on its side: the camera and the
    // HUD use their formulas with the two sides swapped, on the whole canvas (no ghost strip: it
    // belongs to the bottom of the landscape page; CHOSEN, PARITY-LOG 2026-10-09 P4), the server is
    // told (ag:portrait) so it sends the turned view box of the same area, and the first time in a
    // tab session a "turn your phone sideways" card shows for a few seconds (agPortrait). Sideways
    // it is the exact reference layout. Off at parity: the harness page never sets cfg.portrait.
    var portraitAllowed = cfg.portrait === true;
    var portrait = false;                     // the portrait layout is in use
    var quality = qualityName(cfg.quality || 'Retina');
    var settings = {
      names: true, showMass: false, colors: true, dark: false, acid: false,
      quality: QUALITY_LEVEL[quality], showAnimations: true, fontReady: fontsReady
    };
    // Stored settings (our shipped page only: cfg.persistSettings), then the page's own.
    var storage = null;
    if (cfg.persistSettings) {
      try { storage = cfg.storage || win.localStorage || null; } catch (e) { storage = null; }
    }
    var stored = readStoredSettings();
    for (var fi = 0; fi < SETTING_FLAGS.length; fi++) {
      if (typeof stored[SETTING_FLAGS[fi]] === 'boolean') settings[SETTING_FLAGS[fi]] = stored[SETTING_FLAGS[fi]];
    }
    if (typeof stored.quality === 'string') quality = qualityName(stored.quality);
    if (cfg.settings) {
      for (var sk in cfg.settings) {
        if (!Object.prototype.hasOwnProperty.call(cfg.settings, sk)) continue;
        if (sk === 'quality') quality = qualityName(cfg.settings.quality);
        else settings[sk] = cfg.settings[sk];
      }
    }

    function readStoredSettings() {
      if (!storage) return {};
      try {
        var v = JSON.parse(storage.getItem(SETTINGS_KEY) || '{}');
        return v && typeof v === 'object' ? v : {};
      } catch (e) { return {}; }
    }
    function storeSettings() {
      if (!storage) return;
      var v = { quality: quality };
      for (var i = 0; i < SETTING_FLAGS.length; i++) v[SETTING_FLAGS[i]] = !!settings[SETTING_FLAGS[i]];
      try { storage.setItem(SETTINGS_KEY, JSON.stringify(v)); } catch (e) { /* private window or full storage */ }
    }
    function shownSettings() {
      var v = { quality: quality };
      for (var i = 0; i < SETTING_FLAGS.length; i++) v[SETTING_FLAGS[i]] = !!settings[SETTING_FLAGS[i]];
      return v;
    }

    // ---- state the reference keeps outside the world ----------------------------------------
    var nick = '';
    var connected = false;      // set by the server hello
    var sentBelow = 0;          // the ghost rows last reported on this connection (ag:view)
    var sentPortrait = false;   // the layout last reported on this connection (ag:portrait)
    var gameState = 0;          // 0 play (and before), 8 spectate (client-hud 2.2)
    var fadeout = true;         // the dim layer's menu switch, on until the first Play
    var menuState = 'HOME';     // HOME, PLAY, SPECTATE, GAMEOVER
    var capMs = CAP_START_MS;
    var lastFrameNs = clockNs(perfNow());
    var lastDrawNow = null;
    var pending = { play: false, spectate: false };
    var lastRows = null;
    var destroyed = false;
    var canvasScale = 1;
    var net = null;

    // ---- modules ------------------------------------------------------------------------------
    var renderer = agRender.createRenderer({ partyIcon: cfg.partyIcon || null });
    var world = agWorld.createWorld({
      nick: '',
      setName: function (node, name) { renderer.setName(node, name); },
      dropName: function (node) { renderer.dropName(node); }
    });
    var cam = agCamera.createCamera();
    var hud = agHud.createHud({
      createContext: function () { return doc.createElement('canvas').getContext('2d'); },
      fontsLoaded: fontsReady,
      menuImage: cfg.menuImage || null
    });
    hud.setNames(settings.names);
    var stats = agScreens.createLifeStats();
    var sound = cfg.sound || agSound.createSound({});
    var screens = null;
    if (cfg.screens !== false) {
      screens = agScreens.createScreens({
        doc: doc,
        root: cfg.screensRoot || doc.body,
        onPlay: function (name) { play(name); },
        onSpectate: function () { spectate(); },
        onContinue: function () { setMenuState('HOME'); },
        soundButton: cfg.soundButton === false ? null : sound.createToggleButton(doc),
        injectCss: cfg.injectCss,
        settings: shownSettings(),
        onSettings: function (change) { setSettings(change); }
      });
      screens.showHome();
    }
    var graphFallback = null;
    function graphContext() {
      if (screens) return screens.graphContext();
      if (!graphFallback) {
        var g = doc.createElement('canvas');
        g.setAttribute('width', '350');
        g.setAttribute('height', '170');
        graphFallback = g.getContext('2d');
      }
      return graphFallback;
    }

    function fontsReady() {
      try { return !doc.fonts || doc.fonts.check('700 20px Ubuntu'); } catch (e) { return true; }
    }

    // ---- canvas size and quality (client-camera-input 7.1) ----------------------------------
    // Applying a quality sets the renderer's level, the animations switch (on for Retina and
    // High; it only gates animated skins, which are out of scope, so nothing here reads it) and
    // the canvas backing scale, then sizes the canvas. "Retina" reads the device pixel ratio
    // here and only here: a resize reuses the stored scale, as the reference's resize handler
    // does, until the quality is applied again (start-up, connect, a settings change).
    function applyQuality(q) {
      quality = qualityName(q);
      settings.quality = QUALITY_LEVEL[quality];
      settings.showAnimations = quality === 'Retina' || quality === 'High';
      canvasScale = quality === 'Retina' ? (win.devicePixelRatio || 1) : QUALITY_SCALE[quality];
      sizeCanvas();
    }
    // Both sides are written every time, even when unchanged (it resets the 2D context), as the
    // reference's canvas manager does on start-up, on resize and when the settings are applied.
    // The products are written as they are: the canvas truncates them itself, as theirs does.
    function sizeCanvas() {
      setPortrait(portraitNow());
      canvas.width = win.innerWidth * canvasScale;
      canvas.height = (win.innerHeight - bannerPx) * canvasScale;
      // The height their canvas would get above the ghost strip, truncated the way the canvas
      // truncates a written height. A window shorter than the strip gives 0, which draws
      // nothing (CHOSEN, PARITY-LOG; their canvas would fall back to its default height).
      // The portrait layout has no ghost strip.
      layoutH = ghostBannerPx && !portrait ? Math.max(0, Math.trunc((win.innerHeight - bannerPx - ghostBannerPx) * canvasScale)) : 0;
      applyMenuScale();
      reportView();
    }
    // ---- phone portrait (see portraitAllowed above) -----------------------------------------
    function portraitNow() {
      return portraitAllowed && coarsePointer() && win.innerHeight > win.innerWidth;
    }
    // The card shows the first time the portrait layout applies in a tab session (agPortrait;
    // the shipped page loads it). No agPortrait: the layout without the card.
    var rotatePrompt = null;
    if (portraitAllowed && A.agPortrait) {
      var tabStore = null;
      try { tabStore = cfg.tabStorage !== undefined ? cfg.tabStorage : (win.sessionStorage || null); } catch (e) { tabStore = null; }
      rotatePrompt = A.agPortrait.createRotatePrompt({ doc: doc, win: win, root: cfg.screensRoot || doc.body, storage: tabStore });
    }
    // Layout on or off: camera and HUD scale, the root class ag-portrait (ag.css lays the phone pad
    // out for it), and the card. The draw scale follows on the next frame, as after any resize.
    function setPortrait(on) {
      if (rotatePrompt) rotatePrompt.update(on);
      if (on === portrait) return;
      portrait = on;
      cam.setPortrait(on);
      hud.setPortrait(on);
      var el = doc.documentElement;
      if (el && el.classList) el.classList.toggle('ag-portrait', on);
    }
    // The map rows drawn under the ghost layout, in world units at zoom 1 (the layout's draw
    // scale, client-camera-input 6.4), rounded up. The server only sends what lies in its view
    // box (server law L4), which is built for the reference view, so the page tells it how much
    // further down it draws (ag:view; the server adds it to the box bottom, capped by law
    // VIEW_BELOW). Sent on the hello and on every change; 0 and never sent at parity (the
    // harness page), so the outbound stream there is the reference's.
    function ghostBelow() {
      var W = canvas.width, CH = canvas.height, H = layoutHeight(CH);
      if (!(W > 0) || !(H > 0) || !(CH > H)) return 0;
      return Math.ceil((CH - H) / agCamera.screenFactor(W, H));
    }
    // The portrait layout goes on ag:portrait (one boolean, our own wire: their client never
    // sends its screen), first, then the rows below. Sent on the hello and on every change only;
    // never at parity or sideways, where it stays false, the server's default.
    function reportView() {
      if (!connected) return;
      if (portrait !== sentPortrait) {
        sentPortrait = portrait;
        send('portrait', { on: portrait });
      }
      var n = ghostBelow();
      if (n === sentBelow) return;
      sentBelow = n;
      send('view', { below: n });
    }
    // Canvas height every derived size uses: the real one, or the ghost layout's (never taller).
    function layoutHeight(canvasH) {
      return ghostBannerPx && !portrait ? Math.min(layoutH, canvasH) : canvasH;
    }
    // Menu box scale (client-hud 6.3, the reference's menu fit) from the window above the strip,
    // real or ghost. Phones keep scale 1 (CHOSEN, PARITY-LOG: the formula gives about 0.24 on a
    // phone held upright). DOM only: no canvas call changes.
    function coarsePointer() {
      try { return !!(win.matchMedia && win.matchMedia('(pointer: coarse)').matches); } catch (e) { return false; }
    }
    function applyMenuScale() {
      if (!screens || !(win.innerWidth > 0)) return;
      screens.setScale(coarsePointer() ? 1 : agScreens.menuScale(win.innerWidth, win.innerHeight - bannerPx - ghostBannerPx));
    }
    if (doc.documentElement && doc.documentElement.style) doc.documentElement.style.setProperty('--ag-banner', bannerPx + 'px');
    applyQuality(quality);
    win.addEventListener('resize', sizeCanvas);
    // A 2-in-1 can switch between mouse and touch without a resize.
    var pointerQuery = null;
    try { pointerQuery = win.matchMedia ? win.matchMedia('(pointer: coarse)') : null; } catch (e) { pointerQuery = null; }
    // A switch that turns the portrait layout on or off sizes the canvas again (its layout height
    // changes); any other switch only sets the menu scale.
    function onPointerChange() {
      if (portraitNow() !== portrait) sizeCanvas();
      else applyMenuScale();
    }
    function watchPointer(on) {
      if (!pointerQuery) return;
      if (typeof pointerQuery.addEventListener === 'function') pointerQuery[on ? 'addEventListener' : 'removeEventListener']('change', onPointerChange);
      else if (typeof pointerQuery.addListener === 'function') pointerQuery[on ? 'addListener' : 'removeListener'](onPointerChange);
    }
    watchPointer(true);

    // ---- outbound ---------------------------------------------------------------------------
    var session = {};
    function send(kind, payload) {
      if (typeof session.onSend === 'function') {
        try { session.onSend(kind, payload); } catch (e) { /* a hook never breaks the game */ }
      }
      if (net) net.send(kind, payload);
    }
    function sendTarget(x, y) { send('target', { x: x, y: y }); }

    function ownCells() { return world.lists().own; }
    function displayedSizes() {
      var o = ownCells(), out = new Array(o.length);
      for (var i = 0; i < o.length; i++) out[i] = o[i].size;
      return out;
    }

    // ---- input (client-camera-input 8; phone stick and buttons CHOSEN) ------------------------
    var input = agInput.attachInput(canvas, {
      mouse: function (x, y) { cam.setMouse(x, y); },
      zoom: function (n) { cam.wheel(n); },
      split: function () {
        cam.sendTarget(sendTarget);   // flush the current target first
        send('split');
        var cue = agSound.splitCue(displayedSizes());
        if (cue) sound.playCue(cue);
      },
      eject: function () {
        cam.sendTarget(sendTarget);
        send('eject');
        var cue = agSound.ejectCue(displayedSizes());
        if (cue) sound.playCue(cue);
      },
      q: function () { send('q'); },
      menu: function () { openMenu(); }
    }, {
      win: win,
      doc: doc,
      canvasScale: function () { return canvasScale; },
      engineNow: cfg.engineNow,       // tests only; the page uses the input layer's default clock
      splitButton: cfg.splitButton || doc.getElementById('ag-split'),
      ejectButton: cfg.ejectButton || doc.getElementById('ag-eject'),
      canAct: padLive,
      touchFirst: cfg.touchFirst
    });
    function edgePoint(ux, uy) { return cam.stickPoint(ownCells(), ux, uy); }

    // Phone Split / Eject pad (ours, FIX-PLAN P1): shown and acting only while playing with own
    // cells, never on the menu (Esc included), while spectating or on the death panel. The root
    // element carries 'ag-alive' while that holds (ag.css shows the pad on touch screens only),
    // written only when it changes; the frame loop compares every frame and the state changes
    // below write at once. DOM only: no canvas call changes.
    var padShown = false;
    function padLive() { return menuState === 'PLAY' && ownCells().length > 0; }
    function setPadClass(on) {
      var root = doc.documentElement;
      if (root && root.classList) root.classList.toggle('ag-alive', on);
    }
    function syncPad() {
      var live = padLive();
      if (live === padShown) return;
      padShown = live;
      setPadClass(live);
    }

    // ---- game state and the FPS cap ---------------------------------------------------------
    // The reference menu applies a state change in a 0 ms timer and its watcher then sets the
    // cap in a microtask; the frame that runs the timer is still drawn under the old cap.
    function setMenuState(s) {
      menuState = s;
      syncPad();
      win.setTimeout(function () {
        Promise.resolve().then(function () {
          capMs = (menuState === 'PLAY' || menuState === 'SPECTATE') ? -1 : capFor(MENU_FPS);
        });
      }, 0);
    }

    function sendPlay() {
      gameState = 0;
      send('play', { name: nick });
    }
    function sendSpectate() {
      if (!connected) return;
      send('spectate');
      gameState = 8;
      world.setSpectating(true);
    }

    // What the Play button does: the nick is stored and sent at once if a world update has
    // arrived on this connection, else when the first one does.
    function play(name) {
      nick = String(name == null ? '' : name).slice(0, NICK_MAX);
      world.setNick(nick);
      hud.setLocalNick(nick);
      hud.onPlay();
      if (world.state().ready) sendPlay(); else pending.play = true;
      fadeout = false;
      input.setInGame(true);
      input.enableKeys();
      sound.setInGame(true);
      if (screens) screens.hide();
      setMenuState('PLAY');
    }
    function spectate() {
      if (world.state().ready) sendSpectate(); else pending.spectate = true;
      fadeout = false;
      input.setInGame(true);
      input.enableKeys();
      sound.setInGame(true);
      if (screens) screens.hide();
      setMenuState('SPECTATE');
    }
    // Esc: the menu opens over the running game, which is not paused.
    function openMenu() {
      fadeout = true;
      if (screens) screens.showHome();
      setMenuState('HOME');
    }

    // ---- world events -----------------------------------------------------------------------
    world.on('create', function (node) { renderer.initNode(node, cam.targetScale(), cam.scale); });
    world.on('ready', function () {
      if (pending.play) { pending.play = false; sendPlay(); }
      if (pending.spectate) { pending.spectate = false; sendSpectate(); }
    });
    // Connected: the reference page applies its settings again here, and the quality setting
    // re-sizes the canvas (two size writes on the frame the hello arrives).
    world.on('hello', function () {
      connected = true;
      applyQuality(quality);
    });
    world.on('border', function (p) {
      var b = p.border;
      cam.setBorder(b.minX, b.minY, b.maxX, b.maxY, ownCells().length);
      if (p.withMode) {
        gameState = 0;
        hud.setMode(world.state().mode);
      }
    });
    world.on('cam', function (p) { cam.onSpectateCam(p.x, p.y, p.zoom); });
    world.on('spawn', function (p) {
      cam.onSpawn(p.camY);
      if (gameState === 9) gameState = 3;   // a match-state rule of other modes; inert in FFA
      stats.spawn(p.now, p.node.rgb || [p.node.r, p.node.g, p.node.b]);
      hud.onSpawn();
      syncPad();
    });
    world.on('eat', function (p) {
      var e = {
        eaterOwn: p.eaterOwn, eatenOwn: p.eatenOwn, ownCount: ownCells().length,
        food: p.eaten.food, ejected: p.eaten.ejected, flag40: p.eaten.flag40, virus: p.eaten.virus
      };
      stats.eat(e);
      if (sound.playCues) sound.playCues(agSound.eatCues(e));
    });
    world.on('board', function (p) {
      lastRows = p.rows;
      hud.setBoard(p.rows, nick);
      stats.applyBoard(p.rows);
    });
    // Death (client-hud 6.2, 6.3): the mass graph first, then the board re-render, then this
    // life's numbers are taken and reset; the panel shows them. A death while the Esc menu is
    // open keeps the menu as it is (the game-over state becomes HOME when the state was HOME),
    // so no panel replaces the name entry; the FPS cap is the menu's either way.
    world.on('death', function (p) {
      agScreens.drawMassGraph(graphContext(), stats.history, stats.rgb);
      hud.onDeath();
      var snap = stats.death(p.now, lastRows);
      input.setInGame(false);
      sound.setInGame(false);
      syncPad();
      if (menuState === 'HOME') return;
      if (screens) screens.showStats(snap);
      setMenuState('GAMEOVER');
    });

    function applyMessage(msg) {
      if (!msg || typeof msg !== 'object' || destroyed) return;
      world.apply(msg, perfNow());
    }

    // ---- views ------------------------------------------------------------------------------
    // below: canvas rows under the layout height (the ghost strip's extra map), 0 at parity.
    var below = 0;
    function view() {
      return { W: cam.W, H: cam.H, s: cam.scale, camX: cam.x, camY: cam.y, targetScale: cam.targetScale(), below: below, portrait: portrait };
    }
    var hudState = { mode: 0, state: 0, spectating: false, connected: false, ownCount: 0, fadeout: true,
      highestMass: 0, camX: 0, camY: 0, target: null };

    // ---- the frame --------------------------------------------------------------------------
    function gameFrame() {
      var ns = clockNs(perfNow());
      if (capMs > 0 && Math.trunc((ns - lastFrameNs) / 1e6) < capMs) return false;
      lastFrameNs = ns;
      // H is the height every derived size uses (the canvas, or the ghost layout above the
      // strip); CH is the whole canvas, which the clear, the grid and the dim layer cover.
      var W = canvas.width, CH = canvas.height, H = layoutHeight(CH);
      // A collapsed canvas (0 wide or 0 high, e.g. a 0-size frame) draws and sends nothing: the
      // draw scale would become 0 and every target would land on the border corner. CHOSEN; the
      // reference goldens never have a 0-size canvas.
      if (W === 0 || H === 0) return false;
      below = CH - H;
      cam.setCanvasSize(W, H);
      hud.frameStart(W, H, CH);
      renderer.clearFrame(ctx, W, CH, settings);
      if (!cam.ready) return false;
      var now = perfNow();
      world.setNow(now);
      var L = world.lists();
      renderer.sortMain(L.live);
      cam.frameGate(now, sendTarget);
      renderer.beginFrame();
      renderer.updateMembranes(L, view(), settings, now);
      cam.clampWheel();
      cam.stepZoom(L.own);
      for (var i = 0; i < L.own.length; i++) agWorld.interpolate(L.own[i], now);
      cam.stepCamera(L.own);
      renderer.renderWorld(ctx, L, view(), settings, now);

      var ws = world.state();
      hudState.mode = ws.mode;
      hudState.state = gameState;
      hudState.spectating = ws.spectating;
      hudState.connected = connected;
      hudState.ownCount = L.own.length;
      hudState.fadeout = fadeout;
      hudState.highestMass = stats.highestMass;
      hudState.camX = cam.x;
      hudState.camY = cam.y;
      hud.render(ctx, hudState);
      var sizes = new Array(L.own.length);
      for (var k = 0; k < L.own.length; k++) sizes[k] = L.own[k].toSize;
      stats.frame({ spectating: ws.spectating, ownSizes: sizes, dt: lastDrawNow === null ? 0 : now - lastDrawNow });
      lastDrawNow = now;

      renderer.endFrame();
      world.cleanupIfPending(now);
      world.armCleanup();
      return true;
    }

    function onAnimationFrame() {
      if (destroyed) return;
      win.requestAnimationFrame(onAnimationFrame);
      syncPad();
      input.frame(edgePoint);
      gameFrame();
    }

    // The idle step (client-render 1.1). The chain stops if a deadline ever reports negative
    // time, as the reference's does.
    var requestIdle = typeof win.requestIdleCallback === 'function' && cfg.idlePass !== false
      ? function (fn) { win.requestIdleCallback(fn); } : null;
    function onIdle(deadline) {
      if (destroyed) return;
      if (deadline.timeRemaining() < 0) return;
      if (deadline.timeRemaining() >= IDLE_MIN_MS) {
        renderer.idle(world.lists(), view(), settings, world.state().now);
        world.cleanupIfPending();
      }
      requestIdle(onIdle);
    }

    function everySecond() {
      if (destroyed) return;
      world.cleanupIfPending();
      world.armCleanup();
      hud.everySecond();
      win.setTimeout(everySecond, SECOND_MS);
    }

    // ---- network (shipped page) -------------------------------------------------------------
    // The whole-client reset on every connect and disconnect (client-camera-input 2): the world,
    // the camera (its last sent target stays), this life's numbers, the HUD's alive flag, low-FPS
    // counters, board and panels, and the cached names of the nodes that are now gone.
    function resetConnection() {
      connected = false;
      sentBelow = 0;            // a new socket starts at 0 on the server
      sentPortrait = false;     // and sideways
      pending.play = false;
      pending.spectate = false;
      lastRows = null;
      world.reset();
      renderer.clearNames();
      cam.reset();
      stats.reset();
      hud.reset();
    }
    // The socket opens once the Ubuntu face is loaded (so names measured from the first world
    // message use the real face) or after FONT_WAIT_MS, whichever comes first, and only once.
    // Play and Spectate pressed before then wait in `pending` until the world is ready: the reset
    // on connect keeps them (CHOSEN, PARITY-LOG), the reset on disconnect still drops them.
    if (cfg.net !== false && A.agNet && typeof win.io === 'function') {
      var connectNow = function () {
        if (net || destroyed) return;
        net = A.agNet.connect(win.io, applyMessage, {
          url: cfg.url,
          onConnect: function () {
            var queued = { play: pending.play, spectate: pending.spectate };
            resetConnection();
            pending.play = queued.play;
            pending.spectate = queued.spectate;
          },
          onDisconnect: function () {
            resetConnection();
            input.setInGame(false);
            sound.setInGame(false);
            openMenu();
          }
        });
      };
      var fontLoad = null;
      try { fontLoad = doc.fonts && typeof doc.fonts.load === 'function' ? doc.fonts.load(FONT_PROBE) : null; } catch (e) { fontLoad = null; }
      if (fontLoad && typeof fontLoad.then === 'function') {
        fontLoad.then(connectNow, connectNow);
        win.setTimeout(connectNow, FONT_WAIT_MS);
      } else {
        connectNow();
      }
    }

    // ---- session ----------------------------------------------------------------------------
    session.feed = applyMessage;
    session.play = play;
    session.spectate = spectate;
    session.menu = openMenu;
    session.debugLists = function () { return world.debugLists(); };
    session.state = function () {
      var ws = world.state();
      return {
        now: ws.now, ready: ws.ready, alive: ws.alive, spectating: ws.spectating, mode: ws.mode,
        border: ws.border, nick: nick, connected: connected, gameState: gameState, menuState: menuState,
        fadeout: fadeout, capMs: capMs, ownCount: ownCells().length, highestMass: stats.highestMass,
        camera: { x: cam.x, y: cam.y, scale: cam.scale, zoom: cam.zoom }, net: net ? net.stats : null,
        portrait: portrait, rotatePrompt: rotatePrompt ? rotatePrompt.shown() : false
      };
    };
    session.on = function (name, fn) { return world.on(name, fn); };
    session.onSend = null;
    session.config = cfg;
    // Settings (build brief scope 3): quality goes through applyQuality (level, animations
    // switch, canvas scale and size together); every other key is copied. The settings block on
    // the menu card calls this too, and is kept in step with it.
    function setSettings(s) {
      if (!s || typeof s !== 'object') return;
      for (var k in s) {
        if (!Object.prototype.hasOwnProperty.call(s, k)) continue;
        if (k === 'quality') applyQuality(s.quality);
        else settings[k] = s[k];
      }
      hud.setNames(settings.names);
      storeSettings();
      if (screens) screens.setSettings(shownSettings());
    }
    session.setSettings = setSettings;
    session.settings = function () { return shownSettings(); };
    session.destroy = function () {
      destroyed = true;
      padShown = false;
      setPadClass(false);
      input.dispose();
      if (net) net.close();
      win.removeEventListener('resize', sizeCanvas);
      watchPointer(false);
      if (rotatePrompt) rotatePrompt.dispose();
    };
    session.modules = { world: world, camera: cam, renderer: renderer, hud: hud, stats: stats, screens: screens, sound: sound, input: input };

    win.requestAnimationFrame(onAnimationFrame);
    if (requestIdle) requestIdle(onIdle);
    win.setTimeout(everySecond, SECOND_MS);
    win.duelAgar = session;
    return session;
  }

  A.agMain = { boot: boot, clockNs: clockNs, capFor: capFor, CAP_START_MS: CAP_START_MS };
  if (typeof module !== 'undefined' && module.exports) module.exports = A.agMain;

  // The shipped page boots itself once the document is parsed, keeping the drawing settings
  // between visits. A page that wants its own timing (the parity harness) sets
  // window.DUEL_AGAR_MANUAL_BOOT before loading this file and boots with its own config.
  if (root.document && !root.DUEL_AGAR_MANUAL_BOOT && typeof module === 'undefined') {
    var start = function () {
      var c = { persistSettings: true }, given = root.DUEL_AGAR_CONFIG || {};
      for (var k in given) if (Object.prototype.hasOwnProperty.call(given, k)) c[k] = given[k];
      boot(c);
    };
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', start);
    else start();
  }
})(typeof window !== 'undefined' ? window : globalThis);
