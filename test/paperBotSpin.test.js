'use strict';
// Owen 2026-10-28: "a lot of them just spin in circles". A free arena with one scripted person and the bots, run by
// scripts/paperBotSim.js. Before the fix (the wall bend fighting the stock home exits) 62% of bot time over these two
// minutes was a full turn in place and no bot left home by the wall; the fixed bots spin about 1% and almost never
// fold onto their own trail at the wall.
const test = require('node:test');
const assert = require('node:assert');
const { runOne } = require('../scripts/paperBotSim');

test('free arena bots leave home and draw loops instead of spinning in place', () => {
  for (const seed of [1, 2]) {
    const r = runOne(2, seed, {});
    assert.ok(r.botMinutes > 20, 'seed ' + seed + ': bots played ' + r.botMinutes + ' bot-minutes');
    assert.ok(r.spinShare < 0.05, 'seed ' + seed + ': spinning ' + (r.spinShare * 100).toFixed(1) + '% of bot time');
    assert.ok(r.capturesPerBotMin > 10, 'seed ' + seed + ': ' + r.capturesPerBotMin.toFixed(1) + ' captures per bot-minute');
    assert.ok(!(r.deaths.WALL > 2), 'seed ' + seed + ': ' + (r.deaths.WALL || 0) + ' bots folded onto their own trail at the wall');
  }
});
