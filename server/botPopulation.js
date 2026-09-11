'use strict';
/* ─── How many bodies a free room should hold, right now ──────────────────────
   It was one number, twenty, forever. Anyone who opened the lobby twice in a
   day saw exactly twenty both times, and twenty at four in the morning is not a
   number a real game produces — a constant is the tell.

   So the target moves. Two things move it, and both matter:

   A DAILY RHYTHM. A flat random number between 22 and 101 would be as obvious
   as a constant in the other direction: real player counts do not teleport from
   90 to 25 and back. They follow the clock — quiet before dawn, climbing
   through the afternoon, busiest in the evening around the nightly event, then
   falling away. The curve below is that shape, stated as twenty-four plain
   weights rather than hidden inside trigonometry, so it can be read and tuned
   by looking at it.

   SLOW DRIFT. Two Tuesdays should not be identical either. A random walk wanders
   the target a little either side of the curve and is re-seeded per day, so the
   same hour is a different number tomorrow without ever jumping.

   Eastern wall clock, read from Intl, for the same reason everything else in
   this product does: a hardcoded UTC offset is wrong for a third of the year
   and the failure is silent.

   WHAT THIS DOES NOT DO is remove anybody. GameRoom.topUpBots only ever ADDS,
   deliberately — a live snake deleted to hold a number is a snake vanishing out
   from under whoever was chasing it. When the target falls, bots are simply not
   replaced as they die, and the room drains down on its own. */

const C = require('../shared/constants');

/* Share of the day's peak, per Eastern hour, 0..1. Midnight at index 0.
   The shape: a trough at 5am, a slow climb through the morning, a plateau
   across the afternoon, the peak at 9pm beside the nightly battle royale, then
   a decline. Interpolated between hours, so the number never steps. */
const HOURLY = [
  0.42, 0.32, 0.24, 0.18, 0.14, 0.12, 0.14, 0.20,   // 00-07  the dead hours
  0.30, 0.40, 0.48, 0.55, 0.60, 0.63, 0.66, 0.70,   // 08-15  the climb
  0.76, 0.83, 0.90, 0.95, 0.99, 1.00, 0.82, 0.60,   // 16-23  evening, peak at 21
];

let _fmt = null;
try {
  _fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false,
    hour: '2-digit', minute: '2-digit', year: 'numeric', month: '2-digit', day: '2-digit',
  });
} catch (_) { _fmt = null; }

function easternNow(at) {
  const d = at ? new Date(at) : new Date();
  if (!_fmt) {
    return { hour: d.getHours(), minute: d.getMinutes(), day: d.toDateString() };
  }
  const o = {};
  _fmt.formatToParts(d).forEach(p => { if (p.type !== 'literal') o[p.type] = p.value; });
  const hour = Number(o.hour) === 24 ? 0 : Number(o.hour);   // some engines say 24 at midnight
  return { hour, minute: Number(o.minute), day: o.year + '-' + o.month + '-' + o.day };
}

/* The curve at a fractional hour, wrapping midnight so 23:30 eases into 00:00
   instead of falling off the end of the array. */
function curveAt(hour, minute) {
  const h = ((hour % 24) + 24) % 24;
  const f = Math.min(59, Math.max(0, minute || 0)) / 60;
  const a = HOURLY[h];
  const b = HOURLY[(h + 1) % 24];
  return a + (b - a) * f;
}

/* A number in roughly [-1, 1] that wanders smoothly and never repeats.

   Three sines on a CONTINUOUS clock — absolute hours, not hours-past-midnight.
   The first version seeded this off the calendar date, which made it jump at
   every midnight when the seed changed: measured, a 7-snake teleport between
   23:59 and 00:00, which is exactly the kind of seam that reads as a script
   rather than as people. A continuous clock has no seam to cross.

   The three periods (about 17, 7.6 and 3.9 hours) do not divide 24 or each
   other, so the same hour is a different number tomorrow without the walk ever
   being reset.

   Deliberately not Math.random(): the target is recomputed every second, and a
   fresh random each time would be noise rather than drift — the count would
   shiver instead of wandering. */
function drift(tHours) {
  return (
    Math.sin(tHours * 0.37) * 0.55 +
    Math.sin(tHours * 0.83) * 0.30 +
    Math.sin(tHours * 1.61) * 0.15
  );
}

/* The population a free room should be aiming at this second.

   `at` is only for tests: left out, it reads the clock. */
function botTarget(at) {
  const now = at === undefined ? Date.now() : at;
  const { hour, minute } = easternNow(now);
  const lo = C.BOT_MIN, hi = C.BOT_MAX;
  const span = hi - lo;

  const base = lo + span * curveAt(hour, minute);
  /* The wander is a share of the whole range rather than of the current value,
     so the quiet hours move about as much as the busy ones and 3am does not sit
     pinned to the floor every night.

     Driven off the absolute clock so it does not reset at midnight — see drift. */
  const wander = drift(now / 3600000) * span * 0.09;

  return Math.max(lo, Math.min(hi, Math.round(base + wander)));
}

module.exports = { botTarget, curveAt, easternNow, HOURLY };
