'use strict';
// slither.io free room: hold Q to cash out (SERVER-DESIGN 15.3, 5.3 steps 2 and 6; task T9).
//
// Owen (OWNER-ANSWERS.md:46-48, 66-69, 99-100): hold Q, steering LOCKED while holding, the OLD game's speed ramp
// (a smooth curve to 0.2 at 3 s), NO boosting while holding, and when the hold completes the snake VANISHES at once
// for everyone else (no food); others see the ring while it holds.
//
// Pure and clock-free: every time here is the room's SIM time (ms), so a hold is deterministic.
//
//   holdMult(ms, laws)      the speed multiplier after ms of holding, from the C_HOLD_RAMP row only (never from
//                           shared/constants.js at runtime, SERVER-DESIGN C45): max(floor, 1 - (1 - floor) t / ms)
//                           with t capped at ms (server/Snake.js:139-143). 1000, 2000, 3000 ms give 0.7333, 0.4667, 0.2.
//   createHoldBook(laws)    the room's per-snake hold state (below)
//   lockEvent(s, laws)      the ONE rotation record every holder of s gets when its hold starts (SERVER-DESIGN 15.3,
//                           C19): dir 1 or 2 with ang and wang both the 8-bit byte the steering lock set (their form
//                           `3` or `5`, notes/protocol.md:281-287). Call it AFTER sim.setHold started the hold.
//
// The book (one per room). A hold ends ONLY on release ({on: 0}), on a hidden tab, on the own death or on a disconnect
// (SERVER-DESIGN D5, 15.3); the one timer is the C_HOLD_SAFETY_MS net: no upstream packet of ANY kind for
// max(minMs, rttMult x the seat's pong RTT p95). Upstream arrives in POST batches about one round trip apart on
// polling, so a short stale rule (agar's 500 ms) would end holds that are still held.
//
//   book.press(id, simMs)          a {on: 1} arrived (applied at the next tick's step 2)
//   book.release(id, why)          a {on: 0}, a hidden tab, a disconnect or a death (applied at the next step 2;
//                                  a death or a disconnect also drop a press that is still pending)
//   book.heard(id, simMs)          any upstream packet of that seat arrived (the safety net's clock)
//   book.step(sim, simMs, rttP95)  tick step 2: ends, then starts, then the multiplier of every hold, then the
//                                  safety net. rttP95(id) gives the seat's pong RTT p95 in ms (0 when unknown).
//                                  Returns { started: [{id, lock}], ended: [{id, why}] } for the room's records.
//   book.complete(sim, simMs)      tick step 6: every hold whose snake is still alive with held >= C_HOLD_MS ends as
//                                  a cash-out. A snake that died in this tick is gone from the sim, so the death
//                                  wins the tie. Returns the ids (the room removes the snakes).
//   book.drop(id)                  forget a snake (it left the sim)
//   book.holding(id)               true while a hold is running
//   book.heldMs(id, simMs)         ms held so far (0 when not holding)
//
// Held time: a hold started at sim time t0 is held for (simMs - t0) at each later step; t0 is the press's sim time
// (the room stamps it), so a press that arrived just after a tick counts from its arrival, not from the next tick.

const slQuant = require('./slQuant');
const { assertLawsComplete, assertRulesBuilt } = require('./slLaws');

const HOLD_LAW_IDS = Object.freeze(['C_HOLD_MS', 'C_HOLD_RAMP', 'C_HOLD_STEER', 'C_HOLD_BOOST', 'C_HOLD_RING',
  'C_HOLD_SAFETY_MS', 'L48.angRound']);
const HOLD_RULES_BUILT = Object.freeze(['linearToFloor']);

function bad(id, what) {
  throw new Error('slHold: law ' + id + ' ' + what);
}

function num(v, id, what) {
  if (typeof v !== 'number' || !Number.isFinite(v)) bad(id, what + ' is not a finite number');
  return v;
}

