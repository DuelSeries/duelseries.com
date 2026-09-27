# Critic: parity, owner rules, scope (adversarial review of docs/paper-multiplayer-design.md)

Date: 2026-09-23. Lens: golden-parity guardian + owner's reviewer + buildability. Every claim below was checked
against the real code (paths relative to `slither-clone/`), not against the reader notes.

## Verdict

The design can be built and the parity story is sound in its core: no seam touches a solo file, every override is a
subclass method or an instance wrap in a new file, the `get player()` getter is only observed inside `BotUnit.update`
(all three reads verified: `paperBots.js:44,335`, `paperUnits.js:480`), `spawnDeathParticles` is a no-op when
`game.visible` is false (`paperUnits.js:134`), and the five defects listed in section 0 are real and correctly fixed
(verified `paperGame.js:93,345`, `play.js:258-281`, `BOT_TYPE_ROWS` 15 entries at `paperGame.js:44-49`, and
`Polygon.left` commits before it removes at `paperGeom.js:713-721`). Three things must change before implementation
starts. (1) The emergency close is an automatic payout path that pays 100 percent with no house cut: it violates owner
rules 3 and 5 and this codebase's own "no automatic cash-out on the way down" rule (`server/ops.js:19-23`), and it turns
every reproducible server exception into a rake-free exit for whoever finds it; it must freeze, not pay. (2) The
shrink-death veto is far too broad: any reason-2 death within 500 ms of a push is suppressed, which lets a player
survive a deliberate self-cross near the wall and leaves a self-intersecting trail whose next return can flip
`handleReturn`'s far-side branch and hand out (or destroy) land; the veto must be scoped to the push piece and the push
must never cross the unit's own trail. (3) The client predictor runs the stock wall loop on an unguarded
`P.ArenaBorder`, so the probed wall-vertex hang (exact east, y = 1000.0, which wire quantisation produces) freezes the
browser tab. Beyond those, the parity gate command is wrong (a working-tree diff with a pathspec whose `*` matches `/`
under PowerShell), the free arena's bot difficulty silently changes from solo (level 0.5 instead of 0.1..1, a different
type row), and the task order deploys a lobby pointing at a page that does not exist yet while removing the working solo
launch. Everything else is a gap to fill rather than a redesign.

---

## Blockers

### B1. Emergency close is a new, automatic, rake-free way for money to leave the arena

