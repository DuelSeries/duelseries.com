'use strict';
/* ─── The 8 Ball Pool bot ─────────────────────────────────────────────────────
   The opponent a free table gets after its wait, and the screen says it is a
   bot. It plays like a fair club player: it looks at every ball it may pot and
   every pocket, keeps the shots whose lines are clear, prefers straight and
   short ones, hits them with the power the distance needs, and then misses by a
   little, so a person who plays well beats it. With nothing on, it rolls up to
   one of its own balls rather than fouling. It thinks for a few seconds before
   every shot and shows its aim first, the way a person's cue moves on the other
   screen. Nothing here touches money. */

const Sim = require('../shared/pool8Sim');
const Rules = require('../shared/pool8Rules');
const { P8, POCKETS } = Sim;

const BOT = {
  THINK_MS: [2200, 4600],    // before it shows its aim
  AIM_SHOW_MS: 1300,         // its aim on the other screen before it shoots
  AIM_NOISE: 0.011,          // radians (about 0.6 degrees), one standard deviation
  MAX_CUT: 1.25,             // radians: it does not try thinner cuts than about 72 degrees
};

function gauss() { return (Math.random() + Math.random() + Math.random() - 1.5) / 0.5; }

/* Where a ball aims to go into a pocket: the middle of the mouth, a little inside the field. */
function mouth(k) {
  const L = P8.L, W = P8.W, r = P8.R;
  return [[r, r], [L / 2, 0], [L - r, r], [r, W - r], [L / 2, W], [L - r, W - r]][k];
}

// Is the segment from (ax, ay) to (bx, by) clear of every ball but the ones named, for a ball of radius R?
function clear(balls, ax, ay, bx, by, skip) {
  const R = P8.R, ex = bx - ax, ey = by - ay, el = ex * ex + ey * ey || 1;
  for (const b of balls) {
    if (!b.on || skip.includes(b.n)) continue;
    const q = Math.max(0, Math.min(1, ((b.x - ax) * ex + (b.y - ay) * ey) / el));
    const px = ax + ex * q, py = ay + ey * q;
    if ((b.x - px) ** 2 + (b.y - py) ** 2 < 4 * R * R * 0.98) return false;
  }
  return true;
}

function legalBalls(room, side) {
  const tgt = Rules.target(room.rules, room.balls, side);
  return room.balls.filter(b => b.on && b.n !== 0 && (
    tgt === 'eight' ? b.n === 8 : tgt === 'open' || tgt === 'any' ? b.n !== 8 : Sim.groupOf(b.n) === tgt));
}

// The best pot from (cx, cy), or null: { a, p, call, score }.
function bestPot(balls, cx, cy, targets) {
  const R = P8.R;
  let best = null;
  for (const t of targets) {
    for (let k = 0; k < POCKETS.length; k++) {
      const [mx, my] = mouth(k);
      let dx = mx - t.x, dy = my - t.y;
      const dObj = Math.hypot(dx, dy);
      if (dObj < 1) continue;
      dx /= dObj; dy /= dObj;
      if (POCKETS[k].kind === 'side' && Math.abs(dy) < 0.55) continue;   // a side pocket only takes a ball from in front
      const gx = t.x - dx * 2 * R, gy = t.y - dy * 2 * R;
      if (gx < R || gx > P8.L - R || gy < R || gy > P8.W - R) continue;
      let ax = gx - cx, ay = gy - cy;
      const dCue = Math.hypot(ax, ay);
      if (dCue < 1) continue;
      ax /= dCue; ay /= dCue;
      const cut = Math.acos(Math.max(-1, Math.min(1, ax * dx + ay * dy)));
      if (cut > BOT.MAX_CUT) continue;
      if (!clear(balls, t.x, t.y, mx, my, [0, t.n])) continue;
      const a = Math.atan2(ay, ax);
      const g = Sim.aimGuide(balls, cx, cy, a);
      if (g.kind !== 'ball' || g.n !== t.n) continue;
      const score = Math.cos(cut) ** 2 * 1000 / (dCue * 0.6 + dObj + 200);
      // Power: enough for the object ball to reach the pocket after the cut takes its share, with some to spare.
      const need = Math.sqrt(2 * P8.ROLL_DECEL * (dCue + dObj / Math.max(0.25, Math.cos(cut) ** 2)) * 1.6) + 180;
      const p = Math.max(0.12, Math.min(0.92, Math.pow(need / P8.VMAX, 1 / P8.POWER_EXP)));
      if (!best || score > best.score) best = { a, p, call: k, score, n: t.n };
    }
  }
  return best;
}

