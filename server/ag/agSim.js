'use strict';
// agar.io FFA server simulation: the deterministic world the room ticks (build brief 6, 9.1; server laws 1 to 4;
// protocol semantics 3.8 for the events the client needs).
//
// Pure: no io, no timers, no Date, no Math.random. All randomness comes from one agRng stream seeded at creation,
// and one step() is exactly one tick of L1 milliseconds. Every gameplay number is read from the law table passed in;
// this file holds none of its own. createSim refuses a table with any row it reads missing or UNKNOWN (tests run on
// test/agLawsFixture.js).
//
// Where a row names a rule rather than a number, the rule is written here as our own code from the shape the row
// describes: the approved and measured shapes of the real table (L6 'linearRamp', L29 'equalPieces', L32 grows
// 'whileUneaten' with L32_GROW 'randomStep', parity log 2026-10-02) and the older UNKNOWNS suggestion shapes the test
// FIXTURE still carries (L6 'minDistSpeed', L29 'moii', L32 grows true). A rule value this file does not implement
// throws at creation, so a table can never run on the wrong rule.
//
// Order facts the recordings settle (parity log 2026-10-02): the own-cell push (L7) runs after the border step (L3),
// so pressed pieces can sit past the edge until the next tick's border step; merges and virus feeds are plain removals,
// never eat records (U_EAT_REMOVE).
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
  'L32_GROW', 'L33', 'L34', 'L35', 'L36', 'L36_RULE', 'L38', 'U_EAT_REMOVE', 'PLAYER_COLOURS', 'LEAVE_RULE', 'Q_KEY',
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
  const s6 = v('L6'); rule('L6', s6.rule, ['minDistSpeed', 'linearRamp']);
  L.slowRule = s6.rule;
  if (s6.rule === 'linearRamp') {
    num('L6', s6.zoneSizes, 'zoneSizes'); need(s6.zoneSizes > 0, 'L6', 'zoneSizes must be above 0');
    L.slowZone = s6.zoneSizes;
  }
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
  // firstStep (measured, Owen chose the recordings): how far ahead of its parent a piece split off by Space is after
  // its first tick. Older tables have none: the piece then starts at the parent's centre.
  L.splitFirst = s11.firstStep === undefined ? null : s11.firstStep;
  if (L.splitFirst !== null) {
    num('L11', L.splitFirst, 'firstStep');
    need(L.splitFirst > 0, 'L11', 'firstStep must be above 0');
  }
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
  // Where a blob starts, measured from the cell centre along its launch line: 'centre' (0), 'cellEdge' (the cell's
  // size after the loss) or 'blobFarEdgeOnCellEdge' (that size minus the blob size: the blob's far edge on the cell's
  // edge, recorded on 8 of 8 blobs). Older tables carry fromEdge (true = 'cellEdge', false = 'centre').
  L.ejectStart = s21.start !== undefined ? s21.start : s21.fromEdge === true ? 'cellEdge' : 'centre';
  rule('L21', L.ejectStart, ['centre', 'cellEdge', 'blobFarEdgeOnCellEdge']);
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
  const s29 = v('L29'); rule('L29', s29.rule, ['moii', 'equalPieces']); num('L29', s29.minPieceMass, 'minPieceMass');
  need(s29.minPieceMass > 0, 'L29', 'minPieceMass must be above 0');
  L.popRule = s29.rule; L.popMinMass = s29.minPieceMass;
  L.virusEatRatio = v('L30'); num('L30', L.virusEatRatio, 'value');
  L.virusRgb = v('L31'); checkRgb('L31', L.virusRgb);
  const s32 = v('L32'); num('L32', s32.minSize, 'minSize'); num('L32', s32.maxSize, 'maxSize');
  rule('L32', s32.grows, [true, false, 'whileUneaten']);
  need(s32.minSize > 0 && s32.minSize <= s32.maxSize, 'L32', 'minSize must be above 0 and not above maxSize');
  L.foodMin = s32.minSize; L.foodMax = s32.maxSize; L.foodRandomSize = s32.grows === true;
  L.foodGrows = s32.grows === 'whileUneaten';
  const g32 = v('L32_GROW'); rule('L32_GROW', g32.rule, ['randomStep']);
  if (L.foodGrows) {
    num('L32_GROW', g32.chancePerTick, 'chancePerTick');
    need(g32.chancePerTick > 0 && g32.chancePerTick < 1, 'L32_GROW', 'chancePerTick must be between 0 and 1');
    num('L32_GROW', g32.stepSize, 'stepSize'); need(g32.stepSize > 0, 'L32_GROW', 'stepSize must be above 0');
    // ln(1 - chance) for the geometric wait between steps (see scheduleGrowth).
    L.growLogQ = Math.log1p(-g32.chancePerTick);
    L.growStep = g32.stepSize;
  }
  const s33 = v('L33'); rule('L33', s33.rule, ['oneFullOneLowOneRandom']);
  L.foodFull = s33.full; L.foodLow = s33.low; checkChannel('L33', s33.full); checkChannel('L33', s33.low);
  checkChannel('L33', s33.thirdMin); checkChannel('L33', s33.thirdMax);
  need(s33.thirdMin <= s33.thirdMax, 'L33', 'thirdMin must not exceed thirdMax');
  L.foodThirdMin = s33.thirdMin; L.foodThirdSpan = s33.thirdMax - s33.thirdMin + 1;
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

