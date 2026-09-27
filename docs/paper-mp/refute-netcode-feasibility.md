# Refuter verdicts: netcode-feasibility

Recorded 2026-09-27 from the stored result of the critics workflow run `wf_819cd852-cba` (finished 2026-09-24, script
`paper-mp-critics-wf_819cd852-cba.js`), which is where the independent refuters wrote their verdicts; until this file the
verdicts existed only inside that run record, not on disk next to the critic file. The findings and their text are in
`docs/paper-mp/critic-netcode-feasibility.md`. "Downgraded to X" is the severity the refuter left the finding at. "No refuter result"
means the run recorded no verdict for that finding (the workflow log says "4 refuter results missing"). "In design 14"
says whether design section 14 lists the finding as applied. The reasons below are the refuters' text verbatim; the
line numbers they cite (`design:NNN`) are those of the FIRST draft, before the revisions.

| ID | Refuter verdict | In design 14 |
|---|---|---|
| B1 | downgraded to blocker | yes |
| M1 | downgraded to major | yes |
| M2 | downgraded to major | yes |
| M3 | confirmed (major) | yes |
| M4 | downgraded to minor | yes |
| M5 | confirmed (major) | yes |
| M6 | downgraded to minor | yes |
| M7 | no refuter result | yes |
| M8 | REFUTED (reason below) | no |
| m1 | downgraded to minor | yes |
| m2 | confirmed (minor) | yes |
| m3 | REFUTED (reason below) | no |
| m4 | confirmed (minor) | yes |
| m5 | confirmed (minor) | yes |
| m6 | REFUTED (reason below) | no |
| m7 | confirmed (minor) | yes |
| m8 | confirmed (minor) | yes |
| m9 | confirmed (minor) | yes |
| m10 | REFUTED (reason below) | no |
| m11 | REFUTED (reason below) | no |
| m12 | REFUTED (reason below) | no |
| m13 | REFUTED (reason below) | no |
| m14 | REFUTED (reason below) | no |

## Refuted findings, the refuter's reason verbatim

### M8. A dirty base whose owner dies the same tick is trimmed and re-committed after kill removed it

The scenario cannot happen: `_trimDirty` is a flag on the base object (design :219, :620), the stock sim keeps no base registry other than `this.units` (no `bases`/`polygons` collection in paperGame.js, paperTerritory.js, paperGameMoves.js or paperUnits.js), so the post pass can only enumerate dirty bases through `this.units`, and stock `kill` splices the victim out of `this.units` in the same synchronous call that sets `death` (paperGame.js:345, :359-360). Kills run inside `super.update` (paperGame.js:412-413), which the design orders before `trimDirtyBases()` (design :199-203), and every death path goes through `super.kill` (design :211 override, :322 removeHuman reason 7, :379 reasons 8/9), while the vetoes at :207-209 return before `death` is set so the unit stays live. The critic reads paperGeom.js:390-393 correctly (unguarded `splice(-1, 1)`) but a dead owner's base never reaches `applyTrim`, which is why the design's invariant at :673 ("committed and removed exactly once") holds. Residual: the design does not state the enumeration in words, and `_verDirty` (:219) is never consumed (7.3 uses `wireVer` bumps and a post-pass square/segment-count compare instead), which is a wording tidy-up, not a defect.

### m3. Tail truncation unspecified

The scenario (more than 8 corners committed since the last batch) cannot occur under the design's own rules: the wire feed runs once per tick in hooks.afterTick (design :201), the decimator commits at most one corner per fed point (design :508-510), and the reliable batch flushes ALL new corners every TRAIL_BATCH_TICKS = 6 with no per-tick cap on trail encodes (design :511-512, unlike RING_ENCODES_PER_TICK), so the tail is bounded at 6 < TRAIL_TAIL_MAX = 8 by construction. Even reading the feed as every raw polyline point, the extra pieces are wall-vertex splits of 1.2 deg on the 300-gon border (paperMain.js:83), wall-touch points rate-limited by the 6 deg/tick turn cap (paperGameMoves.js:7,59, FULL_TURN=2*pi per second), and one push piece per 0.5 u quantum (design 9.3, about every 7.5 ticks at SHRINK_RATE 4 u/s); at 1.5 u/tick (paperSkins.js:196) a 0.35 u deviation needs a 13.5 deg heading change, i.e. 2 or more ticks between commits, so realistic tails are 2-3 corners. The queue is fed only by getMovement (paperGameMoves.js:337-341); dispatchBucket adds nothing. The critic's fix would also be harmful: a truncated tail makes held corners + tail differ from trailCount, which is exactly what 7.5 treats as a mismatch.

