// DuelSeries layer on the frozen slither.io client: hold Q to cash out, the phone hold button and the cash-out rings
// (SERVER-DESIGN 15.3; Owen Q15 and his 14:45 answer; task T18). Ours, not a parity area.
//
// Inert unless slxNet installed the production transport (15.2, finalize pass C20): no listener, no frame, no node.
//
// The server owns the hold (server/sl/slHold.js, slRoom.js): steering locked, the old speed ramp, no boost, the cash-out
// at C_HOLD_MS. This file only says when the player presses and lets go, and draws the rings the server announces.
// - Press: Q keydown that is not a key repeat (their onKeyDown handles only 37, 38, 39 and 32,
//   public/js/sl/slInput.js:173-184, so Q is free), or a touch on the phone hold button. One sl:hold {on: 1} per
//   press; the server keeps the hold until a release (it never times a press out while packets flow).
// - Release, sl:hold {on: 0}: Q keyup, the button's touchend or touchcancel, window blur, the tab going hidden, the own
//   death (slx 'ownDead'), the socket closing. sl:vis itself is slxNet's (one report per change, slxNet.js sendVis).
// - Rings: sl:x {t: 'hold', id, on: 1, need} starts a ring for snake id, {on: 0} ends it (server/sl/slRoom.js
//   _ringAll: the own seat and every seat holding that snake). Each frame a ring is drawn on one .slx-ring overlay
//   at that snake's head, only while the snake exists in their list; it fills over `need` ms from the message.
//
// Adds to DuelSlither.slx: hold = {held(), press(src), release(src), rings()}.
(function (root) {
  'use strict';
  var D = root.DuelSlither;
  if (!D || !D.slx || !D.slx.active) return;
  var slx = D.slx;
  var S = D.S;
  var doc = root.document;
  if (!S || !doc) return;

  var KEY_Q = 81;                                // keyCode of Q
  var PI2 = 2 * Math.PI;
  // Head radius in world units: their body is 29 x sc wide (public/js/sl/slDrawSnake.js:188, game.js:5422).
  var HEAD_HALF = 29 / 2;
  // The old game's ring around a cashing-out head (public/js/Renderer.js:1113-1138): radius 1.75 head radii, line
  // 0.28 head radii, a faint full track, then the green arc from the top, glowing 1.2 head radii except on phones.
  var RING_R = 1.75;
  var RING_LW = 0.28;
  var RING_GLOW = 1.2;
  var RING_TRACK = 'rgba(255,255,255,0.15)';
  var RING_COLOUR = '#14F195';
  // Between their game canvas (z-index 5) and their HUD (7), public/sl.html:18-24.
  var RING_Z = '6';

  // ---- hold state
  var held = false;
  var heldBy = null;                             // 'key' or 'button'

  function alive() {
    return !!(S.slither && S.connected && S.dead_mtm == -1);
  }

  function press(src) {
    if (held || !alive()) return false;
    held = true;
    heldBy = src;
    slx.send('sl:hold', { on: 1 });
    buttonLook();
    return true;
  }

  // A key or button release ends only the hold it started; blur, hidden, death and close end any hold.
  function release(src) {
    if (!held) return false;
    if ((src === 'key' || src === 'button') && src !== heldBy) return false;
    held = false;
    heldBy = null;
    slx.send('sl:hold', { on: 0 });
    buttonLook();
    return true;
  }

  // ---- Q
  function typing(e) {
    var t = e && e.target;
    var tag = t && typeof t.tagName === 'string' ? t.tagName.toUpperCase() : '';
    return tag === 'INPUT' || tag === 'TEXTAREA' || !!(t && t.isContentEditable);
  }
  function isQ(e) {
    return !!e && (e.keyCode === KEY_Q || e.which === KEY_Q) && !e.ctrlKey && !e.metaKey && !e.altKey;
  }
  doc.addEventListener('keydown', function (e) {
    if (!isQ(e) || e.repeat || typing(e)) return;
    press('key');
  });
  // The Q release is heard on the window in the CAPTURE phase (fixer pass, 2026-10-10): a text box that stops its key
  // events (the chat input T opens, slxChat; slxMain guard typing) would otherwise swallow it, and the hold would run
  // on to a cash-out with Q already let go. A Q keyup that ends no key hold does nothing.
  root.addEventListener('keyup', function (e) {
    if (!isQ(e)) return;
    release('key');
  }, true);
  root.addEventListener('blur', function () { release('blur'); });
  doc.addEventListener('visibilitychange', function () {
    if (doc.hidden === true || doc.visibilityState === 'hidden') release('hidden');
  });
  slx.on('ownDead', function () { release('death'); });
  slx.on('close', function () {
    release('close');
    rings = {};
  });
  slx.on('open', function () { rings = {}; });

  // ---- the phone hold button: the old mobile CASH OUT button (public/game.html:263, public/css/game.css:804-840,
  // wiring public/js/game.js:1686-1704): centred at the bottom, round, amber, pressed look while held.
  var button = null;
  var shown = false;
  function stop(e) { e.stopPropagation(); }
  if (S.is_mobile) {
    button = doc.createElement('button');
    button.type = 'button';
    button.className = 'slx-hold';
    button.setAttribute('aria-label', 'Hold to cash out');
    button.textContent = 'CASH OUT';
    var bs = button.style;
    bs.display = 'none';
    bs.alignItems = 'center';
    bs.justifyContent = 'center';
    bs.position = 'fixed';
    bs.bottom = 'calc(30px + env(safe-area-inset-bottom))';
    bs.left = '50%';
    bs.transform = 'translateX(-50%)';
    bs.zIndex = '9999';
    bs.width = '84px';
    bs.height = '84px';
    bs.borderRadius = '50%';
    bs.border = '2px solid rgba(240, 168, 48, 0.55)';
    bs.background = 'rgba(240, 168, 48, 0.14)';
    bs.color = '#f0a830';
    bs.fontFamily = "'Archivo', ui-sans-serif, system-ui, 'Segoe UI', Arial, sans-serif";
    bs.fontSize = '0.66rem';
    bs.fontWeight = '700';
    bs.letterSpacing = '0.06em';
    bs.textAlign = 'center';
    bs.lineHeight = '1.3';
    bs.padding = '0';
    bs.touchAction = 'none';
    bs.cursor = 'pointer';
    bs.transition = 'background 0.1s, transform 0.1s';
    // A layer control never reaches their window handlers (SERVER-DESIGN 15.1 rules): mousedown would boost
    // (slInput.js:148, 205), touches steer (:203-206). mouseup goes on: it only ends a boost (:207; fixer pass).
    var stops = ['mousedown', 'touchmove'];
    for (var i = 0; i < stops.length; i++) button.addEventListener(stops[i], stop);
    button.addEventListener('contextmenu', function (e) {
      e.stopPropagation();
      e.preventDefault();
    });
    button.addEventListener('touchstart', function (e) {
      e.stopPropagation();
      e.preventDefault();
      press('button');
    }, { passive: false });
    var up = function (e) {
      e.stopPropagation();
      if (e.cancelable !== false) e.preventDefault();
      release('button');
    };
    button.addEventListener('touchend', up, { passive: false });
    button.addEventListener('touchcancel', up, { passive: false });
    doc.body.appendChild(button);
  }
  function buttonLook() {
    if (!button) return;
    var on = held && heldBy === 'button';
    button.style.background = on ? 'rgba(240, 168, 48, 0.4)' : 'rgba(240, 168, 48, 0.14)';
    button.style.transform = on ? 'translateX(-50%) scale(0.94)' : 'translateX(-50%)';
  }

  // ---- rings
  var rings = {};                                // snake id -> {t0, need}
  slx.on('x:hold', function (m) {
    var id = m.id;
    if (typeof id !== 'number' || !(id >= 0) || Math.floor(id) !== id) return;
    if (m.on === 1 || m.on === true) {
      var need = m.need;
      if (typeof need !== 'number' || !(need > 0) || need === Infinity) return;
      // elapsed: a snake that came into view mid-hold arrives with the time it has held (server slRoom._ringOnView)
      var el = m.elapsed;
      var done = typeof el === 'number' && el > 0 && el !== Infinity ? (el < need ? el : need) : 0;
      rings[id] = { t0: slx.now() - done, need: need };
    } else if (m.on === 0 || m.on === false) {
      delete rings[id];
    }
  });

  var canvas = doc.createElement('canvas');
  canvas.className = 'slx-ring';
  var cs = canvas.style;
  cs.position = 'fixed';
  cs.left = '0px';
  cs.top = '0px';
  cs.pointerEvents = 'none';
  cs.zIndex = RING_Z;
  doc.body.appendChild(canvas);
  var ctx = canvas.getContext('2d');
  var drawn = false;                             // something is on the overlay now
  var cw = -1;
  var ch = -1;
  var cdpr = -1;

  // Their camera: the backing store maps world to screen as mww2 + (x - view_xx) * gsc (slDrawSnake.js:130); the
  // canvas sits at floor(ww / 2 - mww / 2) and is scaled by csc about its centre (public/js/sl/slPage.js:95-98).
  function screenX(wx) {
    return Math.floor(S.ww / 2 - S.mww / 2) + S.mww / 2 + (wx - S.view_xx) * S.gsc * S.csc;
  }
  function screenY(wy) {
    return Math.floor(S.hh / 2 - S.mhh / 2) + S.mhh / 2 + (wy - S.view_yy) * S.gsc * S.csc;
  }

  function findSnake(id) {
    var list = S.slithers;
    if (!list) return null;
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return list[i];
    return null;
  }

  function fit() {
    var w = root.innerWidth;
    var h = root.innerHeight;
    var dpr = root.devicePixelRatio > 0 ? root.devicePixelRatio : 1;
    if (w === cw && h === ch && dpr === cdpr) return;
    cw = w;
    ch = h;
    cdpr = dpr;
    cs.width = w + 'px';
    cs.height = h + 'px';
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    drawn = false;                               // a size write clears the bitmap
  }

  function drawRings() {
    var ids = Object.keys(rings);
    if (!ids.length && !drawn) return;
    fit();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawn = false;
    var k = S.gsc * S.csc;
    if (!ids.length || !(k > 0)) return;
    ctx.setTransform(cdpr, 0, 0, cdpr, 0, 0);
    var t = slx.now();
    for (var i = 0; i < ids.length; i++) {
      var id = Number(ids[i]);
      var r = rings[id];
      var o = findSnake(id);
      if (!o || o.dead) continue;
      var hr = HEAD_HALF * o.sc * k;
      var x = screenX(o.xx + (o.fx || 0));
      var y = screenY(o.yy + (o.fy || 0));
      var p = Math.min(Math.max((t - r.t0) / r.need, 0), 1);
      ctx.save();
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(x, y, hr * RING_R, 0, PI2);
      ctx.strokeStyle = RING_TRACK;
      ctx.lineWidth = hr * RING_LW;
      ctx.stroke();
      if (p > 0) {
        if (!S.is_mobile) {
          ctx.shadowColor = RING_COLOUR;
          ctx.shadowBlur = hr * RING_GLOW;
        }
        ctx.beginPath();
        ctx.arc(x, y, hr * RING_R, -Math.PI / 2, -Math.PI / 2 + p * PI2);
        ctx.strokeStyle = RING_COLOUR;
        ctx.lineWidth = hr * RING_LW;
        ctx.stroke();
      }
      ctx.restore();
      drawn = true;
    }
  }

  function frame() {
    root.requestAnimationFrame(frame);
    try {
      if (held && !alive()) release('death');
      if (button) {
        var want = alive();
        if (want !== shown) {
          shown = want;
          button.style.display = want ? 'flex' : 'none';
        }
      }
      drawRings();
    } catch (e) {
      slx.errors = (slx.errors || 0) + 1;
    }
  }
  root.requestAnimationFrame(frame);

  slx.hold = {
    held: function () { return held; },
    press: press,
    release: release,
    rings: function () { return Object.keys(rings).map(Number); }
  };
})(typeof window !== 'undefined' ? window : globalThis);
