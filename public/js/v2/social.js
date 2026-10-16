'use strict';
/* ─── Social: top earners, player search, player profiles ─────────────────────
   Every figure here comes from the server. Response shapes were read out of
   server/index.js, server/db.js and server/earnings rather than guessed:

     GET /api/earnings/board     -> { ok, top: [{ rank, name, game, amount, n }] }
                                    drawn by leaders.js (the top 3 and the full
                                    board): the gold strip's own rule, landed
                                    cash-outs only, owner and bots never on it
     GET /api/players/search?q=  -> ["name", …]   anywhere in the name, names
                                    that start with it first, max 8, LIKE's
                                    wildcards escaped (server/playerStats.js)
                                    NOTE: names only, so opening a result costs a
                                    second request for the profile itself
     GET /api/profile/:name      -> { name, totalEarnings, gamesPlayed,
                                      playTimeSeconds, joinedAt, winRate,
                                      games: [{ amount, at }], … }
                                    :name is a name, or the short wallet the
                                    board shows for a player with no name.
                                    games is every cash-out, the same rows
                                    /api/my-profile gives the Wallet tab.
                                    winRate is { entered, won, since, games }:
                                    paid rounds entered and won, where won means
                                    a landed cash-out worth more than the entry.
     GET /api/earnings/total     -> { on, total, count }  Global player winnings: the
                                    lobby strip's own total (server/earnings), real
                                    players' landed cash-outs only; {on:false} while
                                    the strip's off switch is on
     GET /api/money-config       -> { mode, unit, … }

   ?leaderboard=preview fills the board, search and profiles with sample
   players made in this browser only (socialPreview.js); never sent anywhere. */

