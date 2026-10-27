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
  const Sim = root.HSSim, HS = Sim.HS;
  const FONT = 'Archivo, "Arial Black", "Segoe UI", Arial, sans-serif';
  const TAU = Math.PI * 2;

  /* The measured layout (doc "The look"), world units. */
  const SKY = [[-200, '#72a0da'], [40, '#84aee3'], [230, '#98beec'], [340, '#a0c3ef'], [530, '#adcdf5'], [640, '#b2d1f6'], [913, '#b8d5f8']];
  const CLOUD = { top: 351, body: '#b6def4', lit: '#bae0ff', tile: 4389, speed: 0.2 / 0.45 * 60 };  // S: tilePosition.x += .2 a frame
  const ROOF = { y0: 548, k: 4.5e-5, bandA: 66, bandB: 102 };       // arch: 548 at the middle, 568 at 667, 725 at 2001
  const BOARD = { x0: -324, x1: 324, y0: 63, y1: 368, posts: [[-245, -203], [203, 245]], digitRight: [-163, -40, 130, 253], digitY: 230 };
  const CROWD = { y0: 684, y1: 1196 };                              // S: Crowd sprite from 684; its people end over the wall
  const WALL = [[1245, '#bec8dd'], [1263, '#acb8d3'], [1370, '#76a75d'], [1440, null]];  // the stand's front (measured)
  const PITCH = { far: 1415, near: 1593, front: 1649, farHalf: 941, nearHalf: 1038 };
  const SHELF = { far: 1120, near: 1235, edge: 1249, front: 1638 };
  const LINES = { back: [1426, 8, 888], front: [1565, 11, 980], circle: [0, 1491, 278, 49], spot: [0, 1489, 18, 7] };
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
  let kits = [null, null];

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

  /* ── the sky and the clouds ────────────────────────────────────────────── */
  function paintSky(g) {
    const gr = g.createLinearGradient(0, SKY[0][0], 0, SKY[SKY.length - 1][0]);
    for (const [y, c] of SKY) gr.addColorStop((y - SKY[0][0]) / (SKY[SKY.length - 1][0] - SKY[0][0]), c);
    g.fillStyle = gr; g.fillRect(-VW / 2, 0, VW, HS.VIEW_H);
  }
  // One seamless strip of cloud, CLOUD.tile wide, scrolled at the reference's speed.
  function paintClouds() {
    const T = CLOUD.tile, c = canvas(T * K, 1000 * K), g = c.getContext('2d');
    g.setTransform(K, 0, 0, K, 0, 0);
    const r = rng(7), puffs = [];
    for (let x = 0; x < T; x += 70 + r() * 90) puffs.push([x, CLOUD.top + 20 + r() * 110, 50 + r() * 90]);
    for (const off of [-T, 0, T]) {
      g.fillStyle = CLOUD.body;
      for (const [x, y, rad] of puffs) { g.beginPath(); g.arc(x + off, y + rad * 0.6, rad, 0, TAU); g.fill(); }
      g.fillRect(off, CLOUD.top + 150, T, 900);
      g.fillStyle = CLOUD.lit;
      for (const [x, y, rad] of puffs) { g.beginPath(); g.arc(x + off - rad * 0.15, y + rad * 0.45, rad * 0.55, Math.PI * 1.05, Math.PI * 1.75); g.lineTo(x + off, y + rad * 0.6); g.fill(); }
    }
    return c;
  }

  /* ── the stands: roof, bowl, aisles, board, then the crowd ─────────────── */
  function paintTribune(g) {
    const x0 = -VW / 2, x1 = VW / 2, step = 40;
    // The bowl under the roof, down behind the pitch.
    g.beginPath(); g.moveTo(x0, roofY(x0)); for (let x = x0; x <= x1; x += step) g.lineTo(x, roofY(x));
    g.lineTo(x1, PITCH.far + 60); g.lineTo(x0, PITCH.far + 60); g.closePath();
    const bowl = g.createLinearGradient(0, ROOF.y0, 0, PITCH.far);
    bowl.addColorStop(0, C.standDark); bowl.addColorStop(0.25, C.stand); bowl.addColorStop(1, C.stand);
    g.fillStyle = bowl; g.fill();
    // Aisles of stairs (measured near x -667, mirrored).
    for (const ax of [-667, 667]) {
      const top = roofY(ax) + ROOF.bandA + ROOF.bandB;
      g.fillStyle = C.stair; g.fillRect(ax - 42, top, 84, PITCH.far - top);
      g.fillStyle = C.stairLit;
      for (let y = top + 10; y < PITCH.far; y += 31) g.fillRect(ax - 42, y, 84, 9);
    }
    // The roof: a light rim, a darker band with its struts.
    g.beginPath(); for (let x = x0; x <= x1; x += step) g.lineTo(x, roofY(x));
    for (let x = x1; x >= x0; x -= step) g.lineTo(x, roofY(x) + ROOF.bandA);
    g.closePath(); g.fillStyle = C.roofA; g.fill();
    g.beginPath(); for (let x = x0; x <= x1; x += step) g.lineTo(x, roofY(x) + ROOF.bandA);
    for (let x = x1; x >= x0; x -= step) g.lineTo(x, roofY(x) + ROOF.bandA + ROOF.bandB);
    g.closePath(); g.fillStyle = C.roofB; g.fill();
    g.strokeStyle = C.strut; g.lineWidth = 12;
    for (let x = Math.ceil(x0 / 330) * 330; x <= x1; x += 330) {
      const lean = x === 0 ? 0 : Math.sign(x) * 40;
      g.beginPath(); g.moveTo(x, roofY(x) + ROOF.bandA); g.lineTo(x + lean, roofY(x) + ROOF.bandA + ROOF.bandB); g.stroke();
    }
    g.lineWidth = 6; g.beginPath(); for (let x = x0; x <= x1; x += step) g.lineTo(x, roofY(x) + 3); g.stroke();
    g.beginPath(); for (let x = x0; x <= x1; x += step) g.lineTo(x, roofY(x) + ROOF.bandA); g.stroke();
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

  // The crowd: rows of fans, three frames that the page cycles (S: Crowd frames, 1 s a frame, 0.1 s after a goal).
  const SKIN = ['#f1c7a1', '#e0ad84', '#c48b62', '#9a6544', '#6e472f'];
  const HAIR = ['#2b2018', '#5a3b22', '#a8742f', '#1c1c1c', '#d8b35a', '#7d4a2a', '#c9c3b8'];
  const SHIRT = ['#b9574e', '#5d78ad', '#d8d2c3', '#cfa64e', '#6d9161', '#8a6f9c', '#c2834e', '#646474', '#4f8aa3', '#9c5a6b', '#7a5a44', '#a7a29a'];
  let fans = null;
  function makeFans() {
    const r = rng(11), out = [];
    for (let y = CROWD.y0 + 40, row = 0; y < CROWD.y1; y += 44, row++) {
      const shade = 0.72 + 0.28 * (y - CROWD.y0) / (CROWD.y1 - CROWD.y0);
      for (let x = -HS.VIEW_W_MAX / 2 + (row % 2) * 23; x < HS.VIEW_W_MAX / 2 + 40; x += 40 + r() * 14) {
        if (Math.abs(Math.abs(x) - 667) < 46) continue;            // the aisles stay clear
        out.push({ x, y: y + r() * 6, s: shade, skin: SKIN[(r() * SKIN.length) | 0], hair: HAIR[(r() * HAIR.length) | 0],
                   shirt: SHIRT[(r() * SHIRT.length) | 0], ph: (r() * 3) | 0, arms: r() < 0.22, w: 0.9 + r() * 0.25 });
      }
    }
    return out;
  }
  function dim(hex, f) {
    const n = parseInt(hex.slice(1), 16);
    const ch = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
    return 'rgb(' + ch(n >> 16) + ',' + ch((n >> 8) & 255) + ',' + ch(n & 255) + ')';
  }
  function paintCrowd(g, frame) {
    if (!fans) fans = makeFans();
    for (const f of fans) {
      if (f.x < -VW / 2 - 40 || f.x > VW / 2 + 40) continue;
      const up = f.ph === frame ? -7 : 0, w = 19 * f.w;
      g.fillStyle = dim(f.shirt, f.s);
      rr(g, f.x - w, f.y + up + 6, w * 2, 44, 12); g.fill();
      if (f.arms && f.ph === frame) {
        g.strokeStyle = dim(f.skin, f.s); g.lineWidth = 8; g.lineCap = 'round';
        g.beginPath(); g.moveTo(f.x - w + 4, f.y + up + 14); g.lineTo(f.x - w - 6, f.y + up - 26);
        g.moveTo(f.x + w - 4, f.y + up + 14); g.lineTo(f.x + w + 6, f.y + up - 26); g.stroke();
      }
      g.fillStyle = dim(f.skin, f.s); g.beginPath(); g.arc(f.x, f.y + up - 6, 15, 0, TAU); g.fill();
      g.fillStyle = dim(f.hair, f.s); g.beginPath(); g.arc(f.x, f.y + up - 10, 15, Math.PI * 1.05, Math.PI * 1.95); g.fill();
    }
    // The stand's front wall under the fans, and the grass behind the pitch.
    for (let i = 0; i < WALL.length - 1; i++) { g.fillStyle = WALL[i][1]; g.fillRect(-VW / 2, WALL[i][0], VW, WALL[i + 1][0] - WALL[i][0]); }
  }

  /* ── the pitch, the shelves, the lawn, the lines ───────────────────────── */
  function paintField(g) {
    const x0 = -VW / 2, x1 = VW / 2;
    // The lawn in front, with its fanned stripes.
    g.fillStyle = C.lawn; g.fillRect(x0, SHELF.front - 4, VW, HS.VIEW_H - SHELF.front + 8);
    g.fillStyle = C.pitch;
    for (let i = -12; i <= 12; i += 2) {
      const a = i * 200, b = (i + 1) * 200;
      poly(g, [[a, SHELF.front], [b, SHELF.front], [b * 1.35, HS.VIEW_H], [a * 1.35, HS.VIEW_H]]);
      g.globalAlpha = 0.55; g.fill(); g.globalAlpha = 1;
    }
    // The sunken pitch: top face with stripes, its front face.
    poly(g, [[-PITCH.farHalf - 40, PITCH.far], [PITCH.farHalf + 40, PITCH.far], [PITCH.nearHalf + 40, PITCH.near], [-PITCH.nearHalf - 40, PITCH.near]], C.pitch);
    const bands = [C.pitchLit, C.pitch, C.pitchMid, C.pitch];
    for (let i = -6; i < 6; i++) {
      const fa = i * 170, fb = (i + 1) * 170, na = fa * PITCH.nearHalf / PITCH.farHalf, nb = fb * PITCH.nearHalf / PITCH.farHalf;
      poly(g, [[fa, PITCH.far], [fb, PITCH.far], [nb, PITCH.near], [na, PITCH.near]], bands[(i + 12) % 4]);
    }
    poly(g, [[-PITCH.nearHalf - 40, PITCH.near], [PITCH.nearHalf + 40, PITCH.near], [PITCH.nearHalf + 40, PITCH.front], [-PITCH.nearHalf - 40, PITCH.front]], C.face);
    // The chalk (measured: back line y 1422..1430, front 1560..1571, the centre ellipse and spot).
    g.strokeStyle = C.chalk; g.lineCap = 'round';
    g.lineWidth = LINES.back[1]; g.beginPath(); g.moveTo(-LINES.back[2], LINES.back[0]); g.lineTo(LINES.back[2], LINES.back[0]); g.stroke();
    g.lineWidth = LINES.front[1]; g.beginPath(); g.moveTo(-LINES.front[2], LINES.front[0]); g.lineTo(LINES.front[2], LINES.front[0]); g.stroke();
    g.lineWidth = 9; g.beginPath(); g.ellipse(LINES.circle[0], LINES.circle[1], LINES.circle[2], LINES.circle[3], 0, 0, TAU); g.stroke();
    g.fillStyle = C.chalk; g.beginPath(); g.ellipse(LINES.spot[0], LINES.spot[1], LINES.spot[2], LINES.spot[3], 0, 0, TAU); g.fill();
    // The two raised shelves under the goals.
    for (const s of [-1, 1]) {
      g.save(); g.scale(s, 1);
      poly(g, [[-x1 - 10, SHELF.far], [-PITCH.farHalf, SHELF.far], [-PITCH.nearHalf, SHELF.near], [-x1 - 10, SHELF.near]], C.pitchLit);
      for (let i = 0; i < 8; i++) {
        const a = -PITCH.farHalf - 260 - i * 350;
        poly(g, [[a, SHELF.far], [a - 175, SHELF.far], [a - 175 - 97, SHELF.near], [a - 97, SHELF.near]], i % 2 ? C.pitch : C.pitchMid);
      }
      poly(g, [[-x1 - 10, SHELF.near], [-PITCH.nearHalf, SHELF.near], [-PITCH.nearHalf, SHELF.edge], [-x1 - 10, SHELF.edge]], C.pitchMid);
      poly(g, [[-x1 - 10, SHELF.edge], [-PITCH.nearHalf, SHELF.edge], [-PITCH.nearHalf, SHELF.front], [-x1 - 10, SHELF.front]], C.face);
      poly(g, [[-PITCH.farHalf, SHELF.far], [-PITCH.farHalf, PITCH.far], [-PITCH.nearHalf, PITCH.near], [-PITCH.nearHalf, SHELF.edge]], C.side);
      // Tufts along the top edges.
      g.fillStyle = C.pitchLit;
      for (let x = -x1; x < -PITCH.farHalf; x += 95) { poly(g, [[x, SHELF.far + 2], [x + 14, SHELF.far - 18], [x + 26, SHELF.far + 2]]); g.fill(); }
      g.restore();
    }
    g.fillStyle = C.pitchMid;
    for (let x = -PITCH.farHalf + 40; x < PITCH.farHalf - 20; x += 120) { poly(g, [[x, PITCH.far + 2], [x + 10, PITCH.far - 14], [x + 20, PITCH.far + 2]]); g.fill(); }
  }

  /* ── the goals: back half (behind the players) and front half (over them) ── */
  // The right goal, in world units; the left one is the mirror. Measured: front post 1084..1120 from 788 to 1237,
  // back post 988..1022 from 752 to 1136, the tower 1130..1290 from 3 to 730, the pole 1277..1308 to 1259.
  function netMesh(g, pts, step) {
    g.save(); poly(g, pts); g.clip();
    g.strokeStyle = C.net; g.lineWidth = 3;
    let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
    for (const [x, y] of pts) { mnx = Math.min(mnx, x); mxx = Math.max(mxx, x); mny = Math.min(mny, y); mxy = Math.max(mxy, y); }
    const h = step * 0.866;
    for (let y = mny, r = 0; y < mxy + h; y += h, r++) {
      for (let x = mnx - step + (r % 2) * step / 2; x < mxx + step; x += step) {
        g.beginPath();
        for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3 + Math.PI / 6; g.lineTo(x + Math.cos(a) * step * 0.34, y + Math.sin(a) * step * 0.34); }
        g.closePath(); g.stroke();
      }
    }
    g.restore();
  }
  function paintGoalBack(g) {
    // The floodlight tower.
    g.fillStyle = C.slateDark; rr(g, 1130, 3, 160, 727, 10); g.fill();
    g.fillStyle = C.slate; rr(g, 1138, 9, 144, 106, 8); g.fill();
    g.fillStyle = C.chalk; g.beginPath(); g.arc(1210, 60, 36, 0, TAU); g.fill();
    g.fillStyle = C.slateDark;
    for (let k = 0; k < 5; k++) { const a = -Math.PI / 2 + k * TAU / 5; g.beginPath(); g.arc(1210 + Math.cos(a) * 24, 60 + Math.sin(a) * 24, 9, 0, TAU); g.fill(); }
    g.beginPath(); g.arc(1210, 60, 11, 0, TAU); g.fill();
    g.fillStyle = C.glass; g.fillRect(1150, 120, 120, 530);
    g.fillStyle = C.glass2;
    for (let k = 0; k < 6; k++) { poly(g, [[1150, 200 + k * 90], [1270, 120 + k * 90], [1270, 150 + k * 90], [1150, 230 + k * 90]]); g.globalAlpha = 0.6; g.fill(); g.globalAlpha = 1; }
    g.fillStyle = C.slate; g.fillRect(1138, 650, 144, 70);
    g.fillStyle = C.slateDark; for (let y = 150; y < 640; y += 70) { rr(g, 1137, y, 14, 22, 4); g.fill(); }
    // The back of the goal: the net's back and roof, the back post.
    netMesh(g, [[1005, 752], [1214, 752], [1214, 1182], [1005, 1182]], 34);
    netMesh(g, [[1005, 752], [1214, 752], [1270, 790], [1100, 790]], 34);
    g.fillStyle = C.post; g.fillRect(988, 752, 34, 384);
    g.fillStyle = C.postShade; g.fillRect(1010, 752, 12, 384);
    g.fillStyle = C.post; poly(g, [[988, 744], [1150, 744], [1150, 760], [988, 760]]); g.fill();
  }
  function paintGoalFront(g) {
    netMesh(g, [[1100, 790], [1290, 790], [1340, 1236], [1100, 1236]], 34);
    // The front frame: post, crossbar (it slopes like the physics bar), base.
    g.fillStyle = C.post; poly(g, [[1084, 772], [1300, 772], [1300, 806], [1084, 806]]); g.fill();
    g.fillStyle = C.post; g.fillRect(1084, 788, 36, 449);
    g.fillStyle = C.postShade; g.fillRect(1108, 788, 12, 449);
    g.fillStyle = C.post; poly(g, [[1100, 1211], [1350, 1222], [1350, 1240], [1100, 1236]]); g.fill();
    // The pole down to the grass.
    g.fillStyle = C.slateSoft; g.fillRect(1277, 0, 7, 1259);
    g.fillStyle = C.slate; g.fillRect(1284, 0, 13, 1259);
    g.fillStyle = C.slateDark; g.fillRect(1297, 0, 11, 1259);
  }
  function bothGoals(g, paint) { paint(g); g.save(); g.scale(-1, 1); paint(g); g.restore(); }

  /* ── the ball ───────────────────────────────────────────────────────────── */
  const BALL_R = 51.1;                               // S: drawn at ball-front 92 px x .5 / .45, a little over the body
  function paintBall(golden) {
    const R = BALL_R, c = canvas(2 * (R + 4) * K, 2 * (R + 4) * K), g = c.getContext('2d');
    g.setTransform(K, 0, 0, K, (R + 4) * K, (R + 4) * K);
    const base = golden ? '#f6cf55' : '#fcfef7', patch = golden ? '#b8862b' : C.ink;
    g.fillStyle = base; g.beginPath(); g.arc(0, 0, R, 0, TAU); g.fill();
    g.save(); g.beginPath(); g.arc(0, 0, R, 0, TAU); g.clip();
    g.fillStyle = patch;
    const pent = (cx, cy, r, rot) => { g.beginPath(); for (let k = 0; k < 5; k++) { const a = rot + k * TAU / 5; g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); } g.closePath(); g.fill(); };
    pent(0, 0, R * 0.34, -Math.PI / 2);
    for (let k = 0; k < 5; k++) { const a = -Math.PI / 2 + k * TAU / 5 + TAU / 10; pent(Math.cos(a) * R * 0.92, Math.sin(a) * R * 0.92, R * 0.3, a); }
    g.strokeStyle = patch; g.lineWidth = 3;
    for (let k = 0; k < 5; k++) { const a = -Math.PI / 2 + k * TAU / 5; g.beginPath(); g.moveTo(Math.cos(a) * R * 0.34, Math.sin(a) * R * 0.34); g.lineTo(Math.cos(a) * R * 0.66, Math.sin(a) * R * 0.66); g.stroke(); }
    const sh = g.createRadialGradient(-R * 0.35, -R * 0.4, R * 0.1, 0, 0, R);
    sh.addColorStop(0, 'rgba(255,255,255,0.35)'); sh.addColorStop(0.7, 'rgba(255,255,255,0)'); sh.addColorStop(1, 'rgba(40,40,60,0.28)');
    g.fillStyle = sh; g.fillRect(-R, -R, 2 * R, 2 * R);
    g.restore();
    g.strokeStyle = C.ink; g.lineWidth = 5; g.beginPath(); g.arc(0, 0, R - 1.5, 0, TAU); g.stroke();
    return c;
  }

  /* ── the players: a big head, two floating hands, two boots ───────────────
     Placed as the reference places its parts around the body centre (S: Player
     _headRelativePosition, _leftShoe/_rightShoe..., _leftArm/_rightArm, all x .5):
     head centred 55 below with its image from -102 to +94, boots at (32.5, 130)
     and (-22.5, 130), hands at (87.5, 85) and (-97.5, 85), mirrored by facing.
     The faces are ours: two cartoon footballers, nobody real. */
  const LOOK = [
    { skin: '#f0c49b', shade: '#d9a67c', hair: '#3a281c', kit: '#e0393b', boot: '#1d1f2b', style: 'quiff' },
    { skin: '#b97c55', shade: '#9a603c', hair: '#151515', kit: '#2f6fe0', boot: '#f2f2f2', style: 'curls' },
  ];
  function kitOf(side) { return kits[side] || LOOK[side].kit; }
  function drawHead(g, side, lookRight, blink, mood) {
    const Lk = LOOK[side];
    g.save(); if (!lookRight) g.scale(-1, 1);
    // Head shape: a big rounded block, chin to the front.
    g.fillStyle = Lk.skin; g.strokeStyle = C.outline; g.lineWidth = 6;
    g.beginPath();
    g.moveTo(-60, -60); g.bezierCurveTo(-72, -96, 40, -110, 66, -62);
    g.bezierCurveTo(84, -20, 80, 40, 58, 72); g.bezierCurveTo(36, 98, -36, 98, -56, 66);
    g.bezierCurveTo(-78, 30, -76, -20, -60, -60); g.closePath(); g.fill(); g.stroke();
    // Ear.
    g.fillStyle = Lk.shade; g.beginPath(); g.ellipse(-50, 6, 14, 20, 0, 0, TAU); g.fill(); g.stroke();
    // Hair.
    g.fillStyle = Lk.hair; g.beginPath();
    if (Lk.style === 'quiff') {
      g.moveTo(-64, -40); g.bezierCurveTo(-82, -96, -10, -128, 40, -110); g.bezierCurveTo(80, -100, 84, -70, 70, -54);
      g.bezierCurveTo(40, -70, 0, -66, -30, -58); g.bezierCurveTo(-40, -40, -50, -26, -64, -16); g.closePath();
    } else {
      for (let k = 0; k < 9; k++) { const a = Math.PI * (1.02 + k * 0.12); g.moveTo(Math.cos(a) * 66 + 4, Math.sin(a) * 72 - 34); g.arc(Math.cos(a) * 66 + 4, Math.sin(a) * 72 - 34, 24, 0, TAU); }
    }
    g.fill();
    // Face: brow, eye, nose, mouth (facing right).
    g.fillStyle = C.outline;
    g.beginPath(); g.moveTo(14, -30); g.lineTo(52, -38); g.lineTo(54, -28); g.lineTo(16, -21); g.closePath(); g.fill();
    if (blink) { g.lineWidth = 6; g.beginPath(); g.moveTo(22, -6); g.lineTo(48, -6); g.stroke(); }
    else {
      g.fillStyle = '#fff'; g.beginPath(); g.ellipse(36, -6, 15, 18, 0, 0, TAU); g.fill();
      g.fillStyle = C.outline; g.beginPath(); g.arc(42, -4, 8, 0, TAU); g.fill();
    }
    g.fillStyle = Lk.shade; g.beginPath(); g.moveTo(66, 4); g.quadraticCurveTo(86, 22, 64, 30); g.closePath(); g.fill();
    g.strokeStyle = C.outline; g.lineWidth = 6; g.beginPath();
    if (mood > 0) { g.moveTo(26, 46); g.quadraticCurveTo(46, 64, 64, 44); }
    else if (mood < 0) { g.moveTo(28, 58); g.quadraticCurveTo(46, 44, 62, 56); }
    else { g.moveTo(30, 50); g.quadraticCurveTo(46, 58, 62, 48); }
    g.stroke();
    // Headband in the kit colour.
    g.fillStyle = kitOf(side); g.beginPath(); g.moveTo(-70, -30); g.bezierCurveTo(-20, -50, 40, -54, 76, -40); g.lineTo(78, -26); g.bezierCurveTo(40, -40, -20, -36, -72, -14); g.closePath(); g.fill();
    g.restore();
  }
  function drawHand(g, side, x, y, a) {
    g.fillStyle = LOOK[side].skin; g.strokeStyle = C.outline; g.lineWidth = 5;
    g.beginPath(); g.ellipse(x, y, 30, 26, 0, 0, TAU); g.fill(); g.stroke();
    g.fillStyle = kitOf(side); g.beginPath(); g.ellipse(x - 22 * a, y + 6, 10, 18, 0.3 * a, 0, TAU); g.fill(); g.stroke();
  }
  function drawBoot(g, side, x, y, a, ang, sc) {
    g.save(); g.translate(x, y); g.rotate(ang * a); g.scale(a * sc, sc);
    g.fillStyle = LOOK[side].boot; g.strokeStyle = C.outline; g.lineWidth = 5;
    g.beginPath(); g.moveTo(-30, -20); g.lineTo(6, -22); g.bezierCurveTo(30, -18, 42, 0, 40, 14); g.lineTo(-34, 16); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = kitOf(side); g.fillRect(-26, -4, 50, 8);
    g.fillStyle = C.outline; g.fillRect(-34, 12, 76, 8);
    g.restore();
  }
  /* p: { x, y, left, ground, mv }; st: the page's per-player animation state; ball: where to look. */
  function player(g, p, st, ballX, now) {
    const side = p.side, a = p.left ? -1 : 1, x = p.x, y = p.y;
    const running = p.mv && p.ground && !(st.kickMs >= 0 && st.kickMs < HS.KICK_MS);
    // S: _updateRunAnimation: the boots circle at steps / 3 a step, 30 across and 15 up (x .5).
    const s = st.run, rx = running ? Math.sin(s / 3) * 30 : 0, ry = running ? -Math.cos(s / 3) * 15 : 0;
    const lx = running ? Math.sin(s / 3 + Math.PI) * 30 : 0, ly = running ? -Math.cos(s / 3 + Math.PI) * 15 : 0;
    const air = !p.ground;
    // The kick: the back boot jumps to the ball (or out front) and eases home over 200 ms, 1.5x and turned 60 deg.
    let kx = -22.5 + rx, ky = 130 + ry, ksc = 1, kang = air ? 50 * Math.PI / 180 : 0;
    if (st.kickMs >= 0 && st.kickMs < HS.KICK_MS) {
      const u = st.kickMs / HS.KICK_MS, e = 1 - (1 - u) * (1 - u);      // Quadratic.Out
      const tx = st.kdx * a, ty = st.kdy;
      kx = tx + (-22.5 - tx) * e; ky = ty + (130 - ty) * e; ksc = 1.5 - 0.5 * e; kang = (60 - 60 * e) * Math.PI / 180;
    }
    drawHand(g, side, x - 97.5 * a, y + 85, a);
    drawBoot(g, side, x + (32.5 + lx) * a, y + 130 + ly, a, air ? 47 * Math.PI / 180 : 0, 1);
    g.save(); g.translate(x, y - 4); drawHead(g, side, ballX >= x, st.blink, st.mood); g.restore();       // image -102..+94
    drawBoot(g, side, x + kx * a, y + ky, a, kang, ksc);
    drawHand(g, side, x + 87.5 * a, y + 85, a);
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
    L.sky = layer(paintSky);
    L.clouds = paintClouds();
    L.stands = [0, 1, 2].map((f) => layer((g) => { paintTribune(g); paintCrowd(g, f); }));
    L.field = layer((g) => { paintField(g); bothGoals(g, paintGoalBack); });
    L.front = layer((g) => bothGoals(g, paintGoalFront));
    L.ball = paintBall(false); L.gold = paintBall(true);
    L.plate = paintPlate(); L.pause = paintPause(); L.keys = paintKeys();
    art.bg = true;
  }
  function blitLayer(ctx, c) { ctx.drawImage(c, -VW / 2, 0, VW, HS.VIEW_H); }
  let crowdFrame = 0, crowdAt = 0;
  // fast: the crowd's quick tempo after a goal (S: setTempo(100) for 4 s, else 1000 ms a frame).
  function field(ctx, now, fast) {
    blitLayer(ctx, L.sky);
    const T = CLOUD.tile, off = ((now / 1000 * CLOUD.speed) % T + T) % T;
    for (let x = -VW / 2 - T + off; x < VW / 2; x += T) ctx.drawImage(L.clouds, x, 0, T, 1000);
    if (now - crowdAt > (fast ? 100 : 1000)) { crowdAt = now; crowdFrame = (crowdFrame + 1) % 3; }
    blitLayer(ctx, L.stands[crowdFrame]);
    blitLayer(ctx, L.field);
  }
  function goalFronts(ctx) { blitLayer(ctx, L.front); }
  function ballAt(ctx, x, y, rot, golden) {
    const c = golden ? L.gold : L.ball, R = BALL_R + 4;
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.drawImage(c, -R, -R, 2 * R, 2 * R); ctx.restore();
  }
  function setKits(cols) { kits = [cols && cols[0] || null, cols && cols[1] || null]; }

  const art = { bg: false, build, field, goalFronts, ballAt, player, hudDraw, countText, goalFlash, flashText, youMark,
                button, note, setKits, pauseAt: PAUSE_AT, viewW: () => VW };
  root.HSArt = { create: () => art };
})(window);
