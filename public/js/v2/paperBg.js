/* Paper.io's backdrop for its game screen: a zoomed-out arena with players
   running loops out of their ground and claiming what they close, the way
   slither.io's screen has its moving snakes and agar.io's its drifting cells.

   Same mechanism as those two (v2.html mkWorld / stepWorld / paintScene):
   a cheap pretend world on a half-resolution canvas[data-anim], stepped and
   painted by the lobby's one frame loop, which already skips it while its
   screen is hidden, stops while a game is up, and stops with the tab. It is
   not the game's simulation; it only has to look like the game.

   What it looks like comes from the game itself (public/js/paper):
     floor     arenaColor #e7fff4                    (paperSkins.js config)
     colours   playerColorPalette with deriveColorSet's back (value x0.75)
               and nick (value x0.5), computed by the game's own functions and
               pinned by test/v2PaperBg.test.js
     ground    sides in the back colour, tops in the main colour lifted by
               baseHeight 2                           (paperRender.js)
     trail     main colour at alpha 0.6, trackWidth 8, round caps
     player    a trackWidth square in the nick colour, and above it, lifted
               by baseHeight, the main square with its back rim (makeSquare-
               AvatarCanvas: 80 of 100 inside, 10 each side)
     motion    unitSpeed 90 units/s, turning at most a full turn a second
               over smoothness (paperGameMoves.js getMovement)
     ground    a start base of radius 30               (baseRadius)
   Territory is kept as a radius per direction around the player's home, so
   claiming a loop is a max over the directions it swept and losing ground to
   someone else is a shrink. No polygon clipping, nothing to allocate per
   frame beyond the paths themselves. */
