// Phone portrait for the agar.io redo (ours: the reference page has no phone path). Owen's own
// design (2026-10-08, FIX-PLAN P4): a touch screen held upright first sees a plain "turn your
// phone sideways" card; if the player has not turned the phone after PROMPT_MS the card goes and
// the game plays in the portrait layout, the reference screen turned on its side (agCamera
// screenFactor and agHud hudScale with portrait set; the server sends the turned view box of the
// same area, ag:portrait). Turning the phone sideways at any time hides the card and gives the
// exact reference layout; turning it upright again goes straight to the portrait layout, with no
// card again for the rest of the tab session.
//
// agMain decides when the portrait layout applies (isPortrait below) and calls
// prompt.update(portrait) on every size check. This file only owns the card. Loaded by the
// shipped page only (public/ag.html); the parity harness never loads it.
(function (root) {
  'use strict';
  var A = root.DuelAgarLib = root.DuelAgarLib || {};

  // CHOSEN (Owen 2026-10-08: "after a few seconds"; PARITY-LOG 2026-10-09 P4): how long the card
  // stays up when the phone is not turned.
  var PROMPT_MS = 3000;
  // CHOSEN (PARITY-LOG 2026-10-09 P4): the card shows once per tab session, so coming back to the
  // game from the lobby in the same tab does not show it again. Per-viewer convenience only: no
  // storage (a private window) just means the card can show once per page load.
  var SEEN_KEY = 'agRotateSeen';

  // The portrait layout applies on a touch screen (coarse pointer) that is taller than wide. A
  // mouse screen of any shape keeps the reference layout, the parity harness's 390 x 844 included.
  function isPortrait(w, h, coarse) {
    return !!coarse && h > w;
  }

  // The card's look (CHOSEN, PARITY-LOG 2026-10-09 P4): the reference menu's plain style, a white
  // card with radius 10 and dark grey text (#343434) over a dimmed game, the title in Ubuntu Bold
  // (the face the page already loads), the phone icon in the reference's button blue (#428bca).
  // No touch-action of its own: it takes the page's (the effective value is the intersection with
  // its ancestors), none from ag.css, or pinch-zoom on html and body while the lobby around the
  // game is zoomed (agInput, FIX-PLAN P3), so a zoomed lobby can be pinched back over the card too.
  var PROMPT_CSS = [
    '#ag-rotate{position:fixed;left:0;top:0;right:0;bottom:0;z-index:40;align-items:center;justify-content:center;background:rgba(0,0,0,0.5);user-select:none;-webkit-user-select:none;}',
    '#ag-rotate .ag-rotate-card{box-sizing:border-box;width:260px;max-width:calc(100% - 32px);padding:20px 20px 18px;background:#fff;border-radius:10px;text-align:center;color:#343434;font-family:Arial,sans-serif;}',
    '#ag-rotate svg{display:block;width:64px;height:64px;margin:0 auto 10px;}',
    '#ag-rotate .ag-rotate-phone{transform-origin:32px 32px;animation:ag-rotate-turn 1.6s ease-in-out infinite;}',
    '#ag-rotate .ag-rotate-title{font-family:Ubuntu,Arial,sans-serif;font-weight:700;font-size:20px;line-height:24px;}',
    '#ag-rotate .ag-rotate-sub{margin-top:6px;font-size:14px;line-height:18px;color:#6b6b6b;}',
    '@keyframes ag-rotate-turn{0%,25%{transform:rotate(0deg);}55%,85%{transform:rotate(-90deg);}100%{transform:rotate(0deg);}}',
    '@media (prefers-reduced-motion: reduce){#ag-rotate .ag-rotate-phone{animation:none;transform:rotate(-90deg);}}'
  ].join('\n');

  var TEXT = { title: 'Turn your phone sideways', sub: 'agar.io plays best in landscape.' };

  var ICON = '<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">' +
    '<g class="ag-rotate-phone" fill="none" stroke="#428bca" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="21" y="13" width="22" height="38" rx="4"/><path d="M29 45h6"/></g>' +
    '<path d="M57 32A25 25 0 0 0 32 7" fill="none" stroke="#343434" stroke-width="2.5" stroke-linecap="round"/>' +
    '<path d="M32 7l5-4.5M32 7l5 4.5" fill="none" stroke="#343434" stroke-width="2.5" stroke-linecap="round"/>' +
    '</svg>';

  // opts: { doc, win, root (where the card goes; default body), storage (sessionStorage or null),
  //         injectCss (default true), pinchOk() (bool: the lobby around the game is pinch-zoomed
  //         now; agMain passes agInput.lobbyZoomed; default never) }
  // Returns { update(portrait), shown(), dispose(), el() }.
  function createRotatePrompt(opts) {
    opts = opts || {};
    var win = opts.win || root;
    var doc = opts.doc || win.document;
    var host = opts.root || (doc && doc.body);
    var storage = opts.storage || null;
    var pinchOk = typeof opts.pinchOk === 'function' ? opts.pinchOk : function () { return false; };
    var seen = readSeen();
    var el = null;
    var timer = null;
    var shown = false;

    function readSeen() {
      if (!storage) return false;
      try { return storage.getItem(SEEN_KEY) === '1'; } catch (e) { return false; }
    }
    function writeSeen() {
      if (!storage) return;
      try { storage.setItem(SEEN_KEY, '1'); } catch (e) { /* private window or full storage */ }
    }
    function build() {
      if (el || !doc || !host) return el;
      if (opts.injectCss !== false && doc.head && !doc.getElementById('ag-rotate-css')) {
        var style = doc.createElement('style');
        style.id = 'ag-rotate-css';
        style.textContent = PROMPT_CSS;
        doc.head.appendChild(style);
      }
      el = doc.createElement('div');
      el.id = 'ag-rotate';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      el.style.display = 'none';
      el.innerHTML = '<div class="ag-rotate-card">' + ICON + '<div class="ag-rotate-title">' + TEXT.title +
        '</div><div class="ag-rotate-sub">' + TEXT.sub + '</div></div>';
      // Taps on the card are eaten for its few seconds, so none reaches the menu or the game under it.
      // Except a pinch while the lobby around the game is zoomed (AFTER.md open item 3): Chrome drops
      // a whole pinch whose first touchstart was prevented (agInput, measured), so a touch that starts
      // while pinchOk() holds is left to the browser and a pinch-out over the card brings the lobby
      // back to 1, as over the canvas. Its one-finger tap is still eaten, at the touchend (no click,
      // so none reaches the menu if the card goes mid-tap). The first finger decides for the whole
      // touch: 'eat' (prevented, as before) or 'pinch' (left alone; 'multi' once two fingers are down).
      var eat = function (e) { if (e && e.cancelable && e.preventDefault) e.preventDefault(); if (e && e.stopPropagation) e.stopPropagation(); };
      // The card's own fingers are targetTouches (the touches that started on it; touches where a
      // browser has no targetTouches); a finger elsewhere still counts toward a pinch.
      var touch = null;
      var fingers = function (e, list, none) { var l = e && (list === 'all' ? e.touches : (e.targetTouches || e.touches)); return l ? l.length : none; };
      var onTouchStart = function (e) {
        if (touch === null || fingers(e, 'own', 1) <= 1) touch = pinchOk() ? 'pinch' : 'eat';
        if (touch === 'eat') { eat(e); return; }
        if (fingers(e, 'all', 1) >= 2) touch = 'multi';
        if (e && e.stopPropagation) e.stopPropagation();
      };
      var onTouchEnd = function (e) {
        if (touch === 'pinch' && e && e.cancelable && e.preventDefault) e.preventDefault();
        if (fingers(e, 'own', 0) === 0) touch = null;
      };
      if (typeof el.addEventListener === 'function') {
        el.addEventListener('touchstart', onTouchStart, { passive: false });
        el.addEventListener('touchend', onTouchEnd, { passive: false });
        el.addEventListener('touchcancel', onTouchEnd, { passive: false });
        el.addEventListener('pointerdown', eat);
      }
      host.appendChild(el);
      return el;
    }
    function clearTimer() {
      if (timer === null) return;
      if (typeof win.clearTimeout === 'function') win.clearTimeout(timer);
      timer = null;
    }
    function hide() {
      clearTimer();
      if (el) el.style.display = 'none';
      shown = false;
    }
    function show() {
      if (!build()) return;
      el.style.display = 'flex';
      shown = true;
      var mine = timer = win.setTimeout(function () { if (timer === mine) { timer = null; hide(); } }, PROMPT_MS);
    }

    return {
      // portrait: whether the portrait layout applies now. The first time it does in this tab
      // session the card shows for PROMPT_MS; a turn to landscape hides it at once; after that it
      // never shows again in the session.
      update: function (portrait) {
        if (!portrait) { if (shown) hide(); return; }
        if (seen) return;
        seen = true;
        writeSeen();
        show();
      },
      shown: function () { return shown; },
      el: function () { return el; },
      dispose: function () {
        hide();
        if (el && el.parentNode && typeof el.parentNode.removeChild === 'function') el.parentNode.removeChild(el);
        el = null;
      }
    };
  }

  A.agPortrait = {
    isPortrait: isPortrait,
    createRotatePrompt: createRotatePrompt,
    PROMPT_MS: PROMPT_MS,
    SEEN_KEY: SEEN_KEY,
    PROMPT_CSS: PROMPT_CSS,
    TEXT: TEXT
  };
  if (typeof module === 'object' && module.exports) module.exports = A.agPortrait;
})(typeof window !== 'undefined' ? window : globalThis);
