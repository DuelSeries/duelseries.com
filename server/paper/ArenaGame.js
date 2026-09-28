'use strict';
// The server-run Paper arena (design section 4): the STOCK solo simulation, extended by
// prototype overrides in this file only, so the solo game stays byte-identical to the build
// that passed the golden runs. Humans steer from one input byte each, bots hunt the nearest
// human, the wall follows the head count (paid) and pushes squares in, and every death is
// reported once through hooks.onDeath for the room to settle the money.
const P = require('./loadPaperLib');

const MP = P.MP;

const REASON = {
  SELF_CROSS: 1,
  WALL: 2,
  TRACK_CUT: 3,
  EXIT_POINT_CAPTURED: 4,
  ENCIRCLED: 5,
  SYSTEM_REMOVED: 6,
  CASHOUT: 7,
  DISCONNECT: 8,
  LEAVE: 9,
  FORCED_EXIT: 10
};

// How long after the wall's last inward step the wall rule still cuts back instead of killing:
// two shrink quanta (a quantum every 125 ms at SHRINK_RATE).
const SHRINK_VETO_MS = 250;

const NOOP_HOOKS = {
  onDeath() {},
  afterTick() {},
  onRadius() {},
  onReseat() {},
  idReserved() { return false; }
};

// A human square. No money and no wallet here: the room's bank owns those.
class ArenaHuman extends P.GameUnit {
  constructor(game, name, position, basePoints, schemesManager) {
    super(game, name, position, basePoints, undefined, schemesManager);
    this.isHuman = true;
    this.angle = 0;
    this.seqAck = 0;
    this.holdBit = false;
    this.lastInputAt = 0;
    this.locked = false;
    this.holdTicks = 0;
    this.socketId = null;
    this._pushPiece = null;
    this._inPush = false;
    this._fifo = [];
    this._lastSeq = -1;
    // End points of trail pieces laid by a push. The player never drew those pieces, so
    // crossing one is the shrink's doing and must not kill (brief rule 6).
    this._pushEnds = new WeakSet();
    this._selfHit = null;
    // Remember which own-trail segment a crossing hit, for the veto in ArenaGame.kill.
    const track = this.track;
    const stock = track.handleIntersect;
    track.handleIntersect = function (hit, movingUnit, moveSeg) {
      if (movingUnit === this.unit) this.unit._selfHit = hit;
      try {
        return stock.call(this, hit, movingUnit, moveSeg);
      } finally {
        this.unit._selfHit = null;
      }
    };
  }

  // PlayerUnit's steering (paperUnits.js:446-449) from this human's own byte. A null target
  // makes movement() falsy, so getMovement returns no pieces: that IS the cash-out lock.
  update(dtMs) {
    super.update(dtMs);
    this.target = this.locked
      ? null
      : new P.Vec2(1, 0).rotate((this.angle * Math.PI) / 127).mulScalar(50).add(this.position);
  }
}

// Does `piece` (starting where `prev` ends) run back along `prev`, ending within FOLD_EPS of
// its line? A real turn, however sharp, ends well off the line and stays simple.
const FOLD_EPS = 1e-5;
function foldsBack(prev, piece) {
  const vx = prev.end.x - prev.start.x;
  const vy = prev.end.y - prev.start.y;
  const wx = piece.end.x - piece.start.x;
  const wy = piece.end.y - piece.start.y;
  if (vx * wx + vy * wy >= 0) return false;
  const len = Math.hypot(vx, vy);
  if (!(len > 0)) return false;
  const off = Math.abs(vx * (piece.end.y - prev.start.y) - vy * (piece.end.x - prev.start.x)) / len;
  return off <= FOLD_EPS;
}

