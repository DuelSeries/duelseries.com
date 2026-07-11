class Camera {
  constructor() {
    this.x = 0;      // canvas translation x (pixels) — derived from worldX/scale each update
    this.y = 0;      // canvas translation y (pixels)
    this.scale = 1;
    this.targetScale = 1;
    // World-space follow point (the snake head). Smoothing happens in WORLD space and the
    // pixel translation is derived from the CURRENT scale afterwards — previously targetX/Y
    // were precomputed with a stale scale, so the view swam off the head while zoom animated.
    this.worldX = 0;
    this.worldY = 0;
    this.targetWorldX = 0;
    this.targetWorldY = 0;
    this._w = null;  // last known canvas size (set by follow)
    this._h = null;
    this.snapNextUpdate = false; // set on spawn/respawn to jump straight to the target (no zoom-in animation)
  }

  follow(worldX, worldY, canvasW, canvasH) {
    this.targetWorldX = worldX;
    this.targetWorldY = worldY;
    this._w = canvasW;
    this._h = canvasH;
  }

  setScale(worldRadius, canvasW, canvasH, snakeLength) {
    // slither.io's exact zoom-out curve: dgsc = .64285 + .514285714 / max(1, (sct+16)/36),
    // where sct is its body-part count. Our spawn (20 segments) = slither's sct 2, so
    // sct = length - 18. Normalized to 1.0 at spawn, the view then widens with size on
    // slither's exact curve (total ~1.69x zoom-out by the 411-part cap → ~27 tiles).
    const sct   = Math.max(2, (snakeLength || 20) - 18);
    const dgsc  = 0.64285 + 0.514285714 / Math.max(1, (sct + 16) / 36);
    const DGSC_SPAWN = 1.157136; // dgsc at sct=2 — normalization anchor
    // Spawn framing (owner spec): ~16 background hex tiles visible across the screen at
    // spawn. HexGrid column spacing = √3*(48*.62) + 14.6*.62 ≈ 60.6 world units, so the
    // scale is derived directly from the tile count — resolution-independent. Phones show
    // fewer tiles (more zoomed in), like the slither app.
    const HEX_COL_STEP = Math.sqrt(3) * (48 * 0.62) + 14.6 * 0.62;
    const TILES_ACROSS = canvasW < 900 ? 9 : 16;
    const spawnScale   = canvasW / (TILES_ACROSS * HEX_COL_STEP);
    this.targetScale = Math.max(0.15, Math.min(4, spawnScale * (dgsc / DGSC_SPAWN)));
  }

  update(dt) {
    // On spawn/respawn, jump straight to the target so the view doesn't start
    // zoomed-out and animate in for the first ~0.5s.
    if (this.snapNextUpdate) {
      this.scale = this.targetScale;
      this._scaleMid = this.targetScale;
      this.worldX = this.targetWorldX;
      this.worldY = this.targetWorldY;
      this.snapNextUpdate = false;
    } else {
      // dt-corrected: same feel at 60fps, 144fps, 240fps
      const posAlpha  = 1 - Math.exp(-(dt || 16.67) / 18);  // 18ms time constant
      const zoomAlpha = 1 - Math.exp(-(dt || 16.67) / 250);
      // Zoom is smoothed through TWO cascaded stages: a single exponential starts with a
      // velocity jump the instant the target steps (eating a food burst = visible lurch);
      // cascading ramps the zoom speed up and back down — no jerk, ~500ms overall settle.
      if (this._scaleMid === undefined) this._scaleMid = this.scale;
      this._scaleMid += (this.targetScale - this._scaleMid) * zoomAlpha;
      this.scale     += (this._scaleMid  - this.scale)      * zoomAlpha;
      this.worldX += (this.targetWorldX - this.worldX) * posAlpha;
      this.worldY += (this.targetWorldY - this.worldY) * posAlpha;
    }
    // Derive the pixel translation from the CURRENT scale — zoom and follow can no
    // longer disagree, which removes the subtle swimming while the snake grows.
    if (this._w !== null) {
      this.x = this._w / 2 - this.worldX * this.scale;
      this.y = this._h / 2 - this.worldY * this.scale;
    }
  }

  apply(ctx, dpr) {
    dpr = dpr || 1;
    ctx.setTransform(this.scale * dpr, 0, 0, this.scale * dpr, this.x * dpr, this.y * dpr);
  }

  reset(ctx, dpr) {
    dpr = dpr || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // Convert screen coords to world coords
  screenToWorld(sx, sy, canvasW, canvasH) {
    return {
      x: (sx - this.x) / this.scale,
      y: (sy - this.y) / this.scale,
    };
  }
}
