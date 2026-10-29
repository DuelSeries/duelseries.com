'use strict';
/* The lobby's "Players have cashed out $X" strip and its top-10 board, server side.

   Read only. This file writes nothing to the database and requires no money
   module: it gets one query function and reads house_revenue the same way the
   biggest-cash-out box does (server/sl/slTopCashout.js), so what counts is the
   same rule in both places:
   - one game_rake row per paid payout, every game; take-home = 9 x the rake;
   - only a payout that LANDED (a matching earnings_history row within the
     window and no failed_payouts row), since the cutover to USDC;
   - never the owner wallets, the revenue wallet, or any test wallet in
     C_TOP_EXCLUDE. Bots have no wallet and never produce a rake row.
   Nothing is ever invented, padded or seeded. No real cash-outs means no strip.

   One database read per REFRESH_MS at most, however many lobbies are open: a
   request after the cache goes stale starts ONE refresh and is answered from
   the last good value (only the very first request waits for a read).

   Names: the player's display name, or a short wallet (C5cn...H3m9) when they
   never set one. A full wallet address never leaves this file.

   Preview: /api/earnings?preview=1 is the same read with the owner's own
   cash-outs let in (the revenue wallet still never counts), so Owen can see
   the strip filled before real players have cashed out. Only the viewer who
   asks for it sees it; the plain endpoint never includes the owner.

   Social's "Global player winnings" (/api/earnings/total) is the strip's total
   out of the same cache, so the two can never disagree: $0 until a real player
   cashes out, then every landed cash-out. The page asks every few seconds and
   is answered from memory. A landed cash-out (db.recordEarnings) pokes the
   cache so the next answer has it, rather than waiting out REFRESH_MS; pokes
   are spaced POKE_MS apart, so a burst of cash-outs is still one read. */

const fs = require('fs');
const path = require('path');
const CONFIG = require('./config');
const { TOP_ROWS } = require('../sl/slTopCashout');
const { INVISIBLE_RE } = require('../chatGuard');

const SINCE = TOP_ROWS.C_TOP_SINCE.value;
const LANDED = TOP_ROWS.C_TOP_LANDED.value;
const TAKE_HOME_PER_RAKE = 9;
const TOP_N = 10;
const WEEK_DAYS = 7;
const NAME_MAX = 24;

/* $1 since, $2 excluded wallets, $3 landed window (s), $4 amount tolerance (USDC), $5 time zone.
   The WHERE clause is TOP_SQL's, clause for clause. One row per player, game and local day. */
const EARNINGS_SQL = `SELECT h.player_wallet AS wallet,
       COALESCE(h.game, '') AS game,
       ((now() AT TIME ZONE $5)::date - (h.created_at AT TIME ZONE $5)::date)::int AS age,
       count(*)::int AS n,
       sum(h.amount_usdc)::text AS rake,
       max(h.amount_usdc)::text AS best_rake,
       max(a.name) AS name
  FROM house_revenue h
  LEFT JOIN accounts a ON a.google_id = h.player_wallet
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
 GROUP BY 1, 2, 3`;

function earningsParams(exclude, timeZone) {
  return [SINCE, exclude.slice(), LANDED.windowS, LANDED.tolMicro / 1e6, timeZone];
}

/* The lobby's "Live wins" row (site sweep 2026-10-28): the most recent landed paid payouts, one row each, newest
   first. The strip's own FROM and WHERE, cut out of EARNINGS_SQL, so a win counts here exactly when it counts in
   the strip: landed, never the revenue wallet or a C_TOP_EXCLUDE test wallet, and never a bot (bots have no wallet
   and make no rake row). The owner's own cash-outs DO count here (Owen 2026-10-28: he plays for real on the owner
   account and wants his wins on the row like anyone's), so this reads with the preview's exclusions; the strip,
   its total and the board still leave the owner out. Only $1..$4: the time zone is the grouping's, not the
   filter's.
   What leaves the server per win is the display name (or the short wallet the board shows), the lobby's game id
   and the take-home amount. No wallet, no time, no signature. */
const RECENT_N = 50;   // the row shows the last 50 wins (Owen 2026-10-28)
/* The owner's own cash-outs count on the row from here on: midnight Eastern, 2026-10-28, the night Owen started
   playing the owner account for real. Before it, every owner cash-out was testing, and 50 of those would fill the
   whole row with one name. Never a reason to leave anyone else out. */
const OWNER_WINS_SINCE = Date.parse('2026-10-28T04:00:00Z');
const RECENT_SQL = `SELECT h.player_wallet AS wallet,
       COALESCE(h.game, '') AS game,
       h.amount_usdc::text AS rake,
       h.created_at AS at,
       a.name AS name
${EARNINGS_SQL.slice(EARNINGS_SQL.indexOf('  FROM house_revenue h'), EARNINGS_SQL.indexOf('\n GROUP BY'))}
 ORDER BY h.created_at DESC
 LIMIT ${RECENT_N}`;
