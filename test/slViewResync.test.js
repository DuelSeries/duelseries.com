'use strict';
// The seat stream faults of the T15 soak (task T8b; recordings/OURS-SOAK.md, first 30-minute run: stream.unknownPrey 4
// and one mirrorGhost). FIXTURE table only. OUR room (server/sl/slRoom.js with the real sim, view, send queue and bot
// driver, prey on) on a virtual clock; every bundle a seat is sent goes to scripts/slLoad.js's client model (an id the
// client does not hold, a second add) and to scripts/slSoakCheck.js's seat mirror (moves, snake ghosts), as in the soak.
//
// The causes, each reproduced here first (the commits named are where each test FAILS):
//  1. A resync after a DELIVERED prey_eaten sent prey_remove for the eaten prey: the queue's delivered set kept it.
//     Fixed in 153aba0 (slSendQueue tagOf prey_eaten). In-process at 82fdcf6: 7 unknown prey removals in 627 forced
//     resyncs; at 153aba0 0. Test 1 fails on 82fdcf6.
//  2. Still open at 153aba0: a resync with records still QUEUED sent a removal for every id a dropped add had added
//     (the client never got that add) and a second removal for every queued removal it kept (SERVER-DESIGN 9.3 took
//     "delivered plus every id added by a discarded record" and called the extra removals no-ops). Their server never
//     sends a removal of an id its client does not hold (P1), and scripts/slLoad.js, the load-test bar, counts each as
//     an unknown id. In-process at 153aba0: 97 unknown snake, 20 unknown prey and 127 mirror removals in 606 forced
//     resyncs with records queued; the room's own cap path (C_PENDING_CAP 5000): 31 in 4 resyncs. Fixed in
//     slSendQueue resync (the client's set is followed through the kept records; this task's hunk, carried by commit
//     6b24821, which took the working file while both ran). Test 2 fails on 153aba0: 6 unknown snake, 2 unknown prey
//     and 30 mirror removals in its 6 cap resyncs (24 dropped adds of ids the client never got, 8 kept removals).
//  3. mirrorGhost: a long-polling GET that lands between the slices of a sliced wake is answered at once with what was
//     queued before that wake (the queue's 'ready' flush), so a snake that died in the wake's steps is still on that
//     client until its seat part. Behind, not wrong (the soak's check skips such bundles since 82fdcf6; with the skip
//     off the same run shows 21 snake and 36 food "ghosts", with it 0 in 27,962 checks). Test 3 pins that the strict
//     check sees exactly that and that the seat's part of the same wake sends the removal. No server change.

const test = require('node:test');
const assert = require('node:assert/strict');

const W = require('../shared/slWire.js');
const slSnake = require('../server/sl/slSnake');
const SV = require('../server/sl/slView');
const { SlRoom } = require('../server/sl/slRoom');
const { createBotDriver } = require('../server/sl/slBots');
const { makeFixture } = require('./slLawsFixture');
const { fakeSocket } = require('./slNetFakes');
const { makeTimers } = require('./slMirrorRig');
const { createInsertLog, createSeatMirror, createFailures, hookRoom, createSoakCheck } = require('../scripts/slSoakCheck');

const PI2 = 2 * Math.PI;
const PEAK_WALL = Date.UTC(2026, 9, 10, 0, 0, 0); // botTarget 101 here (test/slSoak.test.js)

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

// opts: { seed, laws, bots, check, sliceStep (clock ms added per clock read, so wakes slice) }
function makeRoom(o) {
  const laws = o.laws || makeFixture();
  const env = { vt: 1000, drift: 0, inWake: false };
  const T = makeTimers(() => env.vt);
  const room = new SlRoom(laws, {
    seed: o.seed, view: SV, bots: o.bots ? createBotDriver(laws, {}) : undefined,
    clock: () => (o.sliceStep && env.inWake ? (env.drift += o.sliceStep, env.vt + env.drift) : env.vt + env.drift),
    now: () => PEAK_WALL + env.vt, timers: T.timers, autoTick: false, shippableOnly: false, prey: true,
    log: { log() {}, warn() {}, error() {} },
  });
  const inserts = createInsertLog();
  hookRoom(room, { check: o.check === false ? null : createSoakCheck(laws), inserts });
  return { laws, env, T, room, inserts, fails: createFailures(), rnd: mulberry32((o.seed || 1) ^ 0x5eed), P: room.P };
}

