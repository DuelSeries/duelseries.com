// Cross-section brightness profile (centre -> edge) sampled from snake_sprite.png
const SNAKE_CROSS_LUT = [1,0.999,0.991,0.982,0.97,0.959,0.944,0.923,0.902,0.876,0.86,0.836,0.82,0.798,0.779,0.756,0.737,0.71,0.696,0.661,0.643,0.602,0.561,0.504];

class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this._isMobile = window.matchMedia('(pointer: coarse)').matches;
    // Exact per-pixel snake shading for the local player's own snake. Heavy, so
    // it only runs for your own snake (not every snake). Add ?pp=0 to the URL to
    // disable it if it's too slow on a given device.
    this._ppMode = true;
    try {
      const s = (location && location.search) || '';
      if (/[?&]pp=0/.test(s) || localStorage.getItem('pp') === '0') this._ppMode = false;
    } catch (e) {}

    // WebGL snake body — ON by default for all snakes; ?gl=0 disables it.
    // Falls back to per-pixel (local) / solid colour if the GL context fails.
    this._glMode = true;
    try { if (/[?&]gl=0/.test((location && location.search) || '') || localStorage.getItem('gl') === '0') this._glMode = false; } catch (e) {}
    if (this._glMode && typeof SnakeGL !== 'undefined') {
      try { this.snakeGL = new SnakeGL(SNAKE_CROSS_LUT); } catch (e) { this.snakeGL = null; }
    }
    // WebGL food — same deal as the snake bodies. Canvas 2D charges ~1.6us per
    // drawImage no matter how big the sprite is, and food is 7 draws per pellet,
    // so a dense field is thousands of calls a frame. Batched quads make the
    // pellet count free. Measured at 1600x900: 800 pellets 14.6ms -> 2.5ms,
    // 3000 pellets 60.4ms -> 5.6ms, and the output matches the 2D passes to
    // within 0.015% of pixels. ?foodgl=0 forces the 2D path back on (?gl=0 also
    // covers it, along with the snakes); it falls back on its own if the
    // context fails.
    let foodGlMode = this._glMode;
    try {
      if (/[?&]foodgl=0/.test((location && location.search) || '') || localStorage.getItem('foodgl') === '0') foodGlMode = false;
    } catch (e) {}
    if (foodGlMode && typeof FoodGL !== 'undefined') {
      try { this.foodGL = new FoodGL(Renderer.FOOD_JS); } catch (e) { this.foodGL = null; }
    }
    this._hexFrame = 0;
    this.hexGrid = new HexGrid(this._isMobile);
    this.camera = new Camera();
    this._foodPhaseCache = new Map();
    this._foodSprCache   = new Map();   // slither food sprites, keyed colour+kind+size
    this._orbCoreCache   = new Map(); // per-colour crisp outlined cores
    this._orbGlowCache   = new Map(); // per-colour wide soft glow halos
    this._goldenFoodSprite   = this._makeGoldenFoodSprite();
  }

  // Food = an additive coloured DISC plus, on ~half the orbs, a soft colour GLOW halo.
  //   - The disc is drawn ADDITIVELY, so where two discs overlap the intersection ADDS UP
  //     and brightens (2 orbs = brighter, a pile = very bright). The overlap effect lives on
  //     the discs themselves, not one big glow.
  //   - There is NO black outline: additive blending can't show black, so a dark rim and
  //     overlap-brightening are mutually exclusive — overlap wins.
  //   - The disc centre's lightness varies per orb, and pulses over time (the "blink").
  _makeOrbGlow(color) {
    let c = this._orbGlowCache.get(color);
    if (c) return c;
    const sz = 96, half = sz / 2;
    c = document.createElement('canvas');
    c.width = c.height = sz;
    const ctx = c.getContext('2d');
    const b = this._parseColor(color);
    // ONE flat sheet of the colour — uniform out to 80% of the radius, then a soft feather
    // to nothing (no layered shades). Overall opacity + the blink are applied at draw time.
    const g = ctx.createRadialGradient(half, half, 0, half, half, half);
    g.addColorStop(0.00, `rgba(${b.r},${b.g},${b.b},1)`);
    g.addColorStop(0.80, `rgba(${b.r},${b.g},${b.b},1)`);
    g.addColorStop(1.00, `rgba(${b.r},${b.g},${b.b},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, sz, sz);
    this._orbGlowCache.set(color, c);
    return c;
  }
  // The additive colour disc. `w` = how light the centre is (0 = flat colour, 1 = white),
  // passed per orb so light-in-the-middle varies across the field; cached by colour+level.
  // No black rim — this is drawn additively (overlap-brightening) where black would vanish.
  _makeOrbCore(color, w) {
    const key = color + '|' + w;
    let c = this._orbCoreCache.get(key);
    if (c) return c;
    const sz = 64, half = sz / 2;
    c = document.createElement('canvas');
    c.width = c.height = sz;
    const ctx = c.getContext('2d');
    const b = this._parseColor(color);
    const mix = (k) => `rgba(${Math.round(b.r + (255 - b.r) * k)},${Math.round(b.g + (255 - b.g) * k)},${Math.round(b.b + (255 - b.b) * k)},1)`;
    const g = ctx.createRadialGradient(half, half, 0, half, half, half);
    g.addColorStop(0.00, mix(w));                          // lighter centre — amount varies per orb
    g.addColorStop(0.45, mix(w * 0.30));                   // transition scaled to that centre
    g.addColorStop(Renderer.ORB_SOLID, `rgba(${b.r},${b.g},${b.b},1)`); // solid disc
    g.addColorStop(1.00, `rgba(${b.r},${b.g},${b.b},0)`);  // soft edge (AA); no black rim
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, sz, sz);
    this._orbCoreCache.set(key, c);
    return c;
  }

  // ── slither.io food sprites ────────────────────────────────────────────────
  // Three sprites per pellet, generated with slither's own formulas over their
  // 17 size steps (j = 2.8 .. 18.8). We build the set once and, at draw time,
  // scale the whole set so the CORE lands on our own food radius — that keeps
  // their glow-to-core proportions exact at whatever size our food happens to be.
  //   core    : sz = ceil(2*(j*0.65)),  solid centre -> 0.2 at 99% -> 0
  //   glow    : sz = ceil(j*8+6),       solid centre -> transparent at radius j*4
  //   outline : black disc bsz = ceil(2*(j*0.7))+2 on a bsz+20 canvas, with
  //             shadowBlur 6 and shadowOffsetY 1 + 2*j/18.8
  static get FOOD_JS() {
    if (!Renderer._FOOD_JS) {
      const a = []; for (let j = 2.8; j <= 18.8; j += 1) a.push(j);
      Renderer._FOOD_JS = a;
    }
    return Renderer._FOOD_JS;
  }

  // Sprites are built on first use, and a glow can be a 157px canvas with a
  // radial gradient. Building several in one frame is a visible stall, so each
  // frame gets a small budget and anything over it reuses the nearest size we
  // already have for that colour. The full set fills in over the next few
  // frames instead of all at once.
  _budgetOk() { return this._sprBudget > 0 && (this._sprBudget--, true); }

  _nearestCached(prefix, color, i) {
    for (let d = 1; d < Renderer.FOOD_JS.length; d++) {
      let c = this._foodSprCache.get(color + prefix + (i - d));
      if (c) return c;
      c = this._foodSprCache.get(color + prefix + (i + d));
      if (c) return c;
    }
    return null;
  }

  _foodCore(color, i) {
    const key = color + '|c' + i;
    let c = this._foodSprCache.get(key); if (c) return c;
    if (!this._budgetOk()) { const n = this._nearestCached('|c', color, i); if (n) return n; }
    const j = Renderer.FOOD_JS[i], sz = Math.ceil(2 * (j * 0.65));
    const b = this._parseColor(color);
    c = document.createElement('canvas'); c.width = c.height = sz;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(sz / 2, sz / 2, 0, sz / 2, sz / 2, sz / 2);
    grd.addColorStop(0,    `rgba(${b.r},${b.g},${b.b},1)`);
    grd.addColorStop(0.99, `rgba(${b.r},${b.g},${b.b},0.2)`);
    grd.addColorStop(1,    `rgba(${b.r},${b.g},${b.b},0)`);
    g.fillStyle = grd; g.fillRect(0, 0, sz, sz);
    this._foodSprCache.set(key, c);
    return c;
  }

  _foodGlow(color, i) {
    const key = color + '|g' + i;
    let c = this._foodSprCache.get(key); if (c) return c;
    if (!this._budgetOk()) { const n = this._nearestCached('|g', color, i); if (n) return n; }
    const j = Renderer.FOOD_JS[i], sz = Math.ceil(j * 8 + 6);
    const b = this._parseColor(color);
    c = document.createElement('canvas'); c.width = c.height = sz;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(sz / 2, sz / 2, 1, sz / 2, sz / 2, j * 4);
    grd.addColorStop(0, `rgba(${b.r},${b.g},${b.b},1)`);
    grd.addColorStop(1, `rgba(${b.r},${b.g},${b.b},0)`);
    g.fillStyle = grd; g.fillRect(0, 0, sz, sz);
    this._foodSprCache.set(key, c);
    return c;
  }

  _foodOutline(i) {
    const key = 'o' + i;
    let c = this._foodSprCache.get(key); if (c) return c;
    if (!this._budgetOk()) { const n = this._nearestCached('', 'o', i); if (n) return n; }
    const j = Renderer.FOOD_JS[i];
    const bsz = Math.ceil(2 * (j * 0.7)) + 2, sz = bsz + 20;
    c = document.createElement('canvas'); c.width = c.height = sz;
    const g = c.getContext('2d');
    g.shadowBlur = 6; g.shadowOffsetY = 1 + 2 * j / 18.8; g.shadowColor = '#000000';
    g.fillStyle = '#000000';
    g.beginPath(); g.arc(sz / 2, sz / 2, bsz / 2, 0, Math.PI * 2); g.fill();
    this._foodSprCache.set(key, c);
    return c;
  }

  _makeGoldenFoodSprite() {
    const sz = 64, c = document.createElement('canvas');
    c.width = c.height = sz;
    const cx = sz / 2, sr = sz * 0.19; // sr = food radius in sprite pixels
    const ctx = c.getContext('2d');
    const glow = ctx.createRadialGradient(cx, cx, sr * 0.4, cx, cx, sr * 2.2);
    glow.addColorStop(0, 'rgba(255,215,0,0.35)');
    glow.addColorStop(1, 'rgba(255,215,0,0)');
    ctx.beginPath(); ctx.arc(cx, cx, sr * 2.2, 0, Math.PI * 2);
    ctx.fillStyle = glow; ctx.fill();
    const core = ctx.createRadialGradient(cx - sr*0.3, cx - sr*0.3, sr*0.1, cx, cx, sr);
    core.addColorStop(0, '#FFFACD'); core.addColorStop(0.4, '#FFD700'); core.addColorStop(1, '#B8860B');
    ctx.beginPath(); ctx.arc(cx, cx, sr, 0, Math.PI * 2);
    ctx.fillStyle = core; ctx.fill();
    ctx.beginPath(); ctx.arc(cx, cx, sr, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,165,0,0.9)'; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.beginPath(); ctx.arc(cx - sr*0.28, cx - sr*0.28, sr*0.22, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.fill();
    return c;
  }

  resize() {
    const rawDpr = window.devicePixelRatio || 1;
    const dpr = this._isMobile ? Math.min(rawDpr, 2) : rawDpr;
    this.canvas.style.width  = window.innerWidth  + 'px';
    this.canvas.style.height = window.innerHeight + 'px';
    this.canvas.width  = Math.round(window.innerWidth  * dpr);
    this.canvas.height = Math.round(window.innerHeight * dpr);
    this._dpr = dpr;
  }

  render(state, myId, mousePos, spectateSnake, cashoutRings, dt) {
    this._cashoutRings = cashoutRings || null;
    const { ctx, canvas, camera } = this;
    const dpr = this._dpr || 1;
    const W = window.innerWidth;  // logical pixels — used for all camera / world calculations
    const H = window.innerHeight;
    this._mousePos = mousePos;
    this._canvasW = W;
    this._canvasH = H;

    const mySnake = state.snakes.find(s => s.id === myId);
    const followSnake = spectateSnake || mySnake;

    if (followSnake) {
      camera.setScale(state.worldRadius, W, H, followSnake.length);
      camera.follow(followSnake.segs[0], followSnake.segs[1], W, H);
    }
    camera.update(Math.min(dt || 16.67, 50));

    /* Boost-pulse bookkeeping. The phase has to persist across frames per snake,
       so entries are kept in a Map and swept occasionally — snakes die and leave
       and the Map would otherwise grow for the whole session. */
    this._dtSec = Math.min(dt || 16.67, 50) / 1000;
    this._frameNo = (this._frameNo || 0) + 1;
    if (this._boostPhase && this._frameNo % 600 === 0) {
      for (const [id, e] of this._boostPhase) if (this._frameNo - e.seen > 300) this._boostPhase.delete(id);
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#070707';
    ctx.fillRect(0, 0, canvas.width, canvas.height); // physical pixels — clear full canvas

    if (this.snakeGL && this.snakeGL.ok) this.snakeGL.ensureSize(canvas.width, canvas.height);
    if (this.foodGL  && this.foodGL.ok)  this.foodGL.ensureSize(canvas.width, canvas.height);

    camera.apply(ctx, dpr);

    // Hex grid — drawn every frame (cheap pattern fill). Skipping frames on
    // mobile caused the background to flicker (canvas is cleared every frame).
    this.hexGrid.draw(ctx, camera, dpr);

    // Food — drawn UNCLIPPED so it's visible out past the border in the red zone too
    // (the red border tint is painted last, on top, so that food reads as "in the red part").
    this._drawFood(ctx, state.food, camera);

    // Snakes drawn outside the clip so bodies stay visible under the red border zone
    // Viewport bounds in world space (with margin for snake body radius)
    const margin = 300;
    const visL = (-camera.x) / camera.scale - margin;
    const visR = (W - camera.x) / camera.scale + margin;
    const visT = (-camera.y) / camera.scale - margin;
    const visB = (H - camera.y) / camera.scale + margin;
    // Compute visible other snakes once — used for both trail recording and drawing
    const visibleOthers = [];
    for (const snake of state.snakes) {
      if (snake.id === myId) continue;
      const hx = snake.segs && snake.segs[0], hy = snake.segs && snake.segs[1];
      if (hx < visL || hx > visR || hy < visT || hy > visB) continue;
      visibleOthers.push(snake);
    }

    // Snake bodies: render all into one GL layer, then composite once (a single
    // drawImage instead of one-per-snake — removes a GPU stall per snake).
    const glBatch = this._glMode && this.snakeGL && this.snakeGL.ok;
    if (glBatch) this.snakeGL.beginFrame();
    for (const snake of visibleOthers) this._drawSnakeBody(ctx, snake, false);
    if (mySnake) this._drawSnakeBody(ctx, mySnake, true);
    if (glBatch) {
      this.snakeGL.endFrame();
      ctx.setTransform(1, 0, 0, 1, 0, 0);        // screen space for the composite
      this.snakeGL.compositeTo(ctx);              // small per-snake copies (1 GL sync total)
      camera.apply(ctx, dpr);                      // back to world space
    }
    // Heads / eyes / hats / names / cashout rings, drawn on top of the bodies
    for (const snake of visibleOthers) this._drawSnakeOverlay(ctx, snake, false);
    if (mySnake) this._drawSnakeOverlay(ctx, mySnake, true);

    // Border overlay drawn last so red tint still appears on top of snakes
    this._drawBorder(ctx, state.worldRadius, camera);

    camera.reset(ctx, dpr);

    this._drawMinimap(ctx, state, myId, W, H);
  }

  _drawMinimap(ctx, state, myId, W, H) {
    const PAD      = 12;
    const R        = Math.min(110, Math.floor(Math.min(W, H) * 0.15));
    const isMobile = Math.min(W, H) < 600;
    // Bottom-right on desktop, lifted ~60px so the FPS/ping stats sit under it; top-left on mobile.
    const cx       = isMobile ? PAD + R : W - PAD - R;
    const cy       = isMobile ? PAD + R : H - PAD - R - 60;
    const scale  = R / state.worldRadius;

    ctx.save();

    // Clipped circle background
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fill();
    ctx.clip();

    // Snake dots — prefer the compact all-snakes minimap feed (state.mm). The main
    // `snakes` list is culled to the player's view, so without `mm` the minimap would
    // only show nearby snakes; `mm` carries every snake's head so the overview stays
    // complete. Falls back to `snakes` for older snapshots / spectator full sends.
    const dots = state.mm || state.snakes
      .filter(s => s.segs && s.segs.length >= 2)
      .map(s => ({ x: s.segs[0], y: s.segs[1], c: s.color, id: s.id }));
    for (const d of dots) {
      const sx = cx + d.x * scale;
      const sy = cy + d.y * scale;
      const isMe = d.id === myId;
      const dotR = isMe ? 4 : 2.5;

      if (isMe) {
        ctx.beginPath();
        ctx.arc(sx, sy, dotR + 1.5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(sx, sy, dotR, 0, Math.PI * 2);
      ctx.fillStyle = d.c || '#ffffff';
      ctx.fill();
    }

    ctx.restore();

    // Outer ring
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  _drawFood(ctx, food, camera) {
    this._sprBudget = 3;      // new sprite canvases allowed this frame
    const BASE_R = CONSTANTS.FOOD_RADIUS;
    const { x: camX, y: camY, scale } = camera;
    const W = this._canvasW, H = this._canvasH; // logical pixels
    const worldCX = (W / 2 - camX) / scale;
    const worldCY = (H / 2 - camY) / scale;
    const margin = BASE_R * 20;
    const halfW = W / (2 * scale) + margin;
    const halfH = H / (2 * scale) + margin;

    const t = Date.now() / 1000;
    // golden sprite: food radius = sz * 0.19, so world span = r / 0.19 * 2 each side
    const GS = 1 / 0.19;

    // Collect visible non-golden orbs once, then render them in PASSES. The pass split is
    // what gives every orb a thin black outline that MERGES on overlap: all the black
    // outline discs are laid down first (overlapping blacks fuse into one silhouette with no
    // internal seam), then the colour fills cover every interior — so only a thin rim of
    // black survives around the outside, and none between overlapping orbs.
    if (!this._foodVis) this._foodVis = [];
    const vis = this._foodVis;
    let n = 0;

    for (const f of food) {
      if (Math.abs(f.x - worldCX) > halfW || Math.abs(f.y - worldCY) > halfH) continue;

      // Phase cached per food ID — avoids hashing every frame
      let ph = this._foodPhaseCache.get(f.id);
      if (!ph) {
        // Food ids are now sequential integers (they used to be uuids, which
        // cost 36 bytes each on the wire). Sequential ids run straight through
        // the old string hash — neighbouring pellets would land on adjacent
        // seeds and visibly pulse in sync — so mix the integer properly first.
        let hash;
        if (typeof f.id === 'number') {
          let h = f.id | 0;
          h = Math.imul(h ^ (h >>> 16), 2246822507);
          h = Math.imul(h ^ (h >>> 13), 3266489909);
          hash = (h ^ (h >>> 16)) >>> 0;
        } else {
          const idStr = String(f.id);
          hash = 0;
          for (let i = 0; i < idStr.length; i++) hash = (hash * 31 + idStr.charCodeAt(i)) & 0xffff;
        }
        // amp: hover distance VARIES per orb — ~1 in 4 sit completely STILL (amp 0), the rest
        //   drift a little to a lot. white: how light the centre is (5 levels). glow: only
        //   ~50% of orbs get the halo. gox/goy/gamp/gphase: the glow sheet sits OFFSET from the
        //   orb and drifts on its own slow phase, randomised per orb.
        // slither's per-food state. gfr starts RANDOM and advances at gr, so no
        // two pellets pulse in sync; wsp is a random speed AND direction, giving
        // each pellet a slow drift around its own anchor. Derived from the id so
        // it stays stable across snapshots.
        const rnd1 = (hash & 0xff) / 255;
        const rnd2 = ((hash >> 8) & 0xff) / 255;
        // Map our food size onto slither's 0..16.5 scale to pick sprite indices.
        // Their formulas need an `sz`; a normal pellet sits mid-range and bigger
        // drops (death food) push toward the top, exactly as in their game.
        const sz = Math.min(16.5, 5 * (f.size || 1));
        const IC = Renderer.FOOD_JS.length;
        const cl = v => Math.min(IC - 1, Math.max(0, v));
        ph = {
          gfr: rnd1 * 64,                       // random starting phase
          gr:  0.65 + 0.1 * sz,                 // phase speed, scales with size
          wsp: (2 * rnd2 - 1) * 0.0225,         // wobble speed + direction
          cv2:  cl(Math.floor(IC * sz / 16.5)),                       // core + outline
          gcv:  cl(Math.floor(IC * (0.25 + 0.75 * sz / 16.5))),       // glow layer 1
          g2cv: cl(Math.floor(IC * 2 * (0.25 + 0.75 * sz / 16.5))),   // glow layer 2 (larger)
        };
        this._foodPhaseCache.set(f.id, ph);
      }
      // Constant size, no breathing. Per-orb HOVER in a small CIRCLE (cos/sin share the
      // argument), staying near the spawn spot. amp 0 = dead still. Suppressed while magnetized.
      // slither's wobble: every pellet orbits its anchor on a radius-6 circle at
      // its own speed and direction. Suppressed while magnetized toward a snake.
      const r = BASE_R * (f.size || 1);
      const gfr = ph.gfr + t * 60 * ph.gr;          // t is seconds; their gfr is per frame-unit
      const hov = f._pulled ? 0 : 6;
      const wx = f.x + Math.cos(ph.wsp * gfr) * hov;
      const wy = f.y + Math.sin(ph.wsp * gfr) * hov;

      if (f.isGolden) {
        // Money food — self-glowing golden sprite (not a slither element, no union outline).
        if (f.dropped) ctx.globalAlpha = 0.55;
        const span = r * GS;
        ctx.drawImage(this._goldenFoodSprite, wx - span, wy - span, span * 2, span * 2);
        ctx.globalAlpha = 1;
        continue;
      }
      let e = vis[n]; if (!e) e = vis[n] = {};
      e.color = f.color; e.wx = wx; e.wy = wy; e.r = r; e.ph = ph; e.dropped = !!f.dropped;
      e.gfr = gfr;
      n++;
    }

    // Pass A — the glow "sheet": one big flat translucent colour halo on ~50% of orbs, drawn
    // under everything. It's OFFSET from the orb and drifts on its own slow phase (randomised),
    // and its pulse is VERY subtle so it nearly blends into the background.
    // Glow "sheet": VERY faint, only barely fades in and out (never fully off). Tune these
    // two numbers — sensible range is ~0.02 (all but invisible) .. ~0.30 (obvious):
    // Every pellet is drawn as slither draws it: a normal-blended dark outline
    // underneath, then an additive bright core, then two wide additive glow
    // layers. The core and both glows are each drawn TWICE — once steady and
    // once at alpha (0.5 + 0.5*cos(gfr/13)) — which is what makes them pulse.
    // Note the outline pass is normal-blended, which is how slither gets both a
    // dark rim AND additive overlap-brightening in the same field.
    // The two wide glow layers' alphas fall off with distance from the VIEW
    // CENTRE:
    //   layer 1: 0.005 + 0.09*(1 - fd2/(86000 + fd2))
    //   layer 2: 0.085*(1 - fd2/(16500 + fd2))
    // Those constants are squared distances in slither's world units, where the
    // half-view is ~404 units — so the alpha halves at ~0.72 and ~0.32 of the
    // half-view. Re-expressed against our own viewport so it scales with our
    // camera. Without this falloff the whole field blows out to white.
    const halfView = Math.min(halfW, halfH);
    const K1 = Math.pow(halfView * 0.72, 2);
    const K2 = Math.pow(halfView * 0.32, 2);
    // Below ~1/255 a layer cannot change a single displayed pixel — an 8-bit
    // channel has no value between "unchanged" and "one step" — so those draws
    // are skipped outright.
    const MIN_A = 1 / 255;

    // Precompute each pellet's pulse, alpha and glow falloffs. Both the GL and
    // the 2D path below consume exactly these numbers.
    for (let i = 0; i < n; i++) {
      const e = vis[i];
      e.pulse = 0.5 + 0.5 * Math.cos(e.gfr / 13);
      e.a = e.dropped ? 0.8 : 1;
      const dx = e.wx - worldCX, dy = e.wy - worldCY;
      const fd2 = dx * dx + dy * dy;
      e.fal1 = (0.005 + 0.09 * (K1 / (K1 + fd2))) * e.a;
      e.fal2 = 0.085 * (K2 / (K2 + fd2)) * e.a;
      if (e.fal1 < MIN_A) e.fal1 = 0;
      if (e.fal2 < MIN_A) e.fal2 = 0;
    }

    if (this.foodGL && this.foodGL.ok) {
      // ── WebGL path ──────────────────────────────────────────────────────────
      // Same three passes, same sprites, same sizes — but queued as quads and
      // flushed in three GPU draw calls, so the per-pellet CPU cost is gone.
      // Camera is translate+scale only: screen = (world*scale + cam)*dpr.
      const dpr = this._dpr || 1, ss = scale * dpr;
      const gl = this.foodGL;
      gl.beginFrame();
      for (let i = 0; i < n; i++) {
        const e = vis[i];
        gl.addFood(
          (e.wx * scale + camX) * dpr, (e.wy * scale + camY) * dpr,
          e.r * ss, this._parseColor(e.color),
          e.ph.cv2, e.ph.gcv, e.ph.g2cv,
          e.a, e.pulse, e.fal1, e.fal2
        );
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);   // screen space for the composites
      gl.render(ctx);
      camera.apply(ctx, dpr);               // back to world space
    } else {
      // ── Canvas 2D fallback ──────────────────────────────────────────────────
      // Scale each pellet so its core sprite lands on our radius.
      for (let i = 0; i < n; i++) {
        const e = vis[i];
        const core = this._foodCore(e.color, e.ph.cv2);
        e.k = e.r / (core.width / 2);          // sprite units -> world units
      }

      // Pass 1 — dark outline, NORMAL blending at 0.8 alpha, under everything.
      ctx.globalCompositeOperation = 'source-over';
      for (let i = 0; i < n; i++) {
        const e = vis[i];
        const img = this._foodOutline(e.ph.cv2);
        const sp = (img.width / 2) * e.k;
        ctx.globalAlpha = 0.8 * e.a;
        ctx.drawImage(img, e.wx - sp, e.wy - sp, sp * 2, sp * 2);
      }

      // Pass 2 — the bright core, ADDITIVE, steady + pulse.
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < n; i++) {
        const e = vis[i];
        const img = this._foodCore(e.color, e.ph.cv2);
        const sp = (img.width / 2) * e.k;
        ctx.globalAlpha = e.a;
        ctx.drawImage(img, e.wx - sp, e.wy - sp, sp * 2, sp * 2);
        ctx.globalAlpha = e.pulse * e.a;
        ctx.drawImage(img, e.wx - sp, e.wy - sp, sp * 2, sp * 2);
      }

      // Pass 3 — two wide ambient glow layers, ADDITIVE, each steady + pulse.
      for (let i = 0; i < n; i++) {
        const e = vis[i];
        if (e.fal1 > 0) {
          const img = this._foodGlow(e.color, e.ph.gcv);
          const sp = (img.width / 2) * e.k;
          ctx.globalAlpha = e.fal1;
          ctx.drawImage(img, e.wx - sp, e.wy - sp, sp * 2, sp * 2);
          if (e.fal1 * e.pulse >= MIN_A) {
            ctx.globalAlpha = e.fal1 * e.pulse;
            ctx.drawImage(img, e.wx - sp, e.wy - sp, sp * 2, sp * 2);
          }
        }
        if (e.fal2 > 0) {
          const img = this._foodGlow(e.color, e.ph.g2cv);
          const sp = (img.width / 2) * e.k;
          ctx.globalAlpha = e.fal2;
          ctx.drawImage(img, e.wx - sp, e.wy - sp, sp * 2, sp * 2);
          if (e.fal2 * e.pulse >= MIN_A) {
            ctx.globalAlpha = e.fal2 * e.pulse;
            ctx.drawImage(img, e.wx - sp, e.wy - sp, sp * 2, sp * 2);
          }
        }
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }

    // Evict stale phase cache entries INCREMENTALLY. Clearing the whole map made
    // every pellet rebuild its state — and lazily regenerate sprites — in a single
    // frame, which showed up as a periodic half-second hitch. Map iterates in
    // insertion order, so dropping from the front retires the oldest ids first.
    const cap = Math.max(64, food.length * 2);
    if (this._foodPhaseCache.size > cap) {
      let over = this._foodPhaseCache.size - cap;
      if (over > 24) over = 24;                      // bounded work per frame
      for (const k of this._foodPhaseCache.keys()) {
        this._foodPhaseCache.delete(k);
        if (--over <= 0) break;
      }
    }
  }

  _parseColor(c) {
    if (!this._colorCache) this._colorCache = new Map();
    let v = this._colorCache.get(c);
    if (v) return v;
    let r = 110, g = 174, b = 175;
    if (typeof c === 'string' && c[0] === '#') {
      if (c.length === 7) { r = parseInt(c.slice(1,3),16); g = parseInt(c.slice(3,5),16); b = parseInt(c.slice(5,7),16); }
      else if (c.length === 4) { r = parseInt(c[1]+c[1],16); g = parseInt(c[2]+c[2],16); b = parseInt(c[3]+c[3],16); }
    }
    v = { r, g, b };
    this._colorCache.set(c, v);
    return v;
  }

  // Exact per-pixel snake body, ported 1:1 from the preview renderer. Heavy —
  // gated behind ?pp=1 and applied to the local snake only, purely to validate
  // the look in-game before moving the shading to WebGL. Renders to an offscreen
  // buffer at screen resolution, then composites under the active world transform.
  _drawSnakeBodyPerPixel(ctx, snake, R, SN, base) {
    const segs = snake.segs;
    const LUT = SNAKE_CROSS_LUT, LN = LUT.length;

    let minX=1e9,minY=1e9,maxX=-1e9,maxY=-1e9;
    for (let i=0;i<SN;i++){ const x=segs[i*2],y=segs[i*2+1]; if(x<minX)minX=x; if(x>maxX)maxX=x; if(y<minY)minY=y; if(y>maxY)maxY=y; }
    const GLOWW = R*0.34, marg = R + GLOWW + 2;
    minX-=marg; minY-=marg; maxX+=marg; maxY+=marg;
    const bw = maxX-minX, bh = maxY-minY;
    const screenScale = (this.camera.scale||1) * (this._dpr||1);
    let offW = Math.ceil(bw*screenScale), offH = Math.ceil(bh*screenScale);
    // Cap the per-frame pixel work so the framerate stays stable as the snake
    // grows (resolution drops a bit when huge — slightly softer, but smooth).
    const PIXBUDGET = 200000;
    { const pxc = offW*offH; if (pxc > PIXBUDGET){ const s=Math.sqrt(PIXBUDGET/pxc); offW=Math.max(2,Math.floor(offW*s)); offH=Math.max(2,Math.floor(offH*s)); } }
    if (offW<2||offH<2) return false;

    if (!this._snakeBuf){ this._snakeBuf=document.createElement('canvas'); this._snakeBufCtx=this._snakeBuf.getContext('2d'); }
    const buf=this._snakeBuf, bctx=this._snakeBufCtx;
    if (buf.width!==offW||buf.height!==offH){ buf.width=offW; buf.height=offH; }
    const img = bctx.createImageData(offW, offH), data = img.data;

    // Reversed spine: index 0 = tail ... last = head, matching the preview's
    // orientation so groove direction and the clean-head fade come out correct.
    if (!this._ptsScratch || this._ptsScratch.length < SN*2) this._ptsScratch = new Float32Array(SN*2+16);
    const P = this._ptsScratch;
    for (let k=0;k<SN;k++){ P[k*2]=segs[(SN-1-k)*2]; P[k*2+1]=segs[(SN-1-k)*2+1]; }
    // cumulative arc length from the tail
    if (!this._arcScratch || this._arcScratch.length < SN) this._arcScratch = new Float32Array(SN+16);
    const arc = this._arcScratch; arc[0]=0;
    for (let i=1;i<SN;i++){ const dx=P[i*2]-P[(i-1)*2], dy=P[i*2+1]-P[(i-1)*2+1]; arc[i]=arc[i-1]+Math.sqrt(dx*dx+dy*dy); }
    const totalArc = arc[SN-1];

    const SEGCAP = 48;                                  // cap segments checked per pixel
    const STEP = Math.max(1, Math.ceil(SN / SEGCAP));   // coarser spine on long snakes
    const invX=bw/offW, invY=bh/offH, aaW=Math.max(invX,invY);
    const GROOVE=R*0.46875, WAVE_PERIOD=13*GROOVE;
    const tipx=P[0], tipy=P[1];          // tail tip
    const t0x=P[STEP*2]-P[0], t0y=P[STEP*2+1]-P[1], tl0=Math.sqrt(t0x*t0x+t0y*t0y)||1;

    for (let oy=0;oy<offH;oy++){
      const wy=minY+(oy+0.5)*invY;
      for (let ox=0;ox<offW;ox++){
        const wx=minX+(ox+0.5)*invX;
        let best=1e9,bestS=0,capAtTail=false;
        for (let i=0;i+STEP<SN;i+=STEP){
          const ax=P[i*2],ay=P[i*2+1],bx=P[(i+STEP)*2],by=P[(i+STEP)*2+1];
          const dx=bx-ax,dy=by-ay,L2=dx*dx+dy*dy||1;
          let u=((wx-ax)*dx+(wy-ay)*dy)/L2; if(u<0)u=0; else if(u>1)u=1;
          const cx=ax+u*dx,cy=ay+u*dy,ex=wx-cx,ey=wy-cy,dd=Math.sqrt(ex*ex+ey*ey);
          if(dd<best){ best=dd; bestS=arc[i]+u*(arc[Math.min(SN-1,i+STEP)]-arc[i]); capAtTail=(i===0&&u===0); }
        }
        const di=(oy*offW+ox)*4;
        if (best<=R+aaW){
          let sBand=bestS, gFr=best/R;
          if (capAtTail){
            const relx=wx-tipx, rely=wy-tipy;
            sBand=(relx*t0x+rely*t0y)/tl0;
            gFr=Math.min(1,Math.abs(relx*(-t0y/tl0)+rely*(t0x/tl0))/R);
          }
          const fr=best/R;
          const idx=fr*(LN-1); let a=idx|0; if(a>LN-2)a=LN-2; const tt=idx-a;
          const lum=LUT[a]*(1-tt)+LUT[a+1]*tt;
          const shade=1-0.42*fr*fr;
          const endFade=Math.max(0,Math.min(1,(totalArc-bestS)/(R*1.15)));
          const sEff=sBand+R*Math.sqrt(Math.max(0,1-gFr*gFr));
          let gp=(sEff%GROOVE)/GROOVE; if(gp<0)gp+=1; gp=gp<0.5?gp:gp-1;
          const line=1-(0.06*endFade)*Math.exp(-(gp/0.18)*(gp/0.18));
          const wp=(((totalArc-bestS)%WAVE_PERIOD)+WAVE_PERIOD)%WAVE_PERIOD/WAVE_PERIOD;
          const waveShade=0.78+0.45*(0.5+0.5*Math.cos(2*Math.PI*wp));
          const scaleShade=1-(0.05*endFade)*(0.5+0.5*Math.cos(2*Math.PI*gp));
          const m=lum*shade*line*waveShade*scaleShade;
          let rr=base.r*m, gg=base.g*m, bb=base.b*m;
          if(rr>255)rr=255; if(gg>255)gg=255; if(bb>255)bb=255;
          let aa=(R+0.5*aaW-best)/aaW; if(aa>1)aa=1; else if(aa<0)aa=0;
          data[di]=rr; data[di+1]=gg; data[di+2]=bb; data[di+3]=aa*255;
        } else if (best<=R+GLOWW){
          data[di]=base.r; data[di+1]=base.g; data[di+2]=base.b;
          data[di+3]=255*0.16*Math.exp(-(best-R)/(0.1*R));
        }
      }
    }
    bctx.putImageData(img,0,0);
    ctx.drawImage(buf,0,0,offW,offH,minX,minY,bw,bh);
    return true;
  }

  // Tint a base colour by a brightness factor: f<1 darkens, f>1 lifts toward white
  _tint(base, f) {
    let r, g, b;
    if (f <= 1) { r = base.r * f; g = base.g * f; b = base.b * f; }
    else { const k = Math.min(1, (f - 1) / 0.5); r = base.r + (255-base.r)*k; g = base.g + (255-base.g)*k; b = base.b + (255-base.b)*k; }
    return 'rgb(' + (r|0) + ',' + (g|0) + ',' + (b|0) + ')';
  }

  // Lightweight shaded body (concentric cross-section strokes + shaded head dome),
  // tinted per colour. Used for every snake on devices without WebGL so bots stay
  // shaded instead of falling back to a flat blank colour.
  _drawSnakeBodyStroke(ctx, segs, SN, R, base) {
    const LAYERS = this._isMobile
      ? [[1.0,0.34],[0.6,0.72],[0.28,1.06]]
      : [[1.0,0.30],[0.84,0.50],[0.62,0.74],[0.40,0.95],[0.20,1.12]];
    const STEPS = 3;
    const drawFull = () => {
      ctx.beginPath();
      ctx.moveTo(segs[(SN-1)*2], segs[(SN-1)*2+1]);
      for (let j = SN-2; j >= 0; j--) {
        const pi=Math.min(SN-1,j+2)*2, ai=(j+1)*2, bi=j*2, ni=Math.max(0,j-1)*2;
        for (let s=1;s<=STEPS;s++){ const t=s/STEPS,t2=t*t,t3=t2*t;
          ctx.lineTo(
            0.5*((2*segs[ai])+(-segs[pi]+segs[bi])*t+(2*segs[pi]-5*segs[ai]+4*segs[bi]-segs[ni])*t2+(-segs[pi]+3*segs[ai]-3*segs[bi]+segs[ni])*t3),
            0.5*((2*segs[ai+1])+(-segs[pi+1]+segs[bi+1])*t+(2*segs[pi+1]-5*segs[ai+1]+4*segs[bi+1]-segs[ni+1])*t2+(-segs[pi+1]+3*segs[ai+1]-3*segs[bi+1]+segs[ni+1])*t3)
          );
        }
      }
    };
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const [wf, bf] of LAYERS) {
      ctx.strokeStyle = this._tint(base, bf);
      ctx.lineWidth = 2 * R * wf;
      drawFull();
      ctx.stroke();
    }
    const hx = segs[0], hy = segs[1];
    for (const [wf, bf] of LAYERS) {
      ctx.beginPath();
      ctx.arc(hx, hy, R * wf, 0, Math.PI * 2);
      ctx.fillStyle = this._tint(base, bf);
      ctx.fill();
    }
  }

  /* Boost pulse state for one snake, or null when it isn't boosting.
     Returns {m, sfr, r, g, b} for SnakeGL — see the constants at the top of
     SnakeGL.js for what the pulse is made of. Two things are worked out here
     because they are per-snake rather than per-stamp:

     THE PHASE. slither advances the pulse by (speed above the boost threshold)
     per frame, so the bands travel faster the harder you are boosting and hold
     their position — rather than snapping back to zero — the moment you let go.
     In their units the speed above threshold is m*(nsp3 - ssp) - 0.1 with
     ssp = 4.25 + 0.5*sc, and the accumulator gains 0.021 of it per 8ms frame,
     which is the 2.625 rad/s below. At full boost on a small snake that is about
     three pulses a second.

     THE COLOUR. The glow is not the snake's own colour: it is that hue pushed to
     a fixed mean brightness of 120, so a dark snake still throws a bright halo.
     Near-black colours (mean <= 24) have no usable hue and become flat grey. */
  _boostGlow(snake, growthScale, colorKey, base) {
    const m = Math.max(0, Math.min(1, snake.boostRamp || 0));
    if (m <= 0) return null;

    const phases = this._boostPhase || (this._boostPhase = new Map());
    let e = phases.get(snake.id);
    if (!e) { e = { p: 0, seen: 0 }; phases.set(snake.id, e); }
    e.seen = this._frameNo;
    const rate = (m * (7.75 - 0.5 * growthScale) - 0.1) * 2.625;   // radians/second
    if (rate > 0) e.p = (e.p + rate * (this._dtSec || 0.0167)) % (Math.PI * 2);

    const cache = this._glowColCache || (this._glowColCache = new Map());
    let c = cache.get(colorKey);
    if (!c) {
      const mean = (base.r + base.g + base.b) / 3;
      if (mean <= 24) {
        c = { r: 90 / 255, g: 90 / 255, b: 90 / 255 };
      } else {
        const k = 120 / mean;
        c = {
          r: Math.min(255, Math.floor(base.r * k)) / 255,
          g: Math.min(255, Math.floor(base.g * k)) / 255,
          b: Math.min(255, Math.floor(base.b * k)) / 255,
        };
      }
      cache.set(colorKey, c);
    }

    const g = this._glowOut || (this._glowOut = {});   // reused — this runs per snake per frame
    g.m = m; g.sfr = e.p; g.r = c.r; g.g = c.g; g.b = c.b;
    return g;
  }

  // Body only — goes into the batched GL layer (composited once by the caller),
  // or a 2D shaded stroke when WebGL is unavailable.
  _drawSnakeBody(ctx, snake, isMe) {
    if (!snake.segs || snake.segs.length < 4) return;
    const { segs, color } = snake;
    const growthScale = Math.min(6, 1 + ((snake.length || 20) - CONSTANTS.SNAKE_MIN_SEGMENTS * 2) / CONSTANTS.SNAKE_SC_SEGS);
    const R  = CONSTANTS.SNAKE_HEAD_RADIUS * growthScale;
    const SN = segs.length >> 1;
    const base = this._parseColor(color);

    if (this._glMode && this.snakeGL && this.snakeGL.ok) {
      const boost = this._boostGlow(snake, growthScale, color, base);
      if (this.snakeGL.drawBody(segs, SN, R, base, this.camera.scale || 1, this.camera.x, this.camera.y, this._dpr || 1, boost)) return;
    }
    // No WebGL on this device — shaded stroke body (+ head dome) for every snake
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    this._drawSnakeBodyStroke(ctx, segs, SN, R, base);
    ctx.restore();
  }

  // Everything drawn on top of the bodies: eyes, name/worth labels, cashout ring.
  _drawSnakeOverlay(ctx, snake, isMe) {
    if (!snake.segs || snake.segs.length < 4) return;
    const { segs, name } = snake;
    const growthScale = Math.min(6, 1 + ((snake.length || 20) - CONSTANTS.SNAKE_MIN_SEGMENTS * 2) / CONSTANTS.SNAKE_SC_SEGS);
    const R  = CONSTANTS.SNAKE_HEAD_RADIUS * growthScale;
    const HR = R; // same radius as body so head is flush

    ctx.save();
    ctx.lineCap  = 'round';
    ctx.lineJoin = 'round';

    // ── Head ──────────────────────────────────────────────────────────────────
    const hx    = segs[0], hy = segs[1];
    const angle = snake.angle || 0;
    const fwdX  = Math.cos(angle), fwdY  = Math.sin(angle);
    const perpX = -Math.sin(angle), perpY = Math.cos(angle);

    // ── Boost glow ───────────────────────────────────────────────────────────
    // Soft pulsing aura around the head whenever boosting (every snake, not just bought boosts).
    const bRamp = snake.boostRamp != null ? snake.boostRamp : (snake.boosting ? 1 : 0);
    if (bRamp > 0.04 && !this._isMobile) {
      const gr = HR * (2.0 + 0.35 * Math.sin(Date.now() / 70));
      const gg = ctx.createRadialGradient(hx, hy, HR * 0.3, hx, hy, gr);
      gg.addColorStop(0, snake.color || '#ffffff');
      gg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.4 * bRamp;
      ctx.fillStyle = gg;
      ctx.beginPath(); ctx.arc(hx, hy, gr, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    // ── Eyes ──────────────────────────────────────────────────────────────────
    // Matched to slither.io's setSkin defaults, as fractions of the body radius
    // (their er 6, pr 3.5, ed 6, esp 6 used as esp+0.5, pma 2.3, over a 14.5
    // body radius). Their eye whites sit at 75% alpha (o.eca), not solid white.
    const eyeR    = HR * 0.414;
    const pupilR  = eyeR * 0.583;
    const eyeSide = HR * 0.448;
    const eyeFwd  = HR * 0.414;

    // Pupils follow mouse for local player, movement direction for others
    let pupilFwdX = fwdX, pupilFwdY = fwdY;
    if (isMe && this._mousePos) {
      const wm = this.camera.screenToWorld(this._mousePos.x, this._mousePos.y, this._canvasW, this._canvasH);
      const pa = Math.atan2(wm.y - hy, wm.x - hx);
      pupilFwdX = Math.cos(pa);
      pupilFwdY = Math.sin(pa);
    }

    for (const side of [-1, 1]) {
      const ex = hx + fwdX * eyeFwd + perpX * eyeSide * side;
      const ey = hy + fwdY * eyeFwd + perpY * eyeSide * side;
      ctx.globalAlpha = 0.75;                 // slither's o.eca
      ctx.beginPath(); ctx.arc(ex, ey, eyeR, 0, Math.PI * 2);
      ctx.fillStyle = '#FFFFFF'; ctx.fill();
      ctx.globalAlpha = 1;                    // o.ppa — pupils stay solid
      const ps = eyeR * 0.383;                // o.pma / o.er
      ctx.beginPath(); ctx.arc(ex + pupilFwdX * ps, ey + pupilFwdY * ps, pupilR, 0, Math.PI * 2);
      ctx.fillStyle = '#060606'; ctx.fill();
    }

    // ── Labels ────────────────────────────────────────────────────────────────
    ctx.textAlign = 'center';
    if (name) {
      const fs = Math.round(R * 1.1);
      ctx.font = `bold ${fs}px Segoe UI`;
      ctx.strokeStyle = 'rgba(0,0,0,0.65)'; ctx.lineWidth = fs * 0.18;
      ctx.strokeText(name, hx, hy - HR * 2.5);
      ctx.fillStyle = isMe ? '#ffe066' : '#fff';
      ctx.fillText(name, hx, hy - HR * 2.5);
    }
    if (snake.worth > 0) {
      // USDC mode: worth already IS dollars. SOL mode: convert SOL worth -> CAD via the live rate.
      const usdc = (typeof moneyMode !== 'undefined' && moneyMode === 'usdc');
      const rate = usdc ? 1 : (typeof solCadRate !== 'undefined' ? solCadRate : 200);
      const label = (usdc ? '$' : 'C$') + (Math.round(snake.worth * rate * 100) / 100).toFixed(2);
      const wfs = Math.round(R * 1.0);
      ctx.font = `bold ${wfs}px Segoe UI`;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.lineWidth = wfs * 0.18;
      ctx.strokeText(label, hx, hy - HR * (name ? 3.8 : 2.5));
      ctx.fillStyle = '#14F195';
      ctx.fillText(label, hx, hy - HR * (name ? 3.8 : 2.5));
    }

    // ── Cashout ring ─────────────────────────────────────────────────────────
    const ringInfo = this._cashoutRings && this._cashoutRings.get(snake.id);
    if (ringInfo) {
      const elapsed  = performance.now() - ringInfo.start;
      const progress = Math.min(elapsed / ringInfo.duration, 1);
      const ringR    = HR * 1.75;
      const lw       = HR * 0.28;
      ctx.save();
      ctx.lineCap = 'round';
      // Faint background track
      ctx.beginPath();
      ctx.arc(hx, hy, ringR, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.lineWidth = lw;
      ctx.stroke();
      // Sweeping progress arc
      if (progress > 0) {
        if (!this._isMobile) { ctx.shadowColor = '#14F195'; ctx.shadowBlur = HR * 1.2; }
        ctx.beginPath();
        ctx.arc(hx, hy, ringR, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
        ctx.strokeStyle = '#14F195';
        ctx.lineWidth   = lw;
        ctx.stroke();
        ctx.shadowBlur = 0;
      }
      ctx.restore();
    }

    ctx.restore();
  }


  _drawBorder(ctx, worldRadius, camera) {
    const dpr = this._dpr || 1;
    const W = ctx.canvas.width, H = ctx.canvas.height;
    // camera.x/y are in logical pixels; multiply by dpr for physical pixel space
    const cx = camera.x * dpr;
    const cy = camera.y * dpr;
    const screenR = worldRadius * camera.scale * dpr;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0); // work in screen space — no outer arc edge possible

    // Fill entire screen, punch out the world circle (nonzero winding: CW rect + CCW arc)
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.arc(cx, cy, screenR, 0, Math.PI * 2, true); // CCW cuts it out
    ctx.fillStyle = 'rgba(180,0,0,0.22)';
    ctx.fill();

    // Single red border ring
    ctx.beginPath();
    ctx.arc(cx, cy, screenR, 0, Math.PI * 2);
    ctx.strokeStyle = '#ff3333';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();
  }

  _drawCursor(ctx, sx, sy) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(sx - 10, sy); ctx.lineTo(sx + 10, sy);
    ctx.moveTo(sx, sy - 10); ctx.lineTo(sx, sy + 10);
    ctx.stroke();
    ctx.restore();
  }

  _lighten(hex, amount) {
    const num = parseInt(hex.replace('#', ''), 16);
    const r = Math.min(255, (num >> 16) + amount);
    const g = Math.min(255, ((num >> 8) & 0xff) + amount);
    const b = Math.min(255, (num & 0xff) + amount);
    return `rgb(${r},${g},${b})`;
  }

  drawMinimap(minimapCtx, state, myId) {
    const mc = minimapCtx;
    const SIZE = mc.canvas.width;
    mc.clearRect(0, 0, SIZE, SIZE);
    const scale = SIZE / (state.worldRadius * 2);
    const cx = SIZE / 2, cy = SIZE / 2;

    mc.beginPath();
    mc.arc(cx, cy, state.worldRadius * scale, 0, Math.PI * 2);
    mc.fillStyle = 'rgba(10,14,40,0.8)'; mc.fill();
    mc.strokeStyle = '#ff3333'; mc.lineWidth = 2; mc.stroke();

    mc.fillStyle = 'rgba(100,255,100,0.5)';
    for (const f of state.food) {
      mc.fillRect(cx + f.x * scale - 1, cy + f.y * scale - 1, 2, 2);
    }
    for (const snake of state.snakes) {
      if (!snake.segs || snake.segs.length < 2) continue;
      mc.beginPath();
      mc.arc(cx + snake.segs[0] * scale, cy + snake.segs[1] * scale,
        snake.id === myId ? 4 : 2.5, 0, Math.PI * 2);
      mc.fillStyle = snake.id === myId ? '#ffe066' : snake.color;
      mc.fill();
    }
  }
}

// Fraction of the disc sprite radius occupied by the solid colour before the soft edge.
// The draw call sets span = r / ORB_SOLID so the disc renders at radius r. Kept high (crisp
// edge) so the colour fill covers the black outline disc cleanly, leaving a sharp thin rim.
Renderer.ORB_SOLID = 0.92;
