/* ─── Battle Royale zone simulation ───────────────────────────────────────────
   node scripts/br-zone-sim.js [--seeds 20] [--minutes 15]   (npm run zone-sim)

   Drives the REAL room's zone (BattleRoyaleRoom.updateZone, the ring model
   since 09a4d74) through whole matches on a faked clock and a seeded
   Math.random, and reports what a player would actually experience: how many
   rings get called, how much warning each gives, how fast the wall travels,
   how long it takes to reach the endgame and the floor, and whether a
   competent player who heads for the announced ring survives it.

   Two players are simulated, because they fail differently:

     CENTRE  swims for the middle of the announced ring (the current circle
             when none is up). If this one is caught the zone is too fast.
     EDGE    keeps to 0.8 of the way out, where the fighting is, measured
             against the announced ring. A ring whose centre jumps away from
             them is what catches this one.

   Both cruise (SNAKE_BASE_SPEED, no boost) and are points: a real snake below
   RING_ENDGAME_RADIUS can no longer turn inside the circle, which is how a
   match ends there, so survival is only judged above that radius.

   (Rewritten 2026-11-01: the first version measured the clock-driven zone,
   SHRINK_MS / ROAM_MS / ENDGAME_MS, which 09a4d74 replaced with rings on
   2026-09-07; it printed NaN for every figure since.) */

const path = require('path');
const { BattleRoyaleRoom, BR } = require(path.join(__dirname, '..', 'server', 'BattleRoyaleRoom'));
const C = require(path.join(__dirname, '..', 'shared', 'constants'));

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && i + 1 < process.argv.length ? Number(process.argv[i + 1]) : def;
}
const SEEDS = arg('seeds', 20);
const CAP_MS = arg('minutes', 15) * 60 * 1000;

const io = { to: () => ({ emit: () => {} }) };
const cruise = C.SNAKE_BASE_SPEED * C.TICK_RATE;   // units a second, unboosted
const STEP = 100;

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/* One match. Returns the ring list, the measured wall speed, when the endgame
   radius and the floor were reached, and where (if) each player was caught. */
function run(seed) {
  const REAL_NOW = Date.now, REAL_RANDOM = Math.random;
  let FAKE = REAL_NOW();
  Date.now = () => FAKE;
  Math.random = mulberry32(seed);
  try {
    const room = new BattleRoyaleRoom(io, 'sim');
    room.snakes.set('a', { id: 'a', name: 'Owen', alive: true, head: { x: 0, y: 0 } });
    room.players.set('a', { walletAddress: 'W' });
    if (!room.startMatch('sim')) throw new Error('the room refused to start');
    room.countdownUntil = FAKE - 1;
    room.updateZone();
    if (room.state !== 'running') throw new Error('the match did not start running: ' + room.state);

    const players = [
      { name: 'centre', hug: 0, x: 0, y: 0, caught: null },
      { name: 'edge', hug: 0.8, x: BR.START_RADIUS * 0.8, y: 0, caught: null },
    ];
    const rings = [];
    let ring = null, worstSpeed = 0, endgameAt = null, floorAt = null, grew = 0, outside = 0;
    let prev = { r: room.worldRadius, x: room.worldCx, y: room.worldCy };

    for (let ms = 0; ms <= CAP_MS; ms += STEP) {
      FAKE += STEP;
      room.updateZone();
      const g = room._ring;
      if (g && g !== ring) {
        rings.push({ fr: g.fr, tr: g.tr, warnMs: g.warnUntil - g.startedAt, moveMs: g.moveMs, at: ms });
        if (g.tr > g.fr + 1e-9) grew++;
        if (Math.hypot(g.tx - g.fx, g.ty - g.fy) + g.tr > g.fr + 1e-6) outside++;
        ring = g;
      }
      // The fastest any point of the wall moved this step: the shrink plus the centre's travel.
      const v = (Math.abs(room.worldRadius - prev.r) + Math.hypot(room.worldCx - prev.x, room.worldCy - prev.y))
        / (STEP / 1000);
      if (v > worstSpeed) worstSpeed = v;
      prev = { r: room.worldRadius, x: room.worldCx, y: room.worldCy };
      if (endgameAt === null && room.worldRadius <= BR.RING_ENDGAME_RADIUS) endgameAt = ms;
      if (floorAt === null && room.worldRadius <= BR.RING_MIN_RADIUS + 1e-9) floorAt = ms;

      const to = room.hopTarget() || { x: room.worldCx, y: room.worldCy, r: room.worldRadius };
      for (const p of players) {
        if (p.caught) continue;
        const off = Math.hypot(p.x - to.x, p.y - to.y) || 1;
        const tx = to.x + (p.x - to.x) / off * to.r * p.hug;
        const ty = to.y + (p.y - to.y) / off * to.r * p.hug;
        const dx = tx - p.x, dy = ty - p.y, d = Math.hypot(dx, dy);
        if (d > 1) {
          const move = Math.min(d, cruise * STEP / 1000);
          p.x += dx / d * move; p.y += dy / d * move;
        }
        if (room.worldRadius > BR.RING_ENDGAME_RADIUS &&
            Math.hypot(p.x - room.worldCx, p.y - room.worldCy) >= room.worldRadius) {
          p.caught = { ms, r: room.worldRadius };
        }
      }
      if (floorAt !== null && ms > floorAt + 30000) break;
    }
    return { rings, worstSpeed, endgameAt, floorAt, grew, outside, players };
  } finally {
    Date.now = REAL_NOW;
    Math.random = REAL_RANDOM;
  }
}

