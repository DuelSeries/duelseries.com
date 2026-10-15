// DuelSeries layer on the frozen slither.io client: Spectate in the free room (the lobby's Spectate on slither.io's
// Free rung; server/sl/slSockets.js watchOf, slArenas.watch, slRoom seatWatch). Ours, not a parity area. Loaded by the
// /sl page after slxBr.js and before slxMain.js (server/sl/slBoot.js SLX_FILES): slxMain merges watchAuth into the
// handshake and its lobby-frame Play then simply plays, as a watcher.
//
// Inert unless slxNet installed the production transport, and a plain free page unless the lobby asked to watch: it
// writes sessionStorage 'dsWatch' = 'snake' before it opens /sl in the game frame. The mark is taken out at boot (a
// later launch is never a watch by mistake) and kept in this closure. A paid page (slxPaid), a page slxPaid holds and
// the battle royale's page (slxBr, which watches its own way) stay exactly as they are, mark or not.
//
// 1. The handshake: { watch: 1 }, plus after (the snake id watched last) for the life Next opens. The server follows
//    the leader (the longest living snake, bots included), or the snake ranked right after `after`.
// 2. Their client follows the watched snake as its own: mouse, touch, wheel and the boost, turn, Q and T keys on the
//    game are swallowed here (as slxBr does), so nothing on screen pretends to steer it, hold it or chat; the phone's
//    CASH OUT button is hidden.
// 3. While a life is on screen: Lobby (top left), 'Watching NAME' and Next (top centre; near the bottom on a phone held
//    upright, where their leaderboard fills the top). Next ends this life from the page (slx.endLife: their close runs
//    as for a drop) and the next life asks for the snake after this one.
// 4. Between lives (slxCard's hooks): the card says Watching, its button is Watch next and it has no length line; the
//    next life starts by itself AGAIN_MS after their menu shows (the leader after a death, the next one down after
//    Next). Nobody alive: 'Nobody to watch right now', asked again every RETRY_MS while the page is visible.
//
// Adds to DuelSlither.slx: watchAuth(), cardLines(kind), beforeAgain(go), watch { state(), next() }.
(function (root) {
  'use strict';
  var D = root.DuelSlither;
  if (!D || !D.slx || !D.slx.active) return;
  var slx = D.slx;
  var S = D.S;
  var doc = root.document;
  if (!S || !doc) return;

  var KEY = 'dsWatch';
  var mark = '';
  try {
    var ss = root.sessionStorage;
    mark = String((ss && ss.getItem(KEY)) || '');
    if (ss) ss.removeItem(KEY);
  } catch (e) {
    mark = '';
  }
  if (mark !== 'snake') return;
  if (slx.paid && slx.paid.on === true) return;
  if (typeof slx.paidHold === 'function' && slx.paidHold() === true) return;
  if (slx.br || typeof slx.brAuth === 'function') return;

  var AGAIN_MS = 900; // after their menu shows, as slxBr's watcher
  var RETRY_MS = 3000; // nobody to watch: the next ask
  var NAME_MAX = 24; // their name cap (law L45 nameMax)
  var WORDS = {
    title: 'Watching',
    again: 'Watch next',
    next: 'Next',
    lobby: 'Lobby',
    watching: 'Watching ',
    someone: 'a snake',
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
  var ended = ''; // how the last life ended: 'next', 'out' (the watched snake ended), 'lost'
  var lastName = '';
  var wasLife = false; // the last close ended a life on screen (else a refusal or a connect that failed)
  var switching = false;
  var gone = false; // Lobby was pressed
  var againTimer = null;
  var retryTimer = null;
  var errors = 0;

  function stopTimers() {
    if (againTimer !== null) root.clearTimeout(againTimer);
    if (retryTimer !== null) root.clearTimeout(retryTimer);
    againTimer = null;
    retryTimer = null;
  }

  // ---- 1. the handshake

  slx.watchAuth = function () {
    var a = { watch: 1 };
    if (after > 0) a.after = after;
    return a;
  };

  slx.on('open', function () {
    after = 0; // this socket's handshake carried it
    watching = null;
    ended = '';
    switching = false;
  });
  slx.on('x:watch', function (m) {
    if (typeof m.id !== 'number' || !(m.id > 0)) return;
    var name = typeof m.name === 'string' ? m.name.slice(0, NAME_MAX) : '';
    watching = { id: m.id, name: name };
    lastName = name;
    paint();
  });
  slx.on('ownDead', function () {
    if (!ended) ended = 'out';
  });
  slx.on('close', function (info) {
    var i = info || {};
    wasLife = !!i.playing;
    if (!i.opened) ended = 'lost';
    else if (!ended) ended = i.sawDead ? 'out' : 'lost';
    if (i.refused === 'nobody') retry();
  });

  // ---- 3. Next

  function next() {
    if (switching || !watching || !onScreen() || typeof slx.endLife !== 'function') return false;
    switching = true;
    ended = 'next';
    after = watching.id;
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
    }
    paint();
    return ok;
  }

  // ---- 4. between lives

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
      return { title: WORDS.title, lines: [line], again: WORDS.again, length: false };
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

  function onGame(e) {
    for (var el = e.target; el && el !== doc; el = el.parentNode) {
      if (typeof el.className === 'string' && /(^|\s)slx-/.test(el.className)) return false; // a layer control
    }
    return true;
  }
  function swallow(e) {
    if (!S.connected || !onGame(e)) return;
    e.stopImmediatePropagation();
    if (e.type === 'touchstart' || e.type === 'touchmove') e.preventDefault();
  }
  var types = ['mousemove', 'mousedown', 'touchstart', 'touchmove', 'wheel'];
  for (var t = 0; t < types.length; t++) root.addEventListener(types[t], swallow, { capture: true, passive: false });
  root.addEventListener('keydown', function (e) {
    if (!S.connected) return;
    var k = e.keyCode;
    // Space and the arrows (their boost and turns), Q (slxHold), T (slxChat: the server takes no line from a watcher)
    if (k === 32 || (k >= 37 && k <= 40) || k === 81 || k === 84) e.stopImmediatePropagation();
  }, true);

  // ---- 3. the controls (their classes are in public/css/slx.css)

  var body = doc.body;
  var lobbyBtn = null;
  var bar = null;
  var label = null;
  var nameEl = null;
  var nextBtn = null;
  if (body) {
    lobbyBtn = doc.createElement('button');
    lobbyBtn.className = 'slx-watch-lobby';
    lobbyBtn.type = 'button';
    lobbyBtn.textContent = WORDS.lobby;
    lobbyBtn.style.display = 'none';
    body.appendChild(lobbyBtn);
    bar = doc.createElement('div');
    bar.className = 'slx-watch-bar';
    bar.style.display = 'none';
    label = doc.createElement('span');
    label.className = 'slx-watch-label';
    label.appendChild(doc.createTextNode(WORDS.watching));
    nameEl = doc.createElement('b');
    label.appendChild(nameEl);
    bar.appendChild(label);
    nextBtn = doc.createElement('button');
    nextBtn.className = 'slx-watch-next';
    nextBtn.type = 'button';
    nextBtn.textContent = WORDS.next;
    bar.appendChild(nextBtn);
    body.appendChild(bar);
  }

  function toLobby() {
    gone = true;
    stopTimers();
    if (typeof slx.toLobby === 'function' && slx.toLobby()) return;
    try {
      root.location.assign('/');
    } catch (e) { /* nothing to do */ }
  }

  // slxMain (which defines guard) loads after this file: the buttons are bound once it exists
  var bound = false;
  function bind() {
    if (bound || !lobbyBtn) return;
    if (typeof slx.guard !== 'function') {
      root.setTimeout(bind, 50);
      return;
    }
    bound = true;
    slx.guard(lobbyBtn, { activate: toLobby });
    slx.guard(bar, {});
    slx.guard(nextBtn, { activate: next });
  }
  if (lobbyBtn) root.setTimeout(bind, 0);

  // A life on screen: playing, live, and not dying (their death hold and menu fade run with dead_mtm set).
  function onScreen() {
    return !!S.playing && !!S.connected && S.dead_mtm === -1 && !gone;
  }

  var holdBtn = null;
  function paint() {
    var show = onScreen();
    if (lobbyBtn) {
      var d = show ? 'block' : 'none';
      if (lobbyBtn.style.display !== d) lobbyBtn.style.display = d;
    }
    if (bar) {
      var b = show && watching ? 'flex' : 'none';
      if (bar.style.display !== b) bar.style.display = b;
      var name = watching && watching.name ? watching.name : WORDS.someone;
      if (nameEl.textContent !== name) nameEl.textContent = name;
      var off = switching || !watching;
      if (nextBtn.disabled !== off) nextBtn.disabled = off;
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
        ended: ended,
        switching: switching,
        shown: onScreen() && !!watching,
        retrying: retryTimer !== null,
        errors: errors
      };
    },
    next: next
  };
})(typeof window !== 'undefined' ? window : globalThis);
