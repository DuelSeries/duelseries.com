'use strict';
// slSoak (SERVER-DESIGN 18.4 and 3.3; SERVER-BUILD-BRIEF 1.2 "Soak"; task T15). The npm half of the soak; the long
// half is scripts/slSoak.js (30 minutes on a local server, recordings/OURS-SOAK.md).
//
// OUR room (server/sl/slRoom.js with the real sim, view, send queue and bot driver, prey on, the FIXTURE table) on a
// virtual clock, the bots at the daily curve's peak (a wall time where server/botPopulation.js botTarget is 101),
// one scripted human who steers, boosts, pings every 250 ms, holds Q to a cash-out once and plays again after every
// end. 20,000 ticks. Every step, scripts/slSoakCheck.js: no NaN, every head inside the L38 border rule, the length
// ledger per snake (eats exact, charges inside the L23 edges, boost drops inside L24.size), death drops by L39, the
// food and prey totals, no id reused inside C_ID_QUARANTINE_MS or while a seat holds it; the full store recount
// every 1,000 ticks and at the end. The human's seat is mirrored (every inserted point, every move, fam on grows,
// 0 ghosts, no wire_error, no kind-15 or off-grid number). A 3 s upstream stall at 74 records per second (one
// record per emit, delivered as one burst when the stall ends, engine.io-client polling.js:138-145) with the
// transport not writable: no kick, no disconnect, the stream goes on clean.
// Then the negative controls: each check catches its own fault.
const test = require('node:test');
const assert = require('node:assert');

const W = require('../shared/slWire.js');
const slSnake = require('../server/sl/slSnake');
const { SlRoom } = require('../server/sl/slRoom');
const { createBotDriver } = require('../server/sl/slBots');
const { botTarget } = require('../server/botPopulation');
const { makeFixture } = require('./slLawsFixture');
const { makeTimers, serverSocket } = require('./slMirrorRig');
const { createSoakCheck, createInsertLog, createSeatMirror, createFailures, hookRoom } = require('../scripts/slSoakCheck');

