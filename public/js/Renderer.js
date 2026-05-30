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
    try { if (/[?&]pp=0/.test((location && location.search) || '')) this._ppMode = false; } catch (e) {}
    this._hexFrame = 0;
    this.hexGrid = new HexGrid(this._isMobile);
    this.camera = new Camera();
    this.boostTrails = new Map();
    this._foodPhaseCache = new Map();
    this._foodOverlaySprite  = this._makeFoodOverlaySprite();
    this._goldenFoodSprite   = this._makeGoldenFoodSprite();
  }

  _makeFoodOverlaySprite() {
    const sz = 64, c = document.createElement('canvas');
    c.width = c.height = sz;
    const cx = sz / 2;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.beginPath(); ctx.arc(cx, cx, cx, 0, Math.PI * 2);
    ctx.fillStyle = g; ctx.fill();
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

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#070707';
    ctx.fillRect(0, 0, canvas.width, canvas.height); // physical pixels — clear full canvas

    camera.apply(ctx, dpr);

    // Hex grid — every frame on desktop, every 3rd frame on mobile
    this._hexFrame++;
    if (!this._isMobile || this._hexFrame % 3 === 0) this.hexGrid.draw(ctx, camera, dpr);

    // Clip food to world circle only
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, state.worldRadius, 0, Math.PI * 2);
    ctx.clip();
    this._drawFood(ctx, state.food, camera);
    ctx.restore();

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
    for (const snake of visibleOthers) this._recordTrail(snake);
    if (mySnake) this._recordTrail(mySnake);
    this._drawLingeringTrails(ctx);
    for (const snake of visibleOthers) this._drawSnake(ctx, snake, false);
    if (mySnake) this._drawSnake(ctx, mySnake, true);

    // Border overlay drawn last so red tint still appears on top of snakes
    this._drawBorder(ctx, state.worldRadius, camera);

    camera.reset(ctx, dpr);

    this._drawMinimap(ctx, state, myId, W, H);
  }

  _drawMinimap(ctx, state, myId, W, H) {
    const PAD      = 12;
    const R        = Math.min(110, Math.floor(Math.min(W, H) * 0.15));
    const isMobile = Math.min(W, H) < 600;
    const cx       = PAD + R;
    const cy       = isMobile ? PAD + R : H - PAD - R;
    const scale  = R / state.worldRadius;

    ctx.save();

    // Clipped circle background
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fill();
    ctx.clip();

    // Snake dots
    for (const snake of state.snakes) {
      if (!snake.segs || snake.segs.length < 2) continue;
      const wx = snake.segs[0], wy = snake.segs[1];
      const sx = cx + wx * scale;
      const sy = cy + wy * scale;
      const isMe = snake.id === myId;
      const dotR = isMe ? 4 : 2.5;

      if (isMe) {
        ctx.beginPath();
        ctx.arc(sx, sy, dotR + 1.5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(sx, sy, dotR, 0, Math.PI * 2);
      ctx.fillStyle = snake.color || '#ffffff';
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
    for (const f of food) {
      if (Math.abs(f.x - worldCX) > halfW || Math.abs(f.y - worldCY) > halfH) continue;

      const r = BASE_R * (f.size || 1);

      // Phase cached per food ID — avoids hashing every frame
      let ph = this._foodPhaseCache.get(f.id);
      if (!ph) {
        const idStr = String(f.id);
        let hash = 0;
        for (let i = 0; i < idStr.length; i++) hash = (hash * 31 + idStr.charCodeAt(i)) & 0xffff;
        ph = { phase: hash * 0.00038, amp: hash % 100 < 80 ? 7 : 0 };
        this._foodPhaseCache.set(f.id, ph);
      }
      const wx = f.x + Math.sin(t * 1.4 + ph.phase) * ph.amp;
      const wy = f.y + Math.cos(t * 1.1 + ph.phase * 1.3) * ph.amp;

      if (f.dropped) ctx.globalAlpha = 0.55;

      if (f.isGolden) {
        // Pre-rendered sprite replaces 2 gradient allocations per frame
        const span = r * GS;
        ctx.drawImage(this._goldenFoodSprite, wx - span, wy - span, span * 2, span * 2);
      } else {
        // Solid fill
        ctx.beginPath();
        ctx.arc(wx, wy, r, 0, Math.PI * 2);
        ctx.fillStyle = f.color;
        ctx.fill();

        // Pre-rendered dark overlay replaces createRadialGradient per frame
        ctx.drawImage(this._foodOverlaySprite, wx - r, wy - r, r * 2, r * 2);

        // Thin outline
        ctx.beginPath();
        ctx.arc(wx, wy, r, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(0,0,0,0.8)';
        ctx.lineWidth = 0.6;
        ctx.stroke();
      }

      if (f.dropped) ctx.globalAlpha = 1;
    }
    // Evict stale phase cache entries
    if (this._foodPhaseCache.size > food.length * 2) this._foodPhaseCache.clear();
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

  _drawSnake(ctx, snake, isMe) {
    if (!snake.segs || snake.segs.length < 4) return;
    const { segs, color, boosting, name } = snake;
    const hatId   = snake.hatId   || 'none';
    const boostId = snake.boostId || 'default';

    const growthScale = 1 + Math.min(1.5, (snake.length || 20) / 200);
    const R  = CONSTANTS.SNAKE_HEAD_RADIUS * growthScale;
    const HR = R; // same radius as body so head is flush
    const SN = segs.length >> 1; // number of (x,y) pairs

    ctx.save();
    ctx.lineCap  = 'round';
    ctx.lineJoin = 'round';

    const STEPS = 3;
    const CHUNK = 8;

    // Helper: draw the Catmull-Rom spline path for the body
    const drawBodyPath = () => {
      for (let end = SN - 1; end > 0; end -= CHUNK) {
        const start = Math.max(0, end - CHUNK);
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(segs[end * 2], segs[end * 2 + 1]);
        for (let j = end - 1; j >= start; j--) {
          const pi = Math.min(SN-1,j+2)*2, ai=(j+1)*2, bi=j*2, ni=Math.max(0,j-1)*2;
          for (let s = 1; s <= STEPS; s++) {
            const t=s/STEPS, t2=t*t, t3=t2*t;
            ctx.lineTo(
              0.5*((2*segs[ai])+(-segs[pi]+segs[bi])*t+(2*segs[pi]-5*segs[ai]+4*segs[bi]-segs[ni])*t2+(-segs[pi]+3*segs[ai]-3*segs[bi]+segs[ni])*t3),
              0.5*((2*segs[ai+1])+(-segs[pi+1]+segs[bi+1])*t+(2*segs[pi+1]-5*segs[ai+1]+4*segs[bi+1]-segs[ni+1])*t2+(-segs[pi+1]+3*segs[ai+1]-3*segs[bi+1]+segs[ni+1])*t3)
            );
          }
        }
        ctx.lineWidth = R * 2;
        ctx.stroke();
      }
    };

    // ── Body ────────────────────────────────────────────────────────────────────
    let bodyDrawn = false;
    if (this._ppMode && isMe) {
      bodyDrawn = this._drawSnakeBodyPerPixel(ctx, snake, R, SN, this._parseColor(color));
    }
    if (!bodyDrawn) {
      ctx.strokeStyle = color;
      drawBodyPath();
    }

    // ── Head ──────────────────────────────────────────────────────────────────
    const hx    = segs[0], hy = segs[1];
    const angle = snake.angle || 0;
    const fwdX  = Math.cos(angle), fwdY  = Math.sin(angle);
    const perpX = -Math.sin(angle), perpY = Math.cos(angle);

    if (!bodyDrawn) {
      // per-pixel path already renders the shaded head dome
      ctx.beginPath();
      ctx.arc(hx, hy, HR, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }

    // ── Eyes ──────────────────────────────────────────────────────────────────
    const eyeR    = HR * 0.40;
    const pupilR  = eyeR * 0.54;
    const eyeSide = HR * 0.46;
    const eyeFwd  = HR * 0.38;

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
      ctx.beginPath(); ctx.arc(ex, ey, eyeR, 0, Math.PI * 2);
      ctx.fillStyle = '#FFFFFF'; ctx.fill();
      const ps = eyeR - pupilR;
      ctx.beginPath(); ctx.arc(ex + pupilFwdX * ps, ey + pupilFwdY * ps, pupilR, 0, Math.PI * 2);
      ctx.fillStyle = '#060606'; ctx.fill();
    }

    // ── Hat ───────────────────────────────────────────────────────────────────
    if (hatId !== 'none') {
      ctx.save();
      ctx.translate(hx, hy);
      ctx.rotate(angle - Math.PI / 2);
      const by = -HR * 1.08;

      if (hatId === 'crown') {
        const w = HR*1.5, h = HR*0.95;
        ctx.fillStyle = '#FFD700'; ctx.strokeStyle = '#B8860B'; ctx.lineWidth = HR*0.06;
        ctx.fillRect(-w/2, by - h*0.32, w, h*0.32);
        ctx.beginPath();
        ctx.moveTo(-w/2, by - h*0.32);
        ctx.lineTo(-w/3, by - h); ctx.lineTo(-w/8, by - h*0.48);
        ctx.lineTo(0, by - h);    ctx.lineTo(w/8, by - h*0.48);
        ctx.lineTo(w/3, by - h);  ctx.lineTo(w/2, by - h*0.32);
        ctx.closePath(); ctx.fill(); ctx.stroke();
        for (const ox of [-w/3, 0, w/3]) {
          ctx.beginPath(); ctx.arc(ox, by - h, HR*0.12, 0, Math.PI*2);
          ctx.fillStyle = '#ff3333'; ctx.fill();
        }
      } else if (hatId === 'tophat') {
        const w = HR*1.3, brimW = HR*1.8, brimH = HR*0.18, h = HR*1.1;
        ctx.fillStyle = '#111'; ctx.strokeStyle = '#333'; ctx.lineWidth = HR*0.06;
        ctx.fillRect(-w/2, by - h, w, h); ctx.strokeRect(-w/2, by - h, w, h);
        ctx.fillRect(-brimW/2, by - brimH, brimW, brimH); ctx.strokeRect(-brimW/2, by - brimH, brimW, brimH);
        ctx.fillStyle = '#8B0000'; ctx.fillRect(-w/2+HR*0.08, by - h*0.28, w - HR*0.16, HR*0.18);
      } else if (hatId === 'cap') {
        const w = HR*1.6, h = HR*0.7;
        ctx.fillStyle = '#1a6eff'; ctx.strokeStyle = '#0044cc'; ctx.lineWidth = HR*0.06;
        ctx.beginPath();
        ctx.ellipse(0, by - h*0.5, w/2, h/2, 0, Math.PI, 0); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#1a6eff';
        ctx.beginPath(); ctx.ellipse(w*0.15, by, w*0.48, HR*0.18, 0.25, 0, Math.PI); ctx.fill();
        ctx.beginPath(); ctx.arc(0, by - h*0.5, HR*0.22, 0, Math.PI*2);
        ctx.fillStyle = '#fff'; ctx.fill();
      } else if (hatId === 'wizard') {
        const w = HR*1.1, h = HR*1.6, brimW = HR*1.8, brimH = HR*0.18;
        ctx.fillStyle = '#6a0dad'; ctx.strokeStyle = '#4a0080'; ctx.lineWidth = HR*0.06;
        ctx.beginPath();
        ctx.moveTo(-w/2, by); ctx.lineTo(w/2, by); ctx.lineTo(0, by - h); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.fillRect(-brimW/2, by - brimH, brimW, brimH); ctx.strokeRect(-brimW/2, by - brimH, brimW, brimH);
        ctx.fillStyle = '#ffd700';
        for (const [sx, sy] of [[-w*0.15, by - h*0.35],[w*0.1, by - h*0.6],[0, by - h*0.15]]) {
          ctx.beginPath(); ctx.arc(sx, sy, HR*0.09, 0, Math.PI*2); ctx.fill();
        }
      } else if (hatId === 'cowboy') {
        const brimW = HR*2.2, brimH = HR*0.2, w = HR*1.0, h = HR*0.8;
        ctx.fillStyle = '#8B4513'; ctx.strokeStyle = '#5C2D0A'; ctx.lineWidth = HR*0.06;
        ctx.fillRect(-brimW/2, by - brimH, brimW, brimH); ctx.strokeRect(-brimW/2, by - brimH, brimW, brimH);
        ctx.beginPath();
        ctx.moveTo(-w/2, by - brimH); ctx.lineTo(-w*0.7, by - brimH - h*0.4);
        ctx.quadraticCurveTo(-w*0.4, by - brimH - h*1.1, 0, by - brimH - h);
        ctx.quadraticCurveTo(w*0.4, by - brimH - h*1.1, w*0.7, by - brimH - h*0.4);
        ctx.lineTo(w/2, by - brimH); ctx.closePath(); ctx.fill(); ctx.stroke();
      } else if (hatId === 'party') {
        const w = HR*0.9, h = HR*1.4;
        ctx.fillStyle = '#ff1493'; ctx.strokeStyle = '#cc0077'; ctx.lineWidth = HR*0.06;
        ctx.beginPath();
        ctx.moveTo(-w/2, by); ctx.lineTo(w/2, by); ctx.lineTo(0, by - h); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#fff';
        for (const [sx, sy] of [[-w*0.2, by - h*0.25],[w*0.15, by - h*0.55],[0, by - h*0.12],[-w*0.05, by - h*0.7]]) {
          ctx.beginPath(); ctx.arc(sx, sy, HR*0.07, 0, Math.PI*2); ctx.fill();
        }
        ctx.fillStyle = '#ffff00'; ctx.beginPath(); ctx.arc(0, by - h, HR*0.16, 0, Math.PI*2); ctx.fill();
      } else if (hatId === 'halo') {
        ctx.strokeStyle = '#FFD700'; ctx.lineWidth = HR*0.28;
        if (!this._isMobile) { ctx.shadowColor = '#FFD700'; ctx.shadowBlur = HR*0.6; }
        ctx.beginPath(); ctx.ellipse(0, by - HR*0.5, HR*0.75, HR*0.22, 0, 0, Math.PI*2); ctx.stroke();
        ctx.shadowBlur = 0;
      }

      ctx.restore();
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
      const rate = typeof solCadRate !== 'undefined' ? solCadRate : 200;
      const cadVal = (Math.round(snake.worth * rate*100)/100);
      const wfs = Math.round(R * 1.0);
      ctx.font = `bold ${wfs}px Segoe UI`;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.lineWidth = wfs * 0.18;
      ctx.strokeText(`C$${cadVal}`, hx, hy - HR * (name ? 3.8 : 2.5));
      ctx.fillStyle = '#14F195';
      ctx.fillText(`C$${cadVal}`, hx, hy - HR * (name ? 3.8 : 2.5));
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

  _recordTrail(snake) {
    const { id, segs, boosting, boostId } = snake;
    if (!boosting || !boostId || boostId === 'default') return;
    const SN = (segs.length >> 1);
    if (SN < 2) return;
    const tx = segs[(SN - 1) * 2], ty = segs[(SN - 1) * 2 + 1];
    const growthScale = 1 + Math.min(1.5, (snake.length || 20) / 200);
    const R = CONSTANTS.SNAKE_HEAD_RADIUS * growthScale;

    if (!this.boostTrails.has(id)) this.boostTrails.set(id, []);
    const trail = this.boostTrails.get(id);

    // Only add a point if it's moved enough from the last one (avoid stacking dots)
    if (trail.length > 0) {
      const last = trail[trail.length - 1];
      const dx = tx - last.x, dy = ty - last.y;
      if (dx * dx + dy * dy < (R * 0.4) * (R * 0.4)) return;
    }
    trail.push({ x: tx, y: ty, t: Date.now(), boostId, r: R });
  }

  _drawLingeringTrails(ctx) {
    const now = Date.now();
    const t = now / 1000;
    const MAX_AGE = 600;

    // Compute perpendicular direction at trail point i
    function perp(trail, i) {
      const a = trail[Math.max(0, i - 1)], b = trail[Math.min(trail.length - 1, i + 1)];
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.sqrt(dx*dx + dy*dy) || 1;
      return { px: -dy / len, py: dx / len };
    }

    ctx.save();
    for (const [id, trail] of this.boostTrails) {
      let start = 0;
      while (start < trail.length && now - trail[start].t > MAX_AGE) start++;
      if (start > 0) trail.splice(0, start);
      if (trail.length === 0) { this.boostTrails.delete(id); continue; }

      const boostId = trail[trail.length - 1].boostId;

      if (boostId === 'fire') {
        ctx.globalCompositeOperation = 'lighter';
        for (let i = 0; i < trail.length; i++) {
          const pt = trail[i]; const fade = 1 - (now - pt.t) / MAX_AGE; const R = pt.r;
          const flk = 0.75 + 0.25 * Math.sin(t * 14 + i * 1.3);
          ctx.fillStyle = `rgba(200,15,0,${(Math.round(fade*0.35*100)/100)})`; ctx.beginPath(); ctx.arc(pt.x, pt.y, R*1.3*fade*flk, 0, Math.PI*2); ctx.fill();
          ctx.fillStyle = `rgba(255,80,0,${(Math.round(fade*0.55*100)/100)})`; ctx.beginPath(); ctx.arc(pt.x, pt.y, R*0.75*fade*flk, 0, Math.PI*2); ctx.fill();
          ctx.fillStyle = `rgba(255,220,0,${(Math.round(fade*0.75*100)/100)})`; ctx.beginPath(); ctx.arc(pt.x, pt.y, R*0.35*fade, 0, Math.PI*2); ctx.fill();
        }
        for (let i = 0; i < trail.length; i += 2) {
          const pt = trail[i]; const fade = 1 - (now - pt.t) / MAX_AGE; const R = pt.r;
          const { px, py } = perp(trail, i);
          ctx.fillStyle = `rgba(255,160,0,${(Math.round(fade*0.95*100)/100)})`;
          ctx.beginPath(); ctx.arc(pt.x + px*Math.sin(t*5+i*2.3)*R*1.1, pt.y + py*Math.sin(t*5+i*2.3)*R*1.1, R*0.13*fade, 0, Math.PI*2); ctx.fill();
        }

      } else if (boostId === 'ice') {
        ctx.globalCompositeOperation = 'lighter';
        for (let i = 0; i < trail.length; i++) {
          const pt = trail[i]; const fade = 1 - (now - pt.t) / MAX_AGE; const R = pt.r;
          ctx.fillStyle = `rgba(80,180,255,${(Math.round(fade*0.35*100)/100)})`; ctx.beginPath(); ctx.arc(pt.x, pt.y, R*1.2*fade, 0, Math.PI*2); ctx.fill();
          ctx.fillStyle = `rgba(180,235,255,${(Math.round(fade*0.55*100)/100)})`; ctx.beginPath(); ctx.arc(pt.x, pt.y, R*0.55*fade, 0, Math.PI*2); ctx.fill();
        }
        ctx.globalCompositeOperation = 'source-over';
        for (let i = 0; i < trail.length; i += 3) {
          const pt = trail[i]; const fade = 1 - (now - pt.t) / MAX_AGE; const R = pt.r;
          if (fade < 0.1) continue;
          const cr = R*0.32*fade, ang = t*1.2 + i*0.9;
          ctx.strokeStyle = `rgba(210,245,255,${(Math.round(fade*0.9*100)/100)})`; ctx.lineWidth = R*0.08;
          for (let arm = 0; arm < 6; arm++) {
            const a = ang + arm*Math.PI/3;
            ctx.beginPath(); ctx.moveTo(pt.x, pt.y); ctx.lineTo(pt.x + Math.cos(a)*cr, pt.y + Math.sin(a)*cr); ctx.stroke();
          }
        }

      } else if (boostId === 'rainbow') {
        ctx.globalCompositeOperation = 'lighter';
        for (let i = 0; i < trail.length; i++) {
          const pt = trail[i]; const fade = 1 - (now - pt.t) / MAX_AGE; const R = pt.r;
          const h1 = ((t*150 - i*16) % 360 + 360) % 360;
          ctx.fillStyle = `hsla(${h1},100%,60%,${(Math.round(fade*0.55*100)/100)})`; ctx.beginPath(); ctx.arc(pt.x, pt.y, R*1.0*fade, 0, Math.PI*2); ctx.fill();
          ctx.fillStyle = `hsla(${(h1+120)%360},100%,80%,${(Math.round(fade*0.4*100)/100)})`; ctx.beginPath(); ctx.arc(pt.x, pt.y, R*0.5*fade, 0, Math.PI*2); ctx.fill();
        }

      } else if (boostId === 'lightning') {
        ctx.globalCompositeOperation = 'lighter';
        for (let i = 0; i < trail.length; i++) {
          const pt = trail[i]; const fade = 1 - (now - pt.t) / MAX_AGE; const R = pt.r;
          ctx.fillStyle = `rgba(80,80,255,${(Math.round(fade*0.3*100)/100)})`; ctx.beginPath(); ctx.arc(pt.x, pt.y, R*1.1*fade, 0, Math.PI*2); ctx.fill();
        }
        for (let bolt = 0; bolt < 2; bolt++) {
          ctx.beginPath(); ctx.moveTo(trail[0].x, trail[0].y);
          for (let i = 1; i < trail.length; i++) {
            const pt = trail[i]; const { px, py } = perp(trail, i); const R = pt.r;
            ctx.lineTo(pt.x + px*Math.sin(t*18+i*3.5+bolt*Math.PI)*R*0.6, pt.y + py*Math.sin(t*18+i*3.5+bolt*Math.PI)*R*0.6);
          }
          ctx.strokeStyle = `rgba(255,255,255,${bolt===0?0.95:0.5})`; ctx.lineWidth = (trail[0].r)*(bolt===0?0.12:0.06); ctx.lineCap = 'round'; ctx.stroke();
        }

      } else if (boostId === 'smoke') {
        ctx.globalCompositeOperation = 'source-over';
        for (let i = 0; i < trail.length; i++) {
          const pt = trail[i]; const fade = 1 - (now - pt.t) / MAX_AGE; const R = pt.r;
          const { px, py } = perp(trail, i);
          const grow = 1 + (1 - fade) * 0.5;
          const ox = px*Math.sin(i*0.6+t*0.8)*R*0.45, oy = py*Math.sin(i*0.6+t*0.8)*R*0.45;
          const grey = Math.floor(130 + fade*60);
          ctx.fillStyle = `rgba(${grey},${grey},${grey},${(Math.round(fade*0.22*100)/100)})`;
          ctx.beginPath(); ctx.arc(pt.x+ox, pt.y+oy, R*grow*0.7, 0, Math.PI*2); ctx.fill();
        }

      } else if (boostId === 'stars') {
        ctx.globalCompositeOperation = 'lighter';
        for (let i = 0; i < trail.length; i++) {
          const pt = trail[i]; const fade = 1 - (now - pt.t) / MAX_AGE; const R = pt.r;
          const twinkle = 0.55 + 0.45*Math.sin(t*9+i*1.8), sr = R*0.6*fade, sa = t*2.5+i*0.55;
          ctx.beginPath();
          for (let s = 0; s < 10; s++) {
            const a = s*Math.PI/5 + sa, rad = s%2===0 ? sr : sr*0.38;
            s===0 ? ctx.moveTo(pt.x+Math.cos(a)*rad, pt.y+Math.sin(a)*rad) : ctx.lineTo(pt.x+Math.cos(a)*rad, pt.y+Math.sin(a)*rad);
          }
          ctx.closePath(); ctx.fillStyle = `rgba(255,240,100,${(Math.round(fade*0.75*twinkle*100)/100)})`; ctx.fill();
        }

      } else if (boostId === 'galaxy') {
        ctx.globalCompositeOperation = 'lighter';
        for (let i = 0; i < trail.length; i++) {
          const pt = trail[i]; const fade = 1 - (now - pt.t) / MAX_AGE; const R = pt.r;
          ctx.fillStyle = `rgba(100,0,200,${(Math.round(fade*0.4*100)/100)})`; ctx.beginPath(); ctx.arc(pt.x, pt.y, R*1.1*fade, 0, Math.PI*2); ctx.fill();
          for (let arm = 0; arm < 3; arm++) {
            const sa = t*4 + i*0.5 + arm*Math.PI*2/3;
            ctx.fillStyle = `hsla(${260+arm*50},100%,70%,${(Math.round(fade*0.65*100)/100)})`;
            ctx.beginPath(); ctx.arc(pt.x+Math.cos(sa)*R*0.33*fade, pt.y+Math.sin(sa)*R*0.33*fade, R*0.28*fade, 0, Math.PI*2); ctx.fill();
          }
        }
      }
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
