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

   Fifty players, a long tail from a few dollars up to a few thousand with a
   clear top 3. Each has a profile whose cash-outs add up to the board's figure
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

  /* Every day a little more (Owen 2026-10-28): from day 0, midnight Eastern on 2026-10-28, each player
     cashes out a few times a day, about $10 to $20 a day in all, the top of the board more and the tail
     less, so the board, the profiles and Global player winnings climb. The history before day 0 is
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
      /* Cash-outs up to day 0: a few dollars to a few tens each, so the big
         earners have a lot of them. Weighted shares that add up exactly. */
      const n0 = Math.max(1, Math.min(200, Math.round(Math.sqrt(baseCents / 100) * (2 + pr()))));
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
      /* From day 0: about perDay dollars a day (half to one and a half times
         it), in one to four cash-outs at random times through the day. Only
         the ones already past count, so the figure climbs through the day. */
      const perDay = i < 3 ? 20 + pr() * 10 : i < 15 ? 12 + pr() * 10 : 6 + pr() * 12;
      for (let d = 0; d <= Math.floor((now - BASE) / DAY); d++) {
        const dr = rng((20261026 ^ Math.imul(i + 1, 0x9E3779B1)) + d * 104729);
        const day = Math.round(perDay * (0.5 + dr()) * 100);
        const k = 1 + Math.floor(dr() * 4);
        const dw = [];
        for (let j = 0; j < k; j++) dw.push(0.5 + dr());
        const dsum = dw.reduce((s, x) => s + x, 0);
        let rest = day;
        for (let j = 0; j < k; j++) {
          const c = j === k - 1 ? rest : Math.round(day * dw[j] / dsum);
          rest -= c;
          const at = BASE + d * DAY + dr() * DAY;
          if (at <= now) games.push({ amount: c / 100, at: new Date(at).toISOString() });
        }
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
    /* Always false (Owen 2026-10-28): the owner sees exactly what players see,
       so no browser wears LIVE on sample players. Kept as a field because
       leaders.js, social.js and v2.html read it. */
    liveLook: false,
    board: board, search: search, profile: profile, amountOf: amountOf, rankOf: rankOf, total: total, tag: TAG, note: NOTE,
  };
})();