const PI2 = 2 * Math.PI;
// 2026-10-09 20:00 ET: botTarget is 101 (BOT_MAX) at every second of the next 35 minutes (searched once, checked below)
const PEAK_WALL = Date.UTC(2026, 9, 10, 0, 0, 0);
const TICKS = Number(process.env.SL_SOAK_TICKS || 20000);

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// opts: { seed, ticks, stallAtTick, holdAtTick }
function runSoak(opts) {
  const o = opts || {};
  const laws = makeFixture();
  const rnd = mulberry32(o.seed ^ 0x50a1);
  let vt = 1000;
  const T = makeTimers(() => vt);
  const driver = createBotDriver(laws, {});
  const room = new SlRoom(laws, {
    seed: o.seed, view: require('../server/sl/slView'), bots: driver, clock: () => vt, now: () => PEAK_WALL + vt,
    timers: T.timers, autoTick: false, shippableOnly: false, prey: true,
    log: { log() {}, warn() {}, error(...a) { errors.push(a.join(' ')); } },
  });
  const errors = [];
  const check = createSoakCheck(laws);
  const inserts = createInsertLog();
  const mfails = createFailures();
  const mstats = { bundles: 0, events: 0, adds: 0, removes: 0, moves: 0, exactMoves: 0, offsetMoves: 0, maxOffset: 0,
    maxDrift: 0, grows: 0, ghostChecks: 0 };
  let maxBots = 0;
  let maxSnakes = 0;
  hookRoom(room, {
    check, inserts,
    onAfterStep(r) {
      maxBots = Math.max(maxBots, driver.count());
      maxSnakes = Math.max(maxSnakes, r.sim.count());
    },
  });
  const P = room.P;
  const out = { room, check, inserts, mfails, mstats, errors, lives: 0, kicks: 0, cashed: 0, stall: null, bundles: 0,
    pongs: 0, mirrors: [] };

  // ---- the human
  const me = { sock: null, seat: null, mirror: null, nextAt: 0, target: rnd() * PI2, boostUntil: 0,
    boosting: false, deadAt: NaN, pingAt: 0, holdDone: false, holding: false, runOut: false };
  let stall = null; // { until, held: [] }
  function up(bytes) {
    if (stall) stall.held.push(bytes);
    else room.onInput(me.seat, bytes);
  }
  function seatMe() {
    const mirror = createSeatMirror(laws, inserts, () => room.sim, { fails: mfails, stats: mstats });
    const sock = serverSocket('human', (name, data) => {
      if (name !== 'sl:f') return;
      const u8 = Uint8Array.from(data);
      out.bundles++;
      mirror.onBundle(u8);
    }, () => {
      out.kicks++;
      room.unseat(sock, 'kick');
    });
    me.sock = sock;
    me.mirror = mirror;
    out.mirrors.push(mirror);
    me.seat = room.seat(sock, { nick: 'Soak human', cv: 4 });
    me.deadAt = NaN;
    me.holding = false;
    out.lives++;
    me.runOut = out.lives % 5 === 0; // every fifth life drives straight out into the border (L38, L39 border 0)
  }
  function steer(s) {
    if (vt >= me.pingAt) {
      me.pingAt = vt + 250;
      up(W.encodeInput([{ type: 'ping' }]));
    }
    if (me.holding || vt < me.nextAt) return;
    me.nextAt = vt + 200 + rnd() * 600;
    const grd = laws.L1.value;
    const hx = slSnake.headX(s) - grd;
    const hy = slSnake.headY(s) - grd;
    const flux = room.sim.flux();
    if (me.runOut) me.target = Math.atan2(hy, hx);
    else if (hx * hx + hy * hy > (0.6 * flux) * (0.6 * flux)) me.target = Math.atan2(-hy, -hx);
    else me.target += (rnd() - 0.5) * 1.6;
    me.target = ((me.target % PI2) + PI2) % PI2;
    up(W.encodeInput([{ type: 'angle', q: Math.floor((251 * me.target) / PI2) % 251 }]));
    if (!me.boosting && rnd() < 0.08) {
      me.boosting = true;
      me.boostUntil = vt + 300 + rnd() * 1500;
      up(W.encodeInput([{ type: 'boost', on: true }]));
    } else if (me.boosting && vt > me.boostUntil) {
      me.boosting = false;
      up(W.encodeInput([{ type: 'boost', on: false }]));
    }
  }

  seatMe();
  let nextWake = vt + P;
  const startTick = room.sim.tick();
  while (room.sim.tick() - startTick < o.ticks) {
    vt = nextWake;
    nextWake += P;
    const tick = room.sim.tick() - startTick;
    // the stall: the transport is not writable (polling with no GET parked) and the upstream is held, then one burst
    if (o.stallAtTick !== undefined && tick === o.stallAtTick && !stall && me.seat && !me.seat.closed) {
      stall = { until: vt + 3000, held: [], extra: 0 };
      me.sock.conn.transport.writable = false;
      out.stall = { atTick: tick, records: 0, kicksBefore: out.kicks };
    }
    if (stall) {
      // 74 records per second (the frozen client's busiest pattern: angles, a boost change every 37, pings)
      const want = Math.floor(((vt - (stall.until - 3000)) * 74) / 1000);
      while (stall.extra < want && stall.extra < 3 * 74) {
        const i = stall.extra++;
        if (i % 37 === 0) stall.held.push(W.encodeInput([{ type: 'boost', on: i % 74 === 0 }]));
        else if (i % 5 === 0) stall.held.push(W.encodeInput([{ type: 'ping' }]));
        else stall.held.push(W.encodeInput([{ type: 'angle', q: (i * 7) % 251 }]));
      }
      if (vt >= stall.until) {
        const held = stall.held;
        const stall0 = stall;
        stall = null;
        out.stall.records = stall0.extra;
        out.stall.held = held.length;
        if (me.seat && !me.seat.closed) for (const b of held) room.onInput(me.seat, b);
        me.sock.conn.transport.writable = true;
        me.sock.conn.transport.emit('ready');
        out.stall.kicksAfter = out.kicks;
        out.stall.closed = !me.seat || me.seat.closed;
      }
    }
    // the human: plays, holds Q once to a cash-out, plays again 1.5 s after any end
    if (me.seat && !me.seat.closed) {
      const s = room.sim.snake(me.seat.snakeId);
      if (s) {
        if (o.holdAtTick !== undefined && tick >= o.holdAtTick && !me.holdDone && !stall) {
          me.holdDone = true;
          me.holding = true;
          if (me.boosting) {
            me.boosting = false;
            up(W.encodeInput([{ type: 'boost', on: false }]));
          }
          room.onHold(me.seat, true);
        }
        steer(s);
      } else if (!stall) {
        if (!Number.isFinite(me.deadAt)) {
          me.deadAt = vt;
          if (me.seat.cashed) out.cashed++;
        }
        if (vt - me.deadAt > 1500) {
          room.unseat(me.sock, 'leave');
          seatMe();
        }
      }
    }
    T.runImmediates();
    room.wake();
    T.runImmediates();
    T.runTimeouts();
    if (tick > 0 && tick % 1000 === 0) check.full(room.sim);
  }
  check.full(room.sim);
  out.pongs = out.mirrors.reduce((n, m) => n + (m.tracker.byType.pong || 0), 0);
  out.maxBots = maxBots;
  out.maxSnakes = maxSnakes;
  return out;
}

