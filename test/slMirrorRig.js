'use strict';
// The mirror rig for task T10 (SERVER-DESIGN 18.2 items 6 and 7). TEST ONLY: never imported by shipped code. No test
// runs here (node --test loads every .js under test/, and this file only defines functions).
//
// runRig(opts) runs OUR room (server/sl/slRoom.js, the real sim, view and send queue, the FIXTURE table) on a virtual
// clock with fake timers, with scripted seats around it, and optionally the frozen client in the vm page of
// test/slVmPage.js on ONE seat (the mirrored seat), side by side with the server:
//   - the client's game socket is a live transport: Play opens it, sl:join seats it in the room, every input bundle
//     reaches room.onInput after the upstream latency, every sl:f the room emits for the seat is applied by the client
//     after the downstream latency, in the frame's socket hook as the harness does (slParityGate.test.js:389-401);
//   - stalls: the seat's transport is not writable (polling with no parked GET, engine.io 6.6.11) for a window, its
//     upstream is held and arrives as one burst at the end (one POST at a time, engine.io-client polling.js:138-145);
//     at the end the transport becomes writable and emits 'ready' (the send queue's flush point (b), SERVER-DESIGN 9.1);
//   - the resync stall: a leave (a seat goes: its snake glides C_DISCONNECT, then dies) and a death (sim.kill) of
//     snakes the seat holds happen at the start, a cash-out (hold Q to C_HOLD_MS, the snake vanishes) completes inside
//     it; the queue passes C_PENDING_CAP (a test value) inside the window, so the room resyncs the seat, and the stall
//     ends one wake after the resync.
// The server side is observed through the room's optional bot driver hook afterStep(room, log, simMs) (slRoom.js
// header, step 8): every point a move INSERTED (slSnake rec.xx, rec.yy, rec.iang, valid during the step) and a state
// snapshot of every live snake per tick. Every bundle the rig captures carries the tick it left at.
//
// The checks themselves live in the callers (test/slMirror.test.js, test/slFormCoverage.test.js); the rig reports
// what it saw: per-bundle callbacks, the client's probe of inserted points, counters.

const { EventEmitter } = require('events');
const W = require('../shared/slWire.js');
const slQuant = require('../server/sl/slQuant');
const slSnake = require('../server/sl/slSnake');
const { SlRoom } = require('../server/sl/slRoom');
const { makeFixture } = require('./slLawsFixture');
const V = require('./slVmPage');

const PI2 = 2 * Math.PI;

// ---------------------------------------------------------------------------------------------------- fakes

// Virtual timers for the room (slSafe timers shape). The room runs with autoTick false; immediates are the on-arrival
// flush (SERVER-DESIGN 5.2 item 4) and slices.
function makeTimers(nowFn) {
  const timeouts = new Map();
  let seq = 0;
  let imms = [];
  return {
    timers: {
      setTimeout(fn, ms) {
        const h = { id: ++seq, unref() {} };
        timeouts.set(h, { at: nowFn() + Math.max(1, +ms || 0), fn, seq: h.id });
        return h;
      },
      clearTimeout(h) { timeouts.delete(h); },
      setImmediate(fn) {
        const h = { fn, live: true };
        imms.push(h);
        return h;
      },
      clearImmediate(h) { if (h) h.live = false; },
    },
    runImmediates() {
      for (let guard = 0; imms.length; guard++) {
        if (guard > 10000) throw new Error('slMirrorRig: immediates never settle');
        const list = imms;
        imms = [];
        for (const h of list) if (h.live) { h.live = false; h.fn(); }
      }
    },
    runTimeouts() {
      for (;;) {
        let best = null;
        for (const [h, t] of timeouts) if (t.at <= nowFn() && (!best || t.at < best[1].at || (t.at === best[1].at && t.seq < best[1].seq))) best = [h, t];
        if (!best) return;
        timeouts.delete(best[0]);
        best[1].fn();
      }
    },
  };
}

