# Single Privy Login (auth migration — "path 1a")

**Goal:** one login instead of two. Today you log into **Google** (account / name / stats, keyed
by Google ID) *and* connect **Privy** (the embedded wallet, keyed by wallet address). After this,
**Privy is the only login** — connecting your wallet *is* signing in, and your **wallet address is
your single identity** everywhere.

**Status:** PLANNED (not started). Run as its own focused session, like the Phase 4 cutover. The
money system (escrow, stakes, cash-out) is untouched by this migration.

## Current state — what's keyed to what
- **Google OAuth (passport + express-session)** is the login. `passport.serializeUser` stores
  `user.googleId`; `deserializeUser` loads the `accounts` row. `GoogleStrategy` at index.js ~129.
  Routes: `/auth/google`, `/auth/google/callback`, `/auth/logout`, `/auth/me`, `/auth/update-name`,
  plus a magic-code / device-trust login (`/auth/verify`, `/auth/resend-code`, db:
  `saveVerificationCode`/`verifyCode`/`addTrustedDevice`/`isDeviceTrusted`/`getGoogleIdByDeviceToken`).
- **`accounts` table** keyed by `google_id` (name, email, avatar, high_score, games_played,
  total_earnings, …). Stats / leaderboards / profile all join on `google_id`.
- **Lobby** gates play on `account` (from `/auth/me`): `if (!account) showLoginModal()` (lobby.js
  ~931, ~1024). Name = `account.name`; identity sent to the game = `account.googleId` (sessionStorage
  + `lobby:join`).
- **Privy** is a *separate* layer: the embedded wallet, keyed by **wallet address**. Self-custody
  play already identifies players by the wallet (`socket._walletAddress`; `socket._googleId` is set
  to the wallet address for self-custody players). Earnings are already wallet-keyed (`recordEarnings`).

So the wallet is **already** the money identity — this migration makes it the *only* identity.

## Target state
- **Privy is the login.** `window.duelWallet.authenticated` = signed in. No Google OAuth, no
  passport, no server session cookie, no magic-code login.
- **Identity = wallet address** everywhere (lobby:join, stats, leaderboards, profile, owner check).
- **Name** = the existing player-name box (saved in `localStorage`, sent per game); the server
  records it against the wallet when it matters (already does at cash-out via `recordEarnings`).
- **Server auth** for the few endpoints that need it (owner/admin, name save) = verify a **Privy
  access token (JWT)** instead of a session cookie.

## Decisions to lock before executing (with recommendations)
1. **Identity key — wallet address (REC) vs Privy user id (`did:privy:…`).** Wallet address is
   already the money key + human-meaningful; Privy id is stabler only if a user changes wallets
   (embedded wallets don't). → **wallet address**.
2. **Existing Google accounts — abandon (REC) vs migrate.** They hold old names / high-scores /
   stats keyed by `google_id`. Test project → **abandon** (fresh wallet identity, trivial). For real
   users add a one-time "link your wallet" step later.
3. **Server auth for owner/admin — verify Privy token (REC) vs signed-message vs keep a tiny
   session.** → **`@privy-io/server-auth` token verification**; owner = `OWNER_WALLET` env var.
4. **Names — per-game display name (REC) vs stored profile name.** Simplest: the name box is the
   display name (localStorage + sent per game; leaderboard stores it on cash-out). Stored profile
   name keyed by wallet is optional polish. → **per-game display name**.

## Phased plan (gradual — playable throughout)

### Phase A — Privy becomes the functional login (client-only; low risk)
- Lobby login gate uses Privy: `if (!window.duelWallet?.authenticated) { window.duelWalletLogin(); return; }`
  instead of `if (!account) showLoginModal()`. The wallet card's "Connect wallet" is the login.
- Identity sent to the game / `lobby:join` = the wallet address (not `account.googleId`).
- Name = the player-name box + `localStorage` (already there); drop the `account.name` dependency.
- Google login still exists server-side but is no longer required. **Ship + verify you can play
  start-to-finish with only a Privy login.**

### Phase B — Server: replace passport with Privy token auth
- Add a Privy access-token verification middleware (`@privy-io/server-auth`): client sends its Privy
  token (Authorization header); the server resolves the wallet address → replaces
  `req.isAuthenticated()` / `req.user`.
- Re-point owner checks to `OWNER_WALLET`. Re-point `/auth/update-name` (if kept) + any authed
  endpoints to the wallet identity.
- Stats keyed by wallet: `recordGameResult`, profile, leaderboards use the wallet address (lazily
  upsert the `accounts` row by wallet, like `recordEarnings` already does).
- **Remove:** `GoogleStrategy`, passport, express-session, `/auth/google`, `/auth/google/callback`,
  `/auth/logout`, `/auth/verify`, `/auth/resend-code`, and the device-trust db functions. `/auth/me`
  → return the Privy identity or drop it (client uses `window.duelWallet`).

### Phase C — Settle the account model + clean up
- `accounts` becomes wallet-keyed (the `google_id` column holds the wallet address for new players;
  old Google rows are legacy/abandoned per decision 2).
- Remove dead Google/account code, the login modal's Google button, the magic-code UI.
- (Optional) one-time "link old account → wallet" tool if you choose migrate over abandon.

## Risks & notes
- **Biggest risk:** locking yourself out of owner/admin if the token-auth swap is wrong. Do Phase B
  behind a verified `OWNER_WALLET` check *before* deleting passport; keep it on a branch.
- **Existing data:** abandoning Google accounts loses old names / high-scores (fine for the test).
- **Mobile/persistence:** Privy sessions persist client-side; you lose the server session, but the
  game already tolerates an empty socket session (uses echoed/signed values).
- **No username from Privy:** the name box stays (it's the display name).
- **Env:** add `OWNER_WALLET`; `GOOGLE_CLIENT_ID/SECRET/CALLBACK_URL` become removable after Phase C.

## Rollback
Phase A is a one-line client revert. Phase B removes passport — verify owner/admin + full play on a
branch before merging. Nothing here touches escrow / stakes / cash-out.
