class Camera {
  constructor() {
    this.x = 0;      // canvas translation x (pixels)
    this.y = 0;      // canvas translation y (pixels)
    this.scale = 1;
    this.targetX = 0;
    this.targetY = 0;
    this.targetScale = 1;
    this.LERP = 0.5;
    this.snapNextUpdate = false; // set on spawn/respawn to jump straight to the target (no zoom-in animation)
  }

  follow(worldX, worldY, canvasW, canvasH) {
    this.targetX = canvasW / 2 - worldX * this.scale;
    this.targetY = canvasH / 2 - worldY * this.scale;
  }

  setScale(worldRadius, canvasW, canvasH, snakeLength) {
    // FOV depends ONLY on the player's own snake size — never on the arena size.
    // The world radius breathes (1200..6000) as players/bots join and die; using it
    // here made the camera zoom out whenever the arena grew (e.g. spawning bots).
    // Use a fixed reference radius instead so the view only widens as the snake grows.
    const REF_RADIUS = 2000; // = CONSTANTS.BASE_WORLD_RADIUS — keeps the spawn feel identical
    const base = Math.min(canvasW, canvasH) / (REF_RADIUS * 0.22);
    // Zoom out smoothly as the snake grows: a 1/x decay from full zoom (factor 1.0) toward a
    // 0.38 floor, so the view widens quickly early then eases off. K sets how fast it zooms out.
    const K = 60;
    const lengthFactor = 0.38 + 0.62 * (K / ((snakeLength || 0) + K));
    this.targetScale = Math.max(0.15, Math.min(2.5, base * lengthFactor));
  }

  update(dt) {
    // On spawn/respawn, jump straight to the target so the view doesn't start
    // zoomed-out and animate in for the first ~0.5s.
    if (this.snapNextUpdate) {
      this.scale = this.targetScale;
      this.x = this.targetX;
      this.y = this.targetY;
      this.snapNextUpdate = false;
      return;
    }
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
