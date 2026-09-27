# Paid entry, end to end (notes for the Paper multiplayer build)

Written 2026-09-20 from a read of the live code. Every claim cites `file:line`. Paths are relative to `slither-clone/`.
Scope: how a buy-in travels from the lobby to a seat in a server room, for a game that has its own page. Knockout is the
traced example (Battleship is the same code shape). Cash-out and the arena sim are other notes; they are only pointed at here.

## 0. The model in five sentences

1. The browser never tells the server what a seat is worth. It pays on-chain, the server reads the chain, and the server
   mints an opaque one-time token that carries the server-recorded worth and the verified payer wallet
   (`server/index.js:544-610`, `server/entryStore.js:33-40`).
2. The token lives in THIS server process's memory for 5 minutes (`server/index.js:374`, `383-386`). A restart loses
   every unspent token.
3. The game page echoes the token on its join event. The server consumes it and takes `worth` and `walletAddress` from
   the token only (`server/index.js:395-412`).
4. The socket handshake carries no identity, so the token is also the only proof of who paid
   (`server/entryStore.js:8-14`, `CLAUDE.md` "socket handshake session is EMPTY").
5. A stake signature can mint at most one token ever: `db.markStakeSig` is an atomic `INSERT ... ON CONFLICT DO NOTHING`
   on `used_stake_sigs` (`server/db.js:227-233`).

## 1. The trace: lobby to seat (Knockout, a paid own-page game)

### 1a. Lobby decides "is this a money launch?"

- One door: `launch(game, sel)` in `public/js/v2/play.js:238-308`. `sel` is `{ stake }` (a rung) or `{ lobbyType }` (an old tier).
  A launch that names neither is refused, because the widget would default a missing room to `dime` and charge ten cents
  (`play.js:250-257`, widget default at `wallet-widget/src/main.jsx:344-346`).
- Own-page games are listed in `OWN_PAGE` (`play.js:274`). `paper: '/paper'` is ALREADY in it.
- The split is by AMOUNT, not by game: `staking = hasStake && Number(sel.stake) > 0` (`play.js:280`).
  - Not staking: the lobby itself writes `sessionStorage.playerName`, sets `game-frame.src = OWN_PAGE[game]` and returns
    (`play.js:281-296`). The wallet widget is not involved. NOTE: this path does not write or clear `stake` or
    `entryToken` (see pitfall P3).
  - Staking: the lobby only dispatches `duel:play` with `{ game, stake }` (`play.js:297-307`). "The widget owns the money."
- The widget hears `duel:play` and calls `doStake(game, { stake })` (`wallet-widget/src/main.jsx:335-351`, `476-493`).
  `busyRef` drops rapid re-clicks so one press cannot fire two stakes (`main.jsx:477`).

### 1b. Widget pays (`stakeOnly`, `wallet-widget/src/main.jsx:75-144`)

1. Free short-circuit by price: stake 0 or `lobbyType === 'free'` returns `{ entryToken: '', worth: 0 }` (`main.jsx:79-81`);
   a quote that owes nothing does the same (`main.jsx:99-102`).
2. `GET /api/stake-quote?stake=<rung>` (`main.jsx:84-88`). Server: `stakeRangeError` refuses anything off the ladder,
   stake 0 answers a zero quote, else `money.stakeQuoteFor(stake)` (`server/index.js:513-527`). In USDC mode the quote is
   `{ mode:'usdc', escrowOwner, escrowAta, usdcMint, decimals, amountUsdc, units, blockhash }`
   (`server/money.js:65-69`, `server/Usdc.js:102-104`).
3. Builds an SPL `transferChecked` into the escrow ATA (plus an idempotent create-ATA), fee payer = the player's wallet
   (`main.jsx:104-123`). Privy SIGNS only (`main.jsx:126`).
4. `POST /api/submit-stake { stake, signedTx, walletAddress }` to `regionBase()` (`main.jsx:130-137`). The stake must hit
   the same regional server the game will connect to, because the token is in that server's memory (`main.jsx:58-62`).
5. Returns the SERVER's `{ entryToken, worth, stake }`; the caller must use these, not what it asked for (`main.jsx:138-143`).

### 1c. Server verifies and mints (`POST /api/submit-stake`, `server/index.js:544-610`)

Ladder path (taken when `stake` is present, `index.js:556-588`):

