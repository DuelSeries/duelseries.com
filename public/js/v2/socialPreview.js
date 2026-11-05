'use strict';
/* ─── ?leaderboard=preview: sample players, in this browser only ──────────────
   Owen wanted to SEE Top earners, the full leaderboard and search filled
   before there are real players (2026-10-15). A made-up board for everyone on
   a real-money site was declined twice, so this is the other way round: the
   sample players are made HERE, in the browser that opened the preview link,
   and nowhere else. Nothing about them is sent to the server or stored. Every
   screen that uses it says "Preview" (social.js and leaders.js). The server
   answers the link with X-Robots-Tag: noindex, so it is never a page a search
   engine keeps.

   Only for the visit that has ?leaderboard=preview in the URL. It used to
   stick in the browser (dsLbPreview in localStorage) and wear LIVE there, so
   the owner's own screen differed from every player's; Owen 2026-10-28: his
   screen must look exactly like everyone else's. The old flag is cleared on
   load, and nothing here ever differs by browser.

   For everyone (Owen, 2026-10-26, to get feedback on the full board in the
   real game): config.js SAMPLE_BOARD = true turns it on for every visitor.
   Then every place it shows says "Sample" and "Sample players to preview the
   board.", and never LIVE: sample winnings on a real-money site are only ever
   shown labelled as sample data. The lobby strip, Wallet and server stay real.

   Fifty players, a long tail from about 50 cents up to about $30 with a clear
   top 3, about $200 to $260 in all (Owen 2026-10-29: much lower). Each has a profile whose cash-outs add up to the board's figure
   to the cent, in bursts with quiet stretches between (so the graph's squeeze
   and zoom show), and a win rate and per-game split that fit the cash-outs.
   Global player winnings shows their total (social.js). Made from a fixed
   seed, so the same browser shows the same board every time. */
