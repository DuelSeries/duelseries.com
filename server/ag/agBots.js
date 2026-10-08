'use strict';
// Bots for the free agar.io rooms (CHOSEN design, Owen's answers Q17 and Q18; parity log C6; build brief 9.1, 9.2).
//
// Owen asked for DECENT bots (Q17, Q18): they eat food, flee anything that can eat them, split to catch a smaller
// cell, and never team (they never eject, never feed anyone, never favour another bot, and never chase an ejected
// blob unless it came from the player they are already hunting). After playing the first build (2026-10-07) he
// found them far too aggressive and asked for bots that are much easier to play against and to kill, that split
// more often, and a MIX: some aggressive, most normal, some that keep off to the side. So every bot now gets a
// PERSONALITY when it is made, drawn from its own seeded random numbers:
//   hunter  (HUNTER_SHARE) chases only clearly smaller cells, splits on them, gives up a chase quickly
//   casual  (CASUAL_SHARE) mostly eats food, rarely chases, often splits for no good reason (easy prey)
//   shy     (SHY_SHARE)    never chases, keeps well away from anything bigger and farms food near the map's edge
// Every bot reacts slowly (it re-decides only every few ticks and keeps its last target in between) and aims
// imperfectly (its target is jittered by a share of the distance). Every bot steers off other cells it can neither
// eat nor be eaten by (fleeing too), and leaves a pellet or prey to any other cell that will reach it first, so two
// bots side by side never lock onto the same goal and a crowd of bots does not pile up on one spot.
// agar.io's own servers run no such bots in FFA, so none of this is their behaviour: it is ours, every tuning number
// sits in BOT_TUNING below, labelled CHOSEN.
//
// THE ONE RULE: bots exist only in rooms where botsAllowed() is true (free rooms; never a paid room). The room asks
// planBotFill() how many to add or remove, and planBotFill() removes every bot when botsAllowed is false.
//
// Game rules the brain must respect (who can eat whom, how far a split flies, when a cell may split) are read from
// the law table, never from numbers in this file; createBotBrain() refuses to start on an unapproved row.
//
// The brain is pure and deterministic: no Math.random, no Date, no io. Its randomness (personality, reaction time,
// aim, chance) comes from its own seeded agRng, so two brains with the same seed fed the same views give the same
// answers.
//
// View contract (built by the room each tick the brain wants to think; any iterable of cells is fine, nearby cells
// are enough):
//   view = { playerId, tick, border: { minX, minY, maxX, maxY }, cells: [cell, ...] }
//   cell = { id, owner, x, y, size, kind }
//     kind  'player' | 'food' | 'virus' | 'ejected'   (or the mirror-message booleans virus / food / ejected)
//     owner the player id that owns a player cell, or that EJECTED a blob (null or absent when not known)
// The bot's own cells are the player cells whose owner is view.playerId.
// botThink returns { tx, ty, split, eject } (integer target, the same shape a human client sends) or null when the
// bot has no cells (dead: the room respawns it). Between two thinks it returns the held target with split false;
// wantsThink(tick) says whether the next call would think, so the room can skip building a view until then.

const { assertLawsComplete } = require('./agLaws');
const { createRng } = require('./agRng');

// Law rows the brain reads (game rules, never its own numbers).
//   L8, L8_CMP  min size to split and its comparison      L9   max own cells
//   L10         split mass division                        L11  split launch (how far a split piece flies)
//   L23         eat size ratio                             L24  eat overlap
//   L30         who can eat (pop on) a virus
const BOT_LAW_IDS = Object.freeze(['L8', 'L8_CMP', 'L9', 'L10', 'L11', 'L23', 'L24', 'L30']);
// Extra rows planBotFill reads: the fill rule and the room size.
const BOT_FILL_LAW_IDS = Object.freeze(['BOT_FILL', 'L39']);

