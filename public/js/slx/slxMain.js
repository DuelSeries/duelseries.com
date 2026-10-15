// DuelSeries layer on the frozen slither.io client: boot (SERVER-DESIGN 3.2, 15.1, 15.3, 15.5; task T16). Ours, not a
// parity area. Runs once, right after slxNet.js, while the frozen client has already booted (slMain.js boots at
// load) and before any Play.
//
// Inert unless slxNet installed the production transport (15.2, finalize pass C20).
//
// 1. Their menu hooks (slLoop.hooks onMenuShow, onMenuFade, onMenuDone, "ours to fill", public/js/sl/slLoop.js:748-756,
//    called by slHud.oefFades and loginFade) are relayed to layer observers as 'menuShow', 'menuFade' (fr) and
//    'menuDone', so several layer files can follow their menu without replacing each other's hook.
// 2. Phones get the computer look (Owen Q8): S.render_mode = 2, written once here, before any Play. Their client set
//    it from is_mobile at boot (public/js/sl/slApply.js:134); their automatic switch to the lighter look below 25 fps
//    stays (slLoop.js:564-575).
// 3. The skin for the handshake (15.5): the lobby's Customize bar stores the cv in localStorage 'duel.sl.skin'; it
//    goes to the server as auth.cv at every connect (slxNet withAuth). The server checks it against the shipped skin
//    set and picks a plain colour otherwise (server/sl/slSockets.js skinOf), so a bad value here costs nothing.
// 4. The lobby hand-off: inside the lobby's game frame (public/js/v2/play.js OWN_PAGE opens game pages in
//    #game-frame and writes the name to sessionStorage 'playerName' first) the page plays at once under the lobby
//    name, as agar's lobby frame does (public/js/ag/agLobby.js startFromLobby). Outside it, slxDirect shows a name
//    box and Play. A paid page (slxPaid, PAID-SL-DESIGN 9) plays the same way; a page slxPaid holds does not.
//
// Adds to DuelSlither.slx: framed, inLobby, lobbyName(), toLobby(), skin(), guard(el, opts).
(function (root) {
  'use strict';
  var D = root.DuelSlither;
  if (!D || !D.slx || !D.slx.active) return;
  var slx = D.slx;
  var S = D.S;
  if (!S) return;

  // ---- 1. menu hooks
  var hooks = D.slLoop && D.slLoop.hooks;
  if (hooks) {
    var relay = function (hook, name) {
      var own = hooks[hook];
      hooks[hook] = function (arg) {
        if (typeof own === 'function') own(arg);
        slx.fire(name, arg);
      };
    };
    relay('onMenuShow', 'menuShow');
    relay('onMenuFade', 'menuFade');
    relay('onMenuDone', 'menuDone');
  }

  // ---- 2. the computer look on phones (Owen Q8)
  if (S.is_mobile) S.render_mode = 2;

  // ---- 3. the skin cv for the handshake
  var SKIN_KEY = 'duel.sl.skin';
  function read(store, key) {
    try {
      return (store && store.getItem(key)) || '';
    } catch (e) {
      return '';
    }
  }
  // A whole number as the lobby wrote it, else null (the server picks a plain colour).
  function skin() {
    var v = String(read(root.localStorage, SKIN_KEY)).trim();
    var n = /^\d+$/.test(v) ? Number(v) : NaN;
    return Number.isSafeInteger(n) ? n : null;
  }
  slx.skin = skin;
  // Plus the paid hand-off's fields when slxPaid (loaded before this file) has any (PAID-SL-DESIGN 9): its paidAuth
  // answer goes into the handshake of every /sl socket, a free page gets none and sends the cv alone, as before.
  slx.auth = function () {
    var cv = skin();
    var a = cv === null ? {} : { cv: cv };
    var p = typeof slx.paidAuth === 'function' ? slx.paidAuth() : null;
    if (p && typeof p === 'object') for (var k in p) if (Object.prototype.hasOwnProperty.call(p, k)) a[k] = p[k];
    // the battle royale's fields (slxBr, loaded before this file, on an event page only)
    var b = typeof slx.brAuth === 'function' ? slx.brAuth() : null;
    if (b && typeof b === 'object') for (var j in b) if (Object.prototype.hasOwnProperty.call(b, j)) a[j] = b[j];
    // the free room's watcher fields (slxWatch, loaded before this file, on a lobby Spectate page only; it stays out of
    // a paid page and the event's, so these never join theirs)
    var w = typeof slx.watchAuth === 'function' ? slx.watchAuth() : null;
    if (w && typeof w === 'object') for (var q in w) if (Object.prototype.hasOwnProperty.call(w, q)) a[q] = w[q];
    return a;
  };

  // ---- 4. the lobby hand-off
  function framed() {
    try {
      return !!root.parent && root.parent !== root;
    } catch (e) {
      return true;
    }
  }
  // The lobby's own game frame (same origin only: a cross-origin parent leaves frameElement null).
  function inLobbyFrame() {
    try {
      var f = root.frameElement;
      return !!f && f.id === 'game-frame';
    } catch (e) {
      return false;
    }
  }
  // The lobby's name: the launch hand-off first, else the name the lobby keeps (public/js/v2/play.js NAME_KEY).
  // Their client cuts and cleans it at the socket open (slNet.js openNick), so it is passed as it is.
  function lobbyName() {
    return String(read(root.sessionStorage, 'playerName') || read(root.localStorage, 'duelseries_playername')).trim();
  }
  // Back to the lobby: the one message every DuelSeries game page sends (play.js clears the frame on it).
  function toLobby() {
    if (!framed()) return false;
    try {
      var origin = root.location && root.location.origin;
      root.parent.postMessage('game:done', origin && origin !== 'null' ? origin : '*');
      return true;
    } catch (e) {
      return false;
    }
  }

  // ---- layer controls: a click or tap on one never reaches their window handlers (15.1 rules): mousedown would
  // boost (public/js/sl/slInput.js:148, 205), touches steer (:203-206), keys reach their document.onkeydown (:208).
  // mouseup is let through (fixer pass, 2026-10-10): their window listener only ends a boost (:166-168, 207), and
  // stopping it left a boost on when the mouse was let go over a layer element (their release ends it anywhere). opts.activate(e) runs on click, and on a tap that ends on the element (touchstart's
  // default is prevented, so no click follows). opts.typing: a text box keeps its touch default (focus, caret) and
  // its key events stop here.
  function guard(el, opts) {
    var o = opts || {};
    var stop = function (e) { e.stopPropagation(); };
    var types = ['mousedown', 'contextmenu', 'touchmove', 'touchend', 'touchcancel'];
    for (var i = 0; i < types.length; i++) el.addEventListener(types[i], stop);
    var touched = false;
    el.addEventListener('touchstart', function (e) {
      e.stopPropagation();
      if (o.typing) return;
      e.preventDefault();
      touched = true;
    }, { passive: false });
    if (typeof o.activate === 'function') {
      el.addEventListener('click', function (e) {
        e.stopPropagation();
        o.activate(e);
      });
      el.addEventListener('touchend', function (e) {
        if (!touched) return;
        touched = false;
        var t = e.changedTouches && e.changedTouches[0];
        var r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
        if (t && r && (t.clientX < r.left || t.clientX > r.right || t.clientY < r.top || t.clientY > r.bottom)) return;
        o.activate(e);
      });
    }
    if (o.typing) {
      var keys = ['keydown', 'keyup', 'keypress'];
      for (var k = 0; k < keys.length; k++) el.addEventListener(keys[k], stop);
    }
    return el;
  }

  slx.framed = framed();
  slx.inLobby = inLobbyFrame();
  slx.lobbyName = lobbyName;
  slx.toLobby = toLobby;
  slx.guard = guard;

  // The keyboard in the lobby's frame (Owen, 2026-10-15: Space and Q sometimes dead after joining). The lobby shows this
  // frame over its own Play button, which keeps the focus, so no key reaches their document.onkeydown (boost,
  // public/js/sl/slInput.js:208) or our Q (slxHold.js); and a click in the game does not move it, because their
  // window.onmousedown prevents the default once a snake exists (slInput.js:148-156). So the frame takes the focus as it
  // boots, and any press in it while it lacks the focus takes it back, in the capture phase, before their handler.
  if (slx.inLobby) {
    try {
      root.focus();
    } catch (e) { /* nothing to take: the press below does it */ }
    if (typeof root.addEventListener === 'function') {
      root.addEventListener('mousedown', function () {
        var d = root.document;
        if (!d || typeof d.hasFocus !== 'function' || d.hasFocus()) return;
        try {
          root.focus();
        } catch (e) { /* nothing to take */ }
      }, true);
    }
  }

  // Inside the lobby's frame: Play at once under the lobby name (their Play, public/js/sl/slMain.js:94-101), unless
  // slxPaid holds the page (paidHold: a paid snake cut off by a reload, or a paid launch it could not read). Such a
  // page shows its notice on the results card and never plays free.
  // The battle royale's page (slxBr) plays itself: it asks the lobby's wallet for the prize proof first. A Spectate page
  // (slxWatch) plays the same way as a free one: its handshake makes the socket a watcher.
  if (slx.inLobby && !(typeof slx.paidHold === 'function' && slx.paidHold() === true)) {
    if (!(typeof slx.brLaunch === 'function' && slx.brLaunch(lobbyName()) === true)) D.play(lobbyName());
  }
})(typeof window !== 'undefined' ? window : globalThis);
