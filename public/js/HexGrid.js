class HexGrid {
  constructor() {
    this._bitmap       = null;
    this._bitmapWorldX = null;
    this._bitmapWorldY = null;
    this._bitmapScale  = null;
    this._bitmapW      = 0;
    this._bitmapH      = 0;
    this._pending      = false;

    this._worker = new Worker('/js/hexgrid-worker.js');
    this._worker.onmessage = ({ data: { bitmap, worldCX, worldCY, scale } }) => {
      if (this._bitmap) this._bitmap.close();
      this._bitmap       = bitmap;
      this._bitmapWorldX = worldCX;
      this._bitmapWorldY = worldCY;
      this._bitmapScale  = scale;
      this._bitmapW      = bitmap.width;
      this._bitmapH      = bitmap.height;
      this._pending      = false;
    };

    // Pre-warm: kick off the first build immediately so the bitmap is ready by the time
    // the player spawns rather than showing a blank background on the first frame.
    const dpr  = window.devicePixelRatio || 1;
    const preW = Math.round(window.innerWidth  * dpr);
    const preH = Math.round(window.innerHeight * dpr);
    // physScale = logical scale * dpr; pre-warm uses scale=1 so physScale = dpr
    this._pending = true;
    this._worker.postMessage({ worldCX: 0, worldCY: 0, scale: dpr, screenW: preW, screenH: preH, hexScale: 1.0 });
  }

  draw(ctx, camera) {
    const { x: camX, y: camY, scale } = camera;
    const W   = ctx.canvas.width, H = ctx.canvas.height;  // physical pixels
    const dpr = window.devicePixelRatio || 1;
    // physScale: physical pixels per world unit (matches camera.apply's scale*dpr)
    const physScale = scale * dpr;

    // World position at the centre of the physical screen
    const worldCX = (W / 2 - camX * dpr) / physScale;
    const worldCY = (H / 2 - camY * dpr) / physScale;

    // Trigger rebuild at 15% of bitmap half-span
    const threshX = 0.15 * W / physScale;
    const threshY = 0.15 * H / physScale;
    const needsRebuild =
      this._bitmapWorldX === null ||
      Math.abs(worldCX - this._bitmapWorldX) > threshX ||
      Math.abs(worldCY - this._bitmapWorldY) > threshY ||
      Math.abs(physScale - this._bitmapScale) > 0.08 * dpr;

    if (needsRebuild && !this._pending) {
      this._pending = true;
      this._worker.postMessage({ worldCX, worldCY, scale: physScale, screenW: W, screenH: H, hexScale: 1.0 });
    }

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#070707';
    ctx.fillRect(0, 0, W, H);

    if (this._bitmap) {
      const dx = (worldCX - this._bitmapWorldX) * physScale;
      const dy = (worldCY - this._bitmapWorldY) * physScale;
      ctx.drawImage(this._bitmap, -this._bitmapW / 2 + W / 2 - dx, -this._bitmapH / 2 + H / 2 - dy);
    }

    ctx.restore();
  }
}
