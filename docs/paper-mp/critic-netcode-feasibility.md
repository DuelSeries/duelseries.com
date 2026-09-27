# Paper multiplayer design: netcode and feasibility critique

Date: 2026-09-23. Lens: a senior netcode engineer who has to build `docs/paper-multiplayer-design.md` next week.
Every claim below was checked against the real files (paths relative to `slither-clone/`, a cite with no folder is
under `public/js/paper/`), not against the reader notes. Four claims were also probed by running the solo modules
under node (scripts kept out of the repo, results quoted inline as PROBE 1 to 5). Nothing was committed.

## Verdict

The shape is right and most of it is buildable: the stock `P.Game` with `player` null really is a complete server tick
(`unit.update` runs before movement, `paperGame.js:412-413`, so the angle byte steers with no tick of delay), the
prey getter works because every bot read of `game.player` sits inside `BotUnit.update` (`paperUnits.js:480,516`,
`paperBots.js:44,335`), the lobby launch path is exactly as described (`play.js:274` removal, `main.jsx:79-80,217`,
`onPlay` at `main.jsx:336-350`), and the CPU and warm-up numbers hold (PROBE 2: 0.068 ms per steady tick with 16
squares, 503 ms for the 6000-update warm-up). Two things must change before the trim task and the client tasks can
start. First, the trim as specified crashes the tick under ordinary play: it commits FRESH `Vec2`s at wall-corner
coordinates, but the stock wall slide hands the border polygon's OWN vertex objects to trails (PROBE 1: 40 of them in
one 900-tick slide, all registered in the grid), so the next slider past a trimmed corner trips the stock
`unifyHitPoints` throw (PROBE 4 reproduces the exact error), three of those close a paid arena through the emergency
path. Second, the own-square reconciliation cannot work with "latest input wins, no queue": the `ack` byte does not
name a client state the server actually reproduced, and the server's own `rng() * 0.01` dt jitter accumulates to
0.11 u over 600 ticks (PROBE 3), so the 0.05 u acceptance and the 0.05 u reconcile threshold are both unmeetable.
Beyond those, a handful of specification gaps (join-time event replay, the version-keyed ring cache defeating the
shrink-end re-send, the renderer fields the mirror must carry, the wall-death veto leaving a self-crossing trail, a
dead unit's base being trimmed and re-committed) each need one paragraph of design before an engineer can build
them the same way twice. On the owner's open question 3 (no reconnect grace) one netcode consequence is worth
stating: socket.io only reports a disconnect after its ping timeout, so a phone that loses radio drops its money
where it stood roughly 20 seconds later while the square keeps its last angle; the hold-bit staleness rule (500 ms)
does not shorten that.

---

## Blockers

### B1. Trim wall vertices duplicate registered points and crash the tick (sections 9.4 step 8, 9.5, 4.3)

**Claim.** `planTrim` step 8 says crossings and wall vertices are "NEW `Vec2`s (never the border polygon's own
points: it is rebuilt every quantum)" (design :666-667) and `applyTrim` commits them (:672-673). But the stock wall
slide does hand the border polygon's own vertex objects to a moving unit: `Segment.intersect` snaps a hit to the
STORED segment's `start`/`end` object when the raw hit is within 2^-26 (`paperGeom.js:194-201`), the slide loop uses
that object as `touch` and ends a piece on it (`paperGameMoves.js:81,88`), and `handleUnitMovements` then does
`unit.track.add(move.end)` (`:371-372`), which commits it to the grid (`Polyline.addDistinct` -> `Segment.commit` ->
`Vec2.commit`, `paperGeom.js:602,151-153,381-388`). PROBE 1 (a unit sliding along the 950 wall for 900 ticks): 920
trail points, 40 of them ARE border polygon vertex objects, all 40 registered in the grid. In solo this is harmless
because a ring later built from that trail holds the same object, so there is only ever one registered point per
corner. The design's trim breaks that: after a trim, the ring holds a fresh `W'` at the corner's coordinates
(committed, registered); the next away unit that slides past that corner adds the border's `W` to its trail (also
registered, same coordinates within 2^-26); its very next movement piece starts at `W`, so `space.intersections`
returns a hit on the trail segment (point `W`) and hits on the two ring segments (point `W'`), and `unifyHitPoints`
throws `paper: two registered points at one location` (`paperGameMoves.js:393-397`). PROBE 4 built exactly that ring
(one fresh point at wall vertex k=8, committed) and ran the slider: the throw fires at tick 112, in the same tick
the corner is passed. Every wall-hugging player crossing any trimmed base's wall run triggers it. Under 5.9 three
consecutive thrown ticks run `emergencyClose()`: every paid human is paid out and the arena is destroyed, so the
shrink feature as written repeatedly closes paid arenas and pushes money through the forced-payout and refund paths
because of a geometry coincidence. Note the same duplication recurs on GROWTH: `setRadius` rebuilds the polygon with
fresh objects (:192), so a ring that kept the old border's objects at radius r meets a new polygon's objects at the
same coordinates when the arena returns to r.

