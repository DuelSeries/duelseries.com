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
  /* Set while the name under NAME_KEY was typed on this device and the account
     has not taken it yet; a push the server accepts clears it. pullName sends
     such a name up instead of overwriting it with the account's older one, and
     that overwrite is how a typed name used to come back as the old one on the
     next launch (Owen, 2026-10-15). */
  const UNSAVED_KEY = 'duelseries_playername_unsaved';
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
    if (window.V2Me) window.V2Me.paint();   // the header's initial and card
    return n;
  }
  function unsaved() {
    try { return localStorage.getItem(UNSAVED_KEY) === '1'; } catch (_) { return false; }
  }
  function markUnsaved(on) {
    try { if (on) localStorage.setItem(UNSAVED_KEY, '1'); else localStorage.removeItem(UNSAVED_KEY); } catch (_) {}
  }
  /* A name the player typed: kept on this device at once, so closing the app
     before confirming it loses nothing, and marked for the account. */
  function typedName(v) {
    const n = cleanName(v);
    if (n === savedName() && !unsaved()) return n;
    try { localStorage.setItem(NAME_KEY, n); } catch (_) {}
    markUnsaved(true);
    return n;
  }
  /* Either name field open for typing: nothing may write over it then. */
  function editing() {
    const b = el('name-act');
    const st = b && b.dataset ? b.dataset.state : '';
    const a = document.activeElement;
    return st === 'editing' || st === 'saving' || st === 'bad' || !!(a && a.id === 'set-name');
  }
  /* Ask the widget for a live token first. The localStorage copy is written by a
     background effect after sign-in, so anything that runs before that effect has
     landed sees nothing there and concludes the player is signed out. */
  async function tokens() {
    if (typeof window.duelWalletToken === 'function') {
      try {
        const t = await window.duelWalletToken();
        if (t && (t.access || t.identity)) return t;
      } catch (_) {}
    }
    try {
      return { access: localStorage.getItem('duel_admin_token'),
               identity: localStorage.getItem('duel_id_token') };
    } catch (_) { return { access: null, identity: null }; }
  }

  /* The account's name is the truth, and it overwrites whatever this browser
     had. That is the whole point: the same person on a phone and a laptop was
     two different names, because the name only ever lived in localStorage. */
  /* Except a name typed here that the account has not taken yet: that one goes
     up first, and the account's name only replaces it when the server refuses
     it as taken (said in a toast). Any other failure keeps it here for the next
     try. Never while a name field is open, and one pull at a time: the wallet
     announces several changes in a row at launch. */
  let pulling = null;
  function pullName() {
    if (!pulling) pulling = pullOnce().catch(() => {}).then(() => { pulling = null; });
    return pulling;
  }
  async function pullOnce() {
    const w = (window.duelWallet || {}).address;
    if (!w || editing()) return;
    const mine = savedName();
    if (unsaved() && mine.length >= 3) {
      const res = await pushName(mine);
      if (res !== 'taken') return;
      markUnsaved(false);
      toast('"' + mine + '" is already taken, so your name is still the one on your account.');
    }
    try {
      const r = await fetch('/api/my-profile?wallet=' + encodeURIComponent(w));
      const p = await r.json();
      if (editing() || unsaved()) return;          // typed into while this was in flight
      if (p && p.name) setName(p.name);
      else if (savedName()) pushName(savedName());   // first device to name it, wins
    } catch (_) {}
  }
  /* Authenticated by the Privy token; the server resolves the wallet from it
     rather than believing anything sent from here. */
  /* Returns true, or a string saying what stopped it. Every failure used to come
     back as plain false and the player was told the same sentence for a taken name,
     an expired login, a server that was not configured and no network at all — so
     there was never anything to act on. */
  async function pushName(n) {
    if (!n || n.length < 3) return 'short';
    /* Both proofs go in one request and the server takes whichever works.

       The signature is the one that matters. It is made by the wallet that IS
       the account, needs nothing from Privy at the moment it is used, and so
       cannot fail for a mismatched app id, a rate limit or an outage — which is
       every reason this was refusing a perfectly good login and telling the
       player their sign-in had expired. The token stays as the fallback. */
    let proof = null;
    if (typeof window.duelWalletSignName === 'function') {
      try { proof = await window.duelWalletSignName(n); } catch (_) {}
    }
    const t = await tokens();
    if (!proof && !t.access && !t.identity) return 'signed-out';
    const headers = { 'Content-Type': 'application/json' };
    if (t.access) headers.Authorization = 'Bearer ' + t.access;
    if (t.identity) headers['privy-id-token'] = t.identity;
    const body = { name: n };
    if (proof) { body.wallet = proof.wallet; body.ts = proof.ts; body.sig = proof.sig; }
    let r;
    try {
      r = await fetch('/api/my-name', { method: 'POST', headers, body: JSON.stringify(body) });
    } catch (_) { return 'offline'; }
    if (r.ok) {
      if (savedName() === cleanName(n)) markUnsaved(false);
      return true;
    }
    if (r.status === 409) return 'taken';
    let err = {};
    try { err = await r.json(); } catch (_) {}
    return err.reason || ('http-' + r.status);
  }
  /* One element per message rather than one element reused. The single toast
     overwrote itself, so two things happening close together showed only the
     second and the first vanished mid-sentence.

     `good` is the whole point of the redesign: a success and a failure look
     different before a word of either is read. */
  /* Enter saves and Escape backs out. Once the field is genuinely typeable a
     keyboard is how it gets used, and hunting for a button to confirm what you
     just typed is not how a text field behaves anywhere else. */
  document.addEventListener('keydown', (e) => {
    if (!e.target || e.target.id !== 'play-name') return;
    const btn = el('name-act');
    if (!btn || btn.dataset.state !== 'editing') return;
    if (e.key === 'Enter') { e.preventDefault(); nameAction(); }
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
      e.target.blur();
    }
  });
  /* What the field held when it was opened, so Escape (or leaving it too short)
     puts back the name and whether it still had to reach the account. */
  let before = null;
  function cancelEdit() {
    if (before) {
      setName(before.name);
      markUnsaved(before.unsaved);
    }
    before = null;
    const input = el('play-name');
    if (input) input.readOnly = true;
    setState('idle');
  }
  /* Kept as it is typed (typedName), so a name is never lost to an app closed
     before the tick. */
  document.addEventListener('input', (e) => {
    if (!e.target || e.target.id !== 'play-name') return;
    const btn = el('name-act');
    if (!btn || btn.dataset.state !== 'editing') return;
    if (cleanName(e.target.value).length >= 3) typedName(e.target.value);
  });
  /* Leaving the open field commits it, as the tick does: tapping away on a
     phone is how most people finish typing. Too short to keep, it goes back to
     what it was rather than shouting about it. A press on the tick blurs the
     field first, and nameAction's own state check stops the click from saving
     a second time. */
  document.addEventListener('blur', (e) => {
    if (!e.target || e.target.id !== 'play-name') return;
    const btn = el('name-act');
    if (!btn || btn.dataset.state !== 'editing') return;
    if (cleanName(e.target.value).length < 3) { cancelEdit(); return; }
    nameAction();
  }, true);
  /* The card itself is public/js/v2/toasts.js (DSToast); this is the one-line
     form every older call uses. */
  function toast(text, good) {
    if (!text) return;
    if (window.DSToast) return window.DSToast.line(text, good);
    const box = el('toasts'); if (!box) return;     // toasts.js missing: the plain line, still read out
    const t = document.createElement('div');
    t.className = 'toast on ' + (good ? 'ok' : 'err');
    t.textContent = text;
    box.appendChild(t);
    setTimeout(() => t.remove(), 5000);
  }
  const toastOk = (text) => toast(text, true);
  const setState = s => { const b = el('name-act'); if (b) b.dataset.state = s; };

  /* Said in the player's terms, one line per thing that can actually go wrong.
     Anything not listed shows its code, so a report is one screenshot rather than
     a round of guessing. */
  const WHY = {
    taken: 'That name is already taken. Please choose a different one.',
    short: 'Names need at least three letters or numbers.',
    'signed-out': 'Sign in first so your name follows you to your other devices.',
    offline: 'No connection. Your name was not saved.',
    'bad-token': 'Could not verify your account just now. Try again in a moment.',
    'bad-identity-token': 'Could not verify your account just now. Try again in a moment.',
    'no-solana-wallet': 'Your account has no wallet yet. Open the Wallet tab first.',
    'privy-not-configured': 'The server cannot check logins right now. This is our end, not yours.',
    'privy-lookup-failed': 'Could not check your login just now. Try again in a moment.',
    'http-500': 'The server could not save it. Try again in a moment.',
  };

  /* One button through four states. Locked it is a pen; pressing it opens the
     field and turns it into a tick; pressing the tick saves. The tick holds
     green for a beat and falls back to the pen, or turns into a cross and says
     why in the corner. */
  /* Opening the editor, from the pen or from the field itself. */
  function nameEdit() {
    const input = el('play-name'), btn = el('name-act');
    if (!input || !btn) return;
    if (btn.dataset.state !== 'idle') return;   // already open, or mid-save
    before = { name: savedName(), unsaved: unsaved() };
    input.readOnly = false;
    setState('editing');
    btn.setAttribute('aria-label', 'Save name');
    input.focus(); input.select();
  }

  async function nameAction() {
    const input = el('play-name'), btn = el('name-act');
    if (!input || !btn) return;

    if (btn.dataset.state === 'idle') { nameEdit(); return; }
    if (btn.dataset.state === 'saving' || btn.dataset.state === 'ok') return;   // in flight, or just saved

    const n = cleanName(input.value || '');
    if (n.length >= 3) { typedName(n); setName(n); }
    if (n.length < 3) {
      setState('bad'); toast('Names need at least three letters or numbers.');
      setTimeout(() => setState('editing'), 1200);
      return;
    }
    setState('saving');                  // a spinner until the server answers
    const res = await pushName(n);
    if (res !== true) {
      setState('bad');
      toast(WHY[res] || ('Could not save your name. Try again in a moment.'));
      setTimeout(() => { setState('editing'); if (res === 'taken') input.focus(); }, 1500);
      return;
    }
    if (window.DSToast) window.DSToast.show({ kind: 'ok', title: 'Name saved', detail: n });
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
    /* Enter on Home's lobby list launches with the game screen hidden, so the
       line under Play said it to nobody and the click looked dead. */
    if (msg && box.offsetParent === null) toast(msg);
  }

  /* Returns the name to play under, or null having already explained why not. */
  function requireName() {
    const input = el('play-name');
    const name = cleanName(input ? input.value : savedName());
    if (name.length < 3) {
      /* The field lives in the header's profile card (public/js/v2/me.js,
         2026-10-16), shut until asked for: open it with the field ready to
         type in, wherever Play was pressed from. */
      say('Pick a name of at least three letters or numbers to play.');
      if (window.V2Me) window.V2Me.open();
      if (input && input.offsetParent !== null) nameEdit();
      return null;
    }
    typedName(name);
    pushName(name);            /* so the next device you sign in on knows it; a refusal stays marked for pullName */
    return name;
  }

  /* BOTH frames. This checked only game-frame, so with agar.io running the
     lobby did not think it was in a game: its animations were never paused and
     kept painting on the same main thread the game renders on. That is what
     was costing agar its frame rate. */
  const FRAMES = ['game-frame', 'agar-frame'];
  const shown = () => FRAMES.map(el).filter(f => f && f.style.display === 'block');
  function inGame() { return shown().length > 0; }

  /* slither.io's page (/sl) is laid out at 0.7 on a phone, as slither.io's own is (public/sl.html's viewport line),
     and its HUD is sized for that. A frame ignores a viewport line, so in this frame the page was at 1 and its
     minimap, buttons and boxes came out 1/0.7 too big (Owen 2026-10-16: "way too big on mobile"; he picked slither's
     size). On a phone (their is_mobile: a user agent that says Mobile, public/js/sl/slMain.js:59) the frame is laid
     out 1/0.7 as big and drawn at 0.7 (v2.html #game-frame.sl07), which is what the viewport line does on a page of
     its own. The game's canvas has a fixed backing size (public/js/sl/slPage.js resize), so this changes the HUD's
     size only, never the view or the cost. Watched on src, so every way /sl opens (Free, the event, Spectate, a paid
     seat from the wallet widget) is drawn small before it lays out, and no other page in this frame is. */
  function slScale() {
    const f = el('game-frame');
    if (!f || typeof MutationObserver !== 'function') return;
    const ua = typeof navigator !== 'undefined' && navigator ? navigator.userAgent : '';
    const phone = String(ua || '').toLowerCase().indexOf('mobile') >= 0;
    const apply = () => {
      let sl = false;
      try { sl = phone && new URL(f.getAttribute('src') || '', location.href).pathname === '/sl'; } catch (_) { sl = false; }
      if (f.classList) f.classList.toggle('sl07', sl);
    };
    new MutationObserver(apply).observe(f, { attributes: true, attributeFilter: ['src'] });
    apply();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', slScale, { once: true });
  else slScale();

  /* The one door. Everything else here funnels into this.
     `sel` names the room: { stake } for a rung of the ladder, or { lobbyType }
     for one of the old fixed tiers. */
  function launch(game, sel) {
    if (inGame()) return;
    /* A Play is never a watch: a watch mark left by a page that never booted
       goes before anything else (spectate below). */
    try { sessionStorage.removeItem('dsWatch'); sessionStorage.removeItem('dsWatchStake'); } catch (_) {}
    /* The last gate, not the only one: an unbuilt game hides its Play button
       and its buy-ins. This is here because those are presentation, and a room
       that does not exist must not be stakeable through a stale handler, a
       console call, or the next bug that shows a control it should not. */
    if (window.V2_IS_SOON && window.V2_IS_SOON(game)) {
      say('That game is not playable yet.');
      return;
    }
    const hasStake = sel && sel.stake !== undefined && sel.stake !== null;
    const hasTier = sel && !!sel.lobbyType;
    /* Never dispatch without naming the room. The widget used to default a
       missing lobbyType to the old ten cent tier, so an unnamed launch charged
       for a room the player did not choose (the widget refuses one now too,
       BACKLOG 2.1). Refuse here first: a room we cannot name is a room we must
       not stake into. */
    if (!hasStake && !hasTier) {
      say('That lobby is not available right now. Refresh and try again.');
      return;
    }
    /* agar.io has no tier rooms: its rooms are rungs (Free, $0.50, $1.00,
       PAID-AGAR-DESIGN.md 7), so a tier name other than the free one names a
       room that does not exist, and the widget would quote that tier's price
       for it. Refused before any money is asked for. */
    if (game === 'agar' && !hasStake && sel.lobbyType !== 'free') {
      say('That Agar.io table does not exist. Pick a buy-in on the card.');
      return;
    }
    /* A paid agar.io rung goes on to the widget like Paper's, but only while
       the board lists that rung's room as open (V2Board.playableStakes: a row
       on /api/live whose state is missing or 'open'). With AG_PAID off the
       server lists no paid agar row, and under the owner's agar:paid:off the
       rows say 'closed', so a console call, a stale handler, or a detail screen
       left open across the switch asks for no money for a room that cannot
       seat it. No board yet (or it failed) is refused too: a paid seat is
       never guessed. The paid door still refunds a stake that reaches it
       while it is shut; this only stops the wallet prompt and the round trip.
       Paper keeps its own rule (lobby-rungs review fix). */
    if (game === 'agar' && hasStake && Number(sel.stake) > 0) {
      let open = false;
      try {
        const want = Number(sel.stake);
        open = !!(window.V2Board && typeof window.V2Board.playableStakes === 'function'
          && Array.from(window.V2Board.playableStakes('agar')).some(s => Math.abs(s - want) < 1e-9));
      } catch (_) { open = false; }
      if (!open) {
        say('That Agar.io buy-in is not open right now. Pick one the card is offering.');
        return;
      }
    }
    /* A paid slither.io rung is seated by one of two engines while the swap
       is live (PAID-SL-DESIGN.md 2): the new one's paid rooms ('sl:' rows) or
       the old one's ('snake:' rows). Which one is the board's call, made here
       from the board itself and never from the row this was handed:
       playChosen takes the FIRST row at the stake, and an old room still
       finishing its players is listed 'closed' ahead of the open sl row
       (/api/live puts liveBoard's rows first). One snake row per paid stake
       is open in any one answer (critic C-3), by board.js's own isOpen rule.
       With none (no board yet, a failed poll, or that rung shut) the wallet
       is never asked, as for agar.io above. */
    let engine = null;
    if (game === 'snake' && hasStake && Number(sel.stake) > 0) {
      const row = openSnakeRow(Number(sel.stake));
      if (!row) {
        say('That Slither.io buy-in is not open right now. Pick one the card is offering.');
        return;
      }
      if (String(row.id || '').indexOf('sl:') === 0) engine = 'sl';
    }
    if (!connected()) {
      say('Sign in first — your wallet is your account here.');
      if (window.duelWalletLogin) window.duelWalletLogin();
      return;
    }
    const name = requireName();
    if (!name) return;
    say('');

    /* Games with their own page and no stake are launched here rather than
       through the wallet widget. The widget's job is money: it quotes a stake,
       signs a transfer and mints an entry token. Tanks has none of those — it
       is free while the mode is new — so routing it through that path would be
       asking the money layer to handle a game that never touches money.

       Everything else still goes through the widget exactly as before.

       Paper and agar.io are deliberately NOT on this list. Their rooms are on
       the server and all three rungs, Free included, go through the widget:
       stake 0 costs nothing there (an empty token) and every launch writes
       the whole hand-off the page reads, so a Free seat can never open on a
       token or a stake left over from an earlier paid one. */
    const OWN_PAGE = { tanks: '/tanks', omgshooter: '/shooter', knockout: '/knockout', battleship: '/battleship' };
    /* A PAID SEAT NEVER TAKES THIS SHORTCUT. The shortcut exists for games with
       no money in them; routing a real buy-in down it would open the table with
       no stake taken and no entry token, which the server would then refuse.
       Knockout is the first game that is on both sides of this line, so the
       test is the amount rather than the game. */
    const staking = hasStake && Number(sel.stake) > 0;
    /* slither.io's Free is the new engine on its own page, /sl (SERVER-DESIGN
       16.2, Phase 6), whenever the board's free snake row is the new room's
       ('sl:' id). With no board yet (a cold start) /sl is still the most likely
       open room; if it is shut, its closed page sends the player back to a
       board that lists the old free room again. Paid snake never comes here. */
    /* The nightly battle royale runs on the same engine as Free whenever /api/live says so (br.engine 'sl', the
       owner's br:engine switch): /sl with the event mark (public/js/slx/slxBr.js). Otherwise the old /game.html
       through the widget, as before. */
    /* Before the Events tab's first /api/live answer the engine is unknown: ask again rather than guess the old one. */
    if (game === 'snake' && !hasStake && sel && sel.lobbyType === 'br' && brEngine() === null) {
      say('One moment, loading the event.');
      if (window.V2Event && typeof window.V2Event.pull === 'function') window.V2Event.pull(true);
      return;
    }
    const brPage = game === 'snake' && !hasStake && sel && sel.lobbyType === 'br' && brOnSl();
    const page = brPage || (game === 'snake' && hasStake && Number(sel.stake) === 0 && slFree())
      ? '/sl' : OWN_PAGE[game];
    if (page && !staking) {
      /* Remember Free as well. defaultStep() already treats 0 as a real rung
         ("including 0: free is a real choice"), but nothing ever WROTE it —
         this path returned before the remember below — so playing a free table
         and coming back landed you on the cheapest paid one instead of where
         you left off. */
      if (hasStake && window.rememberStake) window.rememberStake(Number(sel.stake));
      try { sessionStorage.setItem('playerName', name); } catch (_) {}
      /* A Free /sl page is never a paid one. /sl reads the paid hand-off
         from this tab's sessionStorage (public/js/slx/slxPaid.js), and a paid
         launch whose page never loaded, or an old-engine one, leaves a token,
         a stake and maybe the one-shot slPaidLaunch mark behind; a reload
         mark (slxPaidCut) would hold the free page too. All of it goes before
         the page loads, so a stale token plus a Free click is a free page. */
      if (page === '/sl') {
        for (const k of ['entryToken', 'entrySol', 'stake', 'slPaidLaunch', 'slxPaidCut', 'slBr']) {
          try { sessionStorage.removeItem(k); } catch (_) {}
        }
        if (brPage) { try { sessionStorage.setItem('slBr', 'play'); } catch (_) {} }
      }
      const frame = document.getElementById('game-frame');
      if (!frame) { say('That game could not be opened. Refresh and try again.'); return; }
      if (window.phEvent) window.phEvent('game_started', { game: game, lobbyType: brPage ? 'br' : 'free' });
      /* The keyboard goes to the game: the frame takes the focus once it loads (and again a moment later), as the
         widget's launch does (wallet-widget/src/main.jsx), else Space and Q land on this page's Play button under
         the frame and never reach the game. The button lets go of the focus now, so Space cannot press it again. */
      if (typeof frame.addEventListener === 'function') {
        frame.addEventListener('load', () => {
          const take = () => { try { frame.contentWindow.focus(); } catch (_) {} };
          take();
          setTimeout(take, 150);
        }, { once: true });
      }
      try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (_) {}
      frame.src = page;
      frame.style.display = 'block';
      document.body.classList.add('playing');
      return;
    }
    const detail = hasStake
      ? { game: game, stake: Number(sel.stake) }
      : { game: game, lobbyType: sel.lobbyType };
    /* The widget stakes an 'sl' rung on this origin and opens /sl with it;
       with no engine named it opens the old /game.html exactly as before. */
    if (engine) detail.engine = engine;
    /* Remembered at launch, not at selection, so the buy-in that comes back
       tomorrow is one actually played rather than one idly scrolled past. */
    if (hasStake && window.rememberStake) window.rememberStake(Number(sel.stake));
    if (window.phEvent) window.phEvent('game_started', detail);
    /* The widget stakes if the room is paid, then launches. It owns the money;
       this only says which room. Exactly one of stake and lobbyType is sent, so
       the server never has to guess which the player meant. */
    window.dispatchEvent(new CustomEvent('duel:play', { detail: detail }));
  }

  /* Does the nightly event run on the new engine? The Events tab's last /api/live says (br.engine). */
  /* 'sl', 'old', or null while the Events tab has not heard yet. A page with no Events tab script is the old path,
     as before this engine existed. */
  function brEngine() {
    if (!window.V2Event || typeof window.V2Event.engine !== 'function') return 'old';
    return window.V2Event.engine();
  }
  function brOnSl() { return brEngine() === 'sl'; }

  /* Is the lobby's free snake the new slither.io room? Yes when the board's
     stake 0 snake row has an 'sl:' id, and when there is no board at all. */
  function slFree() {
    const rows = (window.V2Board && window.V2Board.lobbies) || [];
    const free = rows.filter(l => l && l.game === 'snake' && Number(l.stake) === 0);
    if (!free.length) return true;
    return free.some(l => String(l.id || '').indexOf('sl:') === 0);
  }

  /* The snake row that takes new players at this paid stake, or null. Open
     is board.js's rule (isOpen): a missing state counts as open. */
  function openSnakeRow(stake) {
    const rows = (window.V2Board && window.V2Board.lobbies) || [];
    const open = l => l.state === undefined || l.state === null || l.state === 'open';
    return rows.find(l => l && l.game === 'snake' && Math.abs(Number(l.stake) - stake) < 1e-9 && open(l)) || null;
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
    /* NO ROWS IS NOT THE SAME FACT AS NO LADDER, and reading one as the other
       put real players in the wrong room.

       `rows` is empty whenever /api/live failed OR has simply not come back
       yet — V2Board.start() is the last call in the init line and the game
       cards are clickable before it, so an ordinary cold start reaches here —
       and once the player is on the detail screen the board's poll is gated on
       the home screen, so an empty list never heals itself.

       The same empty list ALSO forces the buy-in control down to Free: every
       rung gets struck out, si collapses and defaultStep returns 0. So
       `!rows.length && !stake` fires together, and a laddered game fell
       through to the fixed tier every single time the board hiccuped.

       For snake that tier is `na_free`, which is NOT where anybody else is
       playing — it is exactly the two-rooms-both-called-Free split the detail
       screen's Enter button was already fixed for, still live on this line.

       So ask the catalogue which games are priced in rungs instead of asking
       how many rows happen to have loaded. Free IS a rung for those, and the
       server opens the stake-0 room at boot, so it is a valid door even when
       the board has said nothing at all (agar.io and Paper are ladder games
       too now). A game with no ladder still opens on the fixed free tier,
       which is the room it actually uses. The !stake guard stays: neither
       branch can reach a paid room, so neither can stake anything. */
    if (!rows.length && !stake) {
      const onLadder = typeof window.V2_HAS_LADDER === 'function'
        && window.V2_HAS_LADDER(game);
      launch(game, onLadder ? { stake: 0 } : { lobbyType: 'free' });
      return;
    }
    say('No room at that buy-in. Pick one the board is offering.');
  }

  /* Watching a free room, in every game (Owen 2026-10-15). Nothing here can
     seat anybody or stake anything: no token, no stake, and every money key a
     page could read is taken out first.

     The games on the new pages read one mark, WATCH_KEY = the game's id. Each
     page takes it out as it boots (so a reload, or the next Play, is a plain
     page) and goes into watching only when the mark names it; launch() takes
     it out too, before any Play, so a mark left by a page that never loaded
     cannot turn a Play into watching. agar.io and the old snake engine keep
     their own flag, spectateOnly, which their pages already read. */
  const WATCH_KEY = 'dsWatch';
  const WATCH_PAGE = { snake: '/sl', paper: '/paper-arena', knockout: '/knockout', battleship: '/battleship' };
  const MONEY_KEYS = ['entryToken', 'entrySol', 'stake', 'slPaidLaunch', 'slxPaidCut', 'slBr', 'spectateOnly'];
  /* The paid rung a Spectate watches (Owen, 2026-10-15: Spectate on $0.50 and
     $1 too). Its own key, never 'stake': a page reads 'stake' as a buy-in. Every
     page takes it out at boot; a Play clears it with the watch mark. */
  const WATCH_STAKE_KEY = 'dsWatchStake';
  /* Is somebody playing at that paid rung? From the board. No board row is a
     no. Only the table games ask (Knockout, Battleship: nothing to show but a
     table); the arena games open their watch page anyway, which shows the
     whole map until somebody joins (Owen 2026-10-16, dsEmptyArena.js). */
  const ARENA_GAMES = { snake: true, agar: true, paper: true };
  function paidRungBusy(game, stake) {
    const rows = (window.V2Board && window.V2Board.lobbies) || [];
    return rows.some(l => l && l.game === game && Math.abs(Number(l.stake) - stake) < 1e-9 && (l.players || 0) > 0);
  }
  function spectate(game, lobbyType, stake) {
    if (inGame()) return;
    if (window.V2_IS_SOON && window.V2_IS_SOON(game)) return;
    const paidStake = !lobbyType && Number(stake) > 0 ? Number(stake) : 0;
    if (paidStake) {
      /* Read only on every engine: never a seat, never money, and a watcher is
         shown what the player it follows is shown (the server's watch paths). */
      if (!ARENA_GAMES[game] && !paidRungBusy(game, paidStake)) {
        toast('Nobody is playing at $' + paidStake.toFixed(2) + ' right now.');
        return;
      }
      if (game === 'snake') {
        const row = openSnakeRow(paidStake);
        if (!row || String(row.id || '').indexOf('sl:') !== 0) {
          toast('That table cannot be watched right now.');
          return;
        }
      }
    }
    /* The free snake room on the new engine (/sl), unless the board says the
       free room is still the old one; the event has its own path below. A paid
       snake rung is always the new engine here (checked above). */
    const page = game === 'snake' && !paidStake && (lobbyType || !slFree()) ? null : WATCH_PAGE[game];
    if (page) {
      try {
        for (const k of MONEY_KEYS) sessionStorage.removeItem(k);
        sessionStorage.setItem(WATCH_KEY, game);
        if (paidStake) sessionStorage.setItem(WATCH_STAKE_KEY, String(paidStake));
        else sessionStorage.removeItem(WATCH_STAKE_KEY);
        sessionStorage.setItem('region', region());
      } catch (_) {}
      show(page, game);
      return;
    }
    try {
      /* No money key survives into a watch page here either: a stale token
         would make /ag a paid hand-off rather than a watcher. */
      for (const k of MONEY_KEYS) sessionStorage.removeItem(k);
      sessionStorage.removeItem(WATCH_KEY);
      if (paidStake) sessionStorage.setItem(WATCH_STAKE_KEY, String(paidStake));   // agar.io's paid rung
      else sessionStorage.removeItem(WATCH_STAKE_KEY);
      sessionStorage.setItem('spectateOnly', 'true');
      sessionStorage.setItem('region', region());
      /* Which ROOM to watch. Without this the viewer lands in whatever free
         room the last session happened to leave behind, which for the nightly
         event is the one place the match is definitely not happening. */
      if (lobbyType) {
        sessionStorage.setItem('lobbyType', lobbyType);
        sessionStorage.removeItem('stake');
      } else if (game === 'snake') {
        /* The old engine's free room is the ladder's Free rung (snake:na:s0), the room Free Play reaches by
           stake 0 (launch() sends { stake: 0 } through the widget). With no stake /game.html falls back to
           lobbyType 'free', the off-board fixed tier, and the viewer watched an empty world. */
        sessionStorage.removeItem('lobbyType');
        sessionStorage.setItem('stake', '0');
      } else {
        sessionStorage.removeItem('stake');
      }
    } catch (_) {}
    /* Both pages read spectateOnly. agar.io's has no menu card inside this
       lobby any more (Owen 2026-10-09), so it is the flag that opens it
       straight into watching (public/js/ag/agLobby.js); the widget clears it
       on every launch, so a Play never lands as a watcher. */
    show(game === 'agar' ? '/ag' : '/game.html', game);
  }

  /* The nightly event is a battle royale in the `br` room. */
  function spectateEvent() {
    if (brEngine() === null) {
      say('One moment, loading the event.');
      if (window.V2Event && typeof window.V2Event.pull === 'function') window.V2Event.pull(true);
      return;
    }
    if (!brOnSl()) { spectate('snake', 'br'); return; }
    /* On the new engine: /sl as a watcher of the event (public/js/slx/slxBr.js). */
    if (inGame()) return;
    try {
      for (const k of ['entryToken', 'entrySol', 'stake', 'slPaidLaunch', 'slxPaidCut', 'spectateOnly', WATCH_KEY]) sessionStorage.removeItem(k);
      sessionStorage.setItem('slBr', 'watch');
    } catch (_) {}
    show('/sl', 'snake');
  }

  /* The frame is chosen by the game, not by looking for "agar" in the address:
     agar.io's page is /ag now, which that test no longer matched. */
  function show(src, game) {
    const f = el(game === 'agar' ? 'agar-frame' : 'game-frame');
    if (!f) return;
    if (window._pauseLobbyAnims) window._pauseLobbyAnims();
    f.src = src;
    f.style.display = 'block';
  }

  /* SIGNING ON BEHALF OF THE FRAME.

     The wallet widget is mounted out here, not inside the game iframe, so the
     game cannot call duelWalletSignAction itself. It asks, and this answers —
     the same shape as the restake bridge above it.

     This exists because the in-game owner controls had no way to produce a
     signature and were reaching for localStorage.duel_admin_token instead, a
     Privy token on the auth route that ownerAuth.js documents as broken. The
     signature never leaves the wallet's own approval flow, and the server is
     what decides whether the wallet that signed is an owner. */
  /* Only the game frame may ask, and only from our own origin: any other window
     holding a reference to the lobby (an opener, a page that frames it) could
     otherwise have the wallet sign an owner action without a prompt. The answer
     goes to our own origin only, so a frame that navigated elsewhere never gets it. */
  window.addEventListener('message', async e => {
    const d = e.data;
    if (!d || d.type !== 'duel:signaction') return;
    const frame = el('game-frame');
    const origin = window.location && window.location.origin;
    if (!frame || !frame.contentWindow || e.source !== frame.contentWindow) return;
    if (!origin || e.origin !== origin) return;
    const reply = (msg) => {
      if (frame.contentWindow) frame.contentWindow.postMessage(msg, origin);
    };
    if (typeof window.duelWalletSignAction !== 'function') {
      reply({ type: 'duel:signaction:error', id: d.id,
              message: 'The wallet has not loaded yet. Give it a moment.' });
      return;
    }
    try {
      /* Raced against a clock, for the same reason owner.html races it: a
         promise from the SDK that never settles is a button that never comes
         back, which from the outside is a dead control. */
      const proof = await Promise.race([
        window.duelWalletSignAction(d.action, d.args || {}),
        new Promise((_, no) =>
          setTimeout(() => no(new Error('the wallet did not answer')), 10000)),
      ]);
      reply({ type: 'duel:signaction:done', id: d.id, proof: proof || null });
    } catch (err) {
      reply({ type: 'duel:signaction:error', id: d.id,
              message: 'Could not sign: ' + (err && err.message ? err.message : 'unknown') });
    }
  });

  /* The game signals its own exit. Both frames are cleared and the lobby's
     animations restart. */
  window.addEventListener('message', e => {
    if (e.data !== 'game:done') return;
    // From one of our game frames, on our own origin: nobody else closes the game.
    const origin = window.location && window.location.origin;
    if (!origin || e.origin !== origin) return;
    if (!FRAMES.some(id => { const f = el(id); return !!f && !!f.contentWindow && e.source === f.contentWindow; })) return;
    FRAMES.forEach(id => { const f = el(id); if (f) { f.style.display = 'none'; f.src = ''; } });
    if (window._resumeLobbyAnims) window._resumeLobbyAnims();
    if (window.V2Board) window.V2Board.load();
    if (window.duelWalletRefresh) window.duelWalletRefresh();
  });

  /* A paid snake left by a page that closed (PAID-SL-DESIGN.md 9, the reload
     mark). The /sl page writes slxPaidCut to this tab's sessionStorage on its
     way out with money in ('1') or with an entry it never sent ('2'), but it
     reads the mark back only when the frame alone reloads. A reload or reopen of
     the whole tab lands HERE, with no /sl page in the frame, so the lobby says
     it once and takes the mark (review CLIENT-1). */
  const CUT_KEY = 'slxPaidCut';
  const CUT_TEXT = {
    '1': 'Your paid snake was left when the page closed. Like any lost connection, it glided for 3 seconds, then ' +
         'its money dropped as gold. If it never reached a room, your entry is refunded automatically.',
    '2': 'The page closed before your paid game started. An entry that was never used goes back to your wallet ' +
         'automatically within a few minutes.',
  };
  function paidLeftNotice() {
    let mark = null;
    try {
      mark = sessionStorage.getItem(CUT_KEY);
      sessionStorage.removeItem(CUT_KEY);
    } catch (_) { return false; }
    if (mark === null) return false;
    toast(CUT_TEXT[mark === '2' ? '2' : '1']);
    return true;
  }

  /* Leaving asks first while the frame holds a paid snake with money in (design
     9, the exit trap; review CLIENT-2). The /sl page asks too. Chrome (measured
     in the page proof) shows that ask once the tab has had any real click or
     key, the Play click on this page included; a browser that counts only input
     in the frame that asks would stay silent for a player who steers with the
     mouse alone, so this page asks as well. With no real input at all no
     browser asks, and the reload mark above says it on the lobby instead. Read
     from the same-origin frame at the moment of leaving, never kept. */
  function paidFrameLocked() {
    const f = el('game-frame');
    if (!f || f.style.display !== 'block') return false;
    try {
      const w = f.contentWindow;
      const p = w && w.DuelSlither && w.DuelSlither.slx && w.DuelSlither.slx.paid;
      return !!(p && p.on === true && typeof p.state === 'function' && p.state().locked === true);
    } catch (_) { return false; }
  }
  window.addEventListener('beforeunload', e => {
    if (!paidFrameLocked()) return undefined;
    e.preventDefault();
    e.returnValue = '';
    return '';
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
    paidLeftNotice();
  });

  window.V2Play = { enter: enter, playChosen: playChosen, spectate: spectate,
                    spectateEvent: spectateEvent,
                    launch: launch, savedName: savedName, cleanName: cleanName, typedName: typedName,
                    nameAction: nameAction, nameEdit: nameEdit, pullName: pullName,
                    toast: toast, toastOk: toastOk,
                    paidLeftNotice: paidLeftNotice, paidFrameLocked: paidFrameLocked,
                    pushName: pushName,
                    nameWhy: r => WHY[r] || 'Could not save your name. Try again in a moment.' };

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
