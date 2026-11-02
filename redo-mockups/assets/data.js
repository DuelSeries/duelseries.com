/* DuelSeries site redo looks: DATA-ONLY kit (copied from tab-redesigns/assets/kit.js). It does NOT draw any chrome:
   each look draws its own header, sidebar and phone nav. DSKit.shell() still exists (today's chrome) but is never called.
   Mockup only, nothing here talks to a server.
   - Draws the lobby chrome (PC sidebar + header, phone header + bottom nav) around <main class="tab">.
     The tab is read from <body data-tab="events|wallet|leaderboards|clips|updates|join">.
   - DSKit.data: mockup data shaped like the real API (/api/live br, /api/earnings/board,
     /api/profile/:name, /api/my-transactions, /api/my-transfers, /api/clips).
   - DSKit.countUp: the live site's "Roll" (1.2 s expo). Allowed ONLY on the Events podium prize,
     leaderboard money (global winnings, top 3, full board, profile total) and wallet balances.
     Never gated by prefers-reduced-motion (Owen's PC reports it).
   - DSKit.states: the mockup-only state switcher for Events (also reads ?state=). */
(function () {
  'use strict';
  const NOW = Date.parse('2026-10-27T23:40:00-04:00');
  const DAY = 864e5, HR = 36e5;
  function rng(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  const R = rng(20261027);
  const base = (function () { const s = document.currentScript && document.currentScript.src; return s ? s.replace(/(?:kit|data)\.js.*$/, '') : '../assets/'; })();
  const img = n => base + 'img/' + n + '-card.webp';

  /* The live lobby's order and names (v2.html GAMES, 2026-11-01). kind: arena = drop into a big room (Free, $0.50, $1),
     duel = 1 v 1 queue (Free plays a labelled bot after the wait; $0.50 and $1 wait for a person), solo = free only,
     soon = coming soon (greyed, not playable). players = people in rooms right now (mockup figures; the live site
     shows a count only when the server gave one). */
  const GAMES = [
    { id: 'chomp', name: 'Pac-Man', img: img('chomp'), players: 9, kind: 'arena', blurb: 'Eat the dots, dodge the ghosts, and grab the coins anyone caught drops on the maze.' },
    { id: 'snake', name: 'Slither.io', img: img('snake'), players: 50, kind: 'arena', blurb: 'Grow by eating, cut other players off, and cash out before somebody cuts you off.' },
    { id: 'agar', name: 'Agar.io', img: img('agar'), players: 37, kind: 'arena', blurb: 'Absorb anything smaller than you, split to chase, and stay clear of anything bigger.' },
    { id: 'paper', name: 'Paper.io', img: img('paper'), players: 10, kind: 'arena', blurb: 'Claim ground by looping back home without anyone crossing your trail.' },
    { id: 'headsoccer', name: 'Head Soccer', img: img('headsoccer'), players: 2, kind: 'duel', isNew: true, blurb: 'One on one, oversized heads, and a ball that rarely goes where you meant it to.' },
    { id: 'swim', name: 'Swim', img: img('swim'), players: 0, kind: 'duel', isNew: true, blurb: 'Weave through endless traffic. Touch a car, or fall 200 m behind, and you lose.' },
    { id: 'pool8', name: '8 Ball Pool', img: img('pool8'), players: 2, kind: 'duel', isNew: true, blurb: 'Break, call your pocket, and sink the eight before they do.' },
    { id: 'airhockey', name: 'Air Hockey', img: img('airhockey'), players: 0, kind: 'duel', isNew: true, blurb: 'One puck, two mallets, and a goal at each end. First to seven.' },
    { id: 'omgshooter', name: 'Awesome Tanks', img: img('omgshooter'), players: 4, kind: 'solo', blurb: 'Free-for-all. Kill people, take what they drop, and bank it in the middle.' },
    { id: 'tanks', name: 'Bowmasters', img: img('tanks'), players: 0, kind: 'duel', blurb: 'Aim, pull back and let go. First to drop the other wins.' },
    { id: 'knockout', name: 'Knockout', img: img('knockout'), players: 0, kind: 'duel', blurb: 'Flick your pieces and knock theirs off the ice.' },
    { id: 'rooftop', name: 'Rooftop Snipers', img: img('rooftop'), players: 0, kind: 'duel', blurb: 'Two snipers, one roof. Knock the other one off.' },
    { id: 'crossy', name: 'Crossy Road', img: img('crossy'), players: 0, kind: 'duel', blurb: 'Hop across roads and rivers. Last one standing wins.' },
    { id: 'battleship', name: 'Battleship', img: img('battleship'), players: 0, kind: 'soon', blurb: 'Hide your fleet and sink theirs first.' },
    { id: 'stumble', name: 'Stumble Guys', img: img('stumble'), players: 0, kind: 'soon', blurb: 'Coming soon.' },
    { id: 'omgshoot2', name: 'OMG Shooter', img: img('omgshoot2'), players: 0, kind: 'soon', blurb: 'Coming soon.' }
  ];
  const G = id => GAMES.find(g => g.id === id) || GAMES[0];
  const PAIDGAMES = ['snake', 'agar', 'paper', 'chomp', 'knockout', 'battleship'];

  /* ── Leaderboard: names from the live preview list, a long tail with a clear top 3 ── */
  const NAMES = ['mossy_t', 'Ravenfield', 'zinc', 'Calloway', 'Kestrel', 'okapi', 'Marlowe', 'lumen', 'yuzu', 'Halvard',
    'neonviper', 'ByteNomad', 'juno.k', 'pixelpaz', 'Tomasz', 'orbital', 'sundial22', 'quietfox', 'Ottoline', 'drift_k'];
  const AMOUNTS = [5162.25, 3184.09, 2405.62, 1079.88, 1006.93, 957.39, 806.38, 718.91, 570.91, 550.47,
    488.20, 431.75, 377.10, 329.64, 286.02, 241.55, 198.40, 162.73, 131.08, 104.62];
  const board = NAMES.map((name, i) => {
    const r = rng(i * 97 + 11);
    const game = PAIDGAMES[Math.floor(r() * PAIDGAMES.length)];
    const n = Math.max(6, Math.round(AMOUNTS[i] / (6 + r() * 30)));
    return { rank: i + 1, name, game: G(game).name, gameId: game, amount: AMOUNTS[i], n };
  });
  function profile(name) {
    const p = board.find(b => b.name === name) || board[0];
    const r = rng(p.rank * 131 + 7);
    // Cash-outs that add up to the board figure, in bursts with quiet gaps (the live graph squeezes gaps).
    const k = p.n, cash = []; let left = Math.round(p.amount * 100), t = NOW - (40 + r() * 30) * DAY;
    for (let i = 0; i < k; i++) {
      const c = i === k - 1 ? left : Math.max(50, Math.round(left / (k - i) * (0.4 + r() * 1.2)));
      left -= c; t += (r() < 0.15 ? (3 + r() * 6) * DAY : r() * 18 * HR);
      if (t > NOW - HR) t = NOW - (k - i) * HR;
      cash.push({ amount: c / 100, at: t, game: G(r() < 0.6 ? p.gameId : PAIDGAMES[Math.floor(r() * 6)]).name });
    }
    const entered = Math.round(k * (1.7 + r())), won = Math.min(entered, Math.round(k * (0.55 + r() * 0.3)));
    const split = PAIDGAMES.slice(0, 2 + Math.floor(r() * 3)).map((g, j) => { const e = Math.max(1, Math.round(entered * (j ? 0.25 : 0.55) * (0.6 + r() * 0.6))); return { game: G(g).name, entered: e, won: Math.min(e, Math.round(e * (0.25 + r() * 0.35))) }; });
    return { name: p.name, rank: p.rank, total: p.amount, topGame: p.game, gamesPlayed: entered + Math.floor(r() * 80),
      timePlayedH: Math.round(8 + r() * 120), joined: NOW - (45 + r() * 60) * DAY,
      winRate: { entered, won, since: '2026-06-24T21:07:21Z', games: split }, cashouts: cash };
  }

  /* ── Your wallet (signed in as Owen, mockup figures) ── */
  const SOLUSD = 150;
  const me = { name: 'Owen', initial: 'O', wallet: 'Gq7Hv3K9pT2mRw8xLc4NfYb6eZs1JdQa5Gu3Xk2pWn',
    balanceUsd: 24.60, sol: +(24.60 / SOLUSD).toFixed(4), solUsd: SOLUSD, rank: null };
  const txs = []; (function () {
    const r = rng(42); let t = NOW - 26 * DAY;
    const kinds = ['entry', 'entry', 'payout', 'entry', 'payout', 'entry', 'entry', 'payout', 'add', 'withdraw'];
    while (t < NOW - 2 * HR) {
      t += (0.3 + r() * 20) * HR;
      const kind = kinds[Math.floor(r() * kinds.length)], g = G(PAIDGAMES[Math.floor(r() * 4)]);
      let usd = kind === 'entry' ? (r() < 0.6 ? 1 : 0.5) : kind === 'payout' ? +(0.6 + r() * 4.5).toFixed(2) : kind === 'add' ? [10, 20, 25, 50][Math.floor(r() * 4)] : +(5 + r() * 20).toFixed(2);
      txs.push({ kind, direction: kind === 'entry' || kind === 'withdraw' ? 'out' : 'in', usd, sol: +(usd / SOLUSD).toFixed(5),
        game: kind === 'entry' || kind === 'payout' ? g.name : null, gameId: kind === 'entry' || kind === 'payout' ? g.id : null,
        how: kind === 'add' ? (r() < 0.5 ? 'Card' : 'Phantom') : null,
        peer: kind === 'withdraw' ? '9xQe' + 'Ty7m' + 'Pz2c' + 'Lw4v' + 'Hb8n' + 'Ks3d' + 'Ra6f' + 'Uj1g' : null,
        signature: Math.floor(r() * 1e16).toString(36) + Math.floor(r() * 1e16).toString(36) + 'Hn4W', at: t });
    }
    txs.reverse();
  })();
  const myCashouts = txs.filter(t => t.kind === 'payout').map(t => ({ amount: t.usd, at: t.at, game: t.game })).reverse();
  const myStats = { totalEarnings: +myCashouts.reduce((a, c) => a + c.amount, 0).toFixed(2),
    entered: txs.filter(t => t.kind === 'entry').length, won: 18, winRate: null, bestCashout: Math.max(...myCashouts.map(c => c.amount)) };
  myStats.winRate = { entered: myStats.entered, won: Math.min(myStats.won, myStats.entered) };

  /* ── Battle Royale (shape of /api/live br, plus history for designs that show past matches) ── */
  const lastPodium = [{ place: 1, name: 'happy', score: 1579 }, { place: 2, name: 'PIXEL_PONY', score: 2840 }, { place: 3, name: 'Tyrone', score: 527 }];
  const HIST_W = ['happy', 'Kestrel', 'mossy_t', 'zinc', 'drift_k', 'okapi', 'Ravenfield', 'lumen', 'happy', 'yuzu'];
  const history = HIST_W.map((w, i) => {
    const at = Date.parse('2026-10-27T20:00:00-04:00') - i * 6 * HR, r = rng(i + 300);
    const humans = 2 + Math.floor(r() * 9), solo = humans < 2;
    return { at, winner: w, prize: i === 0 ? null : (i % 4 === 3 ? null : 20), soloRun: i === 0, players: 48, humans: i === 0 ? 1 : humans,
      podium: [w, NAMES[(i * 3 + 4) % 20], NAMES[(i * 7 + 9) % 20]] };
  });
  function br(state) {
    state = state || 'waiting';
    const o = { state, engine: 'sl', prize: 20, prizeText: '$20 to 1st', entry: 'Free entry', every: 6, nextAt: '2:00 AM ET',
      when: 'Every 6 hours, next at 2:00 AM ET', players: 48, humans: 0, alive: 48, joinWindowSec: 30, joinOpen: false,
      podium: lastPodium.slice(), podiumIsLast: true, lastWinner: { name: 'happy', prize: null, soloRun: true },
      nextInSec: 2 * 3600 + 16 * 60 + 42, endsInSec: 0, ringPct: 0,
      schedule: [2, 8, 14, 20].map((h, i) => ({ at: Date.parse('2026-10-28T02:00:00-04:00') + i * 6 * HR, label: ['2:00 AM', '8:00 AM', '2:00 PM', '8:00 PM'][i] + ' ET' })),
      history };
    if (state === 'soon') Object.assign(o, { nextInSec: 6 * 60 + 12, humans: 3, joinOpen: true });
    if (state === 'live') Object.assign(o, { nextInSec: 0, endsInSec: 7 * 60 + 41, alive: 17, humans: 4, ringPct: 0.58, podiumIsLast: false,
      podium: [{ place: 1, name: null }, { place: 2, name: null }, { place: 3, name: null }] });
    if (state === 'over') Object.assign(o, { nextInSec: 5 * 3600 + 58 * 60 + 3, humans: 0, podiumIsLast: true,
      podium: [{ place: 1, name: 'Kestrel', score: 3120 }, { place: 2, name: 'Owen', score: 2210 }, { place: 3, name: 'zinc', score: 990 }],
      lastWinner: { name: 'Kestrel', prize: 20, soloRun: false }, justEnded: true });
    return o;
  }

  /* ── Clips (shape of /api/clips; posters are game card art here, real clips have video frames) ── */
  const CLIPPERS = ['MrPeanutK', 'Kestrel', 'zinc', 'mossy_t', 'lumen', 'okapi', 'yuzu'];
  const CAPS = ['', 'Cut him off at the wall', 'Last snake standing', 'Triple split into the corner', '', 'Paper.io land grab, 40% in one run', 'Clutch save at 0:02', 'Battle Royale final circle', '', 'How did that miss', 'Pac-Man ghost chain', ''];
  const clips = CAPS.map((caption, i) => {
    const g = G(['snake', 'agar', 'snake', 'agar', 'paper', 'paper', 'headsoccer', 'snake', 'knockout', 'battleship', 'chomp', 'snake'][i]);
    return { id: 'c' + (1000 + i).toString(16), name: CLIPPERS[i % CLIPPERS.length], provider: i % 5 === 4 ? 'x' : 'upload', caption,
      game: g.id, gameLabel: g.name, poster: g.img, at: NOW - (i * 9 + 2) * HR, ms: 12000 + Math.round(rng(i)() * 18000),
      vertical: i % 5 === 4, br: i === 7 };
  });
  const topClippers = [{ name: 'MrPeanutK', n: 14 }, { name: 'Kestrel', n: 9 }, { name: 'zinc', n: 6 }, { name: 'mossy_t', n: 4 }, { name: 'lumen', n: 3 }];
  const myClips = [{ id: 'm1', state: 'live', game: 'Slither.io', poster: img('snake'), at: NOW - 5 * HR, ms: 30000 },
    { id: 'm2', state: 'waiting', game: 'Agar.io', poster: img('agar'), at: NOW - 40 * 60e3, ms: 30000 }];

  const links = { discord: 'https://discord.gg/TkFaefHDFr', whop: null, x: null, tiktok: null, youtube: null, email: 'playduelseries@gmail.com',
    invite: 'duelseries.com/play/snake?ref=owen' };

  const data = { NOW, games: GAMES, game: G, board, globalWinnings: { total: 20361.09, count: 50 }, profile, me, txs, myCashouts, myStats,
    br, clips, topClippers, myClips, links, online: 106 };

  /* ── formatting ── */
  const fmt = {
    usd: (n, d) => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: d == null ? 2 : d, maximumFractionDigits: d == null ? 2 : d }),
    sol: n => (+n).toFixed(4) + ' SOL',
    short: a => a.slice(0, 4) + '...' + a.slice(-4),
    date: t => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    time: t => new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
    ago: t => { const s = (NOW - t) / 1000; if (s < 3600) return Math.max(1, Math.round(s / 60)) + ' min ago'; if (s < 86400) return Math.round(s / 3600) + ' h ago'; const d = Math.round(s / 86400); return d === 1 ? 'yesterday' : d + ' days ago'; },
    hms: s => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return { h: String(h).padStart(2, '0'), m: String(m).padStart(2, '0'), s: String(x).padStart(2, '0') }; },
    dur: ms => '0:' + String(Math.round(ms / 1000)).padStart(2, '0')
  };

  /* ── count-up ("Roll", 1.2 s expo, x0.85-1.15 by size). Allowed places only, see header. ── */
  function countUp(el, value, opts) {
    opts = opts || {}; const d = opts.decimals == null ? 2 : opts.decimals, pre = opts.prefix == null ? '$' : opts.prefix;
    const ms = (opts.ms || 1200) * Math.min(1.15, Math.max(0.85, 0.85 + Math.log10(Math.max(1, value)) / 12));
    const t0 = performance.now(), from = opts.from || 0;
    function f(t) { const k = Math.min(1, (t - t0) / ms), e = k === 1 ? 1 : 1 - Math.pow(2, -10 * k), v = from + (value - from) * e;
      el.textContent = pre + v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); if (k < 1) requestAnimationFrame(f); }
    requestAnimationFrame(f);
  }

  /* ── icons (stroke icons, 24 grid) ── */
  const P = {
    home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>', wallet: '<rect x="3" y="6" width="18" height="14" rx="3"/><path d="M16 13h2"/><path d="M3 10h18"/>',
    events: '<path d="M8 21h8M12 17v4"/><path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>',
    leaderboards: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>', clips: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10 9l5 3-5 3z"/>',
    updates: '<path d="M4 5h16M4 12h16M4 19h10"/>', shop: '<path d="M5 8h14l-1 12H6z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
    gift: '<rect x="3" y="8" width="18" height="5" rx="1"/><path d="M5 13v8h14v-8M12 8v13M12 8S9 3 7 5s5 3 5 3 5-1 5-3-5 3-5 3"/>',
    join: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M19 8v6M16 11h6"/>', help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 1 1 3.2 2.4c-.5.2-.8.7-.8 1.2v.6M12 17h.01"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>', play: '<path d="M7 4l13 8-13 8z"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>', plus: '<path d="M12 5v14M5 12h14"/>',
    add: '<path d="M12 4v12M6 10l6 6 6-6"/><path d="M4 20h16"/>', withdraw: '<path d="M12 20V8M6 14l6-6 6 6"/><path d="M4 4h16"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4.2-4.2"/>', clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    upload: '<path d="M12 19V5M5 12l7-7 7 7"/>', download: '<path d="M12 5v14M5 12l7 7 7-7"/>', link: '<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
    share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>', bug: '<rect x="7" y="8" width="10" height="12" rx="5"/><path d="M12 8V5M9 5l1 3M15 5l-1 3M3 13h4M17 13h4M4 19l3-2M20 19l-3-2M4 8l3 2M20 8l-3 2"/>',
    idea: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-4 10.5c.8.8 1 1.5 1 2.5h6c0-1 .2-1.7 1-2.5A6 6 0 0 0 12 3z"/>',
    check: '<path d="M5 12l5 5 9-10"/>', x: '<path d="M6 6l12 12M18 6L6 18"/>', chev: '<path d="M9 6l6 6-6 6"/>', ext: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14a5 5 0 0 1 5.5 5"/>',
    bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/>', card: '<rect x="2" y="5" width="20" height="14" rx="2.5"/><path d="M2 10h20M6 15h4"/>',
    qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM18 18h3v3M14 21h0"/>',
    swap: '<path d="M7 4L3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/>', medal: '<circle cx="12" cy="15" r="6"/><path d="M8.5 3h7L14 9.5h-4z"/>',
    flame: '<path d="M12 21c-4 0-7-2.7-7-6.5C5 10 9 8 9 4c3 1.5 4.5 4 4.5 6 1-.5 1.8-1.6 2-3C17.8 8.6 19 11.3 19 14.5 19 18.3 16 21 12 21z"/>',
    discord: '<path d="M8.5 7.5c2.3-.7 4.7-.7 7 0M7.5 16.5c2.8 1 6.2 1 9 0"/><path d="M6.8 6.4C5 9 4.2 12 4.4 15.5c1.4 1.1 2.8 1.8 4.3 2.2l.9-1.6M17.2 6.4C19 9 19.8 12 19.6 15.5c-1.4 1.1-2.8 1.8-4.3 2.2l-.9-1.6"/><circle cx="9.5" cy="12.5" r="1.1"/><circle cx="14.5" cy="12.5" r="1.1"/>',
    xlogo: '<path d="M4 4l16 16M20 4L4 20"/>', tiktok: '<path d="M14 3v11.5a3.5 3.5 0 1 1-3.5-3.5"/><path d="M14 3c.5 2.6 2.2 4.2 5 4.5"/>',
    youtube: '<rect x="2.5" y="5.5" width="19" height="13" rx="4"/><path d="M10 9.5l5 2.5-5 2.5z"/>', whop: '<path d="M3 8l3.5 9L10 9l2 5 2-5 3.5 8L21 8"/>'
  };
  function icon(n, size, extra) { return '<svg viewBox="0 0 24 24" width="' + (size || 18) + '" height="' + (size || 18) + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"' + (extra ? ' ' + extra : '') + '>' + (P[n] || '') + '</svg>'; }

  /* ── chrome ── */
  const NAV = [['home', 'Home'], ['wallet', 'Wallet'], ['events', 'Events'], ['leaderboards', 'Leaderboards'], ['clips', 'Clips'], ['updates', 'Updates']];
  function shell() {
    const tab = document.body.dataset.tab || '';
    if (document.body.dataset.noshell != null) return;
    document.body.classList.add('ds-shell');
    const sb = document.createElement('aside'); sb.className = 'ds-sb'; sb.setAttribute('aria-label', 'Lobby');
    sb.innerHTML = '<div class="ds-logo">Duel<em>Series</em></div><nav class="ds-nav">' +
      NAV.map(([id, l]) => '<a href="#" class="' + (id === tab ? 'on' : '') + '">' + icon(id) + l + '</a>').join('') +
      '<a href="#">' + icon('shop') + 'Shop<span class="ds-soon">Soon</span></a></nav>' +
      '<div class="ds-sbh"><span>Live games</span><span>View all</span></div>' +
      GAMES.map(g => '<div class="ds-g"><img src="' + g.img + '" alt="">' + g.name + (g.isNew ? ' <span class="ds-new">New</span>' : '') + '<span class="n' + (g.players ? ' on' : '') + '">' + g.players + '</span></div>').join('') +
      '<div class="ds-online"><i class="ds-dot"></i>' + data.online + ' online</div>' +
      '<div class="ds-foot"><div class="ds-brf"><div><b>Battle Royale</b><small>$20 to 1st</small></div><span class="num">02:16:42</span></div>' +
      '<nav class="ds-nav"><a href="#">' + icon('gift') + 'Refer a friend</a><a href="#" class="' + (tab === 'join' ? 'on' : '') + '">' + icon('join') + 'Join us</a><a href="#">' + icon('help') + 'Support</a><a href="#">' + icon('settings') + 'Settings</a></nav></div>';
    const hd = document.createElement('header'); hd.className = 'ds-hd';
    hd.innerHTML = '<span class="sp"></span><div class="ds-bal"><b class="num" id="ds-hbal">$24.60</b><button type="button">Add funds</button></div><div class="ds-me">O</div>';
    const mq = matchMedia('(max-width:760px)');
    const bn = document.createElement('nav'); bn.className = 'ds-bn'; bn.setAttribute('aria-label', 'Tabs');
    bn.innerHTML = [['home', 'Home'], ['wallet', 'Wallet'], ['events', 'Events'], ['leaderboards', 'Leaders'], ['settings', 'Settings']]
      .map(([id, l]) => '<a href="#" class="' + (id === tab ? 'on' : '') + '">' + icon(id) + l + '</a>').join('');
    const tag = document.createElement('div'); tag.className = 'ds-mock'; tag.textContent = 'Mockup data';
    document.body.prepend(hd); document.body.prepend(sb); document.body.append(bn, tag);
    function logoPlace() { const l = hd.querySelector('.ds-logo'); if (mq.matches && !l) hd.insertAdjacentHTML('afterbegin', '<div class="ds-logo">Duel<em>Series</em></div>'); if (!mq.matches && l) l.remove(); }
    logoPlace(); mq.addEventListener('change', logoPlace);
    countUp(document.getElementById('ds-hbal'), me.balanceUsd);
  }

  /* ── mockup-only state switcher (?state= presets it) ── */
  function states(list, onChange) {
    const q = new URLSearchParams(location.search).get('state');
    let cur = list.find(s => s[0] === q) ? q : list[0][0];
    const box = document.createElement('div'); box.className = 'ds-states'; box.setAttribute('aria-label', 'Mockup state');
    function draw() { box.innerHTML = '<span>Show</span>' + list.map(([id, l]) => '<button type="button" data-s="' + id + '" class="' + (id === cur ? 'on' : '') + '">' + l + '</button>').join(''); }
    box.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; cur = b.dataset.s; draw(); onChange(cur); });
    draw(); document.body.append(box); onChange(cur); return () => cur;
  }

  function toast(msg) {
    let t = document.getElementById('ds-toast');
    if (!t) { t = document.createElement('div'); t.id = 'ds-toast'; t.style.cssText = 'position:fixed;left:50%;top:76px;transform:translateX(-50%);z-index:80;background:var(--bone);color:var(--ink);font-weight:600;font-size:14px;border-radius:999px;padding:9px 18px;transition:opacity .25s'; document.body.append(t); }
    t.textContent = msg; t.style.opacity = 1; clearTimeout(t._h); t._h = setTimeout(() => t.style.opacity = 0, 1800);
  }
  function every(fn) { fn(); return setInterval(fn, 1000); }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  window.DSKit = { data, fmt, countUp, icon, states, toast, every, esc, rng };
  /* data-only: no automatic chrome. */
})();
