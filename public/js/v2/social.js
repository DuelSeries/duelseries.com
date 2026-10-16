'use strict';
/* ─── Social: leaderboard, player search, player profiles ─────────────────────
   Every figure here comes from the server. Response shapes were read out of
   server/index.js and server/db.js on 2026-08-15 rather than guessed:

     GET /api/earningsboard      -> [{ rank, name, earnings }]
                                    net-positive accounts only, top 10, already
                                    ranked and ordered by the query
     GET /api/players/search?q=  -> ["name", …]   prefix match, ILIKE 'q%', max 8
                                    NOTE: names only, so opening a result costs a
                                    second request for the profile itself
     GET /api/profile/:name      -> { name, totalEarnings, gamesPlayed,
                                      playTimeSeconds, joinedAt,
                                      games: [{ amount, at }], … }
                                    games is every cash-out, the same rows
                                    /api/my-profile gives the Wallet tab. (The
                                    bucketed series also in the answer are for
                                    the old snake client, not this screen.)
     GET /api/stats/winnings     -> { totalUsd, totalCad }  totalUsd is every payout in
                                    dollars (null until the server has a CAD rate)
     GET /api/money-config       -> { mode, unit, … }

   What the server does NOT have, and is therefore not shown: per-game win/loss,
   house cut paid, and buy-in history for other players. The prototype invented
   those. A profile shows what is really recorded and nothing more. */

