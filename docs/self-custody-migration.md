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

## Phased rollout (don't rip it all out at once)
0. **Embedded wallets** live alongside the current system; create/link on login; show
   on-chain balance.
1. **Stake-on-join** for the dime lobby only: build + verify the stake tx → entry token.
   Gameplay unchanged. Test end-to-end with one real wallet.
2. **On-chain cashout payout** (escrow → wallet) with idempotency + retries.
3. **Bot staking** from the owner wallet.
4. **Settle existing ledger balances** (the reckoning — see below), then retire
   deposit / withdraw / ledger.
5. **Delete dead code** (sweep, withdraw, velocity cap, deposit credit).

Each phase ships and is tested before the next. **Nothing about the actual game
(snakes, rendering, netcode) changes.**

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
