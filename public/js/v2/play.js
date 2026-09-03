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
    return name;
  }

  function inGame() {
    const f = el('game-frame');
    return !!(f && f.style.display !== 'none' && f.style.display !== '');
  }

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
    const f = el('game-frame');
    if (!f) return;
    if (window._pauseLobbyAnims) window._pauseLobbyAnims();
    f.src = src;
    f.style.display = 'block';
  }

  /* The game signals its own exit. Both frames are cleared and the lobby's
     animations restart. */
  window.addEventListener('message', e => {
    if (e.data !== 'game:done') return;
    const f = el('game-frame');
    if (f) { f.style.display = 'none'; f.src = ''; }
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
    const f = el('game-frame');
    if (f) seen.observe(f, { attributes: true, attributeFilter: ['style', 'src'] });
    const input = el('play-name');
    if (input && !input.value) input.value = savedName();
  });

  window.V2Play = { enter: enter, playChosen: playChosen, spectate: spectate,
                    launch: launch, savedName: savedName, cleanName: cleanName };

  /* Forward the stall marker into the game.

     The recorder that measures the hitch lives inside the iframe, so its L
     listener only ever sees a key when the canvas holds focus. If focus sits on
     the lobby around it — which it does after any click out there — the press
     lands here and is silently dropped. A whole test session came back with no
     marks that way, which looks identical to a broken instrument.

     Cheap to forward, and it costs nothing when the game is not open. */
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'l' && e.key !== 'L') return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const f = el('game-frame');
    if (!f || !f.contentWindow || f.style.display === 'none') return;
    try { f.contentWindow.postMessage({ type: 'diag:mark' }, window.location.origin); } catch (_) {}
  }, true);
})();