(function () {
  let MODE = 'usdc';
  let BOARD = [];
  const PROFILES = new Map();          // name -> profile, so reopening is free

  // With thousands separators, so $1,234.56 never reads as $1234.56.
  const money = n => (MODE === 'usdc' ? '$' : 'C$') +
    (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const toast = m => (window.V2Play && window.V2Play.toast ? window.V2Play.toast(m) : alert(m));
  let boardFailed = false;
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const el = id => document.getElementById(id);

  function playTime(sec) {
    sec = Number(sec) || 0;
    if (sec < 3600) return Math.round(sec / 60) + 'm';
    const h = Math.floor(sec / 3600);
    return h < 48 ? h + 'h' : Math.round(h / 24) + 'd';
  }

  async function load() {
    /* A fresh visit starts from the board: a query left in the box from last
       time sat over the full board, which no longer matched it. */
    const q = el('soc-q'); if (q) q.value = '';
    // Loading says so, the first time, instead of a blank screen.
    if (!BOARD.length && !boardFailed) el('soc-board').innerHTML = '<div class="none2">Loading…</div>';
    try {
      const cfg = await (await fetch('/api/money-config')).json();
      MODE = cfg.mode || 'usdc';
    } catch (_) { /* the default is already the live mode */ }

    /* totalUsd: every payout in dollars (the old CAD part converted on the
       server). totalCad mixed the two currencies under a "$". */
    let winnings = null;
    try {
      const j = await (await fetch('/api/stats/winnings')).json();
      winnings = MODE === 'usdc' ? j.totalUsd : j.totalCad;
    } catch (_) { winnings = null; }

    /* A failed read is a failed read, not "nobody has won": the two used to
       look identical. */
    try {
      const r = await fetch('/api/earningsboard');
      if (r.ok === false) throw new Error('HTTP ' + r.status);
      BOARD = await r.json(); boardFailed = false;
    } catch (_) { BOARD = []; boardFailed = true; }
    if (!Array.isArray(BOARD)) BOARD = [];

    /* The one figure worth stating site-wide: everything ever paid out to
       players (not the total of the rows above, which are the top ten net of
       the house's cut). "Players in profit" went with it — the board already
       IS that list, so the count was a tile restating its own length. */
    el('soc-tiles').innerHTML =
      '<div class="tile"><div class="k">Paid out to players</div>' +
      '<div class="v num">' + (winnings == null ? '—' : money(winnings)) + '</div></div>';

    drawBoard();
  }

  function rowHTML(name, earnings, rank) {
    return '<button class="prow" onclick="V2Social.openPlayer(' +
      JSON.stringify(name).replace(/"/g, '&quot;') + ')">' +
      '<span class="rk num">' + (rank == null ? '' : rank) + '</span>' +
      /* No avatar disc. It was two letters of a name on a colour derived from
         that same name, which told a reader nothing they could not already see
         in the name beside it, and a wall of arbitrary colours down the left of
         a money table reads as decoration rather than data. */
      '<span class="nm">' + esc(name) + '</span>' +
      '<span class="gp num"></span>' +
      '<span class="er num">' + (earnings == null ? '' : money(earnings)) + '</span>' +
      '</button>';
  }

  function drawBoard(names) {
    const box = el('soc-board');
    if (names) {                                   // search results: names only
      if (!names.length) {
        box.innerHTML = '<div class="none2">No player by that name.</div>';
        return;
      }
      /* A searched player may not be on the leaderboard at all, so their
         earnings are only filled in when we happen to know them. */
      box.innerHTML = names.map(n => {
        const hit = BOARD.find(b => b.name === n);
        return rowHTML(n, hit ? hit.earnings : null, hit ? hit.rank : null);
      }).join('');
      return;
    }
    if (!BOARD.length) {
      box.innerHTML = boardFailed
        ? '<div class="none2">Could not load the board. Try again in a moment.</div>'
        : '<div class="none2">No winners yet.</div>';
      return;
    }
    box.innerHTML = BOARD.map(p => rowHTML(p.name, p.earnings, p.rank)).join('');
  }

  /* Debounced, and the previous request is aborted, so fast typing cannot land
     an earlier response after a later one and show the wrong results. */
  let timer = null, abort = null;
  function search(q) {
    clearTimeout(timer);
    q = (q || '').trim();
    if (!q) { if (abort) abort.abort(); drawBoard(); return; }
    timer = setTimeout(async () => {
      if (abort) abort.abort();
      abort = new AbortController();
      try {
        const r = await fetch('/api/players/search?q=' + encodeURIComponent(q),
                              { signal: abort.signal });
        drawBoard(await r.json());
      } catch (e) {
        if (e.name !== 'AbortError')
          el('soc-board').innerHTML = '<div class="none2">Could not search. Try again in a moment.</div>';
      }
    }, 250);
  }

  async function openPlayer(name) {
    /* Only a good answer is kept. A server error used to be cached as the
       profile, so that player stayed broken until the page was reloaded; and
       the messages are the lobby's toast, not browser alert boxes. */
    let p = PROFILES.get(name);
    if (!p) {
      try {
        const r = await fetch('/api/profile/' + encodeURIComponent(name));
        if (r.status === 404) { toast('That player no longer exists.'); return; }
        if (r.ok === false) throw new Error('HTTP ' + r.status);
        p = await r.json();
        PROFILES.set(name, p);
      } catch (_) { toast('Could not load that profile. Try again.'); return; }
    }
    /* No initials disc (Owen, 2026-10-15): two letters of the name on a
       colour made from the name, which the board had already dropped. */
    el('p-name').textContent = p.name;
    const rank = (BOARD.find(b => b.name === p.name) || {}).rank;
    el('p-sub').innerHTML = rank ? 'Rank <span class="num">' + rank + '</span>' : '';
    el('p-net').textContent = money(p.totalEarnings);
    el('p-tiles').innerHTML = [
      ['Games played', String(p.gamesPlayed || 0)],
      ['Time played', playTime(p.playTimeSeconds)],
    ].map(t => '<div class="tile"><div class="k">' + t[0] + '</div>' +
               '<div class="v num">' + t[1] + '</div></div>').join('');
    /* One history entry per profile opened, so the phone's Back gesture (or
       the browser's Back) returns to Top earners instead of leaving the site. */
    try { history.pushState({ dsProfile: p.name }, ''); } catch (_) {}
    window.showScreen('player-screen');
    // Drawn once the screen is showing, so the graph is sized to its box, as the Wallet's is.
    drawEarnings(p);
    /* The screen's own top: on a phone each screen scrolls itself, so a
       window scroll left the next profile opening part way down, name and
       Back link above the fold. */
    if (window.jumpToTop) window.jumpToTop(); else scrollTo(0, 0);
  }

  /* The Wallet tab's graph, drawn by the same function from the same rows
     (every cash-out, from the day the account opened, carried to today). It
     used to chart the monthly sums from the server, which stepped once a month
     and stopped at the last payout, so one player's line looked different on
     the two screens. Empty means no recorded payouts, which says so rather
     than drawing a flat line at zero. */
  function drawEarnings(p) {
    const box = el('p-chart');
    const games = Array.isArray(p.games) ? p.games : [];
    if (!games.length) {
      box.innerHTML = '<div class="none2">No cash-outs yet.</div>';
      return;
    }
    window.V2EarningsChart(box, games, p.joinedAt, money);
  }

  // Back from a profile: the board, if the profile is what is on screen.
  window.addEventListener('popstate', () => {
    const scr = el('player-screen');
    if (scr && getComputedStyle(scr).display !== 'none' && window.go) window.go('social');
  });

  window.V2Social = { load: load, drawBoard: drawBoard, search: search, openPlayer: openPlayer };
})();
