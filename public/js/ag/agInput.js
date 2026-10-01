// Input for the agar.io redo (client-camera-input spec section 8, build brief 9.2 "agInput.js",
// Owen's Q7 phone controls). Desktop input follows the reference client exactly: the canvas mouse
// is copied to the game at most every > 25 ms of engine time while in game, Space / W / Q send one
// action per physical press (auto-repeat and held keys do nothing), Esc opens the menu without
// pausing, the wheel feeds the camera's wheel factor. The phone stick and the Split / Eject
// buttons are ours (CHOSEN, PARITY-LOG C7): slither's anchor-and-follow stick (dead zone 10 px,
// follow radius 60 px, public/js/game.js "Touch steering") whose direction becomes a target at
// the edge of the visible area (agCamera.stickPoint).
//
// attachInput(canvas, sink, opts) wires the listeners and returns a controller. agMain calls
// controller.frame(edgeFn) once per animation frame BEFORE the game frame (the reference copies
// the mouse in its app layer's frame handler, which runs ahead of the game's own frame).
//   sink: { mouse(x, y), split(), eject(), q(), menu(), zoom(n) }, every member optional.
//     mouse gets canvas px (the game stores them as int32: agCamera.setMouse).
//     split / eject: agMain flushes the target first (agCamera.sendTarget), then sends the
//     action on every press with no client minimum, then checks the sound cue helpers below.
//     zoom(n): agCamera.wheel(n).
//   opts: { win, doc, canvasScale() (canvas px per CSS px; default 1), engineNow() (integer
//     ms; default new Date().getTime(), the clock the reference app layer uses), splitButton,
//     ejectButton (elements; optional), touchFirst (bool; default: coarse primary pointer),
//     firefox (bool; default: user agent test) }
(function (root) {
  'use strict';
  var A = root.DuelAgarLib = root.DuelAgarLib || {};

  var MOUSE_SYNC_GAP_MS = 25; // the mouse copy needs strictly more than 25 ms since the last one
  var KEY_SPLIT = 32; // Space
  var KEY_EJECT = 87; // W
  var KEY_Q = 81; // Q
  var KEY_ESC = 27;
  var KEY_BACKSLASH = 220; // the reference opens a debug dialog here; out of scope, key still eaten
  // Phone stick (CHOSEN, slither's numbers).
  var STICK_DEADZONE_PX = 10; // below this the thumb has not asked for a direction
  var STICK_FOLLOW_R = 60; // the anchor is never left further behind than this
  // Sound cue gates (spec 8.5, 8.6; build brief fact 9).
  var SPLIT_SOUND_MAX_CELLS = 15;
  var SPLIT_SOUND_MIN_SIZE = 60; // strictly above
  var EJECT_SOUND_MIN_SIZE_SQ = 3612.5; // strictly above, size squared as a double

  // Wheel notches for one legacy wheel event, the reference's own rule: wheelDelta / -120, else
  // the Firefox detail, else 0 (spec 6.1). Up (positive wheelDelta) gives n < 0: zoom in.
  function legacyWheelSteps(e) {
    return e.wheelDelta / -120 || e.detail || 0;
  }

  // Standard `wheel` event, used only where neither legacy event exists. CHOSEN mapping
  // (PARITY-LOG CCI-U6): a legacy wheelDelta when the browser still provides one, otherwise
  // deltaY in notches: 100 px, 3 lines or 1 page per notch.
  function standardWheelSteps(e) {
    var legacy = e.wheelDelta / -120;
    if (legacy) return legacy;
    var d = +e.deltaY || 0;
    if (e.deltaMode === 1) return d / 3;
    if (e.deltaMode === 2) return d;
    return d / 100;
  }

  // Split sound cue: 1 to 15 own cells and some displayed size above 60.
  function splitSoundDue(ownCells) {
    var n = ownCells ? ownCells.length : 0;
    if (n < 1 || n > SPLIT_SOUND_MAX_CELLS) return false;
    for (var i = 0; i < n; i++) if (ownCells[i].size > SPLIT_SOUND_MIN_SIZE) return true;
    return false;
  }

  // Eject sound cue: some own displayed size with size * size above 3612.5.
  function ejectSoundDue(ownCells) {
    var n = ownCells ? ownCells.length : 0;
    for (var i = 0; i < n; i++) {
      var s = ownCells[i].size;
      if (s * s > EJECT_SOUND_MIN_SIZE_SQ) return true;
    }
    return false;
  }

  // The anchor-and-follow stick, DOM free. down(x, y) starts a fresh stick under the thumb (no new
  // direction yet), move(x, y) drags the anchor along once the thumb is more than 60 px away and
  // sets the direction once it is more than 10 px away. The last direction is kept after the
  // thumb lifts, so the cells carry on the way they were going.
  function createStick() {
    var st = { ax: 0, ay: 0, dir: null };
    st.down = function (x, y) {
      st.ax = x;
      st.ay = y;
    };
    st.move = function (x, y) {
      var dx = x - st.ax;
      var dy = y - st.ay;
      var d = Math.hypot(dx, dy);
      if (d > STICK_FOLLOW_R) {
        st.ax = x - (dx / d) * STICK_FOLLOW_R;
        st.ay = y - (dy / d) * STICK_FOLLOW_R;
        dx = x - st.ax;
        dy = y - st.ay;
        d = Math.hypot(dx, dy);
      }
      if (d > STICK_DEADZONE_PX) st.dir = { x: dx / d, y: dy / d };
    };
    st.clear = function () {
      st.dir = null;
    };
    return st;
  }

  function isCoarse(win) {
    try {
      return !!(win.matchMedia && win.matchMedia('(pointer: coarse)').matches);
    } catch (err) {
      return false;
    }
  }

  function attachInput(canvas, sink, opts) {
    opts = opts || {};
    sink = sink || {};
    var win = opts.win || root;
    var doc = opts.doc || win.document;
    var scaleOf = opts.canvasScale || function () { return 1; };
    var engineNow = opts.engineNow || function () { return new Date().getTime(); };
    var firefox = opts.firefox != null ? !!opts.firefox
      : !!(win.navigator && /firefox/i.test(win.navigator.userAgent || ''));
    var listeners = [];
    function on(target, type, fn, o) {
      if (!target || !target.addEventListener) return;
      target.addEventListener(type, fn, o);
      listeners.push([target, type, fn, o]);
    }
    function call(name, a, b) {
      if (typeof sink[name] === 'function') sink[name](a, b);
    }

    var s = {
      inGame: false,
      lastSync: 0,
      mouseX: null, // CSS px of the last canvas mousemove; null until the first one
      mouseY: null,
      keysDown: {}, // one map for the page lifetime
      keysOn: false,
      touchMode: opts.touchFirst != null ? !!opts.touchFirst : isCoarse(win),
      touchId: null
    };
    var stick = createStick();

    // Mouse: only moves over the canvas itself reach the game. A real mouse also takes steering
    // back from the stick.
    on(canvas, 'mousemove', function (e) {
      s.mouseX = e.clientX;
      s.mouseY = e.clientY;
      if (s.touchMode && s.touchId === null) {
        s.touchMode = false;
        stick.clear();
      }
    });

    // Wheel: registered for the page lifetime, active in menus too, no preventDefault. The same
    // registration rule as the reference: Firefox's DOMMouseScroll, else the body's mousewheel;
    // the standard wheel event only where neither exists.
    var body = doc && doc.body;
    function onLegacyWheel(e) {
      call('zoom', legacyWheelSteps(e));
    }
    if (firefox) on(doc, 'DOMMouseScroll', onLegacyWheel, false);
    else if (body && 'onmousewheel' in body) on(body, 'mousewheel', onLegacyWheel);
    else on(body || doc, 'wheel', function (e) { call('zoom', standardWheelSteps(e)); });

    // Keys, installed when a game or spectate first starts (enableKeys) and never removed.
    function onKeyDown(e) {
      var k = e.keyCode;
      if (s.keysDown[k]) return;
      s.keysDown[k] = true;
      if (k === KEY_SPLIT) call('split');
      else if (k === KEY_EJECT) call('eject');
      else if (k === KEY_Q) call('q');
      else if (k === KEY_ESC) {
        if (e.preventDefault) e.preventDefault();
        call('menu');
      } else if (k === KEY_BACKSLASH) {
        if (e.preventDefault) e.preventDefault();
      }
    }
    function onKeyUp(e) {
      // Releasing Q sends nothing: the reference's release check never matches (spec 8.7).
      s.keysDown[e.keyCode] = false;
    }

    // Phone stick on the canvas: the first finger down steers; other fingers are ignored.
    function findTouch(list, id) {
      if (!list) return null;
      for (var i = 0; i < list.length; i++) if (list[i].identifier === id) return list[i];
      return null;
    }
    on(canvas, 'touchstart', function (e) {
      if (e.cancelable && e.preventDefault) e.preventDefault();
      s.touchMode = true;
      if (s.touchId !== null && e.touches && !findTouch(e.touches, s.touchId)) s.touchId = null;
      if (s.touchId !== null) return;
      var t = e.changedTouches && e.changedTouches[0];
      if (!t) return;
      s.touchId = t.identifier;
      stick.down(t.clientX, t.clientY);
    }, { passive: false });
    on(canvas, 'touchmove', function (e) {
      if (e.cancelable && e.preventDefault) e.preventDefault();
      if (s.touchId === null) return;
      var t = findTouch(e.changedTouches, s.touchId);
      if (t) stick.move(t.clientX, t.clientY);
    }, { passive: false });
    function onTouchEnd(e) {
      if (e.cancelable && e.preventDefault) e.preventDefault();
      if (s.touchId === null || !findTouch(e.changedTouches, s.touchId)) return;
      s.touchId = null; // the direction is kept: the cells carry on
    }
    on(canvas, 'touchend', onTouchEnd, { passive: false });
    on(canvas, 'touchcancel', onTouchEnd, { passive: false });

    // Split and Eject buttons: one action per press, the same actions as Space and W.
    function wireButton(el, action) {
      if (!el) return;
      on(el, 'pointerdown', function (e) {
        if (e.preventDefault) e.preventDefault();
        if (e.stopPropagation) e.stopPropagation();
        call(action);
      });
      // No emulated mouse events, no double-tap zoom, no steering from a button press.
      on(el, 'touchstart', function (e) {
        if (e.cancelable && e.preventDefault) e.preventDefault();
        if (e.stopPropagation) e.stopPropagation();
      }, { passive: false });
    }
    wireButton(opts.splitButton, 'split');
    wireButton(opts.ejectButton, 'eject');

    var ctl = {};
    ctl.setInGame = function (v) {
      s.inGame = !!v;
    };
    ctl.enableKeys = function () {
      if (s.keysOn) return;
      s.keysOn = true;
      on(win, 'keydown', onKeyDown);
      on(win, 'keyup', onKeyUp);
    };
    // The mouse copy, once per animation frame ahead of the game frame. While in game and more
    // than 25 ms of engine time after the last copy, the game gets the mouse in canvas px (a
    // mouse that never moved over the canvas counts as 0, 0). In stick mode it gets
    // edgeFn(ux, uy) instead, the canvas px point for the stick direction; with no direction
    // yet edgeFn(0, 0), the own cells' own position, so a phone player stands still until the
    // thumb asks for a direction.
    ctl.frame = function (edgeFn) {
      if (!s.inGame) return false;
      var now = engineNow();
      if (!(now - s.lastSync > MOUSE_SYNC_GAP_MS)) return false;
      s.lastSync = now;
      if (s.touchMode && typeof edgeFn === 'function') {
        var d = stick.dir;
        var p = edgeFn(d ? d.x : 0, d ? d.y : 0);
        call('mouse', p.x, p.y);
      } else {
        var k = scaleOf();
        call('mouse', s.mouseX * k, s.mouseY * k);
      }
      return true;
    };
    ctl.stickDir = function () {
      return stick.dir ? { x: stick.dir.x, y: stick.dir.y } : null;
    };
    ctl.touchMode = function () {
      return s.touchMode;
    };
    ctl.state = s;
    ctl.dispose = function () {
      for (var i = 0; i < listeners.length; i++) {
        var l = listeners[i];
        l[0].removeEventListener(l[1], l[2], l[3]);
      }
      listeners.length = 0;
      s.keysOn = false;
    };
    return ctl;
  }

  A.agInput = {
    attachInput: attachInput,
    createStick: createStick,
    legacyWheelSteps: legacyWheelSteps,
    standardWheelSteps: standardWheelSteps,
    splitSoundDue: splitSoundDue,
    ejectSoundDue: ejectSoundDue,
    MOUSE_SYNC_GAP_MS: MOUSE_SYNC_GAP_MS,
    STICK_DEADZONE_PX: STICK_DEADZONE_PX,
    STICK_FOLLOW_R: STICK_FOLLOW_R
  };
  if (typeof module === 'object' && module.exports) module.exports = A.agInput;
})(typeof window !== 'undefined' ? window : globalThis);
