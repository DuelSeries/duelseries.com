/* The lobby's slither.io skin preview, for the Customize bar and its chooser
   (BACKLOG 3.1). The snake on /sl is drawn by slither's own client, so the
   preview is drawn from the same parts rather than from a second guess at
   them: public/js/sl/slSprites.js is loaded READ-ONLY before this file (it
   touches nothing at load), its setSkin gives a skin's stripe list and eye
   colours, and its buildSprites gives the 48px body discs every colour is
   stamped with in play. The motion is slither's own Change Skin screen (see
   paint below); what is left out is the extras: no antenna, no boost glow.

   The skin list is the server's: cv 0 to 65 less the twelve picture skins,
   which stay off until Owen has looked at their files (server/sl/slBots.js
   botSkins, PICTURE_SKINS). Anything else would be swapped for a random
   plain colour by server/sl/slSockets.js skinOf, so nothing here can pick a
   skin the game would refuse.

   Exposes window.V2Look = {skins, name(cv), paint(canvas, cv, cfg, t)}, t in
   seconds and cfg {lenFrac, hFrac}: the most of the canvas width the whole
   body may take, and the most of its height the swing may take. */
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
  /* A skin is a cv number, or (for the Shop's skins) a list of [count, colour]
     stripe runs: slither's own custom-skin bytes (setSkin's `ca`, bytes 8 on
     are count, colour pairs, only its allowed colours count). */
  function look(cv) {
    var runs = Array.isArray(cv);                 // a cv can also arrive as a string, from data-skin
    var key = runs ? JSON.stringify(cv) : cv;
    if (!looks[key]) {
      var o = { xx: 0, yy: 0 };
      if (!runs) SS.setSkin(o, cv);
      else {
        var ca = [0, 0, 0, 0, 0, 0, 0, 0];
        for (var i = 0; i < cv.length; i++) ca.push(cv[i][0], cv[i][1]);
        SS.setSkin(o, 0, ca);
      }
      looks[key] = o;
    }
    return looks[key];
  }

  /* slither's own Change Skin screen, read from their client
     (slither-reference/beautified/game.js): csk.onclick builds 27 points 10
     units apart with the head on the right, angle 0, and the frame loop's
     choosing_skin branch sets every point's y each frame to
       cos(j/4 + fr/19) * 15 * (1 - j/27)
     with j counted from the TAIL and fr their frame clock (fr += vfr, vfr =
     ms/8). So the tail swings 15 units, the head almost none, and the wave
     runs head to tail at 6.58 radians a second. The snake itself never moves
     or turns while choosing (the steering loop is skipped), so its eye angle
     stays 0, straight ahead, and its pupils stay pushed forward by rex 1.66
     (set in csk.onclick; the loop that would ease them is skipped too).
     Circles: mct = 6 / (qsm * sep / 6) per point gap at their chooser sep
     18.25 and qsm 1, so 1.973 circles per 10 units, against a 14.5 radius. */
  var PTS = 27, GAP_U = 10, SWING = 15, RAD = 14.5, REX = 1.66;
  var MCT = 6 / (18.25 / 6);
  var LEN = (PTS - 1) * GAP_U;          // head centre to tail centre, 260
  var RING = RAD * 52 / 32;             // komc, the outline, drawn at lsz*52/32
  var MS_PER_FR = 8, FR_PER_RAD = 19;

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
    /* Their shape at whatever size fits: k canvas pixels per slither unit. */
    var lenFrac = cfg && cfg.lenFrac || 0.9, hFrac = cfg && cfg.hFrac || 0.9;
    var k = Math.min(w * lenFrac / (LEN + 2 * RING), h * hFrac / (2 * (SWING + RING)));
    var r = RAD * k;
    /* cfg.headX pins the head's centre at that fraction of the width, for a
       box that shows the front of a snake bigger than the box (lenFrac over
       1), the tail running off the left. Unset, the whole body is centred. */
    var hx = cfg && cfg.headX ? w * cfg.headX : w / 2 + LEN * k / 2, cy = h / 2;
    var ph = (t || 0) * 1000 / MS_PER_FR / FR_PER_RAD;
    var n = Math.floor((PTS - 1) * MCT) + 1;
    var xs = new Array(n), ys = new Array(n), an = new Array(n);
    for (var i = 0; i < n; i++) {
      var j = (PTS - 1) - i / MCT;                  // fractional point index, tail = 0
      xs[i] = hx - (PTS - 1 - j) * GAP_U * k;
      ys[i] = cy + Math.cos(j / 4 + ph) * SWING * (1 - j / PTS) * k;
    }
    for (i = 0; i < n; i++) {
      var a = i === 0 ? 1 : i;                      // each circle faces the one ahead of it
      an[i] = Math.atan2(ys[a - 1] - ys[a], xs[a - 1] - xs[a]);
    }
    /* The dark outline ring under the whole body, then the body tail first so
       the head lands on top (slDrawSnake drawCircleBody passes B and C). */
    var ring = sprites.komc, ringR = RING * k;
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
    /* Their eyes (drawEyes): a white then a pupil each side, sized in the
       skin's own units, facing angle 0 with the pupil a further rex forward. */
    for (var side = -1; side <= 1; side += 2) {
      var ex = xs[0] + o.ed * k, ey = ys[0] + side * (o.esp + 0.5) * k;
      ctx.globalAlpha = o.eca;
      ctx.fillStyle = o.ec;
      ctx.beginPath(); ctx.arc(ex, ey, o.er * k, 0, Math.PI * 2); ctx.fill();
      ex = xs[0] + (o.ed + 0.5 + REX) * k;
      ey = ys[0] + side * o.esp * k;
      ctx.globalAlpha = o.ppa;
      ctx.fillStyle = o.ppc;
      ctx.beginPath(); ctx.arc(ex, ey, o.pr * k, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  root.V2Look = { skins: SKINS, name: name, paint: paint };
})(typeof window !== 'undefined' ? window : globalThis);