1. `stakeRangeError(want)` and `want === 0` refused ("Free play needs no stake") (`index.js:557-560`).
2. `Wallet.submitStake(rawTx)` broadcasts and polls for `confirmed` (`index.js:563`, `server/Wallet.js:215-227`).
3. `money.verifyStake(sig, money.amountFor(want))` (`index.js:564`). USDC: `Usdc.verifyUsdcStake` reads the confirmed tx's
   pre/post token balances for the escrow owner + USDC mint, requires delta >= 99% of the ask, returns
   `{ payer: accountKeys[0], usdc }` (`server/money.js:71-74`, `server/Usdc.js:109-129`). SOL mode uses
   `Wallet.verifyStakeTransfer` (lamport delta on the escrow account, 5% slippage) (`server/money.js:42-46`,
   `server/Wallet.js:181-195`). Both are pure reads; neither marks anything used.
4. `rung = tierFor(worth)`: the largest rung the payment covers (snap DOWN, never exact match, so a settled overpay still
   buys a seat) (`index.js:565-566`, `server/stakeRules.js:49-55`).
5. `db.markStakeSig(sig)` AFTER verify; false means "Stake already used" (`index.js:568`, `server/db.js:227-233`).
6. `walletAddress` in the body, if present, must equal the verified on-chain payer, else 400 (`index.js:580-582`).
   The payout address is the verified payer, never the request field (`index.js:572-579`).
7. `entryStore.mint({ stake: rung, worth: rung, walletAddress: payer })` (`index.js:583`). Worth is the RUNG, not the raw
   payment, so everyone in a room enters equal; excess stays in escrow (`index.js:569-571`).
8. Response `{ ok, entryToken, worth: rung, stake: rung, paid }` (`index.js:584`).

Tier path (old `lobbyType` door, still used by agar): same steps with `LOBBY_FEES[lobbyType]` and
`mint({ lobbyType, worth, walletAddress: payer })` (`index.js:590-609`). Paper should NOT use this door.

Rate limit: `entryFeeLimiter` is ONE limiter instance (10 requests / 60 s / IP) shared by quote and submit
(`index.js:359`, `513`, `544`), so roughly 5 paid entries per minute per IP.

### 1d. The token store (`server/entryStore.js`)

- `mint` refuses a stake that is off the ladder (`entryStore.js:33-40`); token = `crypto.randomUUID()`, TTL from
  `ENTRY_TOKEN_MAX_AGE_MS` = 5 min (`index.js:374`, `383-386`).
- `consumeAtStake(token, stake)` (`entryStore.js:46-55`): non-finite or negative stake refused; stake 0 returns
  `{ ok:true, worth:0 }` with no token; otherwise the token must exist, be unexpired, have a numeric `stake` equal to the
  asked stake within 1e-9, and is DELETED on success. Returns `{ ok, worth, googleId, walletAddress }`.
- `consume(token, shortType)` is the tier door: free BY FEE (`!fees[shortType]`), not by the name `free`
  (`entryStore.js:61-74`).
- The two doors do not cross: a tier token has no numeric `stake`, a ladder token has no `lobbyType`
  (`entryStore.js:51`, `71`; tests `test/entryStore.test.js:150`, `159`).
- Wrappers in index.js: `consumePaidEntryAtStake(entryToken, stake, game)` and `consumePaidEntry(entryToken, shortType, game)`
  both pass through `recordEntry`, which writes `db.recordStake(wallet, worth, game)` fire-and-forget
  (`index.js:395-412`, `server/db.js:322-329`). The `game` string is ONLY a label on the stats row. The token itself is
  not bound to a game (see P2).

### 1e. Hand-off to the game page (`stakeAndPlay`, `main.jsx:181-234`)

The widget writes `sessionStorage` then points the iframe at the page:

| key | value | line |
|---|---|---|
| `playerName` | saved name or short wallet | `main.jsx:187` |
| `googleId`, `walletAddress` | the Privy Solana address | `main.jsx:188-189` |
| `stake` | the SERVER's rung (`lobbyType` removed) | `main.jsx:195-197` |
| `entryToken` | the one-time token | `main.jsx:202` |
| `entrySol` | worth (display only, never trusted) | `main.jsx:203` |
| `region` | `duelseries_region` or `na` | `main.jsx:204` |

Then `PAGES = { agar, knockout, battleship, snake }` picks the page, default `/game.html`, and sets `game-frame.src`
(`main.jsx:216-230`). There is NO `paper` entry today, in source or in the built bundle (`public/wallet/widget.js`
contains the same four-key map). See P1.

