'use strict';
/* HOW MANY BOTS, AND WHY IT MOVES.

   It was a flat 20, every hour of every day. Anyone who opened the lobby twice
   saw exactly twenty both times, which is the one thing a real player count
   never is — a constant is the tell, and twenty at four in the morning is not a
   figure a real game produces.

   The target walks a daily curve between BOT_MIN and BOT_MAX now. These pin the
   properties that make it read as people rather than as a number generator:
   it stays inside the range, it has a real rhythm, it never teleports, and two
   days are not identical. */

const test = require('node:test');
const assert = require('node:assert');
const C = require('../shared/constants');
const { botTarget, curveAt, HOURLY } = require('../server/botPopulation');

/* Midnight Eastern on a fixed date, so these run the same in any timezone and
   in any month. 2026-09-12T04:00Z is 2026-09-12 00:00 EDT. */
const MIDNIGHT_ET = new Date('2026-09-12T04:00:00Z').getTime();
const HOUR = 3600 * 1000;
const at = (h, m) => MIDNIGHT_ET + h * HOUR + (m || 0) * 60000;

function dayCounts(dayOffset) {
  const out = [];
  for (let h = 0; h < 24; h++) out.push(botTarget(at(h) + (dayOffset || 0) * 24 * HOUR));
  return out;
}

test('the count never leaves the configured range', () => {
  /* Sampled every ten minutes across four days, which covers the curve, the
     wander, and the wrap through midnight. */
  for (let d = 0; d < 4; d++) {
    for (let h = 0; h < 24; h++) {
      for (let m = 0; m < 60; m += 10) {
        const n = botTarget(at(h, m) + d * 24 * HOUR);
        assert.ok(n >= C.BOT_MIN && n <= C.BOT_MAX,
          `in range at day ${d} ${h}:${m} (got ${n}, range ${C.BOT_MIN}-${C.BOT_MAX})`);
        assert.ok(Number.isInteger(n), 'a whole number of snakes');
      }
    }
  }
});

test('it is never the same number all day, which is what gave it away', () => {
  const counts = dayCounts(0);
  const distinct = new Set(counts);
  assert.ok(distinct.size >= 10,
    `a day has real variety in it (got ${distinct.size} distinct values across 24 hours)`);
});

test('it is quiet before dawn and busiest in the evening', () => {
  /* The rhythm is the point. A flat random number between 22 and 101 would be
     as obvious as a constant in the other direction: real counts do not
     teleport from 90 to 25 and back. */
  const counts = dayCounts(0);
  const small = Math.min(...counts.slice(3, 7));      // 3am-6am
  const big = Math.max(...counts.slice(19, 22));      // 7pm-9pm
  assert.ok(big > small * 1.8,
    `the evening is far busier than the small hours (${small} vs ${big})`);

  const peakHour = counts.indexOf(Math.max(...counts));
  assert.ok(peakHour >= 18 && peakHour <= 22,
    `the peak lands in the evening, near the nightly event (hour ${peakHour})`);
});

test('it never teleports: minute to minute the change is small', () => {
  /* A count that jumps forty between one lobby refresh and the next is as
     unbelievable as a constant. */
  let worst = 0, worstAt = '';
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m++) {
      const a = botTarget(at(h, m));
      const b = botTarget(at(h, m) + 60000);
      const d = Math.abs(b - a);
      if (d > worst) { worst = d; worstAt = h + ':' + m; }
    }
  }
  assert.ok(worst <= 3,
    `at most a few either way in a minute (worst ${worst} at ${worstAt})`);
});

test('two days are not the same day', () => {
  const a = dayCounts(0), b = dayCounts(1);
  assert.notDeepEqual(a, b, 'tomorrow is a different walk');
  // But still the same SHAPE: both evenings busier than both dawns.
  const dawn = (c) => Math.min(...c.slice(3, 7));
  const eve = (c) => Math.max(...c.slice(19, 22));
  assert.ok(eve(a) > dawn(a) && eve(b) > dawn(b), 'and both still have the rhythm');
});

test('the same moment gives the same answer', () => {
  /* Called once a second from the tick. If it were Math.random() per call the
     count would shiver rather than drift, which is its own tell. */
  const t = at(14, 30);
  assert.equal(botTarget(t), botTarget(t));
  assert.equal(botTarget(t), botTarget(t));
});

test('the curve wraps through midnight instead of falling off the array', () => {
  const lateNight = curveAt(23, 30);
  const a = HOURLY[23], b = HOURLY[0];
  const lo = Math.min(a, b), hi = Math.max(a, b);
  assert.ok(lateNight >= lo && lateNight <= hi,
    '23:30 eases between the 23:00 and 00:00 weights');
  assert.equal(HOURLY.length, 24, 'one weight per hour');
});
