const BASE_SIZE = 48 * 0.62;
const BASE_GAP  = 14.6 * 0.62;
const TILT     = -0.285;
const cosT     = Math.cos(TILT);
const sinT     = Math.sin(TILT);

// ── Palette (designed in the background preview) ──────────────────────────────
const GAP_RGB   = 'rgb(14,21,32)';   // dark navy gap between hexes
const OUTLINE   = 'rgb(2,4,7)';      // near-black hex outline
const FACE_TOP  = 'rgb(44,60,84)';   // navy face, light top
const FACE_BOT  = 'rgb(17,27,40)';   // navy face, dark bottom

// Reusable grain tile (generated once so the noise doesn't shimmer on rebuild)
const NT = 160;
let _noiseTile = null;
function noiseTile() {
  if (_noiseTile) return _noiseTile;
  _noiseTile = new OffscreenCanvas(NT, NT);
  const nc = _noiseTile.getContext('2d');
  const im = nc.createImageData(NT, NT);
  for (let i = 0; i < NT * NT; i++) {
    const v = 128 + (Math.random() - 0.5) * 50;
    im.data[i*4] = v; im.data[i*4+1] = v; im.data[i*4+2] = v; im.data[i*4+3] = 255;
  }
  nc.putImageData(im, 0, 0);
  return _noiseTile;
}

function hexPath(ctx, sx, sy, r) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i + Math.PI / 6 + TILT;
    ctx.lineTo(sx + r * Math.cos(a), sy + r * Math.sin(a));
  }
  ctx.closePath();
}

self.onmessage = function ({ data: { worldCX, worldCY, scale, screenW, screenH, hexScale } }) {
  const hs       = hexScale || 1.0;
  const SIZE     = BASE_SIZE * hs;
  const GAP      = BASE_GAP  * hs;
  const FACE_R   = SIZE - GAP / 2;
  const COL_STEP = Math.sqrt(3) * SIZE + GAP;
  const ROW_STEP = 1.5 * SIZE + Math.sqrt(3) / 2 * GAP;

  const W = screenW * 2, H = screenH * 2;
  const oc  = new OffscreenCanvas(W, H);
  const ctx = oc.getContext('2d');

  // gap background
  ctx.fillStyle = GAP_RGB;
  ctx.fillRect(0, 0, W, H);

  // world->screen mapping (tilt + scale), computed per vertex so we can draw in
  // screen space (keeps the gradient screen-vertical and the shadow predictable)
  const a = scale * cosT, b = scale * sinT, c = -scale * sinT, d = scale * cosT;
  const e = W / 2 - worldCX * scale, f = H / 2 - worldCY * scale;

  const halfW    = W / (2 * scale);
  const halfH    = H / (2 * scale);
  const rowStart = Math.floor((worldCY - halfH) / ROW_STEP) - 4;
  const rowEnd   = Math.ceil ((worldCY + halfH) / ROW_STEP) + 4;
  const colStart = Math.floor((worldCX - halfW) / COL_STEP) - 4;
  const colEnd   = Math.ceil ((worldCX + halfW) / COL_STEP) + 4;

  const r = FACE_R * scale;          // hex radius in screen px
  ctx.lineJoin = 'round';
  ctx.lineCap  = 'round';

  for (let row = rowStart; row <= rowEnd; row++) {
    const off = (Math.abs(row % 2) === 1) ? COL_STEP / 2 : 0;
    for (let col = colStart; col <= colEnd; col++) {
      const gx = col * COL_STEP + off;
      const gy = row * ROW_STEP;
      const sx = a * gx + c * gy + e;
      const sy = b * gx + d * gy + f;

      // soft drop shadow cast into the gap (lower-left)
      ctx.shadowColor   = 'rgba(0,0,0,0.55)';
      ctx.shadowBlur    = r * 0.18;
      ctx.shadowOffsetX = -r * 0.10;
      ctx.shadowOffsetY =  r * 0.12;

      const g = ctx.createLinearGradient(sx, sy - r, sx, sy + r);
      g.addColorStop(0, FACE_TOP);
      g.addColorStop(1, FACE_BOT);
      hexPath(ctx, sx, sy, r);
      ctx.fillStyle = g;
      ctx.fill();

      // black outline (no shadow)
      ctx.shadowColor = 'rgba(0,0,0,0)';
      ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
      hexPath(ctx, sx, sy, r);
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth   = Math.max(2, r * 0.12);
      ctx.stroke();
    }
  }

  // diagonal shade — top-right lighter, bottom-left darker
  const overlay = ctx.createLinearGradient(W, 0, 0, H);
  overlay.addColorStop(0, 'rgba(0,0,0,0.06)');
  overlay.addColorStop(1, 'rgba(0,0,0,0.28)');
  ctx.fillStyle = overlay;
  ctx.fillRect(0, 0, W, H);

  // subtle grain
  ctx.save();
  ctx.globalAlpha = 0.05;
  ctx.globalCompositeOperation = 'overlay';
  const tile = noiseTile();
  for (let y = 0; y < H; y += NT) for (let x = 0; x < W; x += NT) ctx.drawImage(tile, x, y);
  ctx.restore();

  const bitmap = oc.transferToImageBitmap();
  self.postMessage({ bitmap, worldCX, worldCY, scale }, [bitmap]);
};
