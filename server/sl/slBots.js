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
//       Owen 2026-10-16: "as good as you can make them, make them boost, make them look like real players". So a
//       bot boosts away from a bigger head aimed at it, boosts in a chase toward a real intercept point, coils round
//       smaller prey when it gets ahead of it, goes for fresh death piles (boosting when they are big and close), and
//       sprints back from the wall or the battle royale circle once it is turned inward. Every boost is short, its
//       length drawn, and refused when the bot is too short to spend the mass.
//   createBotSense(sim, piles)  the read-only world view a brain reads; piles() lists recent death piles.
//   drawBotSpec(rng, laws, names, avoid)  one new bot: brain seed, personality by its share, skin (about 6 in 10 a
//       plain colour, the rest any other shipped skin), name (four draws from the room's 'bot' stream, in that
//       order). The name comes from server/botNames.js (a few hundred base names, dressed the way people type
//       them), never one a live bot or a seated person in the room already has (avoid).
//   spawnBot(sim, spec, inHumanView)  the bot snake on an L42 ring (sim.spawn), drawn again while its head lands
//       inside a human's view set, at most SPAWN_VIEW_TRIES draws (BOT_GATES spawn 'outsideHumanViews', "when
//       possible").
//   planBotFill({target, humans, bots, cap}, laws)  BOT_FILL: want = max(0, min(target, cap) - humans) bots.
//   curveTarget(wallMs)  the daily curve now (server/botPopulation.js botTarget; wall clock passed in).
//   createBotFill(laws)  the pacer: at most one add or one retirement per BOT_GATES.changeMs; a bot is retired only
//       when no seat holds it (BOT_GATES retire 'unseen'; pickRetiree).
//   createBotGovernor(laws)  the process-wide load governor (C_GOV, SERVER-DESIGN 11) and admitBot (refuses while
//       engaged and above C_ROOM_CAP); createLoopProbe(monitor, laws, elu) the event-loop delay p99 over
//       C_GOV.windowMs above this process's own idle floor.
//   botSkins(laws), createNameBook(names), BOT_NAMES, PICTURE_SKIN_CVS, SKIN_MAX.
//   createBotDriver(laws, opts)  the room's bot driver (slRoom opts.bots: beforeInputs, afterStep, add, clear, count,
//       isBot): every part above wired to a room, as slRoom calls it each step. The owner console's controls ride
//       on it too: setTarget(room, n | null) holds an exact live bot count (null: back to the daily curve),
//       target(room) reads it, removeBots(room, n) retires n bots now. A dead bot's place is filled again after a
//       random wait (mean REFILL_MEAN_MS), so the room total moves the way a real server's does.

const { assertLawsComplete, assertRulesBuilt } = require('./slLaws');
const { createRng } = require('./slRng');
const { botTarget } = require('../botPopulation');
const { BASE_NAMES, pickName } = require('../botNames');

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
// The loop monitor's timer period: 1 ms, the finest monitorEventLoopDelay takes (resolution is in whole ms, Node docs).
// Its histogram holds the time between the monitor's own timer callbacks, so an idle process reads its OS timer
// period, not 0. Measured on Owen's Windows 11 box (Node 24.13.1, 2026-10-11): a bare idle process, p50 15.5 ms and
// p99 16.4 to 16.5 ms (the 64 Hz system timer; resolution 10 reads the same); a 20 ms burn every 50 ms, p99 20.2 ms;
// a 40 ms burn every 50 ms, p99 40.1 ms. A Linux box keeps 1 ms timers, so its idle reading sits near the resolution
// (not measured here: no Linux on this box).
const LOOP_RESOLUTION_MS = 1;
// A calm stretch: the loop was busy under this share of it (perf_hooks eventLoopUtilization), so its p99 is the
// timer's own granularity plus the process's background work, not an overload; createLoopProbe takes its idle floor
// only from calm stretches. CHOSEN about midway between the busy shares measured on that box (2026-10-11, one-second
// spans). The whole local server (scripts/dev-local.js: the old snake rooms, agar and Paper with their bots, plus the
// sl room with 51 to 57 bots and one player) at rest: 0.04 to 0.09 (p99 16.2 to 19.6 ms) on a quiet machine, 0.10 to
// 0.29 (p99 17.4 to 36.3 ms) while other node processes loaded it; the same server under a forced burn of 40 ms every
// 50 ms: 0.655 to 0.864. A bare process: idle 0.002; a 20 ms burn every 50 ms 0.32; a 40 ms burn every 50 ms 0.64; a
// setImmediate spin 1.0 (its p99 falls to 1 ms, so it must never be a floor).
const LOOP_CALM_BUSY = 0.5;
// The highest idle floor createLoopProbe ever takes. The floor exists to take out the OS timer's granularity (Windows'
// 64 Hz tick, 15.625 ms) and a quiet process's background work, never load: measured on Owen's box (2026-10-11) a bare
// idle process read p99 16.4 to 16.5 ms, the whole local server at rest on a quiet machine 16.2 to 19.6 ms, and the
// governor proof run's floor was 20.0 ms. A calm share alone cannot tell that from load: a loop blocked 40 ms in
// every 100 is busy only 0.4, under LOOP_CALM_BUSY, and a process that boots straight into it took a 40 ms floor and
// read 0 against the 15 ms bar for as long as the load lasted (verifier, 2026-10-11). CHOSEN: 20 ms, the highest
// floor measured at rest; a p99 above it is load on either system (Linux keeps 1 ms timers, so its floor sits far
// below and this never binds there). On a box loaded by other processes (rest floors 17.1 to 25.9 ms measured) the
// governor reads up to about 6 ms more than before, still under the bar.
const LOOP_FLOOR_MAX_MS = 20;
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
// Ordinary names (Q2 "normal names", no label): the base names of server/botNames.js, one pool for every game with
// bots. The old list (169 names, 6 of them under the 3 characters a real account needs) repeated the same handful on
// screen every day; the generator there dresses a few hundred base names the way people type them (lower case, two
// digits on the end, a birth year, xX_name_Xx). Every base name passes their name rules (slNames.cleanNick: ASCII 32
// to 127, 24 characters, no 7-digit run, none of < > " ' &), checked by the tests with generated names too.
const BOT_NAMES = BASE_NAMES;
// The longest name a bot is given here: their name cap (L45 nameMax, 24 characters; slNames cleanNick cuts there).
const NICK_MAX = 24;
// The plain colours are cv 0 to 8, nine of them: what a person who never opens Customize is given
// (server/sl/slSockets.js skinOf, "a random plain colour 0 to 8").
const PLAIN_SKINS = 9;
// The owner console's bots:set range: 0 to 200 live bots in one room (the Control contract, 2026-10-16). The room's
// own cap (C_ROOM_CAP) still holds bots and people together.
const TARGET_MAX = 200;
// END DATA