**Evidence.** Design :192-196, :666-667, :672-674, :412. Code `paperGameMoves.js:69-101,332-380,384-408`,
`paperGeom.js:149-160,194-201,381-388,602`, `paperTerritory.js:31-43`. PROBE 1 and PROBE 4 as quoted.

**Fix.** (1) `SafeArenaBorder.setRadius` builds its points as `P.makeCirclePoints(center, 300, r).map(p =>
this.space.checkPoint(p))` (`SpatialGrid.checkPoint`, `paperGeom.js:316-319`, returns the already-registered point at
those coordinates when one exists), so the border's vertex objects are always the registered ones. (2) The plan
emits the border polygon's OWN vertex objects for the wall run and passes each crossing point through
`space.checkPoint` before committing it; delete the "never the border polygon's own points" rule (the old polygon
being discarded is fine, a ring holding its vertices is the stock situation). (3) `checkRing` keeps "no repeated vertex
object" and adds "no two registered points within 2^-26 of each other along the ring". (4) New test in
`paperTrim.test.js` and in T5's acceptance: after a trim, an away unit sliding along the trimmed wall run for 300
ticks never throws, and its trail shares vertex objects with the ring at every corner it passes; then grow the arena
back to the same radius and repeat. (5) `paperSoak.test.js` adds a wall-hugging human to the wandering set.

---

## Major

### M1. "Latest input wins, no queue" makes the ack byte meaningless for reconciliation (sections 6.2, 7.1, 8.2)

**Claim.** The client runs one predicted tick per input (`seq`, angle, hold, `stateAfter` into the ring, design
:558-559) but sends `pp:in` "every predicted tick when changed, else every 2nd" (:438), and the server applies only
the latest received value at the top of each tick with no queue (:438, :199). So the server never replays the client's
angle SEQUENCE per tick, it samples whatever arrived. Failing scenario: client ticks 10, 11, 12 steer A and tick 13
steers B; it sends seq 10 (A), skips 11, sends 12 (A) and 13 (B). Jitter delivers 12 and 13 in one wake, so the server
runs A for ticks s10, s11 and B from s12: two ticks of A against the client's three. The frame carries `ack = 13` and
the client compares the server state with `buffer[13].stateAfter`, which differs by one tick of travel (1.5 u, 30x
`RECONCILE_POS_EPS`), replays, and the square hops 1.5 u. The reverse case (seq 12 late) hops the other way. While
steering continuously every tick sends, and any two inputs landing in one wake mean one is never applied, so the
turn-capped direction diverges (`turnCap`, `paperGameMoves.js:59-63`) and the divergence persists until an uncapped
tick re-syncs it. The result is a correction every time delivery jitters, not the "left alone" steady state 8.2
promises, and the T10 premise (same angle per tick on both ends) is not what this wire delivers. Related: `hold`
transitions arrive RTT/2 late, so every Q press produces one 4.5 u (at 100 ms) forward correction and every release one
backward; acceptable, but the design's "prediction and server agree by construction" (:565) overstates it.

**Evidence.** Design :438, :199, :558-563, :749, :773. Code `paperGame.js:406-413`, `paperGameMoves.js:49-66`.

