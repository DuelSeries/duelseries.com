(function (root) {
  'use strict';
  var P = root.DuelPaperLib = root.DuelPaperLib || {};

  // Trail decimation distance (world units), compared squared.
  var SIMPLIFY_DIST = 25;
  var SIMPLIFY_DIST_SQ = SIMPLIFY_DIST * SIMPLIFY_DIST;

  // Kill reason codes handed to game.kill from this module.
  var KILL_REASON_SELF_CROSS = 1;
  var KILL_REASON_WALL = 2;
  var KILL_REASON_TRACK_CUT = 3;

  // The arena wall: a ring polygon that is never committed to the spatial
  // grid, so it is only ever queried through this class.
  class ArenaBorder {
    constructor(polygon, center, radius) {
      this.polygon = polygon;
      this.radius = radius;
      this.center = center;
    }

    static circular(center, pointCount, radius) {
      return new ArenaBorder(
        new P.Polygon(P.makeCirclePoints(center, pointCount, radius)),
        center,
        radius
      );
    }

    intersections(moveSeg) {
      // Fast reject: a step whose both ends are well inside the ring cannot
      // touch the wall. The 0.95 scales the SQUARED radius.
      if (
        moveSeg.start.distanceSq(this.center) < this.radius ** 2 * 0.95 &&
        moveSeg.end.distanceSq(this.center) < this.radius ** 2 * 0.95
      ) {
        return [];
      }
      return this.polygon.intersections(moveSeg).filter(function (hit) {
        return !hit.overlay;
      });
    }
  }

  // One unit's owned land: a single committed ring plus its running area.
  class TerritoryBase {
    constructor(ownerUnit, points) {
      this.unit = void 0;
      this.isTrack = void 0;
      this.unit = ownerUnit;
      this.merges = [];
      this.polygon = new P.Polygon(points);
      this.polygon.commit(this);
      this.calcSquare();
      this.polygon.calcPath();
    }

    calcSquare() {
      this.square = this.polygon.square();
    }

    remove() {
      this.polygon.remove();
    }

    handleIntersect(hit, movingUnit, moveSeg) {
      if (movingUnit === this.unit) {
        this.handleSelfIntersect(hit, movingUnit, moveSeg);
      } else {
        this.handleEnemyIntersect(hit, movingUnit, moveSeg);
      }
    }

    // The owner crosses its own boundary. The guards are deliberately
    // asymmetric (exit defers a hit at the step END, return ignores a hit at
    // the step START) and a crossSide of 0 passes both sign guards.
    handleSelfIntersect(hit, movingUnit, moveSeg) {
      if (hit.overlay) {
        return;
      }
      this.unit.onScoreChanged();
      var crossPoint = hit.point;
      var crossedEdge = hit.segment;
      if (movingUnit.in === this) {
        // leaving home
        if (hit.crossSide < 0) {
          return;
        }
        if (crossPoint.equal(moveSeg.end)) {
          return;
        }
        this.polygon.insert(crossedEdge, crossPoint);
        movingUnit.track.add(crossPoint);
        movingUnit.in = null;
        movingUnit.schemes && movingUnit.schemes.out();
      } else {
        // coming home
        if (hit.crossSide > 0) {
          return;
        }
        if (crossPoint.equal(moveSeg.start)) {
          return;
        }
        if (movingUnit.in) {
          return;
        }
        this.polygon.insert(crossedEdge, crossPoint);
        movingUnit.track.add(crossPoint);
        if (movingUnit.track.polyline.end) {
          this.unit.game.handleReturn(movingUnit);
        }
        movingUnit.in = this;
        movingUnit.track.remove();
      }
    }

    // A foreign unit crosses this boundary. Nobody dies here: the edge is
    // split at the crossing, the same point object joins the intruder's trail
    // and the crossing is logged for the later territory cut. The leave
    // branch has no overlay guard and no end-point guard.
    handleEnemyIntersect(hit, movingUnit, moveSeg) {
      var crossPoint = hit.point;
      var crossedEdge = hit.segment;
      if (movingUnit.in === this) {
        if (hit.crossSide < 0) {
          return;
        }
        this.polygon.insert(crossedEdge, crossPoint);
        movingUnit.track.add(crossPoint);
        movingUnit.track.intersect(hit, this, false);
        movingUnit.in = null;
      } else {
        if (hit.crossSide > 0) {
          return;
        }
        if (hit.overlay) {
          return;
        }
        if (crossPoint.equal(moveSeg.end)) {
          return;
        }
        if (movingUnit.in) {
          return;
        }
        this.polygon.insert(crossedEdge, crossPoint);
        movingUnit.track.add(crossPoint);
        movingUnit.track.intersect(hit, this, true);
        movingUnit.in = this;
      }
    }
  }

  // One unit's trail outside its base.
  class UnitTrack {
    constructor(ownerUnit) {
      this.polyline = new P.Polyline(this);
      this.simplified = [];
      this.unit = ownerUnit;
      this.length = 0;
      this.intersections = [];
      this.isTrack = true;
    }

    add(point) {
      if (this.polyline.addDistinct(point)) {
        var segCount = this.polyline.segments.length;
        if (segCount > 0) {
          var newest = this.polyline.segments[segCount - 1];
          this.length += newest.start.distance(newest.end);
        }
        // Decimated copy: the first three points are always kept, after that
        // a point close to the one before last replaces the last one.
        var coarse = this.simplified;
        var coarseCount = coarse.length;
        if (coarseCount > 2) {
          var twoBack = coarse[coarseCount - 2];
          if (point.distanceSq(twoBack) < SIMPLIFY_DIST_SQ) {
            coarse[coarseCount - 1] = point;
          } else {
            coarse.push(point);
          }
        } else {
          coarse.push(point);
        }
      }
    }

    // Crossing log, grouped by crossing point (epsilon equality).
    intersect(hit, base, isEnter) {
      var record = this.intersections.find(function (entry) {
        return entry.point.equal(hit.point);
      });
      if (record) {
        record.intersections.push({
          intersection: hit,
          base: base,
          enter: isEnter
        });
      } else {
        this.intersections.push({
          point: hit.point,
          intersections: [
            {
              intersection: hit,
              base: base,
              enter: isEnter
            }
          ]
        });
      }
    }

    remove() {
      this.polyline.remove();
      this.polyline = new P.Polyline(this);
      this.length = 0;
      this.simplified = [];
      this.intersections = [];
    }

    // Something crosses this trail. For the owner, the unavoidable touch
    // between a new step and the trail tip snaps to the tip's own point
    // object, so the identity test below lets exactly that case through.
    handleIntersect(hit, movingUnit, moveSeg) {
      var game = movingUnit.game;
      if (movingUnit === this.unit) {
        if (
          hit.overlay === true ||
          hit.point !== this.polyline.segments[this.polyline.segments.length - 1].end
        ) {
          this.unit.position = hit.point;
          var reason =
            game.border.radius - movingUnit.position.distance(game.space.center) < 5
              ? KILL_REASON_WALL
              : KILL_REASON_SELF_CROSS;
          game.kill(this.unit, void 0, reason);
        }
      } else {
        game.kill(this.unit, movingUnit, KILL_REASON_TRACK_CUT);
      }
    }
  }

  P.ArenaBorder = ArenaBorder;
  P.TerritoryBase = TerritoryBase;
  P.UnitTrack = UnitTrack;
})(typeof window !== 'undefined' ? window : globalThis);
