// Session and frame loop for the agar.io redo client. It owns nothing of the game rules: the
// server simulates, this page decodes (agNet + agWire), keeps the client world (agWorld),
// eases the camera (agCamera), draws the world (agRender) and the canvas HUD (agHud), shows the
// menu, the end card and the leaderboard (agScreens, onto the shared DSEnd card and board), plays our own sounds
// (agSound) and reads input (agInput). This file only wires them together in the reference client's frame order.
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
// debugLists(), state(), onSend, config, on(event, fn), menu(), destroy() }, plus ours: onServer(name, fn)
// and sideEvent(name, payload) for the server side events (hold-Q cash-out and paid rooms).
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
  // The drawing flags. Their values are HARD-WIRED to the reference defaults below (names on, colours on, show mass
  // off, dark off, quality Retina): Owen 2026-10-15 removed every agar.io setting ("just get rid of all the settings,
  // I don't need any of them"), so nothing on any page changes them and nothing is stored or read back. Only the
  // parity harness page still passes its own (cfg.settings, and session.setSettings for its quality checks).
  var SETTING_FLAGS = ['names', 'colors', 'showMass', 'dark'];
  // The paid card's Spectate (watchPaidRung): the lobby's own watch of a paid agar.io rung (public/js/v2/play.js
  // spectate): its money keys and the snake watch mark taken out (MONEY_KEYS and WATCH_KEY there), then this page.
  var WATCH_PAGE = '/ag';
  var WATCH_CLEAR_KEYS = ['entryToken', 'entrySol', 'stake', 'slPaidLaunch', 'slxPaidCut', 'slBr', 'spectateOnly', 'dsWatch'];
  // Hold-Q cash-out (ours, Owen 2026-10-08, every room). While Q or the phone Cash out button is held and the
  // player is alive, the page sends ag:hold {on: 1} at once and again every HOLD_REPEAT_MS (the server drops a hold
  // whose last message is older than 500 ms), and {on: 0} when it is let go. Movement locks here at once too: no
  // target is sent and Split / Eject do nothing while held (the server refuses them as well). The ring fills from
  // the server's own report (ag:holding), so it closes on the tick the server cashes out.
  var HOLD_REPEAT_MS = 200;     // design 3.5 / 6: the page repeats ag:hold {on: 1} every 200 ms
  var HOLD_TICK_MS = 40.014;    // the server tick the hold counts (server law L1); ag:joined's tickMs replaces it
  var HOLD_TICKS = 75;          // held ticks to cash out (server AG_MONEY.HOLD_TICKS, Owen's 3 s); ag:holding's need replaces it

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
    // told (ag:portrait) so it sends the turned view box of the same area. There is no "turn your
    // phone sideways" card (Owen 2026-10-15: the game plays the way the phone is held). Sideways
    // it is the exact reference layout. Off at parity: the harness page never sets cfg.portrait.
    var portraitAllowed = cfg.portrait === true;
    var portrait = false;                     // the portrait layout is in use
    // Inside the DuelSeries lobby's agar frame (ours, Owen 2026-10-09 midday; the shipped page only: cfg.lobby, which
    // public/ag.html sets when its frame element is the lobby's #agar-frame). The lobby's agar.io screen holds the
    // name, the buy-in and Spectate, so this page has no menu card: agLobby starts play (or spectate) at
    // once, Esc does nothing in the free room, the end card offers Lobby, Spectate and Play again, a dropped
    // socket rejoins as it was.
    // A paid hand-off keeps its own flow and card exactly. Off at parity and on a direct visit to /ag.
    var lobbyMode = cfg.lobby === true;
    var quality = qualityName(cfg.quality || 'Retina');
    var settings = {
      names: true, showMass: false, colors: true, dark: false, acid: false,
      quality: QUALITY_LEVEL[quality], showAnimations: true, fontReady: fontsReady
    };
    // The parity harness page's own values; the shipped page has none (see SETTING_FLAGS).
    if (cfg.settings) {
      for (var sk in cfg.settings) {
        if (!Object.prototype.hasOwnProperty.call(cfg.settings, sk)) continue;
        if (sk === 'quality') quality = qualityName(cfg.settings.quality);
        else settings[sk] = cfg.settings[sk];
      }
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
    var watchAsk = 0;             // the paid rung the lobby's Spectate watches (auth.watchStake), 0 otherwise
    var watchRetry = null;        // its next ask while nobody is at that rung (watchEmpty)
    var WATCH_RETRY_MS = 3000;
    var canvasScale = 1;
    var net = null;
    // Hold-Q cash-out (see HOLD_REPEAT_MS). wanted: held here and sent; server: the server reports the hold running
    // since `at` (page clock) for `need` ticks; gen: the repeat timer's generation (a new hold or a release stops
    // the old timer).
    var hold = { wanted: false, server: false, at: 0, need: HOLD_TICKS, gen: 0 };
    var holdTickMs = HOLD_TICK_MS;
    var cashedOutFree = false;  // ag:cashedout {free: true} came; the death that follows shows "Cashed out"
    var lastEater = '';         // the name of the player cell that last ate an own cell this life (the free verdict)
    var lastLife = null;        // the last death's snapshot, for a paid end card that comes after the death
    // Paid room (ag:joined with a stake, ag:money, or the hand-off's cfg.paid): money on the HUD, the board and the
    // cells, and the paid states on the end card. Never set in the free room.
    var paid = { on: cfg.paid === true, stake: 0, network: typeof cfg.network === 'string' ? cfg.network : '' };
    // The paid hand-off (agPaid.js; the shipped page only: cfg.handoff, and only when the lobby's wallet left a paid
    // hand-off in sessionStorage). Null on the free page and on the parity harness, which never load agPaid: every
    // use below is behind it, so the free page draws and sends exactly what it did.
    var flow = null;
    var handoff = null;
    if (cfg.handoff === true && A.agPaid) {
      var paidStore = null, localStore = null;
      try { paidStore = cfg.tabStorage !== undefined ? cfg.tabStorage : (win.sessionStorage || null); } catch (e) { paidStore = null; }
      try { localStore = win.localStorage || null; } catch (e) { localStore = null; }
      handoff = A.agPaid.readHandoff(paidStore, localStore);
      if (!handoff.paid) handoff = null;
      else handoff.store = paidStore;
    }

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
    // The menu card (name entry) on a direct visit and at parity; the lobby frame's page has none (see lobbyMode).
    var screens = null;
    if (cfg.screens !== false && !lobbyMode) {
      screens = agScreens.createScreens({
        doc: doc,
        root: cfg.screensRoot || doc.body,
        onPlay: function (name) { play(name); },
        onSpectate: function () { spectate(); },
        injectCss: cfg.injectCss
      });
      screens.showHome();
    }
    // The shared end card and leaderboard (public/js/shared/dsEnd.js, loaded by ag.html before this file). A page
    // without it (the parity harness) shows neither.
    var DSE = cfg.dsEnd || win.DSEnd || null;
    var END_Z = 1000;          // over the menu (20), the Lobby chip (30), the paid hint (40)
    var BOARD_Z = 35;          // over the menu and the Lobby chip, under the paid hint chip (a 3 s notice)
    var end = agScreens.createEnd({ DSEnd: DSE, root: cfg.screensRoot || doc.body, z: END_Z, win: win,
      onLobby: function () { backToLobby(); }, onSpectate: function () { watchPaidRung(); } });
    var board = agScreens.createBoard({ DSEnd: DSE, root: cfg.screensRoot || doc.body, z: BOARD_Z, short: shortScreen });
    // A phone held sideways: the board keeps to 5 rows so it stays clear of the phone pad in the bottom-right corner.
    function shortScreen() { return (win.innerHeight || 0) > 0 && win.innerHeight < 560; }

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
      placeChat();
    }
    // ---- phone portrait (see portraitAllowed above) -----------------------------------------
    function portraitNow() {
      return portraitAllowed && coarsePointer() && win.innerHeight > win.innerWidth;
    }
    // Layout on or off: camera and HUD scale, and the root class ag-portrait (ag.css lays the phone
    // pad out for it). The draw scale follows on the next frame, as after any resize.
    function setPortrait(on) {
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
    // A phone stick adds its speed (thousandths of full speed, the thumb's distance, Owen 2026-10-16); a mouse sends
    // none (full speed). sentSpeed is what the server last got, so a speed change alone is sent too (frame loop).
    var sentSpeed = null;
    function sendTarget(x, y) {
      var sp = input ? input.stickSpeed() : null;
      sentSpeed = sp;
      send('target', sp === null ? { x: x, y: y } : { x: x, y: y, speed: sp });
    }

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
        if (hold.wanted) return;      // locked while holding (Owen 2026-10-08)
        if (flow && !flow.canSteer()) return;   // a paid seat acts only after ag:ready (design 4 step 5)
        cam.sendTarget(sendTarget);   // flush the current target first
        send('split');
        var cue = agSound.splitCue(displayedSizes());
        if (cue) sound.playCue(cue);
      },
      eject: function () {
        if (hold.wanted) return;
        if (flow && !flow.canSteer()) return;
        cam.sendTarget(sendTarget);
        send('eject');
        var cue = agSound.ejectCue(displayedSizes());
        if (cue) sound.playCue(cue);
      },
      q: function () { send('q'); },
      hold: function (on) { setHold(on); },
      // Esc: the menu, except on a paid hand-off page, which never shows it (design 6); while the seat plays Esc shows
      // how to leave instead (design 4 step 7)
      menu: function () {
        if (flow && flow.holdsMenu()) { flow.escape(); return; }
        if (lobbyMode) return;        // the lobby frame's free room has no menu to open (Owen 2026-10-09 midday)
        openMenu();
      }
    }, {
      win: win,
      doc: doc,
      canvasScale: function () { return canvasScale; },
      engineNow: cfg.engineNow,       // tests only; the page uses the input layer's default clock
      splitButton: cfg.splitButton || doc.getElementById('ag-split'),
      ejectButton: cfg.ejectButton || doc.getElementById('ag-eject'),
      cashButton: cfg.cashButton || doc.getElementById('ag-cash'),
      canAct: padLive,
      canHold: padLive,
      touchFirst: cfg.touchFirst
    });
    function edgePoint(ux, uy) { return cam.stickPoint(ownCells(), ux, uy); }

    // Phone Split / Eject pad (ours, FIX-PLAN P1): shown and acting only while playing with own
    // cells, never on the menu (Esc included), while spectating or on the end card. The root
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
      if (!live && hold.wanted) {
        input.releaseHold();          // a player who cannot hold any more (menu, death) lets go of Q and the button
        setHold(false);
      }
      if (live === padShown) return;
      padShown = live;
      setPadClass(live);
    }

    // ---- hold-Q cash-out (see HOLD_REPEAT_MS) ---------------------------------------------------
    // agInput reports the hold going on and off (Q and the Cash out button together). A hold starts only while the
    // player is alive in play; it lasts until let go, until the player cannot hold any more (syncPad) or until the
    // run ends (endHold).
    function setHold(on) {
      if (on) {
        if (hold.wanted || !padLive()) return;
        if (flow && !flow.canSteer()) return;   // the server refuses a hold before ag:ready too
        hold.wanted = true;
        hold.server = false;
        var gen = ++hold.gen;
        send('hold', { on: true });
        var repeat = function () {
          if (destroyed || !hold.wanted || hold.gen !== gen) return;
          if (!padLive()) { setHold(false); return; }
          send('hold', { on: true });
          win.setTimeout(repeat, HOLD_REPEAT_MS);
        };
        win.setTimeout(repeat, HOLD_REPEAT_MS);
        return;
      }
      if (!hold.wanted) return;
      hold.wanted = false;
      hold.server = false;
      hold.gen++;
      send('hold', { on: false });
    }
    // The run ended (a cash-out or a paid end): the server already ended the hold, so nothing is sent; the keys and
    // the button are let go so a still-held Q starts nothing.
    function endHold() {
      hold.wanted = false;
      hold.server = false;
      hold.gen++;
      input.releaseHold();
    }
    // 0..1 of the hold: the server counts its first held tick when it reports the hold (ag:holding), then one per
    // tick, and cashes out at `need`.
    function holdProgress(now) {
      if (!hold.wanted || !hold.server) return 0;
      var p = (1 + (now - hold.at) / holdTickMs) / hold.need;
      return p < 0 ? 0 : (p > 1 ? 1 : p);
    }

    // ---- server side events (agNet SIDE_EVENTS) ---------------------------------------------
    var sideHandlers = {};
    function wholePositive(v) {
      return typeof v === 'number' && isFinite(v) && v >= 1 && Math.floor(v) === v ? v : 0;
    }
    function onSideEvent(name, payload) {
      if (destroyed) return;
      var p = payload && typeof payload === 'object' ? payload : {};
      switch (name) {
        case 'ag:holding':
          if (p.on === 1 || p.on === true) {
            hold.server = hold.wanted;
            hold.at = perfNow();
            hold.need = wholePositive(p.need) || HOLD_TICKS;
          } else {
            hold.server = false;
          }
          break;
        case 'ag:cashedout':
          endHold();
          if (p.free === true) {
            cashedOutFree = true;
          } else {
            end.showCashed(p, lifeNow());
            var net = Number(p.netMicro);
            if (!isFinite(net)) net = (Number(p.grossMicro) || 0) - (Number(p.cutMicro) || 0);
            // a resumed receipt (agPaidDoor answerOutcome) repeats a cash-out already counted: never twice
            if (p.resumed !== true && typeof win.phEvent === 'function') {
              try { win.phEvent('cashed_out', { game: 'agar', amount: net / 1e6, stake: paid.stake }); } catch (e) { /* analytics never breaks the game */ }
            }
          }
          break;
        case 'ag:joined':
          if (Number(p.stake) > 0) {
            paid.on = true;
            paid.stake = Number(p.stake);
            lastLife = null;
            // A new paid seat (Play again) clears the last run's end card: its Lobby button must never sit on top
            // of a run with money in it (lobby-rungs review fix; agLobby's exit trap gates that button too).
            end.hide();
          }
          if (typeof p.tickMs === 'number' && p.tickMs > 0 && isFinite(p.tickMs)) holdTickMs = p.tickMs;
          if (wholePositive(p.holdTicks)) hold.need = p.holdTicks;
          break;
        case 'ag:skins':
          // { cells: [id, skin, ...] }: the cells this page knows that wear a bought skin (1-based in
          // shared/shopSkins.js SKINS.agar). Display only.
          renderer.setSkins(p && p.cells);
          break;
        case 'ag:chat':
          // { name, c, text, me }: one line for the shared chat (me: 1 only on the sender's own copy).
          if (chat) chat.add({ name: p.name, color: p.c, text: p.text, me: p.me === 1 });
          break;
        case 'ag:chatnote':
          if (chat) chat.add({ kind: 'sys', text: p.text });
          break;
        case 'ag:money':
          if (!paid.on) { paid.on = true; placeChat(); }   // the balance panel joins the stack the chat sits above
          applyMoney(p);
          break;
        case 'ag:dead':
          endHold();
          end.showDead(p, lifeNow());
          break;
        case 'ag:closed':
          endHold();
          end.showClosed(p);
          break;
        case 'ag:paid':
          if (end.paidKind()) end.paid(p.sig, paid.network);
          break;
        case 'ag:payerror':
          if (end.paidKind()) end.payError(p.message);
          break;
        case 'ag:refused':
          // The lobby's Spectate on a paid rung nobody is at (agArenas.connectWatch): the empty map, then ask again.
          if (!flow && watchAsk > 0 && p.why === 'nobody') watchEmpty();
          break;
        default:
          break;
      }
      // The paid hand-off hears every server event after the page's own handling (agPaid: the seat, the resume key,
      // ag:ready, refusals and end states). The socket drop goes to it from onDisconnect instead.
      if (flow && name !== 'disconnect') {
        try { flow.onEvent(name, p); } catch (e) { if (win.console) win.console.error('[AG] paid hand-off', e); }
      }
      var list = sideHandlers[name];
      if (list) {
        for (var i = 0; i < list.length; i++) {
          try { list[i](p); } catch (e) { /* a hook never breaks the game */ }
        }
      }
    }
    // ag:money { me, rank, cells: [id, micro, ...], board: [[name, micro], ...] }: display only.
    function applyMoney(p) {
      var shares = new Map();
      var c = Array.isArray(p.cells) ? p.cells : [];
      for (var i = 0; i + 1 < c.length; i += 2) {
        var v = c[i + 1];
        if (typeof c[i] === 'number' && typeof v === 'number' && isFinite(v) && v >= 0) shares.set(c[i], v);
      }
      renderer.setMoney(shares);
      hud.setMoney(p);
      board.setMoney(p, nick);
    }
    // This life's numbers for a paid card that shows before the world's death, else the last death's snapshot (none
    // after a reload: a resumed receipt shows no facts).
    function lifeNow() { return stats.alive ? stats.now(perfNow()) : lastLife; }
    // A paid seat opened (agPaid, on ag:joined): the play state the free Play button gives, without the menu and with
    // no free ag:join (the door already seated the cell). The lobby name is the cell's name, as the server has it.
    function enterPaidPlay() {
      nick = flow.name();
      world.setNick(nick);
      hud.onPlay();
      gameState = 0;
      fadeout = false;
      pending.play = false;
      pending.spectate = false;
      input.setInGame(true);
      input.enableKeys();
      sound.setInGame(true);
      if (screens) screens.hide();
      end.hide();
      setMenuState('PLAY');
      // The payout link's cluster, asked once (Paper's pp:joined does the same; the page has no cfg.network).
      if (!paid.network && !paid.networkAsked && typeof win.fetch === 'function') {
        paid.networkAsked = true;
        try {
          win.fetch('/api/money-config').then(function (r) { return r.json(); }).then(function (c) {
            if (c && typeof c.network === 'string' && c.network) paid.network = c.network;
          }).catch(function () { /* mainnet links stay */ });
        } catch (e) { /* mainnet links stay */ }
      }
    }
    // The page's own events for the onServer hooks (agLobby): never the server's names, never fed to the flow.
    function pageEvent(name, payload) {
      var list = sideHandlers[name];
      if (!list) return;
      for (var i = 0; i < list.length; i++) {
        try { list[i](payload); } catch (e) { /* a hook never breaks the game */ }
      }
    }
    // The card's button: the lobby's own way back (the 'game:done' message agLobby's Lobby button sends), or the
    // hand-off's own handler; a page opened on its own just closes the card.
    function backToLobby() {
      if (typeof cfg.onLobby === 'function') { cfg.onLobby(); return; }
      var framed = false;
      try { framed = !!win.parent && win.parent !== win; } catch (e) { framed = true; }
      if (framed) {
        try { win.parent.postMessage('game:done', '*'); } catch (e) { /* the lobby is gone */ }
        return;
      }
      // A paid hand-off opened on its own goes to the lobby page, as Paper's does (paperArenaMain.js onLobbyClick):
      // never the free menu (design 6).
      if (flow) {
        try { win.location.href = '/'; } catch (e) { /* nowhere to go */ }
        return;
      }
      end.hide();
      openMenu();
    }
    // The paid card's Spectate (a paid death or cash-out). The server never lets a paid socket watch (agArenas
    // spectate: "a paid seat never spectates"), so there is no switch inside this page: it does what the lobby's
    // Spectate does on this rung (public/js/v2/play.js spectate): every money key out, the lobby's watch flag and the
    // rung under its own key (never 'stake', never a token), and /ag again in this frame, which boots as the rung's
    // read-only watcher (auth.watchStake below; agLobby, or watchFromBoot on a page of its own, starts the watch).
    // Never while the way out is shut (the paid flow's lock; the card shuts Spectate with its Lobby then too).
    function watchPaidRung() {
      if (paidLocked) return false;
      if (flow) {
        // only from a seat that ended, with no join out and no hand-off token unspent (pagehide would put it back)
        var fst = flow.state();
        if (fst.phase !== 'end' || fst.unspent || fst.pendingToken || fst.pendingKey || fst.restaking) return false;
      }
      var stake = flow ? Number(flow.stake()) : Number(paid.stake);
      if (!isFinite(stake) || !(stake > 0)) return false;
      var store = null;
      try { store = handoff ? handoff.store : (win.sessionStorage || null); } catch (e) { store = null; }
      if (!store) return false;
      try {
        for (var i = 0; i < WATCH_CLEAR_KEYS.length; i++) store.removeItem(WATCH_CLEAR_KEYS[i]);
        store.setItem('dsWatchStake', String(stake));
        store.setItem('spectateOnly', 'true');
      } catch (e) { return false; }
      var loc = win.location;
      if (!loc) return false;
      // replace: the browser's Back never brings the ended paid page back from its cache
      try {
        if (typeof loc.replace === 'function') loc.replace(WATCH_PAGE);
        else loc.href = WATCH_PAGE;
      } catch (e) { return false; }
      return true;
    }

    // ---- chat (ours, Owen 2026-10-16: public/js/shared/dsChat.js, T to type; the server's ag:chat and ag:chatnote) ----
    // The box shows while a game or a spectate view does, never on a menu or the end card, and only a live cell may send.
    // The map is white, so the lines get a backing (light). Bottom left it sits just above the Score panel (and the paid
    // balance panel stacked on it), which live in the ghost layout and scale with the HUD (placeChat); on a phone it is
    // top left under the ping text.
    var chat = null;
    if (win.DSChat) {
      chat = win.DSChat.mount({
        send: function (t) { return net ? net.send('chat', { text: t }) : false; },
        canSend: function () { return menuState === 'PLAY' && connected && world.state().alive; },
        light: true,
        pc: { left: 15, bottom: 150 },
        phoneAt: { left: 10, top: 30 }
      });
      placeChat();
    }
    function placeChat() {
      if (!chat || !(canvas.width > 0)) return;
      var lh = layoutHeight(canvas.height);
      var q = agHud.hudScale(canvas.width, lh, portrait) / canvasScale;   // HUD units to CSS px
      var stack = 49 + (paid.on ? 42 : 0);                               // score panel (15 + 34), balance panel (8 + 34)
      chat.el.style.setProperty('--dsc-b', Math.round((canvas.height - lh) / canvasScale + q * stack + 10) + 'px');
    }
    function syncChat() {
      if (!chat) return;
      placeChat();
      chat.visible(menuState === 'PLAY' || menuState === 'SPECTATE');
    }

    // ---- game state and the FPS cap ---------------------------------------------------------
    // The reference menu applies a state change in a 0 ms timer and its watcher then sets the
    // cap in a microtask; the frame that runs the timer is still drawn under the old cap.
    function setMenuState(s) {
      menuState = s;
      syncPad();
      syncChat();
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
      hud.onPlay();
      if (world.state().ready) sendPlay(); else pending.play = true;
      fadeout = false;
      input.setInGame(true);
      input.enableKeys();
      sound.setInGame(true);
      if (screens) screens.hide();
      hideFreeEnd();
      setMenuState('PLAY');
    }
    function spectate() {
      if (world.state().ready) sendSpectate(); else pending.spectate = true;
      fadeout = false;
      input.setInGame(true);
      input.enableKeys();
      sound.setInGame(true);
      if (screens) screens.hide();
      hideFreeEnd();
      setMenuState('SPECTATE');
    }
    // The free end card goes with whatever replaces it (Play again, Spectate, the menu); a paid card stays until the
    // paid flow moves on.
    function hideFreeEnd() { if (end.kind === 'free') end.hide(); }
    // The free end card (a death or a free cash-out): the best mass of the life, its time and best rank, with the
    // three buttons every game's end card has (Owen 2026-10-16), in their order: Lobby goes back (the lobby frame), or
    // Menu in its place opens the name entry (a direct visit has no lobby: the old Continue); Spectate watches the room;
    // Play again respawns under the same name at once.
    function showFreeEnd(snap, cashed, by) {
      var buttons = [];
      if (lobbyMode) {
        buttons.push({ id: 'lobby', text: agScreens.END_TEXT.lobby, onClick: function () { backToLobby(); } });
      } else if (screens) {
        buttons.push({ id: 'menu', text: agScreens.END_TEXT.menu, onClick: function () {
          end.hide();
          screens.showHome();
          setMenuState('HOME');
        } });
      }
      buttons.push(
        { id: 'watch', text: agScreens.END_TEXT.spectate, onClick: function () { if (menuState === 'GAMEOVER') spectate(); } },
        { id: 'again', text: agScreens.END_TEXT.again, primary: true, onClick: function () { if (menuState === 'GAMEOVER') play(nick); } }
      );
      end.showFree({ life: snap, cashed: cashed, by: by, buttons: buttons });
    }
    // The lobby's Spectate on a paid rung with nobody at it (Owen 2026-10-16: "it'll just default to spectating the
    // whole map in the middle"): the server refuses the watch ('nobody') and closes the socket, which socket.io never
    // reopens by itself. The whole map shows zoomed out and centred (public/js/shared/dsEmptyArena.js) and the same
    // socket asks again every WATCH_RETRY_MS while the page is visible; the first answer that seats the watcher brings
    // the world ('ready') and the view follows the top player as before. Read only: the handshake is unchanged.
    function watchEmpty() {
      if (destroyed) return;
      var E = win.DSEmptyArena;
      if (E) E.show({ game: 'agar', stake: watchAsk, onLobby: function () { watchQuiet(); backToLobby(); } });
      if (watchRetry !== null) return;
      watchRetry = win.setTimeout(function again() {
        watchRetry = null;
        if (destroyed || !net) return;
        if (doc.hidden) { watchRetry = win.setTimeout(again, WATCH_RETRY_MS); return; }
        if (!net.connected()) net.reconnect();
      }, WATCH_RETRY_MS);
    }
    function watchQuiet() {
      if (watchRetry !== null) { win.clearTimeout(watchRetry); watchRetry = null; }
      var E = win.DSEmptyArena;
      if (E) E.hide();
    }
    // The lobby frame's free page after a dropped socket (see lobbyMode): there is no menu to fall back to, so a player
    // who was playing joins again under the same name and a watcher watches again, both once the new socket's world
    // is ready (pending survives the reset on connect). The end card stays up as it was.
    function rejoinAfterDrop() {
      if (menuState === 'PLAY') play(nick);
      else if (menuState === 'SPECTATE') spectate();
    }
    // Esc: the menu opens over the running game, which is not paused.
    function openMenu() {
      fadeout = true;
      hideFreeEnd();
      if (screens) screens.showHome();
      setMenuState('HOME');
    }

    // ---- world events -----------------------------------------------------------------------
    world.on('create', function (node) { renderer.initNode(node, cam.targetScale(), cam.scale); });
    world.on('ready', function () {
      if (watchAsk > 0) watchQuiet();
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
      if (flow) flow.onSpawn();
      cam.onSpawn(p.camY);
      if (gameState === 9) gameState = 3;   // a match-state rule of other modes; inert in FFA
      stats.spawn(p.now);
      lastEater = '';
      lastLife = null;
      hud.onSpawn();
      syncPad();
    });
    world.on('eat', function (p) {
      var e = {
        eaterOwn: p.eaterOwn, eatenOwn: p.eatenOwn, ownCount: ownCells().length,
        food: p.eaten.food, ejected: p.eaten.ejected, flag40: p.eaten.flag40, virus: p.eaten.virus
      };
      stats.eat(e);
      // Another player's cell ate one of ours: the free card names the last one (a virus or pellet never eats a cell).
      var by = p.eater;
      if (p.eatenOwn && !p.eaterOwn && by && !by.virus && !by.food && !by.ejected) {
        lastEater = typeof by.name === 'string' ? by.name : '';
      }
      if (sound.playCues) sound.playCues(agSound.eatCues(e));
    });
    world.on('board', function (p) {
      lastRows = p.rows;
      if (!paid.on) board.setFree(p.rows, nick);   // a paid room's board is ag:money's
      stats.applyBoard(p.rows);
    });
    // Death (client-hud 6.2, 6.3): this life's numbers are taken and reset; the end card shows them. A death while the
    // Esc menu is open keeps the menu as it is (the game-over state becomes HOME when the state was HOME), so no card
    // replaces the name entry; the FPS cap is the menu's either way.
    // Ours: after a free-room cash-out (Owen 2026-10-08) the card says "Cashed out"; in a paid room the paid states
    // (ag:cashedout, ag:dead, ag:closed) are on the card instead, and this death only gives them the life's final
    // numbers (design 6).
    world.on('death', function (p) {
      hud.onDeath();
      var snap = stats.death(p.now, lastRows);
      lastLife = snap;
      input.setInGame(false);
      sound.setInGame(false);
      syncPad();
      var cashed = cashedOutFree;
      cashedOutFree = false;
      var by = lastEater;
      lastEater = '';
      if (menuState === 'HOME') return;
      if (paid.on) {
        if (screens) screens.hide();
        end.setLife(snap);
        setMenuState('GAMEOVER');
        return;
      }
      showFreeEnd(snap, cashed, by);
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
      // no target while holding (movement locked), nor from a paid seat before its ag:ready
      if (!hold.wanted && (!flow || flow.canSteer())) {
        // the speed alone changed (a lifted thumb stops the cells on the same target): send it on the last target
        if (!cam.frameGate(now, sendTarget) && input.stickSpeed() !== sentSpeed) sendTarget(cam.lastSentX, cam.lastSentY);
      }
      renderer.beginFrame();
      renderer.updateMembranes(L, view(), settings, now);
      cam.clampWheel();
      cam.stepZoom(L.own);
      for (var i = 0; i < L.own.length; i++) agWorld.interpolate(L.own[i], now);
      cam.stepCamera(L.own);
      renderer.renderWorld(ctx, L, view(), settings, now);
      // Ours: the hold ring, only while a hold runs (never in the harness streams, which never hold Q).
      if (hold.wanted && hold.server && L.own.length) {
        // drawn as every game's ring (DSEnd.ring, Owen's gold "Three Count"); no glow on a touch screen. Round every
        // own cell, so a player split into pieces sees each one cashing out (Owen 2026-10-16).
        var ringDraw = DSE && typeof DSE.ring === 'function' ? { draw: DSE.ring, now: now, mobile: coarsePointer() } : null;
        var ringP = holdProgress(now);
        var ringView = view();
        for (var ri = 0; ri < L.own.length; ri++) renderer.drawHoldRing(ctx, ringView, L.own[ri], ringP, settings, ringDraw);
      }
      // A paid seat's own cell is on screen: ag:ready (agPaid, design 4 step 5: the cell is shielded until now).
      if (flow) flow.onFrame(L.own.length);

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
      syncBoard();
      input.frame(edgePoint);
      gameFrame();
    }
    // The leaderboard shows while playing or watching with no end card up (the old canvas board sat under the death
    // panel's dim; the shared card has its own scrim, so the board steps aside). DOM only: no canvas call changes.
    function syncBoard() {
      board.sync((menuState === 'PLAY' || menuState === 'SPECTATE') && !end.shown());
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
      sentSpeed = null;         // and at full speed
      sentPortrait = false;     // and sideways
      pending.play = false;
      pending.spectate = false;
      lastRows = null;
      world.reset();
      renderer.clearNames();
      cam.reset();
      stats.reset();
      hud.reset();
      // Ours: a hold never outlives its socket (the server ends it at the disconnect), and the money shown belongs
      // to the old connection. The paid end card stays up: it is the player's receipt.
      endHold();
      cashedOutFree = false;
      lastEater = '';
      lastLife = null;
      renderer.setMoney(null);
      board.clear();
    }
    // ---- the paid hand-off (agPaid; see `flow` above) ---------------------------------------
    // Its sends go straight to the socket; session.onSend (a test and harness hook) hears the kind and the rung only,
    // never the entry token or the resume key.
    var paidLocked = false;
    function paidSend(kind, payload) {
      if (typeof session.onSend === 'function') {
        var heard = kind === 'paidJoin' && payload
          ? { stake: payload.stake, entry: !!payload.entryToken, resume: !!payload.resumeKey } : payload;
        try { session.onSend(kind, heard); } catch (e) { /* a hook never breaks the game */ }
      }
      return net ? net.send(kind, payload) : false;
    }
    if (handoff) {
      paid.on = true;
      paid.stake = handoff.stake;
      if (screens) screens.hide();   // no menu (design 6); a death or a cash-out offers Spectate on the card (watchPaidRung)
      var parentWin = null;
      try { parentWin = win.parent || null; } catch (e) { parentWin = null; }
      flow = A.agPaid.createFlow({
        handoff: handoff,
        store: handoff.store,
        win: win,
        send: paidSend,
        reconnect: function () { return net ? net.reconnect() : false; },
        card: function () { return end; },
        enterPlay: enterPaidPlay,
        freshTarget: function () { cam.lastSentX = NaN; cam.lastSentY = NaN; },
        lock: function (on) { paidLocked = !!on; pageEvent('paid:lock', { on: paidLocked }); },
        touch: coarsePointer,
        chip: A.agPaid.createChip(doc, cfg.screensRoot || doc.body),
        framed: !!parentWin && parentWin !== win,
        parent: parentWin,
        origin: (win.location && win.location.origin) || '',
        phEvent: function (name, props) { if (typeof win.phEvent === 'function') win.phEvent(name, props); }
      });
      end.onAgain = function () { flow.restake(); };
      if (typeof win.addEventListener === 'function') {
        win.addEventListener('message', function (e) { flow.onMessage(e); });
        // The resume key reaches sessionStorage only when the page goes (agPaid 4).
        win.addEventListener('pagehide', function () { flow.onPageHide(); });
        win.addEventListener('pageshow', function (e) { flow.onPageShow(e); });
      }
      flow.start();
    }

    // The socket opens once the Ubuntu face is loaded (so names measured from the first world
    // message use the real face) or after FONT_WAIT_MS, whichever comes first, and only once.
    // Play and Spectate pressed before then wait in `pending` until the world is ready: the reset
    // on connect keeps them (CHOSEN, PARITY-LOG), the reset on disconnect still drops them.
    // A paid hand-off connects with auth { paid: 1 } (the server keeps it seatless, never a free watcher) and joins
    // through the paid door on every connect (agPaid).
    // A hand-off that already ended at boot (a reload cut its token join off) needs no socket.
    // The free skin picked in the lobby's Customize (shared/agSkins.js, stored under duel.ag.skin) rides the same
    // handshake as auth.skin; the server takes only a listed id and deals a colour as before for anything else.
    // Cosmetic only: no money path reads it.
    var auth = flow ? { paid: 1 } : {};
    try {
      var skinId = win.localStorage ? win.localStorage.getItem('duel.ag.skin') : null;
      if (typeof skinId === 'string' && skinId && skinId.length <= 32) auth.skin = skinId;
    } catch (e) { /* storage blocked: a dealt colour */ }
    // A bought skin (docs/skin-purchases.md): its id and the lobby's skin pass. The server wears it only when the
    // pass lists it (server/ag/agRoom.js paidSkinOf), else the free colour above. Cosmetic: no money path reads it.
    try {
      var shopId = win.localStorage ? win.localStorage.getItem('duel.shop.agar') : null;
      var skinPass = win.localStorage ? win.localStorage.getItem('duel.skinpass') : null;
      if (shopId && skinPass && /^[a-z][a-z0-9]{0,23}$/.test(shopId) && skinPass.length <= 4096) {
        auth.shop = shopId;
        auth.skinPass = skinPass;
      }
    } catch (e) { /* storage blocked: the free look */ }
    // The lobby's Spectate on a paid rung (spectateOnly plus dsWatchStake, both written by public/js/v2/play.js):
    // the rung to watch, read only on the server (agArenas.connectWatch). Never with a paid hand-off, never a buy-in.
    try {
      var ss = win.sessionStorage;
      var ws = ss && ss.getItem('spectateOnly') === 'true' ? Number(ss.getItem('dsWatchStake')) : 0;
      if (!flow && isFinite(ws) && ws > 0) auth.watchStake = watchAsk = ws;
    } catch (e) { /* storage blocked: the free room */ }
    // A page of its own (no lobby frame, so no agLobby start) reopened by the paid card's Spectate (watchPaidRung)
    // watches at once instead of waiting on its menu. The lobby frame's page is started by agLobby.
    var watchFromBoot = !!auth.watchStake && !lobbyMode && !!screens && cfg.net !== false;
    if (cfg.net !== false && A.agNet && typeof win.io === 'function' && !(flow && flow.offline())) {
      var connectNow = function () {
        if (net || destroyed) return;
        net = A.agNet.connect(win.io, applyMessage, {
          url: cfg.url,
          ioOptions: flow || auth.skin || auth.shop || auth.watchStake ? { auth: auth } : undefined,
          onEvent: onSideEvent,
          onConnect: function () {
            var queued = { play: pending.play, spectate: pending.spectate };
            resetConnection();
            pending.play = queued.play;
            pending.spectate = queued.spectate;
            if (flow) flow.onConnect();
          },
          onDisconnect: function (reason) {
            resetConnection();
            input.setInGame(false);
            sound.setInGame(false);
            // A paid page keeps its card (the reconnect wait, or the receipt) instead of the menu. The lobby frame's
            // free page has no menu: it rejoins as it was once the socket is back (see rejoinAfterDrop).
            if (!flow && lobbyMode) rejoinAfterDrop();
            else if (!flow) openMenu();
            if (flow) flow.onDisconnect();
            // Ours: the onServer hooks hear the drop too, as 'disconnect' (agLobby's exit trap: a paid seat this
            // socket held is the server's dropped seat now). No draw and no send.
            onSideEvent('disconnect', { reason: typeof reason === 'string' ? reason : '' });
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
    if (watchFromBoot) spectate();

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
        portrait: portrait,
        hold: { wanted: hold.wanted, server: hold.server, need: hold.need, progress: holdProgress(perfNow()) },
        paid: paid.on, paidEnd: end.paidKind(), handoff: flow ? flow.state() : null,
        end: { kind: end.kind, shown: end.shown() }, board: { visible: board.visible, money: board.money }
      };
    };
    // The page's exit lock from the paid hand-off (a token in flight, a Play again with the wallet): agLobby reads it
    // once when it starts and hears every change as the 'paid:lock' hook.
    session.paidLocked = function () { return paidLocked; };
    session.on = function (name, fn) { return world.on(name, fn); };
    // Server side events (agNet SIDE_EVENTS), plus 'disconnect' when the socket drops: the page's own handling runs
    // first, then these. sideEvent feeds one in as if the socket had sent it (tests, and a page without a socket).
    session.onServer = function (name, fn) {
      if (typeof fn !== 'function') return;
      (sideHandlers[name] = sideHandlers[name] || []).push(fn);
    };
    session.sideEvent = onSideEvent;
    session.onSend = null;
    session.config = cfg;
    // The parity harness's own values (build brief scope 3): quality goes through applyQuality (level, animations
    // switch, canvas scale and size together); every other key is copied. No page a player sees calls this: there
    // are no settings to change (see SETTING_FLAGS), and nothing is stored.
    function setSettings(s) {
      if (!s || typeof s !== 'object') return;
      for (var k in s) {
        if (!Object.prototype.hasOwnProperty.call(s, k)) continue;
        if (k === 'quality') applyQuality(s.quality);
        else settings[k] = s[k];
      }
      hud.setNames(settings.names);
    }
    session.setSettings = function (s) { setSettings(s); };
    session.settings = function () { return shownSettings(); };
    session.destroy = function () {
      destroyed = true;
      hold.wanted = false;
      hold.gen++;
      padShown = false;
      setPadClass(false);
      input.dispose();
      if (net) net.close();
      win.removeEventListener('resize', sizeCanvas);
      watchPointer(false);
    };
    session.modules = { world: world, camera: cam, renderer: renderer, hud: hud, stats: stats, screens: screens, sound: sound, input: input,
      end: end, board: board };

    win.requestAnimationFrame(onAnimationFrame);
    if (requestIdle) requestIdle(onIdle);
    win.setTimeout(everySecond, SECOND_MS);
    win.duelAgar = session;
    return session;
  }

  A.agMain = { boot: boot, clockNs: clockNs, capFor: capFor, CAP_START_MS: CAP_START_MS, SETTING_FLAGS: SETTING_FLAGS };
  if (typeof module !== 'undefined' && module.exports) module.exports = A.agMain;

  // The shipped page boots itself once the document is parsed. A page that wants its own timing (the parity
  // harness) sets window.DUEL_AGAR_MANUAL_BOOT before loading this file and boots with its own config.
  if (root.document && !root.DUEL_AGAR_MANUAL_BOOT && typeof module === 'undefined') {
    var start = function () {
      var c = {}, given = root.DUEL_AGAR_CONFIG || {};
      for (var k in given) if (Object.prototype.hasOwnProperty.call(given, k)) c[k] = given[k];
      boot(c);
    };
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', start);
    else start();
  }
})(typeof window !== 'undefined' ? window : globalThis);
