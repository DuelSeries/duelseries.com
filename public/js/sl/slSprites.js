// slSprites: every offscreen sprite the snake draw uses, the 42-entry colour tables, the per-colour
// sprite object `per_color_imgs[i]` (its snake part) and `setSkin`.
//
// Built from spec/draw-snake.md section 2 (reference side). Numbers carry `game.js:N` notes where
// they explain a value or a quirk. Arithmetic keeps their operator order and their literal
// sub-expressions (`255 * 1.2`, `-(101 * .11) - 21`) so every pixel and field is bit-identical.
//
// Exports (BUILD-BRIEF section 11): buildSprites, setSkin, per_color_imgs, the tables
// (rrs, ggs, bbs, ccs, ccvs, csks, ralcsc, falcsc, alcsc, max_skin_cv), the sprite canvases
// (after buildSprites) and the pure pixel fills komcPixels, ksmcPixels, kfmcPixels, kmcsPixels,
// jsebiPixels, jsepiPixels (node tests; buildSprites uses the same functions).
//
// Nothing here touches the DOM at script load. buildSprites runs once, from boot.
(function (root) {
  'use strict';
  var D = root.DuelSlither = root.DuelSlither || {};

  var PI2 = 2 * Math.PI;              // game.js:125
  var KSZ = 48;                       // body frame size, game.js:3432
  var KSZ2 = KSZ / 2;                 // game.js:3433

  // ---------------------------------------------------------------- colour tables (game.js:3325-3354)

  function hex2(c) {
    var s = '00' + c.toString(16);
    return s.substr(s.length - 2);
  }

  function makeTables() {
    var rrs = [192, 144, 128, 128, 238, 255, 255, 255, 224, 255, 144, 80, 255, 40, 100, 120, 72, 160, 255, 56, 56,
      78, 255, 101, 128, 60, 0, 217, 255, 144, 32, 240, 240, 240, 240, 32, 40, 104, 0, 104, 0, 128];
    var ggs = [128, 153, 208, 255, 238, 160, 144, 64, 48, 255, 153, 80, 192, 136, 117, 134, 84, 80, 224, 68, 68,
      35, 86, 200, 132, 192, 255, 69, 64, 144, 32, 32, 240, 144, 32, 240, 60, 128, 0, 40, 0, 128];
    var bbs = [255, 255, 208, 128, 112, 96, 144, 64, 224, 255, 255, 80, 80, 96, 255, 255, 255, 255, 64, 255, 255,
      192, 9, 232, 144, 72, 83, 69, 64, 144, 240, 32, 32, 32, 240, 32, 173, 255, 112, 170, 0, 255];
    var ccs = [];
    var ccvs = [];
    var n;
    for (n = 0; n < rrs.length; n++) {
      ccs.push('#' + hex2(rrs[n]) + hex2(ggs[n]) + hex2(bbs[n]));
      ccvs.push(rrs[n] << 16 | ggs[n] << 8 | bbs[n]);     // built, never read (game.js:3339)
    }
    // colours a custom skin may use: 0..35, 37, 39, 41 (game.js:3344)
    var csks = [];
    for (n = 0; n <= 35; n++) csks.push(n);
    csks.push(37, 39, 41);
    var ralcsc = new Uint8Array(256);
    var falcsc = new Uint8Array(256);
    for (n = csks.length - 1; n >= 0; n--) {
      ralcsc[csks[n]] = 1;
      falcsc[csks[n]] = 1;
    }
    falcsc[40] = 1;                   // game.js:3353, only the skin builder swaps to it (menu, not built)
    return {
      rrs: rrs, ggs: ggs, bbs: bbs, ccs: ccs, ccvs: ccvs, csks: csks,
      ralcsc: ralcsc, falcsc: falcsc, alcsc: ralcsc,   // alcsc IS ralcsc in play (game.js:3354)
      max_skin_cv: 64                                  // game.js:3330, menu only
    };
  }

  var T = makeTables();
  var rrs = T.rrs;
  var ggs = T.ggs;
  var bbs = T.bbs;

  function clampRound(x) { return Math.max(0, Math.min(255, Math.round(x))); }
  function clampFloor(x) { return Math.max(0, Math.min(255, Math.floor(x))); }

  // ---------------------------------------------------------------- per-pixel fills (pure)
  // `d` is an ImageData `data` array of the sprite's size, walked row by row from (0, 0) exactly
  // like their single counter walk. Bytes their loop does not write are left untouched.

  // komc: outline ring, 52 x 52, radius 16, half width 4, peak alpha 204 (game.js:2953-2976)
  function komcPixels(d) {
    var size = 52;
    var mid = size / 2;
    var p = 0;
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++, p += 4) {
        var a = Math.abs(Math.sqrt(Math.pow(mid - x, 2) + Math.pow(mid - y, 2)) - 16);
        a = a <= 4 ? 1 - a / 4 : 0;
        a *= .8;
        d[p] = d[p + 1] = d[p + 2] = 0;
        d[p + 3] = Math.floor(255 * a);
      }
    }
    return d;
  }

  // ksmc: body and head shadow, 62 x 62, ring centre 3 px below the middle (game.js:2983-3007)
  function ksmcPixels(d) {
    var size = 62;
    var mid = size / 2;
    var p = 0;
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++, p += 4) {
        // distance from the radius 15 ring, falling off over 10 px; peak alpha .25
        var off = (Math.sqrt(Math.pow(mid - x, 2) + Math.pow(mid + 3 - y, 2)) - 15) * .1;
        if (off < 0) off = -off;
        var a = (1 - (off > 1 ? 1 : off)) * .25;
        d[p] = d[p + 1] = d[p + 2] = 0;
        d[p + 3] = Math.floor(255 * a);
      }
    }
    return d;
  }

  // kfmc colour source: these colours take the boost glow of another colour (game.js:3393-3403)
  var KFMC_FROM = { 26: 3, 29: 9, 30: 15, 31: 7, 32: 4, 33: 5, 34: 0, 35: 3, 36: 7, 41: 15 };

  // kfmc: boost glow, 62 x 62, colour i (game.js:3382-3431)
  function kfmcPixels(d, i) {
    var size = 62;
    var mid = size / 2;
    var src = KFMC_FROM.hasOwnProperty(i) ? KFMC_FROM[i] : i;
    var r = rrs[src];
    var g = ggs[src];
    var b = bbs[src];
    var mean = (r + g + b) / 3;
    if (mean <= 24) {
      r = g = b = 90;              // near black glows grey
    } else {
      var lift = 120 / mean;          // brightness target 120
      r = Math.min(255, Math.floor(r * lift));
      g = Math.min(255, Math.floor(g * lift));
      b = Math.min(255, Math.floor(b * lift));
    }
    var p = 0;
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++, p += 4) {
        var a = 1 - Math.sqrt(Math.pow(mid - x, 2) + Math.pow(mid - y, 2)) / 32;
        if (a < 0) a = 0;
        else a = .5 * (1 - Math.cos(Math.PI * a));
        d[p] = r;
        d[p + 1] = g;
        d[p + 2] = b;
        d[p + 3] = Math.floor(255 * a);
      }
    }
    return d;
  }

  // Number of body frames of colour i (game.js:3446-3448).
  function kmcsFrameCount(i) { return i == 36 ? 60 : 7; }

  // Elliptic distance used by the textured colours (half weight on x), game.js:3466 and siblings.
  function ell(x, y) {
    return Math.sqrt(Math.pow(.5 * (x - KSZ2), 2) + Math.pow(1 * (y - KSZ2), 2)) / KSZ2;
  }

  // Rim weight of the textured colours: the elliptic distance times `scale`, to the power `power`, capped at 1.
  function rim(x, y, scale, power) {
    var w = Math.pow(ell(x, y) * scale, power);
    return w > 1 ? 1 : w;
  }

  // Tube shading of a body frame: brightest along the middle row, mixed 3/8 toward the round disc value.
  function tube(y, disc) {
    var v = Math.pow(Math.max(0, Math.min(1, 1 - Math.abs(y - KSZ2) / KSZ2)), .35);
    return v + (disc - v) * .375;
  }

  // Flat colours: the tube shading is replaced by the frame value (quirk K12, game.js:3518-3592,
  // 3664-3676). Channel = base + frame * scale, then a blend toward `to` weighted `k * rim`.
  var FLAT = {
    30: { base: [0, 80, 0, 80, 128, 160], to: [255 * 1, 255 * 1, 255 * 1.4], k: .3 },
    31: { base: [128, 160, 0, 80, 0, 80], to: [255 * 1.4, 255 * 1, 255 * 1], k: .3 },
    32: { base: [96, 128, 96, 128, 0, 80], to: [255 * 1.2, 255 * 1.2, 255 * 1], k: .6 },
    33: { base: [96, 128, 48, 80, 0, 48], to: [255 * 1.2, 255 * 1.1, 255 * 1], k: .6 },
    34: { base: [96, 128, 0, 80, 96, 128], to: [255 * 1.2, 255 * 1, 255 * 1.2], k: .6 },
    35: { base: [0, 80, 96, 128, 0, 80], to: [255 * 1, 255 * 1.2, 255 * 1], k: .6 },
    41: { base: [0, 240, 0, 255, 160, 255], to: [255 * 1, 255 * 1, 255 * 1.4], k: .3 }
  };
  // Tinted tubes: shaded body blended toward a rim colour (game.js:3474-3497).
  var TINT = {
    26: [128 * 1.1, 255 * 1.1, 136 * 1.1],
    27: [217 * 1.1, 69 * 1.1, 69 * 1.1]
  };
  var STRIPE_RED = [255, 32, 64];                  // colour 36 (game.js:3593-3663)
  var STRIPE_WHITE = 255 * 2.2;

  // Scratch colour of the pixel being built (doubles, rounded only by the final clamp).
  var px = [0, 0, 0];

  // Moves the scratch colour toward (r, g, b) by k * w per channel, in their order ((to - c) * k * w; k is 1
  // except for the flat colours, and x * 1 is exact).
  function mix(r, g, b, k, w) {
    px[0] = px[0] + (r - px[0]) * k * w;
    px[1] = px[1] + (g - px[1]) * k * w;
    px[2] = px[2] + (b - px[2]) * k * w;
  }

  // One diagonal band of colour 36's stripes: its distance measure (game.js:3596-3599 and siblings).
  function bandDist(e, phase, w) {
    var t = 1.3 * (e - 1.3 * (phase - .5));
    t = t * 2;
    if (t < 0) t = -t;
    t *= w;
    return t;
  }

  // Colour 36's mix toward a band colour where the band covers the pixel (distance below 1).
  function band(dist, r, g, b) {
    if (dist < 1) mix(r, g, b, 1, 1 - dist);
  }

  // How close a stripe phase is to its centre .5: 1 at the centre, 0 at either end.
  function centreWeight(phase) {
    var off = .5 - phase;
    if (off < 0) off = -off;
    return 1 - Math.pow(off / .5, 2);
  }

  // Colour 36: diagonal red and white stripes, 60 frames, no frame brightness (game.js:3593-3663). Works on the
  // scratch colour; returns the brightness to apply.
  function stripes(x, y, j, frames, i, nsr, v) {
    var phase = (j / frames + .6 + .25 * (x / KSZ)) % 1;
    var nudge = KSZ2 * .055;
    band(bandDist((y - KSZ2) / KSZ, phase, 2.4), STRIPE_WHITE, STRIPE_WHITE, STRIPE_WHITE);
    band(bandDist(phase < .5 ? (y - nudge - KSZ2) / KSZ : (y + nudge - KSZ2) / KSZ, phase, 4.8),
      STRIPE_RED[0], STRIPE_RED[1], STRIPE_RED[2]);
    band(bandDist((KSZ2 - y) / KSZ, phase, 2.4), STRIPE_WHITE, STRIPE_WHITE, STRIPE_WHITE);
    band(bandDist(phase < .5 ? (KSZ2 + nudge - y) / KSZ : (KSZ2 - nudge - y) / KSZ, phase, 4.8),
      STRIPE_RED[0], STRIPE_RED[1], STRIPE_RED[2]);
    var row = (y - KSZ2) / KSZ;
    if (phase >= .47 && phase <= .53) {
      px[0] = STRIPE_RED[0];
      px[1] = STRIPE_RED[1];
      px[2] = STRIPE_RED[2];
    } else if (row >= -.1 && row <= .1) {
      mix(STRIPE_RED[0], STRIPE_RED[1], STRIPE_RED[2], 1, centreWeight(phase));
    } else if (phase >= .44 && phase <= .56 || row >= -.15 && row <= .15) {
      mix(255, 255, 255, 1, centreWeight(phase));
    }
    if (!nsr) {
      // tube shading again, and the table colour back toward the top and bottom edges
      var edge = Math.max(0, Math.min(1, 1 - Math.abs(y - KSZ2) / KSZ2));
      v = Math.pow(edge, .35);
      mix(rrs[i], ggs[i], bbs[i], 1, 1 - Math.pow(edge, .5));
    }
    return v;
  }

  // kmcs: body frame j of colour i, 48 x 48, RGB only (alpha is the browser's antialiased disc
  // and is never written). game.js:3452-3686.
  function kmcsPixels(d, i, j, nsr) {
    var frames = kmcsFrameCount(i);
    var dim = 1.22 - .44 * j / (frames - 1);        // frame brightness, game.js:3677
    var frame = (.1 + .9 * j / frames) % 1;          // flat colour frame value, game.js:3522
    var flat = FLAT[i];
    var tint = TINT[i];
    var p = 0;
    for (var y = 0; y < KSZ; y++) {
      for (var x = 0; x < KSZ; x++, p += 4) {
        var disc = Math.max(0, Math.min(1, 1 - Math.sqrt(Math.pow(x - KSZ2, 2) + Math.pow(y - KSZ2, 2)) / 34));
        var v = nsr ? Math.pow(disc, .5) : tube(y, disc);
        px[0] = rrs[i];
        px[1] = ggs[i];
        px[2] = bbs[i];
        if (i == 24) {
          mix(255 * 1.2, 192 * 1.2, 64 * 1.2, 1, rim(x, y, 1.05, 4));
          v *= dim;
        } else if (tint) {
          var tw = rim(x, y, 1, 2);
          v *= dim;
          px[0] *= v;
          px[1] *= v;
          px[2] *= v;
          v = 1;
          mix(tint[0], tint[1], tint[2], 1, tw);
        } else if (i == 28) {
          mix(128, 128, 255, 1, .5 - .5 * Math.cos(Math.PI * j / frames));
          v = Math.min(v * 1.1, 1);
        } else if (i == 29) {
          var gw = rim(x, y, 1, 2);
          v *= 1.44 - .88 * j / (frames - 1);
          px[0] = px[1] = px[2] = v * 32;
          v = 1;
          mix(255, 255, 255, 1, gw);
        } else if (flat) {
          var fw = rim(x, y, 1, 2);
          var base = flat.base;
          px[0] = base[0] + frame * base[1];
          px[1] = base[2] + frame * base[3];
          px[2] = base[4] + frame * base[5];
          mix(flat.to[0], flat.to[1], flat.to[2], flat.k, fw);
          v = 1;
        } else if (i == 36) {
          v = stripes(x, y, j, frames, i, nsr, v);
        } else {
          v *= dim;
        }
        d[p] = clampFloor(px[0] * v);
        d[p + 1] = clampFloor(px[1] * v);
        d[p + 2] = clampFloor(px[2] * v);
      }
    }
    return d;
  }

  // jsebi: one-eye white of skin 27, 64 x 64, every byte written (game.js:3018-3053).
  // Quirk K7 kept: the alpha of a pixel uses the NEXT pixel's coordinates (game.js:3044-3050).
  function jsebiPixels(d) {
    var size = 64;
    var mid = size / 2;
    var p = 0;
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++, p += 4) {
        var shade = Math.abs(mid - Math.sqrt(Math.pow(mid - x, 2) + Math.pow(mid - y, 2))) / mid;
        shade = shade * 1.06 - .06;
        if (shade < 0) {
          shade = 0;
        } else {
          shade = Math.pow(shade, .35);
          shade *= 1.35;
        }
        shade += (1 - shade) * .25;
        d[p] = clampRound(72 * shade);
        d[p + 1] = clampRound(255 * shade);
        d[p + 2] = clampRound(116 * shade);
        var nextX = x + 1;
        var nextY = y;
        if (nextX >= size) {
          nextX = 0;
          nextY = y + 1;
        }
        var a = mid - Math.sqrt(Math.pow(mid - nextX, 2) + Math.pow(mid - nextY, 2));
        d[p + 3] = a <= 3 ? clampRound(a / 3 * 255) : 255;
      }
    }
    return d;
  }

  // jsepi: one-eye pupil of skin 27, 48 x 48, RGB only (game.js:3056-3090).
  function jsepiPixels(d) {
    var size = 48;
    var mid = size / 2;
    var p = 0;
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++, p += 4) {
        var shade = Math.abs(mid - Math.sqrt(Math.pow(mid - x, 2) + Math.pow(mid - y, 2))) / mid;
        if (shade > .5) shade = 0;
        else shade = 1 - Math.pow(shade / .5, 1);
        shade *= .8;
        if (shade == 0) {
          d[p] = 0;
          d[p + 1] = 0;
          d[p + 2] = 0;
        } else {
          d[p] = clampRound(28 + (87 - 28) * shade);
          d[p + 1] = clampRound(83 + (168 - 83) * shade);
          d[p + 2] = clampRound(128 + (238 - 128) * shade);
        }
      }
    }
    return d;
  }

  // ---------------------------------------------------------------- canvas building (browser)

  // The food and prey sprite lists of a colour set, in their key order (game.js:3360-3374): image, width,
  // height, half width, half height for the dot, the glow and the outline.
  var SET_LISTS = ['imgs', 'fws', 'fhs', 'fw2s', 'fh2s', 'gimgs', 'gfws', 'gfhs', 'gfw2s', 'gfh2s',
    'oimgs', 'ofws', 'ofhs', 'ofw2s', 'ofh2s'];

  function squareCanvas(doc, n) {
    var c = doc.createElement('canvas');
    c.width = c.height = n;            // their chained form (height is written first)
    return c;
  }

  function rectCanvas(doc, w, h) {
    var c = doc.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  // A canvas whose bytes come from one of the pure fills above: getImageData of the fresh (or
  // just drawn) canvas, fill, putImageData.
  function pixelCanvas(doc, sz, fill, predraw) {
    var c = squareCanvas(doc, sz);
    var x = c.getContext('2d');
    if (predraw) predraw(x);
    var map = x.getImageData(0, 0, sz, sz);
    fill(map.data);
    x.putImageData(map, 0, 0);
    return c;
  }

  function whiteDisc(x, r) {
    x.fillStyle = '#ffffff';
    x.beginPath();
    x.arc(r, r, r, 0, PI2);
    x.fill();
  }

  // 64 x 64 radial gradient bulb (rabulb game.js:3093-3103, acbulb 3120-3129)
  function gradientBulb(doc, stops) {
    var c = squareCanvas(doc, 64);
    var x = c.getContext('2d');
    var g = x.createRadialGradient(32, 32, 1, 32, 32, 32 - 1);
    for (var n = 0; n < stops.length; n++) g.addColorStop(stops[n][0], stops[n][1]);
    x.fillStyle = g;
    x.fillRect(0, 0, 64, 64);
    return c;
  }

  // Canvases their client fills from PNG art (skins 37, 39-42, 45-49, 59, 62). Ours never fetches
  // that art (legal line, DS 2.10): same object, same size, left blank. Order is their load order.
  var PICTURE_CANVASES = [
    ['kwkbulb', 130 + 42, 71 + 42],     // game.js:3130-3132
    ['jmou', 79, 130],                  // 3146-3148
    ['pwdbulb', 148 + 42, 146 + 42],    // 3155-3157
    ['sest', 105, 88],                  // 3172-3174
    ['playbulb', 100 + 42, 107 + 42],   // 3181-3183
    ['bonkbulb', 131 + 42, 136 + 42],   // 3197-3199
    ['leafbulb', 101 + 42, 119 + 42],   // 3213-3215
    ['swissbulb', 98 + 42, 98 + 42],    // 3229-3231
    ['moldovabulb', 120 + 42, 95 + 42], // 3245-3247
    ['vietnambulb', 95 + 42, 100 + 42], // 3261-3263
    ['argentinabulb', 110 + 42, 110 + 42], // 3277-3279
    ['movbulb', 100 + 42, 121 + 42]     // 3293-3295
  ];

  var SPRITE_NAMES = ['ecmc', 'kdmc', 'komc', 'ksmc', 'jsebi', 'jsepi', 'rabulb', 'cdbulb', 'cdbulb2', 'acbulb']
    .concat(PICTURE_CANVASES.map(function (e) { return e[0]; }));

  // Star overlays on the body frames of colours 10, 19, 20 (game.js:3693-3771): `k` steps by 1
  // from `from` to `to` (more stars with nsr), star centres on a ring of radius (KSZ2 / 16) * 13,
  // inner radius a * .05 * u, outer radius b * .05 * u, 5 points. `soft` stars sit in their own
  // save/restore at alpha .7.
  var STARS = {
    10: { from: -1, to: 1, nsrFrom: -4, nsrTo: 3, n: 8, a: 24, b: 62, u: KSZ / 32, soft: false },
    19: { from: -2, to: 2, nsrFrom: -7, nsrTo: 7, n: 15, a: 12, b: 31, u: KSZ / 32, soft: true },
    20: { from: -1.5, to: 1.5, nsrFrom: -6.5, nsrTo: 7.5, n: 15, a: 14, b: 36, u: KSZ2 / 16, soft: true }
  };

  function drawStars(x, st, nsr) {
    var last = nsr ? st.nsrTo : st.to;
    for (var k = nsr ? st.nsrFrom : st.from; k <= last; k++) {
      var cx = KSZ2 + Math.cos(2 * Math.PI * k / st.n) * (KSZ2 / 16) * 13;
      var cy = KSZ2 + Math.sin(2 * Math.PI * k / st.n) * (KSZ2 / 16) * 13;
      if (st.soft) {
        x.save();
        x.globalAlpha = .7;
      }
      x.fillStyle = '#FFFFFF';
      x.beginPath();
      for (var m = 0; m <= 5; m++) {
        var px = cx + Math.cos(2 * Math.PI * m / 5) * st.a * .05 * st.u;
        var py = cy + Math.sin(2 * Math.PI * m / 5) * st.a * .05 * st.u;
        if (m == 0) x.moveTo(px, py);
        else x.lineTo(px, py);
        px = cx + Math.cos(2 * Math.PI * (m + .5) / 5) * st.b * .05 * st.u;
        py = cy + Math.sin(2 * Math.PI * (m + .5) / 5) * st.b * .05 * st.u;
        x.lineTo(px, py);
      }
      x.fill();
      if (st.soft) x.restore();
    }
  }

  var spr = {};          // sprite canvases of the latest buildSprites, by their names
  var bound = null;      // the S the latest buildSprites wrote into

  // Which S and options a call means. Accepted: (S, opts), (S) and (opts). An object is S when it
  // is DuelSlither.S or carries the `slithers` list; opts may name S, document, nsr and
  // buildFoodSprites. nsr defaults to S.nsr (set by slMain from the user agent, game.js:47-76).
  function resolveArgs(a, b) {
    var S, opts;
    if (b != null) {
      S = a;
      opts = b;
    } else if (a && (a === D.S || Array.isArray(a.slithers))) {
      S = a;
      opts = {};
    } else {
      opts = a || {};
      S = opts.S || D.S || {};
    }
    return {
      S: S,
      doc: opts.document || root.document,
      nsr: typeof opts.nsr === 'boolean' ? opts.nsr : !!S.nsr,
      food: typeof opts.buildFoodSprites === 'function' ? opts.buildFoodSprites : null
    };
  }

  // Their load-time sprite build, in their order (DS 2.2): eye cut-out, death flash, outline,
  // shadow, one-eye images, bulbs, picture canvases, tables, then the per-colour loop.
  function buildSprites(a, b) {
    var r = resolveArgs(a, b);
    var S = r.S;
    var doc = r.doc;
    var nsr = r.nsr;
    var sp = {};
    var c, x, n;

    // 1. ecmc, jyt eye cut-out, 48 x 48 (game.js:2913-2922)
    c = squareCanvas(doc, 48);
    x = c.getContext('2d');
    x.fillStyle = '#000000';
    x.moveTo(36, 6);
    x.lineTo(30, 6);
    x.quadraticCurveTo(0, 24, 30, 48 - 6);
    x.lineTo(36, 48 - 6);
    x.quadraticCurveTo(14, 24, 36, 6);
    x.fill();
    sp.ecmc = c;

    // 2. kdmc, death flash, 32 x 32; no beginPath on a fresh context (game.js:2947-2952)
    c = squareCanvas(doc, 32);
    x = c.getContext('2d');
    x.fillStyle = '#FF9966';
    x.arc(16, 16, 16, 0, PI2);
    x.fill();
    sp.kdmc = c;

    // 3-6. per-pixel sprites (game.js:2953-3090)
    sp.komc = pixelCanvas(doc, 52, komcPixels, null);
    sp.ksmc = pixelCanvas(doc, 62, ksmcPixels, null);
    sp.jsebi = pixelCanvas(doc, 64, jsebiPixels, function (cx) { whiteDisc(cx, 32); });
    sp.jsepi = pixelCanvas(doc, 48, jsepiPixels, function (cx) { whiteDisc(cx, 24); });

    // 7. rabulb (game.js:3093-3103), never used by any skin
    sp.rabulb = gradientBulb(doc, [
      [0, 'rgba(255, 255, 255, 1)'], [.83, 'rgba(150,150,150, 1)'], [.84, 'rgba(80,80,80, 1)'],
      [.99, 'rgba(80,80,80, 1)'], [1, 'rgba(80,80,80, 0)']
    ]);

    // 8. cdbulb (skin 25): created first, drawn from cdbulb2 with a shadow (game.js:3104-3119)
    sp.cdbulb = rectCanvas(doc, 84, 84);
    sp.cdbulb2 = rectCanvas(doc, 84, 84);
    x = sp.cdbulb2.getContext('2d');
    x.fillStyle = '#ff5609';
    x.fillRect(13, 10, 58 / 2, 64);
    x.fillRect(13, 10, 58, 22);
    x.fillRect(13, 10 + 44, 58, 22);
    x = sp.cdbulb.getContext('2d');
    x.shadowColor = '#000000';
    x.shadowBlur = 20;
    x.drawImage(sp.cdbulb2, 0, 0);
    x.drawImage(sp.cdbulb2, 0, 0);

    // 9. acbulb (skin 24), game.js:3120-3129
    sp.acbulb = gradientBulb(doc, [
      [0, 'rgba(255, 128, 128, 1)'], [.5, 'rgba(222, 3, 3, 1)'], [.96, 'rgba(157, 18, 18, 1)'],
      [1, 'rgba(0,0,0, 0)']
    ]);

    // 10. picture canvases, blank (see PICTURE_CANVASES)
    for (n = 0; n < PICTURE_CANVASES.length; n++) {
      var pc = PICTURE_CANVASES[n];
      sp[pc[0]] = rectCanvas(doc, pc[1], pc[2]);
    }

    spr = sp;
    bound = S;
    for (n = 0; n < SPRITE_NAMES.length; n++) {
      S[SPRITE_NAMES[n]] = sp[SPRITE_NAMES[n]];
      api[SPRITE_NAMES[n]] = sp[SPRITE_NAMES[n]];
    }

    // 11. tables (game.js:3324-3354)
    var pci = [];
    S.per_color_imgs = pci;
    api.per_color_imgs = pci;
    S.rrs = T.rrs;
    S.ggs = T.ggs;
    S.bbs = T.bbs;
    S.ccs = T.ccs;
    S.ccvs = T.ccvs;
    S.max_skin_cv = T.max_skin_cv;
    S.ralcsc = T.ralcsc;
    S.falcsc = T.falcsc;
    S.csks = T.csks;
    S.alcsc = T.alcsc;

    // 12. per-colour loop (game.js:3358-3905)
    for (var i = 0; i < rrs.length; i++) {
      var o = {};
      // empty food sprite lists (filled for colours 0..9 by slDrawWorld), in their key order
      for (n = 0; n < SET_LISTS.length; n++) o[SET_LISTS[n]] = [];
      o.cs = '#' + hex2(rrs[i]) + hex2(ggs[i]) + hex2(bbs[i]);

      o.kfmc = pixelCanvas(doc, 62, function (data) { kfmcPixels(data, i); }, null);

      // body frames: one scratch disc canvas per colour, its ImageData read ONCE and reused, so
      // the alpha of every frame is the browser's antialiased disc (game.js:3434-3440)
      var disc = squareCanvas(doc, KSZ);
      var dctx = disc.getContext('2d');
      dctx.fillStyle = '#FFFFFF';
      dctx.arc(KSZ2, KSZ2, KSZ2, 0, PI2);
      dctx.fill();
      var image = dctx.getImageData(0, 0, KSZ, KSZ);
      var nFrames = kmcsFrameCount(i);
      var frameList = [];
      for (var j = 0; j < nFrames; j++) {
        kmcsPixels(image.data, i, j, nsr);
        dctx.putImageData(image, 0, 0);
        var frame = squareCanvas(doc, KSZ);
        var fctx = frame.getContext('2d');
        fctx.drawImage(disc, 0, 0);
        if (STARS[i]) drawStars(fctx, STARS[i], nsr);
        frameList.push(frame);
      }
      o.kmcs = frameList;
      o.kmos = [];                    // built empty, never filled (game.js:3451, 3783)
      o.kl = frameList.length;
      o.klp = true;
      if (i == 36) o.klp = false;   // colour 36 frames run once through, not ping-pong
      pci.push(o);

      // food and prey sprites of colours 0..9 (slDrawWorld, DWH 2.4), right after the push
      if (i <= 9) {
        if (r.food) r.food(o, i, rrs[i], ggs[i], bbs[i]);
        else if (D.slDrawWorld && typeof D.slDrawWorld.buildFoodSprites === 'function') {
          D.slDrawWorld.buildFoodSprites(o, i, rrs[i], ggs[i], bbs[i]);
        }
      }
    }
    return sp;
  }

  // ---------------------------------------------------------------- setSkin (game.js:2126-2629)

  // Body colour lists of skins 9..65 (game.js:2556-2620). A number is one entry; [v, n] is v
  // repeated n times. Each call gets a fresh array, as theirs builds a new literal per call.
  var STRIPES = {
    9: [7, 9, 7, 9, 7, 9, 7, 9, 7, 9, 7, [10, 9]],
    10: [[9, 5], [1, 5], [7, 5]],
    11: [[11, 5], [7, 5], [12, 5]],
    12: [[7, 5], [9, 5], [13, 5]],
    13: [[14, 5], [9, 5], [7, 5]],
    14: [[9, 7], [7, 7]],
    15: [0, 1, 2, 3, 4, 5, 6, 7, 8],
    16: [[15, 7], [4, 7]],
    17: [[9, 7], [16, 7]],
    18: [[7, 7], [9, 7]],
    19: [9],
    20: [[3, 5], [0, 5]],
    21: [[3, 7], [18, 6], 20, 19, 20, 19, 20, 19, 20, [18, 6]],
    22: [[5, 7], [9, 7], [13, 7]],
    23: [[16, 7], [18, 7], [7, 7]],
    24: [[23, 9], [18, 9]],
    25: [[21, 12], [22, 9]],
    26: [24],
    27: [25],
    28: [[18, 7], [25, 7], [7, 7]],
    29: [11, 11, 4, 11, 11, 11, 11, 4, 11, 11],
    30: [10, 10, 19, 20, 10, 10, 20, 19],
    31: [10, 10],
    32: [20, 20],
    33: [12, 11, 11],
    34: [7, 7, 9, 13, 13, 9, 16, 16, 9, 12, 12, 9, 7, 7, 9, 16, 16, 9],
    35: [7, 7, 9, 9, 6, 6, 9, 9],
    36: [16, 16, 9, 9, 15, 15, 9, 9],
    37: [22],
    38: [18],
    39: [23],
    40: [26],
    41: [27],
    42: [[2, 8], [3, 8], [5, 8], [7, 8]],
    43: [28],
    44: [29],
    45: [[7, 3], [9, 8], [7, 3]],
    46: [7],
    47: [[16, 3], [18, 9], [7, 8], [16, 4]],
    48: [7],
    49: [[23, 5], [9, 8], [23, 2]],
    50: [[18, 14], [16, 8], [7, 8]],
    51: [7, 7, 7, 9, 9, [16, 6], 9, 9],
    52: [[7, 4], [18, 9], [7, 5]],
    53: [30],
    54: [31],
    55: [32],
    56: [33],
    57: [34],
    58: [35],
    59: [18],
    60: [36],
    61: [[30, 6], [35, 6], [33, 6], [31, 6], [32, 6], [34, 6]],
    62: [[17, 5], [39, 5]],
    63: [[7, 3], [11, 3]],
    64: [16, 16, 11, 11],
    65: [[4, 4], [9, 4]]
  };

  function stripeList(cv) {
    if (!STRIPES.hasOwnProperty(cv)) return null;
    var spec = STRIPES[cv];
    var out = [];
    for (var n = 0; n < spec.length; n++) {
      var e = spec[n];
      if (typeof e === 'number') out.push(e);
      else for (var q = 0; q < e[1]; q++) out.push(e[0]);
    }
    return out;
  }

  // A value naming one of our sprite canvases, resolved when setSkin runs.
  function sprite(name) { return { spriteName: name }; }

  // Skins with eye or body flags, fields in their assignment order (game.js:2235-2248, 2304-2317,
  // 2345-2348, 2514, 2543-2553). Skin 65's branch is empty (2554).
  var FLAG_SKINS = {
    27: [['jse', true], ['one_eye', true], ['ebi', sprite('jsebi')], ['ebiw', 64], ['ebih', 64], ['ebisz', 29],
      ['epi', sprite('jsepi')], ['epiw', 48], ['epih', 48], ['episz', 14], ['pma', 4], ['swell', .06]],
    40: [['eac', true], ['jyt', true]],
    41: [['ed', 34], ['esp', 14], ['eca', 1], ['eo', 3], ['er', 8], ['easp', .038], ['pr', 4.5], ['pma', 3],
      ['slg', true]],
    44: [['ec', '#D4D4D4'], ['ecv', 13948116]],
    60: [['drez', true]],
    63: [['ec', '#000000'], ['ecv', 0], ['eca', 1], ['ppc', '#CCCCCC'], ['ppcv', 13421772], ['pr', 2.5]],
    64: [['ec', '#FFFF80'], ['ecv', 16777088], ['eca', 1]]
  };

  // Antenna skins (game.js:2180-2234, 2249-2303, 2318-2344, 2349-2542): fields set before the
  // antenna, then the antenna template with these values.
  var EC1 = [['eca', 1]];
  var ANTENNA_SKINS = {
    24: { pre: [], c1: '#00688c', c2: '#64c8e7', wg: true, ia: .35, rot: false, jc: 8, bulb: 'acbulb',
      bx: -10, by: -10, bw: 20, bh: 20, sc: 1, ba: .75 },
    25: { pre: [['ec', '#FF5609'], ['ecv', 16733705], ['eca', 1]], c1: '#000000', c2: '#5630d7', wg: false,
      ia: 1, rot: true, jc: 9, bulb: 'cdbulb', bx: -5, by: -10, bw: 20, bh: 20, sc: 1.6, ba: 1 },
    37: { pre: EC1, c1: '#301400', c2: '#ff6813', wg: true, ia: .5, rot: true, jc: 9, bulb: 'kwkbulb',
      bx: -18 - 21, by: -42 - 21, bw: 130 + 42, bh: 71 + 42, sc: .42, ba: 1 },
    39: { pre: EC1, c1: '#1d3245', c2: '#44d4ff', wg: true, ia: .43, rot: true, jc: 9, bulb: 'pwdbulb',
      bx: -15 - 21, by: -79 - 21, bw: 148 + 42, bh: 146 + 42, sc: .25, ba: 1 },
    42: { pre: EC1, c1: '#002828', c2: '#80d0d0', wg: true, ia: .5, rot: true, jc: 9, bulb: 'playbulb',
      bx: -8 - 21, by: -53 - 21, bw: 100 + 42, bh: 107 + 42, sc: .36, ba: 1 },
    45: { pre: EC1, c1: '#c02020', c2: '#ff4040', wg: true, ia: .5, rot: true, jc: 9, bulb: 'leafbulb',
      bx: -(101 * .11) - 21, by: -60 - 21, bw: 101 + 42, bh: 119 + 42, sc: .33, ba: 1 },
    46: { pre: EC1, c1: '#c02020', c2: '#ff4040', wg: true, ia: .5, rot: true, jc: 9, bulb: 'swissbulb',
      bx: -(98 * .11) - 21, by: -49 - 21, bw: 98 + 42, bh: 98 + 42, sc: .285, ba: 1 },
    47: { pre: EC1, c1: '#3030ff', c2: '#6060ff', wg: true, ia: .5, rot: true, jc: 9, bulb: 'moldovabulb',
      bx: -(120 * .11) - 21, by: -48 - 21, bw: 120 + 42, bh: 95 + 42, sc: .33, ba: 1 },
    48: { pre: EC1, c1: '#c02020', c2: '#ff4040', wg: true, ia: .75, rot: true, jc: 9, bulb: 'vietnambulb',
      bx: -(95 * .11) - 21, by: -50 - 21, bw: 95 + 42, bh: 100 + 42, sc: .3, ba: 1 },
    49: { pre: EC1, c1: '#64accf', c2: '#84dcff', wg: true, ia: .7, rot: true, jc: 11, bulb: 'argentinabulb',
      bx: -(110 * .11) - 21, by: -55 - 21, bw: 110 + 42, bh: 110 + 42, sc: .3, ba: 1 },
    59: { pre: EC1, c1: '#886818', c2: '#ffe040', wg: true, ia: .55, rot: true, jc: 11, bulb: 'movbulb',
      bx: -(100 * .2) - 21, by: -70 - 21, bw: 100 + 42, bh: 121 + 42, sc: .3, ba: 1 },
    62: { pre: EC1, c1: '#402200', c2: '#ffc20f', wg: true, ia: .5, rot: true, jc: 9, bulb: 'bonkbulb',
      bx: -8 - 21, by: -68 - 21, bw: 131 + 42, bh: 136 + 42, sc: .25, ba: 1 }
  };

  function putFields(o, list) {
    for (var n = 0; n < list.length; n++) {
      var v = list[n][1];
      o[list[n][0]] = v && v.spriteName ? spr[v.spriteName] : v;
    }
  }

  // The antenna template: chain arrays start at the head (atax/atay are created, never used).
  function putAntenna(o, a) {
    o.antenna = true;
    o.atba = 0;
    o.atc1 = a.c1;
    o.atc2 = a.c2;
    if (a.wg) o.atwg = true;          // skin 25 never gets atwg (game.js:2206-2234)
    o.atia = a.ia;
    o.abrot = a.rot;
    var links = a.jc;
    o.atx = new Float32Array(links);
    o.aty = new Float32Array(links);
    o.atvx = new Float32Array(links);
    o.atvy = new Float32Array(links);
    o.atax = new Float32Array(links);
    o.atay = new Float32Array(links);
    o.atx.fill(o.xx);                 // the whole chain starts at the head
    o.aty.fill(o.yy);
    o.bulb = spr[a.bulb];
    o.blbx = a.bx;
    o.blby = a.by;
    o.blbw = a.bw;
    o.blbh = a.bh;
    o.bsc = a.sc;
    o.blba = a.ba;
  }

  // Eye, pupil and flag fields every skin starts from, after rcv, in their assignment order (game.js:2128-2149).
  var SKIN_DEFAULTS = [['er', 6], ['pr', 3.5], ['pma', 2.3], ['ec', '#FFFFFF'], ['ecv', 16777215], ['eca', .75],
    ['ppa', 1], ['ppc', '#000000'], ['ppcv', 0], ['antenna', false], ['one_eye', false], ['drez', false], ['ed', 6],
    ['esp', 6], ['easp', .1], ['eac', false], ['jyt', false], ['jse', false], ['slg', false], ['eo', 0], ['swell', 0],
    ['cusk', false]];

  // Colours a custom skin may use: the S of the latest buildSprites, else DuelSlither.S, else ours.
  function allowedColours() {
    var S = bound || D.S;
    return S && S.alcsc ? S.alcsc : T.alcsc;
  }

  // setSkin(o, cv, ca): skin fields of snake `o` for skin `cv`, with optional custom skin bytes
  // `ca` (bytes 8.. are count, colour pairs). `o` already has id, xx, yy (game.js:2658-2661).
  // Owen Q3 may change which skins exist (layered in a separate file).
  function setSkin(o, cv, ca) {
    o.rcv = cv;
    putFields(o, SKIN_DEFAULTS);

    // custom bytes (game.js:2150-2175): only allowed colours count; an odd trailing count is dropped
    if (ca != null && ca.length >= 10) {
      var allow = allowedColours();
      var list = [];
      for (var m = 8; m + 1 < ca.length; m += 2) {
        var count = ca[m];
        var col = ca[m + 1];
        if (allow[col] == 1) for (var q = 0; q < count; q++) list.push(col);
      }
      if (list.length > 0) {
        o.rbcs = list;
        cv = o.rbcs[0];
        o.cv = cv;
        o.cusk = true;
      }
    }

    var headFade = null;
    var tailFade = null;
    var fadeLen = 0;
    if (!o.cusk) {
      if (ANTENNA_SKINS.hasOwnProperty(cv)) {
        var a = ANTENNA_SKINS[cv];
        putFields(o, a.pre);
        putAntenna(o, a);
      } else if (FLAG_SKINS.hasOwnProperty(cv)) {
        putFields(o, FLAG_SKINS[cv]);
      }
      var rbcs = stripeList(cv);
      if (cv == 60) {                 // skin 60 head and tail fade colours (game.js:2611-2615)
        headFade = 37;
        tailFade = 38;
        fadeLen = 30;
      }
      if (rbcs) cv = rbcs[0];
      else cv = cv % 9;               // every skin outside 9..65 (game.js:2621)
      o.rbcs = rbcs;
      o.cv = cv;
    }
    o.fdhc = headFade;
    o.fdtc = tailFade;
    o.fdl = fadeLen;
  }

  // ---------------------------------------------------------------- exports

  var api = {
    buildSprites: buildSprites,
    setSkin: setSkin,
    komcPixels: komcPixels,
    ksmcPixels: ksmcPixels,
    kfmcPixels: kfmcPixels,
    kmcsPixels: kmcsPixels,
    jsebiPixels: jsebiPixels,
    jsepiPixels: jsepiPixels,
    kmcsFrameCount: kmcsFrameCount,
    SPRITE_NAMES: SPRITE_NAMES,
    per_color_imgs: [],
    rrs: T.rrs,
    ggs: T.ggs,
    bbs: T.bbs,
    ccs: T.ccs,
    ccvs: T.ccvs,
    csks: T.csks,
    ralcsc: T.ralcsc,
    falcsc: T.falcsc,
    alcsc: T.alcsc,
    max_skin_cv: T.max_skin_cv
  };
  for (var s0 = 0; s0 < SPRITE_NAMES.length; s0++) api[SPRITE_NAMES[s0]] = null;

  D.slSprites = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
