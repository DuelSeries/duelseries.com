// WebGL snake-body renderer. Reproduces the per-pixel preview shading on the GPU
// so it stays fast at any size. Renders one snake's body into an offscreen GL
// canvas region; the 2D Renderer composites it with drawImage and draws the
// eyes/name/hat/trails on top. Falls back gracefully if WebGL is unavailable.
// Cross-section brightness profile (centre -> edge) sampled from snake_sprite.png.
// Built-in default so SnakeGL works standalone (e.g. in the lobby).
const SNAKEGL_DEFAULT_LUT = [1,0.999,0.991,0.982,0.97,0.959,0.944,0.923,0.902,0.876,0.86,0.836,0.82,0.798,0.779,0.756,0.737,0.71,0.696,0.661,0.643,0.602,0.561,0.504];

class SnakeGL {
  constructor(crossLut) {
    crossLut = crossLut || SNAKEGL_DEFAULT_LUT;
    this.ok = false;
    this.MAXPTS = 120;
    try {
      this.canvas = document.createElement('canvas');
      this.canvas.width = 64; this.canvas.height = 64;
      const opts = { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false };
      const gl = this.canvas.getContext('webgl', opts) || this.canvas.getContext('experimental-webgl', opts);
      if (!gl) return;
      this.gl = gl;
      // If the browser drops the context (e.g. too many live contexts), fall back
      // to the 2D path instead of silently drawing nothing; re-init if it returns.
      this.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.ok = false; }, false);
      this.canvas.addEventListener('webglcontextrestored', () => {
        try { this._initProgram(); this._initBuffers(); this._initLut(crossLut); this.ok = true; }
        catch (err) { this.ok = false; }
      }, false);
      this._initProgram();
      this._initBuffers();
      this._initLut(crossLut);
      this.ok = true;
      console.log('[SnakeGL] WebGL ready');
    } catch (e) {
      console.warn('[SnakeGL] init failed, falling back:', e);
      this.ok = false;
    }
  }

  _compile(type, src) {
    const gl = this.gl, sh = gl.createShader(type);
    gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error('shader compile: ' + gl.getShaderInfoLog(sh));
    }
    return sh;
  }

  _initProgram() {
    const gl = this.gl, MAXPTS = this.MAXPTS;
    const vs = `
      attribute vec2 aQuad;
      uniform vec2 uBboxMin;
      uniform vec2 uBboxSize;
      varying vec2 vWorld;
      void main() {
        vWorld = uBboxMin + aQuad * uBboxSize;
        gl_Position = vec4(aQuad.x * 2.0 - 1.0, 1.0 - aQuad.y * 2.0, 0.0, 1.0);
      }`;
    const fs = `
      precision highp float;
      #define MAXPTS ${MAXPTS}
      uniform vec2  uPts[MAXPTS];
      uniform float uArc[MAXPTS];
      uniform int   uCount;
      uniform float uR;
      uniform float uTotalArc;
      uniform vec3  uColor;
      uniform float uAaw;
      uniform float uGroove;
      uniform float uWave;
      uniform sampler2D uLut;
      varying vec2 vWorld;
      const float PI = 3.14159265;
      void main() {
        float best = 1e9, bestS = 0.0;
        bool capTail = false;
        for (int i = 0; i < MAXPTS - 1; i++) {
          if (i >= uCount - 1) break;
          vec2 a = uPts[i], b = uPts[i + 1];
          vec2 ab = b - a;
          float L2 = max(dot(ab, ab), 1e-6);
          float u = clamp(dot(vWorld - a, ab) / L2, 0.0, 1.0);
          vec2 c = a + u * ab;
          float d = distance(vWorld, c);
          if (d < best) { best = d; bestS = uArc[i] + u * (uArc[i + 1] - uArc[i]); capTail = (i == 0 && u == 0.0); }
        }
        float R = uR;
        if (best > R + uAaw) { gl_FragColor = vec4(0.0); return; }
        float sBand = bestS, gFr = best / R;
        if (capTail) {
          vec2 t0 = uPts[1] - uPts[0];
          float tl = max(length(t0), 1e-6); t0 /= tl;
          vec2 rel = vWorld - uPts[0];
          sBand = dot(rel, t0);
          gFr = min(1.0, abs(dot(rel, vec2(-t0.y, t0.x))) / R);
        }
        float fr = clamp(best / R, 0.0, 1.0);
        float lum = texture2D(uLut, vec2(fr, 0.5)).r;
        float shade = 1.0 - 0.42 * fr * fr;
        float endFade = clamp((uTotalArc - bestS) / (R * 1.15), 0.0, 1.0);
        float sEff = sBand + R * sqrt(max(0.0, 1.0 - gFr * gFr));
        float gp = fract(sEff / uGroove); if (gp > 0.5) gp -= 1.0;
        float line = 1.0 - (0.06 * endFade) * exp(-(gp / 0.18) * (gp / 0.18));
        float wp = fract((uTotalArc - bestS) / uWave);
        float waveShade = 0.78 + 0.45 * (0.5 + 0.5 * cos(2.0 * PI * wp));
        float scaleShade = 1.0 - (0.05 * endFade) * (0.5 + 0.5 * cos(2.0 * PI * gp));
        float m = lum * shade * line * waveShade * scaleShade;
        vec3 rgb = min(uColor * m, vec3(1.0));
        float aa = clamp((R + 0.5 * uAaw - best) / uAaw, 0.0, 1.0);
        gl_FragColor = vec4(rgb * aa, aa);   // premultiplied alpha
      }`;
    const p = gl.createProgram();
    gl.attachShader(p, this._compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, this._compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
    this.prog = p;
    this.loc = {
      aQuad: gl.getAttribLocation(p, 'aQuad'),
      uBboxMin: gl.getUniformLocation(p, 'uBboxMin'),
      uBboxSize: gl.getUniformLocation(p, 'uBboxSize'),
      uPts: gl.getUniformLocation(p, 'uPts'),
      uArc: gl.getUniformLocation(p, 'uArc'),
      uCount: gl.getUniformLocation(p, 'uCount'),
      uR: gl.getUniformLocation(p, 'uR'),
      uTotalArc: gl.getUniformLocation(p, 'uTotalArc'),
      uColor: gl.getUniformLocation(p, 'uColor'),
      uAaw: gl.getUniformLocation(p, 'uAaw'),
      uGroove: gl.getUniformLocation(p, 'uGroove'),
      uWave: gl.getUniformLocation(p, 'uWave'),
      uLut: gl.getUniformLocation(p, 'uLut'),
    };
  }

  _initBuffers() {
    const gl = this.gl;
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0,0, 1,0, 0,1, 1,1]), gl.STATIC_DRAW);
    this._pts = new Float32Array(this.MAXPTS * 2);
    this._arc = new Float32Array(this.MAXPTS);
  }

  _initLut(lut) {
    const gl = this.gl, n = lut.length;
    const px = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) { const v = Math.round(lut[i] * 255); px[i*4]=v; px[i*4+1]=v; px[i*4+2]=v; px[i*4+3]=255; }
    this.lutTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, n, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  ensureSize(w, h) {
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
  }

  // Render one snake body. segs: flat world coords (head-first, like the game).
  // Returns {minX,minY,bw,bh,offW,offH} for the 2D side to drawImage, or null.
  renderBody(segs, SN, R, base, screenScale) {
    if (!this.ok || SN < 2) return null;
    const gl = this.gl, MAXPTS = this.MAXPTS;

    let minX=1e9,minY=1e9,maxX=-1e9,maxY=-1e9;
    for (let i=0;i<SN;i++){ const x=segs[i*2],y=segs[i*2+1]; if(x<minX)minX=x; if(x>maxX)maxX=x; if(y<minY)minY=y; if(y>maxY)maxY=y; }
    // Transparent border around the tube. Sized in WORLD units but kept to at
    // least a few SCREEN pixels even when zoomed out — otherwise the anti-aliased
    // edge reaches the tile boundary and shows as a faint flickering box.
    const marg = R + 4 + 3 / Math.max(screenScale, 0.0001);
    minX-=marg; minY-=marg; maxX+=marg; maxY+=marg;
    const bw = maxX-minX, bh = maxY-minY;
    let offW = Math.min(this.canvas.width,  Math.max(2, Math.ceil(bw*screenScale)));
    let offH = Math.min(this.canvas.height, Math.max(2, Math.ceil(bh*screenScale)));

    // reversed (tail -> head) + downsampled spine, cumulative arc from tail
    const count = Math.min(MAXPTS, SN);
    const pts = this._pts, arc = this._arc;
    for (let k=0;k<count;k++){
      const src = Math.round((SN-1) * (1 - k/(count-1)));   // tail..head
      pts[k*2] = segs[src*2]; pts[k*2+1] = segs[src*2+1];
    }
    arc[0]=0;
    for (let k=1;k<count;k++){ const dx=pts[k*2]-pts[(k-1)*2], dy=pts[k*2+1]-pts[(k-1)*2+1]; arc[k]=arc[k-1]+Math.sqrt(dx*dx+dy*dy); }
    const totalArc = arc[count-1];
    const groove = R*0.46875;

    gl.useProgram(this.prog);
    gl.viewport(0, 0, offW, offH);
    gl.disable(gl.BLEND);
    gl.clearColor(0,0,0,0);
    gl.enable(gl.SCISSOR_TEST);
    // Clear a 2px gutter beyond the tile so drawImage's edge sampling can't pull
    // in leftover pixels from other snakes sharing this canvas (the faint box).
    gl.scissor(0, 0, Math.min(this.canvas.width, offW + 2), Math.min(this.canvas.height, offH + 2));
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(this.loc.aQuad);
    gl.vertexAttribPointer(this.loc.aQuad, 2, gl.FLOAT, false, 0, 0);

    const L = this.loc;
    gl.uniform2f(L.uBboxMin, minX, minY);
    gl.uniform2f(L.uBboxSize, bw, bh);
    gl.uniform2fv(L.uPts, pts.subarray(0, count*2));
    gl.uniform1fv(L.uArc, arc.subarray(0, count));
    gl.uniform1i(L.uCount, count);
    gl.uniform1f(L.uR, R);
    gl.uniform1f(L.uTotalArc, totalArc);
    gl.uniform3f(L.uColor, base.r/255, base.g/255, base.b/255);
    gl.uniform1f(L.uAaw, Math.max(bw/offW, bh/offH));
    gl.uniform1f(L.uGroove, groove);
    gl.uniform1f(L.uWave, 13*groove);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.uniform1i(L.uLut, 0);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disable(gl.SCISSOR_TEST);

    return { minX, minY, bw, bh, offW, offH };
  }

  // ── Batched in-game path ──────────────────────────────────────────────────
  // All bodies are rendered into this shared GL layer FIRST (one pass, so there's
  // only ONE GL->2D sync), then composited back with small per-snake copies — NOT a
  // full-screen drawImage (that fixed the per-snake stall but a full-screen copy
  // every frame tanked normal-play FPS on high-res displays). Usage per frame:
  // beginFrame() → drawBody() ×N → endFrame() → compositeTo(ctx).
  beginFrame() {
    if (!this.ok) return;
    this._rects = [];
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(this.loc.aQuad);
    gl.vertexAttribPointer(this.loc.aQuad, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.uniform1i(this.loc.uLut, 0);
    // premultiplied-alpha "over" blending so overlapping snakes composite correctly
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  endFrame() {
    if (this.ok) this.gl.disable(this.gl.BLEND);
  }

  // Composite the rendered bodies onto the 2D ctx (which must be at identity /
  // screen-space). Copies only each snake's small box, not the full screen. All GL
  // draws already happened in beginFrame/drawBody, so the first copy triggers one
  // GL flush and the rest read the finished canvas — no per-snake GPU stall.
  compositeTo(ctx) {
    if (!this.ok || !this._rects) return;
    const c = this.canvas;
    for (const r of this._rects) {
      ctx.drawImage(c, r[0], r[1], r[2], r[3], r[0], r[1], r[2], r[3]);
    }
  }

  // Render one snake body into the shared layer at its on-screen position. The
  // shader still works in world coords; we just point the GL viewport at the
  // snake's screen-space bbox. Camera is translate+scale only (no rotation), so
  // world->screen is: screen = (world * scale + cam) * dpr. Returns true if drawn.
  drawBody(segs, SN, R, base, scale, camX, camY, dpr) {
    if (!this.ok || SN < 2) return false;
    const gl = this.gl, MAXPTS = this.MAXPTS;
    scale = scale || 1; dpr = dpr || 1;
    const screenScale = scale * dpr;

    let minX=1e9,minY=1e9,maxX=-1e9,maxY=-1e9;
    for (let i=0;i<SN;i++){ const x=segs[i*2],y=segs[i*2+1]; if(x<minX)minX=x; if(x>maxX)maxX=x; if(y<minY)minY=y; if(y>maxY)maxY=y; }
    const marg = R + 4 + 3 / Math.max(screenScale, 0.0001);
    minX-=marg; minY-=marg; maxX+=marg; maxY+=marg;
    const bw = maxX-minX, bh = maxY-minY;

    // world bbox -> screen (physical px) -> GL viewport (y-up from bottom)
    const sxMin = (minX*scale + camX)*dpr, sxMax = (maxX*scale + camX)*dpr;
    const syMin = (minY*scale + camY)*dpr, syMax = (maxY*scale + camY)*dpr;
    const H = this.canvas.height, W = this.canvas.width;
    if (sxMax < 0 || syMax < 0 || sxMin > W || syMin > H) return true; // off-screen
    const vpX = Math.round(sxMin);
    const vpY = Math.round(H - syMax);
    const vpW = Math.max(1, Math.round(sxMax - sxMin));
    const vpH = Math.max(1, Math.round(syMax - syMin));

    // Record this snake's on-screen rect (image space, y-down) so compositeTo()
    // copies just this box back — not the whole screen.
    const ix = Math.max(0, vpX), iy = Math.max(0, H - (vpY + vpH));
    const ir = Math.min(W, vpX + vpW), ib = Math.min(H, H - vpY);
    if (ir > ix && ib > iy) this._rects.push([ix, iy, ir - ix, ib - iy]);

    // reversed (tail->head) downsampled spine, cumulative arc from tail (world coords)
    const count = Math.min(MAXPTS, SN);
    const pts = this._pts, arc = this._arc;
    for (let k=0;k<count;k++){
      const src = Math.round((SN-1) * (1 - k/(count-1)));
      pts[k*2] = segs[src*2]; pts[k*2+1] = segs[src*2+1];
    }
    arc[0]=0;
    for (let k=1;k<count;k++){ const dx=pts[k*2]-pts[(k-1)*2], dy=pts[k*2+1]-pts[(k-1)*2+1]; arc[k]=arc[k-1]+Math.sqrt(dx*dx+dy*dy); }
    const totalArc = arc[count-1];
    const groove = R*0.46875;

    gl.viewport(vpX, vpY, vpW, vpH);
    const L = this.loc;
    gl.uniform2f(L.uBboxMin, minX, minY);
    gl.uniform2f(L.uBboxSize, bw, bh);
    gl.uniform2fv(L.uPts, pts.subarray(0, count*2));
    gl.uniform1fv(L.uArc, arc.subarray(0, count));
    gl.uniform1i(L.uCount, count);
    gl.uniform1f(L.uR, R);
    gl.uniform1f(L.uTotalArc, totalArc);
    gl.uniform3f(L.uColor, base.r/255, base.g/255, base.b/255);
    gl.uniform1f(L.uAaw, Math.max(bw/vpW, bh/vpH));
    gl.uniform1f(L.uGroove, groove);
    gl.uniform1f(L.uWave, 13*groove);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return true;
  }

  // Free GL objects and force-release the context so the next game (the lobby
  // reuses one iframe) can always acquire a fresh one instead of waiting for GC.
  dispose() {
    const gl = this.gl;
    if (!gl) return;
    try {
      if (this.prog)   gl.deleteProgram(this.prog);
      if (this.quad)   gl.deleteBuffer(this.quad);
      if (this.lutTex) gl.deleteTexture(this.lutTex);
      const ext = gl.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
    } catch (e) {}
    this.ok = false;
    this.gl = null;
  }
}
