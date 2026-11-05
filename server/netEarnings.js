'use strict';
/* Net earnings: what a player has really made from paid play, after the 10% cut (Owen 2026-11-05: "Total earnings"
   must be the true amount, so joining a $1 match and cashing out without gaining anything shows -$0.10).

     net = paid out - paid in + refunds the ledger recorded

   paid out   every landed payout booked to the wallet (earnings_history: cash-outs, duel prizes, battle royale prizes).
              Written only once the transfer landed, by the inline payout or the drainer, never for an owed row.
   paid in    every paid entry the player was seated with (stakes_history, written by recordEntry). A refund at the
              door (never seated) never wrote one, so it never counts in or out.
   refunds    a refund of a SEATED entry that was paid through the owed lane: a failed_payouts row the drainer settled
              (paid = true) whose reason begins 'refund' and whose key is an inline payout's ('payout:') or a keyed
              owed row's ('agowed:'). Those never reach earnings_history (a refund is not winnings), so without this
              term a refunded round would read as a lost one. A stake-ledger refund (stake_sig is the stake's own
              signature) is a refund of an entry that was never seated and has no stakes_history row, so it is left
              out, as are the unkeyed refund rows, which are door refunds of unseated entries too.
              Duel refunds landed before 2026-10-29 were booked as payouts (earnings_history), which already cancels
              their stake row.

   Counted from the first recorded buy-in (the earliest stakes_history row, 2026-08-15): before it only payouts were
   recorded, and a payout with its buy-in missing would overstate what a player made. The SOL-era rows (before the
   2026-06-24 USDC cutover, in another unit) are older still, so they are never mixed in either.

   Read only. Nothing here writes, moves money or changes a payout; it reads three ledger tables the money paths
   already write. Pure where it can be: the SQL is strings, the sums are done in whole micro-dollars here so the
   cents shown are exact, and the tests drive summarize/boardRows directly. */

/* The first recorded buy-in. stakes_history is append-only, so once this is known it never changes. */
const SINCE_SQL = `SELECT min(created_at) AS t FROM stakes_history`;

/* A refund the owed lane paid for a seated entry: the inline payout's key ('payout:' + a UUID, in stake_sig, or at the
   end of the reason when the durable-stakes columns are missing) or a keyed owed row's ('agowed:' + a UUID). */
const REFUND_BACK = `f.paid = true
     AND f.reason LIKE 'refund%'
     AND (COALESCE(f.stake_sig, '') || ' ' || f.reason) ~ '(payout|agowed):[0-9a-f-]{36}'`;

/* One wallet. $1 wallet, $2 since (the first recorded buy-in; NULL counts nothing). */
const NET_ONE_SQL = `SELECT
  (SELECT COALESCE(sum(e.amount), 0) FROM earnings_history e
    WHERE e.google_id = $1 AND e.created_at >= $2::timestamptz)::text AS paid_out,
  (SELECT count(*) FROM earnings_history e
    WHERE e.google_id = $1 AND e.created_at >= $2::timestamptz)::int AS cashouts,
  (SELECT COALESCE(sum(s.amount), 0) FROM stakes_history s
    WHERE s.google_id = $1 AND s.amount > 0)::text AS paid_in,
  (SELECT count(*) FROM stakes_history s
    WHERE s.google_id = $1 AND s.amount > 0)::int AS rounds,
  (SELECT COALESCE(sum(f.amount_sol), 0) FROM failed_payouts f
    WHERE f.wallet_address = $1 AND f.created_at >= $2::timestamptz
     AND ${REFUND_BACK})::text AS refunded`;

/* Top earners: every wallet with a recorded round or payout, ranked by its net, players who are up only.
   $1 wallets left out (the owner wallets, the revenue wallet, Owen's named test wallets, the Bot bank), $2 how many
   rows. The owner stays off every leaderboard (Owen 2026-11-05). Bots have no wallet, so no row. game: the one with the most paid
   rounds, a tie going to the one played last. */
