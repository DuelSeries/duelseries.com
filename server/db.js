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

    CREATE TABLE IF NOT EXISTS failed_payouts (
      id             SERIAL PRIMARY KEY,
      wallet_address TEXT NOT NULL,
      amount_sol     NUMERIC(18,9) NOT NULL,
      name           TEXT,
      reason         TEXT,
      paid           BOOLEAN DEFAULT FALSE,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    );
    -- Retry-queue columns for the idempotent payout drainer. signature/signed_tx let a retry
    -- re-broadcast the SAME transaction (so it can never double-pay) instead of building a new one.
    ALTER TABLE failed_payouts ADD COLUMN IF NOT EXISTS attempts INT DEFAULT 0;
    ALTER TABLE failed_payouts ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;
    ALTER TABLE failed_payouts ADD COLUMN IF NOT EXISTS signature TEXT;
    ALTER TABLE failed_payouts ADD COLUMN IF NOT EXISTS signed_tx TEXT;
    ALTER TABLE failed_payouts ADD COLUMN IF NOT EXISTS blockhash TEXT;
    ALTER TABLE failed_payouts ADD COLUMN IF NOT EXISTS last_valid_block_height BIGINT;
    ALTER TABLE failed_payouts ADD COLUMN IF NOT EXISTS paid_sig TEXT;

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

    -- What a player put IN. earnings_history only ever recorded what came back,
    -- so the product could say what someone had taken out but never whether
    -- they were up: profit needs both halves. Append-only, one row per paid
    -- entry, written when the entry token is consumed.
    CREATE TABLE IF NOT EXISTS stakes_history (
      id         SERIAL PRIMARY KEY,
      google_id  TEXT NOT NULL,
      amount     NUMERIC(18,9) NOT NULL,
      game       TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_sh_gid ON stakes_history(google_id, created_at);

    ALTER TABLE accounts ADD COLUMN IF NOT EXISTS name_history TEXT[] DEFAULT '{}';
    /* Not IF NOT EXISTS alone: this can fail outright on a table that already
       holds two accounts with the same name, which is possible because names
       were never unique before. Wrapped so a failure leaves the check-then-write
       in setAccountName as the only guard rather than stopping startup.

       $$, not $. Postgres dollar-quoting is $tag$ and a bare $ is a syntax
       error, and this whole template is ONE statement, so getting it wrong did
       not just skip the index — it aborted every CREATE and ALTER in the file
       on every boot. The schema silently stopped moving. */
    DO $$ BEGIN
      BEGIN
        CREATE UNIQUE INDEX IF NOT EXISTS accounts_name_lower_uniq
          ON accounts (LOWER(name)) WHERE name IS NOT NULL;
      EXCEPTION WHEN others THEN
        RAISE NOTICE 'accounts_name_lower_uniq not created: %', SQLERRM;
      END;
    END $$;
    ALTER TABLE accounts ADD COLUMN IF NOT EXISTS agar_high_score INTEGER DEFAULT 0;
    ALTER TABLE accounts ADD COLUMN IF NOT EXISTS agar_total_earnings NUMERIC(18,9) DEFAULT 0;
    ALTER TABLE accounts ADD COLUMN IF NOT EXISTS agar_games_played INTEGER DEFAULT 0;
    ALTER TABLE accounts ADD COLUMN IF NOT EXISTS privy_wallet_id TEXT;

    CREATE TABLE IF NOT EXISTS cosmetics_owned (
      wallet_address TEXT NOT NULL,
      item_id        TEXT NOT NULL,
      tx_sig         TEXT,
      paid_usdc      NUMERIC(18,6),
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (wallet_address, item_id)
    );

    CREATE TABLE IF NOT EXISTS house_revenue (
      id            SERIAL PRIMARY KEY,
      source        TEXT NOT NULL,            -- 'game_rake' | 'cosmetic' | 'bot_fee'
      game          TEXT,                     -- 'slither' | 'agar' | NULL
      amount_usdc   NUMERIC(18,6) NOT NULL,
      player_wallet TEXT,
      player_name   TEXT,
      lobby_type    TEXT,
      region        TEXT,
      tx_sig        TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_hr_created ON house_revenue(created_at);
    CREATE INDEX IF NOT EXISTS idx_hr_source  ON house_revenue(source);
  `);
  console.log('[DB] Tables ready');
}

// ─── Accounts ─────────────────────────────────────────────────────────────────
// (Custodial/2FA-era account getters — getAccountByGoogleId/getAccountByWallet/saveAccount and
// their dbToAccount mapper — were removed: nothing reads the vestigial accounts.balance any more.)

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
// Atomically claim a stake signature for one-time use. Returns true if THIS call claimed it
// (row newly inserted), false if it was already used. The INSERT…ON CONFLICT is atomic, so
// concurrent requests with the same sig can't both succeed — closes the double-mint race.
async function markStakeSig(sig) {
  const r = await pool.query(
    `INSERT INTO used_stake_sigs (sig) VALUES ($1) ON CONFLICT DO NOTHING RETURNING sig`,
    [sig]
  );
  return r.rowCount > 0;
}

// A self-custody cash-out that ultimately failed on-chain (e.g. an RPC outage). Recorded
// durably so the owed SOL is never silently lost — the owner reconciles + pays it out manually
// via /api/admin/failed-payouts. No auto-retry, because blindly re-sending could double-pay if
// the original tx actually landed but its confirmation was what failed.
async function recordFailedPayout(walletAddress, amountSol, name, reason, broadcast) {
  const b = broadcast || {};
  await pool.query(
    `INSERT INTO failed_payouts (wallet_address, amount_sol, name, reason, signature, signed_tx, blockhash, last_valid_block_height)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [walletAddress, amountSol, name || null, (reason || '').slice(0, 500),
     b.signature || null, b.signedTx || null, b.blockhash || null, b.lastValidBlockHeight || null]
  );
}

