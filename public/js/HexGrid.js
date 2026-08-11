// Hex background drawn as a repeating PATTERN: one small seamless tile is
// rendered once (rebuilt only when the zoom changes), then painted across the
// whole screen each frame as a tiled, tilted, panned pattern fill. This is
// O(1) per frame regardless of movement/zoom, so it never falls behind.
// Tilt measured off slither.io's own background tile (bg54.jpg, 599x519). A 2D
// autocorrelation of that image gives three lattice vectors, all 83.43px long,
// at -13.87, +45.97 and -73.96 degrees — 60 degrees apart, i.e. a hexagonal
// lattice rotated by -13.87 degrees. Colours below are sampled from the same
// image rather than eyeballed.
const HEX_TILT = -13.87 * Math.PI / 180;   // -0.2421 rad

class HexGrid {
  constructor(isMobile = false) {
    this._isMobile   = isMobile;
    this._tile       = null;
    this._tileScale  = 0;
    this._pattern    = null;

    this.SIZE     = 48 * 0.62;
    // Gap tightened from 14.6 to 12 to match slither's face-to-gap proportion,
    // set by rendering this tile beside their bg54.jpg at a matched lattice
    // spacing (83.43px) and comparing directly.
    this.GAP      = 12 * 0.62;
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
    // Colours sampled from slither's bg54.jpg: the gap between faces is its most
    // common colour (#0e1720), the brightest face pixel is #1e3142, and the
    // darkest pixel (the deep shadow under a face) is #01050e.
    // Gap samples at rgb(14,23,32) in their image, but the grain pass below lifts
    // dark areas by about 4, so the fill is set 4 lower and lands on target.
    ctx.fillStyle = 'rgb(10,19,28)';         // gap / background
    ctx.fillRect(0, 0, big.width, big.height);
    ctx.lineJoin = 'round';
    ctx.lineCap  = 'round';
    // Face gradient read straight off a full hex cycle in the folded average:
    // top of face rgb(25,39,55), bottom of face rgb(17,27,37) before it meets
    // the gap. The earlier top stop of rgb(30,49,66) was the single brightest
    // JPEG pixel, not the true face colour, which is why ours read too contrasty.
    // Stops corrected against a direct profile-vs-profile comparison with their
    // image: the rendered face came out ~5 short on blue near the top and ~3
    // heavy on red lower down, so the stops carry that correction rather than
    // the raw sampled values (the blur and shadow shift the final pixels).
    const grad = ctx.createLinearGradient(0, -r, 0, r);
    grad.addColorStop(0, 'rgb(24,40,60)');   // face top
    grad.addColorStop(1, 'rgb(14,26,36)');   // face bottom

    const hex = (ox, oy) => { ctx.beginPath(); for (let i = 0; i < 6; i++) { const a = (Math.PI/3)*i + Math.PI/6; ctx.lineTo(ox + r*Math.cos(a), oy + r*Math.sin(a)); } ctx.closePath(); };

    for (let row = -2; row <= 3; row++) {
      const off = (((row % 2) + 2) % 2 === 1) ? COL_STEP / 2 : 0;
      for (let col = -2; col <= 3; col++) {
        const cx = (col * COL_STEP + off) * physScale + pad;
        const cy = (row * ROW_STEP) * physScale + pad;
        ctx.setTransform(1, 0, 0, 1, cx, cy);
        // Shadow opacity solved from the fold: the gap sits at rgb(14,23,32) and
        // its darkest point under a face is rgb(9,14,20). 9/14, 14/23 and 20/32
        // all give the same answer, so black at ~0.375 alpha.
        hex(-r * 0.10, r * 0.12);  ctx.fillStyle = 'rgba(0,0,0,0.375)'; ctx.fill(); // soft shadow
        hex(0, 0);                 ctx.fillStyle = grad;               ctx.fill();  // navy face
        // Outline is the dark band immediately bordering a face in the fold,
        // rgb(11,17,24). rgb(1,5,14) was the single darkest pixel in the whole
        // image, which is the shadow floor, not the edge.
        hex(0, 0);                 ctx.strokeStyle = 'rgb(11,17,24)'; ctx.lineWidth = lw; ctx.stroke();
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // Soft blur the padded content. SKIPPED on mobile: the blur and the grain
    // getImageData pass below are synchronous CPU stalls, and this tile rebuilds
    // every time the zoom changes (i.e. as the snake grows) — on a phone each
    // rebuild hitched the frame long enough to back up a marginal connection and
    // "fuck up" the game. Both are barely visible on a small screen anyway.
    let source = big;
    if (!this._isMobile) {
      const blurred = document.createElement('canvas');
      blurred.width = big.width; blurred.height = big.height;
      const bctx = blurred.getContext('2d');
      bctx.filter = `blur(${blurR}px)`;
      bctx.drawImage(big, 0, 0);
      bctx.filter = 'none';
      source = blurred;
    }

    // crop the centre period -> seamless tile
    const c = document.createElement('canvas');
    c.width = tileW; c.height = tileH;
    const cctx = c.getContext('2d');
    cctx.drawImage(source, pad, pad, tileW, tileH, 0, 0, tileW, tileH);
    if (!this._isMobile) {
      // Subtle fuzzy grain. This used to be a getImageData + per-pixel JS loop +
      // putImageData on EVERY rebuild, and since the tile rebuilds whenever the
      // zoom drifts (i.e. constantly, as the snake grows) that synchronous
      // readback stalled the frame hard — a steady framerate with periodic
      // half-second hitches. The grain is just fixed noise, so it is now built
      // ONCE into a small tile and composited, which is a plain GPU blit.
      // Plain alpha compositing. 'overlay' was tried to keep the mean neutral but
      // measured worse: it left the gap perfect while darkening the faces ~20%
      // (profile comparison went from 3.11 to 5.44 average error). The slight
      // lift this grain gives dark areas is compensated in the fill colour above.
      const g = this._grainTile();
      cctx.save();
      cctx.globalAlpha = 0.5;
      const gp = cctx.createPattern(g, 'repeat');
      if (gp) { cctx.fillStyle = gp; cctx.fillRect(0, 0, tileW, tileH); }
      cctx.restore();
    }

    this._tile      = c;
    this._tileScale = physScale;
    this._pattern   = null;   // recreated against the target ctx in draw()
  }

  // Fixed grain noise, generated once and reused for every tile rebuild. Seeded
  // so it never shimmers between rebuilds.
  _grainTile() {
    if (this._grain) return this._grain;
    const N = 128;
    const c = document.createElement('canvas');
    c.width = c.height = N;
    const g = c.getContext('2d');
    const img = g.createImageData(N, N), d = img.data;
    let s = 0x9e3779b9 >>> 0;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    for (let k = 0; k < d.length; k += 4) {
      const n = (rnd() - 0.5) * 8;          // signed noise, applied as translucent grey
      const v = Math.max(0, Math.min(255, 128 + n));
      d[k] = d[k+1] = d[k+2] = v;
      d[k+3] = 26;                           // faint
    }
    g.putImageData(img, 0, 0);
    this._grain = c;
    return c;
  }

  draw(ctx, camera, dpr) {
    dpr = dpr || window.devicePixelRatio || 1;
    const physScale = camera.scale * dpr;
    const W = ctx.canvas.width, H = ctx.canvas.height;

    // (re)build the tiny tile only when the zoom changes meaningfully
    // Rebuild only on a MEANINGFUL zoom change. draw() already corrects for drift
    // by scaling the pattern space by k = physScale / _tileScale, so a wide band
    // costs nothing visually but turns a constant stream of rebuilds (each one a
    // frame hitch, since the camera zooms continuously as the snake grows) into a
    // rare event.
    if (!this._tile || Math.abs(physScale - this._tileScale) > this._tileScale * 0.20) {
      this._buildTile(physScale);
    }
    if (!this._pattern) this._pattern = ctx.createPattern(this._tile, 'repeat');

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // gap background
    ctx.fillStyle = 'rgb(15,25,38)';
    ctx.fillRect(0, 0, W, H);

    // tiled hex pattern, panned with the camera and tilted. The tile was built at
    // _tileScale but the camera may have zoomed a little since (it only rebuilds past a
    // 4% drift) — scale the pattern space by the ratio so hex size tracks the zoom
    // CONTINUOUSLY. Without this the whole background snapped up to 4% on every rebuild,
    // a visible jerk while growing; now rebuilds only swap in a crisper tile at the size
    // already on screen.
    const k = physScale / this._tileScale;
    ctx.translate(camera.x * dpr, camera.y * dpr);
    ctx.rotate(HEX_TILT);
    ctx.scale(k, k);
    ctx.fillStyle = this._pattern;
    // Fill ONLY the on-screen area, mapped back into this panned/rotated/scaled space.
    // The old (W+H)*1.5 block was ~40x the screen, painted every frame — fine on
    // desktop, but it tanked mobile GPU fill-rate (and could leave gaps far from
    // the origin). Project the 4 screen corners into this space and fill their bbox.
    const cos = Math.cos(HEX_TILT), sin = Math.sin(HEX_TILT);
    const px = camera.x * dpr, py = camera.y * dpr;
    let fMinX = Infinity, fMinY = Infinity, fMaxX = -Infinity, fMaxY = -Infinity;
    for (let i = 0; i < 4; i++) {
      const sx = (i & 1) ? W : 0, sy = (i & 2) ? H : 0;
      const ddx = sx - px, ddy = sy - py;
      const tx = (ddx * cos + ddy * sin) / k, ty = (-ddx * sin + ddy * cos) / k;
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
