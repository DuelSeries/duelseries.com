// The DuelSeries lobby around the agar.io page (CHOSEN, ours; not a parity area). public/ag.html loads it after
// agMain.js. It never touches the canvas, the world or the menu card's own controls; it only adds what the
// lobby needs around them:
//
// 1. A Lobby button, when the page runs inside the lobby's frame. It posts 'game:done' to the lobby, the message
//    every DuelSeries game page sends to go back (public/js/v2/play.js clears the frame on it, which closes this
//    page's socket, and the server removes the player at once). It shows while the menu is open (the name entry,
//    the Esc menu over a running game, the Match Results panel) and, on a touch screen, all the time, because a
//    phone has no Esc key to bring the menu up mid-game. Opened on its own (not framed), there is no lobby to go
//    back to, so there is no button.
// 2. The name box starts with the player's lobby name (the hand-off the wallet widget writes before it opens this
//    page, else the name the lobby keeps), cut to the box's own 15 characters. A name already typed is kept.
// 3. No walking out with money in the room (PAID-AGAR-DESIGN.md 4 step 7 and 6, the exit trap). game:done blanks
//    the frame, which drops the socket, and a paid account left that way sits frozen and edible for 3 minutes before
//    its automatic cash-out (Owen Q5). So from the moment this page has a paid account open (the server's ag:joined
//    with a stake) until this page holds it no more, the Lobby button is hidden and refuses a click, the menu shows
//    how to leave instead ("Hold Q to cash out", or the Cash out button on a touch screen), and closing or
//    reloading the tab asks first. The paid end card's own Back to lobby goes through the same gate (agMain's
//    backToLobby calls cfg.onLobby when it is set). The free room never sends ag:joined with a stake, so nothing
//    here changes it. The page holds the account no more when the server says so: it closed (ag:cashedout, ag:dead,
//    ag:closed), its seat was released and refunded before it was confirmed (ag:refused with closed: true,
//    server/ag/agRoom.js _paidClosed), or another tab took it over (ag:replaced, agRoom resumePaid; that tab locks
//    itself). And when its socket drops (agMain's 'disconnect' hook) the seat is the server's dropped seat (5 s
//    grace, then frozen and auto cashed out, Owen Q5, or refunded by a restart, Owen Q6), so the page lets go
//    DROP_MS after the drop unless it took the seat back first (a new ag:joined with a stake). A blip that resumes
//    in time never shows the button, and a crashed server never leaves the page locked.
// 4. The paid hand-off's own lock (agPaid.js, the 'paid:lock' hook): the same gate while an entry token is on its
//    way to the door and while a Play again buy-in is with the lobby's wallet (Paper's lockLobby). agPaid lets go on
//    every answer and after its own give-up timers, so it never leaves the page locked either.
// 5. The free room in the lobby's frame (Owen 2026-10-09 midday: agMain's cfg.lobby, set by public/ag.html when its
//    frame is the lobby's #agar-frame, and no paid hand-off): the page has no menu card, so this starts it at once,
//    playing under the lobby name, or watching when the lobby's Spectate opened it (sessionStorage spectateOnly,
//    the lobby's own watch flag, which public/js/v2/play.js sets and the wallet widget clears on every launch). The
//    Lobby button then shows all the time except over the Match Results panel, which has its own Lobby button, so a
//    mouse player and a watcher (no Esc menu any more) always have one way back. A paid hand-off keeps 1 to 4 as
//    they are.
(function (root) {
  'use strict';

  var doc = root.document;
  if (!doc) return;

  var NICK_MAX = 15;   // the name box's own cap (agScreens LAYOUT.nickMax, law L37's client half)
  // What the menu says in the Lobby button's place while money is in the room (CHOSEN, PARITY-LOG 2026-10-09
  // lobby-rungs): the leave rule of Owen 2026-10-08 (hold Q 3 s, or the phone's Cash out button held).
  var HINT_KEYS = 'Hold Q to cash out';
  var HINT_TOUCH = 'Hold Cash out to leave';

  // How long after a socket drop the page still holds the lock (see 3 above): DISCONNECT_GRACE_MS, the server's own
  // grace for a dropped paid seat (PAID-AGAR-DESIGN.md 3.5, Paper's value). Using it for this page timer is CHOSEN
  // (PARITY-LOG 2026-10-09 lobby-rungs review fixes).
  var DROP_MS = 5000;

  // Money in the room: a paid account is open on this page (see 3 above).
  var moneyIn = false;
  // The paid hand-off's own lock (agPaid through agMain's 'paid:lock' hook and session.paidLocked): an entry token on
  // its way to the door, or a Play again buy-in with the lobby's wallet. A token in flight may already be money in a
  // seat, and a buy-in answered after game:done would land in a blank frame, so the way out stays shut for both.
  var pageLock = false;
  function locked() { return moneyIn || pageLock; }
  var dropTimer = null;
  var sync = function () {};
  function clearDrop() {
    if (dropTimer === null) return;
    try { root.clearTimeout(dropTimer); } catch (e) { /* nothing to clear */ }
    dropTimer = null;
  }
  function setMoneyIn(on) {
    on = !!on;
    clearDrop();
    if (moneyIn === on) return;
    moneyIn = on;
    sync();
  }
  function onDrop() {
    if (!moneyIn || dropTimer !== null) return;
    if (typeof root.setTimeout !== 'function') { setMoneyIn(false); return; }
    dropTimer = root.setTimeout(function () { dropTimer = null; setMoneyIn(false); }, DROP_MS);
  }
  // The one way back to the lobby (the Lobby button and the paid end card's Back to lobby): never while money is in
  // the room.
  function goLobby() {
    if (locked()) return;
    try { root.parent.postMessage('game:done', '*'); } catch (err) { /* the lobby is gone; nothing to do */ }
  }
  // The browser shows its own "leave this site?" text; what a page asks it to say is ignored.
  function onBeforeUnload(e) {
    if (!locked()) return undefined;
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    if (e) e.returnValue = '';
    return '';
  }
  function watchMoney() {
    var page = root.duelAgar;
    if (!page || typeof page.onServer !== 'function') return;
    page.onServer('ag:joined', function (p) { if (p && Number(p.stake) > 0) setMoneyIn(true); });
    page.onServer('ag:cashedout', function (p) { if (!p || p.free !== true) setMoneyIn(false); });
    page.onServer('ag:dead', function () { setMoneyIn(false); });
    page.onServer('ag:closed', function () { setMoneyIn(false); });
    // Only a refusal that says the seat closed: 'cash-out-to-leave' and a refused second join leave it open.
    page.onServer('ag:refused', function (p) { if (p && p.closed === true) setMoneyIn(false); });
    page.onServer('ag:replaced', function () { setMoneyIn(false); });
    page.onServer('disconnect', onDrop);
    // The hand-off's lock: read once (agMain sets it at boot, before this script runs) and followed from then on.
    pageLock = typeof page.paidLocked === 'function' && page.paidLocked() === true;
    sync();
    page.onServer('paid:lock', function (p) {
      var on = !!(p && p.on === true);
      if (on === pageLock) return;
      pageLock = on;
      sync();
    });
    // The paid end card's Back to lobby (agMain backToLobby calls cfg.onLobby when it is set): the same gate. Framed
    // only; a page opened on its own keeps agMain's own handling (close the card, open the menu).
    var cfg = page.config;
    if (framed() && cfg && typeof cfg === 'object') {
      var own = typeof cfg.onLobby === 'function' ? cfg.onLobby : null;
      cfg.onLobby = function () {
        if (locked()) return;
        if (own) own(); else goLobby();
      };
    }
    if (typeof root.addEventListener === 'function') root.addEventListener('beforeunload', onBeforeUnload);
  }

  function framed() {
    try { return root.parent && root.parent !== root; } catch (e) { return true; }
  }

  function read(store, key) {
    try { return (store && store.getItem(key)) || ''; } catch (e) { return ''; }
  }

  function lobbyName() {
    var n = read(root.sessionStorage, 'playerName') || read(root.localStorage, 'duelseries_playername');
    return String(n).trim().slice(0, NICK_MAX);
  }

  function prefillNick() {
    var box = doc.getElementById('ag-nick');
    if (!box || box.value) return;
    var name = lobbyName();
    if (name) box.value = name;
  }

  // The free room inside the lobby's frame (see 5 above): agMain's lobby config, and no paid account on the page.
  function lobbyFree() {
    var page = root.duelAgar;
    if (!page || !page.config || page.config.lobby !== true || !framed()) return false;
    var st = null;
    try { st = typeof page.state === 'function' ? page.state() : null; } catch (e) { st = null; }
    return !!st && st.paid !== true && !st.handoff && !moneyIn && !pageLock;
  }
  function startFromLobby() {
    if (!lobbyFree()) return;
    var page = root.duelAgar;
    if (read(root.sessionStorage, 'spectateOnly') === 'true') {
      if (typeof page.spectate === 'function') page.spectate();
      return;
    }
    if (typeof page.play === 'function') page.play(lobbyName());
  }

  var CSS = [
    '#ag-lobby{position:fixed;left:16px;top:16px;z-index:30;display:none;align-items:center;gap:6px;',
    'box-sizing:border-box;height:36px;margin:0;padding:0 14px 0 10px;border:1px solid #d6cdbd;border-radius:8px;',
    'background:#f5f1e8;color:#100e0b;font:700 14px Arial,sans-serif;letter-spacing:0.02em;cursor:pointer;',
    'touch-action:manipulation;user-select:none;-webkit-user-select:none;}',
    '#ag-lobby:hover{background:#fff;}',
    '#ag-lobby:focus-visible{outline:2px solid #100e0b;outline-offset:2px;}',
    '#ag-lobby.on{display:inline-flex;}',
    '#ag-lobby svg{width:16px;height:16px;flex:none;}',
    // The hint in the button's place: the same chip, not a control (CHOSEN, PARITY-LOG 2026-10-09 lobby-rungs).
    '#ag-lobby-hint{position:fixed;left:16px;top:16px;z-index:30;display:none;align-items:center;',
    'box-sizing:border-box;height:36px;margin:0;padding:0 14px;border:1px solid #d6cdbd;border-radius:8px;',
    'background:#f5f1e8;color:#100e0b;font:700 14px Arial,sans-serif;letter-spacing:0.02em;pointer-events:none;',
    'user-select:none;-webkit-user-select:none;}',
    '#ag-lobby-hint.on{display:inline-flex;}'
  ].join('');

  function addLobbyButton() {
    if (!framed() || doc.getElementById('ag-lobby')) return;
    var style = doc.createElement('style');
    style.id = 'ag-lobby-css';
    style.textContent = CSS;
    (doc.head || doc.body).appendChild(style);

    var btn = doc.createElement('button');
    btn.id = 'ag-lobby';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Back to the lobby');
    btn.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>Lobby';
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      goLobby();   // refused while money is in the room; the button is hidden then too (3 above)
    });
    doc.body.appendChild(btn);

    var hint = doc.createElement('div');
    hint.id = 'ag-lobby-hint';
    hint.setAttribute('role', 'status');
    doc.body.appendChild(hint);

    var coarse = null;
    try { coarse = root.matchMedia ? root.matchMedia('(pointer: coarse)') : null; } catch (e) { coarse = null; }
    sync = function () {
      var menu = doc.getElementById('ag-menu');
      var menuOpen = !!menu && !menu.hidden;
      var touch = !!(coarse && coarse.matches);
      // The lobby frame's free room (5 above): always, except over the Match Results panel and its own Lobby button.
      var shown = lobbyFree() ? !menuOpen : (menuOpen || touch);
      btn.classList.toggle('on', !locked() && shown);
      var text = moneyIn && menuOpen ? (touch ? HINT_TOUCH : HINT_KEYS) : '';
      if (hint.textContent !== text) hint.textContent = text;
      hint.classList.toggle('on', text !== '');
    };
    sync();
    var menu = doc.getElementById('ag-menu');
    if (menu && typeof root.MutationObserver === 'function') {
      new root.MutationObserver(sync).observe(menu, { attributes: true, attributeFilter: ['hidden'] });
    }
    if (coarse) {
      if (typeof coarse.addEventListener === 'function') coarse.addEventListener('change', sync);
      else if (typeof coarse.addListener === 'function') coarse.addListener(sync);
    }
  }

  // agMain boots on DOMContentLoaded too and was loaded first, so its menu exists by the time this runs.
  function start() {
    prefillNick();
    addLobbyButton();
    watchMoney();
    startFromLobby();
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start);
  else start();
})(typeof window !== 'undefined' ? window : globalThis);
