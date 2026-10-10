// slither.io redo: the page shell (build brief section 11 "slPage", spec loop-page-input.md section 5).
// Owns the game canvas mc, its backing size and CSS scale, and window.onresize.
//
// Rules this module keeps:
// - mc is the data-sl="mc" canvas already in sl.html (third in body, same attributes as theirs). Never a second one.
// - Backing size: the window scaled to an 1800 px diagonal, each side capped at 1500, then CSS scaled by csc.
//   The device pixel ratio is never read and image smoothing is never set, same as theirs.
// - mc.width and mc.height are written only when the backing size really changes (a write clears the canvas).
// - redraw runs on EVERY resize call, even when nothing changed (game.js:6930).
// - Desktop web client behaviour on every device: no app banner, so hsu stays 0 (their banner exists only on
//   phone user agents, game.js:6842-6848, and is OUT).
// - Nothing happens at script load. boot calls init(S), then install() after the loop has started.
(function (root) {
  'use strict';
  var D = root.DuelSlither = root.DuelSlither || {};

  var WDL = 1800;      // game.js:6889, target diagonal of the backing store
  var SIDE_CAP = 1500; // game.js:6893-6900, cap on either side
  var MWW0 = 850;      // game.js:1407, backing width before the first resize
  var MHH0 = 700;      // game.js:1408, backing height before the first resize

  var S = null;

  function st() {
    return S || D.S;
  }

  // Load-time state (game.js:1406-1425, 6822-6827; wsu is 0 in their page, index.html:431).
  function init(state) {
    S = state;
    var mc = root.document.querySelector('[data-sl="mc"]');
    if (!mc) throw new Error('slPage: sl.html has no data-sl="mc" canvas');
    S.mc = mc;
    S.ctx = mc.getContext('2d');
    S.mww = MWW0;
    S.mhh = MHH0;
    S.mwwp50 = S.mww + 50;
    S.mhhp50 = S.mhh + 50;
    S.mwwp150 = S.mww + 150;
    S.mhhp150 = S.mhh + 150;
    S.mww2 = S.mww / 2;
    S.mhh2 = S.mhh / 2;
    S.ww = root.innerWidth;   // not rounded at load (game.js:6822-6823); resize rounds up
    S.hh = root.innerHeight;
    S.lww = 0;
    S.lhh = 0;
    S.hsu = 0;
    S.wsu = 0;
    S.csc = undefined;        // declared without a value (game.js:6827)
  }

  // Their resize() (game.js:6829-6931), minus the menu, ads and banner parts (OUT).
  // Owen Q5 and Q10 may change this (layered in a separate file)
  function resize() {
    var s = st();
    var mc = s.mc;
    s.ww = Math.ceil(root.innerWidth);
    s.hh = Math.ceil(root.innerHeight);
    if (s.ww != s.lww || s.hh != s.lhh) {
      // the last size is kept BEFORE the wsu cut (game.js:6833-6834)
      s.lww = s.ww;
      s.lhh = s.hh;
      s.hsu = 0;
      s.ww -= s.wsu;
      // HUD positions plus the login width and scale (game.js:6858-6867, 6901-6911), owned by slHud
      D.slHud.resizeHud();
      var dl = Math.sqrt(s.ww * s.ww + s.hh * s.hh);
      var nmww = Math.ceil(s.ww * WDL / dl);
      var nmhh = Math.ceil(s.hh * WDL / dl);
      if (nmww > SIDE_CAP) {
        nmhh = Math.ceil(nmhh * SIDE_CAP / nmww);
        nmww = SIDE_CAP;
      }
      if (nmhh > SIDE_CAP) {
        nmww = Math.ceil(nmww * SIDE_CAP / nmhh);
        nmhh = SIDE_CAP;
      }
      // A window with no width or no height (a 0-sized iframe) would give a 0-sized backing store and glow
      // canvas, and every later redraw would throw (theirs stops for good, game.js:5222). Ours keeps the
      // last backing size until the window has an area again. A window of at least 1 x 1 px never gets here.
      var hasArea = nmww > 0 && nmhh > 0;
      if (hasArea && (s.mww != nmww || s.mhh != nmhh)) {
        s.mww = nmww;
        s.mhh = nmhh;
        mc.width = s.mww;
        mc.height = s.mhh;
        s.mwwp50 = s.mww + 50;
        s.mhhp50 = s.mhh + 50;
        s.mwwp150 = s.mww + 150;
        s.mhhp150 = s.mhh + 150;
        s.mww2 = s.mww / 2;
        s.mhh2 = s.mhh / 2;
        D.slDrawWorld.rebuildGbg(); // their rdgbg (game.js:1703-1713)
      }
      s.csc = Math.min(s.ww / s.mww, s.hh / s.mhh);
      // their trf() also writes 4 prefixed copies; in Chrome they alias or do nothing (game.js:118-120)
      mc.style.transform = 'scale(' + s.csc + ',' + s.csc + ')';
      mc.style.left = Math.floor(s.ww / 2 - s.mww / 2) + 'px';
      mc.style.top = Math.floor(s.hh / 2 - s.mhh / 2) + 'px';
    }
    D.slDrawWorld.redraw();
  }

  // window.onresize (game.js:6933-6935), then the load-time resize (game.js:11122), after slLoop.start().
  function install() {
    root.onresize = function () {
      resize();
    };
    resize();
  }

  D.slPage = {
    init: init,
    resize: resize,
    install: install
  };
})(typeof window !== 'undefined' ? window : globalThis);