**Fix.** Make the server consume inputs per tick in order: the client sends `pp:in` EVERY predicted tick (60 Hz,
the snake already does); the room keeps a per-human FIFO bounded by a new constant `INPUT_QUEUE_MAX = 3` (drop the
oldest, ignore a seq not newer than the last applied, compare modulo 256); `applyInputs` pops exactly one entry per
tick and sets `seqAck` to THAT seq; when the queue is empty it repeats the last input and sets a new unit flag bit
3 `starved` in the frame. The client reconciles only against a frame whose `ack` changed since the last compare and
whose `starved` bit is clear, otherwise it skips the compare for that frame. Section 2 gains `INPUT_QUEUE_MAX`; 7.1's
flags byte gains bit 3; 6.2's rate rule becomes "every tick, more than 120 per second ignored". Test
(`paperPredict.test.js`, T10 acceptance): a server fed the client's per-tick inputs through the FIFO with random 0
to 2 ticks of delivery jitter reproduces `buffer[ack].stateAfter` exactly on every non-starved acked tick over 600
ticks.

### M2. The server's per-tick rng dt jitter accumulates; the 0.05 u threshold and the T10 bound are unmeetable (sections 2, 8.2, 11)

**Claim.** `Game.update` adds `this.rng() * 0.01` ms to every tick (`paperGame.js:406`); the design counts it as
"0.0009 u" (:117), which is the per-tick figure. It is a one-sided bias (always non-negative), so the server always
travels slightly farther than a fixed-`STEP_MS` predictor. PROBE 3 (the design's own predictor recipe,
`P.Game.prototype.getMovement.call({config, border}, STEP_MS, scratch)`, against the real `update` over 600 ticks of
random steering): position error 0.11 u at the end and growing linearly, direction identical. So `test/paperPredict.test.js`
"within 0.05 u over 600 fixed ticks" (:749, T10 :773) fails against the real `ArenaGame.update`, and on a perfect link
`RECONCILE_POS_EPS = 0.05` fires about every 4 seconds with nothing wrong. The u16 position scale (0.031 u per axis,
:124) alone can produce 0.044 u of apparent error, which sits right under the threshold.

**Evidence.** Design :117, :560-561, :749, :773. Code `paperGame.js:406`. PROBE 3.

**Fix.** Section 2: add `PREDICT_DT_BIAS_MS = 0.005` (the mean of `rng() * 0.01`), the predictor steps at
`STEP_MS + PREDICT_DT_BIAS_MS`, which turns the drift from linear into a random walk of a few hundredths of a unit
per minute; raise `RECONCILE_POS_EPS` to 0.5 u (invisible against an 8 u trail and above the wire quantisation).
T10 acceptance becomes two bounds: exact agreement (under 1e-9 u) against an `ArenaGame` whose `game.rng` is stubbed
to return 0, and under 0.5 u over 600 ticks against the unstubbed game.

### M3. The client predictor runs the unguarded stock wall loop; `SafeArenaBorder` is a server-only file (sections 3, 4.3, 8.2)

**Claim.** 8.2 says the predictor calls the stock `getMovement` with "stock wall slide" and the mirror's
`P.ArenaBorder.circular` (:526, :554). The guard against the stock `while (wallHits.length)` loop lives in
`SafeArenaBorder` in `server/paper/ArenaGame.js` (:139, :190-191), which the browser never loads. Whatever hangs the
server would hang the tab. My probe of the case the design names (exact east from y = 1000, PROBE 5) did NOT hang: the
unit passed straight through the wall corner (final x = 2799, never clipped, at most 2 border calls per tick),
because the corner hit is deduplicated to one edge and the projected leftover ends 0.0002 u outside, after which no
edge is ever crossed again. So the stock loop has at least an escape hole at exact vertices, the guard's reason
text in section 2 (:105, :107 "the probed hang") is imprecise, and on the client the predictor would predict the
escape while the server pushes the unit back (9.3), producing a snap-sized disagreement. Either way the client must run
the same guarded border and the same push as the server, and the file map does not let it.

**Evidence.** Design :139, :189-191, :105, :107, :552-556. Code `paperGameMoves.js:69-101`, `paperGeom.js:748-764`
(dedupe by point object). PROBE 5.

