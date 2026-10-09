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
//    with a stake) until the server says it closed (ag:cashedout, ag:dead or ag:closed), the Lobby button is hidden
//    and refuses a click, the menu shows how to leave instead ("Hold Q to cash out", or the Cash out button on a
//    touch screen), and closing or reloading the tab asks first. The free room never sends ag:joined with a stake,
//    so nothing here changes it.
(function (root) {
  'use strict';

  var doc = root.document;
  if (!doc) return;

  var NICK_MAX = 15;   // the name box's own cap (agScreens LAYOUT.nickMax, law L37's client half)
  // What the menu says in the Lobby button's place while money is in the room (CHOSEN, PARITY-LOG 2026-10-09
  // lobby-rungs): the leave rule of Owen 2026-10-08 (hold Q 3 s, or the phone's Cash out button held).
  var HINT_KEYS = 'Hold Q to cash out';
  var HINT_TOUCH = 'Hold Cash out to leave';

  // Money in the room: a paid account is open on this page (see 3 above).
  var moneyIn = false;
  var sync = function () {};
  function setMoneyIn(on) {
    on = !!on;
    if (moneyIn === on) return;
    moneyIn = on;
    sync();
  }
  // The browser shows its own "leave this site?" text; what a page asks it to say is ignored.
  function onBeforeUnload(e) {
    if (!moneyIn) return undefined;
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
      if (moneyIn) return;   // hidden then too; this is the belt to that brace (3 above)
      try { root.parent.postMessage('game:done', '*'); } catch (err) { /* the lobby is gone; nothing to do */ }
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
      btn.classList.toggle('on', !moneyIn && (menuOpen || touch));
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
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start);
  else start();
})(typeof window !== 'undefined' ? window : globalThis);
