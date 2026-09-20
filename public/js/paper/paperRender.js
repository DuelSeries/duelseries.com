(function (root) {
  'use strict';
  var P = root.DuelPaperLib = root.DuelPaperLib || {};

  // Canvas renderer for one gameplay frame: world passes, then the HUD.
  // Acceptance is a call-by-call diff of the 2D context, so the ORDER of every
  // state write and draw call in this file is load-bearing, including writes
  // that look redundant. Do not tidy them.

  var TWO_PI = Math.PI * 2;
  var NAME_INK = '#363331';
  var NAME_FILL = '#dddddd';
  var PLATE_SHADOW = '#00000022';
  var PLATE_OUTLINE = '#00000099';
  var DEG_TO_RAD = 0.0174533;

  function pixelRatio() {
    return root.devicePixelRatio;
  }

  // ---------------------------------------------------------------- small helpers

  // A fresh gradient is made on every call: the recorded call stream has exactly one
  // createLinearGradient per frame, so this must not be cached.
  function getBackgroundGradient(ctx, space, topColor, bottomColor) {
    var midX = space.width / 2;
    var gradient = ctx.createLinearGradient(midX, 0, space.width / 2, space.height);
    gradient.addColorStop(0, topColor);
    gradient.addColorStop(1, bottomColor);
    return gradient;
  }

  function fillPathWith(ctx, path, paint) {
    ctx.fillStyle = paint;
    ctx.fill(path);
  }

  function strokePath(ctx, path, color, width) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke(path);
  }

  // Width is written before the style here, the other way round from strokePath.
  function strokeTrack(ctx, style, track, unitPosition, width) {
    if (!track.polyline.segments.length) return;
    ctx.lineWidth = width;
    ctx.strokeStyle = style;
    ctx.stroke(track.polyline.path);
  }

  function basePaint(unit) {
    var skin = unit.skin;
    return (skin.pattern && skin.pattern.pattern) || skin.colors.main;
  }

  function fillRoundedRect(ctx, x, y, width, height, radii, strokeWidth) {
    var rTopLeft = radii[0];
    var rTopRight = radii[1];
    var rBottomRight = radii[2];
    var rBottomLeft = radii[3];
    ctx.beginPath();
    ctx.moveTo(x + rTopLeft, y);
    ctx.lineTo(x + width - rTopRight, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + rTopRight);
    ctx.lineTo(x + width, y + height - rBottomRight);
    ctx.quadraticCurveTo(x + width, y + height, x + width - rBottomRight, y + height);
    ctx.lineTo(x + rBottomLeft, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - rBottomLeft);
    ctx.lineTo(x, y + rTopLeft);
    ctx.quadraticCurveTo(x, y, x + rTopLeft, y);
    ctx.closePath();
    ctx.fill();
    if (strokeWidth) {
      ctx.strokeStyle = PLATE_OUTLINE;
      ctx.lineWidth = strokeWidth;
      ctx.stroke();
    }
  }

  // ---------------------------------------------------------------- icon paths

  function buildCrownPath() {
    var u = 5;
    var path = new Path2D();
    path.moveTo(u * -3, u * -3);
    path.lineTo(u * -1, u * -1);
    path.lineTo(u * 0, u * -3);
    path.lineTo(u * 1, u * -1);
    path.lineTo(u * 3, u * -3);
    path.lineTo(u * 2, u * 1);
    path.lineTo(u * -2, u * 1);
    path.closePath();
    return path;
  }

  function buildSkullPath() {
    var u = 1.6;
    var path = new Path2D();
    // head outline
    path.moveTo(u * 0, u * -7);
    path.lineTo(u * 5, u * -6);
    path.lineTo(u * 7, u * -3);
    path.lineTo(u * 6, u * 2);
    path.lineTo(u * 4, u * 3);
    path.lineTo(u * 3, u * 6);
    path.lineTo(u * 0, u * 7);
    path.lineTo(u * -3, u * 6);
    path.lineTo(u * -4, u * 3);
    path.lineTo(u * -6, u * 2);
    path.lineTo(u * -7, u * -3);
    path.lineTo(u * -5, u * -6);
    path.closePath();
    // eye sockets wind the other way so the nonzero fill leaves holes
    path.arc(u * -3, u * -1, u * 2, 0, TWO_PI, true);
    path.closePath();
    path.arc(u * 3, u * -1, u * 2, 0, TWO_PI, true);
    path.closePath();
    // nose
    path.moveTo(u * 0, u * 1);
    path.lineTo(u * -2, u * 3);
    path.lineTo(u * 0, u * 4);
    path.lineTo(u * 2, u * 3);
    path.closePath();
    return path;
  }

  // Path2D objects are not part of the recorded call stream, so they are built
  // on first use; that also lets this file load under node where Path2D is absent.
  var crownPathCache = null;
  var skullPathCache = null;
  function getCrownPath() {
    return crownPathCache || (crownPathCache = buildCrownPath());
  }
  function getSkullPath() {
    return skullPathCache || (skullPathCache = buildSkullPath());
  }

  // ---------------------------------------------------------------- per-unit drawers

  function drawUnitName(ctx, unit, viewScale, hudScale, fontFamily) {
    var dpr = pixelRatio();
    var fontPx = (24 * hudScale) / dpr;
    var shadowUnit = (4 * hudScale) / dpr;
    ctx.save();
    ctx.translate(unit.position.x, unit.position.y);
    ctx.scale(1.001 / viewScale, 1.001 / viewScale);
    ctx.font = fontPx + 'px ' + fontFamily;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';

    var text = unit.name;

    var offsetY = ~~(-12 * viewScale);
    ctx.lineWidth = shadowUnit / 4;
    ctx.strokeStyle = NAME_INK;
    ctx.shadowColor = NAME_INK;
    ctx.shadowBlur = shadowUnit / 2;
    ctx.strokeText(text, 0, offsetY);
    ctx.fillStyle = NAME_INK;
    ctx.fillText(text, 2, offsetY + 2);

    ctx.fillStyle = NAME_FILL;
    ctx.shadowColor = NAME_FILL;
    ctx.shadowBlur = shadowUnit / 3;
    ctx.fillText(text, 0, offsetY);
    ctx.restore();
  }

  function drawCrownAboveUnit(ctx, unit, worldScale, hudScale) {
    var dpr = pixelRatio();
    var nameFontPx = (24 * hudScale) / dpr;
    var crown = getCrownPath();
    ctx.save();
    ctx.translate(unit.position.x, unit.position.y);
    ctx.scale(1 / (worldScale * dpr), 1 / (worldScale * dpr));
    ctx.fillStyle = '#ffff00';
    ctx.strokeStyle = '#ff8800';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 1;
    ctx.translate(0, -10 * worldScale * dpr);
    ctx.translate(0, -nameFontPx * dpr);
    ctx.scale(hudScale, hudScale);
    ctx.translate(0, -4);
    ctx.translate(0, -12);
    ctx.fill(crown);
    ctx.stroke(crown);
    ctx.restore();
  }

  function drawSkullIcon(ctx, centerX, centerY, iconScale) {
    ctx.save();
    ctx.fillStyle = '#ffffffcc';
    ctx.translate(centerX, centerY);
    ctx.scale(iconScale, iconScale);
    ctx.fill(getSkullPath());
    ctx.restore();
  }

  function drawSkinLayer(config, ctx, unit, display, layer) {
    var trackWidth = config.trackWidth;
    var image = layer.image;
    if (!image) return;

    var imgWidth = image.naturalWidth || image.width;
    var imgHeight = image.naturalHeight || image.height;
    var drawScale = (trackWidth * display.scale * layer.scale) / imgWidth;

    ctx.save();
    ctx.translate(unit.position.x, unit.position.y - config.baseHeight * layer.level);
    ctx.rotate(unit.direction + Math.PI / 2);
    ctx.translate((display.x + layer.x) * trackWidth, (display.y + layer.y) * trackWidth);

    var extraTurn = 0;
    if (layer.direction === 'target') {
      var toTarget = (unit.target || new P.Vec2(0, 0)).clone().sub(unit.position);
      var targetAngle = Math.atan2(toTarget.y, toTarget.x);
      extraTurn += targetAngle - unit.direction;
    }
    if (layer.direction === 'billboard') {
      extraTurn += -unit.direction - Math.PI / 2;
    }
    if (layer.rotation) {
      // layer.rotation is the only angle kept in degrees
      extraTurn += layer.rotation * DEG_TO_RAD;
    }
    if (extraTurn) ctx.rotate(extraTurn);

    ctx.scale(drawScale, drawScale);
    ctx.translate(imgWidth * -layer.pivot.x, imgHeight * -layer.pivot.y);
    ctx.drawImage(image, 0, 0);
    ctx.restore();
  }

  function drawSkinLayers(config, ctx, unit, container, front) {
    var entries = front ? container.frontLayers : container.backLayers;
    entries.forEach(function (entry) {
      drawSkinLayer(config, ctx, unit, entry.display, entry.layer);
    });
  }

  // ---------------------------------------------------------------- world passes

  function renderBaseTops(rc) {
    var game = rc.game;
    var ctx = rc.ctx;
    var margin = game.config.trackWidth;
    game.units.forEach(function (unit) {
      if (rc.boundsInView(unit.base.polygon, margin)) {
        fillPathWith(ctx, unit.base.polygon.path, basePaint(unit));
      }
    });
  }

  // Erases a trench where a track crosses any territory, then repaints the part
  // that lies inside the unit's own base, slightly wider, underneath.
  function renderTrackCutouts(rc) {
    var game = rc.game;
    var ctx = rc.ctx;
    var trackWidth = game.config.trackWidth;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.globalCompositeOperation = 'destination-out';
    game.units.forEach(function (unit) {
      if (!unit.track.polyline.start) return;
      if (!rc.boundsInView(unit.track.polyline, trackWidth)) return;
      strokeTrack(ctx, unit.skin.colors.main, unit.track, unit.position, trackWidth);
      ctx.save();
      ctx.globalCompositeOperation = 'destination-over';
      ctx.clip(unit.base.polygon.path);
      strokeTrack(ctx, basePaint(unit), unit.track, unit.position, trackWidth + 2);
      ctx.restore();
    });
    ctx.restore();
  }

  function renderUnitBackLayers(rc) {
    var game = rc.game;
    var ctx = rc.ctx;
    var trackWidth = game.config.trackWidth;
    game.units.forEach(function (unit) {
      if (rc.pointInView(unit.position, trackWidth * 4)) {
        drawSkinLayers(game.config, ctx, unit, unit.skin.container, false);
      }
    });
  }

  function renderUnitFrontLayers(rc) {
    var game = rc.game;
    var ctx = rc.ctx;
    var trackWidth = game.config.trackWidth;
    game.units.forEach(function (unit) {
      if (rc.pointInView(unit.position, trackWidth * 4)) {
        drawSkinLayers(game.config, ctx, unit, unit.skin.container, true);
      }
    });
  }

  function renderTracks(rc) {
    var game = rc.game;
    var ctx = rc.ctx;
    var trackWidth = game.config.trackWidth;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.globalAlpha = 0.6;
    game.units.forEach(function (unit) {
      if (unit.in === unit.base) return;
      if (!rc.boundsInView(unit.track.polyline, trackWidth)) return;
      strokeTrack(ctx, unit.skin.colors.main, unit.track, unit.position, trackWidth);
    });
    ctx.restore();
  }

  function renderBaseSides(rc) {
    var game = rc.game;
    var ctx = rc.ctx;
    var margin = game.config.trackWidth;
    game.units.forEach(function (unit) {
      if (rc.boundsInView(unit.base.polygon, margin)) {
        fillPathWith(ctx, unit.base.polygon.path, unit.skin.colors.back);
      }
    });
  }

  // Runs inside the destination-over block: floor first, then its rim shifted
  // down, then the backdrop rectangle behind everything.
  function renderArenaAndBackground(rc) {
    var game = rc.game;
    var ctx = rc.ctx;
    var config = game.config;
    var baseHeight = config.baseHeight;
    var arenaPath = game.border.polygon.path;
    fillPathWith(ctx, arenaPath, config.arenaColor);
    ctx.translate(0, 3 * baseHeight);
    fillPathWith(ctx, game.border.polygon.path, config.borderColor);
    ctx.translate(0, -3 * baseHeight);
    ctx.fillStyle = getBackgroundGradient(ctx, game.space, config.backgroundTopColor, config.backgroundBottomColor);
    ctx.fillRect(
      rc.viewScreenWidth / -2,
      rc.viewScreenHeight / -2,
      game.space.width + rc.viewScreenWidth,
      game.space.height + rc.viewScreenHeight
    );
  }

  function renderUnitNames(rc) {
    var game = rc.game;
    var ctx = rc.ctx;
    var trackWidth = game.config.trackWidth;
    var font = game.config.font;
    game.units.forEach(function (unit) {
      if (rc.pointInView(unit.position, trackWidth * 20)) {
        drawUnitName(ctx, unit, rc.scale, rc.hudScale, font);
      }
    });
  }

  function renderParticles(rc) {
    var game = rc.game;
    var ctx = rc.ctx;
    var margin = game.config.trackWidth;
    ctx.save();
    game.particles.forEach(function (particle) {
      // expired particles linger in the list for a while; they are skipped, not drawn
      if (particle.time > 0 && rc.pointInView(particle.position, margin)) {
        particle.draw(ctx);
      }
    });
    ctx.restore();
  }

  // Labels draw in canvas pixels. The scale is undone by its inverse rather than
  // by save/restore, and the crown pass inherits that transform.
  function renderLabels(rc) {
    var game = rc.game;
    var ctx = rc.ctx;
    var scale = rc.scale;
    var font = game.config.font;
    ctx.scale(1 / scale, 1 / scale);
    game.labels.forEach(function (label) {
      label.draw(ctx, font, scale, rc.hudScale);
    });
    ctx.scale(scale, scale);
  }

  function renderLeaderCrown(rc) {
    var leader = rc.game.units[0];
    if (leader) drawCrownAboveUnit(rc.ctx, leader, rc.scale, rc.hudScale);
  }

  // ---------------------------------------------------------------- HUD

  function renderMinimap(rc) {
    var game = rc.game;
    var ctx = rc.ctx;
    var player = game.player;
    var size = rc.viewScreenWidth / rc.calcMult(8, 3);
    var lineWidth = (game.space.width / size) * rc.hudScale * 3;

    ctx.save();
    ctx.translate(rc.viewScreenWidth - rc.padding - size, rc.viewScreenHeight - rc.padding - size);
    ctx.scale(size / game.space.width, size / game.space.height);

    fillPathWith(ctx, game.border.polygon.path, '#c2d6cdaa');
    fillPathWith(ctx, player.base.polygon.path, player.skin.colors.main);
    strokePath(ctx, player.base.polygon.path, player.skin.colors.back, lineWidth / 2);
    strokeTrack(ctx, player.skin.colors.back, player.track, player.position, lineWidth / 2);

    // the frame turns red while any other unit stands on the player's land
    var invaded = game.units.some(function (unit) {
      return !game.isPlayer(unit) && unit.in === game.player.base;
    });
    strokePath(ctx, game.border.polygon.path, invaded ? '#ff0000' : PLATE_OUTLINE, lineWidth);

    ctx.beginPath();
    ctx.arc(player.position.x, player.position.y, lineWidth, 0, TWO_PI);
    ctx.fillStyle = player.skin.colors.nick;
    ctx.fill();

    ctx.restore();
  }

  function drawLeaderboardPlates(ctx, rc) {
    var game = rc.game;
    var padding = rc.padding;
    var backHeight = rc.backHeight;
    var barHeight = rc.barHeight;
    var halfBarHeight = rc.halfBarHeight;
    var barWidth = rc.barWidth;
    var halfBarWidth = rc.halfBarWidth;
    var strokeWidth = rc.strokeWidth;
    var previousRatioWidth;

    function drawRow(unit, rank, slot, topScore) {
      var top = padding + slot * (barHeight * 1.3);
      var score = unit.schemes.scores();
      var ratioWidth = halfBarWidth * (score / topScore);
      // each plate is kept at least 5 percent of the half width shorter than the one above
      if (previousRatioWidth && ratioWidth > previousRatioWidth - halfBarWidth * 0.05) {
        ratioWidth = previousRatioWidth - halfBarWidth * 0.05;
      }
      previousRatioWidth = ratioWidth;
      var plateWidth = halfBarWidth + ratioWidth;
      var left = rc.viewScreenWidth - plateWidth;
      var radii = [halfBarHeight, 0, 0, halfBarHeight];

      ctx.fillStyle = PLATE_SHADOW;
      fillRoundedRect(ctx, left + backHeight, top + backHeight * 3, barWidth, barHeight, radii);
      ctx.fillStyle = unit.skin.colors.back;
      fillRoundedRect(ctx, left, top + backHeight, barWidth, barHeight, radii, strokeWidth);
      ctx.fillStyle = unit.skin.colors.main;
      fillRoundedRect(ctx, left, top, barWidth, barHeight, radii, strokeWidth);

      ctx.fillStyle = unit.skin.colors.plate;
      ctx.font = rc.uiFont;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        rank + ' – ' + unit.schemes.print() + ' ' + unit.name,
        left + halfBarHeight,
        top + halfBarHeight * 1.1
      );
    }

    var leader = game.units[0];
    var leaderScore = leader && leader.schemes.scores();
    var playerListed = false;
    for (var i = 0; i < 5; i++) {
      var unit = game.units[i];
      if (unit) {
        if (game.isPlayer(unit)) playerListed = true;
        drawRow(unit, i + 1, i, leaderScore);
      }
    }
    if (!playerListed && game.player && !game.player.death) {
      var playerIndex = game.units.findIndex(function (candidate) {
        return game.isPlayer(candidate);
      });
      // slot 6, not 5: one row is left empty between the top five and the player
      drawRow(game.player, playerIndex + 1, 6, leaderScore);
    }
  }

  // The plates are drawn into an offscreen canvas only when the top list changes,
  // then blitted every frame. A window resize drops the cache canvas.
  var leaderboardCacheCanvas = null;
  if (typeof root.addEventListener === 'function') {
    root.addEventListener('resize', function () {
      leaderboardCacheCanvas = null;
    }, false);
  }

  function renderLeaderboardCached(rc) {
    var ctx = rc.ctx;
    var dpr = rc.devicePixelRatio;
    if (!leaderboardCacheCanvas) {
      leaderboardCacheCanvas = root.document.createElement('canvas');
      leaderboardCacheCanvas.width = ~~rc.barWidth;
      leaderboardCacheCanvas.height = ~~(rc.barHeight * 1.3 * 8);
    }
    if (rc.game.topListChanged) {
      rc.game.topListChanged = false;
      var cacheCtx = leaderboardCacheCanvas.getContext('2d');
      cacheCtx.save();
      cacheCtx.clearRect(0, 0, leaderboardCacheCanvas.width, leaderboardCacheCanvas.height);
      cacheCtx.translate(-ctx.canvas.width + leaderboardCacheCanvas.width, 0);
      cacheCtx.scale(1 / dpr, 1 / dpr);
      drawLeaderboardPlates(cacheCtx, rc);
      cacheCtx.restore();
    }
    ctx.save();
    ctx.resetTransform();
    ctx.drawImage(leaderboardCacheCanvas, ctx.canvas.width - leaderboardCacheCanvas.width, 0);
    ctx.restore();
  }

  function drawPlayerScoreBar(rc) {
    var game = rc.game;
    var ctx = rc.ctx;
    var padding = rc.padding;
    var backHeight = rc.backHeight;
    var barHeight = rc.barHeight;
    var halfBarHeight = rc.halfBarHeight;
    var barWidth = rc.barWidth;
    var strokeWidth = rc.strokeWidth;
    var player = game.player;

    ctx.fillStyle = PLATE_SHADOW;
    fillRoundedRect(ctx, 0, padding, barWidth, barHeight + backHeight, [
      0,
      (barHeight + backHeight) / 2,
      (barHeight + backHeight) / 2,
      0
    ]);

    // with no stored best the bar is always full
    var progress = game.best ? Math.min(1, player.schemes.scores() / game.best) : 1;
    var filledWidth = barWidth * (0.25 + progress * 0.75);

    ctx.fillStyle = player.skin.colors.back;
    fillRoundedRect(ctx, 0, padding + backHeight, filledWidth, barHeight, [0, halfBarHeight, halfBarHeight, 0], strokeWidth);
    ctx.fillStyle = player.skin.colors.main;
    fillRoundedRect(ctx, 0, padding, filledWidth, barHeight, [0, halfBarHeight, halfBarHeight, 0], strokeWidth);

    ctx.fillStyle = player.skin.colors.plate;
    ctx.font = rc.uiFont;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(player.schemes.print(), halfBarHeight, padding + halfBarHeight * 1.1);
  }

  function drawBestScoreText(rc) {
    var game = rc.game;
    var ctx = rc.ctx;
    var padding = rc.padding;
    ctx.font = rc.uiFont;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    var text = game.language.bestTxt + ' ' + game.player.schemes.print(game.best);
    ctx.fillStyle = '#00000066';
    ctx.fillText(text, padding / 2, padding + rc.barHeight + rc.backHeight + padding / 2);
  }

  function drawKillsCounter(rc) {
    var game = rc.game;
    var ctx = rc.ctx;
    var padding = rc.padding;
    var barHeight = rc.barHeight;
    var halfBarHeight = rc.halfBarHeight;
    var pillY = padding + barHeight + rc.backHeight + rc.fontSize + padding / 2 + 4;
    ctx.font = rc.uiFont;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    var label = 'x' + game.player.statistics.kills;
    ctx.fillStyle = '#00000088';
    fillRoundedRect(ctx, 0, pillY, barHeight * 1.5 + ctx.measureText(label).width, barHeight, [
      0,
      halfBarHeight,
      halfBarHeight,
      0
    ]);
    drawSkullIcon(ctx, (barHeight * 1.4) / 2, pillY + barHeight / 2, rc.hudScale);
    ctx.fillStyle = '#ffffffcc';
    ctx.fillText(label, barHeight * 1.25, pillY + halfBarHeight + barHeight * 0.03);
  }

  // ---------------------------------------------------------------- frame entry point

  function renderGameFrame(game) {
    var rc = game.getRenderContext();
    if (!rc) return;

    var baseHeight = game.config.baseHeight;
    var ctx = rc.ctx;
    var dpr = rc.devicePixelRatio;
    var origin = rc.origin;
    var scale = rc.scale;

    ctx.resetTransform();
    ctx.clearRect(0, 0, rc.viewWidth, rc.viewHeight);
    var offsetX = origin.x * scale - rc.viewWidth / 2;
    var offsetY = origin.y * scale - rc.viewHeight / 2;
    ctx.translate(-offsetX, -offsetY);
    ctx.scale(scale, scale);

    // top faces are drawn lifted by the base height
    ctx.translate(0, -baseHeight);
    renderBaseTops(rc);
    renderTrackCutouts(rc);
    ctx.translate(0, baseHeight);

    // everything in this block goes BEHIND what is already on the canvas, so
    // earlier passes sit on top of later ones
    ctx.globalCompositeOperation = 'destination-over';
    renderUnitBackLayers(rc);
    renderTracks(rc);
    renderBaseSides(rc);
    renderArenaAndBackground(rc);
    ctx.globalCompositeOperation = 'source-over';

    renderUnitFrontLayers(rc);
    renderUnitNames(rc);
    renderParticles(rc);
    renderLabels(rc);
    renderLeaderCrown(rc);

    ctx.resetTransform();
    ctx.scale(1 / dpr, 1 / dpr);
    if (game.player) {
      renderLeaderboardCached(rc);
      drawPlayerScoreBar(rc);
      drawBestScoreText(rc);
      drawKillsCounter(rc);
      renderMinimap(rc);
    }
  }

  P.getBackgroundGradient = getBackgroundGradient;
  P.strokePath = strokePath;
  P.strokeTrack = strokeTrack;
  P.fillPathWith = fillPathWith;
  P.fillRoundedRect = fillRoundedRect;
  P.buildCrownPath = buildCrownPath;
  P.buildSkullPath = buildSkullPath;
  P.drawUnitName = drawUnitName;
  P.drawCrownAboveUnit = drawCrownAboveUnit;
  P.drawSkullIcon = drawSkullIcon;
  P.drawSkinLayer = drawSkinLayer;
  P.drawSkinLayers = drawSkinLayers;
  P.renderBaseTops = renderBaseTops;
  P.renderTrackCutouts = renderTrackCutouts;
  P.renderUnitBackLayers = renderUnitBackLayers;
  P.renderUnitFrontLayers = renderUnitFrontLayers;
  P.renderTracks = renderTracks;
  P.renderBaseSides = renderBaseSides;
  P.renderArenaAndBackground = renderArenaAndBackground;
  P.renderUnitNames = renderUnitNames;
  P.renderParticles = renderParticles;
  P.renderLabels = renderLabels;
  P.renderLeaderCrown = renderLeaderCrown;
  P.renderMinimap = renderMinimap;
  P.renderLeaderboardCached = renderLeaderboardCached;
  P.drawLeaderboardPlates = drawLeaderboardPlates;
  P.drawPlayerScoreBar = drawPlayerScoreBar;
  P.drawBestScoreText = drawBestScoreText;
  P.drawKillsCounter = drawKillsCounter;
  P.renderGameFrame = renderGameFrame;
})(typeof window !== 'undefined' ? window : globalThis);
