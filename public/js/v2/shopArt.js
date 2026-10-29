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
  /* Customize's cell (Owen 2026-10-28): agar's split as a perfect loop. The cell splits in two, the new half
     shoots out and slows the way a split cell does, the pair coasts, then they pull back together and merge into
     the one cell it started as. Two halves keep the cell's area (radius R / sqrt 2), and every motion is a
     function of the loop's phase with whole-number harmonics, so the last frame runs into the first with nothing
     to jump. Rims first, then fills: where the halves overlap they read as one body, the way merging cells do.
     The rim is 0.9 of the colour as in play. A look with several colours glides to the next while the cell is
     whole, once a loop. */
  var AG_LOOP = 4.2;
  function agWobble(ctx, x, y, R, P, amp, seed) {
    var n = 48;
    ctx.beginPath();
    for (var i = 0; i <= n; i++) {
      var a = i / n * 6.2832;
      var rr = R * (1 + amp * (0.012 * Math.sin(a * 5 + 2 * P + seed) + 0.008 * Math.sin(a * 3 - P + 2 * seed) + 0.005 * Math.sin(a * 9 + 3 * P)));
      if (i) ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); else ctx.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    ctx.closePath();
  }
  // loops: the clock in loops. A look with several colours glides to its next one in the last eighth of a loop.
  function loopCol(k, loops) {
    if (!k.cols) return k.col;
    var n = k.cols.length, i = Math.floor(loops) % n, p = loops - Math.floor(loops), f = p < 0.88 ? 0 : (p - 0.88) / 0.12;
    return f ? mix(k.cols[i], k.cols[(i + 1) % n], f * f * (3 - 2 * f)) : k.cols[i];
  }
  // A bump that rises and falls back to zero inside [a, a + len] of the loop.
  function bump(p, a, len) { return p > a && p < a + len ? Math.sin((p - a) / len * 3.1416) : 0; }
  function paintAgarCell(ctx, k, t, w, h) {
    var p = ((t / AG_LOOP) % 1 + 1) % 1, P = p * 6.2832;
    var R = Math.min(Math.min(w, h) * 0.34, w * 0.29), r = R * Math.SQRT1_2, D = 2.3 * r, d = 0, f;
    if (p >= 0.1 && p < 0.3) { f = (p - 0.1) / 0.2; d = D * (1 - Math.pow(1 - f, 3)); }   // shot out, slowing
    else if (p >= 0.3 && p < 0.55) d = D * (1 + 0.04 * bump(p, 0.3, 0.25));                // coasting
    else if (p >= 0.55 && p < 0.85) { f = (p - 0.55) / 0.3; d = D * (1 - f * f * (3 - 2 * f)); }   // back together
    // Each half's radius: the whole cell's while they overlap completely, a half's once they are apart.
    var rad = r + (R - r) * Math.pow(Math.max(0, 1 - d / (2 * r)), 2), ring = Math.max(2, rad * 0.07);
    // The membranes jiggle harder just after the split and just after the merge, and are one membrane when whole.
    var amp = 1 + 1.6 * bump(p, 0.1, 0.3) + 2 * bump(p, 0.82, 0.18), sd = Math.min(1, d / r);
    var cx = w / 2 + Math.sin(P) * R * 0.05, cy = h / 2 + Math.sin(2 * P) * R * 0.05;
    var C = [[cx - 0.4 * d, cy, 0.9 * sd], [cx + 0.6 * d, cy, -1.3 * sd]];
    var col = loopCol(k, t / AG_LOOP), c = hexRgb(col);
    ctx.fillStyle = rgbHex([Math.trunc(c[0] * 0.9), Math.trunc(c[1] * 0.9), Math.trunc(c[2] * 0.9)]);
    C.forEach(function (q) { agWobble(ctx, q[0], q[1], rad + ring, P, amp, q[2]); ctx.fill(); });
    ctx.fillStyle = col;
    C.forEach(function (q) { agWobble(ctx, q[0], q[1], rad, P, amp, q[2]); ctx.fill(); });
    if (!k.art) return;
    C.forEach(function (q) {
      ctx.save(); agWobble(ctx, q[0], q[1], rad, P, amp, q[2]); ctx.clip();
      SK.agarArt(ctx, k, q[0], q[1], rad);
      ctx.restore();
    });
  }

  /* ── Paper.io ─────────────────────────────────────────────────────────── */
  /* The game as one perfect loop (Owen 2026-10-28): land along the top, the head running a square wave under it.
     It leaves its land, runs a box out and back in, the box becomes land, it crosses a strip of its own land and
     goes again, while the view pans with it at a steady speed. One loop pans exactly one box along, so the last
     frame is the first. In the game's world units: the trail trackWidth 8 wide with round caps in main at 0.6, the
     head 8 across with its 80 percent centre, every top lifted baseHeight 2 over its side in `back`. */
  var PP_LOOP = 3.0;
  function paintPaper(cv, k, t, big, bare) {
    var ctx = cv.getContext('2d'), w = cv.width, h = cv.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (bare) ctx.clearRect(0, 0, w, h);
    else { ctx.fillStyle = '#e7fff4'; ctx.fillRect(0, 0, w, h); }   // paper-arena.css body
    var p = ((t / PP_LOOP) % 1 + 1) % 1;
    var main = loopCol(k, t / PP_LOOP), back = hsvScale(main, 0.75), nick = hsvScale(main, 0.5);
    var u = bare ? Math.min(w / 30, h / 22) : Math.min(w, h) / 30;
    // The box's depth below the land, the head's depth inside it, the box's length and the land between boxes.
    var TW = 8, HB = 6, DIN = 5, L = 10, G = 14, PITCH = L + G, LEG = HB + DIN, S = 2 * LEG + L + G;
    var yb = h / 2 - u, cam = (p - 0.16) * PITCH;   // the land's edge in pixels; the world x at the centre
    function X(x) { return w / 2 + (x - cam) * u; }
    function Y(y) { return yb + y * u; }
    // The head along the wave at a steady speed: down out of the land, along, up into it, along inside it.
    var s = p * S, hx, hy;
    if (s < LEG) { hx = 0; hy = s - DIN; }
    else if (s < LEG + L) { hx = s - LEG; hy = HB; }
    else if (s < 2 * LEG + L) { hx = L; hy = HB - (s - LEG - L); }
    else { hx = L + s - 2 * LEG - L; hy = -DIN; }
    // The box closes when the head is back over the edge; it fills in as the trail fades.
    var sCap = 2 * LEG + L - DIN, fa = s < sCap ? 0 : Math.min(1, (s - sCap) / (S * 0.05));
    var k0 = Math.floor((cam - w / 2 / u) / PITCH) - 1;
    function lands(lift, cur) {
      ctx.beginPath();
      if (!cur) {
        ctx.rect(0, 0, w, Y(-lift));
        for (var b = k0; b < 0; b++) ctx.rect(X(b * PITCH - TW / 2), Y(-lift), (L + TW) * u, (HB + TW / 2) * u);
      } else ctx.rect(X(-TW / 2), Y(-lift), (L + TW) * u, (HB + TW / 2) * u);
    }
    function art(cur) {
      if (!k.art) return;
      ctx.save(); lands(2, cur); ctx.clip();
      // Tiles fixed to the world, one box pitch square, so the pattern pans with the land.
      for (var tx = k0; tx <= 1; tx++) for (var ty = -2; ty <= 0; ty++)
        SK.paperArt(ctx, k, X(tx * PITCH - TW / 2), Y(ty * PITCH + HB), PITCH * u, k.art === 'stars' ? '#ffffff' : back);
      ctx.restore();
    }
    ctx.fillStyle = back; lands(0, false); ctx.fill();
    ctx.fillStyle = main; lands(2, false); ctx.fill();
    art(false);
    if (fa) {
      ctx.globalAlpha = fa;
      ctx.fillStyle = back; lands(0, true); ctx.fill();
      ctx.fillStyle = main; lands(2, true); ctx.fill();
      art(true);
      ctx.globalAlpha = 1;
    }
    // The trail, from where the head left the land.
    if (s > DIN && fa < 1) {
      ctx.globalAlpha = 0.6 * (1 - fa); ctx.strokeStyle = main; ctx.lineWidth = TW * u; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(X(0), Y(0));
      if (s > LEG) ctx.lineTo(X(0), Y(HB));
      if (s > LEG + L) ctx.lineTo(X(L), Y(HB));
      ctx.lineTo(X(hx), Y(Math.max(0, hy))); ctx.stroke(); ctx.globalAlpha = 1;
    }
    /* The head: the nick square, then the back square with its main centre, lifted baseHeight, 8 units across. */
    var hs = 8 * u, px = X(hx), py = Y(hy);
    ctx.fillStyle = nick; ctx.fillRect(px - hs / 2, py - hs / 2 + 2 * u, hs, hs);
    ctx.fillStyle = back; ctx.fillRect(px - hs / 2, py - hs / 2, hs, hs);
    ctx.fillStyle = main; ctx.fillRect(px - hs * 0.4, py - hs * 0.4, hs * 0.8, hs * 0.8);
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
    // One block seen from the front and a little from above and the right: x, y (its top), size, depth d, all in s.
    function box(x, y, bw, bh, d, c) {
      var X = cx + x * s, Y = top + y * s, Wd = bw * s, Hd = bh * s, ox = d * dx, oy = d * dy;
      ctx.fillStyle = mix(c, '#ffffff', 0.12);
      ctx.beginPath(); ctx.moveTo(X, Y); ctx.lineTo(X + Wd, Y); ctx.lineTo(X + Wd + ox, Y - oy); ctx.lineTo(X + ox, Y - oy); ctx.fill();
      ctx.fillStyle = c; ctx.fillRect(X, Y, Wd, Hd);
      ctx.fillStyle = mix(c, '#1a1340', 0.4);
      ctx.beginPath(); ctx.moveTo(X + Wd, Y); ctx.lineTo(X + Wd + ox, Y - oy); ctx.lineTo(X + Wd + ox, Y - oy + Hd); ctx.lineTo(X + Wd, Y + Hd); ctx.fill();
    }
    if (k.id === 'nugget') {
      // Nugget, our hen (public/js/crossy/crossyScene.js henGeo): the tail behind, the body, the head set forward, the comb.
      box(-0.18, 0.12, 0.36, 0.34, 0.5, '#e9a24c');
      box(-0.5, 0.42, 1.0, 0.72, 1, '#fbd88e');
      box(-0.36, 0.5, 0.06, 0.4, 0.6, '#f0b85c');
      box(-0.4, -0.12, 0.7, 0.62, 0.62, '#fff0c8');
      box(-0.22, -0.3, 0.14, 0.2, 0.5, '#e8475e'); box(-0.06, -0.38, 0.14, 0.28, 0.5, '#c93349'); box(0.1, -0.3, 0.14, 0.2, 0.5, '#e8475e');
      box(-0.18, 0.16, 0.24, 0.12, 0.15, '#f2a21b');
      box(-0.12, 0.28, 0.12, 0.16, 0.05, '#e8475e');
      ctx.fillStyle = '#241610'; ctx.fillRect(cx - s * 0.32, top + s * 0.02, s * 0.1, s * 0.12); ctx.fillRect(cx + s * 0.08, top + s * 0.02, s * 0.1, s * 0.12);
      box(-0.3, 1.14, 0.12, 0.14, 0.3, '#f4b23a'); box(0.16, 1.14, 0.12, 0.14, 0.3, '#f4b23a');
      return;
    }
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

  /* ── Swim ────────────────────────────────────────────────────────────── */
  /* No Shop section: Customize's three cars (shared/swimLooks.js), drawn through paintWith with { car };
     anything else is the default, the supercar. Each car comes with its own paint and engine: the supercar red
     with the V12, the muscle car blue with the V8, the hot hatch yellow with the turbo four. Each is the game's
     own model (public/js/swim/swimScene.js) side on and facing right: the supercar with its big rear wing, the
     muscle car with its long scooped hood and set-back cabin, the hot hatch tall and boxy. The engine's badge
     sits on the door, with its tail pipes under the bumper: two big ones for the V8, four slim ones for the V12,
     one fat one for the turbo four. Drawn in a 102 by 40 unit box scaled to fit, so the badge reads in the 56 px
     Customize bar and the 104 px reel alike. */
  var SW = { gold: '#e8b84a', hi: '#ffd27e', low: '#9a6d1e', glass: '#1b2532', tyre: '#141518', hub: '#8d929b',
    trim: '#202228', tail: '#ff2a1c', head: '#fff2d4', ink: '#141820' };
  var SW_PIPES = { v8: [[27.3, 1.8], [29.5, 1.8]], v12: [[26.9, 0.9], [28.1, 0.9], [29.3, 0.9], [30.5, 0.9]], turbo4: [[27.5, 2.9]] };
  function swPoly(ctx, pts, fill) {
    ctx.beginPath(); ctx.moveTo(pts[0], pts[1]);
    for (var i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
    ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
  }
  /* A paint's lit top and shaded foot: mixed toward white or black. */
  function swMix(hex, to, k) {
    var n = parseInt(hex.slice(1), 16), r = n >> 16 & 255, g = n >> 8 & 255, b = n & 255;
    r = Math.round(r + (to - r) * k); g = Math.round(g + (to - g) * k); b = Math.round(b + (to - b) * k);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }
  function paintSwim(cv, k, t, big, bare) {
    var ctx = cv.getContext('2d'), w = cv.width, h = cv.height;
    var L = root.DS_SWIM_LOOKS, car = L ? L.carOf(k && k.car) : 'supercar';
    var e = L ? L.byId(L.engineOf(car)) : null;
    var id = e ? e.id : 'v12', badge = e ? e.badge : 'V12';
    var base = L ? L.paintOf(car) : SW.gold, PH = swMix(base, 255, 0.35), PL = swMix(base, 0, 0.42);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!bare) { ctx.fillStyle = '#1c1942'; ctx.fillRect(0, 0, w, h); }
    var s = Math.min(w * 0.92 / 102, h * (big ? 0.7 : 0.88) / 40), i;
    ctx.save();
    ctx.translate((w - 102 * s) / 2 + 1.5 * s, (h - 40 * s) / 2 + 0.6 * s);
    ctx.scale(s, s);
    ctx.lineCap = 'round';
    // tail pipes, under the bumper
    var P = SW_PIPES[id] || SW_PIPES.v12;
    for (i = 0; i < P.length; i++) {
      ctx.fillStyle = SW.trim; ctx.fillRect(-1.4, P[i][0], 6, P[i][1]);
      ctx.fillStyle = '#6b6f76'; ctx.fillRect(-1.4, P[i][0], 0.7, P[i][1]);
    }
    var g = ctx.createLinearGradient(0, car === 'hatch' ? 6 : 16, 0, 31);
    g.addColorStop(0, PH); g.addColorStop(0.45, base); g.addColorStop(1, PL);
    ctx.strokeStyle = 'rgba(255,255,255,.2)'; ctx.lineWidth = 0.8;
    if (car === 'muscle') {
      // a slab body with a flat nose, the cabin set back, a scoop on the long hood and a ducktail
      swPoly(ctx, [2, 31, 2, 21, 4, 19.4, 30, 19, 60, 18.6, 96, 19.2, 99.5, 20.6, 99.5, 31], g);
      swPoly(ctx, [29, 19.2, 38, 10.4, 52, 10.1, 62, 18.8], base);
      swPoly(ctx, [33.5, 18.4, 40, 11.7, 51, 11.5, 57.6, 18.2], SW.glass);
      swPoly(ctx, [45.4, 11.6, 47.4, 11.6, 47.8, 18.4, 45.6, 18.4], base);
      ctx.beginPath(); ctx.moveTo(42, 12.6); ctx.lineTo(37, 16.6); ctx.stroke();
      swPoly(ctx, [70, 18.7, 72, 16.4, 80, 16.4, 81.5, 18.8], SW.trim);
      swPoly(ctx, [1.4, 18.6, 7, 18.2, 7, 19.8, 1.6, 20.4], PL);
      swPoly(ctx, [2, 20.6, 4.2, 20.6, 4.2, 23.6, 2, 23.6], SW.tail);
      swPoly(ctx, [97, 20.8, 99.6, 21.2, 99.6, 23.6, 97, 23.4], SW.head);
    } else if (car === 'hatch') {
      // short hood, a tall cabin, a raked hatch under a roof spoiler
      swPoly(ctx, [3.5, 31, 3.5, 17.5, 72, 16.8, 92, 18.6, 98.5, 22, 99, 31], g);
      swPoly(ctx, [4, 17.6, 15, 5.6, 50, 5, 72, 16.9], g);
      swPoly(ctx, [9.6, 16.2, 17, 7.4, 49, 7, 66.4, 16.4], SW.glass);
      swPoly(ctx, [9.4, 16.4, 16.8, 7.2, 22, 7.1, 22.6, 16.4], base);
      swPoly(ctx, [38, 7.1, 40.4, 7.1, 40.8, 16.4, 38.4, 16.4], base);
      ctx.beginPath(); ctx.moveTo(52, 8.8); ctx.lineTo(46, 14.6); ctx.stroke();
      swPoly(ctx, [12, 4.6, 25, 4.2, 25, 5.8, 12.6, 6.8], PL);
      swPoly(ctx, [3.4, 19, 5.8, 19, 5.8, 22.6, 3.4, 22.6], SW.tail);
      swPoly(ctx, [92.8, 19.2, 98, 21.4, 97.6, 22.9, 92.6, 20.8], SW.head);
    } else {
      // the supercar: wing struts, a low wedge, the cabin forward, the big wing
      ctx.fillStyle = SW.trim; ctx.fillRect(9, 8.6, 1.4, 9.6); ctx.fillRect(15, 8.6, 1.4, 9.6);
      swPoly(ctx, [3, 31, 2.5, 22, 5, 18.6, 27, 17.2, 70, 18.4, 88, 21.2, 97, 24, 99.5, 27, 98.5, 31], g);
      swPoly(ctx, [25, 17.6, 37, 9.6, 57, 8.6, 73, 18.8], base);
      swPoly(ctx, [30, 16.9, 39.5, 10.8, 55.5, 10.1, 67.5, 17.9], SW.glass);
      swPoly(ctx, [48.4, 10.3, 50.6, 10.2, 51.6, 18, 49.2, 17.9], base);
      ctx.beginPath(); ctx.moveTo(41.5, 11.6); ctx.lineTo(35.5, 15.8); ctx.stroke();
      swPoly(ctx, [-0.6, 6.2, 22.4, 6.7, 22.4, 9.3, 0, 9.6], PL);
      ctx.fillStyle = PH; ctx.fillRect(-0.6, 6.2, 23, 0.7);
      ctx.fillStyle = SW.trim; ctx.fillRect(-0.4, 5.2, 2.2, 6);
      swPoly(ctx, [2.4, 20.4, 4.4, 19.6, 4.4, 23.4, 2.6, 23.4], SW.tail);
      swPoly(ctx, [92.6, 23, 97.4, 24.4, 96.8, 25.8, 92.2, 24.6], SW.head);
    }
    ctx.strokeStyle = SW.trim; ctx.lineWidth = 1.3;
    ctx.beginPath(); ctx.moveTo(29, 30.4); ctx.lineTo(71, 30.6); ctx.stroke();
    // wheel arches (cut at the body's foot), then the wheels
    var W = [20, 80];
    ctx.save();
    ctx.beginPath(); ctx.rect(-2, 0, 104, 31.2); ctx.clip();
    ctx.fillStyle = '#0d0f13';
    for (i = 0; i < 2; i++) { ctx.beginPath(); ctx.arc(W[i], 31, 8.6, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
    for (i = 0; i < 2; i++) {
      var x = W[i];
      ctx.fillStyle = SW.tyre; ctx.beginPath(); ctx.arc(x, 31, 7, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = SW.hub; ctx.beginPath(); ctx.arc(x, 31, 4.7, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#3c4047'; ctx.beginPath(); ctx.arc(x, 31, 3.7, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = SW.hub; ctx.lineWidth = 1;
      for (var a = 0; a < 5; a++) {
        var an = a * Math.PI * 2 / 5 - Math.PI / 2;
        ctx.beginPath(); ctx.moveTo(x + Math.cos(an) * 1.2, 31 + Math.sin(an) * 1.2);
        ctx.lineTo(x + Math.cos(an) * 4, 31 + Math.sin(an) * 4); ctx.stroke();
      }
    }
    // the engine's badge on the door
    ctx.font = 'italic 800 8.6px Archivo, ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    var bw = ctx.measureText(badge).width + 5.4, bx = 50 - bw / 2, by = 19.8, bh = 9.4, r = 3;
    ctx.beginPath();
    ctx.moveTo(bx + r, by); ctx.lineTo(bx + bw - r, by); ctx.quadraticCurveTo(bx + bw, by, bx + bw, by + r);
    ctx.lineTo(bx + bw, by + bh - r); ctx.quadraticCurveTo(bx + bw, by + bh, bx + bw - r, by + bh);
    ctx.lineTo(bx + r, by + bh); ctx.quadraticCurveTo(bx, by + bh, bx, by + bh - r);
    ctx.lineTo(bx, by + r); ctx.quadraticCurveTo(bx, by, bx + r, by); ctx.closePath();
    ctx.fillStyle = SW.ink; ctx.fill();
    ctx.fillStyle = PH; ctx.fillText(badge, 50, by + bh / 2 + 0.4);
    ctx.restore();
  }

  var PAINT = { crossy: paintCrossy, snake: paintSnake, airhockey: paintAirhockey, agar: paintAgar, paper: paintPaper, chomp: paintChomp, knockout: paintKnockout,
    battleship: paintBattleship, omgshooter: paintShooter, tanks: paintTanks, pool8: paintPool8, rooftop: paintRooftop, swim: paintSwim };
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