(function () {
  let MODE = 'usdc';
  const PROFILES = new Map();          // name -> profile, so reopening is free
  const PV = () => (window.V2SocialPreview && window.V2SocialPreview.on ? window.V2SocialPreview : null);

  // With thousands separators, so $1,234.56 never reads as $1234.56.
  const money = n => (MODE === 'usdc' ? '$' : 'C$') +
    (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const toast = m => (window.V2Play && window.V2Play.toast ? window.V2Play.toast(m) : alert(m));
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
    /* A fresh visit starts with an empty search: a query left in the box from
       last time sat over results that no longer matched it. */
    const q = el('soc-q'); if (q) q.value = '';
    el('soc-board').innerHTML = '';
    try {
      const cfg = await (await fetch('/api/money-config')).json();
      MODE = cfg.mode || 'usdc';
    } catch (_) { /* the default is already the live mode */ }

    pullWin();

    // The top 3 and the full board (leaders.js), live while this tab is open.
    if (window.V2Leaders) window.V2Leaders.load({ money: money, open: openPlayer });
  }

  /* ── Global player winnings ─────────────────────────────────────────────
     What real players have cashed out, all time, live. It is the lobby
     strip's own total (server/earnings: landed cash-outs only, never the owner
     or revenue wallets, test wallets or bots), from the same cached read, so
     Social and the strip can never disagree. It replaced "Paid out to
     players" (/api/stats/winnings), which counted Owen's own test play
     ($242.11 on 2026-10-15) and showed it to the public as player winnings.

     $0.00 until a real player cashes out, and that is the figure, not an
     empty state. Nothing here invents, seeds or pads it: it draws what the
     server says. Asked every WIN_POLL_MS while Social is on screen, answered
     from the server's memory (never a database read per ask); a landed
     cash-out reaches that memory within seconds (earnings.poke), so the next
     ask counts up to the new total and floats the difference beside it. */
  const WIN_URL = '/api/earnings/total' +
    (/(^|[?&])earnings=preview(&|$)/.test(location.search) ? '?preview=1' : '');
  const WIN_POLL_MS = 12000;
  let win = null;              // the total on screen, or null before the first answer
  let winBusy = false, winTimer = null, winAnim = 0;
  const usd = n => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function socialOnScreen() {
    const s = el('social-screen');
    return !!s && getComputedStyle(s).display !== 'none' && !document.hidden &&
      !document.body.classList.contains('ingame');
  }

  /* From `from` to `to` in `ms`, easing out, so a cash-out reads as the
     figure climbing rather than a digit swapping. Run for everyone: it is a
     number changing, and Owen's own PC has animation effects off. */
  function countTo(v, from, to, ms) {
    const run = ++winAnim, t0 = performance.now();
    v.classList.add('hit');
    (function f(t) {
      if (run !== winAnim) return;
      const k = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - k, 3);
      v.textContent = usd(from + (to - from) * e);
      if (k < 1) requestAnimationFrame(f);
      else { v.textContent = usd(to); setTimeout(() => { if (run === winAnim) v.classList.remove('hit'); }, 350); }
    })(t0);
  }

  function drawWin(d) {
    const box = el('soc-win');
    if (!box) return;
    if (!d || d.on !== true || typeof d.total !== 'number' || !isFinite(d.total) || d.total < 0) {
      box.hidden = true; win = null; return;
    }
    if (!box.querySelector('.win-v')) {
      box.innerHTML = '<div class="win-top"><span class="win-k">Global player winnings' +
        (d.preview ? '<span class="win-tag">Preview</span>' : '') + '</span>' +
        '<span class="win-live"><i aria-hidden="true"></i>LIVE</span></div>' +
        '<span class="win-vw"><span class="win-v num"></span><span class="win-up num" aria-hidden="true"></span></span>';
    }
    box.hidden = false;
    const v = box.querySelector('.win-v'), up = box.querySelector('.win-up');
    const to = Math.round(d.total * 100) / 100, from = win;
    win = to;
    v.setAttribute('aria-label', usd(to));
    if (from == null) {                         // first answer: climb from zero once
      if (to > 0) countTo(v, 0, to, 1100); else v.textContent = usd(0);
      return;
    }
    if (to === from) return;
    if (to < from) { winAnim++; v.textContent = usd(to); return; }   // a correction, never dressed up
    countTo(v, from, to, 900);
    up.textContent = '+' + usd(Math.round((to - from) * 100) / 100);
    up.classList.remove('rise'); void up.offsetWidth; up.classList.add('rise');
    /* The lobby strip shows this same total: have it read again now, rather
       than at its own next minute, so the two never show different numbers. */
    if (window.V2Earnings && window.V2Earnings.pull) window.V2Earnings.pull();
  }

  function pullWin() {
    if (winBusy) return;
    winBusy = true;
    fetch(WIN_URL, { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d) drawWin(d); })
      .catch(() => { /* keep what is showing */ })
      .then(() => { winBusy = false; });
    if (!winTimer) {
      winTimer = setInterval(() => { if (socialOnScreen()) pullWin(); }, WIN_POLL_MS);
      document.addEventListener('visibilitychange', () => { if (socialOnScreen()) pullWin(); });
    }
  }

  // What we know a player has earned: the board's figure, when they are on it.
  function knownAmount(name) {
    const pv = PV();
    const a = pv ? pv.amountOf(name) : null;
    if (a != null) return a;
    return window.V2Leaders ? window.V2Leaders.amountOf(name) : null;
  }
  function knownRank(name) {
    const pv = PV();
    const r = pv ? pv.rankOf(name) : null;
    if (r != null) return r;
    return window.V2Leaders ? window.V2Leaders.rankOf(name) : null;
  }

  function rowHTML(name) {
    const amt = knownAmount(name), rank = knownRank(name);
    return '<button type="button" class="prow" data-name="' + esc(name) + '">' +
      '<span class="rk num">' + (rank == null ? '' : rank) + '</span>' +
      '<span class="nm">' + esc(name) + '</span>' +
      '<span class="gp num"></span>' +
      '<span class="er num">' + (amt == null ? '' : money(amt)) + '</span>' +
      '</button>';
  }

  // Search results, under the box. Nothing typed, nothing listed.
  function drawResults(names) {
    const box = el('soc-board');
    if (names == null) { box.innerHTML = ''; return; }
    if (!names.length) { box.innerHTML = '<div class="none2">No player by that name.</div>'; return; }
    box.innerHTML = names.map(rowHTML).join('');
  }

  /* Debounced, and the previous request is aborted, so fast typing cannot land
     an earlier response after a later one and show the wrong results. */
  let timer = null, abort = null;
  function search(q) {
    clearTimeout(timer);
    q = (q || '').trim().slice(0, 24);
    if (!q) { if (abort) abort.abort(); drawResults(null); return; }
    timer = setTimeout(async () => {
      if (abort) abort.abort();
      abort = new AbortController();
      const pv = PV();
      const sample = pv ? pv.search(q) : [];
      try {
        const r = await fetch('/api/players/search?q=' + encodeURIComponent(q),
                              { signal: abort.signal });
        if (r.ok === false) throw new Error('HTTP ' + r.status);
        const real = await r.json();
        const names = sample.concat((Array.isArray(real) ? real : []).filter(n => !sample.includes(n)));
        drawResults(names.slice(0, 8));
      } catch (e) {
        if (e.name === 'AbortError') return;
        if (sample.length) { drawResults(sample); return; }
        el('soc-board').innerHTML = '<div class="none2">Could not search. Try again in a moment.</div>';
      }
    }, 250);
  }

  /* The win rate tile. "How is this counted" sits beside the label as a small
     i, and opens on a tap (a phone has no hover) as well as on a mouse over. */
  function winRateTile(w) {
    const has = w && w.entered > 0;
    const pct = has ? Math.round(100 * w.won / w.entered) + '%' : '—';
    const foot = has ? w.won + ' of ' + w.entered + ' paid rounds' : (w ? 'No paid rounds yet' : 'Not available right now');
    let since = '';
    const t = w && Date.parse(w.since);
    if (t) since = ' Counted since ' + new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + '.';
    const per = has && w.games && w.games.length > 1
      ? '<ul>' + w.games.map(g => '<li><span>' + esc(g.game) + '</span><b class="num">' +
          g.won + ' of ' + g.entered + '</b></li>').join('') + '</ul>'
      : '';
    return '<div class="tile wr"><div class="k">Win rate' +
      '<button type="button" class="wr-i" aria-expanded="false" aria-controls="wr-tip" ' +
        'aria-label="How win rate is counted">i</button></div>' +
      '<div class="v num">' + pct + '</div><div class="f">' + foot + '</div>' +
      '<div class="wr-tip" id="wr-tip" role="tooltip" hidden>' +
        'A paid round is a win when you cash out with more than you paid to enter. ' +
        'Dying, or cashing out for less, is a round played. Free games are not counted.' + since + per +
      '</div></div>';
  }

  function wireWinTip() {
    const btn = document.querySelector('#p-tiles .wr-i');
    const tip = el('wr-tip');
    if (!btn || !tip) return;
    const set = on => { tip.hidden = !on; btn.setAttribute('aria-expanded', String(on)); };
    btn.addEventListener('click', e => { e.stopPropagation(); set(tip.hidden); });
    btn.addEventListener('mouseenter', () => set(true));
    btn.addEventListener('mouseleave', () => { if (document.activeElement !== btn) set(false); });
    btn.addEventListener('blur', () => set(false));
    btn.addEventListener('keydown', e => { if (e.key === 'Escape') set(false); });
  }
  document.addEventListener('click', e => {
    const tip = el('wr-tip');
    if (tip && !tip.hidden && !(e.target.closest && e.target.closest('.wr'))) {
      tip.hidden = true;
      const b = document.querySelector('#p-tiles .wr-i'); if (b) b.setAttribute('aria-expanded', 'false');
    }
  });

  async function openPlayer(name) {
    /* Only a good answer is kept. A server error used to be cached as the
       profile, so that player stayed broken until the page was reloaded; and
       the messages are the lobby's toast, not browser alert boxes. A sample
       player from the preview link is made here and never asked for. */
    const pv = PV();
    let p = (pv && pv.profile(name)) || PROFILES.get(name);
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
    const rank = knownRank(p.name);
    el('p-sub').innerHTML = (rank ? 'Rank <span class="num">' + rank + '</span>' : '') +
      (p.preview ? (rank ? ', ' : '') + '<span class="lb-tag p-tag">Preview</span> sample player' : '');
    el('p-net').textContent = money(p.totalEarnings);
    el('p-tiles').innerHTML = winRateTile(p.winRate) + [
      ['Games played', String(p.gamesPlayed || 0)],
      ['Time played', playTime(p.playTimeSeconds)],
    ].map(t => '<div class="tile"><div class="k">' + t[0] + '</div>' +
               '<div class="v num">' + t[1] + '</div></div>').join('');
    wireWinTip();
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
     (every cash-out, from the day the account opened, carried to today).
     Empty means no recorded payouts, which says so rather than drawing a flat
     line at zero. */
  function drawEarnings(p) {
    const box = el('p-chart');
    const games = Array.isArray(p.games) ? p.games : [];
    if (!games.length) {
      box.innerHTML = '<div class="none2">No cash-outs yet.</div>';
      return;
    }
    window.V2EarningsChart(box, games, p.joinedAt, money);
  }

  // A search result opens its profile. Delegated: the rows are redrawn on every keystroke.
  document.addEventListener('click', e => {
    const row = e.target.closest && e.target.closest('#soc-board .prow');
    if (row) openPlayer(row.getAttribute('data-name'));
  });

  // Back from a profile: the board, if the profile is what is on screen.
  window.addEventListener('popstate', () => {
    const scr = el('player-screen');
    if (scr && getComputedStyle(scr).display !== 'none' && window.go) window.go('social');
  });

  window.V2Social = { load: load, search: search, openPlayer: openPlayer };
})();
