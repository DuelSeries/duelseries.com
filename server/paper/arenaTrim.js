'use strict';
// Territory trim (design 9.4-9.6): when the wall shrinks, the land outside it goes. planTrim is
// a pure convex clip (Weiler-Atherton against the 300-gon wall) that mutates NOTHING; applyTrim
// commits the kept ring. Vertex identity is the whole game here: kept ring vertices stay the
// same objects, wall vertices ARE the border polygon's own (registered) objects, and every new
// crossing point goes through space.checkPoint, so the grid never holds two registered points
// at one location (which would make the next slider past that corner throw).
const P = require('./loadPaperLib');

const MP = P.MP;
const GEOM_EPSILON = Math.pow(2, -26);
const NEAR_WALL = 1e-6;

function vertsOf(poly) {
  return poly.segments.map((s) => s.start);
}

function signedArea(pts) {
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1 < pts.length ? i + 1 : 0];
    sum += (a.x + b.x) * (b.y - a.y);
  }
  return sum / 2;
}

// Signed distance of p from wall edge k (positive inside for a counter-clockwise wall).
function edgeInfo(border, k) {
  const segs = border.polygon.segments;
  const n = segs.length;
  const a = segs[((k % n) + n) % n].start;
  const b = segs[((k % n) + n) % n].end;
  return { a, b };
}

function sectorOf(border, p) {
  const n = border.pointCount;
  const step = (Math.PI * 2) / n;
  let ang = Math.atan2(p.y - border.center.y, p.x - border.center.x);
  if (ang < 0) ang += Math.PI * 2;
  const k = Math.floor(ang / step);
  return k >= n ? n - 1 : k;
}

// Intersection of segment p-q with wall edge k: { t along p-q, s along the edge } or null.
function hitEdge(border, p, q, k) {
  const { a, b } = edgeInfo(border, k);
  const rx = q.x - p.x;
  const ry = q.y - p.y;
  const sx = b.x - a.x;
  const sy = b.y - a.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-15) return null;
  const t = ((a.x - p.x) * sy - (a.y - p.y) * sx) / den;
  const s = ((a.x - p.x) * ry - (a.y - p.y) * rx) / den;
  const tol = 1e-9;
  if (t < -tol || t > 1 + tol || s < -tol || s > 1 + tol) return null;
  return { t: Math.min(1, Math.max(0, t)), s: Math.min(1, Math.max(0, s)), k: ((k % border.pointCount) + border.pointCount) % border.pointCount };
}

// Distance of p from the wall boundary (via its sector's edge; exact for the convex n-gon).
function wallDistance(border, p) {
  const k = sectorOf(border, p);
  const { a, b } = edgeInfo(border, k);
  const ex = b.x - a.x;
  const ey = b.y - a.y;
  return Math.abs(ex * (p.y - a.y) - ey * (p.x - a.x)) / Math.hypot(ex, ey);
}

