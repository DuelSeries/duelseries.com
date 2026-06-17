const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: (process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')) ? { rejectUnauthorized: false } : false,
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      google_id      TEXT PRIMARY KEY,
      email          TEXT,
      name           TEXT,
      avatar         TEXT,
      balance        NUMERIC(18,9) DEFAULT 0,
      high_score     INTEGER DEFAULT 0,
      games_played   INTEGER DEFAULT 0,
      wallet_address TEXT,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS deposits (
      id          SERIAL PRIMARY KEY,
      google_id   TEXT NOT NULL,
      tx_sig      TEXT UNIQUE NOT NULL,
      amount      NUMERIC(18,9) NOT NULL,
      from_address TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    ALTER TABLE accounts ADD COLUMN IF NOT EXISTS total_earnings NUMERIC(18,9) DEFAULT 0;

    CREATE TABLE IF NOT EXISTS withdrawals (
      id          SERIAL PRIMARY KEY,
      google_id   TEXT NOT NULL,
      tx_sig      TEXT,
      amount      NUMERIC(18,9) NOT NULL,
      to_address  TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS collusion_flags (
      id             SERIAL PRIMARY KEY,
      src_google_id  TEXT NOT NULL,
      dst_google_id  TEXT NOT NULL,
      net_sol        NUMERIC(18,9) NOT NULL,
      total_sol      NUMERIC(18,9) NOT NULL,
      transfer_count INTEGER NOT NULL,
      one_way_ratio  NUMERIC(6,4),
      concentration  NUMERIC(6,4),
      lobby_type     TEXT,
      flagged_at     TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS used_stake_sigs (
      sig        TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS verification_codes (
      google_id   TEXT NOT NULL,
      code        TEXT NOT NULL,
      expires_at  TIMESTAMPTZ NOT NULL,
      used        BOOLEAN DEFAULT FALSE,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS trusted_devices (
      google_id    TEXT NOT NULL,
      device_token TEXT NOT NULL,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (google_id, device_token)
    );

    ALTER TABLE accounts ADD COLUMN IF NOT EXISTS play_time_seconds INTEGER DEFAULT 0;

    CREATE TABLE IF NOT EXISTS earnings_history (
      id         SERIAL PRIMARY KEY,
      google_id  TEXT NOT NULL,
      amount     NUMERIC(18,9) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_eh_gid ON earnings_history(google_id, created_at);
    ALTER TABLE earnings_history ADD COLUMN IF NOT EXISTS cad_amount NUMERIC(18,4) DEFAULT 0;

    ALTER TABLE accounts ADD COLUMN IF NOT EXISTS name_history TEXT[] DEFAULT '{}';
    ALTER TABLE accounts ADD COLUMN IF NOT EXISTS agar_high_score INTEGER DEFAULT 0;
    ALTER TABLE accounts ADD COLUMN IF NOT EXISTS agar_total_earnings NUMERIC(18,9) DEFAULT 0;
    ALTER TABLE accounts ADD COLUMN IF NOT EXISTS agar_games_played INTEGER DEFAULT 0;
    ALTER TABLE accounts ADD COLUMN IF NOT EXISTS privy_wallet_id TEXT;
  `);
  console.log('[DB] Tables ready');
}

// ─── Accounts ─────────────────────────────────────────────────────────────────

async function getAccountByGoogleId(googleId) {
  const res = await pool.query('SELECT * FROM accounts WHERE google_id = $1', [googleId]);
  return res.rows[0] ? dbToAccount(res.rows[0]) : null;
}

async function getAccountByWallet(walletAddress) {
  const res = await pool.query('SELECT * FROM accounts WHERE wallet_address = $1', [walletAddress]);
  return res.rows[0] ? dbToAccount(res.rows[0]) : null;
}

async function saveAccount(googleId, updates) {
  const fields = [];
  const values = [];
  let i = 1;
  if (updates.name          !== undefined) { fields.push(`name = $${i++}`);           values.push(updates.name); }
  if (updates.balance       !== undefined) { fields.push(`balance = $${i++}`);        values.push(updates.balance); }
  if (updates.highScore     !== undefined) { fields.push(`high_score = $${i++}`);     values.push(updates.highScore); }
  if (updates.gamesPlayed   !== undefined) { fields.push(`games_played = $${i++}`);   values.push(updates.gamesPlayed); }
  if (updates.walletAddress !== undefined) { fields.push(`wallet_address = $${i++}`); values.push(updates.walletAddress); }
  if (!fields.length) return getAccountByGoogleId(googleId);
  values.push(googleId);
  const res = await pool.query(
    `UPDATE accounts SET ${fields.join(', ')} WHERE google_id = $${i} RETURNING *`,
    values
  );
  return res.rows[0] ? dbToAccount(res.rows[0]) : null;
}

async function recordGameResult(googleId, score, durationSeconds) {
  await pool.query(
    `UPDATE accounts SET
       games_played      = games_played + 1,
       high_score        = GREATEST(high_score, $2),
       play_time_seconds = play_time_seconds + $3
     WHERE google_id = $1`,
    [googleId, score, durationSeconds || 0]
  );
}

// (Phase B2: getFinancialSummary removed — it summed the vestigial custodial
// accounts.balance for the admin dashboard, which now derives "owed" from live in-game
// stakes instead. See sumLiveSelfCustodyStakes in server/index.js.)

// ─── Deposits ─────────────────────────────────────────────────────────────────

async function isTxUsed(txSig) {
  const res = await pool.query('SELECT 1 FROM deposits WHERE tx_sig = $1', [txSig]);
  return res.rows.length > 0;
}

// ─── Withdrawals ──────────────────────────────────────────────────────────────
// Now used purely as a paid-bot spend ledger (owner expense tracking). The custodial
// deposit/withdraw/settle helpers + the accounts.balance debit were removed with the
// custodial system; this just appends a row so bot costs can be totalled later.

async function recordWithdrawal(googleId, txSig, amount, toAddress) {
  await pool.query(
    `INSERT INTO withdrawals (google_id, tx_sig, amount, to_address) VALUES ($1, $2, $3, $4)`,
    [googleId, txSig, amount, toAddress]
  );
}

// Persist a collusion flag raised by CollusionMonitor for later owner review.
async function recordCollusionFlag(f) {
  await pool.query(
    `INSERT INTO collusion_flags
       (src_google_id, dst_google_id, net_sol, total_sol, transfer_count, one_way_ratio, concentration, lobby_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [f.src, f.dst, f.netSol, f.totalSol, f.count, f.oneWayRatio, f.concentration, f.lobbyType]
  );
}

async function getRecentCollusionFlags(limit = 100) {
  const res = await pool.query(
    `SELECT c.*, a1.name AS src_name, a2.name AS dst_name
       FROM collusion_flags c
       LEFT JOIN accounts a1 ON a1.google_id = c.src_google_id
       LEFT JOIN accounts a2 ON a2.google_id = c.dst_google_id
      ORDER BY c.flagged_at DESC
      LIMIT $1`,
    [limit]
  );
  return res.rows;
}

// Phase 1 self-custody stakes: durable one-time-use guard so a stake signature can't be
// replayed for a second free entry (survives restarts; the in-memory set does not).
async function isStakeSigUsed(sig) {
  const r = await pool.query(`SELECT 1 FROM used_stake_sigs WHERE sig = $1`, [sig]);
  return r.rowCount > 0;
}
async function markStakeSig(sig) {
  await pool.query(`INSERT INTO used_stake_sigs (sig) VALUES ($1) ON CONFLICT DO NOTHING`, [sig]);
}

async function addEarnings(googleId, sol, cadAmount = 0) {
  await Promise.all([
    pool.query(`UPDATE accounts SET total_earnings = total_earnings + $2 WHERE google_id = $1`, [googleId, sol]),
    pool.query(`INSERT INTO earnings_history (google_id, amount, cad_amount) VALUES ($1, $2, $3)`, [googleId, sol, cadAmount]),
  ]);
}

async function getTopEarners(n) {
  const res = await pool.query(
    `SELECT google_id AS id, name, total_earnings AS earnings
     FROM accounts WHERE total_earnings != 0 ORDER BY total_earnings DESC LIMIT $1`,
    [n]
  );
  return res.rows.map((r, i) => ({
    rank: i + 1,
    name: r.name,
    earnings: parseFloat(r.earnings),
  }));
}

// Upsert earnings keyed by a stable id — a wallet address for self-custody players (who have
// no google_id account row), so they appear on the top-earners board. Always refreshes the name.
async function recordEarnings(id, name, sol, cadAmount = 0) {
  await pool.query(
    `INSERT INTO accounts (google_id, name, total_earnings) VALUES ($1, $2, $3)
     ON CONFLICT (google_id) DO UPDATE SET total_earnings = COALESCE(accounts.total_earnings, 0) + $3, name = $2`,
    [id, name || 'Player', sol]
  );
  await pool.query(`INSERT INTO earnings_history (google_id, amount, cad_amount) VALUES ($1, $2, $3)`, [id, sol, cadAmount]);
}

async function recordAgarGameResult(googleId, score) {
  await pool.query(
    `UPDATE accounts SET
       agar_games_played = agar_games_played + 1,
       agar_high_score   = GREATEST(agar_high_score, $2)
     WHERE google_id = $1`,
    [googleId, score]
  );
}

async function getGlobalWinnings() {
  const res = await pool.query(
    `SELECT COALESCE(SUM(cad_amount), 0) AS total FROM earnings_history WHERE cad_amount > 0`
  );
  return parseFloat(res.rows[0].total); // already in CAD
}

async function searchPlayerNames(query, limit = 8) {
  const res = await pool.query(
    `SELECT name FROM accounts WHERE name ILIKE $1 ORDER BY name ASC LIMIT $2`,
    [`${query}%`, limit]
  );
  return res.rows.map(r => r.name);
}

async function pushNameHistory(googleId, name) {
  // Prepend name, deduplicate, keep last 3
  await pool.query(
    `UPDATE accounts
     SET name_history = ARRAY(
       SELECT DISTINCT ON (n) n FROM UNNEST(ARRAY[$2::text] || name_history) AS n
       LIMIT 3
     )
     WHERE google_id = $1`,
    [googleId, name]
  );
}

async function getMyProfile(googleId) {
  const accRes = await pool.query(
    `SELECT name, total_earnings, games_played, play_time_seconds, name_history
     FROM accounts WHERE google_id = $1`,
    [googleId]
  );
  if (!accRes.rows[0]) return null;
  const row = accRes.rows[0];

  const gamesRes = await pool.query(
    `SELECT amount, created_at FROM earnings_history
     WHERE google_id=$1 ORDER BY created_at ASC`,
    [googleId]
  );
  const games = gamesRes.rows.map(r => ({
    amount: parseFloat(r.amount),
    at: r.created_at,
  }));

  return {
    name: row.name,
    totalEarnings: parseFloat(row.total_earnings || 0),
    gamesPlayed: parseInt(row.games_played || 0),
    playTimeSeconds: parseInt(row.play_time_seconds || 0),
    nameHistory: row.name_history || [],
    games,
  };
}

async function isNameTaken(name, excludeGoogleId) {
  const res = await pool.query(
    `SELECT 1 FROM accounts WHERE LOWER(name) = LOWER($1) AND google_id != $2`,
    [name, excludeGoogleId]
  );
  return res.rows.length > 0;
}

// (Phase B2: the 2FA / device-trust DB helpers — saveVerificationCode, verifyCode,
// addTrustedDevice, isDeviceTrusted, getGoogleIdByDeviceToken — were removed along with
// Google login. The verification_codes / trusted_devices tables are now vestigial.)

async function getProfile(name) {
  const accRes = await pool.query(
    `SELECT google_id, name, total_earnings, games_played, play_time_seconds
     FROM accounts WHERE LOWER(name) = LOWER($1)`,
    [name]
  );
  if (!accRes.rows[0]) return null;
  const row = accRes.rows[0];
  const gid = row.google_id;

  const mapRows = rows => rows.map(r => ({ period: r.period, total: parseFloat(r.total) }));

  const [week, month, sixMonth, allTime] = await Promise.all([
    pool.query(`SELECT DATE_TRUNC('day', created_at) AS period, SUM(amount) AS total
      FROM earnings_history WHERE google_id=$1 AND created_at >= NOW()-INTERVAL '7 days'
      GROUP BY period ORDER BY period ASC`, [gid]),
    pool.query(`SELECT DATE_TRUNC('day', created_at) AS period, SUM(amount) AS total
      FROM earnings_history WHERE google_id=$1 AND created_at >= NOW()-INTERVAL '30 days'
      GROUP BY period ORDER BY period ASC`, [gid]),
    pool.query(`SELECT DATE_TRUNC('week', created_at) AS period, SUM(amount) AS total
      FROM earnings_history WHERE google_id=$1 AND created_at >= NOW()-INTERVAL '6 months'
      GROUP BY period ORDER BY period ASC`, [gid]),
    pool.query(`SELECT DATE_TRUNC('month', created_at) AS period, SUM(amount) AS total
      FROM earnings_history WHERE google_id=$1
      GROUP BY period ORDER BY period ASC`, [gid]),
  ]);

  return {
    name: row.name,
    totalEarnings: parseFloat(row.total_earnings || 0),
    gamesPlayed: parseInt(row.games_played || 0),
    playTimeSeconds: parseInt(row.play_time_seconds || 0),
    history: {
      week: mapRows(week.rows),
      month: mapRows(month.rows),
      sixMonth: mapRows(sixMonth.rows),
      allTime: mapRows(allTime.rows),
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function dbToAccount(row) {
  return {
    googleId:     row.google_id,
    email:        row.email,
    name:         row.name,
    avatar:       row.avatar,
    balance:      parseFloat(row.balance || 0),
    highScore:     parseInt(row.high_score || 0),
    agarHighScore:   parseInt(row.agar_high_score   || 0),
    agarGamesPlayed: parseInt(row.agar_games_played || 0),
    gamesPlayed:     parseInt(row.games_played      || 0),
    walletAddress:  row.wallet_address,
    privyWalletId:  row.privy_wallet_id,
  };
}

module.exports = {
  init, pool,
  getAccountByGoogleId, getAccountByWallet,
  saveAccount, recordGameResult, recordAgarGameResult,
  isTxUsed, recordWithdrawal,
  recordCollusionFlag, getRecentCollusionFlags,
  isStakeSigUsed, markStakeSig,
  addEarnings, recordEarnings, getTopEarners,
  isNameTaken,
  getProfile, getMyProfile, pushNameHistory, searchPlayerNames, getGlobalWinnings,
};
