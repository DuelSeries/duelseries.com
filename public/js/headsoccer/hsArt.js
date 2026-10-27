'use strict';
/* ─── Head Soccer, the picture ────────────────────────────────────────────────
   Everything on the pitch, drawn in code: the night stadium, the goals, the two
   big heads, the ball, the strip across the top, the KICK OFF and GOAL! words,
   the power shot's lightning and the gold phone buttons. No image files and
   nothing copied: the look is described in docs/head-soccer-reference.md
   (sections 4, 6 and 7) and painted from that description.

   WORLD UNITS ARE THE REFERENCE'S PIXELS. The physics (shared/hsSim.js) and the
   measurements live in the same 1196 x 720 frame, so a number here is either a
   measured one from that doc or a physics constant from HSSim.HS. Where the doc
   says UNKNOWN the number is marked CHOSEN, so it is never mistaken for a
   measurement. headsoccer.js owns the one transform from this frame to the
   screen; every draw call below is in world units, except the phone buttons,
   which live in CSS pixels because in portrait they sit outside the pitch.

   CHEAP PER FRAME. Anything that does not move is painted once per resize into
   an offscreen canvas at the screen's real resolution (the stadium, the goal
   frames, the heads, the ball, the strip's fixed parts, the buttons), so a frame
   is a handful of drawImage calls plus the few shapes that change. Gradients and
   paths are built once and reused. */
