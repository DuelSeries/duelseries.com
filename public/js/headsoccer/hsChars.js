'use strict';
/* ─── Head Soccer, the players and the ball ──────────────────────────────────
   Drawn in world units on a context the caller has transformed. The players
   are our own cartoon footballers (nobody real) built the way the reference
   builds its own: a big head, two floating hands, two boots, placed around the
   body centre where its code places them (docs/head-soccer-reference.md).

   The art is hand-drawn canvas paths in the reference's style (measured from
   its atlas: dark maroon outline, flat cel shading with halftone dots, white
   wristbands and socks, studded boots). Each part is painted once per screen
   scale into an offscreen canvas, so a frame is five drawImage calls a player.

   Units: every part is authored in "atlas px" of a frame the size of the
   reference's matching frame, facing right, and shown at the reference's
   sprite scale .5 of an image scale .45: one atlas px = U world units. */
(function (root) {
  const HS = root.HSSim.HS;
  const TAU = Math.PI * 2;
  const U = 0.5 / 0.45;                               // S: imageScale .45, player and ball sprites at scale .5
  // The pen and the measured colours are public/js/headsoccer/hsFaces.js (the heads, loaded before this file).
  const F = root.HSFaces, { INK, INK2, WHITE, WSHADE, WMID, WLITE, hexRgb, rgbHex, mix, kitOf, trace, shape, line, clipTo, dots } = F.pen;
  const SOLE = '#840f0c', STUD = '#ad1613', SOLELIT = '#ee3937';
  const DEFAULT_KIT = ['#ad1613', '#393295'];          // seat 0 red, seat 1 blue (their palette)
  let kits = [null, null];
  // The face each seat wears (shared/hsHeads.js ids); null is the seat's own.
  let heads = [null, null];
  function kitPal(side) { return kitOf(kits[side] || DEFAULT_KIT[side], DEFAULT_KIT[side]); }

  /* ── offscreen cache: one canvas per part per screen scale ──────────────── */
  const M = 4;                                        // margin around a frame for the outline, atlas px
  const cache = new Map(); let cacheK = 0;
  // k: device px per world unit; res: extra resolution for a part drawn larger (the kicking boot, 1.5x).
  function sprite(key, w, h, k, paint, res) {
    if (k !== cacheK) { cache.clear(); cacheK = k; }
    let c = cache.get(key);
    if (c) return c;
    const s = U * k * (res || 1);
    c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil((w + 2 * M) * s)); c.height = Math.max(1, Math.ceil((h + 2 * M) * s));
    const g = c.getContext('2d');
    g.setTransform(s, 0, 0, s, M * s, M * s); g.lineJoin = 'round'; g.lineCap = 'round';
    paint(g);
    cache.set(key, c);
    return c;
  }
  // Draw a cached frame with its anchor (ax, ay of the frame) at the origin.
  function blit(g, c, w, h, ax, ay) { g.drawImage(c, -(ax * w + M) * U, -(ay * h + M) * U, (w + 2 * M) * U, (h + 2 * M) * U); }

  /* ── the heads: public/js/headsoccer/hsFaces.js ───────────────────────── */
  function headSprite(side, k) {
    const id = F.faceOf(heads[side], side), fr = F.frame(id), kp = kitPal(side);
    return { c: sprite('h' + id + kp.base, fr.w, fr.h, k, (g) => F.paint(g, id, kp)), fr };
  }

  /* ── hands: a fist with a white wristband (hand-front 66 x 66, hand-back 73 x 62 atlas px) ── */
  // A wristband: a short white cylinder from (x, y) along angle a, its open end lighter.
  function cuff(g, x, y, a, len, r) {
    g.save(); g.translate(x, y); g.rotate(a);
    const P = [[0, -r, 1], [len, -r, 1], [len, r, 1], [0, r, 1]];
    shape(g, P, WHITE);
    g.save(); clipTo(g, P);
    for (const yy of [-r * 0.45, 0.05 * r, r * 0.55]) { g.fillStyle = WSHADE; g.fillRect(0, yy - 1, len, 2.2); }
    g.restore();
    shape(g, P, null, 2.3);
    g.beginPath(); g.ellipse(len, 0, r * 0.42, r, 0, 0, TAU); g.fillStyle = WLITE; g.fill(); g.strokeStyle = INK; g.lineWidth = 2.3; g.stroke();
    g.beginPath(); g.ellipse(len, 0, r * 0.22, r * 0.62, 0, 0, TAU); g.fillStyle = WMID; g.fill();
    g.restore();
  }
  function handFront(g, H) {
    cuff(g, 38, 17, -0.72, 23, 10);
    const P = [[3, 20, 1], [34, 8, 1], [48, 16], [54, 32], [56, 47], [50, 58, 1], [36, 62], [22, 64], [10, 59], [4, 46]];
    shape(g, P, H.skin);
    g.save(); clipTo(g, P);
    const SH = [[0, 40], [14, 46], [30, 50], [46, 45], [60, 38], [60, 70], [0, 70]];
    g.fillStyle = H.shade; g.beginPath(); trace(g, SH, true); g.fill();
    g.save(); g.beginPath(); trace(g, SH, true); g.clip(); dots(g, 0, 38, 60, 66, 3.4, 0.7, H.deep); g.restore();
    g.restore();
    shape(g, P, null, 2.6);
    line(g, [[12, 58], [11, 38]], 2.2); line(g, [[24, 63], [23, 44]], 2.2); line(g, [[37, 62], [36, 48]], 2.2);
  }
  function handBack(g, H) {
    const P = [[22, 12], [40, 3, 1], [56, 4], [64, 10], [72, 17], [73, 28], [69, 33, 1], [72, 43], [64, 54], [52, 61], [42, 60], [32, 55], [24, 44], [20, 28]];
    shape(g, P, H.skin);
    g.save(); clipTo(g, P);
    const SH = [[20, 30], [38, 26], [46, 40], [44, 62], [16, 62]];
    g.fillStyle = H.shade; g.beginPath(); trace(g, SH, true); g.fill();
    g.beginPath(); trace(g, [[48, 20], [72, 22], [74, 31], [50, 31]], true); g.fill();
    g.save(); g.beginPath(); trace(g, SH, true); g.clip(); dots(g, 16, 26, 48, 62, 3.4, 0.7, H.deep); g.restore();
    g.restore();
    shape(g, P, null, 2.6);
    line(g, [[30, 15], [46, 9], [60, 13], [64, 20]], 2.4);      // the thumb over the fingers
    line(g, [[48, 17], [46, 30], [44, 44], [45, 58]], 2.4);      // the fingers' tips
    line(g, [[46, 30], [58, 31], [69, 33]], 2.2); line(g, [[44, 44], [56, 45], [66, 50]], 2.2);
    cuff(g, 30, 25, -2.55, 22, 11);
  }
  // The hands take the skin of the face the seat wears.
  function handSprite(side, front, k) {
    const id = F.faceOf(heads[side], side), H = F.skin(id);
    return front ? sprite('hf' + id, 66, 66, k, (g) => handFront(g, H)) : sprite('hb' + id, 73, 62, k, (g) => handBack(g, H));
  }

  /* ── boots: sock, kit-coloured upper, white laces, red heel tab, studded sole (71 x 59 atlas px) ── */
  function boot(g, kp) {
    const red = (() => { const c = hexRgb(kp.base); return c && c[0] > c[1] + 60 && c[0] > c[2] + 60; })();
    // Sock (S: white 5..33 at the top, mostly hidden by the boot below y 20).
    const SO = [[6, 6, 1], [32, 6, 1], [32, 28, 1], [6, 28, 1]];
    shape(g, SO, WHITE);
    g.save(); clipTo(g, SO); g.fillStyle = WSHADE; g.fillRect(6, 6, 4, 24); g.fillRect(16, 6, 4, 24); g.fillRect(28, 6, 4, 24); g.restore();
    shape(g, SO, null, 2.6);
    g.beginPath(); g.ellipse(19, 6, 13, 4.6, 0, 0, TAU); g.fillStyle = WHITE; g.fill(); g.lineWidth = 2.6; g.strokeStyle = INK; g.stroke();
    g.beginPath(); g.ellipse(19, 6.6, 9, 2.6, 0, 0, TAU); g.fillStyle = WMID; g.fill();
    // Back to front (S: row 30 = heel counter 6..9, accent 12..16, upper 19..): the accent strip, the heel counter, the upper.
    shape(g, [[10, 24, 1], [17, 22, 1], [18, 44, 1], [11, 44, 1]], red ? WHITE : STUD, 2.4);
    const HEEL = [[1, 21], [9, 17, 1], [11, 30], [10, 44, 1], [4, 44, 1], [2, 34]];
    shape(g, HEEL, kp.base);
    g.save(); clipTo(g, HEEL); line(g, [[4, 22], [6, 34]], 2.2, kp.light); g.restore();
    shape(g, HEEL, null, 2.5);
    const UP = [[17, 15], [35, 12, 1], [39, 19], [50, 23], [61, 28], [68, 34], [71, 41], [68, 47, 1], [18, 47, 1], [17, 30]];
    shape(g, UP, kp.base);
    g.save(); clipTo(g, UP);
    g.fillStyle = kp.dark; g.beginPath(); trace(g, [[10, 40], [30, 42], [74, 41], [74, 52], [10, 52]], true); g.fill();
    line(g, [[20, 17], [33, 15]], 2.4, kp.light); line(g, [[41, 22], [52, 26], [62, 31], [68, 37]], 2.4, kp.light);
    g.restore();
    shape(g, UP, null, 2.5);
    // Laces: three white pills down the instep.
    for (const [x, y] of [[25, 29], [35, 35], [46, 39]]) {
      const L = [[x, y + 1], [x + 8, y - 1], [x + 16, y - 3]];
      line(g, L, 8, INK); line(g, L, 4.2, WHITE);
      line(g, [[x + 1, y + 2.6], [x + 15, y - 1.2]], 1.2, WSHADE);
    }
    // Sole (S: rows 45..50, a red stripe lit in the middle) and six studs (S: down to row 57).
    for (const x of [8, 19, 35, 45, 55, 65]) shape(g, [[x - 3.2, 49, 1], [x + 3.2, 49, 1], [x + 2.8, 56, 1], [x - 2.8, 56, 1]], STUD, 2.2);
    shape(g, [[4, 45, 1], [71, 44, 1], [71, 49, 1], [6, 50, 1]], SOLE, 2.6);
    line(g, [[12, 47.4], [62, 46.6]], 1.6, red ? WHITE : SOLELIT);
  }
  function bootSprite(side, k) {
    const kp = kitPal(side);
    return sprite('b' + side + kp.base, 71, 59, k, (g) => boot(g, kp), 1.5);
  }

  /* ── the ball: a white back disc (never turns, shaded below) under a turning front of seams and dark patches ── */
  const BALL_R = 51.1;                               // S: ball-front 92 px x .5 / .45 (hsArt sizes its cache by it)
  const RB = 43;                                     // the back disc and the panels' sphere, atlas px (ball-back 86 px)
  let geo = null;
  function ballGeo() {
    if (geo) return geo;
    const PHI = (1 + Math.sqrt(5)) / 2, V = [];
    for (const a of [-1, 1]) for (const b of [-1, 1]) V.push([0, a, b * PHI], [a, b * PHI, 0], [b * PHI, 0, a]);
    const sub = (p, q) => [p[0] - q[0], p[1] - q[1], p[2] - q[2]], dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
    const nrm = (p) => { const l = Math.hypot(p[0], p[1], p[2]); return [p[0] / l, p[1] / l, p[2] / l]; };
    const lerp = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
    const cross = (p, q) => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
    const nb = V.map((v, i) => V.map((w, j) => j).filter(j => j !== i && Math.abs(dot(sub(V[j], v), sub(V[j], v)) - 4) < 1e-6));
    // Facing: a hexagon (an icosahedron face) toward the viewer, a patch up and to the right, tipped a little.
    const f = [0, nb[0][0], nb[0].find(j => nb[nb[0][0]].includes(j))];
    const e3 = nrm(lerp(lerp(V[f[0]], V[f[1]], 0.5), V[f[2]], 1 / 3));
    const t1 = nrm(sub(V[f[0]], e3.map(c => c * dot(V[f[0]], e3)))), t2 = cross(e3, t1);
    const roll = -1.29, al = 0.13, be = 0.07;
    const view = (p) => {
      let x = dot(p, t1), y = dot(p, t2), z = dot(p, e3);
      [x, y] = [x * Math.cos(roll) - y * Math.sin(roll), x * Math.sin(roll) + y * Math.cos(roll)];
      [x, z] = [x * Math.cos(al) + z * Math.sin(al), -x * Math.sin(al) + z * Math.cos(al)];
      [y, z] = [y * Math.cos(be) + z * Math.sin(be), -y * Math.sin(be) + z * Math.cos(be)];
      return [x, y, z];
    };
    // Along a seam on the sphere; a point behind the ball is pushed out to the rim.
    const arc = (p, q, n) => { const out = []; for (let i = 0; i <= n; i++) out.push(view(nrm(lerp(p, q, i / n)))); return out; };
    const flat = (p) => { if (p[2] >= 0) return [p[0], p[1]]; const l = Math.hypot(p[0], p[1]) || 1; return [p[0] / l, p[1] / l]; };
    const pents = [], seams = [];
    V.forEach((v, i) => {
      const n0 = nrm(v), a1 = nrm(sub(V[nb[i][0]], n0.map(c => c * dot(V[nb[i][0]], n0)))), a2 = cross(n0, a1);
      const ring = nb[i].map(j => lerp(v, V[j], 1 / 3)).sort((p, q) => Math.atan2(dot(sub(p, v), a2), dot(sub(p, v), a1)) - Math.atan2(dot(sub(q, v), a2), dot(sub(q, v), a1)));
      const poly = []; let vis = false;
      ring.forEach((p, k) => { const s = arc(p, ring[(k + 1) % 5], 8); for (const q of s) { if (q[2] > 0) vis = true; poly.push(flat(q)); } seams.push(s); });
      if (vis) pents.push(poly);
      nb[i].forEach(j => { if (j > i) seams.push(arc(lerp(v, V[j], 1 / 3), lerp(v, V[j], 2 / 3), 8)); });
    });
    geo = { pents, seams: seams.filter(s => s.some(q => q[2] > 0)).map(s => s.map(flat)) };
    return geo;
  }
  // The back: centred on the origin, world units.
  function ballBack(g, golden) {
    const base = golden ? '#ffc419' : '#fcfff7', shade = golden ? '#f08808' : '#c2acb5';
    g.save(); g.scale(U, U);
    g.fillStyle = shade; g.beginPath(); g.arc(0, 0, RB, 0, TAU); g.fill();
    g.save(); g.clip(); g.fillStyle = base; g.beginPath(); g.arc(0, -19, RB, 0, TAU); g.fill(); g.restore();   // S: lit disc 19 px up
    g.restore();
  }
  // The front (turns with the ball): dark patches, seams with a blue-grey lip, the rim.
  function ballFront(g, golden) {
    const G = ballGeo(), ink = golden ? '#c24000' : '#32282c', lip = golden ? '#f08808' : '#3f4f6c';
    const patch = golden ? 'rgba(189,73,15,0.5)' : '#32282c';
    g.save(); g.scale(U, U); g.lineJoin = 'round'; g.lineCap = 'round';
    const pl = (P, dx, dy) => { g.moveTo(P[0][0] * RB + dx, P[0][1] * RB + dy); for (let i = 1; i < P.length; i++) g.lineTo(P[i][0] * RB + dx, P[i][1] * RB + dy); };
    g.save(); g.beginPath(); g.arc(0, 0, RB, 0, TAU); g.clip();
    g.fillStyle = patch; for (const P of G.pents) { g.beginPath(); pl(P, 0, 0); g.closePath(); g.fill(); }
    g.strokeStyle = lip; g.lineWidth = 3.2; g.beginPath(); for (const S of G.seams) pl(S, 0.8, 0.8); g.stroke();
    g.strokeStyle = ink; g.lineWidth = 2.2; g.beginPath(); for (const S of G.seams) pl(S, 0, 0); g.stroke();
    // Scuffs: short light scratches on the panels.
    g.strokeStyle = golden ? '#ffc419' : '#c2acb5'; g.lineWidth = 1.1;
    g.beginPath();
    for (let i = 0; i < 22; i++) {                    // fixed scatter (golden-angle spiral), short strokes
      const r = RB * 0.9 * Math.sqrt((i + 0.5) / 22), t = i * 2.39996, x = Math.cos(t) * r, y = Math.sin(t) * r, a = t * 1.7;
      g.moveTo(x, y); g.lineTo(x + Math.cos(a) * 2.6, y + Math.sin(a) * 2.6);
    }
    g.stroke();
    g.restore();
    g.strokeStyle = lip; g.lineWidth = 1.2; g.beginPath(); g.arc(0, 0, RB - 0.4, 0, TAU); g.stroke();
    g.strokeStyle = ink; g.lineWidth = 2.2; g.beginPath(); g.arc(0, 0, RB + 1.2, 0, TAU); g.stroke();
    g.restore();
  }
  // The whole ball centred on the origin (hsArt.js caches it).
  function paintBall(g, golden) { ballBack(g, golden); ballFront(g, golden); }

  /* ── the players ──────────────────────────────────────────────────────────
     Placed as the reference places its parts around the body centre (S: Player
     _headRelativePosition, _leftShoe/_rightShoe..., _leftArm/_rightArm, all x .5)
     and drawn in its order: back hand (87.5, 85), front boot (32.5, 130), head
     (0, 55, anchor .5/.8), kicking boot (-22.5, 130), front hand (-97.5, 85).
     Poses are S's: no idle bob; the head turns to the ball; the run cycle; the
     jump's boot turn; the kick; after a goal the scorer cheers and the other is sad. */
  const D = Math.PI / 180;
  const quadOut = (t) => 1 - (1 - t) * (1 - t), quadIn = (t) => t * t, clamp01 = (t) => Math.max(0, Math.min(1, t));
  // Per seat, between frames: when it left the ground, and when its cheer / sad began (our own clocks of the page's flags).
  const was = [{ ground: null, airAt: 0, mood: 0, moodAt: 0 }, { ground: null, airAt: 0, mood: 0, moodAt: 0 }];
  // S cheer(): arms to (175, 70) at -90 deg and (-25, 70) at 150 deg (x .5); every 800 ms a punch up to (215, -160) and
  // (-115, -160), 350 ms Quadratic.Out there and back (yoyo), the first 800 ms after the goal.
  function cheerArms(t) {
    const hb = [87.5, 35], hf = [-12.5, 35];
    if (t >= 800) {
      const w = t % 800, e = w < 350 ? quadOut(w / 350) : w < 700 ? quadOut(1 - (w - 350) / 350) : 0;
      hb[0] += (107.5 - 87.5) * e; hb[1] += (-80 - 35) * e; hf[0] += (-57.5 + 12.5) * e; hf[1] += (-80 - 35) * e;
    }
    return { hb, hf, hbA: -90, hfA: 150 };
  }
  /* p: { x, y, left, ground, mv }; st: the page's per-player animation state; ball: where to look. */
  function player(g, p, st, ballX, now) {
    const side = p.side ? 1 : 0, a = p.left ? -1 : 1, x = p.x, y = p.y, W = was[side];
    // The screen scale, in 1/8-octave steps so the cached parts are rebuilt only when it really changes.
    const m = g.getTransform(), raw = Math.hypot(m.a, m.b) || 1, k = Math.min(4, Math.pow(2, Math.ceil(Math.log2(raw) * 8 - 0.01) / 8));
    const kicking = st.kickMs >= 0 && st.kickMs < HS.KICK_MS, air = !p.ground;
    // Clocks: a take-off seen from the ground starts the boots' turn; a player first seen in the air has finished it.
    if (air && W.ground !== false) W.airAt = W.ground === true ? now : -1e9;
    W.ground = !air;
    const mood = st.mood > 0 ? 1 : st.mood < 0 ? -1 : 0;
    if (mood && mood !== W.mood) W.moodAt = now;
    W.mood = mood;
    // S _updateRunAnimation: the boots circle at steps / 3, 60 across and 30 up (x .5), only on the ground; in the air
    // or mid-kick they hold where they were, and stopping (idle) puts them back.
    const s = st.run || 0, run = !!p.mv;
    const rx = run ? Math.sin(s / 3) * 30 : 0, ry = run ? -Math.cos(s / 3) * 15 : 0;
    const lx = run ? Math.sin(s / 3 + Math.PI) * 30 : 0, ly = run ? -Math.cos(s / 3 + Math.PI) * 15 : 0;
    // S jump(): the front boot turns +47 deg (x facing) over .3 x Game.scale(2000) ms Quadratic.Out, the back one +50
    // over .28 x that, Quadratic.In (240 and 224 ms at the 768-high reference); landing resets both.
    const ta = air ? now - W.airAt : 0;
    const lAng = air ? 47 * a * quadOut(clamp01(ta / 240)) : 0;
    let kAng = air ? 50 * a * quadIn(clamp01(ta / 224)) : 0;
    // S kick(): the back boot jumps to the ball (or (200, 200) out front), 1.5x, angle set to 60 (not mirrored), all
    // eased back over 200 ms Quadratic.Out to where it was.
    let kx = -22.5 + rx, ky = 130 + ry, ksc = 1;
    if (kicking) {
      const e = quadOut(st.kickMs / HS.KICK_MS), tx = st.kdx, ty = st.kdy;   // kdx: body-relative (x facing), as S
      kx = tx + (kx - tx) * e; ky = ty + (ky - ty) * e; ksc = 1.5 - 0.5 * e; kAng = 60 + (kAng - 60) * e;
    }
    // Hands: still, except the cheer.
    let hb = [87.5, 85], hf = [-97.5, 85], hbA = 0, hfA = 0;
    if (mood > 0) ({ hb, hf, hbA, hfA } = cheerArms(now - W.moodAt));
    // Head: faces the ball; after a goal it faces the way the body does, and the sad one tips 45 deg (x facing).
    const look = mood ? a : (ballX > x ? 1 : -1), headA = mood < 0 ? 45 * a : 0;
    const sb = handSprite(side, false, k), sf = handSprite(side, true, k), bt = bootSprite(side, k), hd = headSprite(side, k);
    g.save(); g.translate(x + hb[0] * a, y + hb[1]); g.rotate(hbA * a * D); g.scale(a, 1); blit(g, sb, 73, 62, 0.5, 0.5); g.restore();
    g.save(); g.translate(x + (32.5 + lx) * a, y + 130 + ly); g.rotate(lAng * D); g.scale(a, 1); blit(g, bt, 71, 59, 0.5, 0.5); g.restore();
    g.save(); g.translate(x, y + 55); g.rotate(headA * D); g.scale(look, 1); blit(g, hd.c, hd.fr.w, hd.fr.h, hd.fr.ax, hd.fr.ay); g.restore();
    g.save(); g.translate(x + kx * a, y + ky); g.rotate(kAng * D); g.scale(a * ksc, ksc); blit(g, bt, 71, 59, 0.5, 0.5); g.restore();
    g.save(); g.translate(x + hf[0] * a, y + hf[1]); g.rotate(hfA * a * D); g.scale(a, 1); blit(g, sf, 66, 66, 0.5, 0.5); g.restore();
  }

  root.HSChars = {
    player, ball: paintBall, ballBack, ballFront, BALL_R,
    setKits(cols) { kits = [cols && cols[0] || null, cols && cols[1] || null]; cache.clear(); },
    // ids: the face each seat wears (shared/hsHeads.js), null or unknown for the seat's own.
    setHeads(ids) { heads = [ids && ids[0] || null, ids && ids[1] || null]; },
  };
})(window);
