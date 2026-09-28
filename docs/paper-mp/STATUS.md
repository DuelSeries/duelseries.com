# Paper multiplayer: design phase STATUS

Written 2026-09-23 by the old chat when its design workflow finished; updated 2026-09-23 after the critics ran and the
owner answered. The build continues in a FRESH chat (see ../../../HANDOFF.md).

## Result

- Final design: docs/paper-multiplayer-design.md (merged from the three designs in docs/paper-mp/design-*.md, notes in docs/paper-mp/understand-*.md), REVISED by the critic pass below; section 14 of the design lists every applied finding.

### Critics ran 2026-09-23

Three adversarial critics attacked the design and independent refuters checked every finding. Only confirmed and
downgraded findings were applied; refuted ones were not.

| Lens | File | Findings | Confirmed | Downgraded | Refuted |
|---|---|---|---|---|---|
| money-security | docs/paper-mp/critic-money-security.md | 13 | 5 | 5 | 3 (M8, M11, M12) |
| netcode-feasibility | docs/paper-mp/critic-netcode-feasibility.md | 23 | 8 | 7 | 8 (M8, m3, m6, m10, m11, m12, m13, m14) |
| parity-scope | docs/paper-mp/critic-parity-scope.md | 19 | 6 | 11 | 2 (m6, m7) |
| total | | 55 | 19 | 23 | 13 |

Counts follow the stored refuter verdicts in docs/paper-mp/refute-*.md; findings with no refuter result (netcode M7, parity M1, m9, m11) count as surviving. All 41 surviving findings were applied in place to docs/paper-multiplayer-design.md by a single editor (2026-09-23),
together with the owner's four answers (docs/paper-mp/OWNER-ANSWERS.md). Biggest changes: cash-out ids are UUIDs;
trims share the border's registered vertex objects; refunds are bounded by what landed on-chain; input is a per-human
FIFO with one pop per tick; the predictor carries the server's dt bias and shares the guarded border; the push never
crosses the own trail and its veto is scoped to the push piece; the emergency close pays at the normal 90/10; the
parity gate is a pinned-commit diff plus a blob-id test; a dev entry-token mode makes the paid HUD testable locally;
plus the disconnect grace, the reconnect path and the one-hour floor sweep from the owner's answers. Checked again 2026-09-27 against docs/paper-mp/refute-*.md: parity m10 is CONFIRMED there (this table first listed it as refuted), so it was applied too (a push across a foreign trail is a normal kill, open question 7), plus two refuter side notes (null payload guard on every socket handler; trim enumeration wording, `_verDirty` removed). Design section 14 lists all 42. The synthesizer
summary below is kept as history; where it disagrees with the design, the design wins.

## Summary from the synthesizer (2026-09-23, before the critics; history)

Final design written. Base is reuse-first (scores: reuse 26, netcode 24, money 24): zero edits to any solo file so golden parity holds by construction, stock P.Game with player null as the server tick, ArenaGame/ArenaHuman/SafeArenaBorder in new files, bots hunt humans through a player getter plus a per-bot update wrap (fallback: three one-line preyFor hooks gated on a golden re-run). Grafted from money-first: a pure PaperBank in integer micro-USDC where only deposit and withdraw change the arena total (mint-proof ceiling), a payout order that carries its own wallet, handler-order test with a consume spy, death wins a same-tick tie with a finishing hold, a once-only emergency close. Grafted from netcode-first: input as one volatile integer with seq, angle byte and the hold bit, per-unit ack byte, a pure fixed-step predictor with replay, one playback timeline for remote squares and reliable events, one ordered reliable bundle per snapshot tick, ring cache with an encode budget, a client ring clamp so shrinking costs no ring bandwidth, and all three rungs launching through the wallet widget. Five defects found in the source designs and fixed, each verified in code: (1) reuse-first put callbacks on this.events, which the stock game owns (paperGame.js:93,345); (2) the claimed no-login free launch does not exist because launch() requires a connected wallet before the OWN_PAGE shortcut (play.js:258-262 vs 281), so Paper leaves OWN_PAGE; (3) botsCount 16 with no humans spawns a 16th bot with an undefined type because the type rows have 15 entries (paperGame.js:44-49,204-209), so the free arena uses 15 idle and 16 with humans; (4) float house cut replaced by integer floor(gross/10); (5) trim applies commit-then-remove so kept vertices never leave their grid cell. The doc contains one shared constants table with a reason per value, event names and payloads, the exact byte layout of the volatile frame, the cash-out state machine (sim-time 180 ticks, hold bit stale after 500 ms), the join order with refusals before token consume and a server-only one-time refund, a failure table for every money transition, the radius easing, push and timed wall-death veto (since replaced by the push-piece veto, design 9.3), the trim plan/apply/fallback algorithm, lobby wiring, 16 test files (now 18 new plus 2 edited), and 14 tasks with exclusive file ownership, dependencies and measurable acceptance checks. Paid rungs ship behind PAPER_PAID=1 after a free playtest; the trim ships behind a switch until the soak test passes.

