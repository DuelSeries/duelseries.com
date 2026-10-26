'use strict';
// The battle royale's timer. Owen 2026-10-25: "a battle royale every 6 hours". The slots are every BR_EVERY_HOURS
// hours on the Eastern wall clock from BR_AUTOSTART_HOUR:MIN (2 AM, 8 AM, 2 PM, 8 PM). The last BR_JOIN_WINDOW_MS
// before each slot is its join window: the arena is waiting with its doors open and the lobby calls everyone in
// (joinOpen), so people have time to get in before the doors shut at the slot.
//
// At the slot (the Events countdown hitting zero) it starts a match if anything is in the arena, bots included,
// UNLESS a match is already running, in which case that slot is skipped (Owen 2026-10-16, kept). Each slot goes off
// once: it is marked the moment it starts one or finds one running, and the mark is saved (brJournal autoDay, which
// holds the slot key 'YYYY-MM-DDTHH' since the 6 hour schedule), so neither a restart nor a match ending later in the
// hour fires it again. A match that is only finishing (over / reopening: one snake already left) is waited out, a few
// seconds, and then the slot's match starts. Only in the slot's own hour, so a box that was down at 2:00 does not
// start one at 3:30. An arena that is a moment short of two snakes (just reopened, bots refilling at 8 a second) is waited for through the start
// minute itself, then the slot is skipped.
//
//   slotKey(et, o)  -> 'YYYY-MM-DDTHH' when et.hour is a slot hour, else null
//   nextSlot(et, o) -> { hour, minute, secs }: the next slot at or after this second (secs 0 = this second)
//   decide({ state, canStart, maintenance, et: { hour, minute, second, day }, lastSlot, startHour, startMin, every })
//   -> { act: 'none' | 'start' | 'skip' | 'wait', markDay, slot, why }
//   pending(...same) -> true while this slot's start is due and has not happened (the Events clock says Starting)
//   joinOpen(...same, windowMs) -> true through the join window, and while a due start waits on a waiting arena
//
// o.startHour / startMin / every / windowMs default to shared/constants, so the rooms' "next match in" clocks and
// the timer read the same schedule.

const C = require('../../shared/constants');

const DAY = 24 * 3600;
const sched = (o) => ({
  first: o && Number.isInteger(o.startHour) ? o.startHour : C.BR_AUTOSTART_HOUR,
  min: o && Number.isInteger(o.startMin) ? o.startMin : C.BR_AUTOSTART_MIN,
  every: o && o.every > 0 ? o.every : C.BR_EVERY_HOURS,
});
const isSlotHour = (h, s) => (((h - s.first) % s.every) + s.every) % s.every === 0;
const pad = (n) => String(n).padStart(2, '0');

function slotKey(et, o) {
  const s = sched(o);
  if (!et || !isSlotHour(et.hour, s)) return null;
  return et.day + 'T' + pad(et.hour);
}

function nextSlot(et, o) {
  const s = sched(o);
  const now = et.hour * 3600 + et.minute * 60 + (et.second || 0);
  let best = null;
  for (let h = 0; h < 24; h++) {
    if (!isSlotHour(h, s)) continue;
    let secs = h * 3600 + s.min * 60 - now;
    if (secs < 0) secs += DAY;
    if (!best || secs < best.secs) best = { hour: h, minute: s.min, secs };
  }
  return best;
}

function due(et, o) {
  const s = sched(o);
  return !!et && isSlotHour(et.hour, s) && et.minute >= s.min;
}

function decide(o) {
  const et = o && o.et;
  if (!et || !due(et, o)) return { act: 'none', markDay: false, why: 'not due' };
  const slot = slotKey(et, o);
  if (o.lastSlot === slot) return { act: 'none', markDay: false, slot, why: 'done this slot' };
  if (o.maintenance) return { act: 'skip', markDay: true, slot, why: 'maintenance is on' };
  if (o.state === 'countdown' || o.state === 'running') {
    return { act: 'skip', markDay: true, slot, why: 'a match is already running' };
  }
  if (o.state === 'over' || o.state === 'reopening') return { act: 'wait', markDay: false, slot, why: 'the last match is finishing' };
  if (o.state !== 'waiting') return { act: 'skip', markDay: true, slot, why: 'unknown state ' + o.state };
  if (!o.canStart) {
    if (et.minute === sched(o).min) return { act: 'wait', markDay: false, slot, why: 'the arena is filling' };
    return { act: 'skip', markDay: true, slot, why: 'nobody in the arena' };
  }
  return { act: 'start', markDay: true, slot, why: 'auto ' + et.hour + ':' + pad(sched(o).min) + ' ET' };
}

function pending(o) {
  const et = o && o.et;
  return !!et && due(et, o) && o.lastSlot !== slotKey(et, o) && !o.maintenance;
}

function joinOpen(o) {
  if (!o || !o.et || o.maintenance || o.state !== 'waiting') return false;
  if (pending(o)) return true;
  const win = o.windowMs > 0 ? o.windowMs : C.BR_JOIN_WINDOW_MS;
  const n = nextSlot(o.et, o);
  return n.secs > 0 && n.secs * 1000 <= win;
}

module.exports = { decide, pending, joinOpen, nextSlot, slotKey };
