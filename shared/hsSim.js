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
    MATCH_MS: 60000,                 // S: _actualTimeLimit 60 s of play
    HALF_MS: 30000,                  // S: half time when the clock passes half of 90 minutes
    CLOCK_MIN: 90,                   // S: _timeLimit 90: the board counts 90 game minutes over the 60 s
    COUNTDOWN_MS: 2400,              // S: doCountDown: 3, 2, 1, 0 every 600 ms, play at the 0
    COUNT_STEP_MS: 600,              // S
    GOAL_PAUSE_MS: 3000,             // S: _goalTimeout 3E3 then kickoff()
    HALF_PAUSE_MS: 3000,             // S: halftime callback: setTimeout(kickoff, 3E3)
    GOLDEN_FLASH_MS: 2000,           // S: fulltime level: flashGoldenGoal, setTimeout(goldenGoalKickoff, 2E3)
    TIE: 'golden',                   // S: level at full time -> golden goal: the clock stays at 90:00, next goal wins
    GOLDEN_MAX_MS: 300000,           // OURS (not the reference's): a money match must end; 5 minutes level in golden
                                     //    goal stops as a draw, each seat refunded (the rule this game already had)
    // The power shot is not in this reference (no special moves in its source). OFF, kept as one switch.
    POWER_SHOT: false,
    POWER_FREEZE_MS: 900,
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
    };
  }
  function newBall() { return { x: 0, y: HS.DROP_Y, vx: 0, vy: 0, rot: 0, straight: false, powerBy: -1 }; }
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

  // The whole match, one step. inputs[side]: { held, jumps, kicks, powers } (counts only ever go up). `live` true
  // runs the clock and counts goals; `enabled` false is the reference's disabled input (default on). Returns the
  // step's events: kick, swing, jump, head, bounce, post, net, goal { s: who scored }.
  function step(m, inputs, dt, live, enabled) {
    if (enabled === undefined) enabled = true;
    var ev = [], ball = m.ball, i, p;
    m.tick++;
    // The reference's order: every player's update and controls, then the physics step.
    for (i = 0; i < 2; i++) control(m.p[i], inputs ? inputs[i] : null, ball, enabled, ev);
    if (live) {
      if (m.msLeft > 0) m.msLeft = Math.max(0, m.msLeft - dt * 1000);
      else m.goldenMs += dt * 1000;
    }
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
    // M: the reference's ball barely turns (0.47 rad/s rolling at 984): it slides. Drawn the same.
    ball.rot += ball.vx * dt * 0.00048;

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
    return [r10(p.x), r10(p.y), r10(p.vx), r10(p.vy), flags, Math.round(p.kickMs), 0, p.jumps, p.kicks, p.powers, p.jc];
  }
  function unpackPlayer(a, side) {
    var p = newPlayer(side);
    p.x = a[0] / 10; p.y = a[1] / 10; p.vx = a[2] / 10; p.vy = a[3] / 10;
    var f = a[4] | 0;
    p.ground = !!(f & 1); p.left = !!(f & 4); p.mv = !!(f & 8); p.cf = !!(f & 16); p.cp = !!(f & 32);
    p.kickMs = a[5];
    p.jumps = a[7] | 0; p.kicks = a[8] | 0; p.powers = a[9] | 0; p.jc = a[10] | 0;
    return p;
  }
  function packBall(b) { return [r10(b.x), r10(b.y), r10(b.vx), r10(b.vy), Math.round(b.rot * 100), 0]; }
  function unpackBall(a) {
    var b = newBall();
    b.x = a[0] / 10; b.y = a[1] / 10; b.vx = a[2] / 10; b.vy = a[3] / 10; b.rot = a[4] / 100;
    return b;
  }

  // The board's clock (S: Timer._getDisplayTime): 90 game minutes over the 60 s, as "MMSS".
  function clockDigits(msLeft) {
    var played = clamp(HS.MATCH_MS - msLeft, 0, HS.MATCH_MS);
    var gs = Math.floor(played / 1000 * HS.CLOCK_MIN + 1e-6), mm = Math.floor(gs / 60), ss = gs % 60;
    return (mm < 10 ? '0' : '') + mm + (ss < 10 ? '0' : '') + ss;
  }

  var Sim = { HS: HS, IN: IN, WORLD: WORLD, newMatch: newMatch, newPlayer: newPlayer, newBall: newBall, kickoff: kickoff,
              step: step, standY: standY, kickVelocity: kickVelocity, kickAim: kickAim, clockDigits: clockDigits,
              shapesOf: shapesOf, circlePoly: circlePoly,
              packPlayer: packPlayer, unpackPlayer: unpackPlayer, packBall: packBall, unpackBall: unpackBall };
  if (typeof module === 'object' && module.exports) module.exports = Sim;
  else root.HSSim = Sim;
})(typeof self !== 'undefined' ? self : this);
