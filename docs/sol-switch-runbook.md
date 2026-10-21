# Switch night: USDC to SOL money

Owen's call (2026-10-17): every price stays in dollars, money moves as SOL at the live price. Games count in
dollars in both modes (server/money.js); only the doors convert. Plan page: Claude Code Test/sol-switch-plan.html.

## Before the night
- All of the sol-switch branch merged and deployed with `MONEY_MODE` still defaulting to `usdc` (dormant).
- On the box: `node -r dotenv/config scripts/sol-switch.js check` shows all three price sources reading.

## The night, in order
1. No human in a paid room and no live battle royale (`/api/live`). Turn Maintenance on in Control.
2. `scripts/sol-switch.js check`: `stakes.verifying` must be 0 (a USDC stake still verifying would be checked as
   SOL after the flip and rejected). Wait for it if not. Owed rows: let the drainer pay them in USDC first
   (`owed.rows` 0 is best; any left are dollars and pay in SOL after the flip, which needs escrow SOL).
3. Owen tops the escrow up with SOL: at least the dollar liabilities (`owed.usd` + live tokens + the Bot bank
   float + the $20 prize) at the price shown, plus 0.05 SOL. About 0.25 SOL covered it at plan time.
4. `scripts/sol-switch.js convert --yes`: the escrow's and the Bot bank wallet's USDC become SOL in place.
5. Flip: `MONEY_MODE` default in server/money.js from `'usdc'` to `'sol'`, run the duelseries-deploy-check skill,
   push. Check `/api/money-config` says `mode: 'sol'` and Control's escrow line has a dollar figure.
6. With Owen's OK: one $0.50 stake and cash-out from his wallet. Check on-chain: the stake lamports equal the quote,
   about 90 percent comes back, 10 percent swept to the revenue wallet.
7. Maintenance off. Updates post: money is in SOL now.

## Rollback
Set the default back to `'usdc'` (or `MONEY_MODE=usdc` in .env) and restart, under Maintenance with no verifying
stakes, exactly as above. Escrow needs USDC again (it was converted on the night), so buy some first.

## What SOL mode does differently
- Price: Jupiter + Coinbase + Kraken every 15 s, 60 s freshness, two within 1.5 percent. No good price: no new
  stake quote (503 before any wallet prompt), no new payout transaction (rows wait in the drainer's slow lane).
- A stake quote's rate is locked to its blockhash; the verify prices what landed at it. A short stake from one cent
  up is refunded, never kept.
- Payouts round down, stakes round up. Dust under the rent minimum to an empty wallet waits, never retried into fees.
- Skins: one SOL transfer to the revenue wallet with the memo; rows remember their asset.
- Bot bank wallet: its SOL above 0.003 is the bank.
- Wallet tab: dollars with SOL under them; old USDC shows Convert to SOL and Withdraw USDC.
