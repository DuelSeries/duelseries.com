// Chomp's renderer: the maze, dots, fruit, ghosts and chompers on one canvas, in one of a few looks. Everything is
// drawn here in code (no sprite sheets, no ROM art): the arcade's style, our own shapes.
//
// World units are tiles; S is screen pixels per tile. The walls are traced once from the maze table (a line through
// the centres of the wall tiles that face a corridor, so a two-tile-thick block reads as one thin outlined bar, the
// way the arcade draws its maze), cached in chunks, and stamped each frame. The 'pixel' look draws the whole scene
// at the arcade's own 8 px per tile into a small buffer and scales it up with hard pixel edges.
(function (root) {
  'use strict';
  var Maze = root.ChompMaze;

  // ---- looks (Owen picks one; the numbers are visual only and change nothing in play)
  var BASE = {
    bg: '#000000', wall: '#2121ff', door: '#ffb8ff', dot: '#ffb8ae', text: '#ffffff',
    ghost: ['#ff0000', '#ffb8ff', '#00ffff', '#ffb852'],
    fright: '#2121ff', frightFace: '#ffb8ae', flash: '#dedeff', flashFace: '#ff0000',
    eyeWhite: '#dedeff', pupil: '#2121ff', me: '#ffff00',
    // other chompers: never a ghost colour or the blue of a scared ghost
    players: ['#ffff00', '#8cff3c', '#f4f4f4', '#b07cff', '#3cffb4', '#ff8f6b', '#7cc8ff', '#e4ff6b'],
    wallW: 0.16, glow: 0, pixel: false, chomperR: 0.8, ghostR: 0.875, dotR: 0.125, energizerR: 0.5
  };
  var LOOKS = {
    arcade: { name: 'Arcade' },
    neon: { name: 'Neon', wall: '#3a5bff', wallW: 0.2, glow: 0.55, wallCore: '#a9b8ff' },
    pixel: { name: 'Pixel', pixel: true, wallW: 0.125 }
  };
  function lookOf(name) {
    var o = {}, k, l = LOOKS[name] || LOOKS.arcade;
    for (k in BASE) o[k] = BASE[k];
    for (k in l) o[k] = l[k];
    o.id = LOOKS[name] ? name : 'arcade';
    return o;
  }

  // ---- the wall outline, in tile units: loops of corner points
  function traceWalls(A) {
    var W = A.W, H = A.H;
    function solid(c, r) { return c < 0 || r < 0 || c >= W || r >= H || A.cell[r * W + c] === Maze.WALL; }
    function inside(c, r) { return solid(c, r) && solid(c + 1, r) && solid(c, r + 1) && solid(c + 1, r + 1); }
    // vertices are tile centres (c, r) for c in -1..W, r in -1..H; edges stored per vertex
    var adj = new Map();
    function key(c, r) { return (r + 2) * (W + 4) + (c + 2); }
    function add(a, b) {
      (adj.get(a) || adj.set(a, []).get(a)).push(b);
      (adj.get(b) || adj.set(b, []).get(b)).push(a);
    }
    for (var r = -1; r <= H; r++) for (var c = -1; c <= W; c++) {
      if (c < W && inside(c, r - 1) !== inside(c, r)) add(key(c, r), key(c + 1, r));
      if (r < H && inside(c - 1, r) !== inside(c, r)) add(key(c, r), key(c, r + 1));
    }
    function pos(k) { var c = k % (W + 4) - 2, r = Math.floor(k / (W + 4)) - 2; return [c + 0.5, r + 0.5]; }
    var loops = [], used = new Set();
    function ek(a, b) { return a < b ? a + ':' + b : b + ':' + a; }
    adj.forEach(function (_n, start) {
      var nb = adj.get(start);
      for (var i = 0; i < nb.length; i++) {
        if (used.has(ek(start, nb[i]))) continue;
        var loop = [start], prev = start, cur = nb[i];
        used.add(ek(start, cur));
        for (var guard = 0; guard < 100000 && cur !== start; guard++) {
          loop.push(cur);
          var ns = adj.get(cur), next = -1;
          // prefer the edge that turns least at a 4-way vertex (keeps loops simple)
          for (var j = 0; j < ns.length; j++) if (!used.has(ek(cur, ns[j]))) { next = ns[j]; break; }
          if (next < 0) break;
          used.add(ek(cur, next));
          prev = cur; cur = next;
        }
        // keep corners only
        var pts = loop.map(pos), out = [];
        for (var p = 0; p < pts.length; p++) {
          var a = pts[(p - 1 + pts.length) % pts.length], b = pts[p], d = pts[(p + 1) % pts.length];
          if ((a[0] === b[0] && b[0] === d[0]) || (a[1] === b[1] && b[1] === d[1])) continue;
          out.push(b);
        }
        if (out.length >= 3) loops.push(out);
      }
    });
    return loops;
  }

  function roundedLoop(ctx, pts, rad) {
    var n = pts.length;
    var a = pts[n - 1], b = pts[0];
    ctx.moveTo((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
    for (var i = 0; i < n; i++) {
      var p = pts[i], q = pts[(i + 1) % n];
      ctx.arcTo(p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2, rad);
    }
    ctx.closePath();
  }

  // the static layer (walls, houses, the arena's double edge) as one path in tile units
  function wallPaths(A) {
    var walls = new Path2D();
    traceWalls(A).forEach(function (pts) { roundedLoop(walls, pts, 0.5); });
    // the arena's outer line, just inside its edge (the arcade's double border)
    var e = 0.15;
    roundedLoop(walls, [[e, e], [A.W - e, e], [A.W - e, A.H - e], [e, A.H - e]], 0.6);
    var house = new Path2D(), door = new Path2D(), Hs = Maze.HOUSE;
    A.modules.forEach(function (m) {
      var x0 = m.ox + Hs.c0, y0 = m.oy + Hs.r0, x1 = m.ox + Hs.c1 + 1, y1 = m.oy + Hs.r1 + 1;
      var dx0 = m.ox + Hs.doorX - 1, dx1 = m.ox + Hs.doorX + 1;
      [0.25, 0.7].forEach(function (inset) {
        house.moveTo(dx0, y0 + inset);
        house.lineTo(x0 + inset, y0 + inset); house.lineTo(x0 + inset, y1 - inset);
        house.lineTo(x1 - inset, y1 - inset); house.lineTo(x1 - inset, y0 + inset);
        house.lineTo(dx1, y0 + inset);
      });
      house.moveTo(dx0, y0 + 0.25); house.lineTo(dx0, y0 + 0.7);
      house.moveTo(dx1, y0 + 0.25); house.lineTo(dx1, y0 + 0.7);
      door.rect(dx0, y0 + 0.36, dx1 - dx0, 0.22);
    });
    return { walls: walls, house: house, door: door };
  }

  // ---- pixel sprites (the 'pixel' look): 16 x 16 px, each pixel decided by a shape test, no soft edges
  var spriteCache = new Map();
  function sprite(key, size, fn) {
    var s = spriteCache.get(key);
    if (s) return s;
    s = document.createElement('canvas');
    s.width = s.height = size;
    var g = s.getContext('2d'), img = g.createImageData(size, size), d = img.data;
    for (var j = 0; j < size; j++) for (var i = 0; i < size; i++) {
      var col = fn(i + 0.5 - size / 2, j + 0.5 - size / 2);
      if (!col) continue;
      var o = (j * size + i) * 4;
      d[o] = parseInt(col.slice(1, 3), 16); d[o + 1] = parseInt(col.slice(3, 5), 16); d[o + 2] = parseInt(col.slice(5, 7), 16); d[o + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    spriteCache.set(key, s);
    return s;
  }

  var DIR_ANGLE = [-Math.PI / 2, Math.PI, Math.PI / 2, 0];   // up, left, down, right
  var DIR_V = [[0, -1], [-1, 0], [0, 1], [1, 0]];

  function chomperSprite(color, dir, mouth) {
    var mq = Math.round(mouth * 8) / 8;
    return sprite('c' + color + dir + mq, 16, function (x, y) {
      if (x * x + y * y > 6.5 * 6.5) return null;
      if (mq > 0) {
        var a = Math.atan2(y, x) - DIR_ANGLE[dir < 0 ? 1 : dir];
        a = Math.atan2(Math.sin(a), Math.cos(a));
        if (Math.abs(a) < mq * Math.PI / 2 && x * x + y * y > 0.6) return null;
      }
      return color;
    });
  }

  function ghostSprite(L, ki, dir, frame, mode) {
    // mode: 0 normal, 1 scared, 2 scared flash, 3 eyes only
    return sprite('g' + ki + dir + frame + mode, 16, function (x, y) {
      var body = mode === 1 ? L.fright : mode === 2 ? L.flash : L.ghost[ki];
      var inBody = false;
      if (y < 0) inBody = x * x + y * y <= 49;
      else if (y < 5) inBody = Math.abs(x) <= 7;
      else if (y < 7) {
        var fx = Math.floor(x + 7 + frame * 2) % 4;
        inBody = Math.abs(x) <= 7 && fx < 2;
      }
      if (mode === 1 || mode === 2) {
        if (!inBody) return null;
        var face = mode === 1 ? L.frightFace : L.flashFace;
        if (y >= -3 && y < -1 && (Math.abs(x + 2.5) < 1 || Math.abs(x - 2.5) < 1)) return face;
        if (y >= 2 && y < 4) {
          var zz = Math.floor(x + 7) % 4;
          var up = zz === 1 || zz === 2;
          if (Math.abs(x) < 6 && ((up && y < 3) || (!up && y >= 3))) return face;
        }
        return body;
      }
      var v = DIR_V[dir];
      var ex = v[0] * 1, ey = v[1] * 1;
      for (var side = -1; side <= 1; side += 2) {
        var cx = side * 3 + ex, cy = -2 + ey;
        var dx = x - cx, dy = y - cy;
        if (Math.abs(dx) <= 2 && Math.abs(dy) <= 2.5 && !(Math.abs(dx) > 1.5 && Math.abs(dy) > 2)) {
          var px = cx + v[0] * 1, py = cy + v[1] * 1.2;
          if (Math.abs(x - px) <= 1 && Math.abs(y - py) <= 1) return L.pupil;
          return L.eyeWhite;
        }
      }
      if (mode === 3) return null;
      return inBody ? body : null;
    });
  }

  function energizerSprite(color) {
    return sprite('e' + color, 8, function (x, y) { return x * x + y * y <= 16 ? color : null; });
  }

  // ---- vector shapes (the 'arcade' and 'neon' looks)
  function drawChomper(ctx, x, y, r, dir, mouth, color) {
    var a0 = DIR_ANGLE[dir < 0 ? 1 : dir], m = Math.max(0.0001, mouth) * Math.PI / 2;
    ctx.fillStyle = color;
    ctx.beginPath();
    if (mouth <= 0.001) ctx.arc(x, y, r, 0, Math.PI * 2);
    else { ctx.moveTo(x, y); ctx.arc(x, y, r, a0 + m, a0 + Math.PI * 2 - m); ctx.closePath(); }
    ctx.fill();
  }

  function drawGhost(ctx, L, x, y, R, ki, dir, frame, mode) {
    var body = mode === 1 ? L.fright : mode === 2 ? L.flash : L.ghost[ki];
    if (mode !== 3) {
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.arc(x, y - R * 0.05, R, Math.PI, 0);
      var bot = y + R, n = 6, w = 2 * R / n;
      ctx.lineTo(x + R, bot);
      for (var i = 0; i < n; i++) {
        var xi = x + R - (i + 1) * w;
        var low = ((i + frame) % 2) === 0;
        ctx.lineTo(xi + w / 2, low ? bot - R * 0.3 : bot);
        ctx.lineTo(xi, low ? bot : bot - R * 0.3);
      }
      ctx.closePath();
      ctx.fill();
    }
    if (mode === 1 || mode === 2) {
      ctx.fillStyle = mode === 1 ? L.frightFace : L.flashFace;
      var s = R * 0.26;
      ctx.fillRect(x - R * 0.36 - s / 2, y - R * 0.3 - s / 2, s, s);
      ctx.fillRect(x + R * 0.36 - s / 2, y - R * 0.3 - s / 2, s, s);
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = R * 0.12;
      ctx.beginPath();
      var mx0 = x - R * 0.65, seg = R * 1.3 / 6;
      for (var k = 0; k <= 6; k++) ctx[k ? 'lineTo' : 'moveTo'](mx0 + k * seg, y + R * 0.35 + (k % 2 ? -R * 0.14 : R * 0.08));
      ctx.stroke();
      return;
    }
    var v = DIR_V[dir];
    for (var side = -1; side <= 1; side += 2) {
      var cx = x + side * R * 0.38 + v[0] * R * 0.12, cy = y - R * 0.22 + v[1] * R * 0.12;
      ctx.fillStyle = L.eyeWhite;
      ctx.beginPath(); ctx.ellipse(cx, cy, R * 0.24, R * 0.3, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = L.pupil;
      ctx.beginPath(); ctx.arc(cx + v[0] * R * 0.12, cy + v[1] * R * 0.15, R * 0.13, 0, Math.PI * 2); ctx.fill();
    }
  }

  function drawCherry(ctx, x, y, s) {
    ctx.strokeStyle = '#de9751'; ctx.lineWidth = s * 0.09; ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x - s * 0.4, y + s * 0.15); ctx.quadraticCurveTo(x - s * 0.05, y - s * 0.35, x + s * 0.45, y - s * 0.62);
    ctx.moveTo(x + s * 0.28, y + s * 0.3); ctx.quadraticCurveTo(x + s * 0.3, y - s * 0.2, x + s * 0.45, y - s * 0.62);
    ctx.stroke();
    ctx.fillStyle = '#ff0000';
    ctx.beginPath(); ctx.arc(x - s * 0.42, y + s * 0.32, s * 0.3, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(x + s * 0.28, y + s * 0.45, s * 0.3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x - s * 0.58, y + s * 0.3, s * 0.1, s * 0.1);
    ctx.fillRect(x + s * 0.12, y + s * 0.43, s * 0.1, s * 0.1);
  }

  // ---- the renderer
  function Renderer(canvas, A, lookName) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.A = A;
    this.paths = wallPaths(A);
    this.chunks = new Map();
    this.setLook(lookName);
    this.w = 0; this.h = 0; this.dpr = 1; this.S = 24;
  }

  Renderer.prototype.setLook = function (name) {
    this.L = lookOf(name);
    this.chunks.clear();
    spriteCache.clear();
  };

  // S: device pixels per tile
  Renderer.prototype.resize = function (w, h, dpr, S) {
    this.w = w; this.h = h; this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
    if (this.L.pixel) {
      this.k = Math.max(1, Math.floor(S / 8));          // device pixels per arcade pixel, whole numbers only
      S = this.k * 8;
      if (!this.buf) { this.buf = document.createElement('canvas'); }
      this.buf.width = Math.ceil(this.canvas.width / this.k);
      this.buf.height = Math.ceil(this.canvas.height / this.k);
    }
    this.S = S;
    this.chunks.clear();
  };

  var CHUNK = 16;
  Renderer.prototype.chunk = function (cx, cy, S) {
    var key = cx + ',' + cy, c = this.chunks.get(key);
    if (c) return c;
    var L = this.L, pad = 1;
    c = document.createElement('canvas');
    var px = Math.ceil((CHUNK + pad * 2) * S);
    c.width = c.height = px;
    var g = c.getContext('2d');
    g.setTransform(S, 0, 0, S, (-cx * CHUNK + pad) * S, (-cy * CHUNK + pad) * S);
    g.lineJoin = 'round';
    if (L.glow) {
      g.save();
      g.strokeStyle = L.wall; g.lineWidth = L.wallW * 2.2; g.globalAlpha = 0.35;
      g.shadowColor = L.wall; g.shadowBlur = L.glow * S;
      g.stroke(this.paths.walls); g.stroke(this.paths.house);
      g.restore();
      g.strokeStyle = L.wallCore || L.wall; g.lineWidth = L.wallW * 0.6;
      g.stroke(this.paths.walls); g.stroke(this.paths.house);
    } else {
      g.strokeStyle = L.wall; g.lineWidth = L.wallW;
      g.stroke(this.paths.walls); g.stroke(this.paths.house);
    }
    g.fillStyle = L.door; g.fill(this.paths.door);
    if (L.pixel) {
      // hard edges: every pixel is wall colour or nothing
      var img = g.getImageData(0, 0, px, px), d = img.data;
      var wr = parseInt(L.wall.slice(1, 3), 16), wg = parseInt(L.wall.slice(3, 5), 16), wb = parseInt(L.wall.slice(5, 7), 16);
      for (var i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 90) { d[i + 3] = 0; continue; }
        var isDoor = d[i] > 200 && d[i + 2] > 200 && d[i + 1] > 150;
        if (!isDoor) { d[i] = wr; d[i + 1] = wg; d[i + 2] = wb; }
        d[i + 3] = 255;
      }
      g.putImageData(img, 0, 0);
    }
    c.pad = pad;
    if (this.chunks.size > 80) this.chunks.clear();
    this.chunks.set(key, c);
    return c;
  };

  // scene: { cam: {x, y}, t (ms), dots, players: [{x, y, dir, mouth, color, name, me, alpha, scared, halo, dying}],
  //          ghosts: [{x, y, dir, ki, mode, frame}], fruit: [{x, y}], pops: [{x, y, text, color, a}] }
  Renderer.prototype.frame = function (scene) {
    var L = this.L, A = this.A;
    var pixel = L.pixel;
    var ctx = pixel ? this.buf.getContext('2d') : this.ctx;
    var W = pixel ? this.buf.width : this.canvas.width, H = pixel ? this.buf.height : this.canvas.height;
    var S = pixel ? 8 : this.S;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = !pixel;
    ctx.fillStyle = L.bg; ctx.fillRect(0, 0, W, H);
    // camera: tile at the centre of the screen; whole pixels so nothing shimmers
    var ox = Math.round(W / 2 - scene.cam.x * S), oy = Math.round(H / 2 - scene.cam.y * S);
    var c0 = Math.floor(-ox / S) - 1, r0 = Math.floor(-oy / S) - 1, c1 = Math.ceil((W - ox) / S) + 1, r1 = Math.ceil((H - oy) / S) + 1;
    // walls
    var chunkS = pixel ? 8 : S;
    for (var cy = Math.max(0, Math.floor(r0 / CHUNK)); cy <= Math.min(Math.ceil(A.H / CHUNK), Math.floor(r1 / CHUNK)); cy++) {
      for (var cx = Math.max(0, Math.floor(c0 / CHUNK)); cx <= Math.min(Math.ceil(A.W / CHUNK), Math.floor(c1 / CHUNK)); cx++) {
        var ch = this.chunk(cx, cy, chunkS);
        // only the chunk's own square: its padding exists so glow from walls next door is drawn, not to overlap
        var x0 = Math.round(ox + cx * CHUNK * S), y0 = Math.round(oy + cy * CHUNK * S);
        var x1 = Math.round(ox + (cx + 1) * CHUNK * S), y1 = Math.round(oy + (cy + 1) * CHUNK * S);
        ctx.drawImage(ch, ch.pad * chunkS, ch.pad * chunkS, CHUNK * chunkS, CHUNK * chunkS, x0, y0, x1 - x0, y1 - y0);
      }
    }
    ctx.setTransform(S, 0, 0, S, ox, oy);
    // dots
    var dots = scene.dots, blinkOn = Math.floor(scene.t / 167) % 2 === 0;    // energizers blink (CHOSEN 10 frames)
    ctx.fillStyle = L.dot;
    var cmin = Math.max(0, c0), cmax = Math.min(A.W - 1, c1), rmin = Math.max(0, r0), rmax = Math.min(A.H - 1, r1);
    var dw = L.dotR * 2;
    ctx.beginPath();
    for (var r = rmin; r <= rmax; r++) for (var c = cmin; c <= cmax; c++) {
      if (dots[r * A.W + c] === 1) ctx.rect(c + 0.5 - dw / 2, r + 0.5 - dw / 2, dw, dw);
    }
    ctx.fill();
    if (blinkOn) {
      for (r = rmin; r <= rmax; r++) for (c = cmin; c <= cmax; c++) {
        if (dots[r * A.W + c] !== 2) continue;
        if (pixel) { this.stamp(ctx, energizerSprite(L.dot), c + 0.5, r + 0.5, ox, oy, S); }
        else { ctx.beginPath(); ctx.arc(c + 0.5, r + 0.5, L.energizerR, 0, Math.PI * 2); ctx.fill(); }
      }
    }
    // fruit
    (scene.fruit || []).forEach(function (f) { drawCherry(ctx, f.x, f.y, 0.8); });
    // ghosts
    var self = this;
    scene.ghosts.forEach(function (g) {
      if (g.x < c0 - 2 || g.x > c1 + 2 || g.y < r0 - 2 || g.y > r1 + 2) return;
      if (pixel) self.stamp(ctx, ghostSprite(L, g.ki, g.dir, g.frame, g.mode), g.x, g.y, ox, oy, S);
      else {
        if (L.glow && g.mode !== 3) { ctx.shadowColor = g.mode ? L.fright : L.ghost[g.ki]; ctx.shadowBlur = L.glow * S * 0.6; }
        drawGhost(ctx, L, g.x, g.y, L.ghostR, g.ki, g.dir, g.frame, g.mode);
        ctx.shadowBlur = 0;
      }
    });
    // chompers
    scene.players.forEach(function (p) {
      if (p.x < c0 - 2 || p.x > c1 + 2 || p.y < r0 - 2 || p.y > r1 + 2) return;
      ctx.globalAlpha = p.alpha == null ? 1 : p.alpha;
      var color = p.scared ? (p.scaredFlash ? L.flash : L.fright) : p.color;
      if (p.halo) {
        ctx.strokeStyle = p.color; ctx.lineWidth = pixel ? 1 / 8 : 0.1;
        ctx.globalAlpha *= 0.5 + 0.5 * Math.sin(scene.t / 90);
        ctx.beginPath(); ctx.arc(p.x, p.y, L.chomperR + 0.3, 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = p.alpha == null ? 1 : p.alpha;
      }
      if (p.dying != null) self.deathShape(ctx, p, color, ox, oy, S);
      else if (pixel) self.stamp(ctx, chomperSprite(color, p.dir, p.mouth), p.x, p.y, ox, oy, S);
      else {
        if (L.glow) { ctx.shadowColor = color; ctx.shadowBlur = L.glow * S * 0.6; }
        drawChomper(ctx, p.x, p.y, L.chomperR, p.dir, p.mouth, color);
        ctx.shadowBlur = 0;
      }
      ctx.globalAlpha = 1;
    });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (pixel) {
      var m = this.ctx;
      m.setTransform(1, 0, 0, 1, 0, 0);
      m.imageSmoothingEnabled = false;
      m.drawImage(this.buf, 0, 0, this.buf.width * this.k, this.buf.height * this.k);
      // names and points at screen sharpness, over the scaled-up picture
      this.labels(m, scene, this.S, ox * this.k, oy * this.k);
    } else this.labels(ctx, scene, S, ox, oy);
  };

  // names over the other chompers, and points that pop
  Renderer.prototype.labels = function (ctx, scene, S, ox, oy) {
    var L = this.L;
    var fs = Math.max(10, Math.round(S * 0.42));
    ctx.font = fs + 'px "Press Start 2P", monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    scene.players.forEach(function (p) {
      if (p.me || !p.name || p.dying != null) return;
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = p.color;
      ctx.fillText(p.name, Math.round(ox + p.x * S), Math.round(oy + (p.y - L.chomperR - 0.35) * S));
    });
    ctx.textBaseline = 'middle';
    (scene.pops || []).forEach(function (q) {
      ctx.globalAlpha = q.a;
      ctx.fillStyle = q.color || '#00ffff';
      ctx.fillText(q.text, Math.round(ox + q.x * S), Math.round(oy + q.y * S));
    });
    ctx.globalAlpha = 1;
  };

  // a pixel sprite centred on (x, y) tiles, on whole pixels
  Renderer.prototype.stamp = function (ctx, spr, x, y, ox, oy, S) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(spr, Math.round(ox + x * S - spr.width / 2), Math.round(oy + y * S - spr.height / 2));
    ctx.restore();
  };

  // the death: the mouth opens until the chomper folds away, then a small burst (CHOSEN timing, the arcade's idea)
  Renderer.prototype.deathShape = function (ctx, p, color, ox, oy, S) {
    var k = p.dying;                        // 0..1
    var L = this.L;
    if (k < 0.82) {
      var m = Math.min(1, k / 0.82);
      var a0 = -Math.PI / 2, open = (0.15 + m * 0.85) * Math.PI;
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.moveTo(p.x, p.y);
      ctx.arc(p.x, p.y, L.chomperR, a0 + open, a0 + Math.PI * 2 - open);
      ctx.closePath(); ctx.fill();
    } else {
      var f = (k - 0.82) / 0.18;
      ctx.strokeStyle = color; ctx.lineWidth = L.pixel ? 1 / 8 : 0.09;
      ctx.beginPath();
      for (var i = 0; i < 8; i++) {
        var a = i * Math.PI / 4;
        ctx.moveTo(p.x + Math.cos(a) * (0.25 + f * 0.3), p.y + Math.sin(a) * (0.25 + f * 0.3));
        ctx.lineTo(p.x + Math.cos(a) * (0.5 + f * 0.4), p.y + Math.sin(a) * (0.5 + f * 0.4));
      }
      ctx.stroke();
    }
  };

  Renderer.LOOKS = LOOKS;
  Renderer.lookOf = lookOf;
  Renderer.drawChomper = drawChomper;
  Renderer.drawGhost = drawGhost;
  Renderer.traceWalls = traceWalls;
  root.ChompDraw = Renderer;
})(typeof self !== 'undefined' ? self : this);