/* Where to put the cue ball when it is in hand: behind the best pot it can find, straight on. */
function bestPlacement(room, side, kitchen) {
  const targets = legalBalls(room, side);
  let best = null;
  for (const t of targets) {
    for (let k = 0; k < POCKETS.length; k++) {
      const [mx, my] = mouth(k);
      let dx = mx - t.x, dy = my - t.y;
      const d = Math.hypot(dx, dy) || 1;
      dx /= d; dy /= d;
      for (const back of [140, 220, 90, 320]) {
        const x = t.x - dx * (2 * P8.R + back), y = t.y - dy * (2 * P8.R + back);
        if (!Sim.placeOk(room.balls, x, y, kitchen)) continue;
        const shot = bestPot(room.balls, x, y, [t]);
        if (shot && (!best || shot.score > best.shot.score)) best = { x, y, shot };
        if (shot) break;
      }
    }
  }
  return best;
}

function decide(room, side) {
  const st = room.rules;
  const cue = room.balls[0];
  // The break: from the middle of the baulk line, full power at the head ball.
  if (!st.broken) {
    const x = P8.HEAD_X * P8.L - 2, y = P8.W / 2 + (Math.random() - 0.5) * P8.R * 4;
    const head = room.balls.filter(b => b.on && b.n !== 0).sort((a, b) => a.x - b.x)[0];
    const a = Math.atan2(head.y - y, head.x - x) + gauss() * 0.004;
    return { a, p: 0.96 + Math.random() * 0.04, sx: 0, sy: 0, x, y };
  }
  let cx = cue.x, cy = cue.y, place = null;
  if (st.inHand) {
    const pl = bestPlacement(room, side, st.inHand === 'kitchen');
    if (pl) { place = pl; cx = pl.x; cy = pl.y; }
    else {
      const free = require('./Pool8Room').freeSpot(room.balls, st.inHand === 'kitchen');
      cx = free.x; cy = free.y; place = { x: cx, y: cy };
    }
  }
  const targets = legalBalls(room, side);
  const balls = room.balls.map(b => (b.n === 0 ? { n: 0, x: cx, y: cy, on: true } : b));
  let shot = place && place.shot ? place.shot : bestPot(balls, cx, cy, targets);
  if (!shot) {
    // Nothing on: roll into the nearest of its own balls it can see, firmly enough to reach a cushion.
    let pick = null;
    for (const t of targets) {
      const a = Math.atan2(t.y - cy, t.x - cx);
      const g = Sim.aimGuide(balls, cx, cy, a);
      if (g.kind === 'ball' && g.n === t.n && (!pick || g.dist < pick.d)) pick = { a, d: g.dist, n: t.n };
    }
    let a = pick ? pick.a : null;
    if (a === null) {
      /* Hidden from every ball it may hit: try a ring of kicks off the cushions and keep the first that the rules
         call legal (two dozen played-through shots, only in this rare spot). */
      const before = balls.map(b => ({ n: b.n, x: b.x, y: b.y, on: b.on }));
      const start = Math.random() * Math.PI * 2;
      for (let i = 0; i < 24 && a === null; i++) {
        const ang = start + i * Math.PI / 12;
        const r = Sim.simulate(before, { a: ang, p: 0.5, sx: 0, sy: 0 });
        if (!Rules.judge(st, before, r, null).foul) a = ang;
      }
      if (a === null) a = start;
    }
    shot = { a, p: 0.45, call: null };
    if (Rules.target(st, room.balls, side) === 'eight') {
      // Name the pocket nearest to where the 8 would go.
      const e = room.balls.find(b => b.n === 8);
      let k = 0, bd = Infinity;
      for (let i = 0; i < 6; i++) { const [mx, my] = mouth(i); const d = Math.hypot(mx - e.x, my - e.y); if (d < bd) { bd = d; k = i; } }
      shot.call = k;
    }
  }
  const out = { a: shot.a + gauss() * BOT.AIM_NOISE, p: shot.p, sx: 0, sy: 0, call: shot.call };
  if (place) { out.x = cx; out.y = cy; }
  return out;
}

/* Called every lobby tick for a room with a bot. */
function drive(room, now) {
  if (!room.bot || room.state !== 'aiming') return;
  const side = room.sideOfSocket(room.bot.id);
  if (side === null || room.rules.turn !== side) return;
  const t = typeof now === 'number' ? now : Date.now();
  const key = room.turn + ':' + room.phaseEndsAt;
  const b = room.bot;
  if (b.key !== key) {
    b.key = key;
    b.plan = null;
    b.showAt = t + BOT.THINK_MS[0] + Math.random() * (BOT.THINK_MS[1] - BOT.THINK_MS[0]);
    return;
  }
  if (t < b.showAt) return;
  if (!b.plan) {
    b.plan = decide(room, side);
    b.fireAt = t + BOT.AIM_SHOW_MS;
    room.aim(b.id, { a: b.plan.a, p: 0, x: b.plan.x, y: b.plan.y });
    return;
  }
  if (t < b.fireAt) return;
  const plan = b.plan;
  b.plan = null;
  room.shoot(b.id, plan, t);
}

module.exports = { drive, decide, bestPot, BOT };
