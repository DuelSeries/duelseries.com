/* Which Privy app this page signs in with (2026-11-02).

   One app id used to serve every host, and the live app allows http://localhost:3000, so every local run and
   Playwright test signed in to the PRODUCTION app: 19 of the first 20 "created by wallet: Phantom" users were our
   own Phantom-stub runs (a new fake wallet each run), counting toward the dev-mode 150-user cap and reading as
   sign-ups. duelseries.com and its subdomains get the live app; every other host (localhost, 127.0.0.1, a
   preview box) gets the separate dev app, whose users never mix with players'. App ids are public, not secrets.

   The server checks tokens against its own PRIVY_APP_ID (server/privyKeys.js, audience), so a dev-app token is
   refused by the live server and a live token by a dev one. */
export const PROD_PRIVY_APP_ID = 'cmpnepg0100f20cl10wdig1fr';
export const DEV_PRIVY_APP_ID = 'cmw071mrh00br0hjv42152hdh';   // duelseries-dev, made 2026-11-02 (localhost + 127.0.0.1:3000)

export function privyAppIdFor(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return h === 'duelseries.com' || h.endsWith('.duelseries.com') ? PROD_PRIVY_APP_ID : DEV_PRIVY_APP_ID;
}
