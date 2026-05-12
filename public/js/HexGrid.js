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
    const preW = Math.round(window.innerWidth  * (window.devicePixelRatio || 1));
    const preH = Math.round(window.innerHeight * (window.devicePixelRatio || 1));
    this._pending = true;
    const preHexScale = Math.min(window.innerWidth, window.innerHeight) < 600 ? 2.5 : 1.0;
    this._worker.postMessage({ worldCX: 0, worldCY: 0, scale: 1, screenW: preW, screenH: preH, hexScale: preHexScale });
  }

  draw(ctx, camera) {
    const { x: camX, y: camY, scale } = camera;
    const W = ctx.canvas.width, H = ctx.canvas.height;
    const worldCX = (W / 2 - camX) / scale;
    const worldCY = (H / 2 - camY) / scale;

    // Trigger rebuild at 15% of bitmap half-span — gives the worker ~1s lead time
    // even at full boost speed, well before the 50% edge is reached.
    const threshX = 0.15 * W / scale;
    const threshY = 0.15 * H / scale;
    const needsRebuild =
      this._bitmapWorldX === null ||
      Math.abs(worldCX - this._bitmapWorldX) > threshX ||
      Math.abs(worldCY - this._bitmapWorldY) > threshY ||
      Math.abs(scale   - this._bitmapScale)  > 0.08;

    if (needsRebuild && !this._pending) {
      this._pending = true;
      const hexScale = Math.min(W, H) < 600 ? 2.5 : 1.0;
      this._worker.postMessage({ worldCX, worldCY, scale, screenW: W, screenH: H, hexScale });
    }

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#070707';
    ctx.fillRect(0, 0, W, H);

    if (this._bitmap) {
      // Use current scale (not _bitmapScale) for dx so the bitmap stays correctly
      // positioned when the camera has zoomed since the last build.
      const dx = (worldCX - this._bitmapWorldX) * scale;
      const dy = (worldCY - this._bitmapWorldY) * scale;
      ctx.drawImage(this._bitmap, -this._bitmapW / 2 + W / 2 - dx, -this._bitmapH / 2 + H / 2 - dy);
    }

    ctx.restore();
  }
}
