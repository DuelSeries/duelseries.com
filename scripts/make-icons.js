'use strict';
/* Generates the PWA app icons.
   Chrome will only build a real installed app (a WebAPK, which is what can go
   fullscreen and hide the status bar) if the manifest offers a PNG of at least
   192x192. With anything smaller, Add to Home Screen silently makes a plain
   bookmark shortcut that opens in a browser tab with all its chrome — which
   looks like the fullscreen setting being ignored, but is really the install
   never having happened.

   Written by hand with zlib rather than pulled from an image library: this runs
   once in a while and is not worth a dependency. Re-run with:
     node scripts/make-icons.js
*/
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'public', 'img');

// ── PNG encoding ────────────────────────────────────────────────────────────
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;     // bit depth
  ihdr[9] = 6;     // colour type: RGBA
  // 10,11,12 = compression, filter, interlace — all 0
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;                      // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── the mark ────────────────────────────────────────────────────────────────
const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const INK = hex('#100e0b');      // the lobby's background
const BODY = hex('#c080ff');     // the snake
const AMBER = hex('#f0a830');    // the money accent

/* Distance from p to the segment ab, used to give the snake a round-capped
   body of even thickness however the curve bends. */
function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function draw(size) {
  const buf = Buffer.alloc(size * size * 4);
  /* Maskable icons get cropped to a circle on some launchers, so the mark stays
     inside the middle 80% and the background bleeds to the edges. */
  const S = size / 512;
  const pts = [];
  for (let i = 0; i <= 60; i++) {
    const u = i / 60;
    pts.push([ (110 + u * 300) * S, (300 - Math.sin(u * Math.PI * 1.15) * 105) * S ]);
  }
  const R = 46 * S;                       // body radius
  const headX = pts[pts.length - 1][0], headY = pts[pts.length - 1][1];
  const foodR = 20 * S;
  const foodX = (452) * S, foodY = (168) * S;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      let r = INK[0], g = INK[1], b = INK[2];

      let d = Infinity;
      for (let i = 1; i < pts.length; i++) {
        const dd = distToSeg(x, y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
        if (dd < d) d = dd;
      }
      // Antialiased edge: one pixel of falloff either side of the radius.
      const aBody = Math.max(0, Math.min(1, (R - d) + 0.5));
      if (aBody > 0) {
        /* Lit from above, like the in-game body: brightest along the top of the
           cross-section, falling off towards the silhouette. */
        const lift = Math.max(0, Math.min(1, 1 - d / R));
        const k = 0.55 + 0.45 * Math.pow(lift, 0.6);
        r = r + (BODY[0] * k - r) * aBody;
        g = g + (BODY[1] * k - g) * aBody;
        b = b + (BODY[2] * k - b) * aBody;
      }

      const df = Math.hypot(x - foodX, y - foodY);
      const aFood = Math.max(0, Math.min(1, (foodR - df) + 0.5));
      if (aFood > 0) {
        r = r + (AMBER[0] - r) * aFood;
        g = g + (AMBER[1] - g) * aFood;
        b = b + (AMBER[2] - b) * aFood;
      }

      // The eye, so it reads as a creature and not a ribbon.
      const de = Math.hypot(x - (headX - 6 * S), y - (headY - 12 * S));
      const aEye = Math.max(0, Math.min(1, (13 * S - de) + 0.5));
      if (aEye > 0) { r = r + (255 - r) * aEye; g = g + (255 - g) * aEye; b = b + (255 - b) * aEye; }
      const dp = Math.hypot(x - (headX - 3 * S), y - (headY - 12 * S));
      const aPup = Math.max(0, Math.min(1, (6 * S - dp) + 0.5));
      if (aPup > 0) { r = r * (1 - aPup); g = g * (1 - aPup); b = b * (1 - aPup); }

      buf[o] = Math.round(r); buf[o + 1] = Math.round(g); buf[o + 2] = Math.round(b); buf[o + 3] = 255;
    }
  }
  return png(size, size, buf);
}

for (const size of [192, 512]) {
  const file = path.join(OUT, `icon-${size}.png`);
  fs.writeFileSync(file, draw(size));
  console.log('wrote', file, fs.statSync(file).size, 'bytes');
}
