'use strict';
// FIXTURE law table for agar.io server tests (build brief 7.1). TEST ONLY: no file under server/, shared/ or
// public/ may import this (test/agLaws.test.js scans for it).
//
// Fixed test numbers. The 32 rows Owen approved on 2026-10-02 (APPROVED in server/ag/agLaws.js, except L11, L21 and
// L37, which are MEASURED since he chose the recordings for them) keep here the
// suggestion shown on UNKNOWNS.html before that (row number in each source), so the sim, room, view and bot tests
// stay pinned on numbers that do not move. Those suggestions come from MultiOgarII and Ogar, open-source fan servers,
// NOT from agar.io, and most are NOT the approved values: a test that needs the approved value reads LAWS from
// agLaws.js. Every other row (KNOWN, MEASURED or CHOSEN) is copied from the real table. Every entry here has status
// FIXTURE, including the copied rows, so a FIXTURE table can never pass assertShippable.

const { LAWS, STATUS, tableFrom, sizeOf } = require('../server/ag/agLaws');

const MOII = 'MultiOgarII';
const OG = 'Ogar';

function s(row, value, from) {
  return {
    value,
    source: 'FIXTURE (test only): UNKNOWNS row ' + row + ' suggestion from before the 2026-10-02 approval; ' + from,
  };
}

const SUGGESTIONS = {
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
  L15: s(15, { absorb: 1 }, MOII + ' Cell.js onEat sqrt(R^2 + r^2); ' + OG + ' playerMassAbsorbed 1.0'),
  L16: s(16, { rate: 0.002, periodTicks: 25 }, MOII + ' Server.js decay every 25 ticks, playerDecayRate 0.002'),
  L17: s(17, 1500, MOII + ' playerMaxSize 1500 (' + OG + ' playerMaxMass 22500)'),
  L18: s(18, sizeOf(10), 'mass 10 (' + MOII + ' playerMinSize 31.6227766017)'),
  L19: s(19, 56.56854249, 'their config minMassToShoot, mass 32 (' + OG + ' playerMinMassEject 32 agrees)'),
  L21: s(21, { velocity: 780, decayDiv: 9, spreadRad: 0.3, fromEdge: true }, MOII + ' Server.js eject, ejectVelocity 780'),
  L22: s(22, { cooldownTicks: 3 }, MOII + ' config.js ejectCooldown 3'),
  L24: s(24, { div: 3 }, MOII + ' Server.js eat when distance < R - r / 3 (mobilePhysics 0)'),
  L25: s(25, { minSize: 100, maxSize: 141.421356237 }, MOII + ' config.js virusMinSize 100, virusMaxSize 141.421356237'),
  L26: s(26, { amount: 50, max: 100 }, MOII + ' config.js virusAmount 50, virusMaxAmount 100'),
  L27: s(27, { rule: 'area' }, MOII + ' grows the virus by area until virusMaxSize (8 feeds at these sizes)'),
  L28: s(28, { velocity: 780, decayDiv: 9, direction: 'lastBlob', resetToMin: true }, MOII + ' Virus.js shoot'),
  L29: s(29, { rule: 'moii', minPieceMass: 36 }, MOII + ' Virus.js two-branch pop, virusMaxPoppedSize 60'),
  L30: s(30, 1.15, MOII + ' PlayerCell.canEat, the normal 1.15 rule'),
  L32: s(32, { minSize: 10, maxSize: 20, grows: true }, MOII + ' config.js foodMinSize 10, foodMaxSize 20, foodMassGrow 1'),
  L34: s(34, { amount: 700 }, MOII + ' config.js foodAmount 700'),
  L35: s(35, { ejectSpawnChance: 0.5 }, MOII + ' config.js ejectSpawnPercent 0.5'),
  L37: s(37, 15, MOII + ' and ' + OG + ' playerMaxNickLength 15'),
  L38: s(38, { start: 1, step: 1 }, 'our pick, counting up'),
  L39: s(39, 50, 'our pick: 44.2 average per realm in their server list, rounded up'),
  U_SPECTATE: s(43, { afterDeath: 'stayWhereDied', follow: 'top', zoom: 'followedPlayer' }, 'our pick'),
};

function buildEntries(overrides) {
  const out = [];
  for (const id of Object.keys(LAWS)) {
    const e = LAWS[id];
    let value = e.value;
    let source = 'FIXTURE copy of the real table (' + e.status + '): ' + e.source;
    const sug = Object.prototype.hasOwnProperty.call(SUGGESTIONS, id) ? SUGGESTIONS[id] : null;
    if (!sug && e.status === STATUS.UNKNOWN) throw new Error('agLawsFixture: no test number for UNKNOWN law ' + id);
    if (sug) {
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
