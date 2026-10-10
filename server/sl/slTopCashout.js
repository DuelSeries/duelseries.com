'use strict';
// Biggest all-time cash-out box, server side (SERVER-DESIGN 15.4, task T13; SERVER-BUILD-BRIEF D12 and D13).
//
// Owen (OWNER-ANSWERS 2026-10-10): "ALL-TIME biggest cash-out across EVERY game (name and amount)" (14:45) and
// "TAKE-HOME amount (after the 10% cut), every game, NOT counting event prizes, all-time" (17:00).
//
// What counts (SERVER-DESIGN 15.4):
// - one house_revenue row with source 'game_rake' per paid payout, every game: snake (server/index.js:2933),
//   agar and Paper (server/paperPayout.js:71), knockout and battleship (server/index.js:1499, 1530);
// - every rake is a 10 percent cut, so take-home = gross - cut = 9 x cut, rounded to cents;
// - the event prize writes earnings_history only (server/index.js:2190), never a rake row, so it never counts;
// - OWNER_WALLETS and REVENUE_WALLET (both in server/index.js, passed in as excludeWallets) and any test wallet Owen
//   names (C_TOP_EXCLUDE) never count;
// - only a payout that LANDED counts: the rake row is written BEFORE the payout is tried (server/index.js:2933-2960),
//   so a row counts only with an earnings_history row for the same wallet written after it inside the window (the
//   payers write that row only on success, server/index.js:2953, paperPayout.js:91, index.js:1562) whose amount is
//   the take-home of THAT rake, and with no failed_payouts row for the wallet inside the window;
// - nothing qualifies: the genuine empty state ("No cash-outs yet"), never a number.
//
// This file has no database and no money module (SERVER-DESIGN 13 item 11): it requires nothing. It gets ONE read
// function, topCashout(since, exclude), that index.js builds over the database. TOP_SQL is that read's query and
// makeTopCashoutRead(query) turns any query(sql, params) function into it. memTopQuery is the same rule written over
// in-memory rows, one clause for one (there is no Postgres on the dev machine, as scripts/memLedgerDb.js), for tests.
//
// Message pushed to players as sl:x (SERVER-DESIGN 15.4): {t: 'top', name, amount} with amount in dollars at cent
// precision; the empty state is {t: 'top', name: null, amount: null}. get() returns null while the box is hidden:
// no database, or no read has succeeded yet (an unknown answer is never shown as "No cash-outs yet").

// The C_TOP_* rows (SERVER-DESIGN 4.3). Values and sources only; their status lives with the law table.
const TOP_ROWS = Object.freeze({
  // The USDC cutover, commit 2d2c2ab "P7 CUTOVER: flip money mode default to USDC (live)", 2026-06-24 17:07:21 -0400
  // (memory/project_usdc_migration.md). house_revenue itself starts at commit 87996c1 (2026-07-29), so every rake
  // row is in USDC and this is Owen's "all-time".
  C_TOP_SINCE: Object.freeze({
    value: '2026-06-24T21:07:21Z',
    source: 'SERVER-DESIGN 4.3 "since the USDC cutover"; git 2d2c2ab; OWNER-ANSWERS 17:00 "all-time"',
  }),
  // Test wallets Owen has named. None named as of 2026-10-10. OWNER_WALLETS and REVENUE_WALLET come from index.js.
  C_TOP_EXCLUDE: Object.freeze({
    value: Object.freeze([]),
    source: 'SERVER-DESIGN 4.3 and 15.4 "any wallet Owen names as a test wallet"; none named in OWNER-ANSWERS',
  }),
  // The landed match. windowS: SERVER-DESIGN 15.4 "within 10 minutes after it". tolMicro: the largest gap between a
  // payout and 9 x its rake row in the payers' own arithmetic is 9 micro-USDC (Paper and agar: net = gross - floor(gross
  // / 10), server/paperPayout.js:65-66; snake, knockout, battleship: rake stored at 6 decimals, 9 x 0.5 micro), so 10.
  C_TOP_LANDED: Object.freeze({
    value: Object.freeze({ windowS: 600, tolMicro: 10 }),
    source: 'SERVER-DESIGN 15.4 (b); amount match: server/paperPayout.js:65-66, server/db.js:156 NUMERIC(18,6)',
  }),
});
const TOP_LAW_IDS = Object.freeze(['C_TOP_SINCE', 'C_TOP_EXCLUDE', 'C_TOP_LANDED']);

