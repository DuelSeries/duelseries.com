'use strict';
/* ─── Leaderboards: the top 10, live ──────────────────────────────────────────
   The top 10 on the Leaderboards tab (Owen, 2026-10-15; all ten on the board
   since 2026-10-26). Site redo stage 3 (layout 1, mockup
   looks/ab/1/leaderboards.html): the top 3 are tiles with each player's main
   game behind them, places 4 to 10 the kit's rows, for the period Player
   winnings shows (social.js owns that control and calls setPeriod).

   Real data only, the gold strip's own read and rule (server/earnings):
   take-home from paid cash-outs that LANDED, never the owner, revenue or test
   wallets, and bots have no wallet to count.
     All time     GET /api/earnings/board, shown even while the strip is
                  switched off (the board is its own screen).
     Today, This week   the strip's own answer (/api/earnings, read by
                  earnings.js, V2Earnings.data), only while it is on and not
                  the owner's preview, so they are offered only when known.
   The server reads the database once a minute at most, so this asks once a
   minute while the tab is on screen, which is what "live" means here.

   The sample players (socialPreview.js: everyone while config.js
   SAMPLE_BOARD is on, else ?leaderboard=preview in one browser) take its
   place, never marked live, with one line under the board saying they are
   sample players (the tag itself sits in Player winnings, social.js).

   Its styles live in v2.html with the rest of the tab's. */
