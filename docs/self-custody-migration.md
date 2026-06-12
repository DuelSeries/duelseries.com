# Self-Custody Migration Map (DuelSeries / HexSlither)

Migrating from **custodial** (platform holds everyone's money in one escrow + a Postgres
balance ledger) to **self-custody + per-game stake** using **Privy embedded wallets**.

## The core shift
- **Today:** the platform holds all funds. Deposits get swept into one central escrow;
  `accounts.balance` (Postgres) is the source of truth; withdrawals pay out from escrow.
- **After:** the platform holds **no idle balances**. Each player's balance is the real
  SOL in their own Privy **embedded** wallet. Only the **active stake** of a live game
  sits in the escrow, and it's paid back the moment they cash out or die.

Mental model: **your in-game balance = the SOL in your embedded wallet.** Press Join →
one tap to stake the entry into escrow. Cash out → escrow pays you back. Done.

## Before → After, piece by piece

| Piece | Today (custodial) | After (self-custody + per-game stake) |
|---|---|---|
| **Wallet** | Privy *server* wallet (app-controlled) | Privy *embedded* wallet (user-controlled, created at login) |
| **Balance** | `accounts.balance` row in Postgres | The real SOL in the user's embedded wallet |
| **Funding** | Send SOL → Privy wallet → swept to escrow → credited to ledger | Send SOL → your embedded wallet (or Privy on-ramp). No sweep. |
| **Join paid lobby** | `/wallet/entry-fee` deducts ledger balance | Client builds a stake tx (wallet → escrow); user taps **Confirm**; server verifies the on-chain stake, then issues the entry token |
| **Gameplay** | Off-chain on the server | **Unchanged — identical** |
| **Cash out / die** | Credits ledger balance | Escrow sends final worth → your wallet (on-chain, no tap needed to receive) |
| **Bots (paid lobby)** | Owner-funded ledger entries | Server stakes bot entries from the **owner wallet** → escrow; bot winnings → owner wallet |
| **Withdraw** | `/wallet/withdraw` escrow → external wallet | **Gone** — it's already your wallet; send it anywhere yourself |
| **Escrow** | Holds everyone's entire balance | Holds only the **active pot** (live games + owner bot stakes) |
| **Ledger (`balance`)** | Source of truth | Retired (display cache at most) |

## What changes in code
- **Frontend / Privy:** switch from server wallets to **embedded wallets**; wallet
  created/linked at login; the balance UI reads the on-chain wallet balance; add the
  styled **"Stake $0.10 to play? [Confirm]"** modal that signs the stake tx.
- **`/wallet/entry-fee` → stake-verify:** instead of deducting a ledger balance, it
  verifies a **confirmed on-chain stake tx** (client echoes the signature; server
  confirms it sent ≥ the fee to the escrow and the sig isn't already used), then issues
  the **entry token we already built**. The entry-token → PLAY / RESPAWN / cell:join flow
  **stays** — only what *backs* the token changes (a real stake instead of a ledger debit).
- **Cashout → on-chain payout:** escrow signs a transfer of `worth × 0.9` → the player's
  wallet. Needs **idempotency** (never double-pay) + a **retry queue** (never lose a payout).
- **Bots:** spawning a bot in a paid lobby stakes from the owner wallet → escrow; bot
  exit → escrow → owner wallet. Owner wallet = an app-signable house bankroll.
- **Remove:** deposit-sweep (`sweepFromPrivyWallet` — the CAIP-2/rent fixes become moot),
  `/wallet/withdraw`, the withdrawal velocity cap, and ledger crediting. `withdrawals`
  table + `accounts.balance` go vestigial.
- **Keep:** all gameplay (GameRoom/AgarRoom), the entry-token verification, the collusion
  monitor (still tracks the same value flows), the escrow diagnostics endpoints.

## Phased rollout — STATUS (updated 2026-06-10)
- ✅ **Phase 0** — embedded Privy wallets alongside the current system; login; on-chain balance.
- ✅ **Phase 1** — stake-on-join for ALL paid tiers (10¢ + $1; free skips the stake), launched
  in the lobby iframe, real player name. Browser can't reach a public RPC, so RPC is routed
  through our own `/api/rpc` proxy; Privy *signs only*, the backend submits + confirms over HTTP
  (no browser WebSocket) and verifies the escrow credit before issuing the entry token.
- ✅ **Phase 2** — cash-out escrow → wallet (90%; 10% house cut stays in escrow).
- ✅ **Solvency monitor** — escrow vs (custodial ledger + live stakes); owner alert + `/api/admin/solvency`.
- ⬜ **Phase 3** — bot staking from the owner wallet. **Deferred by owner** until there's an
  expense-tracking design — do NOT build yet.
- ⬜ **Phase 4** — retire custodial. **GRADUAL cutover chosen** (detailed plan at the bottom).
- ⬜ **Phase 5** — delete dead custodial code (folded into Phase 4d below).

Each phase ships and is tested before the next. **Nothing about the actual game changes.**

## The one migration gotcha: existing balances
The ledger says the owner is owed ~$4.54, but only ~$2.11 of real SOL backs it (the rest
was phantom bot winnings). At cutover, ledger balances must be **settled** — paid out for
real or zeroed. For the test account that's trivial (pay what's actually backed). For a
real platform with real users it's a serious, deliberate step (you're paying real money),
so it belongs in Phase 4 — never by accident.

