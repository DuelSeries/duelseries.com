# Paper multiplayer: how cash-out and money bookkeeping work today

Written 2026-09-20 from a read of the live code. Every claim cites `file:line`. Line numbers are as of this date.
Audience: the engineer building the server-run Paper room. Binding rules are in `docs/paper-multiplayer-brief.md`.

Short version: **the room decides WHO and WHEN, `server/index.js` moves the money.** That seam already exists twice
(battle royale `onWinnerCashout`, `server/index.js:1289-1324`; Knockout `onSettled`, `server/index.js:1145-1190`). Paper
should be the third user of it, not a fourth copy of the payout code.

---

## 0. The plug-in checklist (everything a Paper room must touch)

| # | System | Existing function | File:line | What Paper must do |
|---|--------|-------------------|-----------|--------------------|
| 1 | Paid entry | `consumePaidEntryAtStake(token, stake, game)` or `consumePaidEntry(token, shortType, game)` | `server/index.js:395-412` | Call with `game = 'paper'`. Take `worth` and `walletAddress` ONLY from the returned object. |
| 2 | Maintenance gate | `ops.get().maintenance` | `server/index.js:2072-2075`, `2603` | Refuse the join and emit `'maintenance'` BEFORE consuming the token. |
| 3 | Hold to cash out | `cashout:start` / `cashout:cancel` / timer | `server/index.js:2147-2207` | Server owns the 3 s clock. Use `C.CASHOUT_HOLD_MS` (`shared/constants.js:22`). Lock movement server-side. |
| 4 | Payout | `doCashout()` | `server/index.js:2209-2264` | Same sequence: zero worth synchronously, 10% rake, `money.withdraw`, earnings on success, failed-payout row on failure. |
| 5 | Rake ledger | `trackEarning(opts)` and `sweepRake(amount, label)` | `server/index.js:35-38`, `47-55` | `game: 'paper'`, `source: 'game_rake'`. |
| 6 | Earnings | `db.recordEarnings(id, name, amount, fiat)` | `server/db.js:310-317` | Only after the on-chain payout resolves. |
| 7 | Failed payout | `db.recordFailedPayout(wallet, amount, name, reason, broadcast)` | `server/db.js:239-247` | Pass `e.broadcast` through. Never auto-resend yourself. The drainer does it (`server/index.js:1972-1996`). |
| 8 | Solvency | `sumLiveSelfCustodyStakes()` | `server/index.js:1702-1728` | ADD a Paper term: live human worth PLUS cash pickups on the floor. |
| 9 | Collusion | `collusion.record(src, dst, amount, { lobbyType })` | `server/CollusionMonitor.js:42-52` | Call on every kill transfer and every pickup collected. |
| 10 | Drain status | `ops.drainStatus(ALL_ROOMS())` | `server/ops.js:57-77`, `server/index.js:823-835` | Add Paper arenas to `ALL_ROOMS` AND make them countable (see section 9). |
| 11 | Disconnect | main `disconnect` handler | `server/index.js:2828-2873` | Add a Paper branch: clear the hold, drop worth as a pickup, remove the unit. |
| 12 | Bots rule | `isFree()` / `botsAllowed()` | `server/GameRoom.js:76-107` | Bots only when the arena's stake is 0. Ask the room what it costs, never read its name. |

---

## 1. Where worth comes from (entry)

1. Client stakes on-chain, then `POST /api/submit-stake` (`server/index.js:544-610`).
   - Ladder path (`stake` in the body, `:556-588`): `money.verifyStake(sig, money.amountFor(want))` then `tierFor(worth)`
     snaps DOWN to the largest rung covered; `db.markStakeSig(sig)` claims the signature one time (atomic
     `INSERT ... ON CONFLICT DO NOTHING`, `server/db.js:227-233`); token minted with **`worth: rung`** and
     `walletAddress: payer` (`:583`). The payer is the verified on-chain fee payer, and a mismatching client
     `walletAddress` is refused (`:580-582`).
   - Tier path (`lobbyType` in the body, `:590-609`): same checks, but the token carries **`worth` = the actual on-chain
     delta** (`:596`, `:605`), which can be 0.099 to 0.10x because `verifyStake` tolerates 1% (`server/money.js:71-74`).
