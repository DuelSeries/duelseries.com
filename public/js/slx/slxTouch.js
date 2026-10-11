// DuelSeries layer on the frozen slither.io client: the phone thumb stick, heading arrow and both boost gestures
// (SERVER-DESIGN 15.3 "Phones"; Owen Q9 and the 17:00 answer "both"; task T18). Ours, not a parity area.
// Phones only (their own test, S.is_mobile, public/js/sl/slMain.js:59). Computers keep their handlers exactly.
// The computer look on phones (Q8, S.render_mode 2) is written once by slxMain before any Play.
//
// Inert unless slxNet installed the production transport (15.2, finalize pass C20).
//
// How it sits on their client: touchstart, touchmove, touchend and touchcancel listeners on window in the CAPTURE
// phase (passive: false) run before anything else. A game touch is taken here: preventDefault (so no compatibility
// mouse event fires) and stopPropagation (so their window.ontouch* properties, public/js/sl/slInput.js:203-206, never
// see it). A touch that starts on a layer control (any element with an slx- class, or inside one) is left alone for
// that control. With no own snake the touch is left alone too, as their handlers then do nothing but note the time.
//
// Steering is the old game's anchored stick (public/js/game.js:1011-1087): the anchor is where the steering finger
// lands, a turn is asked once the finger is more than 10 px from it, the anchor follows to stay at most 60 px behind,
// and on lift the snake carries on along its real heading (game.js:1644-1656). The stick angle goes to their own
// pipeline as the pointer 100 px from the centre along that angle (SERVER-DESIGN 15.3; outside their 16 px dead zone,
// slInput.js:26), so their stepBoostAndAngle quantises, gates and sends the byte as it does for a mouse.
// Boost, both gestures (Owen 17:00), through their setAcceleration (slInput.js:72-75):
// - a second finger held down (the old game, game.js:1063-1072), and
// - their double tap: a steering finger landing within 24 px in x and in y and under 400 ms after the last one
//   (slInput.js:29-30, 133), held while that finger stays down.
// Heading arrow: the old element and transform (public/game.html:266-272, public/css/game.css:729-741,
// public/js/game.js:1668-1682) at the own head while a finger steers.
//
// Adds to DuelSlither.slx: touch = {steering(), boosting(), state()}.
(function (root) {
  'use strict';
  var D = root.DuelSlither;
  if (!D || !D.slx || !D.slx.active) return;
  var slx = D.slx;
  var S = D.S;
  var doc = root.document;
  if (!S || !S.is_mobile || !doc || !D.slInput || typeof D.slInput.setAcceleration !== 'function') return;

  var DEAD_ZONE = 10;                            // public/js/game.js:1012 TOUCH_DEADZONE_PX
  var FOLLOW_R = 60;                             // public/js/game.js:1013 TOUCH_FOLLOW_R
  var STICK_PX = 100;                            // SERVER-DESIGN 15.3: the pointer this far from the centre
  var TAP_DIST = 24;                             // their double tap, public/js/sl/slInput.js:29
  var TAP_TIME = 400;                            // slInput.js:30
  var ARROW_AHEAD = 46;                          // public/js/game.js:1681 translateX(46px)

  // ---- touch state
  var own = {};                                  // identifier -> true for every touch this file took
  var ownCount = 0;
  var steerId = null;                            // the steering finger
  var anchorX = 0;
  var anchorY = 0;
  var lastTap = null;                            // {x, y, t} of the last steering finger's landing
  var tapBoost = false;                          // a double tap boosts while its finger stays down
  var boosting = false;
  var life = S.slither;

  function isControl(el) {
    for (var n = 0; el && n < 64; n++) {
      if (el === doc || el === root) return false;
      var c = typeof el.className === 'string' ? el.className
        : el.getAttribute ? el.getAttribute('class') || '' : '';
      if (/(^|\s)slx-/.test(c)) return true;
      el = el.parentNode;
    }
    return false;
  }

  function setBoost() {
    var want = tapBoost || ownCount >= 2;
    if (want === boosting) return;
    boosting = want;
    D.slInput.setAcceleration(want ? 1 : 0);
  }

  function point(ang) {
    S.xm = STICK_PX * Math.cos(ang);
    S.ym = STICK_PX * Math.sin(ang);
  }

  // The old updateTouchAim (game.js:1048-1061): the dead zone is judged on the distance before the anchor follows.
  function aim(x, y) {
    var dx = x - anchorX;
    var dy = y - anchorY;
    var d = Math.sqrt(dx * dx + dy * dy);
    if (d > FOLLOW_R) {
      anchorX = x - dx / d * FOLLOW_R;
      anchorY = y - dy / d * FOLLOW_R;
      dx = x - anchorX;
      dy = y - anchorY;
    }
    if (d > DEAD_ZONE) point(Math.atan2(dy, dx));
  }

  function startSteer(t) {
    steerId = t.identifier;
    anchorX = t.clientX;
    anchorY = t.clientY;
  }

  function find(list, id) {
    if (!list) return null;
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].identifier === id) return list[i];
    return null;
  }

  // Fingers the page lost without a touchend (a missed cancel) are forgotten whenever a new touch starts.
  function prune(touches) {
    if (!touches) return;
    for (var k in own) {
      if (!find(touches, Number(k))) {
        delete own[k];
        ownCount--;
        if (Number(k) === steerId) {
          steerId = null;
          tapBoost = false;
        }
      }
    }
  }

  function reset() {
    steerId = null;
    tapBoost = false;
    lastTap = null;
    own = {};
    ownCount = 0;
    if (boosting) {
      boosting = false;
      D.slInput.setAcceleration(0);
    }
  }

  function take(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  function onStart(e) {
    if (S.slither == null || isControl(e.target)) return;
    take(e);
    prune(e.touches);
    var ch = e.changedTouches || [];
    for (var i = 0; i < ch.length; i++) {
      var t = ch[i];
      if (own[t.identifier]) continue;
      own[t.identifier] = true;
      ownCount++;
      if (steerId === null) {
        startSteer(t);
        // their double tap rule, compared in each axis (slInput.js:133)
        var tm = slx.now();
        if (lastTap && Math.abs(t.clientX - lastTap.x) < TAP_DIST && Math.abs(t.clientY - lastTap.y) < TAP_DIST &&
            tm - lastTap.t < TAP_TIME) {
          tapBoost = true;
        }
        lastTap = { x: t.clientX, y: t.clientY, t: tm };
      }
    }
    setBoost();
  }

  function onMove(e) {
    if (!ownCount) return;
    var ch = e.changedTouches || [];
    var mine = false;
    for (var i = 0; i < ch.length; i++) if (own[ch[i].identifier]) mine = true;
    if (!mine) return;
    take(e);
    if (S.slither == null || steerId === null) return;
    var t = find(ch, steerId);
    if (t) aim(t.clientX, t.clientY);
  }

  function onEnd(e) {
    if (!ownCount) return;
    var ch = e.changedTouches || [];
    var mine = false;
    var lifted = false;
    for (var i = 0; i < ch.length; i++) {
      var id = ch[i].identifier;
      if (!own[id]) continue;
      mine = true;
      delete own[id];
      ownCount--;
      if (id === steerId) {
        steerId = null;
        tapBoost = false;
        lifted = true;
      }
    }
    if (!mine) return;
    take(e);
    if (lifted) {
      // carry on the way the snake is going, not toward where the finger left the glass (game.js:1644-1656)
      if (S.slither && typeof S.slither.ang === 'number') point(S.slither.ang);
      // another own finger still down takes over the steering, from where it is now
      for (var k in own) {
        var t = find(e.touches, Number(k));
        if (t) {
          startSteer(t);
          break;
        }
      }
    }
    setBoost();
  }

  var opts = { capture: true, passive: false };
  root.addEventListener('touchstart', onStart, opts);
  root.addEventListener('touchmove', onMove, opts);
  root.addEventListener('touchend', onEnd, opts);
  root.addEventListener('touchcancel', onEnd, opts);

  // ---- the heading arrow
  var arrow = doc.createElement('div');
  arrow.className = 'slx-arrow';
  arrow.setAttribute('aria-hidden', 'true');
  arrow.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M2 12 h13 M15 12 l-5 -5 M15 12 l-5 5" ' +
    'fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var as = arrow.style;
  as.position = 'fixed';
  as.top = '0px';
  as.left = '0px';
  as.zIndex = '40';
  as.color = 'rgba(245, 241, 232, 0.85)';
  as.filter = 'drop-shadow(0 0 6px rgba(0,0,0,0.7))';
  as.pointerEvents = 'none';
  as.opacity = '0';
  as.transition = 'opacity 0.12s linear';
  as.willChange = 'transform';
  doc.body.appendChild(arrow);

  // Their camera, as slxHold: world to backing store mww2 + (x - view_xx) * gsc (public/js/sl/slDrawSnake.js:130),
  // the canvas at floor(ww / 2 - mww / 2) scaled by csc about its centre (public/js/sl/slPage.js:95-98).
  function arrowFrame() {
    var o = S.slither;
    var k = S.gsc * S.csc;
    if (steerId === null || !o || !S.connected || S.dead_mtm != -1 || !(k > 0)) {
      if (as.opacity !== '0') as.opacity = '0';
      return;
    }
    var x = Math.floor(S.ww / 2 - S.mww / 2) + S.mww / 2 + (o.xx + (o.fx || 0) - S.view_xx) * k;
    var y = Math.floor(S.hh / 2 - S.mhh / 2) + S.mhh / 2 + (o.yy + (o.fy || 0) - S.view_yy) * k;
    as.opacity = '1';
    // centring first, in screen space (game.js:1663-1682)
    as.transform = 'translate(-50%, -50%) translate(' + x + 'px, ' + y + 'px) rotate(' + o.ang + 'rad) translateX(' +
      ARROW_AHEAD + 'px)';
  }

  function frame() {
    root.requestAnimationFrame(frame);
    try {
      if (S.slither !== life) {                  // a new life (or none): no boost or stick carried over
        life = S.slither;
        reset();
      }
      arrowFrame();
    } catch (e) {
      slx.errors = (slx.errors || 0) + 1;
    }
  }
  root.requestAnimationFrame(frame);

  slx.touch = {
    steering: function () { return steerId !== null; },
    boosting: function () { return boosting; },
    state: function () {
      return { own: ownCount, steerId: steerId, anchorX: anchorX, anchorY: anchorY, tapBoost: tapBoost, boosting: boosting };
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
