'use strict';
// agar.io FFA server simulation: the deterministic world the room ticks (build brief 6, 9.1; server laws 1 to 4;
// protocol semantics 3.8 for the events the client needs).
//
// Pure: no io, no timers, no Date, no Math.random. All randomness comes from one agRng stream seeded at creation,
// and one step() is exactly one tick of L1 milliseconds. Every gameplay number is read from the law table passed in;
// this file holds none of its own. Server laws their client does not reveal are UNKNOWN in server/ag/agLaws.js, so
// createSim refuses to start until Owen has approved them (tests run on test/agLawsFixture.js).
//
// Where an approved row names a rule rather than a number (L6 'minDistSpeed', L29 'moii', ...), the rule is the shape
// of the UNKNOWNS suggestion described in server laws section 3 for that row, written here as our own code. A rule
// value this file does not implement throws at creation, so a new approval can never run on the wrong rule.
//
// Rule details below that NO law row parameterises are marked "SIM CHOICE" in comments and listed in the build notes
// for Owen (order of the phases inside a tick, tie-breaks, degenerate-direction guards). None of them is a tuning
// number.
//
// Cells handed to callers (forEachCell, getCell, forEachCellInRect) are the live objects; callers must not mutate them.
//   { id, kind: 'player' | 'food' | 'virus' | 'ejected', x, y, size, rgb: [r, g, b], name, owner, ejectedBy, born }
//   owner      the player id that owns a player cell, else null (blobs are nobody's cell)
//   ejectedBy  for an ejected blob, the player id that ejected it, else null
//   born       the tick the cell was created (its age drives merge and push)

const { assertLawsComplete, massOf } = require('./agLaws');
const { createRng } = require('./agRng');
const agMap = require('./agMap');

const SIM_LAW_IDS = Object.freeze([
  'L1', 'L3', 'L5', 'L6', 'L7', 'L8', 'L8_CMP', 'L9', 'L9_CAP', 'L10', 'L11', 'L12', 'L13', 'L14', 'L15', 'L16',
  'L17', 'L18', 'L19', 'L20', 'L21', 'L22', 'L23', 'L24', 'L25', 'L26', 'L27', 'L28', 'L29', 'L30', 'L31', 'L32',
  'L33', 'L34', 'L35', 'L36', 'L36_RULE', 'L38', 'U_EAT_REMOVE', 'PLAYER_COLOURS', 'LEAVE_RULE', 'Q_KEY',
].concat(agMap.MAP_LAW_IDS.filter((id) => id !== 'L3')));

const TWO_32 = 4294967296;
const TAU = 2 * Math.PI;
// The six ways to lay three channel values onto r, g, b (colour rules L33 and L36: one full, one low, one other).
const ARRANGEMENTS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
// Spatial grid bucket side in world units. Performance only: every query is exact and every result list is sorted
// by id before it can change the world, so this value never changes an outcome.
const BUCKET = 256;

