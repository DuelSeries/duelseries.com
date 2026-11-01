# Full test run, 2026-11-01

Branch `claude/full-test-run-fixes`, from `main` at ae4ccc8. Cloud container: 4 CPUs, 16 GB RAM, Linux.
Everything below ran on **Node 24.13.1** (Owen's version, fetched from the npm registry as `node-linux-x64@24.13.1`),
because the container's default Node 22.23.4 fails goldens for reasons that have nothing to do with the code (see
"Node versions"). Nothing here touched the live site, the database, Solana or Privy (the container has no `.env`).

## What was run

| Entry point | What it is | Result |
|---|---|---|
| `npm ci` | clean install of the lock | failed on npm 10 (Node 22's npm), fixed (commit 9e43adb) |
| `npm test` | every `test/*.test.js` (363 files) | see Totals |
| Soak and fuzz files in the suite | slSoak, agSoak, paperSoak, slFuzz, slMoneyFuzz, agMoneyFuzz, slMirror, slLoad, slViewHeap, rungFiftyMoney, hostileInput | all pass in every run |
| Soak and fuzz, extended (scratch copies, not committed) | slMoneyFuzz 12 new seeds x 20,000 steps; agMoneyFuzz 30 new seeds x 2 (with and without step throws; the first run of it under `--test --test-force-exit` reported only 38 of its 60 tests, the rerun 60 of 60); slFuzz 10 new seeds; agSoak 3 new room seeds; `PAPER_SOAK_RUNS=15`; `SL_SOAK_TICKS=100000`; `SL_MIRROR_SEEDS=4,5,6,7,8` | all pass, except slMirror seed 5 (a scenario precondition, below) |
| `node scripts/slSoak.js --minutes 30` | the long slither.io soak on the real boot path | see Soak |
| `npm run owner-smoke`, `br-smoke`, `br-start-smoke`, `br-sl-smoke`, `zone-sim` | smoke scripts that boot the real server | 2 failed, 1 hung, 2 passed before; 5 of 5 pass now |
| `npm run loadtest`, `scripts/capacity/*` | need a running remote server | not run (they would load a real box) |

The brief said about 270 test files; there are 363 `*.test.js` files plus 15 helpers in `test/` (and the new
`test/powPin.js`).

## Totals

The old `npm test` (`node --test --test-force-exit`) drops test results (see the first finding), so its counts are
not the real ones. Both rows below are the same per-file runner on Node 24.13.1, which reports every test.

| | Files | Pass | Fail | Tests | Pass | Fail |
|---|---|---|---|---|---|---|
| Before: `main` ae4ccc8 (run at 14:22 Eastern) | 363 | 355 | 8 | 4402 | 4393 | 9 |
| After: this branch, two final runs (21:14 and 21:21 UTC), identical | 363 | 363 | 0 | 4403 | 4403 | 0 |

For reference, the old runner on `main` (run 1 of 5, 16:50 UTC): 378 files loaded (helpers included), 373 passed,
5 failed; it reported 4247 tests (155 fewer than exist), 4242 pass, 5 fail.

The 8 files failing on `main` with full reporting: the 5 slither.io golden files (host `Math.pow`), slSmoke (it was a
battle royale slot hour), swimEvent (two lobby tests) and agPaidJoinSmoke (a socket race). All fixed below.

The run before those two (with every fix but the second agPaidJoinSmoke one and the soak harness) was clean too: 3 clean full
runs in a row. The one extra test is the new Swim lobby test.

Smoke scripts before: owner-smoke FAIL (3 of 24), zone-sim FAIL (NaN), br-start-smoke HANG, br-smoke and
br-sl-smoke pass. After, on the final code: all 5 pass and exit, no server left running.

## Fixes (one commit each)

| Commit | Kind | Fix, and why |
|---|---|---|
| 488e1e4 | test (goldens) | slSimGolden, slViewGolden, slParityGate synth-60hz, slMirror and slxNoTouch failed on Linux: Node 24 sends `Math.pow` to the host C library, and glibc and Windows round two of the golden runs' pows to different doubles (found by checking every recorded pow input against the exact value). `test/powPin.js` pins exactly those two inputs to the values the goldens were cut with on Windows; goldens and game code untouched. |
| 9e43adb | install | `npm ci` refused on npm 10 (two optional `utf-8-validate` peers missing from the lock); npm 11 still accepts the new lock and the deploy's `npm install --production` plans the same packages. |
| 9008b0f | smoke | `br-start-smoke` printed "all good" and never exited: the server keeps running after SIGTERM by design, so the script now SIGKILLs it and exits. |
| 0b7565a | smoke, stale expectation | `owner-smoke` expected 3 bots to start an old-engine battle royale; 28d75e3 (2026-09-07) made bots not count for the start, on purpose. |
| aad94d2 | tool | `zone-sim` read the clock-zone constants that 09a4d74 replaced with rings on 2026-09-07 and printed NaN; rewritten for the ring zone (same checks, negative controls verified). |
| 7fe685d | test, flaky | paperCull looked up each client's server socket by id before the client had its id. |
| f46b361 | test, flaky | cashoutHold: a free-room bot sometimes killed the test's snake before the honest hold; a run where the snake died is redone, so every assertion is on a living snake. |
| 08b8a03 | **MONEY:** (game code, Swim) | Swim Race lobby: the last bot's random wait could run past the quiet window, so about 1 lobby in 8 (12.2% simulated) showed 7 cars until the start, which also made two swimEvent tests flaky. Capped the wait at 0.9 of the time left; failing test first. Flagged MONEY only because the brief lists Swim: the Swim Race event is free and this moves no money. |
| 3e02310 | game code (slither.io room) | slSafe flaky: a wake with no sim step due reset the run of throwing wakes, so a broken free room took 4 to 6 throwing wakes to close instead of 3. Only a wake that stepped the sim resets it now. Paid rooms unchanged (they close on the first). |
| 3e681ac | test, flaky | ownerConsoleServer read /api/live 11 times in a second and got its documented 1 s cached copy; reads after a door switch now wait out that window. |
| dbeb9f4 | test runner | `npm test` now runs `scripts/runTests.js` (see the first finding); the old command stays as `npm run test:node-runner`. |
| 2433422 | test, time of day | slSmoke failed whenever run 2 to 3 or 8 to 9, AM or PM Eastern: a server booted in a battle royale slot hour starts that slot's match, and the restart check then says no. The test stops the slot's match as the owner would. |
| 9d3a6da, a74590e | test, flaky | agPaidJoinSmoke: two races. The "DEV withdraw" log line comes down the stdout pipe while ag:paid comes down the socket; and ag:paid is emitted in the same tick as ag:cashedout, so a listener added after awaiting ag:cashedout missed it whenever both arrived in one read (a standalone check of that pattern missed 40 of 40). |
| a0772a7 | soak harness | The 30 minute soak's seat mirror predates 9923a11 (early own points, 2026-10-16) and reported 23,103 false mirror failures; it now checks an early own point once the step that places it has run. |

No money-path code was changed. The only commit in game code that the brief's money list covers is the MONEY: one
(Swim lobby timing, no money). Tests in money areas that were changed are test-only (cashoutHold, agPaidJoinSmoke).

## Flaky tests (Node 24, 3 files at once unless noted)

"Full passes" are the 5 runs of the old per-file runner on `main`'s code (fixes landed during passes 4 and 5, noted).
"Targeted" are repeated runs of the one file, before its fix.

| File | Full passes | Targeted, before fix | After fix |
|---|---|---|---|
| paperCull.test.js | failed 2 of 4 unfixed passes (2, 3) | 3 of 20 (4 at once) | 0 of 40 |
| cashoutHold.test.js | 1 of 3 unfixed passes (3) | 1 of 24 (4 at once), a bot killed the snake | redone run, assertions unchanged |
| swimEvent.test.js | 1 of 5 (pass 2); also the full run of `main` with the new runner (tests 10 and 11) | simulated: 12.2% (test 10), 5.0% (test 11) | 15 of 15 in 10 runs; simulated 0% |
| slSafe.test.js | 1 of 5 (pass 5) | 7 of 60 (6 at once) | 0 of 60 |
| ownerConsoleServer.test.js | 1 of 5 (pass 5) | 1 of 12 (4 at once) | 0 of 12 |
| agPaidJoinSmoke.test.js | 0 of 5 old-runner passes; 2 of 3 new-runner full runs before the second fix (two different races) | 0 of 8 alone | 8 of 8; full run passes |
| slSmoke.test.js | 0 of 5 (all before 2 PM Eastern) | fails every run inside a slot hour (4 h of 24) | passes inside and outside a slot hour |

Seen only at 12 files at once (not flaky at the normal 3; passed all 5 full passes; not changed): paperPredict
("exact-vertex sweeps ... under 1 s" took 1676 ms) and ownerPage (one check, "Don't restart yet").

## Findings worth knowing

1. **`node --test --test-force-exit` drops test results** (Node 22.23.4, 24.13.1, 24.22.2 and 26.13.0 alike). Each
   file's child reports through the v8-serializer reporter, and the force exit calls `process.exit()` while report
   events are still queued, so the tail of the file's report never reaches the parent. Every test does run, and a
   failure in the lost tail still fails the run, but only as "<file> test failed" with no test name or message, and the
   counts are wrong: in 5 full passes 27 files reported a different number of tests each time (duelWatchPage 25, 13,
   47, 30, 66). Minimal repro: 60 synchronous 250 ms tests report 30 to 55 under `--test --test-force-exit`, 60 of 60
   without the flag or when the file is run directly. `npm test` now runs each file as
   `node --test-force-exit <file>` with `NODE_TEST_CONTEXT=child` (node:test's own TAP child mode), which reports
   every test (per-file counts equal a run without force exit for all 337 files that can run without it).
2. **The goldens are host-specific.** Node 24 uses the host libm for `Math.pow`, so the same code computes a few pows
   differently on Windows and Linux (one ulp). The live server runs Linux; Owen's PC is Windows. The pin makes the
   goldens replay on both; a golden that fails on one OS only should be checked the same way before re-cutting.
3. **Battle royale slot hours change what a fresh server does** (a match starts at boot inside 2, 8, 14 and 20
   Eastern). slSmoke was the only test caught by it; keep it in mind for any new test that boots a server.
4. Observation, not changed: below RING_ENDGAME_RADIUS a battle royale ring's warning runs a little past
   RING_WARN_MAX_MS (11.1 s against 11 s), because `_nextRing`'s "smallness" is not clamped at 1 under radius 165.
5. Extended slMirror seed 5 failed "the leave glided and died in the stall, before the resync": the scripted leaver
   died before the stall, so that scenario precondition did not hold for seed 5. Every parity check before it passed
   (no client and server mismatch); seeds 4, 6, 7 and 8 pass whole.

## Memory and hangs

- **Peak memory per test file** (whole process tree, sampled every 0.5 s, 5 full passes): highest agarSwap 649 MB,
  hostileInput 622 MB, slMirror 584 MB, slMoneyFuzz 567 MB, slSplitServer 533 MB, rungFiftyMoney 526 MB; 758 MB at
  most when 12 files ran at once. A spot check during run 1 showed 15 GB of the 16 available. Nothing close to the
  27 GB figure in the brief: on Linux the largest single process peaked at about 2.0 GB of virtual memory (hostileInput 1,988 MB; the ten heaviest files all 1.5 to 2.0 GB), so the 27 GB was not reproduced. Virtual size is address space V8 reserves, not memory in use; Windows may count it differently.
- **No test file hung in any run with the runner's force exit**; slowest: rungFiftyMoney 129 s, slMoneyFuzz 113 s,
  agSoak 79 s, slxNoTouch 65 s, slMirror 65 s.
- **Files that never exit on their own** (all their tests pass, then a server or timer keeps the process alive; they
  rely on the force exit, which the new runner keeps, and the runner kills each file's process group afterwards):
  abuseLimitsServer, agServer, agarSwap, bodyParserGzip, comingSoonServer, connectWalletLedger, duelQueue, duelSkinWear, duelWatchServer, durableStakeServer, hostileInput, linkedWallet, ownerAlertSkipServer, rpcBudgetServer, rpcBudgetShareServer, rpcDayServer, rpcRelay, rungFiftyMoney, slClosed, slSmoke, spectateSeat, stakePendingVerifyServer, submitStakeReview (23 files, checked twice; `node --test file` on any of them without `--test-force-exit` waits forever). Most boot `server/index.js` or `scripts/dev-local.js` inside the test process, which has no stop. Not changed; worth a teardown helper one day.
- `br-start-smoke` hung (fixed, above).
- **Soak:** two 30 minute runs of `node scripts/slSoak.js` on this 4-CPU box.
  - Run 1, the real bot governor (default): every server bar passed (42,175 steps checked, 0 invariant failures, 0
    kicks, 0 dropped connections, 0 failed wakes, every one of 211 resume blips back). It failed the mirror bar with
    23,103 failures (a stale harness, fixed in a0772a7), 11 client "doubleFood" records and 2 more in the mirror, 1
    stream failure in 211 resumed lives, the heap bar, and the bots bar: this box could not hold the curve peak, the
    governor cut the bots from 51 to 0, and standing food rose from about 3,000 to 7,800. The doubleFood and resumed-life
    records all came after minute 19, with no bots and the food climbing; they did not recur in run 2 or in two 3 minute
    runs. Not reproduced, so not chased further; the samples were not kept (run 1 had no `--out`).
  - Run 2, `--governor shadow` (the script's mode for a box that cannot hold the peak; bots stay at about 72) and the
    fixed mirror: every bar passed (42,180 steps, 0 invariant, 0 mirror, 0 client stream failures, 0 failures in 227
    resumed lives, 0 kicks, 0 drops, 0 failed wakes) except the heap bar, by a hair: heapUsed after two forced full GCs
    26.1 MB at minute 5, 28.7 MB at minute 30 (+10.05%, bar 10%), while the standing food rose from about 2,700 to
    3,900. Run 1 grew 24.7 to 28.6 MB (+15.8%) with food 2.6 times. **Possible slow growth, not proven a leak:** two
    GC'd samples cannot separate a bigger food store from a leak. Next step if wanted: a longer soak that takes a GC'd
    heap sample every 5 minutes next to the food and seat counts.
  - The npm-level soaks (slSoak 20,000 and 100,000 ticks, agSoak 3 extra seeds, paperSoak 15 seeds, slViewHeap) all
    pass.

## Node versions

On the container's default Node 22.23.4, on top of the golden failures above, agFreeGolden and every slither.io client
golden fail (V8's own `Math.pow` before Node 24), and agShutdown and agReviewFixes cancel tests ("Promise resolution
is still pending but the event loop has already resolved", a test-runner difference). Run the suite on Node 24.
In a cloud session: `npm pack node-linux-x64@24.13.1`, unpack it, and put its `package/bin` first on PATH.
