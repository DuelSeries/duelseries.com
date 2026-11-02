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

   Site redo stage 3 (layout 1, mockup looks/ab/1/leaderboards.html?card): your
   initial, name and short address (with Copy), the name field with one line on
   where the name shows, the balance the header chip shows with Open wallet,
   Your public profile (the Leaderboards profile other players see), and Sign
   out. A popover under the initial on a PC, the kit's bottom sheet on a phone
   (CSS: the card is one element, outside the header).

   Exposes window.V2Me = { open, close, toggle, paint, copy, profile }. */
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
  const PERSON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/></svg>';
  function short(a) { return a && a.length > 10 ? a.slice(0, 4) + '…' + a.slice(-4) : (a || ''); }

  /* The disc, the card's heading and its address, from the saved name and the
     wallet. textContent only: the name is typed by the player. */
  function paint() {
    const n = name(), w = wallet();
    /* No name yet: a person, not a question mark (a ? in the header read as a Help button), and the card's
       heading says there is none rather than showing the field's placeholder as if it were a name. */
    ['medisc', 'medisc2'].forEach(id => {
      const d = el(id); if (!d) return;
      if (n) d.textContent = n[0].toUpperCase(); else d.innerHTML = PERSON;
      d.classList.toggle('q', !n);
    });
    const nm = el('mename');
    if (nm) { nm.textContent = n || 'No name yet'; nm.classList.toggle('none', !n); }
    const has = !!(w.authenticated && w.address);
    const ad = el('meaddr');
    if (ad) { ad.textContent = has ? short(w.address) : ''; ad.title = has ? w.address : ''; }
    const cp = el('me-copy'); if (cp) cp.hidden = !has;
    /* The balance is the header chip's own figure (wallet.js writes it, countUp.js rolls it): its final string,
       never one caught mid-roll, and never a number worked out here. */
    const hb = el('hdr-balance'), mb = el('mebal');
    if (hb && mb) {
      const t = hb.__cu && hb.__cu.fin != null ? hb.__cu.fin : hb.textContent;
      if (mb.textContent !== t) mb.textContent = t;
      mb.classList.toggle('ds-money', t.indexOf('$') >= 0);
    }
    // Your public profile: only with a name, which is what the board and search know you by.
    const lk = el('me-links'); if (lk) lk.hidden = !(has && n);
    const btn = el('mebtn');
    if (btn) btn.setAttribute('aria-label', n ? 'Your profile, ' + n : 'Your profile');
    const out = el('me-out');
    if (out && w.authenticated) { out.disabled = false; out.textContent = 'Sign out'; }
    /* Signed out while the card is up (here, or in another tab): it goes. */
    if (w.ready && !has) close();
  }

  function isOpen() { const p = el('mepop'); return !!(p && !p.hidden); }

  /* A PC: the card hangs under the initial, its right edge on the initial's. A phone: the kit's bottom sheet (CSS). */
  function place() {
    const p = el('mepop'), b = el('mebtn');
    if (!p || !b || p.hidden) return;
    if (window.matchMedia && window.matchMedia('(max-width:760px)').matches) { p.style.top = ''; p.style.right = ''; return; }
    const r = b.getBoundingClientRect(), hd = b.closest('header');
    p.style.top = Math.round((hd ? hd.getBoundingClientRect().bottom : r.bottom) + 8) + 'px';
    p.style.right = Math.max(12, Math.round(window.innerWidth - r.right)) + 'px';
  }
  window.addEventListener('resize', place);

  function open() {
    const p = el('mepop'), b = el('mebtn'), v = el('meveil');
    if (!p) return;
    paint();
    p.hidden = false;
    place();
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

  /* Copy: the whole address, said in a toast with the short form. */
  function copy() {
    const w = wallet();
    if (!(w.authenticated && w.address)) return;
    const say = (kind, title, detail) => { if (window.DSToast) window.DSToast.show({ kind: kind, title: title, detail: detail }); };
    try {
      navigator.clipboard.writeText(w.address).then(() => say('ok', 'Address copied', short(w.address)),
        () => say('err', 'Could not copy', 'Copy it from the Wallet tab instead.'));
    } catch (_) { say('err', 'Could not copy', 'Copy it from the Wallet tab instead.'); }
  }
  /* Your public profile: the Leaderboards profile everyone else sees, opened over its own tab. */
  function profile() {
    const n = name();
    if (!n) return;
    close();
    if (typeof window.go === 'function') window.go('social');
    if (window.V2Social) window.V2Social.openPlayer(n);
  }

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
  /* A balance change reaches the header first and rolls there, so an open card reads it again once it has landed. */
  window.addEventListener('duelwallet:change', () => { paint(); setTimeout(() => { if (isOpen()) paint(); }, 1600); });
  document.addEventListener('input', e => {
    if (e.target && (e.target.id === 'play-name' || e.target.id === 'set-name')) paint();
  });
  document.addEventListener('DOMContentLoaded', paint);

  window.V2Me = { open: open, close: close, toggle: toggle, paint: paint, copy: copy, profile: profile,
    get isOpen() { return isOpen(); } };
})();
