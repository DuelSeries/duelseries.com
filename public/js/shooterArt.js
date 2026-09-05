'use strict';
/* ─── OMG Shooter — the art ───────────────────────────────────────────────────
   Every sprite in this game is drawn here, in canvas. There are no image files
   and nothing was copied: what was taken from Awesome Tanks 2 is measurements —
   sizes, ratios and colour values — which are facts about a picture rather than
   the picture. Their artwork stays theirs.

   HOW THE NUMBERS WERE GOT. Their game ships a TexturePacker atlas
   (images/game.png + game.json). The JSON was read for exact frame sizes, and
   the PNG was drawn into a canvas so exact pixels could be sampled. Nothing
   below is estimated from a screenshot and nothing is guessed:

     tile                54 x 54
     tank body           41 x 42        (0.76 x 0.78 of a tile)
       tread bands       10 thick, top and bottom, the full 41 across
       hull              x 4..37 (34 wide), y 10..31 (22 tall)
     turret + gun        54 x 39, pivot at (23.5, 19.5)
     crate, barrel       35 x 35        (0.65 of a tile)
     bricks              52 x 52
     health pickup       20 x 22        coin 11 x 12       bullet 7 x 7

   Every gun's silhouette came off the same atlas, as the first and last opaque
   pixel of every row. Barrel reach from the turret pivot:

     cannon 29.5   minigun 23.5   shotgun 20.5   shock 24.5   rockets 27.5
     ricochet 26.5   railgun 26.5   laser 20.5   flamethrower 28.5

   THE ONE THING THAT SURPRISED ME. Their guns are painted the tank's own
   colours, not steel. A grey barrel is the obvious thing to draw and it is
   wrong — it made our tanks read as a toy with a metal stick on top, which is
   exactly the sort of thing that "looks close but is off" and cannot be argued
   about once the real colour is in hand.

   So the drawing space here is "atlas pixels", where a tile is 54. Callers pass
   a world size and this scales to it, which means every ratio survives every
   zoom and none of these numbers ever has to be re-derived. */