async function getFailedPayouts(limit = 200) {
  const res = await pool.query(
    `SELECT id, wallet_address, amount_sol, name, reason, paid, paid_sig, attempts, last_attempt_at, created_at
       FROM failed_payouts ORDER BY paid ASC, created_at DESC LIMIT $1`,
    [limit]
  );
  return res.rows.map(r => ({ ...r, amount_sol: parseFloat(r.amount_sol) }));
}

// Atomically claim the next owed-but-unpaid payout that's due for a retry, bumping its attempt
// counter so two ticks/servers can't grab the same row (SKIP LOCKED). Returns the row or null.
async function claimDuePayout(retrySeconds = 30, maxAttempts = 200) {
  const res = await pool.query(
    `UPDATE failed_payouts SET attempts = attempts + 1, last_attempt_at = NOW()
       WHERE id = (
         SELECT id FROM failed_payouts
          WHERE paid = false AND attempts < $2
            AND (last_attempt_at IS NULL OR last_attempt_at < NOW() - make_interval(secs => $1))
          ORDER BY created_at ASC
          LIMIT 1 FOR UPDATE SKIP LOCKED
       )
     RETURNING id, wallet_address, amount_sol, name, signature, signed_tx, blockhash, last_valid_block_height, attempts`,
    [retrySeconds, maxAttempts]
  );
  if (!res.rows[0]) return null;
  const r = res.rows[0];
  r.amount_sol = parseFloat(r.amount_sol);
  return r;
}

// Persist the signed tx + signature the drainer just built for a payout, BEFORE it is sent, so
// a crash mid-send is still recoverable (the same bytes can only ever land once).
async function savePayoutSignature(id, b) {
  await pool.query(
    `UPDATE failed_payouts SET signature = $2, signed_tx = $3, blockhash = $4, last_valid_block_height = $5 WHERE id = $1`,
    [id, b.signature || null, b.signedTx || null, b.blockhash || null, b.lastValidBlockHeight || null]
  );
}

async function markPayoutPaid(id, paidSig) {
  await pool.query(`UPDATE failed_payouts SET paid = true, paid_sig = $2 WHERE id = $1`, [id, paidSig || null]);
}

