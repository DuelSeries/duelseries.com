// WebGL snake-body renderer.
//
// This draws the body the way slither.io actually does: as a chain of small
// overlapping circular sprites ("stamps") along the spine, rather than as a
// distance field. Each stamp is a textured quad, so the whole world's snakes
// collapse into two draw calls (one outline pass, one body pass) and the GPU
// never notices the quad count.
//
// Sprite generation follows slither's own maths:
//   brightness  v = (1 - |dy|/r)^0.35, blended 37.5% toward a radial falloff
//   7 frames    v *= 1.22 - 0.44*j/6, ping-ponged along the body and indexed
//               from the HEAD, so the head always lands on the brightest frame
//   outline     a soft black ring sitting on the silhouette at 80% alpha
// The frames are stored as brightness only, so any snake colour can multiply
// through them at draw time.
const SNAKEGL_STAMP_SPACING = 0.35;   // stamp pitch as a fraction of the radius
const SNAKEGL_FRAMES        = 7;      // brightness frames (slither's kl)
const SNAKEGL_OUTLINE_SCALE = 1.625;  // outline quad half-size / body radius (52/32)
const SNAKEGL_CELL          = 48;     // body sprite cell size
const SNAKEGL_OUTLINE_PX    = 52;     // outline sprite size

class SnakeGL {
  constructor() {
    this.ok = false;
    this.MAXSTAMPS = 24000;           // hard cap on quads per frame
    try {
      this.canvas = document.createElement('canvas');
      this.canvas.width = 64; this.canvas.height = 64;
      const opts = { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false };
      const gl = this.canvas.getContext('webgl', opts) || this.canvas.getContext('experimental-webgl', opts);
      if (!gl) return;
      this.gl = gl;
      this._initProgram();
      this._initBuffers();
      this._initTextures();
      this.ok = true;
      console.log('[SnakeGL] WebGL sprite stamping ready');
    } catch (e) {
      console.warn('[SnakeGL] init failed, falling back:', e);
      this.ok = false;
    }
  }

