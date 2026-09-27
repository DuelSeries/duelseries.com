# Refuter verdicts: money-security

Recorded 2026-09-27 from the stored result of the critics workflow run `wf_819cd852-cba` (finished 2026-09-24, script
`paper-mp-critics-wf_819cd852-cba.js`), which is where the independent refuters wrote their verdicts; until this file the
verdicts existed only inside that run record, not on disk next to the critic file. The findings and their text are in
`docs/paper-mp/critic-money-security.md`. "Downgraded to X" is the severity the refuter left the finding at. "No refuter result"
means the run recorded no verdict for that finding (the workflow log says "4 refuter results missing"). "In design 14"
says whether design section 14 lists the finding as applied. The reasons below are the refuters' text verbatim; the
line numbers they cite (`design:NNN`) are those of the FIRST draft, before the revisions.

| ID | Refuter verdict | In design 14 |
|---|---|---|
| M1 | downgraded to major | yes |
| M2 | confirmed (blocker) | yes |
| M3 | downgraded to minor | yes |
| M4 | downgraded to minor | yes |
| M5 | downgraded to minor | yes |
| M6 | confirmed (minor) | yes |
| M7 | confirmed (minor) | yes |
| M8 | REFUTED (reason below) | no |
| M9 | confirmed (minor) | yes |
| M10 | downgraded to minor | yes |
| M11 | REFUTED (reason below) | no |
| M12 | REFUTED (reason below) | no |
| M13 | confirmed (minor) | yes |

## Refuted findings, the refuter's reason verbatim

### M8. The 'full' refusal is cheap to force and every refund costs the escrow gas

The refund on 'full' adds no payout capability an attacker lacks: brief rule 3 mandates a 90 percent cash-out on a 3 second hold that any staker triggers at will, paid through the same escrow-fee-paying path (server/Usdc.js:220-236, feePayer = escrow, one signature, no priority fee, about 5000 lamports), so escrow already pays one tx fee per cycle for a 10 percent rake ($0.01 at the dime rung); the refund route costs the attacker 128 x $0.10 locked plus 128 stake fees, and every cycle still needs a fresh on-chain stake and one-time token (server/index.js:544-583, markStakeSig :568, entryFeeLimiter 10/min/IP :359), all to save that $0.01, while 'pays more than it received' is M1's defect and is closed by M1's bound, not by removing the refund. The proposed fix is unsound: no lobby path re-spends a token, stakeAndPlay and the duel:restake bridge both call stakeOnly (a new on-chain stake) on every launch (wallet-widget/src/main.jsx:184, 366) and the design page discards the token after one pp:join (design:588), so under the critic's own scenario an honest player's $0.10 sits in a 5 minute token (server/index.js:374) and is then kept by escrow, turning a ~$0.001 escrow gas cost into a $0.10 loss for an honest player, contradicting the brief's 'money code must be correct' and the design's 5.9 row and section 11 test (design:401, 748). It also reverses owner question 13.2 (design:789-790, default yes), which this review must not decide, and raising MAX_ARENAS_PER_STAKE trades a bounded refusal for more 60 Hz sims (design:255-256), an availability matter the snake shares with no cap at all (server/GameRoom.js has no capacity, server/LobbyRegistry.js:76 reports capacity || null). Holding a rung shut is a DoS on availability, not a money defect, and the cap is what converts a CPU flood into a refunded refusal.

### M11. The emergency close is a rake-free exit whose trigger is not proven client-proof

No client value reaches the tick unbounded: design:438 validates `pp:in` to an integer with angle <= 253 and design:177-181 has the sim consume only `angle` 0..253 (`rotate(this.angle * Math.PI / 127)`), `holdBit` and a u8 `seqAck` (design:478) with the stock turn cap bounding any byte (design:187-188), while `pp:join` (design:349-359, `sanitizeName` server/index.js:74-76, `socketRL` :62-68) and `pp:need` (design:439, 449, a cache read at :500) run entirely inside socket handlers, which socket.io 4.8.3 dispatches in `process.nextTick` (node_modules/socket.io/dist/socket.js:689-697) so a handler throw can never increment the `wake` step's consecutive-failure counter (design:254-255); the critic names no payload that reaches the tick and there is none. Even granting a throw, design:412 already states the bound: `bank.withdraw` cannot return more than `inMicro - outMicro` (design:284-286), so a forced close pays at most what the arena took in, the attacker's only gain being the 10 percent cut on money they already hold and could cash out at 90 percent, once per arena (once-only latch), which is the design's explicit choice ("the house does not profit from its own bug"). The fix is unsound: bounding `forced` by M1's per-token `paid` (critic:56, 273) would cap a $1 player holding kills at 0.996 USDC and leave the remainder withdrawn from the bank but unpaid, contradicting brief rule 2 ("you get ALL of their money") and the no-profit-from-bug rule; `EMERGENCY_REOPEN_MS` needs a new closed-until state because `seatFor` (design:423-425) otherwise just opens an overflow arena, and during that minute every paid join at the rung becomes `refuseAndRefund('full')` (design:353), the 100 percent refund path the critic itself attacks in M1 and M8 (gas per refund), while honest players are locked out. One side observation outside M11: server/ has no `uncaughtException` handler (grep), so a non-object payload such as `null` to a destructuring `pp:join`/`pp:need` handler would be a process crash (memory-only money lost), never an emergency close; that is a cheap handler guard plus a test row, not this finding's defect.

### M12. drop(socketId) cannot find the arena from the socket state the design permits

The lookup is expressible from APIs the design already states: paperSockets is built with the `arenas` dep (design:456), `arenas.all()` exists (design:428) and PaperRoom, which owns the sockets (design:143), answers `hasLiveUnit(socketId)` keyed by socket id (design:353) and exposes `snakes` as a `Map<socketId,...>` (design:390), so `drop(socketId)` is a scan of at most MAX_ARENAS_PER_STAKE x 3 rooms; Socket.IO 4.8.3 does remove the socket from the namespace before emitting `disconnect` (node_modules/socket.io/dist/socket.js:551-554, 564), which only rules out `io.sockets.sockets.get`, not the scan. The stated harm cannot happen: a gone socket sends no `pp:in`, and design:314 cancels a hold when `now - lastInputAt > HOLD_INPUT_STALE_MS` (5.9 "hold: stale input", tested at design:745 "input stale for 500 ms cancels"), so a hold never "keeps counting" to `completeCashout` for a disconnected player. The disconnect-drops-a-coin behaviour is already specified and tested at the room level (design:744 "disconnect drops a coin and clears the hold", plus the 5000-tick run with disconnects). The M5 ghost is M5's defect (fix belongs in `addHuman`), and the proposed `bySocket` map written at step 9 has exactly the same gap as `socket._ppRoom` (step 9 never runs when step 8 throws), so it would not find that unit either while adding a second copy of `_ppRoom` state that must stay consistent through death and respawn (design:372).
