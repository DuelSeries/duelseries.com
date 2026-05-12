class Camera {
  constructor() {
    this.x = 0;      // canvas translation x (pixels)
    this.y = 0;      // canvas translation y (pixels)
    this.scale = 1;
    this.targetX = 0;
    this.targetY = 0;
    this.targetScale = 1;
    this.LERP = 0.5;
  }

  follow(worldX, worldY, canvasW, canvasH) {
    this.targetX = canvasW / 2 - worldX * this.scale;
    this.targetY = canvasH / 2 - worldY * this.scale;
  }

  setScale(worldRadius, canvasW, canvasH, snakeLength) {
    // Start very zoomed in, zoom out as snake grows
    const shortSide = Math.min(canvasW, canvasH);
    const base = shortSide / (worldRadius * 0.22);
    // Boost zoom on mobile so snakes don't appear tiny on small screens
    const mobileBoost = shortSide < 600 ? 2.5 : 1.0;
    const lengthFactor = 1 - Math.min(0.75, (snakeLength || 0) / 600);
    this.targetScale = Math.max(0.15, Math.min(2.5, base * lengthFactor * mobileBoost));
  }

  update(dt) {
    // dt-corrected: same feel at 60fps, 144fps, 240fps
    const posAlpha  = 1 - Math.exp(-(dt || 16.67) / 18);  // 18ms time constant
    const zoomAlpha = 1 - Math.exp(-(dt || 16.67) / 300);
    this.scale += (this.targetScale - this.scale) * zoomAlpha;
    this.x += (this.targetX - this.x) * posAlpha;
    this.y += (this.targetY - this.y) * posAlpha;
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
