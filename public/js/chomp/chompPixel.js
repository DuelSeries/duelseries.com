// Chomp's arcade look (Owen's pick, 2026-10-25: "Pixel", then "make it look exactly like the arcade"): the whole
// screen is drawn on the arcade's own grid, 8 px a tile, into a small buffer that is scaled up by a whole number with
// hard pixel edges. Every size, colour, position rule and timing here is measured or sourced (docs/chomp-look.md);
// the shapes are drawn by formula in this file, never copied from the arcade's sprite or tile data.
//
//   new ChompPixel(canvas, A)   A from ChompMaze.build
//   .resize(cssW, cssH, dpr, maxTiles)  picks the scale k (device px per arcade px); maxTiles (a big paid arena,
//                               chompMain viewCap): k grows until at most that many tiles show across and down
//   .frame(scene)               scene: { cam {x, y} tiles, tick (60 Hz count), dots, ghosts, players, fruit, pops, hud,
//                                        coins (paid rooms: [{ c, r }] tiles holding money) }
//   .view                       after a frame: { ox, oy, k, T } (screen px = (o + tiles * T) * k), for the page's ring
(function (root) {
  'use strict';
  var Maze = root.ChompMaze, Walls = root.ChompWalls;

  // Lomont, "Pac-Man Emulation Guide" (2008), Figure 2: the 16 colours of the colour PROM as RGB.
  var C = {
    black: '#000000', red: '#ff0000', brown: '#de9751', pink: '#ffb8ff', cyan: '#00ffff', lightBlue: '#47b8ff',
    orange: '#ffb851', yellow: '#ffff00', blue: '#2121ff', green: '#00ff00', teal: '#47b8ae', peach: '#ffb8ae',
    white: '#dedeff'
  };
  var GHOSTS = [C.red, C.pink, C.cyan, C.orange];
  // Other players: palette entries that are not a ghost, not the scared-ghost blue and not yellow (yours).
  var OTHERS = [C.green, C.lightBlue, C.white, C.teal, C.brown];

  // Timings in 60 Hz ticks. jspacman (github.com/jrhollis/jspacman, a frame-level reverse engineering): chew 2 ticks a
  // frame over closed, half, wide, half; ghost skirt 8; scared flash 7 x 4 frames = 14 ticks blue then 14 white
  // (pacman500 by jotd666 also has 14); energizer 10 on, 10 off; death 30 frozen then 14 frames of 8.
  var TK = { chew: 2, skirt: 8, flash: 14, flashes: 5, blink: 10, deathFreeze: 30, deathFrames: 14, deathFrame: 8 };

  var T = 8, HUD_TOP = 3 * T, HUD_BOTTOM = 2 * T;   // the arcade screen: 3 rows of score on top, 2 below the maze

  // ---- sprites: 16 x 16, origin at (floor(8 p) - 8), the way the arcade's hardware sprites sit on an actor at p
  var cache = new Map();
  function hexRGB(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
  function sprite(key, w, h, fn) {
    var s = cache.get(key);
    if (s) return s;
    s = document.createElement('canvas');
    s.width = w; s.height = h;
    var g = s.getContext('2d'), img = g.createImageData(w, h), d = img.data;
    for (var j = 0; j < h; j++) for (var i = 0; i < w; i++) {
      var col = fn(i, j);
      if (!col) continue;
      var rgb = hexRGB(col), o = (j * w + i) * 4;
      d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    cache.set(key, s);
    return s;
  }

  // Pac-Man-style chomper. Measured (1x captures): a 13 px disc (every pixel within 6.5 of the centre pixel, 137
  // pixels shut), the centre at sprite pixel (7, 7). Mouth frames: 'half' is a wedge from 1 px behind the centre,
  // half-width 0.4 per pixel; 'wide' from 2 px behind, half-width 1 per pixel (45 degrees). dir 0 up 1 left 2 down 3 right.
  // color: a colour, or a bought Customize skin (shared/shopSkins.js SKINS.chomp) whose chompPx colours each pixel
  function chomper(color, dir, frame, extraOpen) {
    var skin = typeof color === 'string' ? null : color;
    var key = 'c' + (skin ? 'k' + skin.id : color) + dir + frame + (extraOpen || 0);
    return sprite(key, 16, 16, function (i, j) {
      var dx = i - 7, dy = j - 7;
      if (dx * dx + dy * dy > 42.25) return null;
      var along, across;
      if (dir === 3) { along = dx; across = Math.abs(dy); }
      else if (dir === 1) { along = -dx; across = Math.abs(dy); }
      else if (dir === 0) { along = -dy; across = Math.abs(dx); }
      else { along = dy; across = Math.abs(dx); }
      if (frame === 1) { var t = along + 1; if (t >= 0 && across <= Math.floor(0.4 * (t + 0.5))) return null; }
      if (frame === 2) { var t2 = along + 2; if (t2 >= 0 && across <= t2) return null; }
      if (frame === 3) {
        // the death: the wedge keeps opening past wide (our drawing; the frame count and timing are sourced)
        if (Math.atan2(across, along + 2) <= Math.PI / 4 + extraOpen * (3 * Math.PI / 4)) return null;
      }
      return skin ? window.DS_SHOP_SKINS.chompPx(skin, dx, dy) : color;
    });
  }

  // Ghost: a 14 x 14 box at sprite pixels 1..14 (measured). Body: our own dome (a circle of radius 7 on the box
  // centre) over straight sides, and a two-row skirt that swaps between two patterns. Eyes (measured from the 1x
  // captures): whites 4 x 5 with the corners off, 2 x 2 pupils, placed per direction (box coordinates).
  var EYES = {
    0: { w: [[2, 1], [8, 1]], p: [[3, 1], [9, 1]] },
    1: { w: [[1, 3], [7, 3]], p: [[1, 5], [7, 5]] },
    2: { w: [[2, 4], [8, 4]], p: [[3, 7], [9, 7]] },
    3: { w: [[3, 3], [9, 3]], p: [[5, 5], [11, 5]] }
  };
  function ghost(ki, dir, frame, mode) {
    // mode 0 normal, 1 scared, 2 scared flashing white, 3 eyes only
    return sprite('g' + ki + dir + frame + mode, 16, 16, function (i, j) {
      var x = i - 1, y = j - 1;                       // box coordinates 0..13
      if (x < 0 || y < 0 || x > 13 || y > 13) return null;
      var fx = x + 0.5 - 7, fy = y + 0.5 - 7;
      var body = false;
      if (fy < 0) body = fx * fx + fy * fy <= 49;
      else if (y < 12) body = true;
      else {
        // our skirt: three feet one frame, the gaps between them the next
        var u = (x + (frame ? 2 : 0)) % 5;
        body = y === 12 ? u !== 4 : (u === 1 || u === 2);
      }
      if (mode === 1 || mode === 2) {
        if (!body) return null;
        var face = mode === 1 ? C.peach : C.red;
        if ((y === 5 || y === 6) && (x === 4 || x === 5 || x === 8 || x === 9)) return face;
        if (x >= 1 && x <= 12) {
          var up = Math.floor((x - 1) / 2) % 2 === 1;
          if ((up && y === 9) || (!up && y === 10)) return face;
        }
        return mode === 1 ? C.blue : C.white;
      }
      var e = EYES[dir] || EYES[1];
      for (var s = 0; s < 2; s++) {
        var px = e.p[s][0], py = e.p[s][1];
        if (x >= px && x <= px + 1 && y >= py && y <= py + 1) return C.blue;
        var wx = x - e.w[s][0], wy = y - e.w[s][1];
        if (wx >= 0 && wx <= 3 && wy >= 0 && wy <= 4 && !((wx === 0 || wx === 3) && (wy === 0 || wy === 4))) return C.white;
      }
      if (mode === 3) return null;
      return body ? GHOSTS[ki] : null;
    });
  }

  // Energizer: an 8 px disc on its tile (52 pixels, as measured), dots 2 x 2 at the tile's centre pixels.
  // A paid room's coin (ours, not the arcade's: money never looks like a dot): a 9 px gold disc with a bronze rim and a
  // struck $, in the shared DuelSeries gold (public/js/shared/dsEnd.js R_GOLD), breathing between two shades.
  var COIN = { gold: '#f5b335', hi: '#ffd76e', rim: '#8a5a12', ink: '#5a3606' };
  var DOLLAR = ['.###.', '#.#..', '.###.', '..#.#', '.###.'];
  function coin(bright) {
    return sprite('$' + (bright ? 1 : 0), 9, 9, function (i, j) {
      var x = i - 4, y = j - 4, d = x * x + y * y;
      if (d > 18) return null;
      if (d > 11) return COIN.rim;
      var gx = i - 2, gy = j - 2;
      if (gx >= 0 && gx < 5 && gy >= 0 && gy < 5 && DOLLAR[gy][gx] === '#') return COIN.ink;
      if (i === 4 && (j === 1 || j === 7)) return COIN.ink;
      return bright && x + y < -2 ? COIN.hi : COIN.gold;
    });
  }

  function energizer() { return sprite('e', 8, 8, function (i, j) { var x = i - 3.5, y = j - 3.5; return x * x + y * y <= 16 ? C.peach : null; }); }

  function segDist(x, y, ax, ay, bx, by) {
    var vx = bx - ax, vy = by - ay, t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy)));
    var ex = x - ax - t * vx, ey = y - ay - t * vy;
    return Math.sqrt(ex * ex + ey * ey);
  }
  // Cherries: our own drawing in the palette's red, brown and white.
  function cherry() {
    return sprite('cherry', 16, 16, function (i, j) {
      var x = i - 7.5, y = j - 7.5;
      var a = (x + 3) * (x + 3) + (y - 2.5) * (y - 2.5), b = (x - 2.5) * (x - 2.5) + (y - 3.5) * (y - 3.5);
      if (a <= 7.5 || b <= 7.5) {
        if ((Math.abs(x + 4) < 0.6 && Math.abs(y - 1.5) < 0.6) || (Math.abs(x - 1.5) < 0.6 && Math.abs(y - 2.5) < 0.6)) return C.white;
        return C.red;
      }
      if (segDist(x, y, -3, 0, 2.5, -5.5) < 0.62 || segDist(x, y, 2.5, 1, 3.5, -2.5) < 0.62 || segDist(x, y, 3.5, -2.5, 2.5, -5.5) < 0.62 ||
          segDist(x, y, 2.5, -5.5, 5, -5.5) < 0.62) return C.brown;
      return null;
    });
  }

  // The life icon on the bottom row: the arcade's is smaller than the playing sprite (measured box 10 x 11); ours is
  // an 11 px disc with the half mouth facing left, drawn so its 10 x 11 box lands where the arcade's does.
  function life() {
    return sprite('life', 16, 16, function (i, j) {
      var dx = i - 7, dy = j - 5;
      if (dx * dx + dy * dy > 30.25) return null;
      var t = -dx + 1;
      if (t >= 0 && Math.abs(dy) <= Math.floor(0.4 * (t + 0.5))) return null;
      return C.yellow;
    });
  }

  // Points where something was eaten. The arcade shows them as one 16 px sprite (jspacman PacmanPoints.js: 16 wide),
  // so ours are small digits: our own 3 x 5 figures, 1 px apart ("1600" is 15 px).
  var DIG = ['111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001',
             '111100111001111', '111100111101111', '111001001001001', '111101111101111', '111101111001111'];
  function points(str, color) {
    return sprite('p' + color + str, str.length * 4 - 1, 5, function (i, j) {
      var d = str.charCodeAt(Math.floor(i / 4)) - 48, x = i % 4;
      if (x === 3 || d < 0 || d > 9) return null;
      return DIG[d][j * 3 + x] === '1' ? color : null;
    });
  }

  function halo(color) {
    return sprite('h' + color, 22, 22, function (i, j) { var x = i - 10.5, y = j - 10.5, d = Math.sqrt(x * x + y * y); return d >= 8.6 && d < 9.6 ? color : null; });
  }

  // Text on the 8 px grid in an 8 x 8 arcade-style face (Press Start 2P, SIL OFL), every pixel on or off.
  var fontReady = false;
  function text(str, color) {
    var key = 't' + color + str, s = cache.get(key);
    if (s) return s;
    s = document.createElement('canvas');
    s.width = Math.max(1, str.length * 8); s.height = 8;
    // willReadFrequently keeps this tiny canvas in memory, so the read below is a copy and not a GPU readback that
    // stalls the frame (every new score is a new string; phone speed pass 2026-10-31). Same pixels either way.
    var g = s.getContext('2d', { willReadFrequently: true });
    g.font = '8px "Press Start 2P"';
    g.textBaseline = 'top';
    g.fillStyle = color;
    g.fillText(str, 0, 0);
    var img = g.getImageData(0, 0, s.width, 8), d = img.data, rgb = hexRGB(color);
    for (var o = 0; o < d.length; o += 4) {
      if (d[o + 3] >= 128) { d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = 255; } else d[o + 3] = 0;
    }
    g.putImageData(img, 0, 0);
    if (fontReady) {
      // every score shown is its own string: without a cap a long game keeps hundreds of these canvases
      if (++textKept > 256) { cache.forEach(function (_v, k) { if (k[0] === 't') cache.delete(k); }); textKept = 1; }
      cache.set(key, s);
    }
    return s;
  }
  var textKept = 0;
  function checkFont() {
    if (fontReady) return;
    try {
      if (document.fonts && document.fonts.check('8px "Press Start 2P"')) {
        fontReady = true;
        cache.forEach(function (_v, k) { if (k[0] === 't') cache.delete(k); });
        textKept = 0;
      }
    } catch (e) { fontReady = true; }
  }

  // ---- the renderer
  function Pixel(canvas, A) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.A = A;
    this.walls = Walls.build(A);
    this.chunks = new Map();
    this.buf = document.createElement('canvas');
    this.k = 3; this.S = 24; this.dpr = 1;
    this.L = { id: 'pixel', me: C.yellow, players: [C.yellow].concat(OTHERS), fright: C.blue, flash: C.white };
    this.C = C;
    if (document.fonts && document.fonts.load) document.fonts.load('8px "Press Start 2P"').then(checkFont, checkFont);
  }

  // k = device pixels per arcade pixel, whole numbers only: on a screen held upright the arcade's 224 px width fits
  // across (never fewer than 28 columns), otherwise its 288 px height (36 rows) to the nearest whole scale.
  Pixel.prototype.resize = function (w, h, dpr, maxTiles) {
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
    var portrait = h > w;
    this.k = Math.max(1, portrait ? Math.floor(this.canvas.width / 224) : Math.round(this.canvas.height / 288));
    // night review 2026-10-29: never more than maxTiles across or down (only a very wide or very short window zooms in)
    if (maxTiles > 0) this.k = Math.max(this.k, Math.ceil(this.canvas.width / (maxTiles * T)), Math.ceil(this.canvas.height / (maxTiles * T)));
    this.S = this.k * T;
    this.buf.width = Math.ceil(this.canvas.width / this.k);
    this.buf.height = Math.ceil(this.canvas.height / this.k);
  };
  Pixel.prototype.setLook = function () {};

  var CH = 16;
  Pixel.prototype.chunk = function (cx, cy) {
    var key = cx + ',' + cy, c = this.chunks.get(key);
    if (c) return c;
    var Wm = this.walls, px = CH * T;
    c = document.createElement('canvas');
    c.width = c.height = px;
    var g = c.getContext('2d'), img = g.createImageData(px, px), d = img.data;
    var wall = hexRGB(C.blue), door = hexRGB(C.pink);
    var wrap = this.A.wrap;
    for (var y = 0; y < px; y++) {
      var gy = cy * px + y;
      // a torus: a chunk past the map's edge shows the map's far side (chunks are keyed by their unwrapped place)
      if (wrap) gy = ((gy % Wm.PH) + Wm.PH) % Wm.PH;
      else if (gy >= Wm.PH) break;
      for (var x = 0; x < px; x++) {
        var gx = cx * px + x;
        if (wrap) gx = ((gx % Wm.PW) + Wm.PW) % Wm.PW;
        else if (gx >= Wm.PW) break;
        var v = Wm.mask[gy * Wm.PW + gx];
        if (!v) continue;
        var rgb = v === 2 ? door : wall, o = (y * px + x) * 4;
        d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    if (this.chunks.size > 120) this.chunks.clear();
    this.chunks.set(key, c);
    return c;
  };

  Pixel.prototype.frame = function (s) {
    checkFont();
    var A = this.A, g = this.buf.getContext('2d'), BW = this.buf.width, BH = this.buf.height;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.imageSmoothingEnabled = false;
    g.fillStyle = C.black;
    g.fillRect(0, 0, BW, BH);
    // the maze shows between the score rows on top and the two rows below
    var top = HUD_TOP, bottom = BH - HUD_BOTTOM;
    var ox = Math.floor(BW / 2) - Math.round(s.cam.x * T), oy = Math.floor((top + bottom) / 2) - Math.round(s.cam.y * T);
    g.save();
    g.beginPath(); g.rect(0, top, BW, bottom - top); g.clip();
    var c0 = Math.floor(-ox / T) - 1, c1 = Math.ceil((BW - ox) / T) + 1;
    var r0 = Math.floor((top - oy) / T) - 1, r1 = Math.ceil((bottom - oy) / T) + 1;
    // sealed: only the map; a torus: every tile on screen, the map's far side past its edge (the camera stays on you)
    if (!A.wrap) { c0 = Math.max(0, c0); c1 = Math.min(A.W - 1, c1); r0 = Math.max(0, r0); r1 = Math.min(A.H - 1, r1); }
    for (var cy = Math.floor(r0 / CH); cy <= Math.floor(r1 / CH); cy++) {
      for (var cx = Math.floor(c0 / CH); cx <= Math.floor(c1 / CH); cx++) g.drawImage(this.chunk(cx, cy), ox + cx * CH * T, oy + cy * CH * T);
    }
    // dots and energizers
    var dots = s.dots, blinkOn = Math.floor(s.tick / TK.blink) % 2 === 0, en = energizer();
    g.fillStyle = C.peach;
    for (var r = r0; r <= r1; r++) for (var c = c0; c <= c1; c++) {
      var v = dots[A.wrap ? A.k(c, r) : r * A.W + c];
      if (v === 1) g.fillRect(ox + c * T + 3, oy + r * T + 3, 2, 2);
      else if (v === 2 && blinkOn) g.drawImage(en, ox + c * T, oy + r * T);
    }
    // coins (paid rooms) over the dots, under everything that moves
    if (s.coins && s.coins.length) {
      var cs = coin(Math.floor(s.tick / 24) % 2 === 0);
      for (var ci = 0; ci < s.coins.length; ci++) {
        var co = s.coins[ci];
        if (co.c < c0 || co.c > c1 || co.r < r0 || co.r > r1) continue;
        g.drawImage(cs, ox + co.c * T - 1, oy + co.r * T - 1);
      }
    }
    var self = this;
    function at(spr, x, y, dx, dy) { g.drawImage(spr, ox + Math.floor(x * T) - 8 + (dx || 0), oy + Math.floor(y * T) - 8 + (dy || 0)); }
    (s.fruit || []).forEach(function (f) { at(cherry(), f.x, f.y); });
    // jspacman GameScene draw order: Pac-Man first, then the ghosts with Blinky last, so ghosts cover chompers
    s.players.forEach(function (p) {
      if (p.hidden) return;
      var color = p.scared ? (p.scaredFlash ? C.white : C.blue) : (p.skin && window.DS_SHOP_SKINS ? p.skin : p.color);
      if (p.halo && p.dying == null && Math.floor(s.tick / 8) % 2 === 0) at(halo(p.color), p.x, p.y, -3, -3);
      if (p.dying != null) {
        var f = p.dying;                       // death frame 0..13, or -1 frozen before it starts
        if (f < 0) at(chomper(color, 0, 2), p.x, p.y);
        else if (f < 11) at(chomper(color, 0, 3, (f + 1) / 11), p.x, p.y);
        else if (f < 13) at(burst(p.scared ? color : p.color, f - 11), p.x, p.y);   // a colour, never a skin
      } else at(chomper(color, p.dir, p.frame), p.x, p.y);
    });
    s.ghosts.slice().sort(function (a, b) { return b.ki - a.ki; }).forEach(function (q) {
      at(ghost(q.ki, q.look != null ? q.look : q.dir, q.frame, q.mode), q.x, q.y);
    });
    // points where something was eaten, on the grid like the arcade's own
    (s.pops || []).forEach(function (q) {
      var t = points(q.text, q.color);
      g.drawImage(t, ox + Math.floor(q.x * T) - (t.width >> 1), oy + Math.floor(q.y * T) - 3);
    });
    if (s.banner) {
      var bt = text(s.banner.text, s.banner.color);
      g.drawImage(bt, ox + Math.floor(s.banner.x * T) - (bt.width >> 1) + 1, oy + Math.floor(s.banner.y * T) - 4);
    }
    g.restore();
    this.hud(g, s.hud, BW, BH, s.tick);
    var m = this.ctx;
    m.setTransform(1, 0, 0, 1, 0, 0);
    m.imageSmoothingEnabled = false;
    m.drawImage(this.buf, 0, 0, BW * this.k, BH * this.k);
    this.view = { ox: ox, oy: oy, k: this.k, T: T, top: HUD_TOP, bottom: BH - HUD_BOTTOM };
    // names over the other chompers (the arcade has none): at screen sharpness, half a tile tall, so a name never
    // outweighs the 13 px chomper under it
    var k = this.k, fs = Math.max(9, 4 * k);
    m.font = fs + 'px "Press Start 2P", monospace';
    m.textAlign = 'center'; m.textBaseline = 'bottom';
    s.players.forEach(function (p) {
      if (p.me || !p.name || p.dying != null) return;
      var y = (oy + Math.floor(p.y * T) - 9) * k;
      if (y < (HUD_TOP + 2) * k || y > (BH - HUD_BOTTOM) * k) return;
      m.fillStyle = p.color;
      m.fillText(p.name, (ox + Math.floor(p.x * T)) * k, y);
    });
    // Owen 2026-10-27: every Pac-Man is the classic yellow, so yours wears a thin, faint white outline (2 px clear of
    // the 13 px disc, whose centre is sprite pixel 7: half a pixel left of and above floor(p * T)); the rest wear names
    s.players.forEach(function (p) {
      if (!p.me || p.hidden || p.dying != null) return;
      m.globalAlpha = 0.55;
      m.strokeStyle = '#ffffff';
      m.lineWidth = Math.max(1, k * 0.75);
      m.beginPath();
      m.arc((ox + Math.floor(p.x * T) - 0.5) * k, (oy + Math.floor(p.y * T) - 0.5) * k, 8.5 * k, 0, Math.PI * 2);
      m.stroke();
    });
    m.globalAlpha = 1;
  };

  // The arcade's score rows (measured from the 1x captures): "1UP" at column 3 and "HIGH SCORE" at column 9 on row 0;
  // the scores on row 1 ending at columns 6 and 16, a zero score shown as "00"; lives along the bottom from column 2,
  // 16 px apart; the level fruit at the bottom right.
  Pixel.prototype.hud = function (g, hud, BW, BH, tick) {
    if (!hud) return;
    // Measured against the Dossier capture: the arcade's glyphs sit 1 px right of Press Start 2P's in the 8 px cell,
    // and the score row 1 px lower. 1UP blinks 16 frames on, 16 off while playing (jspacman Text.js).
    // spectating: no 1UP or score of your own (the Spectate bar's Lobby chip sits there)
    if (!hud.watch && (!hud.blink || Math.floor(tick / 16) % 2 === 0)) g.drawImage(text('1UP', C.white), 3 * T + 1, 0);
    g.drawImage(text('HIGH SCORE', C.white), 9 * T + 1, 0);
    // a paid room shows money where the scores go (yours, and the richest chomper's), in the coins' gold
    var sc = hud.money != null ? hud.money : hud.score > 0 ? String(hud.score) : '00';
    if (!hud.watch) g.drawImage(text(sc, hud.money != null ? COIN.gold : C.white), 7 * T - sc.length * T + 1, T + 1);
    if (hud.highMoney != null) g.drawImage(text(hud.highMoney, COIN.gold), 17 * T - hud.highMoney.length * T + 1, T + 1);
    else if (hud.high > 0) { var hs = String(hud.high); g.drawImage(text(hs, C.white), 17 * T - hs.length * T + 1, T + 1); }
    for (var i = 0; i < hud.lives; i++) g.drawImage(life(), 2 * T + i * 16, BH - HUD_BOTTOM + 2);
    if (hud.fruit) g.drawImage(cherry(), BW - 4 * T, BH - HUD_BOTTOM);
  };

  function burst(color, n) {
    return sprite('b' + color + n, 16, 16, function (i, j) {
      var x = i - 7, y = j - 7, d = Math.sqrt(x * x + y * y), r0 = 2 + n * 2, r1 = 4 + n * 3;
      if (d < r0 || d > r1) return null;
      var a = Math.atan2(y, x) / (Math.PI / 4);
      return Math.abs(a - Math.round(a)) * d < 0.6 ? color : null;
    });
  }

  Pixel.C = C;
  Pixel.TK = TK;
  Pixel.OTHERS = OTHERS;
  Pixel.sprites = { chomper: chomper, ghost: ghost, energizer: energizer, cherry: cherry, text: text, life: life, points: points, coin: coin };
  root.ChompPixel = Pixel;
})(typeof self !== 'undefined' ? self : this);
