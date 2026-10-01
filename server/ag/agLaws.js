'use strict';
// agar.io FFA server law table (the contract every server/ag module reads).
//
// One entry per server law row L1 to L39 of the agar redo spec (server laws, section 2), the KNOWN halves of the
// rows that are only partly known, the open behaviour rows (rounding, eat removal, leaderboard, spectate) and every
// CHOSEN design number. Each entry is { id, name, value, unit, status, source }:
//   KNOWN     read from their client or config (cited by spec section), exact
//   APPROVED  an UNKNOWN that Owen approved; the source names the suggestion, the date and the parity-log line
//   CHOSEN    our own design number, labelled as ours and waiting for Owen's yes
//   UNKNOWN   not settled by their code; value is null and stays null until Owen approves a value
// A room cannot start on an UNKNOWN: modules call assertLawsComplete(laws, ids) with the ids they read, and the
// server boot calls assertShippable(LAWS). Tests use the FIXTURE table in test/agLawsFixture.js, which no shipped
// file may import.
//
// No candidate value for an UNKNOWN row lives in this file, on purpose.

const STATUS = Object.freeze({
  KNOWN: 'KNOWN',
  APPROVED: 'APPROVED',
  CHOSEN: 'CHOSEN',
  UNKNOWN: 'UNKNOWN',
  FIXTURE: 'FIXTURE',
});
const SHIPPABLE = new Set([STATUS.KNOWN, STATUS.APPROVED, STATUS.CHOSEN]);
const ALL_STATUS = new Set(Object.keys(STATUS));

// ---------------------------------------------------------------------------------------------------------------
// Size and mass (KNOWN: size on the wire is the cell radius, mass = size^2 / 100; spec protocol semantics 11,
// client render 7 mass text). The displayed mass rounds through f32 twice, exactly as their client does.

function massOf(size) {
  return (size * size) / 100;
}

function sizeOf(mass) {
  return Math.sqrt(mass * 100);
}

function displayMass(size) {
  const f = Math.fround;
  return Math.floor(f(f(size * size) / 100));
}

// ---------------------------------------------------------------------------------------------------------------
// The table.

function law(id, name, status, value, unit, source) {
  return { id, name, value, unit, status, source };
}

function unknown(id, name, unit, source) {
  return law(id, name, STATUS.UNKNOWN, null, unit, source);
}