// Every value the hold reads, checked once.
function holdLaws(laws) {
  assertLawsComplete(laws, HOLD_LAW_IDS);
  assertRulesBuilt(laws, HOLD_LAW_IDS, HOLD_RULES_BUILT);
  const v = (id) => laws[id].value;
  const ms = num(v('C_HOLD_MS'), 'C_HOLD_MS', 'hold time');
  if (!(ms > 0)) bad('C_HOLD_MS', 'must be above 0');
  const ramp = v('C_HOLD_RAMP');
  if (!ramp || ramp.rule !== 'linearToFloor') bad('C_HOLD_RAMP', 'is not the linearToFloor form');
  for (const k of Object.keys(ramp)) if (k !== 'rule' && k !== 'floor' && k !== 'ms') bad('C_HOLD_RAMP', 'parameter ' + k + ' is not built');
  const floor = num(ramp.floor, 'C_HOLD_RAMP', 'floor');
  const rampMs = num(ramp.ms, 'C_HOLD_RAMP', 'ms');
  if (!(floor > 0 && floor <= 1)) bad('C_HOLD_RAMP', 'floor must be in (0, 1]');
  if (!(rampMs > 0)) bad('C_HOLD_RAMP', 'ms must be above 0');
  const steer = v('C_HOLD_STEER');
  if (steer !== 'locked') bad('C_HOLD_STEER', 'is not "locked" (the only mode built)');
  const boost = v('C_HOLD_BOOST');
  if (!boost || boost.allow !== false) bad('C_HOLD_BOOST', 'allow is not false (Owen: no boosting while holding)');
  const ring = v('C_HOLD_RING');
  if (!ring || typeof ring.others !== 'boolean') bad('C_HOLD_RING', 'others is not a boolean');
  const safe = v('C_HOLD_SAFETY_MS');
  if (!safe || typeof safe !== 'object') bad('C_HOLD_SAFETY_MS', 'is not {minMs, rttMult}');
  const angRound = v('L48.angRound');
  if (angRound !== 'floor' && angRound !== 'round') bad('L48.angRound', 'is neither floor nor round');
  return Object.freeze({
    ms,
    floor,
    rampMs,
    ringOthers: ring.others,
    safetyMin: num(safe.minMs, 'C_HOLD_SAFETY_MS', 'minMs'),
    safetyMult: num(safe.rttMult, 'C_HOLD_SAFETY_MS', 'rttMult'),
    angRound,
  });
}

function rampAt(H, t) {
  const x = t <= 0 ? 0 : (t >= H.rampMs ? 1 : t / H.rampMs);
  const m = 1 - (1 - H.floor) * x;
  return m > H.floor ? m : H.floor;
}

function holdMult(ms, laws) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) throw new TypeError('slHold: ms must be a finite number');
  return rampAt(holdLaws(laws), ms);
}

// The lock record of SERVER-DESIGN 15.3 for snake s, right after its hold started: the sim set wang to the 8-bit
// byte of ang (slSnake.setHold, L48.angRound), so ang and wang go as that same byte with the sim's dir (1 or 2).
// The byte is taken from wang's own raw, so a float that sits a hair under its grid point cannot slip a byte.
function lockEvent(s, laws) {
  return lockEventH(s, holdLaws(laws));
}

function lockEventH(s, H) {
  if (!s || typeof s !== 'object') throw new TypeError('slHold: lockEvent needs a snake');
  const raw = lockByte(s.ang, H.angRound);
  const v = raw * 2 * Math.PI / 256;
  const dir = s.dir === 2 ? 2 : 1;
  return { type: 'snake_rot', id: s.id, dir, ang: v, wang: v };
}

// The byte slSnake.setHold locks to: slQuant.rotAng of the snake's ang at the lock.
function lockByte(ang, angRound) {
  return slQuant.rotAng(ang, angRound).raw;
}

