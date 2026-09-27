# Paper multiplayer: money and security critique

Date: 2026-09-23. Lens: cheater and auditor. Target: `docs/paper-multiplayer-design.md` (the "design"), checked against
the brief (`docs/paper-multiplayer-brief.md`) and the live code under `server/`, `wallet-widget/` and `public/`. Every
code cite below was read today, not taken from the reader notes. Paths are relative to `slither-clone/`.

## Verdict

The money architecture is sound and most of the lens's classic attacks are closed by construction: the token is one
time and deleted on consume (`server/entryStore.js:53`), worth comes only from the token, the bank is the only place
money lives, death wins a same tick tie with a finishing hold, a closed account transfers and withdraws zero, pickups
go only to live humans with an open account, the hold dies with the unit object, the payout carries its own wallet,
the kill and pickup transfers feed the CollusionMonitor by token wallet, the solvency term counts live plus floor
money, the 90/10 split is integer exact, and the snake's "die mid hold, respawn, instant payout" timer bug
(`server/index.js:2160-2213`, verified real) cannot recur. Two things must change before T3, T7 and T8 are built.
First, the design pays 100 percent of the token's rung on a refund and on a forced exit, but the stake verifier
accepts 99 percent of the rung (`server/money.js:71`) and `tierFor` rounds to whole cents (`server/stakeRules.js:45-55`),
so a refund pays out more than came in; it is a small but repeatable mint, and the "full" refusal that triggers it
can be forced by an attacker for the price of 128 seats. Second, `cashoutId` is built from an arena id plus a per
room counter, and arenas at the same index are re-created after a sweep or an emergency close, so the payout
de-duplicator will silently drop a real cash-out whose money has already left the bank. Both fixes are small and fit
the design. The remaining findings are gaps in the ops and failure paths (floor money invisible to the drain check
and unrecorded across the `pm2 restart` every push performs, a synchronous throw window between bank withdraw and
`money.withdraw`, a ghost unit when `addHuman` throws after spawning) and a handful of minor spec holes.

---

## M1 (blocker) sections 5.5, 5.6, 5.9, 13.2: refunds and forced exits pay more than the stake that landed

**Claim.** `refund` pays "full amount, no rake" (design:343) and `forced` pays `cut = 0` (design:334), both from
`toMicro(entry.worth)` where `worth` is the RUNG (`server/index.js:583`, `entryStore.mint({ stake: rung, worth: rung })`).
But the rung is not what landed on chain. `money.verifyStake` accepts `expected * 0.99` (`server/money.js:71`) and
`tierFor(worth)` compares in rounded cents (`server/stakeRules.js:45-55`): a transfer of 0.099 USDC passes the
verifier (min 99000 units, `server/Usdc.js:124-126`) and `cents(0.099) = Math.round(9.9) = 10` buys the $0.10 rung; a
transfer of 0.996 USDC buys the $1 rung. The honest widget never sends these amounts, but `/api/submit-stake` accepts
any signed transaction (`server/index.js:563`) and a modified client can send exactly them.

**Failing scenario.** Attacker A stakes 0.996 USDC, gets a $1 token, sends `pp:join { stake: 1, entryToken }` while
the $1 rung is refused at the door (maintenance, or `seatFor` returns null). `refuseAndRefund` consumes the token and
`payout.refund` sends 1.000000 USDC. Escrow is down 0.004 USDC plus the SOL transaction fee it paid for the refund.
Repeat: `entryFeeLimiter` allows 10 stakes per minute per IP (`server/index.js:359`). The refusal is attacker
forceable: 128 idle sockets at $0.996 (about $127, 90 percent recoverable by cashing out afterwards) fill all
`MAX_ARENAS_PER_STAKE * MAX_HUMANS` seats (design:91), after which every further join is a refund. The same 100
percent path is `forced` in `emergencyClose` (design:412), which also pays kills gathered from other 99 percent stakers.
The snake never pays 100 percent of a rung anywhere, which is why its 1 percent tolerance has never mattered; the
Knockout draw refund (`server/index.js:1170-1176`) and queue refund (`server/KnockoutLobby.js:261-263`) do, and they
carry the same hole today, so they are not a proven pattern to lean on.