// One human on a fake engine.io socket (test/slNetFakes.js), every sl:f fed to its mirror and to h.onBundle.
function seatHuman(R, nick, transport, behind) {
  const sock = fakeSocket(transport, () => R.env.vt);
  const h = { sock, nick, mirror: null, seat: null, onBundle: null, nextAt: 0, pingAt: 0, target: R.rnd() * PI2, deadAt: NaN };
  h.mirror = createSeatMirror(R.laws, R.inserts, () => R.room.sim, { fails: R.fails, behind: behind || (() => false) });
  const emit = sock.emit;
  sock.emit = function tapped(name, data) {
    if (name === 'sl:f') {
      const u8 = Uint8Array.from(data);
      if (h.onBundle) h.onBundle(u8, 'before');
      h.mirror.onBundle(u8);
      if (h.onBundle) h.onBundle(u8, 'after');
    }
    return emit.call(this, name, data);
  };
  if (transport === 'polling') sock.conn.transport.writable = true; // a GET is parked for the join bundle
  h.seat = R.room.seat(sock, { nick, cv: 3 });
  return h;
}

// The soak's steering: pings every 250 ms, a new heading every 0.2 to 0.8 s, back towards the centre past 0.6 flux.
function steer(R, h) {
  const s = R.room.sim.snake(h.seat.snakeId);
  if (!s) return false;
  const vt = R.env.vt;
  if (vt >= h.pingAt) {
    h.pingAt = vt + 250;
    R.room.onInput(h.seat, W.encodeInput([{ type: 'ping' }]));
  }
  if (vt >= h.nextAt) {
    h.nextAt = vt + 200 + R.rnd() * 600;
    const grd = R.laws.L1.value;
    const hx = slSnake.headX(s) - grd;
    const hy = slSnake.headY(s) - grd;
    const f = R.room.sim.flux();
    if (hx * hx + hy * hy > (0.6 * f) * (0.6 * f)) h.target = Math.atan2(-hy, -hx);
    else h.target += (R.rnd() - 0.5) * 1.6;
    h.target = ((h.target % PI2) + PI2) % PI2;
    R.room.onInput(h.seat, W.encodeInput([{ type: 'angle', q: Math.floor((251 * h.target) / PI2) % 251 }]));
  }
  return true;
}

// One wake on the virtual clock: before() and its immediates, then mid() (an immediate scheduled there runs between the
// wake's first slice and the next), the room's due steps and seat part, immediates (slices) and timeouts. The clock
// moves P plus 1e-6 ms a wake, so float sums never leave a wake a hair short of due (one step every wake); with
// sliceStep it also moves while the wake runs (reset at the next wake, which still starts later than this one ended).
function wake(R, before, mid) {
  R.env.vt += R.P + 1e-6;
  R.env.drift = 0;
  if (before) before();
  R.T.runImmediates();
  if (mid) mid();
  R.env.inWake = true;
  R.room.wake();
  R.T.runImmediates();
  R.env.inWake = false;
  R.T.runTimeouts();
}

// The soak's forced resync (scripts/slSoak.js forceResync = the room's own branch in slRoom _seatPart), between wakes.
function forceResync(R, seat) {
  const room = R.room;
  const tick = room.sim.tick();
  seat.queue.resync(tick, room.clock());
  room.stats.resyncs++;
  seat.view.resync();
  const again = seat.view.collect({ tick, simMs: room.sim.nowMs(), flux: room.sim.flux(), frames: [], dead: seat.dead });
  room._pushEvents(seat, tick, again);
  seat.queue.flush(room.clock());
}

function failures(R) {
  return { by: R.fails.by, samples: R.fails.samples.slice(0, 6) };
}

