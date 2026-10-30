'use strict';
// Paper.io for the capacity test (scripts/capacity/lib.js has the module contract): one simulated person on the FREE
// table only, driven through the page's OWN net layer.
//
// The page (public/paper-arena.html, public/js/paper/mp/paperArenaMain.js) opens one socket on the main namespace,
// wraps it in paperNet's ArenaNet and emits pp:join { name, stake: 0 } at once. This module does the same, with the same
// two files the page loads (paperWire.js: the binary codec, shared with the server; paperNet.js: frames, bundles, the
// pp:need resync, the 1 Hz pp:ping and the volatile, drain-aware pp:in), so every world update is decoded exactly as
// a browser decodes it and the server sees exactly a browser's traffic:
//   connect -> pp:join { name, stake: 0 } -> pp:joined -> pp:in (one integer per 60 Hz tick, every tick of a frame in
//   one volatile emit) + pp:ping 1 Hz + ds:ping every 2 s (dsPerfHud, here lib.pingLoop) + pp:need when out of step
//   pp:dead -> ~2 s on the end card -> pp:respawn { name } on the same socket (a new socket joins again)
//   pp:refused 'warming' -> pp:join again after max(1100, retryMs), as the page; any other refusal -> again in 3-5 s
//   a drop the module did not cause -> socket.connect() 2 s later; ArenaNet takes the seat back with its resumeKey
//   (pp:join { name, stake: 0, resumeKey }) inside the server's 5 s grace, as the page does
//   stop() -> pp:leave, then the socket closes
// Free only: stake is the free rung's 0 and nothing else; no entry token, no wallet, no skin pass, no chat, no HTTP.
const path = require('path');
const { openSocket, countBytes, pingLoop } = require('../lib');

const MP_DIR = path.join(__dirname, '..', '..', '..', 'public', 'js', 'paper', 'mp');
// paperWire first: it fills globalThis.DuelPaperLib.MP, which paperNet reads at call time (as on the page).
const MP = require(path.join(MP_DIR, 'paperWire.js'));
const { ArenaNet } = require(path.join(MP_DIR, 'paperNet.js'));

const FREE_STAKE = 0; // the free rung. pp:join must name it (no stake is 'bad-stake'); this module never sends another.
const CENTER = 1000; // the border's centre: paperSkins.js arenaSize 2000 / 2 (ArenaGame makeArena)
const JOIN_RETRY_MIN_MS = 1100; // paperArenaMain.js: the server takes one pp:join per 1000 ms per socket
const RECONNECT_MS = 2000;
const WALL_MARGIN = 45; // turn for the middle this far inside the wall
const TICK_MS = MP.STEP_MS; // one input per server tick (60 Hz), as paperMirror._predict

