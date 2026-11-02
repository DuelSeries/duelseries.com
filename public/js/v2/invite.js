'use strict';
/* ─── Invites (the "get players first" push, 2026-10-26) ──────────────────────
   Two halves of one link, duelseries.com/play/<slug> (shared/shareGames.js):

   Sending: the game screen's "Invite a friend" (Free rung of an open game,
   v2.html #invbtn) copies the link for the game on screen. The link is on this
   page's own origin, so an invite from eu.duelseries.com lands on the EU
   server, where its free room is.

   Arriving: the server sends the lobby itself at /play/<slug>, with that game's
   link preview in its head (server/sharePreview.js). This opens that game's
   screen on the Free rung and presses Play for them, signed in or as a guest
   (play.js guestFree), which is the same free room their friend is in
   (slither.io has one free room per server; Paper and agar.io seat the fullest
   free room with space first).

   Free only, always: the arriving half picks the stake 0 rung and nothing
   else, and the link never carries a stake, a room id or any money word.

   A game's own page (/games/<page>, server/gamePages.js) sends its Play
   buttons here too, marked ?from=page: Play free arrives exactly like an
   invite but is not counted as one (the page sent landing_play_clicked), and
   Play for money adds &pick=1, which opens that game's screen on Free too,
   points at its paid rungs and presses nothing. A paid rung is always picked
   on purpose (Owen, 2026-10-10, v2.html defaultStep): an embedded wallet signs
   a stake with no pop-up of its own, so the rung they press, then Play, is the
   whole confirmation, and a link must never make that choice for them (an
   invite, which arrives without the mark, stays free only). Both marks are
   taken off the address with the path. */
