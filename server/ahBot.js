'use strict';
/* ─── The free table's Air Hockey opponent ────────────────────────────────────
   It moves its mallet through the same input a person's pointer does (the
   room's per-seat target), so it can do nothing a player cannot: the sim clamps
   it to its half and caps its speed like anybody's.

   HOW IT PLAYS: a simple defender-attacker, made beatable on purpose.
     · it SEES the puck REACT_MS late (a ring of past states) and guesses where it
       is now from that old position and speed, so a bank shot or a quick change of
       direction fools it the way it fools a person
     · its hand is slower than a person's can be (BOT_SPEED, a strike STRIKE_SPEED)
     · puck on its half and slow, going away, or with the bot behind it: it lines
       up behind the puck on a line to a spot in the goal (sometimes a bank off a
       side rail), then drives through it
     · puck coming at it fast: it slides to where the puck will cross its
       defending line (bounces off the side rails included), staying near its goal
     · puck on the other half: it waits between the puck and its goal
   Everything is worked in the bot's own frame, its goal at y = 0, then turned
   back for the seat it is in. */

const Sim = require('../shared/ahSim');
const { AH } = Sim;

const REACT_MS = 130;
const BOT_SPEED = 1500;        // units/s its hand moves when placing itself
const STRIKE_SPEED = 2200;     // and when it swings
const DEF_Y = 105;             // its defending line, from its own end
const HOME_Y = 150;
const W = AH.W, H = AH.H, PR = AH.PUCK_R, MR = AH.MALLET_R;

function brainFor(bot) {
  if (!bot.ai) bot.ai = { seen: [], tx: W / 2, ty: HOME_Y, at: 0, aim: null, strikeUntil: 0, err: 0 };
  return bot.ai;
}

// Where a puck now at x moving vx will be after t seconds between the side rails (straight line, reflected).
function railX(x, vx, t) {
  const lo = PR, hi = W - PR, span = hi - lo;
  let v = x - lo + vx * t;
  v = ((v % (2 * span)) + 2 * span) % (2 * span);
  return lo + (v > span ? 2 * span - v : v);
}

function pickAim(ai) {
  const r = Math.random();
  const off = (Math.random() - 0.5) * 120;
  // Straight at the goal, or a bank off one side rail (aiming at the goal's mirror image beyond that rail).
  if (r < 0.6) ai.aim = { x: W / 2 + off, y: H + 40 };
  else if (r < 0.8) ai.aim = { x: -(W / 2) + off * 0.5, y: H + 40 };
  else ai.aim = { x: W * 1.5 + off * 0.5, y: H + 40 };
}

/* One step's pointer for the bot's seat. */
function drive(room, now, who) {
  const bot = who || room.bot;
  if (!bot || !room.match) return;
  if (room.state === 'waiting' || room.state === 'over') return;
  const side = room.sideOfSocket(bot.id);
  if (side === null) return;
  const t = typeof now === 'number' ? now : Date.now();
  const ai = brainFor(bot);
  const dt = ai.at ? Math.max(0, Math.min(0.1, (t - ai.at) / 1000)) : 1 / 60;
  ai.at = t;
  // Its own frame: own goal at y = 0. Seat 1 already defends y = 0; seat 0's world is mirrored top to bottom.
  const flip = side === 0;
  const ly = (y) => (flip ? H - y : y);
  const p = room.match.puck, me = room.match.m[side];
  ai.seen.push({ t, x: p.x, y: ly(p.y), vx: p.vx, vy: flip ? -p.vy : p.vy, live: p.live });
  while (ai.seen.length > 2 && ai.seen[1].t <= t - REACT_MS) ai.seen.shift();
  const old = ai.seen[0];
  const lag = Math.min(REACT_MS, t - old.t) / 1000 * 0.8;
  const P = { x: railX(old.x, old.vx, lag), y: old.y + old.vy * lag, vx: old.vx, vy: old.vy };
  const M = { x: me.x, y: ly(me.y) };

  let dx = W / 2, dy = HOME_Y, speed = BOT_SPEED;
  const playing = room.state === 'playing' && old.live;
  if (!playing) {
    ai.aim = null;
    if (room.state === 'goal' || room.state === 'countdown') { dx = W / 2; dy = HOME_Y; }
    else { dx = M.x; dy = M.y; }
  } else {
    const sp = Math.hypot(P.vx, P.vy);
    const mine = P.y < H / 2 + 6;
    const coming = P.vy < -120;
    if (mine && (!coming || sp < 700 || M.y < P.y - 30)) {
      // Attack: line up behind the puck on the line to the aim, then drive through it.
      if (!ai.aim) pickAim(ai);
      let ux = ai.aim.x - P.x, uy = ai.aim.y - P.y;
      const ul = Math.hypot(ux, uy) || 1;
      ux /= ul; uy /= ul;
      const bx = P.x - ux * (PR + MR + 28), by = P.y - uy * (PR + MR + 28);
      const ahead = (M.x - P.x) * ux + (M.y - P.y) * uy;       // > 0: the mallet is on the wrong side of the puck
      if (t < ai.strikeUntil) {
        dx = P.x + ux * 90; dy = P.y + uy * 90; speed = STRIKE_SPEED;
      } else if (ahead > -10 && Math.hypot(M.x - P.x, M.y - P.y) < PR + MR + 70) {
        // Wrong side and close: go round it, toward its own end, without touching it.
        const sideX = M.x < P.x ? -1 : 1;
        dx = P.x + sideX * (PR + MR + 34); dy = P.y - (PR + MR + 20);
      } else if (Math.hypot(M.x - bx, M.y - by) < 34 || (ahead < -(PR + MR) && Math.hypot(M.x - bx, M.y - by) < 60)) {
        ai.strikeUntil = t + 170;
        ai.err = (Math.random() - 0.5) * 26;                   // a little miss in every swing
        dx = P.x + ux * 90 + ai.err; dy = P.y + uy * 90; speed = STRIKE_SPEED;
      } else {
        dx = bx; dy = by;
      }
    } else {
      ai.aim = null;
      if (coming) {
        // Defend: where it crosses the defending line, kept near the mouth.
        const tc = Math.max(0, (P.y - DEF_Y) / -P.vy);
        let xc = railX(P.x, P.vx, tc);
        xc = Math.max(AH.GOAL_X0 - 40, Math.min(AH.GOAL_X1 + 40, xc));
        dx = xc; dy = tc < 0.25 ? DEF_Y : DEF_Y + Math.min(80, tc * 120);
      } else {
        // Wait between the puck and the goal.
        dx = W / 2 + (P.x - W / 2) * 0.4; dy = HOME_Y;
      }
    }
  }
  // Its hand: toward where it wants to be, no faster than a hand.
  const ex = dx - ai.tx, ey = dy - ai.ty, el = Math.hypot(ex, ey), mx = speed * dt;
  if (el > mx) { ai.tx += ex / el * mx; ai.ty += ey / el * mx; } else { ai.tx = dx; ai.ty = dy; }
  const c = Sim.clampMallet(1, ai.tx, ai.ty);                  // its own frame: its half is y < H / 2
  ai.tx = c[0]; ai.ty = c[1];
  room.inputs[side] = { x: ai.tx, y: ly(ai.ty) };
}

module.exports = { drive, REACT_MS, railX };
