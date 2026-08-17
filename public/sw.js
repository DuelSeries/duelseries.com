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
  // Straight to the network. Present so the app is installable; not a cache.
  e.respondWith(fetch(e.request));
});
