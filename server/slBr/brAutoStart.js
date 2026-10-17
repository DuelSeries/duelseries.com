'use strict';
// The nightly timer's one decision (Owen 2026-10-16): when the Events countdown hits zero (BR_AUTOSTART_HOUR:MIN
// Eastern) it starts a match if anything is in the arena, bots included, UNLESS a match is already running, in which
// case it does nothing that night. It goes off once a day: the day is marked the moment it starts one or finds one
// running, and the mark is saved (brJournal autoDay), so neither a restart nor a match ending later in the hour fires
// it again. A match that is only finishing (over / reopening: one snake already left) is waited out, a few seconds,
// and then the night's match starts. Only in the event's own hour, so a box that was down at 8:05 does not start one
// at midnight. An arena that is a moment short of two snakes (just reopened, bots refilling at 8 a second) is waited
// for through the start minute itself, then the night is skipped.
//
//   decide({ state, canStart, maintenance, et: { hour, minute, day }, lastDay, startHour, startMin })
//   -> { act: 'none' | 'start' | 'skip' | 'wait', markDay, why }
//   pending(...same) -> true while tonight's start is due and has not happened (the Events clock says Starting)

function due(et, startHour, startMin) {
  return !!et && et.hour === startHour && et.minute >= startMin;
}

function decide(o) {
  const et = o && o.et;
  if (!et || !due(et, o.startHour, o.startMin)) return { act: 'none', markDay: false, why: 'not due' };
  if (o.lastDay === et.day) return { act: 'none', markDay: false, why: 'done today' };
  if (o.maintenance) return { act: 'skip', markDay: true, why: 'maintenance is on' };
  if (o.state === 'countdown' || o.state === 'running') {
    return { act: 'skip', markDay: true, why: 'a match is already running' };
  }
  if (o.state === 'over' || o.state === 'reopening') return { act: 'wait', markDay: false, why: 'the last match is finishing' };
  if (o.state !== 'waiting') return { act: 'skip', markDay: true, why: 'unknown state ' + o.state };
  if (!o.canStart) {
    if (et.minute === o.startMin) return { act: 'wait', markDay: false, why: 'the arena is filling' };
    return { act: 'skip', markDay: true, why: 'nobody in the arena' };
  }
  return { act: 'start', markDay: true, why: 'auto ' + o.startHour + ':' + String(o.startMin).padStart(2, '0') + ' ET' };
}

function pending(o) {
  const et = o && o.et;
  return !!et && due(et, o.startHour, o.startMin) && o.lastDay !== et.day && !o.maintenance;
}

module.exports = { decide, pending };
