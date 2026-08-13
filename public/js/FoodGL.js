// WebGL food renderer.
//
// Draws food exactly the way Renderer._drawFood does — slither.io's three
// passes: a normal-blended dark outline underneath, then an additive bright
// core, then two wide additive glow layers, each drawn twice (steady + pulse) —
// but as batched textured quads instead of Canvas 2D drawImage calls.
//
// WHY: measured on this project, a Canvas 2D drawImage costs ~1.6us per call
// regardless of sprite size (5600 blits cost ~9ms whether the sprite is 32px or
// 160px, so it is call overhead, not fill rate). slither's own food is 7 draws
// per pellet, which is fine at their ~300 on-screen pellets (~2100 calls,
// ~3.4ms) but not at ours. Batching collapses every pellet into 3 GPU draw
// calls, so pellet count stops costing CPU time and the full glow can stay on
// at any density.
//
// The sprite shapes are slither's formulas, the same ones Renderer.js uses:
//   core    sz = ceil(2*(j*0.65)),  radial 1 -> 0.2 at 99% -> 0
//   glow    sz = ceil(j*8+6),       radial 1 at r=1 -> 0 at r=j*4
//   outline black disc bsz = ceil(2*(j*0.7))+2 on a bsz+20 canvas,
//           shadowBlur 6, shadowOffsetY 1 + 2*j/18.8
// over j = 2.8 .. 18.8 (17 steps).
//
// Each sprite is painted into the atlas at its EXACT native pixel size, by the
// same code the 2D path uses. That matters: painting them normalised to a
// common cell size instead was measured to leave a visible ring of error around
// every pellet, because the GPU was then sampling a different texel grid than
// Canvas 2D was. Native size means both sample the identical texels, and the
// quad's half-size is the identical `sp` the 2D path computes.
//
// Colour is not baked in: cells are painted white and the shader multiplies the
// pellet colour through, which is what lets every colour share one atlas.
const FOODGL_GUTTER = 2;    // transparent gutter so bilinear can't bleed
const FOODGL_COLS   = 5;    // atlas grid: 5 x 4 holds the 17 steps

class FoodGL {
  constructor(foodJs) {
    this.ok = false;
    this.JS = foodJs;                       // Renderer.FOOD_JS — j = 2.8 .. 18.8
    this.N  = foodJs.length;
    // Vertex buffers grow on demand rather than being capped: a fixed cap would
    // silently drop pellets once the field got dense enough (a zoomed-out view
    // at FOOD_SPAWN_COUNT 3600 already puts ~2700 on screen), and sizing them
    // for the worst case up front would reserve ~16MB that is almost never
    // used. They only ever grow, so there is no per-frame allocation.
    this.HARD_CAP = 60000;                  // quads per layer, a sanity ceiling
    try {
      this.canvas = document.createElement('canvas');
      this.canvas.width = 64; this.canvas.height = 64;
      // antialias stays OFF. Turning MSAA on to soften the quad edges was tried
      // and measured WORSE against the 2D reference (pixels off by >8 went from
      // 16 to 3491), because the shader still samples the texture at the pixel
      // centre while coverage is averaged separately. Hard edges match Canvas
      // more closely here.
      const opts = { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false };
      const gl = this.canvas.getContext('webgl', opts) || this.canvas.getContext('experimental-webgl', opts);
      if (!gl) return;
      this.gl = gl;
      this._initSizes();
      this._initProgram();
      this._initBuffers();
      this._initTextures();
      this.ok = true;
      console.log('[FoodGL] WebGL food ready');
    } catch (e) {
      console.warn('[FoodGL] init failed, falling back to 2D:', e);
      this.ok = false;
    }
  }