let R = null;
function soak() {
  if (!R) R = runSoak({ seed: 7, ticks: TICKS, stallAtTick: Math.floor(TICKS * 0.4), holdAtTick: Math.floor(TICKS * 0.7) });
  return R;
}

test('the peak wall time: botTarget is 101 at every second of 35 minutes', () => {
  for (let t = PEAK_WALL; t < PEAK_WALL + 35 * 60000; t += 1000) assert.strictEqual(botTarget(t), 101);
});

test('slSoak: ' + TICKS + ' ticks of one human plus bots at the curve peak, every invariant every step', { timeout: 600000 }, () => {
  const r = soak();
  const st = r.check.stats();
  const f = r.check.fails;
  assert.deepStrictEqual(f.samples, [], 'server invariants');
  assert.strictEqual(f.total(), 0);
  assert.deepStrictEqual(r.mfails.samples, [], 'the mirrored seat');
  assert.deepStrictEqual(r.errors, [], 'room errors');
  assert.strictEqual(r.room.stats.failedWakes, 0);
  assert.strictEqual(st.steps, TICKS, 'the check saw every step');
  // the run was the run it says: the bots at the peak, everything exercised
  assert.strictEqual(r.maxSnakes, 101, 'the curve peak: humans + bots = 101');
  // floors: about half of what seed 7 gives over 20,000 ticks, scaled by the tick count
  const k = TICKS / 20000;
  assert.ok(st.snakeSteps > 90 * TICKS, 'snake steps ' + st.snakeSteps);
  assert.ok(st.eatsFood > 50000 * k, 'food eats ' + st.eatsFood);
  assert.ok(st.eatsPrey > 10 * k, 'prey eats ' + st.eatsPrey);
  assert.ok(st.charges > 1500 * k, 'charges ' + st.charges);
  assert.ok(st.boostDrops > 1500 * k, 'boost drops ' + st.boostDrops);
  assert.ok(st.deaths > 300 * k, 'deaths ' + st.deaths);
  assert.ok(st.borderDeaths >= 1, 'border deaths ' + st.borderDeaths);
  assert.ok(st.deathDrops > 20000 * k, 'death drops ' + st.deathDrops);
  assert.ok(st.grows > 10000 * k, 'grows ' + st.grows);
  assert.ok(st.newIds > 400 * k, 'new ids ' + st.newIds);
  assert.ok(st.fullChecks >= Math.floor(TICKS / 1000), 'full recounts ' + st.fullChecks);
});

