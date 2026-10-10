// slither.io redo: the game connection (build brief 7.7, 10.4 rows 14 to 17, 12.2).
// Their client keeps one `ws` and ignores events of any socket that is no longer it. Ours keeps one
// current transport the same way. A transport is any object made by `factory(handlers)` with
// open(), send(bundle), close() and an optional join(nick). It calls handlers.onOpen(),
// handlers.onFrame(events, byteLength) and handlers.onClose().
// The product transport is socket.io (namespace /sl, events sl:*). The harness page passes its own
// through window.DuelSlitherConfig.transport, so the same slNet code runs in both.
(function (root) {
  'use strict';
  var D = root.DuelSlither = root.DuelSlither || {};

  var cur = null;                  // their `ws` (game.js:7216): set by connect, nulled by closeSocket

  function S() { return D.S; }
  function stats() { return D.stats; }

  // Their asciize (game.js:9076-9096): any char below 32 or above 127 becomes a space.
  function asciize(s) {
    var i, v, fix = false;
    for (i = 0; i < s.length; i++) {
      v = s.charCodeAt(i);
      if (v < 32 || v > 127) { fix = true; break; }
    }
    if (!fix) return s;
    var out = '';
    for (i = 0; i < s.length; i++) {
      v = s.charCodeAt(i);
      out += v < 32 || v > 127 ? ' ' : String.fromCharCode(v);
    }
    return out;
  }

  // The name their socket open keeps (game.js:8951-8961): asciized, cut to 24, the gameweek2016 code
  // (any case) blanked. The localStorage side effect of that code is out.
  function openNick(raw) {
    var s = asciize(raw == null ? '' : String(raw));
    if (s.length > 24) s = s.substr(0, 24);
    if (s.toLowerCase() == 'gameweek2016') s = '';
    return s;
  }

  function playNick() {
    var m = D.slMain;
    return m && m.nick != null ? m.nick : '';
  }

  function factory() {
    var c = root.DuelSlitherConfig;
    if (c && typeof c.transport === 'function') return c.transport;
    return makeSocketIoTransport;
  }

  // Their connect() (game.js:7175-7216) minus the server list wait and the server pick:
  // resetGame, want_play off, connecting on, the connect time, then a new socket.
  // The 3333 ms reconnect of game.js:4310-4329 picks another server; it is not built (one server).
  function connect() {
    var s = S();
    D.slApply.resetGame();
    s.want_play = false;
    s.connecting = true;
    s.start_connect_mtm = D.slLoop.now();
    var t = null;
    t = factory()({
      onOpen: function () {
        if (cur !== t) return;                       // game.js:8950
        onOpen(t);
      },
      onFrame: function (events, byteLength) {
        if (cur !== t) return;                       // game.js:7220
        onFrame(events, byteLength);
      },
      onClose: function () {
        if (cur !== t) return;                       // game.js:8938
        D.slApply.applyClose();
      }
    });
    cur = t;
    t.open();
  }

  // Their ws.onopen (game.js:8949-9038): the kept name goes to my_nick; the login bytes are their
  // protocol (out), ours sends sl:join with the name that passes gdnm (game.js:8962); then the
  // quality part, owned by slLoop.
  function onOpen(t) {
    var s = S();
    var name = openNick(playNick());
    s.my_nick = name;
    if (typeof t.join === 'function') t.join(D.slApply.gdnm(name) ? name : '');
    D.slLoop.onSocketOpen();
  }

  // One received message. A throw inside applyFrame drops the rest of that message (their packet
  // handler throws the same way); it is counted and the next message still applies.
  function onFrame(events, byteLength) {
    var st = stats();
    if (st) {
      st.messages++;
      st.events += events.length;
      st.wireBytes += byteLength;
      for (var i = 0; i < events.length; i++) if (events[i] && events[i].type === 'wire_error') st.wireErrors++;
    }
    try {
      D.slApply.applyFrame(events, byteLength);
    } catch (e) {
      if (st) st.applyThrows++;
      if (st) st.lastThrow = String(e && e.message || e);
    }
  }

  // Their `ws.close(); ws = null` (game.js:7118-7121, 4490-4492). The transport is detached first,
  // so its later close event is not applied.
  function closeSocket() {
    var t = cur;
    cur = null;
    if (t) t.close();
  }

  function hasSocket() {
    return cur != null;
  }

  // Outbound events from slInput (brief 6.5), one input bundle each (brief 7.6).
  function send(ev) {
    if (!cur) return;
    cur.send(D.slWire.encodeInput([ev]));
  }

  // The product transport: socket.io namespace /sl (brief 7.7). Bundles are reliable and ordered.
  // One transport is one connection, like their single WebSocket (game.js:8937-8947): socket.io's own
  // reconnection is off, a connect that fails counts as the close (their onclose on a failed open), the
  // close is reported once, and nothing is sent while the connection is down (socket.io would buffer it and
  // send it late). Opening again is slNet.connect's job.
  function makeSocketIoTransport(handlers) {
    var sock = null;
    var opened = false;
    var closed = false;
    function closeOnce() {
      if (closed) return;
      closed = true;
      handlers.onClose();
    }
    function live() {
      return sock && sock.connected ? sock : null;
    }
    function toU8(data) {
      if (data instanceof Uint8Array) return data;
      if (data instanceof ArrayBuffer) return new Uint8Array(data);
      if (data && ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      return new Uint8Array(0);
    }
    return {
      open: function () {
        if (typeof root.io !== 'function') throw new Error('slNet: socket.io client is not loaded');
        var me = root.io('/sl', { forceNew: true, reconnection: false });
        sock = me;
        me.on('connect', function () {
          if (sock !== me || opened || closed) return;
          opened = true;
          handlers.onOpen();
        });
        me.on('connect_error', function () { if (sock === me) closeOnce(); });
        me.on('sl:f', function (data) {
          if (sock !== me) return;
          var u8 = toU8(data);
          handlers.onFrame(D.slWire.decodeBundle(u8), u8.length);
        });
        me.on('disconnect', function () { if (sock === me) closeOnce(); });
      },
      join: function (nick) {
        var s = live();
        if (s) s.emit('sl:join', { nick: nick });
      },
      send: function (bundle) {
        var s = live();
        if (s) s.emit('sl:i', bundle);
      },
      close: function () {
        var me = sock;
        sock = null;
        if (me) {
          if (me.connected) me.emit('sl:leave');
          me.disconnect();
        }
      }
    };
  }

  var api = {
    connect: connect,
    closeSocket: closeSocket,
    hasSocket: hasSocket,
    send: send,
    makeSocketIoTransport: makeSocketIoTransport
  };
  D.slNet = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
