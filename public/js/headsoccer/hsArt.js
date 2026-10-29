'use strict';
/* ─── Head Soccer, the picture ────────────────────────────────────────────────
   Everything on the pitch, drawn in code: the daytime stadium (sky, drifting
   clouds, the roof, the crowd, the digital board on its two posts), the sunken
   pitch between two raised grass shelves, the goals with their nets and
   floodlight towers, the two big-headed players, the ball, the score plate, the
   countdown, GOAL!, the key hint, the pause button and the phone buttons.

   THE LOOK IS HEADS ARENA EURO SOCCER'S LAYOUT, PAINTED OUR OWN WAY. Where each
   thing sits and its colours were measured from the reference (its source places
   every sprite; the art inside each sprite was measured pixel by pixel):
   docs/head-soccer-reference.md, "The look". No image, font or sprite of theirs
   is used, and the players are our own cartoon characters, nobody real.

   WORLD UNITS ARE THE PHYSICS' (shared/hsSim.js): the reference's design units,
   x from the halfway line, y down from the top of a 1920-high frame. The page
   owns the one transform from there to the screen.

   CHEAP PER FRAME. What does not move is painted once per resize into
   offscreen canvases at the screen's real resolution (sky, cloud strip, three
   crowd frames over the stands, the pitch with the goal backs, the goal fronts,
   the ball, the plate, the pause button, the key hint, the ten clock digits, the
   GOAL! and GOLDEN GOAL words), so a frame is a handful of drawImage calls plus
   the players and the score and countdown text. */
