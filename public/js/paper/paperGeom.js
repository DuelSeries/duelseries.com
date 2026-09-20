// Geometry core for the paper arena: tolerance helpers, shared-vertex points, directed
// segments, the point-bucket grid, open chains, closed rings, circle builder, colour maths
// and the seeded LCG. Everything downstream compares vertices by identity, so the point
// objects handed out here are never copied behind the caller's back.
(function (root) {
  'use strict';
  var P = root.DuelPaperLib = root.DuelPaperLib || {};

  // ---------------------------------------------------------------------------------------
  // Tolerance and scalar helpers
  // ---------------------------------------------------------------------------------------

  var GEOM_EPSILON = Math.pow(2, -26);

  function isNearZero(value) {
    return Math.abs(value) <= GEOM_EPSILON;
  }

  function nearlyEqual(left, right) {
    return Math.abs(left - right) <= GEOM_EPSILON;
  }

  function lerp(from, to, t) {
    return from + (to - from) * t;
  }

  function easeOutCubic(t) {
    var u = t - 1;
    return u * u * u + 1;
  }

  // Bounds come first, the value last.
  function clampMinMax(lo, hi, value) {
    if (value < lo) return lo;
    if (value > hi) return hi;
    return value;
  }

  function det2x2(p, q, r, s) {
    return p * s - q * r;
  }

  function inRangeEps(boundA, boundB, value) {
    return Math.min(boundA, boundB) - GEOM_EPSILON <= value &&
      value <= Math.max(boundA, boundB) + GEOM_EPSILON;
  }

  // Signed overlap of two 1D spans: positive = overlap, zero = touching, negative = gap.
  function intervalOverlap(a0, a1, b0, b1) {
    var swap;
    if (a0 > a1) { swap = a0; a0 = a1; a1 = swap; }
    if (b0 > b1) { swap = b0; b0 = b1; b1 = swap; }
    return Math.min(a1, b1) - Math.max(a0, b0);
  }

  function isPointOnSegmentExact(px, py, ax, ay, bx, by) {
    var toAx = ax - px;
    var toAy = ay - py;
    var toBx = bx - px;
    var toBy = by - py;
    var cross = toAx * toBy - toAy * toBx;
    var dot = toAx * toBx + toAy * toBy;
    return cross == 0 && dot <= 0;
  }

  // verts is an array of [x, y] pairs. 0 = outside, 1 = on an edge, 2 = inside.
  function classifyPointInPolygon(verts, px, py) {
    var inside = false;
    var count = verts.length;
    for (var i = 0, j = count - 1; i < count; j = i++) {
      var xi = verts[i][0];
      var yi = verts[i][1];
      var xj = verts[j][0];
      var yj = verts[j][1];
      if (isPointOnSegmentExact(px, py, xi, yi, xj, yj)) return 1;
      var crosses = ((yi > py) != (yj > py)) &&
        px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
      if (crosses) inside = !inside;
    }
    return inside ? 2 : 0;
  }

  // One stamp per grid query so a segment hanging off two points is tested once.
  var visitMarkCounter = 1;
  function allocVisitMark() {
    return visitMarkCounter++;
  }

  // Path2D does not exist under node; the stand-in only has to swallow the calls.
  function NullPath() {}
  NullPath.prototype.moveTo = function () {};
  NullPath.prototype.lineTo = function () {};
  NullPath.prototype.closePath = function () {};

  function makePath() {
    return typeof root.Path2D === 'function' ? new root.Path2D() : new NullPath();
  }

  // ---------------------------------------------------------------------------------------
  // Segment: directed edge between two shared points, with the unit-normal line equation
  // ---------------------------------------------------------------------------------------

  class Segment {
    constructor(start, end) {
      this.vector = undefined;
      this.a = undefined;
      this.b = undefined;
      this.c = undefined;
      this.mark = 0;
      this.shape = null;
      this.start = start;
      this.end = end;
      this.calc();
    }

    // Ownership is always read through segment.shape.owner.
    get owner() {
      return null;
    }

    // A zero-length segment divides by zero here and ends up with NaN coefficients;
    // that is what keeps it from ever producing a hit, so it is left alone.
    calc() {
      var start = this.start;
      var end = this.end;
      this.vector = end.clone().sub(start);
      var na = start.y - end.y;
      var nb = end.x - start.x;
      var len = Math.sqrt(na * na + nb * nb);
      na /= len;
      nb /= len;
      this.a = na;
      this.b = nb;
      this.c = -(na * start.x + nb * start.y);
    }

    clone() {
      return new Segment(this.start, this.end);
    }

    reverse() {
      var oldStart = this.start;
      this.start = this.end;
      this.end = oldStart;
      this.calc();
      return this;
    }

    commit(shape) {
      this.shape = shape;
      this.start.commit(this);
      this.end.commit(this);
      return this;
    }

    remove() {
      this.shape = null;
      this.start.remove(this);
      this.end.remove(this);
    }

    length() {
      return this.vector.magnitude();
    }

    crossSide(other) {
      return det2x2(other.a, other.b, this.a, this.b);
    }

    // `this` is the stored edge, `query` is the probe (a movement step or a bot ray).
    // Returns null or { point, segment, distance (SQUARED, from query.start), overlay, crossSide }.
    intersect(query) {
      var qa = query.a;
      var qb = query.b;
      var qc = query.c;
      var qStart = query.start;
      var qEnd = query.end;
      var a = this.a;
      var b = this.b;
      var c = this.c;
      var start = this.start;
      var end = this.end;

      var denom = det2x2(qa, qb, a, b);
      if (!isNearZero(denom)) {
        var hx = -det2x2(qc, qb, c, b) / denom;
        var hy = -det2x2(qa, qc, a, c) / denom;
        if (!(inRangeEps(qStart.x, qEnd.x, hx) &&
              inRangeEps(qStart.y, qEnd.y, hy) &&
              inRangeEps(start.x, end.x, hx) &&
              inRangeEps(start.y, end.y, hy))) {
          return null;
        }
        var raw = new Vec2(hx, hy);
        // Snap to an existing vertex object when one sits on the hit; stored ends win.
        var snapped;
        if (start.equal(raw)) snapped = start;
        else if (end.equal(raw)) snapped = end;
        else if (qStart.equal(raw)) snapped = qStart;
        else if (qEnd.equal(raw)) snapped = qEnd;
        else snapped = raw;
        return {
          point: snapped,
          segment: this,
          distance: raw.distanceSq(qStart),
          overlay: false,
          crossSide: Math.sign(denom)
        };
      }

      var overlapX = intervalOverlap(qStart.x, qEnd.x, start.x, end.x);
      var overlapY = intervalOverlap(qStart.y, qEnd.y, start.y, end.y);
      if (isNearZero(det2x2(qa, qc, a, c)) &&
          isNearZero(det2x2(qb, qc, b, c)) &&
          overlapX >= -GEOM_EPSILON &&
          overlapY >= -GEOM_EPSILON) {
        if (overlapX >= GEOM_EPSILON || overlapY >= GEOM_EPSILON) {
          var overlayPoint;
          if (inRangeEps(start.x, end.x, qStart.x) && inRangeEps(start.y, end.y, qStart.y)) {
            if (start.equal(qStart)) overlayPoint = start;
            else if (end.equal(qStart)) overlayPoint = end;
            else overlayPoint = qStart;
          } else {
            overlayPoint = qStart.distanceSq(start) >= qStart.distanceSq(end) ? end : start;
          }
          return {
            point: overlayPoint,
            segment: this,
            distance: overlayPoint.distanceSq(qStart),
            overlay: true,
            crossSide: 0
          };
        }
        var touchPoint = (start.equal(qStart) || start.equal(qEnd)) ? start : end;
        return {
          point: touchPoint,
          segment: this,
          distance: touchPoint.distanceSq(qStart),
          overlay: false,
          crossSide: 0
        };
      }
      return null;
    }

    has(point) {
      return this.start === point || this.end === point;
    }
  }

  // ---------------------------------------------------------------------------------------
  // Grid: buckets of POINTS; segments are reached through point.segments
  // ---------------------------------------------------------------------------------------

  var GRID_NEIGHBOR_PAD = 1;

  class GridCell {
    constructor(col, row) {
      this.points = [];
      this.x = col;
      this.y = row;
    }

    commit(point) {
      this.points.push(point);
      point.cell = this;
    }

    remove(point) {
      var points = this.points;
      var idx = points.indexOf(point);
      if (idx !== -1) {
        points.splice(idx, 1);
        point.cell = null;
      }
    }
  }

  class SpatialGrid {
    constructor(width, height, cellSize) {
      this.width = width;
      this.height = height;
      this.center = new Vec2(width / 2, height / 2);
      this.size = cellSize;
      this.w = Math.ceil(width / cellSize);
      this.h = Math.ceil(height / cellSize);
      this.cells = [];
      for (var row = 0; row < this.h; row++) {
        for (var col = 0; col < this.w; col++) {
          this.cells.push(new GridCell(col, row));
        }
      }
      Vec2.space = this;
    }

    count() {
      var total = 0;
      this.cells.forEach(function (cell) {
        total += cell.points.length;
      });
      return total;
    }

    // No clamping: `%` keeps the sign of the left operand.
    cell(point) {
      return this.getCell(
        Math.floor(point.x / this.size) % this.w,
        Math.floor(point.y / this.size) % this.h
      );
    }

    getCell(col, row) {
      return this.cells[col + row * this.w];
    }

    checkPoint(point) {
      var home = this.cell(point);
      return home.points.find(function (stored) { return stored.equal(point); }) || point;
    }

    // Broad phase. The scan order (rows, then columns, then point insertion order, then
    // segment insertion order) is observable downstream, so it is fixed.
    intersections(query) {
      var startCell = this.cell(query.start);
      var endCell = this.cell(query.end);
      var minCol = Math.max(0, Math.min(startCell.x, endCell.x) - GRID_NEIGHBOR_PAD);
      var maxCol = Math.min(this.w - 1, Math.max(startCell.x, endCell.x) + GRID_NEIGHBOR_PAD);
      var minRow = Math.max(0, Math.min(startCell.y, endCell.y) - GRID_NEIGHBOR_PAD);
      var maxRow = Math.min(this.h - 1, Math.max(startCell.y, endCell.y) + GRID_NEIGHBOR_PAD);
      var mark = allocVisitMark();
      var hits = [];
      for (var row = minRow; row <= maxRow; row++) {
        for (var col = minCol; col <= maxCol; col++) {
          var points = this.getCell(col, row).points;
          for (var pi = 0; pi < points.length; pi++) {
            var segs = points[pi].segments;
            for (var si = 0; si < segs.length; si++) {
              var seg = segs[si];
              if (seg.mark !== mark) {
                var hit = seg.intersect(query);
                if (hit) hits.push(hit);
                seg.mark = mark;
              }
            }
          }
        }
      }
      return hits;
    }

    clear() {
      this.cells = [];
    }
  }

  // ---------------------------------------------------------------------------------------
  // Vec2: maths vector AND shared graph vertex, with a LIFO recycle pool for temporaries
  // ---------------------------------------------------------------------------------------

  var POINT_POOL_CAPACITY = 30000;
  var pointPool = Array.from({ length: POINT_POOL_CAPACITY });
  var pointPoolCount = 0;

  class Vec2 {
    constructor(x, y) {
      this.x = undefined;
      this.y = undefined;
      this.cell = null;
      this.segments = [];
      this.set(x, y);
    }

    // A missing, null or NaN y copies x; an explicit 0 stays 0.
    set(x, y) {
      this.x = x || 0;
      this.y = y || (y === 0 ? 0 : this.x);
      return this;
    }

    // Grid registration happens once, at the coordinates the point has right now.
    commit(segment) {
      if (this.segments.indexOf(segment) === -1) {
        this.segments.push(segment);
      }
      if (!this.cell) {
        Vec2.space.cell(this).commit(this);
      }
    }

    // No guard on a missing segment: splice(-1, 1) then drops the last entry.
    remove(segment) {
      var idx = this.segments.indexOf(segment);
      this.segments.splice(idx, 1);
      if (this.cell && !this.segments.length) {
        this.cell.remove(this);
      }
    }

    release() {
      Vec2.release(this);
    }

    add(other) {
      this.x += other.x;
      this.y += other.y;
      return this;
    }

    sub(other) {
      this.x -= other.x;
      this.y -= other.y;
      return this;
    }

    mul(other) {
      this.x *= other.x;
      this.y *= other.y;
      return this;
    }

    mulScalar(factor) {
      this.x *= factor;
      this.y *= factor;
      return this;
    }

    magnitude() {
      var x = this.x;
      var y = this.y;
      return Math.sqrt(x * x + y * y);
    }

    normalize() {
      var len = this.magnitude();
      if (len) this.mulScalar(1 / len);
      return this;
    }

    copy(source) {
      this.x = source.x;
      this.y = source.y;
      return this;
    }

    distance(target) {
      return Math.sqrt(this.distanceSq(target));
    }

    distanceSq(target) {
      var dx = this.x - target.x;
      var dy = this.y - target.y;
      return dx * dx + dy * dy;
    }

    cross(other) {
      return this.x * other.y - this.y * other.x;
    }

    dot(other) {
      return this.x * other.x + this.y * other.y;
    }

    // Radians.
    rotate(angle) {
      var x = this.x;
      var y = this.y;
      var cosA = Math.cos(angle);
      var sinA = Math.sin(angle);
      this.x = x * cosA - y * sinA;
      this.y = x * sinA + y * cosA;
      return this;
    }

    angle(target) {
      return Math.atan2(this.cross(target), this.dot(target));
    }

    invert() {
      return this.mulScalar(-1);
    }

    // Per axis (a 2^-26 box), not a Euclidean radius.
    equal(other) {
      return nearlyEqual(this.x, other.x) && nearlyEqual(this.y, other.y);
    }

    clone() {
      return new Vec2(this.x, this.y);
    }

    toString() {
      return '[' + this.x.toFixed(4) + ',' + this.y.toFixed(4) + ']';
    }

    static alloc(x, y) {
      if (pointPoolCount) {
        return pointPool[--pointPoolCount].set(x, y);
      }
      return new Vec2(x, y);
    }

    static clone(source) {
      return Vec2.alloc(source.x, source.y);
    }

    static poolLength() {
      return pointPoolCount;
    }

    // A full pool leaves the point untouched (not even zeroed).
    static release(point) {
      if (pointPoolCount < POINT_POOL_CAPACITY) {
        point.set();
        pointPool[pointPoolCount++] = point;
      }
    }
  }
  Vec2.space = undefined;

  // ---------------------------------------------------------------------------------------
  // Shared constants that sit between the point and the chain classes
  // ---------------------------------------------------------------------------------------

  var SIMPLIFY_DIST = 25;
  var SIMPLIFY_DIST_SQ = SIMPLIFY_DIST * SIMPLIFY_DIST;
  var KILL_REASON_WIN = 0;
  var KILL_REASON_SELF_CROSS = 1;
  var KILL_REASON_WALL = 2;
  var KILL_REASON_TRACK_CUT = 3;
  var KILL_REASON_EXIT_POINT_CAPTURED = 4;
  var KILL_REASON_ENCIRCLED = 5;
  var KILL_REASON_SYSTEM_REMOVED = 6;
  var FRAME_MS = 1000 / 60;
  var PREPARE_STEP_MS = (1000 / 60) * 2;

  // ---------------------------------------------------------------------------------------
  // Polyline: open chain (a unit's trail) with an incrementally built path
  // ---------------------------------------------------------------------------------------

  class Polyline {
    constructor(owner) {
      this.owner = owner || null;
      this.start = null;
      this.end = null;
      this.segments = [];
      this.bounds = {
        left: Infinity,
        right: -Infinity,
        top: Infinity,
        bottom: -Infinity
      };
      this.path = makePath();
    }

    commit(shape) {
      this.segments.forEach(function (seg) { seg.commit(shape); });
    }

    remove() {
      this.segments.forEach(function (seg) { seg.remove(); });
    }

    // The path is not rebuilt.
    reverse() {
      this.segments.reverse().forEach(function (seg) { seg.reverse(); });
      if (this.end) {
        var oldStart = this.start;
        this.start = this.end;
        this.end = oldStart;
      }
      return this;
    }

    // Uncommitted copies of the segments over the SAME vertex objects.
    clone() {
      var copy = new Polyline();
      copy.segments = this.segments.map(function (seg) { return seg.clone(); });
      copy.start = this.start;
      copy.end = this.end;
      Object.assign(copy.bounds, this.bounds);
      return copy;
    }

    updateBounds(point) {
      var x = point.x;
      var y = point.y;
      this.bounds.left = Math.min(this.bounds.left, x);
      this.bounds.right = Math.max(this.bounds.right, x);
      this.bounds.top = Math.min(this.bounds.top, y);
      this.bounds.bottom = Math.max(this.bounds.bottom, y);
    }

    // Returns false when the point repeats the last one; new segments are committed at once.
    addDistinct(point) {
      var last = this.end || this.start;
      if (last && last.equal(point)) {
        return false;
      }
      var x = point.x;
      var y = point.y;
      if (last) {
        this.segments.push(new Segment(last, point).commit(this));
        this.end = point;
        this.updateBounds(point);
        this.path.lineTo(x, y);
        return true;
      }
      this.start = point;
      this.updateBounds(point);
      this.path.moveTo(x, y);
      return true;
    }

    // A chain that only has a start yields an empty list.
    points() {
      var list = this.segments.map(function (seg) { return seg.start; });
      if (this.end) list.push(this.end);
      return list;
    }

    toString() {
      return this.segments.map(function (seg) { return seg.start.toString(); }).join('');
    }
  }

  // Edge A->B against a ray from `point` toward +x: -1 = crossed, 0 = point is ON the edge,
  // +1 = anything else. The tolerance is on the raw cross product, not on a distance.
  function classifyEdgeForPoint(edgeStart, edgeEnd, point) {
    var ax = edgeStart.x - point.x;
    var ay = edgeStart.y - point.y;
    var bx = edgeEnd.x - point.x;
    var by = edgeEnd.y - point.y;
    if (ay * by > 0) return 1;
    var cross = ax * by - ay * bx;
    var sign = isNearZero(cross) ? 0 : Math.sign(cross);
    if (sign === 0) {
      if (ax * bx <= 0) return 0;
      return 1;
    }
    if (ay < 0) return -sign;
    if (by < 0) return sign;
    return 1;
  }

  // ---------------------------------------------------------------------------------------
  // Polygon: closed ring of directed segments; "vertex k" is segments[k].start
  // ---------------------------------------------------------------------------------------

  class Polygon {
    constructor(vertices) {
      this.segments = [];
      this.simplify = [];
      this.owner = null;
      this.bounds = null;
      var count = vertices.length;
      for (var i = 0; i < count; i++) {
        var next = i + 1 < count ? i + 1 : 0;
        this.segments.push(new Segment(vertices[i], vertices[next]));
      }
      this.updateBounds();
    }

    commit(owner) {
      if (owner) this.owner = owner;
      var self = this;
      this.segments.forEach(function (seg) { seg.commit(self); });
    }

    // The array itself stays, so inside() and rawSquare() keep working afterwards.
    remove() {
      this.segments.forEach(function (seg) { seg.remove(); });
    }

    reverse() {
      this.segments.reverse();
      this.segments.forEach(function (seg) { seg.reverse(); });
      return this;
    }

    // Split `segment` at `point` (both halves committed BEFORE the old one is removed).
    // simplify, bounds and path are deliberately not refreshed.
    insert(segment, point) {
      if (!segment.has(point)) {
        var idx = this.segments.findIndex(function (seg) { return seg === segment; });
        var firstHalf = new Segment(segment.start, point).commit(this);
        var secondHalf = new Segment(point, segment.end).commit(this);
        segment.remove();
        this.segments.splice(idx, 1, firstHalf, secondHalf);
      }
    }

    hasPoint(point) {
      return this.segments.some(function (seg) { return seg.has(point); });
    }

    findSegment(startPoint) {
      return this.segments.findIndex(function (seg) { return seg.start === startPoint; });
    }

    // Replace ring segments fromIdx..toIdx-1 by the chain: remove first, commit after.
    splice(chain, fromIdx, toIdx) {
      var args = [fromIdx, toIdx - fromIdx].concat(chain.segments);
      var dropped = this.segments.splice.apply(this.segments, args);
      dropped.forEach(function (seg) { seg.remove(); });
      chain.commit(this);
    }

    // Keep only ring segments fromIdx..toIdx-1 and close them with the reversed chain.
    unsplice(chain, fromIdx, toIdx) {
      var kept = this.segments.splice(fromIdx, toIdx - fromIdx);
      this.remove();
      this.segments = kept.concat(chain.reverse().segments);
      chain.commit(this);
    }

    // Replace the arc fromIdx..toIdx-1 by the chord through `points`: commit first, remove after.
    left(points, fromIdx, toIdx) {
      var chord = [];
      for (var i = 0; i < points.length - 1; i++) {
        chord.push(new Segment(points[i], points[i + 1]));
      }
      var args = [fromIdx, toIdx - fromIdx].concat(chord);
      var replaced = this.segments.splice.apply(this.segments, args);
      var self = this;
      chord.forEach(function (seg) { seg.commit(self); });
      replaced.forEach(function (seg) { seg.remove(); });
    }

    // Keep ONLY the arc fromIdx..toIdx-1 and close it with the reversed chord.
    right(points, fromIdx, toIdx) {
      var chord = [];
      for (var i = 0; i < points.length - 1; i++) {
        chord.push(new Segment(points[i], points[i + 1]));
      }
      var kept = this.segments.splice(fromIdx, toIdx - fromIdx);
      this.remove();
      var self = this;
      chord.reverse().forEach(function (seg) { seg.reverse().commit(self); });
      this.segments = kept.concat(chord);
    }

    points() {
      return this.segments.map(function (seg) { return seg.start; });
    }

    // Brute force over the ring. With several hits: stable sort by squared distance, then
    // keep the first hit per distinct vertex OBJECT.
    intersections(query) {
      var hits = [];
      if (this.segments.length > 1) {
        this.segments.forEach(function (seg) {
          var hit = seg.intersect(query);
          if (hit) hits.push(hit);
        });
      }
      if (hits.length > 1) {
        hits.sort(function (h1, h2) { return h1.distance - h2.distance; });
        var sorted = hits;
        hits = sorted.filter(function (hit, idx) {
          return sorted.findIndex(function (probe) { return probe.point === hit.point; }) == idx;
        });
      }
      return hits;
    }

    // The boundary counts as inside.
    inside(point) {
      var count = this.segments.length;
      var product = 1;
      for (var i = 0; i < count; i++) {
        var seg = this.segments[i];
        var edgeClass = classifyEdgeForPoint(seg.start, seg.end, point);
        if (edgeClass === 0) return true;
        product *= edgeClass;
      }
      return product !== 1;
    }

    insideNew(point) {
      return !!classifyPointInPolygon(
        this.segments.map(function (seg) { return [seg.start.x, seg.start.y]; }),
        point.x,
        point.y
      );
    }

    // Signed shoelace area, summed in ring order.
    rawSquare() {
      var sum = 0;
      this.segments.forEach(function (seg) {
        var start = seg.start;
        var end = seg.end;
        sum += (start.x + end.x) * (end.y - start.y);
      });
      return sum / 2;
    }

    square() {
      var area = this.rawSquare();
      if (area < 0) {
        area *= -1;
      }
      return area;
    }

    calcPath() {
      var path = makePath();
      var segments = this.segments;
      var count = segments.length;
      var first = segments[0].start;
      path.moveTo(first.x, first.y);
      for (var i = 1; i < count; i++) {
        var vertex = segments[i].start;
        path.lineTo(vertex.x, vertex.y);
      }
      path.closePath();
      this.path = path;
      this.updateBounds();
    }

    // Decimated outline: the first two vertices always go in; a later vertex closer than
    // SIMPLIFY_DIST to the entry two back overwrites the latest entry instead of growing it.
    calcSimplify() {
      this.simplify = [];
      var kept = 0;
      var self = this;
      this.segments.forEach(function (seg) {
        var start = seg.start;
        if (kept < 2) {
          self.simplify.push(start);
          kept++;
        } else {
          var twoBack = self.simplify[kept - 2];
          if (start.distanceSq(twoBack) < SIMPLIFY_DIST_SQ) {
            self.simplify[kept - 1] = start;
          } else {
            self.simplify.push(start);
            kept++;
          }
        }
      });
    }

    // Bounds come from the simplified ring, padded by SIMPLIFY_DIST on every side.
    updateBounds() {
      this.calcSimplify();
      var minX = Infinity;
      var maxX = -Infinity;
      var minY = Infinity;
      var maxY = -Infinity;
      this.simplify.forEach(function (vertex) {
        var x = vertex.x;
        var y = vertex.y;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      });
      minX -= SIMPLIFY_DIST;
      maxX += SIMPLIFY_DIST;
      minY -= SIMPLIFY_DIST;
      maxY += SIMPLIFY_DIST;
      this.bounds = {
        left: minX,
        right: maxX,
        top: minY,
        bottom: maxY
      };
    }
  }

  // ---------------------------------------------------------------------------------------
  // Clock, circle builder
  // ---------------------------------------------------------------------------------------

  // Looked up per call so a virtual clock installed on `performance` is always honoured.
  function nowMs() {
    var clock = typeof performance !== 'undefined' ? performance : Date;
    return clock.now();
  }

  // The angle is ACCUMULATED by addition; multiplying k * step changes the low bits.
  function makeCirclePoints(center, pointCount, radius) {
    if (typeof center.x !== 'number') {
      throw Error('circle');
    }
    var fullTurn = Math.PI * 2;
    var step = fullTurn / pointCount;
    var points = [];
    for (var angle = 0; angle < fullTurn - GEOM_EPSILON; angle += step) {
      points.push(new Vec2(
        center.x + Math.cos(angle) * radius,
        center.y + Math.sin(angle) * radius
      ));
    }
    return points;
  }

  // ---------------------------------------------------------------------------------------
  // Colour maths (h in degrees 0..360, s and v in percent 0..100)
  // ---------------------------------------------------------------------------------------

  function hexToRgb(hex) {
    return {
      r: parseInt(hex.substring(1, 3), 16),
      g: parseInt(hex.substring(3, 5), 16),
      b: parseInt(hex.substring(5, 7), 16)
    };
  }

  function rgbToHsv(rgb) {
    var rn = rgb.r / 255;
    var gn = rgb.g / 255;
    var bn = rgb.b / 255;
    var maxC = Math.max(rn, gn, bn);
    var delta = maxC - Math.min(rn, gn, bn);
    var hue;
    var sat;
    if (delta == 0) {
      hue = sat = 0;
    } else {
      sat = delta / maxC;
      var termR = (maxC - rn) / 6 / delta + 1 / 2;
      var termG = (maxC - gn) / 6 / delta + 1 / 2;
      var termB = (maxC - bn) / 6 / delta + 1 / 2;
      if (rn === maxC) {
        hue = termB - termG;
      } else if (gn === maxC) {
        hue = 1 / 3 + termR - termB;
      } else if (bn === maxC) {
        hue = 2 / 3 + termG - termR;
      }
      if (hue < 0) {
        hue += 1;
      } else if (hue > 1) {
        hue -= 1;
      }
    }
    return {
      h: Math.round(hue * 360),
      s: Math.round(sat * 100 * 100) / 100,
      v: Math.round(maxC * 100 * 100) / 100
    };
  }

  function hexByte(channel) {
    var text = channel.toString(16);
    return text.length < 2 ? '0' + text : text;
  }

  function rgbToHex(rgb) {
    return '#' + hexByte(rgb.r) + hexByte(rgb.g) + hexByte(rgb.b);
  }

  function hsvToRgb(hsv) {
    var h = Math.max(0, Math.min(360, hsv.h));
    var s = Math.max(0, Math.min(100, hsv.s));
    var v = Math.max(0, Math.min(100, hsv.v));
    s /= 100;
    v /= 100;
    var r;
    var g;
    var b;
    if (s == 0) {
      r = g = b = v;
    } else {
      h /= 60;
      var sector = Math.floor(h);
      var frac = h - sector;
      var p = v * (1 - s);
      var q = v * (1 - s * frac);
      var t = v * (1 - s * (1 - frac));
      // h == 360 lands in sector 6 and falls to the last branch with frac 0.
      if (sector === 0) { r = v; g = t; b = p; }
      else if (sector === 1) { r = q; g = v; b = p; }
      else if (sector === 2) { r = p; g = v; b = t; }
      else if (sector === 3) { r = p; g = q; b = v; }
      else if (sector === 4) { r = t; g = p; b = v; }
      else { r = v; g = p; b = q; }
    }
    return {
      r: Math.round(r * 255),
      g: Math.round(g * 255),
      b: Math.round(b * 255)
    };
  }

  function hsvToHex(hsv) {
    return rgbToHex(hsvToRgb(hsv));
  }

  function hsvScaleValue(hsv, factor) {
    return { h: hsv.h, s: hsv.s, v: hsv.v * factor };
  }

  function hsvLightenValue(hsv, factor) {
    var v = hsv.v;
    var headroom = 100 - v;
    v = Math.max(v * factor, v + (factor * headroom) / 4);
    return { h: hsv.h, s: hsv.s, v: v };
  }

  function hsvWithValue(hsv, value) {
    return { h: hsv.h, s: hsv.s, v: value };
  }

  // ---------------------------------------------------------------------------------------
  // Seeded LCG. rng() -> float in [0,1) with 1e9 steps, rng(m) -> integer state % m.
  // Plain double arithmetic: the state stays below 2^31, so state * 69069 + 1 is exact.
  // ---------------------------------------------------------------------------------------

  var LCG_MODULUS = 2147483648; // 2^31

  function createSeededRng(seed) {
    var state = seed;
    if (0 < state && state < 1) state = Math.floor(state * 1000000000);
    function next(modulus) {
      state = (state * 69069 + 1) % LCG_MODULUS;
      return state % modulus;
    }
    return function (range) {
      return range == null ? next(1000000000) / 1000000000 : next(range);
    };
  }

  // Never settles when the load fails; callers rely on that (no error path exists).
  function loadImageFromUrl(url) {
    return new Promise(function (resolve) {
      var img = root.document.createElement('img');
      img.src = url;
      img.onload = function () {
        resolve(img);
      };
    });
  }

  function formatFixed2(value) {
    return value.toFixed(2);
  }

  // ---------------------------------------------------------------------------------------
  // Exports
  // ---------------------------------------------------------------------------------------

  P.clampMinMax = clampMinMax;
  P.classifyPointInPolygon = classifyPointInPolygon;
  P.isPointOnSegmentExact = isPointOnSegmentExact;
  P.Segment = Segment;
  P.GridCell = GridCell;
  P.SpatialGrid = SpatialGrid;
  P.Vec2 = Vec2;
  P.Polyline = Polyline;
  P.classifyEdgeForPoint = classifyEdgeForPoint;
  P.Polygon = Polygon;
  P.makeCirclePoints = makeCirclePoints;
  P.hexToRgb = hexToRgb;
  P.rgbToHsv = rgbToHsv;
  P.hsvToRgb = hsvToRgb;
  P.createSeededRng = createSeededRng;
  P.hsvScaleValue = hsvScaleValue;
  P.hsvLightenValue = hsvLightenValue;
  P.hsvWithValue = hsvWithValue;

  // Shared helpers and constants that live next to this range and that no other file owns.
  P.GEOM_EPSILON = GEOM_EPSILON;
  P.isNearZero = isNearZero;
  P.nearlyEqual = nearlyEqual;
  P.lerp = lerp;
  P.easeOutCubic = easeOutCubic;
  P.det2x2 = det2x2;
  P.inRangeEps = inRangeEps;
  P.intervalOverlap = intervalOverlap;
  P.allocVisitMark = allocVisitMark;
  P.GRID_NEIGHBOR_PAD = GRID_NEIGHBOR_PAD;
  P.POINT_POOL_CAPACITY = POINT_POOL_CAPACITY;
  P.SIMPLIFY_DIST = SIMPLIFY_DIST;
  P.SIMPLIFY_DIST_SQ = SIMPLIFY_DIST_SQ;
  P.KILL_REASON_WIN = KILL_REASON_WIN;
  P.KILL_REASON_SELF_CROSS = KILL_REASON_SELF_CROSS;
  P.KILL_REASON_WALL = KILL_REASON_WALL;
  P.KILL_REASON_TRACK_CUT = KILL_REASON_TRACK_CUT;
  P.KILL_REASON_EXIT_POINT_CAPTURED = KILL_REASON_EXIT_POINT_CAPTURED;
  P.KILL_REASON_ENCIRCLED = KILL_REASON_ENCIRCLED;
  P.KILL_REASON_SYSTEM_REMOVED = KILL_REASON_SYSTEM_REMOVED;
  P.FRAME_MS = FRAME_MS;
  P.PREPARE_STEP_MS = PREPARE_STEP_MS;
  P.nowMs = nowMs;
  P.rgbToHex = rgbToHex;
  P.hsvToHex = hsvToHex;
  P.loadImageFromUrl = loadImageFromUrl;
  P.formatFixed2 = formatFixed2;
})(typeof window !== 'undefined' ? window : globalThis);