const TOP_PERIOD_MS = 60000;     // SERVER-DESIGN 15.4 "Cached, refreshed every 60 s"
const TAKE_HOME_PER_RAKE = 9;    // a 10 percent cut: index.js:2927, paperPayout.js:14, index.js:1477
const FALLBACK_NAME = 'Player';  // the payers' own fallback name, server/index.js:1562
const EMPTY = Object.freeze({ t: 'top', name: null, amount: null });

// The one read-only query. $1 since, $2 excluded wallets, $3 landed window in seconds, $4 amount tolerance in USDC.
// Ties go to the earlier payout.
const TOP_SQL = `SELECT h.id, h.player_name, h.player_wallet, h.amount_usdc, h.game, h.created_at
  FROM house_revenue h
 WHERE h.source = 'game_rake'
   AND h.amount_usdc > 0
   AND h.created_at >= $1::timestamptz
   AND h.player_wallet IS NOT NULL
   AND h.player_wallet <> ALL ($2::text[])
   AND EXISTS (SELECT 1 FROM earnings_history e
                WHERE e.google_id = h.player_wallet
                  AND e.created_at >= h.created_at
                  AND e.created_at <= h.created_at + make_interval(secs => $3)
                  AND abs(e.amount - 9 * h.amount_usdc) <= $4::numeric)
   AND NOT EXISTS (SELECT 1 FROM failed_payouts f
                    WHERE f.wallet_address = h.player_wallet
                      AND f.created_at >= h.created_at
                      AND f.created_at <= h.created_at + make_interval(secs => $3))
 ORDER BY h.amount_usdc DESC, h.created_at ASC, h.id ASC
 LIMIT 1`;

function topCashoutParams(since, exclude) {
  const L = TOP_ROWS.C_TOP_LANDED.value;
  return [since, exclude.slice(), L.windowS, L.tolMicro / 1e6];
}

// Any query(sql, params) -> Promise<{rows}> becomes the one read function. Resolves null when nothing qualifies.
function makeTopCashoutRead(query) {
  if (typeof query !== 'function') throw new Error('slTopCashout: makeTopCashoutRead needs a query function');
  return (since, exclude) => Promise.resolve(query(TOP_SQL, topCashoutParams(since, exclude))).then((res) => {
    const r = res && res.rows && res.rows[0];
    if (!r) return null;
    return { name: r.player_name, rake: r.amount_usdc, wallet: r.player_wallet, game: r.game, at: r.created_at };
  });
}

// USDC amount (NUMERIC text or number) to an integer count of micro-USDC (the column scale, server/db.js:156).
function toMicro(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 1e6) : NaN;
}

// Take-home in whole cents for one rake amount: 9 x rake, half up.
function takeHomeCents(rake) {
  const micro = toMicro(rake);
  if (!Number.isFinite(micro)) return NaN;
  return Math.round((micro * TAKE_HOME_PER_RAKE) / 1e4);
}

// TOP_SQL over in-memory tables {house_revenue, earnings_history, failed_payouts}, clause for clause. Answers only
// TOP_SQL; anything else is refused, as the free room has no other read.
function memTopQuery(tables) {
  const T = tables || {};
  const hr = T.house_revenue || [];
  const eh = T.earnings_history || [];
  const fp = T.failed_payouts || [];
  const ms = (v) => (v instanceof Date ? v.getTime() : Date.parse(v));
  const nano = (v) => Math.round(Number(v) * 1e9);
  return (sql, params) => {
    if (sql !== TOP_SQL) return Promise.reject(new Error('memTopQuery answers TOP_SQL only'));
    const [since, exclude, windowS, tol] = params;
    const sinceMs = ms(since);
    const winMs = windowS * 1000;
    const tolNano = nano(tol);
    const ok = hr.filter((h) => {
      if (h.source !== 'game_rake') return false;
      if (!(Number(h.amount_usdc) > 0)) return false;
      const t = ms(h.created_at);
      if (!(t >= sinceMs)) return false;
      if (h.player_wallet == null) return false;
      if (exclude.includes(h.player_wallet)) return false;
      const hN = nano(h.amount_usdc);
      const paid = eh.some((e) => e.google_id === h.player_wallet
        && ms(e.created_at) >= t && ms(e.created_at) <= t + winMs
        && Math.abs(nano(e.amount) - TAKE_HOME_PER_RAKE * hN) <= tolNano);
      if (!paid) return false;
      const failed = fp.some((f) => f.wallet_address === h.player_wallet
        && ms(f.created_at) >= t && ms(f.created_at) <= t + winMs);
      return !failed;
    });
    ok.sort((a, b) => (Number(b.amount_usdc) - Number(a.amount_usdc))
      || (ms(a.created_at) - ms(b.created_at)) || (a.id - b.id));
    return Promise.resolve({ rows: ok.slice(0, 1) });
  };
}

