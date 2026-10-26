'use strict';
// The battle royale's 6 hour timer (server/slBr/brAutoStart.js) and what it must not forget across a restart
// (server/slBr/brJournal.js). Owen 2026-10-16: at zero it starts a match if anything is in the arena, bots included,
// unless a match is already running (then that slot is skipped); every 6 hours since 2026-10-25; a restart mid-match voids it and tells him;
// a prize is never sent twice.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { decide, pending, joinOpen, nextSlot, slotKey } = require('../server/slBr/brAutoStart');
const { createBrJournal } = require('../server/slBr/brJournal');
const C = require('../shared/constants');

const quiet = { log() {}, warn() {}, error() {} };
const at = (hour, minute, day, second) => ({ hour, minute, second: second || 0, day: day || '2026-10-16' });
const base = (o) => Object.assign({ state: 'waiting', canStart: true, maintenance: false, et: at(20, 0),
  lastSlot: null }, o);

test('schedule: every 6 hours from 2 AM Eastern, with a 30 s join window', () => {
  assert.strictEqual(C.BR_AUTOSTART_HOUR, 2);
  assert.strictEqual(C.BR_AUTOSTART_MIN, 0);
  assert.strictEqual(C.BR_EVERY_HOURS, 6);
  assert.strictEqual(C.BR_JOIN_WINDOW_MS, 30000);
  assert.deepStrictEqual(nextSlot(at(1, 59, null, 30)), { hour: 2, minute: 0, secs: 30 });
  assert.deepStrictEqual(nextSlot(at(2, 0)), { hour: 2, minute: 0, secs: 0 }, 'zero at the slot, not 6 hours');
  assert.deepStrictEqual(nextSlot(at(2, 0, null, 1)), { hour: 8, minute: 0, secs: 6 * 3600 - 1 });
  assert.deepStrictEqual(nextSlot(at(13, 0)), { hour: 14, minute: 0, secs: 3600 });
  assert.deepStrictEqual(nextSlot(at(23, 0)), { hour: 2, minute: 0, secs: 3 * 3600 }, 'past 8 PM it wraps to 2 AM');
  assert.strictEqual(slotKey(at(14, 0)), '2026-10-16T14');
  assert.strictEqual(slotKey(at(15, 0)), null);
});

test('timer: at a slot it starts a match in a waiting arena, bots alone included, and marks that slot', () => {
  for (const h of [2, 8, 14, 20]) {
    const d = decide(base({ et: at(h, 0) }));
    assert.strictEqual(d.act, 'start', h + ':00');
    assert.strictEqual(d.markDay, true);
    assert.strictEqual(d.slot, '2026-10-16T' + String(h).padStart(2, '0'));
    assert.strictEqual(pending(base({ et: at(h, 0) })), true, 'the Events clock says Starting until it does');
  }
});

test('timer: not before a slot, not after its hour, not between slots, and once a slot', () => {
  assert.strictEqual(decide(base({ et: at(19, 59) })).act, 'none');
  assert.strictEqual(decide(base({ et: at(21, 0) })).act, 'none', 'a box that was down at 8:00 does not start one later');
  assert.strictEqual(decide(base({ et: at(11, 0) })).act, 'none', 'not between slots');
  assert.strictEqual(decide(base({ et: at(20, 40), lastSlot: '2026-10-16T20' })).act, 'none', 'already went off this slot');
  assert.strictEqual(pending(base({ lastSlot: '2026-10-16T20' })), false);
  assert.strictEqual(decide(base({ et: at(2, 0, '2026-10-17'), lastSlot: '2026-10-16T20' })).act, 'start', 'the next slot');
  assert.strictEqual(decide(base({ lastSlot: '2026-10-16' })).act, 'start', 'a day saved before the 6 hour schedule');
});

test('timer: a match already running at a slot skips that slot (marked, so it never fires later)', () => {
  for (const state of ['countdown', 'running']) {
    const d = decide(base({ state }));
    assert.strictEqual(d.act, 'skip', state);
    assert.strictEqual(d.markDay, true, state);
    assert.strictEqual(joinOpen(base({ state, et: at(19, 59, null, 45) })), false, 'no join call while one runs');
  }
});

test('timer: a match that is only finishing (one snake left) is waited out, then the slot\'s match starts', () => {
  for (const state of ['over', 'reopening']) {
    const d = decide(base({ state }));
    assert.strictEqual(d.act, 'wait', state);
    assert.strictEqual(d.markDay, false, state);
    assert.strictEqual(joinOpen(base({ state })), false, 'doors shut while it finishes');
  }
  assert.strictEqual(decide(base({ et: at(20, 1) })).act, 'start', 'the arena reopened a minute later');
  assert.strictEqual(joinOpen(base({ et: at(20, 1) })), true, 'and the lobby calls people in until it starts');
});

