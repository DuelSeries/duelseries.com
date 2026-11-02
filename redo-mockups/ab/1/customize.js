/* Customize, layout 1: the per-game look chooser (today: the #lookveil reel in public/v2.html, lookList, hasLook,
   look.js and shopArt.js). Mockup only: nothing is bought, stored or sent.
   - ?game=<id> picks the game (default Slither.io). Coming-soon games have no Customize; Awesome Tanks and Bowmasters
     sell nothing (shared/lockedGames.js), so they show their one look.
   - The stage draws the look you picked with SkinsKit (the lobby's own preview code). Free looks come first, in one
     sideways rail, so Slither's 54 never push the 8 paid ones off the page; paid looks sit in a grid under it.
   - Yours: an owned paid look. A locked one shows its price, and "Buy for $N" opens the kit sheet (same steps as
     today's unlock sheet: price, confirm in the wallet, done, "Skins are final").
   - Mockup states: owns some (default), ?empty (owns none), ?signedout. */
(function () {
  'use strict';
  const K = DSKit, D = K.data, F = K.fmt, I = K.icon, esc = K.esc, U = DSUI, SK = window.SkinsKit, me = D.me;
  L1.chrome('customize');   /* layout.js: the chrome, Settings marked (Customize opens from Settings), and the profile card */

  const view = document.getElementById('view'), hd = document.getElementById('lk-hd');
  const withQ = (page, extra) => { const h = U.href(page); return h + (h.indexOf('?') < 0 ? '?' : '&') + extra; };
  const LOCK = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2.2"/><path d="M8.5 11V8a3.5 3.5 0 0 1 7 0v3"/></svg>';

  if (!SK) {
    hd.innerHTML = '<h1 class="t-page">Customize</h1>';
    view.innerHTML = '<section class="panel lk-lone"><p class="t-body">The previews did not load. Reload the page to try again.</p></section>';
    return;
  }

  /* every game with something to choose, in the lobby's order */
  const locked = id => !!(window.DS_LOCKED && window.DS_LOCKED.isLocked(id));
  const GAMES = D.games.filter(g => g.kind !== 'soon').map(g => {
    const all = SK.list(g.id);
    return { g, free: all.filter(e => !e.paid), paid: locked(g.id) ? [] : all.filter(e => e.paid) };
  }).filter(x => x.free.length + x.paid.length > 0);

  /* what this player owns and wears (mockup) */
  const OWNED = { snake: ['candycane', 'ember'], chomp: ['neon'], agar: ['moon'] };
  const WORN = { snake: 'ember', chomp: 'neon', agar: 'lime', pool8: 'green', headsoccer: 'afro', crossy: 'frog' };
  let mode = !U.signedIn ? 'out' : U.Q.has('empty') ? 'none' : 'some';
  let owned = {}, worn = {};
  function seed() {
    owned = {}; worn = {};
    if (mode === 'some') { Object.keys(OWNED).forEach(k => { owned[k] = OWNED[k].slice(); }); Object.assign(worn, WORN); }
  }
  seed();
  const owns = e => !e.paid || (owned[e.game] || []).indexOf(e.id) >= 0;
  const wornId = G => { const w = worn[G.g.id], e = w && SK.find(G.g.id, w); return e && owns(e) ? w : G.free[0].id; };
  const isCar = G => G.g.id === 'swim';

  let G = null, sel = null, stage = null, mounts = [];

  function status(e, onStage) {
    if (e.id === wornId(G)) return { chip: '<span class="chip">' + I('check', 14) + (isCar(G) ? 'Your car' : 'Wearing') + '</span>', txt: isCar(G) ? 'your car' : 'wearing' };
    if (e.paid && owns(e)) return { chip: '<span class="chip">Yours</span>', txt: 'yours' };
    if (e.paid) return { chip: '<span class="chip chip-money">' + LOCK + esc(e.priceText) + '</span>', txt: e.priceText + ', not yours yet' };
    return { chip: onStage ? '<span class="chip">Free</span>' : 'Free', txt: 'free' };
  }
  const tile = e => '<button type="button" class="lk" data-id="' + esc(e.id) + '" aria-pressed="false"><span class="lk-art"></span>' +
    '<span class="lk-meta"><b>' + esc(e.name) + '</b><span class="lk-st"></span></span></button>';

  function drawHead() {
    hd.innerHTML = '<div class="lk-hd-t"><a class="btn btn-quiet btn-sm lk-back" href="' + withQ('home.html', 'game=' + G.g.id) + '" aria-label="Back to ' + esc(G.g.name) + '">' +
      I('chev', 18) + '<span>Back</span></a><h1 class="t-page">Customize</h1></div>' +
      '<button type="button" class="btn btn-secondary lk-pick" id="lk-pick" aria-label="' + esc(G.g.name) + '. Choose another game"><img src="' + G.g.img + '" alt="">' +
      '<span>' + esc(G.g.name) + '</span>' + I('chev', 18) + '</button>';
    document.getElementById('lk-pick').addEventListener('click', pickGame);
  }

  function open(id) {
    mounts.forEach(m => m.destroy()); mounts = [];
    if (stage) { stage.destroy(); stage = null; }
    G = GAMES.find(x => x.g.id === id) || GAMES.find(x => x.g.id === 'snake') || GAMES[0];
    sel = wornId(G);
    drawHead();
    const car = isCar(G), lone = G.free.length + G.paid.length === 1;
    const freeSec = lone
      ? '<section class="panel lk-lone"><p class="t-body">This is the only look for ' + esc(G.g.name) + ' for now. New looks show up here when they are added.</p></section>'
      : '<section class="rail lk-sec lk-free" aria-labelledby="free-t"><div class="rail-hd"><h2 id="free-t">' + (car ? 'Cars' : 'Free looks') + '<small>' + G.free.length + '</small></h2>' +
        U.railArrows() + '</div><div class="rail-track">' + G.free.map(tile).join('') + '</div></section>';
    const paidSec = G.paid.length
      ? '<section class="lk-sec lk-paid" aria-labelledby="paid-t"><div class="sec-hd"><div><h2 id="paid-t">Paid looks<small>' + G.paid.length + '</small></h2>' +
        '<p class="t-meta">Looks only. A look never changes how the game plays.</p></div><span class="lk-own" id="lk-own"></span></div>' +
        '<div class="lk-grid">' + G.paid.map(tile).join('') + '</div></section>'
      : lone ? '' : '<p class="lk-note">' + (car ? 'Every car' : 'Every look') + ' for ' + esc(G.g.name) + ' is free. Nothing here is sold.</p>';
    view.innerHTML = '<div class="lk-stick"><section class="panel lk-stage" aria-label="Try it on"><div class="lk-art-stage" id="stage"></div>' +
      '<div class="lk-band"><div class="lk-band-txt"><h2 class="lk-name" id="lk-name"></h2><div class="lk-tags" id="lk-tags"></div></div>' +
      '<div class="lk-act" id="lk-act"></div></div></section></div>' + freeSec + paidSec;

    stage = SK.mount(document.getElementById('stage'), G.g.id, sel, { big: true, bare: true });
    view.querySelectorAll('.lk').forEach(b => {
      mounts.push(SK.mount(b.querySelector('.lk-art'), G.g.id, b.dataset.id, { bare: true, animate: false }));
      b.addEventListener('click', () => pick(b.dataset.id));
    });
    const rail = view.querySelector('.rail'); if (rail) U.rail(rail);
    paint();
    /* the look you wear may sit far along the free rail: bring it into view */
    const on = view.querySelector('.lk-free .lk[aria-pressed="true"]');
    if (on) { const tr = on.parentElement, d = on.getBoundingClientRect().left - tr.getBoundingClientRect().left; if (d > tr.clientWidth - on.clientWidth) tr.scrollLeft = d - 16; }
  }

  function paint() {
    const e = SK.find(G.g.id, sel), w = wornId(G), car = isCar(G);
    document.getElementById('lk-name').textContent = e.name;
    document.getElementById('lk-tags').innerHTML = status(e, true).chip + '<span class="t-meta">' + esc(G.g.name) + '</span>';
    const act = document.getElementById('lk-act');
    if (e.id === w) act.innerHTML = '';
    else if (owns(e)) act.innerHTML = '<button type="button" class="btn btn-primary" data-wear>' + (car ? 'Use this car' : 'Wear this look') + '</button>';
    else act.innerHTML = '<button type="button" class="btn btn-secondary" data-buy>' + LOCK + 'Buy for ' + esc(e.priceText) + '</button>';
    const wb = act.querySelector('[data-wear]'); if (wb) wb.addEventListener('click', wear);
    const bb = act.querySelector('[data-buy]'); if (bb) bb.addEventListener('click', () => buy(e));
    view.querySelectorAll('.lk').forEach(b => {
      const x = SK.find(G.g.id, b.dataset.id), s = status(x, false);
      b.setAttribute('aria-pressed', String(x.id === sel));
      b.setAttribute('aria-label', x.name + ', ' + s.txt);
      b.querySelector('.lk-st').innerHTML = s.chip;
    });
    const own = document.getElementById('lk-own');
    if (own) { const n = G.paid.filter(owns).length; own.textContent = mode === 'out' ? 'Sign in to see the ones you own' : n ? 'You own ' + n : 'You own none yet'; }
  }

  function pick(id) {
    if (id === sel) return;
    sel = id; stage.set(G.g.id, id, { big: true, bare: true }); paint();
  }

  function wear() {
    const e = SK.find(G.g.id, sel); worn[G.g.id] = e.id; paint();
    if (isCar(G)) U.toast('Using the ' + e.name, 'ok', 'In Swim from your next race.');
    else U.toast('Wearing ' + e.name, 'ok', 'In ' + G.g.name + ' from your next game.');
  }

  /* the buy sheet: today's unlock sheet in the kit's one sheet. The page never sets a price; it shows the catalog's. */
  function buy(e) {
    const gid = G.g.id, out = !U.signedIn, bal = me.balanceUsd;
    let caseM = null, going = false;
    U.sheet({ title: 'Buy ' + e.name, cls: 'lk-buy',
      html: '<div class="lk-case" id="lk-case"></div><p class="t-body">' + esc(G.g.name) + ' look. Yours to keep on every device.</p>' +
        (out ? '<p class="hint">Sign in to buy looks. Free looks work without it.</p>'
          : '<div class="sum"><div><span>Price</span><b class="money">' + F.usd(e.price) + '</b></div><div><span>Your balance</span><b>' + F.usd(bal) + '</b></div>' +
            '<div><span>After</span><b>' + F.usd(bal - e.price) + '</b></div></div>') +
        '<p class="hint lk-msg" data-msg aria-live="polite"></p>',
      foot: '<button type="button" class="btn btn-primary btn-lg btn-block" data-go data-autofocus>' + (out ? 'Sign in to buy' : 'Buy for ' + esc(e.priceText)) + '</button>' +
        '<button type="button" class="btn btn-quiet btn-block" data-close>Not now</button>' +
        '<p class="t-meta lk-fine">Paid in SOL from your wallet. Skins are final, so there are no refunds.</p>',
      onOpen(el, close) {
        caseM = SK.mount(el.querySelector('#lk-case'), gid, e.id, { big: true, bare: true });
        const go = el.querySelector('[data-go]'), msg = el.querySelector('[data-msg]');
        go.addEventListener('click', () => {
          if (out) { U.busy(go, 700, () => U.toast('Sign in opens here', 'info', 'Mockup: the real site shows the Privy sign in.')); return; }
          if (going) return; going = true;
          msg.textContent = 'Getting the price';
          U.busy(go, 700, () => {
            msg.textContent = 'Confirm in your wallet';
            U.busy(go, 1000, () => {
              msg.textContent = 'Buying ' + e.name;
              U.busy(go, 700, () => {
                (owned[gid] = owned[gid] || []).push(e.id); worn[gid] = e.id;
                close(); U.toast('Bought ' + e.name, 'ok', 'Now worn in ' + G.g.name + '.');
                if (G.g.id === gid) paint();
              });
            });
          });
        });
      },
      onClose() { if (caseM) { caseM.destroy(); caseM = null; } }
    });
  }

  /* the game switch: the kit sheet with one list row per game */
  function pickGame() {
    U.sheet({ title: 'Choose a game',
      html: '<div class="list lk-games">' + GAMES.map(x => {
        const cur = x === G, n = x.free.length, p = x.paid.length;
        const sub = n + p === 1 ? 'One look for now' : (x.g.id === 'swim' ? n + ' cars' : n + ' free') + (p ? ', ' + p + ' paid' : '');
        return '<button type="button" class="row" data-pick="' + x.g.id + '"' + (cur ? ' aria-current="true"' : '') + '><span class="row-ic"><img src="' + x.g.img + '" alt=""></span>' +
          '<span class="row-main"><b>' + esc(x.g.name) + '</b><span>' + sub + '</span></span><span class="row-end">' + I(cur ? 'check' : 'chev', 18) + '</span></button>';
      }).join('') + '</div>',
      onOpen(el, close) { el.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => { const id = b.dataset.pick; close(); switchTo(id); })); }
    });
  }

  function qs() {
    const p = []; if (!U.signedIn) p.push('signedout'); if (mode === 'none') p.push('empty'); p.push('game=' + G.g.id);
    return 'customize.html?' + p.join('&');
  }
  function switchTo(id) {
    open(id);
    try { history.replaceState(null, '', qs()); } catch (_) {}
    window.scrollTo(0, 0);
  }

  open(U.Q.get('game') || 'snake');

  /* mockup state switcher, at the foot of the page */
  let ready = false;
  K.states([['some', 'Owns some'], ['none', 'Owns none'], ['out', 'Signed out']], s => {
    if (!ready) return;
    if (s === 'out') { if (U.signedIn) location.href = 'customize.html?signedout&game=' + G.g.id; return; }
    if (!U.signedIn) { location.href = 'customize.html?' + (s === 'none' ? 'empty&' : '') + 'game=' + G.g.id; return; }
    mode = s; seed(); open(G.g.id);
    try { history.replaceState(null, '', qs()); } catch (_) {}
  });
  ready = true;
  const sw = document.querySelector('.ds-states');
  if (sw) {
    sw.classList.add('is-static'); document.getElementById('mock').append(sw);
    sw.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.s === mode));
  }
})();
