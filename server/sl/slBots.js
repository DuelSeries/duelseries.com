'use strict';
// slither.io free room: our own bots (SERVER-DESIGN 11; task T12; OWNER-ANSWERS Q2, "Bot fill", Q21, Q25).
//
// Owen's answers (BINDING): our OWN bots, three personalities like agar.io (casual, hunters, shy), normal names,
// random skins, no label; the count follows the DAILY CURVE like today (about 22 quiet to about 101 at peak,
// shared/constants.js BOT_MIN and BOT_MAX), real players replace bots; the event may take the whole bot budget (Q21),
// so this room never calls botPopulation.registerRoom (it reads botTarget only).
// Bots are not a parity area (PLAN:78): nothing here is slither.io's behaviour. Every tuning number sits in BOT_TUNING
// below, labelled CHOSEN; a test checks no other number appears in this file's code. Game rules come from the law
// table by id (L1 map centre, L7 update period, L15 input bytes, L22 boost floor, L35 body radius, BOT_* and C_GOV).
//
// What is here:
//   createBotBrain(seed, personality, laws)  one bot's brain. Pure and seeded: no Math.random, no Date, no io. Its
//       randomness (think phase, aim error, chances, the arrival offset of each record) comes from its own slRng
//       generator, so the same seed fed the same world gives the same records. brain.step(self, tickMs, sense, out)
//       runs once per tick for a live bot, BEFORE the room's applyInputs, and fills `out` with {rec, offsetMs}:
//       rec is exactly a decoded client input record (shared/slWire.js decodeInput: {type 'angle', q} or
//       {type 'boost', on}), offsetMs its arrival offset into the tick (C_INPUT_OFFSET), so every server law applies
//       to a bot exactly as to a person. The records keep the client's own send gates (public/js/sl/slInput.js:
//       angle attempts more than BOT_GATES.angleMs apart, boost changes more than BOT_GATES.boostMs apart, an angle
//       only when its byte changes), timed at the bot's virtual send time tickMs - offsetMs. Bots never send arrow
//       turns or pings. tickMs = the sim time of the tick that applies the records (sim.nowMs() + L7).
//       The brain re-decides every few ticks (staggered per bot) and reads the world through `sense`
//       (createBotSense(sim): the sim's sector grid and food store; no socket, no view, no encode).
//   createBotSense(sim)  the read-only world view a brain reads.
//   drawBotSpec(rng, laws, names)  one new bot: brain seed, personality by its share, skin, name (four draws from
//       the room's 'bot' stream, in that order).
//   spawnBot(sim, spec, inHumanView)  the bot snake on an L42 ring (sim.spawn), drawn again while its head lands
//       inside a human's view set, at most SPAWN_VIEW_TRIES draws (BOT_GATES spawn 'outsideHumanViews', "when
//       possible").
//   planBotFill({target, humans, bots, cap}, laws)  BOT_FILL: want = max(0, min(target, cap) - humans) bots.
//   curveTarget(wallMs)  the daily curve now (server/botPopulation.js botTarget; wall clock passed in).
//   createBotFill(laws)  the pacer: at most one add or one retirement per BOT_GATES.changeMs; a bot is retired only
//       when no seat holds it (BOT_GATES retire 'unseen'; pickRetiree).
//   createBotGovernor(laws)  the process-wide load governor (C_GOV, SERVER-DESIGN 11) and admitBot (refuses while
//       engaged and above C_ROOM_CAP); createLoopProbe(monitor, laws) the event-loop delay p99 over C_GOV.windowMs.
//   botSkins(laws), createNameBook(names), BOT_NAMES, PICTURE_SKIN_CVS, SKIN_MAX.
//   createBotDriver(laws, opts)  the room's bot driver (slRoom opts.bots: beforeInputs, afterStep, add, clear, count,
//       isBot): every part above wired to a room, as slRoom calls it each step.

const { assertLawsComplete, assertRulesBuilt } = require('./slLaws');
const { createRng } = require('./slRng');
const { botTarget } = require('../botPopulation');

const PI2 = 2 * Math.PI;

// Law rows each part reads.
const BRAIN_LAW_IDS = Object.freeze(['L1', 'L7', 'L15', 'L22', 'L35', 'BOT_KINDS', 'BOT_GATES']);
const FILL_LAW_IDS = Object.freeze(['BOT_FILL', 'BOT_GATES']);
const FILL_RULES_BUILT = Object.freeze(['dailyCurveMinusHumans']);
const GOV_LAW_IDS = Object.freeze(['C_GOV', 'C_FLUSH_SLICE_MS']);
const SKIN_LAW_IDS = Object.freeze(['PICTURE_SKINS']);
const PERSONALITIES = Object.freeze(['casual', 'hunter', 'shy']);

// BEGIN DATA
// Fixed facts, not tuning, each with its source.
// A brain seed is one uint32 draw (slRng generators take any uint32).
const UINT32_SPAN = 4294967296;
// perf_hooks.monitorEventLoopDelay histograms count nanoseconds (Node docs, perf_hooks); the governor reads the 99th
// percentile ("event-loop delay p99", SERVER-DESIGN 11).
const NS_PER_MS = 1e6;
const LOOP_PERCENTILE = 99;
// The shipped skins are cv 0 to 65: plain colours 0 to 8, the frozen client's stripe lists cover skins 9 to 65
// (public/js/sl/slSprites.js:628, last row 687) and every other cv draws as cv mod 9 (slSprites.js:837). The same 66
// skins carry drop colour rows (slLaws SKIN_DROP, BUILD-DECISIONS T1).
const SKIN_MAX = 65;
// The 12 picture skins: their client fills these canvases from PNG art, ours leaves them blank
// (public/js/sl/slSprites.js:409-424: "skins 37, 39-42, 45-49, 59, 62"). Bots use them only while PICTURE_SKINS is on.
const PICTURE_SKIN_CVS = Object.freeze([37, 39, 40, 41, 42, 45, 46, 47, 48, 49, 59, 62]);
// The 12 picture image files (SERVER-DESIGN 15.5; public/js/slx/slxSkins.js PICTURES loads exactly these). The
// PICTURE_SKINS switch is ONE switch for all of them (Owen 17:00: one off switch), so it goes on only when its
// reviewed list names every file (fixer pass, 2026-10-10: on with a short or empty list handed out all 12 skins and
// made the page ask for all 12 files, reviewed or not). No cv-to-file mapping is guessed.
const PICTURE_FILES = Object.freeze(['kwk6.png', 'jmou3.png', 'pewd.png', 'sest5.png', 'play.png', 'bonkers2.png',
  'leaf.png', 'swiss.png', 'moldova.png', 'vietnam.png', 'argentina.png', 'mov2.png']);
