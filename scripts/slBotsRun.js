'use strict';
// Local bot run for task T12 (SERVER-DESIGN 19: "a 10-minute local run: all three personalities seen, no input outside
// the gates, fill follows the curve"). No socket and no money: the real law table, the world sim (border and food;
// prey stays off until its SUGGESTED rows are approved, BUILD-DECISIONS T5), and the bot driver (slBots
// createBotDriver) called exactly as slRoom calls it (beforeInputs at step 0, afterStep after the deaths), with a
// small host standing in for the room. Scripted "humans" (wanderers) join and leave on a schedule, so real players
// replacing bots is exercised.
//
// The fake wall clock runs at --curve-speed (default 144: ten sim minutes sweep a whole day of the daily curve). The
// host's "seen" test is an APPROXIMATION of slView (task T8): a bot is seen while any of its points lies in the L8.R2
// large sector window around a human head.
//
// Usage: node scripts/slBotsRun.js [--minutes 10] [--seed 1] [--curve-speed 144] [--start 2026-10-10T04:00:00Z]
// Prints a summary and PASS or FAIL lines; exit code 1 on any FAIL.

const { LAWS } = require('../server/sl/slLaws');
const { createSim } = require('../server/sl/slSim');
const { createRng } = require('../server/sl/slRng');
const B = require('../server/sl/slBots');
const W = require('../shared/slWire');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const MINUTES = Number(arg('minutes', '10'));
const SEED = Number(arg('seed', '1'));
const CURVE_SPEED = Number(arg('curve-speed', '144'));
const START_WALL = Date.parse(arg('start', '2026-10-10T04:00:00Z')); // midnight Eastern
// Scripted human count: [fromMinute, humans]
const HUMANS = [[0, 0], [1, 5], [3, 30], [5, 12], [7, 2], [9, 40]];

const laws = LAWS;
const P = laws.L7.value;
const SECTOR = laws['L2.size'].value;
const R2 = laws['L8.R2'].value.large;
const K = B.brainLaws(laws);
const CHANGE_MS = laws.BOT_GATES.value.changeMs;
const TICKS = Math.round((MINUTES * 60000) / P);
const PER_SECOND = Math.round(1000 / P);

const sim = createSim(laws, { seed: SEED, border: true, food: true });
const humanRng = createRng((SEED * 2654435761) >>> 0);
const humans = []; // live human snakes
let wall = START_WALL;
let gateViolations = 0;
let wireMismatch = 0;
let records = 0;
const sent = new Map(); // bot id -> what it last sent

function seen(id) {
  const s = sim.snake(id);
  if (!s) return false;
  for (let i = 0; i < s.pts.length; i++) {
    const sx = Math.floor(s.pts[i].xx / SECTOR);
    const sy = Math.floor(s.pts[i].yy / SECTOR);
    for (const h of humans) {
      const dx = sx - Math.floor(h.hx / SECTOR);
      const dy = sy - Math.floor(h.hy / SECTOR);
      if (dx * dx + dy * dy <= R2) return true;
    }
  }
  return false;
}

// The host: the room surface the driver reads (see slBots createBotDriver).
const host = {
  sim,
  now: () => wall,
  get playerCount() {
    return humans.length;
  },
  spawnSnake: (spec) => sim.spawn({ cv: spec.cv, nick: spec.nick }),
  names: new Map(),
  freedAt: new Map(),
  world: { idBlocked: seen },
  get seats() {
    return new Map(humans.map((h) => [h.id, { snakeId: h.id }]));
  },
  _botsPausedUntil: 0,
};

function onRecord(id, r, offsetMs, tickMs) {
  records++;
  let b = sent.get(id);
  if (!b) sent.set(id, (b = { lastAngleT: -Infinity, lastBoostT: -Infinity, boostOn: false, lastQ: -1 }));
  const t = tickMs - offsetMs;
  if (!(offsetMs >= 0 && offsetMs < P)) gateViolations++;
  if (r.type === 'angle') {
    if (!Number.isInteger(r.q) || r.q < 0 || r.q > K.maxAngle || r.q === b.lastQ) gateViolations++;
    if (!(t - b.lastAngleT > K.angleMs)) gateViolations++;
    b.lastAngleT = t;
    b.lastQ = r.q;
  } else if (r.type === 'boost') {
    if (typeof r.on !== 'boolean' || r.on === b.boostOn) gateViolations++;
    if (!(t - b.lastBoostT > K.boostMs)) gateViolations++;
    b.lastBoostT = t;
    b.boostOn = r.on;
  } else {
    gateViolations++;
  }
  const back = W.decodeInput(W.encodeInput([r]));
  if (back.length !== 1 || back[0].type !== r.type || back[0].q !== r.q || back[0].on !== r.on) wireMismatch++;
}

const driver = B.createBotDriver(laws, { onRecord });

function humanWant(minute) {
  let n = 0;
  for (const [from, k] of HUMANS) if (minute >= from) n = k;
  return n;
}

function humanInputs(h) {
  const u = humanRng.next();
  if (u < 0.03) sim.setInput(h.id, { type: 'angle', q: humanRng.int(K.maxAngle + 1) }, humanRng.next() * P);
  else if (u < 0.035) sim.setInput(h.id, { type: 'boost', on: humanRng.next() < 0.5 }, humanRng.next() * P);
}