// The loop stock handleReturn builds (paperGameMoves.js, the ring between the trail's two
// ends, reversed, then the trail) has |area| under FLAT_AREA: the capture is ambiguous. Measured in
// the soak: flat loops about 1e-12 u2, the smallest real capture 0.005 u2.
const FLAT_AREA = 1e-6;
function flatReturn(unit) {
  const trail = unit.track.polyline;
  const ring = unit.base.polygon;
  const first = trail.start;
  const last = trail.end;
  if (!first || !last) return false;
  const fromIdx = ring.segments.findIndex((seg) => seg.start === first);
  const toIdx = ring.segments.findIndex((seg) => seg.start === last);
  if (fromIdx < 0 || toIdx < 0) return false;
  const lo = Math.min(fromIdx, toIdx);
  const hi = Math.max(fromIdx, toIdx);
  const trailPts = [trail.start];
  for (const seg of trail.segments) trailPts.push(seg.end);
  if (lo !== fromIdx) trailPts.reverse();
  const loop = [];
  for (let i = hi - 1; i > lo; i--) loop.push(ring.segments[i].start);
  for (const p of trailPts) loop.push(p);
  let sum = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[i + 1 < loop.length ? i + 1 : 0];
    sum += (a.x + b.x) * (b.y - a.y);
  }
  return Math.abs(sum / 2) < FLAT_AREA;
}

class ArenaGame extends P.Game {
  constructor(config, view, space, border, skinManager, gameOverCallback, nameManager,
    controller, language, schemesManager, seed) {
    super(config, view, space, border, skinManager, gameOverCallback, nameManager,
      controller, language, schemesManager, seed);
    this.stake = 0;
    this.paid = false;
    this.hooks = Object.assign({}, NOOP_HOOKS);
    this.trim = null;
    this.humans = [];
    this.byId = new Map();
    this._nextId = 1;
    this._prey = null;
    this.nowMs = 0;
    this.tick = 0;
    this.rCont = border.radius;
    this.targetRadius = border.radius;
    this._lowerSince = null;
    this.shrinking = false;
    this._lastShrinkAt = -Infinity;
    this.stats.pushCrossings = 0;
    this.stats.shrinkVetoes = 0;
    this.stats.foldCuts = 0;
    this.stats.flatReturns = 0;
    this.stats.despiked = 0;
  }

  // Bots read game.player; here it is the prey the per-bot wrap hands them (4.5). The stock
  // constructor's `this.player = null` lands in the no-op setter.
  get player() {
    return this._prey || null;
  }

  set player(value) {}

  setup({ stake, hooks, trim } = {}) {
    this.stake = stake > 0 ? stake : 0;
    this.paid = this.stake > 0;
    this.hooks = Object.assign({}, NOOP_HOOKS, hooks || {});
    this.trim = trim || null;
    return this;
  }

  // Vec2.space is one process-wide static; every mutator points it at this arena first.
  _enter() {
    P.Vec2.space = this.space;
  }

  // -----------------------------------------------------------------------------------------
  // Tick
  // -----------------------------------------------------------------------------------------

  update(dtMs) {
    if (this.stopped) return false;
    this._enter();
    if (dtMs == null) dtMs = MP.STEP_MS;
    this.nowMs += dtMs;
    this.tick++;
    this.applyInputs();
    this.stepRadius(dtMs);
    const ok = super.update(dtMs);
    this.trimDirtyBases();
    if (!this.paid) this.perHumanMagnet();
    this.hooks.afterTick(this);
    // Stock pushes one entry per tick and never reads it.
    const units = this.units;
    for (let i = 0; i < units.length; i++) units[i].log.length = 0;
    return ok;
  }

  // One queued input per human per tick, never two; an empty queue repeats the last input.
  applyInputs() {
    let best = -1;
    for (const h of this.humans) {
      if (h.death) continue;
      const next = h._fifo.shift();
      if (next) {
        h.angle = next.angle;
        h.holdBit = next.hold;
        h.seqAck = next.seq;
      }
      if (h.percent > best) best = h.percent;
    }
    if (!this.paid) {
      this.config.botsCount = this.humans.length > 0 ? MP.FREE_SQUARES : MP.FREE_BOTS_IDLE;
      // BOT_LEVEL_SOURCE: the leading live human's land, else the reference's no-player level.
      this.config.botLevel = best >= 0 ? P.lerp(this.config.startBotLevel, 1, best) : -1;
    }
  }

  // Queues one input. `at` is the room's wall clock, for the stale-hold rule.
  setInput(id, seq, angle, holdBit, at) {
    const u = this.byId.get(id);
    if (!u || !u.isHuman || u.death) return false;
    if (!Number.isInteger(seq) || seq < 0 || seq > 255) return false;
    if (!Number.isInteger(angle) || angle < 0 || angle >= MP.ANGLE_STEPS) return false;
    if (u._lastSeq >= 0 && !MP.seqNewer(seq, u._lastSeq)) return false;
    u._lastSeq = seq;
    u._fifo.push({ seq, angle, hold: !!holdBit });
    if (u._fifo.length > MP.INPUT_QUEUE_MAX) u._fifo.shift();
    if (at !== undefined) u.lastInputAt = at;
    return true;
  }

