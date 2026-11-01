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
   Play for money adds &pick=1, which opens that game's screen on its cheapest
   open paid rung and presses nothing: Play, signing in and the wallet's own
   confirm are still the player's, exactly as from the lobby's own card (an
   invite, which arrives without the mark, stays free only). Both marks are
   taken off the address with the path. */
(function () {
  const SHARE = window.DS_SHARE;
  if (!SHARE) return;
  const GUEST_MS = 4000;   // Privy not ready by then: Play as a guest (free rooms need no sign in, play.js guestFree)
  const WAIT_MS = 10000;   // after this nothing presses Play by itself; it is left to them

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

  function copy(gameId) {
    const id = gameId || (window.V2Detail && V2Detail.game);
    const url = linkFor(id);
    if (!url) return;
    const g = SHARE.byGame(id);
    copyText(url, () => {
      const btn = document.getElementById('invbtn'), label = document.getElementById('invlabel');
      if (btn && label) {
        btn.classList.add('done');
        label.textContent = 'Link copied';
        clearTimeout(btn._t);
        btn._t = setTimeout(() => { btn.classList.remove('done'); label.textContent = 'Invite a friend'; }, 2200);
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
    /* Play for money from a game's page: its screen on the cheapest paid rung it offers, nothing pressed. */
    if (pick) {
      const off = typeof STEPS_OFF !== 'undefined' ? STEPS_OFF : new Set();
      const paid = typeof STEPS !== 'undefined' ? STEPS.findIndex((v) => v > 0 && !off.has(v)) : -1;
      if (paid >= 0) window.pickStake(paid);
      return;
    }
    /* Free, whatever this browser last played: an invite is to the free room. */
    const free = typeof STEPS !== 'undefined' ? STEPS.indexOf(0) : -1;
    if (free >= 0) window.pickStake(free);
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

  if (arrived) {
    if (document.readyState === 'complete') setTimeout(() => arrive(arrived), 0);
    else window.addEventListener('load', () => arrive(arrived), { once: true });
  }

  /* The PC sidebar's "Refer a friend": the lobby's own address, which opens the home screen
     with the site's link preview (shared/shareGames.js HOME). Nothing is promised for it. */
  function home() {
    copyText(location.origin + '/', () => {
      if (window.DSToast) DSToast.show({ kind: 'ok', title: 'Invite link copied', detail: 'Send it to a friend' });
    });
    // the lobby's own link names no game: an invite_copied without one is a "Refer a friend"
    if (window.DSTrack) window.DSTrack.event('invite_copied', {});
  }

  window.V2Invite = { copy: copy, link: linkFor, home: home };
})();
