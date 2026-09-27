// Paper multiplayer: the client net layer (design 8.3, 7.2, 7.5, 6.2 and 6.3). One ArenaNet per
// page owns the socket handlers, the server clock estimate (an offset EMA), the adaptive jitter
// buffer, the frame buffer the other squares are interpolated from, the reliable event timeline
// (an entry applies when renderTick reaches its bundle tick; entries naming the local square
// apply on receipt), the resync safety net (pp:need) and the reconnect by resumeKey. The socket
// is injected, so node tests drive it with a double. State goes to a sink (the mirror game,
// paperMirror.js) through applyJoined(payload), applyEntry(entry, tick) and onFrame(frame).
// Needs paperWire at CALL time; loads standalone under require.
(function (root, factory) {
  'use strict';
  var api = factory(root);
  var P = root.DuelPaperLib = root.DuelPaperLib || {};
  P.Net = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  // Client timings that are not wire constants (paperWire.js is the shared block and this task
  // does not own it). The pp:need limits are the server's own (design 6.2, paperSockets.js
  // onNeed): a request sent faster than this is dropped there anyway.
  var NEED_UNIT_MS = 250;
  var NEED_ALL_MS = 2000;
  var NEED_ALL_AT = 4; // more ids due in one frame than this ask for everything (id 0)
  var PING_MS = 1000; // pp:ping at 1 Hz (6.2)
  var CLOCK_EMA = 0.1; // the snake client's clock blend (public/js/game.js:400-406)
  var JITTER_DECAY = 0.03; // the snake client's calm-network decay (public/js/game.js:411-414)
  var FRAME_KEEP = 60; // two seconds of 30 Hz frames
  var SEAT_EVENTS = ['pp:dead', 'pp:cashedout', 'pp:paid', 'pp:payerror', 'pp:refused', 'pp:replaced'];

  function mp() {
    var P = root.DuelPaperLib;
    if (!P || !P.MP) throw new Error('paperNet: load paperWire first');
    return P.MP;
  }

  function defaultNow() {
    return (typeof performance !== 'undefined' ? performance : Date).now();
  }

  // -----------------------------------------------------------------------------------------
  // The 7.2 idempotence rules, shared with the mirror so both layers decide alike
  // -----------------------------------------------------------------------------------------

  // u16 ring versions: a is newer than b on a half-ring window.
  function verNewer(a, b) {
    var d = (a - b) & 0xFFFF;
    return d > 0 && d < 0x8000;
  }

  // The point count of a ring or trail blob without decoding it; -1 for anything else.
  function blobCount(buf) {
    var dv = null;
    if (buf instanceof ArrayBuffer) dv = new DataView(buf);
    else if (buf && ArrayBuffer.isView(buf)) dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (!dv || dv.byteLength < 2) return -1;
    var n = dv.getUint16(0, true);
    return dv.byteLength >= 2 + 4 * n ? n : -1;
  }

  // ['t', id, epoch, from, pts] against what is held, { epoch (-1 = none), count }. Returns null
  // when the entry must be ignored (an older epoch, nothing newer than what is held, or a gap the
  // resync has to fill), else { reset, skip, epoch, count }: reset starts the trail afresh, skip
  // is the number of leading points already held.
  function trailMerge(held, epoch, from, n) {
    var MP = mp();
    if (!(n >= 0) || !(from >= 0)) return null;
    if (held.epoch < 0 || MP.seqNewer(epoch, held.epoch)) {
      if (from !== 0) return null; // the start of this trail never arrived
      return { reset: true, skip: 0, epoch: epoch, count: n };
    }
    if (epoch !== held.epoch || from > held.count) return null;
    var skip = held.count - from;
    if (skip >= n) return null;
    return { reset: false, skip: skip, epoch: epoch, count: from + n };
  }

  // The square an entry is about: entries naming the local square apply on receipt (8.3).
  function subjectOf(entry) {
    switch (entry[0]) {
      case 'j': return entry[1] && typeof entry[1] === 'object' ? entry[1].id : 0;
      case 'p+': return 0;
      case 'p-': return entry[2];
      default: return entry[1];
    }
  }

  // -----------------------------------------------------------------------------------------
  // Timeline: reliable entries in tick order (one stream, so arrival order breaks ties)
  // -----------------------------------------------------------------------------------------

  function Timeline() {
    this.items = [];
  }

  Timeline.prototype.push = function (tick, entry) {
    var items = this.items;
    var i = items.length;
    while (i > 0 && items[i - 1].tick > tick) i--;
    items.splice(i, 0, { tick: tick, entry: entry });
  };

  // Removes and returns every entry whose tick has been reached, oldest first.
  Timeline.prototype.due = function (renderTick) {
    var items = this.items;
    var n = 0;
    while (n < items.length && items[n].tick <= renderTick) n++;
    return n ? items.splice(0, n) : [];
  };

  // Removes and returns every waiting entry `match` accepts, oldest first.
  Timeline.prototype.take = function (match) {
    var items = this.items;
    var out = [];
    for (var i = 0; i < items.length; i++) {
      if (match(items[i].entry)) out.push(items.splice(i--, 1)[0]);
    }
    return out;
  };

  Object.defineProperty(Timeline.prototype, 'length', {
    get: function () { return this.items.length; }
  });

  // -----------------------------------------------------------------------------------------
  // ArenaNet
  // -----------------------------------------------------------------------------------------

  // opts: { socket, now?, sink?, onError? }. socket: on(event, fn), emit(event, payload) and an
  // optional volatile.emit. now: the page clock in ms (performance.now by default).
  function ArenaNet(opts) {
    opts = opts || {};
    this.socket = opts.socket || null;
    this.now = opts.now || defaultNow;
    this.sink = opts.sink || null;
    this.onError = opts.onError || function (where, e) {
      console.error('[PAPER] net ' + where, e && e.stack ? e.stack : e);
    };
    this.hooks = {};
    this.name = '';
    this.stake = 0;
    this.you = 0;
    this.resumeKey = null;
    this.seated = false;
    this.connected = true;
    // From a disconnect of a seated page until its resume's pp:joined. No pp:in goes out then:
    // the server's resume resets the seat's input stream (lastSeq = -1), so an old-stream seq
    // sent in that gap would be accepted and then shut out the fresh stream (seq 0 again) for
    // up to 127 ticks, the square driving straight on its last angle (5.7).
    this.resuming = false;
    this.lastPingAt = -Infinity;
    this.rtt = null;
    this.stats = { frames: 0, badFrames: 0, bundles: 0, needs: 0, joins: 0 };
    this._resetStream();
    if (this.socket) this.attach();
  }

  // Everything that belongs to one seat's stream: cleared on every pp:joined (first join or
  // resume), exactly as the snake client does on GAME_JOINED.
  ArenaNet.prototype._resetStream = function () {
    this.clockOffset = null;
    this.jitterBuf = 0;
    this.lastSnapAt = 0;
    this.frames = [];
    this.lastFrameTick = -1;
    this.joinTick = 0;
    this.timeline = new Timeline();
    this.recv = new Map(); // id -> { ver, epoch, count }: what has been RECEIVED (7.5)
    this.gone = new Map(); // id -> tick of its ['k']
    this.mismatch = new Map(); // id -> when the frame first disagreed with recv
    this.lastNeed = new Map(); // id -> when pp:need { id } was last sent
    this.lastNeedAll = -Infinity;
  };

  ArenaNet.prototype.attach = function () {
    var self = this;
    var socket = this.socket;
    // pp:joined, pp:ev and pp:geo arrive with their blobs packed into one attachment
    // (MP.packBin on the server); unpackBin is a no-op for everything else.
    function on(ev, fn) {
      socket.on(ev, function (payload) {
        try {
          fn.call(self, mp().unpackBin(payload));
        } catch (e) {
          self.onError(ev, e);
        }
      });
    }
    on('pp:joined', this.onJoined);
    on('pp:s', this.onFrame);
    on('pp:ev', this.onBundle);
    on('pp:geo', this.onBundle);
    on('pp:pong', this.onPong);
    SEAT_EVENTS.forEach(function (ev) {
      on(ev, function (p) { this.onSeatEvent(ev, p); });
    });
    on('connect', this.onConnect);
    on('disconnect', this.onDisconnect);
  };

  // Page hooks: 'joined', 'connect', 'disconnect', 'pong' and every pp: seat event by its name.
  ArenaNet.prototype.on = function (name, fn) {
    (this.hooks[name] = this.hooks[name] || []).push(fn);
    return this;
  };

  ArenaNet.prototype._hook = function (name, payload) {
    var list = this.hooks[name];
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      try {
        list[i](payload);
      } catch (e) {
        this.onError('hook ' + name, e);
      }
    }
  };

  // ---------------------------------------------------------------------------------------
  // Client to server (6.2)
  // ---------------------------------------------------------------------------------------

  // The first join carries the entry token exactly once; it is never stored here, so no later
  // emit (a reconnect in particular) can ever send it again.
  ArenaNet.prototype.join = function (opts) {
    opts = opts || {};
    this.name = opts.name == null ? '' : String(opts.name);
    this.stake = Number(opts.stake) || 0;
    this.resumeKey = null;
    this.seated = false;
    this.resuming = false;
    var msg = { name: this.name, stake: this.stake };
    if (opts.entryToken != null) msg.entryToken = opts.entryToken;
    this.socket.emit('pp:join', msg);
  };

  ArenaNet.prototype.respawn = function (entryToken) {
    var msg = {};
    if (entryToken != null) msg.entryToken = entryToken;
    this.socket.emit('pp:respawn', msg);
  };

  // Deliberate exit, no grace (5.7); only from end screens.
  ArenaNet.prototype.leave = function () {
    this.seated = false;
    this.resuming = false;
    this.resumeKey = null;
    this.socket.emit('pp:leave');
  };

  ArenaNet.prototype._volatile = function (ev, payload) {
    var s = this.socket;
    (s.volatile || s).emit(ev, payload);
  };

  // One pp:in integer per predicted tick (volatile, 6.2). Never while a resume is in flight.
  ArenaNet.prototype.sendInput = function (n) {
    if (!this.seated || !this.connected || this.resuming) return;
    this._volatile('pp:in', n);
  };

  ArenaNet.prototype._need = function (id) {
    this.stats.needs++;
    this.socket.emit('pp:need', { id: id });
  };

  // Called once per mirror update: the 1 Hz ping.
  ArenaNet.prototype.update = function (now) {
    if (now === undefined) now = this.now();
    if (this.seated && this.connected && now - this.lastPingAt >= PING_MS) {
      this.lastPingAt = now;
      this._volatile('pp:ping', { t: now });
    }
  };

  // ---------------------------------------------------------------------------------------
  // Connection and seat
  // ---------------------------------------------------------------------------------------

  // A reconnect takes the same seat back by its resumeKey (5.7): no token, nothing consumed.
  ArenaNet.prototype.onConnect = function () {
    this.connected = true;
    if (this.seated && this.resumeKey) {
      this.resuming = true;
      this.socket.emit('pp:join', { name: this.name, stake: this.stake, resumeKey: this.resumeKey });
    }
    this._hook('connect');
  };

  ArenaNet.prototype.onDisconnect = function (reason) {
    this.connected = false;
    if (this.seated) this.resuming = true;
    this._hook('disconnect', reason);
  };

  // A dead, cashed-out, refused or replaced seat is never resumed from this page.
  ArenaNet.prototype.onSeatEvent = function (ev, p) {
    if (ev === 'pp:dead' || ev === 'pp:cashedout' || ev === 'pp:refused' || ev === 'pp:replaced') {
      this.seated = false;
      this.resuming = false;
      this.resumeKey = null;
    }
    this._hook(ev, p);
  };

  ArenaNet.prototype.onPong = function (p) {
    if (!p || typeof p !== 'object' || typeof p.t !== 'number') return;
    this.rtt = this.now() - p.t;
    this._hook('pong', p);
  };

  // ---------------------------------------------------------------------------------------
  // Server to client (6.3)
  // ---------------------------------------------------------------------------------------

  // First join or resume: a full reset, then the whole state goes to the sink at once.
  ArenaNet.prototype.onJoined = function (p) {
    if (!p || typeof p !== 'object' || !(p.you > 0)) return;
    this._resetStream();
    this.stats.joins++;
    this.you = p.you;
    this.resumeKey = p.resumeKey || null;
    this.seated = true;
    this.resuming = false;
    if (typeof p.stake === 'number') this.stake = p.stake;
    this.joinTick = p.tick >>> 0;
    this._clockSample(this.joinTick, this.now());
    var units = Array.isArray(p.units) ? p.units : [];
    var trails = Array.isArray(p.trails) ? p.trails : [];
    for (var i = 0; i < units.length; i++) {
      var u = units[i];
      var n = blobCount(trails[i]);
      this.recv.set(u.id, { ver: u.ver & 0xFFFF, epoch: u.epoch & 255, count: n > 0 ? n : 0 });
    }
    if (this.sink) this.sink.applyJoined(p);
    this._hook('joined', p);
  };

  ArenaNet.prototype._clockSample = function (tick, arrival) {
    var sample = tick * mp().STEP_MS - arrival;
    if (this.clockOffset === null) this.clockOffset = sample;
    else this.clockOffset += (sample - this.clockOffset) * CLOCK_EMA;
  };

  // How much later than one snapshot period did this frame land? Grow at once on a spike,
  // shrink slowly when calm (the snake client's adaptive buffer).
  ArenaNet.prototype._jitterSample = function (arrival) {
    var MP = mp();
    if (this.lastSnapAt) {
      var late = Math.max(0, arrival - this.lastSnapAt - MP.SNAPSHOT_EVERY * MP.STEP_MS);
      if (late > this.jitterBuf) this.jitterBuf = Math.min(late, MP.MAX_JITTER_BUF_MS);
      else this.jitterBuf += (late - this.jitterBuf) * JITTER_DECAY;
    }
    this.lastSnapAt = arrival;
  };

  ArenaNet.prototype.onFrame = function (buf) {
    if (!this.you) return;
    var MP = mp();
    var frame;
    try {
      frame = MP.decodeFrame(buf);
    } catch (e) {
      this.stats.badFrames++;
      return;
    }
    if (frame.tick < this.joinTick || frame.tick <= this.lastFrameTick) return;
    var arrival = this.now();
    this.stats.frames++;
    this._clockSample(frame.tick, arrival);
    this._jitterSample(arrival);
    frame.byId = new Map();
    for (var i = 0; i < frame.units.length; i++) frame.byId.set(frame.units[i].id, frame.units[i]);
    this.frames.push(frame);
    if (this.frames.length > FRAME_KEEP) this.frames.shift();
    this.lastFrameTick = frame.tick;
    this._resync(frame, arrival);
    if (this.sink) this.sink.onFrame(frame);
  };

  // pp:ev bundles and pp:geo replies share the shape { tick, ev: [...] }.
  ArenaNet.prototype.onBundle = function (msg) {
    if (!this.you || !msg || typeof msg !== 'object' || !Array.isArray(msg.ev)) return;
    var tick = msg.tick >>> 0;
    this.stats.bundles++;
    for (var i = 0; i < msg.ev.length; i++) {
      var e = msg.ev[i];
      if (!Array.isArray(e) || typeof e[0] !== 'string') continue;
      this._note(e, tick);
      if (this.sink && subjectOf(e) === this.you) this._applyNow(e, tick);
      else this.timeline.push(tick, e);
    }
  };

  // An entry naming the local square, on receipt. A coin the local square collected can come
  // back ('p-' names the collector) before its own 'p+' (no square named) has reached renderTick:
  // that 'p+' is applied first, so the 'p-' finds the coin, instead of the 'p-' being ignored
  // as unknown and the late 'p+' leaving a coin nobody can ever collect.
  ArenaNet.prototype._applyNow = function (e, tick) {
    if (e[0] === 'p-') {
      var pid = e[1];
      var early = this.timeline.take(function (w) { return w[0] === 'p+' && w[1] === pid; });
      for (var i = 0; i < early.length; i++) this.sink.applyEntry(early[i].entry, early[i].tick);
    }
    this.sink.applyEntry(e, tick);
  };

  // What has been received, by the same rules the mirror applies (7.2), for the 7.5 compare.
  ArenaNet.prototype._note = function (e, tick) {
    var id;
    var h;
    switch (e[0]) {
      case 'j':
        id = subjectOf(e);
        this.gone.delete(id);
        if (!this.recv.has(id)) this.recv.set(id, { ver: 0, epoch: 0, count: 0 });
        break;
      case 'k':
        this.recv.delete(e[1]);
        this.gone.set(e[1], tick);
        this.mismatch.delete(e[1]);
        break;
      case 'b':
        id = e[1];
        h = this.recv.get(id);
        if (!h) {
          var g = this.gone.get(id);
          if (g !== undefined && tick <= g) break;
          this.gone.delete(id);
          this.recv.set(id, { ver: e[2] & 0xFFFF, epoch: -1, count: 0 });
        } else if (verNewer(e[2] & 0xFFFF, h.ver)) {
          h.ver = e[2] & 0xFFFF;
        }
        break;
      case 't':
        h = this.recv.get(e[1]);
        if (!h) break;
        var m = trailMerge(h, e[2] & 255, e[3] | 0, blobCount(e[4]));
        if (m) {
          h.epoch = m.epoch;
          h.count = m.count;
        }
        break;
    }
  };

  // The frame's versions against what was received (7.5).
  ArenaNet.prototype._mismatched = function (u, h) {
    if (!h) return true;
    if (u.baseVer !== 0 && verNewer(u.baseVer, h.ver)) return true;
    // A tail at the cap cannot say how many corners went reliably: no verdict this frame.
    if (u.tail.length >= mp().TRAIL_TAIL_MAX) return false;
    var sent = u.trailCount - u.tail.length;
    if (u.trailEpoch !== h.epoch) return sent > 0;
    return h.count !== sent;
  };

  // A mismatch older than RESYNC_AFTER_MS asks for that square's geometry, within the server's
  // rate limits (250 ms per id, 2000 ms for everything).
  ArenaNet.prototype._resync = function (frame, now) {
    var MP = mp();
    var due = [];
    for (var i = 0; i < frame.units.length; i++) {
      var u = frame.units[i];
      if (!this._mismatched(u, this.recv.get(u.id))) {
        this.mismatch.delete(u.id);
        continue;
      }
      var since = this.mismatch.get(u.id);
      if (since === undefined) this.mismatch.set(u.id, now);
      else if (now - since >= MP.RESYNC_AFTER_MS) due.push(u.id);
    }
    var self = this;
    this.mismatch.forEach(function (at, id) {
      if (!frame.byId.has(id)) self.mismatch.delete(id);
    });
    if (!due.length) return;
    // Many at once: one request for everything, never a burst of single ones in its wake.
    if (due.length > NEED_ALL_AT) {
      if (now - this.lastNeedAll < NEED_ALL_MS) return;
      this.lastNeedAll = now;
      for (var a = 0; a < due.length; a++) this.lastNeed.set(due[a], now);
      this._need(0);
      return;
    }
    for (var d = 0; d < due.length; d++) {
      var last = this.lastNeed.get(due[d]);
      if (last !== undefined && now - last < NEED_UNIT_MS) continue;
      this.lastNeed.set(due[d], now);
      this._need(due[d]);
    }
  };

  // ---------------------------------------------------------------------------------------
  // Time base (8.3): the sim tick, smooth even when the server runs two steps in one wake
  // ---------------------------------------------------------------------------------------

  ArenaNet.prototype.serverTick = function (now) {
    if (this.clockOffset === null) return null;
    if (now === undefined) now = this.now();
    return (now + this.clockOffset) / mp().STEP_MS;
  };

  // renderTick = serverTick - (INTERP_DELAY_MS + jitterBuf) / STEP_MS
  ArenaNet.prototype.renderTick = function (now) {
    var MP = mp();
    var t = this.serverTick(now);
    if (t === null) return null;
    return t - (MP.INTERP_DELAY_MS + this.jitterBuf) / MP.STEP_MS;
  };

  // The frames around renderTick: { before, after, alpha, extMs }. Past the newest frame, after
  // is null and extMs is the dead-reckoning time (capped at DEAD_RECKON_MS); before the oldest,
  // the oldest is shown. Null until a frame has arrived.
  ArenaNet.prototype.bracket = function (rt) {
    var MP = mp();
    var f = this.frames;
    if (!f.length) return null;
    if (rt <= f[0].tick) return { before: f[0], after: null, alpha: 0, extMs: 0 };
    var i = f.length - 1;
    while (i > 0 && f[i].tick > rt) i--;
    var before = f[i];
    var after = i + 1 < f.length ? f[i + 1] : null;
    if (!after) {
      return { before: before, after: null, alpha: 0, extMs: Math.min(MP.DEAD_RECKON_MS, (rt - before.tick) * MP.STEP_MS) };
    }
    return { before: before, after: after, alpha: (rt - before.tick) / (after.tick - before.tick), extMs: 0 };
  };

  ArenaNet.prototype.newest = function () {
    return this.frames.length ? this.frames[this.frames.length - 1] : null;
  };

  ArenaNet.prototype.takeDue = function (rt) {
    return this.timeline.due(rt);
  };

  return {
    ArenaNet: ArenaNet,
    Timeline: Timeline,
    verNewer: verNewer,
    blobCount: blobCount,
    trailMerge: trailMerge,
    subjectOf: subjectOf,
    NEED_UNIT_MS: NEED_UNIT_MS,
    NEED_ALL_MS: NEED_ALL_MS,
    NEED_ALL_AT: NEED_ALL_AT,
    PING_MS: PING_MS,
    CLOCK_EMA: CLOCK_EMA,
    JITTER_DECAY: JITTER_DECAY
  };
});
