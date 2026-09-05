'use strict';
/* ─── OMG Shooter — the art ───────────────────────────────────────────────────
   Every sprite in this game is drawn here, in code. Nothing is an image file
   and nothing was taken from anywhere: what WAS taken from Awesome Tanks 2 is
   the shape of the thing — a chunky top-down tank about three quarters of a
   block across, treads down both sides, a square turret that aims separately
   from the hull, thick dark outlines on everything, on flat green grass with
   grey stone and wooden crates. That is game art direction, not their artwork.

   THE NUMBERS ARE MEASURED, NOT GUESSED. Their level was screenshotted at 7x
   with the canvas magnified, and everything below is in the units that came off
   that image:

     block            86 px
     tank footprint   66 x 69 px      (0.77 of a block)
     hull             53 x 54 px      rounded, centred
     tread band       7.5 px thick, the full 66 along the direction of travel
     turret           33 x 35 px
     barrel           about 14 px past the hull

   So the drawing space here is "reference pixels", where a tank is 66 across.
   Callers give a world size and this scales to it, which means the proportions
   survive every zoom level and none of these numbers ever has to be re-guessed.

   WHY A SEPARATE FILE. The renderer needs it, and so does the lobby's weapon
   picker — you should be able to see the gun on the tank before you choose it,
   not read its name. Two callers, one definition, no chance of the picker
   showing something the game does not draw. */

