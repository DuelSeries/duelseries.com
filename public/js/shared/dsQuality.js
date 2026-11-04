// The lobby's Graphics Quality setting (Settings > Graphics > Quality), shared by every game (Owen 2026-11-03:
// "High means high quality in every game, Low means low quality in every game").
//
// One key for every game: slither's own "qual" ('0' is Low; anything else, or nothing, is High), which the lobby's
// Settings already writes (v2.html setGfx) and slither already reads (public/js/sl/slLoop.js, slx/slxQuality.js).
// High is each game's look exactly as it was. Low is visuals only, never gameplay, physics or netcode:
//   - render scale capped at devicePixelRatio 1 (DSQuality.dpr), in every game that sizes its canvas by the DPR;
//   - canvas glow off: every 2D canvas shadowBlur reads 0 while Low is on (shadow colours and offsets stay, so an
//     offset text shadow still draws, just without the costly blur);
//   - each game turns off its own extra effects where it has them (particles, sparks, antialias) by asking
//     DSQuality.low().
// A change made in Settings while a game is open reaches the game's frame by the storage event: the glow switch
// flips at once, a 'resize' event re-sizes the canvas at the new scale, and DSQuality.onChange listeners run.
(function (root) {
  'use strict';
  if (root.DSQuality) return;
  var KEY = 'qual';

  function read() {
    try { return root.localStorage.getItem(KEY) === '0'; } catch (e) { return false; } // storage blocked: High
  }
  var isLow = read();
  var subs = [];

  // The device pixel ratio to draw at: the game's own cap on High (cap omitted: none), at most 1 on Low.
  function dpr(cap) {
    var d = root.devicePixelRatio > 0 ? root.devicePixelRatio : 1;
    if (cap > 0) d = Math.min(d, cap);
    return isLow ? Math.min(d, 1) : d;
  }

  // Canvas glow off on Low, in every 2D context on the page, without touching a game's drawing code.
  function patchBlur(proto) {
    if (!proto) return;
    var d = Object.getOwnPropertyDescriptor(proto, 'shadowBlur');
    if (!d || !d.set || !d.get || !d.configurable) return;
    Object.defineProperty(proto, 'shadowBlur', {
      configurable: true,
      enumerable: d.enumerable,
      get: function () { return d.get.call(this); },
      set: function (v) { d.set.call(this, isLow ? 0 : v); }
    });
  }
  patchBlur(root.CanvasRenderingContext2D && root.CanvasRenderingContext2D.prototype);
  patchBlur(root.OffscreenCanvasRenderingContext2D && root.OffscreenCanvasRenderingContext2D.prototype);

  function mark() {
    var el = root.document && root.document.documentElement;
    if (el && el.classList) el.classList.toggle('ds-lowq', isLow);
  }
  mark();

  if (typeof root.addEventListener === 'function') {
    root.addEventListener('storage', function (e) {
      if (e.key !== KEY && e.key !== null) return;     // null: the whole storage was cleared
      var now = read();
      if (now === isLow) return;
      isLow = now;
      mark();
      for (var i = 0; i < subs.length; i++) { try { subs[i](isLow); } catch (err) {} }
      try { root.dispatchEvent(new Event('resize')); } catch (err) {}
    });
  }

  root.DSQuality = {
    KEY: KEY,
    low: function () { return isLow; },
    dpr: dpr,
    onChange: function (fn) { if (typeof fn === 'function') subs.push(fn); }
  };
})(typeof window !== 'undefined' ? window : globalThis);