**Evidence.** design:334, 343, 359, 365-368, 412; `server/money.js:71`; `server/stakeRules.js:45-55`;
`server/index.js:563-583`; `server/Usdc.js:119-128`.

**Fix.** A refund or forced payout must never exceed what was verified in. Preferred: carry the verified amount in the
token. `entryStore.mint` stores `paid` and `consumeAtStake` returns it (two lines in `server/entryStore.js`, which has
no owner: give it to T9 with `server/index.js:583` becoming `mint({ stake: rung, worth: rung, paid: worth, ... })`), and
`refund` / `forced` pay `min(micro, toMicro(paid))`. Fallback if the owner does not want `entryStore.js` touched:
section 2 gains `REFUND_HAIRCUT_DIV = 100` ("the verifier's own 1 percent, `server/money.js:71`, so a refund can never
exceed what landed") and `refund` and `forced` pay `micro - Math.ceil(micro / REFUND_HAIRCUT_DIV)`. Either way
`paperPayout.test.js` (section 11, T3 acceptance) gains: "a refund of a 100000 token whose `paid` is 99000 sends
99000, never 100000" and "forced never sends more than `paid`". Owner question 13.2 should state this consequence:
whatever is refunded is bounded by the on chain amount, not the rung.

---

## M2 (blocker) sections 5.4, 5.5, 6.1: `cashoutId` repeats after an arena is re-created, and the de-duplicator then drops a real payout

**Claim.** `completeCashout` builds `cashoutId: arenaId + ':' + (++seq)` (design:323) and `payCashout` returns at once
on `seen.has(order.cashoutId)` (design:333). `seq` is per room and `arenaId` is never defined; the only arena
identity the design gives is `lobbyType` = `paper_na_s1` plus `#n` (design:393). Overflow arenas are deleted by
`sweep` after five empty minutes (design:428) and created again by `seatFor` at the same index (design:426-427), and an
emergency close "stops and replaces" an arena (design:412). The replacement starts with `seq = 0`, so its first cash
out is `paper_na_s1#1:1`, an id the previous arena at that index already used. The bank has already withdrawn
(design:321) and the unit is already removed (design:322) when `payCashout` silently returns: no `money.withdraw`, no
`recordFailedPayout`, not even `pp:cashedout`.

**Failing scenario.** Evening one: the $1 rung overflows, arena #1 sees one cash-out (`…#1:1`), then empties and is
swept. Evening two: the rung overflows again, arena #1 is created again, player P holds Q for 3 seconds with $3.00 in
the bank. `bank.withdraw` returns 3000000 and closes the account, P's square is removed, `payCashout` sees `…#1:1` and
returns. P is owed $2.70 and nothing on the server knows it.

**Evidence.** design:323, 333, 393, 412, 426-428; contrast the snake, whose single payout guard is "zero the worth
first" with no id de-duplication at all (`server/index.js:2214-2217`), and Knockout, whose `_koPaid` latch is keyed by a
room id that is never reused (`server/index.js:1157-1160`).

**Fix.** Make the id unique for the life of the process and beyond: `cashoutId = crypto.randomUUID()` (the same
primitive the entry token uses, `server/entryStore.js:34`), or `REGION + ':' + bootMs + ':' + (++processWideSeq)` where
`bootMs` is captured once in `paperPayout.create`. The `seen` branch must not be silent: log
`[PAPER] CASHOUT duplicate id` with the order, because a duplicate that reaches it now means a bug, not a retry.
Section 11 `paperPayout.test.js` gains "two rooms with the same label each pay one cash-out; both `withdraw` calls
happen"; `paperArenas.test.js` gains "an overflow arena swept and re-created pays its first cash-out".

---

## M3 (major) sections 5.8, 5.9, 13.1: floor money is invisible to the drain check and vanishes without a record on every deploy

**Claim.** `ops.drainStatus` reads only `room.snakes` and counts `paid` from entries with `alive && worth > 0`
(`server/ops.js:57-66`); the design's `snakes` getter lists live paid humans only and says floor money "does not block
a drain" (design:390-392). So `maintenance:check` (`server/index.js:1021-1022`) reports `safe: true` with real USDC on
the floor. The design then calls the restart limitation "shared with the snake" and says "the console warns first"
(design:413), which is only true for money on live squares. It is worse than the snake in two ways: money persists on
the floor with nobody connected, for ever by the 13.1 default, and a deploy is `git reset --hard && pm2 restart`
(`.github/workflows/deploy.yml:34-35`) with no `SIGTERM`/`SIGINT` handler anywhere in `server/index.js` (grep: none).
Every push wipes it, and nothing durable says how much or whose it was. The solvency monitor then reports a surplus
that is really unrecorded house income.

**Failing scenario.** P drops $2.00 by disconnecting in the $1 arena. The owner runs `maintenance:check`, reads
"safe", pushes a commit. The escrow now holds $2.00 that no ledger row, no `trackEarning` call and no failed payout
row describes; a later solvency shortfall or surplus cannot be reconciled.

**Evidence.** design:390-392, 413, 428, 787-788; `server/ops.js:57-77`; `server/index.js:1021-1022`; deploy.yml:34-35.

**Fix.** (a) The `snakes` getter also emits one synthetic entry per floor coin, `['coin:' + pid, { alive: true, isBot:
false, worth: micro / 1e6 }]`, so `drainStatus` counts it and `safe` is honest; `paperRoomMoney.test.js` "snakes getter
shape" asserts a coin appears. (b) T9 adds a `process.on('SIGINT')` and `('SIGTERM')` hook in section 6.4 that writes
one line per paid arena, `[PAPER] BANK <label> <JSON of open accounts {wallet, name, micro} and coins {pid, srcWallet,
micro}>`, to stdout before exit (pm2 keeps the log), and `PaperRoom` writes the same line whenever a paid arena goes
idle. (c) State the consequence under 13.1: with the default, every deploy converts floor money into unrecorded escrow
surplus; if the owner keeps the default, the (b) log is the only record, and `trackEarning({ source: 'paper_floor_lost'
})` at boot is not possible because the amount is gone with the process.

---

## M4 (major) sections 5.4, 5.5: a synchronous throw between `bank.withdraw` and `money.withdraw` loses the money with no record

**Claim.** `completeCashout` is "all synchronous, nothing awaited": bank withdraw and close, unit removed, then
`hooks.onCashout(order)` (design:319-324). `payCashout` runs `seen`, the split, `trackEarning`, `sweepRake`, an `io`
emit and only then `money.withdraw(...)` (design:333-341). Nothing in the design says what happens if any statement
before `money.withdraw` throws synchronously, or if `payCashout` itself is missing (a hook wired wrong in T9). The
account is closed and the unit is gone, so the money cannot be put back, and `recordFailedPayout` is only reached
from the `.catch` of a promise that was never created. The snake has the same shape (`server/index.js:2209-2264`) but
hides it behind `doCashout().catch(console.error)`, which is a log line, not a ledger row; the design is new code and
should do better than the copy.

**Failing scenario.** `analytics.captureEarning` (`server/analytics.js:44-52`) or `io.to(order.socketId)` throws for
any reason on the completing tick. The tick try/catch (design:412) logs and skips. P's $0.90 is neither paid nor in
`failed_payouts`. Three such ticks trigger an emergency close that pays everyone else.

**Evidence.** design:319-324, 333-341, 412; `server/index.js:2209-2264`.

**Fix.** Two lines in the spec. `payCashout` computes `net` first and then runs EVERYTHING else inside one promise chain
that starts with `Promise.resolve()`, so any throw lands in the single `.catch` that writes `recordFailedPayout(wallet,
net / 1e6, name, 'paper ' + label + ': dispatch: ' + e.message, e.broadcast)`. `completeCashout` wraps the
`hooks.onCashout` call in try/catch and, on a throw, calls `hooks.onRefund({ wallet, name, micro: net, why:
'cashout-dispatch' })` so the order is still paid by a path that exists. Section 11 `paperPayout.test.js` gains "a
`trackEarning` that throws still results in exactly one `withdraw` call" and `paperRoomHold.test.js` gains "an
`onCashout` that throws leaves the bank closed and calls `onRefund` once".

---

## M5 (major) sections 4.2, 5.1, 5.6: `addHuman` spawns before it deposits, and the duplicate id rule meets a u16 counter

**Claim.** `addHuman` runs `game.spawnHuman` then `bank.deposit(unit.id, ...)` (design:370). `deposit` "throws on a
duplicate id" (design:271) and closed accounts remain queryable ("0 for unknown or closed", design:272), so nothing
says a closed account is ever deleted. `unit.id` is "u16, monotonic per arena" (design:176) and bots draw from the
same counter (`addUnit` assigns every unit an id, design:225). If `deposit` throws, the design refunds once
(design:359) but never removes the unit that `spawnHuman` already added, and step 9 (`socket._ppRoom`) never runs, so
`drop(socketId)` cannot find it either (see M12).

**Failing scenario.** (a) Any `deposit` throw: a ghost square with no account and no socket sits in a paid arena for
ever, holds a seat, keeps the radius up, and can be killed for nothing (its `bank.balance` is 0, so `onDeath` takes the
`victim.isHuman` branch and calls `drop` on an account that does not exist). (b) The free arena #0 lives for the
process lifetime and its 15 bots die and respawn continuously; after 65536 units the id wraps and a human's fresh id
equals a closed account's id, so `deposit` throws and every free join from then on is `seat-failed`.

**Evidence.** design:176, 225, 271-272, 359, 370.

**Fix.** Order: `bank.deposit` FIRST (it cannot fail for a fresh id and an integer amount), then `spawnHuman` inside a
try/catch whose catch calls `bank.withdraw(unit.id)` (returning the deposit to nothing, the refund then pays it) and
rethrows; `addHuman` therefore never leaves a unit without an account or an account without a unit. `deposit` throws
only when the id is currently OPEN; `withdraw`, `drop` and `transferAll` delete the closed account (the `pickups` map
keeps the money). The id counter wraps at 65536 and skips ids still held by a live unit. Section 11
`paperArenaGame.test.js` gains "70000 addUnit calls never hand out an id held by a live unit", `paperBank.test.js` gains
"deposit after withdraw of the same id succeeds", `paperSockets.test.js` "addHuman throwing" adds "and the arena has no
unit for that socket".

---

## M6 (minor) sections 2, 5.4: the hold is counted in float milliseconds, the constant is stated in ticks

**Claim.** `holdMs += STEP_MS` per tick and completes at `holdMs >= HOLD_MS` (design:315-317); `STEP_MS = 1000 / 60` is
not exact in binary and 180 repeated additions may land a few ulp under 3000, making the hold 181 ticks on some
builds and 180 on others. The design's own words are "counted in SIM time (180 ticks)" (design:93).

**Failing scenario.** `paperRoomHold.test.js` "179 pays nothing, 180 pays" passes on the dev PC and fails on the
server after a node upgrade changes nothing but the summation order in a refactor; or the reverse.

**Evidence.** design:93, 315-317.

**Fix.** Section 2 gains `HOLD_TICKS = Math.round(HOLD_MS / STEP_MS)` (180) and the unit keeps an integer `holdTicks`;
the wire byte becomes `holdTicks * 255 / HOLD_TICKS`. No test change beyond reading the new constant.

---

## M7 (minor) sections 5.5, 5.9: a refund that fails and is recovered by the drainer is recorded as earnings

**Claim.** The design says refunds never call `recordEarnings` (design:343-344) and criticises the Knockout refund
for doing so (`server/index.js:1245`). But a failed refund goes to `recordFailedPayout` (design:410), and the NA
drainer calls `db.recordEarnings(row.wallet_address, row.name, row.amount_sol, ...)` on EVERY recovered row
(`server/index.js:1983`), with no field that distinguishes a refund from a cash-out (`claimDuePayout` returns no
`reason`, `server/db.js:260-276`).

**Failing scenario.** RPC outage during maintenance; ten refused $1 joins queue ten refund rows; the drainer pays
them an hour later and the top earners board shows $10 of "winnings" for stakes that were merely returned.

**Evidence.** design:343-344, 410; `server/index.js:1969-1996`, `1983`; `server/db.js:239-276`.

**Fix.** T9 (owner of `server/index.js`) has the drainer skip `recordEarnings` when `row.reason` starts with `refund`,
which needs `reason` added to the `RETURNING` list of `claimDuePayout` (one token in `server/db.js:270`, assign to T9),
and `paperPayout.refund` writes its failed row with `reason = 'refund paper ' + why + ': ' + e.message`. Section 11
`paperPayout.test.js` "refund failure row reason begins with `refund`".

---

## M8 (minor) sections 5.6, 6.1, 13.2: the "full" refusal is cheap to force, and every refund costs the escrow gas

**Claim.** `MAX_ARENAS_PER_STAKE = 8` times 16 humans is 128 seats per rung (design:91). An idle paid square inside its
own spawn base cannot die, so 128 sockets at $0.10 ($12.80, 90 percent of it recoverable) hold the dime rung shut
against every honest player, and each honest join then becomes a refund, an escrow signed USDC transfer that pays
the Solana fee and, per M1, a little more than it received. The brief's cap is 16 per arena, not 128 per rung, so
the number is the design's own.

**Evidence.** design:91, 355, 426-427; `server/Usdc.js:226-236` (escrow pays the fee).

**Fix.** Keep the seat cap but do not refund on `full`: reply `pp:refused { why: 'full', refunded: false, retryMs }` and
leave the token valid (five minute TTL, `server/index.js:374`, and it is game agnostic, so the lobby can also spend it
on the snake at the same rung, design:709-711). Refund only `maintenance` and `seat-failed`, where the server, not the
crowd, is the reason. State this under 13.2. If the owner prefers the refund on `full`, `MAX_ARENAS_PER_STAKE` should
rise so the cost of forcing it is not pocket money.

---

## M9 (minor) sections 5.1, 6.4: `onTransfer` has two signatures and the label has no source

**Claim.** The bank calls `onTransfer(srcWallet, dstWallet, micro, 'kill')` with four positional arguments (design:273,
276); `server/index.js` wires `onTransfer = (t) => collusion.record(t.srcWallet, t.dstWallet, t.micro / 1e6, { lobbyType:
t.label })` expecting one object with a `label` (design:458). The bank is pure and knows no lobby label, so `t.label`
is `undefined` and `CollusionMonitor.record` stores `lobbyType: '?'` (`server/CollusionMonitor.js:47`), losing the rung
in every collusion flag.

**Evidence.** design:273, 276, 458; `server/CollusionMonitor.js:42-52`.

**Fix.** Pick the object form: the bank calls `onTransfer({ srcWallet, dstWallet, micro, kind })` and `PaperRoom`
wraps it, adding `label: this.lobbyType` before forwarding to the injected hook. `paperRoomMoney.test.js` "onTransfer
called once with the dropper's wallet" also asserts `label`.

---

## M10 (minor) section 5.6: a seat-failed refund leaves a stake row with no matching refund record

**Claim.** Step 7 consumes through `consumePaidEntryAtStake`, which writes `db.recordStake` (`server/index.js:401-410`)
before the seat exists; a step 8 throw then refunds (design:359) without any row that says so, while `maintenance` and
`full` deliberately consume directly and write nothing (design:365-366). `stakes_history` therefore over-counts by
exactly the seat-failed refunds and the two refund paths disagree with each other.

**Evidence.** design:359, 365-366; `server/index.js:401-412`; `server/db.js:322-329`.

**Fix.** Log every refund as `[PAPER] REFUND <wallet> <micro> <why>` and accept the drift (it is stats, not money), or
have `refund` call `trackEarning({ source: 'paper_refund', game: 'paper', amountUsdc: 0, ... })`; do not add a negative
stake row, `recordStake` rejects `amt <= 0` (`server/db.js:324`). Note it in 5.9 so nobody later "fixes" the two paths
into agreement by recording the maintenance refunds as stakes.

---

## M11 (minor) section 5.9: the emergency close is a rake free exit, and its trigger is not proven client proof

**Claim.** Three consecutive thrown ticks pay every live paid human 100 percent (design:412). If any client
controlled value can make the tick throw (the input integer is validated only as `Number.isInteger` and `angle <= 253`,
design:438; `pp:need` and `pp:join` payloads are objects), a player who has just taken $10 of kills gets it without the
house cut, and per M1 slightly more than the arena took in. The design's reason ("the house does not profit from its
own bug") is fair; the exposure is that the bug's trigger may be in the player's hands.

**Evidence.** design:412, 438; the tick try/catch at design:254-255.

**Fix.** `forced` keeps 100 percent but is bounded by M1's `paid`; `emergencyClose` calls `notify.pushOwner` (the pattern
at `server/index.js:2130-2135`) with the arena label and total paid out, and the replacement arena for that stake
opens only after `EMERGENCY_REOPEN_MS = 60000` (section 2) so a repeatable trigger yields at most one exit a minute.
Section 11 `paperSockets.test.js` gains a fuzz: 10000 random integers (negative, above 2^24, NaN, strings, objects) into
`pp:in`, `pp:need` and `pp:join` throw nothing.