const ENTRIES = [
  // KNOWN facts the whole server builds on.
  law('K_SIZE_UNIT', 'Size unit', STATUS.KNOWN, 'radius', 'world units; mass = size^2 / 100',
    'protocol semantics 3.1 and 11; build brief 7.2'),
  law('K_WIRE_SIZE_MAX', 'Largest size the wire can carry', STATUS.KNOWN, 32767, 'size (i16 wire cap, not a game rule)',
    'protocol semantics 3.1; server laws F2'),
  law('K_VIEW_FLOOR', 'Least area the server must send around the camera', STATUS.KNOWN, { w: 1920, h: 1080 },
    'world units at zoom 1, divided by the client zoom z', 'protocol semantics 13; server laws F5; camera-input 6.2'),

  // The world.
  unknown('L1', 'Tick length (world updates)', 'ms per tick', 'UNKNOWN: server laws L1 (PS-U5); UNKNOWNS row 1'),
  unknown('L2', 'Full map side (square)', 'world units', 'UNKNOWN: server laws L2 (PS-U2); UNKNOWNS row 2'),
  unknown('L3', 'Keeping cells inside the border', '{ radiusFactor, reflectBoost }: centre kept within ' +
    '[min + radiusFactor * size, max - radiusFactor * size] per axis', 'UNKNOWN: server laws L3; UNKNOWNS row 3'),
  unknown('L4', 'Server view range', '{ baseW, baseH, pad, ref, exp, minScale }: half width (baseW + pad) / s / 2, ' +
    's = max(pow(min(ref / sum size, 1), exp), minScale)', 'UNKNOWN: server laws L4 (PS-U6); UNKNOWNS row 4'),

  // Movement.
  unknown('L5', 'Speed vs size', '{ coef, exp, mult }: units per tick = coef * size^exp * mult',
    'UNKNOWN: server laws L5 (PS-U17); UNKNOWNS row 5'),
  unknown('L6', 'Slowdown near the cursor', '{ rule }', 'UNKNOWN: server laws L6; UNKNOWNS row 6'),
  unknown('L7', 'Own-cell collisions', '{ minAgeTicks, share }', 'UNKNOWN: server laws L7; UNKNOWNS row 7'),

  // Split and merge.
  law('L8', 'Min size to split', STATUS.KNOWN, 60, 'size (mass 36)',
    'KNOWN: config minMassToSplit (FFA) 60, a size (protocol semantics T9); client split gate agrees (PS 12.1)'),
  unknown('L8_CMP', 'Split gate comparison at the min size', "'>=' or '>'",
    'UNKNOWN: server laws L8 edge (PS-U13); UNKNOWNS row 8'),
  law('L9', 'Max own cells', STATUS.KNOWN, 16, 'cells',
    'KNOWN: config maxPlayerCells (FFA) 16; client split gate agrees (PS 12.1)'),
  unknown('L9_CAP', 'Behaviour at the cell cap', '{ extraSplits, popLimitedToFreeSlots }',
    'UNKNOWN: server laws L9 edge; UNKNOWNS row 9'),
  unknown('L10', 'Split mass division', '{ newCellMassFraction }', 'UNKNOWN: server laws L10; UNKNOWNS row 10'),
  unknown('L11', 'Split launch and decay', '{ velocity, sizeExp, decayDiv }: boost = velocity * size^sizeExp, ' +
    'each tick moves boost / decayDiv of what is left', 'UNKNOWN: server laws L11 (PS-U13); UNKNOWNS row 11'),
  unknown('L12', 'Merge time', '{ baseSec, perSizeSec }: seconds = max(baseSec, perSizeSec * size)',
    'UNKNOWN: server laws L12 (PS-U13); UNKNOWNS row 12'),
  unknown('L13', 'Merge rule', '{ rule, minAgeTicks }', 'UNKNOWN: server laws L13; UNKNOWNS row 13'),

  // Mass.
  law('L14_CFG', 'Start value in the config', STATUS.KNOWN, 10, 'unit not stated by their config',
    'KNOWN: config baseMass (FFA) 10 (server laws L14)'),
  unknown('L14', 'Start (spawn) size', 'size', 'UNKNOWN: server laws L14 unit (PS-U15); UNKNOWNS row 14'),
  unknown('L15', 'Mass gain when eating', '{ absorb }: new size = sqrt(R^2 + absorb * r^2)',
    'UNKNOWN: server laws L15; UNKNOWNS row 15'),
  unknown('L16', 'Mass decay', '{ rate, periodTicks }: mass * (1 - rate) every periodTicks, not below L18',
    'UNKNOWN: server laws L16 (PS-U17); UNKNOWNS row 16'),
  unknown('L17', 'Max size of one cell', 'size', 'UNKNOWN: server laws L17; UNKNOWNS row 17'),
  unknown('L18', 'Min size of a player cell (also the decay floor)', 'size',
    'UNKNOWN: server laws L18; UNKNOWNS row 18'),

  // Eject.
  law('L19_CFG', 'Min size to eject in the config', STATUS.KNOWN, 56.56854249, 'size (mass 32)',
    'KNOWN: config minMassToShoot (FFA) 56.56854249, a size (protocol semantics T9)'),
  law('L19_CLIENT', 'Client eject sound gate', STATUS.KNOWN, 3612.5, 'size^2 (sound when some own size^2 > this)',
    'KNOWN: client eject gate (protocol semantics 12.1); not a server rule'),
  unknown('L19', 'Min size to eject used by the server', 'size',
    'UNKNOWN: server laws L19 (PS-U14); UNKNOWNS row 19'),
  unknown('L20', 'Eject blob and loss', '{ blobSize, lossSize }: owner size^2 -= lossSize^2',
    'UNKNOWN: server laws L20 (PS-U14); UNKNOWNS row 20'),
  unknown('L21', 'Eject launch, travel and spread', '{ velocity, decayDiv, spreadRad, fromEdge }',
    'UNKNOWN: server laws L21; UNKNOWNS row 21'),
  unknown('L22', 'Eject rate limit', '{ cooldownTicks }', 'UNKNOWN: server laws L22 (CCI-U5); UNKNOWNS row 22'),

  // Eating and viruses.
  unknown('L23', 'Eat size ratio', 'radius ratio, bigger >= ratio * smaller',
    'UNKNOWN: server laws L23 (PS-U17); UNKNOWNS row 23'),
  unknown('L24', 'Eat overlap', '{ div }: eat when centre distance < R - r / div',
    'UNKNOWN: server laws L24; UNKNOWNS row 24'),
  unknown('L25', 'Virus size', '{ minSize, maxSize }', 'UNKNOWN: server laws L25 (PS-U8); UNKNOWNS row 25'),
  unknown('L26', 'Virus count on the full map', '{ amount, max }', 'UNKNOWN: server laws L26; UNKNOWNS row 26'),
  unknown('L27', 'Virus feeding until it shoots', '{ rule }', 'UNKNOWN: server laws L27; UNKNOWNS row 27'),
  unknown('L28', 'Virus shot', '{ velocity, decayDiv, direction, resetToMin }',
    'UNKNOWN: server laws L28; UNKNOWNS row 28'),
  unknown('L29', 'Virus pop pieces', '{ rule, minPieceMass }', 'UNKNOWN: server laws L29; UNKNOWNS row 29'),
  unknown('L30', 'Who can eat a virus', 'radius ratio', 'UNKNOWN: server laws L30; UNKNOWNS row 30'),
  unknown('L31', 'Virus colour', '[r, g, b]', 'UNKNOWN: server laws L31 (PS-U8); UNKNOWNS row 31'),

  // Food.
  unknown('L32', 'Food size', '{ minSize, maxSize, grows }', 'UNKNOWN: server laws L32 (PS-U8); UNKNOWNS row 32'),
  unknown('L33', 'Food colours', '{ rule, full, low }', 'UNKNOWN: server laws L33 (PS-U8); UNKNOWNS row 33'),
  unknown('L34', 'Food amount on the full map', '{ amount }', 'UNKNOWN: server laws L34; UNKNOWNS row 34'),

  // Players.
  unknown('L35', 'Spawn position rule', '{ ejectSpawnChance }', 'UNKNOWN: server laws L35 (PS-U17); UNKNOWNS row 35'),
  law('L36_RULE', 'Shape of the player colour table', STATUS.KNOWN, { full: 255, low: 7, thirdMin: 8, thirdMax: 254 },
    'one channel full, one low, the third in [thirdMin, thirdMax]',
    'KNOWN: config Cell Color table shape (protocol semantics 12.1); the table itself is never shipped'),
  unknown('L36', 'How the server picks player colours', '{ rule }', 'UNKNOWN: server laws L36 (PS-U8); UNKNOWNS row 36'),
  law('L37_CLIENT', 'Nickname cap in their name box', STATUS.KNOWN, 15, 'characters',
    'KNOWN: their name input maxlength 15 and config maxNicknameLen 15 (server laws L37)'),
  unknown('L37', 'Nickname cap on the server', 'characters (UTF-8 bytes on our wire)',
    'UNKNOWN: server laws L37 (PS-U16); UNKNOWNS row 37'),
  unknown('L38', 'Cell id allocation', '{ start, step }', 'UNKNOWN: server laws L38 (PS-U7); UNKNOWNS row 38'),
  unknown('L39', 'Players per room (also the map shrink N_FULL)', 'players',
    'UNKNOWN: server laws L39 (Q16); UNKNOWNS row 39'),

  // Open behaviour rows (protocol and HUD unknowns, UNKNOWNS rows 40 to 43).
  unknown('U_ROUND', 'Rounding of x, y, size on the wire', "'nearest' or another rule",
    'UNKNOWN: U-round; UNKNOWNS row 40'),
  unknown('U_EAT_REMOVE', 'When an eaten id is removed', "'sameBundle' or a later bundle",
    'UNKNOWN: PS-U3 / CCI-U2; UNKNOWNS row 41'),
  unknown('U_BOARD', 'Leaderboard rows and cadence', '{ rows, periodMs, ownRowWhenOutside }',
    'UNKNOWN: PS-U11 / HUD-U2, U3; UNKNOWNS row 42'),
  unknown('U_SPECTATE', 'After-death view and spectate camera', '{ afterDeath, follow, zoom }',
    'UNKNOWN: PS-U9 / CCI-U7; UNKNOWNS row 43'),

  // CHOSEN: map shrink (server laws 4; parity log C1 to C5; UNKNOWNS rows 45 to 48). FULL_SIDE is L2, N_FULL is L39.
  law('MAP_SHAPE', 'Map shape and centre', STATUS.CHOSEN, 'squareCentredOnOrigin', 'shape',
    'CHOSEN C1, waiting for Owen (UNKNOWNS row 45); server laws 4.1'),
  law('MAP_N_MIN', 'Player count at which the map stops shrinking', STATUS.CHOSEN, 4, 'players',
    'CHOSEN C1 (Paper N_BASE 4), waiting for Owen (UNKNOWNS row 45); server laws 4.1'),
  law('MAP_GROW_FRAC', 'Map grow speed', STATUS.CHOSEN, 60 / 950, 'fraction of the full side per second',
    'CHOSEN C2 (Paper 60 units/s of R_MAX 950), waiting for Owen (UNKNOWNS row 46); server laws 4.1'),
  law('MAP_SHRINK_FRAC', 'Map shrink speed', STATUS.CHOSEN, 4 / 950, 'fraction of the full side per second',
    'CHOSEN C2 (Paper 4 units/s of R_MAX 950), waiting for Owen (UNKNOWNS row 46); server laws 4.1'),
  law('MAP_SHRINK_DELAY_MS', 'Wait below target before shrinking', STATUS.CHOSEN, 3000, 'ms',
    'CHOSEN C2 (Paper SHRINK_DELAY_MS 3000), waiting for Owen (UNKNOWNS row 46); server laws 4.1'),
  law('MAP_COUNT_BOTS', 'Bots count toward the map size', STATUS.CHOSEN, true, 'boolean',
    'CHOSEN C4 (Paper rule), waiting for Owen (UNKNOWNS row 47); server laws 4.1'),
  law('MAP_EDGE_LINE', 'Line drawn at the map edge', STATUS.CHOSEN, false, 'boolean',
    'CHOSEN C5 (none, like theirs), waiting for Owen (UNKNOWNS row 48); server laws 4.3'),
  law('MAP_TARGET_ROUNDING', 'Rounding of area-scaled food and virus targets', STATUS.CHOSEN, 'floor', 'rule',
    'CHOSEN (agMap scaledTarget), waiting for Owen; server laws 4.2 gives the real-valued formula'),

  // CHOSEN: everything else that is ours (parity log C6 to C14 and PS-U4).
  law('BOT_FILL', 'Bot fill in free rooms', STATUS.CHOSEN, 'toRoomSize', 'rule',
    'CHOSEN C6 (Q17, Q18), waiting for Owen (UNKNOWNS row 49); tuning numbers live in agBots'),
  law('PHONE_STICK', 'Phone thumb stick (client side)', STATUS.CHOSEN, { deadZonePx: 10, followPx: 60 }, 'CSS px',
    'CHOSEN C7 (Q7, the slither game stick), waiting for Owen (UNKNOWNS row 50)'),
  law('SOUNDS_DEFAULT_ON', 'Sounds on by default (client side)', STATUS.CHOSEN, false, 'boolean',
    'CHOSEN C8 (Q41; theirs default off too), waiting for Owen (UNKNOWNS row 51)'),
  law('BANNER_PX', 'Bottom banner height on our page (client side)', STATUS.CHOSEN, 0, 'CSS px',
    'CHOSEN C9 (no ads), waiting for Owen (UNKNOWNS row 52); the harness page uses their 90'),
  law('WIRE_BACKLOG', 'Socket write buffer depth that skips a tick', STATUS.CHOSEN, 8, 'buffered packets',
    'CHOSEN C10, build brief 8 netcode'),
  law('SIM_RNG', 'Sim random generator', STATUS.CHOSEN, 'mulberry32', 'algorithm',
    'CHOSEN C11, server/ag/agRng.js'),
  law('LEAVE_RULE', 'What happens to a leaving player', STATUS.CHOSEN, 'removeAtOnce', 'rule',
    'CHOSEN C12 (free build), waiting for Owen (UNKNOWNS row 44)'),
  law('Q_KEY', 'Server use of the Q key in FFA', STATUS.CHOSEN, 'ignore', 'rule', 'CHOSEN C13 (CCI-U4)'),
  law('PLAYER_COLOURS', 'Player colours source', STATUS.CHOSEN, 'generatedByRule', 'rule',
    'CHOSEN C14 (legal line, Q39): made by the L36_RULE shape, never their list'),
  law('WIRE_FLAGS', 'Which cell flags our server sets', STATUS.CHOSEN,
    { agitated: false, ejectedOnBlobs: true, flag40: false, party: false }, 'flags',
    'CHOSEN (PS-U4: our server sets ejected on blobs only)'),
];

function deepFreeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(v[k]);
  }
  return v;
}

// Build a table object keyed by id from a list of entries. Throws on a malformed entry (a programming error).
function tableFrom(entries, { allowFixture = false } = {}) {
  const t = {};
  for (const e of entries) {
    validateEntry(e, allowFixture);
    if (Object.prototype.hasOwnProperty.call(t, e.id)) throw new Error('agLaws: duplicate law id ' + e.id);
    t[e.id] = { id: e.id, name: e.name, value: e.value, unit: e.unit, status: e.status, source: e.source };
  }
  return deepFreeze(t);
}

function validateEntry(e, allowFixture) {
  if (!e || typeof e !== 'object') throw new Error('agLaws: entry is not an object');
  if (typeof e.id !== 'string' || !e.id) throw new Error('agLaws: entry without an id');
  if (!ALL_STATUS.has(e.status)) throw new Error('agLaws: ' + e.id + ' has bad status ' + e.status);
  if (e.status === STATUS.FIXTURE && !allowFixture) throw new Error('agLaws: ' + e.id + ' is FIXTURE in a real table');
  if (typeof e.source !== 'string' || !e.source.trim()) throw new Error('agLaws: ' + e.id + ' has no source');
  if (typeof e.unit !== 'string' || !e.unit.trim()) throw new Error('agLaws: ' + e.id + ' has no unit');
  const isNull = e.value === null || e.value === undefined;
  if (e.status === STATUS.UNKNOWN && !isNull) throw new Error('agLaws: ' + e.id + ' is UNKNOWN but has a value');
  if (e.status !== STATUS.UNKNOWN && isNull) throw new Error('agLaws: ' + e.id + ' is ' + e.status + ' with no value');
}

