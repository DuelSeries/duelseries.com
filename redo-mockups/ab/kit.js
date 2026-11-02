/* DuelSeries merged kit "AB": shared behaviour for layouts 1 to 4. Load after ../../assets/data.js (window.DSKit) and
   ../chart.js (window.V2EarningsChart). Mockup only: nothing talks to a server. Everything lives on window.DSUI.
   Do not edit from a layout; layouts compose these.

   EVERY FUNCTION THE LAYOUTS SHOULD USE (all on DSUI)
   State      signedIn (false with ?signedout) ; PHONE (matchMedia, max-width 760px) ; Q (URLSearchParams) ;
              href('wallet.html') keeps ?signedout and the Battle Royale ?state= on nav links
   Feedback   toast(title, kind 'info'|'ok'|'err', msg?) ; busy(btn, ms, then) (the one loading state)
   Sheet      sheet({ title, html, foot?, wide?, bare?, cls?, focus?, onOpen(el, close), onClose }) -> { el, close } ;
              step(sameOptions) swaps the open sheet's content ; closeSheet(). Escape, backdrop and the close button all close it.
   Controls   seg(box, onChange(value, btn)) -> { set(v) }  for .seg, .seg[role=radiogroup] and .fchips ;
              rail(railEl) wires .rail arrows (and sets .rail.is-fit, arrows hidden, while the track has nothing to scroll) ;
              rails(scope) wires every .rail inside scope
   Games      gameCard(g, { cls?, lazy? }) -> card HTML ; gamesHTML(list?) all 16 in lobby order ; kindOf(g) 'rooms'|'duels'|'soon' ;
              KIND_LABEL ; counts() { all, rooms, duels, soon } ; stake(gameId) opens the Free / $0.50 / $1 sheet
              (any click on [data-game] already opens it, so cards need no wiring)
   Wins       wins(n) -> [{ name, game, amount }] from the mockup data, newest first, never the same name twice in a row,
              any one name at most twice ; winHTML(w) -> .wn button
   Chrome     NAV, MORE (sidebar lists) ; navItem(item, tab, { icon }) -> .nav-a ; balChip({ noAdd }) -> header balance or Sign in ;
              avatar() -> .me ; bottomBar(tab) -> .bb ; liveGames() games with players, busiest first
   Battle R.  brModel(state) -> copy and HTML pieces for Events (tag, clockLabel, secs, actions, why, podium, schedule, past, how) ;
              wireEvent(root, state, redraw) wires Join / Watch / Remind ; bigClock(sec, hot) -> HTML ; tickBig(root, sec, hot) -> stop() ;
              brPin() starts every [data-brclock] element on the page (it ticks by itself, "Live now" while live).
              ONE state for every page: Soon by default (as Events opens), or the Events switcher's pick, which rides
              along as ?state= in href() links. A state passed to brPin from a chrome is ignored so pages never disagree.
              brState() -> 'waiting'|'soon'|'live'|'over', for any home module that draws its own Battle Royale copy.
   Wallet     addFunds() ; withdraw() ; signedOutWallet() -> HTML ; history(box, { start: 'tx'|'earn' }) draws Transactions /
              Earnings with the chart ; earnings(box) mounts the chart alone ; txRow(t) -> .row HTML
   Global clicks (wired once here): [data-stub="Name"] toast "Name is not in this mockup" ; [data-addfunds] ; [data-withdraw] ;
              [data-signin] ; [data-game="id"] stake sheet ; [data-copy] copies the wallet address */
