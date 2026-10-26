'use strict';
/* ─── Invites (the "get players first" push, 2026-10-26) ──────────────────────
   Two halves of one link, duelseries.com/play/<slug> (shared/shareGames.js):

   Sending: the game screen's "Invite a friend" (Free rung of an open game,
   v2.html #invbtn) copies the link for the game on screen. The link is on this
   page's own origin, so an invite from eu.duelseries.com lands on the EU
   server, where its free room is.

   Arriving: the server sends the lobby itself at /play/<slug>, with that game's
   link preview in its head (server/sharePreview.js). This opens that game's
   screen on the Free rung and, once the visitor is signed in with a name,
   presses Play for them, which is the same free room their friend is in
   (slither.io has one free room per server; Paper and agar.io seat the fullest
   free room with space first). Not signed in, the screen waits on Free with a
   toast saying so, and Play goes through sign in as it always does.

   Free only, always: the arriving half picks the stake 0 rung and nothing
   else, and the link never carries a stake, a room id or any money word. */
(function () {
  const SHARE = window.DS_SHARE;
  if (!SHARE) return;
  const WAIT_MS = 10000;   // how long a signed-in visitor's wallet gets to show up before Play is left to them

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
    if (window.phEvent) window.phEvent('invite_copied', { game: id });
  }

  /* ── arriving ── */
  const m = /^\/play\/([a-z]+)\/?$/.exec(location.pathname);
  const arrived = m ? SHARE.bySlug(m[1]) : null;
  if (m) {
    /* The lobby is the lobby again: a reload or Back is home, not a second invite. */
    try { history.replaceState(history.state, '', '/' + location.search + location.hash); } catch (_) {}
    document.title = 'DuelSeries';   // the invite's own title was for the link preview
  }

  function signedIn() {
    const w = window.duelWallet || {};
    return !!(w.authenticated && w.address);
  }

  function arrive(g) {
    if (typeof window.open_ !== 'function' || typeof window.pickStake !== 'function') return;
    if (window.V2_IS_SOON && window.V2_IS_SOON(g.game)) return;
    try { window.open_(g.game); } catch (_) { return; }
    /* Free, whatever this browser last played: an invite is to the free room. */
    const free = typeof STEPS !== 'undefined' ? STEPS.indexOf(0) : -1;
    if (free >= 0) window.pickStake(free);
    if (window.phEvent) window.phEvent('invite_opened', { game: g.game });
    let started = false, gaveUp = false;
    const onFree = () => !!(window.V2Detail && V2Detail.game === g.game && V2Detail.stake === 0);
    const go = () => {
      if (started || gaveUp || !signedIn() || !onFree()) return;
      started = true;
      window.removeEventListener('duelwallet:change', go);
      if (typeof window.startFromDetail === 'function') window.startFromDetail();
    };
    if (!signedIn() && window.DSToast) {
      DSToast.show({ kind: 'ok', title: 'You were invited to play ' + g.name, detail: 'Press Play to join your friend' });
    }
    window.addEventListener('duelwallet:change', go);
    /* Pressing anything on the page first means they are choosing for themselves. */
    document.addEventListener('pointerdown', () => { gaveUp = true; window.removeEventListener('duelwallet:change', go); }, { once: true, capture: true });
    setTimeout(() => { gaveUp = true; window.removeEventListener('duelwallet:change', go); }, WAIT_MS);
    go();
  }

  if (arrived) {
    if (document.readyState === 'complete') setTimeout(() => arrive(arrived), 0);
    else window.addEventListener('load', () => arrive(arrived), { once: true });
  }

  window.V2Invite = { copy: copy, link: linkFor };
})();
