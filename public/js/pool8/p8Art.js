'use strict';
/* ─── 8 Ball Pool, the paint ──────────────────────────────────────────────────
   Everything on the canvas is drawn here, by code: the table, the balls, the
   cue, the aim guide, the power bar, the top bar and the messages. No image,
   font or sound of Miniclip's is used; the LAYOUT and COLOURS follow theirs as
   measured from the reference (docs/pool8-reference.md: Owen's screenshot of
   8ballpool.com/game at 2000x1247 and the headless captures), so every position
   below is in that frame: the game area is DESIGN.w x DESIGN.h units, with the
   origin at its top left.

   The balls are real spheres: each one is shaded pixel by pixel from its own
   orientation (a 3x3 rotation the screen turns as the ball rolls), so a stripe
   rolls over and a number turns away the way a ball does. Small canvases, cached
   until the ball moves. */

(function (root) {
  const Sim = root.P8Sim;
  const P8 = Sim.P8;

  // The reference frame (Owen's screenshot, game area x 617..1683, y 268..978 of 2000x1247).
  const DESIGN = { w: 1066, h: 710 };
  const LAYOUT = {
    bar: { y: 0, h: 110 },
    field: { x: 129, y: 210, w: 808, h: 419 },     // cushion nose to cushion nose
    rail: { x: 99, y: 180, w: 869, h: 479 },       // the wooden rail's outside edge
    ret: { x: 990, y: 296, w: 34, h: 324 },        // the ball-return rail on the right
    power: { x: 26, y: 214, w: 46, h: 412 },       // the vertical power bar on the left
    menu: { x: 11, y: 28, w: 56, h: 56 },
    plate: [{ x: 140, y: 32, w: 238 }, { x: 688, y: 32, w: 238 }],
    avatar: [{ x: 393, y: 12, s: 82 }, { x: 591, y: 12, s: 82 }],
    mid: { x: 491, y: 12, s: 84 },
    spin: { x: 1026, y: 54, r: 33 },
    msg: { y: 690 },
    hint: { y: 132 },
  };

  // Colours read from the reference (docs/pool8-reference.md "Colours").
  const C = {
    bg: '#1a2033', bar: '#2b2a33', barHi: '#383642', barLo: '#17161b', slot: '#17161b', slotRim: '#46454f',
    feltHi: '#97c6d9', feltMid: '#6090b0', feltLo: '#2d4866', cushion: '#5080b0', cushionHi: '#86b4d8',
    railLo: '#4e1006', rail: '#7a271d', railHi: '#87392f', railEdge: '#401000', pocket: '#000000', pocketRim: '#200000',
    diamond: '#f2efe4', text: '#ffffff', hint: '#8e95a8', turn: '#53d63c', ret: '#707080', retLo: '#3d3d4a',
    msgBg: 'rgba(0,0,0,0.88)', guide: 'rgba(255,255,255,0.92)', avatar: '#4a87d6', avatarHi: '#7fb1ee',
  };
  const BALL = {
    1: '#f4c20d', 2: '#1f4fd1', 3: '#d42a1e', 4: '#5b2a8c', 5: '#f07a12', 6: '#127a3b', 7: '#8a1e1c', 8: '#151515',
  };
  const ballColor = (n) => (n === 0 ? '#f7f5ee' : BALL[n > 8 ? n - 8 : n]);

  /* ── the transform: table units -> design units -> screen ─────────────── */
  const F = LAYOUT.field;
  const k = F.w / P8.L;                                    // design units per table unit
  const tx = (x) => F.x + x * k, ty = (y) => F.y + y * k;
  const fx = (dx) => (dx - F.x) / k, fy = (dy) => (dy - F.y) / k;

  // The pocket holes as drawn, in design units (Owen's screenshot: about 24 across the corners, 22 at the sides).
  const POCKET_R = { corner: 24, side: 22 };

  /* ── the table, painted once per size ──────────────────────────────────── */
  /* look: a free look of shared/pool8Looks.js (its cloth), or null for the reference's blue. */
  function paintTable(g, s, look) {
    const R = LAYOUT.rail;
    const K = look && look.cloth ? look.cloth : { hi: C.feltHi, mid: C.feltMid, lo: C.feltLo, cushion: C.cushion, cushionHi: C.cushionHi };
    g.save();
    g.scale(s, s);
    g.fillStyle = C.bg;
    g.fillRect(0, 0, DESIGN.w, DESIGN.h);
    // A soft light over the room behind the table.
    const room = g.createRadialGradient(533, 420, 60, 533, 420, 620);
    room.addColorStop(0, 'rgba(70,90,130,0.35)'); room.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = room; g.fillRect(0, 0, DESIGN.w, DESIGN.h);

    // The ball-return rail: a channel the potted balls roll down and line up in.
    const T = LAYOUT.ret;
    roundRect(g, T.x - 4, T.y - 4, T.w + 8, T.h + 8, (T.w + 8) / 2); g.fillStyle = C.retLo; g.fill();
    roundRect(g, T.x, T.y, T.w, T.h, T.w / 2); g.fillStyle = C.ret; g.fill();
    const tg = g.createLinearGradient(T.x, 0, T.x + T.w, 0);
    tg.addColorStop(0, 'rgba(0,0,0,0.45)'); tg.addColorStop(0.5, 'rgba(255,255,255,0.12)'); tg.addColorStop(1, 'rgba(0,0,0,0.45)');
    g.fillStyle = tg; g.fill();
    // The short chute from the table to the channel.
    g.fillStyle = C.retLo; g.fillRect(R.x + R.w - 6, T.y + T.h - 30, T.x - (R.x + R.w) + 10, 22);

    // Table shadow, then the rail.
    g.fillStyle = 'rgba(0,0,0,0.45)';
    roundRect(g, R.x - 6, R.y + 4, R.w + 12, R.h + 12, 34); g.fill();
    roundRect(g, R.x, R.y, R.w, R.h, 30);
    const rg = g.createLinearGradient(0, R.y, 0, R.y + R.h);
    rg.addColorStop(0, C.railHi); rg.addColorStop(0.08, C.rail); rg.addColorStop(0.92, C.rail); rg.addColorStop(1, C.railLo);
    g.fillStyle = rg; g.fill();
    g.lineWidth = 3; g.strokeStyle = C.railEdge; g.stroke();
    // The rail's inner edge: a thin dark line where the cushion meets the wood.
    roundRect(g, F.x - 11, F.y - 11, F.w + 22, F.h + 22, 6);
    g.fillStyle = C.railEdge; g.fill();

    // The felt: lit from above, brightest in the middle.
    const fg = g.createRadialGradient(F.x + F.w / 2, F.y + F.h / 2, 30, F.x + F.w / 2, F.y + F.h / 2, F.w * 0.62);
    fg.addColorStop(0, K.hi); fg.addColorStop(0.55, K.mid); fg.addColorStop(1, K.lo);
    g.fillStyle = fg;
    g.fillRect(F.x - 12, F.y - 12, F.w + 24, F.h + 24);

    // The cushions: the blue noses along each rail, with the pocket mouths cut out of them.
    g.save();
    g.beginPath(); g.rect(F.x - 12, F.y - 12, F.w + 24, F.h + 24); g.clip();
    for (const sg of Sim.SEGS) {
      g.beginPath();
      g.moveTo(tx(sg.ax), ty(sg.ay)); g.lineTo(tx(sg.bx), ty(sg.by));
      g.lineWidth = 3; g.strokeStyle = K.cushionHi; g.stroke();
    }
    g.restore();
    const lip = (x, y, w, h) => { g.fillStyle = K.cushion; g.fillRect(x, y, w, h); };
    lip(F.x, F.y - 9, F.w, 9); lip(F.x, F.y + F.h, F.w, 9); lip(F.x - 9, F.y, 9, F.h); lip(F.x + F.w, F.y, 9, F.h);
    // The baulk line the break is taken from behind.
    g.strokeStyle = 'rgba(255,255,255,0.22)'; g.lineWidth = 1.5;
    line(g, tx(P8.HEAD_X * P8.L), F.y, tx(P8.HEAD_X * P8.L), F.y + F.h);
    // Pockets: black holes with a dark rim, over the cushion ends.
    for (const p of Sim.POCKETS) {
      const px = tx(p.x), py = ty(p.y), pr = POCKET_R[p.kind];
      g.beginPath(); g.arc(px, py, pr + 3, 0, Math.PI * 2); g.fillStyle = C.railLo; g.fill();
      g.beginPath(); g.arc(px, py, pr, 0, Math.PI * 2);
      const pg = g.createRadialGradient(px, py, pr * 0.2, px, py, pr);
      pg.addColorStop(0, '#000'); pg.addColorStop(0.8, '#050000'); pg.addColorStop(1, C.pocketRim);
      g.fillStyle = pg; g.fill();
    }
    // Diamonds: three between each pair of pockets.
    g.fillStyle = C.diamond;
    for (let i = 1; i < 8; i++) {
      if (i === 4) continue;
      const x = F.x + F.w * i / 8;
      dot(g, x, R.y + (F.y - 16 - R.y) / 2, 2.6); dot(g, x, R.y + R.h - (F.y - 16 - R.y) / 2, 2.6);
    }
    for (let i = 1; i < 4; i++) {
      const y = F.y + F.h * i / 4;
      dot(g, R.x + (F.x - 16 - R.x) / 2, y, 2.6); dot(g, R.x + R.w - (F.x - 16 - R.x) / 2, y, 2.6);
    }
    g.restore();
  }

  /* ── the balls ────────────────────────────────────────────────────────────
     A ball's look in its own frame: solids all colour, stripes white with a band
     around their middle (|y| < 0.52), the 8 black, and the number on a white disc
     at +z and -z. Each pixel of the ball's little canvas is a point on the sphere,
     turned into the ball's frame by its orientation and lit from the top left. */
  const glyphs = {};
  const LIGHT = norm([-0.42, -0.58, 0.7]);
  const HALF = norm([LIGHT[0], LIGHT[1], LIGHT[2] + 1]);
  const DISC = Math.cos(0.43);
  function glyph(n) {
    if (glyphs[n]) return glyphs[n];
    const S = 48, c = mk(S, S), g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, S, S);
    g.fillStyle = '#111';
    g.font = '800 ' + (n > 9 ? 25 : 29) + 'px Archivo, Arial, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(n), S / 2, S / 2 + 2);
    if (n === 6 || n === 9) g.fillRect(S / 2 - 7, S / 2 + 14, 14, 2.5);
    glyphs[n] = { S, d: g.getImageData(0, 0, S, S).data };
    return glyphs[n];
  }
  const rgb = (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];

  function makeBall(n) {
    return { n, m: [1, 0, 0, 0, 1, 0, 0, 0, 1], c: null, px: 0, dirty: true, col: rgb(ballColor(n)) };
  }
  // Roll the ball's orientation by a move of (dx, dy) table units on the cloth.
  function roll(b, dx, dy) {
    const d = Math.hypot(dx, dy);
    if (d < 1e-4) return;
    const ang = d / P8.R, ax = -dy / d, ay = dx / d;     // axis (z up toward the viewer) x move
    const c = Math.cos(ang), s = Math.sin(ang), t = 1 - c;
    // Rotation about (ax, ay, 0).
    const r = [t * ax * ax + c, t * ax * ay, s * ay, t * ax * ay, t * ay * ay + c, -s * ax, -s * ay, s * ax, c];
    b.m = mul(r, b.m);
    b.dirty = true;
  }
  function paintBall(b, px) {
    const S = Math.max(8, Math.ceil(px * 2) + 2);
    if (!b.c || b.c.width !== S) { b.c = mk(S, S); b.dirty = true; }
    if (!b.dirty && b.px === px) return b.c;
    b.dirty = false; b.px = px;
    const g = b.c.getContext('2d');
    const img = g.createImageData(S, S), out = img.data;
    const m = b.m, n = b.n, col = b.col, stripe = n > 8, gl = n > 0 ? glyph(n) : null;
    const r = S / 2 - 1, cx = S / 2, cy = S / 2;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = (x + 0.5 - cx) / r, v = (y + 0.5 - cy) / r, q = u * u + v * v;
        if (q > 1) continue;
        const w = Math.sqrt(1 - q);
        // Into the ball's frame: b = M^T n.
        const bx = m[0] * u + m[3] * v + m[6] * w;
        const by = m[1] * u + m[4] * v + m[7] * w;
        const bz = m[2] * u + m[5] * v + m[8] * w;
        let R0, G0, B0;
        if (n === 0) { R0 = col[0]; G0 = col[1]; B0 = col[2]; }
        else if (stripe && Math.abs(by) > 0.52) { R0 = 246; G0 = 243; B0 = 234; }
        else { R0 = col[0]; G0 = col[1]; B0 = col[2]; }
        if (gl && Math.abs(bz) > DISC) {
          // The number disc, flat on the sphere: its own (x, y) scaled to the glyph.
          const sgn = bz > 0 ? 1 : -1;
          const gx = (bx * sgn / Math.sin(0.43) * 0.5 + 0.5) * gl.S, gy = (by / Math.sin(0.43) * 0.5 + 0.5) * gl.S;
          const gi = ((Math.min(gl.S - 1, Math.max(0, gy | 0))) * gl.S + Math.min(gl.S - 1, Math.max(0, gx | 0))) * 4;
          R0 = gl.d[gi]; G0 = gl.d[gi + 1]; B0 = gl.d[gi + 2];
        }
        const dif = Math.max(0, u * LIGHT[0] + v * LIGHT[1] + w * LIGHT[2]);
        const spec = Math.pow(Math.max(0, u * HALF[0] + v * HALF[1] + w * HALF[2]), 70) * 235;
        const shade = 0.42 + 0.68 * dif;
        const edge = q > 0.86 ? 1 - (q - 0.86) * 1.6 : 1;
        const i = (y * S + x) * 4;
        out[i] = Math.min(255, R0 * shade * edge + spec);
        out[i + 1] = Math.min(255, G0 * shade * edge + spec);
        out[i + 2] = Math.min(255, B0 * shade * edge + spec);
        // Antialiased edge.
        out[i + 3] = q > 0.94 ? Math.max(0, Math.min(255, (1 - q) / 0.06 * 255)) : 255;
      }
    }
    g.putImageData(img, 0, 0);
    return b.c;
  }

  function drawBall(g, b, x, y, s, alpha) {
    const pr = P8.R * k * s;
    const c = paintBall(b, pr);
    if (alpha !== undefined) g.globalAlpha = alpha;
    g.drawImage(c, x * s - c.width / 2, y * s - c.height / 2);
    g.globalAlpha = 1;
  }
  function drawShadow(g, x, y, s) {
    const pr = P8.R * k * s;
    g.beginPath();
    g.ellipse(x * s + pr * 0.28, y * s + pr * 0.32, pr * 1.02, pr * 0.9, 0, 0, Math.PI * 2);
    g.fillStyle = 'rgba(0,0,0,0.32)';
    g.fill();
  }

  /* ── the cue, the guide, the power bar ─────────────────────────────────── */
  // The cue stick behind the cue ball, pointing along `a`, pulled back `pull` design units. cue: a free look's colours.
  const CUE = { shaft: '#d8b27a', butt: '#5a2a14', joint: '#1b1b1b' };
  function drawCue(g, cx, cy, a, pull, s, cue) {
    const Q = cue || CUE;
    const R = P8.R * k;
    const len = 560, ux = Math.cos(a), uy = Math.sin(a);
    const x0 = cx - ux * (R + 4 + pull), y0 = cy - uy * (R + 4 + pull);
    const x1 = x0 - ux * len, y1 = y0 - uy * len;
    g.save(); g.scale(s, s);
    g.lineCap = 'round';
    // Shadow.
    g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 9;
    line(g, x0 + 6, y0 + 9, x1 + 6, y1 + 9);
    const seg = (fa, fb, w0, col) => {
      g.strokeStyle = col; g.lineWidth = w0;
      line(g, x0 - ux * len * fa, y0 - uy * len * fa, x0 - ux * len * fb, y0 - uy * len * fb);
    };
    seg(0, 0.012, 5, '#e9eef2');          // tip
    seg(0.012, 0.03, 5.4, '#f4f1e6');     // ferrule
    seg(0.03, 0.62, 6.2, Q.shaft);        // shaft
    seg(0.62, 0.66, 7.4, Q.joint);        // joint
    seg(0.66, 1, 9, Q.butt);              // butt
    g.strokeStyle = 'rgba(255,255,255,0.28)'; g.lineWidth = 1.6;
    line(g, x0 - ux * len * 0.03 - uy * 1.5, y0 - uy * len * 0.03 + ux * 1.5, x1 - uy * 2.2, y1 + ux * 2.2);
    g.restore();
  }

  /* The guide: a line from the cue ball to the ghost circle; from a ball hit, the object ball's line and the cue
     ball's line. Lengths are the reference's (docs/pool8-reference.md "Aim guide"). */
  const GUIDE = { obj: 3.2, cue: 1.6, width: 2 };   // in ball diameters
  function drawGuide(g, cx, cy, gd, s, warn) {
    g.save(); g.scale(s, s);
    const R = P8.R * k, gx = tx(gd.gx), gy = ty(gd.gy);
    g.strokeStyle = warn ? 'rgba(255,90,80,0.95)' : C.guide; g.lineWidth = GUIDE.width;
    const dx = gx - cx, dy = gy - cy, dl = Math.hypot(dx, dy) || 1;
    line(g, cx + dx / dl * R, cy + dy / dl * R, gx - dx / dl * R, gy - dy / dl * R);
    g.beginPath(); g.arc(gx, gy, R, 0, Math.PI * 2); g.stroke();
    if (warn) {
      // A ball the shooter may not hit first: the circle is crossed out.
      line(g, gx - R * 0.7, gy - R * 0.7, gx + R * 0.7, gy + R * 0.7);
    } else if (gd.kind === 'ball') {
      const D = 2 * R;
      const ox = tx(gd.gx) + gd.ox * (R * 2), oy = ty(gd.gy) + gd.oy * (R * 2);
      line(g, ox, oy, ox + gd.ox * D * GUIDE.obj, oy + gd.oy * D * GUIDE.obj);
      if (gd.tx || gd.ty) line(g, gx, gy, gx + gd.tx * D * GUIDE.cue, gy + gd.ty * D * GUIDE.cue);
    }
    g.restore();
  }

  // The vertical power bar: a channel with the cue inside it, pulled down as the power grows.
  function drawPower(g, p, s, active) {
    const P = LAYOUT.power;
    g.save(); g.scale(s, s);
    roundRect(g, P.x, P.y, P.w, P.h, P.w / 2);
    g.fillStyle = 'rgba(10,12,20,0.85)'; g.fill();
    g.lineWidth = 2; g.strokeStyle = active ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.18)'; g.stroke();
    // The fill: green at the top through yellow to red at full power.
    const ih = (P.h - 12) * p;
    if (p > 0) {
      const gr = g.createLinearGradient(0, P.y + 6, 0, P.y + P.h - 6);
      gr.addColorStop(0, '#3fd14a'); gr.addColorStop(0.55, '#f1d33a'); gr.addColorStop(1, '#e8402c');
      g.save(); roundRect(g, P.x + 6, P.y + 6, P.w - 12, P.h - 12, (P.w - 12) / 2); g.clip();
      g.fillStyle = gr; g.fillRect(P.x + 6, P.y + 6, P.w - 12, ih);
      g.restore();
    }
    // The cue inside the bar, its tip at the power line.
    const cx = P.x + P.w / 2, top = P.y + 10 + ih;
    g.lineCap = 'round';
    g.strokeStyle = '#d8b27a'; g.lineWidth = 6; line(g, cx, top, cx, Math.min(P.y + P.h - 8, top + P.h * 0.7));
    g.strokeStyle = '#f4f1e6'; g.lineWidth = 6; line(g, cx, top, cx, top + 6);
    g.restore();
  }

  /* The fine-aim wheel on a touch screen, at the right edge: ridges that roll as the aim turns. */
  function drawFine(g, a, s) {
    const x = 1030, y = 214, w = 30, h = 412;
    g.save(); g.scale(s, s);
    roundRect(g, x, y, w, h, 10);
    const bg = g.createLinearGradient(x, 0, x + w, 0);
    bg.addColorStop(0, '#22252f'); bg.addColorStop(0.5, '#4a4e5c'); bg.addColorStop(1, '#22252f');
    g.fillStyle = bg; g.fill();
    g.clip();
    const off = ((a * 400) % 16 + 16) % 16;
    g.strokeStyle = 'rgba(0,0,0,0.55)'; g.lineWidth = 2;
    for (let yy = y - 16 + off; yy < y + h + 16; yy += 16) line(g, x + 4, yy, x + w - 4, yy);
    const sh = g.createLinearGradient(0, y, 0, y + h);
    sh.addColorStop(0, 'rgba(0,0,0,0.6)'); sh.addColorStop(0.2, 'rgba(0,0,0,0)'); sh.addColorStop(0.8, 'rgba(0,0,0,0)'); sh.addColorStop(1, 'rgba(0,0,0,0.6)');
    g.fillStyle = sh; g.fillRect(x, y, w, h);
    g.restore();
  }

  /* ── the top bar ───────────────────────────────────────────────────────────
     hud: { names[2], initials[2], active (0|1|-1), timeFrac (1..0), groups[2], potted[2] (numbers),
            spin {x, y}, mid (the 8 or the group icon) } */
  function drawBar(g, hud, s) {
    g.save(); g.scale(s, s);
    const B = LAYOUT.bar;
    const bg = g.createLinearGradient(0, B.y, 0, B.y + B.h);
    bg.addColorStop(0, C.barHi); bg.addColorStop(1, C.bar);
    g.fillStyle = bg; g.fillRect(0, B.y, DESIGN.w, B.h);
    g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(0, B.y + B.h - 2, DESIGN.w, 2);

    // The menu button.
    const M = LAYOUT.menu;
    roundRect(g, M.x, M.y, M.w, M.h, 11);
    const mg = g.createLinearGradient(0, M.y, 0, M.y + M.h);
    mg.addColorStop(0, '#79e05a'); mg.addColorStop(1, '#2e9b2a');
    g.fillStyle = mg; g.fill(); g.lineWidth = 2.5; g.strokeStyle = '#1d5e1a'; g.stroke();
    g.fillStyle = '#fff';
    for (let i = 0; i < 3; i++) roundRect(g, M.x + 13, M.y + 15 + i * 10, M.w - 26, 5, 2.5), g.fill();

    for (let side = 0; side < 2; side++) {
      const P = LAYOUT.plate[side], A = LAYOUT.avatar[side];
      const active = hud.active === side;
      // The name.
      g.font = '800 19px Archivo, Arial, sans-serif';
      g.textBaseline = 'middle';
      g.textAlign = side === 0 ? 'right' : 'left';
      g.fillStyle = active ? '#ffffff' : '#c9c9d2';
      const nx = side === 0 ? P.x + P.w : P.x;
      g.fillText(fitText(g, hud.names[side] || '', P.w - 8), nx, P.y + 18);
      // Seven slots under it: the group's balls as they go down.
      const grp = hud.groups[side];
      const pot = hud.potted[side] || [];
      for (let i = 0; i < 7; i++) {
        const sx = side === 0 ? P.x + P.w - 16 - i * 34 : P.x + 16 + i * 34, sy = P.y + 52;
        g.beginPath(); g.arc(sx, sy, 14.5, 0, Math.PI * 2); g.fillStyle = C.slot; g.fill();
        g.lineWidth = 1.5; g.strokeStyle = C.slotRim; g.stroke();
        if (grp) {
          const n = grp === 'solids' ? 7 - i : 15 - i;
          const shown = side === 0 ? n : (grp === 'solids' ? i + 1 : i + 9);
          if (!pot.includes(shown)) iconBall(g, shown, sx, sy, 12.5);
        }
      }
      // The avatar: a blue tile with the player's initial; green frame and the shot clock ring on whoever is up.
      roundRect(g, A.x, A.y, A.s, A.s, 12);
      g.fillStyle = active ? C.turn : '#4b4a57'; g.fill();
      roundRect(g, A.x + 5, A.y + 5, A.s - 10, A.s - 10, 9);
      const ag = g.createLinearGradient(0, A.y, 0, A.y + A.s);
      ag.addColorStop(0, C.avatarHi); ag.addColorStop(1, C.avatar);
      g.fillStyle = ag; g.fill();
      g.fillStyle = 'rgba(255,255,255,0.95)';
      g.font = '900 42px Archivo, Arial, sans-serif';
      g.textAlign = 'center';
      g.fillText((hud.initials[side] || '?').toUpperCase(), A.x + A.s / 2, A.y + A.s / 2 + 2);
      if (active && hud.timeFrac >= 0) {
        // The clock: the frame drains around the tile, green to red as it runs out.
        const f = Math.max(0, Math.min(1, hud.timeFrac));
        g.lineWidth = 6;
        g.strokeStyle = f > 0.5 ? C.turn : f > 0.2 ? '#f1d33a' : '#ec3b2b';
        g.beginPath();
        perimeter(g, A.x + 2.5, A.y + 2.5, A.s - 5, A.s - 5, 10, f);
        g.stroke();
      }
    }
    // The middle: an 8 ball in a dark tile.
    const D = LAYOUT.mid;
    roundRect(g, D.x, D.y, D.s, D.s, 12); g.fillStyle = C.barLo; g.fill();
    g.lineWidth = 2; g.strokeStyle = C.slotRim; g.stroke();
    iconBall(g, 8, D.x + D.s / 2, D.y + D.s / 2, 25);

    // The spin button: the cue ball with the red dot where the tip will strike.
    const S = LAYOUT.spin;
    iconBall(g, 0, S.x, S.y, S.r);
    g.beginPath(); g.arc(S.x + hud.spin.x * S.r * 0.62, S.y - hud.spin.y * S.r * 0.62, 6, 0, Math.PI * 2);
    g.fillStyle = '#e8262b'; g.fill();
    g.restore();
  }

  // A flat lit ball for the bar (slots, the 8, the spin button).
  function iconBall(g, n, x, y, r) {
    const col = ballColor(n);
    g.save();
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.clip();
    g.fillStyle = n > 8 ? '#f6f3ea' : col; g.fillRect(x - r, y - r, 2 * r, 2 * r);
    if (n > 8) { g.fillStyle = col; g.fillRect(x - r, y - r * 0.52, 2 * r, r * 1.04); }
    if (n > 0) {
      g.beginPath(); g.arc(x, y, r * 0.48, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill();
      g.fillStyle = '#111'; g.font = '800 ' + Math.round(r * (n > 9 ? 0.6 : 0.72)) + 'px Archivo, Arial, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(n), x, y + r * 0.04);
    }
    const sh = g.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r * 1.05);
    sh.addColorStop(0, 'rgba(255,255,255,0.55)'); sh.addColorStop(0.35, 'rgba(255,255,255,0)'); sh.addColorStop(1, 'rgba(0,0,0,0.45)');
    g.fillStyle = sh; g.fillRect(x - r, y - r, 2 * r, 2 * r);
    g.restore();
  }

  // The message box at the foot of the table ("You are breaking, good luck!").
  function drawMsg(g, text, s, alpha) {
    if (!text) return;
    g.save(); g.scale(s, s);
    g.globalAlpha = alpha === undefined ? 1 : alpha;
    g.font = '800 19px Archivo, Arial, sans-serif';
    const w = g.measureText(text).width + 34;
    const x = DESIGN.w / 2 - w / 2 + 160, y = LAYOUT.msg.y - 18;
    roundRect(g, x, y, w, 36, 6); g.fillStyle = C.msgBg; g.fill();
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, x + w / 2, y + 19);
    g.restore();
  }
  // The grey hint under the bar ("Drag to aim", "Pull the power bar down and let go").
  function drawHint(g, text, s) {
    if (!text) return;
    g.save(); g.scale(s, s);
    g.font = '800 26px Archivo, Arial, sans-serif';
    g.fillStyle = C.hint; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, F.x + F.w / 2, LAYOUT.hint.y);
    g.restore();
  }

  /* The opening: the two player cards and VS, over a warm burst (ours: no figures, no title art). */
  function drawVS(g, names, initials, title, f, s) {
    g.save(); g.scale(s, s);
    const t = Math.min(1, f * 3);
    const bg = g.createRadialGradient(533, 360, 30, 533, 360, 640);
    bg.addColorStop(0, '#f7b955'); bg.addColorStop(0.45, '#c46a1c'); bg.addColorStop(1, '#4a1d06');
    g.fillStyle = bg; g.fillRect(0, 0, DESIGN.w, DESIGN.h);
    g.save(); g.translate(533, 380); g.globalAlpha = 0.18; g.fillStyle = '#fff3c4';
    for (let i = 0; i < 18; i++) { g.rotate(Math.PI / 9); g.beginPath(); g.moveTo(0, 0); g.lineTo(700, -60); g.lineTo(700, 60); g.fill(); }
    g.restore();
    g.font = '900 64px Archivo, Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 8; g.strokeStyle = '#1d4a12'; g.strokeText(title, 533, 72);
    g.fillStyle = '#a6f06b'; g.fillText(title, 533, 72);
    for (let side = 0; side < 2; side++) {
      const x = side === 0 ? 237 - (1 - t) * 300 : 629 + (1 - t) * 300, y = 250, w = 200, h = 240;
      roundRect(g, x, y, w, h, 14); g.fillStyle = '#5f6170'; g.fill(); g.lineWidth = 4; g.strokeStyle = '#2d2e38'; g.stroke();
      roundRect(g, x + 16, y + 16, w - 32, h - 76, 10);
      const ag = g.createLinearGradient(0, y, 0, y + h);
      ag.addColorStop(0, C.avatarHi); ag.addColorStop(1, C.avatar);
      g.fillStyle = ag; g.fill();
      g.fillStyle = '#fff'; g.font = '900 96px Archivo, Arial, sans-serif';
      g.fillText((initials[side] || '?').toUpperCase(), x + w / 2, y + 16 + (h - 76) / 2 + 4);
      roundRect(g, x + 12, y + h - 50, w - 24, 36, 8); g.fillStyle = '#22232b'; g.fill();
      g.fillStyle = '#fff'; g.font = '800 17px Archivo, Arial, sans-serif';
      g.fillText(fitText(g, names[side] || '', w - 36), x + w / 2, y + h - 31);
    }
    g.globalAlpha = t;
    g.font = '900 80px Archivo, Arial, sans-serif';
    g.lineWidth = 9; g.strokeStyle = '#173c0e'; g.strokeText('VS', 533, 372);
    g.fillStyle = '#9be35c'; g.fillText('VS', 533, 372);
    g.restore();
  }

  /* The spin picker: a big cue ball, the red dot where the tip will strike, dragged anywhere inside the ring. */
  function drawSpinPicker(g, spin, s) {
    g.save(); g.scale(s, s);
    g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(0, 0, DESIGN.w, DESIGN.h);
    const cx = 533, cy = 400, r = 150;
    iconBall(g, 0, cx, cy, r);
    g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 2;
    line(g, cx - r, cy, cx + r, cy); line(g, cx, cy - r, cx, cy + r);
    g.beginPath(); g.arc(cx, cy, r * 0.62, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(cx + spin.x * r * 0.62, cy - spin.y * r * 0.62, 18, 0, Math.PI * 2);
    g.fillStyle = '#e8262b'; g.fill(); g.lineWidth = 3; g.strokeStyle = '#fff'; g.stroke();
    g.fillStyle = '#fff'; g.font = '800 22px Archivo, Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('Set the spin, then tap outside the ball', cx, cy + r + 44);
    g.restore();
    return { cx, cy, r: r * 0.62, R: r };
  }

  // The pocket called for the 8: a ring and an arrow into it.
  function drawCall(g, k0, s, pulse) {
    const p = Sim.POCKETS[k0];
    if (!p) return;
    g.save(); g.scale(s, s);
    const x = tx(p.x), y = ty(p.y), r = p.r * k * 1.25 + 4 + pulse * 3;
    g.lineWidth = 4; g.strokeStyle = '#f7e03c';
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke();
    g.restore();
  }

  // The hand on a cue ball that may be moved (ball in hand).
  function drawInHand(g, x, y, s, ok) {
    g.save(); g.scale(s, s);
    const R = P8.R * k;
    g.beginPath(); g.arc(x, y, R + 6, 0, Math.PI * 2);
    g.lineWidth = 2.5; g.strokeStyle = ok ? 'rgba(255,255,255,0.9)' : 'rgba(255,80,70,0.95)';
    g.setLineDash([5, 4]); g.stroke(); g.setLineDash([]);
    g.restore();
  }

  /* ── small helpers ─────────────────────────────────────────────────────── */
  function mk(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function norm(v) { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; }
  function mul(a, b) {
    const o = new Array(9);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    return o;
  }
  function line(g, x0, y0, x1, y1) { g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); }
  function dot(g, x, y, r) { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); }
  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }
  // The first `f` of a rounded rectangle's outline, clockwise from the top middle.
  function perimeter(g, x, y, w, h, r, f) {
    const pts = [];
    const N = 120;
    for (let i = 0; i <= N * f; i++) {
      const t = i / N, P = 2 * (w + h);
      let d = (t * P + w / 2) % P, px, py;
      if (d < w) { px = x + d; py = y; } else if (d < w + h) { px = x + w; py = y + d - w; }
      else if (d < 2 * w + h) { px = x + w - (d - w - h); py = y + h; } else { px = x; py = y + h - (d - 2 * w - h); }
      pts.push(px, py);
    }
    for (let i = 0; i < pts.length; i += 2) (i ? g.lineTo : g.moveTo).call(g, pts[i], pts[i + 1]);
  }
  function fitText(g, t, w) {
    let s = String(t);
    if (g.measureText(s).width <= w) return s;
    while (s.length > 1 && g.measureText(s + '…').width > w) s = s.slice(0, -1);
    return s + '…';
  }

  root.P8Art = { DESIGN, LAYOUT, C, k, tx, ty, fx, fy, paintTable, makeBall, roll, drawBall, drawShadow, drawCue,
                 drawGuide, drawPower, drawFine, drawBar, drawMsg, drawHint, drawVS, drawSpinPicker, drawCall, drawInHand,
                 iconBall, GUIDE, ballColor };
})(typeof self !== 'undefined' ? self : this);
