'use strict';
/* ─── Profile (Owen's pick S1, 2026-11-04): your own record in one place, in the tab where Shop was ─────────────
   Mockup: Claude Code Test/lobby-round/s1.html. Nothing new on the server; the two answers that already exist:

     GET /api/my-profile?wallet=<address> -> { name, totalEarnings, earnings, gamesPlayed, playTimeSeconds,
                                               games: [{ amount, at }] }       every cash-out (the Wallet's rows)
       totalEarnings is the NET (server/netEarnings.js, Owen 2026-11-05): paid out minus paid in, so it can be below
       zero (-$0.10 for a flat $1 round); earnings carries its halves and the date it counts from.
     GET /api/profile/:name               -> { joinedAt, winRate: { entered, won, since, games: [{ game, entered, won }] } }

   The second is asked only with a name, which is what the board and the search know a player by. Cash-outs are
   recorded without their game, so Your games is paid rounds won by game (the public profile's own counts) and Recent
   cash-outs is amounts and times. Every figure is the server's; what is not known says so in words, never a dash.
   Names reach the page through esc() only (they are player input). Read only: nothing here signs, sends or spends.

   Signed out it says what the tab holds and offers Sign in. A PC opens it from the sidebar; a phone from the header
   card (me.js, "Your profile").

   Exposes window.V2Profile = { render }. */
