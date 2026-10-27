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
   the ball, the plate, the pause button, the key hint), so a frame is a handful
   of drawImage calls plus the players, the clock digits and the words. */
(function (root) {
  const Sim = root.HSSim, HS = Sim.HS, S = root.HSScene, F = root.HSPitch, P = root.HSChars;
  const FONT = 'Archivo, "Arial Black", "Segoe UI", Arial, sans-serif';
  const TAU = Math.PI * 2;

  /* The measured layout (doc "The look"), world units. */
  const BOARD = { x0: -324, x1: 324, y0: 63, y1: 368, posts: [[-245, -203], [203, 245]], digitRight: [-163, -40, 130, 253], digitY: 230 };
  const ROOF = { y0: 548, k: 4.5e-5 };                            // the board's posts stand on the roof's arch
  const PLATE = { y: 1795, half: 439, boxHalf: 248, barY0: 1736, barY1: 1854, ballX: 385, ballY: 1793, ballR: 30, histX: 340, scoreY: 1785 };
  const C = {
    roofA: '#acb8d3', roofB: '#8b9abb', strut: '#677a9e', stand: '#acb8d3', standDark: '#8b9abb', stair: '#7b8aac', stairLit: '#96a6c5',
    slate: '#677a9e', slateDark: '#48597a', slateDeep: '#3f4f6c', slateLit: '#8b9abb', slateSoft: '#8fa0a6',
    pitch: '#93c47a', pitchLit: '#a3ce8e', pitchMid: '#96c280', face: '#80b366', side: '#76a75d', lawn: '#8bbc72',
    chalk: '#fcfff7', post: '#fcfff7', postShade: '#dee4db', net: 'rgba(250,253,245,0.78)', glass: '#dbf3fd', glass2: '#b6def4',
    plate: '#465778', plateIn: '#3f4f6c', plateRim: '#677a9e', plateEdge: '#8b9abb', plateCap: '#7b98c0',
    key: '#0155dd', keyDark: '#0548ab', keyLit: '#0e64e9', pause: '#60a241', pauseLit: '#7acc53', pauseDark: '#2f6c14', cream: '#ffeddf',
    ink: '#342d2f', outline: '#24314f',
  };

  let K = 1, VW = HS.VIEW_W_REF;                 // device px per world unit, visible world width
  const L = {};                                  // the offscreen layers

  function canvas(w, h) { const c = document.createElement('canvas'); c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h)); return c; }
  function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  function rr(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  function poly(g, pts, fill) { g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]); g.closePath(); if (fill) { g.fillStyle = fill; g.fill(); } }
  // A layer covering the visible world (x -VW/2..VW/2, y 0..1920) at K, drawn in world units.
  function layer(draw, h) {
    const c = canvas(VW * K, (h || HS.VIEW_H) * K), g = c.getContext('2d');
    g.setTransform(K, 0, 0, K, VW / 2 * K, 0);
    draw(g);
    return c;
  }
  function roofY(x) { return ROOF.y0 + ROOF.k * x * x; }

  /* ── the digital board on its two posts (its digits are drawn live) ───── */
  function paintBoard(g) {
    // The digital board on its two posts (its digits are drawn live).
    for (const [a, b] of BOARD.posts) {
      g.fillStyle = C.slate; g.fillRect(a, BOARD.y1 - 10, b - a, roofY(a) - BOARD.y1 + 20);
      g.fillStyle = C.slateDark; g.fillRect(b - 12, BOARD.y1 - 10, 12, roofY(a) - BOARD.y1 + 20);
    }
    rr(g, BOARD.x0, BOARD.y0, BOARD.x1 - BOARD.x0, BOARD.y1 - BOARD.y0, 26); g.fillStyle = C.slateLit; g.fill();
    rr(g, BOARD.x0 + 9, BOARD.y0 + 9, BOARD.x1 - BOARD.x0 - 18, BOARD.y1 - BOARD.y0 - 18, 20); g.fillStyle = C.slate; g.fill();
    rr(g, BOARD.x0 + 26, BOARD.y0 + 30, BOARD.x1 - BOARD.x0 - 52, BOARD.y1 - BOARD.y0 - 70, 14); g.fillStyle = C.slateDeep; g.fill();
    rr(g, BOARD.x0 + 34, BOARD.y0 + 38, BOARD.x1 - BOARD.x0 - 68, BOARD.y1 - BOARD.y0 - 86, 10); g.fillStyle = C.slateDark; g.fill();
    g.fillStyle = C.slateDeep; g.fillRect(BOARD.x0 + 40, BOARD.y1 - 31, BOARD.x1 - BOARD.x0 - 80, 14);
    g.fillStyle = C.chalk;                                      // the colon (measured at y 185..208 and 230..252)
    rr(g, -12, 185, 22, 23, 4); g.fill(); rr(g, -12, 230, 22, 23, 4); g.fill();
  }

  /* ── the ball, cached ───────────────────────────────────────────────────── */
  const BALL_R = P.BALL_R;
  function paintBall(golden) {
    const R = BALL_R, c = canvas(2 * (R + 4) * K, 2 * (R + 4) * K), g = c.getContext('2d');
    g.setTransform(K, 0, 0, K, (R + 4) * K, (R + 4) * K);
    P.ball(g, golden);
    return c;
  }

  /* ── the HUD ────────────────────────────────────────────────────────────── */
  // Seven-segment digits for the board.
  const SEG = { 0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg', 5: 'acdfg', 6: 'acdefg', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg' };
  function digit(g, ch, right, cy) {
    const w = 96, h = 150, t = 18, x = right - w, y = cy - h / 2, on = SEG[ch] || '';
    const seg = { a: [x + t, y, w - 2 * t, t], d: [x + t, y + h - t, w - 2 * t, t], g: [x + t, y + h / 2 - t / 2, w - 2 * t, t],
                  f: [x, y + t, t, h / 2 - t * 1.5], b: [x + w - t, y + t, t, h / 2 - t * 1.5], e: [x, y + h / 2 + t / 2, t, h / 2 - t * 1.5], c: [x + w - t, y + h / 2 + t / 2, t, h / 2 - t * 1.5] };
    for (const k of 'abcdefg') {
      g.fillStyle = on.indexOf(k) >= 0 ? '#eef6ff' : 'rgba(238,246,255,0.07)';
      const r = seg[k]; rr(g, r[0], r[1], r[2], r[3], t / 2); g.fill();
    }
  }
  function paintPlate() {
    return layerSmall(2 * PLATE.half + 20, 200, PLATE.half + 10, 100, (g) => {
      const y0 = PLATE.barY0 - PLATE.y, y1 = PLATE.barY1 - PLATE.y;
      rr(g, -PLATE.half, y0, 2 * PLATE.half, y1 - y0, (y1 - y0) / 2); g.fillStyle = C.plateEdge; g.fill();
      rr(g, -PLATE.half + 9, y0 + 9, 2 * PLATE.half - 18, y1 - y0 - 18, (y1 - y0) / 2 - 9); g.fillStyle = C.plate; g.fill();
      for (const s of [-1, 1]) { g.fillStyle = C.plateIn; g.beginPath(); g.arc(s * PLATE.ballX, PLATE.ballY - PLATE.y, 40, 0, TAU); g.fill(); }
      rr(g, -PLATE.boxHalf, -88, 2 * PLATE.boxHalf, 176, 24); g.fillStyle = C.plateRim; g.fill();
      rr(g, -PLATE.boxHalf + 13, -79, 2 * PLATE.boxHalf - 26, 158, 18); g.fillStyle = '#5e7194'; g.fill();
      rr(g, -PLATE.boxHalf + 26, -70, 2 * PLATE.boxHalf - 52, 140, 14); g.fillStyle = C.plateIn; g.fill();
    });
  }
  function layerSmall(w, h, ox, oy, draw) {
    const c = canvas(w * K, h * K), g = c.getContext('2d');
    g.setTransform(K, 0, 0, K, ox * K, oy * K); draw(g);
    c.ox = ox; c.oy = oy; c.ww = w; c.wh = h;
    return c;
  }
  function blit(ctx, c, x, y) { ctx.drawImage(c, x - c.ox, y - c.oy, c.ww, c.wh); }
  function paintPause() {
    return layerSmall(220, 220, 110, 110, (g) => {
      g.fillStyle = C.pauseDark; g.beginPath(); g.arc(0, 4, 100, 0, TAU); g.fill();
      g.fillStyle = C.cream; g.beginPath(); g.arc(0, 0, 98, 0, TAU); g.fill();
      g.fillStyle = C.pauseDark; g.beginPath(); g.arc(0, 0, 84, 0, TAU); g.fill();
      g.fillStyle = C.pause; g.beginPath(); g.arc(0, -2, 80, 0, TAU); g.fill();
      g.fillStyle = C.pauseLit; g.beginPath(); g.ellipse(0, -46, 56, 26, 0, 0, TAU); g.fill();
      g.fillStyle = '#fff'; rr(g, -39, -50, 29, 100, 8); g.fill(); rr(g, 10, -50, 29, 100, 8); g.fill();
    });
  }
  // The key hint (S: ControlsIndicator at H - 130, x W/2 - 1100, .9 scale, .8 alpha): up, left, right, SPACE.
  function paintKeys() {
    return layerSmall(380, 280, 190, 140, (g) => {
      g.scale(0.9, 0.9);
      const key = (pts) => {
        poly(g, pts.map(([x, y]) => [x, y + 8]), C.keyDark);
        poly(g, pts, C.key);
      };
      key([[0, -144], [62, -18], [-62, -18]]);                       // up
      key([[-198, 65], [-76, 0], [-76, 130]]);                       // left
      key([[198, 65], [76, 0], [76, 130]]);                          // right
      rr(g, -68, 34, 136, 70, 14); g.fillStyle = C.keyDark; g.fill();
      rr(g, -68, 26, 136, 70, 14); g.fillStyle = C.key; g.fill();
      g.fillStyle = '#fff'; g.font = '900 30px ' + FONT; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('SPACE', 0, 62);
    });
  }

  function words(g, text, x, y, size, opts) {
    const o = opts || {};
    g.save();
    g.font = (o.italic ? 'italic ' : '') + '900 ' + size + 'px ' + FONT;
    g.textAlign = o.align || 'center'; g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.lineWidth = size * (o.stroke || 0.16); g.strokeStyle = o.edge || C.outline;
    if (o.shadow) { g.fillStyle = o.shadow; g.fillText(text, x, y + size * 0.08); g.strokeText(text, x, y + size * 0.08); }
    g.strokeText(text, x, y);
    g.fillStyle = o.fill || '#fff'; g.fillText(text, x, y);
    g.restore();
  }
  function hudDraw(g, hud, now) {
    // The board's clock, MM:SS of game time.
    const d = hud.digits || '0000';
    for (let i = 0; i < 4; i++) digit(g, d[i], BOARD.digitRight[i], BOARD.digitY);
    // The score plate at the bottom (shown from the first whistle, S: _showScore).
    if (hud.plate) {
      blit(g, L.plate, 0, PLATE.y);
      for (const s of [-1, 1]) {
        g.save(); g.translate(s * PLATE.ballX, PLATE.ballY); g.scale(0.6, 0.6); g.drawImage(L.ball, -(BALL_R + 4), -(BALL_R + 4), 2 * (BALL_R + 4), 2 * (BALL_R + 4)); g.restore();
      }
      words(g, String(hud.hist[0] | 0), -PLATE.histX, PLATE.scoreY, 60, { align: 'left' });
      words(g, String(hud.hist[1] | 0), PLATE.histX, PLATE.scoreY, 60, { align: 'right' });
      if (!hud.scoreBig) words(g, hud.score[0] + '  -  ' + hud.score[1], 0, PLATE.scoreY, 120);
      // Names (ours: an online duel says who is who), small over the plate's ends.
      const mine = hud.mine;
      for (let s = 0; s < 2; s++) {
        const nm = hud.names[s] || '';
        if (!nm) continue;
        words(g, nm, (s === 0 ? -1 : 1) * (PLATE.half - 10), PLATE.barY0 - 40, 44, { align: s === 0 ? 'left' : 'right', fill: s === mine ? '#ffe27a' : '#fff', stroke: 0.2 });
      }
    }
    if (hud.scoreBig) {
      // S: endScreen: the score rises to the middle at twice its size and stays 3 s.
      const u = Math.min(1, hud.scoreBig / 500), e = 1 - (1 - u) * (1 - u);
      words(g, hud.score[0] + '  -  ' + hud.score[1], 0, PLATE.scoreY + (HS.VIEW_H / 2 - PLATE.scoreY) * e, 120 * (1 + e));
    }
    // The pause button, top right of the visible frame (S: W - 100, 100).
    blit(g, L.pause, VW / 2 - 100, 100);
    if (hud.keys) { g.globalAlpha = 0.8; blit(g, L.keys, -1100, HS.VIEW_H - 130); g.globalAlpha = 1; }
  }
  const PAUSE_AT = () => ({ x: VW / 2 - 100, y: 100, r: 100 });

  // S: doCountDown's numbers, size 170 at the middle of the frame.
  function countText(g, n, age) {
    const u = Math.min(1, age / 120);
    words(g, String(n), 0, HS.VIEW_H / 2, 170 * (0.8 + 0.2 * u), { shadow: 'rgba(20,30,60,0.35)' });
  }
  // GOAL! (S: flashGoal: a copy grows up from the pitch while the big one drops in, shakes, and flies off).
  function goalWord(g, text, x, y, sc, alpha, golden) {
    g.save(); g.translate(x, y); g.scale(sc, sc); g.globalAlpha = alpha;
    const size = golden ? 300 : 560;
    g.font = 'italic 900 ' + size + 'px ' + FONT; g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
    g.fillStyle = golden ? '#8a5a12' : '#9e1f12'; g.fillText(text, 14, 34);
    g.lineWidth = size * 0.11; g.strokeStyle = '#fff'; g.strokeText(text, 0, 0);
    const gr = g.createLinearGradient(0, -size / 2, 0, size / 2);
    if (golden) { gr.addColorStop(0, '#ffe680'); gr.addColorStop(1, '#e0a020'); } else { gr.addColorStop(0, '#ff6a3d'); gr.addColorStop(1, '#e0281c'); }
    g.fillStyle = gr; g.fillText(text, 0, 0);
    g.restore();
  }
  function goalFlash(g, age, golden) {
    const text = golden ? 'GOLDEN GOAL' : 'GOAL!';
    if (age < 700) {
      const u = age / 700, e = 1 - (1 - u) * (1 - u);
      goalWord(g, text, 0, (HS.VIEW_H - 400) + (-600 - (HS.VIEW_H - 400)) * e, 0.1 + 0.6 * e, 0.7, golden);
    }
    if (age >= 700) {
      const a = age - 700;
      let y, sc = 0.9, al = 1, rot = 0;
      if (a < 500) { const u = a / 500, e = 1 - (1 - u) * (1 - u); y = -600 + 1000 * e; sc = 0.7 + 0.2 * e; }
      else if (a < 1300) { y = 400; rot = (Math.floor((a - 500) / 50) % 2 ? -1 : 1) * Math.PI / 180; }
      else if (a < 2300) { const u = (a - 1300) / 1000, e = 1 - (1 - u) * (1 - u); y = 400 - 1000 * e; al = 1 - e; }
      else return;
      g.save(); g.rotate(rot); goalWord(g, text, 0, y, sc, al, golden); g.restore();
    }
  }
  // S: FlashText (HALF TIME): fades in growing .2 -> 1.1 over 0.5 s, holds, fades out over 0.5 s after 1.5 s.
  function flashText(g, text, age) {
    let sc, al;
    if (age < 500) { const u = age / 500, e = 1 - (1 - u) * (1 - u); sc = 0.2 + 0.9 * e; al = e; }
    else if (age < 1500) { sc = 1.1; al = 1; }
    else if (age < 2000) { const u = (age - 1500) / 500, e = 1 - (1 - u) * (1 - u); sc = 1.1 - 0.9 * e; al = 1 - e; }
    else return;
    g.save(); g.globalAlpha = al; g.translate(0, HS.VIEW_H / 2); g.scale(sc, sc); words(g, text, 0, 0, 150); g.restore();
  }
  function youMark(g, x, y, now) {
    const b = Math.sin(now / 160) * 10;
    g.fillStyle = '#ffe27a'; g.strokeStyle = C.outline; g.lineWidth = 8;
    poly(g, [[x - 34, y - 190 + b], [x + 34, y - 190 + b], [x, y - 140 + b]]); g.fill(); g.stroke();
    words(g, 'YOU', x, y - 235 + b, 56, { fill: '#ffe27a' });
  }

  /* ── phone buttons (CSS px) ─────────────────────────────────────────────── */
  function button(ctx, kind, b, pressed, dpr, alpha) {
    const r = Math.min(b.w, b.h) / 2;
    ctx.save(); ctx.globalAlpha = alpha == null ? 1 : alpha;
    ctx.fillStyle = pressed ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.28)';
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = Math.max(2, r * 0.06);
    ctx.beginPath(); ctx.arc(b.cx, b.cy, r * 0.92, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.strokeStyle = 'rgba(20,40,80,0.55)'; ctx.lineWidth = Math.max(2, r * 0.05);
    const s = r * 0.42;
    if (kind === 'L' || kind === 'R') {
      const d = kind === 'L' ? -1 : 1;
      ctx.beginPath(); ctx.moveTo(b.cx + d * s, b.cy); ctx.lineTo(b.cx - d * s * 0.6, b.cy - s * 0.9); ctx.lineTo(b.cx - d * s * 0.6, b.cy + s * 0.9); ctx.closePath(); ctx.fill(); ctx.stroke();
    } else if (kind === 'J') {
      ctx.beginPath(); ctx.moveTo(b.cx, b.cy - s); ctx.lineTo(b.cx + s * 0.9, b.cy + s * 0.6); ctx.lineTo(b.cx - s * 0.9, b.cy + s * 0.6); ctx.closePath(); ctx.fill(); ctx.stroke();
    } else {
      ctx.font = '900 ' + Math.round(r * 0.34) + 'px ' + FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineWidth = Math.max(2, r * 0.08); ctx.strokeText('KICK', b.cx, b.cy); ctx.fillText('KICK', b.cx, b.cy);
    }
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
    L.stands = Array.from({ length: S.CROWD_FRAMES }, (_, f) => layer((g) => { S.tribune(g); S.crowd(g, f); }));
    L.board = layerSmall(BOARD.x1 - BOARD.x0 + 20, roofY(BOARD.posts[0][0]) + 40, -BOARD.x0 + 10, 0, paintBoard);
    L.field = layer((g) => { F.field(g); F.goalsBack(g); });
    L.front = layer(F.goalsFront);
    L.ball = paintBall(false); L.gold = paintBall(true);
    L.plate = paintPlate(); L.pause = paintPause(); L.keys = paintKeys();
    art.bg = true;
  }
  function blitLayer(ctx, c) { ctx.drawImage(c, -VW / 2, 0, VW, HS.VIEW_H); }
  let crowdFrame = 0, crowdAt = 0;
  // fast: the crowd's quick tempo after a goal (S: setTempo(100) for 4 s, else 1000 ms a frame).
  function field(ctx, now, fast) {
    blitLayer(ctx, L.sky);
    const T = S.CLOUD.tile, off = ((now / 1000 * S.CLOUD.speed) % T + T) % T;
    for (let x = -VW / 2 - T + off; x < VW / 2; x += T) ctx.drawImage(L.clouds, x, 0, T, 1000);
    if (now - crowdAt > (fast ? 100 : 1000)) { crowdAt = now; crowdFrame = (crowdFrame + 1) % L.stands.length; }
    blitLayer(ctx, L.stands[crowdFrame]);
    blit(ctx, L.board, 0, 0);
    blitLayer(ctx, L.field);
  }
  function goalFronts(ctx) { blitLayer(ctx, L.front); }
  function ballAt(ctx, x, y, rot, golden) {
    const c = golden ? L.gold : L.ball, R = BALL_R + 4;
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.drawImage(c, -R, -R, 2 * R, 2 * R); ctx.restore();
  }
  function setKits(cols) { P.setKits(cols); }

  const art = { bg: false, build, field, goalFronts, ballAt, player: P.player, hudDraw, countText, goalFlash, flashText, youMark,
                button, note, setKits, pauseAt: PAUSE_AT, viewW: () => VW };
  root.HSArt = { create: () => art };
})(window);
