// Hex background painted from the tile image at public/hexbg.jpg (599x519).
//
// Everything that used to be generated here (gradient faces, shadow, outline,
// blur, grain) is baked into the image, including two things that must NOT be
// re-applied:
//   * the -13.87 degree lattice tilt — rotating the pattern would double-tilt it
//   * the per-face lighting and outline
//
// PERFORMANCE — the reason this is not just "createPattern(img) and fill":
// filling the screen with a pattern under a SCALE transform is catastrophically
// slow. Measured at 1920x1080: 0.68ms/frame at dpr1 but 11.6ms/frame at dpr2, i.e.
// the whole frame budget gone on the background alone (this shipped briefly and
// dropped the game to ~10fps). Filling with an already-correctly-sized pattern
// under a pure TRANSLATE instead costs 0.93ms at dpr2 — the same as the old
// generated background. So the image is pre-scaled to the current zoom into a
// cached tile, and the per-frame fill never scales anything.
//
// The tile is rebuilt only when its pixel size actually changes by 2px, which is a
// ~0.1% change in hex size (invisible) and keeps rebuilds to roughly one a second
// while the snake grows. Each rebuild is a single drawImage, ~0.25ms.
//
// SEAMS: drawImage clamps at the edges of its source instead of wrapping, which
// left a visible discontinuity at every tile boundary (measured 4.5x the normal
// column-to-column difference). So the scale reads from a padded copy whose margin
// is the wrapped neighbouring pixels. That copy does not depend on zoom, so it is
// built once — building it per rebuild is what made rebuilds cost 4ms.
const IMG_LATTICE = 83.43;   // hex centre-to-centre spacing, in image pixels
const WRAP_PAD    = 4;       // source px of wrapped margin, so scaling can't clamp

class HexGrid {
  // isMobile is still accepted so callers don't change, but it no longer matters:
  // the mobile-only shortcuts existed to skip the blur/grain passes of the
  // generated tile, and there is no such work left to skip.
  constructor(isMobile = false) {
    this._img     = new Image();
    this._img.src = '/hexbg.jpg';
    this._padded  = null;    // wrapped-margin copy at 1:1, built once
    this._tile    = null;    // image pre-scaled to the current zoom
    this._pattern = null;

    // World-space hex spacing, unchanged from the generated version so the
    // background keeps the exact size the camera and spawn logic were tuned
    // against (see the spacing note in Camera.js).
    this.SIZE     = 48 * 0.62;
    this.GAP      = 12 * 0.62;
    this.COL_STEP = Math.sqrt(3) * this.SIZE + this.GAP;   // 58.99 world units

    // The image's 83.43px lattice has to land on that world lattice, so the tile
    // is built at this fraction of the camera scale.
    this.IMG_SCALE = this.COL_STEP / IMG_LATTICE;          // 0.70701
  }

  // The image with a margin of wrapped neighbouring pixels around it. Identity
  // scale, so this is a straight copy with no resampling. Zoom-independent.
  _buildPadded() {
    const iw = this._img.naturalWidth, ih = this._img.naturalHeight;
    const c = document.createElement('canvas');
    c.width = iw + 2 * WRAP_PAD; c.height = ih + 2 * WRAP_PAD;
    const ctx = c.getContext('2d');
    ctx.translate(WRAP_PAD, WRAP_PAD);
    const p = ctx.createPattern(this._img, 'repeat');
    if (p) { ctx.fillStyle = p; ctx.fillRect(-WRAP_PAD, -WRAP_PAD, c.width, c.height); }
    this._padded = c;
  }

  // Pre-scale to the on-screen size for this zoom. The padding is scaled along
  // with it and lands outside the canvas, so it only feeds the interpolator at
  // the edges and then gets clipped away.
  _buildTile(tw, th) {
    const iw = this._img.naturalWidth, ih = this._img.naturalHeight;
    const kx = tw / iw, ky = th / ih;                      // the scale actually achieved
    const P = this._padded;
    const c = document.createElement('canvas');
    c.width = tw; c.height = th;
    c.getContext('2d').drawImage(P, 0, 0, P.width, P.height,
                                 -WRAP_PAD * kx, -WRAP_PAD * ky, P.width * kx, P.height * ky);
    this._tile    = c;
    this._pattern = null;    // recreated against the target ctx in draw()
  }

  draw(ctx, camera, dpr) {
    dpr = dpr || window.devicePixelRatio || 1;
    const W = ctx.canvas.width, H = ctx.canvas.height;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // Gap colour underneath — this is also what shows for the frame or two before
    // the image has decoded, so the world is never blank.
    ctx.fillStyle = 'rgb(15,25,38)';
    ctx.fillRect(0, 0, W, H);

    if (this._img.complete && this._img.naturalWidth > 0) {
      if (!this._padded) this._buildPadded();

      const k  = camera.scale * dpr * this.IMG_SCALE;
      const tw = Math.max(2, Math.round(this._img.naturalWidth  * k));
      const th = Math.max(2, Math.round(this._img.naturalHeight * k));
      if (!this._tile || Math.abs(this._tile.width - tw) >= 2) this._buildTile(tw, th);

      if (!this._pattern) this._pattern = ctx.createPattern(this._tile, 'repeat');
      if (this._pattern) {
        // Pure translate — NO scale and NO rotate. Adding either here puts the
        // fill back on the slow path this whole file is arranged to avoid.
        const px = camera.x * dpr, py = camera.y * dpr;
        ctx.translate(px, py);
        ctx.fillStyle = this._pattern;
        ctx.fillRect(-px, -py, W, H);
      }
    }

    ctx.restore();
  }
}
