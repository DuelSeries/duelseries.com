(function (root) {
  'use strict';
  var P = root.DuelPaperLib = root.DuelPaperLib || {};

  // Wall clock read at call time so a harness that swaps performance.now is always honoured.
  function currentTimeMs() {
    if (typeof performance !== 'undefined') return performance.now();
    return Date.now();
  }

  function twoDecimals(value) {
    return value.toFixed(2);
  }

  // ---------------------------------------------------------------------------------------------
  // Particles
  // ---------------------------------------------------------------------------------------------

  function makeUnitSquarePath() {
    var path = new Path2D();
    var half = 1;
    path.moveTo(-half, -half);
    path.lineTo(half, -half);
    path.lineTo(half, half);
    path.lineTo(-half, half);
    path.closePath();
    return path;
  }

  // Built once. Under node (no Path2D) it is built on first draw instead, which never happens there.
  var sharedSquarePath = typeof Path2D !== 'undefined' ? makeUnitSquarePath() : null;

  class Particle {
    constructor(target, color, position, velocity, acceleration, rotate, scale, scaleSpeed, time, fn) {
      this.target = target;
      this.color = color;
      this.position = position;
      this.velocity = velocity;
      this.acceleration = acceleration;
      this.rotate = rotate;
      this.scale = scale;
      this.scaleSpeed = scaleSpeed;
      // Always the LAST Math.random draw of any particle creation.
      this.rotation = Math.random() * Math.PI * 2;
      this.time = time;
      this.fn = fn;
    }

    update(dtMs) {
      var dtSec = dtMs / 1000;
      this.time -= dtMs;
      if (this.time <= 0) {
        // Fires on every update after expiry until the sweep removes the particle.
        if (this.fn) this.fn(this);
        return;
      }
      this.position.x += this.velocity.x * dtSec;
      this.position.y += this.velocity.y * dtSec;
      if (this.acceleration) {
        this.velocity.x += this.acceleration.x * dtSec;
        this.velocity.y += this.acceleration.y * dtSec;
      }
      this.rotation += this.rotate * dtSec;
      this.scale += this.scaleSpeed * dtSec;
    }

    draw(ctx) {
      var px = this.position.x;
      var py = this.position.y;
      var color = this.color;
      var size = this.scale;
      var before = ctx.getTransform();
      ctx.translate(px, py);
      ctx.rotate(this.rotation);
      ctx.scale(size, size);
      if (typeof color === 'string') {
        // The guard matters: the draw-call diff only sees a fillStyle write when one happens.
        if (ctx.fillStyle !== color) {
          ctx.fillStyle = color;
        }
        if (!sharedSquarePath) sharedSquarePath = makeUnitSquarePath();
        ctx.fill(sharedSquarePath);
      } else {
        ctx.scale(1 / 20, 1 / 20);
        ctx.drawImage(color, -color.width / 2, -color.height / 2);
      }
      ctx.setTransform(before);
    }

    // The crumb thrown off while a unit eats into territory. Eight draws here, the ninth in the constructor.
    static emitCrumb(unit, moveSegment, trackWidth) {
      var Vec2 = P.Vec2;
      var side = Math.sign(Math.random() - 0.5);
      var avatarSize = unit.skin.container.maxScale * trackWidth;
      var config = unit.game.config;
      var unitSpeed = config.unitSpeed;
      var baseHeight = config.baseHeight;

      var swerve = side * Math.random() * (Math.PI / 30);
      var launchSpeed = unitSpeed * (1 + Math.random());
      var velocity = moveSegment.vector.clone().normalize().rotate(swerve).mulScalar(launchSpeed);

      var sideways = moveSegment.vector
        .clone()
        .rotate(Math.PI / 2)
        .normalize()
        .mulScalar((side * Math.random() * avatarSize) / 2);

      var ahead = moveSegment.vector.clone().normalize().mulScalar(avatarSize / 2);

      var drag = moveSegment.vector
        .clone()
        .normalize()
        .mulScalar(unitSpeed * -6)
        .rotate(side * Math.random() * (Math.PI / 10));

      var palette = unit.in.unit.skin.colors.particles;
      var startScale = 0.75 + Math.random() * 0.5;
      var pickedColor = palette[~~(Math.random() * palette.length)];
      var startPosition = moveSegment.start
        .clone()
        .add(sideways)
        .add(ahead)
        .add(new Vec2(0, -baseHeight));
      var spin = Math.PI + Math.random() * Math.PI;

      return new Particle(null, pickedColor, startPosition, velocity, drag, spin, startScale, -2 * startScale, 300);
    }
  }

  // One burst particle for roughly every 5 world units of outline. Eight draws each, plus the constructor's.
  function spawnDeathParticles(deadUnit, collectorUnit, shapeSegments, isBigBurst) {
    var game = deadUnit.game;
    if (!game.visible) return;

    var deadScore = deadUnit.schemes.scores();
    var made = 0;
    var walked = 0;
    var share = 0;

    shapeSegments.forEach(function (seg) {
      walked += seg.vector.magnitude();
      if (!(walked > 5)) return;
      walked = 0;

      var quarterTurn = (Math.sign(Math.random() - 0.5) * Math.PI) / 2;
      var launchSpeed = 25 + Math.random() * 100;
      var velocity = seg.vector.clone().normalize().rotate(quarterTurn).mulScalar(launchSpeed);
      if (Math.random() > 0.25) {
        velocity.mulScalar(0.1);
      }

      var startScale = (isBigBurst ? 3 : 1) * (1 + Math.random() * 0.5);
      var lifeMs = 500 + Math.random() * 500;
      var shrinkRate = -startScale * 0.7 * (1000 / lifeMs);

      var palette = deadUnit.skin.colors.particles;
      var pickedColor = palette[~~(Math.random() * deadUnit.skin.colors.particles.length)];
      var startPosition = seg.start.clone();
      var spin = Math.PI * 2 * (1 + Math.random()) * Math.sign(Math.random() - 0.5 || 1);

      var onExpire = function (spent) {
        if (!collectorUnit) return;
        // Homing hand-off. No caller passes a collector today, kept because the hook is part of the model.
        spent.target = collectorUnit;
        spent.time = 1;
        spent.velocity = spent.velocity.magnitude();
        spent.acceleration = (1.5 + Math.random() * 0.5) * game.config.unitSpeed;
        spent.fn = function () {
          if (isBigBurst) {
            collectorUnit.schemes.getScheme().accumulator += share;
          }
        };
        spent.scaleSpeed = 0;
        spent.scale = 1;
      };

      game.particles.push(
        new Particle(null, pickedColor, startPosition, velocity, null, spin, startScale, shrinkRate, lifeMs, onExpire)
      );
      made++;
    });

    share = deadScore / made;
  }

  // ---------------------------------------------------------------------------------------------
  // Score schemes
  // ---------------------------------------------------------------------------------------------

  class ScoreSchemeManager {
    constructor() {
      this.Schemes = Array.prototype.slice.call(arguments);
      this.current = 0;
    }

    getSchemes(unit) {
      return new UnitScoreSchemes(
        this.Schemes.map(function (Scheme) { return new Scheme(unit); }),
        this
      );
    }

    next() {
      this.current++;
      if (this.current === this.Schemes.length) {
        this.current = 0;
      }
    }
  }

  class UnitScoreSchemes {
    constructor(schemes, manager) {
      this.schemes = schemes;
      this.manager = manager;
    }

    getScheme(name) {
      if (name) {
        return this.schemes.find(function (s) { return s.name === name; });
      }
      return this.schemes[this.manager.current];
    }

    scores() {
      return this.schemes[this.manager.current].scores();
    }

    result() {
      return this.schemes[this.manager.current].result();
    }

    print(value) {
      return this.schemes[this.manager.current].print(value);
    }

    // The trailing boolean handed to each scheme means "you are NOT the active scheme".
    update(dtMs) {
      var manager = this.manager;
      this.schemes.forEach(function (s, i) { s.update(dtMs, manager.current !== i); });
    }

    kill(victim, reason) {
      var manager = this.manager;
      this.schemes.forEach(function (s, i) { s.kill(victim, reason, manager.current !== i); });
    }

    out() {
      var manager = this.manager;
      this.schemes.forEach(function (s, i) { s.out(manager.current !== i); });
    }

    comeback(info) {
      var manager = this.manager;
      this.schemes.forEach(function (s, i) { s.comeback(info, manager.current !== i); });
    }
  }

  class BaseScoreScheme {
    constructor(unit, name) {
      this.unit = unit;
      this.name = name;
    }

    getScheme() {
      return this;
    }

    scores() {
      return 0;
    }

    print() {
      return twoDecimals(this.scores());
    }

    result() {
      return this.scores();
    }

    kill() {}
    update() {}
    out() {}
    comeback() {}
  }

  class PercentScoreScheme extends BaseScoreScheme {
    constructor(unit) {
      super(unit, 'percent');
    }

    scores() {
      return this.unit.percent * 100;
    }

    result() {
      return +this.scores().toFixed(2);
    }

    // A falsy override (a stored best of 0) falls through to the live score.
    print(override) {
      var shown = override || this.scores();
      return twoDecimals(shown) + '%';
    }

    kill(victim, reason, inactive) {
      if (!inactive && this.unit.isPlayer) {
        this.unit.addLabel({
          text: this.unit.game.language.killText,
          color: victim.skin.colors.main,
          unit: this.unit,
          time: 1000,
          fading: true
        });
      }
    }

    comeback(info, inactive) {
      var increment = info.increment;
      if (!inactive && increment * 100 >= 0.01 && this.unit.isPlayer) {
        this.unit.addLabel({
          text: '+' + (increment * 100).toFixed(2) + '%',
          color: this.unit.skin.colors.nick,
          unit: this.unit,
          time: 1000,
          fading: true
        });
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Units
  // ---------------------------------------------------------------------------------------------

  class GameUnit {
    constructor(game, name, position, basePoints, unusedFifth, schemesManager) {
      this.killer = void 0;
      this.skin = void 0;
      this.death = void 0;
      this.jitter = void 0;
      this.smoothness = void 0;
      this.type = void 0;
      this.fsm = void 0;
      this.game = game;
      this.name = name;
      this.position = position;
      this.base = new P.TerritoryBase(this, basePoints);
      this.track = new P.UnitTrack(this);
      this.lastSquare = this.base.square;
      this.in = this.base;
      this.target = null;
      this.respawn = false;
      this.statistics = { kills: 0 };
      this.log = [];
      this.bornTime = currentTimeMs();
      this.labels = [];
      this.percent = 0;
      this.bestPercent = 0;
      this.scale = 0;
      this.visionRange = 1;
      this.direction = 0;
      this.top = 0;
      this.scores = { accumulator: 0, kills: 0 };
      this.schemes = schemesManager && schemesManager.getSchemes(this);
      this.baseDistance = 0;
      this.baseNearestPoint = null;
      this.baseNearestPointTangent = null;
      this.baseNearestPointNormal = null;
    }

    get isPlayer() {
      return false;
    }

    setSkin(skin) {
      this.skin = skin;
      skin.user = this;
    }

    // indexOf is -1 for a unit already spliced out, which also passes, so a death always flags the list.
    onScoreChanged() {
      if (this.game.units.indexOf(this) <= 5 || this.isPlayer) this.game.topListChanged = true;
    }

    update(dtMs) {
      this.log.push(this.position);
      var away = this.in !== this.base;
      if (away) {
        this.scores.accumulator += (this.percent * 100 * dtMs) / 1000;
      }

      var nearestDist = 0;
      var nearestPoint = null;
      var tangent = null;
      if (away) {
        // Nearest VERTEX of the simplified outline; strict less-than so the first minimum wins.
        nearestDist = Infinity;
        var nearestIndex = 0;
        var outline = this.base.polygon.simplify;
        var here = this.position;
        outline.forEach(function (vertex, i) {
          var d2 = vertex.distanceSq(here);
          if (d2 < nearestDist) {
            nearestDist = d2;
            nearestPoint = vertex;
            nearestIndex = i;
          }
        });
        var before = outline[nearestIndex > 0 ? nearestIndex - 1 : outline.length - 1];
        var after = outline[nearestIndex < outline.length - 1 ? nearestIndex + 1 : 0];
        tangent = after.clone().sub(before).normalize();
      }
      nearestDist = Math.sqrt(nearestDist);

      this.baseDistance = nearestDist;
      this.baseNearestPoint = nearestPoint;
      this.baseNearestPointTangent = tangent;
      this.baseNearestPointNormal = tangent && tangent.clone().rotate(-Math.PI / 2);
    }

    movement() {
      return this.target && this.target.clone().sub(this.position).normalize();
    }

    addLabel(spec) {
      if (!spec.unit) spec.unit = this;
      this.labels.push(spec);
    }
  }

  class PlayerUnit extends GameUnit {
    constructor(game, name, position, basePoints, unusedFifth, schemesManager) {
      super(game, name, position, basePoints, unusedFifth, schemesManager);
      this.win = false;
    }

    get isPlayer() {
      return true;
    }

    update(dtMs) {
      super.update(dtMs);
      if (!this.respawn) {
        // game.angle is the pointer heading quantised to 254 steps; the target sits 50 units ahead.
        this.target = new P.Vec2(1, 0)
          .rotate((this.game.angle * Math.PI) / 127)
          .mulScalar(50)
          .add(this.position);
      }
    }
  }

  class BotUnit extends GameUnit {
    constructor(game, type, name, position, basePoints, unusedSixth, schemesManager) {
      super(game, name, position, basePoints, unusedSixth, schemesManager);
      this.aggro = 0;
      this.greed = 0;
      this.safety = 0;
      this.def = 0;
      this.type = type;
      // First game.rng draw of a bot's life. The state machine below makes the rest as it boots.
      this.jitter = 0.1 * (2 * this.game.rng() - 1);
      this.targets = [];
      this.smoothness = 1;
      this.maxDanger = 0;
      this.unitDanger = null;
      this.fsm = new P.StateMachine(P.botBrainStates, 'idle', this);
    }

    update(dtMs) {
      super.update(dtMs);
      this.unitToTrackDistances = [];
      var worstDanger = 0;
      var worstDistance = 0;
      var worstUnit = null;

      if (this.in !== this.base) {
        var self = this;
        var player = this.game.player;
        this.game.units.forEach(function (other) {
          // Only the player can hide beyond vision range; other bots are sensed at any distance.
          var hiddenPlayer = player === other && self.position.distance(other.position) > self.visionRange;
          if (other === self || hiddenPlayer) return;

          var reach = Infinity;
          var reachPoint = null;
          self.track.simplified.forEach(function (tailVertex) {
            var d2 = tailVertex.distanceSq(other.position);
            if (d2 < reach) {
              reach = d2;
              reachPoint = tailVertex;
            }
          });
          reach = Math.sqrt(reach);

          var danger = self.baseDistance / reach;
          self.unitToTrackDistances.push({
            unit: other,
            trackDistance: reach,
            trackPoint: reachPoint,
            danger: danger
          });
          if (danger > worstDanger) {
            worstUnit = other;
            worstDistance = reach;
            worstDanger = danger;
          }
        });
      }

      this.unitDanger = worstUnit;
      this.distanceDanger = worstDistance;
      this.maxDanger = worstDanger;
      this.smoothness = 1;
      this.fsm.update();
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Floating text above a unit ("+0.42%", kill text)
  // ---------------------------------------------------------------------------------------------

  class FloatingLabel {
    // position and velocity are kept by reference on purpose: the game shares one velocity vector
    // between labels made in the same tick, and that coupling is part of the visible motion.
    constructor(text, color, unit, position, velocity, duration, fading) {
      if (position === undefined) position = new P.Vec2(0, 0);
      if (velocity === undefined) velocity = new P.Vec2(0, -50);
      if (duration === undefined) duration = 2000;
      if (fading === undefined) fading = true;
      this.text = text;
      this.color = color || '#000000';
      this.unit = unit;
      this.position = position;
      this.velocity = velocity;
      this.acceleration = velocity.clone().mulScalar(-2000 / duration);
      this.duration = duration;
      this.time = duration;
      this.fading = fading;
    }

    update(dtMs) {
      this.time -= dtMs;
      if (this.time > 0) {
        this.velocity.add(this.acceleration.clone().mulScalar(dtMs / 1000));
        this.position.add(this.velocity.clone().mulScalar(dtMs / 1000));
      }
    }

    draw(ctx, fontFamily, viewScale, screenScaler) {
      // Quintic ease out, multiplied left to right after the pre-decrement.
      var k = this.time / this.duration;
      var eased = 1 + --k * k * k * k * k;
      var alphaHex = Math.floor(eased * 255).toString(16);
      if (alphaHex.length < 2) {
        alphaHex = '0' + alphaHex;
      }
      var at = this.unit ? this.unit.position.clone().add(this.position) : this.position;
      var dpr = window.devicePixelRatio;
      var fontPx = (30 * screenScaler) / dpr;
      ctx.save();
      ctx.fillStyle = '' + this.color + (this.fading ? alphaHex : '');
      ctx.font = 'bold ' + fontPx + 'px ' + fontFamily;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.text, at.x * viewScale, at.y * viewScale);
      ctx.restore();
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Bot names
  // ---------------------------------------------------------------------------------------------

  class RandomNamePool {
    constructor(names, seed) {
      this.pool = names;
      this.rng = P.createSeededRng(seed);
    }

    // The name stays in the pool, so two live bots can share one.
    get() {
      var roll = this.rng();
      return this.pool[~~(roll * this.pool.length)];
    }

    available() {
      return true;
    }

    release(names) {
      this.pool.push.apply(this.pool, names);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Best score. Only the number is stored, under our own key. Every access is guarded because storage can be blocked.
  // ---------------------------------------------------------------------------------------------

  var BEST_SCORE_KEY = 'duelseries.paper.best';

  var bestScoreStorage = {
    key: BEST_SCORE_KEY,

    load: function () {
      try {
        var raw = root.localStorage.getItem(BEST_SCORE_KEY);
        var parsed = raw === null ? 0 : JSON.parse(raw);
        return (typeof parsed === 'number' && isFinite(parsed) && parsed) || 0;
      } catch (err) {
        return 0;
      }
    },

    save: function (score) {
      try {
        root.localStorage.setItem(BEST_SCORE_KEY, JSON.stringify(score));
        return true;
      } catch (err) {
        return false;
      }
    },

    // Only a result flagged newBest replaces the stored best.
    record: function (results, currentBest) {
      if (results && results.newBest) {
        bestScoreStorage.save(results.score);
        return results.score;
      }
      return currentBest;
    }
  };

  // Shipped bot names: our own list. The name rng indexes into whatever list is in use, so a page may
  // install its own list on DuelPaperLib.botNames BEFORE this file loads.
  var DEFAULT_BOT_NAMES = [
    "PixelDrifter", "MossyBoots", "TurboSnail", "QuietComet", "LuckyPebble", "NeonOtter",
    "CosmicToast", "WobblyKite", "BraveNoodle", "SleepyFalcon", "RapidWalnut", "SunnyBadger",
    "FrostyMango", "MellowYeti", "GiddyPenguin", "SwiftAcorn", "CleverMoth", "JollyAnvil",
    "DizzyLlama", "HappyGlacier", "BouncyFern", "MightyPickle", "SilentWaffle", "ZippyTurnip",
    "CozyDragon", "FuzzyRocket", "NimbleGoose", "PlaidPanda", "RustyLantern", "VelvetHammer",
    "CrispyCloud", "GentleViper", "WanderingOak", "LoopyHeron", "SnappyBiscuit", "BoldRaccoon",
    "TinyThunder", "MintyWhale", "CopperFinch", "DapperMole", "GlowingReef", "HumbleKraken",
    "IvoryLynx", "JadeSparrow", "KeenMarmot", "LilacBison", "MapleGhost", "NovaHedgehog",
    "OpalCricket", "PepperWolf", "QuirkyOrbit", "RubyTortoise", "SaffronCrow", "TealMantis",
    "UmberStag", "VividNewt", "WillowShark", "AmberJackal", "BreezyCobra", "CinderHare",
    "DuskyPuffin", "EmberQuail", "FableWombat", "GraniteSwan", "HazelIbis", "InkyGecko",
    "JumpyCapybara", "KindlyOx", "LunarFerret", "MarbleToad", "NuttyOsprey", "OliveStoat",
    "PrismBeetle", "QuillRaven", "RippleDeer", "StormyKoala", "TidalLemur", "BurrowGopher",
    "VelvetOtter", "WaffleKnight", "ZestyLobster", "AstroPancake", "BubbleWizard", "CaptainSprout",
    "DoodleMaster", "EchoRanger", "FlipSwitch", "GizmoPilot", "HyperMuffin", "IcicleScout",
    "JellyBandit", "KiteChaser", "LaserTurtle", "MuffinRaider", "NoodleNinja", "OrbitSurfer",
    "PuddleJumper", "QuestSeeker", "RocketGardener", "SockPuppeteer", "TrailBlazerX", "UpsideClown",
    "VortexBaker", "WidgetHunter", "YonderSailor", "ZigZagZebra", "PaperPlanner", "InkSplash",
    "GridWalker", "LineDancer", "SquareRoot", "BlockHopper", "TileTamer", "CornerCutter",
    "LoopCloser", "EdgeSkater", "PathPainter", "ZoneKeeper", "TrailWeaver", "FieldSketcher",
    "MapDoodler", "AreaFiller", "BorderHopper", "ColorSweeper", "TerraTracer", "quiet_storm",
    "lazy_river", "tiny_titan", "moon_gazer", "sky_pirate", "pixel_pony", "soft_thunder",
    "late_bloomer", "night_baker", "salty_pretzel", "cosmic_clam", "fuzzy_logic", "rubber_anchor",
    "velvet_fog", "paper_tiger", "glass_canoe", "iron_daisy", "copper_kettle", "silver_spoonbill",
    "wooden_whistle", "happy_camper", "swift_current", "calm_tempest", "bright_shadow", "frozen_ember",
    "polar_picnic", "desert_pearl", "forest_echo", "river_stone", "mountain_mint", "candy_comet",
    "turbo_turtle", "mellow_marmot", "sneaky_sandwich", "brave_biscuit", "grumpy_cactus", "jolly_juniper",
    "witty_walrus", "zesty_zucchini", "nimble_narwhal", "peppy_parrot", "rowdy_radish", "sleepy_sloth",
    "tricky_trout", "upbeat_urchin", "vivid_vole", "wacky_wren", "yawning_yak", "zippy_zephyr",
    "amber_wave", "blue_lantern", "crimson_kite", "dusty_trail", "emerald_moth", "faded_map",
    "golden_gear", "hollow_log", "indigo_dust", "jade_river", "kind_stranger", "lost_sock",
    "misty_harbor", "north_wind", "open_window", "plain_bagel", "quick_sketch", "round_pebble",
    "slow_orbit", "tall_grass", "under_the_stairs", "violet_hour", "warm_static", "extra_cheese",
    "young_oak", "zero_gravity", "last_pixel", "first_light", "second_wind", "third_wheel",
    "lucky_seven", "double_rainbow", "triple_scoop", "half_moon", "full_tilt", "side_quest",
    "boss_level", "spare_key", "loose_change", "open_road", "soft_reset", "hard_mode",
    "save_point", "bonus_round", "final_lap", "speed_run", "high_tide", "low_battery",
    "no_signal", "good_game", "Pip", "Zed", "Bex", "Kip",
    "Rook", "Wisp", "Flint", "Sable", "Onyx", "Quill",
    "Fern", "Dash", "Blip", "Mote", "Glim", "Vex",
    "Drift", "Ember", "Frost", "Gale", "Haze", "Jolt",
    "Knot", "Loom", "Mist", "Nook", "Oak", "Plum",
    "Quirk", "Reef", "Spark", "Thorn", "Umbra", "Vale",
    "Wren", "Yonder", "Zest", "Birch", "Cobalt", "Echo",
    "Fable", "Glint", "Husk", "Ivy", "Jet", "Kelp",
    "Lark", "Moss", "Nimbus", "Opal", "Pebble", "Rune",
    "Slate", "Vapor", "Wick", "Zephyr", "Pixel42", "Otter77",
    "Rook88", "Comet9", "Turbo3000", "Nova21", "Frosty5", "Glitch404",
    "Byte64", "Quark12", "Badger23", "Waffle101", "Sprout7", "Lantern16",
    "Panda808", "Falcon31", "Noodle55", "Marble19", "Acorn2k", "Yeti360",
    "Gecko14", "Kite28", "Mango6", "Drift99", "Spark11", "Wisp33",
    "Pebble4", "Orbit50", "Tofu22", "Pickle13", "Biscuit8", "Cactus17",
    "Moth45", "Heron29", "Lynx72", "Walnut10", "Zebra66", "Cricket38",
    "Puffin51", "Ferret93"
  ];

  P.makeUnitSquarePath = makeUnitSquarePath;
  P.Particle = Particle;
  P.spawnDeathParticles = spawnDeathParticles;
  P.ScoreSchemeManager = ScoreSchemeManager;
  P.UnitScoreSchemes = UnitScoreSchemes;
  P.BaseScoreScheme = BaseScoreScheme;
  P.PercentScoreScheme = PercentScoreScheme;
  P.GameUnit = GameUnit;
  P.PlayerUnit = PlayerUnit;
  P.BotUnit = BotUnit;
  P.FloatingLabel = FloatingLabel;
  P.RandomNamePool = RandomNamePool;
  P.botNames = P.botNames || DEFAULT_BOT_NAMES;
  P.bestScoreStorage = bestScoreStorage;
})(typeof window !== 'undefined' ? window : globalThis);
