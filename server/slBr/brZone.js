'use strict';
// The battle royale's circle on the sl engine (Owen 2026-10-15: "keep the wandering circle"). The rings of the old
// event (server/BattleRoyaleRoom.js updateZone/_nextRing, every rule and number kept), moved from the wall clock onto
// the sim clock so the circle the server kills with is the one the step ran.
//
// A white circle is announced somewhere inside the current one and a little smaller, sits long enough to be read and
// run for, then the wall travels to it (radius and centre together, at a fixed rate) and rests; again and again down
// to RING_MIN_RADIUS. The new circle is always wholly inside the old one, and the wall never moves faster than
// CLOSE_SPEED_FRAC of a snake's cruise, so it is something you outrun rather than something that catches you.
//
//   get()            null (no zone: the free border rules) or { x, y, r }: the circle a head must stay inside
//   target()         the announced circle { x, y, r } while it is announced or travelling, else null
//   phase(simMs)     'open' | 'warning' | 'closing' | 'holding' | 'frozen' | 'reopening'
//   begin(simMs, r0) the match is live: the circle is the whole arena (grd, grd, r0) and the first ring is called
//   update(simMs)    once per step (the match calls it); returns true when a new ring was called
//   freeze()         the match is decided: the circle stays exactly where it is
//   reopen(simMs)    the circle travels back out to (grd, grd, r0) over REOPEN_MS; reopened(simMs) true once there
//   clear()          no zone (the arena is the free room again)
//   desc(simMs)      what the client draws, as { f: [x, y, r], t: [x, y, r] | null, w, m } with w the ms until the
//                    wall moves and m the ms it then takes (the client runs the same lerp on its own clock)
//   ring(), zoneMs(simMs)  the ring number and the ms until the wall next moves (the HUD)
// rand: () -> [0, 1) (tests pass a seeded one; default Math.random, as the old event).

const SEC = 1000;

const BRZ = Object.freeze({
  // BattleRoyaleRoom BR, the same numbers (Owen's: about 10 % a ring at about 4 minutes a match, see there)
  RING_SHRINK: 0.78,
  RING_MIN_RADIUS: 40,
  RING_ENDGAME_RADIUS: 165,
  RING_WARN_MIN_MS: 4 * SEC,
  RING_WARN_MAX_MS: 11 * SEC,
  RING_MOVE_MIN_MS: 2500,
  RING_REST_MS: 1500,
  CLOSE_SPEED_FRAC: 0.7,
  // the old reopening eased 3.5 % of the gap per 60 Hz tick to 98.5 % (about 2 s); a fixed time here, so the client
  // can draw it from one message
  REOPEN_MS: 2500,
});

// A snake's cruise in world units per second from the law table: their client moves sp / 4 per 8 ms frame
// (slSnake.js travel), and a new snake's sp is nsp1 + nsp2 (L12 at sc 1), the slowest a snake ever cruises.
function cruiseOf(laws) {
  const sp = laws.L4.value;
  return ((sp.nsp1 + sp.nsp2) / 4) * (SEC / 8);
}

