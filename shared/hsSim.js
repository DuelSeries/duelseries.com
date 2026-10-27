// Head Soccer's rules and physics, one fixed step at a time. The server runs the whole match with it
// (server/HeadSoccerRoom.js); the browser runs the very same player step for its own player (prediction), so a
// key press moves you at once on screen and the server agrees about where you went.
//
// Every number in HS is from docs/head-soccer-reference.md, which says where each one was measured. World units:
// the field is W wide, y grows DOWN (canvas order), the ground line is GROUND_Y.
//
// Sides: seat 0 starts on the LEFT, defends the left goal and shoots right; seat 1 is the mirror.
(function (root) {
  'use strict';

  var HS = {
    STEP: 1 / 60,               // the fixed step, seconds
    W: 1000, H: 600,            // the field, world units (aspect from the reference screenshots)
    GROUND_Y: 520,              // the grass line the players stand on and the ball bounces off
    // Goals: one at each end, from the wall to the mouth (GOAL_D deep), GOAL_H tall, under a crossbar BAR_T thick
    // that reaches BAR_OVER past the mouth. The crossbar is solid: the ball and the players bounce off it and can
    // sit on top of it.
    GOAL_D: 70, GOAL_H: 190, BAR_T: 10, BAR_OVER: 6,
    // The ball.
    BALL_R: 17,
    BALL_G: 1500,               // gravity on the ball, units/s^2
    BALL_E_GROUND: 0.72,        // restitution off the grass
    BALL_E_WALL: 0.7,           // off the side walls, the ceiling and the crossbar
    BALL_ROLL: 0.6,             // horizontal speed kept per second while rolling on the grass
    BALL_AIR: 0.99,             // horizontal speed kept per second in the air
    BALL_MAX: 1800,             // a hard cap on ball speed
    // The players: a big head with one boot under its front edge.
    HEAD_R: 34,
    FOOT_H: 16,                 // boot height under the head (the head's bottom sits FOOT_H above the grass)
    WALK: 330,                  // walking speed, units/s
    JUMP_V: 780,                // take-off speed, units/s
    PLAYER_G: 2100,             // gravity on a player, units/s^2
    START_X: 250,               // seat 0's kick-off x (seat 1 at W - START_X)
    HEAD_E: 0.55,               // restitution of a header (head treated as immovable, moving at the player's speed)
    // The kick: the boot swings up and forward and back down.
    KICK_MS: 220,               // the whole swing
    KICK_UP_MS: 90,             // the part of it that rises (contact counts only here)
    KICK_ANGLE: 1.25,           // radians the boot rises through
    FOOT_PIVOT_X: 10, FOOT_LEN: 30, FOOT_R: 13,
    KICK_SPEED: 1050,           // the ball's speed off a clean kick
    KICK_LIFT: 0.62,            // radians above horizontal a clean kick leaves at
    // The power shot.
    POWER_FULL_S: 10,           // seconds of play to fill an empty gauge
    POWER_TOUCH: 0.05,          // and each touch of the ball adds this much
    POWER_RANGE: 95,            // how close the ball must be to the boot to fire one
    POWER_SPEED: 1650,          // the ball's speed off a power shot
    POWER_FLAT_MS: 650,         // the power shot flies flat (no gravity) for this long
    STUN_MS: 1200,              // a power shot that hits the other player knocks them down this long
    // The match.
    MATCH_MS: 60000,
    COUNTDOWN_MS: 3000,
    GOAL_PAUSE_MS: 2200,        // "GOAL" on screen, then kick-off again
    DROP_Y: 140,                // a kick-off drops the ball at centre from this height
    TIE: 'draw',                // a level score at full time: 'draw' (refund on a paid table) or 'golden' (next goal wins)
  };

  // Input bits held down; jump, kick and power are presses, counted (see press()).
  var IN = { LEFT: 1, RIGHT: 2 };

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  function newPlayer(side) {
    return {
      side: side, dir: side === 0 ? 1 : -1,
      x: side === 0 ? HS.START_X : HS.W - HS.START_X,
      y: HS.GROUND_Y - HS.FOOT_H - HS.HEAD_R,
      vx: 0, vy: 0, ground: true,
      kickMs: -1,                // ms into the current swing, -1 when the boot is down
      kickHit: false,            // this swing already struck the ball
      power: 0,                  // 0..1
      powerArmed: false,         // power pressed with a full gauge: the next touch in range fires it
      stunMs: 0,
      held: 0,                   // IN bits
      jumps: 0, kicks: 0, powers: 0,   // press counters already acted on
    };
  }

  function newBall() {
    return { x: HS.W / 2, y: HS.DROP_Y, vx: 0, vy: 0, rot: 0, flatMs: 0, powerBy: -1, lastTouch: -1 };
  }

  function newMatch() {
    return { p: [newPlayer(0), newPlayer(1)], ball: newBall(), score: [0, 0], msLeft: HS.MATCH_MS, tick: 0 };
  }

  function kickoff(m) {
    var a = newPlayer(0), b = newPlayer(1);
    for (var s = 0; s < 2; s++) {
      var q = s === 0 ? a : b, o = m.p[s];
      q.power = o.power; q.held = o.held; q.jumps = o.jumps; q.kicks = o.kicks; q.powers = o.powers;
      m.p[s] = q;
    }
    m.ball = newBall();
  }

  // Where the boot's toe circle is right now, and how fast it is moving (for the kick contact).
  function footAt(p) {
    var a = 0;
    if (p.kickMs >= 0) {
      var t = p.kickMs;
      a = t < HS.KICK_UP_MS ? HS.KICK_ANGLE * (t / HS.KICK_UP_MS)
        : HS.KICK_ANGLE * Math.max(0, 1 - (t - HS.KICK_UP_MS) / (HS.KICK_MS - HS.KICK_UP_MS));
    }
    var px = p.x + p.dir * HS.FOOT_PIVOT_X, py = p.y + HS.HEAD_R + HS.FOOT_H * 0.5;
    return { x: px + p.dir * Math.cos(a) * HS.FOOT_LEN, y: py - Math.sin(a) * HS.FOOT_LEN, a: a,
             rising: p.kickMs >= 0 && p.kickMs < HS.KICK_UP_MS };
  }

  function feetY(p) { return p.y + HS.HEAD_R + HS.FOOT_H; }

  // The two crossbars as boxes: [x0, y0, x1, y1].
  function bars() {
    var top = HS.GROUND_Y - HS.GOAL_H - HS.BAR_T, bot = HS.GROUND_Y - HS.GOAL_H, reach = HS.GOAL_D + HS.BAR_OVER;
    return [[0, top, reach, bot], [HS.W - reach, top, HS.W, bot]];
  }
  var BARS = null;
  function barBoxes() { return BARS || (BARS = bars()); }

  // One player's step from its input: walking, jumping, the boot, the gauge. No ball and no other player here;
  // that is the part the browser can run for its own player as well.
  //   inp: { held, jumps, kicks, powers } — held bits and running press counts (counts only ever go up).
  function stepPlayer(p, inp, dt) {
    var ms = dt * 1000;
    if (inp) {
      p.held = inp.held | 0;
      if (inp.jumps > p.jumps) { p.jumps = inp.jumps; if (p.ground && p.stunMs <= 0) { p.vy = -HS.JUMP_V; p.ground = false; } }
      if (inp.kicks > p.kicks) { p.kicks = inp.kicks; if (p.kickMs < 0 && p.stunMs <= 0) { p.kickMs = 0; p.kickHit = false; } }
      if (inp.powers > p.powers) { p.powers = inp.powers; if (p.power >= 1 && p.stunMs <= 0) p.powerArmed = true; }
    }
    if (p.stunMs > 0) { p.stunMs = Math.max(0, p.stunMs - ms); p.vx = 0; }
    else {
      var want = ((p.held & IN.RIGHT) ? 1 : 0) - ((p.held & IN.LEFT) ? 1 : 0);
      p.vx = want * HS.WALK;
    }
    p.vy += HS.PLAYER_G * dt;
    p.x += p.vx * dt; p.y += p.vy * dt;
    // The grass.
    var floor = HS.GROUND_Y - HS.FOOT_H - HS.HEAD_R;
    p.ground = false;
    if (p.y >= floor) { p.y = floor; p.vy = 0; p.ground = true; }
    // The walls behind the goals.
    p.x = clamp(p.x, HS.HEAD_R, HS.W - HS.HEAD_R);
    // The crossbars: a head bumps the underside, a player lands on top.
    var bb = barBoxes();
    for (var i = 0; i < 2; i++) {
      var b = bb[i];
      if (p.x + HS.HEAD_R * 0.6 < b[0] || p.x - HS.HEAD_R * 0.6 > b[2]) continue;
      var fy = feetY(p), headTop = p.y - HS.HEAD_R;
      if (p.vy >= 0 && fy >= b[1] && fy - p.vy * dt <= b[1] + 1) { p.y = b[1] - HS.FOOT_H - HS.HEAD_R; p.vy = 0; p.ground = true; }
      else if (p.vy < 0 && headTop <= b[3] && headTop - p.vy * dt >= b[3] - 1) { p.y = b[3] + HS.HEAD_R; p.vy = 0; }
    }
    if (p.kickMs >= 0) { p.kickMs += ms; if (p.kickMs >= HS.KICK_MS) p.kickMs = -1; }
  }

  // Push two heads apart, sideways only, half each.
  function collidePlayers(a, b) {
    var dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy), min = HS.HEAD_R * 2;
    if (d >= min || d === 0) return;
    var push = (min - d) / 2, nx = dx / d;
    a.x -= nx * push; b.x += nx * push;
    a.x = clamp(a.x, HS.HEAD_R, HS.W - HS.HEAD_R); b.x = clamp(b.x, HS.HEAD_R, HS.W - HS.HEAD_R);
  }

  // Ball against a circle moving at (vx, vy) that the ball cannot move. Returns the closing speed of the contact
  // (0 for a ball merely resting against it), or -1 for no contact.
  function bounceOffCircle(ball, cx, cy, r, vx, vy, e) {
    var dx = ball.x - cx, dy = ball.y - cy, d = Math.hypot(dx, dy), min = r + HS.BALL_R;
    if (d >= min) return -1;
    if (d === 0) { dx = 0; dy = -1; d = 1; }
    var nx = dx / d, ny = dy / d;
    ball.x = cx + nx * min; ball.y = cy + ny * min;
    var rvx = ball.vx - vx, rvy = ball.vy - vy, vn = rvx * nx + rvy * ny;
    if (vn < 0) { ball.vx -= (1 + e) * vn * nx; ball.vy -= (1 + e) * vn * ny; return -vn; }
    return 0;
  }

  // A touch worth a sound and a sliver of power: a real hit, not a ball rolling along a head.
  var TOUCH_SPEED = 160;

  // Ball against a box (a crossbar).
  function bounceOffBox(ball, b, e) {
    var cx = clamp(ball.x, b[0], b[2]), cy = clamp(ball.y, b[1], b[3]);
    var dx = ball.x - cx, dy = ball.y - cy, d = Math.hypot(dx, dy);
    if (d >= HS.BALL_R) return false;
    var nx, ny;
    if (d === 0) { nx = 0; ny = ball.y < (b[1] + b[3]) / 2 ? -1 : 1; d = 0; }
    else { nx = dx / d; ny = dy / d; }
    ball.x = cx + nx * HS.BALL_R; ball.y = cy + ny * HS.BALL_R;
    var vn = ball.vx * nx + ball.vy * ny;
    if (vn < 0) { ball.vx -= (1 + e) * vn * nx; ball.vy -= (1 + e) * vn * ny; }
    return true;
  }

  function capBall(ball) {
    var s = Math.hypot(ball.vx, ball.vy);
    if (s > HS.BALL_MAX) { ball.vx *= HS.BALL_MAX / s; ball.vy *= HS.BALL_MAX / s; }
  }

  function addPower(p, v) { p.power = Math.min(1, p.power + v); }

  // A player's touch on the ball; `kick` is a rising boot, else a head or a resting boot.
  function touch(m, p, ev, kick) {
    var ball = m.ball;
    ball.lastTouch = p.side;
    if (p.powerArmed) {
      var f = footAt(p);
      if (Math.hypot(ball.x - f.x, ball.y - f.y) <= HS.POWER_RANGE + HS.BALL_R) {
        p.powerArmed = false; p.power = 0;
        ball.vx = p.dir * HS.POWER_SPEED; ball.vy = 0;
        ball.flatMs = HS.POWER_FLAT_MS; ball.powerBy = p.side;
        ev.push({ e: 'power', s: p.side });
        return;
      }
    }
    addPower(p, HS.POWER_TOUCH);
    if (kick) {
      ball.vx = p.dir * Math.cos(HS.KICK_LIFT) * HS.KICK_SPEED + p.vx * 0.3;
      ball.vy = -Math.sin(HS.KICK_LIFT) * HS.KICK_SPEED + Math.min(0, p.vy) * 0.3;
      ev.push({ e: 'kick', s: p.side });
    }
  }

  // The whole match, one step. inputs[side] as stepPlayer takes them. `live` false freezes the clock and scoring
  // (the goal pause): the ball still rolls in the net. Returns the events of this step: kick, head, power, post,
  // bounce, goal { s: who scored }, stun { s: who went down }.
  function step(m, inputs, dt, live) {
    var ev = [], ball = m.ball, i, p;
    m.tick++;
    for (i = 0; i < 2; i++) stepPlayer(m.p[i], inputs ? inputs[i] : null, dt);
    collidePlayers(m.p[0], m.p[1]);
    if (live) {
      m.msLeft = Math.max(0, m.msLeft - dt * 1000);
      for (i = 0; i < 2; i++) if (m.p[i].stunMs <= 0) addPower(m.p[i], dt / HS.POWER_FULL_S);
    }

    // The ball flies.
    if (ball.flatMs > 0) ball.flatMs = Math.max(0, ball.flatMs - dt * 1000);
    else ball.vy += HS.BALL_G * dt;
    ball.x += ball.vx * dt; ball.y += ball.vy * dt;
    var onGrass = false;
    if (ball.y + HS.BALL_R >= HS.GROUND_Y) {
      ball.y = HS.GROUND_Y - HS.BALL_R;
      if (ball.vy > 0) {
        if (ball.vy > 120) ev.push({ e: 'bounce' });
        ball.vy = ball.vy > 60 ? -ball.vy * HS.BALL_E_GROUND : 0;
      }
      onGrass = ball.vy === 0;
    }
    if (ball.y - HS.BALL_R <= 0) { ball.y = HS.BALL_R; if (ball.vy < 0) ball.vy = -ball.vy * HS.BALL_E_WALL; }
    if (ball.x - HS.BALL_R <= 0) { ball.x = HS.BALL_R; if (ball.vx < 0) ball.vx = -ball.vx * HS.BALL_E_WALL; }
    if (ball.x + HS.BALL_R >= HS.W) { ball.x = HS.W - HS.BALL_R; if (ball.vx > 0) ball.vx = -ball.vx * HS.BALL_E_WALL; }
    var bb = barBoxes();
    for (i = 0; i < 2; i++) if (bounceOffBox(ball, bb[i], HS.BALL_E_WALL)) { ev.push({ e: 'post' }); ball.flatMs = 0; }
    ball.vx *= Math.pow(onGrass ? HS.BALL_ROLL : HS.BALL_AIR, dt);

    // Players on the ball: the boot first (a kick beats a header), then the heads.
    for (i = 0; i < 2; i++) {
      p = m.p[i];
      var f = footAt(p);
      var fvx = p.vx, fvy = p.vy;
      var hitF = bounceOffCircle(ball, f.x, f.y, HS.FOOT_R, fvx, fvy, HS.HEAD_E);
      if (hitF >= 0) {
        var kick = f.rising && !p.kickHit;
        if (kick) p.kickHit = true;
        // A power shot that meets the player it was fired at knocks them down instead of being stopped quietly.
        if (ball.powerBy >= 0 && ball.powerBy !== p.side && ball.flatMs > 0) stun(p, ev);
        if (kick || hitF > TOUCH_SPEED || p.powerArmed) touch(m, p, ev, kick);
      }
      var hitH = bounceOffCircle(ball, p.x, p.y, HS.HEAD_R, p.vx, p.vy, HS.HEAD_E);
      if (hitH >= 0) {
        if (ball.powerBy >= 0 && ball.powerBy !== p.side && ball.flatMs > 0) stun(p, ev);
        else if (hitH > TOUCH_SPEED) ev.push({ e: 'head', s: p.side });
        if (hitH > TOUCH_SPEED || p.powerArmed) touch(m, p, ev, false);
      }
    }
    capBall(ball);
    ball.rot += (ball.vx * dt) / HS.BALL_R;

    // A goal: the whole ball past the mouth, under the bar.
    if (live && ball.y - HS.BALL_R > HS.GROUND_Y - HS.GOAL_H) {
      if (ball.x + HS.BALL_R < HS.GOAL_D) { m.score[1]++; ev.push({ e: 'goal', s: 1 }); }
      else if (ball.x - HS.BALL_R > HS.W - HS.GOAL_D) { m.score[0]++; ev.push({ e: 'goal', s: 0 }); }
    }
    return ev;
  }

  function stun(p, ev) {
    if (p.stunMs > 0) return;
    p.stunMs = HS.STUN_MS; p.kickMs = -1; p.powerArmed = false;
    ev.push({ e: 'stun', s: p.side });
  }

  // ── the wire: one snapshot as small integer arrays (positions to a tenth of a unit) ────────────────────────
  var r10 = function (v) { return Math.round(v * 10); };
  function packPlayer(p) {
    var flags = (p.ground ? 1 : 0) | (p.powerArmed ? 2 : 0) | (p.stunMs > 0 ? 4 : 0);
    return [r10(p.x), r10(p.y), r10(p.vx), r10(p.vy), flags, Math.round(p.kickMs), Math.round(p.power * 1000)];
  }
  function unpackPlayer(a, side) {
    var p = newPlayer(side);
    p.x = a[0] / 10; p.y = a[1] / 10; p.vx = a[2] / 10; p.vy = a[3] / 10;
    p.ground = !!(a[4] & 1); p.powerArmed = !!(a[4] & 2); p.stunMs = (a[4] & 4) ? 1 : 0;
    p.kickMs = a[5]; p.power = a[6] / 1000;
    return p;
  }
  function packBall(b) { return [r10(b.x), r10(b.y), r10(b.vx), r10(b.vy), Math.round(b.rot * 100), b.flatMs > 0 ? 1 : 0]; }
  function unpackBall(a) {
    var b = newBall();
    b.x = a[0] / 10; b.y = a[1] / 10; b.vx = a[2] / 10; b.vy = a[3] / 10; b.rot = a[4] / 100; b.flatMs = a[5] ? 1 : 0;
    return b;
  }

  var Sim = { HS: HS, IN: IN, newMatch: newMatch, newPlayer: newPlayer, newBall: newBall, kickoff: kickoff,
              stepPlayer: stepPlayer, step: step, footAt: footAt, barBoxes: barBoxes,
              packPlayer: packPlayer, unpackPlayer: unpackPlayer, packBall: packBall, unpackBall: unpackBall };
  if (typeof module === 'object' && module.exports) module.exports = Sim;
  else root.HSSim = Sim;
})(typeof self !== 'undefined' ? self : this);
