'use strict';
/* ─── Swipe navigation ────────────────────────────────────────────────────────
   Two horizontal gestures, decided by what is under the finger:

     over the games rail   move through the games
     anywhere else         move between tabs

   The interesting part is everything that must NOT be treated as a swipe. The
   earnings chart is scrubbed by dragging horizontally, the appearance screen
   has its own left/right controls, and the lobby list scrolls vertically inside
   itself. A page-wide handler that ignored those would make the chart
   unusable and change tabs while somebody was reading a figure off it.

   Touch events only, deliberately. Pointer events would also fire for a mouse,
   and a click-drag on a desktop is a text selection, not a swipe.

   Nothing calls preventDefault: the page never scrolls horizontally, so there
   is nothing to suppress, and staying passive keeps vertical scrolling smooth
   on the main thread. */

(function () {
  const MIN_X = 55;        // shorter than this is a tap or a jitter
  const RATIO = 1.6;       // must be this much more horizontal than vertical
  const MAX_MS = 700;      // slower than this is a drag, not a flick

  /* Anything here owns its own horizontal gestures. */
  const EXEMPT = '.chartbox, .apscreen, input, textarea, select, #game-frame, .ticker';

  const TABS = ['play', 'wallet', 'stats', 'social', 'locker', 'settings'];

  let x0 = 0, y0 = 0, t0 = 0, from = null, tracking = false;

  function onStart(e) {
    if (e.touches.length !== 1) { tracking = false; return; }   // pinch, not swipe
    const t = e.touches[0];
    x0 = t.clientX; y0 = t.clientY; t0 = Date.now();
    from = e.target;
    tracking = true;
  }

  function onEnd(e) {
    if (!tracking) return;
    tracking = false;
    const t = (e.changedTouches && e.changedTouches[0]);
    if (!t) return;

    const dx = t.clientX - x0, dy = t.clientY - y0, dt = Date.now() - t0;
    if (dt > MAX_MS) return;
    if (Math.abs(dx) < MIN_X) return;
    if (Math.abs(dx) < Math.abs(dy) * RATIO) return;            // mostly vertical

    const el = from && from.closest ? from : null;
    if (el && el.closest(EXEMPT)) return;                       // owns its own drag

    // The appearance screen is a takeover; it is not a tab and has its arrows.
    const look = document.getElementById('lookveil');
    if (look && look.classList.contains('on')) return;

    const dir = dx < 0 ? 1 : -1;                                // left = forward

    /* Over the games: move the rail. The rail is only on the home screen, so
       this cannot swallow a tab swipe anywhere else. */
    if (el && el.closest('.railwrap')) {
      if (window.spin) window.spin(dir);
      return;
    }

    /* Everywhere else: move between tabs. From a game's detail screen a swipe
       goes back to the board first, because that screen is below the tabs
       rather than beside them, and jumping straight to Wallet from it would
       lose your place. */
    const detail = document.getElementById('detail');
    if (detail && getComputedStyle(detail).display !== 'none') {
      if (window.goHome) window.goHome();
      return;
    }
    const player = document.getElementById('player-screen');
    if (player && getComputedStyle(player).display !== 'none') {
      if (window.go) window.go('social');
      return;
    }

    const now = TABS.indexOf(window.route || 'play');
    if (now < 0) return;
    const next = now + dir;
    if (next < 0 || next >= TABS.length) return;                // no wrap-around
    if (window.go) window.go(TABS[next]);
  }

  document.addEventListener('touchstart', onStart, { passive: true });
  document.addEventListener('touchend', onEnd, { passive: true });
  document.addEventListener('touchcancel', () => { tracking = false; }, { passive: true });

  window.V2Swipe = { tabs: TABS };
})();
