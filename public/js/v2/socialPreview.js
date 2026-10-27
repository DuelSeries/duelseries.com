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

   Sticky in that one browser (Owen, 2026-10-26: his top earners "didn't
   save"): opening the link once keeps one flag, dsLbPreview = '1', in this
   browser's localStorage, and ?leaderboard=off removes it. The flag is the
   only thing stored; the players are made again from the seed on each load.
   Every other browser, and the server, only ever see the real board.

   For everyone (Owen, 2026-10-26, to get feedback on the full board in the
   real game): config.js SAMPLE_BOARD = true turns it on for every visitor.
   Then every place it shows says "Sample" and "Sample players to preview the
   board.", and never LIVE (only Owen's own preview browser sees LIVE, liveLook): sample winnings on a real-money site are only ever
   shown labelled as sample data. The lobby strip, Wallet and server stay real.

   Fifty players, a long tail from a few dollars up to a few thousand with a
   clear top 3. Each has a profile whose cash-outs add up to the board's figure
   to the cent, in bursts with quiet stretches between (so the graph's squeeze
   and zoom show), and a win rate and per-game split that fit the cash-outs.
   Global player winnings shows their total (social.js). Made from a fixed
   seed, so the same browser shows the same board every time. */
(function () {
  const KEY = 'dsLbPreview';
  const has = v => new RegExp('(^|[?&])leaderboard=' + v + '(&|$)').test(location.search);
  // MINE: this browser opened the preview link (now, or before and kept).
  const MINE = (function () {
    if (has('off')) { try { localStorage.removeItem(KEY); } catch (_) {} return false; }
    if (has('preview')) { try { localStorage.setItem(KEY, '1'); } catch (_) {} return true; }
    try { return localStorage.getItem(KEY) === '1'; } catch (_) { return false; }
  })();
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

  /* The board's figures, in cents, biggest first and no ties: a clear top 3
     (about $5k, $3.3k, $2.3k), then a long tail from about $1,150 at 4th down
     to a few dollars at 50th, each nudged a little so the curve is not smooth. */
  function amounts(r) {
    const out = [480000 + Math.floor(r() * 45000), 315000 + Math.floor(r() * 30000), 215000 + Math.floor(r() * 30000)];
    const top = 115000, low = 300, k = NAMES.length - 3;
    for (let i = 0; i < k; i++) out.push(Math.max(150, Math.round(top * Math.pow(low / top, i / (k - 1)) * (0.88 + r() * 0.24))));
    out.sort((a, b) => b - a);
    for (let i = 1; i < out.length; i++) if (out[i] >= out[i - 1]) out[i] = out[i - 1] - 1 - Math.floor(r() * 40);
    return out;
  }

  let PLAYERS = null;
  function build() {
    if (PLAYERS) return PLAYERS;
    const r = rng(20261026);
    const now = Date.now();
    const cents = amounts(r);
    // Names shuffled once, so the top of the board is not the list's first names.
    const names = NAMES.slice();
    for (let i = names.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [names[i], names[j]] = [names[j], names[i]]; }
    PLAYERS = names.map((name, i) => {
      const total = cents[i], amount = total / 100;
      /* Cash-outs: a few dollars to a few tens each, so the big earners have
         a lot of them. Weighted shares that add up to the figure exactly. */
      const n = Math.max(1, Math.min(200, Math.round(Math.sqrt(amount) * (2 + r()))));
      const w = [];
      for (let k = 0; k < n; k++) w.push(0.25 + r() * r() * 3);
      const sum = w.reduce((s, x) => s + x, 0);
      let left = total;
      const shares = w.map((x, k) => {
        const c = k === n - 1 ? left : Math.max(1, Math.min(left - (n - 1 - k), Math.round(total * x / sum)));
        left -= c;
        return c;
      });
      /* When: joined 40 to 160 days ago, then two to four bursts of play
         with quiet stretches between, the last one recent. */
      const joined = now - (40 + Math.floor(r() * 120)) * DAY;
      const bursts = 2 + Math.floor(r() * 3);
      const span = now - joined - 3 * DAY;
      const starts = [];
      for (let b = 0; b < bursts; b++) starts.push(joined + 2 * DAY + span * (b / bursts + r() * 0.12));
      starts[bursts - 1] = Math.max(starts[bursts - 1], now - (2 + r() * 8) * DAY);
      const games = shares.map((c, k) => {
        const s = starts[Math.min(bursts - 1, Math.floor(k * bursts / n))];
        const at = Math.min(now - 3600e3, s + r() * Math.min(9, 2 + n / 20) * DAY);
        return { amount: c / 100, at: new Date(at).toISOString() };
      }).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      /* Win rate: nearly every cash-out is a win; the best players win about
         half their paid rounds, the tail fewer. Split over 1 to 4 games, the
         favourite taking most, and the board shows the favourite. */
      const won = Math.max(1, n - Math.floor(r() * Math.max(1, n * 0.1)));
      const rate = (i < 10 ? 0.42 : 0.2) + r() * 0.18;
      const entered = Math.max(won, Math.round(won / rate));
      // Fisher-Yates, not a random sort: a sort calls r() a different number of times in different engines.
      const order = GAMES.slice();
      for (let k = order.length - 1; k > 0; k--) { const j = Math.floor(r() * (k + 1)); [order[k], order[j]] = [order[j], order[k]]; }
      order.length = 1 + Math.floor(r() * 4);
      const per = order.map((g, k) => ({ game: g, entered: 0, won: 0, wt: k === 0 ? 3 + r() * 3 : 0.5 + r() }));
      const pick = () => {
        let t = r() * per.reduce((s, x) => s + x.wt, 0);
        for (const x of per) { t -= x.wt; if (t <= 0) return x; }
        return per[0];
      };
      for (let k = 0; k < won; k++) { const x = pick(); x.won++; x.entered++; }
      for (let k = won; k < entered; k++) pick().entered++;
      const split = per.filter(x => x.entered > 0).sort((a, b) => b.entered - a.entered)
        .map(x => ({ game: x.game, entered: x.entered, won: x.won }));
      const game = split.slice().sort((a, b) => b.won - a.won)[0].game;
      return {
        name: name, amount: amount, game: game, n: games.length,
        profile: {
          name: name, preview: true,
          totalEarnings: amount,
          gamesPlayed: entered + Math.floor(r() * entered * 0.6) + Math.floor(r() * 25),
          playTimeSeconds: Math.round((entered * (5 + r() * 4) + r() * 600) * 60),
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

  /* Not into analytics either: .ph-no-capture keeps PostHog's clicks and its
     session replay off the sample names (public/js/posthog-init.js masks the
     text of anything with that class). */
  if (ON) {
    for (const id of ['social-screen', 'player-screen']) {
      const e = document.getElementById(id);
      if (e) e.classList.add('ph-no-capture');
    }
  }

  window.V2SocialPreview = {
    on: ON,
    /* Owen's own look (2026-10-26, "just to see how this looks"): in the
       browser that opened the link, the board and Global player winnings wear
       LIVE instead of Sample. Never for SAMPLE_BOARD visitors: fake players
       marked LIVE on a real-money site would deceive them. */
    liveLook: MINE,
    board: board, search: search, profile: profile, amountOf: amountOf, rankOf: rankOf, total: total, tag: TAG, note: NOTE,
  };
})();
