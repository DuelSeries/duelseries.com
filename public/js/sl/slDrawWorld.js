// slDrawWorld: the world layer of the slither redo. It owns the frame order of redraw(), the
// background (black fill, glow layer, hex tile and its phase), the food and prey sprites, the
// food passes (shadow, core, glow), prey bodies and prey glow, and the map border. Snakes are
// drawn by slDrawSnake and the "Your length" box by slHud, called from the slots below.
//
// Spec: draw-world-hud.md section 2 (DWH), with the BUILD-BRIEF rulings
// (10.4 rows 1, 7, 9, 10). Every canvas call, its arguments and their order follow DWH 2.2 to 2.8.
// Float order matters for an exact call log: every formula keeps the spec's operator grouping.
// Mirrored state lives on S (DuelSlither.S) under their global names.
//
// Exports: init, buildFoodSprites, updateTilePhase, buildTilePattern, rebuildGbg, redraw.
// Owns in S: bgi2, bgp2, bgee, bgees, bg_hex, ggbg, gbgmc, gbgi.
(function (root) {
  'use strict';
  var D = root.DuelSlither = root.DuelSlither || {};

  var PI2 = 2 * Math.PI;              // their pi2 (game.js:125)

  // Our glow image stands in for their gbg.jpg (BUILD-BRIEF 10.7, D4): a black canvas turned into
  // an image. Its size is their file's natural size, 600 x 550 (capture/s/gbg.jpg header), so the
  // logged <img WxH> argument of the rebuild drawImage matches (H6 keeps sizes). Only the
  // 512 x 512 source corner is ever drawn (game.js:1710).
  var GLOW_W = 600;
  var GLOW_H = 550;

  var bound = null;                   // the S given to init
  function st() { return bound || D.S; }
  function doc() { return root.document; }

  // ---------------------------------------------------------------- load time (BUILD-BRIEF 10.5 step 5)

  // Creates the tile canvas and both images, the way their page does at load (game.js:1673-1721).
  // Nothing is drawn on the game canvas here.
  function init(S, assetBase) {
    bound = S;
    var base = assetBase == null ? '/' : assetBase;
    var d = doc();

    S.bgi2 = d.createElement('canvas');   // 599 x 519 pattern source, sized when the tile loads
    S.bgp2 = null;
    S.bgee = null;
    S.bgees = [];                         // never filled (game.js:1676), kept for the state shape
    S.bg_hex = null;

    var tile = d.createElement('img');
    tile.onload = function () {           // game.js:1688-1695
      var s = st();
      s.bgi2.width = s.bgw2;
      s.bgi2.height = s.bgh2;
      s.bgi2.getContext('2d');
      s.bg_hex = this;
    };
    tile.src = base + 'hexbg.jpg';        // same bytes as their bg54.jpg (md5 aea43d90...)

    S.ggbg = false;
    S.gbgmc = null;
    S.gbgi = d.createElement('img');
    S.gbgi.onload = function () {         // game.js:1717-1720
      st().ggbg = true;
      rebuildGbg();
    };
    S.gbgi.src = glowImageSource(d);
  }

  function glowImageSource(d) {
    var c = d.createElement('canvas');
    c.width = GLOW_W;
    c.height = GLOW_H;
    var g = c.getContext('2d');
    g.fillStyle = '#000000';
    g.fillRect(0, 0, GLOW_W, GLOW_H);
    return c.toDataURL();
  }

  // ---------------------------------------------------------------- food and prey sprites (DWH 2.4)

  // Called by slSprites once per colour i = 0..9, right after that colour's entry `o` was pushed
  // (game.js:3788-3904). rr, gg, bb are the colour's table values. Fills o's food lists, then
  // o.ic and the prey lists.
  function buildFoodSprites(o, i, rr, gg, bb) {
    var d = doc();
    // colour 9 cores are grey; its glows stay white (game.js:3800-3804)
    var cr = rr, cg = gg, cb = bb;
    if (i == 9) { cr = 160; cg = 160; cb = 160; }
    var coreRgb = 'rgba(' + cr + ', ' + cg + ', ' + cb + ', ';
    var glowRgb = 'rgba(' + rr + ', ' + gg + ', ' + bb + ', ';

    var step, cv, c, g, side;
    // 17 sizes; step goes up by += 1 from 2.8 (game.js:3789), never rebuilt as 2.8 + k
    for (step = 2.8; step <= 18.8; step += 1) {
      // core: radial gradient, solid to .99, then a thin .2 rim (game.js:3790-3820)
      cv = d.createElement('canvas');
      side = Math.ceil(2 * (step * .65));          // their + 0 * 6 adds exactly 0
      c = squareOf(cv, side);
      g = c.createRadialGradient(side / 2, side / 2, 0, side / 2, side / 2, side / 2);
      g.addColorStop(0, coreRgb + '1)');
      g.addColorStop(.99, coreRgb + .2 + ')');
      g.addColorStop(1, coreRgb + '0)');
      c.fillStyle = g;
      c.fillRect(0, 0, side, side);
      addSprite(o, '', cv, side);

      // glow: wide soft gradient of the full colour (game.js:3821-3840)
      side = Math.ceil(step * 8 + 6);
      cv = d.createElement('canvas');
      c = squareOf(cv, side);
      g = c.createRadialGradient(side / 2, side / 2, 1, side / 2, side / 2, step * 4);
      g.addColorStop(0, glowRgb + '1)');
      g.addColorStop(1, glowRgb + '0)');
      c.fillStyle = g;
      c.fillRect(0, 0, side, side);
      addSprite(o, 'g', cv, side);

      // shadow: a 600-segment black disc with a blurred, downward shadow (game.js:3841-3868)
      cv = d.createElement('canvas');
      var disc = Math.ceil(2 * (step * .7)) + 2;  // their + 0 * 6 adds exactly 0
      side = disc + 20;
      c = squareOf(cv, side);
      c.shadowBlur = 6;
      c.shadowOffsetY = 1 + 2 * step / 18.8;
      c.shadowColor = '#000000';
      c.globalAlpha = 1;
      c.beginPath();
      for (var seg = 0; seg <= 600; seg++) {
        var px = side / 2 + Math.cos(2 * Math.PI * seg / 600) * disc / 2;
        var py = side / 2 + Math.sin(2 * Math.PI * seg / 600) * disc / 2;
        if (seg == 0) c.moveTo(px, py);
        else c.lineTo(px, py);
      }
      c.fill();                           // default fillStyle (black)
      addSprite(o, 'o', cv, side);
    }

    o.ic = o.imgs.length;                 // 17
    o.pr_imgs = [];
    o.pr_fws = [];
    o.pr_fhs = [];
    o.pr_fw2s = [];
    o.pr_fh2s = [];
    var hex = '#' + hex2(rr) + hex2(gg) + hex2(bb);
    // 22 prey sizes: a dot with a wide coloured shadow, filled twice (game.js:3870-3903)
    for (step = 3; step <= 24; step += 1) {
      cv = d.createElement('canvas');
      side = Math.ceil(step * 2 + 38);
      c = squareOf(cv, side);
      c.fillStyle = o.cs;
      c.arc(side / 2, side / 2, step / 2, 0, PI2);   // no beginPath: the canvas is fresh
      c.shadowBlur = 22;
      c.shadowOffsetY = 0;
      c.shadowColor = hex;
      c.fill();
      c.fill();
      addSprite(o, 'pr_', cv, side);
    }
  }

  // Sizes a fresh canvas to side x side (their chained form: height is written first) and returns its context.
  function squareOf(cv, side) {
    cv.width = cv.height = side;
    return cv.getContext('2d');
  }

  // Appends one sprite and its sizes to a colour set's lists <prefix>imgs, fws, fhs, fw2s, fh2s.
  function addSprite(o, prefix, cv, side) {
    o[prefix + 'imgs'].push(cv);
    o[prefix + 'fws'].push(side);
    o[prefix + 'fhs'].push(side);
    o[prefix + 'fw2s'].push(side / 2);
    o[prefix + 'fh2s'].push(side / 2);
  }

  function hex2(v) {
    var s = '00' + v.toString(16);
    return s.substr(s.length - 2);
  }

  // ---------------------------------------------------------------- background (DWH 2.3)

  // Tile phase from a view move (game.js:5211-5216, the same rule at 7885-7890). Called by redraw
  // and by slApply's own move packet; NOT on the spawn jump and not by resetGame (DWH 2.10 item 1).
  function updateTilePhase(oldX, oldY) {
    var S = st();
    // the tile moves against the view, in tile widths, kept in 0..1 (their * 1 changes no number)
    S.bgx2 = wrapUnit(S.bgx2 - (S.view_xx - oldX) / S.bgw2);
    S.bgy2 = wrapUnit(S.bgy2 - (S.view_yy - oldY) / S.bgh2);
  }

  function wrapUnit(v) {
    v %= 1;
    return v < 0 ? v + 1 : v;
  }

  // The repeat pattern, rebuilt at every game start by slHud.startShowGame (game.js:2112-2122).
  // Resizing bgi2 clears it. With no tile loaded yet the drawImage throws (the call is still made,
  // as theirs) and bgp2 keeps its old value. Team mode (bg_usa) is not built.
  function buildTilePattern() {
    var S = st();
    S.bgi2.width = S.bgw2;
    S.bgi2.height = S.bgh2;
    var c = S.bgi2.getContext('2d');
    try {
      c.drawImage(S.bg_hex, 0, 0);
      S.bgp2 = c.createPattern(S.bgi2, 'repeat');
    } catch (e) { /* tile not loaded: keep bgp2 */ }
  }

  // Their rdgbg (game.js:1703-1712): the glow image stretched to the canvas size. Runs when the
  // image loads and from slPage.resize when the backing size changes.
  function rebuildGbg() {
    var S = st();
    if (!S.ggbg) return;
    if (!S.gbgmc) S.gbgmc = doc().createElement('canvas');
    S.gbgmc.width = S.mww;
    S.gbgmc.height = S.mhh;
    var c = S.gbgmc.getContext('2d');
    try {
      c.drawImage(S.gbgi, 0, 0, 512, 512, 0, 0, S.mww, S.mhh);
    } catch (e) { /* as theirs */ }
  }

  // Layer 4 then layer 5 (game.js:5217-5238). The low quality branch leaves fillStyle "#000000"
  // on the context with no save around it (DWH 2.10 item 2).
  function drawBackground(S, ctx) {
    if (S.ggbg && (S.high_quality || S.gla > 0)) {
      ctx.save();
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, S.mww, S.mhh);
      ctx.globalAlpha = .3;
      ctx.drawImage(S.gbgmc, 0, 0);
      ctx.restore();
    } else {
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, S.mww, S.mhh);
    }
    if (S.bgp2) {
      var z = S.gsc;
      ctx.save();
      ctx.fillStyle = S.bgp2;
      ctx.translate(S.mww2, S.mhh2);
      ctx.scale(z, z);
      ctx.translate(S.bgx2 * S.bgw2, S.bgy2 * S.bgh2);
      ctx.globalAlpha = 1;
      ctx.fillRect(-S.mww * 3 / z, -S.mhh * 3 / z, S.mww * 5 / z, S.mhh * 5 / z);
      ctx.restore();
    }
  }

  // ---------------------------------------------------------------- food (DWH 2.6)

  // One sprite blit: 3-argument form at rad 1, else the 9-argument scaled form (DWH 2.6).
  // Callers pass the top-left corner already moved by half size times rad; at rad 1 that product
  // is the half size itself, so the corner is the same number their rad == 1 branch computes.
  function blit(ctx, img, w, h, x, y, rad) {
    if (rad == 1) ctx.drawImage(img, x, y);
    else ctx.drawImage(img, 0, 0, w, h, x, y, w * rad, h * rad);
  }

  function inFoodBox(S, fo) {           // world box on the drawn position (game.js:5243)
    return fo.rx >= S.fpx1 && fo.ry >= S.fpy1 && fo.rx <= S.fpx2 && fo.ry <= S.fpy2;
  }

  function pulseOf(gfr) {               // the shared shimmer (game.js:5272)
    return .5 + .5 * Math.cos(gfr / 13);
  }

  // Pass A, shadows, source-over (game.js:5239-5257).
  function foodShadows(S, ctx) {
    var a = .8;
    ctx.save();
    for (var i = S.foods_c - 1; i >= 0; i--) {
      var fo = S.foods[i];
      if (!inFoodBox(S, fo)) continue;
      var x = S.mww2 + S.gsc * (fo.rx - S.view_xx) - fo.ofw2 * fo.rad;
      var y = S.mhh2 + S.gsc * (fo.ry - S.view_yy) - fo.ofh2 * fo.rad;
      ctx.globalAlpha = a * fo.fr;
      blit(ctx, fo.ofi, fo.ofw, fo.ofh, x, y, fo.rad);
    }
    ctx.restore();
  }

  // Pass B, cores, additive (game.js:5258-5300). High quality draws each core twice, the second
  // time scaled by the shimmer; low quality once.
  function foodCores(S, ctx) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    var two = S.high_quality || S.gla > 0;
    var a = 1;
    if (two && S.gla != 1) a = 1 * S.gla;
    var a2 = 1;
    for (var i = S.foods_c - 1; i >= 0; i--) {
      var fo = S.foods[i];
      if (!inFoodBox(S, fo)) continue;
      var x = S.mww2 + S.gsc * (fo.rx - S.view_xx) - fo.fw2 * fo.rad;
      var y = S.mhh2 + S.gsc * (fo.ry - S.view_yy) - fo.fh2 * fo.rad;
      if (two) {
        ctx.globalAlpha = a2 * fo.fr;
        blit(ctx, fo.fi, fo.fw, fo.fh, x, y, fo.rad);
        ctx.globalAlpha = a * pulseOf(fo.gfr) * fo.fr;
        blit(ctx, fo.fi, fo.fw, fo.fh, x, y, fo.rad);
      } else {
        ctx.globalAlpha = fo.fr;
        blit(ctx, fo.fi, fo.fw, fo.fh, x, y, fo.rad);
      }
    }
    ctx.restore();
  }

  // Pass C, two glows per food pushed out from the screen centre, additive, high quality or
  // fading only (game.js:6506-6566). No screen cull, only the world box.
  function foodGlows(S, ctx) {
    if (!(S.high_quality || S.gla > 0)) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (var i = S.foods_c - 1; i >= 0; i--) {
      var fo = S.foods[i];
      if (!inFoodBox(S, fo)) continue;
      var dx = fo.rx - S.view_xx;
      var dy = fo.ry - S.view_yy;
      var d2 = dx * dx + dy * dy;

      var push = 1 + .06 * fo.rad;
      var al = .005 + .09 * (1 - d2 / (86E3 + d2));
      glowPair(S, ctx, fo, dx, dy, push, al, fo.gfi, fo.gfw, fo.gfh, fo.gfw2, fo.gfh2);

      push = 1 + .32 * fo.rad;
      al = .085 * (1 - d2 / (16500 + d2));
      glowPair(S, ctx, fo, dx, dy, push, al, fo.g2fi, fo.g2fw, fo.g2fh, fo.g2fw2, fo.g2fh2);
    }
    ctx.restore();
  }

  function glowPair(S, ctx, fo, dx, dy, push, al, img, w, h, w2, h2) {
    var x = dx * push;
    var y = dy * push;
    if (fo.rad != 1) al *= Math.pow(fo.rad, .25);
    if (S.gla != 1) al *= S.gla;
    x = x * S.gsc + S.mww2;
    y = y * S.gsc + S.mhh2;
    x -= w2 * fo.rad;
    y -= h2 * fo.rad;
    ctx.globalAlpha = al * fo.fr;
    blit(ctx, img, w, h, x, y, fo.rad);
    ctx.globalAlpha = al * pulseOf(fo.gfr) * fo.fr;
    blit(ctx, img, w, h, x, y, fo.rad);
  }

  // ---------------------------------------------------------------- prey (DWH 2.7)

  // World position of a prey, pulled toward its eater's mouth while eaten. Prey use
  // Math.pow(eaten_fr, 2) here (food uses a plain product, DWH 2.10 item 7). game.js:5310-5316.
  function mouthPull(pr, pos) {
    var o = pr.eaten_by;
    var k = Math.pow(pr.eaten_fr, 2);
    pos.x += (o.xx + o.fx + Math.cos(o.ang + o.fa) * (43 - k * 24) * (1 - k) - pos.x) * k;
    pos.y += (o.yy + o.fy + Math.sin(o.ang + o.fa) * (43 - k * 24) * (1 - k) - pos.y) * k;
  }

  // Prey bodies, additive, any quality (game.js:5301-5336). The screen cull is on the uneaten
  // position (DWH 2.10 item 5). Alphas above 1 are written as they are (DWH 2.10 item 6).
  function preyBodies(S, ctx) {
    var pos = { x: 0, y: 0 };
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (var i = S.preys.length - 1; i >= 0; i--) {
      var pr = S.preys[i];
      pos.x = pr.xx + pr.fx;
      pos.y = pr.yy + pr.fy;
      var sx = S.mww2 + S.gsc * (pos.x - S.view_xx);
      var sy = S.mhh2 + S.gsc * (pos.y - S.view_yy);
      if (!(sx >= -50 && sy >= -50 && sx <= S.mwwp50 && sy <= S.mhhp50)) continue;
      if (pr.eaten) {
        mouthPull(pr, pos);
        sx = S.mww2 + S.gsc * (pos.x - S.view_xx);
        sy = S.mhh2 + S.gsc * (pos.y - S.view_yy);
      }
      var x = sx - pr.fw2 * pr.rad;
      var y = sy - pr.fh2 * pr.rad;
      ctx.globalAlpha = .75 * pr.fr;
      blit(ctx, pr.fi, pr.fw, pr.fh, x, y, pr.rad);
      ctx.globalAlpha = .75 * pulseOf(pr.gfr) * pr.fr;
      blit(ctx, pr.fi, pr.fw, pr.fh, x, y, pr.rad);
    }
    ctx.restore();
  }

  // Prey glow, additive, never gated by quality (game.js:6567-6625). Each glow is culled on its
  // centre before the half size comes off; the second glow always uses the scaled form at 2 * rad.
  function preyGlows(S, ctx) {
    var pos = { x: 0, y: 0 };
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (var i = S.preys.length - 1; i >= 0; i--) {
      var pr = S.preys[i];
      pos.x = pr.xx + pr.fx;
      pos.y = pr.yy + pr.fy;
      if (pr.eaten) mouthPull(pr, pos);
      var dx = pos.x - S.view_xx;
      var dy = pos.y - S.view_yy;
      var d2 = dx * dx + dy * dy;

      var push = 1 + .08 * pr.rad;
      var x = dx * push;
      var y = dy * push;
      var al = .4 * (1 - d2 / (176E3 + d2));
      if (pr.rad != 1) al *= Math.pow(pr.rad, .25);
      x = x * S.gsc + S.mww2;
      y = y * S.gsc + S.mhh2;
      if (onGlowScreen(S, x, y)) {
        x -= pr.gfw2 * pr.rad;
        y -= pr.gfh2 * pr.rad;
        ctx.globalAlpha = al * pr.fr;
        blit(ctx, pr.gfi, pr.gfw, pr.gfh, x, y, pr.rad);
        ctx.globalAlpha = al * pulseOf(pr.gfr) * pr.fr;
        blit(ctx, pr.gfi, pr.gfw, pr.gfh, x, y, pr.rad);
      }

      push = 1 + .32 * pr.rad;
      x = dx * push;
      y = dy * push;
      al = .35 * (1 - d2 / (46500 + d2));
      if (pr.rad != 1) al *= Math.pow(pr.rad, .25);
      var r2 = pr.rad * 2;
      x = x * S.gsc + S.mww2;
      y = y * S.gsc + S.mhh2;
      if (onGlowScreen(S, x, y)) {
        x -= pr.gfw2 * r2;
        y -= pr.gfh2 * r2;
        ctx.globalAlpha = al * pr.fr;
        ctx.drawImage(pr.gfi, 0, 0, pr.gfw, pr.gfh, x, y, pr.gfw * r2, pr.gfh * r2);
        ctx.globalAlpha = al * pulseOf(pr.gfr) * pr.fr;
        ctx.drawImage(pr.gfi, 0, 0, pr.gfw, pr.gfh, x, y, pr.gfw * r2, pr.gfh * r2);
      }
    }
    ctx.restore();
  }

  function onGlowScreen(S, x, y) {      // game.js:6591
    return x >= -150 && y >= -150 && x <= S.mwwp150 && y <= S.mhhp150;
  }

  // ---------------------------------------------------------------- border (DWH 2.8)

  // The red band past the playable circle, drawn when the view is within 4000 of it
  // (game.js:6626-6657). Pass 1 fills the band between radius flux_grd and flux_grd + 4000 over
  // a 4000-unit arc; pass 2 strokes the inner edge. Before packet a flux_grd is undefined, the
  // test is NaN < 4000 and nothing draws.
  function border(S, ctx) {
    if (!(Math.abs(S.flux_grd - S.view_dist) < 4E3)) return;
    var z = S.gsc;
    ctx.save();
    ctx.lineWidth = 23 * z;
    ctx.strokeStyle = '#800000';
    ctx.fillStyle = '#300000';
    ctx.globalAlpha = .8;
    for (var pass = 1; pass <= 2; pass++) {
      ctx.beginPath();
      var arcLen = S.flux_grd;
      if (4E3 / S.flux_grd > 2 * Math.PI) arcLen = 4E3 / (2 * Math.PI);
      var wx = S.grd + Math.cos(S.view_ang - 2E3 / arcLen) * S.flux_grd;
      var wy = S.grd + Math.sin(S.view_ang - 2E3 / arcLen) * S.flux_grd;
      ctx.moveTo(S.mww2 + (wx - S.view_xx) * z, S.mhh2 + (wy - S.view_yy) * z);
      var s;
      for (s = -2E3; s <= 2E3; s += 100) {
        wx = S.grd + Math.cos(S.view_ang + s / arcLen) * S.flux_grd;
        wy = S.grd + Math.sin(S.view_ang + s / arcLen) * S.flux_grd;
        ctx.lineTo(S.mww2 + (wx - S.view_xx) * z, S.mhh2 + (wy - S.view_yy) * z);
      }
      if (pass == 1) {
        for (s = 2E3; s >= -2E3; s -= 100) {
          wx = S.grd + Math.cos(S.view_ang + s / arcLen) * (S.flux_grd + 4E3);
          wy = S.grd + Math.sin(S.view_ang + s / arcLen) * (S.flux_grd + 4E3);
          ctx.lineTo(S.mww2 + (wx - S.view_xx) * z, S.mhh2 + (wy - S.view_yy) * z);
        }
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- the frame (DWH 2.2)

  // One frame, in their order (game.js:5152-6735). Called at the end of every oef and by
  // slPage.resize (also inside packet a, through startShowGame). The prologue (fps, animating,
  // zoom, camera, boxes) is slLoop's (BUILD-BRIEF 10.4 row 1); it returns null when not animating,
  // else the view taken before the camera step.
  function redraw() {
    var S = st();
    var lv = D.slLoop.redrawPrologue(S);
    if (!lv) return;
    var ctx = S.mc.getContext('2d');
    updateTilePhase(lv.lvx, lv.lvy);           // row 7
    drawBackground(S, ctx);                     // rows 8, 9
    foodShadows(S, ctx);                        // row 10
    foodCores(S, ctx);                          // row 11
    preyBodies(S, ctx);                         // row 12
    ctx.save();                                 // row 13, closed by row 23
    ctx.strokeStyle = '#90C098';
    var snakes = D.slDrawSnake;
    snakes.drawNames(S, ctx);                   // row 14
    snakes.updateVisibility(S);                 // row 15
    snakes.drawSnakes(S, ctx, D.rand);          // rows 16, 17
    // row 18, team-mode eyes (game.js:6496-6505): not built, team mode is OUT
    foodGlows(S, ctx);                          // row 19
    preyGlows(S, ctx);                          // row 20
    border(S, ctx);                             // row 21 (choosing_skin is menu, always false here)
    D.slHud.updateLengthBox(S);                 // row 22
    ctx.restore();                              // row 23
  }

  D.slDrawWorld = {
    init: init,
    buildFoodSprites: buildFoodSprites,
    updateTilePhase: updateTilePhase,
    buildTilePattern: buildTilePattern,
    rebuildGbg: rebuildGbg,
    redraw: redraw
  };
})(typeof window !== 'undefined' ? window : globalThis);