(function (root) {
  const Sim = root.HSSim, HS = Sim.HS;
  const W = HS.W, H = HS.H;
  const FONT = 'Archivo, "Arial Black", "Segoe UI", Arial, sans-serif';

  /* The stadium's layers, top to bottom (doc sec 4 "Stadium layers" and sec 7). The doc gives the HUD strip over
     the sky to about y 120, the crowd at about 130 to 330, the ad board at 500 to 545 and the grass from 545; the
     cuts in between (the wall, the banner strip, the lower tier, the barrier) are CHOSEN to fit those. */
  const Y = { skyEnd: 114, wallEnd: 132, tier1End: 330, bannerEnd: 350, tier2End: 478, barrierEnd: 500, adEnd: 545 };

  // HUD boxes, doc sec 6, measured in this frame.
  const HUD = {
    axis: 602,                                           // M: the strip is mirror symmetric about x = 602
    gauge: [{ inner: 400, outer: 90 }, { inner: 798, outer: 1105 }], // M: x about 90..400 and 798..1105
    gaugeY0: 28, gaugeY1: 78,                            // M
    badge: [{ x: 413 }, { x: 692 }], badgeY: 20, badgeW: 100, badgeH: 63,   // M: 100 x 63 at y 20..83
    scoreX: [467, 745], scoreY0: 84, scoreY1: 120,      // M: centres, about 40 px tall
    clockY0: 10, clockY1: 80,                            // M: x about 535..690 (drawn centred on the axis)
  };

  // The two kits. Seat 0 is the South Korea-like default (doc sec 3: the only character not needing unlock), seat 1
  // a different look. Colours CHOSEN (the doc describes kits only as "differ").
  const LOOKS = [
    { skin: '#f3c592', skinLine: '#a86a3c', hair: '#1c181b', hairHi: '#433a40', brow: '#1c181b',
      kit: '#d8262f', kitDark: '#981820', trim: '#ffffff', shorts: '#ffffff' },
    { skin: '#f8d8b8', skinLine: '#b07a4e', hair: '#f2cc4a', hairHi: '#fff1a6', brow: '#a8761c',
      kit: '#2b60d2', kitDark: '#173b8c', trim: '#ffffff', shorts: '#14275e' },
  ];

  function canvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h));
    return c;
  }
  function rng(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function rr(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
    g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
    g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
    g.closePath();
  }

  /* ── the stadium ────────────────────────────────────────────────────────── */

  /* The crowd is pixel art (doc sec 7: "tiny pixel-art spectators"), so it is painted at one canvas pixel per world
     unit and stretched with smoothing off: the blocks stay blocks at any screen size. Two layers: everybody, and a
     few arms going up, shown on alternate beats for the shimmer. */
  const SHIRTS = ['#d63a32', '#f2c22e', '#3fa34a', '#2f6fd6', '#f2f2f2', '#d63a32', '#f2c22e', '#2f6fd6'];
  const SKINS = ['#f1c38f', '#d9a06b', '#a86c42', '#f6d4b2'];
  const HAIRS = ['#1d1a1a', '#4a2f1c', '#2b2b2b', '#c9a13a', '#5b3a22'];
  function paintCrowd() {
    const top = Y.wallEnd, h = Y.tier2End - Y.wallEnd;
    const base = canvas(W, h), alt = canvas(W, h);
    const g = base.getContext('2d'), a = alt.getContext('2d');
    const r = rng(20120203);
    const tier = (y0, y1, rows) => {
      const rowH = (y1 - y0) / rows;
      g.fillStyle = '#252a39'; g.fillRect(0, y0 - top, W, y1 - y0);
      for (let k = 0; k < rows; k++) {
        const ry = Math.round(y0 - top + k * rowH);
        g.fillStyle = '#343b50'; g.fillRect(0, ry + rowH - 3, W, 2);          // the step each row stands on
        g.fillStyle = '#1a1e2a'; g.fillRect(0, ry + rowH - 1, W, 1);
        for (let x = 2 + Math.floor(r() * 4); x < W - 6; x += 7 + Math.floor(r() * 3)) {
          if (r() < 0.12) continue;                                          // an empty seat
          const sx = x, sy = ry + Math.max(1, Math.round(rowH - 13));
          const shirt = SHIRTS[Math.floor(r() * SHIRTS.length)];
          const skin = SKINS[Math.floor(r() * SKINS.length)];
          g.fillStyle = HAIRS[Math.floor(r() * HAIRS.length)]; g.fillRect(sx + 1, sy, 4, 2);
          g.fillStyle = skin; g.fillRect(sx + 1, sy + 1, 4, 4);
          g.fillStyle = shirt; g.fillRect(sx, sy + 5, 6, 6);
          if (r() < 0.28) {                                                  // arms up on the other beat
            a.fillStyle = skin; a.fillRect(sx - 1, sy - 2, 1, 6); a.fillRect(sx + 6, sy - 2, 1, 6);
            a.fillStyle = shirt; a.fillRect(sx - 1, sy + 4, 1, 2); a.fillRect(sx + 6, sy + 4, 1, 2);
          }
          if (r() < 0.025) {                                                 // a yellow or red banner on a stick
            const col = r() < 0.5 ? '#f6d02a' : '#e0322c';
            g.fillStyle = '#8a8a8a'; g.fillRect(sx + 6, sy - 9, 1, 12);
            g.fillStyle = col; g.fillRect(sx + 7, sy - 9, 9, 5);
            a.fillStyle = col; a.fillRect(sx + 7, sy - 8, 10, 4);
          }
        }
      }
    };
    tier(Y.wallEnd, Y.tier1End, 14);
    tier(Y.bannerEnd, Y.tier2End, 9);
    // The raised arms sit under the same night shade the stands get in build().
    a.globalCompositeOperation = 'source-atop';
    a.fillStyle = 'rgba(0,14,36,0.28)'; a.fillRect(0, 0, W, h);
    return { base, alt, top, h };
  }

  function paintSky(g) {
    let gr = g.createLinearGradient(0, 0, W, 0);
    gr.addColorStop(0, '#13497d'); gr.addColorStop(0.5, '#002a48'); gr.addColorStop(1, '#1e5c7b');   // M (sec 7)
    g.fillStyle = gr; g.fillRect(0, 0, W, Y.wallEnd);
    gr = g.createLinearGradient(0, 0, 0, Y.skyEnd);
    gr.addColorStop(0, 'rgba(0,12,30,0.35)'); gr.addColorStop(1, 'rgba(0,12,30,0)');
    g.fillStyle = gr; g.fillRect(0, 0, W, Y.skyEnd);
    // Big blue-white spotlight glows (sec 7). Where they sit is CHOSEN: two over each half of the stand.
    g.save();
    g.beginPath(); g.rect(0, 0, W, Y.tier1End); g.clip();
    const LIGHTS = [[96, 22, 175], [370, -6, 190], [826, -6, 190], [1100, 22, 175]];
    for (const [x, y, rad] of LIGHTS) {
      const rg = g.createRadialGradient(x, y, 0, x, y, rad);
      rg.addColorStop(0, 'rgba(240,248,255,0.95)');
      rg.addColorStop(0.16, 'rgba(205,228,255,0.6)');
      rg.addColorStop(0.45, 'rgba(150,196,255,0.2)');
      rg.addColorStop(1, 'rgba(120,170,255,0)');
      g.fillStyle = rg; g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
      if (y > 0) {                                     // the lamp bank itself, where it is on screen
        g.fillStyle = '#ffffff';
        for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) g.fillRect(x - 15 + i * 8, y - 6 + j * 8, 6, 6);
      }
    }
    g.restore();
  }

  function paintWall(g) {
    const gr = g.createLinearGradient(0, Y.skyEnd, 0, Y.wallEnd);
    gr.addColorStop(0, '#b2b0b6'); gr.addColorStop(1, '#696967');                                // M (sec 7)
    g.fillStyle = gr; g.fillRect(0, Y.skyEnd, W, Y.wallEnd - Y.skyEnd);
    g.fillStyle = 'rgba(40,40,44,0.35)';
    for (let x = 40; x < W; x += 92) g.fillRect(x, Y.skyEnd, 2, Y.wallEnd - Y.skyEnd);
    g.fillStyle = '#3b3b3e'; g.fillRect(0, Y.wallEnd - 2, W, 2);
  }

  function paintBanner(g) {
    const y0 = Y.tier1End, y1 = Y.bannerEnd;
    const gr = g.createLinearGradient(0, y0, 0, y1);
    gr.addColorStop(0, '#3ea6ff'); gr.addColorStop(0.5, '#0d85ef'); gr.addColorStop(1, '#0a5fb3');   // M: #0d85ef family
    g.fillStyle = gr; g.fillRect(0, y0, W, y1 - y0);
    g.fillStyle = 'rgba(255,255,255,0.16)';
    for (let x = 0; x < W; x += 46) { g.beginPath(); g.moveTo(x, y1); g.lineTo(x + 14, y0); g.lineTo(x + 26, y0); g.lineTo(x + 12, y1); g.fill(); }
    g.fillStyle = '#063a70'; g.fillRect(0, y0, W, 2); g.fillRect(0, y1 - 2, W, 2);
  }

  function paintBarrier(g) {
    g.fillStyle = '#ffcf2a'; g.fillRect(0, Y.tier2End, W, 5);
    const gr = g.createLinearGradient(0, Y.tier2End + 5, 0, Y.barrierEnd);
    gr.addColorStop(0, '#e2302f'); gr.addColorStop(1, '#a3161a');
    g.fillStyle = gr; g.fillRect(0, Y.tier2End + 5, W, Y.barrierEnd - Y.tier2End - 5);
  }

  /* The ad board (sec 7): pink/magenta, sky blue, red, white lettering. Our own name only, never the original's. */
  function paintAds(g) {
    const y0 = Y.barrierEnd, y1 = Y.adEnd, n = 6, w = W / n;
    const COLS = ['#e0287f', '#009ee2', '#d8262c', '#0982c0', '#e0287f', '#009ee2'];
    for (let i = 0; i < n; i++) {
      const gr = g.createLinearGradient(0, y0, 0, y1);
      gr.addColorStop(0, COLS[i]); gr.addColorStop(1, shade(COLS[i], -0.22));
      g.fillStyle = gr; g.fillRect(i * w, y0, w + 1, y1 - y0);
      g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(i * w, y0, 2, y1 - y0);
    }
    g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillRect(0, y0, W, 2);
    g.fillStyle = 'rgba(0,0,0,0.3)'; g.fillRect(0, y1 - 2, W, 2);
    g.save();
    g.font = 'italic 800 24px ' + FONT;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#ffffff';
    for (let i = 0; i < n; i++) g.fillText('DUELSERIES', i * w + w / 2, (y0 + y1) / 2 + 1, w - 24);
    g.restore();
  }

  function shade(hex, f) {
    const n = parseInt(hex.slice(1), 16);
    const c = [n >> 16 & 255, n >> 8 & 255, n & 255].map(v => Math.round(f < 0 ? v * (1 + f) : v + (255 - v) * f));
    return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
  }

  /* Grass (sec 7): #9ec46a base with #aed077 bands, soft horizontal stripes that widen toward the camera, thin pale
     lines with a centre circle near x 600 and a box at each end. The band heights and the line positions are CHOSEN. */
  function paintGrass(g) {
    const y0 = Y.adEnd;
    g.fillStyle = '#9ec46a'; g.fillRect(0, y0, W, H - y0);
    const cuts = [545, 556, 569, 585, 604, 627, 654, 686, 720];
    for (let i = 0; i < cuts.length - 1; i++) if (i % 2 === 1) { g.fillStyle = '#aed077'; g.fillRect(0, cuts[i], W, cuts[i + 1] - cuts[i]); }
    const gr = g.createLinearGradient(0, y0, 0, y0 + 14);
    gr.addColorStop(0, 'rgba(40,60,20,0.28)'); gr.addColorStop(1, 'rgba(40,60,20,0)');
    g.fillStyle = gr; g.fillRect(0, y0, W, 14);
    g.strokeStyle = '#c8e3a3'; g.lineWidth = 3; g.lineJoin = 'round';                              // M: #bfdd9c..#c8e3a3
    g.beginPath(); g.moveTo(0, 553); g.lineTo(W, 553); g.stroke();                                  // the far touchline
    g.beginPath(); g.moveTo(W / 2, 553); g.lineTo(W / 2, H); g.stroke();                            // halfway
    g.beginPath(); g.ellipse(W / 2, 634, 112, 46, 0, 0, Math.PI * 2); g.stroke();                   // centre circle
    g.fillStyle = '#c8e3a3'; g.beginPath(); g.ellipse(W / 2, 634, 6, 3, 0, 0, Math.PI * 2); g.fill();
    for (const s of [1, -1]) {                                                                       // the two boxes
      const x0 = s > 0 ? 0 : W, fx = (v) => (s > 0 ? v : W - v);
      g.beginPath(); g.moveTo(x0, 568); g.lineTo(fx(152), 568); g.lineTo(fx(212), 712); g.lineTo(x0, 712); g.stroke();
    }
  }

  /* ── the goals ───────────────────────────────────────────────────────────
     Sec 4: front white post at x 36..44, grey side face to x 66 (the mouth, HS.GOAL_D), crossbar underside at y 404
     (HS.BAR_Y) with the bar HS.BAR_T thick above it, frame bottom at y 607. Sec 7: white tube frame, grey inner side
     face, light net grid with a slight red tint, in perspective with the top leaning toward the pitch. The net roof's
     height (about 30 px with the bar, sec 4) is drawn 404 - 28 = 376. The left goal is drawn; the right is its mirror.
     The back net and side face go behind the ball (baked into the stadium); the post, bar and roof go in front. */
  const GOAL = { post0: 36, post1: 44, mouth: HS.GOAL_D, barTop: HS.BAR_Y - HS.BAR_T, barBot: HS.BAR_Y,
                 roofTop: 376, frameBot: 607, ground: HS.GROUND_Y };
  function netGrid(g, x0, y0, x1, y1, step) {
    g.beginPath();
    for (let x = x0; x <= x1; x += step) { g.moveTo(x, y0); g.lineTo(x, y1); }
    for (let y = y0; y <= y1; y += step) { g.moveTo(x0, y); g.lineTo(x1, y); }
    g.stroke();
  }
  function paintGoalBack(g) {
    const G = GOAL;
    g.save();
    g.fillStyle = 'rgba(236,222,226,0.20)'; g.fillRect(0, G.barBot, G.post0, G.ground - G.barBot);
    g.strokeStyle = 'rgba(244,236,240,0.55)'; g.lineWidth = 1.2;
    g.save(); g.beginPath(); g.rect(0, G.barBot, G.post1, G.ground - G.barBot); g.clip();
    netGrid(g, 0, G.barBot, G.post1, G.ground, 9);
    g.restore();
    // The grey inner side face, leaning: wide at the bar, narrower at the grass.
    g.beginPath();
    g.moveTo(G.post1, G.barBot); g.lineTo(G.mouth, G.barBot); g.lineTo(G.mouth - 8, G.ground + 2); g.lineTo(G.post1, G.frameBot);
    g.closePath();
    g.fillStyle = 'rgba(128,130,140,0.62)'; g.fill();
    g.save(); g.clip();
    g.strokeStyle = 'rgba(220,220,228,0.45)'; g.lineWidth = 1;
    netGrid(g, G.post1 - 9, G.barBot, G.mouth, G.frameBot, 9);
    g.restore();
    // The tube along the grass at the back.
    g.fillStyle = '#e9e9ee'; g.fillRect(0, G.ground, G.post1, G.frameBot - G.ground);
    g.fillStyle = '#a7a7ae'; g.fillRect(0, G.frameBot - 3, G.post1, 3);
    g.restore();
  }
  function paintGoalFront(g) {
    const G = GOAL;
    // The roof net, leaning toward the pitch.
    g.beginPath();
    g.moveTo(0, G.roofTop); g.lineTo(G.post1, G.roofTop); g.lineTo(G.mouth, G.barTop); g.lineTo(0, G.barTop);
    g.closePath();
    g.fillStyle = 'rgba(240,238,244,0.32)'; g.fill();
    g.save(); g.clip();
    g.strokeStyle = 'rgba(250,246,250,0.6)'; g.lineWidth = 1.1;
    netGrid(g, 0, G.roofTop, G.mouth, G.barTop, 8);
    g.restore();
    const tube = (x0, y0, x1, y1, w) => {
      g.lineCap = 'round';
      g.strokeStyle = '#2a2f3a'; g.lineWidth = w + 2.5; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
      g.strokeStyle = '#f4f4f8'; g.lineWidth = w; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
    };
    tube(0, G.roofTop + 2, G.post1, G.roofTop + 2, 5);                     // the back top bar
    tube(G.post1, G.roofTop + 2, G.mouth, G.barTop + 3, 5);                // the roof's leaning edge
    // The crossbar: exactly the physics box (x 0..66, y BAR_Y - BAR_T .. BAR_Y).
    g.fillStyle = '#2a2f3a'; rr(g, -2, G.barTop - 1, G.mouth + 3, HS.BAR_T + 2, (HS.BAR_T + 2) / 2); g.fill();
    g.fillStyle = '#f6f6fa'; rr(g, -2, G.barTop, G.mouth + 1.5, HS.BAR_T, HS.BAR_T / 2); g.fill();
    g.fillStyle = '#c3c4cc'; g.fillRect(0, G.barBot - 2.5, G.mouth - 3, 2);
    // The front post, white with a grey shaded edge.
    g.fillStyle = '#2a2f3a'; rr(g, G.post0 - 1.2, G.barBot - 2, G.post1 - G.post0 + 2.4, G.frameBot - G.barBot + 3, 4); g.fill();
    g.fillStyle = '#f6f6fa'; rr(g, G.post0, G.barBot - 1, G.post1 - G.post0, G.frameBot - G.barBot + 1, 3.5); g.fill();
    g.fillStyle = '#c9c9d1'; g.fillRect(G.post1 - 2.5, G.barBot, 2, G.frameBot - G.barBot - 3);
  }

  /* ── the ball ────────────────────────────────────────────────────────────
     Sec 7: white with black pentagons, outlined, no shading to speak of. Radius HS.BALL_R. */
  function paintBall(g, R) {
    g.save();
    g.beginPath(); g.arc(0, 0, R, 0, Math.PI * 2); g.fillStyle = '#ffffff'; g.fill();
    g.clip();
    const pent = (cx, cy, r, rot) => {
      g.beginPath();
      for (let i = 0; i < 5; i++) {
        const a = rot + i * Math.PI * 2 / 5;
        const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
        if (i) g.lineTo(x, y); else g.moveTo(x, y);
      }
      g.closePath(); g.fill();
    };
    g.fillStyle = '#16161a';
    pent(0, 0, R * 0.36, -Math.PI / 2);
    g.strokeStyle = '#2b2b30'; g.lineWidth = R * 0.07;
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI / 2 + i * Math.PI * 2 / 5;
      g.beginPath(); g.moveTo(Math.cos(a) * R * 0.36, Math.sin(a) * R * 0.36); g.lineTo(Math.cos(a) * R * 0.7, Math.sin(a) * R * 0.7); g.stroke();
      pent(Math.cos(a + Math.PI / 5) * R * 0.98, Math.sin(a + Math.PI / 5) * R * 0.98, R * 0.36, a + Math.PI / 5);
    }
    g.restore();
    g.beginPath(); g.arc(0, 0, R - 0.8, 0, Math.PI * 2); g.strokeStyle = '#1b1b20'; g.lineWidth = 1.8; g.stroke();
  }

  /* ── the heads ───────────────────────────────────────────────────────────
     Sec 4/7: an 80 x 70 head (HS.HEAD_W x HS.HEAD_HT, centred on the player's x, y), big eyes, bold brows, hair.
     Painted facing right; a player facing left is the same sprite mirrored. Two sprites each: open and blinking. */
  const HEAD_BOX = { x0: -54, y0: -52, w: 108, h: 98 };
  function paintHead(g, L, side, blink) {
    const rx = HS.HEAD_W / 2, ry = HS.HEAD_HT / 2;
    g.lineJoin = 'round'; g.lineCap = 'round';
    // Hair behind the head (volume at the back and top).
    g.fillStyle = L.hair;
    if (side === 1) { g.beginPath(); g.ellipse(-6, -12, rx + 4, ry - 2, -0.15, 0, Math.PI * 2); g.fill(); }
    else { g.beginPath(); g.ellipse(-4, -8, rx + 1, ry - 4, 0, 0, Math.PI * 2); g.fill(); }
    // The face.
    g.beginPath(); g.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    g.fillStyle = L.skin; g.fill();
    g.strokeStyle = L.skinLine; g.lineWidth = 2; g.stroke();
    // An ear on the back of the head.
    g.beginPath(); g.ellipse(-rx + 6, 5, 6.5, 8.5, 0, 0, Math.PI * 2);
    g.fillStyle = L.skin; g.fill(); g.stroke();
    // Hair on top, a fringe across the forehead.
    g.beginPath();
    if (side === 0) {          // short and black, a spiky fringe
      g.moveTo(-rx - 1, 2);
      g.bezierCurveTo(-rx - 2, -ry - 6, rx + 2, -ry - 8, rx + 1, -4);
      g.lineTo(rx - 4, -12); g.lineTo(rx - 10, -7); g.lineTo(rx - 14, -15); g.lineTo(rx - 21, -9); g.lineTo(rx - 26, -17);
      g.lineTo(rx - 33, -11); g.lineTo(rx - 38, -18); g.lineTo(-14, -14); g.lineTo(-22, -6); g.lineTo(-30, 0);
      g.closePath();
    } else {                   // blond, swept up and forward
      g.moveTo(-rx - 3, 6);
      g.bezierCurveTo(-rx - 6, -ry - 14, rx - 6, -ry - 18, rx + 6, -ry + 2);
      g.quadraticCurveTo(rx + 2, -12, rx - 6, -10);
      g.lineTo(rx - 14, -16); g.lineTo(rx - 20, -9); g.lineTo(rx - 30, -17); g.lineTo(-10, -12);
      g.quadraticCurveTo(-24, -6, -30, 4);
      g.closePath();
    }
    g.fillStyle = L.hair; g.fill();
    g.strokeStyle = shade(L.hair === '#1c181b' ? '#000000' : L.hair, -0.45); g.lineWidth = 1.6; g.stroke();
    g.strokeStyle = L.hairHi; g.lineWidth = 2.2;
    g.beginPath(); g.moveTo(-18, -ry + 4); g.quadraticCurveTo(-2, -ry - 1, 12, -ry + 3); g.stroke();
    // The eyes: big, looking forward (toward the other goal).
    const EYES = [[7, 3, 0.92], [24, 3, 1]];
    for (const [ex, ey, k] of EYES) {
      if (blink) {
        g.strokeStyle = '#2a1a12'; g.lineWidth = 2.6;
        g.beginPath(); g.moveTo(ex - 7 * k, ey + 1); g.quadraticCurveTo(ex, ey + 5, ex + 7 * k, ey + 1); g.stroke();
        continue;
      }
      g.beginPath(); g.ellipse(ex, ey, 7.5 * k, 10 * k, 0, 0, Math.PI * 2);
      g.fillStyle = '#ffffff'; g.fill(); g.strokeStyle = '#2a1a12'; g.lineWidth = 1.6; g.stroke();
      g.beginPath(); g.arc(ex + 2.6, ey + 1.5, 4.6 * k, 0, Math.PI * 2); g.fillStyle = '#17120f'; g.fill();
      g.beginPath(); g.arc(ex + 4, ey - 1.4, 1.6, 0, Math.PI * 2); g.fillStyle = '#ffffff'; g.fill();
    }
    // Bold brows, set determined: low between the eyes.
    g.strokeStyle = L.brow; g.lineWidth = 5;
    g.beginPath(); g.moveTo(-1, -12); g.lineTo(12, -8.5); g.stroke();
    g.beginPath(); g.moveTo(17, -8.5); g.lineTo(31, -13); g.stroke();
    // Nose, mouth and a little colour in the cheek.
    g.strokeStyle = L.skinLine; g.lineWidth = 2;
    g.beginPath(); g.moveTo(rx - 4, 6); g.quadraticCurveTo(rx + 1, 11, rx - 5, 13); g.stroke();
    g.strokeStyle = '#7d2b26'; g.lineWidth = 2.6;
    g.beginPath(); g.moveTo(16, 22); g.quadraticCurveTo(22, 20, 29, 21); g.stroke();
    g.fillStyle = 'rgba(232,96,90,0.22)'; g.beginPath(); g.ellipse(30, 13, 5, 3, 0, 0, Math.PI * 2); g.fill();
  }

  /* ── the strip across the top ─────────────────────────────────────────── */

  /* The power gauge's flame (sec 3/6: "flame/lightning shaped bar with POWER printed in it ... fills from the flag
     outward"). The outline is CHOSEN: full height at the badge end, flame licks toward the far end. u runs from the
     badge end (0) to the far end (1), v from the top (0) to the bottom (1). */
  const FLAME = [[0, 0.06], [0.5, 0.14], [0.58, 0], [0.73, 0.2], [0.81, 0.07], [1, 0.48],
                 [0.85, 0.9], [0.77, 0.78], [0.61, 1], [0.53, 0.86], [0, 0.94]];
  function gaugeX(side, u) { const G = HUD.gauge[side]; return G.inner + (G.outer - G.inner) * u; }
  function gaugePath(side) {
    const p = new Path2D(), y0 = HUD.gaugeY0, hh = HUD.gaugeY1 - HUD.gaugeY0;
    FLAME.forEach(([u, v], i) => { const x = gaugeX(side, u), y = y0 + v * hh; if (i) p.lineTo(x, y); else p.moveTo(x, y); });
    p.closePath();
    return p;
  }
  function shieldPath(g, cx, cy, w, h) {
    g.beginPath();
    g.moveTo(cx - w / 2, cy - h / 2); g.lineTo(cx + w / 2, cy - h / 2); g.lineTo(cx + w / 2, cy - h * 0.06);
    g.quadraticCurveTo(cx + w / 2, cy + h * 0.32, cx, cy + h / 2);
    g.quadraticCurveTo(cx - w / 2, cy + h * 0.32, cx - w / 2, cy - h * 0.06);
    g.closePath();
  }
  /* The badges (a team-colour shield, not a national flag) in the measured 100 x 63 boxes with a thin light-green
     border, and the dark TIME label. */
  function paintHudStatic(g, colors) {
    for (let s = 0; s < 2; s++) {
      const x = HUD.badge[s].x, y = HUD.badgeY, w = HUD.badgeW, h = HUD.badgeH;
      const gr = g.createLinearGradient(0, y, 0, y + h);
      gr.addColorStop(0, shade(colors[s], 0.18)); gr.addColorStop(1, shade(colors[s], -0.3));
      rr(g, x, y, w, h, 5); g.fillStyle = gr; g.fill();
      g.strokeStyle = '#122016'; g.lineWidth = 4; g.stroke();
      g.strokeStyle = '#b4e67c'; g.lineWidth = 2; g.stroke();
      const cx = x + w / 2, cy = y + h / 2 + 1;
      shieldPath(g, cx, cy, 38, 44); g.fillStyle = '#ffffff'; g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 1.5; g.stroke();
      shieldPath(g, cx, cy + 0.5, 29, 35); g.fillStyle = shade(colors[s], -0.12); g.fill();
      g.save(); g.clip(); g.fillStyle = '#ffffff'; g.fillRect(cx - 4, cy - 20, 8, 40); g.restore();
      g.fillStyle = 'rgba(255,255,255,0.2)'; g.fillRect(x + 3, y + 3, w - 6, 10);
    }
    const lw = 64, lx = HUD.axis - lw / 2;
    rr(g, lx, HUD.clockY0, lw, 21, 10.5); g.fillStyle = '#1b2230'; g.fill();
    g.strokeStyle = '#0a0e15'; g.lineWidth = 2; g.stroke();
    g.font = '800 14px ' + FONT; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#ffd83a'; g.fillText('TIME', HUD.axis, HUD.clockY0 + 11);
  }

  /* ── the phone buttons ───────────────────────────────────────────────────
     Sec 6: gold arrow shapes for L and R with a brown outline, semi-transparent; rounded gold Kick and Jump; Power
     the same style, only while the gauge is full. Painted in CSS pixels at the size the layout gives them. */
  function paintButton(kind, w, h, dpr, pressed) {
    const c = canvas(w * dpr, h * dpr), g = c.getContext('2d');
    g.scale(dpr, dpr);
    const lw = Math.max(2.5, Math.min(w, h) * 0.05), m = lw;
    g.save();
    if (pressed) { g.translate(w / 2, h / 2); g.scale(0.95, 0.95); g.translate(-w / 2, -h / 2); }
    g.beginPath();
    if (kind === 'L' || kind === 'R') {
      const tip = Math.min(w * 0.3, h * 0.55), x0 = m, x1 = w - m, y0 = m, y1 = h - m, cy = h / 2;
      if (kind === 'L') { g.moveTo(x0, cy); g.lineTo(x0 + tip, y0); g.lineTo(x1, y0); g.lineTo(x1, y1); g.lineTo(x0 + tip, y1); }
      else { g.moveTo(x1, cy); g.lineTo(x1 - tip, y0); g.lineTo(x0, y0); g.lineTo(x0, y1); g.lineTo(x1 - tip, y1); }
      g.closePath();
    } else {
      rr(g, m, m, w - 2 * m, h - 2 * m, Math.min(h * 0.32, 26));
    }
    const power = kind === 'P';
    const gr = g.createLinearGradient(0, 0, 0, h);
    if (power) { gr.addColorStop(0, '#ffd27a'); gr.addColorStop(0.5, '#ff8a1e'); gr.addColorStop(1, '#d9420c'); }
    else if (pressed) { gr.addColorStop(0, '#f2c24e'); gr.addColorStop(0.5, '#d9961a'); gr.addColorStop(1, '#b06a08'); }
    else { gr.addColorStop(0, '#ffe88a'); gr.addColorStop(0.5, '#f6b82c'); gr.addColorStop(1, '#d68a10'); }
    g.fillStyle = gr; g.fill();
    g.lineJoin = 'round'; g.strokeStyle = '#5e3208'; g.lineWidth = lw; g.stroke();
    // The gloss: a pale band over the top half.
    g.save(); g.clip();
    const gl = g.createLinearGradient(0, 0, 0, h * 0.55);
    gl.addColorStop(0, 'rgba(255,255,255,0.55)'); gl.addColorStop(1, 'rgba(255,255,255,0.05)');
    g.fillStyle = gl; g.fillRect(0, 0, w, h * 0.5);
    g.restore();
    g.fillStyle = '#5a2e06'; g.textAlign = 'center'; g.textBaseline = 'middle';
    if (kind === 'L' || kind === 'R') {
      const s = Math.min(w, h) * 0.22, cx = kind === 'L' ? w * 0.56 : w * 0.44, d = kind === 'L' ? -1 : 1;
      g.beginPath(); g.moveTo(cx + d * s, h / 2); g.lineTo(cx - d * s * 0.7, h / 2 - s); g.lineTo(cx - d * s * 0.7, h / 2 + s);
      g.closePath(); g.fill();
    } else {
      const label = kind === 'K' ? 'KICK' : kind === 'J' ? 'JUMP' : 'POWER';
      let fs = Math.min(h * 0.38, w * (label.length > 4 ? 0.19 : 0.24));
      g.font = 'italic 900 ' + fs.toFixed(1) + 'px ' + FONT;
      g.fillStyle = power ? '#fffbe8' : '#5a2e06';
      if (power) { g.strokeStyle = '#6a1f00'; g.lineWidth = fs * 0.16; g.strokeText(label, w / 2, h / 2 + 1); }
      g.fillText(label, w / 2, h / 2 + 1);
    }
    g.restore();
    return c;
  }

  /* ── the art object ──────────────────────────────────────────────────── */
  function create() {
    const A = {
      k: 1, colors: [LOOKS[0].kit, LOOKS[1].kit], looks: [LOOKS[0], LOOKS[1]],
      bg: null, crowd: null, goalFront: null, ball: null, heads: null, glow: null, hud: null,
      gaugePaths: [gaugePath(0), gaugePath(1)], grads: null, goalLetters: null, btn: {},
      bolts: new Float32Array(3 * 12 * 2), boltsAt: -1e9,
    };

    /* Everything that does not move, painted at k device pixels per world unit. */
    A.build = function (k) {
      A.k = k;
      A.crowd = A.crowd || paintCrowd();
      const bg = canvas(W * k, H * k), g = bg.getContext('2d');
      g.scale(k, k);
      paintSky(g); paintWall(g);
      g.imageSmoothingEnabled = false;
      g.drawImage(A.crowd.base, 0, A.crowd.top, W, A.crowd.h);
      g.imageSmoothingEnabled = true;
      // It is night: the stands sit a little under the floodlights, so the players and the ball read first.
      g.fillStyle = 'rgba(0,14,36,0.28)'; g.fillRect(0, Y.wallEnd, W, Y.tier2End - Y.wallEnd);
      // Spotlight wash over the stands, so the crowd under a light reads lit.
      g.save(); g.globalCompositeOperation = 'lighter';
      for (const x of [96, 370, 826, 1100]) {
        const rg = g.createRadialGradient(x, 120, 0, x, 120, 230);
        rg.addColorStop(0, 'rgba(120,150,190,0.18)'); rg.addColorStop(1, 'rgba(120,150,190,0)');
        g.fillStyle = rg; g.fillRect(x - 230, Y.wallEnd, 460, Y.tier2End - Y.wallEnd);
      }
      g.restore();
      paintBanner(g); paintBarrier(g); paintAds(g); paintGrass(g);
      paintGoalBack(g);
      g.save(); g.translate(W, 0); g.scale(-1, 1); paintGoalBack(g); g.restore();
      A.bg = bg;

      // The goal's front frame, a small sprite (world x -4..72, y 368..612).
      const gf = canvas(76 * k, 244 * k), gg = gf.getContext('2d');
      gg.scale(k, k); gg.translate(4, -368); paintGoalFront(gg);
      A.goalFront = gf;

      const R = HS.BALL_R, bs = canvas((R * 2 + 4) * k, (R * 2 + 4) * k), bgx = bs.getContext('2d');
      bgx.scale(k, k); bgx.translate(R + 2, R + 2); paintBall(bgx, R);
      A.ball = bs;

      A.buildHeads();

      // The charged player's yellow glow (sec 3, early versions).
      const gw = canvas(160 * k, 160 * k), gx = gw.getContext('2d');
      gx.scale(k, k);
      const rg = gx.createRadialGradient(80, 80, 20, 80, 80, 80);
      rg.addColorStop(0, 'rgba(255,240,90,0.75)'); rg.addColorStop(0.55, 'rgba(255,210,40,0.32)'); rg.addColorStop(1, 'rgba(255,200,30,0)');
      gx.fillStyle = rg; gx.fillRect(0, 0, 160, 160);
      A.glow = gw;

      A.buildHud();
      A.goalLetters = null;
    };

    A.buildHeads = function () {
      const k = A.k;
      A.heads = [0, 1].map(side => [false, true].map(blink => {
        const c = canvas(HEAD_BOX.w * k, HEAD_BOX.h * k), g = c.getContext('2d');
        g.scale(k, k); g.translate(-HEAD_BOX.x0, -HEAD_BOX.y0);
        paintHead(g, A.looks[side], side, blink);
        return c;
      }));
    };

    A.buildHud = function () {
      const k = A.k;
      const hc = canvas(W * k, 130 * k), g = hc.getContext('2d');
      g.scale(k, k); paintHudStatic(g, A.colors);
      A.hud = hc;
    };

    /* A bought skin dresses the kit (and the badge) in its colour; the server decided which skin, if any. */
    A.setKits = function (cols) {
      let changed = false;
      for (let s = 0; s < 2; s++) {
        const want = cols && cols[s] ? cols[s] : LOOKS[s].kit;
        if (A.colors[s] !== want) {
          A.colors[s] = want;
          A.looks[s] = Object.assign({}, LOOKS[s], { kit: want, kitDark: shade(want, -0.32) });
          changed = true;
        }
      }
      if (changed && A.bg) A.buildHud();
    };

    A.grad = function (ctx) {
      if (A.grads) return A.grads;
      const gl = [0, 1].map(s => {
        const gr = ctx.createLinearGradient(HUD.gauge[s].inner, 0, HUD.gauge[s].outer, 0);
        gr.addColorStop(0, '#a6d84a'); gr.addColorStop(0.35, '#ffe23a'); gr.addColorStop(0.68, '#ff9420'); gr.addColorStop(1, '#ff3418');
        return gr;
      });
      const full = [0, 1].map(s => {
        const gr = ctx.createLinearGradient(HUD.gauge[s].inner, 0, HUD.gauge[s].outer, 0);
        gr.addColorStop(0, '#ffb21a'); gr.addColorStop(0.55, '#ff5a12'); gr.addColorStop(1, '#e8160e');
        return gr;
      });
      const score = ctx.createLinearGradient(0, HUD.scoreY0, 0, HUD.scoreY1);
      score.addColorStop(0, '#fff7b8'); score.addColorStop(0.5, '#ffd23a'); score.addColorStop(1, '#e08600');
      A.grads = { gauge: gl, full, score };
      return A.grads;
    };

    /* ── per frame ───────────────────────────────────────────────────────── */

    A.field = function (ctx, t, excited) {
      ctx.drawImage(A.bg, 0, 0, W, H);
      const beat = excited ? 160 : 430;                 // CHOSEN: the shimmer's beat, quicker after a goal
      if (Math.floor(t / beat) % 2 === 1) {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(A.crowd.alt, 0, A.crowd.top, W, A.crowd.h);
        ctx.imageSmoothingEnabled = true;
      }
    };

    A.goalFronts = function (ctx) {
      ctx.drawImage(A.goalFront, -4, 368, 76, 244);
      ctx.save(); ctx.translate(W, 0); ctx.scale(-1, 1);
      ctx.drawImage(A.goalFront, -4, 368, 76, 244);
      ctx.restore();
    };

    A.shadow = function (ctx, x, rx, alpha) {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#20361a';
      ctx.beginPath(); ctx.ellipse(x, HS.GROUND_Y - 1, rx, rx * 0.2, 0, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    };

    /* One player: shadow, back boot, shirt, the head sprite, then the kicking leg and boot on top. The kicking boot
       is drawn from HSSim.footAt(p), the physics collider, so what you see hitting the ball is what hit it. */
    A.player = function (ctx, p, t, o) {
      const L = A.looks[p.side], d = p.dir, x = p.x, y = p.y;
      const charged = o && o.charged, armed = o && o.armed;
      if (charged) {
        const pulse = 0.55 + 0.45 * Math.sin(t / 110);
        ctx.globalAlpha = armed ? 0.95 : 0.45 + 0.35 * pulse;
        ctx.drawImage(A.glow, x - 80, y - 74, 160, 160);
        ctx.globalAlpha = 1;
      }
      const air = Math.max(0, HS.GROUND_Y - (y + HS.HEAD_HT / 2 + HS.BODY_H));
      A.shadow(ctx, x, 30 * Math.max(0.55, 1 - air / 160), 0.22);
      const hipY = y + HS.HEAD_HT / 2 + 9, soleY = y + HS.HEAD_HT / 2 + HS.BODY_H;
      // The back leg and boot, planted.
      const bx = x - d * 10;
      ctx.lineCap = 'round';
      ctx.strokeStyle = L.kit; ctx.lineWidth = 7;
      ctx.beginPath(); ctx.moveTo(x - d * 5, hipY); ctx.lineTo(bx, soleY - 9); ctx.stroke();
      ctx.fillStyle = '#121214';
      ctx.beginPath(); ctx.ellipse(bx - d * 1, soleY - 6, 12.5, 6.5, 0, 0, Math.PI * 2); ctx.fill();
      // The shirt band and shorts under the chin.
      ctx.fillStyle = L.kit; rr(ctx, x - 16, y + HS.HEAD_HT / 2 - 6, 32, 15, 6); ctx.fill();
      ctx.fillStyle = L.kitDark; ctx.fillRect(x - 15, y + HS.HEAD_HT / 2 + 6, 30, 3);
      ctx.fillStyle = L.shorts; rr(ctx, x - 13, y + HS.HEAD_HT / 2 + 6, 26, 7, 3); ctx.fill();
      // The head.
      const blink = (t + p.side * 1700) % 3900 < 120;
      const img = A.heads[p.side][blink ? 1 : 0];
      if (d > 0) ctx.drawImage(img, x + HEAD_BOX.x0, y + HEAD_BOX.y0, HEAD_BOX.w, HEAD_BOX.h);
      else {
        ctx.save(); ctx.translate(x, y); ctx.scale(-1, 1);
        ctx.drawImage(img, HEAD_BOX.x0, HEAD_BOX.y0, HEAD_BOX.w, HEAD_BOX.h);
        ctx.restore();
      }
      // The kicking leg and boot.
      const f = Sim.footAt(p);
      ctx.strokeStyle = L.kit; ctx.lineWidth = 7;
      ctx.beginPath(); ctx.moveTo(x + d * 5, hipY); ctx.lineTo(f.x - d * 7, f.y - 2); ctx.stroke();
      ctx.save();
      ctx.translate(f.x, f.y); ctx.rotate(-d * f.a);
      ctx.fillStyle = '#121214';
      ctx.beginPath(); ctx.ellipse(-d * 2, 0, HS.FOOT_R + 2, HS.FOOT_R - 2.5, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      ctx.beginPath(); ctx.ellipse(-d * 3, -4, 6, 2, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    };

    /* "You": a small gold arrow over your own head while the match is starting. */
    A.youMark = function (ctx, x, y, t) {
      const yy = y - HS.HEAD_HT / 2 - 26 + Math.sin(t / 160) * 3;
      ctx.beginPath(); ctx.moveTo(x - 11, yy - 12); ctx.lineTo(x + 11, yy - 12); ctx.lineTo(x, yy + 2); ctx.closePath();
      ctx.fillStyle = '#ffd23a'; ctx.fill(); ctx.strokeStyle = '#4a2600'; ctx.lineWidth = 2.5; ctx.stroke();
    };

    A.ballAt = function (ctx, x, y, rot, scale) {
      const R = HS.BALL_R * (scale || 1), s = R + 2 * (scale || 1);
      ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
      ctx.drawImage(A.ball, -s, -s, s * 2, s * 2);
      ctx.restore();
    };

    A.ballShadow = function (ctx, x, y) {
      const h = Math.max(0, HS.BALL_FLOOR_Y - y);
      A.shadow(ctx, x, 16 * Math.max(0.35, 1 - h / 380), 0.2 * Math.max(0.3, 1 - h / 500));
    };

    /* The strip: [gauge][badge][TIME and clock][badge][gauge], scores under the badges, names under the gauges. */
    A.hudDraw = function (ctx, h, t) {
      const G = A.grad(ctx);
      ctx.drawImage(A.hud, 0, 0, W, 130);
      ctx.lineJoin = 'round';
      const gauges = !!HS.POWER_SHOT;   // the power shot is off (Owen 2026-10-27): no gauge, the name takes its place
      for (let s = 0; s < 2; s++) {
        if (!gauges) {
          if (h.names[s]) {
            const nx = (HUD.gauge[s].inner + HUD.gauge[s].outer) / 2, ny = (HUD.gaugeY0 + HUD.gaugeY1) / 2 + 1;
            ctx.font = 'italic 900 26px ' + FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.strokeStyle = 'rgba(0,8,20,0.85)'; ctx.lineWidth = 5; ctx.strokeText(h.names[s], nx, ny);
            ctx.fillStyle = s === h.mine ? '#ffd34a' : '#ffffff'; ctx.fillText(h.names[s], nx, ny);
          }
        } else {
        const path = A.gaugePaths[s], pw = Math.max(0, Math.min(1, h.power[s])), full = pw >= 1;
        ctx.save();
        ctx.clip(path);
        ctx.fillStyle = 'rgba(8,16,30,0.55)'; ctx.fillRect(0, HUD.gaugeY0, W, HUD.gaugeY1 - HUD.gaugeY0);
        if (pw > 0) {
          const xi = HUD.gauge[s].inner, xe = gaugeX(s, pw);
          ctx.fillStyle = full ? G.full[s] : G.gauge[s];
          ctx.fillRect(Math.min(xi, xe), HUD.gaugeY0, Math.abs(xe - xi), HUD.gaugeY1 - HUD.gaugeY0);
          if (full) {
            ctx.globalAlpha = 0.18 + 0.18 * Math.sin(t / 90);
            ctx.fillStyle = '#fff6c0'; ctx.fillRect(0, HUD.gaugeY0, W, HUD.gaugeY1 - HUD.gaugeY0);
            ctx.globalAlpha = 1;
          }
        }
        ctx.restore();
        if (full) { ctx.save(); ctx.shadowColor = '#ffae00'; ctx.shadowBlur = 16 * A.k + 8 * A.k * Math.sin(t / 120); }
        ctx.strokeStyle = '#0d1522'; ctx.lineWidth = 5; ctx.stroke(path);
        ctx.strokeStyle = full ? '#fff1a8' : '#e6ebef'; ctx.lineWidth = 2.4; ctx.stroke(path);
        if (full) ctx.restore();
        // "POWER", on the outer half.
        const px = gaugeX(s, 0.6), py = (HUD.gaugeY0 + HUD.gaugeY1) / 2 + 1;
        ctx.font = 'italic 900 21px ' + FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.strokeStyle = 'rgba(10,16,28,0.85)'; ctx.lineWidth = 4; ctx.strokeText('POWER', px, py);
        ctx.fillStyle = '#ffffff'; ctx.fillText('POWER', px, py);
        // The player's name under the gauge (a DuelSeries addition: the original shows none).
        if (h.names[s]) {
          const nx = (HUD.gauge[s].inner + HUD.gauge[s].outer) / 2;
          ctx.font = '700 16px ' + FONT;
          ctx.strokeStyle = 'rgba(0,8,20,0.8)'; ctx.lineWidth = 4; ctx.strokeText(h.names[s], nx, 96);
          ctx.fillStyle = s === h.mine ? '#ffd34a' : '#ffffff'; ctx.fillText(h.names[s], nx, 96);
        }
        }
        // The score, gold italic under the badge.
        ctx.font = 'italic 900 44px ' + FONT; ctx.textBaseline = 'alphabetic';
        ctx.strokeStyle = '#3a1c00'; ctx.lineWidth = 6.5;
        const sx = HUD.scoreX[s], txt = String(h.score[s]);
        ctx.strokeText(txt, sx, HUD.scoreY1); ctx.fillStyle = G.score; ctx.fillText(txt, sx, HUD.scoreY1);
      }
      // The clock.
      ctx.font = '800 44px ' + FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.strokeStyle = '#111925'; ctx.lineWidth = 7;
      ctx.strokeText(h.clock, HUD.axis, HUD.clockY1 - 3);
      ctx.fillStyle = h.clockWarn ? '#ffe36a' : '#ffffff'; ctx.fillText(h.clock, HUD.axis, HUD.clockY1 - 3);
      if (h.sudden) {
        ctx.globalAlpha = 0.75 + 0.25 * Math.sin(t / 140);
        ctx.font = 'italic 900 20px ' + FONT; ctx.textBaseline = 'middle';
        ctx.strokeStyle = '#2a0a00'; ctx.lineWidth = 5; ctx.strokeText('SUDDEN DEATH', HUD.axis, 104);
        ctx.fillStyle = '#ff6a3a'; ctx.fillText('SUDDEN DEATH', HUD.axis, 104);
        ctx.globalAlpha = 1;
      }
    };

    /* "KICK OFF" (sec 1: yellow outlined lettering with a ball icon above, at match start). Its place on screen is
       CHOSEN: centred over the halfway line, in the stand. */
    A.kickOff = function (ctx, ms) {
      const e = Math.min(1, ms / 220), s = 1 + 0.35 * Math.pow(1 - e, 2);
      ctx.save();
      ctx.translate(W / 2, 290); ctx.scale(s, s); ctx.globalAlpha = e;
      A.ballAt(ctx, 0, -78, ms / 300, 1.45);
      ctx.font = 'italic 900 84px ' + FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 16; ctx.strokeText('KICK OFF', 5, 7);
      ctx.strokeStyle = '#4a2200'; ctx.lineWidth = 14; ctx.strokeText('KICK OFF', 0, 0);
      const gr = ctx.createLinearGradient(0, -34, 0, 34);
      gr.addColorStop(0, '#fff59a'); gr.addColorStop(0.55, '#ffd51a'); gr.addColorStop(1, '#f0a400');
      ctx.fillStyle = gr; ctx.fillText('KICK OFF', 0, 0);
      ctx.restore();
    };

    /* "GOAL!" (sec 1/6): big gold gradient italic, blue-white inner outline, dark drop shadow, about 0.7 W by 0.4 H
       over the centre, letters slamming in one after another. The slam's timing is CHOSEN. */
    A.goalBanner = function (ctx, ms, text) {
      const word = text || 'GOAL!';
      if (!A.goalLetters || A.goalLetters.word !== word) {
        ctx.save();
        ctx.font = 'italic 900 230px ' + FONT;
        const widths = [], letters = word.split('');
        let total = 0;
        for (const ch of letters) { const w = ctx.measureText(ch).width; widths.push(w); total += w; }
        ctx.restore();
        const size = Math.min(230, 230 * (W * 0.7) / total);
        const kk = size / 230;
        const xs = []; let x = W / 2 - total * kk / 2;
        for (const w of widths) { xs.push(x + w * kk / 2); x += w * kk; }
        const gr = ctx.createLinearGradient(0, -size * 0.72, 0, 0);
        gr.addColorStop(0, '#fff8c4'); gr.addColorStop(0.45, '#ffd53a'); gr.addColorStop(0.75, '#f5a000'); gr.addColorStop(1, '#c46a00');
        A.goalLetters = { word, letters, xs, size, grad: gr };
      }
      const GL = A.goalLetters, base = 350 + GL.size * 0.36;
      ctx.save();
      ctx.font = 'italic 900 ' + GL.size.toFixed(1) + 'px ' + FONT;
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.lineJoin = 'round';
      for (let i = 0; i < GL.letters.length; i++) {
        const e = Math.max(0, Math.min(1, (ms - i * 65) / 170));
        if (e <= 0) continue;
        const s = 1 + 2.2 * Math.pow(1 - e, 3), ch = GL.letters[i];
        ctx.save();
        ctx.translate(GL.xs[i], base); ctx.scale(s, s); ctx.globalAlpha = Math.min(1, e * 1.6);
        ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillText(ch, 9, 11);
        ctx.strokeStyle = '#2a1600'; ctx.lineWidth = GL.size * 0.11; ctx.strokeText(ch, 0, 0);
        ctx.strokeStyle = '#e4f3ff'; ctx.lineWidth = GL.size * 0.045; ctx.strokeText(ch, 0, 0);
        ctx.fillStyle = GL.grad; ctx.fillText(ch, 0, 0);
        ctx.restore();
      }
      ctx.restore();
    };

    /* The power shot's cutscene (sec 3: the screen dims with lightning streaks for about 0.9 s). Returns the dim
       level so the page can draw the shooter and the ball again on top, lit. */
    A.powerDim = function (ctx, ms, total) {
      const a = ms < 70 ? ms / 70 : ms > total - 160 ? Math.max(0, (total - ms) / 160) : 1;
      ctx.fillStyle = 'rgba(4,8,22,' + (0.64 * a).toFixed(3) + ')';
      ctx.fillRect(0, 0, W, H);
      return a;
    };
    A.powerBolts = function (ctx, ms, total, tx, ty, now) {
      const a = ms < 70 ? ms / 70 : ms > total - 160 ? Math.max(0, (total - ms) / 160) : 1;
      if (now - A.boltsAt > 70) {                     // new streaks every 70 ms (CHOSEN)
        A.boltsAt = now;
        const B = A.bolts;
        for (let b = 0; b < 3; b++) {
          let x = tx + (b - 1) * 260 + (Math.random() - 0.5) * 120, y = -10;
          for (let i = 0; i < 12; i++) {
            const u = i / 11;
            B[(b * 12 + i) * 2] = x + (tx - x) * u + (i && i < 11 ? (Math.random() - 0.5) * 46 : 0);
            B[(b * 12 + i) * 2 + 1] = y + (ty - y) * u;
          }
        }
      }
      ctx.save();
      ctx.globalAlpha = a; ctx.lineJoin = 'miter'; ctx.lineCap = 'round';
      for (let pass = 0; pass < 2; pass++) {
        ctx.strokeStyle = pass ? '#ffffff' : 'rgba(255,236,120,0.45)';
        ctx.lineWidth = pass ? 3 : 13;
        for (let b = 0; b < 3; b++) {
          ctx.beginPath();
          for (let i = 0; i < 12; i++) {
            const x = A.bolts[(b * 12 + i) * 2], y = A.bolts[(b * 12 + i) * 2 + 1];
            if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
          }
          ctx.stroke();
        }
      }
      if (ms < 110) { ctx.globalAlpha = 0.55 * (1 - ms / 110); ctx.fillStyle = '#fffbe0'; ctx.fillRect(0, 0, W, H); }
      ctx.restore();
    };

    /* A sentence in the empty space under a portrait pitch. In CSS pixels. */
    A.note = function (ctx, text, x, y, size) {
      ctx.font = '600 ' + size + 'px ' + FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(200,220,245,0.55)'; ctx.fillText(text, x, y);
    };

    /* The phone buttons, cached per size; drawn in CSS pixels. */
    A.button = function (ctx, kind, r, pressed, dpr, alpha) {
      const key = kind + (pressed ? 1 : 0);
      let c = A.btn[key];
      if (!c || c._w !== r.w || c._h !== r.h || c._d !== dpr) {
        c = paintButton(kind, r.w, r.h, dpr, pressed);
        c._w = r.w; c._h = r.h; c._d = dpr;
        A.btn[key] = c;
      }
      ctx.globalAlpha = alpha;
      ctx.drawImage(c, r.x, r.y, r.w, r.h);
      ctx.globalAlpha = 1;
    };

    return A;
  }

  root.HSArt = { create, W, H, HUD, LOOKS };
})(window);