### 1f. Game page joins (`public/js/knockout.js`)

- `const socket = io();` same origin (`knockout.js:20`).
- Reads `playerName`, `localStorage.duelseries_wallet`, `stake`, `entryToken` once at load (`knockout.js:65-83`).
- On every socket `connect` it calls `queue()`, which emits
  `ko:queue { name, wallet, stake, entryToken }` and then removes `entryToken` from sessionStorage
  (`knockout.js:512-536`).
- Leaves via `postMessage('game:done')` to the parent lobby (`knockout.js:639-645`); the lobby hides both frames and
  refreshes the wallet (`play.js:427-433`); the widget un-hides itself (`main.jsx:321-325`).

### 1g. Server seats the player (`ko:queue`, `server/index.js:2601-2632`)

1. `socketRL(socket,'koq',1000)` then the maintenance gate (`index.js:2602-2603`).
2. `wants = Number(stake) || 0`. If `wants > 0`: `consumePaidEntryAtStake(entryToken, wants, 'knockout')`; not ok means
   `ko:refused` and return, never a quiet free seat (`index.js:2610-2617`).
3. `worth = entry.worth`, `rung = wants`, `socket._walletAddress = entry.walletAddress` (`index.js:2618-2620`).
   `socket._walletAddress` is only ever assigned from a consumed token, in six places (`index.js:2127`, `2376`, `2441`,
   `2620`, `2676`, `2760`).
4. `knockoutLobby.enqueue(socket, name, wallet || socket._walletAddress || null, rung, worth)` (`index.js:2623-2624`);
   note the client-claimed `wallet` wins here (see P5).
5. `ko:queued { stake, worth, paidWaitMs }` back to the client (`index.js:2625-2631`).

Battleship is line-for-line the same (`index.js:2665-2686`).

### 1h. What the lobby object does with the money (`server/KnockoutLobby.js`, `server/KnockoutRoom.js`)

- The queue entry stores `stake` and `worth` (`KnockoutLobby.js:96-103`). Seats are matched by rung only (`134-148`).
- PAID TABLES NEVER GET A BOT: guarded in `tick` (`KnockoutLobby.js:161-166`) and again in `makeMatch` (`228-231`).
- Every exit from a paid queue refunds once: `refund()` sets `entry.refunded` then calls `onRefund`
  (`KnockoutLobby.js:260-270`); `leave()` refunds a waiting seat (`277-288`); `ko:unqueue` calls `leave()` not `dequeue()`
  (`index.js:2634-2640`); socket `disconnect` calls `knockoutLobby.leave` (`index.js:2828-2834`).
- The room holds `worth` per socket and reports `pot()` (`KnockoutRoom.js:145`, `154-158`, `165-167`); it decides WHO won
  and calls `onSettled({ roomId, winnerId, why, pot, seats })` (`KnockoutRoom.js:545-556`).
- index.js owns moving money: `knockoutLobby.onSettled` pays pot minus 10%, once per room id (`_koPaid`), draw refunds
  each seat its own stake with no cut (`index.js:1159-1190`); `onRefund` (`1231-1235`); `koSend` wraps
  `money.withdraw` + `db.recordEarnings`, and on failure `db.recordFailedPayout` with NO retry (`index.js:1240-1253`).

### 1i. Re-buying without leaving the page (snake's bridge; Knockout does not have one)

- `requestRestake(game)` posts `{ type:'duel:restake', game, lobbyType, stake }` to the parent and waits for
  `duel:restake:done { entryToken }` or `duel:restake:error` (120 s safety timeout) (`public/js/game.js:2031-2046`).
- The widget answers it: runs `stakeOnly` for the same rung and posts the fresh token back to `agar-frame` if
  `d.game === 'agar'`, else `game-frame` (`main.jsx:355-378`). Any non-agar game name works with no widget change.
- Snake respawn: `doRespawn` re-stakes when `isPaidRoom`, then emits `RESPAWN { entryToken }` (`game.js:2050-2070`).
  Server `RESPAWN` re-buys the room the socket is ALREADY in using `socket._stake`, never a stake sent now
  (`index.js:2349-2384`, the rule at `2360-2363`).
- `isPaidRoom` is decided by amount or by the shared free LIST, never `lobbyType !== 'free'` (`game.js:26-33`).