function fail(msg) {
  throw new Error('agSim: ' + msg);
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function need(cond, id, what) {
  if (!cond) fail('law ' + id + ' ' + what);
}

// Checks every law value this file reads and every rule name it implements; returns a flat config.
function readLaws(laws) {
  assertLawsComplete(laws, SIM_LAW_IDS);
  const v = (id) => laws[id].value;
  const num = (id, x, what) => need(isFiniteNumber(x), id, what + ' must be a finite number');
  const rule = (id, x, ok) => need(ok.indexOf(x) >= 0, id, 'rule ' + JSON.stringify(x) + ' is not implemented');

  const L = {};
  L.tickMs = v('L1'); num('L1', L.tickMs, 'value'); need(L.tickMs > 0, 'L1', 'must be positive');
  L.reflect = v('L3').reflectBoost === true;
  const s5 = v('L5'); num('L5', s5.coef, 'coef'); num('L5', s5.exp, 'exp'); num('L5', s5.mult, 'mult');
  L.speedCoef = s5.coef; L.speedExp = s5.exp; L.speedMult = s5.mult;
  rule('L6', v('L6').rule, ['minDistSpeed']);
  const s7 = v('L7'); num('L7', s7.minAgeTicks, 'minAgeTicks'); rule('L7', s7.share, ['otherSizeSq']);
  L.pushMinAge = s7.minAgeTicks;
  L.splitMin = v('L8'); num('L8', L.splitMin, 'value');
  L.splitCmp = v('L8_CMP'); rule('L8_CMP', L.splitCmp, ['>=', '>']);
  L.maxCells = v('L9'); need(Number.isInteger(L.maxCells) && L.maxCells > 0, 'L9', 'must be a positive integer');
  const cap = v('L9_CAP');
  rule('L9_CAP', cap.extraSplits, ['ignored']);
  rule('L9_CAP', cap.popLimitedToFreeSlots, [true]);
  L.splitFrac = v('L10').newCellMassFraction; num('L10', L.splitFrac, 'newCellMassFraction');
  need(L.splitFrac > 0 && L.splitFrac < 1, 'L10', 'newCellMassFraction must be between 0 and 1');
  const s11 = v('L11'); num('L11', s11.velocity, 'velocity'); num('L11', s11.sizeExp, 'sizeExp');
  num('L11', s11.decayDiv, 'decayDiv'); need(s11.decayDiv > 1, 'L11', 'decayDiv must be above 1');
  L.splitVel = s11.velocity; L.splitExp = s11.sizeExp; L.splitDiv = s11.decayDiv;
  const s12 = v('L12'); num('L12', s12.baseSec, 'baseSec'); num('L12', s12.perSizeSec, 'perSizeSec');
  L.mergeBaseSec = s12.baseSec; L.mergePerSizeSec = s12.perSizeSec;
  const s13 = v('L13'); rule('L13', s13.rule, ['eatOverlapNoRatio']); num('L13', s13.minAgeTicks, 'minAgeTicks');
  L.mergeMinAge = s13.minAgeTicks;
  L.startSize = v('L14'); num('L14', L.startSize, 'value'); need(L.startSize > 0, 'L14', 'must be positive');
  L.absorb = v('L15').absorb; num('L15', L.absorb, 'absorb');
  const s16 = v('L16'); num('L16', s16.rate, 'rate');
  need(Number.isInteger(s16.periodTicks) && s16.periodTicks > 0, 'L16', 'periodTicks must be a positive integer');
  L.decayRate = s16.rate; L.decayPeriod = s16.periodTicks;
  L.maxSize = v('L17'); num('L17', L.maxSize, 'value');
  L.minSize = v('L18'); num('L18', L.minSize, 'value');
  L.ejectMin = v('L19'); num('L19', L.ejectMin, 'value');
  const s20 = v('L20'); num('L20', s20.blobSize, 'blobSize'); num('L20', s20.lossSize, 'lossSize');
  L.blobSize = s20.blobSize; L.lossSize = s20.lossSize;
  const s21 = v('L21'); num('L21', s21.velocity, 'velocity'); num('L21', s21.decayDiv, 'decayDiv');
  num('L21', s21.spreadRad, 'spreadRad'); need(s21.decayDiv > 1, 'L21', 'decayDiv must be above 1');
  L.ejectVel = s21.velocity; L.ejectDiv = s21.decayDiv; L.ejectSpread = s21.spreadRad;
  L.ejectFromEdge = s21.fromEdge === true;
  L.ejectCooldown = v('L22').cooldownTicks; num('L22', L.ejectCooldown, 'cooldownTicks');
  L.eatRatio = v('L23'); num('L23', L.eatRatio, 'value');
  L.eatDiv = v('L24').div; num('L24', L.eatDiv, 'div'); need(L.eatDiv !== 0, 'L24', 'div must not be 0');
  const s25 = v('L25'); num('L25', s25.minSize, 'minSize'); num('L25', s25.maxSize, 'maxSize');
  L.virusMin = s25.minSize; L.virusMax = s25.maxSize;
  const s26 = v('L26'); num('L26', s26.amount, 'amount'); num('L26', s26.max, 'max');
  L.virusAmount = s26.amount; L.virusCap = s26.max;
  rule('L27', v('L27').rule, ['area']);
  const s28 = v('L28'); num('L28', s28.velocity, 'velocity'); num('L28', s28.decayDiv, 'decayDiv');
  rule('L28', s28.direction, ['lastBlob']); need(s28.decayDiv > 1, 'L28', 'decayDiv must be above 1');
  L.shotVel = s28.velocity; L.shotDiv = s28.decayDiv; L.shotReset = s28.resetToMin === true;
  const s29 = v('L29'); rule('L29', s29.rule, ['moii']); num('L29', s29.minPieceMass, 'minPieceMass');
  L.popMinMass = s29.minPieceMass;
  L.virusEatRatio = v('L30'); num('L30', L.virusEatRatio, 'value');
  L.virusRgb = v('L31'); checkRgb('L31', L.virusRgb);
  const s32 = v('L32'); num('L32', s32.minSize, 'minSize'); num('L32', s32.maxSize, 'maxSize');
  L.foodMin = s32.minSize; L.foodMax = s32.maxSize; L.foodRandomSize = s32.grows === true;
  const s33 = v('L33'); rule('L33', s33.rule, ['oneFullOneLowOneRandom']);
  L.foodFull = s33.full; L.foodLow = s33.low; checkChannel('L33', s33.full); checkChannel('L33', s33.low);
  L.foodAmount = v('L34').amount; num('L34', L.foodAmount, 'amount');
  const s35 = v('L35'); num('L35', s35.ejectSpawnChance, 'ejectSpawnChance');
  L.ejectSpawnChance = s35.ejectSpawnChance;
  // Optional parts of the L35 rule shape that the suggestion row does not carry yet (build notes, requests).
  L.stoppedBoost = s35.stoppedBoost === undefined ? null : s35.stoppedBoost;
  if (L.stoppedBoost !== null) num('L35', L.stoppedBoost, 'stoppedBoost');
  L.safeTries = s35.safeTries === undefined ? 0 : s35.safeTries;
  need(Number.isInteger(L.safeTries) && L.safeTries >= 0, 'L35', 'safeTries must be a whole number');
  rule('L36', v('L36').rule, ['tableShape']);
  rule('PLAYER_COLOURS', v('PLAYER_COLOURS'), ['generatedByRule']);
  const shape = v('L36_RULE');
  checkChannel('L36_RULE', shape.full); checkChannel('L36_RULE', shape.low);
  checkChannel('L36_RULE', shape.thirdMin); checkChannel('L36_RULE', shape.thirdMax);
  need(shape.thirdMin <= shape.thirdMax, 'L36_RULE', 'thirdMin must not exceed thirdMax');
  L.playerFull = shape.full; L.playerLow = shape.low; L.playerThirdMin = shape.thirdMin;
  L.playerThirdSpan = shape.thirdMax - shape.thirdMin + 1;
  const s38 = v('L38');
  need(Number.isInteger(s38.start) && s38.start > 0 && s38.start < TWO_32, 'L38', 'start must be a u32 above 0');
  need(Number.isInteger(s38.step) && s38.step > 0 && s38.step < TWO_32, 'L38', 'step must be a positive u32');
  L.idStart = s38.start; L.idStep = s38.step;
  rule('U_EAT_REMOVE', v('U_EAT_REMOVE'), ['sameBundle']);
  rule('LEAVE_RULE', v('LEAVE_RULE'), ['removeAtOnce']);
  rule('Q_KEY', v('Q_KEY'), ['ignore']);
  return L;
}

function checkChannel(id, c) {
  need(Number.isInteger(c) && c >= 0 && c <= 255, id, 'colour channels must be integers 0 to 255');
}

function checkRgb(id, rgb) {
  need(Array.isArray(rgb) && rgb.length === 3, id, 'must be [r, g, b]');
  for (const c of rgb) checkChannel(id, c);
}

// Virus pop pieces, rule 'moii' (server laws L29, the suggestion's default branch pair as corrected by the critic):
// masses of the pieces that leave the eating cell, given its mass and its free cell slots.
//   mass / free < minMass: count doubles from 2 while mass / count > minMass and 2 * count < free; then `count`
//                          pieces of mass / (count + 1) each.
//   otherwise:             halving pieces (each halved while it is not below the mass still left), until the mass
//                          left per remaining slot falls under minMass; then the rest is shared equally.
// The list never holds more pieces than free slots: L9 (KNOWN, 16 cells) caps it (L9_CAP popLimitedToFreeSlots).
function popPieces(mass, free, minMass) {
  const out = [];
  if (!(free > 0)) return out;
  if (mass / free < minMass) {
    let count = 2;
    let piece = mass / count;
    while (piece > minMass && count * 2 < free) {
      count *= 2;
      piece = mass / count;
    }
    piece = mass / (count + 1);
    for (let i = 0; i < count; i++) out.push(piece);
  } else {
    let piece = mass / 2;
    let left = mass / 2;
    let slots = free;
    while (slots > 0) {
      slots -= 1; // slots still open after the piece this pass adds
      if (left / slots < minMass) {
        piece = left / slots;
        for (; slots > 0; slots--) out.push(piece);
        slots = -1;
      }
      while (piece >= left && slots > 0) piece /= 2;
      out.push(piece);
      left -= piece;
    }
  }
  if (out.length > free) out.length = free;
  return out;
}

// Exact spatial index over cell centres, rebuilt when the world has changed.
function createGrid() {
  const buckets = new Map();
  let maxSize = 0;
  let lo = { x: 0, y: 0 };
  let hi = { x: -1, y: -1 };
  const key = (bx, by) => (bx + 65536) * 131072 + (by + 65536);
  const idx = (v) => Math.floor(v / BUCKET);
  return {
    rebuild(cellMap) {
      buckets.clear();
      maxSize = 0;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const c of cellMap.values()) {
        const bx = idx(c.x);
        const by = idx(c.y);
        const k = key(bx, by);
        const arr = buckets.get(k);
        if (arr) arr.push(c); else buckets.set(k, [c]);
        if (c.size > maxSize) maxSize = c.size;
        if (bx < x0) x0 = bx;
        if (bx > x1) x1 = bx;
        if (by < y0) y0 = by;
        if (by > y1) y1 = by;
      }
      lo = { x: x0, y: y0 };
      hi = { x: x1, y: y1 };
    },
    maxSize() {
      return maxSize;
    },
    // Cells whose centre lies in the closed rectangle, appended to out (bucket order; callers sort when it matters).
    centresIn(minX, minY, maxX, maxY, out) {
      if (!(minX <= maxX && minY <= maxY)) return out;
      const bx0 = Math.max(idx(minX), lo.x);
      const bx1 = Math.min(idx(maxX), hi.x);
      const by0 = Math.max(idx(minY), lo.y);
      const by1 = Math.min(idx(maxY), hi.y);
      for (let bx = bx0; bx <= bx1; bx++) {
        for (let by = by0; by <= by1; by++) {
          const arr = buckets.get(key(bx, by));
          if (!arr) continue;
          for (const c of arr) {
            if (c.x >= minX && c.x <= maxX && c.y >= minY && c.y <= maxY) out.push(c);
          }
        }
      }
      return out;
    },
  };
}

