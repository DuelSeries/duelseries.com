'use strict';
// Bots for the free agar.io rooms (CHOSEN design, Owen's answers Q17 and Q18; parity log C6; build brief 9.1, 9.2).
//
// Owen asked for DECENT bots: they eat food, flee anything that can eat them, split to catch a smaller cell that is
// inside their split reach, and never team (they never eject, never feed anyone, never favour another bot, and
// never chase an ejected blob unless it came from the player they are already hunting). agar.io's own servers run
// no such bots in FFA, so none of this is their behaviour: it is ours, every tuning number sits in BOT_TUNING below,
// labelled CHOSEN, and waits for Owen's approval with the other CHOSEN rows.
//
// THE ONE RULE: bots exist only in rooms where botsAllowed() is true (free rooms; never a paid room). The room asks
// planBotFill() how many to add or remove, and planBotFill() removes every bot when botsAllowed is false.
//
// Game rules the brain must respect (who can eat whom, how far a split flies, when a cell may split) are read from
// the law table, never from numbers in this file; createBotBrain() refuses to start on an unapproved row.
//
// The brain is pure and deterministic: no Math.random, no Date, no io. Its randomness (wandering) comes from its own
// seeded agRng, so two brains with the same seed fed the same views give the same answers.
//
// View contract (built by the room each tick; any iterable of cells is fine, nearby cells are enough):
//   view = { playerId, tick, border: { minX, minY, maxX, maxY }, cells: [cell, ...] }
//   cell = { id, owner, x, y, size, kind }
//     kind  'player' | 'food' | 'virus' | 'ejected'   (or the mirror-message booleans virus / food / ejected)
//     owner the player id that owns a player cell, or that EJECTED a blob (null or absent when not known)
// The bot's own cells are the player cells whose owner is view.playerId.
// botThink returns { tx, ty, split, eject } (integer target, the same shape a human client sends) or null when the
// bot has no cells (dead: the room respawns it).

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
// Every number the bots tune themselves with. All CHOSEN (ours, Q17 and Q18), none from agar.io. Distances are
// world units, times are sim ticks. A test checks that no other number appears in this file's code.
function chosen(value, note) {
  return Object.freeze({ value, status: 'CHOSEN', note });
}
const BOT_TUNING = Object.freeze({
  SENSE_BASE: chosen(800, 'how far past its own edge a bot notices cells, at any size'),
  SENSE_PER_SIZE: chosen(3, 'extra sense distance per unit of the bot biggest cell size'),
  FLEE_MARGIN: chosen(250, 'flee when a threat is closer than this to being able to eat one of our cells'),
  FLEE_MIN_GAP: chosen(20, 'floor on the gap in the flee weighting, so a touching threat does not divide by zero'),
  TARGET_LEAD: chosen(600, 'how far ahead of the bot centre the target is put when fleeing or wandering'),
  WALL_MARGIN: chosen(300, 'flee lead points closer than this to a wall count as running into it'),
  WALL_PENALTY: chosen(2, 'flee heading penalty per TARGET_LEAD of lead point past the wall inset'),
  FLEE_DIRECTIONS: chosen(16, 'headings tried when a straight flee would run into a wall'),
  PREY_WEIGHT: chosen(4, 'how much more a catchable player cell is worth than its mass in food'),
  PREY_DIST_BIAS: chosen(100, 'distance added when scoring prey, so near prey wins over far bigger prey'),
  FOOD_DIST_BIAS: chosen(50, 'distance added when scoring food and blobs'),
  HUNT_STICKY_TICKS: chosen(15, 'keep chasing the same prey this long unless it leaves view or turns dangerous'),
  HUNT_SWITCH_FACTOR: chosen(1.5, 'a new prey must score this many times better to steal the hunt early'),
  SPLIT_REACH_FACTOR: chosen(0.85, 'only split when the prey is inside this share of the computed split reach'),
  SPLIT_COOLDOWN_TICKS: chosen(25, 'least ticks between two bot splits'),
  SPLIT_MAX_OWN_CELLS: chosen(4, 'a bot with more cells than this does not split'),
  SPLIT_SAFE_MARGIN: chosen(400, 'no split when a cell that could eat a split piece is this close to it'),
  VIRUS_MARGIN: chosen(150, 'steer around a virus that would pop one of our cells when this close to it'),
  VIRUS_PUSH: chosen(1.5, 'strength of that steering, against a unit pull toward the goal'),
  WANDER_TICKS: chosen(75, 'pick a new wander point this often when nothing is worth chasing'),
  WANDER_INSET: chosen(0.8, 'wander points are chosen inside this share of the border box'),
});
// END BOT_TUNING