(function (root) {
  'use strict';

  var TRACK = 8, SPEED = 90, BASE_R = 30, LIFT = 2, FLOOR = '#e7fff4';
  var TURN = Math.PI * 2, SMOOTH = 1.6;
  var BINS = 96, STEP = TURN / BINS;
  var SAMPLE = 3;                 /* trail point every this many units */

  /* [main, back, nick] for every entry of the game's playerColorPalette. */
  var COLORS = [
    ['#3b5998', '#2c4272', '#1e2c4c'], ['#8b9dc3', '#687692', '#454e61'], ['#2a4d69', '#20394f', '#152635'],
    ['#4b86b4', '#386587', '#26435a'], ['#8dbdff', '#6a8dbf', '#465e80'], ['#64a1f4', '#4b78b7', '#32507a'],
    ['#3b7dd8', '#2c5da2', '#1d3e6c'], ['#843b62', '#632c49', '#421d31'], ['#8874a3', '#66577a', '#443a51'],
    ['#8d5524', '#6a401b', '#462a12'], ['#c68642', '#956531', '#634321'], ['#f1c27d', '#b5925e', '#79613f'],
    ['#f77f00', '#b96000', '#7b4000'], ['#fcbf49', '#bd9037', '#7e6025'], ['#ffe066', '#bfa84d', '#807033'],
    ['#65737e', '#4c565e', '#323a3f'], ['#a7adba', '#7d828b', '#53575d'], ['#4a7c59', '#385d43', '#253e2d'],
    ['#1a936f', '#146e53', '#0d4a37'], ['#88d498', '#669f72', '#446a4c'], ['#2a9d8f', '#1f766c', '#154f48'],
    ['#68b0ab', '#4e8480', '#345856'], ['#99e550', '#72ac3c', '#4c7228'], ['#6abe30', '#508f24', '#365f18'],
    ['#4b692f', '#384f23', '#263518'], ['#8f974a', '#6b7138', '#484c25'], ['#8a6f30', '#685324', '#453818'],
    ['#524b24', '#3e381b', '#292612'], ['#d62828', '#a01e1e', '#6b1414'], ['#fe4a49', '#bf3737', '#7f2525'],
    ['#ed6a5a', '#b25043', '#76362d'], ['#ff3377', '#bf2659', '#80193b'], ['#ff77aa', '#bf5980', '#803c56'],
    ['#ff99cc', '#bf7399', '#804d66'], ['#b23a48', '#852b36', '#591d24'], ['#fcb9b2', '#bd8b85', '#7e5d59']
  ];

  function wrapA(a) {
    while (a > Math.PI) a -= TURN;
    while (a < -Math.PI) a += TURN;
    return a;
  }
  function binOf(a) {
    var f = (a / STEP) % BINS;
    return f < 0 ? f + BINS : f;
  }
  /* The ground's radius in direction a, read between the two nearest bins. */
  function radiusAt(u, a) {
    var f = binOf(a), i = Math.floor(f) % BINS, t = f - Math.floor(f);
    return u.r[i] * (1 - t) + u.r[(i + 1) % BINS] * t;
  }
  function inside(u, x, y) {
    var dx = x - u.cx, dy = y - u.cy;
    return dx * dx + dy * dy < Math.pow(radiusAt(u, Math.atan2(dy, dx)), 2);
  }
  function maxR(u) {
    var m = 0;
    for (var k = 0; k < BINS; k++) if (u.r[k] > m) m = u.r[k];
    return m;
  }

  /* A home spot clear of everybody else's ground, somewhere in the view. */
  function spawn(wd, u) {
    var best = null;
    for (var tries = 0; tries < 30; tries++) {
      var x = (wd.rnd() * 1.7 - 0.85) * wd.halfW, y = (wd.rnd() * 1.7 - 0.85) * wd.halfH;
      var ok = true;
      for (var i = 0; i < wd.units.length && ok; i++) {
        var o = wd.units[i];
        if (o === u || o.dead) continue;
        var near = Math.hypot(x - o.cx, y - o.cy) < maxR(o) + BASE_R + 24;
        if (near || inside(o, x, y)) ok = false;
      }
      best = { x: x, y: y };
      if (ok) break;
    }
    u.cx = u.x = best.x; u.cy = u.y = best.y;
    for (var k = 0; k < BINS; k++) u.r[k] = BASE_R;
    u.dir = wd.rnd() * TURN;
    u.trail.length = 0;
    u.out = false;
    u.plan = null;
    u.dead = 0;
    u.claimT = wd.t;
    u.col = COLORS[Math.floor(wd.rnd() * COLORS.length)];
  }

  /* The next loop, the way the game's bots run one: straight out of the
     ground, a turn and a run alongside it, and straight back in. */
  function planLoop(wd, u) {
    var a0 = Math.atan2(u.y - u.cy, u.x - u.cx) + (wd.rnd() - 0.5) * 1.2;
    var grown = maxR(u);
    var out = Math.min(30 + wd.rnd() * (50 + Math.min(90, grown * 0.5)), Math.max(24, wd.cap - grown));
    var side = out * (0.7 + wd.rnd() * 0.9) * (wd.rnd() < 0.5 ? -1 : 1);
    var ex = Math.cos(a0), ey = Math.sin(a0), d0 = radiusAt(u, a0) + out;
    var p1 = [u.cx + ex * d0, u.cy + ey * d0];
    var p2 = [p1[0] - ey * side, p1[1] + ex * side];
    var a2 = Math.atan2(p2[1] - u.cy, p2[0] - u.cx), back = radiusAt(u, a2) * 0.5;
    u.plan = [p1, p2, [u.cx + Math.cos(a2) * back, u.cy + Math.sin(a2) * back]];
  }

  /* Close the loop: every direction the trail swept is ground out to it. */
  function claim(wd, u) {
    var tr = u.trail;
    var prevA = null, prevD = 0;
    for (var i = 0; i < tr.length; i += 2) {
      var dx = tr[i] - u.cx, dy = tr[i + 1] - u.cy;
      var a = Math.atan2(dy, dx), d = Math.hypot(dx, dy);
      if (prevA === null) { prevA = a; prevD = d; continue; }
      var span = wrapA(a - prevA), n = Math.max(1, Math.ceil(Math.abs(span) / STEP));
      for (var s = 0; s <= n; s++) {
        var t = s / n, k = Math.round(binOf(prevA + span * t)) % BINS;
        var dd = prevD + (d - prevD) * t;
        if (dd > u.r[k]) u.r[k] = dd;
      }
      prevA = a; prevD = d;
    }
    u.claimT = wd.t;
    /* Whatever of anybody else's ground the new ground covers is theirs no
       more. Pulled in from the edge until it is clear; ground pulled in to
       nothing is a player out of the game. */
    for (var j = 0; j < wd.units.length; j++) {
      var o = wd.units[j];
      if (o === u || o.dead) continue;
      for (var b = 0; b < BINS; b++) {
        var ca = Math.cos(b * STEP), sa = Math.sin(b * STEP);
        while (o.r[b] > 0 && inside(u, o.cx + ca * o.r[b], o.cy + sa * o.r[b])) o.r[b] = Math.max(0, o.r[b] - 3);
      }
      if (maxR(o) < 10) kill(o);
    }
  }

  function kill(u) {
    if (!u.dead) { u.dead = 1e-6; u.trail.length = 0; u.plan = null; }
  }

  function make(w, h, S, rnd) {
    rnd = rnd || Math.random;
    var halfW = w / (2 * S), halfH = h / (2 * S);
    var n = Math.max(4, Math.min(12, Math.round((4 * halfW * halfH) / (210 * 210))));
    var wd = { paper: true, still: false, halfW: halfW, halfH: halfH, cam: S, t: 0, rnd: rnd,
      units: [], snakes: [], cells: [], food: [], cap: Math.min(halfW, halfH) * 0.75 };
    for (var i = 0; i < n; i++) {
      var u = { r: new Float32Array(BINS), trail: [], cx: 0, cy: 0, x: 0, y: 0, dir: 0 };
      wd.units.push(u);
      spawn(wd, u);
    }
    /* Run it for a while first, so the first frame is a game in progress and
       not everybody standing on a fresh start base. */
    for (var s = 0; s < 1200; s++) step(wd, 1 / 30);
    return wd;
  }

  function step(wd, dtSec) {
    if (!(dtSec > 0)) return;
    wd.t += dtSec;
    var units = wd.units, i, j, u;
    for (i = 0; i < units.length; i++) {
      u = units[i];
      if (u.dead) {
        u.dead += dtSec;
        if (u.dead > 1.8) spawn(wd, u);
        continue;
      }
      if (!u.plan) planLoop(wd, u);
      var wp = u.plan[0];
      var want = Math.atan2(wp[1] - u.y, wp[0] - u.x);
      var turn = wrapA(want - u.dir), cap = (TURN * dtSec) / SMOOTH;
      u.dir += Math.max(-cap, Math.min(cap, turn));
      u.x += Math.cos(u.dir) * SPEED * dtSec;
      u.y += Math.sin(u.dir) * SPEED * dtSec;
      if (Math.hypot(wp[0] - u.x, wp[1] - u.y) < 14) {
        u.plan.shift();
        if (!u.plan.length) u.plan = null;
      }
      var home = inside(u, u.x, u.y);
      if (!home) {
        if (!u.out) { u.out = true; u.trail.length = 0; u.trail.push(u.x, u.y); }
        var L = u.trail.length;
        if (Math.hypot(u.x - u.trail[L - 2], u.y - u.trail[L - 1]) >= SAMPLE) u.trail.push(u.x, u.y);
        /* Grown past what the view can hold: somebody cut it off. */
        if (maxR(u) > wd.cap) kill(u);
      } else if (u.out) {
        u.trail.push(u.x, u.y);
        claim(wd, u);
        u.out = false;
        u.trail.length = 0;
      }
    }
    /* A head across somebody's trail ends them, as in the game. */
    var hit = TRACK * 0.75;
    for (i = 0; i < units.length; i++) {
      u = units[i];
      if (u.dead || !u.out) continue;
      for (j = 0; j < units.length; j++) {
        var o = units[j];
        if (o === u || o.dead) continue;
        var tr = u.trail;
        for (var k = 0; k < tr.length; k += 4) {
          var dx = o.x - tr[k], dy = o.y - tr[k + 1];
          if (dx * dx + dy * dy < hit * hit) { kill(u); break; }
        }
        if (u.dead) break;
      }
    }
  }

  function groundPath(ctx, u, lift) {
    ctx.beginPath();
    for (var k = 0; k < BINS; k++) {
      var x = u.cx + Math.cos(k * STEP) * u.r[k], y = u.cy + Math.sin(k * STEP) * u.r[k] - lift;
      if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.closePath();
  }
  function square(ctx, x, y, a, side, fill) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a + Math.PI / 2);
    ctx.fillStyle = fill;
    ctx.fillRect(-side / 2, -side / 2, side, side);
    ctx.restore();
  }
  /* Ground that has just been lost fades out instead of blinking off. */
  function alphaOf(u) {
    return u.dead ? Math.max(0, 1 - u.dead / 0.5) : 1;
  }

  function paint(ctx, wd, w, h) {
    var S = wd.cam, order = wd.units.slice().sort(function (a, b) { return a.claimT - b.claimT; });
    var i, u;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = FLOOR;
    ctx.fillRect(0, 0, w, h);
    ctx.setTransform(S, 0, 0, S, w / 2, h / 2);
    for (i = 0; i < order.length; i++) {
      u = order[i]; ctx.globalAlpha = alphaOf(u);
      if (!ctx.globalAlpha) continue;
      groundPath(ctx, u, 0); ctx.fillStyle = u.col[1]; ctx.fill();
    }
    for (i = 0; i < order.length; i++) {
      u = order[i]; ctx.globalAlpha = alphaOf(u);
      if (!ctx.globalAlpha) continue;
      groundPath(ctx, u, LIFT); ctx.fillStyle = u.col[0]; ctx.fill();
    }
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = TRACK;
    ctx.globalAlpha = 0.6;
    for (i = 0; i < order.length; i++) {
      u = order[i];
      if (u.dead || !u.out || u.trail.length < 2) continue;
      var tr = u.trail;
      ctx.beginPath();
      ctx.moveTo(tr[0], tr[1]);
      for (var k = 2; k < tr.length; k += 2) ctx.lineTo(tr[k], tr[k + 1]);
      ctx.lineTo(u.x, u.y);
      ctx.strokeStyle = u.col[0];
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    for (i = 0; i < order.length; i++) {
      u = order[i];
      if (u.dead) continue;
      square(ctx, u.x, u.y, u.dir, TRACK, u.col[2]);
      square(ctx, u.x, u.y - LIFT, u.dir, TRACK, u.col[1]);
      square(ctx, u.x, u.y - LIFT, u.dir, TRACK * 0.8, u.col[0]);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  var api = { make: make, step: step, paint: paint, COLORS: COLORS, inside: inside, maxR: maxR,
    consts: { TRACK: TRACK, SPEED: SPEED, BASE_R: BASE_R, LIFT: LIFT, FLOOR: FLOOR } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.V2PaperBg = api;
})(typeof window !== 'undefined' ? window : globalThis);