2. The rungs are `[0.10, 1]` plus free (`server/stakeRules.js:36-38`). The tier table agrees: `{ free: 0, br: 0, dime: 0.10,
   dollar: 1.00 }` (`server/money.js:23`). (The comment at `server/index.js:376` listing nine rungs is stale.)
3. Tokens: `server/entryStore.js`. One-time (`tokens.delete` at `:53`, `:72`), 5 minute TTL
   (`server/index.js:374`, `383-386`). `consumeAtStake` returns `{ ok: true, worth: 0 }` for stake 0 with no token
   (`entryStore.js:49`). `consume` treats any zero-fee type as free (`:69`). A token has NO game field, so a token bought
   for a $0.10 snake seat also opens a $0.10 Paper seat. That is fine (same price, one use) but means `game` is stats only.
4. `recordEntry` (`server/index.js:401-412`) writes `db.recordStake(wallet, worth, game)` fire-and-forget. It is inside
   `consumePaidEntry*`, so Paper gets it for free by passing `'paper'`.
5. The join handler stores the results on the SOCKET: `socket._walletAddress = entry.walletAddress`
   (`server/index.js:2127`), `socket._googleId`, `socket._stake`, `socket._room`, `socket._joinTime`.
   `room.addPlayer(socket, name, wallet, color, entry.worth)` sets `snake.worth = entrySol || 0`
   (`server/GameRoom.js:235-242`).

**Recommendation for Paper:** use the LADDER path (`stake: 0 | 0.10 | 1`) so everybody's entry worth is exactly the rung
(`:569-571` explains why: the take-all rule must be symmetric). The label over the head then reads exactly `$0.10`.

**Respawn is a new buy-in.** `RESPAWN` consumes a fresh token against the room the socket is ALREADY in
(`socket._stake`, never a client value), `server/index.js:2349-2384`. Paper must do the same.

---

## 2. How worth is tracked and transferred today

Two existing models. Paper needs a bit of each.

### Snake: money always hits the floor
- `snake.worth` is a float on the server entity (`server/Snake.js:89`), serialised to clients (`server/Snake.js:535`).
- Death (`GameRoom.killSnake`, `server/GameRoom.js:694-717`): `cashPerDrop = snake.worth / drops.length`; each drop is
  spawned as food with `cashValue` and tagged `f._srcGid = <victim account id>` (`:707-716`). The killer gets NOTHING
  directly. `killerId` is only used for the death card and kill feed (`:719-748`).
- Pickup (`server/GameRoom.js:556-565`): `snake.worth += food.cashValue`, then
  `collusion.record(food._srcGid, eaterGid, food.cashValue, { lobbyType })`.
- Cash on the floor is never culled (`server/Food.js:173-190`).
- `snake.worth` is NOT zeroed on death. It is harmless there only because every reader also checks `alive`.

### Agar: direct transfer on eat
- `player.worth` on the room's player record, with `googleId` stored ON the record
  (`server/AgarRoom.js:115-133`).
- Eat (`server/AgarRoom.js:506-513`): `eater.worth += share; target.worth -= share;` then
  `collusion.record(target.googleId, eater.googleId, share, { lobbyType: this.roomName })`.
- `AgarRoom.removePlayer` (`:150-159`) just deletes the player. **Their worth vanishes** (stays in escrow, owed to nobody).
  Paper must NOT copy this: brief rule 5 says a disconnect drops the money on the map.

### What Paper does (brief rules 2 and 5)
- Kill WITH a killer: `killer.worth += victim.worth; victim.worth = 0;` in one synchronous step, then `collusion.record`.
  The single choke point in the sim is `Game.kill(victim, killer, reason)` (`public/js/paper/paperGame.js:341-372`).
  Killer is set for track cut (`public/js/paper/paperTerritory.js:240`), encircled and exit point captured
  (`public/js/paper/paperGameMoves.js:197`, `:200`).
- Kill with NO killer: self cross or wall (`public/js/paper/paperTerritory.js:233-237`). Spawn ONE pickup at the death
  position carrying `{ value: victim.worth, srcAccount: victimAccount }`, then zero the victim.
- On pickup: `collector.worth += pickup.value`, `collusion.record(pickup.srcAccount, collectorAccount, value, ...)`,
  delete the pickup. All in one synchronous step.
- Two more killer-less kills exist in the solo sim and have money consequences. Decide them explicitly:
  `REASON_SYSTEM_REMOVED` eviction of the middle unit when the arena is full (`paperGame.js:232-238`) and `REASON_WIN`
  (`paperGame.js:320-328`). In a paid arena the eviction would kill a staked human to seat a joiner. It must be
  unreachable there (see pitfalls).