// A server-side socket.io socket on a WebSocket-like engine.io transport that the rig can stall (writable false, as
// polling between GETs) and release (writable true, then 'ready', engine.io's flush point).
class Transport extends EventEmitter {
  constructor() {
    super();
    this.name = 'websocket';
    this.writable = true;
  }
}
let sockSeq = 0;
function serverSocket(tag, onEmit, onDisconnect) {
  const transport = new Transport();
  const conn = new EventEmitter();
  conn.transport = transport;
  conn.writeBuffer = [];
  conn.flush = () => {};
  return {
    id: tag + '#' + (++sockSeq),
    conn,
    disconnected: false,
    emit(name, data) { onEmit(name, data); },
    disconnect() {
      if (this.disconnected) return;
      this.disconnected = true;
      if (onDisconnect) onDisconnect();
    },
  };
}

// ---------------------------------------------------------------------------------------------------- the view

// The room's seat view factory: server/sl/slView.js implements the room's contract (createWorld, createSeatView).
function baseView() {
  return require('../server/sl/slView');
}

// A view that changes what ONE seat (the one whose snake is named nick) is sent: fn(events, ctx) returns the events
// to send (copies, never the shared event objects, which the room's record cache keys). For negative controls.
function tamperedView(nick, fn) {
  const base = baseView();
  return {
    createWorld: (laws, sim) => base.createWorld(laws, sim),
    createSeatView(laws, ctx) {
      const v = base.createSeatView(laws, ctx);
      const s = ctx.sim.snake(ctx.ownId);
      const mine = !!s && s.nick === nick;
      const pass = (evs, c) => (mine ? fn(evs, c, ctx) : evs);
      return {
        join: (c) => pass(v.join(c), c),
        collect: (c) => pass(v.collect(c), c),
        noteOwnRot: typeof v.noteOwnRot === 'function' ? (e) => v.noteOwnRot(e) : undefined,
        resync: () => v.resync(),
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------------- the rig

// opts:
//   seed        room and script seed
//   ticks       sim ticks to run
//   others      scripted seats (default 24)
//   client      true: the frozen client plays the mirrored seat in the vm page; false: a scripted mirrored seat
//   prey        room prey on (default true)
//   cap         C_PENDING_CAP for this run (a test value; the real one is sized by the T15 load test)
//   stalls      [{ at (ms after start), ms, resync (true: the resync stall) }] on the mirrored seat
//   down, up    one-way latency ms (default 20 and 20)
//   frameMs     client frame step (default 16.6667, the harness's 60 Hz)
//   onBundle(b) every bundle of the mirrored seat after the client applied it (client) or when emitted (scripted):
//               b = { n, bytes, tick, snap (every live snake now), prevTick, own (seat snake id), afterStall,
//               resyncs, flux, delivered (when wantDelivered(b) said so) }; out (the rig's state) is the third argument
//   wantDelivered(b)  true: attach the queue's delivered layer and the server world now (ghost checks)
//   onBoot(P)   after the client page booted (slMirror installs its probe here)
//   view        a view factory in place of slView's (negative controls)
//   onOther(bytes) every bundle of a scripted seat (only when given)
//   onFrame(P)  after every client frame
function runRig(opts) {
  const o = opts || {};
  const seed = o.seed >>> 0;
  const laws = makeFixture(Object.assign({ C_PENDING_CAP: o.cap || 16384 }, o.patch || {}));
  const rnd = V.mulberry32(seed ^ 0x5eed);
  let vt = 1000; // virtual ms (the page's own clock starts at 1000)
  const T = makeTimers(() => vt);
  const insertsOf = new Map(); // server snake object -> [{ xx, yy, iang, tick }]
  const snaps = new Map(); // tick -> Map(id -> snapshot)
  const idObj = new Map(); // id -> last server snake object seen
  const out = {
    room: null, page: null, laws, bundles: 0, otherBundles: 0, layerBatches: 0, kicks: 0, resyncAt: null,
    stallEvents: [], lives: 0, closes: 0, errors: [], snaps, insertsOf, deaths: 0,
  };

  function snapshotNow(room) {
    const m = new Map();
    room.sim.forEachSnake((s) => {
      idObj.set(s.id, s);
      const ins = insertsOf.get(s);
      m.set(s.id, {
        s, sct: s.pts.length, fam: s.fam, famSent: s.famSent, sp: s.sp, wang: s.wang, ang: s.ang,
        hx: slSnake.headX(s), hy: slSnake.headY(s), inserts: ins ? ins.length : 0,
        pending: s.inAngle >= 0 || s.inTurn !== 0,
      });
    });
    return m;
  }

  // The observer hook (the room's optional bot driver; no bots are added).
  const observer = {
    beforeInputs() {},
    afterStep(room, log, simMs) {
      const tick = room.sim.tick();
      for (let i = 0; i < log.updates.length; i++) {
        const rec = log.updates[i];
        if (!rec.move) continue;
        const s = room.sim.snake(rec.id) || idObj.get(rec.id);
        if (!s) continue;
        let list = insertsOf.get(s);
        if (!list) insertsOf.set(s, (list = []));
        list.push({ xx: rec.xx, yy: rec.yy, iang: rec.iang, tick });
      }
      out.deaths += log.deaths.length;
      snaps.set(tick, snapshotNow(room));
      snaps.delete(tick - 800);
    },
    add() { return false; },
    clear() { return 0; },
    count() { return 0; },
    isBot() { return false; },
  };

  const room = new SlRoom(laws, {
    seed, view: o.view || baseView(), bots: observer, clock: () => vt, now: () => vt, timers: T.timers, autoTick: false,
    shippableOnly: false, prey: o.prey !== false, log: { log() {}, warn() {}, error(...a) { out.errors.push(a.join(' ')); } },
  });
  out.room = room;
  const P_MS = room.P;

  // ---- upstream queue (inputs, joins, leaves) and the stall state of the mirrored seat
  const up = []; // { at, fn }
  const UP = o.up === undefined ? 20 : o.up;
  const DOWN = o.down === undefined ? 20 : o.down;
  let stall = null; // { until, held: [] , resync }
  function sendUp(fn) {
    const e = { at: vt + UP, fn };
    if (stall) stall.held.push(e);
    else up.push(e);
  }

  // ---- scripted seats: wanderers that stay inside the border, boost now and then, and rejoin after a death
  const others = [];
  function seatOther(k) {
    const w = { k, sock: null, seat: null, nextAt: vt, boostUntil: 0, deadAt: NaN, target: rnd() * PI2 };
    w.sock = serverSocket('o' + k, (name, data) => {
      if (name === 'sl:f') {
        out.otherBundles++;
        if (o.onOther) o.onOther(data instanceof Uint8Array ? data : new Uint8Array(data));
      }
    }, () => { room.unseat(w.sock, 'kick'); });
    w.seat = room.seat(w.sock, { nick: 'Wanderer ' + k, cv: k % 9 });
    others[k] = w;
    return w;
  }
  function driveOther(w) {
    if (!w.seat || w.seat.closed) return;
    const s = room.sim.snake(w.seat.snakeId);
    if (!s) {
      if (!Number.isFinite(w.deadAt)) w.deadAt = vt;
      if (vt - w.deadAt > 1500) {
        room.unseat(w.sock, 'leave');
        seatOther(w.k);
      }
      return;
    }
    steer(w, s);
  }
  // One scripted player's input: a new wanted angle every 200 to 800 ms (toward the centre when outside 0.6 of the
  // border radius), a boost now and then, an arrow burst now and then.
  function steer(w, s) {
    if (vt < w.nextAt) return;
    w.nextAt = vt + 200 + rnd() * 600;
    const grd = laws.L1.value;
    const hx = slSnake.headX(s) - grd, hy = slSnake.headY(s) - grd;
    const flux = room.sim.flux();
    if (hx * hx + hy * hy > (0.6 * flux) * (0.6 * flux)) w.target = Math.atan2(-hy, -hx);
    else w.target += (rnd() - 0.5) * 1.6;
    w.target = ((w.target % PI2) + PI2) % PI2;
    const recs = [{ type: 'angle', q: Math.floor(251 * w.target / PI2) % 251 }];
    if (rnd() < 0.06 && vt > w.boostUntil) { recs.push({ type: 'boost', on: true }); w.boostUntil = vt + 400 + rnd() * 1200; w.boosting = true; }
    else if (w.boosting && vt > w.boostUntil) { recs.push({ type: 'boost', on: false }); w.boosting = false; }
    if (rnd() < 0.05) recs.push({ type: 'turn', dir: rnd() < 0.5 ? 'left' : 'right', v: 1 + Math.floor(rnd() * 20) });
    room.onInput(w.seat, W.encodeInput(recs));
  }

  // ---- the mirrored seat
  const mirror = { sock: null, seat: null, pending: [], prevTick: 0, n: 0, afterStall: false, snakeId: 0, nextAt: 0,
    target: rnd() * PI2, boostUntil: 0, boosting: false, deadAt: NaN };
  function emitMirror(name, data) {
    if (name === 'sl:x') { out.layerBatches++; return; }
    if (name !== 'sl:f') return;
    const bytes = Uint8Array.from(data);
    const tick = room.sim.tick();
    const b = {
      n: ++mirror.n, bytes, tick, prevTick: mirror.prevTick, at: vt + DOWN, own: mirror.seat ? mirror.seat.snakeId : 0,
      snap: snapshotNow(room), afterStall: mirror.afterStall,
      resyncs: room.stats.resyncs, delivered: null, flux: room.sim.flux(),
    };
    if (o.wantDelivered && o.wantDelivered(b)) b.delivered = deliveredNow();
    mirror.afterStall = false;
    mirror.prevTick = tick;
    out.bundles++;
    if (o.client) mirror.pending.push(b);
    else if (o.onBundle) o.onBundle(b, null, out);
  }
  // The send queue's delivered layer and the server world at this moment (for the ghost checks).
  function deliveredNow() {
    const q = mirror.seat && mirror.seat.queue;
    const d = q ? q.delivered : { snakes: new Set(), sectors: new Set(), preys: new Set() };
    const foods = new Map();
    room.sim.food.forEachFood((f) => foods.set((f.sx << 24) | (f.sy << 16) | (f.rx << 8) | f.ry, f));
    const preys = new Set();
    if (room.sim.preys) room.sim.preys.forEachPrey((p) => preys.add(p.id));
    const live = new Set();
    room.sim.forEachSnake((s) => live.add(s.id));
    return {
      snakes: new Set(d.snakes), sectors: new Set(d.sectors), preys: new Set(d.preys), queued: q ? q.length : 0,
      foods, livePreys: preys, liveSnakes: live,
    };
  }
  function seatMirror(nick) {
    const sock = serverSocket('mirror', emitMirror, () => {
      out.kicks++;
      room.unseat(sock, 'kick');
      if (clientT) clientT.serverClosed(vt + DOWN);
    });
    mirror.sock = sock;
    mirror.seat = room.seat(sock, { nick, cv: 3 });
    mirror.snakeId = mirror.seat ? mirror.seat.snakeId : 0;
    mirror.prevTick = room.sim.tick();
    out.lives++;
    return mirror.seat;
  }

  // ---- the frozen client and its live transport
  let P = null;
  let clientT = null;
  const frameMs = o.frameMs || 16.6667;
  if (o.client) {
    const H = { step: frameMs, vw: 1280, vh: 720, ls: null, seed: seed, warm: 60, openFrame: 64, frames: 0 };
    P = V.makePage(H, [], {
      transport(page, handlers) {
        let state = 0; // 0 connecting, 1 open, 2 closed
        let created = page.frame;
        const t = {
          open() { created = page.frame; state = 0; },
          join(nick) { sendUp(() => seatMirror(nick)); },
          send(bundle) {
            if (state !== 1) return;
            const bytes = Uint8Array.from(bundle);
            sendUp(() => { if (mirror.seat && !mirror.seat.closed) room.onInput(mirror.seat, bytes); });
          },
          close() {
            if (state === 2) return;
            state = 2;
            out.closes++;
            const sock = mirror.sock;
            sendUp(() => { if (sock) room.unseat(sock, 'leave'); });
            mirror.pending.length = 0;
          },
          serverClosed(at) { t.closeAt = at; },
          closeAt: Infinity,
        };
        clientT = t;
        page.socketHook = function () {
          if (clientT !== t || state === 2) return;
          if (state === 0 && created < page.frame) { state = 1; handlers.onOpen(); }
          if (state !== 1) return;
          while (mirror.pending.length && mirror.pending[0].at <= page.vnow + 0.001) {
            const b = mirror.pending.shift();
            handlers.onFrame(page.win.DuelSlither.slWire.decodeBundle(new page.U8(b.bytes)), b.bytes.length);
            if (o.onBundle) o.onBundle(b, page, out);
            if (state === 2) return;
          }
          if (t.closeAt <= page.vnow) { state = 2; handlers.onClose(); }
        };
        return t;
      },
    });
    P.boot();
    if (o.onBoot) o.onBoot(P);
    for (let k = 0; k < 60; k++) P.step();
    P.win.DuelSlither.play('Mirror');
    out.page = P;
    vt = P.vnow;
  } else {
    seatMirror('Mirror');
  }

  for (let k = 0; k < (o.others === undefined ? 24 : o.others); k++) seatOther(k);

  // ---- the client's own input: a player steering inside the border, boosting now and then, playing again after a
  // death once their client unlocks Play
  const me = { nextAt: 0, target: rnd() * PI2, boostUntil: 0, down: false, replayAt: NaN };
  function driveClient() {
    const D = P.win.DuelSlither;
    const S = D.S;
    if (!S.playing && !S.connecting && !D.slMain.isPlayLocked() && !S.want_play && S.dead_mtm == -1) {
      if (!Number.isFinite(me.replayAt)) me.replayAt = vt + 500;
      if (vt >= me.replayAt) { me.replayAt = NaN; D.play('Mirror'); }
      return;
    }
    const o2 = S.slither;
    if (!o2 || !S.playing || vt < me.nextAt) return;
    me.nextAt = vt + 300 + rnd() * 600;
    const grd = S.grd;
    const hx = o2.xx - grd, hy = o2.yy - grd;
    const flux = S.flux_grd;
    if (hx * hx + hy * hy > (0.55 * flux) * (0.55 * flux)) me.target = Math.atan2(-hy, -hx);
    else me.target += (rnd() - 0.5) * 1.4;
    const r = 120 + rnd() * 200;
    P.fire('m', [String(640 + Math.cos(me.target) * r), String(360 + Math.sin(me.target) * r)]);
    if (!me.down && rnd() < 0.12) { me.down = true; me.boostUntil = vt + 300 + rnd() * 1500; P.fire('d', ['640', '360', '0', '1']); }
    else if (me.down && vt > me.boostUntil) { me.down = false; P.fire('u', ['640', '360', '0', '0']); }
  }

  // ---- stalls of the mirrored seat
  const stalls = (o.stalls || []).map((s) => Object.assign({ started: false, done: false }, s));
  const t0 = vt;
  function stallControl() {
    for (const s of stalls) {
      // a stall starts once its time came and the mirrored seat's snake is alive (task T14: a stall that began with the
      // snake already dead re-seated the scripted seat, or let the frozen client's dead seat time out, and never
      // reached the resync)
      if (!s.started && vt - t0 >= s.at && mirror.seat && !mirror.seat.closed && room.sim.snake(mirror.seat.snakeId) &&
        (!s.resync || heldOthers().length >= 3)) {
        s.started = true;
        s.startTick = room.sim.tick();
        stall = { until: vt + s.ms, held: [], spec: s };
        mirror.sock.conn.transport.writable = false;
        if (s.resync) resyncEvents(s);
      }
    }
    if (stall) {
      const s = stall.spec;
      // a resync stall that ends without its resync is tried again 5 s later with fresh events: the mirrored snake
      // died inside it (a stalled seat with a dead snake goes quiet: the scripted seat plays again, the frozen client's
      // dead seat times out), or its corner of the map was too quiet to pass the cap in time (task T14: which snake
      // dies when, and what is in view, moves with every sim change)
      const dead = !(mirror.seat && !mirror.seat.closed && room.sim.snake(mirror.seat.snakeId));
      const abort = s.resync && out.resyncAt === null && (dead || vt >= stall.until);
      const done = abort || vt >= stall.until || (s.resync && out.resyncAt !== null && room.sim.tick() > out.resyncAtTick);
      if (done) {
        if (abort) {
          s.started = false;
          s.at = vt - t0 + 5000;
          s.tries = (s.tries || 1) + 1;
          out.stallEvents = [];
        } else s.done = true;
        s.endTick = room.sim.tick();
        const held = stall.held;
        stall = null;
        for (const e of held) up.push(Object.assign(e, { at: vt }));
        if (mirror.sock) {
          mirror.afterStall = true;
          mirror.sock.conn.transport.writable = true;
          mirror.sock.conn.transport.emit('ready');
        }
      }
    }
  }
  // A leave, a death and a cash-out among the snakes the mirrored seat holds. The leave (a 3 s straight glide) and the
  // cash-out (a 3 s hold) go to the held snakes with the most room around their heads, so a collision inside those
  // 3 s does not end them some other way (task T14: any change to the sim reshuffles which snakes are near what).
  function clearance(w) {
    const s0 = room.sim.snake(w.seat.snakeId);
    const hx = slSnake.headX(s0), hy = slSnake.headY(s0);
    let best = Infinity;
    room.sim.forEachSnake((o) => {
      if (o === s0) return;
      for (const p of o.pts) best = Math.min(best, Math.hypot(p.xx - hx, p.yy - hy));
    });
    return best;
  }
  // the scripted seats whose live snake the mirrored seat holds (a resync stall needs three: a leave, a death, a cash-out)
  function heldOthers() {
    const q = mirror.seat.queue;
    return others.filter((w) => w && w.seat && !w.seat.closed && room.sim.snake(w.seat.snakeId) && q.holdsSnake(w.seat.snakeId));
  }
  function resyncEvents(s) {
    const held = heldOthers();
    const room2 = held.map((w) => ({ w, d: clearance(w) })).sort((x, y) => y.d - x.d).map((x) => x.w);
    const a = room2[0] || null, c = room2[1] || null;
    const b = held.find((w) => w !== a && w !== c) || null;
    if (a) { out.stallEvents.push({ kind: 'leave', id: a.seat.snakeId, tick: room.sim.tick() }); room.unseat(a.sock, 'leave'); a.seat = null; }
    if (b) { out.stallEvents.push({ kind: 'death', id: b.seat.snakeId, tick: room.sim.tick() }); room.sim.kill(b.seat.snakeId); }
    if (c) { out.stallEvents.push({ kind: 'cashout', id: c.seat.snakeId, tick: room.sim.tick() }); room.onHold(c.seat, true); c.holding = true; }
  }

  // ---- the clock loop: upstream arrivals, room wakes and client frames in time order
  let nextWake = vt + P_MS;
  const endTick = o.ticks;
  let lastResyncs = 0;
  let lastGlide = 0;
  let lastCash = 0;
  out.glideDeathTicks = [];
  out.cashoutTicks = [];
  while (room.sim.tick() < endTick) {
    const nextUp = up.length ? up[0].at : Infinity;
    const nextFrame = P ? P.vnow + frameMs : Infinity;
    if (nextUp <= nextWake && nextUp <= nextFrame) {
      vt = Math.max(vt, nextUp);
      const e = up.shift();
      e.fn();
      T.runImmediates();
      continue;
    }
    if (nextWake <= nextFrame) {
      vt = nextWake;
      nextWake += P_MS;
      for (const w of others) if (w) {
        if (w.holding && w.seat && !w.seat.closed && !room.sim.snake(w.seat.snakeId)) w.holding = false;
        if (!w.holding) driveOther(w);
        else if (w.seat && !w.seat.closed && vt >= (w.pingAt || 0)) {
          // a holding player's client keeps pinging (their 250 ms gate), so the C_HOLD_SAFETY_MS net never ends it
          w.pingAt = vt + 250;
          room.onInput(w.seat, W.encodeInput([{ type: 'ping' }]));
        }
      }
      T.runImmediates();
      stallControl();
      room.wake();
      T.runImmediates();
      T.runTimeouts();
      if (room.stats.glideDeaths !== lastGlide) { lastGlide = room.stats.glideDeaths; out.glideDeathTicks.push(room.sim.tick()); }
      if (room.stats.cashouts !== lastCash) { lastCash = room.stats.cashouts; out.cashoutTicks.push(room.sim.tick()); }
      if (room.stats.resyncs !== lastResyncs) {
        lastResyncs = room.stats.resyncs;
        if (out.resyncAt === null) { out.resyncAt = vt; out.resyncAtTick = room.sim.tick(); }
      }
      if (!P && mirror.seat && !mirror.seat.closed && room.sim.snake(mirror.seat.snakeId) && !stall) {
        steer(mirror, room.sim.snake(mirror.seat.snakeId));
      }
      if (!P) {
        // the scripted mirrored seat plays again 2 s after a death (no client fade to wait for)
        if (!mirror.seat || mirror.seat.closed) seatMirror('Mirror');
        else if (!room.sim.snake(mirror.seat.snakeId)) {
          if (!Number.isFinite(mirror.deadAt)) mirror.deadAt = vt;
          if (vt - mirror.deadAt > 2000) { mirror.deadAt = NaN; room.unseat(mirror.sock, 'leave'); seatMirror('Mirror'); }
        }
      }
      continue;
    }
    // a client frame
    driveClient();
    P.step();
    vt = P.vnow;
    T.runImmediates();
    if (o.onFrame) o.onFrame(P);
  }
  out.stalls = stalls;
  out.mirror = mirror;
  out.vt = vt;
  return out;
}

// ---------------------------------------------------------------------------------------------------- helpers

// Form keys (test/slFormCoverage.test.js): exactly what the frozen client branches on for one decoded record
// (public/js/sl/slApply.js dispatch): the record type, own or other where the client looks the snake up differently,
// every optional field present, the move letter, the food form flags, the minimap letter, the dead code, the remove
// kind, the snake_add body parts and whether it carries a custom skin (slApply.js:936-937 treats an absent skin and an
// empty one alike).
const has = (e, k) => e[k] !== undefined;
const INIT_OPT = ['pv', 'defaultMsl', 'realSid', 'fluxGrd', 'gameMode', 'extraB'];
const ROT = ['dir', 'ang', 'wang', 'sp'];

function formKey(e) {
  return keyParts(e).replace(/\s+/g, ' ').trim(); // an empty field set leaves no trailing space
}

function keyParts(e) {
  const t = e.type;
  switch (t) {
    case 'init':
      return t + ' ' + INIT_OPT.filter((k) => has(e, k)).join('+');
    case 'snake_rot':
      return t + ' ' + (e.own ? 'own' : 'other') + ' ' + ROT.filter((k) => has(e, k)).join('+');
    case 'snake_tail':
      return t + (has(e, 'fam') ? ' fam' : '');
    case 'snake_move':
      return t + ' ' + e.cmd + ' ' + (e.own ? 'own' : 'other') + ' ' + ['iang', 'xx'].filter((k) => has(e, k)).join('+') +
        (e.raw ? ' rel' : '');
    case 'leaderboard':
      return t + (e.rows.length ? ' rows' : ' empty');
    case 'dead':
      return t + ' ' + e.code;
    case 'minimap':
      return t + ' ' + e.cmd;
    case 'snake_add': {
      const p = e.raw.pts;
      const deltas = p.filter((q) => q.bx !== undefined).length;
      return t + (e.skin && e.skin.length > 0 ? ' skin' : '') + (p.length ? ' first' : '') + (deltas ? ' deltas' : '') +
        (p.length > 1 && p[p.length - 1].iang !== undefined ? ' iang' : '');
    }
    case 'snake_remove':
      return t + ' kill' + (e.kill ? 1 : 0);
    case 'food_sector':
      return t + (has(e, 'sx') ? ' sx' : '') + (e.foods.length ? ' foods' : ' empty') +
        (e.foods.length && has(e.foods[0], 'id') ? ' id' : '') + (e.foods.length && has(e.foods[0], 'xx') ? ' xy' : '');
    case 'food_add':
      return t + (e.rapid ? ' rapid' : '') + (e.sectorFromLast ? ' sLast' : '') + (e.cvFromLast ? ' cLast' : '') +
        (has(e, 'xx') ? ' xy' : '') + (has(e, 'id') ? ' id' : '') + (e.noop ? ' noop' : '');
    case 'food_eat':
      return t + ' ' + e.cmd + (e.sectorFromLast ? ' sLast' : '') + (has(e, 'xx') ? ' xy' : '') + (has(e, 'id') ? ' id' : '');
    case 'prey_move':
      return t + ' ' + ROT.filter((k) => has(e, k)).join('+');
    default:
      return t;
  }
}

// Every form key in the golden streams, with its count.
function goldenForms() {
  const all = V.loadStreams();
  const out = new Map();
  for (const g of Object.values(all.streams)) {
    if (!g.entries) continue;
    for (const en of g.entries) {
      if (en[2] < 0) continue;
      for (const e of W.decodeBundle(new Uint8Array(Buffer.from(en[3], 'hex')))) {
        const k = formKey(e);
        out.set(k, (out.get(k) || 0) + 1);
      }
    }
  }
  return out;
}

// The values the wire carries for a server number (slQuant, the same functions the view uses).
const rule = (laws, id) => laws[id].value;
function famWire(laws, fam) { return slQuant.fam24(Math.min(1, fam), rule(laws, 'L17.famRound')).v; }

module.exports = { runRig, makeTimers, serverSocket, tamperedView, baseView, famWire, formKey, goldenForms, PI2 };
