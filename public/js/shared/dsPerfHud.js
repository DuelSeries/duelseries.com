// The one ping and FPS readout every game shows (Owen 2026-10-27: "for every single game, I want the exact same ping
// and FPS count in every single game"). Same look, same spot, same measuring everywhere, PC and phone.
//
// Look: slither.io's line (public/js/slx/slxStats.js before this file): a coloured dot and "N ms", then "FPS N", in
// an 11 px monospace, on a faint dark capsule so it reads on a bright table or sky as well as a dark map. Bottom right
// corner, clear of the safe area, never takes a touch or a click.
//
// Ping: an app-level echo on the game's own socket ('ds:ping' with an acknowledgement, answered by server/perfEcho.js
// on every namespace). One every 2 s (the first three 500 ms apart), one in flight at a time. Shown: the median of the
// last three round trips, so one slow answer does not flash red but a real change shows within a few seconds. An
// answer more than 2 s late shows as the time it has waited (red) until it lands. Green under 50 ms, orange under
// 100 ms, red from 100 ms (slither's colours); a grey dot and "-- ms" while the socket is not connected.
//
// FPS: frames this page painted (requestAnimationFrame) in the last second, counted in two 500 ms halves, so the
// number updates twice a second. The text is written only when it changes and the box has a fixed size: no layout
// work, nothing that costs a frame.
//
// DSPerfHud.mount({ socket })   socket.io socket (or later via .use); shows the readout and starts measuring
// DSPerfHud.mount({ echo })     echo(done) sends one ping and calls done() on the answer; false when it cannot send
//          { zoom: n }          a page drawn at 1/n (slither's 0.7 page passes its own layout zoom, slx.layoutZoom)
//          .use(sourceOrSocket) a new socket or echo (a page that makes a new socket per match)
//          .show(on)            hide it while a game shows its own menu (default: shown)
//          .ping() -> ms|null   the number shown; .fps() -> the number shown; .element
(function (root) {
  'use strict';
  var doc = root.document;
  if (!doc || root.DSPerfHud) return;

  var PING_EVERY_MS = 2000;
  var PING_FIRST_MS = 500;           // the first three, so a number is up within a second or so
  var PING_KEEP = 3;                 // median of the last three
  var PING_LATE_MS = 2000;           // an answer this late shows as the time waited
  var PING_GIVE_UP_MS = 10000;       // then it is forgotten and a new one goes
  var PING_GREEN_MS = 50;            // slither's colours (public/js/game.js ping tracker)
  var PING_ORANGE_MS = 100;
  var FPS_HALF_MS = 500;
  var Z = 950;                       // over the games' canvases and HUDs, under the shared end card (1000) and dialogs

  var CSS = [
    '.dsp-hud{position:fixed;right:calc(8px + env(safe-area-inset-right,0px));bottom:calc(4px + env(safe-area-inset-bottom,0px));',
    'z-index:' + Z + ';display:flex;align-items:center;gap:10px;height:16px;padding:0 7px;box-sizing:border-box;',
    'border-radius:8px;background:rgba(8,12,16,.46);color:rgba(255,255,255,.8);pointer-events:none;user-select:none;',
    '-webkit-user-select:none;white-space:nowrap;font:11px/16px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;',
    'letter-spacing:.5px;font-variant-numeric:tabular-nums;contain:layout paint style;transform-origin:100% 100%;}',
    '.dsp-hud[hidden]{display:none;}',
    '.dsp-ping{display:flex;align-items:center;gap:4px;}',
    '.dsp-dot{width:7px;height:7px;border-radius:50%;flex:none;background:#8a929c;}',
    '.dsp-green{background:#22c55e;box-shadow:0 0 4px #22c55e88;}',
    '.dsp-orange{background:#f97316;box-shadow:0 0 4px #f9731688;}',
    '.dsp-red{background:#ef4444;box-shadow:0 0 4px #ef444488;}',
    '.dsp-ms{display:inline-block;min-width:6ch;}',
    '.dsp-fps{display:inline-block;min-width:7ch;}'
  ].join('');

  function now() { return root.performance && root.performance.now ? root.performance.now() : Date.now(); }

  function el(tag, cls, text) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // A page laid out below 1:1 would shrink the readout; it is drawn back up so it is the same size on the screen in
  // every game. The page says so (zoom), else a viewport line below 1 that the browser really applied (a phone; a
  // computer and a frame ignore the line).
  function autoZoom() {
    var m = doc.querySelector && doc.querySelector('meta[name="viewport"]');
    var c = m && m.getAttribute('content');
    var r = c && /initial-scale\s*=\s*([\d.]+)/.exec(c);
    var vv = root.visualViewport;
    if (!r || !(parseFloat(r[1]) < 1) || !vv || !(vv.scale > 0.2 && vv.scale < 0.99)) return 1;
    return 1 / vv.scale;
  }
  function setZoom(z) {
    if (!box) return;
    var n = typeof z === 'number' && z >= 1 && z < 5 ? z : autoZoom();
    box.style.transform = n !== 1 ? 'scale(' + n.toFixed(4) + ')' : '';
  }

  var box = null, dot = null, msText = null, fpsText = null;
  var shownMs = '', shownFps = '', shownDot = '';
  var wantShown = true;

  function build() {
    if (box) return;
    var style = el('style', null, CSS);
    style.setAttribute('data-ds', 'perf');
    (doc.head || doc.documentElement).appendChild(style);
    box = el('div', 'dsp-hud');
    box.setAttribute('aria-hidden', 'true');
    var ping = el('span', 'dsp-ping');
    dot = el('span', 'dsp-dot');
    msText = el('span', 'dsp-ms', '-- ms');
    ping.appendChild(dot);
    ping.appendChild(msText);
    fpsText = el('span', 'dsp-fps', 'FPS --');
    box.appendChild(ping);
    box.appendChild(fpsText);
    box.hidden = !wantShown;
    (doc.body || doc.documentElement).appendChild(box);
  }

  function setText(node, prev, next) {
    if (prev !== next) node.textContent = next;
    return next;
  }
  function setDot(cls) {
    if (cls === shownDot) return;
    shownDot = cls;
    dot.className = 'dsp-dot' + (cls ? ' ' + cls : '');
  }
  function colour(ms) {
    return ms < PING_GREEN_MS ? 'dsp-green' : ms < PING_ORANGE_MS ? 'dsp-orange' : 'dsp-red';
  }

  // ---- ping
  var echo = null;                   // function (done) -> bool sent
  var connected = function () { return true; };
  var samples = [];
  var sentAt = -1;                   // the one in flight (-1: none)
  var nextAt = 0;
  var gen = 0;                       // a new source or a drop forgets answers still on their way
  var pingMs = null;

  function median() {
    var a = samples.slice().sort(function (x, y) { return x - y; });
    return a[(a.length - 1) >> 1];
  }
  function showPing(ms, cls) {
    pingMs = ms;
    shownMs = setText(msText, shownMs, ms == null ? '-- ms' : ms + ' ms');
    setDot(ms == null ? '' : cls || colour(ms));
  }
  function forget() {
    samples = [];
    sentAt = -1;
    gen++;
    nextAt = 0;
    showPing(null);
  }

  function sourceOf(src) {
    if (!src) return null;
    if (typeof src === 'function') return { echo: src, connected: null };
    if (typeof src.echo === 'function') return { echo: src.echo, connected: src.connected || null };
    var sock = src.socket || src;
    if (!sock || typeof sock.emit !== 'function') return null;
    if (typeof sock.on === 'function') {
      // dropped and restored connections, for every game (public/js/shared/dsTrack.js)
      if (root.DSTrack && typeof root.DSTrack.watchSocket === 'function') { try { root.DSTrack.watchSocket(sock); } catch (e) { /* none */ } }
      sock.on('connect', function () { if (echo && echo.sock === sock) { forget(); } });
      sock.on('disconnect', function () { if (echo && echo.sock === sock) forget(); });
    }
    var fn = function (done) {
      if (!sock.connected) return false;
      sock.emit('ds:ping', done);
      return true;
    };
    fn.sock = sock;
    return { echo: fn, connected: function () { return !!sock.connected; } };
  }

  function use(src) {
    var s = sourceOf(src);
    echo = s ? s.echo : null;
    connected = s && s.connected ? s.connected : function () { return true; };
    forget();
  }

  function pingTick(t) {
    if (!echo) return;
    if (!connected()) {
      if (pingMs !== null || samples.length) forget();
      return;
    }
    if (sentAt >= 0) {
      var waited = t - sentAt;
      if (waited >= PING_GIVE_UP_MS) { sentAt = -1; gen++; }
      else {
        // in quarter seconds, so the text changes four times a second, not every frame
        if (waited >= PING_LATE_MS) showPing(Math.floor(waited / 250) * 250, 'dsp-red');
        return;
      }
    }
    if (t < nextAt) return;
    var g = gen;
    var at = t;
    var sent = false;
    try {
      sent = echo(function () {
        if (g !== gen) return;
        sentAt = -1;
        var rtt = now() - at;
        samples.push(rtt);
        if (samples.length > PING_KEEP) samples.shift();
        report({ ping: rtt });
        showPing(Math.round(median()));
      });
    } catch (e) { sent = false; }
    if (sent) {
      sentAt = at;
      nextAt = at + (samples.length < PING_KEEP - 1 ? PING_FIRST_MS : PING_EVERY_MS);
    } else {
      nextAt = at + PING_FIRST_MS;
    }
  }

  /* Each reading also goes to the game's FPS and ping summary (dsTrack.js: one game_perf per game, never per frame). */
  function report(o) {
    var T = root.DSTrack;
    if (T && typeof T.sample === 'function') { try { T.sample(o); } catch (e) { /* none */ } }
  }

  // ---- FPS
  var fps = null;
  var halfAt = -1, halfFrames = 0;   // this half
  var prevAt = -1, prevFrames = 0;   // the half before it

  function fpsTick(t) {
    if (halfAt < 0) { halfAt = t; return; }
    halfFrames++;
    var span = t - halfAt;
    if (span < FPS_HALF_MS) return;
    if (span > 4 * FPS_HALF_MS) {
      // the page was hidden or stalled: start counting again rather than average a pause in
      halfAt = t; halfFrames = 0; prevAt = -1; prevFrames = 0;
      return;
    }
    var from = prevAt >= 0 ? prevAt : halfAt;
    fps = Math.round((prevFrames + halfFrames) * 1000 / (t - from));
    shownFps = setText(fpsText, shownFps, 'FPS ' + fps);
    report({ fps: fps });
    prevAt = halfAt; prevFrames = halfFrames;
    halfAt = t; halfFrames = 0;
  }

  var running = false;
  function frame() {
    var t = now();
    fpsTick(t);
    pingTick(t);
    root.requestAnimationFrame(frame);
  }

  function mount(opts) {
    var o = opts || {};
    if (!doc.body) {
      doc.addEventListener('DOMContentLoaded', function () { mount(o); });
      return api;
    }
    build();
    if (o.zoom !== undefined || !box.style.transform) setZoom(o.zoom);
    if (o.socket || o.echo) use(o.echo ? { echo: o.echo, connected: o.connected } : o.socket);
    if (typeof o.visible === 'boolean') show(o.visible);
    if (!running && typeof root.requestAnimationFrame === 'function') {
      running = true;
      root.requestAnimationFrame(frame);
    }
    return api;
  }

  function show(on) {
    wantShown = on !== false;
    if (box) box.hidden = !wantShown;
  }

  var api = {
    mount: mount,
    use: use,
    show: show,
    ping: function () { return pingMs; },
    fps: function () { return fps; },
    get element() { return box; }
  };
  root.DSPerfHud = api;
})(typeof window !== 'undefined' ? window : globalThis);
