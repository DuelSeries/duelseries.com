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
  // Measured colours (atlas frames, see SP/hs-tools/notes-c.md).
  const INK = '#440201', INK2 = '#571813';            // every outline; the softer inner line
  const WHITE = '#f8f7fd', WSHADE = '#d4c7d5', WMID = '#ddd6e2', WLITE = '#ece7ef';   // socks, wristbands, teeth, eyes
  const SOLE = '#840f0c', STUD = '#ad1613', SOLELIT = '#ee3937';
  // Kit triples measured on their blue (France) and red kits; any other kit colour is shaded by mixing.
  const KITS = {
    '#393295': { base: '#393295', dark: '#3b2f73', deep: '#332655', light: '#4c48a9' },
    '#ad1613': { base: '#ad1613', dark: '#840f0c', deep: '#680906', light: '#ee3937' },
  };
  const DEFAULT_KIT = ['#ad1613', '#393295'];          // seat 0 red, seat 1 blue (their palette)
  let kits = [null, null];

  /* ── small helpers ──────────────────────────────────────────────────────── */
  function hexRgb(h) {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(h || '').trim());
    if (!m) return null;
    let s = m[1]; if (s.length === 3) s = s.split('').map(c => c + c).join('');
    return [0, 2, 4].map(i => parseInt(s.slice(i, i + 2), 16));
  }
  const rgbHex = (c) => '#' + c.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  const mix = (a, b, t) => rgbHex(a.map((v, i) => v + (b[i] - v) * t));
  function kitPal(side) {
    const want = kits[side] || DEFAULT_KIT[side], key = String(want).toLowerCase();
    if (KITS[key]) return KITS[key];
    const c = hexRgb(want) || hexRgb(DEFAULT_KIT[side]);
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

  /* ── the heads ──────────────────────────────────────────────────────────── */
  // Frame sizes are the reference's head frames for the same seats (131 x 187 and 132 x 167 atlas px, drawn
  // 145.6 x 207.8 and 146.7 x 185.6 units), anchored at (.5, .8) like theirs, built the way theirs are: 3/4 view,
  // tipped forward, big cranium over a jutting jaw, squinting eyes under heavy brows, a toothy grin, the collar
  // under the chin. The two faces are our own invented players. Colours are entries of their atlas (notes-c.md).
  const HEADS = [
    { w: 131, h: 187, skin: '#75504c', shade: '#5d473d', deep: '#4d352d', dot: '#514239', lite: '#806870', lip: '#7e6570',
      scalp: '#6d5a52', hair: '#1d1e25', hairMid: '#2a2a33', hairLite: '#554d48', iris: '#2a2a33' },
    { w: 132, h: 167, skin: '#eabfa8', shade: '#da958a', deep: '#b47c6e', dot: '#d18c81', lite: '#e2b09d', lip: '#da958a',
      hair: '#ae8b66', hairMid: '#9a724b', hairDark: '#7b6352', hairLite: '#d2c097', iris: '#7b6352' },
  ];

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

  // Seat 0: dark skin, a shaved head, a thick short beard.
  function headA(g, kp) {
    const H = HEADS[0];
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

  // Seat 1: light skin, short spiky light-brown hair, a stubbly jaw.
  function headB(g, kp) {
    const H = HEADS[1];
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
    g.fillStyle = H.shade; g.beginPath(); trace(g, [[50, 36], [80, 32], [118, 34], [118, 44], [80, 42], [54, 48]], true); g.fill();                       // the hair's shadow
    g.fillStyle = H.deep; g.beginPath(); trace(g, [[106, 102], [124, 104], [118, 109], [108, 108]], true); g.fill();
    // Stubble over the jaw, chin and upper lip.
    const ST = [[36, 100], [50, 110], [64, 122], [80, 124], [92, 112], [110, 108], [130, 108], [130, 170], [30, 170]];
    g.fillStyle = '#e0a493'; g.beginPath(); trace(g, ST, true); g.fill();
    g.save(); g.beginPath(); trace(g, ST, true); g.clip(); dots(g, 30, 100, 130, 170, 2, 0.45, H.deep); g.restore();
    g.restore();
    shape(g, SK, null, 2.7);
    ear(g, H, [[24, 76], [12, 70], [3, 78], [2, 94], [8, 110], [20, 120], [30, 116], [32, 102]],
      [[[8, 78], [16, 74], [24, 82], [24, 108], [16, 114], [8, 104]], [[12, 82], [8, 94], [12, 106], [22, 112]], [[17, 88], [21, 96], [18, 104]]]);
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
    // Brows, crow's feet, squinting eyes.
    shape(g, [[58, 71], [70, 64], [92, 63], [104, 69], [99, 73], [80, 70], [64, 76]], H.hairMid, 2);
    shape(g, [[108, 70], [118, 64], [129, 66], [128, 72], [116, 74]], H.hairMid, 2);
    eye(g, H, [[72, 82.5], [80, 80.3], [90, 80.3], [94, 82.3], [86, 84], [76, 84]], [87, 82.5], 2.6, [[66, 82], [78, 78.5], [92, 78.5], [98, 81]], [[74, 88], [86, 89], [94, 86]]);
    eye(g, H, [[108, 82], [114, 79.5], [121, 80.5], [120, 83.5], [111, 84]], [116.5, 82], 2.3, [[105, 81.5], [114, 78.5], [124, 79.5]]);
    line(g, [[60, 82], [55, 86]], 1.4, INK2); line(g, [[61, 88], [56, 92]], 1.4, INK2);
    line(g, [[100, 56], [98, 64]], 1.4, INK2);
    // The nose, the cheek fold, the grin.
    line(g, [[104, 84], [106, 94]], 1.9);
    line(g, [[100, 98], [97, 104], [104, 109], [117, 106]], 2.2);
    line(g, [[96, 98], [86, 108], [82, 120], [86, 132]], 2);
    grin(g, H, [[90, 120], [102, 116], [114, 114], [124, 115], [123, 122], [117, 130], [105, 134], [96, 131], [91, 126]],
      [[88, 116], [126, 112], [125, 123], [108, 126], [92, 125]], [[100, 117, 125], [107, 115, 125], [114, 114, 124], [120, 114, 122]],
      [[100, 131], [107, 128], [117, 127], [112, 133], [102, 135]], [[98, 136], [108, 138], [117, 133], [115, 139], [106, 143], [98, 140]]);
    line(g, [[100, 150], [108, 149]], 1.6, INK2);
  }
  function headSprite(side, k) {
    const H = HEADS[side], kp = kitPal(side);
    return sprite('h' + side + kp.base, H.w, H.h, k, (g) => (side ? headB : headA)(g, kp));
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
  function handSprite(side, front, k) {
    const H = HEADS[side];
    return front ? sprite('hf' + side, 66, 66, k, (g) => handFront(g, H)) : sprite('hb' + side, 73, 62, k, (g) => handBack(g, H));
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
    const sb = handSprite(side, false, k), sf = handSprite(side, true, k), bt = bootSprite(side, k), hd = headSprite(side, k), H = HEADS[side];
    g.save(); g.translate(x + hb[0] * a, y + hb[1]); g.rotate(hbA * a * D); g.scale(a, 1); blit(g, sb, 73, 62, 0.5, 0.5); g.restore();
    g.save(); g.translate(x + (32.5 + lx) * a, y + 130 + ly); g.rotate(lAng * D); g.scale(a, 1); blit(g, bt, 71, 59, 0.5, 0.5); g.restore();
    g.save(); g.translate(x, y + 55); g.rotate(headA * D); g.scale(look, 1); blit(g, hd, H.w, H.h, 0.5, 0.8); g.restore();
    g.save(); g.translate(x + kx * a, y + ky); g.rotate(kAng * D); g.scale(a * ksc, ksc); blit(g, bt, 71, 59, 0.5, 0.5); g.restore();
    g.save(); g.translate(x + hf[0] * a, y + hf[1]); g.rotate(hfA * a * D); g.scale(a, 1); blit(g, sf, 66, 66, 0.5, 0.5); g.restore();
  }

  root.HSChars = {
    player, ball: paintBall, ballBack, ballFront, BALL_R,
    setKits(cols) { kits = [cols && cols[0] || null, cols && cols[1] || null]; cache.clear(); },
  };
})(window);
