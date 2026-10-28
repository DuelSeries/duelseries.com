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
    /* A: the reference's strip keeps its buildings low (most 10 to 20 squares of its 50, the tallest about 30), in two
       overlapping rows, pale, with a one-square lighter rim and tiny windows. Ours follows those proportions. */
    const row = (seed, hMin, hMax, wMin, wMax) => {
      let x = -2, k = 0;
      while (x < 100) {
        const w = wMin + Math.floor(hash(seed + k * 7 + 1) * (wMax - wMin + 1));
        const h = hMin + Math.floor(hash(seed + k * 13 + 5) * (hMax - hMin + 1));
        const f = fills[Math.floor(hash(seed + k * 3 + 2) * fills.length)];
        const top = 50 - h;
        g.fillStyle = edge; g.fillRect(x, top, w, h);
        g.fillStyle = f; g.fillRect(x + 1, top + 1, w - 2, h - 1);
        g.fillStyle = hash(seed + k * 5 + 9) > 0.5 ? '#f8f2d6' : '#e6eeea';
        if (hash(seed + k * 19 + 4) > 0.35) for (let wy = top + 3; wy < 47; wy += 4) for (let wx = x + 2; wx < x + w - 2; wx += 3) g.fillRect(wx, wy, 1, 2);
        x += w + (hash(seed + k * 17) > 0.75 ? 2 : 0);
        k++;
      }
    };
    row(101, 16, 30, 7, 10);      // the back row, taller
    row(7, 8, 18, 6, 9);          // the front row, low
    // T: CityLayer/City self_modulate (0.8745, 0.9176, 1): the strip is drawn tinted toward the sky
    const d = g.getImageData(0, 0, 100, 50);
    for (let i = 0; i < d.data.length; i += 4) { d.data[i] = Math.round(d.data[i] * 0.8745); d.data[i + 1] = Math.round(d.data[i + 1] * 0.9176); }
    g.putImageData(d, 0, 0);
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

  /* One sniper standing still, for the lobby's Customize (public/js/v2/shopArt.js, the free looks of
     shared/rtLooks.js): the same body, arm and rifle the match draws, put together where the match puts them at rest
     (body 44 px above its origin and 4 px behind it, the arm from its pin 58 px up, the rifle hanging from the hand),
     in base pixels, facing left like the sprites. 60 x 150, cached per sniper and team. */
  const POSES = {};
  const CAST_INDEX = (name) => CAST.findIndex(o => o.name === name);
  function pose(name, side) {
    const i = CAST_INDEX(name), s = side === 1 ? 1 : 0;
    if (i < 0) return null;
    const key = name + s;
    if (POSES[key]) return POSES[key];
    const body = mk(30, 72);
    person(body.getContext('2d'), CAST[i], s === 1 ? BLUE : RED);
    const c = mk(60, 150), g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(body, 0, 0, 60, 144);                     // body: (-34, -116) from the origin at (34, 116)
    g.drawImage(paintGun(false), 22, 82, 24, 68);          // rifle: (-12, 10) from the hand, 14 under the pin
    g.drawImage(paintArm(CAST[i]), 28, 53, 12, 44);        // arm: (-6, -19) from the same point
    return (POSES[key] = c);
  }

  /* ── the round modifiers' sprites (the maps, the tomahawk, the falling things): ours, square by square, laid out
     where the reference's sit and in its colours (A: its textures measured for size, layout and palette only) ── */
  const CIV = '#ab9b19';      // T: CharacterMat shader_param/new (0.671, 0.608, 0.098): a civilian wears no team colour
  const sq = (g) => (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x, y, w, h); };

  // The tomahawk: 14 x 10 squares at 4 px (T: Tomahawk Sprite at (-12, 0) from the hand, TomahawkRigid's at (8, 0)):
  // the steel head on the left with its bright edge at the bottom, the handle along the middle to the right, in the
  // team's colour where the reference marks it (red #e62828, blue #2850e6).
  function paintTomahawk(side) {
    const c = mk(14, 10), r = sq(c.getContext('2d'));
    const T = side === 1 ? ['#2850e6', '#344da7'] : ['#e62828', '#a73434'];
    r(3, 0, 1, 1, '#e9f1fb');
    r(2, 1, 3, 6, '#2d3138'); r(4, 1, 1, 6, '#292b2e');
    r(3, 2, 1, 1, T[0]); r(3, 5, 1, 1, T[1]);
    r(1, 6, 5, 1, '#2d3138'); r(0, 7, 7, 2, '#34383f'); r(5, 7, 2, 2, '#292b2e'); r(0, 7, 1, 1, '#232527');
    r(0, 9, 4, 1, '#e9f1fb'); r(4, 9, 3, 1, '#e1e4e8');
    r(5, 4, 9, 1, '#7a4a24'); r(5, 5, 8, 1, '#4f2f16');
    r(8, 4, 1, 2, T[0]); r(11, 4, 1, 2, T[0]); r(13, 4, 1, 1, T[1]);
    return c;
  }
  // The beach ball: 20 x 20 squares at 4 px (T: BeachBall Sprite scale 4, radius 40): white with a red, a cyan and a
  // yellow panel (A: #ca2626, #25d7dd, #ddd225), shaded #eaeaea on its lower right. Ours: three swirled panels.
  function paintBall() {
    const c = mk(20, 20), r = sq(c.getContext('2d'));
    const cols = ['#ca2626', '#ffffff', '#25d7dd', '#ffffff', '#ddd225', '#ffffff'];
    for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) {
      const dx = x - 9.5, dy = y - 9.5, d = Math.sqrt(dx * dx + dy * dy);
      if (d > 10) continue;
      let ang = Math.atan2(dy, dx) + d * 0.09 + Math.PI;
      const k = Math.floor(ang / (Math.PI / 3)) % 6;
      let col = d < 1.6 ? '#ffffff' : cols[k];
      if (col === '#ffffff' && dx + dy > 9 && d > 7) col = '#eaeaea';
      r(x, y, 1, 1, col);
    }
    return c;
  }
  // The Elevator's brick housing: 20 x 21 squares at 12.8 px (T: Elevator Sprite (0, -180), region 23 x 22 offset by
  // half a square, its opaque part x -128..128, y -314.4..-45.6): a grey cap of three rows, then red bricks.
  function paintLift() {
    const c = mk(20, 21), r = sq(c.getContext('2d'));
    const reds = ['#985f5f', '#894747', '#955050', '#944040', '#ad4d4d', '#a73d3d', '#753333', '#a05050', '#8d2828',
      '#9a5252', '#9c3a3a', '#a93b3b', '#7a4b4b', '#a15d5d', '#9a2525', '#8b2f2f', '#a33e3e', '#955a5a'];
    r(0, 0, 20, 1, '#777777'); r(0, 1, 20, 2, '#858585'); r(0, 2, 20, 1, '#7d7d7d');
    for (let y = 3; y < 21; y++) for (let x = -(y % 2) * 2; x < 20; x += 3) r(x, y, 3, 1, reds[Math.floor(hash(y * 37 + x * 11 + 5) * reds.length)]);
    return c;
  }
  // The car: 20 x 18 squares at 12.8 px (T: ElevatorShaft/Elevator2 at (0, 1.5) under the 12.8 scale): grey steel
  // (A: #5c5c5c, #515151, #4e4e4e), a lamp at the top (#b7b49f, #918d69). Ours: three panels with seams and rivets.
  function paintCab() {
    const c = mk(20, 18), r = sq(c.getContext('2d'));
    r(0, 0, 20, 18, '#5c5c5c'); r(0, 0, 20, 1, '#4e4e4e'); r(0, 17, 20, 1, '#4e4e4e');
    for (const x of [0, 6, 13, 19]) r(x, 1, 1, 16, '#515151');
    for (const x of [2, 4, 9, 10, 15, 17]) { r(x, 3, 1, 1, '#515151'); r(x, 14, 1, 1, '#515151'); }
    r(8, 1, 4, 1, '#69685f'); r(8, 2, 4, 1, '#918d69'); r(9, 2, 2, 1, '#b7b49f'); r(9, 3, 2, 1, '#918d69');
    return c;
  }
  /* The House: 121 x 50 squares at 9.6 px (T: House/Sprite at (-4.5, 0) from (0, 74.8837), region 121 x 50): a
     steep gable with a window in the middle, a grey roof band the full width, white-and-blue siding walls with two
     windows and a door (A: roof #afbab9, trim #ffffff, wall #e3f0f1, wood #a79770, glass #aac9cb, knob #d4d384).
     Ours: board-and-batten siding, cross-barred windows, a panelled door with a light. */
  function paintHouse() {
    const c = mk(121, 50), r = sq(c.getContext('2d'));
    const ROOF = '#afbab9', TRIM = '#ffffff', WALL = '#e3f0f1', WOOD = '#a79770', GLASS = '#aac9cb';
    for (let y = 0; y < 16; y++) {
      const L = 60 - y, W = 2 * y + 2;
      r(L, y, W, 1, ROOF);
      if (W > 6) r(L + 3, y, W - 6, 1, TRIM);
      if (W > 8) r(L + 4, y, W - 8, 1, WALL);
    }
    const win = (x, y, w, h) => {
      r(x - 1, y - 1, w + 2, h + 2, TRIM); r(x, y, w, h, WOOD); r(x + 1, y + 1, w - 2, h - 2, GLASS);
      r(x + (w >> 1), y + 1, 1, h - 2, WOOD); r(x + 1, y + (h >> 1), w - 2, 1, WOOD);
    };
    win(57, 11, 7, 6);
    // the roof band, as wide each side as the mirrored collision (Owen 2026-10-28): the flat roof -556.5 / 557.1 over
    // -+556.6, the eave -566.1 / 566.7 over its tips at -+565.7 (the reference's started a square further left)
    r(3, 16, 116, 1, ROOF); r(2, 17, 118, 1, ROOF); r(1, 18, 120, 1, ROOF); r(2, 19, 118, 1, ROOF);
    r(11, 20, 100, 30, WALL); r(11, 20, 100, 1, TRIM);
    for (let x = 11; x < 111; x += 5) r(x, 21, 1, 29, TRIM);
    r(110, 21, 1, 29, TRIM);
    win(20, 31, 9, 12); win(92, 31, 9, 12);
    r(55, 36, 10, 14, WOOD); r(54, 35, 12, 1, TRIM); r(54, 36, 1, 14, TRIM); r(65, 36, 1, 14, TRIM);
    r(57, 38, 6, 3, GLASS); r(57, 43, 2, 5, '#968862'); r(61, 43, 2, 5, '#968862'); r(63, 43, 1, 1, '#d4d384');
    return c;
  }
  /* The Cabin: 116 x 51 squares at 9.6 px (T: Cabin/Sprite at (0, 9.6) from (0, 74.8837), region 116 x 51): a snowed
     roof, steep over the middle and shallow over the eaves, three tall gable windows, log walls between corner
     posts and two big glazed doors (A: snow #ffffff #fafbfc #f1f4f6 #e5eaed, logs #423225 #615245 #4a3829, posts
     #635042 #483b31 #392b20 #36281e #4b3a2c, glass #31302f in #817d7a frames). Ours, log by log. */
  function paintCabin() {
    const c = mk(116, 51), r = sq(c.getContext('2d'));
    const LOGS = ['#423225', '#615245', '#4a3829'], POST = ['#635042', '#483b31', '#392b20', '#36281e', '#4b3a2c'];
    const FRAME = '#817d7a', GL = '#31302f';
    // the steep roof's outer edge row by row (the peak at 57.5), then the eaves the full width, both sides alike
    // (-+556.8 under the mirrored collision's -+558.8, Owen 2026-10-28; they once stopped a square short on the right)
    const half = (y) => y <= 8 ? 1.5 + y * 2.4 : y === 9 ? 39.5 : y === 10 ? 52 : 57.5;
    for (let y = 0; y < 21; y++) {
      const h = half(y), eave = y > 10, L = eave ? 0 : Math.round(57.5 - h), Rr = eave ? 116 : Math.round(57.5 + h);
      r(L, y, Rr - L, 1, y >= 8 ? '#f1f4f6' : '#fafbfc');
    }
    r(1, 20, 114, 1, '#e5eaed');
    // the gable wall inside the steep snow band, in logs, and its three windows
    for (let y = 4; y < 21; y++) {
      const inner = Math.max(0, (y - 3) * 2.4 - 1), L = Math.round(57.5 - inner), Rr = Math.round(57.5 + inner);
      if (Rr > L) r(L, y, Rr - L, 1, LOGS[y % 3]);
      r(L - 2, y, 2, 1, '#fafbfc'); r(Rr, y, 2, 1, '#fafbfc');
      r(L - 3, y, 1, 1, '#ffffff'); r(Rr + 2, y, 1, 1, '#ffffff');
    }
    for (let y = 0; y < 8; y++) { const h = half(y); r(Math.round(57.5 - h), y, 2, 1, '#ffffff'); r(Math.round(57.5 + h) - 2, y, 2, 1, '#ffffff'); }
    const pane = (x, y, w, h) => { r(x, y, w, h, FRAME); r(x + 1, y + 1, w - 2, h - 2, GL); };
    pane(41, 9, 9, 13); pane(50, 6, 16, 16); pane(66, 9, 9, 13);
    r(57, 7, 2, 15, FRAME); r(51, 14, 14, 1, FRAME);
    // the walls: logs between the corner posts, the log ends stacked in the posts
    for (let y = 21; y < 49; y++) {
      r(11, y, 94, 1, LOGS[y % 3]);
      r(3, y, 8, 1, POST[(y + 1) % 5]); r(105, y, 8, 1, POST[(y + 3) % 5]);
      if (y % 3 === 1) { r(4, y, 2, 1, '#36281e'); r(110, y, 2, 1, '#36281e'); }
    }
    for (let y = 21; y < 49; y += 3) for (let x = 14; x < 104; x += 13) r(x + (y % 2) * 5, y + 1, 2, 1, '#36281e');
    r(11, 49, 94, 1, LOGS[1]); r(12, 50, 92, 1, LOGS[2]);
    // the glazed doors, two pairs
    for (const x0 of [40, 59]) { pane(x0, 32, 17, 19); r(x0 + 8, 32, 1, 19, FRAME); r(x0 + 1, 41, 15, 1, FRAME); }
    return c;
  }
  /* The Blimp: 158 x 62 squares at 12.8 px (T: Blimp/Sprite at (0, 374.567), region 158 x 62): a long white envelope
     shading to grey towards its lower right (A: #ffffff to #ededed), a grey tail fin (#d0d0d0) on the left, and the
     gondola under the middle with four blue windows (#398ab0). Ours: dithered by our own pattern. */
  function paintBlimp() {
    const c = mk(158, 62), r = sq(c.getContext('2d'));
    const greys = ['#ffffff', '#fcfcfc', '#f9f9f9', '#f6f6f6', '#f3f3f3', '#f0f0f0', '#ededed'];
    for (let y = 0; y < 46; y++) {
      const v = (y - 22.5) / 23.2, w = Math.sqrt(Math.max(0, 1 - v * v)) * 79.2;
      const L = Math.max(0, Math.round(78.5 - w)), Rr = Math.min(158, Math.round(78.5 + w));
      for (let x = L; x < Rr; x++) {
        const u = (x / 157) * 0.55 + (y / 45) * 0.45 + (hash(x * 131 + y * 7) - 0.5) * 0.12;
        r(x, y, 1, 1, greys[Math.max(0, Math.min(6, Math.floor(u * 7)))]);
      }
    }
    for (let y = 18; y < 24; y++) r(4 + (y - 18), y, 18 + (y - 18) * 3 - Math.max(0, y - 22) * 14, 1, '#d0d0d0');
    for (let y = 46; y < 62; y++) {
      const inset = y > 59 ? y - 59 : 0;
      r(55 + inset, y, 44 - 2 * inset, 1, y < 56 ? '#f4f4f4' : greys[Math.min(6, 2 + (y - 56))]);
    }
    for (const [x, w] of [[64, 7], [72, 9], [82, 8], [91, 7]]) { r(x, 46, w, 10, '#398ab0'); r(x + 1, 47, 1, 2, '#6fb3d3'); }
    return c;
  }
  // The far mountains (T: Cabin ParallaxLayer, MountainsBackground 100 x 50 and MountainEndBackground 50 x 50 at 3.2,
  // modulated (0.871, 0.875, 0.898)): slate (#575668) with lit faces (#6f6e82) and snow tops (#dadadd, #efefef). Ours.
  function paintRange(w, h, top) {
    const c = mk(w, h), r = sq(c.getContext('2d'));
    for (let x = 0; x < w; x++) {
      const t = top(x);
      r(x, t, 1, h - t, '#575668');
      if (t < h - 18) {
        r(x, t, 1, 2 + Math.floor(hash(x * 3 + 1) * 3), hash(x * 7) > 0.5 ? '#dadadd' : '#efefef');
        if (top(x + 1) > t) r(x, t + 4, 1, 3, '#6f6e82');
      }
    }
    const d = c.getContext('2d').getImageData(0, 0, w, h);
    for (let i = 0; i < d.data.length; i += 4) { d.data[i] = Math.round(d.data[i] * 0.8706); d.data[i + 1] = Math.round(d.data[i + 1] * 0.8745); d.data[i + 2] = Math.round(d.data[i + 2] * 0.898); }
    c.getContext('2d').putImageData(d, 0, 0);
    return c;
  }
  const peaks = (x, seed, lo, span) => {
    const k = Math.floor(x / 9), f = (x % 9) / 9;
    const a = lo + hash(k * 17 + seed) * span, b = lo + hash((k + 1) * 17 + seed) * span;
    return Math.round(a + (b - a) * f + Math.abs(f - 0.5) * 4);
  };
  // The near hills (T: Cabin ParallaxLayer2, MountainsCloseBackground 100 x 20 at 3.2 modulated 0.761): white
  // rounded tops ten to fifteen squares down, so #c2c2c2 on screen.
  function paintHills() {
    const c = mk(100, 20), r = sq(c.getContext('2d'));
    for (let x = 0; x < 100; x++) { const t = 10 + Math.round(2.5 + 2.5 * Math.sin(x * 0.19) * Math.cos(x * 0.07)); r(x, t, 1, 20 - t, '#c2c2c2'); }
    return c;
  }
  // The grass far under the Blimp (T: Blimp Ground sprites, GrassGround 240 x 40 at 16 px, five side by side):
  // a pale rim (#74c548, #d2d8c3) over mown stripes (#84d25a, #77b455). Ours: broader stripes.
  function paintGrass() {
    const c = mk(240, 40), r = sq(c.getContext('2d'));
    r(0, 0, 240, 1, '#74c548'); r(0, 1, 240, 1, '#d2d8c3'); r(0, 2, 240, 38, '#84d25a');
    for (let y = 2; y < 38; y++) for (let x = -8; x < 240; x += 8) r(x + (y >> 1) % 8, y, 4, 1, '#77b455');
    return c;
  }

  function create() {
    const city = paintCity(), building = paintBuilding();
    const bodies = CAST.map(o => [RED, BLUE].map(T => { const c = mk(30, 72); person(c.getContext('2d'), o, T); return c; }));
    const armsImg = CAST.map(paintArm);
    const guns = [paintGun(false), paintGun(true)];
    const shoe = paintShoe();
    const launcher = paintLauncher();
    const civBodies = CAST.map(o => { const c = mk(30, 72); person(c.getContext('2d'), o, CIV); return c; });
    const toms = [paintTomahawk(0), paintTomahawk(1)], ball = paintBall();
    const liftHouse = paintLift(), cab = paintCab(), house = paintHouse(), cabin = paintCabin(), blimp = paintBlimp();
    const range = paintRange(100, 50, (x) => peaks(x, 3, 16, 11)), rangeEnd = paintRange(50, 50, (x) => Math.max(peaks(x, 9, 28, 4), 28 + Math.round(x * 0.33)));
    const hills = paintHills(), grass = paintGrass();
    let clouds = [], drops = [], waterT = 0, flash = 0, flakes = [];
    /* Each seat's free look (shared/rtLooks.js), as a CAST index, from the room's players[]; -1 is the round's random
       sniper. A seat without one never wears the other seat's chosen sniper: it takes the next one along. */
    let seatLook = [-1, -1];
    function setLooks(names) {
      seatLook = [0, 1].map(s => (Array.isArray(names) && typeof names[s] === 'string' ? CAST_INDEX(names[s]) : -1));
    }
    function lookOf(side, dealt) {
      const mine = seatLook[side], theirs = seatLook[1 - side];
      if (mine >= 0) return mine;
      return dealt === theirs ? (dealt + 1) % CAST.length : dealt;
    }

    function newRound() {
      // S: ObjectSpawner prewarm: 3 to 8 clouds anywhere along the strip, moving 25-60 px/s, 1-2 x 1-1.4 of 25 px.
      clouds = [];
      const n = 3 + Math.floor(Math.random() * 5);
      for (let i = 0; i < n; i++) clouds.push(cloud(true));
      drops = [];
      for (let i = 0; i < 40; i++) drops.push({ x: (Math.random() * 2 - 1) * 1000, y: -500 + Math.random() * 1600, s: 13 * (1 - Math.random() * 0.6) });
      flakes = [];
      for (let i = 0; i < 40; i++) flakes.push(flake(null, Math.random() * 6));
    }
    /* T: Snow.tscn CPUParticles2D: 40 white squares 13 px (60% random smaller) from a 2000 x 40 strip 650 above the
       camera, 500 px/s along (1, 1) +-20 degrees, gravity 100, damping 52.28 px/s^2, 6 s each. */
    function flake(cam, age) {
      const cx = cam ? cam.x : 0, cy = cam ? cam.y : -150;
      const ang = Math.PI / 4 + (Math.random() * 2 - 1) * 20 * Math.PI / 180;
      const f = { x: cx + (Math.random() * 2 - 1) * 1000, y: cy - 650 + (Math.random() * 2 - 1) * 20, vx: Math.cos(ang) * 500, vy: Math.sin(ang) * 500,
                  s: 13 * (0.4 + 0.6 * Math.random()), t: 0 };
      for (let k = 0; k < Math.round((age || 0) * 30); k++) stepFlake(f, 1 / 30);
      return f;
    }
    function stepFlake(f, dt) {
      f.vy += 100 * dt;
      const v = Math.hypot(f.vx, f.vy), nv = Math.max(0, v - 52.28 * dt);
      if (v > 0) { f.vx *= nv / v; f.vy *= nv / v; }
      f.x += f.vx * dt; f.y += f.vy * dt; f.t += dt;
    }
    function cloud(pre) {
      const y = -100 + Math.random() * 200, depth = (y + 100) / 200 * 0.25 + 1;
      const x = pre ? (Math.random() * 2 - 1) * 1500 : (Math.random() < 0.5 ? -1 : 1) * 1500;
      const dir = (pre ? Math.random() > 0.5 : x < 0) ? 1 : -1;
      return { x, y, v: (25 + Math.random() * 35) * dir * depth, w: 25 * (1 + Math.random()) * depth, h: 25 * (1 + Math.random() * 0.4) * depth, next: 0 };
    }
    let cloudWait = 6;
    function tick(dt, cam) {
      for (let i = 0; i < flakes.length; i++) { stepFlake(flakes[i], dt); if (flakes[i].t >= 6) flakes[i] = flake(cam, 0); }
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
      const map = s.mods ? s.mods[0] | 0 : 0, slip = !!(s.mods && s.mods[3] === 1), snow = slip && map === 4;
      g.imageSmoothingEnabled = false;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.fillStyle = SKY; g.fillRect(0, 0, bw, bh);
      // T: Snow/CanvasLayer/Sky (layer -110, under the parallax): the sky greyed (0.298, 0.345, 0.396, 0.455)
      if (snow) { g.fillStyle = 'rgba(76,88,101,0.455)'; g.fillRect(0, 0, bw, bh); }
      // clouds (m 0.02, at -250)
      const [cx, cy] = layerAt(cam, bw, bh, 0.02, -250);
      g.fillStyle = CLOUD;
      for (const c of clouds) g.fillRect(Math.round(cx + c.x - c.w / 2), Math.round(cy + c.y - c.h / 2), Math.round(c.w), Math.round(c.h));
      if (map === 4) mountains(g, s);
      else cityLayer(g, s);
      if (slip && !snow) { g.fillStyle = 'rgba(149,151,165,0.302)'; g.fillRect(0, 0, bw, bh); }
      // T: Snow DarkBack (0.761, 0.765, 0.788, 0.188) at z -20, over the backdrop and under the world
      if (snow) { g.fillStyle = 'rgba(194,195,201,0.188)'; g.fillRect(0, 0, bw, bh); }
      ground(g, s, map);
      if (snow) {
        g.fillStyle = '#ffffff';
        for (const f of flakes) g.fillRect(Math.round(f.x - f.s / 2), Math.round(f.y - f.s / 2), Math.round(f.s), Math.round(f.s));
      }
      mapParts(g, s, map);
      people(g, s);
      g.setTransform(1, 0, 0, 1, 0, 0);
      if (slip && !snow) {
        // T: Rain DarkFront (0.184, 0.188, 0.224, 0.196) over everything, and the storm's flicker
        g.fillStyle = 'rgba(47,48,57,0.196)'; g.fillRect(0, 0, bw, bh);
        if ((flash > 3 && flash < 3.4) || (flash > 6 && flash < 6.4)) { g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(0, 0, bw, bh); }
      }
      // T: Snow DarkFront (0.549, 0.553, 0.573, 0.11) at z 50
      if (snow) { g.fillStyle = 'rgba(140,141,146,0.11)'; g.fillRect(0, 0, bw, bh); }
    }
    // The city, its water and reflection (T: DefualtMap CityLayer, m 0.1; the Cabin hides it)
    function cityLayer(g, s) {
      const { cam, bw, bh } = s;
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
    }
    /* The Cabin's backdrop (T: Cabin ParallaxLayer m 0.075: three MountainsBackground at x 0, +-320 and the two
       MountainEndBackground at +-560, y -182.6, 3.2 px squares, over a slate fill (0.298, 0.294, 0.365) from y -121.8;
       ParallaxLayer2 m 0.09: eleven MountainsCloseBackground every 320 from -1600 at y -90 over a grey fill
       (0.761) from y -61.4). */
    function mountains(g, s) {
      const { cam, bw, bh } = s;
      const [ax, ay] = layerAt(cam, bw, bh, 0.075, 0);
      g.fillStyle = '#4c4b5d'; g.fillRect(0, Math.round(ay - 121.8), bw, bh);
      for (const k of [-1, 0, 1]) g.drawImage(range, Math.round(ax + k * 320 - 160), Math.round(ay - 182.6 - 80), 320, 160);
      g.save(); g.translate(Math.round(ax - 560), 0); g.scale(-1, 1); g.drawImage(rangeEnd, -80, Math.round(ay - 182.6 - 80), 160, 160); g.restore();
      g.drawImage(rangeEnd, Math.round(ax + 560 - 80), Math.round(ay - 182.6 - 80), 160, 160);
      const [hx, hy] = layerAt(cam, bw, bh, 0.09, 0);
      g.fillStyle = '#c2c2c2'; g.fillRect(0, Math.round(hy - 61.4), bw, bh);
      for (let x = -1600; x <= 1600; x += 320) g.drawImage(hills, Math.round(hx + x - 160), Math.round(hy - 90 - 32), 320, 64);
    }
    // The ground under each map, behind its building (T: each scene's Ground and Backdrop sprites).
    function ground(g, s, map) {
      const { cam, bw, bh } = s, z = cam.z;
      g.setTransform(1 / z, 0, 0, 1 / z, bw / 2 - cam.x / z, bh / 2 - cam.y / z);
      if (map <= 1) {
        // the street far below (T: Backdrop, Ground): only seen when the camera follows a fall
        g.fillStyle = '#464646'; g.fillRect(-7500, 1176, 15000, 48);
        g.fillStyle = '#8b8b8b'; g.fillRect(-7500, 1212, 15000, 8);
        g.fillStyle = '#5c5c5c'; g.fillRect(-7500, 1225, 15000, 200);
        g.fillStyle = '#3b2920'; g.fillRect(-3724, 252, 1056, 1200); g.fillRect(2797, 252, 797, 1200);
      } else if (map === 2) {
        // T: House Backdrop (0.239 from y 277.4, 48 tall; 0.322 from 301.7, 8 tall) and Ground's Concrete2 (64 rows
        // of 10 px from y 309.5: two dark (#5a5a5a), one pale (#e0d1b5), the rest #827d7d)
        g.fillStyle = '#3d3d3d'; g.fillRect(-7500, 277.4, 15000, 48);
        g.fillStyle = '#525252'; g.fillRect(-7500, 301.7, 15000, 8);
        g.fillStyle = '#827d7d'; g.fillRect(-7500, 309.5, 15000, 640);
        g.fillStyle = '#5a5a5a'; g.fillRect(-7500, 309.5, 15000, 20);
        g.fillStyle = '#e0d1b5'; g.fillRect(-7500, 329.5, 15000, 10);
      } else if (map === 3) {
        for (let k = -2; k <= 2; k++) g.drawImage(grass, k * 3840 - 1920, 5120 - 320, 3840, 640);
      } else if (map === 4) {
        // T: Cabin Ground's two snow sheets: (0.882) from y 265.3 and (0.945) from y 285.2, 480 tall
        g.fillStyle = '#e1e1e1'; g.fillRect(-7500, 265.3, 15000, 480);
        g.fillStyle = '#f1f1f1'; g.fillRect(-7500, 285.2, 15000, 480);
      }
    }
    // The map's own building, under the players (z -1 and 0, before them in the scene).
    function mapParts(g, s, map) {
      if (map === 1) {
        // T: the Elevator's housing (z -1), the moving car over it, and the two doors (Blank 2 x 18 at +-9.025,
        // 0.251 grey) while its animation has them shut
        g.drawImage(liftHouse, -128, -314.4, 256, 268.8);
        const ly = typeof s.lift === 'number' ? s.lift : -180;
        g.drawImage(cab, -128, ly + 19.2 - 115.2, 256, 230.4);
        if (s.doors) { g.fillStyle = '#404040'; g.fillRect(-128.32, -276, 25.6, 230.4); g.fillRect(102.72, -276, 25.6, 230.4); }
      } else if (map === 2) g.drawImage(house, -585.3, -165.12, 1161.6, 480);
      else if (map === 3) g.drawImage(blimp, -1011.2, -22.233, 2022.4, 793.6);
      else if (map === 4) g.drawImage(cabin, -556.8, -160.32, 1113.6, 489.6);
    }
    function people(g, s) {
      const P = s.players, ch = s.chars, O = s.objs || [];
      // bodies (z 0), rifles (z 1), arms (z 2): the reference sorts by z across both players; the round's objects
      // come after the players in the scene, so each sits over them within its own z
      for (const p of P) drawBody(g, p, ch[p.side] | 0, s);
      for (const o of O) drawObj(g, o, s, false);
      for (const p of P) drawArm(g, p, ch[p.side] | 0, s, true);
      for (const p of P) drawArm(g, p, ch[p.side] | 0, s, false);
      for (const o of O) if (o.k === 2) drawObj(g, o, s, true);
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
      // the building over everything (T: BuildingSprite z_index 4): 1280 x 1280, centred on (0, 590); the normal map
      // and the Elevator (which inherits it) only
      const map = s.mods ? s.mods[0] | 0 : 0;
      if (map <= 1) g.drawImage(building, -640, -50, 1280, 1280);
      if (s.mods && s.mods[3] === 1 && map !== 4) rain(g, s);
    }
    /* A thrown tomahawk (T: TomahawkRigid Sprite at (8, 0), mirrored when thrown from a mirrored arm), a beach ball
       (80 px round), a civilian (a Character: its body like a player's facing left, its free arm hanging straight
       down from the pin; C: the arm's own body is not simulated, as for the players). arm: the arm pass. */
    function drawObj(g, o, s, arm) {
      const { cam, bw, bh } = s;
      g.save();
      g.setTransform(1 / cam.z, 0, 0, 1 / cam.z, bw / 2 - cam.x / cam.z, bh / 2 - cam.y / cam.z);
      if (o.k === 2 && arm) {
        const c = Math.cos(o.a), sn = Math.sin(o.a);
        g.translate(o.x + 58 * sn, o.y - 58 * c);
        g.translate(0, 14);
        g.drawImage(armsImg[(o.ch | 0) % armsImg.length], -6, -19, 12, 44);
      } else {
        g.translate(o.x, o.y); g.rotate(o.a);
        if (o.k === 1) { if (o.fl) g.scale(1, -1); g.drawImage(toms[o.side === 1 ? 1 : 0], -20, -20, 56, 40); }
        else if (o.k === 3) g.drawImage(ball, -40, -40, 80, 80);
        else if (o.k === 2) g.drawImage(civBodies[(o.ch | 0) % civBodies.length], -4 - 30, -44 - 72, 60, 144);
      }
      g.restore();
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
      g.drawImage(bodies[lookOf(p.side, c)][p.side], -4 - 30, -44 - 72, 60, 144);
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
      // T: Tomahawk Sprite at (-12, 0) from the hand; S: hidden from the throw until the reload
      else if (gun && s.mods && s.mods[1] === 3) { if (p.reloaded !== false) g.drawImage(toms[p.side === 1 ? 1 : 0], -40, 0, 56, 40); }
      else if (gun) g.drawImage(guns[s.mods && s.mods[1] === 1 ? 1 : 0], -12, 10, 24, 68);
      else g.drawImage(armsImg[lookOf(p.side, c)], -6, -19, 12, 44);
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
      // each seat's name above its sniper (ours: the reference's players are only Red and Blue)
      if (h.tags) nameTags(g, h, ly > -60 ? ly : null);
      // the pause button (T: TopBar/PauseButton, "||" size 70)
      if (h.pause) F.center(g, '||', 36, 45, 70, { outline: 4, color: '#ffffff', bold: true });
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
      // "Point Blue" / "Point Red", wobbling side to side (T: PointText, size 60, sine 0.35 s each way). One big line at
      // a time: the reference's game-over menu takes the screen from the point, so "Red Wins!" (or "Time up")
      // replaces it rather than stacking on it (site sweep 2026-10-28).
      const ended = (h.endAt > 0 && now >= h.endAt && h.winner >= 0) || (h.timeUpAt > 0 && now >= h.timeUpAt);
      if (h.pointAt > 0 && now >= h.pointAt && !ended) {
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
      if (h.sound) soundIcon(g, h);      // over the ready-up veil: it is the first thing somebody may want to press
    }
    /* The names: small, upright, in the seat's colour, just over each head (tags[s] is the head's top on screen).
       Kept below the score, inside the screen's sides, and over the round's label when that is down and in the way. */
    const TAG_SIZE = 20, SCORE_LOW = 74;
    function nameTags(g, h, labelY) {
      const lm = labelY === null ? null : F.measure(h.label, 30);
      for (let s = 0; s < 2; s++) {
        const t = h.tags[s];
        if (!t || !t.name) continue;
        const m = F.measure(t.name, TAG_SIZE), half = m.h / 2 + 3;
        const x = Math.max(m.w / 2 + 8, Math.min(h.bw - m.w / 2 - 8, t.x));
        let y = t.y - 5 - half;
        if (lm && Math.abs(x - h.bw / 2) < (m.w + lm.w) / 2 + 6 && Math.abs(y - labelY) < half + lm.h / 2 + 5) {
          y = labelY - lm.h / 2 - 5 - half;
        }
        y = Math.max(y, SCORE_LOW + half);
        F.center(g, t.name, x, y, TAG_SIZE, { outline: 3, color: s === 1 ? '#5b8dff' : '#ff5252' });
      }
    }
    /* The sound button, top right (ours: the reference keeps its sound switch in a menu): a speaker in white squares
       with the lettering's black outline, its two waves while sound is on, a red cross while it is off. In squares of
       5 px, 11 x 10, centred where the pause button's "||" sits on the other side. rooftop.js hit-tests the corner. */
    const SPEAKER = [[0, 3, 3, 4], [3, 2, 1, 6], [4, 1, 1, 8], [5, 0, 1, 10]];   // [x, y, w, h] in squares
    const WAVES = [[7, 2, 1, 1], [8, 3, 1, 4], [7, 7, 1, 1], [9, 1, 1, 1], [10, 2, 1, 6], [9, 8, 1, 1]];
    const CROSS = [[7, 3, 1, 1], [10, 3, 1, 1], [8, 4, 2, 2], [7, 6, 1, 1], [10, 6, 1, 1]];
    function soundIcon(g, h) {
      const u = 5, ol = 3, x0 = Math.round(h.bw - 38 - 5.5 * u), y0 = 45 - 5 * u;
      const off = h.sound === 'off', marks = off ? CROSS : WAVES;
      const cells = (list, col, grow) => {
        g.fillStyle = col;
        for (const [x, y, w, hh] of list) g.fillRect(x0 + x * u - grow, y0 + y * u - grow, w * u + 2 * grow, hh * u + 2 * grow);
      };
      cells(SPEAKER, '#000', ol); cells(marks, '#000', ol);
      cells(SPEAKER, '#ffffff', 0); cells(marks, off ? '#ff5252' : '#ffffff', 0);
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

    return { world, hud, tick, newRound, CAST, setLooks };
  }

  root.RTArt = { create, CAST_COUNT: CAST.length, NAMES: CAST.map(o => o.name), pose };
})(window);