test('1. a resync after a delivered prey_eaten sends no prey_remove for the eaten prey (soak stream.unknownPrey)', () => {
  const R = makeRoom({ seed: 22, bots: false, check: false });
  let h = seatHuman(R, 'eater', 'websocket');
  const ex = { eatenDelivered: 0, resyncsAfterEat: 0 };
  let owed = false; // a prey_eaten reached the seat since its last resync
  let target = 0; // the prey being brought to the own head
  const hook = (hh) => {
    hh.onBundle = (u8, when) => {
      if (when !== 'before') return;
      for (const ev of W.decodeBundle(u8)) {
        if (ev.type === 'prey_eaten') {
          ex.eatenDelivered++;
          owed = true;
        }
      }
    };
  };
  hook(h);
  for (let w = 0; w < 4000 && ex.resyncsAfterEat < 4; w++) {
    wake(R, () => {
      if (owed && !h.seat.closed && !h.seat.dead && R.room.sim.snake(h.seat.snakeId)) {
        owed = false;
        forceResync(R, h.seat);
        ex.resyncsAfterEat++;
      }
      if (!steer(R, h)) {
        if (!Number.isFinite(h.deadAt)) h.deadAt = R.env.vt;
        if (R.env.vt - h.deadAt > 1500) {
          R.room.unseat(h.sock, 'leave');
          h = seatHuman(R, 'eater', 'websocket');
          hook(h);
        }
        return;
      }
      // a prey spawned 120 units ahead of the own head (the prey store's own spawnAt, between steps), so the seat's next
      // adds walk gives it to the seat; once the seat holds it, a test move puts it on the own head (the sim's own prey
      // object; not prey motion), so the next step's L31 eat takes it and the seat is sent its prey_eaten
      if (owed || w % 10 !== 0) return;
      const s = R.room.sim.snake(h.seat.snakeId);
      const preys = R.room.sim.preys;
      if (target && preys.get(target) && h.seat.view.mirror().prey.includes(target)) {
        const p = preys.get(target);
        p.x = slSnake.headX(s);
        p.y = slSnake.headY(s);
        target = 0;
      } else if (!target || !preys.get(target)) {
        const p = preys.spawnAt(slSnake.headX(s) + 120 * Math.cos(s.ang), slSnake.headY(s) + 120 * Math.sin(s.ang));
        target = p ? p.id : 0;
      }
    });
  }
  assert.ok(ex.eatenDelivered >= 4 && ex.resyncsAfterEat >= 4, 'exercised: ' + JSON.stringify(ex));
  assert.deepEqual(failures(R), { by: {}, samples: [] });
});

test('2. a cap resync with records still queued: no removal of an id the client never got, no second removal', () => {
  const R = makeRoom({ seed: 21, bots: true, laws: makeFixture({ C_PENDING_CAP: 4000 }) });
  let h = null;
  const ex = { resyncs: 0, droppedAdds: 0, keptRemovals: 0, stalls: 0, kicks: 0 };
  let stall = null;
  let w = 0;
  let lastResyncW = -1000;
  // what the seat's queue holds that the client never got: every add and removal pushed since the last sl:f
  function instrument(hh) {
    const q = hh.seat.queue;
    let queued = [];
    const push = q.push;
    q.push = function tapped(tick, ev, bytes, alt) {
      if (ev.type === 'snake_add' || ev.type === 'prey_add' || ev.type === 'snake_remove' || ev.type === 'prey_remove') queued.push(ev);
      return push.call(this, tick, ev, bytes, alt);
    };
    const checkCap = q.checkCap;
    q.checkCap = function tapped(tick, now) {
      const snakes = new Set(q.delivered.snakes);
      const preys = new Set(q.delivered.preys);
      const r = checkCap.call(this, tick, now);
      if (r === 'resync') {
        ex.resyncs++;
        lastResyncW = w;
        for (const ev of queued) {
          const set = ev.type[0] === 's' ? snakes : preys;
          if (ev.type.endsWith('_add') && ev.id !== hh.seat.snakeId && !set.has(ev.id)) ex.droppedAdds++;
          if (ev.type.endsWith('_remove') && set.has(ev.id)) ex.keptRemovals++;
        }
      }
      if (r !== 'ok') queued = [];
      return r;
    };
    hh.onBundle = (u8, when) => {
      if (when === 'after') queued = [];
    };
    const disc = hh.sock.disconnect;
    hh.sock.disconnect = function tapped() {
      ex.kicks++;
      return disc.call(this);
    };
  }
  h = seatHuman(R, 'capped', 'websocket');
  instrument(h);
  for (; w < 2400; w++) {
    wake(R, () => {
      const tr = h.sock.conn.transport;
      // a stall: the transport takes nothing (writable false) until the room resyncs the seat, then a GET lands
      if (stall && (h.seat.closed || h.seat.dead || R.room.stats.resyncs > stall.at || w - stall.from > 150)) {
        stall = null;
        tr.park();
      } else if (!stall && w >= 100 && w - lastResyncW >= 280 && w % 20 === 0 && !h.seat.closed && !h.seat.dead) {
        // (C_RESYNC_GAP_MS 10000: a cap hit within 10 s of the last resync is a kick, so 280 wakes (11.9 s) apart)
        stall = { at: R.room.stats.resyncs, from: w };
        ex.stalls++;
        tr.writable = false;
      }
      if (!steer(R, h) && !stall) {
        if (!Number.isFinite(h.deadAt)) h.deadAt = R.env.vt;
        if (R.env.vt - h.deadAt > 1500) {
          R.room.unseat(h.sock, 'leave');
          h = seatHuman(R, 'capped', 'websocket');
          instrument(h);
        }
      }
    });
  }
  assert.equal(ex.kicks, 0, JSON.stringify(ex));
  assert.ok(ex.resyncs >= 4 && ex.droppedAdds >= 1, 'exercised (a dropped add of an id the client never got): ' + JSON.stringify(ex));
  assert.deepEqual(failures(R), { by: {}, samples: [] });
});

