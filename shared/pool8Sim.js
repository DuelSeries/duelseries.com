// 8 Ball Pool's table and physics. The SERVER runs every shot with this, start to finish, in one go
// (server/Pool8Room.js) and sends both screens the result as a tape of keyframes; a browser only uses the
// geometry here (aimGuide, placeOk) to draw the aim line and to move the cue ball in hand. Nothing a client
// computes ever decides where a ball goes.
//
// THE REFERENCE IS MINICLIP'S 8 BALL POOL WEB BUILD (8ballpool.com/game). It is Objective-C compiled to
// WebAssembly with encrypted config, so its constants could not be read; docs/pool8-reference.md says where
// every number below came from (measured from its frames, or CHOSEN where nothing could be measured).
//
// Units: the play field (cushion nose to cushion nose) is P8.L long on x and P8.W wide on y, origin top left,
// y down. Time in seconds, speeds in units per second. The model is the textbook one for pool (a ball slides
// until friction makes it roll, then rolls to a stop; side spin decays on its own; balls hit with restitution;
// a cushion reverses the normal speed with restitution and turns side spin into a change of angle).

(function (root) {
  'use strict';

  var P8 = {
    L: 1000,              // play field length (x)
    W: 500,               // play field width (y): MEASURED 424.5 of 849.5 px, 2:1
    R: 15,                // ball radius: MEASURED 12.75 px on the 849.5 px field
    VMAX: 2055,           // cue ball speed at full power: MEASURED 1730-1760 px/s at the longest pull seen
    POWER_EXP: 1.25,      // speed = VMAX * power^1.25: MEASURED, launch speed = 0.72 x drag^1.25 (px/s, px)
    SLIDE_DECEL: 783,     // sliding friction: MEASURED 665 px/s^2 (it rolls from 5/7 of the launch speed)
    ROLL_DECEL: 43.6,     // rolling: MEASURED 37 px/s^2
    SPIN_DECEL: 9,        // side (z) spin decay: CHOSEN (spin could not be measured), see stepBall
    E_BALL: 0.9,          // ball to ball: MEASURED 0.84-0.94 (a full hit leaves the cue ball 6-16% of its speed)
    E_CUSHION: [[0, 0.2], [33, 0.24], [59, 0.25], [86, 0.42], [135, 0.52], [327, 0.65], [1013, 0.745], [1766, 0.79]],
                          // cushion restitution by the speed into it (units/s): MEASURED, frame tracks
    T_CUSHION: 0.8,       // speed kept along the cushion: MEASURED 0.70-0.88, mean 0.80
    MU_CUSHION: 0.18,     // how far side spin grips the rail (english off a cushion): CHOSEN
    TIP_MAX: 0.5,         // the furthest the cue tip can strike from centre, in radii
    CORNER_MOUTH: 1.67,   // corner pocket mouth, jaw tip to jaw tip, in ball diameters: MEASURED 42.7 px
    SIDE_MOUTH: 2.01,     // side pocket mouth: MEASURED 51.3 px
    CORNER_HOLE: [16.5, 30.4],  // corner hole: centre past the nose corner on each axis, radius: MEASURED
    SIDE_HOLE: [27.7, 24.8],    // side hole: centre past the nose line, radius: MEASURED
    FOOT_X: 0.75,         // rack apex (foot spot), fraction of L
    HEAD_X: 0.25,         // the baulk line the breaker places the cue ball behind, fraction of L
    STEP: 1 / 1000,       // physics step, s
    KF_EVERY: 1 / 30,     // a keyframe at least this often for every moving ball, s
    MAX_T: 25,            // a shot never runs longer than this, s
  };

  /* ── the table ─────────────────────────────────────────────────────────────
     Six pockets (0 top left, 1 top middle, 2 top right, 3 bottom left, 4 bottom middle, 5 bottom right) and the
     cushions as straight segments with gaps at the mouths. A ball is potted once its centre is inside a pocket's
     drop circle, which sits just past the mouth, so a ball can rattle off a jaw tip (a segment end) and stay up. */
  var POCKETS = [], SEGS = [];
  function build() {
    var L = P8.L, W = P8.W, D = 2 * P8.R;
    var c = P8.CORNER_MOUTH * D / Math.SQRT2;     // jaw tip distance from the corner along each rail
    var s = P8.SIDE_MOUTH * D / 2;                // half the side mouth
    var deep = 3 * D;                             // how far the jaws run back from the field
    POCKETS.length = 0; SEGS.length = 0;
    // A ball drops once its centre is over the hole (the holes as measured).
    var off = P8.CORNER_HOLE[0], cr = P8.CORNER_HOLE[1], so = P8.SIDE_HOLE[0], sr = P8.SIDE_HOLE[1];
    POCKETS.push({ x: -off, y: -off, r: cr, kind: 'corner' });
    POCKETS.push({ x: L / 2, y: -so, r: sr, kind: 'side' });
    POCKETS.push({ x: L + off, y: -off, r: cr, kind: 'corner' });
    POCKETS.push({ x: -off, y: W + off, r: cr, kind: 'corner' });
    POCKETS.push({ x: L / 2, y: W + so, r: sr, kind: 'side' });
    POCKETS.push({ x: L + off, y: W + off, r: cr, kind: 'corner' });
    function seg(ax, ay, bx, by) { SEGS.push({ ax: ax, ay: ay, bx: bx, by: by }); }
    // Rails.
    seg(c, 0, L / 2 - s, 0); seg(L / 2 + s, 0, L - c, 0);
    seg(c, W, L / 2 - s, W); seg(L / 2 + s, W, L - c, W);
    seg(0, c, 0, W - c); seg(L, c, L, W - c);
    // Corner jaws, running back along the pocket's diagonal.
    var j = deep / Math.SQRT2;
    seg(c, 0, c - j, -j); seg(0, c, -j, c - j);
    seg(L - c, 0, L - c + j, -j); seg(L, c, L + j, c - j);
    seg(c, W, c - j, W + j); seg(0, W - c, -j, W - c + j);
    seg(L - c, W, L - c + j, W + j); seg(L, W - c, L + j, W - c + j);
    // Side jaws, angled in a little toward the back of the pocket.
    var sj = deep * 0.6;
    seg(L / 2 - s, 0, L / 2 - s + sj * 0.25, -sj); seg(L / 2 + s, 0, L / 2 + s - sj * 0.25, -sj);
    seg(L / 2 - s, W, L / 2 - s + sj * 0.25, W + sj); seg(L / 2 + s, W, L / 2 + s - sj * 0.25, W + sj);
  }

  // 1..7 solids, 8 the black, 9..15 stripes.
  function groupOf(n) { return n >= 1 && n <= 7 ? 'solids' : n >= 9 && n <= 15 ? 'stripes' : n === 8 ? 'eight' : 'cue'; }

  /* The rack: a triangle with its apex on the foot spot, pointing at the breaker, row by row from the apex. The
     reference deals it at random every game (MEASURED: four racks, four apex balls) with the 8 in the middle of the
     third row and one solid and one stripe in the back corners, so that is what rackOrder deals; rng is the
     server's Math.random (the order is sent, never re-dealt on a screen). RACK_ORDER is a fixed one for tests. */
  var RACK_ORDER = [1, 9, 2, 10, 8, 3, 11, 7, 14, 4, 5, 13, 15, 6, 12];
  function rackOrder(rng) {
    var r = typeof rng === 'function' ? rng : Math.random;
    var shuffle = function (a) { for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(r() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; };
    var solids = shuffle([1, 2, 3, 4, 5, 6, 7]), stripes = shuffle([9, 10, 11, 12, 13, 14, 15]);
    var back = r() < 0.5 ? [solids.pop(), stripes.pop()] : [stripes.pop(), solids.pop()];
    var rest = shuffle(solids.concat(stripes));
    // Slots 0..14 row by row: 4 is the middle of row 3, 10 and 14 the back corners.
    var out = [];
    for (var k = 0; k < 15; k++) out.push(k === 4 ? 8 : k === 10 ? back[0] : k === 14 ? back[1] : rest.pop());
    return out;
  }
  function newRack(order) {
    var ORDER = Array.isArray(order) && order.length === 15 ? order : RACK_ORDER;
    var R = P8.R, gap = 0.02;
    var dx = (2 * R + gap) * Math.sqrt(3) / 2, dy = R + gap / 2;
    var balls = [{ n: 0, x: P8.HEAD_X * P8.L, y: P8.W / 2, on: true }];
    var k = 0;
    for (var row = 0; row < 5; row++) {
      for (var i = 0; i <= row; i++) {
        balls.push({ n: ORDER[k++], x: P8.FOOT_X * P8.L + row * dx, y: P8.W / 2 + (2 * i - row) * dy, on: true });
      }
    }
    balls.sort(function (a, b) { return a.n - b.n; });
    return balls;
  }

  /* Where the cue ball may be put down: on the field, clear of every other ball, and behind the baulk line when
     `kitchen` (the break). */
  function placeOk(balls, x, y, kitchen) {
    var R = P8.R;
    if (!(typeof x === 'number' && typeof y === 'number' && isFinite(x) && isFinite(y))) return false;
    if (x < R || x > P8.L - R || y < R || y > P8.W - R) return false;
    if (kitchen && x > P8.HEAD_X * P8.L) return false;
    for (var i = 0; i < balls.length; i++) {
      var b = balls[i];
      if (!b.on || b.n === 0) continue;
      var dx = b.x - x, dy = b.y - y;
      if (dx * dx + dy * dy < 4 * R * R * 1.0001) return false;
    }
    return true;
  }

  /* ── the aim guide ─────────────────────────────────────────────────────────
     The line from the cue ball along `angle` to the first thing it would touch: a ball (the ghost ball circle
     where the cue ball meets it, the object ball's direction from there, and the cue ball's tangent line) or a
     cushion. Geometry only, the same on every screen; the bot aims with it too. */
  function aimGuide(balls, cx, cy, angle) {
    var R = P8.R, dx = Math.cos(angle), dy = Math.sin(angle);
    var best = Infinity, hit = null;
    for (var i = 0; i < balls.length; i++) {
      var b = balls[i];
      if (!b.on || b.n === 0) continue;
      var ox = b.x - cx, oy = b.y - cy;
      var t = ox * dx + oy * dy;
      if (t <= 0) continue;
      var d2 = ox * ox + oy * oy - t * t, rr = 4 * R * R;
      if (d2 > rr) continue;
      var s = t - Math.sqrt(rr - d2);
      if (s < best) { best = s; hit = b; }
    }
    // The cushion box the cue ball's centre can reach.
    var sx = dx > 0 ? (P8.L - R - cx) / dx : dx < 0 ? (R - cx) / dx : Infinity;
    var sy = dy > 0 ? (P8.W - R - cy) / dy : dy < 0 ? (R - cy) / dy : Infinity;
    var wall = Math.max(0, Math.min(sx, sy));
    if (hit && best <= wall) {
      var gx = cx + dx * best, gy = cy + dy * best;
      var nx = hit.x - gx, ny = hit.y - gy, nl = Math.hypot(nx, ny) || 1;
      nx /= nl; ny /= nl;
      var dot = dx * nx + dy * ny;
      var tx = dx - dot * nx, ty = dy - dot * ny, tl = Math.hypot(tx, ty);
      return { kind: 'ball', n: hit.n, gx: gx, gy: gy, dist: best, ox: nx, oy: ny, cut: Math.acos(Math.min(1, dot)),
               tx: tl > 1e-9 ? tx / tl : 0, ty: tl > 1e-9 ? ty / tl : 0 };
    }
    return { kind: 'rail', n: null, gx: cx + dx * wall, gy: cy + dy * wall, dist: wall };
  }

  /* ── one shot ──────────────────────────────────────────────────────────────
     shot: { a: angle (rad), p: power 0..1, sx: side spin -1..1 (+ = right english), sy: -1..1 (+ = top) }.
     Returns the tape for the screens and the facts the rules need. `balls` is not changed; the end positions
     are in result.balls. */
  function simulate(ballsIn, shot) {
    if (!POCKETS.length) build();
    var R = P8.R, dt = P8.STEP;
    var balls = ballsIn.map(function (b) {
      return { n: b.n, x: b.x, y: b.y, on: b.on, vx: 0, vy: 0, wx: 0, wy: 0, wz: 0, moving: false, kt: -1, kx: b.x, ky: b.y };
    });
    var cue = null;
    for (var i = 0; i < balls.length; i++) if (balls[i].n === 0 && balls[i].on) cue = balls[i];
    var kf = [], ev = [], potted = [];
    var res = { first: null, firstT: -1, railAfter: false, railBalls: {}, cuePotted: false };
    function key(b, t) {
      var x = Math.round(b.x * 10), y = Math.round(b.y * 10);
      if (b.kt >= 0 && x === b.kx && y === b.ky) return;
      kf.push(b.n, Math.round(t * 1000), x, y);
      b.kt = t; b.kx = x; b.ky = y;
    }
    if (!cue) return { tape: { dur: 0, kf: kf }, ev: ev, potted: potted, first: null, railAfter: false, railBalls: 0, cuePotted: false, balls: ballsIn.map(copyBall) };

    // The strike. Speed along the aim; the tip's offset from centre gives the cue ball its spin.
    var p = clamp(num(shot.p), 0, 1), a = num(shot.a);
    var V = P8.VMAX * Math.pow(p, P8.POWER_EXP);
    var ux = Math.cos(a), uy = Math.sin(a);
    var tipX = clamp(num(shot.sx), -1, 1) * P8.TIP_MAX * R, tipY = clamp(num(shot.sy), -1, 1) * P8.TIP_MAX * R;
    if (tipX * tipX + tipY * tipY > P8.TIP_MAX * P8.TIP_MAX * R * R) {
      var k = P8.TIP_MAX * R / Math.hypot(tipX, tipY); tipX *= k; tipY *= k;
    }
    cue.vx = V * ux; cue.vy = V * uy;
    // Top (+) / back (-) spin turns about the horizontal axis across the shot; rolling forward is (-uy, ux) * V/R.
    var wTop = 2.5 * V * tipY / (R * R);
    cue.wx = -uy * wTop; cue.wy = ux * wTop;
    // Right english spins the ball clockwise seen from above (y down: positive wz turns x toward y).
    cue.wz = -2.5 * V * tipX / (R * R);
    cue.moving = V > 0;
    key(cue, 0);
    ev.push(0, 1, 0, 0, Math.round(p * 100));

    var t = 0, nextKey = P8.KF_EVERY;
    while (t < P8.MAX_T) {
      t += dt;
      var anyMoving = false;
      for (i = 0; i < balls.length; i++) {
        var b = balls[i];
        if (!b.on || !b.moving) continue;
        stepBall(b, dt);
        if (b.moving) anyMoving = true;
      }
      // Ball to ball.
      for (i = 0; i < balls.length; i++) {
        var A = balls[i];
        if (!A.on) continue;
        for (var j = i + 1; j < balls.length; j++) {
          var B = balls[j];
          if (!B.on || (!A.moving && !B.moving)) continue;
          var dx = B.x - A.x, dy = B.y - A.y, d2 = dx * dx + dy * dy, rr = 4 * R * R;
          if (d2 >= rr) continue;
          var d = Math.sqrt(d2) || 1e-6, nx = dx / d, ny = dy / d;
          var van = A.vx * nx + A.vy * ny, vbn = B.vx * nx + B.vy * ny;
          var closing = van - vbn;
          if (closing > 0) {
            var e = P8.E_BALL;
            var an = ((1 - e) * van + (1 + e) * vbn) / 2, bn = ((1 + e) * van + (1 - e) * vbn) / 2;
            A.vx += (an - van) * nx; A.vy += (an - van) * ny;
            B.vx += (bn - vbn) * nx; B.vy += (bn - vbn) * ny;
            A.moving = B.moving = true; anyMoving = true;
            key(A, t); key(B, t);
            ev.push(Math.round(t * 1000), 2, A.n, B.n, Math.min(999, Math.round(closing)));
            if (res.first === null && (A.n === 0 || B.n === 0)) { res.first = A.n === 0 ? B.n : A.n; res.firstT = t; }
          }
          /* Never left overlapping: pushed apart, the moving ball taking all of it when the other is at rest (a resting
             ball pushed sideways could be shoved through a cushion it is lying against). */
          var over = 2 * R - d;
          var fa = A.moving && B.moving ? 0.5 : A.moving ? 1 : 0, fb = 1 - fa;
          A.x -= nx * over * fa; A.y -= ny * over * fa; B.x += nx * over * fb; B.y += ny * over * fb;
        }
      }
      // Cushions and pockets.
      for (i = 0; i < balls.length; i++) {
        b = balls[i];
        if (!b.on || !b.moving) continue;
        if (b.x > R && b.x < P8.L - R && b.y > R && b.y < P8.W - R) continue;   // nowhere near a rail
        for (var s = 0; s < SEGS.length; s++) {
          var g = SEGS[s];
          var ex = g.bx - g.ax, ey = g.by - g.ay, el = ex * ex + ey * ey;
          var q = clamp(((b.x - g.ax) * ex + (b.y - g.ay) * ey) / el, 0, 1);
          var px = g.ax + ex * q, py = g.ay + ey * q;
          var cx = b.x - px, cy = b.y - py, c2 = cx * cx + cy * cy;
          if (c2 >= R * R) continue;
          var cd = Math.sqrt(c2) || 1e-6, mx = cx / cd, my = cy / cd;
          var vn = b.vx * mx + b.vy * my;
          if (vn < 0) {
            cushion(b, mx, my, vn);
            key(b, t);
            ev.push(Math.round(t * 1000), 3, b.n, 0, Math.min(999, Math.round(-vn)));
            if (res.first !== null) { res.railAfter = true; }
            if (b.n !== 0) res.railBalls[b.n] = true;
          }
          b.x = px + mx * R; b.y = py + my * R;
        }
        for (var k2 = 0; k2 < POCKETS.length; k2++) {
          var P = POCKETS[k2], ddx = b.x - P.x, ddy = b.y - P.y;
          if (ddx * ddx + ddy * ddy < P.r * P.r) {
            key(b, t);
            b.on = false; b.moving = false;
            potted.push({ n: b.n, p: k2, t: Math.round(t * 1000) });
            ev.push(Math.round(t * 1000), 4, b.n, k2, Math.min(999, Math.round(Math.hypot(b.vx, b.vy))));
            if (b.n === 0) res.cuePotted = true;
            break;
          }
        }
        // A ball that somehow got past everything is potted in the nearest pocket rather than lost.
        if (b.on && (b.x < -4 * R || b.x > P8.L + 4 * R || b.y < -4 * R || b.y > P8.W + 4 * R)) {
          var bestP = 0, bd = Infinity;
          for (k2 = 0; k2 < POCKETS.length; k2++) {
            var dd = Math.hypot(b.x - POCKETS[k2].x, b.y - POCKETS[k2].y);
            if (dd < bd) { bd = dd; bestP = k2; }
          }
          key(b, t); b.on = false; b.moving = false;
          potted.push({ n: b.n, p: bestP, t: Math.round(t * 1000) });
          ev.push(Math.round(t * 1000), 4, b.n, bestP, 0);
          if (b.n === 0) res.cuePotted = true;
        }
      }
      if (t >= nextKey) {
        nextKey += P8.KF_EVERY;
        for (i = 0; i < balls.length; i++) if (balls[i].on && balls[i].moving) key(balls[i], t);
      }
      if (!anyMoving) break;
    }
    for (i = 0; i < balls.length; i++) if (balls[i].on) key(balls[i], t);
    var railBalls = 0;
    for (var rb in res.railBalls) if (res.railBalls[rb]) railBalls++;
    return {
      tape: { dur: Math.round(t * 1000), kf: kf }, ev: ev, potted: potted,
      first: res.first, railAfter: res.railAfter, railBalls: railBalls, cuePotted: res.cuePotted,
      balls: balls.map(copyBall),
    };
  }

  /* One step of a ball on the cloth. Sliding while the contact point slips (u = v + w x r), at SLIDE_DECEL against
     the slip, which also turns the ball until it rolls (a solid sphere's slip falls 7/2 times as fast as its
     speed changes); rolling at ROLL_DECEL along its motion; side spin decays on its own. */
  function stepBall(b, dt) {
    var R = P8.R;
    var ux = b.vx - R * b.wy, uy = b.vy + R * b.wx, us = Math.hypot(ux, uy);
    var sp = Math.hypot(b.vx, b.vy);
    if (us > 0.5) {
      var dec = P8.SLIDE_DECEL;
      if (3.5 * dec * dt >= us) {
        // The slip ends inside this step: the ball rolls from here (v loses 2/7 of the slip).
        b.vx -= ux / 3.5; b.vy -= uy / 3.5;
        b.wx = -b.vy / R; b.wy = b.vx / R;
      } else {
        var ax = -dec * ux / us, ay = -dec * uy / us;
        b.vx += ax * dt; b.vy += ay * dt;
        b.wx += 2.5 / R * ay * dt; b.wy += -2.5 / R * ax * dt;
      }
    } else if (sp > 0) {
      var d = P8.ROLL_DECEL * dt;
      if (d >= sp) { b.vx = 0; b.vy = 0; }
      else { var f = (sp - d) / sp; b.vx *= f; b.vy *= f; }
      b.wx = -b.vy / R; b.wy = b.vx / R;
    }
    if (b.wz !== 0) {
      var dz = P8.SPIN_DECEL * dt * 2.5 / R * 10;
      b.wz = Math.abs(b.wz) <= dz ? 0 : b.wz - Math.sign(b.wz) * dz;
    }
    b.x += b.vx * dt; b.y += b.vy * dt;
    var still = b.vx === 0 && b.vy === 0;
    if (still) { b.wx = 0; b.wy = 0; }
    var slip = Math.hypot(b.vx - R * b.wy, b.vy + R * b.wx);
    b.moving = !(still && slip <= 0.5) && !(Math.hypot(b.vx, b.vy) < 0.5 && slip <= 0.5);
    if (!b.moving) { b.vx = b.vy = b.wx = b.wy = 0; b.wz = 0; }
  }

  /* A cushion hit. n points from the cushion into the table and vn (< 0) is the speed into it. MEASURED on the
     reference: the speed across the rail comes back at a restitution that grows with the speed of the hit
     (E_CUSHION), and 0.8 of the speed along it is kept (T_CUSHION). The ball's roll turns with it (CHOSEN: a
     rolling ball leaves the rail rolling, a stunned one stunned, a drawing one still drawing), and side spin grips
     the rail up to MU_CUSHION of the impact, which is what makes english change the angle (CHOSEN: the reference's
     spin could not be measured). */
  function cushionE(v) {
    var t = P8.E_CUSHION;
    if (typeof t === 'number') return t;
    if (v <= t[0][0]) return t[0][1];
    for (var i = 1; i < t.length; i++) if (v <= t[i][0]) return t[i - 1][1] + (t[i][1] - t[i - 1][1]) * (v - t[i - 1][0]) / (t[i][0] - t[i - 1][0]);
    return t[t.length - 1][1];
  }
  function cushion(b, nx, ny, vn) {
    var R = P8.R, e = cushionE(-vn), T = P8.T_CUSHION;
    var tx = -ny, ty = nx;
    var vt = b.vx * tx + b.vy * ty;
    // The roll as a speed (the speed it would roll at), turned the same way as the velocity.
    var sx = R * b.wy, sy = -R * b.wx;
    var sn = -e * (sx * nx + sy * ny), st = T * (sx * tx + sy * ty);
    var nvn = -e * vn, nvt = T * vt;
    b.vx = nvn * nx + nvt * tx; b.vy = nvn * ny + nvt * ty;
    sx = sn * nx + st * tx; sy = sn * ny + st * ty;
    b.wy = sx / R; b.wx = -sy / R;
    // English: side spin grips the rail and bends the way out.
    if (b.wz !== 0) {
      var J = R * b.wz / 3.5, cap = P8.MU_CUSHION * (1 + e) * -vn;
      if (J > cap) J = cap; else if (J < -cap) J = -cap;
      b.vx += J * tx; b.vy += J * ty;
      b.wz -= 2.5 * J / R;
    }
    b.moving = true;
  }

  function copyBall(b) { return { n: b.n, x: Math.round(b.x * 100) / 100, y: Math.round(b.y * 100) / 100, on: b.on }; }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }

  /* Where a ball is at time tms on a tape (the screens animate with this). kfByBall: from indexTape. */
  function indexTape(kf) {
    var by = {};
    for (var i = 0; i < kf.length; i += 4) (by[kf[i]] = by[kf[i]] || []).push(kf[i + 1], kf[i + 2] / 10, kf[i + 3] / 10);
    return by;
  }
  function posAt(list, tms) {
    if (!list || !list.length) return null;
    if (tms <= list[0]) return { x: list[1], y: list[2], i: 0 };
    for (var i = 3; i < list.length; i += 3) {
      if (list[i] >= tms) {
        var t0 = list[i - 3], t1 = list[i], f = t1 > t0 ? (tms - t0) / (t1 - t0) : 1;
        return { x: list[i - 2] + (list[i + 1] - list[i - 2]) * f, y: list[i - 1] + (list[i + 2] - list[i - 1]) * f, i: i };
      }
    }
    return { x: list[list.length - 2], y: list[list.length - 1], i: list.length - 3 };
  }

  /* Setting a measured constant rebuilds the table (tests and the reference harness use it). */
  function configure(over) {
    for (var k in over) if (Object.prototype.hasOwnProperty.call(P8, k)) P8[k] = over[k];
    build();
  }

  build();
  var Sim = { P8: P8, POCKETS: POCKETS, SEGS: SEGS, RACK_ORDER: RACK_ORDER, rackOrder: rackOrder, groupOf: groupOf, newRack: newRack,
              placeOk: placeOk, aimGuide: aimGuide, simulate: simulate, indexTape: indexTape, posAt: posAt,
              configure: configure };
  if (typeof module === 'object' && module.exports) module.exports = Sim;
  else root.P8Sim = Sim;
})(typeof self !== 'undefined' ? self : this);
