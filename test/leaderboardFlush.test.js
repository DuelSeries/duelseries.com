'use strict';
/* The all-time leaderboard flush, which was the cause of the once-a-minute lag.

   It used to do this:

     for (const entry of _cache) { await pool.query('UPDATE ... WHERE google_id = $1') }

   _cache holds up to 1000 players, and _dirty was a single boolean, so ONE
   player beating their own high score issued up to a thousand sequential
   round trips to Postgres. They ran on the same thread as the 60Hz simulation,
   so the loop spent seconds servicing query callbacks instead of ticking.
   /api/debug/tick showed it as a five-second window of late ticks, in every
   room at once, roughly once a minute.

   These tests hold the shape of the fix: one query however many scores
   changed, only the rows that actually changed, and nothing at all when
   nothing did. */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

/* setDb kicks off an async _load that replaces the whole cache when it lands.
   Await it before recording anything, or the load resolves mid-test and wipes
   the scores the test just set. Harmless in production, where setDb runs at
   boot long before a player connects. */
async function freshBoard() {
  // Fresh module each time; the cache is module-level state.
  delete require.cache[require.resolve('../server/leaderboard')];
  const lb = require('../server/leaderboard');
  const calls = [];
  lb.setDb({ pool: { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } } });
  await new Promise(r => setImmediate(r));   // let the initial load settle
  return { lb, calls };
}

test('one changed score costs one query, not one per cached player', async () => {
  const { lb, calls } = await freshBoard();
  for (let i = 0; i < 200; i++) lb.record('wallet' + i, 'p' + i, 1000 + i);
  calls.length = 0;                      // ignore the initial load

  await lb.flush();

  const writes = calls.filter(c => /UPDATE/i.test(c.sql));
  assert.equal(writes.length, 1, `one batched write, got ${writes.length}`);

  // Both arrays are passed whole, so the row count is a parameter, not a loop.
  const [ids, scores] = writes[0].params;
  assert.ok(Array.isArray(ids) && Array.isArray(scores), 'ids and scores are arrays');
  assert.equal(ids.length, 200, 'every changed player is in the single query');
  assert.equal(scores.length, 200);
  assert.ok(/unnest/i.test(writes[0].sql), 'expanded server-side with unnest');
});

test('only the rows that actually changed are written', async () => {
  const { lb, calls } = await freshBoard();
  for (let i = 0; i < 50; i++) lb.record('w' + i, 'p' + i, 500 + i);
  await lb.flush();
  calls.length = 0;

  lb.record('w7', 'p7', 99999);          // one player improves
  await lb.flush();

  const writes = calls.filter(c => /UPDATE/i.test(c.sql));
  assert.equal(writes.length, 1, 'still one query');
  assert.deepEqual(writes[0].params[0], ['w7'], 'and it carries only the changed player');
  assert.deepEqual(writes[0].params[1], [99999]);
});

test('a score that did not improve, and a rename, write nothing', async () => {
  const { lb, calls } = await freshBoard();
  lb.record('w1', 'alice', 900);
  await lb.flush();
  calls.length = 0;

  lb.record('w1', 'alice', 400);         // lower than the stored 900
  lb.rename('w1', 'alice2');             // flush only ever writes high_score
  await lb.flush();

  assert.equal(calls.filter(c => /UPDATE/i.test(c.sql)).length, 0,
    'nothing changed, so nothing is written');
});

test('a failed flush puts the scores back rather than losing them', async () => {
  delete require.cache[require.resolve('../server/leaderboard')];
  const lb = require('../server/leaderboard');
  let fail = true, writes = 0;
  lb.setDb({ pool: { query: async (sql, params) => {
    if (/UPDATE/i.test(sql)) { writes++; if (fail) throw new Error('connection reset'); }
    return { rows: [] };
  } } });

  await new Promise(r => setImmediate(r));   // let the initial load settle
  lb.record('w1', 'alice', 900);
  await lb.flush();                      // fails
  assert.equal(writes, 1);

  fail = false;
  await lb.flush();                      // must try again, not silently drop it
  assert.equal(writes, 2, 'the score is retried after a failure');
});

test('every periodic job is staggered and timed, none on a bare interval', () => {
  /* The previous fix staggered only two jobs. The leaderboard flush, the lobby
     sweeper and the collusion evaluator kept bare intervals started at boot, so
     they collided every 60 seconds and, worse, nothing timed them — which is
     why the debug endpoint could not name the culprit. */
  const fs = require('fs');
  const idx = fs.readFileSync(path.join(__dirname, '..', 'server/index.js'), 'utf8');

  for (const label of ['solvency', 'payouts', 'lb-flush', 'agar-lb-flush',
                       'lobby-sweep', 'collusion'])
    assert.ok(new RegExp(`'${label}'`).test(idx), `${label} runs through everyStaggered`);

  // No module may quietly schedule its own periodic work any more.
  for (const f of ['server/leaderboard.js', 'server/agarLeaderboard.js', 'server/CollusionMonitor.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(!/setInterval/.test(src), `${f} does not schedule itself`);
  }

  /* Offsets must be distinct MOD 30000, because most jobs repeat every 30s and
     a 60s job still lands in a 30s slot. This is the check that would have
     caught 41000, which looks staggered but reduces to the same slot as
     payouts at 11000. */
  const slots = new Map();
  for (const m of idx.matchAll(/everyStaggered\([^,]+,\s*(\d+),\s*(\d+),\s*'([\w-]+)'/g)) {
    const slot = Number(m[2]) % 30000;
    assert.ok(!slots.has(slot),
      `${m[3]} shares the ${slot}ms slot with ${slots.get(slot)}`);
    slots.set(slot, m[3]);
  }
  assert.ok(slots.size >= 6, 'all six jobs were found and checked');
});
