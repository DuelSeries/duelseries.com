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
                                      playTimeSeconds,
                                      history: { week[], month[], sixMonth[],
                                                 allTime[] } }
                                    each series is [{ period, total }].
                                    NOTE the series are nested under `history`,
                                    not top level; reading them flat silently
                                    yields no chart at all.
     GET /api/stats/winnings     -> { totalCad }  a fiat sum already; do not
                                    re-multiply, only label it by money mode
     GET /api/money-config       -> { mode, unit, … }

   What the server does NOT have, and is therefore not shown: per-game win/loss,
   house cut paid, and buy-in history for other players. The prototype invented
   those. A profile shows what is really recorded and nothing more. */

(function () {
  let MODE = 'usdc';
  let BOARD = [];
  const PROFILES = new Map();          // name -> profile, so reopening is free

  const money = n => (MODE === 'usdc' ? '$' : 'C$') + (Number(n) || 0).toFixed(2);
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const initials = n => esc(String(n).replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase());
  const el = id => document.getElementById(id);

  /* A name is all the server gives us to identify a player, so the avatar
     colour is derived from it rather than stored. Same name, same colour,
     on every device. */
  function tint(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return (window.V2_LOOKS || [{ color: '#c080ff' }])[h % (window.V2_LOOKS || [1]).length].color;
  }

  function playTime(sec) {
    sec = Number(sec) || 0;
    if (sec < 3600) return Math.round(sec / 60) + 'm';
    const h = Math.floor(sec / 3600);
    return h < 48 ? h + 'h' : Math.round(h / 24) + 'd';
  }

  async function load() {
    try {
      const cfg = await (await fetch('/api/money-config')).json();
      MODE = cfg.mode || 'usdc';
    } catch (_) { /* the default is already the live mode */ }

    let winnings = null;
    try { winnings = (await (await fetch('/api/stats/winnings')).json()).totalCad; }
    catch (_) { winnings = null; }

    try { BOARD = await (await fetch('/api/earningsboard')).json(); }
    catch (_) { BOARD = []; }
    if (!Array.isArray(BOARD)) BOARD = [];

    el('soc-sub').textContent = BOARD.length
      ? 'Everyone who has finished a game ahead.'
      : 'No winners yet. The first cash-out lands here.';

    /* The one figure worth stating site-wide, and it belongs under the board
       rather than over it: it is the total of the rows above. "Players in
       profit" went with it — the board already IS that list, so the count was
       a tile restating its own length. */
    el('soc-tiles').innerHTML =
      '<div class="tile"><div class="k">Total player earnings</div>' +
      '<div class="v num">' + (winnings == null ? '—' : money(winnings)) + '</div>' +
      '<div class="f">paid out to players, all time</div></div>';

    drawBoard();
  }

  function rowHTML(name, earnings, rank) {
    return '<button class="prow" onclick="V2Social.openPlayer(' +
      JSON.stringify(name).replace(/"/g, '&quot;') + ')">' +
      '<span class="rk num">' + (rank == null ? '' : rank) + '</span>' +
      '<span class="pav" style="background:' + tint(name) + '">' + initials(name) + '</span>' +
      '<span class="nm">' + esc(name) + '</span>' +
      '<span class="gp num"></span>' +
      '<span class="er num">' + (earnings == null ? '' : money(earnings)) + '</span>' +
      '</button>';
  }

  function drawBoard(names) {
    const box = el('soc-board');
    if (names) {                                   // search results: names only
      if (!names.length) {
        box.innerHTML = '<div class="none2">No player by that name. ' +
          'Search matches the start of a name, so try fewer letters.</div>';
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
      box.innerHTML = '<div class="none2">Nobody has cashed out ahead yet. ' +
        'Win a game and this is where you land.</div>';
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
          el('soc-board').innerHTML = '<div class="none2">Could not reach the ' +
            'server. Check your connection and try again.</div>';
      }
    }, 250);
  }

  async function openPlayer(name) {
    let p = PROFILES.get(name);
    if (!p) {
      try {
        const r = await fetch('/api/profile/' + encodeURIComponent(name));
        if (r.status === 404) { alert('That player no longer exists.'); return; }
        p = await r.json();
        PROFILES.set(name, p);
      } catch (_) { alert('Could not load that profile. Try again.'); return; }
    }
    el('p-av').style.background = tint(p.name);
    el('p-av').textContent = initials(p.name);
    el('p-name').textContent = p.name;
    const rank = (BOARD.find(b => b.name === p.name) || {}).rank;
    el('p-sub').innerHTML = rank
      ? 'Rank <span class="num">' + rank + '</span> on the earnings board'
      : 'Not on the earnings board';
    el('p-net').textContent = money(p.totalEarnings);
    el('p-tiles').innerHTML = [
      ['Games played', String(p.gamesPlayed || 0), 'all time'],
      ['Time played', playTime(p.playTimeSeconds), 'in game'],
    ].map(t => '<div class="tile"><div class="k">' + t[0] + '</div>' +
               '<div class="v num">' + t[1] + '</div>' +
               '<div class="f">' + t[2] + '</div></div>').join('');
    drawEarnings(p);
    window.showScreen('player-screen');
    scrollTo(0, 0);
  }

  /* The server returns earnings bucketed by period, which is exactly the shape
     the running-total chart wants. Empty means a player with no recorded
     payouts, which says so rather than drawing a flat line at zero. */
  function drawEarnings(p) {
    const h = p.history || {};
    const series = (h.allTime && h.allTime.length ? h.allTime
                 : h.sixMonth && h.sixMonth.length ? h.sixMonth
                 : h.month) || [];
    const box = el('p-chart');
    if (!series.length) {
      box.innerHTML = '<div class="none2">No payouts recorded yet.</div>';
      return;
    }
    let run = 0;
    const pts = series.map(s => ({ d: s.period, cum: (run += Number(s.total) || 0) }));
    box.innerHTML = window.V2Chart(pts, money);
    if (window.V2ChartWire) window.V2ChartWire(box, money);
  }

  window.V2Social = { load: load, drawBoard: drawBoard, search: search, openPlayer: openPlayer };
})();