function walletList(excludeWallets) {
  const out = [];
  const add = (w) => { if (typeof w === 'string' && w.length > 0 && !out.includes(w)) out.push(w); };
  if (excludeWallets && typeof excludeWallets[Symbol.iterator] === 'function') for (const w of excludeWallets) add(w);
  for (const w of TOP_ROWS.C_TOP_EXCLUDE.value) add(w);
  return out;
}

function createTopCashout({ topCashout, excludeWallets, periodMs = TOP_PERIOD_MS, log = null, every = null } = {}) {
  const say = (m) => {
    try {
      if (typeof log === 'function') log(m);
      else if (log && typeof log.warn === 'function') log.warn(m);
    } catch (_) { /* a logger never breaks the box */ }
  };
  const stats = { reads: 0, fails: 0 };

  // No database (local dev): no box (SERVER-DESIGN 15.4).
  if (typeof topCashout !== 'function') {
    return {
      get: () => null,
      start: () => false,
      stop: () => {},
      refresh: () => Promise.resolve(null),
      stats: () => ({ reads: 0, fails: 0, hidden: true, value: null }),
    };
  }

  const exclude = walletList(excludeWallets);
  if (exclude.length === 0) {
    throw new Error('slTopCashout: excludeWallets must name the owner and revenue wallets');
  }
  if (!(Number.isFinite(periodMs) && periodMs > 0)) throw new Error('slTopCashout: bad periodMs ' + periodMs);
  const since = TOP_ROWS.C_TOP_SINCE.value;

  let current = null;    // null = hidden; EMPTY = "No cash-outs yet"; else {t, name, amount}
  let inFlight = null;
  let timer = null;
  let onChange = null;

  const BAD = {};
  function toMessage(row) {
    if (row === null) return EMPTY;
    if (!row || typeof row !== 'object') return BAD;
    if (typeof row.wallet === 'string' && exclude.includes(row.wallet)) return BAD;
    if (!(Number(row.rake) > 0)) return BAD;
    const cents = takeHomeCents(row.rake);
    if (!Number.isFinite(cents)) return BAD;
    const name = (typeof row.name === 'string' && row.name.trim().length > 0) ? row.name : FALLBACK_NAME;
    return Object.freeze({ t: 'top', name, amount: cents / 100 });
  }

  function notify(msg) {
    if (!onChange) return;
    try { onChange(msg); } catch (e) { say('[sl] top cash-out push threw: ' + (e && e.message)); }
  }

  // Never throws, never rejects. A failed or odd read keeps the last value.
  function refresh() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      let row;
      try {
        row = await topCashout(since, exclude.slice());
      } catch (e) {
        stats.fails++;
        say('[sl] top cash-out read failed, keeping the last value: ' + (e && e.message));
        return current;
      }
      const next = toMessage(row);
      if (next === BAD) {
        stats.fails++;
        say('[sl] top cash-out read gave an unusable row, keeping the last value');
        return current;
      }
      stats.reads++;
      const same = current && current.name === next.name && current.amount === next.amount;
      if (!same) {
        current = next;
        notify(next);
      }
      return current;
    })().finally(() => { inFlight = null; });
    return inFlight;
  }

  function start(cb) {
    if (typeof cb === 'function') onChange = cb;
    if (timer) return true;
    refresh();
    const tick = () => { refresh(); };
    if (typeof every === 'function') timer = { h: every(tick, periodMs, 'slTopCashout') };
    else {
      const h = setInterval(tick, periodMs);
      if (h && typeof h.unref === 'function') h.unref();
      timer = { h, own: true };
    }
    return true;
  }

  function stop() {
    onChange = null;
    if (!timer) return;
    const { h, own } = timer;
    timer = null;
    if (own) clearInterval(h);
    else if (typeof h === 'function') h();
    else if (h && typeof h.stop === 'function') h.stop();
    else clearInterval(h);
  }

  return {
    get: () => current,
    start,
    stop,
    refresh,
    stats: () => ({ reads: stats.reads, fails: stats.fails, hidden: current === null, value: current }),
  };
}

module.exports = {
  createTopCashout,
  makeTopCashoutRead,
  memTopQuery,
  takeHomeCents,
  topCashoutParams,
  TOP_SQL,
  TOP_ROWS,
  TOP_LAW_IDS,
  TOP_PERIOD_MS,
  EMPTY,
};
