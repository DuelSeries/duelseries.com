// DuelSeries layer on the frozen slither.io client: the ping and FPS readout and the sl:diag report (Owen Q14;
// SERVER-DESIGN 15.3 "Old extras kept", 9.6, 12.2, 16.2 Phase 4 bars; task T17). Ours, not a parity area.
//
// Inert unless slxNet installed the production transport (15.2, finalize pass C20).
//
// The readout is the one every game shows (Owen 2026-10-27: "the exact same ping and FPS count in every single
// game"; public/js/shared/dsPerfHud.js, loaded before the layer by server/sl/slBoot.js): bottom right, its ping timed
// on its own echo on this socket (slx.echo, slxNet) like every other game's, its FPS from its own frames. Shown while
// their game shows (S.playing). The diag below keeps its own numbers: their ping record's round trips ('pong' rttMs,
// slxNet) for pongP95 and this file's frames over 500 ms for fps.
//
// sl:diag (server/sl/slSockets.js DIAG_NUMBERS, slRoom onDiag): one report at each socket open (it names how the
// previous socket ended) and then one every DIAG_EVERY_MS while connected. Fields, each over the time since the last
// report:
//   applyThrows, wireErrors  new counts in their DuelSlither.stats (slNet.js:94-107); the room adds them up
//   fps                      the last 500 ms frame rate
//   lag, lagEntries          ms spent in their lag mode (S.lagging, slLoop.js:520-530) and how many times it began
//   pongP95                  the 95th percentile ping round trip in ms (nearest rank), when a pong came
//   maxGapMs                 the largest gap between two received bundles
//   maxOwnChl                the largest own-snake chl seen in a frame (slLoop.js:339-343, slApply.js:706-711)
//   lastClose                the first report of a socket only: how the previous one ended (CLOSE_NAMES)
(function (root) {
  'use strict';
  var D = root.DuelSlither;
  if (!D || !D.slx || !D.slx.active) return;
  var slx = D.slx;
  var doc = root.document;
  var S = D.S;
  if (!doc || !S || typeof slx.on !== 'function') return;

  // law C_RATE diag (10000 ms, spec/SERVER-LAWS.md section N): the server keeps one sl:diag per socket per 10 s and
  // drops the rest. Plus one second (CHOSEN) so a late frame or a batched poll never lands a report inside the gap.
  var DIAG_EVERY_MS = 10000 + 1000;
  var FPS_WINDOW_MS = 500;                       // the diag's fps window
  var NAME_MAX = 24;                             // law L45 nameMax: the server's lastClose cap (slSockets cleanDiag)
  // socket.io's disconnect reasons as one short word each (the server keeps only letters, digits, _ : -).
  var CLOSE_NAMES = {
    'io server disconnect': 'server',
    'io client disconnect': 'client',
    'ping timeout': 'ping-timeout',
    'transport close': 'transport-close',
    'transport error': 'transport-error',
    'parse error': 'parse-error',
    connect_error: 'connect-error'
  };

  // ---- the readout
  var hud = root.DSPerfHud && typeof slx.echo === 'function' ?
    root.DSPerfHud.mount({ echo: slx.echo, connected: slx.connected, visible: false,
      zoom: typeof slx.layoutZoom === 'function' ? slx.layoutZoom() : 1 }) : null;
  var fps = 0;
  var fpsFrames = 0;
  var fpsLast = slx.now();
  var visible = false;

  // ---- the diag window
  var win = null;
  var base = { applyThrows: 0, wireErrors: 0 };
  var lastDiagAt = -Infinity;
  var lastFrameNow = null;
  var wasLagging = false;
  var lastBundleAt = null;

  function newWindow() {
    return { rtts: [], lagMs: 0, lagEntries: 0, maxGap: 0, maxChl: 0 };
  }
  win = newWindow();

  function stat(k) {
    var st = D.stats;
    var v = st ? st[k] : 0;
    return typeof v === 'number' && isFinite(v) && v >= 0 ? v : 0;
  }

  // Nearest-rank percentile of a list of whole milliseconds.
  function p95(list) {
    var a = list.slice().sort(function (x, y) { return x - y; });
    return a[Math.max(0, Math.ceil(0.95 * a.length) - 1)];
  }

  function report(lastClose) {
    var at = stat('applyThrows');
    var we = stat('wireErrors');
    var d = {
      applyThrows: Math.max(0, at - base.applyThrows),
      wireErrors: Math.max(0, we - base.wireErrors),
      fps: fps,
      lag: Math.round(win.lagMs),
      lagEntries: win.lagEntries,
      maxGapMs: Math.round(win.maxGap),
      maxOwnChl: Math.round(win.maxChl * 100) / 100
    };
    if (win.rtts.length) d.pongP95 = p95(win.rtts);
    if (lastClose) d.lastClose = lastClose.slice(0, NAME_MAX);
    if (!slx.send('sl:diag', d)) return null;
    base.applyThrows = at;
    base.wireErrors = we;
    win = newWindow();
    lastDiagAt = slx.now();
    return d;
  }

  // ---- how each socket ended (lastClose)
  var rec = null;                                // the newest socket's: {dead, cashed, refused, reason, closed}
  var curReason = '';
  var connectWhy = '';                           // the why of a refused handshake (slSockets admit: {why: 'limit'})

  function newRec() {
    return { dead: false, cashed: false, refused: '', reason: '', closed: false };
  }
  function closeName(r) {
    if (!r) return '';
    if (r.cashed) return 'cashed';
    if (r.dead) return 'dead';
    if (r.refused) return 'refused-' + r.refused;
    if (r.reason) return CLOSE_NAMES[r.reason] || 'other';
    return 'none';
  }

  if (typeof slx.onSocket === 'function') {
    slx.onSocket('disconnect', function (reason) { curReason = String(reason || ''); });
    slx.onSocket('connect_error', function (err) {
      curReason = 'connect_error';
      var d = err && err.data;
      connectWhy = d && typeof d.why === 'string' ? d.why : '';
    });
  }

  slx.on('open', function () {
    if (rec && !rec.closed) rec.reason = curReason;       // the previous socket ended on this page's own close
    var last = closeName(rec);
    rec = newRec();
    curReason = '';
    connectWhy = '';
    lastBundleAt = null;
    report(last);
  });
  slx.on('close', function (info) {
    var i = info || {};
    if (!i.opened || !rec) rec = newRec();                // a socket that never opened has its own record
    rec.closed = true;
    rec.reason = curReason;
    var why = typeof i.refused === 'string' ? i.refused : !i.opened ? connectWhy : '';
    if (/^[A-Za-z0-9_:-]*$/.test(why)) rec.refused = why;
    connectWhy = '';
    lastBundleAt = null;
  });
  slx.on('ownDead', function () { if (rec) rec.dead = true; });
  slx.on('x:cashed', function () { if (rec) rec.cashed = true; });

  slx.on('pong', function (rtt) {
    if (typeof rtt !== 'number' || !(rtt >= 0)) return;
    win.rtts.push(Math.round(rtt));
  });
  slx.on('frame', function () {
    var now = slx.now();
    if (lastBundleAt !== null && now - lastBundleAt > win.maxGap) win.maxGap = now - lastBundleAt;
    lastBundleAt = now;
  });

  // ---- every animation frame
  function frame() {
    var now = slx.now();
    fpsFrames++;
    if (now - fpsLast >= FPS_WINDOW_MS) {
      fps = Math.round(fpsFrames * 1000 / (now - fpsLast));
      fpsFrames = 0;
      fpsLast = now;
    }
    var dt = lastFrameNow === null ? 0 : now - lastFrameNow;
    lastFrameNow = now;
    var lagging = !!S.lagging;
    if (lagging) {
      if (!wasLagging) win.lagEntries++;
      win.lagMs += dt;
    }
    wasLagging = lagging;
    // Their own snake's chl, read only: beyond the 15.1 slither field list, as 12.2's maxOwnChl needs it.
    var me = S.slither;
    if (me && typeof me.chl === 'number' && me.chl > win.maxChl) win.maxChl = me.chl;
    var on = !!S.playing;
    if (on !== visible) {
      visible = on;
      if (hud) hud.show(on);
    }
    if (now - lastDiagAt >= DIAG_EVERY_MS && slx.connected()) report('');
    root.requestAnimationFrame(frame);
  }
  root.requestAnimationFrame(frame);

  slx.stats = {
    // For tests and the console: the shared readout, the diag's fps, the ping shown.
    hud: hud,
    fps: function () { return fps; },
    ping: function () { var p = hud && hud.ping(); return p == null ? '-- ms' : p + ' ms'; },
    closeName: function () { return closeName(rec); }
  };
})(typeof window !== 'undefined' ? window : globalThis);