// BEGIN BOT_TUNING
// Every number the bots tune themselves with. All CHOSEN (ours, Q17 and Q18 and Owen's 2026-10-07 feedback), none
// from agar.io. Distances are world units, times are sim ticks, chances are per think. A test checks that no other
// number appears in this file's code.
function chosen(value, note) {
  return Object.freeze({ value, status: 'CHOSEN', note });
}
const BOT_TUNING = Object.freeze({
  // Shared by every personality.
  SENSE_BASE: chosen(800, 'how far past its own edge the sharpest bot notices cells, at any size (the room sends this much)'),
  SENSE_PER_SIZE: chosen(3, 'extra sense distance per unit of the bot biggest cell size'),
  FLEE_MIN_GAP: chosen(20, 'floor on the gap in the flee weighting, so a touching threat does not divide by zero'),
  TARGET_LEAD: chosen(600, 'how far ahead of the bot centre the target is put when fleeing or steering'),
  WALL_MARGIN: chosen(300, 'flee lead points this close to a wall count as running into it; a bot in pieces never aims or splits into it'),
  WALL_PENALTY: chosen(2, 'flee heading penalty per TARGET_LEAD of lead point past the wall inset'),
  FLEE_DIRECTIONS: chosen(16, 'headings tried when a straight flee would run into a wall'),
  PREY_DIST_BIAS: chosen(100, 'distance added when scoring prey, so near prey wins over far bigger prey'),
  FOOD_DIST_BIAS: chosen(50, 'distance added when scoring food and blobs'),
  SPLIT_COOLDOWN_TICKS: chosen(50, 'least ticks between two splits of one bot'),
  SPLIT_MAX_OWN_CELLS: chosen(2, 'a bot with more cells than this does not split at prey'),
  SPLIT_SAFE_MARGIN: chosen(400, 'a careful bot does not split at prey when a cell that could eat a piece is this close'),
  IDLE_SPLIT_MAX_CELLS: chosen(2, 'a careless split (at food or nothing) only happens with this many cells or fewer'),
  VIRUS_MARGIN: chosen(300, 'steer around a virus that would pop one of our cells when this close to it (wide: bots react slowly)'),
  VIRUS_PUSH: chosen(1.5, 'strength of that steering, against a unit pull toward the goal'),
  SPACE_MARGIN: chosen(40, 'steer off a player cell that neither side can eat when the gap between edges is under this'),
  SPACE_PUSH: chosen(0.8, 'strength of that steering, against a unit pull toward the goal (under 1, so it never stalls)'),
  WANDER_TICKS: chosen(75, 'pick a new wander point this often when nothing is worth chasing'),
  WANDER_INSET: chosen(0.8, 'wander points are chosen inside this share of the border box'),
  EDGE_BAND_MIN: chosen(0.8, 'an edge keeper wanders at least this share of the half side out from the centre'),
  EDGE_BAND_MAX: chosen(0.92, 'and at most this share (inside the wall margin)'),
  EDGE_FOOD_BAND: chosen(0.78, 'an edge keeper only goes for food at least this share of the half side out'),
  EDGE_SNACK_RANGE: chosen(100, 'unless the food is this close to its edge'),
  EDGE_WANDER_SPAN: chosen(0.25, 'how far along its edge (share of the half side) an edge keeper picks its next point'),

  // Personalities: the share of bots that get each one (the three add up to 1), then each one's settings.
  //   THINK_MIN, THINK_MAX  ticks between two decisions (drawn each time; the target is held in between)
  //   SENSE_SHARE           share of the full sense distance it notices cells within
  //   FLEE_MARGIN           flee when a threat is closer than this to being able to eat one of its cells
  //   SPLIT_FEAR            share of a threat's split reach added to that flee distance
  //   AIM_JITTER            its target misses by up to this share of the distance, on each axis
  //   PREY_RATIO            only chases a cell its biggest cell is at least this many times the size of
  //   CHASE_CHANCE          chance, each think with such prey in range, that it starts a chase
  //   CHASE_RANGE           how far past the edges such prey may be for a chase to start
  //   GIVE_UP_TICKS         a chase ends after this long, caught or not
  //   HUNT_REST_TICKS       and no new chase starts for this long after it ends
  //   SPLIT_REACH           only splits at prey inside this share of the computed split reach
  //   SPLIT_CHANCE          chance, each think with prey in that reach, that it splits
  //   SPLIT_CARE            share of the safety zone it checks before splitting at prey (0: careless)
  //   IDLE_SPLIT_CHANCE     chance, each calm think, that it splits toward food or nothing
  //   KEEPS_TO_EDGE         1: farms and wanders near the map's edge; 0: anywhere
  HUNTER_SHARE: chosen(0.15, 'share of bots that are hunters'),
  HUNTER_THINK_MIN: chosen(3, 'hunter: fewest ticks between two decisions'),
  HUNTER_THINK_MAX: chosen(5, 'hunter: most ticks between two decisions'),
  HUNTER_SENSE_SHARE: chosen(1, 'hunter: share of the full sense distance'),
  HUNTER_FLEE_MARGIN: chosen(200, 'hunter: flee distance from being eaten'),
  HUNTER_SPLIT_FEAR: chosen(0.7, 'hunter: share of a threat split reach added to the flee distance'),
  HUNTER_AIM_JITTER: chosen(0.08, 'hunter: aim error as a share of the distance'),
  HUNTER_PREY_RATIO: chosen(1.35, 'hunter: chases only cells this many times smaller'),
  HUNTER_CHASE_CHANCE: chosen(0.7, 'hunter: chance per think to start a chase'),
  HUNTER_CHASE_RANGE: chosen(600, 'hunter: farthest edge gap at which a chase starts'),
  HUNTER_GIVE_UP_TICKS: chosen(60, 'hunter: a chase lasts at most this long'),
  HUNTER_HUNT_REST_TICKS: chosen(75, 'hunter: rest after a chase before the next one'),
  HUNTER_SPLIT_REACH: chosen(0.7, 'hunter: splits at prey inside this share of the split reach'),
  HUNTER_SPLIT_CHANCE: chosen(0.5, 'hunter: chance per think to split at prey in reach'),
  HUNTER_SPLIT_CARE: chosen(1, 'hunter: checks the whole safety zone before splitting at prey'),
  HUNTER_IDLE_SPLIT_CHANCE: chosen(0.004, 'hunter: chance per calm think of a careless split'),
  HUNTER_KEEPS_TO_EDGE: chosen(0, 'hunter: roams the whole map'),
  CASUAL_SHARE: chosen(0.6, 'share of bots that are casual'),
  CASUAL_THINK_MIN: chosen(5, 'casual: fewest ticks between two decisions'),
  CASUAL_THINK_MAX: chosen(10, 'casual: most ticks between two decisions'),
  CASUAL_SENSE_SHARE: chosen(0.6, 'casual: share of the full sense distance'),
  CASUAL_FLEE_MARGIN: chosen(100, 'casual: flee distance from being eaten'),
  CASUAL_SPLIT_FEAR: chosen(0.1, 'casual: share of a threat split reach added to the flee distance'),
  CASUAL_AIM_JITTER: chosen(0.25, 'casual: aim error as a share of the distance'),
  CASUAL_PREY_RATIO: chosen(1.6, 'casual: chases only cells this many times smaller'),
  CASUAL_CHASE_CHANCE: chosen(0.12, 'casual: chance per think to start a chase'),
  CASUAL_CHASE_RANGE: chosen(250, 'casual: farthest edge gap at which a chase starts'),
  CASUAL_GIVE_UP_TICKS: chosen(40, 'casual: a chase lasts at most this long'),
  CASUAL_HUNT_REST_TICKS: chosen(150, 'casual: rest after a chase before the next one'),
  CASUAL_SPLIT_REACH: chosen(0.55, 'casual: splits at prey inside this share of the split reach'),
  CASUAL_SPLIT_CHANCE: chosen(0.35, 'casual: chance per think to split at prey in reach'),
  CASUAL_SPLIT_CARE: chosen(0, 'casual: splits at prey without checking who is around'),
  CASUAL_IDLE_SPLIT_CHANCE: chosen(0.012, 'casual: chance per calm think of a careless split'),
  CASUAL_KEEPS_TO_EDGE: chosen(0, 'casual: roams the whole map'),
  SHY_SHARE: chosen(0.25, 'share of bots that are shy'),
  SHY_THINK_MIN: chosen(4, 'shy: fewest ticks between two decisions'),
  SHY_THINK_MAX: chosen(8, 'shy: most ticks between two decisions'),
  SHY_SENSE_SHARE: chosen(0.8, 'shy: share of the full sense distance'),
  SHY_FLEE_MARGIN: chosen(350, 'shy: flee distance from being eaten'),
  SHY_SPLIT_FEAR: chosen(0.9, 'shy: share of a threat split reach added to the flee distance'),
  SHY_AIM_JITTER: chosen(0.2, 'shy: aim error as a share of the distance'),
  SHY_PREY_RATIO: chosen(2, 'shy: would only chase cells this many times smaller (it never starts a chase)'),
  SHY_CHASE_CHANCE: chosen(0, 'shy: never starts a chase'),
  SHY_CHASE_RANGE: chosen(0, 'shy: no chase range'),
  SHY_GIVE_UP_TICKS: chosen(0, 'shy: no chase to give up'),
  SHY_HUNT_REST_TICKS: chosen(150, 'shy: rest after a chase (never used, kept for the same shape)'),
  SHY_SPLIT_REACH: chosen(0, 'shy: never splits at prey'),
  SHY_SPLIT_CHANCE: chosen(0, 'shy: never splits at prey'),
  SHY_SPLIT_CARE: chosen(0, 'shy: no prey splits to check'),
  SHY_IDLE_SPLIT_CHANCE: chosen(0.008, 'shy: chance per calm think of a careless split'),
  SHY_KEEPS_TO_EDGE: chosen(1, 'shy: farms and wanders near the map edge'),
});
// END BOT_TUNING

