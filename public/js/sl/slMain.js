// slither.io redo: boot and Play (build brief 10.2, 10.5, 10.6). Loaded last by sl.html.
// boot() builds the mirrored state object S and runs every module's load step in the order their
// page does its load work: state, tables, page and HUD elements, images, sprites, the frame loop
// (game.js:6941), the input handlers (6942-7029), then the load-time resize (11122).
(function (root) {
  'use strict';
  var D = root.DuelSlither = root.DuelSlither || {};

  // The only random source of the client (brief 10.7). The global random function is looked up at each call.
  function rand() {
    return Math.random();
  }

  // The Mac OS X version numbers after "mac os x " the way their parser reads them (game.js:51-64): digits
  // build a number; '.' or '_' ends a number and goes on; any other character ends the last number and stops;
  // at most 3 numbers. A number still being read when the text runs out is dropped (their quirk: a user agent
  // that ends in "mac os x 10.11" gives only [10], so no Mac version).
  function macVersion(ua) {
    var at = ua.indexOf('mac os x ');
    if (at < 0) return [];
    var parts = [];
    var num = 0;
    for (var i = at + 9; i < ua.length && parts.length < 3; i++) {
      var c = ua.charAt(i);
      if (c >= '0' && c <= '9') {
        num = num * 10 + (c.charCodeAt(0) - 48);
        continue;
      }
      parts.push(num);
      num = 0;
      if (c != '.' && c != '_') break;
    }
    return parts;
  }

  // Their nsr flag (game.js:15, 47-76, 103-106): Chrome (not Safari, not Firefox) on Mac OS X 10.11 or
  // older, on a Mac platform when the browser names one.
  function nsrFlag(nav) {
    var ua = String(nav.userAgent || '').toLowerCase();
    var firefox = ua.indexOf('firefox') > -1;
    var safari = ua.indexOf('safari') >= 0 && ua.indexOf('chrome') == -1;
    var chrome = ua.indexOf('chrome') >= 0 && !safari && !firefox;
    var ver = macVersion(ua);
    var mac = ver.length >= 2 && ver[0] == 10;
    if (nav.platform && String(nav.platform).toLowerCase().substr(0, 3) != 'mac') mac = false;
    return chrome && mac && ver[1] <= 11;
  }

  function boot(config) {
    if (D.booted) return;
    var cfg = config || root.DuelSlitherConfig || {};
    var nav = root.navigator || {};
    var S = {};
    D.S = S;
    D.rand = rand;
    D.stats = { messages: 0, events: 0, wireBytes: 0, wireErrors: 0, applyThrows: 0 };

    // 0. environment flags (game.js:20-21, 33, 38)
    S.is_mobile = String(nav.userAgent || '').toLowerCase().indexOf('mobile') >= 0;
    S.nsr = nsrFlag(nav);
    S.lang = String(nav.language || nav.userLanguage || '').substr(0, 2);

    // 1 to 3. state of each module (slApply first: brief 10.3)
    D.slApply.initApplyState(S);
    D.slLoop.initLoopState(S);
    D.slLoop.buildTables(S);
    D.slInput.initInputState(S);

    // 4. page canvas and HUD elements
    D.slPage.init(S);
    D.slHud.init(S);

    // 5. tile and glow images
    D.slDrawWorld.init(S, cfg.assetBase == null ? '/' : cfg.assetBase);

    // 6. sprites, then the snake draw buffers
    D.slSprites.buildSprites(S, { nsr: S.nsr });
    D.slDrawSnake.initDrawSnake(S);

    // 7 to 9. frame loop, input, load-time resize
    D.slLoop.start();
    D.slInput.install();
    D.slPage.install();

    D.booted = true;
  }

  // Their Play button state (play_btn.disabled): locked by a Play, unlocked by gameOver while playing and
  // not already closing (game.js:1366-1370, 9046), so a Play during a life cannot reset it.
  var locked = false;

  // Their Play click minus the menu (game.js:1364-1374): only when not already wanting to play and the
  // button is not locked. The name is read at the socket open, as theirs reads nick.value (game.js:8951).
  function play(nick) {
    var S = D.S;
    if (!S || S.want_play || locked) return;
    locked = true;
    api.nick = nick == null ? '' : String(nick);
    S.want_play = true;
  }

  // Called by slApply.gameOver (their play_btn.setEnabled(true)) and by slApply.applyClose when the socket
  // closes with no life running. That second call is ours: their 3333 ms reconnect (game.js:4310-4329) is
  // OUT, so a connect that fails before init must leave Play usable.
  function unlockPlay() {
    locked = false;
  }

  var api = {
    boot: boot,
    play: play,
    unlockPlay: unlockPlay,
    isPlayLocked: function () { return locked; },
    nsrFlag: nsrFlag,
    macVersion: macVersion,
    nick: ''
  };
  D.slMain = api;
  D.boot = boot;
  D.play = play;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else if (root.document) {
    boot(root.DuelSlitherConfig || {});
  }
})(typeof window !== 'undefined' ? window : globalThis);
