'use strict';
/* ─── The free table's Head Soccer opponent ───────────────────────────────────
   It presses the same buttons a person does, through the same input the room
   reads from a socket, so it can do nothing a player cannot: run, jump, kick.

   HOW IT PLAYS IS THE REFERENCE'S CPU (Heads Arena Euro Soccer, logic.AIControls
   in its game.min.js, read 2026-10-27), rewritten here step for step at its
   "medium" level (AILevels easy 1, medium 5, hard 9). Its own numbers, in the
   reference's design units (shared/hsSim.js):
     · every 10 x (10 - level) steps it re-reads where the ball will land
       (_bufferBallPositionForSteps), and before its first read it is chasing a
       ball it has not seen yet (the corner of the screen, as the reference's is)
     · it stands .55 x the kick reach behind the ball, on its own goal's side
       (_maxKickDelta), within half that (goToPosition's tolerance)
     · near the ball (a third of the screen width) it runs to where the ball
       will come down, otherwise straight at the ball (the "attacker" role the
       solo CPU gets)
     · with the ball 112 to 300 above its centre (_playerUnderBall, .75 to 2
       jump distances) it presses jump every step, as the reference's does
     · in line with the ball it kicks after its "average shot" check: the kick
       is skipped only when every place it could meet the ball sends it at its
       own goal before any sends it at the other one (_estimatedShot)
   Above medium (level 6+) it would also run back for balls heading into its
   own goal; at medium it does not, as the reference's medium does not. */

const Sim = require('../shared/hsSim');
const { HS, IN } = Sim;

const LEVEL = 5;                     // S: AIControls.AILevels.medium
const MAX_LEVEL = 9;                 // S: _maxDifficulty
const W = HS.VIEW_W_REF;             // its distances use Game.dimensions.width: a 16:9 screen
const H = HS.VIEW_H;
const BODY_H = 100;                  // S: the player body sprite, Game.scale(200) x scale .5
const JUMP_DIST = 1.5 * BODY_H;      // S: _jumpDistance
const MAX_KICK_DELTA = 0.55 * HS.KICK_RANGE;   // S: _maxKickDelta (signed by side below)
const NEAR = W / 3;                  // S: _nearBallDistance with no team-mate
const BUFFER = 10 * (10 - LEVEL);    // S: _bufferBallPositionForSteps


const mod = (a) => LEVEL / MAX_LEVEL * a;      // S: _getDifficultyModifier

// S: Ball.getTrajectory: its own rough flight, x += vx / 10 and y += vy / 10 + 9000 d^2 a point, stopping low.
function trajectory(x, y, vx, vy, e) {
  const out = [];
  for (let d = 0; d < 40 * e; d += e) {
    x += vx / 10; y += vy / 10 + 9000 * d * d;
    out.push({ x, y });
    if (y > H - 400) break;
  }
  return out;
}
// S: Arena.checkGoal over a trajectory: -1 into the right goal, 1 into the left one, 0 neither (the last one wins).
function landsIn(points) {
  let f = 0;
  for (const p of points) {
    if (p.y > HS.GOAL_TOP_Y && p.y < HS.GOAL_BOT_Y) {
      if (p.x < -HS.GOAL_LINE_X) f = 1;
      else if (p.x > HS.GOAL_LINE_X) f = -1;
    }
  }
  return f;
}

function brainFor(bot) {
  if (!bot.ai) bot.ai = { steps: Math.floor(30 * Math.random()), seen: false, traj: null, kickIn: -1 };
  return bot.ai;
}

/* One step's worth of buttons for the bot's seat. */
function drive(room, now, who) {
  const bot = who || room.bot;
  if (!bot || !room.match) return;
  if (room.state === 'waiting' || room.state === 'over') return;
  const side = room.sideOfSocket(bot.id);
  if (side === null) return;
  const m = room.match, me = m.p[side], ball = m.ball;
  const inp = room.inputs[side];
  const ai = brainFor(bot);
  const attacksLeft = side === 1;                       // the reference's "isLeft"
  const delta = MAX_KICK_DELTA * (attacksLeft ? 1 : -1);
  inp.held = 0;

  // S: update(): idle, count, and every BUFFER steps look at the ball again.
  ai.steps++;
  const bp = ai.seen ? ball : { x: -W / 2, y: 0 };      // S: a fresh Phaser.Point, the screen's corner
  const landing = () => {
    const t = trajectory(ball.x, ball.y, ball.vx / 10, ball.vy / 10, 0.025);
    return (t.length < 2 ? t[0].x : t[t.length - 2].x) + delta;
  };
  if (ai.steps % BUFFER === 0) { ai.seen = true; ai.traj = landing(); }
  if (room.state !== 'playing') { ai.kickIn = -1; return; }

  let move = 0;
  const goTo = (x, tol) => { if (!(me.x > x - tol && me.x < x + tol)) move = me.x < x - tol ? 1 : -1; };
  const dist = Math.hypot(bp.x - me.x, bp.y - me.y);
  if (dist < NEAR) {
    if (ai.traj === null) ai.traj = landing();
    goTo(ai.traj, 0.5 * Math.abs(delta));                // S: _goToBallTrajectory
  } else {
    goTo(bp.x + delta, 0.5 * Math.abs(delta));           // S: the attacker's _goToBall
  }

  const ideal = bp.x + delta;
  const aligned = me.x > ideal - Math.abs(delta) && me.x < ideal + Math.abs(delta);
  if (aligned) {
    if (bp.y > me.y - 2 * JUMP_DIST && bp.y < me.y - 0.75 * JUMP_DIST) inp.jumps++;   // S: _playerUnderBall
    const reachY = Math.max(200, 100 * LEVEL);
    if (bp.y > me.y - reachY && bp.y < me.y + reachY && ai.kickIn < 0) {
      // S: _averageShot = _estimatedShot(mod(80), 40 - mod(40)): search the ball's path for a place to meet it.
      const e = 0.0167 / (mod(80) / 100);
      const path = trajectory(ball.x, ball.y, ball.vx / 10, ball.vy / 10, e);
      let ownGoalRisk = false, at = 0;
      for (let n = 0; n < path.length; n++) {
        const v = Sim.kickVelocity(me, path[n].x, path[n].y);
        if (!v) continue;
        const r = landsIn(trajectory(path[n].x, path[n].y, v[0], v[1], e));
        const scores = attacksLeft ? r === 1 : r === -1;
        const own = attacksLeft ? r === -1 : r === 1;
        if (scores) { ownGoalRisk = false; at = n * e; break; }
        if (own) ownGoalRisk = true;
      }
      // S: setTimeout(_quickShot, f + b) with f in seconds read as ms: a step or two.
      if (!ownGoalRisk) ai.kickIn = Math.max(1, Math.round((at + 40 - mod(40)) / (1000 / 60)));
    }
  }
  if (ai.kickIn > 0 && --ai.kickIn === 0) { inp.kicks++; ai.kickIn = -1; }
  inp.held = move > 0 ? IN.RIGHT : move < 0 ? IN.LEFT : 0;
}

module.exports = { drive, trajectory, LEVEL };
