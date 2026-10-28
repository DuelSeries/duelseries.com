/* The skins' previews in the lobby (Owen, 2026-10-15). Drawing only: buying
   is public/js/v2/skinBuy.js and the server (docs/skin-purchases.md). The
   skins themselves and the drawing the games share are in
   shared/shopSkins.js; prices are in shared/shopPrices.js, the one file Owen
   edits.

   Every preview is drawn the way that game draws its own player, from that
   game's own code where it can be loaded and from a copy of its few drawing
   lines where it cannot:
     slither.io     slither's own sprites through V2Look (public/js/v2/look.js,
                    which reads the frozen public/js/sl/slSprites.js). A shop
                    snake is a slither custom skin: runs of [count, colour]
                    from the colours slither lets a custom skin use (0 to 35,
                    37, 39, 41).
     agar.io        public/js/ag/agRender.js drawNode, the small-cell case: a
                    rim 5 wide in the colour times 0.9, then the cell. The
                    design inside is clipped to the cell, as agar's picture
                    skins are.
     Paper.io       public/js/paper/paperSkins.js deriveColorSet (back = value
                    times 0.75, nick = times 0.5) and paperRender.js: the top
                    lifted 2 over its side, the trail at 0.6 alpha, the head
                    square with its 80 percent centre.
     Knockout       public/js/knockout.js draw(): the disc, then the darker
                    inner disc at 0.58 of the radius, raised 0.12.
     Battleship     BattleshipArt.drawShip (public/js/battleshipArt.js) with
                    its HULL colours swapped for the call and put back.
     Awesome Tanks  ShooterArt.drawTank (public/js/shooterArt.js) with the
                    skin as one more TEAMS entry.
     Bowmasters     public/js/tanks.js drawTank: the trapezium hull and the
                    round-capped barrel in one body colour.

   In Customize (bare) every piece moves in its own game's way, off a clock
   in seconds: agar's cell breathes and coasts, Paper.io's head runs a loop
   and claims it, the Knockout piece is flicked into the other, the ship
   rides a swell, the Awesome Tanks hull turns under a hunting turret, and
   the Bowmasters tank aims and fires.

   Exposes window.V2Shop = {games, game(id), price(g, k), tier(p), tiers,
   paint(canvas, gameId, skinId, t, big, bare), paintWith(canvas, gameId,
   look, t, big, bare), animated(gameId)}. */