**Fix.** Move the guard into the shared module: `paperWire.js` exports `MP.guardBorder(border)` (wraps
`intersections` with the `BORDER_GUARD_CALLS` cap and `resetGuard`) and both `SafeArenaBorder` and the mirror border
use it; the predictor calls `resetGuard()` before every step and applies `MP.pushPoint` exactly as 9.3 (already
stated). T4's "exact-east no hang" acceptance also asserts "inside the wall after the push on the next tick", and
`paperPredict.test.js` adds the exact-east case with the same assertion. Reword the `SPAWN_AXIS_GUARD` and
`BORDER_GUARD_CALLS` reasons to "the exact-vertex hole (escape or loop)".

### M4. The shrink-end ring re-send goes through a version-keyed cache and re-sends the stale ring; mid-shrink joiners get unclamped rings (sections 7.3, 8.4, 6.3)

**Claim.** 7.3: a plain trim "bumps nothing" (:502) and rings are "cached by version" (:499); at the end of a shrink
"every base flagged `_wallTouched` during the shrink is re-sent once" (:503-505). A re-send at the same version is a
cache hit, so it sends the encode made BEFORE the trims: the client replaces its (correctly clamped) ring with the
untrimmed one, which is worse than sending nothing, and it stays wrong until the next capture. The growth case the
paragraph exists for ("land a blocked trim left outside that growth makes reachable again") is the one where the
cached encode and the server ring differ most. Second gap: `pp:joined` "reuses the cache" (:500), so a client joining
mid-shrink receives rings that extend beyond the current wall, and 8.4 clamps only "when the frame radius falls by a
quantum" (:579), which for that client may not happen for seconds.

**Evidence.** Design :495-505, :578-582, :446.

**Fix.** The re-send is a version bump: when the radius stops falling or starts growing, `base.wireVer++` for every
`_wallTouched` base (the encode budget spreads them over a few ticks). The client clamps every ring it receives
(join, `['b']`, `pp:geo`) to the radius of the newest frame on receipt, then on each quantum as now.
`paperArenaWire.test.js` (T6 acceptance): "the ring re-sent at shrink end carries a new version and differs from the
cached encode; a join built mid-shrink followed by a client clamp equals the server ring within 0.06 u".

### M5. A join between ticks replays events the join payload already reflects (sections 5.6, 6.3, 7.2)