// Virus pop pieces, rule 'equalPieces' (server laws L29 as approved and measured: mass 325 with 15 free slots made 16
// equal pieces of 20.3, recordings agar-20261001-210803 + agar-20261001-222428): the eating cell's mass (the virus
// already in it) is shared into n = min(free + 1, floor(mass / minMass)) equal pieces, the eating cell keeping one.
// Returns the masses of the n - 1 pieces that leave it (none when n is under 2).
function equalPopPieces(mass, free, minMass) {
  if (!(free > 0)) return [];
  const n = Math.min(free + 1, Math.floor(mass / minMass));
  if (!(n >= 2)) return [];
  const out = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) out[i] = mass / n;
  return out;
}

// Exact spatial index over cell centres, rebuilt when the world has changed.
// Speed only (S2, polish/FIX-PLAN.md): once the buckets exist, a rebuild allocates nothing. Bucket arrays are kept
// between rebuilds and emptied in place with pop (the ones filled last time are listed in `used`). pop keeps each
// backing store; length = 0 can release it, which measured 0.69 MB allocated per tick in sim.step against 0.21 MB
// with pop (2026-10-08, polish/build/S2S3-alloc). Keys are small integers while both bucket indexes are inside
// +-16383 (CHOSEN packing, parity log 2026-10-08 S2/S3: at most 32767 * 32768 + 32767 = 2^30 - 1, a small integer
// on every V8 build), so the Map never stores a heap number. The map is a square of side L2 centred on (0, 0), so
// in-map bucket indexes stay within +-28 at BUCKET 256, and the second formula (the old one, for an index past
// +-16383, which means a centre more than 4,194,304 units out) is never used in practice. That fallback is not
// above every small key for every input (an index near -65536 gives a small value): the two formulas never meet
// only because real indexes are tiny. Same buckets, same order inside each bucket (cell creation order), same
// centresIn output as a fresh Map per rebuild.
function createGrid() {
  const buckets = new Map();   // key -> bucket array (kept, possibly empty)
  const used = [];             // bucket arrays filled by the last rebuild
  let maxSize = 0;
  const lo = { x: 0, y: 0 };
  const hi = { x: -1, y: -1 };
  const key = (bx, by) => (bx > -16384 && bx < 16384 && by > -16384 && by < 16384)
    ? (bx + 16384) * 32768 + (by + 16384)
    : (bx + 65536) * 131072 + (by + 65536);
  const idx = (v) => Math.floor(v / BUCKET);
  return {
    rebuild(cellMap) {
      for (let i = 0; i < used.length; i++) {
        const arr = used[i];
        while (arr.length !== 0) arr.pop();
      }
      used.length = 0;
      maxSize = 0;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const c of cellMap.values()) {
        const bx = idx(c.x);
        const by = idx(c.y);
        const k = key(bx, by);
        let arr = buckets.get(k);
        if (arr === undefined) { arr = []; buckets.set(k, arr); }
        if (arr.length === 0) used.push(arr);
        arr.push(c);
        if (c.size > maxSize) maxSize = c.size;
        if (bx < x0) x0 = bx;
        if (bx > x1) x1 = bx;
        if (by < y0) y0 = by;
        if (by > y1) y1 = by;
      }
      lo.x = x0; lo.y = y0;
      hi.x = x1; hi.y = y1;
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
//   still    a Set of player ids, owned and updated by the room: Owen's hold-Q cash-out (OWNER-ANSWERS 2026-10-08,
//            every agar room, free included). A held player's cells are not steered (moveToward is skipped; a piece
//            still flying from a split finishes its boost, own pieces keep their L7 spacing and the border step runs,
//            design 3.3.4) and its split and eject commands are refused. Empty (or absent): nothing changes, so the
//            free room, which never holds Q in the parity streams, runs exactly as before.
//   paid     paid rooms only (design 3.3): { shielded: Set, still: Set }, owned by the room's money controller. Adds
//            the money facts to the step events (money, feeds), the shield (a shielded player eats nothing and
//            nothing eats its cells), the still set above, findSpawnPoint, spawnClearOf, relocate and
//            spawn(pid, name, at). The sim stays
//            money-free: it reports who ate whose cell and how big, never an amount. Absent in every free room.
function createSim(opts) {
  const o = opts || {};
  const laws = o.laws;
  const L = readLaws(laws);
  const rng = createRng(o.seed);
  const fixedBorder = o.border !== undefined && o.border !== null;
  const refillFood = o.food !== false;
  const refillViruses = o.viruses !== false;
  const paid = o.paid && typeof o.paid === 'object' ? o.paid : null;
  if (paid && !(paid.shielded instanceof Set && paid.still instanceof Set)) {
    throw new TypeError('agSim: paid must be { shielded: Set, still: Set }');
  }
  if (o.still !== undefined && o.still !== null && !(o.still instanceof Set)) {
    throw new TypeError('agSim: still must be a Set');
  }
  const still = paid ? paid.still : o.still instanceof Set ? o.still : null;
  const shielded = paid ? paid.shielded : null;
  const isStill = (pid) => still !== null && still.size > 0 && still.has(pid);

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
  const growQueue = new Map(); // L32 'whileUneaten': tick -> ids of the food due to grow on that tick
  let inStep = false;
  const grid = createGrid();
  let gridDirty = true;
  // Mass bookkeeping (in mass units, size^2 / 100) so a soak can prove the accounting closes:
  // live mass = created - destroyed, where every destroyed entry names its cause.
  const ledger = { created: 0, decay: 0, eject: 0, eat: 0, virus: 0, cap: 0, left: 0, trim: 0 };
  let ev = newEvents();

  // The money facts (paid only, design 3.3.1) live here and nowhere else: nothing resets them at the start of a step,
  // and ev is replaced only at the end of a step that completes, so a step that throws after eats() keeps its facts
  // and the next completed step returns them together, in order.
  function newEvents() {
    const e = { tick: 0, eats: [], removed: [], added: [], newOwn: [], spawned: [], died: [], border: null,
      borderChanged: false };
    if (paid) {
      e.money = [];
      e.feeds = [];
    }
    return e;
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

  // L33: one channel full, one low, the third in [thirdMin, thirdMax], over the six channel orders.
  function foodColour() {
    const third = L.foodThirdMin + rng.int(L.foodThirdSpan);
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

  // A uniform point in the part of the map outside `inner` (a rectangle inside the border): the strip a growing map
  // has gained since the last refill.
  function stripPoint(inner) {
    const b = border;
    const w = b.maxX - b.minX;
    const ih = inner.maxY - inner.minY;
    const top = w * (inner.minY - b.minY);
    const bottom = w * (b.maxY - inner.maxY);
    const left = (inner.minX - b.minX) * ih;
    const right = (b.maxX - inner.maxX) * ih;
    let u = rng() * (top + bottom + left + right);
    const r1 = rng();
    const r2 = rng();
    if ((u -= top) < 0) return { x: b.minX + w * r1, y: b.minY + (inner.minY - b.minY) * r2 };
    if ((u -= bottom) < 0) return { x: b.minX + w * r1, y: inner.maxY + (b.maxY - inner.maxY) * r2 };
    if ((u -= left) < 0) return { x: b.minX + (inner.minX - b.minX) * r1, y: inner.minY + ih * r2 };
    return { x: inner.maxX + (b.maxX - inner.maxX) * r1, y: inner.minY + ih * r2 };
  }

  // where: the point generator (randomPoint, or a strip of a grown map); retries draw from the same place.
  function safePlace(pt, r, where) {
    const next = where || randomPoint;
    let p = pt;
    for (let i = 0; i < L.safeTries && touchesPlayer(p.x, p.y, r); i++) p = next();
    return p;
  }

  function spawnFood(where) {
    const pt = (where || randomPoint)();
    const size = L.foodRandomSize ? L.foodMin + (L.foodMax - L.foodMin) * rng() : L.foodMin;
    const c = addCell('food', pt.x, pt.y, size, foodColour(), null, '');
    ledger.created += massOf(size);
    scheduleGrowth(c);
    return c;
  }

  // L32 'whileUneaten' with L32_GROW 'randomStep': each tick an uneaten food under maxSize grows by stepSize with
  // chance chancePerTick. Drawn as the geometric wait to its next step (the same law, one draw per step instead of
  // one per food per tick): wait = 1 + floor(ln(1 - u) / ln(1 - chance)) ticks. A food made inside a step can first
  // grow on the next one; one placed between steps (the first world, debugPlace) on the next step itself.
  function scheduleGrowth(c) {
    if (!L.foodGrows || !(c.size < L.foodMax)) return;
    const wait = 1 + Math.floor(Math.log1p(-rng()) / L.growLogQ);
    c.growAt = (inStep ? tick : tick - 1) + wait;
    const due = growQueue.get(c.growAt);
    if (due) due.push(c.id); else growQueue.set(c.growAt, [c.id]);
  }

  // Phase 5b (L32 'whileUneaten'): the food due this tick grows one step, never past maxSize; food eaten this tick is
  // gone already (SIM CHOICE: growth after the eats).
  function growFood() {
    const due = growQueue.get(tick);
    if (!due) return;
    growQueue.delete(tick);
    for (const id of due) {
      const c = food.get(id);
      if (!c || c.growAt !== tick) continue;
      const before = massOf(c.size);
      c.size = Math.min(c.size + L.growStep, L.foodMax);
      ledger.created += massOf(c.size) - before;
      gridDirty = true;
      scheduleGrowth(c);
    }
  }

  function spawnVirus(where) {
    const next = where || randomPoint;
    const pt = safePlace(next(), L.virusMin, next);
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

  // While the map is still growing toward its side for n players, the food and virus counts follow the area it has
  // reached (the targets are per area, server laws 4.2), so a fresh room is never filled to its full counts while its
  // map is still small (LAW CHECK 2026-10-02, agario-reference/recordings/ours-vs-theirs.md: a fresh room grows from
  // the MAP_N_MIN side to full in about 11 s while its bots spawn, and the full counts poured into the small map left
  // 98 percent of the viruses in the inner quarter of the map, 84 percent still after 30 minutes).
  function targets() {
    if (fixedBorder) return { food: L.foodAmount, viruses: L.virusAmount, virusCap: L.virusCap };
    const n = mapCount();
    const goal = agMap.targetSide(n, laws);
    const reached = mapState.side < goal ? (mapState.side * mapState.side) / (goal * goal) : 1;
    return {
      food: Math.floor(agMap.scaledTarget(L.foodAmount, n, laws) * reached),
      viruses: Math.floor(agMap.scaledTarget(L.virusAmount, n, laws) * reached),
      virusCap: agMap.scaledTarget(L.virusCap, n, laws),
    };
  }

  // The border the last refill filled, and the fraction of a cell each kind is owed in a grown strip (carried so a
  // share under one per tick is not lost).
  let filled = null;
  const stripCarry = { food: 0, virus: 0 };

  // Tops food and viruses up to their targets. When the map has grown since the last refill, the strip it gained gets
  // its share of the targets first (target x strip area / map area), so a map that grows while it fills stays evenly
  // covered; the rest (replacing what was eaten) lands anywhere on the map.
  function refill() {
    const t = targets();
    let strip = null;
    let share = 0;
    if (filled && border.minX <= filled.minX && border.minY <= filled.minY && border.maxX >= filled.maxX &&
        border.maxY >= filled.maxY) {
      const before = (filled.maxX - filled.minX) * (filled.maxY - filled.minY);
      const now = (border.maxX - border.minX) * (border.maxY - border.minY);
      if (now > before) {
        const inner = filled;
        strip = () => stripPoint(inner);
        share = 1 - before / now;
      }
    }
    if (refillFood) fillKind(food, t.food, spawnFood, 'food', strip, share);
    if (refillViruses) fillKind(viruses, t.viruses, spawnVirus, 'virus', strip, share);
    filled = { minX: border.minX, minY: border.minY, maxX: border.maxX, maxY: border.maxY };
  }

  // The strip's share is owed until it is placed: a whole share can come due a tick before the floored target lets one
  // more in, so it waits for the next placement instead of being dropped (dropping it sent about half of a growing
  // map's viruses to random places, most of them in the middle). Owed shares are let go once the map stops growing.
  function fillKind(have, target, spawnOne, kind, strip, share) {
    if (!strip) { stripCarry[kind] = 0; } else stripCarry[kind] += target * share;
    while (have.size < target) {
      if (strip && stripCarry[kind] >= 1) { stripCarry[kind] -= 1; spawnOne(strip); } else spawnOne(randomPoint);
    }
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

  // Splits childSq (a size^2) off a player cell toward angle with the L11 boost. Refused when the parent would fall
  // under L18 (the suggestion's rule shape). Returns the child or null.
  // Where the child starts: a Space split (spaceSplit true) begins (L11 firstStep - its first boost step) ahead of the
  // parent centre along its launch line, so after this tick's boost step it is firstStep ahead of its parent, as on
  // the recorded single splits (both move the same normal step: same point, same size). Pop pieces and the L17
  // max-size split start at the centre: pop pieces were recorded 7 to 52 units out after their first update, nowhere
  // near the Space split's first step, and a max-size split was never recorded (SIM CHOICE, no number involved).
  function splitOff(p, parent, angleX, angleY, childSq, spaceSplit) {
    const childSize = Math.sqrt(childSq);
    const parentSize = Math.sqrt(parent.size * parent.size - childSq);
    if (!(parentSize >= L.minSize)) return null;
    parent.size = parentSize;
    const boost = L.splitVel * Math.pow(childSize, L.splitExp);
    const ahead = spaceSplit === true && L.splitFirst !== null ? L.splitFirst - boost / L.splitDiv : 0;
    const child = addCell('player', parent.x + angleX * ahead, parent.y + angleY * ahead, childSize, parent.rgb,
      p.pid, p.name);
    setBoost(child, boost, angleX, angleY, L.splitDiv);
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
      splitOff(p, c, dir.x, dir.y, c.size * c.size * L.splitFrac, true);
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
      const angle = Math.atan2(dir.y, dir.x) + (rng() * 2 * L.ejectSpread - L.ejectSpread);
      // The start point lies on the blob's own launch line, so the blob's path runs straight out from the cell centre.
      // On the 8 recorded blobs (angles up to 0.335 rad from the mouse) the first sighting minus the first boost step
      // sat exactly that far out (mean residual 0.00 units, analysis/ours/l21start.js); a start on the mouse line
      // would put the angled ones up to about 0.7 units short.
      const from = L.ejectStart === 'cellEdge' ? c.size : L.ejectStart === 'blobFarEdgeOnCellEdge'
        ? Math.max(0, c.size - L.blobSize) : 0;
      const x = c.x + Math.cos(angle) * from;
      const y = c.y + Math.sin(angle) * from;
      const blob = addCell('ejected', x, y, L.blobSize, c.rgb, null, '');
      blob.ejectedBy = p.pid;
      setBoost(blob, L.ejectVel, Math.cos(angle), Math.sin(angle), L.ejectDiv);
      ledger.eject += before - massOf(c.size) - massOf(blob.size);
    }
  }

  // at: a paid spawn's point from findSpawnPoint (design 3.3.5), used instead of the L35 rule's point; the paid player
  // starts at the L14 start size in its own colour, never on a blob. Free spawns never pass one.
  function doSpawn(p, at) {
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
    if (!at && blob && roll <= L.ejectSpawnChance &&
        (L.stoppedBoost === null ? blob.boost === 0 : blob.boost < L.stoppedBoost)) {
      pt = { x: blob.x, y: blob.y };
      rgb = blob.rgb.slice();
      size = Math.max(size, blob.size * L.eatRatio);
    }
    pt = at ? { x: at.x, y: at.y } : safePlace(pt, size);
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
        doSpawn(p, cmd.at);
      } else if (cmd.t === 'split') {
        if (!isStill(p.pid)) doSplit(p);       // refused while held (Owen 2026-10-08 cash-out)
      } else if (cmd.t === 'eject') {
        if (!isStill(p.pid)) doEject(p);
      } else if (cmd.t === 'clear') doClear(p);
    }
  }

  // A finished hold-Q cash-out in a free room (Owen 2026-10-08: the run simply ends): the cells go like a leave, the
  // player stays (a seat's player can press Play again), and the step reports it in died like any player whose
  // cells are gone. Never queued by anything in the parity streams.
  function doClear(p) {
    for (const c of p.cells.slice()) removeCell(c, 'left');
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

  // L5 speed and the L6 slowdown: each own cell moves straight at the target, per tick
  //   'linearRamp'    speed * min(1, distance / (zoneSizes * size)): full speed outside the zone, then a straight
  //                   line down to 0 at the target (the approved row, measured on FFA)
  //   'minDistSpeed'  min(distance, speed) (the FIXTURE suggestion)
  function moveToward(p, c) {
    const t = targetOf(p);
    if (t === null) return;
    const dx = t.x - c.x;
    const dy = t.y - c.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist === 0) return;
    const speed = L.speedCoef * Math.pow(c.size, L.speedExp) * L.speedMult;
    let step;
    if (L.slowRule === 'linearRamp') {
      const zone = L.slowZone * c.size;
      step = dist < zone ? (speed * dist) / zone : speed;
    } else {
      step = speed < dist ? speed : dist;
    }
    const move = step / dist;
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

  // Phase 4: players in join order: merge clocks, movement, boost, border, then the own-cell push, then max size.
  // The push comes after the border step (measured, parity log L3 note: own pieces pressed together went up to 7.9
  // units past the map edge and came back over the next ticks), so a pressed piece can end a tick outside its L3 box;
  // the next tick's border step brings it back.
  function movePlayers() {
    for (const p of Array.from(players.values())) {
      if (p.cells.length === 0) continue;
      const cs = p.cells.slice();
      for (const c of cs) c.canMerge = age(c) >= mergeTicks(c.size);
      const steer = !isStill(p.pid);
      for (const c of cs) {
        if (steer) moveToward(p, c);
        boostStep(c);
        keepInside(c);
      }
      if (cs.length > 1) pushOwn(cs);
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
    // The paid shield (design 3.3.3): a shielded player eats nothing (not even food or viruses), and nothing eats a
    // shielded cell. Virus feeds never go through here and cannot hurt a cell.
    if (shielded !== null && shielded.size > 0) {
      if (shielded.has(P.owner)) return false;
      if (Q.kind === 'player' && shielded.has(Q.owner)) return false;
    }
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

  // Eat: the L15 gain and the removal in the same tick (U_EAT_REMOVE 'sameBundle'). An eat between two cells of one
  // player is a merge, which their server sends as a plain removal, never an eat record (U_EAT_REMOVE, measured: 0 of
  // the merges in the recordings were in the eat list), so only eats of another cell are listed.
  function eat(P, Q) {
    if (!(Q.kind === 'player' && Q.owner === P.owner)) ev.eats.push([P.id, Q.id]);
    if (paid) moneyFact(P, Q);
    const before = massOf(P.size) + massOf(Q.size);
    P.size = Math.sqrt(P.size * P.size + L.absorb * Q.size * Q.size);
    removeCell(Q, null);
    ledger.eat += before - massOf(P.size);
  }

  // The money facts of one eat (design 3.3.2), pushed before the eaten cell is removed. Only a player cell eating
  // ANOTHER player's cell moves money (own merges go through eat() too and are excluded); the victim's size^2 sum is
  // over its live cells at this instant, the eaten one included, and last says it was the victim's only cell. An
  // ejected blob eaten by someone other than its ejector is a feed (flagged, never money).
  function moneyFact(P, Q) {
    if (Q.kind === 'player' && Q.owner !== P.owner) {
      const v = players.get(Q.owner);
      let victimSq = 0;
      let live = 0;
      if (v) {
        for (const c of v.cells) {
          if (c.dead) continue;
          victimSq += c.size * c.size;
          live++;
        }
      }
      ev.money.push({ eater: P.owner, victim: Q.owner, eatenSq: Q.size * Q.size, victimSq, last: live <= 1 });
    } else if (Q.kind === 'ejected' && Q.ejectedBy && Q.ejectedBy !== P.owner) {
      ev.feeds.push({ feeder: Q.ejectedBy, eater: P.owner, blobSq: Q.size * Q.size });
    }
  }

  // L29 pop after a player cell eats a virus: pieces leave in random directions with the split boost.
  function pop(P) {
    const p = players.get(P.owner);
    const free = L.maxCells - p.cells.length;
    if (free <= 0) return;
    const mass = massOf(P.size);
    const pieces = L.popRule === 'equalPieces' ? equalPopPieces(mass, free, L.popMinMass)
      : popPieces(mass, free, L.popMinMass);
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
        // A fed blob is a plain removal, never an eat record (U_EAT_REMOVE, measured: virus feeds are not in the
        // eat list).
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
    inStep = true;
    applyCommands();
    moveBoosted();
    decay();
    movePlayers();
    eats();
    if (L.foodGrows) growFood();
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
    inStep = false;
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

  // at (paid rooms only): a point from findSpawnPoint, both coordinates finite.
  function spawn(pid, name, at) {
    if (!players.has(pid)) return false;
    const cmd = { t: 'spawn', pid, name: typeof name === 'string' ? name : undefined };
    if (at !== undefined && at !== null) {
      if (!paid) throw new Error('agSim: a spawn point is for paid rooms only');
      if (!isFiniteNumber(at.x) || !isFiniteNumber(at.y)) throw new TypeError('agSim: spawn point must be finite');
      cmd.at = { x: at.x, y: at.y };
    }
    queue.push(cmd);
    return true;
  }

  // The cells of a player go at the next step and the player stays (a free room's finished hold-Q cash-out).
  function clearCells(pid) {
    if (!players.has(pid)) return false;
    queue.push({ t: 'clear', pid });
    return true;
  }

  // Paid safe spawn (design 3.3.5): up to `tries` uniform points of the map; a point is clear when every live cell of
  // a player that could eat a cell of `size` (L23 eatRatio) has its centre at least (its size + size + clear) away.
  // Returns the first clear point, or null. Paid rooms only (the free room never draws these rng values).
  function findSpawnPoint(size, clear, tries) {
    if (!paid) throw new Error('agSim: findSpawnPoint is for paid rooms only');
    if (!isFiniteNumber(size) || size <= 0 || !isFiniteNumber(clear) || clear < 0 || !Number.isInteger(tries) || tries < 1) {
      throw new TypeError('agSim: findSpawnPoint needs a size above 0, a clearance of 0 or more and whole tries');
    }
    const eaters = [];
    for (const c of playerCells.values()) {
      if (!c.dead && c.size >= L.eatRatio * size) eaters.push(c);
    }
    for (let i = 0; i < tries; i++) {
      const pt = randomPoint();
      let ok = true;
      for (const c of eaters) {
        const dx = c.x - pt.x;
        const dy = c.y - pt.y;
        const need = c.size + size + clear;
        if (dx * dx + dy * dy < need * need) {
          ok = false;
          break;
        }
      }
      if (ok) return pt;
    }
    return null;
  }

  // Paid rooms only (review fix, spawn camping): is the one cell of `pid` still clear by findSpawnPoint's rule, with
  // its own size, of every live cell of ANOTHER player that could eat it? A shielded newcomer is checked again when it
  // readies, because a bigger cell may have parked on it while the shield was up.
  function spawnClearOf(pid, clear) {
    if (!paid) throw new Error('agSim: spawnClearOf is for paid rooms only');
    const p = players.get(pid);
    if (!p || p.cells.length !== 1) return false;
    const me = p.cells[0];
    for (const c of playerCells.values()) {
      if (c.dead || c.owner === pid || c.size < L.eatRatio * me.size) continue;
      const dx = c.x - me.x;
      const dy = c.y - me.y;
      const need = c.size + me.size + clear;
      if (dx * dx + dy * dy < need * need) return false;
    }
    return true;
  }

  // Paid rooms only, between steps: moves the one cell of a shielded, still newcomer to `at` (a point from
  // findSpawnPoint) and points its target there, so the player starts clear. False when the player has not exactly
  // one cell. Never queued by a free room.
  function relocate(pid, at) {
    if (!paid) throw new Error('agSim: relocate is for paid rooms only');
    if (inStep) throw new Error('agSim: relocate runs between steps only');
    if (!at || !isFiniteNumber(at.x) || !isFiniteNumber(at.y)) throw new TypeError('agSim: relocate needs a finite point');
    const p = players.get(pid);
    if (!p || p.cells.length !== 1) return false;
    const c = p.cells[0];
    c.x = at.x;
    c.y = at.y;
    p.target = { x: at.x, y: at.y };
    gridDirty = true;
    return true;
  }

  // The money facts no completed step has returned yet (design 3.3.6), for an emergency close or a shutdown while
  // steps keep throwing; they are cleared so nothing is applied twice.
  function takeMoneyEvents() {
    if (!paid) return { money: [], feeds: [] };
    return { money: ev.money.splice(0, ev.money.length), feeds: ev.feeds.splice(0, ev.feeds.length) };
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
        c.bdx, c.bdy, c.bdiv, c.canMerge, c.growAt === undefined ? null : c.growAt]);
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
    if (kind === 'food') scheduleGrowth(c);
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
    clearCells,
    findSpawnPoint,
    spawnClearOf,
    relocate,
    takeMoneyEvents,
    startSize: () => L.startSize,
    eatRatio: () => L.eatRatio,
  };
}

module.exports = { createSim, SIM_LAW_IDS, popPieces, equalPopPieces };
