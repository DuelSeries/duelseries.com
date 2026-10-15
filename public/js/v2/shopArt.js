/* The Shop tab's skins and their previews (Owen, 2026-10-15). LOOK ONLY:
   nothing here can be bought, worn or sent to a game. Prices are not in this
   file; they are in shared/shopPrices.js, the one file Owen edits.

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

   Exposes window.V2Shop = {games, game(id), price(g, k), tier(p), tiers,
   paint(canvas, gameId, skinId, t, big), animated(gameId)}. */
(function (root) {
  'use strict';
  var PR = root.DS_SHOP_PRICES;

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
  function mix(a, b, f) { var x = hexRgb(a), y = hexRgb(b); return rgbHex([0, 1, 2].map(function (i) { return x[i] + (y[i] - x[i]) * f; })); }

  /* ── the skins ──────────────────────────────────────────────────────────
     `id` is the key in shared/shopPrices.js. The order here is the order on
     the page, cheapest first. */
  var GAMES = [
    { id: 'snake', name: 'slither.io', bg: '#0e1622', skins: [
      { id: 'candycane',     name: 'Candy Cane', runs: [[2, 31], [2, 9]] },
      { id: 'bumblebee', name: 'Bumblebee',  runs: [[3, 32], [3, 11]] },
      { id: 'glacier',   name: 'Glacier',    runs: [[3, 9], [3, 23], [2, 14]] },
      { id: 'toxic',     name: 'Toxic',      runs: [[3, 26], [2, 11], [1, 35]] },
      { id: 'ember',     name: 'Ember',      runs: [[3, 22], [2, 33], [2, 18]] },
      { id: 'sunset',    name: 'Sunset',     runs: [[2, 8], [2, 7], [2, 5], [2, 4]] },
      { id: 'royal',     name: 'Royal',      runs: [[3, 21], [2, 12], [1, 17]] },
      { id: 'rainbow',   name: 'Rainbow',    runs: [[1, 7], [1, 5], [1, 4], [1, 3], [1, 23], [1, 14], [1, 17]] },
    ] },
    { id: 'agar', name: 'agar.io', bg: 'rgb(242,251,255)', skins: [
      { id: 'twoface',    name: 'Two Face',   col: '#3fa9f5', art: 'split',    alt: '#ff5a5f' },
      { id: 'bullseye', name: 'Bullseye',   col: '#ff4040', art: 'rings',    alt: '#ffffff' },
      { id: 'melon',    name: 'Melon',      col: '#5cc95c', art: 'melon',    alt: '#2e8b3a' },
      { id: 'moon',     name: 'Moon',       col: '#c9ccd4', art: 'moon',     alt: '#9da2ad' },
      { id: 'peppermint',     name: 'Peppermint', col: '#ffffff', art: 'swirl',    alt: '#e8323c' },
      { id: 'eyeball',      name: 'Eyeball',    col: '#fdfdfd', art: 'eye',      alt: '#3d8be0' },
      { id: 'galaxy',   name: 'Galaxy',     col: '#1d1846', art: 'stars',    alt: '#b49cff' },
      { id: 'sunburst',      name: 'Sunburst',   col: '#ffc21a', art: 'rays',     alt: '#ff8a00' },
    ] },
    { id: 'paper', name: 'Paper.io', bg: '#e7fff4', skins: [
      { id: 'mint',      name: 'Mint',      col: '#3ee8b0', art: 'checks' },
      { id: 'ice',       name: 'Ice',       col: '#9fdcff', art: 'stripes' },
      { id: 'bubblegum', name: 'Bubblegum', col: '#ff77aa', art: 'dots' },
      { id: 'grape',     name: 'Grape',     col: '#8a4fc0', art: 'checks' },
      { id: 'lava',      name: 'Lava',      col: '#ff5a1f', art: 'stripes' },
      { id: 'camo',    name: 'Camo',      col: '#4a7c59', art: 'camo' },
      { id: 'midnight',  name: 'Midnight',  col: '#2b3a8c', art: 'stars' },
      { id: 'gold',      name: 'Gold',      col: '#f2b632', art: 'diamonds' },
    ] },
    { id: 'knockout', name: 'Knockout', bg: '#0b0907', skins: [
      { id: 'copper',   name: 'Copper',   col: '#c8743c' },
      { id: 'jade',     name: 'Jade',     col: '#4fb886' },
      { id: 'ice',      name: 'Ice',      col: '#bfe6f5' },
      { id: 'ruby',     name: 'Ruby',     col: '#d0354a' },
      { id: 'target',   name: 'Target',   col: '#f4f1ea', art: 'rings', alt: '#e0554a' },
      { id: 'obsidian', name: 'Obsidian', col: '#3a332d', art: 'gloss' },
      { id: 'marble',   name: 'Marble',   col: '#ece8e1', art: 'veins', alt: '#9b938a' },
      { id: 'gold',     name: 'Gold',     col: '#f0b83a', art: 'gloss' },
    ] },
    { id: 'battleship', name: 'Battleship', bg: '#0a1622', skins: [
      { id: 'navy',    name: 'Navy',    col: '#4a6496' },
      { id: 'arctic',  name: 'Arctic',  col: '#c9d3df' },
      { id: 'desert',  name: 'Desert',  col: '#b79c6c' },
      { id: 'rust',    name: 'Rust',    col: '#9a5634' },
      { id: 'crimson', name: 'Crimson', col: '#b13a3a' },
      { id: 'stealth', name: 'Stealth', col: '#3b4149', glass: '#e0554a' },
      { id: 'jungle',    name: 'Jungle',  col: '#5f7a3f', deck: '#3d4f2a' },
      { id: 'gold',    name: 'Gold',    col: '#d4a93c', glass: '#fff1b8' },
    ] },
    { id: 'omgshooter', name: 'Awesome Tanks', bg: '#1d2016', skins: [
      { id: 'desert',  name: 'Desert',  rim: '#e0c27a', core: '#4a3a16', panel: '#a8894a' },
      { id: 'arctic',  name: 'Arctic',  rim: '#e8f0f6', core: '#2c3a46', panel: '#9fb4c4' },
      { id: 'navy',    name: 'Navy',    rim: '#5c8de8', core: '#0c1a3a', panel: '#2c4f96' },
      { id: 'violet',  name: 'Violet',  rim: '#b47cf0', core: '#2a0f46', panel: '#6c3aa8' },
      { id: 'toxic',   name: 'Toxic',   rim: '#d4f02a', core: '#2a3a00', panel: '#7a9a10' },
      { id: 'shadow',  name: 'Shadow',  rim: '#5a5e66', core: '#0a0b0d', panel: '#2a2d33' },
      { id: 'crimson', name: 'Crimson', rim: '#ff3a5a', core: '#3a0010', panel: '#a01830' },
      { id: 'gold',    name: 'Gold',    rim: '#ffd23a', core: '#4a3200', panel: '#c08a10' },
    ] },
    { id: 'tanks', name: 'Bowmasters', bg: '#14110d', skins: [
      { id: 'jade',    name: 'Jade',    col: '#4fb886' },
      { id: 'sky',     name: 'Sky',     col: '#7fd4f5' },
      { id: 'copper',  name: 'Copper',  col: '#c8743c' },
      { id: 'violet',  name: 'Violet',  col: '#a887d6' },
      { id: 'crimson', name: 'Crimson', col: '#d0354a' },
      { id: 'twotone',    name: 'Two Tone', col: '#8ed081', gun: '#f4f1ea' },
      { id: 'ghost',   name: 'Ghost',   col: '#f4f1ea', alpha: 0.55 },
      { id: 'gold',    name: 'Gold',    col: '#f0b83a', gun: '#fff1b8' },
    ] },
  ];
  var BY = {};
  GAMES.forEach(function (g) { BY[g.id] = g; g.by = {}; g.skins.forEach(function (k) { g.by[k.id] = k; }); });

  /* ── slither.io ───────────────────────────────────────────────────────── */
  var SL_CARD = { spanFrac: 0.3, ampFrac: 0.12, radiusFrac: null };
  var SL_BIG = { spanFrac: 0.3, ampFrac: 0.08, radiusFrac: 0.05 };
  function paintSnake(cv, k, t, big) {
    if (!root.V2Look) return;
    root.V2Look.paint(cv, k.runs, big ? SL_BIG : SL_CARD, t);
  }

  /* ── agar.io ──────────────────────────────────────────────────────────── */
  function agarDesign(ctx, k, x, y, R) {
    var i, a;
    ctx.fillStyle = k.alt;
    ctx.strokeStyle = k.alt;
    switch (k.art) {
      case 'split':
        ctx.fillRect(x, y - R, R, R * 2); break;
      case 'rings':
        for (i = 4; i >= 1; i -= 2) { ctx.beginPath(); ctx.arc(x, y, R * i / 5, 0, 6.2832); ctx.fill();
          ctx.fillStyle = k.col; ctx.beginPath(); ctx.arc(x, y, R * (i - 1) / 5, 0, 6.2832); ctx.fill(); ctx.fillStyle = k.alt; }
        break;
      case 'melon':
        ctx.lineWidth = R * 0.13;
        for (i = -3; i <= 3; i++) { ctx.beginPath(); ctx.ellipse(x + i * R * 0.3, y, R * 0.06 + Math.abs(i) * R * 0.02, R, 0, 0, 6.2832); ctx.stroke(); }
        break;
      case 'moon':
        [[-.35, -.3, .22], [.3, -.1, .16], [-.05, .38, .26], [.45, .4, .1], [-.5, .2, .09]].forEach(function (c) {
          ctx.beginPath(); ctx.arc(x + c[0] * R, y + c[1] * R, c[2] * R, 0, 6.2832); ctx.fill(); });
        break;
      case 'swirl':
        for (i = 0; i < 6; i++) { a = i * Math.PI / 3; ctx.beginPath(); ctx.moveTo(x, y);
          ctx.arc(x, y, R, a, a + Math.PI / 6); ctx.closePath(); ctx.fill(); }
        break;
      case 'eye':
        ctx.beginPath(); ctx.arc(x + R * 0.12, y, R * 0.5, 0, 6.2832); ctx.fill();
        ctx.fillStyle = '#111'; ctx.beginPath(); ctx.arc(x + R * 0.16, y, R * 0.24, 0, 6.2832); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x + R * 0.26, y - R * 0.12, R * 0.08, 0, 6.2832); ctx.fill();
        ctx.strokeStyle = '#e8323c'; ctx.lineWidth = R * 0.03;
        for (i = 0; i < 5; i++) { a = 2.4 + i * 0.35; ctx.beginPath(); ctx.moveTo(x + Math.cos(a) * R, y + Math.sin(a) * R);
          ctx.lineTo(x + Math.cos(a + 0.1) * R * 0.66, y + Math.sin(a + 0.1) * R * 0.66); ctx.stroke(); }
        break;
      case 'stars':
        for (i = 0; i < 26; i++) { var u = Math.sin(i * 12.9898) * 43758.5453, v = Math.sin(i * 78.233) * 12543.21;
          u -= Math.floor(u); v -= Math.floor(v);
          ctx.globalAlpha = 0.5 + (i % 3) * 0.25;
          ctx.beginPath(); ctx.arc(x + (u * 2 - 1) * R, y + (v * 2 - 1) * R, R * (0.02 + (i % 4) * 0.012), 0, 6.2832); ctx.fill(); }
        ctx.globalAlpha = 0.35; ctx.beginPath(); ctx.ellipse(x, y, R * 0.8, R * 0.22, -0.5, 0, 6.2832); ctx.fill();
        ctx.globalAlpha = 1;
        break;
      case 'rays':
        for (i = 0; i < 12; i++) { a = i * Math.PI / 6; ctx.beginPath(); ctx.moveTo(x, y);
          ctx.arc(x, y, R, a, a + Math.PI / 12); ctx.closePath(); ctx.fill(); }
        ctx.fillStyle = k.col; ctx.beginPath(); ctx.arc(x, y, R * 0.45, 0, 6.2832); ctx.fill();
        break;
    }
  }
  function paintAgar(cv, k, t, big) {
    var ctx = cv.getContext('2d'), w = cv.width, h = cv.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = 'rgb(242,251,255)';                   // agRender BG_LIGHT
    ctx.fillRect(0, 0, w, h);
    /* The 50-unit grid at agar's 0.2 alpha black, about 3 squares across. */
    var step = h / 3.2;
    ctx.strokeStyle = 'rgb(0,0,0)'; ctx.globalAlpha = 0.2; ctx.lineWidth = 1;
    ctx.beginPath();
    for (var gx = (w / 2) % step; gx < w; gx += step) { ctx.moveTo(Math.round(gx) + 0.5, 0); ctx.lineTo(Math.round(gx) + 0.5, h); }
    for (var gy = (h / 2) % step; gy < h; gy += step) { ctx.moveTo(0, Math.round(gy) + 0.5); ctx.lineTo(w, Math.round(gy) + 0.5); }
    ctx.stroke(); ctx.globalAlpha = 1;
    var x = w / 2, y = h / 2, R = Math.min(w, h) * (big ? 0.34 : 0.33);
    var ring = Math.max(2, R * 0.07);                     // rim 5 at a cell of ~70
    var c = hexRgb(k.col);
    ctx.fillStyle = rgbHex([Math.trunc(c[0] * 0.9), Math.trunc(c[1] * 0.9), Math.trunc(c[2] * 0.9)]);
    ctx.beginPath(); ctx.arc(x, y, R + ring, 0, 6.2832); ctx.fill();
    ctx.fillStyle = k.col;
    ctx.beginPath(); ctx.arc(x, y, R, 0, 6.2832); ctx.fill();
    ctx.save(); ctx.beginPath(); ctx.arc(x, y, R, 0, 6.2832); ctx.clip();
    agarDesign(ctx, k, x, y, R);
    ctx.restore();
  }

  /* ── Paper.io ─────────────────────────────────────────────────────────── */
  function paperPattern(ctx, k, x0, y0, s, col) {
    var i, j, n = 6, c = s / n;
    ctx.fillStyle = col;
    switch (k.art) {
      case 'checks':
        for (i = 0; i < n; i++) for (j = 0; j < n; j++) if ((i + j) % 2) ctx.fillRect(x0 + i * c, y0 + j * c, c, c);
        break;
      case 'stripes':
        ctx.save(); ctx.beginPath(); ctx.rect(x0, y0, s, s); ctx.clip();
        for (i = -n; i < n * 2; i += 2) { ctx.beginPath(); ctx.moveTo(x0 + i * c, y0); ctx.lineTo(x0 + (i + 1) * c, y0);
          ctx.lineTo(x0 + (i + 1) * c - s, y0 + s); ctx.lineTo(x0 + i * c - s, y0 + s); ctx.fill(); }
        ctx.restore(); break;
      case 'dots':
        for (i = 0; i < n; i++) for (j = 0; j < n; j++) { ctx.beginPath();
          ctx.arc(x0 + (i + 0.5 + (j % 2) * 0.5) * c, y0 + (j + 0.5) * c, c * 0.22, 0, 6.2832); ctx.fill(); }
        break;
      case 'camo':
        ctx.save(); ctx.beginPath(); ctx.rect(x0, y0, s, s); ctx.clip();
        [[.2, .25, .2, .12], [.7, .2, .18, .1], [.45, .6, .24, .13], [.85, .75, .15, .1], [.12, .8, .16, .1]].forEach(function (b) {
          ctx.beginPath(); ctx.ellipse(x0 + b[0] * s, y0 + b[1] * s, b[2] * s, b[3] * s, 0.6, 0, 6.2832); ctx.fill(); });
        ctx.restore(); break;
      case 'stars':
        for (i = 0; i < 14; i++) { var u = Math.sin(i * 12.9898) * 43758.5453, v = Math.sin(i * 78.233) * 12543.21;
          u -= Math.floor(u); v -= Math.floor(v); ctx.beginPath();
          ctx.arc(x0 + u * s, y0 + v * s, s * (0.012 + (i % 3) * 0.008), 0, 6.2832); ctx.fill(); }
        break;
      case 'diamonds':
        for (i = 0; i < n; i++) for (j = 0; j < n; j++) { var cx = x0 + (i + 0.5) * c, cy = y0 + (j + 0.5) * c;
          ctx.beginPath(); ctx.moveTo(cx, cy - c * 0.35); ctx.lineTo(cx + c * 0.35, cy); ctx.lineTo(cx, cy + c * 0.35);
          ctx.lineTo(cx - c * 0.35, cy); ctx.fill(); }
        break;
    }
  }
  function paintPaper(cv, k, t, big) {
    var ctx = cv.getContext('2d'), w = cv.width, h = cv.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#e7fff4'; ctx.fillRect(0, 0, w, h);   // paper-arena.css body
    var main = k.col, back = hsvScale(main, 0.75), nick = hsvScale(main, 0.5);
    var u = Math.min(w, h) / 30;                          // world units: trackWidth 8, baseHeight 2
    var s = u * 15, x0 = w * 0.18, y0 = (h - s) / 2;
    /* Territory: its side in `back`, then the top lifted baseHeight. */
    ctx.fillStyle = back; ctx.fillRect(x0, y0, s, s);
    ctx.fillStyle = main; ctx.fillRect(x0, y0 - 2 * u, s, s);
    paperPattern(ctx, k, x0, y0 - 2 * u, s, k.art === 'stars' ? '#ffffff' : back);
    /* The trail out of it, main at 0.6, trackWidth wide with round caps. */
    var hx = x0 + s + u * 11, hy = y0 + s * 0.3;
    ctx.globalAlpha = 0.6; ctx.strokeStyle = main; ctx.lineWidth = 8 * u; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(x0 + s - 4 * u, y0 + s * 0.78); ctx.lineTo(x0 + s + 6 * u, y0 + s * 0.78);
    ctx.lineTo(hx, hy + 6 * u); ctx.lineTo(hx, hy); ctx.stroke(); ctx.globalAlpha = 1;
    /* The head: the nick square, then the back square with its main centre,
       lifted baseHeight, 8 units across. */
    var hs = 8 * u, bob = Math.sin(t * 3) * 0.6 * u;
    ctx.fillStyle = nick; ctx.fillRect(hx - hs / 2, hy - hs / 2 + bob, hs, hs);
    ctx.fillStyle = back; ctx.fillRect(hx - hs / 2, hy - hs / 2 - 2 * u + bob, hs, hs);
    ctx.fillStyle = main; ctx.fillRect(hx - hs * 0.4, hy - hs * 0.4 - 2 * u + bob, hs * 0.8, hs * 0.8);
  }

  /* ── Knockout ─────────────────────────────────────────────────────────── */
  function knockoutPiece(ctx, k, x, y, pr) {
    ctx.beginPath(); ctx.arc(x, y, pr, 0, 6.2832); ctx.fillStyle = k.col; ctx.fill();
    ctx.save(); ctx.beginPath(); ctx.arc(x, y, pr, 0, 6.2832); ctx.clip();
    if (k.art === 'rings') {
      ctx.fillStyle = k.alt; ctx.beginPath(); ctx.arc(x, y, pr * 0.8, 0, 6.2832); ctx.fill();
      ctx.fillStyle = k.col; ctx.beginPath(); ctx.arc(x, y, pr * 0.6, 0, 6.2832); ctx.fill();
    } else if (k.art === 'veins') {
      ctx.strokeStyle = k.alt; ctx.lineWidth = pr * 0.05; ctx.globalAlpha = 0.6;
      ctx.beginPath(); ctx.moveTo(x - pr, y - pr * 0.3); ctx.quadraticCurveTo(x - pr * 0.2, y - pr * 0.1, x + pr * 0.1, y + pr * 0.4);
      ctx.quadraticCurveTo(x + pr * 0.4, y + pr * 0.7, x + pr, y + pr * 0.5);
      ctx.moveTo(x - pr * 0.3, y - pr); ctx.quadraticCurveTo(x, y - pr * 0.4, x + pr * 0.6, y - pr * 0.2); ctx.stroke();
      ctx.globalAlpha = 1;
    } else if (k.art === 'gloss') {
      var g = ctx.createLinearGradient(x, y - pr, x, y + pr);
      g.addColorStop(0, 'rgba(255,255,255,0.35)'); g.addColorStop(0.5, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(0,0,0,0.25)');
      ctx.fillStyle = g; ctx.fillRect(x - pr, y - pr, pr * 2, pr * 2);
    }
    ctx.restore();
    /* knockout.js: the darker inner disc, so the piece reads as having a top. */
    ctx.beginPath(); ctx.arc(x, y - pr * 0.12, pr * 0.58, 0, 6.2832);
    ctx.fillStyle = 'rgba(0,0,0,0.13)'; ctx.fill();
  }
  function paintKnockout(cv, k, t, big) {
    var ctx = cv.getContext('2d'), w = cv.width, h = cv.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0b0907'; ctx.fillRect(0, 0, w, h);
    /* Close in on the disc: the piece is what is for sale, so the field runs
       off the edges rather than shrinking the piece to fit it. */
    var cx = w / 2, cy = h / 2 + h * 0.1, R = Math.min(w * 0.5, h * 0.62);
    var g = ctx.createRadialGradient(cx, cy - R * 0.35, R * 0.1, cx, cy, R);
    g.addColorStop(0, '#241d16'); g.addColorStop(1, '#171310');
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 6.2832); ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = '#f0a830'; ctx.lineWidth = Math.max(1.5, R * 0.012); ctx.stroke();
    var pr = Math.min(w, h) * 0.17;
    knockoutPiece(ctx, k, cx - pr * 1.35, h * 0.5, pr);
    knockoutPiece(ctx, k, cx + pr * 1.35, h * 0.42, pr);
  }

  /* ── Battleship ───────────────────────────────────────────────────────── */
  function hullFor(k) {
    return {
      steel: k.col, steelHi: mix(k.col, '#ffffff', 0.18), steelLo: mix(k.col, '#000000', 0.27),
      deck: k.deck || mix(k.col, '#000000', 0.43), deckHi: mix(k.deck || k.col, '#000000', 0.27),
      trim: mix(k.col, '#000000', 0.65), glass: k.glass || '#9fd0e8',
    };
  }
  function paintBattleship(cv, k, t, big) {
    var BA = root.BattleshipArt; if (!BA) return;
    var ctx = cv.getContext('2d'), w = cv.width, h = cv.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0a1622'; ctx.fillRect(0, 0, w, h);   // battleship.js water
    var cell = w / 4.5, x0 = (w - cell * 4) / 2, y0 = (h - cell) / 2;
    ctx.strokeStyle = '#1d3348'; ctx.lineWidth = 1; ctx.beginPath();
    for (var x = x0 - cell * 2; x < w; x += cell) { ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, h); }
    for (var y = y0 - cell * 3; y < h; y += cell) { ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(w, Math.round(y) + 0.5); }
    ctx.stroke();
    /* drawShip reads BattleshipArt.HULL as it draws: swap the skin in for the
       call, then put the game's own colours straight back. */
    var H = BA.HULL, keep = {}, mine = hullFor(k), key;
    for (key in mine) { keep[key] = H[key]; H[key] = mine[key]; }
    try { BA.drawShip(ctx, 'battleship', 4, x0, y0, cell, true, 0.95); }
    finally { for (key in keep) H[key] = keep[key]; }
  }

  /* ── Awesome Tanks ────────────────────────────────────────────────────── */
  function teamFor(k) {
    return {
      rim: k.rim, rimDim: mix(k.rim, '#000000', 0.2), core: k.core, panel: k.panel,
      barrel: mix(k.panel, '#000000', 0.35), barrelDim: k.core, lit: mix(k.rim, '#ffffff', 0.55),
      track: mix(k.core, '#000000', 0.5), line: '#000000',
    };
  }
  function paintShooter(cv, k, t, big) {
    var SA = root.ShooterArt; if (!SA) return;
    var ctx = cv.getContext('2d'), w = cv.width, h = cv.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#1d2016'; ctx.fillRect(0, 0, w, h);
    var team = 'shop:' + k.id;
    if (!SA.TEAMS[team]) SA.TEAMS[team] = teamFor(k);
    SA.drawTank(ctx, { x: w / 2, y: h / 2, size: Math.min(w, h) * 0.5, team: team,
      hull: -0.35, turret: -0.35 + Math.sin(t * 0.8) * 0.6 });
  }

  /* ── Bowmasters ───────────────────────────────────────────────────────── */
  function paintTanks(cv, k, t, big) {
    var ctx = cv.getContext('2d'), w = cv.width, h = cv.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    var g = ctx.createLinearGradient(0, 0, 0, h);         // tanks.js sky
    g.addColorStop(0, '#14110d'); g.addColorStop(0.62, '#241a12'); g.addColorStop(1, '#3a2a18');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    var gy = h * 0.7;
    var gg = ctx.createLinearGradient(0, gy, 0, h);        // tanks.js ground
    gg.addColorStop(0, '#191309'); gg.addColorStop(1, '#0c0906');
    ctx.fillStyle = gg; ctx.beginPath(); ctx.moveTo(0, gy + h * 0.04);
    ctx.quadraticCurveTo(w * 0.5, gy - h * 0.05, w, gy + h * 0.03); ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.fill();
    var k2 = Math.min(w, h) / 70, tw = 34 * k2, th = 16 * k2, gx = w / 2, base = gy;
    var rad = (40 + Math.sin(t * 0.9) * 12) * Math.PI / 180;
    ctx.save(); ctx.globalAlpha = k.alpha || 1;
    ctx.strokeStyle = k.gun || k.col; ctx.lineWidth = Math.max(2.4, 3.5 * k2); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(gx, base - th * 0.55);
    ctx.lineTo(gx + Math.cos(rad) * tw * 0.85, base - th * 0.55 - Math.sin(rad) * tw * 0.85); ctx.stroke();
    ctx.fillStyle = k.col; ctx.beginPath();
    ctx.moveTo(gx - tw / 2, base); ctx.lineTo(gx + tw / 2, base); ctx.lineTo(gx + tw * 0.34, base - th); ctx.lineTo(gx - tw * 0.34, base - th);
    ctx.closePath(); ctx.fill(); ctx.restore();
  }

  var PAINT = { snake: paintSnake, agar: paintAgar, paper: paintPaper, knockout: paintKnockout,
    battleship: paintBattleship, omgshooter: paintShooter, tanks: paintTanks };
  /* Which previews move. The rest are painted once per size, which keeps a
     page of forty-odd canvases off the frame budget. */
  var MOVES = { snake: 1, paper: 1, omgshooter: 1, tanks: 1 };

  function paint(cv, gameId, skinId, t, big) {
    var g = BY[gameId], k = g && g.by[skinId], fn = PAINT[gameId];
    if (!k || !fn || !cv.width || !cv.height) return;
    fn(cv, k, t || 0, !!big);
  }

  root.V2Shop = {
    games: GAMES,
    game: function (id) { return BY[id] || null; },
    price: function (g, k) { return PR ? PR.price(g, k) : null; },
    tier: function (p) { return PR ? PR.tier(p) : null; },
    tiers: PR ? PR.TIERS : [],
    animated: function (id) { return !!MOVES[id]; },
    paint: paint,
  };
})(typeof window !== 'undefined' ? window : globalThis);
