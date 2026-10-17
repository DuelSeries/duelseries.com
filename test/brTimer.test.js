'use strict';
// The battle royale's nightly timer (server/slBr/brAutoStart.js) and what it must not forget across a restart
// (server/slBr/brJournal.js). Owen 2026-10-16: at zero it starts a match if anything is in the arena, bots included,
// unless a match is already running (then it does nothing that night); a restart mid-match voids it and tells him;
// a prize is never sent twice.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { decide, pending } = require('../server/slBr/brAutoStart');
const { createBrJournal } = require('../server/slBr/brJournal');

const quiet = { log() {}, warn() {}, error() {} };
const at = (hour, minute, day) => ({ hour, minute, second: 0, day: day || '2026-10-16' });
const base = (o) => Object.assign({ state: 'waiting', canStart: true, maintenance: false, et: at(20, 5),
  lastDay: null, startHour: 20, startMin: 5 }, o);

test('timer: at zero it starts a match in a waiting arena, bots alone included, and marks the night', () => {
  const d = decide(base());
  assert.strictEqual(d.act, 'start');
  assert.strictEqual(d.markDay, true);
  assert.strictEqual(pending(base()), true, 'the Events clock says Starting until it does');
});

test('timer: not before 8:05, not after the 8 PM hour, and once a night', () => {
  assert.strictEqual(decide(base({ et: at(20, 4) })).act, 'none');
  assert.strictEqual(decide(base({ et: at(19, 59) })).act, 'none');
  assert.strictEqual(decide(base({ et: at(21, 0) })).act, 'none', 'a box that was down at 8:05 does not start one later');
  assert.strictEqual(decide(base({ et: at(20, 40), lastDay: '2026-10-16' })).act, 'none', 'already went off tonight');
  assert.strictEqual(pending(base({ lastDay: '2026-10-16' })), false);
  assert.strictEqual(decide(base({ et: at(20, 5, '2026-10-17'), lastDay: '2026-10-16' })).act, 'start', 'tomorrow');
});

test('timer: a match already running at zero means nothing tonight (the night is marked, so it never fires later)', () => {
  for (const state of ['countdown', 'running']) {
    const d = decide(base({ state }));
    assert.strictEqual(d.act, 'skip', state);
    assert.strictEqual(d.markDay, true, state);
  }
});

test('timer: a match that is only finishing (one snake left) is waited out, then the night\'s match starts', () => {
  for (const state of ['over', 'reopening']) {
    const d = decide(base({ state }));
    assert.strictEqual(d.act, 'wait', state);
    assert.strictEqual(d.markDay, false, state);
  }
  assert.strictEqual(decide(base({ et: at(20, 6) })).act, 'start', 'the arena reopened a minute later');
});

test('timer: an arena short of two snakes is waited for through the start minute, then the night is skipped', () => {
  const filling = decide(base({ canStart: false }));
  assert.strictEqual(filling.act, 'wait', 'just reopened, bots refilling');
  assert.strictEqual(filling.markDay, false);
  const empty = decide(base({ canStart: false, et: at(20, 6) }));
  assert.strictEqual(empty.act, 'skip');
  assert.strictEqual(empty.markDay, true);
  const m = decide(base({ maintenance: true }));
  assert.strictEqual(m.act, 'skip');
  assert.strictEqual(pending(base({ maintenance: true })), false);
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
