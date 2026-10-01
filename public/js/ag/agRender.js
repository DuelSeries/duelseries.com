// World renderer for the agar.io redo: background grid, world transform, food, player cells,
// viruses, ejected blobs, membranes and their wobble, draw order, names and mass text.
// Every canvas call, its arguments and their order follow the client-render spec (sections
// 1 to 12); every f32(...) below is a real single-precision rounding point of that spec.
// Loads in the browser (DuelAgarLib.agRender) and under node (module.exports).
//
// Frame contract (client-render spec section 1, the caller is agMain):
//   step 6  renderer.sortMain(lists.main)
//   step 8  renderer.beginFrame()                 (text stagger counter)
//   step 9  renderer.updateMembranes(lists, prevView, settings, now)
//   step 10-11 camera and zoom (agCamera)
//   step 12-13 renderer.renderWorld(ctx, lists, view, settings, now)
//   step 15 world clean-up (agWorld); the membrane update is allowed again from here on
// The membrane update runs at most once per drawn frame: a drawn world pass allows it, the
// next call consumes it. The reference page may also run it from the browser's idle callback
// (after the frame, with that frame's view and clock), which is renderer.idle (spec 1.1).
// The world (agWorld) calls renderer.initNode at node creation (the ring starts from the one
// random the world drew for the node, node.points[0]), renderer.setName whenever a record names
// a node (and for own cells with the local nick), and renderer.dropName when a node is removed.
(function (root) {
  'use strict';
  var A = root.DuelAgarLib = root.DuelAgarLib || {};

  var f32 = Math.fround;
  var TAU = 6.283185307179586;
  var INTERP_MS = 100;
  var GRID = 50;
  var MAX_BUCKET_CELLS = 4194304;   // 16 MB of bucket heads (CHOSEN guard, see updateMembranes)

  var BG_LIGHT = 'rgb(242,251,255)';
  var BG_DARK = 'rgb(17,17,17)';
  var LINE_LIGHT = 'rgb(0,0,0)';
  var LINE_DARK = 'rgb(170,170,170)';
  var GOLD_OUTER = 'rgb(255,174,0)';
  var GOLD_INNER = 'rgb(240,236,0)';
  var TEXT_FILL = 'rgb(255,255,255)';
  var TEXT_STROKE = 'rgb(0,0,0)';
  var MEASURE_FONT = '100px Ubuntu';

  // agMath is looked up at call time (Paper wrapper rule); under node it is required once.
  var mathLib = null;
  function M() {
    if (mathLib) return mathLib;
    mathLib = A.agMath || null;
    if (!mathLib && typeof require === 'function') mathLib = require('./agMath.js');
    return mathLib;
  }

  // ---------------------------------------------------------------------------------------
  // Pure helpers (spec sections 4.3, 5.1, 6.2, 6.3)
  // ---------------------------------------------------------------------------------------

  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  // The 100 ms interpolation, size snapping on the INTERPOLATED size (section 4.3, trap 15).
  function interpolate(node, now) {
    var t = clamp01((now - node.updateTime) / INTERP_MS);
    node.x = f32(t * f32(node.toX - node.fromX) + node.fromX);
    node.y = f32(t * f32(node.toY - node.fromY) + node.fromY);
    var si = f32(t * f32(node.toSize - node.fromSize) + node.fromSize);
    node.size = Math.abs(f32(si - node.toSize)) < 0.01 ? node.toSize : si;
    return node;
  }

  // Membrane point count (section 5.1). ts = targetScale, s = draw scale.
  function pointCount(node, ts, s) {
    if (node.virus) return Math.max(Math.trunc(Math.floor(node.size)), 30);
    var m = ts > s ? s : ts;
    if (m > 1) m = 1;
    var n = Math.trunc(m * Math.trunc(Math.floor(node.size)));
    var lo = node.food ? 20 : 10;
    return n > lo ? n : lo;
  }

  function rgbString(c) { return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')'; }

  // The darker edge colour (section 6.2): each channel times 0.9, truncated.
  function darker(c) { return [Math.trunc(c[0] * 0.9), Math.trunc(c[1] * 0.9), Math.trunc(c[2] * 0.9)]; }

  // Ring width (section 6.3); note min(H/1080, W/1920) here, unlike the draw scale's max.
  function ringWidth(highlighted, s, W, H) {
    if (!highlighted) return 5;
    var r = 5 / s;
    var cap = Math.trunc(Math.min(H / 1080, W / 1920) * 20);
    return r > cap ? cap : r;
  }

  // Grid offset (section 2.4): real W*0.5, JS remainder twice.
  function gridOffset(half, s, cam) {
    return ((f32(half / s - cam) % GRID) + GRID) % GRID;
  }

  function normalizeSettings(st) {
    st = st || {};
    return {
      names: st.names !== false,
      showMass: st.showMass === true,
      noColors: st.colors === false || st.noColors === true,
      dark: st.dark === true,
      acid: st.acid === true,
      quality: st.quality | 0,
      fontReady: st.fontReady
    };
  }

  // Lists the renderer reads; agWorld.lists() returns this shape (see build notes).
  function listsOf(world) {
    return (world && typeof world.lists === 'function') ? world.lists() : world;
  }

  function isOwnId(lists, id) {
    var o = lists.ownIds;
    if (!o) return false;
    if (typeof o.has === 'function') return o.has(id);
    return o.indexOf(id) >= 0;
  }

  function ownCellCount(lists) {
    var c = lists.ownCells;
    if (c == null) return 0;
    return typeof c === 'number' ? c : c.length;
  }

  // ---------------------------------------------------------------------------------------
  // The renderer (state: grid tile, name cache, text stagger counter, sort)
  // ---------------------------------------------------------------------------------------

  function createRenderer(opts) {
    opts = opts || {};
    var makeCanvas = opts.createCanvas || function () { return root.document.createElement('canvas'); };
    var random = opts.random || function () { return Math.random(); };
    var partyIcon = opts.partyIcon || null;     // the default party icon image (ours), optional
    var sortBySize = M().makeIntroSort(function (a, b) { return a.size < b.size; });

    var grid = { pattern: null, scale: 0, dark: false };
    var names = new Map();                      // name string -> { refs, levels[4] }
    var frameCounter = 0;
    var membranesAllowed = true;                // allowed on the first frame (spec 1.2)

    // Scratch for the spatial buckets (section 5.3), reused between frames.
    var bucketHead = new Int32Array(0);
    var linkNext = new Int32Array(0);
    var linkPoint = [];

    // ---- text objects (sections 8.2, 8.5) ----------------------------------------------

    function newCanvas(w, h) {
      var c = makeCanvas();
      if (w !== undefined) { c.width = w; c.height = h; }
      return c;
    }

    function textObject(fs, canvas) {
      return { canvas: canvas, ctx: canvas ? canvas.getContext('2d') : null, text: '', fs: fs, scale: 1,
        outline: 0.1, alpha: 1, stroke: true, m100: 0, dirty: true };
    }

    function ensureCanvas(T) {
      if (!T.canvas) { T.canvas = makeCanvas(); T.ctx = T.canvas.getContext('2d'); }
    }

    // Setting a text (8.2/8.4): only a change re-measures at 100 px and marks it dirty.
    function setText(T, s) {
      if (T.text === s) return;
      T.dirty = true;
      T.text = s;
      ensureCanvas(T);
      T.ctx.font = MEASURE_FONT;
      T.m100 = T.ctx.measureText(s).width;
    }

    function fontReady(st) {
      var f = st.fontReady;
      if (f === undefined || f === true) return true;
      if (typeof f === 'function') return !!f();
      return !!f;
    }

    // Rendering a text object into its own canvas (8.5).
    function renderText(T, st) {
      if (!T.dirty || !fontReady(st)) return;
      ensureCanvas(T);
      var g = T.ctx, fs = T.fs, sc = T.scale;
      g.font = (~~fs) + 'px Ubuntu';
      var i04 = Math.trunc(fs * 0.4);
      var pad = fs * T.outline + fs * T.outline;
      var width = Math.trunc((g.measureText(T.text).width + (pad + pad)) * sc);
      var height = Math.trunc(sc * (fs + i04));
      T.canvas.width = width;
      T.canvas.height = height;
      g.textBaseline = 'middle';
      g.font = (~~(fs * sc)) + 'px Ubuntu';
      g.globalAlpha = T.alpha;
      g.lineWidth = sc * (fs * T.outline);
      g.strokeStyle = TEXT_STROKE;
      g.fillStyle = TEXT_FILL;
      var tx = Math.trunc(pad * sc), ty = Math.trunc(height / 2);
      if (T.stroke) g.strokeText(T.text, tx, ty);
      g.fillText(T.text, tx, ty);
      T.dirty = false;
    }

    // A name cache entry (8.2): four levels from 15 * 1.8^k, a level never estimated wider than
    // ten font sizes. The levels are first built and measured on scratch canvases and then
    // copied onto four fresh canvases of the scratch canvases' size; the copies are the ones
    // used. Both sets of canvas sizings are part of the reference call stream, so both happen.
    function buildNameEntry(name) {
      var scratch = [];
      var u = 15;
      for (var L = 0; L < 4; L++) {
        var T = textObject(200, newCanvas(300, 150));
        setText(T, name);
        u = f32(u * 1.8);
        T.fs = u;
        var pad = T.fs * 0.1 + T.fs * 0.1;
        var estW = Math.trunc(1 * ((pad + pad) + T.m100 / 100 * T.fs));
        var lim = f32(u * 10);
        if (lim < estW) T.fs = f32(u / f32(estW / lim));
        scratch.push(T);
      }
      var levels = [];
      for (var k = 0; k < 4; k++) {
        var src = scratch[k];
        var copy = textObject(src.fs, newCanvas(src.canvas.width, src.canvas.height));
        copy.text = src.text; copy.m100 = src.m100; copy.dirty = src.dirty;
        copy.scale = src.scale; copy.outline = src.outline; copy.alpha = src.alpha; copy.stroke = src.stroke;
        levels.push(copy);
      }
      return { refs: 0, levels: levels };
    }

    // A record names a node (or the local nick is re-applied to an own cell): same name does
    // nothing; otherwise the old name loses a user (freed at zero) and the new one gains one.
    function setName(node, name) {
      name = name == null ? '' : String(name);
      var old = node.name || '';
      if (old === name) return;
      releaseEntry(old);
      node.name = name;
      if (!name) return;
      var e = names.get(name);
      if (!e) { e = buildNameEntry(name); names.set(name, e); }
      e.refs++;
    }

    function releaseEntry(name) {
      if (!name) return;
      var e = names.get(name);
      if (!e) return;
      e.refs--;
      if (e.refs <= 0) names.delete(name);
    }

    // Removal drops the node's use of its name; the node keeps the string (a fading node draws
    // its name only while another node still holds the same entry).
    function dropName(node) { releaseEntry(node.name || ''); }

    // Our reconnect (outside the reference's clear-all, which keeps its entries): every node is
    // gone, so every cached name goes too.
    function clearNames() { names.clear(); }

    // ---- node creation (5.1): the ring starts as one point with one random velocity -------

    function initNode(node, ts, s) {
      node.pts = [];
      node.circle = 1;
      node.textStarted = false;
      node.massText = null;
      node.lastMassPx = -1000;
      if (node.name == null) node.name = '';
      fitRing(node, ts, s);
      return node;
    }

    function fitRing(node, ts, s) {
      var n = pointCount(node, ts, s);
      var P = node.pts;
      if (P.length > n) P.length = n;
      if (P.length === 0) {
        // The client world draws the node's one creation random and keeps the first ring point
        // as node.points[0] (spec 5.1); the ring starts from it. A node without one (tests,
        // standalone use) draws it here instead, so it is still exactly one draw per node.
        var seed = node.points && node.points[0];
        P.push(seed ? { cid: seed.cid, px: seed.px, py: seed.py, cx: seed.cx, sy: seed.sy, r: seed.r, v: seed.v }
          : { cid: node.id, px: node.x, py: node.y, cx: 0, sy: 0, r: node.size, v: f32(random() - 0.5) });
      }
      while (P.length < n) {
        var q = P[P.length - 1];
        P.push({ cid: q.cid, px: q.px, py: q.py, cx: q.cx, sy: q.sy, r: q.r, v: q.v });
      }
    }

    // ---- frame steps 6 and 8 ---------------------------------------------------------------

    function sortMain(main) { return sortBySize(main); }
    function beginFrame() { frameCounter = (frameCounter + 1) | 0; return frameCounter; }

    // ---- membranes (section 5), frame step 9, with the PREVIOUS frame's view --------------

    function inView(n, view) {
      var hw = Math.trunc(view.W / 2) / view.s, hh = Math.trunc(view.H / 2) / view.s;
      return !(f32(f32(n.x + n.size) + 40) < view.camX - hw || f32(f32(n.size + n.y) + 40) < view.camY - hh ||
        f32(f32(n.x - n.size) - 40) > view.camX + hw || f32(f32(n.y - n.size) - 40) > view.camY + hh);
    }

    function updateMembranes(world, view, settings, now) {
      if (!membranesAllowed) return false;
      membranesAllowed = false;
      var lists = listsOf(world);
      var st = normalizeSettings(settings);
      var fading = lists.fading || [], main = lists.main || [];
      var s = view.s, ts = view.targetScale;
      var all = fading.length ? fading.concat(main) : main;
      var nAll = all.length, i, n;

      // 5.3 bounds over every node, starting from 0 (the box always holds the origin)
      var maxY = 0, maxX = 0, minY = 0, minX = 0;
      for (i = 0; i < nAll; i++) {
        n = all[i];
        var a = f32(n.size + n.y); if (maxY < a) maxY = a;
        var b = f32(n.x + n.size); if (maxX < b) maxX = b;
        var c = f32(n.y - n.size); if (minY > c) minY = c;
        var d = f32(n.x - n.size); if (minX > d) minX = d;
      }
      var rows = Math.trunc(Math.ceil(f32(f32(maxY - minY) / GRID)));
      var cols = Math.trunc(Math.ceil(f32(f32(maxX - minX) / GRID)));
      var cells = rows * cols;
      // A node box far bigger than any map (only a server bug sends a cell that far out) would
      // need a bucket grid too large to allocate: this frame then fits the rings and decides
      // circle or polygon as usual but buckets and wobbles nothing. CHOSEN guard, never reached
      // with a real map (the full map is about 300 x 300 buckets).
      var bucketsOk = cells <= MAX_BUCKET_CELLS;
      if (bucketsOk) {
        if (bucketHead.length < cells) bucketHead = new Int32Array(cells);
        if (cells > 0) bucketHead.fill(-1, 0, cells);
      }
      var links = 0;
      linkPoint.length = 0;

      function colOf(px) {
        var q = f32(f32(px - minX) / GRID);
        if (q <= 0) return 0;
        var k = Math.trunc(q);
        return k < cols - 1 ? k : cols - 1;
      }
      function rowOf(py) {
        var q = f32(f32(py - minY) / GRID);
        if (q <= 0) return 0;
        var k = Math.trunc(q);
        return k < rows - 1 ? k : rows - 1;
      }

      // 5.2 point count, circle or polygon, bucket insertion (every node, fading list first)
      var vis = new Array(nAll);
      for (i = 0; i < nAll; i++) {
        n = all[i];
        fitRing(n, ts, s);
        var P = n.pts, cnt = P.length, circle;
        if (cnt < 20 || (st.quality === 4 && !n.virus)) {
          circle = 1;
        } else {
          var big = !(s * n.size < 10);
          circle = big ? 0 : 1;
          if (n.circle === 1 && big) {
            for (var k = 0; k < cnt; k++) {
              var q = k * TAU / cnt;
              var p = P[k];
              p.r = n.size; p.v = 0;
              p.sy = f32(Math.sin(q)); p.cx = f32(Math.cos(q));
              p.py = f32(f32(p.sy * n.size) + n.y);
              p.px = f32(f32(p.cx * n.size) + n.x);
            }
          }
        }
        n.circle = circle;
        vis[i] = bucketsOk && !circle && inView(n, view);
        if (!vis[i]) continue;
        for (var j = 0; j < cnt; j++) {
          var pt = P[j];
          var idx = rowOf(pt.py) * cols + colOf(pt.px);
          if (linkNext.length <= links) {
            var grown = new Int32Array(Math.max(1024, links * 2));
            grown.set(linkNext);
            linkNext = grown;
          }
          linkPoint[links] = pt;
          linkNext[links] = bucketHead[idx];
          bucketHead[idx] = links;
          links++;
        }
      }

      var border = lists.border || { minX: 0, minY: 0, maxX: 0, maxY: 0 };
      // 5.4 wobble, in-view polygon nodes, fading list first, then the sorted main list
      for (i = 0; i < nAll; i++) {
        if (!vis[i]) continue;
        wobble(all[i], s, now, border, colOf, rowOf, cols);
      }
      return true;
    }

    // The idle pass (spec 1.1): the membrane update if still allowed, then every node of the
    // fading list and then the main list re-interpolated at the client clock. The caller then
    // runs the world clean-up, as the reference idle pass does.
    function idle(world, view, settings, now) {
      var lists = listsOf(world);
      updateMembranes(lists, view, settings, now);
      var fading = lists.fading || [], main = lists.main || [], i;
      for (i = 0; i < fading.length; i++) interpolate(fading[i], now);
      for (i = 0; i < main.length; i++) interpolate(main[i], now);
    }

    function endFrame() { membranesAllowed = true; }

    function touching(px, py, id, colOf, rowOf, cols) {
      var c0 = colOf(px), r0 = rowOf(py);
      var c1 = colOf(f32(px + 10)), r1 = rowOf(f32(py + 10));
      for (var cx = c0; cx <= c1; cx++) {
        for (var ry = r0; ry <= r1; ry++) {
          for (var l = bucketHead[ry * cols + cx]; l !== -1; l = linkNext[l]) {
            var o = linkPoint[l];
            if (o.cid === id) continue;
            var dx = px - o.px, dy = py - o.py;
            if (dx * dx + dy * dy < 25) return true;
          }
        }
      }
      return false;
    }

    function wobble(n, s, now, border, colOf, rowOf, cols) {
      var P = n.pts, cnt = P.length, t, p;
      var k = n.agitated ? 3 : 1;
      // pass A: velocities (one Math.random per point, in index order)
      for (t = 0; t < cnt; t++) {
        var prev = P[(t + cnt - 1) % cnt].v, next = P[(t + 1) % cnt].v;
        var w = f32(f32((random() - 0.5) * k + P[t].v) * 0.7);
        var b = w > 10 ? 10 : (w < -10 ? -10 : w);
        P[t].v = f32((prev + next + f32(b * 8)) / 10);
      }
      // pass B: phase
      var phase = n.virus ? 0 : f32(((n.id >>> 0) / 1000 + now / 10000) % TAU);
      // pass C: radii and positions
      var mf = M(), step = f32(TAU / cnt), collide = !n.food && s * n.size > 20;
      for (t = 0; t < cnt; t++) {
        p = P[t];
        var cur = p.r, nextR = P[(t + 1) % cnt].r, prevR = P[(t + cnt - 1) % cnt].r;
        if (collide) {
          var x = p.px, y = p.py;
          if (touching(x, y, n.id, colOf, rowOf, cols) ||
            x < border.minX || y < border.minY || x > border.maxX || y > border.maxY) {
            p.v = p.v > 0 ? -1 : f32(p.v - 1);
          }
        }
        var bb = f32(cur + p.v); if (bb < 0) bb = 0;
        var m = n.agitated ? f32(f32(f32(bb * 19) + n.size) / 20) : f32(f32(f32(bb * 12) + n.size) / 13);
        var R = f32(f32(f32(m * 8) + f32(prevR + nextR)) / 10);
        p.r = R;
        var ang = f32(f32(step * t) + phase);
        p.sy = mf.sinf(ang);
        p.cx = mf.cosf(ang);
        var Rs = (t & 1) ? R : (n.virus ? f32(R + 5) : R);
        p.px = f32(p.cx * Rs + n.x);
        p.py = f32(p.sy * Rs + n.y);
      }
    }

    // ---- background and grid (section 2), frame step 12 ------------------------------------

    function rebuildTile(ctx, s, dark) {
      var c = newCanvas(GRID, GRID);
      var g = c.getContext('2d');
      g.fillStyle = dark ? BG_DARK : BG_LIGHT;
      g.fillRect(0, 0, GRID, GRID);
      g.strokeStyle = dark ? LINE_DARK : LINE_LIGHT;
      g.globalAlpha = s * 0.2;
      g.lineWidth = 1 / s;
      g.beginPath();
      g.moveTo(0.5, 0.5); g.lineTo(0.5, 50.5);
      g.moveTo(0.5, 0.5); g.lineTo(50.5, 0.5);
      g.stroke();
      grid.pattern = ctx.createPattern(c, null);
      grid.scale = s;
      grid.dark = dark;
    }

    function drawBackground(ctx, view, settings) {
      var st = normalizeSettings(settings);
      var W = view.W, H = view.H, s = view.s;
      if (st.acid) {
        ctx.fillStyle = st.dark ? BG_DARK : BG_LIGHT;
        ctx.globalAlpha = 0.05;
        ctx.fillRect(0, 0, W, H);
        ctx.globalAlpha = 1;
        return;
      }
      ctx.save();
      if (!grid.pattern || grid.dark !== st.dark || Math.abs(grid.scale - s) > 0.1) rebuildTile(ctx, s, st.dark);
      var tx = gridOffset(W * 0.5, s, view.camX);
      var ty = gridOffset(H * 0.5, s, view.camY);
      ctx.scale(s, s);
      ctx.save();
      ctx.translate(f32(f32(tx) - GRID), f32(f32(ty) - GRID));
      ctx.fillStyle = grid.pattern;
      ctx.fillRect(0, 0, W / s + GRID, H / s + GRID);
      ctx.restore();
      ctx.restore();
    }

    // Frame step 3 (the caller decides when): the main canvas is cleared unless acid is on.
    function clearFrame(ctx, W, H, settings) {
      if (!normalizeSettings(settings).acid) ctx.clearRect(0, 0, W, H);
    }

    // ---- world pass (section 3), frame step 13 ---------------------------------------------

    function drawWorld(ctx, world, view, settings, now) {
      var lists = listsOf(world);
      var st = normalizeSettings(settings);
      var fading = lists.fading || [], main = lists.main || [];
      var own = ownCellCount(lists);
      ctx.save();
      ctx.translate(Math.trunc(view.W / 2), Math.trunc(view.H / 2));
      ctx.scale(view.s, view.s);
      ctx.translate(-view.camX, -view.camY);
      var i;
      for (i = 0; i < fading.length; i++) drawNode(ctx, fading[i], lists, own, view, st, now);
      for (i = 0; i < main.length; i++) drawNode(ctx, main[i], lists, own, view, st, now);
      ctx.restore();
      membranesAllowed = true;
    }

    function renderWorld(ctx, world, view, settings, now) {
      drawBackground(ctx, view, settings);
      drawWorld(ctx, world, view, settings, now);
    }

    // ---- one node (section 6) ----------------------------------------------------------

    function ringPath(ctx, n, radiusOf) {
      var P = n.pts, cnt = P.length;
      var w = radiusOf(P[0].r);
      if (n.virus) w = f32(w + 5);
      ctx.moveTo(f32(n.x + f32(P[0].cx * w)), f32(f32(P[0].sy * w) + n.y));
      for (var d = 1; d <= cnt; d++) {
        var i = d === cnt ? 0 : d;
        var p = P[i];
        w = radiusOf(p.r);
        if (n.virus && !(d & 1)) w = f32(w + 5);
        ctx.lineTo(f32(n.x + f32(p.cx * w)), f32(f32(p.sy * w) + n.y));
      }
    }

    function drawNode(ctx, n, lists, ownCount, view, st, now) {
      interpolate(n, now);
      ctx.save();
      if (n.dying) ctx.globalAlpha = 1 - clamp01((now - n.updateTime) / INTERP_MS);
      ctx.lineWidth = 10;
      ctx.lineCap = 'round';
      ctx.lineJoin = n.virus ? 'miter' : 'round';

      var rgb = n.rgb || [0, 0, 0];
      var col = st.noColors ? [255, 255, 255] : rgb;
      var dk = st.noColors ? [170, 170, 170] : darker(rgb);
      var hi = !!n.highlight;
      var r = ringWidth(hi, view.s, view.W, view.H);
      var x = n.x, y = n.y, size = n.size;

      if (n.circle) {
        ctx.beginPath();
        ctx.arc(x, y, size + r, 0, TAU, 0);
        ctx.closePath();
        if (n.food) {
          ctx.fillStyle = rgbString(col);
          ctx.fill();
        } else if (hi) {
          ctx.fillStyle = GOLD_OUTER;
          ctx.fill();
          ctx.beginPath();
          ctx.arc(x, y, r * 0.5 + size, 0, TAU, 0);
          ctx.closePath();
          ctx.fillStyle = GOLD_INNER;
          ctx.fill();
          ctx.beginPath();
          ctx.arc(x, y, size, 0, TAU, 0);
          ctx.closePath();
          ctx.fillStyle = rgbString(col);
          ctx.fill();
        } else {
          ctx.fillStyle = rgbString(dk);
          ctx.fill();
          ctx.beginPath();
          ctx.arc(x, y, size, 0, TAU, 0);
          ctx.closePath();
          ctx.fillStyle = rgbString(col);
          ctx.fill();
        }
      } else {
        ctx.beginPath();
        ringPath(ctx, n, function (pr) { return f32(r + pr); });
        ctx.closePath();
        ctx.fillStyle = rgbString(n.food && !st.noColors ? col : dk);
        ctx.fill();
        if (!n.food) {
          var inset = hi ? 1 : r;
          ctx.beginPath();
          ringPath(ctx, n, function (pr) { return f32(pr - inset); });
          ctx.closePath();
          ctx.fillStyle = rgbString(col);
          if (hi) {
            ctx.lineWidth = r + r;
            ctx.strokeStyle = GOLD_OUTER;
            ctx.stroke();
            ctx.lineWidth = r;
            ctx.strokeStyle = GOLD_INNER;
            ctx.stroke();
          }
          ctx.fill();
        }
      }
      drawText(ctx, n, lists, ownCount, view, st);
      ctx.restore();
    }

    // ---- names, mass text and the party icon (section 8) --------------------------------

    function drawText(ctx, n, lists, ownCount, view, st) {
      if (!n.textStarted && ((n.id + frameCounter) >>> 0) % 10 !== 0) return;
      if (n.food || n.virus || n.ejected) return;
      n.textStarted = true;
      var own = isOwnId(lists, n.id);
      var name = n.name || '';
      var showName = (own || st.names) && name.length > 0;
      var showMass = st.showMass && (own || ownCount === 0);
      var x = n.x, y = n.y, size = n.size, ts = view.targetScale;

      if ((n.friend || n.highlight) && !own) drawPartyIcon(ctx, x, y, size);

      var wMass = f32(size * 0.5 * 1.75);
      if (showName) {
        var entry = names.get(name);
        if (!entry) {
          wMass = f32(size * 0.5);
        } else {
          var T3 = entry.levels[3];
          var pad3 = T3.fs * 0.1 + T3.fs * 0.1;
          var texW = f32(Math.trunc(T3.scale * ((pad3 + pad3) + T3.m100 / 100 * T3.fs)));
          var texH = f32(Math.trunc(T3.scale * (T3.fs + Math.trunc(T3.fs * 0.4))));
          var maxW = f32(size * 3), maxH = f32(size * 0.8);
          var w, h;
          if (f32(texW / texH) > f32(maxW / maxH)) {
            w = maxW;
            h = f32(maxH / f32(f32(f32(maxH / texH) * texW) / maxW));
          } else {
            h = maxH;
            w = f32(maxW / f32(f32(f32(maxW / texW) * texH) / maxH));
          }
          wMass = h;
          var onScreen = f32(ts * h);
          if (onScreen > 10) {
            var level = Math.ceil(M().log2f(f32(onScreen / 15))) - 1;
            level = level < 0 ? 0 : (level > 3 ? 3 : level);
            var T = entry.levels[level];
            renderText(T, st);
            if (T.canvas) {
              ctx.drawImage(T.canvas, 0, 0, T.canvas.width, T.canvas.height, f32(x - w * 0.5), f32(y - h * 0.5), w, h);
            }
          }
        }
      }

      if (!showMass) return;
      var MT = n.massText || (n.massText = textObject(200, null));
      setText(MT, String(Math.trunc(Math.floor(f32(f32(size * size) / 100)))));
      var pad = MT.fs * 0.1 + MT.fs * 0.1;
      var mTexH = f32(Math.trunc(MT.scale * (MT.fs + Math.trunc(MT.fs * 0.4))));
      var z = f32(f32(wMass / mTexH) * 0.5);
      var hgt = f32(z * mTexH); if (hgt < 22) hgt = 22;
      var mTexW = Math.trunc(MT.scale * ((pad + pad) + MT.m100 / 100 * MT.fs));
      var px = f32(ts * hgt);
      if (Math.abs(f32(n.lastMassPx - px)) > 10) {
        if (MT.fs !== px) { MT.fs = px; MT.dirty = true; }
        n.lastMassPx = px;
      }
      renderText(MT, st);
      if (!MT.canvas) return;
      var wid = f32(z * mTexW); if (wid < 25) wid = 25;
      var top = showName ? f32(wMass * 0.3 + y) : f32(y + hgt * -0.5);
      ctx.drawImage(MT.canvas, 0, 0, MT.canvas.width, MT.canvas.height, f32(x + wid * -0.5), top, wid, hgt);
    }

    // Party icon (8.1.1): a guest has no profile pictures, so the default icon, half size,
    // unclipped, centred half a size above the node centre. All double maths.
    function drawPartyIcon(ctx, x, y, size) {
      ctx.save();
      var img = partyIcon;
      var r = size, t = y + r * -0.5, v = x;
      var iw = img ? (img.width | 0) : 0, ih = img ? (img.height | 0) : 0;
      var a = iw / ih, w, h;
      if (a < 1) { w = r; h = r / a; } else { w = a * r; h = r; }
      w = w * 0.5; h = h * 0.5;
      if (img && img.complete !== false) ctx.drawImage(img, 0, 0, img.width, img.height, v - w * 0.5, t - h * 0.5, w, h);
      ctx.restore();
    }

    return {
      initNode: initNode,
      setName: setName,
      dropName: dropName,
      clearNames: clearNames,
      nameCount: function () { return names.size; },
      sortMain: sortMain,
      beginFrame: beginFrame,
      updateMembranes: updateMembranes,
      idle: idle,
      endFrame: endFrame,
      clearFrame: clearFrame,
      drawBackground: drawBackground,
      drawWorld: drawWorld,
      renderWorld: renderWorld,
      nameEntry: function (name) { return names.get(name) || null; },
      get frameCounter() { return frameCounter; }
    };
  }

  var agRender = {
    TAU: TAU,
    INTERP_MS: INTERP_MS,
    createRenderer: createRenderer,
    interpolate: interpolate,
    pointCount: pointCount,
    darker: darker,
    ringWidth: ringWidth,
    gridOffset: gridOffset,
    rgbString: rgbString,
    normalizeSettings: normalizeSettings
  };
  A.agRender = agRender;
  if (typeof module !== 'undefined' && module.exports) module.exports = agRender;
})(typeof window !== 'undefined' ? window : globalThis);
