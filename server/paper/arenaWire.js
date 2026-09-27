'use strict';
// Server side of the Paper wire (design 7.1-7.5): per-unit streaming trail decimation, the base
// ring cache and its encode budget, the volatile frame, the join payload and pp:geo replies.
// Events go to the room through `queue(entry)`; money comes from the room through `microOf`.
const P = require('./loadPaperLib');

const MP = P.MP;

function pctOf(game, base) {
  return MP.clampPct(base.square / game.square);
}

function ringPoints(base) {
  return base.polygon.segments.map((s) => s.start);
}

class ArenaWire {
  constructor(game, { queue, microOf, holdingOf } = {}) {
    this.game = game;
    this.queue = queue || (() => {});
    this.microOf = microOf || (() => 0);
    this.holdingOf = holdingOf || ((u) => !!(u.isHuman && u.locked));
    this.state = new Map(); // unit -> per-unit wire state
    this.stats = { ringEncodes: 0, trailBatches: 0, frames: 0 };
  }

  _st(unit) {
    let st = this.state.get(unit);
    if (!st) {
      st = {
        poly: null,
        lastPt: null,
        fed: 0,
        epoch: 0,
        dec: new MP.Decimator(),
        sent: 0, // corners already in a reliable ['t']
        sentVer: undefined, // ring version last queued as ['b']
        seenVer: undefined, // wireVer when the carve baseline was taken
        seenSquare: 0,
        seenSegs: 0,
        cache: null // { ver, blob, pct }
      };
      this.state.set(unit, st);
    }
    return st;
  }

  // The streaming trail: new raw polyline points go through the decimator once. A new polyline
  // (return, death, recoverTail, reseat) or a rewind that cut points already fed resets it.
  _feedTrail(unit, st) {
    const poly = unit.track.polyline;
    const segs = poly.segments;
    const count = poly.start ? segs.length + 1 : 0;
    const pointAt = (i) => (i === 0 ? poly.start : segs[i - 1].end);
    const reset = poly !== st.poly || count < st.fed || (st.fed > 0 && pointAt(st.fed - 1) !== st.lastPt);
    if (reset && (st.poly !== null || st.fed > 0)) st.epoch = (st.epoch + 1) & 255;
    if (reset) {
      st.poly = poly;
      st.fed = 0;
      st.lastPt = null;
      st.dec = new MP.Decimator();
      st.sent = 0;
    }
    for (let i = st.fed; i < count; i++) {
      const p = pointAt(i);
      st.dec.push(p.x, p.y);
      st.lastPt = p;
    }
    st.fed = count;
  }

  // A carve (the base changed and the sim did not bump) bumps wireVer; a plain trim does not.
  _noteCarve(unit, st) {
    const base = unit.base;
    const segs = base.polygon.segments.length;
    if (st.seenVer === base.wireVer && (base.square !== st.seenSquare || segs !== st.seenSegs)) {
      const trimmedOnly = base._trimTick === this.game.tick &&
        base._preTrimSquare === st.seenSquare && base._preTrimSegs === st.seenSegs;
      if (!trimmedOnly) base.wireVer++;
    }
    st.seenVer = base.wireVer;
    st.seenSquare = base.square;
    st.seenSegs = segs;
  }

  _encodeRing(unit, st) {
    const base = unit.base;
    if (st.cache && st.cache.ver === base.wireVer) return st.cache;
    const blob = MP.encodePoints(MP.decimateRing(ringPoints(base), MP.RING_TOL));
    st.cache = { ver: base.wireVer, blob, pct: pctOf(this.game, base) };
    this.stats.ringEncodes++;
    return st.cache;
  }

