'use strict';
// The soak's invariants (task T15; SERVER-DESIGN 18.4; SERVER-BUILD-BRIEF 1.2 "Soak"; PLAN Phase 3 bars). Shared by
// the long local soak (scripts/slSoak.js) and the npm soak (test/slSoak.test.js). Never loaded by product code.
//
// createSoakCheck(laws) -> check. hookRoom(room, parts) puts it on a running room through the room's bot driver hooks
// (slRoom.js header: beforeInputs at step 0, afterStep after the deaths of the step), so it sees EVERY step:
//   beforeStep (step 0)   the state each snake enters the step with (length sct + fam, charge count), the border
//                         radius the step's L38 test uses, the food and prey totals, prey radii; ids that appeared or
//                         left since the last step (seats spawn and leave between steps)
//   afterStep (step 8)    every check below, on the state the step left
// Checks, every step:
//   finite      every live snake's fam, ang, wang, sp, d, sc, head and every body point; every food the step added;
//               every number of every live prey
//   border      every snake that went through the step: its L38 test point (head + f1 sc along ang) is inside the
//               radius + m the step tested against (L38); a snake born after the step: its head inside the border
//   length      (the "mass ledger", per snake that went through the step) with L = sct + fam:
//               the update part: no charge -> L unchanged (moves and grows only trade fam for points); n charges ->
//               L fell by at most n x the L23 high edge at that length (each charge costs c x the L18 multiplier,
//               c inside the L23 edges), never rose;
//               the eat part: the snake's fam now equals its fam after the update plus, in eat order, the L18 value of
//               each food it ate and the L34 value of each prey (exact, the sim's own arithmetic);
//               its boost drops: at most one per charge, each rad byte inside dropByte(L23 low edge) to
//               dropByte(L23 high edge) (L24.size); every update added at most one point
//   deaths      L39.count: border deaths drop nothing, others 2 sct + 1 (perPoint sct + extra), every drop with the
//               L39.rad byte of the victim's length (so the drop value is exactly (2 sct + 1) K18 b(sct)^2; the share
//               of the victim's length is reported)
//   food        the foods in the cells (the grid's count) after = before + the step's adds - its eats, and the food
//               store's own counters equal the cells (a food is a cell: the store is keyed by cell, so one food per
//               cell holds by construction; full() recounts it)
//   prey        the live prey after = before + adds - removes - eats
//   ids         a new snake never takes an id that left less than C_ID_QUARANTINE_MS of sim time ago, nor one a
//               seat's send queue still holds (checked at the spawn itself, through hookRoom's spawnSnake wrap)
// full(sim) (every second in the long soak, and at the end): sim.check(): every food in its own cell at its client
// position, per-sector natural counts recounted, the grid recounted, body sequence numbers, finite points.
//
// createInsertLog() keeps, per snake id, the last INSERT_CAP points a move inserted (the update record's xx, yy and
// the fam after the update), numbered from 1 at the snake's first move. createSeatMirror() is the client mirror of
// one seat (SERVER-BUILD-BRIEF 1.2 "mirror equal for 3 sampled seats", P3 restated): it decodes every sl:f the seat
// is sent, in order, and rebuilds every inserted point with the client's own arithmetic (scripts/slLoad.js addEnd
// and movePoint: slApply.js buildBody and headPoint over slCore.headStep). Each must equal the server's insert
// exactly for a snake the seat has held since before its first move, and otherwise differ by one constant offset of
// at most 0.25 per axis (moving by no more than the 1 ulp budget); the seat must get every move the server made
// since it started holding the snake (consecutive numbers); a grow carries the server's fam clamped and quantized
// (L17.famRound); after every bundle every snake the seat holds is alive on the server, and about every 0.7 s every
// food it holds is the server's food of that cell with the same size and colour and every prey it holds is live (0
// ghosts); the decoded-stream model of scripts/slLoad.js runs on the same bundles (no wire_error, no kind-15 number, no
// number off its wire grid, no unknown id, foods by cell as the client keeps them).

