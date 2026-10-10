/*
 * slDrawSnake.js: snake names, the visibility pass, snake bodies (render_mode 1 lines and render_mode 2 sprite
 * circles), the antenna, the death flash, head parts and eyes. Canvas 2D only.
 *
 * Built from our own spec of their desktop web client (draw-snake.md section 3). Every canvas call, argument and
 * order matches theirs, including calls that do nothing (an alpha above 1, a stroke style set then replaced), so the
 * call log of one frame is identical. Float math keeps their operator order; do not regroup or pre-fold literals.
 *
 * Load order: after slDrawWorld.js, before slHud.js. Nothing runs at load; slMain.boot calls initDrawSnake().
 * Reads S (the mirrored state object) and the sprite canvases slSprites built. Draws no random numbers of its own:
 * the antenna jitter uses the rand passed in (DuelSlither.rand, looked up at call time).
 */
(function (root) {
  'use strict';
  var D = root.DuelSlither = root.DuelSlither || {};

  var TAU = 2 * Math.PI; // game.js:125
  var BUF_LEN = 32767; // game.js:3320-3323
  var NAME_FONT = '15px Arial, Helvetica Neue, Helvetica, sans-serif'; // game.js:5363

  // Circle buffers shared by every snake and every frame, never cleared (game.js:3320-3323).
  // pbx/pby/pba are float32 on purpose: every translate and rotate argument is read back from them.
  var pbx = null;
  var pby = null;
  var pba = null;
  var pbu = null; // 2 = draw, 1 = drez gap (body pass only), else skip; off-box slots keep old values (quirk K1)
  var at2lt = null; // antenna angle lookup, game.js:3984-3986

  var api = {
    initDrawSnake: initDrawSnake,
    drawNames: drawNames,
    updateVisibility: updateVisibility,
    drawSnakes: drawSnakes,
    drawEyes: drawEyes,
    // Read only views of the buffers (set by initDrawSnake).
    pbx: null,
    pby: null,
    pba: null,
    pbu: null,
    at2lt: null,
    // Optional harness and test probe: called as geoHook(o, bp, q, cap) after a render_mode 2 snake fills the
    // buffers (the point their 5877 line starts the passes). Null in play.
    geoHook: null
  };

  function initDrawSnake(S) {
    if (S === undefined) S = D.S;
    pbx = new Float32Array(BUF_LEN);
    pby = new Float32Array(BUF_LEN);
    pba = new Float32Array(BUF_LEN);
    pbu = new Uint8Array(BUF_LEN);
    at2lt = new Float32Array(65536);
    for (var y = 0; y < 256; y++) {
      for (var x = 0; x < 256; x++) at2lt[(y << 8) | x] = Math.atan2(y - 128, x - 128);
    }
    api.pbx = pbx;
    api.pby = pby;
    api.pba = pba;
    api.pbu = pbu;
    api.at2lt = at2lt;
    if (S) {
      S.pbx = pbx;
      S.pby = pby;
      S.pba = pba;
      S.pbu = pbu;
      S.at2lt = at2lt;
    }
  }

  // Sprite canvases live on S (slSprites); fall back to the slSprites module object.
  function sprite(S, name) {
    var v = S[name];
    if (v == null && D.slSprites) v = D.slSprites[name];
    return v;
  }

  // ------------------------------------------------------------------ small shared math

  // 0..1 boost level of speed `speed` between the snake's ssp and msp (game.js:5491, 5887).
  function boostLevel(o, speed) {
    return Math.max(0, Math.min(1, (speed - o.ssp) / (o.msp - o.ssp)));
  }

  // Death pulse: `base` plus `base` times a fast sine, all under a slow sine of dead_amt (game.js:5517, 6369).
  function deathPulse(o, base) {
    return (base + base * Math.abs(Math.sin(5 * Math.PI * o.dead_amt))) * Math.sin(Math.PI * o.dead_amt);
  }

  // Midpoint of a and b in their operator order.
  function half(a, b) {
    return a + (b - a) * .5;
  }

  // One axis of the quadratic piece a -> b -> c at t: two lerps, then a lerp between them.
  function bend(a, b, c, t) {
    var u = a + (b - a) * t;
    var w = b + (c - b) * t;
    return u + (w - u) * t;
  }

  // Wraps an angle difference into -PI..PI the way their bulb does (game.js:6348-6350).
  function wrapTurn(v) {
    if (v < 0 || v >= TAU) v %= TAU;
    if (v < -Math.PI) v += TAU;
    else if (v > Math.PI) v -= TAU;
    return v;
  }

  // ------------------------------------------------------------------ names (game.js:5339-5385)

  function drawNames(S, ctx) {
    var list = S.slithers;
    var gsc = S.gsc;
    for (var i = list.length - 1; i >= 0; i--) {
      var o = list[i];
      var nx = o.xx + o.fx;
      var ny = o.yy + o.fy + 40;
      if (!(o.na > 0)) continue;
      if (!(nx >= S.bpx1 - 100 && ny >= S.bpy1 && nx <= S.bpx2 + 100 && ny <= S.bpy2)) continue;
      // Own name fades after 200 drawn redraws (counted per redraw, not per time; quirk K9).
      if (o == S.slither) fadeOwnName(o);
      ctx.save();
      ctx.globalAlpha = .5 * o.na * o.alive_amt * (1 - o.dead_amt);
      ctx.font = NAME_FONT;
      ctx.fillStyle = o.csw;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      var headX = o.xx + o.fx;
      var headY = o.yy + o.fy;
      ctx.fillText(o.nk, S.mww2 + (headX - S.view_xx) * gsc,
        S.mhh2 + (headY - S.view_yy) * gsc + 32 + 11 * o.sc * gsc);
      ctx.restore();
    }
  }

  function fadeOwnName(o) {
    o.fnfr++;
    if (!(o.fnfr > 200)) return;
    o.na -= .004;
    if (o.na < 0) o.na = 0;
  }

  // ------------------------------------------------------------------ visibility (game.js:5386-5403)

  function updateVisibility(S) {
    var list = S.slithers;
    for (var i = list.length - 1; i >= 0; i--) {
      var o = list[i];
      var seen = anyPointInBox(S, o.pts);
      // `iiv` is created here on the first redraw (undefined != false), game.js:5399-5401.
      if (o.iiv != seen) {
        o.iiv = seen;
        if (seen) {
          o.ehang = o.ang;
          o.wehang = o.ang;
        }
      }
    }
  }

  // True when any body point (with its fx/fy) is inside the draw box bpx1..bpy2, searched from the head end.
  function anyPointInBox(S, pts) {
    for (var i = pts.length - 1; i >= 0; i--) {
      var p = pts[i];
      var x = p.xx + p.fx;
      var y = p.yy + p.fy;
      if (x >= S.bpx1 && y >= S.bpy1 && x <= S.bpx2 && y <= S.bpy2) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ all snakes (game.js:5404-6495)

  function drawSnakes(S, ctx, rand) {
    var rnd = typeof rand === 'function' ? rand : D.rand;
    var list = S.slithers;
    // Scratch that their redraw keeps in function scope and does NOT reset per snake (quirks K2, K3, K4):
    // `cap` (how many circles get measured), `pieceDone`, and the point two back (p3x/p3y) carry from one snake to
    // the next within one redraw. tx/ty is the closeness tracker.
    var F = { cap: undefined, pieceDone: undefined, p3x: undefined, p3y: undefined, tx: 0, ty: 0 };
    for (var i = list.length - 1; i >= 0; i--) {
      var o = list[i];
      if (!o.iiv) continue;
      var headX = o.xx + o.fx;
      var headY = o.yy + o.fy;
      var faceAng = o.ehang; // read before the mode 2 geometry rewrites wehang
      var scale = o.sc;
      var width = 29 * scale; // game.js:5422
      if (S.render_mode == 1) drawLineBody(S, ctx, o, headX, headY, width);
      if (S.render_mode == 2) drawCircleBody(S, ctx, o, headX, headY, width * .5, F, rnd); // halved, game.js:5532
      drawHeadParts(S, ctx, o, headX, headY, faceAng, scale);
    }
  }

  // ------------------------------------------------------------------ render_mode 1 (game.js:5425-5530)

  function drawLineBody(S, ctx, o, headX, headY, width) {
    var gsc = S.gsc;
    var mww2 = S.mww2;
    var mhh2 = S.mhh2;
    var vx = S.view_xx;
    var vy = S.view_yy;
    function sx(x) { return mww2 + (x - vx) * gsc; }
    function sy(y) { return mhh2 + (y - vy) * gsc; }

    var pts = o.pts;
    var budget = o.cfl;
    var x = headX;
    var y = headY;
    var backX, backY, midX, midY, oldMidX, oldMidY, pull;
    var started = false;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(sx(x), sy(y));
    for (var i = pts.length - 1; i >= 0; i--) {
      var p = pts[i];
      backX = x;
      backY = y;
      x = p.xx;
      y = p.yy;
      if (!(budget > 0)) continue;
      x += p.fx;
      y += p.fy;
      oldMidX = midX;
      oldMidY = midY;
      midX = (x + backX) / 2;
      midY = (y + backY) / 2;
      if (!started) {
        oldMidX = midX;
        oldMidY = midY;
      }
      // The last drawn piece is pulled back by what is left of the length budget.
      if (budget < 1) {
        pull = 1 - budget;
        backX += (oldMidX - backX) * pull;
        backY += (oldMidY - backY) * pull;
        midX += (oldMidX - midX) * pull;
        midY += (oldMidY - midY) * pull;
      }
      // The first piece spends the head part (chl + fchl), every later one a whole point.
      budget -= started ? 1 : o.chl + o.fchl;
      if (started) {
        ctx.quadraticCurveTo(sx(backX), sy(backY), sx(midX), sy(midY));
      } else {
        ctx.lineTo(sx(midX), sy(midY));
        started = true;
      }
    }
    var life = 1 - o.dead_amt;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    // Boost glow keys off the raw sp here (not tsp), game.js:5490.
    if (o.sp > o.fsp) {
      var glow = o.alive_amt * life * boostLevel(o, o.sp);
      ctx.save();
      ctx.lineWidth = (width - 2) * gsc;
      ctx.shadowBlur = 30 * gsc;
      ctx.shadowColor = 'rgba(' + o.rr + ',' + o.gg + ',' + o.bb + ', ' + Math.round(1E4 * glow) / 1E4 + ')';
      ctx.stroke();
      ctx.stroke();
      ctx.restore();
    }
    // Outline, then body. Their sequence sets strokeStyle three times around the second stroke; kept as is.
    ctx.globalAlpha = .4 * o.alive_amt * life;
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = (width + 5) * gsc;
    ctx.stroke();
    ctx.strokeStyle = o.cs;
    ctx.lineWidth = width * gsc;
    ctx.strokeStyle = '#000000';
    ctx.globalAlpha = 1 * o.alive_amt * life;
    ctx.stroke();
    ctx.strokeStyle = o.cs;
    ctx.globalAlpha = .8 * o.alive_amt * life;
    ctx.lineWidth = width * gsc;
    ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = o.cs;
    if (o.dead) {
      var pulse = deathPulse(o, .5);
      ctx.save();
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineWidth = (width - 3) * gsc;
      ctx.globalAlpha = pulse;
      ctx.strokeStyle = '#FFCC99';
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  // ------------------------------------------------------------------ render_mode 2 geometry (game.js:5531-5876)
  //
  // The body is laid as a run of circles from the head back. A walker W carries the length budget and counters:
  //   left      budget still to spend, in body points (starts at cfl)
  //   step      budget one circle costs (1 / circles per point)
  //   carry     where the next circle falls inside the current curve piece (a fraction of that piece)
  //   stage     0 laying, 1 the next circle is the last one, 2 finished
  //   count     circles placed (pooled slots used)
  //   measured  circles whose spacing feeds the head re-spacing; prev is the last of them

  // Pooled circle point per snake (their arp, game.js:2642-2655). Stale .d/.ox/.oy survive on reused objects.
  function slot(o, index, x, y) {
    var c;
    if (index < o.gptz.length) {
      c = o.gptz[index];
      c.xx = x;
      c.yy = y;
      return c;
    }
    c = {};
    c.xx = x;
    c.yy = y;
    o.gptz.push(c);
    return c;
  }

  function gap(a, b) {
    return Math.sqrt(Math.pow(a.xx - b.xx, 2) + Math.pow(a.yy - b.yy, 2));
  }

  // The closeness of two circle centres: 1 when far apart, less when they overlap on screen (5901-5910).
  function closeness(tx, ty, ox, oy) {
    var v = tx > ox ? tx - ox : ox - tx;
    v += ty > oy ? ty - oy : oy - ty;
    v /= 6;
    if (v > 1) v = 1;
    return v;
  }

  // Moves the tracker to circle c and returns its closeness to the previous tracked position.
  function track(F, c) {
    var ox = F.tx;
    var oy = F.ty;
    F.tx = pbx[c];
    F.ty = pby[c];
    return closeness(F.tx, F.ty, ox, oy);
  }

  // Sizes of the first 4 circles grow with o.swell (skin 27 only; 0 elsewhere).
  function swollen(s, c, o) {
    return c < 4 ? s * (1 + (4 - c) * o.swell) : s;
  }

  // sep eases toward wsep by .0035 per redraw, only here (iiv snakes, mode 2), game.js:5544-5551.
  function easeSep(o) {
    if (o.sep < o.wsep) {
      o.sep += .0035;
      if (o.sep >= o.wsep) o.sep = o.wsep;
    } else if (o.sep > o.wsep) {
      o.sep -= .0035;
      if (o.sep <= o.wsep) o.sep = o.wsep;
    }
  }

  function place(o, W, x, y) {
    var c = slot(o, W.count, x, y);
    W.count++;
    return c;
  }

  function measure(W, c, dist) {
    c.d = dist;
    W.prev = c;
    W.measured++;
  }

  // True (and the walk finished) when the circle just placed was the last one.
  function finishing(W) {
    if (W.stage != 1) return false;
    W.stage = 2;
    return true;
  }

  // Charges one circle to the budget. When the budget runs out the next circle becomes the last, and only the part
  // of the step that was still covered (step plus the overdrawn budget) is returned.
  function charge(W) {
    W.left -= W.step;
    if (W.left <= 0) {
      W.stage = 1;
      return W.step + W.left;
    }
    return W.step;
  }

  // A budget less than 1E-4 below zero counts as exactly spent (game.js:5655, 5697, 5770, 5802).
  function snapLeft(W) {
    if (W.left >= -1E-4 && W.left <= 0) W.left = 0;
  }

  function stillLaying(W) {
    return W.left >= 0 || W.stage == 1;
  }

  // Walks the body and fills pbx/pby/pba/pbu from slot 0. Returns the circle count.
  function layCircles(S, o, headX, headY, F) {
    var pts = o.pts;
    var n = pts.length;
    var pool = o.gptz;
    easeSep(o);

    F.tx = 0;
    F.ty = 0;
    var unit = o.msl; // world length of one body point
    var perUnit = 6 / (S.qsm * o.sep / 6); // circles per point, game.js:5579
    if (o.drez) perUnit *= 2;
    var basePerUnit = perUnit;
    var spacing = unit / perUnit;
    var W = { left: o.cfl, step: 1 / perUnit, carry: 0, stage: 0, count: 0, measured: 0, prev: null };
    var c, t, span;

    // Neck: the head may sit up to msl ahead of the first body point (game.js:5585-5620).
    var front = pts[n - 1];
    var frontX = front.xx + front.fx;
    var frontY = front.yy + front.fy;
    var reach = Math.sqrt(Math.pow(headX - frontX, 2) + Math.pow(headY - frontY, 2));
    var dirX = (headX - frontX) / reach;
    var dirY = (headY - frontY) / reach;
    var neck = reach / unit;
    var second = pts[n - 2];
    if (second) {
      F.p3x = second.xx + second.fx;
      F.p3y = second.yy + second.fy;
    }
    var x0 = headX; // start of the current curve piece
    var y0 = headY;
    var ctlX = frontX; // its control point
    var ctlY = frontY;
    if (reach > unit) {
      x0 = ctlX + dirX * unit;
      y0 = ctlY + dirY * unit;
    }
    var fromX = half(x0, ctlX);
    var fromY = half(y0, ctlY);
    if (neck < 1) {
      fromX += (x0 - fromX) * (1 - neck);
      fromY += (y0 - fromY) * (1 - neck);
    }
    var toX = half(F.p3x, ctlX);
    var toY = half(F.p3y, ctlY);
    var straight = Math.sqrt(Math.pow(headX - fromX, 2) + Math.pow(headY - fromY, 2));

    // Phase 1: straight run back from the head (game.js:5621-5653). Circle 0 is the head and spends no length.
    var along = spacing;
    var steps = 1;
    measure(W, place(o, W, headX, headY), 0);
    while (along < straight) {
      F.tx = headX - steps * dirX * spacing;
      F.ty = headY - steps * dirY * spacing;
      measure(W, place(o, W, F.tx, F.ty), spacing);
      if (finishing(W)) break;
      var covered = charge(W);
      if (W.stage == 1) {
        var part = covered / W.step;
        steps += part;
        along += spacing * part;
      } else {
        steps++;
        along += spacing;
      }
    }
    W.carry = (along - straight) / unit;

    // Phase 2: the neck curve (game.js:5654-5698). Running out here zeroes the budget (quirk K11).
    if (W.stage <= 1) {
      snapLeft(W);
      if (stillLaying(W)) {
        if (neck < 1) {
          ctlX += (toX - ctlX) * .5 * (1 - neck);
          ctlY += (toY - ctlY) * .5 * (1 - neck);
        }
        span = .5 + neck - straight / unit;
        while (W.carry >= 0 && W.carry < span) {
          t = W.carry / span;
          c = place(o, W, bend(fromX, ctlX, toX, t), bend(fromY, ctlY, toY, t));
          measure(W, c, gap(c, W.prev));
          if (finishing(W)) break;
          W.carry += charge(W);
          if (W.stage == 1) W.left = 0;
        }
        W.carry -= span;
      }
      snapLeft(W);
    }

    // Phase 3: the body, one quadratic piece per point (game.js:5699-5768).
    var lastPiece = n;
    if (W.stage <= 1) {
      if (stillLaying(W)) {
        F.pieceDone = false;
        var owed = 0; // the previous piece's leftover, in circles
        var cur = pts[lastPiece - 1];
        for (var i = n - 1; i >= 2 && W.stage < 2; i--) {
          lastPiece = i;
          var after = cur;
          var p3 = pts[i - 2];
          var p2 = pts[i - 1];
          cur = pts[i];
          x0 = cur.xx + cur.fx;
          y0 = cur.yy + cur.fy;
          ctlX = p2.xx + p2.fx;
          ctlY = p2.yy + p2.fy;
          F.p3x = p3.xx + p3.fx;
          F.p3y = p3.yy + p3.fy;
          fromX = half(x0, ctlX);
          fromY = half(y0, ctlY);
          toX = half(ctlX, F.p3x);
          toY = half(ctlY, F.p3y);
          span = cur.ltn + cur.fltn;
          F.cap = basePerUnit * 2 + 2; // game.js:5723
          if (cur.smu != after.smu || cur.fsmu != after.fsmu) {
            W.carry *= (after.smu + after.fsmu) / (cur.smu + cur.fsmu);
            W.step = 1 / (basePerUnit * (cur.smu + cur.fsmu));
          }
          W.left -= owed * W.step;
          while (W.carry < span) {
            t = W.carry / span;
            c = place(o, W, bend(fromX, ctlX, toX, t), bend(fromY, ctlY, toY, t));
            if (W.measured <= F.cap) measure(W, c, gap(c, W.prev));
            if (finishing(W)) break;
            W.carry += charge(W);
          }
          W.carry -= span;
          owed = W.carry / W.step;
          W.left += W.carry;
          F.pieceDone = true;
        }
      }
      if (F.pieceDone) W.left -= W.carry;
    }

    // Phase 4: the tail tip, extrapolated past the last point (game.js:5769-5805). A 1-point snake throws here,
    // exactly as theirs does (there is no point before the last); our server never sends one.
    if (W.stage <= 1) {
      snapLeft(W);
      if (stillLaying(W)) {
        var last = pts[lastPiece - 1];
        var before = pts[lastPiece - 2];
        if (last) {
          x0 = last.xx + last.fx;
          y0 = last.yy + last.fy;
        }
        ctlX = before.xx + before.fx;
        ctlY = before.yy + before.fy;
        while (stillLaying(W)) {
          c = place(o, W, ctlX - (x0 - ctlX) * (W.carry - .5), ctlY - (y0 - ctlY) * (W.carry - .5));
          if (W.measured <= F.cap) measure(W, c, gap(c, W.prev));
          if (finishing(W)) break;
          W.carry += charge(W);
          snapLeft(W);
        }
      }
    }

    respaceHead(pool, W.measured - 1);
    fillBuffers(S, o, pool, W.count, F);
    if (W.count >= 2) {
      pba[0] = pba[1];
      o.wehang = pba[1] + Math.PI;
    } else {
      o.wehang = o.ang;
    }
    if (api.geoHook) api.geoHook(o, W.count, W.count, F.cap);
    return W.count;
  }

  // Head re-spacing: evens out the first `count` circles along their own path, easing back toward the old spot the
  // further a circle is from the head (game.js:5806-5848).
  function respaceHead(pool, count) {
    if (count >= pool.length) count = pool.length;
    if (!(count >= 3)) return;
    var total = 0;
    var i;
    for (i = 0; i < count - 1; i++) total += pool[i].d;
    var even = total / (count - 2);
    for (i = 0; i < count; i++) {
      pool[i].ox = pool[i].xx;
      pool[i].oy = pool[i].yy;
    }
    var from = pool[0];
    var next = 1;
    var dist = even;
    for (i = 1; i < count; i++) {
      var c = pool[i];
      for (;;) {
        var to = pool[next];
        if (dist < to.d) {
          c.xx = from.ox + (to.ox - from.ox) * dist / to.d;
          c.yy = from.oy + (to.oy - from.oy) * dist / to.d;
          c.xx += (c.ox - c.xx) * Math.pow(i / count, 2);
          c.yy += (c.oy - c.yy) * Math.pow(i / count, 2);
          dist += even;
          break;
        }
        dist -= to.d;
        from = to;
        next++;
        if (next >= count) return;
      }
    }
  }

  // Buffers and angles (game.js:5849-5876). The float32 store rounds; the angle uses the float64 deltas.
  // With drez every third circle (counting 3, 2, 1 from the head) is marked 1: drawn by the body pass only.
  function fillBuffers(S, o, pool, count, F) {
    var thin = o.drez;
    var beat = 0;
    var lastX = 0;
    var lastY = 0;
    for (var i = 0; i < count; i++) {
      var x = pool[i].xx;
      var y = pool[i].yy;
      pbx[i] = x;
      pby[i] = y;
      pba[i] = 0;
      if (thin) {
        beat--;
        if (beat <= 0) beat = 3;
      }
      if (x >= S.bpx1 && y >= S.bpy1 && x <= S.bpx2 && y <= S.bpy2) pbu[i] = (thin && beat != 3) ? 1 : 2;
      if (i >= 1) {
        F.tx = x - lastX;
        F.ty = y - lastY;
        pba[i] = Math.atan2(F.ty, F.tx);
      }
      lastX = x;
      lastY = y;
    }
  }

  // ------------------------------------------------------------------ render_mode 2 passes (game.js:5877-6396)

  // Moves the context to the tracked circle (world to screen; the mww2/mhh2 translate is already applied).
  function toTracked(ctx, F, vx, vy, gsc) {
    ctx.translate((F.tx - vx) * gsc, (F.ty - vy) * gsc);
  }

  // Draws img centred on the origin with half-size r.
  function stamp(ctx, img, r) {
    ctx.drawImage(img, -r, -r, 2 * r, 2 * r);
  }

  // Same, with the half-size given in world units and the zoom g applied in their argument order.
  function stampZoomed(ctx, img, g, r) {
    ctx.drawImage(img, -g * r, -g * r, g * 2 * r, g * 2 * r);
  }

  // The colour set of circle i: the stripe colour when the skin has stripes (rbcs), else the snake's own set.
  function setFor(sets, stripes, own, i) {
    return stripes ? sets[stripes[i % stripes.length]] : own;
  }

  // Sprite frame for circle i. Frames run 0..n-1 then back down when the set ping-pongs (klp), else loop; custom
  // skins always use frame 0.
  function frameOf(o, i, n, pingPong) {
    if (o.cusk) return 0;
    if (!pingPong) return i % n;
    var f = i % (n * 2);
    return f >= n ? n * 2 - (f + 1) : f;
  }

  function drawCircleBody(S, ctx, o, headX, headY, rad, F, rnd) {
    var count = layCircles(S, o, headX, headY, F);
    var gsc = S.gsc;
    var vx = S.view_xx;
    var vy = S.view_yy;
    var sets = S.per_color_imgs;
    var own = sets[o.cv];
    var stripes = o.rbcs;
    var wave = o.drez ? 12 : 4; // game.js:5877-5878
    var fancy = S.high_quality || S.gla > 0;
    var i, near, r;

    ctx.save();
    ctx.translate(S.mww2, S.mhh2);
    var ringR = gsc * rad * 52 / 32;
    var shadowR = gsc * rad * 62 / 32;
    var vis = o.alive_amt * (1 - o.dead_amt);
    vis *= vis;
    var outline = 1;
    var overlay = 0;

    // A. Boost underlay, not quality gated (game.js:5886-5946).
    if (o.tsp > o.fsp) {
      var level = o.alive_amt * (1 - o.dead_amt) * boostLevel(o, o.tsp);
      overlay = level * .37;
      var levelRoot = Math.pow(level, .5);
      var glowR = 1.5 * gsc * rad * (1 + (62 / 32 - 1) * levelRoot);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (i = count - 1; i >= 0; i--) {
        if (pbu[i] != 2) continue;
        near = track(F, i);
        var glowImg = setFor(sets, stripes, own, i).kfmc;
        ctx.save();
        ctx.globalAlpha = near * vis * levelRoot * .38 * (.6 + .4 * Math.cos(i / wave - 1.15 * o.sfr));
        toTracked(ctx, F, vx, vy, gsc);
        stamp(ctx, glowImg, swollen(glowR, i, o));
        ctx.restore();
      }
      ctx.restore();
      outline = 1 - level; // the outline fades out while boosting
    }

    // B. Outline rings and the head shadow (game.js:5947-6001).
    var bodyAlpha = vis * outline;
    var ringImg = sprite(S, 'komc');
    var shadowImg = sprite(S, 'ksmc');
    if (fancy) {
      ctx.globalAlpha = S.gla != 1 ? bodyAlpha * S.gla : bodyAlpha;
      for (i = count - 1; i >= 0; i--) {
        if (pbu[i] != 2) continue;
        near = track(F, i);
        ctx.save();
        toTracked(ctx, F, vx, vy, gsc);
        stamp(ctx, ringImg, ringR);
        if (i < 9) {
          ctx.globalAlpha = near * vis * (1 - i / 9);
          stamp(ctx, shadowImg, swollen(shadowR, i, o));
        }
        ctx.restore();
      }
      // The last 4 circles again. Their alpha can exceed 1 on long snakes; it is still assigned (quirk K5).
      for (var back = 1; back <= 4; back++) {
        i = count - back;
        if (!(i >= 0 && i < count && pbu[i] == 2)) continue;
        near = track(F, i);
        ctx.save();
        toTracked(ctx, F, vx, vy, gsc);
        stamp(ctx, ringImg, ringR);
        ctx.globalAlpha = near * vis * (i / 9);
        stamp(ctx, shadowImg, swollen(shadowR, i, o));
        ctx.restore();
      }
    }

    // C. Body sprites with the shadow 4 circles behind each (game.js:6002-6077 patterned, 6113-6161 plain).
    ctx.globalAlpha = bodyAlpha;
    var frames = own.kmcs;
    var nFrames = frames.length;
    var pingPong = own.klp; // from o.cv's set even for stripes (quirk K10)
    var flat = S.nsr;
    for (i = count - 1; i >= 0; i--) {
      if (!(pbu[i] >= 1)) continue;
      var cx = pbx[i];
      var cy = pby[i];
      if (i >= 4 && pbu[i - 4] == 2) shadowBehind(ctx, F, o, i - 4, vis, shadowImg, shadowR, vx, vy, gsc);
      ctx.save();
      ctx.globalAlpha = vis;
      ctx.translate((cx - vx) * gsc, (cy - vy) * gsc);
      if (!flat) ctx.rotate(pba[i]);
      var f = frameOf(o, i, nFrames, pingPong);
      stampZoomed(ctx, stripes ? setFor(sets, stripes, own, i).kmcs[f] : frames[f], gsc, swollen(rad, i, o));
      if (stripes) {
        // Skin 60 head and tail fades (game.js:6062-6076); no i < 4 guard on the swell factor here.
        if (o.fdhc && i < o.fdl) capFade(ctx, sets[o.fdhc], vis, 1 - i / o.fdl, rad, i, o, gsc);
        if (o.fdtc && i > count - o.fdl) capFade(ctx, sets[o.fdtc], vis, 1 - (count - i) / o.fdl, rad, i, o, gsc);
      }
      ctx.restore();
    }

    // D. Boost overlay, quality gated (game.js:6078-6112 patterned, 6162-6197 plain).
    if (o.tsp > o.fsp && fancy) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      var overR = rad * 2;
      for (i = count - 1; i >= 0; i--) {
        if (pbu[i] != 2) continue;
        near = track(F, i);
        ctx.save();
        toTracked(ctx, F, vx, vy, gsc);
        ctx.globalAlpha = near * vis * overlay * S.gla * (.5 + .5 * Math.cos(i / wave - o.sfr));
        r = swollen(overR, i, o);
        stampZoomed(ctx, setFor(sets, stripes, own, i).kfmc, gsc, r);
        ctx.restore();
      }
      ctx.restore();
    }

    // E. Antenna (game.js:6235-6365).
    if (o.antenna) drawAntenna(S, ctx, o, headX, headY, count, vis, F, rnd);

    // F. Death flash (game.js:6366-6394).
    if (o.dead) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      var pulse = deathPulse(o, .15);
      var flashR = gsc * rad;
      var flashImg = sprite(S, 'kdmc');
      for (i = count - 1; i >= 0; i--) {
        if (pbu[i] != 2) continue;
        near = track(F, i);
        ctx.save();
        ctx.globalAlpha = near * pulse * (.6 + .4 * Math.cos(i / 4 - 15 * o.dead_amt));
        toTracked(ctx, F, vx, vy, gsc);
        stamp(ctx, flashImg, swollen(flashR, i, o));
        ctx.restore();
      }
      ctx.restore();
    }

    ctx.restore(); // game.js:6395
  }

  // The shadow under circle `at` (4 behind the body circle being drawn). Near the head it fades by position and
  // the tracker moves without a fresh closeness (quirk K6); further back it uses the closeness.
  function shadowBehind(ctx, F, o, at, vis, img, shadowR, vx, vy, gsc) {
    var near = track(F, at);
    ctx.save();
    toTracked(ctx, F, vx, vy, gsc);
    if (at < 9) {
      ctx.globalAlpha = vis * (at / 9);
      stamp(ctx, img, swollen(shadowR, at, o));
    } else {
      ctx.globalAlpha = vis * near;
      stamp(ctx, img, shadowR);
    }
    ctx.restore();
  }

  // One skin 60 end fade: the end colour's first frame, a little larger, at alpha vis * amt.
  function capFade(ctx, set, vis, amt, rad, i, o, gsc) {
    ctx.globalAlpha = vis * amt;
    stampZoomed(ctx, set.kmcs[0], gsc, (1 + .05 * amt) * rad * (1 + (4 - i) * o.swell));
  }

  // ------------------------------------------------------------------ antenna (game.js:6235-6365)

  // Angle of (dx, dy) through the at2lt table at the finest scale that fits, else atan2 (game.js:6263-6267).
  function lookAngle(dx, dy) {
    if (dx >= -4 && dy >= -4 && dx < 4 && dy < 4) return at2lt[((dy * 32 + 128) << 8) | (dx * 32 + 128)];
    if (dx >= -8 && dy >= -8 && dx < 8 && dy < 8) return at2lt[((dy * 16 + 128) << 8) | (dx * 16 + 128)];
    if (dx >= -16 && dy >= -16 && dx < 16 && dy < 16) return at2lt[((dy * 8 + 128) << 8) | (dx * 8 + 128)];
    if (dx >= -127 && dy >= -127 && dx < 127 && dy < 127) return at2lt[((dy + 128) << 8) | (dx + 128)];
    return Math.atan2(dy, dx);
  }

  // One link of the antenna chain (game.js:6256-6288): aim from the jittered previous link (two random draws, x
  // first) toward this link, spring toward the point 4 * sc out along that aim, damp the speed, then clamp the
  // link length to 4 * sc. The tracker F ends on the last delta.
  function springLink(o, lx, ly, lvx, lvy, i, F, rnd) {
    var aimX = lx[i - 1] + (rnd() * 2 - 1);
    var aimY = ly[i - 1] + (rnd() * 2 - 1);
    F.tx = lx[i] - aimX;
    F.ty = ly[i] - aimY;
    var ang = lookAngle(F.tx, F.ty);
    aimX += Math.cos(ang) * 4 * o.sc;
    aimY += Math.sin(ang) * 4 * o.sc;
    lvx[i] += (aimX - lx[i]) * .1;
    lvy[i] += (aimY - ly[i]) * .1;
    lx[i] += lvx[i];
    ly[i] += lvy[i];
    lvx[i] *= .88;
    lvy[i] *= .88;
    F.tx = lx[i] - lx[i - 1];
    F.ty = ly[i] - ly[i - 1];
    if (Math.sqrt(F.tx * F.tx + F.ty * F.ty) > 4 * o.sc) {
      ang = lookAngle(F.tx, F.ty);
      lx[i] = lx[i - 1] + Math.cos(ang) * 4 * o.sc;
      ly[i] = ly[i - 1] + Math.sin(ang) * 4 * o.sc;
    }
  }

  // Adds (x, y) to the path only when it is at least 1 px (sum of both axes) from the last point added.
  function lineIfMoved(ctx, F, x, y) {
    if (Math.abs(x - F.tx) + Math.abs(y - F.ty) >= 1) {
      F.tx = x;
      F.ty = y;
      ctx.lineTo(F.tx, F.ty);
    }
  }

  // Starts a path at link `from` and walks the links down to `to` (inclusive) through lineIfMoved.
  function linkPath(ctx, F, lx, ly, from, to, vx, vy, gsc) {
    ctx.beginPath();
    F.tx = (lx[from] - vx) * gsc;
    F.ty = (ly[from] - vy) * gsc;
    ctx.moveTo(F.tx, F.ty);
    for (var i = from - 1; i >= to; i--) lineIfMoved(ctx, F, (lx[i] - vx) * gsc, (ly[i] - vy) * gsc);
  }

  function drawAntenna(S, ctx, o, headX, headY, count, vis, F, rnd) {
    var gsc = S.gsc;
    var vx = S.view_xx;
    var vy = S.view_yy;
    // The tracker takes these values even when the antenna is not drawn (quirk K2, read by the death flash).
    F.tx = Math.cos(o.ang);
    F.ty = Math.sin(o.ang);
    var baseX = headX - F.tx * 8 * o.sc;
    var baseY = headY - F.ty * 8 * o.sc;
    if (!(count >= 2 && baseX >= S.apx1 && baseY >= S.apy1 && baseX <= S.apx2 && baseY <= S.apy2)) {
      if (o.antenna_shown) o.antenna_shown = false; // re-seeds the chain next time it shows
      return;
    }
    var lx = o.atx;
    var ly = o.aty;
    lx[0] = baseX;
    ly[0] = baseY;
    var zoom = o.sc * gsc;
    var tip = lx.length - 1;
    var i;
    if (!o.antenna_shown) {
      // First frame on screen: lay the chain straight back from the base.
      o.antenna_shown = true;
      for (i = 1; i <= tip; i++) {
        lx[i] = baseX - F.tx * i * 4 * o.sc;
        ly[i] = baseY - F.ty * i * 4 * o.sc;
      }
    }
    for (i = 1; i <= tip; i++) springLink(o, lx, ly, o.atvx, o.atvy, i, F, rnd);

    // Stroke 1: dark core from the tip down to link 1, then the midpoint of links 1 and 0.
    ctx.globalAlpha = vis;
    ctx.strokeStyle = o.atc1;
    ctx.lineWidth = 5 * zoom;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    linkPath(ctx, F, lx, ly, tip, 1, vx, vy, gsc);
    lineIfMoved(ctx, F, ((lx[1] + lx[0]) * .5 - vx) * gsc, ((ly[1] + ly[0]) * .5 - vy) * gsc);
    ctx.stroke();

    // Stroke 2: lighter line from the tip down to link 0, thinned twice more when atwg.
    ctx.globalAlpha = o.atia * vis;
    ctx.strokeStyle = o.atc2;
    ctx.lineWidth = 4 * zoom;
    linkPath(ctx, F, lx, ly, tip, 0, vx, vy, gsc);
    ctx.stroke();
    if (o.atwg) {
      ctx.lineWidth = 3 * zoom;
      ctx.stroke();
      ctx.lineWidth = 2 * zoom;
      ctx.stroke();
    }

    // Bulb at the tip; with abrot it eases its rotation toward the last link's direction.
    ctx.globalAlpha = vis * o.blba;
    var bw = o.blbw * o.bsc * zoom;
    var bh = o.blbh * o.bsc * zoom;
    if (o.abrot) {
      ctx.save();
      ctx.translate((lx[tip] - vx) * gsc, (ly[tip] - vy) * gsc);
      var turn = wrapTurn(Math.atan2(ly[tip] - ly[tip - 1], lx[tip] - lx[tip - 1]) - o.atba);
      o.atba = (o.atba + turn * .15) % TAU;
      ctx.rotate(o.atba);
      ctx.drawImage(o.bulb, o.blbx * o.bsc * zoom, o.blby * o.bsc * zoom, bw, bh);
      ctx.restore();
    } else {
      ctx.drawImage(o.bulb, (lx[tip] - vx + o.blbx * o.bsc * o.sc) * gsc, (ly[tip] - vy + o.blby * o.bsc * o.sc) * gsc,
        bw, bh);
    }
  }

  // ------------------------------------------------------------------ head parts (game.js:6397-6493)

  // The side angle of an eye or side part: a quarter turn left (side -1) or right (side 1) of the face angle.
  function sideAngle(faceAng, side) {
    return side < 0 ? faceAng - Math.PI / 2 : faceAng + Math.PI / 2;
  }

  // Draws a sprite rotated to the face angle, centred on world point (wx, wy) relative to the view.
  function faceSprite(S, ctx, img, wx, wy, faceAng, left, top, w, h) {
    ctx.save();
    ctx.translate(S.mww2 + (wx - S.view_xx) * S.gsc, S.mhh2 + (wy - S.view_yy) * S.gsc);
    ctx.rotate(faceAng);
    ctx.drawImage(img, left, top, w, h);
    ctx.restore();
  }

  function drawHeadParts(S, ctx, o, headX, headY, faceAng, scale) {
    if (o.one_eye) drawOneEye(S, ctx, o, headX, headY, faceAng, scale);
    else {
      if (!o.eac) drawEyes(S, o, ctx, faceAng, scale, 1, 1);
      // Accessories are not built (every snake has accessory -1 in our room).
      if (o.jyt) drawCutouts(S, ctx, o, headX, headY, faceAng, scale);
    }
    ctx.globalAlpha = 1; // game.js:6475, outside any save/restore pair
    if (o.slg) drawSideParts(S, ctx, o, headX, headY, faceAng, scale);
  }

  // Skin 27: one big eye image and its pupil. Eyes ignore alive_amt (game.js:6397-6411).
  function drawOneEye(S, ctx, o, headX, headY, faceAng, scale) {
    var gsc = S.gsc;
    var fwd = 3 * scale;
    var size = scale * o.ebisz;
    var offX = Math.cos(faceAng) * fwd;
    var offY = Math.sin(faceAng) * fwd;
    ctx.globalAlpha = o.dead_amt == 0 ? 1 : Math.sqrt(1 - o.dead_amt);
    ctx.drawImage(o.ebi, 0, 0, o.ebiw, o.ebih, S.mww2 + (offX + headX - size / 2 - S.view_xx) * gsc,
      S.mhh2 + (offY + headY - size / 2 - S.view_yy) * gsc, size * gsc, size * gsc);
    offX = Math.cos(faceAng) * (fwd + .15) + o.rex * scale;
    offY = Math.sin(faceAng) * (fwd + .15) + o.rey * scale;
    size = scale * o.episz;
    ctx.drawImage(o.epi, 0, 0, o.epiw, o.epih, S.mww2 + (offX + headX - size / 2 - S.view_xx) * gsc,
      S.mhh2 + (offY + headY - size / 2 - S.view_yy) * gsc, size * gsc, size * gsc);
  }

  // Skin 40: two eye cut-outs, then the mouth (game.js:6446-6474).
  function drawCutouts(S, ctx, o, headX, headY, faceAng, scale) {
    var cut = sprite(S, 'ecmc');
    var z = o.sc * S.gsc * .25;
    var fwd = -3 * scale;
    var apart = 7 * scale;
    for (var side = -1; side <= 1; side += 2) {
      var sa = sideAngle(faceAng, side);
      var offX = Math.cos(faceAng) * (fwd + .5) + o.rex * scale + Math.cos(sa) * apart;
      var offY = Math.sin(faceAng) * (fwd + .5) + o.rey * scale + Math.sin(sa) * apart;
      faceSprite(S, ctx, cut, offX + headX, offY + headY, faceAng, -24 * z, -24 * z, 48 * z, 48 * z);
    }
    fwd = 5 * scale;
    var mouthX = Math.cos(faceAng) * (fwd + .5) + o.rex * scale;
    var mouthY = Math.sin(faceAng) * (fwd + .5) + o.rey * scale;
    z = o.sc * S.gsc * .16;
    faceSprite(S, ctx, sprite(S, 'jmou'), mouthX + headX, mouthY + headY, faceAng, -40 * z, -65 * z, 79 * z, 130 * z);
  }

  // Skin 41: two side images, each turned .4 outward (game.js:6476-6493).
  function drawSideParts(S, ctx, o, headX, headY, faceAng, scale) {
    var img = sprite(S, 'sest');
    var z = o.sc * S.gsc * .25;
    for (var side = -1; side <= 1; side += 2) {
      var sa = sideAngle(faceAng, side);
      var offX = Math.cos(faceAng) * 13 * scale + Math.cos(sa) * (6 * scale + .5);
      var offY = Math.sin(faceAng) * 13 * scale + Math.sin(sa) * (6 * scale + .5);
      faceSprite(S, ctx, img, offX + headX, offY + headY, side < 0 ? faceAng - .4 : faceAng + .4,
        -28 * z, -44 * z, 105 * z, 88 * z);
    }
  }

  // ------------------------------------------------------------------ eyes (game.js:6738-6791)

  // Eye alpha: base * mult, dimmed by sqrt(1 - dead_amt) while dying.
  function eyeAlpha(o, base, mult) {
    return o.dead_amt == 0 ? base * mult : base * Math.sqrt(1 - o.dead_amt) * mult;
  }

  // A closed circle path at world point (wx, wy) relative to the view, radius r in screen units.
  function circlePath(S, ctx, wx, wy, r) {
    ctx.beginPath();
    ctx.arc(S.mww2 + (wx - S.view_xx) * S.gsc, S.mhh2 + (wy - S.view_yy) * S.gsc, r, 0, TAU);
    ctx.closePath();
  }

  // Two eyes, each white then pupil, left side first. Fill, stroke and alpha state stays on the context after the
  // call (quirk K8).
  function drawEyes(S, o, ctx, faceAng, scale, whiteMult, pupilMult) {
    var gsc = S.gsc;
    var fwd = o.ed * scale;
    var apart = o.esp * scale;
    var headX = o.xx + o.fx;
    var headY = o.yy + o.fy;
    for (var side = -1; side <= 1; side += 2) {
      var sa = sideAngle(faceAng, side);
      // White: fwd along the face, a half unit wider than the pupil spacing.
      var offX = Math.cos(faceAng) * fwd + Math.cos(sa) * (apart + .5);
      var offY = Math.sin(faceAng) * fwd + Math.sin(sa) * (apart + .5);
      ctx.fillStyle = o.ec;
      if (o.eo > 0) {
        ctx.lineWidth = o.eo * gsc;
        ctx.strokeStyle = '#000000';
      }
      ctx.globalAlpha = eyeAlpha(o, o.eca, whiteMult);
      circlePath(S, ctx, offX + headX, offY + headY, o.er * scale * gsc);
      if (o.eo > 0) ctx.stroke();
      ctx.fill();
      // Pupil: a half unit further forward, shifted by the look offset rex/rey.
      offX = Math.cos(faceAng) * (fwd + .5) + o.rex * scale + Math.cos(sa) * apart;
      offY = Math.sin(faceAng) * (fwd + .5) + o.rey * scale + Math.sin(sa) * apart;
      ctx.globalAlpha = eyeAlpha(o, o.ppa, pupilMult);
      ctx.fillStyle = o.ppc;
      circlePath(S, ctx, offX + headX, offY + headY, o.pr * scale * gsc);
      ctx.fill();
    }
  }

  D.slDrawSnake = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