test('slSoak: the mirrored seat got every move, every inserted point exact or a constant offset within 0.25', { timeout: 600000 }, () => {
  const r = soak();
  const m = r.mstats;
  assert.strictEqual(r.mfails.total(), 0);
  const k = TICKS / 20000;
  assert.ok(m.moves > 20000 * k, 'moves checked ' + m.moves);
  assert.ok(m.exactMoves > 1500 * k, 'moves of snakes held since spawn ' + m.exactMoves);
  assert.ok(m.offsetMoves > 15000 * k, 'moves of snakes added mid-life ' + m.offsetMoves);
  assert.ok(m.maxOffset <= 0.25, 'largest offset ' + m.maxOffset);
  assert.ok(m.maxDrift < 1e-9, 'largest drift ' + m.maxDrift);
  assert.ok(m.grows > 1000 * k, 'grows with fam checked ' + m.grows);
  assert.ok(m.ghostChecks === r.bundles, 'a ghost check after every bundle');
  assert.ok(m.foodGhostChecks > r.bundles / 20, 'food and prey ghost walks ' + m.foodGhostChecks);
  // the decoded-stream client model (scripts/slLoad.js) ran on the same bundles: its failures count in mfails above
  const foods = r.mirrors.reduce((n, x) => n + (x.tracker.byType.food_add || 0) + (x.tracker.byType.food_eat || 0), 0);
  assert.ok(foods > 10000, 'food adds and eats followed by cell ' + foods);
  assert.ok(r.pongs > TICKS / 30, 'pongs ' + r.pongs);
});

test('slSoak: a 3 s upstream stall at 74 records per second: no kick, no disconnect, the stream goes on', { timeout: 600000 }, () => {
  const r = soak();
  assert.ok(r.stall, 'the stall ran');
  assert.strictEqual(r.stall.records, 222, 'three seconds of 74 records');
  assert.ok(r.stall.held > 222, 'plus the human inputs of those 3 s, all in one burst (' + r.stall.held + ')');
  assert.strictEqual(r.stall.kicksAfter, r.stall.kicksBefore, 'no kick');
  assert.strictEqual(r.stall.closed, false, 'the seat stayed');
  assert.strictEqual(r.kicks, 0);
  assert.ok(r.lives >= 2, 'the human played again after an end (' + r.lives + ' lives)');
  assert.ok(r.cashed >= 1, 'the hold reached a cash-out');
});

// ---------------------------------------------------------------------------------------------------- negative controls

// A small room, stepped by hand, to break one thing at a time.
function smallRoom(seed) {
  const laws = makeFixture();
  let vt = 1000;
  const T = makeTimers(() => vt);
  const room = new SlRoom(laws, {
    seed, view: require('../server/sl/slView'), bots: createBotDriver(laws, {}), clock: () => vt,
    now: () => PEAK_WALL + vt, timers: T.timers, autoTick: false, shippableOnly: false, prey: true,
    log: { log() {}, warn() {}, error() {} },
  });
  const check = createSoakCheck(laws);
  const inserts = createInsertLog();
  return { laws, room, check, inserts, step() { vt += room.P; room.wake(); T.runImmediates(); T.runTimeouts(); }, T };
}

test('negative control: a non-finite fam is caught', () => {
  const x = smallRoom(3);
  let broke = false;
  hookRoom(x.room, {
    check: x.check,
    onAfterStep(r) {
      if (!broke && r.sim.tick() === 40) {
        broke = true;
        r.sim.forEachSnake((s) => { if (s.id === 1) s.fam = NaN; });
      }
    },
  });
  // the check runs before the view, which then refuses to encode the NaN (slQuant throws): both stop it
  let threw = null;
  try {
    for (let i = 0; i < 60; i++) x.step();
  } catch (e) {
    threw = e;
  }
  assert.ok(threw && /finite/.test(threw.message), 'the encoder refuses it too');
  assert.ok(x.check.fails.by.nan >= 1, JSON.stringify(x.check.fails.by));
});

test('negative control: a head past the border is caught', () => {
  const x = smallRoom(4);
  let moved = 0;
  hookRoom(x.room, { check: x.check });
  // between steps, push a snake's whole body far outside: the step's own L38 test kills it, so the snake must be moved
  // after the test; a wrapped afterStep moves it before the check runs
  const d = x.room.bots;
  const after = d.afterStep;
  d.afterStep = function (r, log, simMs) {
    if (!moved && r.sim.tick() === 50) {
      r.sim.forEachSnake((s) => {
        if (moved) return;
        moved = s.id;
        s.hx += 2 * r.sim.flux();
      });
    }
    return after.call(this, r, log, simMs);
  };
  for (let i = 0; i < 60; i++) x.step();
  assert.ok(moved > 0);
  assert.ok(x.check.fails.by.border >= 1, JSON.stringify(x.check.fails.by));
});

