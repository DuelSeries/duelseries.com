'use strict';
/* ─── ?leaderboard=preview: sample players, in this browser only ──────────────
   Owen wanted to SEE Top earners, the full leaderboard and search filled
   before there are real players (2026-10-15). A made-up board for everyone on
   a real-money site was declined twice, so this is the other way round: the
   sample players are made HERE, in the browser that opened the preview link,
   and nowhere else. Nothing in this file is sent to the server or stored; a
   reload without the link shows the real, empty board. Every screen that uses
   it says "Preview" (social.js and leaders.js). The server answers the link
   with X-Robots-Tag: noindex, so it is never a page a search engine keeps.

   Twenty players between $1 and $10, each with a profile that has cash-outs,
   a win rate and a quiet stretch, so the graph's squeeze and zoom show too.
   Made from a fixed seed, so the same link shows the same board every time. */
(function () {
  const ON = /(^|[?&])leaderboard=preview(&|$)/.test(location.search);
  const DAY = 864e5;
  const NAMES = ['neonviper', 'Kestrel', 'mossy_t', 'ByteNomad', 'juno.k', 'Ravenfield', 'pixelpaz',
    'Tomasz', 'orbital', 'sundial22', 'Marlowe', 'lumen', 'quietfox', 'Halvard', 'zinc', 'Ottoline',
    'drift_k', 'Bramble', 'Sato', 'fennec'];
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

  let PLAYERS = null;
  function build() {
    if (PLAYERS) return PLAYERS;
    const r = rng(20261015);
    const now = Date.now();
    const used = new Set();
    PLAYERS = NAMES.map((name, i) => {
      let cents;
      do { cents = 100 + Math.floor(r() * 900); } while (used.has(cents));   // $1.00 to $9.99, no ties
      used.add(cents);
      const amount = cents / 100;
      const n = 1 + Math.floor(r() * 5);
      const game = GAMES[Math.floor(r() * GAMES.length)];
      /* Cash-outs: a first burst, a quiet stretch of a few weeks, a recent
         burst. The amounts add up to the board's figure to the cent. */
      const joined = now - (45 + Math.floor(r() * 60)) * DAY;
      const firstAt = joined + (2 + r() * 8) * DAY;
      const lateAt = now - (1 + r() * 9) * DAY;
      const w = [];
      for (let k = 0; k < n; k++) w.push(0.3 + r());
      const sum = w.reduce((s, x) => s + x, 0);
      let left = cents;
      const games = w.map((x, k) => {
        const c = k === n - 1 ? left : Math.max(1, Math.round(cents * x / sum));
        left -= c;
        const base = k < Math.ceil(n / 2) ? firstAt : lateAt;
        return { amount: c / 100, at: new Date(base + k * (20 + r() * 140) * 60000).toISOString() };
      }).filter(g => g.amount > 0).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      const losses = Math.floor(r() * (n * 2 + 2));
      const won = Math.max(1, n - Math.floor(r() * 2));
      const entered = won + losses;
      return {
        name: name, amount: amount, game: game, n: games.length,
        profile: {
          name: name, preview: true,
          totalEarnings: amount,
          gamesPlayed: entered + Math.floor(r() * 30),
          playTimeSeconds: Math.round((entered * 7 + r() * 600) * 60),
          joinedAt: new Date(joined).toISOString(),
          games: games,
          winRate: { entered: entered, won: won, since: '2026-06-24T21:07:21Z',
                     games: [{ game: game, entered: entered, won: won }] },
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
    board: board, search: search, profile: profile, amountOf: amountOf, rankOf: rankOf,
  };
})();
