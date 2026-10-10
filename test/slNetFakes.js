'use strict';
// Test helpers for the slither.io room and send queue (task T9). TEST ONLY: never imported by shipped code.
//
//   fakeTimers()          a manual clock with setTimeout, clearTimeout, setImmediate, clearImmediate; run(ms) moves
//                         time forward firing every timer in time order and every immediate after each timer
//   FakeTransport, FakeConn, fakeSocket(name)
//                         an engine.io 6.6.11 look-alike: conn.write pushes a packet and flushes at once while the
//                         transport is writable (engine.io/build/socket.js:386-433); polling's send() sets writable
//                         false (transports/polling.js:193-194); a parked GET sets it true and emits 'ready'
//                         (polling.js:77-78), whose first listener is the conn's own flush (socket.js:197-203); the
//                         socket writes a binary event as TWO packets, header then attachment, like socket.io
//                         (socket.io/dist/client.js:172-183)
//   fakeView(opts)        a seat view that follows the slRoom contract with a tiny stream: init at join, the own
//                         snake's wang and dir when they change, the lock records, the own end (dead, own remove) on
//                         a death or a cash-out; opts.perFrame adds one own kill_count per step (tick % 1000),
//                         opts.throwOnCollect and opts.throwOnStep plant a throw
//   wangByte(w)           the 8-bit byte of an angle that sits on the 8-bit grid (round, so a float a hair under its
//                         grid point keeps its byte)

const { EventEmitter } = require('events');
const { initFields } = require('../server/sl/slLaws');

const PI2 = 2 * Math.PI;

function fakeTimers(start) {
  let now = start === undefined ? 0 : start;
  let seq = 0;
  const timers = new Map(); // handle -> { at, fn, seq }
  let immediates = [];
  function setTimeout_(fn, ms) {
    const h = { id: ++seq, unref() {} };
    timers.set(h, { at: now + Math.max(1, ms), fn, seq: h.id });
    return h;
  }
  function clearTimeout_(h) {
    timers.delete(h);
  }
  function setImmediate_(fn) {
    const h = { id: ++seq, fn, live: true };
    immediates.push(h);
    return h;
  }
  function clearImmediate_(h) {
    if (h) h.live = false;
  }
  function runImmediates() {
    let guard = 0;
    while (immediates.length) {
      const list = immediates;
      immediates = [];
      for (const h of list) if (h.live) {
        h.live = false;
        h.fn();
      }
      if (++guard > 10000) throw new Error('fakeTimers: immediates never settle');
    }
  }
  function nextTimer() {
    let best = null;
    for (const [h, t] of timers) {
      if (!best || t.at < best[1].at || (t.at === best[1].at && t.seq < best[1].seq)) best = [h, t];
    }
    return best;
  }
  // Moves time to now + ms, firing timers in order (and immediates after each).
  function run(ms) {
    const end = now + ms;
    runImmediates();
    for (;;) {
      const nt = nextTimer();
      if (!nt || nt[1].at > end) break;
      timers.delete(nt[0]);
      now = nt[1].at;
      nt[1].fn();
      runImmediates();
    }
    now = end;
    runImmediates();
  }
  return {
    clock: () => now,
    timers: { setTimeout: setTimeout_, clearTimeout: clearTimeout_, setImmediate: setImmediate_, clearImmediate: clearImmediate_ },
    run,
    runImmediates,
    advance(ms) {
      now += ms;
    },
    pending: () => timers.size,
  };
}

class FakeTransport extends EventEmitter {
  constructor(name, clock) {
    super();
    this.name = name || 'polling';
    this.writable = false;
    this.clock = clock || (() => 0);
    this.sends = []; // { at, packets }
  }
  send(packets) {
    if (this.name === 'polling') this.writable = false;
    this.sends.push({ at: this.clock(), packets });
    this.emit('sent', packets);
  }
  // polling: a GET arrived and is parked
  park() {
    this.writable = true;
    this.emit('ready');
  }
}

class FakeConn extends EventEmitter {
  constructor(transport) {
    super();
    this.writeBuffer = [];
    this.setTransport(transport);
  }
  setTransport(t) {
    if (this.transport) this.transport.removeAllListeners('ready');
    this.transport = t;
    t.on('ready', () => this.flush()); // engine.io's own listener, first
  }
  write(packet) {
    this.writeBuffer.push(packet);
    this.flush();
  }
  flush() {
    if (this.transport.writable && this.writeBuffer.length) {
      const w = this.writeBuffer;
      this.writeBuffer = [];
      this.transport.send(w);
    }
  }
  upgrade(t) {
    this.setTransport(t);
    this.emit('upgrade', t);
    this.flush();
  }
}

