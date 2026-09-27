# Paper multiplayer: the final design

Written 2026-09-20 by the lead engineer after judging three independent designs
(`docs/paper-mp/design-reuse-first.md`, `design-netcode-first.md`, `design-money-first.md`) against the binding brief
(`docs/paper-multiplayer-brief.md`) and the six reader notes (`docs/paper-mp/understand-*.md`). Paths are relative to
`slither-clone/`. A cite with no folder is under `public/js/paper/`. Every cite below was either re-read by me today or
comes from a reader note that cites the same line. Build from THIS document; the three source designs are background.

---

## 0. Verdict

Scores, 1 (worst) to 5 (best):

| Criterion | reuse-first | netcode-first | money-first |
|---|---|---|---|
| Fidelity to the owner's rules | 5 | 5 | 4 (adds a client-callable refund event the brief never asked for) |
| Solo parity untouched | 5 (zero solo edits, bots included) | 4 (one optional hook, shipped last) | 4 (same optional hook) |
| Money safety | 4 | 4 | 5 (one pure bank object, conservation by structure, payout independent of the socket) |
| Feel online | 3 (10 percent blend, variable dt) | 5 (fixed step, input ack, replay, one timeline) | 3 |
| Amount of new code | 5 | 2 | 3 |
| Testability | 4 | 4 (pure predictor) | 5 (bank property test, handler-order spy, injected payout) |
| Total | 26 | 24 | 24 |

**Base: reuse-first.** It has the smallest diff, zero edits to any solo file, the simplest trim that can work (plan on
plain numbers, validate, then one ring rebuild), and a clean one-owner-per-file split.

**Grafted from money-first:** the `PaperBank` (all in-arena money in one pure object, only `deposit` and `withdraw`
change the arena total), the payout order that carries its own wallet so payment never depends on a socket, the
handler-order test that spies on token consumption, "death wins a same-tick tie with a finishing hold", the
`SPAWN_AXIS_GUARD`, the whole-disc trim case, and the tick try/catch with a once-only emergency close.

**Grafted from netcode-first:** input as one volatile integer carrying `seq`, the angle byte and the HOLD BIT (a lost
packet heals in one frame, there is no start/cancel event to lose), a per-unit `ack` byte in the shared frame, a pure
fixed-step predictor with replay, one playback timeline for remote squares AND reliable events, one ordered reliable
bundle per snapshot tick, the per-version ring cache with an encode budget, the client-side ring clamp so a shrink
costs no ring bandwidth, and every rung launching through the wallet widget.

**Defects found while judging (each verified in code) and fixed here:**

1. reuse-first stores its callbacks on `this.events`, but the stock game owns that name: `this.events = { returns: 0,
   kills: 0 }` (`paperGame.js:93`) and `kill` does `this.events.kills++` (`:345`). Callbacks live on `this.hooks`.
2. reuse-first and money-first keep Paper in `OWN_PAGE` "so free play needs no login". That is false: `launch()` refuses
   an unconnected player at `public/js/v2/play.js:258-262`, BEFORE the shortcut at `:281`. So the shortcut buys nothing
   and costs the stale-sessionStorage trap. Paper leaves `OWN_PAGE`; all three rungs use the widget.
3. netcode-first and money-first set `botsCount: 16` for the free arena. With no humans that spawns a 16th bot, and
   the bot type rows have 15 entries (`paperGame.js:44-49`), so `row[15]` is `undefined` and the bot gets no type
   (`:204-209`). Solo ships `botsCount: 15` (`paperSkins.js:201`). Use reuse-first's 15 / 16 switch (section 4.4).
4. netcode-first computes the house cut in floats (`worth * 0.10`). The cut is integer micro-USDC here.
5. reuse-first applies the trim as remove-then-commit. Commit-then-remove (the order stock `left` uses,
   `paperGeom.js:717-727`) is used instead, so a kept vertex never drops to zero segments and never leaves its grid cell.

---

## 1. The shape in one page

1. **Zero edits to any solo file.** Nothing under `public/js/paper/*.js`, nor `public/paper.html`, nor the `/paper`
   route changes. Golden parity holds by construction; the gate is that
   `git diff --stat bffe6d5 -- ':(glob)public/js/paper/*.js' public/paper.html` prints nothing. It compares the pinned
   golden-verified commit with the working tree, so it catches a solo edit committed inside a task commit as well as an
   uncommitted one; the quotes and the `:(glob)` magic make it shell-independent (from PowerShell an unquoted pattern
   reaches git unexpanded, and git's default pathspec lets `*` match `/`, which would drag `public/js/paper/mp/` into the
   diff). The eleven solo files are the ten modules the harness loads by path (`../paperio-reference/harness/ours.html:46-55`:
   `paperGeom, paperTerritory, paperBots, paperUnits, paperGame, paperGameMoves, paperSkins, paperRender, paperInput,
   paperMain`) plus `public/paper.html`; `test/paperParityGate.test.js` (T1) pins their blob ids (section 11). New code
   lives in `public/js/paper/mp/`. Section 4.6 lists the ONE fallback seam and the condition under which it is allowed.
2. **Server sim = stock `P.Game` with `player`, `controller`, `view` null and `visible` false**, which is already a
   complete server tick (`paperGame.js:398-537`; `readInput` returns at once, `paperGameMoves.js:106-107`).
   `ArenaGame extends P.Game` wraps `update` and overrides `kill`, `getMovement`, `recoverTail`, `handleReturn`,
   `spawnBot`, `addUnit`. Humans are `ArenaHuman extends P.GameUnit` steering from their own angle byte.
3. **Money lives in `PaperBank`, never on a unit and never in a float.** The sim does not know money exists. The room
   joins sim and bank at one seam (`hooks.onDeath`, called from the `kill` override). The room never moves real money:
   it calls `hooks.onCashout / onTransfer / onRefund`, and `server/paperPayout.js` (injected deps) pays.
4. **Netcode:** fixed 60 Hz on both ends; one shared volatile 30 Hz binary state frame per arena; one ordered reliable
   bundle per snapshot tick for everything that must arrive; the client is a mirror `P.Game` whose `player` is the local
   unit, so `renderGameFrame`, camera, minimap, leaderboard and `loop()` run untouched.
5. **Arena:** radius follows `950 * sqrt(n / 16)` clamped 475..950, grows fast, shrinks slowly after a delay, pushes
   squares through the normal movement pipeline with a push piece that never crosses the unit's own trail (and a veto
   scoped to that one piece), trims land with a convex Weiler-Atherton clip that can always say "not this tick", and
   reseats an owner whose land is gone. Nobody dies or loses money to the shrink.
6. **Lobby:** three always-present `game:'paper'` rows on `/api/live`, catalogue row `ladder:1`, `PAGES.paper` in the
   widget (rebuilt and committed), a new page at `/paper-arena`.

---

## 2. Shared constants (ONE block, `P.MP` in `public/js/paper/mp/paperWire.js`, loaded by node and browser)

Every new number lives here and nowhere else. Tests import this block; no test hardcodes a value.

