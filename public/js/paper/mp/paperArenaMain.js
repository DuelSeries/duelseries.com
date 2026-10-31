// Paper multiplayer: the arena page's boot and shell (design 8.5). It builds the mirror game the
// way paperMain.js builds the solo one (same config, languages, skin manager and fonts), wires
// the net layer to the page's socket, and owns the DOM around the canvas: the connecting and
// warming layer, the reconnect veil, the four end cards (refused, dead, cashed out, disconnected)
// and the leaderboard, both the site's shared ones (public/js/shared/dsEnd.js, DSEnd), the Q key
// and the touch hold button, and the analytics. The stock canvas leaderboard plates are off on
// this page (see topListChanged below). The live game has NO leave control: Lobby is on the end
// cards only. Watch mode (the lobby's Spectate,
// sessionStorage dsWatch = 'paper') never joins: it watches the busiest free table read-only,
// under the shared Spectate bar (Lobby, previous, the followed square's name, next). The death and cash-out cards'
// Spectate reopens this page in watch mode on the same table's rung, as the lobby's Spectate does.
// Test-only: ?lag=N delays every socket event by N ms each way (so ?lag=50 is a 100 ms round
// trip); off by default.
(function (root) {
  'use strict';
  var doc = root.document;
  var P = root.DuelPaperLib;

  var BEST_KEY = 'duelseries.paper.arena.best'; // the solo page keeps its own best
  var JOIN_RETRY_MIN_MS = 1100; // the server takes one pp:join per 1000 ms per socket
  var MAX_LAG_MS = 2000;
  var ARROW_HALF_PX = 13; // half the touch arrow's 26 px box
  var ARROW_GAP_PX = 14; // clear space between the square's corner and the arrow's tail
  var RESTAKE_WAIT_MS = 120000; // public/js/game.js requestRestake's safety window
  var WATCH_RETRY_MS = 3000; // watch mode: nothing to watch (or no answer yet), ask again this often
  var BOARD_MS = 200; // the leaderboard is redrawn at most this often (its land % move every tick)
  var END_CARDS = { dead: true, cashed: true, refused: true, gone: true };
  // The end cards' Spectate does what the lobby's does for this game (public/js/v2/play.js spectate): every money key
  // a page could read goes first (its MONEY_KEYS), then the watch mark, then the same page the lobby opens.
  var WATCH_MONEY_KEYS = ['entryToken', 'entrySol', 'stake', 'slPaidLaunch', 'slxPaidCut', 'slBr', 'spectateOnly'];
  var WATCH_URL = '/paper-arena';
  // Watch mode's waiting words per pp:watching { none: true, why } (server paperSockets.js WATCH_TEXT).
  var WATCH_TEXT = {
    nobody: 'Nobody is playing right now',
    closed: 'Nobody is playing right now',
    full: 'Too many people are watching right now',
    'bad-stake': 'This table cannot be watched',
    seated: 'You are playing at a table already'
  };
  // The refused screen's own words per reason (server paperSockets.js TEXT, minus its refund
  // sentence): the refund line is shown only when the refusal says refunded (design 8.5).
  var REFUSED_TEXT = {
    'bad-stake': 'That table does not exist.',
    'not-open': 'Paid Paper tables are not open yet.',
    maintenance: 'DuelSeries is updating. Try again in a few minutes.',
    full: 'Every Paper table at this stake is full.',
    entry: 'Entry fee not verified.',
    'seat-failed': 'Could not seat you.',
    'join-lost': 'The connection dropped while you were joining.',
    'join-timeout': 'Your connection did not answer in time.',
    warming: 'The table is getting ready. Try again in a few seconds.'
  };
  var REASON_TEXT = {
    1: 'You crossed your own trail',
    2: 'You hit the wall',
    7: 'You cashed out',
    8: 'You were away too long',
    9: 'You left the table'
  };

  function $(id) {
    return doc.getElementById(id);
  }

  function show(el, visible) {
    if (!el) return;
    if (!visible) {
      var active = doc.activeElement;
      if (active && active !== doc.body && el.contains(active) && typeof active.blur === 'function') active.blur();
    }
    el.hidden = !visible;
  }

  function nowMs() {
    return (root.performance && typeof root.performance.now === 'function' ? root.performance : Date).now();
  }

  // A land share in percent points (18.4) as the stock HUD prints it ('18.40%').
  function pctText(v) {
    return (Math.round((Number(v) || 0) * 100) / 100).toFixed(2) + '%';
  }

  function isFramed() {
    try {
      return !!root.parent && root.parent !== root;
    } catch (_) {
      return true;
    }
  }

  function storageGet(store, key) {
    try {
      return root[store].getItem(key);
    } catch (_) {
      return null;
    }
  }

  // The keys the lobby's wallet widget writes before it opens this page (read once). The name falls back to the one
  // the lobby keeps (duelseries_playername), as /sl and agar.io do, so a page opened without the hand-off is not 'Player'.
  function readSession() {
    var stake = Number(storageGet('sessionStorage', 'stake'));
    return {
      name: (storageGet('sessionStorage', 'playerName') || storageGet('localStorage', 'duelseries_playername') || '').slice(0, 20),
      stake: isFinite(stake) && stake > 0 ? stake : 0,
      entryToken: storageGet('sessionStorage', 'entryToken') || null,
      walletAddress: storageGet('sessionStorage', 'walletAddress') || null,
      region: storageGet('sessionStorage', 'region') || null
    };
  }

  // The paid Paper skin the player picked in the lobby and the lobby's skin pass (docs/skin-purchases.md), from
  // localStorage (the lobby is the same origin). Sent in the join; the SERVER wears the skin only when the pass is
  // genuine and lists it, so nothing here can grant one. null when there is no choice or no pass.
  function readPaidSkin() {
    var shop = storageGet('localStorage', 'duel.shop.paper');
    var pass = storageGet('localStorage', 'duel.skinpass');
    if (typeof shop !== 'string' || !/^[a-z][a-z0-9]{0,23}$/.test(shop)) return null;
    if (typeof pass !== 'string' || !pass || pass.length > 4096) return null;
    return { shop: shop, skinPass: pass };
  }

  // The lobby's Spectate (public/js/v2/play.js) writes dsWatch = 'paper' (and removes stake and entryToken) before it
  // opens this page, and dsWatchStake for a paid rung: the table to watch, never a buy-in. Read once and removed at
  // boot, whatever they say.
  function readWatch() {
    var v = storageGet('sessionStorage', 'dsWatch');
    var s = Number(storageGet('sessionStorage', 'dsWatchStake'));
    try {
      root.sessionStorage.removeItem('dsWatch');
      root.sessionStorage.removeItem('dsWatchStake');
    } catch (_) {}
    return v === 'paper' ? { stake: isFinite(s) && s > 0 ? s : 0 } : null;
  }

  // A fresh id for one restake request, echoed back by the lobby's wallet with its answer.
  function newNonce() {
    try {
      var a = new root.Uint32Array(4);
      root.crypto.getRandomValues(a);
      return Array.prototype.map.call(a, function (n) { return n.toString(36); }).join('');
    } catch (_) {
      return Math.random().toString(36).slice(2) + Date.now().toString(36);
    }
  }

  function queryNumber(name) {
    try {
      var v = new root.URLSearchParams(root.location.search).get(name);
      var n = Number(v);
      return v !== null && isFinite(n) ? n : 0;
    } catch (_) {
      return 0;
    }
  }

  function loadBest() {
    var n = Number(storageGet('localStorage', BEST_KEY));
    return isFinite(n) && n > 0 ? n : 0;
  }

  function saveBest(v) {
    try {
      root.localStorage.setItem(BEST_KEY, String(v));
    } catch (_) {}
  }

  // A socket whose every event, both ways, is delayed by ms (FIFO: equal delays keep order).
  function laggedSocket(socket, ms) {
    var wrap = {
      on: function (ev, fn) {
        socket.on(ev, function (payload) {
          setTimeout(function () { fn(payload); }, ms);
        });
        return wrap;
      },
      emit: function (ev, payload) {
        var args = arguments;
        setTimeout(function () { socket.emit.apply(socket, args); }, ms);
        return wrap;
      },
      volatile: {
        emit: function () {
          var args = arguments;
          setTimeout(function () { socket.volatile.emit.apply(socket.volatile, args); }, ms);
        }
      }
    };
    return wrap;
  }

  function boot() {
    var DSEnd = root.DSEnd;
    if (!P || typeof Path2D === 'undefined' || typeof root.io !== 'function' || !P.Mirror || !P.Net || !P.Hud ||
        !P.MP || !DSEnd) {
      show($('pp-connecting'), false);
      show($('pp-unsupported'), true);
      return null;
    }
    var MP = P.MP;
    var session = readSession();
    // Watch mode is free and read-only: no stake, and no entry token ever leaves this page.
    var watchOf = readWatch();
    var watchMode = !!watchOf;
    if (watchMode) {
      session.stake = 0;
      session.entryToken = null;
    }
    var paidStake = session.stake > 0;
    var framed = isFramed();

    if (typeof P.installGameMoves === 'function') P.installGameMoves();
    var language = P.pickDefaultLanguage();
    if (!language) {
      P.registerLanguages(P.languagesData);
      language = P.pickDefaultLanguage();
    }
    var config = Object.assign(Object.assign({}, P.defaultPaperConfig), {
      followKiller: true,
      selfKillDelay: 1000,
      enemyKillDelay: 2000
    });

    var view = $('view');
    var skinManager = new P.SkinManager(
      new P.ColorSkinPool(config),
      new P.ClassicSkinPool(config, view, P.skinAssetPath, P.skinsData),
      1
    );

    var lagMs = Math.max(0, Math.min(MAX_LAG_MS, queryNumber('lag')));
    var socket = root.io();
    var link = lagMs > 0 ? laggedSocket(socket, lagMs) : socket;
    var net = new P.Net.ArenaNet({ socket: link });
    // The ping and FPS readout every game shares (public/js/shared/dsPerfHud.js), timed on the real socket.
    if (root.DSPerfHud) root.DSPerfHud.mount({ socket: socket });

    // ---- DOM ----
    var el = {
      connecting: $('pp-connecting'),
      connectingText: $('pp-connecting-text'),
      connectingSub: $('pp-connecting-sub'),
      reconnecting: $('pp-reconnecting'),
      hint: $('pp-hint'),
      cash: $('pp-cash'),
      cashFill: $('pp-cash-fill'),
      cashLabel: $('pp-cash-label')
    };
    var RING_C = 2 * Math.PI * 32;
    if (el.cashFill) {
      el.cashFill.style.strokeDasharray = String(RING_C);
      el.cashFill.style.strokeDashoffset = String(RING_C);
    }

    var page = {
      phase: 'connecting', // connecting | live | ending | end | watch
      // Watch mode: watch is set once at boot (cleared by Lobby); watchLive while a table's state is shown.
      watch: watchMode,
      watchLive: false,
      stake: session.stake,
      // What covers the game: 'connecting' | 'reconnecting' | an end card ('dead' | 'cashed' | 'refused' |
      // 'gone') | null. end: the card's own state while one shows, { kind, opts, again, note }.
      screen: null,
      end: null,
      joinedSocketId: null,
      holdDown: false,
      timers: {},
      restaking: false,
      restakeNonce: null,
      lobbyLocked: false,
      network: 'mainnet-beta',
      networkAsked: false,
      connects: 0,
      drops: 0,
      joinSent: false,
      joinOutDrop: null,
      // The entry token of the paid join (or respawn) still waiting for its answer, in page
      // memory only. If the link drops before pp:joined, the same token goes out once more on
      // the next connection: the server takes back the seat it bought (still unconfirmed, no
      // second buy-in), tells the refund it already made, or seats it for the first time if
      // the first message never arrived. Cleared by pp:joined and pp:refused.
      joinToken: null,
      roundBest: 0,
      // The round's own facts for the end card, all seen by this page: when it started (pp:joined, not a resumed
      // one), when it ended (pp:dead / pp:cashedout), the best rank on the leaderboard, the land while alive.
      roundStartMs: null,
      roundEndMs: null,
      bestRank: 0,
      landNow: 0,
      deathLand: 0,
      roundKills: null,     // the own square's kills at the round's end (the mirror counts the server's kills)
      // the own place and how many squares the last drawn board listed (product tracking reads them at the end)
      rankNow: 0,
      boardCount: 0
    };

    // Product tracking (public/js/shared/dsTrack.js, every name and property checked against shared/trackPlan.js):
    // this page's player, one call per round's start and end and per watch, never per frame. A paid round's start and
    // end are the server's; there the page's calls only time it for its FPS and ping summary. A page without the
    // helper (the tests' pages) tracks nothing, and a throw in it never reaches the game.
    var track = null;
    try {
      if (root.DSTrack && typeof root.DSTrack.game === 'function') {
        var watchPaid = watchMode && watchOf.stake > 0;
        track = root.DSTrack.game('paper', {
          paid: paidStake || watchPaid,
          stake: watchMode ? watchOf.stake : session.stake,
          mode: paidStake || watchPaid ? 'paid' : 'free',
          region: session.region || undefined
        });
      }
    } catch (_) {
      track = null;
    }
    function tracked(fn) {
      if (!track) return;
      try {
        fn(track);
      } catch (_) { /* analytics never breaks the game */ }
    }

    // socket.io keeps an emit made while the link is down and sends it on the next connection
    // BEFORE that connection's 'connect' event (the client's sendBuffer), as it does for an emit
    // made after its ping expired. So the connect hook asks when the pending join really went
    // out: page.drops counts the link's drops, and page.joinOutDrop is that count when the join
    // was handed to the transport (null: not yet).
    var tracksOutgoing = typeof socket.onAnyOutgoing === 'function';
    if (tracksOutgoing) {
      socket.onAnyOutgoing(function (ev) {
        if (ev === 'pp:join' || ev === 'pp:respawn') page.joinOutDrop = page.drops;
      });
    }
    socket.on('disconnect', function () {
      page.drops++;
    });

    // Before every join or respawn emit (an emit on a live link reports itself at once).
    function markJoin() {
      page.joinSent = true;
      page.joinOutDrop = tracksOutgoing || !socket.connected ? null : page.drops;
    }

    function later(name, fn, ms) {
      clearTimeout(page.timers[name]);
      page.timers[name] = setTimeout(function () {
        page.timers[name] = null;
        fn();
      }, ms);
    }

    function cancel(name) {
      clearTimeout(page.timers[name]);
      page.timers[name] = null;
    }

    function holdText(hold, game) {
      var verb = game && game.paid ? 'Cashing out' : 'Leaving';
      if (hold.waiting) return verb + ', release to cancel';
      return verb + ' ' + (hold.remainingMs / 1000).toFixed(1) + ' s, release to cancel';
    }

    // The touch button's ring follows the HUD's own-hold state every drawn frame.
    var lastButton = '';
    function updateCashButton(hold) {
      if (!el.cash || el.cash.hidden) return;
      var key = hold.active ? (hold.waiting ? 'w' : hold.fraction.toFixed(3)) : '';
      if (key === lastButton) return;
      lastButton = key;
      el.cash.classList.toggle('pp-down', !!hold.active);
      el.cash.classList.toggle('pp-waiting', !!(hold.active && hold.waiting));
      if (el.cashFill) {
        var f = hold.active && !hold.waiting ? hold.fraction : 0;
        el.cashFill.style.strokeDashoffset = String(RING_C * (1 - f));
      }
    }

    var hud = P.Hud.create({ onLocalHold: updateCashButton, holdText: holdText });
    // Touch steers through paperTouch.js (the snake game's anchored stick and heading arrow); the
    // stock controller keeps the keyboard and mouse and is built blind to touches.
    var controller = new P.InputController(P.Touch ? P.Touch.withoutTouch(view) : view);
    var game = P.Mirror.create({
      view: view,
      controller: controller,
      net: net,
      hud: hud,
      config: config,
      skinManager: skinManager,
      language: language.strings
    });
    var touch = P.Touch ? P.Touch.create({
      view: view,
      controller: controller,
      heading: function () {
        return game.direction || null;
      },
      arrow: $('pp-arrow'),
      ahead: arrowAhead,
      lift: function () {
        return (config.baseHeight || 0) * arrowPerUnit(); // the square is drawn on its lifted land
      }
    }) : null;
    // The arrow sits just clear of the square, as the snake game's sits just ahead of the head.
    // The camera scales the world with the screen's diagonal and zooms out as the land grows:
    // CSS px per world unit is game.scale * diagonal / hypot(1366, 768) (getRenderContext's
    // hudScale over devicePixelRatio, with the quality factor cancelled). The square is
    // skin maxScale * trackWidth across, so its corner is 0.71 of that from its centre.
    function arrowPerUnit() {
      return (game.scale || 4.5) * Math.hypot(view.clientWidth, view.clientHeight) / Math.hypot(1366, 768);
    }
    function arrowAhead() {
      var perUnit = arrowPerUnit();
      var skin = game.player && game.player.skin;
      var size = ((skin && skin.container && skin.container.maxScale) || 1) * (config.trackWidth || 8);
      return size * 0.71 * perUnit + ARROW_HALF_PX + ARROW_GAP_PX;
    }
    game.onApplied = function (entry, tick) {
      hud.onApplied(entry, tick, game);
    };
    // A view with no size (a hidden frame or tab) has nothing to draw, and the stock leaderboard
    // cache is sized on its first draw: made at 0 wide it throws on every later frame. A throw
    // out of render would also end the unchanged loop (its next frame is requested after it),
    // freezing a live square, so a render fault is reported and the loop keeps running.
    var baseRenderer = game.renderer;
    var renderFaults = 0;
    game.renderer = function (g) {
      if (!(view.clientWidth > 0 && view.clientHeight > 0)) return;
      try {
        baseRenderer(g);
        if (touch) touch.drawArrow(page.phase === 'live' && !!game.player && !game.player.death);
        trackRound();
        refreshBoard();
      } catch (err) {
        if (renderFaults++ < 3 && root.console) root.console.error('[PAPER] render', err);
      }
    };

    // ---- the leaderboard (DSEnd.board, the site's one board) ----
    // The stock plates (paperRender.js drawLeaderboardPlates, pinned by the solo parity gate) are drawn only when
    // the game's topListChanged flag is up: on this page it always reads false, so they never are, and every raise
    // (the stock rule: a top-six or own score changed, a square came or went) marks the DOM board for a redraw.
    var board = DSEnd.board({ title: 'Leaderboard' });
    board.hide(); // until there is a square to rank
    var boardOn = false;
    var boardDirty = true;
    var boardAt = -Infinity;
    Object.defineProperty(game, 'topListChanged', {
      configurable: true,
      get: function () { return false; },
      set: function (v) { if (v) boardDirty = true; }
    });

    function unitName(u) {
      return (u && u.name) || (language.strings && language.strings.defaultPlayerName) || 'Player';
    }

    // The live squares in the stock order (game.units, sorted by score every update), land % as the plates print
    // it; your row (the followed square when watching) is pinned under the list when outside it. Shown whenever
    // the stock HUD would be (a player to draw it for), except under the connecting layer. A paid room ranks by
    // money (Owen 2026-10-17: "how much they're worth... the higher the number the higher the rank"): each square's
    // live $ (u.micro, the server's bank balance every frame, bots too), most first, then land. Display only.
    var boardPaid = false;
    function refreshBoard() {
      var me = game.player;
      var on = !!me && page.screen !== 'connecting';
      var paid = !!game.paid;
      if (paid !== boardPaid) {
        boardPaid = paid;
        if (board.el) board.el.className = String(board.el.className).replace(/\s*\bmoney\b/g, '') + (paid ? ' money' : '');
        boardDirty = true;
      }
      if (paid) boardDirty = true; // money moves without a stock raise; BOARD_MS and the board's own key limit writes
      if (on !== boardOn) {
        boardOn = on;
        if (on) board.show(); else board.hide();
        boardDirty = true;
      }
      if (!on || !boardDirty) return;
      var t = nowMs();
      if (t - boardAt < BOARD_MS) return;
      boardDirty = false;
      boardAt = t;
      var rows = [];
      var mine = null;
      var units = game.units || [];
      if (paid) {
        units = units.slice();
        var at = new Map();
        for (var k = 0; k < units.length; k++) at.set(units[k], k);
        units.sort(function (a, b) {
          return ((b && b.micro) || 0) - ((a && a.micro) || 0) || at.get(a) - at.get(b);
        });
      }
      for (var i = 0; i < units.length; i++) {
        var u = units[i];
        if (!u || u.death) continue;
        var row = {
          rank: rows.length + 1,
          name: unitName(u),
          value: paid ? DSEnd.usd(Math.max(0, Number(u.micro) || 0))
            : u.schemes && typeof u.schemes.print === 'function' ? u.schemes.print() : pctText((u.percent || 0) * 100),
          me: u === me
        };
        rows.push(row);
        if (row.me) mine = row;
      }
      board.set(rows, mine);
      if (mine && page.phase === 'live' && !page.watch && (!page.bestRank || mine.rank < page.bestRank)) {
        page.bestRank = mine.rank;
      }
      if (page.phase === 'live' && !page.watch) {
        page.rankNow = mine ? mine.rank : 0;
        page.boardCount = rows.length;
      }
    }

    // The own land while the square lives: what the death card shows (the land is gone by the time it does).
    function trackRound() {
      var me = game.player;
      if (page.phase === 'live' && !page.watch && me && !me.death) page.landNow = (me.percent || 0) * 100;
    }
    var best = loadBest();
    game.best = watchMode ? undefined : best || undefined; // a watcher's own best is not the followed square's

    // ---- chat (public/js/shared/dsChat.js: T types, Enter sends; the server's pp:chat and pp:chatnote) ----
    // Only a live square sends; a watcher reads. The box shows while a table does (live, or a watched one): bottom left
    // above the leave hint (higher in watch mode, where the Next bar sits there), and on a phone top left under the
    // stock score stack, the place the watch page puts its Lobby button (layoutChat), with the watcher's box below it.
    var chat = null;
    if (root.DSChat) {
      chat = root.DSChat.mount({
        send: function (t) { return net.chat(t); },
        canSend: function () { return page.phase === 'live' && !page.watch; },
        light: true,
        pc: { left: 12, bottom: watchMode ? 58 : 54 },
        phoneAt: { left: 10, top: 124 }
      });
      net.on('pp:chat', function (m) {
        m = m || {};
        chat.add({ name: m.name, color: m.c, text: m.text, me: net.you > 0 && m.id === net.you });
      });
      net.on('pp:chatnote', function (m) { chat.add({ kind: 'sys', text: m && m.text }); });
    }
    function layoutChat() {
      var w = view.clientWidth;
      var h = view.clientHeight;
      if (!chat || !(w > 0 && h > 0)) return;
      var s = Math.hypot(w, h) / Math.hypot(1366, 768);
      var font = P.Hud.calcMult(w, h, 20, 30) * s;
      chat.el.style.setProperty('--dsc-t', Math.round(28 * s + 4 * font + 12 + (watchMode ? 44 : 4)) + 'px');
    }
    if (chat) {
      root.addEventListener('resize', layoutChat);
      layoutChat();
    }

    // ---- screens ----
    function setLive(live) {
      show(el.hint, live);
      show(el.cash, live);
      if (chat) chat.visible(live);
      if (!live) setHold(false);
    }

    function showOnly(screen) {
      page.screen = screen || null;
      show(el.connecting, screen === 'connecting');
      show(el.reconnecting, screen === 'reconnecting');
      if (!END_CARDS[screen]) hideEnd();
      refreshBoard();
    }

    function showConnecting(text, sub) {
      if (el.connectingText) el.connectingText.textContent = text;
      if (el.connectingSub) el.connectingSub.textContent = sub || '';
      showOnly('connecting');
    }

    // ---- end cards (DSEnd.show, the site's one card) ----
    // page.end holds what the card says (opts: verdict, hero, facts, ledger, status), its Play again (null on a
    // notice card: refused or disconnected, with only the way back) and the one note under the money (a restake
    // refusal or wait); every change redraws it. A card that closes a life (dead, cashed out, paid or free) has the
    // same three buttons as every game's (Owen 2026-10-16): Lobby, Spectate, Play again. Spectate is open when Lobby
    // is, except while a paid buy-in is still with the wallet (see onSpectateClick); Play again is shown even where
    // it cannot be pressed (a paid page with no lobby wallet to ask), disabled.
    function endCard() {
      var end = page.end;
      var o = {};
      for (var k in end.opts) if (Object.prototype.hasOwnProperty.call(end.opts, k)) o[k] = end.opts[k];
      o.notes = (end.opts.notes || []).concat(end.note ? [end.note] : []);
      var again_ = end.again || null;
      o.buttons = [{ id: 'lobby', text: 'Lobby', primary: !again_, disabled: page.lobbyLocked, onClick: onLobbyClick }];
      if (again_) {
        o.buttons.push({ id: 'spectate', text: 'Spectate', disabled: !spectateOpen(), onClick: onSpectateClick });
        o.buttons.push({ id: 'again', text: again_.text, primary: true, disabled: !again_.can || again_.disabled,
          onClick: onAgainClick });
      }
      return o;
    }

    function drawEnd() {
      if (page.end) DSEnd.show(endCard());
    }

    function hideEnd() {
      page.end = null;
      if (DSEnd.shown()) DSEnd.hide();
    }

    function endPhase(kind, end) {
      page.phase = 'end';
      setLive(false);
      cancel('giveUp');
      showOnly(kind);
      end.kind = kind;
      end.note = end.note || '';
      page.end = end;
      var card = DSEnd.show(endCard());
      // Keyboard focus lands on the card's action. A paid Play again is not a keyboard default (it opens a new
      // buy-in), so a paid card leaves the focus alone; a card with only the way back focuses it.
      var focusBtn = !end.again ? card.button('lobby') : (page.stake === 0 && end.again.can ? card.button('again') : null);
      if (focusBtn) {
        try { focusBtn.focus({ preventScroll: true }); } catch (_) {}
      }
    }

    // Play again as a fresh card offers it. A paid round is bought again through the lobby's wallet (duel:restake);
    // a page opened on its own has no wallet to ask, so its Play again cannot be pressed (can: false).
    function prepareAgain() {
      page.restaking = false;
      cancel('restake');
      page.lobbyLocked = false;
      return { can: !(page.stake > 0 && !framed), text: 'Play again', disabled: false };
    }

    // While a paid buy-in is with the lobby's wallet the way back is shut: the lobby clears
    // this frame on game:done (public/js/v2/play.js), so a token minted after that would go to
    // a blank frame, a stake with no seat. It opens again on the wallet's answer, or once
    // RESTAKE_WAIT_MS has passed with none (a late answer is still taken, see restakeSlow).
    function lockLobby(locked) {
      page.lobbyLocked = !!locked;
      drawEnd();
    }

    // The note under the money on the dead or cashed-out card ('' clears it).
    function restakeNote(text) {
      if (page.end && (page.end.kind === 'dead' || page.end.kind === 'cashed')) page.end.note = text || '';
    }

    function restakeSlow() {
      if (!page.restaking) return;
      if (page.end && page.end.again) page.end.again.text = 'Waiting for your wallet...';
      restakeNote('Your wallet has not answered yet. If you approved the stake, wait here: ' +
        'the round starts once it lands.');
      lockLobby(false);
    }

    function recordBest() {
      var me = game.player;
      if (!me) return 0;
      var pct = Math.max(me.bestPercent || 0, me.percent || 0) * 100;
      pct = Math.round(pct * 100) / 100;
      if (pct > page.roundBest) page.roundBest = pct;
      if (pct > best) {
        best = pct;
        saveBest(best);
      }
      return pct;
    }

    // The round's end, as this page saw it: the clock stops and the land at that moment is kept for the card.
    function endRound() {
      if (page.roundEndMs === null) page.roundEndMs = nowMs();
      var me = game.player;
      var land = me && !me.death ? (me.percent || 0) * 100 : 0;
      page.deathLand = Math.max(land, page.landNow);
      if (me && me.statistics && typeof me.statistics.kills === 'number') page.roundKills = me.statistics.kills;
    }

    // Time alive and the best leaderboard rank, when this page saw them (a page that never saw the round has none);
    // a paid card adds the round's best land as its score.
    function roundFacts(withScore) {
      var f = [];
      if (page.roundStartMs === null) return f;
      f.push(['Time', DSEnd.clock((page.roundEndMs !== null ? page.roundEndMs : nowMs()) - page.roundStartMs)]);
      if (page.bestRank > 0) f.push(['Top rank', DSEnd.ordinal(page.bestRank)]);
      if (withScore) f.push(['Best land', pctText(page.roundBest)]);
      // Kills (Owen 2026-10-16): the trails this square cut, as the server reported them
      if (page.roundKills !== null) f.push(['Kills', DSEnd.int(page.roundKills)]);
      return f;
    }

    function killerText(p) {
      if (p && p.killerId) return 'Killed by ' + (p.killerName || 'another player');
      return (p && REASON_TEXT[p.reason]) || 'Your square was destroyed';
    }

    // Share your score (2026-10-26): the free table's card only (a paid one never offers it), its own figure and facts.
    function freeShare() {
      if (page.stake > 0 || typeof DSEnd.share !== 'function') return null;
      return {
        onClick: function () {
          var o = page.end && page.end.opts;
          if (!o || page.stake > 0) return;
          DSEnd.share({ game: 'paper', hero: o.hero, unit: o.unit, facts: o.facts });
        }
      };
    }

    // Free: the land at death. Paid: the stake lost, from the server's own lostMicro.
    function showDead(p) {
      var opts;
      if (page.stake > 0) {
        opts = {
          tone: 'loss',
          verdict: killerText(p),
          hero: DSEnd.usd(-(Number(p && p.lostMicro) || 0)),
          unit: 'lost',
          facts: roundFacts(true)
        };
      } else {
        opts = { tone: 'plain', verdict: killerText(p), hero: pctText(page.deathLand), unit: 'land', facts: roundFacts(),
          share: freeShare() };
      }
      endPhase('dead', { opts: opts, again: prepareAgain() });
    }

    // Paid: the server's receipt (pp:cashedout grossMicro / cutMicro / netMicro, display only), then the payout's
    // own status (pp:paid, pp:payerror). Free: the best land this round.
    function showCashed(p) {
      var gross = Number(p && p.grossMicro) || 0;
      var cut = Number(p && p.cutMicro) || 0;
      var net_ = Number(p && p.netMicro) || 0;
      var opts;
      if (page.stake > 0 || gross > 0) {
        opts = {
          tone: 'win',
          verdict: 'Cashed out',
          hero: DSEnd.usd(net_),
          unit: 'to your wallet',
          facts: roundFacts(true),
          ledger: [['Cashed out', DSEnd.usd(gross)], ['House 10%', DSEnd.usd(-cut)], ['You receive', DSEnd.usd(net_)]],
          status: net_ > 0 ? { text: 'Sending to your wallet', state: 'pending' } : null
        };
      } else {
        opts = { tone: 'plain', verdict: 'Cashed out', hero: pctText(page.roundBest), unit: 'best land', facts: roundFacts(),
          share: freeShare() };
      }
      endPhase('cashed', { opts: opts, again: prepareAgain() });
    }

    function showGone(title, text) {
      tracked(function (t) { t.end({ result: 'ended', reason: 'disconnect' }); });
      endPhase('gone', { opts: { verdict: title, notes: [text] }, again: null });
    }

    function showRefused(p) {
      var text = p && Object.prototype.hasOwnProperty.call(REFUSED_TEXT, p.why) ? REFUSED_TEXT[p.why] : null;
      if (!text) text = (p && typeof p.text === 'string' && p.text) || 'The table did not let you in.';
      var notes = [text];
      if (p && p.refunded) notes.push('Your entry was refunded to your wallet.');
      endPhase('refused', { opts: { verdict: 'Could not join', notes: notes }, again: null });
    }

    // ---- joining ----
    function sendJoin(token) {
      var msg = { name: session.name, stake: page.stake };
      if (token) msg.entryToken = token;
      var bought = readPaidSkin(); // read again each time: a pass the lobby refreshed meanwhile is used
      if (bought) { msg.shop = bought.shop; msg.skinPass = bought.skinPass; }
      page.joinToken = page.stake > 0 && token ? token : null;
      markJoin();
      net.join(msg);
    }

    // Play again: free respawns on the same socket; paid buys a new entry through the lobby.
    // A socket that changed since the last seat has no stake on the server side, so it joins.
    function again(token) {
      showConnecting('Starting', 'A new round is on its way');
      page.phase = 'connecting';
      if (socket.id && socket.id === page.joinedSocketId) {
        page.joinToken = page.stake > 0 && token ? token : null;
        markJoin();
        net.respawn(token || undefined, readPaidSkin());
      } else {
        sendJoin(token || null);
      }
    }

    function onAgainClick() {
      var end = page.end;
      var a = end && end.again;
      if (!a || !a.can || a.disabled || page.phase !== 'end') return;
      if (page.stake > 0) {
        if (!framed || page.restaking) return;
        page.restaking = true;
        a.disabled = true;
        a.text = 'Confirm in your wallet...';
        restakeNote('');
        later('restake', restakeSlow, RESTAKE_WAIT_MS);
        page.restakeNonce = newNonce();
        try {
          root.parent.postMessage({ type: 'duel:restake', game: 'paper', stake: page.stake, nonce: page.restakeNonce }, '*');
        } catch (_) {
          page.restaking = false;
          cancel('restake');
          a.disabled = false;
          a.text = 'Play again';
          lockLobby(false);
          return;
        }
        lockLobby(true);
        return;
      }
      a.disabled = true;
      again(null);
    }

    function onLobbyClick(evt) {
      if (evt && typeof evt.preventDefault === 'function') evt.preventDefault();
      if (page.lobbyLocked) return;
      try { net.leave(); } catch (_) {}
      if (framed) {
        try { root.parent.postMessage('game:done', '*'); } catch (_) {}
      } else {
        root.location.href = '/';
      }
    }

    // Spectate is open when Lobby is, and also shut while a paid buy-in is with the wallet (page.restaking, which
    // outlasts the lock after RESTAKE_WAIT_MS): Lobby clears the frame, so a stake that lands late opens its round in
    // it (wallet-widget/src/restakeBridge.mjs relaunch), but this page would still be in the frame, watching, and a
    // late stake would have no seat to go to.
    function spectateOpen() {
      return !page.lobbyLocked && !page.restaking;
    }

    // The lobby's Spectate for this table's rung (public/js/v2/play.js spectate), from the card: every money key out,
    // dsWatch = 'paper', dsWatchStake for a paid table (its own key, never 'stake'), then the page the lobby opens,
    // which boots watching (readWatch). Watch mode is set up only at boot, so the page opens again rather than
    // switching in place. pp:leave first, as Lobby sends it. Nothing here touches money: the round is over.
    function onSpectateClick(evt) {
      if (evt && typeof evt.preventDefault === 'function') evt.preventDefault();
      if (!spectateOpen() || page.phase !== 'end' || !page.end || !page.end.again) return;
      var stake = page.stake > 0 ? page.stake : 0;
      try {
        var ss = root.sessionStorage;
        for (var i = 0; i < WATCH_MONEY_KEYS.length; i++) ss.removeItem(WATCH_MONEY_KEYS[i]);
        ss.setItem('dsWatch', 'paper');
        if (stake > 0) ss.setItem('dsWatchStake', String(stake));
        else ss.removeItem('dsWatchStake');
      } catch (_) {
        return; // no mark, no watching: the card stays as it is
      }
      try { net.leave(); } catch (_) {}
      var loc = root.location;
      if (loc && typeof loc.replace === 'function') loc.replace(WATCH_URL);
      else if (loc) loc.href = WATCH_URL;
    }

    // The lobby's answer to duel:restake (wallet-widget/src/main.jsx). Only the parent frame
    // may answer, only on this page's origin, and only to the request this page made (the
    // nonce: a wallet built before it answers without one); the fresh token goes straight into
    // pp:respawn and is never stored.
    root.addEventListener('message', function (e) {
      var d = e && e.data;
      if (!d || typeof d !== 'object' || !page.restaking) return;
      if (e.source !== root.parent) return;
      var here = root.location && root.location.origin;
      if (here && e.origin && e.origin !== here) return;
      if (d.nonce !== undefined && d.nonce !== page.restakeNonce) return;
      if (d.type === 'duel:restake:done' && typeof d.entryToken === 'string' && d.entryToken) {
        page.restaking = false;
        cancel('restake');
        page.lobbyLocked = false;
        again(d.entryToken);
      } else if (d.type === 'duel:restake:error') {
        page.restaking = false;
        cancel('restake');
        if (page.end && page.end.again) {
          page.end.again.disabled = false;
          page.end.again.text = 'Play again';
        }
        restakeNote(String(d.message || 'Stake failed'));
        lockLobby(false);
      }
    });

    // ---- hold: Q and the touch button ----
    function setHold(down) {
      down = !!down;
      if (down && (page.phase !== 'live' || !game.player || game.player.death)) return;
      if (page.holdDown === down) return;
      page.holdDown = down;
      game.setHold(down);
    }

    function isQ(evt) {
      return evt.code === 'KeyQ' || evt.key === 'q' || evt.key === 'Q' || evt.keyCode === 81;
    }

    root.addEventListener('keydown', function (evt) {
      if (isQ(evt)) {
        // The rule paperInput.js follows: keys typed while anything but the body has focus
        // belong to that element. A held key's auto-repeat is ignored.
        if (evt.repeat || evt.target !== doc.body) return;
        evt.preventDefault();
        setHold(true);
        return;
      }
      if (page.phase === 'end' && page.stake === 0 && (page.screen === 'dead' || page.screen === 'cashed') &&
          evt.target === doc.body && (evt.key === ' ' || evt.key === 'Enter')) {
        evt.preventDefault();
        onAgainClick();
      }
    });
    root.addEventListener('keyup', function (evt) {
      if (isQ(evt)) setHold(false);
    });
    root.addEventListener('blur', function () {
      setHold(false);
    });
    doc.addEventListener('visibilitychange', function () {
      if (doc.visibilityState !== 'visible') setHold(false);
    });

    if (el.cash) {
      el.cash.addEventListener('pointerdown', function (evt) {
        evt.preventDefault();
        setHold(true);
      });
      ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (name) {
        el.cash.addEventListener(name, function () {
          setHold(false);
        });
      });
      el.cash.addEventListener('contextmenu', function (evt) {
        evt.preventDefault();
      });
    }

    // Touch devices show the button from the first touch even when (pointer: coarse) misses them.
    root.addEventListener('touchstart', function () {
      doc.body.classList.add('pp-touch');
    }, { once: true, passive: true });

    // A held key needs focus: on load, and on the first pointer down.
    try { root.focus(); } catch (_) {}
    root.addEventListener('pointerdown', function () {
      try { root.focus(); } catch (_) {}
    }, { once: true });

    // ---- net ----
    net.on('joined', function (p) {
      page.joinToken = null;
      cancel('giveUp');
      cancel('dead');
      cancel('retry');
      hud.reset();
      page.phase = 'live';
      page.joinedSocketId = socket.id || null;
      if (typeof p.stake === 'number') page.stake = p.stake;
      page.holdDown = false;
      showOnly(null);
      setLive(true);
      if (el.hint) el.hint.innerHTML = game.paid ? 'Hold <b>Q</b> to cash out' : 'Hold <b>Q</b> to leave';
      if (el.cashLabel) el.cashLabel.innerHTML = game.paid ? 'CASH<br>OUT' : 'LEAVE';
      if (el.cash) el.cash.setAttribute('aria-label', game.paid ? 'Hold to cash out' : 'Hold to leave');
      page.roundEndMs = null;
      if (!p.resumed) {
        page.roundBest = 0;
        page.roundStartMs = nowMs();
        page.bestRank = 0;
        page.landNow = 0;
        page.deathLand = 0;
        page.roundKills = null;
        page.rankNow = 0;
        page.boardCount = 0;
        game.best = best || undefined;
      }
      // seated: a round (a resumed seat after a drop is the same one; a paid round's start is the server's)
      tracked(function (t) {
        if (page.stake > 0) t.set({ paid: true, stake: page.stake, mode: 'paid' });
        t.start();
      });
      if (page.stake > 0 && page.network === 'mainnet-beta' && !page.networkAsked) {
        page.networkAsked = true;
        fetch('/api/money-config').then(function (r) { return r.json(); }).then(function (c) {
          if (c && c.network) page.network = c.network;
        }).catch(function () {});
      }
      try { root.focus(); } catch (_) {}
    });

    net.on('pp:refused', function (p) {
      p = p || {};
      page.joinToken = null;
      if (p.why === 'warming' && page.phase === 'connecting') {
        // The free table's boot warm-up: no token is at stake, so ask again by itself.
        showConnecting('Getting the table ready', 'This takes a few seconds after the server starts');
        later('retry', function () {
          if (page.phase === 'connecting') sendJoin(null);
        }, Math.max(JOIN_RETRY_MIN_MS, Number(p.retryMs) || 0));
        return;
      }
      if (p.why === 'expired') {
        showGone('Disconnected', page.stake > 0 ? (p.text || 'Your square is gone. Your money dropped where you stood.')
          : 'Your square is gone.');
        return;
      }
      showRefused(p);
    });

    net.on('pp:dead', function (p) {
      recordBest();
      endRound();
      // the server's reasons 8 (away too long) and 9 (left the table) are a leave, the rest a death (REASON_TEXT)
      var gone = p && (p.reason === 8 || p.reason === 9);
      tracked(function (t) {
        t.end({ result: gone ? 'left' : 'died', reason: gone ? (p.reason === 8 ? 'disconnect' : 'leave') : undefined,
          score: Math.round(page.deathLand * 100) / 100, place: page.rankNow || undefined, players: page.boardCount || undefined });
      });
      page.phase = 'ending';
      setLive(false);
      cancel('giveUp');
      showOnly(null);
      // The stock follow-killer glide plays before the screen, as in solo.
      var wait = p && p.killerId ? config.enemyKillDelay : config.selfKillDelay;
      later('dead', function () {
        showDead(p);
      }, wait);
    });

    net.on('pp:cashedout', function (p) {
      recordBest();
      endRound();
      cancel('dead');
      showCashed(p || {});
      tracked(function (t) {
        t.end({ result: 'cashed_out', amount: (Number(p && p.netMicro) || 0) / 1e6, score: page.roundBest,
          place: page.rankNow || undefined, players: page.boardCount || undefined });
      });
    });

    // The payout's own status on the cash-out card (the card that is showing; a later card has none).
    function payStatus(status) {
      if (!page.end || page.end.kind !== 'cashed') return;
      page.end.opts.status = status;
      drawEnd();
    }

    net.on('pp:paid', function (p) {
      if (!p || typeof p.sig !== 'string') return;
      var q = page.network && page.network !== 'mainnet-beta' ? '?cluster=' + encodeURIComponent(page.network) : '';
      payStatus({
        text: 'Sent to your wallet.',
        state: 'ok',
        link: { href: 'https://solscan.io/tx/' + encodeURIComponent(p.sig) + q, text: 'View transaction' }
      });
    });

    net.on('pp:payerror', function (p) {
      payStatus({ text: (p && p.message) || 'Payout delayed. Your winnings are recorded and will be sent.', state: 'err' });
    });

    net.on('pp:replaced', function () {
      showGone('Disconnected', 'This seat was taken over by a newer connection.');
    });

    net.on('disconnect', function () {
      // Any hold is cancelled by the server at the disconnect and never resumed; the player
      // re-arms it with a fresh key press.
      setHold(false);
      if (!net.resuming) return; // not seated: nothing to take back
      showOnly('reconnecting');
      // A socket that never comes back: the seat is gone once its grace ends (up to 15 s for
      // socket.io to notice a silent loss, then DISCONNECT_GRACE_MS).
      later('giveUp', function () {
        if (net.resuming) {
          showGone('Disconnected', page.stake > 0 ? 'Connection lost. Your money dropped where you stood.'
            : 'Connection lost. Your square is gone.');
        }
      }, MP.DISCONNECT_GRACE_MS + 20000);
    });

    net.on('connect', function () {
      page.connects++;
      if (page.connects === 1 || page.phase !== 'connecting' || net.seated || !page.joinSent) return;
      // The pending join went out on THIS connection (flushed from socket.io's buffer just
      // before this event) or has not gone out yet: its answer comes on this link.
      if (page.joinOutDrop === null || page.joinOutDrop === page.drops) return;
      // The link dropped between a join (or respawn) and its answer, so no resumeKey ever
      // arrived. A free table simply asks again. A paid one asks again with the same entry
      // token: the server answers with the seat that token bought (taken back, nothing spent
      // twice), the refund it made when the link closed, or a first seat if the message never
      // arrived. Each answer clears the token, so it is re-sent only while none has come.
      if (page.stake === 0) {
        sendJoin(null);
        return;
      }
      if (page.joinToken) {
        showConnecting('Reconnecting', 'Getting your seat back');
        sendJoin(page.joinToken);
        return;
      }
      showGone('Disconnected', 'The connection dropped while you were joining. If your entry was taken, ' +
        'its money dropped where your square stood.');
    });

    // ---- watch mode (the lobby's Spectate) ----
    // Read-only: pp:watch instead of pp:join, never live, no Play, cash-out or hold control. The mirror follows
    // one square (game.follow / followNext / followPrev); the page shows the shared Spectate bar
    // (public/js/shared/dsWatchBar.js, Owen 2026-10-16: the same controls in every game): Lobby, previous, the
    // followed square's name and next. Until a table is shown it says it is finding a player, its arrows off, over
    // the connecting words; Lobby works from the start.
    var bar = watchMode ? root.DSWatchBar || null : null;

    // The stock HUD's sizes in CSS px (paperGame.js getRenderContext over devicePixelRatio; the render quality
    // cancels out): the bar's Lobby goes under the top-left score stack (score bar, BEST line, kills pill), where the
    // watch Lobby always was, and on a phone its arrows and name are lifted clear of the minimap disc (bottom right).
    function watchSizes() {
      var w = view.clientWidth;
      var h = view.clientHeight;
      if (!(w > 0 && h > 0)) return null;
      var s = Math.hypot(w, h) / Math.hypot(1366, 768);
      var font = P.Hud.calcMult(w, h, 20, 30) * s;
      return {
        // padding 16, bar 1.5 font, back 4, the BEST line (font + padding / 2), the kills pill (4 + 1.5 font)
        lobbyTop: Math.round(28 * s + 4 * font + 12),
        lift: Math.ceil(16 * s + w / P.Hud.calcMult(w, h, 8, 3) + 12) // the minimap and its padding, plus a gap
      };
    }

    function barOpen() {
      var z = watchSizes();
      bar.open({ game: 'paper', stake: watchOf ? watchOf.stake : 0, onPrev: onWatchPrev, onNext: onWatchNext,
        onLobby: onWatchLobby, phoneLift: z ? z.lift : 0 });
      var lobby = doc.querySelector('.dsw-lobby');
      if (lobby && z) lobby.style.top = z.lobbyTop + 'px';
    }

    function layoutWatch() {
      if (bar && page.watch && bar.shown()) barOpen();
    }

    // Finding a player, arrows off (from the start, and while the server says why there is no table to show).
    function barWait() {
      if (!bar) return;
      if (bar.shown()) bar.close();
      barOpen();
      bar.busy(true);
    }

    // The name shows only while a table is shown; a shown table with nobody alive on it is the empty table.
    function setFollowed(u) {
      if (!bar || !page.watch || !page.watchLive) return;
      if (u) bar.watching(unitName(u));
      else bar.empty();
    }

    function watchWait(text, sub) {
      page.watchLive = false;
      page.phase = 'connecting';
      if (chat) chat.visible(false);
      showConnecting(text, sub);
    }

    // Asks again every WATCH_RETRY_MS until a table's state is shown. While the link is down nothing is asked
    // (the net asks by itself on the next connection), so no pile of asks waits in socket.io's buffer.
    function armWatch() {
      later('watch', function () {
        if (!page.watch || page.watchLive) return;
        if (socket.connected === false) return armWatch();
        askWatch();
      }, WATCH_RETRY_MS);
    }

    function askWatch() {
      net.watchStake = watchOf ? watchOf.stake : 0;
      net.watch();
      armWatch();
    }

    function onWatchNext(evt) {
      if (evt && evt.preventDefault) evt.preventDefault();
      if (!page.watch || !page.watchLive || typeof game.followNext !== 'function') return;
      game.followNext();
    }

    function onWatchPrev(evt) {
      if (evt && evt.preventDefault) evt.preventDefault();
      if (!page.watch || !page.watchLive || typeof game.followPrev !== 'function') return;
      game.followPrev();
    }

    // net.leave() (pp:leave ends the watch on the server) and the existing way back (game:done, or '/').
    function onWatchLobby(evt) {
      page.watch = false;
      page.watchLive = false;
      cancel('watch');
      if (bar) bar.close();
      onLobbyClick(evt);
    }

    if (watchMode) {
      if (bar) {
        barWait();
        root.addEventListener('resize', layoutWatch);
      }
      game.onFollow = function (u) {
        setFollowed(u);
      };

      net.on('watching', function (p) {
        if (!page.watch) return;
        if (!p || p.none) {
          var text = (p && Object.prototype.hasOwnProperty.call(WATCH_TEXT, p.why) && WATCH_TEXT[p.why]) || WATCH_TEXT.nobody;
          watchWait(text, 'Checking again every few seconds');
          // Nobody at the table (a paid rung nobody is at; the free arena has bots from boot): the empty table, the
          // whole map behind the bar (Owen 2026-10-16). Any other reason keeps its words on show, the plate blank.
          if (bar) {
            if (!p || p.why === 'nobody' || p.why === 'closed') bar.empty();
            else barWait();
          }
          if (!page.timers.watch) armWatch();
          return;
        }
        cancel('watch');
        hud.reset();
        page.watchLive = true;
        page.phase = 'watch';
        tracked(function (t) {
          if (t.stage !== 'spectating') t.spectate();
        });
        showOnly(null);
        if (chat) chat.visible(true);
        layoutWatch();
        setFollowed(game.player || null);
      });

      // The server forgot this watcher with its socket; the net asks again on the next connection. The bar keeps
      // its plate (and Lobby) with the arrows off meanwhile.
      net.on('disconnect', function () {
        if (!page.watch) return;
        watchWait('Reconnecting...', 'Getting the table back');
        if (bar) bar.busy(true);
        armWatch();
      });
    }

    // ---- start ----
    showConnecting('Connecting', watchMode ? 'Finding a table to watch' : 'Finding you a table');
    var started = false;
    function start() {
      if (started) return;
      started = true;
      game.loop();
      if (watchMode) {
        askWatch(); // no pp:join, no token, no name
        return;
      }
      // One pp:join with the entry token, then the token leaves sessionStorage for good: a
      // reconnect proves the seat with its resumeKey (design 5.7). Until pp:joined or
      // pp:refused answers, page memory keeps it (page.joinToken) for the one case with no
      // resumeKey yet: the link dropping before the answer.
      var token = session.entryToken;
      session.entryToken = null;
      sendJoin(token);
      try { root.sessionStorage.removeItem('entryToken'); } catch (_) {}
    }
    // The HUD font should be in before the first drawn frame (never longer than two seconds).
    P.whenFontsReady(doc, P.hudPreloadText(language.strings, session.name) + '$', start);

    var api = {
      game: game,
      net: net,
      hud: hud,
      socket: socket,
      page: page,
      session: { name: session.name, stake: session.stake, region: session.region, paid: paidStake, watch: watchMode },
      lagMs: lagMs,
      setHold: setHold,
      // Watch mode, for checks: what the page shows now.
      watchState: function () {
        var u = page.watch ? game.player : null;
        return {
          watching: !!page.watch,
          live: !!page.watchLive,
          followId: u ? u.id : 0,
          followName: u ? unitName(u) : '',
          followDead: !!(u && u.death)
        };
      },
      next: onWatchNext,
      prev: onWatchPrev
    };
    P.arena = api;
    return api;
  }

  P && (P.arenaBoot = boot);
  boot();
})(typeof window !== 'undefined' ? window : globalThis);
