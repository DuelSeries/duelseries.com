/* 8 Ball Pool's FREE looks (Owen 2026-10-28: "two or three free looks, cues and/or cloth colours, chosen in a
   Customize chooser like Pac-Man's"): a cloth colour and a cue you pick in Customize and keep, instead of the game's
   own look (the reference's blue cloth and maple cue). All of them are ours; none is Miniclip's.

   One list for both ends, like shared/chompSkins.js: the lobby's chooser lists these after the game's own look, the
   /pool8 page sends the chosen id in its queue message, and the server wears only an id from here (anything else is
   the classic look), so a page can never ask for something that is not on it. The cloth is drawn on your own
   screen; your cue is drawn on both screens and for anyone watching. Cosmetic only: no rule and no money path reads
   it. Stored in the lobby under duel.pool8.look.

   The cues (Owen 2026-10-28: "a cue chooser with a few cues of our own design"): five more looks, each a cue of
   ours on the game's own blue cloth, in the same one reel (Owen keeps Customize to one reel, as Swim's cars). A cue
   with a style is drawn by paintCue below, the same function in the game (p8Art.js drawCue) and in the lobby's
   preview (shopArt.js), so the two can never differ. Looks only: every cue aims and hits the same. */
(function (root) {
  'use strict';
  var LOOKS = [
    { id: 'green', name: 'Tournament green',
      cloth: { hi: '#7fcf86', mid: '#3a9a50', lo: '#15542b', cushion: '#2f8a45', cushionHi: '#8fd99a' },
      cue: { shaft: '#e4c48e', butt: '#2b1a10', joint: '#c9a23a' }, col: '#3a9a50' },
    { id: 'wine', name: 'Wine red',
      cloth: { hi: '#d07a82', mid: '#93323d', lo: '#47101a', cushion: '#86303b', cushionHi: '#e09aa2' },
      cue: { shaft: '#d9b27c', butt: '#151515', joint: '#e8e8e8' }, col: '#93323d' },
    { id: 'midnight', name: 'Midnight',
      cloth: { hi: '#8796b3', mid: '#46536f', lo: '#1b2131', cushion: '#40506c', cushionHi: '#a3b2cf' },
      cue: { shaft: '#cfd6e0', butt: '#0f2a4a', joint: '#ffd34d' }, col: '#46536f' },
    // fore: the forearm (the cue's design), wrap: the grip with its weave in wrapLine, sleeve: the butt with trim rings.
    { id: 'ebony', name: 'Ebony and brass', col: '#c9a23a',
      cue: { style: 'points', shaft: '#e8cf9f', joint: '#c9a23a', fore: '#1d1512', inlay: '#c9a23a', trim: '#e9d9a8',
        wrap: '#141414', wrapLine: '#3a3a3a', sleeve: '#1d1512', band: '#c9a23a' } },
    { id: 'tiger', name: 'Tiger maple', col: '#d99a4e',
      cue: { style: 'curl', shaft: '#ecd3a2', joint: '#2a1a12', fore: '#dca35a', inlay: '#8e4f1e', trim: '#2a1a12',
        wrap: '#7a4a2b', wrapLine: '#5b351d', sleeve: '#4a2c1a' } },
    { id: 'ocean', name: 'Ocean lacquer', col: '#1f5fae',
      cue: { style: 'wave', shaft: '#e6d2a8', joint: '#d7dee8', fore: '#143f80', inlay: '#d7dee8', trim: '#d7dee8',
        wrap: '#eef2f6', wrapLine: '#1f5fae', sleeve: '#143f80' } },
    { id: 'ember', name: 'Ember', col: '#e0521d',
      cue: { style: 'flames', shaft: '#e9cf9c', joint: '#111111', fore: '#141414', inlay: '#d8361e', trim: '#f2a23a',
        wrap: '#1c1c1c', wrapLine: '#4a1a10', sleeve: '#141414' } },
    { id: 'zebra', name: 'Zebrawood', col: '#c8a86a',
      cue: { style: 'stripes', shaft: '#ead19f', joint: '#1a120c', fore: '#e6cc96', inlay: '#4a3220', trim: '#1a120c',
        wrap: '#8a6440', wrapLine: '#6a4a2c', sleeve: '#e6cc96' } },
  ];
  var BY = {};
  LOOKS.forEach(function (s) { BY[s.id] = s; });
  /* The look for an id, or null for anything not listed. */
  function byId(id) {
    return typeof id === 'string' && Object.prototype.hasOwnProperty.call(BY, id) ? BY[id] : null;
  }
  /* A styled cue along +x from its tip (x = 0) to its butt (x = len), y across, at the caller's transform; ws scales
     the widths (1 = play's, a 5.6 px tip swelling to 8.4 at the butt). From the tip: tip, ferrule, shaft, joint
     collar, forearm (the design), wrap, sleeve, bumper. */
  var SEC = { tip: 0.005, ferrule: 0.02, shaft: 0.56, joint: 0.58, fore: 0.75, wrap: 0.88, sleeve: 0.985 };
  function paintCue(g, len, Q, ws) {
    function W(f) { return (5.6 + 2.8 * f) * ws; }
    function body(fa, fb) {
      g.beginPath(); g.moveTo(fa * len, -W(fa) / 2); g.lineTo(fb * len, -W(fb) / 2);
      g.lineTo(fb * len, W(fb) / 2); g.lineTo(fa * len, W(fa) / 2); g.closePath();
    }
    function band(fa, fb, col) { g.fillStyle = col; body(fa, fb); g.fill(); }
    function inside(fa, fb, fn) { g.save(); body(fa, fb); g.clip(); fn(fa * len, fb * len, W(fb)); g.restore(); }
    function ring(f, col) { band(f - 0.003, f + 0.003, col); }
    band(0, SEC.tip, '#3d78c9');
    band(SEC.tip, SEC.ferrule, '#f4f1e6');
    band(SEC.ferrule, SEC.shaft, Q.shaft);
    band(SEC.shaft, SEC.joint, Q.joint);
    band(SEC.joint, SEC.fore, Q.fore);
    if (PATTERN[Q.style]) inside(SEC.joint, SEC.fore, function (a, b, w) { PATTERN[Q.style](g, a, b, w, Q); });
    band(SEC.fore, SEC.wrap, Q.wrap);
    // The grip's linen weave: fine crossing lines.
    inside(SEC.fore, SEC.wrap, function (a, b, w) {
      g.strokeStyle = Q.wrapLine; g.lineWidth = Math.max(0.5, w * 0.08);
      for (var x = a - w; x < b + w; x += w * 0.34) {
        g.beginPath(); g.moveTo(x, -w); g.lineTo(x + w * 0.9, w); g.moveTo(x + w * 0.9, -w); g.lineTo(x, w); g.stroke();
      }
    });
    band(SEC.wrap, SEC.sleeve, Q.sleeve);
    if (Q.band) band(SEC.wrap + 0.025, SEC.wrap + 0.07, Q.band);                // a wide metal band on the butt
    ring(SEC.joint + 0.003, Q.trim); ring(SEC.fore, Q.trim); ring(SEC.wrap, Q.trim);
    ring(SEC.wrap + 0.02, Q.trim); ring(SEC.sleeve - 0.012, Q.trim);
    band(SEC.sleeve, 1, '#151515');
    // Round, not flat: a lit line along the top and a shade along the bottom.
    g.save(); body(0, 1); g.clip();
    g.fillStyle = 'rgba(0,0,0,0.22)'; g.fillRect(0, W(1) * 0.12, len, W(1));
    g.strokeStyle = 'rgba(255,255,255,0.32)'; g.lineWidth = 1.3 * ws;
    g.beginPath(); g.moveTo(len * 0.02, -W(0.02) * 0.24); g.lineTo(len, -W(1) * 0.24); g.stroke();
    g.restore();
  }
  // The forearm designs, inside [a, b] along the cue, w the width there.
  var PATTERN = {
    // Spliced points pointing to the tip, each edged in a pale veneer; the side view shows one whole and two halves.
    points: function (g, a, b, w, Q) {
      var tipX = a + (b - a) * 0.16;
      [-w, 0, w].forEach(function (y) {
        g.beginPath(); g.moveTo(tipX, y); g.lineTo(b + 1, y - w * 0.48); g.lineTo(b + 1, y + w * 0.48); g.closePath();
        g.fillStyle = Q.trim; g.fill();
        g.beginPath(); g.moveTo(tipX + (b - a) * 0.07, y); g.lineTo(b + 1, y - w * 0.36); g.lineTo(b + 1, y + w * 0.36); g.closePath();
        g.fillStyle = Q.inlay; g.fill();
      });
    },
    // Tiger maple: dark stripes across the grain at uneven spacing, each fat in the middle and tapering to the edges.
    curl: function (g, a, b, w, Q) {
      var L = b - a, AT = [0.04, 0.11, 0.15, 0.27, 0.33, 0.47, 0.52, 0.63, 0.76, 0.81, 0.92], WD = [0.5, 0.25, 0.4, 0.6, 0.3, 0.45, 0.2, 0.55, 0.35, 0.25, 0.5];
      g.fillStyle = Q.inlay;
      AT.forEach(function (f, i) {
        var x = a + L * f, s = w * WD[i] * 0.45, k = (i % 2 ? 1 : -1) * w * 0.18;
        g.globalAlpha = 0.45 + 0.25 * (i % 3) / 2;
        g.beginPath(); g.moveTo(x, -w * 0.6);
        g.quadraticCurveTo(x + k + s, 0, x + w * 0.1, w * 0.6); g.quadraticCurveTo(x + k - s * 0.4, 0, x, -w * 0.6);
        g.fill();
      });
      g.globalAlpha = 1;
    },
    // Flames licking up the forearm from the grip: red tongues, orange inside them, yellow at the heart.
    flames: function (g, a, b, w, Q) {
      var L = b - a, T = [[-0.3, 0.92], [0.02, 0.7], [0.3, 0.84], [-0.05, 0.45]];
      [[Q.inlay, 1, 1], ['#f08a1c', 0.72, 0.62], ['#ffd34a', 0.42, 0.32]].forEach(function (layer) {
        g.fillStyle = layer[0];
        T.forEach(function (t) {
          var y = t[0] * w, len = L * t[1] * layer[1], hw = w * 0.3 * layer[2];
          g.beginPath(); g.moveTo(b + 1, y - hw);
          g.bezierCurveTo(b - len * 0.4, y - hw * 1.2, b - len * 0.7, y + hw * 0.7, b - len, y - hw * 0.3);
          g.bezierCurveTo(b - len * 0.6, y + hw * 0.3, b - len * 0.3, y + hw * 1.3, b + 1, y + hw);
          g.closePath(); g.fill();
        });
      });
    },
    // A silver wave inlaid down the middle with a dot in every crest.
    wave: function (g, a, b, w, Q) {
      var n = 3, L = b - a;
      g.strokeStyle = Q.inlay; g.lineWidth = Math.max(0.8, w * 0.13);
      g.beginPath();
      for (var i = 0; i <= 60; i++) { var x = a + L * i / 60, y = Math.sin(i / 60 * n * 6.2832) * w * 0.24; if (i) g.lineTo(x, y); else g.moveTo(x, y); }
      g.stroke();
      g.fillStyle = Q.inlay;
      for (var j = 0; j < n; j++) { g.beginPath(); g.arc(a + L * (j + 0.75) / n, -w * 0.24, w * 0.09, 0, 6.2832); g.fill(); }
    },
    // Black diamonds in a row, a pearl dot in each.
    diamonds: function (g, a, b, w, Q) {
      var n = 4, L = (b - a) / n;
      for (var i = 0; i < n; i++) {
        var cx = a + L * (i + 0.5);
        g.beginPath(); g.moveTo(cx - L * 0.36, 0); g.lineTo(cx, -w * 0.36); g.lineTo(cx + L * 0.36, 0); g.lineTo(cx, w * 0.36); g.closePath();
        g.fillStyle = Q.inlay; g.fill();
        g.beginPath(); g.arc(cx, 0, w * 0.08, 0, 6.2832); g.fillStyle = Q.trim; g.fill();
      }
    },
    // Zebrawood's dark grain: slanted stripes of uneven width.
    stripes: function (g, a, b, w, Q) {
      g.fillStyle = Q.inlay;
      for (var x = a - w, i = 0; x < b + w; x += w * 0.55, i++) {
        var sw = w * (0.12 + 0.05 * (i % 3));
        g.beginPath(); g.moveTo(x, -w); g.lineTo(x + sw, -w); g.lineTo(x + sw + w * 0.5, w); g.lineTo(x + w * 0.5, w); g.closePath(); g.fill();
      }
    },
  };
  var api = { LOOKS: LOOKS, byId: byId, KEY: 'duel.pool8.look', paintCue: paintCue };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.DS_POOL8_LOOKS = api;
})(typeof window !== 'undefined' ? window : null);
