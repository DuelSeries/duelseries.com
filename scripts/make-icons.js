'use strict';
/* Generates every icon the site uses, from one drawing, at every size a
   browser or launcher asks for:
     favicon-16/32      the browser tab and the bookmark bar
     apple-touch-180    iOS home screen and Safari bookmarks
     icon-192/512       the installed app (Chrome needs >=192 to install at all)

   The mark is DuelSeries': crossed swords inside a gold ring on the lobby's
   ink background. It is drawn as geometry rather than traced from a render,
   because the whole job of this file is producing something legible at 16
   pixels. A photoreal metallic render carries detail that turns to grey mush
   at that size; flat shapes with one light direction do not.

   Drawn at 3x and averaged down, which is the cheapest way to get clean edges
   on every shape at once without writing a rasteriser per primitive.

   Re-run after any change:  node scripts/make-icons.js
*/
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'public', 'img');
const SS = 3;                                  // supersampling factor

// ── PNG encoding ────────────────────────────────────────────────────────────
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c; }
  return t;
})();
const crc32 = b => { let c = -1;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── palette ─────────────────────────────────────────────────────────────────
const INK   = [0x10, 0x0e, 0x0b];     // the lobby background
const PLATE = [0x1a, 0x1a, 0x1c];     // the disc behind the swords
const GOLD_L = [0xf7, 0xd0, 0x6b];    // gold, lit edge
const GOLD_M = [0xd4, 0xa0, 0x30];    // gold, body
const GOLD_D = [0x9a, 0x6c, 0x12];    // gold, shadow edge
const STEEL_L = [0xf2, 0xf4, 0xf7];   // blade, lit face
const STEEL_M = [0xc3, 0xc9, 0xd2];   // blade, body
const STEEL_D = [0x8d, 0x94, 0x9e];   // blade, shadow face
const GRIP    = [0x2a, 0x26, 0x22];   // leather-wrapped handle

// ── drawing helpers, all operating on a float RGB buffer ────────────────────
function makeCanvas(n) { return { n, px: new Float32Array(n * n * 3) }; }
function fillAll(c, col) {
  for (let i = 0; i < c.n * c.n; i++) { c.px[i*3] = col[0]; c.px[i*3+1] = col[1]; c.px[i*3+2] = col[2]; }
}
function put(c, x, y, col) {
  if (x < 0 || y < 0 || x >= c.n || y >= c.n) return;
  const i = (y * c.n + x) * 3;
  c.px[i] = col[0]; c.px[i+1] = col[1]; c.px[i+2] = col[2];
}
const mix = (a, b, t) => [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t];

/* Annulus with a light direction, so the ring reads as a bevelled metal band
   rather than a flat donut: lighter at the top-left, darker at the bottom. */
function ring(c, cx, cy, rOuter, rInner) {
  for (let y = 0; y < c.n; y++) for (let x = 0; x < c.n; x++) {
    const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
    const d = Math.hypot(dx, dy);
    if (d > rOuter || d < rInner) continue;
    const across = (d - rInner) / Math.max(1e-6, rOuter - rInner);   // 0 inner .. 1 outer
    const lightDir = (-dx - dy) / (Math.SQRT2 * Math.max(1e-6, d));   // -1 .. 1
    let col = mix(GOLD_D, GOLD_L, Math.max(0, Math.min(1, 0.5 + lightDir * 0.5)));
    col = mix(col, GOLD_M, Math.abs(across - 0.5) * 0.9);
    put(c, x, y, col);
  }
}
function disc(c, cx, cy, r, col) {
  for (let y = 0; y < c.n; y++) for (let x = 0; x < c.n; x++) {
    const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
    if (dx*dx + dy*dy <= r*r) put(c, x, y, col);
  }
}
/* Even-odd point-in-polygon. Every sword part is a polygon so one routine
   covers blade, guard and grip. */
function inPoly(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/* Fills a polygon with a left-to-right shade across its own axis, which is what
   gives the blade a lit face, a bright fuller and a shadowed face. */
function fillPoly(c, pts, shade) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
                         minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
  for (let y = Math.max(0, Math.floor(minY)); y <= Math.min(c.n - 1, Math.ceil(maxY)); y++)
    for (let x = Math.max(0, Math.floor(minX)); x <= Math.min(c.n - 1, Math.ceil(maxX)); x++)
      if (inPoly(x + 0.5, y + 0.5, pts)) put(c, x, y, shade(x + 0.5, y + 0.5));
}
const rot = (x, y, cx, cy, a) => {
  const s = Math.sin(a), co = Math.cos(a), dx = x - cx, dy = y - cy;
  return [cx + dx * co - dy * s, cy + dx * s + dy * co];
};

/* One sword, drawn pointing up through the centre then rotated. Proportions are
   matched to the reference: a long blade reaching most of the way to the ring,
   a crescent crossguard whose ends sweep up towards the tip, a banded grip, and
   a ball pommel sitting out near the inner ring. */
function sword(c, cx, cy, R, angle) {
  const P = (x, y) => rot(cx + x * R, cy + y * R, cx, cy, angle);
  const halfW = 0.062, tipY = -0.70, shoulderY = -0.52, guardY = 0.20;

  // Blade: parallel sides, then a long point.
  const blade = [P(-halfW, guardY), P(-halfW, shoulderY), P(0, tipY),
                 P(halfW, shoulderY), P(halfW, guardY)];
  /* Shaded across the blade's own width, with the axis rotated with it, so the
     lit face and the central fuller stay put whichever way the sword points. */
  const ux = Math.cos(angle), uy = Math.sin(angle);
  fillPoly(c, blade, (x, y) => {
    const k = Math.max(0, Math.min(1,
      ((x - cx) * ux + (y - cy) * uy) / (halfW * R) * 0.5 + 0.5));
    return k < 0.38 ? mix(STEEL_D, STEEL_M, k / 0.38)
         : k < 0.56 ? STEEL_L                       // the fuller catching light
         : mix(STEEL_M, STEEL_D, (k - 0.56) / 0.44);
  });

  /* Crescent crossguard: the ends rise towards the tip, which is the detail
     that makes it read as a sword hilt rather than a plus sign. Built by
     sampling the curve rather than as a straight bar. */
  const gw = 0.30, gh = 0.075, bow = 0.11, N = 14;
  const top = [], bottom = [];
  for (let i = 0; i <= N; i++) {
    const t = -1 + (2 * i) / N;
    const yc = guardY - bow * t * t;
    top.push(P(t * gw, yc - gh / 2));
    bottom.push(P(t * gw, yc + gh / 2));
  }
  fillPoly(c, top.concat(bottom.reverse()), () => GOLD_M);
  // A lit sliver along the guard's upper edge.
  const lip = [];
  for (let i = 0; i <= N; i++) {
    const t = -1 + (2 * i) / N;
    lip.push(P(t * gw, guardY - bow * t * t - gh / 2));
  }
  for (let i = N; i >= 0; i--) {
    const t = -1 + (2 * i) / N;
    lip.push(P(t * gw, guardY - bow * t * t - gh / 2 + gh * 0.42));
  }
  fillPoly(c, lip, () => GOLD_L);

  // Grip, with two gold bands like the reference.
  fillPoly(c, [P(-0.050, guardY + gh / 2), P(-0.050, 0.50),
               P(0.050, 0.50), P(0.050, guardY + gh / 2)], () => GRIP);
  for (const by of [0.31, 0.41]) {
    fillPoly(c, [P(-0.052, by), P(-0.052, by + 0.026),
                 P(0.052, by + 0.026), P(0.052, by)], () => GOLD_D);
  }

  // Ball pommel, lit from the same direction as the ring.
  const pom = P(0, 0.575), pr = 0.085 * R;
  for (let y = Math.max(0, Math.floor(pom[1] - pr)); y <= Math.min(c.n - 1, Math.ceil(pom[1] + pr)); y++)
    for (let x = Math.max(0, Math.floor(pom[0] - pr)); x <= Math.min(c.n - 1, Math.ceil(pom[0] + pr)); x++) {
      const dx = x + 0.5 - pom[0], dy = y + 0.5 - pom[1];
      if (dx * dx + dy * dy > pr * pr) continue;
      put(c, x, y, mix(GOLD_L, GOLD_D,
        Math.max(0, Math.min(1, (dx + dy) / (2 * pr) + 0.5))));
    }
}

function draw(size, { bleed = true } = {}) {
  const n = size * SS;
  const c = makeCanvas(n);
  fillAll(c, bleed ? INK : INK);
  const cx = n / 2, cy = n / 2;
  const R = n * 0.5;

  ring(c, cx, cy, R * 0.96, R * 0.80);          // outer gold band
  disc(c, cx, cy, R * 0.80, INK);               // gap
  ring(c, cx, cy, R * 0.74, R * 0.68);          // inner gold hairline
  disc(c, cx, cy, R * 0.68, PLATE);             // the dark plate

  /* Crossed, and short enough to stay inside the plate. Drawn at 3/4 scale of
     the plate so the blades never touch the ring, which is what turns to a
     smudge at 16px. */
  const swordR = R * 0.62;
  sword(c, cx, cy + R * 0.06, swordR, Math.PI * 0.22);
  sword(c, cx, cy + R * 0.06, swordR, -Math.PI * 0.22);

  // Average the supersampled buffer down to the requested size.
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const i = (((y * SS + sy) * n) + (x * SS + sx)) * 3;
      r += c.px[i]; g += c.px[i+1]; b += c.px[i+2];
    }
    const k = SS * SS, o = (y * size + x) * 4;
    out[o] = Math.round(r / k); out[o+1] = Math.round(g / k);
    out[o+2] = Math.round(b / k); out[o+3] = 255;
  }
  return png(size, size, out);
}

const targets = [
  ['favicon-16.png', 16], ['favicon-32.png', 32],
  ['apple-touch-icon.png', 180],
  ['icon-192.png', 192], ['icon-512.png', 512],
];
for (const [name, size] of targets) {
  const file = path.join(OUT, name);
  fs.writeFileSync(file, draw(size));
  console.log('wrote', name.padEnd(22), size + 'x' + size, fs.statSync(file).size + ' bytes');
}
