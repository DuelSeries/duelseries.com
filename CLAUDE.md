# DuelSeries — Project Context

## The Goal (read this first)
This is a **real-money, multiplayer skill game** being built into a legitimate product. The end goal is a polished, trustworthy game with **1,000+ concurrent users**. Every decision should serve that bar:
- **It handles real money (Solana/SOL).** Correctness and security in the money paths are non-negotiable — a bug here loses real funds or lets a cheater mint them. Treat anything touching stakes, escrow, cash-out, or worth as critical code.
- **It must feel legit and professional** — no half-finished features, no "good enough" hacks shipped to live. If it's not solid, it's not done.
- **It must scale.** Aim for clean, efficient, server-authoritative code that holds up with hundreds of players per lobby.

When in doubt, choose the option that makes the game more correct, more secure, and more scalable — not the fastest patch.

## How I should work here
- **Always verify your work.** After every change, confirm it actually functions before claiming it's done: run `node --check <file>` on changed JS, boot the server (or the affected path) and exercise it, and check the behavior really changed. Never report something as working that you haven't checked. If you can't verify, say so explicitly.
- **Guard the money paths.** Never trust client-supplied money values (see Money System). When editing staking/cash-out/worth logic, re-read the surrounding flow first and preserve the server-authoritative, one-time-token model.
- **Server is authoritative.** The server simulates; clients render and predict. Do not move game logic to the client or rewrite the simulation to be client-driven.
- **Commit + push after every change** (this is how the game deploys — see Deploying).
- Prefer minimal, surgical edits over sweeping rewrites unless a rewrite is clearly the right call for quality/scale.

## Current stage — basically no live players yet
The game is **pre-launch / personal testing right now — there are almost never any live players on it.** So live-server operations (restarting pm2, redeploying, even renaming the prod directory) are **low-stakes**: don't treat brief downtime or "disconnecting players" as a blocker, and don't let "it's the live money server" paralyze a routine change. Still verify your work — just don't over-worry about player impact, because there essentially isn't any yet. (This will change as the game grows toward the 1,000+ user goal — raise the caution level then.)

## Workspace Verification
Before reading or editing, confirm the active workspace is this project — it should contain `server/`, `public/js/`, `shared/constants.js`, and `package.json` (name `duelseries`). The game lives in the `slither-clone/` folder. If there's a mismatch, STOP and ask for the correct path.