const LAWS = tableFrom(ENTRIES);

// ---------------------------------------------------------------------------------------------------------------
// Checks.

function entriesOf(laws) {
  if (!laws || typeof laws !== 'object') throw new TypeError('agLaws: law table must be an object keyed by id');
  return Object.keys(laws).map((k) => laws[k]);
}

// Throws naming every id in `ids` (default: every id in the table) that is missing, UNKNOWN or has no value.
// FIXTURE entries pass (that is what lets tests run the formulas); assertShippable is the boot guard against them.
function assertLawsComplete(laws, ids) {
  entriesOf(laws);
  const need = ids === undefined ? Object.keys(laws) : ids;
  if (!Array.isArray(need)) throw new TypeError('agLaws: ids must be an array of law ids');
  const bad = [];
  for (const id of need) {
    const e = Object.prototype.hasOwnProperty.call(laws, id) ? laws[id] : null;
    if (!e) { bad.push(id + ' (missing)'); continue; }
    if (!ALL_STATUS.has(e.status)) { bad.push(id + ' (bad status ' + e.status + ')'); continue; }
    if (e.status === STATUS.UNKNOWN || e.value === null || e.value === undefined) {
      bad.push(id + (e.name ? ' (' + e.name + ')' : '') + ' is ' + (e.status === STATUS.UNKNOWN ? 'UNKNOWN' : 'empty'));
    }
  }
  if (bad.length) {
    throw new Error('agLaws: cannot start on unapproved laws, Owen must approve: ' + bad.join('; '));
  }
  return laws;
}

