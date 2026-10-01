'use strict';
// FIXTURE law table for agar.io server tests (build brief 7.1). TEST ONLY: no file under server/, shared/ or
// public/ may import this (test/agLaws.test.js scans for it).
//
// Every UNKNOWN row of server/ag/agLaws.js is filled with the suggestion shown to Owen on UNKNOWNS.html (row number
// in each source). Those suggestions come from MultiOgarII and Ogar, open-source fan servers, NOT from agar.io; they
// are unapproved. Every entry here has status FIXTURE, including the rows copied from the real table, so a FIXTURE
// table can never pass assertShippable. When Owen approves a row it turns APPROVED in agLaws.js and this file then
// copies the approved value instead of its suggestion (the tests re-pin on it).

const { LAWS, STATUS, tableFrom, sizeOf } = require('../server/ag/agLaws');

const MOII = 'MultiOgarII';
const OG = 'Ogar';

function s(row, value, from) {
  return { value, source: 'FIXTURE (test only, unapproved): UNKNOWNS row ' + row + ' suggestion; ' + from };
}

const SUGGESTIONS = {
  L1: s(1, 40, MOII + ' Server.js timeStep 40 (25 Hz)'),
  L2: s(2, 14142.135623730952, MOII + ' config.js border 14142.135623730952, centred on 0 in Server.js'),
  L3: s(3, { radiusFactor: 0.5, reflectBoost: true }, MOII + ' Cell.js checkBorder (r = radius / 2)'),
  L4: s(4, { baseW: 1920, baseH: 1080, pad: 100, ref: 64, exp: 0.4, minScale: 0.15 },
    MOII + ' Player.js view box, config.js serverViewBase 1920 x 1080, serverMinScale 0.15'),
  L5: s(5, { coef: 2.2, exp: -0.45, mult: 40 }, MOII + ' PlayerCell.js speed 2.2 * r^-0.45 * 40 per tick'),
  L6: s(6, { rule: 'minDistSpeed' }, MOII + ' PlayerCell.js step = min(distance, speed)'),
  L7: s(7, { minAgeTicks: 13, share: 'otherSizeSq' }, MOII + ' Server.js own-cell push (each moves by the other r^2 share)'),
  L8_CMP: s(8, '>=', MOII + ' skips a split only when the radius is below the minimum'),
  L9_CAP: s(9, { extraSplits: 'ignored', popLimitedToFreeSlots: true }, MOII + ' Server.js and Virus.js'),
  L10: s(10, { newCellMassFraction: 0.5 }, MOII + ' Server.js split halves (' + OG + ' even too)'),
  L11: s(11, { velocity: 780, sizeExp: 0.0122, decayDiv: 9 }, MOII + ' Server.js splitVelocity 780 * size^0.0122, boost / 9'),
  L12: s(12, { baseSec: 30, perSizeSec: 0.2 }, MOII + ' Server.js max(playerRecombineTime 30, radius * 0.2) seconds'),
  L13: s(13, { rule: 'eatOverlapNoRatio', minAgeTicks: 13 }, MOII + ' Server.js merge through the eat overlap, age 13'),
  L14: s(14, sizeOf(10), 'mass 10 (' + MOII + ' playerStartSize 31.6227766017, ' + OG + ' playerStartMass 10)'),
  L15: s(15, { absorb: 1 }, MOII + ' Cell.js onEat sqrt(R^2 + r^2); ' + OG + ' playerMassAbsorbed 1.0'),
  L16: s(16, { rate: 0.002, periodTicks: 25 }, MOII + ' Server.js decay every 25 ticks, playerDecayRate 0.002'),
  L17: s(17, 1500, MOII + ' playerMaxSize 1500 (' + OG + ' playerMaxMass 22500)'),
  L18: s(18, sizeOf(10), 'mass 10 (' + MOII + ' playerMinSize 31.6227766017)'),
  L19: s(19, 56.56854249, 'their config minMassToShoot, mass 32 (' + OG + ' playerMinMassEject 32 agrees)'),
  L20: s(20, { blobSize: 36.06, lossSize: 42.43 }, MOII + ' config.js ejectSize 36.06, ejectSizeLoss 42.43'),
  L21: s(21, { velocity: 780, decayDiv: 9, spreadRad: 0.3, fromEdge: true }, MOII + ' Server.js eject, ejectVelocity 780'),
  L22: s(22, { cooldownTicks: 3 }, MOII + ' config.js ejectCooldown 3'),
  L23: s(23, 1.15, MOII + ' Server.js radius ratio 1.15'),
  L24: s(24, { div: 3 }, MOII + ' Server.js eat when distance < R - r / 3 (mobilePhysics 0)'),
  L25: s(25, { minSize: 100, maxSize: 141.421356237 }, MOII + ' config.js virusMinSize 100, virusMaxSize 141.421356237'),
  L26: s(26, { amount: 50, max: 100 }, MOII + ' config.js virusAmount 50, virusMaxAmount 100'),
  L27: s(27, { rule: 'area' }, MOII + ' grows the virus by area until virusMaxSize (8 feeds at these sizes)'),
  L28: s(28, { velocity: 780, decayDiv: 9, direction: 'lastBlob', resetToMin: true }, MOII + ' Virus.js shoot'),
  L29: s(29, { rule: 'moii', minPieceMass: 36 }, MOII + ' Virus.js two-branch pop, virusMaxPoppedSize 60'),
  L30: s(30, 1.15, MOII + ' PlayerCell.canEat, the normal 1.15 rule'),
  L31: s(31, [51, 255, 51], MOII + ' and ' + OG + ' Virus.js agree'),
  L32: s(32, { minSize: 10, maxSize: 20, grows: true }, MOII + ' config.js foodMinSize 10, foodMaxSize 20, foodMassGrow 1'),
  L33: s(33, { rule: 'oneFullOneLowOneRandom', full: 255, low: 7 }, MOII + ' and ' + OG + ' agree'),
  L34: s(34, { amount: 700 }, MOII + ' config.js foodAmount 700'),
  L35: s(35, { ejectSpawnChance: 0.5 }, MOII + ' config.js ejectSpawnPercent 0.5'),
  L36: s(36, { rule: 'tableShape' }, 'random colour of the L36_RULE shape (we never ship their list)'),
  L37: s(37, 15, MOII + ' and ' + OG + ' playerMaxNickLength 15'),
  L38: s(38, { start: 1, step: 1 }, 'our pick, counting up'),
  L39: s(39, 50, 'our pick: 44.2 average per realm in their server list, rounded up'),
  U_ROUND: s(40, 'nearest', 'our pick, so the start mass shows 10'),
  U_EAT_REMOVE: s(41, 'sameBundle', 'our pick, the eaten cell fades while it slides'),
  U_BOARD: s(42, { rows: 10, periodMs: 1000, ownRowWhenOutside: true }, 'our pick'),
  U_SPECTATE: s(43, { afterDeath: 'stayWhereDied', follow: 'top', zoom: 'followedPlayer' }, 'our pick'),
};