## Task list (from design section 12 as revised 2026-09-23; no two tasks own the same file)

- **T1 Wire codec, shared constants block, guarded border, parity gate test**  files: public/js/paper/mp/paperWire.js, test/paperWire.test.js, test/paperParityGate.test.js  depends on: none
  acceptance: both test files pass (radiusFor table, wallInside vs brute force on 10,000 points, frame/ring/trail/input round trips, money u32 exact and saturating, pct saturation, trail decimator within 0.35 u and under 200 corners for a 5000-point wall crawl, guardedBorder caps and resets and shares registered vertex objects); module loads standalone under node require (no DuelPaperLib at load time) and as a classic browser script; every constant of design section 2 is exported from MP; the parity gate test pins the eleven solo files' blob ids at bffe6d5.
- **T2 PaperBank: all in-arena money in one pure object**  files: server/paper/PaperBank.js, test/paperBank.test.js  depends on: none
  acceptance: test/paperBank.test.js passes including 10,000 random ops (with sweeps) with totalMicro() === inMicro - outMicro after every op, closed accounts deleted so an id can be reused, sweepPickup, onTransfer with one object, and the withdraw ceiling; the file contains zero require calls.
- **T3 Payout, refund and floor-sweep module with injected deps**  files: server/paperPayout.js, test/paperPayout.test.js  depends on: none
  acceptance: test/paperPayout.test.js passes: 100000 gives 90000 + 10000 in integers, recordEarnings only after withdraw resolves, a rejection writes recordFailedPayout with e.broadcast and makes zero further withdraw calls, two orders from same-label rooms each pay and a duplicate order object pays once and logs, a throwing trackEarning still yields one withdraw, refunds bounded by paid (99000 for paid 0.099, the rung for paid 1.5 or undefined), refund never records earnings and its failed row reason begins with refund, sweepFloor records paper_floor and never earnings; no forced path; the file never reads a socket property.
- **T4 Server sim: ArenaGame, ArenaHuman, radius, push, rewindTrail, prey, bot level, spawn, reseat**  files: server/paper/loadPaperLib.js, server/paper/ArenaGame.js, test/paperArenaGame.test.js, test/paperRadius.test.js  depends on: T1
  acceptance: both test files pass (own-byte steering, lock displacement 0.000, two arenas keep separate grids, exact-east no hang and wallInside after the push, never more than 15 bots or 16 squares and no bot with undefined type, bot level follows the leading human and the spawn row follows the level, spawnBot inert when paid, magnet-path attack test, onDeath once per victim, id wrap never hands out 0 or a live id, overlay self-cross at the wall still kills, presser and slider survive 1500 shrink ticks inside the wall with simple trails and pushCrossings 0, shrink delay 3000 ms then 4 u/s in 0.5 u quanta, shrink end bumps wireVer once per wall-touched base); `git diff --stat bffe6d5 -- ':(glob)public/js/paper/*.js' public/paper.html` prints nothing; steady tick with 16 squares under 0.2 ms on the dev PC.
- **T5 Territory trim: pure plan, commit-then-remove apply, checkRing**  files: server/paper/arenaTrim.js, test/paperTrim.test.js  depends on: T1
  acceptance: test/paperTrim.test.js passes: analytic lens area within 0.5 percent, kept Vec2 identity preserved, wall vertices ARE the border's own objects (one lobe and whole-disc), grid point count balanced, wrap past index 0, concave U keeps the anchor prong and subtracts the dropped area with no ['cap'], whole-disc case, blocked cases mutate nothing (ring deep-equal before and after planTrim), a capture after a trim carves without throwing, a slider along a trimmed run for 300 ticks both ways with zero throws (then growth back and repeat), checkRing incl. simplicity and the 2^-26 rule, 300-blob fuzz with zero throws.
- **T6 Server wire builder: wire trails, ring cache, frame and join payloads**  files: server/paper/arenaWire.js, test/paperArenaWire.test.js  depends on: T1, T4
  acceptance: test/paperArenaWire.test.js passes (one encode per ring version, fresh base encoded in its first post pass, budget of 3 per tick defers the rest, epoch bumps on return and rewind, 8 dropped frames plus 10 Hz batches rebuild the same trail through a test double of the 7.4 contract, plain trim sends no ring, shrink-end re-send carries ver + 1 and is never doubled, mid-shrink join clamped within 0.06 u); one frame encode for 16 squares under 0.1 ms; frame exactly 412 B for 16 empty-tail units and exactly 668 + 10P B at TRAIL_TAIL_MAX; a turn-cap human yields tailN <= 2 per window.