(function () {
  const KEY = 'dsLbPreview';
  const has = v => new RegExp('(^|[?&])leaderboard=' + v + '(&|$)').test(location.search);
  // MINE: this visit's URL asks for the preview. The old sticky flag is dropped.
  try { localStorage.removeItem(KEY); } catch (_) {}
  const MINE = has('preview');
  const ON = MINE || (!has('off') && !!window.DSConfig && window.DSConfig.SAMPLE_BOARD === true);   // config.js: everyone
  // Every screen showing these players carries this tag and this line (leaders.js, social.js).
  const TAG = 'Sample';
  const NOTE = 'Sample players to preview the board.';
  const DAY = 864e5;
  const NAMES = ['neonviper', 'Kestrel', 'mossy_t', 'ByteNomad', 'juno.k', 'Ravenfield', 'pixelpaz',
    'Tomasz', 'orbital', 'sundial22', 'Marlowe', 'lumen', 'quietfox', 'Halvard', 'zinc', 'Ottoline',
    'drift_k', 'Bramble', 'Sato', 'fennec', 'GhostLatte', 'arcturus', 'Delphine', 'kai_wren', 'NOVA77',
    'tidepool', 'Ezekiel_R', 'saltmarsh', 'Priyanka', 'coldbrew', 'Vex', 'marigold.j', 'Thandiwe',
    'rustbucket', 'okapi', 'Lindqvist', 'hexfire', 'Calloway', 'yuzu', 'deadpan_dan', 'Ingrid',
    'MothLamp', 'castelo', 'r0nin', 'Beatrix', 'skyline_9', 'Odalys', 'grimwald', 'pepper.s', 'Aurelio'];
  const GAMES = ['Slither.io', 'Paper.io', 'Agar.io', 'Knockout', 'Battleship'];   // server/earnings gameLabel's own names

  // mulberry32: small, fast, and the same numbers for the same seed in every browser.
  function rng(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  /* The board's figures at day 0, in cents, biggest first and no ties: a clear
     top 3 (about $28, $20, $15), then a long tail from about $9 at 4th down to
     about 50 cents at 50th, each nudged a little so the curve is not smooth, all
     scaled to a seeded total between $200 and $250 (Owen 2026-10-29: Global
     player winnings between $200 and $300, the slow daily climb inside that). */
  function amounts(r) {
    const out = [2600 + Math.floor(r() * 400), 1900 + Math.floor(r() * 300), 1400 + Math.floor(r() * 300)];
    const top = 800, low = 50, k = NAMES.length - 3;
    for (let i = 0; i < k; i++) out.push(Math.round(top * Math.pow(low / top, i / (k - 1)) * (0.88 + r() * 0.24)));
    const want = 20000 + Math.floor(r() * 5000);
    const sum = out.reduce((s, c) => s + c, 0);
    for (let i = 0; i < out.length; i++) out[i] = Math.max(45, Math.round(out[i] * want / sum));
    out.sort((a, b) => b - a);
    for (let i = 1; i < out.length; i++) if (out[i] >= out[i - 1]) out[i] = out[i - 1] - 1 - Math.floor(r() * 3);
    return out;
  }

  /* Every day a little more (Owen 2026-10-28, lowered 2026-10-29): from day 0, midnight Eastern on
     2026-10-28, now and then a player cashes out one round's prize, the top of the board most often, about
     $2 to $3 a day across the whole board, so the board, the profiles and Global player winnings climb slowly. The history before day 0 is
     anchored to it rather than to today, so a profile's past never moves. Each player and each day has
     its own seed: every browser shows the same figures at the same moment. Tests pin the clock with
     window.DS_PREVIEW_NOW. */
  const BASE = Date.UTC(2026, 9, 28, 4);
  const clock = () => (typeof window.DS_PREVIEW_NOW === 'number' ? window.DS_PREVIEW_NOW : Date.now());

  let PLAYERS = null;
  function build() {
    if (PLAYERS) return PLAYERS;
    const r = rng(20261026);
    const now = clock();
    const cents = amounts(r);
    // Names shuffled once, so the top of the board is not the list's first names.
    const names = NAMES.slice();
    for (let i = names.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [names[i], names[j]] = [names[j], names[i]]; }
    PLAYERS = names.map((name, i) => {
      // This player's own numbers: one player's new day never moves anyone else's past.
      const pr = rng(20261026 + (i + 1) * 7919);
      const baseCents = cents[i];
      /* Cash-outs up to day 0: about $1 to $2.50 each on average, so the big
         earners have more of them. Weighted shares that add up exactly. */
      const n0 = Math.max(1, Math.min(200, Math.round(baseCents / (90 + pr() * 160))));
      const w = [];
      for (let k = 0; k < n0; k++) w.push(0.25 + pr() * pr() * 3);
      const sum = w.reduce((s, x) => s + x, 0);
      let left = baseCents;
      const shares = w.map((x, k) => {
        const c = k === n0 - 1 ? left : Math.max(1, Math.min(left - (n0 - 1 - k), Math.round(baseCents * x / sum)));
        left -= c;
        return c;
      });
      /* When: joined 40 to 160 days before day 0, then two to four bursts of
         play with quiet stretches between, the last one just before day 0. */
      const joined = BASE - (40 + Math.floor(pr() * 120)) * DAY;
      const bursts = 2 + Math.floor(pr() * 3);
      const span = BASE - joined - 3 * DAY;
      const starts = [];
      for (let b = 0; b < bursts; b++) starts.push(joined + 2 * DAY + span * (b / bursts + pr() * 0.12));
      starts[bursts - 1] = Math.max(starts[bursts - 1], BASE - (2 + pr() * 8) * DAY);
      const games = shares.map((c, k) => {
        const s = starts[Math.min(bursts - 1, Math.floor(k * bursts / n0))];
        const at = Math.min(BASE - 3600e3, s + pr() * Math.min(9, 2 + n0 / 20) * DAY);
        return { amount: c / 100, at: new Date(at).toISOString() };
      });
      /* From day 0: on some days one cash-out at a random time, the top 3
         about one day in five, the next 12 one in sixteen, the tail one in
         fifty; a duel or Paper.io prize ($0.45, $0.90 or $1.80) or a snake
         cash-out up to about $3. Only the ones already past count. */
      const odds = i < 3 ? 0.2 : i < 15 ? 0.06 : 0.02;
      for (let d = 0; d <= Math.floor((now - BASE) / DAY); d++) {
        const dr = rng((20261026 ^ Math.imul(i + 1, 0x9E3779B1)) + d * 104729);
        if (dr() >= odds) continue;
        const c = dr() < 0.6 ? [45, 90, 90, 180][Math.floor(dr() * 4)] : 45 + Math.floor(dr() * 260);
        const at = BASE + d * DAY + dr() * DAY;
        if (at <= now) games.push({ amount: c / 100, at: new Date(at).toISOString() });
      }
      games.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      const amount = games.reduce((s, g) => s + Math.round(g.amount * 100), 0) / 100;
      const n = games.length;
      /* Win rate: nearly every cash-out is a win; the best players win about
         half their paid rounds, the tail fewer. Split over 1 to 4 games, the
         favourite taking most, and the board shows the favourite. Its own
         seed, with the fixed draws first, so a new day only adds rounds. */
      const wr = rng(20261026 + (i + 1) * 104723);
      const lossR = wr(), rateR = wr(), gpA = wr(), gpB = wr(), ptA = wr(), ptB = wr();
      const won = Math.max(1, n - Math.floor(lossR * Math.max(1, n * 0.1)));
      const rate = (i < 10 ? 0.42 : 0.2) + rateR * 0.18;
      const entered = Math.max(won, Math.round(won / rate));
      // Fisher-Yates, not a random sort: a sort calls wr() a different number of times in different engines.
      const order = GAMES.slice();
      for (let k = order.length - 1; k > 0; k--) { const j = Math.floor(wr() * (k + 1)); [order[k], order[j]] = [order[j], order[k]]; }
      order.length = 1 + Math.floor(wr() * 4);
      const per = order.map((g, k) => ({ game: g, entered: 0, won: 0, wt: k === 0 ? 3 + wr() * 3 : 0.5 + wr() }));
      const pick = () => {
        let t = wr() * per.reduce((s, x) => s + x.wt, 0);
        for (const x of per) { t -= x.wt; if (t <= 0) return x; }
        return per[0];
      };
      for (let k = 0; k < won; k++) { const x = pick(); x.won++; x.entered++; }
      for (let k = won; k < entered; k++) pick().entered++;
      const split = per.filter(x => x.entered > 0).sort((a, b) => b.entered - a.entered)
        .map(x => ({ game: x.game, entered: x.entered, won: x.won }));
      const game = split.slice().sort((a, b) => b.won - a.won)[0].game;
      return {
        name: name, amount: amount, game: game, n: n,
        profile: {
          name: name, preview: true,
          totalEarnings: amount,
          gamesPlayed: entered + Math.floor(gpA * entered * 0.6) + Math.floor(gpB * 25),
          playTimeSeconds: Math.round((entered * (5 + ptA * 4) + ptB * 600) * 60),
          joinedAt: new Date(joined).toISOString(),
          games: games,
          winRate: { entered: entered, won: won, since: '2026-06-24T21:07:21Z', games: split },
        },
        i: i,
      };
    }).sort((a, b) => b.amount - a.amount);
    PLAYERS.forEach((p, k) => { p.rank = k + 1; });
    return PLAYERS;
  }

  // The board in /api/earnings/board's own shape: { ok, top: [{ rank, name, game, amount, n }] }.
  function board(limit) {
    if (!ON) return { ok: false, top: [] };
    return { ok: true, preview: true, top: build().slice(0, limit || 10).map(p =>
      ({ rank: p.rank, name: p.name, game: p.game, amount: p.amount, n: p.n })) };
  }

  // Names containing q, those that start with it first, at most 8: the server's own order.
  function search(q) {
    q = String(q || '').trim().toLowerCase();
    if (!ON || !q) return [];
    return build().map(p => p.name)
      .filter(n => n.toLowerCase().includes(q))
      .sort((a, b) => (b.toLowerCase().startsWith(q) - a.toLowerCase().startsWith(q)) ||
                      (a.length - b.length) || a.toLowerCase().localeCompare(b.toLowerCase()))
      .slice(0, 8);
  }

  function profile(name) {
    const p = ON && build().find(x => x.name === name);
    return p ? p.profile : null;
  }
  const amountOf = name => { const p = ON && build().find(x => x.name === name); return p ? p.amount : null; };
  const rankOf = name => { const p = ON && build().find(x => x.name === name); return p ? p.rank : null; };
  // Every sample player's figure added up, for Global player winnings (social.js).
  const total = () => (ON ? build().reduce((t, p) => t + Math.round(p.amount * 100), 0) / 100 : 0);

  /* The board's three periods in the strip's own shape (/api/earnings periods): { today, week, all }, each
     { total, count, top: [{ name, game, amount, n }] }. Today and This week go by the Eastern day, as the
     server's do (server/earnings: age in days on America/Toronto, today is age 0, the week is under 7). Worked
     out at most once a minute. */
  const dayOf = t => Date.parse(new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/Toronto' }));
  let perMemo = null, perAt = 0;
  function periods() {
    if (!ON) return {};
    const now = clock();
    if (perMemo && Math.abs(now - perAt) < 60000) return perMemo;
    const today = dayOf(now);
    const mk = () => ({ total: 0, count: 0, top: [] });
    const out = { today: mk(), week: mk(), all: mk() };
    for (const p of build()) {
      const per = { today: [0, 0], week: [0, 0], all: [0, 0] };
      for (const g of p.profile.games) {
        const c = Math.round(g.amount * 100), age = Math.round((today - dayOf(Date.parse(g.at))) / DAY);
        per.all[0] += c; per.all[1]++;
        if (age < 7) { per.week[0] += c; per.week[1]++; }
        if (age <= 0) { per.today[0] += c; per.today[1]++; }
      }
      for (const k of ['today', 'week', 'all']) {
        if (!per[k][1]) continue;
        out[k].total += per[k][0]; out[k].count += per[k][1];
        out[k].top.push({ name: p.name, game: p.game, amount: per[k][0] / 100, n: per[k][1] });
      }
    }
    for (const k of ['today', 'week', 'all']) {
      out[k].total = out[k].total / 100;
      out[k].top.sort((a, b) => (b.amount - a.amount) || (b.n - a.n) || (a.name < b.name ? -1 : 1));
      out[k].top = out[k].top.slice(0, 10);
    }
    perMemo = out; perAt = now;
    return out;
  }

  /* Not into analytics either: .ph-no-capture keeps PostHog's clicks and its
     session replay off the sample names (public/js/posthog-init.js masks the
     text of anything with that class). */
  if (ON) {
    for (const id of ['social-screen', 'player-screen']) {
      const e = document.getElementById(id);
      if (e) e.classList.add('ph-no-capture');
    }
  }

  /* Home's Live wins when config.js SAMPLE_WINS is on (Owen 2026-11-02: many more, full and moving). One made-up
     win every WIN_MS, each slot's player, game and amount from its own seed, so every browser shows the same row at
     the same moment and a new win slides in at the left as each slot opens. Names are the board's players and a
     few more; amounts are the rooms' real prizes ($0.90 and $1.80 for a 1 v 1, a cash-out in a big room). */
  const CFG = window.DSConfig || {};
  const WINS_ON = !has('off') && CFG.SAMPLE_WINS === true;
  const WIN_MS = 6000;
  const WIN_GAMES = [['snake', 3], ['chomp', 3], ['agar', 2], ['paper', 2], ['pool8', 2], ['headsoccer', 1], ['airhockey', 1],
    ['knockout', 1], ['battleship', 1], ['rooftop', 1], ['crossy', 1], ['swim', 1]];
  const DUELS = new Set(['pool8', 'headsoccer', 'airhockey', 'battleship', 'rooftop', 'crossy', 'swim']);
  const EXTRA = ['milo.v', 'Shreya', 'cobaltcat', 'Juniper', 'reza_k', 'blitzkid', 'Anouk', 'tofu_tom', 'Lysander', 'glimmer',
    'Matteo', 'snek_lord', 'Wren', 'oatmilk', 'Kofi', 'pinecone', 'Esme', 'turbo_tav', 'Ilse', 'Darius'];
  const WIN_NAMES = NAMES.concat(EXTRA);
  const WIN_W = WIN_GAMES.reduce((s, g) => s + g[1], 0);
  function winAt(slot) {
    const r = rng(0x5eed + Math.imul(slot, 2654435761));
    let k = r() * WIN_W, g = WIN_GAMES[0][0];
    for (const [id, w] of WIN_GAMES) { if ((k -= w) < 0) { g = id; break; } }
    let amt;
    if (DUELS.has(g)) amt = r() < 0.7 ? 0.9 : 1.8;
    else { const x = r(); amt = x < 0.55 ? 0.3 + r() * 1.7 : x < 0.9 ? 2 + r() * 4 : 6 + r() * 9; }
    return { who: WIN_NAMES[Math.floor(r() * WIN_NAMES.length)], g: g, amt: Math.round(amt * 100) / 100, slot: slot };
  }
  // The newest n made-up wins, newest first: { who, g, amt, slot }.
  function wins(n) {
    if (!WINS_ON) return [];
    const now = Math.floor(clock() / WIN_MS), out = [];
    for (let k = 0; k < (n || 50); k++) out.push(winAt(now - k));
    return out;
  }

  /* The Sample tag (config.js SAMPLE_TAG) is on unless the config turns it off, or this is a localhost dev server
     opened with ?filler=live. Off on main since 2026-11-05 (Owen: no Sample label on the filled boards). */
  const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  const LIVE_LOOK = CFG.SAMPLE_TAG === false || (LOCAL && /(^|[?&])filler=live(&|$)/.test(location.search));

  window.V2SocialPreview = {
    on: ON,
    winsOn: WINS_ON, wins: wins, WIN_MS: WIN_MS,
    // true only when the Sample tag is off (above): leaders.js, social.js and v2.html then show the Live wording.
    liveLook: LIVE_LOOK,
    board: board, periods: periods, search: search, profile: profile, amountOf: amountOf, rankOf: rankOf, total: total, tag: TAG, note: NOTE,
  };
})();
