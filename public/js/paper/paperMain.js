// Paper clone: the game session API (window.duelPaper), the boot sequence and the tiny page shell
// (canvas, start flow, game-over hand-off, "Play again"). No menus: the page starts the round itself.
(function (root) {
  'use strict';
  var P = root.DuelPaperLib = root.DuelPaperLib || {};

  var clock = typeof performance !== 'undefined' ? performance : Date;
  function nowMs() {
    return clock.now();
  }

  // ---------------------------------------------------------------------------------------------
  // In-game strings. The canvas reads exactly three keys from game.language (player fallback name,
  // the "best" prefix, the kill label), so only those are carried, per language. Missing keys
  // fall back to English when the table is registered.
  // ---------------------------------------------------------------------------------------------
  var languagesData = {
    en: { defaultPlayerName: 'Player', bestTxt: 'BEST', killText: 'Kill' },
    ru: { defaultPlayerName: 'Игрок', bestTxt: 'ЛУЧШИЙ', killText: 'Убит' },
    tr: { defaultPlayerName: 'Oyuncu', bestTxt: 'EN İYİ', killText: 'Öldürmek' },
    sp: { defaultPlayerName: 'Jugador', bestTxt: 'MEJOR', killText: 'Matar' },
    fr: { defaultPlayerName: 'Joueur', bestTxt: 'MEILLEUR', killText: 'Tuer' },
    nl: { defaultPlayerName: 'Speler', bestTxt: 'BESTE', killText: 'Doden' },
    pt: { defaultPlayerName: 'Jogador', bestTxt: 'MELHOR', killText: 'Mate' },
    de: { defaultPlayerName: 'Spieler', bestTxt: 'BESTE', killText: 'Töten' },
    it: { defaultPlayerName: 'Giocatore', bestTxt: 'MIGLIORE', killText: 'Uccidere' }
  };

  var languageList = [];

  function registerLanguages(table) {
    var english = table.en;
    Object.keys(table).forEach(function (code) {
      languageList.push({ name: code, strings: Object.assign(Object.assign({}, english), table[code]) });
    });
  }

  function browserLanguageCode() {
    var nav = typeof navigator !== 'undefined' ? navigator : {};
    var tag = (nav.languages && nav.languages.length && nav.languages[0]) ||
      nav.userLanguage || nav.language || nav.browserLanguage || 'en';
    return tag.substr(0, 2).toLowerCase();
  }

  function pickDefaultLanguage() {
    var code = browserLanguageCode();
    return languageList.find(function (entry) { return entry.name === code; }) ||
      languageList.find(function (entry) { return entry.name === 'en'; });
  }

  // ---------------------------------------------------------------------------------------------
  // Game session API.
  //   create(view)   builds the world on a canvas (one Math.random draw: the simulation seed)
  //   prepare(cb)    warm-up: batches of updates on a zero-delay interval, no rendering
  //   start(...)     spawns the player (finishing the warm-up synchronously if it was still running)
  //   preparing      true until the warm-up ended or start ran
  //   game           the Game instance
  // startGame() is added by the page shell below, because it needs the shell's route state.
  //
  // Host hook (set it on window.duelPaper at any time, for example from a page that embeds this one):
  //   onRoundEnd = function (result) {}
  //     called once per finished round, when the results overlay comes up, with
  //       percent      final score in percent, 0..100 with two decimals (the number the overlay prints)
  //       bestPercent  largest share of the arena held at any moment of the round, same units
  //       kills        units killed by the player
  //       timeMs       round length in milliseconds, spawn to death (or win)
  //       won          true when the round ended by filling the arena
  //     An exception thrown by the hook is reported to the console and never reaches the game.
  // ---------------------------------------------------------------------------------------------
  function createGameApi(config, languagePack, makeSkinManager, nameManager, schemesManager) {
    if (typeof Path2D === 'undefined' || !Path2D) return null;

    var api = {};
    var warmupUpdates = 0;
    var warmupTimer;

    api.create = function (view) {
      var arenaSize = config.arenaSize;
      var space = new P.SpatialGrid(arenaSize, arenaSize, config.quadSize);
      P.Vec2.space = space;
      var center = new P.Vec2(arenaSize / 2, arenaSize / 2);
      var radius = Math.min(center.x, center.y) * 0.95;
      var border = P.ArenaBorder.circular(center, config.borderPoints, radius);
      var skinManager = makeSkinManager(config, view);
      // The seed draw is the LAST constructor argument, so it happens after everything above.
      var game = new P.Game(
        config,
        view,
        space,
        border,
        skinManager,
        null,
        nameManager,
        new P.InputController(view),
        languagePack.strings,
        schemesManager,
        Math.random()
      );
      skinManager.game = game;
      game.renderer = P.renderGameFrame;
      api.game = game;
      // The developer key chords (debug overlay toggles) are left out: that overlay is not part of the game.
    };

    api.preparing = true;
    api.onRoundEnd = null;

    function runWarmupBatch() {
      var mult = config.prepareMult;
      var left = config.prepareBatchCount;
      while (left--) {
        api.game.update((1000 / 60) * mult + Math.random());
        warmupUpdates++;
      }
    }

    api.prepare = function (onDone) {
      var game = api.game;
      warmupTimer = setInterval(function () {
        if (nameManager.available()) {
          runWarmupBatch();
          if (warmupUpdates > config.prepareCounter) {
            clearInterval(warmupTimer);
            api.preparing = false;
            game.visible = true;
            if (!game.looped) game.loop();
            if (onDone) onDone();
          }
        }
      }, 0);
    };

    api.start = function (nickName, skinName, bestScore, onGameOver) {
      var game = api.game;
      if (api.preparing) {
        // Early start: finish the warm-up now, but never block for longer than the configured cap.
        clearInterval(warmupTimer);
        var catchupStart = nowMs();
        while (warmupUpdates < config.prepareCounter) {
          runWarmupBatch();
          if (nowMs() - catchupStart > config.maxPreparingTime) break;
        }
      }
      game.best = bestScore;
      game.spawnPlayer(nickName, skinName);
      if (onGameOver) game.gameOverCallback = onGameOver;
      api.preparing = false;
      game.visible = true;
      if (!game.looped) game.loop();
      if (typeof root.focus === 'function') root.focus();
    };

    return api;
  }

  // ---------------------------------------------------------------------------------------------
  // Deferred effects.
  // "create + prepare" (page load) and "api.start" (after startGame) run as deferred effects
  // that are flushed AFTER the next paint: requestAnimationFrame, with a 100 ms timer as a fallback for
  // a hidden tab, and from whichever fires first a zero-delay timer that finally runs the effects.
  // That sequence decides on which animation frame the player exists:
  //   frame N   : the loop callback (queued earlier) runs first, then our rAF callback arms the timer
  //   frame N+1 : timers fire before the frame's callbacks, so the player is spawned and then simulated
  //               and drawn in that same frame.
  // So after startGame() the first frame still has no player and the second one does; the recorded
  // parity runs depend on that. Effects queued while a flush is already pending share that flush.
  // The page-load effect goes through the same gate, which fixes the frame on which the warm-up starts
  // (and with it every later timestamp). The fallback timer is created before the rAF request
  // so timer ids are handed out in a fixed order.
  // ---------------------------------------------------------------------------------------------
  var pendingEffects = [];

  function flushEffects() {
    var batch = pendingEffects;
    pendingEffects = [];
    for (var i = 0; i < batch.length; i++) batch[i]();
  }

  function afterNextPaint(callback) {
    var hasRaf = typeof requestAnimationFrame === 'function';
    var rafId;
    var fallbackTimer;
    var done = function () {
      clearTimeout(fallbackTimer);
      if (hasRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
      setTimeout(callback);
    };
    fallbackTimer = setTimeout(done, 100);
    if (hasRaf) rafId = requestAnimationFrame(done);
  }

  function queueEffect(effect) {
    if (pendingEffects.push(effect) === 1) afterNextPaint(flushEffects);
  }

  // ---------------------------------------------------------------------------------------------
  // Boot + page shell.
  // options:
  //   autoStart   start a round as soon as fonts and warm-up are ready (normal page). Default false.
  //   container   element (or id) that receives the canvas. Default "game", else document.body.
  //   nickName    player name, "" means the language's default name. Default "".
  //   skin        player skin name, "" means a random free colour. Default "".
  //   bestScore   if a number: use it as the stored best and never write storage (test pages).
  // ---------------------------------------------------------------------------------------------
  function boot(options) {
    options = options || {};
    var doc = root.document;

    if (typeof P.installGameMoves === 'function') P.installGameMoves();

    var config = Object.assign(Object.assign({}, P.defaultPaperConfig), {
      followKiller: true,
      selfKillDelay: 1000,
      enemyKillDelay: 2000
    });

    if (!languageList.length) registerLanguages(languagesData);

    var makeSkinManager = function (cfg, view) {
      var colorPool = new P.ColorSkinPool(cfg);
      var classicPool = new P.ClassicSkinPool(cfg, view, P.skinAssetPath, P.skinsData);
      return new P.SkinManager(colorPool, classicPool, 1);
    };

    var schemesManager = new P.ScoreSchemeManager(P.PercentScoreScheme);

    // First Math.random draw of the page: the seed of the bot-name stream. The simulation seed is the
    // second one, drawn later inside api.create.
    var api = createGameApi(
      config,
      pickDefaultLanguage(),
      makeSkinManager,
      new P.RandomNamePool(P.botNames, Math.random()),
      schemesManager
    );
    root.duelPaper = api;
    if (!api) {
      showUnsupported(doc);
      return null;
    }

    // ---- shell state ----
    var pinnedBest = typeof options.bestScore === 'number' && isFinite(options.bestScore);
    var state = {
      route: 'menu',
      preparing: true,
      language: pickDefaultLanguage(),
      results: null,
      nickName: options.nickName || '',
      bestScore: pinnedBest ? options.bestScore : ((P.bestScoreStorage && P.bestScoreStorage.load()) || 0),
      skin: options.skin || '',
      fontsReady: false,
      autoStartPending: !!options.autoStart,
      // The loading layer stays up until the first player exists, so the observer view is never shown.
      firstSpawnPending: !!options.autoStart
    };
    api.shell = state;

    var view = ensureCanvas(doc, options.container);
    var loadingEl = doc.getElementById('paper-loading');
    var againEl = doc.getElementById('paper-again');
    var againScoreEl = doc.getElementById('paper-again-score');

    // A layer that goes away must not keep keyboard focus (a clicked "Play again" button would otherwise
    // stay the active element while hidden and swallow the steering keys of the next round).
    function show(el, visible) {
      if (!el) return;
      if (!visible) {
        var active = doc.activeElement;
        if (active && active !== doc.body && typeof el.contains === 'function' && el.contains(active) &&
            typeof active.blur === 'function') {
          active.blur();
        }
      }
      el.hidden = !visible;
      el.style.display = visible ? '' : 'none';
    }

    function refreshOverlays() {
      show(loadingEl, state.firstSpawnPending);
      show(againEl, state.route === 'results');
      if (againScoreEl && state.results) {
        againScoreEl.textContent = state.results.score.toFixed(2) + '%';
      }
    }

    function onGameOver(results) {
      if (results.newBest) {
        state.bestScore = results.score;
        if (!pinnedBest && P.bestScoreStorage) P.bestScoreStorage.save(results.score);
      }
      state.results = results;
      setRoute('results');
      notifyRoundEnd(results);
    }

    function notifyRoundEnd(results) {
      if (typeof api.onRoundEnd !== 'function') return;
      var summary = {
        percent: results.score,
        bestPercent: +(results.bestPercent * 100).toFixed(2),
        kills: results.kills,
        timeMs: results.time,
        won: results.reason === P.KILL_REASON_WIN
      };
      try {
        api.onRoundEnd(summary);
      } catch (err) {
        if (root.console && root.console.error) root.console.error(err);
      }
    }

    // Runs once per round, after the paint that follows startGame().
    function sessionStartEffect() {
      api.game.language = state.language.strings;
      var skinName = state.skin;
      if (skinName === 'default' || skinName === 'No skin') skinName = '';
      api.start(state.nickName, skinName, state.bestScore, onGameOver);
      state.preparing = false;
      // This runs in the timer phase, before the frame is drawn: the first frame seen has the player.
      if (state.firstSpawnPending) {
        state.firstSpawnPending = false;
        refreshOverlays();
      }
    }

    function setRoute(next) {
      if (state.route === next) return;
      state.route = next;
      refreshOverlays();
      if (next === 'game') queueEffect(sessionStartEffect);
    }

    // Makes the world visible and switches to the game; the player is spawned by the deferred effect.
    // Calling it again while a round is running does nothing (the route is already 'game').
    api.startGame = function () {
      if (api.game) api.game.visible = true;
      setRoute('game');
    };

    // Auto-start and "Play again" both come through here.
    function requestGameStart() {
      state.autoStartPending = false;
      api.startGame();
    }
    api.requestGameStart = requestGameStart;

    // A hidden document gets no animation frames, and the first frame after it is shown replays up to
    // 10 s of simulation in one go. A player spawned while hidden would spend that running straight
    // ahead unattended, so the automatic start waits until the page can be seen. A round that is
    // already running is not touched when the page gets hidden.
    function documentVisible() {
      return typeof doc.visibilityState !== 'string' || doc.visibilityState === 'visible';
    }

    function maybeAutoStart() {
      if (state.autoStartPending && state.fontsReady && !state.preparing && state.route === 'menu' &&
          documentVisible()) {
        requestGameStart();
      }
    }

    // Page-load effect: build the world, then warm it up in the background.
    queueEffect(function () {
      api.create(view);
      api.prepare(function () {
        state.preparing = false;
        maybeAutoStart();
      });
    });

    // The HUD font should be in place before the first drawn frame, or text metrics change mid-round.
    // Only the automatic start waits for it, and never longer than FONT_WAIT_MS.
    if (state.autoStartPending) {
      whenFontsReady(doc, hudPreloadText(state.language.strings, state.nickName), function () {
        state.fontsReady = true;
        maybeAutoStart();
      });
      if (typeof doc.addEventListener === 'function') doc.addEventListener('visibilitychange', maybeAutoStart);
    }

    // ---- overlays ----
    if (againEl) {
      againEl.addEventListener('click', function (event) {
        event.preventDefault();
        if (state.route === 'results') requestGameStart();
      });
    }
    // Inside the DuelSeries lobby the page runs in an iframe, and the lobby closes that frame when it hears
    // 'game:done' (the same message the other game pages send). On its own there is nowhere to go back to,
    // so the button stays hidden.
    var leaveEl = doc.getElementById('paper-leave');
    if (leaveEl) {
      var framed = false;
      try { framed = !!root.parent && root.parent !== root; } catch (_) { framed = true; }
      leaveEl.hidden = !framed;
      leaveEl.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation(); // the whole layer is a "play again" target
        try { root.parent.postMessage('game:done', '*'); } catch (_) {}
      });
    }
    if (loadingEl) {
      // Pressing play before the warm-up is over is allowed: api.start then catches up.
      loadingEl.addEventListener('click', function (event) {
        event.preventDefault();
        if (state.route === 'menu' && state.autoStartPending && api.game) requestGameStart();
      });
    }
    root.addEventListener('keydown', function (event) {
      if (state.route !== 'results') return;
      var code = event.keyCode || event.which;
      if (code === 32 || code === 13 || event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        requestGameStart();
      }
    });

    refreshOverlays();
    return api;
  }

  // The Game sizes the canvas backing store itself on every rendered frame (client size times quality),
  // so nothing here sets width / height or listens for resize: CSS keeps #view at the full viewport.
  function ensureCanvas(doc, container) {
    var view = doc.getElementById('view');
    if (view) return view;
    var host = typeof container === 'string' ? doc.getElementById(container) : container;
    if (!host) host = doc.getElementById('game') || doc.body;
    view = doc.createElement('canvas');
    view.id = 'view';
    host.appendChild(view);
    return view;
  }

  var FONT_WAIT_MS = 2000;

  // Every character the canvas can print with the data this page runs on: score digits and signs, the three
  // strings of the active language, the player's name and the bot names. The font is split into
  // unicode-range subsets and the browser fetches only the subsets this text touches (shipped names are
  // plain ASCII, so an English page loads the latin file alone; Russian adds the cyrillic one).
  function hudPreloadText(strings, nickName) {
    var source = ['0123456789.,:%#+- ', strings.defaultPlayerName, strings.bestTxt, strings.killText, nickName || '']
      .concat(P.botNames || []).join('');
    var seen = {};
    var text = '';
    for (var i = 0; i < source.length; i++) {
      var ch = source.charAt(i);
      if (!seen[ch]) {
        seen[ch] = true;
        text += ch;
      }
    }
    return text;
  }

  // Calls back once: when the needed font files are in, when loading failed, or after FONT_WAIT_MS,
  // whichever comes first. A blocked or slow font must never keep the game from starting.
  function whenFontsReady(doc, text, callback) {
    var fonts = doc.fonts;
    if (!fonts || typeof fonts.load !== 'function') {
      callback();
      return;
    }
    var settled = false;
    var timer;
    var finish = function () {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    timer = setTimeout(finish, FONT_WAIT_MS);
    try {
      fonts.load('700 20px "PT Sans Caption"', text).then(finish, finish);
    } catch (err) {
      finish();
    }
  }

  function showUnsupported(doc) {
    var note = doc.getElementById('paper-unsupported');
    if (note) {
      note.hidden = false;
      note.style.display = '';
    }
  }

  P.createGameApi = createGameApi;
  P.registerLanguages = registerLanguages;
  P.pickDefaultLanguage = pickDefaultLanguage;
  P.languagesData = languagesData;
  P.hudPreloadText = hudPreloadText;
  P.whenFontsReady = whenFontsReady;
  P.boot = boot;
})(typeof window !== 'undefined' ? window : globalThis);
