/* The paid skins themselves: what each one looks like, and the drawing every game shares (docs/skin-purchases.md).

   One file for the lobby's previews (public/js/v2/shopArt.js) and the games that wear them, so a skin looks the same
   in Customize and in play: slither.io (the server turns `runs` into the custom skin bytes its own client already
   draws), agar.io (agarArt inside the cell), Paper.io (paperArt as the territory's pattern), Knockout (knockoutPiece)
   and Battleship (hullFor, the hull colours). Prices are NOT here: shared/shopPrices.js, the one file Owen edits.

   `id` is the key in shared/shopPrices.js. The order is the order on the page, cheapest first. Loaded as a plain
   script it lands on window.DS_SHOP_SKINS; required, it is module.exports. */
(function (root) {
  'use strict';
  var SKINS = {
    /* A slither custom skin: runs of [count, colour] from the colours slither lets a custom skin use (0 to 35,
       37, 39, 41). */
    snake: [
      { id: 'candycane', name: 'Candy Cane', runs: [[2, 31], [2, 9]] },
      { id: 'bumblebee', name: 'Bumblebee',  runs: [[3, 32], [3, 11]] },
      { id: 'glacier',   name: 'Glacier',    runs: [[3, 9], [3, 23], [2, 14]] },
      { id: 'toxic',     name: 'Toxic',      runs: [[3, 26], [2, 11], [1, 35]] },
      { id: 'ember',     name: 'Ember',      runs: [[3, 22], [2, 33], [2, 18]] },
      { id: 'sunset',    name: 'Sunset',     runs: [[2, 8], [2, 7], [2, 5], [2, 4]] },
      { id: 'royal',     name: 'Royal',      runs: [[3, 21], [2, 12], [1, 17]] },
      { id: 'rainbow',   name: 'Rainbow',    runs: [[1, 7], [1, 5], [1, 4], [1, 3], [1, 23], [1, 14], [1, 17]] },
    ],
    agar: [
      { id: 'twoface',    name: 'Two Face',   col: '#3fa9f5', art: 'split', alt: '#ff5a5f' },
      { id: 'bullseye',   name: 'Bullseye',   col: '#ff4040', art: 'rings', alt: '#ffffff' },
      { id: 'melon',      name: 'Melon',      col: '#5cc95c', art: 'melon', alt: '#2e8b3a' },
      { id: 'moon',       name: 'Moon',       col: '#c9ccd4', art: 'moon',  alt: '#9da2ad' },
      { id: 'peppermint', name: 'Peppermint', col: '#ffffff', art: 'swirl', alt: '#e8323c' },
      { id: 'eyeball',    name: 'Eyeball',    col: '#fdfdfd', art: 'eye',   alt: '#3d8be0' },
      { id: 'galaxy',     name: 'Galaxy',     col: '#1d1846', art: 'stars', alt: '#b49cff' },
      { id: 'sunburst',   name: 'Sunburst',   col: '#ffc21a', art: 'rays',  alt: '#ff8a00' },
    ],
    /* Pac-Man (chomp): the arcade chomper is a 13 px pixel disc, so a skin is a colour for each of its pixels
       (chompPx): halves, stripes, a rim, checks or bands, in colours that are no ghost's. */
    chomp: [
      { id: 'twotone', name: 'Two Tone', col: '#ffe14d', art: 'split',   alt: '#3fa9f5' },
      { id: 'candy',   name: 'Candy',    col: '#ffffff', art: 'stripes', alt: '#e8323c' },
      { id: 'frost',   name: 'Frost',    col: '#e6f6ff', art: 'rim',     alt: '#5aa9ff' },
      { id: 'checker', name: 'Checker',  col: '#ffffff', art: 'checks',  alt: '#9a6bff' },
      { id: 'neon',    name: 'Neon',     col: '#0f4d1a', art: 'rim',     alt: '#39ff14' },
      { id: 'lava',    name: 'Lava',     col: '#ff7a00', art: 'bands',   bands: ['#ffd23f', '#ff9a1a', '#ff5a1f', '#c81e00'] },
      { id: 'grape',   name: 'Grape',    col: '#9a4fe0', art: 'stripes', alt: '#ffd1ff' },
      { id: 'rainbow', name: 'Rainbow',  col: '#ffe14d', art: 'bands',
        bands: ['#ff4040', '#ff9a1a', '#ffe14d', '#5cc95c', '#3fa9f5', '#9a4fe0'] },
    ],
    paper: [
      { id: 'mint',      name: 'Mint',      col: '#3ee8b0', art: 'checks' },
      { id: 'ice',       name: 'Ice',       col: '#9fdcff', art: 'stripes' },
      { id: 'bubblegum', name: 'Bubblegum', col: '#ff77aa', art: 'dots' },
      { id: 'grape',     name: 'Grape',     col: '#8a4fc0', art: 'checks' },
      { id: 'lava',      name: 'Lava',      col: '#ff5a1f', art: 'stripes' },
      { id: 'camo',      name: 'Camo',      col: '#4a7c59', art: 'camo' },
      { id: 'midnight',  name: 'Midnight',  col: '#2b3a8c', art: 'stars' },
      { id: 'gold',      name: 'Gold',      col: '#f2b632', art: 'diamonds' },
    ],
    knockout: [
      { id: 'copper',   name: 'Copper',   col: '#c8743c' },
      { id: 'jade',     name: 'Jade',     col: '#4fb886' },
      { id: 'ice',      name: 'Ice',      col: '#bfe6f5' },
      { id: 'ruby',     name: 'Ruby',     col: '#d0354a' },
      { id: 'target',   name: 'Target',   col: '#f4f1ea', art: 'rings', alt: '#e0554a' },
      { id: 'obsidian', name: 'Obsidian', col: '#3a332d', art: 'gloss' },
      { id: 'marble',   name: 'Marble',   col: '#ece8e1', art: 'veins', alt: '#9b938a' },
      { id: 'gold',     name: 'Gold',     col: '#f0b83a', art: 'gloss' },
    ],
    battleship: [
      { id: 'navy',    name: 'Navy',    col: '#4a6496' },
      { id: 'arctic',  name: 'Arctic',  col: '#c9d3df' },
      { id: 'desert',  name: 'Desert',  col: '#b79c6c' },
      { id: 'rust',    name: 'Rust',    col: '#9a5634' },
      { id: 'crimson', name: 'Crimson', col: '#b13a3a' },
      { id: 'stealth', name: 'Stealth', col: '#3b4149', glass: '#e0554a' },
      { id: 'jungle',  name: 'Jungle',  col: '#5f7a3f', deck: '#3d4f2a' },
      { id: 'gold',    name: 'Gold',    col: '#d4a93c', glass: '#fff1b8' },
    ],
    omgshooter: [
      { id: 'desert',  name: 'Desert',  rim: '#e0c27a', core: '#4a3a16', panel: '#a8894a' },
      { id: 'arctic',  name: 'Arctic',  rim: '#e8f0f6', core: '#2c3a46', panel: '#9fb4c4' },
      { id: 'navy',    name: 'Navy',    rim: '#5c8de8', core: '#0c1a3a', panel: '#2c4f96' },
      { id: 'violet',  name: 'Violet',  rim: '#b47cf0', core: '#2a0f46', panel: '#6c3aa8' },
      { id: 'toxic',   name: 'Toxic',   rim: '#d4f02a', core: '#2a3a00', panel: '#7a9a10' },
      { id: 'shadow',  name: 'Shadow',  rim: '#5a5e66', core: '#0a0b0d', panel: '#2a2d33' },
      { id: 'crimson', name: 'Crimson', rim: '#ff3a5a', core: '#3a0010', panel: '#a01830' },
      { id: 'gold',    name: 'Gold',    rim: '#ffd23a', core: '#4a3200', panel: '#c08a10' },
    ],
    tanks: [
      { id: 'jade',    name: 'Jade',     col: '#4fb886' },
      { id: 'sky',     name: 'Sky',      col: '#7fd4f5' },
      { id: 'copper',  name: 'Copper',   col: '#c8743c' },
      { id: 'violet',  name: 'Violet',   col: '#a887d6' },
      { id: 'crimson', name: 'Crimson',  col: '#d0354a' },
      { id: 'twotone', name: 'Two Tone', col: '#8ed081', gun: '#f4f1ea' },
      { id: 'ghost',   name: 'Ghost',    col: '#f4f1ea', alpha: 0.55 },
      { id: 'gold',    name: 'Gold',     col: '#f0b83a', gun: '#fff1b8' },
    ],
  };

  function byId(game, id) {
    var list = Object.prototype.hasOwnProperty.call(SKINS, game) ? SKINS[game] : null;
    if (!list || typeof id !== 'string') return null;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  /* ── colour ─────────────────────────────────────────────────────────── */
  function hexRgb(h) { var n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
  function rgbHex(c) { return '#' + c.map(function (v) { v = Math.max(0, Math.min(255, Math.round(v))); return (v < 16 ? '0' : '') + v.toString(16); }).join(''); }
  function mix(a, b, f) { var x = hexRgb(a), y = hexRgb(b); return rgbHex([0, 1, 2].map(function (i) { return x[i] + (y[i] - x[i]) * f; })); }

  /* ── slither.io: a custom skin's bytes as slither's add-snake carries them (bytes 0 to 7 unused, then count,
     colour pairs; public/js/sl/slSprites.js setSkin). ───────────────── */
  function snakeBytes(runs) {
    var out = [0, 0, 0, 0, 0, 0, 0, 0];
    for (var i = 0; i < (runs || []).length; i++) out.push(runs[i][0], runs[i][1]);
    return out;
  }

  /* ── agar.io: the design inside a cell of radius R at (x, y), drawn after the cell's fill and clipped to it by
     the caller. Alpha is multiplied, never set, so a fading cell fades its design too. ────────────────── */
  function agarArt(ctx, k, x, y, R) {
    var i, a, base = ctx.globalAlpha;
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
          ctx.globalAlpha = base * (0.5 + (i % 3) * 0.25);
          ctx.beginPath(); ctx.arc(x + (u * 2 - 1) * R, y + (v * 2 - 1) * R, R * (0.02 + (i % 4) * 0.012), 0, 6.2832); ctx.fill(); }
        ctx.globalAlpha = base * 0.35; ctx.beginPath(); ctx.ellipse(x, y, R * 0.8, R * 0.22, -0.5, 0, 6.2832); ctx.fill();
        ctx.globalAlpha = base;
        break;
      case 'rays':
        for (i = 0; i < 12; i++) { a = i * Math.PI / 6; ctx.beginPath(); ctx.moveTo(x, y);
          ctx.arc(x, y, R, a, a + Math.PI / 12); ctx.closePath(); ctx.fill(); }
        ctx.fillStyle = k.col; ctx.beginPath(); ctx.arc(x, y, R * 0.45, 0, 6.2832); ctx.fill();
        break;
    }
  }

  /* ── Paper.io: the pattern over a square of side s at (x0, y0), in colour col. A territory repeats it as a tile. */
  function paperArt(ctx, k, x0, y0, s, col) {
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

  /* ── Pac-Man (chomp): the colour of the chomper's pixel (dx, dy) from its centre pixel, -6..6 (the 13 px disc of
     public/js/chomp/chompPixel.js chomper). The lobby's previews draw the same pixels bigger (shopArt paintChomp), and
     the free colours (shared/chompSkins.js, { col }) come out plain. ─────── */
  function chompPx(k, dx, dy) {
    switch (k.art) {
      case 'split': return dy < 0 ? k.col : k.alt;
      case 'stripes': return Math.floor((dy + 7) / 2) % 2 ? k.alt : k.col;
      case 'rim': return dx * dx + dy * dy > 20.25 ? k.alt : k.col;
      case 'checks': return (Math.floor((dx + 9) / 3) + Math.floor((dy + 9) / 3)) % 2 ? k.alt : k.col;
      case 'bands': {
        var n = k.bands.length;
        return k.bands[Math.max(0, Math.min(n - 1, Math.floor((dy + 6.5) / 13 * n)))];
      }
      default: return k.col;
    }
  }

  /* ── Knockout: a piece of radius pr at (x, y): the disc, its design clipped to it, then knockout.js's darker
     inner disc (inner = that disc's alpha, the game's own). ─────────────── */
  function knockoutPiece(ctx, k, x, y, pr, inner) {
    var base = ctx.globalAlpha;
    ctx.beginPath(); ctx.arc(x, y, pr, 0, 6.2832); ctx.fillStyle = k.col; ctx.fill();
    ctx.save(); ctx.beginPath(); ctx.arc(x, y, pr, 0, 6.2832); ctx.clip();
    if (k.art === 'rings') {
      ctx.fillStyle = k.alt; ctx.beginPath(); ctx.arc(x, y, pr * 0.8, 0, 6.2832); ctx.fill();
      ctx.fillStyle = k.col; ctx.beginPath(); ctx.arc(x, y, pr * 0.6, 0, 6.2832); ctx.fill();
    } else if (k.art === 'veins') {
      ctx.strokeStyle = k.alt; ctx.lineWidth = pr * 0.05; ctx.globalAlpha = base * 0.6;
      ctx.beginPath(); ctx.moveTo(x - pr, y - pr * 0.3); ctx.quadraticCurveTo(x - pr * 0.2, y - pr * 0.1, x + pr * 0.1, y + pr * 0.4);
      ctx.quadraticCurveTo(x + pr * 0.4, y + pr * 0.7, x + pr, y + pr * 0.5);
      ctx.moveTo(x - pr * 0.3, y - pr); ctx.quadraticCurveTo(x, y - pr * 0.4, x + pr * 0.6, y - pr * 0.2); ctx.stroke();
      ctx.globalAlpha = base;
    } else if (k.art === 'gloss') {
      var g = ctx.createLinearGradient(x, y - pr, x, y + pr);
      g.addColorStop(0, 'rgba(255,255,255,0.35)'); g.addColorStop(0.5, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(0,0,0,0.25)');
      ctx.fillStyle = g; ctx.fillRect(x - pr, y - pr, pr * 2, pr * 2);
    }
    ctx.restore();
    ctx.beginPath(); ctx.arc(x, y - pr * 0.12, pr * 0.58, 0, 6.2832);
    ctx.fillStyle = 'rgba(0,0,0,' + (inner == null ? 0.13 : inner) + ')'; ctx.fill();
  }

  /* ── Battleship: BattleshipArt.HULL's colours for a skin (swapped in around a drawShip call). */
  function hullFor(k) {
    return {
      steel: k.col, steelHi: mix(k.col, '#ffffff', 0.18), steelLo: mix(k.col, '#000000', 0.27),
      deck: k.deck || mix(k.col, '#000000', 0.43), deckHi: mix(k.deck || k.col, '#000000', 0.27),
      trim: mix(k.col, '#000000', 0.65), glass: k.glass || '#9fd0e8',
    };
  }

  var api = { SKINS: SKINS, byId: byId, snakeBytes: snakeBytes, agarArt: agarArt, paperArt: paperArt,
              knockoutPiece: knockoutPiece, hullFor: hullFor, chompPx: chompPx, hexRgb: hexRgb, rgbHex: rgbHex, mix: mix };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.DS_SHOP_SKINS = api;
})(typeof window !== 'undefined' ? window : null);
