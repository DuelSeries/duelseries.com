'use strict';
/* ─── Head Soccer, the players and the ball ──────────────────────────────────
   Drawn in world units on a context the caller has transformed. The players
   are our own cartoon footballers (nobody real) built the way the reference
   builds its own: a big head, two floating hands, two boots, placed around the
   body centre where its code places them (docs/head-soccer-reference.md). */
(function (root) {
  const HS = root.HSSim.HS;
  const TAU = Math.PI * 2;
  const C = {
    roofA: '#acb8d3', roofB: '#8b9abb', strut: '#677a9e', stand: '#acb8d3', standDark: '#8b9abb', stair: '#7b8aac', stairLit: '#96a6c5',
    slate: '#677a9e', slateDark: '#48597a', slateDeep: '#3f4f6c', slateLit: '#8b9abb', slateSoft: '#8fa0a6',
    pitch: '#93c47a', pitchLit: '#a3ce8e', pitchMid: '#96c280', face: '#80b366', side: '#76a75d', lawn: '#8bbc72',
    chalk: '#fcfff7', post: '#fcfff7', postShade: '#dee4db', net: 'rgba(250,253,245,0.78)', glass: '#dbf3fd', glass2: '#b6def4',
    plate: '#465778', plateIn: '#3f4f6c', plateRim: '#677a9e', plateEdge: '#8b9abb', plateCap: '#7b98c0',
    key: '#0155dd', keyDark: '#0548ab', keyLit: '#0e64e9', pause: '#60a241', pauseLit: '#7acc53', pauseDark: '#2f6c14', cream: '#ffeddf',
    ink: '#342d2f', outline: '#24314f',
  };
  let kits = [null, null];

  /* ── the ball ───────────────────────────────────────────────────────────── */
  const BALL_R = 51.1;                               // S: drawn at ball-front 92 px x .5 / .45, a little over the body
  // The ball centred on the origin, radius BALL_R (hsArt.js caches it).
  function paintBall(g, golden) {
    const R = BALL_R;
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

  root.HSChars = {
    player, ball: paintBall, BALL_R,
    setKits(cols) { kits = [cols && cols[0] || null, cols && cols[1] || null]; },
  };
})(window);