(function (root) {

  var TANK = 66;                 // reference pixels across a whole tank
  var HULL_W = 53, HULL_H = 54;
  var TREAD = 7.5;
  var TUR_W = 33, TUR_H = 35;

  /* Our colours, not theirs. The construction is the borrowed part; green for
     you and hot orange for everyone else is the lobby's own language for "mine"
     and "not mine", and it is what the minimap dots have to agree with. */
  var TEAMS = {
    you: {
      base:  '#5ea832', lit: '#7fce4a', dark: '#3d7420',
      line:  '#1b3d12', tread: '#182a10', link: '#2f4a1c',
      glass: '#cfe8a8',
    },
    them: {
      base:  '#e0821f', lit: '#f6a63c', dark: '#b45f14',
      line:  '#5d2110', tread: '#2b1209', link: '#4a2113',
      glass: '#f7d9a8',
    },
    gun:   { metal: '#8d8f93', lit: '#c3c6cb', dark: '#4d5054', line: '#22262b' },
  };

  /* The ten, in the order the picker offers them: cheap and fast first, slow
     and enormous last. Each one draws a different barrel, because a weapon you
     cannot see on your own tank is a weapon you have to remember you picked. */
  var WEAPONS = [
    { key: 'minigun',      name: 'Minigun',      blurb: 'Six barrels, no pause, and not much per shot.' },
    { key: 'shotgun',      name: 'Shotgun',      blurb: 'A wall of pellets. Devastating up close, useless down a corridor.' },
    { key: 'ricochet',     name: 'Ricochet',     blurb: 'Bounces off stone. Shoot the wall, not the tank.' },
    { key: 'flamethrower', name: 'Flamethrower', blurb: 'Short range, constant damage, and it lights up the room.' },
    { key: 'cannon',       name: 'Cannon',       blurb: 'One heavy shell. Slow, and it hurts.' },
    { key: 'shock',        name: 'Shock',        blurb: 'Jumps between anything close. No aiming required.' },
    { key: 'rockets',      name: 'Rockets',      blurb: 'Splash damage, so near enough is good enough.' },
    { key: 'laser',        name: 'Laser',        blurb: 'Instant, down a line, straight through crates.' },
    { key: 'railgun',      name: 'Railgun',      blurb: 'Punches the length of the arena. Long wait between shots.' },
    { key: 'mines',        name: 'Mines',        blurb: 'Leave them behind you and drive away.' },
  ];

  /* ── helpers ───────────────────────────────────────────────────────────── */

  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }
  function fillLine(ctx, fill, line, w) {
    ctx.fillStyle = fill; ctx.fill();
    if (line) { ctx.strokeStyle = line; ctx.lineWidth = w || 3; ctx.stroke(); }
  }

  /* ── the barrels ────────────────────────────────────────────────────────
     Drawn from the turret's centre out along +x, so the caller only has to
     rotate once. Each is a silhouette first and a detail second: at the size
     these are actually played at, the outline is the whole readable part. */

  function barrel(ctx, key) {
    var g = TEAMS.gun;
    ctx.lineJoin = 'round';
    ctx.lineWidth = 2.6;

    if (key === 'minigun') {
      // A drum, then a cluster of thin tubes with a plate across their noses.
      rr(ctx, 6, -10, 14, 20, 4); fillLine(ctx, g.dark, g.line);
      for (var i = -1; i <= 1; i++) {
        rr(ctx, 16, i * 6 - 2.2, 30, 4.4, 2);
        fillLine(ctx, i === 0 ? g.lit : g.metal, g.line, 2);
      }
      rr(ctx, 44, -9.5, 5, 19, 2); fillLine(ctx, g.lit, g.line, 2);
      return;
    }
    if (key === 'shotgun') {
      rr(ctx, 8, -6, 26, 12, 4); fillLine(ctx, g.metal, g.line);
      // The flare is the whole tell: wide muzzle, wide spread.
      ctx.beginPath();
      ctx.moveTo(32, -6); ctx.lineTo(46, -13); ctx.lineTo(46, 13); ctx.lineTo(32, 6);
      ctx.closePath();
      fillLine(ctx, g.lit, g.line);
      return;
    }
    if (key === 'ricochet') {
      rr(ctx, 8, -4.5, 34, 9, 4); fillLine(ctx, g.metal, g.line);
      rr(ctx, 34, -8.5, 8, 17, 3); fillLine(ctx, g.lit, g.line);
      return;
    }
    if (key === 'flamethrower') {
      // Fuel bottle behind, short nozzle in front. It should look like a risk.
      rr(ctx, 2, -10, 14, 20, 6); fillLine(ctx, '#b8402a', g.line);
      rr(ctx, 15, -4, 20, 8, 3); fillLine(ctx, g.dark, g.line);
      ctx.beginPath();
      ctx.moveTo(34, -4); ctx.lineTo(45, -9.5); ctx.lineTo(45, 9.5); ctx.lineTo(34, 4);
      ctx.closePath();
      fillLine(ctx, '#e0a038', g.line);
      return;
    }
    if (key === 'shock') {
      rr(ctx, 6, -7, 16, 14, 5); fillLine(ctx, g.dark, g.line);
      // Two prongs and an arc between them.
      rr(ctx, 20, -9.5, 22, 4.4, 2); fillLine(ctx, g.metal, g.line, 2);
      rr(ctx, 20, 5.1, 22, 4.4, 2); fillLine(ctx, g.metal, g.line, 2);
      ctx.beginPath(); ctx.arc(42, 0, 7, -Math.PI / 2, Math.PI / 2);
      ctx.strokeStyle = '#8fd6ff'; ctx.lineWidth = 3; ctx.stroke();
      return;
    }
    if (key === 'rockets') {
      rr(ctx, 6, -11.5, 34, 23, 5); fillLine(ctx, g.dark, g.line);
      for (var t = -1; t <= 1; t += 2) {
        ctx.beginPath(); ctx.arc(36, t * 5.8, 4.4, 0, Math.PI * 2);
        fillLine(ctx, '#c0392b', g.line, 2);
      }
      return;
    }
    if (key === 'laser') {
      rr(ctx, 8, -4, 32, 8, 3); fillLine(ctx, g.metal, g.line);
      ctx.beginPath(); ctx.arc(42, 0, 7.5, 0, Math.PI * 2);
      fillLine(ctx, '#ff5b5b', g.line);
      ctx.beginPath(); ctx.arc(42, 0, 2.8, 0, Math.PI * 2);
      ctx.fillStyle = '#ffe3e3'; ctx.fill();
      return;
    }
    if (key === 'railgun') {
      // The longest thing on the board, and it should look like it.
      rr(ctx, 4, -8, 14, 16, 4); fillLine(ctx, g.dark, g.line);
      rr(ctx, 16, -6.5, 40, 4, 2); fillLine(ctx, g.metal, g.line, 2);
      rr(ctx, 16, 2.5, 40, 4, 2); fillLine(ctx, g.metal, g.line, 2);
      rr(ctx, 50, -9.5, 5.5, 19, 2); fillLine(ctx, '#6fd0ff', g.line, 2);
      return;
    }
    if (key === 'mines') {
      rr(ctx, 6, -10, 26, 20, 6); fillLine(ctx, g.dark, g.line);
      ctx.beginPath(); ctx.arc(19, 0, 7, 0, Math.PI * 2);
      fillLine(ctx, '#e0a020', g.line, 2);
      ctx.beginPath(); ctx.arc(19, 0, 2.8, 0, Math.PI * 2);
      ctx.fillStyle = g.line; ctx.fill();
      return;
    }
    // cannon, and anything unrecognised: one thick barrel with a muzzle band.
    rr(ctx, 8, -6, 36, 12, 4); fillLine(ctx, g.metal, g.line);
    rr(ctx, 39, -9, 7.5, 18, 3); fillLine(ctx, g.lit, g.line);
  }

  /* ── the tank ───────────────────────────────────────────────────────────
     Hull and turret point in different directions, which is the whole feel of
     the genre: you drive one way and shoot another. */

  function drawTank(ctx, o) {
    var p = TEAMS[o.team === 'you' ? 'you' : 'them'];
    var size = o.size || TANK;
    var k = size / TANK;

    ctx.save();
    ctx.translate(o.x, o.y);
    ctx.scale(k, k);
    ctx.lineJoin = 'round';

    // ── hull, and the treads that run down both sides of it
    ctx.save();
    ctx.rotate(o.hull || 0);

    for (var s = -1; s <= 1; s += 2) {
      var by = s * (HULL_H / 2 + TREAD / 2);
      rr(ctx, -TANK / 2, by - TREAD / 2 - 1.5, TANK, TREAD + 3, 3.5);
      fillLine(ctx, p.tread, p.line, 3);
      /* The links. Twelve of them, which is what the reference has and is also
         about the fewest that still reads as a track rather than a bar. */
      ctx.fillStyle = p.link;
      for (var i = 0; i < 12; i++) {
        var lx = -TANK / 2 + 3 + i * ((TANK - 6) / 12);
        ctx.fillRect(lx, by - TREAD / 2 + 0.5, 2.6, TREAD - 1);
      }
    }

    rr(ctx, -HULL_W / 2, -HULL_H / 2, HULL_W, HULL_H, 9);
    fillLine(ctx, p.base, p.line, 3.4);
    /* One lit band across the front and a shadow across the back. The hull
       has to have a direction of its own -- it points where you are DRIVING,
       which on a tank is not where you are shooting -- and a symmetrical hull
       cannot say that. */
    ctx.save();
    rr(ctx, -HULL_W / 2, -HULL_H / 2, HULL_W, HULL_H, 9);
    ctx.clip();
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = p.lit;
    ctx.fillRect(HULL_W / 2 - 15, -HULL_H / 2, 15, HULL_H);
    ctx.globalAlpha = 1;
    ctx.fillStyle = p.dark;
    ctx.fillRect(-HULL_W / 2, -HULL_H / 2, 7, HULL_H);
    ctx.restore();
    // Rivets. Four of them, at the corners of the plate.
    ctx.fillStyle = p.dark;
    for (var rx = -1; rx <= 1; rx += 2) {
      for (var ry = -1; ry <= 1; ry += 2) {
        ctx.beginPath();
        ctx.arc(rx * (HULL_W / 2 - 5), ry * (HULL_H / 2 - 5), 1.9, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();

    // ── turret, and whatever is bolted to the front of it
    ctx.save();
    ctx.rotate(o.turret || 0);
    barrel(ctx, o.weapon || 'cannon');
    rr(ctx, -TUR_W / 2, -TUR_H / 2, TUR_W, TUR_H, 8);
    fillLine(ctx, p.lit, p.line, 3.4);
    // The hatch, set back from the gun, which is what makes the turret read
    // as the top of something rather than a second hull.
    rr(ctx, -TUR_W / 2 + 4.5, -5.5, 12, 11, 3.5);
    ctx.fillStyle = p.dark; ctx.fill();
    ctx.restore();

    ctx.restore();

    if (o.hp !== undefined && o.max && o.hp < o.max) drawHealth(ctx, o, size);
  }

  /* Above the tank, in world space, and only when it is hurt. A bar over every
     tank all the time is a row of bars; a bar over a hurt one is information. */
  function drawHealth(ctx, o, size) {
    var w = size * 0.92, h = Math.max(2.5, size * 0.075);
    var x = o.x - w / 2, y = o.y - size * 0.62;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    rr(ctx, x - 1.5, y - 1.5, w + 3, h + 3, (h + 3) / 2); ctx.fill();
    ctx.fillStyle = o.team === 'you' ? '#7fce4a' : '#f0603c';
    rr(ctx, x, y, Math.max(1, w * (o.hp / o.max)), h, h / 2); ctx.fill();
  }

  /* ── the ground ─────────────────────────────────────────────────────────
     Flat green with a fine mottle and the odd pebble, which is what stops a
     large empty arena reading as a blank fill. Every speck is placed from the
     cell's own coordinates, so the ground does not crawl as the camera moves. */

  var GRASS = '#3f8a44', GRASS_2 = '#3a8040', PEBBLE = ['#c9855c', '#e6d3a6', '#b06a45'];

  function hash(a, b) {
    var h = (a * 374761393 + b * 668265263) | 0;
    h = (h ^ (h >>> 13)) * 1274126177;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  function drawGrass(ctx, x, y, s, col, row) {
    ctx.fillStyle = GRASS;
    ctx.fillRect(x, y, s, s);
    ctx.fillStyle = GRASS_2;
    for (var i = 0; i < 5; i++) {
      var a = hash(col * 7 + i, row * 13 + i * 3), b = hash(col * 17 + i * 5, row * 3 + i);
      ctx.fillRect(x + a * s, y + b * s, s * 0.09, s * 0.09);
    }
    var p = hash(col, row);
    if (p > 0.86) {
      ctx.fillStyle = PEBBLE[Math.floor(hash(col + 3, row + 7) * PEBBLE.length)];
      var px = x + hash(col + 1, row) * s * 0.7 + s * 0.15;
      var py = y + hash(col, row + 1) * s * 0.7 + s * 0.15;
      ctx.beginPath(); ctx.ellipse(px, py, s * 0.055, s * 0.038, p * 6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /* Stone never breaks and has to look like it: a heavy dark outline, a bevel,
     and a couple of chips that are the same every time you come back. */
  function drawStone(ctx, x, y, s) {
    ctx.fillStyle = '#171512';
    ctx.fillRect(x, y, s, s);
    rr(ctx, x + s * 0.03, y + s * 0.03, s * 0.94, s * 0.94, s * 0.1);
    fillLine(ctx, '#b3aa9d', '#171512', Math.max(1, s * 0.05));
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    rr(ctx, x + s * 0.1, y + s * 0.1, s * 0.8, s * 0.16, s * 0.06); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    rr(ctx, x + s * 0.1, y + s * 0.72, s * 0.8, s * 0.18, s * 0.06); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.14)';
    ctx.fillRect(x + s * 0.3, y + s * 0.36, s * 0.16, s * 0.16);
  }

  /* Wood is the thing you shoot to get at what is behind it, so it is warm and
     obviously made of parts, against stone that is one solid mass. */
  function drawWood(ctx, x, y, s) {
    var i = s * 0.09;
    rr(ctx, x + i, y + i, s - i * 2, s - i * 2, s * 0.08);
    fillLine(ctx, '#c9782a', '#4a2409', Math.max(1, s * 0.055));
    ctx.fillStyle = '#a95f1c';
    for (var k = 1; k < 4; k++) ctx.fillRect(x + i + (s - i * 2) * k / 4 - s * 0.014, y + i, s * 0.028, s - i * 2);
    ctx.fillStyle = '#e0913c';
    ctx.fillRect(x + i, y + s * 0.24, s - i * 2, s * 0.09);
    ctx.fillRect(x + i, y + s * 0.66, s - i * 2, s * 0.09);
  }

  function drawBrick(ctx, x, y, s) {
    ctx.fillStyle = '#8e4433';
    ctx.fillRect(x, y, s, s);
    ctx.strokeStyle = '#c9b8a4'; ctx.lineWidth = Math.max(1, s * 0.035);
    for (var r = 0; r < 4; r++) {
      var yy = y + s * (r + 1) / 4;
      ctx.beginPath(); ctx.moveTo(x, yy); ctx.lineTo(x + s, yy); ctx.stroke();
      var off = (r % 2) ? 0 : s / 2;
      ctx.beginPath();
      ctx.moveTo(x + off, yy - s / 4); ctx.lineTo(x + off, yy);
      ctx.stroke();
    }
    ctx.strokeStyle = '#3a1a12'; ctx.lineWidth = Math.max(1, s * 0.055);
    ctx.strokeRect(x + s * 0.03, y + s * 0.03, s * 0.94, s * 0.94);
  }

  /* A barrel is a wall that fights back, so it is the one piece of scenery
     painted in warning colours. */
  function drawBarrel(ctx, x, y, s) {
    var cx = x + s / 2, cy = y + s / 2;
    ctx.beginPath(); ctx.arc(cx, cy, s * 0.36, 0, Math.PI * 2);
    fillLine(ctx, '#c0392b', '#3a1109', Math.max(1, s * 0.055));
    ctx.beginPath(); ctx.arc(cx, cy, s * 0.24, 0, Math.PI * 2);
    ctx.fillStyle = '#e2a33a'; ctx.fill();
    ctx.beginPath(); ctx.arc(cx, cy, s * 0.1, 0, Math.PI * 2);
    ctx.fillStyle = '#3a1109'; ctx.fill();
  }

  root.ShooterArt = {
    TANK: TANK, TEAMS: TEAMS, WEAPONS: WEAPONS,
    drawTank: drawTank, barrel: barrel, roundRect: rr,
    drawGrass: drawGrass, drawStone: drawStone, drawWood: drawWood,
    drawBrick: drawBrick, drawBarrel: drawBarrel,
  };

})(typeof window !== 'undefined' ? window : globalThis);
