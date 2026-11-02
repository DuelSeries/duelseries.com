/* Leaderboards, layout 1 "Sidebar" (mockup only, nothing talks to a server).
   Mirrors today's Social tab (public/js/v2/leaders.js, social.js, earnings.js, stats.js) on the AB kit:
   - Player winnings: what players cashed out, counted up, for Today / This week / All time (earnings.js periods).
   - The top 10 as a Money board (take-home) and a Wins board (paid rounds won), for the same three periods.
   - Search: finds anyone who has played, on the board or not, in the same row as the board (audit fix).
   - The public profile behind ?p=<name>: total earnings (counted up), win rate with how it is counted, games and
     time played, the earnings chart (../chart.js) and paid rounds by game. Back returns to the board.
   Mockup states (the switcher in the page head, or the URL): ?few (three players, small amounts: what a quiet
   week really looks like), ?empty (nobody has cashed out), ?error (the board did not load).
   Deep links: ?period=today|week|all ?board=money|wins ?p=<name> ?card (header profile card, mecard.js).
   Every figure comes from ../../assets/data.js; the ?few players are written out below, small on purpose. */
(function () {
  'use strict';
  const K = window.DSKit, D = K.data, F = K.fmt, I = K.icon, esc = K.esc, U = window.DSUI, Q = U.Q;
  const NOW = D.NOW, DAY = 864e5, HR = 36e5, MIN = 6e4;
  const SOD = (() => { const d = new Date(NOW); d.setHours(0, 0, 0, 0); return +d; })();
  const MODES = [['busy', 'Busy'], ['few', 'Few'], ['empty', 'Empty'], ['error', 'Failed']];
  const PERIODS = [['today', 'Today'], ['week', 'This week'], ['all', 'All time']];
  const PWORD = { today: 'today', week: 'this week', all: 'all time' };
  const SINCE = '2026-06-24T21:07:21Z';

  let mode = (MODES.find(m => m[0] !== 'busy' && Q.has(m[0])) || MODES[0])[0];
  let kind = Q.get('board') === 'wins' ? 'wins' : 'money';
  let period = PERIODS.some(p => p[0] === Q.get('period')) ? Q.get('period') : null;
  let query = '';
  let shownTotal = 0;

  const money = v => F.usd(v);
  const round2 = v => Math.round(v * 100) / 100;
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  const ord = n => n + (n % 100 > 10 && n % 100 < 14 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
  const gameBy = name => D.games.find(g => g.name === name) || null;
  const inP = (t, p) => p === 'all' || (p === 'today' ? t >= SOD : t > NOW - 7 * DAY);
  const hash = s => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7) >>> 0;
  function topGame(list) {
    const by = {}; list.forEach(c => { by[c.game] = (by[c.game] || 0) + c.amount; });
    return Object.keys(by).sort((a, b) => by[b] - by[a])[0] || '';
  }

  /* ---------- players ---------- */
  /* played, never cashed out: Battle Royale names (data.js br podium), and everyone in ?empty */
  function quiet(name, isMe) {
    const r = K.rng(hash(name));
    return { name, isMe: !!isMe, cashouts: [], entered: 0, won: 0, split: [], gamesPlayed: 3 + Math.floor(r() * 26),
      timeH: 1 + Math.floor(r() * 6), joined: NOW - (4 + r() * 26) * DAY };
  }
  /* paid rounds by game, shared out by where the cash-outs came from, so the split always adds up to the win rate */
  function splitFrom(cash, entered, won) {
    const by = {}; cash.forEach(c => { by[c.game] = (by[c.game] || 0) + 1; });
    const games = Object.keys(by).sort((a, b) => by[b] - by[a]), n = cash.length;
    if (!n || !entered) return [];
    const out = games.map(g => ({ game: g, entered: Math.max(1, Math.round(entered * by[g] / n)), won: Math.round(won * by[g] / n) }));
    out[0].entered += entered - out.reduce((s, x) => s + x.entered, 0);
    out[0].won += won - out.reduce((s, x) => s + x.won, 0);
    out.forEach(x => { x.won = Math.max(0, Math.min(x.won, x.entered)); });
    return out;
  }
  function fromBoard(b) {
    const p = D.profile(b.name), first = p.cashouts.length ? p.cashouts[0].at : NOW;
    return { name: p.name, cashouts: p.cashouts, entered: p.winRate.entered, won: p.winRate.won, split: splitFrom(p.cashouts, p.winRate.entered, p.winRate.won),
      gamesPlayed: p.gamesPlayed, timeH: p.timePlayedH, joined: Math.min(p.joined, first - 2 * DAY) };
  }
  /* you: the wallet's own cash-outs and paid rounds (data.js myCashouts, txs, myStats), so Wallet and profile agree */
  function meFull() {
    const per = {};
    D.txs.forEach(t => { if (!t.game) return; const g = per[t.game] || (per[t.game] = { game: t.game, entered: 0, won: 0 });
      if (t.kind === 'entry') g.entered++; if (t.kind === 'payout') g.won++; });
    const split = Object.values(per).map(g => ({ game: g.game, entered: Math.max(g.entered, 1), won: Math.min(g.won, g.entered) }));
    const won = D.myStats.winRate.won;
    for (let s = split.reduce((a, g) => a + g.won, 0); s > won; s--) split.sort((a, b) => b.won - a.won)[0].won--;
    split.sort((a, b) => b.entered - a.entered);
    return { name: D.me.name, isMe: true, cashouts: D.myCashouts.slice(), entered: D.myStats.winRate.entered, won,
      split, gamesPlayed: D.myStats.entered + 28, timeH: 9, joined: D.txs[D.txs.length - 1].at - 18 * HR };
  }
  /* MrPeanutK is the site's own Live wins strip ($1.77 on Slither.io, $0.90 on Knockout) */
  const peanut = () => ({ name: 'MrPeanutK', cashouts: [{ amount: 0.9, at: NOW - 52 * MIN, game: 'Knockout' }, { amount: 1.77, at: NOW - 4 * MIN, game: 'Slither.io' }],
    entered: 6, won: 2, split: [{ game: 'Slither.io', entered: 4, won: 1 }, { game: 'Knockout', entered: 2, won: 1 }], gamesPlayed: 23, timeH: 4, joined: NOW - 12 * DAY });
  const BR_NAMES = ['happy', 'PIXEL_PONY', 'Tyrone'];
  let POOL = null;
  function pool() {
    if (POOL) return POOL;
    if (mode === 'few') POOL = [peanut(),
      { name: 'Kestrel', cashouts: [{ amount: 2.7, at: NOW - 3 * DAY - 5 * HR, game: 'Agar.io' }], entered: 4, won: 1,
        split: [{ game: 'Agar.io', entered: 3, won: 1 }, { game: 'Slither.io', entered: 1, won: 0 }], gamesPlayed: 19, timeH: 5, joined: NOW - 20 * DAY },
      { name: 'zinc', cashouts: [{ amount: 1.35, at: NOW - 9 * DAY - 2 * HR, game: 'Paper.io' }], entered: 2, won: 1,
        split: [{ game: 'Paper.io', entered: 2, won: 1 }], gamesPlayed: 11, timeH: 2, joined: NOW - 16 * DAY },
      quiet(D.me.name, true)].concat(BR_NAMES.map(n => quiet(n)));
    else if (mode === 'empty') POOL = [quiet(D.me.name, true), quiet('MrPeanutK')].concat(BR_NAMES.map(n => quiet(n)));
    else POOL = D.board.map(fromBoard).concat([peanut(), meFull()], BR_NAMES.map(n => quiet(n)));
    return POOL;
  }
  const find = name => pool().find(p => p.name.toLowerCase() === String(name).toLowerCase());

  /* ---------- boards: take-home and paid wins per period, top 10, the live rule (no ties, biggest first) ---------- */
  function standings(k, per) {
    return pool().map(pl => {
      const c = pl.cashouts.filter(x => inP(x.at, per));
      if (!c.length) return null;
      const amount = round2(c.reduce((s, x) => s + x.amount, 0));
      const wins = per === 'all' ? pl.won : Math.min(c.length, Math.round(c.length * pl.won / pl.cashouts.length));
      return { pl, name: pl.name, amount, n: c.length, wins, game: topGame(c) };
    }).filter(r => r && (k === 'money' || r.wins > 0))
      .sort(k === 'money' ? (a, b) => b.amount - a.amount || b.n - a.n || (a.name < b.name ? -1 : 1)
        : (a, b) => b.wins - a.wins || b.amount - a.amount || (a.name < b.name ? -1 : 1))
      .slice(0, 10).map((r, i) => Object.assign(r, { rank: i + 1 }));
  }
  function totals(per) {
    let t = 0, n = 0;
    pool().forEach(pl => pl.cashouts.forEach(c => { if (inP(c.at, per)) { t += c.amount; n++; } }));
    return { total: round2(t), n };
  }
  /* like earnings.js firstTab: open on the first period that has anyone in it */
  const firstPeriod = () => (PERIODS.find(([p]) => standings(kind, p).length) || PERIODS[2])[0];
  const rankOf = name => { const r = standings('money', 'all').find(x => x.name === name); return r ? r.rank : null; };

  /* ---------- urls: keep the mockup state and ?signedout on every link ---------- */
  function url(o) {
    o = o || {};
    const q = [];
    if (!U.signedIn) q.push('signedout');
    if (Q.get('state')) q.push('state=' + encodeURIComponent(Q.get('state')));
    if (mode !== 'busy') q.push(mode);
    if (o.p) q.push('p=' + encodeURIComponent(o.p));
    return 'leaderboards.html' + (q.length ? '?' + q.join('&') : '');
  }

  /* ---------- chrome: layout 1's sidebar, header and bottom bar (layout.js) ---------- */
  L1.chrome('leaderboards', { card: { profileHref: url({ p: D.me.name }) } });

  const hd = document.getElementById('lb-hd'), view = document.getElementById('view');
  const h1 = hd.querySelector('h1');

  /* the mockup-only switcher (kit .ds-states): a review tool, never product UI */
  const sw = document.createElement('div');
  sw.className = 'ds-states is-static lb-sw'; sw.setAttribute('role', 'group'); sw.setAttribute('aria-label', 'Mockup state');
  function drawSw() { sw.innerHTML = MODES.map(([id, l]) => '<button type="button" data-mode="' + id + '"' + (id === mode ? ' class="on" aria-pressed="true"' : ' aria-pressed="false"') + '>' + l + '</button>').join(''); }
  sw.addEventListener('click', e => {
    const b = e.target.closest('[data-mode]'); if (!b || b.dataset.mode === mode) return;
    mode = b.dataset.mode; POOL = null; period = null; shownTotal = 0; drawSw();
    const p = new URLSearchParams(location.search).get('p');
    try { history.replaceState(history.state, '', url({ p })); } catch (_) {}
    render();
  });
  drawSw(); hd.append(sw);

  const liveChip = '<span class="chip chip-live" title="Updates every minute">Live</span>';
  const searchIc = '<span class="input-pre" aria-hidden="true">' + I('search', 18) + '</span>';

  /* ---------- the board ---------- */
  function boardView() {
    document.title = 'Leaderboards | DuelSeries';
    hd.classList.remove('is-pf');
    if (!hd.contains(h1)) { hd.querySelector('.pf-back') && hd.querySelector('.pf-back').remove(); hd.prepend(h1); }
    if (!period) period = firstPeriod();
    const err = mode === 'error';
    view.innerHTML = '<div class="lb"><div class="lb-main">' +
      '<section class="panel lb-sum" aria-labelledby="sum-t"' + (err ? ' hidden' : '') + '>' +
        '<div class="lb-sum-hd"><h2 class="lb-sum-t" id="sum-t">Player winnings</h2>' + liveChip + '<span class="t-meta lb-upd">Updates every minute</span></div>' +
        '<div class="seg lb-per" id="per" aria-label="Period">' + PERIODS.map(([id, l]) => '<button type="button" data-v="' + id + '" aria-pressed="' + (id === period) + '">' + l + '</button>').join('') + '</div>' +
        '<div class="lb-fig"><b class="d2 money" id="fig">' + money(shownTotal) + '</b><p class="lb-figsub" id="figsub"></p></div></section>' +
      '<section class="lb-board" aria-labelledby="top-t"><div class="sec-hd"><h2 id="top-t">Top 10</h2>' +
        (err ? '' : '<div class="seg" id="kind" aria-label="Board"><button type="button" data-v="money" aria-pressed="' + (kind === 'money') + '">Money</button>' +
        '<button type="button" data-v="wins" aria-pressed="' + (kind === 'wins') + '">Wins</button></div>') + '</div><div id="board"></div></section>' +
      '</div><div class="lb-side">' +
      '<section class="panel lb-find" aria-labelledby="find-t"><h2 class="lb-side-t" id="find-t">Find a player</h2>' +
        '<div class="input-wrap">' + searchIc + '<input class="input" id="q" type="search" placeholder="Search by name" maxlength="24" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" aria-label="Search players by name" aria-controls="res"></div>' +
        '<div class="lb-res" id="res" aria-live="polite"></div></section>' +
      '<section class="panel lb-how" aria-labelledby="how-t"><h2 class="lb-side-t" id="how-t">How the board works</h2><ul>' +
        '<li><b>Money</b> is what landed in players\' wallets from paid rooms, after the 10% cut.</li>' +
        '<li><b>Wins</b> are paid rounds cashed out for more than the entry. Free games do not count.</li>' +
        '<li>The board updates every minute. Search finds anyone who has played, on the board or not.</li></ul></section>' +
      '</div></div>';
    U.seg(document.getElementById('per'), v => { period = v; drawBoard(true); });
    if (!err) U.seg(document.getElementById('kind'), v => { kind = v; drawBoard(true); });
    const q = document.getElementById('q');
    q.value = query;
    let t;
    q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { query = q.value; drawResults(); }, 150); });
    drawBoard(true);
    drawResults();
  }

  function drawBoard(animate) {
    const box = document.getElementById('board'); if (!box) return;
    if (mode === 'error') {
      box.innerHTML = '<div class="panel lb-none"><b>Could not load the board.</b><p class="hint">It tries again every minute. Search and player profiles still work.</p>' +
        '<button type="button" class="btn btn-secondary btn-sm" data-retry>Try again now</button></div>';
      box.querySelector('[data-retry]').addEventListener('click', e => U.busy(e.currentTarget, 900, () => U.toast('Still not loading', 'err', 'The board tries again by itself every minute.')));
      return;
    }
    const rows = standings(kind, period), tot = totals(period);
    document.getElementById('top-t').textContent = 'Top 10 ' + PWORD[period];
    /* the total: counts up from what was showing, so a period switch reads as the figure moving */
    const fig = document.getElementById('fig'), sub = document.getElementById('figsub');
    if (animate && tot.total !== shownTotal) K.countUp(fig, tot.total, { from: shownTotal }); else fig.textContent = money(tot.total);
    shownTotal = tot.total;
    sub.textContent = tot.n ? 'won by players ' + PWORD[period] + ', across ' + plural(tot.n, 'cash-out') + '.'
      : period === 'all' ? 'Nothing paid out to players yet. This counts real players\' cash-outs from paid rooms.'
      : 'Nothing paid out to players ' + PWORD[period] + ' yet.';

    let html = '<div class="lb-pod">' + [0, 1, 2].map(i => rows[i] ? tile(rows[i], i) : emptyTile(i, rows.length)).join('') + '</div>';
    if (rows.length > 3) html += '<div class="panel panel-tight lb-rest"><div class="list">' + rows.slice(3).map(row).join('') + '</div></div>';
    if (!rows.length) {
      const next = PERIODS.find(([p]) => p !== period && PERIODS.findIndex(x => x[0] === p) > PERIODS.findIndex(x => x[0] === period) && standings(kind, p).length);
      const what = kind === 'money' ? 'Nobody has cashed out ' : 'No paid wins ';
      html += '<div class="lb-foot"><p>' + (period === 'all' ? (kind === 'money' ? 'Nobody has cashed out yet. Players show up here once they cash out from a paid room.' : 'No paid wins yet.')
        : what + PWORD[period] + ' yet.') + '</p>' +
        (next ? '<button type="button" class="btn btn-secondary btn-sm" data-per="' + next[0] + '">See ' + next[1].toLowerCase() + '</button>' : '') + '</div>';
    } else if (rows.length < 10) {
      html += '<p class="lb-foot">That is everyone who ' + (kind === 'money' ? 'cashed out' : 'won a paid round') + ' ' + PWORD[period] + '.</p>';
    }
    box.innerHTML = html;
    const jump = box.querySelector('[data-per]');
    if (jump) jump.addEventListener('click', () => { const s = document.querySelector('#per [data-v="' + jump.dataset.per + '"]'); if (s) s.click(); });
    if (kind === 'money') box.querySelectorAll('[data-cu]').forEach(el => K.countUp(el, +el.dataset.cu));
  }

  const you = pl => pl && pl.isMe ? ' <span class="chip lb-you">You</span>' : '';
  function tile(r, i) {
    const g = gameBy(r.game), place = ord(i + 1);
    const fig = kind === 'money' ? '<span class="lb-t-v money" data-cu="' + r.amount + '">$0.00</span>'
      : '<span class="lb-t-v">' + r.wins + '<small>' + (r.wins === 1 ? 'win' : 'wins') + '</small></span>';
    const sub = kind === 'money' ? r.game + ', ' + plural(r.n, 'cash-out') : money(r.amount) + ' won, mostly ' + r.game;
    const label = place + ', ' + r.name + ', ' + (kind === 'money' ? money(r.amount) : plural(r.wins, 'win')) + '. Open profile';
    return '<button type="button" class="panel lb-t is-' + (i + 1) + '" data-p="' + esc(r.name) + '" aria-label="' + esc(label) + '">' +
      (g ? '<img class="lb-t-art" src="' + g.img + '" alt="">' : '') +
      '<span class="lb-t-rk">' + place + '</span><b class="lb-t-nm"><span>' + esc(r.name) + '</span>' + you(r.pl) + '</b>' + fig +
      '<span class="lb-t-sub">' + esc(sub) + '</span></button>';
  }
  function emptyTile(i, have) {
    return '<div class="panel lb-t is-' + (i + 1) + ' is-empty"><span class="lb-t-rk">' + ord(i + 1) + '</span>' +
      '<b class="lb-t-nm">' + (have ? 'Nobody else yet' : 'Nobody yet') + '</b><span class="lb-t-sub">' +
      (period === 'all' ? (kind === 'money' ? 'No cash-outs yet' : 'No paid wins yet') : 'None ' + PWORD[period]) + '</span></div>';
  }
  function row(r) {
    const g = gameBy(r.game);
    const sub = kind === 'money' ? r.game + ', ' + plural(r.n, 'cash-out') : money(r.amount) + ' won, mostly ' + r.game;
    const end = kind === 'money' ? '<div class="row-end money">' + money(r.amount) + '</div>'
      : '<div class="row-end">' + r.wins + '<small>' + (r.wins === 1 ? 'win' : 'wins') + '</small></div>';
    return '<button type="button" class="row lb-row" data-p="' + esc(r.name) + '"><span class="lb-rk">' + r.rank + '</span>' +
      '<span class="row-ic">' + (g ? '<img src="' + g.img + '" alt="">' : I('users', 18)) + '</span>' +
      '<div class="row-main"><b>' + esc(r.name) + you(r.pl) + '</b><span>' + esc(sub) + '</span></div>' + end + '</button>';
  }

  /* ---------- search: names that start with it first, anywhere in the name after, 8 at most ---------- */
  function drawResults() {
    const box = document.getElementById('res'); if (!box) return;
    const q = query.trim().slice(0, 24).toLowerCase();
    if (!q) { box.innerHTML = '<p class="hint">Finds anyone who has played, on the board or not.</p>'; return; }
    const total = pl => pl.cashouts.reduce((s, c) => s + c.amount, 0);
    const hits = pool().filter(pl => pl.name.toLowerCase().includes(q))
      .sort((a, b) => b.name.toLowerCase().startsWith(q) - a.name.toLowerCase().startsWith(q) || total(b) - total(a)).slice(0, 8);
    if (!hits.length) { box.innerHTML = '<p class="hint lb-miss">No player by that name.</p>'; return; }
    box.innerHTML = '<div class="list">' + hits.map(pl => {
      const n = pl.cashouts.length, rk = n ? rankOf(pl.name) : null, g = n ? gameBy(topGame(pl.cashouts)) : null;
      const sub = n ? (rk ? ord(rk) + ' all time, ' : '') + plural(n, 'cash-out') : 'No cash-outs yet';
      return '<button type="button" class="row" data-p="' + esc(pl.name) + '"><span class="row-ic">' + (g ? '<img src="' + g.img + '" alt="">' : I('users', 18)) + '</span>' +
        '<div class="row-main"><b>' + esc(pl.name) + you(pl) + '</b><span>' + esc(sub) + '</span></div>' +
        (n ? '<div class="row-end money">' + money(round2(total(pl))) + '</div>' : '<div class="row-end lb-chev">' + I('chev', 18) + '</div>') + '</button>';
    }).join('') + '</div>';
  }

  /* ---------- the public profile (?p=<name>) ---------- */
  function playTime(h) { return h < 1 ? Math.max(1, Math.round(h * 60)) + 'm' : h < 48 ? Math.round(h) + 'h' : Math.round(h / 24) + 'd'; }
  function profileView(name) {
    hd.classList.add('is-pf');
    if (hd.contains(h1)) h1.remove();
    if (!hd.querySelector('.pf-back')) hd.insertAdjacentHTML('afterbegin', '<a class="btn btn-quiet pf-back" href="' + url() + '" data-back>' + I('chev', 18) + 'Leaderboards</a>');
    else hd.querySelector('.pf-back').href = url();
    const pl = find(name);
    if (!pl) {
      document.title = 'Player not found | DuelSeries';
      view.innerHTML = '<section class="panel pf-gone"><h1 class="t-page">No player called ' + esc(name) + '</h1>' +
        '<p class="t-body">Check the spelling, or search for them from the board.</p><a class="btn btn-primary" href="' + url() + '" data-back>Back to Leaderboards</a></section>';
      return;
    }
    document.title = pl.name + ' | DuelSeries';
    const c = pl.cashouts, total = round2(c.reduce((s, x) => s + x.amount, 0)), tg = c.length ? topGame(c) : '', g = tg ? gameBy(tg) : null;
    const rk = c.length ? rankOf(pl.name) : null;
    const line = [rk ? ord(rk) + ' on the all-time money board.' : '', tg ? 'Plays ' + tg + ' most.' : '', 'Joined ' + F.date(pl.joined) + '.'].filter(Boolean).join(' ');
    const has = pl.entered > 0, pct = has ? Math.round(100 * pl.won / pl.entered) : 0;
    const split = (pl.split || []).filter(s => s.entered > 0);

    view.innerHTML = '<div class="pf">' +
      '<section class="panel pf-hd" aria-labelledby="pf-n">' + (g ? '<img class="pf-art" src="' + g.img + '" alt="">' : '') +
        '<div class="pf-id"><h1 class="t-page" id="pf-n"><span>' + esc(pl.name) + '</span>' + you(pl) + '</h1><p class="pf-line">' + esc(line) + '</p>' +
          (pl.isMe ? '<p class="pf-mine">This is what other players see. Change your name from your profile card in the header.</p>' : '') + '</div>' +
        '<div class="pf-tot"><span class="t-label">Total earnings</span><b class="d2 money" id="pf-tot">$0.00</b>' +
          '<span class="t-meta">' + (c.length ? plural(c.length, 'cash-out') + ', after the 10% cut' : 'No cash-outs yet') + '</span></div></section>' +
      '<div class="stat-row pf-stats">' +
        '<div class="stat"><span>Win rate</span>' + (has ? '<b>' + pct + '%</b><small>' + pl.won + ' of ' + plural(pl.entered, 'paid round') + '</small>' : '<b class="pf-nil">No paid rounds</b><small>Free games are not counted</small>') + '</div>' +
        '<div class="stat"><span>Games played</span><b>' + pl.gamesPlayed + '</b><small>Free and paid</small></div>' +
        '<div class="stat"><span>Time played</span><b>' + playTime(pl.timeH) + '</b><small>In every game</small></div></div>' +
      '<div class="pf-grid">' +
        '<section class="panel pf-earn" aria-labelledby="pf-et"><div class="panel-head"><h2 id="pf-et">Earnings</h2>' + (c.length ? '<span class="t-meta">' + (matchMedia('(pointer: coarse)').matches ? 'Drag across it to read a day' : 'Hover to read a day') + '</span>' : '') + '</div>' +
          (c.length ? '<div class="chart-box" id="pf-chart"></div>' : '<div class="pf-empty"><b>No cash-outs yet</b><p class="hint">The line starts at the first cash-out from a paid room.</p></div>') + '</section>' +
        '<section class="panel pf-wr" aria-labelledby="pf-wt"><div class="panel-head"><h2 id="pf-wt">Paid rounds</h2></div>' +
          (split.length ? '<div class="list">' + split.map(s => { const sg = gameBy(s.game);
            return '<div class="row"><span class="row-ic">' + (sg ? '<img src="' + sg.img + '" alt="">' : I('users', 18)) + '</span><div class="row-main"><b>' + esc(s.game) + '</b><span>Won ' + s.won + ' of ' + s.entered + '</span></div>' +
              '<div class="row-end">' + Math.round(100 * s.won / s.entered) + '%</div></div>'; }).join('') + '</div>'
            : '<p class="hint pf-nowr">No paid rounds yet. Free games are not counted.</p>') +
          '<button type="button" class="btn btn-quiet btn-sm pf-how" data-wrhow>' + I('help', 16) + 'How a win is counted</button></section>' +
      '</div></div>';

    K.countUp(document.getElementById('pf-tot'), total);
    const box = document.getElementById('pf-chart');
    if (box) drawChart(box, pl);
  }
  let chartFor = null;
  function drawChart(box, pl) {
    chartFor = { box, pl, w: box.clientWidth };
    window.V2EarningsChart(box, pl.cashouts.map(x => ({ amount: x.amount, at: new Date(x.at).toISOString() })), new Date(pl.joined).toISOString(), v => F.usd(v), NOW);
  }
  let rs;
  addEventListener('resize', () => { clearTimeout(rs); rs = setTimeout(() => {
    if (chartFor && document.contains(chartFor.box) && Math.abs(chartFor.box.clientWidth - chartFor.w) > 40) drawChart(chartFor.box, chartFor.pl); }, 200); });

  function howSheet(pl) {
    const t = Date.parse(SINCE);
    U.sheet({ title: 'How a win is counted', cls: 'pf-sheet',
      html: '<p class="t-body">A paid round is a win when the player cashes out with more than they paid to enter. Dying, or cashing out for less, is a round played but not won.</p>' +
        '<p class="t-body">Free games and free rooms are not counted. Counted since ' + new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + '.</p>' +
        (pl && pl.entered ? '<div class="sum"><div><span>' + esc(pl.name) + '</span><b>' + pl.won + ' of ' + plural(pl.entered, 'paid round') + '</b></div></div>' : ''),
      foot: '<button type="button" class="btn btn-primary btn-block" data-got>Got it</button>',
      focus: '[data-got]',
      onOpen: (el, close) => { el.querySelector('[data-got]').addEventListener('click', close); } });
  }

  /* ---------- routing: ?p= is the profile, Back returns to the board ---------- */
  function render() {
    const p = new URLSearchParams(location.search).get('p');
    chartFor = null;
    if (p) profileView(p); else boardView();
  }
  function openProfile(name) {
    try { history.pushState({ lb: 1 }, '', url({ p: name })); } catch (_) {}
    render(); scrollTo(0, 0);
  }
  document.addEventListener('click', e => {
    const t = e.target.closest('[data-p]');
    if (t) { e.preventDefault(); openProfile(t.dataset.p); return; }
    const b = e.target.closest('[data-back]');
    if (b) {
      e.preventDefault();
      if (history.state && history.state.lb) history.back();
      else { try { history.replaceState(null, '', url()); } catch (_) {} render(); scrollTo(0, 0); }
      return;
    }
    if (e.target.closest('[data-wrhow]')) howSheet(find(new URLSearchParams(location.search).get('p') || ''));
  });
  addEventListener('popstate', () => { render(); });

  render();
  if (Q.has('how') && Q.get('p')) howSheet(find(Q.get('p')));
  if (Q.has('q') && document.getElementById('q')) { query = Q.get('q'); document.getElementById('q').value = query; drawResults(); }
  if (Q.has('card') && window.MeCard) window.MeCard.open();
})();
