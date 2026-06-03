// Hex background drawn as a repeating PATTERN: one small seamless tile is
// rendered once (rebuilt only when the zoom changes), then painted across the
// whole screen each frame as a tiled, tilted, panned pattern fill. This is
// O(1) per frame regardless of movement/zoom, so it never falls behind.
const HEX_TILT = -0.285;

class HexGrid {
  constructor(isMobile = false) {
    this._isMobile   = isMobile;
    this._tile       = null;
    this._tileScale  = 0;
    this._pattern    = null;

    this.SIZE     = 48 * 0.62;
    this.GAP      = 14.6 * 0.62;
    this.FACE_R   = this.SIZE - this.GAP / 2;
    this.COL_STEP = Math.sqrt(3) * this.SIZE + this.GAP;
    this.ROW_STEP = 1.5 * this.SIZE + Math.sqrt(3) / 2 * this.GAP;
  }

  _buildTile(physScale) {
    const { COL_STEP, ROW_STEP, FACE_R } = this;
    const tileW = Math.max(2, Math.round(COL_STEP * physScale));
    const tileH = Math.max(2, Math.round(2 * ROW_STEP * physScale));

    const r     = FACE_R * physScale;
    const lw    = Math.max(1.3, r * 0.125);
    const blurR = Math.max(0.5, r * 0.009);
    const pad   = Math.ceil(blurR * 3 + 2);

    // Render the tile content with a padded margin of wrapped neighbours, so the
    // blur can bleed correctly and the centre crop still tiles seamlessly.
    const big = document.createElement('canvas');
    big.width = tileW + pad * 2; big.height = tileH + pad * 2;
    const ctx = big.getContext('2d');
    ctx.fillStyle = 'rgb(15,25,38)';
    ctx.fillRect(0, 0, big.width, big.height);
    ctx.lineJoin = 'round';
    ctx.lineCap  = 'round';
    const grad = ctx.createLinearGradient(0, -r, 0, r);
    grad.addColorStop(0, 'rgb(35,49,70)');   // navy light top (less yellow)
    grad.addColorStop(1, 'rgb(17,27,39)');   // navy dark bottom (less yellow)

    const hex = (ox, oy) => { ctx.beginPath(); for (let i = 0; i < 6; i++) { const a = (Math.PI/3)*i + Math.PI/6; ctx.lineTo(ox + r*Math.cos(a), oy + r*Math.sin(a)); } ctx.closePath(); };

    for (let row = -2; row <= 3; row++) {
      const off = (((row % 2) + 2) % 2 === 1) ? COL_STEP / 2 : 0;
      for (let col = -2; col <= 3; col++) {
        const cx = (col * COL_STEP + off) * physScale + pad;
        const cy = (row * ROW_STEP) * physScale + pad;
        ctx.setTransform(1, 0, 0, 1, cx, cy);
        hex(-r * 0.10, r * 0.12);  ctx.fillStyle = 'rgba(0,0,0,0.28)'; ctx.fill();  // soft shadow
        hex(0, 0);                 ctx.fillStyle = grad;               ctx.fill();  // navy face
        hex(0, 0);                 ctx.strokeStyle = 'rgb(8,13,19)'; ctx.lineWidth = lw; ctx.stroke(); // outline (less yellow)
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // soft blur the padded content
    const blurred = document.createElement('canvas');
    blurred.width = big.width; blurred.height = big.height;
    const bctx = blurred.getContext('2d');
    bctx.filter = `blur(${blurR}px)`;
    bctx.drawImage(big, 0, 0);
    bctx.filter = 'none';

    // crop the centre period -> seamless blurred tile
    const c = document.createElement('canvas');
    c.width = tileW; c.height = tileH;
    const cctx = c.getContext('2d');
    cctx.drawImage(blurred, pad, pad, tileW, tileH, 0, 0, tileW, tileH);
    // subtle fuzzy grain (barely noticeable). Seeded PRNG so the grain is the
    // SAME on every rebuild -> no shimmer/flicker when the tile rebuilds on zoom.
    const gd = cctx.getImageData(0, 0, tileW, tileH), dd = gd.data;
    let s = 0x9e3779b9 >>> 0;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    for (let k = 0; k < dd.length; k += 4) { const n = (rnd() - 0.5) * 4; dd[k] += n; dd[k+1] += n; dd[k+2] += n; }
    cctx.putImageData(gd, 0, 0);

    this._tile      = c;
    this._tileScale = physScale;
    this._pattern   = null;   // recreated against the target ctx in draw()
  }

  draw(ctx, camera, dpr) {
    dpr = dpr || window.devicePixelRatio || 1;
    const physScale = camera.scale * dpr;
    const W = ctx.canvas.width, H = ctx.canvas.height;

    // (re)build the tiny tile only when the zoom changes meaningfully
    if (!this._tile || Math.abs(physScale - this._tileScale) > this._tileScale * 0.04) {
      this._buildTile(physScale);
    }
    if (!this._pattern) this._pattern = ctx.createPattern(this._tile, 'repeat');

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // gap background
    ctx.fillStyle = 'rgb(15,25,38)';
    ctx.fillRect(0, 0, W, H);

    // tiled hex pattern, panned with the camera and tilted
    ctx.translate(camera.x * dpr, camera.y * dpr);
    ctx.rotate(HEX_TILT);
    ctx.fillStyle = this._pattern;
    // Fill ONLY the on-screen area, mapped back into this panned/rotated space.
    // The old (W+H)*1.5 block was ~40x the screen, painted every frame — fine on
    // desktop, but it tanked mobile GPU fill-rate (and could leave gaps far from
    // the origin). Project the 4 screen corners into this space and fill their bbox.
    const cos = Math.cos(HEX_TILT), sin = Math.sin(HEX_TILT);
    const px = camera.x * dpr, py = camera.y * dpr;
    let fMinX = Infinity, fMinY = Infinity, fMaxX = -Infinity, fMaxY = -Infinity;
    for (let i = 0; i < 4; i++) {
      const sx = (i & 1) ? W : 0, sy = (i & 2) ? H : 0;
      const ddx = sx - px, ddy = sy - py;
      const tx = ddx * cos + ddy * sin, ty = -ddx * sin + ddy * cos;
      if (tx < fMinX) fMinX = tx; if (tx > fMaxX) fMaxX = tx;
      if (ty < fMinY) fMinY = ty; if (ty > fMaxY) fMaxY = ty;
    }
    const fpad = 4;
    ctx.fillRect(fMinX - fpad, fMinY - fpad, (fMaxX - fMinX) + 2 * fpad, (fMaxY - fMinY) + 2 * fpad);

    // diagonal shade — top-right lighter, bottom-left darker
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const ov = ctx.createLinearGradient(W, 0, 0, H);
    ov.addColorStop(0, 'rgba(0,0,0,0.06)');
    ov.addColorStop(1, 'rgba(0,0,0,0.28)');
    ctx.fillStyle = ov;
    ctx.fillRect(0, 0, W, H);

    ctx.restore();
  }
}
