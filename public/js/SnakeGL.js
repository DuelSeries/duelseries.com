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

/* ── Boost pulse ────────────────────────────────────────────────────────────
   The bright bands that travel down a boosting snake. Two ADDITIVE passes of a
   soft round glow blob stamped along the same spine as the body, whose per-stamp
   alpha is a cosine of distance-along-the-body minus a phase that advances while
   boosting. One pass sits UNDER the body (the halo), one OVER it (the bands on
   the body itself), and they run at slightly different phase speeds so they beat
   against each other instead of reading as one clean sine.

   Every number below is a ratio read out of slither.io's own client, expressed
   against the body radius so it survives our different stamp pitch and units:

     glow blob      alpha = raised-cosine of (1 - dist/32) on a 62px cell
     under-glow     half-size R * 1.5 * (1 + 0.9375*sqrt(m)),  alpha sqrt(m)*0.38*(0.6+0.4cos(p - 1.15*sfr))
     over-glow      half-size R * 2,                            alpha m*0.37*(0.5+0.5cos(p - sfr))
     p              distance from head / (0.9655 * R) radians — one wavelength every ~6.07 body radii
     m              0 at base speed, 1 at full boost (our boostRamp is exactly this)

   Those alphas are PER STAMP in their renderer, and the passes are additive, so
   what you see is the sum over every blob covering a pixel. That sum depends on
   the stamp pitch, which is ours and not theirs, so the alpha is divided by the
   overlap count (2*half/pitch) to make the accumulated result equal the peak
   above. Without that the brightness is a function of how finely we stamp
   rather than of how hard the snake is boosting. */
const SNAKEGL_GLOW_PX      = 62;      // glow sprite cell
const SNAKEGL_GLOW_EDGE    = 32;      // falloff reaches zero here (just past the 31px half-cell)
const SNAKEGL_GLOW_UNDER   = 1.5;     // under-glow half-size / R, before the boost swell
const SNAKEGL_GLOW_SWELL   = 62 / 32 - 1;  // how much the under-glow grows with sqrt(m)
const SNAKEGL_GLOW_OVER    = 2.0;     // over-glow half-size / R
const SNAKEGL_WAVE_R       = 0.9655;  // body radii travelled per radian of pulse phase
const SNAKEGL_MAXGLOW      = 12000;   // glow quads per frame (only boosting snakes emit any)
const SNAKEGL_CURVE_SUB    = 4;       // spline steps per body point when stamping

/* THE TAIL FADES OUT RATHER THAN ENDING ON A HARD EDGE.

   slither never removes a tail point outright. It flags the point 'dying', ramps
   a value on it and draws it at 1 - that value, so the tip is always a soft
   gradient rather than a cap. Their retiring point is literally fading while it
   waits to be removed.

   Ours needed it for the same reason: the stored tail moves in one 43% step each
   time a point is laid, about a third of a body radius, and against a hard-edged
   tip that reads as the very end blinking and shivering. There is nothing to
   blink on a tip that is already transparent.

   Length of the fade, in body radii. Wide enough to cover that step several
   times over. This is their idea applied along the body rather than a literal
   port of their per-point timer, because their fade rate depends on how often
   their server retires points, which I could not pin down reliably. */