  _compile(type, src) {
    const gl = this.gl, sh = gl.createShader(type);
    gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(sh));
    return sh;
  }

  _initProgram() {
    const gl = this.gl;
    const vs = `
      attribute vec2 aPos;
      attribute vec2 aUV;
      attribute vec3 aColor;
      uniform vec2 uRes;
      varying vec2 vUV;
      varying vec3 vColor;
      void main() {
        vUV = aUV; vColor = aColor;
        vec2 c = vec2(aPos.x / uRes.x * 2.0 - 1.0, 1.0 - aPos.y / uRes.y * 2.0);
        gl_Position = vec4(c, 0.0, 1.0);
      }`;
    // Body: texture holds brightness in .r and the circular mask in .a, so the
    // snake colour multiplies through. Output is premultiplied alpha.
    const fsBody = `
      precision mediump float;
      uniform sampler2D uTex;
      varying vec2 vUV;
      varying vec3 vColor;
      void main() {
        vec4 t = texture2D(uTex, vUV);
        gl_FragColor = vec4(vColor * t.r * t.a, t.a);
      }`;
    // Outline: flat black, alpha straight from the ring sprite.
    const fsLine = `
      precision mediump float;
      uniform sampler2D uTex;
      varying vec2 vUV;
      varying vec3 vColor;
      void main() {
        vec4 t = texture2D(uTex, vUV);
        gl_FragColor = vec4(0.0, 0.0, 0.0, t.a);
      }`;
    const link = (fsSrc) => {
      const p = gl.createProgram();
      gl.attachShader(p, this._compile(gl.VERTEX_SHADER, vs));
      gl.attachShader(p, this._compile(gl.FRAGMENT_SHADER, fsSrc));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
      return {
        prog: p,
        aPos:   gl.getAttribLocation(p, 'aPos'),
        aUV:    gl.getAttribLocation(p, 'aUV'),
        aColor: gl.getAttribLocation(p, 'aColor'),
        uRes:   gl.getUniformLocation(p, 'uRes'),
        uTex:   gl.getUniformLocation(p, 'uTex'),
      };
    };
    this.pBody = link(fsBody);
    this.pLine = link(fsLine);
  }

  _initBuffers() {
    const gl = this.gl;
    this.STRIDE = 7;                                  // x,y,u,v,r,g,b
    this._vbBody = new Float32Array(this.MAXSTAMPS * 6 * this.STRIDE);
    this._vbLine = new Float32Array(this.MAXSTAMPS * 6 * this.STRIDE);
    this._nBody = 0; this._nLine = 0;                 // vertex counts
    this.bufBody = gl.createBuffer();
    this.bufLine = gl.createBuffer();
  }

  // Body atlas: SNAKEGL_FRAMES cells in a row, brightness in RGB, mask in A.
  _initTextures() {
    const gl = this.gl, N = SNAKEGL_FRAMES, S = SNAKEGL_CELL, H = S / 2;
    const w = S * N;
    const px = new Uint8Array(w * S * 4);
    for (let j = 0; j < N; j++) {
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          const dx = x - H, dy = y - H;
          const dist = Math.sqrt(dx * dx + dy * dy);
          // slither's cross-section
          const v2 = Math.max(0, Math.min(1, 1 - dist / 34));
          let v = Math.pow(Math.max(0, Math.min(1, 1 - Math.abs(dy) / H)), 0.35);
          v += (v2 - v) * 0.375;
          v *= 1.22 - 0.44 * j / (N - 1);
          v = Math.max(0, Math.min(1, v));
          // circular mask with a 1px feather so edges stay smooth
          const a = Math.max(0, Math.min(1, H - dist));
          const o = ((y * w) + (j * S + x)) * 4;
          const b = Math.round(v * 255);
          px[o] = b; px[o + 1] = b; px[o + 2] = b;
          px[o + 3] = Math.round(a * 255);
        }
      }
    }
    this.texBody = this._makeTex(px, w, S);

    // Outline ring — slither's "komc": black ring at radius 16 of a 52px sprite,
    // 4px falloff each side, 80% peak alpha.
    const OS = SNAKEGL_OUTLINE_PX, opx = new Uint8Array(OS * OS * 4);
    for (let y = 0; y < OS; y++) {
      for (let x = 0; x < OS; x++) {
        const d = Math.abs(Math.sqrt(Math.pow(OS / 2 - x, 2) + Math.pow(OS / 2 - y, 2)) - 16);
        let v = d <= 4 ? 1 - d / 4 : 0;
        v *= 0.8;
        const o = (y * OS + x) * 4;
        opx[o] = opx[o + 1] = opx[o + 2] = 0;
        opx[o + 3] = Math.round(v * 255);
      }
    }
    this.texLine = this._makeTex(opx, OS, OS);
  }

  _makeTex(px, w, h) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  ensureSize(w, h) {
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
  }

  // Push one rotated quad (6 verts) into a vertex array.
  _quad(arr, n, cx, cy, half, ang, u0, u1, r, g, b) {
    const c = Math.cos(ang) * half, s = Math.sin(ang) * half;
    // corners: (-1,-1) (1,-1) (1,1) (-1,1) rotated
    const x0 = cx - c + s, y0 = cy - s - c;
    const x1 = cx + c + s, y1 = cy + s - c;
    const x2 = cx + c - s, y2 = cy + s + c;
    const x3 = cx - c - s, y3 = cy - s + c;
    const P = [x0, y0, u0, 0, x1, y1, u1, 0, x2, y2, u1, 1,
               x0, y0, u0, 0, x2, y2, u1, 1, x3, y3, u0, 1];
    let o = n * this.STRIDE;
    for (let i = 0; i < 6; i++) {
      arr[o++] = P[i * 4]; arr[o++] = P[i * 4 + 1];
      arr[o++] = P[i * 4 + 2]; arr[o++] = P[i * 4 + 3];
      arr[o++] = r; arr[o++] = g; arr[o++] = b;
    }
    return n + 6;
  }

  // Resample a spine (screen px, head-first) into stamps and queue their quads.
  _stamp(pts, n, R, base) {
    const spacing = Math.max(0.75, R * SNAKEGL_STAMP_SPACING);
    const r = base.r / 255, g = base.g / 255, b = base.b / 255;
    const uw = 1 / SNAKEGL_FRAMES, KL = SNAKEGL_FRAMES, KL2 = KL * 2;
    const oHalf = R * SNAKEGL_OUTLINE_SCALE;
    // Walk head -> tail collecting stamp positions, with the frame index j
    // counted from the head (j = 0 is the head, slither's brightest frame).
    const S = this._scratch || (this._scratch = []);
    S.length = 0;
    let j = 0, carry = 0, ang = 0;
    for (let i = 1; i < n; i++) {
      const ax = pts[(i - 1) * 2], ay = pts[(i - 1) * 2 + 1];
      const bx = pts[i * 2], by = pts[i * 2 + 1];
      const segLen = Math.hypot(bx - ax, by - ay);
      if (segLen < 1e-6) continue;
      const dx = (bx - ax) / segLen, dy = (by - ay) / segLen;
      ang = Math.atan2(dy, dx);
      let t = carry;
      while (t <= segLen) {
        let k = j % KL2; if (k >= KL) k = KL2 - (k + 1);
        S.push(ax + dx * t, ay + dy * t, ang, k);
        j++; t += spacing;
      }
      carry = t - segLen;
    }
    // Emit TAIL -> HEAD so the head overlaps the body, matching slither's
    // `for (j = bp-1; j >= 0; j--)` loop. Emitting head-first would leave the
    // tail painted on top and the snake reads back to front.
    for (let s = S.length - 4; s >= 0; s -= 4) {
      if (this._nBody / 6 >= this.MAXSTAMPS) break;
      const cx = S[s], cy = S[s + 1], a = S[s + 2], k = S[s + 3];
      this._nLine = this._quad(this._vbLine, this._nLine, cx, cy, oHalf, a, 0, 1, 0, 0, 0);
      this._nBody = this._quad(this._vbBody, this._nBody, cx, cy, R, a, k * uw, (k + 1) * uw, r, g, b);
    }
  }

  _draw(p, buf, arr, nVerts, tex, w, h) {
    if (!nVerts) return;
    const gl = this.gl;
    gl.useProgram(p.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, arr.subarray(0, nVerts * this.STRIDE), gl.DYNAMIC_DRAW);
    const FS = this.STRIDE * 4;
    gl.enableVertexAttribArray(p.aPos);   gl.vertexAttribPointer(p.aPos,   2, gl.FLOAT, false, FS, 0);
    gl.enableVertexAttribArray(p.aUV);    gl.vertexAttribPointer(p.aUV,    2, gl.FLOAT, false, FS, 8);
    gl.enableVertexAttribArray(p.aColor); gl.vertexAttribPointer(p.aColor, 3, gl.FLOAT, false, FS, 16);
    gl.uniform2f(p.uRes, w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(p.uTex, 0);
    gl.drawArrays(gl.TRIANGLES, 0, nVerts);
  }

  // ── Batched in-game path: beginFrame → drawBody ×N → endFrame → compositeTo ──
  beginFrame() {
    if (!this.ok) return;
    this._rects = [];
    this._nBody = 0; this._nLine = 0;
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);   // premultiplied
  }

  // Queue one snake. Camera is translate+scale only: screen = (world*scale + cam)*dpr.
  drawBody(segs, SN, R, base, scale, camX, camY, dpr) {
    if (!this.ok || SN < 2) return false;
    scale = scale || 1; dpr = dpr || 1;
    const ss = scale * dpr;
    const W = this.canvas.width, H = this.canvas.height;

    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    const pts = new Float32Array(SN * 2);
    for (let i = 0; i < SN; i++) {
      const x = (segs[i * 2] * scale + camX) * dpr;
      const y = (segs[i * 2 + 1] * scale + camY) * dpr;
      pts[i * 2] = x; pts[i * 2 + 1] = y;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const Rs = R * ss;
    const marg = Rs * SNAKEGL_OUTLINE_SCALE + 2;
    if (maxX + marg < 0 || maxY + marg < 0 || minX - marg > W || minY - marg > H) return true; // off-screen

    this._stamp(pts, SN, Rs, base);

    const ix = Math.max(0, Math.floor(minX - marg)), iy = Math.max(0, Math.floor(minY - marg));
    const ir = Math.min(W, Math.ceil(maxX + marg)),  ib = Math.min(H, Math.ceil(maxY + marg));
    if (ir > ix && ib > iy) this._rects.push([ix, iy, ir - ix, ib - iy]);
    return true;
  }

  // Issue the two batched passes (outline under, bodies over).
  endFrame() {
    if (!this.ok) return;
    const gl = this.gl, W = this.canvas.width, H = this.canvas.height;
    this._draw(this.pLine, this.bufLine, this._vbLine, this._nLine, this.texLine, W, H);
    this._draw(this.pBody, this.bufBody, this._vbBody, this._nBody, this.texBody, W, H);
    gl.disable(gl.BLEND);
  }

  // Copy each snake's box back onto the 2D context (which must be at identity).
  compositeTo(ctx) {
    if (!this.ok || !this._rects) return;
    const c = this.canvas;
    for (const r of this._rects) ctx.drawImage(c, r[0], r[1], r[2], r[3], r[0], r[1], r[2], r[3]);
  }

  // ── Single-snake path (lobby previews). World coords in, bbox out. ──────────
  // Renders into the bottom-left offW x offH of the GL canvas; the caller reads
  // from canvas.height - offH, matching WebGL's bottom-left origin.
  renderBody(segs, SN, R, base, screenScale) {
    if (!this.ok || SN < 2) return null;
    const gl = this.gl;
    screenScale = screenScale || 1;

    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for (let i = 0; i < SN; i++) {
      const x = segs[i * 2], y = segs[i * 2 + 1];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const marg = R * SNAKEGL_OUTLINE_SCALE + 4 + 3 / Math.max(screenScale, 1e-4);
    minX -= marg; minY -= marg; maxX += marg; maxY += marg;
    const bw = maxX - minX, bh = maxY - minY;
    const offW = Math.min(this.canvas.width,  Math.max(2, Math.ceil(bw * screenScale)));
    const offH = Math.min(this.canvas.height, Math.max(2, Math.ceil(bh * screenScale)));

    // world -> local pixels inside the offW x offH viewport
    const sx = offW / bw, sy = offH / bh;
    const pts = new Float32Array(SN * 2);
    for (let i = 0; i < SN; i++) {
      pts[i * 2]     = (segs[i * 2]     - minX) * sx;
      pts[i * 2 + 1] = (segs[i * 2 + 1] - minY) * sy;
    }

    this._nBody = 0; this._nLine = 0;
    this._stamp(pts, SN, R * ((sx + sy) / 2), base);

    gl.viewport(0, 0, offW, offH);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, Math.min(this.canvas.width, offW + 2), Math.min(this.canvas.height, offH + 2));
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this._draw(this.pLine, this.bufLine, this._vbLine, this._nLine, this.texLine, offW, offH);
    this._draw(this.pBody, this.bufBody, this._vbBody, this._nBody, this.texBody, offW, offH);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);

    return { minX, minY, bw, bh, offW, offH };
  }
}