| Name | Value | Reason |
|---|---|---|
| `STEP_MS` | `1000 / 60` | project sim rate (`shared/constants.js:6`); under `2 * FRAME_MS` so one call is a legal stock step (`paperGame.js:703-713`) |
| `MAX_STEPS_PER_WAKE` | 4 | a GC stall never becomes one long step (turn allowance scales with dt, `paperGameMoves.js:59`); extra backlog is dropped |
| `SNAPSHOT_EVERY` | 2 ticks (30 Hz) | project snapshot rate (`shared/constants.js:7`) |
| `TRAIL_BATCH_TICKS` | 6 (10 Hz) | reliable trail corners; the volatile tail covers the gap between batches |
| `MAX_HUMANS` | 16 | brief rule 7 |
| `MAX_ARENAS_PER_STAKE` | 8 | 128 seats per rung, bounds memory; beyond it the door refuses and refunds |
| `FREE_BOTS_IDLE` / `FREE_SQUARES` | 15 / 16 | bot type rows have 15 entries (`paperGame.js:44-49`); solo is 15 bots + 1 player |
| `HOLD_MS` | `C.CASHOUT_HOLD_MS` = 3000 | brief rule 3 (`shared/constants.js:22`); kept as the brief's number and the client ring duration only |
| `HOLD_TICKS` | `Math.round(HOLD_MS / STEP_MS)` = 180 | the hold is counted in whole SIM ticks so it is exact (180 additions of the float `STEP_MS` sum to 2999.999999999995 and would complete one tick late); every one of those ticks the holder was killable |
| `HOLD_INPUT_STALE_MS` | 500 | wall clock, measured from the last RECEIVED input: the hold bit counts as released when no input arrived for 500 ms, so a released key whose packets were lost on a dying link must not cash out |
| `DISCONNECT_GRACE_MS` | 5000 | owner decision 3 (section 13): after the socket closes the square keeps moving on its last steering for 5 s and the same seat can be taken back; only then does the money drop |
| `PICKUP_SWEEP_MS` | 3600000 | owner decision 1 (section 13): a coin nobody collects within 60 minutes of dropping (server clock) leaves the arena to the house, recorded like rake |
| `UNIT_ID_MAX` | 65535 | `unit.id` is 1..65535 (0 is the wire's "none", 7.1); the per-arena counter wraps and skips any id held by a live unit or an open account, so a long-lived free arena never hands out a colliding id |
| `HOUSE_CUT_DIV` | 10 | `cut = floor(gross / 10)` in integer micro-USDC: the existing 90/10 (`server/index.js:2221-2223`) |
| `PICKUP_RADIUS` | 16 u | twice the trail width (`paperSkins.js:195`): the square visibly overlaps the coin; a tick moves 1.5 u so a pass cannot skip it |
| `PICKUP_WALL_INSET` | 12 u | a wall slider sits ON the wall; 12 is under `PICKUP_RADIUS`, so a coin against the wall is always reachable |
| `R_MAX`, `R_MIN`, `N_FULL`, `N_BASE` | 950, 475, 16, 4 | brief: `radiusFor(n) = clamp(950 * sqrt(n / 16), 475, 950)` |
| `GROW_RATE` | 60 u/s | one join is 30 to 56 u, so the arena is the right size within a second ("growth quick") |
| `SHRINK_RATE` | 4 u/s | "shrinks slowly": 1/22 of unit speed (90 u/s, `paperSkins.js:196`), so nobody is outrun; one death at n = 16 takes 7.5 s |
| `SHRINK_DELAY_MS` | 3000 | a quick re-buy cancels the shrink, so the wall does not jiggle |
| `RADIUS_QUANTUM` | 0.5 u | `setRadius`, push and trim run about 8 times a second while shrinking, never 60 |
| `PUSH_INSET` / `PUSH_TWIST` | 0.5 u / 0.001 rad | push target sits just inside the apothem and never on an exact symmetric coordinate (the wall-vertex hang, `paperGameMoves.js:70-99`) |
| `PUSH_TWIST_CANDIDATES` | `[1, -1, 2] * PUSH_TWIST` | the push piece is tried with each twist in this order and the first that does not cross the unit's own trail is used, so the push never crosses it (never twist 0: a radial push makes a perpendicular presser's stock re-approach overlay its own push segment, the probe's original reason 2 death on a STOCK piece); the push piece is the ONLY move whose reason 2 hit is vetoed (9.3) |
| `BORDER_GUARD_CALLS` | 12 | cap on `border.intersections` calls per movement step, shared by server and predictor (`MP.guardedBorder`, 4.3): the exact-vertex hole in the stock wall loop is a hang for some step phases and an escape through the wall for others (probed: 38 of 150 phases hang, 41 escape); no legitimate step needs more than 3 calls |
| `SPAWN_TRIES` | 60 | bounded `getSpawnPosition` attempts (it returns undefined on failure, `paperGame.js:121-174`) |
| `SPAWN_AXIS_GUARD` | 0.5 u | reject spawn points within 0.5 u of `x = 1000` or `y = 1000` (exact east from y = 1000 reaches wall vertex 0 exactly: the exact-vertex hole, a hang for some step phases and an escape through the wall for others, probed) |
| `BOT_LEVEL_SOURCE` | max live human percent, else the reference's no-player level | `applyInputs` sets `config.botLevel = lerp(startBotLevel 0.1, 1, max live human percent)` and `-1` with no live human (so the stock `noPlayerBotLevel` 0.5 branch runs, `paperGame.js:454-461`): solo scales bot skill with the one player's land (`:455`) and the arena has one level per tick (skill is computed once at `:464`, a per-bot level would need a solo edit), so it follows its leading human; a fresh joiner meets the leader's level, accepted; with no humans (warm-up) the reference's no-player level is kept, exactly as solo's warm-up does (`paperMain.js:133-148`) |
| `SPAWN_SAFE_LOOKAHEAD` / `SPAWN_SAFE_MARGIN` | 3 squares / 60 u | spawn inside the radius the arena would have with three fewer squares, minus two base radii, so a fresh base survives several deaths |
| `TRIM_MAX_PER_TICK` | 4 | bounds trim cost per tick on the shared core |
| `TRIM_MIN_AREA` | 200 u^2 | 7 percent of a spawn base (pi * 30^2 = 2827); below it the owner is reseated |
| `TRIM_MAX_EDGE` | 20 u | one grid cell (`paperSkins.js:185`); the broad phase finds a segment only through endpoints within a cell (`paperGeom.js:323-349`) |
| `TRIM_INVALID_LIMIT` | 20 | consecutive invalid plans before a base stops retrying until the next quantum or return |
| `RESEAT_AFTER_MS` | 3000 | an owner with no reachable land waits at most this long for a fresh base |
| `TRAIL_TOL` / `TRAIL_MAX_GAP` / `TRAIL_TAIL_MAX` | 0.35 u / 40 u / 4 | wire trail decimation (a wall crawler lays 5885 raw points in 25 s, probe); tail = corners since the last reliable batch; 4 is double the sim-reachable maximum of about 3 corners per batch window (turn cap `2 * PI / 60` rad per 1.5 u tick against `TRAIL_TOL`, exhaustive search, plus one wall-touch corner); corners past the cap wait for the next reliable batch, at most 100 ms of trail lag and never a gap after the batch lands |
| `RING_TOL` / `RING_ENCODES_PER_TICK` | 0.4 u / 3 | stock `simplify` is 25 u, too coarse to draw; a capture that carves five bases cannot spike a tick |
| `INTERP_DELAY_MS` / `MAX_JITTER_BUF_MS` / `DEAD_RECKON_MS` | 70 / 180 / 200 | the snake client's proven numbers (`public/js/game.js:73-84`) |
| `PREDICT_DT_BIAS_MS` | 0.005 | the mean of the server's per-tick `rng() * 0.01` ms (`paperGame.js:406`); the predictor steps at `STEP_MS + PREDICT_DT_BIAS_MS` so the one-sided jitter does not accumulate against it |
| `RECONCILE_POS_EPS` / `RECONCILE_DIR_EPS` | 0.5 u / 0.5 deg | below this the predictor is left alone. The server's dt jitter is one-sided (mean +0.005 ms, 0.00045 u per tick) and accumulates linearly on straight runs (0.25 u over 600 ticks, probe), so the predictor carries the mean; 0.5 u sits above the stacked u16 rounding (0.044 u) and the residual random walk (under 0.02 u per minute, probe) and is invisible against an 8 u trail. Direction differences stay under 0.001 rad and do not accumulate |
| `SNAP_DIST` / `VISUAL_DECAY_MS` | 40 u / 100 ms | larger error snaps (push, reseat); smaller is hidden by a decaying visual offset |
| `INPUT_BUFFER` | 64 | one second of predicted inputs, keyed by `seq` (8.2 says how a miss is detected) |
| `INPUT_QUEUE_MAX` | 3 | per-human FIFO on the server so the ack advances exactly one `seq` per server tick, which is what `buffer[ack]` assumes; a bunch of up to 3 late packets is absorbed; costs up to 2 ticks (33 ms) of input latency while jitter persists, drained one tick at a time on the next gap; drop-oldest on overflow |
| `MAX_PREDICT_TICKS_PER_FRAME` | 4 | client mirror of `MAX_STEPS_PER_WAKE`: a resume burst after a tab stall neither blows through the input ring nor trips the server's 120 per second `pp:in` limit |
| `RESYNC_AFTER_MS` | 500 | a version mismatch older than this sends `pp:need` |
| `WARM_CHUNK` | 100 updates per `setImmediate` | 6000 warm-up updates cost 474 ms in one block (probe), which would stall snake and agar |
| `ARENA_SWEEP_MS` | 300000 | an OVERFLOW arena is deleted after 5 empty minutes, only with zero money on its floor |
| `EMERGENCY_FAIL_TICKS` | 3 | consecutive thrown ticks before the once-only emergency close (a cash-out at the normal 90/10, 5.9) |
| Wire scales | position `u16 = round(v * 32)`, radius `* 32`, percent `* 65535` with `pct` clamped to `[0, 1]` first, direction `u16` of a full turn | arena is 2000 wide: 64000 fits a u16 at 0.03 u; untrimmed or blocked land can make `base.square` exceed `game.square`, so an unclamped percent would wrap |

---

## 3. File map (every file has exactly one owning task, section 12)

```
public/js/paper/mp/paperWire.js      UMD  constants, radiusFor, wallInside, pushPoint, guardedBorder, codecs, decimators, fmtMicro
public/js/paper/mp/paperPredict.js   UMD  pure own-square predictor (node-testable)
public/js/paper/mp/paperNet.js       UMD  socket (injected), clock, frame buffer, event timeline, pp:need (node-testable with a socket double)
public/js/paper/mp/paperMirror.js    UMD  ClientArenaGame, MirrorUnit, event lookup, interpolation, ring clamp (node-testable with view null)
public/js/paper/mp/paperHud.js       browser  money labels, pickups, hold ring, Q + touch button, screens
public/js/paper/mp/paperArenaMain.js browser  boot, canvas, fonts, sessionStorage, reconnect, restake bridge, analytics, game:done
public/paper-arena.html, public/css/paper-arena.css
server/paper/loadPaperLib.js         requires the seven solo sim files in page order, then paperWire; returns DuelPaperLib
server/paper/ArenaGame.js            ArenaGame, ArenaHuman, radius stepping, push, rewindTrail, prey, spawn, reseat
server/paper/arenaTrim.js            planTrim (pure), applyTrim, checkRing
server/paper/arenaWire.js            wire trails, ring cache, frame builder, join payload builder
server/paper/PaperBank.js            pure, no imports
server/paper/PaperRoom.js            one arena: ArenaGame + PaperBank + seats + sockets + tick + hooks + grace + pickup sweep
server/paper/PaperArenas.js          arenas per stake, seatFor, seatByKey, overflow, sweep, boardRows
server/paperSockets.js               attach(socket), drop(socketId): all pp:* handlers incl. the reconnect path (injected deps)
server/paperPayout.js                create(deps): payCashout(order), refund(order), sweepFloor(order)
EDIT server/index.js (one owner)     about 60 lines, section 6.4; the same owner EDITS server/entryStore.js (the `paid`
     field, 5.5), server/db.js (`claimDuePayout` returns `reason`, 5.5), test/entryStore.test.js, and COMMITS
     scripts/dev-local.js (today untracked) with the PAPER_DEV_TOKENS launch, section 6.4 item 9
EDIT public/v2.html, public/js/v2/play.js, public/js/v2/board.js, wallet-widget/src/main.jsx,
     public/wallet/widget.js (rebuilt), test/v2route.test.js          (one owner)
test/paper*.test.js                  section 11 (incl. paperParityGate, paperNet, paperMirror). No helper module in test/
                                     (default discovery would run it); each test declares its own io and socket doubles
                                     as test/shooter.test.js:6,20-32 does.
```

---

## 4. Server sim (`server/paper/ArenaGame.js`)

### 4.1 Loading and construction
`loadPaperLib.js` requires `paperGeom, paperTerritory, paperBots, paperUnits, paperGame, paperGameMoves, paperSkins` in
the order of `public/paper.html:52-59`. They are IIFEs over `globalThis` (`paperGameMoves.js:458`) and
`installGameMoves` runs itself at load (`:457`). No per-arena state may be put on `DuelPaperLib`.

The three remaining constructor arguments are built exactly as the solo boot builds them, none may be null:
`names = new P.RandomNamePool(P.botNames, seed)` (`paperUnits.js:576-591,706`; `spawnBot` returns early when
`nameManager` is missing, `paperGame.js:187`, which would leave the free arena with no bots); `lang = {
defaultPlayerName: 'Player', bestTxt: 'BEST', killText: 'Kill' }` (a copy of `languagesData.en`, `paperMain.js:18`, a
file the seven-file loader does not load; never read on the server because `spawnPlayer` is never called and
`ArenaHuman.isPlayer` is false); `schemes = new P.ScoreSchemeManager(P.PercentScoreScheme)` as `paperMain.js:225` does
(it feeds `GameUnit.schemes`, `paperUnits.js:365`, and so the per-tick rank sort at `paperGame.js:445` that the
lowest-bot removal in 5.6 relies on).
```
makeArena({ stake, seed })
  config = Object.assign({}, P.defaultPaperConfig, { botsCount: stake > 0 ? 0 : MP.FREE_BOTS_IDLE })   // own copy
  space  = new P.SpatialGrid(2000, 2000, config.quadSize)
  border = MP.guardedBorder(center(1000, 1000), config.borderPoints, stake > 0 ? MP.R_MIN : MP.R_MAX, space)   // 4.3
  skins  = new P.SkinManager(new P.ColorSkinPool(undefined), new P.ClassicSkinPool(undefined, null, '', []), seed)
  game   = new ArenaGame(config, null, space, border, skins, null, names, null, lang, schemes, seed)   // paperGame.js:52-53
  game.updateParticlesId.unref()        // the ctor timer (paperGame.js:95-97) must not keep node or a test alive
```
`addPlayer` and `spawnPlayer` are never called (`spawnPlayer` evicts `units[~~(len/2)]` and retries for ever,
`paperGame.js:232-247`). `game.stop()` only on teardown (it sets `stopped`, after which `update` returns false, `:403`).

### 4.2 `ArenaHuman extends P.GameUnit`
Fields: `id` (1..`UNIT_ID_MAX`, from the per-arena counter in `addUnit`, never an index: `units` is re-sorted every
tick, `paperGame.js:445`), `isHuman = true`, `angle` 0..253, `seqAck`, `holdBit`, `lastInputAt`, `locked`, `holdTicks`
(integer), `_pushPiece`, `_inPush`, `socketId` (null while the seat is in its disconnect grace, 5.7). No money field, no
wallet field. The room keeps the rest per SEAT (`{ unit, socketId, resumeKey, graceUntil, fifo, lastSeq }`, 5.6 and 5.7).
```
update(dt) { super.update(dt);
  this.target = this.locked ? null
    : new P.Vec2(1, 0).rotate(this.angle * Math.PI / 127).mulScalar(50).add(this.position); }   // paperUnits.js:446-449
```
`target = null` makes `movement()` falsy (`paperUnits.js:422-424`) so `getMovement` returns no pieces
(`paperGameMoves.js:52-53`): that IS the cash-out movement lock (probe: displacement 0.000). The trail of a locked
square stays cuttable, which is the intended risk. `isPlayer` stays false so the server builds no labels. The stock
turn cap (`paperGameMoves.js:56-63`) bounds turning whatever byte arrives.

### 4.3 The border: `MP.guardedBorder(center, pointCount, radius, space?)` (`paperWire.js`, shared by server and predictor)
A factory, not a load-time subclass (it looks up `root.DuelPaperLib` at CALL time, so `paperWire.js` still loads
standalone under `require`, T1). It builds `P.ArenaBorder.circular(center, pointCount, radius)` (`paperTerritory.js:23`)
and wraps it:
- `intersections(seg)`: counts calls since `resetGuard()`; once the count reaches `BORDER_GUARD_CALLS` it returns `[]`.
  A try/catch cannot interrupt a synchronous loop, so this cap is the only guard against the exact-vertex hole in the
  stock `while (wallHits.length)` loop (`paperGameMoves.js:70-99`), which hangs for some step phases and lets the unit
  walk through the wall for others (probed on both server and client strides). Every caller runs `resetGuard()` right
  before each movement step (server `getMovement`, 4.4; predictor `step`, 8.2), because normal slides use 2 to 3 calls
  per tick and a cap with no reset would go dead within five ticks.
- `setRadius(r)`: `this.radius = r; let pts = P.makeCirclePoints(center, pointCount, r); if (space) pts = pts.map(p =>
  space.checkPoint(p)); this.polygon = new P.Polygon(pts); this.polygon.calcPath();` plus cached `apothem = r * cos(PI /
  pointCount)` and the ring orientation sign. On the server `space` is the arena grid, so the border's vertex OBJECTS are
  always the registered ones when a point at that location is already in the grid (`SpatialGrid.checkPoint`,
  `paperGeom.js:316-319`): the stock wall slide hands the border polygon's own vertex objects to a sliding unit's trail
  (`Segment.intersect` snaps to stored ends, `paperGeom.js:194-201`; the slide ends a piece on it, `paperGameMoves.js:81-88`;
  `track.add` commits it, `:371-374`; probe: 55 border vertices registered by one 900-tick slide), so any other object
  at those coordinates (a fresh trim vertex, or a fresh border after growth back to a visited radius) would make
  `unifyHitPoints` throw "two registered points at one location" (`paperGameMoves.js:384-408`). The predictor passes no
  `space` (its geometry is never committed). The wall itself is never committed (`paperTerritory.js:14-29`), so a rebuild
  is free (0.023 ms, probe). The caller then sets `game.square = border.polygon.square()` (computed once only in the
  ctor, `paperGame.js:77`; it feeds percent `:418`). Centre stays (1000, 1000), radius never above 950 (`SpatialGrid.cell`
  does not clamp, `paperGeom.js:304-310`).

### 4.4 `ArenaGame` overrides (prototype methods, so no solo edit)
- `update(dt)`: `_enter(); nowMs += dt; applyInputs(); stepRadius(dt); super.update(dt);` then the post pass IN THIS
  ORDER: `trimDirtyBases()` (walks `this.units`, the stock sim's only base registry; stock `kill` splices a victim out
  of `this.units` in the same call that sets `death`, so a dead owner's base is never trimmed), `perHumanMagnet()` (free only, 4.5), `hooks.afterTick()` (the room: pickups incl. the
  hour sweep, then grace expiries, then holds, then wire feed, then `bank.assertConserved()`), `for (u of units)
  u.log.length = 0` (stock pushes one entry per tick and never reads it, `paperUnits.js:355,387`). Deaths happen inside
  `super.update`, before holds, so on a same-tick tie DEATH WINS and the killer gets the money.
- `applyInputs()` (before `super.update`), per human seat: the input FIFO (`INPUT_QUEUE_MAX`, filled by `setInput`,
  6.2) is popped EXACTLY ONE entry per tick, never two (popping two reintroduces the client mismatch that the queue
  exists to remove): that entry's `angle` and hold bit become the unit's, `seqAck` = its `seq`. An arriving `seq` not
  newer than the last applied one (modulo 256) is ignored at `setInput`. When the FIFO is empty the unit repeats its
  last angle and hold bit and `seqAck` is unchanged. Then, free arena only: `config.botsCount = humans > 0 ? 16 : 15`,
  and `BOT_LEVEL_SOURCE` (section 2): `const live = this.humans.filter(h => !h.death); this.config.botLevel = live.length
  ? P.lerp(this.config.startBotLevel, 1, Math.max(...live.map(h => h.percent))) : -1;` (`P.lerp`, `paperGeom.js:1068`;
  `percent` is last tick's value from `paperGame.js:419`, a one-tick lag, accepted). The level drives three things in
  the stock tick: per-bot skill (`paperGame.js:464`), the spawn type row `BOT_TYPE_ROWS[round(level * 3)]` (`:204`), and
  `getSpawnPosition`'s `trackFactor`, which is 2 with `player` null instead of `lerp(3, 1, percent)` (`:128-130`; accepted,
  it only widens the spawn search).
- `kill(victim, killer, reason)`:
  ```
  if (victim.death) return;                                         // one capture can call kill twice (paperGameMoves.js:196-201)
  if (reason === 2 && victim._inPush) { this.rewindTrail(victim); return; }   // the push piece never kills (9.3); the trail stays simple
  if (reason === 6 && victim.isHuman) return;                       // a human is never system-evicted
  const at = { x: victim.position.x, y: victim.position.y };        // self cross: already the crossing point (paperTerritory.js:232)
  victim.locked = false; victim.holdTicks = 0;
  super.kill(victim, killer, reason);                               // paperGame.js:341-372
  this.hooks.onDeath(victim, killer && !killer.death ? killer : undefined, reason, at);
  ```
  Killer is defined for reasons 3, 4, 5 and undefined for 1, 2, 6 (`paperTerritory.js:237,240`,
  `paperGameMoves.js:197,200`). New reasons `7 CASHOUT`, `8 DISCONNECT` (grace expired, 5.7), `9 LEAVE`, `10 FORCED_EXIT`
  (emergency close and a failed join, 5.6) are safe: the base compares only against 6 and 0 (`paperGame.js:353,369`;
  probe: reason 7 removes cleanly). Reason 2 on a STOCK piece (a self cross within 5 u of the wall,
  `paperTerritory.js:225-238`) is never vetoed: pressing into the wall kills exactly as solo does.
- `rewindTrail(unit)` (only from the veto above): `UnitTrack.handleIntersect` has already set `unit.position` to the hit
  point `X` (`paperTerritory.js:232`; a trail vertex for an overlay hit, a point on the crossed segment otherwise) and
  `handleUnitMovements` will still append `move.end` (`paperGameMoves.js:370-374`), so without a rewind the polyline would
  cross itself with no shared vertex and every later `handleReturn` (`:158-201`) and `planTrim` would work on a
  non-simple ring. Rewind: find the trail segment `i` whose span contains `X`; `track.polyline.remove()`; rebuild the
  polyline with `addDistinct` over `v0 .. vi` then `X` (each new segment commits itself, `paperGeom.js:594-612`);
  recompute `track.length` and `track.simplified` from the surviving points; drop every `track.intersections` record
  whose point is no longer on the trail; set `unit.in` to the base of the last surviving `enter` record with no later
  `exit` for that base, else null (enemy rings keep their inserted vertices, harmless). Mid-dispatch mutation is safe:
  `Segment.remove` nulls `shape` (`paperGeom.js:156-159`) and `dispatchBucket` skips such hits (`paperGameMoves.js:446`).
  `handleUnitMovements` then appends `move.end` from `X`, so the trail stays simple. The wire trail epoch bumps (7.4).
- `getMovement(dt, unit)`: `border.resetGuard()` first; if the unit is outside the wall build the push piece with the
  candidate rule of 9.3 and prepend it; then `super` evaluated from the push target.
- `dispatchBucket(bucket, unit, move)`: `unit._inPush = (move === unit._pushPiece); try { return super.dispatchBucket(...); }
  finally { unit._inPush = false; }` (a subclass method, `paperGameMoves.js:412-449`; no solo edit).
- `recoverTail()`: the stock 12-line body (`paperGameMoves.js:137-149`) run for every human (stock reads `this.player`).
- `handleReturn(unit)`: `const r = super.handleReturn(unit); unit.base._trimDirty = true; unit.base.wireVer++; return r;` (the own-return bump of 7.3; there is no separate dirty set)
  The trim itself waits for the post pass, because `dispatchBucket` still holds hit records for that ring
  (`paperGameMoves.js:412-449`).
- `spawnBot(mode)`: `if (this.stake > 0) return; return super.spawnBot(mode);` (second lock on THE ONE RULE, on top of
  `botsCount: 0`, `paperGame.js:184`). Free arena: bots = `min(15, 16 - humans)` (the cap check is `units.length >=
  botsCount` when `player` is null, with `botsCount` set per tick in `applyInputs`).
- `addUnit(unit)`: assigns `unit.id` from the per-arena counter (1..`UNIT_ID_MAX`, wrapping past the top and skipping
  any id held by a live unit or an open bank account; 0 is never handed out), pushes, and for a `P.BotUnit` installs the
  prey wrap (4.5). `spawnBot` calls `this.addUnit(bot)` (`paperGame.js:222`), so no copy of `spawnBot` is needed.
- New: `findSpawn()` (pure query, 9.6), `spawnHuman(spec, spot)`, `removeHuman(id, reason)`, `setInput(id, seq, angle,
  holdBit)`, `reseat(unit)`, `nearestHuman(bot)`, `stats = { pushCrossings: 0 }`.

### 4.5 Bots hunt humans with no solo edit
```
get player() { return this._prey || null; }   set player(v) {}     // the base ctor assigns this.player = null (paperGame.js:68)
addUnit wrap:  const stock = unit.update, g = this;
  unit.update = function (dt) { g._prey = g.nearestHuman(this); try { stock.call(this, dt); } finally { g._prey = null; } };
```
The bot reads of `game.player` inside `BotUnit.update` (`paperUnits.js:480` directly, `paperBots.js:44,335` via
`this.fsm.update()` at `paperUnits.js:516`) see the wrap's prey. `game.player` is ALSO read outside `BotUnit.update` in
two places, both handled here: (a) at `BotUnit` construction: the ctor builds its FSM (`paperUnits.js:468`), the
`StateMachine` ctor runs `change('idle')` -> `update()` at once (`paperBots.js:18,30`), `idle.update` returns `exit` when
`bot.in === bot.base` (`:73`), and `exit.update` calls `isPlayerTrackInAggroRange` (`:136` -> `:44`), all inside `spawnBot`
BEFORE `addUnit` installs the wrap; it reads null, so a bot spawning inside aggro range of a human trail attacks one
tick later than stock, accepted; (b) any external `fsm.change('attack')`: `StateMachine.change` runs the new state's
`update` synchronously (`paperBots.js:21-32`) and `attack.update` returns `idle` on a null player (`:334-337`), whose
chained `idle.update` draws `rng()` and resets the bot. So `perHumanMagnet()` (the loop at `paperGame.js:502-522` once
per live human whose `track.length > config.botAttackTrackLength`, picking `nearestBot` exactly as `:502-520` does)
supplies the prey around the change it issues: `bot._preyHint = human; this._prey = human; try {
bot.fsm.change('attack'); } finally { this._prey = null; }`. `attack.update` then sets `bot.target` from the human's
trail with no rng draw, and the next tick's wrap returns the same human via `_preyHint`. The other reads in a sim file
are `recoverTail` (`paperGameMoves.js:138`, overridden) and the reads in `Game.update` itself, which run while `_prey` is
null (`paperGame.js:411`), as does `kill` (`:369`). `nearestHuman(bot)` returns `bot._preyHint` if it is still alive,
else the nearest live human. Vision asymmetry, accepted: with `player` = the nearest human, only THAT human can hide
beyond `visionRange` (`paperUnits.js:480-484`); every other human is sensed at any distance, like bots are in solo.

### 4.6 Seams added to solo modules
**None.** The one permitted fallback: if `test/paperArenaGame.test.js` "a bot enters `attack` on a long human trail"
(the magnet-path version, section 11) STILL fails with 4.5 as written, AND the failure is traced to a `game.player`
read outside `BotUnit.update` other than the two named in 4.5, with the call site named in the commit message, then
replace `bot.game.player` by `(bot.game.preyFor ? bot.game.preyFor(bot) : bot.game.player)` at `paperBots.js:44`,
`:335` and `paperUnits.js:480`. It is a strict no-op in solo (no `Math.random` or `game.rng` draw added, no iteration
order changed) and REQUIRES a by-hand golden re-run (600/600 on both seeds, `../paperio-reference/spec/BUILD-BRIEF.md`)
before the commit. That commit, and nothing else, may move the parity pin: the commit id in the gate line (section 1,
11, T4) and the eleven blob ids in `test/paperParityGate.test.js` move in the SAME commit as the recorded 600/600
golden re-run. Nothing else may touch a solo file.

### 4.7 `Vec2.space`, tick, warm-up, idle
- `P.Vec2.space` is ONE process-wide static (`paperGeom.js:293,386,518`) that `update` re-points only at the top of a
  tick (`paperGame.js:404`). Every public mutator of `ArenaGame` (`spawnHuman`, `removeHuman`, `reseat`, `applyTrim`,
  `stop`) starts with `_enter()` = `P.Vec2.space = this.space`. Node is single threaded and no `update` is ever
  suspended, so a synchronous set is sufficient and keeps the join one atomic turn (5.6).
- Tick: `PaperRoom` owns `setInterval(wake, 16)`. `wake`: `acc += now() - last`; run `min(MAX_STEPS_PER_WAKE, floor(acc /
  STEP_MS))` steps of exactly `STEP_MS`; drop the rest. Never `loop()` (rAF, `paperGame.js:685-724`). Each step is wrapped
  in try/catch (5.9). Every deadline reads `room.now()` or sim time, so tests step a fake clock (`test/shooter.test.js:8-17`).
- Idle: the interval exists only while `liveHumans > 0`, where a seat in its disconnect grace (5.7) still counts (its
  square is alive and moving). A paid arena with money on its floor and nobody in it is frozen, not destroyed. At the
  moment a paid arena's `liveHumans` reaches 0 with `bank.totalMicro() > 0`, `PaperRoom` logs one line `[PAPER] IDLE
  <lobbyType> <JSON of open accounts { wallet, name, micro } and coins { pid, srcWallet, micro, droppedAt }>`: that is
  precisely when the money becomes floor-only and invisible to the drain check (5.8), and pm2 keeps the log. Floor money
  is memory only, like every live stake (5.9); the stake rows written by `recordEntry` plus this line are the record.
  While frozen, the hour sweep of 5.3 still runs from the directory's 60 s timer (6.1). The first join restarts with
  `last = now()` (no catch-up burst).
- Free arena #1 warms up once at boot: 6000 updates of `50 + Math.random()` ms (`paperMain.js:108-131`) in chunks of
  `WARM_CHUNK` per `setImmediate`. Until done, free joins get `pp:refused { why: 'warming', retryMs: 500 }` and the client
  retries by itself (no token is at stake at stake 0). Overflow free arenas skip the warm-up.
- Same-tick mutual cuts are decided by rank order (`paperGame.js:445`, `paperGameMoves.js:333-336`). Reference behaviour,
  kept; money is still assigned exactly once.

---

## 5. Money

### 5.1 `PaperBank` (`server/paper/PaperBank.js`, pure, integer micro-USDC, no imports)
```
constructor({ onTransfer, onBreach })
deposit(unitId, micro, wallet, name)   opens an account; throws when that id has a currently OPEN account, on a negative
                                       or a non-integer (a closed account is deleted, see below, so an id can be reused)
isOpen(unitId)   balance(unitId)       0 for unknown or closed
transferAll(fromId, toId)  -> micro    closes and DELETES `from`, credits `to`, calls onTransfer({ srcWallet, dstWallet, micro, kind: 'kill' });
                                       returns -1 and moves NOTHING when `to` is not open
drop(fromId, x, y, now)    -> pickup | null     closes and deletes `from`; null when the balance is 0 (free arena never shows coins)
collect(pickupId, toId)    -> micro    deletes the pickup and credits; onTransfer({ srcWallet, dstWallet, micro, kind: 'pickup' }); no-op when gone
withdraw(unitId)           -> { micro, wallet, name }     closes and deletes the account; outMicro += micro
sweepPickup(pickupId)      -> { micro, srcWallet, srcName } | null   deletes the pickup; outMicro += micro (the money LEAVES
                                       the arena, to the house, 5.3); null when gone
movePickup(pickupId, x, y)             never deletes
pickups()  floorMicro()  totalMicro()  = sum(open accounts) + sum(pickups)
ledger { inMicro, outMicro }           invariant: totalMicro() === inMicro - outMicro
assertConserved() -> bool              on a breach calls onBreach ONCE with the numbers; never throws in production
```
Only `deposit`, `withdraw` and `sweepPickup` change the arena total, so conservation is structural, and `withdraw` can
never return more than `inMicro - outMicro`: an arena cannot pay out more than it took in, whatever bug exists
elsewhere. Closed accounts are deleted (the pickups map keeps the money), so "0 for unknown or closed" and
closed-account idempotence hold by absence and a wrapped `unit.id` (4.4) can open a fresh account. A pickup is `{ pid, x,
y, micro, srcWallet, srcName, droppedAt }` (`droppedAt` = `room.now()` at the drop, the hour sweep's clock). `onTransfer`
takes ONE object; `PaperRoom` constructs the bank with `onTransfer: (t) => hooks.onTransfer({ ...t, label:
this.lobbyType })`, so the label the collusion record needs is added by the one object that knows it (the pattern of
`server/GameRoom.js:564`) and the bank stays pure. The collusion account id is the TOKEN wallet, never a client id (the
snake's `socket._googleId` is client supplied, cashout note section 6). `toMicro(worth) = Math.round(worth * 1e6)`;
floats exist only when reading `entry.worth` and `entry.paid` and when calling `money.withdraw(wallet, micro / 1e6)`
(`Usdc.toUnits` rounds to 6 decimals, `server/Usdc.js:40`). Free arena: every balance is 0, so every `micro > 0` guard
keeps the money paths inert.

### 5.2 The kill seam: `room.onDeath(victim, killer, reason, at)`
```
if (reason === 7 || reason === 10) { queue ['k', id, 0, reason, 0, 0]; return; }     // already withdrawn, no credit, no coin
const m = bank.balance(victim.id); let pid = 0;
if (m > 0) {
  if (killer && killer.isHuman && bank.isOpen(killer.id)) { bank.transferAll(victim.id, killer.id); queue ['m', killer.id, bank.balance(killer.id)]; }
  else { const p = bank.drop(victim.id, clampInside(at, radius - PICKUP_WALL_INSET)); pid = p.pid; queue ['p+', p.pid, p.x, p.y, p.micro]; }
} else if (victim.isHuman) bank.drop(victim.id, 0, 0);                                 // closes a zero account
queue ['k', victim.id, killer ? killer.id : 0, reason, m, pid];
victim socket: reliable 'pp:dead' { reason, killerId, killerName, lostMicro: m, tick }
```
One capture can kill several victims; each gets its own call, its own transfer and its own collusion record.

### 5.3 Pickups (room post pass, after deaths, before grace expiries and holds)
For each pickup in creation order: among live humans with an open account and `distanceSq <= PICKUP_RADIUS^2`, take the
NEAREST; an exact tie goes to the lower `id`. `bank.collect(pid, unit.id)`, queue `['p-', pid, unit.id, micro]` and `['m',
unit.id, balance]`. Bots never collect. Pickups are never culled by count or by crowding (real money, the point
`server/Food.js:173-190` makes for cash food). On a shrink quantum a pickup beyond `radius - PICKUP_WALL_INSET` is moved
radially with `bank.movePickup`. A player may collect a coin they dropped in an earlier life (`CollusionMonitor.record`
ignores `src === dst`, `server/CollusionMonitor.js:43`).

**The hour sweep (owner decision 1).** After the collect step, `room.sweepPickups(now)`: every remaining pickup with
`now - droppedAt >= PICKUP_SWEEP_MS` is taken off the floor: `const s = bank.sweepPickup(pid)` (the money leaves the
arena total through `outMicro`, so it stops counting as liability, 5.8), queue `['p-', pid, 0, micro]` (`byId` 0 = swept,
the client removes the coin with no floater), and `hooks.onSweep({ sweepId: crypto.randomUUID(), micro, srcWallet:
s.srcWallet, srcName: s.srcName, label: lobbyType, pid })`, which `paperPayout.sweepFloor` records as house income (5.5),
never as anybody's earnings. A frozen arena (4.7) has no tick, so `PaperArenas.sweep(now)` (the existing 60 s timer,
6.1) also calls `room.sweepPickups(now)` on every room with pickups and no interval: an idle arena's stale coins go to
the house within a minute of the hour mark. Until then a coin waits on the map and counts as liability. Consequence for
overflow arenas: once every coin on an idle overflow floor has been swept, `bank.totalMicro()` is 0 and the arena is
eligible for the `ARENA_SWEEP_MS` deletion (6.1).

### 5.4 Cash-out state machine (on the unit, advanced by the sim tick, server clock only)
```
IDLE     --(holdBit && input fresh && alive)-->                         HOLDING   locked = true, holdTicks = 0
HOLDING  --(!holdBit || now - lastInputAt > HOLD_INPUT_STALE_MS)-->      IDLE      locked = false, holdTicks = 0
HOLDING  --each tick-->                                                 holdTicks += 1
HOLDING  --(death, any reason)-->                                       gone      money moved by 5.2; the hold dies with the unit object
HOLDING  --(socket closes, 5.7)-->                                      IDLE      cancelled at the disconnect, not resumed by a reconnect
HOLDING  --(holdTicks >= HOLD_TICKS)-->                                 room.completeCashout(unit)
```
The hold is counted in whole ticks (`HOLD_TICKS`, section 2), never in float milliseconds. `completeCashout(unit)`, all
synchronous, nothing awaited:
```
const w = bank.withdraw(unit.id);                        // zero + close FIRST: the double-pay guard (server/index.js:2214-2217 pattern)
const order = { cashoutId: crypto.randomUUID(), socketId, wallet: w.wallet, name: w.name, grossMicro: w.micro, stake, label: lobbyType };
try { game.removeHuman(unit.id, 7); }                    // kill(unit, undefined, 7): square and land removed, no credit, no coin
finally {                                                // dispatched exactly once whenever the bank has released money, even if the sim throws
  if (w.micro > 0) hooks.onCashout(order);               // (the 5.9 tick try/catch still sees the throw afterwards)
  else io.to(socketId).emit('pp:cashedout', { grossMicro: 0, cutMicro: 0, netMicro: 0 });   // free arena: a clean exit
}
```
`cashoutId` is a fresh `crypto.randomUUID()` minted in `PaperRoom` (the primitive the entry token uses,
`server/entryStore.js:37`), NEVER derived from an arena label, an index or a per-room counter: overflow arenas are swept
and re-created at the same index and `emergencyClose` replaces an arena in place, so any label-plus-counter id would
repeat and the payout de-duplicator (5.5) would silently drop a real payout. The client is never asked whether the hold
finished. A respawn is a new `ArenaHuman` with `holdTicks = 0`, so the snake's "die mid-hold, respawn, instant payout"
bug (`server/index.js:2147-2213`) cannot occur. A pushed (9.3) holder keeps holding.

### 5.5 Payout (`server/paperPayout.js`, `create({ money, db, trackEarning, sweepRake, io, REGION })`)
`payCashout(order)`, a sibling of `doCashout` (`server/index.js:2209-2264`), which is closure-bound to the snake socket:
```
if (seen.has(order.cashoutId)) { console.error('[PAPER] CASHOUT duplicate id', JSON.stringify(order)); return; }   // a hit is a BUG, never a retry
seen.add(order.cashoutId);                                                          // bounded Set, newest 5000
cut = Math.floor(order.grossMicro / HOUSE_CUT_DIV);  net = order.grossMicro - cut;   // ALWAYS 90/10 (brief rule 3); there is no forced field
try {                                                                                // belt and braces: bookkeeping can never prevent the one withdraw
  if (cut > 0) { trackEarning({ source: 'game_rake', game: 'paper', amountUsdc: cut / 1e6, wallet, name, lobbyType: label, region: REGION });
                 sweepRake(cut / 1e6, 'paper ' + label); }                         // server/index.js:35-55, 2226-2233
  io.to(order.socketId).emit('pp:cashedout', { grossMicro, cutMicro: cut, netMicro: net, cashoutId });   // display only
} catch (e) { console.error('[PAPER] PAYOUT bookkeeping', e.message); }
money.withdraw(order.wallet, net / 1e6)                                              // unconditionally, exactly once per order
  .then(sig => { db.recordEarnings(wallet, name, net / 1e6, money.fiatValue(net / 1e6)).catch(() => {}); emit 'pp:paid' { sig, netMicro: net }; })
  .catch(e  => { db.recordFailedPayout(wallet, net / 1e6, name, 'paper ' + label + ': ' + e.message, e.broadcast).catch(() => {});
                 emit 'pp:payerror' { message }; });                               // NO inline retry: the NA drainer recovers (server/index.js:1967-1996)
```
The de-duplicator is redundant by construction (`withdraw` closes the account, the unit is removed, the hook is called
synchronously exactly once), so a `seen` hit can only mean a bug and is logged loudly, never swallowed.

`refund({ wallet, name, micro, paid, why })`: no rake, `money.withdraw` of `Math.min(micro, toMicro(Number.isFinite(paid)
? paid : micro / 1e6))`. `micro` is the rung; `paid` is the amount that actually landed on-chain, carried in the entry
token: the stake verifier accepts `expected * 0.99` (`server/money.js:72`, `server/Usdc.js:124-126`) and `tierFor` rounds
to whole cents (`server/stakeRules.js:45-55`), so 0.099 USDC buys a $0.10 token and 0.995 USDC a $1.00 token, and a
refund of the RUNG would mint the difference on every refused join (10 per minute per IP, `server/index.js:359`).
`entryStore.mint` therefore stores `paid`, `consumeAtStake` returns it, and `server/index.js:583` becomes
`entryStore.mint({ stake: rung, worth: rung, paid: worth, walletAddress: payer })` (T9; the tier path and an old token
have no `paid`, so the fallback refunds the rung and never NaN or 0). Every call logs `[PAPER] REFUND <wallet> <micro>
<why>` BEFORE `money.withdraw` (the `[KO] refunding ...` convention, `server/index.js:1232`), so the line exists even
when the transfer fails. Failure goes to `recordFailedPayout` with reason `'refund paper ' + why + ': ' + e.message`
(the first 500 chars are kept, so the prefix survives): the NA drainer (`server/index.js:1972-1996`) recovers every
failed row and today records `db.recordEarnings` for each, so `db.claimDuePayout` gains `reason` in its `RETURNING`
list (`server/db.js:270`, T9) and `drainPayouts` skips `recordEarnings` when `String(row.reason || '').startsWith('refund')`
(`markPayoutPaid` and the recovery log unchanged; the existing Knockout and Battleship reasons begin with `knockout` /
`battleship`, so nothing changes for them). A refund never calls `recordEarnings` (the Knockout refund wrongly does,
`server/index.js:1245`). Note for T9: Knockout and Battleship refunds (`server/index.js:1170-1176, 1232-1234`,
`server/KnockoutLobby.js:261-263`) refund the rung and carry the same 1 percent hole today; out of scope for Paper,
flagged. Payment never reads a socket property: the wallet travels in the order, so a socket that closes between
completion and payment is still paid.

`sweepFloor({ sweepId, micro, srcWallet, srcName, label, pid })` (the hour sweep, 5.3): `seen` de-duplication as above
(a hit logs `[PAPER] SWEEP duplicate id`), then `trackEarning({ source: 'paper_floor', game: 'paper', amountUsdc: micro /
1e6, wallet: srcWallet, name: srcName, lobbyType: label, region: REGION })` and `sweepRake(micro / 1e6, 'paper floor ' +
label)`: the rake's own path (ledger row plus the on-chain move to the revenue wallet, `server/index.js:35-55`), with its
own `source` so the owner's per-source dashboard shows swept floor money apart from rake; it explains the escrow surplus
that the liability drop creates. Never `recordEarnings`, never a player payout. One log line `[PAPER] SWEEP <label>
<pid> <micro> <srcWallet>`.

### 5.6 Join and respawn order (`server/paperSockets.js`; the order is the contract, asserted with a spy on consume)
```
pp:join { name, stake, entryToken, resumeKey? }
 1. socketRL(socket, 'ppjoin', 1000)                                                     server/index.js:62
 2. stake = Number(msg.stake); if (!isStake(stake)) refuse('bad-stake')                  server/stakeRules.js:36-69
 3. if (stake > 0 && !PAID_ENABLED) refuse('not-open')                                    token untouched (it still opens another game)
 3r. if (msg.resumeKey) RECONNECT PATH (5.7): seat = arenas.seatByKey(String(msg.resumeKey));
    if (!seat) refuse('expired') (nothing consumed); else seat.room.resume(socket, seat); socket._ppRoom / _ppStake
    from the SEAT, never the message; return.  No token is read, consumed or refunded on this path.
 4. if (socket._ppRoom && socket._ppRoom.hasLiveUnit(socket.id)) return                  duplicate guard, PLAY's (server/index.js:2051-2055)
 5. if (ops.get().maintenance) refuseAndRefund('maintenance')                            server/index.js:2072-2075
 6. seat = arenas.seatFor(stake, socket._ppRoom)   -> { room, spot } | null;  if (!seat) refuseAndRefund('full')
 7. entry = consumePaidEntryAtStake(msg.entryToken, stake, 'paper')                      server/index.js:395-397; SAME number as step 6
    if (!entry.ok || (stake > 0 && !(entry.worth > 0 && entry.walletAddress))) refuse('Entry fee not verified')   never seated free
 8. if (socket._ppRoom && socket._ppRoom !== seat.room) socket.leave(socket._ppRoom.ioRoom)   // a respawn into another arena
    try { seat.room.addHuman(socket, { name: sanitizeName(name), micro: toMicro(entry.worth), wallet: entry.walletAddress || null, spot: seat.spot }) }
    catch (e) { if (entry.worth > 0) payout.refund({ wallet: entry.walletAddress, name, micro: toMicro(entry.worth), paid: entry.paid, why: 'seat-failed' }); refuse('seat-failed') }
 9. socket._ppRoom = seat.room; socket._ppStake = stake
```
- Steps 2 to 6 consume nothing. `seatFor` is a pure query (`findSpawn` mutates nothing) and steps 6 to 8 are one
  synchronous turn, so the seat and the spot cannot be taken in between. There is no room name on the wire, so the
  `consumeAtStake(undefined, 0)` free pass (`server/entryStore.js:49`) can only ever seat you in a stake 0 arena. Client
  `wallet`, `worth`, `micro` or `paid` fields in `pp:join` (and any `stake`, `worth` or `micro` in `pp:respawn`) change
  nothing: the deposit is `toMicro(entry.worth)` from the token, and the refund bound is `entry.paid` from the token.
- `refuseAndRefund(why)` when `stake > 0`: `r = entryStore.consumeAtStake(msg.entryToken, stake)` DIRECTLY
  (`server/entryStore.js:46-55`; not through `recordEntry`, so no stake row for a seat never taken); if `r.ok && r.worth > 0
  && r.walletAddress` then `payout.refund({ wallet: r.walletAddress, name, micro: toMicro(r.worth), paid: r.paid, why })`,
  which pays what landed on-chain, capped at the rung (5.5). One-time because the token is. Reply `pp:refused { why,
  refunded }`. There is NO client-callable refund event: a refund only follows a server-decided refusal. A spent token
  re-sent through `pp:join` or `pp:respawn` (the Knockout client's mistake) reaches step 7, consume returns `ok: false`
  (a deleted token is indistinguishable from an unknown one), and the socket gets `pp:refused 'Entry fee not verified'`
  with no refund and no seat.
- `addHuman(socket, spec)` inside `_enter()`: `if (this.stopped) throw new Error('stopped')` (a swept or emergency-closed
  arena never seats anyone; the throw lands in the step 8 refund); free arena at 16 squares first removes the LOWEST
  ranked `BotUnit` (reason 6, never a human); `unit = game.spawnHuman(spec, spot)`; then EVERYTHING after that runs in a
  try/catch whose catch calls `game.removeHuman(unit.id, 10)` (reason 10 takes the no-bank early return in 5.2: no
  coin, no `pp:dead`) and rethrows into the step 8 refund, so a failed join never leaves a unit in the arena:
  `bank.deposit(unit.id, micro, wallet, name)`; the seat record `{ unit, socketId, resumeKey: crypto.randomUUID(),
  graceUntil: 0, fifo: [], lastSeq: -1 }` (5.7); then, IMMEDIATELY before `socket.join(ioRoom)`, if the pending event
  queue is non-empty it is flushed now as `pp:ev { tick: currentTick, ev }` to the room and cleared, so the evicted bot's
  `['k']` and the joiner's own `['j']` go to the existing members only and the joiner never receives an event its
  payload already reflects (the payload is built from live state in this same call, and a queue flushed on the next
  snapshot tick would replay a kill or a coin drop from the tick before the join); `socket.join(ioRoom)`; reliable
  `pp:joined` (6.3, carrying `resumeKey`) built in the same call so there is no gap between the payload and the event
  stream.
- `pp:respawn { entryToken }`: same list with `stake = socket._ppStake` (never the message, `server/index.js:2360-2370`);
  step 6 passes the current `socket._ppRoom` as `preferred` and `seatFor` honours it only while it is still listed, not
  stopped and has a spot (6.1); a swept or replaced arena is skipped and step 8 leaves its io room. The paid client gets
  a fresh token through the existing `duel:restake` bridge (`wallet-widget/src/main.jsx:355-378`, reference client
  `public/js/game.js:2031-2046`).
- Socket state is `_ppRoom` and `_ppStake` only. Nothing of the snake's (`_room`, `_stake`, `_cashoutTimer`,
  `_walletAddress`) is read or written: the snake handlers act on `socket._room.snakes` (`server/index.js:2162-2165`).

### 5.7 Disconnect grace, reconnect, leave (owner decision 3)
**Disconnect.** `paperSockets.drop(socketId)` next to `endShooter` (`server/index.js:2835`), from io's `disconnect`:
`seat = arenas.seatOfSocket(socketId)` (a `socketId -> seat` map kept by the directory in step with `addHuman`,
`resume` and the seat being freed; `socket._ppRoom` is not consulted because the socket object is gone); if none,
return. `room.beginGrace(seat)`: `unit.holdBit = 0; unit.locked = false;
unit.holdTicks = 0` (any hold is cancelled at the disconnect and is never resumed), `seat.fifo.length = 0`,
`seat.socketId = null; unit.socketId = null`, `seat.graceUntil = room.now() + DISCONNECT_GRACE_MS`. The square is NOT
removed: `ArenaHuman.update` keeps steering from `angle` (the last applied byte) with no further input, so it keeps
moving on its last steering, stays alive and killable, keeps its account and its land, and still counts in
`liveHumans` (the tick interval keeps running, 4.7) and in the `snakes` getter (5.8: money is still on the table).
**When the clock starts:** socket.io reports a disconnect at once on a clean close (tab closed, `transport close`), but
on a silent link loss only after `pingInterval + pingTimeout` = 5000 + 10000 ms (`server/index.js:98-99`, reason `ping
timeout`). The grace clock starts at THAT event (`room.now()` when `drop` runs), as the owner's rule says ("when a
human's socket closes"), so a silently lost phone keeps its square steering on its last angle for up to 15 s before the
5 s grace even begins; `HOLD_INPUT_STALE_MS` has already cancelled any hold 500 ms into the silence. Accepted and stated;
no second timer is added.
**Expiry.** In the room post pass (after pickups, before holds): every seat with `graceUntil` set and `graceUntil <=
now`: `room.removeHuman(id, 8)` = `kill(unit, undefined, 8)`, which reaches `onDeath` with no killer, which drops the
coin where the square stood (brief rule 5); the seat is freed and its `resumeKey` forgotten.
**Death during the grace** follows the normal rules of 5.2 (killer takes all, or a no-killer death drops the coin); the
seat is freed; `pp:dead` goes to a closed socket and is lost, so a later reconnect finds no seat and gets `pp:refused {
why: 'expired' }` (the page shows the disconnected screen: "Your money dropped where you stood").
**Reconnect** (`room.resume(socket, seat)`, reached from step 3r of 5.6 by a `pp:join` carrying the seat's `resumeKey`):
the socket handshake carries no identity, so the seat is proven by possession of `resumeKey`, a `crypto.randomUUID()`
minted per seat and sent only to that seat's socket in `pp:joined`, the same principle as the entry token; the seat's
wallet is the token's wallet, so "the same wallet takes the square back" holds by construction and nobody else can
name it. If `seat.socketId === socket.id` (the seated socket re-sent its own key) the reply is simply a fresh
`pp:joined { resumed: true }` and nothing else changes. If `seat.socketId` is another live socket (two sockets on one
wallet: the old one has not been reported dead yet, or a second tab sent the key), the NEWER socket wins: the older
gets reliable `pp:replaced { tick }`, is `socket.leave(ioRoom)`'d and has its `_ppRoom` cleared. Then: `seat.graceUntil = 0`, `seat.socketId = unit.socketId =
socket.id`, `seat.fifo.length = 0; seat.lastSeq = -1` (the resumed client's `seq` restarts at 0 after its reset, 8.2),
pending events flushed to the room as in `addHuman`, `socket.join(ioRoom)`, reliable `pp:joined { resumed: true, ... }`
built from live state exactly as on a first join (the predictor, mirror and rings reset from it). No token is consumed,
no deposit, no db row, no new buy-in. The hold is not restored: the client re-arms it only from a fresh keydown.
**Client** (8.5): socket.io reconnects by itself; on every `connect` after the first, the page sends `pp:join { name,
stake, resumeKey }` with NO `entryToken` (it was removed from sessionStorage after the first join) and shows
"Reconnecting..." over the last frame; `pp:joined { resumed: true }` resumes play, `pp:refused { why: 'expired' }` and
`pp:replaced` show the disconnected screen (the latter with "This seat was taken over by a newer connection"). The
`resumeKey` lives in page memory only: a page reload is a new page and that seat is lost at the end of its grace, like
a closed tab. This replaces the earlier "never re-emit `pp:join` on a reconnect" rule; the Knockout client's mistake
(`public/js/knockout.js:512-536`) was re-sending a SPENT TOKEN, which this path never carries.
**Leave.** `pp:leave` is deliberate: `room.removeHuman(id, 9)` at once, no grace, hold cleared, `kill(unit, undefined,
9)`, coin dropped where the square stood; `socket.leave(ioRoom)` (GameRoom does, `server/GameRoom.js:262`; the shooter
forgets). The live HUD has no leave control (8.6); `pp:leave` is sent only from the end screens, where the unit is
already gone and the call is a no-op cleanup, so a mis-tap can never forfeit a buy-in.

### 5.8 Solvency, drain, console
- `sumLiveSelfCustodyStakes` (`server/index.js:1702-1728`) gains `for (const r of paperArenas.all()) total +=
  r.liveStakeTotal();` where that is `bank.totalMicro() / 1e6`: live humans (seats in grace included) PLUS unswept floor
  coins, each dollar once. A swept coin (5.3) has left through `outMicro`, so the liability drops by exactly the amount
  the `paper_floor` ledger row explains. `sweepRake` leaves escrow no cushion, so exactness matters. Money withdrawn from
  the bank but not yet landed on-chain is not counted, which errs toward surplus, never a false shortfall (same as the
  snake).
- `PaperRoom` exposes `get snakes()` returning a fresh `Map<seatKey, { alive, isBot: false, worth }>` of live paid
  humans (a seat in grace is alive and listed), exactly what `ops.drainStatus` reads (`server/ops.js:57-66`), so `ops.js`
  is not edited. Floor money is reported as `floorWorth` in the ops snapshot and does not block a drain:
  `maintenance:check` reads only live squares, and floor money is memory only, exactly like a live snake stake or the
  snake's own cash food, so look at `floorWorth` (and the `[PAPER] IDLE` line, 4.7) before a push.
- Console contract (`server/ShooterRoom.js:441-491`): numeric `stake`, `lobbyType` (`paper_na_s0`, `paper_na_s0_1`,
  `paper_na_s1` plus `#n`), `playerCount`, `botCount`, `isFree()` = `stake === 0`, `botsAllowed()` = `isFree()`,
  `addBot()` returns null when paid, `topUpBots()` deletes every bot first when paid, `clearBots()`.

### 5.9 Failure handling for every money transition
| Transition | Failure | Handling |
|---|---|---|
| stake to token | existing path | unchanged (`/api/submit-stake`, `db.markStakeSig`) |
| token to seat | refusal before consume (maintenance, full) | token consumed once by the refund path, the on-chain amount (`entry.paid`) capped at the rung sent back, `pp:refused { refunded: true }`; no stake row is written |
| token to seat | bad, expired, spent or wrong-stake token | `pp:refused`, nothing consumed, never seated free |
| token to seat | `addHuman` throws after consume (incl. `'stopped'`) | the spawned unit, if any, is removed with reason 10 inside `addHuman`; exactly one `payout.refund` bounded by `entry.paid`, `pp:refused { why: 'seat-failed', refunded: true }` |
| seat-failed refund | stats drift | `stakes_history` keeps the buy-in row written by `recordEntry` and no offsetting row exists (`recordStake` rejects `amt <= 0`, `server/db.js:324`); the profile `totalStaked` (`server/db.js:472-479`) overstates by that amount; accepted, stats only, same as the Knockout and Battleship queue refunds; do NOT reconcile by writing maintenance/full refunds as stakes or by copying Knockout's `recordEarnings`-on-refund (`server/index.js:1245`); `db.recordStake(` keeps its single call site (6.4) |
| disconnect | socket closes | 5.7: hold cancelled, square keeps moving for `DISCONNECT_GRACE_MS`; a reconnect with the seat's `resumeKey` takes it back (no token, no deposit); expiry drops the coin where the square stood; a death in the window follows 5.2 |
| floor coin | uncollected for `PICKUP_SWEEP_MS` | `bank.sweepPickup` moves it out of the arena total, `sweepFloor` records it as `paper_floor` house income and moves it to the revenue wallet like rake; never earnings; a frozen arena is swept by the directory's 60 s timer |
| kill transfer | killer vanished in the same capture, or is a bot | `transferAll` returns -1 and moves nothing; the room drops a coin instead |
| kill called twice for one victim | | first line of `kill`; and a closed account transfers 0 |
| coin collected twice | | `collect` on a deleted pickup is a no-op |
| hold | death, release, stale input, respawn | state is on the unit object and dies with it |
| cash-out twice | | `withdraw` on a closed account returns 0; `cashoutId` (a UUID) de-duplicated in `paperPayout`, a hit is logged as a bug |
| cash-out dispatch | the sim throws inside `removeHuman` after `bank.withdraw` | the `finally` in `completeCashout` still dispatches the order exactly once; a mis-wired hook cannot hide until the first paid cash-out because the `PaperRoom` constructor asserts `typeof hooks.onCashout / onTransfer / onRefund / onSweep / onBreach === 'function'` and throws at boot |
| on-chain payout fails | | `db.recordFailedPayout(..., e.broadcast)`, `pp:payerror`, NO retry; the drainer re-sends idempotently |
| refund payout fails | | same `recordFailedPayout` row with a reason beginning `refund`; the drainer records no earnings for such rows (5.5) |
| conservation breach | | `[PAPER] LEDGER` with the numbers, owner alert once, arena keeps running, never throws |
| a tick throws | | caught, logged, tick skipped. `EMERGENCY_FAIL_TICKS` in a row: `emergencyClose()` behind a once-only latch: each live paid account is cashed out to the letter of brief rules 3 and 5, through `bank.withdraw` and the NORMAL `onCashout` order (fresh UUID `cashoutId`, 90/10 in `payCashout`, no special field); each floor coin goes back to `srcWallet` through `payout.refund` (nobody earned it; same shape as the refused-join refund); one log line `[PAPER] EMERGENCY <lobbyType> accounts=<n> coins=<n> micro=<total>` and the owner alert used for the ledger breach; the arena is `stop()`ped and replaced (6.1). The bank ceiling bounds the total to what the arena took in. The 90/10 here is the default of an open question (section 13, still open 5): the alternative is 100 percent, the house forgoing its cut on its own bug. |
| refund and emergency amounts vs what landed | the verifier's 1 percent tolerance | join-refusal and seat-failed refunds are bounded by `entry.paid`, so they can never exceed what landed. The emergency-close payouts and coin refunds are NOT bounded by any single `paid` (a balance carries kills from other tokens): they pay the bank balance, which can exceed what landed by at most the verifier's tolerance (1 percent of a dime arena's intake, 0.5 percent of a dollar arena's), once per arena behind the once-only latch, and 90/10 takes more than that back. Accepted. |
| server restart with money live | | known, accepted limitation shared with the snake (`server/ops.js:19-23`): memory only. Paper is visible to the drain status so the console warns first; the `[PAPER] IDLE` line (4.7) records floor money at the moment it becomes floor-only. |

---

## 6. Rooms, directory, sockets

### 6.1 `server/paper/PaperArenas.js`
Not a `LobbyRegistry` (its sweep deletes a paid room after 5 empty minutes whatever is on its floor,
`server/LobbyRegistry.js:84-95`) and never the snake `ladder` (the solvency sum would throw on `room.snakes`,
`server/index.js:1704-1715`, swallowed by `checkSolvency`'s catch).
```
arenas: { '0.00': [PaperRoom], '0.10': [...], '1.00': [...] }        keys Number(stake).toFixed(2); this REGION only
seatFor(stake, preferred) -> { room, spot } | null
                     `preferred` (a respawn's current arena) is honoured only when arenas[key].includes(preferred) &&
                     !preferred.stopped && preferred.findSpawn() yields a spot; otherwise the normal scan: rooms with
                     liveHumans < 16, FULLEST first, ties to the one holding floor money; first room whose findSpawn()
                     yields a spot wins; none: create an overflow arena (an empty arena always has a spot) while
                     list.length < MAX_ARENAS_PER_STAKE; else null
seatByKey(resumeKey) -> seat | null        the reconnect lookup (5.7): a Map resumeKey -> seat kept by the directory, entries
seatOfSocket(socketId) -> seat | null      added at addHuman, re-pointed at resume, and removed when the seat is freed (death,
                     expiry, cash-out, leave, stop); the second map is what drop(socketId) uses (5.7)
all()   sweep(now)   (1) deletes an OVERFLOW arena (index > 0) only when liveHumans === 0 AND bank.totalMicro() === 0 for
                     ARENA_SWEEP_MS, calling room.stop() first so `stopped` is really set (addHuman then throws 'stopped',
                     5.6); (2) calls room.sweepPickups(now) on every room that holds pickups and has no tick interval, so
                     the hour sweep (5.3) survives an arena going idle
emergencyClose       (5.9) also calls room.stop() on the closed room before the replacement takes its index
boardRows()          section 10
PAID_ENABLED         process.env.PAPER_PAID === '1'   (ship free first, then switch paid on)
```
An arena's only identity is `lobbyType` plus `#n` (5.8), and `n` is reused after a sweep or an emergency close. The
`arenaId` in `pp:joined` is DISPLAY ONLY and carries no money meaning: nothing money-related (cash-out ids, sweep ids,
seat keys) is ever derived from it.

### 6.2 Client to server
| Event | Emit | Payload | Notes |
|---|---|---|---|
| `pp:join` | reliable | `{ name, stake, entryToken }` or, on a reconnect, `{ name, stake, resumeKey }` | once per token, 5.6; the reconnect form carries no token and consumes nothing, 5.7 |
| `pp:respawn` | reliable | `{ entryToken }` | stake from `socket._ppStake` |
| `pp:in` | **volatile**, EVERY predicted tick (60 Hz, exactly like the snake's `sendInput`, `public/js/game.js:2222-2224`) | one integer `(seq & 255) << 16 \| angle << 8 \| flags` | `Number.isInteger`, `angle <= 253`, flags bit0 = HOLD. Queued per human in a FIFO of `INPUT_QUEUE_MAX`, one consumed per server tick (4.4 `applyInputs`); a `seq` not newer than the last applied (modulo 256) is ignored; on overflow the OLDEST queued entry is dropped, never the newest; more than 120 per second from one socket are ignored (dropping the oldest queued entry, never the newest) |
| `pp:need` | reliable | `{ id \| 0 }` | 250 ms limit per unit, 2000 ms for `0` (everything) |
| `pp:leave` | reliable | none | deliberate exit, no grace: the money drops at once (5.7); only sent from end screens |
| `pp:ping` | volatile, 1 Hz | `{ t }` | reply `pp:pong { t, tick }` |

Every handler first checks that an object payload is a non-null object (`pp:in` that it is an integer) and returns
silently otherwise, before any destructuring: `server/` has no `uncaughtException` handler, so a thrown handler would
be a process crash with every live stake in memory (5.9), not an emergency close.

### 6.3 Server to client
| Event | Emit | Payload |
|---|---|---|
| `pp:joined` | reliable, one socket | `{ you, arenaId (display only, 6.1), stake, tick, radius, targetRadius, holdTicks, resumeKey, resumed: false \| true, units: [{ id, name, skin, bot, x, y, dir, inId, micro, pct, ver, epoch }], pickups, rings: ArrayBuffer[], trails: ArrayBuffer[] }`; `skin` is the colour skin NAME, its main hex (`paperSkins.js:381,472`); `pct` clamped to `[0, 1]`; `resumed: true` is the event a client needs to resume after a reconnect (5.7): the full state, applied exactly like a first join |
| `pp:s` | **volatile**, room, 30 Hz | one shared `ArrayBuffer`, 7.1 |
| `pp:ev` | reliable, room, on snapshot ticks with events, and flushed early at any join or resume (5.6) | `{ tick, ev: [...] }`, 7.2. ONE stream, so order is total |
| `pp:geo` | reliable, one socket | reply to `pp:need`: `{ tick, ev: [['b', ...], ['t', ...]] }` for that unit or all |
| `pp:dead` | reliable, victim | `{ reason, killerId, killerName, lostMicro, tick }` |
| `pp:cashedout`, `pp:paid`, `pp:payerror` | reliable, one socket | 5.5 |
| `pp:refused` | reliable, one socket | `{ why, text, refunded, retryMs? }`; always says why; `why: 'expired'` answers a reconnect whose seat is gone |
| `pp:replaced` | reliable, the OLDER socket | `{ tick }`: a newer socket took this seat with its `resumeKey` (5.7) |

### 6.4 `server/index.js` and sibling edits (single owner, T9, about 60 lines)
1. Near the shooter room (`:1261`): build `paperArenas`, `paperPayout = require('./paperPayout').create({ money, db,
   trackEarning, sweepRake, io, REGION })`, `paper = require('./paperSockets')({ io, arenas, ops, socketRL, sanitizeName,
   isStake, consumePaidEntryAtStake, entryStore, payout, collusion })`. Room hooks: `onCashout = payout.payCashout`,
   `onTransfer = (t) => collusion.record(t.srcWallet, t.dstWallet, t.micro / 1e6, { lobbyType: t.label })`
   (`server/CollusionMonitor.js:42-52`; `t` is the one object of 5.1 with `label` added by `PaperRoom`), `onRefund =
   payout.refund`, `onSweep = payout.sweepFloor`, `onBreach` = owner alert. The `PaperRoom` constructor asserts every
   hook is a function and throws otherwise, so a mis-wiring fails at boot, not at the first paid cash-out (the free
   arena never calls `onCashout` with money, so free testing would not catch it).
2. Inside `io.on('connection')` (`:2028`): `paper.attach(socket)`. 3. Disconnect (`:2835`): `paper.drop(socket.id)`.
4. Solvency term (5.8). 5. `ALL_ROOMS` (`:823`) pushes `paperArenas.all()`; `roomLabel` (`:840`) and `opsSnapshot` (`:875`)
   get one Paper branch each.
6. `/api/live` (`:1491`): `lobbies: liveBoard().concat(paperArenas.boardRows())`. `liveBoard` itself is NOT reshaped (its
   text is pinned, `test/v2route.test.js:197-213`).
7. `app.get('/paper-arena', ...)` next to `/paper` (`:1123`): one path segment, so relative script urls resolve.
8. `everyStaggered(() => paperArenas.sweep(Date.now()), 60000, ...)` (arena deletion AND the idle-arena hour sweep, 6.1).
9. **Dev entry tokens** (so the paid HUD and money path can be exercised before real money): env `PAPER_DEV_TOKENS=1`,
   honoured only when `!process.env.ESCROW_PRIVATE_KEY` (an empty string counts as unset, matching `server/Wallet.js:29`
   and `scripts/dev-local.js:60`) and `NODE_ENV !== 'production'`; the check sits beside the `ALLOW_TEST_OWNER` block
   (`server/index.js:172-179`) and `process.exit(1)`s with a message naming the flag when the escrow key is set. In that
   mode `POST /api/submit-stake` with `{ stake, walletAddress }` and no `signedTx` skips `Wallet.submitStake`,
   `money.verifyStake` and `db.markStakeSig` and mints through the normal `entryStore.mint({ stake: rung, worth: rung,
   paid: rung, walletAddress })` (`isStake` still enforced), so the 5.6 join order, `consumePaidEntryAtStake` and
   `recordEntry` run unchanged. `paperPayout.create` then receives a `money` object whose `withdraw` resolves a fake
   signature and logs `[PAPER] DEV withdraw`, scoped to Paper's injected deps only (the global `money` module is
   untouched). `scripts/dev-local.js` (today untracked) is committed by T9 with `PAPER_PAID: '1'` and `PAPER_DEV_TOKENS:
   '1'` added to its env block; the launch entry stays `duelseries-local` -> that script on port 4409
   (`../.claude/launch.json` has no env field, the script assigns `process.env` itself).
10. `server/entryStore.js`: `mint` stores `paid`, `consumeAtStake` and `consume` return it (5.5); `server/index.js:583`
   passes `paid: worth`. `server/db.js:270`: `reason` added to `claimDuePayout`'s `RETURNING` list; `drainPayouts`
   (`:1983`) skips `recordEarnings` for a reason beginning `refund` (5.5). No existing test covers `drainPayouts`, so
   that part is accepted by code review plus `npm test` green; the KO and Battleship reason strings are not touched.
`db.recordStake(` still appears exactly once (`test/v2route.test.js:158-171`): Paper goes through `recordEntry`.

---

## 7. Wire format (`paperWire.js`, the SAME module encodes on the server and decodes in the browser)

### 7.1 Volatile frame `pp:s` (little-endian). STATE only, never a delta: a dropped frame costs 33 ms of staleness.
```
header 12 B   u8 version=1 | u8 hflags (bit0 shrinking, bit1 paid) | u32 tick | u16 radius*32 | u16 targetRadius*32 | u8 nUnits | u8 nPickups
unit   24 B   u16 id | u16 x*32 | u16 y*32 | u16 dir | u8 flags (bit0 bot, bit1 holding, bit2 pushed this tick) | u8 hold (floor(holdTicks*255/HOLD_TICKS), 255 exactly at HOLD_TICKS)
              | u8 ack (seq of the last pp:in applied; bots 0) | u8 trailEpoch | u16 pct*65535 (pct clamped to [0, 1] first) | u16 inId (0 none, own id = home, else that base's owner)
              | u16 baseVer | u16 trailCount | u32 moneyMicro (saturates; exact value rides ['m'])
       + tail u8 tailN (<= TRAIL_TAIL_MAX) | tailN x (u16 x*32, u16 y*32)      wire-trail corners committed since the last reliable batch
pickup 10 B   u16 pid | u16 x*32 | u16 y*32 | u32 micro
```
Frame size = `12 + nUnits * (25 + 4 * tailN) + 10 * nPickups` bytes: 412 B with 16 units and empty tails, 668 + 10P B
with every unit at `TRAIL_TAIL_MAX` (the format maximum), and in play a human at the turn cap commits at most 2 wire
corners per 6-tick batch window plus one per wall touch, so about 604 + 10P (about 18 KB/s per client at 30 Hz). ONE
encode per arena per frame through `io.to(ioRoom).volatile.emit` (an arena, diameter 1900, fits one 2000-unit interest
cell). `unit.direction` is unbounded radians (`paperGameMoves.js:63`): wrap before quantising. `pct` is `base.square /
game.square` clamped to `[0, 1]` before scaling (untrimmed or blocked land can make it exceed 1 while `game.square`
shrinks; `setUint16` would wrap 1.2 to 0.2); the same clamp applies to the `pct` number in `['b']` and `pp:joined`. The
time base is the TICK (`tick * STEP_MS`), which is sim time and therefore smooth even when the server runs two steps in
one wake. Money and hold progress are absolute in every frame, so a label can never drift from the bank for longer than
one delivered frame. `ack` advances by exactly one `seq` per server tick while the input FIFO has entries (4.4), so the
client reads the two fields it already has: between two frames `Δack < Δtick` means the server starved (an empty FIFO
repeated the last input) and `Δack > Δtick` means it dropped (overflow); no extra flag bit is needed (8.2).

### 7.2 Reliable bundle `pp:ev.ev` entries (arrays, first element is the type)
`['j', { id, name, skin, bot, micro, x, y }]` joined (no ring: the client builds the unit with the synthesised spawn
circle, 8.3, and the first `['b']` replaces it); `['k', victimId, killerId|0, reason, micro, pickupId|0]` gone (reason 7 =
cashed out, 8 = disconnect grace expired); `['m', id, micro]` money now; `['p+', pid, x, y, micro]`; `['p-', pid, byId,
micro]` (`byId` 0 = swept to the house, 5.3: the coin goes with no floater); `['b', id, ver, pct, ArrayBuffer]` base ring;
`['t', id, epoch, from, ArrayBuffer]` trail corners; `['cap', id, gainPct]` (drives the stock "+x.xx%" label on the
owner's client); `['mv', id, x, y]` reseated, snap instead of smoothing. Ring and trail blobs are `u16 count` then `count
x (u16 x*32, u16 y*32)`.

**Every entry is idempotent on the client** (a join or resume flush, a `pp:geo` reply and a bundle can overlap): `['j']`
for a known id updates its fields and never creates a second unit (the local player in particular is never rebuilt, so
`player` always is the unit in `units`); `['k']` and `['p-']` for an unknown id are ignored (an unknown `['k']` would
otherwise reach `spawnDeathParticles`, which reads `deadUnit.schemes`, `paperUnits.js:132-137`, and throw inside
`update`, which the unchanged `loop` does not catch); `['b']` with `ver` not newer than the held version and `['t']`
with `(epoch, from)` not newer than what is held are ignored; `['p+']` is keyed by `pid` and replaces; `['m']` and
`['mv']` are absolute. The mirror applies every event through this lookup (8.1).

### 7.3 Bases
`base.wireVer` bumps on: a fresh base (spawn of a human or a bot: it has no last-sent version, so it counts as a bump
and its ring is encoded in the same post pass, subject to the budget), own return (`handleReturn` override), being
carved (post pass compares `base.square` and `polygon.segments.length` with the last sent values; `polygon.insert` adds
collinear vertices that need no send, `paperGeom.js:680-690`), a trim that DROPPED a lobe, a reseat, and SHRINK END
(every base flagged `_wallTouched`, below). On a bump the ring is decimated ONCE (streaming perpendicular filter at
`RING_TOL`), encoded, cached by the NEW version and attached to that tick's bundle; at most `RING_ENCODES_PER_TICK`, the
rest wait a tick (versions coalesce). Join payloads and `pp:geo` reuse the cache. Rings of 450 to 1851 vertices (probe)
come down to a few hundred. Percent is sent as a number because a decimated ring cannot reproduce it. A PLAIN trim (one
piece, only wall arcs replaced) bumps nothing: the client clamps (8.4). When the applied radius stops falling or starts
growing (9.1), `base.wireVer++` for every base flagged `_wallTouched` during the shrink, then the flag is cleared; the
normal bump path does the rest, so a cached encode is NEVER served for a ring the server has trimmed since it was made
(a re-send without a bump would be a cache hit shipping the pre-trim encode, and the client's idempotence rule would
ignore it anyway). This removes any drift between server ring and client clamp, including land a blocked trim left
outside that growth makes reachable again; no `_wallTouched` base is re-sent twice for one shrink.

### 7.4 Trails
Per away unit the server keeps a WIRE polyline fed in the post pass by a streaming O(1) decimator: commit the previous
raw point when the newest deviates more than `TRAIL_TOL` from the line (last corner, current candidate), or lies more
than `TRAIL_MAX_GAP` past it. Corners are append-only, so an index is stable. `epoch` bumps and `trailCount` zeroes on
every reset (return, death, `recoverTail`, reseat, `rewindTrail` 4.4). Every `TRAIL_BATCH_TICKS` the bundle carries `['t', id, epoch, from,
pts]` for units with new corners; corners newer than the last batch ride the volatile frame as the tail, replaced
wholesale each frame, so new corners arrive with the position (no lag) and a dropped frame loses nothing. The client
draws reliable corners + tail + the unit's interpolated position; `strokeTrack` strokes only `track.polyline.path`
(`paperRender.js:45-50`), so the live head point is what keeps the trail attached to the square.

### 7.5 Resync
The client compares `baseVer`, `trailEpoch`, `trailCount` and `from` with what it holds; a mismatch older than
`RESYNC_AFTER_MS` sends `pp:need { id }`. This is the safety net, not the normal path.

---

## 8. Client

### 8.1 Mirror game (`paperMirror.js`)
`ClientArenaGame extends P.Game`, built like `createGameApi.create` (`paperMain.js:77-103`, the eleven-argument call at
`:96`) with the real view, a real `P.InputController`, its own `SpatialGrid`, `MP.guardedBorder(center,
config.borderPoints, radius)` (4.3, no `space`; updated through `setRadius` whenever the frame radius moves a
`RADIUS_QUANTUM`, 8.4) and, as the tenth argument, `new P.ScoreSchemeManager(P.PercentScoreScheme)` built by the arena
boot exactly as `paperMain.js:225` does (the manager is built outside the four helpers the boot reuses, so it must be
built here). `visible = true`, `cycle = config.prepareCounter`
so `loop()` takes the visible branch (`paperGame.js:690,702-713`), `renderer = (g) => { P.renderGameFrame(g);
hud.draw(g); }`. `player` = the local mirror unit, so the HUD gate, camera focus, follow-killer glide and `isPlayer` all
work as in solo (`paperRender.js:629-635`, `paperGame.js:566-581,680-682`). The page has its own boot file because
`createGameApi` hardcodes `new P.Game` (`paperMain.js:86`); it reuses `registerLanguages`, `pickDefaultLanguage`,
`hudPreloadText`, `whenFontsReady` (`paperMain.js:489-495`).

`MirrorUnit extends P.GameUnit`. Its ctor calls `super(game, name, position, ringPoints, undefined,
game.schemesManager)` so `unit.schemes` exists (`paperUnits.js:365`; the renderer reads `schemes.scores()` and `print()`
unconditionally for the top five and the player, `paperRender.js:436,459,466,537,549`, and `spawnDeathParticles` reads
it too, `paperUnits.js:136`). The ctor commits a `TerritoryBase` (`paperUnits.js:348`), so it is built with the first
ring (`pp:joined.rings`, or the synthesised spawn circle for a `['j']`, 8.3; an empty ring would throw in `calcPath`,
`paperGeom.js:810`) and `this.base.remove()` is called at once: commit and remove are balanced and the polygon object
keeps working (`paperGeom.js:669-672`). After that geometry is REAL but NEVER committed: `setRing(points)` = `new
P.Polygon(points); calcPath()`; `setTrail(points)` builds a fresh `P.Polyline` per trail reset and, per point, mirrors
`addDistinct` minus `.commit` (set `start`/`end`, push `new P.Segment(prev, p)`, call the public non-committing
`polyline.updateBounds(p)`, `paperGeom.js:584`, and `path.moveTo/lineTo`), so `boundsInView` (`paperGame.js:590-592`) and
`strokeTrack` (`paperRender.js:45-50`) work (`Polyline.addDistinct` itself commits, `paperGeom.js:594-612`, so it is not
used). **Field contract** for the unchanged renderer: the wire skin NAME is resolved with the page's real `SkinManager`
(`skinManager.get(name)`, `paperSkins.js:465`) and `unit.setSkin(skin)` on `pp:joined` units and `['j']`, released on
`['k']` and leave (the renderer reads `unit.skin.container` before the HUD, `paperRender.js:283`); `unit.percent` is set
from the frame (`u16 / 65535`) or the `['b']` value BEFORE the stock scale/sort lines of the cosmetic tick; whenever a
unit's decoded percent differs from the stored one, a unit joins, or a unit is dropped, the stock `unit.onScoreChanged()`
is called (it carries the index <= 5 or `isPlayer` rule and sets `game.topListChanged`, `paperUnits.js:382-384`, which
is the only thing that makes the cached leaderboard redraw, `paperRender.js:501-502`; `topListChanged` starts false,
`paperGame.js:56`, and nothing else in the mirror sets it). `in` is resolved from `inId` to the owning mirror's `base`
so `renderTracks` and the minimap "invaded" test keep working (`paperRender.js:307,410-412`); `target` is 8.3's. The
local unit overrides `get isPlayer() { return true; }` so stock "Kill" and "+x.xx%" labels appear
(`paperUnits.js:306-329`). On `['k']` the mirror calls `P.spawnDeathParticles` with the victim's real segment arrays as
`kill` does (`paperGame.js:354-355`) and, when the killer is a mirror unit, `killer.schemes.kill(victim, reason)` and
`killer.statistics.kills++` (`paperGame.js:364-365`, what `drawKillsCounter` reads), all BEFORE dropping the victim
(the scheme label reads `victim.skin.colors.main`, `paperUnits.js:309`); then `victim.onScoreChanged()` and
`killer.onScoreChanged()`. On `['cap', id, gainPct]` it calls `unit.schemes.comeback({ increment })` with `increment` in
the fraction units `comeback` multiplies by 100 (`paperUnits.js:319-320`), never a hand-written label. For the local
unit a `['k']` sets `killer` and keeps `player` for the stock follow-killer delay before the death screen. Every event
is applied through the idempotent lookup of 7.2.

`update(dt)` (called by the unchanged `loop`): run predictor ticks (8.2); advance `renderTick`; apply due timeline
events; interpolate remotes; then the cosmetic subset of the stock tick: `unit.scale` from percent (`paperGame.js:421`),
sort by percent and set `top` (`:445-448`), labels and particles (`:449-453`), camera scale ease (`:523-525`), crumbs for
units inside an enemy base (`paperGameMoves.js:375-377`), `cycle++`. It never calls `getRenderContext()` a second time:
that call advances the follow-killer glide (`paperGame.js:576-582`).

### 8.2 Own square: predictor and reconciliation (`paperPredict.js`, pure)
```
step(state{x, y, dir}, angleByte, locked, dtMs, border, config, ownTrail?) -> state
  border.resetGuard()                                                               // EVERY step, incl. the remainder scratch step below
  scratch = { position, direction, target: locked ? null : pos + rot(angle * PI / 127) * 50, movement() }
  if outside the wall: prepend the push piece with the candidate rule of 9.3, tested against ownTrail when the mirror
     has one (else the first candidate), and evaluate the rest from the push target, exactly as the server does
  pieces  = P.Game.prototype.getMovement.call({ config, border }, dtMs, scratch)     // stock code, stock wall slide
```
`getMovement` reads only `config.unitSpeed`, the unit and `border` (`paperGameMoves.js:49-102`). The border is the
mirror's `MP.guardedBorder` (4.3): the same cap and the same `resetGuard()` before every step as the server, so on the
exact-vertex phase (a reconcile installs the wire-quantised `y = 1000.0` exactly, and angle byte 0 keeps it there) the
server and the predictor take the same escape on the same input instead of the tab freezing, and after the push both
are `wallInside` (a unit parked exactly on the vertex counts as inside by 9.2's boundary rule). An accumulator runs
predicted ticks at `STEP_MS + PREDICT_DT_BIAS_MS` (the server's per-tick dt is `STEP_MS + rng() * 0.01`, `paperGame.js:406`,
whose one-sided mean would otherwise accumulate 0.25 u per 600 ticks on a straight run), at most
`MAX_PREDICT_TICKS_PER_FRAME` per frame. Each tick: stock `readInput` and the stock quantise (`paperGame.js:409`), push
`{ seq, angle, hold, stateAfter }` into the `INPUT_BUFFER` ring (keyed by `seq`), send `pp:in` (EVERY tick, 6.2). The
rendered position is `step(last, angle, locked, remainderMs)` on a scratch copy, so a 144 Hz screen is as smooth as solo
with zero added latency.

Reconciliation, on every frame: take own `ack`. It is a MISS when no ring entry has that `seq` (`u8 seq` wraps at 256 and
the ring holds 64, so the test is `buffer[ack & 63].seq !== ack`, never a bare index: a bare index would alias a live
entry 64, 128 or 192 seqs away and replay up to 255 aliased slots); a miss (RTT over a second, a tab stall) is a snap:
state = server state, ring cleared, visual offset cleared, prediction continues from there and the next in-ring ack
resumes the normal path. Otherwise, if `|server - buffer[ack].stateAfter|` is under the two EPS values do nothing; else
set state = server state, replay `ack + 1 .. now` (each ring entry's stored `hold` is used as `locked` in the replay, so
replayed positions match the server's held position), and hide the jump with `visualOffset = oldRendered -
newPredicted` decayed over `VISUAL_DECAY_MS` (the snake's gentle correction, `public/js/game.js:470-542`). With the server
FIFO (4.4) the compare is EXACT whenever `Δack == Δtick` since the last compare: the server applied exactly the
inputs the client predicted, one per tick, in order; a starve (`Δack < Δtick`) or a drop (`Δack > Δtick`) is a REAL
one-step divergence that produces exactly one re-base of one tick of travel (1.5 u), hidden by the visual offset, after
which agreement is exact again. The server's dt jitter never trips the EPS: the biased predictor stays within 0.02 u
(probe over 3600 ticks) and the stacked u16 rounding is 0.044 u, both under `RECONCILE_POS_EPS`. Snap when the error
exceeds `SNAP_DIST` or a `['mv']` names us. Q down sets the hold bit and the predictor stops at once (`target = null`,
the exact server mechanism), so prediction and server agree by construction; the local lock's release rules are in
8.6. On `pp:joined` (first join or `resumed: true`) the predictor resets fully: state from `you`, ring cleared, `seq`
restarts at 0 (the server resets its last-applied seq on a resume, 5.7). NEVER predicted: kills, captures, land, money,
other squares. Own trail = reliable corners (applied on receipt) + tail + predicted positions newer than the ack tick
where `me.base.polygon.inside(pos)` is false + the rendered position. Predicted home while the server still says away
keeps the trail drawn until a new own ring version arrives or 500 ms pass.

### 8.3 Other squares and the event timeline (`paperNet.js`)
The snake client's recipe: clock offset EMA, `renderTick = serverTick - (INTERP_DELAY_MS + jitterBuf) / STEP_MS`,
adaptive jitter buffer to `MAX_JITTER_BUF_MS`, `DEAD_RECKON_MS` cap along the heading at 90 u/s, full reset on
`pp:joined` (`public/js/game.js:361-428`). Position lerps, heading takes the shortest arc. Mirror `unit.target` = position
+ heading x 50 (the renderer reads it). Reliable events carry the server tick and are applied when `renderTick`
reaches it, so land never appears before the square that captured it gets home; events naming the local unit apply on
receipt. On `['j']` the mirror builds the `MirrorUnit` with a synthesised spawn circle,
`P.makeCirclePoints(new P.Vec2(x, y), config.baseCount, config.baseRadius)` (the exact call `spawnBot` and the reseat
use, `paperGame.js:216`, 9.6, so it IS the server's ring), and the first `['b']` for that id replaces it through
`setRing`; `pp:joined.rings` still covers the local unit and the units already present.

### 8.4 Ring clamp
When the frame radius falls by a quantum, every stored ring whose bounds reach beyond it has the vertices outside
moved radially onto `radius` (destructive) and its path rebuilt. That draws the same picture as the server's arc
replacement (difference under 0.06 u, the sagitta of a 19.9 u wall edge), so a shrink sends no rings. The rings in
`pp:joined` are clamped to the payload's OWN `radius` on receipt (exact: same server state; it closes the window of a
join built mid-shrink, up to 125 ms before the next falling quantum would clamp them). Bundle and `pp:geo` rings are
NOT clamped on receipt (a bundle ring is at most one quantum stale, and the newest frame runs up to `INTERP_DELAY_MS`
ahead of the render-time border); the falling-quantum clamp covers them. The mirror border is `MP.guardedBorder`,
updated with `setRadius` from the frame radius with `mirror.square` recomputed, whenever it moves `RADIUS_QUANTUM`.

### 8.5 Page and shell
`/paper-arena` loads `/js/posthog-init.js` FIRST (a classic external script, as `public/game.html:5` and
`public/agar.html:5` do; `test/inlineScripts.test.js:33-34` skips `src=` scripts), then `/socket.io/socket.io.js`, the ten
solo scripts in `paper.html` order (`public/paper.html:52-61`; `paperMain.js` only exports, the solo page's inline script
is what boots solo), then the six `mp/` files. Classic scripts only (`test/inlineScripts.test.js:36-43`). Head: `<meta
charset>`, the viewport meta the other framed pages use (`public/shooter.html:5`; inert inside the lobby iframe, kept for
a top-level load), the PT Sans Caption preload and stylesheet (`public/paper.html:9-10`: the HUD draws with the same
font), then `css/paper-arena.css`, whose first three rules are `public/paper.html:13-15` unchanged (body background and
font; the `html, body, canvas` reset with `overflow: hidden` and `height: 100%`; `#view { position: absolute; width:
100%; height: 100%; z-index: 1 }`), because the sim sizes the canvas from `view.clientWidth/clientHeight`
(`paperGame.js:551-557`) and steers from its centre (`paperGameMoves.js:43`), which `paperMain.js:424-425` leaves to CSS on
purpose; without them the canvas is 300 x 150 on every device. The DOM screens reuse the `.paper-layer` recipe
(`paper.html:17-23`, including `touch-action: manipulation`) under a `.pp-layer` class; no inline `<style>` block and no
verbatim copy of `paper.html`'s solo-only screen selectors. Reads `playerName`, `stake`, `entryToken`, `walletAddress`,
`region` from sessionStorage ONCE, sends `pp:join` once, then `sessionStorage.removeItem('entryToken')`; keeps the
`resumeKey` from `pp:joined` in memory and, on every socket `connect` after the first, sends `pp:join { name, stake,
resumeKey }` (5.7) behind a "Reconnecting..." overlay. Analytics: on `pp:joined` (not on a resume) `if (window.phEvent)
window.phEvent('game_started', { game: 'paper', stake })` UNCONDITIONALLY (the lobby's own `game_started` at
`public/js/v2/play.js:291,303` never fires because `v2.html` does not load `posthog-init.js`; if that is fixed later
under the parked 2026-09-22 analytics plan, dedupe then, not now); on `pp:cashedout` `phEvent('cashed_out', { game:
'paper', amount: netMicro / 1e6, stake })`. NEVER `phIdentify(wallet)` (a raw wallet as `distinct_id` is the flagged
privacy landmine). Money analytics stays server-side through `trackEarning` -> `house_earning` (5.5); the client events
are funnel and display only. `window.focus()` on load and on first pointer down (a held key needs focus). Exit:
`window.parent.postMessage('game:done', '*')` with a non-framed fallback (`public/js/shooter.js:1085-1089`; lobby handler
`public/js/v2/play.js:427-433`). Screens (DOM): warming (auto retry), refused (reason, "refunded" when true; `expired`
after a failed reconnect), dead ("You lost $0.20", Play again: free sends `pp:respawn`; paid posts `{ type:
'duel:restake', game: 'paper', stake }` and sends `pp:respawn` with the token from `duel:restake:done`), cashed out
(gross, 10 percent fee, you receive; then the tx link on `pp:paid` or the delay message on `pp:payerror`), disconnected
(after `pp:refused 'expired'`, `pp:replaced`, or a socket that never comes back: "Your money dropped where you stood" /
"This seat was taken over by a newer connection"). Every end screen (dead, cashed out, refused, disconnected) carries
the ONLY "Back to the lobby" control: it emits `pp:leave` then `game:done`, as `shooter.js leave()` does.

### 8.6 HUD (`paperHud.js`, one pass AFTER `renderGameFrame`, world transform rebuilt from `game.origin` and `game.scale`
with the maths of `paperRender.js:599-604`)
- Money over every head: `'$' + (micro / 1e6).toFixed(2)` one line above the stock name (`drawUnitName`,
  `paperRender.js:141-168`), same font and shadow recipe, gold fill, hidden at 0 (so the free arena shows none). A 300 ms
  count-up on `['m']` and a `+$0.10` floater on a kill or coin.
- Coins: a disc with its amount, gentle bob, above land and below squares; a dot on the minimap.
- Cash-out ring: an arc around any unit with the holding flag, filled to `hold / 255` (server clock). The local lock
  (the predictor's `locked` and the HUD ring) is set at keydown / pointerdown for responsiveness and held while the hold
  bit is set. It is cleared ONLY by (a) keyup, blur, visibilitychange, pointerup / pointercancel / pointerleave clearing
  the bit (brief rule 3: releasing Q cancels at once), or (b) a frame whose own `ack` (7.1) is at or past the `seq` of
  the first `pp:in` that carried the hold bit (compare modulo 256) and whose `flags` bit1 (holding) is clear; from that
  frame on the local lock and ring follow the frame's holding flag and hold byte exactly ("re-synced to the frame
  byte"; this also covers the server dropping the hold through `HOLD_INPUT_STALE_MS` while the key is still down).
  NEVER a client-side wall-clock timeout: while the key is down and no such frame has arrived, the predictor stays
  stopped and the ring shows a "waiting for server" state (confirmation needs keydown -> next predicted tick -> uplink
  -> server tick -> next snapshot tick -> downlink, so any RTT above roughly 250 ms would trip a 300 ms timer with zero
  loss and the square would walk off while Q is held; the server's `HOLD_INPUT_STALE_MS` is the only timeout, as in the
  snake, `public/js/game.js:1699-1712`). Centre line "Cashing out 2.1 s, release to cancel".
- Q: keydown (ignoring `repeat`, only when `evt.target === document.body`, the rule `paperInput.js:87-97` follows) sets the
  hold bit; keyup, window `blur` and `visibilitychange` clear it.
- Touch: a 72 px DOM button `#pp-cash`, bottom LEFT (the minimap owns bottom right, `paperRender.js:401`), shown on
  `(pointer: coarse)` or the first `touchstart`, `touch-action: none`, `pointerdown` sets the bit, `pointerup /
  pointercancel / pointerleave` clear it, SVG ring for progress. It is outside the canvas, so it never steers
  (`paperInput.js:49-58` listens on the canvas only). Desktop shows a small "Hold Q to cash out" hint.
- No leave control during live play, in every arena: the live HUD stays identical to solo (brief), and the shooter
  removed its Leave button because it "sat one mis-tap from ending a run with coins on the floor"
  (`public/js/shooter.js:1090-1094`); every other game exposes Lobby only on end screens. "Back to the lobby" lives on
  the end screens of 8.5 only.

---

## 9. Arena radius, push, trim

### 9.1 Target and easing (`ArenaGame.stepRadius`)
`radiusFor(n) = clamp(950 * sqrt(n / 16), 475, 950)`, pure, in `paperWire.js`. Paid: `n` = squares alive. Free: fixed 950
(bots keep it full, so bots never meet a moving wall). Target above current: grow at `GROW_RATE` at once. Target below:
only after it has been lower for `SHRINK_DELAY_MS`, then `SHRINK_RATE`. The APPLIED radius moves in `RADIUS_QUANTUM` steps:
`border.setRadius(r); game.square = border.polygon.square();`. On a shrink quantum: every base whose bounds reach beyond
the wall is flagged `_trimDirty` and `_wallTouched`; coins are clamped (5.3). When the applied radius stops falling or
starts growing, every `_wallTouched` base gets `wireVer++` and the flag is cleared (7.3).

### 9.2 O(1) wall test (`MP.wallInside`)
`makeCirclePoints` starts at angle 0 and steps `2PI / 300` (`paperGeom.js:883-897`), so wall edge `k` spans angles `[k, k+1]
* 2PI / 300`. `d = |p - c|`: `d <= apothem` inside; `d > radius` outside; else `k = floor(atan2 / step)` and one half-plane
test against edge `k` (the wall is convex, so this is exact). Tolerance 1e-6 counts as inside.

### 9.3 Push (inside `getMovement`) and the push-piece veto
Only when `!wallInside(unit.position)`, which in a static arena never happens (stock sliders sit ON the wall, so
reference behaviour is untouched). The push target is `MP.pushPoint(...)` = the point at `apothem - PUSH_INSET` on the
radial through the unit, rotated by a twist. **Candidate rule:** the twist is tried in the order `PUSH_TWIST_CANDIDATES`
(`+PUSH_TWIST`, `-PUSH_TWIST`, `+2 * PUSH_TWIST`; never 0, section 2); each candidate piece `new P.Segment(unit.position,
target)` is tested with `this.space.intersections(candidate)` filtered to `hit.segment.shape === unit.track.polyline &&
hit.point !== unit.track.polyline.end` (there is no `Polyline.intersections`; hits come from the grid or
`Segment.intersect`); the first candidate with no such hit is used. The unit is ALWAYS pushed this tick (it must be
inside after it; a skipped push would leave it outside a convex wall where the stock clip cannot act,
`paperGameMoves.js:70-99` only clips a piece that crosses the wall from inside, and it would walk 1.5 u outward per
tick): if all three cross, push with `+PUSH_TWIST` anyway and `stats.pushCrossings++`. `unit._pushPiece = piece`; the
push is the first piece and the rest comes from `super.getMovement` evaluated from `target` (set `unit.position`
temporarily, restore). It runs through the normal crossing dispatch, so `in` flags, own-base crossings and trail cuts
stay consistent (probe: zero overshoot 950 to 800). It applies to a locked (holding) square too.

**The veto is scoped to the push piece, not timed.** `dispatchBucket` marks `unit._inPush` while it dispatches the push
piece (4.4), and `kill` vetoes reason 2 ONLY then, followed by `rewindTrail` so the trail stays simple (a vetoed
`handleIntersect` has already moved the unit to the hit point, `paperTerritory.js:232`, and `handleUnitMovements` would
still append the move end, `paperGameMoves.js:370-374`: without the rewind the polyline crosses itself and every later
return and trim works on a non-simple ring). A naive radial push KILLS a wall-hugging square through the stock
self-cross rule as reason 2 (`paperTerritory.js:225-238`; probe: death on the first shrink step), and a timed per-unit
veto would have been continuous during any shrink (quanta every 125 ms), sparing a genuine self-cross within 5 u of the
wall and leaving a self-crossing trail on every push. With the candidate rule the push never crosses the trail, so the
veto fires only in the `pushCrossings` fallback; reason 2 on any STOCK piece kills exactly as solo does (pressing into a
static wall, an overlay U-turn along the wall), and a self-cross away from the wall (reason 1) is never vetoed. A
pushed square that crosses another player's trail still kills that player and the pushed player takes the victim's
money: it counts as a kill by a player, not by the shrink (reference-consistent, a trail near the wall is cuttable), and
it is open question 7 in section 13 with this default. The predictor applies the same candidate rule against the mirror's own trail when it has one, else accepts the
reconcile snap (at most about 1.9 u sideways, once per quantum).

### 9.4 Trim plan (`arenaTrim.planTrim(base, border, anchor)`, pure, plain numbers, mutates NOTHING)
Returns `{ status: 'clean' | 'blocked' | 'invalid' | 'empty' | 'wall' | 'ok', keep?, droppedLobe? }`.
1. **Classify** each ring vertex `v_i = segments[i].start` with `wallInside`. None out: `clean`. An edge with both ends
   inside is inside (convex wall). An edge with both ends outside is treated as outside: ring and wall edges are at most
   19.9 u, so the ignored sliver is under 0.1 u deep.
2. **Crossings.** For each edge whose ends differ: analytic hit against the wall edges of the sectors between `k(P)` and
   `k(Q)` plus one each side; else brute force all 300; else 40 rounds of bisection on `wallInside` (a result is always
   produced). REUSE rules: if the inside end is within 1e-6 of the wall, the crossing IS that ring vertex object; if
   the crossing lies within `GEOM_EPSILON` (`2^-26`, `paperGeom.js:13`) of a wall vertex, the crossing IS the border
   polygon's OWN vertex object for it (the registered one, 4.3); every other crossing is a new `Vec2` that passes
   through `space.checkPoint` before commit (so a point already registered at that location is reused rather than
   duplicated). Record `{ ringIndex, kind: exit | enter, k, t }`. Exits and enters must alternate and be equal in
   number, else `invalid`.
3. **Walk (Weiler-Atherton, convex clip).** Sort crossings by wall position `(k, t)`. Walk direction =
   `sign(ring.rawSquare()) * sign(wall.rawSquare())` (same sign: increasing `k`; a unit test pins it against the analytic
   lens area). From each unvisited `enter`: follow inside ring vertices to the next `exit`; follow the wall to the next
   crossing, emitting the border polygon's OWN vertex objects for the wall vertices passed (never fresh copies); it MUST
   be an `enter`, else `invalid`; repeat until closed. Each loop is one connected piece of `base INTERSECT arena`.
4. **Choose** (the carve rule, `paperGameMoves.js:237-246`): owner home: the piece containing `unit.position`; owner away:
   the piece whose run holds the vertex OBJECT `unit.track.polyline.start`; else the largest. Tested with an uncommitted
   `new P.Polygon(pts).inside(anchor)`. More than one piece sets `droppedLobe`. This is what prevents a ring that doubles
   back along the wall.
5. **No piece:** if the centre is inside the ring (one base owns the whole disc) status `wall`: `keep` = the border
   polygon's 300 OWN vertex objects (in ring orientation), never fresh ones. Otherwise `empty`.
6. **Blocked** (let `D` = existing ring vertices NOT kept): (a) the owner is away and `track.polyline.start` is in `D`
   (return looks it up by identity, `paperGameMoves.js:163-164`, and would get -1); (b) any vertex in `D` has a committed
   segment whose `shape.owner.isTrack` (a live foreign trail crossing: deleting it mis-pairs a later carve,
   `paperGameMoves.js:257-311`). Both clear by themselves when that trail returns or dies.
7. **Validate** (`invalid`): at least 3 vertices; all finite and within `radius + 0.01`; area at least `TRIM_MIN_AREA`
   (else `empty`) and at most the old area + 1e-6 (a trim never grows land); `sign(rawSquare)` unchanged; no new edge
   longer than `TRIM_MAX_EDGE`; no zero-length edge.
8. **Plan:** `keep` in ring order, where every kept original vertex is the SAME `Vec2` object, every wall vertex is the
   border polygon's OWN vertex object (a ring holding border objects is the stock situation: the wall slide already
   hands them to trails, 4.3; the border is rebuilt every quantum, and `setRadius` reuses the registered object for any
   location already in the grid, so a ring that holds one never disagrees with a later border) and every other crossing
   is a `Vec2` that went through `space.checkPoint`. Two registered objects at one location would make the next slider
   past that corner throw in `unifyHitPoints` (`paperGameMoves.js:393-397`; probe: at tick 56 or 73 in all four
   direction and orientation combinations), and three thrown ticks would run `emergencyClose` on a paid arena.

### 9.5 Apply (`arenaTrim.applyTrim(game, base, plan)`, only from the post pass, after `_enter()`)
```
const old = ring.segments;
const fresh = pairs(plan.keep).map(([a, b]) => new P.Segment(a, b));
fresh.forEach(s => s.commit(ring));          // commit FIRST (the order stock left() uses, paperGeom.js:717-727)
old.forEach(s => s.remove());                // each old segment is committed and removed exactly once (paperGeom.js:390-397)
ring.segments = fresh;  base.calcSquare();  ring.calcPath();      // calcPath refreshes simplify and bounds (paperGeom.js:806-869)
if (plan.droppedLobe) base.wireVer++;
units with in === base and no longer inside get in = null      // what carve does for bystanders (paperGameMoves.js:250-254)
```
`ring.owner` is untouched, so `seg.shape.owner` stays the base. Later captures find ring segments by VERTEX identity
(`seg.start === cut.startPoint`, `paperGameMoves.js:211-216`, and `vertex.segments.filter(seg.start === vertex)`,
`:263-265`), which the kept `Vec2` objects preserve. `checkRing(base)` (tests and debug): closed, every segment committed
to this ring, no zero length, no repeated vertex object, no two registered points within `2^-26` of each other along
the ring, simple (no two non-adjacent segments intersect, no overlay), area sign unchanged, away owner's exit vertex
still a `.start`.

### 9.6 When, and the fallbacks (nobody dies, nobody loses money: money is in the bank, not the geometry)
- The trim module reaches `ArenaGame` by injection: `makeArena({ trim })`, where `trim` is `{ planTrim, applyTrim }` or
  null. Null means "never trim": the arena stays fully playable because the client clamp hides untrimmed land and
  percent carries no money. `PaperRoom` holds the one switch (`const TRIM_ON`), false until T14 passes.
- Runs only in the post pass, for bases flagged `_trimDirty` (every wall-reaching base on a shrink quantum; one base after
  its own return, because a trail laid before the shrink merges as land outside the wall: probe, 5367 of 6469 vertices).
  At most `TRIM_MAX_PER_TICK`. The flag stays set on `blocked` and `invalid`.
- F0 `blocked` / `invalid`: nothing was mutated; retry next tick. Untrimmed land outside the wall is unreachable,
  harmless to the sim, and hidden by the client clamp. After `TRIM_INVALID_LIMIT` invalids in a row: log `[PAPER] TRIM`
  with the ring and stop retrying that base until the next quantum or return.
- F1 `empty`, or the owner has had no ring vertex inside the wall for `RESEAT_AFTER_MS`: **reseat**. `track.remove()`,
  `base.remove()`, clear other units' `in` that pointed at it, `spot = findSpawn()`, a fresh spawn circle there
  (`P.makeCirclePoints(spot, baseCount, baseRadius)` as `spawnBot` does, `paperGame.js:216`), move the unit, `in = base`,
  `wireVer++`, trail epoch bump, `['mv']`. If `findSpawn` fails, retry every second. `findSpawn` guarantees no overlap
  with a neighbour, which the sim never allows. A base with no vertex inside the wall is wholly outside the new edge,
  so trimming all of it is brief rule 6 as written; the reseat is its consequence: not a death, no money moves, the
  trail is cleared because its start vertex is no longer on any ring (`handleReturn`'s identity lookup,
  `paperGameMoves.js:163-164`, would return -1), and the fresh circle is the ordinary spawn base every unit gets. The
  split case (a U cut into two inside pieces keeps the anchor's piece and drops the other, step 4) changes land percent
  only; it is listed as an open question in section 13 with this behaviour as the default.
- F2 exception inside apply (should be unreachable): caught, logged CRITICAL with the ring dump, immediate reseat; if
  that throws too the tick-failure path of 5.9 takes over.
- `findSpawn()`: up to `SPAWN_TRIES` of `getSpawnPosition('random', baseRadius)`; reject a point within
  `SPAWN_AXIS_GUARD` of either centre line, or farther from the centre than `radiusFor(max(N_BASE, nAfter -
  SPAWN_SAFE_LOOKAHEAD)) - SPAWN_SAFE_MARGIN`. Pure query.

---

## 10. Lobby wiring for Free, $0.10, $1.00 (one owner)

- `wallet-widget/src/main.jsx:217`: add `paper: '/paper-arena'` to `PAGES`. Today a paid Paper launch falls through to
  `/game.html` (`:219`) and the snake client would spend the token (tokens are not game-bound,
  `server/entryStore.js:46-55`). Then `npm run build` and COMMIT `public/wallet/widget.js` (the deploy does not build,
  `.github/workflows/deploy.yml:34-35`; tests check the bundle, `test/v2route.test.js:265-289`).
- `public/js/v2/play.js:274`: REMOVE `paper` from `OWN_PAGE`. All three rungs then take the widget path, where stake 0
  short-circuits to an empty token and the full hand-off (`stake`, `entryToken`, `walletAddress`, `region`) is freshly
  written on every launch (`wallet-widget/src/main.jsx:187-209`) and the frame is focused (`:225-228`). Nothing is lost:
  `launch()` already demands a connected wallet for every game (`play.js:258-262`). `knockout:` and `battleship:` stay
  (`test/v2route.test.js:1171-1189`); no forbidden string is added (`:215-220`).
- `public/v2.html:2165`: the row becomes `built:1, ladder:1, nolook:1`; `solo:1` and `soloNote` go; never `paid:1` or
  `duel:1`. Add `#detail.nolook .lookrow{display:none}` beside `:900` and the class toggle beside `:3179` (the snake
  colour picker would otherwise appear), plus a rules line "Kill a player, take their money. Hold Q for 3 seconds to
  cash out." with its own show rule. Keep the pinned detail markup order (`test/v2route.test.js:409-431`).
- `public/js/v2/board.js:127-130`: drop the pinned `paper:free` lobbyType row; pin the stake 0 row with one ADDED line.
  Do not touch the snake pin text or the `|| 0)` expression at `:50` (`test/v2route.test.js:806-822`, `:211`).
- `/api/live`: `boardRows()` returns `{ id: 'paper:na:s<rung>', game: 'paper', region, stake, players, bots, capacity: 16,
  state: 'open' }` summed over that rung's arenas: stake 0 ALWAYS, 0.10 and 1 when `PAID_ENABLED`. Free reports `bots =
  players > 0 ? live bots : 15` (what you will find, as the shooter does, `server/index.js:1396-1411`). Rows existing at
  all times is what lights the rung buttons (`public/js/v2/board.js:141-146`, `public/v2.html:2220-2223`).
- `test/v2route.test.js:1132-1137`: rewrite to `built:1`, `ladder:1`, not `solo:1`, not `soon:1`, not `duel:1`, not `paid:1`;
  add pins: `PAGES` maps `paper` in BOTH source and bundle; `OWN_PAGE` has no `paper`; index.js lists `game: 'paper'` rows.

---

## 11. Tests (`node:test`, flat in `test/`; the 470 existing tests stay green; stub `Math.random` where determinism matters)

| File | Proves |
|---|---|
| `paperWire.test.js` | `radiusFor` at n = 0, 4, 5, 8, 15, 16, 20 (475, 475, ..., 950, 950) and monotone; `wallInside` against brute force on 10,000 points; frame, ring, trail and input-integer round trips; money u32 exact and saturating; `pct` above 1 saturates to 65535, negative or NaN gives 0; direction wrap; trail decimator stays within `TRAIL_TOL`, is append-only, and turns a 5000-point wall crawl into under 200 corners; `guardedBorder` returns `[]` after `BORDER_GUARD_CALLS` calls and resets on `resetGuard`, `setRadius` rebuilds polygon and apothem, and with a `space` its vertex objects are the registered ones; the module loads standalone under `require` |
| `paperParityGate.test.js` | for each of the eleven solo files (section 1): read the bytes, normalise CRLF to LF (`core.autocrlf=true` gives CRLF working copies while the `bffe6d5` blobs are LF), compute git's blob id `sha1("blob <len>\0" + content)` and compare with the eleven ids recorded from `git ls-tree bffe6d5 -- <files>`, failing with the file name |
| `paperBank.test.js` | every op; closed-account idempotence; deposit after `withdraw` or `drop` of the same id succeeds; transfer to a closed account moves nothing; withdraw ceiling; `sweepPickup` deletes the coin, adds to `outMicro`, returns its source and is a no-op when gone; `onTransfer` receives one object with `kind` `kill` or `pickup`; integers only; **10,000 random ops (incl. sweeps) with `totalMicro() === inMicro - outMicro` after every one** |
| `paperPayout.test.js` (fake deps) | 100000 gives 90000 + 10000 and 300000 gives 270000 + 30000 in integers; `recordEarnings` only after `withdraw` resolves; a rejection gives `recordFailedPayout` with `e.broadcast` and ZERO further `withdraw` calls; two orders from rooms with the same label each pay one cash-out (both `withdraw` calls happen) and the same order object dispatched twice pays once and logs; a throwing `trackEarning` still yields exactly one `withdraw` call; refund of a 100000 token with `paid` 0.099 sends 99000, with `paid` 1.5 for a 1000000 token sends 1000000, with `paid` undefined sends the rung; refund never calls `recordEarnings` and its failure row reason begins with `refund`; refund logs before withdraw; `sweepFloor` calls `trackEarning` with source `paper_floor` and `sweepRake` once, never `recordEarnings`, and a duplicate `sweepId` records nothing and logs |
| `paperArenaGame.test.js` | two humans steer from their own bytes; `locked` gives displacement 0.000; two interleaved arenas keep separate grids (`space.count()`, `paperGeom.js:296-302`); exact-east heading from y = 1000 does not hang AND the unit is `wallInside` on the tick after the push; `unit.log` stays empty; free arena never exceeds 15 bots or 16 squares and no bot has `type === undefined`; after one tick with one live human at percent p, `game.level` equals `P.lerp(startBotLevel, 1, p)` within 1e-9, follows the strongest live human, and with zero live humans equals `noPlayerBotLevel`; with a human present and exactly one bot alive of type 1, the next `spawnBot` creates type 2 (row 0's second wish), not type 1 (row 2's); `spawnBot` inert at stake > 0; the magnet path: a human's long trail farther from the bot than `visionRange * aggro * 0.75` (so `isPlayerTrackInAggroRange` is false), one update gives `bot.fsm.state === 'attack'` with `bot.target` a vertex of the human's `track.simplified`, and a second update keeps `attack`; `onDeath` fires once per victim on a double-kill capture; reasons 3/4/5 carry a killer, 1/2/8 none; `findSpawn` is bounded and never on an axis; 70000 `addUnit` calls never hand out 0 or a live unit's id; an overlay self-cross along the wall within 5 u during a shrink kills with reason 2 (stock piece, not vetoed); a perpendicular wall-presser AND a tangential wall-slider (against `PUSH_TWIST`) each survive 1500 shrink ticks, are inside the wall at the end of EVERY tick, keep a simple trail (every segment against every non-adjacent segment with `Segment.intersect` yields no hit), `pushCrossings === 0`, and the slider's later return carves the analytic area; a `rewindTrail` in the all-candidates-cross fallback leaves a simple trail with `in` and the crossing log consistent |
| `paperRadius.test.js` | growth at once at 60 u/s; shrink only after 3000 ms then 4 u/s on a fake clock; 0.5 u quanta; `game.square` follows; a re-buy inside the delay cancels the shrink; shrink end bumps `wireVer` once on every `_wallTouched` base and clears the flag |
| `paperTrim.test.js` | clean base untouched; circle base straddling the wall equals the analytic lens area within 0.5 percent (pins orientation); kept `Vec2` identity preserved; wall vertices in `keep` ARE the border polygon's vertex objects (one lobe case and whole-disc case); grid point count balanced after apply; run wrapping ring index 0; concave U keeps the anchor's prong, sets `droppedLobe`, subtracts the dropped prong's area from `base.square` (via `calcSquare`) and queues no `['cap']`; whole-disc owner gives `wall`; away-owner exit vertex in `D` gives `blocked` and mutates nothing; foreign trail crossing gives `blocked`; `empty` for a base wholly outside; no output edge over 20 u; second call is `clean`; a capture AFTER a trim carves without throwing; after a trim (one lobe and whole-disc) an away unit slides along the trimmed wall run for 300 ticks in both directions with zero throws and shares vertex objects with the ring at every corner, then the arena grows back to the same radius and it repeats; `checkRing` (incl. simplicity and the `2^-26` rule) after every case; fuzz: 300 random blobs x random radii, zero throws |
| `paperArenaWire.test.js` | ring re-encoded once per version (cache hit on join); a fresh base is encoded in its first post pass; budget of 3 per tick defers the rest; epoch bumps on return and on `rewindTrail`; a client double fed frames with 8 dropped in a row plus the 10 Hz batches rebuilds the same trail (the double follows the 7.4 contract with T1's codecs, no T11 dependency); plain trim sends no ring, dropped lobe does; the ring re-sent at shrink end carries `ver + 1` and its encode differs from the cached one, and no `_wallTouched` base is re-sent twice for one shrink; a join built mid-shrink, clamped to the join payload's radius, matches the server ring within 0.06 u; frame is exactly 412 B for 16 units with empty tails and no pickups, exactly 668 + 10P B with every unit at `TRAIL_TAIL_MAX` and P pickups, and a 6-tick window fed from a real `ArenaGame` human held at the turn cap yields `tailN <= 2`; `pct` above 1 saturates |
| `paperRoomMoney.test.js` | join shows 100000; kill makes the killer 200000 and the victim 0 in the same tick; chain kill carries 300000; multi-victim capture pays once per victim (one `onTransfer` with `kind: 'kill'` per victim); self cross drops ONE coin at the death point; coin collected once, nearer wins, `onTransfer` called once with the dropper's wallet, `kind: 'pickup'` and `label === room.lobbyType`; a coin dropped at t is still collectable at t + 59 min and at t + 61 min is gone, `onSweep` fired exactly once with its micro and source, `['p-', pid, 0, micro]` queued, and `liveStakeTotal` dropped by it; the same on a frozen room through `sweepPickups(now)`; disconnect starts the grace: the hold is cleared at once, the square keeps moving on its last angle, it stays killable (a kill during the grace pays the killer), expiry after `DISCONNECT_GRACE_MS` drops a coin where the square then stands and frees the seat, and a resume inside the window keeps the account, land and unit with no deposit; coin pushed inward on a shrink, never deleted; `liveStakeTotal` equals live + floor after every step; `snakes` getter shape incl. a seat in grace; a join between ticks never receives an event older than its payload (kill on an odd tick, `addHuman` with a spy socket: the spy sees no `['k']`, `['p+']` or its own `['j']`, and the room saw one extra `pp:ev` with `tick = currentTick`); a square pushed in by a shrink quantum across another player's trail kills that player and the pushed player's account gains the victim's whole balance in the same tick (open question 7); a reseat calls `onDeath` zero times, fires no `onTransfer`, and leaves `bank.totalMicro()` unchanged; three thrown ticks call `onCashout` exactly once per live paid account with no `forced` field, a UUID `cashoutId` and `grossMicro` equal to each balance, every coin refunded once to its `srcWallet`, `bank.totalMicro()` is 0 afterwards, the room is `stopped`, and a fourth throw pays nothing; **5000 random ticks of joins, kills, coins, cash-outs, disconnects, graces, sweeps and shrinks with `assertConserved()` true every tick**; a free room never calls `onCashout` for payment; `[PAPER] IDLE` logged once when the last human leaves money behind |
| `paperRoomHold.test.js` | hold locks movement; clearing the bit restores steering; reads `P.MP.HOLD_TICKS` and asserts `HOLD_TICKS - 1` ticks pays nothing and `HOLD_TICKS` ticks calls `onCashout` exactly once with the account already closed and the unit gone (no value hardcoded); killed on the completing tick pays the KILLER; die mid-hold then respawn: the new life has no hold; input stale for 500 ms cancels; a disconnect mid-hold cancels it and a resume does not restore it; receipt reliable and single; constructing a room with a missing hook throws; a `removeHuman` that throws on the completing tick still calls `onCashout` exactly once with the account closed |
| `paperRoomBots.test.js` | THE ONE RULE: `botsAllowed` from the stake number, `addBot` null and `topUpBots` leaves 0 at stake > 0; bots hold no account and never trigger a hook |
| `paperArenas.test.js` | 17th human opens an overflow arena; a room with no spawn spot is skipped; overflow with floor money is not swept and is picked first; an overflow arena swept and re-created pays its first cash-out (the `onCashout` order has a fresh `cashoutId`); respawn after the overflow arena was swept seats in a live arena; a stopped preferred room is skipped; `seatByKey` finds a seat in grace and forgets it when freed; the 60 s sweep calls `sweepPickups` on a frozen room; rows: free always, paid only with `PAPER_PAID=1` |
| `paperSockets.test.js` | bad stake (`"abc"`, -1, 0.5), not-open, duplicate, maintenance and full are all decided with the consume spy at ZERO calls; maintenance and full consume the token once through the refund path and pay `entry.paid`, not the rung; a bad token at 0.10 is refused visibly and never seated; a paid human dies, then `pp:join` or `pp:respawn` re-sends the spent token: the consume spy shows a second call returning `ok: false`, reply `pp:refused 'Entry fee not verified'`, `addHuman` not called again, no refund, never seated; the wallet and worth on the record are the token's, and client `wallet`, `worth`, `micro` fields in `pp:join` (and `stake`/`worth`/`micro` in `pp:respawn`) change nothing about the deposit; respawn uses `socket._ppStake` even if the message names another stake; respawn with a stale `_ppRoom` consumes the token once and is seated in a listed arena, leaving the old io room; `addHuman` throwing triggers exactly one refund bounded by `paid`, and the arena has no unit for that socket and `units.length` is unchanged; reconnect in time (`pp:join` with the `resumeKey`, consume spy at zero, `pp:joined { resumed: true }`, same unit id and balance), reconnect too late (`pp:refused 'expired'`, nothing consumed), die during the grace then reconnect (`expired`), and two sockets on one seat (the newer gets `pp:joined`, the older gets `pp:replaced` and leaves the room); a wrong `resumeKey` is `expired` and never seats; `null`, a number and a string sent as the payload of `pp:join`, `pp:respawn`, `pp:need` and `pp:leave` are ignored without a throw and consume nothing |
| `paperPredict.test.js` | (a) bit-exact agreement (under 1e-9 u) with a server `ArenaHuman` over 600 fixed ticks against an `ArenaGame` whose `game.rng` is stubbed to return 0.5 for the per-tick draw (`STEP_MS + 0.5 * 0.01 === STEP_MS + 0.005` in doubles; NOT 0, which leaves a 0.005 ms per tick gap); (b) under `RECONCILE_POS_EPS` over 600 ticks against the unstubbed game; both scripts include at least one 200-tick straight run and a wall slide (pure random re-steering cancels the drift); the FIFO: a server `ArenaGame` fed the client's per-tick inputs with 0 to 2 ticks of IN-ORDER bunching over 600 ticks: zero jitter gives zero re-bases and exact agreement at every acked tick; with jitter every frame whose `ack` advanced by exactly the tick advance since the last compare agrees exactly, every starve or drop gives a mismatch of exactly one step once and agreement is exact again after one re-base, so re-bases <= starves + drops; the same run under the old "every 2nd tick, latest wins" rules is asserted to FAIL; replay after dropped inputs converges; replay through a held stretch uses the stored hold bit; an `ack` not in the ring snaps and the next in-ring ack resumes; lock gives zero displacement; with the bit set and no frames for 400 ms the displacement stays 0.000 and the hold bit is still sent, and a frame with `ack` past the hold seq and holding clear releases it; the exact-vertex sweep: start x over 1900.00..1901.49 in 0.01 steps at y = 1000 exactly, dir 0, angle byte 0, 120 ticks each, a counting wrapper asserting no step makes more than `BORDER_GUARD_CALLS + 1` `intersections` calls, the whole sweep under 1 s wall clock, every run ending `MP.wallInside` true; the same north from x = 1000; and the control: the same sweep against a plain `P.ArenaBorder` wrapped to throw after 5000 calls throws for at least one phase (x = 1900.37 is a known hanging phase), so the test is proven to reproduce the stock hang |
| `paperNet.test.js` (socket double) | clock offset EMA; `renderTick`; jitter buffer growth and decay; event timeline ordering; `pp:need` after `RESYNC_AFTER_MS`; a reconnect sends `pp:join` with the `resumeKey` and no token |
| `paperMirror.test.js` (view null, `visible` false) | applying the first bundle twice changes nothing; `['j']` for a known id never creates a second unit; `['k']` and `['p-']` for unknown ids are ignored; stale `['b']` and `['t']` are ignored; a `['j']` unit gets the synthesised spawn circle and the first `['b']` replaces it; `onScoreChanged` is called on a percent change |
| `paperSoak.test.js` | 16 wandering humans (one of them a wall hugger), scripted deaths driving 950 to 475 and back, trim ON: zero throws, zero deaths whose dispatched move was a push piece, zero units outside the wall after any tick, `pushCrossings === 0`, every trail polyline simple on every tick, `checkRing` (incl. simplicity) on every base every 60 ticks, bank conserved |
| `paperJoinSmoke.test.js` | real server on a random port (env as `test/joinSmoke.test.js:36-67`): free join gets `pp:joined` then `pp:s`; paid join with no token gets `pp:refused` with a reason; `/api/live` has the Paper rows; the hold is asserted "not early" only (`test/cashoutHold.test.js:103-116`); a spawn with `PAPER_DEV_TOKENS=1` plus a dummy `ESCROW_PRIVATE_KEY` exits non-zero naming the flag; with the flag and no key a POST without `signedTx` returns a token that seats a paid `pp:join` (consume spy path unchanged) |
| `entryStore.test.js` (edit, T9) | `mint` stores `paid` and `consumeAtStake` returns it; a token without `paid` returns `undefined` for it |
| `v2route.test.js` (edit) | section 10 |

Gates before any push (CI runs nothing, `.github/workflows/deploy.yml:30-35`): `npm test` green, `node --check` on every
changed file, `git diff --stat bffe6d5 -- ':(glob)public/js/paper/*.js' public/paper.html` prints nothing (section 1).
If and only if that diff is NOT empty (the 4.6 fallback), the golden parity and solo node tests in
`../paperio-reference/harness` by hand, 600/600 on both seeds, in the same commit that moves the pin.

---

## 12. Task breakdown (NO two tasks own the same file)

| Task | Files (exclusive) | Depends on | Measurable acceptance |
|---|---|---|---|
| T1 Wire and constants | `public/js/paper/mp/paperWire.js`, `test/paperWire.test.js`, `test/paperParityGate.test.js` | none | both test files pass; module loads under `require` (standalone, no `DuelPaperLib` at load time) and as a classic browser script; every section 2 constant exported from `MP`; `MP.guardedBorder` caps and resets; the parity gate test pins the eleven blob ids of `bffe6d5` |
| T2 Bank | `server/paper/PaperBank.js`, `test/paperBank.test.js` | none | test passes including the 10,000-op property test with sweeps; closed accounts are deleted; `onTransfer` takes one object; the file has zero `require` calls |
| T3 Payout | `server/paperPayout.js`, `test/paperPayout.test.js` | none | test passes; the file never references `socket.`, never calls `withdraw` twice for one order, has no `forced` path; a duplicate id logs; refunds are bounded by `paid`; failed refund rows begin with `refund`; `sweepFloor` records `paper_floor` and never earnings |
| T4 Sim | `server/paper/loadPaperLib.js`, `server/paper/ArenaGame.js`, `test/paperArenaGame.test.js`, `test/paperRadius.test.js` | T1 | both tests pass (incl. exact-east `wallInside` after the push, the level and spawn-row tests, the magnet-path attack test, the push and veto tests with trail simplicity, the id wrap test); `git diff --stat bffe6d5 -- ':(glob)public/js/paper/*.js' public/paper.html` prints nothing; steady tick with 16 squares under 0.2 ms on the dev PC |
| T5 Trim | `server/paper/arenaTrim.js`, `test/paperTrim.test.js` | T1 | test passes including the 300-blob fuzz with zero throws, the border-object sharing test (slide along a trimmed run, both directions, one lobe and whole-disc, then growth back) and `checkRing` simplicity; `planTrim` proven pure (ring deep-equal before and after) |
| T6 Wire builder | `server/paper/arenaWire.js`, `test/paperArenaWire.test.js` | T1, T4 | test passes; one frame encode for 16 squares under 0.1 ms; frame is exactly 412 B for 16 units with empty tails and no pickups and exactly 668 + 10P B at `TRAIL_TAIL_MAX`; a turn-cap human yields `tailN <= 2` per 6-tick window; shrink end re-sends carry `ver + 1` |
| T7 Room and directory | `server/paper/PaperRoom.js`, `server/paper/PaperArenas.js`, `test/paperRoomMoney.test.js`, `test/paperRoomHold.test.js`, `test/paperRoomBots.test.js`, `test/paperArenas.test.js` | T1, T2, T4, T6 (T5 behind a flag) | all four tests pass including the 5000-tick conservation run, the 59/61 minute sweep test (ticking and frozen), the grace tests (hold cancelled, keeps moving, killable, expiry coin, resume keeps the seat), the join-flush test, the reseat money test, the emergency-close 90/10 test, `HOLD_TICKS` from `P.MP`, the missing-hook throw and the throwing-`removeHuman` dispatch; a swept-and-recreated arena pays its first cash-out; a stopped preferred room is skipped; neither file requires `money`, `db` or `Wallet`; the `[PAPER] IDLE` line |
| T8 Socket handlers | `server/paperSockets.js`, `test/paperSockets.test.js` | T3 and T7 contracts (this document) | test passes; every refusal case shows the consume spy at zero calls; maintenance and full refunds pay `entry.paid`; the spent-token replay is refused with no refund; the reconnect path (in time, too late, die during grace, two sockets, wrong key) consumes no token; a stale `_ppRoom` respawn seats in a listed arena; a null or non-object payload to any handler is ignored without a throw |
| T9 Server wiring | EDIT `server/index.js`, `server/entryStore.js`, `server/db.js`, `test/entryStore.test.js`; NEW `test/paperJoinSmoke.test.js`; COMMIT `scripts/dev-local.js` | T3, T7, T8 | smoke test passes incl. the two `PAPER_DEV_TOKENS` checks; `npm test` fully green; `db.recordStake(` still appears once; `/api/live` shows 1 Paper row without `PAPER_PAID` and 3 with it; `sumLiveSelfCustodyStakes` includes live plus unswept floor money; `mint` carries `paid`; `claimDuePayout` returns `reason` and `drainPayouts` records no earnings for `refund` rows (code review); the room hooks incl. `onSweep` are functions at boot |
| T10 Predictor | `public/js/paper/mp/paperPredict.js`, `test/paperPredict.test.js` | T1, T4 | test passes: bit-exact over 600 ticks against the 0.5-stubbed rng and under `RECONCILE_POS_EPS` against the unstubbed game (both scripts with a 200-tick straight run and a wall slide); the FIFO jitter bounds incl. the asserted failure of the old rules; the exact-vertex sweeps (east and north, 150 phases, under 1 s, `wallInside` at the end) plus the control that proves the stock hang; the lock, stale-frame and ack-miss cases |
| T11 Client net and mirror | `public/js/paper/mp/paperNet.js`, `public/js/paper/mp/paperMirror.js`, `test/paperNet.test.js`, `test/paperMirror.test.js` | T1, T10 | both node tests pass (socket double and view null); both modules load under `require`; `renderGameFrame` and `paperRender.js` are unmodified. The browser checks moved to T12 |
| T12 Page and HUD | `public/paper-arena.html`, `public/css/paper-arena.css`, `public/js/paper/mp/paperArenaMain.js`, `public/js/paper/mp/paperHud.js` | T11, T9 (a server to run against) | `test/inlineScripts.test.js` still passes; `posthog-init.js` is the first script and both `phEvent` calls are present; canvas fills the frame at phone and desktop sizes (no 300 x 150 default); FREE ARENA in the browser against `duelseries-local`: renders with zero console errors for 5 minutes, own square within 2 u of the server position at 100 ms simulated latency, minimap and leaderboard populated with percentages changing within a second of a capture, "Kill" and "+x.xx%" labels and the kill counter on a local kill, the hold ring and all five screens (warming, refused, dead, cashed out, disconnected), a reconnect resumes the same square; PAID HUD against `duelseries-local` with `PAPER_DEV_TOKENS=1`, seeding sessionStorage by hand with the keys the widget writes (`playerName`, `walletAddress`, `stake`, `entryToken` from the POST, `region`; `wallet-widget/src/main.jsx:187-209`) and opening `/paper-arena` directly (a Privy login on localhost is not assumed): money label, coin, count-up and the cashed-out receipt; touch button does not steer on a phone viewport; `game:done` returns to the lobby only from an end screen (no live-play leave control); `entryToken` removed from sessionStorage after the single `pp:join`; the paid Play-again path through `duel:restake` stays a milestone (4) live check |
| T13 Lobby | EDIT `public/v2.html`, `public/js/v2/play.js`, `public/js/v2/board.js`, `wallet-widget/src/main.jsx`, rebuilt `public/wallet/widget.js`, `test/v2route.test.js` | T9 AND T12 (route, rows and the page); merges in the SAME push as T9 and T12, never before the page exists and never after paid is switched on (a push deploys, and a Free card opening a 404 `/paper-arena` while `OWN_PAGE` has lost `paper` would kill the working solo launch) | `v2route.test.js` passes; built bundle contains `paper-arena`; from the lobby, Free opens `/paper-arena` with `stake` = `0` in sessionStorage |
| T14 Soak and ship gate | `test/paperSoak.test.js` | T4, T5, T7 | soak test passes three runs in a row with different `Math.random` stubs (wall hugger included, push-piece deaths zero, no unit outside after any tick, `pushCrossings` zero, every trail and ring simple); then T7's trim flag is switched on (a one-line edit by T7's owner in `PaperRoom.js`; `PaperRoom.js` is NOT in T14's file list) |

Order: T1, T2, T3 in parallel. T4 and T5 next. T6, T10. T7. T8, T11. T12. Then T9 + T12 + T13 in ONE push (free only)
= milestone 1. T14. (T11 has only node tests when scheduled; its browser checks live in T12, where the page and the T9
server exist.) Milestones: (1) free arena playable end to end, and the golden parity run by hand once at this
milestone regardless of the diff; (2) `PAPER_PAID=1` plus `PAPER_DEV_TOKENS=1` on the dev PC through the
`duelseries-local` launch (`scripts/dev-local.js`): entry, kill transfer, coin, cash-out, receipt, reconnect grace;
(3) radius and trim on; (4) one real $0.10 round trip on the live server by the owner, then $1.00.

---

## 13. Decided by the owner (2026-09-23)

The four questions of the first draft were answered in `docs/paper-mp/OWNER-ANSWERS.md` (binding, like the brief) and
are folded into the sections named:

1. **Money left on the floor of an arena nobody visits: HOUSE REVENUE AFTER 1 HOUR.** A pickup nobody collects within
   `PICKUP_SWEEP_MS` (60 minutes on the server clock, measured from the moment it dropped) is swept to the house on
   the rake's own path: `bank.sweepPickup` takes it out of the arena total (5.1), `sweepFloor` records it as house
   income with source `paper_floor` and moves it to the revenue wallet (5.5), never as anybody's earnings; until then it
   waits on the map and counts as liability (5.8). The sweep survives an idle arena through the directory's 60 s timer
   (5.3, 6.1). Consequence of the rule: floor money is memory only until swept (a restart or deploy loses it, like every
   live stake, 5.9), and the `[PAPER] IDLE` line plus the stake rows are the record (4.7).
2. **A paid join refused at the door (maintenance, or all seats taken): AUTO-REFUND, once per buy-in, decided and
   executed by the server only.** Kept exactly as designed (5.6, 5.9), with one precision from the critics: a refund
   returns the amount that landed on-chain, capped at the rung (`entry.paid`, 5.5), so a refusal can never mint the
   verifier's 1 percent tolerance.
3. **Disconnect: 5 SECOND GRACE, the square keeps moving.** `DISCONNECT_GRACE_MS` (section 2); the grace timer, the
   reconnect path, the two-sockets rule, the hold cancelled at the disconnect and the exact moment the clock starts
   are in 5.7; the join-order hook is step 3r of 5.6; the client's resume is `pp:joined { resumed: true }` (6.3, 8.5).
4. **Cash-out hold: ALLOWED ANYWHERE**, exactly as designed (3 seconds, movement locked, release cancels; 5.4, 8.6).

### Still open (defaults chosen by the design; none blocks the build)

5. **An arena whose tick throws `EMERGENCY_FAIL_TICKS` times in a row is closed automatically and every live account is
   cashed out at the normal 90/10** (5.9: brief rules 3 and 5 to the letter, the house cut applies to every exit).
   Alternative: 100 percent, the house forgoing its cut on its own bug. The percentage is the owner's call.
6. **When the wall cuts your land into two pieces that both remain inside, you keep the piece you are standing in (or
   that your trail left from) and lose the other**, exactly as an enemy cut works today (9.4 step 4, 9.6). This changes
   land percent only; no money moves. OK?
7. **A square pushed in by the shrink that crosses another player's trail kills that player, and the pushed player takes
   the victim's money** (9.3). The pushed player did not steer into it, so rule 6 ("nobody dies from the shrink itself")
   could be read either way; the default treats it as a normal kill because a trail near the wall is cuttable in the
   reference too. Pinned in `paperRoomMoney.test.js`. Alternative: the victim's money drops as a pickup instead.

---

## 14. Critic revisions (2026-09-23)

Three adversarial critics (money-security, netcode-feasibility, parity-scope) attacked the first draft and independent
refuters checked every finding; the 41 that survived were applied here by one editor. Applied, one line each:

- **money-security/M2** (blocker): `cashoutId` is a fresh UUID minted in `PaperRoom`, never label plus counter; a
  `seen` hit logs a bug; `arenaId` is display only (5.4, 5.5, 6.1, tests).
- **netcode-feasibility/B1** (blocker): the border's vertex objects are the registered ones (`setRadius` through
  `space.checkPoint`), `planTrim` emits the border polygon's OWN objects for every wall vertex incl. the whole-disc
  case and snaps near-vertex crossings to them, `checkRing` gains the `2^-26` rule, slide-after-trim and wall-hugger
  soak tests (4.3, 9.4, 9.5, 11).
- **money-security/M1** (major): the token carries `paid`, join-refusal and seat-failed refunds are bounded by it,
  emergency amounts are not (bound stated in 5.9), `REFUND_HAIRCUT_DIV` idea dropped, KO/Battleship hole flagged for T9.
- **netcode-feasibility/M1** (major): `pp:in` every tick, per-human FIFO of `INPUT_QUEUE_MAX` popped one per tick,
  drop-oldest, ack semantics from the two existing fields, FIFO jitter tests incl. the asserted failure of the old rules.
- **netcode-feasibility/M2** (major): `PREDICT_DT_BIAS_MS`, `RECONCILE_POS_EPS` 0.5 u, T10 split into the 0.5-stubbed
  bit-exact bound and the unstubbed 0.5 u bound with a straight run and a wall slide in the script.
- **netcode-feasibility/M3** and **parity-scope/M2** (major, merged): `MP.guardedBorder` in `paperWire.js` shared by
  server and predictor, `resetGuard` before every step, exact-vertex sweeps with a counting wrapper and the stock-hang
  control, reworded guard reasons, `wallInside` asserted after the push.
- **netcode-feasibility/M5** (major): pending events flushed to the room before `socket.join` at every join or resume;
  client idempotence rules in 7.2; join-flush test in T7, `test/paperMirror.test.js` in T11.
- **netcode-feasibility/M7** and **parity-scope/M1** (major, merged): the push tries `PUSH_TWIST_CANDIDATES` and never
  crosses the own trail, the veto is scoped to the push piece via `dispatchBucket`, `rewindTrail` keeps the trail
  simple when the fallback fires, `PUSH_GRACE_MS` deleted, `pushCrossings` stat, simplicity asserted in tests and soak.
- **parity-scope/B1** (major): `forced` removed everywhere; the emergency close pays through the normal 90/10
  `payCashout`, logs and alerts; the percentage is open question 5 with 90/10 as the default.
- **parity-scope/M3** and **netcode-feasibility/m9** (major, merged): `BOT_LEVEL_SOURCE`, `config.botLevel` set per tick
  from the leading live human, effects on skill, type row and `trackFactor` stated, vision asymmetry stated, two
  tests that can fail.
- **parity-scope/M4** (major): the parity gate is `git diff --stat bffe6d5 -- ':(glob)public/js/paper/*.js'
  public/paper.html`, the eleven files are named, `test/paperParityGate.test.js` (T1) pins their blob ids with CRLF
  normalisation, the pin moves only with the recorded golden re-run, the golden runs by hand at milestone 1.
- **parity-scope/M6** (major): `PAPER_DEV_TOKENS` behind the escrow-key and production guards, Paper-scoped fake
  withdraw, `scripts/dev-local.js` committed by T9, smoke-test checks, T12 acceptance split into free and dev-token paid.
- **money-security/M3** (minor): `[PAPER] IDLE` log at the moment money becomes floor-only, `maintenance:check`
  sentence in 5.8; the sweep goes through `trackEarning` (now decided by the owner).
- **money-security/M4** (minor): the constructor asserts every hook, `completeCashout` dispatches in a `finally`,
  `payCashout` wraps bookkeeping and withdraws unconditionally, tests.
- **money-security/M5** (minor): closed accounts are deleted, `UNIT_ID_MAX` and the wrap rule, `addHuman` removes a
  spawned unit (reason 10) on a throw, tests.
- **money-security/M6** and **parity-scope/m1** (minor, merged): `HOLD_TICKS`, integer `holdTicks` everywhere, the
  hold byte from it, the hold test reads `P.MP.HOLD_TICKS`.
- **money-security/M7** (minor): failed refund rows begin with `refund`, `claimDuePayout` returns `reason`,
  `drainPayouts` records no earnings for them (T9 owns `server/db.js`).
- **money-security/M9** (minor): `onTransfer` takes one object end to end; `PaperRoom` adds the label; tests assert
  kind and label.
- **money-security/M10** (minor): `[PAPER] REFUND` log before withdraw, the zero-amount `trackEarning` idea dropped,
  the `stakes_history` drift row in 5.9.
- **money-security/M13** (minor): `seatFor(stake, preferred)` with the membership, stopped and spot checks, `stop()`
  on sweep and emergency close, `addHuman` throws `'stopped'`, `socket.leave` of the old arena, tests.
- **netcode-feasibility/M4** (minor): shrink end is a `wireVer` bump; `pp:joined` rings clamped on receipt; bundle
  rings not; tests.
- **netcode-feasibility/M6** (minor): the MirrorUnit field contract (schemes manager, skin resolution, `percent`,
  `onScoreChanged`, kills counter, `comeback`, `updateBounds`) in 8.1; leaderboard and label checks in T12.
- **netcode-feasibility/m1** (minor): the frame size formula, `TRAIL_TAIL_MAX` 4, T6 acceptance in exact states.
- **netcode-feasibility/m2** (minor): `pct` clamped to `[0, 1]` in the frame, `['b']` and `pp:joined`; saturation test.
- **netcode-feasibility/m4** (minor): ack-miss detection by `seq`, snap on a miss, `MAX_PREDICT_TICKS_PER_FRAME`.
- **netcode-feasibility/m5** and **parity-scope/m9** (minor, merged): the local lock is released only by the key or a
  confirming frame, never by a client timer; replay uses the stored hold bit; tests. m5's variant (c), a client-side
  `HOLD_INPUT_STALE_MS` release, was NOT adopted: it re-creates the same divergence later, and rule 3 ties the cancel
  to the key.
- **netcode-feasibility/m7** (minor): `['j']` units get the synthesised spawn circle, a fresh base counts as a bump.
- **netcode-feasibility/m8** and **parity-scope/m2** (minor, merged): the two `game.player` reads outside
  `BotUnit.update` are named in 4.5, the magnet sets `_prey` around `change('attack')`, the magnet-path test, the 4.6
  fallback trigger tightened and the pin-move rule added.
- **parity-scope/M5** (minor): the order line rebuilt, T13 depends on T9 AND T12 in one push, `paperNet.js` UMD with a
  node test in T11, browser checks moved to T12; T6 and T14 left as designed.
- **parity-scope/M7** (minor): the reseat sentence in 9.6 F1, the split case as open question 6, the two pin tests.
- **parity-scope/m3** (minor): `names`, `lang`, `schemes` defined in 4.1.
- **parity-scope/m4** (minor): `posthog-init.js` first, `game_started` and `cashed_out` events, no `phIdentify`.
- **parity-scope/m5** (minor): head, fonts and the three load-bearing CSS rules named in 8.5; canvas-size check in T12.
- **parity-scope/m8** (minor): no live-play leave control; "Back to the lobby" only on end screens.
- **parity-scope/m11** (minor): the `pp:join` field-ignoring test extended to `worth`/`micro`, the spent-token replay
  case worded for the post-death path.
- **Owner answers 1 and 3**: `PICKUP_SWEEP_MS`, `DISCONNECT_GRACE_MS`, `sweepPickup`, `sweepFloor`, the hour sweep in
  the pickups pass and from the directory timer, the seat record, the grace and reconnect paths with the socket.io
  timing stated, `pp:joined { resumed }`, `pp:replaced`, `pp:refused 'expired'`, the reconnect client rule, tests.
  Answers 2 and 4 keep the design as written.

Added 2026-09-27 after checking the stored refuter verdicts (`docs/paper-mp/refute-*.md`) against this list:

- **parity-scope/m10** (minor, confirmed; the first status table listed it as refuted): a push across a foreign trail
  is a normal kill with the money to the pushed player, stated in 9.3, open question 7, pinned in `paperRoomMoney.test.js`.
- **money-security/M11 refuter side note**: every socket handler rejects a null or non-object payload before
  destructuring (6.2), with a `paperSockets.test.js` row and a T8 acceptance item.
- **netcode-feasibility/M8 refuter residual** (wording): `trimDirtyBases()` walks `this.units` (4.4), and the unused
  `_verDirty` set is gone: `handleReturn` bumps `wireVer` directly, as 7.3 already said.

Skipped, with why:

- Nothing surviving was skipped outright. Two sub-variants were not adopted, each with its reason above: m5's client
  `HOLD_INPUT_STALE_MS` release (superseded by m9) and M3 money's `source: 'game_rake'` label for the floor sweep (the
  owner's answer makes the sweep real; it uses the rake's path with its own `paper_floor` source so the per-source
  dashboard stays honest). The M6 money/m1 parity, M3 parity/m9 netcode, M3 netcode/M2 parity, M7 netcode/M1 parity,
  m5/m9 and m8/m2 pairs were each applied as one merged change.
