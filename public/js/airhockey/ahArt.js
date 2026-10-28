'use strict';
/* ─── Air Hockey: the table, the mallets, the puck ────────────────────────────
   Everything here draws in WORLD units (shared/ahSim.js: the surface is 600 x
   1000, y down); the page sets one transform that fits the table to the screen
   and turns it 180 degrees for the top seat, so each player sees their own goal
   at the bottom. The table's markings are the same both ways up, so the one
   painted table serves both seats.

   THREE LOOKS, all ours (no downloaded art): 'arcade' a white arcade table
   with air holes, red and blue markings and a lit rail; 'house' DuelSeries'
   own dark table with gold markings and brass rails; 'rink' a dark ice rink
   with glowing lines. The page picks one (?look= for the judge panel); the
   numbers that differ are in LOOKS.

   The table is painted once per size into an offscreen canvas (build), and
   the moving parts are drawn every frame on top. Roles, not seats: 'me' is
   the mallet at the bottom of this screen. */
(function (root) {
  const Sim = root.AHSim, AH = Sim.AH;
  const W = AH.W, H = AH.H, RAIL = 34, PAD = 26;
  const TX0 = -RAIL - PAD, TY0 = -RAIL - PAD, TW = W + 2 * (RAIL + PAD), TH = H + 2 * (RAIL + PAD);
  const PI2 = Math.PI * 2;

  const LOOKS = {
    arcade: {
      name: 'Arcade',
      bg: '#0c1320',
      surface: ['#f4f9fd', '#d7e6f2'], holes: 'rgba(70,98,124,0.30)', holeStep: 20,
      line: '#e2343b', crease: '#2c6cd6', lineW: 5, glowLines: 0,
      rail: ['#05080d', '#1c2532', '#05080d'], railEdge: '#9fb3c8', railGlow: '#4ea6f0', railGlowA: 0.85,
      pocket: '#020306',
      me: { body: '#2f8cf0', rim: '#165fb8', top: '#8fc8ff', glow: '#4ea6f0' },
      them: { body: '#ec3b46', rim: '#a51d27', top: '#ff9aa0', glow: '#ff4d5e' },
      puck: { body: '#ffc93a', rim: '#d9971a', top: '#fff0b8', glow: '#ffd23f' },
      trail: 'rgba(255,190,40,', ring: '#ffffff', neon: false,
    },
    house: {
      name: 'DuelSeries',
      bg: '#100e0b',
      surface: ['#1d1812', '#110e0a'], holes: 'rgba(240,168,48,0.10)', holeStep: 22,
      line: 'rgba(240,168,48,0.70)', crease: 'rgba(240,168,48,0.55)', lineW: 2.2, glowLines: 0,
      rail: ['#5c4214', '#f0b84a', '#6a4b16'], railEdge: '#2a1f10', railGlow: '#f0a830', railGlowA: 0.25,
      pocket: '#050403',
      me: { body: '#f0a830', rim: '#9c6a14', top: '#ffe2a3', glow: '#f0a830' },
      them: { body: '#4ea6f0', rim: '#245f95', top: '#b5dcff', glow: '#4ea6f0' },
      puck: { body: '#17140f', rim: '#f0a830', top: '#3a3226', glow: '#f0a830' },
      trail: 'rgba(240,168,48,', ring: '#ffe2a3', neon: false,
    },
    rink: {
      name: 'Neon rink',
      bg: '#03070d',
      surface: ['#0b1a2c', '#050c16'], holes: null, holeStep: 0,
      line: 'rgba(255,61,139,0.5)', crease: 'rgba(47,243,255,0.45)', lineW: 3, glowLines: 1,
      rail: ['#05080d', '#0d1622', '#05080d'], railEdge: '#1f3550', railGlow: '#2ff3ff', railGlowA: 0.9,
      pocket: '#000000',
      me: { body: '#2ff3ff', rim: '#2ff3ff', top: '#d8feff', glow: '#2ff3ff' },
      them: { body: '#ff3df0', rim: '#ff3df0', top: '#ffd2fb', glow: '#ff3df0' },
      puck: { body: '#ffffff', rim: '#ffffff', top: '#ffffff', glow: '#ffffff' },
      trail: 'rgba(225,250,255,', ring: '#ffffff', neon: true,
    },
  };

  // A rounded rectangle path (the rail's shape).
  function rrect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y); c.lineTo(x + w - r, y); c.arcTo(x + w, y, x + w, y + r, r);
    c.lineTo(x + w, y + h - r); c.arcTo(x + w, y + h, x + w - r, y + h, r);
    c.lineTo(x + r, y + h); c.arcTo(x, y + h, x, y + h - r, r);
    c.lineTo(x, y + r); c.arcTo(x, y, x + r, y, r);
    c.closePath();
  }

  // A seeded random, so the rink's frost is the same on every repaint.
  function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

  function paintTable(L, k) {
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(TW * k)); cv.height = Math.max(1, Math.round(TH * k));
    const c = cv.getContext('2d');
    c.setTransform(k, 0, 0, k, -TX0 * k, -TY0 * k);
    const C = AH.CORNER, g0 = AH.GOAL_X0, g1 = AH.GOAL_X1;

    // The rail: the outer body, its lit inner edge.
    c.save();
    c.shadowColor = 'rgba(0,0,0,0.6)'; c.shadowBlur = 24; c.shadowOffsetY = 8;
    rrect(c, -RAIL, -RAIL, W + 2 * RAIL, H + 2 * RAIL, C + RAIL);
    const rg = c.createLinearGradient(-RAIL, 0, W + RAIL, 0);
    rg.addColorStop(0, L.rail[0]); rg.addColorStop(0.5, L.rail[1]); rg.addColorStop(1, L.rail[2]);
    c.fillStyle = rg; c.fill();
    c.restore();
    // A top sheen across the rail.
    rrect(c, -RAIL, -RAIL, W + 2 * RAIL, H + 2 * RAIL, C + RAIL);
    const sh = c.createLinearGradient(0, -RAIL, 0, H + RAIL);
    sh.addColorStop(0, 'rgba(255,255,255,0.10)'); sh.addColorStop(0.5, 'rgba(255,255,255,0)'); sh.addColorStop(1, 'rgba(255,255,255,0.06)');
    c.fillStyle = sh; c.fill();
    rrect(c, -RAIL + 1.5, -RAIL + 1.5, W + 2 * RAIL - 3, H + 2 * RAIL - 3, C + RAIL - 1.5);
    c.strokeStyle = L.railEdge; c.globalAlpha = 0.55; c.lineWidth = 1.5; c.stroke(); c.globalAlpha = 1;

    // The goal pockets, cut through each end rail.
    c.fillStyle = L.pocket;
    for (const top of [true, false]) {
      const y = top ? -RAIL - 2 : H - 2;
      rrect(c, g0, y, AH.GOAL_W, RAIL + 4, 10);
      c.fill();
    }

    // The surface.
    rrect(c, 0, 0, W, H, C);
    const sg = c.createRadialGradient(W / 2, H / 2, 40, W / 2, H / 2, H * 0.62);
    sg.addColorStop(0, L.surface[0]); sg.addColorStop(1, L.surface[1]);
    c.fillStyle = sg; c.fill();
    c.save();
    rrect(c, 0, 0, W, H, C); c.clip();
    // Air holes, a fine grid (the arcade's and the house table's), or frost scratches on the rink.
    if (L.holes) {
      c.fillStyle = L.holes;
      const st = L.holeStep;
      for (let y = st / 2; y < H; y += st) for (let x = st / 2; x < W; x += st) {
        c.beginPath(); c.arc(x, y, 1.5, 0, PI2); c.fill();
      }
    } else {
      const r = rng(7);
      c.strokeStyle = 'rgba(190,230,255,0.025)'; c.lineWidth = 1;
      for (let i = 0; i < 160; i++) {
        const x = r() * W, y = r() * H, a = r() * Math.PI, l = 20 + r() * 90;
        c.beginPath(); c.moveTo(x, y); c.quadraticCurveTo(x + Math.cos(a) * l * 0.5 + 8, y + Math.sin(a) * l * 0.5,
          x + Math.cos(a) * l, y + Math.sin(a) * l); c.stroke();
      }
      const fog = c.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, H * 0.6);
      fog.addColorStop(0, 'rgba(47,243,255,0.06)'); fog.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = fog; c.fillRect(0, 0, W, H);
    }

    // Markings: the halfway line, the centre circle, a crease at each goal (and the rink's own lines).
    const stroke = (col, w, glow) => {
      c.lineWidth = w; c.strokeStyle = col;
      if (glow) { c.shadowColor = col; c.shadowBlur = 14; } else c.shadowBlur = 0;
      c.stroke();
    };
    c.lineCap = 'round';
    c.beginPath(); c.moveTo(0, H / 2); c.lineTo(W, H / 2); stroke(L.line, L.lineW * 1.2, L.glowLines);
    c.beginPath(); c.arc(W / 2, H / 2, 92, 0, PI2); stroke(L.line, L.lineW, L.glowLines);
    c.beginPath(); c.arc(W / 2, H / 2, 10, 0, PI2); c.fillStyle = L.line; c.shadowBlur = 0; c.fill();
    for (const top of [true, false]) {
      const gy = top ? 0 : H, dir = top ? 1 : -1;
      c.beginPath(); c.arc(W / 2, gy, 128, top ? 0 : Math.PI, top ? Math.PI : PI2); stroke(L.crease, L.lineW, L.glowLines);
      if (L.neon) {
        c.save(); c.globalAlpha = 0.10; c.fillStyle = L.crease;
        c.beginPath(); c.arc(W / 2, gy, 128, top ? 0 : Math.PI, top ? Math.PI : PI2); c.fill(); c.restore();
        // The rink's blue line on each half, and its face-off circles.
        c.beginPath(); c.moveTo(0, gy + dir * 300); c.lineTo(W, gy + dir * 300); stroke('rgba(47,243,255,0.38)', 3, 1);
        for (const fx of [150, 450]) {
          c.beginPath(); c.arc(fx, gy + dir * 190, 56, 0, PI2); stroke('rgba(255,61,139,0.36)', 2.5, 1);
          c.beginPath(); c.arc(fx, gy + dir * 190, 5, 0, PI2); c.fillStyle = 'rgba(255,61,139,0.5)'; c.shadowBlur = 0; c.fill();
        }
      } else {
        // Face-off dots and a short tick each side of the mouth.
        for (const fx of [150, 450]) {
          c.beginPath(); c.arc(fx, gy + dir * 250, 6, 0, PI2); c.fillStyle = L.crease; c.shadowBlur = 0; c.fill();
        }
      }
    }
    if (L === LOOKS.house) {
      // The house table's emblem: a diamond in the centre circle, the same both ways up.
      c.save(); c.translate(W / 2, H / 2); c.rotate(Math.PI / 4);
      c.strokeStyle = 'rgba(240,168,48,0.45)'; c.lineWidth = 1.5; c.shadowBlur = 0;
      c.strokeRect(-38, -38, 76, 76); c.strokeRect(-30, -30, 60, 60);
      c.restore();
      c.beginPath(); c.arc(W / 2, H / 2, 82, 0, PI2); c.strokeStyle = 'rgba(240,168,48,0.25)'; c.lineWidth = 1; c.stroke();
    }
    // An inner shadow where the surface meets the rail.
    c.shadowBlur = 0;
    rrect(c, 0, 0, W, H, C);
    c.lineWidth = 10; c.strokeStyle = 'rgba(0,0,0,0.22)'; c.stroke();
    c.restore();

    // The rail's light along the surface edge.
    c.save();
    rrect(c, -1, -1, W + 2, H + 2, C + 1);
    c.lineWidth = L.neon ? 3 : 2.5; c.strokeStyle = L.railGlow; c.globalAlpha = L.railGlowA;
    c.shadowColor = L.railGlow; c.shadowBlur = L.neon ? 22 : 12; c.stroke();
    c.restore();
    // The pockets' mouths, lit faintly from inside.
    for (const top of [true, false]) {
      const y = top ? -3 : H - 3;
      c.fillStyle = L.pocket; c.fillRect(g0 + 2, y, AH.GOAL_W - 4, 6);
      c.fillStyle = L.railGlow; c.globalAlpha = 0.6;
      c.fillRect(g0 - 4, top ? -RAIL : H, 4, RAIL); c.fillRect(g1, top ? -RAIL : H, 4, RAIL);
      c.globalAlpha = 1;
    }
    return cv;
  }

  function create(lookName) {
    let L = LOOKS[lookName] || LOOKS.house;
    let table = null, builtK = 0;
    const api = {
      LOOKS, RAIL, TX0, TY0, TW, TH,
      get look() { return L; },
      setLook(n) { if (LOOKS[n] && LOOKS[n] !== L) { L = LOOKS[n]; if (builtK) api.build(builtK); } },
      build(k) { builtK = k; table = paintTable(L, k); },
      drawTable(c) { if (table) c.drawImage(table, TX0, TY0, TW, TH); },

      /* A mallet: a disc with a raised rim and a knob, lit from the top of the screen (flip says the screen is
         turned, so the light stays on the screen's top). flash 0..1 brightens it after a hit. */
      drawMallet(c, x, y, role, flash, flip) {
        const P = role === 'me' ? L.me : L.them, r = AH.MALLET_R;
        const ly = flip ? 1 : -1;
        c.save();
        if (L.neon) {
          c.shadowColor = P.glow; c.shadowBlur = 26 + 20 * flash;
          c.beginPath(); c.arc(x, y, r - 3, 0, PI2); c.lineWidth = 6; c.strokeStyle = P.body; c.stroke();
          c.shadowBlur = 0;
          c.beginPath(); c.arc(x, y, r - 6, 0, PI2); c.fillStyle = 'rgba(3,10,20,0.9)'; c.fill();
          c.globalAlpha = 0.42; c.fillStyle = P.body; c.fill(); c.globalAlpha = 1;
          c.beginPath(); c.arc(x, y, r * 0.42, 0, PI2); c.lineWidth = 3; c.strokeStyle = P.body; c.shadowBlur = 12; c.shadowColor = P.glow; c.stroke();
          c.shadowBlur = 0;
          c.beginPath(); c.arc(x, y, r * 0.2, 0, PI2); c.fillStyle = P.top; c.fill();
        } else {
          c.shadowColor = 'rgba(0,0,0,0.45)'; c.shadowBlur = 12; c.shadowOffsetY = flip ? -5 : 5;
          c.beginPath(); c.arc(x, y, r, 0, PI2); c.fillStyle = P.rim; c.fill();
          c.shadowColor = 'transparent'; c.shadowBlur = 0; c.shadowOffsetY = 0;
          const g = c.createRadialGradient(x, y + ly * r * 0.35, r * 0.1, x, y, r);
          g.addColorStop(0, P.top); g.addColorStop(0.55, P.body); g.addColorStop(1, P.rim);
          c.beginPath(); c.arc(x, y, r - 3, 0, PI2); c.fillStyle = g; c.fill();
          c.beginPath(); c.arc(x, y, r * 0.66, 0, PI2); c.lineWidth = 2; c.strokeStyle = 'rgba(0,0,0,0.22)'; c.stroke();
          // The knob.
          const kg = c.createRadialGradient(x, y + ly * 6, 2, x, y, r * 0.42);
          kg.addColorStop(0, P.top); kg.addColorStop(1, P.body);
          c.shadowColor = 'rgba(0,0,0,0.35)'; c.shadowBlur = 6; c.shadowOffsetY = flip ? -2 : 2;
          c.beginPath(); c.arc(x, y, r * 0.4, 0, PI2); c.fillStyle = kg; c.fill();
          c.shadowColor = 'transparent';
          c.beginPath(); c.ellipse(x, y + ly * r * 0.16, r * 0.18, r * 0.09, 0, 0, PI2); c.fillStyle = 'rgba(255,255,255,0.45)'; c.fill();
        }
        if (flash > 0.01) {
          c.globalAlpha = Math.min(0.6, flash * 0.6); c.beginPath(); c.arc(x, y, r, 0, PI2); c.fillStyle = '#ffffff'; c.fill();
        }
        c.restore();
      },

      /* The puck, and the white flash a hit puts on it. */
      drawPuck(c, x, y, flash, speed, flip) {
        const P = L.puck, r = AH.PUCK_R, ly = flip ? 1 : -1;
        c.save();
        if (L.neon) {
          c.shadowColor = P.glow; c.shadowBlur = 24 + Math.min(30, speed / 80) + 30 * flash;
          c.beginPath(); c.arc(x, y, r, 0, PI2); c.fillStyle = P.body; c.fill();
          c.shadowBlur = 0;
        } else {
          c.shadowColor = 'rgba(0,0,0,0.5)'; c.shadowBlur = 8; c.shadowOffsetY = flip ? -3 : 3;
          c.beginPath(); c.arc(x, y, r, 0, PI2); c.fillStyle = P.rim; c.fill();
          c.shadowColor = 'transparent';
          const g = c.createRadialGradient(x, y + ly * r * 0.3, 2, x, y, r);
          g.addColorStop(0, P.top); g.addColorStop(1, P.body);
          c.beginPath(); c.arc(x, y, r - 3.5, 0, PI2); c.fillStyle = g; c.fill();
          c.beginPath(); c.arc(x, y, r * 0.55, 0, PI2); c.lineWidth = 1.5; c.strokeStyle = L === LOOKS.house ? 'rgba(240,168,48,0.55)' : 'rgba(0,0,0,0.18)'; c.stroke();
        }
        if (flash > 0.01) {
          c.globalAlpha = Math.min(0.9, flash);
          c.shadowColor = '#ffffff'; c.shadowBlur = 18 * flash;
          c.beginPath(); c.arc(x, y, r + 1, 0, PI2); c.fillStyle = '#ffffff'; c.fill();
        }
        c.restore();
      },

      /* The puck's trail: the last few drawn positions, fading, wider the faster it went. */
      drawTrail(c, pts) {
        if (pts.length < 2) return;
        c.save();
        c.lineCap = 'round'; c.lineJoin = 'round';
        if (L.neon) { c.shadowColor = L.puck.glow; c.shadowBlur = 16; }
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1], b = pts[i], u = i / pts.length;
          const sp = Math.min(1, (b.v || 0) / AH.PUCK_MAX);
          if (sp < 0.2) continue;
          c.strokeStyle = L.trail + (u * sp * (L.neon ? 0.7 : 0.45)).toFixed(3) + ')';
          c.lineWidth = AH.PUCK_R * 2 * (0.25 + 0.6 * u);
          c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
        }
        c.restore();
      },

      /* Hit rings and sparks, in world units: { kind: 'ring' | 'spark', x, y, at, v, col, a (angle) }. */
      drawFx(c, list, now) {
        c.save();
        for (const f of list) {
          const u = (now - f.at) / f.life;
          if (u < 0 || u > 1) continue;
          if (f.kind === 'ring') {
            c.globalAlpha = (1 - u) * 0.8;
            c.strokeStyle = f.col || L.ring; c.lineWidth = 4 * (1 - u) + 1;
            if (L.neon) { c.shadowColor = f.col || L.ring; c.shadowBlur = 14; }
            c.beginPath(); c.arc(f.x, f.y, 10 + f.size * u, 0, PI2); c.stroke();
          } else if (f.kind === 'spark') {
            c.globalAlpha = 1 - u;
            c.strokeStyle = f.col || L.ring; c.lineWidth = 2.5;
            const d0 = 8 + f.size * u * 0.6, d1 = d0 + 10 + 14 * (1 - u);
            c.beginPath(); c.moveTo(f.x + Math.cos(f.a) * d0, f.y + Math.sin(f.a) * d0);
            c.lineTo(f.x + Math.cos(f.a) * d1, f.y + Math.sin(f.a) * d1); c.stroke();
          } else if (f.kind === 'goal') {
            // The goal mouth lit in the scorer's colour, washing up the table.
            const gy = f.y, dir = gy < H / 2 ? 1 : -1;
            const g = c.createLinearGradient(0, gy, 0, gy + dir * 520);
            g.addColorStop(0, f.col); g.addColorStop(1, 'rgba(0,0,0,0)');
            c.globalAlpha = (1 - u) * 0.55;
            c.fillStyle = g;
            c.fillRect(0, Math.min(gy, gy + dir * 520), W, 520);
            c.globalAlpha = (1 - u);
            c.fillStyle = f.col; c.shadowColor = f.col; c.shadowBlur = 30;
            c.fillRect(AH.GOAL_X0, gy - 6, AH.GOAL_W, 12);
          }
        }
        c.restore();
      },

      /* The 7 second rule's ring round the puck: how much of the time is gone (0..1). */
      drawStall(c, x, y, frac, col) {
        c.save();
        c.lineWidth = 4; c.strokeStyle = col; c.globalAlpha = 0.9; c.lineCap = 'round';
        c.beginPath(); c.arc(x, y, AH.PUCK_R + 9, -Math.PI / 2, -Math.PI / 2 + PI2 * (1 - frac)); c.stroke();
        c.restore();
      },

/* Each goal mouth glows in its owner's colour (top: the seat that defends y = 0); a goal floods the scored-on mouth
         in the scorer's colour for half a second. */
      drawGoals(c, topRole, botRole, sinceGoal, scorerRole) {
        c.save();
        for (const [role, y] of [[topRole, -4], [botRole, H - 2]]) {
          const col = role === 'me' ? L.me.glow : L.them.glow;
          c.globalAlpha = L.neon ? 0.55 : 0.3; c.fillStyle = col; c.shadowColor = col; c.shadowBlur = L.neon ? 16 : 6;
          c.fillRect(AH.GOAL_X0 + 6, y, AH.GOAL_W - 12, 6);
        }
        c.restore();
      },

      colorOf(role) { return role === 'me' ? L.me.glow : L.them.glow; },
    };
    return api;
  }

  root.AHArt = { create, LOOKS, RAIL };
})(window);
