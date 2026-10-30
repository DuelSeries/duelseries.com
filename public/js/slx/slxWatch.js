// DuelSeries layer on the frozen slither.io client: Spectate in the free room (the lobby's Spectate on slither.io's
// Free rung; server/sl/slSockets.js watchOf, slArenas.watch, slRoom seatWatch). Ours, not a parity area. Loaded by the
// /sl page after slxBr.js and before slxMain.js (server/sl/slBoot.js SLX_FILES): slxMain merges watchAuth into the
// handshake and its lobby-frame Play then simply plays, as a watcher.
//
// Inert unless slxNet installed the production transport, and a plain free page unless the lobby asked to watch: it
// writes sessionStorage 'dsWatch' = 'snake' (and 'dsWatchStake' for a paid rung) before it opens /sl in the game
// frame. The mark is taken out at boot (a
// later launch is never a watch by mistake) and kept in this closure. A paid page (slxPaid), a page slxPaid holds and
// the battle royale's page (slxBr, which watches its own way) stay exactly as they are, mark or not.
//
// 1. The handshake: { watch: 1 }, plus after (Next) or before (Previous), the snake id watched last, for the life the
//    switch opens. The server follows the leader (the longest living snake, bots included), or the snake ranked right
//    after `after` or right before `before`, wrapping round.
// 2. Their client follows the watched snake as its own: mouse, touch, wheel and the boost, turn, Q and T keys on the
//    game are swallowed here (as slxBr does), so nothing on screen pretends to steer it, hold it or chat; the phone's
//    CASH OUT button is hidden.
// 3. The controls are the Spectate bar every game shares (public/js/shared/dsWatchBar.js, loaded after the layer by
//    slBoot; Owen 2026-10-16): open from boot until Lobby, Lobby top left, previous, the watched name and next at the
//    bottom; the arrows are off while no life is on screen. Left is previous, Right and Space next. Nobody to follow
//    (a refused 'nobody': a paid rung nobody plays) is its empty table, the whole map, asked again every RETRY_MS.
// 4. A switch is instant: Previous or Next ends this life from the page (slx.endLife), and the moment their close has
//    run the next life starts (quick): no death hold, no menu, no card. A watched snake that dies stays on screen
//    DEATH_MS, then the leader is watched the same way. Only a dropped connection keeps the card (slxCard's hooks:
//    Watching, Watch next, no length line, a watcher's own card with no Spectate: slxCard's spectate: false; the next
//    life AGAIN_MS after their menu shows).
//
// Adds to DuelSlither.slx: watchOpen(rung) on every page (0 below); on a Spectate page watchAuth(), cardLines(kind),
// beforeAgain(go), watch { state(), next(), prev() }.
(function (root) {
  'use strict';
  var D = root.DuelSlither;
  if (!D || !D.slx || !D.slx.active) return;
  var slx = D.slx;
  var S = D.S;
  var doc = root.document;
  if (!S || !doc) return;

  var KEY = 'dsWatch';
  // The paid rung to watch (the lobby's Spectate on a $0.50 or $1 rung writes it beside the mark): sent as
  // watchStake, and the server watches that rung's busiest room, read only (slPaidArenas.watch). Taken out with it.
  var STAKE_KEY = 'dsWatchStake';
  var mark = '';
  var watchStake = 0;
  try {
    var ss = root.sessionStorage;
    mark = String((ss && ss.getItem(KEY)) || '');
    var ws = Number(ss && ss.getItem(STAKE_KEY));
    watchStake = isFinite(ws) && ws > 0 ? ws : 0;
    if (ss) ss.removeItem(KEY);
    if (ss) ss.removeItem(STAKE_KEY);
  } catch (e) {
    mark = '';
  }
  // 0. The card's Spectate (slxCard, Owen 2026-10-16: Lobby, Spectate and Play again on every death and cash-out), on
  //    every page: this page reopens watching as the lobby's Spectate opens it (public/js/v2/play.js spectate): the
  //    mark, the paid rung's own key or none, and /sl again in the same frame. Read only: it writes nothing else, never
  //    a seat or any money key. The lobby also clears its hand-off keys first; this page already took those out at
  //    boot (slxPaid its launch and its reload mark, slxBr its mark), and its own reload mark is written only while
  //    money is in, when the card's Spectate is refused (slxPaid beforeLobby). rung: the paid rung, else 0 (free).
  //    -> true once the page is on its way.
  var PAGE = '/sl'; // play.js WATCH_PAGE.snake
  slx.watchOpen = function (rung) {
    var s = Number(rung);
    try {
      var ss = root.sessionStorage;
      if (!ss) return false;
      ss.setItem(KEY, 'snake');
      if (isFinite(s) && s > 0) ss.setItem(STAKE_KEY, String(s));
      else ss.removeItem(STAKE_KEY);
    } catch (e) {
      return false; // no storage: the reopened page could only play, so it stays as it is
    }
    var loc = root.location;
    try {
      // in place of this page in the frame's history: Back never reopens the life that just ended
      if (loc && typeof loc.replace === 'function') loc.replace(PAGE);
      else loc.assign(PAGE);
      return true;
    } catch (e) {
      return false;
    }
  };

  if (mark !== 'snake') return;
  if (slx.paid && slx.paid.on === true) return;
  if (typeof slx.paidHold === 'function' && slx.paidHold() === true) return;
  if (slx.br || typeof slx.brAuth === 'function') return;

  var AGAIN_MS = 900; // after their menu shows (a dropped connection only), as slxBr's watcher
  var RETRY_MS = 3000;
  // The lobby draws /sl at 0.7 on phones (.sl07): the bar sits at the bottom (Owen 2026-10-28: "at the very bottom",
  // above the safe area) and stops left of their minimap (160 frame px wide, 16 in from the right), with buttons that
  // are still a thumb's size there (dsWatchBar phoneLift, phoneRight, phoneSize).
  var PHONE_LIFT = 12;
  var PHONE_RIGHT = 184;
  var PHONE_SIZE = 80; // nobody to watch: the next ask
  var DEATH_MS = 1200; // the watched snake's death on screen before the next life
  var NAME_MAX = 24; // their name cap (law L45 nameMax)
  var WORDS = {
    title: 'Watching',
    again: 'Watch next',
    finding: 'Finding the next snake.',
    out: ' is out. Watching the leader next.',
    outNobody: 'That snake is out. Watching the leader next.',
    dropped: 'The connection dropped. Watching again.',
    nobody: 'Nobody to watch right now',
    retrying: 'Trying again in a few seconds.',
    tryAgain: 'Try again',
    full: 'Too many people watching',
    fullLine: 'Try again in a minute.'
  };

  var watching = null; // { id, name } this life, from sl:x {t: 'watch'}
  var after = 0; // the id the next life asks to follow after (Next), 0 for the leader
  var before = 0; // the id the next life asks to follow before (Previous)
  var ended = ''; // how the last life ended: 'next' (Previous or Next), 'out' (the watched snake ended), 'lost'
  var lastName = '';
  var wasLife = false; // the last close ended a life on screen (else a refusal or a connect that failed)
  var switching = false;
  var empty = false; // the last ask was refused 'nobody' (the bar's empty table until a watch comes)
  var gone = false; // Lobby was pressed
  var againTimer = null;
  var retryTimer = null;
  var deathTimer = null;
  var quicks = 0;
  var errors = 0;

  function stopTimers() {
    if (againTimer !== null) root.clearTimeout(againTimer);
    if (retryTimer !== null) root.clearTimeout(retryTimer);
    if (deathTimer !== null) root.clearTimeout(deathTimer);
    againTimer = null;
    retryTimer = null;
    deathTimer = null;
  }

  // ---- 1. the handshake

  // Product tracking's base for a paid rung's Spectate (slxTrack); the free room's needs none.
  if (watchStake > 0) slx.trackBase = function () { return { paid: true, stake: watchStake, mode: 'paid' }; };

  slx.watchAuth = function () {
    var a = { watch: 1 };
    if (watchStake > 0) a.watchStake = watchStake;
    if (after > 0) a.after = after;
    else if (before > 0) a.before = before;
    return a;
  };

  slx.on('open', function () {
    after = 0; // this socket's handshake carried them
    before = 0;
    watching = null;
    ended = '';
    switching = false;
  });
  slx.on('x:watch', function (m) {
    if (typeof m.id !== 'number' || !(m.id > 0)) return;
    empty = false;
    var name = typeof m.name === 'string' ? m.name.slice(0, NAME_MAX) : '';
    watching = { id: m.id, name: name };
    lastName = name;
    paint();
  });
  // The watched snake ended: its death plays for DEATH_MS, then this life ends from the page and the next starts at
  // once (the leader: the dead snake is no longer on the board).
  slx.on('ownDead', function () {
    if (!ended) ended = 'out';
    if (deathTimer !== null) root.clearTimeout(deathTimer);
    deathTimer = root.setTimeout(function () {
      deathTimer = null;
      if (gone || typeof slx.endLife !== 'function') return;
      try {
        slx.endLife();
      } catch (e) {
        errors++;
      }
    }, DEATH_MS);
  });
  slx.on('close', function (info) {
    var i = info || {};
    wasLife = !!i.playing;
    if (deathTimer !== null) root.clearTimeout(deathTimer);
    deathTimer = null;
    if (!i.opened) ended = 'lost';
    else if (!ended) ended = i.sawDead ? 'out' : 'lost';
    if (i.refused === 'nobody') {
      empty = true;
      retry();
    } else if (i.refused && empty) {
      // refused for another reason (full, closed) after an empty table: no retry is armed, so the empty map goes and
      // the card's own words and Try again show; the bar opens again on its next paint, 'Finding a player'
      empty = false;
      if (root.DSWatchBar && root.DSWatchBar.shown()) root.DSWatchBar.close();
    }
    if (wasLife && (ended === 'next' || ended === 'out')) quick();
  });

  // ---- 4. the next life at once
  // Their close runs right after this layer's 'close' (slxNet closeLife) and starts their death hold (dead_mtm set);
  // their menu would show 1600 ms later and their loop connects a Play only once its fade has ended (slLoop step 3).
  // A watcher's switch has no death of its own to show: once their close has run, dead_mtm goes back to -1 and their
  // Play is asked, so their next frame connects. Their start fade then ends at its first step (login_fr is still 1),
  // which takes the card away if one was up. Not once their menu has shown: the card's way then. The one write this
  // layer makes to their state beyond 15.1 (test/slxSurface.test.js QUICK_FILES).
  var menuUp = false;
  slx.on('menuShow', function () { menuUp = true; });
  slx.on('open', function () { menuUp = false; });
  function quick() {
    root.setTimeout(function () {
      if (gone || menuUp || S.connected) return;
      var m = D.slMain;
      if (S.dead_mtm !== -1) S.dead_mtm = -1;
      quicks++;
      D.play(m && typeof m.nick === 'string' ? m.nick : '');
    }, 0);
  }

  // ---- 3. Previous and Next

  function step(d) {
    if (switching || !watching || !onScreen() || typeof slx.endLife !== 'function') return false;
    switching = true;
    ended = 'next';
    after = d > 0 ? watching.id : 0;
    before = d < 0 ? watching.id : 0;
    var ok = false;
    try {
      ok = slx.endLife() === true;
    } catch (e) {
      errors++;
    }
    if (!ok) {
      switching = false;
      ended = '';
      after = 0;
      before = 0;
    }
    paint();
    return ok;
  }
  function next() { return step(1); }
  function prev() { return step(-1); }

  // ---- between lives (a dropped connection, a refusal)

  function playAgain() {
    if (gone) return;
    var c = slx.card;
    if (c && typeof c.playAgain === 'function') c.playAgain();
  }

  function retry() {
    if (retryTimer !== null) root.clearTimeout(retryTimer);
    retryTimer = root.setTimeout(function ask() {
      retryTimer = null;
      if (gone) return;
      if (doc.hidden) {
        retryTimer = root.setTimeout(ask, RETRY_MS);
        return;
      }
      playAgain();
    }, RETRY_MS);
  }

  slx.cardLines = function (kind) {
    if (kind === 'nobody') return { title: WORDS.nobody, lines: [WORDS.retrying], again: WORDS.tryAgain, length: false };
    if (kind === 'full') return { title: WORDS.full, lines: [WORDS.fullLine], again: WORDS.tryAgain, length: false };
    // a connect that failed keeps the card's own words (Connection lost, Try again): nothing starts by itself then
    if (!wasLife) return null;
    if (kind === 'dead' || kind === 'cashed' || kind === 'lost' || kind === 'slow') {
      var line = ended === 'next' ? WORDS.finding
        : ended === 'out' ? (lastName ? lastName + WORDS.out : WORDS.outNobody) : WORDS.dropped;
      return { title: WORDS.title, lines: [line], again: WORDS.again, length: false, spectate: false };
    }
    return null;
  };

  slx.beforeAgain = function (go) {
    stopTimers();
    go();
    return true;
  };

  // The next life starts by itself once their menu shows (the card's own button does the same, sooner).
  slx.on('menuShow', function () {
    if (gone) return;
    if (againTimer !== null) root.clearTimeout(againTimer);
    againTimer = root.setTimeout(function () {
      againTimer = null;
      playAgain();
    }, AGAIN_MS);
  });

  // ---- 2. nothing on the game steers the watched snake

  // 'slx' for a layer control (the results card is marked slx-card), 'dsw' for the Spectate bar, '' for the game.
  function controlOf(e) {
    // the page itself is never a control (the bar marks the body dsw-on)
    for (var el = e.target; el && el !== doc && el !== doc.body; el = el.parentNode) {
      var c = el.className;
      if (typeof c !== 'string') continue; // an svg node inside a button: its button says
      if (/(^|\s)dsw-/.test(c)) return 'dsw';
      if (/(^|\s)slx-/.test(c)) return 'slx';
    }
    return '';
  }
  function swallow(e) {
    if (!S.connected) return;
    var c = controlOf(e);
    if (c === 'slx') return;
    e.stopImmediatePropagation();
    // A press on the bar is the bar's: nothing after this listener hears it (slxTouch would take a tap on it as a
    // steering touch and prevent it), and it is never prevented here, so a tap still becomes a click.
    if (c === '' && (e.type === 'touchstart' || e.type === 'touchmove')) e.preventDefault();
  }
  var types = ['mousemove', 'mousedown', 'touchstart', 'touchmove', 'wheel'];
  for (var t = 0; t < types.length; t++) root.addEventListener(types[t], swallow, { capture: true, passive: false });
  // The bar's keys (Left, Right, Space) go on to the bar's own listener, which stops them before the game.
  function barKey(e) {
    var B = bar();
    if (!B || !B.shown() || e.ctrlKey || e.metaKey || e.altKey) return false;
    return e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === ' ' || e.key === 'Spacebar';
  }
  root.addEventListener('keydown', function (e) {
    if (!S.connected || barKey(e)) return;
    var k = e.keyCode;
    // Space and the arrows (their boost and turns), Q (slxHold), T (slxChat: the server takes no line from a watcher)
    if (k === 32 || (k >= 37 && k <= 40) || k === 81 || k === 84) e.stopImmediatePropagation();
  }, true);

  // ---- 3. the bar

  function toLobby() {
    gone = true;
    stopTimers();
    paint();
    if (typeof slx.toLobby === 'function' && slx.toLobby()) return;
    try {
      root.location.assign('/');
    } catch (e) { /* nothing to do */ }
  }

  function bar() {
    var B = root.DSWatchBar;
    return B && typeof B.open === 'function' ? B : null;
  }

  // A life on screen: playing, live, and not dying (their death hold and menu fade run with dead_mtm set).
  function onScreen() {
    return !!S.playing && !!S.connected && S.dead_mtm === -1 && !gone;
  }

  var opened = false;
  var named = null; // the watching record the plate shows
  var holdBtn = null;
  function paint() {
    var B = bar();
    if (B) {
      if (gone) {
        if (B.shown()) B.close();
      } else {
        if (!opened || !B.shown()) {
          opened = B.open({ game: 'snake', stake: watchStake, onPrev: prev, onNext: next, onLobby: toLobby,
            phoneLift: PHONE_LIFT, phoneRight: PHONE_RIGHT, phoneSize: PHONE_SIZE }) === true;
          named = null;
        }
        if (opened) {
          var s = B.state();
          if (empty) {
            if (!s.empty) B.empty();
            named = null;
          } else if (watching && named !== watching) {
            named = watching;
            B.watching(watching.name);
          }
          var off = !empty && (switching || !watching || !onScreen());
          if (!empty && B.state().busy !== off) B.busy(off);
        }
      }
    }
    // the phone's CASH OUT button (slxHold): a watcher holds nothing
    if (!holdBtn && typeof doc.querySelector === 'function') holdBtn = doc.querySelector('.slx-hold');
    if (holdBtn && holdBtn.style.visibility !== 'hidden') holdBtn.style.visibility = 'hidden';
  }

  function frame() {
    root.requestAnimationFrame(frame);
    try {
      paint();
    } catch (e) {
      errors++;
      slx.errors = (slx.errors || 0) + 1;
    }
  }
  if (typeof root.requestAnimationFrame === 'function') root.requestAnimationFrame(frame);

  slx.watch = {
    // For headless checks and the console: what this page is watching now.
    state: function () {
      return {
        on: true,
        id: watching ? watching.id : 0,
        name: watching ? watching.name : '',
        after: after,
        before: before,
        ended: ended,
        switching: switching,
        shown: onScreen() && !!watching,
        empty: empty,
        retrying: retryTimer !== null,
        quicks: quicks,
        errors: errors
      };
    },
    next: next,
    prev: prev
  };
})(typeof window !== 'undefined' ? window : globalThis);
