// Paper multiplayer: the ONE shared constants block, the binary wire codec, the guarded arena
// border and the wire decimator. The same file runs on the server (require) and in the
// browser (classic script), so the encoder and the decoder can never disagree. It needs
// nothing at load time; guardedBorder looks the solo modules up only when it is called.
// Design: docs/paper-multiplayer-design.md sections 2, 4.3, 7 and 9.1-9.2.
(function (root, factory) {
  'use strict';
  var MP = factory(root);
  var P = root.DuelPaperLib = root.DuelPaperLib || {};
  P.MP = MP;
  if (typeof module === 'object' && module.exports) module.exports = MP;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  // -----------------------------------------------------------------------------------------
  // Shared constants (design section 2). Every new number lives here and nowhere else.
  // -----------------------------------------------------------------------------------------

  var STEP_MS = 1000 / 60;
  var HOLD_MS = 3000;
  var PUSH_TWIST = 0.001;

  var MP = {
    STEP_MS: STEP_MS,
    MAX_STEPS_PER_WAKE: 4,
    SNAPSHOT_EVERY: 2,
    TRAIL_BATCH_TICKS: 6,
    MAX_HUMANS: 16,
    MAX_ARENAS_PER_STAKE: 8,
    FREE_BOTS_IDLE: 15,
    FREE_SQUARES: 16,
    HOLD_MS: HOLD_MS,
    HOLD_TICKS: Math.round(HOLD_MS / STEP_MS),
    HOLD_INPUT_STALE_MS: 500,
    DISCONNECT_GRACE_MS: 5000,
    PICKUP_SWEEP_MS: 3600000,
    UNIT_ID_MAX: 65535,
    HOUSE_CUT_DIV: 10,
    PICKUP_RADIUS: 16,
    PICKUP_WALL_INSET: 12,
    R_MAX: 950,
    R_MIN: 475,
    N_FULL: 16,
    N_BASE: 4,
    GROW_RATE: 60,
    SHRINK_RATE: 4,
    SHRINK_DELAY_MS: 3000,
    RADIUS_QUANTUM: 0.5,
    PUSH_INSET: 0.5,
    PUSH_TWIST: PUSH_TWIST,
    PUSH_TWIST_CANDIDATES: [1 * PUSH_TWIST, -1 * PUSH_TWIST, 2 * PUSH_TWIST],
    BORDER_GUARD_CALLS: 12,
    SPAWN_TRIES: 60,
    SPAWN_AXIS_GUARD: 0.5,
    // Not a number: names the rule applyInputs follows (design 4.4).
    BOT_LEVEL_SOURCE: 'max-live-human-percent',
    SPAWN_SAFE_LOOKAHEAD: 3,
    SPAWN_SAFE_MARGIN: 60,
    TRIM_MAX_PER_TICK: 4,
    TRIM_MIN_AREA: 200,
    TRIM_MAX_EDGE: 20,
    TRIM_INVALID_LIMIT: 20,
    RESEAT_AFTER_MS: 3000,
    TRAIL_TOL: 0.35,
    TRAIL_MAX_GAP: 40,
    TRAIL_TAIL_MAX: 4,
    RING_TOL: 0.4,
    RING_ENCODES_PER_TICK: 3,
    INTERP_DELAY_MS: 70,
    MAX_JITTER_BUF_MS: 180,
    DEAD_RECKON_MS: 200,
    PREDICT_DT_BIAS_MS: 0.005,
    RECONCILE_POS_EPS: 0.5,
    RECONCILE_DIR_EPS: 0.5 * Math.PI / 180,
    SNAP_DIST: 40,
    VISUAL_DECAY_MS: 100,
    INPUT_BUFFER: 64,
    // The server's per-seat input FIFO is a small jitter buffer: a starve (no input queued at a
    // tick) leaves one more input queued for good, so the depth grows to what the network needs;
    // when the depth never fell below INPUT_TRIM_DEPTH for INPUT_TRIM_TICKS, the oldest input is
    // dropped (one tick less input delay). INPUT_QUEUE_MAX is only the hard cap (drop-oldest).
    INPUT_QUEUE_MAX: 8,
    INPUT_TRIM_DEPTH: 3,
    INPUT_TRIM_TICKS: 120,
    // One pp:in message carries every input a client frame predicted (an integer for one, an
    // array for more): a second volatile emit in the same task would be thrown away.
    INPUT_BATCH_MAX: 8,
    MAX_PREDICT_TICKS_PER_FRAME: 4,
    RESYNC_AFTER_MS: 500,
    WARM_CHUNK: 100,
    ARENA_SWEEP_MS: 300000,
    EMERGENCY_FAIL_TICKS: 3,
    // Wire scales (design section 2, last row).
    POS_SCALE: 32,
    PCT_SCALE: 65535,
    DIR_SCALE: 65536,
    // Wire format version byte and fixed sizes (design 7.1).
    WIRE_VERSION: 1,
    FRAME_HEADER_BYTES: 12,
    FRAME_UNIT_BYTES: 25,
    FRAME_PICKUP_BYTES: 10,
    // Input integer: an angle byte covers a full turn in 254 steps (rotate(angle * PI / 127)).
    ANGLE_STEPS: 254,
    INPUT_HOLD_BIT: 1
  };

  var TWO_PI = Math.PI * 2;
  var U16_MAX = 65535;
  var U32_MAX = 4294967295;

  // -----------------------------------------------------------------------------------------
  // Scalars
  // -----------------------------------------------------------------------------------------

  function clamp(lo, hi, v) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  // Arena radius for n live squares: 950 * sqrt(n / 16), clamped to [475, 950] (brief).
  function radiusFor(n) {
    var count = n > 0 ? n : 0;
    return clamp(MP.R_MIN, MP.R_MAX, MP.R_MAX * Math.sqrt(count / MP.N_FULL));
  }

  // unit.direction is unbounded radians; the wire wants [0, 2PI).
  function wrapAngle(rad) {
    var w = rad % TWO_PI;
    if (w < 0) w += TWO_PI;
    return w >= TWO_PI ? 0 : w;
  }

  // NaN and negatives give 0, above 1 gives 1: setUint16 would otherwise wrap 1.2 to 0.2.
  function clampPct(pct) {
    if (!(pct > 0)) return 0;
    return pct > 1 ? 1 : pct;
  }

  function moneyU32(micro) {
    if (!(micro > 0)) return 0;
    return micro >= U32_MAX ? U32_MAX : Math.floor(micro);
  }

  function posU16(v) {
    var q = Math.round(v * MP.POS_SCALE);
    return q < 0 || !(q === q) ? 0 : q > U16_MAX ? U16_MAX : q;
  }

  function dirU16(rad) {
    return Math.round(wrapAngle(rad) / TWO_PI * MP.DIR_SCALE) & 0xFFFF;
  }

  function holdByte(holdTicks) {
    if (!(holdTicks > 0)) return 0;
    if (holdTicks >= MP.HOLD_TICKS) return 255;
    return Math.floor(holdTicks * 255 / MP.HOLD_TICKS);
  }

  // -----------------------------------------------------------------------------------------
  // Input integer: (seq & 255) << 16 | angle << 8 | flags, angle 0..253, flags bit0 = HOLD
  // -----------------------------------------------------------------------------------------

  function angleToByte(rad) {
    return Math.round(wrapAngle(rad) * 127 / Math.PI) % MP.ANGLE_STEPS;
  }

  function byteToAngle(angle) {
    return angle * Math.PI / 127;
  }

  function encodeInput(seq, angle, hold) {
    return ((seq & 255) << 16) | ((angle & 255) << 8) | (hold ? MP.INPUT_HOLD_BIT : 0);
  }

  // Null for anything a legit client never sends; the caller drops it silently.
  function decodeInput(n) {
    if (!Number.isInteger(n) || n < 0 || n > 0xFFFFFF) return null;
    var angle = (n >> 8) & 255;
    if (angle > MP.ANGLE_STEPS - 1) return null;
    return { seq: (n >> 16) & 255, angle: angle, hold: (n & MP.INPUT_HOLD_BIT) !== 0 };
  }

  // True when seq a is newer than b on the 8-bit ring (a half-ring window).
  function seqNewer(a, b) {
    var d = (a - b) & 255;
    return d > 0 && d < 128;
  }

  // -----------------------------------------------------------------------------------------
  // Byte helpers: node hands socket payloads over as Buffer, browsers as ArrayBuffer
  // -----------------------------------------------------------------------------------------

  function viewOf(buf) {
    if (buf instanceof ArrayBuffer) return new DataView(buf);
    if (ArrayBuffer.isView(buf)) return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    throw new Error('paperWire: not a binary payload');
  }

  // -----------------------------------------------------------------------------------------
  // Volatile frame pp:s (design 7.1)
  // -----------------------------------------------------------------------------------------

  function tailCount(unit) {
    var n = unit.tail ? unit.tail.length : 0;
    return n > MP.TRAIL_TAIL_MAX ? MP.TRAIL_TAIL_MAX : n;
  }

  function frameSize(units, pickups) {
    var size = MP.FRAME_HEADER_BYTES + MP.FRAME_PICKUP_BYTES * pickups.length;
    for (var i = 0; i < units.length; i++) size += MP.FRAME_UNIT_BYTES + 4 * tailCount(units[i]);
    return size;
  }

  // frame: { tick, radius, targetRadius, shrinking, paid, units: [...], pickups: [...] }
  // unit:  { id, x, y, dir, bot, holding, pushed, holdTicks, ack, trailEpoch, pct, inId, baseVer,
  //          trailCount, micro, tail: [{x, y}] }   (only the first TRAIL_TAIL_MAX tail corners go)
  // pickup: { pid, x, y, micro }
  function encodeFrame(frame) {
    var units = frame.units || [];
    var pickups = frame.pickups || [];
    if (units.length > 255 || pickups.length > 255) throw new Error('paperWire: frame too large');
    var buf = new ArrayBuffer(frameSize(units, pickups));
    var dv = new DataView(buf);
    var o = 0;
    dv.setUint8(o, MP.WIRE_VERSION); o += 1;
    dv.setUint8(o, (frame.shrinking ? 1 : 0) | (frame.paid ? 2 : 0)); o += 1;
    dv.setUint32(o, frame.tick >>> 0, true); o += 4;
    dv.setUint16(o, posU16(frame.radius), true); o += 2;
    dv.setUint16(o, posU16(frame.targetRadius), true); o += 2;
    dv.setUint8(o, units.length); o += 1;
    dv.setUint8(o, pickups.length); o += 1;
    for (var i = 0; i < units.length; i++) {
      var u = units[i];
      dv.setUint16(o, u.id & 0xFFFF, true); o += 2;
      dv.setUint16(o, posU16(u.x), true); o += 2;
      dv.setUint16(o, posU16(u.y), true); o += 2;
      dv.setUint16(o, dirU16(u.dir), true); o += 2;
      dv.setUint8(o, (u.bot ? 1 : 0) | (u.holding ? 2 : 0) | (u.pushed ? 4 : 0)); o += 1;
      dv.setUint8(o, holdByte(u.holdTicks)); o += 1;
      dv.setUint8(o, (u.ack | 0) & 255); o += 1;
      dv.setUint8(o, (u.trailEpoch | 0) & 255); o += 1;
      dv.setUint16(o, Math.round(clampPct(u.pct) * MP.PCT_SCALE), true); o += 2;
      dv.setUint16(o, (u.inId | 0) & 0xFFFF, true); o += 2;
      dv.setUint16(o, (u.baseVer | 0) & 0xFFFF, true); o += 2;
      dv.setUint16(o, clamp(0, U16_MAX, u.trailCount | 0), true); o += 2;
      dv.setUint32(o, moneyU32(u.micro), true); o += 4;
      var tn = tailCount(u);
      dv.setUint8(o, tn); o += 1;
      for (var t = 0; t < tn; t++) {
        dv.setUint16(o, posU16(u.tail[t].x), true); o += 2;
        dv.setUint16(o, posU16(u.tail[t].y), true); o += 2;
      }
    }
    for (var j = 0; j < pickups.length; j++) {
      var p = pickups[j];
      dv.setUint16(o, p.pid & 0xFFFF, true); o += 2;
      dv.setUint16(o, posU16(p.x), true); o += 2;
      dv.setUint16(o, posU16(p.y), true); o += 2;
      dv.setUint32(o, moneyU32(p.micro), true); o += 4;
    }
    return buf;
  }

  function decodeFrame(buf) {
    var dv = viewOf(buf);
    var S = MP.POS_SCALE;
    var o = 0;
    var version = dv.getUint8(o); o += 1;
    if (version !== MP.WIRE_VERSION) throw new Error('paperWire: frame version ' + version);
    var hflags = dv.getUint8(o); o += 1;
    var frame = {
      tick: dv.getUint32(o, true),
      shrinking: (hflags & 1) !== 0,
      paid: (hflags & 2) !== 0,
      radius: 0,
      targetRadius: 0,
      units: [],
      pickups: []
    };
    o += 4;
    frame.radius = dv.getUint16(o, true) / S; o += 2;
    frame.targetRadius = dv.getUint16(o, true) / S; o += 2;
    var nUnits = dv.getUint8(o); o += 1;
    var nPickups = dv.getUint8(o); o += 1;
    for (var i = 0; i < nUnits; i++) {
      var u = {};
      u.id = dv.getUint16(o, true); o += 2;
      u.x = dv.getUint16(o, true) / S; o += 2;
      u.y = dv.getUint16(o, true) / S; o += 2;
      u.dir = dv.getUint16(o, true) / MP.DIR_SCALE * TWO_PI; o += 2;
      var fl = dv.getUint8(o); o += 1;
      u.bot = (fl & 1) !== 0;
      u.holding = (fl & 2) !== 0;
      u.pushed = (fl & 4) !== 0;
      u.hold = dv.getUint8(o) / 255; o += 1;
      u.ack = dv.getUint8(o); o += 1;
      u.trailEpoch = dv.getUint8(o); o += 1;
      u.pct = dv.getUint16(o, true) / MP.PCT_SCALE; o += 2;
      u.inId = dv.getUint16(o, true); o += 2;
      u.baseVer = dv.getUint16(o, true); o += 2;
      u.trailCount = dv.getUint16(o, true); o += 2;
      u.micro = dv.getUint32(o, true); o += 4;
      var tn = dv.getUint8(o); o += 1;
      u.tail = [];
      for (var t = 0; t < tn; t++) {
        u.tail.push({ x: dv.getUint16(o, true) / S, y: dv.getUint16(o + 2, true) / S });
        o += 4;
      }
      frame.units.push(u);
    }
    for (var j = 0; j < nPickups; j++) {
      frame.pickups.push({
        pid: dv.getUint16(o, true),
        x: dv.getUint16(o + 2, true) / S,
        y: dv.getUint16(o + 4, true) / S,
        micro: dv.getUint32(o + 6, true)
      });
      o += MP.FRAME_PICKUP_BYTES;
    }
    return frame;
  }

  // -----------------------------------------------------------------------------------------
  // Ring and trail blobs: u16 count, then count x (u16 x*32, u16 y*32)
  // -----------------------------------------------------------------------------------------

  function encodePoints(points) {
    var n = points.length;
    if (n > U16_MAX) throw new Error('paperWire: too many points');
    var buf = new ArrayBuffer(2 + 4 * n);
    var dv = new DataView(buf);
    dv.setUint16(0, n, true);
    for (var i = 0, o = 2; i < n; i++, o += 4) {
      dv.setUint16(o, posU16(points[i].x), true);
      dv.setUint16(o + 2, posU16(points[i].y), true);
    }
    return buf;
  }

  function decodePoints(buf) {
    var dv = viewOf(buf);
    var n = dv.getUint16(0, true);
    var out = new Array(n);
    for (var i = 0, o = 2; i < n; i++, o += 4) {
      out[i] = { x: dv.getUint16(o, true) / MP.POS_SCALE, y: dv.getUint16(o + 2, true) / MP.POS_SCALE };
    }
    return out;
  }

  // -----------------------------------------------------------------------------------------
  // One binary attachment per message. pp:joined, pp:ev and pp:geo carry a ring or trail blob
  // per unit; socket.io sends each ArrayBuffer as its own attachment, and socket.io-parser 4.2.6
  // (the node client, and any future browser bundle) refuses a packet with more than 10. So the
  // sender packs every blob into ONE buffer, $bin, and leaves { $b: [offset, length] } in place;
  // the receiver swaps them back. A payload with no $bin passes through unpackBin untouched.
  // -----------------------------------------------------------------------------------------

  function isBinary(v) {
    return v instanceof ArrayBuffer || (ArrayBuffer.isView(v) && !(v instanceof DataView));
  }

  function packBin(payload) {
    var parts = [];
    var total = 0;
    function walk(v) {
      if (isBinary(v)) {
        var u8 = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
        var ref = { $b: [total, u8.byteLength] };
        parts.push(u8);
        total += u8.byteLength;
        return ref;
      }
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') {
        var o = {};
        for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) o[k] = walk(v[k]);
        return o;
      }
      return v;
    }
    var out = walk(payload);
    if (!parts.length) return payload;
    var bin = new Uint8Array(total);
    for (var i = 0, off = 0; i < parts.length; i++) {
      bin.set(parts[i], off);
      off += parts[i].byteLength;
    }
    out.$bin = bin.buffer;
    return out;
  }

  function unpackBin(payload) {
    if (!payload || typeof payload !== 'object' || !payload.$bin) return payload;
    var raw = payload.$bin;
    var u8 = raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    function walk(v) {
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') {
        if (Array.isArray(v.$b) && v.$b.length === 2) {
          var o0 = v.$b[0] | 0;
          var n0 = v.$b[1] | 0;
          if (o0 < 0 || n0 < 0 || o0 + n0 > u8.byteLength) throw new Error('paperWire: bad blob ref');
          return u8.slice(o0, o0 + n0).buffer;
        }
        var o = {};
        for (var k in v) if (k !== '$bin' && Object.prototype.hasOwnProperty.call(v, k)) o[k] = walk(v[k]);
        return o;
      }
      return v;
    }
    return walk(payload);
  }

  // -----------------------------------------------------------------------------------------
  // Decimation (design 7.3, 7.4). A streaming chord test: a raw point becomes a corner when the
  // chord from the last corner to the newest point would leave any point since that corner
  // more than `tol` away, or when the newest point lies more than `maxGap` past the corner.
  // The points since the corner are held (at most maxBuffer), so every raw point stays within
  // `tol` of the output polyline, not just the newest one.
  // -----------------------------------------------------------------------------------------

  function distToSegmentSq(px, py, ax, ay, bx, by) {
    var dx = bx - ax;
    var dy = by - ay;
    var len2 = dx * dx + dy * dy;
    var t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    var qx = ax + dx * t - px;
    var qy = ay + dy * t - py;
    return qx * qx + qy * qy;
  }

  class Decimator {
    constructor(tol, maxGap, maxBuffer) {
      this.tol = tol === undefined ? MP.TRAIL_TOL : tol;
      this.maxGap = maxGap === undefined ? MP.TRAIL_MAX_GAP : maxGap;
      this.maxBuffer = maxBuffer || 64;
      this.corners = [];
      this.pending = [];
    }

    // Starts a fresh polyline whose first corner is (x, y).
    reset(x, y) {
      this.corners = [{ x: x, y: y }];
      this.pending = [];
    }

    // Feeds one raw point; returns the number of corners committed by it (0 or 1).
    push(x, y) {
      if (!this.corners.length) {
        this.reset(x, y);
        return 1;
      }
      var pending = this.pending;
      if (!pending.length) {
        pending.push({ x: x, y: y });
        return 0;
      }
      var c = this.corners[this.corners.length - 1];
      var gx = x - c.x;
      var gy = y - c.y;
      var split = pending.length >= this.maxBuffer || gx * gx + gy * gy > this.maxGap * this.maxGap;
      if (!split) {
        var tol2 = this.tol * this.tol;
        for (var i = 0; i < pending.length; i++) {
          if (distToSegmentSq(pending[i].x, pending[i].y, c.x, c.y, x, y) > tol2) {
            split = true;
            break;
          }
        }
      }
      if (!split) {
        pending.push({ x: x, y: y });
        return 0;
      }
      this.corners.push(pending[pending.length - 1]);
      this.pending = [{ x: x, y: y }];
      return 1;
    }

    // The newest raw point (the live end of the polyline), or the last corner.
    head() {
      return this.pending.length ? this.pending[this.pending.length - 1] : this.corners[this.corners.length - 1];
    }
  }

  // A closed ring decimated once per version. Vertex 0 always stays; the chord test runs round
  // the ring and back to vertex 0, whose repeat is dropped.
  function decimateRing(points, tol) {
    var n = points.length;
    if (n < 4) return points.map(function (p) { return { x: p.x, y: p.y }; });
    var d = new Decimator(tol === undefined ? MP.RING_TOL : tol, Infinity, 64);
    d.reset(points[0].x, points[0].y);
    for (var i = 1; i < n; i++) d.push(points[i].x, points[i].y);
    d.push(points[0].x, points[0].y);
    var out = d.corners;
    if (out.length < 3) {
      // A sliver thinner than tol: keep three spread vertices so it is still a ring.
      return [points[0], points[Math.floor(n / 3)], points[Math.floor(2 * n / 3)]].map(function (p) {
        return { x: p.x, y: p.y };
      });
    }
    return out;
  }

  // -----------------------------------------------------------------------------------------
  // Wall (design 9.2): O(1) inside test for the circular n-gon built by P.makeCirclePoints,
  // which starts at angle 0 and steps 2PI / n, so wall edge k spans angles [k, k+1] * 2PI / n.
  // wall: { center: {x, y}, radius, pointCount }. Tolerance 1e-6 counts as inside.
  // -----------------------------------------------------------------------------------------

  var WALL_TOL = 1e-6;

  function wallInside(wall, x, y) {
    var cx = wall.center.x;
    var cy = wall.center.y;
    var r = wall.radius;
    var n = wall.pointCount;
    var dx = x - cx;
    var dy = y - cy;
    var d2 = dx * dx + dy * dy;
    var apothem = r * Math.cos(Math.PI / n);
    if (d2 <= apothem * apothem) return true;
    if (d2 > (r + WALL_TOL) * (r + WALL_TOL)) return false;
    var step = TWO_PI / n;
    var a = Math.atan2(dy, dx);
    if (a < 0) a += TWO_PI;
    var k = Math.floor(a / step);
    if (k >= n) k = n - 1;
    var ax = Math.cos(k * step) * r;
    var ay = Math.sin(k * step) * r;
    var bx = Math.cos((k + 1) * step) * r;
    var by = Math.sin((k + 1) * step) * r;
    var ex = bx - ax;
    var ey = by - ay;
    // Counter-clockwise ring: inside is on the left of every edge.
    var cross = ex * (dy - ay) - ey * (dx - ax);
    return cross / Math.sqrt(ex * ex + ey * ey) >= -WALL_TOL;
  }

  // Push target (design 9.3): the point at apothem - PUSH_INSET on the radial through (x, y),
  // rotated by `twist` radians, so it is never an exact symmetric coordinate. Shared by the
  // server's getMovement and the client predictor.
  function pushPoint(wall, x, y, twist) {
    var cx = wall.center.x;
    var cy = wall.center.y;
    var a = Math.atan2(y - cy, x - cx) + twist;
    var d = wall.radius * Math.cos(Math.PI / wall.pointCount) - MP.PUSH_INSET;
    return { x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d };
  }

  // -----------------------------------------------------------------------------------------
  // Guarded border (design 4.3). Built at CALL time from the solo modules.
  // -----------------------------------------------------------------------------------------

  function guardedBorder(center, pointCount, radius, space) {
    var P = root.DuelPaperLib;
    if (!P || !P.ArenaBorder || !P.makeCirclePoints || !P.Polygon) {
      throw new Error('paperWire.guardedBorder: load the solo paper modules first');
    }
    var border = P.ArenaBorder.circular(center, pointCount, radius);
    var stockIntersections = border.intersections;
    border.pointCount = pointCount;
    border.space = space || null;
    border.guardCalls = 0;
    border.guardTrips = 0;
    border.apothem = 0;
    border.orientation = 0;

    // The stock `while (wallHits.length)` slide loop cannot be interrupted, so this cap is the
    // only guard against its exact-vertex hang. Callers reset it before every movement step.
    border.intersections = function (seg) {
      if (this.guardCalls >= MP.BORDER_GUARD_CALLS) {
        this.guardTrips++;
        return [];
      }
      this.guardCalls++;
      return stockIntersections.call(this, seg);
    };

    border.resetGuard = function () {
      this.guardCalls = 0;
    };

    // With a space the vertex OBJECTS are the registered ones wherever a point already sits at
    // that location, so a trail that slid along an earlier wall never meets a twin point.
    border.setRadius = function (r) {
      this.radius = r;
      var pts = P.makeCirclePoints(this.center, this.pointCount, r);
      var grid = this.space;
      if (grid) pts = pts.map(function (p) { return grid.checkPoint(p); });
      this.polygon = new P.Polygon(pts);
      this.polygon.calcPath();
      this.apothem = r * Math.cos(Math.PI / this.pointCount);
      var area2 = 0;
      for (var i = 0; i < pts.length; i++) {
        var a = pts[i];
        var b = pts[i + 1 < pts.length ? i + 1 : 0];
        area2 += a.x * b.y - b.x * a.y;
      }
      this.orientation = area2 > 0 ? 1 : area2 < 0 ? -1 : 0;
      return this;
    };

    border.inside = function (x, y) {
      return wallInside(this, x, y);
    };

    border.setRadius(radius);
    return border;
  }

  MP.clamp = clamp;
  MP.radiusFor = radiusFor;
  MP.wrapAngle = wrapAngle;
  MP.clampPct = clampPct;
  MP.moneyU32 = moneyU32;
  MP.holdByte = holdByte;
  MP.angleToByte = angleToByte;
  MP.byteToAngle = byteToAngle;
  MP.encodeInput = encodeInput;
  MP.decodeInput = decodeInput;
  MP.seqNewer = seqNewer;
  MP.frameSize = frameSize;
  MP.encodeFrame = encodeFrame;
  MP.decodeFrame = decodeFrame;
  MP.encodePoints = encodePoints;
  MP.decodePoints = decodePoints;
  MP.distToSegmentSq = distToSegmentSq;
  MP.packBin = packBin;
  MP.unpackBin = unpackBin;
  MP.Decimator = Decimator;
  MP.decimateRing = decimateRing;
  MP.wallInside = wallInside;
  MP.pushPoint = pushPoint;
  MP.guardedBorder = guardedBorder;
  return MP;
});
