# Paper multiplayer: design, money first

Written 2026-09-20 by architect 3 of 3. Bias: money correctness and abuse resistance. Binding rules:
`docs/paper-multiplayer-brief.md`. Reader notes: `docs/paper-mp/understand-*.md`. Line cites are as of this date.
Cites marked (read) were re-read by me; the rest come from the reader notes, which cite the same lines.

The idea in one paragraph: follow one dollar from the wallet to the wallet and make every hop a single synchronous,
idempotent, server-decided function with a test. All in-arena money lives in ONE small pure object per arena, the
`PaperBank`, whose only operations that change the arena total are `deposit` (token consumed) and `withdraw`
(cash-out). Everything else (kill transfer, drop, collect) moves money between accounts inside the bank and cannot
change the total, so conservation is structural, not hoped for. The sim (`ArenaGame`) never sees money. The room
(`PaperRoom`) joins the two at exactly one seam, the `kill()` override. `server/index.js` remains the only place that
touches `money`, `db`, `trackEarning` and `sweepRake`, through one hook, exactly like Knockout's `onSettled`
(`server/index.js:1145-1190`) and the battle royale seam (`server/index.js:1289-1324`).

---

## 1. The life of a dollar (every transition, who decides, what makes it atomic)

| # | Transition | Decided by | Atomic step | Idempotent because | Test file |
|---|---|---|---|---|---|
| 1 | Wallet to escrow (stake) | existing `/api/submit-stake` (`server/index.js:544-588`) | `db.markStakeSig` one-time claim (`server/db.js:227-233`) | signature claimed once | existing |
| 2 | Stake to token | existing `entryStore.mint({stake: rung, worth: rung, walletAddress: payer})` (`server/entryStore.js:33-40`, read) | in-process Map set | token is a UUID | existing `test/entryStore.test.js` |
| 3 | Token to seat + bank deposit | `paperSockets.join` | one synchronous handler turn: refuse checks, `reserveSeat`, `consumePaidEntryAtStake` (`server/index.js:395-397`, read), `room.addPlayer`, `bank.deposit` | token deleted on consume (`server/entryStore.js:53`, read); duplicate join refused BEFORE consume | `paperSockets.test.js` |
| 4 | Worth over the head | `bank.balance(unitId)` copied into every snapshot as absolute micro-USDC | none (read only) | absolute values, never deltas | `paperCodec.test.js` |
| 5 | Kill with a killer | `ArenaGame.kill` override calls `room.onDeath` inside the sim tick | `bank.transferAll(victim, killer)` zeroes and closes the victim and credits the killer in one call | closed account transfers 0 | `paperBank.test.js`, `paperRoomMoney.test.js` |
| 6 | Death with no killer, or disconnect | same seam, `killer` undefined or dead | `bank.drop(victim, x, y)` closes the account and creates the pickup in one call | closed account drops nothing | same |
| 7 | Pickup collected | room post-tick pass | `bank.collect(pickupId, unitId)` deletes the pickup and credits in one call | deleted pickup collects 0 | same |
| 8 | Hold to cash out | room tick on `room.now()`, 3000 ms from `C.CASHOUT_HOLD_MS` (`shared/constants.js:22`) | hold state lives ON THE UNIT, dies with the unit | new life = new unit object with no hold | `paperRoomMoney.test.js`, `paperServer.test.js` |
| 9 | Bank to payout order | `room.completeCashout(unit)` | `bank.withdraw(unitId)` zeroes + closes, then unit removed with reason 7, then `onCashout(order)` called once, all before any await | closed account withdraws 0; `order.cashoutId` also de-duplicated in `paperMoney` | `paperRoomMoney.test.js`, `paperMoneyWire.test.js` |
| 10 | Payout order to wallet | `paperMoney.payCashout(order)` wired in index.js | integer 90/10 split, `trackEarning` + `sweepRake`, `money.withdraw`, `db.recordEarnings` only on success, `db.recordFailedPayout(..., e.broadcast)` and NO retry on failure (pattern at `server/index.js:2221-2256`, read) | drainer re-sends idempotently (`server/index.js:1972-1996`) | `paperMoneyWire.test.js` |
| 11 | Paid but never seated | `paperMoney.refundEntry` | token consumed through `entryStore.consumeAtStake` (one-time), full amount sent back, NOT recorded as earnings | token consumed once | `paperMoneyWire.test.js` |
| 12 | Liability | `room.liveStakeTotal()` = `bank.totalMicro() / 1e6`, added to `sumLiveSelfCustodyStakes` (`server/index.js:1702-1728`, read) | one number, includes pickups by construction | n/a | `paperRoomMoney.test.js` |

Money is integer micro-USDC (`Math.round(entry.worth * 1e6)`) everywhere inside Paper. Floats appear only at the two
edges: reading `entry.worth` and calling `money.withdraw(wallet, micro / 1e6)`, which `Usdc.toUnits` rounds to 6
decimals anyway (`server/Usdc.js:40`). This removes the 0.1 + 0.2 hazard noted at `server/stakeRules.js:43-45`.

### 1.1 PaperBank (new, `server/paper/PaperBank.js`, pure, no imports)

```
class PaperBank {
  constructor({ onTransfer })            // onTransfer(srcWallet, dstWallet, micro, kind) for CollusionMonitor
  deposit(unitId, micro, wallet, name)   // opens account; throws if unitId already open or micro < 0 or not integer
  balance(unitId)                        // 0 for unknown/closed
  transferAll(fromId, toId)              // returns micro moved; closes `from`; if `to` is not open, returns -1 and moves nothing
  drop(fromId, x, y)                     // returns pickup or null when balance is 0; closes `from`
  collect(pickupId, toId)                // returns micro; deletes the pickup; no-op if pickup gone or `to` not open
  withdraw(unitId)                       // returns { micro, wallet, name }; closes the account
  movePickup(pickupId, x, y)             // shrink push, never deletes
  totalMicro()                           // sum(open accounts) + sum(pickups)
  ledger                                 // { inMicro, outMicro } ; invariant: totalMicro() === inMicro - outMicro
  assertConserved()                      // returns true, or false after calling onBreach once
}
```