let sockSeq = 0;
function fakeSocket(transportName, clock) {
  const t = new FakeTransport(transportName, clock);
  if (transportName === 'websocket') t.writable = true;
  const conn = new FakeConn(t);
  const sock = {
    id: 'fake' + (++sockSeq),
    conn,
    disconnected: false,
    emitted: [], // { name, data } in emit order
    emit(name, data) {
      this.emitted.push({ name, data });
      if (data instanceof Uint8Array) {
        conn.write({ name, part: 'header' });
        conn.write({ name, part: 'attachment', data });
      } else {
        conn.write({ name, data });
      }
    },
    disconnect() {
      this.disconnected = true;
    },
  };
  return sock;
}

// A bare emitter socket (no engine.io connection): always ready.
function bareSocket() {
  return {
    id: 'bare' + (++sockSeq),
    conn: { transport: { writable: true }, writeBuffer: [] },
    disconnected: false,
    emitted: [],
    emit(name, data) {
      this.emitted.push({ name, data });
    },
    disconnect() {
      this.disconnected = true;
    },
  };
}

function wangByte(w) {
  return Math.round(w * 256 / PI2) & 255;
}

// The fake seat view (slRoom contract). stats counts calls.
function fakeView(opts) {
  const o = opts || {};
  const stats = { worlds: 0, steps: 0, joins: 0, collects: 0, resyncs: 0, notes: 0, collectFrames: [] };
  function createWorld(laws, sim) {
    stats.worlds++;
    const world = {
      sim,
      // per step: { tick, snakes: Map id -> { wang, dir }, deaths: [id], cashed: [{id, code}], locks: [ev] }
      frames: new Map(),
      afterStep(frame) {
        stats.steps++;
        if (o.throwOnStep) throw new Error('fakeView: planted throw in afterStep');
        const snakes = new Map();
        sim.forEachSnake((s) => snakes.set(s.id, { wang: wangByte(s.wang), dir: s.dir }));
        world.frames.set(frame.tick, {
          tick: frame.tick,
          snakes,
          deaths: frame.log.deaths.map((d) => d.id),
          cashed: frame.cashed.slice(),
          locks: frame.locks.slice(),
          clocks: frame.clocks,
        });
        if (world.frames.size > 64) world.frames.delete(world.frames.keys().next().value);
      },
    };
    return world;
  }
  function createSeatView(laws, ctx0) {
    const ownId = ctx0.ownId;
    const world = ctx0.world;
    let lastWang = -1;
    let lastDir = -1;
    let ended = false;
    const view = {
      join(ctx) {
        stats.joins++;
        const s = ctx0.sim.snake(ownId);
        lastWang = wangByte(s.wang);
        lastDir = s.dir;
        return [initFields(laws, ctx.flux)];
      },
      collect(ctx) {
        stats.collects++;
        stats.collectFrames.push(ctx.frames.length);
        if (o.throwOnCollect) throw new Error('fakeView: planted throw in collect');
        const out = [];
        for (const f of ctx.frames) {
          const wf = world.frames.get(f.tick);
          if (!wf || ended) continue;
          if (o.perFrame) out.push({ type: 'kill_count', id: ownId, count: f.tick % 1000 });
          const lock = wf.locks.find((l) => l.id === ownId);
          if (lock) {
            out.push(lock);
            lastWang = wangByte(lock.wang);
            lastDir = lock.dir;
          }
          const me = wf.snakes.get(ownId);
          if (me && !lock && (me.wang !== lastWang || me.dir !== lastDir)) {
            out.push({ type: 'snake_rot', id: ownId, dir: me.dir, wang: me.wang * PI2 / 256 });
            lastWang = me.wang;
            lastDir = me.dir;
          }
          if (wf.deaths.indexOf(ownId) >= 0 || wf.cashed.some((c) => c.id === ownId)) {
            out.push({ type: 'dead', code: 0 }, { type: 'snake_remove', id: ownId, kill: true });
            ended = true;
          }
        }
        return out;
      },
      noteOwnRot(r) {
        stats.notes++;
        lastWang = r.wangRaw;
        lastDir = r.dir;
      },
      resync() {
        stats.resyncs++;
      },
    };
    return view;
  }
  return { createWorld, createSeatView, stats };
}

module.exports = { fakeTimers, FakeTransport, FakeConn, fakeSocket, bareSocket, fakeView, wangByte, PI2 };
