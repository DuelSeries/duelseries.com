'use strict';
/* Minimal service worker, present for one reason: Chrome wants a fetch handler
   before it will build an installed app (a WebAPK) rather than a bookmark
   shortcut, and only an installed app can go fullscreen and hide the status
   bar.

   It caches NOTHING, deliberately. A caching worker on a real-money lobby is
   how a phone ends up showing yesterday's balance, yesterday's board, or an
   old build of the staking client, with no obvious way for the player to
   clear it. The cost of skipping the cache is that the app needs a connection,
   which it needs anyway: every screen here is live server state.

   skipWaiting + clients.claim so a new build takes over immediately instead of
   waiting for every tab to close, which on a home-screen app can be days. */

/* The browser installs a new worker whenever a byte of this file changes, so
   this line is the version: change it with any edit that must reach phones
   that already have the old worker. CHOSEN: a plain counter, 1 being the
   unnumbered first file; 2 = socket.io left alone (below). */
const SW_VERSION = 2;

self.addEventListener('install', (e) => { self.skipWaiting(); });

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // Clear anything a previous version of this file may have stored.
    const names = await caches.keys();
    await Promise.all(names.map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  /* The games' socket.io traffic does not come through here at all. Its
     long-polling requests were being relayed by this worker (6 of 6 measured
     on the live agar.io page, 2026-10-08), an extra hop in every game's
     connection that buys nothing, since nothing is cached. Returning without
     respondWith hands the request straight back to the browser. /ag-io/ is
     agar.io's path if it ever moves to its own socket.io server. */
  const path = new URL(e.request.url).pathname;
  if (path.startsWith('/socket.io/') || path.startsWith('/ag-io/')) return;
  // Straight to the network. Present so the app is installable; not a cache.
  e.respondWith(fetch(e.request));
});