  // A resumed seat starts a fresh input stream.
  resetInput(id) {
    const u = this.byId.get(id);
    if (!u || !u.isHuman) return false;
    u._fifo = [];
    u._lastSeq = -1;
    u.holdBit = false;
    return true;
  }

  // -----------------------------------------------------------------------------------------
  // Radius (design 9.1)
  // -----------------------------------------------------------------------------------------

  radiusTarget() {
    return this.paid ? MP.radiusFor(this.units.length) : MP.R_MAX;
  }

  stepRadius(dtMs) {
    const target = this.radiusTarget();
    this.targetRadius = target;
    const cur = this.rCont;
    let next = cur;
    let shrinkingNow = false;
    if (target > cur) {
      this._lowerSince = null;
      next = Math.min(target, cur + (MP.GROW_RATE * dtMs) / 1000);
    } else if (target < cur) {
      if (this._lowerSince === null) this._lowerSince = this.nowMs;
      if (this.nowMs - this._lowerSince >= MP.SHRINK_DELAY_MS) {
        next = Math.max(target, cur - (MP.SHRINK_RATE * dtMs) / 1000);
        shrinkingNow = true;
      }
    } else {
      this._lowerSince = null;
    }
    this.rCont = next;

    // The applied wall moves in RADIUS_QUANTUM steps, landing exactly on the target at the end.
    const applied = this.border.radius;
    const Q = MP.RADIUS_QUANTUM;
    let want = applied;
    if (next >= applied + Q) want = applied + Math.floor((next - applied) / Q) * Q;
    else if (next <= applied - Q) want = applied - Math.floor((applied - next) / Q) * Q;
    if (next === target && Math.abs(target - want) < Q) want = target;
    if (want !== applied) this._applyRadius(want, applied);

    if (this.shrinking && !shrinkingNow) this._shrinkEnd();
    this.shrinking = shrinkingNow;
  }

  _applyRadius(r, prev) {
    this.border.setRadius(r);
    this.square = this.border.polygon.square();
    if (r < prev) {
      this._lastShrinkAt = this.nowMs;
      // Every base whose bounding box reaches past the wall's apothem may now stick out.
      const c = this.border.center;
      const ap2 = this.border.apothem * this.border.apothem;
      for (const u of this.units) {
        const b = u.base.polygon.bounds;
        const dx = Math.max(Math.abs(b.left - c.x), Math.abs(b.right - c.x));
        const dy = Math.max(Math.abs(b.top - c.y), Math.abs(b.bottom - c.y));
        if (dx * dx + dy * dy > ap2) {
          u.base._trimDirty = true;
          u.base._wallTouched = true;
        }
      }
    }
    this.hooks.onRadius(r, prev);
  }

  // The shrink stopped: re-send every ring the wall touched, once (7.3).
  _shrinkEnd() {
    for (const u of this.units) {
      const b = u.base;
      if (b._wallTouched) {
        b._wallTouched = false;
        b.wireVer++;
      }
    }
  }

  // Test and ops helper: set the wall at once (no easing).
  setRadiusNow(r) {
    this._enter();
    const prev = this.border.radius;
    this.rCont = r;
    if (r !== prev) this._applyRadius(r, prev);
  }

  // -----------------------------------------------------------------------------------------
  // Movement, push and the push-piece veto (design 9.3)
  // -----------------------------------------------------------------------------------------

  getMovement(dtMs, unit) {
    const border = this.border;
    border.resetGuard();
    unit._pushPiece = null;
    unit._moveHalted = false;
    unit._curMove = null;
    if (MP.wallInside(border, unit.position.x, unit.position.y)) {
      return (unit._moveQueue = this._cutFold(unit, super.getMovement(dtMs, unit), 0));
    }
    const piece = this._pushPieceFor(unit);
    unit._pushPiece = piece;
    unit._pushedTick = this.tick;
    // The rest of the step runs from the push target with the steering target moved by the
    // same offset, so the heading the square asked for is kept (a stale target would bend the
    // heading back across the push piece).
    const saved = unit.position;
    const savedTarget = unit.target;
    unit.position = piece.end;
    if (savedTarget) unit.target = savedTarget.clone().add(piece.end).sub(saved);
    let rest;
    try {
      border.resetGuard();
      rest = super.getMovement(dtMs, unit);
    } finally {
      unit.position = saved;
      unit.target = savedTarget;
    }
    rest.unshift(piece);
    return (unit._moveQueue = this._cutFold(unit, rest, 1));
  }