test('3. a GET between the slices of a wake gets the state before it (behind, not a ghost); the seat part removes the dead snake', () => {
  // the clock moves 1 ms per read inside a wake, so the seat part slices (C_FLUSH_SLICE_MS 6) after a seat or two
  const R = makeRoom({ seed: 23, bots: true, sliceStep: 1 });
  const fillers = [];
  for (let k = 0; k < 4; k++) fillers.push(seatHuman(R, 'f' + k, 'websocket'));
  // the long-polling seat, seated last so its seat part runs in a later slice; strict mirror (nothing skipped)
  const a = seatHuman(R, 'poller', 'polling');
  const seen = [];
  a.onBundle = (u8, when) => {
    if (when !== 'after') return;
    seen.push({ pending: R.room._seatPending(a.seat), held: new Set(a.mirror.held.keys()), tick: R.room.sim.tick() });
  };
  const park = () => {
    if (!a.sock.conn.transport.writable) a.sock.conn.transport.park();
  };
  // play with a GET parked before every wake until the poller holds a snake other than its own
  let X = 0;
  for (let w = 0; w < 600 && !X; w++) {
    wake(R, () => {
      for (const f of fillers) steer(R, f);
      steer(R, a);
      park();
    });
    const held = a.seat.view.mirror().snakes.filter((id) => id !== a.seat.snakeId && a.mirror.held.has(id));
    if (held.length && R.room.sim.snake(a.seat.snakeId) && w > 40) X = held[0];
  }
  assert.ok(X > 0, 'the poller holds another snake');
  // wake W-1: no GET, so its records stay queued
  wake(R, () => steer(R, a));
  assert.ok(a.seat.queue.length > 0, 'records queued for the poller');
  X = a.seat.view.mirror().snakes.find((id) => id !== a.seat.snakeId && a.mirror.held.has(id) && R.room.sim.snake(id)) || 0;
  assert.ok(X > 0 && R.room.sim.snake(a.seat.snakeId), 'the poller is alive and holds a live snake X');
  // wake W: X dies in its step; a GET lands between the slices, before the poller's seat part
  const before = seen.length;
  R.room.sim.kill(X);
  wake(R, null, () => R.T.timers.setImmediate(() => park()));
  assert.ok(R.room.stats.slices > 0, 'the wake sliced');
  assert.equal(R.room.sim.snake(X), null, 'X died in the step');
  const mid = seen.slice(before);
  assert.equal(mid.length, 1, 'one bundle left during the wake: the GET between the slices');
  assert.equal(mid[0].pending, true, 'it went before the poller\'s seat part (slRoom _seatPending)');
  assert.equal(mid[0].held.has(X), true, 'the client still holds X: the strict check calls this a ghost');
  assert.equal(R.fails.by.mirrorGhost >= 1, true, 'the strict mirror flagged it');
  // the poller's seat part of that wake queued X's removal: the next GET carries it
  wake(R, () => park());
  const next = seen.slice(before + 1);
  assert.ok(next.length >= 1);
  assert.equal(next[0].pending, false);
  assert.equal(next[0].held.has(X), false, 'the removal of X came with the seat part of the wake X died in');
  // and with the soak's skip of a bundle sent before the seat's part, the same run is clean
  const by = Object.assign({}, R.fails.by);
  delete by.mirrorGhost;
  delete by.mirrorFoodGhost;
  assert.deepEqual(by, {});
});