// The personalities in draw order, and the settings each one reads from BOT_TUNING (PREFIX_KEY).
const PERSONALITIES = Object.freeze(['hunter', 'casual', 'shy']);
const PROFILE_KEYS = Object.freeze([
  'SHARE', 'THINK_MIN', 'THINK_MAX', 'SENSE_SHARE', 'FLEE_MARGIN', 'SPLIT_FEAR', 'AIM_JITTER', 'PREY_RATIO',
  'CHASE_CHANCE', 'CHASE_RANGE', 'GIVE_UP_TICKS', 'HUNT_REST_TICKS', 'SPLIT_REACH', 'SPLIT_CHANCE', 'SPLIT_CARE',
  'IDLE_SPLIT_CHANCE', 'KEEPS_TO_EDGE',
]);

// Our own bot names (CHOSEN, nothing from agar.io).
const BOT_NAMES = Object.freeze([
  'Pebble', 'Mochi', 'Nimbus', 'Comet', 'Biscuit', 'Quasar', 'Pickle', 'Orbit', 'Waffle', 'Zephyr',
  'Mango', 'Tofu', 'Rocket', 'Sprout', 'Nebula', 'Pudding', 'Cosmo', 'Jelly', 'Bramble', 'Ripple',
]);

const T = {};
for (const k of Object.keys(BOT_TUNING)) T[k] = BOT_TUNING[k].value;