(function (root) {
  'use strict';
  var PR = root.DS_SHOP_PRICES;
  /* The skins and the drawing the games share: shared/shopSkins.js (loaded before this file). */
  var SK = root.DS_SHOP_SKINS;

  /* ── colour helpers ─────────────────────────────────────────────────── */
  function hexRgb(h) { var n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
  function rgbHex(c) { return '#' + c.map(function (v) { v = Math.max(0, Math.min(255, Math.round(v))); return (v < 16 ? '0' : '') + v.toString(16); }).join(''); }
  /* Paper's HSV, value 0 to 100 (paperGeom.js hsvScaleValue). */
  function hsvScale(hex, f) {
    var c = hexRgb(hex), r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, h = 0;
    if (d) h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    var s = mx ? d / mx : 0, v = mx * f;
    var i = Math.floor(h), fr = h - i, p = v * (1 - s), q = v * (1 - s * fr), t = v * (1 - s * (1 - fr));
    var o = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
    return rgbHex([o[0] * 255, o[1] * 255, o[2] * 255]);
  }
  /* A free look that changes every life shows its colours in turn. */
  function colOf(k, t) { return k.cols ? k.cols[Math.floor(t / 1.6) % k.cols.length] : k.col; }
  function mix(a, b, f) { var x = hexRgb(a), y = hexRgb(b); return rgbHex([0, 1, 2].map(function (i) { return x[i] + (y[i] - x[i]) * f; })); }

  /* ── the skins ──────────────────────────────────────────────────────────
     `id` is the key in shared/shopPrices.js. The order here is the order on
     the page, cheapest first. */
  var GAMES = [
    { id: 'snake', name: 'Slither.io', bg: '#0e1622', skins: SK.SKINS.snake },
    { id: 'paper', name: 'Paper.io', bg: '#e7fff4',
      /* The arena hands out a free colour from its palette (paperSkins.js). */
      def: { name: 'Random colour', cols: ['#3b7dd8', '#f77f00', '#1a936f', '#ff3377', '#8874a3', '#fcbf49'] }, skins: SK.SKINS.paper },
    { id: 'agar', name: 'Agar.io', bg: 'rgb(242,251,255)',
      /* The server deals a colour every life (one channel 255, one 7, the third
         anything between; server/ag/agSim.js playerColour), so the free look
         walks through a few of those. */
      def: { name: 'Random colour', cols: ['#ff4007', '#07ff8a', '#5a07ff', '#ffd407', '#07c4ff', '#ff07a8'] }, skins: SK.SKINS.agar },
    /* Pac-Man (chomp, its shown name shared/chompName.js): the game's own yellow, then the free colours of
       shared/chompSkins.js in Customize. */
    { id: 'chomp', name: root.DS_CHOMP_NAME || 'Chomp', bg: '#000000', def: { name: 'Classic yellow', col: '#ffff00' },
      skins: SK.SKINS.chomp },
    { id: 'knockout', name: 'Knockout', bg: '#0b0907', def: { name: 'Default', col: '#f4f1ea' }, skins: SK.SKINS.knockout },
    { id: 'battleship', name: 'Battleship', bg: '#0a1622', def: { name: 'Default', native: true }, skins: SK.SKINS.battleship },
    { id: 'omgshooter', name: 'Awesome Tanks', bg: '#1d2016', def: { name: 'Default', team: 'you' }, skins: SK.SKINS.omgshooter },
    { id: 'tanks', name: 'Bowmasters', bg: '#14110d', def: { name: 'Default', col: '#f4f1ea' }, skins: SK.SKINS.tanks },
  ];
  var BY = {};
  GAMES.forEach(function (g) { BY[g.id] = g; g.by = {}; g.skins.forEach(function (k) { g.by[k.id] = k; }); });
  /* Games with free Customize looks and no Shop yet: found by game(id), so Customize draws their chooser, but not in
     `games`, so the Shop does not list them. Air Hockey: its neon cyan, then shared/ahSkins.js's colours. */
  [{ id: 'airhockey', name: 'Air Hockey', bg: '#03070d', def: { name: 'Neon cyan', col: '#2ff3ff' }, skins: [] }]
    .forEach(function (g) { BY[g.id] = g; g.by = {}; });

  /* ── slither.io ───────────────────────────────────────────────────────── */
  /* look.js draws slither's own chooser snake; these say only how much of
     the box it may fill. */
  var SL_CARD = { lenFrac: 0.82, hFrac: 0.8 };
  var SL_BIG = { lenFrac: 0.7, hFrac: 0.8 };
  function paintSnake(cv, k, t, big) {
    if (!root.V2Look) return;
    root.V2Look.paint(cv, k.runs, big ? SL_BIG : SL_CARD, t);
  }

  /* ── agar.io ──────────────────────────────────────────────────────────── */
  /* agar's membrane (agRender.js wobble): past the small-cell case a cell is a
     ring of points whose radii breathe, and the ring turns at now/10000, 0.1
     radians a second. The preview keeps that look with three slow sines per
     point instead of their random walk, which needs a running world. */
  function membrane(ctx, x, y, R, t) {
    var n = 48;
    ctx.beginPath();
    for (var i = 0; i <= n; i++) {
      var a = i / n * 6.2832 + t * 0.1;
      var rr = R * (1 + 0.012 * Math.sin(a * 5 + t * 2.3) + 0.008 * Math.sin(a * 3 - t * 1.5) + 0.005 * Math.sin(a * 9 + t * 3.1));
      if (i) ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); else ctx.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    ctx.closePath();
  }
  function paintAgar(cv, k, t, big, bare) {
    var ctx = cv.getContext('2d'), w = cv.width, h = cv.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (bare) { ctx.clearRect(0, 0, w, h); paintAgarCell(ctx, k, t, w, h); return; }
    else {
    ctx.fillStyle = 'rgb(242,251,255)';                   // agRender BG_LIGHT
    ctx.fillRect(0, 0, w, h);
    /* The 50-unit grid at agar's 0.2 alpha black, about 3 squares across. */
    var step = h / 3.2;
    ctx.strokeStyle = 'rgb(0,0,0)'; ctx.globalAlpha = 0.2; ctx.lineWidth = 1;
    ctx.beginPath();
    for (var gx = (w / 2) % step; gx < w; gx += step) { ctx.moveTo(Math.round(gx) + 0.5, 0); ctx.lineTo(Math.round(gx) + 0.5, h); }
    for (var gy = (h / 2) % step; gy < h; gy += step) { ctx.moveTo(0, Math.round(gy) + 0.5); ctx.lineTo(w, Math.round(gy) + 0.5); }
    ctx.stroke(); ctx.globalAlpha = 1;
    }
    var x = w / 2, y = h / 2, R = Math.min(w, h) * (bare ? 0.38 : big ? 0.34 : 0.33);
    var col = colOf(k, t);
    var ring = Math.max(2, R * 0.07);                     // rim 5 at a cell of ~70
    var c = hexRgb(col);
    ctx.fillStyle = rgbHex([Math.trunc(c[0] * 0.9), Math.trunc(c[1] * 0.9), Math.trunc(c[2] * 0.9)]);
    ctx.beginPath(); ctx.arc(x, y, R + ring, 0, 6.2832); ctx.fill();
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(x, y, R, 0, 6.2832); ctx.fill();
    if (!k.art) return;
    ctx.save(); ctx.beginPath(); ctx.arc(x, y, R, 0, 6.2832); ctx.clip();
    SK.agarArt(ctx, k, x, y, R);
    ctx.restore();
  }
  /* Customize's cell: the membrane, drifting on a slow loop the way a cell
     coasts after the mouse, its rim at 0.9 of the colour as in play. */
  function paintAgarCell(ctx, k, t, w, h) {
    var R = Math.min(w, h) * 0.34;
    var x = w / 2 + Math.sin(t * 0.8) * R * 0.14, y = h / 2 + Math.sin(t * 1.15) * R * 0.07;
    var col = colOf(k, t), c = hexRgb(col), ring = Math.max(2, R * 0.07);
    ctx.fillStyle = rgbHex([Math.trunc(c[0] * 0.9), Math.trunc(c[1] * 0.9), Math.trunc(c[2] * 0.9)]);
    membrane(ctx, x, y, R + ring, t); ctx.fill();
    ctx.fillStyle = col;
    membrane(ctx, x, y, R, t); ctx.fill();
    if (!k.art) return;
    ctx.save(); membrane(ctx, x, y, R, t); ctx.clip();
    SK.agarArt(ctx, k, x, y, R);
    ctx.restore();
  }

  /* ── Paper.io ─────────────────────────────────────────────────────────── */
  function paintPaper(cv, k, t, big, bare) {
    var ctx = cv.getContext('2d'), w = cv.width, h = cv.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (bare) ctx.clearRect(0, 0, w, h);
    else { ctx.fillStyle = '#e7fff4'; ctx.fillRect(0, 0, w, h); }   // paper-arena.css body
    var main = colOf(k, t), back = hsvScale(main, 0.75), nick = hsvScale(main, 0.5);
    var u = bare ? Math.min(w / 30, h / 22) : Math.min(w, h) / 30;   // world units: trackWidth 8, baseHeight 2
    var s = u * 15, x0 = (w - 30 * u) / 2, y0 = (h - s) / 2 + u;
    /* Territory: its side in `back`, then the top lifted baseHeight. */
    ctx.fillStyle = back; ctx.fillRect(x0, y0, s, s);
    ctx.fillStyle = main; ctx.fillRect(x0, y0 - 2 * u, s, s);
    SK.paperArt(ctx, k, x0, y0 - 2 * u, s, k.art === 'stars' ? '#ffffff' : back);
    /* The game in one loop: the head leaves its land, runs a box out and back,
       and the box it drew becomes land, then it starts again. The trail is
       main at 0.6, trackWidth wide with round caps. */
    var ty = y0 - 2 * u, P = [[x0 + s - 3 * u, ty + s * 0.74], [x0 + s + 9 * u, ty + s * 0.74],
      [x0 + s + 9 * u, ty + s * 0.16], [x0 + s - 3 * u, ty + s * 0.16]];
    var seg = [12 * u, s * 0.58, 12 * u], total = seg[0] + seg[1] + seg[2];
    var CYCLE = 3.2, RUN = 0.78, ph = (t % CYCLE) / CYCLE;
    var run = Math.min(1, ph / RUN), d = run * total, i = 0;
    while (i < 2 && d > seg[i]) { d -= seg[i]; i++; }
    var f = Math.min(1, d / seg[i]);
    var hx = P[i][0] + (P[i + 1][0] - P[i][0]) * f, hy = P[i][1] + (P[i + 1][1] - P[i][1]) * f;
    if (ph >= RUN) {
      /* Captured: the box is land now, side and top like the rest. */
      var bx = x0 + s - 0.5 * u, bw = 9 * u + 4 * u, byy = ty + s * 0.16 - 4 * u, bh = s * 0.58 + 8 * u;
      ctx.globalAlpha = Math.min(1, (ph - RUN) / 0.06);
      ctx.fillStyle = back; ctx.fillRect(bx, byy + 2 * u, bw, bh);
      ctx.fillStyle = main; ctx.fillRect(bx, byy, bw, bh);
      ctx.globalAlpha = 1;
    } else {
      ctx.globalAlpha = 0.6; ctx.strokeStyle = main; ctx.lineWidth = 8 * u; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(P[0][0], P[0][1]);
      for (var q = 1; q <= i; q++) ctx.lineTo(P[q][0], P[q][1]);
      ctx.lineTo(hx, hy); ctx.stroke(); ctx.globalAlpha = 1;
    }
    /* The head: the nick square, then the back square with its main centre,
       lifted baseHeight, 8 units across. */
    var hs = 8 * u;
    ctx.fillStyle = nick; ctx.fillRect(hx - hs / 2, hy - hs / 2 + 2 * u, hs, hs);
    ctx.fillStyle = back; ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
    ctx.fillStyle = main; ctx.fillRect(hx - hs * 0.4, hy - hs * 0.4, hs * 0.8, hs * 0.8);
  }

  /* ── Knockout ─────────────────────────────────────────────────────────── */
  function paintKnockout(cv, k, t, big, bare) {
    var ctx = cv.getContext('2d'), w = cv.width, h = cv.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (bare) {
      /* A flick and a hit, on a loop: the left piece slides in, stops dead on
         the right one and knocks it on, and both drift back to start. */
      ctx.clearRect(0, 0, w, h);
      var br = Math.min(h * 0.3, w * 0.16), c = w / 2;
      var ph = (t % 2.6) / 2.6, ease = function (v) { return v * v * (3 - 2 * v); };
      var aX0 = c - 2 * br, bX0 = c + 0.9 * br, hitA = bX0 - 2 * br, ax = aX0, bx = bX0;
      if (ph < 0.3) ax = aX0 + (hitA - aX0) * Math.pow(ph / 0.3, 1.6);
      else if (ph < 0.72) { var g = (ph - 0.3) / 0.42; ax = hitA - br * 0.12 * Math.sin(Math.PI * g); bx = bX0 + br * (1 - Math.pow(1 - g, 3)); }
      else { var e = ease((ph - 0.72) / 0.28); ax = hitA + (aX0 - hitA) * e; bx = bX0 + br * (1 - e); }
      SK.knockoutPiece(ctx, k, ax, h / 2, br);
      SK.knockoutPiece(ctx, k, bx, h / 2, br);
      return;
    }
    ctx.fillStyle = '#0b0907'; ctx.fillRect(0, 0, w, h);
    /* Close in on the disc: the piece is what is for sale, so the field runs
       off the edges rather than shrinking the piece to fit it. */
    var cx = w / 2, cy = h / 2 + h * 0.1, R = Math.min(w * 0.5, h * 0.62);
    var g = ctx.createRadialGradient(cx, cy - R * 0.35, R * 0.1, cx, cy, R);
    g.addColorStop(0, '#241d16'); g.addColorStop(1, '#171310');
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 6.2832); ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = '#f0a830'; ctx.lineWidth = Math.max(1.5, R * 0.012); ctx.stroke();
    var pr = Math.min(w, h) * 0.17;
    SK.knockoutPiece(ctx, k, cx - pr * 1.35, h * 0.5, pr);
    SK.knockoutPiece(ctx, k, cx + pr * 1.35, h * 0.42, pr);
  }

  /* ── Battleship ───────────────────────────────────────────────────────── */
  function paintBattleship(cv, k, t, big, bare) {
    var BA = root.BattleshipArt; if (!BA) return;
    var ctx = cv.getContext('2d'), w = cv.width, h = cv.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    var cell = bare ? Math.min(w / 4.6, h * 0.42) : w / 4.5, x0 = (w - cell * 4) / 2, y0 = (h - cell) / 2;
    if (bare) ctx.clearRect(0, 0, w, h);
    else {
    ctx.fillStyle = '#0a1622'; ctx.fillRect(0, 0, w, h);   // battleship.js water
    ctx.strokeStyle = '#1d3348'; ctx.lineWidth = 1; ctx.beginPath();
    for (var x = x0 - cell * 2; x < w; x += cell) { ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, h); }
    for (var y = y0 - cell * 3; y < h; y += cell) { ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(w, Math.round(y) + 0.5); }
    ctx.stroke();
    }
    /* Customize's ship rides a swell: a slow rise and fall and a little roll. */
    if (bare) {
      ctx.translate(w / 2, h / 2 + Math.sin(t * 1.6) * cell * 0.07);
      ctx.rotate(Math.sin(t * 1.1) * 0.035);
      ctx.translate(-w / 2, -h / 2);
    }
    if (k.native) { BA.drawShip(ctx, 'battleship', 4, x0, y0, cell, true, 0.95); ctx.setTransform(1, 0, 0, 1, 0, 0); return; }
    /* drawShip reads BattleshipArt.HULL as it draws: swap the skin in for the
       call, then put the game's own colours straight back. */
    var H = BA.HULL, keep = {}, mine = SK.hullFor(k), key;
    for (key in mine) { keep[key] = H[key]; H[key] = mine[key]; }
    try { BA.drawShip(ctx, 'battleship', 4, x0, y0, cell, true, 0.95); }
    finally { for (key in keep) H[key] = keep[key]; ctx.setTransform(1, 0, 0, 1, 0, 0); }
  }

  /* ── Awesome Tanks ────────────────────────────────────────────────────── */
  function teamFor(k) {
    return {
      rim: k.rim, rimDim: mix(k.rim, '#000000', 0.2), core: k.core, panel: k.panel,
      barrel: mix(k.panel, '#000000', 0.35), barrelDim: k.core, lit: mix(k.rim, '#ffffff', 0.55),
      track: mix(k.core, '#000000', 0.5), line: '#000000',
    };
  }
  function paintShooter(cv, k, t, big, bare) {
    var SA = root.ShooterArt; if (!SA) return;
    var ctx = cv.getContext('2d'), w = cv.width, h = cv.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (bare) ctx.clearRect(0, 0, w, h);
    else { ctx.fillStyle = '#1d2016'; ctx.fillRect(0, 0, w, h); }
    var team = k.team || 'shop:' + k.id;
    if (!SA.TEAMS[team]) SA.TEAMS[team] = teamFor(k);
    /* The hull swings round slowly while the turret hunts faster on top of it. */
    var hull = -0.35 + (bare ? Math.sin(t * 0.6) * 0.5 : 0);
    SA.drawTank(ctx, { x: w / 2, y: h / 2, size: Math.min(w, h) * (bare ? 0.7 : 0.5), team: team,
      hull: hull, turret: hull + Math.sin(t * (bare ? 1.7 : 0.8)) * (bare ? 0.8 : 0.6) });
  }

  /* ── Bowmasters ───────────────────────────────────────────────────────── */
  function paintTanks(cv, k, t, big, bare) {
    var ctx = cv.getContext('2d'), w = cv.width, h = cv.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    var gy = h * 0.7;
    if (bare) { ctx.clearRect(0, 0, w, h); gy = h * 0.8; }
    else {
    var g = ctx.createLinearGradient(0, 0, 0, h);         // tanks.js sky
    g.addColorStop(0, '#14110d'); g.addColorStop(0.62, '#241a12'); g.addColorStop(1, '#3a2a18');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    var gg = ctx.createLinearGradient(0, gy, 0, h);        // tanks.js ground
    gg.addColorStop(0, '#191309'); gg.addColorStop(1, '#0c0906');
    ctx.fillStyle = gg; ctx.beginPath(); ctx.moveTo(0, gy + h * 0.04);
    ctx.quadraticCurveTo(w * 0.5, gy - h * 0.05, w, gy + h * 0.03); ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.fill();
    }
    var k2 = Math.min(w, h) / (bare ? 42 : 70), tw = 34 * k2, th = 16 * k2, gx = w / 2, base = gy;
    var rad = (40 + Math.sin(t * (bare ? 1.8 : 0.9)) * (bare ? 16 : 12)) * Math.PI / 180;
    /* Customize's tank fires every 1.4 seconds: it kicks back and a puff
       leaves the muzzle. */
    var kick = 0;
    if (bare) { var ph = (t % 1.4) / 1.4; kick = ph < 0.22 ? 1 - ph / 0.22 : 0; gx -= kick * 2.6 * k2; }
    ctx.save(); ctx.globalAlpha = k.alpha || 1;
    ctx.strokeStyle = k.gun || k.col; ctx.lineWidth = Math.max(2.4, 3.5 * k2); ctx.lineCap = 'round';
    var mx = gx + Math.cos(rad) * tw * 0.85, my = base - th * 0.55 - Math.sin(rad) * tw * 0.85;
    ctx.beginPath(); ctx.moveTo(gx, base - th * 0.55);
    ctx.lineTo(mx, my); ctx.stroke();
    if (kick > 0) {
      ctx.globalAlpha = (k.alpha || 1) * kick * 0.7; ctx.fillStyle = '#f4f1ea';
      ctx.beginPath(); ctx.arc(mx + Math.cos(rad) * k2 * 3, my - Math.sin(rad) * k2 * 3, k2 * (2.5 + (1 - kick) * 3.5), 0, 6.2832); ctx.fill();
      ctx.globalAlpha = k.alpha || 1;
    }
    ctx.fillStyle = k.col; ctx.beginPath();
    ctx.moveTo(gx - tw / 2, base); ctx.lineTo(gx + tw / 2, base); ctx.lineTo(gx + tw * 0.34, base - th); ctx.lineTo(gx - tw * 0.34, base - th);
    ctx.closePath(); ctx.fill(); ctx.restore();
  }

  /* ── Pac-Man (chomp) ─────────────────────────────────────────────────── */
  /* The game's own pixels (shared/shopSkins.js chompPx over chompPixel.js's 13 px disc), chomping to the right
     (the game's mouth frames shut, half, wide, half; Owen 2026-10-27: the Customize button's Pac-Man chomps, and the
     lobby paints it every frame whatever the OS's reduced-motion says), on the arcade's black with the next dots ahead
     of it (bare: the chomper alone, centred). */
  var CHOMP_CHEW = [0, 1, 2, 1];
  function paintChomp(cv, k, t, big, bare) {
    var ctx = cv.getContext('2d'), w = cv.width, h = cv.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!bare) { ctx.fillStyle = '#000000'; ctx.fillRect(0, 0, w, h); }
    var px = Math.max(1, Math.floor(Math.min(w, h) * (big ? 0.55 : 0.7) / 13));
    var dots = bare ? 0 : Math.max(0, Math.min(2, Math.floor((w - 13 * px) / (8 * px) / 1.5)));
    var x0 = Math.round((w - (13 + dots * 8) * px) / 2), y0 = Math.round((h - 13 * px) / 2);
    var fr = CHOMP_CHEW[Math.floor((t || 0) / 0.09) % 4];
    for (var dy = -6; dy <= 6; dy++) for (var dx = -6; dx <= 6; dx++) {
      if (dx * dx + dy * dy > 42.25) continue;
      // the mouth, facing right: chompPixel's frame 1 (half) and frame 2 (wide); frame 0 is shut
      if (fr === 1 && dx + 1 >= 0 && Math.abs(dy) <= Math.floor(0.4 * (dx + 1.5))) continue;
      if (fr === 2 && dx + 2 >= 0 && Math.abs(dy) <= dx + 2) continue;
      ctx.fillStyle = SK.chompPx(k, dx, dy);
      ctx.fillRect(x0 + (dx + 6) * px, y0 + (dy + 6) * px, px, px);
    }
    ctx.fillStyle = '#ffb8ae';                                         // the arcade's dots: 2 px, a tile (8 px) apart
    for (var i = 1; i <= dots; i++) ctx.fillRect(x0 + (6 + i * 8) * px, y0 + 6 * px - px / 2, 2 * px, 2 * px);
  }

  /* A neon mallet seen from above (public/js/airhockey/ahArt.js, the rink look) with the white puck gliding past. */
  function paintAirhockey(cv, k, t, big, bare) {
    var ctx = cv.getContext('2d'), w = cv.width, h = cv.height, col = k.col || '#2ff3ff';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!bare) { ctx.fillStyle = '#03070d'; ctx.fillRect(0, 0, w, h); }
    var r = Math.min(w, h) * (big ? 0.26 : 0.34), cx = w / 2 - r * 0.45, cy = h / 2;
    var px = cx + r * 1.9 + Math.sin((t || 0) * 1.6) * r * 0.25, pr = r * 0.62;
    ctx.save();
    ctx.shadowColor = '#ffffff'; ctx.shadowBlur = r * 0.5;
    ctx.beginPath(); ctx.arc(px, cy, pr, 0, Math.PI * 2); ctx.fillStyle = '#ffffff'; ctx.fill();
    ctx.shadowColor = col; ctx.shadowBlur = r * 0.6;
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.92, 0, Math.PI * 2); ctx.lineWidth = r * 0.15; ctx.strokeStyle = col; ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 0.42; ctx.beginPath(); ctx.arc(cx, cy, r * 0.84, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.42, 0, Math.PI * 2); ctx.lineWidth = r * 0.08; ctx.strokeStyle = col; ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.2, 0, Math.PI * 2); ctx.fillStyle = '#ffffff'; ctx.fill();
    ctx.restore();
  }

  /* ── 8 Ball Pool: a corner of cloth, the cue ball and the cue drawing back and striking, in a look's colours
     (k.cloth and k.cue from shared/pool8Looks.js; {} is the game's own look). Not a Shop game (nothing is sold for
     it yet), so the lobby's Customize draws it through paintWith only. ─────── */
  var P8_CLOTH = { hi: '#97c6d9', mid: '#6090b0', lo: '#2d4866' }, P8_CUE = { shaft: '#d8b27a', butt: '#5a2a14', joint: '#1b1b1b' };
  function paintPool8(cv, k, t, big, bare) {
    var ctx = cv.getContext('2d'), w = cv.width, h = cv.height;
    var cl = k.cloth || P8_CLOTH, cu = k.cue || P8_CUE;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (bare) ctx.clearRect(0, 0, w, h);
    else { ctx.fillStyle = '#1a2033'; ctx.fillRect(0, 0, w, h); }
    var m = Math.min(w, h) * 0.08, rw = w - 2 * m, rh = h - 2 * m, r = Math.min(rw, rh) * 0.12;
    ctx.beginPath();
    ctx.moveTo(m + r, m); ctx.arcTo(m + rw, m, m + rw, m + rh, r); ctx.arcTo(m + rw, m + rh, m, m + rh, r);
    ctx.arcTo(m, m + rh, m, m, r); ctx.arcTo(m, m, m + rw, m, r); ctx.closePath();
    ctx.fillStyle = '#6b2118'; ctx.fill();
    var p = m + Math.min(rw, rh) * 0.07;
    var g = ctx.createRadialGradient(w / 2, h / 2, 2, w / 2, h / 2, Math.max(w, h) * 0.6);
    g.addColorStop(0, cl.hi); g.addColorStop(0.55, cl.mid); g.addColorStop(1, cl.lo);
    ctx.fillStyle = g; ctx.fillRect(p, p, w - 2 * p, h - 2 * p);
    var br = Math.min(w, h) * 0.085, bx = w * 0.62, by = h * 0.52;
    ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.beginPath(); ctx.arc(bx + br * 0.25, by + br * 0.3, br, 0, Math.PI * 2); ctx.fill();
    var bg = ctx.createRadialGradient(bx - br * 0.35, by - br * 0.4, br * 0.1, bx, by, br);
    bg.addColorStop(0, '#ffffff'); bg.addColorStop(1, '#b9b6ad');
    ctx.fillStyle = bg; ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2); ctx.fill();
    // The cue: drawn back and through, on a loop.
    var ph = (t % 2) / 2, back = ph < 0.7 ? Math.sin(ph / 0.7 * Math.PI / 2) : 1 - (ph - 0.7) / 0.3 * 1.15;
    var a = Math.PI * 0.86, ux = Math.cos(a), uy = Math.sin(a), len = Math.max(w, h) * 0.9;
    var x0 = bx + ux * (br * 1.25 + back * br * 1.6), y0 = by + uy * (br * 1.25 + back * br * 1.6);
    var lw = Math.max(2, br * 0.42);
    ctx.lineCap = 'round';
    var seg = function (fa, fb, wd, col) {
      ctx.strokeStyle = col; ctx.lineWidth = wd; ctx.beginPath();
      ctx.moveTo(x0 + ux * len * fa, y0 + uy * len * fa); ctx.lineTo(x0 + ux * len * fb, y0 + uy * len * fb); ctx.stroke();
    };
    seg(0, 0.03, lw, '#f4f1e6'); seg(0.03, 0.6, lw * 1.1, cu.shaft); seg(0.6, 0.64, lw * 1.3, cu.joint); seg(0.64, 1, lw * 1.55, cu.butt);
  }

  /* Crossy Road: the critter as a voxel block seen the game's way (top, front, right face), hopping on the spot. Not a
     Shop game (nothing is sold for it yet), so Customize draws it through paintWith only, { col } of a look. */
  function paintCrossy(cv, k, t, big, bare) {
    var ctx = cv.getContext('2d'), w = cv.width, h = cv.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (bare) ctx.clearRect(0, 0, w, h); else { ctx.fillStyle = '#9bc846'; ctx.fillRect(0, 0, w, h); }
    var s = Math.min(w, h) * 0.34, hop = Math.max(0, Math.sin((t % 0.9) / 0.9 * Math.PI)) * s * 0.25;
    var cx = w / 2 - s * 0.15, top = h / 2 - s * 0.55 - hop, col = k.col || '#62c84a';
    var dx = s * 0.45, dy = s * 0.3;
    ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.fillRect(cx - s / 2 + dx * 0.4, h / 2 + s * 0.62, s + dx, dy * 0.6);
    ctx.fillStyle = mix(col, '#ffffff', 0.12);                          // top
    ctx.beginPath(); ctx.moveTo(cx - s / 2, top); ctx.lineTo(cx + s / 2, top); ctx.lineTo(cx + s / 2 + dx, top - dy); ctx.lineTo(cx - s / 2 + dx, top - dy); ctx.fill();
    ctx.fillStyle = col; ctx.fillRect(cx - s / 2, top, s, s * 1.1);    // front
    ctx.fillStyle = mix(col, '#1a1340', 0.45);                          // right
    ctx.beginPath(); ctx.moveTo(cx + s / 2, top); ctx.lineTo(cx + s / 2 + dx, top - dy); ctx.lineTo(cx + s / 2 + dx, top - dy + s * 1.1); ctx.lineTo(cx + s / 2, top + s * 1.1); ctx.fill();
    ctx.fillStyle = '#ffffff'; ctx.fillRect(cx - s * 0.32, top + s * 0.28, s * 0.22, s * 0.24); ctx.fillRect(cx + s * 0.1, top + s * 0.28, s * 0.22, s * 0.24);
    ctx.fillStyle = '#15201a'; ctx.fillRect(cx - s * 0.25, top + s * 0.34, s * 0.1, s * 0.14); ctx.fillRect(cx + s * 0.17, top + s * 0.34, s * 0.1, s * 0.14);
  }

  /* ── Rooftop Snipers ─────────────────────────────────────────────────── */
  /* No Shop section (no bought skins): Customize's free looks only (shared/rtLooks.js), drawn through paintWith with
     { look: id }. The sniper is the game's own (public/js/rooftop/rtArt.js pose: the body, arm and rifle the match
     draws, in the red team's colour), standing, turned to face right, in whole squares with no smoothing. No look is
     Random: the preview walks through the whole cast, as each round deals one. The Customize bar and the chooser's
     reel (56 and 104 px high) show it from the belt up at two pixels a square, where the hats and helmets that tell
     the snipers apart read; a box over 160 px high shows all of it. */
  function paintRooftop(cv, k, t, big, bare) {
    var A = root.RTArt;
    if (!A || !A.pose) return;
    var ctx = cv.getContext('2d'), w = cv.width, h = cv.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!bare) { ctx.fillStyle = '#6dd9e8'; ctx.fillRect(0, 0, w, h); }
    var name = k && k.look ? k.look : A.NAMES[Math.floor((t || 0) / 1.2) % A.NAMES.length];
    var img = A.pose(name, 0);
    if (!img) return;
    var srcH = (cv.clientHeight || h) < 160 ? 96 : 150;
    var s = Math.min(w * 0.9 / 60, h * (big ? 0.8 : 0.94) / srcH);
    if (s >= 0.5) s = Math.floor(s * 2) / 2;                           // whole squares: a square is 2 base px
    var dw = Math.round(60 * s), dh = Math.round(srcH * s);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.translate(Math.round((w + dw) / 2), Math.round((h - dh) / 2));
    ctx.scale(-1, 1);
    ctx.drawImage(img, 0, 0, 60, srcH, 0, 0, dw, dh);
    ctx.restore();
  }

  var PAINT = { crossy: paintCrossy, snake: paintSnake, airhockey: paintAirhockey, agar: paintAgar, paper: paintPaper, chomp: paintChomp, knockout: paintKnockout,
    battleship: paintBattleship, omgshooter: paintShooter, tanks: paintTanks, pool8: paintPool8, rooftop: paintRooftop };
  /* Which previews move. The rest are painted once per size, which keeps a
     page of forty-odd canvases off the frame budget. */
  var MOVES = { snake: 1, paper: 1, chomp: 1, omgshooter: 1, tanks: 1, airhockey: 1, pool8: 1, crossy: 1, rooftop: 1 };

  /* skinId 'default' is the game's free look (each game's `def`). bare draws
     the piece alone on a clear canvas, for Customize's dark chooser. */
  function paint(cv, gameId, skinId, t, big, bare) {
    var g = BY[gameId], k = g && (skinId === 'default' ? g.def : g.by[skinId]), fn = PAINT[gameId];
    if (!k || !fn || !cv.width || !cv.height) return;
    fn(cv, k, t || 0, !!big, !!bare);
  }
  /* A look that is not one of the Shop's skins, drawn the same way: agar.io's
     free colours (shared/agSkins.js) as { col }. */
  function paintWith(cv, gameId, k, t, big, bare) {
    var fn = PAINT[gameId];
    if (!k || !fn || !cv.width || !cv.height) return;
    fn(cv, k, t || 0, !!big, !!bare);
  }

  root.V2Shop = {
    games: GAMES,
    game: function (id) { return BY[id] || null; },
    price: function (g, k) { return PR ? PR.price(g, k) : null; },
    tier: function (p) { return PR ? PR.tier(p) : null; },
    tiers: PR ? PR.TIERS : [],
    animated: function (id) { return !!MOVES[id]; },
    defaultName: function (id) { return BY[id] && BY[id].def ? BY[id].def.name : ''; },
    format: function (p) { return PR ? PR.format(p) : ''; },
    paint: paint,
    paintWith: paintWith,
  };
})(typeof window !== 'undefined' ? window : globalThis);