  // Native sprite pixel sizes per step. The 2D path derives every `sp` from
  // these, so they have to match it exactly for the geometry to line up.
  _initSizes() {
    const N = this.N;
    this.coreW = new Float32Array(N);
    this.glowW = new Float32Array(N);
    this.lineW = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const j = this.JS[i];
      this.coreW[i] = Math.ceil(2 * (j * 0.65));
      this.glowW[i] = Math.ceil(j * 8 + 6);
      this.lineW[i] = Math.ceil(2 * (j * 0.7)) + 2 + 20;
    }
  }

  _compile(type, src) {
    const gl = this.gl, sh = gl.createShader(type);
    gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(sh));
    return sh;
  }

  // One program serves every pass: the sprite supplies coverage in .a, the
  // vertex colour supplies the tint (black for outlines) and the layer alpha.
  // Output is premultiplied, which suits both "over" and additive blending.
  _initProgram() {
    const gl = this.gl;
    const vs = `
      attribute vec2 aPos;
      attribute vec2 aUV;
      attribute vec4 aColor;
      uniform vec2 uRes;
      varying vec2 vUV;
      varying vec4 vColor;
      void main() {
        vUV = aUV; vColor = aColor;
        gl_Position = vec4(aPos.x / uRes.x * 2.0 - 1.0, 1.0 - aPos.y / uRes.y * 2.0, 0.0, 1.0);
      }`;
    const fs = `
      precision mediump float;
      uniform sampler2D uTex;
      varying vec2 vUV;
      varying vec4 vColor;
      void main() {
        float a = texture2D(uTex, vUV).a * vColor.a;
        gl_FragColor = vec4(vColor.rgb * a, a);
      }`;
    const p = gl.createProgram();
    gl.attachShader(p, this._compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, this._compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
    this.p = {
      prog: p,
      aPos:   gl.getAttribLocation(p, 'aPos'),
      aUV:    gl.getAttribLocation(p, 'aUV'),
      aColor: gl.getAttribLocation(p, 'aColor'),
      uRes:   gl.getUniformLocation(p, 'uRes'),
      uTex:   gl.getUniformLocation(p, 'uTex'),
    };
  }

  _initBuffers() {
    const gl = this.gl;
    this.STRIDE = 8;                                   // x,y,u,v,r,g,b,a
    const seed = 2048 * 6 * this.STRIDE;
    this._vLine = new Float32Array(seed);
    this._vCore = new Float32Array(seed * 2);
    this._vGlow = new Float32Array(seed * 4);
    this._nLine = 0; this._nCore = 0; this._nGlow = 0;  // vertex counts
    this.bufLine = gl.createBuffer();
    this.bufCore = gl.createBuffer();
    this.bufGlow = gl.createBuffer();
  }

  // Make room for `quads` more quads in one of the vertex arrays, doubling it if
  // needed. Returns the array (possibly a new, larger one) or null at the cap.
  _room(name, quads) {
    const arr = this[name];
    const need = this['_n' + name.slice(2)] * this.STRIDE + quads * 6 * this.STRIDE;
    if (need <= arr.length) return arr;
    if (need > this.HARD_CAP * 6 * this.STRIDE) return null;
    let len = arr.length;
    while (len < need) len *= 2;
    const next = new Float32Array(len);
    next.set(arr);
    this[name] = next;
    return next;
  }

  // Build a grid atlas. `paint(g, sz, i)` draws step i at its native size sz,
  // with the origin already translated to the cell. Cells sit on a grid pitched
  // to the largest sprite plus a gutter, and UVs bound the sprite's exact
  // native rect.
  //
  // Each cell then gets its outermost row/column EXTRUDED one pixel into the
  // gutter. That is not cosmetic: Canvas 2D clamps to the edge texel when it
  // samples past a sprite's border, while GL bilinear blends toward whatever is
  // outside the UV rect. Without the extrusion the GPU was mixing in the
  // transparent gutter and every pellet came out with a ring of error up to
  // ~48/255 around its rim. Extruding makes the border behave like
  // CLAMP_TO_EDGE, which is what the 2D path does.
  _atlas(nativeW, paint) {
    const N = this.N, G = FOODGL_GUTTER, OFF = 1;      // OFF leaves room to extrude
    let max = 0;
    for (let i = 0; i < N; i++) if (nativeW[i] > max) max = nativeW[i];
    const cols = FOODGL_COLS, rows = Math.ceil(N / cols), pitch = max + G;
    const c = document.createElement('canvas');
    c.width  = cols * pitch + 2 * OFF;
    c.height = rows * pitch + 2 * OFF;
    const g = c.getContext('2d');
    const uv = new Float32Array(N * 4);                // u0,v0,u1,v1 per step
    for (let i = 0; i < N; i++) {
      const sz = nativeW[i];
      const cx = OFF + (i % cols) * pitch, cy = OFF + Math.floor(i / cols) * pitch;
      g.save();
      g.translate(cx, cy);
      g.beginPath(); g.rect(0, 0, sz, sz); g.clip();
      paint(g, sz, i);
      g.restore();
      // extrude: sides first, then full-width top/bottom so the corners fill in
      g.drawImage(c, cx,          cy, 1, sz,        cx - 1,  cy,      1,      sz);
      g.drawImage(c, cx + sz - 1, cy, 1, sz,        cx + sz, cy,      1,      sz);
      g.drawImage(c, cx - 1, cy,          sz + 2, 1, cx - 1, cy - 1,  sz + 2, 1);
      g.drawImage(c, cx - 1, cy + sz - 1, sz + 2, 1, cx - 1, cy + sz, sz + 2, 1);
      uv[i * 4]     = cx / c.width;
      uv[i * 4 + 1] = cy / c.height;
      uv[i * 4 + 2] = (cx + sz) / c.width;
      uv[i * 4 + 3] = (cy + sz) / c.height;
    }
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return { tex: t, uv };
  }

  // These three are Renderer._foodCore / _foodGlow / _foodOutline with the
  // colour fixed to white (the shader supplies the tint) and the destination a
  // sub-rect of the atlas instead of its own canvas. Keep them in step.
  _initTextures() {
    this.texCore = this._atlas(this.coreW, (g, sz) => {
      const grd = g.createRadialGradient(sz / 2, sz / 2, 0, sz / 2, sz / 2, sz / 2);
      grd.addColorStop(0,    'rgba(255,255,255,1)');
      grd.addColorStop(0.99, 'rgba(255,255,255,0.2)');
      grd.addColorStop(1,    'rgba(255,255,255,0)');
      g.fillStyle = grd; g.fillRect(0, 0, sz, sz);
    });

    this.texGlow = this._atlas(this.glowW, (g, sz, i) => {
      const j = this.JS[i];
      const grd = g.createRadialGradient(sz / 2, sz / 2, 1, sz / 2, sz / 2, j * 4);
      grd.addColorStop(0, 'rgba(255,255,255,1)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd; g.fillRect(0, 0, sz, sz);
    });

    // Only .a is sampled and the shader tints it black, so the fill colour here
    // is incidental — but it is left black to match the 2D sprite exactly.
    this.texLine = this._atlas(this.lineW, (g, sz, i) => {
      const j = this.JS[i], bsz = Math.ceil(2 * (j * 0.7)) + 2;
      g.shadowBlur = 6;
      g.shadowOffsetY = 1 + 2 * j / 18.8;
      g.shadowColor = '#000000';
      g.fillStyle = '#000000';
      g.beginPath(); g.arc(sz / 2, sz / 2, bsz / 2, 0, Math.PI * 2); g.fill();
    });
  }

  ensureSize(w, h) {
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
  }

  // One axis-aligned quad (6 verts). Food sprites are radially symmetric, so
  // unlike the snake stamps they never need rotating.
  _quad(arr, n, cx, cy, half, uv, i, r, g, b, a) {
    const u0 = uv[i * 4], v0 = uv[i * 4 + 1], u1 = uv[i * 4 + 2], v1 = uv[i * 4 + 3];
    const x0 = cx - half, y0 = cy - half, x1 = cx + half, y1 = cy + half;
    const P = [x0,y0,u0,v0,  x1,y0,u1,v0,  x1,y1,u1,v1,
               x0,y0,u0,v0,  x1,y1,u1,v1,  x0,y1,u0,v1];
    let o = n * this.STRIDE;
    for (let k = 0; k < 6; k++) {
      arr[o++] = P[k*4]; arr[o++] = P[k*4+1]; arr[o++] = P[k*4+2]; arr[o++] = P[k*4+3];
      arr[o++] = r; arr[o++] = g; arr[o++] = b; arr[o++] = a;
    }
    if (x0 < this._bx0) this._bx0 = x0;
    if (y0 < this._by0) this._by0 = y0;
    if (x1 > this._bx1) this._bx1 = x1;
    if (y1 > this._by1) this._by1 = y1;
    return n + 6;
  }

  beginFrame() {
    if (!this.ok) return;
    this._nLine = 0; this._nCore = 0; this._nGlow = 0;
    this._bx0 = 1e9; this._by0 = 1e9; this._bx1 = -1e9; this._by1 = -1e9;
  }

  // Queue one pellet. Everything is in PHYSICAL SCREEN PIXELS and mirrors the
  // 2D path one-for-one:
  //   cx,cy         pellet centre
  //   coreHalf      the core's on-screen half-size (the 2D path's `sp`)
  //   base          {r,g,b} 0..255
  //   cv2/gcv/g2cv  slither's three sprite-step indices
  //   a             the pellet's overall alpha (0.8 when dropped, else 1)
  //   pulse         0.5 + 0.5*cos(gfr/13)
  //   fal1/fal2     the glow layers' distance-falloff alphas, already scaled by
  //                 `a` and already tested against the caller's MIN_A cutoff
  addFood(cx, cy, coreHalf, base, cv2, gcv, g2cv, a, pulse, fal1, fal2) {
    if (!this.ok) return;
    const R = base.r / 255, G = base.g / 255, B = base.b / 255;
    // sprite pixels -> screen pixels; this is the 2D path's `k`
    const k = coreHalf / (this.coreW[cv2] / 2);

    const line = this._room('_vLine', 1);
    if (line) {
      const sp = (this.lineW[cv2] / 2) * k;
      this._nLine = this._quad(line, this._nLine, cx, cy, sp, this.texLine.uv, cv2, 0, 0, 0, 0.8 * a);
    }

    // core: steady + pulse
    const core = this._room('_vCore', 2);
    if (core) {
      this._nCore = this._quad(core, this._nCore, cx, cy, coreHalf, this.texCore.uv, cv2, R, G, B, a);
      this._nCore = this._quad(core, this._nCore, cx, cy, coreHalf, this.texCore.uv, cv2, R, G, B, a * pulse);
    }

    // two glow layers, each steady + pulse
    if (fal1 <= 0 && fal2 <= 0) return;
    const glow = this._room('_vGlow', (fal1 > 0 ? 2 : 0) + (fal2 > 0 ? 2 : 0));
    if (!glow) return;
    if (fal1 > 0) {
      const sp = (this.glowW[gcv] / 2) * k;
      this._nGlow = this._quad(glow, this._nGlow, cx, cy, sp, this.texGlow.uv, gcv, R, G, B, fal1);
      this._nGlow = this._quad(glow, this._nGlow, cx, cy, sp, this.texGlow.uv, gcv, R, G, B, fal1 * pulse);
    }
    if (fal2 > 0) {
      const sp = (this.glowW[g2cv] / 2) * k;
      this._nGlow = this._quad(glow, this._nGlow, cx, cy, sp, this.texGlow.uv, g2cv, R, G, B, fal2);
      this._nGlow = this._quad(glow, this._nGlow, cx, cy, sp, this.texGlow.uv, g2cv, R, G, B, fal2 * pulse);
    }
  }

  _clear() {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  _batch(buf, arr, nVerts, atlas, additive) {
    if (!nVerts) return;
    const gl = this.gl, p = this.p;
    gl.useProgram(p.prog);
    gl.enable(gl.BLEND);
    // additive for core + glow, premultiplied "over" for the outline
    if (additive) gl.blendFunc(gl.ONE, gl.ONE);
    else          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, arr.subarray(0, nVerts * this.STRIDE), gl.DYNAMIC_DRAW);
    const FS = this.STRIDE * 4;
    gl.enableVertexAttribArray(p.aPos);   gl.vertexAttribPointer(p.aPos,   2, gl.FLOAT, false, FS, 0);
    gl.enableVertexAttribArray(p.aUV);    gl.vertexAttribPointer(p.aUV,    2, gl.FLOAT, false, FS, 8);
    gl.enableVertexAttribArray(p.aColor); gl.vertexAttribPointer(p.aColor, 4, gl.FLOAT, false, FS, 16);
    gl.uniform2f(p.uRes, this.canvas.width, this.canvas.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, atlas.tex);
    gl.uniform1i(p.uTex, 0);
    gl.drawArrays(gl.TRIANGLES, 0, nVerts);
    gl.disable(gl.BLEND);
  }

  // Draw onto the 2D context, which MUST be at identity.
  //
  // Two GL layers and two composites, because the blend modes act on the
  // BACKGROUND, not just on each other: the outline darkens what is under it
  // (source-over) while the core and glows add to it ('lighter'). Folding them
  // into one layer would either erase the black rim or lose the additive
  // brightening. Core and glow share the second layer — additive blending is
  // commutative, so their order within it does not matter. Compositing is
  // clipped to the pellets' bounding box.
  render(ctx) {
    if (!this.ok || (!this._nCore && !this._nGlow && !this._nLine)) return;
    const W = this.canvas.width, H = this.canvas.height;
    const x0 = Math.max(0, Math.floor(this._bx0)), y0 = Math.max(0, Math.floor(this._by0));
    const x1 = Math.min(W, Math.ceil(this._bx1)),  y1 = Math.min(H, Math.ceil(this._by1));
    if (x1 <= x0 || y1 <= y0) return;
    const w = x1 - x0, h = y1 - y0;

    const prevOp = ctx.globalCompositeOperation, prevA = ctx.globalAlpha;
    ctx.globalAlpha = 1;

    this._clear();
    this._batch(this.bufLine, this._vLine, this._nLine, this.texLine, false);
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(this.canvas, x0, y0, w, h, x0, y0, w, h);

    this._clear();
    this._batch(this.bufGlow, this._vGlow, this._nGlow, this.texGlow, true);
    this._batch(this.bufCore, this._vCore, this._nCore, this.texCore, true);
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(this.canvas, x0, y0, w, h, x0, y0, w, h);

    ctx.globalCompositeOperation = prevOp;
    ctx.globalAlpha = prevA;
  }

  get quadCount() { return (this._nLine + this._nCore + this._nGlow) / 6; }
}
