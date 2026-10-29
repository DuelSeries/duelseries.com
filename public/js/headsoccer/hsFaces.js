'use strict';
/* ─── Head Soccer, the heads ─────────────────────────────────────────────────
   The heads a player can wear (Owen 2026-10-28: a head chooser in Customize), and the pen every Head Soccer part is
   drawn with. Loaded by /headsoccer (before hsChars.js, which draws the bodies, boots and ball with the same pen) and
   by the lobby, whose Customize previews the heads with the same painters, so a head looks the same in both.

   Every face is INVENTED: nobody real and no lookalike (Owen: a first pass looked like a real footballer and was
   rejected). All are drawn in the reference's caricature style: 3/4 view facing right, tipped forward, a big cranium
   over a jutting jaw, squinting eyes under heavy brows, a toothy grin, the shirt collar in the kit colours under the
   chin, a dark maroon outline, flat cel shading with halftone dots (docs/head-soccer-reference.md).

   Units are "atlas px" of a frame the size of the reference's head frames, anchored at (.5, .8) of the classic
   frames; a head with hair outside that frame has a bigger frame and an offset (dx, dy) so its face sits exactly
   where the classic one does. The ids, names and order players see are shared/hsHeads.js. */
(function (root) {
  const TAU = Math.PI * 2;
  // Measured colours (atlas frames, see SP/hs-tools/notes-c.md).
  const INK = '#440201', INK2 = '#571813';            // every outline; the softer inner line
  const WHITE = '#f8f7fd', WSHADE = '#d4c7d5', WMID = '#ddd6e2', WLITE = '#ece7ef';   // socks, wristbands, teeth, eyes
  // Kit triples measured on their blue (France) and red kits; any other kit colour is shaded by mixing.
  const KITS = {
    '#393295': { base: '#393295', dark: '#3b2f73', deep: '#332655', light: '#4c48a9' },
    '#ad1613': { base: '#ad1613', dark: '#840f0c', deep: '#680906', light: '#ee3937' },
  };

  /* ── the pen ────────────────────────────────────────────────────────────── */
  function hexRgb(h) {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(h || '').trim());
    if (!m) return null;
    let s = m[1]; if (s.length === 3) s = s.split('').map(c => c + c).join('');
    return [0, 2, 4].map(i => parseInt(s.slice(i, i + 2), 16));
  }
  const rgbHex = (c) => '#' + c.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  const mix = (a, b, t) => rgbHex(a.map((v, i) => v + (b[i] - v) * t));
  // A kit colour's four tones: the measured ones for their two kits, mixed for any other.
  function kitOf(colour, fallback) {
    const key = String(colour || '').toLowerCase();
    if (KITS[key]) return KITS[key];
    const c = hexRgb(colour) || hexRgb(fallback) || hexRgb('#ad1613');
    return { base: rgbHex(c), dark: mix(c, [40, 8, 30], 0.32), deep: mix(c, [30, 4, 20], 0.5), light: mix(c, [255, 255, 255], 0.14) };
  }
  // A smooth path through points (Catmull-Rom); a point with a third value 1 is a sharp corner.
  function trace(g, P, closed) {
    const n = P.length, tan = (i) => {
      const p = P[i];
      if (p[2] === 1) return [0, 0];
      const a = closed ? P[(i - 1 + n) % n] : P[Math.max(0, i - 1)], b = closed ? P[(i + 1) % n] : P[Math.min(n - 1, i + 1)];
      return [(b[0] - a[0]) / 2, (b[1] - a[1]) / 2];
    };
    g.moveTo(P[0][0], P[0][1]);
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const j = (i + 1) % n, p = P[i], q = P[j], t0 = tan(i), t1 = tan(j);
      g.bezierCurveTo(p[0] + t0[0] / 3, p[1] + t0[1] / 3, q[0] - t1[0] / 3, q[1] - t1[1] / 3, q[0], q[1]);
    }
    if (closed) g.closePath();
  }
  function shape(g, P, fill, lw, stroke) {
    g.beginPath(); trace(g, P, true);
    if (fill) { g.fillStyle = fill; g.fill(); }
    if (lw) { g.strokeStyle = stroke || INK; g.lineWidth = lw; g.stroke(); }
  }
  function line(g, P, lw, col) { g.beginPath(); trace(g, P, false); g.strokeStyle = col || INK; g.lineWidth = lw; g.stroke(); }
  function clipTo(g, P) { g.beginPath(); trace(g, P, true); g.clip(); }
  // Halftone dots (their shading texture), in a staggered grid over a box.
  function dots(g, x0, y0, x1, y1, step, r, col) {
    g.fillStyle = col; g.beginPath();
    for (let y = y0, row = 0; y <= y1; y += step, row++) for (let x = x0 + (row & 1) * step / 2; x <= x1; x += step) { g.moveTo(x + r, y); g.arc(x, y, r, 0, TAU); }
    g.fill();
  }
  // Fill a region with one colour, clipped to a path (the cel shading's tones).
  function tone(g, P, col) { g.fillStyle = col; g.beginPath(); trace(g, P, true); g.fill(); }

  /* ── the parts every face shares ─────────────────────────────────────────── */
  // The shirt collar under the jaw, in the kit colours (their heads carry the collar too).
  function collar(g, kp, dx, dy) {
    const P = [[10, 112], [7, 138], [18, 160], [42, 173], [72, 179], [98, 177], [110, 169], [98, 164], [74, 158], [50, 146], [32, 132], [24, 114]]
      .map(p => [p[0] + dx, p[1] + dy]);
    shape(g, P, kp.base);
    g.save(); clipTo(g, P);
    g.fillStyle = kp.deep; g.beginPath(); trace(g, [[0, 100 + dy], [30 + dx, 120 + dy], [36 + dx, 150 + dy], [50 + dx, 190 + dy], [0, 190 + dy]], true); g.fill();
    line(g, [[14 + dx, 150 + dy], [38 + dx, 167 + dy], [68 + dx, 174 + dy], [100 + dx, 172 + dy]], 6, kp.light);
    g.restore();
    shape(g, P, null, 2.7);
  }
  function ear(g, H, P, inner) {
    shape(g, P, H.skin);
    g.save(); clipTo(g, P); g.fillStyle = H.shade; g.beginPath(); trace(g, inner[0], true); g.fill(); g.restore();
    line(g, inner[1], 2); line(g, inner[2], 1.8);
    shape(g, P, null, 2.5);
  }
  // A squinting eye: a small white under a heavy lid, the iris tucked under it, a lower-lid crease.
  function eye(g, H, white, iris, r, lid, under) {
    shape(g, white, WMID);
    g.save(); clipTo(g, white);
    g.fillStyle = H.iris; g.beginPath(); g.arc(iris[0], iris[1], r, 0, TAU); g.fill();
    g.fillStyle = '#1d1e25'; g.beginPath(); g.arc(iris[0] + r * 0.25, iris[1], r * 0.55, 0, TAU); g.fill();
    g.fillStyle = 'rgba(68,2,1,0.35)'; g.fillRect(iris[0] - 12, white[1][1] - 2, 24, 3);              // the lid's shadow
    g.restore();
    shape(g, white, null, 1.3, INK2);
    line(g, lid, 3.6);
    if (under) line(g, under, 1.4, INK2);
  }
  // Painted hair clumps: strokes from a base line toward the tips, darker at the root, lit along one side.
  function clumps(g, list, dark, lite, w) {
    for (const [x0, y0, x1, y1] of list) {
      line(g, [[x0, y0], [x1, y1]], w, dark);
      line(g, [[x0 + (x1 - x0) * 0.25 + 1.5, y0 + (y1 - y0) * 0.25 - 1.5], [x0 + (x1 - x0) * 0.8 + 1, y1 + (y0 - y1) * 0.2 - 1]], w * 0.45, lite);
    }
  }
  // A toothy grin: dark mouth, an upper row of teeth with gaps, lower lip.
  function grin(g, H, MO, TEETH, gaps, lower, lip) {
    shape(g, MO, INK);
    g.save(); clipTo(g, MO);
    shape(g, TEETH, WHITE);
    line(g, TEETH.slice(2), 2.4, WSHADE);
    for (const [x, y0, y1] of gaps) line(g, [[x, y0], [x + 0.5, y1]], 1.1, WSHADE);
    if (lower) shape(g, lower, WSHADE);
    g.restore();
    shape(g, MO, null, 2.2);
    if (lip) shape(g, lip, H.lip, 1.6);
  }

  /* ── the classic pair (the seats' own faces) ─────────────────────────────── */
  // Frame sizes are the reference's head frames for the same seats (131 x 187 and 132 x 167 atlas px, drawn
  // 145.6 x 207.8 and 146.7 x 185.6 units). Colours are entries of their atlas (notes-c.md).
  const BEARD = { w: 131, h: 187, skin: '#75504c', shade: '#5d473d', deep: '#4d352d', dot: '#514239', lite: '#806870', lip: '#7e6570',
    scalp: '#6d5a52', hair: '#1d1e25', hairMid: '#2a2a33', hairLite: '#554d48', iris: '#2a2a33' };
  const SPIKES = { w: 132, h: 167, skin: '#eabfa8', shade: '#da958a', deep: '#b47c6e', dot: '#d18c81', lite: '#e2b09d', lip: '#da958a',
    hair: '#ae8b66', hairMid: '#9a724b', hairDark: '#7b6352', hairLite: '#d2c097', iris: '#7b6352' };

  // Seat 0's own face: dark skin, a shaved head, a thick short beard.
  function headBeard(g, kp) {
    const H = BEARD;
    collar(g, kp, 0, 0);
    const SK = [[16, 70], [22, 44], [38, 22], [60, 11], [86, 10], [104, 17], [116, 31], [121, 50], [123, 64], [129, 79], [124, 89], [126, 99],
      [131, 110, 1], [123, 117], [125, 124], [123, 134], [120, 146], [119, 157], [113, 167], [99, 173], [80, 169], [58, 157], [38, 143], [21, 127], [13, 105], [12, 86]];
    shape(g, SK, H.skin);
    g.save(); clipTo(g, SK);
    // Three tones: the shadow side (back and below), the brow's shadow over the eyes, the lit forehead and nose.
    const SH = [[0, 30], [40, 26], [46, 52], [50, 80], [56, 106], [66, 128], [90, 150], [130, 150], [130, 190], [0, 190]];
    g.fillStyle = H.shade; g.beginPath(); trace(g, SH, true); g.fill();
    g.save(); g.beginPath(); trace(g, SH, true); g.clip(); dots(g, 0, 26, 130, 190, 3.6, 0.9, H.deep); g.restore();
    g.beginPath(); trace(g, [[58, 88], [84, 86], [104, 90], [122, 88], [122, 98], [104, 101], [80, 101], [62, 102]], true); g.fill();
    g.beginPath(); trace(g, [[64, 104], [82, 108], [94, 120], [80, 122], [68, 114]], true); g.fill();
    g.fillStyle = H.deep; g.beginPath(); trace(g, [[104, 114], [122, 116], [116, 121], [106, 120]], true); g.fill();
    // The shaved scalp: a cooler tone above the hairline, speckled with stubble, a shine on the crown.
    const SC = [[0, 96], [10, 60], [24, 30], [46, 14], [74, 8], [100, 12], [114, 24], [120, 42], [108, 46], [88, 44], [70, 48], [56, 58], [48, 74], [42, 92], [30, 98]];
    g.fillStyle = H.scalp; g.beginPath(); trace(g, SC, true); g.fill();
    g.save(); g.beginPath(); trace(g, SC, true); g.clip(); dots(g, 0, 4, 124, 100, 2.6, 0.6, H.deep); g.restore();
    g.fillStyle = H.lite; g.beginPath(); trace(g, [[56, 20], [80, 15], [98, 20], [84, 24], [64, 26]], true); g.fill();
    g.beginPath(); trace(g, [[88, 52], [108, 54], [114, 62], [98, 60]], true); g.fill();
    g.beginPath(); trace(g, [[118, 100], [127, 106], [126, 111], [119, 107]], true); g.fill();
    g.restore();
    shape(g, SK, null, 2.7);
    line(g, [[110, 46], [90, 44], [70, 48], [56, 58], [48, 74], [43, 90]], 1.4, INK2);                    // the shave line
    ear(g, H, [[24, 94], [12, 88], [3, 96], [2, 112], [8, 128], [20, 138], [30, 134], [32, 120]],
      [[[8, 96], [16, 92], [24, 100], [24, 126], [16, 132], [8, 122]], [[12, 100], [8, 112], [12, 124], [22, 130]], [[17, 106], [21, 114], [18, 122]]]);
    // The thick short beard: from the sideburn along the jaw round the chin, the moustache over the lip.
    const BD = [[32, 98], [42, 94, 1], [48, 106], [58, 120], [72, 128], [84, 129], [92, 122], [104, 119], [118, 119], [128, 120, 1], [126, 131], [123, 142],
      [122, 154], [119, 164], [112, 172], [99, 177], [80, 173], [58, 161], [40, 147], [26, 131], [24, 116]];
    shape(g, BD, H.hairMid);
    g.save(); clipTo(g, BD);
    g.fillStyle = H.hair; g.beginPath(); trace(g, [[0, 120], [30, 130], [60, 160], [100, 178], [130, 160], [130, 190], [0, 190]], true); g.fill();
    clumps(g, [[34, 104, 30, 122], [40, 112, 36, 132], [50, 124, 46, 146], [60, 134, 58, 156], [72, 142, 72, 164], [86, 146, 88, 170],
      [100, 150, 104, 172], [112, 146, 116, 166], [120, 138, 122, 156], [96, 121, 92, 126], [110, 120, 108, 125], [121, 121, 120, 126]], H.hair, H.hairLite, 3);
    g.restore();
    shape(g, BD, null, 2.7);
    // Brows: heavy and low, pulled down to the nose; forehead creases.
    shape(g, [[56, 86], [68, 77], [90, 76], [104, 83], [100, 89], [84, 85], [66, 90]], H.hair, 2);
    shape(g, [[107, 85], [117, 78], [128, 80], [127, 88], [116, 89]], H.hair, 2);
    line(g, [[60, 60], [76, 55], [94, 58]], 1.6, INK2); line(g, [[64, 68], [80, 64], [98, 66]], 1.6, INK2);
    line(g, [[102, 68], [100, 78]], 1.6, INK2);
    eye(g, H, [[70, 95.5], [79, 92.5], [90, 92.5], [95, 95], [86, 97.5], [75, 97.5]], [87, 95.5], 2.8, [[66, 95], [78, 91.5], [92, 91.5], [98, 94]], [[74, 101], [86, 102], [94, 99]]);
    eye(g, H, [[108, 95], [114, 92.5], [121, 93.5], [120, 96.5], [111, 97]], [116.5, 95], 2.3, [[105, 94.5], [114, 91.5], [124, 92.5]]);
    // The nose: bridge, a big wing, the cheek fold.
    line(g, [[104, 94], [106, 104]], 2);
    line(g, [[100, 108], [97, 114], [104, 119], [117, 116]], 2.4);
    line(g, [[94, 106], [84, 116], [80, 126]], 2.2);
    line(g, [[64, 104], [74, 110]], 1.6, INK2);
    // The grin, cut into the beard.
    grin(g, H, [[82, 129], [96, 124], [112, 122], [125, 124], [124, 132], [118, 143], [106, 150], [94, 147], [85, 137]],
      [[80, 124], [126, 120], [125, 134], [108, 138], [90, 137]], [[94, 126, 136], [103, 124, 137], [112, 123, 136], [120, 123, 134]],
      [[96, 146], [104, 143], [116, 141], [112, 149], [100, 151]], [[92, 150], [106, 153], [118, 146], [116, 154], [104, 158], [93, 155]]);
  }

  /* The second face's skull, features and grin, shared by every head after it: o.hair draws the hair over the skull,
     o.stubble darkens the jaw, o.hairShadow lays the hair's shadow on the forehead, o.brow is the brows' colour,
     o.crease keeps the frown line between the brows, o.nose replaces the nose and cheek fold, o.before draws on the
     bare face (freckles, lines), o.after draws over the finished face (a moustache). */
  function faceB(g, kp, H, o) {
    collar(g, kp, 0, -19);
    const SK = [[24, 40], [36, 20], [56, 8], [80, 8], [100, 14], [114, 26], [121, 40], [124, 54], [128, 66], [131, 75], [126, 84], [128, 92],
      [131, 99, 1], [125, 106], [127, 112], [123, 122], [119, 134], [116, 146], [110, 156], [94, 160], [74, 152], [52, 138], [32, 122], [16, 104],
      [10, 82], [12, 60], [18, 48]];
    shape(g, SK, H.skin);
    g.save(); clipTo(g, SK);
    const SH = [[0, 30], [44, 40], [42, 64], [46, 90], [54, 112], [68, 130], [96, 146], [130, 140], [130, 170], [0, 170]];
    g.fillStyle = H.shade; g.beginPath(); trace(g, SH, true); g.fill();
    g.save(); g.beginPath(); trace(g, SH, true); g.clip(); dots(g, 0, 30, 130, 170, 3.6, 0.7, H.dot); g.restore();
    g.beginPath(); trace(g, [[58, 72], [84, 70], [104, 74], [122, 72], [122, 82], [104, 84], [80, 84], [62, 86]], true); g.fill();   // under the brow
    g.fillStyle = H.lite; g.beginPath(); trace(g, [[66, 92], [84, 96], [94, 108], [80, 110], [70, 102]], true); g.fill();          // under the cheekbone
    if (o.hairShadow) { g.fillStyle = H.shade; g.beginPath(); trace(g, [[50, 36], [80, 32], [118, 34], [118, 44], [80, 42], [54, 48]], true); g.fill(); }
    g.fillStyle = H.deep; g.beginPath(); trace(g, [[106, 102], [124, 104], [118, 109], [108, 108]], true); g.fill();
    if (o.stubble) {
      // Stubble over the jaw, chin and upper lip.
      const ST = [[36, 100], [50, 110], [64, 122], [80, 124], [92, 112], [110, 108], [130, 108], [130, 170], [30, 170]];
      g.fillStyle = o.stubble; g.beginPath(); trace(g, ST, true); g.fill();
      g.save(); g.beginPath(); trace(g, ST, true); g.clip(); dots(g, 30, 100, 130, 170, 2, 0.45, H.deep); g.restore();
    }
    if (o.skull) o.skull(g, H);
    g.restore();
    shape(g, SK, null, 2.7);
    ear(g, H, [[24, 76], [12, 70], [3, 78], [2, 94], [8, 110], [20, 120], [30, 116], [32, 102]],
      [[[8, 78], [16, 74], [24, 82], [24, 108], [16, 114], [8, 104]], [[12, 82], [8, 94], [12, 106], [22, 112]], [[17, 88], [21, 96], [18, 104]]]);
    if (o.before) o.before(g, H);
    if (o.hair) o.hair(g, H);
    // Brows, crow's feet, squinting eyes.
    shape(g, [[58, 71], [70, 64], [92, 63], [104, 69], [99, 73], [80, 70], [64, 76]], o.brow || H.hairMid, 2);
    shape(g, [[108, 70], [118, 64], [129, 66], [128, 72], [116, 74]], o.brow || H.hairMid, 2);
    eye(g, H, [[72, 82.5], [80, 80.3], [90, 80.3], [94, 82.3], [86, 84], [76, 84]], [87, 82.5], 2.6, [[66, 82], [78, 78.5], [92, 78.5], [98, 81]], [[74, 88], [86, 89], [94, 86]]);
    eye(g, H, [[108, 82], [114, 79.5], [121, 80.5], [120, 83.5], [111, 84]], [116.5, 82], 2.3, [[105, 81.5], [114, 78.5], [124, 79.5]]);
    line(g, [[60, 82], [55, 86]], 1.4, INK2); line(g, [[61, 88], [56, 92]], 1.4, INK2);
    if (o.crease !== false) line(g, [[100, 56], [98, 64]], 1.4, INK2);
    // The nose, the cheek fold, the grin.
    if (o.nose) o.nose(g, H);
    else {
      line(g, [[104, 84], [106, 94]], 1.9);
      line(g, [[100, 98], [97, 104], [104, 109], [117, 106]], 2.2);
      line(g, [[96, 98], [86, 108], [82, 120], [86, 132]], 2);
    }
    grin(g, H, [[90, 120], [102, 116], [114, 114], [124, 115], [123, 122], [117, 130], [105, 134], [96, 131], [91, 126]],
      [[88, 116], [126, 112], [125, 123], [108, 126], [92, 125]], [[100, 117, 125], [107, 115, 125], [114, 114, 124], [120, 114, 122]],
      [[100, 131], [107, 128], [117, 127], [112, 133], [102, 135]], [[98, 136], [108, 138], [117, 133], [115, 139], [106, 143], [98, 140]]);
    line(g, [[100, 150], [108, 149]], 1.6, INK2);
    if (o.after) o.after(g, H);
  }

  // Seat 1's own face: light skin, short spiky light-brown hair, a stubbly jaw.
  function headSpikes(g, kp) {
    faceB(g, kp, SPIKES, {
      hairShadow: true, stubble: '#e0a493',
      hair(g, H) {
        // Short spiky hair: a cap of chunky spikes, the fringe pushed up and forward.
        const HR = [[10, 78], [6, 52], [8, 34], [4, 22, 1], [16, 20], [15, 8, 1], [28, 12], [33, 2, 1], [44, 8], [54, 1, 1], [62, 8], [74, 2, 1], [82, 9],
          [94, 4, 1], [100, 12], [112, 8, 1], [114, 19], [126, 17, 1], [120, 27], [130, 29, 1], [118, 34], [104, 33], [86, 31], [70, 35], [58, 43], [50, 56],
          [46, 72], [44, 84], [36, 78], [24, 80]];
        shape(g, HR, H.hair);
        g.save(); clipTo(g, HR);
        g.fillStyle = H.hairMid; g.beginPath(); trace(g, [[0, 40], [30, 36], [56, 40], [64, 50], [50, 90], [0, 90]], true); g.fill();
        dots(g, 4, 40, 60, 90, 3, 0.8, H.hairDark);
        clumps(g, [[16, 40, 6, 24], [22, 34, 16, 10], [32, 30, 33, 4], [44, 28, 54, 3], [56, 26, 74, 4], [70, 26, 94, 6], [84, 26, 112, 10], [96, 28, 126, 19],
          [104, 30, 129, 29], [36, 44, 20, 30], [50, 40, 40, 20]], H.hairDark, H.hairLite, 2.6);
        g.restore();
        shape(g, HR, null, 2.7);
        line(g, [[44, 84], [45, 72]], 1.6, INK2);
      },
    });
  }

  /* ── the new faces (Owen 2026-10-28), each on the second face's build ───── */
  // Flat-top: fair and freckled, a copper-brown flat-top with short faded sides.
  const FLATTOP = { w: 132, h: 187, dx: 0, dy: 20, skin: '#f2c6ae', shade: '#e1a28f', deep: '#bf8475', dot: '#d6927f', lite: '#f8d8c6', lip: '#e09a8c',
    hair: '#9c5228', hairMid: '#86431f', hairDark: '#5e2b12', hairLite: '#c98252', iris: '#4f7340' };
  function headFlattop(g, kp) {
    faceB(g, kp, FLATTOP, {
      hairShadow: true, brow: '#6e3518',
      before(g, H) {
        // Freckles over the nose and cheeks.
        g.fillStyle = '#c9805f';
        for (const [x, y] of [[70, 94], [76, 98], [82, 94], [88, 99], [74, 103], [96, 92], [110, 95], [116, 98], [104, 98], [121, 93], [92, 104]]) { g.beginPath(); g.arc(x, y, 1.3, 0, TAU); g.fill(); }
      },
      hair(g, H) {
        // The flat-top: a tall block with a level top over the crown, the sides cut short to the skin.
        const SIDE = [[10, 80], [6, 56], [10, 36], [24, 30], [40, 34], [50, 48], [46, 66], [44, 84], [36, 78], [24, 82]];
        shape(g, SIDE, H.hairMid);
        g.save(); clipTo(g, SIDE); dots(g, 4, 30, 54, 90, 2.6, 0.75, H.hairDark); g.restore();
        shape(g, SIDE, null, 2.4);
        const TOP = [[14, 40], [12, 12], [16, -14, 1], [70, -18, 1], [122, -14, 1], [126, 10], [127, 26], [120, 33], [104, 33], [86, 31], [70, 35], [58, 43], [48, 50], [30, 44]];
        shape(g, TOP, H.hair);
        g.save(); clipTo(g, TOP);
        g.fillStyle = H.hairMid; g.beginPath(); trace(g, [[0, 30], [40, 30], [56, 40], [56, 60], [0, 60]], true); g.fill();
        const L = [];
        for (let x = 20; x <= 122; x += 7) L.push([x, 34 - (x > 60 ? 4 : 0), x + 1, -16]);
        clumps(g, L, H.hairDark, H.hairLite, 2.6);
        g.fillStyle = H.hairLite; g.globalAlpha = 0.55; g.fillRect(16, -16, 108, 5); g.globalAlpha = 1;        // the level top, catching the light
        g.restore();
        shape(g, TOP, null, 2.7);
      },
    });
  }
  // Afro: deep brown skin, a big lumpy cloud of an afro, wider than tall.
  const AFRO = { w: 160, h: 205, dx: 22, dy: 38, skin: '#8f6048', shade: '#744a37', deep: '#5c3a2b', dot: '#674333', lite: '#a8785f', lip: '#7d5040',
    hair: '#241a17', hairMid: '#30241f', hairDark: '#140e0c', hairLite: '#57433a', iris: '#2a1f1a' };
  function headAfro(g, kp) {
    faceB(g, kp, AFRO, {
      stubble: false, brow: '#1d1513',
      hair(g, H) {
        // The afro: one big soft mass over the crown and the back of the head, its curls in two tones.
        const AF = [[44, 86], [30, 92], [12, 90], [-6, 80], [-18, 62], [-20, 40], [-14, 22], [-18, 6], [-6, -10], [8, -16], [20, -28], [40, -30],
          [56, -24], [72, -32], [92, -30], [106, -18], [120, -16], [132, -2], [134, 14], [136, 28], [126, 38], [104, 36], [84, 36], [66, 42], [54, 54], [48, 70]];
        shape(g, AF, H.hair);
        g.save(); clipTo(g, AF);
        g.fillStyle = H.hairMid; g.beginPath(); trace(g, [[-30, -40], [60, -40], [40, 20], [20, 100], [-30, 100]], true); g.fill();
        g.strokeStyle = H.hairLite; g.lineWidth = 1.6;
        for (let y = -30, r = 0; y < 90; y += 9, r++) for (let x = -18 + (r & 1) * 5; x < 136; x += 10) { g.beginPath(); g.arc(x, y, 3.2, 3.6, 5.6); g.stroke(); }
        g.strokeStyle = H.hairDark; g.lineWidth = 1.4;
        for (let y = -26, r = 0; y < 90; y += 9, r++) for (let x = -13 + (r & 1) * 5; x < 136; x += 10) { g.beginPath(); g.arc(x, y, 3, 0.4, 2.6); g.stroke(); }
        g.restore();
        shape(g, AF, null, 2.7);
      },
    });
  }
  // Moustache: tanned and bald with a horseshoe of dark hair round the back and a big curled moustache.
  const TASH = { w: 140, h: 167, skin: '#d8a07c', shade: '#bf8262', deep: '#9b6447', dot: '#b2765a', lite: '#ecc2a2', lip: '#c4846a',
    hair: '#3a2a24', hairMid: '#4b382f', hairDark: '#231813', hairLite: '#7c665a', iris: '#3a2a20' };
  function headTash(g, kp) {
    faceB(g, kp, TASH, {
      stubble: false, brow: '#2e211c', crease: false,
      skull(g, H) {
        // The bald dome's shine and two forehead lines.
        g.fillStyle = H.lite; g.beginPath(); trace(g, [[56, 14], [80, 10], [100, 16], [84, 22], [64, 22]], true); g.fill();
        g.beginPath(); trace(g, [[96, 26], [108, 28], [112, 36], [102, 33]], true); g.fill();
      },
      before(g, H) {
        line(g, [[66, 44], [84, 40], [104, 44]], 1.6, INK2); line(g, [[70, 53], [86, 50], [102, 53]], 1.6, INK2);
      },
      hair(g, H) {
        // The horseshoe: short dark hair from the temple round the back, above the ear.
        const HS = [[8, 92], [2, 70], [4, 48], [14, 34], [28, 30], [40, 36], [46, 50], [44, 66], [38, 74], [30, 72], [22, 66], [16, 76], [14, 90]];
        shape(g, HS, H.hairMid);
        g.save(); clipTo(g, HS); dots(g, 0, 28, 50, 96, 2.4, 0.8, H.hairDark); g.restore();
        shape(g, HS, null, 2.4);
      },
      after(g, H) {
        // The moustache: a thick brush under the nose, its ends curled up past the cheeks.
        const MU = [[90, 116], [96, 108], [106, 106], [114, 108], [122, 106], [130, 102], [136, 92, 1], [138, 104], [132, 114], [122, 119], [112, 118],
          [104, 121], [94, 125], [84, 122], [78, 110, 1], [84, 116]];
        shape(g, MU, H.hair);
        g.save(); clipTo(g, MU);
        clumps(g, [[96, 110, 92, 122], [104, 108, 100, 121], [112, 109, 110, 119], [120, 108, 122, 117], [128, 104, 132, 112]], H.hairDark, H.hairLite, 2.6);
        g.restore();
        shape(g, MU, null, 2.4);
      },
    });
  }
  // Bowl cut: a dark brown bowl of hair with a ragged fringe over the brows, a round button nose.
  const BOWL = { w: 132, h: 167, skin: '#dea47c', shade: '#c88a64', deep: '#a26a4c', dot: '#b97c5a', lite: '#ecbd98', lip: '#c4826a',
    hair: '#3d2619', hairMid: '#33200f', hairDark: '#1d120a', hairLite: '#8a6248', iris: '#2b1f18' };
  function headBowl(g, kp) {
    faceB(g, kp, BOWL, {
      hairShadow: true, stubble: false, crease: false, brow: '#24170f',
      nose(g, H) {
        // A round button nose instead of the long one.
        shape(g, [[100, 92], [108, 90], [116, 94], [118, 102], [112, 107], [102, 106], [97, 100]], H.lite, 2.2);
        g.fillStyle = H.deep; g.beginPath(); g.arc(110, 104, 2.2, 0, TAU); g.fill();
        line(g, [[96, 98], [86, 108], [82, 120], [86, 132]], 2);
      },
      hair(g, H) {
        const HR = [[8, 92], [2, 66], [6, 38], [22, 14], [50, 0], [84, -2], [110, 8], [126, 26], [132, 46], [133, 60, 1], [126, 56, 1], [120, 63, 1],
          [112, 57, 1], [104, 62, 1], [96, 56, 1], [88, 62, 1], [80, 57, 1], [72, 63, 1], [64, 58, 1], [56, 66, 1], [50, 70], [46, 86], [36, 90], [22, 94]];
        shape(g, HR, H.hair);
        g.save(); clipTo(g, HR);
        g.fillStyle = H.hairMid; g.beginPath(); trace(g, [[-4, 30], [34, 26], [50, 50], [48, 100], [-4, 100]], true); g.fill();
        const L = [];
        for (let x = 28; x <= 128; x += 8) L.push([x - 14, 4 + Math.abs(x - 70) * 0.25, x, 60]);
        clumps(g, L, H.hairDark, H.hairLite, 2.8);
        dots(g, 4, 34, 46, 96, 3, 0.8, H.hairDark);
        g.restore();
        shape(g, HR, null, 2.7);
        g.globalAlpha = 0.5; line(g, [[30, 30], [56, 12], [90, 8], [118, 22]], 5, H.hairLite); g.globalAlpha = 1;   // the sheen
      },
    });
  }

  // id -> painter and frame. dx, dy: where the classic face sits inside a bigger frame.
  const FACES = {
    beard: { paint: headBeard, w: BEARD.w, h: BEARD.h },
    spikes: { paint: headSpikes, w: SPIKES.w, h: SPIKES.h },
    flattop: { paint: headFlattop, w: FLATTOP.w, h: FLATTOP.h, dx: FLATTOP.dx, dy: FLATTOP.dy, base: 'spikes' },
    afro: { paint: headAfro, w: AFRO.w, h: AFRO.h, dx: AFRO.dx, dy: AFRO.dy, base: 'spikes' },
    tash: { paint: headTash, w: TASH.w, h: TASH.h, base: 'spikes' },
    bowl: { paint: headBowl, w: BOWL.w, h: BOWL.h, base: 'spikes' },
  };
  const SEAT = ['beard', 'spikes'];
  /* The face a seat shows: the id it wears, or the seat's own. frame: { w, h, ax, ay } with the anchor placed so the
     face sits where the classic face of its build sits. */
  function faceOf(id, side) { return FACES[id] ? id : SEAT[side === 1 ? 1 : 0]; }
  function frame(id) {
    const F = FACES[id] || FACES.beard, B = FACES[F.base || id] || F, dx = F.dx || 0, dy = F.dy || 0;
    return { w: F.w, h: F.h, ax: (0.5 * B.w + dx) / F.w, ay: (0.8 * B.h + dy) / F.h };
  }
  // A face's skin tones (skin, shade, deep), which the hands take.
  const PAL = { beard: BEARD, spikes: SPIKES, flattop: FLATTOP, afro: AFRO, tash: TASH, bowl: BOWL };
  function skin(id) { return PAL[id] || BEARD; }
  // Paint a face facing right at the origin of its frame (atlas px), the collar in kp's colours.
  function paint(g, id, kp) {
    const F = FACES[id] || FACES.beard;
    g.save(); g.translate(F.dx || 0, F.dy || 0); F.paint(g, kp); g.restore();
  }

  root.HSFaces = {
    faceOf, frame, paint, skin, ids: Object.keys(FACES),
    pen: { TAU, INK, INK2, WHITE, WSHADE, WMID, WLITE, hexRgb, rgbHex, mix, kitOf, trace, shape, line, clipTo, dots, tone },
  };
})(window);