// The crossing of ring edge p (inside) - q (outside), or the reverse, with the reuse rules.
function crossingOf(border, space, pIn, qOut) {
  const n = border.pointCount;
  const wallVerts = border.polygon.segments;
  if (wallDistance(border, qOut) <= NEAR_WALL) return onWall(border, qOut);
  let hit = null;
  // Analytic: the sectors between the two ends (the short way round) plus one each side.
  const k1 = sectorOf(border, pIn);
  const k2 = sectorOf(border, qOut);
  let d = k2 - k1;
  if (d > n / 2) d -= n;
  if (d < -n / 2) d += n;
  const lo = Math.min(0, d) - 1;
  const hi = Math.max(0, d) + 1;
  for (let j = lo; j <= hi && !hit; j++) hit = hitEdge(border, pIn, qOut, k1 + j);
  for (let k = 0; k < n && !hit; k++) hit = hitEdge(border, pIn, qOut, k);
  let point;
  if (hit) {
    point = { x: pIn.x + (qOut.x - pIn.x) * hit.t, y: pIn.y + (qOut.y - pIn.y) * hit.t };
  } else {
    // Bisection on the inside test always produces an answer.
    let a = 0;
    let b = 1;
    for (let r = 0; r < 40; r++) {
      const m = (a + b) / 2;
      if (MP.wallInside(border, pIn.x + (qOut.x - pIn.x) * m, pIn.y + (qOut.y - pIn.y) * m)) a = m;
      else b = m;
    }
    point = { x: pIn.x + (qOut.x - pIn.x) * a, y: pIn.y + (qOut.y - pIn.y) * a };
    const k = sectorOf(border, point);
    const { a: wa, b: wb } = edgeInfo(border, k);
    const ex = wb.x - wa.x;
    const ey = wb.y - wa.y;
    const s = ((point.x - wa.x) * ex + (point.y - wa.y) * ey) / (ex * ex + ey * ey);
    hit = { t: a, s: Math.min(1, Math.max(0, s)), k };
  }
  let k = hit.k;
  let s = hit.s;
  let obj;
  if (wallDistance(border, pIn) <= NEAR_WALL) {
    obj = pIn; // the inside end sits on the wall: the crossing IS that ring vertex
  } else {
    const va = wallVerts[k].start;
    const vb = wallVerts[k].end;
    if (Math.abs(point.x - va.x) <= GEOM_EPSILON && Math.abs(point.y - va.y) <= GEOM_EPSILON) {
      obj = va;
      s = 0;
    } else if (Math.abs(point.x - vb.x) <= GEOM_EPSILON && Math.abs(point.y - vb.y) <= GEOM_EPSILON) {
      obj = vb;
      k = (k + 1) % n;
      s = 0;
    } else {
      const fresh = new P.Vec2(point.x, point.y);
      obj = space ? space.checkPoint(fresh) : fresh;
    }
  }
  return { point: obj, k, s, pos: k + s };
}

// A ring vertex that sits on the wall (planTrim counts it as outside) IS the crossing of its
// edge: the same object, placed on its wall edge (exactly on a wall vertex when within 2^-26).
function onWall(border, q) {
  const n = border.pointCount;
  let k = sectorOf(border, q);
  const { a, b } = edgeInfo(border, k);
  let s;
  if (Math.abs(q.x - a.x) <= GEOM_EPSILON && Math.abs(q.y - a.y) <= GEOM_EPSILON) s = 0;
  else if (Math.abs(q.x - b.x) <= GEOM_EPSILON && Math.abs(q.y - b.y) <= GEOM_EPSILON) {
    k = (k + 1) % n;
    s = 0;
  } else {
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    s = Math.min(1, Math.max(0, ((q.x - a.x) * ex + (q.y - a.y) * ey) / (ex * ex + ey * ey)));
  }
  return { point: q, k, s, pos: k + s };
}

// Does the segment a-b meet any committed trail piece anywhere but at its own two ends?
function crossesTrail(space, a, b) {
  const hits = space.intersections(new P.Segment(a, b));
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    const shape = h.segment.shape;
    if (!shape || !shape.owner || !shape.owner.isTrack) continue;
    if (!h.overlay && (h.point === a || h.point === b || h.point.equal(a) || h.point.equal(b))) continue;
    return true;
  }
  return false;
}

