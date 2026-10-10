// slither.io redo: input and the outbound play packets (build brief section 11 "slInput", spec
// loop-page-input.md section 6, outbound shapes brief 6.5).
//
// Rules this module keeps:
// - Handlers are their event-handler properties, assigned their way (window.onmousemove, oncontextmenu,
//   ontouchmove, ontouchstart, onmousedown, ontouchend, a "mouseup" listener, document.onkeydown/onkeyup).
//   No other window property is added, and no wheel, blur, visibility or WASD handler exists in theirs.
// - Mouse and touch positions are CSS px from the centre of the play area (S.ww / 2, S.hh / 2 from slPage).
// - Sends are abstract events handed to slNet.send at call time: {type: 'turn', dir, v}, {type: 'ping'},
//   {type: 'boost', on}, {type: 'angle', q}. Within one frame oef calls them in the order TURN, PING
//   (step 9) then BOOST, ANGLE (step 12).
// - Time is read with slLoop.now() at the same sites they read timeObj.now(); the send steps use the
//   frame's ctm that oef passes in, like theirs.
// - Their scratch globals (ang, sang, d2, v) are locals here; none of them is logged.
// - Every gate keeps their exact comparison (> 50, > 250, > 33, > 256, < 24, < 400).
(function (root) {
  'use strict';
  var D = root.DuelSlither = root.DuelSlither || {};

  var PI2 = 2 * Math.PI;   // game.js:125
  var ARROW_GATE = 50;     // game.js:4501, ms between 252 turn packets
  var ARROW_MAX = 127;     // game.js:4514, 4529, most ticks in one turn packet
  var PING_GATE = 250;     // game.js:4545, ms between pings
  var BOOST_GATE = 50;     // game.js:4697, ms between boost packets
  var ANGLE_GATE = 33;     // game.js:4715, ms between angle attempts
  var DEAD_ZONE2 = 256;    // game.js:4721, 16 CSS px squared
  var ANGLE_STEPS = 251;   // game.js:4728, written (250 + 1) there
  var TOUCH_SUPPRESS = 1500; // game.js:6965, 6987, mouse ignored this long after a touch
  var TAP_DIST = 24;       // game.js:7001, double tap distance in each axis
  var TAP_TIME = 400;      // game.js:7002, double tap time

  var S = null;

  function st() {
    return S || D.S;
  }

  function now() {
    return D.slLoop.now();
  }

  function send(ev) {
    D.slNet.send(ev);
  }

  // State at load (game.js:1827-1830, 3939-3942, 3962-3963, 3987-3992, 6982-6985). wfpr is slApply's.
  function initInputState(state) {
    S = state;
    S.xm = 0;
    S.ym = 0;
    S.lsxm = 0;
    S.lsym = 0;
    S.lsang = 0;
    S.want_e = false;
    S.last_e_mtm = 0;
    S.last_accel_mtm = 0;
    S.kd_l = false;
    S.kd_r = false;
    S.kd_u = false;          // set and cleared by the keys, never read (theirs too)
    S.kd_l_frb = 0;
    S.kd_r_frb = 0;
    S.lkstm = 0;
    S.last_ping_mtm = 0;
    S.lpstm = 0;
    S.dmutm = 0;
    S.ltchx = -1;
    S.ltchy = -1;
    S.ltchmtm = -1;
  }

  // game.js:6956-6958
  function setAcceleration(mode) {
    var s = st();
    if (s.slither != null) s.slither.wmd = mode == 1;
  }

  // game.js:6942-6954. Not gated by slither: the position is tracked on the menu too.
  // follow_view is always true, so their off-view correction never runs.
  function onMouseMove(e) {
    e = e || root.event;
    if (e && typeof e.clientX != 'undefined') {
      var s = st();
      s.xm = e.clientX - s.ww / 2;
      s.ym = e.clientY - s.hh / 2;
    }
  }

  // game.js:6959-6963
  function onContextMenu(e) {
    e.preventDefault();
    e.stopPropagation();
    return false;
  }

  // game.js:6964-6980. No preventDefault here (theirs has none).
  // Owen Q9 may change this (layered in a separate file)
  function onTouchMove(e) {
    var s = st();
    s.dmutm = now() + TOUCH_SUPPRESS;
    if (s.slither != null) {
      e = e || root.event;
      if (e) {
        var t = e.touches[0];
        if (typeof t.clientX != 'undefined') {
          s.xm = t.clientX - s.ww / 2;
          s.ym = t.clientY - s.hh / 2;
        } else {
          s.xm = t.pageX - s.ww / 2;
          s.ym = t.pageY - s.hh / 2;
        }
      }
    }
  }

  // game.js:6986-7011. A second tap within 24 px in x and y and under 400 ms turns boost on.
  // Owen Q9 may change this (layered in a separate file)
  function onTouchStart(e) {
    var s = st();
    s.dmutm = now() + TOUCH_SUPPRESS;
    if (s.slither != null) {
      e = e || root.event;
      if (e) {
        var tx, ty;
        var t = e.touches[0];
        if (typeof t.clientX != 'undefined') {
          tx = t.clientX - s.ww / 2;
          ty = t.clientY - s.hh / 2;
        } else {
          tx = t.pageX - s.ww / 2;
          ty = t.pageY - s.hh / 2;
        }
        var mtm = now();
        if (Math.abs(tx - s.ltchx) < TAP_DIST && Math.abs(ty - s.ltchy) < TAP_DIST && mtm - s.ltchmtm < TAP_TIME) {
          setAcceleration(1);
        }
        s.ltchx = tx;
        s.ltchy = ty;
        s.ltchmtm = mtm;
        s.xm = tx;
        s.ym = ty;
      }
      e.preventDefault();
    }
  }

  // game.js:7012-7021. Any button. Ignored until 1500 ms after the last touch.
  // It calls whatever window.onmousemove holds, as theirs does (game.js:7016).
  function onMouseDown(e) {
    var s = st();
    if (s.dmutm == 0 || now() > s.dmutm) {
      s.dmutm = 0;
      if (s.slither != null) {
        root.onmousemove(e);
        setAcceleration(1);
        e.preventDefault();
      }
    }
  }

  // game.js:7022-7024, any finger lift
  function onTouchEnd() {
    setAcceleration(0);
  }

  // game.js:7026-7029 (their window.onmouseup at 690 belongs to the menu buttons, OUT)
  function onMouseUp() {
    setAcceleration(0);
  }

  // game.js:10061-10103. Left 37, right 39, up 38 or space 32. No preventDefault (Space is not blocked).
  // Enter (13, 10) presses their Play button when not connecting or connected: menu, OUT here.
  // Owen Q11 and Q18 may change this (layered in a separate file)
  function onKeyDown(e) {
    e = e || root.event;
    var s = st();
    var code = e.keyCode;
    if (code == 37) s.kd_l = true;
    else if (code == 39) s.kd_r = true;
    else if (code == 38 || code == 32) {
      s.kd_u = true;
      setAcceleration(1);
    }
    // digits, Backspace, Enter, Shift, Esc: enter-code, server chooser, Play, testing (OUT)
  }

  // game.js:10104-10114
  function onKeyUp(e) {
    e = e || root.event;
    var s = st();
    var code = e.keyCode;
    if (code == 37) s.kd_l = false;
    else if (code == 39) s.kd_r = false;
    else if (code == 38 || code == 32) {
      s.kd_u = false;
      setAcceleration(0);
    }
  }

  // Their load-time handler assignments, in their order (game.js:6942-7029, then 10061-10114).
  function install() {
    root.onmousemove = onMouseMove;
    root.oncontextmenu = onContextMenu;
    root.ontouchmove = onTouchMove;
    root.ontouchstart = onTouchStart;
    root.onmousedown = onMouseDown;
    root.ontouchend = onTouchEnd;
    root.addEventListener('mouseup', onMouseUp);
    root.document.onkeydown = onKeyDown;
    root.document.onkeyup = onKeyUp;
  }

  // oef step 2 (game.js:4037-4041): held arrows collect whole 8 ms ticks.
  function accumulateArrowTicks() {
    var s = st();
    if (s.connected && s.slither != null) {
      if (s.kd_l) s.kd_l_frb += s.vfrb;
      if (s.kd_r) s.kd_r_frb += s.vfrb;
    }
  }

  // oef step 9a (game.js:4498-4543), inside "if (connected)". Equal counts do not cancel: left goes first.
  // The eang nudge is overwritten later in the same frame by stepBoostAndAngle (game.js:4713).
  function stepArrowKeys(ctm) {
    var s = st();
    if (!s.connected) return;
    var o = s.slither;
    if (o != null && (s.kd_l_frb > 0 || s.kd_r_frb > 0) && ctm - s.lkstm > ARROW_GATE) {
      s.lkstm = ctm;
      if (s.kd_r_frb > 0 && s.kd_l_frb > s.kd_r_frb) {
        s.kd_l_frb -= s.kd_r_frb;
        s.kd_r_frb = 0;
      }
      if (s.kd_l_frb > 0 && s.kd_r_frb > s.kd_l_frb) {
        s.kd_r_frb -= s.kd_l_frb;
        s.kd_l_frb = 0;
      }
      var v;
      if (s.kd_l_frb > 0) {
        v = s.kd_l_frb;
        if (v > ARROW_MAX) v = ARROW_MAX;
        s.kd_l_frb -= v;
        o.eang -= s.mamu * v * o.scang * o.spang;
        send({ type: 'turn', dir: 'left', v: v });   // their byte form [252, v]
      } else if (s.kd_r_frb > 0) {
        v = s.kd_r_frb;
        if (v > ARROW_MAX) v = ARROW_MAX;
        s.kd_r_frb -= v;
        o.eang += s.mamu * v * o.scang * o.spang;
        send({ type: 'turn', dir: 'right', v: v });  // their byte form [252, v + 128]
      }
    }
  }

  // oef step 9b (game.js:4544-4553), inside "if (connected)". The pong (slApply) clears wfpr.
  // An unanswered ping is what slLoop turns into lag mode after 750 ms.
  // Owen Q24 may change this (layered in a separate file)
  function stepPing(ctm) {
    var s = st();
    if (!s.connected) return;
    if (!s.wfpr && ctm - s.last_ping_mtm > PING_GATE) {
      s.last_ping_mtm = ctm;
      s.wfpr = true;
      send({ type: 'ping' });   // their byte form [251]
      s.lpstm = ctm;
    }
  }

  // oef step 12 (game.js:4696-4751), whenever there is an own snake (connected or not).
  function stepBoostAndAngle(ctm) {
    var s = st();
    var o = s.slither;
    if (o == null) return;
    if (o.md != o.wmd && ctm - s.last_accel_mtm > BOOST_GATE) {
      o.md = o.wmd;
      s.last_accel_mtm = ctm;
      send({ type: 'boost', on: o.md });   // their byte form [253] on, [254] off
    }
    if (s.xm != s.lsxm || s.ym != s.lsym) s.want_e = true;
    o.eang = Math.atan2(s.ym, s.xm);   // every frame, not normalised
    if (s.want_e && ctm - s.last_e_mtm > ANGLE_GATE) {
      // the gate is spent by every attempt, sent or not (game.js:4717 before the test at 4729)
      s.want_e = false;
      s.last_e_mtm = ctm;
      s.lsxm = s.xm;
      s.lsym = s.ym;
      var ang;
      var d2 = s.xm * s.xm + s.ym * s.ym;
      if (d2 > DEAD_ZONE2) {
        ang = Math.atan2(s.ym, s.xm);
        o.eang = ang;
      } else {
        ang = o.wang;   // inside the dead zone the server's last wang is re-sent, quantised
      }
      ang %= PI2;
      if (ang < 0) ang += PI2;
      var sang = Math.floor(ANGLE_STEPS * ang / PI2);
      // lsang starts at 0 and is never reset, so a first angle in bucket 0 is not sent (game.js:1827)
      if (sang != s.lsang) {
        s.lsang = sang;
        s.lpstm = ctm;
        send({ type: 'angle', q: sang & 255 });   // their byte form [sang & 255] (game.js:4732)
      }
    }
  }

  D.slInput = {
    initInputState: initInputState,
    install: install,
    setAcceleration: setAcceleration,
    accumulateArrowTicks: accumulateArrowTicks,
    stepArrowKeys: stepArrowKeys,
    stepPing: stepPing,
    stepBoostAndAngle: stepBoostAndAngle
  };
})(typeof window !== 'undefined' ? window : globalThis);
