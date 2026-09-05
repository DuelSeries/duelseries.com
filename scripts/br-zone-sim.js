/* ─── Battle Royale zone simulation ───────────────────────────────────────────
   node scripts/br-zone-sim.js   (npm run zone-sim)

   Drives the REAL room through a whole match with the clock faked, and reports
   what a player would actually experience: how many hops get announced, how
   much warning each gives, how fast the wall travels, how small it finishes —
   and whether a competent player can survive it.

   Two players are simulated, because they fail differently:

     CENTRE  swims for the middle of the circle. If this one dies the zone is
             simply too fast.
     EDGE    hangs around the rim, where the fighting is. This is the one the
             endgame kills, because a closing circle and a moving circle squeeze
             from opposite sides and the trailing rim gets the sum of both.

   Every number in the zone is a playability constraint rather than a taste, and
   the only way to know whether a wall can be outrun is to measure it against
   SNAKE_BASE_SPEED. */

const path = require('path');
const { BattleRoyaleRoom, BR } = require(path.join(__dirname, '..', 'server', 'BattleRoyaleRoom'));
const C = require(path.join(__dirname, '..', 'shared', 'constants'));

const io = { to: () => ({ emit: () => {} }) };
const cruise = C.SNAKE_BASE_SPEED * C.TICK_RATE;   // units a second, unboosted
const STEP = 100;
const TOTAL = BR.SHRINK_MS + BR.ROAM_MS;

function freshRoom(tag) {
  const r = new BattleRoyaleRoom(io, tag);
  r.snakes.set('a', { id: 'a', name: 'Owen', alive: true, head: { x: 0, y: 0 } });
  r.players.set('a', { walletAddress: 'W' });
  return r;
}

/* Run one match. `hug` is how far out the player tries to sit, 0 = dead centre,
   0.8 = near the rim. Returns when (if) the zone caught them. */
function run(hug) {
  const REAL = Date.now;
  let FAKE = REAL();
  Date.now = () => FAKE;
  const room = freshRoom('sim');
  room.startMatch('sim');
  room.countdownUntil = FAKE - 1;
  room.updateZone();

  let px = 0, py = 0, caught = null, worstSpeed = 0, prev = null;
  let hops = 0, lastTo = null, announce = 0;
  const warnings = [];
  const ringGap = [];

  /* Well past the buzzer: the clock running out STARTS the ending now, so a sim
     that stops at TOTAL never sees the part that decides the match. */
  const CAP = TOTAL + 5 * 60 * 1000;
  for (let ms = 0; ms <= CAP && caught === null; ms += STEP) {
    FAKE += STEP;
    room.startedAt = FAKE - ms;
    room.updateZone();

    // Where the player wants to be: `hug` of the way out from the centre.
    const off = Math.hypot(px - room.worldCx, py - room.worldCy) || 1;
    const tx = room.worldCx + (px - room.worldCx) / off * room.worldRadius * hug;
    const ty = room.worldCy + (py - room.worldCy) / off * room.worldRadius * hug;
    const dx = tx - px, dy = ty - py, d = Math.hypot(dx, dy);
    if (d > 1) {
      /* Flat out once the clock is gone. If a snake at MAX speed still cannot
         stay ahead, the match is guaranteed to end, which is the property that
         matters most about sudden death. */
      const speed = ms > TOTAL ? C.SNAKE_MAX_SPEED * C.TICK_RATE : cruise;
      const move = Math.min(d, speed * STEP / 1000);
      px += dx / d * move; py += dy / d * move;
    }
    if (Math.hypot(px - room.worldCx, py - room.worldCy) >= room.worldRadius) caught = ms;

    const to = room.hopTarget();
    if (to && (!lastTo || to.x !== lastTo.x || to.y !== lastTo.y)) {
      /* Only announcements that both began AND ended inside the timed part.
         The one still running when the buzzer goes is cut short by the buzzer,
         not by the design, and counting it made the shortest warning look like
         one second. */
      /* Announcements that both began AND ended inside the timed part. The one
         running when the buzzer goes is cut short by the buzzer rather than by
         the design, and the first is clipped by the start of the roam. */
      if (announce && ms > BR.SHRINK_MS + 3000 && ms <= TOTAL - 3000) {
        warnings.push(announce / 1000);
      }
      if (ms <= TOTAL) hops++;
      lastTo = { x: to.x, y: to.y }; announce = 0;
    }
    if (to) {
      announce += STEP;
      /* Is the ring WARNING? Once the endgame starts closing, the circle that
         arrives is smaller than the one on screen now, and the ring has to show
         the smaller one — otherwise it promises room that will not be there.
         Outside the endgame the two are the same and the gap is zero. */
      if (ms >= TOTAL - BR.ENDGAME_MS) ringGap.push(room.radiusAt(ms) - to.r);
    }
    if (prev && ms > BR.SHRINK_MS && ms <= TOTAL) {
      const v = Math.hypot(room.worldCx - prev.x, room.worldCy - prev.y) / (STEP / 1000);
      if (v > worstSpeed) worstSpeed = v;
    }
    prev = { x: room.worldCx, y: room.worldCy };
  }
  /* The announcement still running when the loop stops is a fragment of one,
     cut off by the end of the simulation rather than by anything the zone did.
     Pushing it made the shortest warning read 0.9s when the shortest real one
     was eight seconds. */
  Date.now = REAL;
  return { caught, worstSpeed, hops, warnings, ringGap, endRadius: room.worldRadius };
}

