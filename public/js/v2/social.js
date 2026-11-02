'use strict';
/* ─── Leaderboards: player winnings, player search, player profiles ───────────
   Every figure here comes from the server. Response shapes were read out of
   server/index.js, server/db.js and server/earnings rather than guessed:

     GET /api/earnings/board     -> { ok, top: [{ rank, name, game, amount, n }] }
                                    drawn by leaders.js (the top 10): the gold
                                    strip's own rule, landed cash-outs only,
                                    owner and bots never on it
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
     GET /api/earnings/total     -> { on, total, count }  Player winnings, all time:
                                    the lobby strip's own total (server/earnings),
                                    real players' landed cash-outs only; {on:false}
                                    while the strip's off switch is on. Today and
                                    This week are the strip's own periods
                                    (V2Leaders.periodData), offered only when known.

   Site redo stage 3 (layout 1, mockup looks/ab/1/leaderboards.html): Player
   winnings with its period control, the search beside the board on a PC (above
   it on a phone), results as the board's own rows, and the profile as a header
   over the player's main game, three figures, the earnings graph and their paid
   rounds by game. No figure is ever a dash: what is not known says so in words.

   The sample players (socialPreview.js) fill the board, search, profiles
   and Player winnings, tagged Sample: for everyone while config.js
   SAMPLE_BOARD is on, else in one browser after ?leaderboard=preview (until
   ?leaderboard=off). Made in the browser, never sent anywhere. */