async function getTopEarners(n) {
  // Top earners = net-positive only. Some legacy custodial-era rows have negative
  // total_earnings; the current cash-out path only ever adds positive winnings, so anyone
  // truly "owed nothing" or net-negative shouldn't appear on a winners board.
  const res = await pool.query(
    `SELECT google_id AS id, name, total_earnings AS earnings
     FROM accounts WHERE total_earnings > 0 ORDER BY total_earnings DESC LIMIT $1`,
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

// The other half of a player's ledger: what they paid to enter. Callers use
// .catch() and never await this — a failed write must cost someone a stats row,
// never their seat in a game they have already paid for.
async function recordStake(id, amount, game = null) {
  const amt = Number(amount);
  if (!id || !Number.isFinite(amt) || amt <= 0) return;   // free play stakes nothing
  await pool.query(
    `INSERT INTO stakes_history (google_id, amount, game) VALUES ($1, $2, $3)`,
    [id, amt, game]
  );
}

// ─── House revenue (the owner's take: game rake + cosmetic sales) ────────────────
// One append-only ledger of everything the house earns, so the owner can see total
// take at a glance. Callers use .catch() — a missed revenue log must never break a
// cashout or a purchase.
async function recordHouseRevenue({ source, game = null, amountUsdc, wallet = null, name = null, lobbyType = null, region = null, txSig = null }) {
  const amt = Number(amountUsdc);
  if (!Number.isFinite(amt) || amt === 0) return; // allow negatives (e.g. bot-entry costs)
  await pool.query(
    `INSERT INTO house_revenue (source, game, amount_usdc, player_wallet, player_name, lobby_type, region, tx_sig)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [source, game, amt, wallet, name, lobbyType, region, txSig]
  );
}

// Totals for the owner earnings dashboard: grand total + per-source + per-lobby + today/7d/30d.
async function getHouseRevenueSummary() {
  const [bySource, byLobby, grand, today, last7, last30] = await Promise.all([
    pool.query(`SELECT source, COALESCE(SUM(amount_usdc),0) AS total, COUNT(*) AS n FROM house_revenue GROUP BY source`),
    pool.query(`SELECT COALESCE(lobby_type,'unknown') AS lobby, COALESCE(SUM(amount_usdc),0) AS total, COUNT(*) AS n FROM house_revenue GROUP BY lobby_type`),
    pool.query(`SELECT COALESCE(SUM(amount_usdc),0) AS total, COUNT(*) AS n FROM house_revenue`),
    pool.query(`SELECT COALESCE(SUM(amount_usdc),0) AS total FROM house_revenue WHERE created_at >= date_trunc('day', NOW())`),
    pool.query(`SELECT COALESCE(SUM(amount_usdc),0) AS total FROM house_revenue WHERE created_at >= NOW() - INTERVAL '7 days'`),
    pool.query(`SELECT COALESCE(SUM(amount_usdc),0) AS total FROM house_revenue WHERE created_at >= NOW() - INTERVAL '30 days'`),
  ]);
  return {
    total:  parseFloat(grand.rows[0].total),
    count:  parseInt(grand.rows[0].n, 10),
    today:  parseFloat(today.rows[0].total),
    last7:  parseFloat(last7.rows[0].total),
    last30: parseFloat(last30.rows[0].total),
    bySource: bySource.rows.map(r => ({ source: r.source, total: parseFloat(r.total), count: parseInt(r.n, 10) })),
    byLobby:  byLobby.rows.map(r => ({ lobby: r.lobby, total: parseFloat(r.total), count: parseInt(r.n, 10) })),
  };
}

// Daily net earnings for the dashboard trend chart (last `days` days, oldest first).
async function getHouseRevenueDaily(days = 30) {
  const r = await pool.query(
    `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
            COALESCE(SUM(amount_usdc),0) AS total
       FROM house_revenue
      WHERE created_at >= NOW() - ($1 || ' days')::interval
      GROUP BY day ORDER BY day ASC`,
    [days]
  );
  return r.rows.map(x => ({ day: x.day, total: parseFloat(x.total) }));
}

// Most recent revenue events for the dashboard's live feed.
async function getRecentHouseRevenue(limit = 30) {
  const r = await pool.query(
    `SELECT source, game, amount_usdc, player_name, lobby_type, region, created_at
       FROM house_revenue ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return r.rows.map(x => ({
    source: x.source, game: x.game, amount: parseFloat(x.amount_usdc),
    name: x.player_name, lobbyType: x.lobby_type, region: x.region, at: x.created_at,
  }));
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

/* The display name, stored on the account so it is the same on every device
   the player signs in from. It used to live only in each browser's
   localStorage, so the same person on a phone and a laptop was two names.

   Upsert, because an account row is only created when earnings are first
   recorded — somebody can pick a name before they have ever won anything. */
/* Throws NAME_TAKEN if somebody else already has it, compared case-insensitively
   — Owen and owen are the same name to a person, and the profile lookup already
   resolves names with LOWER(), so two accounts sharing one would make that
   lookup ambiguous.

   Checked and then written, which leaves a small race: two people claiming the
   same free name in the same instant both pass the check. The proper close is a
   unique index, attempted at startup — it cannot simply be assumed, because any
   duplicate already sitting in the table would make creating it fail. Where it
   exists, the insert below fails instead and the caller still gets NAME_TAKEN. */
async function setAccountName(googleId, name) {
  const clash = await pool.query(
    `SELECT google_id FROM accounts WHERE LOWER(name) = LOWER($1) AND google_id <> $2 LIMIT 1`,
    [name, googleId]
  );
  if (clash.rows[0]) { const e = new Error('NAME_TAKEN'); e.code = 'NAME_TAKEN'; throw e; }
  try {
    await pool.query(
      `INSERT INTO accounts (google_id, name) VALUES ($1, $2)
       ON CONFLICT (google_id) DO UPDATE SET name = $2`,
      [googleId, name]
    );
  } catch (e) {
    if (e && e.code === '23505') { const t = new Error('NAME_TAKEN'); t.code = 'NAME_TAKEN'; throw t; }
    throw e;
  }
}

async function getMyProfile(googleId) {
  const accRes = await pool.query(
    `SELECT name, total_earnings, games_played, play_time_seconds, name_history,
            created_at
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

  // Buy-ins, so the client can show profit rather than only takings.
  const stakesRes = await pool.query(
    `SELECT amount, created_at FROM stakes_history
     WHERE google_id=$1 ORDER BY created_at ASC`,
    [googleId]
  );
  const stakes = stakesRes.rows.map(r => ({
    amount: parseFloat(r.amount),
    at: r.created_at,
  }));
  const totalStaked = stakes.reduce((a, s) => a + s.amount, 0);

  return {
    name: row.name,
    totalEarnings: parseFloat(row.total_earnings || 0),
    gamesPlayed: parseInt(row.games_played || 0),
    playTimeSeconds: parseInt(row.play_time_seconds || 0),
    nameHistory: row.name_history || [],
    /* When the account was opened. The earnings chart starts here rather than
       at the first cash-out, so a quiet first month reads as a quiet first
       month instead of being cropped out of the picture. */
    joinedAt: row.created_at,
    games,
    stakes,
    totalStaked,
    /* Only meaningful once buy-ins have been recorded. Older accounts have
       payouts stretching back before stakes_history existed, so their net
       would look far better than it was; the flag lets the client say the
       figure is partial instead of quietly overstating it. */
    stakesTracked: stakes.length > 0,
  };
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

// ─── Cosmetics ownership (paid skins/hats/boosts bought with USDC) ──────────────
async function addCosmetic(walletAddress, itemId, txSig, paidUsdc) {
  await pool.query(
    `INSERT INTO cosmetics_owned (wallet_address, item_id, tx_sig, paid_usdc)
     VALUES ($1, $2, $3, $4) ON CONFLICT (wallet_address, item_id) DO NOTHING`,
    [walletAddress, itemId, txSig || null, paidUsdc || null],
  );
}
async function getOwnedCosmetics(walletAddress) {
  if (!walletAddress) return [];
  const r = await pool.query(`SELECT item_id FROM cosmetics_owned WHERE wallet_address = $1`, [walletAddress]);
  return r.rows.map((row) => row.item_id);
}

module.exports = {
  init, pool,
  recordGameResult, recordAgarGameResult,
  recordWithdrawal,
  recordCollusionFlag, getRecentCollusionFlags,
  markStakeSig,
  recordFailedPayout, getFailedPayouts, claimDuePayout, savePayoutSignature, markPayoutPaid,
  recordEarnings,
  recordStake, getTopEarners,
  getProfile, getMyProfile, setAccountName, searchPlayerNames, getGlobalWinnings,
  addCosmetic, getOwnedCosmetics,
  recordHouseRevenue, getHouseRevenueSummary, getRecentHouseRevenue, getHouseRevenueDaily,
};
