# USDC Cutover Runbook (P7)

Flip the live game from native SOL to USDC. The whole USDC stack is already built + deployed
behind the `MONEY_MODE` flag (default `sol`) and **proven on devnet** (see `scripts/usdc-devnet-run.js`).
This runbook is the live mainnet cutover. It's fully reversible (one env flip).

## Key facts
- **Reuse the existing escrow wallet** (`EZAAbJxzrsULmTxeMTw56mQtnvaUM2ZUaHmoDYh7USZV`). It just needs a
  USDC token account (ATA) + USDC funding. Same wallet holds SOL (for gas) AND USDC (the float).
- **USDC mint (mainnet):** `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (Circle USDC).
- **Lobby fees become USD:** dime = $0.10 USDC, dollar = $1.00 USDC.
- The escrow needs SOL on the side: ~0.002 SOL per *first-time* winner (to create their USDC
  account on payout) + tx fees. Keep a few tenths of a SOL there.

## Pre-flight (all ✅ already)
- [x] Devnet proof passed end-to-end (stake→verify→payout→new-wallet payout).
- [x] `money.js` / `Usdc.js` deployed (dormant, `MONEY_MODE` unset = SOL).
- [x] Client widget is mode-aware (reads `/api/money-config` + quote.mode), rebuilt + deployed.

## Steps
1. **Create the escrow's USDC ATA on mainnet** (one tx, ~0.002 SOL from the escrow's existing SOL).
   Run on NA: a small node script using `ESCROW_PRIVATE_KEY` from `.env` +
   `@solana/spl-token` `getOrCreateAssociatedTokenAccount(conn, escrow, USDC_MINT, escrow.publicKey)`.
   → produces the escrow's USDC token account (empty).
2. **Fund the escrow with USDC** (YOUR float). Send USDC (mainnet) to the escrow **wallet**
   `EZAAbJ…` (wallets/exchanges resolve to its ATA automatically) — start small, e.g. $5–$20 for
   the first live test. This is the money the game pays winners from.
3. **Top up escrow SOL for gas** if it's low (aim ≥ 0.1 SOL): send a little SOL to `EZAAbJ…`.
4. **Flip the flag on BOTH servers** — add `MONEY_MODE=usdc` to `/home/ubuntu/duelseries/.env`
   on NA and EU, then `pm2 restart duelseries` / `duelseries-eu`.
5. **Verify:**
   - `curl https://duelseries.com/api/money-config` → `{"mode":"usdc","unit":"USDC", ...}`
   - `/api/admin/solvency` (owner) → escrow USDC balance shows your float.
   - **Smoke test:** from a wallet holding a little USDC, stake a $0.10 lobby, play, cash out —
     confirm the USDC moves and the payout lands.

## Rollback (instant)
Set `MONEY_MODE=sol` (or remove the line) in both `.env`s + `pm2 restart`. The SOL escrow still
holds its SOL; nothing about the SOL path changed. The USDC float just sits in the escrow ATA
until you flip back.

## After cutover
- Build the **"Add Funds" on-ramp modal** (Privy funding / MoonPay) so players can buy USDC with
  card/Apple Pay/PayPal — the headline feature (see CLAUDE.md roadmap).
- Once stable on USDC, delete the SOL backend + the `MONEY_MODE` flag (full cutover cleanup).
