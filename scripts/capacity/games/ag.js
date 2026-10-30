'use strict';
// Capacity test: one simulated agar.io player on the FREE rung (socket.io namespace /ag, room ag:<region>:s0).
//
// It behaves like the shipped page (public/ag.html + public/js/ag/agMain.js, agNet.js, agCamera.js, agWorld.js):
//   1. connect to /ag with no handshake auth (a free page with no Customize skin sends none; agMain.js auth/ioOptions)
//      -> the server seats the socket at once as a watcher and starts sending one binary bundle per tick on 'ag:f'
//   2. first bundle: the 'hello' record -> ag:view { below: 90 } (ag.html ghostBannerPx 90 on a 1920-wide desktop
//      window, agMain reportView on the hello); portrait is never sent on a desktop (it stays false)
//   3. first world record (the page's 'ready') -> ag:join { name } (agMain play(): pending.play is sent on ready)
//   4. the own id ('own' record) plus a cell record carrying it = spawned (agWorld promotion) -> stats.joined()
//   5. while alive: ag:target { x, y } (integers) from the rAF frame loop, at most once per frame and only after
//      strictly more than 15 ms since the last check, only when the integer target changed (agCamera frameGate,
//      TARGET_SEND_GAP_MS 15): about 60 a second on a 60 Hz screen while the cell moves. Rare ag:split / ag:eject,
//      each after flushing the current target first, as the page does.
//   6. death = the last own cell removed (agWorld death) -> stats.dead(), ~2 s on the end card, then ag:join again
//      on the same socket (the free card's Play again).
// FREE ONLY: no auth.paid, no stake, no entryToken, no resumeKey, no wallet, no chat, no ag:hold, no HTTP route.

const { openSocket, countBytes, pingLoop, toU8 } = require('../lib');
const agWire = require('../../../shared/agWire.js');

const NSP = '/ag';
const FRAME_MS = 1000 / 60;            // requestAnimationFrame on a 60 Hz screen
const TARGET_GAP_MS = 15;              // agCamera.js TARGET_SEND_GAP_MS (strictly more than)
const VIEW_BELOW = 90;                 // ag.html ghostBannerPx 90 at agCamera.screenFactor 1 (1920 x ~950 window)
const RESPAWN_MS = [1700, 2600];       // the free end card, then Play again
const REFUSED_RETRY_MS = [3000, 5000];
const DROP_RECONNECT_MS = 2000;
const JOIN_WATCHDOG_MS = 8000;         // a join that never spawned (dropped by the 500 ms join limit, a lost packet)
const REFUSE_CLOSE_WINDOW_MS = 1500;   // a server close this soon after ag:refused is that refusal's close, not a drop