const { performance } = require('perf_hooks');
const slSnake = require('../server/sl/slSnake');
const slQuant = require('../server/sl/slQuant');
const { worldLaws, deathRadByte } = require('../server/sl/slSim');
const { addEnd, movePoint, createTracker, FAIL_KINDS } = require('./slLoad');

const EPS = 1e-9; // float sums of whole points and fractions
const ULP_BUDGET = 1e-6; // the constant offset may move by (k + 1) x (42 x 2^-52 + 2^-36) per point; far under this
const OFFSET_MAX = 0.25; // P3: a constant offset of at most 0.25 per axis
const INSERT_CAP = 1024; // about 44 s of moves at L7 43 ms; a seat is kicked after C_STALL_KICK_MS 15 s not ready
const SAMPLE_CAP = 30;
// The food and prey ghost walk visits every food the seat holds once per this many bundles (about 0.7 s), inside the
// emit, when the bundle carries the whole queue. Snakes are checked after every bundle.
const FOOD_GHOST_EVERY = 16;

function createFailures() {
  const by = {};
  const samples = [];
  return {
    by,
    samples,
    add(kind, what) {
      by[kind] = (by[kind] || 0) + 1;
      if (samples.length < SAMPLE_CAP) samples.push(kind + ': ' + what);
    },
    total() {
      let n = 0;
      for (const k of Object.keys(by)) n += by[k];
      return n;
    },
  };
}