// Pure. Returns { status, keep?, droppedLobe?, pieces? }; see design 9.4 for each status.
function planTrim(base, border, anchor) {
  const ring = base.polygon;
  const verts = vertsOf(ring);
  const n = verts.length;
  if (n < 3) return { status: 'invalid', why: 'ring under 3' };
  const inside = verts.map((v) => MP.wallInside(border, v.x, v.y));
  if (inside.every(Boolean)) return { status: 'clean' };
  // A ring vertex ON the wall (a wall slide lays trail points on the edge, and a capture
  // makes them ring vertices) counts as outside for the clip, the usual perturbation for
  // Weiler-Atherton: the wall walk then replaces the ring's own run along the edge, and the
  // crossings at its ends resolve to those same vertex objects (checkPoint). Counted inside,
  // the wall walk could run back over them and the kept ring touched itself (soak probe).
  for (let i = 0; i < n; i++) {
    if (inside[i] && wallDistance(border, verts[i]) <= NEAR_WALL) inside[i] = false;
  }

  const ringSign = Math.sign(signedArea(verts));
  const wallPts = vertsOf(border.polygon);
  const wallSign = Math.sign(signedArea(wallPts));
  const space = border.space || null;
  const unit = base.unit;
  const away = unit && unit.in !== base;
  const exitVertex = away && unit.track && unit.track.polyline ? unit.track.polyline.start : null;

  // Crossings, one per ring edge whose ends differ.
  const onEdge = new Array(n).fill(null);
  const crossings = [];
  for (let i = 0; i < n; i++) {
    const j = i + 1 < n ? i + 1 : 0;
    if (inside[i] === inside[j]) continue;
    const c = inside[i] ? crossingOf(border, space, verts[i], verts[j]) : crossingOf(border, space, verts[j], verts[i]);
    c.edge = i;
    c.kind = inside[i] ? 'exit' : 'enter';
    onEdge[i] = c;
    crossings.push(c);
  }

  let pieces = [];
  if (crossings.length) {
    const exits = crossings.filter((c) => c.kind === 'exit').length;
    if (exits * 2 !== crossings.length) return { status: 'invalid', why: 'unpaired crossings' };
    // Along the ring they must alternate.
    for (let a = 0; a < crossings.length; a++) {
      const b = crossings[(a + 1) % crossings.length];
      if (crossings.length > 1 && crossings[a].kind === b.kind) return { status: 'invalid', why: 'not alternating' };
    }
    const dir = ringSign * wallSign >= 0 ? 1 : -1;
    const byPos = crossings.slice().sort((a, b) => a.pos - b.pos);
    const idxOf = new Map(byPos.map((c, i) => [c, i]));
    const visited = new Set();
    const wallN = border.pointCount;
    const maxSteps = n + wallN + crossings.length * 4 + 10;
    for (const start of crossings) {
      if (start.kind !== 'enter' || visited.has(start)) continue;
      const pts = [];
      let cur = start;
      let steps = 0;
      for (;;) {
        if (++steps > maxSteps) return { status: 'invalid', why: 'walk did not close' };
        visited.add(cur);
        pts.push(cur.point);
        // Follow the ring from this enter to the next exit.
        let e = cur.edge;
        let exit = null;
        for (let m = 0; m < n; m++) {
          const vi = (e + 1) % n;
          pts.push(verts[vi]);
          const c = onEdge[vi];
          if (c) {
            if (c.kind !== 'exit') return { status: 'invalid', why: 'enter while inside' };
            exit = c;
            break;
          }
          e = vi;
        }
        if (!exit) return { status: 'invalid', why: 'no exit' };
        pts.push(exit.point);
        visited.add(exit);
        // Follow the wall to the next crossing in the walk direction; it must be an enter.
        const ix = idxOf.get(exit);
        const next = byPos[(ix + dir + byPos.length) % byPos.length];
        if (next.kind !== 'enter') return { status: 'invalid', why: 'wall walk met an exit' };
        let from = exit.pos;
        let to = next.pos;
        if (dir > 0) {
          if (to <= from) to += wallN;
          for (let v = Math.floor(from) + 1; v < to; v++) pts.push(wallPts[v % wallN]);
        } else {
          if (to >= from) to -= wallN;
          for (let v = Math.ceil(from) - 1; v > to; v--) pts.push(wallPts[((v % wallN) + wallN) % wallN]);
        }
        if (next === start) break;
        cur = next;
      }
      // Drop consecutive repeats of one object (a crossing that IS a ring or wall vertex).
      const clean = [];
      for (const p of pts) if (!clean.length || clean[clean.length - 1] !== p) clean.push(p);
      if (clean.length > 1 && clean[0] === clean[clean.length - 1]) clean.pop();
      pieces.push(clean);
    }
  }

  let keep;
  let status = 'ok';
  let droppedLobe = false;
  if (!pieces.length) {
    const c = border.center;
    if (!crossings.length && ring.inside(c)) {
      keep = ringSign * wallSign >= 0 ? wallPts.slice() : wallPts.slice().reverse();
      status = 'wall';
    } else {
      return { status: 'empty' };
    }
  } else {
    let chosen = null;
    if (anchor && anchor.point) {
      chosen = pieces.find((pts) => new P.Polygon(pts).inside(anchor.point)) || null;
    } else if (away && exitVertex) {
      chosen = pieces.find((pts) => pts.includes(exitVertex)) || null;
    } else if (unit && !away) {
      chosen = pieces.find((pts) => new P.Polygon(pts).inside(unit.position)) || null;
    }
    if (!chosen) {
      let best = -1;
      for (const pts of pieces) {
        const a = Math.abs(signedArea(pts));
        if (a > best) { best = a; chosen = pts; }
      }
    }
    keep = chosen;
    droppedLobe = pieces.length > 1;
  }

  // Blocked: vertices this trim would delete that something else still needs.
  const kept = new Set(keep);
  const dropped = verts.filter((v) => !kept.has(v));
  if (exitVertex && dropped.includes(exitVertex)) return { status: 'blocked', why: 'exit vertex' };
  for (const v of dropped) {
    for (const seg of v.segments) {
      if (seg.shape && seg.shape.owner && seg.shape.owner.isTrack) return { status: 'blocked', why: 'trail on a dropped vertex' };
    }
  }

  // Validate.
  if (keep.length < 3) return { status: 'invalid', why: 'under 3 vertices' };
  const c = border.center;
  const lim = border.radius + 0.01;
  const oldNext = new Map();
  for (let i = 0; i < n; i++) oldNext.set(verts[i], verts[(i + 1) % n]);
  for (let i = 0; i < keep.length; i++) {
    const a = keep[i];
    const b = keep[(i + 1) % keep.length];
    if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) return { status: 'invalid', why: 'non-finite' };
    if (Math.hypot(a.x - c.x, a.y - c.y) > lim) return { status: 'invalid', why: 'outside the wall' };
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len <= GEOM_EPSILON) return { status: 'invalid', why: 'zero-length edge' };
    const isOld = oldNext.get(a) === b || oldNext.get(b) === a;
    if (!isOld && len > MP.TRIM_MAX_EDGE) return { status: 'invalid', why: 'long new edge ' + len };
    // A new edge (the wall run, or an edge to a crossing) must not cross any trail: the trail
    // was laid against the old ring, so it holds no enter or exit record for this edge, and
    // the owner's next capture would merge its trail across it (soak probe: a spiked ring
    // hundreds of ticks later). Wait until the trail is gone, as for a dropped trail vertex.
    if (!isOld && space && crossesTrail(space, a, b)) return { status: 'blocked', why: 'trail crosses a new edge' };
  }
  const area = signedArea(keep);
  if (Math.abs(area) < MP.TRIM_MIN_AREA) return { status: 'empty' };
  if (Math.abs(area) > Math.abs(signedArea(verts)) + 1e-6) return { status: 'invalid', why: 'trim grew land' };
  if (Math.sign(area) !== ringSign) return { status: 'invalid', why: 'orientation flipped' };

  return { status, keep, droppedLobe, pieces: pieces.length };
}