const SNAKEGL_TAIL_FADE    = 1.6;

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
      attribute float aAlpha;
      uniform vec2 uRes;
      varying vec2 vUV;
      varying vec3 vColor;
      varying float vA;
      void main() {
        vUV = aUV; vColor = aColor; vA = aAlpha;
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
      varying float vA;
      void main() {
        vec4 t = texture2D(uTex, vUV);
        gl_FragColor = vec4(vColor * t.r * t.a * vA, t.a * vA);
      }`;
    // Outline: flat black, alpha straight from the ring sprite.
    const fsLine = `
      precision mediump float;
      uniform sampler2D uTex;
      varying vec2 vUV;
      varying vec3 vColor;
      varying float vA;
      void main() {
        vec4 t = texture2D(uTex, vUV);
        gl_FragColor = vec4(0.0, 0.0, 0.0, t.a * vA);
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
        aAlpha: gl.getAttribLocation(p, 'aAlpha'),
        uRes:   gl.getUniformLocation(p, 'uRes'),
        uTex:   gl.getUniformLocation(p, 'uTex'),
      };
    };
    this.pBody = link(fsBody);
    this.pLine = link(fsLine);

    /* Glow needs a per-vertex alpha as well as a colour — the pulse brightness
       differs from stamp to stamp — so it gets its own layout (stride 8) rather
       than folding the alpha into the colour, which would light the blob but
       leave it fully transparent in the composite. */
    const vsGlow = `
      attribute vec2 aPos;
      attribute vec2 aUV;
      attribute vec3 aColor;
      attribute float aAlpha;
      uniform vec2 uRes;
      varying vec2 vUV;
      varying vec3 vColor;
      varying float vA;
      void main() {
        vUV = aUV; vColor = aColor; vA = aAlpha;
        vec2 c = vec2(aPos.x / uRes.x * 2.0 - 1.0, 1.0 - aPos.y / uRes.y * 2.0);
        gl_Position = vec4(c, 0.0, 1.0);
      }`;
    // Premultiplied output so it can be blended with ONE,ONE — the GL equivalent
    // of the 2D canvas "lighter" operation slither draws the glow with.
    const fsGlow = `
      precision mediump float;
      uniform sampler2D uTex;
      varying vec2 vUV;
      varying vec3 vColor;
      varying float vA;
      void main() {
        float a = texture2D(uTex, vUV).a * vA;
        gl_FragColor = vec4(vColor * a, a);
      }`;
    const pg = gl.createProgram();
    gl.attachShader(pg, this._compile(gl.VERTEX_SHADER, vsGlow));
    gl.attachShader(pg, this._compile(gl.FRAGMENT_SHADER, fsGlow));
    gl.linkProgram(pg);
    if (!gl.getProgramParameter(pg, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(pg));
    this.pGlow = {
      prog: pg,
      aPos:   gl.getAttribLocation(pg, 'aPos'),
      aUV:    gl.getAttribLocation(pg, 'aUV'),
      aColor: gl.getAttribLocation(pg, 'aColor'),
      aAlpha: gl.getAttribLocation(pg, 'aAlpha'),
      uRes:   gl.getUniformLocation(pg, 'uRes'),
      uTex:   gl.getUniformLocation(pg, 'uTex'),
    };
  }

  _initBuffers() {
    const gl = this.gl;
    this.STRIDE = 8;                                  // x,y,u,v,r,g,b,a
    this.GSTRIDE = 8;                                 // ...plus a per-vertex alpha for the glow
    this._vbBody = new Float32Array(this.MAXSTAMPS * 6 * this.STRIDE);
    this._vbLine = new Float32Array(this.MAXSTAMPS * 6 * this.STRIDE);
    this._nBody = 0; this._nLine = 0;                 // vertex counts
    this.bufBody = gl.createBuffer();
    this.bufLine = gl.createBuffer();
    // Only boosting snakes fill these, so they get a smaller cap than the body.
    this._vbGlowU = new Float32Array(SNAKEGL_MAXGLOW * 6 * this.GSTRIDE);
    this._vbGlowO = new Float32Array(SNAKEGL_MAXGLOW * 6 * this.GSTRIDE);
    this._nGlowU = 0; this._nGlowO = 0;
    this.bufGlowU = gl.createBuffer();
    this.bufGlowO = gl.createBuffer();
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

    // Boost glow blob — a linear falloff to zero at SNAKEGL_GLOW_EDGE, then eased
    // through a raised cosine so the halo has no visible rim. White, so the snake
    // colour multiplies through it the same way it does for the body.
    const GS = SNAKEGL_GLOW_PX, gpx = new Uint8Array(GS * GS * 4);
    for (let y = 0; y < GS; y++) {
      for (let x = 0; x < GS; x++) {
        const dx = GS / 2 - x, dy = GS / 2 - y;
        let v = 1 - Math.sqrt(dx * dx + dy * dy) / SNAKEGL_GLOW_EDGE;
        v = v <= 0 ? 0 : 0.5 * (1 - Math.cos(Math.PI * v));
        const o = (y * GS + x) * 4;
        gpx[o] = gpx[o + 1] = gpx[o + 2] = 255;
        gpx[o + 3] = Math.round(v * 255);
      }
    }
    this.texGlow = this._makeTex(gpx, GS, GS);
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

  // Grow-once scratch buffer for spine points. drawBody runs per snake per
  // frame; allocating a Float32Array there produced enough garbage to cause
  // periodic GC pauses (steady framerate with sudden half-second hitches).
  _scratchPts(SN) {
    const need = SN * 2;
    if (!this._ptsBuf || this._ptsBuf.length < need) this._ptsBuf = new Float32Array(need + 64);
    return this._ptsBuf;
  }

  // Push one rotated quad (6 verts) into a vertex array.
  _quad(arr, n, cx, cy, half, ang, u0, u1, r, g, b, a) {
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
      arr[o++] = r; arr[o++] = g; arr[o++] = b; arr[o++] = a;
    }
    return n + 6;
  }

  /* Axis-aligned quad with a per-vertex alpha, for the glow layout (stride 8).
     The glow blob is radially symmetric, so unlike the body stamps it does not
     need rotating to the local body angle. */
  _quadA(arr, n, cx, cy, half, r, g, b, a) {
    const x0 = cx - half, y0 = cy - half, x1 = cx + half, y1 = cy + half;
    const P = [x0, y0, 0, 0, x1, y0, 1, 0, x1, y1, 1, 1,
               x0, y0, 0, 0, x1, y1, 1, 1, x0, y1, 0, 1];
    let o = n * this.GSTRIDE;
    for (let i = 0; i < 6; i++) {
      arr[o++] = P[i * 4]; arr[o++] = P[i * 4 + 1];
      arr[o++] = P[i * 4 + 2]; arr[o++] = P[i * 4 + 3];
      arr[o++] = r; arr[o++] = g; arr[o++] = b; arr[o++] = a;
    }
    return n + 6;
  }

  /* Body points arrive roughly a body-radius apart. Now that the body can curl
     tightly, drawing straight between them turns a tight curve into flat chords
     with a visible crease at every joint, which reads as the body crumpling and
     bunching through a turn. Running a Catmull-Rom spline through the points
     first restores the curve; the stamps are then laid along that.

     Reused buffer, since this runs per snake per frame. */
  _smooth(pts, n) {
    if (n < 3) return n;
    const SUB = SNAKEGL_CURVE_SUB;
    const need = ((n - 1) * SUB + 1) * 2;
    if (!this._smBuf || this._smBuf.length < need) this._smBuf = new Float32Array(need + 512);
    const o = this._smBuf;
    let w = 0;
    for (let i = 0; i < n - 1; i++) {
      const a = Math.max(0, i - 1) * 2, b = i * 2, c = (i + 1) * 2, e = Math.min(n - 1, i + 2) * 2;
      const x0 = pts[a], y0 = pts[a+1], x1 = pts[b], y1 = pts[b+1];
      const x2 = pts[c], y2 = pts[c+1], x3 = pts[e], y3 = pts[e+1];
      for (let k = 0; k < SUB; k++) {
        const t = k / SUB, t2 = t * t, t3 = t2 * t;
        o[w++] = 0.5 * (2*x1 + (-x0 + x2)*t + (2*x0 - 5*x1 + 4*x2 - x3)*t2 + (-x0 + 3*x1 - 3*x2 + x3)*t3);
        o[w++] = 0.5 * (2*y1 + (-y0 + y2)*t + (2*y0 - 5*y1 + 4*y2 - y3)*t2 + (-y0 + 3*y1 - 3*y2 + y3)*t3);
      }
    }
    o[w++] = pts[(n-1)*2]; o[w++] = pts[(n-1)*2+1];
    return w >> 1;
  }

  // Resample a spine (screen px, head-first) into stamps and queue their quads.
  // `boost`, when present, adds the pulse passes: {m, sfr, r, g, b} with m the
  // 0..1 boost amount, sfr the travelling phase in radians, rgb the glow colour.
  _stamp(pts, n, R, base, boost) {
    const smN = this._smooth(pts, n);
    if (smN !== n) { pts = this._smBuf; n = smN; }
    const spacing = Math.max(0.75, R * SNAKEGL_STAMP_SPACING);
    const r = base.r / 255, g = base.g / 255, b = base.b / 255;
    const uw = 1 / SNAKEGL_FRAMES, KL = SNAKEGL_FRAMES, KL2 = KL * 2;
    const oHalf = R * SNAKEGL_OUTLINE_SCALE;
    // Pulse geometry and amplitudes, precomputed once per snake.
    const glow = boost && boost.m > 0;
    let gUnder = 0, gOver = 0, gStep = 0, gSfr = 0, gAmpU = 0, gAmpO = 0, gr = 0, gg = 0, gb = 0;
    if (glow) {
      const m = boost.m, mr = Math.sqrt(m);
      gUnder = R * SNAKEGL_GLOW_UNDER * (1 + SNAKEGL_GLOW_SWELL * mr);
      gOver  = R * SNAKEGL_GLOW_OVER;
      gStep  = spacing / (SNAKEGL_WAVE_R * R);   // pulse phase advanced per stamp
      gSfr   = boost.sfr;
      /* Additive passes accumulate, so a pixel on the spine is lit by every blob
         that reaches it, and the alphas above are PER STAMP in their renderer at
         THEIR stamp pitch. Ours is different, so the alpha is divided by how many
         of our blobs overlap a point — otherwise the brightness is a function of
         how finely we stamp rather than of how hard the snake is boosting, which
         is what made the first version far too bright.

         The overlap is not the blob's width: the blob is a raised cosine that is
         near zero at its rim. Integrating that profile along the spine gives
         exactly its falloff radius, so the effective count is E/pitch with
         E = half * 32/31 (the falloff reaches zero at 32px of the 62px cell,
         while the quad's half-size maps to 31). Accumulated peak then equals the
         peak alpha above, by construction. */
      const overlapU = (gUnder * (SNAKEGL_GLOW_EDGE / (SNAKEGL_GLOW_PX / 2))) / spacing;
      const overlapO = (gOver  * (SNAKEGL_GLOW_EDGE / (SNAKEGL_GLOW_PX / 2))) / spacing;
      // gain is a 1.0-by-default eyeball knob (?glow= in the URL), there so the
      // final brightness can be nudged against the real thing without a deploy.
      const gain = boost.gain || 1;
      gAmpU = mr * 0.38 * gain / overlapU;
      gAmpO = m  * 0.37 * gain / overlapO;
      gr = boost.r; gg = boost.g; gb = boost.b;
    }
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
    /* The last stretch of the tail fades out instead of ending on a hard cap,
       which is what slither does with its dying points. See SNAKEGL_TAIL_FADE. */
    const nStamps = S.length / 4;
    const fadeLen = Math.max(1e-6, R * SNAKEGL_TAIL_FADE);
    for (let s = S.length - 4; s >= 0; s -= 4) {
      if (this._nBody / 6 >= this.MAXSTAMPS) break;
      const cx = S[s], cy = S[s + 1], a = S[s + 2], k = S[s + 3];
      const fromTail = (nStamps - 1 - (s / 4)) * spacing;
      const ta = Math.min(1, fromTail / fadeLen);
      this._nLine = this._quad(this._vbLine, this._nLine, cx, cy, oHalf, a, 0, 1, 0, 0, 0, ta);
      this._nBody = this._quad(this._vbBody, this._nBody, cx, cy, R, a, k * uw, (k + 1) * uw, r, g, b, ta);
      if (glow && this._nGlowO / 6 < SNAKEGL_MAXGLOW) {
        /* Phase along the body. The two waves run at 1x and 1.15x the phase
           speed, so the halo and the bands on the body drift against each other
           rather than pulsing in lockstep. */
        const p = (s / 4) * gStep;
        const au = gAmpU * (0.6 + 0.4 * Math.cos(p - 1.15 * gSfr));
        const ao = gAmpO * (0.5 + 0.5 * Math.cos(p - gSfr));
        if (au > 0.002) this._nGlowU = this._quadA(this._vbGlowU, this._nGlowU, cx, cy, gUnder, gr, gg, gb, au);
        if (ao > 0.002) this._nGlowO = this._quadA(this._vbGlowO, this._nGlowO, cx, cy, gOver,  gr, gg, gb, ao);
      }
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
    gl.enableVertexAttribArray(p.aAlpha); gl.vertexAttribPointer(p.aAlpha, 1, gl.FLOAT, false, FS, 28);
    gl.uniform2f(p.uRes, w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(p.uTex, 0);
    gl.drawArrays(gl.TRIANGLES, 0, nVerts);
  }

  // Glow shares the vertex/UV/colour layout but carries a per-vertex alpha.
  _drawGlow(buf, arr, nVerts, w, h) {
    if (!nVerts) return;
    const gl = this.gl, p = this.pGlow;
    gl.useProgram(p.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, arr.subarray(0, nVerts * this.GSTRIDE), gl.DYNAMIC_DRAW);
    const FS = this.GSTRIDE * 4;
    gl.enableVertexAttribArray(p.aPos);   gl.vertexAttribPointer(p.aPos,   2, gl.FLOAT, false, FS, 0);
    gl.enableVertexAttribArray(p.aUV);    gl.vertexAttribPointer(p.aUV,    2, gl.FLOAT, false, FS, 8);
    gl.enableVertexAttribArray(p.aColor); gl.vertexAttribPointer(p.aColor, 3, gl.FLOAT, false, FS, 16);
    gl.enableVertexAttribArray(p.aAlpha); gl.vertexAttribPointer(p.aAlpha, 1, gl.FLOAT, false, FS, 28);
    gl.uniform2f(p.uRes, w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texGlow);
    gl.uniform1i(p.uTex, 0);
    gl.blendFunc(gl.ONE, gl.ONE);                     // additive — the "lighter" pass
    gl.drawArrays(gl.TRIANGLES, 0, nVerts);
    // aAlpha stays enabled: the body and outline passes carry it too now.
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);     // back to premultiplied normal
  }

  // ── Batched in-game path: beginFrame → drawBody ×N → endFrame → compositeTo ──
  beginFrame() {
    if (!this.ok) return;
    this._rects = [];
    this._nBody = 0; this._nLine = 0;
    this._nGlowU = 0; this._nGlowO = 0;
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);   // premultiplied
  }

  // Queue one snake. Camera is translate+scale only: screen = (world*scale + cam)*dpr.
  // `boost` (optional) is {m, sfr, r, g, b} — see _stamp — and adds the pulse.
  drawBody(segs, SN, R, base, scale, camX, camY, dpr, boost) {
    if (!this.ok || SN < 2) return false;
    scale = scale || 1; dpr = dpr || 1;
    const ss = scale * dpr;
    const W = this.canvas.width, H = this.canvas.height;

    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    // Reused scratch — this runs per snake per frame, so allocating here would
    // generate enough garbage to trigger periodic GC pauses (frame hitches).
    const pts = this._scratchPts(SN);
    for (let i = 0; i < SN; i++) {
      const x = (segs[i * 2] * scale + camX) * dpr;
      const y = (segs[i * 2 + 1] * scale + camY) * dpr;
      pts[i * 2] = x; pts[i * 2 + 1] = y;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const Rs = R * ss;
    /* The composite copies back only this box, so it has to cover the widest
       pass. While boosting that is the halo (up to 2.9 radii), not the outline. */
    const glowHalf = boost && boost.m > 0
      ? Rs * Math.max(SNAKEGL_GLOW_OVER, SNAKEGL_GLOW_UNDER * (1 + SNAKEGL_GLOW_SWELL * Math.sqrt(boost.m)))
      : 0;
    const marg = Math.max(Rs * SNAKEGL_OUTLINE_SCALE, glowHalf) + 2;
    if (maxX + marg < 0 || maxY + marg < 0 || minX - marg > W || minY - marg > H) return true; // off-screen

    this._stamp(pts, SN, Rs, base, boost);

    const ix = Math.max(0, Math.floor(minX - marg)), iy = Math.max(0, Math.floor(minY - marg));
    const ir = Math.min(W, Math.ceil(maxX + marg)),  ib = Math.min(H, Math.ceil(maxY + marg));
    if (ir > ix && ib > iy) this._rects.push([ix, iy, ir - ix, ib - iy]);
    return true;
  }

  /* Issue the batched passes bottom to top: outline, boost halo, bodies, then
     the boost bands. The halo goes UNDER the bodies so it reads as light spilling
     out around the snake; the bands go OVER so they brighten the body itself. */
  endFrame() {
    if (!this.ok) return;
    const gl = this.gl, W = this.canvas.width, H = this.canvas.height;
    this._draw(this.pLine, this.bufLine, this._vbLine, this._nLine, this.texLine, W, H);
    this._drawGlow(this.bufGlowU, this._vbGlowU, this._nGlowU, W, H);
    this._draw(this.pBody, this.bufBody, this._vbBody, this._nBody, this.texBody, W, H);
    this._drawGlow(this.bufGlowO, this._vbGlowO, this._nGlowO, W, H);
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
    const pts = this._scratchPts(SN);
    for (let i = 0; i < SN; i++) {
      pts[i * 2]     = (segs[i * 2]     - minX) * sx;
      pts[i * 2 + 1] = (segs[i * 2 + 1] - minY) * sy;
    }

    this._nBody = 0; this._nLine = 0; this._nGlowU = 0; this._nGlowO = 0;
    this._stamp(pts, SN, R * ((sx + sy) / 2), base);   // lobby previews never boost

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
