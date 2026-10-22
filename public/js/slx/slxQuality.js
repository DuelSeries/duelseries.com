// DuelSeries layer on the frozen slither.io client: the lobby's Graphics quality setting, applied live (Owen
// 2026-10-21: "High (default)" is exactly today's look, "Low (faster)" is for PCs that lag in big fights).
//
// The setting IS their own storage key "qual" ('0' is low; public/js/sl/slLoop.js readWantQuality). Their client reads
// it once at load and applies it when the game socket opens (slLoop onSocketOpen), so a page opened after a change
// needs nothing from here. This file carries a change made while the game is open: the lobby's Settings writes the key
// in the same origin and the storage event reaches this frame. It sets what their socket open would have, want_quality
// and high_quality; their own per-frame fades (slLoop stepQualityFades) then take the pellet glow (gla) and the body
// circle spacing (qsm) there smoothly. High hands the choice back to their auto quality, which still drops to low
// under 24 fps as it always has.
(function (root) {
  'use strict';
  var D = root.DuelSlither;
  if (!D || !D.slx || !D.slx.active) return;
  if (typeof root.addEventListener !== 'function') return;

  function wanted() {
    try {
      return root.localStorage.getItem('qual') === '0' ? 0 : 1;
    } catch (e) {
      return 1;                                  // storage blocked: their default
    }
  }

  root.addEventListener('storage', function (e) {
    if (e.key !== 'qual' && e.key !== null) return; // null: the whole storage was cleared
    var S = D.S;
    if (!S) return;
    var q = wanted();
    if (q === S.want_quality) return;
    S.want_quality = q;
    S.high_quality = q === 1 && S.render_mode != 1; // their socket open keeps render mode 1 low
  });
})(typeof window !== 'undefined' ? window : globalThis);