// Commits a plan (post pass only, after game._enter()). Fresh segments are committed FIRST so
// kept vertices never leave the grid, then every old segment is removed exactly once.
function applyTrim(game, base, plan) {
  const ring = base.polygon;
  const keep = plan.keep;
  const old = ring.segments;
  // For the wire (arenaWire): a plain trim is not a carve and sends no ring, so it records the
  // size the ring had before this apply.
  base._trimTick = game.tick;
  base._preTrimSquare = base.square;
  base._preTrimSegs = old.length;
  const fresh = [];
  for (let i = 0; i < keep.length; i++) fresh.push(new P.Segment(keep[i], keep[(i + 1) % keep.length]));
  fresh.forEach((s) => s.commit(ring));
  old.forEach((s) => s.remove());
  ring.segments = fresh;
  base.calcSquare();
  ring.calcPath();
  if (plan.droppedLobe) base.wireVer = (base.wireVer | 0) + 1;
  for (const u of game.units) {
    if (u.in === base && u !== base.unit && !ring.inside(u.position)) u.in = null;
  }
  return true;
}

// Debug and test check of a ring after any trim (design 9.5). Returns null or a reason.
function checkRing(base) {
  const ring = base.polygon;
  const segs = ring.segments;
  const n = segs.length;
  if (n < 3) return 'under 3 segments';
  const seen = new Set();
  for (let i = 0; i < n; i++) {
    const s = segs[i];
    if (s.end !== segs[(i + 1) % n].start) return 'not closed at ' + i;
    if (s.shape !== ring) return 'segment ' + i + ' not committed to this ring';
    if (!s.start.cell) return 'vertex ' + i + ' not registered';
    if (s.start.segments.indexOf(s) === -1) return 'segment ' + i + ' missing from its start';
    if (Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y) <= GEOM_EPSILON) return 'zero-length ' + i;
    if (seen.has(s.start)) return 'repeated vertex object ' + i;
    seen.add(s.start);
  }
  for (let i = 0; i < n; i++) {
    const a = segs[i].start;
    const b = segs[(i + 1) % n].start;
    if (a !== b && Math.abs(a.x - b.x) <= GEOM_EPSILON && Math.abs(a.y - b.y) <= GEOM_EPSILON) return 'two points within 2^-26 at ' + i;
  }
  // Every non-adjacent pair, through a sweep over x: Segment.intersect only ever reports a
  // point inside both boxes (within 2^-26), so pairs whose boxes miss by more are skipped
  // without changing the answer (the all-pairs loop cost seconds on a 2000-vertex ring).
  const E = 1e-6;
  const lo = new Float64Array(n);
  const hi = new Float64Array(n);
  const top = new Float64Array(n);
  const bot = new Float64Array(n);
  const order = new Array(n);
  for (let i = 0; i < n; i++) {
    const s = segs[i];
    lo[i] = Math.min(s.start.x, s.end.x) - E;
    hi[i] = Math.max(s.start.x, s.end.x) + E;
    top[i] = Math.min(s.start.y, s.end.y) - E;
    bot[i] = Math.max(s.start.y, s.end.y) + E;
    order[i] = i;
  }
  order.sort((a, b) => lo[a] - lo[b]);
  let active = [];
  for (const k of order) {
    active = active.filter((o) => hi[o] >= lo[k]);
    for (const o of active) {
      const i = Math.min(o, k);
      const j = Math.max(o, k);
      if (j - i < 2 || (i === 0 && j === n - 1)) continue;
      if (top[k] > bot[o] || top[o] > bot[k]) continue;
      if (segs[i].intersect(segs[j])) return 'not simple: ' + i + ' x ' + j;
    }
    active.push(k);
  }
  const unit = base.unit;
  if (unit && unit.in !== base && unit.track && unit.track.polyline.start) {
    const st = unit.track.polyline.start;
    if (!segs.some((s) => s.start === st)) return 'exit vertex lost';
  }
  return null;
}

