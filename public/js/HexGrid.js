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
  }

  draw(ctx, camera) {
    const { x: camX, y: camY, scale } = camera;
    const W = ctx.canvas.width, H = ctx.canvas.height;
    const worldCX = (W / 2 - camX) / scale;
    const worldCY = (H / 2 - camY) / scale;

    // Threshold: 35% of the visible half-span — safely within the 2× bitmap margin
    const threshX = 0.35 * W / scale;
    const threshY = 0.35 * H / scale;
    const needsRebuild =
      this._bitmapWorldX === null ||
      Math.abs(worldCX - this._bitmapWorldX) > threshX ||
      Math.abs(worldCY - this._bitmapWorldY) > threshY ||
      Math.abs(scale   - this._bitmapScale)  > 0.15;

    // Kick off an async rebuild — main thread never blocks
    if (needsRebuild && !this._pending) {
      this._pending = true;
      this._worker.postMessage({ worldCX, worldCY, scale, screenW: W, screenH: H });
    }

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#070707';
    ctx.fillRect(0, 0, W, H);

    if (this._bitmap) {
      const sc = this._bitmapScale;
      const dx = (worldCX - this._bitmapWorldX) * sc;
      const dy = (worldCY - this._bitmapWorldY) * sc;
      ctx.drawImage(this._bitmap, -this._bitmapW / 2 + W / 2 - dx, -this._bitmapH / 2 + H / 2 - dy);
    }

    ctx.restore();
  }
}
