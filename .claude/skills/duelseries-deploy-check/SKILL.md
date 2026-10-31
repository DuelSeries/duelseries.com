---
name: duelseries-deploy-check
description: Run this SAFETY PASS before committing, pushing, or deploying ANY change to DuelSeries (the slither-clone real-money game). Pushing to main auto-deploys to AWS, so this guards the money paths and catches breakage first. Trigger whenever about to git commit / git push / deploy DuelSeries, or when Owen says "ship it", "push it", "deploy", or "make it live".
---

# DuelSeries pre-deploy safety check

DuelSeries handles REAL money (USDC on Solana). Pushing to `main` triggers an automatic AWS deploy, so a bad push can lose real funds or break the live game. Before ANY commit/push/deploy of the game, walk these steps in order. Do not skip. If any step fails or is unclear, STOP and tell Owen rather than pushing.

## 1. Confirm the scope
- Run `git status` and `git --no-pager diff --stat` from the `slither-clone` repo to see exactly which files changed.
- The change should be surgical. If the diff is bigger than expected, pause and confirm with Owen before continuing.

## 2. Syntax-check every changed JS file
- For each changed `.js` file, run `node --check <file>`.
- If ANY file fails the check, STOP. Do not push broken code.

## 3. Guard the money paths (the critical step)
If the change touches ANY money-related code, treat it as high-risk:
- Files: `server/index.js`, `server/GameRoom.js`, `server/AgarRoom.js`, `server/Snake.js`, `server/Usdc.js`, `server/money.js`, `server/Wallet.js`, anything under `/api/submit-stake`, or the cosmetics/cashout/rake logic.
- Re-read the surrounding flow first, then confirm these invariants from the project CLAUDE.md still hold:
  - NEVER trust the client's `entrySol`/worth. Worth comes ONLY from the server-minted one-time entry token via `consumePaidEntry`.
  - Paid entry = a real on-chain stake verified server-side; the signature is claimed one-time via `db.markStakeSig` (closes the double-mint race).
  - Cash-out pays the player 90% back on-chain; the 10% house cut stays in escrow.
  - The server is authoritative; do not move money/game logic to the client.
- Invoke the `security-and-hardening` skill on the diff for any money- or input-handling change.
- If anything about the money path is uncertain, DO NOT push. Flag it to Owen.

## 4. Verify it actually works
- Confirm the changed behavior really functions, do not claim "done" without checking (per CLAUDE.md). At minimum: `node --check` passed on all changed JS; boot/exercise the affected path if feasible.

## 4b. Never push while a human is in a paid room (Owen's rule, 2026-09-30)
- A push restarts the live server, and money already seated in a paid game is lost on a restart.
- Right before `git push`, fetch `https://duelseries.com/api/live` and check every lobby with `stake > 0`: `players` must be 0.
  If any paid room has a human, wait and recheck; never push over a live paid player.
- If Maintenance is on (`/api/live` answers `maintenance.on: true`, or Control's Maintenance button reads "End
  maintenance"), wait until Control says "Safe to update now" before pushing. Players were told to finish up or
  cash out and are never kicked; after the push the server reopens games by itself once healthy (a "Done today"
  line in Control). If it says it stayed closed, Owen opens it by hand.

## 4c. Post it on the Updates tab (Owen's rule, 2026-10-16)
- If players can see or feel the change (new feature, new look, game feel, a bug they would have hit), add ONE post
  at the TOP of `slither-clone/public/updates.json` in the same commit, following the repo CLAUDE.md
  "Posting an Update" rules (tag new/fix/event/heads-up, image optional under public/updates/).
- Write it for players: short and plain, what changed and why it's better. Never mention money mechanics, rake,
  security fixes or exploits, internal tools, the owner console, bots, tests or refactors. Skip the post for
  internal-only changes.
- Several small player-visible fixes in one push become one post, not many.
- On a rebase conflict in updates.json, keep both posts (newest first) and make sure the JSON still parses.

## 5. Commit + push (this is the deploy)
- Stage only the intended files, then commit with a clear message. End the commit message with the required trailer:
  `Co-Authored-By: <the model actually running> <noreply@anthropic.com>`, e.g.
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`. Use whichever model you
  actually are rather than a hardcoded name, so the trailer does not go stale.
- `git push origin main`. Pushing to `main` is what auto-deploys to AWS.
- In a cloud session (`CLAUDE_CODE_REMOTE=true`), skip this push: push to the session's own branch instead and
  leave the merge to main to the local dispatcher (see CLAUDE.md "Cloud sessions").

## 6. Confirm the result
- Report exactly what was pushed and that it triggers the AWS deploy. The deploy pings Owen's phone via ntfy when it finishes.
- If the change was money-related, remind Owen to test the live money flow (stake → cash out) once it deploys.
