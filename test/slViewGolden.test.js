'use strict';
// slViewGolden (task T8; SERVER-DESIGN 18.2 item 5 for the view): the scripted worlds of test/slViewHarness.js (16
// snakes, 4 seats that die, leave and are replaced, inputs, kills and leaves), 3 seeds x 2000 ticks with wakes of up
// to 1, 2 and 3 ticks, hashed per window of 100 ticks: a sha256 of every seat bundle of the window (seat index and
// bytes, in assemble order) and sim.digest() at the window end. Any change to what a seat is sent shows up here.
//
// Re-cut ONLY with a law-table change or a reviewed view or sim change:
//   SL_VIEW_GOLDEN_CUT=1 node --test test/slViewGolden.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { runWorld } = require('./slViewHarness');
const { bundleOf } = require('../server/sl/slView');

const GOLDEN = path.join(__dirname, 'slViewGolden.json');
const RUNS = [{ seed: 31, wakeMax: 1 }, { seed: 32, wakeMax: 2 }, { seed: 33, wakeMax: 3 }];
const TICKS = 2000;
const EVERY = 100;

function cut(run) {
  const windows = [];
  let h = crypto.createHash('sha256');
  let next = EVERY;
  let bundles = 0;
  let bytes = 0;
  const out = runWorld({
    seed: run.seed,
    ticks: TICKS,
    snakes: 16,
    seats: 4,
    wakeMax: run.wakeMax,
    onJoin({ rec, entries }) {
      const b = bundleOf(entries);
      h.update('J' + rec.own + ':' + b.length + '\n');
      h.update(b);
    },
    onAssemble({ rec, entries, sim }) {
      const b = bundleOf(entries);
      bundles++;
      bytes += b.length;
      h.update('S' + rec.own + '@' + sim.tick() + ':' + b.length + '\n');
      h.update(b);
    },
    onWake({ sim }) {
      if (sim.tick() >= next) {
        windows.push(h.digest('hex').slice(0, 16) + ' ' + sim.digest());
        h = crypto.createHash('sha256');
        while (next <= sim.tick()) next += EVERY;
      }
    },
  });
  const problems = out.seats.flatMap((s) => s.mirror.problems);
  return { seed: run.seed, wakeMax: run.wakeMax, windows, bundles, bytes, seats: out.seats.length, problems };
}

test('slViewGolden: 3 seeds x 2000 ticks, 4 seats, wakes of 1 to 3 ticks: every window equals the golden', () => {
  const got = RUNS.map(cut);
  for (const g of got) assert.deepEqual(g.problems.slice(0, 5), [], 'seed ' + g.seed + ': the stream mirror found problems');
  const doc = got.map((g) => ({ seed: g.seed, wakeMax: g.wakeMax, seats: g.seats, bundles: g.bundles, bytes: g.bytes,
    windows: g.windows }));
  if (process.env.SL_VIEW_GOLDEN_CUT === '1') {
    fs.writeFileSync(GOLDEN, JSON.stringify(doc, null, 1) + '\n');
    return;
  }
  const want = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  assert.equal(want.length, doc.length);
  for (let i = 0; i < doc.length; i++) {
    assert.equal(doc[i].seed, want[i].seed);
    assert.equal(doc[i].windows.length, want[i].windows.length, 'seed ' + doc[i].seed + ' windows');
    for (let k = 0; k < doc[i].windows.length; k++) {
      assert.equal(doc[i].windows[k], want[i].windows[k], 'seed ' + doc[i].seed + ' window ' + k + ' (ticks to ' + (k + 1) * EVERY + ')');
    }
    assert.equal(doc[i].bundles, want[i].bundles);
    assert.equal(doc[i].bytes, want[i].bytes);
    assert.equal(doc[i].seats, want[i].seats);
  }
});