function createZone(opts) {
  const o = opts || {};
  const grd = o.grd;
  const cruise = o.cruise;
  if (!(typeof grd === 'number' && grd > 0)) throw new TypeError('brZone: grd must be a positive number');
  if (!(typeof cruise === 'number' && cruise > 0)) throw new TypeError('brZone: cruise must be a positive number');
  const rand = typeof o.rand === 'function' ? o.rand : Math.random;
  const closeSpeed = BRZ.CLOSE_SPEED_FRAC * cruise; // units per second

  let mode = 'open'; // open | rings | frozen | reopening
  let r0 = 0;
  let cur = null; // { x, y, r } the kill circle
  let g = null; // the current ring { fx, fy, fr, tx, ty, tr, warnUntil, moveMs }
  let ringNo = 0;
  let reo = null; // { fx, fy, fr, t0 }

  // BattleRoyaleRoom._nextRing, on sim ms
  function nextRing(now) {
    const fr = cur.r;
    const fx = cur.x;
    const fy = cur.y;
    const tr = Math.max(BRZ.RING_MIN_RADIUS, fr * BRZ.RING_SHRINK);
    const slack = Math.max(0, fr - tr);
    const a = rand() * Math.PI * 2;
    const d = Math.sqrt(rand()) * slack; // even by area
    const tx = fx + Math.cos(a) * d;
    const ty = fy + Math.sin(a) * d;
    const worst = (fr - tr) + Math.hypot(tx - fx, ty - fy);
    const moveMs = Math.max(BRZ.RING_MOVE_MIN_MS, (worst / closeSpeed) * SEC);
    const smallness = 1 - Math.min(1, (fr - BRZ.RING_ENDGAME_RADIUS) / Math.max(1, r0 - BRZ.RING_ENDGAME_RADIUS));
    const warnMs = BRZ.RING_WARN_MIN_MS + (BRZ.RING_WARN_MAX_MS - BRZ.RING_WARN_MIN_MS) * smallness;
    ringNo++;
    return { fx, fy, fr, tx, ty, tr, moveMs, warnUntil: now + warnMs };
  }

  function update(now) {
    if (mode === 'reopening') {
      const k = Math.min(1, (now - reo.t0) / BRZ.REOPEN_MS);
      const e = 1 - (1 - k) * (1 - k); // ease out
      cur = { x: reo.fx + (grd - reo.fx) * e, y: reo.fy + (grd - reo.fy) * e, r: reo.fr + (r0 - reo.fr) * e };
      return false;
    }
    if (mode !== 'rings') return false;
    let called = false;
    if (!g) {
      g = nextRing(now);
      called = true;
    }
    if (now < g.warnUntil) {
      cur = { x: g.fx, y: g.fy, r: g.fr };
      return called;
    }
    const moveEnd = g.warnUntil + g.moveMs;
    if (now < moveEnd) {
      const k = g.moveMs > 0 ? (now - g.warnUntil) / g.moveMs : 1;
      cur = { x: g.fx + (g.tx - g.fx) * k, y: g.fy + (g.ty - g.fy) * k, r: g.fr + (g.tr - g.fr) * k };
      return called;
    }
    cur = { x: g.tx, y: g.ty, r: g.tr };
    if (now >= moveEnd + BRZ.RING_REST_MS) {
      g = nextRing(now);
      cur = { x: g.fx, y: g.fy, r: g.fr };
      called = true;
    }
    return called;
  }

  return {
    get: () => cur,
    target: () => (mode === 'rings' && g ? { x: g.tx, y: g.ty, r: g.tr } : null),
    phase(now) {
      if (mode === 'open' || mode === 'frozen' || mode === 'reopening') return mode;
      if (!g) return 'warning';
      if (now < g.warnUntil) return 'warning';
      if (now < g.warnUntil + g.moveMs) return 'closing';
      return 'holding';
    },
    begin(now, radius) {
      if (!(typeof radius === 'number' && radius > 0)) throw new RangeError('brZone: the arena radius must be > 0');
      r0 = radius;
      mode = 'rings';
      cur = { x: grd, y: grd, r: r0 };
      g = null;
      ringNo = 0;
      reo = null;
      update(now);
    },
    update,
    freeze() {
      if (mode === 'rings') mode = 'frozen';
      g = null;
    },
    reopen(now) {
      if (!cur) return;
      mode = 'reopening';
      g = null;
      reo = { fx: cur.x, fy: cur.y, fr: cur.r, t0: now };
    },
    reopened: (now) => mode === 'reopening' && now - reo.t0 >= BRZ.REOPEN_MS,
    clear() {
      mode = 'open';
      cur = null;
      g = null;
      reo = null;
    },
    ring: () => ringNo,
    zoneMs: (now) => (mode === 'rings' && g ? Math.max(0, g.warnUntil - now) : 0),
    arena: () => r0,
    desc(now) {
      if (!cur) return null;
      const f = [Math.round(cur.x), Math.round(cur.y), Math.round(cur.r)];
      if (mode === 'rings' && g) {
        // the ring as a whole, from its start, so the client lerps it on its own clock
        const w = Math.round(g.warnUntil - now);
        if (now < g.warnUntil + g.moveMs) {
          const from = [Math.round(g.fx), Math.round(g.fy), Math.round(g.fr)];
          const to = [Math.round(g.tx), Math.round(g.ty), Math.round(g.tr)];
          return { f: from, t: to, w, m: Math.round(g.moveMs) };
        }
        return { f, t: null, w: 0, m: 0 };
      }
      if (mode === 'reopening') {
        return { f: [Math.round(reo.fx), Math.round(reo.fy), Math.round(reo.fr)], t: [grd, grd, Math.round(r0)],
          w: Math.round(reo.t0 - now), m: BRZ.REOPEN_MS, ease: 1 };
      }
      return { f, t: null, w: 0, m: 0 };
    },
    closeSpeed: () => closeSpeed,
  };
}

module.exports = { BRZ, createZone, cruiseOf };
