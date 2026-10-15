/* The lobby's slither.io skin preview, for the Customize bar and its chooser
   (BACKLOG 3.1). The snake on /sl is drawn by slither's own client, so the
   preview is drawn from the same parts rather than from a second guess at
   them: public/js/sl/slSprites.js is loaded READ-ONLY before this file (it
   touches nothing at load), its setSkin gives a skin's stripe list and eye
   colours, and its buildSprites gives the 48px body discs every colour is
   stamped with in play. What is simplified is the path (a still wave, not a
   steered body) and the extras: no antenna, no boost glow.

   The skin list is the server's: cv 0 to 65 less the twelve picture skins,
   which stay off until Owen has looked at their files (server/sl/slBots.js
   botSkins, PICTURE_SKINS). Anything else would be swapped for a random
   plain colour by server/sl/slSockets.js skinOf, so nothing here can pick a
   skin the game would refuse.

   Exposes window.V2Look = {skins, name(cv), paint(canvas, cv, cfg, t)}. */
(function (root) {
  'use strict';
  var SS = root.DuelSlither && root.DuelSlither.slSprites;
  var SKIN_MAX = 65;                                  // server/sl/slBots.js SKIN_MAX
  var PICTURE = [37, 39, 40, 41, 42, 45, 46, 47, 48, 49, 59, 62];
  /* The nine plain colours, cv 0 to 8, are the first nine of the old lobby's
     list in the same order, so they keep the names people already know. */
  var NAMES = ['Purple', 'Periwinkle', 'Teal', 'Green', 'Yellow', 'Orange', 'Coral', 'Red', 'Magenta'];
  var SKINS = [];
  for (var c = 0; c <= SKIN_MAX; c++) if (PICTURE.indexOf(c) < 0) SKINS.push(c);

  /* slither has no skin names. A number reads as what it is, a place in the list. */
  function name(cv) { return cv < 9 ? NAMES[cv] : 'Skin ' + (SKINS.indexOf(cv) + 1); }

  var sprites = null;
  var looks = {};
  function sets() {
    if (!sprites) { sprites = {}; SS.buildSprites(sprites, { document: root.document, nsr: false }); }
    return sprites.per_color_imgs;
  }
  function look(cv) {
    if (!looks[cv]) { var o = { xx: 0, yy: 0 }; SS.setSkin(o, cv); looks[cv] = o; }
    return looks[cv];
  }

  /* Body circles sit about half a radius apart, as they do at a starting
     size in play (slDrawSnake layCircles: six circles per 42-unit point at
     sep 6, against a 14.5 radius). That is what sets how wide a stripe is. */
  var GAP = 0.48;

  function paint(cv, skinCv, cfg, t) {
    if (!SS) return;
    var w = cv.width, h = cv.height;
    if (!w || !h) return;
    var ctx = cv.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    var all = sets();
    var o = look(skinCv);
    var own = all[o.cv];
    var stripes = o.rbcs;
    var r = cfg.radiusFrac != null ? w * cfg.radiusFrac : Math.min(w * 0.068, h * 0.13);
    var spanX = w * cfg.spanFrac, amp = h * cfg.ampFrac;
    var n = Math.max(8, Math.round(2 * spanX / (GAP * r)));
    /* Head on the right at u=0, the wave travelling down to the tail, the
       amplitude growing toward the tail: the old preview's swim, unchanged. */
    var xs = new Array(n), ys = new Array(n), an = new Array(n);
    for (var i = 0; i < n; i++) {
      var u = i / (n - 1);
      xs[i] = w / 2 + spanX * (1 - u * 2);
      ys[i] = h / 2 + Math.sin(u * Math.PI * 1.4 - t * 2) * amp * (0.3 + u * 0.7);
    }
    for (i = 0; i < n; i++) {
      var j = i === 0 ? 1 : i;                      // each circle faces the one ahead of it
      an[i] = Math.atan2(ys[j - 1] - ys[j], xs[j - 1] - xs[j]);
    }
    /* The dark outline ring under the whole body, then the body tail first so
       the head lands on top (slDrawSnake drawCircleBody passes B and C). */
    var ring = sprites.komc, ringR = r * 52 / 32;
    if (ring) for (i = n - 1; i >= 0; i--) ctx.drawImage(ring, xs[i] - ringR, ys[i] - ringR, ringR * 2, ringR * 2);
    var frames = own.kmcs.length, pingPong = own.klp;
    for (i = n - 1; i >= 0; i--) {
      var set = stripes ? all[stripes[i % stripes.length]] : own;
      var f = i % frames;
      if (pingPong) { f = i % (frames * 2); if (f >= frames) f = frames * 2 - (f + 1); }
      ctx.save();
      ctx.translate(xs[i], ys[i]);
      ctx.rotate(an[i]);
      ctx.drawImage(set.kmcs[f] || set.kmcs[0], -r, -r, r * 2, r * 2);
      ctx.restore();
    }
    /* Their eyes at a starting size: a white then a pupil each side, sized in
       the skin's own units against a 14.5 radius (slDrawSnake drawEyes). */
    var k = r / 14.5, face = an[0];
    for (var side = -1; side <= 1; side += 2) {
      var sa = face + side * Math.PI / 2;
      var ex = xs[0] + Math.cos(face) * o.ed * k + Math.cos(sa) * (o.esp + 0.5) * k;
      var ey = ys[0] + Math.sin(face) * o.ed * k + Math.sin(sa) * (o.esp + 0.5) * k;
      ctx.globalAlpha = o.eca;
      ctx.fillStyle = o.ec;
      ctx.beginPath(); ctx.arc(ex, ey, o.er * k, 0, Math.PI * 2); ctx.fill();
      ex = xs[0] + Math.cos(face) * (o.ed + 0.5) * k + Math.cos(sa) * o.esp * k;
      ey = ys[0] + Math.sin(face) * (o.ed + 0.5) * k + Math.sin(sa) * o.esp * k;
      ctx.globalAlpha = o.ppa;
      ctx.fillStyle = o.ppc;
      ctx.beginPath(); ctx.arc(ex, ey, o.pr * k, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  root.V2Look = { skins: SKINS, name: name, paint: paint };
})(typeof window !== 'undefined' ? window : globalThis);