## Open questions / risks
- **Per-join latency** (~1s for the stake to confirm) → show a "confirming…" state.
- **Replay friction** (one Confirm per respawn) → later add optional Privy **session
  signers** for a "fast replay" mode (auto-stake within limits) — opt-in, not default.
- **Tx fees** (~0.000005 SOL/stake, paid by the player) — negligible but real.
- **Failed stake** (reject/timeout) → don't start the game; clean retry.
- **Failed payout** (escrow→wallet tx fails) → retry queue + idempotency.
- **Rent minimums** — embedded wallets must hold ~0.00089 SOL to exist; UX must tell users
  they need a little SOL for fees + rent on top of the stake.
- **Licensing / KYC** — unchanged; still required before real money/players. Self-custody
  helps the money-transmitter angle, not the gambling-license one.

## Phase 4 — detailed execution plan (GRADUAL cutover, decided 2026-06-10)
Owner chose a **gradual** cutover (don't break existing users; remove custodial only once
self-custody is proven), to run as its own focused session. Order:

**STATUS (2026-06-12):**
- ✅ **4a** — main Play button is self-custody-first for paid lobbies (custodial fallback). Verified.
- ✅ **4b** — one-tap "Move old balance → wallet" (`/wallet/settle` + atomic `db.takeFullBalance`,
  refund-on-fail). Mechanism verified (correctly refused to overdraw the escrow + refunded). Owner's
  own balance left UNSETTLED by choice — phantom-inflated test data (ledger > escrow backing).
- ✅ **4c** — custodial deposits stopped: `/wallet/deposit` → 410, "Add Funds" hidden (CSS). Cash-out kept.
- 🟡 **4d** — PARTIAL: removed the dead inbound deposit body (now a 410 stub). OUTBOUND removal is
  DEFERRED — `db.recordDeposit` is the ledger-credit STILL used by the custodial cash-out, and
  `sweepFromPrivyWallet` has a second caller (admin debug endpoint ~L768). Deleting withdraw/ledger
  now would break cash-out + strand un-settled balances.
  **Gate to finish 4d:** (1) settle/write-off remaining custodial balances, (2) migrate or retire the
  custodial cashout-to-ledger path; THEN delete `/wallet/withdraw` + velocity cap, the custodial
  cashout branch, `recordDeposit`, `sweepFromPrivyWallet` + its admin caller, `findDepositsForAddress`.

### 4a — Self-custody as the DEFAULT paid-play path (keep custodial fallback)
- The lobby's main **Play** button, for PAID lobbies, routes through the self-custody stake
  when a self-custody wallet is connected; falls back to the custodial entry-fee if not.
- Widget exposes `window.duelStake(lobbyType)` (stake → entry token → launch). `lobby.js`'s
  `btn-play` calls it for paid lobbies when `window.duelWallet?.authenticated`; else the
  existing custodial flow (transition safety). Free lobbies unchanged.
- Risk: changes the main button → keep the custodial fallback until proven.

### 4b — Settle existing custodial balances (the reckoning)
- Owner tool: pay each custodial `accounts.balance` to the user's wallet (escrow → wallet via
  `Wallet.withdraw`), then zero the ledger. Idempotent (no double-pay); confirm each on-chain.
- Pay to the user's linked embedded wallet (by email/googleId). Keep `/wallet/withdraw` open
  during transition.
- **Un-backed gap:** if ledger > real escrow backing (the $4.54-vs-$2.11 phantom-bot-winnings
  issue), owner must top up the escrow to honor balances OR write down the phantom portion.
  Trivial for the test account; a real decision with real users.

### 4c — Stop new custodial money in
- Disable custodial deposits (`/wallet/deposit` → "moved to self-custody"; hide custodial
  "Add Funds"). New funds only enter via the embedded wallet.

### 4d — Delete custodial code (only after 4a–4c proven + balances settled)
- Remove: `/wallet/deposit`, `/wallet/withdraw` + velocity cap, `sweepFromPrivyWallet` (+ the
  CAIP-2/rent fixes), the custodial branch of `/wallet/entry-fee`, the custodial cashout branch
  (recordDeposit/addEarnings). `accounts.balance` + `withdrawals` go vestigial.
- KEEP: entry-token system (now only stake-backed), escrow, `/api/rpc` proxy, stake-quote /
  submit-stake, collusion monitor, solvency monitor, escrow diagnostics, the widget + cashout.

### Auth note
- Gradual keeps **Google OAuth** for the account/name/leaderboard layer; the **Privy embedded
  wallet** is the money layer. Migrating *login* to Privy is optional/separate — not required
  to retire the custodial *money* system.

### Throughout
- The **solvency monitor** (`/api/admin/solvency`) watches the whole transition and alerts if
  the escrow ever can't cover obligations.