const byId = (a, b) => a.id - b.id;

// createSim({ laws, seed, border?, food?, viruses? })
//   laws     the law table (LAWS once Owen has approved every row; the FIXTURE table in tests)
//   seed     finite number for agRng
//   border   omitted: the map follows the CHOSEN shrink rule (agMap, server laws 4) from the live player count;
//            { minX, minY, maxX, maxY }: a fixed border (tests, tools), food and virus targets at their full amounts
//   food, viruses   false turns the refill of that kind off (tests that need an empty world); default true
function createSim(opts) {
  const o = opts || {};
  const laws = o.laws;
  const L = readLaws(laws);
  const rng = createRng(o.seed);
  const fixedBorder = o.border !== undefined && o.border !== null;
  const refillFood = o.food !== false;
  const refillViruses = o.viruses !== false;

  let mapState = null;
  let border;
  if (fixedBorder) {
    const b = o.border;
    for (const k of ['minX', 'minY', 'maxX', 'maxY']) {
      if (!isFiniteNumber(b[k])) throw new TypeError('agSim: border.' + k + ' must be a finite number');
    }
    if (!(b.minX < b.maxX && b.minY < b.maxY)) throw new RangeError('agSim: border must have min below max');
    border = { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY };
  } else {
    mapState = agMap.createMapState(laws, 0);
    border = agMap.borderFor(mapState.side);
  }

  let tick = 0;
  let nextId = L.idStart;
  let nextPid = 1;
  const cells = new Map();     // every live cell, creation order
  const playerCells = new Map();
  const food = new Map();
  const viruses = new Map();
  const ejected = new Map();
  const movers = new Map();    // non-player cells with boost left
  const players = new Map();   // pid -> player, join order
  const queue = [];            // commands, applied at the start of the next step in arrival order
  const grid = createGrid();
  let gridDirty = true;
  // Mass bookkeeping (in mass units, size^2 / 100) so a soak can prove the accounting closes:
  // live mass = created - destroyed, where every destroyed entry names its cause.
  const ledger = { created: 0, decay: 0, eject: 0, eat: 0, virus: 0, cap: 0, left: 0, trim: 0 };
  let ev = newEvents();

  function newEvents() {
    return { tick: 0, eats: [], removed: [], added: [], newOwn: [], spawned: [], died: [], border: null,
      borderChanged: false };
  }

  function kindMap(kind) {
    return kind === 'player' ? playerCells : kind === 'food' ? food : kind === 'virus' ? viruses : ejected;
  }

  function allocId() {
    for (;;) {
      const id = nextId;
      nextId = (nextId + L.idStep) % TWO_32;
      if (id !== 0 && !cells.has(id)) return id;
    }
  }

  function arrange(full, low, third) {
    const vals = [full, low, third];
    const a = ARRANGEMENTS[rng.int(ARRANGEMENTS.length)];
    return [vals[a[0]], vals[a[1]], vals[a[2]]];
  }

  function foodColour() {
    const third = rng.int(256);
    return arrange(L.foodFull, L.foodLow, third);
  }

  function playerColour() {
    const third = L.playerThirdMin + rng.int(L.playerThirdSpan);
    return arrange(L.playerFull, L.playerLow, third);
  }

  function addCell(kind, x, y, size, rgb, owner, name) {
    const c = {
      id: allocId(), kind, x, y, size, rgb, name: name || '', owner: owner || null, ejectedBy: null, born: tick,
      boost: 0, bdx: 0, bdy: 0, bdiv: 0, canMerge: false,
    };
    cells.set(c.id, c);
    kindMap(kind).set(c.id, c);
    if (c.owner !== null) {
      players.get(c.owner).cells.push(c);
      ev.newOwn.push([c.owner, c.id]);
    }
    ev.added.push(c.id);
    // Every new non-food cell starts inside the L3 box (SIM CHOICE: random spawn points and edge blobs included).
    if (kind !== 'food') agMap.pushInside(c, border, laws);
    gridDirty = true;
    return c;
  }

  function setBoost(c, distance, dx, dy, div) {
    c.boost = distance;
    c.bdx = dx;
    c.bdy = dy;
    c.bdiv = div;
    if (c.kind !== 'player' && distance > 0) movers.set(c.id, c);
  }

  function removeCell(c, cause) {
    if (!cells.delete(c.id)) return;
    kindMap(c.kind).delete(c.id);
    movers.delete(c.id);
    c.dead = true;
    if (c.owner !== null) {
      const p = players.get(c.owner);
      if (p) {
        const i = p.cells.indexOf(c);
        if (i >= 0) p.cells.splice(i, 1);
      }
    }
    if (cause) ledger[cause] += massOf(c.size);
    ev.removed.push(c.id);
    gridDirty = true;
  }

  function freshGrid() {
    if (gridDirty) {
      grid.rebuild(cells);
      gridDirty = false;
    }
    return grid;
  }

  function randomPoint() {
    const x = border.minX + (border.maxX - border.minX) * rng();
    const y = border.minY + (border.maxY - border.minY) * rng();
    return { x, y };
  }

  // True when a circle's bounding box overlaps some player cell's bounding box (the safe-spawn test of the L35
  // rule shape; used only when the approved L35 row carries safeTries).
  function touchesPlayer(x, y, r) {
    const g = freshGrid();
    const reach = r + g.maxSize();
    const near = g.centresIn(x - reach, y - reach, x + reach, y + reach, []);
    for (const c of near) {
      if (c.kind !== 'player' || c.dead) continue;
      if (c.x + c.size >= x - r && c.x - c.size <= x + r && c.y + c.size >= y - r && c.y - c.size <= y + r) return true;
    }
    return false;
  }

  function safePlace(pt, r) {
    let p = pt;
    for (let i = 0; i < L.safeTries && touchesPlayer(p.x, p.y, r); i++) p = randomPoint();
    return p;
  }

  function spawnFood() {
    const pt = randomPoint();
    const size = L.foodRandomSize ? L.foodMin + (L.foodMax - L.foodMin) * rng() : L.foodMin;
    const c = addCell('food', pt.x, pt.y, size, foodColour(), null, '');
    ledger.created += massOf(size);
    return c;
  }

  function spawnVirus() {
    const pt = safePlace(randomPoint(), L.virusMin);
    const c = addCell('virus', pt.x, pt.y, L.virusMin, L.virusRgb.slice(), null, '');
    ledger.created += massOf(c.size);
    return c;
  }

  // Number of players with cells, as the map counts them (MAP_COUNT_BOTS decides whether bots count).
  function mapCount() {
    let humans = 0;
    let bots = 0;
    for (const p of players.values()) {
      if (p.cells.length === 0) continue;
      if (p.bot) bots++; else humans++;
    }
    return agMap.countForMap(humans, bots, laws);
  }

  function targets() {
    if (fixedBorder) return { food: L.foodAmount, viruses: L.virusAmount, virusCap: L.virusCap };
    const n = mapCount();
    return {
      food: agMap.scaledTarget(L.foodAmount, n, laws),
      viruses: agMap.scaledTarget(L.virusAmount, n, laws),
      virusCap: agMap.scaledTarget(L.virusCap, n, laws),
    };
  }

  function refill() {
    const t = targets();
    if (refillFood) while (food.size < t.food) spawnFood();
    if (refillViruses) while (viruses.size < t.viruses) spawnVirus();
  }

  // Keeps a moving cell inside the border by the L3 rule and reflects its boost on the clamped axes.
  function keepInside(c) {
    const mask = agMap.pushInside(c, border, laws);
    if (mask && L.reflect) {
      if (mask & agMap.PUSHED_X) c.bdx = -c.bdx;
      if (mask & agMap.PUSHED_Y) c.bdy = -c.bdy;
    }
  }

  // One tick of boost (L11, L21, L28 shape): the cell moves boost / div along its boost direction and that much is
  // spent. A boost that can no longer shrink in floating point is finished (SIM CHOICE, no number involved).
  function boostStep(c) {
    if (c.boost <= 0) return;
    const d = c.boost / c.bdiv;
    const left = c.boost - d;
    c.x += c.bdx * d;
    c.y += c.bdy * d;
    c.boost = left === c.boost ? 0 : left;
  }

  function age(c) {
    return tick - c.born;
  }

  // L12: merging allowed once the cell is max(baseSec, perSizeSec * size) seconds old, in ticks of L1 ms.
  function mergeTicks(size) {
    return (Math.max(L.mergeBaseSec, L.mergePerSizeSec * size) * 1000) / L.tickMs;
  }

  function canSplitSize(size) {
    return L.splitCmp === '>=' ? size >= L.splitMin : size > L.splitMin;
  }

  function targetOf(p) {
    if (p.target === null) return null;
    const t = p.target;
    // The client clamps its target to the border (server laws F3); the server applies the same clamp so a
    // modified client cannot ask for more.
    return {
      x: t.x < border.minX ? border.minX : t.x > border.maxX ? border.maxX : t.x,
      y: t.y < border.minY ? border.minY : t.y > border.maxY ? border.maxY : t.y,
    };
  }

  // Splits childSq (a size^2) off a player cell toward angle; the child starts at the parent's centre with the L11
  // boost. Refused when the parent would fall under L18 (the suggestion's rule shape). Returns the child or null.
  function splitOff(p, parent, angleX, angleY, childSq) {
    const childSize = Math.sqrt(childSq);
    const parentSize = Math.sqrt(parent.size * parent.size - childSq);
    if (!(parentSize >= L.minSize)) return null;
    parent.size = parentSize;
    const child = addCell('player', parent.x, parent.y, childSize, parent.rgb, p.pid, p.name);
    setBoost(child, L.splitVel * Math.pow(childSize, L.splitExp), angleX, angleY, L.splitDiv);
    return child;
  }

  function directionTo(p, c) {
    const t = targetOf(p);
    if (t === null) return { x: 1, y: 0 };
    const dx = t.x - c.x;
    const dy = t.y - c.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    // A target exactly on the centre gives no direction: use +x (SIM CHOICE, a guard only).
    if (d === 0) return { x: 1, y: 0 };
    return { x: dx / d, y: dy / d };
  }

  function doSplit(p) {
    const list = p.cells.slice();
    for (const c of list) {
      if (c.dead) continue;
      if (p.cells.length >= L.maxCells) continue; // L9 cap, extra splits ignored (L9_CAP)
      if (!canSplitSize(c.size)) continue;
      const dir = directionTo(p, c);
      splitOff(p, c, dir.x, dir.y, c.size * c.size * L.splitFrac);
    }
  }

  function doEject(p) {
    if (p.lastEject !== null && tick - p.lastEject < L.ejectCooldown) return;
    p.lastEject = tick;
    const list = p.cells.slice();
    for (const c of list) {
      if (c.dead || c.size < L.ejectMin) continue;
      const newSq = c.size * c.size - L.lossSize * L.lossSize;
      if (newSq < L.minSize * L.minSize) continue;
      const before = massOf(c.size);
      c.size = Math.sqrt(newSq);
      const dir = directionTo(p, c);
      const x = L.ejectFromEdge ? c.x + dir.x * c.size : c.x;
      const y = L.ejectFromEdge ? c.y + dir.y * c.size : c.y;
      const angle = Math.atan2(dir.y, dir.x) + (rng() * 2 * L.ejectSpread - L.ejectSpread);
      const blob = addCell('ejected', x, y, L.blobSize, c.rgb, null, '');
      blob.ejectedBy = p.pid;
      setBoost(blob, L.ejectVel, Math.cos(angle), Math.sin(angle), L.ejectDiv);
      ledger.eject += before - massOf(c.size) - massOf(blob.size);
    }
  }

  function doSpawn(p) {
    if (p.cells.length > 0) return;
    let rgb = playerColour();
    let pt = randomPoint();
    let size = L.startSize;
    // L35: with chance ejectSpawnChance the player starts on a stopped ejected blob, in its colour and big enough to
    // eat it (L23); the blob is picked before the chance is drawn, so both draws always happen.
    const blobs = Array.from(ejected.values());
    const pick = Math.floor(rng() * blobs.length);
    const roll = rng();
    const blob = blobs.length ? blobs[pick] : null;
    if (blob && roll <= L.ejectSpawnChance &&
        (L.stoppedBoost === null ? blob.boost === 0 : blob.boost < L.stoppedBoost)) {
      pt = { x: blob.x, y: blob.y };
      rgb = blob.rgb.slice();
      size = Math.max(size, blob.size * L.eatRatio);
    }
    pt = safePlace(pt, size);
    const c = addCell('player', pt.x, pt.y, size, rgb, p.pid, p.name);
    ledger.created += massOf(size);
    p.rgb = rgb;
    p.alive = true;
    p.target = { x: pt.x, y: pt.y };
    p.lastEject = null;
    ev.spawned.push([p.pid, c.id]);
  }

  function doLeave(p) {
    for (const c of p.cells.slice()) removeCell(c, 'left');
    players.delete(p.pid);
  }

  function applyCommands() {
    const cmds = queue.splice(0, queue.length);
    for (const cmd of cmds) {
      const p = players.get(cmd.pid);
      if (!p) continue;
      if (cmd.t === 'leave') doLeave(p);
      else if (cmd.t === 'spawn') {
        if (typeof cmd.name === 'string') p.name = cmd.name;
        doSpawn(p);
      } else if (cmd.t === 'split') doSplit(p);
      else if (cmd.t === 'eject') doEject(p);
    }
  }

  // Phase 2: blobs and viruses that still carry a boost.
  function moveBoosted() {
    for (const c of Array.from(movers.values())) {
      boostStep(c);
      keepInside(c);
      if (c.boost <= 0) movers.delete(c.id);
      gridDirty = true;
    }
  }

  // Phase 3: L16 decay of every player cell once per period, never below L18.
  function decay() {
    if ((tick + 1) % L.decayPeriod !== 0) return;
    for (const c of playerCells.values()) {
      if (c.size <= L.minSize) continue;
      let s = Math.sqrt(c.size * c.size * (1 - L.decayRate));
      if (s < L.minSize) s = L.minSize;
      ledger.decay += massOf(c.size) - massOf(s);
      c.size = s;
    }
  }

  // L7: two own cells push apart, each moving by the other cell's share of size^2, once both are minAgeTicks old
  // and while at least one of them may not merge yet.
  function pushOwn(cs) {
    for (let i = 0; i < cs.length; i++) {
      for (let j = i + 1; j < cs.length; j++) {
        const a = cs[i];
        const b = cs[j];
        if (age(a) < L.pushMinAge || age(b) < L.pushMinAge) continue;
        if (a.canMerge && b.canMerge) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d === 0) continue;
        const push = (a.size + b.size - d) / d;
        if (push <= 0) continue;
        const a2 = a.size * a.size;
        const b2 = b.size * b.size;
        const sum = a2 + b2;
        const ra = (push * a2) / sum;
        const rb = (push * b2) / sum;
        a.x -= dx * rb;
        a.y -= dy * rb;
        b.x += dx * ra;
        b.y += dy * ra;
      }
    }
  }

  // L5 speed and L6 'minDistSpeed': each own cell moves straight at the target, min(distance, speed) per tick.
  function moveToward(p, c) {
    const t = targetOf(p);
    if (t === null) return;
    const dx = t.x - c.x;
    const dy = t.y - c.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist === 0) return;
    const speed = L.speedCoef * Math.pow(c.size, L.speedExp) * L.speedMult;
    const move = (speed < dist ? speed : dist) / dist;
    c.x += dx * move;
    c.y += dy * move;
  }

  // L17: a cell at the max size splits in a random direction (L10 share) while the player has free slots, else it
  // is held at the max.
  function capSize(p, c) {
    if (c.dead || c.size < L.maxSize) return;
    if (p.cells.length >= L.maxCells) {
      ledger.cap += massOf(c.size) - massOf(L.maxSize);
      c.size = L.maxSize;
      return;
    }
    const angle = rng() * TAU;
    splitOff(p, c, Math.cos(angle), Math.sin(angle), c.size * c.size * L.splitFrac);
  }

  // Phase 4: players in join order: merge clocks, pushes, movement, boost, border, max size.
  function movePlayers() {
    for (const p of Array.from(players.values())) {
      if (p.cells.length === 0) continue;
      const cs = p.cells.slice();
      for (const c of cs) c.canMerge = age(c) >= mergeTicks(c.size);
      if (cs.length > 1) pushOwn(cs);
      for (const c of cs) {
        moveToward(p, c);
        boostStep(c);
        keepInside(c);
      }
      for (const c of cs) capSize(p, c);
    }
    gridDirty = true;
  }

  function dist(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // Overlap rule L24: the eaten centre must be closer than R - r / div.
  function overlaps(eater, prey) {
    return dist(eater, prey) < eater.size - prey.size / L.eatDiv;
  }

  // Can player cell P eat cell Q right now (server laws L13, L23, L24, L30)?
  function playerCanEat(P, Q) {
    if (Q.kind === 'player') {
      if (Q.owner === P.owner) {
        // Merge (L13): both past their merge time and both minAgeTicks old, no size ratio; the bigger cell eats,
        // and on equal sizes the older one (SIM CHOICE tie-break).
        if (!(P.size > Q.size || (P.size === Q.size && P.id < Q.id))) return false;
        if (!P.canMerge || !Q.canMerge) return false;
        if (age(P) < L.mergeMinAge || age(Q) < L.mergeMinAge) return false;
        return overlaps(P, Q);
      }
      return P.size >= L.eatRatio * Q.size && overlaps(P, Q);
    }
    if (Q.kind === 'virus') return P.size >= L.virusEatRatio * Q.size && overlaps(P, Q);
    return P.size >= L.eatRatio * Q.size && overlaps(P, Q); // food and ejected blobs
  }

  // Eat: an eat event, the L15 gain, the removal in the same tick (U_EAT_REMOVE 'sameBundle').
  function eat(P, Q) {
    ev.eats.push([P.id, Q.id]);
    const before = massOf(P.size) + massOf(Q.size);
    P.size = Math.sqrt(P.size * P.size + L.absorb * Q.size * Q.size);
    removeCell(Q, null);
    ledger.eat += before - massOf(P.size);
  }

  // L29 pop after a player cell eats a virus: pieces leave in random directions with the split boost.
  function pop(P) {
    const p = players.get(P.owner);
    const free = L.maxCells - p.cells.length;
    if (free <= 0) return;
    const pieces = popPieces(massOf(P.size), free, L.popMinMass);
    for (const m of pieces) {
      const angle = rng() * TAU;
      splitOff(p, P, Math.cos(angle), Math.sin(angle), m * 100);
    }
  }

  // Phase 5: player cells eat (creation order; each eater's candidates in id order), then viruses eat blobs.
  function eats() {
    const g = freshGrid();
    for (const P of Array.from(playerCells.values())) {
      if (P.dead) continue;
      const near = g.centresIn(P.x - P.size, P.y - P.size, P.x + P.size, P.y + P.size, []).sort(byId);
      for (const Q of near) {
        if (P.dead) break;
        if (Q === P || Q.dead) continue;
        if (!playerCanEat(P, Q)) continue;
        eat(P, Q);
        if (Q.kind === 'virus') pop(P);
      }
    }
    // Viruses eat ejected blobs while the virus count is under its cap (L26 max); the virus grows by area (L27) and
    // at L25 maxSize it shoots a new virus along the blob's direction (L28) and goes back to minSize.
    const cap = targets().virusCap;
    for (const V of Array.from(viruses.values())) {
      if (V.dead) continue;
      const near = g.centresIn(V.x - V.size, V.y - V.size, V.x + V.size, V.y + V.size, []).sort(byId);
      for (const E of near) {
        if (V.dead) break;
        if (E.kind !== 'ejected' || E.dead) continue;
        if (viruses.size >= cap) break;
        if (!(V.size >= L.eatRatio * E.size && overlaps(V, E))) continue;
        ev.eats.push([V.id, E.id]);
        const before = massOf(V.size) + massOf(E.size);
        V.size = Math.sqrt(V.size * V.size + E.size * E.size);
        removeCell(E, null);
        ledger.virus += before - massOf(V.size);
        if (V.size >= L.virusMax) {
          if (L.shotReset) {
            ledger.virus += massOf(V.size) - massOf(L.virusMin);
            V.size = L.virusMin;
          }
          const shot = addCell('virus', V.x, V.y, L.virusMin, L.virusRgb.slice(), null, '');
          ledger.created += massOf(shot.size);
          setBoost(shot, L.shotVel, E.bdx, E.bdy, L.shotDiv);
        }
      }
    }
  }

  // Phase 6: the map follows the player count (dynamic border only); a shrinking border pushes cells in and
  // removes the food it leaves outside, never anything else (server laws 4.2).
  function stepMap() {
    if (fixedBorder) return;
    const next = agMap.stepSide(mapState, agMap.targetSide(mapCount(), laws), L.tickMs, laws);
    const changed = next.side !== mapState.side;
    mapState = next;
    if (!changed) return;
    border = agMap.borderFor(mapState.side);
    ev.borderChanged = true;
    for (const c of Array.from(cells.values())) {
      if (c.kind === 'food') {
        if (agMap.isOutside(c.x, c.y, border)) removeCell(c, 'trim');
      } else {
        keepInside(c);
      }
    }
    gridDirty = true;
  }

  function step() {
    ev.tick = tick;
    const aliveBefore = new Set();
    for (const p of players.values()) if (p.cells.length) aliveBefore.add(p.pid);
    applyCommands();
    moveBoosted();
    decay();
    movePlayers();
    eats();
    for (const p of players.values()) {
      if (p.alive && p.cells.length === 0) {
        p.alive = false;
        ev.died.push(p.pid);
      }
    }
    for (const pid of aliveBefore) {
      if (!players.has(pid) && ev.died.indexOf(pid) < 0) ev.died.push(pid); // left while alive
    }
    stepMap();
    refill();
    freshGrid();
    ev.border = { minX: border.minX, minY: border.minY, maxX: border.maxX, maxY: border.maxY };
    tick++;
    const out = ev;
    ev = newEvents();
    return out;
  }

  // ----------------------------------------------------------------------------------------------------------
  // Commands (queued; applied at the start of the next step in arrival order).

  function player(pid) {
    const p = players.get(pid);
    return p || null;
  }

  function addPlayer(info) {
    const i = info || {};
    const pid = nextPid++;
    players.set(pid, {
      pid, name: typeof i.name === 'string' ? i.name : '', bot: i.bot === true, alive: false,
      cells: [], target: null, lastEject: null, rgb: null,
    });
    return pid;
  }

  // A player with cells loses them at the next step (queued like every command). A player with none (a watcher
  // that never played, a dead player, a dead bot) has nothing in the world, so it goes at once together with any
  // command it queued: an idle room that runs no step can then never pile up players or commands.
  function removePlayer(pid) {
    const p = players.get(pid);
    if (!p) return false;
    if (p.cells.length === 0) {
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i].pid === pid) queue.splice(i, 1);
      players.delete(pid);
      return true;
    }
    queue.push({ t: 'leave', pid });
    return true;
  }

  function spawn(pid, name) {
    if (!players.has(pid)) return false;
    queue.push({ t: 'spawn', pid, name: typeof name === 'string' ? name : undefined });
    return true;
  }

  function split(pid) {
    if (!players.has(pid)) return false;
    queue.push({ t: 'split', pid });
    return true;
  }

  function eject(pid) {
    if (!players.has(pid)) return false;
    queue.push({ t: 'eject', pid });
    return true;
  }

  // setInput(pid, { x, y, split, eject, q }): x and y set the world target (both finite or the target is kept);
  // split / eject queue one press each; q is ignored in FFA (Q_KEY 'ignore').
  function setInput(pid, input) {
    const p = players.get(pid);
    if (!p || !input || typeof input !== 'object') return false;
    if (isFiniteNumber(input.x) && isFiniteNumber(input.y)) p.target = { x: input.x, y: input.y };
    if (input.split === true) split(pid);
    if (input.eject === true) eject(pid);
    return true;
  }

  // ----------------------------------------------------------------------------------------------------------
  // Reads.

  function forEachCell(fn) {
    for (const c of cells.values()) fn(c);
  }

  // Cells whose bounding box overlaps the rectangle (view queries, bots), in a deterministic order.
  function forEachCellInRect(minX, minY, maxX, maxY, fn) {
    const g = freshGrid();
    const m = g.maxSize();
    const near = g.centresIn(minX - m, minY - m, maxX + m, maxY + m, []);
    for (const c of near) {
      if (c.x + c.size >= minX && c.x - c.size <= maxX && c.y + c.size >= minY && c.y - c.size <= maxY) fn(c);
    }
  }

  function getCell(id) {
    return cells.get(id) || null;
  }

  function playerInfo(pid) {
    const p = players.get(pid);
    if (!p) return null;
    let score = 0;
    for (const c of p.cells) score += massOf(c.size);
    return {
      pid: p.pid, name: p.name, bot: p.bot, alive: p.alive, cells: p.cells.map((c) => c.id),
      target: p.target ? { x: p.target.x, y: p.target.y } : null, rgb: p.rgb ? p.rgb.slice() : null, score,
    };
  }

  function forEachPlayer(fn) {
    for (const pid of players.keys()) fn(playerInfo(pid));
  }

  function totalMass() {
    let m = 0;
    for (const c of cells.values()) m += massOf(c.size);
    return m;
  }

  function counts() {
    let alive = 0;
    let bots = 0;
    for (const p of players.values()) {
      if (p.cells.length) alive++;
      if (p.bot) bots++;
    }
    return { players: players.size, alive, bots, playerCells: playerCells.size, food: food.size,
      viruses: viruses.size, ejected: ejected.size, cells: cells.size };
  }

  // Full deterministic state as plain data (two sims fed the same seed and inputs give identical JSON).
  function snapshot() {
    const cs = [];
    for (const c of cells.values()) {
      cs.push([c.id, c.kind, c.x, c.y, c.size, c.rgb[0], c.rgb[1], c.rgb[2], c.owner, c.ejectedBy, c.born, c.boost,
        c.bdx, c.bdy, c.bdiv, c.canMerge]);
    }
    const ps = [];
    for (const p of players.values()) {
      ps.push({ pid: p.pid, name: p.name, bot: p.bot, alive: p.alive, cells: p.cells.map((c) => c.id),
        target: p.target ? [p.target.x, p.target.y] : null, lastEject: p.lastEject, rgb: p.rgb });
    }
    return {
      tick, rng: rng.state(), nextId, nextPid,
      border: { minX: border.minX, minY: border.minY, maxX: border.maxX, maxY: border.maxY },
      map: mapState ? { side: mapState.side, belowMs: mapState.belowMs } : null,
      queued: queue.map((q) => [q.t, q.pid]),
      ledger: Object.assign({}, ledger),
      players: ps,
      cells: cs,
    };
  }

  // ----------------------------------------------------------------------------------------------------------
  // Test and tool hooks: place a cell directly (outside any step; it shows in the next step's events).
  // { kind, x, y, size, owner?, rgb?, born?, boost?: { distance, dx, dy, div } }
  function debugPlace(spec) {
    const s = spec || {};
    const kind = s.kind || 'player';
    if (['player', 'food', 'virus', 'ejected'].indexOf(kind) < 0) throw new TypeError('agSim: bad kind ' + kind);
    for (const k of ['x', 'y', 'size']) {
      if (!isFiniteNumber(s[k])) throw new TypeError('agSim: debugPlace ' + k + ' must be a finite number');
    }
    let owner = null;
    let name = '';
    if (kind === 'player') {
      const p = players.get(s.owner);
      if (!p) throw new Error('agSim: debugPlace player cell needs an existing owner');
      owner = p.pid;
      name = p.name;
      p.alive = true;
      if (!p.rgb) p.rgb = s.rgb ? s.rgb.slice() : playerColour();
    }
    const rgb = s.rgb ? s.rgb.slice() : owner !== null ? players.get(owner).rgb : kind === 'virus'
      ? L.virusRgb.slice() : foodColour();
    const c = addCell(kind, s.x, s.y, s.size, rgb, owner, name);
    if (kind === 'ejected' && s.ejectedBy !== undefined) c.ejectedBy = s.ejectedBy;
    if (isFiniteNumber(s.born)) c.born = s.born;
    if (s.boost) setBoost(c, s.boost.distance, s.boost.dx, s.boost.dy, s.boost.div);
    ledger.created += massOf(c.size);
    return c.id;
  }

  // Initial world: food and viruses at their targets (inside the starting border).
  refill();
  freshGrid();

  return {
    SIM_LAW_IDS,
    laws,
    addPlayer,
    removePlayer,
    spawn,
    setInput,
    split,
    eject,
    step,
    snapshot,
    forEachCell,
    forEachCellInRect,
    getCell,
    playerInfo,
    forEachPlayer,
    counts,
    totalMass,
    ledger: () => Object.assign({}, ledger),
    border: () => ({ minX: border.minX, minY: border.minY, maxX: border.maxX, maxY: border.maxY }),
    tick: () => tick,
    hasPlayer: (pid) => player(pid) !== null,
    debugPlace,
  };
}

module.exports = { createSim, SIM_LAW_IDS, popPieces };