// The entry ArenaGame.trimDirtyBases calls: 'trimmed' | 'clean' | 'blocked' | 'invalid' |
// 'empty' (reseat) | 'gave-up' (stop retrying until the next quantum or return).
function trimBase(game, unit) {
  const base = unit.base;
  const border = game.border;
  const anyInside = base.polygon.segments.some((s) => MP.wallInside(border, s.start.x, s.start.y));
  if (anyInside) base._noInsideSince = null;
  else if (base._noInsideSince == null) base._noInsideSince = game.nowMs;
  const plan = planTrim(base, border);
  if (plan.status === 'ok' || plan.status === 'wall') {
    game._enter();
    applyTrim(game, base, plan);
    base._trimInvalid = 0;
    return 'trimmed';
  }
  if (plan.status === 'invalid') {
    base._trimInvalid = (base._trimInvalid | 0) + 1;
    if (base._trimInvalid >= MP.TRIM_INVALID_LIMIT) {
      console.error('[PAPER] TRIM gave up', plan.why, JSON.stringify(vertsOf(base.polygon).map((v) => [v.x, v.y])));
      base._trimInvalid = 0;
      return 'gave-up';
    }
    return 'invalid';
  }
  if (plan.status === 'blocked' && base._noInsideSince != null && game.nowMs - base._noInsideSince >= MP.RESEAT_AFTER_MS) {
    return 'empty';
  }
  return plan.status;
}

module.exports = { planTrim, applyTrim, checkRing, trimBase, signedArea };
