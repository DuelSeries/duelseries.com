// Net layer for the agar.io redo client (build brief 6 and 8). The server sends one binary bundle
// per tick on 'ag:f'; this file decodes it with the shared wire (agWire) and hands each record,
// in order, to the page (agMain's feed, which applies it to the client world). The client never
// predicts: there is no clock estimate or jitter buffer here, every record is applied the moment
// it arrives, as the reference client does with its own stream.
//
// Outbound events, all 'ag:*' (never 'cell:*', so the old agar pages cannot talk to the new
// room): ag:join {name}, ag:spectate, ag:target {x, y} (integers), ag:split, ag:eject, ag:q,
// ag:leave, ag:view {below} (a whole number, 0 or more: the map rows the page draws under the
// reference view, world units at zoom 1; agMain sends it only when it changes), ag:portrait true|false
// (the phone portrait layout is on; one boolean, sent only when it changes), ag:hold {on: 1 | 0} (Owen's hold-Q
// cash-out, every room, 2026-10-08: agMain repeats {on: 1} while Q or the phone Cash out button is held and sends
// {on: 0} when it is let go). Nothing is sent while the socket is down (a dropped target is simply not sent; the
// camera keeps its last-sent pair, as the reference's send does when its socket is closed).
//
// Side events in (plain socket.io events next to the binary bundle, never inside it): SIDE_EVENTS below, each
// handed to opts.onEvent(name, payload). ag:holding and ag:cashedout reach every room (the hold ring and the
// results screen); the rest are sent to paid seats only (ag:money, ag:joined, the payout and end events).
//
// A bad bundle (agWire returns an error record) keeps the records before it, drops the rest
// and is counted and logged. The stream is a delta, so a lost record cannot be recovered by
// the client; the server's backlog resync (a 'sync' record) is the only repair path today
// (wire build notes, CHOSEN).
//
// The socket is injected (createNet), so node tests drive it with a double; connect(io, ...)
// builds one with the page's socket.io client and its default transport (never forced).
(function (root) {
  'use strict';
  var A = root.DuelAgarLib = root.DuelAgarLib || {};

  var EV = {
    frame: 'ag:f',
    join: 'ag:join',
    spectate: 'ag:spectate',
    target: 'ag:target',
    split: 'ag:split',
    eject: 'ag:eject',
    q: 'ag:q',
    leave: 'ag:leave',
    view: 'ag:view',
    portrait: 'ag:portrait',
    hold: 'ag:hold'
  };

  // The server's side events the page listens to (server/ag/agRoom.js, agPaidDoor.js and the agar payout instance
  // of server/paperPayout.js). Anything else on the socket is ignored.
  var SIDE_EVENTS = ['ag:holding', 'ag:cashedout', 'ag:money', 'ag:joined', 'ag:dead', 'ag:closed', 'ag:paid',
    'ag:payerror', 'ag:refused', 'ag:refunded', 'ag:replaced'];

  function wire() {
    var w = A.agWire;
    if (!w && typeof require === 'function') {
      try { w = require('../../../shared/agWire.js'); } catch (e) { w = null; }
    }
    if (!w) throw new Error('agNet: load shared/agWire.js first');
    return w;
  }

  function byteLength(buf) {
    if (!buf) return 0;
    if (typeof buf.byteLength === 'number') return buf.byteLength;
    if (typeof buf.length === 'number') return buf.length;
    return 0;
  }

  // An int32 target the wire accepts; anything else is not sent.
  function intOrNull(v) {
    return typeof v === 'number' && isFinite(v) ? Math.trunc(v) | 0 : null;
  }

  // opts: { socket, onMessage(record), onConnect(), onDisconnect(reason), onError(record),
  //         log(text) }
  function createNet(opts) {
    opts = opts || {};
    var socket = opts.socket || null;
    var onMessage = typeof opts.onMessage === 'function' ? opts.onMessage : function () {};
    var log = typeof opts.log === 'function' ? opts.log
      : function (t) { if (root.console && root.console.warn) root.console.warn(t); };
    var stats = { bundles: 0, records: 0, bytes: 0, errors: 0, lastError: null, sent: 0 };

    // One bundle: every record before a bad one is applied, the rest are dropped.
    function handleBundle(buf) {
      var recs = wire().decodeBundle(buf);
      stats.bundles++;
      stats.bytes += byteLength(buf);
      for (var i = 0; i < recs.length; i++) {
        var r = recs[i];
        if (r && r.t === 'error') {
          stats.errors++;
          stats.lastError = { reason: r.reason, offset: r.offset, kind: r.kind, bundle: stats.bundles };
          log('agNet: bad bundle #' + stats.bundles + ' (' + r.reason + ' at byte ' + r.offset + '), rest dropped');
          if (typeof opts.onError === 'function') opts.onError(r);
          return;
        }
        stats.records++;
        onMessage(r);
      }
    }

    if (socket && typeof socket.on === 'function') {
      socket.on(EV.frame, handleBundle);
      socket.on('connect', function () { if (typeof opts.onConnect === 'function') opts.onConnect(); });
      socket.on('disconnect', function (reason) { if (typeof opts.onDisconnect === 'function') opts.onDisconnect(reason); });
      if (typeof opts.onEvent === 'function') {
        SIDE_EVENTS.forEach(function (name) {
          socket.on(name, function (payload) { opts.onEvent(name, payload); });
        });
      }
    }

    function isUp() { return !!(socket && socket.connected); }
    function emit(ev, payload) {
      if (!isUp()) return false;
      if (payload === undefined) socket.emit(ev); else socket.emit(ev, payload);
      stats.sent++;
      return true;
    }

    var api = {
      stats: stats,
      handleBundle: handleBundle,
      connected: isUp,
      sendJoin: function (name) { return emit(EV.join, { name: String(name == null ? '' : name) }); },
      sendSpectate: function () { return emit(EV.spectate); },
      sendTarget: function (x, y) {
        var ix = intOrNull(x), iy = intOrNull(y);
        if (ix === null || iy === null) return false;
        return emit(EV.target, { x: ix, y: iy });
      },
      sendSplit: function () { return emit(EV.split); },
      sendEject: function () { return emit(EV.eject); },
      sendQ: function () { return emit(EV.q); },
      sendLeave: function () { return emit(EV.leave); },
      sendView: function (below) {
        var b = intOrNull(below);
        if (b === null || b < 0) return false;
        return emit(EV.view, { below: b });
      },
      // One boolean, nothing else: the server never takes a size from the client.
      sendPortrait: function (on) { return emit(EV.portrait, on === true); },
      // 1 while held (repeated by agMain), 0 when let go; the server's own shape (server/ag/agSockets.js onHold).
      sendHold: function (on) { return emit(EV.hold, { on: on === true ? 1 : 0 }); },
      // agMain's outbound kinds: play, spectate, target, split, eject, q, leave, view, portrait, hold.
      send: function (kind, payload) {
        switch (kind) {
          case 'play': return api.sendJoin(payload && payload.name);
          case 'spectate': return api.sendSpectate();
          case 'target': return api.sendTarget(payload && payload.x, payload && payload.y);
          case 'split': return api.sendSplit();
          case 'eject': return api.sendEject();
          case 'q': return api.sendQ();
          case 'leave': return api.sendLeave();
          case 'view': return api.sendView(payload && payload.below);
          case 'portrait': return api.sendPortrait(!!(payload && payload.on));
          case 'hold': return api.sendHold(!!(payload && payload.on));
          default: return false;
        }
      },
      close: function () { if (socket && typeof socket.close === 'function') socket.close(); }
    };
    return api;
  }

  // io: the socket.io client factory (window.io). opts: createNet's handlers plus url and
  // ioOptions. The transport is left to socket.io (lesson from the slither game's phones).
  function connect(io, onMessage, opts) {
    opts = opts || {};
    var socket = opts.url ? io(opts.url, opts.ioOptions || {}) : io(opts.ioOptions || {});
    var o = {};
    for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) o[k] = opts[k];
    o.socket = socket;
    o.onMessage = onMessage;
    return createNet(o);
  }

  A.agNet = { EVENTS: EV, SIDE_EVENTS: SIDE_EVENTS, createNet: createNet, connect: connect };
  if (typeof module !== 'undefined' && module.exports) module.exports = A.agNet;
})(typeof window !== 'undefined' ? window : globalThis);
