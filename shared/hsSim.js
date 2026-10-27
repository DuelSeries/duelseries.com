// Head Soccer's rules and physics, one fixed step at a time. The server runs the whole match with it
// (server/HeadSoccerRoom.js); the browser runs the very same player step for its own player (prediction), so a
// key press moves you at once on screen and the server agrees about where you went.
//
// UNITS ARE THE REFERENCE'S PIXELS. The field is the measured game frame, 1196 x 720 (docs/head-soccer-reference.md,
// source V2), so every number below is the measured one as it was measured, with no conversion to get wrong. y grows
// DOWN (canvas order). Each constant says where it came from: measured (M), derived from measured values (D), the
// wiki (Wk), or CHOSEN where the reference could not be measured (the doc lists those as UNKNOWN).
//
// Sides: seat 0 starts on the LEFT, defends the left goal and shoots right; seat 1 is the mirror.
(function (root) {
  'use strict';

  var G = 705;                       // M: ball gravity 705 +-20 px/s^2; player gravity measured 740, within 5%: one world (Box2D)
  var JUMP_H = 70;                   // M: head top 506 -> 436

  var HS = {
    STEP: 1 / 60,
    W: 1196, H: 720,                 // M: the game frame
    GROUND_Y: 598,                   // M: boot soles standing
    BALL_FLOOR_Y: 576,               // M: ball centre resting on the grass, 574 to 578
    // Goals: from the wall to the mouth, under a solid crossbar.
    GOAL_D: 66,                      // M: 0..66 and 1130..1196
    BAR_Y: 404,                      // M: goal top edge (crossbar underside), 194 above the soles
    BAR_T: 9,                        // M (by eye, low confidence): white bar 8 to 10 px
    BALL_R: 18.5,                    // M: 37 +-2 px across
    G: G,
    BALL_E: 0.64,                    // M: ground restitution 0.64 +-0.04; Box2D mixes restitution as the max, so the
                                     //    ball's 0.64 holds off every surface it meets (D)
    BALL_DAMP: 0.07,                 // D: in-air x curvature -35 px/s^2 at 341 px/s -> linear damping 0.1/s; 0.07 is
                                     //    the same within the fit (negligible either way)
    BALL_MAX: 1400,                  // CHOSEN: a cap far above anything measured (870 max seen)
    // The players: a big head over tiny boots.
    HEAD_W: 80, HEAD_HT: 70,         // M: head box 80 x 70
    HEAD_R: 37.5,                    // D: the collider circle, mean of the measured half-width and half-height
    BODY_H: 22,                      // M: boots and neck band under the head (player 92 tall)
    WALK: 315,                       // M: 315 +-10 px/s
    WALK_ACCEL: 3150,                // D: full speed within about 0.1 s
    JUMP_V: Math.sqrt(2 * G * JUMP_H), // D: 314 px/s (airtime 0.89 s vs 0.87 +-0.03 measured)
    START_X: 248,                    // M: 248 and 948 (= W - 248)
    X_MIN: 86, X_MAX: 1110,          // M: head box 46..1150, so the head centre stays 86..1110
    // The kick. Its swing could not be measured from 30 fps video (doc: kick impulse UNKNOWN); these are CHOSEN so
    // the ball leaves at the measured speeds: a ground ball off a standing kick at 513 to 520 px/s with a slight lift
    // (vy about -90), typical launches 520 to 700, the fastest flights 800 to 870.
    KICK_MS: 200, KICK_UP_MS: 90, KICK_ANGLE: 1.1,
    FOOT_X: 14, FOOT_LEN: 26, FOOT_R: 12,
    KICK_SPEED: 520,                 // M: the measured standing kick
    KICK_LIFT_LOW: 0.17,             // M: atan(90/513), a ball met low on the boot
    KICK_LIFT_HIGH: 0.75,            // CHOSEN: a ball met at the top of the swing goes up more steeply
    KICK_CARRY: 0.5,                 // CHOSEN: share of the player's own speed added (a running kick reaches ~680)
    // The power shot.
    POWER_FILL_S: 20,                // M: empty to full in about 20 s of clock (19 to 23), linear
    POWER_FREEZE_MS: 900,            // M: the lightning cutscene, about 0.9 s, everything stops
    POWER_SPEED: 870,                // CHOSEN: South Korea's straight shot speed is UNKNOWN; the fastest flight seen
    // The match.
    MATCH_MS: 60000,                 // M: 1:00
    COUNTDOWN_MS: 3000,              // CHOSEN: "KICK OFF" shows at the start (M), its length was not measured
    GOAL_PAUSE_MS: 2000,             // M: the clock stops 1.5 to 2.5 s per goal while the ball keeps rolling
    DROP_X: 598, DROP_Y: 226.5,      // M: ball appears at (600, 226.5) at rest; x is W/2 here so neither side is nearer
    TIE: 'golden',                   // Wk: level at 0:00 is sudden death, no time limit, first goal wins
    GOLDEN_MAX_MS: 300000,           // CHOSEN: a safety stop, never seen in play: 5 minutes of sudden death is a draw
  };

  var IN = { LEFT: 1, RIGHT: 2 };

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function standY() { return HS.GROUND_Y - HS.BODY_H - HS.HEAD_HT / 2; }   // head centre standing: 541

  function newPlayer(side) {
    return {
      side: side, dir: side === 0 ? 1 : -1,
      x: side === 0 ? HS.START_X : HS.W - HS.START_X, y: standY(),
      vx: 0, vy: 0, ground: true,
      kickMs: -1,                // ms into the current swing, -1 when the boot is down
      kickHit: false,            // this swing already struck the ball
      power: 0,                  // 0..1
      powerArmed: false,         // power pressed with a full gauge: the next touch of the ball is the power shot
      held: 0,                   // IN bits
      jumps: 0, kicks: 0, powers: 0,   // press counters already acted on
    };
  }

  function newBall() {
    return { x: HS.DROP_X, y: HS.DROP_Y, vx: 0, vy: 0, rot: 0, straight: false, powerBy: -1 };
  }

  function newMatch() {
    return { p: [newPlayer(0), newPlayer(1)], ball: newBall(), score: [0, 0], msLeft: HS.MATCH_MS, goldenMs: 0,
             tick: 0, freezeMs: 0 };
  }

  // Back to the kick-off spots with a new ball dropping at centre. Gauges, presses and the armed shot carry over.
  function kickoff(m) {
    for (var s = 0; s < 2; s++) {
      var o = m.p[s], q = newPlayer(s);
      q.power = o.power; q.powerArmed = o.powerArmed; q.held = o.held;
      q.jumps = o.jumps; q.kicks = o.kicks; q.powers = o.powers;
      m.p[s] = q;
    }
    m.ball = newBall();
  }

  // Where the boot's toe circle is right now, and whether the boot is on its way up.
  function footAt(p) {
    var a = 0;
    if (p.kickMs >= 0) {
      var t = p.kickMs;
      a = t < HS.KICK_UP_MS ? HS.KICK_ANGLE * (t / HS.KICK_UP_MS)
        : HS.KICK_ANGLE * Math.max(0, 1 - (t - HS.KICK_UP_MS) / (HS.KICK_MS - HS.KICK_UP_MS));
    }
    var px = p.x + p.dir * HS.FOOT_X, py = p.y + HS.HEAD_HT / 2 + HS.BODY_H - HS.FOOT_R;
    return { x: px + p.dir * Math.cos(a) * HS.FOOT_LEN * 0.5, y: py - Math.sin(a) * HS.FOOT_LEN, a: a,
             rising: p.kickMs >= 0 && p.kickMs < HS.KICK_UP_MS };
  }

  // The two crossbars as boxes: [x0, y0, x1, y1].
  var BARS = null;
  function barBoxes() {
    if (BARS) return BARS;
    var top = HS.BAR_Y - HS.BAR_T, bot = HS.BAR_Y;
    return (BARS = [[0, top, HS.GOAL_D, bot], [HS.W - HS.GOAL_D, top, HS.W, bot]]);
  }

  // One player's step from its input: walking, jumping, the boot. No ball and no other player here; that is the
  // part the browser can run for its own player as well.
  //   inp: { held, jumps, kicks, powers } — held bits and running press counts (counts only ever go up).
  function stepPlayer(p, inp, dt, canCharge) {
    var ms = dt * 1000;
    if (inp) {
      p.held = inp.held | 0;
      if (inp.jumps > p.jumps) { p.jumps = inp.jumps; if (p.ground) { p.vy = -HS.JUMP_V; p.ground = false; } }
      if (inp.kicks > p.kicks) { p.kicks = inp.kicks; if (p.kickMs < 0) { p.kickMs = 0; p.kickHit = false; } }
      if (inp.powers > p.powers) { p.powers = inp.powers; if (p.power >= 1) p.powerArmed = true; }
    }
    var want = (((p.held & IN.RIGHT) ? 1 : 0) - ((p.held & IN.LEFT) ? 1 : 0)) * HS.WALK;
    var dv = HS.WALK_ACCEL * dt;
    p.vx = p.vx < want ? Math.min(want, p.vx + dv) : Math.max(want, p.vx - dv);
    p.vy += HS.G * dt;
    p.x += p.vx * dt; p.y += p.vy * dt;
    p.ground = false;
    if (p.y >= standY()) { p.y = standY(); p.vy = 0; p.ground = true; }
    if (p.x < HS.X_MIN) { p.x = HS.X_MIN; if (p.vx < 0) p.vx = 0; }
    if (p.x > HS.X_MAX) { p.x = HS.X_MAX; if (p.vx > 0) p.vx = 0; }
    if (p.kickMs >= 0) { p.kickMs += ms; if (p.kickMs >= HS.KICK_MS) p.kickMs = -1; }
    if (canCharge && !p.powerArmed) p.power = Math.min(1, p.power + dt / HS.POWER_FILL_S);
  }

  // Two heads are solid: pushed apart along the line between them, and one coming down on the other stands on it.
  function collidePlayers(a, b) {
    var dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy), min = HS.HEAD_R * 2;
    if (d >= min) return;
    if (d === 0) { dx = 1; dy = 0; d = 1; }
    var nx = dx / d, ny = dy / d, push = (min - d) / 2;
    var top = ny > 0.6 ? a : ny < -0.6 ? b : null;     // a head well above the other is on top of it
    if (top) {
      var under = top === a ? b : a;
      var ddx = top.x - under.x;
      top.y = under.y - Math.sqrt(Math.max(0, min * min - ddx * ddx)) - 0.01;
      if (top.vy > 0) top.vy = 0;
      top.ground = true;
      top.x += (top === a ? -nx : nx) * push * 0.5;
    } else {
      a.x -= nx * push; b.x += nx * push;
    }
    a.x = clamp(a.x, HS.X_MIN, HS.X_MAX); b.x = clamp(b.x, HS.X_MIN, HS.X_MAX);
  }

  // Ball against a circle moving at (vx, vy) that the ball cannot move. Returns the closing speed of the contact
  // (0 for a ball merely resting against it), or -1 for no contact.
  function bounceOffCircle(ball, cx, cy, r, vx, vy) {
    var dx = ball.x - cx, dy = ball.y - cy, d = Math.hypot(dx, dy), min = r + HS.BALL_R;
    if (d >= min) return -1;
    if (d === 0) { dx = 0; dy = -1; d = 1; }
    var nx = dx / d, ny = dy / d;
    ball.x = cx + nx * min; ball.y = cy + ny * min;
    var rvx = ball.vx - vx, rvy = ball.vy - vy, vn = rvx * nx + rvy * ny;
    if (vn < 0) { ball.vx -= (1 + HS.BALL_E) * vn * nx; ball.vy -= (1 + HS.BALL_E) * vn * ny; return -vn; }
    return 0;
  }

  // Ball against a box (a crossbar). Returns true on contact.
  function bounceOffBox(ball, b) {
    var cx = clamp(ball.x, b[0], b[2]), cy = clamp(ball.y, b[1], b[3]);
    var dx = ball.x - cx, dy = ball.y - cy, d = Math.hypot(dx, dy);
    if (d >= HS.BALL_R) return false;
    var nx, ny;
    if (d === 0) { nx = 0; ny = ball.y < (b[1] + b[3]) / 2 ? -1 : 1; }
    else { nx = dx / d; ny = dy / d; }
    ball.x = cx + nx * HS.BALL_R; ball.y = cy + ny * HS.BALL_R;
    var vn = ball.vx * nx + ball.vy * ny;
    if (vn < 0) { ball.vx -= (1 + HS.BALL_E) * vn * nx; ball.vy -= (1 + HS.BALL_E) * vn * ny; }
    return true;
  }

  // A touch worth a sound: a real hit, not a ball rolling along a head.
  var TOUCH_SPEED = 120;

  // The power shot leaves the touch point flat and fast toward the far goal, and stays flat until it meets anything.
  function firePower(m, p, ev) {
    var ball = m.ball;
    p.powerArmed = false; p.power = 0;
    ball.vx = p.dir * HS.POWER_SPEED; ball.vy = 0;
    ball.straight = true; ball.powerBy = p.side;
    m.freezeMs = HS.POWER_FREEZE_MS;
    ev.push({ e: 'power', s: p.side });
  }

  function endStraight(ball) { ball.straight = false; ball.powerBy = -1; }

  // The whole match, one step. inputs[side] as stepPlayer takes them. `live` false freezes the clock, the gauges
  // and scoring (the goal pause): the ball still rolls in the net. A power shot freezes everything for its cutscene
  // (m.freezeMs). Returns the events of this step: kick, head, power, post, bounce, goal { s: who scored }.
  function step(m, inputs, dt, live) {
    var ev = [], ball = m.ball, i, p;
    m.tick++;
    if (m.freezeMs > 0) { m.freezeMs = Math.max(0, m.freezeMs - dt * 1000); return ev; }
    var golden = live && m.msLeft <= 0;
    for (i = 0; i < 2; i++) stepPlayer(m.p[i], inputs ? inputs[i] : null, dt, live && !golden);
    collidePlayers(m.p[0], m.p[1]);
    if (live) {
      if (m.msLeft > 0) m.msLeft = Math.max(0, m.msLeft - dt * 1000);
      else m.goldenMs += dt * 1000;
    }

    // The ball flies.
    if (!ball.straight) ball.vy += HS.G * dt;
    var damp = Math.exp(-HS.BALL_DAMP * dt);
    ball.vx *= damp; if (!ball.straight) ball.vy *= damp;
    ball.x += ball.vx * dt; ball.y += ball.vy * dt;
    if (ball.y >= HS.BALL_FLOOR_Y) {
      ball.y = HS.BALL_FLOOR_Y;
      if (ball.vy > 0) {
        if (ball.vy > 120) ev.push({ e: 'bounce' });
        ball.vy = ball.vy > 40 ? -ball.vy * HS.BALL_E : 0;
      }
      if (ball.straight) endStraight(ball);
    }
    if (ball.y - HS.BALL_R <= 0) { ball.y = HS.BALL_R; if (ball.vy < 0) ball.vy = -ball.vy * HS.BALL_E; endStraight(ball); }
    if (ball.x - HS.BALL_R <= 0) { ball.x = HS.BALL_R; if (ball.vx < 0) ball.vx = -ball.vx * HS.BALL_E; endStraight(ball); }
    if (ball.x + HS.BALL_R >= HS.W) { ball.x = HS.W - HS.BALL_R; if (ball.vx > 0) ball.vx = -ball.vx * HS.BALL_E; endStraight(ball); }
    var bb = barBoxes();
    for (i = 0; i < 2; i++) if (bounceOffBox(ball, bb[i])) { ev.push({ e: 'post' }); endStraight(ball); }

    // Players on the ball: the boot first (a kick beats a header), then the head.
    for (i = 0; i < 2; i++) {
      p = m.p[i];
      var f = footAt(p);
      var was = ball.straight && ball.powerBy !== p.side;    // somebody else's power shot arriving
      var hitF = bounceOffCircle(ball, f.x, f.y, HS.FOOT_R, p.vx, p.vy);
      if (hitF >= 0) {
        if (was) endStraight(ball);
        var kick = f.rising && !p.kickHit;
        if (kick) p.kickHit = true;
        if (p.powerArmed && (kick || hitF > TOUCH_SPEED || hitF === 0)) firePower(m, p, ev);
        else if (kick) {
          // Low on the boot goes out nearly flat (the measured kick), high on it goes up more steeply.
          var up = clamp((f.y - ball.y) / (HS.FOOT_R + HS.BALL_R), 0, 1);
          var lift = HS.KICK_LIFT_LOW + (HS.KICK_LIFT_HIGH - HS.KICK_LIFT_LOW) * up;
          ball.vx = p.dir * Math.cos(lift) * HS.KICK_SPEED + p.vx * HS.KICK_CARRY;
          ball.vy = -Math.sin(lift) * HS.KICK_SPEED + Math.min(0, p.vy) * HS.KICK_CARRY;
          ev.push({ e: 'kick', s: p.side });
        }
      }
      var hitH = bounceOffCircle(ball, p.x, p.y, HS.HEAD_R, p.vx, p.vy);
      if (hitH >= 0) {
        if (was) endStraight(ball);
        if (p.powerArmed && (hitH > TOUCH_SPEED || hitH === 0)) firePower(m, p, ev);
        else if (hitH > TOUCH_SPEED) ev.push({ e: 'head', s: p.side });
      }
    }
    var s = Math.hypot(ball.vx, ball.vy);
    if (s > HS.BALL_MAX) { ball.vx *= HS.BALL_MAX / s; ball.vy *= HS.BALL_MAX / s; }
    ball.rot += (ball.vx * dt) / HS.BALL_R;

    // A goal: the whole ball past the mouth (under the bar, which is solid, so nothing else can be there).
    if (live && ball.y > HS.BAR_Y) {
      var scored = ball.x + HS.BALL_R < HS.GOAL_D ? 1 : ball.x - HS.BALL_R > HS.W - HS.GOAL_D ? 0 : -1;
      if (scored >= 0) {
        m.score[scored]++;
        // M: being scored on fills the conceding side's gauge (seen 2 of 2, from 86% and 66%). Not in sudden death,
        // where gauges do not charge (Wk), and moot then anyway: the goal ends it.
        if (!golden) m.p[1 - scored].power = 1;
        ev.push({ e: 'goal', s: scored });
      }
    }
    return ev;
  }

  // ── the wire: one snapshot as small integer arrays (positions to a tenth of a unit) ────────────────────────
  var r10 = function (v) { return Math.round(v * 10); };
  function packPlayer(p) {
    var flags = (p.ground ? 1 : 0) | (p.powerArmed ? 2 : 0);
    // The press counts the server has acted on ride along, so a page replaying its own presses on top of this state
    // (prediction) replays only the ones the server has not seen yet.
    return [r10(p.x), r10(p.y), r10(p.vx), r10(p.vy), flags, Math.round(p.kickMs), Math.round(p.power * 1000),
            p.jumps, p.kicks, p.powers, p.kickHit ? 1 : 0];
  }
  function unpackPlayer(a, side) {
    var p = newPlayer(side);
    p.x = a[0] / 10; p.y = a[1] / 10; p.vx = a[2] / 10; p.vy = a[3] / 10;
    p.ground = !!(a[4] & 1); p.powerArmed = !!(a[4] & 2);
    p.kickMs = a[5]; p.power = a[6] / 1000;
    p.jumps = a[7] | 0; p.kicks = a[8] | 0; p.powers = a[9] | 0; p.kickHit = !!a[10];
    return p;
  }
  function packBall(b) { return [r10(b.x), r10(b.y), r10(b.vx), r10(b.vy), Math.round(b.rot * 100), b.straight ? 1 : 0]; }
  function unpackBall(a) {
    var b = newBall();
    b.x = a[0] / 10; b.y = a[1] / 10; b.vx = a[2] / 10; b.vy = a[3] / 10; b.rot = a[4] / 100; b.straight = !!a[5];
    return b;
  }

  var Sim = { HS: HS, IN: IN, newMatch: newMatch, newPlayer: newPlayer, newBall: newBall, kickoff: kickoff,
              stepPlayer: stepPlayer, step: step, footAt: footAt, barBoxes: barBoxes, standY: standY,
              packPlayer: packPlayer, unpackPlayer: unpackPlayer, packBall: packBall, unpackBall: unpackBall };
  if (typeof module === 'object' && module.exports) module.exports = Sim;
  else root.HSSim = Sim;
})(typeof self !== 'undefined' ? self : this);