function createHoldBook(laws) {
  const H = holdLaws(laws);
  // id -> { id, state: 'pending' | 'holding', pressMs, startMs, heardMs, endWhy }
  const book = new Map();
  // ids whose hold must end at the next step (release seen while holding), with the reason
  const ends = new Map();
  const stats = { presses: 0, started: 0, released: 0, safety: 0, completed: 0, deaths: 0 };

  function entry(id) {
    return book.get(id) || null;
  }

  function press(id, simMs) {
    const e = entry(id);
    if (e && e.state === 'pending') return false; // a press is already waiting for the tick
    if (e && e.state === 'holding' && !ends.has(id)) return false; // already holding
    stats.presses++;
    if (e && e.state === 'holding') {
      // released and pressed again before the tick: the old hold ends, a new one starts at this press
      e.restart = simMs;
      return true;
    }
    book.set(id, { id, state: 'pending', pressMs: simMs, startMs: NaN, heardMs: simMs, restart: NaN });
    return true;
  }

  function release(id, why) {
    const e = entry(id);
    if (!e) return false;
    const reason = typeof why === 'string' ? why : 'release';
    if (e.state === 'pending') {
      book.delete(id); // pressed and released before any tick: nothing ever started
      return true;
    }
    e.restart = NaN;
    if (!ends.has(id)) ends.set(id, reason);
    return true;
  }

  function heard(id, simMs) {
    const e = entry(id);
    if (e) e.heardMs = simMs;
  }

  function drop(id) {
    book.delete(id);
    ends.delete(id);
  }

  function holding(id) {
    const e = entry(id);
    return !!e && e.state === 'holding';
  }

  function heldMs(id, simMs) {
    const e = entry(id);
    return e && e.state === 'holding' ? Math.max(0, simMs - e.startMs) : 0;
  }

  function safetyMs(rtt) {
    const r = typeof rtt === 'number' && Number.isFinite(rtt) && rtt > 0 ? rtt : 0;
    const m = H.safetyMult * r;
    return m > H.safetyMin ? m : H.safetyMin;
  }

  const out = { started: [], ended: [] };

  function endHold(sim, e, why) {
    if (sim.snake(e.id)) sim.setHold(e.id, null, 0);
    out.ended.push({ id: e.id, why });
    if (why === 'safety') stats.safety++;
    else stats.released++;
  }

  // Tick step 2.
  function step(sim, simMs, rttP95) {
    out.started.length = 0;
    out.ended.length = 0;
    // 1. ends (release, hidden, disconnect, death)
    for (const [id, why] of ends) {
      const e = entry(id);
      ends.delete(id);
      if (!e || e.state !== 'holding') continue;
      endHold(sim, e, why);
      if (Number.isFinite(e.restart) && sim.snake(id)) {
        e.state = 'pending';
        e.pressMs = e.restart;
        e.restart = NaN;
      } else {
        book.delete(id);
      }
    }
    // 2. starts, 3. multipliers, 4. the safety net (in id order: deterministic)
    const ids = Array.from(book.keys()).sort((a, b) => a - b);
    for (const id of ids) {
      const e = book.get(id);
      const s = sim.snake(id);
      if (!s) {
        book.delete(id);
        continue;
      }
      if (e.state === 'pending') {
        const lockAng = s.ang;
        e.state = 'holding';
        e.startMs = e.pressMs <= simMs ? e.pressMs : simMs;
        const off = simMs - e.startMs;
        sim.setHold(id, rampAt(H, off), off);
        stats.started++;
        out.started.push({ id, lock: lockEventH({ id, ang: lockAng, dir: s.dir }, H) });
        continue;
      }
      const t = simMs - e.startMs;
      const rtt = typeof rttP95 === 'function' ? rttP95(id) : 0;
      if (simMs - e.heardMs > safetyMs(rtt)) {
        endHold(sim, e, 'safety');
        book.delete(id);
        continue;
      }
      sim.setHold(id, rampAt(H, t), 0);
    }
    return out;
  }

  // Tick step 6: holds that reached C_HOLD_MS with their snake still alive. The room removes each snake (no drops).
  const done = [];
  function complete(sim, simMs) {
    done.length = 0;
    for (const id of Array.from(book.keys()).sort((a, b) => a - b)) {
      const e = book.get(id);
      if (e.state !== 'holding') continue;
      if (!sim.snake(id)) {
        // died this tick: the death wins
        book.delete(id);
        ends.delete(id);
        stats.deaths++;
        continue;
      }
      if (simMs - e.startMs >= H.ms) {
        book.delete(id);
        ends.delete(id);
        stats.completed++;
        done.push(id);
      }
    }
    return done;
  }

  return {
    H,
    press,
    release,
    heard,
    drop,
    holding,
    heldMs,
    safetyMs,
    step,
    complete,
    stats,
    size: () => book.size,
    has: (id) => book.has(id), // any entry: a press waiting, a hold, an end
  };
}

module.exports = {
  HOLD_LAW_IDS,
  HOLD_RULES_BUILT,
  holdLaws,
  holdMult,
  lockEvent,
  lockByte,
  createHoldBook,
};
