// Paper multiplayer: the arena page's boot and shell (design 8.5). It builds the mirror game the
// way paperMain.js builds the solo one (same config, languages, skin manager and fonts), wires
// the net layer to the page's socket, and owns the DOM around the canvas: the connecting and
// warming layer, the reconnect veil, the four end screens (refused, dead, cashed out,
// disconnected), the Q key and the touch hold button, and the analytics. The live game has NO
// leave control: "Back to the lobby" is on the end screens only.
// Test-only: ?lag=N delays every socket event by N ms each way (so ?lag=50 is a 100 ms round
// trip); off by default.
(function (root) {
  'use strict';
  var doc = root.document;
  var P = root.DuelPaperLib;

  var BEST_KEY = 'duelseries.paper.arena.best'; // the solo page keeps its own best
  var JOIN_RETRY_MIN_MS = 1100; // the server takes one pp:join per 1000 ms per socket
  var MAX_LAG_MS = 2000;
  var RESTAKE_WAIT_MS = 120000; // public/js/game.js requestRestake's safety window
  // The refused screen's own words per reason (server paperSockets.js TEXT, minus its refund
  // sentence): the refund line is shown only when the refusal says refunded (design 8.5).
  var REFUSED_TEXT = {
    'bad-stake': 'That table does not exist.',
    'not-open': 'Paid Paper tables are not open yet.',
    maintenance: 'DuelSeries is updating. Try again in a few minutes.',
    full: 'Every Paper table at this stake is full.',
    entry: 'Entry fee not verified.',
    'seat-failed': 'Could not seat you.',
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

  function money(micro) {
    return '$' + (Math.max(0, Number(micro) || 0) / 1e6).toFixed(2);
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

  // The keys the lobby's wallet widget writes before it opens this page (read once).
  function readSession() {
    var stake = Number(storageGet('sessionStorage', 'stake'));
    return {
      name: (storageGet('sessionStorage', 'playerName') || '').slice(0, 20),
      stake: isFinite(stake) && stake > 0 ? stake : 0,
      entryToken: storageGet('sessionStorage', 'entryToken') || null,
      walletAddress: storageGet('sessionStorage', 'walletAddress') || null,
      region: storageGet('sessionStorage', 'region') || null
    };
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
    if (!P || typeof Path2D === 'undefined' || typeof root.io !== 'function' || !P.Mirror || !P.Net || !P.Hud ||
        !P.MP) {
      show($('pp-connecting'), false);
      show($('pp-unsupported'), true);
      return null;
    }
    var MP = P.MP;
    var session = readSession();
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

    // ---- DOM ----
    var el = {
      connecting: $('pp-connecting'),
      connectingText: $('pp-connecting-text'),
      connectingSub: $('pp-connecting-sub'),
      reconnecting: $('pp-reconnecting'),
      refused: $('pp-refused'),
      dead: $('pp-dead'),
      cashed: $('pp-cashed'),
      gone: $('pp-gone'),
      hint: $('pp-hint'),
      cash: $('pp-cash'),
      cashFill: $('pp-cash-fill'),
      cashLabel: $('pp-cash-label')
    };
    var END_SCREENS = [el.refused, el.dead, el.cashed, el.gone];
    var RING_C = 2 * Math.PI * 32;
    if (el.cashFill) {
      el.cashFill.style.strokeDasharray = String(RING_C);
      el.cashFill.style.strokeDashoffset = String(RING_C);
    }

    var page = {
      phase: 'connecting', // connecting | live | ending | end
      stake: session.stake,
      screen: null,
      joinedSocketId: null,
      holdDown: false,
      timers: {},
      restaking: false,
      lobbyLocked: false,
      network: 'mainnet-beta',
      networkAsked: false,
      connects: 0,
      drops: 0,
      joinSent: false,
      joinOutDrop: null,
      roundBest: 0
    };

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
    var game = P.Mirror.create({
      view: view,
      controller: new P.InputController(view),
      net: net,
      hud: hud,
      config: config,
      skinManager: skinManager,
      language: language.strings
    });
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
      } catch (err) {
        if (renderFaults++ < 3 && root.console) root.console.error('[PAPER] render', err);
      }
    };
    var best = loadBest();
    game.best = best || undefined;

    // ---- screens ----
    function setLive(live) {
      show(el.hint, live);
      show(el.cash, live);
      if (!live) setHold(false);
    }

    function showOnly(screen) {
      page.screen = screen;
      show(el.connecting, screen === el.connecting);
      show(el.reconnecting, screen === el.reconnecting);
      for (var i = 0; i < END_SCREENS.length; i++) show(END_SCREENS[i], END_SCREENS[i] === screen);
      // Keyboard focus lands on the screen's action. A paid Play again is not a keyboard
      // default (it opens a new buy-in), so a paid end screen leaves the focus alone.
      var focusBtn = null;
      if (screen && screen.querySelector && END_SCREENS.indexOf(screen) >= 0) {
        var again_ = screen.querySelector('.pp-again');
        if (!again_) focusBtn = screen.querySelector('.pp-lobby');
        else if (page.stake === 0 && !again_.hidden) focusBtn = again_;
      }
      if (focusBtn) {
        try { focusBtn.focus({ preventScroll: true }); } catch (_) {}
      }
    }

    function showConnecting(text, sub) {
      if (el.connectingText) el.connectingText.textContent = text;
      if (el.connectingSub) el.connectingSub.textContent = sub || '';
      showOnly(el.connecting);
    }

    function endPhase(screen) {
      page.phase = 'end';
      setLive(false);
      cancel('giveUp');
      showOnly(screen);
    }

    function setText(id, text) {
      var n = $(id);
      if (n) n.textContent = text == null ? '' : text;
    }

    function note(id, text) {
      var n = $(id);
      if (!n) return;
      n.textContent = text || '';
      n.hidden = !text;
    }

    function prepareAgain(screen) {
      var btn = screen.querySelector('.pp-again');
      if (!btn) return;
      // A paid round is bought again through the lobby's wallet (duel:restake); a page opened on
      // its own has no wallet to ask, so it offers only the way back.
      btn.hidden = page.stake > 0 && !framed;
      btn.disabled = false;
      btn.textContent = 'Play again';
      page.restaking = false;
      cancel('restake');
      lockLobby(false);
    }

    // While a paid buy-in is with the lobby's wallet the way back is shut: the lobby clears
    // this frame on game:done (public/js/v2/play.js), so a token minted after that would go to
    // a blank frame, a stake with no seat. It opens again on the wallet's answer, or once
    // RESTAKE_WAIT_MS has passed with none (a late answer is still taken, see restakeSlow).
    function lockLobby(locked) {
      page.lobbyLocked = !!locked;
      Array.prototype.forEach.call(doc.querySelectorAll('.pp-lobby'), function (b) {
        b.disabled = !!locked;
      });
    }

    function restakeError(text) {
      var screen = page.screen;
      if (screen === el.dead) note('pp-dead-error', text);
      else if (screen === el.cashed) note('pp-cashed-error', text);
    }

    function restakeSlow() {
      if (!page.restaking) return;
      lockLobby(false);
      var btn = page.screen && page.screen.querySelector ? page.screen.querySelector('.pp-again') : null;
      if (btn) btn.textContent = 'Waiting for your wallet...';
      restakeError('Your wallet has not answered yet. If you approved the stake, wait here: ' +
        'the round starts once it lands.');
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

    function killerText(p) {
      if (p && p.killerId) return 'Killed by ' + (p.killerName || 'another player');
      return (p && REASON_TEXT[p.reason]) || 'Your square was destroyed';
    }

    function showDead(p) {
      var me = game.player;
      var pct = me ? Math.round((me.percent || 0) * 10000) / 100 : 0;
      var lost = Number(p && p.lostMicro) || 0;
      if (page.stake > 0) {
        setText('pp-dead-title', 'You lost');
        setText('pp-dead-big', money(lost));
        setText('pp-dead-line', killerText(p));
      } else {
        setText('pp-dead-title', killerText(p));
        setText('pp-dead-big', pct.toFixed(2) + '%');
        setText('pp-dead-line', 'Best this round ' + page.roundBest.toFixed(2) + '%');
      }
      note('pp-dead-error', '');
      prepareAgain(el.dead);
      endPhase(el.dead);
    }

    function showCashed(p) {
      var gross = Number(p && p.grossMicro) || 0;
      var cut = Number(p && p.cutMicro) || 0;
      var net_ = Number(p && p.netMicro) || 0;
      var paidRound = page.stake > 0 || gross > 0;
      if (paidRound) {
        setText('pp-cashed-title', 'Cashed out');
        setText('pp-cashed-big', money(net_));
        setText('pp-gross', money(gross));
        setText('pp-cut', '-' + money(cut));
        setText('pp-net', money(net_));
        show($('pp-receipt'), true);
        note('pp-pay-status', net_ > 0 ? 'Sending to your wallet...' : '');
      } else {
        setText('pp-cashed-title', 'You left the table');
        setText('pp-cashed-big', page.roundBest.toFixed(2) + '%');
        show($('pp-receipt'), false);
        note('pp-pay-status', 'Best land this round');
      }
      note('pp-cashed-error', '');
      prepareAgain(el.cashed);
      endPhase(el.cashed);
    }

    function showGone(title, text) {
      setText('pp-gone-title', title);
      setText('pp-gone-text', text);
      endPhase(el.gone);
    }

    function showRefused(p) {
      var text = p && Object.prototype.hasOwnProperty.call(REFUSED_TEXT, p.why) ? REFUSED_TEXT[p.why] : null;
      if (!text) text = (p && typeof p.text === 'string' && p.text) || 'The table did not let you in.';
      setText('pp-refused-text', text);
      show($('pp-refused-refund'), !!(p && p.refunded));
      endPhase(el.refused);
    }

    // ---- joining ----
    function sendJoin(token) {
      var msg = { name: session.name, stake: page.stake };
      if (token) msg.entryToken = token;
      markJoin();
      net.join(msg);
    }

    // Play again: free respawns on the same socket; paid buys a new entry through the lobby.
    // A socket that changed since the last seat has no stake on the server side, so it joins.
    function again(token) {
      showConnecting('Starting', 'A new round is on its way');
      page.phase = 'connecting';
      if (socket.id && socket.id === page.joinedSocketId) {
        markJoin();
        net.respawn(token || undefined);
      } else {
        sendJoin(token || null);
      }
    }

    function onAgainClick(evt) {
      evt.preventDefault();
      var btn = evt.currentTarget;
      if (btn.disabled || page.phase !== 'end') return;
      if (page.stake > 0) {
        if (!framed || page.restaking) return;
        page.restaking = true;
        btn.disabled = true;
        btn.textContent = 'Confirm in your wallet...';
        restakeError('');
        lockLobby(true);
        later('restake', restakeSlow, RESTAKE_WAIT_MS);
        try {
          root.parent.postMessage({ type: 'duel:restake', game: 'paper', stake: page.stake }, '*');
        } catch (_) {
          page.restaking = false;
          cancel('restake');
          lockLobby(false);
          btn.disabled = false;
          btn.textContent = 'Play again';
        }
        return;
      }
      btn.disabled = true;
      again(null);
    }

    function onLobbyClick(evt) {
      evt.preventDefault();
      if (page.lobbyLocked || (evt.currentTarget && evt.currentTarget.disabled)) return;
      try { net.leave(); } catch (_) {}
      if (framed) {
        try { root.parent.postMessage('game:done', '*'); } catch (_) {}
      } else {
        root.location.href = '/';
      }
    }

    Array.prototype.forEach.call(doc.querySelectorAll('.pp-again'), function (b) {
      b.addEventListener('click', onAgainClick);
    });
    Array.prototype.forEach.call(doc.querySelectorAll('.pp-lobby'), function (b) {
      b.addEventListener('click', onLobbyClick);
    });

    // The lobby's answer to duel:restake (wallet-widget/src/main.jsx). Only the parent frame
    // may answer; the fresh token goes straight into pp:respawn and is never stored.
    root.addEventListener('message', function (e) {
      var d = e && e.data;
      if (!d || typeof d !== 'object' || !page.restaking) return;
      if (e.source !== root.parent) return;
      if (d.type === 'duel:restake:done' && typeof d.entryToken === 'string' && d.entryToken) {
        page.restaking = false;
        cancel('restake');
        lockLobby(false);
        again(d.entryToken);
      } else if (d.type === 'duel:restake:error') {
        page.restaking = false;
        cancel('restake');
        lockLobby(false);
        var screen = page.screen;
        if (screen && screen.querySelector) {
          var btn = screen.querySelector('.pp-again');
          if (btn) {
            btn.disabled = false;
            btn.textContent = 'Play again';
          }
        }
        restakeError(String(d.message || 'Stake failed'));
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
      if (page.phase === 'end' && page.stake === 0 && (page.screen === el.dead || page.screen === el.cashed) &&
          evt.target === doc.body && (evt.key === ' ' || evt.key === 'Enter')) {
        evt.preventDefault();
        var btn = page.screen.querySelector('.pp-again');
        if (btn && !btn.disabled && !btn.hidden) btn.click();
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
      if (!p.resumed) {
        page.roundBest = 0;
        game.best = best || undefined;
        if (root.phEvent) root.phEvent('game_started', { game: 'paper', stake: page.stake });
      }
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
      cancel('dead');
      showCashed(p || {});
      if (root.phEvent) {
        root.phEvent('cashed_out', { game: 'paper', amount: (Number(p && p.netMicro) || 0) / 1e6, stake: page.stake });
      }
    });

    net.on('pp:paid', function (p) {
      var n = $('pp-pay-status');
      if (!n || !p || typeof p.sig !== 'string') return;
      var q = page.network && page.network !== 'mainnet-beta' ? '?cluster=' + encodeURIComponent(page.network) : '';
      n.textContent = 'Sent to your wallet. ';
      var a = doc.createElement('a');
      a.href = 'https://solscan.io/tx/' + encodeURIComponent(p.sig) + q;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = 'View transaction';
      n.appendChild(a);
      n.hidden = false;
    });

    net.on('pp:payerror', function (p) {
      note('pp-pay-status', (p && p.message) || 'Payout delayed. Your winnings are recorded and will be sent.');
    });

    net.on('pp:replaced', function () {
      showGone('Disconnected', 'This seat was taken over by a newer connection.');
    });

    net.on('disconnect', function () {
      // Any hold is cancelled by the server at the disconnect and never resumed; the player
      // re-arms it with a fresh key press.
      setHold(false);
      if (!net.resuming) return; // not seated: nothing to take back
      showOnly(el.reconnecting);
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
      // arrived. A free table simply asks again; a paid entry token went out with that one
      // message and is never sent twice (design 5.7), so the page says what may have happened.
      if (page.stake === 0) {
        sendJoin(null);
        return;
      }
      showGone('Disconnected', 'The connection dropped while you were joining. If your entry was taken, ' +
        'its money dropped where your square stood.');
    });

    // ---- start ----
    showConnecting('Connecting', 'Finding you a table');
    var started = false;
    function start() {
      if (started) return;
      started = true;
      game.loop();
      // One pp:join with the entry token, then the token leaves sessionStorage for good: a
      // reconnect proves the seat with its resumeKey, never with a token (design 5.7).
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
      session: { name: session.name, stake: session.stake, region: session.region, paid: paidStake },
      lagMs: lagMs,
      setHold: setHold
    };
    P.arena = api;
    return api;
  }

  P && (P.arenaBoot = boot);
  boot();
})(typeof window !== 'undefined' ? window : globalThis);
