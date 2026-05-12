// All-time leaderboard backed by PostgreSQL — survives restarts and deploys.
// Reads/writes high_score in the accounts table directly.

let _db = null;

// In-memory cache so we're not hammering the DB every game tick
let _cache = []; // [{ id, name, score }]
let _dirty = false;

function setDb(db) {
  _db = db;
  // Load initial cache from DB
  _load().catch(e => console.error('[Leaderboard] initial load failed:', e.message));
  // Flush any in-memory updates every 30s
  setInterval(_flush, 30_000);
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

async function _flush() {
  if (!_dirty || !_db) return;
  for (const entry of _cache) {
    if (!entry.id || !entry.score) continue;
    await _db.pool.query(
      `UPDATE accounts SET high_score = GREATEST(high_score, $2) WHERE google_id = $1`,
      [entry.id, entry.score]
    ).catch(() => {});
  }
  _dirty = false;
}

function record(id, name, score) {
  if (!id || !name || typeof score !== 'number' || score <= 0) return;
  const idx = _cache.findIndex(e => e.id === id);
  if (idx >= 0) {
    _cache[idx].name = name;
    if (score > _cache[idx].score) { _cache[idx].score = score; _dirty = true; }
  } else {
    _cache.push({ id, name, score });
    _dirty = true;
  }
  if (_dirty) _cache.sort((a, b) => b.score - a.score);
  if (_cache.length > 1000) _cache.length = 1000;
}

function rename(googleId, newName) {
  const entry = _cache.find(e => e.id === googleId);
  if (entry && entry.name !== newName) { entry.name = newName; _dirty = true; }
}

function getTop(n) {
  return _cache.slice(0, n).map((e, i) => ({ rank: i + 1, name: e.name, score: e.score }));
}

module.exports = { setDb, record, rename, getTop };