// The production guard: every entry approved or ours, none FIXTURE, none UNKNOWN, every source given.
function assertShippable(laws) {
  const bad = [];
  for (const e of entriesOf(laws)) {
    if (!e || !SHIPPABLE.has(e.status)) bad.push((e && e.id) + ' (' + (e && e.status) + ')');
    else if (e.value === null || e.value === undefined) bad.push(e.id + ' (no value)');
    else if (typeof e.source !== 'string' || !e.source.trim()) bad.push(e.id + ' (no source)');
  }
  if (bad.length) throw new Error('agLaws: law table is not shippable: ' + bad.join('; '));
  return laws;
}

// Reads one value, throwing if it is missing or not approved (same rule as assertLawsComplete).
function lawValue(laws, id) {
  assertLawsComplete(laws, [id]);
  return laws[id].value;
}

// A copy of a table with some values replaced ({ id: value }); statuses and sources are kept. For tests and for
// wiring an approval in before it is written into the table.
function withValues(laws, patch) {
  const out = [];
  for (const e of entriesOf(laws)) {
    const has = Object.prototype.hasOwnProperty.call(patch, e.id);
    out.push(Object.assign({}, e, has ? { value: patch[e.id] } : null));
  }
  for (const id of Object.keys(patch)) {
    if (!Object.prototype.hasOwnProperty.call(laws, id)) throw new Error('agLaws: withValues on unknown id ' + id);
  }
  // Validation is skipped here on purpose: a test may set a value to null to prove the checks catch it.
  const t = {};
  for (const e of out) t[e.id] = e;
  return deepFreeze(t);
}

function statusCounts(laws) {
  const c = { KNOWN: 0, APPROVED: 0, CHOSEN: 0, UNKNOWN: 0, FIXTURE: 0 };
  for (const e of entriesOf(laws)) if (Object.prototype.hasOwnProperty.call(c, e.status)) c[e.status]++;
  return c;
}

module.exports = {
  STATUS,
  LAWS,
  ENTRIES: deepFreeze(ENTRIES.map((e) => Object.assign({}, e))),
  tableFrom,
  assertLawsComplete,
  assertShippable,
  lawValue,
  withValues,
  statusCounts,
  massOf,
  sizeOf,
  displayMass,
};