// BEGIN BOT_TUNING
// Every number the bots tune themselves with. All CHOSEN (ours; Q2 and SERVER-DESIGN 11), none from slither.io.
// Distances are world units, times ms, think intervals sim updates (L7), chances per think, angles radians (or the
// cosine of one, _COS), lengths L = sct + fam (the L36 size). The first shares were agar's (server/ag/agBots.js);
// Owen's 2026-10-16 ask ("as good as you can make them") moved more bots to hunting and gave every bot the flee,
// scavenge and wall reflexes a person has.
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
  SPAWN_VIEW_TRIES: chosen(8, 'L42 draws a bot spawn may take to land outside every human view set'),

  // Boost, every personality. A press lasts a drawn length (a person never holds it the same time twice) and the
  // rest after it is drawn too; L22 and the sim charge the mass exactly as for a person.
  BOOST_MIN_L: chosen(12, 'a bot presses boost only above this length (L22 refuses at or below 2.14 anyway)'),
  BOOST_STOP_L: chosen(8, 'a boosting bot lets go at or below this length'),
  BOOST_AFFORD_L: chosen(24, 'a boost the bot does not need to live (a chase, a pile, a whim) only at this length or more'),
  BOOST_REST_MIN_MS: chosen(600, 'shortest rest between the end of one boost and a press it does not need to live'),
  BOOST_REST_MAX_MS: chosen(2200, 'longest such rest (drawn between the two)'),

  // Fleeing a head: another snake at least THREAT_RATIO times longer whose head is within THREAT_RANGE and points at
  // this bot's head. The bot turns away from it and off its line of travel, and boosts when it is close.
  THREAT_AIM_COS: chosen(0.82, 'a head points at the bot when its heading is within about 35 degrees of the line to the bot head'),
  THREAT_AHEAD: chosen(140, 'or of the line to the point this far ahead of the bot head (somebody cutting in front of it)'),
  FLEE_SIDESTEP: chosen(0.6, 'weight of stepping sideways off the threat line of travel, against 1 for straight away'),
  FLEE_BOOST_RANGE: chosen(220, 'a fleeing bot boosts while the threat head is this close'),
  FLEE_BOOST_MIN_MS: chosen(350, 'shortest flee boost'),
  FLEE_BOOST_MAX_MS: chosen(900, 'longest flee boost'),

  // The wall and the battle royale circle: once turned back inward, a bot this far out sprints.
  PANIC_SHARE: chosen(0.97, 'outside this share of the border radius (or outside the battle royale circle at all) a bot turned inward boosts'),
  PANIC_INWARD_COS: chosen(0.7, 'turned inward means heading within about 45 degrees of the middle (boosting earlier only widens the turn)'),
  PANIC_BOOST_MIN_MS: chosen(500, 'shortest wall boost'),
  PANIC_BOOST_MAX_MS: chosen(1000, 'longest wall boost'),

  // Chasing (every personality that HUNTS): cut in front of a clearly smaller snake, aiming where its head will be.
  HUNT_RANGE: chosen(700, 'a hunter looks for prey heads within this distance'),
  HUNT_MIN_L: chosen(20, 'a bot shorter than this does not chase'),
  HUNT_LEAD_MIN: chosen(80, 'the intercept point is at least this far ahead of the prey head'),
  HUNT_LEAD_MAX: chosen(450, 'and at most this far (distance x prey speed / own speed in between)'),
  HUNT_GIVE_UP_MS: chosen(4000, 'a chase ends after this long, caught or not (a coil has its own clock)'),
  HUNT_REST_MS: chosen(6000, 'no new chase for this long after one ends'),
  HUNT_BOOST_RANGE: chosen(600, 'a chasing bot boosts only while its aim point is closer than this'),
  CHASE_BOOST_NEAR: chosen(120, 'and still farther than this (closer, a boost overshoots the cut)'),
  CHASE_BOOST_COS: chosen(0.5, 'and its heading within 60 degrees of the aim point (a pile boost too)'),
  CHASE_DROP_COS: chosen(0, 'a chase boost is let go once the aim point is more than 90 degrees off the heading'),
  CHASE_BOOST_MIN_MS: chosen(400, 'shortest chase boost'),
  CHASE_BOOST_MAX_MS: chosen(1100, 'longest chase boost'),

  // Coiling (personalities that COIL): a hunter close to and ahead of much smaller prey circles its head so its own
  // body closes round it, the way a person traps a small snake.
  COIL_RANGE: chosen(260, 'a coil starts with the prey head this close'),
  COIL_RATIO: chosen(2.5, 'and the prey at least this many times shorter (enough body to go round it)'),
  COIL_R: chosen(170, 'radius of the ring the bot head runs round the prey head, plus the prey body radius (L35)'),
  COIL_ADVANCE: chosen(0.9, 'the coil aims this far round the ring ahead of the bot head'),
  COIL_ESCAPE: chosen(480, 'the coil ends when the prey head gets this far away'),
  COIL_MS: chosen(6000, 'or after this long'),

  // Death piles (personalities that SCAVENGE): a fresh death leaves its length as food along its body.
  PILE_RANGE: chosen(900, 'a pile within this distance is a goal'),
  PILE_FRESH_MS: chosen(7000, 'a pile counts this long after the death (most of it is eaten by then)'),
  PILE_MIN_L: chosen(30, 'only a death at least this long is worth crossing the map for'),
  PILE_HANDOFF: chosen(220, 'this close the food goal takes over (it sees the pellets themselves)'),
  PILE_GUARD: chosen(200, 'a pile with a bigger snake head this close to it, nearer than the bot, is left alone'),
  PILE_BOOST_L: chosen(80, 'a pile from a death at least this long is worth a boost'),
  PILE_BOOST_RANGE: chosen(650, 'boost to a pile only when it is this close'),
  PILE_BOOST_MIN_MS: chosen(400, 'shortest pile boost'),
  PILE_BOOST_MAX_MS: chosen(1000, 'longest pile boost'),
  PILE_SAMPLES: chosen(8, 'points kept per pile, spread along the drops (the bot heads for the nearest)'),
  PILE_MAX: chosen(24, 'piles remembered at once (oldest dropped first)'),

  // Shy (keeps clear of bigger bodies, not only heads).
  SHY_RANGE: chosen(320, 'a shy bot turns away from bigger bodies within this distance (was 450: shy bots starved)'),
  SHY_RATIO: chosen(1.2, 'bigger means at least this many times its length (L)'),

  // New bots and the fill.
  SKIN_PLAIN_SHARE: chosen(0.6, 'share of new bots in a plain colour 0 to 8, the rest any other shipped skin'),
  REFILL_MEAN_MS: chosen(6000, 'a dead bot is replaced after a random wait, exponential with this mean (a room never refills in 125 ms)'),
  REFILL_MAX_MS: chosen(20000, 'and never longer than this'),

  // Personalities: share of the bots, then each one's settings.
  //   THINK_MIN, THINK_MAX  updates between two decisions (drawn each time)
  //   AIM_JITTER            the heading misses by up to this much each think
  //   CLEAR_MARGIN          room kept from another body, on top of its L35 radius a x sc
  //   BOOST_CHANCE          chance per think of a boost for no reason, BOOST_MS long at most (half that at least)
  //   HUNTS, HUNT_RATIO, CHASE_CHANCE   chases snakes HUNT_RATIO times shorter, CHASE_CHANCE per think with one near
  //   COILS                 1: coils round much smaller prey it gets ahead of
  //   FLEES                 1: also turns away from bigger BODIES within SHY_RANGE (shy)
  //   THREAT_RANGE, THREAT_RATIO        flees heads at least THREAT_RATIO times longer, aimed at it, this close
  //   SCAVENGES             1: goes for fresh death piles
  CASUAL_SHARE: chosen(0.55, 'share of bots that are casual'),
  CASUAL_THINK_MIN: chosen(3, 'casual: fewest updates between two decisions'),
  CASUAL_THINK_MAX: chosen(6, 'casual: most updates between two decisions'),
  CASUAL_AIM_JITTER: chosen(0.15, 'casual: aim error'),
  CASUAL_CLEAR_MARGIN: chosen(35, 'casual: room kept from other bodies'),
  CASUAL_BOOST_CHANCE: chosen(0.005, 'casual: chance per think of a short boost (rarely boosts)'),
  CASUAL_BOOST_MS: chosen(600, 'casual: that boost lasts up to this long'),
  CASUAL_HUNTS: chosen(1, 'casual: chases now and then, only snakes far smaller'),
  CASUAL_HUNT_RATIO: chosen(2.5, 'casual: prey must be this many times shorter'),
  CASUAL_CHASE_CHANCE: chosen(0.08, 'casual: chance per think, with such prey in range, that a chase starts'),
  CASUAL_COILS: chosen(0, 'casual: never coils'),
  CASUAL_FLEES: chosen(0, 'casual: no extra care around bigger bodies'),
  CASUAL_THREAT_RANGE: chosen(260, 'casual: flees an aimed bigger head this close'),
  CASUAL_THREAT_RATIO: chosen(1.3, 'casual: bigger means this many times longer'),
  CASUAL_SCAVENGES: chosen(1, 'casual: goes for death piles'),
  HUNTER_SHARE: chosen(0.25, 'share of bots that are hunters (was 0.15: most players never met one)'),
  HUNTER_THINK_MIN: chosen(2, 'hunter: fewest updates between two decisions'),
  HUNTER_THINK_MAX: chosen(4, 'hunter: most updates between two decisions'),
  HUNTER_AIM_JITTER: chosen(0.05, 'hunter: aim error'),
  HUNTER_CLEAR_MARGIN: chosen(25, 'hunter: room kept from other bodies (cuts closer than shy)'),
  HUNTER_BOOST_CHANCE: chosen(0, 'hunter: no boost for no reason'),
  HUNTER_BOOST_MS: chosen(0, 'hunter: (no idle boost)'),
  HUNTER_HUNTS: chosen(1, 'hunter: chases clearly smaller snakes'),
  HUNTER_HUNT_RATIO: chosen(1.5, 'hunter: prey must be this many times shorter'),
  HUNTER_CHASE_CHANCE: chosen(0.5, 'hunter: chance per think, with prey in range, that a chase starts'),
  HUNTER_COILS: chosen(1, 'hunter: coils round much smaller prey'),
  HUNTER_FLEES: chosen(0, 'hunter: no extra care around bigger bodies'),
  HUNTER_THREAT_RANGE: chosen(200, 'hunter: flees an aimed bigger head only this close'),
  HUNTER_THREAT_RATIO: chosen(1.8, 'hunter: bigger means this many times longer'),
  HUNTER_SCAVENGES: chosen(1, 'hunter: goes for death piles'),
  SHY_SHARE: chosen(0.2, 'share of bots that are shy'),
  SHY_THINK_MIN: chosen(3, 'shy: fewest updates between two decisions'),
  SHY_THINK_MAX: chosen(5, 'shy: most updates between two decisions'),
  SHY_AIM_JITTER: chosen(0.1, 'shy: aim error'),
  SHY_CLEAR_MARGIN: chosen(40, 'shy: room kept from other bodies'),
  SHY_BOOST_CHANCE: chosen(0, 'shy: no boost for no reason (it still boosts to get away)'),
  SHY_BOOST_MS: chosen(0, 'shy: (no idle boost)'),
  SHY_HUNTS: chosen(0, 'shy: never chases'),
  SHY_HUNT_RATIO: chosen(0, 'shy: (never chases)'),
  SHY_CHASE_CHANCE: chosen(0, 'shy: (never chases)'),
  SHY_COILS: chosen(0, 'shy: never coils'),
  SHY_FLEES: chosen(1, 'shy: turns away from bigger bodies within SHY_RANGE'),
  SHY_THREAT_RANGE: chosen(380, 'shy: flees an aimed bigger head from farther off'),
  SHY_THREAT_RATIO: chosen(1.1, 'shy: bigger means only this many times longer'),
  SHY_SCAVENGES: chosen(1, 'shy: goes for death piles nobody bigger is guarding'),
});
// END BOT_TUNING

