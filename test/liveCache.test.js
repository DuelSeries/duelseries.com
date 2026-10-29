'use strict';
/* /api/live's answer, shared while the site is busy (night review 2026-10-29, capacity): server/liveCache.js.
   A quiet site (the owner flipping a switch and reading the board, the deploy check, every server test) is built
   fresh on every request exactly as before; a crowd of polling lobbies shares one build for up to a second, so the
   main thread spends a few builds a second on the board however many lobbies poll it. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { liveCache } = require('../server/liveCache');

const ROOT = path.join(__dirname, '..');

function board() {
  let n = 0;
  const build = () => ({ lobbies: [{ id: 'snake:na:free', players: n }], n: ++n });
  return { build, count: () => n };
}

test('quiet: every request is built fresh, so a change shows on the very next read', () => {
  let t = 0;
  const b = board();
  const get = liveCache(b.build, { now: () => t });
  for (let i = 1; i <= 10; i++) {
    assert.strictEqual(JSON.parse(get()).n, i, 'request ' + i + ' is fresh');
    t += 5;                                   // ten requests in 50 ms is still "quiet"
  }
  assert.strictEqual(b.count(), 10);
});

test('busy: past the fresh ones in a second, callers share the last build for up to a second', () => {
  let t = 0;
  const b = board();
  const get = liveCache(b.build, { now: () => t, freshPerSec: 10, ttlMs: 1000 });
  for (let i = 0; i < 1000; i++) { get(); t += 1; }        // 1000 requests a second
  assert.ok(b.count() <= 11, 'at most freshPerSec + 1 builds in that second: ' + b.count());
  const before = b.count();
  for (let i = 0; i < 5000; i++) { get(); t += 1; }        // five more seconds of it
  assert.ok(b.count() - before <= 5 * 11, 'bounded every second: ' + (b.count() - before));
  // Never older than the ttl: the shared copy is rebuilt once it is a second old.
  t += 1000;
  const n = b.count();
  get();
  assert.strictEqual(b.count(), n + 1, 'a new second starts fresh');
});

test('the shared answer is the same JSON string, never a half-built one', () => {
  let t = 0;
  const b = board();
  const get = liveCache(b.build, { now: () => t, freshPerSec: 1 });
  const first = get();
  assert.strictEqual(typeof first, 'string');
  assert.deepStrictEqual(JSON.parse(first), { lobbies: [{ id: 'snake:na:free', players: 0 }], n: 1 });
  t += 10;
  assert.strictEqual(get(), first, 'busy (freshPerSec 1): the same string');
  t += 1000;
  assert.notStrictEqual(get(), first, 'and a fresh one once the second is up');
});

test('server/index.js serves /api/live from it, as JSON, built by the same liveSnapshot', () => {
  const s = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
  assert.match(s, /const liveJson = liveCache\(liveSnapshot\);/);
  assert.match(s, /app\.get\('\/api\/live', \(_req, res\) => res\.type\('json'\)\.send\(liveJson\(\)\)\);/);
  assert.ok(!/res\.json\(liveSnapshot\(\)\)/.test(s), 'no uncached build left on the route');
  // The push to watching lobbies keeps its own once-a-second build.
  assert.match(s, /const s = liveSnapshot\(\);\s+const board = \{ lobbies: s\.lobbies/);
});
