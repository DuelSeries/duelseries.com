# Buying skins (2026-10-16)

Owen: "make the whole buying skins thing work." Owen's calls: wear in all five open games (slither, agar,
Paper, Knockout, Battleship; Awesome Tanks and Bowmasters stay Coming soon while locked), no refunds,
Owen does the one real test buy.

## The money path

Item = `<game>:<skin>` (`snake:candycane`). Price = the SERVER's copy of `shared/shopPrices.js`, in USDC
base units, never a client number. Sellable = has a price and the game is not in `shared/lockedGames.js`.
Paid to `REVENUE_WALLET` (Owen's Phantom revenue wallet, where the rake already goes).

1. `POST /api/skins/intent {game, skin, wallet}` -> a purchase row `open` with a server-random `ref`
   and the server's price. Refused if the wallet owns it already, or if an earlier payment for the same
   item is still settling (the page resumes that one instead). No proof needed here: only the wallet
   can sign the payment, and an open row moves nothing. Answers the quote: revenue USDC account, mint,
   units, memo `ds-skin:<ref>`, fresh blockhash.
2. The page shows the confirm sheet (preview, price, balance after, Confirm). Short of USDC: Add funds.
   Confirm builds exactly two instructions, `transferChecked(player -> revenue, units)` and a Memo with
   the ref, and the player's own Privy wallet signs it (sign only).
3. `POST /api/skins/buy {ref, signedTx}`, BEFORE broadcasting: the bytes are a real signature by their
   fee payer (`Wallet.stakeTxInfo`), the payer is the row's wallet, and the instructions are exactly that
   transfer (USDC mint, the revenue account, the row's units, authority = payer) and that memo (Compute
   Budget allowed, nothing else). Then the row goes `open -> submitted` with the signature (UNIQUE) in
   one conditional UPDATE, so a double click or a replay never sends twice. Only then is it broadcast.
   A preflight refusal (no USDC, no SOL for the fee) is certain to have moved nothing and puts the row
   back to `open`.
4. After it confirms, the landed tx is checked on-chain: no error, the revenue wallet's USDC rose by at
   least the units, fee payer = the row's wallet, the memo names this ref. Then ONE database transaction:
   row `submitted -> paid` (only once, the signature unique across all rows), `cosmetics_owned` row,
   `house_revenue` row (source `cosmetic`): the sale's ledger line for Business Finances.
5. Anything unfinished settles later, never lost: `GET /api/skins/purchase/:ref` (the page saves the ref
   before sending, so a reload resumes it) and a server sweep every minute both run step 4 for a
   `submitted` row whose tx landed, and close it `failed` when the chain says it failed or its blockhash
   expired unlanded. One RPC at a time, never batched, `withRetry` on 429. No refunds: a payment that
   landed always becomes the skin.

## Wearing it

`GET /api/skins/owned?wallet=` lists owned items (public facts, on-chain anyway). To wear, the lobby
gets a skin pass: `POST /api/skins/pass {proof}`, a one-time silent signature by the wallet over action
`skins:pass` (ownerAuth's message; that action runs nothing anywhere else), answered with an HMAC token
(key from `SESSION_SECRET`) over `{wallet, owned items, expiry 24 h}`. Each game page sends the pass and
its chosen paid skin in its join; the game SERVER verifies the HMAC, the expiry and that the item is in
the pass, and wears it, else the free look. No client-only lock: a page claiming a skin without a valid
pass gets the default.

How each game wears it: slither (/sl) sends slither's own custom skin bytes in snake_add.skin, which the frozen
client already draws; agar (/ag) puts the skin's colour on the cells and sends `ag:skins` (cell ids and skin) to each
page right after its bundle, only when its list changes; Paper.io names the unit's skin `paper:<id>` and the page
paints the territory with the skin's pattern; Knockout and Battleship carry `skin` per player in their state, and the
pages draw it from `shared/shopSkins.js` (Knockout keeps a ring in the team colour so sides stay clear).

Known limit: a pass is not tied to the socket, so a player who copies their pass to a friend lends them the look (no
money moves, the server still checks the pass). A price change closes an open row and re-quotes, and the page refuses
to sign a quote that differs from the price it showed.

## Failure paths

Insufficient USDC (checked before signing, and preflight) -> Add funds. Cancel in the wallet -> nothing
sent, row stays open and expires. Tx failed or timed out -> resume/sweep settle it; the page says
"still confirming" and the toast lands when it does. Double click -> one busy lock in the page, one
conditional UPDATE on the server. RPC 429 -> retry with backoff, sweep paced one row at a time.
Maintenance -> no new purchases.