module.exports = {
  id: 'paper',
  start(ctx) {
    const stats = ctx.stats;
    const rand = ctx.rand;
    const opts = ctx.opts || {};
    // The page's frame rate: its inputs leave once per animation frame, every tick of that frame together. 60 on a
    // desktop (one input per emit); opts.paperFps 30 is a phone at 30 fps (two per emit). Inputs stay 60 a second.
    const fps = Number(opts.paperFps) > 0 ? Math.min(120, Number(opts.paperFps)) : 60;

    const socket = openSocket(ctx.base, '/', ctx.ip);
    countBytes(socket, stats);
    const stopPing = pingLoop(socket, stats);

    let stopped = false;
    let state = 'joining'; // joining | alive | dead | wait
    let joinedSocketId = null;
    let seq = 0;
    let acc = 0;
    let lastFrameAt = 0;
    let badSeen = 0;
    const timers = new Set();
    function later(fn, ms) {
      const t = setTimeout(() => {
        timers.delete(t);
        if (!stopped) fn();
      }, ms);
      timers.add(t);
      return t;
    }
    function clearLater() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
    }

    // Frames reach the sink once ArenaNet accepted them (decoded, in order, not older than the join).
    const sink = {
      applyJoined() {},
      applyEntry() {},
      onFrame() {
        if (state === 'alive') stats.snap();
      },
    };
    const net = new ArenaNet({
      socket,
      sink,
      onError: (where) => stats.error('paper:' + String(where)),
    });

    // ---- the person: loops out of their own land and back in ----
    // home: roughly the middle of the land (where the square has been while inside it); exit: the last point it was
    // inside, so the way back aims at where this loop left (out, a quarter turn, back: a triangle that never crosses
    // itself), even after other squares took the spawn.
    const plan = { leg: 'home', until: 0, heading: rand() * Math.PI * 2, side: 1, home: null, exit: null, inSince: 0 };

    function resetPlan(p) {
      plan.leg = 'home';
      plan.until = 0;
      plan.home = null;
      plan.exit = null;
      plan.inSince = 0;
      const units = p && Array.isArray(p.units) ? p.units : [];
      for (const u of units) {
        if (u && u.id === p.you && Number.isFinite(u.x) && Number.isFinite(u.y)) plan.home = { x: u.x, y: u.y };
      }
    }

    function goBack(now) {
      plan.leg = 'back';
      plan.inSince = 0;
      plan.until = now + 8000; // never stuck chasing a point that is someone else's now
    }

    function steer(now) {
      const f = net.newest();
      const me = f && f.byId ? f.byId.get(net.you) : null;
      if (!me) return plan.heading;
      if (!plan.home) plan.home = { x: me.x, y: me.y };
      const inLand = me.inId === net.you;
      if (inLand) {
        plan.exit = { x: me.x, y: me.y };
        plan.home.x += (me.x - plan.home.x) * 0.01;
        plan.home.y += (me.y - plan.home.y) * 0.01;
      }
      const target = plan.exit || plan.home;
      const toTarget = Math.atan2(target.y - me.y, target.x - me.x);
      const dx = me.x - CENTER;
      const dy = me.y - CENTER;
      const radius = f.radius > 0 ? f.radius : MP.R_MIN;
      if (Math.hypot(dx, dy) > radius - WALL_MARGIN) {
        // near the wall: head for the middle, and go home from there
        if (plan.leg === 'out' || plan.leg === 'side') goBack(now);
        plan.heading = Math.atan2(-dy, -dx);
        return plan.heading;
      }
      switch (plan.leg) {
        case 'home': {
          if (!inLand) {
            plan.heading = toTarget;
            break;
          }
          // A new loop: a few cells out (0.8-2 s at 90 u/s), away from the middle of the land, a quarter turn, a few
          // cells along (0.6-1.5 s), then straight back to where it left.
          plan.leg = 'out';
          plan.until = now + 800 + rand() * 1200;
          plan.side = rand() < 0.5 ? -1 : 1;
          const fromHome = Math.hypot(me.x - plan.home.x, me.y - plan.home.y);
          plan.heading = fromHome > 8
            ? Math.atan2(me.y - plan.home.y, me.x - plan.home.x) + (rand() - 0.5) * 0.9
            : rand() * Math.PI * 2;
          if (Math.hypot(plan.home.x - CENTER, plan.home.y - CENTER) > radius * 0.55) {
            plan.heading = Math.atan2(-dy, -dx) + (rand() - 0.5) * Math.PI; // land near the wall: loop inwards
          }
          break;
        }
        case 'out':
          if (now >= plan.until) {
            plan.leg = 'side';
            plan.until = now + 600 + rand() * 900;
            plan.heading += plan.side * Math.PI / 2;
          }
          break;
        case 'side':
          if (now >= plan.until) goBack(now);
          break;
        case 'back':
          if (!inLand) {
            plan.heading = toTarget;
            plan.inSince = 0;
            if (now >= plan.until) plan.exit = null; // that ground is gone: make for the middle of the land instead
            break;
          }
          // inside again: on toward the middle of the land
          if (Math.hypot(plan.home.x - me.x, plan.home.y - me.y) > 3) {
            plan.heading = Math.atan2(plan.home.y - me.y, plan.home.x - me.x);
          }
          if (!plan.inSince) plan.inSince = now;
          // loop closed (the land grew): the next one once a little way inside
          if (now - plan.inSince > 300) plan.leg = 'home';
          break;
      }
      return plan.heading;
    }

    // ---- the page's animation frame ----
    function frame() {
      const now = net.now();
      let dt = lastFrameAt ? now - lastFrameAt : 0;
      lastFrameAt = now;
      if (dt > 250) dt = 250;
      if (state === 'alive' && net.seated && net.connected && !net.resuming) {
        const angle = MP.angleToByte(steer(now) + (rand() - 0.5) * 0.04); // a hand on a mouse is never exact
        acc += dt;
        let budget = MP.MAX_PREDICT_TICKS_PER_FRAME;
        while (acc >= TICK_MS && budget > 0) {
          acc -= TICK_MS;
          budget--;
          net.queueInput(MP.encodeInput(seq, angle, false)); // never the hold bit: a free "leave" is never asked
          seq = (seq + 1) & 255;
        }
        net.flushInputs();
        if (acc >= TICK_MS) acc %= TICK_MS;
      } else {
        acc = 0;
      }
      net.update(now); // pp:ping at 1 Hz, behind this frame's inputs
      const rt = net.renderTick(now);
      if (rt !== null) net.takeDue(rt); // the mirror applies due entries; here they are only let go
      if (net.stats.badFrames > badSeen) {
        for (; badSeen < net.stats.badFrames; badSeen++) stats.error('paper:bad-frame');
      }
    }
    const frameTimer = setInterval(frame, Math.max(4, Math.floor(1000 / fps)));

    // ---- joining ----
    function sendJoin() {
      state = 'joining';
      if (!socket.connected) return; // the connect handler sends it
      net.join({ name: ctx.name, stake: FREE_STAKE });
    }

    // Play again: a free respawn on the same socket; a socket that changed since the seat joins again (the page's again()).
    function again() {
      if (socket.connected && socket.id && socket.id === joinedSocketId) {
        state = 'joining';
        net.respawn();
      } else {
        sendJoin();
      }
    }

    net.on('connect', () => {
      stats.connectedNow();
      if (net.resuming) {
        state = 'joining'; // ArenaNet already asked for the seat back with its resumeKey
        return;
      }
      if (state === 'joining') sendJoin(); // the first join, or one whose answer was lost with the old link
    });

    net.on('joined', (p) => {
      if (stopped) return;
      state = 'alive';
      joinedSocketId = socket.id || null;
      seq = 0; // a fresh input stream (the server's resetInput / a new square)
      acc = 0;
      stats.joined();
      if (p && p.resumed) stats.note('paper:resumed');
      else {
        if (p && typeof p.arenaId === 'string') stats.note('arena:' + p.arenaId);
        resetPlan(p);
      }
    });

    net.on('pp:dead', (p) => {
      stats.dead();
      stats.note('paper:dead:' + (p && p.killerId ? 'killed' : 'reason' + (p && p.reason)));
      state = 'dead';
      // the follow-the-killer glide (2 s, 1 s with no killer), then the end card and a press of Play again
      const glide = p && p.killerId ? 2000 : 1000;
      later(again, glide + 800 + rand() * 1200);
    });

    net.on('pp:cashedout', () => {
      // never asked for (no hold bit), counted if it ever comes
      stats.note('paper:cashedout');
      stats.unseated();
      state = 'dead';
      later(again, 2000 + rand() * 1500);
    });

    net.on('pp:refused', (p) => {
      const why = (p && p.why) || '?';
      stats.refused(why);
      stats.unseated();
      state = 'wait';
      const ms = why === 'warming' ? Math.max(JOIN_RETRY_MIN_MS, Number(p.retryMs) || 0) : 3000 + rand() * 2000;
      later(sendJoin, ms);
    });

    net.on('pp:replaced', () => {
      stats.note('paper:replaced');
      stats.unseated();
      state = 'wait';
      later(sendJoin, 3000 + rand() * 2000);
    });

    net.on('disconnect', (reason) => {
      if (stopped) return; // stop() counts its own close
      stats.dropped(reason);
      if (state === 'alive') state = 'joining'; // net.resuming: the seat is asked back on the next connect
      later(() => socket.connect(), RECONNECT_MS);
    });

    socket.on('connect_error', (err) => {
      if (stopped) return;
      const why = err && err.data && err.data.why ? err.data.why : err && err.message;
      stats.connectError(why);
      later(() => {
        if (!socket.connected) socket.connect();
      }, RECONNECT_MS + rand() * 1000);
    });

    return {
      stop() {
        if (stopped) return;
        try {
          if (socket.connected) net.leave(); // pp:leave: the square goes now, no grace
        } catch (_) {
          // closing anyway
        }
        stopped = true;
        clearInterval(frameTimer);
        clearLater();
        stopPing();
        try {
          socket.disconnect();
        } catch (_) {
          // already closed
        }
        stats.closed();
      },
    };
  },
};