const T = {};
for (const k of Object.keys(BOT_TUNING)) T[k] = BOT_TUNING[k].value;

const PROFILE_KEYS = Object.freeze(['SHARE', 'THINK_MIN', 'THINK_MAX', 'AIM_JITTER', 'CLEAR_MARGIN', 'BOOST_CHANCE',
  'BOOST_MS', 'HUNTS', 'HUNT_RATIO', 'CHASE_CHANCE', 'COILS', 'FLEES', 'THREAT_RANGE', 'THREAT_RATIO', 'SCAVENGES']);

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

// piles: optional () -> the recent death piles, [{at (sim ms of the death), size (its L), pts [x, y, ...]}], as the
// driver keeps them from each step's deaths; absent, no piles (a brain then never scavenges).
const NO_PILES = Object.freeze([]);
function createBotSense(sim, piles) {
  if (!sim || !sim.grid || typeof sim.snake !== 'function') throw new TypeError('slBots: createBotSense needs a sim');
  const grd = sim.laws.L1.value;
  const grid = sim.grid;
  return Object.freeze({
    piles: typeof piles === 'function' ? piles : () => NO_PILES,
    grd,
    flux: () => sim.flux(),
    // the battle royale's circle { x, y, r } or null (slSim opts.zone); a free room has none
    zone: () => (typeof sim.zoneNow === 'function' ? sim.zoneNow() : null),
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
  let coilDir = 0; // 0: not coiling; else the way round the prey head (1 counterclockwise, -1 clockwise)
  let coilSince = 0;
  let restUntil = -Infinity;
  let wanderX = 0;
  let wanderY = 0;
  let wanderUntil = -Infinity;
  let foodId = null;
  let foodSince = 0;
  let skipFoodId = null;
  const stats = { thinks: 0, border: 0, flee: 0, hunt: 0, coil: 0, pile: 0, food: 0, wander: 0, chases: 0, coils: 0,
    boosts: 0, fleeBoosts: 0, panicBoosts: 0, chaseBoosts: 0, pileBoosts: 0, angles: 0, boostRecs: 0 };

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
  let threat = null;
  let threatD2 = 0;
  let guardX = 0;
  let guardY = 0;
  let guardD2 = 0;
  let guarded = false;

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

  // The nearest head of a clearly bigger snake (THREAT_RATIO) inside THREAT_RANGE whose heading points at this head,
  // or at the spot THREAT_AHEAD in front of it: somebody coming to cut it off. The prey of a chase is never one (it
  // is the smaller snake by the hunt rule).
  function visitThreat(o) {
    if (o === me || !o.alive || o.id === chaseId) return;
    const dx = mx - o.hx;
    const dy = my - o.hy;
    const d2 = dx * dx + dy * dy;
    if (d2 >= threatD2 || !(d2 > 0) || lengthOf(o) < prof.THREAT_RATIO * myL) return;
    const ux = Math.cos(o.ang);
    const uy = Math.sin(o.ang);
    const d = Math.sqrt(d2);
    if ((ux * dx + uy * dy) / d < T.THREAT_AIM_COS) {
      const ax = dx + Math.cos(curAng) * T.THREAT_AHEAD;
      const ay = dy + Math.sin(curAng) * T.THREAT_AHEAD;
      const a = Math.sqrt(ax * ax + ay * ay);
      if (!(a > 0) || (ux * ax + uy * ay) / a < T.THREAT_AIM_COS) return;
    }
    threatD2 = d2;
    threat = o;
  }

  // Away from the threat head, and sideways off its line of travel to whichever side the bot is already on, so a
  // threat that keeps coming overshoots instead of running the bot down from behind.
  function fleeFrom(o) {
    const dx = mx - o.hx;
    const dy = my - o.hy;
    const d = Math.sqrt(dx * dx + dy * dy);
    const ux = Math.cos(o.ang);
    const uy = Math.sin(o.ang);
    const side = ux * dy - uy * dx >= 0 ? 1 : -1;
    return Math.atan2(dy / d + side * ux * T.FLEE_SIDESTEP, dx / d - side * uy * T.FLEE_SIDESTEP);
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

  // A press of boost held for a drawn length between minMs and maxMs. Refused at or below BOOST_MIN_L (and the L22
  // floor); a boost the bot does not need to live (urgent false) is also refused below BOOST_AFFORD_L and inside the
  // drawn rest after the last one. An urgent press while already boosting keeps it held for the new length. True only
  // when a new press starts.
  function startBoost(tickMs, minMs, maxMs, urgent) {
    if (myL <= T.BOOST_MIN_L || myL <= K.minL) return false;
    if (wantBoost) {
      if (urgent) {
        const until = tickMs + minMs + rng.next() * (maxMs - minMs);
        if (until > boostUntil) boostUntil = until;
      }
      return false;
    }
    if (!urgent && (myL < T.BOOST_AFFORD_L || tickMs < boostRestUntil)) return false;
    wantBoost = true;
    boostUntil = tickMs + minMs + rng.next() * (maxMs - minMs);
    stats.boosts++;
    return true;
  }

  function stopBoost(tickMs) {
    if (!wantBoost) return;
    wantBoost = false;
    boostRestUntil = tickMs + T.BOOST_REST_MIN_MS + rng.next() * (T.BOOST_REST_MAX_MS - T.BOOST_REST_MIN_MS);
  }

  function endChase(tickMs) {
    chaseId = 0;
    coilDir = 0;
    restUntil = tickMs + T.HUNT_REST_MS;
    stopBoost(tickMs);
  }

  // A snake holding Q to cash out (slHold: steering locked, crawling at a fifth of its speed, holdMult set) is never
  // prey: it cannot get away, so a chase would turn every free-room cash-out into a kill nobody could escape.
  function holding(o) {
    return o.holdMult !== null && o.holdMult !== undefined;
  }

  function visitHead(o) {
    if (o === me || !o.alive || holding(o)) return;
    const dx = o.hx - mx;
    const dy = o.hy - my;
    const d2 = dx * dx + dy * dy;
    if (d2 >= preyD2) return;
    if (myL < prof.HUNT_RATIO * lengthOf(o)) return;
    preyD2 = d2;
    prey = o;
  }

  // Aim where the prey head will be when this head gets there: along the prey heading by distance x prey speed /
  // own speed, held to [HUNT_LEAD_MIN, HUNT_LEAD_MAX]. Boost while lined up on that point and still short of it; let
  // go once the prey has turned so far that the point is behind.
  function cutAt(o, tickMs) {
    const hx = o.hx - mx;
    const hy = o.hy - my;
    const d = Math.sqrt(hx * hx + hy * hy);
    let lead = me.sp > 0 ? (d * o.sp) / me.sp : T.HUNT_LEAD_MAX;
    if (!(lead >= T.HUNT_LEAD_MIN)) lead = T.HUNT_LEAD_MIN;
    else if (lead > T.HUNT_LEAD_MAX) lead = T.HUNT_LEAD_MAX;
    const tx = hx + Math.cos(o.ang) * lead;
    const ty = hy + Math.sin(o.ang) * lead;
    const aim = Math.atan2(ty, tx);
    const lined = Math.cos(aim - curAng);
    const far2 = tx * tx + ty * ty;
    if (wantBoost && lined < T.CHASE_DROP_COS) {
      stopBoost(tickMs);
    } else if (lined > T.CHASE_BOOST_COS && far2 > T.CHASE_BOOST_NEAR * T.CHASE_BOOST_NEAR &&
        far2 < T.HUNT_BOOST_RANGE * T.HUNT_BOOST_RANGE &&
        startBoost(tickMs, T.CHASE_BOOST_MIN_MS, T.CHASE_BOOST_MAX_MS, false)) {
      stats.chaseBoosts++;
    }
    return aim;
  }

  // Run round the prey head on a ring COIL_R (plus its body radius) out, aiming COIL_ADVANCE ahead round it, always
  // the same way: the way that first crosses in front of the prey. The bot's own body is never a hazard (L37), so the
  // ring closes on the prey and only the prey's body is steered round.
  function coilAt(o, tickMs) {
    const dx = mx - o.hx;
    const dy = my - o.hy;
    if (coilDir === 0) {
      coilDir = Math.cos(o.ang) * dy - Math.sin(o.ang) * dx >= 0 ? -1 : 1;
      coilSince = tickMs;
      stats.coils++;
      stopBoost(tickMs); // a boosting snake turns a wider circle
    }
    const phi = Math.atan2(dy, dx) + coilDir * T.COIL_ADVANCE;
    const r = T.COIL_R + K.a * o.sc;
    return Math.atan2(o.hy + Math.sin(phi) * r - my, o.hx + Math.cos(phi) * r - mx);
  }

  function huntGoal(tickMs) {
    if (chaseId !== 0) {
      const o = sense.snake(chaseId);
      const late = coilDir !== 0 ? tickMs - coilSince >= T.COIL_MS : tickMs - chaseSince >= T.HUNT_GIVE_UP_MS;
      let over = !o || !o.alive || late || holding(o) || myL < prof.HUNT_RATIO * lengthOf(o);
      let dx = 0;
      let dy = 0;
      if (!over) {
        dx = mx - o.hx;
        dy = my - o.hy;
        over = dx * dx + dy * dy > T.HUNT_RANGE * T.HUNT_RANGE;
      }
      if (!over && prof.COILS && myL >= T.COIL_RATIO * lengthOf(o)) {
        const d2 = dx * dx + dy * dy;
        const ahead = Math.cos(o.ang) * dx + Math.sin(o.ang) * dy > 0;
        if (coilDir !== 0 ? d2 < T.COIL_ESCAPE * T.COIL_ESCAPE : d2 < T.COIL_RANGE * T.COIL_RANGE && ahead) {
          return coilAt(o, tickMs);
        }
      }
      if (over || coilDir !== 0) { // a coil that ends ends the chase: the prey got out
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
    if (found === null || rng.next() >= prof.CHASE_CHANCE) return null;
    chaseId = found.id;
    chaseSince = tickMs;
    stats.chases++;
    return cutAt(found, tickMs);
  }

  function visitGuard(o) {
    if (guarded || o === me || !o.alive) return;
    const dx = o.hx - guardX;
    const dy = o.hy - guardY;
    const d2 = dx * dx + dy * dy;
    if (d2 < T.PILE_GUARD * T.PILE_GUARD && d2 < guardD2 && lengthOf(o) >= prof.THREAT_RATIO * myL) guarded = true;
  }

  // The nearest point of a fresh death pile (PILE_FRESH_MS, at least PILE_MIN_L long) inside PILE_RANGE and inside the
  // wall, unless a bigger head is nearer to it; boost there when it is big and close. Within PILE_HANDOFF the food
  // goal takes over, since it sees the pellets that are actually left.
  function pileGoal(tickMs) {
    if (!prof.SCAVENGES || typeof sense.piles !== 'function') return null;
    const list = sense.piles();
    if (!list || list.length === 0) return null;
    let bestD2 = T.PILE_RANGE * T.PILE_RANGE;
    let bx = 0;
    let by = 0;
    let size = 0;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (tickMs - p.at > T.PILE_FRESH_MS || p.size < T.PILE_MIN_L) continue;
      const pts = p.pts;
      for (let k = 0; k + 1 < pts.length; k += 2) {
        const ex = pts[k] - borderCx;
        const ey = pts[k + 1] - borderCy;
        if (ex * ex + ey * ey > borderR2) continue;
        const dx = pts[k] - mx;
        const dy = pts[k + 1] - my;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) {
          bestD2 = d2;
          bx = pts[k];
          by = pts[k + 1];
          size = p.size;
        }
      }
    }
    if (size === 0 || bestD2 < T.PILE_HANDOFF * T.PILE_HANDOFF) return null;
    guardX = bx;
    guardY = by;
    guardD2 = bestD2;
    guarded = false;
    sense.forEachSnake(visitGuard);
    if (guarded) return null;
    const aim = Math.atan2(by - my, bx - mx);
    if (size >= T.PILE_BOOST_L && bestD2 < T.PILE_BOOST_RANGE * T.PILE_BOOST_RANGE &&
        Math.cos(aim - curAng) > T.CHASE_BOOST_COS && startBoost(tickMs, T.PILE_BOOST_MIN_MS, T.PILE_BOOST_MAX_MS, false)) {
      stats.pileBoosts++;
    }
    return aim;
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

  // The goal ladder: the wall, a threat head, bigger bodies (shy), a chase or coil, a death pile, food, a wander point.
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
    threat = null;
    threatD2 = prof.THREAT_RANGE * prof.THREAT_RANGE;
    // the battle royale's circle when there is one, else the map's border round (grd, grd)
    const z = sense.zone ? sense.zone() : null;
    const R = z ? z.r : sense.flux();
    if (!okNum(R) || R <= 0) throw new Error('slBots: the bots need the border (sense.flux() > 0)');
    const cx = z ? z.x : sense.grd;
    const cy = z ? z.y : sense.grd;
    borderCx = cx;
    borderCy = cy;
    borderR2 = (R - T.BORDER_MARGIN) * (R - T.BORDER_MARGIN);
    sense.forEachPointNear(mx, my, prof.FLEES && T.SHY_RANGE > look ? T.SHY_RANGE : look, visitPoint);
    // the prey's own path ahead is where a cut goes, so it is no hazard for its hunter (its body still is)
    for (const o of near.values()) if (o && o.id !== chaseId) markHead(o);
    near.clear();
    // threat heads from the head list, not the body points: one distance test per snake costs less than reading
    // every body point out to THREAT_RANGE
    sense.forEachSnake(visitThreat);
    markBorder(cx, cy, R);
    stats.thinks++;

    const ox = mx - cx;
    const oy = my - cy;
    const out2 = ox * ox + oy * oy;
    let goal = null;
    if (out2 > T.BORDER_CAUTION * T.BORDER_CAUTION * R * R) {
      mode = 'border';
      goal = Math.atan2(-oy, -ox);
      const panic = z ? out2 > R * R : out2 > T.PANIC_SHARE * T.PANIC_SHARE * R * R;
      if (panic && Math.cos(goal - curAng) > T.PANIC_INWARD_COS &&
          startBoost(tickMs, T.PANIC_BOOST_MIN_MS, T.PANIC_BOOST_MAX_MS, true)) {
        stats.panicBoosts++;
      }
    } else if (threat !== null) {
      mode = 'flee';
      goal = fleeFrom(threat);
      if (threatD2 < T.FLEE_BOOST_RANGE * T.FLEE_BOOST_RANGE &&
          startBoost(tickMs, T.FLEE_BOOST_MIN_MS, T.FLEE_BOOST_MAX_MS, true)) {
        stats.fleeBoosts++;
      }
    } else if (prof.FLEES && (fleeX !== 0 || fleeY !== 0)) {
      mode = 'flee';
      goal = Math.atan2(fleeY, fleeX);
    } else if (prof.HUNTS && (goal = huntGoal(tickMs)) !== null) {
      mode = coilDir !== 0 ? 'coil' : 'hunt';
    } else if ((goal = pileGoal(tickMs)) !== null) {
      mode = 'pile';
    } else if ((goal = foodGoal(tickMs)) !== null) {
      mode = 'food';
    } else {
      mode = 'wander';
      goal = wanderGoal(tickMs, cx, cy, R);
    }
    threat = null;
    stats[mode]++;
    if (mode !== 'hunt' && mode !== 'coil' && chaseId !== 0) endChase(tickMs);
    // a boost for no reason only while nothing is going on (never at the wall, where it only widens the turn)
    if (prof.BOOST_CHANCE > 0 && !wantBoost && (mode === 'food' || mode === 'wander') && rng.next() < prof.BOOST_CHANCE) {
      startBoost(tickMs, prof.BOOST_MS / 2, prof.BOOST_MS, false);
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

/// The skins a bot may wear: every shipped skin cv 0 to SKIN_MAX, the picture skins only while the PICTURE_SKINS
// switch is on (Owen: one off switch, default off until he has reviewed each image). How often each is worn is
// skinOf below.
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

// One skin from one uniform draw u: SKIN_PLAIN_SHARE of bots in a plain colour (cv under PLAIN_SKINS, what most
// people play in because it is what they get without opening Customize), the rest spread over every other allowed
// skin. skins is botSkins' list, ascending, so its plain colours come first. Uniform over the whole list was 5 in 6
// striped, which no real room looks like.
function skinOf(skins, u) {
  let plain = 0;
  while (plain < skins.length && skins[plain] < PLAIN_SKINS) plain++;
  const other = skins.length - plain;
  let i;
  if (other === 0) i = Math.floor(u * plain);
  else if (plain === 0) i = Math.floor(u * other);
  else if (u < T.SKIN_PLAIN_SHARE) i = Math.floor((u / T.SKIN_PLAIN_SHARE) * plain);
  else i = plain + Math.floor(((u - T.SKIN_PLAIN_SHARE) / (1 - T.SKIN_PLAIN_SHARE)) * other);
  return skins[i < skins.length ? i : skins.length - 1];
}

function bumpName(map, k) {
  map.set(k, (map.get(k) || 0) + 1);
}

function dropName(map, k) {
  const n = map.get(k);
  if (n === undefined) return;
  if (n <= 1) map.delete(k);
  else map.set(k, n - 1);
}

// The room's names. One draw per take. take(rng, avoid): avoid is an optional Set of lower case names the room's
// seated people wear, which no bot is given. Without a list (the room's book) a name comes from the shared generator
// (server/botNames.js pickName, NICK_MAX characters at most) and is never the same as a live bot's, case aside. With
// a list (tools and tests), names in use are not handed out again while a free one exists (the old engine's rule,
// server/Bot.js:41-47).
function createNameBook(names) {
  const used = new Map(); // name -> live bots wearing it
  const lower = new Map(); // the same, lower case
  if (names === undefined) {
    let avoiding = null;
    const taken = (lc) => lower.has(lc) || (avoiding !== null && avoiding.has(lc));
    return {
      take(rng, avoid) {
        avoiding = avoid instanceof Set && avoid.size > 0 ? avoid : null;
        const name = pickName(rng.next(), { maxLen: NICK_MAX, taken });
        avoiding = null;
        bumpName(used, name);
        bumpName(lower, name.toLowerCase());
        return name;
      },
      release(name) {
        if (!used.has(name)) return;
        dropName(used, name);
        dropName(lower, name.toLowerCase());
      },
      inUse: () => used.size,
    };
  }
  const list = names;
  if (!Array.isArray(list) || list.length === 0) throw new Error('slBots: name book needs names');
  const free = [];
  return {
    take(rng, avoid) {
      free.length = 0;
      const skip = avoid instanceof Set ? avoid : null;
      for (const n of list) if (!used.has(n) && (skip === null || !skip.has(n.toLowerCase()))) free.push(n);
      const name = free.length > 0 ? free[rng.int(free.length)] : list[rng.int(list.length)];
      bumpName(used, name);
      return name;
    },
    release(name) {
      dropName(used, name);
    },
    inUse: () => used.size,
  };
}

// One new bot from the room's 'bot' stream: brain seed, personality, skin, name, in that order (four draws). avoid:
// the lower case names of the people seated in the room (createNameBook take).
function drawBotSpec(rng, laws, names, avoid) {
  const skins = botSkins(laws);
  const seed = Math.floor(rng.next() * UINT32_SPAN);
  const personality = drawPersonality(rng);
  const cv = skinOf(skins, rng.next());
  const nick = names.take(rng, avoid);
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

// Event-loop delay p99 over C_GOV.windowMs ABOVE THIS PROCESS'S OWN IDLE FLOOR, from a monitorEventLoopDelay histogram
// at LOOP_RESOLUTION_MS (slBoot builds it, SlArenas.startTimers enables it) and the loop's busy share over the same
// span (elu: perf_hooks performance.eventLoopUtilization by default; any () -> {idle, active} cumulative ms; one it
// cannot read counts as busy). A span is CALM when the loop was busy under LOOP_CALM_BUSY of it. read(nowMs), once a
// second:
//   first  the first read starts the histogram afresh (the server's require-time boot stalls are not load) and the
//          busy span with it, and answers 0;
//   raw    the larger of the last whole window's p99 and the current window's so far, in ms, so a stall shows at the
//          next read and counts for one whole window after it;
//   floor  the p99 of this process at its quietest, like for like with raw: the lowest p99 of a whole calm window.
//          Until the first whole calm window it is the lowest p99 of a calm read (the current window so far), and
//          before any calm read it is LOOP_RESOLUTION_MS, which can only over-read (bots yield sooner), never
//          under-read; until then every read that is not calm also starts the window afresh, so the stretch the first
//          floor comes from never holds the boot's stalls. The first whole calm window replaces that early floor;
//          after it the floor only ever falls, so an overload cannot lift it. It is never above LOOP_FLOOR_MAX_MS (a
//          calm share alone does not tell a timer tick from a loop blocked under half the time). On Windows it sits
//          just over the 15.6 ms system tick the timer fires on (a bare process 16.5 ms; the local server, machine
//          loaded, 17.1 to 25.9 ms, so 20 there),
//          on Linux it is the 1 ms resolution plus the quietest background work of the process (the old engine's
//          rooms tick on the same thread);
//   read   max(0, raw - floor), and 0 until the histogram holds a sample (an empty one answers 511 ns for every
//          percentile, Node 24, so its count decides when it has one).
// So C_GOV.loopP99Ms 15 means "the loop ran 15 ms later than this process at its quietest" on both systems (an idle
// Windows process reads raw p99 about 16.5 ms, which against the bare 15 ms bar kept every bot out). Windows' coarse
// timer hides a stall shorter than its 15.6 ms tick, so there the bar is a raw p99 of about 31 ms (16.5 + 15); Linux
// reads the lateness itself (above the process's quietest background work). stats() gives the numbers for the log and
// the console (raw, floor, busy share).
function createLoopProbe(monitor, laws, elu) {
  assertLawsComplete(laws, GOV_LAW_IDS);
  if (!monitor || typeof monitor.percentile !== 'function' || typeof monitor.reset !== 'function') {
    throw new TypeError('slBots: createLoopProbe needs a monitorEventLoopDelay histogram');
  }
  const busyNow = elu === undefined ? defaultElu() : elu;
  if (typeof busyNow !== 'function') throw new TypeError('slBots: createLoopProbe elu must be a function');
  const windowMs = posNum(laws.C_GOV.value.windowMs, 'C_GOV windowMs');
  let start = null;
  let span = null;
  let lastP99 = 0;
  let floor = Infinity;
  let settled = false;
  let raw = 0;
  let excess = 0;
  let busy = NaN;
  let windows = 0;
  let calmReads = 0;
  function p99() {
    if (typeof monitor.count === 'number' && !(monitor.count > 0)) return 0;
    const v = monitor.percentile(LOOP_PERCENTILE) / NS_PER_MS;
    return okNum(v) && v > 0 ? v : 0;
  }
  function snap() {
    const e = busyNow();
    return e && okNum(e.idle) && okNum(e.active) ? { idle: e.idle, active: e.active } : null;
  }
  // The loop's busy share since the window started, NaN when it cannot be read.
  function busyShare() {
    const e = snap();
    if (!e || !span) return NaN;
    const active = e.active - span.active;
    const total = active + (e.idle - span.idle);
    return total > 0 && active >= 0 ? active / total : NaN;
  }
  // The window so far: its p99 when it was calm, else 0.
  function calmP99() {
    const v = p99();
    if (!(v > 0)) return 0;
    busy = busyShare();
    if (!(busy < LOOP_CALM_BUSY)) return 0;
    calmReads++;
    return v;
  }
  function startWindow(nowMs) {
    monitor.reset();
    start = nowMs;
    span = snap();
  }
  const floorNow = () => (floor === Infinity ? LOOP_RESOLUTION_MS : floor);
  return {
    read(nowMs) {
      if (!okNum(nowMs)) throw new TypeError('slBots: nowMs must be a finite number');
      if (start === null) {
        startWindow(nowMs);
        return 0;
      }
      if (nowMs - start >= windowMs) {
        const v = calmP99();
        if (v > 0) {
          const w = v < LOOP_FLOOR_MAX_MS ? v : LOOP_FLOOR_MAX_MS;
          floor = settled && floor < w ? floor : w;
          settled = true;
        }
        lastP99 = p99();
        startWindow(nowMs);
        windows++;
      }
      let calm = false;
      if (!settled) {
        const v = calmP99();
        calm = v > 0;
        if (calm && v < floor) floor = v < LOOP_FLOOR_MAX_MS ? v : LOOP_FLOOR_MAX_MS;
      }
      const cur = p99();
      raw = cur > lastP99 ? cur : lastP99;
      excess = raw > floorNow() ? raw - floorNow() : 0;
      if (!calm && floor === Infinity) startWindow(nowMs);
      return excess;
    },
    stats: () => ({ rawP99Ms: raw, floorMs: floorNow(), settled, loopP99Ms: excess, busy, windows, calmReads }),
  };
}

// perf_hooks' event-loop utilization: cumulative idle and active ms since the process started.
function defaultElu() {
  const { performance } = require('perf_hooks');
  return () => performance.eventLoopUtilization();
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
//   room.humans, room.names          the human snake ids and every snake's name: a new bot never takes a name a
//                                    person in the room wears
//   room._botsPausedUntil            wall ms; the owner console's bots:clear window (server/index.js:1241): no
//                                    automatic adds until then
// opts: { governor (createBotGovernor; its mult lowers the target, and while engaged nothing is added), now (wall ms
// function, when the room has none), onRecord(id, rec, offsetMs, tickMs) (tools and tests watch the records),
// holdFill(room) (the battle royale only: true while a match runs, so the fill neither adds nor retires) }.
// Bots added by hand through add(room) return their record; the console marks it manual (server/index.js:1258) and
// the automatic fill then neither counts nor retires it.
//
// The owner console's controls (Control contract 2026-10-16; callers check typeof === 'function' first):
//   setTarget(room, n)   hold exactly n live bots (0 to TARGET_MAX): the fill adds and retires toward n at its normal
//                        pace, people no longer displace bots, hand-added bots count toward n like the rest, and a
//                        dead bot is replaced at once (an exact count is what was asked for). The room cap still holds
//                        bots and people together and the load governor still lowers it under load. n null: back to
//                        the daily curve. A held count wins over an older Clear pause.
//   target(room)         the held n, or null on the curve.
//   removeBots(room, n)  retire n bots now (unseen first, shortest first), the same way clear takes them out. Call it
//                        from a timer or a request, never inside a step. Returns how many went.
//   clear(room)          every bot out now; also drops a held count, so the console's Clear pause then holds the room
//                        empty.
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
  const holdFill = typeof o.holdFill === 'function' ? o.holdFill : null;
  const fill = createBotFill(laws);
  const names = createNameBook();
  const recs = new Map(); // snake id -> {id, nick, personality, cv, manual, brain}
  const per = {}; // personality -> {spawned, died, retired, and the brain stats of every bot that has left}
  for (const p of PERSONALITIES) per[p] = { spawned: 0, died: 0, retired: 0 };
  const out = [];
  const auto = [];
  const heads = [];
  const avoid = new Set(); // lower case names of the people in the room, per spawn
  const piles = []; // recent deaths with drops, oldest first: {at, size, pts: [x, y, ...]}
  const waiting = []; // sim ms at which each dead bot's place may be filled again
  const targets = new WeakMap(); // room -> held live bot count (setTarget)
  const refills = { delays: 0, totalMs: 0, maxMs: 0 };
  let sense = null;
  let senseSim = null;
  let room = null; // the room of the current call
  const pilesNow = () => piles;

  function senseOf(r) {
    if (senseSim !== r.sim) {
      sense = createBotSense(r.sim, pilesNow);
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

  // The names the people in the room wear, lower case (a bot never gets one of them).
  function loadAvoid(r) {
    avoid.clear();
    if (!r.humans || typeof r.humans[Symbol.iterator] !== 'function' || !r.names || typeof r.names.get !== 'function') return;
    for (const id of r.humans) {
      const n = r.names.get(id);
      if (typeof n === 'string' && n.length > 0) avoid.add(n.trim().toLowerCase());
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

  // A death worth scavenging: up to PILE_SAMPLES of its drop points, spread along them, for the brains (sense.piles).
  function notePile(d, simMs) {
    const drops = d.drops;
    if (!Array.isArray(drops) || drops.length === 0) return;
    const size = d.sct + d.fam;
    if (!(size >= T.PILE_MIN_L)) return;
    const every = drops.length > T.PILE_SAMPLES ? Math.floor(drops.length / T.PILE_SAMPLES) : 1;
    const pts = [];
    for (let i = 0; i < drops.length && pts.length < T.PILE_SAMPLES * 2; i += every) pts.push(drops[i].x, drops[i].y);
    piles.push({ at: simMs, size, pts });
    if (piles.length > T.PILE_MAX) piles.shift();
  }

  // How long a dead bot's place waits before the fill may fill it: exponential with mean REFILL_MEAN_MS, held to
  // REFILL_MAX_MS, one draw from the room's 'bot' stream. People leave and arrive at random; a room that put a bot
  // back within 125 ms of every death showed its population for what it is.
  function refillDelay(r) {
    const u = r.sim.rng.bot.next();
    const ms = -Math.log(1 - u) * T.REFILL_MEAN_MS;
    const wait = ms < T.REFILL_MAX_MS ? ms : T.REFILL_MAX_MS;
    refills.delays++;
    refills.totalMs += wait;
    if (wait > refills.maxMs) refills.maxMs = wait;
    return wait;
  }

  // One new bot: spec from the 'bot' stream, then a ring spawn drawn again (at most SPAWN_VIEW_TRIES) while it lands
  // in a human's window; a draw taken back was never sent to anyone.
  function spawnOne(r, manual) {
    loadAvoid(r);
    const spec = drawBotSpec(r.sim.rng.bot, laws, names, avoid);
    avoid.clear();
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
    // the battle royale's match (opts.holdFill() true): the bots in the arena stay as they are, none added or retired
    const hold = holdFill !== null && holdFill(r) === true;
    const held = targets.get(r);
    for (let i = 0; i < log.deaths.length; i++) {
      const d = log.deaths[i];
      notePile(d, simMs);
      const rec = recs.get(d.id);
      if (rec && !rec.manual && !hold && held === undefined) waiting.push(simMs + refillDelay(r));
      forget(d.id, 'died');
    }
    for (const id of Array.from(recs.keys())) if (!r.sim.snake(id)) forget(id, 'gone'); // taken out by someone else
    while (piles.length > 0 && simMs - piles[0].at > T.PILE_FRESH_MS) piles.shift();
    let k = 0;
    for (let i = 0; i < waiting.length; i++) if (waiting[i] > simMs) waiting[k++] = waiting[i];
    waiting.length = k;
    if (hold) return;
    room = r;
    auto.length = 0;
    let manual = 0;
    for (const rec of recs.values()) {
      if (rec.manual && held === undefined) manual++;
      else auto.push(r.sim.snake(rec.id));
    }
    const humans = Number.isInteger(r.playerCount) && r.playerCount > 0 ? r.playerCount : 0;
    let plan;
    if (held !== undefined) {
      // an exact count: people do not displace it, but bots and people together stay inside the room cap
      waiting.length = 0;
      plan = { target: held, humans: 0, cap: cap === null ? null : (cap > humans ? cap - humans : 0) };
    } else {
      const wall = wallNow(r);
      const paused = okNum(r._botsPausedUntil) && wall < r._botsPausedUntil;
      plan = { target: paused ? 0 : curveTarget(wall), humans, cap: cap === null ? null : (cap > manual ? cap - manual : 0) };
    }
    const mult = governor ? governor.mult() : 1;
    // A waiting place the fill no longer wants (people arrived, the curve fell) is given up at once, before any live
    // bot is retired: nobody can see it, so it needs neither the pacer nor an unseen retiree.
    if (waiting.length > 0) {
      const want = planBotFill({ target: Math.floor(plan.target * mult), humans: plan.humans, bots: 0, cap: plan.cap }, laws).want;
      const spare = auto.length + waiting.length - want;
      if (spare > 0) waiting.length = spare < waiting.length ? waiting.length - spare : 0;
    }
    const act = fill.step(simMs, {
      target: plan.target,
      humans: plan.humans,
      bots: auto.length + waiting.length,
      cap: plan.cap,
      mult,
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

  // The owner console's bots:clear: every bot out now (the console then pauses the fill for its window), and any
  // held count dropped, so that pause holds the room empty.
  function clear(r) {
    let n = 0;
    for (const id of Array.from(recs.keys())) {
      if (r.sim.snake(id)) takeOut(r, id);
      forget(id, 'cleared');
      n++;
    }
    waiting.length = 0;
    if (r && typeof r === 'object') targets.delete(r);
    return n;
  }

  function setTarget(r, n) {
    if (!r || typeof r !== 'object') throw new TypeError('slBots: setTarget needs the room');
    if (n === null || n === undefined) {
      targets.delete(r);
      return null;
    }
    if (!Number.isInteger(n) || n < 0 || n > TARGET_MAX) {
      throw new RangeError('slBots: setTarget takes a whole number of bots from 0 to ' + TARGET_MAX + ', or null');
    }
    targets.set(r, n);
    waiting.length = 0;
    return n;
  }

  function target(r) {
    const n = r && typeof r === 'object' ? targets.get(r) : undefined;
    return n === undefined ? null : n;
  }

  // n bots out now: the unseen ones first, shortest first (pickRetiree), then seen ones the same way.
  function removeBots(r, n) {
    if (!r || typeof r !== 'object' || !r.sim) throw new TypeError('slBots: removeBots needs the room');
    if (!Number.isInteger(n) || n < 0) throw new RangeError('slBots: removeBots takes a whole number of bots');
    const live = [];
    for (const rec of recs.values()) {
      const s = r.sim.snake(rec.id);
      if (s) live.push(s);
    }
    room = r;
    let gone = 0;
    try {
      while (gone < n && live.length > 0) {
        let s = pickRetiree(live, isSeen, false);
        if (s === null) s = pickRetiree(live, isSeen, true);
        live.splice(live.indexOf(s), 1);
        takeOut(r, s.id);
        forget(s.id, 'retired');
        gone++;
      }
    } finally {
      room = null;
    }
    return gone;
  }

  return {
    beforeInputs,
    afterStep,
    add,
    clear,
    setTarget,
    target,
    removeBots,
    count: () => recs.size,
    waiting: () => waiting.length,
    isBot: (id) => recs.has(id),
    personalityOf: (id) => (recs.has(id) ? recs.get(id).personality : null),
    // per personality: live, spawned, died, retired, and the summed brain stats (thinks, modes, chases, boosts,
    // records) of every bot that has lived in this room; waiting places, remembered piles and the refill delays
    stats: () => {
      const kinds = {};
      for (const p of PERSONALITIES) kinds[p] = Object.assign({ live: 0 }, per[p]);
      for (const rec of recs.values()) {
        kinds[rec.personality].live++;
        addInto(kinds[rec.personality], rec.brain.stats());
      }
      return Object.assign({ bots: recs.size, names: names.inUse(), kinds, waiting: waiting.length, piles: piles.length,
        refillDelays: refills.delays, refillMeanMs: refills.delays > 0 ? refills.totalMs / refills.delays : 0,
        refillMaxMs: refills.maxMs },
      fill.stats());
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
  PLAIN_SKINS,
  NICK_MAX,
  TARGET_MAX,
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
  skinOf,
  createNameBook,
  drawBotSpec,
  spawnBot,
  curveTarget,
  planBotFill,
  pickRetiree,
  createBotFill,
  createBotGovernor,
  createLoopProbe,
  LOOP_RESOLUTION_MS,
  LOOP_CALM_BUSY,
  LOOP_FLOOR_MAX_MS,
  DRIVER_LAW_IDS,
  createBotDriver,
};
