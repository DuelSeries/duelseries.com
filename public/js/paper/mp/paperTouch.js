// Paper multiplayer: touch steering and the heading arrow for the arena page (night queue item 7).
// It is the snake game's scheme (public/js/game.js, "Touch steering"): the stick is anchored
// where the thumb lands, the heading is the direction from that anchor to the thumb, the anchor
// is dragged along so it never sits more than FOLLOW_R behind the thumb, a thumb inside the
// dead zone asks for no turn, and lifting the thumb carries on the way the arrow was pointing.
// The arrow is the snake game's arrow in the ink the agar page uses on a light floor.
//
// How it reaches the game without touching the frozen solo modules: the stock InputController is
// built on withoutTouch(view), so it keeps its keyboard and mouse listeners but never hears a
// touch, and this module owns every touch on the canvas. It steers by writing the controller's
// mouse / lastMouse to a point far out from the view centre along the wanted heading, which is
// exactly what the stock readInput turns into game.direction (the point minus the view centre,
// normalised). The cash-out button is a sibling of the canvas, so a touch that starts on it
// never reaches these listeners and never steers; a steering thumb and a holding thumb are
// tracked apart by touch identifier.
// Loads standalone under require (tests).
(function (root, factory) {
  'use strict';
  var api = factory(root);
  var P = root.DuelPaperLib = root.DuelPaperLib || {};
  P.Touch = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var DEADZONE_PX = 10; // game.js TOUCH_DEADZONE_PX: below this the thumb has not asked for a turn
  var FOLLOW_R = 60; // game.js TOUCH_FOLLOW_R: the anchor is never left further behind than this
  // How far out the steering point sits. readInput measures it from the view centre at tick
  // time, so it has to dwarf any change of that centre (a phone turned mid-stroke).
  var FAR = 1e6;

  // The view as the stock InputController sees it: every listener but the touch ones.
  function withoutTouch(view) {
    function isTouch(type) {
      return String(type).slice(0, 5) === 'touch';
    }
    return {
      addEventListener: function (type, fn, opts) {
        if (!isTouch(type)) view.addEventListener(type, fn, opts);
      },
      removeEventListener: function (type, fn, opts) {
        if (!isTouch(type)) view.removeEventListener(type, fn, opts);
      }
    };
  }

  // opts: { view, controller, heading() -> {x, y} unit vector or null, arrow (element or null),
  //         ahead() -> px from the square's centre to the arrow's centre (optional),
  //         lift() -> px the square's drawn centre sits above the view centre (optional) }
  function create(opts) {
    var view = opts.view;
    var pad = opts.controller;
    var arrow = opts.arrow || null;
    var s = {
      id: null, // identifier of the steering touch; null: no thumb is steering
      ax: 0, // the anchor, client px
      ay: 0,
      shown: false,
      lastTransform: ''
    };

    function centre() {
      return { x: view.clientWidth / 2, y: view.clientHeight / 2 };
    }

    function steerAlong(ux, uy) {
      var c = centre();
      pad.mouse = { x: c.x + ux * FAR, y: c.y + uy * FAR };
    }

    // A fresh stick under the thumb that asks for no turn yet: keep the current heading.
    function grab(t) {
      s.id = t.identifier;
      s.ax = t.clientX;
      s.ay = t.clientY;
      var h = opts.heading();
      if (h && (h.x || h.y)) steerAlong(h.x, h.y);
      else pad.mouse = null;
    }

    function aim(t) {
      var dx = t.clientX - s.ax;
      var dy = t.clientY - s.ay;
      var d = Math.hypot(dx, dy);
      if (d > FOLLOW_R) {
        s.ax = t.clientX - (dx / d) * FOLLOW_R;
        s.ay = t.clientY - (dy / d) * FOLLOW_R;
        dx = t.clientX - s.ax;
        dy = t.clientY - s.ay;
        d = FOLLOW_R;
      }
      // Inside the dead zone the steering point is left alone, so the square holds its line.
      if (d > DEADZONE_PX) steerAlong(dx / d, dy / d);
    }

    function find(list, id) {
      for (var i = 0; i < list.length; i++) if (list[i].identifier === id) return list[i];
      return null;
    }

    function onStart(evt) {
      evt.preventDefault();
      // A steering touch the browser never ended (no touchend reached us) is let go.
      if (s.id !== null && evt.touches && !find(evt.touches, s.id)) s.id = null;
      if (s.id !== null) return; // a second finger on the canvas is not a second stick
      var t = evt.changedTouches[0];
      if (t) grab(t);
    }

    function onMove(evt) {
      evt.preventDefault();
      if (s.id === null) return;
      var t = find(evt.changedTouches, s.id);
      if (t) aim(t);
    }

    function onEnd(evt) {
      evt.preventDefault();
      if (s.id === null || !find(evt.changedTouches, s.id)) return;
      s.id = null;
      // Another thumb still down on the canvas takes over with a fresh stick. A finger on the
      // cash-out button started on the button, so it is never handed the wheel.
      var rest = evt.touches || [];
      for (var i = 0; i < rest.length; i++) {
        if (rest[i].target === view) {
          grab(rest[i]);
          return;
        }
      }
      // Thumb off the glass: carry on the way the arrow is pointing, as the stock pointer-gone
      // handler does (it keeps the last point in lastMouse).
      if (pad.mouse) pad.lastMouse = pad.mouse;
      pad.mouse = null;
    }

    var listeners = [
      ['touchstart', onStart],
      ['touchmove', onMove],
      ['touchend', onEnd],
      ['touchcancel', onEnd]
    ];
    listeners.forEach(function (pair) {
      view.addEventListener(pair[0], pair[1], { passive: false });
    });

    function hideArrow() {
      if (!s.shown) return;
      s.shown = false;
      arrow.style.opacity = '0';
    }

    // Once per drawn frame. Writes the arrow's style only when it changes, so a steady heading
    // costs a few comparisons. The square sits at the view centre: the camera follows it
    // exactly while it is alive.
    function drawArrow(live) {
      if (!arrow) return;
      var h = live && s.id !== null ? opts.heading() : null;
      if (!h || !(h.x || h.y)) {
        hideArrow();
        return;
      }
      var c = centre();
      var r = opts.ahead ? opts.ahead() : 46;
      var cy = c.y - (opts.lift ? opts.lift() : 0);
      var angle = Math.atan2(h.y, h.x);
      var tf = 'translate(-50%, -50%) translate(' + Math.round(c.x) + 'px, ' + Math.round(cy) + 'px) ' +
        'rotate(' + angle.toFixed(3) + 'rad) translateX(' + Math.round(r) + 'px)';
      if (tf !== s.lastTransform) {
        s.lastTransform = tf;
        arrow.style.transform = tf;
      }
      if (!s.shown) {
        s.shown = true;
        arrow.style.opacity = '1';
      }
    }

    function dispose() {
      listeners.forEach(function (pair) {
        view.removeEventListener(pair[0], pair[1], { passive: false });
      });
    }

    return {
      drawArrow: drawArrow,
      dispose: dispose,
      steering: function () {
        return s.id !== null;
      },
      anchor: function () {
        return { x: s.ax, y: s.ay };
      }
    };
  }

  return {
    withoutTouch: withoutTouch,
    create: create,
    DEADZONE_PX: DEADZONE_PX,
    FOLLOW_R: FOLLOW_R
  };
});
