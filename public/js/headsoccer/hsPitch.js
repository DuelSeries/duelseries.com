'use strict';
/* ─── Head Soccer, the pitch and the goals ───────────────────────────────────
   The sunken pitch between its two raised grass shelves, its chalk, the lawn
   in front, and the goals (nets, posts, crossbars) with the floodlight towers
   that stand behind them. World units (shared/hsSim.js), on a context the
   caller has transformed; hsArt.js caches them. The back of each goal is drawn
   behind the players, the front over them.

   THE LOOK IS HEADS ARENA EURO SOCCER'S, PAINTED OUR OWN WAY: positions,
   sizes and colours measured from the reference (docs/head-soccer-reference.md,
   measurement list in the art notes), no image of theirs used, nothing traced.
   Everything here is painted once per resize into hsArt's cached layers. */
(function (root) {
  const TAU = Math.PI * 2;

  // The field and the goals sit at fixed world positions (their sprites never move), wider than any view; the view
  // width is kept for the API only.
  let VW = root.HSSim.HS.VIEW_W_REF;
  function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  function poly(g, pts, fill) { g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]); g.closePath(); if (fill) { g.fillStyle = fill; g.fill(); } }

  /* ── tufts: the brushy edges, drawn by hand from a seeded random ─────────── */
  // One tuft: a few round-tipped blades (5..7 px wide, as theirs) side by side on (x, y), growing along the unit normal
  // (nx, ny); the cluster is W wide and its tallest blade H high.
  function tuft(g, x, y, nx, ny, W, H, rnd, col) {
    const n = Math.max(1, Math.round(W / 6)), top = Math.floor(rnd() * n);
    g.save(); g.translate(x, y); g.rotate(Math.atan2(nx, -ny)); g.fillStyle = col;
    for (let i = 0; i < n; i++) {
      const w = Math.min(W, 5 + 2 * rnd()), u = n === 1 ? 0 : -(W - w) / 2 + (W - w) * i / (n - 1);
      const h = i === top ? H : H * (0.35 + 0.55 * rnd()), lean = (rnd() - 0.5) * 0.5;
      g.save(); g.translate(u, 0); g.rotate(lean); g.beginPath();
      if (h <= w / 2) g.ellipse(0, 0.5, w / 2, h + 0.5, 0, Math.PI, 0);
      else { g.moveTo(-w / 2, 1); g.lineTo(-w / 2, -(h - w / 2)); g.arc(0, -(h - w / 2), w / 2, Math.PI, 0); g.lineTo(w / 2, 1); }
      g.closePath(); g.fill(); g.restore();
    }
    g.restore();
  }
  // A measured spread [min, median, max] sampled so its median lands on the measured one.
  function spread(r, m) { const e = Math.log(Math.max(1e-3, (m[1] - m[0]) / (m[2] - m[0]))) / Math.log(0.5); return m[0] + (m[2] - m[0]) * Math.pow(r, e); }
  // Tufts along the segment a -> b, normal (nx, ny); mean gap, cluster widths and heights [min, median, max] per edge.
  function tuftEdge(g, rnd, ax, ay, bx, by, nx, ny, gap, wr, hr, colAt) {
    const len = Math.hypot(bx - ax, by - ay);
    for (let s = gap * rnd(); s < len; s += gap * (0.5 + rnd())) {
      const t = s / len, x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
      tuft(g, x, y, nx, ny, spread(rnd(), wr), spread(rnd(), hr), rnd, colAt(x, y));
    }
  }
  // Tufts along a slanted stripe edge e between heights y0 and y1, either way (colL grows from the left region).
  function edgeBumps(g, rnd, e, y0, y1, gap, wr, hr, colL, colR, only) {
    const ax = at(e, y0), bx = at(e, y1), len = Math.hypot(bx - ax, y1 - y0), nx = (y1 - y0) / len, ny = -(bx - ax) / len;
    for (let s = gap * rnd(); s < len; s += gap * (0.5 + rnd())) {
      const t = s / len, x = ax + (bx - ax) * t, y = y0 + (y1 - y0) * t, side = only || (rnd() < 0.5 ? 1 : -1);
      tuft(g, x, y, nx * side, ny * side, spread(rnd(), wr), spread(rnd(), hr), rnd, side > 0 ? colL : colR);
    }
  }

  /* ── the field: the lawn, the pitch, the two raised grass blocks, the chalk ──
     Drawn in the atlas pixels of their `field` sprite (1975 x 377 px, placed at x -2194.4, y 1082.2 in the display
     list, 1 px = 20/9 units at imageScale .45), so every number below is a pixel position measured on level--field.png
     (SP/hs-tools/notes-f.md). Flat colours only, seven greens and the chalk; every edge carries procedural tufts (seeded
     random; spacing, widths and heights measured per edge), nothing traced. Mirror-symmetric about x 987.5. */
  const AT = 20 / 9, FLD = { x: -2194.4, y: 1082.2, w: 1975, mid: 987.5 };
  const GR = { L: '#a3ce8e', m: '#96c280', p: '#93c47a', k: '#8bbc72', f: '#80b366', s: '#76a75d', W: '#fcfff7', d: '#dee4db' };
  const FY = { top: 17, face: 81, far: 150, near: 230, lawn: 255, bot: 377 };
  // Stripe edges as [x at ya, x at yb, ya, yb] (fitted lines); `at(e, y)` reads one at any height.
  const at = (e, y) => e[0] + (e[1] - e[0]) * (y - e[2]) / (e[3] - e[2]);
  const LAWN = [[20, -230, 255, 377], [199, 46, 257, 376], [370, 268, 257, 376], [568, 485, 257, 376],
                [684, 621, 257, 376], [807, 756, 257, 376], [928, 904, 257, 376]];       // m | k | m | k ... (k in the middle)
  const PFACE = [568.3, 683.7, 805.9, 926.6];                                           // pitch front face: f | k | f | k | f
  const SFACE = [20, 200, 370, 517];                                                     // block fronts: k | f | k | f, side face from 517
  const PTOP = [[614.4, 580.6, 158, 214], [723.7, 690.6, 158, 214], [833.3, 816.7, 158, 214], [940.0, 929.1, 158, 214]]; // bevel L | p | L | p | L | p
  const STOP = [[130.2, 31.2, 18, 74], [289.9, 206.8, 18, 74], [448.6, 374.9, 18, 74], [552.4, 502.9, 18, 74]];          // L | p | L | p | L bevel
  const SIDE = [[517, 100], [571, 32], [571, 141], [517, 207]];                         // the block's side face (s)
  const PBEV = [581, 528, 150, 229];                                                     // right edge of the pitch's bevel band
  function quad(g, e0, e1, y0, y1, col) {
    g.beginPath(); g.moveTo(at(e0, y0), y0); g.lineTo(at(e1, y0), y0); g.lineTo(at(e1, y1), y1); g.lineTo(at(e0, y1), y1); g.closePath();
    g.fillStyle = col; g.fill();
  }
  const lawnCol = (x, y) => { let i = 0; while (i < LAWN.length && x > at(LAWN[i], y)) i++; return i % 2 ? GR.k : GR.m; };
  const pfaceCol = (x) => { let i = 0; while (i < PFACE.length && x > PFACE[i]) i++; return i % 2 ? GR.k : GR.f; };
  const sfaceCol = (x) => { let i = 0; while (i < SFACE.length && x > SFACE[i]) i++; return i % 2 ? GR.f : GR.k; };
  const ptopCol = (x, y) => { if (x < at(PBEV, y)) return GR.L; let i = 0; while (i < PTOP.length && x > at(PTOP[i], y)) i++; return i % 2 ? GR.L : GR.p; };

  function fieldBase(g) {
    const M = FLD.mid, far = FY.far, near = FY.near;
    // The lawn: its fanned stripes, k in the middle.
    g.fillStyle = GR.k; g.fillRect(-10, FY.lawn, M + 10, FY.bot - FY.lawn + 1);
    quad(g, [-400, -400, 0, 1], LAWN[0], FY.lawn, FY.bot + 1, GR.m);
    for (let i = 1; i + 1 < LAWN.length; i += 2) quad(g, LAWN[i], LAWN[i + 1], FY.lawn, FY.bot + 1, GR.m);
    // The pitch's front face: vertical stripes one shade darker than the lawn's.
    g.fillStyle = GR.f; g.fillRect(SFACE[3] - 1, near, M - SFACE[3] + 1, FY.lawn - near + 0.5);
    g.fillStyle = GR.k;
    for (let i = 0; i + 1 < PFACE.length; i += 2) g.fillRect(PFACE[i], near, PFACE[i + 1] - PFACE[i], FY.lawn - near + 0.5);
    // The blocks' front faces under the goals.
    g.fillStyle = GR.f; g.fillRect(-10, FY.face, SFACE[3] + 10, FY.lawn - FY.face + 0.5);
    g.fillStyle = GR.k; g.fillRect(-10, FY.face, SFACE[0] + 10, FY.lawn - FY.face + 0.5); g.fillRect(SFACE[1], FY.face, SFACE[2] - SFACE[1], FY.lawn - FY.face + 0.5);
    // The pitch's top: base p, L stripes, the light bevel band along its left edge.
    g.save();
    g.beginPath(); g.moveTo(SIDE[2][0], SIDE[2][1]); g.quadraticCurveTo(SIDE[2][0], far, SIDE[2][0] + 10, far); g.lineTo(M + 1, far);
    g.lineTo(M + 1, near); g.lineTo(SIDE[3][0], near); g.lineTo(SIDE[3][0], SIDE[3][1]); g.closePath(); g.clip();
    g.fillStyle = GR.p; g.fillRect(500, 130, M - 499, 101);
    quad(g, PTOP[0], PTOP[1], 130, near, GR.L); quad(g, PTOP[2], PTOP[3], 130, near, GR.L);
    g.beginPath(); g.moveTo(SIDE[2][0], SIDE[2][1]); g.lineTo(at(PBEV, 140), 140); g.lineTo(at(PBEV, near - 4), near - 4);
    g.quadraticCurveTo(at(PBEV, near), near, at(PBEV, near) - 6, near); g.lineTo(SIDE[3][0] - 1, near); g.lineTo(SIDE[3][0] - 1, SIDE[3][1]); g.closePath();
    g.fillStyle = GR.L; g.fill();
    g.restore();
    // The block's side face, toward the pitch.
    poly(g, SIDE, GR.s);
    // The block's top: base L, p stripes, the L bevel down its inner edge, a rounded far corner.
    g.save();
    g.beginPath(); g.moveTo(-10, FY.top); g.lineTo(SIDE[1][0] - 10, FY.top); g.quadraticCurveTo(SIDE[1][0], FY.top, SIDE[1][0], FY.top + 10);
    g.lineTo(SIDE[1][0], SIDE[1][1]); g.lineTo(SIDE[0][0], SIDE[0][1]); g.lineTo(SIDE[0][0], FY.face); g.lineTo(-10, FY.face); g.closePath(); g.clip();
    g.fillStyle = GR.L; g.fillRect(-10, FY.top, SIDE[1][0] + 11, SIDE[0][1] - FY.top + 1);
    quad(g, STOP[0], STOP[1], FY.top, SIDE[0][1], GR.p); quad(g, STOP[2], STOP[3], FY.top, SIDE[0][1], GR.p);
    g.restore();
  }
  function fieldTufts(g, rnd) {
    const M = FLD.mid;
    // Stripe edges: small round bumps either way (lawn, pitch top, block top): ~3 per 120 px, 6..10 wide, 2..7 high.
    const SB = [40, [6, 8, 10], [2, 4, 7]];
    for (let i = 1; i < LAWN.length; i++) edgeBumps(g, rnd, LAWN[i], FY.lawn + 2, FY.bot, ...SB, i % 2 ? GR.k : GR.m, i % 2 ? GR.m : GR.k);
    for (let i = 0; i < PTOP.length; i++) edgeBumps(g, rnd, PTOP[i], FY.far + 2, FY.near - 2, ...SB, i % 2 ? GR.L : GR.p, i % 2 ? GR.p : GR.L);
    for (let i = 0; i < STOP.length; i++) edgeBumps(g, rnd, STOP[i], FY.top + 2, i === 3 ? 78 : FY.face - 2, ...SB, i % 2 ? GR.p : GR.L, i % 2 ? GR.L : GR.p);
    // The two bevel bands' outer edges: L lumps into the side face (measured 5 per 131 px, 6..15 wide, 3..7 high).
    edgeBumps(g, rnd, [SIDE[1][0], SIDE[0][0], SIDE[1][1], SIDE[0][1]], SIDE[1][1] + 3, SIDE[0][1] - 3, 26, [6, 9, 15], [3, 5, 7], GR.L, GR.L, 1);
    edgeBumps(g, rnd, PBEV, FY.far + 6, FY.near - 8, 26, [6, 9, 15], [3, 5, 7], GR.L, GR.L, 1);
    // The lawn's top edge, into the faces (measured 70 per 1975 px, 3..15 wide (median 7), 2..9 high (median 6)).
    tuftEdge(g, rnd, -5, FY.lawn, M, FY.lawn, 0, -1, 28, [3, 7, 15], [2, 6, 9], lawnCol);
    // The block fronts' stripe edges: the inner stripe bumps outward (5 per 163 px, 6..15 wide, 3..6 deep);
    // the front's last stripe into the side face (4 per 106 px, 5..15 wide, 5..6 deep).
    for (let i = 0; i < 3; i++) tuftEdge(g, rnd, SFACE[i], FY.face + 4, SFACE[i], FY.lawn - 2, -1, 0, 33, [6, 8, 15], [3, 5, 6], () => (i % 2 ? GR.k : GR.f));
    tuftEdge(g, rnd, SFACE[3], SIDE[0][1] + 4, SFACE[3], SIDE[3][1] - 2, 1, 0, 30, [5, 7, 15], [4, 5, 6], () => GR.f);
    // The pitch front's top edge, into the pitch (35 per 936 px, 4..26 wide (median 7), 2..10 high (median 7)).
    tuftEdge(g, rnd, SFACE[3] + 6, FY.near, M, FY.near, 0, -1, 27, [4, 7, 26], [2, 7, 10], (x) => pfaceCol(x));
    // The pitch's far edge, up against the stand (25 per 826 px, 3..23 wide (median 11), 3..18 high (median 8)).
    tuftEdge(g, rnd, 586, FY.far, M, FY.far, 0, -1, 33, [3, 11, 23], [3, 8, 18], (x) => ptopCol(x, FY.far + 1));
    // The side face's far edge (5 per 131 px, 6..15 wide, 3..7 out).
    tuftEdge(g, rnd, SIDE[1][0], SIDE[1][1] + 4, SIDE[2][0], SIDE[2][1] - 6, 1, 0, 26, [6, 9, 15], [3, 5, 7], () => GR.s);
    tuftEdge(g, rnd, SIDE[1][0], FY.top + 12, SIDE[1][0], SIDE[1][1], 1, 0, 26, [6, 9, 15], [3, 5, 7], () => GR.L);
    // The block fronts' top edge, up into the block top (16 per 516 px, 5..21 wide (median 15), 5..16 high (median 10)).
    tuftEdge(g, rnd, -5, FY.face, SFACE[3], FY.face, 0, -1, 32, [5, 15, 21], [5, 10, 16], (x) => sfaceCol(x));
    // The block top's far edge, up against the stand (11 per 556 px, 6..23 wide (median 9), 4..17 high (median 9)).
    tuftEdge(g, rnd, -5, FY.top, SIDE[1][0] - 8, FY.top, 0, -1, 50, [6, 9, 23], [4, 9, 17], () => GR.p);
  }
  // The chalk (one full-width pass): back line 154..156 (x 589..1388), front line 217..221 (x 546..1427), both with a
  // 1 px #dee4db rim; centre circle = a 15 px stroke round r 103 squashed to 0.184 at (987.5, 185.5) with tails out
  // to x 862 / 1113; spot 28 x 7 at (986.5, 182.5); small white bumps on the lines' top edges.
  function chalk(g, rnd) {
    const M = FLD.mid;
    g.fillStyle = GR.d; g.fillRect(589, 153, 799, 4); g.fillRect(546, 216, 881, 6);
    g.fillStyle = GR.W; g.fillRect(589, 154, 799, 2.2); g.fillRect(546, 217, 881, 4);
    g.save(); g.translate(M, 185.5); g.scale(1, 0.184);
    g.strokeStyle = GR.W; g.lineWidth = 15; g.beginPath(); g.arc(0, 0, 103, 0, TAU); g.stroke();
    g.restore();
    g.fillStyle = GR.W;
    for (const s of [-1, 1]) { g.beginPath(); g.moveTo(M + s * 99, 181.5); g.lineTo(M + s * 99, 189); g.lineTo(M + s * 125.5, 188.5); g.lineTo(M + s * 125.5, 184); g.closePath(); g.fill(); }
    g.beginPath(); g.ellipse(986.5, 182.5, 14, 3.5, 0, 0, TAU); g.fill();
    const W = () => GR.W;
    tuftEdge(g, rnd, 589, 153.5, 1388, 153.5, 0, -1, 61, [1, 3, 5], [2, 2.5, 3], W);
    tuftEdge(g, rnd, 546, 216.5, 1427, 216.5, 0, -1, 46, [2, 4, 12], [2, 3, 6], W);
    // The circle's rough rim: bumps on its outer and inner edges and on the tails (about one per 40 px of rim, as on
    // rows 162..164 and 206..208), 3..12 wide, 2..4 high.
    for (let k = 0; k < 18; k++) {
      const a = TAU * rnd(), out = k < 12, R = out ? 1 : -1, c = Math.cos(a), s = Math.sin(a);
      const rx = out ? 110.5 : 95.5, ry = out ? 20.5 : 17.5, nx = R * c / rx, ny = R * s / ry, nl = Math.hypot(nx, ny);
      tuft(g, M + c * rx, 185.5 + s * ry, nx / nl, ny / nl, spread(rnd(), [3, 5, 12]), spread(rnd(), [2, 3, 4]), rnd, GR.W);
    }
    for (const s of [-1, 1]) for (let k = 0; k < 2; k++) tuft(g, M + s * (104 + 20 * rnd()), k ? 188.5 : 182, 0, k ? 1 : -1, spread(rnd(), [3, 5, 12]), spread(rnd(), [2, 3, 4]), rnd, GR.W);
    for (let k = 0; k < 5; k++) tuft(g, 974 + 25 * rnd(), 179.5, 0, -1, 2 + 3 * rnd(), 2 + 2 * rnd(), rnd, GR.W);
  }
  function paintField(g) {
    g.save(); g.translate(FLD.x, FLD.y); g.scale(AT, AT);
    const half = (fn, seed) => { for (const s of [0, 1]) { g.save(); if (s) { g.translate(FLD.w, 0); g.scale(-1, 1); } fn(g, rng(seed + s * 7919)); g.restore(); } };
    half(fieldBase, 1);
    chalk(g, rng(5));
    half(fieldTufts, 11);
    g.restore();
  }

  /* ── the goals: back half (behind the players) and front half (over them) ──
     Drawn in the atlas pixels of their `goal-back` (184 x 554 px at x 985.6, y 3.1) and `goal-front` (160 x 567 px at
     x 1044.2, y -0.8) sprites for the right goal; the left goal is the mirror (sx -1). Every number is a pixel position
     or colour measured on level--goal-back.png / level--goal-front.png (notes-f.md); the shapes are drawn by hand. */
  const GB = { x: 985.6, y: 3.1 }, GF = { x: 1044.2, y: -0.8 };
  const SL = { lit: '#96a6c5', a: '#8b9abb', b: '#7b8aac', c: '#677a9e', d: '#48597a', e: '#3f4f6c', line: '#a0c3ef' };
  // The flat-top hexagon mesh: side s, a cell centred at (cu, cv) in mesh space, every edge stroked once, each point
  // mapped to sprite pixels by the affine A = [ox, oy, ax, ay, bx, by]: (ox, oy) + u (ax, ay) + v (bx, by).
  // The caller clips and sets the stroke.
  function hexMesh(g, s, cu, cv, u0, u1, v0, v1, A) {
    const h = Math.sqrt(3) * s / 2, P = (u, v) => [A[0] + u * A[2] + v * A[4], A[1] + u * A[3] + v * A[5]];
    const seg = (ua, va, ub, vb) => { const a = P(ua, va), b = P(ub, vb); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); };
    g.beginPath();
    for (let i = Math.floor((u0 - cu) / (1.5 * s)) - 1; i <= Math.ceil((u1 - cu) / (1.5 * s)) + 1; i++) {
      const u = cu + i * 1.5 * s, off = (((i % 2) + 2) % 2) * h;
      for (let j = Math.floor((v0 - cv - off) / (2 * h)) - 1; j <= Math.ceil((v1 - cv - off) / (2 * h)) + 1; j++) {
        const v = cv + off + j * 2 * h;
        seg(u - s / 2, v - h, u + s / 2, v - h); seg(u - s / 2, v - h, u - s, v); seg(u - s, v, u - s / 2, v + h);
      }
    }
    g.stroke();
  }
  function clipPoly(g, pts) { poly(g, pts); g.clip(); }
  // A tube: a thick round-jointed stroke, lit side white, shaded band #dee4db (their posts and crossbars).
  function tube(g, pts, w, shade, sw) {
    g.lineJoin = 'round'; g.lineCap = 'round';
    const line = (p, col, lw) => { g.beginPath(); g.moveTo(p[0][0], p[0][1]); for (let i = 1; i < p.length; i++) g.lineTo(p[i][0], p[i][1]); g.strokeStyle = col; g.lineWidth = lw; g.stroke(); };
    line(pts, GR.W, w); if (shade) line(shade, GR.d, sw);
  }
  // Grass in front of a goal's base: tufts in the field's own colour there (the block top's stripes).
  function fieldColAt(wx, wy) {
    let px = (wx - FLD.x) / AT; const py = (wy - FLD.y) / AT; if (px > FLD.mid) px = FLD.w - px;
    let i = 0; while (i < STOP.length && px > at(STOP[i], py)) i++; return i % 2 ? GR.p : GR.L;
  }
  function baseGrass(g, o, x0, x1, y, rnd, mirror) {
    tuftEdge(g, rnd, x0, y, x1, y, 0, -1, 20, [4, 6, 13], [2, 3, 5], (x, yy) => fieldColAt((o.x + x * AT) * mirror, o.y + yy * AT));
  }
  function paintGoalBack(g, mirror) {
    g.save(); g.translate(GB.x, GB.y); g.scale(AT, AT);
    const rnd = rng(mirror > 0 ? 21 : 22);
    // The floodlight tower's pole: x 64..78, lit left (#7b8aac), #677a9e core, light right rim; down to the base bar.
    g.fillStyle = SL.b; g.fillRect(64.5, 0, 13.5, 503);
    g.fillStyle = SL.c; g.fillRect(70, 0, 4, 503);
    g.fillStyle = SL.lit; g.fillRect(77, 52, 1, 230);
    // The glass panel: x 78..136 from y 51 down to the plate, #b3d6f7 at .54 with #dbf3fd streaks (slope -1.35, their
    // spans along x = 100 measured), a grey shadow under the emblem box.
    g.save(); clipPoly(g, [[78, 51], [136, 51], [136, 298], [78, 279]]);
    // (Their streak pixels replace the base colour, so the base is filled only between the streaks.)
    const streaks = (path) => {
      for (const [a, b] of [[30, 80], [110, 114.5], [133, 155.5], [168, 187.5], [201, 224.5], [228, 231.5], [271, 280.5]]) {
        path.moveTo(60, a + 54); path.lineTo(160, a - 81); path.lineTo(160, b - 81); path.lineTo(60, b + 54); path.closePath();
      }
    };
    g.beginPath(); g.rect(78, 51, 58, 247); streaks(g); g.fillStyle = 'rgba(179,214,247,0.537)'; g.fill('evenodd');
    g.beginPath(); streaks(g); g.fillStyle = 'rgba(219,243,253,0.506)'; g.fill();
    g.fillStyle = 'rgba(142,161,166,0.56)'; g.fillRect(78, 51, 58, 2.5);
    g.fillStyle = 'rgba(189,231,237,0.13)'; g.fillRect(135.5, 51, 1, 247);
    g.restore();
    // The emblem box: #677a9e, an inset #48597a frame, a slanted foot; the ball drawn in its outline.
    poly(g, [[64.5, 0], [134, 0], [134, 47.5], [64.5, 50.5]], SL.c);
    g.fillStyle = SL.b; g.fillRect(64.5, 0, 5.5, 51);
    g.fillStyle = SL.d; g.fillRect(77, 0, 3, 44.5); g.fillRect(128, 0, 3, 41);
    poly(g, [[77, 42], [131, 39.5], [131, 42], [77, 45.5]], SL.d);
    poly(g, [[70, 49], [134, 46], [134, 48], [70, 51.5]], SL.d);
    // Ball: outline x 85..119, y 2..36 (#48597a, 2 px); #3f4f6c patches measured: three whole ones (x 93..102 y 6..14,
    // x 106..115 y 17..27, x 89..98 y 23..31) and three cut by the rim (top right, bottom, left); seams between them.
    g.save(); g.translate(102, 19);
    g.strokeStyle = SL.d; g.lineWidth = 2; g.beginPath(); g.arc(0, 0, 16, 0, TAU); g.stroke();
    g.save(); g.beginPath(); g.arc(0, 0, 15, 0, TAU); g.clip();
    const pent = [[-4.5, -9, 0.15], [8.5, 3, -0.35], [-8.5, 8, 0.45], [11, -12.5, 0.1], [5, 16.5, 0], [-18, -3, 0.3]];
    g.strokeStyle = SL.d; g.lineWidth = 1.5; g.beginPath();
    for (const [a, b] of [[0, 1], [1, 2], [2, 0], [0, 3], [1, 3], [1, 4], [2, 4], [0, 5], [2, 5]]) { g.moveTo(pent[a][0], pent[a][1]); g.lineTo(pent[b][0], pent[b][1]); }
    g.stroke();
    g.fillStyle = SL.e;
    for (const [px, py, rot] of pent) {
      g.beginPath();
      for (let k = 0; k < 5; k++) { const a = rot - Math.PI / 2 + k * TAU / 5; g.lineTo(px + Math.cos(a) * 5.2, py + Math.sin(a) * 5.2); }
      g.closePath(); g.fill();
    }
    g.restore(); g.restore();
    // The plate under the glass: a slanted box, top edge (78, 279) -> (136, 298), an inset #48597a frame, dark right side.
    poly(g, [[64.5, 274], [136, 297.9], [136, 345], [64.5, 321]], SL.c);
    poly(g, [[78, 279], [136, 297.9], [136, 301], [78, 282.5]], SL.a);
    g.strokeStyle = SL.d; g.lineWidth = 2.5; poly(g, [[77.5, 286.5], [130, 303.5], [130, 336], [77.5, 318]]); g.stroke();
    g.fillStyle = SL.d; g.fillRect(131, 299, 3, 46);
    g.fillStyle = SL.b; g.fillRect(64.5, 274, 5.5, 230);
    // Bolts on the pole's right side, pointing into the glass.
    for (const y of [68, 117.5, 170, 218.5, 263]) { poly(g, [[77, y - 5.5], [84, y - 1], [84, y + 1], [77, y + 5.5]], SL.a); poly(g, [[77, y - 3.5], [81.5, y], [77, y + 3.5]], SL.c); }
    // The back net: #b3d6f7 hexagons (side 6.35 px, one centred at (31, 381.5)) between the back post and the side
    // frame line, over the pole; the side net beyond that line, sheared, greyer where it lies on the grass.
    g.save(); clipPoly(g, [[13, 338], [70, 322], [79, 336], [112, 500], [112, 503], [13, 503]]);
    g.strokeStyle = 'rgba(179,214,247,0.72)'; g.lineWidth = 1; hexMesh(g, 6.35, 31, 381.5, 0, 120, 300, 520, [0, 0, 1, 0, 0, 1]);
    g.restore();
    g.save(); clipPoly(g, [[70, 322], [100, 328], [130, 343], [170, 478], [178, 505], [184, 516], [184, 554], [180, 554], [112, 500], [79, 336]]);
    g.strokeStyle = 'rgba(179,214,247,0.62)'; g.lineWidth = 1; hexMesh(g, 6.35, 0, 0, -20, 140, -40, 260, [80, 322, 1, 0.6, 0.2, 1.15]);
    g.beginPath(); g.rect(100, 505, 90, 60); g.clip();
    g.strokeStyle = 'rgba(142,161,166,0.6)'; hexMesh(g, 6.35, 0, 0, -20, 140, -40, 260, [80, 322, 1, 0.6, 0.2, 1.15]);
    g.restore();
    // The roof net from the back post's top to the side frame (white), its far edge and the side frame in #a0c3ef.
    g.save(); clipPoly(g, [[6, 333], [69, 320], [79, 337], [37, 351]]);
    g.strokeStyle = 'rgba(252,255,247,0.85)'; g.lineWidth = 1.2; hexMesh(g, 6.35, 0, 0, -10, 60, -10, 60, [37, 351, 0.98, -0.26, -0.62, -0.36]);
    g.restore();
    g.strokeStyle = SL.line; g.lineWidth = 1.6; g.lineJoin = 'round';
    g.beginPath(); g.moveTo(16, 331); g.lineTo(69, 320); g.lineTo(78, 336); g.lineTo(112, 500.5); g.stroke();
    // The back post (x 0..15: white, #dee4db band 7..13) bending at its top (outer edge y 331) into the side bar, one
    // straight tube to the front post's elbow (51.9, 365.2 here); this sprite holds it to x 37, the front one the rest.
    g.save(); g.beginPath(); g.rect(-2, 300, 39.5, 220); g.clip();
    tube(g, [[7.5, 506], [7.5, 338.5], [51.9, 365.2]], 15.5, [[10, 506], [10, 336], [53.7, 362.2]], 6);
    g.restore();
    // The base bar: white top (502..505), #dee4db below to 511, x 0..118, a joint at x 46..61; grass in front of it.
    g.fillStyle = GR.W; g.fillRect(0, 502, 118, 3);
    g.fillStyle = GR.d; g.fillRect(0, 504.5, 118, 6.5);
    g.fillStyle = GR.W; g.fillRect(46, 502, 7, 9); g.fillRect(59, 502, 2, 9);
    baseGrass(g, GB, -2, 120, 511, rnd, mirror);
    g.restore();
  }
  function paintGoalFront(g, mirror) {
    g.save(); g.translate(GF.x, GF.y); g.scale(AT, AT);
    const rnd = rng(mirror > 0 ? 31 : 32);
    // The front net: hexagons of side 7.67 px (one centred at (42, 375.6)), #f9fbf2 at .7, 1 px lines, from the post to
    // the pole and on, right of the pole, to the side frame line (120.5, 402) -> (157, 546).
    g.save(); clipPoly(g, [[33, 366], [104, 350.5], [120, 350.5], [120.5, 402], [157, 546], [33, 546]]);
    g.strokeStyle = 'rgba(249,251,242,0.7)'; g.lineWidth = 1; hexMesh(g, 7.67, 42, 375.6, 20, 170, 330, 560, [0, 0, 1, 0, 0, 1]);
    g.restore();
    g.strokeStyle = GR.W; g.lineWidth = 2; g.beginPath(); g.moveTo(120.5, 401); g.lineTo(157.5, 547); g.stroke();
    // The roof net: the same mesh on the parallelogram front (33, 365) -> (104, 350), back to (5, 348), whiter lines;
    // its front edge (the top of the front net) a 2 px white line.
    g.save(); clipPoly(g, [[33, 365.5], [104.5, 350], [76, 333.5], [4.5, 348]]);
    g.strokeStyle = 'rgba(252,255,247,0.88)'; g.lineWidth = 1.2; hexMesh(g, 7.67, 9, 0, -10, 90, -60, 10, [33, 365, 0.973, -0.205, 0.609, 0.37]);
    g.restore();
    g.strokeStyle = GR.W; g.lineWidth = 2.2; g.beginPath(); g.moveTo(33, 366); g.lineTo(104.5, 350.5); g.stroke();
    // The pole: x 105..120 (#96a6c5 rim, #8b9abb, #677a9e, #48597a, #677a9e), the whole height, with bolts on its left.
    g.fillStyle = SL.lit; g.fillRect(105, 0, 1, 567); g.fillStyle = SL.a; g.fillRect(106, 0, 2, 567);
    g.fillStyle = SL.c; g.fillRect(108, 0, 6, 567); g.fillStyle = SL.d; g.fillRect(114, 0, 5, 567); g.fillStyle = SL.c; g.fillRect(119, 0, 1, 567);
    for (const y of [69.5, 122.5, 180.5, 232.5, 282]) { poly(g, [[105.5, y - 4.5], [100, y - 2], [100, y + 2], [105.5, y + 4.5]], SL.c); poly(g, [[105.5, y - 4.5], [103, y - 3.5], [103, y + 3.5], [105.5, y + 4.5]], SL.d); }
    // The front post (x 18..33, white, #dee4db band 26..32) and the side bar it bends into, up-left toward the back
    // post's elbow (-18.9, 340.3 here), cut at this sprite's left edge like theirs.
    g.save(); g.beginPath(); g.rect(0, 300, 60, 270); g.clip();
    tube(g, [[-18.9, 340.3], [25.5, 367], [25.5, 552]], 16, [[-17.1, 337.3], [27.3, 364], [29, 369], [29, 552]], 6);
    g.restore();
    // The base bar: white 545..551, #dee4db 551..558, x 18..158; grass in front of it.
    g.fillStyle = GR.W; g.fillRect(18, 545, 140, 6);
    g.fillStyle = GR.d; g.fillRect(26, 551, 132, 7);
    g.fillStyle = GR.W; g.fillRect(18, 551, 8, 6);
    baseGrass(g, GF, 16, 160, 558, rnd, mirror);
    g.restore();
  }
  function bothGoals(g, paint) { paint(g, 1); g.save(); g.scale(-1, 1); paint(g, -1); g.restore(); }

  root.HSPitch = {
    setView(vw) { VW = vw; },
    field: paintField,
    goalsBack: (g) => bothGoals(g, paintGoalBack), goalsFront: (g) => bothGoals(g, paintGoalFront),
  };
})(window);
