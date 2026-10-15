// DuelSeries layer on the frozen slither.io client: the net tap (SERVER-DESIGN 15.0 to 15.2; task T16). Ours, not
// a parity area. Loaded by the /sl page right after slMain.js (server/sl/slBoot.js composePage); never in
// public/sl.html and never in public/js/sl/ (test/slParityGate.test.js pins both).
//
// INERT unless this page runs the production transport (15.2, finalize pass C20): when DuelSlitherConfig.transport
// is already a function (the parity harness and test/slVmPage.js set their own), this file only leaves
// DuelSlither.slx = {active: false} and returns. Every other layer file starts with the same check, so an inert
// layer makes no timer, no animation frame, no listener, no image load and no DOM node (test/slxNoTouch.test.js).
//
// Active, it does three things and nothing else:
// 1. DuelSlitherConfig.transport = h => tapSend(slNet.makeSocketIoTransport(tap(h))). The FROZEN socket.io
//    transport (public/js/sl/slNet.js:133-186) still does all the work; the tap only lets layer observers see what
//    it already does. tap: onOpen and onFrame call the original FIRST, then the observers; onClose lets the
//    observers read S first, then calls the original. tapSend: each outbound input bundle is decoded
//    (slWire.decodeInput) for the ping clock, then the original send runs; close marks the transport detached.
//    Observers run only for the current transport (slNet's own `cur === t` rule, slNet.js:63-75).
// 2. window.io is wrapped once, for the namespace /sl only: every argument passes through, plus the handshake
//    auth (slx.auth(), the skin cv, SERVER-DESIGN 15.5) and the layer's socket listeners (sl:x, and any a layer
//    file adds with slx.onSocket before Play). Any other namespace goes to the original io untouched.
// 3. Layer emits on the same socket (slx.send), only sl:hold, sl:vis, sl:chat and sl:diag (SERVER-DESIGN 12.2);
//    and sl:vis itself, from a visibilitychange listener (15.2), so the server never counts a hidden tab as late.
// 4. Resume after a blip (task T16b; Owen Q10 "glide 3 s from the start ... while reconnecting"; SERVER-DESIGN 9.6;
//    server/sl/slResume.js). The server hands each life a key in sl:x {t: 'seat', k, ms} and a new one at every
//    resume ({t: 'back', k, ms}); the key stays in this file (never fired to observers). When the life's socket drops
//    (any reason but the server's own disconnect or this page's, no refusal, own death not seen, a key held), their
//    close is NOT run: their client keeps the transport and sees a late stream (lag mode), exactly what a long stall
//    looks like. Meanwhile new /sl sockets are made (the same options, through the wrapped io), each sending
//    sl:back {k, n, p} (n: the sl:f bundles this life got, p: the pings their client sent this life) as its first
//    emit. The answer 'back' resumes: the server's resync bundle follows on the new socket and is fed to their
//    client through the same transport, their sends go to the new socket, the last angle and boost they sent while
//    down go once, and sl:vis is told again. A refusal, or no resume inside ms of the drop (the server's glide plus
//    its dead-seat limit), runs their close as before. An attempt not answered in RESUME_TRY_MS is dropped and the
//    next starts RESUME_GAP_MS later. Under a harness transport none of this exists (the file is inert).
//
// The layer API (DuelSlither.slx), for slxMain, slxDirect and the later layer files (T17, T18):
//   active                true only when this file installed the production transport
//   on(name, fn) -> off   observers, each call caught and counted (slx.errors), never thrown into the game:
//     'open'              the game socket opened (their sl:join already sent)
//     'frame'  (events, byteLength)   after their client applied the bundle
//     'pong'   (rttMs)    a pong arrived; rttMs from the matching outbound ping record (-1 when none was seen)
//     'ownAdd' (ev)       the own snake_add (id equal to S.slither.id after the apply)
//     'ownDead' (ev)      the own dead (their server sends `dead` to the dying seat only)
//     'ownKills' (ev)     the own kill_count
//     'send'   (events)   the decoded outbound input records (angle, turn, boost, ping)
//     'close'  (info)     before their close runs: {playing, opened, sawDead, refused}; refused is the why of an
//                         sl:x refusal on this socket (server/sl/slSockets.js REFUSALS) or null
//     'resuming'          the life's socket dropped and a resume started (their close waits)
//     'resumed'           the server gave the life back on a new socket (no 'open' follows: it is the same life)
//     'x' (msg) and 'x:' + msg.t (msg)   each item of an sl:x array, in order
//     'menuShow', 'menuFade' (fr), 'menuDone'   their menu hooks (slLoop.hooks), relayed by slxMain
//   send(name, payload) -> bool   a layer emit on the live /sl socket (allow list above)
//   onSocket(name, fn)    one more socket event for the layer (attached to each /sl socket made after the call)
//   endLife() -> bool     ends the current life from this page as a dropped connection would (slxWatch's Next):
//                         sl:leave, then the live /sl socket closes; their own transport sees its socket's disconnect,
//                         so their close runs as for any drop, and no resume is tried (this page's own disconnect)
//   connected() -> bool   the current /sl socket is live (false while a resume runs)
//   resuming() -> bool    a resume is running
//   rtt                   the last ping round trip in ms (-1 before the first)
//   now()                 the page clock (performance.now)
//   fire(name, a, b)      relays an observer event (slxMain uses it for the menu hooks)
//   auth                  null, or a function returning the extra handshake fields (slxMain sets it)
(function (root) {
  'use strict';
  var D = root.DuelSlither;
  if (!D || D.slx) return;                       // the frozen client did not boot, or the layer loaded twice
  var slx = D.slx = { active: false };
  var cfg = root.DuelSlitherConfig;
  if (cfg && typeof cfg.transport === 'function') return;      // a harness transport: inert (15.2)
  if (!D.slNet || typeof D.slNet.makeSocketIoTransport !== 'function') return;
  if (!D.slWire || typeof D.slWire.decodeInput !== 'function') return;
  if (!cfg) cfg = root.DuelSlitherConfig = {};

  var NS = '/sl';                                // the frozen transport's namespace (slNet.js:154)
  var LAYER_EMITS = { 'sl:hold': true, 'sl:vis': true, 'sl:chat': true, 'sl:diag': true };
  // An sl:x array longer than this is not ours (the server sends a handful of items per flush).
  var X_MAX = 256;
  // Resume (4. above; CHOSEN, task T16b BUILD-DECISIONS). An attempt is a new socket that must connect and answer its
  // sl:back within RESUME_TRY_MS (a phone polling handshake is a few round trips); after a failed one the next starts
  // RESUME_GAP_MS later; the server's window ms is believed only up to RESUME_MS_MAX.
  var RESUME_TRY_MS = 3000;
  var RESUME_GAP_MS = 500;
  var RESUME_MS_MAX = 60000;
  // The key's exact shape (server/sl/slResume.js makeKey, isKey); anything else is never kept or sent.
  var KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  // socket.io-client's reasons for a close that is nobody's blip: the server's own disconnect (a kick or a refusal) and
  // this page's.
  var NO_RESUME = { 'io server disconnect': true, 'io client disconnect': true };
  // Outbound pings waiting for their pong. Their client keeps at most one in flight (slInput stepPing), so a longer
  // queue only means pongs went missing; the oldest are dropped.
  var PING_MAX = 16;
  var doc = root.document;
  var has = Object.prototype.hasOwnProperty;

  function now() {
    var p = root.performance;
    return p && typeof p.now === 'function' ? p.now() : Date.now();
  }

  // ---- observers
  var subs = {};
  slx.errors = 0;
  function on(name, fn) {
    if (typeof fn !== 'function') return function () {};
    var list = subs[name] || (subs[name] = []);
    list.push(fn);
    return function off() {
      var at = list.indexOf(fn);
      if (at >= 0) list.splice(at, 1);
    };
  }
  function fire(name, a, b) {
    var list = subs[name];
    if (!list || !list.length) return;
    list = list.slice();
    for (var i = 0; i < list.length; i++) {
      try {
        list[i](a, b);
      } catch (e) {
        slx.errors++;
      }
    }
  }

  // ---- the /sl socket (the newest one the wrapped io made) and the current transport
  var sock = null;
  var curRec = null;                             // the newest tapped transport's life (cfg.transport below)
  var sockSubs = [['sl:x', onLayerMessage], ['disconnect', onSockDisconnect]];

  function current(rec) {
    return rec === curRec && !rec.detached;
  }
  function live() {
    return !!(sock && sock.connected && curRec && !curRec.detached && !curRec.re);
  }

  function send(name, payload) {
    if (!has.call(LAYER_EMITS, name) || !live()) return false;
    try {
      sock.emit(name, payload);
      return true;
    } catch (e) {
      slx.errors++;
      return false;
    }
  }

  // Their transport is never asked to close (its close detaches it first, so their close would never run): the socket
  // goes, and its disconnect reaches their transport and the tap as a drop does (header, endLife).
  function endLife() {
    if (!live()) return false;
    var s = sock;
    try {
      s.emit('sl:leave');
      s.disconnect();
      return true;
    } catch (e) {
      slx.errors++;
      return false;
    }
  }

  function onSocket(name, fn) {
    if (typeof name !== 'string' || typeof fn !== 'function') return;
    sockSubs.push([name, fn]);
  }

  // sl:x: one JSON array per flush, emitted before that flush's sl:f (server/sl/slSendQueue.js).
  function onLayerMessage(data) {
    if (!Array.isArray(data) || !curRec) return;
    var rec = curRec;
    var s = sock;
    for (var i = 0; i < data.length && i < X_MAX; i++) {
      var m = data[i];
      if (!m || typeof m !== 'object' || typeof m.t !== 'string') continue;
      if (m.t === 'seat' || m.t === 'back') {
        // the life's key (4. above): kept here, never fired to observers
        if (typeof m.k !== 'string' || !KEY_RE.test(m.k)) continue;
        rec.key = m.k;
        rec.keyMs = typeof m.ms === 'number' && m.ms > 0 ? (m.ms < RESUME_MS_MAX ? m.ms : RESUME_MS_MAX) : 0;
        if (m.t === 'back' && rec.re && rec.re.sock === s) resumed(rec, s);
        continue;
      }
      if (m.t === 'refused' && typeof m.why === 'string') rec.life.refused = m.why;
      fire('x', m);
      fire('x:' + m.t, m);
    }
  }

  // Every /sl socket's close reason, for the resume rule (NO_RESUME); it runs before their own disconnect listener.
  function onSockDisconnect(reason) {
    if (curRec) curRec.reason = reason == null ? '' : String(reason);
  }

  // The handshake options: theirs, copied, plus the layer's auth fields.
  function withAuth(opts) {
    var o = {};
    var k;
    if (opts && typeof opts === 'object') for (k in opts) if (has.call(opts, k)) o[k] = opts[k];
    var auth = {};
    if (o.auth && typeof o.auth === 'object') for (k in o.auth) if (has.call(o.auth, k)) auth[k] = o.auth[k];
    var extra = null;
    try {
      extra = typeof slx.auth === 'function' ? slx.auth() : null;
    } catch (e) {
      slx.errors++;
    }
    if (extra && typeof extra === 'object') for (k in extra) if (has.call(extra, k)) auth[k] = extra[k];
    o.auth = auth;
    return o;
  }

  function attach(s, name, fn) {
    s.on(name, function (data) {
      if (sock !== s) return;                    // an older socket: ignored, as their client ignores it
      try {
        fn(data);
      } catch (e) {
        slx.errors++;
      }
    });
  }

  var origIo = root.io;
  if (typeof origIo === 'function') {
    var wrapped = function (uri) {
      if (uri !== NS) return origIo.apply(this, arguments);
      var args = Array.prototype.slice.call(arguments);
      args[1] = withAuth(args[1]);
      var s = origIo.apply(this, args);
      sock = s;
      if (s && typeof s.on === 'function') for (var i = 0; i < sockSubs.length; i++) attach(s, sockSubs[i][0], sockSubs[i][1]);
      return s;
    };
    for (var key in origIo) if (has.call(origIo, key)) wrapped[key] = origIo[key];
    root.io = wrapped;
  }

  // ---- the tap
  var pings = [];
  slx.rtt = -1;

  function observeFrame(events) {
    var S = D.S;
    var me = S ? S.slither : null;
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      if (!ev) continue;
      if (ev.type === 'pong') {
        var rtt = pings.length ? now() - pings.shift() : -1;
        if (rtt >= 0) slx.rtt = rtt;
        fire('pong', rtt);
      } else if (ev.type === 'snake_add') {
        if (me && ev.id === me.id) fire('ownAdd', ev);
      } else if (ev.type === 'dead') {
        curRec.life.sawDead = true;
        fire('ownDead', ev);
      } else if (ev.type === 'kill_count') {
        if (me && ev.id === me.id) fire('ownKills', ev);
      }
    }
  }

  function tap(h, rec) {
    return {
      onOpen: function () {
        h.onOpen();
        if (!current(rec)) return;
        rec.life.opened = true;
        fire('open');
        sendVis(true);
      },
      onFrame: function (events, byteLength) {
        if (current(rec)) rec.n++;               // every sl:f of the life counts, as the server's sentSeq (resume)
        h.onFrame(events, byteLength);
        if (!current(rec) || !events) return;
        observeFrame(events);
        fire('frame', events, byteLength);
      },
      onClose: function () {
        dropped(rec);
      }
    };
  }

  // Their close, once per life: the observers first (while S still says how the life ended), then theirs.
  function closeLife(rec) {
    if (rec.closed) return;
    rec.closed = true;
    stopResume(rec);
    if (current(rec)) {
      var S = D.S;
      var l = rec.life;
      fire('close', { playing: !!(S && S.playing), opened: l.opened, sawDead: l.sawDead, refused: l.refused });
    }
    rec.h.onClose();
  }

  // ---- resume (4. in the header)
  function resumable(rec) {
    return !!rec.key && rec.keyMs > 0 && rec.life.opened && !rec.life.sawDead && !rec.life.refused &&
      !has.call(NO_RESUME, rec.reason) && typeof root.setTimeout === 'function';
  }

  // The life's socket went (the frozen transport's own, or a resumed one): resume when the rule allows, else close.
  function dropped(rec) {
    if (rec.closed || rec.re) return;
    if (current(rec) && resumable(rec)) {
      rec.alt = null;
      rec.re = { until: now() + rec.keyMs, sock: null, timer: null, tries: 0 };
      fire('resuming');
      attempt(rec);
      return;
    }
    closeLife(rec);
  }

  function clearTimer(re) {
    if (re && re.timer !== null) {
      try {
        root.clearTimeout(re.timer);
      } catch (e) {
        slx.errors++;
      }
      re.timer = null;
    }
  }

  function stopResume(rec) {
    var re = rec.re;
    if (!re) return;
    rec.re = null;
    clearTimer(re);
    var s = re.sock;
    re.sock = null;
    if (s) {
      try {
        s.disconnect();
      } catch (e) {
        slx.errors++;
      }
    }
  }

  function toU8(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (data && ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return new Uint8Array(0);
  }

  // One attempt: a new /sl socket (their options, through the wrapped io), sl:back as its first emit.
  function attempt(rec) {
    var re = rec.re;
    if (!re || rec.closed || !current(rec)) return;
    clearTimer(re);
    var left = re.until - now();
    if (left <= 0) return closeLife(rec);        // the server's window is over: the life ended there
    re.tries++;
    var s;
    try {
      s = root.io(NS, { forceNew: true, reconnection: false });
    } catch (e) {
      slx.errors++;
      return closeLife(rec);
    }
    if (!s || typeof s.on !== 'function') return closeLife(rec);
    re.sock = s;
    re.timer = root.setTimeout(function () { failed(rec, s); }, left < RESUME_TRY_MS ? left : RESUME_TRY_MS);
    s.on('connect', function () {
      if (!rec.re || rec.re.sock !== s) return;
      try {
        s.emit('sl:back', { k: rec.key, n: rec.n, p: rec.p });
      } catch (e) {
        slx.errors++;
      }
    });
    s.on('connect_error', function () { failed(rec, s); });
    s.on('disconnect', function () {
      if (rec.re && rec.re.sock === s) failed(rec, s);
      else if (rec.alt === s) dropped(rec);
    });
    s.on('sl:f', function (data) {
      if (rec.alt !== s || rec.closed || rec.re) return;
      try {
        var u8 = toU8(data);
        rec.th.onFrame(D.slWire.decodeBundle(u8), u8.length);
      } catch (e) {
        slx.errors++;
      }
    });
  }

  // An attempt that failed (no connect, a close, no answer in time): a refusal ends the life, else the next attempt.
  function failed(rec, s) {
    var re = rec.re;
    if (!re || re.sock !== s) return;
    re.sock = null;
    clearTimer(re);
    try {
      s.disconnect();
    } catch (e) {
      slx.errors++;
    }
    if (rec.life.refused) return closeLife(rec);
    var left = re.until - now();
    if (left <= 0) return closeLife(rec);
    re.timer = root.setTimeout(function () { attempt(rec); }, left < RESUME_GAP_MS ? left : RESUME_GAP_MS);
  }

  // 'back' arrived on the attempt socket s: the life goes on there.
  function resumed(rec, s) {
    var re = rec.re;
    clearTimer(re);
    rec.re = null;
    rec.alt = s;
    rec.reason = '';
    var recs = [];
    if (rec.held.angle) recs.push(rec.held.angle);
    if (rec.held.boost) recs.push(rec.held.boost);
    rec.held = { angle: null, boost: null };
    if (recs.length) {
      try {
        s.emit('sl:i', D.slWire.encodeInput(recs));
      } catch (e) {
        slx.errors++;
      }
    }
    rec.life.vis = 0;                            // the server starts the new socket as visible
    sendVis(true);
    fire('resumed');
  }

  function tapSend(t, rec) {
    var send0 = t.send;
    var close0 = t.close;
    t.send = function (bundle) {
      var list = null;
      if (current(rec) && (live() || rec.re)) {
        try {
          list = D.slWire.decodeInput(bundle);
          for (var i = 0; i < list.length; i++) {
            if (list[i] && list[i].type === 'ping') {
              rec.p++;                           // their client thinks it pinged: the server answers a lost one
              pings.push(now());
              if (pings.length > PING_MAX) pings.shift();
            }
          }
          fire('send', list);
        } catch (e) {
          slx.errors++;
        }
      }
      if (rec.re) {
        // down: nothing leaves; the newest wanted angle and boost go once the life is back
        if (list) {
          for (var j = 0; j < list.length; j++) {
            var ev = list[j];
            if (ev && ev.type === 'angle') rec.held.angle = ev;
            else if (ev && ev.type === 'boost') rec.held.boost = ev;
          }
        }
        return;
      }
      if (rec.alt) {
        var a = rec.alt;
        if (a.connected) {
          try {
            a.emit('sl:i', bundle);
          } catch (e) {
            slx.errors++;
          }
        }
        return;
      }
      return send0.apply(t, arguments);
    };
    t.close = function () {
      rec.detached = true;
      stopResume(rec);
      var a = rec.alt;
      rec.alt = null;
      if (a) {
        try {
          if (a.connected) a.emit('sl:leave');
          a.disconnect();
        } catch (e) {
          slx.errors++;
        }
      }
      return close0.apply(t, arguments);
    };
    return t;
  }

  cfg.transport = function (h) {
    var rec = { detached: false, closed: false, life: { opened: false, sawDead: false, refused: null, vis: 0 },
      h: h, th: null, key: null, keyMs: 0, n: 0, p: 0, reason: '', re: null, alt: null,
      held: { angle: null, boost: null } };
    rec.th = tap(h, rec);
    curRec = rec;
    pings = [];
    return tapSend(D.slNet.makeSocketIoTransport(rec.th), rec);
  };

  // ---- sl:vis (SERVER-DESIGN 12.2): the server starts every socket as visible.
  function hiddenNow() {
    return doc && (doc.hidden === true || doc.visibilityState === 'hidden') ? 1 : 0;
  }
  function sendVis(atOpen) {
    if (!curRec) return;
    var h = hiddenNow();
    var l = curRec.life;
    if (h === l.vis) return;
    if (atOpen && !h) return;
    if (send('sl:vis', { hidden: h })) l.vis = h;
  }
  if (doc && typeof doc.addEventListener === 'function') {
    doc.addEventListener('visibilitychange', function () {
      try {
        sendVis(false);
      } catch (e) {
        slx.errors++;
      }
    });
  }

  slx.on = on;
  slx.fire = fire;
  slx.send = send;
  slx.onSocket = onSocket;
  slx.endLife = endLife;
  slx.connected = live;
  slx.resuming = function () { return !!(curRec && curRec.re); };
  slx.now = now;
  slx.auth = null;
  slx.active = true;
})(typeof window !== 'undefined' ? window : globalThis);