(function (root) {

  var TILE = 54;                 // atlas pixels across one tile: the unit for everything
  var BODY_W = 41, BODY_H = 42;
  var TRACK = 6;                 // each track band, top and bottom (y 0..5, 36..41)
  var HULL_W = 35, HULL_H = 31;  // the rimmed block between the tracks
  var GUN_W = 54, GUN_H = 39, GUN_PX = 23.5, GUN_PY = 19.5;

  /* Measured off game.png. The player is dark red with orange fittings; the
     enemies are amber with dark brown tracks. Ours keep those two exactly, and
     add a green so a free-for-all can tell you apart from everybody else —
     which their single-player game never had to do. */
  /* Read out of the sprites themselves rather than off a colour histogram,
     which is why the structure below is what it is: their hull is a BRIGHT
     ORANGE RIM around a dark red core, their tracks are near-black with
     transparent gaps between the links, and their barrels are dark red rather
     than the body colour. Every one of those three was wrong in the first
     pass and every one of them is what made it read as "close but not it". */
  var TEAMS = {
    them: {                                   // their player tank, exactly
      rim: '#ff8811', rimDim: '#ee6622', core: '#660000', panel: '#aa3333',
      barrel: '#882222', barrelDim: '#772222', lit: '#ffcc77',
      track: '#220000', line: '#000000',
    },
    enemy: {                                  // their enemy tanks, exactly
      rim: '#f5ad23', rimDim: '#dc961a', core: '#493000', panel: '#925102',
      barrel: '#5a3a06', barrelDim: '#392500', lit: '#ffd06a',
      track: '#2a1608', line: '#160b04',
    },
    you: {                                    // ours: the same build, our green
      rim: '#9ede4a', rimDim: '#6fb32f', core: '#173a0c', panel: '#39702a',
      barrel: '#20501a', barrelDim: '#173a0c', lit: '#d8f7a8',
      track: '#0d1a06', line: '#000000',
    },
  };
  /* The ten, in their order. Every one draws a different barrel, because a
     weapon you cannot see on your own tank is one you have to remember you
     picked. Mines is ours: their game deploys them and draws no barrel for it,
     so there was nothing to measure and a dispenser is the honest invention. */
  var WEAPONS = [
    { key: 'minigun',      name: 'Minigun',      blurb: 'Two barrels, no pause, and not much per shot.' },
    { key: 'shotgun',      name: 'Shotgun',      blurb: 'A wall of pellets. Brutal up close, useless down a corridor.' },
    { key: 'ricochet',     name: 'Ricochet',     blurb: 'Bounces off stone. Shoot the wall, not the tank.' },
    { key: 'flamethrower', name: 'Flamethrower', blurb: 'Short reach, constant damage, and it lights up the room.' },
    { key: 'cannon',       name: 'Cannon',       blurb: 'One heavy shell. Slow, and it hurts.' },
    { key: 'shock',        name: 'Shock',        blurb: 'Jumps between anything close. No aiming required.' },
    { key: 'rockets',      name: 'Rockets',      blurb: 'Splash damage, so near enough is good enough.' },
    { key: 'laser',        name: 'Laser',        blurb: 'Instant, down a line, straight through crates.' },
    { key: 'railgun',      name: 'Railgun',      blurb: 'Punches the length of the arena. Long wait between shots.' },
    { key: 'mines',        name: 'Mines',        blurb: 'Leave them behind you and drive away.' },
  ];

  /* ── helpers ───────────────────────────────────────────────────────────── */

  function rr(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function fillLine(ctx, fill, line, w) {
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (line) { ctx.strokeStyle = line; ctx.lineWidth = w || 2; ctx.stroke(); }
  }
  function hash(a, b) {
    var h = (a * 374761393 + b * 668265263) | 0;
    h = (h ^ (h >>> 13)) * 1274126177;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  /* ── the guns ───────────────────────────────────────────────────────────
     Drawn around the pivot, pointing along +x, in atlas pixels. Every length
     here is the measured reach from that pivot, so a barrel that looks short is
     short in their game too. */

  function gun(ctx, key, p) {
    ctx.lineJoin = 'round';
    var L = p.line;

    /* Their barrels are dark red, not the body colour and not steel. Every gun
       below is the same two materials: a rimmed body block and dark tubes. */
    function body(x, y, w, h, r) {
      rr(ctx, x, y, w, h, r);
      fillLine(ctx, p.rim, L, 2.2);
      rr(ctx, x + 2.6, y + 2.6, w - 5.2, h - 5.2, Math.max(1, r - 2));
      ctx.fillStyle = p.lit; ctx.globalAlpha = 0.55; ctx.fill(); ctx.globalAlpha = 1;
    }
    function tube(x, y, len, thick) {
      rr(ctx, x, y - thick / 2, len, thick, thick * 0.35);
      fillLine(ctx, p.barrel, L, 1.8);
    }

    if (key === 'minigun') {
      // Body x14..33 of the 54 sprite, two tubes 4 thick at y -5 and +4,
      // reaching 23.5 from the pivot.
      tube(4, -5, 20, 4.4);
      tube(4, 4.5, 20, 4.4);
      body(-9.5, -11.5, 20, 23, 6);
      return;
    }
    if (key === 'shotgun') {
      tube(2, 0, 19, 9);
      rr(ctx, 15, -7, 5.5, 14, 2.4); fillLine(ctx, p.barrelDim, L, 1.8);
      body(-11.5, -13.5, 21, 27, 7);
      return;
    }
    if (key === 'ricochet') {
      tube(6, 0, 21, 5.5);
      rr(ctx, 22, -5, 5, 10, 2); fillLine(ctx, p.barrelDim, L, 1.8);
      ctx.beginPath(); ctx.ellipse(-3, 0, 13, 19.5, 0, 0, Math.PI * 2);
      fillLine(ctx, p.rim, L, 2.2);
      ctx.beginPath(); ctx.ellipse(-3, 0, 8.5, 14, 0, 0, Math.PI * 2);
      ctx.fillStyle = p.core; ctx.fill();
      return;
    }
    if (key === 'flamethrower') {
      tube(4, 0, 20, 4.5);
      ctx.beginPath();
      ctx.moveTo(20, -3.5); ctx.lineTo(28.5, -8); ctx.lineTo(28.5, 8); ctx.lineTo(20, 3.5);
      ctx.closePath(); fillLine(ctx, '#e0561f', L, 1.8);
      body(-15, -15, 26, 30, 9);
      rr(ctx, -16, -8, 9, 16, 4); fillLine(ctx, '#b8402a', L, 1.8);
      return;
    }
    if (key === 'shock') {
      tube(6, -4, 18, 4.4);
      tube(6, 4, 18, 4.4);
      ctx.beginPath(); ctx.arc(24.5, 0, 6.5, -Math.PI / 2, Math.PI / 2);
      ctx.strokeStyle = '#8fd6ff'; ctx.lineWidth = 2.4; ctx.stroke();
      ctx.beginPath(); ctx.arc(-5, 0, 14, 0, Math.PI * 2);
      fillLine(ctx, p.rim, L, 2.2);
      ctx.beginPath(); ctx.arc(-5, 0, 9, 0, Math.PI * 2);
      ctx.fillStyle = p.core; ctx.fill();
      return;
    }
    if (key === 'rockets') {
      tube(8, -4.5, 19, 4.6);
      tube(8, 4.5, 19, 4.6);
      body(-13.5, -9.5, 26, 19, 5);
      for (var t = -1; t <= 1; t += 2) {
        ctx.beginPath(); ctx.arc(26, t * 4.5, 2.8, 0, Math.PI * 2);
        fillLine(ctx, '#c0392b', L, 1.4);
      }
      return;
    }
    if (key === 'laser') {
      tube(4, 0, 13, 5);
      ctx.beginPath(); ctx.arc(19, 0, 5.5, 0, Math.PI * 2);
      fillLine(ctx, '#ff4b4b', L, 1.8);
      ctx.beginPath(); ctx.arc(19, 0, 2, 0, Math.PI * 2);
      ctx.fillStyle = '#ffe3e3'; ctx.fill();
      body(-23.5, -13.5, 30, 27, 8);
      return;
    }
    if (key === 'railgun') {
      tube(2, 0, 24.5, 7);
      rr(ctx, 13, -5.5, 3.5, 11, 1.4); fillLine(ctx, '#6fd0ff', L, 1.4);
      body(-21.5, -15, 26, 30, 7);
      return;
    }
    if (key === 'mines') {
      // Ours. Their game deploys them and draws no barrel, so nothing here is
      // measured and a dispenser is the honest invention.
      body(-10, -10, 22, 20, 6);
      ctx.beginPath(); ctx.arc(2, 0, 6.5, 0, Math.PI * 2);
      fillLine(ctx, '#e0a020', L, 1.8);
      ctx.beginPath(); ctx.arc(2, 0, 2.4, 0, Math.PI * 2);
      ctx.fillStyle = L; ctx.fill();
      return;
    }
    // cannon: a round turret, barrel 6 thick reaching 29.5.
    tube(6, 0, 23.5, 6.5);
    ctx.beginPath(); ctx.arc(0, 0, 12, 0, Math.PI * 2);
    fillLine(ctx, p.rim, L, 2.2);
    ctx.beginPath(); ctx.arc(0, 0, 8, 0, Math.PI * 2);
    ctx.fillStyle = p.core; ctx.fill();
    ctx.beginPath(); ctx.arc(-2.5, -2.5, 3.4, 0, Math.PI * 2);
    ctx.fillStyle = p.panel; ctx.fill();
  }
  /* ── the tank ───────────────────────────────────────────────────────────
     Hull and turret point in different directions, which is the whole feel of
     the genre: you drive one way and shoot another.

     o = { x, y, size, hull, turret, team, weapon, hp, max, roll } where `size`
     is how many world units the 41-wide body should span, and `roll` is a
     distance travelled that animates the tracks — their sprite has two body
     frames for exactly this. */

  function drawTank(ctx, o) {
    var p = TEAMS[o.team] || TEAMS.you;
    var size = o.size || BODY_W;
    var k = size / BODY_W;

    ctx.save();
    ctx.translate(o.x, o.y);
    ctx.scale(k, k);
    ctx.lineJoin = 'round';

    ctx.save();
    ctx.rotate(o.hull || 0);

    /* Tracks. Six thick, the full body width, and drawn as SEGMENTS with gaps
       between them — their sprite has transparent holes there and the grass
       shows through. A solid dark bar is the obvious thing to draw and it is
       what made ours read as a brick with a lid rather than a tank. */
    var seg = 3.4, gap = 2.2, pitch = seg + gap;
    var roll = ((o.roll || 0) % pitch + pitch) % pitch;
    ctx.fillStyle = p.track;
    for (var s2 = -1; s2 <= 1; s2 += 2) {
      var by = s2 * (BODY_H / 2 - TRACK / 2);
      for (var lx = -BODY_W / 2 - pitch + roll; lx < BODY_W / 2; lx += pitch) {
        var x0 = Math.max(-BODY_W / 2, lx), x1 = Math.min(BODY_W / 2, lx + seg);
        if (x1 > x0) ctx.fillRect(x0, by - TRACK / 2, x1 - x0, TRACK);
      }
      // The rails the links run on, so the band still reads as one track.
      ctx.fillRect(-BODY_W / 2, by - TRACK / 2, BODY_W, 1.1);
      ctx.fillRect(-BODY_W / 2, by + TRACK / 2 - 1.1, BODY_W, 1.1);
    }

    /* The hull: a bright rim around a dark core. Not a dark hull with a black
       outline, which is what ours was and is the single biggest reason it did
       not look like theirs. */
    rr(ctx, -HULL_W / 2, -HULL_H / 2, HULL_W, HULL_H, 8);
    fillLine(ctx, p.rim, p.line, 2);
    rr(ctx, -HULL_W / 2 + 3.6, -HULL_H / 2 + 3.6, HULL_W - 7.2, HULL_H - 7.2, 5);
    ctx.fillStyle = p.core; ctx.fill();
    // A lighter panel across the middle, and a lit nose so the hull has a front.
    ctx.save();
    rr(ctx, -HULL_W / 2 + 3.6, -HULL_H / 2 + 3.6, HULL_W - 7.2, HULL_H - 7.2, 5);
    ctx.clip();
    ctx.fillStyle = p.panel;
    ctx.fillRect(-HULL_W / 2, -3.2, HULL_W, 6.4);
    ctx.fillStyle = p.rimDim;
    ctx.fillRect(HULL_W / 2 - 8, -HULL_H / 2, 8, HULL_H);
    ctx.restore();
    ctx.restore();
    // Turret and gun, on their own heading.
    if (!o.noGun) {
      ctx.save();
      ctx.rotate(o.turret || 0);
      gun(ctx, o.weapon || 'cannon', p);
      ctx.restore();
    }

    ctx.restore();

    if (o.hp !== undefined && o.max && o.hp < o.max) drawHealth(ctx, o, size);
    if (o.label) drawLabel(ctx, o, size);
  }

  /* Their life bar is 95 x 15 for a 41-wide tank — more than twice its width,
     which above a tank in a crowd is a bar per tank and no tanks. Ours is the
     tank's own width, which is the readable version of the same idea. */
  function drawHealth(ctx, o, size) {
    var w = size * 1.0, h = Math.max(2.5, size * 0.09);
    var x = o.x - w / 2, y = o.y - size * 0.78;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    rr(ctx, x - 1.5, y - 1.5, w + 3, h + 3, (h + 3) / 2); ctx.fill();
    ctx.fillStyle = o.team === 'you' ? '#9ede4a' : '#ef3f35';
    rr(ctx, x, y, Math.max(1, w * (o.hp / o.max)), h, h / 2); ctx.fill();
  }

  function drawLabel(ctx, o, size) {
    ctx.save();
    ctx.font = '600 ' + Math.round(size * 0.30) + 'px Archivo, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(2, size * 0.09);
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.strokeText(o.label, o.x, o.y + size * 0.92);
    ctx.fillStyle = o.team === 'you' ? '#d3f39b' : '#ffd8b0';
    ctx.fillText(o.label, o.x, o.y + size * 0.92);
    ctx.restore();
  }

  /* ── the ground and the blocks ──────────────────────────────────────────
     All of these are drawn to fill a tile of `s` world units, with the colours
     sampled off their atlas rather than picked. */

  /* Every one of these was rebuilt from the sprite's own pixels, sampled on a
     3px grid off their atlas and read as structure rather than as a palette.
     What the first pass got wrong, in every case, was the STRUCTURE: flat
     squares where they have layered bevels, four huge blocks where they have
     five courses of brick, horizontal bars where they have vertical planks. */

  var GRASS = '#3a8145';

  function drawGrass(ctx, x, y, s, col, row) {
    ctx.fillStyle = GRASS;
    ctx.fillRect(x, y, s, s);
    /* Their grass tile is 58% one flat colour and the rest a fine scatter
       within two or three points of it. Denser than the first pass, which read
       as a flat fill next to theirs. */
    var u = s / 54;
    for (var i = 0; i < 14; i++) {
      var h1 = hash(col * 31 + i, row * 17 + i * 5), h2 = hash(col * 13 + i * 3, row * 41 + i);
      ctx.fillStyle = h1 > 0.5 ? '#3c8548' : '#377c41';
      ctx.fillRect(x + h1 * (s - 3 * u), y + h2 * (s - 3 * u), 3 * u, 3 * u);
    }
    var p = hash(col, row);
    if (p > 0.86) {
      ctx.fillStyle = p > 0.94 ? '#e6d3a6' : '#c9855c';
      var px = x + hash(col + 1, row) * s * 0.7 + s * 0.15;
      var py = y + hash(col, row + 1) * s * 0.7 + s * 0.15;
      ctx.beginPath(); ctx.ellipse(px, py, s * 0.05, s * 0.033, p * 6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /* Stone, read off wall_0 on a 3px grid. Five layers, not one: black outline,
     a #776655 shoulder, a #ccaa99 bevel, the #aa9988 face, and a #554444 shadow
     along the bottom and right. That layering is the whole reason theirs looks
     carved and a flat grey square does not. */
  function drawStone(ctx, x, y, s, col, row) {
    var u = s / 54;
    ctx.fillStyle = '#000000'; ctx.fillRect(x, y, s, s);
    rr(ctx, x + 2 * u, y + 2 * u, s - 4 * u, s - 4 * u, 7 * u);
    ctx.fillStyle = '#776655'; ctx.fill();
    ctx.save(); ctx.clip();
    ctx.fillStyle = '#554444';
    ctx.fillRect(x, y + s - 8 * u, s, 8 * u);
    ctx.fillRect(x + s - 8 * u, y, 8 * u, s);
    ctx.restore();
    rr(ctx, x + 5 * u, y + 5 * u, s - 13 * u, s - 13 * u, 5 * u);
    ctx.fillStyle = '#ccaa99'; ctx.fill();
    rr(ctx, x + 8 * u, y + 8 * u, s - 19 * u, s - 19 * u, 4 * u);
    ctx.fillStyle = '#aa9988'; ctx.fill();
    // Chips, the same every time you come back to the same cell.
    ctx.fillStyle = '#bbaa99';
    for (var i = 0; i < 3; i++) {
      var h1 = hash((col || 0) * 7 + i, (row || 0) * 3 + i * 5);
      var h2 = hash((col || 0) * 11 + i * 2, (row || 0) * 19 + i);
      ctx.fillRect(x + (10 + h1 * 30) * u, y + (10 + h2 * 30) * u, 3 * u, 3 * u);
    }
  }

  /* Brick: five courses, offset, with mortar between them. The first pass drew
     four flat blocks the size of a quarter of the tile, which at any zoom reads
     as a red square rather than as brick. */
  function drawBrick(ctx, x, y, s, col, row) {
    var u = s / 52, tones = ['#ee5533', '#dd6633', '#ee6644', '#aa3322'];
    ctx.fillStyle = '#772211'; ctx.fillRect(x, y, s, s);
    var courses = 5, ch = (s - 6 * u) / courses, bw = 14 * u;
    for (var r = 0; r < courses; r++) {
      var off = (r % 2) ? -bw / 2 : 0;
      for (var c = -1; c < 4; c++) {
        var bx = x + 3 * u + off + c * bw;
        var x0 = Math.max(x + 3 * u, bx + 1.5 * u);
        var x1 = Math.min(x + s - 3 * u, bx + bw - 1.5 * u);
        if (x1 <= x0) continue;
        ctx.fillStyle = tones[Math.floor(hash((col || 0) * 5 + c, (row || 0) * 7 + r) * tones.length)];
        ctx.fillRect(x0, y + 3 * u + r * ch + 1.5 * u, x1 - x0, ch - 3 * u);
      }
    }
    ctx.strokeStyle = '#000000'; ctx.lineWidth = 3 * u;
    ctx.strokeRect(x + 1.5 * u, y + 1.5 * u, s - 3 * u, s - 3 * u);
  }

  /* Wood: a panel of VERTICAL planks, dark on the left and lighter on the
     right, with grain. The first pass drew horizontal bars, which is the one
     thing it definitely is not. */
  function drawWood(ctx, x, y, s, col, row) {
    var u = s / 52, planks = 6, pw = (s - 6 * u) / planks;
    ctx.fillStyle = '#000000'; ctx.fillRect(x, y, s, s);
    /* A left-to-right lightening across the whole panel, with the plank joins
       as faint darker lines rather than colour steps. Six flat stripes read as
       a barcode; theirs reads as one board. */
    var g = ctx.createLinearGradient(x, y, x + s, y + s);
    g.addColorStop(0, '#c05c14'); g.addColorStop(0.5, '#d87023'); g.addColorStop(1, '#ee8833');
    ctx.fillStyle = g;
    ctx.fillRect(x + 3 * u, y + 3 * u, s - 6 * u, s - 6 * u);
    for (var i = 1; i < planks; i++) {
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.fillRect(x + 3 * u + i * pw - 0.7 * u, y + 3 * u, 1.4 * u, s - 6 * u);
      // Grain: one faint streak inside each plank, fixed per cell.
      ctx.fillStyle = 'rgba(0,0,0,0.10)';
      var gx = x + 3 * u + (i - 1) * pw + (0.3 + hash((col || 0) + i, row || 0) * 0.4) * pw;
      ctx.fillRect(gx, y + 5 * u, 1.2 * u, s - 10 * u);
    }
  }

  /* Crate: 35 of 54, so it sits inside its tile with grass all round it.
     Vertical planks with two dark divisions, a light plank near the left, and
     two darker bands across. */
  function drawCrate(ctx, x, y, s, hp) {
    var u = s / 54, i = 9.5 * u, w = 35 * u;
    var bx = x + i, by = y + i;
    ctx.fillStyle = '#000000'; ctx.fillRect(bx, by, w, w);
    ctx.fillStyle = '#ff8822'; ctx.fillRect(bx + 2 * u, by + 2 * u, w - 4 * u, w - 4 * u);
    // Two thin darker bands, at a quarter and three quarters down.
    ctx.fillStyle = '#bb6611';
    ctx.fillRect(bx + 2 * u, by + 8 * u, w - 4 * u, 2.5 * u);
    ctx.fillRect(bx + 2 * u, by + 25 * u, w - 4 * u, 2.5 * u);
    // Plank divisions, and the lit plank near the left edge.
    ctx.fillStyle = '#eeaa44'; ctx.fillRect(bx + 5 * u, by + 2 * u, 2 * u, w - 4 * u);
    ctx.fillStyle = '#774411';
    ctx.fillRect(bx + 9 * u, by + 2 * u, 2 * u, w - 4 * u);
    ctx.fillRect(bx + 23 * u, by + 2 * u, 2 * u, w - 4 * u);
    ctx.fillStyle = '#eeaa44'; ctx.fillRect(bx + 27 * u, by + 2 * u, 2 * u, w - 4 * u);
    /* Their crates have no bar; ours do, because Owen asked to see one and a
       crate you have already hit twice is worth knowing about. */
    if (hp !== undefined && hp < 1) {
      var barW = w * 0.9, barH = Math.max(2, 3 * u);
      var px = bx + (w - barW) / 2, py = by - barH - 2 * u;
      ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(px - 1, py - 1, barW + 2, barH + 2);
      ctx.fillStyle = '#ffb500'; ctx.fillRect(px, py, barW * Math.max(0, hp), barH);
    }
  }

  /* Barrel: a 35 circle, black outlined, a bright #ff4411 ring round a dark
     #bb2200 body, lit on the left. Darker overall than the first pass, which
     was almost the same orange as a crate. */
  function drawBarrel(ctx, x, y, s) {
    var cx = x + s / 2, cy = y + s / 2, r = 17.5 * (s / 54);
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    fillLine(ctx, '#ff4411', '#000000', Math.max(1, s * 0.045));
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.74, 0, Math.PI * 2);
    ctx.fillStyle = '#bb2200'; ctx.fill();
    ctx.beginPath(); ctx.arc(cx - r * 0.3, cy - r * 0.06, r * 0.36, 0, Math.PI * 2);
    ctx.fillStyle = '#ff5522'; ctx.fill();
    ctx.beginPath(); ctx.arc(cx + r * 0.3, cy + r * 0.18, r * 0.28, 0, Math.PI * 2);
    ctx.fillStyle = '#881100'; ctx.fill();
  }
  /* Pickups, at their measured sizes: health is a 20x22 white box with a red
     cross, a coin is 11x12 of #ffb500. */
  function drawMedkit(ctx, x, y, s) {
    var w = s * 0.37, h = s * 0.41;
    rr(ctx, x - w / 2, y - h / 2, w, h, s * 0.06);
    fillLine(ctx, '#f3e7da', '#000000', Math.max(1, s * 0.037));
    ctx.fillStyle = '#ef3f35';
    ctx.fillRect(x - w * 0.32, y - h * 0.12, w * 0.64, h * 0.24);
    ctx.fillRect(x - w * 0.12, y - h * 0.32, w * 0.24, h * 0.64);
  }

  function drawCoin(ctx, x, y, s, big) {
    var r = s * (big ? 0.16 : 0.11);
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    fillLine(ctx, '#ffb500', '#513a00', Math.max(1, s * 0.03));
    ctx.beginPath(); ctx.arc(x - r * 0.28, y - r * 0.28, r * 0.34, 0, Math.PI * 2);
    ctx.fillStyle = '#ffe49f'; ctx.fill();
  }

  root.ShooterArt = {
    TILE: TILE, BODY_W: BODY_W, BODY_H: BODY_H, GUN_W: GUN_W, GUN_H: GUN_H,
    GUN_PIVOT: [GUN_PX, GUN_PY],
    TEAMS: TEAMS, WEAPONS: WEAPONS, GRASS: GRASS,
    drawTank: drawTank, gun: gun, roundRect: rr,
    drawGrass: drawGrass, drawStone: drawStone, drawBrick: drawBrick,
    drawWood: drawWood, drawCrate: drawCrate, drawBarrel: drawBarrel,
    drawMedkit: drawMedkit, drawCoin: drawCoin,
  };

})(typeof window !== 'undefined' ? window : globalThis);
