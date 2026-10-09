'use strict';
// agar.io FFA server law table (the contract every server/ag module reads).
//
// One entry per server law row L1 to L39 of the agar redo spec (server laws, section 2), the KNOWN halves of the
// rows that are only partly known, the open behaviour rows (rounding, eat removal, leaderboard, spectate) and every
// CHOSEN design number. Each entry is { id, name, value, unit, status, source }:
//   KNOWN     read from their client or config (cited by spec section), exact
//   MEASURED  read from Owen's own recorded play on their FFA servers (both sessions pooled, FFA connections only):
//             the source names the spec row, the recordings, the 95 percent interval and the sample size; only rows
//             whose whole value was measured (parity log, 2026-10-02 final table), plus the three approval rows where
//             Owen later chose the recordings over his approved value (L11, L21, L37; OWNER-ANSWERS 2026-10-02, later:
//             their sources still name the approval row) and L32_GROW, which he accepted as measured
//   APPROVED  a row play and code could not settle, with the value Owen approved; the source says "APPROVED by Owen
//             2026-10-02", the approval row (1 to 32, the parity log's final table order) and where the approved
//             suggestion came from (tags below)
//   CHOSEN    our own design number, labelled as ours and waiting for Owen's yes
//   UNKNOWN   not settled by their code or by play and not approved; value is null. Since 2026-10-02 no row is
//             UNKNOWN (Owen approved all 32 open rows), but the status and its guards stay for any new row
// A room cannot start on an UNKNOWN: modules call assertLawsComplete(laws, ids) with the ids they read, and the
// server boot calls assertShippable(LAWS), which this table passes. A module that reads an approved rule it has not
// built yet (a rule name it does not implement) still refuses at creation. Tests use the FIXTURE table in
// test/agLawsFixture.js (fixed test numbers, never these), which no shipped file may import.

const STATUS = Object.freeze({
  KNOWN: 'KNOWN',
  MEASURED: 'MEASURED',
  APPROVED: 'APPROVED',
  CHOSEN: 'CHOSEN',
  UNKNOWN: 'UNKNOWN',
  FIXTURE: 'FIXTURE',
});
const SHIPPABLE = new Set([STATUS.KNOWN, STATUS.MEASURED, STATUS.APPROVED, STATUS.CHOSEN]);
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

// MEASURED rows: Owen's two recorded sessions on their FFA servers, agar-20261001-210803 (its FFA connections only;
// its other-type server is shown apart, never pooled) and agar-20261001-222428, pooled. Sizes on the wire are whole
// numbers rounded down, so a wire size w is a true size from w up to w + 1.
const REC = 'recordings agar-20261001-210803 + agar-20261001-222428 (FFA connections pooled)';
function measured(id, name, value, unit, source) {
  return law(id, name, STATUS.MEASURED, value, unit, 'MEASURED: ' + source + '; ' + REC);
}

// APPROVED rows: Owen answered "approve all" to the 32 open rows on 2026-10-02 (29 stay APPROVED; for rows 9, 17 and
// 29 he then chose what the recordings show, so L11, L21 and L37 are MEASURED). Each source names where the approved
// suggestion came from:
//   MEASURED    the pooled FFA recordings (FFA below), with the interval and the sample size
//   OTHER TYPE  session 1's game-type-3 server (OTHER below): never pooled into an FFA row, only a suggestion source
//   CLIENT      their client code or config, cited by spec section
//   MOII        MultiOgarII, a fan-made server, UNVERIFIED
//   CHOSEN      our own pick, shown to Owen as ours
//   OWNER       Owen's own answer to a build question
const OWEN = 'APPROVED by Owen 2026-10-02';
const FFA = 'FFA recordings agar-20261001-210803 + agar-20261001-222428';
const OTHER = 'OTHER TYPE (recording agar-20261001-210803, its type-3 server)';
function approved(row, id, name, value, unit, from) {
  return law(id, name, STATUS.APPROVED, value, unit, OWEN + ' (approval row ' + row + '); ' + from);
}

// L1: the steadiest FFA server ticked 40.014 ms (interval 40.0138 to 40.0145, 8,556 updates; a second connection to
// the same server 40.017); the other FFA servers ran 40.04 to 43.5 ms under load (slow ticks, never skipped ones).
const TICK_MS = 40.014;
// L23 and L30: the measured player eat ratio, which Owen approved for viruses too.
const EAT_RATIO = 1.17;
// L19_CLIENT and L19: their client's eject sound gate, size^2 above this.
const EJECT_GATE_SQ = 3612.5;