function finite(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

// ---------------------------------------------------------------------------------------------------------------
// The server invariants

function createSoakCheck(laws) {
  const K = slSnake.snakeLaws(laws);
  const Wd = worldLaws(laws);
  const grd = laws.L1.value;
  const quarantine = laws.C_ID_QUARANTINE_MS.value;
  const K18 = laws.L18.value.K;
  const fails = createFailures();
  const st = {
    steps: 0, snakeSteps: 0, eatsFood: 0, eatsPrey: 0, charges: 0, chargedSteps: 0, boostDrops: 0, grows: 0,
    deaths: 0, borderDeaths: 0, deathDrops: 0, newIds: 0, lateNewIds: 0, reusedIds: 0, idsLeft: 0, fullChecks: 0, foodAdds: 0,
    foodEats: 0, shareMin: Infinity, shareMax: 0, shareSum: 0, maxSct: 0, maxSnakes: 0, maxFood: 0, maxPrey: 0,
    hookMs: 0,
  };
  // state at step 0, per snake id
  const pre = new Map(); // id -> { s, sct, fam, charges }
  const known = new Map(); // id -> snake object alive at the end of the last step
  const freed = new Map(); // id -> sim ms it left
  const preyRad = new Map(); // prey id -> rad
  let radius0 = 0;
  let food0 = 0;
  let prey0 = 0;
  const foodEats = new Map(); // eater -> [b]
  const preyEats = new Map(); // eater -> [rad]

  // A new snake: its id must not have left less than the quarantine ago, nor be held by a seat (checked at the spawn
  // itself, through hookRoom's spawnSnake wrap: a seat part sliced across turns can add the new snake to other seats
  // before the next step, so a later look would see it held legitimately). late: seen first at a step (no spawn
  // hook ran), so only the quarantine is checked.
  function noteNew(room, s, simMs, late) {
    st.newIds++;
    if (late) st.lateNewIds++;
    const at = freed.get(s.id);
    if (at !== undefined) {
      st.reusedIds++;
      if (simMs - at < quarantine) fails.add('idReused', 'id ' + s.id + ' back after ' + (simMs - at) + ' ms of sim time');
      freed.delete(s.id);
    }
    if (!late && room && room.seats) {
      for (const seat of room.seats.values()) {
        if (seat.snakeId !== s.id && seat.queue && seat.queue.holdsSnake(s.id)) {
          fails.add('idHeld', 'id ' + s.id + ' given while seat ' + seat.id + ' still holds it');
        }
      }
    }
  }

  // The room's spawnSnake (seats and bots), wrapped by hookRoom.
  function onSpawn(room, s) {
    const t0 = performance.now();
    const sim = room.sim;
    const old = known.get(s.id);
    if (old && old !== s) {
      // the id's last owner left since the last step: this spawn took its id at once
      known.delete(s.id);
      noteGone(s.id, sim.nowMs());
    }
    noteNew(room, s, sim.nowMs(), false);
    known.set(s.id, s);
    st.hookMs += performance.now() - t0;
  }

  function noteGone(id, simMs) {
    freed.set(id, simMs);
    st.idsLeft++;
  }

  function preyCount(sim) {
    let n = 0;
    if (sim.preys) sim.preys.forEachPrey(() => { n++; });
    return n;
  }

  function beforeStep(room) {
    const t0 = performance.now();
    const sim = room.sim;
    const simMs = sim.nowMs();
    // ids that left or appeared between steps (seats, leaves, the console)
    for (const [id, s] of known) {
      if (sim.snake(id) !== s) {
        known.delete(id);
        noteGone(id, simMs);
      }
    }
    pre.clear();
    sim.forEachSnake((s) => {
      if (known.get(s.id) !== s) {
        noteNew(room, s, simMs, true);
        known.set(s.id, s);
      }
      pre.set(s.id, { s, sct: s.pts.length, fam: s.fam, charges: s.chargeCount });
    });
    radius0 = sim.flux();
    food0 = sim.food ? sim.grid.foodTotal() : 0;
    preyRad.clear();
    prey0 = 0;
    if (sim.preys) {
      sim.preys.forEachPrey((p) => {
        prey0++;
        preyRad.set(p.id, p.rad);
      });
    }
    st.hookMs += performance.now() - t0;
  }

  function checkFinite(s) {
    if (!finite(s.fam) || !finite(s.ang) || !finite(s.wang) || !finite(s.sp) || !finite(s.d) || !finite(s.sc) ||
      !finite(s.hx) || !finite(s.hy)) {
      fails.add('nan', 'snake ' + s.id + ' fam ' + s.fam + ' ang ' + s.ang + ' wang ' + s.wang + ' sp ' + s.sp + ' d ' + s.d);
      return;
    }
    const pts = s.pts;
    for (let i = 0; i < pts.length; i++) {
      if (!finite(pts[i].xx) || !finite(pts[i].yy)) {
        fails.add('nan', 'snake ' + s.id + ' point ' + i);
        return;
      }
    }
  }

  function afterStep(room, log, simMs) {
    const t0 = performance.now();
    const sim = room.sim;
    st.steps++;
    // eats of the step, per eater, in order
    foodEats.clear();
    preyEats.clear();
    if (sim.food) {
      for (const e of sim.food.tick.eats) {
        let l = foodEats.get(e.eater);
        if (!l) foodEats.set(e.eater, (l = []));
        l.push(e.food.b);
      }
    }
    if (sim.preys) {
      for (const e of sim.preys.tick.eats) {
        let l = preyEats.get(e.eater);
        if (!l) preyEats.set(e.eater, (l = []));
        const rad = preyRad.get(e.id);
        if (rad === undefined) fails.add('prey', 'prey ' + e.id + ' eaten but not live at step 0');
        l.push(rad);
      }
    }
    // boost drops per snake
    const boostDrops = new Map();
    for (const d of log.drops) {
      if (d.kind !== 'boost') continue;
      boostDrops.set(d.id, (boostDrops.get(d.id) || 0) + 1);
    }

    let n = 0;
    sim.forEachSnake((s) => {
      n++;
      checkFinite(s);
      if (s.pts.length > st.maxSct) st.maxSct = s.pts.length;
      const p = pre.get(s.id);
      if (!p || p.s !== s) {
        // born after the step (a bot the driver added): its head inside the border it was born in
        const dx = s.hx - grd;
        const dy = s.hy - grd;
        const r = sim.flux();
        if (dx * dx + dy * dy > r * r) fails.add('border', 'snake ' + s.id + ' born outside the border');
        if (known.get(s.id) !== s) {
          noteNew(room, s, simMs, true);
          known.set(s.id, s);
        }
        return;
      }
      st.snakeSteps++;
      // L38: the test point the step used, against the radius it used
      const bx = s.hx + Wd.borderF1 * s.sc * Math.cos(s.ang) - grd;
      const by = s.hy + Wd.borderF1 * s.sc * Math.sin(s.ang) - grd;
      const lim = radius0 + Wd.borderM;
      if (bx * bx + by * by > lim * lim) {
        fails.add('border', 'snake ' + s.id + ' alive with its test point ' + Math.sqrt(bx * bx + by * by).toFixed(3) +
          ' from the centre, radius ' + lim);
      }
      const rec = s.rec;
      if (rec.moves > 1) fails.add('points', 'snake ' + s.id + ' added ' + rec.moves + ' points in one update');
      if (rec.grow) st.grows++;
      const sct1 = s.pts.length;
      // the update part
      const charges = s.chargeCount - p.charges;
      const dL = (sct1 + rec.fam) - (p.sct + p.fam);
      if (charges === 0) {
        if (Math.abs(dL) > EPS) fails.add('length', 'snake ' + s.id + ' length moved by ' + dL + ' with no charge');
      } else {
        st.charges += charges;
        st.chargedSteps++;
        let hi = 0;
        for (let sct = Math.min(sct1, p.sct); sct <= Math.max(sct1, p.sct); sct++) hi = Math.max(hi, slSnake.chargeHi(K, sct));
        if (dL > EPS || dL < -charges * hi - EPS) {
          fails.add('length', 'snake ' + s.id + ' length moved by ' + dL + ' with ' + charges + ' charges (high edge ' + hi + ')');
        }
      }
      const nb = boostDrops.get(s.id) || 0;
      if (nb > charges) fails.add('boostDrop', 'snake ' + s.id + ' dropped ' + nb + ' with ' + charges + ' charges');
      // the eat part
      let fam = rec.fam;
      const fl = foodEats.get(s.id);
      if (fl) {
        for (let i = 0; i < fl.length; i++) fam += slSnake.foodGain(K, sct1, fam, fl[i]);
        st.eatsFood += fl.length;
      }
      const pl = preyEats.get(s.id);
      if (pl) {
        for (let i = 0; i < pl.length; i++) fam += slSnake.preyGain(K, sct1, fam, pl[i]);
        st.eatsPrey += pl.length;
      }
      if (!Object.is(fam, s.fam)) {
        fails.add('length', 'snake ' + s.id + ' fam ' + s.fam + ' after its eats, the ledger says ' + fam);
      }
    });
    if (n > st.maxSnakes) st.maxSnakes = n;
    // boost drop sizes (the snake may have died since; its length then is the one in the death record)
    for (const d of log.drops) {
      if (d.kind !== 'boost') continue;
      st.boostDrops++;
      if (!finite(d.x) || !finite(d.y)) fails.add('nan', 'boost drop of ' + d.id);
      // a charge sees the length the update entered with, less one per earlier charge of the same update that cost
      // a tail point (at most the press charge plus one period charge: P < the L23 period)
      const pr = pre.get(d.id);
      if (!pr) {
        fails.add('boostDrop', 'boost drop of snake ' + d.id + ' that did not enter the step');
        continue;
      }
      let lo = Infinity;
      let hi = -Infinity;
      for (let sct = Math.max(K.minSct, pr.sct - 2); sct <= pr.sct; sct++) {
        lo = Math.min(lo, slSnake.dropByte(K, slSnake.chargeLo(K, sct)));
        hi = Math.max(hi, slSnake.dropByte(K, slSnake.chargeHi(K, sct)));
      }
      if (!(d.b >= lo && d.b <= hi)) fails.add('boostDrop', 'snake ' + d.id + ' boost drop byte ' + d.b + ' outside ' + lo + '..' + hi);
    }
    // deaths
    for (const d of log.deaths) {
      st.deaths++;
      if (d.cause === 'border') st.borderDeaths++;
      const want = d.cause === 'border' ? 0 : Wd.perPoint * d.sct + Wd.atHead;
      if (d.drops.length !== want) fails.add('deathDrops', 'snake ' + d.id + ' (' + d.cause + ', sct ' + d.sct + ') dropped ' + d.drops.length + ', L39.count says ' + want);
      const b = deathRadByte(Wd, d.sct);
      let value = 0;
      for (const f of d.drops) {
        st.deathDrops++;
        if (f.b !== b) fails.add('deathDrops', 'snake ' + d.id + ' drop byte ' + f.b + ', L39.rad says ' + b);
        if (!finite(f.x) || !finite(f.y)) fails.add('nan', 'death drop of ' + d.id);
        value += K18 * f.b * f.b;
      }
      if (d.drops.length) {
        const share = value / (d.sct + d.fam);
        if (share < st.shareMin) st.shareMin = share;
        if (share > st.shareMax) st.shareMax = share;
        st.shareSum += share;
      }
    }
    // food and prey totals
    if (sim.food) {
      const tk = sim.food.tick;
      st.foodAdds += tk.adds.length;
      st.foodEats += tk.eats.length;
      for (const f of tk.adds) if (!finite(f.x) || !finite(f.y) || !finite(f.b)) fails.add('nan', 'food ' + f.id);
      // the foods actually in the cells against the step's records, and the store's own counters against the cells
      const food1 = sim.grid.foodTotal();
      if (food1 !== food0 + tk.adds.length - tk.eats.length) {
        fails.add('food', 'cells hold ' + food1 + ' after ' + food0 + ' + ' + tk.adds.length + ' - ' + tk.eats.length);
      }
      const standing = sim.food.stats().standing;
      if (standing !== food1) fails.add('food', 'the store counts ' + standing + ', the cells hold ' + food1);
      if (food1 > st.maxFood) st.maxFood = food1;
    }
    if (sim.preys) {
      const tk = sim.preys.tick;
      let prey1 = 0;
      sim.preys.forEachPrey((pr) => {
        prey1++;
        for (const k in pr) if (typeof pr[k] === 'number' && !Number.isFinite(pr[k])) fails.add('nan', 'prey ' + pr.id + ' ' + k);
      });
      if (prey1 !== prey0 + tk.adds.length - tk.removes.length - tk.eats.length) {
        fails.add('prey', 'live ' + prey1 + ' after ' + prey0 + ' + ' + tk.adds.length + ' - ' + tk.removes.length + ' - ' + tk.eats.length);
      }
      if (prey1 > st.maxPrey) st.maxPrey = prey1;
    }
    // ids that left in the step (deaths, cash-outs, retired bots)
    for (const [id, s] of known) {
      if (sim.snake(id) !== s) {
        known.delete(id);
        noteGone(id, simMs);
      }
    }
    st.hookMs += performance.now() - t0;
  }

  function full(sim) {
    const t0 = performance.now();
    st.fullChecks++;
    const problems = sim.check();
    for (const p of problems) fails.add('store', p);
    st.hookMs += performance.now() - t0;
    return problems.length;
  }

  function stats() {
    const o = Object.assign({}, st);
    o.shareMean = st.deaths - st.borderDeaths > 0 ? st.shareSum / (st.deaths - st.borderDeaths) : 0;
    if (o.shareMin === Infinity) o.shareMin = 0;
    delete o.shareSum;
    return o;
  }

  return { beforeStep, afterStep, onSpawn, full, stats, fails, hookMs: () => st.hookMs };
}

// ---------------------------------------------------------------------------------------------------------------
// The server's inserted points, per snake id

function createInsertLog() {
  const byId = new Map(); // id -> { s, n, xs, ys, fams }
  let hookMs = 0;
  function afterStep(room, log) {
    const t0 = performance.now();
    const sim = room.sim;
    for (let i = 0; i < log.updates.length; i++) {
      const rec = log.updates[i];
      if (!rec.move) continue;
      const s = sim.snake(rec.id); // null when it died in this step (its last move may still reach a seat)
      let h = byId.get(rec.id);
      if (!h || (s && h.s !== s)) {
        h = { s, n: 0, xs: new Float64Array(INSERT_CAP), ys: new Float64Array(INSERT_CAP), fams: new Float64Array(INSERT_CAP) };
        byId.set(rec.id, h);
      }
      h.n++;
      const k = h.n % INSERT_CAP;
      h.xs[k] = rec.xx;
      h.ys[k] = rec.yy;
      h.fams[k] = rec.fam;
    }
    // forget snakes gone for good: a history is dropped one full sweep (512 steps, 22 s) after its snake was first seen
    // gone, so a last move still queued for a seat (at most C_STALL_KICK_MS 15 s) finds it
    if (log.tick % 512 === 0) {
      for (const [id, h] of byId) {
        const cur = sim.snake(id);
        if (cur && cur === h.s) continue;
        if (h.goneAt === undefined) h.goneAt = log.tick;
        else if (log.tick - h.goneAt >= 512) byId.delete(id);
      }
    }
    hookMs += performance.now() - t0;
  }
  // A new snake object took this id (a reuse after quarantine): its history starts again at its first move.
  function get(id) {
    return byId.get(id) || null;
  }
  return { afterStep, get, size: () => byId.size, hookMs: () => hookMs };
}

// ---------------------------------------------------------------------------------------------------------------
// The client mirror of one seat

function createSeatMirror(laws, inserts, getSim, opts) {
  const o = opts || {};
  const famRound = laws['L17.famRound'].value;
  const fails = o.fails || createFailures();
  const st = o.stats || {
    bundles: 0, events: 0, adds: 0, removes: 0, moves: 0, exactMoves: 0, offsetMoves: 0, maxOffset: 0,
    maxDrift: 0, grows: 0, ghostChecks: 0,
  };
  // behind() true: the seat was sent a bundle while a sliced wake had run steps whose records it has not been given
  // yet (slRoom _seatPending; a long-polling GET arriving between slices flushes the queue on the transport's ready
  // event). The client is then a little behind the sim, not wrong: the ghost checks wait for an up-to-date bundle.
  const behind = typeof o.behind === 'function' ? o.behind : () => false;
  let init = false;
  let msl = 42;
  let ownId = 0;
  const held = new Map(); // id -> { x, y, iang, seq, offX, offY, exact }
  // the decoded-stream client model (scripts/slLoad.js): ids, foods by cell, prey; its failures count here as stream.*
  const tracker = createTracker();
  const seen = {};
  for (const k of FAIL_KINDS) seen[k] = 0;

  function famWire(f) {
    return slQuant.fam24(Math.min(1, f), famRound).v;
  }

  function onMove(ev) {
    const id = ev.own ? ownId : ev.id;
    const m = held.get(id);
    if (!m) {
      fails.add('mirrorUnknown', 'move of snake ' + id + ' the seat does not hold');
      return;
    }
    if (ev.cmd !== '+' && ev.cmd !== '=' && ev.iang === undefined && m.iang === undefined) {
      fails.add('mirrorAngle', 'move of snake ' + id + ' with no angle after an add that ended without one');
    }
    const c = movePoint(ev, m, msl);
    st.moves++;
    const h = inserts.get(id);
    if (!h || h.n === 0) {
      fails.add('mirrorNoInsert', 'snake ' + id + ': a move the server never inserted');
    } else if (m.seq < 0) {
      // the first move since the add: the server insert it rebuilds (within the offset bound)
      let seq = -1;
      for (let k = h.n; k > 0 && k > h.n - INSERT_CAP; k--) {
        const i = k % INSERT_CAP;
        if (Math.abs(c.x - h.xs[i]) <= OFFSET_MAX + EPS && Math.abs(c.y - h.ys[i]) <= OFFSET_MAX + EPS) {
          seq = k;
          break;
        }
      }
      if (seq < 0) {
        fails.add('mirrorPoint', 'snake ' + id + ': the first move after its add (' + c.x + ', ' + c.y + ') is no server insert');
      } else {
        const i = seq % INSERT_CAP;
        m.seq = seq;
        m.offX = c.x - h.xs[i];
        m.offY = c.y - h.ys[i];
        m.exact = seq === 1;
        if (m.exact && !(Object.is(c.x, h.xs[i]) && Object.is(c.y, h.ys[i]))) {
          fails.add('mirrorExact', 'snake ' + id + ' held since spawn: first insert off by ' + m.offX + ', ' + m.offY);
        }
        tally(m);
        checkFam(ev, h, i, id);
      }
    } else {
      const want = m.seq + 1;
      if (want > h.n) {
        fails.add('mirrorAhead', 'snake ' + id + ': move ' + want + ' before the server made it (' + h.n + ')');
      } else if (want <= h.n - INSERT_CAP) {
        fails.add('mirrorOld', 'snake ' + id + ': move ' + want + ' older than the insert log');
      } else {
        const i = want % INSERT_CAP;
        if (m.exact) {
          if (!(Object.is(c.x, h.xs[i]) && Object.is(c.y, h.ys[i]))) {
            fails.add('mirrorExact', 'snake ' + id + ' move ' + want + ': (' + c.x + ', ' + c.y + ') server (' + h.xs[i] + ', ' + h.ys[i] + ')');
          }
        } else {
          const dx = c.x - h.xs[i] - m.offX;
          const dy = c.y - h.ys[i] - m.offY;
          const drift = Math.max(Math.abs(dx), Math.abs(dy));
          if (drift > st.maxDrift) st.maxDrift = drift;
          if (drift > ULP_BUDGET) {
            fails.add('mirrorPoint', 'snake ' + id + ' move ' + want + ': offset moved by ' + drift);
          }
        }
        m.seq = want;
        tally(m);
        checkFam(ev, h, i, id);
      }
    }
    m.x = c.x;
    m.y = c.y;
    m.iang = c.iang;
  }

  function tally(m) {
    if (m.exact) st.exactMoves++;
    else st.offsetMoves++;
    const off = Math.max(Math.abs(m.offX), Math.abs(m.offY));
    if (off > st.maxOffset) st.maxOffset = off;
    if (off > OFFSET_MAX + EPS) fails.add('mirrorOffset', 'offset ' + off);
  }

  function checkFam(ev, h, i, id) {
    if (ev.fam === undefined) return;
    st.grows++;
    const want = famWire(h.fams[i]);
    if (ev.fam !== want) fails.add('mirrorFam', 'snake ' + id + ': grow carries fam ' + ev.fam + ', the server ' + want);
  }

  // Every food and prey the seat holds is on the server now, the food with the same size and colour (one per cell).
  function ghostSweep() {
    const sim = getSim();
    st.foodGhostChecks = (st.foodGhostChecks || 0) + 1;
    if (sim.food) {
      for (const [id, list] of tracker.cells) {
        const f = sim.food.get(id);
        if (list.length !== 1) fails.add('mirrorFoodGhost', 'cell ' + id + ' holds ' + list.length + ' foods on the client');
        else if (!f) fails.add('mirrorFoodGhost', 'the seat holds food ' + id + ', none on the server');
        else if (f.rad !== list[0].rad || f.cv !== list[0].cv) {
          fails.add('mirrorFoodGhost', 'food ' + id + ' rad ' + list[0].rad + ' cv ' + list[0].cv + ', the server rad ' + f.rad + ' cv ' + f.cv);
        }
      }
    }
    if (sim.preys) {
      const live = new Set();
      sim.preys.forEachPrey((pr) => live.add(pr.id));
      for (const id of tracker.preys) if (!live.has(id)) fails.add('mirrorPreyGhost', 'the seat holds prey ' + id + ', gone on the server');
    }
  }

  // One sl:f bundle, in the order the seat was sent them.
  function onBundle(u8) {
    st.bundles++;
    const events = tracker.onBundle(u8);
    for (const k of FAIL_KINDS) {
      if (tracker.fail[k] !== seen[k]) {
        fails.add('stream.' + k, tracker.samples[tracker.samples.length - 1] || k);
        seen[k] = tracker.fail[k];
      }
    }
    for (const ev of events) {
      st.events++;
      switch (ev.type) {
        case 'init':
          init = true;
          if (ev.defaultMsl !== undefined) msl = ev.defaultMsl;
          break;
        case 'snake_add': {
          if (!init) fails.add('mirrorOrder', 'snake_add before init');
          if (!ownId) ownId = ev.id;
          const e = addEnd(ev.raw.pts, msl);
          held.set(ev.id, { x: e.x, y: e.y, iang: e.iang, seq: -1, offX: 0, offY: 0, exact: false });
          st.adds++;
          break;
        }
        case 'snake_remove':
          if (!held.delete(ev.id)) fails.add('mirrorUnknown', 'remove of snake ' + ev.id);
          st.removes++;
          break;
        case 'snake_move':
          onMove(ev);
          break;
        default:
          break;
      }
    }
    // 0 ghosts: every snake the seat holds is alive on the server right now
    if (behind()) {
      st.behindBundles = (st.behindBundles || 0) + 1;
      return;
    }
    const sim = getSim();
    st.ghostChecks++;
    for (const id of held.keys()) if (!sim.snake(id)) fails.add('mirrorGhost', 'the seat holds snake ' + id + ', gone on the server');
    if (st.bundles % FOOD_GHOST_EVERY === 0) ghostSweep();
  }

  return { onBundle, ghostSweep, fails, stats: st, held, tracker, own: () => ownId };
}

// ---------------------------------------------------------------------------------------------------------------
// Putting it on a room

// parts: { check, inserts, onAfterStep(room, log, simMs) }. The room's bot driver (slBots, or a pass-through when the
// room has none) is wrapped: check.beforeStep before the driver's beforeInputs; the driver's afterStep, then
// check.afterStep and inserts.afterStep (so bots the driver adds this step are seen as born after it).
function hookRoom(room, parts) {
  const p = parts || {};
  const d = room.bots || { beforeInputs() {}, afterStep() {}, add() { return null; }, clear() { return 0; }, count() { return 0; }, isBot() { return false; } };
  const before = d.beforeInputs;
  const after = d.afterStep;
  d.beforeInputs = function beforeInputs(r, tickSimMs) {
    if (p.check) p.check.beforeStep(r);
    if (typeof before === 'function') before.call(this, r, tickSimMs);
  };
  d.afterStep = function afterStep(r, log, simMs) {
    if (typeof after === 'function') after.call(this, r, log, simMs);
    if (p.check) p.check.afterStep(r, log, simMs);
    if (p.inserts) p.inserts.afterStep(r, log);
    if (p.onAfterStep) p.onAfterStep(r, log, simMs);
  };
  room.bots = d;
  if (p.check && typeof room.spawnSnake === 'function') {
    const spawn = room.spawnSnake;
    room.spawnSnake = function spawnSnake(spec) {
      const s = spawn.call(this, spec);
      if (s) p.check.onSpawn(this, s);
      return s;
    };
  }
  return d;
}

module.exports = { createSoakCheck, createInsertLog, createSeatMirror, createFailures, hookRoom, INSERT_CAP,
  OFFSET_MAX, ULP_BUDGET };