let samples = 0;
let within1 = 0;
let maxDiff = 0;
let worstStreak = 0;
let streak = 0;
let stepped = 0;
let catchingUp = 0;
let blockedSeen = 0;
let misses = 0;
let prevWant = null;
let lastChangeMs = -Infinity;
let lastFill = 0;
const t0 = Date.now();
for (let tick = 0; tick < TICKS; tick++) {
  const minute = (tick * P) / 60000;
  wall = START_WALL + tick * P * CURVE_SPEED;
  // seats: humans join and leave on the schedule; a dead human plays again at once
  for (let i = humans.length - 1; i >= 0; i--) if (!humans[i].alive) humans.splice(i, 1, sim.spawn({ cv: humanRng.int(9), nick: 'h' }));
  const wantH = humanWant(minute);
  while (humans.length < wantH) humans.push(sim.spawn({ cv: humanRng.int(9), nick: 'h' }));
  while (humans.length > wantH) sim.remove(humans.pop().id);

  driver.beforeInputs(host, sim.nowMs() + P);
  for (const h of humans) humanInputs(h);
  sim.applyInputs();
  const log = sim.step();
  driver.afterStep(host, log, sim.nowMs());
  const f = driver.stats();
  if (f.adds + f.removes !== lastFill) lastChangeMs = sim.nowMs();
  lastFill = f.adds + f.removes;

  if (tick % PER_SECOND === 0 && tick > 0) {
    const want = Math.max(0, B.curveTarget(wall) - humans.length);
    const bots = driver.count() + driver.waiting(); // a place waiting out its refill delay counts as filled
    const diff = Math.abs(bots - want);
    samples++;
    if (diff <= 1) {
      within1++;
      streak = 0;
    } else {
      streak++;
      if (streak > worstStreak) worstStreak = streak;
      // off by more than 1: the target moved that second, the pacer is busy (one change per 125 ms), or every extra
      // bot is seen by a human (retired only unseen); anything else is a miss
      const live = [];
      sim.forEachSnake((s) => {
        if (driver.isBot(s.id)) live.push(s);
      });
      if (prevWant !== null && Math.abs(want - prevWant) > 1) stepped++;
      else if (sim.nowMs() - lastChangeMs <= 2 * CHANGE_MS) catchingUp++;
      else if (bots > want && B.pickRetiree(live, seen) === null) blockedSeen++;
      else {
        misses++;
        if (process.env.SLB_DEBUG) console.log('miss', { minute: minute.toFixed(2), bots, want, humans: humans.length });
      }
    }
    if (diff > maxDiff) maxDiff = diff;
    prevWant = want;
  }
}
const st = driver.stats();
const problems = sim.check();
const secs = (Date.now() - t0) / 1000;
const share = samples ? within1 / samples : 0;

console.log('slBotsRun: ' + MINUTES + ' sim minutes, seed ' + SEED + ', curve speed ' + CURVE_SPEED + 'x, ' + TICKS +
  ' ticks in ' + secs.toFixed(1) + ' s');
for (const p of B.PERSONALITIES) {
  const k = st.kinds[p];
  const z = (v) => v || 0;
  console.log('  ' + p + ': spawned ' + k.spawned + ', died ' + k.died + ', retired ' + k.retired + ', live ' + k.live +
    ', thinks ' + z(k.thinks) + ' (food ' + z(k.food) + ', wander ' + z(k.wander) + ', border ' + z(k.border) + ', flee ' +
    z(k.flee) + ', hunt ' + z(k.hunt) + ', coil ' + z(k.coil) + ', pile ' + z(k.pile) + '), chases ' + z(k.chases) +
    ', coils ' + z(k.coils) + ', boosts ' + z(k.boosts) + ' (flee ' + z(k.fleeBoosts) + ', wall ' + z(k.panicBoosts) +
    ', chase ' + z(k.chaseBoosts) + ', pile ' + z(k.pileBoosts) + '), angle records ' + z(k.angles) + ', boost records ' +
    z(k.boostRecs));
}
console.log('  records ' + records + ', gate violations ' + gateViolations + ', wire round trip mismatches ' + wireMismatch);
console.log('  fill: ' + samples + ' one-second samples, ' + (100 * share).toFixed(1) +
  ' percent within 1 of (curve - humans), largest gap ' + maxDiff + ', longest stretch off by more than 1: ' +
  worstStreak + ' s');
console.log('  seconds off by more than 1: ' + stepped + ' the target moved by more than 1 that second, ' + catchingUp +
  ' pacer busy, ' + blockedSeen + ' every extra bot seen by a human (retired only unseen), ' + misses +
  ' misses; fill ' + JSON.stringify({ adds: st.adds, removes: st.removes, blocked: st.blocked, forced: st.forced }));
console.log('  sim check problems ' + problems.length + ', border radius at the end ' + sim.flux());

const fails = [];
function need(ok, what) {
  console.log((ok ? 'PASS ' : 'FAIL ') + what);
  if (!ok) fails.push(what);
}
const k = st.kinds;
need(B.PERSONALITIES.every((p) => k[p].spawned > 0), 'all three personalities spawned');
need((k.hunter.chases || 0) > 0 && (k.hunter.chaseBoosts || 0) > 0, 'hunters chased and boosted toward the cut');
need((k.shy.flee || 0) > 0 && (k.shy.hunt || 0) === 0, 'shy bots turned away from bigger snakes and never chased');
need((k.casual.food || 0) > 0, 'casual bots ate');
need(B.PERSONALITIES.some((p) => (k[p].fleeBoosts || 0) > 0), 'bots boosted away from bigger heads aimed at them');
need(B.PERSONALITIES.some((p) => (k[p].pile || 0) > 0), 'bots went for fresh death piles');
need(records > 0 && gateViolations === 0 && wireMismatch === 0, 'no input outside the client gates, every record a valid wire input');
need(misses === 0, 'fill follows the curve (every second within 1, or the target just moved, or the pacer busy, or every extra bot seen)');
need(problems.length === 0, 'sim invariants hold');
process.exit(fails.length ? 1 : 0);