test('timer: an arena short of two snakes is waited for through the start minute, then the slot is skipped', () => {
  const filling = decide(base({ canStart: false }));
  assert.strictEqual(filling.act, 'wait', 'just reopened, bots refilling');
  assert.strictEqual(filling.markDay, false);
  const empty = decide(base({ canStart: false, et: at(20, 1) }));
  assert.strictEqual(empty.act, 'skip');
  assert.strictEqual(empty.markDay, true);
  const m = decide(base({ maintenance: true }));
  assert.strictEqual(m.act, 'skip');
  assert.strictEqual(pending(base({ maintenance: true })), false);
  assert.strictEqual(joinOpen(base({ maintenance: true, et: at(19, 59, null, 45) })), false);
});

/* A fake clock: one Eastern day, second by second, through the server's own loop (decide every second, the mark
   saved, a started match running for a while). Four starts, each on its slot's second, each after exactly 30 s of
   join window; a match the owner started that is still running at a slot skips it. */
function runDay(opts) {
  const o = opts || {};
  let state = 'waiting', lastSlot = null, busyUntil = -1;
  const starts = [], skips = [], windows = {};
  for (let t = 0; t < 86400; t++) {
    if (o.ownerStartAt === t) { state = 'running'; busyUntil = t + o.ownerRunsFor; }
    if (state === 'running' && t >= busyUntil) state = 'waiting';
    const et = { hour: Math.floor(t / 3600), minute: Math.floor(t / 60) % 60, second: t % 60, day: '2026-10-25' };
    const a = { state, canStart: true, maintenance: false, et, lastSlot };
    const n = nextSlot(et);
    if (joinOpen(a) && n.secs > 0) windows[n.hour] = (windows[n.hour] || 0) + 1;   // the slot's own second is 'Starting'
    const d = decide(a);
    if (d.markDay) lastSlot = d.slot;
    if (d.act === 'start') { starts.push(t); state = 'running'; busyUntil = t + 120; }
    else if (d.act === 'skip') skips.push(t);
  }
  return { starts, skips, windows };
}

test('fake clock: a day has four matches, at 2 AM, 8 AM, 2 PM and 8 PM, each after a 30 s join window', () => {
  const r = runDay();
  assert.deepStrictEqual(r.starts, [2, 8, 14, 20].map((h) => h * 3600));
  assert.deepStrictEqual(r.skips, []);
  assert.deepStrictEqual(r.windows, { 2: 30, 8: 30, 14: 30, 20: 30 }, 'the 30 seconds before each slot, and no others');
});

test('fake clock: a match still running at a slot skips that slot, and the next slot runs as normal', () => {
  const r = runDay({ ownerStartAt: 13 * 3600 + 58 * 60, ownerRunsFor: 5 * 60 });   // owner Start at 1:58 PM, 5 min
  assert.deepStrictEqual(r.starts, [2, 8, 20].map((h) => h * 3600));
  assert.deepStrictEqual(r.skips, [14 * 3600]);
  assert.strictEqual(r.windows[14], undefined, 'no join call for a slot whose doors are shut');
});

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brj-')), 'br-journal.json');
}

test('journal: the live match, the timer night and the prizes survive a restart (a new journal on the same file)', () => {
  const file = tmpFile();
  const j = createBrJournal({ file, log: quiet, now: () => 1.7e12 });
  assert.strictEqual(j.live(), null);
  assert.strictEqual(j.setLive({ matchId: 'br_x', startedAt: 't', seats: 2, wallets: 2, people: ['Ann', 'Ben'] }), true);
  j.setAutoDay('2026-10-16');
  j.setPrize('br_y', { state: 'paying', wallet: 'WB', name: 'Ben', amount: 20 });
  const k = createBrJournal({ file, log: quiet });
  assert.deepStrictEqual(k.live(), { matchId: 'br_x', startedAt: 't', seats: 2, wallets: 2, people: ['Ann', 'Ben'] });
  assert.strictEqual(k.autoDay(), '2026-10-16');
  assert.strictEqual(k.prize('br_y').state, 'paying');
  assert.strictEqual(k.prize('br_y').wallet, 'WB');
  k.setPrize('br_y', { state: 'paid', sig: 'SIG' });
  const p = createBrJournal({ file, log: quiet }).prize('br_y');
  assert.strictEqual(p.state, 'paid');
  assert.strictEqual(p.sig, 'SIG');
  assert.strictEqual(p.wallet, 'WB', 'a patch keeps what it does not name');
  k.setLive(null);
  assert.strictEqual(createBrJournal({ file, log: quiet }).live(), null);
});

test('journal: a bad state, a file that is not ours, and the kept prize count', () => {
  const file = tmpFile();
  const j = createBrJournal({ file, log: quiet });
  assert.strictEqual(j.setPrize('br_z', { state: 'maybe' }), false, 'only paying, paid, failed, unknown');
  assert.strictEqual(j.prize('br_z'), null);
  for (let i = 0; i < 40; i++) j.setPrize('br_' + i, { state: 'paid' });
  assert.strictEqual(j.prizes().length, 30);
  assert.strictEqual(j.prize('br_0'), null, 'the oldest go first');
  assert.ok(j.prize('br_39'));
  fs.writeFileSync(file, '{not json');
  const k = createBrJournal({ file, log: quiet });
  assert.strictEqual(k.live(), null);
  assert.deepStrictEqual(k.prizes(), []);
});
