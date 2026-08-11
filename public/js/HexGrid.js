// Hex background painted straight from the tile image at public/hexbg.jpg
// (599x519). It is drawn as a repeating pattern, panned with the camera and
// scaled to the zoom — O(1) per frame, and no tile is ever generated, so zoom
// changes can't hitch the frame the way rebuilding the old canvas tile did.
//
// This REPLACED a procedurally generated tile (gradient faces + shadow + outline
// + blur + grain, rebuilt on every meaningful zoom change). Everything that code
// drew is already baked into the image, including two things that must NOT be
// re-applied here:
//   * the -13.87 degree lattice tilt — rotating the pattern would double-tilt it
//   * the per-face lighting, outline, blur and grain
//
// A 2D autocorrelation of the image gives three lattice vectors 60 degrees apart,
// all 83.43px long. 599x519 is, to within a pixel, a whole number of those vectors
// along both axes (6·v1 + 2·v2 across, -5·v1 + 7·v2 down), which is why the image
// tiles seamlessly with a plain 'repeat' pattern.
const IMG_LATTICE = 83.43;   // hex centre-to-centre spacing, in image pixels

class HexGrid {
  // isMobile is still accepted so callers don't change, but it no longer matters:
  // the mobile-only shortcuts existed to skip the blur/grain passes of the
  // generated tile, and there is no tile generation left to skip.
  constructor(isMobile = false) {
    this._img     = new Image();
    this._img.src = '/hexbg.jpg';
    this._pattern = null;

    // World-space hex spacing, unchanged from the generated version so the
    // background keeps the exact size the camera and spawn logic were tuned
    // against (see the spacing note in Camera.js).
    this.SIZE     = 48 * 0.62;
    this.GAP      = 12 * 0.62;
    this.COL_STEP = Math.sqrt(3) * this.SIZE + this.GAP;   // 58.99 world units

    // The image's 83.43px lattice has to land on that world lattice, so the
    // pattern is painted at this fraction of the camera scale.
    this.IMG_SCALE = this.COL_STEP / IMG_LATTICE;          // 0.70701
  }

  draw(ctx, camera, dpr) {
    dpr = dpr || window.devicePixelRatio || 1;
    const W = ctx.canvas.width, H = ctx.canvas.height;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // Gap colour underneath — this is also what shows for the frame or two before
    // the image has decoded, so the world is never blank white.
    ctx.fillStyle = 'rgb(15,25,38)';
    ctx.fillRect(0, 0, W, H);

    if (this._img.complete && this._img.naturalWidth > 0) {
      if (!this._pattern) this._pattern = ctx.createPattern(this._img, 'repeat');
      if (this._pattern) {
        const k  = camera.scale * dpr * this.IMG_SCALE;
        const px = camera.x * dpr, py = camera.y * dpr;
        ctx.translate(px, py);
        ctx.scale(k, k);
        ctx.fillStyle = this._pattern;
        // Fill ONLY the on-screen area, mapped back into this panned/scaled space.
        // Painting a large fixed block instead was what choked mobile GPU fill-rate
        // before (commit b44cd22) — don't reintroduce it.
        const pad = 4;
        ctx.fillRect(-px / k - pad, -py / k - pad, W / k + 2 * pad, H / k + 2 * pad);
      }
    }

    ctx.restore();
  }
}