function recentParams(exclude) {
  return earningsParams(exclude, 'UTC').slice(0, 4);
}
// house_revenue.game to the lobby's GAMES id (its card art and name); anything else is not a lobby game and is dropped.
const LOBBY_GAME = Object.freeze({ slither: 'snake', snake: 'snake', ag: 'agar', agar: 'agar' });
function lobbyGame(g) {
  const k = String(g || '').toLowerCase();
  if (LOBBY_GAME[k]) return LOBBY_GAME[k];
  return /^[a-z0-9]{2,16}$/.test(k) ? k : '';
}

const GAME_LABELS = Object.freeze({
  slither: 'Slither.io', snake: 'Slither.io', agar: 'Agar.io', ag: 'Agar.io', paper: 'Paper.io',
  knockout: 'Knockout', battleship: 'Battleship', tanks: 'Awesome Tanks', shooter: 'OMG Shooter',
  swim: require('../../shared/swimSim').NAME,
  headsoccer: 'Head Soccer',
  pool8: '8 Ball Pool',
  airhockey: 'Air Hockey',
  rooftop: 'Rooftop Snipers',
  crossy: 'Crossy Road',
});
function gameLabel(g) {
  const k = String(g || '').toLowerCase();
  if (GAME_LABELS[k]) return GAME_LABELS[k];
  return k ? k.charAt(0).toUpperCase() + k.slice(1) : '';
}

function shortWallet(w) {
  const s = String(w || '');
  return s.length > 10 ? s.slice(0, 4) + '…' + s.slice(-4) : 'Player';
}

// The display name, or a short wallet. 'Player' is the payers' own fallback, so it means "no name set".
// Zero-width and bidi characters go too (night review 2026-10-29): a name stored before names were
// cleaned could hold a right-to-left override that flips how the rest of its row reads.
function displayName(name, wallet) {
  const n = String(name == null ? '' : name).replace(/[\u0000-\u001f\u007f]/g, '').replace(INVISIBLE_RE, '').trim();
  if (!n || n.toLowerCase() === 'player') return shortWallet(wallet);
  return n.length > NAME_MAX ? n.slice(0, NAME_MAX) : n;
}

function toMicro(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 1e6) : NaN;
}
// Take-home dollars for a summed rake in micro-USDC: 9 x rake, to the cent.
function takeHome(micro) {
  return Math.round((micro * TAKE_HOME_PER_RAKE) / 1e4) / 100;
}

/* Rows from EARNINGS_SQL to the public answer. Pure, so the tests drive it directly.
   Returns null for a row set that cannot be trusted (the caller keeps its last value). */
function summarize(rows) {
  if (!Array.isArray(rows)) return null;
  const mk = () => ({ micro: 0, n: 0, players: new Map() });
  const P = { today: mk(), week: mk(), all: mk() };
  let best = null;   // { micro, game } the biggest single cash-out today
  for (const r of rows) {
    if (!r || typeof r.wallet !== 'string' || !r.wallet) return null;
    const micro = toMicro(r.rake);
    const n = Number(r.n);
    const age = Number(r.age);
    if (!(micro > 0) || !(n > 0) || !Number.isFinite(age)) return null;
    const into = [P.all];
    if (age <= 0) into.push(P.today);
    if (age < WEEK_DAYS) into.push(P.week);
    for (const p of into) {
      p.micro += micro;
      p.n += n;
      let pl = p.players.get(r.wallet);
      if (!pl) { pl = { wallet: r.wallet, name: r.name, micro: 0, n: 0, games: new Map() }; p.players.set(r.wallet, pl); }
      pl.micro += micro;
      pl.n += n;
      if (r.name) pl.name = r.name;
      pl.games.set(r.game, (pl.games.get(r.game) || 0) + micro);
    }
    if (age <= 0) {
      const b = toMicro(r.best_rake);
      if (b > 0 && (!best || b > best.micro)) best = { micro: b, game: r.game };
    }
  }
  const board = (p) => ({
    total: takeHome(p.micro),
    count: p.n,
    top: [...p.players.values()]
      .sort((a, b) => (b.micro - a.micro) || (b.n - a.n) || (a.wallet < b.wallet ? -1 : 1))
      .slice(0, TOP_N)
      .map((pl) => {
        let g = '', gm = -1;
        for (const [k, m] of pl.games) if (m > gm) { g = k; gm = m; }
        return { name: displayName(pl.name, pl.wallet), game: gameLabel(g), amount: takeHome(pl.micro), n: pl.n };
      }),
  });
  return {
    total: takeHome(P.all.micro),
    count: P.all.n,
    bestToday: best ? { amount: takeHome(best.micro), game: gameLabel(best.game) } : null,
    periods: { today: board(P.today), week: board(P.week), all: board(P.all) },
  };
}