## 2. How lobbies and stakes are named and resolved (server)

| thing | where | notes |
|---|---|---|
| Fee table `FEES = { free:0, br:0, dime:0.10, dollar:1.00 }` | `server/money.js:23` | exported as `money.lobbyFees`, aliased `LOBBY_FEES` (`index.js:365`). Its KEYS validate a tier name. `br` is in it at 0 on purpose (`money.js:17-22`). |
| Stake ladder `STAKE_TIERS = [0.10, 1]`, `ALL_STAKES = [0, 0.10, 1]` | `server/stakeRules.js:36-41` | closed set; compared as integer cents (`45-46`); `tierFor` snaps down (`49-55`); `stakeRangeError` (`59-69`). The comment at `index.js:376` listing nine rungs is STALE. |
| Fixed tier rooms `gameRooms[rgn] = { free, dime, dollar, br }` named `na_free`, `na_dime`, `na_dollar`, `na_br` | `index.js:1264-1273` | the three non-br ones are `fallbackOnly` (`1274-1288`). Only THIS region's rooms are built (`1132-1138`). |
| Agar rooms `agar_na_free|dime|dollar` | `index.js:1326-1330` | still on the tier door (`cell:join`, `index.js:2422-2453`). |
| Ladder rooms via `LobbyRegistry`, key `game:region:stake.toFixed(2)`, room named `na_s0`, `na_s0_1`, `na_s1` | `server/LobbyRegistry.js:31-54`, `index.js:1599-1619` | made on demand, `room.stake` set on the room (`1604-1607`), free rung opened at boot (`1619`), swept after 5 min empty except stake 0 (`LobbyRegistry.js:84-95`, `index.js:1964`). `hold()` exists but nothing calls it. |
| Join resolution | `getRoomForJoin` `index.js:1627-1633` | a valid `stake` wins and goes to `ladder.get('snake', ...)`; otherwise `getRoomForType`, whose unknown-name fallback is the free tier and logs loudly (`1641-1674`). |
| Snake `PLAY` | `index.js:2050-2140` | duplicate-while-alive ignored BEFORE any token is consumed (`2052-2055`); `socket._stake` remembered (`2085`); token door chosen by `byStake` (`2114-2116`); `room.addPlayer(..., entry.worth)` (`2131`). |
| Lobby board `/api/live` | `index.js:1351-1382`, `1491-1502` | `lobbies` = one row per rung, SNAKE ONLY (`l.game === 'snake'` filter at `1362`); `stakes: ALL_STAKES`; `extras` = free counts for agar, shooter, tanks, knockout, battleship (`1390-1446`). There is no Paper row or extra today. |
| Solvency liability | `sumLiveSelfCustodyStakes` `index.js:1702-1728` | sums ladder rooms + `gameRooms` (via `room.snakes` / `room.players`) + agar. Knockout and Battleship pots are NOT counted. `checkSolvency` every 60 s (`1735-1750`). |

The `ladder` registry is assumed snake-only in three places: its `makeRoom` always builds a `GameRoom` and ignores
`game` (`index.js:1602-1609`), `ALL_SNAKE_ROOMS` pushes every ladder room (`index.js:813-822`), and the solvency sum
walks `l.room.snakes` (`index.js:1704-1715`).

## 3. The rule: ask what it costs, never what it is called

Source: `server/GameRoom.js:76-107`. `isFree()` returns `Number(this.stake) === 0` when the room carries a stake, and only
falls back to the shared list `C.FREE_LOBBY_TYPES = ['free','br']` (`shared/constants.js:254-262`) for a fixed tier room.
`botsAllowed()` is `isFree()`. The comment records that reading free/paid out of a room NAME has broken seven times
(`na_br` read as paid, `na_s0` read as paid, `'na_free' !== 'free'` ranking free rooms by worth).

The same rule is applied on every layer:
- token store: free by FEE (`entryStore.js:63-69`)
- widget: free by PRICE of the quote (`main.jsx:90-102`)
- lobby: money path chosen by AMOUNT (`play.js:275-281`)
- snake client: paid decided by stake or the free LIST (`game.js:26-33`)
- Knockout: `room.stake > 0` and `entry.stake > 0` guard bots (`KnockoutLobby.js:161`, `193-196`, `231`)

For Paper: give the arena a numeric `stake` property at construction and have every "is this paid?" question
(bots, leaderboard ordering, cash-out UI, liability) read that number. Never parse the room id.

