'use strict';
/* ─── Rooftop Snipers: the picture ────────────────────────────────────────────
   Everything is painted in the reference's own base pixels (a 1024 x 600 view
   widened to the window, shared/rtSim.js units) and rooftop.js blows the result
   up without smoothing. Every sprite here is OURS, drawn in code square by
   square: the city, the brick building, the eight snipers, their arms and rifles
   and the lettering (rtFont.js). The reference's image files are never used.

   WHERE THINGS ARE IS THE REFERENCE'S (its scene files, docs/rooftop-reference.md):
   the sky colour, the city strip on a 0.1 parallax 240 px above its layer, the
   water under it, the main building 1280 x 1280 with its top on the roof line
   drawn over the players, a sprite square 2 px for bodies, 4 px for arms and
   rifles, 6.4 px for the city and 12.8 px for the building, the body sprite
   30 x 72 squares centred 44 px above the body's origin and 4 px behind it, the
   arm hanging from a pin 58 px up, the rifle 20 px down the arm, the 6 px tracer
   that fades over half a second, the score, the round's label and the buttons. */

(function (root) {
  const F = root.RTFont;
  const SKY = '#6dd9e8';                       // T: DefualtMap MapData.background_color (0.4275, 0.851, 0.9098)
  const RED = '#a02929', BLUE = '#2e66bc';      // T: CharacterManager red/blue_char_color
  const CLOUD = '#e7efff';                      // T: Cloud.tscn self_modulate (0.906, 0.937, 1)
  const WATER = '#8db9e5';                      // T: CityLayer/Water modulate (0.553, 0.725, 0.898)

  const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  function hash(n) { n = (n ^ 61) ^ (n >>> 16); n = n + (n << 3); n = n ^ (n >>> 4); n = Math.imul(n, 0x27d4eb2d); return ((n ^ (n >>> 15)) >>> 0) / 4294967296; }

  /* ── the city strip: 100 x 50 squares at 6.4 px (T: CityLayer/City), our own skyline ── */
  function paintCity() {
    const c = mk(100, 50), g = c.getContext('2d');
    const fills = ['#f4dca9', '#e9e5c1', '#f4eca9', '#dbeddd', '#e8e1bf', '#d7dedd'];
    const edge = '#eff8c9';
    let x = 0, k = 0;
    while (x < 100) {
      const w = 6 + Math.floor(hash(k * 7 + 1) * 7), h = 12 + Math.floor(hash(k * 13 + 5) * 24);
      const f = fills[Math.floor(hash(k * 3 + 2) * fills.length)];
      const top = 50 - h;
      g.fillStyle = edge; g.fillRect(x, top, w, h);
      g.fillStyle = f; g.fillRect(x + 1, top + 1, w - 2, h - 1);
      // windows: little lighter slots in rows
      g.fillStyle = hash(k * 5 + 9) > 0.5 ? '#fbf6dc' : '#e2ecec';
      for (let wy = top + 3; wy < 48; wy += 4) for (let wx = x + 2; wx < x + w - 2; wx += 3) g.fillRect(wx, wy, 1, 2);
      // a few with a stepped roof
      if (hash(k * 11 + 3) > 0.6 && w > 8) { g.fillStyle = edge; g.fillRect(x + 2, top - 3, w - 4, 3); g.fillStyle = f; g.fillRect(x + 3, top - 2, w - 6, 3); }
      x += w + (hash(k * 17) > 0.7 ? 1 : 0);
      k++;
    }
    return c;
  }

  /* ── the building: 100 x 100 squares at 12.8 px (T: MainBuilding/BuildingSprite), our own bricks ── */
  function paintBuilding() {
    const c = mk(100, 100), g = c.getContext('2d');
    g.fillStyle = '#737373'; g.fillRect(0, 0, 100, 1);
    g.fillStyle = '#878787'; g.fillRect(0, 1, 100, 3);
    g.fillStyle = '#939393'; g.fillRect(0, 1, 100, 1);
    const reds = ['#b53d3d', '#c84848', '#cf6767', '#c26868', '#d95050', '#984343', '#d17979', '#e06464', '#c83030', '#b85050'];
    for (let y = 4; y < 94; y++) {
      const shift = (y % 2) ? 0 : 1;
      for (let x = -shift; x < 100; x += 3) {
        g.fillStyle = reds[Math.floor(hash(y * 131 + x * 7 + 3) * reds.length)];
        g.fillRect(x, y, 3, 1);
      }
    }
    // windows: brown frames round dark glass, four floors of five
    for (let fl = 0; fl < 4; fl++) {
      const wy = 13 + fl * 20;
      for (const wx of [6, 26, 46, 66, 86]) {
        g.fillStyle = '#72564a'; g.fillRect(wx - 1, wy - 1, 8, 11);
        g.fillStyle = '#5a5a5a'; g.fillRect(wx, wy, 6, 9);
        g.fillStyle = '#6a6a6a'; g.fillRect(wx, wy, 6, 1);
        g.fillStyle = '#72564a'; g.fillRect(wx, wy + 4, 6, 1);
      }
    }
    g.fillStyle = '#ec6666'; g.fillRect(0, 94, 100, 1);
    g.fillStyle = '#aeaeae'; g.fillRect(0, 95, 100, 5);
    g.fillStyle = '#a5a5a5'; g.fillRect(0, 95, 100, 1);
    return c;
  }

  /* ── the snipers: 30 x 72 squares at 2 px, facing left, 'T' is the team colour ── */
  const SK = ['#f1c7a1', '#c68b59', '#8d5a3b', '#e0ac7e', '#f5d0b0', '#a86f45'];
  function person(g, o, T) {
    const r = (x, y, w, h, col) => { g.fillStyle = col === 'T' ? T : col; g.fillRect(x, y, w, h); };
    const skin = o.skin, skinD = o.skinD || shade(skin, -0.18);
    // shoes and legs
    r(7, 67, 18, 5, o.shoe); r(7, 70, 18, 2, shade(o.shoe, -0.25));
    r(9, 50, 15, 17, o.pants); r(16, 52, 1, 15, shade(o.pants, -0.2));
    // torso
    r(8, 29, 18, 21, o.top); r(23, 29, 3, 21, shade(o.top, -0.15));
    // neck and head
    r(13, 26, 8, 3, skinD);
    r(8, 9, 17, 18, skin);
    r(21, 15, 2, 4, skinD);                               // the ear
    r(7, 17, 1, 3, skin);                                 // the nose
    r(10, 15, 2, 2, '#1f1f24');                           // the eye
    r(9, 22, 4, 1, shade(skin, -0.35));                   // the mouth
    if (o.extra) o.extra(r, T);
  }
  function shade(hex, k) {
    const n = parseInt(hex.slice(1), 16);
    const f = (v) => Math.max(0, Math.min(255, Math.round(k < 0 ? v * (1 + k) : v + (255 - v) * k)));
    return '#' + [f(n >> 16), f((n >> 8) & 255), f(n & 255)].map(v => v.toString(16).padStart(2, '0')).join('');
  }
  const CAST = [
    { name: 'chef', skin: SK[0], top: '#f2f2f2', pants: '#2f2f33', shoe: '#1d1d1d', sleeve: '#f2f2f2',
      extra: (r) => { r(9, 0, 15, 9, '#fafafa'); r(8, 7, 17, 3, '#e6e6e6'); r(10, 1, 3, 2, '#ffffff');
        r(11, 33, 2, 2, '#bbbbbb'); r(11, 39, 2, 2, '#bbbbbb'); r(11, 45, 2, 2, '#bbbbbb');
        r(9, 27, 13, 4, 'T'); r(9, 31, 4, 3, 'T');
        for (let y = 50; y < 66; y += 2) for (let x = 9 + (y % 4 ? 0 : 1); x < 24; x += 2) r(x, y, 1, 1, '#d8d8d8'); } },
    { name: 'builder', skin: SK[1], top: '#8a8f96', pants: '#3b5a8c', shoe: '#6b4423', sleeve: '#8a8f96',
      extra: (r) => { r(7, 5, 19, 6, '#f2c12e'); r(5, 10, 21, 2, '#d9a81c'); r(9, 6, 4, 1, '#fde27a');
        r(8, 30, 18, 19, '#f07a1a'); r(8, 38, 18, 3, 'T'); r(14, 30, 2, 19, '#c95f0e'); } },
    { name: 'clerk', skin: SK[3], top: '#c9b28a', pants: '#b59c74', shoe: '#3d2a1c', sleeve: '#c9b28a',
      extra: (r) => { r(8, 6, 17, 5, '#5a3a22'); r(20, 10, 5, 7, '#5a3a22'); r(9, 7, 6, 2, '#6d4a2e');
        r(9, 29, 7, 3, '#f4f4f4'); r(11, 29, 3, 15, 'T'); r(11, 44, 3, 2, 'T'); } },
    { name: 'granny', skin: SK[4], top: '#7a4b8c', pants: '#4b3b5c', shoe: '#222222', sleeve: '#7a4b8c',
      extra: (r) => { r(8, 6, 17, 6, '#b8b8b8'); r(19, 2, 6, 6, '#c8c8c8'); r(20, 11, 5, 8, '#b8b8b8');
        r(8, 14, 6, 4, '#222'); r(9, 15, 4, 2, '#cfe8f2'); r(10, 15, 2, 2, '#1f1f24');
        r(9, 27, 15, 4, 'T'); r(9, 31, 4, 6, 'T'); r(9, 50, 15, 15, '#4b3b5c'); } },
    { name: 'skater', skin: SK[2], top: '#e8e8e8', pants: '#a89268', shoe: '#f0f0f0', sleeve: '#e8e8e8',
      extra: (r) => { r(7, 4, 18, 8, '#2d6b4f'); r(7, 10, 18, 2, '#24563f'); r(14, 2, 4, 2, '#2d6b4f');
        for (let y = 31; y < 49; y += 4) r(8, y, 18, 2, '#9a9a9a');
        r(9, 49, 15, 2, 'T'); r(9, 59, 15, 5, SK[2]); r(9, 64, 15, 3, '#ffffff'); r(7, 70, 18, 2, '#333'); } },
    { name: 'robot', skin: '#9aa3ab', skinD: '#7b848c', top: '#5d666e', pants: '#7b848c', shoe: '#3a4046', sleeve: '#5d666e',
      extra: (r) => { r(15, 3, 2, 6, '#3a4046'); r(14, 1, 4, 2, '#ffd23f'); r(8, 13, 9, 5, '#2a2f35'); r(9, 14, 3, 3, '#ffd23f');
        r(7, 17, 1, 3, '#9aa3ab'); r(9, 22, 4, 1, '#3a4046'); r(12, 34, 6, 6, '#3a4046'); r(13, 35, 4, 4, 'T');
        r(9, 57, 15, 1, '#5d666e'); } },
    { name: 'astronaut', skin: '#eeeeee', skinD: '#cfcfcf', top: '#eeeeee', pants: '#e2e2e2', shoe: '#8a8f96', sleeve: '#eeeeee',
      extra: (r) => { r(7, 7, 19, 21, '#f6f6f6'); r(7, 12, 9, 10, '#1d2b3a'); r(8, 13, 3, 2, '#5f87a8');
        r(13, 32, 5, 4, 'T'); r(9, 47, 17, 3, '#b5b5b5'); r(9, 60, 15, 2, '#cfcfcf'); } },
    { name: 'farmer', skin: SK[5], top: '#3f7d3c', pants: '#8a5a33', shoe: '#5a3a1e', sleeve: '#3f7d3c',
      extra: (r) => { r(4, 7, 24, 3, '#e2c46b'); r(9, 3, 14, 5, '#e2c46b'); r(9, 6, 14, 1, '#b8913a');
        for (let x = 8; x < 26; x += 4) r(x, 29, 2, 21, '#2b5a29');
        for (let y = 31; y < 49; y += 5) r(8, y, 18, 1, '#2b5a29');
        r(10, 36, 13, 14, '#8a5a33'); r(10, 29, 2, 8, '#8a5a33'); r(20, 29, 2, 8, '#8a5a33'); r(10, 36, 2, 2, 'T'); r(20, 36, 2, 2, 'T'); } },
  ];

  // An arm: 3 x 11 squares at 4 px (T: ArmGraphic/Graphic), the sleeve then the hand.
  function paintArm(o) {
    const c = mk(3, 11), g = c.getContext('2d');
    g.fillStyle = o.sleeve; g.fillRect(0, 0, 3, 8);
    g.fillStyle = shade(o.sleeve, -0.18); g.fillRect(2, 0, 1, 8);
    g.fillStyle = o.skin; g.fillRect(0, 8, 3, 3);
    g.fillStyle = o.skinD || shade(o.skin, -0.18); g.fillRect(0, 10, 3, 1);
    return c;
  }
  // The rifle: 6 x 17 squares at 4 px hanging from the hand, barrel down, the muzzle at (-6, 58) (T: Gun.tscn).
  function paintGun(strong) {
    const c = mk(6, 17), g = c.getContext('2d');
    const r = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x, y, w, h); };
    const wood = strong ? '#2f5c3a' : '#7a4a24', woodD = strong ? '#1f4029' : '#4f2f16', metal = '#33343a';
    r(2, 0, 3, 5, wood); r(4, 0, 1, 5, woodD);
    r(1, 4, 4, 5, metal); r(1, 4, 4, 1, '#4a4b52');
    r(0, 3, 1, 5, '#1b1b20'); r(0, 7, 1, 1, '#7fd3ff');
    r(3, 9, 1, 2, metal);
    r(1, 9, 1, 8, '#2a2a30'); r(1, 16, 1, 1, '#5a5a62');
    if (strong) { r(2, 9, 1, 4, '#2a2a30'); r(2, 5, 2, 1, '#53d18a'); }
    return c;
  }
  // The rocket launcher: 9 x 18 squares at 4 px (T: RocketLauncher Sprite at (-12, 0)), ours: an olive tube with a grip.
  function paintLauncher() {
    const c = mk(9, 18), g = c.getContext('2d');
    const r = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x, y, w, h); };
    r(1, 0, 5, 18, '#556b3a'); r(1, 0, 5, 1, '#6f8a4c'); r(5, 0, 1, 18, '#3f5029');
    r(0, 0, 7, 2, '#3a3f45'); r(0, 16, 7, 2, '#3a3f45');
    r(6, 6, 3, 2, '#2a2a30'); r(7, 8, 2, 3, '#2a2a30');
    r(2, 3, 2, 3, '#1d1d22'); r(2, 3, 1, 1, '#7fd3ff');
    return c;
  }
  // The athlete's sneaker (T: Player AthleteShoe, 18 x 6 at 2 px over the feet): ours, white with a green flash.
  function paintShoe() {
    const c = mk(18, 6), g = c.getContext('2d');
    g.fillStyle = '#f7f7f7'; g.fillRect(0, 1, 18, 4);
    g.fillStyle = '#3fd16b'; g.fillRect(4, 2, 9, 1);
    g.fillStyle = '#d9d9d9'; g.fillRect(0, 5, 18, 1);
    g.fillStyle = '#ffffff'; g.fillRect(2, 0, 10, 1);
    return c;
  }

  function create() {
    const city = paintCity(), building = paintBuilding();
    const bodies = CAST.map(o => [RED, BLUE].map(T => { const c = mk(30, 72); person(c.getContext('2d'), o, T); return c; }));
    const armsImg = CAST.map(paintArm);
    const guns = [paintGun(false), paintGun(true)];
    const shoe = paintShoe();
    const launcher = paintLauncher();
    let clouds = [], drops = [], waterT = 0, flash = 0;

    function newRound() {
      // S: ObjectSpawner prewarm: 3 to 8 clouds anywhere along the strip, moving 25-60 px/s, 1-2 x 1-1.4 of 25 px.
      clouds = [];
      const n = 3 + Math.floor(Math.random() * 5);
      for (let i = 0; i < n; i++) clouds.push(cloud(true));
      drops = [];
      for (let i = 0; i < 40; i++) drops.push({ x: (Math.random() * 2 - 1) * 1000, y: -500 + Math.random() * 1600, s: 13 * (1 - Math.random() * 0.6) });
    }
    function cloud(pre) {
      const y = -100 + Math.random() * 200, depth = (y + 100) / 200 * 0.25 + 1;
      const x = pre ? (Math.random() * 2 - 1) * 1500 : (Math.random() < 0.5 ? -1 : 1) * 1500;
      const dir = (pre ? Math.random() > 0.5 : x < 0) ? 1 : -1;
      return { x, y, v: (25 + Math.random() * 35) * dir * depth, w: 25 * (1 + Math.random()) * depth, h: 25 * (1 + Math.random() * 0.4) * depth, next: 0 };
    }
    let cloudWait = 6;
    function tick(dt) {
      for (const c of clouds) c.x += c.v * dt;
      clouds = clouds.filter(c => Math.abs(c.x) <= 1500 || (c.x > 0) !== (c.v > 0));
      cloudWait -= dt;
      if (cloudWait <= 0) { clouds.push(cloud(false)); cloudWait = 5 + Math.random() * 3; }
      waterT += dt;
      for (const d of drops) { d.x += 500 * 0.7071 * dt; d.y += (500 * 0.7071 + 250 * dt) * dt; if (d.y > 1100) { d.y -= 1600; d.x = (Math.random() * 2 - 1) * 1000; } }
      flash = (flash + dt) % 8;
    }

    /* The parallax strip (T: DefualtMap ParallaxBackground, scroll_base_offset (0, 1250), y limits -2000 .. 1000,
       zoom ignored): where a layer with motion m sits on screen for this camera. */
    function layerAt(cam, bw, bh, m, oy) {
      const ox = -cam.x / cam.z + bw / 2;
      let ofy = 1250 + (-cam.y / cam.z + bh / 2);
      let n = -ofy;
      if (n < -2000) n = -2000; else if (n + bh > 1000) n = 1000 - bh;
      ofy = -n;
      return [bw / 2 + (ox - bw / 2) * m, bh / 2 + (ofy - bh / 2) * m + (oy || 0)];
    }

    function world(g, s) {
      const { cam, bw, bh } = s;
      g.imageSmoothingEnabled = false;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.fillStyle = SKY; g.fillRect(0, 0, bw, bh);
      // clouds (m 0.02, at -250)
      const [cx, cy] = layerAt(cam, bw, bh, 0.02, -250);
      g.fillStyle = CLOUD;
      for (const c of clouds) g.fillRect(Math.round(cx + c.x - c.w / 2), Math.round(cy + c.y - c.h / 2), Math.round(c.w), Math.round(c.h));
      // the city, the water under it and its reflection (m 0.1)
      const [lx, ly] = layerAt(cam, bw, bh, 0.1, 0);
      const cityX = Math.round(lx - 0.95 - 320), cityY = Math.round(ly - 239.67 - 160);
      g.globalAlpha = 1;
      for (const k of [-1, 0, 1]) g.drawImage(city, cityX + k * 640, cityY, 640, 320);
      g.fillStyle = 'rgba(223,234,255,0.0)';
      const wy = Math.round(ly + 882.4 - 962);
      g.fillStyle = WATER; g.fillRect(0, wy, bw, bh - wy);
      g.save(); g.globalAlpha = 0.36; g.translate(0, Math.round(ly + 79.34 + 160)); g.scale(1, -1);
      for (const k of [-1, 0, 1]) g.drawImage(city, cityX + k * 640, 0, 640, 320);
      g.restore();
      g.fillStyle = 'rgba(255,195,195,0.10)'; g.fillRect(0, wy, bw, 320);
      // ripples on the water (T: WaterTexture, scrolling 15 px/s)
      g.fillStyle = 'rgba(255,255,255,0.22)';
      for (let i = 0; i < 26; i++) {
        const rx = ((hash(i * 9 + 1) * 1600 - waterT * 15) % 1600 + 1600) % 1600 - 300, ry = wy + 6 + Math.floor(hash(i * 5 + 3) * 300);
        g.fillRect(Math.round(lx - bw / 2 + rx), ry, 20 + Math.floor(hash(i) * 30), 3);
      }
      if (s.mods && s.mods[3] === 1) { g.fillStyle = 'rgba(149,151,165,0.302)'; g.fillRect(0, 0, bw, bh); }

      // the world, through the camera
      const z = cam.z;
      g.setTransform(1 / z, 0, 0, 1 / z, bw / 2 - cam.x / z, bh / 2 - cam.y / z);
      // the street far below (T: Backdrop, Ground): only seen when the camera follows a fall
      g.fillStyle = '#464646'; g.fillRect(-7500, 1176, 15000, 48);
      g.fillStyle = '#8b8b8b'; g.fillRect(-7500, 1212, 15000, 8);
      g.fillStyle = '#5c5c5c'; g.fillRect(-7500, 1225, 15000, 200);
      g.fillStyle = '#3b2920'; g.fillRect(-3724, 252, 1056, 1200); g.fillRect(2797, 252, 797, 1200);
      // bodies (z 0), rifles (z 1), arms (z 2): the reference sorts by z across both players
      const P = s.players, ch = s.chars;
      for (const p of P) drawBody(g, p, ch[p.side] | 0, s);
      for (const p of P) drawArm(g, p, ch[p.side] | 0, s, true);
      for (const p of P) drawArm(g, p, ch[p.side] | 0, s, false);
      // tracers and sparks (the scene's own children, drawn last of z 0, but the arms sit over them only by a hair)
      for (const t of s.tracers) {
        const age = (s.now - t.t0) / 1000 * s.ts;
        if (age > 0.5) continue;
        const a = 0.588 * (1 - age / 0.5);
        g.strokeStyle = t.strong ? 'rgba(17,211,111,' + a + ')' : 'rgba(255,255,255,' + a + ')';
        g.lineWidth = 6; g.lineCap = 'butt';
        g.beginPath(); g.moveTo(t.fx, t.fy); g.lineTo(t.hx, t.hy); g.stroke();
      }
      for (const r of s.rockets || []) {
        g.save(); g.translate(r.x, r.y); g.rotate(r.a);
        // ours: a little grey missile, nose to the left of its own frame (it flies along -x), red tip, two fins
        g.fillStyle = '#5b6168'; g.fillRect(-14, -5, 26, 10);
        g.fillStyle = '#8a9099'; g.fillRect(-14, -5, 26, 3);
        g.fillStyle = '#d23a2a'; g.fillRect(-18, -4, 4, 8);
        g.fillStyle = '#3a3f45'; g.fillRect(8, -9, 6, 4); g.fillRect(8, 5, 6, 4);
        g.fillStyle = 'rgba(255,190,80,0.85)'; g.fillRect(12, -3, 6, 6);
        g.restore();
      }
      for (const sp of s.sparks) {
        const u = sp.t / sp.life, k = u < 0.127 ? u / 0.127 : 1 - (u - 0.127) / 0.873;
        const sz = Math.max(1, sp.size * k);
        if (sp.fire) g.fillStyle = u < 0.25 ? '#fff3b0' : u < 0.55 ? '#ffb030' : 'rgba(110,100,95,0.7)';
        else g.fillStyle = u < 0.5 ? '#ec4444' : 'rgba(161,44,44,0.84)';
        g.fillRect(Math.round(sp.x - sz / 2), Math.round(sp.y - sz / 2), Math.round(sz), Math.round(sz));
      }
      // the building over everything (T: BuildingSprite z_index 4): 1280 x 1280, centred on (0, 590)
      g.drawImage(building, -640, -50, 1280, 1280);
      if (s.mods && s.mods[3] === 1) rain(g, s);
      g.setTransform(1, 0, 0, 1, 0, 0);
      if (s.mods && s.mods[3] === 1) {
        // T: Rain DarkFront (0.184, 0.188, 0.224, 0.196) over everything, and the storm's flicker
        g.fillStyle = 'rgba(47,48,57,0.196)'; g.fillRect(0, 0, bw, bh);
        if ((flash > 3 && flash < 3.4) || (flash > 6 && flash < 6.4)) { g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(0, 0, bw, bh); }
      }
    }
    function rain(g, s) {
      g.fillStyle = '#2448e6';
      const ox = s.cam.x, oy = s.cam.y - 150;
      for (const d of drops) g.fillRect(Math.round(ox + d.x), Math.round(oy + d.y), Math.round(d.s * 0.35), Math.round(d.s));
    }

    function bodyXf(g, p, s) {
      const { cam, bw, bh } = s;
      g.setTransform(1 / cam.z, 0, 0, 1 / cam.z, bw / 2 - cam.x / cam.z, bh / 2 - cam.y / cam.z);
      g.translate(p.x, p.y);
      g.rotate(p.a);
    }
    function drawBody(g, p, c, s) {
      g.save();
      bodyXf(g, p, s);
      g.scale(p.sx, 1);
      g.drawImage(bodies[c][p.side], -4 - 30, -44 - 72, 60, 144);
      if (s.mods && s.mods[4] === 1) { g.scale(-1, 1); g.drawImage(shoe, 4 - 18, 22 - 6, 36, 12); }
      g.restore();
    }
    // The arm swings round its pin; `gun` draws the rifle pass, else the arm pass.
    function drawArm(g, p, c, s, gun) {
      g.save();
      const { cam, bw, bh } = s;
      g.setTransform(1 / cam.z, 0, 0, 1 / cam.z, bw / 2 - cam.x / cam.z, bh / 2 - cam.y / cam.z);
      const ca = Math.cos(p.a), sa = Math.sin(p.a);
      g.translate(p.x + 58 * sa, p.y - 58 * ca);          // the pin, 58 above the origin in the body's frame
      g.rotate(p.armA);
      // T: the Shoot animation: the arm graphic jumps 6 px back along the arm and returns over a third of a second
      let kick = 0;
      if (p.kick > 0) {
        const t = (s.now - p.kick) / 1000 * s.ts;
        if (t < 0.0667) kick = -6 * (t / 0.0667); else if (t < 0.3333) kick = -6 * (1 - (t - 0.0667) / 0.2667);
      }
      g.translate(0, 14 + kick);
      g.scale(p.sx, 1);
      if (gun && s.mods && s.mods[1] === 2) g.drawImage(launcher, -30, -16, 36, 72);
      else if (gun) g.drawImage(guns[s.mods && s.mods[1] === 1 ? 1 : 0], -12, 10, 24, 68);
      else g.drawImage(armsImg[c], -6, -19, 12, 44);
      g.restore();
    }

    /* ── the HUD, in base pixels ── */
    const ease = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u);
    const sine = (u) => 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, u)));
    const quint = (u) => { u = Math.max(0, Math.min(1, u)); return u < 0.5 ? 16 * u * u * u * u * u : 1 - Math.pow(-2 * u + 2, 5) / 2; };
    function hud(g, h) {
      g.setTransform(1, 0, 0, 1, 0, 0);
      const { bw, bh, now } = h;
      const mid = bw / 2;
      // the score (T: GameCanvas/Score, size 70, outline 6: red number, white "To", blue number)
      F.runs(g, [[String(h.score[0]), '#ff0000'], [' To ', '#ffffff'], [String(h.score[1]), '#0000ff']], mid, 44, 70, { outline: 6, bold: true });
      // the round's label slides down from behind the top after half a second (T: Customization, 0.2 s, delay 0.5)
      // and back up when the point is given
      let ly = -90;
      const since = (now - (h.first ? h.goAt : h.labelAt)) / 1000;
      if (since >= 0.5) ly = -90 + 200 * ease((since - 0.5) / 0.2);
      if (h.pointAt > 0 && now >= h.pointAt) ly = 110 - 200 * ease((now - h.pointAt) / 1000 / 0.2);
      if (ly > -60) F.center(g, h.label, mid, ly, 30, { outline: 4, shadow: [1, 1, '#000'], color: '#ffffff' });
      // the pause button (T: TopBar/PauseButton, "||" size 70)
      if (h.pause) F.center(g, '||', 36, 45, 70, { outline: 4, color: '#ffffff' });
      // "Play up to 5" on the first round, "Match Point" when somebody is one away (T: BottomMessage)
      const goSince = (now - h.goAt) / 1000;
      if (h.first && h.goAt > 0 && goSince >= 0 && goSince < 3) {
        const y = bh + 100 - 200 * ease(goSince / 0.2) + 32;
        const x = goSince < 2 ? mid : mid + (2143) * quint((goSince - 2) / 0.5);
        F.center(g, 'Play up to ' + h.playTo, x, y, 30, { outline: 3, shadow: [2, 2, '#000'] });
      }
      const rSince = (now - h.roundAt) / 1000;
      if (h.matchPoint && !h.first && rSince >= 0 && rSince < 3) {
        const y = bh + 100 - 200 * ease(rSince / 0.2) + 45;
        const x = rSince < 2 ? mid : mid + 2149 * quint((rSince - 2) / 0.5);
        F.center(g, 'Match Point', x, y, 45, { outline: 6, color: '#1dd13c', shadow: [0, 2, '#000'] });
      }
      // "Point Blue" / "Point Red", wobbling side to side (T: PointText, size 60, sine 0.35 s each way)
      if (h.pointAt > 0 && now >= h.pointAt) {
        const t = (now - h.pointAt) / 1000, u = (t % 0.7) / 0.35;
        const dx = u <= 1 ? -20 + 40 * sine(u) : 20 - 40 * sine(u - 1);
        const blue = h.pointSide === 1;
        F.center(g, blue ? 'Point Blue' : 'Point Red', mid + dx, bh / 2 - 94, 60, {
          outline: 7, color: blue ? '#0000ff' : '#ff0000', shadow: [3, 3, blue ? '#1c4b8d' : '#8d1c1c'] });
      }
      // the end: "Red Wins!" / "Blue Wins!" (T: GameoverMenu/WinText) before the result card
      if (h.endAt > 0 && now >= h.endAt && h.winner >= 0) {
        F.center(g, h.winner === 1 ? 'Blue Wins!' : 'Red Wins!', mid, bh / 2 - 60, 70, { outline: 6, color: h.winner === 1 ? '#3b6dff' : '#ff3b3b' });
      }
      if (h.timeUpAt > 0 && now >= h.timeUpAt) F.center(g, 'Time up', mid, bh / 2 - 60, 70, { outline: 6, color: '#ffd23f' });
      if (h.ready) readyUp(g, h);
      if (h.buttons) buttons(g, h);
    }
    // T: ReadyUpMenu: a dark veil, "Ready Up", how to play, and READY by each side once its jump is pressed.
    function readyUp(g, h) {
      const { bw, bh } = h, mid = bw / 2;
      g.fillStyle = 'rgba(0,0,0,0.443)'; g.fillRect(0, 0, bw, bh);
      F.center(g, 'Ready Up', mid, 116, 40, { outline: 5, shadow: [2, 2, '#000'] });
      F.center(g, 'Press JUMP button to ready up', mid, 150, 30, { outline: 3, color: '#eff608', shadow: [2, 2, '#000'] });
      F.center(g, 'Controls', mid, bh / 2 - 72, 40, { outline: 4, color: '#3cf768', shadow: [2, 2, '#000'] });
      F.center(g, 'Jump to dodge', mid, bh / 2 - 34, 30, { outline: 3 });
      F.center(g, 'Hold shoot to raise weapon', mid, bh / 2 - 6, 30, { outline: 3 });
      F.center(g, 'Let go to shoot', mid, bh / 2 + 22, 30, { outline: 3 });
      F.center(g, 'Objective', mid, bh / 2 + 84, 40, { outline: 4, color: '#5af781', shadow: [2, 2, '#000'] });
      F.center(g, 'Push opponent OFF', mid, bh / 2 + 120, 30, { outline: 3 });
      if (h.readyMs > 0) F.center(g, 'Starts in ' + Math.ceil(h.readyMs / 1000), mid, bh / 2 + 160, 25, { outline: 3, color: '#cccccc' });
      // READY by each player's side of the bottom (T: ReadyIcons)
      for (let s = 0; s < 2; s++) {
        if (!h.readyFlags[s]) continue;
        const x = s === 0 ? 233 : bw - 233;
        F.center(g, 'READY', x, bh - 174, 40, { outline: 4, color: s === 0 ? '#ff5252' : '#5b8dff' });
      }
    }
    // T: PlayerButtons/1Player: a jump button bottom left and a shoot button bottom right, 150 x 100, the seat's
    // colour; on a computer the key letter with its name above, on a phone the name inside.
    function buttons(g, h) {
      const B = h.buttons;
      const col = h.mySeat === 1 ? ['#5279f7', '#6989fa'] : ['#f75252', '#fa6969'];
      const one = (b, key, name, down, k) => {
        const y = b.y + (down ? 4 : 0);
        g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(b.x + 3, b.y + 6, b.w, b.h);
        g.fillStyle = shade(col[k], -0.25); g.fillRect(b.x, y, b.w, b.h);
        g.fillStyle = down ? shade(col[k], -0.08) : col[k]; g.fillRect(b.x + 4, y + 4, b.w - 8, b.h - 10);
        g.fillStyle = 'rgba(255,255,255,0.25)'; g.fillRect(b.x + 4, y + 4, b.w - 8, 6);
        if (h.touch) F.center(g, name, b.x + b.w / 2, y + b.h / 2, 30, { outline: 3 });
        else {
          F.center(g, key, b.x + b.w / 2, y + b.h / 2, 50, { outline: 0, color: '#ffffff' });
          F.center(g, name, b.x + b.w / 2, b.y - 22, 30, { outline: 3 });
        }
      };
      one(B.J, 'W', 'Jump', h.pressed.J, 0);
      one(B.S, 'E', 'Shoot', h.pressed.S, 1);
    }

    return { world, hud, tick, newRound, CAST };
  }

  root.RTArt = { create, CAST_COUNT: CAST.length };
})(window);
