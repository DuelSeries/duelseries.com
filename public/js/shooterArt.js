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
  var TREAD = 10;                // each band, top and bottom
  var HULL_X = 4, HULL_W = 34;   // x 4..37
  var HULL_Y = 10, HULL_H = 22;  // y 10..31
  var GUN_W = 54, GUN_H = 39, GUN_PX = 23.5, GUN_PY = 19.5;

  /* Measured off game.png. The player is dark red with orange fittings; the
     enemies are amber with dark brown tracks. Ours keep those two exactly, and
     add a green so a free-for-all can tell you apart from everybody else —
     which their single-player game never had to do. */
  var TEAMS = {
    them: {                                   // their player tank, exactly
      hull: '#650a0a', hullLit: '#a93533', hullDim: '#4a0707',
      trim: '#f5821f', trimLit: '#fac574', trimDim: '#89280f',
      tread: '#2b0e0d', link: '#3d2007', line: '#000000',
    },
    enemy: {                                  // their enemy tanks, exactly
      hull: '#f5ad23', hullLit: '#ffd06a', hullDim: '#925102',
      trim: '#dc961a', trimLit: '#ffd06a', trimDim: '#975404',
      tread: '#493000', link: '#392500', line: '#2a0e0d',
    },
    you: {                                    // ours: the same build, our green
      hull: '#2f6d1c', hullLit: '#57a333', hullDim: '#1d4a11',
      trim: '#9ede4a', trimLit: '#d3f39b', trimDim: '#356b18',
      tread: '#14240c', link: '#25391a', line: '#000000',
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

    if (key === 'minigun') {
      // Body x14..34 of a 54 sprite, so 9.5 back from the pivot to 10.5 ahead.
      // Two barrels, four thick, at y -5 and +4, reaching 23.5.
      rr(ctx, -3, -5.5, 8, 4.4, 1.6); fillLine(ctx, p.trimDim, L, 1.6);
      rr(ctx, -3, 1.1, 8, 4.4, 1.6); fillLine(ctx, p.trimDim, L, 1.6);
      rr(ctx, 4, -6.2, 19.5, 5, 2); fillLine(ctx, p.trim, L, 1.8);
      rr(ctx, 4, 1.2, 19.5, 5, 2); fillLine(ctx, p.trim, L, 1.8);
      rr(ctx, -9.5, -11, 20, 22, 6); fillLine(ctx, p.trim, L, 2.2);
      rr(ctx, -6, -7.5, 12, 15, 4); fillLine(ctx, p.trimLit, null);
      return;
    }
    if (key === 'shotgun') {
      // Body x12..33 (21 wide, 27 tall), barrel 9 thick out to 20.5.
      rr(ctx, 2, -4.5, 18.5, 9, 3); fillLine(ctx, p.trim, L, 1.8);
      rr(ctx, 15, -6, 5.5, 12, 2.4); fillLine(ctx, p.trimLit, L, 1.8);
      rr(ctx, -11.5, -13.5, 21, 27, 7); fillLine(ctx, p.trim, L, 2.2);
      rr(ctx, -8, -9.5, 13, 19, 5); fillLine(ctx, p.trimLit, null);
      return;
    }
    if (key === 'ricochet') {
      // The tallest gun they draw: the full 39 rows. Barrel 5 thick to 26.5.
      rr(ctx, 2, -2.5, 24.5, 5, 2); fillLine(ctx, p.trim, L, 1.8);
      rr(ctx, 20, -4.5, 6.5, 9, 2.6); fillLine(ctx, p.trimLit, L, 1.8);
      ctx.beginPath(); ctx.ellipse(-3, 0, 13, 19.5, 0, 0, Math.PI * 2);
      fillLine(ctx, p.trim, L, 2.2);
      ctx.beginPath(); ctx.ellipse(-3, 0, 8, 14, 0, 0, Math.PI * 2);
      fillLine(ctx, p.trimLit, null);
      return;
    }
    if (key === 'flamethrower') {
      // Their biggest body, rows 1..36, nozzle out to 28.5.
      rr(ctx, 0, -2, 22, 4, 1.6); fillLine(ctx, p.trimDim, L, 1.6);
      ctx.beginPath();
      ctx.moveTo(18, -3); ctx.lineTo(28.5, -7); ctx.lineTo(28.5, 7); ctx.lineTo(18, 3);
      ctx.closePath(); fillLine(ctx, '#e0561f', L, 1.8);
      ctx.beginPath(); ctx.ellipse(-4, 0, 16, 18, 0, 0, Math.PI * 2);
      fillLine(ctx, p.trim, L, 2.2);
      rr(ctx, -14, -8, 14, 16, 5); fillLine(ctx, '#b8402a', L, 1.8);
      ctx.beginPath(); ctx.ellipse(-2, 0, 8, 11, 0, 0, Math.PI * 2);
      fillLine(ctx, p.trimLit, null);
      return;
    }
    if (key === 'shock') {
      // Two prongs, rows 14..23, reaching 24.5.
      rr(ctx, 2, -6, 22.5, 4.4, 1.8); fillLine(ctx, p.trimDim, L, 1.6);
      rr(ctx, 2, 1.6, 22.5, 4.4, 1.8); fillLine(ctx, p.trimDim, L, 1.6);
      ctx.beginPath(); ctx.arc(24.5, 0, 6.5, -Math.PI / 2, Math.PI / 2);
      ctx.strokeStyle = '#8fd6ff'; ctx.lineWidth = 2.4; ctx.stroke();
      ctx.beginPath(); ctx.ellipse(-5, 0, 14, 14, 0, 0, Math.PI * 2);
      fillLine(ctx, p.trim, L, 2.2);
      ctx.beginPath(); ctx.ellipse(-5, 0, 8.5, 8.5, 0, 0, Math.PI * 2);
      fillLine(ctx, p.trimLit, null);
      return;
    }
    if (key === 'rockets') {
      // A launcher box, x10..38, tubes out to 27.5.
      rr(ctx, -13.5, -8.5, 28, 17, 4); fillLine(ctx, p.trim, L, 2.2);
      rr(ctx, -10, -5.5, 17, 11, 3); fillLine(ctx, p.trimDim, null);
      for (var t = -1; t <= 1; t += 2) {
        rr(ctx, 10, t * 4 - 2.2, 17.5, 4.4, 2); fillLine(ctx, p.trimLit, L, 1.6);
        ctx.beginPath(); ctx.arc(26, t * 4, 2.6, 0, Math.PI * 2);
        fillLine(ctx, '#c0392b', L, 1.4);
      }
      return;
    }
    if (key === 'laser') {
      // Body from the very back of the sprite, barrel 5 thick to 20.5.
      rr(ctx, 0, -2.5, 16, 5, 2); fillLine(ctx, p.trimDim, L, 1.6);
      ctx.beginPath(); ctx.arc(19, 0, 5.5, 0, Math.PI * 2);
      fillLine(ctx, '#ff4b4b', L, 1.8);
      ctx.beginPath(); ctx.arc(19, 0, 2, 0, Math.PI * 2);
      ctx.fillStyle = '#ffe3e3'; ctx.fill();
      rr(ctx, -23.5, -13.5, 30, 27, 8); fillLine(ctx, p.trim, L, 2.2);
      rr(ctx, -19, -9, 21, 18, 5); fillLine(ctx, p.trimLit, null);
      return;
    }
    if (key === 'railgun') {
      // Rows 4..33 with a long slim barrel, 8 thick, out to 26.5.
      rr(ctx, 0, -4, 26.5, 8, 2.5); fillLine(ctx, p.trimDim, L, 1.8);
      rr(ctx, 14, -5.5, 4, 11, 1.6); fillLine(ctx, '#6fd0ff', L, 1.4);
      rr(ctx, -21.5, -15, 26, 30, 7); fillLine(ctx, p.trim, L, 2.2);
      rr(ctx, -17, -10, 18, 20, 5); fillLine(ctx, p.trimLit, null);
      return;
    }
    if (key === 'mines') {
      // Ours. Their game draws no barrel for it, so nothing here is measured.
      rr(ctx, -10, -10, 22, 20, 6); fillLine(ctx, p.trim, L, 2.2);
      ctx.beginPath(); ctx.arc(2, 0, 6.5, 0, Math.PI * 2);
      fillLine(ctx, '#e0a020', L, 1.8);
      ctx.beginPath(); ctx.arc(2, 0, 2.4, 0, Math.PI * 2);
      ctx.fillStyle = L; ctx.fill();
      return;
    }
    // cannon: a round turret, disc x10..37, barrel 7 thick, reaching 29.5.
    rr(ctx, 2, -3.5, 27.5, 7, 2.6); fillLine(ctx, p.trim, L, 1.8);
    rr(ctx, 23, -5, 6.5, 10, 2.4); fillLine(ctx, p.trimLit, L, 1.8);
    ctx.beginPath(); ctx.arc(0, 0, 13.5, 0, Math.PI * 2);
    fillLine(ctx, p.trim, L, 2.2);
    ctx.beginPath(); ctx.arc(0, 0, 8.5, 0, Math.PI * 2);
    fillLine(ctx, p.trimLit, null);
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

    // Tracks: 10 thick, the full body width, one each side of the hull.
    for (var s = -1; s <= 1; s += 2) {
      var by = s * (BODY_H / 2 - TREAD / 2);
      rr(ctx, -BODY_W / 2, by - TREAD / 2, BODY_W, TREAD, 3);
      fillLine(ctx, p.tread, p.line, 2.2);
      /* The links, scrolling with distance travelled. Their sprite alternates
         between two frames; a continuous offset is the same idea without the
         two-frame stutter, and it is what makes a tank crossing open ground
         read as driving rather than sliding. */
      ctx.save();
      rr(ctx, -BODY_W / 2, by - TREAD / 2, BODY_W, TREAD, 3);
      ctx.clip();
      ctx.fillStyle = p.link;
      var step = 5, off = ((o.roll || 0) % step + step) % step;
      for (var lx = -BODY_W / 2 - step + off; lx < BODY_W / 2; lx += step) {
        ctx.fillRect(lx, by - TREAD / 2 + 1, 2.2, TREAD - 2);
      }
      ctx.restore();
    }

    // Hull: 34 x 22, sitting between the tracks.
    rr(ctx, -HULL_W / 2, -HULL_H / 2, HULL_W, HULL_H, 5);
    fillLine(ctx, p.hull, p.line, 2.4);
    /* A lit strip at the front and a shadow at the back. The hull points where
       the tank is DRIVING, which is not where it is shooting, and a hull with
       no front cannot say that. */
    ctx.save();
    rr(ctx, -HULL_W / 2, -HULL_H / 2, HULL_W, HULL_H, 5);
    ctx.clip();
    ctx.fillStyle = p.hullLit;
    ctx.fillRect(HULL_W / 2 - 7, -HULL_H / 2, 7, HULL_H);
    ctx.fillStyle = p.hullDim;
    ctx.fillRect(-HULL_W / 2, -HULL_H / 2, 5, HULL_H);
    ctx.restore();
    ctx.restore();

    // Turret and gun, on their own heading.
    ctx.save();
    ctx.rotate(o.turret || 0);
    gun(ctx, o.weapon || 'cannon', p);
    ctx.restore();

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

  var GRASS = '#3a8145';

  function drawGrass(ctx, x, y, s, col, row) {
    ctx.fillStyle = GRASS;
    ctx.fillRect(x, y, s, s);
    /* Their grass tile is 58% one flat colour and the rest a scatter within two
       or three points of it, so this is noise at that amplitude and no more.
       Anything stronger turns a quiet field into carpet. */
    ctx.fillStyle = '#3c7d44';
    for (var i = 0; i < 6; i++) {
      var a = hash(col * 7 + i, row * 13 + i * 3), b = hash(col * 17 + i * 5, row * 3 + i);
      ctx.fillRect(x + a * s, y + b * s, s * 0.08, s * 0.08);
    }
    var p = hash(col, row);
    if (p > 0.88) {
      ctx.fillStyle = p > 0.95 ? '#e6d3a6' : '#c9855c';
      var px = x + hash(col + 1, row) * s * 0.7 + s * 0.15;
      var py = y + hash(col, row + 1) * s * 0.7 + s * 0.15;
      ctx.beginPath(); ctx.ellipse(px, py, s * 0.05, s * 0.033, p * 6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /* Stone, from wall_0: a 6/54 rim of #7a6457, a #a29184 face, a #c3ae9f
     highlight at the top right and a #5b4a41 shadow band along the bottom. */
  function drawStone(ctx, x, y, s, col, row) {
    var u = s / 54;
    ctx.fillStyle = '#7a6457'; ctx.fillRect(x, y, s, s);
    ctx.fillStyle = '#a29184'; ctx.fillRect(x + 6 * u, y + 6 * u, s - 12 * u, s - 12 * u);
    ctx.fillStyle = '#c3ae9f';
    ctx.fillRect(x + s - 14 * u, y + 6 * u, 8 * u, 10 * u);
    ctx.fillStyle = '#5b4a41'; ctx.fillRect(x, y + s - 6 * u, s, 6 * u);
    ctx.fillStyle = '#443730'; ctx.fillRect(x, y + s - 6 * u, 6 * u, 6 * u);
    // Two chips, the same every time you come back to the same cell.
    ctx.fillStyle = '#8c7669';
    var a = hash(col || 0, row || 0), b = hash((col || 0) + 5, (row || 0) + 9);
    ctx.fillRect(x + (8 + a * 30) * u, y + (10 + b * 28) * u, 7 * u, 6 * u);
    ctx.fillStyle = '#b5a293';
    ctx.fillRect(x + (10 + b * 28) * u, y + (12 + a * 26) * u, 5 * u, 4 * u);
    ctx.strokeStyle = '#000000'; ctx.lineWidth = Math.max(1, 1.6 * u);
    ctx.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1);
  }

  /* Brick, from bricks_0: a red mosaic, #e2523c with #d76738 and #e76941 tonal
     blocks and #733720 mortar. Destructible, so it is warmer and more broken up
     than the stone that is not. */
  function drawBrick(ctx, x, y, s, col, row) {
    var u = s / 54, tones = ['#e2523c', '#d76738', '#e76941', '#a83d2c', '#ad5330'];
    ctx.fillStyle = '#e2523c'; ctx.fillRect(x, y, s, s);
    var bh = s / 4;
    for (var r = 0; r < 4; r++) {
      var off = (r % 2) ? 0 : bh;
      for (var c = -1; c < 4; c++) {
        var bx = x + c * (bh * 2) + off, bw = bh * 2;
        if (bx + bw < x || bx > x + s) continue;
        ctx.fillStyle = tones[Math.floor(hash((col || 0) * 4 + c, (row || 0) * 4 + r) * tones.length)];
        var x0 = Math.max(x, bx + 1.5 * u), x1 = Math.min(x + s, bx + bw - 1.5 * u);
        if (x1 > x0) ctx.fillRect(x0, y + r * bh + 1.5 * u, x1 - x0, bh - 3 * u);
      }
    }
    ctx.strokeStyle = '#733720'; ctx.lineWidth = Math.max(1, 1.6 * u);
    ctx.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1);
  }

  /* Crate, from crate.png: 35 of 54, so it sits inside its tile with grass all
     round it. Face #ff892a, a #76531f strap, a #3e210a band low down. */
  function drawCrate(ctx, x, y, s, hp) {
    var i = s * 0.176, w = s - i * 2, u = s / 54;       // 35/54 leaves 9.5 each side
    rr(ctx, x + i, y + i, w, w, 3 * u);
    fillLine(ctx, '#ff892a', '#000000', Math.max(1, 2.2 * u));
    ctx.save();
    rr(ctx, x + i, y + i, w, w, 3 * u); ctx.clip();
    ctx.fillStyle = '#efa840'; ctx.fillRect(x + i + w * 0.10, y + i, w * 0.10, w);
    ctx.fillStyle = '#76531f'; ctx.fillRect(x + i + w * 0.22, y + i, w * 0.07, w);
    ctx.fillStyle = '#3e210a'; ctx.fillRect(x + i, y + i + w * 0.66, w, w * 0.11);
    ctx.fillStyle = '#7e4414'; ctx.fillRect(x + i, y + i + w * 0.88, w, w * 0.12);
    ctx.restore();
    /* Their crates have no bar; ours do, because Owen asked to see one and a
       crate you have already hit twice is worth knowing about. */
    if (hp !== undefined && hp < 1) {
      var bw = w * 0.9, bh = Math.max(2, s * 0.06);
      var bx = x + i + (w - bw) / 2, by = y + i - bh - 2 * u;
      ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(bx - 1, by - 1, bw + 2, bh + 2);
      ctx.fillStyle = '#ffb500'; ctx.fillRect(bx, by, bw * Math.max(0, hp), bh);
    }
  }

  /* Barrel, from barrel.png: a 35 circle, rim #ff4c11, body #ba2d0b, lit on the
     left at #f35b22 and shadowed on the right at #801f07. */
  function drawBarrel(ctx, x, y, s) {
    var cx = x + s / 2, cy = y + s / 2, r = s * 0.324;   // 35/54 diameter
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    fillLine(ctx, '#ff4c11', '#000000', Math.max(1, s * 0.04));
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.72, 0, Math.PI * 2);
    ctx.fillStyle = '#ba2d0b'; ctx.fill();
    ctx.beginPath(); ctx.arc(cx - r * 0.28, cy, r * 0.34, 0, Math.PI * 2);
    ctx.fillStyle = '#f35b22'; ctx.fill();
    ctx.beginPath(); ctx.arc(cx + r * 0.34, cy - r * 0.1, r * 0.22, 0, Math.PI * 2);
    ctx.fillStyle = '#801f07'; ctx.fill();
  }

  /* Wood, from wood.png: the same family as the crate but a full tile, so it
     reads as a wall you can break rather than a box you can break. */
  function drawWood(ctx, x, y, s, col, row) {
    var u = s / 54;
    ctx.fillStyle = '#cf6920'; ctx.fillRect(x, y, s, s);
    ctx.fillStyle = '#db772f';
    for (var k = 0; k < 4; k++) ctx.fillRect(x, y + k * s / 4 + 2 * u, s, s / 4 - 5 * u);
    ctx.fillStyle = '#2c2316';
    for (var k2 = 1; k2 < 4; k2++) ctx.fillRect(x, y + k2 * s / 4 - 1.5 * u, s, 3 * u);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(x + (hash(col || 0, row || 0) * 0.6 + 0.2) * s, y, 3 * u, s);
    ctx.strokeStyle = '#000000'; ctx.lineWidth = Math.max(1, 2 * u);
    ctx.strokeRect(x + 1, y + 1, s - 2, s - 2);
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
