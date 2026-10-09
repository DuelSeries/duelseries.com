// Camera, zoom and steering target for the agar.io redo (client-camera-input spec sections 2, 3,
// 4.6, 5, 6 and 8.2-8.3). The reference client keeps the camera, the eased zoom and the wheel
// factor as doubles and eases them once per DRAWN frame with no delta time; this module does the
// same, with the same operation order, so the world transform matches theirs frame for frame.
//
// Pure state: no DOM, no timers, no randomness. agMain owns the frame and calls, in this order
// (spec section 3; the order is load-bearing):
//   cam.setCanvasSize(W, H)                 every frame, from canvas.width/height
//   if (!cam.ready) stop                    nothing below runs until the canvas has a real size
//   cam.frameGate(now, send)                target send gate, uses LAST frame's camera and scale
//   cam.clampWheel()                        uses LAST frame's draw scale
//   cam.stepZoom(ownCells)                  own sizes as last interpolated (before this frame's)
//   (agWorld interpolates the own cells at now)
//   cam.stepCamera(ownCells)                own positions as interpolated this frame
//   then: save; translate(cam.centreX(), cam.centreY()); scale(cam.scale, cam.scale);
//         translate(-cam.x, -cam.y)
// Message hooks: cam.setBorder(...) on every border message, cam.onSpawn(y) when the own-cell
// list goes from empty to one cell, cam.onSpectateCam(x, y, zoom) on a spectate camera message,
// cam.reset() on every (re)connect, cam.setMouse(x, y) from agInput's mouse copy, cam.wheel(n)
// from agInput's wheel. Own cells are objects with the displayed (interpolated, float32) fields
// x, y and size, in own-list order.
(function (root) {
  'use strict';
  var A = root.DuelAgarLib = root.DuelAgarLib || {};

  // Spec section 1 constants.
  var REF_W = 1920; // reference screen: draw scale = zoom * max(W / 1920, H / 1080)
  var REF_H = 1080;
  var ZOOM_REF_SUM = 64; // sum of own sizes at which the size zoom starts
  var ZOOM_EXP = 0.4;
  var WHEEL_STEP = 0.9; // wheel factor *= 0.9^n
  var WHEEL_MIN = 1;
  var WHEEL_MAX_NUM = 4; // upper clamp is 4 / previous draw scale
  var SPECT_ZOOM_MULT = 1.1; // while alive the no-cells zoom base tracks zoom * 1.1
  var TARGET_SEND_GAP_MS = 15; // frame-time gate: strictly more than 15 ms since the last check
  var INT_MIN = -2147483648;
  var TWO_31 = 2147483648;

  // The ease ratios (spec 5.1, 5.2, 6.3) and the half-lives they give, in drawn frames (spec 5.6).
  var EASE = { cameraAlive: 2 / 3, cameraNoCells: 29 / 30, zoom: 9 / 10 };
  var HALF_LIFE_FRAMES = {
    cameraAlive: Math.log(0.5) / Math.log(EASE.cameraAlive),
    cameraNoCells: Math.log(0.5) / Math.log(EASE.cameraNoCells),
    zoom: Math.log(0.5) / Math.log(EASE.zoom)
  };

  // Double to int32 with the reference's guard: truncate toward zero when |v| < 2^31, otherwise
  // the int32 minimum (spec 8.2). NaN fails the guard too.
  function truncGuard(v) {
    return Math.abs(v) < TWO_31 ? Math.trunc(v) | 0 : INT_MIN;
  }

  // max(W / 1920, H / 1080), both in canvas px (spec 6.4).
  // portrait (ours, Owen 2026-10-08, FIX-PLAN P4): a phone held upright plays the reference screen
  // turned on its side, the same formula with the two sides swapped, max(W / 1080, H / 1920), so
  // at zoom 1 the view is at most 1080 world units across and 1920 down. Never set at parity: the
  // divisions are the reference's own when it is false.
  function screenFactor(W, H, portrait) {
    var a = W / (portrait ? REF_H : REF_W);
    var b = H / (portrait ? REF_W : REF_H);
    return a > b ? a : b;
  }

  // Zoom target from own sizes alone (wheel 1): pow(min(64 / S, 1), 0.4); S = 0 gives 1 (spec 6.2).
  function sizeZoom(sum) {
    var q = ZOOM_REF_SUM / sum;
    return Math.pow(q > 1 ? 1 : q, ZOOM_EXP);
  }

  // World units visible across a W x H canvas at eased zoom z (spec 6.4; portrait as above).
  function visibleWorld(W, H, z, portrait) {
    var s = z * screenFactor(W, H, portrait);
    return { w: W / s, h: H / s };
  }

  function createCamera() {
    var cam = {
      // Camera (spec 2): position, draw scale, the point it eases toward.
      x: 0,
      y: 0,
      scale: 1,
      targetX: 0,
      targetY: 0,
      noCellsZoomBase: 1,
      zoom: 1, // eased zoom z
      zoomTarget: 1,
      wheelFactor: 1,
      firstFrame: true,
      // Canvas (canvas px).
      W: 0,
      H: 0,
      ready: false,
      // The phone portrait layout (screenFactor above). A page layout, not connection state, so
      // the reset below leaves it alone; agMain sets it.
      portrait: false,
      // Border as stored (normalised min/max), all 0 until the first border message.
      minX: 0,
      minY: 0,
      maxX: 0,
      maxY: 0,
      firstBorderSeen: false,
      // Steering: the mouse copy (canvas px, int32), the frame gate and the last sent target.
      mouseX: 0,
      mouseY: 0,
      lastTargetCheck: 0,
      lastSentX: 0,
      lastSentY: 0
    };

    // The whole-client reset that runs at start-up and on every reconnect (spec 2): camera, zoom,
    // wheel, mouse, the first-frame flag and the frame gate go back to their initial values. The
    // last sent target is NOT reset, so an unchanged target is still not resent after a reconnect.
    // The border and the first-border flag belong to the connection, so they reset too.
    cam.reset = function () {
      cam.x = 0;
      cam.y = 0;
      cam.scale = 1;
      cam.targetX = 0;
      cam.targetY = 0;
      cam.noCellsZoomBase = 1;
      cam.zoom = 1;
      cam.zoomTarget = 1;
      cam.wheelFactor = 1;
      cam.firstFrame = true;
      cam.mouseX = 0;
      cam.mouseY = 0;
      cam.lastTargetCheck = 0;
      cam.minX = 0;
      cam.minY = 0;
      cam.maxX = 0;
      cam.maxY = 0;
      cam.firstBorderSeen = false;
    };

    // Called with canvas.width/height at the start of every drawn frame. The canvas counts as ready
    // (once, for good) the first time it changes to a size where neither side is the HTML default
    // 300 x 150 (spec 7.2). Returns true when the size changed (the HUD layout must be rebuilt).
    cam.setCanvasSize = function (W, H) {
      if (W === cam.W && H === cam.H) return false;
      if (W !== 300 && H !== 150) cam.ready = true;
      cam.W = W;
      cam.H = H;
      return true;
    };

    // The phone portrait layout on or off (screenFactor). The draw scale follows on the next
    // stepZoom, as it does after a canvas resize.
    cam.setPortrait = function (on) {
      cam.portrait = !!on;
    };

    // Screen centre of the world transform: integer halves (spec 5.5).
    cam.centreX = function () {
      return Math.trunc(cam.W / 2);
    };
    cam.centreY = function () {
      return Math.trunc(cam.H / 2);
    };

    // Border message (spec 5.4). Each axis is normalised to min/max and stored. On the first
    // border of a connection the no-cells zoom base becomes 1 and the camera target the border
    // centre; with no own cells the camera also cuts there at draw scale 1. ownCount = number of
    // own cells at receipt.
    cam.setBorder = function (ax, ay, bx, by, ownCount) {
      var minX = ax < bx ? ax : bx;
      var maxX = ax < bx ? bx : ax;
      var minY = ay < by ? ay : by;
      var maxY = ay < by ? by : ay;
      cam.minX = minX;
      cam.minY = minY;
      cam.maxX = maxX;
      cam.maxY = maxY;
      if (cam.firstBorderSeen) return;
      cam.firstBorderSeen = true;
      cam.noCellsZoomBase = 1;
      cam.targetY = (minY + maxY) * 0.5;
      cam.targetX = (minX + maxX) * 0.5;
      if (!ownCount) {
        cam.scale = 1;
        cam.y = cam.targetY;
        cam.x = cam.targetX;
      }
    };

    // Spawn: the own-cell list went from empty to its first cell (spec 4.6, build brief fact 14).
    // Camera x goes to 0 (not the cell's x), camera y to the cell's displayed y, draw scale to 1.
    // The zoom, the camera target and the no-cells zoom base are left alone.
    cam.onSpawn = function (cellY) {
      cam.scale = 1;
      cam.y = cellY;
      cam.x = 0;
    };

    // Spectate camera message (spec 5.3): stored as the camera target and the no-cells zoom base;
    // the frame eases toward them. While own cells exist the frame overwrites all three.
    cam.onSpectateCam = function (x, y, zoom) {
      cam.targetX = x;
      cam.targetY = y;
      cam.noCellsZoomBase = zoom;
    };

    // Wheel input (spec 6.1): wheel factor = 0.9^n * factor, no clamp here.
    cam.wheel = function (n) {
      cam.wheelFactor = Math.pow(WHEEL_STEP, n) * cam.wheelFactor;
    };

    // Per frame, before the zoom (spec 6.1): at least 1, then at most 4 / the previous frame's
    // draw scale; the upper clamp wins when the two conflict.
    cam.clampWheel = function () {
      if (cam.wheelFactor < WHEEL_MIN) cam.wheelFactor = WHEEL_MIN;
      var hi = WHEEL_MAX_NUM / cam.scale;
      if (hi < cam.wheelFactor) cam.wheelFactor = hi;
    };

    // Zoom target, eased zoom and draw scale (spec 6.2-6.4). ownCells: sizes as last interpolated.
    cam.stepZoom = function (ownCells) {
      var n = ownCells ? ownCells.length : 0;
      var t;
      if (n) {
        var sum = 0;
        for (var i = 0; i < n; i++) sum = sum + ownCells[i].size;
        t = sizeZoom(sum) * cam.wheelFactor;
      } else {
        t = cam.noCellsZoomBase * cam.wheelFactor;
      }
      cam.zoomTarget = t;
      if (cam.firstFrame) {
        cam.firstFrame = false;
        cam.zoom = t;
        cam.noCellsZoomBase = t;
      } else {
        cam.zoom = (cam.zoom * 9 + t) / 10;
      }
      cam.scale = cam.zoom * screenFactor(cam.W, cam.H, cam.portrait);
      return cam.scale;
    };

    // Camera step (spec 5.1, 5.2). With own cells: plain average of their displayed positions,
    // eased 1/3 per frame, and the no-cells zoom base follows zoom * 1.1. Without: 1/30 per frame
    // toward whatever target was last written (death point, spectate point or border centre).
    cam.stepCamera = function (ownCells) {
      var n = ownCells ? ownCells.length : 0;
      if (n) {
        var sx = 0;
        var sy = 0;
        for (var i = 0; i < n; i++) {
          sy = sy + ownCells[i].y;
          sx = sx + ownCells[i].x;
        }
        cam.noCellsZoomBase = cam.zoom * SPECT_ZOOM_MULT;
        cam.targetY = sy / n;
        cam.targetX = sx / n;
        cam.x = (cam.x + cam.x + cam.targetX) / 3;
        cam.y = (cam.y + cam.y + cam.targetY) / 3;
        return;
      }
      cam.x = (cam.x * 29 + cam.targetX) / 30;
      cam.y = (cam.y * 29 + cam.targetY) / 30;
    };

    // Draw scale of the zoom TARGET (spec 6.4), read by the cell renderer.
    cam.targetScale = function () {
      return screenFactor(cam.W, cam.H, cam.portrait) * cam.zoomTarget;
    };

    // Integer world target for a canvas-px mouse point (spec 8.2): camera plus the offset from the
    // integer screen centre over the draw scale, truncated, then clamped to the truncated border.
    // Before the first border every bound is 0, so the target is (0, 0).
    cam.worldTarget = function (mx, my) {
      var s = cam.scale;
      var y = truncGuard(cam.y + (((my | 0) + (cam.H / -2 | 0)) | 0) / s);
      var lo = truncGuard(cam.minY);
      var hi = truncGuard(cam.maxY);
      y = y > lo ? y : lo;
      y = hi > y ? y : hi;
      var x = truncGuard(cam.x + (((mx | 0) + (cam.W / -2 | 0)) | 0) / s);
      lo = truncGuard(cam.minX);
      hi = truncGuard(cam.maxX);
      x = x > lo ? x : lo;
      x = hi > x ? x : hi;
      return { x: x, y: y };
    };

    // The mouse copy from the input layer, canvas px, stored as int32 like the reference's
    // integer mouse slot.
    cam.setMouse = function (x, y) {
      cam.mouseX = x | 0;
      cam.mouseY = y | 0;
    };

    // Send the target for the stored mouse when it differs from the last one sent (spec 8.2).
    // The last-sent pair is updated even when send drops the packet (socket not open).
    // send(x, y) is called with integers. Returns true when something was sent.
    cam.sendTarget = function (send) {
      var t = cam.worldTarget(cam.mouseX, cam.mouseY);
      if (t.x === cam.lastSentX && t.y === cam.lastSentY) return false;
      cam.lastSentY = t.y;
      cam.lastSentX = t.x;
      if (send) send(t.x, t.y);
      return true;
    };

    // The frame-loop send gate (spec 8.3): more than 15 ms of frame time since the last check.
    // Runs before this frame's camera and zoom update. Split and eject call sendTarget directly.
    cam.frameGate = function (now, send) {
      if (now - cam.lastTargetCheck > TARGET_SEND_GAP_MS) {
        cam.lastTargetCheck = now;
        return cam.sendTarget(send);
      }
      return false;
    };

    // Phone stick (CHOSEN, PARITY-LOG C7): the canvas-px point where the ray from the own cells'
    // on-screen average, along the unit stick direction (ux, uy), leaves the canvas. Fed to the
    // same mouse copy as a real mouse, so the world target sits at the edge of the visible area
    // in the stick direction and moves with the camera, as a still mouse would. With no own
    // cells the ray starts at the screen centre.
    cam.stickPoint = function (ownCells, ux, uy) {
      var n = ownCells ? ownCells.length : 0;
      var cx = cam.centreX();
      var cy = cam.centreY();
      var px = cx;
      var py = cy;
      if (n) {
        var sx = 0;
        var sy = 0;
        for (var i = 0; i < n; i++) {
          sx += ownCells[i].x;
          sy += ownCells[i].y;
        }
        px = cx + (sx / n - cam.x) * cam.scale;
        py = cy + (sy / n - cam.y) * cam.scale;
      }
      // Keep the start on the canvas so the ray always runs forward to an edge.
      px = px < 0 ? 0 : px > cam.W ? cam.W : px;
      py = py < 0 ? 0 : py > cam.H ? cam.H : py;
      var t = Infinity;
      if (ux > 0) t = Math.min(t, (cam.W - px) / ux);
      else if (ux < 0) t = Math.min(t, -px / ux);
      if (uy > 0) t = Math.min(t, (cam.H - py) / uy);
      else if (uy < 0) t = Math.min(t, -py / uy);
      if (!isFinite(t)) t = 0;
      return { x: px + ux * t, y: py + uy * t };
    };

    return cam;
  }

  A.agCamera = {
    createCamera: createCamera,
    sizeZoom: sizeZoom,
    screenFactor: screenFactor,
    visibleWorld: visibleWorld,
    truncGuard: truncGuard,
    EASE: EASE,
    HALF_LIFE_FRAMES: HALF_LIFE_FRAMES,
    TARGET_SEND_GAP_MS: TARGET_SEND_GAP_MS,
    REF_W: REF_W,
    REF_H: REF_H
  };
  if (typeof module === 'object' && module.exports) module.exports = A.agCamera;
})(typeof window !== 'undefined' ? window : globalThis);