/* Rows from RECENT_SQL to the public list. Pure. Null for a row set that cannot be trusted. */
function recentWins(rows) {
  if (!Array.isArray(rows)) return null;
  const out = [];
  for (const r of rows) {
    if (!r || typeof r.wallet !== 'string' || !r.wallet) return null;
    const micro = toMicro(r.rake);
    if (!(micro > 0)) return null;
    const game = lobbyGame(r.game);
    if (!game) continue;
    out.push({ name: displayName(r.name, r.wallet), game, amount: takeHome(micro) });
  }
  return out;
}

/* The owner console's hide, kept in a small file so it outlives a restart and a
   deploy (server/data/ is gitignored and kept by the deploy). Present = hidden.
   A file that exists but cannot be read counts as hidden. */
function createHideSwitch({ file, fsx = fs, log = console } = {}) {
  let hidden = false;
  try {
    if (file && fsx.existsSync(file)) { fsx.readFileSync(file, 'utf8'); hidden = true; }
  } catch (e) {
    hidden = true;
    log.error('[EARN] hide switch file unreadable, the strip starts hidden: ' + (e && e.message));
  }
  return {
    hidden: () => hidden,
    set(h) {
      hidden = !!h;
      if (!file) return { ok: false, why: 'no file' };
      try {
        if (hidden) {
          fsx.mkdirSync(path.dirname(file), { recursive: true });
          fsx.writeFileSync(file, JSON.stringify({ hidden: true, at: new Date().toISOString() }) + '\n');
        } else if (fsx.existsSync(file)) {
          fsx.unlinkSync(file);
        }
        return { ok: true };
      } catch (e) {
        return { ok: false, why: (e && e.message) || 'write failed' };
      }
    },
  };
}

/* query(sql, params) -> Promise<{rows}>, or null with no database (then the strip never shows).
   excludeWallets: the owner wallets AND the revenue wallet (required).
   previewExclude: what the preview still leaves out (the revenue wallet, at least). */