const ENTRIES = [
  // KNOWN facts the whole server builds on.
  law('K_SIZE_UNIT', 'Size unit', STATUS.KNOWN, 'radius', 'world units; mass = size^2 / 100',
    'protocol semantics 3.1 and 11; build brief 7.2'),
  law('K_WIRE_SIZE_MAX', 'Largest size the wire can carry', STATUS.KNOWN, 32767, 'size (i16 wire cap, not a game rule)',
    'protocol semantics 3.1; server laws F2'),
  law('K_VIEW_FLOOR', 'Least area the server must send around the camera', STATUS.KNOWN, { w: 1920, h: 1080 },
    'world units at zoom 1, divided by the client zoom z; our page also draws the rows it reports on ag:view below ' +
    'that (VIEW_BELOW), which the view adds to the box bottom', 'protocol semantics 13; server laws F5; camera-input 6.2'),

  // The world.
  measured('L1', 'Tick length (world updates)', TICK_MS, 'ms per tick',
    'server laws L1 (PS-U5): fastest FFA server 40.014 ms per update (40.0138 to 40.0145, n 8,556), every tick sent'),
  measured('L2', 'Full map side (square)', 10000 * Math.SQRT2, 'world units',
    'server laws L2 (PS-U2): 10000 x sqrt 2; the 11 FFA connections send it stretched up to 0.5 percent per axis, mean ' +
    'side 14147.9 (95 percent 14129.9 to 14165.9, n 22 axes), and the one unstretched connection sent exactly this'),
  approved(1, 'L3', 'Keeping cells inside the border', { radiusFactor: 0.5, reflectBoost: false },
    '{ radiusFactor, reflectBoost }: centre kept within [min + radiusFactor * size, max - radiusFactor * size] per axis',
    'server laws L3. radiusFactor: MEASURED, ' + FFA + ', 0.462 to 0.522 (6 cells at sizes 39 to 109, 789 pinned ' +
    'ticks; ' + OTHER + ' 0.417 to 0.583). reflectBoost: CHOSEN, no launched piece hit a wall in either session'),
  approved(2, 'L4', 'Server view range', { baseW: 1920, baseH: 1080, pad: 100.6, ref: 64, exp: 0.4, minScale: 0.0417 },
    '{ baseW, baseH, pad, ref, exp, minScale }: half width (baseW + pad) / s / 2, ' +
    's = max(pow(min(ref / sum size, 1), exp), minScale); the bottom edge alone also moves down by the rows the ' +
    'page reports below the reference view, / s (VIEW_BELOW), so the pad stays past every edge the page draws',
    'server laws L4 (PS-U6). baseW, baseH: CLIENT, their view at zoom 1 (K_VIEW_FLOOR). pad: MEASURED, ' + FFA +
    ', 102.0 +- 2.7 across, 100.4 +- 1.1 down (2,634 view boxes, 15,725 updates, own sizes adding up to 32 to 752). ' +
    'ref, exp: MEASURED, exact. minScale: CHOSEN "no floor", the scale where the box already reaches past every map ' +
    'edge (their client zoom has no floor either)'),

  // Movement.
  approved(3, 'L5', 'Speed vs size', { coef: 83.466, exp: -0.4468, mult: 1 },
    '{ coef, exp, mult }: units per tick = coef * size^exp * mult',
    'server laws L5 (PS-U17). MEASURED, ' + FFA + ': coef 82.80 to 85.60, exp -0.4519 to -0.4448 (6,701 ticks in ' +
    '140 runs, sizes 32 to 150, worst size bin 0.14 percent off; ' + OTHER + ' 83.78 x size^-0.4476); the same ' +
    'formula above size 150'),
  approved(4, 'L6', 'Slowdown near the cursor', { rule: 'linearRamp', zoneSizes: 0.651 },
    "{ rule, zoneSizes }: 'linearRamp' = full speed while the mouse is farther than zoneSizes * size from the centre, " +
    "inside that the speed falls in a straight line to 0 at the mouse; 'minDistSpeed' = step min(distance, speed)",
    'server laws L6. MEASURED, ' + FFA + ': zone 0.459 to 0.838 sizes (3,744 near-mouse ticks, 30 inside the ' +
    'zone); beats the min(distance, speed) rule by 641 BIC'),
  approved(5, 'L7', 'Own-cell collisions', { minAgeTicks: 13, share: 'otherSizeSq' },
    "{ minAgeTicks, share }: 'otherSizeSq' = each piece moves by the other piece's size^2 share (the smaller moves more)",
    'server laws L7. share: MEASURED, ' + FFA + ', best of three rules (error 0.035 against 0.045 and 0.094, 539 ' +
    'push corrections; ' + OTHER + ' agrees on 2,759). minAgeTicks 13: MOII (UNVERIFIED)'),

  // Split and merge.
  law('L8', 'Min size to split', STATUS.KNOWN, 60, 'size (mass 36)',
    'KNOWN: config minMassToSplit (FFA) 60, a size (protocol semantics T9); client split gate agrees (PS 12.1)'),
  approved(6, 'L8_CMP', 'Split gate comparison at the min size', '>=', "'>=' or '>'",
    'server laws L8 edge (PS-U13). CLIENT: their split animation check is ">= 60" (PS 12.1); MEASURED, ' + FFA +
    ': gate between 57.5 and 68 (4 splits, 8 presses that did nothing)'),
  law('L9', 'Max own cells', STATUS.KNOWN, 16, 'cells',
    'KNOWN: config maxPlayerCells (FFA) 16; client split gate agrees (PS 12.1)'),
  approved(7, 'L9_CAP', 'Behaviour at the cell cap', { extraSplits: 'ignored', popLimitedToFreeSlots: true },
    '{ extraSplits, popLimitedToFreeSlots }',
    'server laws L9 edge. ' + OTHER + ': Space at 16 cells did nothing 15 of 15 times; MEASURED, ' + FFA +
    ': a virus pop with 15 free slots made exactly 15 new pieces (1 pop)'),
  approved(8, 'L10', 'Split mass division', { newCellMassFraction: 0.5 }, '{ newCellMassFraction }',
    'server laws L10. MEASURED, ' + FFA + ': 0.5 to 0.5 (4 splits, sizes 67 to 77; ' + OTHER + ' agrees on 5)'),
  measured('L11', 'Split launch and decay', { velocity: 733.5, sizeExp: 0, decayDiv: 9.737, firstStep: 98.42 },
    '{ velocity, sizeExp, decayDiv, firstStep }: boost = velocity * size^sizeExp, each tick moves boost / decayDiv of ' +
    'what is left; a piece split off by Space is firstStep ahead of its parent after its first tick, so it begins ' +
    '(firstStep - boost / decayDiv) ahead of the parent centre along its launch line and reaches that plus the boost',
    'server laws L11 (PS-U13). Owen chose the recordings over his approved value (approval row 9; OWNER-ANSWERS ' +
    '2026-10-02, later): the first step. firstStep: on the first update of a single split with the mouse far, the ' +
    'piece sat 98.07 and 98.78 units ahead of its parent (2 single splits, sizes 47 and 54; 95 percent 93.91 to ' +
    '102.94, analysis/ours/l11first.js), not the 75.33 of velocity / decayDiv: the piece begins 23.1 ahead (15.9 to ' +
    '30.4) and reaches 756.5 in all (approved: 733.5). velocity, decayDiv: the L11 fit of the later steps, flight 695 ' +
    'to 763, decay 9.49 to 10.00 (5 launches, sizes 43 to 54), unchanged. sizeExp 0 and the first step at every size: ' +
    OTHER + ', 14 launches at sizes 43 to 83 show no size term (exponent -0.53 to 0.25) and 6 clean first steps sit ' +
    'at 97.7 to 98.7 for sizes 43 to 117 (mean 98.11, 97.11 to 99.11). The one FFA two-cell split with a clean first ' +
    'update came out at 83.1 (shown, not used: with more own cells their pushes reach the parent)'),
  approved(10, 'L12', 'Merge time', { baseSec: 30, perSizeSec: 0.2 },
    '{ baseSec, perSizeSec }: seconds = max(baseSec, perSizeSec * size)',
    'server laws L12 (PS-U13). ' + OTHER + ': base 30.20 to 30.37 s, 0.1975 to 0.2011 s per size (9 timed merges, ' +
    'counted in whole seconds there); MEASURED, ' + FFA + ': 2 timed merges at 30.07 s agree'),
  approved(11, 'L13', 'Merge rule', { rule: 'eatOverlapNoRatio', minAgeTicks: 13 },
    "{ rule, minAgeTicks }: 'eatOverlapNoRatio' = own pieces join once they overlap as deep as an eat (L24), no size " +
    'ratio, never before minAgeTicks',
    'server laws L13. rule: MEASURED, ' + FFA + ', merge threshold R - r / 2.68 to R - r / 3.17 holds the eat ' +
    'overlap (7 merges, 0 against). minAgeTicks 13: MOII (UNVERIFIED)'),

  // Mass.
  law('L14_CFG', 'Start value in the config', STATUS.KNOWN, 10, 'unit not stated by their config',
    'KNOWN: config baseMass (FFA) 10 (server laws L14)'),
  measured('L14', 'Start (spawn) size', 32, 'size',
    'server laws L14 (PS-U15): every FFA life starts at wire size 32 (5 of 6; the sixth ate on arrival), true 32 to 33 ' +
    '(mass 10.24 to 10.89, shown as 10); the first food eats keep it under 32.5'),
  approved(12, 'L15', 'Mass gain when eating', { absorb: 1 }, '{ absorb }: new size = sqrt(R^2 + absorb * r^2)',
    'server laws L15. MEASURED, ' + FFA + ': 0.941 to 1.049 (621 eats; ' + OTHER + ' 0.951 to 1.036)'),
  approved(13, 'L16', 'Mass decay', { rate: 0.001994, periodTicks: 25 },
    '{ rate, periodTicks }: mass * (1 - rate) every periodTicks, not below L18',
    'server laws L16 (PS-U17). rate: ' + OTHER + ', 0.1987 to 0.1997 percent of mass a second (23 size steps, ' +
    'sizes 42 to 179). One step every 25 updates (once a second): CHOSEN, once a second and every update look alike ' +
    'at this rate'),
  approved(14, 'L17', 'Max size of one cell', 1856, 'size',
    'server laws L17. MEASURED bound, ' + FFA + ': a cell of size 1856 (mass 34,447) was seen, so the cap is at ' +
    'least this; a fan server\'s lower cap is ruled out'),
  approved(15, 'L18', 'Min size of a player cell (also the decay floor)', 32, 'size',
    'server laws L18. MEASURED bound, ' + FFA + ': the start size (L14), also the smallest player cell seen ' +
    '(6 spawns)'),

  // Eject.
  law('L19_CFG', 'Min size to eject in the config', STATUS.KNOWN, 56.56854249, 'size (mass 32)',
    'KNOWN: config minMassToShoot (FFA) 56.56854249, a size (protocol semantics T9)'),
  law('L19_CLIENT', 'Client eject sound gate', STATUS.KNOWN, EJECT_GATE_SQ, 'size^2 (sound when some own size^2 > this)',
    'KNOWN: client eject gate (protocol semantics 12.1); not a server rule'),
  approved(16, 'L19', 'Min size to eject used by the server', Math.sqrt(EJECT_GATE_SQ), 'size',
    'server laws L19 (PS-U14). CLIENT: their eject sound gate, size^2 > 3612.5 (L19_CLIENT, PS 12.1), size 60.104; ' +
    'inside the MEASURED bracket, ' + FFA + ': ejects at 60 and up, blocked at 58 and under (14 blobs, 6 blocked ' +
    'presses, 0 against); the config gate L19_CFG lies outside it'),
  measured('L20', 'Eject blob and loss', { blobSize: 38, lossSize: 42.21 }, '{ blobSize, lossSize }: owner size^2 -= lossSize^2',
    'server laws L20 (PS-U14): blob wire size 38 on 14 of 14 blobs (true 38 to 39); the cell loses size 42.21 in ' +
    'quadrature (41.75 to 42.66, mass 17.8, n 14)'),
  measured('L21', 'Eject launch, travel and spread',
    { velocity: 819.9, decayDiv: 10.235, spreadRad: 0.391, start: 'blobFarEdgeOnCellEdge' },
    '{ velocity, decayDiv, spreadRad, start }: flight = velocity, each tick moves 1 / decayDiv of what is left, ' +
    'up to spreadRad either side of the mouse; start = where the blob begins, from the cell centre along its launch ' +
    "line: 'centre', 'cellEdge' (the size after the loss) or 'blobFarEdgeOnCellEdge' (that size minus the blob size)",
    'server laws L21. START POINT: Owen chose the recordings over his approved "from the centre" (approval row 17; ' +
    'OWNER-ANSWERS 2026-10-02, later): per blob the first sighting minus the first boost step sits (size after the ' +
    'loss - blob size) from the centre, within 1 unit on 8 of 8 blobs (mean miss 0.00, largest 0.97, sizes after the ' +
    'loss 44 to 59, analysis/ours/l21start.js); from the centre, our cells of about size 95 and up ate their own ' +
    'blob on the eject tick (law check 2026-10-02). velocity, decayDiv: flight 816.5 to 823.3, decay 10.18 to 10.30 ' +
    '(8 blob paths). spreadRad: the largest angle seen (0.335 rad) scaled up for 6 throws (0.32 to 0.59)'),
  approved(18, 'L22', 'Eject rate limit', { cooldownTicks: 3 }, '{ cooldownTicks }',
    'server laws L22 (CCI-U5). MOII 3 (UNVERIFIED), inside the MEASURED bound, ' + FFA + ': at most 5 updates ' +
    '(3 quick blobs, 0 refused presses)'),

  // Eating and viruses.
  measured('L23', 'Eat size ratio', EAT_RATIO, 'radius ratio, bigger >= ratio * smaller',
    'server laws L23 (PS-U17): 1.17 (1.111 to 1.191 with wire rounding), smallest ratio that ate 1.162, largest deep ' +
    'overlap that did not 1.150, 0 of 152 observations against'),
  approved(19, 'L24', 'Eat overlap', { div: 3.04 }, '{ div }: eat when centre distance < R - r / div',
    'server laws L24. MEASURED, ' + FFA + ': R - r / 2.84 to R - r / 3.27 (1,365 bracketed food eats; ' + OTHER +
    ' R - r / 2.96)'),
  approved(20, 'L25', 'Virus size', { minSize: 100, maxSize: sizeOf(200) },
    '{ minSize, maxSize }: a new virus is minSize; a fed virus shoots past maxSize (here mass 200)',
    'server laws L25 (PS-U8). minSize: MEASURED, ' + FFA + ', 60 of 62 new viruses. maxSize, mass 200: MOII ' +
    '(UNVERIFIED), inside the MEASURED bracket (a fed virus shot between wire sizes 136 and 141.2, 1 shot)'),
  approved(21, 'L26', 'Virus count on the full map', { amount: 51, max: 100 }, '{ amount, max }',
    'server laws L26. amount: MEASURED, ' + FFA + ', rough, about 40 to 68 (62 viruses over 633 s). max: MOII ' +
    '(UNVERIFIED)'),
  approved(22, 'L27', 'Virus feeding until it shoots', { rule: 'area' },
    "{ rule }: 'area' = each blob adds its whole mass (size^2 adds) and the virus shoots once it passes L25 maxSize",
    'server laws L27. MEASURED, ' + FFA + ' and ' + OTHER + ': each feed adds 0.865 to 1.063 of a blob\'s mass, ' +
    '7 feeds of size-38 blobs from 100 make it shoot (1 shot on each)'),
  approved(23, 'L28', 'Virus shot', { velocity: 798.8, decayDiv: 10.206, direction: 'lastBlob', resetToMin: true },
    '{ velocity, decayDiv, direction, resetToMin }',
    'server laws L28. MEASURED, ' + FFA + ': flight 793.0 to 804.6, decay 10.10 to 10.32, along the last blob, the ' +
    'fed virus back to minSize (1 shot; ' + OTHER + ' 792.3, 1 / 10.14)'),
  approved(24, 'L29', 'Virus pop pieces', { rule: 'equalPieces', minPieceMass: 20 },
    "{ rule, minPieceMass }: 'equalPieces' = equal pieces, as many as the free slots allow, each at least " +
    "minPieceMass; 'moii' = the fan server's two-branch pop",
    'server laws L29. equal pieces up to the free slots: MEASURED, ' + FFA + ', mass 325 into 16 equal pieces ' +
    '(1 pop; ' + OTHER + ' mass 334 the same way). minPieceMass 20: CHOSEN, the top of the measured range 5 to 20'),
  approved(25, 'L30', 'Who can eat a virus', EAT_RATIO, 'radius ratio',
    'server laws L30. MEASURED, ' + FFA + ': the player eat ratio (L23), inside the virus bracket 1.15 to 1.33 ' +
    '(2 virus eats, 2 deep overlaps without one)'),
  measured('L31', 'Virus colour', [51, 255, 51], '[r, g, b]',
    'server laws L31 (PS-U8): colour bytes of 62 of 62 viruses, exact'),

  // Food.
  approved(26, 'L32', 'Food size', { minSize: 10, maxSize: 16, grows: 'whileUneaten' },
    "{ minSize, maxSize, grows }: 'whileUneaten' = born at minSize, grows while uneaten up to maxSize; true = a " +
    'random size in [minSize, maxSize] at birth (the fan server reading)',
    'server laws L32 (PS-U8). minSize: MEASURED, ' + FFA + ', 622 of 628 food born in view at size 10. maxSize: ' +
    'MEASURED bound, the biggest food seen on FFA. How fast food grows was not measured and is not part of the ' +
    'approved value (it is L32_GROW, measured after the approval)'),
  measured('L32_GROW', 'Food growth while uneaten', { rule: 'randomStep', chancePerTick: 5.38e-4, stepSize: 1 },
    "{ rule, chancePerTick, stepSize }: 'randomStep' = every tick each uneaten food under L32 maxSize grows by " +
    'stepSize with chance chancePerTick (about one step every 74 s)',
    'server laws L32 (PS-U8), the growth rate the approved L32 whileUneaten rule needs, accepted as measured by Owen ' +
    '(OWNER-ANSWERS 2026-10-02, later), measured 2026-10-02 with ' +
    'analysis/laws/food.js: every food in view grew in steps of exactly 1 size (589 of 589), 589 steps in 1,094,783 ' +
    'food-ticks below size 16, chance 5.38e-4 per tick (95 percent 4.95e-4 to 5.83e-4, 8 percent either side, ' +
    'rougher than the other MEASURED rows); the same chance at every size (size 10: 445 in 775,649, 11: 108 in ' +
    '224,978, 12: 29 in 67,028) and the steps spread over every update phase mod 25 (no once-a-second growth); ' +
    OTHER + ' 4.70e-4 (4.18e-4 to 5.26e-4)'),
  measured('L33', 'Food colours', { rule: 'oneFullOneLowOneRandom', full: 255, low: 7, thirdMin: 8, thirdMax: 254 },
    '{ rule, full, low, thirdMin, thirdMax }',
    'server laws L33 (PS-U8): 5,304 of 5,304 food colours have one channel 255, one 7 and the third 8 to 254, all six ' +
    'channel orders about equally (the shape of their colour table, which is never shipped)'),
  approved(27, 'L34', 'Food amount on the full map', { amount: 2657 }, '{ amount }',
    'server laws L34. MEASURED, ' + FFA + ', rough and low-biased (players eat the food near them): 2,326 to 2,975 ' +
    '(633 s of view)'),

  // Players.
  approved(28, 'L35', 'Spawn position rule', { ejectSpawnChance: 0 },
    '{ ejectSpawnChance }: chance a new life starts out of a shot blob; otherwise anywhere at random',
    'server laws L35 (PS-U17). MEASURED bound, ' + FFA + ': 0 of 6 spawns came from a blob (at most 0.39); the ' +
    'spawn places pass the uniform test'),
  law('L36_RULE', 'Shape of the player colour table', STATUS.KNOWN, { full: 255, low: 7, thirdMin: 8, thirdMax: 254 },
    'one channel full, one low, the third in [thirdMin, thirdMax]',
    'KNOWN: config Cell Color table shape (protocol semantics 12.1); the table itself is never shipped'),
  measured('L36', 'How the server picks player colours', { rule: 'tableShape' }, '{ rule }',
    'server laws L36 (PS-U8): 303 of 303 player colours of the L36_RULE shape, all six orders, a new colour every life ' +
    '(6 colours in 6 lives)'),
  law('L37_CLIENT', 'Nickname cap in their name box', STATUS.KNOWN, 15, 'characters',
    'KNOWN: their name input maxlength 15 and config maxNicknameLen 15 (server laws L37)'),
  measured('L37', 'Nickname cap on the server', 15,
    'characters of any kind (code points: 15 emoji stay 15; our wire carries up to 4 x this in UTF-8 bytes)',
    'server laws L37 (PS-U16). Owen chose the recordings over his approved value (approval row 29; OWNER-ANSWERS ' +
    '2026-10-02, later): their server passed a name of 15 characters, 26 UTF-16 units, 52 UTF-8 bytes whole (recording ' +
    'agar-20261001-210803, the longest of the 104 names seen on FFA), so the cap counts characters, not UTF-16 units or bytes. The ' +
    'number 15: their name box maxlength 15 and config maxNicknameLen 15 (L37_CLIENT)'),
  approved(30, 'L38', 'Cell id allocation', { start: 1, step: 1 }, '{ start, step }',
    'server laws L38 (PS-U7). step: MEASURED, ' + FFA + ', 1 on every server (6,015 ids, 0 reused). start 1: ' +
    'CHOSEN, our rooms start fresh'),
  approved(31, 'L39', 'Players per room (also the map shrink N_FULL)', 54, 'players',
    'server laws L39 (Q16). OWNER: Owen\'s Q16 answer, their typical room size (lowered if our load test says so); ' +
    'MEASURED, ' + FFA + ': the median room on the leaderboard, quartiles 44 to 145 (1,630 boards over 10 ' +
    'connections)'),

  // Open behaviour rows (protocol and HUD unknowns, UNKNOWNS rows 40 to 43).
  measured('U_ROUND', 'Rounding of x, y, size on the wire', 'trunc', "'nearest', 'floor' or 'trunc'",
    'U-round, UNKNOWNS row 40: truncated toward zero; sizes rounded down (the server view box law leaves 7 of 2,345 ' +
    'boxes unexplained with round-down, 81 with nearest), positions truncated (view box centre minus wire position fits ' +
    'truncation on 99.9 percent of 2,062 coordinates, 448 of them negative)'),
  measured('U_EAT_REMOVE', 'When an eaten id is removed', 'sameBundle', "'sameBundle' or a later bundle",
    'PS-U3 / CCI-U2, UNKNOWNS row 41: removed in the same update on 2,457 of 2,457 eats; merges and virus feeds are ' +
    'never in the eat list (plain removals)'),
  measured('U_BOARD', 'Leaderboard rows and cadence', { rows: 200, periodMs: 25 * TICK_MS, ownRowWhenOutside: false },
    '{ rows, periodMs, ownRowWhenOutside }',
    'PS-U11 / HUD-U2, U3, UNKNOWNS row 42: op 53 with the whole room list up to 200 rows, every 25 updates (1,619 of ' +
    '1,620 gaps, so periodMs is 25 ticks of L1), no extra own row with a rank (0 of 1,630 boards)'),
  approved(32, 'U_SPECTATE', 'After-death view and spectate camera',
    { afterDeath: 'stayWhereDied', follow: 'top', zoom: 'followedPlayer' }, '{ afterDeath, follow, zoom }',
    'PS-U9 / CCI-U7. afterDeath: MEASURED, ' + FFA + ', the view stays where you died and world updates go on ' +
    '(2 deaths; ' + OTHER + ' 3). follow, zoom: CHOSEN, the Spectate button follows the top player at their zoom ' +
    '(never pressed while dead)'),

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
  // Owen 2026-10-08 ("size as if the strip were there"): our page sizes everything from the canvas their page would
  // have above its 90 CSS px ad strip, draws on the whole window, and so shows extra map under their view. It reports
  // those rows on ag:view (world units at zoom 1, whole, rounded up) and the view box bottom moves down by them / s.
  law('VIEW_BELOW', 'Most extra view below the reference view a page may report', STATUS.CHOSEN, { cap: 180 },
    '{ cap }: world units at zoom 1; the view box bottom moves down by min(reported, cap) / s',
    'CHOSEN (V2 ghost strip, PARITY-LOG 2026-10-08): 180 = 90 / 0.5, the strip rows of a window whose layout factor ' +
    'max(w / 1920, (h - 90) / 1080) is 0.5 (960 CSS px wide or 630 high), so every window that size or larger keeps ' +
    'its whole pad below; a smaller one keeps the slack L4 gives under the reference view (at least 50.3 units) less ' +
    'what it reports past the cap, and a page that reports more sees no further down than such a window'),
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
  const c = { KNOWN: 0, MEASURED: 0, APPROVED: 0, CHOSEN: 0, UNKNOWN: 0, FIXTURE: 0 };
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