### m6. Which frame the resync compare and the timeline read is unspecified

The failing scenario cannot happen: the largest interpolation lag is INTERP_DELAY_MS 70 + MAX_JITTER_BUF_MS 180 = 250 ms (design :118) while RESYNC_AFTER_MS is 500 ms (:120), so a mismatch that exists only because one side lags the other by the interpolation delay never ages to the pp:need trigger, and pp:need is rate limited to one per 250 ms per unit anyway (:439). The design already pairs each unit's frame with holdings on the same time base: the own unit takes ack from every (newest) frame and applies own corners on receipt (8.2 :563-567), remotes apply reliable events when renderTick reaches their tick with the in-tick order fixed at :544-545 (apply due timeline events, then interpolate remotes); the critic's blanket "compare against the newest frame" rule would itself mis-compare a remote's timeline-applied corners against the newest trailCount since a 10 Hz ['t'] batch almost always falls inside the 70-250 ms window. The three "unstated" rules are covered or moot: 8.1 :541-543 drops a unit only on ['k'] (so it persists until then), paperRender.js:307 skips the trail whenever unit.in === unit.base so a returned unit's stale corners are never drawn before any ['t'] arrives, ['t'] carries epoch and from (:511-512) so a reset is self-describing, and bundle-versus-frame emission order is immaterial because remotes key both by tick and the own unit tolerates 500 ms (socket.io also preserves emit order on one connection).

### m10. ArenaHuman.type must stay undefined

The scenario needs a human with `type === 0`, which the design never creates: section 4.2 (design :175-177) lists ArenaHuman's fields explicitly and `type` is not among them, and `P.GameUnit`'s ctor sets `this.type = void 0` (paperUnits.js:343); only `BotUnit` assigns it (paperUnits.js:461), exactly as solo's `PlayerUnit` (paperUnits.js:432-436) leaves it undefined. The wire bot flag (design :476, `flags bit0 bot`) comes from the unit class, not from `type`, so nothing in the design tempts an implementer to add one. With `type` undefined, `census[undefined]++` (paperGame.js:197-202) only creates `census.undefined = NaN`, the `while` at :206 indexes row values 0..3 only, and `this.bots` is written (:82, :203, :223) but never read anywhere in the repo, so the result is harmless, as the critic itself concedes. The design's own test row (:740, "no bot has `type === undefined`") would additionally catch a type-0 human, since 15 counted units would exhaust the 15-entry row and hand the next bot `row[15]`. This is a wording nicety, not a defect.

### m11. Warm-up through the wrapped update runs the post pass 6000 times

With zero humans and zero sockets (free joins are refused with `warming` until warm-up ends, design :259) the post pass is near-empty: `perHumanMagnet` loops once per human (:200), pickups/holds/`assertConserved` act on an empty bank (5.1 :275, 5.3, 5.4), trim is injected null until T14 and the free radius is fixed at 950 = solo's `min(1000,1000)*0.95` (design :616-617, :685-687; paperMain.js:82) so `planTrim` would return `clean` in step 1 anyway, and the wire feed is an O(1) decimator per away unit plus at most 3 ring encodes and one ~400 B frame every 2 ticks emitted to an empty io room; the 474 ms probe (understand-solo-seams.md:60) was the stock `Game` alone, so `super.update` is the whole cost and WARM_CHUNK already bounds the stall. The "state 50-51 ms like solo" half of the fix is already in the design verbatim at :258. The "super.update only" half would break the first join: `kill` -> `hooks.onDeath` (:212-213) runs INSIDE `super.update` and QUEUES `['k',...]` entries (:292-298) that only the post pass flushes (:447), so thousands of warm-up bot deaths would be dumped on the first joiner right after `pp:joined`; and away bots' wire trails are fed only by the streaming post-pass decimator (:508-509), which never re-walks, so every trail alive at warm-up end would arrive truncated until that bot returns or dies. Clearing `u.log` each step (:202) during warm-up is itself a benefit, since stock `unit.update` pushes a Vec2 per tick and never reads it (paperUnits.js:387).