// Ordinary names (CHOSEN content, Q2 "normal names", no label). The old engine's list is the start
// (server/Bot.js:12-21) without 'ieatbots' (it says bot) and 'slitherio_pro' (the brand, legal line 4); the rest are
// ours. Every one passes their name rules (slNames.cleanNick: ASCII 32 to 127, 24 characters, no 7-digit run); a test
// checks it against the frozen client's gdnm. More names than BOT_MAX, so live bots never share a name.
const BOT_NAMES = Object.freeze([
  'aidan6969', 'jacobtheweiner78', 'quantum', 'Mr-1221z', 'slitherkinggg', 'xX_snake_Xx', 'noodleman', 'cobrakai99',
  'bigworm42', 'snek_lord', 'viper0011', 'hisssss', 'eaturdust', 'n00bslayer', 'wormhole_', 'slurpmaster', 'gg_no_re',
  'tryhard99', 'just_a_worm', 'toxic_snek', 'GigaWorm', 'boostgang', 'curvy_boi', 'nomnom_snek', 'deathcoil',
  'zoomzoom22', 'slimy_steve', 'wiggleking', 'ouroboros_', 'snekattack', 'longneck', 'ratboi420', 'fastaf_boii',
  'lmaosnek', 'noobmaster_', 'wormy_mcworm', 'danger_noodle', 'mr_slithers',
  'jake', 'Emma', 'lucas_b', 'mia2010', 'Noah', 'olivia :)', 'ethan', 'ava_xo', 'liam11', 'sophia', 'mason',
  'Isabella', 'logan', 'chloe', 'tyler', 'Grace', 'Ryan', 'zoe', 'kevin', 'nathan', 'hannah', 'dylan', 'Lily', 'caleb',
  'max', 'Leo', 'sam', 'alex', 'ben', 'jack', 'Daniel', 'matt', 'chris', 'josh', 'Tom', 'Anna', 'sarah', 'kyle',
  'eric', 'jay', 'Maria', 'Carlos', 'Diego', 'Luca', 'Mateo', 'Hugo', 'Lukas', 'Felix', 'Marco', 'Pedro', 'Ivan',
  'Yuki', 'Kenji', 'Omar', 'Sven', 'Jonas', 'Elias', 'pro gamer', 'BigSnake', 'the snake', 'snakey', 'Slinky',
  'Spaghetti', 'noodle', 'Wormy', 'Mr Snake', 'Python', 'Cobra', 'Mamba', 'Anaconda', 'rattler', 'sidewinder',
  'king cobra', 'Medusa', 'Hydra', 'Shadow', 'Ghost', 'Ninja', 'Phoenix', 'Blaze', 'Storm', 'Thunder', 'Frost', 'Venom',
  'Rex', 'Ace', 'Bolt', 'Dash', 'Turbo', 'Rocket', 'Comet', 'Nova', 'Titan', 'Atlas', 'Luna', 'Sky', 'River', 'pizza',
  'taco', 'Banana', 'potato', 'cookie', 'Pickle', 'Waffle', 'nugget', 'Mango', 'Kiwi', 'hi', 'lol', 'xd', 'gg', 'ez',
  'yo', ':)', 'help me', 'dont kill me', 'im new', 'friendly', 'follow me', 'just vibing', 'chill', 'hungry',
  'snack time', 'zzz', 'hello world', 'Mom', 'Dad', 'grandma', 'the king', 'Queen', 'Captain',
]);
// END DATA

// BEGIN BOT_TUNING
// Every number the bots tune themselves with. All CHOSEN (ours; Q2 and SERVER-DESIGN 11), none from slither.io.
// Distances are world units, times ms, think intervals sim updates (L7), chances per think, angles radians,
// lengths L = sct + fam (the L36 size). Shares are agar's (server/ag/agBots.js BOT_TUNING HUNTER_SHARE, CASUAL_SHARE,
// SHY_SHARE), the same mix Owen asked for there.
function chosen(value, note) {
  return Object.freeze({ value, status: 'CHOSEN', note });
}
const BOT_TUNING = Object.freeze({
  // Steering, every personality.
  BINS: chosen(24, 'headings scored per think (15 degrees apart), plus the goal heading itself'),
  LOOK_BASE: chosen(180, 'look-ahead for bodies and the border at any speed'),
  LOOK_PER_SP: chosen(12, 'extra look-ahead per unit of the bot speed (about 250 at 5.79, 350 boosting at 14)'),
  W_GOAL: chosen(1, 'weight of facing the goal (cosine of the gap)'),
  W_TURN: chosen(0.15, 'weight of keeping the current heading (cosine of the gap), so a bot does not swerve for nothing'),
  HEAD_LEAD_PER_SP: chosen(15, 'another head counts as a body along its heading this far per unit of its speed (about 87 at 5.79, 210 boosting)'),
  HEAD_LEAD_STEP: chosen(20, 'spacing of the points marked along that predicted path'),
  W_DANGER: chosen(4, 'weight of a body or the border ahead, times ((look - gap) / look) squared'),
  BORDER_CAUTION: chosen(0.92, 'outside this share of the border radius the bot heads for the middle'),
  BORDER_MARGIN: chosen(60, 'the border counts as a wall this far inside it'),
  FOOD_SENSE: chosen(320, 'food within this distance of the head is a goal'),
  FOOD_DIST_BIAS: chosen(40, 'distance added when scoring food (size byte over distance), so near food wins'),
  FOOD_BEHIND_MULT: chosen(0.3, 'food more than 90 degrees off the heading scores this share (no circling it)'),
  FOOD_GIVE_UP_MS: chosen(4000, 'a food goal held this long is dropped (the bot is circling it)'),
  WANDER_INSET: chosen(0.8, 'wander points are drawn in this share of the border radius'),
  WANDER_MS: chosen(8000, 'a new wander point at least this often'),
  WANDER_REACH: chosen(150, 'a wander point this close counts as reached'),
  BOOST_MIN_L: chosen(12, 'a bot presses boost only above this length (L22 refuses at or below 2.14 anyway)'),
  BOOST_STOP_L: chosen(8, 'a boosting bot lets go at or below this length'),
  BOOST_REST_MS: chosen(1500, 'least time between the end of one boost and the next press'),
  SPAWN_VIEW_TRIES: chosen(8, 'L42 draws a bot spawn may take to land outside every human view set'),
  // Hunters (cut in front of clearly smaller snakes, short boosts, give up quickly).
  HUNT_RANGE: chosen(700, 'a hunter looks for prey heads within this distance'),
  HUNT_RATIO: chosen(1.5, 'prey must be this many times shorter (L) than the hunter'),
  HUNT_MIN_L: chosen(20, 'a hunter shorter than this does not chase'),
  HUNT_CHASE_CHANCE: chosen(0.5, 'chance per think, with prey in range, that a chase starts'),
  HUNT_CUT_LEAD: chosen(160, 'the hunter aims this far ahead of the prey head along its heading'),
  HUNT_GIVE_UP_MS: chosen(4000, 'a chase ends after this long, caught or not'),
  HUNT_REST_MS: chosen(6000, 'no new chase for this long after one ends'),
  HUNT_BOOST_RANGE: chosen(350, 'a chasing hunter boosts when its aim point is this close'),
  HUNT_BOOST_MS: chosen(900, 'a hunter boost lasts this long'),
  // Shy (keeps clear of bigger bodies).
  SHY_RANGE: chosen(450, 'a shy bot turns away from bigger bodies within this distance'),
  SHY_RATIO: chosen(1.2, 'bigger means at least this many times its length (L)'),

  // Personalities: share of the bots, then each one's settings.
  //   THINK_MIN, THINK_MAX  updates between two decisions (drawn each time)
  //   AIM_JITTER            the heading misses by up to this much each think
  //   CLEAR_MARGIN          room kept from another body, on top of its L35 radius a x sc
  //   BOOST_CHANCE          chance per think of a boost for no reason, BOOST_MS long
  //   HUNTS, FLEES          1: chases smaller snakes (hunter) / turns away from bigger ones (shy)
  CASUAL_SHARE: chosen(0.6, 'share of bots that are casual (agar CASUAL_SHARE)'),
  CASUAL_THINK_MIN: chosen(3, 'casual: fewest updates between two decisions'),
  CASUAL_THINK_MAX: chosen(6, 'casual: most updates between two decisions'),
  CASUAL_AIM_JITTER: chosen(0.15, 'casual: aim error'),
  CASUAL_CLEAR_MARGIN: chosen(35, 'casual: room kept from other bodies'),
  CASUAL_BOOST_CHANCE: chosen(0.005, 'casual: chance per think of a short boost (rarely boosts)'),
  CASUAL_BOOST_MS: chosen(600, 'casual: that boost lasts this long'),
  CASUAL_HUNTS: chosen(0, 'casual: never chases'),
  CASUAL_FLEES: chosen(0, 'casual: no extra care around bigger snakes'),
  HUNTER_SHARE: chosen(0.15, 'share of bots that are hunters (agar HUNTER_SHARE)'),
  HUNTER_THINK_MIN: chosen(2, 'hunter: fewest updates between two decisions'),
  HUNTER_THINK_MAX: chosen(4, 'hunter: most updates between two decisions'),
  HUNTER_AIM_JITTER: chosen(0.05, 'hunter: aim error'),
  HUNTER_CLEAR_MARGIN: chosen(25, 'hunter: room kept from other bodies (cuts closer than shy)'),
  HUNTER_BOOST_CHANCE: chosen(0, 'hunter: boosts only in a chase'),
  HUNTER_BOOST_MS: chosen(0, 'hunter: (no idle boost)'),
  HUNTER_HUNTS: chosen(1, 'hunter: chases clearly smaller snakes'),
  HUNTER_FLEES: chosen(0, 'hunter: no extra care around bigger snakes'),
  SHY_SHARE: chosen(0.25, 'share of bots that are shy (agar SHY_SHARE)'),
  SHY_THINK_MIN: chosen(3, 'shy: fewest updates between two decisions'),
  SHY_THINK_MAX: chosen(5, 'shy: most updates between two decisions'),
  SHY_AIM_JITTER: chosen(0.1, 'shy: aim error'),
  SHY_CLEAR_MARGIN: chosen(40, 'shy: room kept from other bodies'),
  SHY_BOOST_CHANCE: chosen(0, 'shy: never boosts'),
  SHY_BOOST_MS: chosen(0, 'shy: (no idle boost)'),
  SHY_HUNTS: chosen(0, 'shy: never chases'),
  SHY_FLEES: chosen(1, 'shy: turns away from bigger bodies within SHY_RANGE'),
});
// END BOT_TUNING

