// Head Soccer's rules and physics, one fixed step at a time. The server runs the whole match with it
// (server/HeadSoccerRoom.js); the browser runs the very same step for its own player (prediction), so a key press
// moves you at once on screen and the server agrees about where you went.
//
// THE REFERENCE IS "HEADS ARENA EURO SOCCER" (Poki, 2016, Phaser 2.4.2 + P2 physics). Every number below comes from
// its own source (game.min.js, read 2026-10-27) or from its running world (headless Chrome, live p2 bodies), and
// says which: (S) its source, with the identifier; (L) read live from its physics world; (M) measured by stepping it.
// docs/head-soccer-reference.md has the full table, how each was got, and what is still UNKNOWN.
//
// UNITS ARE THE REFERENCE'S OWN DESIGN UNITS: its frame is 1920 high at any screen size (config.json workingHeight
// 1920; Game.scale(v) = imageScale * v, so a value v in its source is v here). x is measured from the halfway line
// (the reference's Game.dimensions.width / 2), positive to the right; y grows DOWN from the top of that 1920 frame.
// Its width follows the screen (1920 x 1.333 .. 1920 x 2.286); the playable box does not: the two goal nets close it
// at x = +-1214.2 whatever the width.
//
// Sides: seat 0 starts on the LEFT, defends the left goal and shoots right; seat 1 is the mirror.
(function (root) {
  'use strict';

  var HS = {
    STEP: 1 / 60,                    // S: Phaser P2 fixed step (p2.frameRate 1/60, useElapsedTime false) (L)
    // The frame.
    VIEW_H: 1920,                    // S: config.json orientationSettings.landscape.workingHeight
    VIEW_W_MIN: 1920 * 4 / 3,        // S: config.json maxRatio .75 -> width at least 1920 / .75
    VIEW_W_MAX: 1920 / 0.4375,       // S: config.json minRatio .4375 -> width at most 1920 / .4375
    VIEW_W_REF: 1920 * 16 / 9,       // the reference's width on a 16:9 screen, where its AI's distances were read
    // The world.
    G: 1600,                         // S: _setupPhysics p2.gravity.y = Game.scale(1600)  (L: 1600)
    PLAYER_G: 2000,                  // S: Player.update data.force[1] -= Game.scale(1E4) on mass 100 -> 2000 more
    BALL_DAMP: 0.1,                  // L: p2 default damping on the ball body (M: 984 -> 967 in 10 steps rolling)
    PLAYER_DAMP: 0.5,                // S: Player body.damping = .5
    FRICTION_G: 480,                 // S/M: contact friction .3 x gravity 1600 (p2 slip force); M: a released run
                                     //    loses 8 a step on the grass on top of the damping (1000 -> 980.5)
    // The pitch: one static body, drawn by FieldDrawer.drawArenaOnBody (S), placed by Arena (S), read live (L).
    PITCH_Y: 1471.8,                 // L: floor shape top in the middle (FIELD_DEPTH lower than the shelves)
    SHELF_Y: 1181.8,                 // L: the raised grass under each goal
    FIELD_HALF: 990,                 // S: Arena _fieldSize Game.scale(1980) / 2: the step faces
    CORNER: 40,                      // S: Arena _cornerSize: the 45 degree chamfers on the steps
    GOAL_AREA: 250,                  // S: Arena _goalAreaSize: the shelf, out to 1280
    ARENA_HALF: 1280,                // S: _midToEnd = 990 + 250 + 40
    // The goals (Goal class, S; positions L).
    GOAL_LINE_X: 1044.2,             // S: isInGoal x past sprite.x -+ .5 * sprite.width (goal-front 160 px / .45)
    GOAL_TOP_Y: 755.2,               // S: isInGoal y > sprite.y - .4 * sprite.height (1259.2 - .4 x 1260)
    GOAL_BOT_Y: 1259.2,              // S: isInGoal y < sprite.y (Game height - floor height + 177)
    NET_X: 1214.2,                   // L: the net wall's inner face (Goal.net, a 355.6 wide box, 8 frames tall)
    NET_W: 355.6,                    // S: net width = goal-front sprite width
    BAR_X: 1197,                     // L: crossbar centre x (sprite.x -+ Game.scale(25))
    BAR_Y: 752.2,                    // L: crossbar centre y
    BAR_W: 355.6, BAR_H: 40,         // S: Goal.bar createSprite(sprite.width, Game.scale(40))
    BAR_DEG: 12,                     // S: bar.body.angle = 12 * (left ? 1 : -1): the bar slopes down toward the pitch
    // The ball (level.Ball, S).
    BALL_R: 46,                      // S: setCircle(.45 * sprite.width), ball-front 92 px x .5 / .45 (L: 46)
    BALL_E_PITCH: 0.8,               // S: contactMaterial(ball, field).restitution  (M: 1568 -> 1247 off the grass)
    BALL_E_GOAL: 0.6,                // S: contactMaterial(ball, arena).restitution: crossbars and nets
    BALL_E_PLAYER: 0.3,              // S: contactMaterial(ball, player).restitution
    BALL_E_TOP: 0,                   // S: world bounds use the default contact material (restitution 0)
    // The players (character.Player, S).
    HEAD: [[-20, 50], [-70, 0], [-70, -50], [-20, -100], [20, -100], [70, -50], [70, 0], [20, 50]],  // L: octagon
    LEGS: [[-20, 50], [20, 50], [20, 150], [-20, 150]],   // L: from _playerPolyRaw x body.width x 2, centred
    FOOT: 150,                       // L: body centre to soles
    RUN: 1000,                       // S: _moveSpeed Game.scale(1E3)  (M: 1000 set every step a key is held)
    IDLE_KEEP: 0.6,                  // S: Player.update: not moving -> velocity.x *= .6 every step
    JUMP_V: 2000,                    // S: jump(a = Game.scale(2E3)): velocity.y = -a
    JUMPS: 2,                        // S: _jumpLimit 2 (from the ground: one jump and one more in the air)
    KICK_RANGE: 270,                 // S: _ballKickDistance Game.scale(270)
    KICK_SPEED: 2900,                // S: _kickForce Game.scale(2900)
    KICK_VY: 0.7,                    // S: kick sets (sin a * force, cos a * force * .7)
    KICK_LIFT: 0.2 * Math.PI,        // S: getKickAngle adds .2 PI when grounded, signed by facing
    KICK_AIM_X: 51.1, KICK_AIM_Y: 50, // S: kick() aims at sprite.position - sprite.size / 2 (ball 92x90 px x .5)
    KICK_MS: 200, KICK_REST_MS: 200, // S: _kickTime 200 (the boot's tween) + _kickDelay 200 before the next kick
    // Kick-off (GameplayHandler.startGame + Arena.getPlayerStart, S).
    START_X: 495,                    // S: fieldSize / 2 / (1 + 1): both players 495 from the middle
    START_Y: 1082.2,                 // S: Game height - floor sprite height (377 px / .45): dropped onto the pitch
    DROP_Y: 576,                     // S: ball setStart(.3 * Game height)
    DROP_VX_PER_GOAL: 5,             // S: moveRight((left score - right score) * Game.scale(5))
    // The match (logic.Timer and GameplayHandler, S).
    MATCH_MS: 120000,                // OURS (Owen 2026-10-27): one 2-minute match, no half time, the board counts
                                     //    down 2:00 to 0:00 (the reference plays 60 s shown as 90 minutes, with a half)
    COUNTDOWN_MS: 2400,              // S: doCountDown: 3, 2, 1, 0 every 600 ms, play at the 0
    COUNT_STEP_MS: 600,              // S
    GOAL_PAUSE_MS: 3000,             // S: _goalTimeout 3E3 then kickoff()
    GOLDEN_FLASH_MS: 2000,           // S: fulltime level: flashGoldenGoal, setTimeout(goldenGoalKickoff, 2E3)
    TIE: 'golden',                   // S: level at full time -> golden goal, the next goal wins
    GOLDEN_MAX_MS: 60000,            // OURS (Owen 2026-10-27): golden goal lasts one minute, shown counting down 1:00 to
                                     //    0:00; still level then is a draw, each seat refunded its own stake
    // The power shot is not in this reference (no special moves in its source). OFF, kept as one switch.
    POWER_SHOT: false,
    POWER_FREEZE_MS: 900,
    // Contacts: the reference's own soft-contact engine (its p2: contacts found a step late and pushed apart by a
    // spring, friction, restitution on a first impact only, a spinning ball) and its kick's second update() call.
    // M: 52 measured scenarios match it within 0.5 units. false is the rigid push-out model this file had before.
    CONTACT_P2: true,
  };

  var IN = { LEFT: 1, RIGHT: 2 };
  var BALL_REST = 2 * HS.G * HS.STEP;  // below this an impact is a resting contact: p2 applies restitution only on a
                                       // contact's first impact, so a resting ball does not hop
  var TOUCH_SPEED = 120;               // a contact worth a sound

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function standY() { return HS.PITCH_Y - HS.FOOT; }

  // ── the static world ─────────────────────────────────────────────────────────────────────────────────────────
  function box(x0, y0, x1, y1) { return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]; }
  function rotBox(cx, cy, hw, hh, deg) {
    var a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(function (v) { return [cx + v[0] * c - v[1] * s, cy + v[0] * s + v[1] * c]; });
  }
  function mirror(poly) { return poly.map(function (v) { return [-v[0], v[1]]; }).reverse(); }
  var WORLD = (function () {
    var P = HS.PITCH_Y, Sh = HS.SHELF_Y, F = HS.FIELD_HALF, C = HS.CORNER, A = HS.ARENA_HALF, B = P + 600;
    var blockL = [[-A, Sh], [-F - C, Sh], [-F, Sh + C], [-F, P], [-A, P]];
    var filletL = [[-F, P - C], [-F + C, P], [-F, P]];
    var netL = box(-HS.NET_X - HS.NET_W, -9600, -HS.NET_X, 5760);
    var barL = rotBox(-HS.BAR_X, HS.BAR_Y, HS.BAR_W / 2, HS.BAR_H / 2, HS.BAR_DEG);
    var barR = rotBox(HS.BAR_X, HS.BAR_Y, HS.BAR_W / 2, HS.BAR_H / 2, -HS.BAR_DEG);
    var mk = function (poly, kind) { return { v: poly, kind: kind, n: normals(poly) }; };
    return [
      mk(box(-A, P, A, B), 'pitch'), mk(blockL, 'pitch'), mk(mirror(blockL), 'pitch'), mk(filletL, 'pitch'), mk(mirror(filletL), 'pitch'),
      mk(netL, 'net'), mk(mirror(netL), 'net'), mk(barL, 'bar'), mk(barR, 'bar'),
    ];
  })();

  // Outward unit normals of a convex polygon, whatever its winding.
  function normals(poly) {
    var cx = 0, cy = 0, i, out = [];
    for (i = 0; i < poly.length; i++) { cx += poly[i][0]; cy += poly[i][1]; }
    cx /= poly.length; cy /= poly.length;
    for (i = 0; i < poly.length; i++) {
      var a = poly[i], b = poly[(i + 1) % poly.length], nx = b[1] - a[1], ny = a[0] - b[0], l = Math.hypot(nx, ny);
      nx /= l; ny /= l;
      if ((a[0] - cx) * nx + (a[1] - cy) * ny < 0) { nx = -nx; ny = -ny; }
      out.push([nx, ny]);
    }
    return out;
  }
  function project(poly, nx, ny) {
    var mn = Infinity, mx = -Infinity;
    for (var i = 0; i < poly.length; i++) { var d = poly[i][0] * nx + poly[i][1] * ny; if (d < mn) mn = d; if (d > mx) mx = d; }
    return [mn, mx];
  }
  // Separating axes: the smallest push that takes polygon a out of polygon b, as { nx, ny, d } (n points from b to a).
  function sat(a, an, b, bn) {
    var best = null, i, axes = [an, bn];
    for (var k = 0; k < 2; k++) {
      for (i = 0; i < axes[k].length; i++) {
        var nx = axes[k][i][0], ny = axes[k][i][1], pa = project(a, nx, ny), pb = project(b, nx, ny);
        var o1 = pb[1] - pa[0], o2 = pa[1] - pb[0];    // push a along +n, or along -n
        if (o1 <= 0 || o2 <= 0) return null;
        if (!best || o1 < best.d) best = { nx: nx, ny: ny, d: o1 };
        if (o2 < best.d) best = { nx: -nx, ny: -ny, d: o2 };
      }
    }
    return best;
  }
  // A circle against a convex polygon: { nx, ny, d } pushing the circle out (n from the polygon to the centre).
  function circlePoly(cx, cy, r, poly, ns) {
    var inside = true, maxD = -Infinity, maxI = 0, i;
    for (i = 0; i < poly.length; i++) {
      var d = (cx - poly[i][0]) * ns[i][0] + (cy - poly[i][1]) * ns[i][1];
      if (d > 0) inside = false;
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (inside) return { nx: ns[maxI][0], ny: ns[maxI][1], d: r - maxD };
    if (maxD >= r) return null;
    var bx = 0, by = 0, bd = Infinity;
    for (i = 0; i < poly.length; i++) {
      var a = poly[i], b = poly[(i + 1) % poly.length], ex = b[0] - a[0], ey = b[1] - a[1];
      var t = clamp(((cx - a[0]) * ex + (cy - a[1]) * ey) / (ex * ex + ey * ey), 0, 1);
      var qx = a[0] + ex * t, qy = a[1] + ey * t, dd = (cx - qx) * (cx - qx) + (cy - qy) * (cy - qy);
      if (dd < bd) { bd = dd; bx = qx; by = qy; }
    }
    var dist = Math.sqrt(bd);
    if (dist >= r || dist === 0) return null;
    return { nx: (cx - bx) / dist, ny: (cy - by) / dist, d: r - dist };
  }

  var HEAD_N = normals(HS.HEAD), LEGS_N = normals(HS.LEGS);
  function shapesOf(p) {
    var t = function (v) { return [v[0] + p.x, v[1] + p.y]; };
    return [{ v: HS.HEAD.map(t), n: HEAD_N }, { v: HS.LEGS.map(t), n: LEGS_N }];
  }

  // ── state ────────────────────────────────────────────────────────────────────────────────────────────────────
  function newPlayer(side) {
    return {
      side: side, dir: side === 0 ? 1 : -1,
      x: side === 0 ? -HS.START_X : HS.START_X, y: HS.START_Y, vx: 0, vy: 0,
      ground: false,             // S: Player.grounded, set on a contact's start with the pitch or a grounded player
      jc: 0,                     // S: _jumpCounter
      left: side === 1,          // S: _orientationIsLeft (the right player starts facing left: orientateLeft)
      mv: false,                 // S: isMoving, from the last step's controls
      cf: false, cp: false,      // touching the pitch / the other player at the end of the last step
      kickMs: -1,                // ms into the current kick, -1 when free (the swing plus its rest)
      held: 0,                   // IN bits
      jumps: 0, kicks: 0, powers: 0,   // press counters already acted on
      power: 0, powerArmed: false,     // the power shot's, kept at zero (no power shot)
      spin: 0,                   // CONTACT_P2: the body's hidden spin (L: its angle is locked, its spin is not), rad/s
      touch: 0,                  // CONTACT_P2: which shape pairs touched last step (bits, see Contact)
      xf: 0,                     // CONTACT_P2: this step's extra Player.update forces from a kick (S: kick calls update)
    };
  }
  function newBall() { return { x: 0, y: HS.DROP_Y, vx: 0, vy: 0, rot: 0, straight: false, powerBy: -1, spin: 0, touch: 0 }; }
  function newMatch() {
    return { p: [newPlayer(0), newPlayer(1)], ball: newBall(), score: [0, 0], msLeft: HS.MATCH_MS, goldenMs: 0,
             tick: 0, freezeMs: 0 };
  }

  // Back to the kick-off spots with a new ball dropping from the middle (S: startGame). Presses carry over.
  function kickoff(m) {
    for (var s = 0; s < 2; s++) {
      var o = m.p[s], q = newPlayer(s);
      q.held = o.held; q.jumps = o.jumps; q.kicks = o.kicks; q.powers = o.powers;
      q.ground = o.ground; q.jc = o.jc;
      m.p[s] = q;
    }
    m.ball = newBall();
    m.ball.vx = (m.score[0] - m.score[1]) * HS.DROP_VX_PER_GOAL;
  }

  // ── a player's controls (S: PlayerControls.update / Player.moveLeft, moveRight, jump, kick) ─────────────────
  function tryJump(p) {
    if (!(p.ground || p.jc < HS.JUMPS)) return false;
    p.vy = -HS.JUMP_V; p.ground = false; p.jc++;
    return true;
  }
  // The ball's kick, if it is in reach: aimed from the body centre at the ball's corner (the reference aims at its
  // sprite's top-left corner; here that corner is mirrored for the right seat so neither seat kicks differently).
  function kickVelocity(p, tx, ty) {
    var dx = tx - p.x, dy = ty - p.y;
    if (Math.hypot(dx, dy) >= HS.KICK_RANGE) return null;
    var a = Math.atan2(dx, dy) + (p.ground ? HS.KICK_LIFT : 0) * (p.left ? -1 : 1);
    return [Math.sin(a) * HS.KICK_SPEED, Math.cos(a) * HS.KICK_SPEED * HS.KICK_VY];
  }
  function kickAim(p, ball) { return [ball.x - HS.KICK_AIM_X * p.dir, ball.y - HS.KICK_AIM_Y]; }
  function tryKick(p, ball, ev) {
    if (p.kickMs >= 0) return;
    p.kickMs = 0;
    // S: kick() calls this.update() a second time: not moving -> velocity.x *= .6 once more, and one more 1E4 down
    // force this step (M: a drifting kicker keeps 313.9 of 523, an airborne one falls 33.3 faster)
    if (HS.CONTACT_P2) { if (!p.mv) p.vx *= HS.IDLE_KEEP; p.mv = false; p.xf = (p.xf | 0) + 1; }
    var t = kickAim(p, ball), v = kickVelocity(p, t[0], t[1]);
    if (!v) { ev.push({ e: 'swing', s: p.side }); return; }
    ball.vx = v[0]; ball.vy = v[1];
    ev.push({ e: 'kick', s: p.side, v: Math.round(Math.hypot(v[0], v[1])) });
  }

  // One player's controls for this step. `enabled` false is the reference's disabled input (countdowns, goal and
  // half-time pauses): no moves, and presses made then are used up, never saved for later.
  function control(p, inp, ball, enabled, ev) {
    if (!p.mv) p.vx *= HS.IDLE_KEEP;
    p.mv = false;
    if (p.kickMs >= 0) { p.kickMs += HS.STEP * 1000; if (p.kickMs >= HS.KICK_MS + HS.KICK_REST_MS) p.kickMs = -1; }
    if (!inp) return;
    p.held = inp.held | 0;
    var jumped = inp.jumps > p.jumps, kicked = inp.kicks > p.kicks;
    if (jumped) p.jumps = inp.jumps;
    if (kicked) p.kicks = inp.kicks;
    if (inp.powers > p.powers) p.powers = inp.powers;
    if (!enabled) return;
    var L = !!(p.held & IN.LEFT), R = !!(p.held & IN.RIGHT);
    if (L && !R) { p.vx = -HS.RUN; p.left = true; p.mv = true; }
    else if (R && !L) { p.vx = HS.RUN; p.left = false; p.mv = true; }
    if (jumped && tryJump(p)) ev.push({ e: 'jump', s: p.side });
    if (kicked) tryKick(p, ball, ev);
  }

  // ── physics ──────────────────────────────────────────────────────────────────────────────────────────────────
  function frictionOn(p, nx, ny, k) {
    var tx = -ny, ty = nx, vt = p.vx * tx + p.vy * ty, f = Math.min(Math.abs(vt), HS.FRICTION_G * HS.STEP * k);
    if (vt > 0) f = -f;
    // p2 solves friction before it moves the body: the step's move uses the slowed speed too.
    p.vx += tx * f; p.vy += ty * f; p.x += tx * f * HS.STEP; p.y += ty * f * HS.STEP;
  }
  function playerWorld(p) {
    var touched = false;
    for (var pass = 0; pass < 2; pass++) {
      var parts = shapesOf(p);
      for (var i = 0; i < WORLD.length; i++) {
        var w = WORLD[i];
        for (var j = 0; j < 2; j++) {
          var c = sat(parts[j].v, parts[j].n, w.v, w.n);
          if (!c) continue;
          p.x += c.nx * c.d; p.y += c.ny * c.d;
          for (var q = 0; q < 2; q++) { var v = parts[q].v; for (var r = 0; r < v.length; r++) { v[r][0] += c.nx * c.d; v[r][1] += c.ny * c.d; } }
          var vn = p.vx * c.nx + p.vy * c.ny;
          if (vn < 0) { p.vx -= vn * c.nx; p.vy -= vn * c.ny; }
          if (pass === 0) frictionOn(p, c.nx, c.ny, 1);
          if (w.kind === 'pitch') touched = true;
        }
      }
    }
    if (p.y - 100 < 0) { p.y = 100; if (p.vy < 0) p.vy = 0; }
    return touched;
  }
  function playersTouch(a, b) {
    var pa = shapesOf(a), pb = shapesOf(b), best = null;
    for (var i = 0; i < 2; i++) for (var j = 0; j < 2; j++) {
      var c = sat(pa[i].v, pa[i].n, pb[j].v, pb[j].n);
      if (c && (!best || c.d > best.d)) best = c;
    }
    if (!best) return false;
    var h = best.d / 2;
    a.x += best.nx * h; a.y += best.ny * h; b.x -= best.nx * h; b.y -= best.ny * h;
    var vn = (a.vx - b.vx) * best.nx + (a.vy - b.vy) * best.ny;
    if (vn < 0) { a.vx -= vn / 2 * best.nx; a.vy -= vn / 2 * best.ny; b.vx += vn / 2 * best.nx; b.vy += vn / 2 * best.ny; }
    return true;
  }
  function ballOff(ball, c, e, vx, vy) {
    ball.x += c.nx * c.d; ball.y += c.ny * c.d;
    var rvx = ball.vx - vx, rvy = ball.vy - vy, vn = rvx * c.nx + rvy * c.ny;
    if (vn >= 0) return 0;
    var k = -vn > BALL_REST ? 1 + e : 1;
    ball.vx -= k * vn * c.nx; ball.vy -= k * vn * c.ny;
    return -vn;
  }

  // The rigid model (HS.CONTACT_P2 false): move, then push every overlap out along its normal in the same step.
  function rigid(m, ev, dt) {
    var ball = m.ball, i, p;
    var bd = Math.pow(1 - HS.BALL_DAMP, dt), pd = Math.pow(1 - HS.PLAYER_DAMP, dt);
    ball.vx *= bd; ball.vy *= bd; ball.vy += HS.G * dt;
    ball.x += ball.vx * dt; ball.y += ball.vy * dt;
    for (i = 0; i < 2; i++) {
      p = m.p[i];
      p.vx *= pd; p.vy *= pd; p.vy += (HS.G + HS.PLAYER_G) * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
    }
    // Players against the pitch, the nets and the bars, then each other. Ground() on a contact's start (S).
    var cf = [false, false];
    for (i = 0; i < 2; i++) cf[i] = playerWorld(m.p[i]);
    var cp = playersTouch(m.p[0], m.p[1]);
    if (cp) { cf[0] = playerWorld(m.p[0]) || cf[0]; cf[1] = playerWorld(m.p[1]) || cf[1]; }
    for (i = 0; i < 2; i++) {
      p = m.p[i];
      var o = m.p[1 - i];
      if (cf[i] && !p.cf) { p.ground = true; p.jc = 0; }
      if (cp && !p.cp && o.ground) { p.ground = true; p.jc = 0; }
      p.cf = cf[i]; p.cp = cp;
    }
    // The ball against the world, then the players (who outweigh it fifty to one, so it is the one that moves).
    for (var pass = 0; pass < 2; pass++) {
      for (i = 0; i < WORLD.length; i++) {
        var w = WORLD[i], c = circlePoly(ball.x, ball.y, HS.BALL_R, w.v, w.n);
        if (!c) continue;
        var hit = ballOff(ball, c, w.kind === 'pitch' ? HS.BALL_E_PITCH : HS.BALL_E_GOAL, 0, 0);
        if (pass === 0 && hit > TOUCH_SPEED) ev.push({ e: w.kind === 'pitch' ? 'bounce' : w.kind === 'bar' ? 'post' : 'net' });
      }
      if (ball.y - HS.BALL_R < 0) { ball.y = HS.BALL_R; if (ball.vy < 0) ball.vy = -ball.vy * HS.BALL_E_TOP; }
      for (i = 0; i < 2; i++) {
        p = m.p[i];
        if (Math.abs(ball.x - p.x) > 200 || Math.abs(ball.y - p.y) > 260) continue;
        var parts = shapesOf(p);
        for (var j = 0; j < 2; j++) {
          var c2 = circlePoly(ball.x, ball.y, HS.BALL_R, parts[j].v, parts[j].n);
          if (!c2) continue;
          var hit2 = ballOff(ball, c2, HS.BALL_E_PLAYER, p.vx, p.vy);
          if (pass === 0 && j === 0 && hit2 > TOUCH_SPEED) ev.push({ e: 'head', s: p.side });
        }
      }
    }
    // The rigid ball has no spin: drawn turning slowly with its speed.
    ball.rot += ball.vx * dt * 0.00048;
  }

  // ── physics B: the reference's own contact model (HS.CONTACT_P2) ───────────────────────────────────────────────
  /* p2 0.7 inside Phaser 2.4.2, written from reading its shipped source (MIT) and checked step by step against the
     running reference: 52 scenarios (bounces, rolling, head and bar rebounds, landings, the kicker's recoil), every
     one within 0.5 units (docs/head-soccer-reference.md, "Contacts"). Unlike the rigid model: a contact is found from
     the START-of-step positions (a step after the overlap begins) and pushed apart by a soft spring (SPOOK: stiffness
     1e5, the ball's materials 1e6, relaxation 4, 10 Gauss-Seidel passes); friction is a soft equation clamped at
     mu x |g| x mass; restitution is the target only on a body pair's first impact; the ball spins (inertia 1.0712)
     and the players keep a hidden spin (L: inertia 358.36) though their angle is locked. Its frame: metres,
     kilograms, and x and y NEGATED from the design frame (its P2 world is ours turned half a turn).

     LOCKSTEP. A step reads nothing but the match. What the engine remembers between steps rides on the moving bodies
     and on the wire: `touch` (which shape pairs touched last step: first impacts and Player.ground read it) and
     `spin`. The broadphase order is sorted afresh every step from one fixed list (the reference keeps its list
     between steps; the two differ only on an exact tie), and all the scratch is rebuilt every step. */
  var Contact = (function () {
    var SM = 0.0225;                                   // metres per design unit: imageScale .45 px per unit, 20 px per metre
    var CIRCLE = 1, PLANE = 4, CONVEX = 8, ITER = 10;  // p2's shape type numbers (a pair is solved lower type first); L: 10 passes
    var P_INV_I = 1 / 358.3564484735253, P_ANG_DAMP = 0.1;   // L: a player body's inertia and angularDamping
    var MAT = { e: 0, k: 1e5, d: 4, skin: 0.005, fr: 0.3 };  // L: setGlobalStiffness(1E5), relaxation 4, friction .3; S: skin
    var BALL_MAT = {                                   // S: contactMaterial(ball, ...).restitution; L: their stiffness 1e6
      field: { e: HS.BALL_E_PITCH, k: 1e6, d: 4, skin: 0.005, fr: 0.3 },
      arena: { e: HS.BALL_E_GOAL, k: 1e6, d: 4, skin: 0.005, fr: 0.3 },
      player: { e: HS.BALL_E_PLAYER, k: 1e6, d: 4, skin: 0.005, fr: 0.3 },
    };
    function matOf(a, b) { var o = a === 'ball' ? b : b === 'ball' ? a : null; return (o && BALL_MAT[o]) || MAT; }

    function dot(a, b) { return a[0] * b[0] + a[1] * b[1]; }
    function sub(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
    function add(a, b) { return [a[0] + b[0], a[1] + b[1]]; }
    function mul(a, s) { return [a[0] * s, a[1] * s]; }
    function cross(a, b) { return a[0] * b[1] - a[1] * b[0]; }
    function unit(a) { var l = Math.hypot(a[0], a[1]); return l > 0 ? [a[0] / l, a[1] / l] : [0, 0]; }
    function cw(a) { return [a[1], -a[0]]; }

    // A convex shape from a design-frame polygon: counter-clockwise in the engine's frame, about its own centroid.
    function ccw(v) {
      var a = 0;
      for (var i = 0; i < v.length; i++) { var p = v[i], q = v[(i + 1) % v.length]; a += p[0] * q[1] - q[0] * p[1]; }
      return a < 0 ? v.slice().reverse() : v;
    }
    function convex(poly, mat, ix, head) {
      var v = ccw(poly.map(function (p) { return [-p[0] * SM, -p[1] * SM]; })), a = 0, cx = 0, cy = 0, i;
      for (i = 0; i < v.length; i++) {
        var p = v[i], q = v[(i + 1) % v.length], cr = p[0] * q[1] - q[0] * p[1];
        a += cr; cx += (p[0] + q[0]) * cr; cy += (p[1] + q[1]) * cr;
      }
      cx /= 3 * a; cy /= 3 * a;
      return { type: CONVEX, v: v.map(function (p) { return [p[0] - cx, p[1] - cy]; }), off: [cx, cy], mat: mat, ix: ix, head: !!head };
    }
    function spos(b, sh) { return sh.off ? [b.pos[0] + sh.off[0], b.pos[1] + sh.off[1]] : b.pos; }

    /* Bodies by slot, in the reference's body-id order: the top edge, the pitch, left bar, left net, right bar, right
       net, seat 0, seat 1, the ball. NS: shapes per slot; BASE: the shapes in the slots before it. A moving body's
       `touch` holds one bit per (lower-slot shape, own shape) pair: bit (BASE[lower] + its shape) x NS[own] + own shape. */
    var NS = [1, 5, 1, 1, 1, 1, 2, 2, 1], BASE = [0, 1, 6, 7, 8, 9, 10, 12, 14];
    function body(slot, tag) {
      return { slot: slot, tag: tag, dynamic: false, pos: [0, 0], vel: [0, 0], w: 0, force: [0, 0], mass: 0, invMass: 0, invI: 0,
               damping: 0, angDamping: 0, shapes: [], vl: [0, 0], wl: 0, box: null, was: 0, now: 0, idx: -1 };
    }
    // L: the reference's pitch body is these five convex pieces, in this order and winding (read from its live p2 body):
    // WORLD's pitch outline cut its way, so contacts at the step faces and chamfers pair up as they do there.
    var FLOOR_PIECES = [
      [[-1280, 1181.82], [-1030, 1181.82], [-990, 1221.82], [-990, 1431.82]],
      [[-1280, 2019.59], [-1280, 1181.82], [-990, 1431.82], [-950, 1471.82]],
      [[1280, 2019.59], [-1280, 2019.59], [-950, 1471.82], [950, 1471.82]],
      [[1280, 1181.82], [1280, 2019.59], [950, 1471.82], [990, 1431.82]],
      [[990, 1431.82], [990, 1221.82], [1030, 1181.82], [1280, 1181.82]],
    ];
    var TOP = body(0, 'top'), FLOOR = body(1, 'floor'), BAR_L = body(2, 'bar'), NET_L = body(3, 'net'), BAR_R = body(4, 'bar'), NET_R = body(5, 'net');
    TOP.shapes.push({ type: PLANE, normal: [0, -1], mat: 'default', ix: 0 });   // the world's top edge, y = 0
    FLOOR_PIECES.forEach(function (v, i) { FLOOR.shapes.push(convex(v, 'field', i)); });
    NET_L.shapes.push(convex(WORLD[5].v, 'arena', 0)); NET_R.shapes.push(convex(WORLD[6].v, 'arena', 0));
    BAR_L.shapes.push(convex(WORLD[7].v, 'arena', 0)); BAR_R.shapes.push(convex(WORLD[8].v, 'arena', 0));
    var STATICS = [TOP, FLOOR, BAR_L, NET_L, BAR_R, NET_R];
    var LEGS = convex([[20, 50], [20, 150], [-20, 150], [-20, 50]], 'player', 0), HEAD = convex(HS.HEAD, 'player', 1, true);   // L: its vertex order
    var BALL = { type: CIRCLE, radius: HS.BALL_R * SM, mat: 'ball', ix: 0 };

    function aabbOf(b) {
      var lx = Infinity, ux = -Infinity, ly = Infinity, uy = -Infinity;
      b.shapes.forEach(function (sh) {
        if (sh.type === PLANE) { lx = -1e7; ux = 1e7; ly = b.pos[1]; uy = 1e7; return; }   // everything above y = 0
        var o = spos(b, sh), vs = sh.type === CIRCLE ? [[-sh.radius, -sh.radius], [sh.radius, sh.radius]] : sh.v;
        vs.forEach(function (v) { var x = o[0] + v[0], y = o[1] + v[1]; if (x < lx) lx = x; if (x > ux) ux = x; if (y < ly) ly = y; if (y > uy) uy = y; });
      });
      return { lx: lx, ux: ux, ly: ly, uy: uy };
    }
    STATICS.forEach(function (b) { b.box = aabbOf(b); });

    // S: its broadphase is sweep-and-prune on x, and the order its pairs come out in is the order they are solved
    // in: bodies sorted by their box's lowest x (stable, from the slot order), a pair (earlier, later) while the later
    // starts before the earlier ends, only pairs its collision groups allow.
    function mayCollide(a, b) {
      if (!a.dynamic && !b.dynamic) return false;
      if (a.tag === 'top' || b.tag === 'top' || a.tag === 'ball' || b.tag === 'ball') return true;
      return a.tag === 'player' && b.tag === 'player' || a.dynamic !== b.dynamic;
    }
    function pairsOf(bodies) {
      var order = [], out = [], i, j;
      for (i = 0; i < bodies.length; i++) {
        var e = bodies[i], f = i - 1;
        order.push(e);
        while (f >= 0 && order[f].box.lx > e.box.lx) { order[f + 1] = order[f]; f--; }
        order[f + 1] = e;
      }
      for (i = 0; i < order.length; i++) {
        var A = order[i], a = A.box;
        for (j = i + 1; j < order.length; j++) {
          var B = order[j], c = B.box;
          if (!(c.lx <= a.ux)) break;
          if (mayCollide(A, B) && a.lx <= c.ux && c.lx <= a.ux && a.ly <= c.uy && c.ly <= a.uy) out.push([A, B]);
        }
      }
      return out;
    }

    // ── its equations ──
    function gmult(G, vA, wA, vB, wB) { return G[0] * vA[0] + G[1] * vA[1] + G[2] * wA + G[3] * vB[0] + G[4] * vB[1] + G[5] * wB; }
    function gW(e) { return gmult(e.G, e.A.vel, e.A.w, e.B.vel, e.B.w); }
    function gWl(e) { return gmult(e.G, e.A.vl, e.A.wl, e.B.vl, e.B.wl); }
    function giMf(e) {
      var A = e.A, B = e.B;
      return gmult(e.G, [A.force[0] * A.invMass, A.force[1] * A.invMass], 0, [B.force[0] * B.invMass, B.force[1] * B.invMass], 0);
    }
    function giMGt(e) {
      var G = e.G, A = e.A, B = e.B;
      return G[0] * G[0] * A.invMass + G[1] * G[1] * A.invMass + G[2] * G[2] * A.invI + G[3] * G[3] * B.invMass + G[4] * G[4] * B.invMass + G[5] * G[5] * B.invI;
    }
    function addW(e, l) {
      var G = e.G, A = e.A, B = e.B;
      A.vl[0] += G[0] * A.invMass * l; A.vl[1] += G[1] * A.invMass * l; A.wl += A.invI * G[2] * l;
      B.vl[0] += G[3] * B.invMass * l; B.vl[1] += G[4] * B.invMass * l; B.wl += B.invI * G[5] * l;
    }
    function spook(e, h) { var k = e.k, d = e.d; e.a = 4 / (h * (1 + 4 * d)); e.b = 4 * d / (1 + 4 * d); e.eps = 4 / (h * h * k * (1 + 4 * d)); }
    function contactB(e, h) {
      var G = e.G, n = e.n, q, p;
      G[0] = -n[0]; G[1] = -n[1]; G[2] = -cross(e.cpA, n); G[3] = n[0]; G[4] = n[1]; G[5] = cross(e.cpB, n);
      var pen = sub(add(e.B.pos, e.cpB), add(e.A.pos, e.cpA));
      e.closing = -gW(e);
      if (e.first && e.rest !== 0) { q = 0; p = 1 / e.b * (1 + e.rest) * gW(e); }   // a first impact aims at the bounce
      else { q = dot(n, pen) + e.skin; p = gW(e); }                                  // after it, a spring on the overlap
      return -q * e.a - p * e.b - h * giMf(e);
    }
    function frictionB(e, h) {
      var G = e.G, t = e.t;
      G[0] = -t[0]; G[1] = -t[1]; G[2] = -cross(e.cpA, t); G[3] = t[0]; G[4] = t[1]; G[5] = cross(e.cpB, t);
      return -gW(e) * e.b - h * giMf(e);
    }

    // ── its narrowphase (the contact points follow its maths) ──
    function touchedBefore(A, B) {
      var H = A.slot > B.slot ? A : B, L = H === A ? B : A, n = NS[H.slot];
      return ((H.was >>> (BASE[L.slot] * n)) & ((1 << (NS[L.slot] * n)) - 1)) !== 0;
    }
    function newContact(w, A, B, sA, sB) {
      var k = w.mat, e = { c: true, A: A, B: B, sA: sA, sB: sB, G: [0, 0, 0, 0, 0, 0], cpA: [0, 0], cpB: [0, 0], n: [0, 0],
        min: 0, max: Infinity, rest: k.e, first: !touchedBefore(A, B), k: k.k, d: k.d, skin: k.skin, a: 0, b: 0, eps: 0, closing: 0 };
      w.ces.push(e);
      return e;
    }
    function friction(w, A, B, cpA, cpB, t) {
      w.frs.push({ c: false, A: A, B: B, G: [0, 0, 0, 0, 0, 0], cpA: cpA, cpB: cpB, t: t, min: -w.slip, max: w.slip, k: w.mat.k, d: w.mat.d, a: 0, b: 0, eps: 0 });
    }
    function frictionFromAverage(w, n) {   // one friction row for a shape pair's n contacts, at their mean point
      var last = w.ces[w.ces.length - 1], A = last.A, B = last.B, cpA = [0, 0], cpB = [0, 0], t = [0, 0];
      for (var i = 0; i < n; i++) {
        var c = w.ces[w.ces.length - 1 - i];
        if (c.A === A) { t = add(t, c.n); cpA = add(cpA, c.cpA); cpB = add(cpB, c.cpB); }
        else { t = sub(t, c.n); cpA = add(cpA, c.cpB); cpB = add(cpB, c.cpA); }
      }
      friction(w, A, B, mul(cpA, 1 / n), mul(cpB, 1 / n), cw(unit(t)));
    }
    function pointInConvex(p, v, pos) {
      var n = null;
      for (var o = 0; o <= v.length; o++) {
        var P = add(v[o % v.length], pos), Q = add(v[(o + 1) % v.length], pos), r = cross(sub(P, p), sub(Q, p));
        if (n === null) n = r;
        if (0 >= r * n) return false;
        n = r;
      }
      return true;
    }
    function circleConvex(w, A, sA, B, sB) {
      var c = spos(A, sA), R = sA.radius, k = spos(B, sB), M = sB.v, found = false, L = Infinity, J = null, Ap = null, N;
      for (N = 0; N !== M.length + 1; N++) {
        var O = add(M[N % M.length], k), P = add(M[(N + 1) % M.length], k), x = cw(unit(sub(P, O))), D = add(mul(x, -R), c);
        if (pointInConvex(D, M, k)) {
          var Q = Math.abs(dot(sub(O, D), x));
          if (L > Q) { J = D; L = Q; Ap = add(mul(x, Q), D); found = true; }
        }
      }
      var e;
      if (found) {
        e = newContact(w, A, B, sA, sB);
        e.n = unit(sub(J, c)); e.cpA = sub(add(mul(e.n, R), c), A.pos); e.cpB = sub(add(sub(Ap, k), k), B.pos);
        friction(w, A, B, e.cpA.slice(), e.cpB.slice(), cw(e.n));
        return 1;
      }
      for (N = 0; N < M.length; N++) {   // a vertex inside the circle
        var z = add(M[N], k), y = sub(z, c);
        if (dot(y, y) < R * R) {
          e = newContact(w, A, B, sA, sB);
          e.n = unit(y); e.cpA = sub(add(mul(e.n, R), c), A.pos); e.cpB = sub(add(sub(z, k), k), B.pos);
          friction(w, A, B, e.cpA.slice(), e.cpB.slice(), cw(e.n));
          return 1;
        }
      }
      return 0;
    }
    function projectOnto(v, pos, axis) {
      var mn = null, mx = null;
      for (var i = 0; i < v.length; i++) { var h = dot(v[i], axis); if (mx === null || h > mx) mx = h; if (mn === null || mn > h) mn = h; }
      var o = dot(pos, axis);
      return [mn + o, mx + o];
    }
    function separatingAxis(a, pa, b, pb) {
      var best = null, bestAxis = null, over = false;
      for (var u = 0; u !== 2; u++) {
        var s = u === 0 ? a : b;
        for (var x = 0; x !== s.v.length; x++) {
          var r = unit(cw(sub(s.v[(x + 1) % s.v.length], s.v[x]))), p = projectOnto(a.v, pa, r), q = projectOnto(b.v, pb, r), lo = p, hi = q;
          if (p[0] > q[0]) { hi = p; lo = q; }
          var gap = hi[0] - lo[1];
          if (best === null || gap > best) { bestAxis = r; best = gap; over = gap <= 0; }
        }
      }
      return over ? bestAxis : null;
    }
    function closestEdge(sh, axis, flip) {
      var e = flip ? [-axis[0], -axis[1]] : axis, k = -1, m = -1, l = sh.v.length;
      for (var n = 0; n !== l; n++) {
        var o = dot(unit(cw(sub(sh.v[(n + 1) % l], sh.v[n % l]))), e);
        if (k === -1 || o > m) { k = n % l; m = o; }
      }
      return k;
    }
    function convexConvex(w, bA, sA, bB, sB) {
      var posA = spos(bA, sA), posB = spos(bB, sB), F = 0, axis = separatingAxis(sA, posA, sB, posB);
      if (!axis) return 0;
      if (dot(axis, sub(posB, posA)) > 0) axis = mul(axis, -1);
      var H = closestEdge(sA, axis, true), I = closestEdge(sB, axis, false);
      if (H === -1 || I === -1) return 0;
      for (var J = 0; J < 2; J++) {
        var K = H, L = I, M = sA, N = sB, O = posA, P = posB, S = bA, T = bB;
        if (J === 0) { K = I; L = H; M = sB; N = sA; O = posB; P = posA; S = bB; T = bA; }
        for (var V = L; V < L + 2; V++) {
          var q = add(N.v[(V + N.v.length) % N.v.length], P), X = 0;
          for (var Y = K - 1; Y < K + 2; Y++) {
            var Z = add(M.v[(Y + M.v.length) % M.v.length], O), Z2 = add(M.v[(Y + 1 + M.v.length) % M.v.length], O);
            if (0 >= dot(unit(cw(sub(Z2, Z))), sub(q, Z))) X++;
          }
          if (X >= 3) {
            var ab = newContact(w, S, T, M, N); F++;
            var Z0 = add(M.v[K % M.v.length], O), Z1 = add(M.v[(K + 1) % M.v.length], O);
            ab.n = unit(cw(sub(Z1, Z0)));
            var C = mul(ab.n, dot(ab.n, sub(q, Z0)));
            ab.cpA = sub(sub(q, C), S.pos); ab.cpB = sub(q, T.pos);
          }
        }
      }
      if (F) frictionFromAverage(w, F);
      return F;
    }
    function planeConvex(w, A, sA, B, sB) {
      var n = sA.normal, q = 0;
      for (var v = 0; v !== sB.v.length; v++) {
        var vp = add(sB.v[v], spos(B, sB)), p = sub(vp, spos(A, sA));
        if (dot(p, n) <= 0) {
          q++;
          var e = newContact(w, A, B, sA, sB);
          e.n = n.slice(); e.cpB = sub(vp, B.pos); e.cpA = sub(sub(vp, mul(e.n, dot(p, e.n))), A.pos);
        }
      }
      if (q) frictionFromAverage(w, q);
      return q;
    }
    function circlePlane(w, A, sA, B, sB) {   // its equation has the plane as body A
      var x = sub(A.pos, B.pos), n = sB.normal, d = dot(n, x);
      if (d > sA.radius) return 0;
      var e = newContact(w, B, A, sB, sA);
      e.n = n.slice(); e.cpB = sub(add(mul(n, -sA.radius), A.pos), A.pos); e.cpA = sub(sub(A.pos, mul(n, d)), B.pos);
      friction(w, B, A, e.cpA.slice(), e.cpB.slice(), cw(e.n));
      return 1;
    }
    function shapePair(w, A, sA, B, sB) {
      var k = w.mat = matOf(sA.mat, sB.mat);
      w.slip = k.fr * w.g * (!A.dynamic ? B.mass : !B.dynamic ? A.mass : A.mass * B.mass / (A.mass + B.mass));   // S: mu x |g| x mass
      if (sA.type > sB.type || sA.type === sB.type) { var T = A; A = B; B = T; var U = sA; sA = sB; sB = U; }
      var t = sA.type | sB.type;
      if (t === (CIRCLE | CONVEX)) return circleConvex(w, A, sA, B, sB);
      if (t === CONVEX) return convexConvex(w, A, sA, B, sB);
      if (t === (PLANE | CONVEX)) return planeConvex(w, A, sA, B, sB);
      if (t === (CIRCLE | PLANE)) return circlePlane(w, A, sA, B, sB);
      return 0;
    }

    function moving(slot, tag, o, shapes, mass, damping, invI, angDamping) {
      var b = body(slot, tag);
      b.dynamic = true; b.mass = mass; b.invMass = 1 / mass; b.invI = invI; b.damping = damping; b.angDamping = angDamping;
      b.pos[0] = -o.x * SM; b.pos[1] = -o.y * SM; b.vel[0] = -o.vx * SM; b.vel[1] = -o.vy * SM;
      b.w = o.spin || 0; b.was = o.touch | 0; b.shapes = shapes;
      b.box = aabbOf(b);
      return b;
    }
    function back(b, o) { o.x = -b.pos[0] / SM; o.y = -b.pos[1] / SM; o.vx = -b.vel[0] / SM; o.vy = -b.vel[1] / SM; o.spin = b.w; o.touch = b.now; }

    // One physics step for the ball and both players.
    function step(m, ev, h) {
      var ball = m.ball, i, k, n;
      var bb = moving(8, 'ball', ball, [BALL], 2, HS.BALL_DAMP, 1 / (0.5 * 2 * Math.pow(HS.BALL_R * SM, 2)), HS.BALL_DAMP);
      var pb = [];
      for (i = 0; i < 2; i++) {
        var p = m.p[i], b = moving(6 + i, 'player', p, [LEGS, HEAD], 100, HS.PLAYER_DAMP, P_INV_I, P_ANG_DAMP);
        b.idx = i;
        b.force[1] = -HS.PLAYER_G * SM * 100 * (1 + (p.xf | 0));   // S: Player.update: force[1] -= 1E4, once per update() call
        p.xf = 0;
        pb.push(b);
      }
      var bodies = STATICS.concat(pb, [bb]), gy = -HS.G * SM;
      for (i = 0; i < bodies.length; i++) { bodies[i].vl = [0, 0]; bodies[i].wl = 0; }
      // Gravity as a force, damping on the velocities, before the solver sees them.
      for (i = 6; i < 9; i++) {
        var d = bodies[i];
        d.force[1] += gy * d.mass;
        var ld = Math.pow(1 - d.damping, h);
        d.vel[0] *= ld; d.vel[1] *= ld; d.w *= Math.pow(1 - d.angDamping, h);
      }
      // Narrowphase from the start-of-step positions, pair by pair in the sweep's order.
      var w = { g: Math.hypot(0, gy), mat: MAT, slip: 0, ces: [], frs: [] }, pairs = pairsOf(bodies), begun = [];
      for (i = 0; i < pairs.length; i++) {
        var A = pairs[i][0], B = pairs[i][1];
        for (var ia = 0; ia < A.shapes.length; ia++) for (var ib = 0; ib < B.shapes.length; ib++) {
          var sA = A.shapes[ia], sB = B.shapes[ib];
          if (!shapePair(w, A, sA, B, sB)) continue;
          var hiA = A.slot > B.slot, H = hiA ? A : B, sH = hiA ? sA : sB, Lo = hiA ? B : A, sL = hiA ? sB : sA;
          var bit = 1 << ((BASE[Lo.slot] + sL.ix) * NS[H.slot] + sH.ix);
          H.now |= bit;
          if (!(H.was & bit)) begun.push([A, B]);   // S: onBeginContact, per shape pair
        }
      }
      // Solve: SPOOK rows, 10 Gauss-Seidel passes, contacts first then friction.
      var eqs = w.ces.concat(w.frs), Bs = [], invC = [], lam = [];
      n = eqs.length;
      for (i = 0; i < n; i++) spook(eqs[i], h);
      for (i = 0; i < n; i++) { var e = eqs[i]; Bs[i] = e.c ? contactB(e, h) : frictionB(e, h); invC[i] = 1 / (giMGt(e) + e.eps); lam[i] = 0; }
      for (var it = 0; it < ITER; it++) {
        for (i = 0; i < n; i++) {
          var q = eqs[i], o = invC[i] * (Bs[i] - gWl(q) - q.eps * lam[i]), s = lam[i] + o;
          if (q.min * h > s) o = q.min * h - lam[i]; else if (s > q.max * h) o = q.max * h - lam[i];
          lam[i] += o; addW(q, o);
        }
      }
      // Then move: the solver's change, the forces, the positions.
      for (i = 6; i < 9; i++) {
        var y = bodies[i];
        y.vel[0] += y.vl[0]; y.vel[1] += y.vl[1]; y.w += y.wl;
        y.vel[0] += y.force[0] * h * y.invMass; y.vel[1] += y.force[1] * h * y.invMass;
        y.pos[0] += y.vel[0] * h; y.pos[1] += y.vel[1] * h;
      }
      back(bb, ball);
      for (i = 0; i < 2; i++) back(pb[i], m.p[i]);
      // S: onBeginContact on a player: the pitch body, or a grounded player, gives the jumps back (Player.ground).
      for (i = 0; i < begun.length; i++) {
        for (k = 0; k < 2; k++) {
          var me = begun[i][k], other = begun[i][1 - k];
          if (me.tag !== 'player') continue;
          if (other === FLOOR || (other.tag === 'player' && m.p[other.idx].ground)) { m.p[me.idx].ground = true; m.p[me.idx].jc = 0; }
        }
      }
      // The sounds: a ball's first touch that came in fast enough, once per body it touched.
      var heard = 0, cf = [false, false], cp = false;
      for (i = 0; i < w.ces.length; i++) {
        var c = w.ces[i];
        for (k = 0; k < 2; k++) {
          var me2 = k ? c.B : c.A, ot = k ? c.A : c.B;
          if (me2.tag === 'player' && ot === FLOOR) cf[me2.idx] = true;
          if (me2.tag === 'player' && ot.tag === 'player') cp = true;
        }
        if (!c.first || c.closing / SM <= TOUCH_SPEED) continue;
        var ob = c.A.tag === 'ball' ? c.B : c.B.tag === 'ball' ? c.A : null;
        if (!ob || (heard & (1 << ob.slot))) continue;
        var sh = ob === c.A ? c.sA : c.sB;
        if (ob === FLOOR) ev.push({ e: 'bounce' });
        else if (ob.tag === 'bar') ev.push({ e: 'post' });
        else if (ob.tag === 'net') ev.push({ e: 'net' });
        else if (ob.tag === 'player' && sh.head) ev.push({ e: 'head', s: ob.idx });
        else continue;
        heard |= 1 << ob.slot;
      }
      for (i = 0; i < 2; i++) { m.p[i].cf = cf[i]; m.p[i].cp = cp; }   // touching the pitch / each other (kept for the wire)
    }
    return { step: step };
  })();

  // The whole match, one step. inputs[side]: { held, jumps, kicks, powers } (counts only ever go up). `live` true
  // runs the clock and counts goals; `enabled` false is the reference's disabled input (default on). Returns the
  // step's events: kick, swing, jump, head, bounce, post, net, goal { s: who scored }.
  function step(m, inputs, dt, live, enabled) {
    if (enabled === undefined) enabled = true;
    var ev = [], ball = m.ball, i;
    m.tick++;
    // The reference's order: every player's update and controls, then the physics step.
    for (i = 0; i < 2; i++) control(m.p[i], inputs ? inputs[i] : null, ball, enabled, ev);
    if (live) {
      if (m.msLeft > 0) m.msLeft = Math.max(0, m.msLeft - dt * 1000);
      else m.goldenMs += dt * 1000;
    }
    if (HS.CONTACT_P2) {
      Contact.step(m, ev, dt);
      ball.rot += ball.spin * dt;   // the sprite turns with the body (S: Phaser sets rotation from the p2 angle)
    } else rigid(m, ev, dt);

    // A goal: the ball's centre inside a goal's box (S: Goal.isInGoal).
    if (live && ball.y > HS.GOAL_TOP_Y && ball.y < HS.GOAL_BOT_Y) {
      var scored = ball.x < -HS.GOAL_LINE_X ? 1 : ball.x > HS.GOAL_LINE_X ? 0 : -1;
      if (scored >= 0) { m.score[scored]++; ev.push({ e: 'goal', s: scored }); }
    }
    return ev;
  }

  // ── the wire: one snapshot as small integer arrays (positions to a tenth of a unit) ────────────────────────
  var r10 = function (v) { return Math.round(v * 10); };
  function packPlayer(p) {
    var flags = (p.ground ? 1 : 0) | (p.left ? 4 : 0) | (p.mv ? 8 : 0) | (p.cf ? 16 : 0) | (p.cp ? 32 : 0);
    // The press counts the server has acted on ride along, so a page replaying its own presses on top of this state
    // (prediction) replays only the ones the server has not seen yet.
    // touch and spin are the contact engine's memory between steps: a page replaying from this state needs them.
    return [r10(p.x), r10(p.y), r10(p.vx), r10(p.vy), flags, Math.round(p.kickMs), p.touch | 0, p.jumps, p.kicks, p.powers, p.jc,
            r1k(p.spin)];
  }
  function unpackPlayer(a, side) {
    var p = newPlayer(side);
    p.x = a[0] / 10; p.y = a[1] / 10; p.vx = a[2] / 10; p.vy = a[3] / 10;
    var f = a[4] | 0;
    p.ground = !!(f & 1); p.left = !!(f & 4); p.mv = !!(f & 8); p.cf = !!(f & 16); p.cp = !!(f & 32);
    p.kickMs = a[5];
    p.touch = a[6] | 0;
    p.jumps = a[7] | 0; p.kicks = a[8] | 0; p.powers = a[9] | 0; p.jc = a[10] | 0;
    p.spin = (+a[11] || 0) / 1000;
    return p;
  }
  function packBall(b) { return [r10(b.x), r10(b.y), r10(b.vx), r10(b.vy), Math.round(b.rot * 100), b.touch | 0, r1k(b.spin)]; }
  function unpackBall(a) {
    var b = newBall();
    b.x = a[0] / 10; b.y = a[1] / 10; b.vx = a[2] / 10; b.vy = a[3] / 10; b.rot = a[4] / 100;
    b.touch = a[5] | 0; b.spin = (+a[6] || 0) / 1000;
    return b;
  }
  function r1k(v) { return Math.round((v || 0) * 1000); }
  /* The server rounds its own match exactly as the wire does whenever it sends one (HeadSoccerRoom.snapshot), so the
     state a page replays from IS the state the server stepped on: the same Sim.step from it gives the server's
     next states bit for bit, until the other player's presses differ. Everything else a step reads is exact on the
     wire already (flags, counts, touch bits). */
  function snapToWire(m) {
    for (var s = 0; s < 2; s++) {
      var p = m.p[s], q = unpackPlayer(packPlayer(p), s);
      p.x = q.x; p.y = q.y; p.vx = q.vx; p.vy = q.vy; p.kickMs = q.kickMs; p.spin = q.spin;
    }
    var b = m.ball, c = unpackBall(packBall(b));
    b.x = c.x; b.y = c.y; b.vx = c.vx; b.vy = c.vy; b.rot = c.rot; b.spin = c.spin;
  }

  // The board's clock: the time left as "MMSS", counting down. A second shows until it has fully gone, so the
  // board reads 2:00 at the whistle and 0:00 only at the end.
  function clockDigits(msLeft) {
    var s = Math.ceil(Math.max(0, msLeft) / 1000 - 1e-6), mm = Math.floor(s / 60), ss = s % 60;
    return (mm < 10 ? '0' : '') + mm + (ss < 10 ? '0' : '') + ss;
  }

  var Sim = { HS: HS, IN: IN, WORLD: WORLD, newMatch: newMatch, newPlayer: newPlayer, newBall: newBall, kickoff: kickoff,
              step: step, standY: standY, kickVelocity: kickVelocity, kickAim: kickAim, clockDigits: clockDigits,
              shapesOf: shapesOf, circlePoly: circlePoly,
              packPlayer: packPlayer, unpackPlayer: unpackPlayer, packBall: packBall, unpackBall: unpackBall, snapToWire: snapToWire };
  if (typeof module === 'object' && module.exports) module.exports = Sim;
  else root.HSSim = Sim;
})(typeof self !== 'undefined' ? self : this);
