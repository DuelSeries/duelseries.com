'use strict';
/* ─── Fullscreen and phone behaviour ──────────────────────────────────────────
   WHAT IS ACTUALLY POSSIBLE, because the obvious ask is not:

   A page cannot put itself fullscreen on load. Every browser requires the call
   to come from a user gesture, and iOS Safari does not implement the Fullscreen
   API for anything except <video> — there is no flag or trick for it. So:

     Installed to the home screen   real fullscreen, no browser chrome at all,
                                    on both iOS and Android. This is the only
                                    route to "open it and it is fullscreen",
                                    and it is what the manifest and the
                                    apple-mobile-web-app-capable meta are for.
     Android / desktop browser      requestFullscreen on the first tap, which
                                    is the earliest moment it is allowed.
     iOS Safari tab                 not possible. The page instead uses every
                                    pixel it is given, under the notch too, and
                                    offers Add to Home Screen once.

   Nothing here fights the browser or hides the fact when it cannot comply. */

(function () {
  const standalone = () =>
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    window.navigator.standalone === true;

  const isIOS = () => /iP(hone|ad|od)/.test(navigator.platform || '') ||
    (navigator.userAgent.includes('Mac') && 'ontouchend' in document);
  const isPhone = () => window.matchMedia('(max-width: 760px)').matches;

  /* Ask for fullscreen at the first touch, since that is the first moment a
     browser will honour it. Once only: a user who leaves fullscreen means it. */
  let asked = false;
  function tryFullscreen() {
    if (asked || standalone()) return;
    asked = true;
    const el = document.documentElement;
    const go = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
    if (!go) return;                       // iOS Safari: not available, not an error
    try { const p = go.call(el); if (p && p.catch) p.catch(() => {}); } catch (_) {}
  }
  window.addEventListener('pointerdown', tryFullscreen, { once: true, passive: true });

  /* iOS in a tab cannot be put fullscreen by us, so tell the person how to get
     it. Shown once ever, and only where it is actually true. */
  function maybeOfferInstall() {
    if (!isIOS() || standalone() || !isPhone()) return;
    try { if (localStorage.getItem('duelseries_a2hs') === 'seen') return; } catch (_) { return; }
    const bar = document.createElement('div');
    bar.className = 'a2hs';
    bar.innerHTML =
      '<span>Add DuelSeries to your home screen for fullscreen: tap Share, ' +
      'then <b>Add to Home Screen</b>.</span>' +
      '<button aria-label="Dismiss">Got it</button>';
    bar.querySelector('button').addEventListener('click', () => {
      bar.remove();
      try { localStorage.setItem('duelseries_a2hs', 'seen'); } catch (_) {}
    });
    document.body.appendChild(bar);
  }

  /* ── "Desktop site" detection ──────────────────────────────────────────
     With Chrome's Desktop site setting on, the browser ignores
     width=device-width and lays the page out at about 980 CSS pixels, then
     scales the whole thing down to fit. Every media query below 760px stops
     matching, so a phone gets the desktop layout at about a third size: the
     page looks "zoomed out" and fills a fraction of the screen.

     Nothing in CSS or JS can override that — it is the user's decision and the
     browser enforces it. What we can do is notice, because the symptom looks
     exactly like a broken responsive layout and is impossible to guess at.
     The tell is a layout viewport far wider than the physical screen. */
  function desktopSiteForced() {
    if (!screen || !screen.width) return false;
    const layout = window.innerWidth;
    const physical = Math.min(screen.width, screen.height);
    // A real tablet is wide AND has a wide screen; this is wide on a narrow one.
    return physical <= 500 && layout > physical * 1.6 && layout >= 700;
  }
  function warnDesktopSite() {
    if (!desktopSiteForced()) return;
    try { if (sessionStorage.getItem('duelseries_dsite') === 'seen') return; } catch (_) {}
    const bar = document.createElement('div');
    bar.className = 'a2hs';
    bar.innerHTML =
      '<span>This is showing the desktop layout. Turn off <b>Desktop site</b> ' +
      'in your browser menu for the phone version.</span>' +
      '<button aria-label="Dismiss">Got it</button>';
    bar.querySelector('button').addEventListener('click', () => {
      bar.remove();
      try { sessionStorage.setItem('duelseries_dsite', 'seen'); } catch (_) {}
    });
    document.body.appendChild(bar);
  }

  /* Mobile browsers report 100vh as the height WITHOUT the collapsing address
     bar, so a full-height element is taller than the screen and the page
     rocks as the bar hides. --vh is the real height, updated as it changes. */
  function setVH() {
    document.documentElement.style.setProperty('--vh', window.innerHeight * 0.01 + 'px');
  }
  setVH();
  window.addEventListener('resize', setVH);
  window.addEventListener('orientationchange', () => setTimeout(setVH, 200));

  /* Registered so Chrome will build a real installed app instead of a bookmark
     shortcut. It caches nothing; see public/sw.js for why that is deliberate. */
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }

  document.addEventListener('DOMContentLoaded', () => { warnDesktopSite(); maybeOfferInstall(); });

  window.V2Mobile = { standalone, isPhone, tryFullscreen, desktopSiteForced };
})();