**Claim.** Events are queued per tick and flushed only on snapshot ticks (:448, `SNAPSHOT_EVERY` 2). `addHuman` joins
the socket to the room and builds `pp:joined` from the live state in the same call (:370-371). Failing scenario: tick
101 (non-snapshot) kills B and drops coin 7 (queued); the join handler runs between 101 and 102 and sends C a payload
with no B and with coin 7; tick 102 flushes `['k', B, ...]`, `['p+', 7, ...]` and `['j', C, ...]` to the room, so C
receives a kill for an unknown id, a second coin 7 and a `['j']` for ITSELF. The design never says events are
idempotent or that unknown ids are ignored, so one engineer builds a second `MirrorUnit` for the local player (the
mirror's `player` no longer matches the unit in `units`, the minimap and leaderboard draw the wrong one) and another
pushes a duplicate coin. `pp:joined.tick` cannot be used to drop them because the bundle's `tick` is the flush tick,
not the event's.

**Evidence.** Design :369-371, :448, :488-493. `socket.join` then `io.to(room).emit` ordering is per socket, so the
replay is exact.

**Fix.** In `addHuman`, before `socket.join(ioRoom)`, if the pending event queue is non-empty emit it now as
`pp:ev { tick: currentTick }` to the room and clear it. Independently, 7.2 states that every event is idempotent:
`['j']` for a known id updates fields, `['k']`/`['p-']` for an unknown id is ignored, `['b']`/`['t']` with a version
or (epoch, from) not newer than what is held is ignored, `['p+']` is keyed by pid. Test (`paperRoomMoney.test.js`,
T7 acceptance): a join between ticks never receives an event older than its payload, and applying the first bundle
twice to a mirror changes nothing.

### M6. The mirror is missing fields the unchanged renderer reads; without `schemes` it throws on the first frame (section 8.1)

**Claim.** 8.1 lists `base.polygon`, `track.polyline`, `in`, `isPlayer`, `scale`, `top`, labels, particles and camera.
Reading `paperRender.js` end to end, the renderer and the code it calls also read: `unit.schemes.scores()` and
`.print()` unconditionally for the top five and the player (`drawLeaderboardPlates` :436,459,466; `drawPlayerScoreBar`
:537,549; `drawBestScoreText` :559), and `deadUnit.schemes.scores()` in `spawnDeathParticles` (`paperUnits.js:136`,
which the mirror calls on `['k']`, design :540); `unit.percent` (what `PercentScoreScheme.scores()` returns,
`paperUnits.js:293`, and what 8.1's "scale from percent" and "sort by percent" need); `game.topListChanged`, without
which the cached leaderboard canvas is drawn once and never again (`:501-502`; stock sets it in `onScoreChanged`,
`paperUnits.js:382-384`, which the mirror never calls); `game.player.statistics.kills` (`:574`); `unit.name`, `unit.skin`
with `.colors.{main,back,nick,plate,particles}`, `.pattern`, `.container.{frontLayers,backLayers,maxScale}`
(`:52-55,200-240,405-417,449-454`); `unit.target` for `target` layers (`:216`); `unit.direction` (`:211`);
`track.polyline.{segments,start,path,bounds}` (`:46-49,265-266,308`, `boundsInView` reads `.bounds`, which
`Polyline.updateBounds` only maintains through `addDistinct`, `paperGeom.js:584-612`, the method the design says it
will not use); `base.polygon.{path,bounds}` (`:249-250`); `game.labels`, `game.particles`, `game.language.bestTxt`,
`game.best`, `game.border.polygon.path`, `game.space.{width,height,center}`, `game.units[0]` as leader. The design's
`MirrorUnit extends P.GameUnit` ctor (:534) takes a `schemesManager` but 8.1 never says one is passed, so
`unit.schemes` is `undefined` and `drawLeaderboardPlates` throws on the first frame with any unit on screen.

**Evidence.** Design :525-548. Code as cited.

**Fix.** 8.1 gets the field list above as a contract: `MirrorUnit` is built with the page's `ScoreSchemeManager`;
`setTrail` sets `polyline.start/end/segments`, rebuilds `path` and `bounds` by hand; the cosmetic tick sets
`unit.percent` from `pct`, `unit.top` from the sort, sets `game.topListChanged = true` whenever the identity or
score of any of the first six units or the local unit changed since the last frame, increments
`player.statistics.kills` on a `['k']` whose killer is the local id, and calls `addLabel` for the stock kill and
"+x.xx%" texts. T11 acceptance adds "the leaderboard percentages change within one second of a capture and the kill
counter increments".

### M7. The wall-death veto leaves a self-crossing trail behind (sections 4.4, 9.3)

**Claim.** `kill` returns early for reason 2 inside the grace window (:207, :633-636). But by then
`UnitTrack.handleIntersect` has already set `unit.position = hit.point` and called `kill` (`paperTerritory.js:232-237`);
after the veto, `dispatchBucket` and `handleUnitMovements` continue normally and append `move.end` to the trail
(`paperGameMoves.js:442-446,370-374`). The move crossed an earlier trail segment, so the polyline now intersects
itself with no shared vertex. Consequences: on return, `handleReturn` builds `loop` from that trail
(`paperGameMoves.js:158-178`), a self-intersecting polygon whose `rawSquare()` sign and `inside()` answers are
arbitrary, so the branch at :181 picks the wrong ring, kills at :196-201 hit the wrong units, and the resulting base
ring is self-intersecting; `planTrim` (9.4) assumes simple rings. The veto also fires for a GENUINE self-cross that
happens within 5 u of the wall during the grace window (reason 2 is "self cross near the wall", `paperTerritory.js:233-236`),
which is not the shrink killing anyone. The probe the design cites (:635) counted deaths, not trail simplicity.

**Evidence.** Design :204-213, :627-637. Code `paperTerritory.js:225-242`, `paperGameMoves.js:365-378,442-446`.

**Fix.** On a vetoed reason 2 the room repairs the trail instead of ignoring the crossing: rewind the trail to the
crossing point (rebuild `track` from its points up to and including `hit.point`, which is already on the trail, then
let the tick continue), or, if that is more code than the design wants, wipe it the way `recoverTail` does
(`track.remove()`, leaving the unit away with an empty trail, which the stock return path handles: no capture, no
throw). State the choice in 9.3 and add to `paperSoak.test.js` and to T14's acceptance: "every trail polyline is simple
(no two non-adjacent segments intersect) on every tick".

### M8. A base flagged for trimming whose owner dies the same tick is trimmed and re-committed after `kill` removed it (sections 4.4, 9.5, 9.6)

**Claim.** `stepRadius` flags every wall-reaching base `_trimDirty` before `super.update` (:199, :619-620); deaths
happen inside `super.update` and `kill` removes the victim's ring from the grid (`paperGame.js:357-358`); the post
pass then trims "bases flagged `_trimDirty`" (:688-690) with no death check. `applyTrim` commits fresh segments and
removes the old ones (:672-674): the old ones are already removed (`Vec2.remove` with a missing segment splices
index -1, `paperGeom.js:390-393`, silently dropping some OTHER segment from each vertex), and the fresh ones register
a ghost ring with a dead owner in the grid for the life of the arena. Shrink quanta arrive every 125 ms and kills
happen, so this is routine, and the damage (`splice(-1, 1)` on vertices shared with live trails) is exactly the kind
of corruption that surfaces ticks later as an unrelated throw.

**Evidence.** Design :199-203, :619-620, :669-678, :688-690. Code `paperGame.js:341-372`, `paperGeom.js:390-397`.

**Fix.** The post pass skips any base whose `unit.death` is set and `kill` clears `_trimDirty`/`_verDirty` for the
victim; `applyTrim` asserts every old segment still has `shape === ring` before removing it and treats a mismatch as
F2. Test in `paperTrim.test.js` and T5's acceptance: "a base flagged dirty whose owner is killed in the same tick is
not touched and the grid point count is unchanged".

---

## Minor

### m1. Frame byte budget: 924 bytes worst case, not "about 550" and not "under 700" (sections 7.1, 12 T6)

Per unit 24 B + 1 B `tailN` + 4 B per tail corner; with `TRAIL_TAIL_MAX` 8 that is 57 B, 16 units 912 B, plus the 12 B
header, plus 10 B per pickup: 924 B before pickups (27.7 KB/s at 30 Hz), against T6's "under 700 bytes" (:769).
The typical figure (one or two corners) is 476 to 540 B, so 550 is fine as a typical number. Fix: T6 acceptance says
"under 950 bytes with 16 units at the full tail and 2 pickups, under 600 typical", or `TRAIL_TAIL_MAX` becomes 4 (a
full-turn zigzag produces about one corner per two ticks, so 4 covers the 6-tick batch interval with margin).

### m2. Percent above 1 saturates the u16 (section 7.1)

A blocked or not-yet-trimmed base keeps land outside the wall while `game.square` shrinks, so `base.square /
game.square` can exceed 1 (:418-419 of `paperGame.js`, design :195). Clamp `pct` to 1 before scaling by 65535 and
state it in 7.1.

### m3. Tail truncation is unspecified (section 7.4)

"tailN (<= 8)" (:479) does not say which corners ride when more than 8 were committed since the last batch. Specify
"the newest 8"; the client draws a straight chord across the gap until the batch arrives, and `trailCount` lets it
know a gap exists.

### m4. Ack older than the input ring (sections 2, 8.2)

`INPUT_BUFFER` 64 is one second; an `ack` no longer in the ring (RTT above one second, or after a tab stall) is not
handled. Specify: treat it as a snap (set state to the server state, clear the ring).

### m5. Local hold lock released after 300 ms without a confirming frame (section 8.6)

":602-603": on a phone with a 300 ms spike the local predictor resumes moving while the server still holds; the next
frame pulls it 27 u back (under `SNAP_DIST`, so it eases) and the ring flickers. Keep the local lock while the hold
bit is set and release only when a frame newer than the keydown shows the holding flag clear, or after
`HOLD_INPUT_STALE_MS`.

### m6. Resync compare must read the newest frame, timeline reads the render frame (sections 7.5, 8.3)

Per-unit metadata (`baseVer`, `trailEpoch`, `trailCount`, `inId`, `pct`, `hold`) should be read from the frame at
`renderTick` for drawing (so land and the home flag change together with the timeline `['b']`), but the 7.5 mismatch
test must use the NEWEST frame, otherwise a healthy client sends `pp:need` during every interpolation delay. Say so.
Also specify: a frame's epoch bump clears the held corners of that unit at `renderTick` even before the `['t']`
batch arrives; a unit absent from the newer frame keeps its last position until its `['k']` applies; the bundle is
emitted BEFORE the frame in the post pass.

### m7. `['j']` carries no ring (section 7.2)

A joiner's ring reaches other clients only through the encode budget, possibly a tick later; until then the mirror
has no polygon to draw or clip against. Either `['j']` carries the spawn circle blob or the client synthesises
`P.makeCirclePoints({x, y}, config.baseCount, config.baseRadius)` and lets the first `['b']` replace it.

### m8. The magnet must set the prey around `fsm.change('attack')` (section 4.5)

`StateMachine.change` runs the new state's `update` at once (`paperBots.js:21-32`); `attack.update` reads
`bot.game.player` (`:335-337`) and returns `'idle'` when it is null. The per-human magnet (:200-201) runs in the post
pass where `_prey` is null (:238), so a `change('attack')` there leaves attack immediately. Wrap the call:
`g._prey = human; try { bot.fsm.change('attack'); } finally { g._prey = null; }`, and make the T4 "bot enters attack
on a long human trail" test go through the magnet path, not only through aggro range.

### m9. Free-arena bot skill is pinned at `noPlayerBotLevel` (section 4.4)

With `player` null in `Game.update`, `level` is `config.noPlayerBotLevel` = 0.5 every tick (`paperGame.js:454-458`),
where solo scales it from 0.1 to 1 with the player's percent. The free arena's bots are therefore mid-skill from the
first second, unlike the solo page the brief says it should feel like. Fix without a solo edit: `applyInputs` sets the
arena's own `config.botLevel = lerp(startBotLevel, 1, maxHumanPercent)` each tick (`:459-461` applies it), and
`-1` when no human is alive.

### m10. `ArenaHuman.type` must stay undefined (section 4.2)

`spawnBot`'s census does `census[unit.type]++` for every unit that is not `player` (`paperGame.js:197-202`); a human
with `type` 0 would consume a bot type slot and shift the row. State that `type` is left undefined (it produces a
harmless `census.undefined = NaN`).

### m11. Warm-up through the wrapped `update` runs the post pass 6000 times (section 4.7)

The wrapped `update` calls `trimDirtyBases`, the magnet, the wire feed and `assertConserved` on every warm-up step.
Add a `warming` flag that runs `super.update` only, and state that warm-up steps use 50 to 51 ms like solo
(`paperMain.js:112`), which the stock update accepts.

### m12. Shrink-end re-send burst and pickup clamp radius (sections 7.3, 5.3)

Up to 16 rings of about 1.2 KB each go out within a few ticks at shrink end; fine, but say the budget applies so it
is not sent in one bundle. `PICKUP_WALL_INSET` clamps to `radius - 12` while the reachable wall is the apothem
(`radius * cos(PI/300)`, 0.05 u less); harmless, but use the apothem for consistency with the push.

### m13. Trail corners outside the wall are drawn outside the clamped wall (section 8.4)

The client clamps rings but not trail corners, so after a shrink a trail laid along the old wall is drawn beyond the
new one until the owner returns. Cosmetic; clamp trail corners radially on the same quantum, or accept and say so.

### m14. `pp:in` excess handling (section 6.2)

"More than 120 per second are ignored" drops the NEWEST inputs under a burst, which with M1's FIFO would drop fresh
steering. Ignore excess by dropping the oldest queued entry instead, or count against a per-second budget that
resets, so a client cannot be starved by its own burst.
