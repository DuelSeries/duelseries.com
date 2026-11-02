/* The header profile card for layout 1 (mockup only). Mirrors today's public/js/v2/me.js + play.js name edit:
   your initial in the header, and a press opens a card with your name and wallet address, the name field (THE one
   place a name is changed), your balance with the wallet, your public profile, and Sign out. Signed out there is no
   avatar, so no card. PC: a popover under the avatar. Phone: the kit's bottom sheet (one sheet everywhere).
   Name edit, as today: the field is locked until the pen (or the field) is pressed; the pen turns into a tick;
   Enter or the tick saves, Escape backs the edit out, tapping away with a good name saves it. 3 to 16 letters or
   numbers; a name already on the board is "taken". Only kit parts: .field .input-wrap .input .btn .row .money.
   Use: MeCard.mount({ profileHref }) after the layout chrome is drawn ; MeCard.open() ; MeCard.close(). */
(function () {
  'use strict';
  const K = window.DSKit, D = K.data, F = K.fmt, I = K.icon, esc = K.esc, U = window.DSUI, me = D.me;
  const PEN = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
  const HINT = 'Shown on the leaderboards and in every game.';
  let name = me.name, btn = null, pop = null, isOpen = false, opts = {};

  function body() {
    return '<div class="mc-id"><span class="mc-disc" aria-hidden="true" data-mc-ini>' + esc(name[0].toUpperCase()) + '</span>' +
      '<div class="mc-who"><b data-mc-nm>' + esc(name) + '</b><span class="mc-addr"><span class="mono" title="' + me.wallet + '">' + F.short(me.wallet) + '</span>' +
      '<button type="button" class="btn btn-quiet btn-sm btn-icon" data-copy aria-label="Copy wallet address" title="Copy wallet address">' + I('copy', 16) + '</button></span></div></div>' +
      '<div class="field mc-field"><label for="mc-name">Player name</label><div class="input-wrap">' +
        '<input class="input" id="mc-name" value="' + esc(name) + '" maxlength="16" readonly autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="done" aria-describedby="mc-msg" title="Press to change your name">' +
        '<button type="button" class="btn btn-secondary btn-sm btn-icon" data-mc-act aria-label="Change name" title="Change name">' + PEN + '</button></div>' +
        '<p class="field-msg" id="mc-msg">' + HINT + '</p></div>' +
      '<div class="mc-bal"><div><span class="t-label">Balance</span><b class="money">' + F.usd(me.balanceUsd) + '</b></div>' +
        '<a class="btn btn-secondary btn-sm" href="' + U.href('wallet.html') + '">' + I('wallet', 16) + 'Open wallet</a></div>' +
      '<div class="list mc-links"><a class="row" href="' + esc(opts.profileHref || 'leaderboards.html?p=' + encodeURIComponent(me.name)) + '">' +
        '<span class="row-ic">' + I('leaderboards', 18) + '</span><div class="row-main"><b>Your public profile</b><span>What other players see</span></div><span class="row-end mc-chev">' + I('chev', 18) + '</span></a></div>' +
      '<button type="button" class="btn btn-quiet btn-block mc-out" data-mc-out>Sign out</button>';
  }

  /* ---------- the name field: idle (pen) -> editing (tick) -> saving -> idle ---------- */
  function wire(root) {
    const input = root.querySelector('#mc-name'), act = root.querySelector('[data-mc-act]'), msg = root.querySelector('#mc-msg'), field = root.querySelector('.mc-field');
    let state = 'idle', before = name;
    const say = (t, bad) => { msg.textContent = t; field.classList.toggle('is-err', !!bad); };
    function setAct(s) {
      state = s;
      act.className = 'btn btn-sm btn-icon ' + (s === 'editing' ? 'btn-primary' : 'btn-secondary');
      act.innerHTML = s === 'editing' ? I('check', 18) : PEN;
      act.setAttribute('aria-label', s === 'editing' ? 'Save name' : 'Change name'); act.title = act.getAttribute('aria-label');
    }
    function edit() {
      if (state !== 'idle') return;
      before = name; input.readOnly = false; setAct('editing'); say('3 to 16 letters or numbers.');
      input.focus(); input.select();
    }
    function cancel() { input.value = before; input.readOnly = true; setAct('idle'); say(HINT); }
    function save() {
      if (state !== 'editing') return;
      const n = input.value.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
      input.value = n;
      if (n.length < 3) { say('Names need at least three letters or numbers.', true); input.focus(); return; }
      if (n === name) { input.readOnly = true; setAct('idle'); say(HINT); return; }
      if (D.board.some(b => b.name.toLowerCase() === n.toLowerCase()) || /^mrpeanutk$/i.test(n)) { say('That name is already taken. Choose a different one.', true); input.focus(); return; }
      state = 'saving'; input.readOnly = true;
      U.busy(act, 800, () => {
        name = n; setAct('idle'); say(HINT); paint();
        U.toast('Name saved', 'ok', n);
      });
    }
    input.addEventListener('click', edit);
    input.addEventListener('input', () => {
      const clean = input.value.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
      if (clean !== input.value) input.value = clean;
      if (field.classList.contains('is-err')) say('3 to 16 letters or numbers.');
    });
    input.addEventListener('keydown', e => {
      if (state !== 'editing') return;
      if (e.key === 'Enter') { e.preventDefault(); save(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); act.focus(); }
    });
    /* tapping away commits a good name, as today; too short goes back to what it was */
    input.addEventListener('blur', e => {
      if (state !== 'editing' || e.relatedTarget === act) return;
      if (input.value.replace(/[^a-zA-Z0-9]/g, '').length < 3) cancel(); else save();
    });
    act.addEventListener('click', () => { if (state === 'idle') edit(); else save(); });
    root.querySelector('[data-mc-out]').addEventListener('click', e => U.busy(e.currentTarget, 700, () => U.toast('Sign out runs here', 'info', 'Mockup: the real site signs you out of Privy.')));
  }

  /* the header disc and any open card follow the saved name */
  function paint() {
    if (btn) { btn.textContent = name[0].toUpperCase(); btn.setAttribute('aria-label', 'Your profile, ' + name); }
    document.querySelectorAll('[data-mc-nm]').forEach(el => { el.textContent = name; });
    document.querySelectorAll('[data-mc-ini]').forEach(el => { el.textContent = name[0].toUpperCase(); });
  }

  /* ---------- PC popover ---------- */
  function place() {
    if (!pop || !btn) return;
    const r = btn.getBoundingClientRect(), hd = btn.closest('.hd');
    pop.style.top = Math.round((hd ? hd.getBoundingClientRect().bottom : r.bottom) + 8) + 'px';
    pop.style.right = Math.max(12, Math.round(innerWidth - r.right)) + 'px';
  }
  function open() {
    if (!btn) return;
    if (isOpen) return;
    isOpen = true; btn.setAttribute('aria-expanded', 'true');
    if (U.PHONE.matches) {
      U.sheet({ title: 'Your profile', html: body(), cls: 'mc-sheet', focus: '[data-mc-act]',
        onOpen: el => wire(el), onClose: () => { isOpen = false; btn.setAttribute('aria-expanded', 'false'); } });
      return;
    }
    pop = document.createElement('div');
    pop.className = 'mc-pop'; pop.id = 'mc-pop'; pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', 'Your profile'); pop.tabIndex = -1;
    pop.innerHTML = body();
    document.body.append(pop); wire(pop); place();
    requestAnimationFrame(() => { if (pop) { pop.classList.add('open'); pop.focus({ preventScroll: true }); } });
  }
  function close(refocus) {
    if (!isOpen) return;
    if (!pop) { U.closeSheet(); return; }
    const a = document.activeElement;
    if (a && pop.contains(a) && a.blur) a.blur();   /* an open name field commits first, as today */
    isOpen = false; btn.setAttribute('aria-expanded', 'false');
    pop.remove(); pop = null;
    if (refocus) btn.focus({ preventScroll: true });
  }

  function mount(o) {
    if (btn) { opts = o || opts; return; }          /* layout.js mounts it once; a page call only adds its options */
    opts = o || {};
    btn = document.querySelector('.hd .me');
    if (!btn) return;                              /* signed out: no avatar, no card */
    btn.removeAttribute('data-stub');
    btn.setAttribute('aria-haspopup', 'dialog'); btn.setAttribute('aria-expanded', 'false'); btn.setAttribute('aria-controls', 'mc-pop');
    btn.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); if (isOpen) close(true); else open(); });
    document.addEventListener('mousedown', e => { if (pop && !pop.contains(e.target) && !btn.contains(e.target)) close(false); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && pop) close(true); });
    addEventListener('resize', () => { if (pop && U.PHONE.matches) close(false); else place(); });
    paint();
  }

  window.MeCard = { mount, open, close: () => close(true), get name() { return name; } };
})();