(function (root) {
  const Sim = root.HSSim, HS = Sim.HS, S = root.HSScene, F = root.HSPitch, P = root.HSChars;
  const FONT = 'Archivo, "Arial Black", "Segoe UI", Arial, sans-serif';
  const TAU = Math.PI * 2;

  /* The measured layout (doc "The look"), world units. Every HUD number below was measured on the
     reference (its source places each sprite; the art inside was measured pixel by pixel, at 2.222 units
     an atlas pixel): the list of values and where each came from is in the doc. */
  const BOARD = { x0: -334, x1: 334, digitRight: [-163, -40, 130, 253], digitY: 230 };   // S: 45 +- 85 (+- 123), H/2 - 730
  const PLATE = { y: 1795, half: 439, ballX: 385, ballY: 1793, histX: 340, histY: 1783, scoreY: 1785 };   // S: _scoreBasePosition H - 115
  // Their HUD font ("normal", Refrigerator Deluxe) is not free. Sofia Sans Extra Condensed 700 is the closest
  // free one: the best glyph overlap of 40 Google fonts against theirs (.785; Archivo .37). Their LCD clock font
  // is drawn segment by segment below.
  const HFONT = '"Sofia Sans Extra Condensed", "Arial Narrow", sans-serif';
  // Ask for it at once (a canvas alone only asks on first use), and repaint the cached key hint when it lands.
  const fontReady = root.document && document.fonts && document.fonts.load ? document.fonts.load('700 40px "Sofia Sans Extra Condensed"').catch(() => {}) : Promise.resolve();
  fontReady.then(() => { if (art.bg) L.keys = paintKeys(); });
  const C = {
    slateLit: '#8b9abb', slateMid: '#7b8aac', slate: '#677a9e', slateDark: '#48597a', slateDeep: '#3f4f6c',
    plate: '#465778', plateLine: '#536587', shade: 'rgba(102,90,130,0.62)', chalk: '#fcfff7',
    key: '#0155dd', keyLit: '#0e64e9', keyEdge: '#0a52bf', keySide: '#0548ab', keyText: '#2b76e8',
    ink: '#342d2f', outline: '#24314f',
  };

  let K = 1, VW = HS.VIEW_W_REF;                 // device px per world unit, visible world width
  const L = {};                                  // the offscreen layers

  function canvas(w, h) { const c = document.createElement('canvas'); c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h)); return c; }
  function rr(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  function box(g, b, fill) { rr(g, b[0], b[2], b[1] - b[0], b[3] - b[2], b[4] || 0); if (fill) { g.fillStyle = fill; g.fill(); } }   // b = [x0, x1, y0, y1, r]
  function poly(g, pts, fill) { g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]); g.closePath(); if (fill) { g.fillStyle = fill; g.fill(); } }
  function disc(g, x, y, r, fill) { g.beginPath(); g.arc(x, y, r, 0, TAU); if (fill) { g.fillStyle = fill; g.fill(); } }
  // A polygon with every corner rounded to r.
  function roundPoly(g, pts, r) {
    const n = pts.length, mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    g.beginPath(); const m0 = mid(pts[n - 1], pts[0]); g.moveTo(m0[0], m0[1]);
    for (let i = 0; i < n; i++) { const p = pts[i], q = pts[(i + 1) % n], m = mid(p, q); g.arcTo(p[0], p[1], m[0], m[1], r); }
    g.closePath();
  }
  // A layer covering the visible world (x -VW/2..VW/2, y 0..1920) at K, drawn in world units.
  function layer(draw, h) {
    const c = canvas(VW * K, (h || HS.VIEW_H) * K), g = c.getContext('2d');
    g.setTransform(K, 0, 0, K, VW / 2 * K, 0);
    draw(g);
    return c;
  }
  // A layer covering only world y [y0, y1] of the visible width (the crowd's frames: five of them, so kept small).
  const CROWD_BAND = [600, 1460];
  function band(b, draw) {
    const c = canvas(VW * K, (b[1] - b[0]) * K), g = c.getContext('2d');
    g.setTransform(K, 0, 0, K, VW / 2 * K, -b[0] * K);
    draw(g);
    return c;
  }
  function layerSmall(w, h, ox, oy, draw) {
    const c = canvas(w * K, h * K), g = c.getContext('2d');
    g.setTransform(K, 0, 0, K, ox * K, oy * K); draw(g);
    c.ox = ox; c.oy = oy; c.ww = w; c.wh = h;
    return c;
  }
  function blit(ctx, c, x, y) { ctx.drawImage(c, x - c.ox, y - c.oy, c.ww, c.wh); }

  /* ── the digital board on its two posts (painted once; its digits are drawn live) ───── */
  // Their board is part of the tribune art: side caps, a slate frame lit along the top, a sunken panel
  // with four darker digit cells and the colon between them, on two posts that stand on the roof.
  const BD = {
    cap: [-333.3, -290, 62.2, 366.6, 28], capLine: [-317.8, -313.3, 79, 352],
    back: [-313.3, 315.6, 70, 367.7, 16], frame: [-306.7, 308.9, 62.2, 356.6, 14], frameLit: 72.2, frameMid: 74.4,
    pOut: [-286.7, 291.1, 83.3, 347.7, 24], pShadow: [-286.7, 288.9, 83.3, 345.5, 24], pIn: [-282.2, 286.7, 94.4, 336.6, 18],
    cells: [[-266.7, -148.9], [-138.9, -21.1], [21.1, 138.9], [150, 267.8]], cellY: [112.2, 316.6], cellR: 24,
    posts: [[-245.6, -203.3], [205.6, 245.6]], postY: [367.7, 392.2, 394.4, 588.9],
    colon: [[[6.7, 176.7], [14.4, 186.7], [13.3, 198.9], [1.1, 208.9], [-6.7, 198.9], [-5.6, 187.8]],
            [[-2.2, 227.8], [7.8, 237.8], [6.7, 247.8], [-6.7, 256.6], [-14.4, 247.8], [-12.2, 236.7]]],
  };
  // A cap: a pill lit along its top-left and shaded along its bottom (both are crescents of the same pill).
  function capPill(g, b, lit, body, dark, litDx, litDy, darkDy) {
    g.save(); box(g, b); g.clip();
    g.fillStyle = dark; g.fillRect(b[0], b[2], b[1] - b[0], b[3] - b[2]);
    const up = [b[0], b[1], b[2] - darkDy, b[3] - darkDy, b[4]];
    box(g, up, lit); box(g, up); g.clip();
    box(g, [b[0] + litDx, b[1] + litDx, b[2] + litDy, b[3] + litDy, b[4]], body);
    g.restore();
  }
  function paintBoard(g) {
    for (const [a, b] of BD.posts) {
      const y = BD.postY;
      g.fillStyle = C.slateLit; g.fillRect(a, y[0], b - a, y[3] - y[0]);
      g.fillStyle = C.slate; g.fillRect(a, y[0], b - a, y[1] - y[0]);
      g.fillStyle = C.slateMid; g.fillRect(a, y[1], b - a, y[2] - y[1]);
    }
    for (const sx of [1, -1]) {
      g.save(); g.scale(sx, 1);
      capPill(g, BD.cap, C.slateLit, C.slate, C.slateDark, 2.2, 11, 8);
      g.fillStyle = C.slateMid; g.fillRect(BD.capLine[0], BD.capLine[2], 2.2, BD.capLine[3] - BD.capLine[2]);
      g.fillStyle = C.slateLit; g.fillRect(BD.capLine[0] + 2.2, BD.capLine[2], 2.3, BD.capLine[3] - BD.capLine[2]);
      g.restore();
    }
    box(g, BD.back, C.slateDark);
    box(g, BD.frame, C.slate);
    g.save(); box(g, BD.frame); g.clip();
    g.fillStyle = C.slateLit; g.fillRect(BD.frame[0], BD.frame[2], BD.frame[1] - BD.frame[0], BD.frameLit - BD.frame[2]);
    g.fillStyle = C.slateMid; g.fillRect(BD.frame[0], BD.frameLit, BD.frame[1] - BD.frame[0], BD.frameMid - BD.frameLit);
    g.restore();
    box(g, BD.pOut, C.slateDark); box(g, BD.pShadow, C.slateDeep); box(g, BD.pIn, C.slateDark);
    for (const [a, b] of BD.cells) box(g, [a, b, BD.cellY[0], BD.cellY[1], BD.cellR], C.slateDeep);
    for (const dot of BD.colon) poly(g, dot, C.chalk);
  }

  /* ── the clock digits: their LCD font, drawn segment by segment ────────── */
  // S: four bitmapTexts in "digital-time" at size 190, each right-aligned (anchor 1, .5) at BOARD.digitRight.
  // The glyph geometry is fitted to their font sheet, in font units (the font is size 54; soft overlap .84 to .93 a
  // glyph): uprights 19.25 apart and 43.1 tall slanted .134, strokes 5.5 thick with mitred points and small gaps.
  const DS = 190 / 54, DSK = 0.134, DT = 2.75, DG = 0.3, DX0 = -0.03, DY0 = 0.5, DH = 43.1;
  const DL = 2.75, DR = 22, DTOP = 2.75, DMID = 21.55, DBOT = 40.35;
  const TL = [DL, DTOP], TR = [DR, DTOP], ML = [DL, DMID], MR = [DR, DMID], BL = [DL, DBOT], BR = [DR, DBOT];
  const SEG = { a: [TL, TR], b: [TR, MR], c: [MR, BR], d: [BL, BR], e: [ML, BL], f: [TL, ML], g: [ML, MR] };
  const GLYPH = { 0: 'abcdef', 6: 'afgedc', 8: 'abcdefg', 9: 'abcdfg' };
  // The odd ones, as fitted: the 1 sits left in its cell with a flag, the 2 and 5 keep short stubs, the 3, 5 and 7
  // run their bars past a missing upright, the 4 runs its uprights to the cell edges, the 7 has a broken diagonal.
  function glyphSegs(ch) {
    const s = (k) => SEG[k];
    switch (ch) {
      case '1': return [[[14.95, 0.2], [14.95, DMID]], [[14.9, DMID], [14.9, 43]], [[10.35, 4.4], [7.85, 13.7], 2.45]];
      case '2': return 'abged'.split('').map(s).concat([[TL, [DL, 10.4]]]);
      case '3': return [[[0.35, DTOP], TR], [[0.05, DBOT], BR], [[3.25, DMID], MR], SEG.b, SEG.c];
      case '4': return [[[DL, 0], ML], SEG.g, [[DR, 0], MR], [MR, [DR, DH]]];
      case '5': return [[TL, [22.75, DTOP]], SEG.f, SEG.g, SEG.c, SEG.d, [[DL, 32.55], BL]];
      case '7': return [[[-0.15, DTOP], [25, DTOP]], [[22.2, 7.7], [15.85, 21.75], 2.5], [[14.5, 22], [3.5, 43.6], 2.5]];
      default: return (GLYPH[ch] || '').split('').map(s);
    }
  }
  // A segment from p to q, t half its thickness, pointed at both ends and pulled back gap from each.
  function hexSeg(p, q, t, gap) {
    const dx = q[0] - p[0], dy = q[1] - p[1], l = Math.hypot(dx, dy), ux = dx / l, uy = dy / l, nx = -uy * t, ny = ux * t, ax = ux * t, ay = uy * t;
    const a = [p[0] + ux * gap, p[1] + uy * gap], b = [q[0] - ux * gap, q[1] - uy * gap];
    return [a, [a[0] + ax + nx, a[1] + ay + ny], [b[0] - ax + nx, b[1] - ay + ny], b, [b[0] - ax - nx, b[1] - ay - ny], [a[0] + ax - nx, a[1] + ay - ny]];
  }
  // One glyph, cached, origin at its cell's top-left (S: a cell is the font's advance, 28.35 units, its top 3.15 down).
  function paintDigit(ch) {
    return layerSmall(38 * DS, 46 * DS, 3 * DS, DS, (g) => {
      for (const sg of glyphSegs(ch)) poly(g, hexSeg(sg[0], sg[1], sg[2] || DT, DG).map(([u, v]) => [DS * (DX0 + u + DSK * (DH - v)), DS * (DY0 + v)]), '#fff');
    });
  }
  // S: anchor .5 of the line height 56.7, glyph offset 3.15; their glyphs land 4 units lower and 4 further right on
  // screen than that layout says (measured on the captured frame), so ours do too.
  const DIGIT_TOP = BOARD.digitY - 56.7 / 2 * DS + 3.15 * DS + 4, DIGIT_DX = 4;

  /* ── the ball ───────────────────────────────────────────────────────────── */
  // Two caches per ball: the back (its lit disc and shade, which stay put) and the front (patches and seams, which
  // turn with the ball), as the reference stacks ball-back under ball-front.
  const BALL_R = P.BALL_R;
  function paintBall(part, golden) {
    const R = BALL_R, c = canvas(2 * (R + 4) * K, 2 * (R + 4) * K), g = c.getContext('2d');
    g.setTransform(K, 0, 0, K, (R + 4) * K, (R + 4) * K);
    part(g, golden);
    return c;
  }

  /* ── the score plate ────────────────────────────────────────────────────── */
  // Their "score" sprite (877.8 x 175.6, top-left -438.9, 1707.2): a long pill with a ball socket at each end
  // under a capped box, the same build as the board. Coordinates are world units.
  const PL = {
    pill: [-438.9, 438.9, 1734, 1856, 61], pillDark: 11, pillBody: 22.4, socket: [385.5, 1793.5, 37.8],
    shade: [-247.8, 247.8, 1712, 1882.8, 14], cap: [-247.8, -200, 1707.2, 1880.5, 18], capLine: [-236.7, -234.4, 1725, 1866],
    back: [-234.4, 234.4, 1712, 1880.5, 10], frame: [-229, 229, 1708, 1880.5, 12], frameLit: 1716.1, frameBand: 1873,
    ring: [-216.7, 216.7, 1722.8, 1866, 18], body: [-212.2, 212.2, 1731.6, 1858.3, 14],
  };
  function paintPlate() {
    return layerSmall(2 * PLATE.half + 20, 200, PLATE.half + 10, 100, (g) => {
      g.translate(0, -PLATE.y);
      const p = PL.pill, inset = (d) => [p[0] + d, p[1] - d, p[2] + d, p[3] - d, p[4] - d];
      box(g, p, C.slateLit); box(g, inset(PL.pillDark), C.slateDeep); box(g, inset(PL.pillBody), C.plate);
      for (const s of [-1, 1]) disc(g, s * PL.socket[0], PL.socket[1], PL.socket[2], C.slateDeep);
      box(g, PL.shade, C.shade);
      for (const sx of [1, -1]) {
        g.save(); g.scale(sx, 1);
        capPill(g, PL.cap, C.slateLit, C.slate, C.plateLine, 2.2, 11, 9);
        g.fillStyle = C.slateMid; g.fillRect(PL.capLine[0], PL.capLine[2], PL.capLine[1] - PL.capLine[0], PL.capLine[3] - PL.capLine[2]);
        g.restore();
      }
      box(g, PL.back, C.plate);
      box(g, PL.frame, C.slate);
      g.save(); box(g, PL.frame); g.clip();
      g.fillStyle = C.slateLit; g.fillRect(PL.frame[0], PL.frame[2], PL.frame[1] - PL.frame[0], PL.frameLit - PL.frame[2]);
      g.fillStyle = C.plateLine; g.fillRect(PL.frame[0], PL.frameBand, PL.frame[1] - PL.frame[0], PL.frame[3] - PL.frameBand);
      g.restore();
      box(g, PL.ring, C.slateDeep); box(g, PL.body, C.plate);
    });
  }
  // Their small "ball" icon on the plate (S: scale .6, 61 x 60 units): white, a dark rim, black patches, lilac seams.
  function paintUiBall() {
    return layerSmall(68, 68, 34, 34, (g) => {
      const u = 1.333, at = (x, y) => [(x - 23) * u, (y - 22.5) * u];      // their icon's pixels -> units
      disc(g, 0, 0, 30.4, C.ink); disc(g, 0, 0, 28.2, '#fcfef7');
      g.save(); disc(g, 0, 0, 28.2); g.clip();
      const pent = (x, y, r, rot) => { const c = at(x, y), pts = []; for (let i = 0; i < 5; i++) { const a = rot + i * TAU / 5; pts.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]); } return pts; };
      const patches = [[27.5, 10.5, 9, -1.4], [11, 26, 9, 2.6], [31, 33, 9, 0.3], [3, 8, 8, 0.6], [11, 42, 8, 1.2], [45, 18, 7, 0]];
      g.strokeStyle = '#9887a2'; g.lineWidth = 1.6; g.lineCap = 'round';
      for (const [x, y, r, rot] of patches.slice(0, 3)) for (const [px, py] of pent(x, y, r, rot)) {
        const c = at(x, y); g.beginPath(); g.moveTo(px, py); g.lineTo(c[0] + (px - c[0]) * 2.1, c[1] + (py - c[1]) * 2.1); g.stroke();
      }
      for (const [x, y, r, rot] of patches) poly(g, pent(x, y, r, rot), C.ink);
      g.restore();
    });
  }

  /* ── the HUD text: their "normal" font's layout, our font's glyphs ─────── */
  // S: bitmapText lays a string out on the font's advances (font units of 67.5) and anchors the whole line; each glyph's
  // white body is drawn centred on where theirs sits. Per glyph: advance, offset, width (their .fnt metrics).
  const NM = { 0: [30.6, -5.4, 30.6], 1: [24.75, -6.3, 27], 2: [30.6, -5.4, 30.6], 3: [30.6, -5.4, 30.6], 4: [30.6, -6.3, 32.4],
    5: [30.6, -5.4, 30.6], 6: [30.6, -5.4, 30.6], 7: [27.9, -7.2, 30.6], 8: [30.6, -5.4, 30.6], 9: [30.6, -5.4, 30.6],
    ' ': [13.5, -9, 0], '-': [18, -7.2, 21.6], H: [30.6, -5.4, 30.6], a: [26.55, -6.3, 27], l: [13.05, -5.4, 13.5], f: [19.8, -7.65, 24.3],
    t: [19.8, -7.65, 24.3], i: [13.05, -6.3, 15.3], m: [39.15, -5.4, 39.6], e: [27, -5.4, 27] };
  // Their digits' white body is .711 of the size tall (48 of 67.5); Sofia Sans Extra Condensed's are .665 of its size.
  const NF = (48 / 67.5) / 0.665;
  // ax: 0 left, .5 centre, 1 right (S: anchor x; y is always .5). The outline: theirs is ~2.7 font units wide, navy at the
  // top fading to pale blue at the bottom, half see-through.
  function refText(g, text, x, y, size, ax) {
    const s = size / 67.5, m = (ch) => NM[ch] || NM[0];
    let w = 0; for (const ch of text) w += m(ch)[0];
    const base = y + 30.8 * s, top = base - 48 * s;            // S: line top y - 36s; their body runs 18.8s..66.8s below it
    g.save();
    g.font = '700 ' + (size * NF).toFixed(1) + 'px ' + HFONT; g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.lineJoin = 'round';
    const gr = g.createLinearGradient(0, top - 3 * s, 0, base + 3 * s);
    gr.addColorStop(0, 'rgba(6,47,101,0.55)'); gr.addColorStop(0.5, 'rgba(96,137,181,0.48)'); gr.addColorStop(1, 'rgba(161,207,248,0.45)');
    g.strokeStyle = gr; g.lineWidth = 5.4 * s; g.fillStyle = '#fff';
    for (const pass of [0, 1]) {
      let cx = x - w * s * (ax == null ? 0.5 : ax);
      for (const ch of text) {
        const q = m(ch);
        const gx = cx + (q[1] + q[2] / 2) * s;
        if (ch === '-') {                        // their dash: a bar 15.5 x 5.4 font units, its middle 50.4 below the line top
          g.beginPath(); g.rect(gx - 7.75 * s, y + 11.7 * s, 15.5 * s, 5.4 * s);
          if (pass) g.fill(); else g.stroke();
        } else if (ch !== ' ') { if (pass) g.fillText(ch, gx, base); else g.strokeText(ch, gx, base); }
        cx += q[0] * s;
      }
    }
    g.restore();
  }
  // Our own labels (names, YOU): same font, a solid outline.
  function words(g, text, x, y, size, opts) {
    const o = opts || {};
    g.save();
    g.font = '700 ' + (size * 1.15).toFixed(1) + 'px ' + HFONT;
    g.textAlign = o.align || 'center'; g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.lineWidth = size * (o.stroke || 0.16); g.strokeStyle = o.edge || C.outline;
    g.strokeText(text, x, y);
    g.fillStyle = o.fill || '#fff'; g.fillText(text, x, y);
    g.restore();
  }

  /* ── the pause button (S: RoundButton, button-up with icon-pause at .563, at W - 100, 100) ── */
  function paintPause() {
    return layerSmall(220, 220, 110, 110, (g) => {
      disc(g, 0, 0, 100, '#6f5a81'); disc(g, 0, 0, 97.8, '#9887a2');                // rim, and the lilac base showing below the ring
      g.save(); disc(g, 0, 0, 97.8); g.clip();
      disc(g, 0, -16.8, 99, '#ffffff'); disc(g, 0, -16.8, 99); g.clip();               // the cream ring, white along its top
      disc(g, 0, 10.1, 99, '#ffeddf');
      g.restore();
      disc(g, 0, 0, 82.2, '#2f6c14');                                                   // the green face and its outline
      g.save(); disc(g, 0, 0, 79.5); g.clip();
      disc(g, 0, 0, 79.5, '#7acc53'); disc(g, 0, 10.6, 79.5, '#9ad97c'); disc(g, 0, 16.2, 79.5, '#4e8f2f');
      disc(g, 0, 16.2, 79.5); g.clip();
      disc(g, 0, -14, 79.5, '#39851c'); disc(g, 0, -19.5, 79.5, '#5ea040');
      g.restore();
      g.fillStyle = '#fff'; rr(g, -38.7, -50, 28.8, 100, 14.4); g.fill(); rr(g, 10.1, -50, 28.7, 100, 14.3); g.fill();
    });
  }
  const PAUSE_AT = () => ({ x: VW / 2 - 100, y: 100, r: 100 });

  /* ── the key hint (S: ControlsIndicator: player-buttons-space at .9, alpha .8, top-left -1282, 1659) ── */
  // Drawn in their sprite's pixels (2 units each): three rounded triangle keys and SPACE, each with a lit disc,
  // a darker side below and a soft shadow; white arrows (their icon-back at .3, .27 units a pixel).
  const KEYS = {
    up: [[89.5, -5.3], [54.7, 55], [124.3, 55]], left: [[-5.5, 90], [56, 54.5], [56, 125.5]], right: [[187.5, 90], [126, 54.5], [126, 125.5]],
    shine: { up: [89.5, 22, 16], left: [24, 86, 15.3], right: [158, 86, 15.3] }, r: 6, space: [60, 120.5, 78.5, 102, 4.5],
  };
  function arrow(g) {                              // their back arrow, in its own pixels (85 x 92), tip left
    g.strokeStyle = '#fff'; g.lineWidth = 19; g.lineCap = 'round'; g.lineJoin = 'round';
    g.beginPath(); g.moveTo(49.5, 9.5); g.lineTo(10, 46); g.lineTo(49.5, 82.5); g.moveTo(10, 46); g.lineTo(74.5, 46); g.stroke();
  }
  function paintKeys() {
    return layerSmall(380, 280, 190, 140, (g) => {
      g.translate(-182, -131); g.scale(2, 2);      // their sprite's pixels, with the layer's origin at (-1100, 1790)
      const keys = [KEYS.up, KEYS.left, KEYS.right], sp = KEYS.space;
      const shape = (pts, dy) => roundPoly(g, pts.map(([x, y]) => [x, y + dy]), KEYS.r);
      const space = (dy) => rr(g, sp[0], sp[2] + dy, sp[1] - sp[0], sp[3] - sp[2], sp[4]);
      g.fillStyle = 'rgba(102,90,130,0.42)'; for (const k of keys) { shape(k, 7); g.fill(); } space(7); g.fill();
      g.fillStyle = C.keySide; for (const k of keys) { shape(k, 4); g.fill(); } space(4); g.fill();
      for (const [k, sh] of [[KEYS.up, KEYS.shine.up], [KEYS.left, KEYS.shine.left], [KEYS.right, KEYS.shine.right]]) {
        shape(k, 0); g.fillStyle = C.key; g.fill();
        g.save(); shape(k, 0); g.clip(); disc(g, sh[0], sh[1], sh[2], C.keyLit);
        if (k !== KEYS.up) { g.fillStyle = C.keyEdge; g.fillRect(k === KEYS.left ? 54 : 126, 40, 2, 100); }
        g.restore();
      }
      space(0); g.fillStyle = C.keyLit; g.fill();
      // SPACE: their letters are 50 x 13 pixels (x 65..115, y 82..95), wider than our condensed font, so it is stretched.
      g.font = '700 ' + (13 / 0.665).toFixed(1) + 'px ' + HFONT; g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.lineJoin = 'round';
      const tw = g.measureText('SPACE').width;
      g.save(); g.translate(90, 95); g.scale(50 / tw, 1);
      g.lineWidth = 2.4; g.strokeStyle = C.keyText; g.strokeText('SPACE', 0, 0); g.fillStyle = '#fff'; g.fillText('SPACE', 0, 0);
      g.restore();
    });
  }
  // The arrows are their own sprites at alpha .8 over the keys (also .8), so they are their own layer.
  function paintArrows() {
    return layerSmall(380, 280, 190, 140, (g) => {
      g.translate(-182, -131); g.scale(2, 2);
      const icon = (m) => { g.save(); g.transform(m[0], m[1], m[2], m[3], m[4], m[5]); arrow(g); g.restore(); };
      icon([0.3, 0, 0, 0.3, 24.25, 74.2]);                          // left
      icon([-0.3, 0, 0, 0.3, 157.75, 74.2]);                        // right (S: scale x -.3)
      icon([0, 0.3, -0.3, 0, 91 + 0.3 * 46, 34 - 0.3 * 42.5]);      // up (S: rotation 1.57)
    });
  }

  function hudDraw(g, hud, now) {
    // The board's clock, MM:SS of game time.
    const d = hud.digits || '0000';
    for (let i = 0; i < 4; i++) { const c = L.digits[d[i]]; if (c) blit(g, c, BOARD.digitRight[i] - 28.35 * DS + DIGIT_DX, DIGIT_TOP); }
    // The score plate at the bottom (shown from the first whistle, S: _showScore).
    if (hud.plate) {
      blit(g, L.plate, 0, PLATE.y);
      for (const s of [-1, 1]) blit(g, L.uiBall, s * PLATE.ballX, PLATE.ballY);
      refText(g, String(hud.hist[0] | 0), -PLATE.histX, PLATE.histY, 60, 0);
      refText(g, String(hud.hist[1] | 0), PLATE.histX, PLATE.histY, 60, 1);
      if (!hud.scoreBig) refText(g, hud.score[0] + '   -   ' + hud.score[1], 0, PLATE.scoreY, 120);
      // Names (ours: an online duel says who is who), small over the plate's ends.
      const mine = hud.mine;
      for (let s = 0; s < 2; s++) {
        const nm = hud.names[s] || '';
        if (!nm) continue;
        words(g, nm, (s === 0 ? -1 : 1) * (PLATE.half - 10), PL.pill[2] - 40, 44, { align: s === 0 ? 'left' : 'right', fill: s === mine ? '#ffe27a' : '#fff', stroke: 0.2 });
      }
    }
    if (hud.scoreBig) {
      // S: endScreen: the score rises to the middle at twice its size and stays 3 s.
      const u = Math.min(1, hud.scoreBig / 500), e = 1 - (1 - u) * (1 - u);
      refText(g, hud.score[0] + '   -   ' + hud.score[1], 0, PLATE.scoreY + (HS.VIEW_H / 2 - PLATE.scoreY) * e, 120 * (1 + e));
    }
    // The pause button, top right of the visible frame (S: W - 100, 100).
    blit(g, L.pause, VW / 2 - 100, 100);
    if (hud.keys) { g.globalAlpha = 0.8; blit(g, L.keys, -1100, HS.VIEW_H - 130); blit(g, L.arrows, -1100, HS.VIEW_H - 130); g.globalAlpha = 1; }
    if (hud.sudden) suddenBanner(g);
  }

  // S: doCountDown: the number at the middle of the frame, size 170, swapped every 600 ms, no animation.
  function countText(g, n) { refText(g, String(n), 0, HS.VIEW_H / 2, 170); }
  /* ── GOAL! and GOLDEN GOAL (S: flashGoal; the "goal" and "golden-goal" effect sprites) ───────── */
  // Their words are slab-serif letters with a deep 3D extrusion, on a white sticker with a lilac shadow. Ours are
  // hand-made letters (height 1, x 0 at the letter's middle) placed, sized and slanted as measured on their sprites,
  // in the sprites' own pixels (1119 x 349 and 1152 x 175, 2.222 units each). Parts: [kind, data, hole?]:
  // 'se' a superellipse [cx, cy, a, b, n], 'p' a polygon.
  const SLAB = {
    O: [['se', [0, 0.5, 0.42, 0.5, 2.6]], ['se', [0, 0.465, 0.205, 0.31, 2.4], 1]],
    G: [['se', [-0.012, 0.49, 0.445, 0.49, 2.6]], ['se', [-0.025, 0.46, 0.2, 0.31, 2.4], 1], ['p', [[-0.03, 0.22], [0.55, 0.22], [0.55, 0.42], [-0.03, 0.42]], 1],
        ['p', [[0.4, 0], [0.59, 0], [0.555, 0.11], [0.53, 0.22], [0.34, 0.22], [0.31, 0.17]]],
        ['p', [[0.033, 0.42], [0.48, 0.42], [0.48, 0.585], [0.033, 0.585]]],
        ['p', [[0.17, 0.585], [0.48, 0.585], [0.43, 0.8], [0.39, 0.9], [0.365, 1], [0.175, 1], [0.2, 0.89]]]],
    A: [['p', [[-0.17, 0], [0.17, 0], [0.22, 0.13], [0.43, 0.81], [-0.43, 0.81], [-0.22, 0.13]]],
        ['p', [[-0.016, 0.24], [0.08, 0.48], [-0.08, 0.48]], 1], ['p', [[-0.13, 0.65], [0.13, 0.65], [0.2, 0.81], [-0.2, 0.81]], 1],
        ['p', [[-0.6, 0.81], [-0.08, 0.81], [-0.13, 1.04], [-0.6, 1.04]]], ['p', [[0.09, 0.81], [0.62, 0.81], [0.62, 1.04], [0.15, 1.04]]]],
    L: [['p', [[-0.257, 0], [0.227, 0], [0.232, 0.155], [-0.23, 0.155]]], ['p', [[-0.122, 0.155], [0.122, 0.155], [0.14, 0.81], [-0.122, 0.81]]],
        ['p', [[-0.31, 0.81], [0.56, 0.81], [0.58, 1], [-0.31, 1]]], ['p', [[0.34, 0.675], [0.52, 0.675], [0.545, 0.81], [0.34, 0.81]]]],
    '!': [['p', [[-0.115, 0], [0.13, 0], [0.13, 0.675], [-0.115, 0.675]]], ['p', [[-0.15, 0.78], [0.125, 0.78], [0.125, 1], [-0.15, 1]]]],
    D: [['p', [[-0.42, 0], [0.08, 0], [0.3, 0.06], [0.42, 0.3], [0.42, 0.7], [0.3, 0.94], [0.08, 1], [-0.42, 1], [-0.42, 0.82], [-0.3, 0.82], [-0.3, 0.18], [-0.42, 0.18]]],
        ['p', [[-0.07, 0.2], [0.06, 0.2], [0.16, 0.32], [0.16, 0.68], [0.06, 0.8], [-0.07, 0.8]], 1]],
    E: [['p', [[-0.4, 0], [0.38, 0], [0.38, 0.32], [0.2, 0.32], [0.2, 0.18], [-0.06, 0.18], [-0.06, 0.41], [0.14, 0.41], [0.14, 0.59], [-0.06, 0.59],
        [-0.06, 0.82], [0.2, 0.82], [0.2, 0.68], [0.38, 0.68], [0.38, 1], [-0.4, 1], [-0.4, 0.82], [-0.3, 0.82], [-0.3, 0.18], [-0.4, 0.18]]]],
    N: [['p', [[-0.46, 0], [-0.12, 0], [0.16, 0.5], [0.16, 0.18], [0.06, 0.18], [0.06, 0], [0.46, 0], [0.46, 0.18], [0.36, 0.18], [0.36, 1], [0.14, 1],
        [-0.16, 0.48], [-0.16, 0.82], [-0.06, 0.82], [-0.06, 1], [-0.46, 1], [-0.46, 0.82], [-0.36, 0.82], [-0.36, 0.18], [-0.46, 0.18]]]],
  };
  // Each word: sprite size, letters [char, x of its middle at mid height, slant (x per y)], letter top and height,
  // the 3D extrusion (straight down by depth, pulled in toward vx), sticker spreads (white, lilac, shadow) and colours.
  const WORDS = {
    goal: { w: 1119, h: 349, top: 6, lh: 246, letters: [['G', 129, -0.27], ['O', 375, -0.27], ['A', 590, 0.04], ['L', 786, 0.6], ['!', 977, 0.9]],
      vx: 560, pull: 0.048, depth: 48, white: [14, 21], lilac: [20, 28], shadow: [22, 45],
      face: ['#f94200', '#e92700', '#dc2400'], hi: '#fb6943', ext: '#8b0000', extIn: '#bf2906' },
    golden: { w: 1152, h: 175, top: 13, lh: 122, sx: 1.08, letters: [['G', 82, -0.12], ['O', 182, -0.12], ['L', 264, -0.12], ['D', 385, -0.12], ['E', 468, -0.12], ['N', 576, -0.12],
      ['G', 771, -0.12], ['O', 867, -0.12], ['A', 957, -0.12], ['L', 1046, -0.12]],
      vx: 576, pull: 0.025, depth: 17, white: [8, 10], lilac: [10, 14], shadow: [12, 24],
      face: ['#ffc52c', '#ffac01', '#ff9900'], hi: '#ffc52c', ext: '#e36d00', extIn: '#e8891d' },
  };
  function sePath(g, cx, cy, a, b, n) {
    for (let i = 0; i <= 72; i++) {
      const t = i / 72 * TAU, c = Math.cos(t), s = Math.sin(t);
      const x = cx + a * Math.sign(c) * Math.pow(Math.abs(c), 2 / n), y = cy + b * Math.sign(s) * Math.pow(Math.abs(s), 2 / n);
      if (i) g.lineTo(x, y); else g.moveTo(x, y);
    }
    g.closePath();
  }
  function tinted(src, fill) {
    const c = canvas(src.width, src.height), g = c.getContext('2d');
    g.drawImage(src, 0, 0); g.globalCompositeOperation = 'source-in'; g.fillStyle = fill; g.fillRect(0, 0, c.width, c.height);
    return c;
  }
  // The union of src moved by every offset in [x0, x1] x [y0, y1] (sprite px), drawn onto out (or a new canvas).
  function spread(src, R, x0, x1, y0, y1, out) {
    const a = canvas(src.width, src.height), ga = a.getContext('2d'), b = out || canvas(src.width, src.height), gb = b.getContext('2d');
    for (let x = x0; x <= x1; x += 3) ga.drawImage(src, x * R, 0);
    for (let y = y0; y <= y1; y += 3) gb.drawImage(a, 0, y * R);
    return b;
  }
  function paintWord(W, R) {
    const mask = canvas(W.w * R, W.h * R), holes = canvas(W.w * R, W.h * R), mg = mask.getContext('2d'), hg = holes.getContext('2d');
    const mid = W.top + W.lh / 2;
    for (const [ch, xc, k] of W.letters) {
      const one = canvas(W.w * R, W.h * R), og = one.getContext('2d'), h = W.lh;
      for (const tg of [og, hg]) tg.setTransform(R * h * (W.sx || 1), 0, R * k * h, R * h, R * (xc + k * (W.top - mid)), R * W.top);
      for (const [kind, d, hole] of SLAB[ch]) {
        og.globalCompositeOperation = hole ? 'destination-out' : 'source-over';
        og.beginPath(); if (kind === 'se') sePath(og, ...d); else poly(og, d); og.fillStyle = '#fff'; og.fill();
        if (hole) { hg.beginPath(); if (kind === 'se') sePath(hg, ...d); else poly(hg, d); hg.fillStyle = '#fff'; hg.fill(); }
      }
      mg.drawImage(one, 0, 0);
    }
    // The extrusion: the letters pulled toward the vanishing point; dark outside, lighter seen through the counters.
    const ext = canvas(mask.width, mask.height), eg = ext.getContext('2d'), vx = W.vx;
    for (let i = 20; i >= 1; i--) {                 // straight down by depth, drawn in toward vx by up to pull
      const t = i / 20, f = W.pull * t;
      eg.setTransform(1 - f, 0, 0, 1, R * vx * f, R * W.depth * t); eg.drawImage(mask, 0, 0);
    }
    eg.setTransform(1, 0, 0, 1, 0, 0);
    const sil = canvas(mask.width, mask.height), sg = sil.getContext('2d'); sg.drawImage(ext, 0, 0); sg.drawImage(mask, 0, 0);
    const full = canvas(mask.width, mask.height), fg = full.getContext('2d'); fg.drawImage(sil, 0, 0); fg.drawImage(holes, 0, 0);
    const extIn = tinted(ext, W.extIn), ig = extIn.getContext('2d'); ig.globalCompositeOperation = 'destination-in'; ig.drawImage(holes, 0, 0);
    // The face: a top-to-bottom gradient, with a lighter band along every lower edge.
    const gr = mg.createLinearGradient(0, R * W.top, 0, R * (W.top + W.lh));
    gr.addColorStop(0, W.face[0]); gr.addColorStop(0.5, W.face[1]); gr.addColorStop(1, W.face[2]);
    const face = tinted(mask, W.hi), body = tinted(mask, gr), bg = face.getContext('2d');
    bg.globalCompositeOperation = 'source-atop'; bg.drawImage(body, 0, -5 * R * W.lh / 246);
    const out = canvas(mask.width, mask.height), g = out.getContext('2d');
    // The sticker: white close under and right of the letters, lilac further (filling the counters), a lilac-grey
    // shadow at the bottom; both lighter bands also reach a little left along the bottom.
    const [wx, wy] = W.white, [lx, ly] = W.lilac, [hx, hy] = W.shadow, wl = Math.round(wy * 0.43), ll = Math.round(ly * 0.5);
    g.drawImage(tinted(spread(full, R, 0, hx, 0, hy), '#9a91b4'), 0, 0);
    g.drawImage(tinted(spread(full, R, -ll, 0, ly - ll, ly, spread(full, R, 0, lx, 0, ly)), '#c0b7d7'), 0, 0);
    g.drawImage(tinted(spread(sil, R, -wl, 0, wy - wl, wy, spread(sil, R, 0, wx, 0, wy)), '#f5f5ff'), 0, 0);
    g.drawImage(tinted(ext, W.ext), 0, 0); g.drawImage(extIn, 0, 0); g.drawImage(face, 0, 0);
    out.ww = W.w * 2.2222; out.wh = W.h * 2.2222;
    return out;
  }
  // S: flashGoal: the "behind" copy starts at H - 400 at .1 scale (alpha .7) and rises to -600 growing to .7 over 0.7 s;
  // then the front one drops from -600 to 400 growing .7 -> .9 over 0.5 s, shakes +-1 degree every 50 ms, and flies
  // back up to -600 fading out over 1 s.
  function goalWord(g, golden, x, y, sc, alpha) {
    const c = golden ? L.golden : L.goal;
    g.save(); g.globalAlpha = alpha; g.translate(x, y); g.scale(sc, sc);
    g.drawImage(c, -c.ww / 2, -c.wh / 2, c.ww, c.wh);
    g.restore();
  }
  function goalFlash(g, age, golden) {
    if (age < 700) {
      const u = age / 700, e = 1 - (1 - u) * (1 - u);
      goalWord(g, golden, 0, (HS.VIEW_H - 400) + (-600 - (HS.VIEW_H - 400)) * e, 0.1 + 0.6 * e, 0.7);
    }
    if (age >= 700) {
      const a = age - 700;
      let y, sc = 0.9, al = 1, rot = 0;
      if (a < 500) { const u = a / 500, e = 1 - (1 - u) * (1 - u); y = -600 + 1000 * e; sc = 0.7 + 0.2 * e; }
      else if (a < 1300) { y = 400; rot = (Math.floor((a - 500) / 50) % 2 ? -1 : 1) * Math.PI / 180; }
      else if (a < 2300) { const u = (a - 1300) / 1000, e = 1 - (1 - u) * (1 - u); y = 400 - 1000 * e; al = 1 - e; }
      else return;
      g.save(); g.rotate(rot); goalWord(g, golden, 0, y, sc, al); g.restore();
    }
  }
  // The SUDDEN DEATH call when the clock runs out level, in the reference's FlashText way (it used it for "Half time"):
  // fades in growing .2 -> 1.1 over 0.5 s, holds, then fades out shrinking back to .2 over 0.5 s after 1.5 s.
  function flashText(g, text, age) {
    let sc, al;
    if (age < 500) { const u = age / 500, e = 1 - (1 - u) * (1 - u); sc = 0.2 + 0.9 * e; al = e; }
    else if (age < 1500) { sc = 1.1; al = 1; }
    else if (age < 2000) { const u = (age - 1500) / 500, e = 1 - (1 - u) * (1 - u); sc = 1.1 - 0.9 * e; al = 1 - e; }
    else return;
    g.save(); g.globalAlpha = al; g.translate(0, HS.VIEW_H / 2); g.scale(sc, sc); refText(g, text, 0, 0, 150); g.restore();
  }
  // OURS: through the minute of sudden death, a banner under the board says so (the board counts that minute down).
  // On a pill in the score plate's slate and rim (#8b9abb, #465778, doc: Score plate) so it reads over the clouds.
  function suddenBanner(g) {
    rr(g, -300, 384, 600, 112, 56); g.fillStyle = '#8b9abb'; g.fill();
    rr(g, -291, 393, 582, 94, 47); g.fillStyle = '#465778'; g.fill();
    refText(g, 'SUDDEN DEATH', 0, 440, 84);
  }
  function youMark(g, x, y, now) {
    const b = Math.sin(now / 160) * 10;
    g.fillStyle = '#ffe27a'; g.strokeStyle = C.outline; g.lineWidth = 8;
    poly(g, [[x - 34, y - 190 + b], [x + 34, y - 190 + b], [x, y - 140 + b]]); g.fill(); g.stroke();
    words(g, 'YOU', x, y - 235 + b, 56, { fill: '#ffe27a' });
  }

  /* ── phone buttons (CSS px; S: MobileControls) ─────────────────────────── */
  // Their buttons are 101 px sprites: mobi-right (a D, mirrored for left), mobi-jump and mob-shoot (discs), green in
  // four rings with a white icon; pressed shows mobi-move-down / mobi-round-down, a white ring 8 px wide around it.
  function dShape(ctx, d) {                       // their D: flat left with 16 px corners, a half disc on the right, inset d
    const r = 50.5 - d, rc = Math.max(2, 16 - d), x0 = d, y0 = d, y1 = 101 - d;
    ctx.beginPath(); ctx.moveTo(x0 + rc, y0); ctx.lineTo(50.5, y0); ctx.arc(50.5, 50.5, r, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(x0 + rc, y1); ctx.arcTo(x0, y1, x0, y1 - rc, rc); ctx.lineTo(x0, y0 + rc); ctx.arcTo(x0, y0, x0 + rc, y0, rc); ctx.closePath();
  }
  function button(ctx, kind, b, pressed, dpr, alpha) {
    const s = Math.min(b.w, b.h) / 101, side = kind === 'L' || kind === 'R';
    ctx.save(); ctx.globalAlpha = alpha == null ? 1 : alpha;
    ctx.translate(b.cx, b.cy); ctx.scale(s, s); ctx.translate(-50.5, -50.5);
    if (kind === 'L') { ctx.translate(101, 0); ctx.scale(-1, 1); }
    const shape = (d) => { if (side) dShape(ctx, d); else { ctx.beginPath(); ctx.arc(50.5, 50.5, 50.5 - d, 0, TAU); } };
    for (const [d, col] of [[0, '#214a0d'], [3, '#275412'], [4, '#2f6c14'], [8.5, '#7acc53'], [11.5, '#60a241']]) { shape(d); ctx.fillStyle = col; ctx.fill(); }
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#fff';
    if (side) { roundPoly(ctx, [[33, 29], [69.5, 50.5], [33, 72]], 4); ctx.fill(); }
    else if (kind === 'J') { roundPoly(ctx, [[50.5, 26], [71, 65.5], [30, 65.5]], 4); ctx.fill(); }
    else {                                        // their shoot icon: a white ball with green pentagons and seams
      const cx = 51, cy = 50, pent = (x, y, r, rot) => { const p = []; for (let i = 0; i < 5; i++) { const t = rot + i * TAU / 5; p.push([x + r * Math.cos(t), y + r * Math.sin(t)]); } return p; };
      disc(ctx, cx, cy, 22.3, '#fff');
      ctx.save(); disc(ctx, cx, cy, 19.3); ctx.clip(); ctx.fillStyle = '#60a241'; ctx.strokeStyle = '#60a241'; ctx.lineWidth = 1.7;
      poly(ctx, pent(cx, cy, 7.5, -Math.PI / 2), '#60a241');
      for (let i = 0; i < 5; i++) {
        const t = -Math.PI / 2 + i * TAU / 5, c = Math.cos(t), sn = Math.sin(t);
        ctx.beginPath(); ctx.moveTo(cx + 7.5 * c, cy + 7.5 * sn); ctx.lineTo(cx + 14 * c, cy + 14 * sn); ctx.stroke();
        poly(ctx, pent(cx + 19.5 * c, cy + 19.5 * sn, 6.8, t + Math.PI), '#60a241');
      }
      ctx.restore();
    }
    if (pressed) { shape(0); ctx.lineWidth = 8; ctx.strokeStyle = '#fff'; ctx.stroke(); }
    ctx.restore();
  }
  function note(ctx, text, x, y, size) {
    ctx.save(); ctx.font = '700 ' + size + 'px ' + FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.fillText(text, x, y); ctx.restore();
  }

  /* ── the frame ──────────────────────────────────────────────────────────── */
  function build(k, vw) {
    K = k; VW = vw || HS.VIEW_W_REF;
    S.setView(VW); F.setView(VW);
    L.sky = layer(S.sky);
    const T = S.CLOUD.tile, cl = canvas(T * K, 1000 * K), cg = cl.getContext('2d');
    cg.setTransform(K, 0, 0, K, 0, 0); S.clouds(cg); L.clouds = cl;
    L.tribune = layer(S.tribune);
    L.crowd = Array.from({ length: S.CROWD_FRAMES }, (_, f) => band(CROWD_BAND, (g) => S.crowd(g, f)));
    L.board = layerSmall(BOARD.x1 - BOARD.x0 + 20, BD.postY[3] + 10, -BOARD.x0 + 10, 0, paintBoard);
    L.digits = {}; for (const ch of "0123456789") L.digits[ch] = paintDigit(ch);
    L.field = layer((g) => { F.field(g); F.goalsBack(g); });
    L.front = layer(F.goalsFront);
    L.ballBack = paintBall(P.ballBack, false); L.ballFront = paintBall(P.ballFront, false);
    L.goldBack = paintBall(P.ballBack, true); L.goldFront = paintBall(P.ballFront, true);
    L.plate = paintPlate(); L.uiBall = paintUiBall(); L.pause = paintPause(); L.keys = paintKeys(); L.arrows = paintArrows();
    L.goal = paintWord(WORDS.goal, 2.2222 * 0.9 * K); L.golden = paintWord(WORDS.golden, 2.2222 * 0.9 * K);   // at their largest (S: .9)
    art.bg = true;
  }
  function blitLayer(ctx, c) { ctx.drawImage(c, -VW / 2, 0, VW, HS.VIEW_H); }
  let crowdStep = 0, crowdAt = 0;
  // fast: the crowd's quick tempo after a goal (S: setTempo(100) for 4 s, else 1000 ms a frame). Its frames play
  // there and back (S.CROWD_ORDER), over the stands painted once.
  function field(ctx, now, fast) {
    blitLayer(ctx, L.sky);
    const T = S.CLOUD.tile, off = ((now / 1000 * S.CLOUD.speed) % T + T) % T;
    for (let x = -VW / 2 - T + off; x < VW / 2; x += T) ctx.drawImage(L.clouds, x, 0, T, 1000);
    if (now - crowdAt > (fast ? 100 : 1000)) { crowdAt = now; crowdStep = (crowdStep + 1) % S.CROWD_ORDER.length; }
    blitLayer(ctx, L.tribune);
    ctx.drawImage(L.crowd[S.CROWD_ORDER[crowdStep]], -VW / 2, CROWD_BAND[0], VW, CROWD_BAND[1] - CROWD_BAND[0]);
    blit(ctx, L.board, 0, 0);
    blitLayer(ctx, L.field);
  }
  function goalFronts(ctx) { blitLayer(ctx, L.front); }
  function ballAt(ctx, x, y, rot, golden) {
    const R = BALL_R + 4;
    ctx.save(); ctx.translate(x, y);
    ctx.drawImage(golden ? L.goldBack : L.ballBack, -R, -R, 2 * R, 2 * R);
    ctx.rotate(rot); ctx.drawImage(golden ? L.goldFront : L.ballFront, -R, -R, 2 * R, 2 * R);
    ctx.restore();
  }
  function setKits(cols) { P.setKits(cols); }
  function setHeads(ids) { P.setHeads(ids); }

  const art = { bg: false, build, field, goalFronts, ballAt, player: P.player, hudDraw, countText, goalFlash, flashText, youMark,
                button, note, setKits, setHeads, pauseAt: PAUSE_AT, viewW: () => VW };
  root.HSArt = { create: () => art };
})(window);
