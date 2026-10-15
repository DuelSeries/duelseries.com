'use strict';
/* Security review 2026-10-15 (finder-2 #8): the EU -> NA stats push secret fell back to the
   public 'duelseries-dev-secret' whenever SESSION_SECRET was unset, and liveStakesSol (which NA
   adds into the escrow solvency check) was taken as sent. On a deployed server (NODE_ENV
   production, or REGION set) there is no fallback any more: the push route refuses everything and
   EU sends nothing. The numbers are read as finite and non-negative. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { statsSecret, secretOk, readStatsPush, DEV_SECRET } = require('../server/statsPush');

test('no public fallback on a deployed server', () => {
  assert.strictEqual(statsSecret({ NODE_ENV: 'production' }), null);
  assert.strictEqual(statsSecret({ REGION: 'na' }), null);
  assert.strictEqual(statsSecret({ REGION: 'eu', SESSION_SECRET: '' }), null);
  assert.strictEqual(statsSecret({ REGION: 'na', SESSION_SECRET: 's3cret' }), 's3cret');
  assert.strictEqual(statsSecret({ NODE_ENV: 'production', SESSION_SECRET: 's3cret' }), 's3cret');
  // A bare local run (no REGION, not production) keeps the dev value.
  assert.strictEqual(statsSecret({}), DEV_SECRET);
});

test('with no secret every push is refused, including the old public one', () => {
  assert.strictEqual(secretOk(null, DEV_SECRET), false);
  assert.strictEqual(secretOk(null, ''), false);
  assert.strictEqual(secretOk(null, undefined), false);
  assert.strictEqual(secretOk('s3cret', 's3cret'), true);
  assert.strictEqual(secretOk('s3cret', DEV_SECRET), false);
  assert.strictEqual(secretOk('s3cret', ['s3cret']), false);
  assert.strictEqual(secretOk('s3cret', 's3cre'), false);
});

test('the pushed numbers are finite and never negative', () => {
  assert.deepStrictEqual(readStatsPush({ playerCount: 12, liveStakesSol: 3.5 }), { playerCount: 12, liveStakesSol: 3.5 });
  assert.deepStrictEqual(readStatsPush({ playerCount: -5, liveStakesSol: -1e9 }), { playerCount: 0, liveStakesSol: 0 });
  assert.deepStrictEqual(readStatsPush({ playerCount: 'x', liveStakesSol: 'NaN' }), { playerCount: 0, liveStakesSol: 0 });
  assert.deepStrictEqual(readStatsPush({ playerCount: { a: 1 }, liveStakesSol: [5] }), { playerCount: 0, liveStakesSol: 0 });
  assert.deepStrictEqual(readStatsPush({ liveStakesSol: Infinity }), { playerCount: 0, liveStakesSol: 0 });
  assert.deepStrictEqual(readStatsPush(null), { playerCount: 0, liveStakesSol: 0 });
});

test('index.js: the route and the push both go through it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(src, /const STATS_SECRET = statsPush\.statsSecret\(process\.env\);/);
  assert.doesNotMatch(src, /'duelseries-dev-secret'/, 'no public fallback left in index.js');
  assert.match(src, /if \(!statsPush\.secretOk\(STATS_SECRET, req\.headers\['x-stats-secret'\]\)\) return res\.sendStatus\(403\);\s*remoteStats = statsPush\.readStatsPush\(req\.body\);/);
  assert.match(src, /if \(REGION !== 'eu' \|\| !STATS_SECRET\) return;/);
});
