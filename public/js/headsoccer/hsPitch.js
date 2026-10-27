'use strict';
/* ─── Head Soccer, the pitch and the goals ───────────────────────────────────
   The sunken pitch between its two raised grass shelves, its chalk, the lawn
   in front, and the goals (nets, posts, crossbars) with the floodlight towers
   that stand behind them. World units (shared/hsSim.js), on a context the
   caller has transformed; hsArt.js caches them. The back of each goal is drawn
   behind the players, the front over them.

   THE LOOK IS HEADS ARENA EURO SOCCER'S, PAINTED OUR OWN WAY: positions,
   sizes and colours measured from the reference (docs/head-soccer-reference.md),
   no image of theirs used. */
(function (root) {
  const HS = root.HSSim.HS;
  const TAU = Math.PI * 2;

  const PITCH = { far: 1415, near: 1593, front: 1649, farHalf: 941, nearHalf: 1038 };
  const SHELF = { far: 1120, near: 1235, edge: 1249, front: 1638 };
  const LINES = { back: [1426, 8, 888], front: [1565, 11, 980], circle: [0, 1491, 278, 49], spot: [0, 1489, 18, 7] };
  const C = {
    roofA: '#acb8d3', roofB: '#8b9abb', strut: '#677a9e', stand: '#acb8d3', standDark: '#8b9abb', stair: '#7b8aac', stairLit: '#96a6c5',
    slate: '#677a9e', slateDark: '#48597a', slateDeep: '#3f4f6c', slateLit: '#8b9abb', slateSoft: '#8fa0a6',
    pitch: '#93c47a', pitchLit: '#a3ce8e', pitchMid: '#96c280', face: '#80b366', side: '#76a75d', lawn: '#8bbc72',
    chalk: '#fcfff7', post: '#fcfff7', postShade: '#dee4db', net: 'rgba(250,253,245,0.78)', glass: '#dbf3fd', glass2: '#b6def4',
    plate: '#465778', plateIn: '#3f4f6c', plateRim: '#677a9e', plateEdge: '#8b9abb', plateCap: '#7b98c0',
    key: '#0155dd', keyDark: '#0548ab', keyLit: '#0e64e9', pause: '#60a241', pauseLit: '#7acc53', pauseDark: '#2f6c14', cream: '#ffeddf',
    ink: '#342d2f', outline: '#24314f',
  };

  let VW = HS.VIEW_W_REF;                        // visible world width (set per resize)
  function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  function rr(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  function poly(g, pts, fill) { g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]); g.closePath(); if (fill) { g.fillStyle = fill; g.fill(); } }

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

  root.HSPitch = {
    setView(vw) { VW = vw; },
    field: paintField,
    goalsBack: (g) => bothGoals(g, paintGoalBack), goalsFront: (g) => bothGoals(g, paintGoalFront),
  };
})(window);