Rules enforced inside the bank so no caller can get them wrong:
- A pickup remembers `srcWallet` and `srcName` (the dead player's token wallet) so the collector's
  `collusion.record(src, dst, amount, { lobbyType })` call has the right source (`server/CollusionMonitor.js:42-52`;
  precedents `server/GameRoom.js:564`, `server/AgarRoom.js:512`). Account id for collusion is the TOKEN wallet, never a
  client id (the snake's `socket._googleId` is client supplied, see cashout notes section 6).
- `withdraw` can never return more than `inMicro - outMicro`. An arena cannot pay out more than it took in, whatever
  bug exists elsewhere. This is the mint-proof ceiling.
- Zero-value accounts (free arena) are legal; `drop` of a zero balance returns null so the free arena never shows
  pickups, and `onCashout` is never called with `micro === 0` for payment (the room sends a plain "left" receipt).

### 1.2 Abuse cases and the answer to each

| Abuse | Answer |
|---|---|
| Client sends a worth, wallet, or "hold finished" | No such field is read. Worth and wallet come only from the token result (`server/index.js:395-412`, read). The hold is completed by the room tick. |
| Junk stake (`NaN`, negative, `"0"` with a paid arena name) | One number: `stake = Number(msg.stake)`; must pass `isStake` (`server/stakeRules.js:36-69`); that SAME number picks the arena and is passed to the token door. There is no separate room name on the wire, so the `consumeAtStake(undefined, 0)` free-pass (`server/entryStore.js:49`, read) can only ever seat you in a stake 0 arena. |
| Die mid-hold, respawn inside 3 s, inherit the hold (live snake bug, cashout notes pitfall 2) | Hold state is a field on the unit object. A respawn is a new `ArenaHuman`. |
| Reconnect loses the payout wallet (live snake bug, pitfall 1) | No reconnect in Paper (brief rule 5: disconnect drops the money). Wallet lives on the room's player record and inside the bank account, never only on the socket. |
| Double cash-out (two events, timer + message) | There is no client "done" event. `bank.withdraw` closes the account; `paperMoney` also ignores a repeated `cashoutId`. |
| Pull the plug to deny a killer | Disconnect is a no-killer death: money drops where the square stood, the chaser takes it. |
| Feed a friend (suicide next to them, or let them kill you) | Both paths call `collusion.record`. No rake dodge exists: money leaves only by cash-out, which always pays the 10%. |
| Join a full arena and lose the stake | Seat is reserved before the token is consumed; overflow arenas are created on demand; an unspent token can be refunded (transition 11). |
| Replace-on-rejoin dumps money (shooter `sh:join` pattern, `server/index.js:2716-2717`) | Duplicate guard like PLAY (`server/index.js:2051-2055`): a socket that already has a live unit is refused BEFORE consume. |
| Bots taking or minting money | `botsAllowed()` asks `this.stake === 0` only; paid arena: `config.botsCount = 0` AND `spawnBot` overridden empty AND `topUpBots` deletes first (THE ONE RULE, `server/GameRoom.js:76-107`). Bots have no bank account, so `transferAll` to a bot returns -1 and the room drops a pickup instead. |
| Sim exception or infinite loop freezes the money process | Tick wrapped in try/catch; `SafeArenaBorder` caps the stock wall loop (solo-seams pitfall 2); three failed ticks in a row trigger `emergencyClose` (section 9.4). |
| Server restart with money in play | Arenas are visible to `ops.drainStatus` (`server/ops.js:57-77`, read) so the console refuses "safe". Phase 2 journal in section 9.5. |

---

## 2. File map (all new unless marked EDIT)

```
public/js/paper/mp/paperArenaCore.js   UMD. constants, arenaRadiusFor(n), ArenaHuman, SafeArenaBorder
public/js/paper/mp/paperArenaGame.js   UMD. ArenaGame extends P.Game (server sim; also loadable in browser tests)
public/js/paper/mp/paperTrim.js        UMD. trimBaseToWall(game, base) and ring invariant checker
public/js/paper/mp/paperCodec.js       UMD. binary snapshot + ring/trail packing
public/js/paper/mp/paperNet.js         browser. socket, clock offset, snapshot buffer, reliable event queue
public/js/paper/mp/paperMirror.js      browser. ClientArenaGame extends P.Game (render mirror + own-square prediction)
public/js/paper/mp/paperHud.js         browser. money labels, hold ring, touch button, receipts, death/respawn sheet
public/js/paper/mp/paperMpMain.js      browser. boot, canvas, fonts, focus, game:done
public/paper-mp.html                   page (classic scripts only, no type=module: test/inlineScripts.test.js:36-43)
server/paper/loadSim.js                requires the seven solo files in page order, then the four UMD mp files; returns DuelPaperLib
server/paper/PaperBank.js              section 1.1
server/paper/PaperRoom.js              one arena: ArenaGame + PaperBank + sockets + snapshots
server/paper/PaperArenas.js            directory of arenas by stake, seat finding, overflow, sweep, /api/live rows
server/paperSockets.js                 attach(socket, deps): all paper:* handlers and the disconnect branch
server/paperMoney.js                   create(deps): payCashout(order), refundEntry(...), forfeitFloor(...)
server/index.js                        EDIT (one owner): ~45 lines of wiring, listed in section 10
server/ops.js                          no edit (room exposes a `snakes` view, section 9.3)
wallet-widget/src/main.jsx             EDIT: PAGES gets paper:'/paper-mp' (line 217, read); then npm run build, commit public/wallet/widget.js
public/js/v2/play.js                   EDIT: OWN_PAGE.paper -> '/paper-mp' (line 274, read) + sessionStorage hygiene in the shortcut
public/js/v2/board.js                  EDIT: replace pinned paper:free lobbyType row (127-130) by a stake:0 pin, as an ADDED line
public/v2.html                         EDIT: catalogue row, .noskin CSS, detail copy
test/paper*.test.js                    nine new files, section 11
test/v2route.test.js                   EDIT: rewrite 1132-1137 (read)
```

Solo files under `public/js/paper/*.js`, `public/paper.html` and the `/paper` route are NOT touched in phase 1. The
only solo edit in the whole plan is the optional `preyFor` hook (task T12), gated on a golden re-run.

Why `server/paperSockets.js` and `server/paperMoney.js` instead of inlining in index.js: the house rule is "rooms never
move money, index.js does". These two modules ARE index.js's money code, given their dependencies by injection
(`{ money, db, trackEarning, sweepRake, consumePaidEntryAtStake, entryStore, ops, socketRL, sanitizeName, isStake,
REGION, arenas, io }`). Injection lets `paperMoneyWire.test.js` run the real payout code against fakes without
stubbing modules, which no existing money path can do today. The test pin "`db.recordStake(` appears exactly once in
index.js" (`test/v2route.test.js:158-171`) is unaffected because Paper goes through `consumePaidEntryAtStake`.

---

## 3. Server sim: reuse and seams

### 3.1 Loading
`server/paper/loadSim.js` does `require()` of `paperGeom, paperTerritory, paperBots, paperUnits, paperGame,
paperGameMoves, paperSkins` in the order of `public/paper.html:52-59`. They are IIFEs that write
`globalThis.DuelPaperLib` and have no `module.exports`, so `require` just runs them (solo-seams 0.1). Then it calls
`P.installGameMoves` if the solo boot normally does (`paperMain.js:209`), then requires the mp UMD files. No per-room
state may be put on `DuelPaperLib` (process wide).

### 3.2 ArenaGame extends P.Game (no solo edits)
Constructed with `player = null, controller = null, view = null, visible = false`, which makes the stock `update` a
complete server tick (solo-seams section 2.1; `paperGame.js:398-461`, read). Config: `botsCount: 16` when stake is 0,
`botsCount: 0` otherwise (`paperGame.js:184`). Border is a `SafeArenaBorder` (3.4). Overrides:

| Method | Override |
|---|---|
| `update(dt)` | `P.Vec2.space = this.space`; `stepRadius(dt)`; copy inputs onto humans; `super.update(dt)`; post pass (3.3). |
| `kill(victim, killer, reason)` | `if (victim.death) return;` (one capture can call kill twice, `paperGameMoves.js:196-201`, read). If reason is 1 or 2, no killer, and `now - victim.lastPushAt < 250 ms`: VETO (return without killing; brief rule 6). Else `super.kill(...)`, then `this.onDeath(victim, killer && !killer.death ? killer : undefined, reason)`. |
| `getMovement(dt, unit)` | reset the border's loop counter; if the unit is outside the wall prepend the radial push piece exactly as probed in solo-seams 5.4, stamp `unit.lastPushAt`; else `super`. |
| `recoverTail()` | run the stock body (`paperGameMoves.js:137-149`) for every human, because `player` is null. |
| `handleReturn(unit)` | `super`, then `this.trimQueue.add(unit.base)` (land laid before a shrink is merged outside the wall, solo-seams 5.5). |
| `spawnBot(mode)` | paid: empty body. Free: `super`. |
| new `spawnHuman(record, pos)` | never `spawnPlayer` (`paperGame.js:232-247`: evicts a middle unit and loops forever). Free arena at 16 units: evict the LOWEST ranked `BotUnit` with `super.kill(bot, undefined, 6)`. Builds `ArenaHuman` on a 50-gon of radius 30 (`paperSkins.js:190-191`) at `pos`. |
| new `findSpawn()` | `getSpawnPosition('random', baseRadius)` (`paperGame.js:121-174`) with at most 40 tries; rejects any point with `|y - 1000| < 0.5` or `|x - 1000| < 0.5` (the exact-axis wall vertex hang, solo-seams pitfall 2). Returns null on failure. Pure query, no mutation. |

New reason codes (safe: the base only compares against 6 and 0, `paperGame.js:353,369`, read):
`7 CASHOUT` (no credit, no pickup), `8 DISCONNECT` (pickup), `9 FORCED_EXIT` (emergency, section 9.4).

`ArenaHuman extends P.GameUnit`: fields `id` (u16, monotonic per arena, never an index: `units` is re-sorted every
tick, `paperGame.js:445`, read), `angle` (int 0..253), `locked`. `update(dt)`: `super.update(dt)`, then
`this.target = this.locked ? null : fromAngle(this.angle)`. Locked means zero displacement (probed, solo-seams 2.2)
while the trail stays cuttable. `isPlayer` stays false so the server builds no labels.

### 3.3 Post pass order (money-relevant ordering is deliberate)
1. trim pass (section 7), at most 4 bases per tick from `trimQueue`.
2. free arena only: the long-trail magnet per human (stock loop `paperGame.js:502-522`).
3. pickups: for each pickup, nearest alive human within 22 u collects; exact ties go to the lower `id`.
4. holds: for each alive human with `holdStartedAt`, if `now - holdStartedAt >= HOLD_MS` then `completeCashout`.
   Deaths happen in `super.update`, before this step, so on a same-tick tie DEATH WINS and the killer gets the money.
5. `unit.log.length = 0` for every unit (leak, solo-seams pitfall 3).
6. `bank.assertConserved()`.

Same-tick mutual trail cuts are decided by rank order, because the higher scored unit moves first
(`paperGame.js:445`, `paperGameMoves.js:333-336`). That is reference behaviour and stays; money is still assigned
exactly once because the loser is removed before it moves.

### 3.4 SafeArenaBorder extends P.ArenaBorder
- `intersections(seg)`: counts calls since `resetLoopGuard()`; past 12 returns `[]` (probe: ends the stock
  `while (wallHits.length)` hang at `paperGameMoves.js:70-99`). The push pass repairs any escape next tick.
- `setRadius(r)`: `this.radius = r; this.polygon = new P.Polygon(P.makeCirclePoints(center, 300, r));
  this.polygon.calcPath();` then the game sets `game.square = border.polygon.square()` (`paperGame.js:77` computes it
  once only). The wall is never committed to the grid (`paperTerritory.js:14-29`, read), so this costs 0.023 ms.
  Centre stays (1000, 1000), radius <= 950 (`SpatialGrid.cell` does not clamp, `paperGeom.js:304-310`).

### 3.5 The process-wide static
`P.Vec2.space` is one static for the whole process (`paperGeom.js:293,386,518`) and `Game.update` re-points it only at
the top of a tick (`paperGame.js:404`, read). Every PaperRoom entry point that can touch geometry outside `tick()`
(`addPlayer`, `respawn`, `removePlayer`, `emergencyClose`, `stop`) goes through one wrapper:

```
withSpace(fn) { const prev = P.Vec2.space; P.Vec2.space = this.game.space; try { return fn(); } finally { P.Vec2.space = prev; } }
```

Node is single threaded and no `update` is ever suspended mid-tick, so a synchronous wrapper is sufficient and keeps
the join atomic (a command queue would split "token consumed" from "seat taken" across time, which is the wrong
trade for money). `paperArenaGame.test.js` builds two arenas and proves land committed through `withSpace` in arena A
collides in A and is invisible in B.

### 3.6 Fixed timestep
`PaperRoom` owns `setInterval(wake, 1000 / 60)`. `wake` reads `this.now()`, adds to an accumulator, and runs
`min(5, floor(acc / STEP))` steps of exactly `STEP = 1000 / 60` ms (extra backlog is dropped, never one long step:
turn allowance scales with dt, `paperGameMoves.js:54-65`). The solo `loop()` is never called (needs rAF,
`paperGame.js:685-724`) and its random sub-step jitter is not imitated. `now()` is the single overridable clock
(`server/ShooterRoom.js:157-164` pattern); every deadline (hold, radius easing, shrink delay, trim retry, idle stop,
snapshot cadence) reads it, so tests subclass and step a fake clock (`test/shooter.test.js:8-17`). Snapshots go out
every second step (30 Hz) like `SNAPSHOT_RATE`.

---

## 4. Room lifecycle and arena directory

`PaperArenas` (not `LobbyRegistry`: its sweep deletes a paid room after 5 empty minutes whatever is on the floor,
`server/LobbyRegistry.js:84-95`, read; and the snake `ladder` instance must never hold a Paper room,
`server/index.js:1599-1609, 1704-1715`).

- `arenas: Map<'0.00'|'0.10'|'1.00', PaperRoom[]>`, keyed with `Number(stake).toFixed(2)` like
  `server/LobbyRegistry.js:31-33` (read). Only this server's REGION (`server/index.js:1132-1138`).
- `seatFor(stake)`: among arenas of that stake with `humansAlive < 16`, pick the FULLEST (anti-fragmentation), call
  `room.reserveSeat()`; if none seats, create a new arena (max 8 per stake) and try it; else return null.
- Free arena `#1` is created at boot and warmed up in chunks of 200 updates per `setImmediate` (6000 updates of 50 ms,
  `paperMain.js:108-131`; 474 ms if done in one block, which would stall the snake and agar rooms). Until `ready`,
  free joins get `paper:refused {reason:'warming'}` and the client retries after 500 ms. Paid arenas have no bots and
  need no warm-up.
- Idle: when `humans.size === 0` for 30 s the interval is cleared and ALL state is kept (bots frozen, pickups kept).
  It restarts on the next `reserveSeat`. The free arena reports its bot floor to `/api/live` while idle, like the
  shooter (`server/index.js:1396-1411`).
- `sweep()` every 60 s: delete an arena only if it has no humans, `bank.totalMicro() === 0`, it is not free `#1`, and
  it has been so for 5 minutes. An arena with money on the floor is NEVER deleted; `seatFor` prefers it (it is
  the fullest-or-equal candidate and it costs nothing to reuse), so the next player in finds the money. `room.stop()`
  calls `game.stop()` (the constructor's 500 ms interval, `paperGame.js:95-106`).
- Console contract so the owner panel works unchanged (`server/index.js:877-890`, read): `lobbyType`
  (`'paper_na_s0'`, `'paper_na_s0_1'`, `'paper_na_s1'` plus `#n`), `playerCount`, `botCount`, `botsAllowed()`,
  `addBot()`, `clearBots()`, `isFree()`, numeric `stake`. `roomLabel` gets one Paper branch.

### Seat reservation (why a paid player can never lose a stake at the door)
`reserveSeat()` returns `{ pos }` or null. It checks `humansAlive < 16` and `findSpawn()` succeeds. It mutates nothing.
Because the join handler is one synchronous turn, the reservation cannot go stale between reserve and spawn.

---

## 5. Sockets and events

One namespace, new prefix `paper:` (unused today, rooms-netcode notes). Socket state: `socket._paperRoom`,
`socket._paperStake`, `socket._paperWallet` (display only; payout reads the room record). None of the snake fields
(`_room`, `_stake`, `_cashoutTimer`, `_doCashout`) are reused, because the snake cash-out handlers act on
`socket._room.snakes` (`server/index.js:2162-2165`).

### 5.1 Join handler (order is the contract; `paperSockets.test.js` asserts it with a spy on consume)
```
paper:join { name, stake, entryToken }
 1. socketRL(socket, 'paper:join', 1000)                      (server/index.js:62-68)
 2. stake = Number(msg.stake); if (!isStake(stake)) refuse 'bad-stake'
 3. if (ops.get().maintenance) emit 'maintenance' + refuse     (server/index.js:2072-2075)  BEFORE consume
 4. if (socket._paperRoom && room.hasLiveUnit(socket.id)) refuse 'already-playing'          BEFORE consume
 5. seat = arenas.seatFor(stake); if (!seat) refuse 'full' (token stays unspent, client may retry or refund)
 6. entry = consumePaidEntryAtStake(msg.entryToken, stake, 'paper')
    if (!entry.ok) refuse 'entry-not-verified' (visible, never seated free: server/index.js:2605-2617)
 7. try { seat.room.addPlayer(socket, sanitizeName(name), { micro: round(entry.worth*1e6), wallet: entry.walletAddress }, seat) }
    catch (e) { if (entry.worth > 0) paperMoney.refundPaid(entry, 'seat failed'); refuse 'seat-failed' }
 8. socket._paperRoom = room; socket._paperStake = stake; socket._paperWallet = entry.walletAddress || null
```
`addPlayer` does, inside `withSpace`: `game.spawnHuman`, `bank.deposit(unit.id, micro, wallet, name)`,
`socket.join(room.ioRoom)`, reliable `paper:joined` (full state). For stake 0, `entry` is `{ ok: true, worth: 0 }`
with no wallet, so micro is 0.

`paper:respawn { entryToken }`: same steps with `stake = socket._paperStake` (never a client value,
`server/index.js:2360-2370`); step 5 tries the current arena first and moves the socket to another arena if it is
full. Paid clients get the fresh token through the existing `duel:restake` bridge
(`wallet-widget/src/main.jsx:355-378`, read; `public/js/game.js:2031-2046`). Free respawn sends no token.

`paper:refund { stake, entryToken }` (rate limit 2000 ms): for a client holding a token it could not use (arena
full after 60 s of retries, maintenance, tab closing). `paperMoney.refundEntry` calls `entryStore.consumeAtStake`
DIRECTLY (not `consumePaidEntryAtStake`, so no `db.recordStake` row is written for a seat never taken), then
`money.withdraw(wallet, worth)` with the full amount; failure goes to `db.recordFailedPayout`; success does NOT call
`db.recordEarnings` (koSend wrongly does, `server/index.js:1245`, read). One-time because the token is.

Other client events: `paper:input` (volatile, `{a}` integer 0..253 validated with `Number.isInteger`),
`paper:hold {on}` (reliable, rate limit 100 ms), `paper:resync`, `paper:leave`, `paper:ping` (clock).

### 5.2 Server to client
| Event | Delivery | Content |
|---|---|---|
| `paper:joined` | reliable | your unit id, stake, arena label, server time, radius, every unit (id, name, colour, bot flag, money, ring, trail, area), pickups |
| `paper:s` | VOLATILE, one shared binary payload per arena per 30 Hz frame via `io.to(room).volatile.emit` | section 6 |
| `paper:geo` | reliable, coalesced at 10 Hz | trail appends/resets and base rings with version numbers |
| `paper:ev` | reliable | unit joined/gone, kill (victim, killer, reason, micro moved, killer's new absolute money), pickup spawned/collected, hold started/cancelled, reseed |
| `paper:dead` | reliable, victim only | reason, killer name, micro lost |
| `paper:cashedout` | reliable, once | grossMicro, cutMicro, playerMicro, cashoutId |
| `paper:paid` / `paper:payerror` | reliable | tx signature, or the "payout delayed, it is recorded" message |
| `paper:refused` | reliable | reason code + human text |

Deltas never ride in volatile frames (a dropped frame loses them forever: the shooter and agar bug class,
`server/ShooterRoom.js:628-630`, `server/AgarRoom.js:563-567`). The volatile frame carries only superseded state plus
version counters so a client can detect a miss and send `paper:resync`.

`removePlayer` calls `socket.leave(ioRoom)` (GameRoom does, `server/GameRoom.js:262`; the shooter forgets).

### 5.3 Disconnect
In the shared handler next to `endShooter` (`server/index.js:2828-2873`): `paperSockets.onDisconnect(socket)` calls
`room.removePlayer(socket.id)`. If the unit is alive: hold cleared, `game.kill(unit, undefined, 8)`, which reaches
`onDeath` with no killer, which calls `bank.drop`. No reconnect grace (decision D2 in section 13): a held square is a
stationary target carrying money, and brief rule 5 says disconnect drops the money.

---

## 6. Snapshot format and rates

Sim 60 Hz, snapshot 30 Hz, geometry 10 Hz, input 30 Hz. One arena fits one interest cell (diameter <= 1900 against the
snake's 2000 u cells), so ONE encode per arena per frame, fanned out through the Socket.IO room. No transport is forced
(CLAUDE.md netcode section; `public/js/game.js:105-112`).

`paper:s` (little endian, `paperCodec.encodeFrame/decodeFrame`, same UMD module both sides like
`shared/snapshotCodec.js:36-40`):
```
header  u8 version | u32 tick | u32 serverMs (since arena epoch) | u16 radius*32 | u8 nUnits | u8 nPickups
unit    u16 id | u8 flags | u16 x*32 | u16 y*32 | u8 dir (wrapped, 256 steps) | u8 holdProgress 0..255
        u16 inOwnerId (0 none) | u8 trailEpoch | u16 trailCount | u8 baseVer | u32 moneyMicro          = 19 bytes
pickup  u16 id | u16 x*32 | u16 y*32 | u32 micro                                                       = 10 bytes
flags   bit0 bot, bit1 holding, bit2 pushed, bit3 dead-this-frame
```
16 units is about 320 bytes, under 10 KB/s per client. Money and hold progress are ABSOLUTE in every frame, so a label
can never drift from the bank for longer than one delivered frame. `unit.direction` is unbounded radians
(`paperGameMoves.js:63`); wrap before quantising. Human `type` is undefined and must not leak
(`paperGame.js:197-202`).

Geometry (`paper:geo`):
- Trail: server keeps a published, decimated copy per unit (streaming tolerance 0.35 u, plus forced point every
  40 u). Message `{ id, epoch, from, pts: Uint16 pairs }`. `epoch` bumps on reset (return, death, recoverTail,
  reseed). Client draws published points plus the live interpolated position as the tip. Wall crawlers generate
  thousands of micro points (probe: 5885 in 25 s); decimation bounds that.
- Base ring: `{ id, ver, area, pts }`, sent when `base.version` changes (own return, carved, trimmed, reseed),
  decimated at 0.4 u (the sim's own `simplify` is 25 u, too coarse to draw). `area` is `base.square`; the client
  derives percent from `area / squareOf(radius)` so the score bar stays right while the radius eases.
- Client compares `trailEpoch/trailCount/baseVer` from each frame against what it holds; a mismatch that persists
  400 ms sends `paper:resync { id }` and the server replies with the full trail and ring for that unit.

---

## 7. Arena radius and the TRIM

### 7.1 Radius
`arenaRadiusFor(n) = 950 * sqrt(clamp(n, 4, 16) / 16)` (brief: 475 at n <= 4, 950 at n >= 16), `n` = squares alive
including bots, pure function in `paperArenaCore.js` so the client uses the same one for tests. Free arena is pinned
at 16 by bots, so it is always 950. Easing, on `room.now()`: grow at 40 u/s starting at once; shrink at 4 u/s and only
after the target has been lower for 3 s (a quick respawn does not jiggle the wall). The applied radius moves in 0.5 u
quanta, so `setRadius`, the push and the trim run about 8 times a second while shrinking, never 60.

On every quantum: `border.setRadius(r)`, `game.square` recomputed. Shrink only: pickups beyond `r - 20` are moved
radially to `r - 20` with `bank.movePickup` (never deleted: real money, same point as `server/Food.js:173-190`); every
base whose bounds reach beyond the wall goes into `trimQueue`. Units are pushed by the `getMovement` override on their
next move (at most 0.5 u per quantum, so a pushed unit is always within 5 u of the wall and any push-induced
self-cross is reason 2, `paperTerritory.js:233-236`, read; the veto also covers reason 1 for safety).

The veto is per unit and time boxed (250 ms since that unit's last push), not arena wide, so a player cannot use a
shrinking wall somewhere else to survive a real self-cross.

### 7.2 Trim algorithm: "clip against the wall, keep identity" (`paperTrim.js`)

It is Weiler-Atherton against a convex clip polygon (the 300-gon wall), applied to the existing ring so that every
kept vertex and every kept Segment is the SAME object. It generalises what `carve` already does with `left`/`right`
(`paperGameMoves.js:207-255`, read; `paperGeom.js:717-740`, read) to several runs, wrap-around and multi-piece
results. Two phases: PLAN (pure, may abort freely) then COMMIT (short, ordered, cannot fail on valid input).

Definitions. Wall vertices `W[0..N-1]`, `N = 300`, generated at increasing angle from 0 (`paperGeom.js:883-895`,
read). For a point p: sector `k = floor(angle(p) / (2*pi/N))`, signed distance `d(p)` to edge `W[k]W[k+1]`, positive
toward the centre. `OUT` means `d < -1e-6`. Everything else is `IN` (on the wall counts as in).

PLAN
1. Fast exit: if every ring vertex is within `r * cos(pi/N) - 1e-6` of the centre, nothing to do.
2. Crossing points. For each ring edge PQ:
   - IN to OUT or OUT to IN: exactly one crossing (convex wall). Compute it analytically against the wall edges of
     the sectors between `k(P)` and `k(Q)` plus one each side; if that finds nothing, brute force all N edges; if
     that finds nothing, bisect on the `OUT` predicate (40 rounds). A result is therefore always produced. If the IN
     endpoint is itself within 1e-6 of the wall, REUSE that vertex as the crossing (no insert).
   - OUT to OUT: if the closest point M of the edge to the centre is `IN` by more than 1e-6, there are two
     crossings; bisect from M toward each end. Otherwise none (grazing counts as outside).
   Record each crossing as `{ segment, point, s }` where `s = k + u` is its position along the wall in [0, N).
   Nothing is mutated yet.
3. Orientation `sigma` = sign of the ring's shoelace sum. Wall walk direction is increasing `s` when `sigma > 0`,
   decreasing otherwise (both signs come from the same plane, so this holds whatever the screen axes are; a unit
   test pins it with a circle base straddling the wall against the analytic lens area).
4. Build the cyclic vertex list with crossings spliced in (still a plain array). Split it into IN runs bounded by
   crossings. From each run's exit crossing, walk the wall in the walk direction to the next crossing; it MUST be an
   entry crossing, else ABORT. Following run, arc, run, arc until closed yields one or more cycles (pieces).
5. Choose the piece to keep, the carve rule (`paperGameMoves.js:237-246`, read): owner home
   (`unit.in === unit.base`): the piece whose polygon contains `unit.position`; owner away: the piece whose runs
   contain the vertex object `unit.track.polyline.start` (identity, invariant I2,
   `paperGameMoves.js:163-164`, read); if that vertex is OUT, ABORT. No match: the largest piece.
6. Protected vertices: any vertex that would be dropped and has a segment in `vertex.segments` whose
   `shape.owner.isTrack` is true (`paperTerritory.js:162`, read) is shared with a live trail (invariants I2, I3).
   If any exists, ABORT.
7. Validate: kept ring has >= 3 segments; no arc segment shorter than 1e-9 (skip wall vertices that close to a
   crossing); new area <= old area + 1e-6 (a trim can never grow land); new area >= 200 u^2, else mark SWALLOWED.

COMMIT (only after a fully valid plan)
1. `ring.insert(segment, point)` for each new crossing (the stock split: both halves committed before the old
   segment is removed, `paperGeom.js:680-690`, read). This alone never changes the shape.
2. Build `newSegs`: for IN runs push the EXISTING committed Segment objects; for arcs create
   `new P.Segment(a, b)` over `[A, fresh Vec2 copies of the wall vertices strictly between, B]` and collect them in
   `added`. Wall vertices are copied, never shared with the border polygon (it is rebuilt on every quantum).
3. `dropped` = current `ring.segments` not in `newSegs` (by Set).
4. `added.forEach(s => s.commit(ring))`, THEN `dropped.forEach(s => s.remove())`: commit first, remove after, the
   order `left` uses; each dropped segment is a committed ring segment and is removed exactly once (invariant I4,
   `paperGeom.js:390-397`).
5. `ring.segments = newSegs` (array start may rotate; `right` and `unsplice` already re-base it, and every consumer
   finds indices by identity). `base.calcSquare()`, `ring.calcPath()` (refreshes `simplify` and `bounds`,
   `paperGeom.js:806-869`), `base.version++`.
6. Bystanders: any other unit with `in === base` whose position is no longer inside gets `in = null`, exactly what
   `carve` does (`paperGameMoves.js:250-254`, read).

Land edges end up exactly on wall edges, which is the state the solo game already reaches when a unit captures while
sliding (overlay hits on the own ring are ignored, `paperTerritory.js:78-81`). After the next quantum those vertices
are all OUT and form one run that is replaced again, so the vertex count does not grow.

`checkRing(base)` (test and debug only): ring closed, every segment committed to this ring, no zero length, no
repeated vertex object, area sign unchanged, away owner's exit vertex still a `.start` in the ring.

### 7.3 Fallbacks (in order)
- F0 ABORT: nothing was mutated. `base.trimDirtySince = now`; retried on the next quantum and at least every 250 ms
  while dirty. Untrimmed land outside the wall is unreachable and harmless, and territory carries no money.
- F1 RESEED: plan says SWALLOWED, or no IN vertex exists and the centre is not inside the ring, or the base has been
  dirty for 10 s. `pos = game.findSpawn()` (bounded; if null, stay dirty and try next pass). Then: wipe the trail the
  way `recoverTail` does (`paperGameMoves.js:137-149`), `base.remove()`, clear other units' `in` that pointed at it,
  new `TerritoryBase` on a radius 30 circle at `pos`, move the unit there, `in = base`, version bump, reliable
  `paper:ev {t:'reseed'}` so the client shows "The wall swallowed your land". Using `findSpawn` guarantees no overlap
  with a neighbour, which the sim never allows. Money is untouched (it is in the bank, not the geometry).
  Special case: no IN vertex but the centre IS inside the ring (one base owns the whole disc): the kept ring is the
  full wall circle; same COMMIT with one arc and zero runs.
- F2 EXCEPTION in COMMIT (should be unreachable): caught, logged CRITICAL with the ring dump, immediate RESEED; if
  that throws too, FORCED EXIT for that one player (section 9.4). Nobody dies from the shrink, and nobody loses money
  to a geometry bug.

---

## 8. Client

`/paper-mp` (single path segment, because the page loads scripts by relative url like `public/paper.html:52-61`)
serves `public/paper-mp.html`: the seven solo sim files + `paperInput.js` + `paperRender.js` unchanged, then
`/socket.io/socket.io.js`, then the mp files. Not `paperMain.js` (`createGameApi` hardcodes `new P.Game`,
`paperMain.js:86`), but it reuses its exported helpers (`registerLanguages`, `pickDefaultLanguage`, `whenFontsReady`,
`paperMain.js:489-495`).

- `ClientArenaGame extends P.Game` (mirror). `player` = the local unit, so the stock camera, minimap, leaderboard
  row and HUD gate all work untouched (solo-seams 2.7). `update(dt)`: stock `readInput` + angle quantisation
  (`paperGame.js:408-409`, read), interpolate every remote unit from the snapshot buffer, predict the local unit,
  run labels/particles/camera-scale easing. `renderGameFrame`, `getRenderContext`, `loop` are used byte for byte.
  Mirror units hold real, UNCOMMITTED `P.Polygon`/`P.Polyline` objects rebuilt from `paper:geo` (needed by the
  renderer and by `P.spawnDeathParticles` on a kill event).
- Interpolation copied from the snake: clock offset EMA, 70 ms base delay with adaptive jitter buffer to 180 ms,
  200 ms dead-reckon cap, full reset on `paper:joined` (`public/js/game.js:73-84, 361-428, 470-542`).
- Prediction, own square only: `P.Game.prototype.getMovement.call(mirror, dt, unit)` with the target built from the
  local angle, which reads only `config.unitSpeed`, the unit and `border` (`paperGameMoves.js:49-102`), so turn cap
  and wall slide match the server. Correction: blend 10% per frame toward the server position advanced by the
  measured delay; snap beyond 60 u. Kills, captures, land and money are NEVER predicted.
- Input: `paper:input` volatile at 30 Hz and on change, one integer 0..253 (the same quantisation solo uses).
- Pointer steering is relative to the view centre (`paperGameMoves.js:42-44`), so the camera keeps the local square
  centred (stock behaviour with `player` set).
- Focus: the page calls `window.focus()` on load and on first pointer down, because only the widget path focuses the
  iframe (`wallet-widget/src/main.jsx:225-228`, read) and cash-out is a held key.
- Exit: `window.parent.postMessage('game:done', '*')` with a non-framed fallback (`public/js/shooter.js:1085-1089`;
  lobby handler `public/js/v2/play.js:427-433`).
- Session hand-off: reads `playerName`, `stake`, `entryToken`, `walletAddress`, `region` from sessionStorage ONCE at
  load, then `removeItem('entryToken')` immediately (send once, `public/js/knockout.js:528-535`). On socket
  reconnect it does NOT re-emit join (the unit is gone and the token is spent); it shows "Disconnected. Your money
  was dropped in the arena." with Play again (paid: restake bridge) and Lobby.
- Refusals: `full` retries `paper:join` every 2 s for up to 60 s with the same token, then offers "Refund my
  buy-in" (`paper:refund`). `entry-not-verified` and `maintenance` show the server's text and a Lobby button.

### HUD additions (`paperHud.js`, drawn in a pass AFTER `renderGameFrame` using the world transform from
`getRenderContext`, `paperRender.js:599-604`; no renderer edit)
- Money over every head: `'$' + (micro / 1e6).toFixed(2)`, above the stock name (which is drawn 12 px above the
  unit, `paperRender.js:141-168`). Hidden when the arena stake is 0 (decision D1). A 600 ms scale pop plus a
  "+$0.20" floater on a kill or pickup, from `paper:ev`.
- Pickups: coin disc with the amount, gentle bob; also a dot on the minimap.
- Cash-out ring: around any unit whose `holding` flag is set, progress from the `holdProgress` byte (server clock).
  For the local unit the ring starts at keydown for responsiveness but is re-synced to the server byte; if no frame
  confirms `holding` within 300 ms the local lock is released.
- Hold control: Q keydown (not repeat, `evt.target === document.body`, the rule `paperInput.js:87-97` uses) sends
  `paper:hold {on:true}`; keyup, window blur and `visibilitychange` send `{on:false}`.
- Touch: a 72 px round DOM button bottom right, shown on `(pointer: coarse)` or the first `touchstart`, label "HOLD
  TO CASH OUT $0.20", `touch-action: none`, `pointerdown` = hold on, `pointerup/pointercancel/pointerleave` = hold
  off, SVG stroke ring for progress. It is a separate element from the canvas, and touch steering listens on the
  canvas only (`paperInput.js:49-58`), so pressing it does not steer.
- Receipt sheet on `paper:cashedout`: gross, 10% fee, you receive; then the tx link on `paper:paid` or the delay
  message on `paper:payerror`. Death sheet on `paper:dead`: who, how much was lost, Play again, Lobby.

---

## 9. Money wiring in index.js terms

### 9.1 Cash-out order and payment
`completeCashout(unit)` in the room, all synchronous:
```
const w = bank.withdraw(unit.id);            // zero + close: the double-pay guard (server/index.js:2214-2217 pattern, read)
withSpace(() => game.kill(unit, undefined, 7));   // no credit, no pickup; land removed
emit paper:ev gone; if (w.micro > 0) this.onCashout({ cashoutId, socketId, wallet: w.wallet, name: w.name,
   grossMicro: w.micro, stake: this.stake, label: this.lobbyType, forced: false });
else socket.emit('paper:cashedout', { grossMicro: 0 ... });   // free arena: just a clean exit
```
`paperMoney.payCashout(order)`:
```
if (seen.has(order.cashoutId)) return; seen.add(order.cashoutId);           // bounded Set, newest 5000
cutMicro = order.forced ? 0 : Math.floor(order.grossMicro / 10); playerMicro = grossMicro - cutMicro;
if (cutMicro > 0) { trackEarning({ source:'game_rake', game:'paper', amountUsdc: cutMicro/1e6, wallet, name,
                    lobbyType: label, region }); sweepRake(cutMicro/1e6, 'paper ' + label); }   (server/index.js:35-55, 2226-2233)
emit paper:cashedout to the socket if still connected (payment does NOT depend on the socket)
money.withdraw(wallet, playerMicro/1e6)
  .then(sig => { db.recordEarnings(wallet, name, playerMicro/1e6, money.fiatValue(playerMicro/1e6)); emit paper:paid })
  .catch(e => { db.recordFailedPayout(wallet, playerMicro/1e6, name, 'paper ' + label + ': ' + e.message, e.broadcast);
                emit paper:payerror })        // no inline retry (server/index.js:2250-2256, read)
```
The wallet travels inside the order, so a socket that closes between completion and payment still gets paid (the
snake pays nothing in that case because the wallet lives on the socket).

### 9.2 Solvency
In `sumLiveSelfCustodyStakes` add, after the agar loop (`server/index.js:1716-1726`, read):
`for (const room of paperArenas.all()) total += room.liveStakeTotal();`. It includes floor pickups by construction,
so Paper does not repeat the snake's under-count of cash food (cashout notes section 5). Because `sweepRake` moves
the 10% out of escrow there is no cushion: each dollar is counted exactly once because each bank call moves it in one
step. Money withdrawn from the bank but not yet landed on-chain is no longer counted, which errs toward surplus,
never toward a false shortfall (same as the snake).

### 9.3 Drain status and console
`PaperRoom` exposes `get snakes()` returning a fresh `Map<socketId, { alive, isBot: false, worth }>` of live paid
humans (`worth = balance / 1e6`), which is exactly what `ops.drainStatus` reads (`server/ops.js:60-65`, read), so
`ops.js` needs no edit. `ALL_ROOMS()` pushes every Paper arena (`server/index.js:823-835`, read). Nothing else walks
`.snakes` of `ALL_ROOMS()` (grep: lines 877, 896, 957, 1022 only). The solvency sum walks `ladder` and `gameRooms`
directly, not `ALL_ROOMS`, so there is no double count.

### 9.4 Emergency close (sim failure with money in the arena)
The room tick is wrapped in try/catch. One failure: log, skip the tick. Three in a row: `emergencyClose()`: for every
live paid human `bank.withdraw` then `onCashout({ ..., forced: true })` (100%, no rake: the house does not profit
from its own bug); every floor pickup goes to `onForfeit({ micro, srcWallet })`, which refunds it to the wallet that
dropped it (it was that player's money and nobody earned it). The arena is then stopped and removed and
`seatFor` builds a fresh one. This reuses the one payout function; it is not a second payout path.

### 9.5 Restart (phase 2, optional, no payout logic)
Live money is memory only and every push to main restarts pm2. Phase 1 honours the existing answer: the console
refuses "safe to restart" while paid players are live (`server/ops.js:19-23`, read). Phase 2 proposal, deliberately
NOT a payout path: a `paper_positions` journal table upserted on every bank event (wallet, micro, arena, updated_at)
and deleted on withdraw; on boot, leftover rows are listed on the owner console as "stranded at restart" for a manual
refund. It needs a `db.js` migration and is owned by nobody in phase 1.

### 9.6 Known neighbours, not fixed here
`entryFeeLimiter` is shared by quote and submit at 10 req/min/IP (`server/index.js:359, 513, 544`): about five
buy-ins a minute, which fast die-and-rebuy can hit. Suggest a separate limiter for submit; owner of index.js decides.
Maintenance is not checked on `/api/stake-quote`, so a player can pay and then be refused at the door; `paper:refund`
is the remedy for Paper.

---

## 10. Lobby wiring for Free / $0.10 / $1.00

1. `wallet-widget/src/main.jsx:217`: add `paper: '/paper-mp'` to PAGES. Today a paid Paper launch falls back to
   `/game.html` and the snake client would spend the token (read, lines 217-219). Then `npm run build` and COMMIT
   `public/wallet/widget.js` (the deploy does not build, `.github/workflows/deploy.yml:34-35`). This must land in the
   same commit that makes the card paid, never after.
2. `public/js/v2/play.js:274`: `paper: '/paper-mp'`. Paper stays in OWN_PAGE so the free arena needs no wallet
   (`stakeAndPlay` requires one, `main.jsx:181-189`, read); paid still goes to the widget because the test is the
   amount (`play.js:280-281`, read). In the shortcut add hygiene so stale keys from an earlier paid game cannot make
   the page ask for a paid seat with a burnt token (lobby-tiers pitfall P3): set `stake` to
   `String(hasStake ? Number(sel.stake) : 0)` and remove `entryToken`, `entrySol`, `lobbyType`. No forbidden strings
   are added (`test/v2route.test.js:215-233`).
3. `server/index.js`: route `/paper-mp`; `/api/live` `lobbies` gets three ALWAYS-present rows
   `{ game:'paper', stake, players, bots, capacity }` from `paperArenas.liveRows()` (summed per stake; free reports
   its bot floor), CONCATENATED after the snake mapping without reshaping it (tests regex the snake mapping,
   `test/v2route.test.js:197-213`). Without rows every rung is struck through (`public/v2.html:2220-2223`,
   `public/js/v2/board.js:141-146`).
4. `public/v2.html:2165`: the Paper row becomes `built:1, ladder:1, noskin:1` with `solo` and `soloNote` removed;
   add CSS `.noskin .lookrow{display:none}` (the snake colour picker would otherwise appear, P6) and a short note
   "Kill a player, take their money. Hold Q for 3 seconds to cash out." Do not use `paid:1` (duel-only, carries wrong
   copy about bots and a one-minute refund, `public/v2.html:2204-2223, 3189-3196`). Keep the test-pinned detail
   markup order (`test/v2route.test.js:409-431`).
5. `public/js/v2/board.js:127-130`: replace the pinned `paper:free` lobbyType row with a `{game:'paper', stake:0}`
   pin as an ADDED line; do not touch the snake pin text or the `|| 0)` expression at line 50 (tests at
   `test/v2route.test.js:806-822` and line 211).
6. `test/v2route.test.js:1132-1137` (read): rewrite to assert `built:1`, `ladder:1`, no `solo:1`, no `soon:1`, no
   `duel:1`, no `paid:1`, plus new pins: PAGES contains `paper:` in both source and built bundle, and `/api/live`
   source contains `game: 'paper'`.

index.js edit list (single owner, about 45 lines): require + construct `paperArenas`, `paperMoney`, and call
`paperSockets.attach(socket, deps)` inside `io.on('connection')`; disconnect branch; solvency term; `ALL_ROOMS`
push; `roomLabel` branch; `/paper-mp` route; `/api/live` rows; `paperArenas.sweep` via `everyStaggered`.

---

## 11. Tests (all `node:test`, flat in `test/`, no helper modules in that folder)

| File | What it proves |
|---|---|
| `paperBank.test.js` | every op; closed-account idempotence; withdraw ceiling; 10 000 random op property test: `totalMicro === in - out` after every op; integers only |
| `paperRadius.test.js` | `arenaRadiusFor` at n = 0, 4, 5, 16, 20; growth quick, shrink delayed 3 s then 4 u/s on a fake clock; 0.5 u quanta |
| `paperTrim.test.js` | circle base straddling the wall vs analytic lens area (pins orientation); run that wraps index 0; concave U keeps the anchor piece; base owning the whole disc; SWALLOWED to reseed; protected vertex ABORT mutates nothing; idempotent second call; `checkRing` after every case; fuzz: 300 random blobs x random radii with `Math.random` stubbed |
| `paperArenaGame.test.js` | two humans steer independently from their own bytes; `locked` gives displacement 0.000; kill hook fires once per victim on a double-kill capture; reasons 3/4/5 carry a killer, 1/2/8 none; push keeps units inside through a 950 to 475 shrink with zero deaths (veto) and a real self-cross far from any push still kills; exact-east heading from y = 1000 does not hang; `unit.log` stays empty; two arenas do not share `Vec2.space`; `stop()` clears timers |
| `paperRoomMoney.test.js` | join shows 100000 micro; kill makes killer 200000 and victim 0 in the same tick; chain kill carries 300000; self-cross drops ONE pickup at the death point; pickup collect + `collusion.record(src, dst)` called once with wallets; disconnect drops a pickup and clears the hold; hold: moves 0 during, cancel restores steering, completes at 3000 ms not 2999; killed at 2990 ms pays the KILLER; die mid-hold then respawn: new life has no hold; `onCashout` exactly once, reliable receipt exactly once; free room never calls `onCashout` for payment; paid room `addBot()` returns null and `topUpBots` leaves 0; 17th human gets no seat; pickup pushed inward on shrink, never deleted; `liveStakeTotal` equals alive + floor after every step of a scripted 60 s match |
| `paperMoneyWire.test.js` | fakes for money/db: 90/10 in integers (100000 gives 90000 + 10000; 300000 gives 270000 + 30000); `recordEarnings` only after resolve; reject gives `recordFailedPayout` with `e.broadcast` and zero further `withdraw` calls; duplicate `cashoutId` pays once; `forced` pays 100% and sweeps nothing; `refundEntry` consumes the token once, pays full, never calls `recordEarnings` or `recordStake` |
| `paperSockets.test.js` | refusals (bad stake, maintenance, duplicate, full) all happen with the consume spy at zero calls; bad token at stake 0.10 is refused visibly and never seated; stake `"abc"`, `-1`, `0.5` refused; wallet on the record equals the token's, a client `wallet` field is ignored; respawn uses `socket._paperStake` even if the message names another stake; addPlayer throwing triggers exactly one refund |
| `paperCodec.test.js` | frame and geometry round trip; money u32 exact; direction wrap |
| `paperServer.test.js` | real server on a random port with `DATABASE_URL=''`, `NTFY_DISABLED='1'`, `MONEY_MODE='usdc'` (`test/joinSmoke.test.js:36-67`): free join gets `paper:joined` then frames; paid join with no token gets `paper:refused`; hold asserted "not early" only (`test/cashoutHold.test.js:103-116`); `t.skip` without socket.io-client |

Gates before any push (CI runs nothing, `.github/workflows/deploy.yml:30-35`): `npm test` with the 470 existing tests
still green, `node --check` on every changed file, and, if and only if a file under `public/js/paper/*.js` changed,
the golden parity run and node tests in `../paperio-reference/harness` by hand (600/600 on both seeds).

---

## 12. Task breakdown (no two owners share a file)

Step 0 (half a day, everyone): freeze the contracts in this document: PaperBank API (1.1), ArenaGame callbacks
(`onDeath(victim, killer, reason)`, `spawnHuman`, `findSpawn`, `trimQueue`), room hooks (`onCashout`, `onForfeit`),
wire format (5, 6). After that the six tracks are independent.

| Task | Owner | Files (exclusive) | Depends on |
|---|---|---|---|
| T1 Bank | Money | `server/paper/PaperBank.js`, `test/paperBank.test.js` | none |
| T2 Payout + refund | Money | `server/paperMoney.js`, `test/paperMoneyWire.test.js` | none |
| T3 Sim core | Sim | `public/js/paper/mp/paperArenaCore.js`, `public/js/paper/mp/paperArenaGame.js`, `server/paper/loadSim.js`, `test/paperArenaGame.test.js`, `test/paperRadius.test.js` | none (stubs `trimBaseToWall`) |
| T4 Trim | Geometry | `public/js/paper/mp/paperTrim.js`, `test/paperTrim.test.js` | none |
| T5 Codec | Net | `public/js/paper/mp/paperCodec.js`, `test/paperCodec.test.js` | none |
| T6 Room + directory | Net | `server/paper/PaperRoom.js`, `server/paper/PaperArenas.js`, `test/paperRoomMoney.test.js` | T1, T3, T5 (T4 behind a flag) |
| T7 Socket handlers | Net | `server/paperSockets.js`, `test/paperSockets.test.js` | T6 contract |
| T8 index.js wiring | Money | `server/index.js`, `test/paperServer.test.js` | T2, T6, T7 |
| T9 Client net + mirror | Client | `public/paper-mp.html`, `public/js/paper/mp/paperNet.js`, `paperMirror.js`, `paperMpMain.js` | T5, wire format |
| T10 HUD + touch | HUD | `public/js/paper/mp/paperHud.js` | T9 skeleton |
| T11 Lobby | Lobby | `public/v2.html`, `public/js/v2/play.js`, `public/js/v2/board.js`, `wallet-widget/src/main.jsx`, `public/wallet/widget.js`, `test/v2route.test.js` | T8 for live rows; ships in the SAME commit as T8's route |
| T12 Bot aggro hook (optional) | Sim | `public/js/paper/paperBots.js:44,335`, `public/js/paper/paperUnits.js:480` one-line `preyFor` hooks | golden re-run is the acceptance gate |

Ship order: T1-T5 in parallel, T6-T7, T8 + T11 together with the free arena only (paid rows hidden behind
`PAPER_PAID=1`), play test, then enable $0.10, then $1.00.

---

## 13. Decisions taken here, and the questions they leave for Owen (none block the build)

- D1 Free arena shows no money label and Q simply leaves (worth stays 0 so payout, solvency and drain stay inert).
- D2 No reconnect grace: a disconnect drops the money at once (brief rule 5 read literally).
- D3 Arena full: a second arena of the same buy-in opens; up to 8; after that the door refuses and the unspent
  buy-in can be refunded in full.
- D4 Money left on the floor of an empty paid arena stays there for the next player in. It is never swept.
- D5 If the wall swallows your whole land you are moved to a fresh starting circle; you never die from the shrink.
- D6 A forced exit caused by a server fault pays 100% with no fee.