  // A square pressed square-on into the wall slides a hair one way and then the other, so a
  // piece can run straight back along the trail piece before it (soak probe: the end lands
  // under 1e-6 u off that piece, on its far side, and the next push piece crosses it at a point
  // the geometry snaps to the tip, so nothing sees the crossing). Such a fold is cut: the
  // pieces from the fold on are dropped and the square rests for this tick. Only inside the
  // wall-rule veto window (wall moving, or under SHRINK_VETO_MS since its last step) and within
  // 5 u of the wall, where the stock kill for running back along the trail is vetoed anyway
  // (rewind and halt, the same rest); on a static wall the stock rules stay exactly as solo.
  // `from` skips the push piece, which must always carry the square inside.
  _cutFold(unit, pieces, from) {
    if (!(this.shrinking || this.nowMs - this._lastShrinkAt < SHRINK_VETO_MS)) return pieces;
    const c = this.space.center;
    if (this.border.radius - unit.position.distance(c) >= 5) return pieces;
    let prev = null;
    if (from === 0 && unit.in !== unit.base) {
      const segs = unit.track.polyline.segments;
      if (segs.length) prev = segs[segs.length - 1];
    } else if (from > 0) {
      prev = pieces[from - 1];
    }
    for (let i = from; i < pieces.length; i++) {
      const piece = pieces[i];
      if (prev && foldsBack(prev, piece)) {
        pieces.length = i;
        this.stats.foldCuts++;
        break;
      }
      prev = piece;
    }
    return pieces;
  }

  // The first twist of PUSH_TWIST_CANDIDATES whose piece does not cross the unit's own trail;
  // if all cross, +PUSH_TWIST anyway (the unit must be inside after this tick) and the veto
  // in kill keeps it alive.
  _pushPieceFor(unit) {
    const pos = unit.position;
    const polyline = unit.track.polyline;
    const tip = polyline.end;
    let first = null;
    for (const twist of MP.PUSH_TWIST_CANDIDATES) {
      const at = MP.pushPoint(this.border, pos.x, pos.y, twist);
      const cand = new P.Segment(pos, new P.Vec2(at.x, at.y));
      if (!first) first = cand;
      if (!polyline.segments.length) {
        unit._pushEnds && unit._pushEnds.add(cand.end);
        return cand;
      }
      const hits = this.space.intersections(cand);
      let crosses = false;
      for (let i = 0; i < hits.length; i++) {
        if (hits[i].segment.shape === polyline && hits[i].point !== tip) {
          crosses = true;
          break;
        }
      }
      if (!crosses) {
        unit._pushEnds && unit._pushEnds.add(cand.end);
        return cand;
      }
    }
    this.stats.pushCrossings++;
    unit._pushEnds && unit._pushEnds.add(first.end);
    return first;
  }

  dispatchBucket(bucket, unit, move) {
    if (unit._moveHalted) return undefined; // a vetoed retrace stopped this square for the tick
    unit._curMove = move;
    unit._inPush = move === unit._pushPiece;
    try {
      return super.dispatchBucket(bucket, unit, move);
    } finally {
      unit._inPush = false;
    }
  }

