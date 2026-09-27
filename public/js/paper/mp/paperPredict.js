// Paper multiplayer: the pure own-square predictor (design 8.2). One predicted tick is the
// server's exact movement for a human: the stock getMovement with the same guarded border, the
// same push and the same steering target, at STEP_MS + PREDICT_DT_BIAS_MS. Reconciliation
// compares the server's acked state with the stored prediction for that seq and replays.
// Needs the solo modules and paperWire at CALL time; loads standalone under require.
(function (root, factory) {
  'use strict';
  var api = factory(root);
  var P = root.DuelPaperLib = root.DuelPaperLib || {};
  P.Predict = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  function lib() {
    var P = root.DuelPaperLib;
    if (!P || !P.Game || !P.MP) throw new Error('paperPredict: load the solo paper modules and paperWire first');
    return P;
  }

  // Proper crossing of segment a-b with any segment of `trail` (points), ignoring the trail tip
  // the push piece starts from.
  function crossesTrail(ax, ay, bx, by, trail) {
    for (var i = 0; i + 1 < trail.length; i++) {
      var p = trail[i];
      var q = trail[i + 1];
      if (i + 2 === trail.length && q.x === ax && q.y === ay) continue;
      var rx = bx - ax, ry = by - ay, sx = q.x - p.x, sy = q.y - p.y;
      var den = rx * sy - ry * sx;
      if (Math.abs(den) < 1e-15) continue;
      var t = ((p.x - ax) * sy - (p.y - ay) * sx) / den;
      var u = ((p.x - ax) * ry - (p.y - ay) * rx) / den;
      if (t > 1e-9 && t <= 1 && u >= 0 && u <= 1) return true;
    }
    return false;
  }

  // One predicted tick. state { x, y, dir } -> { x, y, dir, pushed }.
  function step(state, angleByte, locked, dtMs, border, config, ownTrail) {
    var P = lib();
    var MP = P.MP;
    border.resetGuard();
    var pos = new P.Vec2(state.x, state.y);
    var target = locked ? null : new P.Vec2(1, 0).rotate((angleByte * Math.PI) / 127).mulScalar(50).add(pos);
    var unit = {
      position: pos,
      direction: state.dir,
      target: target,
      smoothness: undefined,
      movement: function () {
        return this.target && this.target.clone().sub(this.position).normalize();
      }
    };
    var ctx = { config: config, border: border };
    var pushed = false;
    if (!MP.wallInside(border, pos.x, pos.y)) {
      // The server's candidate rule (9.3) against the mirror's own trail when there is one.
      var cands = MP.PUSH_TWIST_CANDIDATES;
      var chosen = MP.pushPoint(border, pos.x, pos.y, cands[0]);
      if (ownTrail && ownTrail.length > 1) {
        for (var c = 0; c < cands.length; c++) {
          var at = MP.pushPoint(border, pos.x, pos.y, cands[c]);
          if (!crossesTrail(pos.x, pos.y, at.x, at.y, ownTrail)) { chosen = at; break; }
        }
      }
      var pt = new P.Vec2(chosen.x, chosen.y);
      unit.position = pt;
      if (target) unit.target = target.clone().add(pt).sub(pos);
      pushed = true;
      border.resetGuard();
    }
    var pieces = P.Game.prototype.getMovement.call(ctx, dtMs, unit);
    var end = pieces.length ? pieces[pieces.length - 1].end : unit.position;
    return { x: end.x, y: end.y, dir: unit.direction, pushed: pushed };
  }

  // The client side of the input FIFO: one predicted tick and one pp:in per tick, a 64-entry
  // ring keyed by seq, reconciliation on every frame, and a decaying visual offset.
  function Predictor(opts) {
    var P = lib();
    this.MP = P.MP;
    this.border = opts.border;
    this.config = opts.config;
    this.dtMs = opts.dtMs || P.MP.STEP_MS + P.MP.PREDICT_DT_BIAS_MS;
    this.ownTrail = null;
    this.ring = new Array(P.MP.INPUT_BUFFER);
    this.stats = { rebases: 0, snaps: 0, compares: 0 };
    this.reset({ x: 0, y: 0, dir: 0 });
  }

  Predictor.prototype.reset = function (state) {
    this.state = { x: state.x, y: state.y, dir: state.dir };
    this.seq = 0; // the next seq to send
    for (var i = 0; i < this.ring.length; i++) this.ring[i] = null;
    this.offset = { x: 0, y: 0, ms: 0 };
    this.holdKey = false;
    this.holdSeq = -1;
    this.releasedByServer = false;
  };

  // Q (or the touch button). The local lock is released only by the key or by a frame that
  // confirms the server is not holding, never by a client timer.
  Predictor.prototype.setHold = function (down) {
    if (down && !this.holdKey) {
      this.holdSeq = this.seq;
      this.releasedByServer = false;
    }
    if (!down) this.releasedByServer = false;
    this.holdKey = !!down;
  };

  Predictor.prototype.locked = function () {
    return this.holdKey && !this.releasedByServer;
  };

  // One predicted tick. Returns the pp:in integer to send.
  Predictor.prototype.next = function (angleByte) {
    var MP = this.MP;
    var hold = this.holdKey;
    var locked = this.locked();
    this.state = step(this.state, angleByte, locked, this.dtMs, this.border, this.config, this.ownTrail);
    var seq = this.seq & 255;
    this.ring[seq & (this.ring.length - 1)] = { seq: seq, angle: angleByte, hold: hold, locked: locked, after: this.state };
    this.seq = (this.seq + 1) & 255;
    return MP.encodeInput(seq, angleByte, hold);
  };

  Predictor.prototype.entry = function (ack) {
    var e = this.ring[ack & (this.ring.length - 1)];
    return e && e.seq === ack ? e : null;
  };

  // own: the decoded frame unit { x, y, dir, ack, holding }. Returns 'ok' | 'rebase' | 'snap'.
  Predictor.prototype.reconcile = function (own) {
    var MP = this.MP;
    this.stats.compares++;
    if (this.holdKey && !own.holding && this.holdSeq >= 0 && MP.seqNewer(own.ack, this.holdSeq)) {
      this.releasedByServer = true;
    }
    var e = this.entry(own.ack);
    if (!e) {
      this.stats.snaps++;
      this.state = { x: own.x, y: own.y, dir: own.dir };
      for (var i = 0; i < this.ring.length; i++) this.ring[i] = null;
      this.offset = { x: 0, y: 0, ms: 0 };
      return 'snap';
    }
    var dx = own.x - e.after.x;
    var dy = own.y - e.after.y;
    var err = Math.sqrt(dx * dx + dy * dy);
    var dd = Math.abs(MP.wrapAngle(own.dir) - MP.wrapAngle(e.after.dir));
    dd = Math.min(dd, Math.PI * 2 - dd);
    if (err < MP.RECONCILE_POS_EPS && dd < MP.RECONCILE_DIR_EPS) return 'ok';
    var before = this.state;
    var s = { x: own.x, y: own.y, dir: own.dir };
    e.after = s;
    // Replay every stored input after the ack, each with its own stored hold/lock.
    var seq = (own.ack + 1) & 255;
    for (var n = 0; n < this.ring.length; n++) {
      if (seq === this.seq) break;
      var r = this.entry(seq);
      if (!r) break;
      s = step(s, r.angle, r.locked, this.dtMs, this.border, this.config, this.ownTrail);
      r.after = s;
      seq = (seq + 1) & 255;
    }
    this.state = s;
    if (err > MP.SNAP_DIST) {
      this.stats.snaps++;
      this.offset = { x: 0, y: 0, ms: 0 };
      return 'snap';
    }
    this.stats.rebases++;
    this.offset = { x: before.x - s.x, y: before.y - s.y, ms: MP.VISUAL_DECAY_MS };
    return 'rebase';
  };

  // The drawn position: a scratch step of the remainder (zero added latency) plus the decaying
  // correction offset. Never mutates the predicted state.
  Predictor.prototype.render = function (remainderMs, frameMs, angleByte) {
    var MP = this.MP;
    if (frameMs) this.offset.ms = Math.max(0, this.offset.ms - frameMs);
    var k = this.offset.ms > 0 ? this.offset.ms / MP.VISUAL_DECAY_MS : 0;
    var s = remainderMs > 0
      ? step(this.state, angleByte, this.locked(), remainderMs, this.border, this.config, this.ownTrail)
      : this.state;
    return { x: s.x + this.offset.x * k, y: s.y + this.offset.y * k, dir: s.dir };
  };

  return { step: step, Predictor: Predictor, crossesTrail: crossesTrail };
});
