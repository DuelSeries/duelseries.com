(function (root) {
  'use strict';
  var P = root.DuelPaperLib = root.DuelPaperLib || {};

  // Key codes that steer. Arrow keys and WASD share a flag each.
  var STEER_KEYS = {
    38: 'up', 87: 'up',
    40: 'down', 83: 'down',
    37: 'left', 65: 'left',
    39: 'right', 68: 'right'
  };

  // Collects keyboard, mouse and touch state. It never steers anything itself:
  // Game.readInput polls pressed(), up/down/left/right, mouse and lastMouse once per tick.
  class InputController {
    constructor(view) {
      this.up = false;
      this.down = false;
      this.left = false;
      this.right = false;
      this.mouse = null;
      this.lastMouse = null;

      var self = this;

      var onKeyDown = function (evt) { self.onKeyChange(evt, true); };
      var onKeyUp = function (evt) { self.onKeyChange(evt, false); };
      root.addEventListener('keydown', onKeyDown, false);
      root.addEventListener('keyup', onKeyUp, false);

      var onContextMenu = function (evt) { evt.preventDefault(); };
      view.addEventListener('contextmenu', onContextMenu, false);

      // Pointer gone: remember where it was so the unit keeps heading that way.
      var onPointerGone = function (evt) {
        self.lastMouse = self.mouse;
        self.mouse = null;
        evt.preventDefault();
      };
      // Mouse positions are page coordinates (touch uses client coordinates below).
      var onMouseMove = function (evt) {
        if (self.mouse === null) {
          self.mouse = {};
        }
        self.mouse.x = evt.pageX;
        self.mouse.y = evt.pageY;
        evt.preventDefault();
      };
      // No touch identifier tracking: the first changed touch of the event wins.
      var onTouchPoint = function (evt) {
        if (self.mouse === null) {
          self.mouse = {};
        }
        var touch = evt.changedTouches[0];
        self.mouse.x = touch.clientX;
        self.mouse.y = touch.clientY;
        evt.preventDefault();
      };

      var viewListeners = [
        ['contextmenu', onContextMenu],
        ['mouseenter', onMouseMove],
        ['mousemove', onMouseMove],
        ['mouseleave', onPointerGone],
        ['touchstart', onTouchPoint],
        ['touchmove', onTouchPoint],
        ['touchend', onPointerGone],
        ['touchcancel', onPointerGone]
      ];
      viewListeners.slice(1).forEach(function (pair) {
        view.addEventListener(pair[0], pair[1], false);
      });

      this.dispose = function () {
        root.removeEventListener('keydown', onKeyDown, false);
        root.removeEventListener('keyup', onKeyUp, false);
        viewListeners.forEach(function (pair) {
          view.removeEventListener(pair[0], pair[1], false);
        });
      };
    }

    pressed() {
      return this.up || this.down || this.left || this.right;
    }

    onKeyChange(evt, isDown) {
      // Keys typed while anything other than the page body has focus are ignored.
      if (evt.target !== root.document.body) {
        return;
      }
      var flag = STEER_KEYS[evt.keyCode];
      if (flag) {
        this[flag] = isDown;
        evt.preventDefault();
      }
    }
  }

  P.InputController = InputController;
})(typeof window !== 'undefined' ? window : globalThis);
