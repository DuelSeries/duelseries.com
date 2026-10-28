'use strict';
/* ─── 8 Ball Pool, the paint ──────────────────────────────────────────────────
   Everything on the canvas is drawn here, by code: the table, the balls, the
   cue, the aim guide, the power bar, the top bar and the messages. No image,
   font or sound of Miniclip's is used; the LAYOUT and COLOURS follow theirs as
   MEASURED on its guest build (docs/pool8-reference.md), so every position below
   is in the reference's own canvas: 1154 x 768 native px, origin top left.

   The balls are real spheres: each one is shaded pixel by pixel from its own
   orientation (a 3x3 rotation the screen turns as the ball rolls), so a stripe
   rolls over and a number turns away the way a ball does. Small canvases, cached
   until the ball moves. */

(function (root) {
  const Sim = root.P8Sim;
  const P8 = Sim.P8;

  const DESIGN = { w: 1154, h: 768 };
  const LAYOUT = {
    bar: { y: 0, h: 120 },
    field: { x: 152, y: 243.5, w: 849.5, h: 424.75 },   // cushion nose to cushion nose (MEASURED)
    rail: { x: 105, y: 195, w: 943, h: 521 },           // the rail's outside edge (MEASURED)
    cushion: 16,                                        // the blue cushion strip inside the rail (MEASURED)
    ret: { x: 1048, y: 288, w: 62, h: 400, ch: 1094.5, bottom: 672, pitch: 25 },   // the chrome ball return (MEASURED)
    power: { x: 30, y: 214, w: 46, h: 412 },            // phone only: the reference app's power bar on the left
    fine: { x: 1116, y: 214, w: 32, h: 412 },           // phone only: the fine-aim wheel on the right
    menu: { x: 10, y: 31, w: 64, h: 61 },
    star: [{ x: 176, y: 53 }, { x: 978, y: 53 }],
    name: [{ x: 190, w: 215 }, { x: 745, w: 220 }],
    slot0: [168, 763], slotStep: 37, slotY: 91, slotR: 15.5,
    avatar: [{ x: 424, y: 13, s: 92 }, { x: 638, y: 13, s: 92 }],
    mid: { x: 530, y: 16, w: 94, h: 86 },
    spin: { x: 1110, y: 60, r: 36 },
    msg: { x: 789, y: 747 },
    hint: { y: 150, y2: 268 },
  };

  // Colours MEASURED on the reference's frames (docs/pool8-reference.md "Look").
  const C = {
    bg: '#192336', bgEdge: '#121a29', bar: '#26242d', barHi: '#312f3b', barEdge: '#706f7c', barLow: '#101423',
    slot: '#151519', slotRim: '#030307', plate: '#1c1b22',
    feltHi: '#74bacc', feltMid: '#307b9d', feltLo: '#1f6181', feltCorner: '#1a5e80',
    cushion: '#3183ae', cushionTop: '#287096', cushionHi: '#4dc4e7',
    railOut: '#520802', railHi: '#933429', railIn: '#690e06', metal: '#4b404e', metalHi: '#b9b4bf',
    pocket: '#0d0101', pocketRim: '#450000', diamond: '#f2efe9', headLine: 'rgba(100,156,180,0.75)',
    text: '#ffffff', textDim: '#b7b6c2', hint: '#8e95a8', turn: '#00ff00', turnLate: '#ff9a1a',
    menuHi: '#24cc1d', menuLo: '#07aa01', guide: '#eeeeee', msgBg: 'rgba(0,0,0,0.9)',
    avatar: '#0277be', avatarHi: '#4fb3ee', frameOn: '#e9efd9', frameOff: '#3e4a44',
  };
  const BALL = {
    1: '#f4c20d', 2: '#1f4fd1', 3: '#d42a1e', 4: '#5b2a8c', 5: '#f07a12', 6: '#127a3b', 7: '#8a1e1c', 8: '#151515',
  };
  const ballColor = (n) => (n === 0 ? '#f7f5ee' : BALL[n > 8 ? n - 8 : n]);

  /* ── the transform: table units -> canvas px ───────────────────────────── */
  const F = LAYOUT.field;
  const k = F.w / P8.L;                                    // canvas px per table unit (0.8495)
  const tx = (x) => F.x + x * k, ty = (y) => F.y + y * k;
  const fx = (dx) => (dx - F.x) / k, fy = (dy) => (dy - F.y) / k;
  // Where the i-th potted ball sits in the return rail (from the bottom up).
  const retPos = (i) => ({ x: LAYOUT.ret.ch, y: LAYOUT.ret.bottom - i * LAYOUT.ret.pitch });

  /* ── the table, painted once per size ──────────────────────────────────────
     look: a free look of shared/pool8Looks.js (its cloth), or null for the reference's blue. */
  function paintTable(g, s, look) {
    const R = LAYOUT.rail, CU = LAYOUT.cushion;
    const K = look && look.cloth
      ? { hi: look.cloth.hi, mid: look.cloth.mid, lo: look.cloth.lo, corner: look.cloth.lo, cushion: look.cloth.cushion, cushionTop: look.cloth.cushion, cushionHi: look.cloth.cushionHi }
      : { hi: C.feltHi, mid: C.feltMid, lo: C.feltLo, corner: C.feltCorner, cushion: C.cushion, cushionTop: C.cushionTop, cushionHi: C.cushionHi };
    g.save();
    g.scale(s, s);
    // The room: navy, a little darker toward the edges.
    const room = g.createRadialGradient(577, 455, 80, 577, 455, 760);
    room.addColorStop(0, '#1d2a40'); room.addColorStop(1, C.bgEdge);
    g.fillStyle = room; g.fillRect(0, 0, DESIGN.w, DESIGN.h);

    // The ball return: a chrome wire track leaving the right rail and running down beside it.
    paintReturn(g);

    // Shadow under the table, then the rail as four cylinders of red.
    g.fillStyle = 'rgba(0,0,0,0.5)';
    roundRect(g, R.x - 4, R.y + 6, R.w + 8, R.h + 8, 22); g.fill();
    const rail = (x, y, w, h, vertical) => {
      const gr = vertical ? g.createLinearGradient(x, 0, x + w, 0) : g.createLinearGradient(0, y, 0, y + h);
      const far = vertical ? x > 500 : y > 400;
      gr.addColorStop(far ? 1 : 0, C.railOut); gr.addColorStop(0.45, C.railHi); gr.addColorStop(far ? 0 : 1, C.railIn);
      g.fillStyle = gr; g.fillRect(x, y, w, h);
    };
    const inX = F.x - CU, inY = F.y - CU, inW = F.w + 2 * CU, inH = F.h + 2 * CU;
    rail(R.x, R.y, R.w, inY - R.y, false);
    rail(R.x, inY + inH, R.w, R.y + R.h - inY - inH, false);
    rail(R.x, R.y, inX - R.x, R.h, true);
    rail(inX + inW, R.y, R.x + R.w - inX - inW, R.h, true);

    // Metal plates round the corner pockets.
    for (const [cx, cy] of [[R.x, R.y], [R.x + R.w, R.y], [R.x, R.y + R.h], [R.x + R.w, R.y + R.h]]) {
      const sx = cx < 500 ? 1 : -1, sy = cy < 400 ? 1 : -1;
      g.beginPath();
      g.moveTo(cx, cy + sy * 70); g.lineTo(cx, cy + sy * 16); g.arcTo(cx, cy, cx + sx * 16, cy, 16);
      g.lineTo(cx + sx * 70, cy); g.lineTo(cx + sx * 70, cy + sy * 26); g.quadraticCurveTo(cx + sx * 34, cy + sy * 30, cx + sx * 26, cy + sy * 70);
      g.closePath();
      const mg = g.createLinearGradient(cx, cy, cx + sx * 70, cy + sy * 70);
      mg.addColorStop(0, C.metalHi); mg.addColorStop(0.5, '#7d7684'); mg.addColorStop(1, C.metal);
      g.fillStyle = mg; g.fill();
    }

    // The felt: lit from above, brightest a little left of the middle.
    const fg = g.createRadialGradient(580, 400, 20, 580, 420, 560);
    fg.addColorStop(0, K.hi); fg.addColorStop(0.45, K.mid); fg.addColorStop(0.85, K.lo); fg.addColorStop(1, K.corner);
    g.fillStyle = fg;
    g.fillRect(inX, inY, inW, inH);
    // The cloth's grain (the reference's felt is visibly textured): fixed speckle, the same every paint.
    let seed = 12345;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 9000; i++) {
      g.fillStyle = rnd() < 0.5 ? 'rgba(255,255,255,0.045)' : 'rgba(0,0,0,0.06)';
      g.fillRect(inX + rnd() * inW, inY + rnd() * inH, 1.4, 1.4);
    }

    // The cushions: blue bevels along each rail, cut away at the pocket mouths (the rail segments of pool8Sim).
    g.save();
    g.beginPath(); g.rect(inX, inY, inW, inH); g.clip();
    const S = Sim.SEGS;
    const cushions = [
      { a: [tx(S[0].ax), F.y], b: [tx(S[0].bx), F.y], n: [0, -1], top: true },
      { a: [tx(S[1].ax), F.y], b: [tx(S[1].bx), F.y], n: [0, -1], top: true },
      { a: [tx(S[2].ax), F.y + F.h], b: [tx(S[2].bx), F.y + F.h], n: [0, 1] },
      { a: [tx(S[3].ax), F.y + F.h], b: [tx(S[3].bx), F.y + F.h], n: [0, 1] },
      { a: [F.x, ty(S[4].ay)], b: [F.x, ty(S[4].by)], n: [-1, 0] },
      { a: [F.x + F.w, ty(S[5].ay)], b: [F.x + F.w, ty(S[5].by)], n: [1, 0] },
    ];
    for (const c of cushions) {
      const [ax, ay] = c.a, [bx, by] = c.b, [nx, ny] = c.n;
      const ux = Math.sign(bx - ax), uy = Math.sign(by - ay);
      g.beginPath();
      g.moveTo(ax, ay); g.lineTo(bx, by);
      g.lineTo(bx + nx * CU + ux * CU * 0.9, by + ny * CU + uy * CU * 0.9);
      g.lineTo(ax + nx * CU - ux * CU * 0.9, ay + ny * CU - uy * CU * 0.9);
      g.closePath();
      g.fillStyle = c.top ? K.cushionTop : K.cushion; g.fill();
      g.strokeStyle = K.cushionHi; g.lineWidth = 2.2;
      g.beginPath(); g.moveTo(ax, ay + ny * 0.8); g.lineTo(bx, by + ny * 0.8); g.stroke();
    }
    g.restore();

    // Pockets: the holes, where the reference has them.
    for (const p of Sim.POCKETS) {
      const px = tx(p.x), py = ty(p.y), pr = p.r * k;
      const pg = g.createRadialGradient(px, py, pr * 0.25, px, py, pr);
      pg.addColorStop(0, C.pocket); pg.addColorStop(0.82, '#120202'); pg.addColorStop(1, C.pocketRim);
      g.beginPath(); g.arc(px, py, pr, 0, Math.PI * 2); g.fillStyle = pg; g.fill();
    }
    // The head string the break is placed behind.
    g.strokeStyle = C.headLine; g.lineWidth = 1.2;
    line(g, tx(P8.HEAD_X * P8.L), F.y, tx(P8.HEAD_X * P8.L), F.y + F.h);
    // Diamonds: six on each long rail, three on each short one, 34 px outside the nose.
    g.fillStyle = C.diamond;
    for (const kk of [1, 2, 3, 5, 6, 7]) {
      const x = F.x + F.w * kk / 8;
      dot(g, x, F.y - 34, 2.2); dot(g, x, F.y + F.h + 34, 2.2);
    }
    for (const kk of [1, 2, 3]) {
      const y = F.y + F.h * kk / 4;
      dot(g, F.x - 34, y, 2.2); dot(g, F.x + F.w + 34, y, 2.2);
    }
    g.restore();
  }

  // Four chrome wires in two loops; the balls run in the channel between the inner pair.
  function paintReturn(g) {
    const xs = [1108, 1099, 1089, 1080], tops = [290, 299, 309, 318], bottom = 688;
    g.save();
    g.lineCap = 'round';
    for (const pass of [{ w: 3.2, c: 'rgba(0,0,0,0.55)', dy: 2 }, { w: 2, c: '#c9ccd4', dy: 0 }]) {
      g.strokeStyle = pass.c; g.lineWidth = pass.w;
      for (const [o, i] of [[0, 3], [1, 2]]) {
        const xo = xs[o], xi = xs[i], to = tops[o] + pass.dy, ti = tops[i] + pass.dy, r = (xo - xi) / 2, b = bottom + pass.dy - (o ? 6 : 0);
        g.beginPath();
        g.moveTo(1046, to); g.lineTo(xo - 14, to); g.quadraticCurveTo(xo, to, xo, to + 14);
        g.lineTo(xo, b - r); g.arc(xo - r, b - r, r, 0, Math.PI, false);
        g.lineTo(xi, ti + 8); g.quadraticCurveTo(xi, ti, xi - 8, ti); g.lineTo(1046, ti);
        g.stroke();
      }
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
  // The number disc: about 0.6 of the ball's radius across, as big as the reference's (side by side, 2026-10-28).
  const DISC_A = 0.64, DISC = Math.cos(DISC_A), DISC_S = Math.sin(DISC_A);
  function glyph(n) {
    if (glyphs[n]) return glyphs[n];
    const SZ = 48, c = mk(SZ, SZ), g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, SZ, SZ);
    g.fillStyle = '#111';
    g.font = '900 ' + (n > 9 ? 27 : 33) + 'px Archivo, Arial, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(n), SZ / 2, SZ / 2 + 2);
    if (n === 6 || n === 9) g.fillRect(SZ / 2 - 7, SZ / 2 + 14, 14, 2.5);
    glyphs[n] = { S: SZ, d: g.getImageData(0, 0, SZ, SZ).data };
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
    const r = [t * ax * ax + c, t * ax * ay, s * ay, t * ax * ay, t * ay * ay + c, -s * ax, -s * ay, s * ax, c];
    b.m = mul(r, b.m);
    b.dirty = true;
  }
  function paintBall(b, px) {
    const SZ = Math.max(8, Math.ceil(px * 2) + 2);
    if (!b.c || b.c.width !== SZ) { b.c = mk(SZ, SZ); b.dirty = true; }
    if (!b.dirty && b.px === px) return b.c;
    b.dirty = false; b.px = px;
    const g = b.c.getContext('2d');
    const img = g.createImageData(SZ, SZ), out = img.data;
    const m = b.m, n = b.n, col = b.col, stripe = n > 8, gl = n > 0 ? glyph(n) : null;
    const r = SZ / 2 - 1, cx = SZ / 2, cy = SZ / 2;
    for (let y = 0; y < SZ; y++) {
      for (let x = 0; x < SZ; x++) {
        const u = (x + 0.5 - cx) / r, v = (y + 0.5 - cy) / r, q = u * u + v * v;
        if (q > 1) continue;
        const w = Math.sqrt(1 - q);
        const bx = m[0] * u + m[3] * v + m[6] * w;
        const by = m[1] * u + m[4] * v + m[7] * w;
        const bz = m[2] * u + m[5] * v + m[8] * w;
        let R0, G0, B0;
        if (stripe && Math.abs(by) > 0.52) { R0 = 246; G0 = 243; B0 = 234; }
        else { R0 = col[0]; G0 = col[1]; B0 = col[2]; }
        if (gl && Math.abs(bz) > DISC) {
          const sgn = bz > 0 ? 1 : -1;
          const gx = (bx * sgn / DISC_S * 0.5 + 0.5) * gl.S, gy = (by / DISC_S * 0.5 + 0.5) * gl.S;
          const gi = ((Math.min(gl.S - 1, Math.max(0, gy | 0))) * gl.S + Math.min(gl.S - 1, Math.max(0, gx | 0))) * 4;
          R0 = gl.d[gi]; G0 = gl.d[gi + 1]; B0 = gl.d[gi + 2];
        }
        const dif = Math.max(0, u * LIGHT[0] + v * LIGHT[1] + w * LIGHT[2]);
        const spec = Math.pow(Math.max(0, u * HALF[0] + v * HALF[1] + w * HALF[2]), 70) * 235;
        const shade = 0.42 + 0.68 * dif;
        const edge = q > 0.86 ? 1 - (q - 0.86) * 1.6 : 1;
        const i = (y * SZ + x) * 4;
        out[i] = Math.min(255, R0 * shade * edge + spec);
        out[i + 1] = Math.min(255, G0 * shade * edge + spec);
        out[i + 2] = Math.min(255, B0 * shade * edge + spec);
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
    // The thin dark outline every ball has on the reference (its cue ball: 23 px of cream, 25 with the outline).
    g.beginPath(); g.arc(x * s, y * s, pr, 0, Math.PI * 2);
    g.lineWidth = Math.max(0.8, s * 1.1); g.strokeStyle = 'rgba(0,0,0,0.45)'; g.stroke();
    g.globalAlpha = 1;
  }
  function drawShadow(g, x, y, s) {
    const pr = P8.R * k * s;
    g.beginPath();
    g.ellipse(x * s + pr * 0.3, y * s + pr * 0.35, pr * 1.02, pr * 0.9, 0, 0, Math.PI * 2);
    g.fillStyle = 'rgba(0,0,0,0.3)';
    g.fill();
  }

  /* ── the cue, the guide, the power bar ─────────────────────────────────── */
  /* The cue stick behind the cue ball along `a`, its tip `pull` px past the rest gap (the reference rests the tip
     26 px from the ball's centre and draws it back to 161 at full pull, MEASURED). cue: a free look's colours. */
  const CUE = { shaft: '#e2c08a', butt: '#6b3a1c', joint: '#1b1b1b' };
  function drawCue(g, cx, cy, a, pull, s, cue) {
    const Q = cue || CUE;
    const len = 760, ux = Math.cos(a), uy = Math.sin(a);
    const x0 = cx - ux * (26 + pull), y0 = cy - uy * (26 + pull);
    const x1 = x0 - ux * len, y1 = y0 - uy * len;
    g.save(); g.scale(s, s);
    g.lineCap = 'butt';
    g.strokeStyle = 'rgba(0,0,0,0.18)'; g.lineWidth = 6;
    line(g, x0 + 3, y0 + 5, x1 + 3, y1 + 5);
    const seg = (fa, fb, w0, col) => {
      g.strokeStyle = col; g.lineWidth = w0;
      line(g, x0 - ux * len * fa, y0 - uy * len * fa, x0 - ux * len * fb, y0 - uy * len * fb);
    };
    seg(0, 0.005, 5.6, '#3d78c9');        // tip
    seg(0.005, 0.02, 5.8, '#f4f1e6');     // ferrule
    seg(0.02, 0.6, 6, Q.shaft);           // shaft
    seg(0.6, 0.63, 7, Q.joint);           // joint
    seg(0.63, 1, 8, Q.butt);              // butt
    g.strokeStyle = 'rgba(255,255,255,0.3)'; g.lineWidth = 1.4;
    line(g, x0 - ux * len * 0.02 - uy * 1.4, y0 - uy * len * 0.02 + ux * 1.4, x1 - uy * 2, y1 + ux * 2);
    g.restore();
  }

  /* The guide (MEASURED on the reference): a #eeeeee line 3 px wide with a dark edge from the cue ball to the ghost
     ring (one ball across) at the first ball or cushion it would touch, and from a ball hit the object ball's line,
     1.52 ball diameters long. A first ball the shooter may not hit gets a red no-entry ring instead. */
  const GUIDE = { obj: 1.52, width: 3 };
  function drawGuide(g, cx, cy, gd, s, warn) {
    g.save(); g.scale(s, s);
    const R = P8.R * k, gx = tx(gd.gx), gy = ty(gd.gy);
    const dx = gx - cx, dy = gy - cy, dl = Math.hypot(dx, dy) || 1;
    const stroke = (fn, w, col) => { g.strokeStyle = col; g.lineWidth = w; fn(); };
    const main = () => line(g, cx + dx / dl * R, cy + dy / dl * R, gx - dx / dl * R, gy - dy / dl * R);
    const ring = () => { g.beginPath(); g.arc(gx, gy, R - 1.5, 0, Math.PI * 2); g.stroke(); };
    stroke(main, GUIDE.width + 2, 'rgba(0,0,0,0.75)'); stroke(main, GUIDE.width, C.guide);
    if (warn) {
      stroke(ring, 5, 'rgba(0,0,0,0.6)'); stroke(ring, 3, '#e8262b');
      g.strokeStyle = '#e8262b'; g.lineWidth = 3;
      line(g, gx - R * 0.6, gy + R * 0.6, gx + R * 0.6, gy - R * 0.6);
    } else {
      stroke(ring, GUIDE.width + 2, 'rgba(0,0,0,0.75)'); stroke(ring, GUIDE.width, C.guide);
      if (gd.kind === 'ball') {
        const ox = tx(gd.gx) + gd.ox * 2 * R, oy = ty(gd.gy) + gd.oy * 2 * R, Lb = GUIDE.obj * 2 * R;
        const obj = () => line(g, ox, oy, ox + gd.ox * Lb, oy + gd.oy * Lb);
        stroke(obj, GUIDE.width + 2, 'rgba(0,0,0,0.75)'); stroke(obj, GUIDE.width, C.guide);
      }
    }
    g.restore();
  }

  // Phone only: the vertical power bar (the reference app's), the cue inside it pulled down as the power grows.
  function drawPower(g, p, s, active) {
    const P = LAYOUT.power;
    g.save(); g.scale(s, s);
    roundRect(g, P.x, P.y, P.w, P.h, P.w / 2);
    g.fillStyle = 'rgba(8,10,18,0.85)'; g.fill();
    g.lineWidth = 2; g.strokeStyle = active ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.18)'; g.stroke();
    const ih = (P.h - 12) * p;
    if (p > 0) {
      const gr = g.createLinearGradient(0, P.y + 6, 0, P.y + P.h - 6);
      gr.addColorStop(0, '#3fd14a'); gr.addColorStop(0.55, '#f1d33a'); gr.addColorStop(1, '#e8402c');
      g.save(); roundRect(g, P.x + 6, P.y + 6, P.w - 12, P.h - 12, (P.w - 12) / 2); g.clip();
      g.fillStyle = gr; g.fillRect(P.x + 6, P.y + 6, P.w - 12, ih);
      g.restore();
    }
    const cx = P.x + P.w / 2, top = P.y + 10 + ih;
    g.lineCap = 'round';
    g.strokeStyle = CUE.shaft; g.lineWidth = 6; line(g, cx, top, cx, Math.min(P.y + P.h - 8, top + P.h * 0.7));
    g.strokeStyle = '#f4f1e6'; g.lineWidth = 6; line(g, cx, top, cx, top + 6);
    g.restore();
  }
  // Phone only: the fine-aim wheel at the right edge, its ridges rolling as the aim turns.
  function drawFine(g, a, s) {
    const Fn = LAYOUT.fine, x = Fn.x, y = Fn.y, w = Fn.w, h = Fn.h;
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
     hud: { names[2], initials[2], active (0|1|-1), timeFrac (1..0), groups[2], potted (numbers off the table),
            spin {x, y}, late (the clock bubble) } */
  function drawBar(g, hud, s) {
    g.save(); g.scale(s, s);
    const B = LAYOUT.bar;
    const bg = g.createLinearGradient(0, B.y, 0, B.y + B.h);
    bg.addColorStop(0, C.barHi); bg.addColorStop(1, C.bar);
    g.fillStyle = bg; g.fillRect(0, B.y, DESIGN.w, B.h);
    g.fillStyle = C.barEdge; g.fillRect(0, B.h - 1, DESIGN.w, 1);
    g.fillStyle = C.barLow; g.fillRect(0, B.h, DESIGN.w, 2);

    // The menu button.
    const M = LAYOUT.menu;
    roundRect(g, M.x, M.y, M.w, M.h, 10);
    const mg = g.createLinearGradient(0, M.y, 0, M.y + M.h);
    mg.addColorStop(0, C.menuHi); mg.addColorStop(1, C.menuLo);
    g.fillStyle = mg; g.fill(); g.lineWidth = 2.5; g.strokeStyle = '#05540a'; g.stroke();
    g.fillStyle = '#fff';
    for (let i = 0; i < 3; i++) { roundRect(g, M.x + 15, M.y + 15 + i * 12, M.w - 30, 6, 3); g.fill(); }

    for (let side = 0; side < 2; side++) {
      const A = LAYOUT.avatar[side], N = LAYOUT.name[side], ST = LAYOUT.star[side];
      const active = hud.active === side;
      // The name on its dark plate, the level star at its outer end.
      roundRect(g, N.x - 6, 42, N.w + 12, 30, 5); g.fillStyle = C.plate; g.fill();
      g.font = '700 21px Archivo, Arial, sans-serif';
      g.textBaseline = 'middle'; g.textAlign = side === 0 ? 'left' : 'right';
      g.fillStyle = active ? C.text : C.textDim;
      g.fillText(fitText(g, hud.names[side] || '', N.w - 10), side === 0 ? N.x + 8 : N.x + N.w - 8, 58);
      star(g, ST.x, ST.y, 18);
      // Seven slots: the group's balls once groups are set, a potted one dark again.
      const grp = hud.groups[side];
      for (let i = 0; i < 7; i++) {
        const sx = LAYOUT.slot0[side] + i * LAYOUT.slotStep, sy = LAYOUT.slotY;
        g.beginPath(); g.arc(sx, sy, LAYOUT.slotR, 0, Math.PI * 2); g.fillStyle = C.slot; g.fill();
        g.lineWidth = 1.5; g.strokeStyle = C.slotRim; g.stroke();
        if (grp) {
          const n = grp === 'solids' ? i + 1 : i + 9;
          if (!(hud.potted || []).includes(n)) iconBall(g, n, sx, sy, LAYOUT.slotR - 2);
        }
      }
      // The avatar: a pale frame on whoever is up, the shot clock draining round it.
      roundRect(g, A.x, A.y, A.s, A.s, 12);
      g.fillStyle = active ? C.frameOn : C.frameOff; g.fill();
      roundRect(g, A.x + 7, A.y + 7, A.s - 14, A.s - 14, 8);
      const ag = g.createLinearGradient(0, A.y, 0, A.y + A.s);
      ag.addColorStop(0, C.avatarHi); ag.addColorStop(1, C.avatar);
      g.fillStyle = ag; g.fill();
      g.fillStyle = 'rgba(255,255,255,0.95)';
      g.font = '900 46px Archivo, Arial, sans-serif'; g.textAlign = 'center';
      g.fillText((hud.initials[side] || '?').toUpperCase(), A.x + A.s / 2, A.y + A.s / 2 + 3);
      if (active && hud.timeFrac >= 0) {
        const f = Math.max(0, Math.min(1, hud.timeFrac));
        g.lineWidth = 5;
        g.strokeStyle = f > 0.28 ? C.turn : C.turnLate;
        g.beginPath(); perimeter(g, A.x + 2.5, A.y + 2.5, A.s - 5, A.s - 5, f); g.stroke();
        if (hud.late) {
          // "Clock is ticking." under the avatar, the reference's bubble.
          g.font = '700 16px Archivo, Arial, sans-serif';
          const t = 'Clock is ticking.', w = g.measureText(t).width + 22, bx = A.x + A.s / 2 - w / 2;
          roundRect(g, bx, 124, w, 30, 8); g.fillStyle = '#ffffff'; g.fill();
          g.beginPath(); g.moveTo(A.x + A.s / 2 - 7, 125); g.lineTo(A.x + A.s / 2, 116); g.lineTo(A.x + A.s / 2 + 7, 125); g.fill();
          g.fillStyle = '#26242d'; g.textAlign = 'center'; g.fillText(t, A.x + A.s / 2, 140);
        }
      }
    }
    // The middle tile: three balls (ours), the game's icon.
    const D = LAYOUT.mid;
    roundRect(g, D.x, D.y, D.w, D.h, 12); g.fillStyle = '#16151b'; g.fill();
    g.lineWidth = 1.5; g.strokeStyle = '#3c3a45'; g.stroke();
    iconBall(g, 11, D.x + 34, D.y + 52, 17);
    iconBall(g, 5, D.x + 46, D.y + 32, 17);
    iconBall(g, 3, D.x + 62, D.y + 50, 17);

    // The spin button: the cue ball, a red ring where the tip will strike.
    const SP = LAYOUT.spin;
    iconBall(g, 0, SP.x, SP.y, SP.r);
    g.beginPath(); g.arc(SP.x, SP.y, SP.r, 0, Math.PI * 2); g.lineWidth = 2; g.strokeStyle = '#989994'; g.stroke();
    g.beginPath(); g.arc(SP.x + hud.spin.x * SP.r * 0.6, SP.y - hud.spin.y * SP.r * 0.6, 6, 0, Math.PI * 2);
    g.lineWidth = 2.5; g.strokeStyle = '#e8262b'; g.stroke();
    g.restore();
  }

  function star(g, x, y, r) {
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.48 : r;
      g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    g.closePath();
    const sg = g.createLinearGradient(0, y - r, 0, y + r);
    sg.addColorStop(0, '#f6dd84'); sg.addColorStop(1, '#b8893a');
    g.fillStyle = sg; g.fill();
    g.lineWidth = 1.2; g.strokeStyle = '#6b4c17'; g.stroke();
  }

  // A flat lit ball for the bar (slots, the middle tile, the spin button).
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

  // The black pill low on the screen ("You are breaking, good luck!").
  function drawMsg(g, text, s, alpha) {
    if (!text) return;
    g.save(); g.scale(s, s);
    g.globalAlpha = alpha === undefined ? 1 : alpha;
    g.font = '700 21px Archivo, Arial, sans-serif';
    const w = g.measureText(text).width + 36, x = Math.min(DESIGN.w - w - 30, LAYOUT.msg.x - w / 2), y = LAYOUT.msg.y - 17;
    roundRect(g, x, y, w, 34, 7); g.fillStyle = C.msgBg; g.fill();
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, x + w / 2, y + 18);
    g.restore();
  }
  // The tutorial lines: grey over the table, then faint on the felt.
  function drawHint(g, text, s, text2) {
    g.save(); g.scale(s, s);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    if (text) { g.font = '800 30px Archivo, Arial, sans-serif'; g.fillStyle = C.hint; g.fillText(text, F.x + F.w / 2, LAYOUT.hint.y); }
    if (text2) { g.font = '700 22px Archivo, Arial, sans-serif'; g.fillStyle = 'rgba(255,255,255,0.42)'; g.fillText(text2, F.x + F.w / 2, LAYOUT.hint.y2); }
    g.restore();
  }
  // "You are Stripes!": big grey letters with depth across the middle of the table.
  function drawBanner(g, text, s, alpha) {
    g.save(); g.scale(s, s);
    g.globalAlpha = alpha;
    g.font = '900 64px Archivo, Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const x = F.x + F.w / 2, y = F.y + F.h / 2;
    g.fillStyle = 'rgba(0,0,0,0.55)'; for (let d = 6; d > 0; d--) g.fillText(text, x + d * 0.6, y + d);
    const gr = g.createLinearGradient(0, y - 30, 0, y + 30);
    gr.addColorStop(0, '#f2f2f2'); gr.addColorStop(1, '#a9a9ad');
    g.fillStyle = gr; g.fillText(text, x, y);
    g.restore();
  }

  /* The opening: the two player cards and VS over a warm burst (ours: no figures, no title art). */
  function drawVS(g, names, initials, title, f, s) {
    g.save(); g.scale(s, s);
    const t = Math.min(1, f * 3), cx = DESIGN.w / 2;
    const bg = g.createRadialGradient(cx, 400, 30, cx, 400, 700);
    bg.addColorStop(0, '#f7b955'); bg.addColorStop(0.45, '#c46a1c'); bg.addColorStop(1, '#4a1d06');
    g.fillStyle = bg; g.fillRect(0, 0, DESIGN.w, DESIGN.h);
    g.save(); g.translate(cx, 420); g.globalAlpha = 0.18; g.fillStyle = '#fff3c4';
    for (let i = 0; i < 18; i++) { g.rotate(Math.PI / 9); g.beginPath(); g.moveTo(0, 0); g.lineTo(760, -64); g.lineTo(760, 64); g.fill(); }
    g.restore();
    g.font = '900 70px Archivo, Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 9; g.strokeStyle = '#1d4a12'; g.strokeText(title, cx, 80);
    g.fillStyle = '#a6f06b'; g.fillText(title, cx, 80);
    for (let side = 0; side < 2; side++) {
      const w = 216, h = 260, x = side === 0 ? cx - 330 - (1 - t) * 320 : cx + 114 + (1 - t) * 320, y = 270;
      roundRect(g, x, y, w, h, 14); g.fillStyle = '#5f6170'; g.fill(); g.lineWidth = 4; g.strokeStyle = '#2d2e38'; g.stroke();
      roundRect(g, x + 16, y + 16, w - 32, h - 80, 10);
      const ag = g.createLinearGradient(0, y, 0, y + h);
      ag.addColorStop(0, C.avatarHi); ag.addColorStop(1, C.avatar);
      g.fillStyle = ag; g.fill();
      g.fillStyle = '#fff'; g.font = '900 104px Archivo, Arial, sans-serif';
      g.fillText((initials[side] || '?').toUpperCase(), x + w / 2, y + 16 + (h - 80) / 2 + 4);
      roundRect(g, x + 12, y + h - 54, w - 24, 38, 8); g.fillStyle = '#22232b'; g.fill();
      g.fillStyle = '#fff'; g.font = '800 18px Archivo, Arial, sans-serif';
      g.fillText(fitText(g, names[side] || '', w - 36), x + w / 2, y + h - 34);
    }
    g.globalAlpha = t;
    g.font = '900 88px Archivo, Arial, sans-serif';
    g.lineWidth = 10; g.strokeStyle = '#173c0e'; g.strokeText('VS', cx, 400);
    g.fillStyle = '#9be35c'; g.fillText('VS', cx, 400);
    g.restore();
  }

  /* The spin picker: a big cue ball, the red dot where the tip will strike, dragged anywhere inside the ring. */
  function drawSpinPicker(g, spin, s) {
    g.save(); g.scale(s, s);
    g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(0, 0, DESIGN.w, DESIGN.h);
    const cx = DESIGN.w / 2, cy = 430, r = 160;
    iconBall(g, 0, cx, cy, r);
    g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 2;
    line(g, cx - r, cy, cx + r, cy); line(g, cx, cy - r, cx, cy + r);
    g.beginPath(); g.arc(cx, cy, r * 0.62, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(cx + spin.x * r * 0.62, cy - spin.y * r * 0.62, 19, 0, Math.PI * 2);
    g.fillStyle = '#e8262b'; g.fill(); g.lineWidth = 3; g.strokeStyle = '#fff'; g.stroke();
    g.fillStyle = '#fff'; g.font = '800 23px Archivo, Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('Set the spin, then tap outside the ball', cx, cy + r + 44);
    g.restore();
    return { cx, cy, r: r * 0.62, R: r };
  }

  // The pocket called for the 8: a pulsing ring round it.
  function drawCall(g, k0, s, pulse) {
    const p = Sim.POCKETS[k0];
    if (!p) return;
    g.save(); g.scale(s, s);
    const x = tx(p.x), y = ty(p.y), r = p.r * k + 5 + pulse * 3;
    g.lineWidth = 4; g.strokeStyle = '#f7e03c';
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke();
    g.restore();
  }

  // A cue ball that may be moved (ball in hand): a dashed ring, red with a bar where it may not go.
  function drawInHand(g, x, y, s, ok) {
    g.save(); g.scale(s, s);
    const R = P8.R * k;
    g.beginPath(); g.arc(x, y, R + 6, 0, Math.PI * 2);
    g.lineWidth = 2.5; g.strokeStyle = ok ? 'rgba(255,255,255,0.9)' : 'rgba(232,38,43,0.95)';
    g.setLineDash([5, 4]); g.stroke(); g.setLineDash([]);
    if (!ok) { g.strokeStyle = '#e8262b'; g.lineWidth = 3; line(g, x - R * 0.7, y + R * 0.7, x + R * 0.7, y - R * 0.7); }
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
  // The first `f` of a rectangle's outline, clockwise from the top middle.
  function perimeter(g, x, y, w, h, f) {
    const N = 120, P = 2 * (w + h);
    for (let i = 0; i <= N * f; i++) {
      const d = (i / N * P + w / 2) % P;
      let px, py;
      if (d < w) { px = x + d; py = y; } else if (d < w + h) { px = x + w; py = y + d - w; }
      else if (d < 2 * w + h) { px = x + w - (d - w - h); py = y + h; } else { px = x; py = y + h - (d - 2 * w - h); }
      if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
  }
  function fitText(g, t, w) {
    let s = String(t);
    if (g.measureText(s).width <= w) return s;
    while (s.length > 1 && g.measureText(s + '…').width > w) s = s.slice(0, -1);
    return s + '…';
  }

  root.P8Art = { DESIGN, LAYOUT, C, k, tx, ty, fx, fy, retPos, paintTable, makeBall, roll, drawBall, drawShadow, drawCue,
                 drawGuide, drawPower, drawFine, drawBar, drawMsg, drawHint, drawBanner, drawVS, drawSpinPicker,
                 drawCall, drawInHand, iconBall, GUIDE, ballColor };
})(typeof self !== 'undefined' ? self : this);