**Conservation invariant to test:** at every tick,
`sum(alive human worth) + sum(pickup value) == sum(entry worth admitted) - sum(gross cashed out)`.
Track worth in integer micro-USDC (or cents) inside the room if you can. The existing code uses floats
(`0.1 + 0.2 !== 0.3`, noted at `server/stakeRules.js:43-45`); payouts are safe only because `Usdc.toUnits` rounds to 6
decimals (`server/Usdc.js:40`).

---

## 3. Hold to cash out

### Client (snake, `public/js/game.js`)
- Q keydown, not repeat, not dead, not typing in chat: `startQTimer()` (`:1866-1872`). Keyup: `cancelQTimer()` (`:1873-1877`).
- `startQTimer` (`:1699-1721`): emits `'cashout:start'`, runs a 30 ms interval to paint the ring, and at 3 s calls
  `triggerCashOut()` which emits the legacy `'cashout'` (`:1732-1739`).
- `cancelQTimer` emits `'cashout:cancel'` (`:1723-1730`).
- Touch: a hold button wired with touchstart/touchend/touchcancel to the same two functions (`:1656-1673`). The brief
  requires the same for Paper.
- Rings over OTHER players' heads come from `'cashout:started'` / `'cashout:cancelled'` broadcasts (`:1741-1746`).
- Receipt: `'cashout:result'` (`:1792-1849`), then `'cashout:paid'` with the tx sig or `'cashout:error'` (`:1854-1864`).
- The client values are animation only. The comment at `:1675-1679` says so, and the server enforces it.

### Server (`server/index.js:2142-2207`)
- `cashout:start` (`:2152-2181`): requires a live snake, refuses if already holding, stamps
  `snake.cashoutStartedAt = Date.now()`, arms `socket._cashoutTimer = setTimeout(doCashout, C.CASHOUT_HOLD_MS)`, and
  broadcasts `'cashout:started' { id }` to the room plus an echo to self. **The server completes the hold itself**; it does
  not wait to be told (`:2168-2174` explains why: the client clock runs about one trip ahead, and a tolerance is exactly
  what a cheat would aim at).
- `cashout:cancel` (`:2183-2189`): clears the stamp and the timer, broadcasts `'cashout:cancelled'`.
- A small extra `disconnect` handler clears the hold (`:2191-2192`).
- Legacy `'cashout'` (`:2197-2207`): rate limited 1 s, grants nothing unless `Date.now() - cashoutStartedAt >= CASHOUT_HOLD_MS`.
- The penalty is server-side too: `Snake.speedMult` ramps to `CASHOUT_MIN_SPEED_MULT` (0.2) from the server's own stamp
  (`server/Snake.js:137-143`); the client's speed multiplier is no longer read (`server/index.js:2275-2280`).
- Test that attacks this for real: `test/cashoutHold.test.js`.

### Paper differences
- Brief rule 3: movement is LOCKED (speed 0), not slowed. Agar has a lock precedent (`AgarRoom.lockPlayer`,
  `server/AgarRoom.js:190-200`), but see the pitfall about agar's cash-out below.
- Prefer a TICK-DRIVEN hold inside the room over a per-socket `setTimeout`: store `unit.cashoutStartedAt`, freeze the unit
  while it is set, and let the room's tick fire `this.onCashout(playerId)` once `now - cashoutStartedAt >= CASHOUT_HOLD_MS`
  and the unit is still alive. Death then voids the hold automatically, which the snake's timer does not (pitfall 2).
- Use namespaced events (`paper:cashout:start`, `paper:cashout:cancel`, `paper:cashout:result`, ...) and a separate
  `socket._paperRoom`. The snake handlers key off `socket._room.snakes` (`:2162-2165`); sharing `socket._room` would run
  them against a Paper room. Agar does exactly this separation (`socket._agarRoom`, `cell:` prefix,
  `server/index.js:2430`, `2778`).

---

## 4. The payout, step by step (`doCashout`, `server/index.js:2209-2264`)

