/* Your profile, in the header (Owen's pick B, 2026-10-16): your initial in a
   disc at the end of the header, and a tap on it opens a card with your name,
   your wallet address, the name field, Wallet and Sign out.

   This is THE place a name is changed now. The field in it is the same
   #play-name / #name-act pair the game screens used to carry, moved here with
   its ids, so play.js keeps saving it exactly as before (localStorage, the
   unsaved mark, the account push and the pull on every wallet change) and
   every game reads it the same way.

   Signed out the disc is not shown (a game cannot be started signed out, and
   the header already says Sign in).

   Exposes window.V2Me = { open, close, toggle, paint }. */
(function () {
  'use strict';
  const el = id => document.getElementById(id);
  const NAME_KEY = 'duelseries_playername';

  function name() {
    if (window.V2Play && window.V2Play.savedName) return window.V2Play.savedName();
    try { return String(localStorage.getItem(NAME_KEY) || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 16); }
    catch (_) { return ''; }
  }
  function wallet() { return window.duelWallet || {}; }
  function short(a) { return a && a.length > 10 ? a.slice(0, 4) + '…' + a.slice(-4) : (a || ''); }

  /* The disc, the card's heading and its address, from the saved name and the
     wallet. textContent only: the name is typed by the player. */
  function paint() {
    const n = name(), w = wallet();
    const initial = n ? n[0].toUpperCase() : '?';
    ['medisc', 'medisc2'].forEach(id => {
      const d = el(id); if (!d) return;
      d.textContent = initial;
      d.classList.toggle('q', !n);
    });
    const nm = el('mename');
    if (nm) { nm.textContent = n || 'Your name'; nm.classList.toggle('none', !n); }
    const ad = el('meaddr');
    if (ad) ad.textContent = w.authenticated && w.address ? short(w.address) : '';
    const btn = el('mebtn');
    if (btn) btn.setAttribute('aria-label', n ? 'Your profile, ' + n : 'Your profile');
    const out = el('me-out');
    if (out && w.authenticated) { out.disabled = false; out.textContent = 'Sign out'; }
    /* Signed out while the card is up (here, or in another tab): it goes. */
    if (w.ready && !(w.authenticated && w.address)) close();
  }

  function isOpen() { const p = el('mepop'); return !!(p && !p.hidden); }

  function open() {
    const p = el('mepop'), b = el('mebtn'), v = el('meveil');
    if (!p) return;
    paint();
    p.hidden = false;
    if (v) v.classList.add('on');
    if (b) b.setAttribute('aria-expanded', 'true');
  }
  /* An open name field is committed first, the way tapping away from it does
     on a game screen: play.js's blur handler saves it. */
  function close() {
    const p = el('mepop'), b = el('mebtn'), v = el('meveil');
    if (!p || p.hidden) return;
    const a = document.activeElement;
    if (a && p.contains(a) && typeof a.blur === 'function') a.blur();
    p.hidden = true;
    if (v) v.classList.remove('on');
    if (b) b.setAttribute('aria-expanded', 'false');
  }
  function toggle() { if (isOpen()) close(); else open(); }

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !isOpen()) return;
    /* Escape inside the name field backs the edit out (play.js); only an
       Escape from anywhere else closes the card. */
    if (e.target && e.target.id === 'play-name') return;
    const btn = el('name-act');
    if (btn && btn.dataset && btn.dataset.state && btn.dataset.state !== 'idle') return;
    close();
    const b = el('mebtn'); if (b) b.focus();
  });
  window.addEventListener('duelwallet:change', paint);
  document.addEventListener('input', e => {
    if (e.target && (e.target.id === 'play-name' || e.target.id === 'set-name')) paint();
  });
  document.addEventListener('DOMContentLoaded', paint);

  window.V2Me = { open: open, close: close, toggle: toggle, paint: paint, get isOpen() { return isOpen(); } };
})();
