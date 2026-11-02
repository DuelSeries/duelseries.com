/* Layout 1 "Sidebar": the chrome around <main class="main">. PC: a left sidebar (tabs, Live games, the pinned
   Battle Royale, more links) and a slim header with the balance. Phone: a header with the balance and the bottom bar.
   Built only from kit.js pieces (DSUI). This file is the ONE place the chrome is drawn and wired: every tab that has a
   page in this mockup is a real link here (Shop stays Soon), the current page is marked, and pages never patch it.
   Use: L1.chrome(tab, { card }) where tab is the page id; card is passed to MeCard.mount (mecard.js) when loaded. */
(function () {
  'use strict';
  const K = window.DSKit, D = K.data, I = K.icon, esc = K.esc, U = window.DSUI;
  /* every page of layout 1 that the chrome links to (Shop has none: it stays a Soon stub) */
  const PAGE = { home: 'home.html', wallet: 'wallet.html', events: 'events.html', leaderboards: 'leaderboards.html', clips: 'clips.html',
    updates: 'updates.html', refer: 'refer.html', join: 'join.html', support: 'support.html', settings: 'settings.html' };
  /* the sidebar's More list: [page id, icon, label] (same order and words as DSUI.MORE) */
  const MORE = [['refer', 'gift', 'Refer a friend'], ['join', 'join', 'Join us'], ['support', 'help', 'Support'], ['settings', 'settings', 'Settings']];
  /* the phone bottom bar: Clips, Updates and Join us are PC only, so they are never here */
  const BB = [['home', 'Home'], ['wallet', 'Wallet'], ['events', 'Events'], ['leaderboards', 'Leaderboards'], ['settings', 'Settings']];
  /* pages that live under a tab: Customize opens from Settings */
  const UNDER = { customize: 'settings' };
  const cur = (id, on) => id === on ? ' aria-current="page"' : '';
  const link = (id, cls, on, inner) => '<a' + (cls ? ' class="' + cls + '"' : '') + ' href="' + U.href(PAGE[id]) + '" data-pg="' + id + '"' + cur(id, on) + '>' + inner + '</a>';
  const dot = why => '<i class="nav-new" aria-hidden="true"></i><span class="sr">, ' + why + '</span>';

  function chrome(tab, o) {
    o = o || {};
    const on = UNDER[tab] || tab;
    const main = document.querySelector('main');
    const app = document.createElement('div'); app.className = 'app';
    const live = U.liveGames();
    /* unseen marks: Updates has posts this player has not read (cleared on Updates itself); Clips has clips waiting
       when the owner is signed in (?owner). clips.html drops its mark once the queue is empty. */
    const marks = {};
    if (on !== 'updates') marks.updates = 'new posts';
    if (U.Q.has('owner') && U.signedIn) marks.clips = '2 to review';
    const tabs = U.NAV.map(([id, label, , chip]) => PAGE[id]
      ? link(id, 'nav-a', on, I(id, 20) + label + (marks[id] ? dot(marks[id]) : ''))
      : U.navItem([id, label, null, chip], on)).join('');
    const more = MORE.map(([id, ic, label]) => link(id, 'nav-a', on, I(ic, 20) + label)).join('');
    const sb = '<aside class="sb" aria-label="Site">' +
      '<a class="logo sb-logo" href="' + U.href('home.html') + '" data-pg="home">Duel<span>Series</span></a>' +
      '<nav class="nav" aria-label="Tabs">' + tabs + '</nav>' +
      '<div class="nav-hd">Live games<span><i class="dot"></i>' + D.online + ' online</span></div>' +
      '<div class="nav">' + live.map(g => '<button type="button" class="nav-g" data-game="' + g.id + '"><img src="' + g.img + '" alt="">' + esc(g.name) +
        '<span class="n" aria-label="' + g.players + ' playing"><i class="dot"></i>' + g.players + '</span></button>').join('') + '</div>' +
      '<div class="sb-sp"></div>' +
      '<a class="nav-br" href="' + U.href('events.html') + '" data-pg="events"><b>Battle Royale</b><span class="clock" data-brclock>02:16:42</span><small class="money">$20 to 1st</small></a>' +
      '<nav class="nav sb-more" aria-label="More">' + more + '</nav>' +
      '</aside>';
    /* the wallet page has its own Add funds and its own Sign in, so the header does not repeat them there */
    const onWallet = on === 'wallet';
    const hd = '<header class="hd"><a class="logo hd-logo" href="' + U.href('home.html') + '" data-pg="home">Duel<span>Series</span></a><span class="hd-sp"></span>' +
      U.balChip({ noAdd: onWallet, noSignin: onWallet }) + U.avatar() + '</header>';
    const bb = '<nav class="bb" aria-label="Tabs">' + BB.map(([id, label]) => link(id, '', on, I(id, 22) + label)).join('') + '</nav>';
    app.innerHTML = sb + '<div class="col">' + hd + '</div>';
    main.replaceWith(app); app.querySelector('.col').append(main);
    app.insertAdjacentHTML('afterend', bb);
    app.querySelectorAll('.hd .bal-amt').forEach(a => { a.dataset.pg = 'wallet'; });
    U.brPin();
    /* the header avatar opens the profile card on every page */
    if (window.MeCard) window.MeCard.mount(o.card || {});
  }

  /* chrome links carry the Battle Royale state the Events switcher picked (and ?signedout), read at the moment of the
     press, so every page agrees whichever tab you arrive from */
  const fresh = e => { const a = e.target.closest && e.target.closest('a[data-pg]'); if (a && PAGE[a.dataset.pg]) a.setAttribute('href', U.href(PAGE[a.dataset.pg])); };
  document.addEventListener('pointerdown', fresh, true);
  document.addEventListener('click', fresh, true);
  document.addEventListener('keydown', e => { if (e.key === 'Enter') fresh(e); }, true);

  window.L1 = { chrome, PAGE };
})();
