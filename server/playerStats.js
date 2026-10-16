'use strict';
/* The Social tab's server side that is not the board: player search, opening a
   profile by its short wallet, and a profile's win rate. Pure where it can be,
   so test/socialUpgrades.test.js drives it without a database.

   WIN RATE (Owen, 2026-10-15). A paid round is one row of stakes_history (one
   per paid entry, written when the player is seated). It is WON when a cash-out
   landed for that player before their next paid entry and the take-home beat
   the entry: you walked away with more than you put in. A death, a cash-out
   for less than the entry, or a payout that never landed is a round played and
   not won. Free games stake nothing and are not counted.

   "Landed" is the earnings strip's rule word for word (server/earnings,
   EARNINGS_SQL): a game_rake row with a matching earnings_history row inside
   the window and no failed_payouts row. Take-home is 9 x the rake there too.
   Counted from the USDC cutover, as the strip is, because the SOL-era stakes
   were in a different unit. */

const { EARNINGS_SQL, gameLabel, shortWallet } = require('./earnings');
const { TOP_ROWS } = require('./sl/slTopCashout');

const SINCE = TOP_ROWS.C_TOP_SINCE.value;
const LANDED = TOP_ROWS.C_TOP_LANDED.value;

// The strip's landed test, cut out of its own SQL so the two cannot drift. $3 window (s), $4 tolerance.
const LANDED_CLAUSE = EARNINGS_SQL.slice(
  EARNINGS_SQL.indexOf('AND EXISTS (SELECT 1 FROM earnings_history e'),
  EARNINGS_SQL.indexOf('GROUP BY'),
).trim();

/* $1 wallet, $2 since, $3 landed window (s), $4 amount tolerance (USDC).
   One row per game: rounds entered and rounds won. */
const WIN_SQL = `WITH st AS (
  SELECT game, amount, created_at,
         lead(created_at) OVER (ORDER BY created_at, id) AS next_at
    FROM stakes_history
   WHERE google_id = $1
     AND created_at >= $2::timestamptz
     AND amount > 0
)
SELECT COALESCE(st.game, '') AS game,
       count(*)::int AS entered,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM house_revenue h
          WHERE h.source = 'game_rake'
            AND h.amount_usdc > 0
            AND h.player_wallet = $1
            AND h.created_at >= st.created_at
            AND (st.next_at IS NULL OR h.created_at < st.next_at)
            AND 9 * h.amount_usdc > st.amount
            ${LANDED_CLAUSE}
       ))::int AS won
  FROM st
 GROUP BY 1`;

function winParams(wallet) {
  return [wallet, SINCE, LANDED.windowS, LANDED.tolMicro / 1e6];
}

/* Rows from WIN_SQL to { entered, won, since, games: [{ game, entered, won }] }.
   'snake' and 'slither' are one game to a player, so labels are merged. */
function summarizeWins(rows) {
  const by = new Map();
  let entered = 0, won = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    const e = Math.max(0, Math.floor(Number(r && r.entered) || 0));
    const w = Math.min(e, Math.max(0, Math.floor(Number(r && r.won) || 0)));
    if (!e) continue;
    const g = gameLabel(r.game) || 'Other';
    const cur = by.get(g) || { game: g, entered: 0, won: 0 };
    cur.entered += e; cur.won += w;
    by.set(g, cur);
    entered += e; won += w;
  }
  const games = [...by.values()].sort((a, b) => (b.entered - a.entered) || (a.game < b.game ? -1 : 1));
  return { entered, won, since: SINCE, games };
}

/* ─── Search ────────────────────────────────────────────────────────────────
   The query a person typed, made safe to look for: a string, no control
   characters, at most NAME_MAX characters (no name is longer, so a longer
   query can only miss). LIKE's own wildcards are escaped, so "%" finds a
   literal percent sign and not every player on the site. */
const NAME_MAX = 24;
const SEARCH_LIMIT = 8;

function cleanQuery(q) {
  if (typeof q !== 'string') return '';
  return q.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NAME_MAX);
}
const escLike = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);

/* Anywhere in the name, names that START with it first, then shorter names
   (closer to what was typed), then A to Z. Unnamed accounts ('Player' or no
   name) are never returned: they have nothing to search by. */
const SEARCH_SQL = `SELECT name FROM accounts
 WHERE name IS NOT NULL
   AND lower(name) <> 'player'
   AND name ILIKE $1 ESCAPE '\\'
 ORDER BY (lower(name) LIKE $2 ESCAPE '\\') DESC, length(name) ASC, lower(name) ASC
 LIMIT $3`;

function searchParams(q, limit) {
  const e = escLike(q.toLowerCase());
  const n = Math.max(1, Math.min(SEARCH_LIMIT, Math.floor(Number(limit) || SEARCH_LIMIT)));
  return ['%' + e + '%', e + '%', n];
}

/* ─── A profile by its short wallet ───────────────────────────────────────────
   A player who never set a name shows on the board as their short wallet
   (C5cn…H3m9, server/earnings shortWallet). That is all anyone outside sees,
   so it is also what opens their profile: base58 only, which leaves nothing
   for LIKE to treat as a wildcard. Exactly one match or nothing. */
const B58 = '[1-9A-HJ-NP-Za-km-z]';
const SHORT_WALLET_RE = new RegExp('^(' + B58 + '{4})(?:…|\\.\\.\\.)(' + B58 + '{4})$');

function parseShortWallet(s) {
  const m = SHORT_WALLET_RE.exec(String(s || ''));
  return m ? { head: m[1], tail: m[2] } : null;
}

const SHORT_WALLET_SQL = `SELECT google_id FROM accounts
 WHERE google_id LIKE $1 AND length(google_id) BETWEEN 32 AND 44
   AND (name IS NULL OR lower(name) = 'player')
 LIMIT 2`;

module.exports = {
  WIN_SQL, winParams, summarizeWins, LANDED_CLAUSE,
  SEARCH_SQL, searchParams, cleanQuery, escLike, NAME_MAX, SEARCH_LIMIT,
  SHORT_WALLET_SQL, parseShortWallet, shortWallet,
};