  kill(victim, killer, reason) {
    if (victim.death) return; // one capture can call kill twice for one victim
    if (this._shrinkMadeCross(victim, killer, reason)) {
      // The push never kills, and neither does crossing a piece a push laid; the rewind keeps
      // the trail simple.
      const hit = victim._selfHit;
      const cut = this.rewindTrail(victim);
      // An OVERLAY hit means this move runs back along the trail (a square pressed into a wall
      // corner: the wall slide folds the step back on itself). The rest of the move would lay
      // the fold again after the cut, so the square stops at the cut for the rest of this tick
      // (soak probe: a folded trail, then a spiked ring after the capture). Never on the push
      // piece: that one must still carry the square inside the wall.
      if (cut && hit && hit.overlay === true && !victim._inPush) this._haltMove(victim);
      return;
    }
    if (reason === REASON.SYSTEM_REMOVED && victim.isHuman) return; // never evict a human
    const at = { x: victim.position.x, y: victim.position.y };
    if (victim.isHuman) {
      victim.locked = false;
      victim.holdTicks = 0;
    }
    super.kill(victim, killer, reason);
    if (!victim.death) return;
    this.byId.delete(victim.id);
    if (victim.isHuman) {
      const i = this.humans.indexOf(victim);
      if (i >= 0) this.humans.splice(i, 1);
      // This tick's spawn step must already see the new head count.
      if (!this.paid) this.config.botsCount = this.humans.length > 0 ? MP.FREE_SQUARES : MP.FREE_BOTS_IDLE;
    }
    this.hooks.onDeath(victim, killer && !killer.death ? killer : undefined, reason, at);
  }

  // Own-trail crossings the shrink caused (brief rule 6, the shrink never kills), for humans
  // with no killer: (a) the push piece itself; (b) any move across a trail piece a push laid;
  // (c) the wall rule (reason 2, a self-cross within 5 u of the wall) while the wall is moving
  // in and for SHRINK_VETO_MS after its last step: the push walks a presser along the wall and
  // a square pressed into a wall corner dies by the stock rule (probed), so near a moving wall
  // the trail is cut back instead. On a static wall every stock rule kills exactly as solo.
  _shrinkMadeCross(victim, killer, reason) {
    if (killer || !victim.isHuman) return false;
    if (reason !== REASON.WALL && reason !== REASON.SELF_CROSS) return false;
    if (victim._inPush) return true;
    const hit = victim._selfHit;
    if (hit && hit.segment && victim._pushEnds.has(hit.segment.end)) return true;
    if (reason === REASON.WALL && (this.shrinking || this.nowMs - this._lastShrinkAt < SHRINK_VETO_MS)) {
      this.stats.shrinkVetoes++;
      return true;
    }
    return false;
  }

  // Ends this square's movement for the tick at its (rewound) trail tip: the move being
  // dispatched ends there (stock handleUnitMovements appends move.end, a no-op for the tip
  // itself), its remaining hits are skipped and the queued pieces are dropped.
  _haltMove(unit) {
    const move = unit._curMove;
    if (!move) return;
    unit._moveHalted = true;
    move.end = unit.position;
    if (unit._moveQueue) unit._moveQueue.length = 0;
  }