test('negative control: fam that did not come from an eat, and length from nowhere, are caught', () => {
  const x = smallRoom(5);
  hookRoom(x.room, { check: x.check });
  const d = x.room.bots;
  const after = d.afterStep;
  d.afterStep = function (r, log, simMs) {
    if (r.sim.tick() === 30) r.sim.forEachSnake((s) => { if (s.id === 2) s.fam += 1e-3; });
    return after.call(this, r, log, simMs);
  };
  const before = d.beforeInputs;
  d.beforeInputs = function (r, ms) {
    before.call(this, r, ms);
    // after the check's snapshot: a point appears with no charge and no eat
    if (r.sim.tick() === 40) r.sim.forEachSnake((s) => { if (s.id === 3) s.fam += 1; });
  };
  for (let i = 0; i < 50; i++) x.step();
  assert.ok(x.check.fails.by.length >= 2, JSON.stringify(x.check.fails.by));
});

test('negative control: a food that vanishes, and death drops off L39, are caught', () => {
  const x = smallRoom(6);
  hookRoom(x.room, { check: x.check });
  const d = x.room.bots;
  const after = d.afterStep;
  let ate = false;
  d.afterStep = function (r, log, simMs) {
    if (!ate && r.sim.tick() === 30) {
      // a food leaves the store without an eat record
      r.sim.food.forEachFood((f) => {
        if (ate) return;
        ate = true;
        r.sim.grid.foodDel(f.id);
      });
    }
    if (log.deaths.length) log.deaths[0].drops.pop();
    return after.call(this, r, log, simMs);
  };
  for (let i = 0; i < 40; i++) x.step();
  assert.ok(ate);
  assert.ok(x.check.fails.by.food >= 1, JSON.stringify(x.check.fails.by));
  // a death of a length-2 snake by hand: its drops must be 2 x 2 + 1; one less is caught
  const y = smallRoom(8);
  hookRoom(y.room, { check: y.check });
  const yd = y.room.bots;
  const yafter = yd.afterStep;
  yd.afterStep = function (r, log, simMs) {
    for (const dd of log.deaths) if (dd.drops.length) dd.drops.pop();
    return yafter.call(this, r, log, simMs);
  };
  for (let i = 0; i < 10; i++) y.step(); // the driver adds its first bots
  let victim = 0;
  y.room.sim.forEachSnake((s) => { if (!victim) victim = s.id; });
  assert.ok(victim > 0);
  y.room.sim.kill(victim);
  for (let i = 0; i < 3; i++) y.step();
  assert.ok(y.check.fails.by.deathDrops >= 1, JSON.stringify(y.check.fails.by));
});

test('negative control: a reused id inside the quarantine is caught', () => {
  const x = smallRoom(9);
  hookRoom(x.room, { check: x.check });
  for (let i = 0; i < 5; i++) x.step();
  // fake the books: an id that left 1 ms of sim time ago comes back
  let some = 0;
  x.room.sim.forEachSnake((s) => { if (!some) some = s.id; });
  x.check.beforeStep(x.room); // known
  const s = x.room.sim.snake(some);
  x.room.sim.remove(some);
  x.check.beforeStep(x.room); // it left now
  const s2 = x.room.sim.spawn({ cv: 1, nick: 'back' });
  assert.notStrictEqual(s2, s);
  // the sim gives a fresh id; pretend the fresh id is the one that left
  x.check.beforeStep({ sim: { nowMs: () => x.room.sim.nowMs(), forEachSnake(fn) { fn(Object.assign({}, s2, { id: some })); },
    snake: () => null, flux: () => x.room.sim.flux(), food: null, preys: null }, seats: new Map() });
  assert.ok(x.check.fails.by.idReused >= 1, JSON.stringify(x.check.fails.by));
});

