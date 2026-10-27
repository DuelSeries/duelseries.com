'use strict';
/* ─── Head Soccer, the stadium ───────────────────────────────────────────────
   The sky, the drifting clouds and the stands (roof, bowl, stair aisles, the
   crowd), everything behind the pitch (hsPitch.js). Every function draws in
   world units (shared/hsSim.js: x from the halfway line, y down a 1920-high
   frame) on a context the caller has already transformed; hsArt.js paints
   them once per resize into offscreen layers.

   THE LOOK IS HEADS ARENA EURO SOCCER'S, PAINTED OUR OWN WAY: every position,
   size and colour below was measured from the reference (its display list and
   its art frames, see docs/head-soccer-reference.md); the shapes are drawn
   here by hand, no image or pixel data of theirs is used. */
(function (root) {
  const HS = root.HSSim.HS;
  const TAU = Math.PI * 2;
  const U = 1 / 0.45;                                   // S: hd art at imageScale .45 -> 2.222 units per art px

  /* Positions are kept in the reference frames' own px and turned into world
     units here. Tribune: sprite at (W/2, H/2 + 30), 1975 x 836 px, centred ->
     left -2194.4, top 61.1. Crowd: sprite at (W/2, H/2 + 130), 1975 x 365 px ->
     top 684.4 (display list). The frames are mirror images about px 987.5. */
  const FX = (px) => -2194.4 + px * U, TY = (py) => 61.1 + py * U, CY = (py) => 684.4 + py * U;
  const MIRROR = 1975;
  const HALF_W = 2194.4;

  /* ── the sky ────────────────────────────────────────────────────────────────
     S: bg-back, a tileSprite W x H at (W/2, H/2 - 200): its art (1975 x 864 px,
     12 flat colours) spans y -200..1720 and tiles every 4389 units from the
     screen's left edge. Top six bands have wavy edges (two strongest Fourier
     terms of each measured edge: [harmonic of the tile, amplitude, phase]). */
  const SKY_T = 4389;
  const SKY_TOP = '#72a0da';
  const SKY_WAVES = [
    ['#7ba8de', -66, [[3, 15.9, 1.01], [2, 14.5, 0.83]]],
    ['#84aee3', 17, [[2, 17.5, 2.52], [3, 9.8, 1.78]]],
    ['#8bb4e6', 111, [[5, 14.3, 0.46], [1, 11.9, 0.99]]],
    ['#92b9e9', 190, [[1, 25, 0.12], [2, 16.5, 2.8]]],
    ['#98beec', 276, [[2, 25.8, 0.46], [1, 15.2, -1.69]]],
    ['#a0c3ef', 341, [[2, 23.8, -2], [1, 9.2, 1.02]]],
  ];
  const SKY_FLAT = [['#a7c8f2', 420], ['#adcdf5', 526.7], ['#b2d1f6', 642.2], ['#b5d3f7', 762.2], ['#b8d5f8', 913.3]];
  // Lens-shaped streaks (measured): colour, tile x from..to, centre y and thickness at the fifths of its length.
  const SKY_STREAKS = [
    ['#8bb4e6', 2607, 4236, [60, 78, 86, 71, 55], [24, 33, 25, 37, 16]],
    ['#92b9e9', 658, 1247, [188, 173, 158, 151, 152], [6, 17, 26, 20, 10]],
    ['#8bb4e6', 1373, 2351, [218, 213, 211, 213, 223], [9, 20, 24, 21, 22]],
  ];

  /* ── the clouds ─────────────────────────────────────────────────────────────
     S: bg-front, a tileSprite at y 200 scrolling .2 px a frame; one flat colour
     #bae0ff, solid below y 796, puffs above. The puffs are our own seeded
     shapes, tuned until their height spread matches the art's (cover per 50
     units from y 200: 4 13 24 37 47 56 67 73 82 92 94 99 %; ours 3 10 23 29 41
     56 64 73 83 88 93 98 %). The seven loose blobs are at the art's own spots. */
  const CLOUD = { body: '#bae0ff', base: 796, tile: 4389, speed: 0.2 / 0.45 * 60 };   // S: tilePosition.x += .2 a frame
  const CLOUD_GEN = { pBig: 0.086, bigR: [110, 60], bigT: [203, 70], pMid: 0.31, midR: [69, 50], midT: [338, 186],
                      smR: [30, 40], smT: [566, 226], egg: [1, 0.3], pBump: 0.69, p2: 0.5, th: [0.05, 0.4], br: [0.22, 0.2],
                      step: [1.64, 0.8], mound: 1.3 };   // each puff sits on a mound 1.3x its width reaching the body
  const CLOUD_BLOBS = [[1422, 331, 160, 122], [3244, 282, 67, 82], [271, 511, 67, 71], [3140, 280, 62, 73],
                       [2560, 487, 60, 58], [1598, 344, 60, 64], [744, 416, 58, 56]];   // tile x, top y, w, h

  /* ── the stand (tribune art) ────────────────────────────────────────────────
     Every edge of the roof is an ellipse centred on x 0: [centre y, half width,
     half height], fitted to the art (mean error under 1 unit). */
  const E = {
    roof: [1628.9, 3640, 1080],      // top of the roof's light band (#acb8d3), 549 at the middle
    under: [1885.7, 3640, 1270],     // the roof's underside (#8b9abb) from 616
    dark: [1337.6, 2860, 680],       // the dark band with the posts (#677a9e) from 658
    beam: [1844.9, 3440, 1140],      // the light beam from 705
    wall: [1925, 3480, 1190],        // the back wall (#7b8aac) from 735
    bowl: [1558.2, 2740, 750],       // the bowl (#8b9abb) from 808
    rim: [1561.7, 2040, 315],        // the light rim (#bec8dd) from 1247; its face (#acb8d3) 16.4 lower; grass 124.2 lower
  };
  const RIM_FACE = 16.4, RIM_GRASS = 124.2, GRASS_END = TY(800), TRIB_END = TY(836);
  const C = {
    roofA: '#acb8d3', bowl: '#8b9abb', dark: '#677a9e', wall: '#7b8aac', rim: '#bec8dd', grass: '#76a75d',
    tread: '#96a6c5', riser: '#7b8aac',
  };
  // Posts under the roof (tribune px x of their centres), 16 px wide, round foot 17.2 units above the beam's foot.
  const POSTS = [987.5, 796.5, 590, 393.5, 249, 82.5], POST_W = 16 * U, POST_FOOT = 17.2;
  // Struts (left half; mirrored): centre line top/bottom in tribune px, width px. Round foot; the top hides under the beam.
  const STRUTS = [
    [[440.7, 330], [499.7, 497], 16],                    // S1: x 438..453 at py 345, slope .353, foot py 505
    [[210.8, 365], [302.5, 488], 16.5],                  // S2: 214..229 at py 380, slope .745, foot 496
    [[136, 380], [221.6, 487], 20],                      // S3: 142..161 at py 400, slope .8, foot 497
  ];
  const CENTRE_STRUT = { x0: 979, x1: 995, y0: 297, y1: 533 };
  // Stair aisle (left; mirrored): its two walls (centre line [px x, py] top..bottom, 16 px wide).
  const AISLE = {
    outer: [[655.5, 319], [686.5, 540.5]],              // 648..663 at py 319 -> 679..694 at 540
    inner: [[736.5, 319], [761.5, 537]],                // 729..744 at py 319 -> 754..769 at 537
    wallW: 16, stringer: 8, line: 3.5,                  // px: stringer band beside the inner wall, dark line 3.5 px from it
    landing: [346, 362], landingGap: 11.7,              // the dark landing (py) stops 11.7 px short of the inner wall
    treads: [[363, 376], [387, 390], [401, 404], [415, 418], [429, 431], [443, 445], [457, 459], [471, 473], [485, 487], [498, 501], [512, 515], [526, 529]],
  };
  // The small stair between S3 and S2 (tribune px): its hand rail and three steps.
  const SIDE_STAIR = {
    rail: [[180, 418], [184, 425], [205, 426], [227, 432], [237, 440], [263, 478]], railW: 3.5,
    steps: [
      [[[204, 449], [222, 449], [226, 453], [208, 453]], [[208, 454], [228, 454], [228, 461], [210, 461]]],
      [[[215, 462], [236, 462], [238, 466], [217, 466]], [[219, 467], [238, 467], [238, 473], [222, 473]]],
      [[[225, 474], [246, 474], [248, 482], [228, 482]], null],
    ],
  };

  /* ── the crowd ──────────────────────────────────────────────────────────────
     S: Crowd, frames crowd-1..5 played 1 2 3 4 5 4 3 2, one a second (0.1 s
     for 4 s after a goal). Eight blocks of fans (four a side), each a slanted
     section of the bowl between the struts and aisles; fans sit in staggered
     rows, back rows first. Block outlines, the front row's first fan, the step
     along a row (u) and to the row behind (v) are crowd px; s is the figure
     size against the middle blocks (face, row and column pitch measured). */
  const BLOCKS = [
    { // C: the middle block (x 762..987), 10 rows of 8, faces 20 px wide, rows 22.9 px apart (face tops 19 -> 225)
      poly: [[762, 0], [987.5, 0], [987.5, 330], [762, 330]],
      a: [775, 247], u: [26.8, 0], v: [0, -22.9], rows: 10, cols: 8, s: 1 },
    { // L3: between strut S1 and the aisle
      poly: [[465, 0], [636, 0], [640, 45], [647, 95], [655, 150], [661, 190], [672, 235], [676, 262], [680, 330],
             [503, 330], [503, 232], [510, 225], [502, 200], [495, 180], [488, 160], [481, 140], [474, 120], [468, 100], [463, 70]],
      a: [518, 252.6], u: [21.2, -1.7], v: [-4.1, -20.4], rows: 10, cols: 8, s: 0.8 },
    { // L2: between S2 and S1, notched where S2 runs down over it
      poly: [[241, 52], [427, 27], [431, 80], [440, 100], [459, 150], [474, 200], [486, 222], [496, 250], [502, 268], [506, 330],
             [335, 330], [320, 285], [314, 265], [305, 245], [300, 235], [294, 225], [326, 220], [318, 210], [302, 190],
             [287, 170], [271, 150], [255, 130], [247, 120], [241, 110]],
      a: [331, 282], u: [22.6, -4.4], v: [-8.1, -19.4], rows: 10, cols: 8, s: 0.8 },
    { // L1: the far block, left of S3 (seen only on wide screens)
      poly: [[0, 125], [137, 83], [142, 120], [148, 130], [156, 140], [161, 150], [166, 160], [177, 170], [183, 180], [187, 190],
             [195, 200], [201, 210], [205, 220], [208, 230], [221, 240], [230, 250], [235, 260], [242, 270], [247, 280], [253, 290],
             [260, 300], [270, 330], [275, 400], [140, 400], [140, 338], [120, 346], [100, 352], [80, 359], [60, 346], [40, 317], [20, 283], [0, 247]],
      a: [65, 342], u: [23.4, -7.3], v: [-4.5, -18.5], rows: 11, cols: 9, s: 0.8 },
  ];
  const STAGGER = 0.37;                 // every other row sits 10 px (of a 26.8 px step) along
  const JITTER = 1.5;                   // px, the spread of fans about their row
  // Palettes [colour, weight] (weights = counts of each colour's faces, shirts, hair in the art).
  const SKIN = [['#bea9a0', 75], ['#635046', 42], ['#88715d', 18], ['#a39884', 19]];
  const SHIRT = [['#767998', 21.7], ['#5b8d78', 15.6], ['#8d69af', 12.8], ['#b1ac76', 12.8], ['#af6a67', 12.1], ['#7279a3', 10.8], ['#803f47', 7.8]];
  /* Hair: style, weight, colours. Styles by the art's hair shapes and how many of each (big mops 38 x 33 px: 34,
     spikes 20 x 19: 32, caps 21-24 x 12-15: 47, long caps with 8 px strands: 22); colours within a style by their
     share of the whole crowd frame. */
  const HAIR = [
    ['big', 34, [['#291a11', 5.6], ['#816a76', 6.1], ['#81766a', 4.0], ['#8a6060', 3.2]]],
    ['spiky', 32, [['#150d09', 1.6], ['#6e8579', 1.9], ['#3b251b', 1.3]]],
    ['cap', 47, [['#5d473d', 2.4], ['#726358', 2.5], ['#8f8770', 1.4], ['#5a3a27', 1.2]]],
    ['long', 22, [['#723f4c', 2.3], ['#35464d', 2.3], ['#565466', 1.9]]],
  ];
  // Bob over the five frames, art px (down +), and how often each pattern shows (block matching between frames).
  const BOB = [[0, 4, 0, -4, 4], [0, -4, 0, -4, -8], [0, -4, 0, 4, -4], [0, 4, 0, 4, 8], [0, -4, 0, 4, 0], [0, 4, 8, 4, 4]];
  const BOB_W = [70, 68, 56, 55, 52, 41];
  const CROWD_FRAMES = 5, CROWD_ORDER = [0, 1, 2, 3, 4, 3, 2, 1];

  let VW = HS.VIEW_W_REF;                        // visible world width (set per resize)
  function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  function pick(r, list) { let t = 0; for (const it of list) t += it[1]; let q = r() * t; for (const it of list) { q -= it[1]; if (q <= 0) return it; } return list[list.length - 1]; }
  function rr(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  function ell(e, x, dy) { return e[0] + (dy || 0) - e[2] * Math.sqrt(Math.max(0, 1 - (x / e[1]) * (x / e[1]))); }
  function xRange() { return [Math.max(-VW / 2, -HALF_W), Math.min(VW / 2, HALF_W)]; }
  // Fill between two curves of x over the visible stand.
  function band(g, top, bot, fill) {
    const [x0, x1] = xRange(), n = Math.ceil((x1 - x0) / 30);
    g.beginPath();
    for (let i = 0; i <= n; i++) { const x = x0 + (x1 - x0) * i / n; g.lineTo(x, top(x)); }
    for (let i = n; i >= 0; i--) { const x = x0 + (x1 - x0) * i / n; g.lineTo(x, bot(x)); }
    g.closePath(); g.fillStyle = fill; g.fill();
  }
  function quad(g, pts, fill) { g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]); g.closePath(); g.fillStyle = fill; g.fill(); }
  // A thick line between two world points.
  function bar(g, a, b, w, fill, cap) { g.strokeStyle = fill; g.lineWidth = w; g.lineCap = cap || 'butt'; g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke(); }
  // Tribune px point -> world, on the left (m = 1) or mirrored to the right (m = -1).
  function tw(p, m) { const x = FX(p[0]); return [m < 0 ? -x : x, TY(p[1])]; }

  /* ── the sky ────────────────────────────────────────────────────────────── */
  function paintSky(g) {
    const x0 = -VW / 2, x1 = VW / 2, H = HS.VIEW_H, n = Math.ceil(VW / 30);
    g.fillStyle = SKY_TOP; g.fillRect(x0, 0, VW, H);
    for (const [col, mean, terms] of SKY_WAVES) {
      g.beginPath(); g.moveTo(x0, H);
      for (let i = 0; i <= n; i++) {
        const x = x0 + VW * i / n, t = (x - x0) / SKY_T * TAU;
        let y = mean; for (const [k, a, ph] of terms) y += a * Math.cos(k * t + ph);
        g.lineTo(x, y);
      }
      g.lineTo(x1, H); g.closePath(); g.fillStyle = col; g.fill();
    }
    for (const [col, y] of SKY_FLAT) { g.fillStyle = col; g.fillRect(x0, y, VW, H - y); }
    for (const [col, a, b, cy, th] of SKY_STREAKS) {
      for (let o = x0; o < x1; o += SKY_T) {
        if (o + b < x0 || o + a > x1) continue;
        const pts = [[0, cy[0], 0]]; for (let i = 0; i < 5; i++) pts.push([(i + 0.5) / 5, cy[i], th[i]]); pts.push([1, cy[4], 0]);
        g.beginPath();
        for (const [f, y, t] of pts) g.lineTo(o + a + (b - a) * f, y - t / 2);
        for (let i = pts.length - 1; i >= 0; i--) { const [f, y, t] = pts[i]; g.lineTo(o + a + (b - a) * f, y + t / 2); }
        g.closePath(); g.fillStyle = col; g.fill();
      }
    }
  }

  /* ── the clouds: one seamless strip CLOUD.tile wide (x 0..tile, y 0..1000) ─ */
  function cloudShapes() {
    const p = CLOUD_GEN, r = rng(7), T = CLOUD.tile, out = [];
    for (let x = 0; x < T;) {
      const q = r(); let rx, top;
      if (q < p.pBig) { rx = p.bigR[0] + r() * p.bigR[1]; top = p.bigT[0] + r() * p.bigT[1]; }
      else if (q < p.pBig + p.pMid) { rx = p.midR[0] + r() * p.midR[1]; top = p.midT[0] + r() * p.midT[1]; }
      else { rx = p.smR[0] + r() * p.smR[1]; top = p.smT[0] + r() * p.smT[1]; }
      const ry = rx * (p.egg[0] + r() * p.egg[1]);
      out.push([x + rx, top + ry, rx, ry, true]);
      for (const sd of [-1, 1]) {                               // small lobes on the puff's shoulders
        const nb = r() < p.pBump ? 1 + (r() < p.p2 ? 1 : 0) : 0;
        for (let j = 0; j < nb; j++) {
          const th = Math.PI * (sd > 0 ? -(p.th[0] + r() * p.th[1]) : -(1 - p.th[0] - r() * p.th[1])), br = rx * (p.br[0] + r() * p.br[1]);
          out.push([x + rx + Math.cos(th) * rx * 0.95, top + ry + Math.sin(th) * ry * 0.95, br, br, false]);
        }
      }
      x += rx * (p.step[0] + r() * p.step[1]);
    }
    // The loose blobs: tilted ovals in their measured boxes (the big one is a pair).
    for (const [x, y, w, h] of CLOUD_BLOBS) {
      if (w > 100) { out.push([x + w * 0.3, y + h * 0.62, w * 0.24, h * 0.36, false, -0.5]); out.push([x + w * 0.7, y + h * 0.4, w * 0.27, h * 0.38, false, 0.45]); }
      else out.push([x + w / 2, y + h / 2, w / 2, h / 2, false, w < h ? 0.35 : 0]);
    }
    return out;
  }
  function paintClouds(g) {
    const T = CLOUD.tile, sh = cloudShapes();
    g.fillStyle = CLOUD.body;
    for (const off of [-T, 0, T]) {
      g.beginPath();
      for (const [cx, cy, rx, ry, stem, rot] of sh) {
        const x = cx + off; if (x + rx < -T * 0.05 || x - rx > T * 1.05) continue;
        g.moveTo(x + rx, cy); g.ellipse(x, cy, rx, ry, rot || 0, 0, TAU);
        const my = CLOUD.base + 20 - cy, mw = rx * CLOUD_GEN.mound;
        if (stem && my > 0) { g.moveTo(x + mw, CLOUD.base + 20); g.ellipse(x, CLOUD.base + 20, mw, my, 0, 0, TAU); }
      }
      g.fill();
      g.fillRect(off, CLOUD.base, T, 1000 - CLOUD.base);
    }
  }

  /* ── the stand: roof, bowl, aisles, struts, the rim ────────────────────── */
  // The light rim round the bowl, its face, and the grass oval inside it (cut flat at GRASS_END).
  function paintRim(g) {
    const [x0, x1] = xRange(), e = E.rim;
    for (const [dy, col] of [[0, C.rim], [RIM_FACE, C.roofA], [RIM_GRASS, C.grass]]) {
      g.save();
      if (col === C.grass) { g.beginPath(); g.rect(x0, 0, x1 - x0, GRASS_END); g.clip(); }
      g.beginPath(); g.ellipse(0, e[0] + dy, e[1], e[2], 0, 0, TAU); g.fillStyle = col; g.fill();
      g.restore();
    }
  }
  function paintAisle(g, m) {
    const A = AISLE, wl = (pts) => [tw(pts[0], m), tw(pts[1], m)];
    const outer = wl(A.outer), inner = wl(A.inner), hw = A.wallW * U / 2;
    // x of a wall's centre line at world y
    const at = (w, y) => w[0][0] + (w[1][0] - w[0][0]) * (y - w[0][1]) / (w[1][1] - w[0][1]);
    const yTop = TY(A.landing[0]) - 6, yBot = TY(545);
    const span = (y0, y1, a, b, fill) => quad(g, [[a(y0), y0], [b(y0), y0], [b(y1), y1], [a(y1), y1]], fill);
    const oIn = (y) => at(outer, y) + m * hw;                       // the stair side of the outer wall
    const iIn = (y) => at(inner, y) - m * hw;                       // the stair side of the inner wall
    const strL = (y) => iIn(y) - m * A.stringer * U;                // the stair's edge beside the stringer
    // the stringer band, the risers and treads, the landing, the dark line
    span(yTop, yBot, oIn, iIn, C.bowl);
    span(TY(A.landing[1]), yBot, oIn, strL, C.riser);
    for (const [p0, p1] of A.treads) span(TY(p0), TY(p1 + 1), oIn, strL, C.tread);
    span(Math.min(yTop + 6, TY(A.landing[0])), TY(A.landing[1]), oIn, (y) => iIn(y) - m * A.landingGap * U, C.dark);
    const lx = (y) => iIn(y) - m * A.line * U;
    bar(g, [lx(TY(A.landing[1])), TY(A.landing[1])], [lx(yBot), yBot], U, C.dark);
    // the two walls, from inside the beam down past the rim
    for (const w of [outer, inner]) { const y0 = ell(E.beam, w[0][0]) + 10; bar(g, [at(w, y0), y0], [at(w, yBot), yBot], A.wallW * U, C.roofA); }
  }
  function paintSideStair(g, m) {
    const S = SIDE_STAIR;
    for (const [tread, riser] of S.steps) {
      quad(g, tread.map((p) => tw(p, m)), C.tread);
      if (riser) quad(g, riser.map((p) => tw(p, m)), C.riser);
    }
    g.strokeStyle = C.dark; g.lineWidth = S.railW * U; g.lineCap = 'round'; g.lineJoin = 'round';
    g.beginPath(); for (const p of S.rail) { const q = tw(p, m); g.lineTo(q[0], q[1]); } g.stroke();
  }
  function paintTribune(g) {
    const [x0, x1] = xRange();
    // The bowl under the roof, then the roof's bands top to bottom.
    band(g, (x) => ell(E.roof, x), () => TRIB_END, C.bowl);
    band(g, (x) => ell(E.roof, x), (x) => ell(E.under, x), C.roofA);
    band(g, (x) => ell(E.dark, x), (x) => ell(E.beam, x), C.dark);
    band(g, (x) => ell(E.wall, x), (x) => ell(E.bowl, x), C.wall);
    // The aisles, the small side stairs and the struts, all tucked under the beam.
    for (const m of [1, -1]) { paintAisle(g, m); paintSideStair(g, m); }
    for (const m of [1, -1]) for (const [a, b, w] of STRUTS) {
      const p = tw(a, m), q = tw(b, m);
      bar(g, p, q, w * U, C.roofA, 'round');
    }
    const cs = CENTRE_STRUT;
    g.fillStyle = C.roofA; g.fillRect(FX(cs.x0), TY(cs.y0) - 20, (cs.x1 - cs.x0) * U, TY(cs.y1) - TY(cs.y0) + 30);
    band(g, (x) => ell(E.beam, x), (x) => ell(E.wall, x), C.roofA);
    // Posts down through the dark band, their round feet on the beam.
    g.strokeStyle = C.bowl; g.lineWidth = POST_W; g.lineCap = 'round';
    for (const px of POSTS) for (const m of px === 987.5 ? [1] : [1, -1]) {
      const x = m * FX(px); if (x < x0 - POST_W || x > x1 + POST_W) continue;
      const foot = ell(E.wall, x) - POST_FOOT - POST_W / 2;
      g.beginPath(); g.moveTo(x, ell(E.dark, x) - 4); g.lineTo(x, foot); g.stroke();
    }
    paintRim(g);
  }

  /* ── the crowd ──────────────────────────────────────────────────────────── */
  let fans = null;
  function inPoly(pts, x, y) {
    let c = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
    }
    return c;
  }
  /* Fans are stamped from a pool of LOOKS (hair, colours, a side) drawn from the palettes above, each painted
     once per size into a small sprite; the reference repeats whole blocks of its crowd, so a pool this size
     reads the same. Stamping keeps a crowd layer to a few milliseconds. */
  const LOOKS_N = 64, SCALES = [1, 0.8];
  let looks = null;
  function shuffle(r, a) { for (let i = a.length - 1; i > 0; i--) { const j = (r() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; }
  // n items in the palette's proportions (largest remainder), shuffled, so the pool holds the measured mix exactly.
  function share(r, list, n) {
    let t = 0; for (const it of list) t += it[1];
    const q = list.map((it) => n * it[1] / t), out = [];
    list.forEach((it, i) => { for (let j = 0; j < Math.floor(q[i]); j++) out.push(it[0]); });
    list.map((it, i) => [q[i] - Math.floor(q[i]), it[0]]).sort((a, b) => b[0] - a[0]).slice(0, n - out.length).forEach((e) => out.push(e[1]));
    return shuffle(r, out);
  }
  function makeLooks() {
    const r = rng(97), hairs = [];
    for (const [style, w, cols] of HAIR) { let t = 0; for (const c of cols) t += c[1]; for (const [c, cw] of cols) hairs.push([[style, c], w * cw / t]); }
    const hs = share(r, hairs, LOOKS_N), sk = share(r, SKIN, LOOKS_N), sh = share(r, SHIRT, LOOKS_N);
    return hs.map((h, i) => ({ skin: sk[i], shirt: sh[i], hair: h[0], hc: h[1], m: r() < 0.5 ? -1 : 1, ph: r() * TAU, spk: r() }));
  }
  function makeFans() {
    const out = [];
    let seed = 11;
    const bobs = BOB.map((p, n) => [p, BOB_W[n]]);
    for (const B of BLOCKS) for (const m of [1, -1]) {
      const r = rng(seed++ * 7919), list = [], deck = [];
      const nextLook = () => { if (!deck.length) deck.push(...shuffle(r, Array.from({ length: LOOKS_N }, (_, i) => i))); return deck.pop(); };
      const P = (p) => [m > 0 ? p[0] : MIRROR - p[0], p[1]];
      const poly = B.poly.map(P), si = SCALES.indexOf(B.s);
      for (let row = B.rows - 1; row >= 0; row--) {
        for (let i = -2; i <= B.cols + 1; i++) {
          const f = i + (row % 2) * STAGGER;
          let px = B.a[0] + f * B.u[0] + row * B.v[0], py = B.a[1] + f * B.u[1] + row * B.v[1];
          if (m < 0) px = MIRROR - px;
          if (!inPoly(poly, px, py - 12 * B.s)) continue;
          px += (r() * 2 - 1) * JITTER; py += (r() * 2 - 1) * JITTER;
          list.push({ x: FX(px), b: CY(py), si, li: nextLook(), bob: pick(r, bobs)[0] });
        }
      }
      const wp = poly.map((p) => [FX(p[0]), CY(p[1])]);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const [x, y] of wp) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      out.push({ poly: wp, list, box: [x0 - 30, Math.max(0, y0 - 90), x1 + 30, Math.min(HS.VIEW_H, y1)] });
    }
    return out;
  }
  // Every look at every size painted once into one sheet at the layer's scale K (device px per world unit).
  let sheet = null, sheetK = 0;
  function makeSheet(K) {
    looks = looks || makeLooks();
    const cols = 16, cells = [];
    let y = 0, W = 0;
    for (const sc of SCALES) {
      const k = U * sc, cw = Math.ceil(44 * k * K) + 2, ch = Math.ceil(58 * k * K) + 2;
      cells.push({ k, cw, ch, y }); y += ch * Math.ceil(LOOKS_N / cols); W = Math.max(W, cw * cols);
    }
    const c = document.createElement('canvas'); c.width = W; c.height = y;
    const g = c.getContext('2d'), out = [];
    cells.forEach(({ k, cw, ch, y: y0 }) => {
      out.push(looks.map((lk, i) => {
        const sx = (i % cols) * cw, sy = y0 + ((i / cols) | 0) * ch;
        g.setTransform(K, 0, 0, K, sx + 22 * k * K + 1, sy + 40 * k * K + 1);
        paintFan(g, Object.assign({ x: 0, b: 0, k }, lk), 0);
        return { sx, sy, w: cw, h: ch, ox: 22 * k + 1 / K, oy: 40 * k + 1 / K };
      }));
    });
    return { c, cells: out };
  }
  /* One fan (art px, b = top of the shirt = foot of the neck; front-row fans measured): face 19-20 px wide at
     b-14, round brow, jaw narrowing to 7-11 px at b-7, chin b-4; neck 4 px; shirt 17-18 px wide; hair from b-29.5,
     fringe down to b-22 in the middle and b-16 at the sides. k = world units per art px at this block's size. */
  function paintFan(g, f, dy) {
    const k = f.k, x = f.x, b = f.b + dy, m = f.m, X = (dx) => x + dx * k * m, Y = (dy2) => b + dy2 * k;
    if (f.hair === 'big') {                                     // a big curly mop behind the head, 38 x 33 px
      g.fillStyle = f.hc; g.beginPath(); g.ellipse(x, Y(-20), 14 * k, 11.5 * k, 0, 0, TAU);
      for (let i = 0; i < 10; i++) {
        const a = f.ph + i * TAU / 10, cx = x + Math.cos(a) * 14 * k, cy = Y(-20) + Math.sin(a) * 11.5 * k;
        g.moveTo(cx + 5 * k, cy); g.arc(cx, cy, 5 * k, 0, TAU);
      }
      g.fill();
    } else if (f.hair === 'long') {                             // long hair hangs behind, beside the jaw (8 px strands)
      g.fillStyle = f.hc; rr(g, x - 10.8 * k, Y(-19), 21.6 * k, 20 * k, 4 * k); g.fill();
    }
    g.fillStyle = f.shirt; rr(g, x - 8.75 * k, b, 17.5 * k, 14 * k, 5.5 * k); g.fill();
    g.fillStyle = f.skin;
    g.fillRect(x - 2 * k, Y(-6), 4 * k, 7 * k);
    g.beginPath();                                              // the face and the ears
    g.moveTo(x - 9.6 * k, Y(-14));
    g.ellipse(x, Y(-14), 9.6 * k, 10 * k, 0, Math.PI, TAU);
    g.bezierCurveTo(x + 8.2 * k, Y(-9), x + 2 * k, Y(-4), x, Y(-4));
    g.bezierCurveTo(x - 2 * k, Y(-4), x - 8.2 * k, Y(-9), x - 9.6 * k, Y(-14));
    g.moveTo(x - 7.8 * k, Y(-16)); g.arc(x - 9.4 * k, Y(-16), 1.6 * k, 0, TAU);
    g.moveTo(x + 11 * k, Y(-16)); g.arc(x + 9.4 * k, Y(-16), 1.6 * k, 0, TAU);
    g.fill();
    if (f.hair === 'big') return;
    g.fillStyle = f.hc; g.beginPath();
    if (f.hair === 'spiky') {                                   // a crown of spikes, 20 x 19 px, a lock to one side
      const n = 11;
      for (let i = 0; i <= n; i++) {
        const a = Math.PI + i * Math.PI / n, grow = i % 2 ? 1 + 0.45 * ((f.spk * (i + 3) * 7.31) % 1) : 1;
        g.lineTo(X(Math.cos(a) * 10.6 * grow), Y(-18 + Math.sin(a) * 11.5 * grow));
      }
      g.lineTo(X(10.4), Y(-12)); g.lineTo(X(8.4), Y(-17));
      g.quadraticCurveTo(X(1), Y(-27), X(-10.6), Y(-16));
    } else {                                                    // a cap of hair, 21-24 x 12-15 px (median 22.8)
      g.moveTo(x - 11.4 * k, Y(-16)); g.lineTo(x - 11.4 * k, Y(-18));
      g.ellipse(x, Y(-18), 11.4 * k, 11.5 * k, 0, Math.PI, TAU);
      g.lineTo(x + 11.4 * k, Y(-16));
      g.quadraticCurveTo(X(-2), Y(-28), x - 11.4 * k, Y(-16));
    }
    g.fill();
  }
  let scratch = null;
  function paintCrowd(g, frame) {
    if (!fans) fans = makeFans();
    const fr = ((frame | 0) % CROWD_FRAMES + CROWD_FRAMES) % CROWD_FRAMES;
    const T = g.getTransform(), K = T.a, tx = T.e, ty = T.f;
    if (!sheet || sheetK !== K) { sheet = makeSheet(K); sheetK = K; }
    const [vx0, vx1] = xRange();
    for (const blk of fans) {
      // the block's box, snapped to the layer's pixel grid so the stamp lands 1:1
      const bx0 = Math.max(blk.box[0], vx0 - 30), bx1 = Math.min(blk.box[2], vx1 + 30);
      if (bx1 <= bx0) continue;
      const px0 = Math.floor(bx0 * K + tx), py0 = Math.floor(blk.box[1] * K + ty);
      const pw = Math.ceil(bx1 * K + tx) - px0, ph = Math.ceil(blk.box[3] * K + ty) - py0;
      if (!scratch) scratch = document.createElement('canvas');
      if (scratch.width < pw || scratch.height < ph) { scratch.width = Math.max(scratch.width, pw); scratch.height = Math.max(scratch.height, ph); }
      const sg = scratch.getContext('2d');
      sg.setTransform(1, 0, 0, 1, 0, 0); sg.globalCompositeOperation = 'source-over'; sg.clearRect(0, 0, pw, ph);
      const ox = tx - px0, oy = ty - py0;
      for (const f of blk.list) {
        const sp = sheet.cells[f.si][f.li];
        sg.drawImage(sheet.c, sp.sx, sp.sy, sp.w, sp.h, (f.x - sp.ox) * K + ox, (f.b + f.bob[fr] * U - sp.oy) * K + oy, sp.w, sp.h);
      }
      sg.globalCompositeOperation = 'destination-in';
      sg.setTransform(K, 0, 0, K, ox, oy);
      sg.beginPath(); sg.moveTo(blk.poly[0][0], blk.poly[0][1]); for (const p of blk.poly) sg.lineTo(p[0], p[1]); sg.closePath();
      sg.fillStyle = '#000'; sg.fill();
      sg.globalCompositeOperation = 'source-over';
      g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.drawImage(scratch, 0, 0, pw, ph, px0, py0, pw, ph); g.restore();
    }
    paintRim(g);                                                // the fans stop at the rim
  }

  root.HSScene = {
    setView(vw) { VW = vw; },
    sky: paintSky, clouds: paintClouds, tribune: paintTribune, crowd: paintCrowd,
    CLOUD, CROWD_FRAMES, CROWD_ORDER,
  };
})(window);
