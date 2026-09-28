// Paper multiplayer: the mirror game (design 8.1-8.4). ClientArenaGame extends the stock P.Game,
// so the unchanged loop, renderGameFrame and the stock labels, particles, leaderboard and minimap
// all run on it, but it never simulates: every square, ring and trail comes from the server
// through paperNet (applyJoined, applyEntry, onFrame), the own square is predicted by
// paperPredict, and update() is the cosmetic subset of the stock tick. MirrorUnit extends
// P.GameUnit with real geometry that is never committed, in exactly the fields the stock
// renderer reads (base.polygon.path and bounds, track.polyline.path, segments and bounds,
// position, direction, target, skin, schemes, in, percent, statistics).
// Needs the solo modules, paperWire, paperPredict and paperNet at CALL time; loads standalone
// under require.
(function (root, factory) {
  'use strict';
  var api = factory(root);
  var P = root.DuelPaperLib = root.DuelPaperLib || {};
  P.Mirror = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  var TWO_PI = Math.PI * 2;
  var REASON_SYSTEM_REMOVED = 6; // the stock kill skips the death burst for this reason only
  var PREDICTED_HOME_MS = 500; // 8.2: a predicted return keeps the own trail at most this long
  var U32_MAX = 4294967295; // frame money saturates here; the exact value rides ['m']
  var VIEW_DIAGONAL = Math.sqrt(1366 * 1366 + 768 * 768); // the stock visionRange line
  var SAME_POINT = 1e-9;

  function lib() {
    var P = root.DuelPaperLib;
    if (!P || !P.Game || !P.GameUnit || !P.MP || !P.Predict || !P.Net) {
      throw new Error('paperMirror: load the solo paper modules, paperWire, paperPredict and paperNet first');
    }
    return P;
  }

  // -----------------------------------------------------------------------------------------
  // Ring clip (8.4, corrected). The design's RADIAL clamp (vertices outside moved onto the
  // radius) is exact only along the wall run: where the ring meets the wall it cuts the corner
  // by up to about 1.2 u (measured in T6, docs/paper-mp/STATUS.md). So the mirror CLIPS the
  // ring against the wall instead, the same picture the server's trim draws: the kept part of
  // the ring, the exact crossing points on the wall, and between each exit and the next entry
  // the wall's own vertices (the wall run), walked in the direction the ring went round outside.
  // The wall is convex, so an edge crosses it at most twice. Returns the clipped points, the
  // SAME array when nothing reaches outside, or null when no part of the ring is inside.
  // wall: an MP.guardedBorder ({ center, radius, pointCount, polygon }).
  // -----------------------------------------------------------------------------------------

  function clipRing(points, wall) {
    var P = root.DuelPaperLib;
    var MP = P && P.MP;
    if (!MP) throw new Error('paperMirror.clipRing: load paperWire first');
    var n = points.length;
    if (n < 3) return null;
    var inside = new Array(n);
    var first = -1;
    var all = true;
    for (var i = 0; i < n; i++) {
      inside[i] = MP.wallInside(wall, points[i].x, points[i].y);
      if (!inside[i]) all = false;
      else if (first < 0) first = i;
    }
    if (all) return points;
    if (first < 0) return null;

    var cx = wall.center.x;
    var cy = wall.center.y;
    var m = wall.pointCount;
    var step = TWO_PI / m;
    var apothem = wall.radius * Math.cos(Math.PI / m);
    var wallSegs = wall.polygon.segments; // wall vertex k is wallSegs[k].start, at angle k * step

    function angleOf(p) {
      var a = Math.atan2(p.y - cy, p.x - cx);
      return a < 0 ? a + TWO_PI : a;
    }
    function at(a, b, t) {
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    // The one boundary point between an inside point and an outside point, by bisection on the
    // exact wall test (so it agrees with the vertex flags above).
    function crossing(pin, pout) {
      var lo = 0;
      var hi = 1;
      for (var it = 0; it < 52; it++) {
        var mid = (lo + hi) / 2;
        if (MP.wallInside(wall, pin.x + (pout.x - pin.x) * mid, pin.y + (pout.y - pin.y) * mid)) lo = mid;
        else hi = mid;
      }
      return at(pin, pout, lo);
    }
    // How far past the wall edge that faces (x, y) the point lies: the n-gon's support function
    // in that sector. Along a segment this is convex (a max of affine functions).
    function depth(p) {
      var dx = p.x - cx;
      var dy = p.y - cy;
      var a = Math.atan2(dy, dx);
      if (a < 0) a += TWO_PI;
      var k = Math.floor(a / step);
      if (k >= m) k = m - 1;
      var phi = (k + 0.5) * step;
      return dx * Math.cos(phi) + dy * Math.sin(phi) - apothem;
    }
    // The deepest point of an edge whose two ends are outside (ternary search on the depth).
    function deepest(a, b) {
      var lo = 0;
      var hi = 1;
      for (var it = 0; it < 60; it++) {
        var t1 = lo + (hi - lo) / 3;
        var t2 = hi - (hi - lo) / 3;
        if (depth(at(a, b, t1)) <= depth(at(a, b, t2))) hi = t2;
        else lo = t1;
      }
      return at(a, b, (lo + hi) / 2);
    }

    var out = [];
    var exitAng = 0;
    var lastAng = 0;
    var sweep = 0;
    function turn(p) {
      var a = angleOf(p);
      var d = a - lastAng;
      if (d > Math.PI) d -= TWO_PI;
      else if (d <= -Math.PI) d += TWO_PI;
      sweep += d;
      lastAng = a;
    }
    function exit(p) {
      out.push(p);
      exitAng = angleOf(p);
      lastAng = exitAng;
      sweep = 0;
    }
    // The wall run: every wall vertex strictly between the exit angle and the entry angle, in
    // the direction of the outside excursion (its accumulated angle round the centre).
    function enter(p) {
      turn(p);
      var k;
      if (sweep > 0) {
        var up1 = Math.ceil((exitAng + sweep) / step) - 1;
        for (k = Math.floor(exitAng / step) + 1; k <= up1; k++) out.push(wallSegs[((k % m) + m) % m].start);
      } else if (sweep < 0) {
        var dn1 = Math.floor((exitAng + sweep) / step) + 1;
        for (k = Math.ceil(exitAng / step) - 1; k >= dn1; k--) out.push(wallSegs[((k % m) + m) % m].start);
      }
      out.push(p);
    }

    for (var c = 0; c < n; c++) {
      var ia = (first + c) % n;
      var ib = (ia + 1) % n;
      var a = points[ia];
      var b = points[ib];
      if (inside[ia]) out.push(a);
      else turn(a);
      if (inside[ia] && !inside[ib]) {
        exit(crossing(a, b));
      } else if (!inside[ia] && inside[ib]) {
        enter(crossing(b, a));
      } else if (!inside[ia] && !inside[ib]) {
        var d = deepest(a, b);
        if (MP.wallInside(wall, d.x, d.y)) {
          enter(crossing(d, a));
          exit(crossing(d, b));
        }
      }
    }

    var clean = [];
    for (var j = 0; j < out.length; j++) {
      var p = out[j];
      var q = clean.length ? clean[clean.length - 1] : null;
      if (q && Math.abs(p.x - q.x) < SAME_POINT && Math.abs(p.y - q.y) < SAME_POINT) continue;
      clean.push(p);
    }
    while (clean.length > 1 && Math.abs(clean[0].x - clean[clean.length - 1].x) < SAME_POINT &&
      Math.abs(clean[0].y - clean[clean.length - 1].y) < SAME_POINT) {
      clean.pop();
    }
    return clean.length >= 3 ? clean : null;
  }

  // -----------------------------------------------------------------------------------------
  // Classes, built on first use (P.Game and P.GameUnit do not exist at load time)
  // -----------------------------------------------------------------------------------------

  var built = null;

  function classes() {
    if (built) return built;
    var P = lib();
    var MP = P.MP;
    var Net = P.Net;

    function quantAngle(dir) {
      return Math.round((Math.atan2(dir.y, dir.x) / Math.PI) * 127 + 254) % 254;
    }

    // A square as the server describes it. The constructor commits a TerritoryBase (the stock
    // GameUnit constructor does) and removes it at once: commit and remove are balanced and the
    // polygon keeps working. From then on the geometry is real but never committed.
    class MirrorUnit extends P.GameUnit {
      constructor(game, info, ring) {
        var prev = P.Vec2.space;
        P.Vec2.space = game.space;
        try {
          super(
            game,
            info.name == null ? '' : String(info.name),
            new P.Vec2(+info.x || 0, +info.y || 0),
            ring.map(function (p) { return new P.Vec2(p.x, p.y); }),
            undefined,
            game.schemesManager
          );
        } finally {
          P.Vec2.space = prev;
        }
        this.base.remove();
        this.id = info.id;
        this.bot = !!info.bot;
        this.micro = typeof info.micro === 'number' ? info.micro : 0;
        this.ver = 0; // held ring version (u16)
        this.trail = { epoch: 0, corners: [] }; // held reliable trail corners (P.Vec2)
        this.wire = null; // the frame record the fields were last taken from
        this.inId = 0;
        this.holding = false;
        this.hold = 0;
        this.pushed = false;
        this._local = false;
        this._stable = null;
        this._stableHeld = null;
        this._stableWire = null;
      }

      // Only the page's own square (8.1): the stock "Kill" and "+x.xx%" labels need it.
      get isPlayer() {
        return this._local === true;
      }

      // new P.Polygon(points); calcPath(). Never committed.
      setRing(points) {
        var poly = new P.Polygon(points.map(function (p) { return new P.Vec2(p.x, p.y); }));
        poly.calcPath();
        this.base.polygon = poly;
        this.base.calcSquare();
      }

      ringPoints() {
        return this.base.polygon.segments.map(function (s) { return s.start; });
      }

      // A fresh polyline through the points, the way Polyline.addDistinct builds one minus the
      // commit: start and end, one Segment per step, updateBounds and the path.
      setTrail(points) {
        this.drawTrail(this.stableOf(points), []);
      }

      // The part of a trail that only changes when a batch or a frame arrives, with its
      // segments and bounds built once.
      stableOf(points) {
        var pts = [];
        var segs = [];
        var bounds = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
        var last = null;
        for (var i = 0; i < points.length; i++) {
          var p = points[i];
          if (last && last.equal(p)) continue;
          if (last) segs.push(new P.Segment(last, p));
          pts.push(p);
          if (p.x < bounds.left) bounds.left = p.x;
          if (p.x > bounds.right) bounds.right = p.x;
          if (p.y < bounds.top) bounds.top = p.y;
          if (p.y > bounds.bottom) bounds.bottom = p.y;
          last = p;
        }
        return { pts: pts, segs: segs, bounds: bounds };
      }

      // stable + the moving points (the live head, and for the own square its predicted run).
      drawTrail(stable, extra) {
        var poly = new P.Polyline(this.track);
        var pts = stable.pts;
        var segs = stable.segs.slice();
        var last = null;
        if (pts.length) {
          poly.start = pts[0];
          Object.assign(poly.bounds, stable.bounds);
          poly.path.moveTo(pts[0].x, pts[0].y);
          for (var i = 1; i < pts.length; i++) poly.path.lineTo(pts[i].x, pts[i].y);
          last = pts[pts.length - 1];
        }
        for (var k = 0; k < extra.length; k++) {
          var p = extra[k];
          if (last && last.equal(p)) continue;
          if (last) {
            segs.push(new P.Segment(last, p));
            poly.path.lineTo(p.x, p.y);
          } else {
            poly.start = p;
            poly.path.moveTo(p.x, p.y);
          }
          poly.updateBounds(p);
          last = p;
        }
        poly.segments = segs;
        poly.end = segs.length ? last : null;
        this.track.polyline = poly;
      }

      clearTrail() {
        if (this.track.polyline.start) this.track.polyline = new P.Polyline(this.track);
      }
    }

    class ClientArenaGame extends P.Game {
      constructor(config, view, space, border, skinManager, gameOverCallback, nameManager,
        controller, language, schemesManager, seed) {
        super(config, view, space, border, skinManager, gameOverCallback, nameManager,
          controller, language, schemesManager, seed);
        // The stock particle timer must not keep node (or a test) alive.
        if (this.updateParticlesId && typeof this.updateParticlesId.unref === 'function') this.updateParticlesId.unref();
        this.net = null;
        this.hud = null;
        this.onError = null; // (error, entry) for an entry that threw while applied
        this.onApplied = null; // (entry, tick) after an entry changed the mirror
        this.errors = 0;
        this.you = 0;
        this.byId = new Map();
        this.gone = new Map(); // id -> tick of its ['k']
        this.pickups = new Map(); // pid -> { pid, x, y, micro }
        this.lastCap = new Map(); // id -> { tick, gain }
        this.stake = 0;
        this.paid = false;
        this.holdTicks = MP.HOLD_TICKS;
        this.targetRadius = border.radius;
        this.shrinking = false;
        this.renderTickNow = null;
        this.lastReconcile = null;
        this.predictor = new P.Predict.Predictor({ border: border, config: config });
        this.predictAcc = 0;
        this._sentSinceReset = 0; // pp:in sent since the predictor's last reset (saturates at 256)
        this._streamAcked = false; // has a frame acked one of them yet
        this.angle = quantAngle(this.direction);
        this._frameBudget = null;
        this._crumbAcc = 0;
        this._predHomeSince = null;
      }

      attachNet(net) {
        this.net = net;
        net.sink = this;
        return this;
      }

      stop() {
        this.stopped = true;
        clearInterval(this.updateParticlesId);
        for (var i = 0; i < this.units.length; i++) this._releaseSkin(this.units[i].skin);
      }

      // The unchanged loop calls this once per animation frame, before its sub-steps: it bounds
      // the predicted ticks per FRAME (MAX_PREDICT_TICKS_PER_FRAME), not per sub-step.
      updateMetrics(frameTimeMs) {
        this._frameBudget = MP.MAX_PREDICT_TICKS_PER_FRAME;
        super.updateMetrics(frameTimeMs);
      }

      // Q (or the touch button), from the page.
      setHold(down) {
        this.predictor.setHold(!!down);
      }

      // -------------------------------------------------------------------------------------
      // Skins and units
      // -------------------------------------------------------------------------------------

      _releaseSkin(skin) {
        var sm = this.skinManager;
        if (skin && skin.name && sm && sm.usedBy && sm.usedBy[skin.name]) sm.release(skin);
      }

      // The wire skin NAME through the page's real SkinManager; any other skin when the name is
      // missing or unknown, so the renderer always finds skin.container and skin.colors.
      _skin(unit, name) {
        var sm = this.skinManager;
        var skin = null;
        try {
          if (name && sm.assets && sm.assets[name]) skin = sm.get(name);
          else skin = sm.get();
        } catch (e) {
          skin = null;
        }
        if (!skin) skin = new P.UnitSkin();
        if (unit.skin) this._releaseSkin(unit.skin);
        unit.setSkin(skin);
      }

      _addUnit(info, ring) {
        var u = new MirrorUnit(this, info, ring);
        this._skin(u, info.skin);
        this.units.push(u);
        this.byId.set(u.id, u);
        this.gone.delete(u.id);
        u.onScoreChanged();
        return u;
      }

      // Percent as the frame carries it (u16 of [0, 1]), so a ['b'] value and a frame value for
      // the same land compare equal. A change drives the stock leaderboard redraw.
      _setPercent(u, pct) {
        var q = Math.round(MP.clampPct(pct) * MP.PCT_SCALE) / MP.PCT_SCALE;
        if (u.percent !== q) {
          u.percent = q;
          u.onScoreChanged();
        }
      }

      _resolveIn(u, inId) {
        if (!inId) return null;
        if (inId === u.id) return u.base;
        var owner = this.byId.get(inId);
        return owner && !owner.death ? owner.base : null;
      }

      // Removes a square; its skin object stays on it for the labels and the burst.
      _drop(v) {
        this._releaseSkin(v.skin);
        var i = this.units.indexOf(v);
        if (i >= 0) this.units.splice(i, 1);
        if (this.byId.get(v.id) === v) this.byId.delete(v.id);
        for (var k = 0; k < this.units.length; k++) {
          if (this.units[k].in === v.base) this.units[k].in = null;
        }
      }

      _clear() {
        for (var i = 0; i < this.units.length; i++) this._releaseSkin(this.units[i].skin);
        this.units = [];
        this.byId = new Map();
        this.gone = new Map();
        this.pickups = new Map();
        this.lastCap = new Map();
        this.player = null;
        this.you = 0;
        this.labels = [];
        this.particles = [];
        this.predictAcc = 0;
        this._predHomeSince = null;
        this.topListChanged = true;
      }

      // -------------------------------------------------------------------------------------
      // Wall (8.4)
      // -------------------------------------------------------------------------------------

      // The wall follows the frame radius; when it falls, every ring reaching past it is clipped.
      _wall(r) {
        var border = this.border;
        if (!(r > 0) || Math.abs(r - border.radius) < 1 / (2 * MP.POS_SCALE)) return false;
        var fell = r < border.radius;
        border.setRadius(r);
        this.square = border.polygon.square();
        if (fell) {
          for (var i = 0; i < this.units.length; i++) this._clipUnit(this.units[i]);
        }
        return true;
      }

      _clipUnit(u) {
        var pts = u.ringPoints();
        var out = clipRing(pts, this.border);
        if (!out || out === pts) return false;
        u.setRing(out);
        return true;
      }

      // A received ring, clipped to the wall the mirror shows now (a ring can reach no further
      // than the wall that is drawn with it; for a ring the server already trimmed this changes
      // nothing).
      _clipPoints(pts) {
        var out = clipRing(pts, this.border);
        return out || pts;
      }

      // -------------------------------------------------------------------------------------
      // pp:joined (first join or resume): the whole state, applied the same way both times
      // -------------------------------------------------------------------------------------

      applyJoined(p) {
        this._clear();
        this.you = p.you | 0;
        this.stake = Number(p.stake) || 0;
        this.paid = this.stake > 0;
        if (p.holdTicks > 0) this.holdTicks = p.holdTicks;
        if (p.targetRadius > 0) this.targetRadius = p.targetRadius;
        if (p.radius > 0) {
          this.border.setRadius(p.radius);
          this.square = this.border.polygon.square();
        }
        var units = Array.isArray(p.units) ? p.units : [];
        var rings = Array.isArray(p.rings) ? p.rings : [];
        var trails = Array.isArray(p.trails) ? p.trails : [];
        for (var i = 0; i < units.length; i++) {
          var info = units[i];
          if (!info || !(info.id > 0) || this.byId.has(info.id)) continue;
          var ring;
          try {
            ring = MP.decodePoints(rings[i]);
          } catch (e) {
            ring = [];
          }
          // The payload's rings are clamped to its OWN radius on receipt (exact: same state).
          if (ring.length >= 3) ring = this._clipPoints(ring);
          else ring = P.makeCirclePoints(new P.Vec2(info.x, info.y), this.config.baseCount, this.config.baseRadius);
          var u = this._addUnit(info, ring);
          u.ver = info.ver & 0xFFFF;
          u.direction = +info.dir || 0;
          u.inId = info.inId | 0;
          var corners = [];
          try {
            corners = MP.decodePoints(trails[i]).map(function (q) { return new P.Vec2(q.x, q.y); });
          } catch (e) {
            corners = [];
          }
          u.trail = { epoch: info.epoch & 255, corners: corners };
          this._setPercent(u, info.pct);
        }
        for (var k = 0; k < this.units.length; k++) {
          var w = this.units[k];
          w.in = this._resolveIn(w, w.inId);
          w.target = new P.Vec2(Math.cos(w.direction), Math.sin(w.direction)).mulScalar(50).add(w.position);
        }
        var pickups = Array.isArray(p.pickups) ? p.pickups : [];
        for (var j = 0; j < pickups.length; j++) {
          var c = pickups[j];
          this.pickups.set(c.pid, { pid: c.pid, x: c.x, y: c.y, micro: c.micro });
        }
        var me = this.byId.get(this.you) || null;
        if (me) {
          me._local = true;
          this.player = me;
          this.direction = new P.Vec2(Math.cos(me.direction), Math.sin(me.direction));
          this.angle = quantAngle(this.direction);
          this.predictor.reset({ x: me.position.x, y: me.position.y, dir: me.direction });
          this.predictor.setHold(false);
          this._sentSinceReset = 0;
          this._streamAcked = false;
        }
      }

      // -------------------------------------------------------------------------------------
      // Reliable entries (7.2): every one idempotent
      // -------------------------------------------------------------------------------------

      applyEntry(e, tick) {
        if (!Array.isArray(e)) return false;
        var done = false;
        try {
          done = this._apply(e, tick >>> 0);
        } catch (err) {
          this.errors++;
          if (this.onError) this.onError(err, e);
          else console.error('[PAPER] mirror ' + e[0], err && err.stack ? err.stack : err);
          return false;
        }
        if (done && this.onApplied) this.onApplied(e, tick);
        return done;
      }

      _apply(e, tick) {
        var u;
        switch (e[0]) {
          case 'j': return this._join(e[1]);
          case 'k': return this._kill(e[1], e[2], e[3], tick);
          case 'm':
            u = this.byId.get(e[1]);
            if (!u || typeof e[2] !== 'number') return false;
            u.micro = e[2];
            return true;
          case 'p+':
            this.pickups.set(e[1], { pid: e[1], x: e[2], y: e[3], micro: e[4] });
            return true;
          case 'p-':
            if (!this.pickups.has(e[1])) return false;
            this.pickups.delete(e[1]);
            return true;
          case 'b': return this._ring(e[1], e[2], e[3], e[4], tick);
          case 't': return this._trail(e[1], e[2], e[3], e[4]);
          case 'cap': return this._cap(e[1], e[2], tick);
          case 'mv': return this._moved(e[1], e[2], e[3]);
          default: return false;
        }
      }

      // A known id only updates its fields (the local square is never rebuilt, so `player` is
      // always the unit in `units`). A new one gets the synthesised spawn circle, the exact call
      // spawnBot and the reseat use, so it IS the server's ring; its first ['b'] replaces it.
      _join(info) {
        if (!info || typeof info !== 'object' || !(info.id > 0)) return false;
        var u = this.byId.get(info.id);
        if (u) {
          if (info.name != null) u.name = String(info.name);
          u.bot = !!info.bot;
          if (typeof info.micro === 'number') u.micro = info.micro;
          if (info.skin && (!u.skin || u.skin.name !== info.skin)) this._skin(u, info.skin);
          return true;
        }
        if (info.id === this.you && this.player) return false;
        var c = this.config;
        var ring = P.makeCirclePoints(new P.Vec2(+info.x || 0, +info.y || 0), c.baseCount, c.baseRadius);
        u = this._addUnit(info, ring);
        u.ver = 0;
        u.trail = { epoch: 0, corners: [] };
        u.target = new P.Vec2(1, 0).mulScalar(50).add(u.position);
        this._setPercent(u, u.base.square / this.square);
        return true;
      }

      // ['k'] for an unknown id is ignored: the burst reads victim.schemes and skin (7.2).
      _kill(victimId, killerId, reason, tick) {
        var v = this.byId.get(victimId);
        if (!v) return false;
        var k = killerId ? this.byId.get(killerId) || null : null;
        if (k === v) k = null;
        if (reason !== REASON_SYSTEM_REMOVED) {
          P.spawnDeathParticles(v, null, v.track.polyline.segments);
          P.spawnDeathParticles(v, null, v.base.polygon.segments);
        }
        if (k) {
          if (k.schemes) k.schemes.kill(v, reason);
          k.statistics.kills++;
        }
        this._drop(v);
        v.death = true;
        v.killer = k || undefined;
        this.gone.set(victimId, tick);
        v.onScoreChanged();
        if (k) k.onScoreChanged();
        return true;
      }

      _ring(id, ver, pct, blob, tick) {
        ver &= 0xFFFF;
        var u = this.byId.get(id);
        if (!u) {
          var g = this.gone.get(id);
          if (g !== undefined && tick <= g) return false;
          var raw = MP.decodePoints(blob);
          if (raw.length < 3) return false;
          // A square the server never announced with a ['j'] (it sends none for a bot it
          // spawns mid-game): adopt it from its ring; the frames give it a position.
          var sx = 0;
          var sy = 0;
          for (var i = 0; i < raw.length; i++) {
            sx += raw[i].x;
            sy += raw[i].y;
          }
          u = this._addUnit({ id: id, name: '', bot: true, x: sx / raw.length, y: sy / raw.length }, this._clipPoints(raw));
          u.ver = ver;
          u.trail = { epoch: -1, corners: [] };
          this._setPercent(u, pct);
          return true;
        }
        if (!Net.verNewer(ver, u.ver)) return false;
        var pts = MP.decodePoints(blob);
        if (pts.length < 3) return false;
        u.setRing(this._clipPoints(pts));
        u.ver = ver;
        this._setPercent(u, pct);
        return true;
      }

      _trail(id, epoch, from, blob) {
        var u = this.byId.get(id);
        if (!u) return false;
        var n = Net.blobCount(blob);
        if (n < 0) return false;
        var held = u.trail;
        var m = Net.trailMerge({ epoch: held.epoch, count: held.corners.length }, epoch & 255, from | 0, n);
        if (!m) return false;
        var pts = MP.decodePoints(blob);
        var add = [];
        for (var i = m.skip; i < pts.length; i++) add.push(new P.Vec2(pts[i].x, pts[i].y));
        u.trail = { epoch: m.epoch, corners: m.reset ? add : held.corners.concat(add) };
        return true;
      }

      // The stock "+x.xx%" label through the scheme (gain is the fraction comeback multiplies by
      // 100). The same capture seen twice (the same tick and gain) shows once.
      _cap(id, gain, tick) {
        var u = this.byId.get(id);
        if (!u || typeof gain !== 'number') return false;
        var last = this.lastCap.get(id);
        if (last && (tick < last.tick || (tick === last.tick && gain === last.gain))) return false;
        this.lastCap.set(id, { tick: tick, gain: gain });
        if (u.schemes) u.schemes.comeback({ increment: gain });
        return true;
      }

      // Reseated: snap, never smooth (the new ring follows as a ['b']).
      _moved(id, x, y) {
        var u = this.byId.get(id);
        if (!u || typeof x !== 'number' || typeof y !== 'number') return false;
        u.position = new P.Vec2(x, y);
        if (u === this.player) {
          var pr = this.predictor;
          pr.state = { x: x, y: y, dir: pr.state.dir };
          pr.offset = { x: 0, y: 0, ms: 0 };
        }
        return true;
      }

      // -------------------------------------------------------------------------------------
      // Frames (on receipt): reconcile the own square (8.2)
      // -------------------------------------------------------------------------------------

      onFrame(frame) {
        if (!frame || !frame.byId) return;
        // The wall follows the NEWEST frame, so the own square is predicted against the wall the
        // server steps it against (a render-time wall lags a moving one by a quantum and turns
        // every push into a re-base). Remotes are drawn INTERP_DELAY_MS + jitterBuf behind it:
        // at SHRINK_RATE that is about one 0.5 u quantum, invisible against a square.
        this._wall(frame.radius);
        this.targetRadius = frame.targetRadius;
        this.shrinking = frame.shrinking;
        this.paid = frame.paid;
        var me = this.player;
        if (!me || me.death) return;
        var rec = frame.byId.get(me.id);
        if (!rec) return;
        me.wire = rec;
        this.predictor.ownTrail = rec.inId !== me.id ? this._stable(me).pts : null;
        this.lastReconcile = this._reconcile(rec);
      }

      // Two cases around paperPredict's reconcile, handled here (paperPredict.js is not this
      // task's file):
      // 1. After a reset (join, resume) the server keeps acking the OLD stream's last seq until
      //    it applies an input of the new one (resetInput leaves seqAck alone). Such an ack says
      //    nothing about this stream, so the frame is not compared ('stale') until an ack names
      //    a seq sent since the reset. An old ack that happens to equal a new seq costs at most
      //    a re-base, never a snap.
      // 2. A MISS (the acked seq is not in the ring: RTT over a second, an uplink stall past 64
      //    ticks) snaps to the server state. The predictor also clears its whole ring there, and
      //    then every later ack names an input predicted before the latest clear, so with RTT
      //    above one frame interval every frame misses again and prediction never comes back.
      //    The inputs newer than the ack are still in flight: they are put back and replayed
      //    from the server state, as a re-base replays, so the next in-ring ack takes the
      //    normal path again (design 8.2).
      _reconcile(rec) {
        var pr = this.predictor;
        if (this.net && this.net.resuming) return 'stale'; // the resume's pp:joined resets it all
        if (!this._streamAcked) {
          if (rec.ack >= this._sentSinceReset) return 'stale';
          this._streamAcked = true;
        }
        if (pr.entry(rec.ack)) return pr.reconcile(rec);
        var keep = [];
        for (var i = 0; i < pr.ring.length; i++) {
          var e = pr.ring[i];
          if (e && MP.seqNewer(e.seq, rec.ack)) keep.push(e);
        }
        var r = pr.reconcile(rec); // the snap: server state, offset cleared, hold release
        keep.sort(function (a, b) { return ((a.seq - rec.ack) & 255) - ((b.seq - rec.ack) & 255); });
        var s = pr.state;
        for (var k = 0; k < keep.length; k++) {
          var w = keep[k];
          s = P.Predict.step(s, w.angle, w.locked, pr.dtMs, pr.border, pr.config, pr.ownTrail);
          w.after = s;
          pr.ring[w.seq & (pr.ring.length - 1)] = w;
        }
        pr.state = s;
        return r;
      }

      // -------------------------------------------------------------------------------------
      // The tick (called by the unchanged loop): predict, apply due entries, interpolate, then
      // the cosmetic subset of the stock tick. getRenderContext is never called here.
      // -------------------------------------------------------------------------------------

      update(dtMs) {
        if (this.stopped) return false;
        if (dtMs == null) dtMs = MP.STEP_MS;
        var net = this.net;
        var now = net ? net.now() : 0;
        this._predict(dtMs);
        if (net) net.update(now); // the ping, behind this frame's inputs
        var br = null;
        if (net) {
          var rt = net.renderTick(now);
          if (rt !== null) {
            this.renderTickNow = rt;
            var due = net.takeDue(rt);
            for (var i = 0; i < due.length; i++) this.applyEntry(due[i].entry, due[i].tick);
            br = net.bracket(rt);
          }
        }
        this._placeRemotes(br);
        this._placeLocal(dtMs, now);
        this._cosmetic(dtMs);
        this.cycle++;
        return true;
      }

      // One predicted tick per STEP_MS of frame time, the server's tick period: the stock
      // readInput and quantise, then the predictor (whose step MOVES by STEP_MS +
      // PREDICT_DT_BIAS_MS, the server's mean per-tick dt), then the input is queued; all of the
      // frame's inputs leave as one pp:in. A backlog past the per-frame cap is dropped, as the
      // server drops its own. (Counting ticks at STEP_MS + bias made 59.98 inputs a second
      // against the server's 60 ticks: its FIFO ran dry once a minute, a one-tick re-base.)
      _predict(dtMs) {
        var me = this.player;
        var net = this.net;
        // No prediction while a resume is in flight: nothing could be sent (paperNet gates
        // pp:in), and the resume's pp:joined resets the predictor anyway.
        if (!me || me.death || !net || !net.seated || net.resuming) {
          this.predictAcc = 0;
          return;
        }
        var pr = this.predictor;
        var period = MP.STEP_MS;
        var budget = this._frameBudget !== null ? this._frameBudget : MP.MAX_PREDICT_TICKS_PER_FRAME;
        this.predictAcc += dtMs;
        while (this.predictAcc >= period && budget > 0) {
          this.predictAcc -= period;
          budget--;
          this.readInput(pr.dtMs);
          this.angle = quantAngle(this.direction);
          net.queueInput(pr.next(this.angle));
          if (this._sentSinceReset < 256) this._sentSinceReset++;
        }
        net.flushInputs();
        if (this._frameBudget !== null) this._frameBudget = budget;
        if (this.predictAcc >= period) this.predictAcc %= period;
      }

      // Position lerps and the heading takes the shortest arc; past the newest frame it dead
      // reckons along the heading at unit speed (capped by the net); a jump past SNAP_DIST (a
      // reseat) snaps.
      _interp(u, br) {
        var b = br.before.byId.get(u.id);
        var a = br.after ? br.after.byId.get(u.id) : null;
        var rec = b || a;
        if (!rec) return null;
        var x;
        var y;
        var dir;
        if (b && a) {
          var dx = a.x - b.x;
          var dy = a.y - b.y;
          if (dx * dx + dy * dy > MP.SNAP_DIST * MP.SNAP_DIST) {
            var pick = br.alpha < 0.5 ? b : a;
            x = pick.x;
            y = pick.y;
            dir = pick.dir;
          } else {
            var t = br.alpha;
            var turn = a.dir - b.dir;
            if (turn > Math.PI) turn -= TWO_PI;
            else if (turn < -Math.PI) turn += TWO_PI;
            x = b.x + dx * t;
            y = b.y + dy * t;
            dir = b.dir + turn * t;
          }
        } else {
          x = rec.x;
          y = rec.y;
          dir = rec.dir;
          if (b && br.extMs > 0 && !b.holding) {
            var d = (this.config.unitSpeed * br.extMs) / 1000;
            x += Math.cos(dir) * d;
            y += Math.sin(dir) * d;
          }
        }
        u.position = new P.Vec2(x, y);
        u.direction = dir;
        u.target = new P.Vec2(Math.cos(dir), Math.sin(dir)).mulScalar(50).add(u.position);
        return rec;
      }

      _fields(u, rec) {
        this._setPercent(u, rec.pct);
        u.inId = rec.inId;
        u.bot = rec.bot;
        u.holding = rec.holding;
        u.hold = rec.hold;
        u.pushed = rec.pushed;
        if (rec.micro !== U32_MAX) u.micro = rec.micro;
        u.wire = rec;
      }

      // Reliable corners + the frame tail (7.4). The tail starts where the reliable batches
      // stopped; corners already held are skipped. A newer epoch in the frame means the held
      // corners belong to a trail that is gone.
      _stable(u) {
        var held = u.trail;
        var w = u.wire;
        if (u._stable && u._stableHeld === held && u._stableWire === w) return u._stable;
        var pts;
        if (!w) {
          pts = held.corners;
        } else if (w.trailEpoch === held.epoch) {
          var tail = w.tail;
          var start = tail.length < MP.TRAIL_TAIL_MAX ? w.trailCount - tail.length : held.corners.length;
          var skip = Math.max(0, held.corners.length - start);
          pts = held.corners.slice();
          for (var k = skip; k < tail.length; k++) pts.push(new P.Vec2(tail[k].x, tail[k].y));
        } else {
          pts = w.tail.map(function (q) { return new P.Vec2(q.x, q.y); });
        }
        u._stable = u.stableOf(pts);
        u._stableHeld = held;
        u._stableWire = w;
        return u._stable;
      }

      _placeRemotes(br) {
        if (br) {
          for (var i = 0; i < this.units.length; i++) {
            var u = this.units[i];
            if (u._local) continue;
            var rec = this._interp(u, br);
            if (rec) this._fields(u, rec);
          }
          // Coins come and go by ['p+'] / ['p-']; where they lie is frame STATE (a shrinking wall
          // moves floor coins inward and sends no event for it).
          var coins = br.before.pickups;
          for (var c = 0; c < coins.length; c++) {
            var have = this.pickups.get(coins[c].pid);
            if (!have) continue;
            have.x = coins[c].x;
            have.y = coins[c].y;
            have.micro = coins[c].micro;
          }
        }
        for (var j = 0; j < this.units.length; j++) {
          var w = this.units[j];
          if (w._local) continue;
          w.in = this._resolveIn(w, w.inId);
          if (w.in === w.base) w.clearTrail();
          else w.drawTrail(this._stable(w), [w.position]);
        }
      }

      // The own square: the predictor's drawn position (zero added latency) and the own trail,
      // reliable corners + tail + predicted positions newer than the ack that lie outside the
      // own base + the drawn position (8.2).
      _placeLocal(dtMs, now) {
        var me = this.player;
        if (!me || me.death) return;
        var pr = this.predictor;
        var newest = this.net ? this.net.newest() : null;
        var rec = newest ? newest.byId.get(me.id) : null;
        if (rec) this._fields(me, rec);
        var s = pr.render(this.predictAcc, dtMs, this.angle);
        me.position = new P.Vec2(s.x, s.y);
        me.direction = s.dir;
        me.target = pr.locked()
          ? null
          : new P.Vec2(1, 0).rotate((this.angle * Math.PI) / 127).mulScalar(50).add(me.position);
        var ring = me.base.polygon;
        var extra = [];
        if (rec) {
          var seq = (rec.ack + 1) & 255;
          for (var n = 0; n < MP.INPUT_BUFFER && seq !== pr.seq; n++) {
            var e = pr.entry(seq);
            if (e && !ring.inside(e.after)) extra.push(new P.Vec2(e.after.x, e.after.y));
            seq = (seq + 1) & 255;
          }
        }
        var serverAway = rec ? rec.inId !== me.id : me.in !== me.base;
        var headOut = !ring.inside(me.position);
        var predictedHome = serverAway && !headOut;
        if (!predictedHome) this._predHomeSince = null;
        else if (this._predHomeSince === null) this._predHomeSince = now;
        var keep = serverAway && !(predictedHome && now - this._predHomeSince > PREDICTED_HOME_MS);
        if (keep || headOut || extra.length) {
          me.in = serverAway ? this._resolveIn(me, me.inId) : null;
          if (me.in === me.base) me.in = null;
          extra.push(me.position);
          me.drawTrail(serverAway ? this._stable(me) : me.stableOf([]), extra);
        } else {
          me.in = me.base;
          me.clearTrail();
        }
      }

      // The stock tick's cosmetic lines (paperGame.js:421-453, 523-525, paperGameMoves.js:375-377).
      _cosmetic(dtMs) {
        var config = this.config;
        var self = this;
        this.units.forEach(function (unit) {
          var fraction = unit.percent;
          unit.bestPercent = Math.max(unit.bestPercent, fraction);
          unit.scale = P.lerp(config.maxScale, config.minScale, P.easeOutCubic(~~(fraction * 20) / 20));
          unit.visionRange = 0.8 * (VIEW_DIAGONAL / 2 / unit.scale);
          if (unit.schemes) unit.schemes.update(dtMs);
          if (unit.labels.length) {
            var labelOffset = new P.Vec2(0, -35);
            var labelVelocity = new P.Vec2(0, -10);
            var labelOffsetStep = new P.Vec2(0, -10);
            unit.labels.forEach(function (pending) {
              self.labels.push(new P.FloatingLabel(pending.text, pending.color, pending.unit, labelOffset,
                labelVelocity, pending.time, pending.fading));
              labelOffset = labelOffset.clone().add(labelOffsetStep);
            });
            unit.labels = [];
          }
        });
        this.units.sort(function (a, b) {
          return b.schemes && a.schemes ? b.schemes.scores() - a.schemes.scores() : 0;
        });
        this.units.forEach(function (unit, index) {
          unit.top = index + 1;
        });
        this.labels = this.labels.filter(function (label) {
          label.update(dtMs);
          return label.time > 0;
        });
        this.particles.forEach(function (particle) {
          particle.update(dtMs);
        });
        var player = this.player;
        var targetScale = player ? player.scale : config.observerScale;
        this.scale += ((targetScale - this.scale) * dtMs) / (1000 * 0.4);
        // Crumbs while a square eats into someone's land, one per server tick at most.
        if (this.visible) {
          this._crumbAcc += dtMs;
          if (this._crumbAcc >= MP.STEP_MS) {
            this._crumbAcc %= MP.STEP_MS;
            for (var i = 0; i < this.units.length; i++) {
              var u = this.units[i];
              var prev = u._crumbAt;
              u._crumbAt = u.position;
              if (!prev || !u.in || u.in === u.base || !u.in.unit || !u.in.unit.skin) continue;
              var move = new P.Segment(prev, u.position);
              if (!(move.vector.magnitude() > 0)) continue;
              this.particles.push(P.Particle.emitCrumb(u, move, config.trackWidth));
            }
          }
        }
      }
    }

    built = { MirrorUnit: MirrorUnit, ClientArenaGame: ClientArenaGame, quantAngle: quantAngle };
    return built;
  }

  // -----------------------------------------------------------------------------------------
  // Boot: the mirror built like createGameApi.create (paperMain.js:77-103), with its own grid,
  // the guarded border and its own ScoreSchemeManager (paperMain.js:225).
  // opts: { view, controller, net, hud, config, skinManager, language, seed, radius, visible }
  // -----------------------------------------------------------------------------------------

  function create(opts) {
    opts = opts || {};
    var P = lib();
    var MP = P.MP;
    var C = classes();
    var config = opts.config || Object.assign({}, P.defaultPaperConfig);
    var view = opts.view || null;
    var prevSpace = P.Vec2.space;
    var space = new P.SpatialGrid(config.arenaSize, config.arenaSize, config.quadSize);
    P.Vec2.space = prevSpace === undefined ? space : prevSpace;
    var center = new P.Vec2(config.arenaSize / 2, config.arenaSize / 2);
    var border = MP.guardedBorder(center, config.borderPoints, opts.radius > 0 ? opts.radius : MP.R_MAX);
    var skinManager = opts.skinManager || new P.SkinManager(
      new P.ColorSkinPool(view ? config : undefined),
      new P.ClassicSkinPool(view ? config : undefined, view, P.skinAssetPath, P.skinsData),
      1
    );
    var language = opts.language || { defaultPlayerName: 'Player', bestTxt: 'BEST', killText: 'Kill' };
    var schemes = new P.ScoreSchemeManager(P.PercentScoreScheme);
    var game = new C.ClientArenaGame(config, view, space, border, skinManager, null, null,
      opts.controller || null, language, schemes, opts.seed === undefined ? Math.random() : opts.seed);
    skinManager.game = game;
    game.hud = opts.hud || null;
    game.visible = opts.visible === undefined ? !!view : !!opts.visible;
    game.cycle = config.prepareCounter;
    if (typeof P.renderGameFrame === 'function') {
      game.renderer = function (g) {
        P.renderGameFrame(g);
        if (g.hud && typeof g.hud.draw === 'function') g.hud.draw(g);
      };
    }
    if (opts.net) game.attachNet(opts.net);
    return game;
  }

  return {
    create: create,
    classes: classes,
    clipRing: clipRing,
    PREDICTED_HOME_MS: PREDICTED_HOME_MS
  };
});
