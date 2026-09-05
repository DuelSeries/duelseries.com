/* ─── Battle Royale zone simulation ───────────────────────────────────────────
   node scripts/br-zone-sim.js

   Drives the REAL room through a whole match with the clock faked, and reports
   what a player would actually experience: how many hops get announced, how
   fast the wall travels, how much warning each hop gives, and how small it
   finishes.

   It exists because every number in the zone is a playability constraint rather
   than a taste, and the only way to know whether a wall can be outrun is to
   measure it against SNAKE_BASE_SPEED. */

const path = require('path');
const { BattleRoyaleRoom, BR } = require(path.join(__dirname, '..', 'server', 'BattleRoyaleRoom'));
const C = require(path.join(__dirname, '..', 'shared', 'constants'));

const io = { to: () => ({ emit: () => {} }) };
const room = new BattleRoyaleRoom(io, 'sim');
room.snakes.set('a', { id: 'a', name: 'Owen', alive: true, head: { x: 0, y: 0 } });
room.players.set('a', { walletAddress: 'W' });

const cruise = C.SNAKE_BASE_SPEED * C.TICK_RATE;   // units a second, unboosted
const REAL = Date.now;
let fake = REAL();
Date.now = () => fake;

room.startMatch('sim');
room.countdownUntil = fake - 1;
room.updateZone();

const STEP = 100;                                  // ms per sample
let hops = 0, lastTo = null, worstSpeed = 0, prev = null;
let announceMs = 0, currentAnnounce = 0;
const warnings = [];
const radii = [];

const total = BR.SHRINK_MS + BR.ROAM_MS;
for (let ms = 0; ms <= total; ms += STEP) {
  fake += STEP;
  room.startedAt = fake - ms;
  room.updateZone();

  const to = room.hopTarget();
  if (to && (!lastTo || to.x !== lastTo.x || to.y !== lastTo.y)) {
    if (currentAnnounce) warnings.push(currentAnnounce / 1000);
    hops++; lastTo = { x: to.x, y: to.y }; currentAnnounce = 0;
  }
  if (to) currentAnnounce += STEP;

  if (prev && ms > BR.SHRINK_MS) {
    const v = Math.hypot(room.worldCx - prev.x, room.worldCy - prev.y) / (STEP / 1000);
    if (v > worstSpeed) worstSpeed = v;
  }
  prev = { x: room.worldCx, y: room.worldCy };
  if (ms >= BR.SHRINK_MS) radii.push(room.worldRadius);
}
if (currentAnnounce) warnings.push(currentAnnounce / 1000);
Date.now = REAL;

const avg = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const fmt = n => Math.round(n * 10) / 10;

console.log('A match is', total / 1000 + 's:', BR.SHRINK_MS / 1000 + 's closing,',
            BR.ROAM_MS / 1000 + 's hopping.\n');
console.log('hops announced          ', hops);
console.log('warning per hop         ', fmt(avg(warnings)) + 's average,',
            fmt(Math.min.apply(null, warnings)) + 's shortest');
console.log('fastest the wall travels', Math.round(worstSpeed), 'u/s');
console.log('a snake cruises at      ', Math.round(cruise), 'u/s  ->',
            Math.round(worstSpeed / cruise * 100) + '% of it');
console.log('circle while hopping    ', Math.round(radii[0]), 'radius');
console.log('circle at the end       ', Math.round(radii[radii.length - 1]), 'radius');

const fails = [];
if (worstSpeed > cruise * 0.75) fails.push('the wall outruns a snake');
if (Math.min.apply(null, warnings) < 2) fails.push('a hop gives under two seconds of warning');
if (hops < 3) fails.push('barely any hops in a whole match');
if (Math.round(radii[radii.length - 1]) > BR.ENDGAME_RADIUS + 5) fails.push('it never closes at the end');
console.log('\n' + (fails.length ? 'PROBLEMS: ' + fails.join('; ') : 'the zone is followable and finishes small'));
process.exitCode = fails.length ? 1 : 0;
