'use strict';
/* Cuts every icon the site uses from ONE source file, public/img/logo-source.png:
     favicon-16/32      the browser tab and the bookmark bar
     apple-touch-180    iOS home screen and Safari bookmarks
     icon-192/512       the installed app (Chrome needs >=192 to install at all)

   This used to redraw the emblem from canvas primitives, because the real
   artwork was not on disk. It is now, so nothing is redrawn and nothing is
   approximated: every size is a resample of the actual file, and that file is
   the only thing anyone needs to replace to change the brand mark.

   Node has no image decoder in core, so PNG decode and the downscale are both
   here. The decode is the boring half of the spec (inflate, then undo the
   per-scanline filters). The downscale is a box filter — each destination
   pixel averages exactly the source pixels it covers — which for shrinking is
   not a compromise but the correct answer: it uses every source pixel exactly
   once, where bilinear sampling would skip most of them and alias the thin
   highlights on the blades into sparkle.

   Alpha is premultiplied before averaging and divided back out after. Skipping
   that step averages the colour of fully transparent pixels into the edge and
   leaves a dark halo around the ring.

   Re-run after replacing the source:  node scripts/make-icons.js
*/
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const IMG = path.join(__dirname, '..', 'public', 'img');
const SRC = path.join(IMG, 'logo-source.png');

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

// ── PNG decoding ────────────────────────────────────────────────────────────
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  const depth = buf[24], colour = buf[25], interlace = buf[28];
  if (depth !== 8) throw new Error(`bit depth ${depth} unsupported, need 8`);
  if (colour !== 6 && colour !== 2) throw new Error(`colour type ${colour} unsupported, need 2 or 6`);
  if (interlace) throw new Error('interlaced PNG unsupported');

  const parts = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') parts.push(buf.slice(off + 8, off + 8 + len));
    if (type === 'IEND') break;
    off += 12 + len;
  }
  const data = zlib.inflateSync(Buffer.concat(parts));

  const ch = colour === 6 ? 4 : 3;          // source channels
  const stride = w * ch;
  const out = Buffer.alloc(w * h * 4);
  const line = Buffer.alloc(stride);
  const prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = data[p++];
    data.copy(line, 0, p, p + stride); p += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? line[i - ch] : 0;   // left
      const b = prev[i];                      // up
      const c = i >= ch ? prev[i - ch] : 0;   // up-left
      let v = line[i];
      switch (filter) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {                              // Paeth
          const pp = a + b - c;
          const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
          v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
          break;
        }
        default: throw new Error('bad filter ' + filter);
      }
      line[i] = v & 0xff;
    }
    for (let x = 0; x < w; x++) {
      const s = x * ch, d = (y * w + x) * 4;
      out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2];
      out[d + 3] = ch === 4 ? line[s + 3] : 255;
    }
    line.copy(prev);
  }
  return { w, h, rgba: out };
}

// ── box-filter resize, alpha-correct ────────────────────────────────────────
function resize(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  const xr = sw / dw, yr = sh / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * yr), y1 = Math.max(y0 + 1, Math.floor((y + 1) * yr));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * xr), x1 = Math.max(x0 + 1, Math.floor((x + 1) * xr));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1 && sy < sh; sy++) {
        for (let sx = x0; sx < x1 && sx < sw; sx++) {
          const i = (sy * sw + sx) * 4, al = src[i + 3] / 255;
          r += src[i] * al; g += src[i + 1] * al; b += src[i + 2] * al;
          a += src[i + 3]; n++;
        }
      }
      const d = (y * dw + x) * 4;
      const am = a / n;                       // mean alpha, 0..255
      if (am > 0) {
        const k = n * (am / 255);             // undo the premultiply
        out[d] = Math.round(r / k); out[d + 1] = Math.round(g / k); out[d + 2] = Math.round(b / k);
      }
      out[d + 3] = Math.round(am);
    }
  }
  return out;
}

// Composite onto an opaque square, or leave transparent when bg is null.
function compose(size, fit, fw, fh, bg) {
  const out = Buffer.alloc(size * size * 4);
  if (bg) {
    for (let i = 0; i < size * size; i++) {
      out[i * 4] = bg[0]; out[i * 4 + 1] = bg[1]; out[i * 4 + 2] = bg[2]; out[i * 4 + 3] = 255;
    }
  }
  const ox = Math.round((size - fw) / 2), oy = Math.round((size - fh) / 2);
  for (let y = 0; y < fh; y++) {
    for (let x = 0; x < fw; x++) {
      const dx = ox + x, dy = oy + y;
      if (dx < 0 || dy < 0 || dx >= size || dy >= size) continue;
      const s = (y * fw + x) * 4, d = (dy * size + dx) * 4;
      const al = fit[s + 3] / 255;
      if (al <= 0) continue;
      const ia = 1 - al;
      out[d]     = Math.round(fit[s]     * al + out[d]     * ia);
      out[d + 1] = Math.round(fit[s + 1] * al + out[d + 1] * ia);
      out[d + 2] = Math.round(fit[s + 2] * al + out[d + 2] * ia);
      out[d + 3] = Math.min(255, Math.round(fit[s + 3] + out[d + 3] * ia));
    }
  }
  return out;
}

const INK = [0x10, 0x0e, 0x0b];   // the lobby background

/* fill: how much of the square the emblem occupies.
   The two app icons are declared maskable, and a launcher may crop a maskable
   icon to any shape, taking up to ~10% off each edge. They get the ink ground
   and the emblem at 80%, which keeps it inside the safe circle. Favicons are
   tiny and never masked, so they use the whole square and stay transparent. */
const SIZES = [
  { file: 'favicon-16.png',       size: 16,  fill: 1.00, bg: null },
  { file: 'favicon-32.png',       size: 32,  fill: 1.00, bg: null },
  { file: 'apple-touch-icon.png', size: 180, fill: 0.92, bg: INK  },
  { file: 'icon-192.png',         size: 192, fill: 0.80, bg: INK  },
  { file: 'icon-512.png',         size: 512, fill: 0.80, bg: INK  },
];

function main() {
  if (!fs.existsSync(SRC)) {
    console.error('Missing ' + path.relative(process.cwd(), SRC) + ' — put the artwork there first.');
    process.exit(1);
  }
  const src = decodePng(fs.readFileSync(SRC));
  console.log(`source ${src.w}x${src.h}`);

  for (const { file, size, fill, bg } of SIZES) {
    // Contain rather than cover: the source is not square and cropping it
    // would clip the ring.
    const target = size * fill;
    const scale = Math.min(target / src.w, target / src.h);
    const fw = Math.max(1, Math.round(src.w * scale));
    const fh = Math.max(1, Math.round(src.h * scale));
    const fit = resize(src.rgba, src.w, src.h, fw, fh);
    const out = compose(size, fit, fw, fh, bg);
    fs.writeFileSync(path.join(IMG, file), png(size, size, out));
    console.log(`  ${file.padEnd(22)} ${size}x${size}  emblem ${fw}x${fh}${bg ? '  on ink' : '  transparent'}`);
  }
  console.log('done');
}

module.exports = { decodePng, resize, SIZES };
if (require.main === module) main();