const fmt = (n) => Math.round(n * 10) / 10;
const min = (a) => a.reduce((m, x) => Math.min(m, x), Infinity);
const max = (a) => a.reduce((m, x) => Math.max(m, x), -Infinity);
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

const runs = [];
for (let s = 1; s <= SEEDS; s++) runs.push(run(s));

const toFloor = runs.map((r) => r.rings.findIndex((g) => g.tr <= BR.RING_MIN_RADIUS + 1e-9) + 1);
const warns = [].concat(...runs.map((r) => r.rings.map((g) => g.warnMs / 1000)));
const worst = max(runs.map((r) => r.worstSpeed));
const endgame = runs.map((r) => r.endgameAt).filter((x) => x !== null);
const floor = runs.map((r) => r.floorAt).filter((x) => x !== null);
const caught = (name) => runs.map((r) => r.players.find((p) => p.name === name).caught).filter(Boolean);

console.log(SEEDS + ' matches, one person, the zone stepped every ' + STEP + ' ms on a faked clock.\n');
console.log('rings called to the floor  ', min(toFloor) + ' to ' + max(toFloor));
console.log('warning per ring           ', fmt(avg(warns)) + 's average, ' + fmt(min(warns)) + 's shortest, '
  + fmt(max(warns)) + 's longest');
console.log('fastest the wall travels   ', Math.round(worst), 'u/s (its limit ' + Math.round(BR.CLOSE_SPEED) + ')');
console.log('a snake cruises at         ', Math.round(cruise), 'u/s  ->', Math.round(worst / cruise * 100) + '% of it');
console.log('endgame (r ' + BR.RING_ENDGAME_RADIUS + ') reached     ', endgame.length ? fmt(min(endgame) / 60000) + ' to '
  + fmt(max(endgame) / 60000) + ' min' : 'NEVER');
console.log('floor (r ' + BR.RING_MIN_RADIUS + ') reached        ', floor.length ? fmt(min(floor) / 60000) + ' to '
  + fmt(max(floor) / 60000) + ' min' : 'NEVER');
for (const name of ['centre', 'edge']) {
  const c = caught(name);
  console.log(('player at the ' + name).padEnd(27), c.length ? 'caught in ' + c.length + ' of ' + SEEDS
    + ' (first at r ' + Math.round(max(c.map((x) => x.r))) + ')' : 'never caught above the endgame radius');
}

const fails = [];
if (worst > cruise * 0.75) fails.push('the wall outruns a snake');
if (min(warns) < 2) fails.push('a ring gives under two seconds of warning');
if (min(toFloor) < 3) fails.push('barely any rings in a whole match');
if (floor.length < SEEDS) fails.push('the zone does not reach its floor within ' + CAP_MS / 60000 + ' minutes');
if (caught('centre').length) fails.push('heading for the announced ring is not enough to survive');
if (runs.some((r) => r.grew)) fails.push('a ring is bigger than the one before it');
if (runs.some((r) => r.outside)) fails.push('a ring pokes outside the circle it replaces');
console.log('\n' + (fails.length ? 'PROBLEMS: ' + fails.join('; ')
  : 'the zone is followable, honest about where it is going, and finishes small'));
process.exitCode = fails.length ? 1 : 0;