- **T7 PaperRoom (seats, grace, pickup sweep, hooks) and PaperArenas directory**  files: server/paper/PaperRoom.js, server/paper/PaperArenas.js, test/paperRoomMoney.test.js, test/paperRoomHold.test.js, test/paperRoomBots.test.js, test/paperArenas.test.js  depends on: T1, T2, T4, T6 (T5 behind a flag)
  acceptance: all four test files pass, including the 5000-tick random conservation run (joins, kills, coins, cash-outs, disconnects, graces, sweeps, shrinks) with assertConserved() true every tick, HOLD_TICKS - 1 ticks pays nothing and HOLD_TICKS calls onCashout exactly once (read from P.MP), killed on the completing tick pays the killer, a 59 minute coin is collectable and a 61 minute coin is swept exactly once (ticking and frozen), the grace tests (hold cancelled at disconnect, square keeps moving, killable, expiry drops a coin, resume keeps the seat with no deposit), a join between ticks never receives an event older than its payload, a reseat moves no money, three thrown ticks cash out every live account at 90/10 with UUID ids and refund every coin once then a fourth throw pays nothing, 17th human opens an overflow arena, overflow with floor money is never swept, a swept-and-recreated arena pays its first cash-out, a stopped preferred room is skipped, seatByKey, the 60 s sweep runs sweepPickups on a frozen room, paid room addBot returns null, a missing hook throws at construction, a throwing removeHuman still dispatches the order once, the [PAPER] IDLE line; neither file requires money, db or Wallet.
- **T8 Socket handlers with the join order contract and the reconnect path**  files: server/paperSockets.js, test/paperSockets.test.js  depends on: T3, T7
  acceptance: test/paperSockets.test.js passes: bad stake, not-open, duplicate, maintenance and full are all decided with the token-consume spy at zero calls; maintenance and full then consume once through the refund path and pay entry.paid, not the rung; a bad token at 0.10 is refused visibly and never seated; a spent token re-sent after death is refused with no refund; client wallet/worth/micro fields change nothing; respawn uses socket._ppStake and a stale _ppRoom respawn seats in a listed arena; addHuman throwing triggers exactly one refund and leaves no unit; reconnect in time, too late, die-during-grace, two sockets on one seat and a wrong key all behave as design 5.7 with the consume spy at zero; a null or non-object payload to any handler is ignored without a throw.
