'use strict';
/* ─── Starting a game ─────────────────────────────────────────────────────────
   This module starts nothing itself. It collects a name, a region and a lobby,
   then fires the same duel:play event the live lobby fires, and the Privy
   widget does the staking and the launch. Every line of money handling stays in
   one place that way, and this lobby cannot drift from the live one.

   The widget currently reads `detail.game` and `detail.lobbyType` off the
   event, so that is what is sent. The any-amount model is built server-side but
   nothing routes through it until the widget speaks it and the mainnet gate has
   been run; sending a stake here would be a silent half-migration.

   The game runs in an iframe on the shared main thread. Pausing the lobby's
   animations before showing it is not cosmetic: leaving them running is what
   cost a day of hunting a 30fps drop that turned out to be the lobby preview
   animating behind the game. */

(function () {
  const NAME_KEY = 'duelseries_playername';
  const el = id => document.getElementById(id);

  const cleanName = s => String(s || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);

  function savedName() {
    try { return cleanName(localStorage.getItem(NAME_KEY) || ''); } catch (_) { return ''; }
  }
  function setName(v) {
    const n = cleanName(v);
    try { localStorage.setItem(NAME_KEY, n); } catch (_) {}
    const i = el('play-name'); if (i) i.value = n;
    const s = el('set-name');  if (s) s.value = n;
    return n;
  }
  const token = () => { try { return localStorage.getItem('duel_admin_token'); } catch (_) { return null; } };

  /* The account's name is the truth, and it overwrites whatever this browser
     had. That is the whole point: the same person on a phone and a laptop was
     two different names, because the name only ever lived in localStorage. */
  async function pullName() {
    const w = (window.duelWallet || {}).address;
    if (!w) return;
    try {
      const r = await fetch('/api/my-profile?wallet=' + encodeURIComponent(w));
      const p = await r.json();
      if (p && p.name) setName(p.name);
      else if (savedName()) pushName(savedName());   // first device to name it, wins
    } catch (_) {}
  }
  /* Authenticated by the Privy token; the server resolves the wallet from it
     rather than believing anything sent from here. */
  /* true saved, 'taken' somebody else has it, false could not save. Three
     outcomes rather than two, because "taken" is the one the player can
     actually do something about. */
  async function pushName(n) {
    const t = token(); if (!t || !n || n.length < 3) return false;
    try {
      const r = await fetch('/api/my-name', { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
        body: JSON.stringify({ name: n }) });
      if (r.status === 409) return 'taken';
      return r.ok;
    } catch (_) { return false; }
  }
  let toastT = 0;
  function toast(text) {
    const t = el('toast'); if (!t) return;
    t.textContent = text; t.classList.add('on');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 4000);
  }
  const setState = s => { const b = el('name-act'); if (b) b.dataset.state = s; };

  /* One button through four states. Locked it is a pen; pressing it opens the
     field and turns it into a tick; pressing the tick saves. The tick holds
     green for a beat and falls back to the pen, or turns into a cross and says
     why in the corner. */
  async function nameAction() {
    const input = el('play-name'), btn = el('name-act');
    if (!input || !btn) return;

    if (btn.dataset.state === 'idle') {
      input.readOnly = false;
      setState('editing');
      btn.setAttribute('aria-label', 'Save name');
      input.focus(); input.select();
      return;
    }
    if (btn.dataset.state === 'saving') return;      // already in flight

    const n = setName(input.value || '');
    if (n.length < 3) {
      setState('bad'); toast('Names need at least three letters or numbers.');
      setTimeout(() => setState('editing'), 1200);
      return;
    }
    setState('saving');
    const res = await pushName(n);
    if (res === 'taken') {
      setState('bad');
      toast('That name is already taken. Please choose a different one.');
      setTimeout(() => { setState('editing'); input.focus(); }, 1400);
      return;
    }
    if (!res && (window.duelWallet || {}).authenticated) {
      setState('bad');
      toast('Could not reach your account. The name is saved on this device only.');
      setTimeout(() => { setState('editing'); }, 1600);
      return;
    }
    /* Saved, or saved locally because nobody is signed in — which is the most
       this can do and is not a failure to report as one. */
    if (!res) toast('Saved here. Sign in to use this name on your other devices.');
    input.readOnly = true;
    setState('ok');
    btn.setAttribute('aria-label', 'Change name');
    setTimeout(() => setState('idle'), 1100);
  }
  window.addEventListener('duelwallet:change', pullName);

  function region() {
    try { return localStorage.getItem('duelseries_region') || 'na'; } catch (_) { return 'na'; }
  }

  function connected() {
    const w = window.duelWallet || {};
    return !!(w.authenticated && w.address);
  }

  function say(msg) {
    const box = el('play-msg');
    if (!box) { alert(msg); return; }
    box.textContent = msg;
    box.hidden = !msg;
  }

  /* Returns the name to play under, or null having already explained why not. */
  function requireName() {
    const input = el('play-name');
    const name = cleanName(input ? input.value : savedName());
    if (name.length < 3) {
      say('Pick a name of at least three letters or numbers to play.');
      if (input) input.focus();
      return null;
    }
    try { localStorage.setItem(NAME_KEY, name); } catch (_) {}
    pushName(name);            /* so the next device you sign in on knows it */
    return name;
  }

  /* BOTH frames. This checked only game-frame, so with agar.io running the
     lobby did not think it was in a game: its animations were never paused and
     kept painting on the same main thread the game renders on. That is what
     was costing agar its frame rate. */
  const FRAMES = ['game-frame', 'agar-frame'];
  const shown = () => FRAMES.map(el).filter(f => f && f.style.display === 'block');
  function inGame() { return shown().length > 0; }

  /* The one door. Everything else here funnels into this.
     `sel` names the room: { stake } for a rung of the ladder, or { lobbyType }
     for one of the old fixed tiers. */
  function launch(game, sel) {
    if (inGame()) return;
    const hasStake = sel && sel.stake !== undefined && sel.stake !== null;
    const hasTier = sel && !!sel.lobbyType;
    /* Never dispatch without naming the room. The widget defaults a missing
       lobbyType to 'dime', so an unnamed launch silently charges ten cents for
       a room the player did not choose. Refuse instead: a room we cannot name
       is a room we must not stake into. */
    if (!hasStake && !hasTier) {
      say('That lobby is not available right now. Refresh and try again.');
      return;
    }
    if (!connected()) {
      say('Sign in first — your wallet is your account here.');
      if (window.duelWalletLogin) window.duelWalletLogin();
      return;
    }
    const name = requireName();
    if (!name) return;
    say('');
    const detail = hasStake
      ? { game: game, stake: Number(sel.stake) }
      : { game: game, lobbyType: sel.lobbyType };
    /* Remembered at launch, not at selection, so the buy-in that comes back
       tomorrow is one actually played rather than one idly scrolled past. */
    if (hasStake && window.rememberStake) window.rememberStake(Number(sel.stake));
    if (window.phEvent) window.phEvent('game_started', detail);
    /* The widget stakes if the room is paid, then launches. It owns the money;
       this only says which room. Exactly one of stake and lobbyType is sent, so
       the server never has to guess which the player meant. */
    window.dispatchEvent(new CustomEvent('duel:play', { detail: detail }));
  }

  /* From a board row. The row names its own room, so nothing is guessed. */
  function enter(lobby) {
    if (!lobby) return;
    launch(lobby.game || 'snake',
      lobby.stake !== undefined && lobby.stake !== null
        ? { stake: lobby.stake }
        : { lobbyType: lobby.lobbyType });
  }

  /* From the detail screen, where a buy-in has been chosen. */
  function playChosen() {
    const game = (window.V2Detail && window.V2Detail.game) || 'snake';
    const stake = (window.V2Detail && window.V2Detail.stake);
    const rows = (window.V2Board ? window.V2Board.lobbies : [])
      .filter(l => l.game === game);
    const hit = rows.find(l => Math.abs(l.stake - stake) < 1e-9);
    if (hit) { enter(hit); return; }
    /* The board carries buy-in rungs for snake only. A game with no rungs at
       all is not a missing room, it is a game that runs on the fixed tiers, so
       it opens on the free one — and ONLY the free one. The !stake guard is
       what keeps that true: this path can never reach a paid room, so it
       cannot stake anything. */
    if (!rows.length && !stake) { launch(game, { lobbyType: 'free' }); return; }
    say('No room at that buy-in. Pick one the board is offering.');
  }

  function spectate(game) {
    if (inGame()) return;
    try {
      sessionStorage.setItem('spectateOnly', 'true');
      sessionStorage.setItem('region', region());
    } catch (_) {}
    show(game === 'agar' ? '/agar.html' : '/game.html');
  }

  function show(src) {
    const f = el(src.indexOf('agar') >= 0 ? 'agar-frame' : 'game-frame');
    if (!f) return;
    if (window._pauseLobbyAnims) window._pauseLobbyAnims();
    f.src = src;
    f.style.display = 'block';
  }

  /* The game signals its own exit. Both frames are cleared and the lobby's
     animations restart. */
  window.addEventListener('message', e => {
    if (e.data !== 'game:done') return;
    FRAMES.forEach(id => { const f = el(id); if (f) { f.style.display = 'none'; f.src = ''; } });
    if (window._resumeLobbyAnims) window._resumeLobbyAnims();
    if (window.V2Board) window.V2Board.load();
    if (window.duelWalletRefresh) window.duelWalletRefresh();
  });

  /* The widget shows the frame itself once a stake settles, so the lobby has to
     notice that rather than assume it did the showing. */
  const seen = new MutationObserver(() => {
    if (inGame() && window._pauseLobbyAnims) window._pauseLobbyAnims();
  });
  document.addEventListener('DOMContentLoaded', () => {
    FRAMES.forEach(id => { const f = el(id);
      if (f) seen.observe(f, { attributes: true, attributeFilter: ['style', 'src'] }); });
    const input = el('play-name');
    if (input && !input.value) input.value = savedName();
  });

  window.V2Play = { enter: enter, playChosen: playChosen, spectate: spectate,
                    launch: launch, savedName: savedName, cleanName: cleanName,
                    nameAction: nameAction, pullName: pullName,
                    pushName: pushName };

  /* Forward the stall marker into the game.

     The recorder that measures the hitch lives inside the iframe, so its L
     listener only ever sees a key when the canvas holds focus. If focus sits on
     the lobby around it — which it does after any click out there — the press
     lands here and is silently dropped. A whole test session came back with no
     marks that way, which looks identical to a broken instrument.

     Cheap to forward, and it costs nothing when the game is not open. */
  /* The L-key forwarder went with diag.js: there is nothing in the frame left
     listening for it. */
})();