// Our own bot names (CHOSEN, nothing from agar.io).
const BOT_NAMES = Object.freeze([
  'Pebble', 'Mochi', 'Nimbus', 'Comet', 'Biscuit', 'Quasar', 'Pickle', 'Orbit', 'Waffle', 'Zephyr',
  'Mango', 'Tofu', 'Rocket', 'Sprout', 'Nebula', 'Pudding', 'Cosmo', 'Jelly', 'Bramble', 'Ripple',
]);

const T = {};
for (const k of Object.keys(BOT_TUNING)) T[k] = BOT_TUNING[k].value;

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
// boost that is left, so the whole boost is the total travel).
function splitTravel(pieceSize, laws) {
  const b = laws.L11.value;
  return b.velocity * Math.pow(pieceSize, b.sizeExp);
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

function createBotBrain(opts) {
  const o = opts || {};
  const laws = o.laws;
  assertLawsComplete(laws, BOT_LAW_IDS);
  let rng = o.rng;
  if (!rng) rng = createRng(okNum(o.seed) ? o.seed : 0);

  const mem = {
    huntId: null,       // cell id of the prey being chased
    huntOwner: null,    // its owner (blobs from this player may be eaten)
    huntSince: 0,
    lastSplitTick: null,
    wanderX: null,
    wanderY: null,
    wanderTick: null,
    mode: 'idle',
  };

  function think(view) {
    return decide(view, laws, rng, mem);
  }

  return {
    botThink: think,
    think,
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

function decide(view, laws, rng, mem) {
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
    mem.huntId = null;
    mem.huntOwner = null;
    mem.mode = 'dead';
    return null;
  }
  let mass = 0;
  let cx = 0;
  let cy = 0;
  let biggest = own[0];
  let smallest = own[0];
  for (const c of own) {
    const m = c.size * c.size;
    mass += m;
    cx += c.x * m;
    cy += c.y * m;
    if (c.size > biggest.size) biggest = c;
    if (c.size < smallest.size) smallest = c;
  }
  cx /= mass;
  cy /= mass;
  const sense = T.SENSE_BASE + T.SENSE_PER_SIZE * biggest.size;

  // Sort what we can see. Distances are from the nearest own cell's centre.
  let fleeX = 0;
  let fleeY = 0;
  let threatened = false;
  const others = [];
  const viruses = [];
  let bestPrey = null;
  let bestPreyScore = 0;
  let huntPrey = null;
  let huntScore = 0;
  let bestFood = null;
  let bestFoodScore = 0;

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
      // Threat: it can eat one of our cells (checked against every own cell it could swallow).
      for (const m of own) {
        if (!canEatSize(c.size, m.size, laws)) continue;
        const d = Math.hypot(m.x - c.x, m.y - c.y);
        const gap = d - eatDistance(c.size, m.size, laws);
        const reach = splitKillRange(c.size, m.size, laws);
        // A threat that could split onto this cell is dangerous from much farther away.
        const zone = T.FLEE_MARGIN + (reach === null ? 0 : Math.max(0, reach - eatDistance(c.size, m.size, laws)));
        if (gap < zone) {
          threatened = true;
          const w = (m.size * m.size) / Math.max(gap, T.FLEE_MIN_GAP);
          const ux = d > 0 ? (m.x - c.x) / d : 1;
          const uy = d > 0 ? (m.y - c.y) / d : 0;
          fleeX += ux * w;
          fleeY += uy * w;
        }
      }
      // Prey: one of our cells can eat it.
      if (canEatSize(biggest.size, c.size, laws)) {
        const score = (T.PREY_WEIGHT * c.size * c.size) / (nd + T.PREY_DIST_BIAS);
        if (score > bestPreyScore) {
          bestPreyScore = score;
          bestPrey = c;
        }
        if (c.id === mem.huntId) {
          huntPrey = c;
          huntScore = score;
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
    const score = (c.size * c.size) / (nd + T.FOOD_DIST_BIAS);
    if (score > bestFoodScore) {
      bestFoodScore = score;
      bestFood = c;
    }
  }

  // Keep a hunt for HUNT_STICKY_TICKS unless a clearly better prey shows up.
  let prey = bestPrey;
  if (huntPrey && tick - mem.huntSince < T.HUNT_STICKY_TICKS && !(bestPreyScore > huntScore * T.HUNT_SWITCH_FACTOR)) {
    prey = huntPrey;
  }

  let goalX;
  let goalY;
  let aimAtPoint = true;
  let split = false;

  if (threatened && (fleeX !== 0 || fleeY !== 0)) {
    mem.mode = 'flee';
    mem.huntId = null;
    mem.huntOwner = null;
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
  } else if (prey) {
    mem.mode = 'hunt';
    if (prey.id !== mem.huntId) {
      mem.huntId = prey.id;
      mem.huntSince = tick;
    }
    mem.huntOwner = prey.owner === undefined ? null : prey.owner;
    goalX = prey.x;
    goalY = prey.y;
    split = wantSplit(own, prey, others, laws, mem, tick);
    if (split) mem.lastSplitTick = tick;
  } else if (bestFood) {
    mem.mode = 'eat';
    mem.huntId = null;
    mem.huntOwner = null;
    goalX = bestFood.x;
    goalY = bestFood.y;
  } else {
    mem.mode = 'wander';
    mem.huntId = null;
    mem.huntOwner = null;
    if (mem.wanderTick === null || tick - mem.wanderTick >= T.WANDER_TICKS || mem.wanderX === null) {
      pickWander(border, cx, cy, rng, mem);
      mem.wanderTick = tick;
    }
    goalX = mem.wanderX;
    goalY = mem.wanderY;
  }

  // Steer around viruses that would pop one of our cells (not while splitting at prey: the split already flies).
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
    if (pushX !== 0 || pushY !== 0) {
      const ux = dist > 0 ? dx / dist : 0;
      const uy = dist > 0 ? dy / dist : 0;
      const pl = Math.hypot(pushX, pushY);
      dx = ux + (pushX / pl) * T.VIRUS_PUSH;
      dy = uy + (pushY / pl) * T.VIRUS_PUSH;
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
    tx = clampToBorder(tx, border.minX, border.maxX);
    ty = clampToBorder(ty, border.minY, border.maxY);
  }
  // Never team: a bot never ejects (ejecting only ever feeds someone else).
  return { tx: Math.round(tx), ty: Math.round(ty), split, eject: false };
}

// How far a point lies outside the border shrunk by WALL_MARGIN on every side (0 inside).
function outsideInset(x, y, border) {
  const ox = Math.max(border.minX + T.WALL_MARGIN - x, 0, x - (border.maxX - T.WALL_MARGIN));
  const oy = Math.max(border.minY + T.WALL_MARGIN - y, 0, y - (border.maxY - T.WALL_MARGIN));
  return ox + oy;
}

function wantSplit(own, prey, others, laws, mem, tick) {
  if (mem.lastSplitTick !== null && tick - mem.lastSplitTick < T.SPLIT_COOLDOWN_TICKS) return false;
  if (own.length > T.SPLIT_MAX_OWN_CELLS || own.length >= laws.L9.value) return false;
  // Some cell must reach and swallow the prey with its launched piece.
  let hits = false;
  for (const m of own) {
    const range = splitKillRange(m.size, prey.size, laws);
    if (range === null) continue;
    const d = Math.hypot(prey.x - m.x, prey.y - m.y);
    if (d <= range * T.SPLIT_REACH_FACTOR) {
      hits = true;
      break;
    }
  }
  if (!hits) return false;
  // Every piece the split makes must stay safe: no other cell that could eat a piece (or split onto it) nearby.
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
      const zone = T.SPLIT_SAFE_MARGIN + (reach === null ? 0 : reach);
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

module.exports = {
  BOT_LAW_IDS,
  BOT_FILL_LAW_IDS,
  BOT_TUNING,
  BOT_NAMES,
  createBotBrain,
  botThink,
  planBotFill,
  botName,
  splitKillRange,
  canEatSize,
};