- **T9 server/index.js wiring (single owner), entryStore paid field, db reason, dev tokens, real-server smoke test**  files: server/index.js, server/entryStore.js, server/db.js, test/entryStore.test.js, test/paperJoinSmoke.test.js, scripts/dev-local.js (committed)  depends on: T3, T7, T8
  acceptance: test/paperJoinSmoke.test.js passes (free join gets pp:joined then pp:s, paid join with no token gets pp:refused with a reason, PAPER_DEV_TOKENS=1 with a dummy escrow key exits non-zero naming the flag, with the flag and no key a POST without signedTx returns a token that seats a paid pp:join); npm test fully green with the 470 existing tests; db.recordStake( still appears exactly once in index.js; /api/live shows 1 Paper row without PAPER_PAID and 3 with PAPER_PAID=1; sumLiveSelfCustodyStakes includes live plus unswept floor money; mint carries paid; claimDuePayout returns reason and drainPayouts records no earnings for refund rows (code review); every room hook incl. onSweep is a function at boot.
- **T10 Pure own-square predictor**  files: public/js/paper/mp/paperPredict.js, test/paperPredict.test.js  depends on: T1, T4
  acceptance: test/paperPredict.test.js passes: bit-exact over 600 ticks against an ArenaGame whose rng is stubbed to 0.5, under RECONCILE_POS_EPS (0.5 u) against the unstubbed game, both with a 200-tick straight run and a wall slide; FIFO jitter runs give re-bases <= starves + drops and the old every-2nd-tick rules are asserted to fail; replay after dropped inputs converges and uses the stored hold bit; ack miss snaps; lock gives zero displacement and 400 ms without frames keeps it; exact-east and exact-north sweeps of 150 phases finish under 1 s with every run wallInside, and the unguarded control reproduces the stock hang.
- **T11 Client net layer and mirror game (UMD, node-tested)**  files: public/js/paper/mp/paperNet.js, public/js/paper/mp/paperMirror.js, test/paperNet.test.js, test/paperMirror.test.js  depends on: T1, T10
  acceptance: both node tests pass (clock offset EMA, renderTick, jitter buffer growth and decay, event timeline ordering, pp:need after RESYNC_AFTER_MS, reconnect join with the resumeKey; applying the first bundle twice changes nothing, idempotent ['j'] ['k'] ['p-'] ['b'] ['t'], synthesised spawn circle, onScoreChanged on a percent change); both modules load under require; renderGameFrame and paperRender.js are unmodified. Browser checks live in T12.
- **T12 Arena page, shell screens and HUD (money labels, coins, hold ring, Q and touch button, reconnect, analytics)**  files: public/paper-arena.html, public/css/paper-arena.css, public/js/paper/mp/paperArenaMain.js, public/js/paper/mp/paperHud.js  depends on: T11, T9
  acceptance: test/inlineScripts.test.js still passes; posthog-init.js is the first script and both phEvent calls are present; canvas fills the frame at phone and desktop sizes; FREE arena in the browser against duelseries-local: 5 minutes with zero console errors, own square within 2 u at 100 ms simulated latency, minimap and leaderboard with percentages updating within a second of a capture, Kill and +x.xx% labels and the kill counter, the hold ring and all five screens, a reconnect resumes the same square; PAID HUD against duelseries-local with PAPER_DEV_TOKENS=1 and hand-seeded sessionStorage: money label, coin, count-up, cashed-out receipt; the touch hold button does not steer on a phone viewport; game:done returns to the lobby only from an end screen (no live-play leave control); entryToken is removed from sessionStorage after the single pp:join.
- **T13 Lobby wiring for Free, $0.10 and $1.00**  files: public/v2.html, public/js/v2/play.js, public/js/v2/board.js, wallet-widget/src/main.jsx, public/wallet/widget.js, test/v2route.test.js  depends on: T9 AND T12
  acceptance: test/v2route.test.js passes with the rewritten Paper assertions (built:1, ladder:1, not solo, not paid) and new pins (PAGES maps paper in source AND built bundle, OWN_PAGE has no paper); the committed public/wallet/widget.js contains paper-arena; from the lobby Free opens /paper-arena with stake 0 in sessionStorage; ships in the same push as T9 and T12, never before the page exists.
- **T14 Shrink and trim soak test, then switch the trim on** (DONE 2026-09-28, TRIM_ON = true)  files: test/paperSoak.test.js  depends on: T4, T5, T7
  acceptance: test/paperSoak.test.js passes three runs in a row with different Math.random stubs: 16 wandering humans incl. a wall hugger through 950 to 475 and back with the trim on, zero throws, zero deaths on a push piece, zero units outside the wall after any tick, pushCrossings 0, every trail and ring simple, checkRing on every base every 60 ticks, bank conserved; only then is TRIM_ON set true by the T7 owner (PaperRoom.js stays T7's file).

Order: T1, T2, T3 in parallel. T4 and T5 next. T6, T10. T7. T8, T11. T12. Then T9 + T12 + T13 in ONE push (free only) = milestone 1. T14.

## Decided by the owner (2026-09-23, docs/paper-mp/OWNER-ANSWERS.md, binding; design section 13)

1. Money left on the floor of an arena nobody visits: HOUSE REVENUE AFTER 1 HOUR. PICKUP_SWEEP_MS = 3600000; the sweep takes the coin out of the arena total and records it as house income (source paper_floor) on the rake's path, never as earnings; it survives an idle arena through the directory's 60 s timer; until then the coin counts as liability.
2. A paid join refused at the door (maintenance, or all seats taken): AUTO-REFUND, once per buy-in, server-decided. Kept as designed, with the critics' precision that the refund returns the on-chain amount capped at the rung.
3. Disconnect: 5 SECOND GRACE, the square keeps moving on its last steering. DISCONNECT_GRACE_MS = 5000 from the socket close (socket.io reports a silent loss only after 15 s of pings, stated in design 5.7); a reconnect with the seat's resumeKey takes the square back with no new buy-in; the hold is cancelled at the disconnect; a death in the window follows the normal rules; expiry drops the money where the square stood; two sockets on one seat: the newer wins, the older is told.
4. Cash-out hold: ALLOWED ANYWHERE, exactly as designed (3 seconds, movement locked, release cancels).

Still open (defaults chosen by the design, none blocks the build): (5) an arena whose tick throws three times in a row is closed and every live account cashed out at the normal 90/10, alternative 100 percent; (6) when the wall cuts your land into two inside pieces you keep the piece you stand in (or your trail left from) and lose the other, land percent only, no money moves; (7) a square pushed by the shrink across another player's trail kills that player and takes the money, alternative the money drops as a pickup.

## Critic lenses (ran 2026-09-23; kept for the record)

1. money-security: attack as a cheater and an auditor (replayed entry token, double kill credit, kill and cash-out same tick, pickup collected twice, cash-out completing while dead, disconnect during the hold, reconnect, two sockets one wallet, self-kill collusion, worth shown but not backed by escrow, payout failure limbo, server restart with money alive). Every transition server-decided, atomic, idempotent; solvency liability counted; CollusionMonitor fed. Compare with the snake game code.
2. netcode-feasibility: fixed server timestep vs the solo variable-dt loop; snapshot size with hundred-point base polygons; trail and polygon deltas after packet loss with volatile emits; own-square prediction for a turn-rate-limited constant-speed mover, reconciliation without snapping; does the replica let paperRender.js draw unchanged; CPU per arena; trim robustness (self-intersection, slivers, base entirely outside, base split in two, player on trimmed land, trail crossing the new edge) and the fallback.
3. parity-scope: does any seam change solo behaviour, rng draw order or canvas call order (golden parity must stay 600/600); does it follow the owner rules in docs/paper-multiplayer-brief.md to the letter; is the task breakdown conflict-free with measurable acceptance checks; what is missing.

## Build progress (Opus chat, from 2026-09-27)

- T1 wire + constants + parity gate: done (31cbb14). T2 bank: done (855937b). T3 payout: done (db495d6).
- T4 sim: done. Deviations from the design, each forced by a probe in `test/paperArenaGame.test.js`, all in
  `server/paper/ArenaGame.js` (no solo file touched):
  1. The rest of a pushed step runs with the steering target moved by the push offset, so the heading the player asked
     for is kept (a stale target bent the heading back across the push piece).
  2. Besides the push piece itself, a crossing of any trail piece that a PUSH laid never kills (rewind instead): the
     player never drew it. Detected by the piece's end point, recorded when the push is built.
  3. While the wall is moving in, and 250 ms after its last step (`SHRINK_VETO_MS`), the wall rule (reason 2) rewinds
     instead of killing a human: the push walks a presser along the wall and the stock rule kills a square pressed into
     a wall corner even on a static wall (probed: 7 of 20 static corner pressers die). On a static wall every stock rule
     kills exactly as solo. This is the timed veto the design rejected, made safe by the rewind (trails stay simple).
  4. `rewindTrail` cuts in place (kept segments stay the same objects) so later hits of the same move are still
     dispatched; rebuilding them hid real crossings and left a non-simple trail.
  5. Free arena: at most 15 bots, and `botsCount` is refreshed when a human dies mid-tick (else a 16th bot with an
     undefined type spawned in the same tick, caught by the cap test).
  6. `pushCrossings` is counted, not required to be 0: a presser's zigzag makes all three twists cross sometimes (41 in
     the 1500-tick test); each is vetoed with a rewind, never a death, trails stay simple.
  `MP.pushPoint` was added to `paperWire.js` (T1's file) because the predictor (T10) needs the same push target.
- T5 trim: done (e69bac1), switched ON by T14 (2026-09-28).
- T6 wire builder: done. `arenaTrim.applyTrim` now records the pre-trim ring size so the wire can tell a plain trim
  (no ring sent) from a carve. Finding for T11: the design's RADIAL clamp of stored rings is exact along the wall run
  but cuts the corner where a ring meets the wall by up to about 1.2 u (measured); cosmetic (land percent comes from
  the server), but the mirror should CLIP the ring against the wall (crossing points plus the wall run), not clamp.
- T10 predictor: done. Requirement it puts on T7: the room must set `unit.locked` from the APPLIED hold bit in the
  same tick, before movement (the tests wrap `applyInputs` to do exactly that); a lock that lags one tick would make
  every hold a one-step divergence. The "north" exact-vertex sweep cannot be exact (254 angle steps cannot point at
  pi/2), so it runs at byte 64; the east sweep is exact and trips the guard (13 calls max, the stock border hangs).
- T7 room + directory: done. The hold starts and stops in a wrapper around `applyInputs` (before movement, as T10
  needs); captures queue `['cap']` through a wrapper around `handleReturn`; both are instance wraps, T4's file is
  untouched. A failed join closes any account it opened (withdraw) before the caller's refund, so no phantom liability.
  Test lesson: never `assert.strictEqual` two rooms or seats (a failing diff of the whole sim graph runs node out of
  memory); compare with `assert.ok(a === b)`.
- T8 sockets: done (a6b3e7b). Each arena's io room name is now unique per process (a re-created arena must not reach
  sockets left in the old one). STOPPED HERE 2026-09-27 at a clean point (5-hour usage window at 95 percent). Next: T11.
- T11 client net + mirror: done (built, adversarially reviewed and fixed by a workflow). Deviations: rings are CLIPPED
  against the wall (agrees with the server's planTrim to 1e-6 u); the mirror wall follows the newest frame radius; an
  unknown id's ['b'] adopts the unit; client timing numbers live in paperNet.js/paperMirror.js; ['cap'] idempotent
  per (unit, tick, gain). Review fixes: no pp:in between a resume pp:join and its pp:joined; a local ['p-'] pulls its
  ['p+'] forward; the mirror works around the predictor's miss branch clearing the whole ring (paperPredict.js still
  does that, as design 8.2 says; worth revisiting). Known: about one own-square re-base per wall quantum while pressed
  against a SHRINKING wall (hidden by the visual offset), and one at a first join.
- Cross-cutting fix with T11: every pp:joined / pp:ev / pp:geo packs its ring and trail blobs into ONE binary
  attachment (MP.packBin / unpackBin): socket.io-parser 4.2.6 refuses more than 10 attachments (the node client does
  today; the browser bundle 4.8.3 does not yet). PaperRoom now announces bots spawned mid-game with ['j'].
- T9 server wiring: built, reviewed (money/security) and fixed; COMMITTED LOCALLY, NOT PUSHED until T12 + T13 join it.
  Dev entry tokens are scoped to Paper (a dev token cannot open a Knockout or snake table) and the dev mode refuses to
  boot with NODE_ENV=production, a non-empty ESCROW_PRIVATE_KEY or a non-empty DATABASE_URL. Pre-existing, flagged not
  fixed: drainPayouts records earnings for recovered rake-sweep rows; Knockout/Battleship refunds pay the rung.
- MILESTONE 1 (T9 + T12 + T13, free only, PAPER_PAID off everywhere) pushed together. End-to-end browser check against
  duelseries-local passed: lobby shows Free (and $0.10/$1.00 with PAPER_PAID=1 locally), Free launches /paper-arena,
  2+ minutes of play with zero app console errors, a paid dev-token join shows $0.10, holding Q pays 90000 of 100000,
  the entryToken leaves sessionStorage after the one pp:join, reconnect resumes the same square, solo /paper still
  plays. Fixed on the way: the last seat dying mid-tick now still sends its own ['k'] and coin before the arena idles.
- BEFORE PAPER_PAID IS SWITCHED ON (owner's Fable money review), open items found during the build:
  1. DONE (night queue item 5, 2026-09-28). Region: the widget staked every buy-in on regionBase() (localStorage
     duelseries_region, can be EU) while the arena page connects to its own origin, so an EU token was refused on NA.
     Decision: Paper stakes on the page's own origin, the same server that serves its lobby rows and its free table
     (the brief keeps EU specifics out of scope). `wallet-widget/src/stakeRoute.mjs` picks the server per game:
     Paper, Knockout and Battleship (all three pages call io() with no URL, and Knockout and Battleship had the same
     split) stake on this origin; snake and agar follow the region, read once, and the launch writes the region the
     stake used. A Play again stakes on the region its page was launched with (sessionStorage), not the lobby's
     current pick. Tests: test/stakeRoute.test.js, v2route "staked on this origin" (the real widget launch code).
  2. DONE (night queue item 5, 2026-09-28). The orphaned paid seat. A paid seat is now UNCONFIRMED until its first
     input (the page steers only after pp:joined; a resumeKey resume also confirms). Unconfirmed at its socket's
     close: refunded at once (paperPayout.refund, bounded by what landed), square removed with reason 10, no coin;
     any money it won meanwhile stays on the floor as a coin. Unconfirmed `MP.JOIN_CONFIRM_MS` (3000) after the join:
     the same refund, and the socket gets pp:refused { why: 'join-timeout', refunded: true } (bounds how long a
     square nobody steers can fly after a silent link loss). The page keeps the entry token in memory until pp:joined
     or pp:refused answers and re-sends it once per new link when its join went out before a drop: the token's
     sha256 names the unconfirmed seat, which the new socket takes back (nothing consumed or deposited twice), or the
     outcome it already had is told again (refunded, full, expired; kept 10 minutes, at most 5000). A confirmed seat
     is never named by its token and follows the owner's grace rule unchanged; free seats are untouched. The design's
     "a token is never sent twice" is relaxed to this one case, which cannot spend anything twice. Checked in a real
     browser on duelseries-local: a page in a hidden pane (no animation frames, so no input) was refunded by
     join-timeout; the same page driving frames confirmed its seat. Tests: test/paperJoinLost.test.js (server),
     paperJoinSmoke "closes before pp:joined" (real server), paperArenaPage "lost before pp:joined" (page),
     paperBank withdrawUpTo.
  3. DONE (night queue item 5, 2026-09-28). The restake bridge (`wallet-widget/src/restakeBridge.mjs`) answers only
     the document that asked: same origin, the game frame's own window, no document load since the request, frame on
     screen; answers go to this origin only (was '*') with the page's nonce, and the arena page takes only its own
     nonce. Page gone before the money moves (game:done, or a new document): stakeOnly stops before the wallet prompt
     or before the submit, so the signed transfer is never sent. Gone after the submit: the paid round opens in the
     free frame through the normal launch instead of being posted into a blank one (a frame busy with another game is
     logged, not overwritten). Tests: test/restakeBridge.test.js, paperArenaPage "Back to the lobby is shut".
  4. DONE (night queue item 3, 2026-09-28; measurements in scratchpad/night/paper-lag.md, gitignored). The lag had
     three real causes on every platform, the Windows timer only a fourth for local testing. (1) The server sent the
     reliable pp:ev before the volatile pp:s in the same turn, so socket.io threw away the frame on every snapshot with
     an event: 13 of 30 frames a second arrived (live too), remotes were drawn about 200 ms late. Frame first now:
     30.05 frames/s, 0 dropped, jitter buffer 7 ms median (was 127), remotes about 77 ms late, 0% extrapolating.
     (2) The client lost its own pp:in whenever the ping or a second input went out in the same frame (half of all
     inputs at 30 fps): a frame's inputs are now one emit and anything the transport cannot take waits for its drain,
     0 discarded at 30, 60 and 120 fps; the mirror also counts ticks at STEP_MS now (it sent 59.98 inputs a second).
     (3) The 3-deep FIFO starved and overflowed on internet jitter: it is now an 8-deep jitter buffer with a slow trim;
     at 15+U(0,20) ms one way re-bases went from 2.5/s to 0 in steady play, at 30+U(0,40) from 4.25/s to 0.
     (4) The room clock is a setTimeout to the next step on a monotonic clock, capped catch-up (no 33 ms gap in the
     Linux model, no double steps on Windows). Remaining: the join transient (the first compare after a spawn re-bases
     by about one RTT of travel, then 1 to 4 one-tick starves while the FIFO builds its cushion on a jittery link).
  5. Pre-existing. FIXED (night queue item 5, money safety): Knockout and Battleship refunds paid the rung, a mint of
     up to 1 percent of the rung per refund (the verifier accepts 99 percent); queue and draw refunds are now bounded
     by the token's paid (`stakeRules.refundBound`), and a paid Knockout or Battleship seat is paid to the token's
     verified wallet, never a client-sent one (test/duelRefundBound.test.js). OPEN, stats only (no money moves):
     drainPayouts records earnings for recovered rake-sweep rows (and for recovered Knockout/Battleship refund rows,
     whose reason does not begin with 'refund'); the stock leaderboard cache throws if first drawn at 0 size (arena
     page guards it, solo cannot be edited).
  6. Found while fixing 1 to 3, left for the money-path review: a paid entry token that is never spent (tab closed
     between the stake and the join, or 5 minutes pass) expires with no refund, for every game; /api/submit-stake
     claims the signature before it refuses a stake paid by a different wallet than the request names (that money
     stays in escrow with no token); an emergency close cashes out an unconfirmed Paper seat at 90/10 like the rest.
     DONE (night queue item 5, adversarial review fixes), with the other confirmed review findings:
     - Stakes are exact rungs everywhere (stakeRules.rungOf): 0.10499 or 0.004 no longer opens or relabels an arena,
       is quoted or minted; arenas are built only from RUNGS. tierFor floors in micro-dollars; the USDC verifier is
       exact (no 99 percent floor), so a short transfer never buys the rung.
     - An unspent paid token is refunded when it expires (entryStore onExpire, server/entryExpiry.js: what landed, to
       the verified payer, once; a failed send is an owed 'refund' row; dev tokens never reach the real escrow). A real
       token at a shut paid table is refunded at the door. Unspent tokens count as liability and in drainStatus.
     - Still open: a RESTART between a stake and its join loses the token (memory only). maintenance:check now says
       "not safe" while any token is pending or a Paper floor coin exists; wait for it before a push.
     - submit-stake mints to the verified payer and logs a mismatched walletAddress instead of stranding the stake.
     - Emergency close refunds an unconfirmed seat in full (bounded by what landed), cashes out only what it won.
     - A reconnect after a finished cash-out gets pp:cashedout again; after being cut, 'killed'; never a false
       "your money dropped" (PaperArenas outcomes by resumeKey).
     - Escrow never pays a player's USDC account rent (Usdc.js RECIPIENT_NO_USDC_ACCOUNT, owed until the account
       exists again); only the revenue wallet and the Battle Royale prize may open one. Escrow SOL low alarm (0.01).
     - A wallet with RELEASE_MAX (2) unconfirmed-seat refunds in 10 minutes is paused, refunded in full at the door.
     - The Paper buy-in row is written when the seat is first steered, not when the token is spent.
     Tests: test/paperReviewFixes, entryExpiry, usdcAccountRent, submitStakeReview (real server), stakeRules.
- T14 soak: done, TRIM_ON = true in PaperRoom.js (committed, not pushed by the T14 step). `test/paperSoak.test.js`:
  three seeds (Math.random stubbed per run, restored), a paid room, 16 wanderers incl. two wall huggers, scripted exits
  (hold, grace, leave) drive the wall 950 to 475 and joins bring it back, trim injected ON; every tick asserts no
  throw, no death on or across a push piece, every square inside the wall, pushCrossings matched to pushed squares
  that lived, every trail and changed ring simple, the bank and liability conserved; checkRing on every base every 60
  ticks. About 10 s per seed (about 32 s for the file, full npm test about 40 s). PAPER_SOAK_RUNS=n runs n seeds (the
  13 listed ones first), PAPER_SOAK_SEEDS=a,b,c exactly those; 40 listed/derived seeds and 60 fresh ones passed.
  It found six real bugs, each fixed without loosening an invariant:
  1. ArenaGame: a square pressed into a wall corner while the wall moves makes an OVERLAY self-hit; the veto rewound,
     then the rest of the move laid the fold again (non-simple trail). An overlay veto (not on the push piece) now
     stops the square at the cut for the rest of that tick (`_haltMove`).
  2. ArenaGame: a square pressed square-on into the wall slides a hair one way, then back, so a piece can run straight
     back along the trail piece before it, ending under 1e-6 u off it on the far side; the next push piece then crosses
     it at a point the geometry snaps to the tip, so nothing sees it. Inside the wall-rule veto window (wall moving, or
     under SHRINK_VETO_MS since its last step) and within 5 u of the wall, a piece that folds back within 1e-5 u of the
     previous piece's line is now cut and the square rests that tick (`_cutFold`, `stats.foldCuts`; never the push
     piece). That is the same rest the vetoed stock kill for running back along the trail gives; on a static wall the
     stock rules stay exactly as solo. The client predictor does not model the cut; a rare cut is a tiny re-base.
  3. ArenaGame: a trail that comes home along the base's own edge (sliding along a wall run) makes a zero-area loop,
     and the stock sign test on it is noise: a 1759-edge base became a 7-edge sliver. A return whose loop is under
     1e-6 u2 (flat loops measured about 1e-12, the smallest real capture 0.005) now captures nothing
     (`flatReturn`, `stats.flatReturns`).
  4. arenaTrim.planTrim: ring vertices ON the wall edge (trail points from a wall slide, captured) counted as inside, so
     the wall walk could run back over them and the kept ring touched itself. They now count as outside (the usual
     Weiler-Atherton perturbation) and the crossing at the end of such a run IS that vertex (`onWall`).
  5. arenaTrim.planTrim: a new edge of the kept ring (the wall run) could cross a trail laid against the old ring, so
     the owner's next capture merged across it (a spiked ring hundreds of ticks later). Such a plan is now `blocked`
     until the trail is gone (`crossesTrail`).
  6. ArenaGame: a trail that leaves home along the ring's own edge (a slide out of a wall corner along a wall run)
     is merged by the next capture as a zero-width spike (three ring vertices collinear within 1e-13, running out and
     straight back). After each capture, spike tips used only by that ring (and the returning trail) are dropped; no
     area changes (`_despike`, `stats.despiked`).
  Also `checkRing` finds non-adjacent crossings with a sweep over x instead of all pairs (same answer on 4000 random
  rings; the all-pairs loop cost seconds per 2000-vertex ring).
- NEXT: the night queue (Paper lag, lobby items, paid tables through their own safeguards).
- Pre-existing flaky tests (fail without any Paper change): `localBody.test.js` "the neck keeps its spacing" about 1 run
  in 3, and `cashoutHold.test.js` under CPU contention. Not touched.