---

## M12 (minor) section 5.7: `drop(socketId)` cannot find the arena from the socket state the design allows

**Claim.** `paperSockets.drop(socketId)` receives only the id (design:145, 379), and the only socket state permitted is
`socket._ppRoom` and `socket._ppStake` (design:375), which `drop` does not receive. Either `paperSockets` keeps its own
`Map<socketId, room>` (unstated) or `drop` scans `arenas.all()` (unstated, and a unit spawned by an `addHuman` that
threw after `spawnHuman` is in no map, see M5). The disconnect handler is the path that drops a holder's money, so an
unfound unit means a hold that keeps counting for a socket that is gone.

**Evidence.** design:145, 375, 379-381; `server/index.js:2828-2835`.

**Fix.** State it: `paperSockets` keeps `bySocket: Map<socketId, room>` written at step 9 and cleared in `drop`, and
`drop` also calls `arenas.findBySocket(socketId)` as a fallback that logs when the map missed. `paperSockets.test.js`
gains "disconnect after a successful join drops a coin; disconnect after a failed join leaves no unit".

---

## M13 (minor) sections 5.6, 6.1: respawn into a swept or stopped `_ppRoom`

**Claim.** `pp:respawn` has `seatFor` "try the current arena first" (design:373), but the current arena may have been
deleted by `sweep` (design:428) or stopped by `emergencyClose` (design:412) while the socket sat on the death screen.
Nothing says a stopped room refuses `addHuman`, so a token could be consumed into an arena whose interval never runs
again: money deposited, square never ticks, cash-out impossible, disconnect drops a coin nobody can reach.