## The Two Games (naming)
One server hosts two games that share infrastructure (login, wallet, leaderboards, money):
- **The slither.io game** = the snake-style mode; the user calls it **"the slither.io game"** — `server/GameRoom.js` + `public/js/game.js`. (The code still uses `Snake`/`snake` naming internally; that's fine — the conversational label is "the slither.io game.")
- **The agar.io game** = the user calls it exactly that — `server/AgarRoom.js` + `public/js/agar.js`. agar.io-style cells.

## Architecture
- **Stack:** Node + Express + Socket.io (real-time), Postgres via `pg` (persistence), `@solana/web3.js` (on-chain), Privy (login + embedded wallet), Vite + React (builds the wallet widget at `public/wallet/`).
- **Authoritative sim:** server runs at `TICK_RATE` 60Hz; broadcasts snapshots at `SNAPSHOT_RATE` 30Hz (lower rate so weak/mobile clients don't back up). Tunables live in `shared/constants.js`.
- **Rooms:** one room per **region × lobby type**. Regions `['na','eu']`; lobby types `free`, `dime`, `dollar`. `gameRooms[region][type]` and `agarRooms[region][type]` in `server/index.js`.
- **Identity = the player's Privy Solana wallet address.** Single login (Privy only — Google/passport/sessions were removed). The wallet address is passed around as `googleId` for legacy reasons; it is the stable player id used for stats/earnings.
- **The slither.io game runs inside an iframe** in the lobby. It signals "back to lobby" via `postMessage('game:done')`; the lobby (`public/js/lobby.js`) hosts it.
- **⚠️ The socket handshake session is EMPTY** — you cannot identify a player from socket auth. Identity comes from echoed/signed values the client sends (and, for paid play, the server-minted entry token). Never assume the socket "knows who you are."

## Money System (critical — real SOL)
Self-custody only (the old custodial escrow + `accounts.balance` ledger were fully removed; those columns/tables are vestigial).
- **Paid entry = a real on-chain stake.** Client stakes SOL to the escrow, then `POST /api/submit-stake` verifies the transfer landed (`Wallet.verifyStakeTransfer`), atomically claims the signature one-time via `db.markStakeSig` (closes the double-mint race), and mints a one-time **entry token** carrying the SERVER-recorded worth + the staker's wallet.
- **NEVER trust the client's `entrySol`/worth.** `PLAY`, `RESPAWN`, `cell:join`, and `cell:respawn` call `consumePaidEntry(entryToken, type)` and take worth from the server token only. A modified client must not be able to inflate worth and mint money on cash-out. This is the core anti-cheat invariant — preserve it.
- **Cash-out:** escrow pays the player **90%** back on-chain to their own wallet (`Wallet.withdraw`); the **10% house cut** stays in escrow. Earnings recorded via `db.recordEarnings` (keyed by wallet, feeds the combined top-earners board).
- **The escrow is SHARED across NA + EU.** Liability = live stakes in play on BOTH regions. EU pushes its live-stake sum to NA; the solvency monitor (`checkSolvency`, every 60s) alerts the owner if escrow < owed.
- **Owner** = `OWNER_WALLET` (hardcoded to the owner's embedded game wallet in `server/index.js`); owner-only routes verify a Privy id token resolving to that wallet.
- **Anti-collusion:** `CollusionMonitor` records value transfers between accounts (cash food eaten, cells eaten) and flags suspicious one-way/concentrated pairs to the DB + owner socket.

## Netcode & Performance (the scaling constraints)
- **Interest-group snapshots:** players are bucketed into 2000-unit world cells; one payload is encoded per occupied cell and fanned out via a Socket.IO room (`GameRoom.broadcastSnapshot`). Encodes scale with occupied cells, not players² — this is what lifts the per-lobby ceiling. Don't regress to per-socket encoding.
- **Binary codec:** coordinates are packed into one little-endian Int16 buffer (`shared/snapshotCodec.js`), metadata stays a JS object. Same module encodes (server) and decodes (browser) so they can't disagree.
- **`volatile.emit` for snapshots** — a client that can't keep up drops frames instead of backing up its buffer (which would inflate latency for everything). Keep snapshot/input emits volatile.
- **Mobile netcode:** do NOT force a transport (websocket/polling) and do NOT make 60Hz reliable emits — that backed up phone connections and caused the high-ping glitch. Client interpolates (`INTERP_DELAY_MS`, adaptive jitter buffer) and locally predicts its own snake.
- **Collision** uses a spatial grid (`server/SpatialGrid.js`), not all-pairs. The world grows with the crowd so players spread out.

## Commands
- `npm start` — run the server (`server/index.js`).
- `npm run dev` — run with nodemon (auto-restart).
- `npm run build` — Vite build (the wallet widget).
- `npm run loadtest` — headless socket load test (`scripts/loadtest.js`). Env: `LT_URL`, `LT_LEVELS`, `LT_HZ`, `LT_SAMPLE`, `LT_REGION`, `LT_LOBBY`. NOTE: its server-tick columns show `-` because the `/api/debug/tick` endpoint was removed; re-add it to restore them.
- Sanity-check a changed JS file: `node --check <file>`.

## Deploying Changes
- **Commit + push after EVERY change** (`git add <files> && git commit && git push`). Never leave changes uncommitted.
- **Pushing to `main` triggers an automatic AWS deployment** — this is how the live game updates. If the user says they don't see a change live, first check whether it was actually pushed.
- **Two servers:** NA is primary (`duelseries.com`), EU is `eu.duelseries.com`; the lobby stakes against the regional server it's about to play on. They share the escrow + DB; EU pushes stats to NA.

## Environment / Gotchas
- **`.env.example` is STALE** (only lists old SMTP creds). The real env vars the server needs: `REGION` (`na`/`eu`), `DATABASE_URL` (Postgres), `RPC_URL` (Solana RPC — Helius in prod), `SOLANA_NETWORK`, `ESCROW_PRIVATE_KEY`, `ESCROW_PUBLIC_KEY`, `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `OWNER_WALLET` (optional extra owner), `SESSION_SECRET` (required in prod), `PORT`.
- **Vestigial leftovers** from removed systems (don't mistake them for live): `accounts.balance`, the `withdrawals`/`deposits`/`verification_codes`/`trusted_devices` tables (custodial + 2FA), and the custodial finance code. The owner dashboard derives "owed" from live in-game stakes, not `accounts.balance`.
- **Solana RPC must be a dedicated provider** (Helius via `RPC_URL`) — the public endpoint 503s/rate-limits and 403s browser origins. `Wallet.withRetry` backs off on 429/502/503/504. The browser's RPC calls are proxied through `/api/rpc` so they never hit the public node directly.

## Roadmap / Future Direction
- **Fiat on-ramps (PayPal, Cash App, credit/debit cards, Apple/Google Pay).** Goal: let players fund (and ideally cash out) with everyday payment methods instead of needing SOL. Intended approach is to KEEP the crypto rails under the hood and bolt on a fiat→crypto on-ramp so card/PayPal buys SOL (or USDC) that lands in the player's Privy wallet — NOT to become a custodial fiat money-transmitter (that path means licensing + banking partners + chargeback risk and is a regulated-company build). Candidate integrations: Privy's built-in funding (already on our stack), MoonPay, Transak, Stripe crypto on-ramp, Coinbase Onramp. Open considerations: on-ramp fees (~3–5%), KYC friction, **chargeback risk** (cards/PayPal/Cash App are reversible — dangerous for a cash-out game), possibly moving the in-game unit to **USDC** for price stability, and the **legal/gambling-regulation** reality of real-money wagering by jurisdiction. Treat as a real project, not a quick add.

## Reference Docs
- `docs/self-custody-migration.md` — how the custodial system became self-custody (the money model).
- `docs/single-login-migration.md` — how Privy became the only login.
