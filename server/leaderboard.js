// All-time leaderboard backed by PostgreSQL — survives restarts and deploys.
// Reads/writes high_score in the accounts table directly.

let _db = null;

// In-memory cache so we're not hammering the DB every game tick
let _cache = []; // [{ id, name, score }]

/* WHICH rows changed, not just THAT something did.
   This was a single boolean, and _flush rewrote the whole cache whenever it was
   set. One player beating their own high score therefore issued an UPDATE for
   all 1000 cached players, one sequential round trip each, on the thread
   running the 60Hz simulation. That is what players felt as the snake lagging
   once a minute: not a freeze, a multi-second window of late ticks while the
   loop serviced a thousand query callbacks. */
const _dirtyIds = new Set();
let _flushing = false;

function setDb(db) {
  _db = db;
  // Load initial cache from DB
  _load().catch(e => console.error('[Leaderboard] initial load failed:', e.message));
  // Scheduling lives in index.js now, through everyStaggered, so this job is
  // both offset from the others AND measured in /api/debug/tick. It was the
  // only heavy periodic job that nothing was timing.
  process.on('SIGTERM', _flush);
  process.on('SIGINT',  _flush);
}

async function _load() {
  if (!_db) return;
  const res = await _db.pool.query(
    `SELECT google_id AS id, name, high_score AS score
     FROM accounts WHERE high_score > 0 ORDER BY high_score DESC LIMIT 1000`
  );
  _cache = res.rows.map(r => ({ id: r.id, name: r.name, score: parseInt(r.score) }));
}

/* ONE round trip for any number of changed scores, instead of one per row.
   unnest turns the two arrays into rows the UPDATE joins against, so a hundred
   changed scores cost the same single query as one does. GREATEST keeps the
   old behaviour: a score never goes down, whatever the cache thinks. */
async function _flush() {
  if (!_db || _dirtyIds.size === 0) return;
  if (_flushing) return;          // a slow flush must not stack up behind itself
  _flushing = true;
  const ids = [], scores = [];
  for (const id of _dirtyIds) {
    const e = _cache.find(x => x.id === id);
    if (!e || !e.id || !e.score) continue;
    ids.push(String(e.id));
    scores.push(Math.floor(e.score));
  }
  _dirtyIds.clear();              // cleared up front: a score set during the
                                  // await belongs to the NEXT flush, not this one
  try {
    if (ids.length) {
      await _db.pool.query(
        `UPDATE accounts AS a
            SET high_score = GREATEST(a.high_score, v.score)
           FROM (SELECT * FROM unnest($1::text[], $2::bigint[]) AS t(id, score)) AS v
          WHERE a.google_id = v.id`,
        [ids, scores]
      );
    }
  } catch (e) {
    console.error('[Leaderboard] flush failed:', e.message);
    for (const id of ids) _dirtyIds.add(id);   // retry on the next pass
  } finally {
    _flushing = false;
  }
}

function record(id, name, score) {
  if (!id || !name || typeof score !== 'number' || score <= 0) return;
  let changed = false;
  const idx = _cache.findIndex(e => e.id === id);
  if (idx >= 0) {
    _cache[idx].name = name;
    if (score > _cache[idx].score) { _cache[idx].score = score; changed = true; }
  } else {
    _cache.push({ id, name, score });
    changed = true;
  }
  if (!changed) return;           // a name touch is not a score, and writes nothing
  _dirtyIds.add(id);
  _cache.sort((a, b) => b.score - a.score);
  if (_cache.length > 1000) _cache.length = 1000;
}

/* Renaming does NOT mark anything for flushing: _flush only ever writes
   high_score, so a rename used to schedule a thousand pointless UPDATEs that
   changed nothing at all. */
function rename(googleId, newName) {
  const entry = _cache.find(e => e.id === googleId);
  if (entry && entry.name !== newName) entry.name = newName;
}

function getTop(n) {
  return _cache.slice(0, n).map((e, i) => ({ rank: i + 1, name: e.name, score: e.score }));
}

module.exports = { setDb, record, rename, getTop, flush: _flush };
