'use strict';
// slither.io free room: the named rule forms the law table may refer to (SERVER-DESIGN 4.1, task T1).
//
// A law row whose behaviour is a FORM rather than a single number holds { rule: '<name>', ...params } (see
// server/sl/slLaws.js). This file is the one list of those names. It holds NAMES ONLY: each name says which law it
// serves and which module builds it. The module that reads a rule row checks the name against the forms it has
// actually built (slLaws.assertRulesBuilt with its own built list), so a table can never run on a rule nobody wrote.
// slLaws.assertRulesBuilt refuses any rule name that is not in this list.
//
// No numbers live here. Every value is in slLaws.js, by law id.

function r(law, module, what) {
  return Object.freeze({ law, module, what });
}

const RULES = Object.freeze({
  // Movement and growth (slSnake / slSim snake half, task T4)
  speedBase: r('L12', 'slSnake', 'normal speed nsp1 + nsp2 sc(m), m set at spawn and at boost end only'),
  rampN: r('L13.ramp', 'slSnake', 'boost ramp: one step of (nsp3 - ssp) / N per update, N_down = ratio x N_up'),
  offsetFraction: r('L13.first', 'slSnake', 'first ramp step times (press to update ms) / update period'),
  turnK: r('L14', 'slSnake', 'turn per ms toward wang, scang of sc with divisor K, current sct'),
  wangFromByte: r('L15', 'slSim', 'input bytes: wang = 2 pi floor(256 b / 251) / 256, arrow, boost, ping'),
  pullBeforePush: r('L16', 'slSnake', 'server body pulled like the client BEFORE each new point'),
  slCoreScore: r('L17', 'slView', 'length sct + fam and score from shared/slCore.js'),
  famGain: r('L18', 'slSim', 'fam += K b^2 x (1 - Lq / mscps)^exp, one point per move while fam >= 1'),
  lqClampZero: r('L19', 'slSim', 'growth multiplier clamped at 0 once Lq reaches mscps, no separate cap'),
  noDecay: r('L21', 'slSnake', 'no length loss without boosting'),
  boostStart: r('L22', 'slSim', 'boost starts at the press iff L > minL; a refused press stays refused while held'),
  charge: r('L23.form', 'slSnake', 'boost charge: c uniform in [lo, hi], fam -= c x mult, tail point when fam < 0'),
  chargeEdgesCubic: r('L23.edges', 'slSnake', 'charge edges above the low band: base + b2 s^2 + b3 s^3'),
  dropOnCharge: r('L24.Td', 'slSnake', 'a charge drops one food iff L before the charge > minL'),
  dropByte: r('L24.size', 'slSnake', 'boost drop rad byte = round(alpha sqrt(c) + beta)'),
  tailTipDisc: r('L24.place', 'slSnake', 'boost drop at the oldest pulled point plus a uniform point in a disc'),
  skinDropTable: r('L24.colour.skin', 'slSim', 'drop colour: plain own colour, skins by the weight table'),

  // View and stream (slView, task T8)
  anchorAhead: r('L8.anchor', 'slView', 'view anchor ahead of the head along its heading'),
  r2BySct: r('L8.R2', 'slView', 'sector disc i^2 + j^2 <= R2, R2 picked by own sct at each recompute'),
  noFurtherStep: r('L8.R2.high', 'slView', 'no R2 step above the measured sizes'),
  followCurrentSct: r('L8.R2.shrink', 'slView', 'R2 follows the current sct at each recompute'),
  dumpOnEnter: r('L8.adds', 'slView', 'a sector entering the set sends its food dump, nothing when empty'),
  pulledPointInKept: r('L8.snakeAdd', 'slView', 'hold a snake while a pulled point lies in a kept sector'),
  retainAfterUnwatched: r('L8.snake', 'slView', 'code-0 removal once no pulled point was kept for keepMs'),
  discRaster: r('L10', 'slView', 'minimap pixel lit where a pulled body point lies'),
  smallerOfMV: r('L10.mv', 'slView', 'full image or XOR image, whichever encodes smaller'),
  zCadence: r('L11.cadence', 'slView', 'z on the first check, then only on an integer change'),
  ownDeathOrder: r('L41', 'slView', 'own death: dead code 0, own removal code 1, then the drops'),
  pongPerPing: r('L47', 'slRoom', 'one pong per ping, on arrival'),
  angleFormOnIangChange: r('L48.move', 'slView', 'move in angle form iff iang changed, else short form'),
  absFirstPointOnly: r('L48.abs', 'slView', 'absolute move form only for a fresh snake first point'),
  rotChanged: r('L48.rot', 'slView', 'rotation record of changed bytes, ang while turning, ang refresh'),
  removalCodes: r('L50', 'slView', 'snake removal code 1 died, 0 left view'),
  packetByContext: r('L25', 'slView', 'natural food slow pop-in, drops fast pop-in, sector dumps'),

  // Food and prey (slFood, slPrey, task T5)
  radialProfile: r('L26', 'slFood', 'natural food target per sector by fraction of the border radius'),
  naturalRadByte: r('L27', 'slFood', 'natural rad byte = base + floor(span u)'),
  weightedColour: r('L28', 'slFood', 'natural food colour 0 to 8 by fixed weights'),
  batchByDistance: r('L29.rate', 'slFood', 'per pass spawn chance by fraction of the radius, below a target guard'),
  noExpiry: r('L30', 'slFood', 'food never expires'),
  eatDisc: r('L31', 'slSim', 'eat every food inside a disc ahead of the head'),
  preySpawn: r('L32', 'slPrey', 'prey spawn chance per sector-minute, rad byte weights, colour, speed'),
  preyFlee: r('L33.flee', 'slPrey', 'prey flee from the nearest head within a distance, with an angle offset'),
  preyGain: r('L34', 'slSim', 'prey value Kp rad^2 x mult, in the L18 form'),

  // World (slSim world half, task T6)
  collideB: r('L35', 'slSim', 'test point ahead of the head against other bodies as capsules'),
  biggerWins: r('L36', 'slSim', 'same-update head-on: the bigger snake by L survives, a seeded coin on a tie'),
  ownBodySafe: r('L37', 'slSim', 'a snake never dies on its own body'),
  borderKill: r('L38', 'slSim', 'death when the test point passes flux + m'),
  deathDrops: r('L39.count', 'slSim', 'death drops perPoint per body point plus extra, none at the border'),
  interpTable: r('L39.rad', 'slSim', 'death drop rad byte by linear interpolation between measured points'),
  alongBodyDisc: r('L39.place', 'slSim', 'death drops along the pulled body, each moved inside a disc'),
  killCreditOwnSeat: r('L40', 'slRoom', 'kill count to the killer own seat only'),
  spawnRing: r('L42.ring', 'slSim', 'spawn radius (q k + c) flux from the centre at a uniform angle'),

  // Border (slBorder, task T7)
  crowdDensity: r('L11.driver', 'slBorder', 'target radius from the live snake count at the L51 crowd density'),

  // Ours (rooms, hold, bots, top box)
  linearToFloor: r('C_HOLD_RAMP', 'slHold', 'hold speed multiplier max(floor, 1 - (1 - floor) t / ms)'),
  glideThenDie: r('C_DISCONNECT', 'slRoom', 'a live snake whose socket drops glides straight, then dies'),
  humanInvolved: r('C_KILLFEED', 'slRoom', 'a kill line only when the killer exists and a human is involved'),
  takeHome: r('C_TOP_AMOUNT', 'slTopCashout', 'shown amount = rake row x mult'),
  dailyCurveMinusHumans: r('BOT_FILL', 'slBots', 'bots = max(0, daily curve target - humans)'),
  ledgerPlusQuantBound: r('C_TIMING_BARS', 'law check', 'timing law bars read from the sim ledger plus the tick quantization bound'),
});

const RULE_NAMES = Object.freeze(Object.keys(RULES));

function isRule(name) {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(RULES, name);
}

module.exports = { RULES, RULE_NAMES, isRule };