  // Once per tick, in the room's post pass after pickups, graces and holds.
  feed() {
    const game = this.game;
    const units = game.units;
    for (const [unit] of this.state) if (unit.death || units.indexOf(unit) === -1) this.state.delete(unit);
    let budget = MP.RING_ENCODES_PER_TICK;
    for (const unit of units) {
      const st = this._st(unit);
      this._feedTrail(unit, st);
      this._noteCarve(unit, st);
      if (st.sentVer !== unit.base.wireVer && budget > 0) {
        const fresh = !(st.cache && st.cache.ver === unit.base.wireVer);
        const c = this._encodeRing(unit, st);
        if (fresh) budget--;
        this.queue(['b', unit.id, c.ver & 0xFFFF, c.pct, c.blob]);
        st.sentVer = c.ver;
      }
    }
    if (game.tick % MP.TRAIL_BATCH_TICKS === 0) {
      for (const unit of units) {
        const st = this.state.get(unit);
        const corners = st.dec.corners;
        if (corners.length > st.sent) {
          this.queue(['t', unit.id, st.epoch, st.sent, MP.encodePoints(corners.slice(st.sent))]);
          st.sent = corners.length;
          this.stats.trailBatches++;
        }
      }
    }
  }

  _frameUnit(unit) {
    const game = this.game;
    const st = this._st(unit);
    const inBase = unit.in;
    return {
      id: unit.id,
      x: unit.position.x,
      y: unit.position.y,
      dir: unit.direction,
      bot: !unit.isHuman,
      holding: this.holdingOf(unit),
      pushed: unit._pushedTick === game.tick,
      holdTicks: unit.isHuman ? unit.holdTicks : 0,
      ack: unit.isHuman ? unit.seqAck : 0,
      trailEpoch: st.epoch,
      pct: pctOf(game, unit.base),
      inId: inBase ? (inBase === unit.base ? unit.id : inBase.unit ? inBase.unit.id : 0) : 0,
      baseVer: st.sentVer === undefined ? 0 : st.sentVer,
      trailCount: st.dec.corners.length,
      micro: this.microOf(unit.id),
      tail: st.dec.corners.slice(st.sent)
    };
  }

  // The volatile pp:s frame: ONE encode per arena per snapshot tick.
  frame(pickups) {
    const game = this.game;
    this.stats.frames++;
    return MP.encodeFrame({
      tick: game.tick,
      radius: game.border.radius,
      targetRadius: game.targetRadius,
      shrinking: game.shrinking,
      paid: game.paid,
      units: game.units.map((u) => this._frameUnit(u)),
      pickups: pickups || []
    });
  }

  // The state part of pp:joined, built from live state in the same turn as the join (5.6).
  // Rings reuse the cache; trails carry the corners already sent reliably (the frame tail
  // carries the rest, exactly as for existing members).
  joinPayload() {
    const game = this.game;
    const units = [];
    const rings = [];
    const trails = [];
    for (const unit of game.units) {
      const st = this._st(unit);
      this._feedTrail(unit, st);
      this._noteCarve(unit, st);
      const ring = this._encodeRing(unit, st);
      const inBase = unit.in;
      units.push({
        id: unit.id,
        name: unit.name,
        skin: unit.skin ? unit.skin.name : null,
        bot: !unit.isHuman,
        x: unit.position.x,
        y: unit.position.y,
        dir: unit.direction,
        inId: inBase ? (inBase === unit.base ? unit.id : inBase.unit ? inBase.unit.id : 0) : 0,
        micro: this.microOf(unit.id),
        pct: ring.pct,
        ver: ring.ver & 0xFFFF,
        epoch: st.epoch
      });
      rings.push(ring.blob);
      trails.push(MP.encodePoints(st.dec.corners.slice(0, st.sent)));
    }
    return { tick: game.tick, radius: game.border.radius, targetRadius: game.targetRadius, units, rings, trails };
  }

  // Reply to pp:need { id } (0 = everything): the ring and the reliable corners.
  geo(id) {
    const ev = [];
    for (const unit of this.game.units) {
      if (id && unit.id !== id) continue;
      const st = this._st(unit);
      const ring = this._encodeRing(unit, st);
      ev.push(['b', unit.id, ring.ver & 0xFFFF, ring.pct, ring.blob]);
      ev.push(['t', unit.id, st.epoch, 0, MP.encodePoints(st.dec.corners.slice(0, st.sent))]);
    }
    return { tick: this.game.tick, ev };
  }
}

module.exports = { ArenaWire, pctOf };