### m12. Shrink-end burst and pickup clamp radius

Both halves are, in the critic's own words, "fine" and "harmless", and neither is a defect. Budget: design.md:499-500 defines the only ring send path (bump -> decimate once -> encode -> cache by version -> at most RING_ENCODES_PER_TICK per tick, rest wait), and the shrink-end re-send at :503-505 must be a wireVer bump because the cache is keyed by version and a plain trim bumps nothing (:502), so a re-send without a bump would just replay the stale cached blob that joins/pp:geo reuse; the test row at :743 puts "budget of 3 per tick defers the rest" and "wall-touched rings re-sent once when the shrink ends" in the same test file. Even in the worst reading, ~19 KB in one reliable socket.io message over TCP and 16 O(n) filter passes (~1-3 ms) is not a netcode-feasibility problem. Pickup clamp: the wall is a 300-gon (paperSkins.js:186, paperGeom.js:883-897), so radius - apothem = r(1 - cos(pi/300)) is 0.026-0.052 u; a coin at radius - 12 is still 11.95 u inside the nearest wall point, under PICKUP_RADIUS = 16 (design :97), so the design's stated justification holds with 4 u of margin, and clampInside (:296) and movePickup (:307) already use the same radius - PICKUP_WALL_INSET reference consistently.

### m13. Trail corners outside the wall are drawn beyond the clamped wall

The server never trims or moves a trail on a shrink: design 9.1 (:619-620) flags only bases, 9.3 (:627-633) pushes only the unit's position through the normal movement pipeline (which extends the trail from outside to the push point), and 9.6 (:688-689) plus 9.4 blocked rule (b) (:659-661) explicitly RELY on the untouched trail staying outside the wall until return. So the client drawing reliable corners + tail as-is (7.4, :507-515) is an exact mirror of the authoritative trail, not a drift; the ring clamp in 8.4 (:578-582) exists only because the server DOES replace ring arcs without sending them (7.3, :502), and there is no equivalent server change to trails to mirror. The proposed clamp would break the design's own rule that client geometry is server truth (8.1 :528-531, 8.2 :569): trails are kill objects, so a corner pulled radially onto the wall would show a cuttable trail on the wall line where the real one is outside and unreachable, and the stroke is unclipped (`renderTracks`, public/js/paper/paperRender.js:299-311) so the honest picture is the one that shows it beyond the floor. It would also be undone by every append-only `['t']` batch and `pp:need` resync (7.4-7.5, :510-519) unless reapplied per batch, so the fix is both unsound and incomplete; the visual is cosmetic and truthful.

### m14. pp:in excess handling drops the newest inputs

The finding is explicitly conditional on "M1's FIFO", which is the critic's own proposed change (critic-netcode-feasibility.md:96-102), not the design: design :438 says "Latest wins, no queue", so nothing is queued and nothing FIFO-starves; and M1's fix text already specifies "drop the oldest" for its bounded FIFO (:97-98), so m14 at most notes an ordering inside M1, not a defect in the design under attack. The critic's second proposed fix, "count against a per-second budget that resets", restates what :438 already says ("more than 120 per second"), and its first fix ("drop the oldest queued entry") presupposes a queue the design does not have. A legit client sends at most 60/s (one pp:in per predicted STEP_MS tick, :438, :557-559), so the 2x cap can only trip on a modified flooding client (which the cap exists to ignore) or on >1 s of packets backed up in the browser WebSocket buffer and flushed at once (engine.io-client websocket.js:60-80 only clears writable on nextTick, so browser volatile packets queue rather than drop); in that regime snapshots have also stalled >1 s, HOLD_INPUT_STALE_MS=500 (:94) has already released any hold, the client snaps on the first frame (SNAP_DIST, :118), and the residual is bounded to keeping burst packet #120 (at most 1 s older than the newest) plus ignoring fresh input for the rest of the current 1 s window, which self-heals. The room adds no catch-up burst of its own (:253-257), and the snake precedent has no input cap at all (server/index.js:2277-2280), so the design is already stricter than shipped practice.