const NET_BOARD_SQL = `WITH since AS (SELECT min(created_at) AS t FROM stakes_history),
ins AS (
  SELECT s.google_id AS w, sum(s.amount) AS v, count(*) AS n
    FROM stakes_history s WHERE s.amount > 0 GROUP BY 1),
games AS (
  SELECT DISTINCT ON (g.w) g.w, g.game
    FROM (SELECT s.google_id AS w, s.game, count(*) AS n, max(s.created_at) AS last
            FROM stakes_history s WHERE s.amount > 0 GROUP BY 1, 2) g
   ORDER BY g.w, g.n DESC, g.last DESC),
outs AS (
  SELECT e.google_id AS w, sum(e.amount) AS v, count(*) AS n
    FROM earnings_history e, since WHERE e.created_at >= since.t GROUP BY 1),
backs AS (
  SELECT f.wallet_address AS w, sum(f.amount_sol) AS v
    FROM failed_payouts f, since WHERE f.created_at >= since.t AND ${REFUND_BACK} GROUP BY 1),
ws AS (SELECT w FROM ins UNION SELECT w FROM outs UNION SELECT w FROM backs),
nets AS (
  SELECT ws.w, COALESCE(o.v, 0) AS paid_out, COALESCE(o.n, 0) AS cashouts, COALESCE(i.v, 0) AS paid_in,
         COALESCE(i.n, 0) AS rounds, COALESCE(b.v, 0) AS refunded, g.game,
         COALESCE(o.v, 0) - COALESCE(i.v, 0) + COALESCE(b.v, 0) AS net
    FROM ws LEFT JOIN ins i ON i.w = ws.w LEFT JOIN outs o ON o.w = ws.w LEFT JOIN backs b ON b.w = ws.w
            LEFT JOIN games g ON g.w = ws.w
   WHERE ws.w IS NOT NULL AND ws.w <> ALL ($1::text[]))
SELECT n.w AS wallet, a.name, n.paid_out::text AS paid_out, n.cashouts::int AS cashouts, n.paid_in::text AS paid_in,
       n.rounds::int AS rounds, n.refunded::text AS refunded, n.game
  FROM nets n LEFT JOIN accounts a ON a.google_id = n.w
 WHERE n.net > 0
 ORDER BY n.net DESC, n.cashouts DESC, n.w
 LIMIT $2`;

const TOP_N = 10;

// A NUMERIC sum as text to whole micro-dollars (exact to the micro the ledger keeps), NaN when it is not a number.
function toMicro(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 1e6) : NaN;
}
// Micro-dollars to dollars at the cent, rounded half away from zero, never -0.
function toCents(micro) {
  const c = Math.sign(micro) * Math.round(Math.abs(micro) / 1e4);
  return c === 0 ? 0 : c / 100;
}

/* One row of NET_ONE_SQL (or of the board) to { net, paidOut, paidIn, refunded, cashouts, rounds } in dollars at the
   cent. A missing row is an account with nothing recorded: all zero. Null for a row that cannot be trusted. */
function summarize(row) {
  const r = row || {};
  const out = toMicro(r.paid_out), inn = toMicro(r.paid_in), back = toMicro(r.refunded);
  if (![out, inn, back].every(Number.isFinite)) return null;
  return {
    net: toCents(out - inn + back),
    paidOut: toCents(out),
    paidIn: toCents(inn),
    refunded: toCents(back),
    cashouts: Math.max(0, Math.floor(Number(r.cashouts) || 0)),
    rounds: Math.max(0, Math.floor(Number(r.rounds) || 0)),
  };
}

/* NET_BOARD_SQL rows to the board the lobby draws: [{ rank, name, game, amount, n }], the shape /api/earnings/board
   always answered (amount is the net now, n the landed cash-outs). Null for a row set that cannot be trusted. */
function boardRows(rows) {
  if (!Array.isArray(rows)) return null;
  const { displayName, gameLabel } = require('./earnings');   // here, not at the top: server/earnings requires this file
  const out = [];
  for (const r of rows) {
    if (!r || typeof r.wallet !== 'string' || !r.wallet) return null;
    const s = summarize(r);
    if (!s) return null;
    if (!(s.net > 0)) continue;
    out.push({ name: displayName(r.name, r.wallet), game: gameLabel(r.game), amount: s.net, n: s.cashouts });
  }
  return out.slice(0, TOP_N).map((x, i) => ({ rank: i + 1, ...x }));
}

function boardParams(exclude, n = TOP_N) {
  return [exclude.slice(), n];
}

module.exports = { SINCE_SQL, NET_ONE_SQL, NET_BOARD_SQL, REFUND_BACK, TOP_N, summarize, boardRows, boardParams, toMicro, toCents };
