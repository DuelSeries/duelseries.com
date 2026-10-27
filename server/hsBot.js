'use strict';
/* ─── The free table's Head Soccer opponent ───────────────────────────────────
   It presses the same buttons a person does, through the same input the room
   reads from a socket, so it can do nothing a player cannot: walk, jump, kick,
   and fire the power shot once its gauge is full.

   How it plays: it reads the ball every 70 to 140 ms (a person's reaction, and
   between reads it keeps doing what it decided), works out where the ball will
   come down, and gets BEHIND it, on its own goal's side, so that a kick sends
   it the right way. When the ball is coming at its goal and it cannot get
   behind it in time, it falls back to the goal mouth and jumps for anything
   high. It kicks what is in front of its boot, heads what drops onto it, and
   fires the power shot when the ball sits in front of it facing the open
   goal. It hesitates now and then and its timing is never exact, so it can be
   beaten by a player who reads it. */

const Sim = require('../shared/hsSim');
const { HS, IN } = Sim;

// Where the ball will be after `t` seconds, ignoring players: gravity, the grass and the walls.
function ballAfter(b, t) {
  let x = b.x, y = b.y, vx = b.vx, vy = b.vy, flat = b.flatMs / 1000;
  const dt = 1 / 30;
  for (let s = 0; s < t; s += dt) {
    if (flat > 0) flat -= dt; else vy += HS.BALL_G * dt;
    x += vx * dt; y += vy * dt;
    if (y + HS.BALL_R > HS.GROUND_Y) { y = HS.GROUND_Y - HS.BALL_R; vy = vy > 60 ? -vy * HS.BALL_E_GROUND : 0; }
    if (x < HS.BALL_R) { x = HS.BALL_R; vx = -vx * HS.BALL_E_WALL; }
    if (x > HS.W - HS.BALL_R) { x = HS.W - HS.BALL_R; vx = -vx * HS.BALL_E_WALL; }
  }
  return { x, y, vx, vy };
}

function think(room, bot, me, foe, now) {
  const ball = room.match.ball;
  const dir = me.dir;                                   // the way it attacks
  const goalX = me.side === 0 ? 0 : HS.W;               // the goal it defends
  const plan = { move: 0, jump: false, kick: false, power: false };

  // Where the ball comes into reach: the first moment it is low enough to play and the bot can get there.
  let aim = ballAfter(ball, 0.25);
  for (let t = 0.05; t <= 1.2; t += 0.05) {
    const f = ballAfter(ball, t);
    const low = f.y > me.y - HS.HEAD_R * 2.2;
    if (low && Math.abs(f.x - me.x) / HS.WALK <= t + 0.05) { aim = f; break; }
  }

  // Ahead (toward the goal it attacks) of the ball, or behind it.
  const ahead = (me.x - ball.x) * dir;                  // > 0: between the ball and the far goal (wrong side)
  const towardOwn = ball.vx * -dir > 250;               // the ball is coming back at its goal
  const ballOurHalf = (ball.x - HS.W / 2) * dir < 0;
  const foeCloser = Math.abs(foe.x - ball.x) + 40 < Math.abs(me.x - ball.x);

  let tx;
  if ((towardOwn && ballOurHalf && ahead > 0) || (foeCloser && ballOurHalf && ahead > HS.HEAD_R)) {
    // Too late to get behind it: guard the mouth.
    tx = goalX + dir * (HS.GOAL_D + HS.HEAD_R + 8);
    if (ball.y < me.y - HS.HEAD_R && Math.abs(ball.x - me.x) < 160 && ball.vy > -200) plan.jump = true;
  } else {
    // Behind the ball, close enough that the boot meets it.
    tx = aim.x - dir * (HS.HEAD_R + HS.BALL_R * 0.4);
    if (ahead > -HS.HEAD_R * 0.5 && Math.abs(ball.x - me.x) < HS.HEAD_R * 2.2) {
      // On the wrong side with the ball at its feet: hop over it on the way round.
      tx = ball.x - dir * (HS.HEAD_R * 2.5);
      if (ball.y > me.y && me.ground) plan.jump = Math.random() < 0.5;
    }
  }
  const gap = tx - me.x;
  if (Math.abs(gap) > 6) plan.move = gap > 0 ? 1 : -1;

  // The boot: the ball in front of it, low, close.
  const front = (ball.x - me.x) * dir;
  const reach = HS.FOOT_PIVOT_X + HS.FOOT_LEN + HS.FOOT_R + HS.BALL_R;
  if (front > 0 && front < reach + 14 && ball.y > me.y - HS.HEAD_R * 0.3 && ahead < 0) plan.kick = Math.random() < 0.85;
  // A header: dropping onto it, close.
  if (Math.abs(ball.x - me.x) < HS.HEAD_R * 1.4 && ball.y < me.y - HS.HEAD_R && ball.y > me.y - HS.HEAD_R * 5
      && ball.vy > 0 && me.ground) plan.jump = true;
  // The power shot: full gauge, the ball right in front, facing the goal it attacks.
  if (me.power >= 1 && front > 0 && front < HS.POWER_RANGE && ahead < 0) plan.power = true;

  // A person hesitates sometimes.
  if (Math.random() < 0.07) { plan.move = 0; plan.kick = false; }
  bot.plan = plan;
  bot.nextAt = now + 70 + Math.random() * 70;
}

/* One step's worth of buttons for the bot's seat. */
function drive(room, now, who) {
  const bot = who || room.bot;
  if (!bot || !room.match) return;
  if (room.state !== 'playing' && room.state !== 'countdown') return;
  const side = room.sideOfSocket(bot.id);
  if (side === null) return;
  const me = room.match.p[side], foe = room.match.p[1 - side];
  const inp = room.inputs[side];
  if (room.state === 'countdown') { inp.held = 0; return; }
  if (!bot.nextAt || now >= bot.nextAt) think(room, bot, me, foe, now);
  const plan = bot.plan || { move: 0 };
  inp.held = plan.move > 0 ? IN.RIGHT : plan.move < 0 ? IN.LEFT : 0;
  // Presses: once per think, never held (the room acts on a count going up).
  if (plan.jump) { inp.jumps++; plan.jump = false; }
  if (plan.power) { inp.powers++; plan.power = false; }
  if (plan.kick) { inp.kicks++; plan.kick = false; }
}

module.exports = { drive, ballAfter };