## 4. What a new Paper room must do to fit in (paid-entry checklist)

1. Join event (suggested `paper:join { name, stake, entryToken }`): rate-limit with `socketRL`, check maintenance, do the
   duplicate/already-alive check, THEN `consumePaidEntryAtStake(entryToken, stake, 'paper')`. Refuse with a visible
   reason when `!entry.ok`. Pattern: `index.js:2601-2621` and `2052-2055`.
2. Take worth from `entry.worth` only, payout wallet from `entry.walletAddress` only, and set `socket._walletAddress`
   from the token. Remember the rung on the socket (like `socket._stake`, `index.js:2085`).
3. Respawn in a paid arena = a new buy-in (brief, "Decisions"): consume a NEW token against the rung remembered on the
   socket, never a stake in the respawn message (`index.js:2360-2370`). Client side, reuse the `duel:restake` bridge
   (`game.js:2031-2046`, `main.jsx:355-378`).
4. Resolve the arena from a validated rung: `isStake(stake)` (`stakeRules.js:46`), key by `toFixed(2)`
   (`LobbyRegistry.js:31-33`). Use a SEPARATE registry or fixed per-rung arenas for Paper, not the snake `ladder`
   instance (section 2, last paragraph).
5. A paid player who has been charged must always get a seat or a refund. With a 16-player cap, either open another
   arena for that rung when full, or refund through a `koSend`-style one-time path (`index.js:1240-1253`,
   `KnockoutLobby.js:260-270`). Decide before consuming where possible.
6. No bots where `stake > 0`, guarded inside the room as well as at the caller (`GameRoom.js:102-107`,
   `KnockoutLobby.js:228-231`).
7. Add Paper's live money (every alive square's worth PLUS every cash pickup lying on the map) to
   `sumLiveSelfCustodyStakes` (`index.js:1702-1728`). The brief requires this; Knockout is not a precedent.
8. Lobby wiring: add `paper` to the widget `PAGES` map (`main.jsx:217`), run `npm run build`, and commit
   `public/wallet/widget.js` (it is tracked in git and the deploy does not build: `.github/workflows/deploy.yml:34-35`
   runs only `npm install --production` and `pm2 restart`). Point `OWN_PAGE.paper` (`play.js:274`) and `PAGES.paper` at
   the same multiplayer page.
9. Lobby catalogue: the Paper card is `built:1, solo:1` today (`public/v2.html:2165-2167`), and `startFromDetail`
   sends every `built && (duel || solo)` game to `{ lobbyType:'free' }` regardless of the rung picked
   (`v2.html:3302-3312`). To sell $0.10 and $1.00 seats the card must stop being `solo` and the Play button must reach
   `V2Play.launch('paper', { stake: STEPS[si] })` or `playChosen()`. `playChosen()` only finds a room if `/api/live`
   `lobbies` has a row with `game:'paper'` at that stake (`play.js:320-359`), and `refreshSteps` strikes every rung for a
   game with no rows unless it is flagged `paid` (`v2.html:2204-2223`). Also replace the pinned `paper:free` row
   (`public/js/v2/board.js:127-130`) and add a Paper entry to `liveExtras` or `liveBoard`.
10. Tests to copy the shape of: `test/entryStore.test.js` (token doors), `test/knockoutMoney.test.js` (no bot on a paid
    table, settle once, refund once), `test/stakeRules.test.js`, `test/lobbyRegistry.test.js`.

Adjacent, owned by other notes: the held cash-out is server-timed (`index.js:2142-2207`, `C.CASHOUT_HOLD_MS` = 3000 at
`shared/constants.js:22`); payout is `doCashout` (`index.js:2209-2264`): zero the worth first, 10% via `trackEarning` +
`sweepRake` (`index.js:35`, `47`), 90% via `money.withdraw`, `db.recordEarnings` only after the tx lands,
`db.recordFailedPayout` on failure with no retry. Value transfers between accounts go to
`collusion.record(srcId, dstId, amount, { lobbyType })` (`server/CollusionMonitor.js:42`, call sites
`GameRoom.js:564`, `AgarRoom.js:512`).

## 5. Pitfalls found while reading (each verified in code)

- P1. A paid Paper launch today would open the SNAKE page. `PAGES[game] || '/game.html'` (`main.jsx:217-219`) has no
  `paper` key, and `game.js` would happily spend the $0.10 token in the snake rung. Fix the map and rebuild the widget
  before any paid Paper button exists.
