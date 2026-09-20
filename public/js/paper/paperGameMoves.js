(function (root) {
  'use strict';
  var P = root.DuelPaperLib = root.DuelPaperLib || {};

  // Shared geometric tolerance (2^-26), same value the geometry module uses.
  var TOLERANCE = Math.pow(2, -26);
  var FULL_TURN = Math.PI * 2;

  // Kill reasons used by the capture step.
  var REASON_EXIT_POINT_CAPTURED = 4;
  var REASON_ENCIRCLED = 5;

  function nearZero(value) {
    return Math.abs(value) <= TOLERANCE;
  }

  function closeTo(left, right) {
    return Math.abs(left - right) <= TOLERANCE;
  }

  // Pooled vectors are only an allocation saving, so fall back to plain ones.
  function borrowVec(x, y) {
    var V = P.Vec2;
    return typeof V.alloc === 'function' ? V.alloc(x, y) : new V(x, y);
  }

  function giveBack(vec) {
    if (typeof vec.release === 'function') vec.release();
  }

  // Unit vector for a heading in radians. The vector setter folds -0 into 0,
  // so plain cos / sin is bit-identical to rotating (1, 0) by the heading.
  function headingVec(angle) {
    return borrowVec(Math.cos(angle), Math.sin(angle));
  }

  // Signed angle that turns `from` onto `to`, in (-PI, PI].
  function signedTurn(from, to) {
    return Math.atan2(from.x * to.y - to.x * from.y, from.x * to.x + from.y * to.y);
  }

  function viewCentre(view) {
    return new P.Vec2(view.clientWidth / 2, view.clientHeight / 2);
  }

  var gameMoves = {
    // One tick of steering plus travel for a unit, clipped against the arena
    // wall. Returns the straight pieces travelled, in order.
    getMovement: function (dtMs, unit) {
      var speed = this.config.unitSpeed;
      var pieces = [];
      var wanted = unit.movement();
      if (!wanted) return pieces;
      wanted.mulScalar((speed * dtMs) / 1000);

      var facing = headingVec(unit.direction);
      var turn = signedTurn(facing, wanted);
      giveBack(facing);
      var turnCap = (FULL_TURN * dtMs) / 1000 / (unit.smoothness || 1);
      if (Math.abs(turn) > turnCap) {
        turn = turnCap * Math.sign(turn);
      }
      unit.direction += turn;

      var stride = headingVec(unit.direction).mulScalar((speed * dtMs) / 1000);
      var piece = new P.Segment(unit.position, unit.position.clone().add(stride));
      giveBack(stride);

      var wallHits = this.border.intersections(piece);
      while (wallHits.length) {
        var travel = piece.vector;
        var picked;
        if (wallHits.length === 2) {
          // Two wall edges hit at once (a corner): take the one we lean out of.
          var firstLean = signedTurn(travel, wallHits[0].segment.vector);
          picked = firstLean > 0 ? wallHits[0] : wallHits[1];
        } else {
          picked = wallHits[0];
        }
        var wallEdge = picked.segment.vector;
        var touch = picked.point;
        var lean = signedTurn(travel, wallEdge);
        if (lean < 0) {
          // Heading back inside across this edge, nothing to clip.
          break;
        }
        if (!nearZero(picked.distance)) {
          pieces.push(new P.Segment(piece.start, touch));
        }
        // Whatever is left of the step gets projected onto the wall edge.
        piece = new P.Segment(touch, piece.end);
        var leftover = piece.vector;
        var slide = borrowVec(wallEdge.x, wallEdge.y)
          .normalize()
          .mulScalar(leftover.dot(wallEdge) / wallEdge.magnitude());
        piece = new P.Segment(touch, touch.clone().add(slide));
        giveBack(slide);
        wallHits = this.border.intersections(piece);
      }
      pieces.push(piece);
      return pieces;
    },

    // Controller state to game.direction (a unit Vec2).
    readInput: function (dtMs) {
      var pad = this.controller;
      if (!pad) return;
      if (pad.pressed()) {
        // Remember where the pointer sat so it only takes over again once it moves.
        this.keyboard = Object.assign({}, pad.mouse);
        var keyTurnCap = (FULL_TURN * dtMs) / 1000;
        var pushed = new P.Vec2();
        if (pad.up) pushed.add(new P.Vec2(0, -1));
        if (pad.down) pushed.add(new P.Vec2(0, 1));
        if (pad.left) pushed.add(new P.Vec2(-1, 0));
        if (pad.right) pushed.add(new P.Vec2(1, 0));
        if (pushed.magnitude()) {
          var keyTurn = signedTurn(this.direction, pushed);
          if (Math.abs(keyTurn) > keyTurnCap) {
            keyTurn = Math.sign(keyTurn) * keyTurnCap;
          }
          this.direction.rotate(keyTurn);
        }
      } else if (pad.mouse) {
        var held = this.keyboard;
        if (!held || (held.x !== pad.mouse.x && held.y !== pad.mouse.y)) {
          this.keyboard = null;
          this.direction = new P.Vec2(pad.mouse.x, pad.mouse.y).sub(viewCentre(this.view)).normalize();
        }
      } else if (!this.keyboard && pad.lastMouse) {
        this.direction = new P.Vec2(pad.lastMouse.x, pad.lastMouse.y).sub(viewCentre(this.view)).normalize();
      }
    },

    // Safety net: player flagged as home while geometrically outside its base.
    // Push it one unit past the nearest base vertex and wipe the trail.
    recoverTail: function () {
      var me = this.player;
      if (!me || me.in != me.base || me.base.polygon.inside(me.position)) return;
      var here = me.position;
      // On an exact tie the later segment wins (strict less-than keeps the earlier).
      var nearest = me.base.polygon.segments.reduce(function (best, cand) {
        return best.start.distanceSq(here) < cand.start.distanceSq(here) ? best : cand;
      });
      var toVertex = nearest.start.clone().sub(me.position);
      var gap = toVertex.magnitude();
      me.position = toVertex.mulScalar(1 + 1 / gap).add(me.position);
      me.track.remove();
    },

    // A unit's trail has come back to its own base: merge the enclosed area,
    // kill whoever got enclosed, then carve the crossed enemy bases.
    handleReturn: function (unit) {
      if (unit.death) return;
      var game = this;
      this.events.returns++;

      var trail = unit.track.polyline.clone();
      var home = unit.base;
      var ring = home.polygon;
      var trailFirst = trail.start;
      var trailLast = trail.end;
      var fromIdx = ring.segments.findIndex(function (seg) { return seg.start === trailFirst; });
      var toIdx = ring.segments.findIndex(function (seg) { return seg.start === trailLast; });
      var lo = Math.min(toIdx, fromIdx);
      var hi = Math.max(toIdx, fromIdx);
      if (lo !== fromIdx) {
        trail.reverse();
      }

      var trailPts = trail.points();
      var ringViaTrail = ring.points();
      var loopPts = ringViaTrail.splice.apply(ringViaTrail, [lo, hi - lo + 1].concat(trailPts));
      loopPts.shift();
      loopPts.pop();
      loopPts.reverse();
      loopPts.push.apply(loopPts, trailPts);
      var loop = new P.Polygon(loopPts);

      var gained;
      if (loop.rawSquare() < 0) {
        // The trail went round the far side: the gain is the other ring.
        gained = new P.Polygon(ringViaTrail.reverse());
        ring.unsplice(trail, lo, hi);
      } else {
        gained = loop;
        ring.splice(trail, lo, hi);
      }
      home.square += gained.square();
      ring.calcPath();

      this.units
        .filter(function (other) { return other !== unit; })
        .forEach(function (other) {
          if (other.death) return;
          if (other.in === other.base && gained.inside(other.position)) {
            game.kill(other, unit, REASON_ENCIRCLED);
          }
          if (other.track.polyline.start && gained.inside(other.track.polyline.start)) {
            game.kill(other, unit, REASON_EXIT_POINT_CAPTURED);
          }
        });

      var victims = [];

      // Removes from an enemy base the side of the cut that its owner is not on.
      function carve(cut) {
        var owner = cut.owner;
        var enterSeg = cut.enter;
        var leaveSeg = cut.leave;
        if (enterSeg.shape !== owner.polygon) {
          enterSeg = owner.polygon.segments.find(function (seg) { return seg.start === cut.startPoint; });
        }
        if (leaveSeg.shape !== owner.polygon) {
          leaveSeg = owner.polygon.segments.find(function (seg) { return seg.start === cut.endPoint; });
        }
        if (enterSeg === leaveSeg) return;

        var chord = unit.track.polyline.points().splice(cut.startT, cut.endT - cut.startT + 1);
        var enterIdx = owner.polygon.segments.findIndex(function (seg) { return seg === enterSeg; });
        var leaveIdx = owner.polygon.segments.findIndex(function (seg) { return seg === leaveSeg; });
        var cutLo = Math.min(leaveIdx, enterIdx);
        var cutHi = Math.max(leaveIdx, enterIdx);
        if (cutLo !== enterIdx) {
          chord.reverse();
        }
        var restPts = owner.polygon.points();
        var arcPts = restPts.splice.apply(restPts, [cutLo, cutHi - cutLo + 1].concat(chord));
        arcPts.shift();
        arcPts.pop();
        arcPts.push.apply(arcPts, chord.slice().reverse());
        var arcSide = new P.Polygon(arcPts);
        var restSide = new P.Polygon(restPts);

        var enemy = owner.unit;
        var lost;
        if (
          (enemy.in === enemy.base && arcSide.inside(enemy.position)) ||
          (enemy.in !== enemy.base && arcSide.inside(enemy.track.polyline.start))
        ) {
          owner.polygon.right(chord, cutLo, cutHi);
          lost = restSide;
        } else {
          owner.polygon.left(chord, cutLo, cutHi);
          lost = arcSide;
        }
        owner.square -= lost.square();
        owner.polygon.calcPath();
        victims.push({ base: owner, poly: lost });
        game.units.forEach(function (bystander) {
          if (owner.unit !== bystander && bystander.in === owner && lost.inside(bystander.position)) {
            bystander.in = null;
          }
        });
      }

      // Walk the ORIGINAL trail (still committed) vertex by vertex.
      var carried = [];
      var trailSegs = unit.track.polyline.segments;
      var segCount = trailSegs.length;
      for (var i = 0; i <= segCount; i++) {
        var vertex = i === segCount ? trailSegs[i - 1].end : trailSegs[i].start;
        var foreign = vertex.segments.filter(function (seg) {
          return seg.shape.owner !== unit.track && seg.shape.owner !== unit.base && seg.start === vertex;
        });
        if (!foreign.length) continue;

        var here = foreign.map(function (seg) {
          return { owner: seg.shape.owner, point: vertex, segment: seg, index: i };
        });

        if (!carried.length) {
          var seedLog = unit.track.intersections.find(function (rec) { return rec.point.equal(vertex); });
          if (!seedLog) {
            // No crossing logged here: give up on cuts, "in" updates and scoring.
            return false;
          }
          carried = here.filter(function (hit) {
            var logged = seedLog.intersections.filter(function (entry) { return entry.base === hit.owner; });
            if (!logged.length) return false;
            return logged[logged.length - 1].enter;
          });
        } else {
          var matched = carried.filter(function (prev) {
            return here.some(function (cur) { return cur.owner === prev.owner; });
          });
          if (matched.length) {
            var entered = matched[0];
            var left = here.find(function (cur) { return cur.owner === entered.owner; });
            if (!(entered.owner instanceof P.TerritoryBase)) {
              throw new Error('paper: crossed shape is not a base');
            }
            carve({
              owner: entered.owner,
              enter: entered.segment,
              startPoint: entered.point,
              startT: entered.index,
              leave: left.segment,
              endPoint: left.point,
              endT: left.index
            });
            var leaveLog = unit.track.intersections.find(function (rec) { return rec.point.equal(vertex); });
            var ownerLog = leaveLog.intersections.filter(function (entry) { return entry.base === entered.owner; });
            if (ownerLog.length === 1 || ownerLog[ownerLog.length - 1].enter === false) {
              // Left that base here without going straight back in.
              here = here.filter(function (cur) { return cur.owner !== entered.owner; });
            }
          }
          carried = here;
        }
      }

      this.units.forEach(function (other) {
        if (unit !== other && gained.inside(other.position)) {
          other.in = unit.base;
        }
      });

      var gainFraction = (unit.base.square - unit.lastSquare) / this.square;
      if (unit.schemes) {
        unit.schemes.comeback({
          increment: gainFraction,
          rise: gained,
          victims: victims,
          game: this
        });
      }
    },

    // Moves every live unit for this tick and dispatches each crossing with a
    // committed segment, nearest first.
    handleUnitMovements: function (dtMs) {
      var roster = this.units.slice();
      nextUnit: for (var u = 0; u < roster.length; u++) {
        var unit = roster[u];
        if (unit.death) continue;
        var queue = this.getMovement(dtMs, unit);

        while (queue.length) {
          if (unit.death) continue nextUnit;
          var move = queue.shift();
          var hits = this.space.intersections(move);

          this.unifyHitPoints(hits);

          for (var d = 0; d < hits.length; d++) {
            hits[d].distance = move.start.distanceSq(hits[d].point);
          }
          hits.sort(function (a, b) { return a.distance - b.distance; });

          // Hits at the same squared distance are handled as one bucket; the
          // comparison is against the FIRST distance of the open bucket.
          var buckets = [];
          var open = null;
          var openDist = -1;
          for (var h = 0; h < hits.length; h++) {
            if (!closeTo(hits[h].distance, openDist)) {
              open = [];
              openDist = hits[h].distance;
              buckets.push(open);
            }
            open.push(hits[h]);
          }

          for (var b = 0; b < buckets.length; b++) {
            this.dispatchBucket(buckets[b], unit, move);
          }

          if (unit.death) continue nextUnit;
          var reached = move.end;
          if (unit.in !== unit.base) {
            unit.track.add(reached);
          }
          unit.position = reached;
          if (this.visible && !queue.length && unit.in && unit.in !== unit.base) {
            this.particles.push(P.Particle.emitCrumb(unit, move, this.config.trackWidth));
          }
        }
      }
    },

    // Hits whose coordinates agree within tolerance must share ONE point
    // object, preferring the one already registered in the grid.
    unifyHitPoints: function (hits) {
      var groups = [];
      hits.forEach(function (hit) {
        var at = groups.findIndex(function (group) { return group.point.equal(hit.point); });
        if (at === -1) {
          groups.push({ point: hit.point, intersections: [hit] });
          return;
        }
        var group = groups[at];
        if (hit.point !== group.point) {
          if (hit.point.cell) {
            if (group.point.cell) {
              throw new Error('paper: two registered points at one location');
            }
            group.point = hit.point;
            group.intersections.forEach(function (member) {
              member.point = hit.point;
            });
          } else {
            hit.point = group.point;
          }
        }
        group.intersections.push(hit);
      });
    },

    // One bucket of equidistant hits: trails go first, then the base the unit
    // is currently in, then the rest in order of appearance.
    dispatchBucket: function (bucket, unit, move) {
      var shapes = [];
      bucket.forEach(function (hit) {
        var shape = hit.segment.shape;
        if (shape && shapes.indexOf(shape) === -1) {
          shapes.push(shape);
        }
      });
      var byCrossing = function (a, b) {
        return unit.in ? b.crossSide - a.crossSide : a.crossSide - b.crossSide;
      };
      while (shapes.length) {
        var k = shapes.findIndex(function (shape) { return shape.owner === unit.in; });
        if (k > 0) {
          var heldA = shapes[0];
          shapes[0] = shapes[k];
          shapes[k] = heldA;
        }
        k = shapes.findIndex(function (shape) { return shape.owner.isTrack; });
        if (k > 0) {
          var heldB = shapes[0];
          shapes[0] = shapes[k];
          shapes[k] = heldB;
        }
        var active = shapes.shift();
        var pending = [];
        for (var i = 0; i < bucket.length; i++) {
          if (bucket[i].segment.shape === active) pending.push(bucket[i]);
        }
        // Re-sorted before every pick because the handler can change unit.in.
        while (!unit.death && pending.length) {
          pending.sort(byCrossing);
          var next = pending.shift();
          if (next.segment.shape && !active.owner.unit.death) {
            active.owner.handleIntersect(next, unit, move);
          }
        }
      }
    }
  };

  P.installGameMoves = function () {
    Object.assign(P.Game.prototype, gameMoves);
  };

  if (P.Game) P.installGameMoves();
})(typeof window !== 'undefined' ? window : globalThis);