**Evidence.** design:373, 412, 428.

**Fix.** `seatFor(stake, preferred)` ignores a `preferred` room that is stopped or no longer in the list, and
`PaperRoom.addHuman` throws `'stopped'` when `stopped` is set (which routes into the once-only refund of step 8).
`paperArenas.test.js` gains "respawn after the overflow arena was swept seats in a live arena".

---

## Checked and found correct (so the next reader does not re-derive them)

- Token replay and shared token: `consumeAtStake` deletes on success (`server/entryStore.js:53`); the join handler is
  one synchronous turn, so two sockets with one token cannot both pass step 7.
- Stake from the client is bounded by the token: `Math.abs(t.stake - stake) > EPS` refuses a rung mismatch
  (`server/entryStore.js:52`), and `isStake` (`server/stakeRules.js:46`) rejects everything off the ladder.
- A paid token at stake 0 is neither consumed nor credited (`server/entryStore.js:49`), so the free arena cannot mint
  and a paid token cannot be burnt by a free join.
- Double kill: `victim.death` is set in stock `kill` (`public/js/paper/paperGame.js:345`) before anything else, and
  the capture loop skips dead units (`paperGameMoves.js:195`); the bank's closed account moves nothing either way.
- Kill and cash-out in one tick: deaths run inside `super.update`, holds in the post pass, so the killer is paid.
- Respawn is a new buy-in at `socket._ppStake`, the snake's rule (`server/index.js:2360-2370`).
- `recordStake`, `recordEarnings` after `withdraw` resolves, `recordFailedPayout` with `e.broadcast`, `trackEarning` and
  `sweepRake` before the player's transfer: all as `doCashout` does (`server/index.js:2209-2258`).
- Integer split: `floor(gross / 10)` with all stakes multiples of 100000 micro, so the cut is exact and
  `Usdc.toUnits` (`server/Usdc.js:40`) round-trips `net / 1e6` without loss.
- Solvency: `bank.totalMicro()` per arena counts live and floor money once; pending on-chain payouts are excluded on
  the same side as the snake (surplus, never a false shortfall).
- CollusionMonitor: fed on kill and pickup with token wallets; `src === dst` is ignored (`server/CollusionMonitor.js:43`),
  so two sockets on one wallet cannot mint and cannot pollute the pairs.
