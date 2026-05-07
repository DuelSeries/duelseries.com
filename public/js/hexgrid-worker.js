const SIZE     = 48 * 0.62;
const GAP      = 14.6 * 0.62;
const FACE_R   = SIZE - GAP / 2;
const COL_STEP = Math.sqrt(3) * SIZE + GAP;
const ROW_STEP = 1.5 * SIZE + Math.sqrt(3) / 2 * GAP;
const TILT     = -0.285;
const cosT     = Math.cos(TILT);
const sinT     = Math.sin(TILT);

function hexPath(ctx, cx, cy, r) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i + Math.PI / 6;
    ctx.lineTo(cx + r * Math.cos(angle), cy + r * Math.sin(angle));
  }
  ctx.closePath();
}

function drawOne(ctx, cx, cy) {
  hexPath(ctx, cx, cy, FACE_R);
  ctx.fillStyle = '#0e0e0e';
  ctx.fill();

  hexPath(ctx, cx, cy, FACE_R);
  ctx.strokeStyle = 'rgba(1,1,1,0.95)';
  ctx.lineWidth = 5;
  ctx.stroke();
}

self.onmessage = function ({ data: { worldCX, worldCY, scale, screenW, screenH } }) {
  const W = screenW * 2, H = screenH * 2;
  const oc  = new OffscreenCanvas(W, H);
  const ctx = oc.getContext('2d');

  ctx.fillStyle = '#070707';
  ctx.fillRect(0, 0, W, H);

  ctx.setTransform(
    scale * cosT,  scale * sinT,
    -scale * sinT, scale * cosT,
    W / 2 - worldCX * scale,
    H / 2 - worldCY * scale
  );

  const halfW    = W / (2 * scale);
  const halfH    = H / (2 * scale);
  const rowStart = Math.floor((worldCY - halfH) / ROW_STEP) - 4;
  const rowEnd   = Math.ceil ((worldCY + halfH) / ROW_STEP) + 4;
  const colStart = Math.floor((worldCX - halfW) / COL_STEP) - 4;
  const colEnd   = Math.ceil ((worldCX + halfW) / COL_STEP) + 4;

  for (let row = rowStart; row <= rowEnd; row++) {
    for (let col = colStart; col <= colEnd; col++) {
      const cx = col * COL_STEP + (Math.abs(row % 2) === 1 ? COL_STEP / 2 : 0);
      const cy = row * ROW_STEP;
      drawOne(ctx, cx, cy);
    }
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const overlay = ctx.createLinearGradient(W, 0, 0, H);
  overlay.addColorStop(0, 'rgba(20,20,20,0.06)');
  overlay.addColorStop(1, 'rgba(0,0,0,0.28)');
  ctx.fillStyle = overlay;
  ctx.fillRect(0, 0, W, H);

  const bitmap = oc.transferToImageBitmap();
  self.postMessage({ bitmap, worldCX, worldCY, scale }, [bitmap]);
};