- P2. Tokens are not game-bound. `consumeAtStake` checks only the stake (`entryStore.js:46-55`); the `game` argument is a
  stats label (`index.js:401-411`). A $0.10 token bought from the Paper card opens the $0.10 snake, Knockout or
  Battleship seat and vice versa. Worth is equal so escrow is not harmed, but do not assume "this token was bought for
  Paper". If binding is wanted it is a change to `mint`/`consumeAtStake` plus `/api/submit-stake` and needs its own tests.
- P3. Stale `sessionStorage`. The free own-page launch writes only `playerName` (`play.js:281-296`). `stake` and
  `entryToken` from an earlier PAID game in the same tab survive (only `knockout.js:535` and `battleship.js:754` remove
  the token; `game.js` never does; nothing clears `stake` except the widget and `spectate`, `play.js:370`). A page that
  reads `stake` at load can then ask for a paid seat with a burned token and be refused. The Paper free path must set
  `stake` to `0` and remove `entryToken`, or the page must be told its rung another way.
- P4. Knockout re-sends its load-time token on every socket `connect` and on Play again (`knockout.js:81-83`,
  `512-536`, `648-654`), and has no restake bridge, so a paid reconnect or rematch is refused with "that buy-in was not
  paid for". Paper must not copy this: join once per token, handle reconnect separately, and re-stake through the bridge.
- P5. Knockout passes `wallet || socket._walletAddress` to the lobby (`index.js:2623-2624`), so the CLIENT-claimed wallet
  wins over the verified payer as the payout address. That contradicts the rule written at `index.js:572-579`. For Paper,
  pay out only to `entry.walletAddress` (snake does this: `index.js:2127`, `2237-2242`).
- P6. Consume order. Snake ignores a duplicate `PLAY` before consuming (`index.js:2052-2055`). Any check that can refuse
  a join (already alive, arena full, match locked) must run BEFORE `consumePaidEntryAtStake`, because a consumed token
  is gone and the stake is already on-chain.
- P7. Maintenance is checked on the join events only (`index.js:2072`, `2603`, `2667`), not on `/api/stake-quote` or
  `/api/submit-stake` (`index.js:513-610`). A player can pay during maintenance, be refused at the door, and hold a
  token that expires in 5 minutes with no refund path. Existing gap; do not widen it. Cheapest fix is refusing the quote.
- P8. `markStakeSig` runs BEFORE the payer/`walletAddress` mismatch check (`index.js:568` then `580-582`), so a mismatch
  burns the signature and mints nothing. The real widget always sends the fee payer, so this only bites a custom client.
- P9. Tokens are in one process's memory with a 5 minute TTL (`index.js:374`, `383-386`). A deploy (pm2 restart) between
  pay and join loses the token. Stake and join must hit the same regional server (`main.jsx:58-62`).
- P10. `entryFeeLimiter` is shared by quote and submit at 10/min/IP (`index.js:359`). A Paper player dying and re-buying
  more than about five times a minute will be told to slow down by the stake endpoints.
- P11. The worth minted is the RUNG, not the raw payment (`index.js:569-571`, `583`). Display and liability maths should
  use `entry.worth`; do not reconstruct it from the client's `stake` or from `entrySol` in sessionStorage.
- P12. `consumeAtStake` with stake 0 succeeds with no token (`entryStore.js:49`). A join handler that computes
  `wants = Number(stake) || 0` (`index.js:2611`) turns NaN, negative and junk into a FREE seat, which is safe only if
  the free arena is a different room object from the paid ones. Pick the room from the same validated number you
  passed to the token door.
- P13. `liveBoard` and the lobby's `LOBBIES` list are documented as snake-only (`index.js:1351-1363`, `1387-1389`;
  `board.js:150`). Adding `game:'paper'` rows is what makes `playChosen` and `refreshSteps` work for Paper, but check
  `board.js:141-160` and `v2.html:3217-3250` render them sensibly (the detail screen's free row launches
  `{ stake: 0 }`, `v2.html:3237`, which for Paper takes the no-widget path in `play.js:281`).
- P14. Putting Paper rooms in the existing `ladder` registry would make `sumLiveSelfCustodyStakes` throw on
  `room.snakes` (`index.js:1704-1715`); the throw is swallowed by `checkSolvency`'s catch (`index.js:1747-1749`) and the
  solvency monitor would silently stop working.