const fmt = n => Math.round(n * 10) / 10;
const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;

const centre = run(0);
const edge = run(0.8);

console.log('A match is ' + TOTAL / 1000 + 's: ' + BR.SHRINK_MS / 1000 + 's closing, '
  + BR.ROAM_MS / 1000 + 's hopping, the last ' + BR.ENDGAME_MS / 1000 + 's closing again.\n');
console.log('Figures below describe the TIMED part. Sudden death is meant to be unsurvivable.');
console.log('');
console.log('hops announced          ', centre.hops);
console.log('warning per hop         ', fmt(avg(centre.warnings)) + 's average, '
  + fmt(Math.min.apply(null, centre.warnings)) + 's shortest');
console.log('fastest the wall travels', Math.round(centre.worstSpeed), 'u/s');
console.log('a snake cruises at      ', Math.round(cruise), 'u/s  ->',
  Math.round(centre.worstSpeed / cruise * 100) + '% of it');
console.log('circle at the end       ', Math.round(centre.endRadius), 'radius');
console.log('endgame ring warns by   ', fmt(avg(centre.ringGap)),
  'units smaller than the wall is now');
console.log('');
const sd = (r) => r.caught === null ? 'NEVER CAUGHT'
  : r.caught <= TOTAL ? 'caught at ' + r.caught / 1000 + 's (before the buzzer)'
  : 'caught ' + fmt((r.caught - TOTAL) / 1000) + 's into sudden death';
console.log('player who holds the middle:', sd(centre));
console.log('player who hugs the rim    :', sd(edge));

const fails = [];
if (centre.worstSpeed > cruise * 0.75) fails.push('the wall outruns a snake');
if (Math.min.apply(null, centre.warnings) < 2) fails.push('a hop gives under two seconds of warning');
if (centre.hops < 3) fails.push('barely any hops in a whole match');
if (centre.caught !== null && centre.caught <= TOTAL) {
  fails.push('holding the middle is not enough to survive the timed part');
}
if (edge.caught !== null && edge.caught < TOTAL - BR.ENDGAME_MS) {
  fails.push('the rim is lethal before the endgame even starts');
}
/* The one guarantee sudden death exists to make. */
if (centre.caught === null) fails.push('sudden death never ends the match');
if (avg(centre.ringGap) <= 0) {
  fails.push('the ring does not shrink ahead of the wall in the endgame');
}
console.log('\n' + (fails.length ? 'PROBLEMS: ' + fails.join('; ')
  : 'the zone is followable, honest about where it is going, and finishes small'));
process.exitCode = fails.length ? 1 : 0;
