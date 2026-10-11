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
//     'x' (msg) and 'x:' + msg.t (msg)   each item of an sl:x array, in order
//     'menuShow', 'menuFade' (fr), 'menuDone'   their menu hooks (slLoop.hooks), relayed by slxMain
//   send(name, payload) -> bool   a layer emit on the live /sl socket (allow list above)
//   onSocket(name, fn)    one more socket event for the layer (attached to each /sl socket made after the call)
//   connected() -> bool   the current /sl socket is live
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
  var curRec = null;                             // {detached, life} of the newest tapped transport
  var sockSubs = [['sl:x', onLayerMessage]];

  function current(rec) {
    return rec === curRec && !rec.detached;
  }
  function live() {
    return !!(sock && sock.connected && curRec && !curRec.detached);
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

  function onSocket(name, fn) {
    if (typeof name !== 'string' || typeof fn !== 'function') return;
    sockSubs.push([name, fn]);
  }

  // sl:x: one JSON array per flush, emitted before that flush's sl:f (server/sl/slSendQueue.js).
  function onLayerMessage(data) {
    if (!Array.isArray(data) || !curRec) return;
    var rec = curRec;
    for (var i = 0; i < data.length && i < X_MAX; i++) {
      var m = data[i];
      if (!m || typeof m !== 'object' || typeof m.t !== 'string') continue;
      if (m.t === 'refused' && typeof m.why === 'string') rec.life.refused = m.why;
      fire('x', m);
      fire('x:' + m.t, m);
    }
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
        h.onFrame(events, byteLength);
        if (!current(rec) || !events) return;
        observeFrame(events);
        fire('frame', events, byteLength);
      },
      onClose: function () {
        if (current(rec)) {
          var S = D.S;
          var l = rec.life;
          fire('close', { playing: !!(S && S.playing), opened: l.opened, sawDead: l.sawDead, refused: l.refused });
        }
        h.onClose();
      }
    };
  }

  function tapSend(t, rec) {
    var send0 = t.send;
    var close0 = t.close;
    t.send = function (bundle) {
      if (current(rec) && live()) {
        try {
          var list = D.slWire.decodeInput(bundle);
          for (var i = 0; i < list.length; i++) {
            if (list[i] && list[i].type === 'ping') {
              pings.push(now());
              if (pings.length > PING_MAX) pings.shift();
            }
          }
          fire('send', list);
        } catch (e) {
          slx.errors++;
        }
      }
      return send0.apply(t, arguments);
    };
    t.close = function () {
      rec.detached = true;
      return close0.apply(t, arguments);
    };
    return t;
  }

  cfg.transport = function (h) {
    var rec = { detached: false, life: { opened: false, sawDead: false, refused: null, vis: 0 } };
    curRec = rec;
    pings = [];
    return tapSend(D.slNet.makeSocketIoTransport(tap(h, rec)), rec);
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
  slx.connected = live;
  slx.now = now;
  slx.auth = null;
  slx.active = true;
})(typeof window !== 'undefined' ? window : globalThis);