  // Only from the veto: the stock intersect already moved the unit to the crossing X and the
  // move will still append its end, so cut the trail back to X first (design 4.4). The kept
  // segments stay the SAME objects, so hits of the rest of this move on them are still
  // dispatched; only the cut-off segments are removed (their pending hits are skipped).
  rewindTrail(unit) {
    const track = unit.track;
    const poly = track.polyline;
    const X = unit.position;
    const segs = poly.segments;
    if (!segs.length) return false;
    let cut = -1;
    let xIsVertex = false;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (s.start === X || s.start.equal(X)) { cut = i; xIsVertex = true; break; }
      if (s.end === X || s.end.equal(X)) { cut = i + 1; xIsVertex = true; break; }
      if (MP.distToSegmentSq(X.x, X.y, s.start.x, s.start.y, s.end.x, s.end.y) <= 1e-12) { cut = i; break; }
    }
    if (cut < 0) return false;
    while (segs.length > cut) segs.pop().remove();
    poly.end = segs.length ? segs[segs.length - 1].end : null;
    if (xIsVertex) unit.position = poly.end || poly.start;
    else poly.addDistinct(X);
    // Rebuild what add() keeps incrementally: bounds, length, and the stock decimated copy
    // (paperTerritory.js UnitTrack.add: the first three points stay, then a point closer than
    // 25 u to the one before last replaces the last).
    const pts = [poly.start];
    for (const s of segs) pts.push(s.end);
    poly.bounds = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
    let length = 0;
    const coarse = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      poly.updateBounds(p);
      if (i > 0) length += pts[i - 1].distance(p);
      if (coarse.length > 2 && p.distanceSq(coarse[coarse.length - 2]) < 625) coarse[coarse.length - 1] = p;
      else coarse.push(p);
    }
    track.length = length;
    track.simplified = coarse;
    track.intersections = track.intersections.filter((rec) => pts.some((p) => p === rec.point || p.equal(rec.point)));
    // `in` = the base of the last surviving enter with no later exit for that base.
    const lastEnter = new Map();
    let order = 0;
    for (const rec of track.intersections) {
      for (const e of rec.intersections) {
        order++;
        if (e.enter) lastEnter.set(e.base, order);
        else lastEnter.delete(e.base);
      }
    }
    let inBase = null;
    let inOrder = -1;
    for (const [base, o] of lastEnter) {
      if (o > inOrder && base.unit && !base.unit.death && base !== unit.base) {
        inBase = base;
        inOrder = o;
      }
    }
    unit.in = inBase;
    unit._rewoundTick = this.tick;
    return true;
  }

  // The stock safety net (paperGameMoves.js:137-149), run for every human.
  recoverTail() {
    for (const me of this.humans) {
      if (me.death || me.in != me.base || me.base.polygon.inside(me.position)) continue;
      const here = me.position;
      const nearest = me.base.polygon.segments.reduce(function (best, cand) {
        return best.start.distanceSq(here) < cand.start.distanceSq(here) ? best : cand;
      });
      const toVertex = nearest.start.clone().sub(me.position);
      const gap = toVertex.magnitude();
      me.position = toVertex.mulScalar(1 + 1 / gap).add(me.position);
      me.track.remove();
    }
  }

  handleReturn(unit) {
    if (!unit.death && flatReturn(unit)) {
      // The trail came home along the base's own edge (a slide along a wall run the trim or an
      // earlier capture laid): it encloses no land, and the stock sign test on a zero-area loop
      // is noise, so it could keep the sliver as the whole base (soak probe: a 1759-edge base
      // became 7 edges). Nothing is captured; the exit and entry points already sit in the ring.
      this.events.returns++;
      this.stats.flatReturns++;
      if (unit.base) {
        unit.base._trimDirty = true;
        unit.base.wireVer++;
      }
      return undefined;
    }
    const r = super.handleReturn(unit);
    if (!unit.death && unit.base) this._despike(unit.base, unit.track.polyline);
    if (unit.base) {
      unit.base._trimDirty = true;
      unit.base.wireVer++;
    }
    return r;
  }

  // A trail that left home along the ring's own edge (a slide out of a wall corner along a wall
  // run) is merged by the capture as a zero-width spike: the ring runs out along a line and
  // straight back (soak probe: 51 -> 52 -> 53 collinear within 1e-13). Each spike tip that only
  // this ring uses (and the returning trail, which the stock caller removes right after) is
  // dropped (no area changes), until none is left. Any other ring is untouched.
  _despike(base, trail) {
    const ring = base.polygon;
    const verts = ring.segments.map((seg) => seg.start);
    const own = (v) => v.segments.every((seg) => seg.shape === ring || seg.shape === trail);
    let dropped = 0;
    for (let guard = 0; guard < verts.length && verts.length > 3; guard++) {
      let hit = -1;
      for (let i = 0; i < verts.length; i++) {
        const u = verts[(i + verts.length - 1) % verts.length];
        const v = verts[i];
        const w = verts[(i + 1) % verts.length];
        if ((v.equal(u) || foldsBack({ start: u, end: v }, { start: v, end: w })) && own(v)) {
          hit = i;
          break;
        }
      }
      if (hit < 0) break;
      verts.splice(hit, 1);
      dropped++;
    }
    if (!dropped || verts.length < 3) return;
    const old = ring.segments;
    const byStart = new Map(old.map((seg) => [seg.start, seg]));
    const fresh = [];
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i];
      const b = verts[(i + 1) % verts.length];
      const kept = byStart.get(a);
      fresh.push(kept && kept.end === b ? kept : new P.Segment(a, b).commit(ring));
    }
    const keep = new Set(fresh);
    for (const seg of old) if (!keep.has(seg)) seg.remove();
    ring.segments = fresh;
    base.calcSquare();
    ring.calcPath();
    this.stats.despiked += dropped;
  }

  // THE ONE RULE: a paid arena never has bots.
  // And never more than FREE_BOTS_IDLE bots: the stock type rows have 15 entries, so a 16th
  // bot would get an undefined type.
  spawnBot(mode) {
    if (this.paid) return;
    let bots = 0;
    for (const u of this.units) if (u instanceof P.BotUnit) bots++;
    if (bots >= MP.FREE_BOTS_IDLE) return;
    return super.spawnBot(mode);
  }

  addUnit(unit) {
    unit.id = this._allocId();
    this.byId.set(unit.id, unit);
    if (unit.base && unit.base.wireVer === undefined) unit.base.wireVer = 1;
    super.addUnit(unit);
    if (unit instanceof P.BotUnit) this._wrapBot(unit);
  }

  // 1..UNIT_ID_MAX, wrapping, never 0, never a live unit's id or one the room reserves.
  _allocId() {
    for (let tries = 0; tries < MP.UNIT_ID_MAX; tries++) {
      const id = this._nextId;
      this._nextId = id >= MP.UNIT_ID_MAX ? 1 : id + 1;
      if (!this.byId.has(id) && !this.hooks.idReserved(id)) return id;
    }
    throw new Error('ArenaGame: no free unit id');
  }

  // -----------------------------------------------------------------------------------------
  // Bots hunt humans (design 4.5)
  // -----------------------------------------------------------------------------------------

  _wrapBot(bot) {
    const stock = bot.update;
    const game = this;
    bot.update = function (dtMs) {
      game._prey = game.nearestHuman(this);
      try {
        return stock.call(this, dtMs);
      } finally {
        game._prey = null;
        if (this.fsm && this.fsm.state !== 'attack') this._preyHint = null;
      }
    };
  }

  nearestHuman(bot) {
    const hint = bot._preyHint;
    if (hint && !hint.death) return hint;
    bot._preyHint = null;
    let best = null;
    let bestD = Infinity;
    for (const h of this.humans) {
      if (h.death) continue;
      const d = h.position.distanceSq(bot.position);
      if (d < bestD) {
        bestD = d;
        best = h;
      }
    }
    return best;
  }

  // The stock long-trail magnet (paperGame.js:502-522), once per live human.
  perHumanMagnet() {
    const limit = this.config.botAttackTrackLength;
    for (const human of this.humans) {
      if (human.death || !(human.track.length > limit)) continue;
      let nearestBot = null;
      let nearestDist = Infinity;
      for (const bot of this.units) {
        if (!(bot instanceof P.BotUnit)) continue;
        let dist = Infinity;
        for (const point of human.track.simplified) {
          const d2 = point.distanceSq(bot.position);
          if (d2 < dist) dist = d2;
        }
        dist = Math.sqrt(dist);
        if (dist < nearestDist) {
          nearestBot = bot;
          nearestDist = dist;
        }
      }
      if (!nearestBot) continue;
      nearestBot._preyHint = human;
      this._prey = human;
      try {
        nearestBot.fsm.change('attack');
      } finally {
        this._prey = null;
      }
    }
  }

  // -----------------------------------------------------------------------------------------
  // Seats, spawn, removal
  // -----------------------------------------------------------------------------------------

  // Pure query (design 9.6): a spawn point off both centre lines and inside the radius the
  // arena would have with SPAWN_SAFE_LOOKAHEAD fewer squares. Null when none was found.
  findSpawn(nAfter) {
    const n = nAfter === undefined ? this.units.length + 1 : nAfter;
    const c = this.border.center;
    const limit = this.paid
      ? MP.radiusFor(Math.max(MP.N_BASE, n - MP.SPAWN_SAFE_LOOKAHEAD)) - MP.SPAWN_SAFE_MARGIN
      : Infinity;
    for (let i = 0; i < MP.SPAWN_TRIES; i++) {
      const p = this.getSpawnPosition('random', this.config.baseRadius);
      if (!p) continue;
      if (Math.abs(p.x - c.x) < MP.SPAWN_AXIS_GUARD || Math.abs(p.y - c.y) < MP.SPAWN_AXIS_GUARD) continue;
      if (p.distance(c) > limit) continue;
      return p;
    }
    return null;
  }

  spawnHuman(spec, spot) {
    this._enter();
    if (this.stopped) throw new Error('stopped');
    const pos = spot || this.findSpawn();
    if (!pos) throw new Error('no-spawn');
    const c = this.config;
    const unit = new ArenaHuman(
      this,
      (spec && spec.name) || this.language.defaultPlayerName,
      pos,
      P.makeCirclePoints(pos, c.baseCount, c.baseRadius),
      this.schemesManager
    );
    unit.socketId = (spec && spec.socketId) || null;
    unit.setSkin(this._humanSkin());
    this.addUnit(unit);
    this.humans.push(unit);
    return unit;
  }

  _humanSkin() {
    const sm = this.skinManager;
    if (sm.available('colored')) return sm.getPlayerSkin();
    const names = Object.keys(sm.assets);
    return sm.get(names[Math.floor(Math.random() * names.length)]);
  }

  removeHuman(id, reason) {
    this._enter();
    const u = this.byId.get(id);
    if (!u || !u.isHuman || u.death) return false;
    this.kill(u, undefined, reason);
    return !!u.death;
  }

  // Free arena at 16 squares: the LOWEST ranked bot makes room (reason 6, never a human).
  removeLowestBot() {
    this._enter();
    for (let i = this.units.length - 1; i >= 0; i--) {
      const u = this.units[i];
      if (u instanceof P.BotUnit && !u.death) {
        this.kill(u, undefined, REASON.SYSTEM_REMOVED);
        return u;
      }
    }
    return null;
  }

  // A fresh spawn base elsewhere (design 9.6 F1): not a death, no money moves.
  reseat(unit) {
    this._enter();
    if (!unit || unit.death) return false;
    const spot = this.findSpawn(this.units.length);
    if (!spot) return false;
    const c = this.config;
    const old = unit.base;
    unit.track.remove();
    old.remove();
    for (const other of this.units) {
      if (other !== unit && other.in === old) other.in = null;
    }
    const base = new P.TerritoryBase(unit, P.makeCirclePoints(spot, c.baseCount, c.baseRadius));
    base.wireVer = (old.wireVer | 0) + 1;
    unit.base = base;
    unit.position = spot;
    unit.in = base;
    unit.lastSquare = base.square;
    this.hooks.onReseat(unit);
    return true;
  }

  // Post pass: trims dirty bases through the injected trim module (null until T14 passes).
  trimDirtyBases() {
    const trim = this.trim;
    if (!trim) return;
    let budget = MP.TRIM_MAX_PER_TICK;
    for (const u of this.units.slice()) {
      if (budget <= 0) break;
      if (u.death || !u.base._trimDirty) continue;
      budget--;
      let status;
      try {
        status = trim.trimBase(this, u);
      } catch (e) {
        console.error('[PAPER] TRIM CRITICAL', e && e.message);
        status = 'empty';
      }
      if (status === 'empty') {
        u.base._trimDirty = false;
        if (!this.reseat(u)) u.base._trimDirty = true;
      } else if (status !== 'blocked' && status !== 'invalid') {
        u.base._trimDirty = false;
      }
    }
  }
}

