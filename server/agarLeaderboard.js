'use strict';
// Agar.io all-time leaderboard backed by PostgreSQL (agar_high_score column).
// Mirrors the pattern of leaderboard.js.

let _db = null;
let _cache = []; // [{ id, name, score }]
let _dirty = false;

function setDb(db) {
  _db = db;
  _load().catch(e => console.error('[AgarLB] initial load failed:', e.message));
  setInterval(_flush, 30_000);
  process.on('SIGTERM', _flush);
  process.on('SIGINT',  _flush);
}

async function _load() {
  if (!_db) return;
  const res = await _db.pool.query(
    `SELECT google_id AS id, name, agar_high_score AS score
     FROM accounts WHERE agar_high_score > 0 ORDER BY agar_high_score DESC LIMIT 1000`
  );
  _cache = res.rows.map(r => ({ id: r.id, name: r.name, score: parseInt(r.score) }));
}

async function _flush() {
  if (!_dirty || !_db) return;
  await _load().catch(() => {});
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

  // Write to DB immediately so the score survives restarts
  if (_db) {
    _db.pool.query(
      `UPDATE accounts SET agar_high_score = GREATEST(agar_high_score, $2) WHERE google_id = $1`,
      [id, score]
    ).catch(e => console.error('[AgarLB] DB write failed:', e.message));
  }
}

function getTop(n) {
  return _cache.slice(0, n).map((e, i) => ({ rank: i + 1, name: e.name, score: e.score }));
}

module.exports = { setDb, record, getTop };