function start(ctx) {
  const stats = ctx.stats;
  const rand = typeof ctx.rand === 'function' ? ctx.rand : Math.random;
  const name = String(ctx.name == null ? '' : ctx.name).slice(0, 15);   // agMain NICK_MAX
  const log = typeof ctx.log === 'function' ? ctx.log : () => {};
  const between = (r) => r[0] + rand() * (r[1] - r[0]);

  let stopped = false;
  let socket = null;
  let stopPing = null;
  let frameTimer = null;
  let frameBase = 0;
  let frameN = 0;
  let lastCheck = -Infinity;
  const timers = new Set();
  let refusedAt = 0;

  // The page's world, reduced to what a player acts on.
  let w = null;
  function freshWorld() {
    return {
      ready: false,            // first world record seen on this connection
      viewSent: false,
      pendingPlay: true,       // Play was pressed before the socket was up (agMain pending.play)
      ownIds: new Set(),       // announced own ids
      own: new Map(),          // promoted own cells: id -> { x, y, size }
      alive: false,
      border: null,
      joinAt: 0,
      lastSentX: 0, lastSentY: 0,
      heading: rand() * Math.PI * 2,
      dist: 250 + rand() * 300,
      nextTurn: 0,
      nextSplit: 0,
      nextEject: 0,
    };
  }

  function later(fn, ms) {
    const t = setTimeout(() => {
      timers.delete(t);
      if (!stopped) fn();
    }, ms);
    timers.add(t);
    return t;
  }
  function clearTimers() {
    for (const t of timers) clearTimeout(t);
    timers.clear();
  }

  function up() {
    return !!(socket && socket.connected);
  }
  function emit(ev, payload) {
    if (!up()) return false;
    if (payload === undefined) socket.emit(ev);
    else socket.emit(ev, payload);
    return true;
  }

  function sendJoin() {
    if (!w || !up()) return;
    w.joinAt = Date.now();
    emit('ag:join', { name });
    // the page never retries a Play, but a join dropped by the server's 500 ms join limit would leave this player
    // on the menu for good; a person would press Play again
    later(() => {
      if (w && up() && !w.alive && w.joinAt && Date.now() - w.joinAt >= JOIN_WATCHDOG_MS) {
        stats.note('join-no-spawn');
        sendJoin();
      }
    }, JOIN_WATCHDOG_MS + 50);
  }

  // ---- the world (agWorld.js apply, own cells only) ---------------------------------------------------------
  function onSpawn() {
    w.alive = true;
    w.joinAt = 0;
    const now = Date.now();
    w.heading = rand() * Math.PI * 2;
    w.nextTurn = now + 800 + rand() * 3000;
    w.nextSplit = now + 8000 + rand() * 30000;
    w.nextEject = now + 15000 + rand() * 45000;
    stats.joined();
  }

  function onDeath() {
    w.alive = false;
    stats.dead();
    const myWorld = w;
    later(() => {
      if (w === myWorld && up() && !w.alive) sendJoin();
    }, between(RESPAWN_MS));
  }

  function applyWorld(msg, isSync) {
    if (!w.ready) {
      w.ready = true;
      if (w.pendingPlay) {
        w.pendingPlay = false;
        sendJoin();
      }
    }
    let ownGone = false;
    const eats = msg.eats || [];
    for (let i = 0; i < eats.length; i++) {
      const e = eats[i];
      if (e && w.own.has(e[1] >>> 0)) ownGone = true;
    }
    const cells = msg.cells || [];
    const listed = isSync ? new Set() : null;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      if (!c) continue;
      const id = c.id >>> 0;
      if (listed) listed.add(id);
      const o = w.own.get(id);
      if (o) {
        o.x = c.x; o.y = c.y; o.size = c.size;
      } else if (w.ownIds.has(id)) {
        const first = w.own.size === 0;
        w.own.set(id, { x: c.x, y: c.y, size: c.size });
        if (first) onSpawn();
      }
    }
    const removed = msg.removed || [];
    for (let i = 0; i < removed.length; i++) {
      const id = removed[i] >>> 0;
      if (w.own.delete(id)) {
        w.ownIds.delete(id);
        ownGone = true;
      }
    }
    if (listed) {
      for (const id of Array.from(w.own.keys())) {
        if (!listed.has(id)) {
          w.own.delete(id);
          w.ownIds.delete(id);
          ownGone = true;
        }
      }
    }
    if (ownGone && w.own.size === 0 && w.alive) onDeath();
  }

  function onBundle(data) {
    if (!w) return;
    const recs = agWire.decodeBundle(toU8(data) || data);
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      switch (r && r.t) {
        case 'error':
          stats.error('decode:' + r.reason);
          return;   // the records before it were applied, the rest dropped (agNet handleBundle)
        case 'hello':
          if (!w.viewSent) {
            w.viewSent = true;
            emit('ag:view', { below: VIEW_BELOW });
          }
          break;
        case 'border':
          w.border = r;
          break;
        case 'own':
          w.ownIds.add(r.id >>> 0);
          break;
        case 'clearOwn':
          w.own.clear();
          w.ownIds.clear();
          break;
        case 'clearAll':
          // moved to another room (overflow on Play, or a replaced room): the page drops its whole world
          stats.note('room-move');
          w.own.clear();
          w.ownIds.clear();
          break;
        case 'world':
          applyWorld(r, false);
          break;
        case 'sync':
          applyWorld(r, true);
          break;
        default:
          break;   // cam, board: display only
      }
    }
    stats.snap();
  }

  // ---- the frame loop (agMain gameFrame -> agCamera.frameGate) ------------------------------------------------
  function centre() {
    let sx = 0, sy = 0, n = 0;
    for (const c of w.own.values()) { sx += c.x; sy += c.y; n++; }
    return n ? { x: sx / n, y: sy / n } : null;
  }

  // A person's mouse: mostly steady, a new heading every second or few, away from the border when close to it.
  function steer(now, at) {
    const b = w.border;
    if (b) {
      const m = 700;
      const nearX = at.x < b.minX + m ? 1 : at.x > b.maxX - m ? -1 : 0;
      const nearY = at.y < b.minY + m ? 1 : at.y > b.maxY - m ? -1 : 0;
      if (nearX || nearY) {
        const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
        const toCentre = Math.atan2(cy - at.y, cx - at.x);
        let d = toCentre - w.heading;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        if (Math.abs(d) > Math.PI / 2) {
          w.heading = toCentre + (rand() - 0.5) * 1.2;
          w.nextTurn = now + 1500 + rand() * 2500;
        }
      }
    }
    if (now >= w.nextTurn) {
      w.heading += rand() < 0.15 ? (rand() - 0.5) * 2 * Math.PI : (rand() - 0.5) * 1.6;
      if (rand() < 0.3) w.dist = 120 + rand() * 500;
      w.nextTurn = now + 700 + rand() * 4000;
    } else {
      w.heading += (rand() - 0.5) * 0.02;   // a hand is never perfectly still
    }
  }

  function sendTarget(at) {
    const x = Math.trunc(at.x + Math.cos(w.heading) * w.dist) | 0;
    const y = Math.trunc(at.y + Math.sin(w.heading) * w.dist) | 0;
    if (x === w.lastSentX && y === w.lastSentY) return false;
    w.lastSentX = x;
    w.lastSentY = y;
    return emit('ag:target', { x, y });
  }

  function frame() {
    frameTimer = null;
    if (stopped) return;
    const now = Date.now();
    // The gate reads the frame's own time, as rAF hands the page its vsync time (a steady 16.7 ms apart), so a timer
    // that fires a little early on a coarse OS clock never makes a 60 Hz frame look like a 15 ms one.
    const vsync = frameBase + frameN * FRAME_MS;
    if (w && w.alive && up() && vsync - lastCheck > TARGET_GAP_MS) {
      lastCheck = vsync;
      const at = centre();
      if (at) {
        steer(now, at);
        sendTarget(at);
        if (now >= w.nextSplit) {
          if (w.own.size < 4) {
            sendTarget(at);   // the page flushes the target before a split (it is unchanged here, so not resent)
            emit('ag:split');
          }
          w.nextSplit = now + 15000 + rand() * 45000;
        }
        if (now >= w.nextEject) {
          emit('ag:eject');
          w.nextEject = now + 20000 + rand() * 60000;
        }
      }
    }
    // drift-free 60 Hz
    frameN++;
    let due = frameBase + frameN * FRAME_MS;
    const t = Date.now();
    if (due < t - 100) {   // a long stall: start again from now (a real page drops frames the same way)
      frameBase = t;
      frameN = 0;
      due = t;
      lastCheck = -Infinity;
    }
    frameTimer = setTimeout(frame, Math.max(0, due - t));
  }
  function startFrames() {
    if (frameTimer) return;
    frameBase = Date.now() + rand() * FRAME_MS;   // players are not all in phase
    frameN = 0;
    frameTimer = setTimeout(frame, Math.max(0, frameBase - Date.now()));
  }
  function stopFrames() {
    if (frameTimer) clearTimeout(frameTimer);
    frameTimer = null;
  }

  // ---- the socket -------------------------------------------------------------------------------------------
  function teardownSocket() {
    stopFrames();
    if (stopPing) { stopPing(); stopPing = null; }
    if (socket) {
      const s = socket;
      socket = null;
      s.removeAllListeners();
      try { s.close(); } catch (e) { /* already closed */ }
    }
    w = null;
  }

  function connect() {
    if (stopped) return;
    teardownSocket();
    const s = openSocket(ctx.base, NSP, ctx.ip);
    socket = s;
    countBytes(s, stats);
    s.on('connect', () => {
      if (s !== socket) return;
      stats.connectedNow();
      w = freshWorld();
      lastCheck = -Infinity;
      if (stopPing) stopPing();
      stopPing = pingLoop(s, stats);
      startFrames();
    });
    s.on('ag:f', (data) => {
      if (s !== socket) return;
      try {
        onBundle(data);
      } catch (e) {
        stats.error('client:' + (e && e.message));
      }
    });
    s.on('ag:refused', (p) => {
      if (s !== socket) return;
      const why = p && typeof p.why === 'string' ? p.why : '?';
      refusedAt = Date.now();
      stats.refused(why);
      // 'full' on a Play keeps the socket (agSockets onJoin): try Play again later on it. A refused connection is
      // closed by the server (agArenas refuse): the disconnect handler reconnects.
      later(() => {
        if (s === socket && up() && w && !w.alive) sendJoin();
      }, between(REFUSED_RETRY_MS));
    });
    s.on('connect_error', (err) => {
      if (s !== socket) return;
      const why = err && err.data && err.data.why;
      if (why) stats.refused('handshake:' + why);
      else stats.connectError(err && err.message);
      teardownSocket();
      later(connect, between(REFUSED_RETRY_MS));
    });
    s.on('disconnect', (reason) => {
      if (s !== socket) return;
      if (stopped || reason === 'io client disconnect') return;
      const wasRefused = Date.now() - refusedAt < REFUSE_CLOSE_WINDOW_MS;
      teardownSocket();
      if (wasRefused) {
        stats.closed();
        later(connect, between(REFUSED_RETRY_MS));
      } else {
        stats.dropped(reason);
        later(connect, DROP_RECONNECT_MS);
      }
    });
  }

  connect();

  return {
    stop() {
      if (stopped) return;
      // leave like a person closing the tab from the menu: ag:leave, then the socket goes
      if (up()) {
        try { socket.emit('ag:leave'); } catch (e) { /* closing anyway */ }
      }
      stopped = true;
      clearTimers();
      teardownSocket();
      stats.closed();
      log('ag stopped');
    },
  };
}

module.exports = { id: 'ag', start };