(function () {
  const PERIOD_MS = 60000;
  const P = () => window.V2SocialPreview && window.V2SocialPreview.on ? window.V2SocialPreview : null;
  /* Owen asked to see the sample board as LIVE (2026-10-26). Made-up players
     marked live on a real-money site would mislead real visitors, so they never
     are (socialPreview.js liveLook is always false now). */
  const SAMPLE = () => !!P() && !P().liveLook;
  const PERIODS = ['today', 'week', 'all'];
  const ROWS = 25;            // made-up players shown on the board (the real board is the server's top 10)
  const WORD = { today: 'today', week: 'this week', all: 'all time' };

  let money = n => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  let open = () => {};
  let data = null;            // last good all-time board { ok, top, preview? }
  let failed = false;
  let timer = null;
  let period = 'all';

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const $ = id => document.getElementById(id);
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  const ord = n => n + (n % 100 > 10 && n % 100 < 14 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
  const PERSON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/></svg>';

  /* A period's board and totals: { top: [{ name, game, amount, n }], total, count }, or null when not known. */
  function periodData(p) {
    const pv = P();
    if (pv) return p === 'all' ? { top: pv.board(ROWS).top, total: pv.total(), count: null } : pv.periods()[p] || null;
    if (p === 'all') return data ? { top: data.top || [], total: null, count: null } : null;
    const d = window.V2Earnings && window.V2Earnings.data;
    if (!d || d.on !== true || d.preview || !d.periods || !d.periods[p]) return null;
    return d.periods[p];
  }
  // The periods that can be shown: All time always, Today and This week when known.
  // All time only (Owen 2026-11-02: the pre-redo board, no Today or This week).
  const periods = () => ['all'];
  // Like earnings.js: open on the first period that has anyone on it.
  const firstPeriod = () => periods().find(p => { const d = periodData(p); return d && d.top && d.top.length; }) || 'all';

  /* The card art of a game the board names ('Slither.io', 'Chomp'), from the lobby's own registry. */
  function artFor(label) {
    const names = window.V2_GAME_NAMES || {}, art = window.V2_artSrc;
    if (!art || !label) return '';
    const l = String(label).toLowerCase();
    let id = Object.keys(names).find(k => String(names[k]).toLowerCase() === l);
    if (!id && names[l]) id = l;
    return id ? art(id) : '';
  }
  function mine(name) {
    const w = window.duelWallet || {};
    const me = window.V2Play && window.V2Play.savedName ? window.V2Play.savedName() : '';
    return !!(w.authenticated && me && String(name).toLowerCase() === me.toLowerCase());
  }
  const you = name => mine(name) ? ' <span class="ds-chip lb-you">You</span>' : '';
  const sub = r => [r.game, r.n ? plural(r.n, 'cash-out') : ''].filter(Boolean).join(', ');
  // The one counted figure: a period switch or a refresh rolls each player's amount from what it showed.
  const amt = (r, cls) => '<span class="' + cls + '" data-cu="lb-' + esc(r.name) + '">' + money(r.amount) + '</span>';

  function tile(r, i) {
    const img = artFor(r.game), place = ord(i + 1);
    const label = place + ', ' + r.name + ', ' + money(r.amount) + '. Open profile';
    return '<button type="button" class="ds-panel lb-t lbrow is-' + (i + 1) + '" data-name="' + esc(r.name) + '" aria-label="' + esc(label) + '">' +
      (img ? '<img class="lb-t-art" src="' + img + '" alt="" decoding="async" draggable="false">' : '') +
      '<span class="lb-t-rk">' + place + '</span><b class="lb-t-nm"><span>' + esc(r.name) + '</span>' + you(r.name) + '</b>' +
      amt(r, 'lb-t-v') + '<span class="lb-t-sub">' + esc(sub(r)) + '</span></button>';
  }
  function emptyTile(i, have) {
    return '<div class="ds-panel lb-t is-' + (i + 1) + ' is-empty"><span class="lb-t-rk">' + ord(i + 1) + '</span>' +
      '<b class="lb-t-nm">' + (have ? 'Nobody else yet' : 'Nobody yet') + '</b><span class="lb-t-sub">' +
      (period === 'all' ? 'No cash-outs yet' : 'None ' + WORD[period]) + '</span></div>';
  }
  function rowHTML(r) {
    const img = artFor(r.game);
    return '<button type="button" class="ds-row lb-row lbrow" data-name="' + esc(r.name) + '"><span class="lb-rk">' + r.rank + '</span>' +
      '<span class="ds-row-ic">' + (img ? '<img src="' + img + '" alt="" decoding="async" draggable="false">' : PERSON) + '</span>' +
      '<span class="ds-row-main"><b><span>' + esc(r.name) + '</span>' + you(r.name) + '</b><span>' + esc(sub(r)) + '</span></span>' +
      amt(r, 'ds-row-end ds-money') + '</button>';
  }

  // The live mark in Player winnings: hidden for sample players and while the board is not loading.
  function drawMarks() {
    const live = $('soc-live');
    if (live) {
      live.hidden = SAMPLE() || failed;
      live.title = 'Updates every minute';
    }
  }

  function draw() {
    const box = $('soc-top');
    if (!box) return;
    drawMarks();
    if (!periods().includes(period)) period = 'all';
    const h = $('lb-top-t');
    if (h) h.innerHTML = 'Top earners' + (SAMPLE() ? ' <span class="ds-chip lb-sample">' + P().tag + '</span>' : '');
    if (!data && !P()) {
      box.innerHTML = failed
        ? '<div class="ds-panel lb-none" role="status"><b>Could not load the board.</b><p class="ds-hint">It tries again every minute. ' +
          'Search and player profiles still work.</p><button type="button" class="ds-btn ds-btn-secondary ds-btn-sm" data-retry>Try again now</button></div>'
        : '<div class="ds-panel lb-none"><span class="lb-load"><span class="ds-spin" aria-hidden="true"></span>Loading the board</span></div>';
      return;
    }
    const pd = periodData(period) || { top: [] };
    const top = (pd.top ? pd.top.slice(0, ROWS) : []).map((r, i) => Object.assign({}, r, { rank: r.rank || i + 1 }));
    // One plain list, 1st down (the pre-redo board): no podium cards.
    let html = top.length ? '<div class="ds-panel ds-panel-tight lb-rest"><div class="ds-list">' + top.map(rowHTML).join('') + '</div></div>' : '';
    if (!top.length) {
      const later = PERIODS.slice(PERIODS.indexOf(period) + 1)
        .find(p => periods().includes(p) && (periodData(p).top || []).length);
      html += '<div class="lb-foot"><p>' + (period === 'all'
        ? 'Nobody has cashed out yet. Players show up here once they cash out from a paid room.'
        : 'Nobody has cashed out ' + WORD[period] + ' yet.') + '</p>' +
        (later ? '<button type="button" class="ds-btn ds-btn-secondary ds-btn-sm" data-per="' + later + '">See ' + WORD[later] + '</button>' : '') + '</div>';
    }
    box.innerHTML = html;
  }

  async function refresh() {
    const p = P();
    if (p) { data = p.board(ROWS); failed = false; draw(); return; }
    try {
      const r = await fetch('/api/earnings/board', { cache: 'no-store' });
      if (r.ok === false) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (!j || j.ok !== true || !Array.isArray(j.top)) throw new Error('bad answer');
      data = j; failed = false;
    } catch (_) {
      failed = true;          // the last good board stays up; the live mark goes
    }
    draw();
    // Today and This week may have come or gone with the strip's own read: Player winnings follows.
    if (window.V2Social && window.V2Social.repaint) window.V2Social.repaint();
  }

  const onSocial = () => { const s = $('social-screen'); return !!s && getComputedStyle(s).display !== 'none'; };
  function tick() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (document.visibilityState === 'visible' && onSocial()) refresh().then(tick, tick);
      else tick();
    }, PERIOD_MS);
  }

  /* Called by social.js each time the Leaderboards tab opens: draws at once
     from the last answer, then asks again. */
  function load(opts) {
    if (opts && typeof opts.money === 'function') money = opts.money;
    if (opts && typeof opts.open === 'function') open = opts.open;
    const box = $('soc-top');
    if (box && !box._wired) {
      box._wired = true;
      box.addEventListener('click', e => {
        const t = e.target.closest && e.target;
        if (!t) return;
        const row = t.closest('.lbrow');
        if (row) { open(row.getAttribute('data-name')); return; }
        const per = t.closest('[data-per]');
        if (per && window.V2Social && window.V2Social.setPeriod) { window.V2Social.setPeriod(per.getAttribute('data-per')); return; }
        const again = t.closest('[data-retry]');
        if (again) { again.disabled = true; refresh().then(() => { again.disabled = false; }); }
      });
    }
    draw();
    return refresh().then(tick);
  }

  function setPeriod(p) { if (PERIODS.includes(p)) { period = p; draw(); } }

  function find(name) {
    const r = data && (data.top || []).find(x => x.name === name);
    return r || null;
  }
  function rankOf(name) { const r = find(name); return r ? r.rank : null; }
  function amountOf(name) { const r = find(name); return r ? r.amount : null; }
  function gameOf(name) { const r = find(name); return r ? r.game : null; }

  window.V2Leaders = { load: load, rankOf: rankOf, amountOf: amountOf, gameOf: gameOf, artFor: artFor, mine: mine,
    periods: periods, periodData: periodData, firstPeriod: firstPeriod, setPeriod: setPeriod,
    get period() { return period; } };
})();
