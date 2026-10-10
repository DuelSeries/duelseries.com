// slLoop: the one game loop of the slither redo. Written from the reference-side spec
// loop-page-input.md sections 1 to 4 and the build brief (sections 8, 10.4, 10.5, 11). It owns:
// - oef(): one call per animation frame from page load, in their exact step order: timing and lag,
//   connect request, quality fades, the HUD fade hook, the deferred socket close, the connected
//   block (arrow turn, ping, border ring, minimap fades), the own dot, the 1 s auto quality
//   window, boost and angle, then every snake, prey and food, then redraw;
// - redrawPrologue(): the start of every redraw (fps count, zoom step, camera ring step, view,
//   cull boxes), called first by slDrawWorld.redraw();
// - onSocketOpen(): the quality reset when the game socket opens;
// - the p12 table and the loop's own globals on DuelSlither.S (their names, so one state logger
//   reads both clients).
// Rates matter: the lag ramp, tsp easing, zoom and camera steps run once per frame or per redraw,
// motion and fades scale by vfr, rings step by whole 8 ms ticks (vfrb). At 144 or 240 Hz the
// per-frame rules run faster, exactly like theirs (spec 4.17). Do not "fix" that.
// Other modules are looked up on DuelSlither at call time, never captured.
(function (root) {
  'use strict';
  var D = root.DuelSlither = root.DuelSlither || {};

  var PI2 = 2 * Math.PI;   // game.js:123
  var LFC = 53;            // length ring, game.js:1855, 1861
  var HFC = 53;            // body point ring, game.js:1882
  var RFC = 53;            // head ring and prey ring, game.js:1867
  var AFC = 26;            // head angle ring, game.js:1888
  var VFC = 62;            // camera ring, game.js:1896
  var FLXC = 56;           // border ring, game.js:1801

  var bound = null;        // the S handed to initLoopState, used only if DuelSlither.S is not set yet
  function st() {
    return D.S || bound;
  }

  // Their timeObj (game.js:84-91): performance.now() when it exists, else Date. Read at the same
  // call sites as theirs, never the rAF timestamp.
  function now() {
    var p = root.performance;
    if (p && typeof p.now === 'function') return p.now();
    return Date.now();
  }

  // want_quality is read once at load from their storage key "qual" (game.js:9124-9133).
  // Owen Q19 may change this (layered in a separate file).
  function readWantQuality() {
    var q = 1;
    try {
      if (root.localStorage.qual == '0') q = 0;
    } catch (e) { /* storage blocked: keep 1 */ }
    return q;
  }

  // Load values of the keys slLoop owns (the brief 10.3 and section 11 list; slApply sets the
  // shared keys such as gsc, lag_mult, view_xx, fvxs before this runs).
  function initLoopState(S) {
    bound = S;
    // timing, game.js:3950-3959
    S.fr = 0;
    S.lfr = 0;
    S.ltm = api.now();
    S.vfr = 0;
    S.vfrb = 0;
    S.avfr = 0;
    S.afr = 0;
    S.fr2 = 0;
    S.lfr2 = 0;
    S.vfrb2 = 0;
    // quality, game.js:3971-3975
    S.high_quality = true;
    S.gla = 1;
    S.wdfg = 0;
    S.qsm = 1;
    S.mqsm = 1.7;
    // view, game.js:3935-3936
    S.view_ang = 0;
    S.view_dist = 0;
    // cull boxes, declared without a value (game.js:1784-1786)
    S.bpx1 = undefined; S.bpy1 = undefined; S.bpx2 = undefined; S.bpy2 = undefined;
    S.fpx1 = undefined; S.fpy1 = undefined; S.fpx2 = undefined; S.fpy2 = undefined;
    S.apx1 = undefined; S.apy1 = undefined; S.apx2 = undefined; S.apy2 = undefined;
    S.animating = false;            // game.js:129, start() sets it
    S.want_play = false;            // game.js:1207
    S.fgfr = 0;                     // game.js:5121, never written again
    S.fps = 0;                      // game.js:5151
    S.lrd_mtm = api.now();          // game.js:7076
    S.want_quality = readWantQuality();
  }

  // p12 (game.js:1837-1842): a Float32Array built by iteration, the running value kept in float64.
  // Never 1 - .88^n.
  function buildTables(S) {
    S = S || st();
    var table = new Float32Array(250);
    var acc = 0;
    for (var i = 0; i < 250; i++) {
      table[i] = acc;
      acc += (1 - acc) * .12;
    }
    S.p12 = table;
    return table;
  }

  // Their startAnimation at page load (game.js:129-136, 6941). The setInterval fallback for
  // browsers without requestAnimationFrame is not built.
  function start() {
    var S = st();
    S.animating = true;
    root.requestAnimationFrame(oef);
  }

  // ------------------------------------------------------------------ small helpers

  // Angle helpers with their exact arithmetic (game.js:4790-4796): wrap into [0, 2pi), and the
  // signed gap from a to w folded into (-pi, pi].
  function wrapAngle(a) {
    if (a < 0 || a >= PI2) a %= PI2;
    if (a < 0) a += PI2;
    return a;
  }
  function angleGap(w, a) {
    var v = (w - a) % PI2;
    if (v < 0) v += PI2;
    if (v > Math.PI) v -= PI2;
    return v;
  }

  // Moves v toward target by step without passing it: an upward pass, then a downward pass.
  function approach(v, target, step) {
    if (v < target) {
      v += step;
      if (v >= target) v = target;
    }
    if (v > target) {
      v -= step;
      if (v <= target) v = target;
    }
    return v;
  }

  // Ring slots to play this frame: the whole 8 ms ticks, but never more than are queued.
  function ticksFor(queued, ticks) {
    return ticks > queued ? queued : ticks;
  }

  // The ring position after `pos`, wrapping to 0 at `size`.
  function nextSlot(pos, size) {
    pos++;
    return pos >= size ? 0 : pos;
  }

  // Spawn-in size of food and prey from its 0..1 progress: a cosine ease, pulled .66 of the way toward
  // a second cosine ease of itself (game.js:5038-5039, 5078-5079).
  function spawnSize(progress) {
    var r = .5 * (1 - Math.cos(Math.PI * progress));
    return r + (.5 * (1 - Math.cos(Math.PI * r)) - r) * .66;
  }

  // Turn toward wang by turnStep (snakes game.js:4788-4810, prey 4995-5017: same rule).
  // A dir that is absent (snake right after its add) or 0 snaps to wang and is left as it is.
  function steer(t, turnStep) {
    if (t.dir == 1) {
      t.ang = wrapAngle(t.ang - turnStep);
      if (angleGap(t.wang, t.ang) > 0) {
        t.ang = t.wang;
        t.dir = 0;
      }
    } else if (t.dir == 2) {
      t.ang = wrapAngle(t.ang + turnStep);
      if (angleGap(t.wang, t.ang) < 0) {
        t.ang = t.wang;
        t.dir = 0;
      }
    } else {
      t.ang = t.wang;
    }
  }

  // ------------------------------------------------------------------ snakes (game.js:4755-4968)

  // The boost speed shown (tsp) chases sp once PER FRAME: 10 percent of the gap going up, 30 percent
  // going down, plus a 1E-4 nudge, never overshooting (game.js:4760-4768).
  function easeShownSpeed(shown, real) {
    if (shown == real) return shown;
    var rising = shown < real;
    shown += (real - shown) * (rising ? .1 : .3);
    shown += rising ? 1E-4 : -1E-4;
    if (rising ? shown > real : shown < real) shown = real;
    return shown;
  }

  // Length ring (game.js:4770-4784): plays queued length offsets into fl, zeroing each slot played.
  // An empty queue clears fl once. Runs even on a frame with 0 ticks.
  function playLengthRing(o, ticks) {
    if (o.fltg > 0) {
      var take = ticksFor(o.fltg, ticks);
      o.fltg -= take;
      for (var t = 0; t < take; t++) {
        var at = o.flpos;
        o.fl = o.fls[at];
        o.fls[at] = 0;
        o.flpos = nextSlot(at, LFC);
      }
    } else if (o.fltg == 0) {
      o.fltg = -1;
      o.fl = 0;
    }
  }

  // Dying points fade by .0015 per tick; counted from the head, a finished one from the 4th dying point
  // on is spliced out and pooled (game.js:4861-4878).
  function fadeDyingPoints(S, pts, ticks) {
    var seen = 0;
    for (var i = pts.length - 1; i >= 0; i--) {
      var p = pts[i];
      if (!p.dying) continue;
      seen++;
      p.da += .0015 * ticks;
      if (!(p.da >= 1)) continue;
      p.da = 1;
      if (seen >= 4) {
        pts.splice(i, 1);
        p.dying = false;
        S.points_dp.add(p);
      }
    }
  }

  // Body point ring (game.js:4879-4905): four channels (x, y, ltn, smu offsets) played together.
  function playPointRing(p, ticks) {
    if (p.ftg > 0) {
      var take = ticksFor(p.ftg, ticks);
      p.ftg -= take;
      for (var t = 0; t < take; t++) {
        var at = p.fpos;
        p.fx = p.fxs[at];
        p.fy = p.fys[at];
        p.fltn = p.fltns[at];
        p.fsmu = p.fsmus[at];
        p.fxs[at] = 0;
        p.fys[at] = 0;
        p.fltns[at] = 0;
        p.fsmus[at] = 0;
        p.fpos = nextSlot(at, HFC);
      }
    } else if (p.ftg == 0) {
      p.ftg = -1;
      p.fx = 0;
      p.fy = 0;
      p.fltn = 0;
      p.fsmu = 0;
    }
  }

  // Head ring (game.js:4926-4946): x, y and head length offsets.
  function playHeadRing(o, ticks) {
    if (o.ftg > 0) {
      var take = ticksFor(o.ftg, ticks);
      o.ftg -= take;
      for (var t = 0; t < take; t++) {
        var at = o.fpos;
        o.fx = o.fxs[at];
        o.fy = o.fys[at];
        o.fchl = o.fchls[at];
        o.fxs[at] = 0;
        o.fys[at] = 0;
        o.fchls[at] = 0;
        o.fpos = nextSlot(at, RFC);
      }
    } else if (o.ftg == 0) {
      o.ftg = -1;
      o.fx = 0;
      o.fy = 0;
      o.fchl = 0;
    }
  }

  // Head angle ring (game.js:4947-4960).
  function playAngleRing(o, ticks) {
    if (o.fatg > 0) {
      var take = ticksFor(o.fatg, ticks);
      o.fatg -= take;
      for (var t = 0; t < take; t++) {
        var at = o.fapos;
        o.fa = o.fas[at];
        o.fas[at] = 0;
        o.fapos = nextSlot(at, AFC);
      }
    } else if (o.fatg == 0) {
      o.fatg = -1;
      o.fa = 0;
    }
  }

  // render_mode 1 aims the eyes from the head-most body point (pts run tail first, so the last one) plus its eye
  // offset still easing out; raw atan2, not wrapped (game.js:4815-4818). In render_mode 2 the draw pass sets wehang.
  function lineModeEyeTarget(o) {
    var front = o.pts[o.pts.length - 1];
    var dy = o.yy + o.fy - front.yy - front.fy + front.eby * (1 - o.ehl);
    var dx = o.xx + o.fx - front.xx - front.fx + front.ebx * (1 - o.ehl);
    return Math.atan2(dy, dx);
  }

  // One snake per frame. Returns true when it must be removed.
  function stepSnake(S, o, vfr, vfrb) {
    var turnStep = S.mamu * vfr * o.scang * o.spang;
    var move = o.sp * vfr / 4;
    if (move > o.msl) move = o.msl;

    if (!o.dead) {
      o.tsp = easeShownSpeed(o.tsp, o.sp);
      if (o.tsp > o.fsp) o.sfr += (o.tsp - o.fsp) * vfr * .021;   // game.js:4769
      playLengthRing(o, vfrb);
      // the drawn length is .6 shorter in render_mode 2 (game.js:4785-4786)
      o.cfl = S.render_mode == 1 ? o.tl + o.fl : o.tl + o.fl - .6;
    }

    // dead snakes keep turning (quirk kept)
    steer(o, turnStep);

    if (o.ehl != 1) {
      o.ehl += .03 * vfr;
      if (o.ehl >= 1) o.ehl = 1;
    }
    if (S.render_mode == 1) o.wehang = lineModeEyeTarget(o);
    // eye turn direction, first write of o.edir; a gap of exactly 0 leaves it (game.js:4819-4825)
    if (!o.dead && o.ehang != o.wehang) {
      var g = angleGap(o.wehang, o.ehang);
      if (g < 0) o.edir = 1;
      else if (g > 0) o.edir = 2;
    }
    // eye chase by p12[vfrb], not gated by dead (game.js:4826-4854)
    if (o.edir == 1 || o.edir == 2) {
      o.ehang = wrapAngle(o.ehang + angleGap(o.wehang, o.ehang) * S.p12[vfrb]);
      var left = angleGap(o.wehang, o.ehang);
      if (o.edir == 1 ? left > 0 : left < 0) {
        o.ehang = o.wehang;
        o.edir = 0;
      }
    }

    if (!o.dead) {
      // head moves along ang; the head part grows by the same distance in points
      o.xx += Math.cos(o.ang) * move;
      o.yy += Math.sin(o.ang) * move;
      o.chl += move / o.msl;
    }

    var pts = o.pts;
    if (vfrb > 0) {
      fadeDyingPoints(S, pts, vfrb);
      for (var i = pts.length - 1; i >= 0; i--) playPointRing(pts[i], vfrb);
    }

    // pupils chase their target every frame, each axis up then down (game.js:4907-4924)
    var lookX = Math.cos(o.eang) * o.pma;
    var lookY = Math.sin(o.eang) * o.pma;
    o.rex = approach(o.rex, lookX, vfr / 6);
    o.rey = approach(o.rey, lookY, vfr / 6);

    if (vfrb > 0) {
      playHeadRing(o, vfrb);
      playAngleRing(o, vfrb);
    }

    // a killed snake fades out and leaves at dead_amt >= 1 (game.js:4962-4968)
    if (o.dead) {
      o.dead_amt += vfr * .02;
      if (o.dead_amt >= 1) return true;
    } else if (o.alive_amt != 1) {
      o.alive_amt += vfr * .015;
      if (o.alive_amt >= 1) o.alive_amt = 1;
    }
    return false;
  }

  // ------------------------------------------------------------------ prey (game.js:4972-5041)

  // Prey ring: only the last played slot is copied out (same end value as copying each one).
  function playPreyRing(pr, ticks) {
    if (pr.ftg > 0) {
      var take = ticksFor(pr.ftg, ticks);
      pr.ftg -= take;
      for (var t = 1; t <= take; t++) {
        var at = pr.fpos;
        if (t == take) {
          pr.fx = pr.fxs[at];
          pr.fy = pr.fys[at];
        }
        pr.fxs[at] = 0;
        pr.fys[at] = 0;
        pr.fpos = nextSlot(at, RFC);
      }
    } else if (pr.ftg == 0) {
      pr.fx = 0;
      pr.fy = 0;
      pr.ftg = -1;
    }
  }

  // One prey per frame. Returns true when it must be removed.
  function stepPrey(S, pr, vfr, vfrb) {
    var turnStep = S.mamu2 * vfr;
    var move = pr.sp * vfr / 4;   // no cap for prey
    if (vfrb > 0) playPreyRing(pr, vfrb);
    steer(pr, turnStep);
    pr.xx += Math.cos(pr.ang) * move;
    pr.yy += Math.sin(pr.ang) * move;
    pr.gfr += vfr * pr.gr;
    if (pr.eaten) {
      // being eaten: fr grows to 1.5 (from wherever it is, even above), it spins faster, and it shrinks by the
      // cube of its progress
      if (pr.fr != 1.5) pr.fr = Math.min(pr.fr + vfr / 150, 1.5);
      pr.eaten_fr += vfr / 47;
      pr.gfr += vfr;
      if (pr.eaten_fr >= 1 || !pr.eaten_by) return true;
      pr.rad = 1 - Math.pow(pr.eaten_fr, 3);
    } else if (pr.fr != 1) {
      pr.fr += vfr / 150;
      if (pr.fr >= 1) {
        pr.fr = 1;
        pr.rad = 1;
      } else {
        pr.rad = spawnSize(pr.fr);
      }
    }
    return false;
  }

  // ------------------------------------------------------------------ food (game.js:5043-5088)

  // Wobble offset of a food on its radius 6 orbit (game.js:5068, 5085).
  function orbitX(f) {
    return Math.cos(f.wsp * f.gfr) * 6;
  }
  function orbitY(f) {
    return Math.sin(f.wsp * f.gfr) * 6;
  }

  // The eaten food's target: (43 - t*24) * (1 - t) ahead of the eater's head along ang + fa (t = progress
  // squared), in their multiplication order.
  function mouthX(eater, t) {
    return eater.xx + eater.fx + Math.cos(eater.ang + eater.fa) * (43 - t * 24) * (1 - t);
  }
  function mouthY(eater, t) {
    return eater.yy + eater.fy + Math.sin(eater.ang + eater.fa) * (43 - t * 24) * (1 - t);
  }

  // Every food, highest live index first. A finished food is removed by slApply's shared helper, which
  // swaps the last live food in and lowers S.cm1 and S.foods_c; the swapped-in food was already updated
  // this frame.
  function stepFoods(S, vfr) {
    S.cm1 = S.foods_c - 1;
    var list = S.foods;
    for (var i = S.cm1; i >= 0; i--) {
      var f = list[i];
      f.gfr += vfr * f.gr;
      if (f.eaten) {
        f.eaten_fr += vfr / 41;
        var eater = f.eaten_by;
        if (f.eaten_fr >= 1 || !eater) {
          D.slApply.foodRemoveAt(i);
          continue;
        }
        // Flies into the eater's mouth (game.js:5061-5069). The eater may already be gone from slithers;
        // the reference is still held here.
        var t = f.eaten_fr * f.eaten_fr;
        f.rad = f.lrrad * (1 - f.eaten_fr * t);
        f.rx = f.xx + (mouthX(eater, t) - f.xx) * t;
        f.ry = f.yy + (mouthY(eater, t) - f.yy) * t;
        f.rx += orbitX(f) * (1 - f.eaten_fr);
        f.ry += orbitY(f) * (1 - f.eaten_fr);
        continue;
      }
      if (f.fr != 1) {
        f.fr += f.rsp * vfr / 150;
        if (f.fr >= 1) {
          f.fr = 1;
          f.rad = 1;
        } else {
          f.rad = spawnSize(f.fr);
        }
        f.lrrad = f.rad;
      }
      f.rx = f.xx + orbitX(f);
      f.ry = f.yy + orbitY(f);
    }
  }

  // Border ring, while connected (game.js:4553-4564): played slots are refilled with the target, not
  // zeroed, and only the last played slot is shown.
  function stepBorderRing(S, vfrb) {
    if (!(vfrb > 0)) return;
    if (S.flx_tg > 0) {
      var take = ticksFor(S.flx_tg, vfrb);
      S.flx_tg -= take;
      for (var t = 1; t <= take; t++) {
        var at = S.flux_grd_pos;
        if (t == take) S.flux_grd = S.flux_grds[at];
        S.flux_grds[at] = S.real_flux_grd;
        S.flux_grd_pos = nextSlot(at, FLXC);
      }
    } else if (S.flx_tg == 0) {
      S.flx_tg = -1;
    }
  }

  // ------------------------------------------------------------------ the frame

  // Whole 8 ms ticks crossed when a frame counter goes from `before` to `after`.
  function ticksBetween(before, after) {
    return Math.floor(after) - Math.floor(before);
  }

  // Step 1 (game.js:4009-4036): frame length in 8 ms units capped at 5, then the lag multiplier, which ramps
  // PER FRAME (down x.85 to .2 while lagging, else up +.05 to 1). Owen Q24 may change the lag rule (layered in a
  // separate file). Their second cap of 120 (game.js:4028) cannot trigger after the cap of 5: not built.
  function stepTiming(S, ctm) {
    var units = (ctm - S.ltm) / 8;
    if (units > 5) units = 5;
    if (units < 0) units = 0;
    S.vfr = units;
    S.avfr = units;
    S.ltm = ctm;
    if (!S.lagging && S.wfpr && ctm - S.last_ping_mtm > 750 && !S.want_play) S.lagging = true;
    if (S.lagging) {
      S.lag_mult *= .85;
      if (S.lag_mult < .2) S.lag_mult = .2;
    } else if (S.lag_mult < 1) {
      S.lag_mult += .05;
      if (S.lag_mult >= 1) S.lag_mult = 1;
    }
    S.vfr *= S.lag_mult;
    S.lfr = S.fr;
    S.fr += S.vfr;
    S.vfrb = ticksBetween(S.lfr, S.fr);
    S.lfr2 = S.fr2;
    S.fr2 += S.vfr * 2;
    S.vfrb2 = ticksBetween(S.lfr2, S.fr2);
    S.afr += S.avfr;
  }

  // Step 5 (game.js:4338-4357): while playing, the glow alpha and the circle spacing factor fade toward low
  // quality or back.
  function stepQualityFades(S, vfr) {
    if (!S.high_quality) {
      if (S.gla > 0) {
        S.gla -= vfr * .0075;
        if (S.gla < 0) S.gla = 0;
      }
      if (S.qsm < S.mqsm) {
        S.qsm += vfr * 4E-5;
        if (S.qsm > S.mqsm) S.qsm = S.mqsm;
      }
    } else {
      if (S.gla < 1) {
        S.gla += vfr * .0075;
        if (S.gla > 1) S.gla = 1;
      }
      if (S.qsm > 1) {
        S.qsm -= vfr * 4E-5;
        if (S.qsm < 1) S.qsm = 1;
      }
    }
  }

  // Step 11 (game.js:4620-4695): once a second, auto quality from the redraw count, then the counters reset.
  function stepSecond(S) {
    if (S.playing && S.want_quality == 1) {
      if (S.fps <= 24) {
        S.wdfg++;
        if (S.high_quality && S.wdfg >= 1) S.high_quality = false;
      } else if ((S.high_quality || S.fps >= 32) && S.wdfg > 0) {
        S.wdfg *= .987;
        S.wdfg -= .1;
        if (S.wdfg <= 0) S.high_quality = true;
      }
    }
    // the counters slApply keeps, in their order (game.js:4686-4688)
    S.apkps = 0;
    S.pkps = 0;
    S.rdps = 0;
    S.fps = 0;
    S.lrd_mtm = api.now();
  }

  // One frame (game.js:4007-5093). Their menu, ad, spinner, skin chooser, victory, team and
  // testing branches are OUT; choosing_skin, checking_code and shoa are always false here.
  // The next frame is requested in `finally`, so one frame that throws cannot stop the loop for good
  // (theirs would stop; this only differs on a frame that throws).
  function oef() {
    var S = st();
    try {
      runFrame(S);
    } finally {
      // 17. packets between frames see vfr = vfrb = 0 (game.js:5090-5093)
      S.vfr = 0;
      S.vfrb = 0;
      root.requestAnimationFrame(oef);
    }
  }

  function runFrame(S) {
    var ctm = api.now();

    // 1. timing and lag
    stepTiming(S, ctm);
    var vfr = S.vfr;
    var vfrb = S.vfrb;

    // 2. arrow keys collect whole ticks (game.js:4037-4041)
    if (S.connected && S.slither != null) D.slInput.accumulateArrowTicks();

    // 3. a Play request connects once no death fade is running (game.js:4042-4043)
    if (S.want_play && S.dead_mtm == -1) api.hooks.connect();

    // 5. quality fades while playing
    if (S.playing) stepQualityFades(S, vfr);

    // 7. leaderboard fade-in, death hold and fade (game.js:4400-4486), slHud's
    D.slHud.oefFades(ctm);

    // 8. deferred close after a death (game.js:4487-4496)
    if (S.want_close_socket && S.dead_mtm == -1) {
      S.want_close_socket = false;
      if (D.slNet.hasSocket()) {
        D.slNet.closeSocket();
        S.connected = false;
        S.playing = false;
      }
      D.slApply.resetGame();
    }

    // 9. while connected (game.js:4498-4611): turn keys, ping, border ring, minimap fades
    if (S.connected) {
      D.slInput.stepArrowKeys(ctm);
      D.slInput.stepPing(ctm);
      stepBorderRing(S, vfrb);
      D.slHud.oefMinimap();
    }

    // 10. own dot on the minimap (game.js:4613-4619), slHud's, gated inside
    D.slHud.oefDot(ctm);

    // 11. once a second
    if (ctm - S.lrd_mtm > 1E3) stepSecond(S);

    // 12. boost and steering angle (game.js:4696-4751)
    if (S.slither != null) D.slInput.stepBoostAndAngle(ctm);

    // 13. every snake, oldest (highest index) first (game.js:4752-4969)
    var snakes = S.slithers;
    for (var i = snakes.length - 1; i >= 0; i--) {
      if (stepSnake(S, snakes[i], vfr, vfrb)) snakes.splice(i, 1);   // their destroySlitherAtIndex is only this splice (game.js:2636-2640)
    }

    // 14. every prey (game.js:4970-5042)
    var preys = S.preys;
    for (var p = preys.length - 1; p >= 0; p--) {
      if (stepPrey(S, preys[p], vfr, vfrb)) preys.splice(p, 1);
    }

    // 15. every food (game.js:5043-5088)
    stepFoods(S, vfr);

    // 16. draw (game.js:5089); slDrawWorld.redraw starts with redrawPrologue()
    D.slDrawWorld.redraw();
  }

  // ------------------------------------------------------------------ redraw prologue (game.js:5153-5210)

  // Sets one cull box: `margin` world units past the half screen on each side of the view.
  function setBox(S, x1, y1, x2, y2, vx, vy, halfW, halfH, margin) {
    S[x1] = vx - (halfW + margin);
    S[y1] = vy - (halfH + margin);
    S[x2] = vx + (halfW + margin);
    S[y2] = vy + (halfH + margin);
  }

  // Start of every redraw: count it, then zoom and camera PER REDRAW.
  // Returns null when not animating, else the view from before the camera step for the tile phase.
  var prologueOut = { lvx: 0, lvy: 0 };
  function redrawPrologue() {
    var S = st();
    S.fps++;
    if (!S.animating) return null;
    var me = S.slither;
    if (me) {
      // zoom target from the own length only, step 2E-4 per redraw (game.js:5156-5165); anything not below the
      // target steps down
      var zoomTarget = .64285 + .514285714 / Math.max(1, (me.sct + 16) / 36);
      if (S.gsc != zoomTarget) {
        if (S.gsc < zoomTarget) {
          S.gsc += 2E-4;
          if (S.gsc >= zoomTarget) S.gsc = zoomTarget;
        } else {
          S.gsc -= 2E-4;
          if (S.gsc <= zoomTarget) S.gsc = zoomTarget;
        }
      }
    }
    prologueOut.lvx = S.view_xx;
    prologueOut.lvy = S.view_yy;
    if (me != null) {
      // camera ring: one slot per redraw; fvx keeps its last value when idle (game.js:5175-5183)
      if (S.fvtg > 0) {
        S.fvtg--;
        var at = S.fvpos;
        S.fvx = S.fvxs[at];
        S.fvy = S.fvys[at];
        S.fvxs[at] = 0;
        S.fvys[at] = 0;
        S.fvpos = nextSlot(at, VFC);
      }
      if (S.follow_view) {
        S.view_xx = me.xx + me.fx + S.fvx;
        S.view_yy = me.yy + me.fy + S.fvy;
      }
      var vx = S.view_xx, vy = S.view_yy, centre = S.grd, zoom = S.gsc;
      S.view_ang = Math.atan2(vy - centre, vx - centre);
      S.view_dist = Math.sqrt((vx - centre) * (vx - centre) + (vy - centre) * (vy - centre));
      // cull boxes: snakes 84, food 24, extra 210 world units past the half screen (game.js:5197-5209)
      var halfW = S.mww2 / zoom, halfH = S.mhh2 / zoom;
      setBox(S, 'bpx1', 'bpy1', 'bpx2', 'bpy2', vx, vy, halfW, halfH, 84);
      setBox(S, 'fpx1', 'fpy1', 'fpx2', 'fpy2', vx, vy, halfW, halfH, 24);
      setBox(S, 'apx1', 'apy1', 'apx2', 'apy2', vx, vy, halfW, halfH, 210);
    }
    return prologueOut;
  }

  // The quality part of their socket open (game.js:9025-9038). slNet calls it after its own open
  // work. Not undone by resetGame: it carries into the menu and the next life.
  function onSocketOpen() {
    var S = st();
    S.high_quality = true;
    S.gla = 1;
    S.wdfg = 0;
    S.qsm = 1;
    if (S.want_quality == 0) {
      S.high_quality = false;
      S.gla = 0;
      S.qsm = 1.7;
    }
    if (S.render_mode == 1) {
      S.high_quality = false;
      S.gla = 0;
    }
    S.lpstm = api.now();
  }

  // hooks.connect is their connect() (oef step 3): slNet.connect resets the game, clears
  // want_play and opens the socket. The menu hooks are ours to fill; slLoop never calls them
  // (the death fade lives in slHud.oefFades).
  var hooks = {
    connect: function () { D.slNet.connect(); },
    onMenuShow: function () {},
    onMenuFade: function () {},
    onMenuDone: function () {}
  };

  var api = {
    now: now,
    initLoopState: initLoopState,
    buildTables: buildTables,
    start: start,
    oef: oef,
    redrawPrologue: redrawPrologue,
    onSocketOpen: onSocketOpen,
    hooks: hooks
  };
  D.slLoop = api;
})(typeof window !== 'undefined' ? window : globalThis);
