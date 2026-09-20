(function (root) {
  'use strict';
  var P = root.DuelPaperLib = root.DuelPaperLib || {};

  // Kill reason codes (shared numbering across modules).
  var REASON_WIN = 0;
  var REASON_TRACK_CUT = 3;
  var REASON_EXIT_POINT_CAPTURED = 4;
  var REASON_ENCIRCLED = 5;
  var REASON_SYSTEM_REMOVED = 6;

  var FRAME_MS = 1000 / 60;
  var PREPARE_STEP_MS = (1000 / 60) * 2;
  var GEOM_EPSILON = Math.pow(2, -26);

  // Clock is looked up on every call so a virtualised performance.now is always honoured.
  function nowMs() {
    return (typeof performance !== 'undefined' ? performance : Date).now();
  }

  function lerp(from, to, t) {
    return from + (to - from) * t;
  }

  // (t - 1)^3 + 1, with the decrement applied first.
  function easeOutCubic(t) {
    return --t * t * t + 1;
  }

  function inRangeEps(boundA, boundB, value) {
    return Math.min(boundA, boundB) - GEOM_EPSILON <= value &&
      value <= Math.max(boundA, boundB) + GEOM_EPSILON;
  }

  function intervalOverlap(a0, a1, b0, b1) {
    var swap;
    if (a0 > a1) { swap = a0; a0 = a1; a1 = swap; }
    if (b0 > b1) { swap = b0; b0 = b1; b1 = swap; }
    return Math.min(a1, b1) - Math.max(a0, b0);
  }

  // Which bot type to add next, by difficulty row. Each row is a wish list that is
  // consumed by the bots already alive; the first unmet entry wins.
  var BOT_TYPE_ROWS = [
    [1, 2, 2, 3, 3, 3, 3, 0, 0, 0, 0, 0, 0, 0, 0],
    [1, 1, 2, 2, 2, 3, 3, 3, 0, 0, 0, 0, 0, 0, 0],
    [1, 1, 2, 2, 2, 2, 3, 3, 0, 0, 0, 0, 0, 0, 0],
    [1, 1, 1, 2, 2, 2, 2, 2, 3, 0, 0, 0, 0, 0, 0]
  ];

  class Game {
    constructor(config, view, space, border, skinManager, gameOverCallback, nameManager,
      controller, language, schemesManager, seed) {
      this.best = void 0;
      this.playerDeathCallback = void 0;
      this.topListChanged = false;
      this.renderer = void 0;
      this.rng = P.createSeededRng(seed);
      this.build = 704;
      this.config = config;
      this.language = language;
      this.controller = controller;
      this.skinManager = skinManager;
      this.nameManager = nameManager;
      this.space = space;
      this.view = view;
      this.border = border;
      this.player = null;
      this.units = [];
      this.mouse = new P.Vec2();
      this.direction = new P.Vec2(1, 0);
      this.cycle = 0;
      this.seed = seed;
      this.botSpawnLimited = false;
      this.labels = [];
      this.scale = config.maxScale;
      this.square = this.border.polygon.square();
      this.gameOverCallback = gameOverCallback;
      this.visible = false;
      this.stopped = false;
      this.level = 0;
      this.bots = [0, 0, 0, 0];
      this.spawnSuspend = 0;
      this.particles = [];
      this.schemesManager = schemesManager;
      this.last = 0;
      this.timeAccumulated = 0;
      this.looped = false;
      this.border.polygon.calcPath();
      this.quality = 1;
      this.fpsSequence = [];
      this.stats = { fps: 0 };
      this.events = { returns: 0, kills: 0 };
      // Expired particles are dropped on a wall-clock timer, not per tick.
      this.updateParticlesId = setInterval(() => {
        this.particles = this.particles.filter((particle) => particle.time > 0);
      }, 500);
    }

    stop() {
      this.stopped = true;
      clearInterval(this.updateParticlesId);
      for (const unit of this.units) {
        this.skinManager.release(unit.skin);
      }
    }

    addPlayer(unit) {
      this.quality = 1;
      this.fpsSequence = [];
      this.addUnit(unit);
      this.player = unit;
      // Parity draw: keeps the Math.random stream aligned with the recorded reference runs.
      Math.random();
    }

    addUnit(unit) {
      this.units.push(unit);
    }

    getSpawnPosition(mode, spawnRadius) {
      const center = this.space.center;
      const radius = this.border.radius;
      const baseRadius = this.config.baseRadius;
      let anchor = center;
      if (mode === 'player' && !this.player) {
        return;
      }
      spawnRadius = spawnRadius || baseRadius;
      const trackFactor = this.player ? lerp(3, 1, this.player.percent) : 2;
      const baseClearance = spawnRadius + 2 * baseRadius;
      const baseClearanceSq = baseClearance * baseClearance;
      const trackClearance = spawnRadius + 2 * baseRadius * trackFactor;
      const trackClearanceSq = trackClearance * trackClearance;
      let distance;
      switch (mode) {
        case 'player':
          distance = lerp(12 * baseRadius, 16 * baseRadius, Math.random());
          anchor = this.player.position;
          break;
        case 'bounds':
          distance = lerp(
            Math.max(0, radius - (spawnRadius + 10 * baseRadius)),
            Math.max(0, radius - (spawnRadius + 4 * baseRadius)),
            Math.random()
          );
          break;
        case 'center':
          distance = lerp(0, radius / 3, Math.random());
          break;
        default:
          distance = lerp(0, Math.max(0, radius - (spawnRadius + baseRadius)), Math.random());
          break;
      }
      const offset = P.Vec2.alloc(0, distance).rotate(Math.random() * Math.PI * 2);
      const candidate = anchor.clone().add(offset);
      offset.release();
      if (candidate.distance(center) > radius - (spawnRadius + baseRadius)) {
        return;
      }
      for (let i = 0; i < this.units.length; i++) {
        const other = this.units[i];
        if (other.base.polygon.inside(candidate)) {
          return;
        }
        if (other.base.polygon.simplify.some((vertex) => candidate.distanceSq(vertex) < baseClearanceSq)) {
          return;
        }
        if (other.track.simplified.some((vertex) => candidate.distanceSq(vertex) < trackClearanceSq)) {
          return;
        }
      }
      return candidate;
    }

    spawnBot(mode) {
      const config = this.config;
      const baseCount = config.baseCount;
      const baseRadius = config.baseRadius;
      if (this.botSpawnLimited) {
        if (this.spawnSuspend > 0) return;
        this.spawnSuspend = config.spawnTimeout * (1 + this.rng());
      }
      if (this.units.length - (this.player ? 1 : 0) >= config.botsCount) {
        return;
      }
      if (!(this.nameManager && this.nameManager.available())) {
        return;
      }
      if (!(this.skinManager && this.skinManager.available())) {
        return;
      }
      const position = this.getSpawnPosition(mode);
      if (!position) {
        return;
      }
      const census = [0, 0, 0, 0];
      this.units.forEach((unit) => {
        if (unit !== this.player) {
          census[unit.type]++;
        }
      });
      this.bots = Object.assign({}, census);
      const row = BOT_TYPE_ROWS[Math.round(this.level * (BOT_TYPE_ROWS.length - 1))];
      let rowIndex = -1;
      while (census[row[++rowIndex]] > 0) {
        census[row[rowIndex]]--;
      }
      const botType = row[rowIndex];
      const botName = this.nameManager.get();
      const bot = new P.BotUnit(
        this,
        botType,
        botName,
        position,
        P.makeCirclePoints(position, baseCount, baseRadius),
        void 0,
        this.schemesManager
      );
      const skin = this.skinManager.get();
      bot.setSkin(skin);
      this.addUnit(bot);
      this.bots[botType]++;
    }

    spawnPlayer(playerName, skinName) {
      const config = this.config;
      const baseCount = config.baseCount;
      const baseRadius = config.baseRadius;
      const maxScale = config.maxScale;
      const minScale = config.minScale;
      const evictMiddleUnit = () => {
        this.units.length &&
          this.kill(this.units[~~(this.units.length / 2)], void 0, REASON_SYSTEM_REMOVED);
      };
      if (this.units.length && this.units.length >= config.botsCount) {
        evictMiddleUnit();
      }
      let position;
      let tries = 0;
      while (!position) {
        if (tries++ > 50) {
          tries = 0;
          evictMiddleUnit();
        }
        position = this.getSpawnPosition('random', baseRadius);
      }
      const player = new P.PlayerUnit(
        this,
        playerName || this.language.defaultPlayerName,
        position,
        P.makeCirclePoints(position, baseCount, baseRadius),
        void 0,
        this.schemesManager
      );
      const skin = this.skinManager.getPlayerSkin(skinName);
      player.setSkin(skin);
      this.addPlayer(player);
      this.scale = maxScale - (~~((player.base.square / this.square) * 20) / 20) * (maxScale - minScale);
      this.startTime = nowMs();
    }

    gameOver(reason) {
      const player = this.player;
      if (!player.win) {
        let minX = Infinity;
        let maxX = 0;
        let minY = Infinity;
        let maxY = 0;
        player.base.polygon.segments.forEach((segment) => {
          const x = segment.start.x;
          const y = segment.start.y;
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        });
        const boxWidth = maxX - minX;
        const boxHeight = maxY - minY;
        const boxMaxDim = Math.max(boxWidth, boxHeight);
        const boxMid = new P.Vec2(minX + boxWidth / 2, minY + boxHeight / 2);
        const shotSize = 500;
        const shotScale = (shotSize * 0.95) / boxMaxDim;
        const shotDepth = shotSize / 100;
        let image;
        // Territory snapshot for the results card. The draw calls are part of the frame's call log.
        if (typeof document !== 'undefined') {
          const shotCanvas = document.createElement('canvas');
          shotCanvas.width = shotSize;
          shotCanvas.height = shotSize;
          const shotCtx = shotCanvas.getContext('2d');
          shotCtx.scale(shotScale, shotScale);
          shotCtx.translate(
            shotSize / 2 / shotScale - boxMid.x,
            shotSize / 2 / shotScale - boxMid.y
          );
          shotCtx.translate(0, shotDepth / shotScale);
          shotCtx.fillStyle = player.skin.colors.back;
          shotCtx.fill(player.base.polygon.path);
          shotCtx.translate(0, (-2 * shotDepth) / shotScale);
          shotCtx.fillStyle = (player.skin.pattern && player.skin.pattern.pattern) || player.skin.colors.main;
          shotCtx.fill(player.base.polygon.path);
          image = shotCanvas.toDataURL('image/png');
        }
        const result = {
          build: this.build,
          game: this,
          percent: player.percent,
          score: player.schemes && player.schemes.result(),
          newBest: player.schemes && player.schemes.result() > this.best,
          name: player.name,
          top: player.top,
          best: this.best,
          bestPercent: player.bestPercent,
          time: nowMs() - this.startTime,
          kills: player.statistics.kills,
          image: image,
          reason: reason
        };
        if (reason === REASON_WIN) {
          player.win = true;
        }
        this.playerDeathCallback && this.playerDeathCallback();
        // Wall-clock delay: enemy kills linger longer so the camera can follow the killer.
        // A winner is only removed when the delay ends.
        setTimeout(
          () => {
            reason === REASON_WIN && this.kill(player, void 0, reason);
            this.player = null;
            this.gameOverCallback && this.gameOverCallback(result);
          },
          reason === REASON_TRACK_CUT ||
            reason === REASON_EXIT_POINT_CAPTURED ||
            reason === REASON_ENCIRCLED
            ? this.config.enemyKillDelay
            : this.config.selfKillDelay
        );
      }
    }

    kill(victim, killer, reason) {
      if (victim.death) {
        return;
      }
      this.events.kills++;
      victim.death = true;
      this.skinManager && this.skinManager.release(victim.skin);
      this.units.forEach((unit) => {
        if (unit !== victim && unit.in === victim.base) {
          unit.in = null;
        }
      });
      if (reason !== REASON_SYSTEM_REMOVED) {
        P.spawnDeathParticles(victim, null, victim.track.polyline.segments);
        P.spawnDeathParticles(victim, null, victim.base.polygon.segments);
      }
      victim.track.remove();
      victim.base.remove();
      const victimIndex = this.units.findIndex((unit) => unit === victim);
      this.units.splice(victimIndex, 1);
      victim.killer = killer;
      if (killer) {
        killer.scores.kills = victim.scores.kills + victim.scores.accumulator;
        killer.schemes && killer.schemes.kill(victim, reason);
        killer.statistics.kills++;
      }
      victim.onScoreChanged();
      if (killer) killer.onScoreChanged();
      if (reason !== REASON_WIN && victim === this.player) {
        this.gameOver(reason);
      }
    }

    prepareAndUpdate(frameDtMs) {
      if (this.preparing()) {
        let stepsLeft = this.config.prepareAcceleration;
        while (this.preparing() && stepsLeft > 0) {
          this.update(PREPARE_STEP_MS);
          stepsLeft--;
        }
      } else {
        this.update(frameDtMs);
      }
    }

    preparing() {
      return this.cycle < this.config.prepareCounter;
    }

    finishPrepare() {
      const targetCycle = this.config.prepareCounter;
      while (this.cycle < targetCycle) {
        this.update();
      }
    }

    // One simulation tick. tickDtMs is in milliseconds.
    update(tickDtMs) {
      const config = this.config;
      const maxScale = config.maxScale;
      const minScale = config.minScale;
      const observerScale = config.observerScale;
      if (this.stopped) return false;
      P.Vec2.space = this.space;
      if (tickDtMs == null) tickDtMs = 1000 / 60;
      tickDtMs += this.rng() * 0.01;
      this.spawnSuspend -= tickDtMs;
      this.readInput(tickDtMs);
      this.angle = Math.round((Math.atan2(this.direction.y, this.direction.x) / Math.PI) * 127 + 254) % 254;
      this.recoverTail();
      const player = this.player;
      this.units.forEach((unit) => unit.update(tickDtMs));
      this.handleUnitMovements(tickDtMs);
      this.units.forEach((unit) => {
        unit.lastSquare = unit.base.square;
      });
      this.units.forEach((unit) => {
        const fraction = unit.base.square / this.square;
        unit.percent = fraction;
        unit.bestPercent = Math.max(unit.bestPercent, fraction);
        unit.scale = lerp(maxScale, minScale, easeOutCubic(~~(fraction * 20) / 20));
        unit.visionRange = 0.8 * (Math.sqrt(1366 * 1366 + 768 * 768) / 2 / unit.scale);
        unit.schemes && unit.schemes.update(tickDtMs);
        if (unit.labels.length) {
          let labelOffset = new P.Vec2(0, -35);
          const labelVelocity = new P.Vec2(0, -10);
          const labelOffsetStep = new P.Vec2(0, -10);
          unit.labels.forEach((pending) => {
            this.labels.push(
              new P.FloatingLabel(
                pending.text,
                pending.color,
                pending.unit,
                labelOffset,
                labelVelocity,
                pending.time,
                pending.fading
              )
            );
            labelOffset = labelOffset.clone().add(labelOffsetStep);
          });
          unit.labels = [];
        }
      });
      this.units.sort((a, b) => (b.schemes && a.schemes ? b.schemes.scores() - a.schemes.scores() : 0));
      this.units.forEach((unit, index) => {
        unit.top = index + 1;
      });
      this.labels = this.labels.filter((label) => {
        label.update(tickDtMs);
        return label.time > 0;
      });
      this.particles.forEach((particle) => particle.update(tickDtMs));
      if (player) {
        this.level = lerp(config.startBotLevel, 1, player.percent);
      } else {
        this.level = config.noPlayerBotLevel;
      }
      if (config.botLevel !== -1) {
        this.level = config.botLevel;
      }
      this.units.forEach((bot) => {
        if (bot instanceof P.BotUnit) {
          const skill = Math.min(1, Math.max(0, this.level + bot.jitter));
          let aggroMin = config.botAggroMin;
          let aggroMax = config.botAggroMax;
          let defMin = config.botDefMin;
          let defMax = config.botDefMax;
          let greedMin = config.botGreedMin;
          let greedMax = config.botGreedMax;
          let safetyMin = config.botSafetyMin;
          let safetyMax = config.botSafetyMax;
          switch (bot.type) {
            case 1:
              aggroMin *= 1.25;
              aggroMax *= 1.25;
              break;
            case 2:
              greedMin *= 2;
              greedMax *= 1.1;
              safetyMin *= 0.75;
              safetyMax *= 0.75;
              break;
            case 3:
              aggroMin *= 0.75;
              aggroMax *= 0.75;
              greedMin *= 4;
              greedMax *= 1.1;
              safetyMin *= 0.5;
              safetyMax *= 0.5;
              defMin *= 2;
              defMax *= 2;
              break;
          }
          bot.aggro = lerp(aggroMin, aggroMax, skill);
          bot.greed = lerp(greedMin, greedMax, skill);
          bot.safety = lerp(safetyMin, safetyMax, skill);
          bot.def = lerp(defMin, defMax, skill);
        }
      });
      // A long player trail pulls the nearest bot into its attack state, every tick.
      if (player && player.track.length > config.botAttackTrackLength) {
        let nearestBot = null;
        let nearestDist = Infinity;
        this.units.forEach((bot) => {
          if (bot instanceof P.BotUnit) {
            let dist = Infinity;
            player.track.simplified.forEach((point) => {
              const d2 = point.distanceSq(bot.position);
              if (d2 < dist) {
                dist = d2;
              }
            });
            dist = Math.sqrt(dist);
            if (dist < nearestDist) {
              nearestBot = bot;
              nearestDist = dist;
            }
          }
        });
        nearestBot && nearestBot.fsm.change('attack');
      }
      const targetScale = player ? player.scale : observerScale;
      const scaleDelta = targetScale - this.scale;
      this.scale += (scaleDelta * tickDtMs) / (1000 * 0.4);
      if (player && player.percent > 0.9999) {
        player.percent = 1;
        this.gameOver(REASON_WIN);
      }
      for (let i = 0; i < config.nearPlayerBotSpawnCount; i++) {
        this.spawnBot('player');
      }
      this.spawnBot('center');
      this.spawnBot(this.rng() > 0.3 ? 'bounds' : 'random');
      this.cycle++;
      return true;
    }

    get renderContext() {
      return this.getRenderContext();
    }

    // Per rendered frame: sizes the backing store, eases the camera and derives the HUD metrics.
    getRenderContext() {
      const view = this.view;
      if (!view) {
        return;
      }
      const font = this.config.font;
      const ctx = view.getContext('2d');
      const cssWidth = view.clientWidth;
      const cssHeight = view.clientHeight;
      const viewWidth = ~~(cssWidth * this.quality);
      const viewHeight = ~~(cssHeight * this.quality);
      if (view.width !== viewWidth || view.height !== viewHeight) {
        view.width = viewWidth;
        view.height = viewHeight;
      }
      const devicePixelRatio = root.devicePixelRatio;
      const viewScreenWidth = viewWidth * devicePixelRatio;
      const viewScreenHeight = viewHeight * devicePixelRatio;
      const hudScale =
        Math.sqrt(viewScreenWidth * viewScreenWidth + viewScreenHeight * viewScreenHeight) /
        Math.sqrt(1366 * 1366 + 768 * 768);
      const scale = (this.scale * hudScale) / devicePixelRatio;
      let focus;
      if (this.player) {
        focus = this.player.position;
        if (this.player.killer && this.config.followKiller) {
          focus = this.player.killer.position;
        }
      } else {
        focus = this.space.center;
      }
      // Smoothing only applies in observer mode or while following a killer; it is per frame, not per ms.
      if (this.origin && (!this.player || this.player.killer)) {
        const gap = this.origin.distance(focus);
        const stepLength = gap / 30;
        const stepVec = focus.clone().sub(this.origin).normalize().mulScalar(stepLength);
        focus = this.origin.add(stepVec);
      }
      this.origin = focus.clone();
      const viewLeft = focus.x - viewWidth / 2 / scale;
      const viewRight = focus.x + viewWidth / 2 / scale;
      const viewTop = focus.y - viewHeight / 2 / scale;
      const viewBottom = focus.y + viewHeight / 2 / scale;
      const pointInView = (point, margin = 0) =>
        inRangeEps(viewLeft - margin, viewRight + margin, point.x) &&
        inRangeEps(viewTop - margin, viewBottom + margin, point.y);
      const boundsInView = (shape, margin = 0) =>
        intervalOverlap(shape.bounds.left - margin, shape.bounds.right + margin, viewLeft, viewRight) > 0 &&
        intervalOverlap(shape.bounds.top - margin, shape.bounds.bottom + margin, viewTop, viewBottom) > 0;
      // Linear blend between a landscape and a portrait value by aspect ratio.
      // The operation order is deliberate: it yields 19.999999999999996 for (20, 30) at 16:9.
      const calcMult = (landscapeValue, portraitValue) => {
        const aspectWide = 16 / 9;
        const aspectTall = 9 / 16;
        const aspect = P.clampMinMax(aspectTall, aspectWide, viewScreenWidth / viewScreenHeight);
        const valueDelta = landscapeValue - portraitValue;
        const aspectDelta = aspectTall - aspectWide;
        const intercept = -(valueDelta * aspectWide + aspectDelta * landscapeValue);
        return -(intercept + valueDelta * aspect) / aspectDelta;
      };
      const fontSize = ~~(calcMult(20, 30) * hudScale);
      const strokeWidth = this.config.platesStrokeWidth * hudScale;
      const backHeight = ~~(4 * hudScale);
      const uiFont = fontSize + 'px ' + font;
      const padding = ~~(16 * hudScale);
      const halfBarHeight = ~~(fontSize * 0.75);
      const barHeight = halfBarHeight * 2;
      const barWidth = ~~(viewScreenWidth / calcMult(4, 2.25));
      const halfBarWidth = ~~(barWidth / 2);
      return {
        game: this,
        view: view,
        ctx: ctx,
        viewWidth: viewWidth,
        viewHeight: viewHeight,
        devicePixelRatio: devicePixelRatio,
        hudScale: hudScale,
        scale: scale,
        origin: focus,
        pointInView: pointInView,
        boundsInView: boundsInView,
        calcMult: calcMult,
        viewScreenWidth: viewScreenWidth,
        viewScreenHeight: viewScreenHeight,
        fontSize: fontSize,
        strokeWidth: strokeWidth,
        backHeight: backHeight,
        uiFont: uiFont,
        padding: padding,
        barHeight: barHeight,
        halfBarHeight: halfBarHeight,
        barWidth: barWidth,
        halfBarWidth: halfBarWidth
      };
    }

    // Smoothed frame rate plus the automatic render-quality stepping.
    updateMetrics(frameTimeMs) {
      const stats = this.stats;
      const alpha = 0.05;
      stats.fps = lerp(stats.fps, 1000 / frameTimeMs, alpha);
      this.fpsSequence.push(stats.fps);
      const lowFps = 25;
      const highFps = 35;
      const veryLowFps = 10;
      const windowSize = 120;
      const minQuality = 0.5;
      if (this.fpsSequence.length > windowSize) {
        // Default (string) ordering on purpose, to pick the same "median" sample.
        this.fpsSequence.sort();
        const medianFps = this.fpsSequence[~~(windowSize / 2)];
        if (medianFps < lowFps) {
          this.quality -= 0.1;
        }
        if (medianFps < veryLowFps) {
          this.quality -= 0.1;
        }
        if (this.quality < minQuality) {
          this.quality = minQuality;
        }
        if (medianFps > highFps) {
          this.quality += 0.1;
        }
        if (this.quality > 1) {
          this.quality = 1;
        }
        this.quality = Math.round(this.quality * 10) / 10;
        this.fpsSequence = [];
      }
      this.events = { returns: 0, kills: 0 };
    }

    render() {
      if (this.renderer) this.renderer(this);
    }

    isPlayer(unit) {
      return unit === this.player;
    }

    // One animation frame: variable timestep, long frames are split into sub-steps.
    loop() {
      const frameNow = nowMs();
      if (this.stopped) {
        return;
      }
      if (this.visible || this.cycle < this.config.prepareCounter) {
        this.looped = true;
        if (this.last == 0) this.last = frameNow;
        let frameDtMs = frameNow - this.last;
        if (frameDtMs < 1) {
          frameDtMs = 1;
        }
        // The frame-rate average sees the uncapped delta.
        this.updateMetrics(frameDtMs);
        if (frameDtMs > 10 * 1000) {
          frameDtMs = 10 * 1000;
        }
        if (this.visible) {
          const maxSubStepMs = 2 * FRAME_MS;
          while (frameDtMs > 0) {
            const subStepMs =
              frameDtMs <= maxSubStepMs
                ? frameDtMs
                : frameDtMs < maxSubStepMs * 2
                  ? frameDtMs / 2 + Math.random()
                  : maxSubStepMs + Math.random();
            this.update(subStepMs);
            frameDtMs -= subStepMs;
          }
        } else {
          this.prepareAndUpdate(frameDtMs);
        }
      }
      if (this.visible) {
        this.render();
      }
      // Refreshed even on skipped frames, so a pause never produces one giant delta.
      this.last = frameNow;
      requestAnimationFrame(() => this.loop());
    }
  }

  P.Game = Game;
})(typeof window !== 'undefined' ? window : globalThis);