1. Resolve `room`, `snake`; return unless `snake.alive` (`:2210-2213`).
2. **Synchronously**: `const worth = snake.worth; snake.worth = 0; snake.alive = false;` (`:2214-2217`). This is the
   double-pay guard. Any second call finds a dead, worthless snake. Nothing async happens before it.
   The snake is removed with NO drops and NO kill credit (matches the brief's "leaving by cash-out").
3. `HOUSE_CUT = 0.10`; `ownerShare = worth * 0.10`; `playerShare = worth - ownerShare` (`:2221-2223`).
4. If `worth > 0`: `trackEarning({ source: 'game_rake', game: 'slither', amountUsdc: ownerShare, wallet, name,
   lobbyType, region: REGION })` and `sweepRake(ownerShare, label)` (`:2226-2233`).
   - `trackEarning` = `db.recordHouseRevenue(opts)` + `analytics.captureEarning(opts)` (`:35-38`;
     `server/db.js:335-343`).
   - `sweepRake` actually MOVES the 10% out of escrow to `REVENUE_WALLET` (`:42-55`). CLAUDE.md says the cut "stays in
     escrow"; the code sweeps it. So escrow holds almost exactly the live stakes with no cushion, which is why the
     solvency sum must be exact. A failed sweep is queued with `db.recordFailedPayout(REVENUE_WALLET, ..., 'rake-sweep', ...)`.
5. If `socket._walletAddress`: emit `'cashout:result' { newBalance: null, earnedSol: playerShare, gross: worth,
   cut: ownerShare, score, length, toWallet: true }` immediately (`:2240`), then if `worth > 0`:
   `money.withdraw(wallet, playerShare)` (`:2242`)
   - success: `db.recordEarnings(wallet, name, playerShare, money.fiatValue(playerShare))` and emit
     `'cashout:paid' { sol: playerShare, sig }` (`:2243-2249`). Earnings count only once the payout lands.
   - failure: log CRITICAL, `db.recordFailedPayout(wallet, playerShare, name, 'snake <lobby>: <msg>', e.broadcast)`, emit
     `'cashout:error'` (`:2250-2256`). No inline retry: "a re-send could double-pay".
6. No wallet: emit a zero-value `'cashout:result'` (`:2261-2263`). Note this runs AFTER worth was zeroed (pitfall 1).
7. `socket._doCashout = doCashout` exposes the same function to the BR seam (`:2266-2273`), which re-checks
   `sock._room === room` before calling it (`:1312-1320`).

### `money.withdraw` and retries
- `server/money.js:75` routes to `Usdc.withdrawUsdc` (USDC is the default mode, `:13`, `:83`).
- `withdrawUsdc` (`server/Usdc.js:226-236`): builds and signs one tx (`buildSignedUsdcPayout`, `:196-222`: checks escrow
  balance, creates the recipient ATA if missing, amount via `toUnits`, throws if `amount <= 0n`), then
  `sendRawTransaction` and `confirmTransaction`, each inside `withRetry(..., 6)`.
- `withRetry` (`server/Usdc.js:60-72`) retries only transient RPC errors (429/502/503/504, timeouts, resets) with
  backoff 600 ms doubling to 8 s. Re-sending the SAME signed bytes is idempotent.
- On failure it attaches `e.broadcast = { signature, signedTx, blockhash, lastValidBlockHeight }` (`:233`). If the BUILD
  step throws (for example "Escrow USDC too low"), `e.broadcast` is undefined and the row is stored without a tx.
- SOL mode mirrors this (`server/Wallet.js:60-66`, `129-136`).

### The drainer (`server/index.js:1967-1996`)
- NA only, every 30 s, up to 5 rows: `db.claimDuePayout(30, 200)` (`FOR UPDATE SKIP LOCKED`, `server/db.js:260-277`),
  `money.attemptPayout(row, onFreshTx)` (`server/Usdc.js:269-288`: re-broadcast the same bytes while the blockhash is
  valid, build a fresh tx only once the old one provably expired, persist it via `db.savePayoutSignature` BEFORE
  sending), then `db.markPayoutPaid` and `db.recordEarnings` on recovery (`:1979-1984`).
- Paper gets this for free by writing the same `failed_payouts` row.

### Data each function expects
| Function | Arguments |
|---|---|
| `money.withdraw(toAddress, amount)` | base58 wallet string, amount in the active unit (USDC). Resolves to the tx signature. |
| `db.recordEarnings(id, name, amount, fiat)` | `id` = wallet address (the `accounts.google_id` key), display name, amount in unit, `money.fiatValue(amount)`. |
| `db.recordFailedPayout(wallet, amount, name, reason, broadcast)` | reason is cut to 500 chars; `broadcast` may be undefined. |
| `trackEarning({ source, game, amountUsdc, wallet, name, lobbyType, region })` | signed amount; positive is revenue. |
| `sweepRake(amountUsdc, label)` | no-op unless `> 0`. |
| `db.recordStake(wallet, amount, game)` | called for you inside `consumePaidEntry*`. |

---

## 5. Solvency monitor

- `sumLiveSelfCustodyStakes()` (`server/index.js:1702-1728`) sums, for THIS server:
  - every ladder room (`ladder.rooms.values()`, `:1715`) and every `gameRooms[rgn][lt]` (`:1716-1719`) via `sumRoom`:
    alive snakes whose `room.players.get(sid).socket._walletAddress` is set, `+= snake.worth` (`:1704-1710`);
  - every agar room: alive players with `worth > 0` (`:1720-1725`).
- Cross-region: EU pushes `liveStakesSol: sumLiveSelfCustodyStakes()` to NA (`pushStatsToNA`, `:345-355`); NA stores it
  in `remoteStats` (`:334-341`); `totalLiveStakesSol()` adds local + remote (`:1732-1734`).
- `checkSolvency()` (`:1735-1750`): `money.escrowBalance()` minus `totalLiveStakesSol()`; if short by more than 1e-6 it
  logs `[SOLVENCY] SHORTFALL` and emits `'admin:solvency_alert'` to the owner socket. Scheduled every 45 s
  (`everyStaggered(checkSolvency, 45000, 3000, 'solvency')`, `:1955`) and once at boot (`:1956`).
- Other readers of the same sum: `/admin/finance` (`:443-456`), `/api/admin/solvency` (`:645-649`), the EU push (`:351`).

**What is NOT counted today (do not repeat this for Paper):**
- Cash lying on the floor in the snake game. A dead snake's worth becomes `cashValue` food and the sum only walks alive
  snakes, so that money drops out of liability until somebody eats it.
- Knockout and Battleship stakes held in a queue or a running match. There is no term for them in `:1702-1728`.
- A reattached snake (pitfall 1), because the new socket has no `_walletAddress`.

**Paper term to add** inside `sumLiveSelfCustodyStakes`: for every Paper arena on this server,
`total += arena.liveStakeTotal()` where that returns `sum(alive human unit worth) + sum(pickup value)`. Expose it as a
method on the room so index.js does not reach into the sim. Count each dollar exactly once: zero the victim in the same
synchronous step that credits the killer or creates the pickup, or the monitor will raise false shortfalls (there is no
cushion, see section 4 step 4).

---

## 6. CollusionMonitor (`server/CollusionMonitor.js`)

- API: `init({ db, onFlag })` (`:31-39`), `record(src, dst, amount, ctx)` (`:42-52`), `evaluate()` (`:71-89`),
  `topPairs(limit)` (`:92-105`).
- `record` silently ignores the call when `!src || !dst || src === dst || !(amount > 0)` (`:43`). Bots have no account id,
  so bot flows drop out on their own. `ctx.lobbyType` is a free-text label stored on the pair.
- A pair is flagged when ALL hold over a rolling 24 h: `count >= 5`, `net >= 0.02` (in the active unit, so 2 cents of
  USDC), one-way ratio `>= 0.8`, and the source is `>= 0.5` of everything the destination received (`:18-24`, `:60-69`).
  One hour re-flag cooldown. Flags go to `db.recordCollusionFlag` (`server/db.js:200-207`) and the owner socket.
- Wiring in index.js: `collusion.init` at `:1685-1691`; `evaluate` every 30 s through `everyStaggered` (`:1965`); owner
  endpoint `/api/admin/collusion` (`:622-630`). The module does NOT schedule itself.
- Existing call sites: `server/GameRoom.js:564` (cash food eaten; source tagged at death `:280`, `:716`) and
  `server/AgarRoom.js:512` (cell eaten). Rooms `require('./CollusionMonitor')` directly (`server/GameRoom.js:5`).
- Account ids: `collusion_flags` is joined to `accounts.google_id` (`server/db.js:209-220`) and `recordEarnings` keys
  `accounts` by WALLET address. **Use the token-verified wallet address as the account id in Paper.** The snake uses
  `socket._googleId`, which is whatever the client sent: no mint call passes a `googleId`
  (`server/index.js:583`, `:605`), so `entry.googleId` is always undefined and the override at `:2123-2126` never fires.
  A cheat could rotate that id to dodge pair tracking.

Paper calls:
- kill with killer: `collusion.record(victimWallet, killerWallet, victimWorth, { lobbyType: arenaName })`
- pickup collected: `collusion.record(pickup.srcWallet, collectorWallet, pickup.value, { lobbyType: arenaName })`

---

## 7. Death and disconnect today

- **Death**: `GameRoom.killSnake` (`server/GameRoom.js:694-749`) drops worth as cash food, emits
  `PLAYER_DIED { score, length, killerId }` to the victim and `PLAYER_KILLED` to a human killer, and a kill-feed chat line.
- **Disconnect** (`server/index.js:2828-2873`):
  - alive snake AND the client sent a `reconnectKey`: `room.markOrphan(socket.id, key, 8000, finalize)`
    (`RECONNECT_GRACE_MS`, `:2000`; `server/GameRoom.js:291-300`). The snake keeps gliding, can be killed, and its worth
    stays on it. On expiry `finalize` records the result and calls `room.removePlayer`.
  - otherwise: `db.recordGameResult`, then `room.removePlayer(socket.id)`.
  - `GameRoom.removePlayer` (`server/GameRoom.js:260-285`) treats leaving as a death: worth drops as cash food tagged
    with the leaver's account id. Money stays in the arena. This matches brief rule 5.
  - Agar on disconnect: `removePlayer` deletes the player and the worth is simply gone (`server/AgarRoom.js:150-159`).
- **Reconnect**: `PLAY` with a known `reconnectKey` calls `room.reattach(key, socket)` and returns early
  (`server/index.js:2093-2104`; `server/GameRoom.js:305-337`). See pitfall 1.

For Paper: on disconnect clear any hold, then either drop at once or keep the square for a short grace. If you keep a
grace window, the square must stay killable with full kill credit, and when the window ends the money drops as a pickup
at its position. Store everything the payout needs on the ROOM's player record so a reattach cannot lose it.

---

## 8. Bots and paid rooms

`GameRoom.isFree()` asks the room's `stake` first, then falls back to `C.FREE_LOBBY_TYPES`
(`server/GameRoom.js:102-106`, `shared/constants.js:262`). `botsAllowed()` is `isFree()` (`:107`) and `addBot` refuses
otherwise (`:374-377`). The comment lists seven times name-sniffing got this wrong (`:82-101`). Give the Paper arena a
numeric `stake` and the same two methods.

In the free arena every worth is 0, so the cash-out path pays nothing (`worth > 0` guards at `:2226`, `:2241`). If the
free arena shows play-money labels for fun, keep them in a separate display field. Never put a non-staked number in the
field that payout, solvency and drain status read.

---

## 9. Ops: maintenance and drain

- Joins are refused during maintenance before any token is consumed (`server/index.js:2072-2075`).
- `ops.drainStatus(rooms)` (`server/ops.js:57-77`) walks `room.snakes.values()` and counts entries with
  `alive && !isBot && worth > 0`. Rooms without a `.snakes` Map are skipped (`:60`), which is why agar is invisible to
  it. `ALL_ROOMS()` is built at `server/index.js:813-835`.
- For Paper: push arenas into `ALL_ROOMS()` and either expose a `snakes`-shaped Map view (`alive`, `isBot`, `worth`) or
  extend `drainStatus` with a `room.paidPlayers()` hook. Otherwise the owner console will call the server safe to take
  down while people hold money in a Paper arena. Live worth is memory only: a restart (every push to main deploys) wipes
  it, and there is deliberately no auto cash-out on shutdown (`server/ops.js:19-23`).
- If Paper arenas live in a `LobbyRegistry`, note `sweep()` stops and deletes a paid room after 5 empty minutes whatever
  is lying on its floor (`server/LobbyRegistry.js:84-95`). Uncollected pickups would be destroyed with it. Decide on
  purpose: keep the arena while `liveStakeTotal() > 0`, or book the leftovers as house revenue through `trackEarning`.

---

## 10. Pitfalls and latent bugs found while reading (do not inherit these)

1. **Payout wallet lives on the socket, and reattach drops it.** `_walletAddress` is only ever assigned from a consumed
   token (`server/index.js:2127`, `2376`, `2441`, `2620`, `2676`, `2760`). The reconnect branch returns before that line
   (`:2093-2104`) and `GameRoom.reattach` copies nothing to the new socket (`server/GameRoom.js:305-337`). After a
   reconnect `doCashout` zeroes worth, sweeps the rake, then finds no wallet and pays nothing (`:2214-2215`, `:2237`,
   `:2261-2263`), and the snake falls out of the solvency sum (`:1707-1708`). Paper: keep `walletAddress` on the room's
   player record, set once from the token, and read it from there for payout, solvency and collusion.
2. **The hold timer outlives the snake.** `socket._cashoutTimer` is cleared only on cancel and disconnect
   (`:2147-2150`, `:2183-2192`), and `doCashout` checks `alive` but not that a hold is running on THIS life
   (`:2209-2213`). Die mid-hold, respawn within 3 s (same `socket.id`, `server/GameRoom.js:751-759`) and the new life is
   cashed out instantly minus 10%. Paper: tick-driven hold on the unit, and re-verify elapsed time inside the payout.
3. **Agar's cash-out has no server-side hold at all.** `cell:cashout` is gated only by a 5 s rate limit
   (`server/index.js:2778-2787`); the lock is a separate client-driven event (`:2770-2776`). Do not model Paper on it.
4. **Capacity versus a burned token.** The stake is already on-chain and the token is one-time. If the 16-player check
   runs after `consumePaidEntry*`, a full arena eats the player's money. Check capacity first, and have a plan for a paid
   player who arrives at a full arena (open another arena instance, or refund with a `koSend`-style transfer,
   `server/index.js:1240-1253`). Never let the solo eviction path (`paperGame.js:232-238`) run in a paid arena.
5. **Refunds are recorded as earnings.** `koSend` calls `db.recordEarnings` for refunds as well as prizes
   (`server/index.js:1245`), inflating the top-earners board. If Paper refunds, skip `recordEarnings`.
6. **Client-supplied payout address.** Knockout enqueues `wallet || socket._walletAddress` (`server/index.js:2623-2624`),
   client value first. Paper must pay only the verified payer from the token.
7. **The drainer credits rake sweeps as earnings.** Recovered rows all go through `db.recordEarnings`
   (`server/index.js:1983`), including `'rake-sweep'` rows addressed to `REVENUE_WALLET`. Existing quirk; just do not add
   more row types that should not be on the board.
8. **Floats.** Worth is a JS number everywhere. Whole-worth transfers avoid the snake's `worth / drops.length` splitting,
   but sums like 0.1 + 0.2 still drift. Format labels with `toFixed(2)` and keep the conservation test tolerant to 1e-9,
   or use integer micro-units inside the room.
9. **Pickups and the shrinking border.** Brief rule 6 trims land and pushes players inward. A pickup outside the new edge
   must be pushed inward too, never deleted: it is real money (`server/Food.js:173-184` makes the same point for cash food).

---

## 11. Suggested shape of the Paper money seam

Room (`server/PaperRoom.js`, new) owns state and timing; it never imports `money`, `db` or `Wallet`:
- player record: `{ socket, name, walletAddress, accountId, stake, joinTime }` set at join from the token result
- unit fields: `worth`, `cashoutStartedAt`
- `addPlayer(socket, name, skin, entry)` where `entry = { worth, walletAddress }`; `respawnPlayer(socketId, entry)`
- `startCashoutHold(socketId)`, `cancelCashoutHold(socketId)`; tick completes the hold
- `onCashout({ socketId, walletAddress, name, gross })` callback, fired AFTER the room has synchronously zeroed the
  worth and removed the unit with no kill credit and no pickup
- `liveStakeTotal()`, `paidPlayers()` (for drain status), `isFree()`, `botsAllowed()`, numeric `stake`
- calls `collusion.record(...)` itself on kill transfer and pickup collect, like the other rooms

index.js owns money: a `paperCashout({ walletAddress, name, gross, lobbyLabel, socket })` helper that is the body of
`doCashout` steps 3 to 6 with `game: 'paper'`, plus the join / respawn / disconnect handlers, the `sumLiveSelfCustodyStakes`
term and the `ALL_ROOMS` entry. Add a test in the style of `test/cashoutHold.test.js` that tries to cash out with no
hold, with a short hold, after dying mid-hold, and twice in a row.
