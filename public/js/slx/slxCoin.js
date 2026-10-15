// DuelSeries layer on the frozen slither.io client: the gold coin every cash pellet is drawn as (Owen's pick, 2026-10-15:
// "C1 Classic Gold Dollar" with a star on the back, picked from a page of ten looks). Ours, not a parity
// area. Display only: which food is cash stays the server's gold rule and what it is worth stays the server's
// (slxPaid.js section 3); this file only draws.
//
// The coin: a polished minted gold coin that turns all the way round about its vertical axis every SPIN_MS. The front is
// an embossed $ inside a raised rim, the back a faceted five point star, the edge a reeded band of real thickness
// (T = 0.22 r). The light is fixed in screen space, top left, so the faces darken or catch a sweep as they turn.
//
// Cost: draw(ctx, r, a) depends on r, a and the canvas pixel scale only, so it is pre-rendered. Each size bucket (device
// radius on a STEP ratio ladder, capped at MAX_DEV) gets one atlas canvas of FRAMES spin frames, drawn lazily: at most BUDGET_N new frames,
// and BUDGET_MS, per animation frame (always at least one). The last MAX_BUCKETS buckets are kept. blit() draws one pellet
// from an atlas, scaled from its bucket to the exact size; a frame not drawn yet borrows the nearest drawn frame of the
// bucket, and a pellet still popping in (their rad < 1) only borrows an existing bucket, so pop-in makes no new atlas.
// blit() returns false when nothing usable is cached, or the browser lacks what the coin needs: the caller then draws a
// plain gold disc. sparkle() is the live twinkle (a short four point star on the rim, about 13% of the time per pellet).
//
// Adds DuelSlither.slx.coin = { SPIN_MS, FRAMES, frameAt(t, ph), angleOf(f), draw(ctx, r, a), beginFrame(), blit(ctx,
// x, y, r, dpr, t, ph, grown), sparkle(ctx, x, y, r, t, ph), stats() }. No node, listener, timer or frame at load.
(function (root) {
  'use strict';
  var D = root.DuelSlither;
  if (!D || !D.slx || !D.slx.active) return;
  var slx = D.slx;

  var PI = Math.PI, PI2 = 2 * PI;
  var SPIN_MS = 2600;                            // one full turn
  var FRAMES = 96;                               // spin frames per turn: 27 ms each
  var COLS = 10;                                 // atlas grid: 10 x 10 cells hold the 96 frames
  var STEP = 1.06;                               // size buckets: device radii 6% apart, drawn scaled to the exact size
  var MIN_DEV = 4;                               // below this device radius the caller's plain disc is as good
  var MAX_DEV = 36;                              // bigger (a 3x phone screen) draws the 36 bucket scaled up: memory
  var MAX_BUCKETS = 5;                           // worst case about 5 x 3.3 MB of atlas
  var BUDGET_N = 12;                             // new atlas frames per animation frame, at most
  var BUDGET_MS = 2;
  var T_K = 0.22;                                // edge thickness / r

  // ---------------------------------------------------------------- the coin (the design file, as reviewed)

  function norm3(x, y, z) { var l = Math.sqrt(x * x + y * y + z * z); return [x / l, y / l, z / l]; }
  // screen space: x right, y down, z toward the viewer
  var L = norm3(-0.48, -0.62, 0.62);             // toward the light (top left, in front)
  var H = norm3(L[0], L[1], L[2] + 1);           // half vector for the viewer at +z

  // the one gold ramp every colour comes from (dark amber to white hot)
  var RAMP = [
    [0.00, 46, 26, 0], [0.12, 104, 62, 0], [0.25, 156, 101, 0], [0.38, 201, 138, 0], [0.50, 230, 168, 0],
    [0.62, 247, 194, 26], [0.74, 255, 216, 74], [0.85, 255, 233, 138], [0.94, 255, 246, 204], [1.00, 255, 255, 255]
  ];
  function gold(v, al) {
    v = v < 0 ? 0 : v > 1 ? 1 : v;
    var i = 1;
    while (i < RAMP.length - 1 && v > RAMP[i][0]) i++;
    var A = RAMP[i - 1], B = RAMP[i], f = (v - A[0]) / (B[0] - A[0]);
    var r = Math.round(A[1] + (B[1] - A[1]) * f), g = Math.round(A[2] + (B[2] - A[2]) * f), b = Math.round(A[3] + (B[3] - A[3]) * f);
    return al == null ? 'rgb(' + r + ',' + g + ',' + b + ')' : 'rgba(' + r + ',' + g + ',' + b + ',' + al + ')';
  }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function pixScale(ctx) {
    if (!ctx.getTransform) return 1;
    var m = ctx.getTransform();
    return Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
  }

  // the $ (unit coords, S half height 0.82, stubs to 1.3)
  function dollarPath(ctx, u) {
    ctx.beginPath();
    ctx.moveTo(0.50 * u, -0.50 * u);
    ctx.bezierCurveTo(0.42 * u, -0.76 * u, 0.22 * u, -0.82 * u, 0, -0.82 * u);
    ctx.bezierCurveTo(-0.27 * u, -0.82 * u, -0.46 * u, -0.66 * u, -0.46 * u, -0.42 * u);
    ctx.bezierCurveTo(-0.46 * u, -0.18 * u, -0.22 * u, -0.09 * u, 0, 0);
    ctx.bezierCurveTo(0.22 * u, 0.09 * u, 0.46 * u, 0.18 * u, 0.46 * u, 0.42 * u);
    ctx.bezierCurveTo(0.46 * u, 0.66 * u, 0.27 * u, 0.82 * u, 0, 0.82 * u);
    ctx.bezierCurveTo(-0.22 * u, 0.82 * u, -0.42 * u, 0.76 * u, -0.50 * u, 0.50 * u);
    ctx.moveTo(0, -1.30 * u); ctx.lineTo(0, -0.70 * u);
    ctx.moveTo(0, 0.70 * u); ctx.lineTo(0, 1.30 * u);
  }

  // the star (back), as 10 facets
  var STAR_O = 0.64, STAR_I = 0.28, STAR_H = 0.24;
  function starPts(R) {
    var p = [];
    for (var k = 0; k < 10; k++) {
      var th = -PI / 2 + k * PI / 5, rr = (k % 2 ? STAR_I : STAR_O) * R;
      p.push([Math.cos(th) * rr, Math.sin(th) * rr]);
    }
    return p;
  }

  // One face in face local coords (unit circle radius R, already scaled horizontally by |cos a|). lx, ly, ln: the light
  // in face coords; hx, hy, hn: the half vector in face coords; dv: brightness offset; px: one device pixel.
  function face(ctx, R, back, dev, lx, ly, ln, hx, hy, hn, dv, px) {
    var lm = Math.sqrt(lx * lx + ly * ly) || 1, dx = lx / lm, dy = ly / lm;  // in-plane direction toward the light
    var big = dev >= 26;

    // rim: outer slope lit toward the light
    var g = ctx.createLinearGradient(dx * R, dy * R, -dx * R, -dy * R);
    g.addColorStop(0, gold(0.95 + dv)); g.addColorStop(0.45, gold(0.70 + dv)); g.addColorStop(1, gold(0.31 + dv));
    ctx.beginPath(); ctx.arc(0, 0, R, 0, PI2); ctx.fillStyle = g; ctx.fill();
    // rim inner wall: faces the other way, so dark on the light side
    var rw = 0.835 * R;
    g = ctx.createLinearGradient(dx * rw, dy * rw, -dx * rw, -dy * rw);
    g.addColorStop(0, gold(0.30 + dv)); g.addColorStop(0.55, gold(0.52 + dv)); g.addColorStop(1, gold(0.86 + dv));
    ctx.beginPath(); ctx.arc(0, 0, rw, 0, PI2); ctx.fillStyle = g; ctx.fill();
    // field
    var fr = 0.775 * R;
    g = ctx.createRadialGradient(dx * 0.35 * R, dy * 0.35 * R, 0, 0, 0, fr * 1.15);
    g.addColorStop(0, gold(0.62 + dv)); g.addColorStop(0.55, gold(0.51 + dv)); g.addColorStop(1, gold(0.39 + dv));
    ctx.beginPath(); ctx.arc(0, 0, fr, 0, PI2); ctx.fillStyle = g; ctx.fill();

    // brushed sheen on the field: a bow tie of light along the in-plane light axis
    if (ctx.createConicGradient) {
      ctx.save();
      ctx.clip();
      var th = Math.atan2(dy, dx), k = clamp(lm * 1.2, 0, 1);
      var cg = ctx.createConicGradient(th, 0, 0);
      var lo = 'rgba(255,248,214,0)', hi = 'rgba(255,248,214,' + (0.30 * k).toFixed(3) + ')';
      var hi2 = 'rgba(255,248,214,' + (0.16 * k).toFixed(3) + ')', dk = 'rgba(96,56,0,' + (0.16 * k).toFixed(3) + ')';
      cg.addColorStop(0, hi); cg.addColorStop(0.07, lo); cg.addColorStop(0.25, dk); cg.addColorStop(0.43, lo);
      cg.addColorStop(0.5, hi2); cg.addColorStop(0.57, lo); cg.addColorStop(0.75, dk); cg.addColorStop(0.93, lo); cg.addColorStop(1, hi);
      ctx.fillStyle = cg; ctx.fillRect(-R, -R, 2 * R, 2 * R);
      if (big) {
        // fine radial brushing, deterministic
        var bg = ctx.createConicGradient(0, 0, 0), n = 72;
        for (var i = 0; i <= n; i++) {
          var h = Math.sin(i * 12.9898) * 43758.5453; h -= Math.floor(h);
          bg.addColorStop(i / n, h > 0.5 ? 'rgba(255,240,190,' + ((h - 0.5) * 0.16).toFixed(3) + ')' : 'rgba(80,46,0,' + ((0.5 - h) * 0.14).toFixed(3) + ')');
        }
        ctx.fillStyle = bg; ctx.fillRect(-R, -R, 2 * R, 2 * R);
      }
      ctx.restore();
    }

    // denticles (beaded ring) just inside the rim wall, big sizes only
    if (big) {
      var nb = 56, br = 0.735 * R, bs = 0.024 * R;
      for (var j = 0; j < nb; j++) {
        var bt = j * PI2 / nb, bx = Math.cos(bt), by = Math.sin(bt);
        var lit = (bx * dx + by * dy);
        ctx.beginPath(); ctx.arc(bx * br, by * br, bs, 0, PI2);
        ctx.fillStyle = gold(0.62 + 0.25 * lit + dv); ctx.fill();
      }
    }

    // the device, embossed: shadow away from the light, highlight toward it, then the body
    var o = Math.max(0.045 * R, 0.9 * px), ox = -dx * o, oy = -dy * o;
    if (!back) {
      var u = 0.525 * R;
      ctx.lineCap = 'butt'; ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(0.33 * u, 1.8 * px);
      ctx.save(); ctx.translate(ox * 1.4, oy * 1.4); dollarPath(ctx, u); ctx.strokeStyle = gold(0.12 + dv * 0.5, 0.95); ctx.stroke(); ctx.restore();
      ctx.save(); ctx.translate(-ox * 0.8, -oy * 0.8); dollarPath(ctx, u); ctx.strokeStyle = gold(0.99 + dv * 0.3); ctx.stroke(); ctx.restore();
      g = ctx.createLinearGradient(dx * u, dy * u, -dx * u, -dy * u);
      g.addColorStop(0, gold(0.88 + dv)); g.addColorStop(1, gold(0.68 + dv));
      dollarPath(ctx, u); ctx.strokeStyle = g; ctx.stroke();
    } else {
      var P = starPts(R), lz = ln;
      // shadow
      ctx.save(); ctx.translate(ox * 1.3, oy * 1.3);
      ctx.beginPath(); for (var a = 0; a < 10; a++) ctx[a ? 'lineTo' : 'moveTo'](P[a][0], P[a][1]); ctx.closePath();
      ctx.fillStyle = gold(0.14 + dv * 0.5, 0.9); ctx.fill(); ctx.restore();
      // facets: triangle (centre raised, outer point, inner point)
      var hz = STAR_H * R;
      for (var f = 0; f < 10; f++) {
        var A = P[f], B = P[(f + 1) % 10];
        // vectors from the raised centre (0,0,hz)
        var ax = A[0], ay = A[1], az = -hz, bx2 = B[0], by2 = B[1], bz = -hz;
        var nx = ay * bz - az * by2, ny = az * bx2 - ax * bz, nz = ax * by2 - ay * bx2;
        if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
        var nl = Math.sqrt(nx * nx + ny * ny + nz * nz); nx /= nl; ny /= nl; nz /= nl;
        var dif = nx * lx + ny * ly + nz * lz;
        var spc = Math.max(0, nx * hx + ny * hy + nz * hn); spc = Math.pow(spc, 24);
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.closePath();
        ctx.fillStyle = gold(0.30 + 0.62 * dif + 0.35 * spc + dv * 0.6);
        ctx.fill();
        // tiny overdraw stroke so facet seams do not show the field through
        ctx.lineWidth = 0.6 * px; ctx.strokeStyle = ctx.fillStyle; ctx.stroke();
      }
    }

    // specular blob: where a slightly domed face would mirror the light
    if (hn > 0.05) {
      var kap = 0.85, sx = hx / hn / kap, sy = hy / hn / kap, d2 = sx * sx + sy * sy;
      var al = 0.32 * clamp(1.5 - Math.sqrt(d2), 0, 1);
      if (al > 0.01) {
        ctx.save();
        ctx.beginPath(); ctx.arc(0, 0, R, 0, PI2); ctx.clip();
        ctx.globalCompositeOperation = 'lighter';
        var sg = ctx.createRadialGradient(sx * R, sy * R, 0, sx * R, sy * R, 0.75 * R);
        sg.addColorStop(0, 'rgba(255,236,160,' + al.toFixed(3) + ')');
        sg.addColorStop(0.45, 'rgba(255,220,110,' + (al * 0.35).toFixed(3) + ')');
        sg.addColorStop(1, 'rgba(255,220,110,0)');
        ctx.fillStyle = sg; ctx.fillRect(-R, -R, 2 * R, 2 * R);
        ctx.restore();
      }
    }
  }

  // The coin at (0, 0), radius r, spin angle a (0 face on, PI/2 edge on, PI the back).
  function draw(ctx, r, a) {
    var ps = pixScale(ctx), px = 1 / ps, dev = r * ps;
    var R = r, T = T_K * r;
    var c = Math.cos(a), sa = Math.sin(a), sg = c >= 0 ? 1 : -1;
    var ex = R * Math.abs(c);                    // face ellipse half width
    var hs = 0.5 * T * sa;                       // front face centre x offset
    var cv = sg * hs, ch = -sg * hs;             // visible / hidden face centres
    var dirn = (ch - cv) >= 0 ? 1 : -1;          // side the edge band shows on

    // light in face coords (face x axis = sg*(c,0,-sa), y = (0,1,0), normal = sg*(sa,0,c))
    var lx = sg * (c * L[0] - sa * L[2]), ly = L[1], ln = sg * (sa * L[0] + c * L[2]);
    var hx = sg * (c * H[0] - sa * H[2]), hy = H[1], hn = sg * (sa * H[0] + c * H[2]);
    var dv = clamp((ln - L[2]) * 0.45, -0.28, 0.07);

    ctx.save();

    // the edge band (the coin's thickness)
    function bandPath() {
      ctx.beginPath();
      ctx.moveTo(ch, -R);
      ctx.ellipse(ch, 0, Math.max(ex, 1e-4), R, 0, -PI / 2, PI / 2, dirn < 0);
      ctx.lineTo(cv, R);
      ctx.ellipse(cv, 0, Math.max(ex, 1e-4), R, 0, PI / 2, -PI / 2, dirn > 0);
      ctx.closePath();
    }
    var bandW = Math.abs(ch - cv);
    if (bandW * ps > 0.05) {
      // brightness along y: rim angle th with sin th = s, on the visible side
      var cs = -(sa >= 0 ? 1 : -1);              // sign of cos(th) on the visible side
      var bg = ctx.createLinearGradient(0, -R, 0, R);
      for (var i = 0; i <= 16; i++) {
        var s = -1 + i / 8, ct = cs * Math.sqrt(Math.max(0, 1 - s * s));
        var nx = ct * c, ny = s, nz = -ct * sa;
        var dif = nx * L[0] + ny * L[1] + nz * L[2];
        var spc = Math.max(0, nx * H[0] + ny * H[1] + nz * H[2]); spc = Math.pow(spc, 14);
        bg.addColorStop(i / 16, gold(Math.min(0.9, 0.38 + 0.36 * dif + 0.40 * spc)));
      }
      bandPath(); ctx.fillStyle = bg; ctx.fill();
      // reeding: each ridge is a horizontal segment at y = R sin th
      if (dev >= 22 && bandW * ps > 2.5) {
        ctx.save(); bandPath(); ctx.clip();
        var N = 96, lw = Math.max(px, 0.018 * R);
        ctx.lineWidth = lw;
        for (var k = 0; k < N; k++) {
          var th = (k + 0.5) * PI2 / N, cth = Math.cos(th);
          if (cth * cs <= 0.02) continue;
          var y = R * Math.sin(th), xm = R * cth * c, fo = Math.abs(cth);
          ctx.beginPath(); ctx.moveTo(xm - bandW / 2 - lw, y); ctx.lineTo(xm + bandW / 2 + lw, y);
          ctx.strokeStyle = 'rgba(70,40,0,' + (0.55 * fo).toFixed(3) + ')'; ctx.stroke();
          ctx.beginPath(); ctx.moveTo(xm - bandW / 2 - lw, y - lw); ctx.lineTo(xm + bandW / 2 + lw, y - lw);
          ctx.strokeStyle = 'rgba(255,240,180,' + (0.30 * fo).toFixed(3) + ')'; ctx.stroke();
        }
        ctx.restore();
      }
    }

    // the visible face
    if (ex * ps > 0.6) {
      ctx.save();
      ctx.translate(cv, 0);
      ctx.scale(Math.abs(c), 1);
      face(ctx, R, sg < 0, dev, lx, ly, ln, hx, hy, hn, dv, px);
      ctx.restore();
    }

    // crisp outer edge
    var ow = Math.max(px, 0.05 * R);
    ctx.lineWidth = ow; ctx.lineJoin = 'round';
    ctx.strokeStyle = gold(0.10, 0.85);
    if (bandW * ps > 0.05) { bandPath(); ctx.stroke(); }
    ctx.beginPath(); ctx.ellipse(cv, 0, Math.max(ex, 1e-4), R, 0, 0, PI2); ctx.stroke();
    // polished corner of the rim catching the light (top left of the face edge), just inside the dark edge
    if (ex * ps > 1.5) {
      var hw = Math.max(0.8 * px, 0.035 * R), ri = R - ow * 0.5 - hw * 0.5;
      var sc = Math.abs(c), la = Math.atan2(ly, lx);
      ctx.save();
      ctx.translate(cv, 0); ctx.scale(sc, 1);
      ctx.beginPath(); ctx.arc(0, 0, ri, la - 0.95, la + 0.95);
      ctx.restore();
      ctx.lineWidth = hw; ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(255,248,215,' + clamp(0.55 + dv * 1.5, 0.15, 0.7).toFixed(3) + ')';
      ctx.stroke();
    }

    ctx.restore();
  }

  // The live twinkle at (x, y): a short four point sparkle on the top left of the rim, once every 3.2 s per pellet.
  // Returns at once (no canvas call) while it is off.
  function sparkle(ctx, x, y, r, t, ph) {
    var u = (t / 3200 + ph * 5.71) % 1, on = 0.13;
    if (!(u >= 0 && u <= on)) return false;
    var k = Math.sin(u / on * PI);
    var a = angleOf(frameAt(t, ph));
    var c = Math.cos(a), sa = Math.sin(a), sg = c >= 0 ? 1 : -1;
    var ex = r * Math.abs(c), cv = sg * 0.11 * r * sa;
    var s = r * 0.62 * k, w = s * 0.16;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.translate(x + cv - 0.62 * Math.max(ex, 0.12 * r), y - 0.66 * r);
    ctx.beginPath();
    ctx.moveTo(0, -s); ctx.quadraticCurveTo(w, -w, s, 0); ctx.quadraticCurveTo(w, w, 0, s);
    ctx.quadraticCurveTo(-w, w, -s, 0); ctx.quadraticCurveTo(-w, -w, 0, -s); ctx.closePath();
    ctx.fillStyle = 'rgba(255,250,220,' + (0.95 * k).toFixed(3) + ')';
    ctx.fill();
    ctx.beginPath(); ctx.arc(0, 0, s * 0.22, 0, PI2);
    ctx.fillStyle = 'rgba(255,255,255,' + (0.8 * k).toFixed(3) + ')';
    ctx.fill();
    ctx.restore();
    return true;
  }

  // ---------------------------------------------------------------- the spin

  // The spin frame of a pellet at t (ms) with its fixed phase ph (0..1), and that frame's angle.
  function frameAt(t, ph) {
    var u = (t / SPIN_MS + (ph > 0 ? ph : 0)) % 1;
    var f = Math.floor((u >= 0 ? u : u + 1) * FRAMES);
    return f >= 0 && f < FRAMES ? f : 0;
  }
  function angleOf(f) { return f * PI2 / FRAMES; }

  // ---------------------------------------------------------------- the sprite cache

  var doc = root.document;
  var buckets = {};                              // bucket index -> { br, cell, cv, g, ready, n, used }
  var nBuckets = 0;
  var tickN = 0;                                 // animation frames seen (beginFrame)
  var budgetN = 0;
  var budgetUntil = 0;
  var spent = 0;                                 // frames drawn in this animation frame
  var broken = false;                            // the canvas lacks what the coin needs: callers draw discs
  var made = 0;                                  // atlas frames drawn, ever (stats)

  function clock() {
    var p = root.performance;
    return p && typeof p.now === 'function' ? p.now() : Date.now();
  }
  function bucketIndex(dev) { return Math.round(Math.log(dev) / Math.log(STEP)); }

  function newBucket(b) {
    if (!doc || typeof doc.createElement !== 'function') return null;
    if (nBuckets >= MAX_BUCKETS) {
      var old = null;
      for (var k in buckets) if (Object.prototype.hasOwnProperty.call(buckets, k) && (old === null || buckets[k].used < buckets[old].used)) old = k;
      if (old !== null) {
        buckets[old].cv.width = buckets[old].cv.height = 0;   // let the bitmap go now
        delete buckets[old];
        nBuckets--;
      }
    }
    var br = Math.pow(STEP, b);
    var cell = Math.ceil(2 * (br * (1 + T_K / 2) + 0.06 * br + 3));
    var cv = doc.createElement('canvas');
    cv.width = COLS * cell;
    cv.height = Math.ceil(FRAMES / COLS) * cell;
    var g = typeof cv.getContext === 'function' ? cv.getContext('2d') : null;
    if (!g) return null;
    var bk = { br: br, cell: cell, cv: cv, g: g, ready: new Uint8Array(FRAMES), n: 0, used: tickN };
    buckets[b] = bk;
    nBuckets++;
    return bk;
  }

  // Draws frame f into its atlas cell (device pixels, so the design picks its detail from br). False when out of budget.
  function make(bk, f) {
    if (bk.ready[f]) return true;
    if (spent > 0 && (budgetN <= 0 || clock() > budgetUntil)) return false;
    var g = bk.g, cell = bk.cell;
    var x0 = (f % COLS) * cell, y0 = Math.floor(f / COLS) * cell;
    try {
      g.save();
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.beginPath();
      g.rect(x0, y0, cell, cell);
      g.clip();
      g.translate(x0 + cell / 2, y0 + cell / 2);
      draw(g, bk.br, angleOf(f));
      g.restore();
    } catch (e) {
      broken = true;
      return false;
    }
    bk.ready[f] = 1;
    bk.n++;
    budgetN--;
    spent++;
    made++;
    return true;
  }

  // The nearest drawn frame of a bucket to f (either way round), or -1.
  function nearest(bk, f) {
    if (bk.n === 0) return -1;
    for (var d = 0; d <= FRAMES / 2; d++) {
      var a = (f + d) % FRAMES, b = (f - d + FRAMES) % FRAMES;
      if (bk.ready[a]) return a;
      if (bk.ready[b]) return b;
    }
    return -1;
  }

  // Call once per animation frame, before any blit.
  function beginFrame() {
    tickN++;
    budgetN = BUDGET_N;
    budgetUntil = clock() + BUDGET_MS;
    spent = 0;
  }

  // One pellet: the coin of radius r (css px) at (x, y) on a canvas drawn at dpr device pixels per css px, spin frame
  // from (t, ph). grown: the pellet is at its full size (only then may a new size bucket be made). False: nothing drawn.
  function blit(ctx, x, y, r, dpr, t, ph, grown) {
    if (broken || !(r > 0) || !(dpr > 0)) return false;
    var dev = r * dpr;
    if (dev < MIN_DEV) return false;
    var f = frameAt(t, ph);
    var b = bucketIndex(Math.min(dev, MAX_DEV));
    var bk = Object.prototype.hasOwnProperty.call(buckets, b) ? buckets[b] : null;
    if (!bk && grown) bk = newBucket(b);
    if (!bk) {
      // popping in (or no new atlas allowed): the closest existing bucket, scaled
      var best = null;
      for (var k in buckets) {
        if (!Object.prototype.hasOwnProperty.call(buckets, k) || buckets[k].n === 0) continue;
        if (best === null || Math.abs(k - b) < Math.abs(best - b)) best = k;
      }
      if (best === null) return false;
      bk = buckets[best];
    }
    if (broken) return false;
    bk.used = tickN;
    var use = make(bk, f) ? f : nearest(bk, f);
    if (use < 0) return false;
    var cell = bk.cell, s = dev / bk.br / dpr, w = cell * s;
    ctx.drawImage(bk.cv, (use % COLS) * cell, Math.floor(use / COLS) * cell, cell, cell, x - w / 2, y - w / 2, w, w);
    return true;
  }

  slx.coin = {
    SPIN_MS: SPIN_MS,
    FRAMES: FRAMES,
    frameAt: frameAt,
    angleOf: angleOf,
    draw: draw,
    beginFrame: beginFrame,
    blit: blit,
    sparkle: sparkle,
    // For tests and the console.
    stats: function () {
      var list = [];
      for (var k in buckets) if (Object.prototype.hasOwnProperty.call(buckets, k)) list.push({ b: +k, br: buckets[k].br, cell: buckets[k].cell, frames: buckets[k].n });
      return { buckets: list, made: made, broken: broken };
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