// One personality's settings, checked once at load (a bad table fails loudly, not mid-game).
function buildProfile(name) {
  const prefix = name.toUpperCase() + '_';
  const p = { name };
  for (const k of PROFILE_KEYS) {
    const v = T[prefix + k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error('agBots: bad tuning ' + prefix + k);
    p[k] = v;
  }
  if (!Number.isInteger(p.THINK_MIN) || !Number.isInteger(p.THINK_MAX) || p.THINK_MIN < 1 || p.THINK_MAX < p.THINK_MIN) {
    throw new Error('agBots: ' + prefix + 'THINK_MIN and THINK_MAX must be whole ticks, 1 or more, min not above max');
  }
  if (p.SENSE_SHARE > 1) throw new Error('agBots: ' + prefix + 'SENSE_SHARE above 1 (the room sends no more)');
  return Object.freeze(p);
}
const PROFILES = {};
let shareSum = 0;
for (const name of PERSONALITIES) {
  PROFILES[name] = buildProfile(name);
  shareSum += PROFILES[name].SHARE;
}
Object.freeze(PROFILES);
if (Math.abs(shareSum - 1) > Number.EPSILON * PERSONALITIES.length) throw new Error('agBots: personality shares must add up to 1');

function personalityProfile(name) {
  return Object.prototype.hasOwnProperty.call(PROFILES, name) ? PROFILES[name] : null;
}

// One draw: hunter, casual or shy by their shares.
function drawPersonality(rng) {
  const u = rng();
  let acc = 0;
  for (const name of PERSONALITIES) {
    acc += PROFILES[name].SHARE;
    if (u < acc) return name;
  }
  return PERSONALITIES[PERSONALITIES.length - 1];
}

// ---------------------------------------------------------------------------------------------------------------
// Game-rule helpers (law table only).

function kindOf(c) {
  if (typeof c.kind === 'string') return c.kind;
  if (c.virus) return 'virus';
  if (c.food) return 'food';
  if (c.ejected) return 'ejected';
  return 'player';
}

function okNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// True when a cell of size `big` may eat a cell of size `small` (L23 radius ratio).
function canEatSize(big, small, laws) {
  return big >= laws.L23.value * small;
}

// The centre distance below which an eater of size R swallows a cell of size r (L24 overlap).
function eatDistance(R, r, laws) {
  return R - r / laws.L24.value.div;
}

function canSplitSize(size, laws) {
  return laws.L8_CMP.value === '>' ? size > laws.L8.value : size >= laws.L8.value;
}

// Sizes of the launched piece and of the piece left behind (L10 mass division).
function splitPieces(size, laws) {
  const f = laws.L10.value.newCellMassFraction;
  return { launched: size * Math.sqrt(f), kept: size * Math.sqrt(1 - f) };
}

// How far the launched piece's centre travels from the parent centre (L11: each tick moves 1/decayDiv of the
// boost that is left, so the whole boost is the travel; with a measured firstStep the piece also begins
// (firstStep - boost / decayDiv) ahead of the parent centre, as agSim starts a Space split).
function splitTravel(pieceSize, laws) {
  const b = laws.L11.value;
  const boost = b.velocity * Math.pow(pieceSize, b.sizeExp);
  return b.firstStep === undefined ? boost : boost + b.firstStep - boost / b.decayDiv;
}

// Farthest prey centre (from the parent centre) that a split of a cell of `size` can swallow, before the CHOSEN
// safety share. Null when the piece cannot eat that prey at all.
function splitKillRange(size, preySize, laws) {
  if (!canSplitSize(size, laws)) return null;
  const p = splitPieces(size, laws);
  if (!canEatSize(p.launched, preySize, laws)) return null;
  return splitTravel(p.launched, laws) + eatDistance(p.launched, preySize, laws);
}

// ---------------------------------------------------------------------------------------------------------------
// Fill rule (THE ONE RULE lives here as well as in the room).

// How many bots the room should add or remove now. botsAllowed false always means: remove every bot, add none.
function planBotFill(opts, laws) {
  assertLawsComplete(laws, BOT_FILL_LAW_IDS);
  const humans = opts && okNum(opts.humans) && opts.humans > 0 ? Math.floor(opts.humans) : 0;
  const bots = opts && okNum(opts.bots) && opts.bots > 0 ? Math.floor(opts.bots) : 0;
  if (!opts || opts.botsAllowed !== true) return { add: 0, remove: bots, want: 0 };
  if (laws.BOT_FILL.value !== 'toRoomSize') throw new Error('agBots: unsupported BOT_FILL rule ' + laws.BOT_FILL.value);
  const roomSize = laws.L39.value;
  const want = Math.max(0, roomSize - humans);
  return { add: Math.max(0, want - bots), remove: Math.max(0, bots - want), want };
}

function botName(rng) {
  return BOT_NAMES[rng.int(BOT_NAMES.length)];
}

// ---------------------------------------------------------------------------------------------------------------
// The brain.

// opts: { laws, seed | rng, personality? } (personality forces one, for tests and the owner console; otherwise it
// is the first draw of the brain's own seeded rng).
function createBotBrain(opts) {
  const o = opts || {};
  const laws = o.laws;
  assertLawsComplete(laws, BOT_LAW_IDS);
  let rng = o.rng;
  if (!rng) rng = createRng(okNum(o.seed) ? o.seed : 0);
  let personality;
  if (o.personality !== undefined) {
    if (!personalityProfile(o.personality)) throw new Error('agBots: unknown personality ' + String(o.personality));
    personality = o.personality;
  } else {
    personality = drawPersonality(rng);
  }
  const prof = PROFILES[personality];

  const mem = {
    personality,
    huntId: null,       // cell id of the prey being chased
    huntOwner: null,    // its owner (blobs from this player may be eaten)
    huntSince: 0,
    restUntil: null,    // no new chase before this tick
    lastSplitTick: null,
    wanderX: null,
    wanderY: null,
    wanderTick: null,
    lastThink: null,    // tick of the last decision
    nextThink: null,    // tick of the next one (the held target stands until then)
    heldX: null,
    heldY: null,
    goalId: null,       // cell id of the pellet, blob or prey it is heading for (null when fleeing or wandering)
    mode: 'idle',
  };

  function wantsThink(tick) {
    return mem.nextThink === null || !okNum(tick) || tick >= mem.nextThink || tick < mem.lastThink;
  }

  function think(view) {
    return decide(view, laws, prof, rng, mem, wantsThink);
  }

  return {
    personality,
    botThink: think,
    think,
    wantsThink,
    memory() {
      return Object.assign({}, mem);
    },
  };
}

function botThink(brain, view) {
  return brain.botThink(view);
}

function clampToBorder(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function forgetHunt(mem) {
  mem.huntId = null;
  mem.huntOwner = null;
}

// How far out from the centre a point is, as a share of the half side (0 centre, 1 on the border; the larger axis).
function bandOf(x, y, border) {
  const hw = (border.maxX - border.minX) / 2;
  const hh = (border.maxY - border.minY) / 2;
  if (!(hw > 0) || !(hh > 0)) return 0;
  return Math.max(Math.abs(x - (border.minX + border.maxX) / 2) / hw, Math.abs(y - (border.minY + border.maxY) / 2) / hh);
}

function decide(view, laws, prof, rng, mem, wantsThink) {
  if (!view || typeof view !== 'object') return null;
  const me = view.playerId;
  const tick = okNum(view.tick) ? view.tick : 0;
  const border = view.border;
  const all = view.cells || [];

  // Own cells, their mass centre and biggest size.
  const own = [];
  for (const c of all) {
    if (c && c.owner === me && kindOf(c) === 'player' && okNum(c.x) && okNum(c.y) && okNum(c.size) && c.size > 0) {
      own.push(c);
    }
  }
  if (!own.length) {
    forgetHunt(mem);
    mem.mode = 'dead';
    mem.goalId = null;
    mem.nextThink = null;
    mem.heldX = null;
    return null;
  }

  // Reaction time: between two decisions the bot keeps its last target and never presses split again.
  if (mem.heldX !== null && !wantsThink(tick)) {
    return { tx: mem.heldX, ty: mem.heldY, split: false, eject: false };
  }
  mem.lastThink = tick;
  mem.nextThink = tick + prof.THINK_MIN + rng.int(prof.THINK_MAX - prof.THINK_MIN + 1);

  let mass = 0;
  let cx = 0;
  let cy = 0;
  let biggest = own[0];
  for (const c of own) {
    const m = c.size * c.size;
    mass += m;
    cx += c.x * m;
    cy += c.y * m;
    if (c.size > biggest.size) biggest = c;
  }
  cx /= mass;
  cy /= mass;
  const sense = (T.SENSE_BASE + T.SENSE_PER_SIZE * biggest.size) * prof.SENSE_SHARE;
  const edgeKeeper = prof.KEEPS_TO_EDGE > 0 && !!border;
  const inPieces = own.length > 1 && !!border && border.maxX - border.minX > 2 * T.WALL_MARGIN &&
    border.maxY - border.minY > 2 * T.WALL_MARGIN;

  // Sort what we can see. Distances are from the nearest own cell's centre.
  let fleeX = 0;
  let fleeY = 0;
  let threatened = false;
  let spaceX = 0;
  let spaceY = 0;
  const others = [];
  const viruses = [];
  let bestPrey = null;
  let bestPreyScore = 0;
  let huntPrey = null;
  let bestFood = null;
  let bestFoodScore = 0;
  // Goal candidates (cell, score, the own cell that would eat it), picked once every other player cell is known.
  const preyC = [];
  const preyS = [];
  const preyE = [];
  const foodC = [];
  const foodS = [];
  const foodE = [];

  for (const c of all) {
    if (!c || !okNum(c.x) || !okNum(c.y) || !okNum(c.size) || c.size <= 0) continue;
    const kind = kindOf(c);
    if (kind === 'player' && c.owner === me) continue;
    // Nearest own cell and its distance.
    let near = own[0];
    let nd = Infinity;
    for (const m of own) {
      const d = Math.hypot(c.x - m.x, c.y - m.y);
      if (d < nd) {
        nd = d;
        near = m;
      }
    }
    if (nd - c.size - near.size > sense) continue;

    if (kind === 'virus') {
      viruses.push(c);
      continue;
    }
    if (kind === 'player') {
      others.push(c);
      for (const m of own) {
        const d = Math.hypot(m.x - c.x, m.y - c.y);
        if (canEatSize(c.size, m.size, laws)) {
          // Threat: it can eat this cell. How much of its split reach the bot fears depends on the personality.
          const gap = d - eatDistance(c.size, m.size, laws);
          const reach = splitKillRange(c.size, m.size, laws);
          const zone = prof.FLEE_MARGIN +
            prof.SPLIT_FEAR * (reach === null ? 0 : Math.max(0, reach - eatDistance(c.size, m.size, laws)));
          if (gap < zone) {
            threatened = true;
            const w = (m.size * m.size) / Math.max(gap, T.FLEE_MIN_GAP);
            const ux = d > 0 ? (m.x - c.x) / d : 1;
            const uy = d > 0 ? (m.y - c.y) / d : 0;
            fleeX += ux * w;
            fleeY += uy * w;
          }
        } else if (!canEatSize(m.size, c.size, laws) && d - m.size - c.size < T.SPACE_MARGIN) {
          // Neither side can eat the other: keep some space instead of sliding on top of it. Two centres exactly on
          // top of each other split by player id (each side pushes the opposite way), so they never stay locked.
          if (d > 0) {
            spaceX += (m.x - c.x) / d;
            spaceY += (m.y - c.y) / d;
          } else {
            spaceX += idBefore(me, c.owner) ? 1 : -1;
          }
        }
      }
      // Prey: one of our cells can eat it.
      if (canEatSize(biggest.size, c.size, laws)) {
        if (c.id === mem.huntId) huntPrey = c;
        if (biggest.size >= prof.PREY_RATIO * c.size && nd - c.size - near.size <= prof.CHASE_RANGE) {
          preyC.push(c);
          preyS.push((c.size * c.size) / (nd + T.PREY_DIST_BIAS));
          preyE.push(bestEater(own, c, laws));
        }
      }
      continue;
    }
    // Food, and ejected blobs only from the player we are hunting (never team: no feeding chains).
    if (kind === 'ejected') {
      if (mem.huntOwner === null || c.owner === undefined || c.owner === null || c.owner !== mem.huntOwner) continue;
    } else if (kind !== 'food') {
      continue;
    }
    if (!canEatSize(near.size, c.size, laws)) continue;
    // An edge keeper leaves the middle of the map alone, bar a pellet right at its edge.
    if (edgeKeeper && bandOf(c.x, c.y, border) < T.EDGE_FOOD_BAND && nd - near.size > T.EDGE_SNACK_RANGE) continue;
    // A bot in pieces leaves food in the wall margin alone (see the target clamp below).
    if (inPieces && outsideInset(c.x, c.y, border) > 0) continue;
    foodC.push(c);
    foodS.push((c.size * c.size) / (nd + T.FOOD_DIST_BIAS));
    foodE.push(near);
  }

  // The best goal no rival will reach first: two bots side by side never pick the same pellet or the same prey (the
  // nearer one keeps it, an exact tie goes by player id), so they do not lock onto one spot. A rival is a cell that
  // neither eats nor is eaten by the own cell going for the goal (the same cells it keeps its space from), bot or
  // human alike (never team); cells it could eat or must flee are handled as prey and threats, as before.
  for (let i = 0; i < foodC.length; i++) {
    if (foodS[i] > bestFoodScore && !contested(foodC[i], foodE[i], others, me, laws)) {
      bestFoodScore = foodS[i];
      bestFood = foodC[i];
    }
  }
  for (let i = 0; i < preyC.length; i++) {
    if (preyS[i] > bestPreyScore && !contested(preyC[i], preyE[i], others, me, laws)) {
      bestPreyScore = preyS[i];
      bestPrey = preyC[i];
    }
  }

  let goalX;
  let goalY;
  let aimAtPoint = true;
  let jitter = false;
  let split = false;
  mem.goalId = null;

  if (threatened && (fleeX !== 0 || fleeY !== 0)) {
    mem.mode = 'flee';
    forgetHunt(mem);
    // Do not run into a wall: try FLEE_DIRECTIONS headings and take the one most away from the threats once a
    // lead point beyond the wall inset is penalised, so a bot curves along a wall instead of pinning itself there.
    if (border) {
      const fl = Math.hypot(fleeX, fleeY);
      const ux = fleeX / fl;
      const uy = fleeY / fl;
      let best = -Infinity;
      let bx = ux;
      let by = uy;
      for (let i = 0; i < T.FLEE_DIRECTIONS; i++) {
        const ang = (i / T.FLEE_DIRECTIONS) * Math.PI * 2;
        const dxi = Math.cos(ang);
        const dyi = Math.sin(ang);
        const s = dxi * ux + dyi * uy - T.WALL_PENALTY * outsideInset(cx + dxi * T.TARGET_LEAD, cy + dyi * T.TARGET_LEAD, border) / T.TARGET_LEAD;
        if (s > best) {
          best = s;
          bx = dxi;
          by = dyi;
        }
      }
      // The straight-away heading wins whenever it is not penalised.
      const straight = ux * ux + uy * uy - T.WALL_PENALTY * outsideInset(cx + ux * T.TARGET_LEAD, cy + uy * T.TARGET_LEAD, border) / T.TARGET_LEAD;
      if (straight >= best) {
        bx = ux;
        by = uy;
      }
      fleeX = bx;
      fleeY = by;
    }
    goalX = fleeX;
    goalY = fleeY;
    aimAtPoint = false;
  } else {
    // A chase runs until it is won, lost from sight or GIVE_UP_TICKS old; then the bot rests before another.
    let prey = null;
    if (mem.huntId !== null) {
      if (huntPrey && tick - mem.huntSince < prof.GIVE_UP_TICKS) {
        prey = huntPrey;
      } else {
        forgetHunt(mem);
        mem.restUntil = tick + prof.HUNT_REST_TICKS;
      }
    }
    if (!prey && bestPrey && prof.CHASE_CHANCE > 0 && !(mem.restUntil !== null && tick < mem.restUntil) &&
      rng() < prof.CHASE_CHANCE) {
      prey = bestPrey;
      mem.huntId = prey.id;
      mem.huntSince = tick;
    }
    if (prey) {
      mem.mode = 'hunt';
      mem.huntOwner = prey.owner === undefined ? null : prey.owner;
      mem.goalId = prey.id;
      goalX = prey.x;
      goalY = prey.y;
      jitter = true;
      if (wantSplit(own, prey, others, laws, prof, mem, tick) && rng() < prof.SPLIT_CHANCE) split = true;
    } else if (bestFood) {
      mem.mode = 'eat';
      mem.goalId = bestFood.id;
      goalX = bestFood.x;
      goalY = bestFood.y;
      jitter = true;
    } else {
      mem.mode = 'wander';
      const reached = mem.wanderX !== null && Math.hypot(mem.wanderX - cx, mem.wanderY - cy) < biggest.size;
      if (mem.wanderTick === null || tick - mem.wanderTick >= T.WANDER_TICKS || mem.wanderX === null || reached) {
        if (edgeKeeper) pickEdgeWander(border, cx, cy, rng, mem);
        else pickWander(border, cx, cy, rng, mem);
        mem.wanderTick = tick;
      }
      goalX = mem.wanderX;
      goalY = mem.wanderY;
    }
  }

  // Imperfect aim: the target misses by up to AIM_JITTER of the distance on each axis (a split flies there too).
  if (jitter) {
    const reach = Math.hypot(goalX - cx, goalY - cy) * prof.AIM_JITTER;
    goalX += (rng() * 2 - 1) * reach;
    goalY += (rng() * 2 - 1) * reach;
  }

  // Careless split: now and then a calm bot splits toward whatever it is heading for, which leaves it in pieces
  // (never when the launched piece would land in the wall margin, where pinned pieces only pile up, nor with a virus
  // the launched piece could pop on inside its flight).
  if (!split && (mem.mode === 'eat' || mem.mode === 'wander') && own.length <= T.IDLE_SPLIT_MAX_CELLS &&
    canSplitSize(biggest.size, laws) && splitReady(mem, tick) && prof.IDLE_SPLIT_CHANCE > 0 &&
    !launchIntoWall(cx, cy, goalX, goalY, biggest.size, laws, border) &&
    !virusInFlight(cx, cy, biggest.size, viruses, laws) && rng() < prof.IDLE_SPLIT_CHANCE) {
    split = true;
  }
  if (split) mem.lastSplitTick = tick;

  // Steer around viruses that would pop one of our cells, and off cells neither side can eat (not while splitting:
  // the split already flies). Fleeing bots keep their space too, or two bots running from one threat stay stacked.
  let dx = aimAtPoint ? goalX - cx : goalX;
  let dy = aimAtPoint ? goalY - cy : goalY;
  let dist = Math.hypot(dx, dy);
  if (!split) {
    let pushX = 0;
    let pushY = 0;
    for (const v of viruses) {
      for (const m of own) {
        if (!canEatSize(m.size, v.size, laws)) continue;
        const d = Math.hypot(m.x - v.x, m.y - v.y);
        const gap = d - m.size - v.size;
        if (gap < T.VIRUS_MARGIN) {
          pushX += d > 0 ? (m.x - v.x) / d : 0;
          pushY += d > 0 ? (m.y - v.y) / d : 0;
        }
      }
    }
    if (pushX !== 0 || pushY !== 0 || spaceX !== 0 || spaceY !== 0) {
      let nx = dist > 0 ? dx / dist : 0;
      let ny = dist > 0 ? dy / dist : 0;
      if (pushX !== 0 || pushY !== 0) {
        const pl = Math.hypot(pushX, pushY);
        nx += (pushX / pl) * T.VIRUS_PUSH;
        ny += (pushY / pl) * T.VIRUS_PUSH;
      }
      if (spaceX !== 0 || spaceY !== 0) {
        const sl = Math.hypot(spaceX, spaceY);
        let sx = spaceX / sl;
        let sy = spaceY / sl;
        // A push straight back against the heading would only shorten it (same heading, same speed), so a bot
        // behind another one steps aside instead: square to its heading, on the side the push leans to.
        const hl = Math.hypot(nx, ny);
        if (hl > 0) {
          const hx = nx / hl;
          const hy = ny / hl;
          if (sx * hx + sy * hy < 0) {
            const side = hx * sy - hy * sx < 0 ? -1 : 1;
            sx = -hy * side;
            sy = hx * side;
          }
        }
        nx += sx * T.SPACE_PUSH;
        ny += sy * T.SPACE_PUSH;
      }
      dx = nx;
      dy = ny;
      aimAtPoint = false;
      dist = Math.hypot(dx, dy);
    }
  }

  let tx;
  let ty;
  if (aimAtPoint) {
    tx = goalX;
    ty = goalY;
  } else if (dist > 0) {
    tx = cx + (dx / dist) * T.TARGET_LEAD;
    ty = cy + (dy / dist) * T.TARGET_LEAD;
  } else {
    tx = cx;
    ty = cy;
  }
  if (border) {
    // A bot in pieces never aims into the wall margin: its pieces would only be pressed together against the wall.
    const inset = inPieces ? T.WALL_MARGIN : 0;
    tx = clampToBorder(tx, border.minX + inset, border.maxX - inset);
    ty = clampToBorder(ty, border.minY + inset, border.maxY - inset);
  }
  mem.heldX = Math.round(tx);
  mem.heldY = Math.round(ty);
  // Never team: a bot never ejects (ejecting only ever feeds someone else).
  return { tx: mem.heldX, ty: mem.heldY, split, eject: false };
}

// A fixed order on player ids, the same from both sides (each of two bots gets the opposite answer).
function idBefore(a, b) {
  return String(a) < String(b);
}

// How far `eater` is from eating `target` (centre distance minus the L24 eat distance).
function eatGap(eater, target, laws) {
  return Math.hypot(target.x - eater.x, target.y - eater.y) - eatDistance(eater.size, target.size, laws);
}

// Our cell nearest to eating `target` (null when none can eat it).
function bestEater(own, target, laws) {
  let best = null;
  let bestGap = Infinity;
  for (const m of own) {
    if (!canEatSize(m.size, target.size, laws)) continue;
    const g = eatGap(m, target, laws);
    if (g < bestGap) {
      bestGap = g;
      best = m;
    }
  }
  return best;
}

// True when a rival of our `eater` (a cell neither eats the other) that can eat `target` is nearer to eating it;
// an exact tie goes to the lower player id. The target's own player never competes for it.
function contested(target, eater, others, me, laws) {
  const gap = eatGap(eater, target, laws);
  for (const c of others) {
    if (c === target || (c.owner === target.owner && kindOf(target) === 'player')) continue;
    if (canEatSize(c.size, eater.size, laws) || canEatSize(eater.size, c.size, laws)) continue;
    if (!canEatSize(c.size, target.size, laws)) continue;
    const g = eatGap(c, target, laws);
    if (g < gap || (g === gap && idBefore(c.owner, me))) return true;
  }
  return false;
}

// How far a point lies outside the border shrunk by WALL_MARGIN on every side (0 inside).
function outsideInset(x, y, border) {
  const ox = Math.max(border.minX + T.WALL_MARGIN - x, 0, x - (border.maxX - T.WALL_MARGIN));
  const oy = Math.max(border.minY + T.WALL_MARGIN - y, 0, y - (border.maxY - T.WALL_MARGIN));
  return ox + oy;
}

// True when a split of a cell of `size` at (cx, cy) toward (gx, gy) would land its launched piece inside the wall
// margin (WALL_MARGIN), using the law split travel.
function launchIntoWall(cx, cy, gx, gy, size, laws, border) {
  if (!border) return false;
  const d = Math.hypot(gx - cx, gy - cy);
  if (!(d > 0)) return false;
  const travel = splitTravel(splitPieces(size, laws).launched, laws);
  return outsideInset(cx + ((gx - cx) / d) * travel, cy + ((gy - cy) / d) * travel, border) > 0;
}

// True when a virus the launched piece of a `size` cell could pop on lies within its split flight (plus VIRUS_MARGIN).
function virusInFlight(cx, cy, size, viruses, laws) {
  const piece = splitPieces(size, laws).launched;
  const reach = splitTravel(piece, laws) + piece + T.VIRUS_MARGIN;
  for (const v of viruses) {
    if (canEatSize(piece, v.size, laws) && Math.hypot(v.x - cx, v.y - cy) - v.size < reach) return true;
  }
  return false;
}

function splitReady(mem, tick) {
  return mem.lastSplitTick === null || tick - mem.lastSplitTick >= T.SPLIT_COOLDOWN_TICKS || tick < mem.lastSplitTick;
}

function wantSplit(own, prey, others, laws, prof, mem, tick) {
  if (prof.SPLIT_REACH <= 0 || prof.SPLIT_CHANCE <= 0) return false;
  if (!splitReady(mem, tick)) return false;
  if (own.length > T.SPLIT_MAX_OWN_CELLS || own.length >= laws.L9.value) return false;
  // Some cell must reach and swallow the prey with its launched piece.
  let hits = false;
  for (const m of own) {
    const range = splitKillRange(m.size, prey.size, laws);
    if (range === null) continue;
    const d = Math.hypot(prey.x - m.x, prey.y - m.y);
    if (d <= range * prof.SPLIT_REACH) {
      hits = true;
      break;
    }
  }
  if (!hits) return false;
  if (prof.SPLIT_CARE <= 0) return true;
  // A careful bot keeps every piece the split makes safe: no other cell that could eat a piece (or split onto it)
  // inside SPLIT_CARE of the safety zone.
  for (const m of own) {
    if (!canSplitSize(m.size, laws)) continue;
    const p = splitPieces(m.size, laws);
    const piece = Math.min(p.launched, p.kept);
    for (const c of others) {
      if (c === prey) continue;
      if (!canEatSize(c.size, piece, laws)) continue;
      const reach = splitKillRange(c.size, piece, laws);
      const d = Math.hypot(c.x - m.x, c.y - m.y);
      const gap = d - eatDistance(c.size, piece, laws);
      const zone = prof.SPLIT_CARE * (T.SPLIT_SAFE_MARGIN + (reach === null ? 0 : reach));
      if (gap < zone) return false;
    }
  }
  return true;
}

function pickWander(border, cx, cy, rng, mem) {
  if (!border) {
    mem.wanderX = cx + (rng() * 2 - 1) * T.TARGET_LEAD;
    mem.wanderY = cy + (rng() * 2 - 1) * T.TARGET_LEAD;
    return;
  }
  const midX = (border.minX + border.maxX) / 2;
  const midY = (border.minY + border.maxY) / 2;
  const hw = ((border.maxX - border.minX) / 2) * T.WANDER_INSET;
  const hh = ((border.maxY - border.minY) / 2) * T.WANDER_INSET;
  mem.wanderX = midX + (rng() * 2 - 1) * hw;
  mem.wanderY = midY + (rng() * 2 - 1) * hh;
}

// An edge keeper heads for the band near its nearest side and then drifts along it (always two draws).
function pickEdgeWander(border, cx, cy, rng, mem) {
  const midX = (border.minX + border.maxX) / 2;
  const midY = (border.minY + border.maxY) / 2;
  const hw = (border.maxX - border.minX) / 2;
  const hh = (border.maxY - border.minY) / 2;
  const nx = hw > 0 ? (cx - midX) / hw : 0;
  const ny = hh > 0 ? (cy - midY) / hh : 0;
  const out = T.EDGE_BAND_MIN + rng() * (T.EDGE_BAND_MAX - T.EDGE_BAND_MIN);
  const along = (rng() * 2 - 1) * T.EDGE_WANDER_SPAN;
  const lim = T.EDGE_BAND_MAX;
  if (Math.abs(nx) >= Math.abs(ny)) {
    mem.wanderX = midX + (nx < 0 ? -out : out) * hw;
    mem.wanderY = midY + clampToBorder(ny + along, -lim, lim) * hh;
  } else {
    mem.wanderX = midX + clampToBorder(nx + along, -lim, lim) * hw;
    mem.wanderY = midY + (ny < 0 ? -out : out) * hh;
  }
}

module.exports = {
  BOT_LAW_IDS,
  BOT_FILL_LAW_IDS,
  BOT_TUNING,
  BOT_NAMES,
  PERSONALITIES,
  createBotBrain,
  botThink,
  planBotFill,
  botName,
  personalityProfile,
  drawPersonality,
  splitKillRange,
  canEatSize,
};