(function () {
  'use strict';
  const K = window.DSKit, D = K.data, I = K.icon, F = K.fmt, esc = K.esc;
  const Q = new URLSearchParams(location.search);
  const signedIn = !Q.has('signedout');
  const PHONE = matchMedia('(max-width: 760px)');
  /* the one Battle Royale state every page shows: Events opens on Soon, so Home and Wallet do too */
  const BR_STATES = ['waiting', 'soon', 'live', 'over'], BR_DEFAULT = 'soon';
  let brShared = BR_STATES.includes(Q.get('state')) ? Q.get('state') : BR_DEFAULT;
  const href = page => {
    const p = []; if (!signedIn) p.push('signedout'); if (brShared !== BR_DEFAULT) p.push('state=' + brShared);
    return page + (p.length ? '?' + p.join('&') : '');
  };
  const me = D.me;
  const money = (v) => F.usd(v, v % 1 ? 2 : 0);

  /* ---------- toast ---------- */
  let stack;
  function toast(title, kind, msg) {
    kind = kind || 'info';
    if (!stack) { stack = document.createElement('div'); stack.className = 'toasts'; stack.setAttribute('role', 'status'); stack.setAttribute('aria-live', 'polite'); document.body.append(stack); }
    const ic = kind === 'ok' ? 'check' : kind === 'err' ? 'x' : 'bell';
    const t = document.createElement('div'); t.className = 'toast toast-' + kind;
    t.innerHTML = '<div class="toast-ic">' + I(ic, 18) + '</div><div><b>' + esc(title) + '</b>' + (msg ? '<span>' + esc(msg) + '</span>' : '') + '</div>';
    stack.append(t);
    while (stack.children.length > 3) stack.firstChild.remove();
    setTimeout(() => { t.classList.add('is-out'); setTimeout(() => t.remove(), 220); }, kind === 'err' ? 4200 : 2800);
    return t;
  }

  /* ---------- busy: the one loading state ---------- */
  function busy(btn, ms, then) {
    btn.classList.add('is-loading'); btn.setAttribute('aria-busy', 'true');
    setTimeout(() => { btn.classList.remove('is-loading'); btn.removeAttribute('aria-busy'); if (then) then(); }, ms || 900);
  }

  /* ---------- sheet: one build, reused. PC centred, phone bottom sheet ---------- */
  let scrim, sh, lastFocus, onCloseFn, isOpen = false, hideTimer;
  function ensure() {
    if (scrim) return;
    scrim = document.createElement('div'); scrim.className = 'scrim'; scrim.hidden = true;
    scrim.innerHTML = '<div class="sheet" role="dialog" aria-modal="true" tabindex="-1"><div class="sheet-grab" aria-hidden="true"></div>' +
      '<div class="sheet-hd"><h2 id="sheet-t"></h2><button type="button" class="btn btn-quiet btn-icon sheet-x" aria-label="Close">' + I('x', 20) + '</button></div>' +
      '<div class="sheet-bd"></div><div class="sheet-ft"></div></div>';
    document.body.append(scrim); sh = scrim.firstChild;
    scrim.addEventListener('mousedown', e => { if (e.target === scrim) close(); });
    sh.addEventListener('click', e => { if (e.target.closest('.sheet-x') || e.target.closest('[data-close]')) close(); });
    document.addEventListener('keydown', e => {
      if (!isOpen) return;
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key === 'Tab') {
        const f = [...sh.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]')].filter(x => x.offsetParent);
        if (!f.length) return; const a = f[0], z = f[f.length - 1];
        if (e.shiftKey && (document.activeElement === a || document.activeElement === sh)) { e.preventDefault(); z.focus(); }
        else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
      }
    });
  }
  function fill(o) {
    sh.className = 'sheet' + (o.wide ? ' sheet-wide' : '') + (o.bare ? ' sheet-bare' : '') + (o.cls ? ' ' + o.cls : '');
    const h = sh.querySelector('#sheet-t');
    h.textContent = o.title || ''; h.hidden = !!o.bare || !o.title;
    if (o.bare || !o.title) { sh.removeAttribute('aria-labelledby'); sh.setAttribute('aria-label', o.title || o.label || 'Sheet'); }
    else { sh.removeAttribute('aria-label'); sh.setAttribute('aria-labelledby', 'sheet-t'); }
    const bd = sh.querySelector('.sheet-bd'), ft = sh.querySelector('.sheet-ft');
    bd.innerHTML = o.html || ''; ft.innerHTML = o.foot || ''; ft.hidden = !o.foot;
    sh.scrollTop = 0;
    if (o.onOpen) o.onOpen(sh, close);
  }
  /* land on the choice, not on Close. On a phone never focus an input first, so the keyboard does not cover the sheet. */
  function focusFirst(sel) {
    const q = s => sh.querySelector(s);
    let f = (sel && q(sel)) || q('[data-autofocus]') || q('.sheet-bd [aria-checked="true"]:not(:disabled)') || q('.sheet-bd .opt') ||
      q('.sheet-bd input:not(:disabled)') || q('.sheet-bd button:not(:disabled):not(.sheet-back)') || q('.sheet-ft button:not(:disabled)') || q('.sheet-x');
    if (f && f.tagName === 'INPUT' && PHONE.matches) f = sh;
    if (f) f.focus({ preventScroll: true });
  }
  function sheet(o) {
    ensure(); clearTimeout(hideTimer);
    if (!isOpen) lastFocus = document.activeElement;
    onCloseFn = o.onClose || null;
    fill(o);
    scrim.hidden = false; isOpen = true; document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => { scrim.classList.add('open'); focusFirst(o.focus); });
    return { el: sh, close };
  }
  function step(o) { if (!isOpen) return sheet(o); onCloseFn = o.onClose || onCloseFn; fill(o); focusFirst(o.focus); return { el: sh, close }; }
  function close() {
    if (!isOpen) return;
    isOpen = false; scrim.classList.remove('open'); document.body.style.overflow = '';
    hideTimer = setTimeout(() => { scrim.hidden = true; }, 200);
    const fn = onCloseFn; onCloseFn = null; if (fn) fn();
    if (lastFocus && lastFocus.focus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
  }

  /* ---------- segmented control: .seg (aria-pressed), .seg[role=radiogroup] (aria-checked), .fchips ---------- */
  function seg(box, onChange) {
    const btns = () => [...box.querySelectorAll('button')];
    const attr = box.getAttribute('role') === 'radiogroup' ? 'aria-checked' : 'aria-pressed';
    function pick(b, fire) {
      btns().forEach(x => { x.setAttribute(attr, String(x === b)); if (attr === 'aria-checked') x.tabIndex = x === b ? 0 : -1; });
      if (fire && onChange) onChange(b.dataset.v, b);
    }
    box.addEventListener('click', e => { const b = e.target.closest('button'); if (b && !b.disabled && box.contains(b)) pick(b, true); });
    box.addEventListener('keydown', e => {
      if (!/Arrow(Left|Right)/.test(e.key)) return;
      const live = btns().filter(b => !b.disabled), i = live.indexOf(document.activeElement); if (i < 0) return;
      const n = live[(i + (e.key === 'ArrowRight' ? 1 : -1) + live.length) % live.length]; n.focus(); pick(n, true); e.preventDefault();
    });
    const on = btns().find(b => b.getAttribute(attr) === 'true') || btns().find(b => !b.disabled); if (on) pick(on, false);
    return { set: v => { const b = btns().find(x => x.dataset.v === v); if (b) pick(b, true); } };
  }

  /* ---------- rails ---------- */
  function rail(root) {
    if (!root || root.dataset.railOn) return; root.dataset.railOn = '1';
    const track = root.querySelector('.rail-track'), prev = root.querySelector('[data-rail="prev"]'), next = root.querySelector('[data-rail="next"]');
    if (!track) return;
    /* a track that fits has nothing to scroll: hide its arrows instead of showing two dead ones */
    const upd = () => { const max = track.scrollWidth - track.clientWidth - 2; root.classList.toggle('is-fit', track.scrollWidth <= track.clientWidth + 1);
      if (prev) prev.disabled = track.scrollLeft <= 2; if (next) next.disabled = track.scrollLeft >= max; };
    const go = d => track.scrollBy({ left: d * Math.max(120, track.clientWidth * 0.86), behavior: 'smooth' });
    if (prev) prev.addEventListener('click', () => go(-1));
    if (next) next.addEventListener('click', () => go(1));
    track.addEventListener('scroll', upd, { passive: true }); addEventListener('resize', upd); upd(); setTimeout(upd, 300);
  }
  function rails(scope) { (scope || document).querySelectorAll('.rail').forEach(rail); }
  const railArrows = () => '<div class="rail-arrows"><button type="button" class="rail-btn" data-rail="prev" aria-label="Scroll back">' + I('chev', 18) + '</button>' +
    '<button type="button" class="rail-btn" data-rail="next" aria-label="Scroll on">' + I('chev', 18) + '</button></div>';

  /* ---------- games ---------- */
  const kindOf = g => g.kind === 'soon' ? 'soon' : g.kind === 'duel' ? 'duels' : 'rooms';
  const KIND_LABEL = { rooms: 'Big room', duels: '1 v 1', soon: 'Coming soon' };
  function counts() { const c = { all: D.games.length, rooms: 0, duels: 0, soon: 0 }; D.games.forEach(g => c[kindOf(g)]++); return c; }
  function gameCard(g, o) {
    o = o || {};
    const soon = g.kind === 'soon';
    const top = (g.players > 0 ? '<span class="gc-count"><i class="dot"></i>' + g.players + I('users', 13) + '</span>' : '<span></span>') +
      (g.isNew && !soon ? '<span class="chip chip-new">New</span>' : '');
    return '<button type="button" class="gcard' + (soon ? ' is-soon' : '') + (o.cls ? ' ' + o.cls : '') + '" data-game="' + g.id + '" data-kind="' + kindOf(g) + '" aria-label="' +
      esc(g.name) + (soon ? ', coming soon' : g.players ? ', ' + g.players + ' playing' : '') + (g.isNew && !soon ? ', new' : '') + '">' +
      '<img src="' + g.img + '" alt="" loading="' + (o.lazy ? 'lazy' : 'eager') + '" decoding="async">' +
      '<span class="gc-top">' + top + '</span>' + (soon ? '<span class="gc-soon chip chip-glass">Coming soon</span>' : '') + '</button>';
  }
  function gamesHTML(list, o) { return (list || D.games).map(g => gameCard(g, o)).join(''); }
  const liveGames = () => D.games.filter(g => g.players > 0 && g.kind !== 'soon').sort((a, b) => b.players - a.players);

  /* ---------- live wins: the site's own recent-wins strip (MrPeanutK), then the latest cash-outs of board names. Static amounts.
     Newest first, never the same name twice in a row, and no name more than twice, so it reads like a feed, not one player. ---------- */
  function wins(n) {
    n = n || 14;
    const byName = name => D.games.find(g => g.name === name) || D.game('snake');
    /* r: 0 for a name's newest win, 1 for its one earlier win. Every name shows once before anyone shows twice. */
    const pool = [{ name: 'MrPeanutK', game: 'snake', amount: 1.77, at: D.NOW - 4 * 6e4, r: 0 }, { name: 'MrPeanutK', game: 'knockout', amount: 0.9, at: D.NOW - 52 * 6e4, r: 1 }];
    D.board.slice(0, 10).forEach(b => D.profile(b.name).cashouts.slice(-2).reverse().forEach((c, r) => pool.push({ name: b.name, game: byName(c.game).id, amount: c.amount, at: c.at, r })));
    pool.sort((a, b) => a.r - b.r || b.at - a.at);
    const out = [], seen = {};
    while (out.length < n && pool.length) {
      const last = out.length ? out[out.length - 1].name : '';
      const i = pool.findIndex(w => w.name !== last && (seen[w.name] || 0) < 2);
      if (i < 0) break;
      const w = pool.splice(i, 1)[0]; seen[w.name] = (seen[w.name] || 0) + 1; out.push(w);
    }
    return out.map(({ name, game, amount }) => ({ name, game, amount }));
  }
  function winHTML(w) {
    const g = D.game(w.game);
    return '<button type="button" class="wn" data-game="' + g.id + '" aria-label="' + esc(w.name) + ' won ' + F.usd(w.amount) + ' in ' + esc(g.name) + '"><img src="' + g.img + '" alt=""><b>' + esc(w.name) + '</b><em>+' + F.usd(w.amount) + '</em></button>';
  }

  /* ---------- chrome pieces ---------- */
  const NAV = [['home', 'Home', 'home.html'], ['wallet', 'Wallet', 'wallet.html'], ['events', 'Events', 'events.html'], ['leaderboards', 'Leaderboards'], ['clips', 'Clips'], ['updates', 'Updates'], ['shop', 'Shop', null, 'Soon']];
  const MORE = [['gift', 'Refer a friend'], ['join', 'Join us'], ['help', 'Support'], ['settings', 'Settings']];
  function navItem(item, tab, o) {
    o = o || {}; const [id, label, page, chip] = item;
    const cur = id === tab ? ' aria-current="page"' : '';
    const inner = I(id, 20) + (o.icon ? '<span class="sr">' + label + '</span>' : label) + (chip && !o.icon ? '<span class="chip chip-soon">' + chip + '</span>' : '');
    const cls = 'nav-a' + (o.icon ? ' is-icon' : '') + (o.cls ? ' ' + o.cls : '');
    const tip = o.icon ? ' title="' + label + (chip ? ', ' + chip.toLowerCase() : '') + '"' : '';
    return page ? '<a class="' + cls + '" href="' + href(page) + '"' + cur + tip + '>' + inner + '</a>'
      : '<button type="button" class="' + cls + '" data-stub="' + label + '"' + cur + tip + '>' + inner + '</button>';
  }
  function balChip(o) {
    o = o || {};
    if (!signedIn) return o.noSignin ? '' : '<button type="button" class="btn btn-secondary" data-signin>Sign in</button>';
    return '<div class="bal"><a class="bal-amt" href="' + href('wallet.html') + '" aria-label="Balance ' + F.usd(me.balanceUsd) + ', open wallet">' + F.usd(me.balanceUsd) + '</a>' +
      (o.noAdd ? '' : '<button type="button" class="btn btn-secondary" data-addfunds aria-label="Add funds" title="Add funds">' + I('plus', 18) + '<span class="bal-add-txt">Add funds</span></button>') + '</div>';
  }
  const avatar = () => signedIn ? '<button type="button" class="me" data-stub="Your profile" aria-label="Your profile">' + esc(me.initial) + '</button>' : '';
  function bottomBar(tab) {
    const BB = [['home', 'Home', 'home.html'], ['wallet', 'Wallet', 'wallet.html'], ['events', 'Events', 'events.html'], ['leaderboards', 'Leaderboards'], ['settings', 'Settings']];
    return '<nav class="bb" aria-label="Tabs">' + BB.map(([id, l, h]) => {
      const cur = id === tab ? ' aria-current="page"' : '';
      return h ? '<a href="' + href(h) + '"' + cur + '>' + I(id, 22) + l + '</a>' : '<button type="button" data-stub="' + l + '"' + cur + '>' + I(id, 22) + l + '</button>';
    }).join('') + '</nav>';
  }

  /* ---------- the Battle Royale clock: every [data-brclock] on the page ticks together ----------
     One state across pages (brShared): a chrome's brPin('waiting') can no longer pull Home out of step with Events. */
  let brState = null, brLeft = 0, brTimer = null;
  function drawPins() {
    document.querySelectorAll('[data-brclock]').forEach(el => {
      if (brState === 'live') { el.textContent = 'Live now'; el.classList.add('win'); return; }
      const t = F.hms(brLeft); el.textContent = t.h + ':' + t.m + ':' + t.s; el.classList.remove('win');
    });
  }
  function brPin() {
    const state = brShared;
    if (state !== brState) { const b = D.br(state); brState = state; brLeft = state === 'live' ? b.endsInSec : b.nextInSec; }
    document.documentElement.dataset.br = state; drawPins();
    if (!brTimer) brTimer = setInterval(() => { brLeft = Math.max(0, brLeft - 1); drawPins(); }, 1000);
  }
  /* the Events switcher (DSKit.states) sets the shared state: the URL keeps it for a reload, and every nav link carries it */
  const navLink = /^(home|wallet|events)\.html(\?|#|$)/;
  function syncLinks() {
    document.querySelectorAll('a[href]').forEach(a => { const h = a.getAttribute('href'), m = h.match(navLink); if (m) a.setAttribute('href', href(m[1] + '.html')); });
    /* window.history: the kit's own history() (Transactions / Earnings) shadows the global here */
    try { const p = new URLSearchParams(location.search); if (brShared === BR_DEFAULT) p.delete('state'); else p.set('state', brShared);
      const qs = p.toString().replace(/=(?=&|$)/g, '');
      window.history.replaceState(window.history.state, '', (qs ? '?' + qs : location.pathname.split('/').pop()) + location.hash); } catch (_) {}
  }
  const states0 = K.states;
  K.states = function (list, onChange) {
    return states0(list, s => {
      const isBr = BR_STATES.includes(s), moved = isBr && s !== brShared;
      if (isBr) brShared = s;
      onChange(s);
      if (isBr) { brPin(); if (moved) syncLinks(); }
    });
  };

  /* ---------- the stake sheet: pick Free, $0.50 or $1 for a game ---------- */
  function stakeNote(g, v) {
    const amt = v ? money(v) : '';
    if (g.kind === 'soon') return 'Not open yet. It shows up here with a New tag the day it opens.';
    if (g.kind === 'solo') return 'Free to play with players and bots. Paid rooms are not open for this game yet.';
    if (g.kind === 'duel') return v ? 'Paid matches wait for a real player, never a bot. Your ' + amt + ' entry is taken when the match starts, and the winner gets ' + F.usd(v * 1.8) + '.'
      : 'We look for a player for 60 seconds. If nobody joins, you play a bot, and it is labelled as one.';
    return v ? 'Your ' + amt + ' is your stake in the room. Knock players out to collect what they drop, then cash out in the game to keep it.'
      : 'A free room with bots and players. Nothing to lose and nothing to collect.';
  }
  function stakeLabel(g, v) {
    if (g.kind === 'soon') return 'Not open yet';
    if (v && !signedIn) return 'Sign in to play for ' + money(v);
    return g.kind === 'duel' ? (v ? 'Find a ' + money(v) + ' match' : 'Find a free match') : (v ? 'Join a ' + money(v) + ' room' : 'Play free');
  }
  function stake(id) {
    const g = D.game(id), soon = g.kind === 'soon', paidOk = g.kind === 'arena' || g.kind === 'duel';
    const tags = (g.players > 0 ? '<span class="chip chip-live">' + g.players + ' playing</span>' : '') + (g.isNew && !soon ? '<span class="chip chip-new">New</span>' : '') + '<span class="chip">' + KIND_LABEL[kindOf(g)] + '</span>';
    const opt = (v, big, small) => '<button type="button" role="radio" data-v="' + v + '"' + ((soon || (v && !paidOk)) ? ' disabled' : '') + ' aria-checked="' + (v === 0) + '"><b' + (v ? ' class="money"' : '') + '>' + big + '</b><span>' + small + '</span></button>';
    const balLine = v => v ? (signedIn ? 'Paid from your ' + F.usd(me.balanceUsd) + ' balance.' : 'Paid rooms need you to sign in.') : 'Free rooms never touch your balance.';
    return sheet({ wide: true, bare: true, title: g.name, html:
      '<div class="ps"><img class="ps-art" src="' + g.img + '" alt="">' +
      '<div class="ps-main"><div class="ps-tags">' + tags + '</div>' +
      '<h2 class="d3">' + esc(g.name) + '</h2><p class="t-body">' + esc(g.blurb) + '</p>' +
      '<div class="seg seg-block seg-stake" role="radiogroup" aria-label="Entry">' + opt(0, 'Free', soon ? 'Soon' : 'No money') + opt(0.5, '$0.50', paidOk ? 'Entry' : 'Free only') + opt(1, '$1', paidOk ? 'Entry' : 'Free only') + '</div>' +
      '<p class="ps-note" data-note>' + stakeNote(g, 0) + '</p>' +
      '<button type="button" class="btn btn-primary btn-lg btn-block" data-go' + (soon ? ' disabled' : ' data-autofocus') + '>' + stakeLabel(g, 0) + '</button>' +
      '<div class="ps-foot"><button type="button" class="btn btn-quiet btn-sm" data-watch' + (soon ? ' disabled' : '') + '>' + I('eye', 18) + 'Watch a room</button><span class="t-meta" data-bal>' + balLine(0) + '</span></div>' +
      '</div></div>',
      onOpen(el, done) {
        let v = 0; const go = el.querySelector('[data-go]');
        seg(el.querySelector('.seg-stake'), x => { v = +x; el.querySelector('[data-note]').textContent = stakeNote(g, v); go.textContent = stakeLabel(g, v); el.querySelector('[data-bal]').textContent = balLine(v); });
        go.addEventListener('click', () => {
          if (v && !signedIn) { busy(go, 700, () => toast('Sign in opens here', 'info', 'Mockup: the real site shows the Privy sign in.')); return; }
          busy(go, 900, () => { done(); toast(g.kind === 'duel' ? 'Looking for a player' : 'Joining ' + g.name, 'info', 'Mockup: the game opens here.'); });
        });
        el.querySelector('[data-watch]').addEventListener('click', () => toast('Watching ' + g.name, 'info', 'Mockup: a room opens to watch.'));
      } });
  }

  /* ---------- Add funds (Look B's flow: pick a way, then the amount or the address) ---------- */
  function back() { return '<button type="button" class="btn btn-quiet btn-sm sheet-back" data-back>' + I('chev', 16) + 'All ways to add</button>'; }
  function addFunds() {
    if (!signedIn) { toast('Sign in to add funds', 'info', 'Mockup: the real site shows the Privy sign in.'); return; }
    const pick = {
      title: 'Add funds',
      html: '<p class="hint">Money arrives in your wallet as SOL. Your balance shows it in dollars.</p>' +
        '<button type="button" class="opt" data-o="card"><span class="opt-ic">' + I('card', 22) + '</span><span><b>Pay with card</b><small>Debit or credit card, Apple Pay or Google Pay, through MoonPay.</small></span>' + I('chev', 18) + '</button>' +
        '<button type="button" class="opt" data-o="recv"><span class="opt-ic">' + I('qr', 22) + '</span><span><b>Receive from another wallet</b><small>Send SOL to your address from any Solana wallet or exchange.</small></span>' + I('chev', 18) + '</button>' +
        '<button type="button" class="opt" data-o="phantom"><span class="opt-ic">' + I('swap', 22) + '</span><span><b>From Phantom</b><small>Connect Phantom and choose how much to move.</small></span>' + I('chev', 18) + '</button>',
      onOpen: el => el.querySelectorAll('.opt').forEach(b => b.addEventListener('click', () => addStep(b.dataset.o)))
    };
    function addStep(o) {
      if (o === 'recv') {
        step({ title: 'Receive from another wallet',
          html: back() + '<p class="hint">Send SOL on the Solana network to this address. It shows in your balance once the network confirms it, usually in under a minute.</p>' +
            '<div class="addr-box"><span class="mono">' + esc(me.wallet.replace(/(.{4})/g, '$1 ').trim()) + '</span></div>' +
            '<p class="t-meta">Only SOL on Solana. Anything else sent here is lost.</p>',
          foot: '<button type="button" class="btn btn-primary btn-lg btn-block" data-copy data-autofocus>' + I('copy', 18) + 'Copy address</button>',
          onOpen: el => el.querySelector('[data-back]').addEventListener('click', () => step(pick)) });
        return;
      }
      const card = o === 'card';
      step({ title: card ? 'Pay with card' : 'From Phantom',
        html: back() +
          '<div class="field"><label for="add-amt">Amount in dollars</label><div class="input-wrap"><span class="input-pre">$</span><input class="input input-money" id="add-amt" inputmode="decimal" autocomplete="off" placeholder="0.00"></div></div>' +
          '<div class="quick"><button type="button" class="btn btn-secondary btn-sm" data-q="10">$10</button><button type="button" class="btn btn-secondary btn-sm" data-q="20">$20</button><button type="button" class="btn btn-secondary btn-sm" data-q="50">$50</button></div>' +
          '<p class="hint">' + (card ? 'MoonPay checks your card and may charge a fee. You see the total before you pay.' : 'Phantom asks you to approve the transfer.') + '</p>',
        foot: '<button type="button" class="btn btn-primary btn-lg btn-block" data-go disabled>' + (card ? 'Continue to MoonPay' : 'Connect Phantom') + '</button>',
        focus: '#add-amt',
        onOpen: el => {
          const amt = el.querySelector('#add-amt'), go = el.querySelector('[data-go]');
          const upd = () => { go.disabled = !(parseFloat(amt.value) > 0); };
          amt.addEventListener('input', upd);
          el.querySelectorAll('[data-q]').forEach(b => b.addEventListener('click', () => { amt.value = b.dataset.q; upd(); }));
          el.querySelector('[data-back]').addEventListener('click', () => step(pick));
          go.addEventListener('click', () => busy(go, 800, () => { close(); toast(card ? 'MoonPay checkout opens here' : 'Phantom opens here', 'info', 'Mockup: the real site hands off for ' + F.usd(parseFloat(amt.value) || 0) + '.'); }));
        } });
    }
    sheet(pick);
  }

  /* ---------- Withdraw (Look B's flow: amount and address, then check and send) ---------- */
  const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  function withdraw(prefill) {
    if (!signedIn) { toast('Sign in to withdraw', 'info', 'Mockup: the real site shows the Privy sign in.'); return; }
    if (!(prefill && prefill.v != null)) prefill = null;
    const p = prefill || {};
    const form = {
      title: 'Withdraw', focus: '#wd-amt',
      html: '<div class="avail"><span>Available</span><b>' + F.usd(me.balanceUsd) + '</b></div>' +
        '<div class="field" data-f="amt"><label for="wd-amt">Amount in dollars</label><div class="input-wrap"><span class="input-pre">$</span>' +
          '<input class="input input-money" id="wd-amt" inputmode="decimal" autocomplete="off" placeholder="0.00" aria-describedby="wd-amt-m" value="' + (p.v ? p.v.toFixed(2) : '') + '">' +
          '<button type="button" class="btn btn-secondary btn-sm" data-max>Max</button></div><div class="field-msg num" id="wd-amt-m">Type an amount in dollars.</div></div>' +
        '<div class="field" data-f="to"><label for="wd-to">Send to</label><input class="input mono" id="wd-to" autocomplete="off" spellcheck="false" placeholder="Solana wallet address" aria-describedby="wd-to-m" value="' + esc(p.a || '') + '">' +
          '<div class="field-msg" id="wd-to-m">Check it twice. A send cannot be undone.</div></div>',
      foot: '<button type="button" class="btn btn-primary btn-lg btn-block" data-send disabled>Send it</button><p class="t-meta" data-why style="text-align:center">Fill in both boxes to send</p>',
      onOpen: el => {
        const a = el.querySelector('#wd-amt'), to = el.querySelector('#wd-to'), send = el.querySelector('[data-send]'), why = el.querySelector('[data-why]');
        const fa = el.querySelector('[data-f="amt"]'), ft = el.querySelector('[data-f="to"]'), ma = el.querySelector('#wd-amt-m'), mt = el.querySelector('#wd-to-m');
        function upd() {
          const v = parseFloat(a.value.replace(/[^0-9.]/g, '')), addr = to.value.trim();
          const over = v > me.balanceUsd + 1e-9, badA = a.value !== '' && !(v > 0), badT = addr !== '' && !B58.test(addr);
          fa.classList.toggle('is-err', over || badA); ft.classList.toggle('is-err', badT);
          ma.textContent = a.value === '' ? 'Type an amount in dollars.' : badA ? 'Type an amount above $0.' : over ? 'That is more than your ' + F.usd(me.balanceUsd) + ' balance.' : 'About ' + F.sol(v / me.solUsd);
          mt.textContent = badT ? 'That does not look like a Solana address.' : 'Check it twice. A send cannot be undone.';
          const ok = v > 0 && !over && addr && !badT; send.disabled = !ok;
          why.textContent = ok ? 'Next you check it before it sends' : !(v > 0) ? 'Enter an amount to send' : over ? 'Lower the amount to send' : 'Add the address to send to';
          return { v, addr };
        }
        a.addEventListener('input', upd); to.addEventListener('input', upd);
        el.querySelector('[data-max]').addEventListener('click', () => { a.value = me.balanceUsd.toFixed(2); upd(); a.focus(); });
        send.addEventListener('click', () => { const r = upd(); review(+r.v.toFixed(2), r.addr); });
        if (Q.has('fill')) { a.value = '10'; to.value = '9xQeTy7mPz2cLw4vHb8nKs3dRa6fUj1g'; }
        upd();
      }
    };
    function review(v, addr) {
      step({ title: 'Check and send',
        html: '<div class="sum"><div><span>Amount</span><b class="money">' + F.usd(v) + '</b></div><div><span>In SOL</span><b>' + F.sol(v / me.solUsd) + '</b></div>' +
          '<div><span>To</span><b class="mono">' + esc(F.short(addr)) + '</b></div><div><span>Left in your wallet</span><b>' + F.usd(me.balanceUsd - v) + '</b></div></div>' +
          '<p class="hint">Money sent to a wrong address cannot be brought back.</p>',
        foot: '<button type="button" class="btn btn-primary btn-lg btn-block" data-ok data-autofocus>Send ' + F.usd(v) + '</button><button type="button" class="btn btn-quiet btn-block" data-edit>Change something</button>',
        onOpen: el => {
          el.querySelector('[data-edit]').addEventListener('click', () => withdraw({ v, a: addr }));
          el.querySelector('[data-ok]').addEventListener('click', e => busy(e.currentTarget, 1100, () => { close(); toast('Sent ' + F.usd(v), 'ok', 'On its way to ' + F.short(addr) + '.'); }));
        } });
    }
    if (prefill) step(form); else sheet(form);
  }

  /* ---------- signed-out wallet: one clear Sign in and what the wallet is ---------- */
  function signedOutWallet() {
    return '<section class="panel out" aria-labelledby="out-t"><div>' +
      '<h2 class="t-page" id="out-t">Sign in to see your wallet</h2>' +
      '<p class="t-body">Your DuelSeries wallet holds the money you use for paid rooms. It belongs to you, and only you can move money out of it.</p>' +
      '<ul><li>' + I('check', 18) + 'Add funds with a card or from another wallet.</li><li>' + I('check', 18) + 'Every amount shows in dollars.</li><li>' + I('check', 18) + 'Withdraw to any Solana wallet whenever you like.</li></ul>' +
      '<button type="button" class="btn btn-primary btn-lg" data-signin>Sign in</button>' +
      '<p class="hint">Free rooms and the Battle Royale work without signing in.</p></div>' +
      '<div class="panel lit is-off out-bal" aria-hidden="true"><span class="t-label">Your balance</span>' +
      '<span class="out-lock"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg></span>' +
      '<b class="out-what">Signed out</b><p class="t-meta">Shows here once you sign in</p></div></section>';
  }

  /* ---------- history: Transactions and Earnings (Earnings carries the chart) ---------- */
  function txRow(t) {
    const g = t.gameId ? D.game(t.gameId) : null, inn = t.direction === 'in';
    const title = t.kind === 'entry' ? 'Played ' + t.game : t.kind === 'payout' ? 'Won on ' + t.game : t.kind === 'add' ? 'Added funds' : 'Withdrew';
    const sub = t.kind === 'entry' ? money(t.usd) + ' room' : t.kind === 'payout' ? 'Paid room' : t.kind === 'add' ? (t.how === 'Card' ? 'By card' : 'From Phantom') : 'To ' + F.short(t.peer);
    const ic = g ? '<span class="row-ic"><img src="' + g.img + '" alt=""></span>' : '<span class="row-ic ' + (inn ? 'in' : 'out') + '">' + I(t.kind === 'add' ? 'add' : 'withdraw', 18) + '</span>';
    return '<div class="row">' + ic + '<div class="row-main"><b>' + esc(title) + '</b><span>' + esc(sub) + ', ' + F.date(t.at) + ' at ' + F.time(t.at) + '</span></div>' +
      '<div class="row-end' + (inn ? ' win' : '') + '">' + (inn ? '+' : '-') + F.usd(t.usd) + '</div></div>';
  }
  function earnings(box) {
    if (!box || !window.V2EarningsChart) return;
    const games = D.myCashouts.map(c => ({ amount: c.amount, at: new Date(c.at).toISOString() }));
    const joined = new Date(D.txs[D.txs.length - 1].at - 18 * 36e5).toISOString();
    window.V2EarningsChart(box, games, joined, v => F.usd(v), D.NOW);
    if (!box.dataset.rs) {
      box.dataset.rs = '1'; let w = box.clientWidth, t;
      addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => { if (document.contains(box) && Math.abs(box.clientWidth - w) > 40) { w = box.clientWidth; window.V2EarningsChart(box, games, joined, v => F.usd(v), D.NOW); } }, 200); });
    }
  }
  function history(box, o) {
    o = o || {};
    box.innerHTML = '<div class="hist-tools"><h2 id="hist-t">History</h2><div class="seg" data-hseg aria-label="Show"><button type="button" data-v="tx" aria-pressed="' + (o.start !== 'earn') + '">Transactions</button>' +
      '<button type="button" data-v="earn" aria-pressed="' + (o.start === 'earn') + '">Earnings</button></div></div><div data-hist></div>';
    const out = box.querySelector('[data-hist]');
    let shown = 10, wins = 12;
    function drawTx() {
      out.innerHTML = '<div class="list">' + D.txs.slice(0, shown).map(txRow).join('') + '</div>' +
        (shown < D.txs.length ? '<button type="button" class="btn btn-quiet more" data-more>Show ' + Math.min(10, D.txs.length - shown) + ' more</button>' : '');
      const m = out.querySelector('[data-more]'); if (m) m.addEventListener('click', () => { shown += 10; drawTx(); });
    }
    function drawEarn() {
      const s = D.myStats, list = D.myCashouts.slice().reverse();
      if (!list.length) { out.innerHTML = '<p class="hint">No wins yet. Win a paid room and it shows up here.</p>'; return; }
      out.innerHTML = '<div class="stat-row"><div class="stat"><span>Total won</span><b class="win">' + F.usd(s.totalEarnings) + '</b></div>' +
        '<div class="stat"><span>Best win</span><b class="win">' + F.usd(s.bestCashout) + '</b></div>' +
        '<div class="stat"><span>Paid games won</span><b>' + s.winRate.won + ' of ' + s.winRate.entered + '</b></div></div>' +
        '<div class="earn-hd"><b>Running total</b><span class="t-meta">' + (matchMedia('(pointer: coarse)').matches ? 'Drag across it to read a day' : 'Hover to read a day') + '</span></div>' +
        '<div class="chart-box" data-chart></div>' +
        '<div class="earn-hd"><b>Wins</b></div><div class="list" data-wins></div>';
      const wl = out.querySelector('[data-wins]');
      const drawWins = () => { wl.innerHTML = list.slice(0, wins).map(c => { const g = D.games.find(x => x.name === c.game) || D.game('snake');
          return '<div class="row"><span class="row-ic"><img src="' + g.img + '" alt=""></span><div class="row-main"><b>Won on ' + esc(c.game) + '</b><span>' + F.date(c.at) + ' at ' + F.time(c.at) + '</span></div><div class="row-end win">+' + F.usd(c.amount) + '</div></div>'; }).join('');
        const old = out.querySelector('[data-morewins]'); if (old) old.remove();
        if (wins < list.length) { wl.insertAdjacentHTML('afterend', '<button type="button" class="btn btn-quiet more" data-morewins>Show ' + Math.min(12, list.length - wins) + ' more</button>');
          out.querySelector('[data-morewins]').addEventListener('click', () => { wins += 12; drawWins(); }); } };
      drawWins();
      earnings(out.querySelector('[data-chart]'));
    }
    seg(box.querySelector('[data-hseg]'), v => v === 'earn' ? drawEarn() : drawTx());
    if (o.start === 'earn') drawEarn(); else drawTx();
  }

  /* ---------- Battle Royale model for Events: the same copy in every layout ---------- */
  let joined = false;
  function bigClock(sec, hot) {
    const t = F.hms(sec);
    return '<div class="bigclock' + (hot ? ' is-hot' : '') + '" role="timer" aria-live="off"><div class="bc"><b data-u="h">' + t.h + '</b><span>hours</span></div><i aria-hidden="true">:</i>' +
      '<div class="bc"><b data-u="m">' + t.m + '</b><span>min</span></div><i aria-hidden="true">:</i><div class="bc"><b data-u="s">' + t.s + '</b><span>sec</span></div></div>';
  }
  let bigTimer = null;
  function tickBig(root, sec, hot) {
    clearInterval(bigTimer); let left = sec;
    const h = root.querySelector('[data-u="h"]'), m = root.querySelector('[data-u="m"]'), s = root.querySelector('[data-u="s"]'), one = root.querySelectorAll('[data-hms]');
    bigTimer = setInterval(() => {
      left = Math.max(0, left - 1); const t = F.hms(left);
      one.forEach(el => { el.textContent = t.h + ':' + t.m + ':' + t.s; });
      if (h) { h.textContent = t.h; m.textContent = t.m; if (s.textContent !== t.s) { s.textContent = t.s; if (hot) { s.classList.remove('tick'); void s.offsetWidth; s.classList.add('tick'); } } }
    }, 1000);
    return () => clearInterval(bigTimer);
  }
  function brModel(state) {
    const b = D.br(state), live = state === 'live', soon = state === 'soon', over = state === 'over', waiting = state === 'waiting';
    const nextLabel = (live || over) ? '8:00 AM ET' : '2:00 AM ET', opensAt = (live || over) ? '7:50 AM ET' : '1:50 AM ET';
    const tag = soon ? '<span class="chip chip-live is-pulse" data-pulse>Join window open</span>' : live ? '<span class="chip chip-live is-pulse" data-pulse>Live now</span>' :
      over ? '<span class="chip">Just finished</span>' : '<span class="chip">Next match ' + nextLabel + '</span>';
    let primary, secondary = '', why;
    if (soon) {
      primary = joined ? '<button type="button" class="btn btn-primary btn-xl" disabled>' + I('check', 20) + 'You are in</button>'
        : '<button type="button" class="btn btn-primary btn-xl" data-br="join">Join the Battle Royale</button>';
      why = joined ? 'Stay on this page. The match starts at <b>2:00 AM ET</b> and you go in automatically.' : '<b>' + b.humans + ' players</b> have joined so far. Joining closes when the match starts at 2:00 AM ET.';
    } else if (live) {
      primary = '<button type="button" class="btn btn-primary btn-xl" data-br="watch">' + I('eye', 20) + 'Watch live</button>';
      secondary = '<button type="button" class="btn btn-secondary btn-lg" disabled>Doors shut</button>';
      why = 'The match is running, so nobody new can join. Doors open again at <b>' + opensAt + '</b>, 10 min before the next match.';
    } else {
      primary = '<button type="button" class="btn btn-primary btn-lg" data-br="remind">' + I('bell', 18) + 'Remind me</button>';
      secondary = '<span class="opens">' + I('clock', 18) + '<span>Joining opens at <b>' + opensAt + '</b></span></span>';
      why = over ? '' : 'Joining opens 10 min before every match. Matches run every 6 hours.';
    }
    const lw = b.lastWinner;
    const soloLast = b.podiumIsLast && !over && lw.soloRun;
    const podium = [2, 1, 3].map(p => { const x = b.podium.find(y => y.place === p) || {}; const nm = x.name;
      const you = nm === me.name, bot = soloLast && p > 1;
      const prize = p === 1 ? (nm && b.podiumIsLast && !over ? '<span class="pz quiet">No prize</span>' : '<span class="pz money">' + F.usd(b.prize, 0) + '</span>') : '';
      return '<div class="pl p' + p + (nm ? '' : ' empty') + '"><div class="av">' + (nm ? esc(nm[0].toUpperCase()) : I('clock', 20)) + '</div>' +
        '<div class="nm">' + (nm ? esc(nm) : 'Still playing') + (you ? ' <span class="chip chip-new">You</span>' : '') + '</div>' +
        '<div class="sc">' + (bot ? '<span class="chip">Bot</span>' : '') + (nm && x.score ? 'Score ' + x.score.toLocaleString('en-US') : live ? 'Place ' + p : '') + '</div>' + prize + '<div class="blk">' + p + '</div></div>'; }).join('');
    const schedule = b.schedule.map((s, i) => { let c = '';
      if (i === 0 && !live && !over) c = '<span class="chip' + (soon ? ' chip-live' : '') + '">Next</span>';
      if (i === 1 && (live || over)) c = '<span class="chip">Next</span>';
      if ((live || over) && i === 0) c = live ? '<span class="chip chip-live">Live now</span>' : '<span class="chip">Finished</span>';
      return '<div class="row"><div class="row-ic">' + I('clock', 18) + '</div><div class="row-main"><b>' + s.label + '</b><span>' + F.date(s.at) + '</span></div><div class="row-end">' + c + '</div></div>'; }).join('');
    const past = b.history.slice(0, 6).map(h => { const botWon = !h.prize && !h.soloRun;
      return '<div class="row"><div class="row-ic">' + I('medal', 18) + '</div><div class="row-main"><b>' + (botWon ? 'A bot won' : esc(h.winner) + ' won') + '</b><span>' +
        F.date(h.at) + ', ' + F.time(h.at) + ', ' + h.humans + (h.humans === 1 ? ' player' : ' players') + '</span></div><div class="row-end ' + (h.prize ? 'money' : 'quiet') + '">' +
        (h.prize ? F.usd(h.prize, 0) : h.soloRun ? 'Solo, no prize' : 'No prize') + '</div></div>'; }).join('');
    const how = '<ol class="steps">' +
      '<li><b>1</b><div>Join in the last 10 minutes<span>The Join button opens 10 min before each match and shuts when it starts.</span></div></li>' +
      '<li><b>2</b><div>Stay inside the circle<span>It is Slither.io with a closing circle. Eat, grow, and cut others off.</span></div></li>' +
      '<li><b>3</b><div>Last snake alive wins ' + F.usd(b.prize, 0) + '<span>Bots fill the room. If a bot is last alive, or only one person joined, no prize is paid.</span></div></li></ol>';
    return { b, state, live, soon, over, waiting, nextLabel, opensAt, tag,
      secs: live ? b.endsInSec : b.nextInSec,
      clockLabel: soon ? 'Starts in' : live ? 'Circle closes in' : 'Next match in',
      actions: primary + secondary, primary, secondary, why,
      alive: live ? '<span class="chip">' + b.alive + ' of ' + b.players + ' left</span><span class="chip">' + b.humans + ' players, ' + (b.players - b.humans) + ' bots</span>' : '',
      winner: over ? { name: lw.name, prize: lw.prize, match: '2:00 AM' } : null,
      podium, podiumTitle: live ? 'This match' : over ? 'Result, 2:00 AM match' : 'Last match, 8:00 PM',
      podiumNote: live ? 'Places fill in as players drop out. The last snake alive wins.' : over ? 'Places go by who lasted longest. The prize went to ' + esc(lw.name) + '’s wallet.'
        : 'Only one person joined, so bots filled the room and no prize was paid. Places go by who lasted longest, not by score.',
      schedule, past, how };
  }
  function wireEvent(root, state, redraw) {
    const j = root.querySelector('[data-br="join"]'); if (j) j.addEventListener('click', () => busy(j, 900, () => { joined = true; redraw(state); toast('You are in the Battle Royale', 'ok', 'Stay on this page. It starts at 2:00 AM ET.'); }));
    const w = root.querySelector('[data-br="watch"]'); if (w) w.addEventListener('click', () => toast('Watching the Battle Royale', 'info', 'Mockup: the live match opens here.'));
    const r = root.querySelector('[data-br="remind"]'); if (r) r.addEventListener('click', () => busy(r, 600, () => toast('Reminder set', 'ok', 'We will tell you when joining opens.')));
  }
  function resetJoin() { joined = false; }

  /* ---------- global clicks ---------- */
  document.addEventListener('click', e => {
    const s = e.target.closest('[data-stub]'); if (s) { e.preventDefault(); toast(s.dataset.stub + ' is not in this mockup', 'info', 'Stage 3 builds it on this kit.'); return; }
    if (e.target.closest('[data-addfunds]')) { e.preventDefault(); addFunds(); return; }
    if (e.target.closest('[data-withdraw]')) { e.preventDefault(); withdraw(); return; }
    if (e.target.closest('[data-copy]')) { try { navigator.clipboard.writeText(me.wallet).catch(() => {}); } catch (_) {} toast('Address copied', 'ok', F.short(me.wallet)); return; }
    const si = e.target.closest('[data-signin]'); if (si) { e.preventDefault(); busy(si, 700, () => toast('Sign in opens here', 'info', 'Mockup: the real site shows the Privy sign in.')); return; }
    const g = e.target.closest('[data-game]'); if (g && !e.defaultPrevented) { e.preventDefault(); stake(g.dataset.game); }
  });
  brPin();

  window.DSUI = { signedIn, PHONE, Q, href, toast, busy, sheet, step, closeSheet: close, seg, rail, rails, railArrows,
    kindOf, KIND_LABEL, counts, gameCard, gamesHTML, liveGames, wins, winHTML, NAV, MORE, navItem, balChip, avatar, bottomBar,
    brPin, brState: () => brShared, brModel, wireEvent, resetJoin, bigClock, tickBig, stake, addFunds, withdraw, signedOutWallet, history, earnings, txRow };
})();