(function () {
  const el = id => document.getElementById(id);
  // Always dollars, with thousands separators (social.js's money).
  const money = n => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // A figure that can be below zero: -$0.10, never $-0.10.
  const signed = n => (Number(n) < 0 ? '-' : '') + money(Math.abs(Number(n) || 0));
  /* Under Total earnings, what it is (Owen 2026-11-05): the server's net, paid out minus paid in. Counted from the
     first recorded buy-in, so a player with cash-outs from before then is told the date. */
  function netCaption(m, cash) {
    const e = m.earnings || null;
    if (!e || !(e.rounds > 0 || e.cashouts > 0)) return 'No paid rounds yet';
    const since = Date.parse(e.since);
    const older = since && cash.some(g => Date.parse(g.at) < since);
    return 'Cash-outs minus buy-ins, after the 10% cut' +
      (older ? ', since ' + new Date(since).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');
  }
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  const W = () => window.duelWallet || {};
  const signedIn = () => { const w = W(); return !!(w.authenticated && w.address); };
  const noSession = () => !!(window.DSWalletBoot && window.DSWalletBoot.session === false);
  const art = g => (window.V2Leaders && g ? window.V2Leaders.artFor(g) : '');
  const ICON = {
    person: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/></svg>',
    coin: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v10M9.5 9.5c0-1 1.1-1.7 2.5-1.7s2.5.7 2.5 1.7-1.1 1.6-2.5 1.8-2.5.8-2.5 1.8 1.1 1.7 2.5 1.7 2.5-.7 2.5-1.7"/></svg>',
    eye: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
    pen: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>'
  };

  function playTime(sec) {
    sec = Number(sec) || 0;
    if (sec < 3600) return Math.round(sec / 60) + 'm';
    const h = Math.floor(sec / 3600);
    return h < 48 ? h + 'h' : Math.round(h / 24) + 'd';
  }
  // "today 9:12 PM", "yesterday 8:40 PM", "Oct 28, 9:12 PM"
  function when(t) {
    const d = new Date(t); if (isNaN(d)) return '';
    const hm = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const day = new Date(); day.setHours(0, 0, 0, 0);
    const diff = Math.floor((day - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 864e5);
    if (diff <= 0) return 'today ' + hm;
    if (diff === 1) return 'yesterday ' + hm;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' + hm;
  }
  const shown = () => { const s = el('profile-screen'); return !!(s && getComputedStyle(s).display !== 'none'); };

  /* One answer per wallet, kept a minute: switching tabs back and forth does not ask again. */
  let got = null, gotFor = '', gotAt = 0, asking = null;
  async function fetchAll(addr) {
    const r = await fetch('/api/my-profile?wallet=' + encodeURIComponent(addr), { cache: 'no-store' });
    if (r.ok === false) throw new Error('HTTP ' + r.status);
    const mine = await r.json();
    let pub = null;
    if (mine && mine.name) {
      try {
        const q = await fetch('/api/profile/' + encodeURIComponent(mine.name));
        if (q.ok) pub = await q.json();
      } catch (_) { /* the paid rounds say Not available; the rest still shows */ }
    }
    return { mine: mine || {}, pub: pub };
  }

  function out() {
    return '<section class="ds-panel pr-out">' +
      '<span class="pr-av q" aria-hidden="true">' + ICON.person + '</span>' +
      '<div><h3>Sign in to see your profile</h3><p>Your earnings, your games and your paid rounds, in one place.</p></div>' +
      '<button type="button" class="ds-btn ds-btn-primary" onclick="V2Wallet.login(\'profile\')">Sign in</button></section>';
  }
  function wait(t) {
    return '<section class="ds-panel pr-wait" role="status"><span class="ds-spin" aria-hidden="true"></span>' + esc(t) + '</section>';
  }
  function failed() {
    return '<section class="ds-panel pr-wait" role="status">Could not load your profile. ' +
      '<button type="button" class="ds-btn ds-btn-secondary ds-btn-sm" onclick="V2Profile.render(true)">Try again</button></section>';
  }

  function page(d) {
    const m = d.mine, p = d.pub || {};
    const name = String(m.name || '');
    const cash = (Array.isArray(m.games) ? m.games : []).filter(g => g && Number(g.amount) > 0);
    const best = cash.reduce((t, g) => Math.max(t, Number(g.amount) || 0), 0);
    const w = p.winRate || null;
    const byGame = w && Array.isArray(w.games) ? w.games.filter(g => g && g.entered > 0).sort((a, b) => b.entered - a.entered || b.won - a.won) : [];
    const joined = Date.parse(p.joinedAt);
    const sub = [
      joined ? 'Joined ' + new Date(joined).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + '.' : '',
      byGame[0] ? 'Plays ' + byGame[0].game + ' most.' : ''
    ].filter(Boolean).join(' ') || (name ? 'Your record on DuelSeries.' : 'Pick a name to show up on the leaderboards.');

    const hd = '<section class="ds-panel pr-hd">' +
      '<span class="pr-av' + (name ? '' : ' q') + '" aria-hidden="true">' + (name ? esc(name.charAt(0).toUpperCase()) : ICON.person) + '</span>' +
      '<div class="pr-id"><h3>' + (name ? esc(name) : 'No name yet') + '</h3><p>' + esc(sub) + '</p>' +
        '<div class="pr-acts">' +
          (name ? '<button type="button" class="ds-btn ds-btn-secondary ds-btn-sm" data-pr="public">' + ICON.eye + 'See what others see</button>' : '') +
          '<button type="button" class="ds-btn ds-btn-quiet ds-btn-sm" data-pr="name">' + ICON.pen + (name ? 'Change name' : 'Pick a name') + '</button>' +
        '</div></div>' +
      '<div class="pr-tot"><span class="ds-t-label">Total earnings</span><b class="num"' +
        (Number(m.totalEarnings) < 0 ? ' style="color:var(--ds-red)"' : '') + '>' + signed(m.totalEarnings) + '</b>' +
        '<span class="ds-t-meta">' + esc(netCaption(m, cash)) + '</span></div>' +
      '</section>';

    const stat = (label, val, small, cls) => '<div class="ds-stat"><span>' + label + '</span><b class="num' + (cls ? ' ' + cls : '') + '">' + val + '</b>' +
      (small ? '<small>' + small + '</small>' : '') + '</div>';
    const wr = w && w.entered > 0
      ? stat('Win rate', Math.round(100 * w.won / w.entered) + '%', w.won + ' of ' + plural(w.entered, 'paid round'))
      : stat('Win rate', w ? 'No paid rounds' : 'Not available', w ? 'Free games are not counted' : (name ? 'Try again in a moment' : 'Needs a name'), 'pr-nil');
    const stats = '<div class="ds-stat-row pr-stats">' + wr +
      stat('Games played', String(Number(m.gamesPlayed) || 0), 'Free and paid') +
      stat('Best payout', best > 0 ? money(best) : 'None yet', best > 0 ? 'One cash-out' : 'Win a paid room', best > 0 ? 'ds-money' : 'pr-nil') +
      stat('Time played', playTime(m.playTimeSeconds), 'In every game') + '</div>';

    const games = byGame.length
      ? '<div class="pr-games">' + byGame.slice(0, 6).map((g, i) => {
          const img = art(g.game);
          return '<div class="pr-g' + (i === 0 ? ' best' : '') + '">' + (img ? '<img src="' + img + '" alt="" decoding="async" draggable="false">' : '') +
            (i === 0 ? '<span class="ds-chip">Most played</span>' : '') +
            '<b>' + esc(g.game) + '</b><span>Won ' + g.won + ' of ' + plural(g.entered, 'paid round') + '</span>' +
            '<em class="num">' + Math.round(100 * g.won / g.entered) + '%</em></div>';
        }).join('') + '</div>'
      : '<p class="ds-hint pr-none">' + (w ? 'No paid rounds yet. Free games are not counted.' : name ? 'Not available right now.' : 'Pick a name and your paid rounds show here.') + '</p>';

    const recent = cash.length
      ? '<div class="ds-list">' + cash.slice().sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 6).map(g =>
          '<div class="ds-row"><span class="ds-row-ic in">' + ICON.coin + '</span><span class="ds-row-main"><b>Cash-out</b><span>' + esc(when(g.at)) + '</span></span>' +
          '<span class="ds-row-end ds-win num">+' + money(g.amount) + '</span></div>').join('') + '</div>'
      : '<p class="ds-hint pr-none">No cash-outs yet. Win a paid room and it shows here.</p>';

    return hd + stats + '<div class="pr-grid">' +
      '<section class="ds-panel"><div class="ds-panel-head"><h2>Your games</h2><span class="ds-t-meta">Paid rounds won</span></div>' + games + '</section>' +
      '<section class="ds-panel"><div class="ds-panel-head"><h2>Recent cash-outs</h2></div>' + recent + '</section></div>';
  }

  async function render(force) {
    const box = el('pr-body'); if (!box) return;
    const w = W();
    if (!signedIn()) {
      box.innerHTML = (w.ready || noSession()) ? out() : wait('Starting your wallet');
      return;
    }
    const addr = w.address;
    if (!force && got && gotFor === addr && Date.now() - gotAt < 60000) { box.innerHTML = page(got); return; }
    if (!(got && gotFor === addr)) box.innerHTML = wait('Getting your profile');
    if (asking) return asking;
    asking = (async () => {
      try {
        const d = await fetchAll(addr);
        got = d; gotFor = addr; gotAt = Date.now();
        if (W().address === addr && el('pr-body')) el('pr-body').innerHTML = page(d);
      } catch (_) {
        if (!(got && gotFor === addr)) box.innerHTML = failed();
      } finally { asking = null; }
    })();
    return asking;
  }

  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('#profile-screen [data-pr]');
    if (!b) return;
    const what = b.getAttribute('data-pr');
    if (what === 'public') {
      const n = got && got.mine && got.mine.name;
      if (!n) return;
      if (typeof window.go === 'function') window.go('social');
      if (window.V2Social) window.V2Social.openPlayer(n);
    } else if (what === 'name' && window.V2Me) {
      window.V2Me.open();
    }
  });
  // Signed in or out, or a new name saved, while the tab is up: draw it again.
  window.addEventListener('duelwallet:change', () => { if (shown()) render(); });

  window.V2Profile = { render: render };
})();