const T = {};
for (const k of Object.keys(BOT_TUNING)) T[k] = BOT_TUNING[k].value;

const PROFILE_KEYS = Object.freeze(['SHARE', 'THINK_MIN', 'THINK_MAX', 'AIM_JITTER', 'CLEAR_MARGIN', 'BOOST_CHANCE',
  'BOOST_MS', 'HUNTS', 'FLEES']);

function buildProfile(name) {
  const prefix = name.toUpperCase() + '_';
  const p = { name };
  for (const k of PROFILE_KEYS) {
    const v = T[prefix + k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error('slBots: bad tuning ' + prefix + k);
    p[k] = v;
  }
  if (!Number.isInteger(p.THINK_MIN) || !Number.isInteger(p.THINK_MAX) || p.THINK_MIN < 1 || p.THINK_MAX < p.THINK_MIN) {
    throw new Error('slBots: ' + prefix + 'THINK_MIN and THINK_MAX must be whole updates, 1 or more, min not above max');
  }
  return Object.freeze(p);
}
const PROFILES = {};
let shareSum = 0;
for (const name of PERSONALITIES) {
  PROFILES[name] = buildProfile(name);
  shareSum += PROFILES[name].SHARE;
}
Object.freeze(PROFILES);
if (Math.abs(shareSum - 1) > Number.EPSILON * PERSONALITIES.length) throw new Error('slBots: personality shares must add up to 1');

function personalityProfile(name) {
  return Object.prototype.hasOwnProperty.call(PROFILES, name) ? PROFILES[name] : null;
}

// One draw: casual, hunter or shy by their shares.
function drawPersonality(rng) {
  const u = rng.next();
  let acc = 0;
  for (const name of PERSONALITIES) {
    acc += PROFILES[name].SHARE;
    if (u < acc) return name;
  }
  return PERSONALITIES[PERSONALITIES.length - 1];
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers.

function okNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function posNum(v, what) {
  if (!okNum(v) || v <= 0) throw new Error('slBots: ' + what + ' must be a positive number');
  return v;
}

// Signed shortest gap from angle a to angle b, in [-pi, pi].
function angleDiff(a, b) {
  let d = (b - a) % PI2;
  if (d > Math.PI) d -= PI2;
  else if (d < -Math.PI) d += PI2;
  return d;
}

// The L36 size L = sct + fam of a sim snake.
function lengthOf(s) {
  return s.pts.length + s.fam;
}

// The brain's law rows, checked once.
function brainLaws(laws) {
  assertLawsComplete(laws, BRAIN_LAW_IDS);
  const kinds = laws.BOT_KINDS.value;
  if (!kinds || !Array.isArray(kinds.personalities) || kinds.personalities.length !== PERSONALITIES.length ||
      kinds.personalities.some((p) => !PERSONALITIES.includes(p)) || kinds.label !== false) {
    throw new Error('slBots: BOT_KINDS must name casual, hunter and shy with no label');
  }
  const gates = laws.BOT_GATES.value;
  const L15 = laws.L15.value;
  if (!Number.isInteger(L15.maxAngle) || L15.maxAngle < 1) throw new Error('slBots: L15 maxAngle must be a whole byte');
  return Object.freeze({
    grd: posNum(laws.L1.value, 'L1'),
    P: posNum(laws.L7.value, 'L7'),
    maxAngle: L15.maxAngle,
    steps: L15.maxAngle + 1, // the client's ANGLE_STEPS: sang = floor(steps x ang / 2 pi) (slInput.js:296, L15)
    minL: posNum(laws.L22.value.minL, 'L22 minL'),
    a: posNum(laws.L35.value.a, 'L35 a'),
    angleMs: posNum(gates.angleMs, 'BOT_GATES angleMs'),
    boostMs: posNum(gates.boostMs, 'BOT_GATES boostMs'),
  });
}

// The client's angle byte of a heading (public/js/sl/slInput.js:293-296): wrapped to [0, 2 pi), floor(steps a / 2 pi).
function angleByte(K, a) {
  let w = a % PI2;
  if (w < 0) w += PI2;
  const q = Math.floor((K.steps * w) / PI2);
  return q > K.maxAngle ? K.maxAngle : q;
}

// ---------------------------------------------------------------------------------------------------------------
// The world a brain reads (read only).

function createBotSense(sim) {
  if (!sim || !sim.grid || typeof sim.snake !== 'function') throw new TypeError('slBots: createBotSense needs a sim');
  const grd = sim.laws.L1.value;
  const grid = sim.grid;
  return Object.freeze({
    grd,
    flux: () => sim.flux(),
    snake: (id) => sim.snake(id),
    forEachSnake: (fn) => sim.forEachSnake(fn),
    forEachPointNear: (x, y, r, fn) => grid.forEachPointInBox(x - r, y - r, x + r, y + r, fn),
    forEachFoodNear: (x, y, r, fn) => (sim.food ? sim.food.forEachInDisc(x, y, r, fn) : 0),
  });
}

// ---------------------------------------------------------------------------------------------------------------
// The brain.

function createBotBrain(seed, personality, laws) {
  if (!okNum(seed)) throw new TypeError('slBots: seed must be a finite number');
  const prof = personalityProfile(personality);
  if (!prof) throw new Error('slBots: unknown personality ' + String(personality));
  const K = brainLaws(laws);
  const rng = createRng(seed);
  const BINS = T.BINS;
  const binW = PI2 / BINS;
  const binX = new Float64Array(BINS);
  const binY = new Float64Array(BINS);
  for (let b = 0; b < BINS; b++) {
    binX[b] = Math.cos(b * binW);
    binY[b] = Math.sin(b * binW);
  }
  const gap = new Float64Array(BINS); // per heading: the smallest gap to contact ahead (body or border)
  const near = new Map(); // per think: snake id -> sim snake (or null)

  // Sending (the client gates, timed at the virtual send time tickMs - offsetMs).
  let wantQ = -1;
  let sentQ = -1;
  let lastAngleT = -Infinity;
  let wantBoost = false;
  let sentBoost = false;
  let lastBoostT = -Infinity;
  let boostUntil = -Infinity;
  let boostRestUntil = -Infinity;
  // Deciding.
  let thinkIn = 1 + rng.int(prof.THINK_MAX); // staggered: the first think within THINK_MAX updates
  let mode = 'idle';
  let chaseId = 0;
  let chaseSince = 0;
  let restUntil = -Infinity;
  let wanderX = 0;
  let wanderY = 0;
  let wanderUntil = -Infinity;
  let foodId = null;
  let foodSince = 0;
  let skipFoodId = null;
  const stats = { thinks: 0, border: 0, flee: 0, hunt: 0, food: 0, wander: 0, chases: 0, boosts: 0, angles: 0, boostRecs: 0 };

  // Per-think scratch.
  let me = null;
  let sense = null;
  let mx = 0;
  let my = 0;
  let myL = 0;
  let look = 0;
  let fleeX = 0;
  let fleeY = 0;
  let goalAng = 0;
  let curAng = 0;
  let bestFood = null;
  let bestScore = 0;
  let borderCx = 0;
  let borderCy = 0;
  let borderR2 = 0;
  let prey = null;
  let preyD2 = 0;

  function snakeOf(sid) {
    let o = near.get(sid);
    if (o === undefined) {
      o = sense.snake(sid);
      near.set(sid, o);
    }
    return o;
  }

  // A heading arc [theta - half, theta + half] holds a body this gap away: every bin whose centre is inside the arc
  // widened by half a bin keeps the smallest gap.
  function markArc(theta, half, g) {
    const span = half + binW / 2;
    const n = Math.ceil(span / binW);
    const b0 = Math.round(theta / binW);
    for (let k = -n; k <= n; k++) {
      const b = (((b0 + k) % BINS) + BINS) % BINS;
      if (Math.abs(angleDiff(theta, b * binW)) <= span && g < gap[b]) gap[b] = g;
    }
  }

  function visitPoint(p, sid) {
    if (sid === me.id) return; // L37: its own body never kills it
    const o = snakeOf(sid);
    if (!o) return;
    const dx = p.xx - mx;
    const dy = p.yy - my;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (prof.FLEES && d > 0 && d < T.SHY_RANGE && lengthOf(o) >= T.SHY_RATIO * myL) {
      const w = (T.SHY_RANGE - d) / (T.SHY_RANGE * d);
      fleeX -= dx * w;
      fleeY -= dy * w;
    }
    if (d > look) return;
    const c = K.a * o.sc + prof.CLEAR_MARGIN; // L35: a body kills within a x sc of it
    if (d > c) markArc(Math.atan2(dy, dx), Math.asin(c / d), d - c);
    else markArc(Math.atan2(dy, dx), Math.PI / 2, 0);
  }

  // Where another snake's head is about to be: its heading from the head, HEAD_LEAD_PER_SP x its speed long, marked
  // like body points (most deaths of a body-only model came from running into a head that moved in front).
  function markHead(o) {
    const lead = T.HEAD_LEAD_PER_SP * o.sp;
    const c = K.a * o.sc + prof.CLEAR_MARGIN;
    const ux = Math.cos(o.ang);
    const uy = Math.sin(o.ang);
    for (let t = 0; t <= lead; t += T.HEAD_LEAD_STEP) {
      const px = o.hx + ux * t - mx;
      const py = o.hy + uy * t - my;
      const d = Math.sqrt(px * px + py * py);
      if (d > look) continue;
      if (d > c) markArc(Math.atan2(py, px), Math.asin(c / d), d - c);
      else markArc(Math.atan2(py, px), Math.PI / 2, 0);
    }
  }

  // The border as a wall BORDER_MARGIN inside the disc of radius R around (cx, cy): per heading, the distance to it.
  function markBorder(cx, cy, R) {
    const ox = mx - cx;
    const oy = my - cy;
    const wall = R > T.BORDER_MARGIN ? R - T.BORDER_MARGIN : 0;
    const c0 = ox * ox + oy * oy - wall * wall;
    for (let b = 0; b < BINS; b++) {
      const bb = ox * binX[b] + oy * binY[b];
      const disc = bb * bb - c0;
      let t = disc > 0 ? -bb + Math.sqrt(disc) : 0;
      if (t < 0) t = 0;
      if (t < gap[b]) gap[b] = t;
    }
  }

  function binOf(th) {
    return ((Math.round(th / binW) % BINS) + BINS) % BINS;
  }

  function hazard(th) {
    const g = gap[binOf(th)];
    if (g >= look) return 0;
    const u = (look - g) / look;
    return T.W_DANGER * u * u;
  }

  function score(th) {
    return T.W_GOAL * Math.cos(th - goalAng) + T.W_TURN * Math.cos(th - curAng) - hazard(th);
  }

  // The goal heading itself, else the bin heading that scores best.
  function steer() {
    let best = goalAng;
    let bestS = score(goalAng);
    for (let b = 0; b < BINS; b++) {
      const s = score(b * binW);
      if (s > bestS) {
        bestS = s;
        best = b * binW;
      }
    }
    return best;
  }

  function startBoost(tickMs, ms) {
    if (wantBoost || tickMs < boostRestUntil || myL <= T.BOOST_MIN_L || myL <= K.minL) return;
    wantBoost = true;
    boostUntil = tickMs + ms;
    stats.boosts++;
  }

  function stopBoost(tickMs) {
    if (!wantBoost) return;
    wantBoost = false;
    boostRestUntil = tickMs + T.BOOST_REST_MS;
  }

  function endChase(tickMs) {
    chaseId = 0;
    restUntil = tickMs + T.HUNT_REST_MS;
    stopBoost(tickMs);
  }

  function visitHead(o) {
    if (o === me || !o.alive) return;
    const dx = o.hx - mx;
    const dy = o.hy - my;
    const d2 = dx * dx + dy * dy;
    if (d2 >= preyD2) return;
    if (myL < T.HUNT_RATIO * lengthOf(o)) return;
    preyD2 = d2;
    prey = o;
  }

  // Aim HUNT_CUT_LEAD ahead of the prey head along its heading; boost when close.
  function cutAt(o, tickMs) {
    const tx = o.hx + Math.cos(o.ang) * T.HUNT_CUT_LEAD;
    const ty = o.hy + Math.sin(o.ang) * T.HUNT_CUT_LEAD;
    const dx = tx - mx;
    const dy = ty - my;
    if (dx * dx + dy * dy < T.HUNT_BOOST_RANGE * T.HUNT_BOOST_RANGE) startBoost(tickMs, T.HUNT_BOOST_MS);
    return Math.atan2(dy, dx);
  }

  function huntGoal(tickMs) {
    if (chaseId !== 0) {
      const o = sense.snake(chaseId);
      let over = !o || !o.alive || tickMs - chaseSince >= T.HUNT_GIVE_UP_MS || myL < T.HUNT_RATIO * lengthOf(o);
      if (!over) {
        const dx = o.hx - mx;
        const dy = o.hy - my;
        over = dx * dx + dy * dy > T.HUNT_RANGE * T.HUNT_RANGE;
      }
      if (over) {
        endChase(tickMs);
        return null;
      }
      return cutAt(o, tickMs);
    }
    if (tickMs < restUntil || myL < T.HUNT_MIN_L) return null;
    prey = null;
    preyD2 = T.HUNT_RANGE * T.HUNT_RANGE;
    sense.forEachSnake(visitHead);
    const found = prey;
    prey = null;
    if (found === null || rng.next() >= T.HUNT_CHASE_CHANCE) return null;
    chaseId = found.id;
    chaseSince = tickMs;
    stats.chases++;
    return cutAt(found, tickMs);
  }

  function visitFood(f) {
    if (f.id === skipFoodId) return;
    const ex = f.x - borderCx;
    const ey = f.y - borderCy;
    if (ex * ex + ey * ey > borderR2) return; // food outside the wall is not worth the border
    const dx = f.x - mx;
    const dy = f.y - my;
    const d = Math.sqrt(dx * dx + dy * dy);
    const th = Math.atan2(dy, dx);
    if (gap[binOf(th)] < d) return; // a body or the wall lies between: not this one
    let s = f.b / (d + T.FOOD_DIST_BIAS);
    if (Math.abs(angleDiff(curAng, th)) > Math.PI / 2) s *= T.FOOD_BEHIND_MULT;
    if (s > bestScore) {
      bestScore = s;
      bestFood = f;
    }
  }

  function foodGoal(tickMs) {
    bestFood = null;
    bestScore = 0;
    sense.forEachFoodNear(mx, my, T.FOOD_SENSE, visitFood);
    const f = bestFood;
    bestFood = null;
    if (f === null) {
      foodId = null;
      return null;
    }
    if (f.id !== foodId) {
      foodId = f.id;
      foodSince = tickMs;
    } else if (tickMs - foodSince > T.FOOD_GIVE_UP_MS) {
      skipFoodId = foodId;
      foodId = null;
      return null;
    }
    return Math.atan2(f.y - my, f.x - mx);
  }

  function wanderGoal(tickMs, cx, cy, R) {
    const dx = wanderX - mx;
    const dy = wanderY - my;
    const wx = wanderX - cx;
    const wy = wanderY - cy;
    const inset = R * T.WANDER_INSET;
    if (!(tickMs < wanderUntil) || dx * dx + dy * dy < T.WANDER_REACH * T.WANDER_REACH || wx * wx + wy * wy > inset * inset) {
      const r = inset * Math.sqrt(rng.next());
      const a = rng.next() * PI2;
      wanderX = cx + r * Math.cos(a);
      wanderY = cy + r * Math.sin(a);
      wanderUntil = tickMs + T.WANDER_MS;
    }
    return Math.atan2(wanderY - my, wanderX - mx);
  }

  function think(tickMs) {
    mx = me.hx;
    my = me.hy;
    myL = lengthOf(me);
    curAng = me.ang;
    look = T.LOOK_BASE + T.LOOK_PER_SP * me.sp;
    gap.fill(Infinity);
    near.clear();
    fleeX = 0;
    fleeY = 0;
    const R = sense.flux();
    if (!okNum(R) || R <= 0) throw new Error('slBots: the bots need the border (sense.flux() > 0)');
    const cx = sense.grd;
    const cy = sense.grd;
    borderCx = cx;
    borderCy = cy;
    borderR2 = (R - T.BORDER_MARGIN) * (R - T.BORDER_MARGIN);
    sense.forEachPointNear(mx, my, prof.FLEES && T.SHY_RANGE > look ? T.SHY_RANGE : look, visitPoint);
    for (const o of near.values()) if (o) markHead(o);
    near.clear();
    markBorder(cx, cy, R);
    stats.thinks++;

    const ox = mx - cx;
    const oy = my - cy;
    let goal = null;
    if (ox * ox + oy * oy > T.BORDER_CAUTION * T.BORDER_CAUTION * R * R) {
      mode = 'border';
      goal = Math.atan2(-oy, -ox);
    } else if (prof.FLEES && (fleeX !== 0 || fleeY !== 0)) {
      mode = 'flee';
      goal = Math.atan2(fleeY, fleeX);
    } else if (prof.HUNTS && (goal = huntGoal(tickMs)) !== null) {
      mode = 'hunt';
    } else if ((goal = foodGoal(tickMs)) !== null) {
      mode = 'food';
    } else {
      mode = 'wander';
      goal = wanderGoal(tickMs, cx, cy, R);
    }
    stats[mode]++;
    if (mode !== 'hunt' && chaseId !== 0) endChase(tickMs);
    if (prof.BOOST_CHANCE > 0 && !wantBoost && myL > T.BOOST_MIN_L && rng.next() < prof.BOOST_CHANCE) {
      startBoost(tickMs, prof.BOOST_MS);
    }
    goalAng = goal + (rng.next() * 2 - 1) * prof.AIM_JITTER;
    wantQ = angleByte(K, steer());
  }

  // One record when its gate allows: the arrival offset is uniform over one update, like a person's input.
  function emit(tickMs, out) {
    if (wantQ >= 0 && wantQ !== sentQ) {
      const off = rng.next() * K.P;
      const t = tickMs - off;
      if (t - lastAngleT > K.angleMs) {
        out.push({ rec: { type: 'angle', q: wantQ }, offsetMs: off });
        sentQ = wantQ;
        lastAngleT = t;
        stats.angles++;
      }
    }
    if (wantBoost !== sentBoost) {
      const off = rng.next() * K.P;
      const t = tickMs - off;
      if (t - lastBoostT > K.boostMs) {
        out.push({ rec: { type: 'boost', on: wantBoost }, offsetMs: off });
        sentBoost = wantBoost;
        lastBoostT = t;
        stats.boostRecs++;
      }
    }
  }

  // Once per tick for a live bot, before applyInputs. Returns `out` (cleared first) holding {rec, offsetMs}.
  function step(self, tickMs, sns, out) {
    if (!Array.isArray(out)) throw new TypeError('slBots: step needs an out array');
    out.length = 0;
    if (!self || !self.alive) return out;
    if (!okNum(tickMs)) throw new TypeError('slBots: tickMs must be a finite number');
    me = self;
    sense = sns;
    myL = lengthOf(self);
    if (wantBoost && (tickMs >= boostUntil || myL <= T.BOOST_STOP_L)) stopBoost(tickMs);
    thinkIn--;
    if (thinkIn <= 0) {
      think(tickMs);
      thinkIn = prof.THINK_MIN + rng.int(prof.THINK_MAX - prof.THINK_MIN + 1);
    }
    emit(tickMs, out);
    me = null;
    sense = null;
    return out;
  }

  return {
    personality,
    step,
    mode: () => mode,
    stats: () => Object.assign({}, stats),
    rngState: () => rng.state(),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// New bots: skin, name, spec, spawn.

// The skins a bot draws from, uniform: every shipped skin cv 0 to SKIN_MAX, the picture skins only while the
// PICTURE_SKINS switch is on (Owen: one off switch, default off until he has reviewed each image).
function botSkins(laws) {
  assertLawsComplete(laws, SKIN_LAW_IDS);
  const sw = laws.PICTURE_SKINS.value;
  if (!sw || typeof sw.on !== 'boolean') throw new Error('slBots: PICTURE_SKINS must be {on: boolean, ...}');
  const reviewed = Array.isArray(sw.reviewed) ? sw.reviewed : null;
  if (!reviewed) throw new Error('slBots: PICTURE_SKINS must carry a reviewed list');
  for (const f of reviewed) {
    if (!PICTURE_FILES.includes(f)) throw new Error('slBots: PICTURE_SKINS reviewed names ' + JSON.stringify(f) + ', not one of the 12 picture files');
  }
  if (sw.on) {
    const missing = PICTURE_FILES.filter((f) => !reviewed.includes(f));
    if (missing.length) throw new Error('slBots: PICTURE_SKINS is on but not every picture file is reviewed: ' + missing.join(', '));
  }
  const out = [];
  for (let cv = 0; cv <= SKIN_MAX; cv++) if (sw.on || !PICTURE_SKIN_CVS.includes(cv)) out.push(cv);
  return Object.freeze(out);
}

// Names in use are not handed out again while a free one exists (the old engine's rule, server/Bot.js:41-47); one
// draw per take.
function createNameBook(names) {
  const list = names === undefined ? BOT_NAMES : names;
  if (!Array.isArray(list) || list.length === 0) throw new Error('slBots: name book needs names');
  const used = new Map();
  const free = [];
  return {
    take(rng) {
      free.length = 0;
      for (const n of list) if (!used.has(n)) free.push(n);
      const name = free.length > 0 ? free[rng.int(free.length)] : list[rng.int(list.length)];
      used.set(name, (used.get(name) || 0) + 1);
      return name;
    },
    release(name) {
      const k = used.get(name);
      if (k === undefined) return;
      if (k <= 1) used.delete(name);
      else used.set(name, k - 1);
    },
    inUse: () => used.size,
  };
}

// One new bot from the room's 'bot' stream: brain seed, personality, skin, name, in that order (four draws).
function drawBotSpec(rng, laws, names) {
  const skins = botSkins(laws);
  const seed = Math.floor(rng.next() * UINT32_SPAN);
  const personality = drawPersonality(rng);
  const cv = skins[rng.int(skins.length)];
  const nick = names.take(rng);
  return { seed, personality, cv, nick };
}

// The bot snake on an L42 ring (the sim's own spawn ring and clearance); while its head lands inside a human's view
// set (inHumanView(x, y) true) it is taken out (no drops, no record: nobody was sent it) and drawn again, at most
// SPAWN_VIEW_TRIES draws in all; the last draw stays.
function spawnBot(sim, spec, inHumanView) {
  let s = null;
  for (let t = 0; t < T.SPAWN_VIEW_TRIES; t++) {
    s = sim.spawn({ cv: spec.cv, nick: spec.nick });
    if (typeof inHumanView !== 'function' || t === T.SPAWN_VIEW_TRIES - 1 || !inHumanView(s.hx, s.hy)) return s;
    sim.remove(s.id);
  }
  return s;
}

// ---------------------------------------------------------------------------------------------------------------
// Fill.

// The daily curve now: server/botPopulation.js botTarget (BOT_MIN 22 to BOT_MAX 101, shared/constants.js:293, 317),
// read only; never registerRoom (Q21). wallMs is the wall clock, passed in so this file never reads Date.
function curveTarget(wallMs) {
  if (!okNum(wallMs) || wallMs <= 0) throw new TypeError('slBots: curveTarget needs the wall clock in ms');
  return botTarget(wallMs);
}

function count(v, what) {
  if (!Number.isInteger(v) || v < 0) throw new TypeError('slBots: ' + what + ' must be a whole number >= 0');
  return v;
}

// BOT_FILL: bots = max(0, target - humans), the room total held to the cap (bots yield first: a human is refused only
// when humans alone fill it). target = the curve target, already times the governor multiplier (createBotFill).
// cap null or absent = no cap (the real C_ROOM_CAP comes from the T15 load test).
function planBotFill(o, laws) {
  assertLawsComplete(laws, FILL_LAW_IDS);
  assertRulesBuilt(laws, ['BOT_FILL'], FILL_RULES_BUILT);
  if (!o || typeof o !== 'object') throw new TypeError('slBots: planBotFill needs {target, humans, bots, cap}');
  const target = count(o.target, 'target');
  const humans = count(o.humans, 'humans');
  const bots = count(o.bots, 'bots');
  const cap = o.cap === null || o.cap === undefined ? Infinity : count(o.cap, 'cap');
  const total = target < cap ? target : cap;
  const want = total > humans ? total - humans : 0;
  return { want, add: want > bots ? want - bots : 0, remove: bots > want ? bots - want : 0 };
}

// The bot to retire: the shortest (L) bot no seat holds, ties to the lower id; null when every bot is seen.
// bots: iterable of sim snakes; isSeen(id) true while any seat holds the snake (slView, task T8). force (the room is
// over its cap, so bots yield to humans at once): the shortest bot even when seen (it vanishes for those seats).
function pickRetiree(bots, isSeen, force) {
  let best = null;
  for (const s of bots) {
    if (force !== true && isSeen(s.id)) continue;
    if (best === null || lengthOf(s) < lengthOf(best) || (lengthOf(s) === lengthOf(best) && s.id < best.id)) best = s;
  }
  return best;
}

// The pacer: step(nowMs, {target, humans, bots, cap, mult, retiree}) -> {op: 'add'} | {op: 'remove', id, forced} | null.
// At most one change per BOT_GATES.changeMs (real players replace bots one at a time); target is multiplied by the
// governor's mult (floor); retiree(force) gives an unseen bot or null (then nothing is removed this time). force is
// true only while humans + bots are over the cap (SERVER-DESIGN 12.1: bots yield first), so a seen bot may go.
function createBotFill(laws) {
  assertLawsComplete(laws, FILL_LAW_IDS);
  const changeMs = posNum(laws.BOT_GATES.value.changeMs, 'BOT_GATES changeMs');
  if (laws.BOT_GATES.value.retire !== 'unseen') throw new Error('slBots: BOT_GATES retire must be unseen');
  let last = -Infinity;
  const st = { adds: 0, removes: 0, blocked: 0, forced: 0 };
  return {
    step(nowMs, o) {
      if (!okNum(nowMs)) throw new TypeError('slBots: nowMs must be a finite number');
      const mult = o.mult === undefined ? 1 : o.mult;
      if (!okNum(mult) || mult < 0 || mult > 1) throw new RangeError('slBots: mult must be in [0, 1]');
      const plan = planBotFill({ target: Math.floor(count(o.target, 'target') * mult), humans: o.humans, bots: o.bots, cap: o.cap }, laws);
      if (nowMs - last < changeMs) return null;
      if (plan.add > 0) {
        last = nowMs;
        st.adds++;
        return { op: 'add', want: plan.want };
      }
      if (plan.remove > 0) {
        const over = o.cap !== null && o.cap !== undefined && o.humans + o.bots > o.cap;
        const s = typeof o.retiree === 'function' ? o.retiree(over) : null;
        if (!s) {
          st.blocked++;
          return null;
        }
        last = nowMs;
        st.removes++;
        if (over) st.forced++;
        return { op: 'remove', id: s.id, want: plan.want, forced: over };
      }
      return null;
    },
    stats: () => Object.assign({}, st),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The governor (C_GOV, SERVER-DESIGN 11): fed by the whole process, because paid snake, agar and Paper share the Node
// thread. sample(nowMs, {loopP99Ms, sliceMaxMs, paidPlayers, paid: [{latePct, baselinePct}]}) once a second:
//   engages when loopP99Ms > loopP99Ms, or sliceMaxMs > sliceMult x C_FLUSH_SLICE_MS, or any occupied paid room's
//   late-tick share (percent) exceeds its measured baseline by more than paidLatePoints; every threshold is divided
//   by 2 while paidPlayers > 0 (halveWhilePaid). Engaged: mult x stepMult at once and every stepMs, and admitBot
//   refuses. It recovers when every input is under recoverShare of its threshold; then mult climbs back by
//   / stepMult every stepMs up to 1. Humans are never removed (mult only lowers the bot target).
// sample returns 'engaged', 'recovered', 'down', 'up' or null, for the log and the console.
function createBotGovernor(laws) {
  assertLawsComplete(laws, GOV_LAW_IDS);
  const g = laws.C_GOV.value;
  const sliceMs = posNum(laws.C_FLUSH_SLICE_MS.value, 'C_FLUSH_SLICE_MS');
  for (const k of ['loopP99Ms', 'windowMs', 'paidLatePoints', 'sliceMult', 'stepMult', 'stepMs', 'recoverShare']) {
    posNum(g[k], 'C_GOV ' + k);
  }
  if (g.stepMult >= 1 || g.recoverShare >= 1) throw new Error('slBots: C_GOV stepMult and recoverShare must be under 1');
  if (typeof g.halveWhilePaid !== 'boolean') throw new Error('slBots: C_GOV halveWhilePaid must be a boolean');
  let engaged = false;
  let mult = 1;
  let nextStep = Infinity;
  let why = '';
  const st = { samples: 0, engagements: 0, steps: 0 };

  function nonNeg(v, what) {
    if (!okNum(v) || v < 0) throw new TypeError('slBots: governor input ' + what + ' must be a number >= 0');
    return v;
  }

  function sample(nowMs, inp) {
    if (!okNum(nowMs)) throw new TypeError('slBots: nowMs must be a finite number');
    if (!inp || typeof inp !== 'object') throw new TypeError('slBots: governor sample needs its inputs');
    st.samples++;
    const loop = nonNeg(inp.loopP99Ms, 'loopP99Ms');
    const slice = nonNeg(inp.sliceMaxMs, 'sliceMaxMs');
    const paidPlayers = count(inp.paidPlayers, 'paidPlayers');
    const div = g.halveWhilePaid && paidPlayers > 0 ? 2 : 1;
    const tLoop = g.loopP99Ms / div;
    const tSlice = (g.sliceMult * sliceMs) / div;
    const tPaid = g.paidLatePoints / div;
    let paidExcess = 0;
    for (const r of inp.paid || []) {
      const e = nonNeg(r.latePct, 'latePct') - nonNeg(r.baselinePct, 'baselinePct');
      if (e > paidExcess) paidExcess = e;
    }
    const over = loop > tLoop || slice > tSlice || paidExcess > tPaid;
    const s = g.recoverShare;
    const under = loop < tLoop * s && slice < tSlice * s && paidExcess < tPaid * s;
    if (!engaged && over) {
      engaged = true;
      why = loop > tLoop ? 'loop' : slice > tSlice ? 'slice' : 'paid';
      mult *= g.stepMult;
      nextStep = nowMs + g.stepMs;
      st.engagements++;
      st.steps++;
      return 'engaged';
    }
    if (engaged && under) {
      engaged = false;
      nextStep = nowMs + g.stepMs;
      return 'recovered';
    }
    if (nowMs >= nextStep) {
      if (engaged) {
        mult *= g.stepMult;
        nextStep = nowMs + g.stepMs;
        st.steps++;
        return 'down';
      }
      if (mult < 1) {
        mult /= g.stepMult;
        if (mult > 1) mult = 1;
        nextStep = mult < 1 ? nowMs + g.stepMs : Infinity;
        return 'up';
      }
    }
    return null;
  }

  // slRoom.addBot (and the owner console's bots:add) asks this first: refused while engaged, and when one more snake
  // would pass the room cap (cap null = none yet).
  function admitBot(o) {
    if (engaged) return { ok: false, why: 'governor' };
    const snakes = count(o && o.snakes, 'snakes');
    const cap = !o || o.cap === null || o.cap === undefined ? Infinity : count(o.cap, 'cap');
    if (snakes + 1 > cap) return { ok: false, why: 'cap' };
    return { ok: true, why: '' };
  }

  return {
    sample,
    admitBot,
    engaged: () => engaged,
    mult: () => mult,
    stats: () => Object.assign({ engaged, mult, why }, st),
  };
}

// Event-loop delay p99 over C_GOV.windowMs from a perf_hooks.monitorEventLoopDelay() histogram (enabled by the
// caller): read(nowMs) is the larger of the last whole window's p99 and the current window's so far, in ms, so a stall
// shows at the next read and counts for one whole window after it.
function createLoopProbe(monitor, laws) {
  assertLawsComplete(laws, GOV_LAW_IDS);
  if (!monitor || typeof monitor.percentile !== 'function' || typeof monitor.reset !== 'function') {
    throw new TypeError('slBots: createLoopProbe needs a monitorEventLoopDelay histogram');
  }
  const windowMs = posNum(laws.C_GOV.value.windowMs, 'C_GOV windowMs');
  let start = null;
  let lastP99 = 0;
  function p99() {
    const v = monitor.percentile(LOOP_PERCENTILE) / NS_PER_MS;
    return okNum(v) && v > 0 ? v : 0;
  }
  return {
    read(nowMs) {
      if (!okNum(nowMs)) throw new TypeError('slBots: nowMs must be a finite number');
      if (start === null) start = nowMs;
      if (nowMs - start >= windowMs) {
        lastP99 = p99();
        monitor.reset();
        start = nowMs;
      }
      const cur = p99();
      return cur > lastP99 ? cur : lastP99;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The room's bot driver (slRoom opts.bots; slRoom calls beforeInputs at step 0 and afterStep after the deaths of the
// step, SERVER-DESIGN 5.3 steps 0 and 8).
//
// The room surface it reads, each part optional except sim and spawnSnake:
//   room.sim                         the world sim
//   room.spawnSnake({cv, nick, isBot: true})   a snake on an L42 ring (so the room knows its name for kill lines)
//   room.removeBot(id)               takes a bot out (a room removal: the view sends C_CASHOUT_CODE to its holders);
//                                    absent: sim.remove plus the room's names and freedAt maps, as slRoom._cashOut does
//   room.now()                       the wall clock (the daily curve); absent: opts.now
//   room.playerCount                 seated humans (real players replace bots)
//   room.world.idBlocked(id), room._idBlocked(id)   true while a seat holds the snake (retire only unseen); with
//                                    neither, every bot counts as seen (only an over-cap retirement may take one)
//   room.seats (values with snakeId) the human heads; a new bot is drawn again while its head lands in the L8.R2
//                                    large sector window around one of them (an approximation of the view set, which
//                                    holds the sectors around an anchor at most about one sector ahead of the head)
//   room._botsPausedUntil            wall ms; the owner console's bots:clear window (server/index.js:1241): no
//                                    automatic adds until then
// opts: { governor (createBotGovernor; its mult lowers the target, and while engaged nothing is added), now (wall ms
// function, when the room has none), onRecord(id, rec, offsetMs, tickMs) (tools and tests watch the records) }.
// Bots added by hand through add(room) return their record; the console marks it manual (server/index.js:1258) and
// the automatic fill then neither counts nor retires it.
const DRIVER_LAW_IDS = Object.freeze(['L2.size', 'L8.R2', 'C_ROOM_CAP']);

function createBotDriver(laws, opts) {
  const o = opts || {};
  brainLaws(laws);
  assertLawsComplete(laws, FILL_LAW_IDS);
  assertLawsComplete(laws, ['L2.size', 'L8.R2']);
  const sectorSize = posNum(laws['L2.size'].value, 'L2.size');
  const r2 = posNum(laws['L8.R2'].value.large, 'L8.R2 large');
  const capRow = laws.C_ROOM_CAP ? laws.C_ROOM_CAP.value : null;
  const cap = capRow === null || capRow === undefined ? null : count(capRow, 'C_ROOM_CAP');
  const governor = o.governor || null;
  const onRecord = typeof o.onRecord === 'function' ? o.onRecord : null;
  const fill = createBotFill(laws);
  const names = createNameBook();
  const recs = new Map(); // snake id -> {id, nick, personality, cv, manual, brain}
  const per = {}; // personality -> {spawned, died, retired, and the brain stats of every bot that has left}
  for (const p of PERSONALITIES) per[p] = { spawned: 0, died: 0, retired: 0 };
  const out = [];
  const auto = [];
  const heads = [];
  let sense = null;
  let senseSim = null;
  let room = null; // the room of the current call

  function senseOf(r) {
    if (senseSim !== r.sim) {
      sense = createBotSense(r.sim);
      senseSim = r.sim;
    }
    return sense;
  }

  function wallNow(r) {
    const t = typeof r.now === 'function' ? r.now() : typeof o.now === 'function' ? o.now() : NaN;
    if (!okNum(t)) throw new Error('slBots: the driver needs a wall clock (room.now or opts.now)');
    return t;
  }

  function isSeen(id) {
    const w = room.world;
    const a = w && typeof w.idBlocked === 'function';
    const b = typeof room._idBlocked === 'function';
    if (!a && !b) return true;
    return (a && w.idBlocked(id) === true) || (b && room._idBlocked(id) === true);
  }

  function inHumanView(x, y) {
    if (heads.length === 0) return false;
    const sx = Math.floor(x / sectorSize);
    const sy = Math.floor(y / sectorSize);
    for (let i = 0; i < heads.length; i += 2) {
      const dx = sx - heads[i];
      const dy = sy - heads[i + 1];
      if (dx * dx + dy * dy <= r2) return true;
    }
    return false;
  }

  function loadHeads(r) {
    heads.length = 0;
    if (!r.seats || typeof r.seats.values !== 'function') return;
    for (const seat of r.seats.values()) {
      const s = seat && r.sim.snake(seat.snakeId);
      if (s && !recs.has(s.id)) heads.push(Math.floor(s.hx / sectorSize), Math.floor(s.hy / sectorSize));
    }
  }

  function takeOut(r, id) {
    if (typeof r.removeBot === 'function') {
      r.removeBot(id);
    } else {
      r.sim.remove(id);
      if (r.names && typeof r.names.delete === 'function') r.names.delete(id);
      if (r.freedAt && typeof r.freedAt.set === 'function') r.freedAt.set(id, r.sim.nowMs());
    }
  }

  function addInto(acc, st) {
    for (const k of Object.keys(st)) acc[k] = (acc[k] || 0) + st[k];
  }

  function forget(id, why) {
    const rec = recs.get(id);
    if (!rec) return;
    const p = per[rec.personality];
    if (why === 'died') p.died++;
    else if (why === 'retired') p.retired++;
    addInto(p, rec.brain.stats());
    names.release(rec.nick);
    recs.delete(id);
  }

  // One new bot: spec from the 'bot' stream, then a ring spawn drawn again (at most SPAWN_VIEW_TRIES) while it lands
  // in a human's window; a draw taken back was never sent to anyone.
  function spawnOne(r, manual) {
    const spec = drawBotSpec(r.sim.rng.bot, laws, names);
    loadHeads(r);
    let s = null;
    for (let t = 0; t < T.SPAWN_VIEW_TRIES; t++) {
      s = r.spawnSnake({ cv: spec.cv, nick: spec.nick, isBot: true });
      if (t === T.SPAWN_VIEW_TRIES - 1 || !inHumanView(s.hx, s.hy)) break;
      takeOut(r, s.id);
    }
    const rec = { id: s.id, nick: spec.nick, personality: spec.personality, cv: spec.cv, manual: manual === true,
      brain: createBotBrain(spec.seed, spec.personality, laws) };
    recs.set(s.id, rec);
    per[spec.personality].spawned++;
    return rec;
  }

  function retiree(force) {
    return pickRetiree(auto, isSeen, force);
  }

  function beforeInputs(r, tickSimMs) {
    const sns = senseOf(r);
    for (const [id, rec] of recs) {
      const s = r.sim.snake(id);
      if (!s) continue; // gone in a way afterStep has not seen yet
      rec.brain.step(s, tickSimMs, sns, out);
      for (let i = 0; i < out.length; i++) {
        const e = out[i];
        if (onRecord) onRecord(id, e.rec, e.offsetMs, tickSimMs);
        r.sim.setInput(id, e.rec, e.offsetMs);
      }
    }
  }

  function afterStep(r, log, simMs) {
    for (let i = 0; i < log.deaths.length; i++) forget(log.deaths[i].id, 'died');
    for (const id of Array.from(recs.keys())) if (!r.sim.snake(id)) forget(id, 'gone'); // taken out by someone else
    room = r;
    auto.length = 0;
    let manual = 0;
    for (const rec of recs.values()) {
      if (rec.manual) manual++;
      else auto.push(r.sim.snake(rec.id));
    }
    const wall = wallNow(r);
    const humans = Number.isInteger(r.playerCount) && r.playerCount > 0 ? r.playerCount : 0;
    const paused = okNum(r._botsPausedUntil) && wall < r._botsPausedUntil;
    const act = fill.step(simMs, {
      target: paused ? 0 : curveTarget(wall),
      humans,
      bots: auto.length,
      cap: cap === null ? null : (cap > manual ? cap - manual : 0),
      mult: governor ? governor.mult() : 1,
      retiree,
    });
    if (act && act.op === 'add' && !(governor && governor.engaged())) spawnOne(r, false);
    else if (act && act.op === 'remove') {
      takeOut(r, act.id);
      forget(act.id, 'retired');
    }
    auto.length = 0;
    room = null;
  }

  // The owner console's bots:add (through slRoom.addBot): refused while the governor is engaged or at the cap.
  function add(r) {
    if (governor && !governor.admitBot({ snakes: r.sim.count(), cap }).ok) return null;
    if (cap !== null && r.sim.count() + 1 > cap) return null;
    return spawnOne(r, false);
  }

  // The owner console's bots:clear: every bot out now (the console then pauses the fill for its window).
  function clear(r) {
    let n = 0;
    for (const id of Array.from(recs.keys())) {
      if (r.sim.snake(id)) takeOut(r, id);
      forget(id, 'cleared');
      n++;
    }
    return n;
  }

  return {
    beforeInputs,
    afterStep,
    add,
    clear,
    count: () => recs.size,
    isBot: (id) => recs.has(id),
    personalityOf: (id) => (recs.has(id) ? recs.get(id).personality : null),
    // per personality: live, spawned, died, retired, and the summed brain stats (thinks, modes, chases, boosts,
    // records) of every bot that has lived in this room
    stats: () => {
      const kinds = {};
      for (const p of PERSONALITIES) kinds[p] = Object.assign({ live: 0 }, per[p]);
      for (const rec of recs.values()) {
        kinds[rec.personality].live++;
        addInto(kinds[rec.personality], rec.brain.stats());
      }
      return Object.assign({ bots: recs.size, names: names.inUse(), kinds }, fill.stats());
    },
  };
}

module.exports = {
  BOT_TUNING,
  BOT_NAMES,
  PERSONALITIES,
  PICTURE_SKIN_CVS,
  PICTURE_FILES,
  SKIN_MAX,
  BRAIN_LAW_IDS,
  FILL_LAW_IDS,
  GOV_LAW_IDS,
  personalityProfile,
  drawPersonality,
  angleByte,
  brainLaws,
  createBotSense,
  createBotBrain,
  botSkins,
  createNameBook,
  drawBotSpec,
  spawnBot,
  curveTarget,
  planBotFill,
  pickRetiree,
  createBotFill,
  createBotGovernor,
  createLoopProbe,
  DRIVER_LAW_IDS,
  createBotDriver,
};