(function () {
  const PROFILES = new Map();          // name -> profile, so reopening is free
  const PV = () => (window.V2SocialPreview && window.V2SocialPreview.on ? window.V2SocialPreview : null);
  const L = () => window.V2Leaders || null;

  // With thousands separators, so $1,234.56 never reads as $1234.56.
  // Always dollars: the game counts in dollars in both money modes.
  const money = n => '$' +
    (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const toast = m => (window.V2Play && window.V2Play.toast ? window.V2Play.toast(m) : alert(m));
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const el = id => document.getElementById(id);
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  const ord = n => n + (n % 100 > 10 && n % 100 < 14 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
  const PERSON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/></svg>';
  const CHEV = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';

  function playTime(sec) {
    sec = Number(sec) || 0;
    if (sec < 3600) return Math.round(sec / 60) + 'm';
    const h = Math.floor(sec / 3600);
    return h < 48 ? h + 'h' : Math.round(h / 24) + 'd';
  }

  let chosen = false;          // a period picked by hand this visit stays picked
  async function load() {
    /* A fresh visit starts with an empty search: a query left in the box from
       last time sat over results that no longer matched it. */
    const q = el('soc-q'); if (q) q.value = '';
    drawResults(null);
    if (L() && !chosen) L().setPeriod(L().firstPeriod());
    pullWin();

    // The top 10 (leaders.js), live while this tab is open.
    if (L()) L().load({ money: money, open: openPlayer });
  }

  /* ── Player winnings ────────────────────────────────────────────────────
     What real players have cashed out, live. All time is the lobby strip's
     own total (server/earnings: landed cash-outs only, never the owner or
     revenue wallets, test wallets or bots), from the same cached read, so the
     tab and the strip can never disagree. It replaced "Paid out to players"
     (/api/stats/winnings), which counted Owen's own test play ($242.11 on
     2026-10-15) and showed it to the public as player winnings. Today and This
     week are the strip's own periods, and the board follows the period shown.

     $0.00 until a real player cashes out, and that is the figure, not an
     empty state. Nothing here invents, seeds or pads it: it draws what the
     server says. Asked every WIN_POLL_MS while the tab is on screen, answered
     from the server's memory (never a database read per ask); a landed
     cash-out reaches that memory within seconds (earnings.poke), so the next
     ask counts up to the new total and floats the difference over it. */
  const WIN_URL = '/api/earnings/total' +
    (/(^|[?&])earnings=preview(&|$)/.test(location.search) ? '?preview=1' : '');
  const WIN_POLL_MS = 12000;
  let win = null;              // the all-time total from the server, or null before the first answer
  let winCount = null;
  let shown = null;            // { p, v }: the period and figure on screen
  let winBusy = false, winTimer = null, winAnim = 0;
  const usd = n => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const WORD = { today: 'today', week: 'this week', all: 'all time' };
  const LABEL = { today: 'Today', week: 'This week', all: 'All time' };

  function socialOnScreen() {
    const s = el('social-screen');
    return !!s && getComputedStyle(s).display !== 'none' && !document.hidden &&
      !document.body.classList.contains('ingame');
  }

  /* The climb itself is the lobby's shared one (countUp.js): from $0 when
     the tab opens, a roll from the old total on a rise, so a cash-out reads as
     the figure climbing rather than a digit swapping. This only lights the
     figure while it climbs. */
  function glow(v, from, to) {
    const run = ++winAnim;
    v.classList.add('hit');
    setTimeout(() => { if (run === winAnim) v.classList.remove('hit'); },
      (window.DSCount ? window.DSCount.ms(from, to) : 0) + 350);
  }

  function drawWin(d) {
    const box = el('soc-win');
    if (!box) return;
    if (!d || d.on !== true || typeof d.total !== 'number' || !isFinite(d.total) || d.total < 0) {
      box.hidden = true; win = null; shown = null; return;
    }
    if (!box.querySelector('.win-v')) {
      // Sample unless this is Owen's own preview browser (socialPreview.js liveLook): the tag, never the live mark.
      const sample = d.preview && !d.preview.liveLook ? d.preview : null;
      box.innerHTML = '<div class="lb-sum-hd"><h3 class="lb-sum-t">Player winnings</h3>' +
        (sample ? '<span class="ds-chip lb-sample">' + sample.tag + '</span>'
          : '<span class="ds-chip ds-chip-live is-pulse" data-pulse id="soc-live" title="Updates every minute">Live</span>' +
            '<span class="ds-t-meta lb-upd">Updates every minute</span>') + '</div>' +
        '<div class="ds-seg lb-per" id="lb-per" role="group" aria-label="Period" hidden></div>' +
        '<div class="lb-fig"><span class="win-vw"><b class="win-v num" data-cu="soc-win" data-cu-rise></b><span class="win-up num" aria-hidden="true"></span></span>' +
        '<p class="lb-figsub" id="soc-winsub"></p></div>';
    }
    box.hidden = false;
    win = Math.round(d.total * 100) / 100;
    winCount = typeof d.count === 'number' ? d.count : null;
    drawFig();
  }

  // The period control: All time always, Today and This week when the strip knows them.
  function drawPer() {
    const seg = el('lb-per'); if (!seg) return;
    const ps = L() ? L().periods() : ['all'], cur = L() ? L().period : 'all';
    const key = ps.join() + '|' + cur;
    if (seg._key === key) return; seg._key = key;
    seg.hidden = ps.length < 2;
    seg.innerHTML = ps.map(p => '<button type="button" data-p="' + p + '" aria-pressed="' + (p === cur) + '">' + LABEL[p] + '</button>').join('');
  }

  /* The figure for the period on screen. Live on All time: a rise counts up and floats the difference, a drop is a
     correction shown as it is. A period switch rolls the figure from what it showed, either way. */
  function drawFig() {
    const box = el('soc-win'), v = box && box.querySelector('.win-v'), up = box && box.querySelector('.win-up');
    if (!v) return;
    drawPer();
    const p = L() ? L().period : 'all';
    let to, n;
    if (p === 'all') { if (win == null) return; to = win; n = winCount; }
    else {
      const pd = L() && L().periodData(p);
      if (!pd) { setPeriod('all'); return; }
      to = Math.round((Number(pd.total) || 0) * 100) / 100; n = pd.count;
    }
    const sub = el('soc-winsub');
    if (sub) sub.textContent = to > 0
      ? 'won by players ' + WORD[p] + (n ? ', across ' + plural(n, 'cash-out') : '') + '.'
      : p === 'all' ? 'Nothing paid out to players yet. This counts real players\' cash-outs from paid rooms.'
      : 'Nothing paid out to players ' + WORD[p] + ' yet.';
    v.setAttribute('aria-label', usd(to));
    const was = shown;
    shown = { p: p, v: to };
    if (was == null) {                         // first answer: climbs from zero
      if (to > 0) { v.textContent = usd(to); glow(v, 0, to); } else v.textContent = usd(0);
      return;
    }
    if (was.p !== p) {                         // a period switch: rolls from what showed, down as well as up
      v.removeAttribute('data-cu-rise');
      v.textContent = usd(to);
      setTimeout(() => v.setAttribute('data-cu-rise', ''), 0);
      if (to > was.v) glow(v, was.v, to);
      return;
    }
    const from = was.v;
    if (to === from) return;
    // A correction, never dressed up: data-cu-rise shows a drop as it is.
    if (to < from) { winAnim++; v.classList.remove('hit'); v.textContent = usd(to); return; }
    v.textContent = usd(to);
    glow(v, from, to);
    up.textContent = '+' + usd(Math.round((to - from) * 100) / 100);
    up.classList.remove('rise'); void up.offsetWidth; up.classList.add('rise');
    /* The lobby strip shows this same total: have it read again now, rather
       than at its own next minute, so the two never show different numbers. */
    if (p === 'all' && window.V2Earnings && window.V2Earnings.pull) window.V2Earnings.pull();
  }

  function setPeriod(p) {
    if (!L()) return;
    if (!L().periods().includes(p)) p = 'all';
    L().setPeriod(p);
    drawFig();
  }
  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('#lb-per button[data-p]');
    if (b) { chosen = true; setPeriod(b.getAttribute('data-p')); }
  });

  function pullWin() {
    /* The sample players' figures added up (socialPreview.js), never the
       server's: tagged Sample, and no live mark. */
    const pv = PV();
    if (pv) { drawWin({ on: true, total: pv.total(), preview: pv }); return; }
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
    return L() ? L().amountOf(name) : null;
  }
  function knownRank(name) {
    const pv = PV();
    const r = pv ? pv.rankOf(name) : null;
    if (r != null) return r;
    return L() ? L().rankOf(name) : null;
  }
  const art = g => (L() && g ? L().artFor(g) : '');
  const isMine = name => !!(L() && L().mine(name));

  /* A search result, in the board's own row: the player's main game, where they stand all time, and what they have
     taken home when the board knows it. A sample player says so. With no known place it claims none (the board may
     not have loaded, or show sample players): its main game, or where the row goes (review 2026-11-02). */
  function rowHTML(name) {
    const amt = knownAmount(name), rank = knownRank(name), pv = PV();
    const sample = !!(pv && pv.profile(name));
    const game = sample ? (pv.board(50).top.find(x => x.name === name) || {}).game : (L() ? L().gameOf(name) : null);
    const img = art(game);
    const sub = rank ? ord(rank) + ' all time' + (game ? ', mostly ' + game : '') : game ? 'Mostly ' + game : 'Open their profile';
    return '<button type="button" class="ds-row prow" data-name="' + esc(name) + '">' +
      '<span class="ds-row-ic">' + (img ? '<img src="' + img + '" alt="" decoding="async" draggable="false">' : PERSON) + '</span>' +
      '<span class="ds-row-main"><b><span>' + esc(name) + '</span>' +
        (isMine(name) ? '<span class="ds-chip lb-you">You</span>' : '') +
        (sample ? '<span class="ds-chip lb-sample">' + pv.tag + '</span>' : '') + '</b>' +
      '<span>' + esc(sub) + '</span></span>' +
      (amt == null ? '<span class="ds-row-end lb-chev">' + CHEV + '</span>' : '<span class="ds-row-end ds-money num">' + money(amt) + '</span>') +
      '</button>';
  }

  // Search results, under the box. Nothing typed: one line saying what it finds.
  function drawResults(names) {
    const box = el('soc-board');
    if (!box) return;
    if (names == null) { box.innerHTML = '<p class="ds-hint">Finds anyone who has played, on the board or not.</p>'; return; }
    if (!names.length) { box.innerHTML = '<p class="ds-hint lb-miss">No player by that name.</p>'; return; }
    box.innerHTML = '<div class="ds-list">' + names.map(rowHTML).join('') + '</div>';
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
        el('soc-board').innerHTML = '<p class="ds-hint">Could not search just now. Try again in a moment.</p>';
      }
    }, 250);
  }

  /* The win rate figure, and how it is counted one press away (winHow, the
     lobby's How it works sheet). No paid rounds says so in words, never a dash. */
  let WR = null, WRNAME = '';
  function winRateTile(w) {
    const has = w && w.entered > 0;
    return '<div class="ds-stat"><span>Win rate</span>' + (has
      ? '<b class="num">' + Math.round(100 * w.won / w.entered) + '%</b><small>' + w.won + ' of ' + plural(w.entered, 'paid round') + '</small>'
      : '<b class="pf-nil">' + (w ? 'No paid rounds' : 'Not available') + '</b><small>' + (w ? 'Free games are not counted' : 'Try again in a moment') + '</small>') +
      '</div>';
  }
  /* Paid rounds by game, from the same counts as the win rate. */
  function splitHTML(w) {
    const games = w && Array.isArray(w.games) ? w.games.filter(g => g && g.entered > 0) : [];
    if (!w) return '<p class="ds-hint pf-nowr">Not available right now.</p>';
    if (!games.length) return '<p class="ds-hint pf-nowr">No paid rounds yet. Free games are not counted.</p>';
    return '<div class="ds-list">' + games.map(g => {
      const img = art(g.game);
      return '<div class="ds-row"><span class="ds-row-ic">' + (img ? '<img src="' + img + '" alt="" decoding="async" draggable="false">' : PERSON) + '</span>' +
        '<span class="ds-row-main"><b>' + esc(g.game) + '</b><span>Won ' + g.won + ' of ' + g.entered + '</span></span>' +
        '<span class="ds-row-end num">' + Math.round(100 * g.won / g.entered) + '%</span></div>';
    }).join('') + '</div>';
  }
  function winHow() {
    const w = WR;
    let since = '';
    const t = w && Date.parse(w.since);
    if (t) since = ' Counted since ' + new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + '.';
    const steps = [
      ['A win', 'A paid round is a win when you cash out with more than you paid to enter.'],
      ['A round played', 'Dying, or cashing out for less than the entry, is a round played but not won.'],
      ['Free games', 'Free games and free rooms are not counted.' + since],
    ];
    if (w && w.entered > 0) steps.push([esc(WRNAME), w.won + ' of ' + plural(w.entered, 'paid round') + ' won.']);
    if (typeof window.openHow === 'function') window.openHow('How a win is counted', steps);
  }

  async function openPlayer(name, opt) {
    /* Only a good answer is kept. A server error used to be cached as the
       profile, so that player stayed broken until the page was reloaded; and
       the messages are the lobby's toast, not browser alert boxes. A sample
       player from the preview link is made here and never asked for. */
    const pv = PV();
    /* Your own profile (me.js, opt.own) is always the real one, even when a sample player shares your name. */
    let p = (!(opt && opt.own) && pv && pv.profile(name)) || PROFILES.get(name);
    if (!p) {
      try {
        const r = await fetch('/api/profile/' + encodeURIComponent(name));
        if (r.status === 404) { toast('That player no longer exists.'); return; }
        if (r.ok === false) throw new Error('HTTP ' + r.status);
        p = await r.json();
        PROFILES.set(name, p);
      } catch (_) { toast('Could not load that profile. Try again.'); return; }
    }
    /* The name by textContent (it is player input), then its marks. */
    const h = el('p-name');
    h.textContent = '';
    const nm = document.createElement('span'); nm.textContent = p.name; h.appendChild(nm);
    const mineToo = isMine(p.name);
    if (mineToo) h.insertAdjacentHTML('beforeend', '<span class="ds-chip lb-you">You</span>');
    if (p.preview) h.insertAdjacentHTML('beforeend', '<span class="ds-chip lb-sample">' + PV().tag + '</span>');
    el('p-mine').hidden = !mineToo;

    const games = Array.isArray(p.games) ? p.games : [];
    const w = p.winRate;
    const rank = knownRank(p.name);
    const byWins = w && Array.isArray(w.games) ? w.games.filter(g => g && g.entered > 0).sort((a, b) => b.entered - a.entered) : [];
    const top = (pv && p.preview ? (pv.board(50).top.find(x => x.name === p.name) || {}).game : null) ||
      (L() ? L().gameOf(p.name) : null) || (byWins[0] && byWins[0].game) || '';
    const joined = Date.parse(p.joinedAt);
    el('p-sub').textContent = [
      rank ? ord(rank) + ' on the all-time money board.' : '',
      top ? 'Plays ' + top + ' most.' : '',
      joined ? 'Joined ' + new Date(joined).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + '.' : '',
    ].filter(Boolean).join(' ');
    const ar = el('p-art'), src = art(top);
    if (ar) { if (src) { if (ar.getAttribute('src') !== src) ar.src = src; ar.hidden = false; } else ar.hidden = true; }
    el('p-net').textContent = money(p.totalEarnings);
    el('p-netsub').textContent = games.length ? plural(games.length, 'cash-out') + ', after the 10% cut' : 'No cash-outs yet';
    WR = w || null; WRNAME = p.name;
    el('p-tiles').innerHTML = winRateTile(p.winRate) + [
      ['Games played', String(p.gamesPlayed || 0), 'Free and paid'],
      ['Time played', playTime(p.playTimeSeconds), 'In every game'],
    ].map(t => '<div class="ds-stat"><span>' + t[0] + '</span><b class="num">' + t[1] + '</b><small>' + t[2] + '</small></div>').join('');
    el('p-split').innerHTML = splitHTML(w);
    /* One history entry per profile opened, so the phone's Back gesture (or
       the browser's Back) returns to the board instead of leaving the site. */
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
    const hint = el('p-chart-hint');
    if (hint) hint.textContent = games.length ? (matchMedia('(pointer: coarse)').matches ? 'Drag across it to read a day' : 'Hover to read a day') : '';
    if (!games.length) {
      box.innerHTML = '<div class="pf-empty"><b>No cash-outs yet</b><p class="ds-hint">The line starts at the first cash-out from a paid room.</p></div>';
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

  window.V2Social = { load: load, search: search, openPlayer: openPlayer, setPeriod: setPeriod, winHow: winHow,
    repaint: drawFig };
})();