// One arena with its own grid, border, skins, names and config (design 4.1).
function makeArena({ stake = 0, seed = Math.random(), hooks, trim = null } = {}) {
  const config = Object.assign({}, P.defaultPaperConfig, { botsCount: stake > 0 ? 0 : MP.FREE_BOTS_IDLE });
  const space = new P.SpatialGrid(config.arenaSize, config.arenaSize, config.quadSize);
  const center = new P.Vec2(config.arenaSize / 2, config.arenaSize / 2);
  const border = MP.guardedBorder(center, config.borderPoints, stake > 0 ? MP.R_MIN : MP.R_MAX, space);
  const skins = new P.SkinManager(new P.ColorSkinPool(undefined), new P.ClassicSkinPool(undefined, null, '', []), seed);
  const names = new P.RandomNamePool(P.botNames.slice(), seed);
  const lang = { defaultPlayerName: 'Player', bestTxt: 'BEST', killText: 'Kill' };
  const schemes = new P.ScoreSchemeManager(P.PercentScoreScheme);
  const game = new ArenaGame(config, null, space, border, skins, null, names, null, lang, schemes, seed);
  // The stock particle timer must not keep node (or a test) alive.
  if (game.updateParticlesId && typeof game.updateParticlesId.unref === 'function') game.updateParticlesId.unref();
  return game.setup({ stake, hooks, trim });
}

module.exports = { ArenaGame, ArenaHuman, makeArena, REASON, P, MP, flatReturn };