- Severity: blocker. Sections: 5.9 (design line 412), 5.5 (`forced: true`, line 335), 2 (`EMERGENCY_FAIL_TICKS`, line 123).
- Claim. Owner rule 5: "Money never leaves the arena except by cash-out." Rule 3: "The existing house cut applies."
  The design adds `emergencyClose()`: after three thrown ticks in a row (50 ms) every live paid human gets
  `bank.withdraw` then `onCashout({ forced: true })`, which pays 100 percent with no rake, and every floor coin is refunded
  to `srcWallet`. This is exactly the path the codebase forbids: `server/ops.js:19-23` ("Deliberately NOT here:
  automatically cashing everyone out on the way down. That is a new payout path, and a payout path built in a hurry ...
  is exactly the sort of thing that pays twice."). Failing scenario: sixteen players at $1.00; one player finds any
  input that makes the tick throw deterministically (a corrupted ring from a blocked trim that later carves, a
  `NaN` position, anything caught by the per-step try/catch). Three ticks later the arena is gone, every player is paid
  $1.00 instead of the $0.90 a cash-out would give, the house loses $1.60 of rake it was owed, and the crasher can do it
  again in the next arena. Even without a cheater, a plain bug pays 16 people and stops the game with no owner in the loop.
- Evidence. Design 412 (`emergencyClose ... forced: true ... 100 percent`), 335 (`cut = order.forced ? 0 : ...`).
  Code: `server/ops.js:19-23` (the house rule), `server/index.js:2214-2264` (`doCashout`, the only sanctioned payout
  shape, always 90/10), `server/ops.js:57-66` (`drainStatus` refuses to drain while paid players are live, the console
  waits instead).
- Fix. Replace the payout in `emergencyClose` with a FREEZE: stop the interval, set `room.frozen = true`, refuse joins
  with `pp:refused { why: 'paused' }`, emit `pp:paused` to the arena, keep the bank untouched (it stays counted by
  `liveStakeTotal`), and raise the existing owner alert. Money leaves only through the existing paths: the players' own
  cash-out cannot run while frozen, so add ONE owner-console action (`paper:close <arena>`, owner-only like the other
  console commands at `server/index.js:957`) that pays each live account through the normal `payCashout` (90/10, same
  `cashoutId` de-duplication) and refunds coins to `srcWallet`. Remove `forced` from `paperPayout` entirely. Section 11:
  `paperPayout.test.js` loses "forced pays 100 percent"; `paperRoomMoney.test.js` gains "three thrown ticks freeze the
  arena, call `onCashout` zero times and leave `bank.totalMicro()` unchanged". T3 and T7 acceptance lines change accordingly.

---

## Major

### M1. The shrink-death veto suppresses legitimate deaths and corrupts trail geometry

- Severity: major. Sections: 4.4 (line 207), 9.3 (lines 633-637), 11 `paperSoak` (line 750, "zero reason 2 deaths inside a grace window").
- Claim. `kill` returns early for ANY reason-2 death while `victim.pushGraceUntil > nowMs` (500 ms after every push
  quantum, refreshed every 125 ms while the wall moves, so effectively the whole shrink). Reason 2 is not "killed by the
  wall": it is the stock self-cross rule whenever the crossing lies within 5 u of the wall
  (`paperTerritory.js:229-233`). Two failures. (a) Rule bend: a player near a shrinking wall who deliberately drives
  through their own trail survives, which changes the kill rules the brief says must stay identical. (b) Geometry: the
  vetoed `handleIntersect` has already done `this.unit.position = hit.point` (`paperTerritory.js:228`) and returns
  without killing; `handleUnitMovements` then continues with `unit.position = reached; unit.track.add(reached)`
  (`paperGameMoves.js:340-343`), so the trail now crosses itself. On the next return, `handleReturn` builds `loop` from
  the ring arc plus that trail and chooses by `loop.rawSquare() < 0` (`paperGameMoves.js:183-190`); a self-intersecting
  loop has an arbitrary sign, so the far-side branch (`ring.unsplice`) can fire and the base becomes the complement of
  what it should be. Land is minted or destroyed by the shrink, and the leaderboard and percent follow. The soak test
  as written asserts the broad veto rather than catching this.
- Evidence. Design 207, 633-637, 750. Code: `paperTerritory.js:222-236`, `paperGameMoves.js:322-346`, `:160-190`.
- Fix (fits 9.3). Scope the veto to the push piece only and never let the push cross the unit's own trail:
  in the `getMovement` override, before prepending the push, test the push segment against `unit.track.polyline`
  (`Polyline.intersections`, excluding a hit at the tip vertex `polyline.end`); if it hits, shorten the push to
  `hit.point` minus `PUSH_TRAIL_CLEARANCE` along the push direction, and if that leaves under `PUSH_TRAIL_CLEARANCE`
  of travel skip the push this tick (the unit stays outside the wall, which is not itself fatal, and can steer away).
  Mark `unit._pushPiece = piece` and in the `kill` override veto reason 2 ONLY when the current move being dispatched is
  `unit._pushPiece` (set `unit._inPush = true` around that piece by wrapping `dispatchBucket` in `ArenaGame`, a
  subclass override, no solo edit); a reason-2 hit on any later stock piece kills exactly as solo does. Section 2 gains
  `PUSH_TRAIL_CLEARANCE = 0.05 u` (a thirtieth of a tick's travel, well above the 2^-26 geometry tolerance). Section 11,
  `paperArenaGame.test.js`: "a deliberate self-cross within 5 u of the wall during a shrink kills with reason 2"; "a
  wall-hugger whose trail lies inward of it survives 1500 shrink ticks with a trail that has no self-intersection
  (`Polyline.intersections` of every segment against the rest is empty)". `paperSoak` replaces "zero reason 2 deaths
  inside a grace window" with "zero deaths whose dispatched move was a push piece".

### M2. The client predictor can hang the browser on the probed wall-vertex case

- Severity: major. Sections: 8.1 (line 527, `P.ArenaBorder.circular`), 8.2 (line 554), 4.3 (189-190), 2 (`BORDER_GUARD_CALLS`, line 105).
- Claim. The server guards the stock `while (wallHits.length)` loop (`paperGameMoves.js:70-99`) with
  `SafeArenaBorder.intersections` returning `[]` after 12 calls, because the loop spins for ever when a step reaches a
  wall vertex exactly (solo-seams note pitfall 2: heading exactly east from y = 1000.0 froze node at tick 633). The
  client predictor runs the SAME stock `getMovement` (`P.Game.prototype.getMovement.call({ config, border }, ...)`)
  against a plain `P.ArenaBorder.circular` with no guard. `SafeArenaBorder` lives in `server/paper/ArenaGame.js`, which
  the browser cannot load. Failing scenario: the player heads due east (angle byte 0 is a real quantised input) near the
  centre line; the server's y is 1000.004; a reconcile sets the predictor state to the wire value
  `round(y * 32) / 32 = 1000.0` exactly; at heading 0 `sin(0) = 0` keeps y at 1000.0 for every predicted tick; every
  later ack differs by 0.004 u, under `RECONCILE_POS_EPS`, so the predictor is left alone; it reaches wall vertex 0 at
  (1950, 1000) and the tab freezes. The T10 test (random angles) never draws this case.
- Evidence. Design 527, 554; `docs/paper-mp/understand-solo-seams.md:380-388`; `paperGameMoves.js:70-99`;
  `paperGeom.js:883-897` (vertex 0 at angle 0). The netcode-first source design put a `SafeArenaBorder` on the mirror
  (`docs/paper-mp/design-netcode-first.md:222`); the merge dropped it.
- Fix. Move the guard into the shared module: `paperWire.js` (T1, UMD) exports `MP.guardedBorder(center, points,
  radius)` (or `MP.SafeArenaBorder`) with `intersections` capped at `BORDER_GUARD_CALLS` and `setRadius`; both
  `ArenaGame` (server) and `paperPredict.js` / `paperMirror.js` (client) use it, so server and predictor take the same
  escape on the same input and the push repairs it on both. Section 11 `paperPredict.test.js` adds the exact case:
  state `{ x: 1900, y: 1000, dir: 0 }`, angle byte 0, 100 ticks, must return within 100 ms and end inside the wall.
  `paperWire.test.js` adds "guarded border returns `[]` after 12 calls and resets on `resetGuard`".

### M3. Free-arena bot difficulty and type mix silently differ from solo (unstated mechanic, no constant)

- Severity: major. Sections: 4.4-4.5, 2 (no entry), the brief's "everything else stays IDENTICAL".
- Claim. With `player` null, `Game.update` sets `this.level = config.noPlayerBotLevel` (0.5) instead of
  `lerp(startBotLevel, 1, player.percent)` (0.1 at a fresh start, `paperGame.js:457-461`, `paperSkins.js:200-201`).
  That level also picks the bot type row: `BOT_TYPE_ROWS[Math.round(level * 3)]` is row 2 at 0.5 and row 0 at 0.1
  (`paperGame.js:205`), so the free arena spawns a different mix of bot types, and `getSpawnPosition` uses
  `trackFactor = 2` instead of `lerp(3, 1, percent)` (`:128`). A second difference: only the current prey can hide beyond
  a bot's vision range (`paperUnits.js:480-484`); every other human is sensed at any distance. None of this is stated in
  the design, and section 2 has no constant for it, which breaks the brief's own rule that a new mechanic needs a chosen
  number in the one constants block. Failing scenario: a first-time free player meets skill-0.5 bots from tick one
  (solo gives 0.1) and says "the online bots are harder than the solo ones".
- Evidence. Design 4.4 (`applyInputs` only sets `botsCount`), 2 (no bot level entry). Code as cited.
- Fix. Use the seam the stock code already exposes: `config.botLevel !== -1` overrides `level`
  (`paperGame.js:462-464`). In `ArenaGame.update`, before `super.update`, set
  `this.config.botLevel = humans.length ? lerp(startBotLevel, 1, maxHumanPercent) : config.noPlayerBotLevel` (the
  warm-up with no humans keeps the reference's no-player level, as solo does while preparing). Section 2 gains
  `BOT_LEVEL_SOURCE = 'max human percent'` with the reason "solo scales bot skill with the one player's land; the arena
  scales with its leading human so a full arena is no harder than solo". State the vision asymmetry in 4.5 as accepted.
  Section 11 `paperArenaGame.test.js`: "with one human at 0 percent, `game.level` is `startBotLevel` and the first bot
  spawned takes `BOT_TYPE_ROWS[0]`'s type".

### M4. The parity gate is the wrong command: it misses committed solo edits and its glob is shell-dependent

- Severity: major. Sections: 1 (lines 57-59), 11 (line 755), T4 acceptance (line 767).
- Claim. The design's ONLY parity guard is "an empty `git diff --stat -- public/js/paper/*.js public/paper.html`",
  and the golden re-run happens only if that diff is not empty. Two defects. (a) `git diff --stat` compares the working
  tree with the index: an agent that commits a solo edit inside a task commit (the HANDOFF records exactly this kind of
  mid-task damage) leaves an empty diff and the gate passes. (b) Owen's shell is PowerShell, which hands the glob to git
  unexpanded, and git's default pathspec lets `*` match `/`: verified in this repo, `git ls-files -- 'public/js/*.js'`
  lists 18 files under `public/js/v2/` and `public/js/paper/`, while `':(glob)public/js/*.js'` lists none. So once
  `public/js/paper/mp/*.js` exists, the "empty diff" check is either a false alarm on every mp edit (and gets ignored) or,
  under bash, silently excludes nothing useful. Either way the check does not measure "no solo edit since the golden".
- Evidence. Design 57-59, 755, 767; `git ls-files` probe above; the harness loads the ten solo files by explicit path
  (`../paperio-reference/harness/ours.html:46-55`), so the mp folder is invisible to it, which is fine, but the gate must
  say the same ten files.
- Fix. Pin the gate to the last golden-verified commit and an explicit list: `git diff --stat bffe6d5 HEAD --
  public/js/paper/paperGeom.js public/js/paper/paperTerritory.js public/js/paper/paperBots.js
  public/js/paper/paperUnits.js public/js/paper/paperGame.js public/js/paper/paperGameMoves.js
  public/js/paper/paperInput.js public/js/paper/paperSkins.js public/js/paper/paperRender.js
  public/js/paper/paperMain.js public/paper.html` (or the same list behind `':(glob)public/js/paper/*.js'`), run
  before every push and pinned by a small test (`test/paperParityGate.test.js`, T1's owner) that hashes those eleven
  files against the recorded hashes at `bffe6d5`. Also run the golden by hand once at milestone 1 regardless of the diff,
  because the design's "by construction" claim deserves one measurement.

### M5. The task order is not buildable as scheduled: T11 cannot be accepted, T13 deploys a dead link, T6 has a hidden dependency

- Severity: major. Section 12 (lines 774-779), 10.
- Claim. (a) T11's acceptance is "in a browser against a local server the free arena renders for 5 minutes" but T11
  owns only `paperNet.js` and `paperMirror.js`; the page (T12) and the server wiring and route (T9) come later in the
  order line ("T8, T11. T9 + T13 together. T12."), so T11's check cannot be run when T11 is done. (b) T13 depends on T9
  only and "ships in the same push as T9", yet the order puts T12 after both. A push deploys
  (`.github/workflows/deploy.yml:26-35`), so that push puts a live Free button on the Paper card that opens
  `/paper-arena` (404 from `sendFile` of a missing file) AND removes `paper` from `OWN_PAGE`
  (`public/js/v2/play.js:274`) so the working solo launch is gone: the live Free card is broken between the T13 push and
  the T12 push. (c) T6's test "a client fed frames with 8 dropped in a row plus the 10 Hz batches rebuilds the same trail"
  needs the client-side trail reassembly, which section 3 puts in `paperNet.js`/`paperMirror.js` (browser only, T11);
  T6 depends only on T1 and T4. (d) T14's completion edits `PaperRoom.js`, a T7 file, "by T7's owner", so no task owns
  that final switch.
- Evidence. Design 774-779, 10 (OWN_PAGE removal), `play.js:274`, `deploy.yml`.
- Fix. Make the trail reassembler and the ring clamp pure functions in `paperWire.js` (T1) so T6's test and T11 share
  them and T6 stays node-only. Give T11 a node test file (`test/paperNet.test.js`: clock offset EMA, `renderTick`,
  jitter buffer growth and decay, event timeline ordering, `pp:need` after `RESYNC_AFTER_MS`) and move the browser check
  to T12. Make T13 depend on T9 AND T12 and ship the three in one push (milestone 1 = T9 + T12 + T13). Add the trim
  switch to T14's file list as an explicit "T14 also edits `server/paper/PaperRoom.js`, one line, after T7 is merged".

### M6. No headless local server or dev entry token, so the money visuals cannot be verified before real money is used

- Severity: major. Section 12 (T11, T12 acceptance), 8.5, 8.6; HANDOFF "What is NEXT" item 3.
- Claim. T12's acceptance is "money label, coin, hold ring and all five screens seen in the browser". A money label or a
  coin needs a paid seat, a paid seat needs an entry token, and a token only comes from `/api/submit-stake` after a real
  on-chain USDC transfer (`server/entryStore.js:33-40`, `server/index.js:395-397`). The only local server in the design
  is the smoke test's child process (`test/joinSmoke.test.js:36-45`, `DATABASE_URL: ''`), which can seat free players
  only. So the paid HUD cannot be verified until milestone 4 ("one real $0.10 round trip on the live server"), which is
  after T12 is supposed to be accepted. The HANDOFF already flags that the old `duelseries-local` launch is dead.
- Evidence. Design 775 (T12), 588-592; `test/joinSmoke.test.js:36-45`; `../HANDOFF.md` item 3.
- Fix. Add to T9: env `PAPER_DEV_TOKENS=1`, honoured ONLY when `ESCROW_PRIVATE_KEY` is unset and `NODE_ENV !==
  'production'` (a server that cannot pay anyway), which makes `POST /api/submit-stake` mint a token via
  `entryStore.mint({ stake, worth: stake, walletAddress })` without a signature and makes `money.withdraw` a logging
  stub. Add a `.claude/launch.json` entry `duelseries-local` with that env, `PAPER_PAID=1`, `DATABASE_URL=''`,
  `NTFY_DISABLED=1`. Pin it: `test/paperJoinSmoke.test.js` asserts the server REFUSES to boot with `PAPER_DEV_TOKENS=1`
  when `ESCROW_PRIVATE_KEY` is set (exit code non-zero, message names the flag). T12's acceptance then reads "against
  `duelseries-local` with `PAPER_DEV_TOKENS=1`".

### M7. The trim drops land INSIDE the arena and the reseat removes a trail and gifts a base; rule 6 says only outside land goes

- Severity: major. Sections: 9.4 step 4 (line 655, `droppedLobe`), 9.5 (676), 9.6 F1 (694-698), 13 (no question about it).
- Claim. Rule 6: "territory outside the new edge is TRIMMED off, players outside are pushed inward. Nobody dies from the
  shrink itself." Two consequences the design chooses without telling the owner. (a) A base shaped like a U whose bend
  lies outside the wall becomes two pieces inside the arena; the plan keeps only the piece holding the anchor and drops
  the other lobe (`droppedLobe`), which is land inside the new edge. It is forced by the one-ring model
  (`TerritoryBase.polygon` is a single `Polygon`, `paperTerritory.js:47-55`) and matches the reference's own carve rule
  (`paperGameMoves.js:237-246`), but it is not what rule 6 says. (b) F1 reseat: an owner whose ring has no vertex inside
  the wall for 3 s gets `track.remove()` (a long trail thrown away), is moved to a fresh spawn circle (a 2827 u^2 gift)
  and `['mv']` snaps them. Failing scenario: a player with 8 percent of the map in a U loses the 3 percent prong they are
  not standing in, on a shrink, and the leaderboard drops them below the player who killed nobody.
- Evidence. Design 655, 676, 694-698; code as cited.
- Fix. Keep the algorithm (it is the only one the geometry allows) but say it: add question 5 to section 13 ("when the
  wall splits your land in two, you keep the part you are in and lose the other; when none of your land is inside, you
  are re-seated with a fresh base and your trail is cleared; OK?") and put the rule on the lobby rules line. Section 11
  `paperTrim.test.js` already has "concave U keeps the anchor's prong"; add "the dropped prong's area is subtracted from
  `base.square` and `['cap']` is not sent for it" and `paperRoomMoney.test.js` "a reseat moves no money and fires no
  `onTransfer`".

---

## Minor

### m1. The hold counter accumulates float milliseconds, so the "180 ticks pays" test fails as written

- Severity: minor. Sections 5.4 (line 315), 11 (line 745), T7 acceptance.
- Claim. `holdMs += STEP_MS` with `STEP_MS = 1000 / 60`: after 180 additions node gives `2999.999999999995`, which is
  under `HOLD_MS` 3000, so the hold completes on tick 181 and "179 ticks pays nothing and 180 calls `onCashout` exactly
  once" fails (probe: `node -e` sum of 180 steps).
- Fix. Count ticks: `HOLD_TICKS = Math.round(HOLD_MS / STEP_MS)` = 180 in section 2, `holdTicks++`, complete at
  `holdTicks >= HOLD_TICKS`; the wire `hold` byte becomes `holdTicks * 255 / HOLD_TICKS`.

### m2. Section 4.6 is titled "Seams added to solo modules" and section 1 says zero edits; the fallback trigger is a judgment call

- Severity: minor. Sections 1 (57), 4.6 (241-246).
- Claim. The content is consistent (4.6 says "None" plus one fallback), but the heading contradicts the headline and
  the fallback fires when a test "cannot be made to pass", which nobody can measure. The 4.5 getter is observed only
  inside `BotUnit.update` (verified), so the fallback should be unreachable.
- Fix. Rename 4.6 "No seams in solo modules (one forbidden-by-default fallback)" and make the trigger concrete: the
  fallback may be used only if `paperArenaGame.test.js` "bot enters attack on a long human trail" fails AND the failure
  is shown to come from a `game.player` read outside `BotUnit.update` (name the call site in the commit message).

### m3. Section 4.1 leaves `names` and `lang` undefined and the seven-file loader does not include the file that holds the languages

- Severity: minor. Section 4.1 (lines 165-171).
- Claim. `names` is `new P.RandomNamePool(P.botNames, seed)` (`paperUnits.js:576-591,706`, available on the server), but
  `languagesData` lives in `paperMain.js:17-27`, which is not in the seven-file list. The server reads
  `language.defaultPlayerName` only in `spawnPlayer` (never called) and `killText` only for `isPlayer` (never true), so
  any object works, but T4 must not guess.
- Fix. State in 4.1: `names = new P.RandomNamePool(P.botNames, seed)`; `lang = { defaultPlayerName: 'Player', bestTxt:
  'BEST', killText: 'Kill' }` (a copy of `languagesData.en`, never read on the server); `schemes = new
  P.ScoreSchemeManager(P.PercentScoreScheme)` as `paperMain.js:225` does.

### m4. No analytics on the arena page

- Severity: minor. Section 8.5.
- Claim. The other iframes load `/js/posthog-init.js` (`public/game.html:5`, `public/agar.html`) and fire
  `phEvent('cashed_out', { game, amount, ... })` (`public/js/game.js:1793`, `public/js/agar.js:500`); the lobby fires
  `game_started` (`public/js/v2/play.js:291,303`). The design's page loads neither.
- Fix. 8.5: load `/js/posthog-init.js` first; on `pp:cashedout` call `phEvent('cashed_out', { game: 'paper', amount:
  netMicro / 1e6, stake })`; on `pp:joined` `phEvent('game_started', { game: 'paper', stake })` only when the page was
  opened outside the lobby (the lobby already fires it). T12 acceptance: "the two `phEvent` calls are present".

### m5. No viewport or touch rules for the arena page

- Severity: minor. Sections 8.5, 8.6.
- Claim. `paper.html:5` carries `<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1,
  user-scalable=no">` and the canvas CSS that makes steering measure from the centre; 8.5 lists scripts only. Without
  the meta a phone renders the page at 980 px and the hold button lands off-screen.
- Fix. 8.5: "copy `paper.html` lines 1-40 (head, viewport, canvas CSS) verbatim, then add the DOM screens and
  `#pp-cash`"; `#pp-cash` gets `touch-action: none` and `pointer-events: auto` while the canvas keeps its own listeners.

### m6. The lobby row never says full or warming, so a paid player can stake on-chain and be refused at the door

- Severity: minor. Sections 10 (line 725, `state: 'open'`), 6.1, 5.6 step 6.
- Claim. `boardRows()` returns `state: 'open'` always. When all `MAX_ARENAS_PER_STAKE` arenas at a rung are full (128
  humans), the join is refused AFTER the on-chain stake and refunded (question 2), costing two transactions for nothing.
- Fix. `state: seatFor(stake) ? 'open' : 'full'` (a pure query, cheap at 15 s polls) and `warming` for the free rung
  until the warm-up ends; the lobby already reads `state` (`public/js/v2/board.js:4`). Add to `paperArenas.test.js`:
  "rows report `full` when every arena has 16 humans".

### m7. A duplicate join is silent and there is no connecting or unreachable screen

- Severity: minor. Sections 5.6 step 4 (line 353), 8.5 (line 590).
- Claim. Step 4 returns with no reply, so a client that (wrongly) re-sends `pp:join` waits for ever on "warming".
  The five screens have no state for "socket never connected" (server down, wrong region), which the Knockout client
  learned the hard way.
- Fix. Step 4 replies `pp:refused { why: 'already-seated' }` without consuming anything; 8.5 adds a "Connecting" screen
  that becomes "Cannot reach the server, back to lobby" on `connect_error` after 10 s.

### m8. The Lobby button and `pp:leave` forfeit a paid player's money with no confirmation

- Severity: minor. Sections 5.7 (379-382), 6.2 (440), 8.6 (609).
- Claim. Rule 5 makes leaving a no-killer death (correct), but the page offers a one-tap Lobby button top left that
  drops the whole buy-in as a coin. The shooter removed its Leave button for exactly this reason
  (`public/js/shooter.js:1090-1094`).
- Fix. In a paid arena the Lobby button opens a confirm ("Leave now and drop $0.20 on the floor? Hold Q to cash out
  instead.") before `pp:leave`; in the free arena it leaves at once.

### m9. Releasing the LOCAL lock after 300 ms without a frame contradicts "releasing Q cancels"

- Severity: minor. Section 8.6 (line 602).
- Claim. If frames are lost for 300 ms the client unlocks and predicts movement while the server still holds; the
  reconcile drags the square back every frame and the server may complete the cash-out while the client shows the player
  moving. Rule 3 ties cancel to the KEY, not to packet loss.
- Fix. Never release the local lock while the key or button is down; show "waiting for server" on the ring instead,
  and let `HOLD_INPUT_STALE_MS` on the server be the only timeout.

### m10. A pushed square that crosses a foreign trail kills that player: a death the shrink caused

- Severity: minor. Section 9.3 (line 637).
- Claim. The design calls it "a kill by a player, not by the shrink", but the pushed player did not act; the victim's
  trail was simply within 0.5 u of the wall. Rule 6's spirit ("Nobody dies from the shrink itself") is arguable here and
  the money moves to the pushed player.
- Fix. State it explicitly in section 13 as question 6 with the default kept (it is reference-consistent: trails near a
  wall are cuttable) and pin it in `paperRoomMoney.test.js` ("a push through a foreign trail transfers the victim's money
  to the pushed player").

### m11. Section 11 gaps against the HANDOFF list and T11 has no automated test

- Severity: minor. Sections 11, 12 (T8, T11).
- Claim. "Entry token consumed once" is tested only through refusals; a spent token re-sent to `pp:join` (the Knockout
  client's mistake, `public/js/knockout.js:531-535`) is not in `paperSockets.test.js`. "Client cannot inflate worth" has
  the wallet case but not `pp:join { stake: 0.10, entryToken, worth: 999, micro: 999 }` and `pp:respawn { stake: 1 }`
  on a `_ppStake` 0.10 socket. T11 ships two browser files with zero node tests (see M5).
- Fix. `paperSockets.test.js` adds "the same token twice: second join refused, consume spy 1, never seated" and "extra
  money fields in `pp:join` and `pp:respawn` change nothing about the deposit". T11 gains `test/paperNet.test.js` (M5).

---

## Checked and found correct (no finding)

- Owner rules 1, 2, 4, 7 and the "decisions already made" list are followed as written: worth only from the token
  (`consumePaidEntryAtStake`, `server/index.js:395-397,401-412`), `db.recordStake` stays single (`test/v2route.test.js:158-171`),
  cash-out 90/10 through `money.withdraw` with `recordEarnings` on success only, kills and pickups fed to
  `CollusionMonitor.record` (`server/CollusionMonitor.js:42-52`), solvency term added, respawn is a new buy-in from
  `socket._ppStake`, cash-out is reason 7 with no killer and no coin, bots only at stake 0 with `spawnBot` refusing and
  `botsCount` 0, cap 16 humans per arena, the free arena at 15 idle / 16 with humans (the type-row arithmetic holds).
- Same-tick tie: deaths run inside `super.update`, holds in the post pass, so the killer gets a completing holder's money.
- The `get player()` getter never leaks into `kill` (`paperGame.js:369` runs with `_prey` null because kills are dispatched
  in `handleUnitMovements`, after the unit loop) and the base ctor's `this.player = null` hits the no-op setter.
- `unit.log` is written and never read (`paperUnits.js:355,387`); clearing it is safe.
- `spawnDeathParticles` returns at once when `game.visible` is false (`paperUnits.js:134`), so server kills cost nothing.
- `installGameMoves` patches `P.Game.prototype` (`paperGameMoves.js:453-457`); subclass overrides in `ArenaGame` shadow
  it without touching it, and `server/` is never served, so nothing can leak into `/paper`.
- The harness loads the ten solo files by explicit path (`../paperio-reference/harness/ours.html:46-55`); files under
  `public/js/paper/mp/` cannot enter a golden run.
- `node --test` on Node 24 runs each file in its own process, so the process-wide `DuelPaperLib` and `Vec2.space` do not
  bleed between test files; `_enter()` before every out-of-tick mutator answers the solo-seams pitfall 1.