(function () {
  const SHARE = window.DS_SHARE;
  if (!SHARE) return;
  const GUEST_MS = 4000;   // Privy not ready by then: Play as a guest (free rooms need no sign in, play.js guestFree)
  const WAIT_MS = 10000;   // after this nothing presses Play by itself; it is left to them
  const BOARD_MS = 4000;   // Play for money: how long the paid hint waits for /api/live to say which rungs are open

  function linkFor(gameId) {
    const g = SHARE.byGame(gameId);
    return g ? location.origin + '/play/' + g.slug : null;
  }

  /* The clipboard API needs a secure page and a recent click; the hidden
     textarea covers the rest; failing both, a toast shows the link to copy. */
  function copyText(text, done) {
    const fallback = () => {
      const t = document.createElement('textarea');
      t.value = text; t.setAttribute('readonly', ''); t.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.appendChild(t); t.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) {}
      t.remove();
      if (ok) done();
      else if (window.DSToast) DSToast.show({ kind: 'info', title: 'Copy this link', code: text });
    };
    try {
      if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, fallback);
      else fallback();
    } catch (_) { fallback(); }
  }

  /* A Copy button that says Copied for a moment after a press (the Refer a friend page): its label is .ref-cl. */
  function flip(btn) {
    if (!btn) return;
    const lbl = btn.querySelector('.ref-cl');
    if (lbl && !btn.dataset.was) btn.dataset.was = lbl.textContent;
    btn.classList.add('is-done');
    if (lbl) lbl.textContent = btn.dataset.done || 'Copied';
    clearTimeout(btn._t);
    btn._t = setTimeout(() => { btn.classList.remove('is-done'); if (lbl) lbl.textContent = btn.dataset.was; }, 2200);
  }

  function copy(gameId, btn) {
    const id = gameId || (window.V2Detail && V2Detail.game);
    const url = linkFor(id);
    if (!url) return;
    const g = SHARE.byGame(id);
    copyText(url, () => {
      flip(btn);
      const inv = document.getElementById('invbtn'), label = document.getElementById('invlabel');
      if (inv && label) {
        inv.classList.add('done');
        label.textContent = 'Link copied';
        clearTimeout(inv._t);
        inv._t = setTimeout(() => { inv.classList.remove('done'); label.textContent = 'Invite a friend'; }, 2200);
      }
      if (window.DSToast) DSToast.show({ kind: 'ok', title: 'Invite link copied', detail: 'Send it to a friend to play ' + g.name + ' together' });
    });
    if (window.DSTrack) window.DSTrack.event('invite_copied', { game: id });
  }

  /* ── arriving ── */
  const m = /^\/play\/([a-z]+)\/?$/.exec(location.pathname);
  const arrived = m ? SHARE.bySlug(m[1]) : null;
  let fromPage = false, pick = false;
  if (m) {
    let rest = location.search;
    try {
      const q = new URLSearchParams(location.search);
      fromPage = q.get('from') === 'page';
      pick = fromPage && q.get('pick') === '1';
      q.delete('from'); q.delete('pick');
      rest = q.toString() ? '?' + q.toString() : '';
    } catch (_) {}
    /* The lobby is the lobby again: a reload or Back is home, not a second invite. */
    try { history.replaceState(history.state, '', '/' + rest + location.hash); } catch (_) {}
    document.title = SHARE.HOME.title;   // the invite's own title was for the link preview
  }

  function signedIn() {
    const w = window.duelWallet || {};
    return !!(w.authenticated && w.address);
  }

  function arrive(g) {
    if (typeof window.open_ !== 'function' || typeof window.pickStake !== 'function') return;
    if (window.V2_IS_SOON && window.V2_IS_SOON(g.game)) return;
    try { window.open_(g.game, fromPage ? 'landing' : 'invite'); } catch (_) { return; }
    /* Free, whatever this browser last played: an invite is to the free room, and Play for money only points. */
    const free = typeof STEPS !== 'undefined' ? STEPS.indexOf(0) : -1;
    if (free >= 0) window.pickStake(free);
    if (pick) { pointAtPaid(g); return; }
    if (window.DSTrack && !fromPage) window.DSTrack.event('invite_opened', { game: g.game });
    let started = false, gaveUp = false;
    const onFree = () => !!(window.V2Detail && V2Detail.game === g.game && V2Detail.stake === 0);
    /* Privy says whether this visitor is signed in (duelWallet.ready); until then a signed-in friend would be
       started as a guest, so Play waits for it, or for GUEST_MS when it is slow, then plays as a guest. */
    /* No sign of a session in this browser at all (DSWalletBoot.session, the top of v2.html): nobody can be signed
       in, so there is nothing to wait for. The widget now comes in only once the page is idle, and this would
       otherwise sit out the whole GUEST_MS before a new visitor's free table. */
    const ready = () => !!(window.duelWallet && window.duelWallet.ready)
      || !!(window.DSWalletBoot && window.DSWalletBoot.session === false);
    const start = () => {
      if (started || gaveUp || !onFree()) return;
      started = true;
      window.removeEventListener('duelwallet:change', go);
      if (typeof window.startFromDetail === 'function') window.startFromDetail();
    };
    const go = () => { if (signedIn() || ready()) start(); };
    window.addEventListener('duelwallet:change', go);
    /* Pressing anything on the page first means they are choosing for themselves. */
    document.addEventListener('pointerdown', () => { gaveUp = true; window.removeEventListener('duelwallet:change', go); }, { once: true, capture: true });
    setTimeout(start, GUEST_MS);
    setTimeout(() => { gaveUp = true; window.removeEventListener('duelwallet:change', go); }, WAIT_MS);
    go();
  }

  /* Play for money from a game's page: the screen stays on Free and nothing is pressed. Once the board says which
     paid rungs are open (v2.html restep un-strikes them), those are outlined and a toast says to pick one. */
  function pointAtPaid(g) {
    const box = document.getElementById('stakes');
    const t0 = Date.now();
    const boardIn = () => !!(window.V2Board && Array.isArray(V2Board.lobbies) && V2Board.lobbies.length);
    const wait = () => {
      if (!(window.V2Detail && V2Detail.game === g.game)) return;   // they have moved on
      if (!boardIn() && Date.now() - t0 < BOARD_MS) { setTimeout(wait, 100); return; }
      const off = typeof STEPS_OFF !== 'undefined' ? STEPS_OFF : new Set();
      const paid = (typeof STEPS !== 'undefined' ? STEPS : []).filter((v) => v > 0 && !off.has(v));
      const amt = (v) => '$' + (Number.isInteger(v) ? v : v.toFixed(2));
      if (!paid.length) {
        if (window.DSToast) DSToast.show({ kind: 'info', title: 'No paid tables open right now', detail: 'Free is open: press Play to play free.' });
        return;
      }
      if (box) {
        box.classList.add('hint');
        try { box.scrollIntoView({ block: 'nearest' }); } catch (_) {}
        const clear = () => box.classList.remove('hint');
        document.addEventListener('pointerdown', clear, { once: true, capture: true });
        setTimeout(clear, 8000);
      }
      if (window.DSToast) DSToast.show({ kind: 'info', title: 'Pick ' + paid.map(amt).join(' or ') + ' to play for money' });
    };
    wait();
  }

  if (arrived) {
    if (document.readyState === 'complete') setTimeout(() => arrive(arrived), 0);
    else window.addEventListener('load', () => arrive(arrived), { once: true });
  }

  /* Refer a friend's Copy link: the lobby's own address, which opens the home screen
     with the site's link preview (shared/shareGames.js HOME). Nothing is promised for it. */
  function home(btn) {
    copyText(location.origin + '/', () => {
      flip(btn);
      if (window.DSToast) DSToast.show({ kind: 'ok', title: 'Invite link copied', detail: 'Send it to a friend' });
    });
    // the lobby's own link names no game: an invite_copied without one is a "Refer a friend"
    if (window.DSTrack) window.DSTrack.event('invite_copied', {});
  }

  /* ── the Refer a friend page (site redo stage 3, layout 1; mockup looks/ab/1/refer.html) ──
     The lobby link set large with its Copy, beside what a friend sees when it lands in a chat (the site's own link
     preview, shareGames.js HOME), then a link for each free game with how many are playing it now (the board's own
     counts, nothing typed in), each with its own Copy. A game that is Coming soon gets no row; one with no link at all
     is named under the list. Free only: a link never carries a stake. */
  const COPY_IC = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" class="ref-i-cp"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>' +
    '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" class="ref-i-ok"><path d="M5 12l5 5 9-10"/></svg>';
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  function page() {
    const list = document.getElementById('ref-list');
    if (!list) return;
    const host = String(location.host || 'duelseries.com').replace(/^www./, '');
    const u = document.getElementById('ref-url'); if (u) u.textContent = host;
    const b = document.getElementById('ref-bub'); if (b) b.textContent = location.origin + '/';
    const h = document.getElementById('ref-host'); if (h) h.textContent = host;
    const all = typeof GAMES !== 'undefined' ? GAMES : [];
    const soon = (id) => !!(window.V2_IS_SOON && window.V2_IS_SOON(id));
    const counts = (window.V2Board && V2Board.counts) || null;
    const art = (id) => (window.V2_artSrc ? window.V2_artSrc(id) : '/img/games/' + id + '.png');
    const rows = all.filter((g) => SHARE.byGame(g.id) && !g.soon && !soon(g.id));
    list.innerHTML = rows.map((g) => {
      const s = SHARE.byGame(g.id);
      const n = counts && typeof counts[g.id] === 'number' && counts[g.id] > 0 ? Math.floor(counts[g.id]) : 0;
      return '<div class="ds-row ref-row"><span class="ds-row-ic"><img src="' + esc(art(g.id)) + '" alt="" loading="lazy" draggable="false"></span>' +
        '<span class="ds-row-main"><b>' + esc(g.name) + '</b><span class="ref-u">' + esc(host + '/play/' + s.slug) + '</span>' +
        (n ? '<span class="ref-k">' + n + ' playing</span>' : '') + '</span>' +
        '<span class="ds-row-end ref-end">' + (n ? '<span class="ref-n"><i class="ds-dot"></i>' + n + ' playing</span>' : '') +
        '<button type="button" class="ds-btn ds-btn-secondary ds-btn-sm ref-cp" data-inv="' + esc(g.id) + '" aria-label="Copy the invite link for ' + esc(g.name) + '">' +
        COPY_IC + '<span class="ref-cl">Copy</span></button></span></div>';
    }).join('');
    const without = all.filter((g) => !g.soon && !soon(g.id) && !SHARE.byGame(g.id)).map((g) => g.name);
    const and = (a) => a.length > 1 ? a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1] : a[0];
    const none = document.getElementById('ref-none');
    if (none) none.textContent = without.length ? and(without) + (without.length > 1 ? ' have' : ' has') + ' no invite link yet.' : '';
  }
  document.addEventListener('click', (e) => {
    const b = e.target && e.target.closest && e.target.closest('#ref-list [data-inv]');
    if (b) copy(b.dataset.inv, b);
  });

  window.V2Invite = { copy: copy, link: linkFor, home: home, page: page };
})();