test('the check keeps a left id only while its quarantine runs (its own heap) and still counts every reuse', () => {
  const x = smallRoom(11);
  hookRoom(x.room, { check: x.check });
  const Q = x.laws.C_ID_QUARANTINE_MS.value;
  const KILL_EVERY = 20;
  const steps = Math.ceil(2.2 * Q / x.room.P);
  let maxFreed = 0;
  for (let i = 0; i < steps; i++) {
    if (i % KILL_EVERY === 10) {
      let v = 0;
      x.room.sim.forEachSnake((s) => { if (!v) v = s.id; });
      if (v) x.room.sim.kill(v);
    }
    x.step();
    maxFreed = Math.max(maxFreed, x.check.freedSize());
  }
  const st = x.check.stats();
  assert.strictEqual(x.check.fails.total(), 0, JSON.stringify(x.check.fails.samples));
  assert.ok(st.idsLeft >= Math.floor(steps / KILL_EVERY), st.idsLeft + ' ids left');
  assert.ok(st.idsLeft > 1.5 * maxFreed, st.idsLeft + ' ids left, the book held ' + maxFreed + ' at most');
  const age = x.room.sim.nowMs() - x.check.freedOldest();
  assert.ok(age < Q + KILL_EVERY * x.room.P, 'oldest entry ' + age + ' ms');
});

test('negative control: the mirror catches a moved point, a skipped move, a ghost and a wire error', () => {
  const laws = makeFixture();
  const inserts = { get: () => ({ n: 3, xs: Float64Array.from([0, 100, 142, 184].concat(new Array(1020).fill(0))),
    ys: new Float64Array(1024), fams: new Float64Array(1024) }) };
  const alive = new Set([5]);
  const m = createSeatMirror(laws, inserts, () => ({ snake: (id) => (alive.has(id) ? {} : null) }));
  const init = { type: 'init', grd: 21600, mscps: 411, sectorSize: 300, sectorCount: 144, spangdv: 4.8, nsp1: 5.39,
    nsp2: 0.4, nsp3: 14, mamu: 0.033, mamu2: 0.028, cst: 0.43, pv: 19, defaultMsl: 42, realSid: 0, fluxGrd: 21600,
    gameMode: 1, extraB: 0 };
  // a snake added with its last point at (100, 0), angle 0 (iang 0): a g move steps msl 42 to (142, 0) = insert 2
  const add = { type: 'snake_add', id: 5, ang: 0, wang: 0, sp: 5.39, fam: 0, cv: 1, snx: 100, sny: 0, nick: 'x',
    raw: { pts: [{ x: 290, y: 0 }, { iang: 0 }] } };
  m.onBundle(W.encodeBundle([init, add, { type: 'snake_move', cmd: 'g', own: false, id: 5 }], 19));
  assert.strictEqual(m.fails.total(), 0, JSON.stringify(m.fails.samples));
  // the next move must be insert 3 at 184; send one that lands 1 unit off
  m.onBundle(W.encodeBundle([{ type: 'snake_move', cmd: 'g', own: false, id: 5, iang: 100 }], 19));
  assert.ok(m.fails.by.mirrorPoint >= 1, JSON.stringify(m.fails.by));
  // a move past the last insert (the server never made it)
  m.onBundle(W.encodeBundle([{ type: 'snake_move', cmd: 'g', own: false, id: 5 }], 19));
  assert.ok(m.fails.by.mirrorAhead >= 1, JSON.stringify(m.fails.by));
  // the snake dies on the server but the seat is never told: a ghost
  alive.delete(5);
  m.onBundle(W.encodeBundle([], 19));
  assert.ok(m.fails.by.mirrorGhost >= 1, JSON.stringify(m.fails.by));
  m.onBundle(Uint8Array.from([99, 1, 2]));
  assert.ok(m.fails.by['stream.wireError'] >= 1, JSON.stringify(m.fails.by));
});
if (process.env.SL_SOAK_PRINT) {
  test('print', { timeout: 600000 }, () => {
    const r = soak();
    console.log(JSON.stringify({ check: r.check.stats(), m: r.mstats, lives: r.lives, cashed: r.cashed, bundles: r.bundles,
      pongs: r.pongs, maxBots: r.maxBots, maxSnakes: r.maxSnakes, stall: r.stall, room: r.room.stats }, null, 1));
  });
}