function createEarnings({ query, excludeWallets, previewExclude, switchFile = null, config = CONFIG,
  now = Date.now, log = console, fsx = fs, setTimer = setTimeout } = {}) {
  const list = (ws) => {
    const out = [];
    for (const w of ws || []) if (typeof w === 'string' && w && !out.includes(w)) out.push(w);
    for (const w of TOP_ROWS.C_TOP_EXCLUDE.value) if (!out.includes(w)) out.push(w);
    return out;
  };
  const exclude = list(excludeWallets);
  const pExclude = list(previewExclude);
  // The owner wallets: left out of the strip, let onto the wins row from OWNER_WINS_SINCE.
  const owners = exclude.filter((w) => !pExclude.includes(w));
  const ownerSince = (rows) => (Array.isArray(rows) ? rows.filter((r) =>
    !(r && owners.includes(r.wallet) && !(r.at != null && new Date(r.at).getTime() >= OWNER_WINS_SINCE))) : rows);
  if (typeof query === 'function' && (exclude.length < 2 || pExclude.length < 1)) {
    throw new Error('earnings: excludeWallets must name the owner and revenue wallets, previewExclude the revenue wallet');
  }
  for (const w of pExclude) {
    if (!exclude.includes(w)) throw new Error('earnings: previewExclude must be a subset of excludeWallets');
  }
  const sw = createHideSwitch({ file: switchFile, fsx, log });
  const stats = { reads: 0, fails: 0 };

  // kind: the strip's grouped read (default), or the Live wins row's recent list.
  function cache(ex, kind) {
    const recent = kind === 'recent';
    let value = null, at = 0, inFlight = null, pokeTimer = null;
    function refresh() {
      if (inFlight) return inFlight;
      inFlight = (async () => {
        try {
          const res = recent ? await query(RECENT_SQL, recentParams(ex))
            : await query(EARNINGS_SQL, earningsParams(ex, config.TIME_ZONE));
          const v = recent ? recentWins(ownerSince(res && res.rows)) : summarize(res && res.rows);
          if (!v) { stats.fails++; log.warn('[EARN] unusable rows, keeping the last value'); return value; }
          stats.reads++;
          value = v;
          at = now();
          return value;
        } catch (e) {
          stats.fails++;
          at = now();   // a failing database is retried once per period, not once per request
          log.warn('[EARN] read failed, keeping the last value: ' + (e && e.message));
          return value;
        }
      })().finally(() => { inFlight = null; });
      return inFlight;
    }
    async function get() {
      if (at === 0) return refresh();
      if (now() - at >= config.REFRESH_MS) refresh();
      return value;
    }
    /* A cash-out landed: read again soon, never sooner than POKE_MS after the
       last read. One timer at a time, so pokes in a burst share it. A cache
       nobody has asked yet (at 0) stays lazy. */
    get.poke = function poke() {
      if (at === 0 || pokeTimer) return;
      const gap = Math.max(Number(config.POKE_MS) || 0, 0);
      const wait = Math.max(gap - (now() - at), 0) + Math.min(gap, 1500);
      pokeTimer = setTimer(() => { pokeTimer = null; refresh(); }, wait);
      if (pokeTimer && typeof pokeTimer.unref === 'function') pokeTimer.unref();
    };
    return get;
  }
  const pub = typeof query === 'function' ? cache(exclude) : null;
  const pre = typeof query === 'function' ? cache(pExclude) : null;
  const rec = typeof query === 'function' ? cache(pExclude, 'recent') : null;   // the owner counts on the wins row

  const OFF = Object.freeze({ on: false });
  function shown() { return !!config.SHOW && !sw.hidden(); }

  /* Social's figure: {on:false} while hidden (the same switch as the strip) or
     before the first good read, else {on:true, preview, total, count}. Unlike
     the strip it is shown at $0: the strip is a banner that waits for a real
     cash-out, the figure is a counter that starts at zero. */
  async function figure(preview) {
    if (!shown() || !pub) return OFF;
    const v = await (preview ? pre : pub)();
    if (!v) return OFF;
    return { on: true, preview: !!preview, total: v.total, count: v.count };
  }

  // The public answer: {on:false}, or {on:true, preview, total, count, bestToday, periods}.
  async function answer(preview) {
    if (!shown() || !pub) return OFF;
    const v = await (preview ? pre : pub)();
    if (!v) return OFF;
    if (!preview && !(v.total > 0 && v.total >= (Number(config.MIN_TOTAL_USD) || 0))) return OFF;
    if (preview && !(v.total > 0)) return OFF;
    return { on: true, preview: !!preview, ...v };
  }

  /* The Social tab's Top earners: the all-time top 10 from the same cached
     read, so the board and the strip can never disagree about who earned what.
     Never the owner (no preview here). Not behind the strip's switch: that
     hides the gold strip, and the board on the Social tab is its own screen
     that was always shown. ok:false is a failed read, which the lobby says,
     rather than an empty board that would read as "nobody has won". */
  async function board() {
    if (!pub) return { ok: false, top: [] };
    const v = await pub();
    if (!v) return { ok: false, top: [] };
    return { ok: true, top: v.periods.all.top.map((r, i) => ({ rank: i + 1, ...r })) };
  }

  /* The Live wins row: {ok:true, wins:[{name, game, amount}]} newest first, or ok:false (no database or a failed
     first read), which the lobby treats like no wins: its Sample row. Behind the strip's switches (config SHOW
     and the owner console's hide), so a payout the owner hides from the strip is hidden here too (Fable review). */
  async function recentList() {
    if (!rec || !shown()) return { ok: false, wins: [] };
    const v = await rec();
    if (!v) return { ok: false, wins: [] };
    return { ok: true, wins: v.map((w) => ({ name: w.name, game: w.game, amount: w.amount })) };
  }

  function route(app) {
    app.get('/api/earnings/recent', async (req, res) => {
      res.set('Cache-Control', 'no-store');
      try {
        res.json(await recentList());
      } catch (e) {
        res.json({ ok: false, wins: [] });
      }
    });
    app.get('/api/earnings/board', async (req, res) => {
      res.set('Cache-Control', 'no-store');
      try {
        res.json(await board());
      } catch (e) {
        res.json({ ok: false, top: [] });
      }
    });
    app.get('/api/earnings', async (req, res) => {
      res.set('Cache-Control', 'no-store');
      try {
        res.json(await answer(req.query && req.query.preview === '1'));
      } catch (e) {
        res.json(OFF);
      }
    });
    app.get('/api/earnings/total', async (req, res) => {
      res.set('Cache-Control', 'no-store');
      try {
        res.json(await figure(req.query && req.query.preview === '1'));
      } catch (e) {
        res.json(OFF);
      }
    });
  }

  function poke() {
    if (pub) pub.poke();
    if (pre) pre.poke();
    if (rec) rec.poke();
  }

  return {
    answer,
    figure,
    poke,
    board,
    recentList,
    route,
    hidden: () => sw.hidden(),
    shown,
    setHidden: (h) => sw.set(h),
    stats: () => ({ reads: stats.reads, fails: stats.fails, shown: shown(), configShow: !!config.SHOW }),
  };
}

module.exports = {
  createEarnings,
  summarize,
  displayName,
  shortWallet,
  gameLabel,
  EARNINGS_SQL,
  earningsParams,
  RECENT_SQL,
  recentParams,
  recentWins,
};
