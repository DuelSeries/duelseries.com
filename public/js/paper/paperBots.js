(function (root) {
  'use strict';
  var P = root.DuelPaperLib = root.DuelPaperLib || {};

  // Unclamped on purpose: the "back" state feeds it t >= 1 and relies on the overshoot.
  function mix(from, to, t) {
    return from + (to - from) * t;
  }

  // Tiny state machine. A transition runs the new state's update straight away,
  // so several states can chain inside one tick.
  class StateMachine {
    constructor(table, initialName, payload) {
      this.states = table;
      this.state = '';
      this.payload = payload;
      this.context = {};
      this.change(initialName);
    }

    change(name) {
      const current = this.states[this.state];
      if (current && current.leave) {
        this.context = current.leave(this.payload, this.context) || this.context;
      }
      const next = this.states[name];
      if (next) {
        this.state = name;
        this.context = (next.enter && next.enter(this.payload, this.context)) || this.context;
        this.update();
      }
    }

    update() {
      const active = this.states[this.state];
      const wanted = active && active.update(this.payload, this.context);
      wanted && this.change(wanted);
    }
  }

  // True when any vertex of the player's simplified trail is inside the bot's aggro radius.
  // Falls through to undefined otherwise (callers only test truthiness).
  function isPlayerTrackInAggroRange(bot) {
    const player = bot.game.player;
    if (player) {
      const viewRange = Math.max(bot.visionRange, player.visionRange);
      const reach = viewRange * bot.aggro * 0.75;
      const trail = player.track.simplified;
      for (let i = 0, n = trail.length; i < n; i++) {
        if (bot.position.distanceSq(trail[i]) < reach * reach) {
          return true;
        }
      }
    }
  }

  function isBotEndangered(bot) {
    if (bot.in === bot.base) {
      return false;
    }
    return bot.maxDanger > 0.8 * bot.def;
  }

  const STEER_STEP = 25;

  const botBrainStates = {
    idle: {
      enter: function () {
        return {};
      },
      update: function (bot) {
        if (bot.in === bot.base) {
          return bot.game.rng() < 0.25 ? 'cut' : 'exit';
        }
        return 'back';
      },
    },

    // Leave the base along the ray that points straight away from the arena centre.
    cut: {
      enter: function (bot) {
        const game = bot.game;
        const outward = bot.position.clone().sub(game.space.center);
        const rayEnd = outward
          .normalize()
          .mulScalar(game.border.radius + 10)
          .add(game.space.center);
        const ray = new P.Segment(bot.position, rayEnd);
        const hits = bot.base.polygon.intersections(ray);
        const ctx = {};
        hits.sort((a, b) => a.distance - b.distance);
        ctx.exitPoint = hits[0] && hits[0].point;
        return ctx;
      },
      update: function (bot, ctx) {
        if (bot.in !== bot.base) {
          return 'capture';
        }
        const centerDist = bot.position.distance(bot.game.space.center);
        const wallGap = bot.game.border.radius - centerDist;
        if (!ctx.exitPoint || wallGap < 1) {
          return 'idle';
        }
        bot.target = ctx.exitPoint;
      },
    },

    // Leave the base through one of its (full polygon) vertices.
    exit: {
      enter: function (bot) {
        const ctx = {};
        let bestDist = Infinity;
        let bestIdx;
        const segs = bot.base.polygon.segments;
        const count = segs.length;
        let threshold = bot.game.config.unitSpeed;
        ctx.minDistance = threshold;
        // One rng draw per attempt; the threshold decays until a vertex is far enough.
        while (bestIdx === undefined) {
          const idx = ~~(bot.game.rng() * count);
          const vertex = bot.base.polygon.segments[idx].start;
          const dist = vertex.distance(bot.position);
          if (dist < bestDist && dist > threshold) {
            bestDist = dist;
            bestIdx = idx;
          }
          threshold *= 0.75;
        }
        ctx.exitPoint = bot.base.polygon.segments[bestIdx].start;
        return ctx;
      },
      update: function (bot, ctx) {
        if (bot.in !== bot.base) {
          return 'capture';
        }
        if (isPlayerTrackInAggroRange(bot)) {
          return 'attack';
        }
        const count = bot.base.polygon.segments.length;
        const minDistance = ctx.minDistance;
        const idx = ~~(bot.game.rng() * count);
        const candidate = bot.base.polygon.segments[idx].start;
        const candidateDist = candidate.distance(bot.position);
        const currentDist = ctx.exitPoint.distance(bot.position);
        if (candidateDist > minDistance && candidateDist < currentDist) {
          ctx.exitPoint = candidate;
        } else {
          // The remembered vertex may have been cut out of the base since it was picked.
          const stillOnBase = Object.values(ctx.exitPoint.segments).some(
            (seg) => seg && seg.shape === bot.base.polygon
          );
          if (!stillOnBase) {
            ctx.exitPoint = candidate;
          }
          if (
            bot.target &&
            bot.target.distance(bot.game.space.center) > bot.game.border.radius - 1
          ) {
            ctx.exitPoint = candidate;
          }
        }
        bot.target = ctx.exitPoint;
      },
    },

    // Circle outside the base, re-planning a target 25 units ahead each tick.
    capture: {
      update: function (bot) {
        if (bot.in === bot.base) {
          return 'idle';
        }
        if (isPlayerTrackInAggroRange(bot)) {
          return 'attack';
        }
        const unitSpeed = bot.game.config.unitSpeed;
        const center = bot.game.space.center;
        const radius = bot.game.border.radius;
        const centerDist = bot.position.distance(center);
        const wallGap = radius - centerDist;
        if (bot.baseDistance < unitSpeed / 4 && bot.track.length > unitSpeed * 2 && wallGap > 10) {
          return 'back';
        }
        const step = STEER_STEP;
        const halfStep = step / 2;
        const halfStepSq = halfStep * halfStep;
        // Hold rule: keep the current target while the bot is still close to it.
        if (bot.position.distanceSq(bot.target) < halfStepSq && wallGap > step) {
          return;
        }

        // Shoelace sum over the simplified trail, closed through the nearest base vertex.
        const trail = bot.track.simplified;
        let areaSum = 0;
        for (let i = 1, n = trail.length; i < n; i++) {
          const prev = trail[i - 1];
          const cur = trail[i];
          areaSum += (prev.x + cur.x) * (cur.y - prev.y);
        }
        let edgeFrom = bot.track.simplified[bot.track.simplified.length - 1];
        let edgeTo = bot.baseNearestPoint;
        areaSum += (edgeFrom.x + edgeTo.x) * (edgeTo.y - edgeFrom.y);
        edgeFrom = bot.baseNearestPoint;
        edgeTo = bot.track.simplified[0];
        areaSum += (edgeFrom.x + edgeTo.x) * (edgeTo.y - edgeFrom.y);
        const winding = Math.sign(areaSum);
        areaSum = Math.abs(areaSum / 2);
        bot.capSquare = areaSum;

        // Four "time to go home" pressures; the worst one decides.
        const def = bot.def;
        const greed = bot.greed;
        const safety = bot.safety;
        const maxTrackLen = 2 * Math.PI * bot.visionRange * greed;
        const lenRatio = bot.track.length / maxTrackLen;
        const maxArea = Math.min(bot.base.square, Math.PI * bot.visionRange * bot.visionRange) * greed;
        const areaRatio = bot.capSquare / maxArea;
        const maxStartDist = bot.visionRange * mix(3, 0.7, safety);
        const startRatio = bot.position.distance(bot.track.polyline.start) / maxStartDist;
        const safeDist =
          bot.unitToTrackDistances.reduce(
            (acc, entry) => Math.min(entry.trackDistance, acc),
            Infinity
          ) *
          0.8 *
          def;
        const enemyRatio = bot.baseDistance / safeDist;
        const worst = Math.max(lenRatio, areaRatio, startRatio, enemyRatio);
        if (worst > 1) {
          return 'back';
        }

        const farBand = bot.visionRange * greed;
        const nearBand = farBand * 0.8;
        const oldHeading = bot.target.clone().sub(bot.position);
        let steer;
        if (bot.baseDistance > farBand || worst > 0.75) {
          bot.aspect = 'approach';
          steer = bot.baseNearestPointNormal
            .clone()
            .mulScalar(step)
            .rotate((Math.PI / 2 + Math.PI / 4) * winding);
        } else if (bot.baseDistance < nearBand) {
          bot.aspect = 'retreat';
          let awayAngle = Math.PI / 4;
          const trackVsNear = bot.track.length / nearBand;
          if (trackVsNear < 1) {
            bot.aspect = 'breakout';
            awayAngle = mix((Math.PI / 2) * greed, 0, trackVsNear);
          }
          steer = bot.baseNearestPointNormal
            .clone()
            .mulScalar(step)
            .rotate((Math.PI / 2 - awayAngle) * winding);
        } else {
          bot.aspect = 'pass';
          steer = bot.baseNearestPointNormal
            .clone()
            .mulScalar(step)
            .rotate((Math.PI / 2) * winding);
          bot.smoothness = 1 + 3 * (1 - Math.min(1, bot.maxDanger));
        }
        // This assignment always wins over the one in the last branch above.
        bot.smoothness = 1 + 1 * (1 - Math.min(1, bot.maxDanger));

        // Near the wall: mirror the steer vector to the side the bot was already heading,
        // and keep it at least 45 degrees off the radial.
        if (
          wallGap < step * 2 &&
          wallGap > step / 4 &&
          wallGap < bot.position.clone().add(steer).distance(center)
        ) {
          const radial = bot.position.clone().sub(center);
          const headingAngle = radial.angle(oldHeading);
          const headingSign = Math.sign(headingAngle);
          let steerAngle = radial.angle(steer);
          let steerSign = Math.sign(steerAngle);
          if (headingSign !== steerSign) {
            steerAngle *= -1;
            steerSign *= -1;
            steer.rotate(2 * steerAngle);
          }
          const steerAngleAbs = Math.abs(steerAngle);
          if (steerAngleAbs < Math.PI / 4) {
            steer.rotate((Math.PI / 4 - steerAngleAbs) * steerSign);
          }
        }

        bot.target = bot.position.clone().add(steer);

        // Target well past the wall: aim at the crossing of the wall circle and a
        // radius-25 circle around the bot. The rotations use the raw, unnormalised angle.
        if (bot.target.distance(center) > radius + step * 0.75) {
          const radial = bot.position.clone().sub(center);
          const headingAngle = radial.angle(oldHeading);
          const d = centerDist;
          const footDist = (radius * radius - step * step + d * d) / (2 * d);
          const halfChord = Math.sqrt(radius * radius - footDist * footDist);
          const radialUnit = bot.position.clone().sub(center).normalize();
          const foot = center.clone().add(radialUnit.clone().mulScalar(footDist));
          steer = radialUnit
            .clone()
            .rotate((Math.PI / 2) * headingAngle)
            .rotate((Math.PI / 8) * -headingAngle)
            .mulScalar(halfChord);
          bot.target = foot.clone().add(steer);
        }
      },
    },

    back: {
      enter: function () {},
      update: function (bot) {
        if (bot.in === bot.base) {
          return 'idle';
        }
        bot.smoothness = mix(
          1,
          Math.max(1, Math.max(1, 4 * Math.min(bot.def, bot.greed))),
          Math.max(1, bot.maxDanger)
        );
        const wallGap = bot.game.border.radius - bot.position.distance(bot.game.space.center);
        if (wallGap < 20) {
          bot.smoothness = 1;
        }
        bot.target = bot.baseNearestPoint;
      },
    },

    // Chase the nearest vertex of the player's simplified trail.
    attack: {
      enter: function () {
        return {};
      },
      update: function (bot) {
        const player = bot.game.player;
        if (!player || player.death) {
          return 'idle';
        }
        const trail = player.track.simplified;
        if (!trail.length) {
          return 'idle';
        }
        if (player.track.length < bot.game.config.botAttackTrackLength && isBotEndangered(bot)) {
          return 'idle';
        }
        let nearestIdx = 0;
        let nearestDistSq = Infinity;
        trail.forEach((point, idx) => {
          const distSq = bot.position.distanceSq(point);
          if (distSq < nearestDistSq) {
            nearestDistSq = distSq;
            nearestIdx = idx;
          }
        });
        bot.target = trail[nearestIdx];
      },
    },
  };

  P.StateMachine = StateMachine;
  P.isPlayerTrackInAggroRange = isPlayerTrackInAggroRange;
  P.isBotEndangered = isBotEndangered;
  P.botBrainStates = botBrainStates;
})(typeof window !== 'undefined' ? window : globalThis);