function buildEntries(overrides) {
  const out = [];
  for (const id of Object.keys(LAWS)) {
    const e = LAWS[id];
    let value = e.value;
    let source = 'FIXTURE copy of the real table (' + e.status + '): ' + e.source;
    if (e.status === STATUS.UNKNOWN) {
      const sug = SUGGESTIONS[id];
      if (!sug) throw new Error('agLawsFixture: no suggestion for UNKNOWN law ' + id);
      value = sug.value;
      source = sug.source;
    }
    if (overrides && Object.prototype.hasOwnProperty.call(overrides, id)) value = overrides[id];
    out.push({ id, name: e.name, value, unit: e.unit, status: STATUS.FIXTURE, source });
  }
  if (overrides) {
    for (const id of Object.keys(overrides)) {
      if (!Object.prototype.hasOwnProperty.call(LAWS, id)) throw new Error('agLawsFixture: unknown law id ' + id);
    }
  }
  return out;
}

// A fresh fixture table, optionally with some values replaced: makeFixture({ L8_CMP: '>' }).
function makeFixture(overrides) {
  return tableFrom(buildEntries(overrides), { allowFixture: true });
}

const FIXTURE = makeFixture();

module.exports = { LAWS: FIXTURE, FIXTURE, SUGGESTIONS, makeFixture };
