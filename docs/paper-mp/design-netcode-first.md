# Paper multiplayer: design, netcode first

Written 2026-09-20 by architect 3 of 3 (bias: the feel online). Binding input: `docs/paper-multiplayer-brief.md`.
Reader notes used: `docs/paper-mp/understand-*.md`. Every claim about existing code carries a `file:line` cite; cites
without a folder are under `public/js/paper/`. Nothing in this document was executed; the probes quoted are the ones
recorded in `understand-solo-seams.md` section 7.

The design is derived in this order: what crosses the wire and when (sections 1 to 4), then the server that can feed that
wire (5 to 8), then money (9), the moving wall and the trim (10, 11), lobby and page (12, 13), tests (14) and the
file-by-file split (15).

---

## 0. The ten decisions that shape everything

1. **Fixed 60 Hz step on BOTH ends.** The server calls `ArenaGame.update(1000/60)` from its own interval with an
   accumulator (never `loop()`, which needs rAF: `paperGame.js:685-724`). The client predicts its own square with the
   same fixed step and the same stock `getMovement` (`paperGameMoves.js:49-102`), so a replay of unacknowledged inputs
   lands on the server's answer to within rounding. Rendering extrapolates the partial step, so a 144 Hz screen is as
   smooth as solo.
2. **Input is one number, 60 Hz, volatile**: `seq`, the stock 0..253 angle byte (`paperGame.js:409`), and a `hold` bit
   for cash-out. Latest wins on the server, no input queue, no added latency. The hold bit rides the input stream, so a
   lost packet heals itself 16 ms later and there is no separate start/cancel event to lose.
3. **One shared binary frame per arena per snapshot, 30 Hz, volatile** (`C.SNAPSHOT_RATE`, `shared/constants.js:7`).
   About 350 bytes for 16 squares. It carries only superseded state: position, heading, flags, percent, hold progress,
   input ack, radius, and three small counters per square (base version, trail epoch, trail count) plus a redundant tail
   of the last 4 trail corners.
4. **Geometry that must arrive goes reliable, and only when it changes**: base rings on a version bump (decimated,
   binary, cached per version), roster, kills, money, pickups. One reliable bundle per snapshot tick at most. The
   counters in the volatile frame let a client detect a miss and ask for a resend (`pp:need`), so nothing depends on a
   one-shot delta inside a droppable frame (the shooter/agar pitfall: `server/ShooterRoom.js:628-630`,
   `server/AgarRoom.js:563-567`).
5. **Everything about other squares is played back on one timeline**, `renderTick = serverTick - delay`. Reliable
   events carry the server tick and are applied when the render clock reaches it, so land never appears before the
   square that captured it gets home. Own-square events apply on receipt.
6. **The client is a mirror `P.Game`** whose `player` is the local unit, so `renderGameFrame`, `getRenderContext`,
   camera, zoom, leaderboard, minimap and `loop()` are reused byte for byte (`paperRender.js:589-636`). Mirror geometry
   is duck-typed and never committed to a grid.
7. **Money is integer micro-USDC inside the room**, moved only inside an override of `kill(victim, killer, reason)`
   (`paperGame.js:341-372`), with a conservation ledger asserted every snapshot tick. The room never touches
   `money`/`db`; it calls three hooks and `server/index.js` pays (the existing seam: `server/index.js:1289-1324`,
   `1145-1190`).
8. **The trim is optional at every step.** Untrimmed land outside the wall is a valid sim state, so the in-place trim
   validates everything before it mutates anything, skips a base on any doubt, and has two fallbacks that cannot fail
   (rebuild from a clipped copy, and a display clamp on the client).
9. **Shrinking costs no ring bandwidth.** The client clamps ring vertices to the current radius itself, which draws the
   same picture as the server's arc-replacement trim. Rings are re-sent only when a lobe is dropped or a base is
   re-seeded.
10. **Many arenas per buy-in.** A `PaperRegistry` (new, separate from the snake `ladder`, see
    `server/index.js:1600-1610`, `1702-1715`) opens a second arena at the same stake when one holds 16 humans, so a
    charged player is never refused for capacity; any other post-payment refusal is an automatic one-time refund.

---

## 1. What crosses the wire

Event prefix `pp:` (unused today; prefixes in use are listed in `understand-rooms-netcode.md`). Default namespace, no
forced transport (`CLAUDE.md` netcode section; `public/js/game.js:105-112`).

### 1.1 Client to server

| Event | Emit | Rate | Payload | Notes |
|---|---|---|---|---|
| `pp:join` | reliable | once per life | `{ name, stake, entryToken }` | `stake` is validated with `isStake` (`server/stakeRules.js:36-69`) and is the SAME number used to pick the arena and to check the token (`server/entryStore.js:49`) |
| `pp:in` | **volatile** | every predicted tick when changed, otherwise every 2nd tick (30 to 60 Hz) | one integer `seq << 16 \| angle << 8 \| flags` | `seq` u8 wraps; `angle` 0..253 validated as integer; `flags` bit0 = hold. Same shape as the snake's volatile input (`public/js/game.js:2219-2224`) |
| `pp:respawn` | reliable | on demand | `{ entryToken }` | stake comes from `socket._paperStake`, never the client (`server/index.js:2360-2370`) |
| `pp:need` | reliable | max 4 per second | `{ id, what: 'base' \| 'trail' \| 'all' }` | resync request |
| `pp:leave` | reliable | once | none | same effect as disconnect (money drops) |
| `pp:ping` | volatile | 1 Hz | `{ t }` | clock offset, echoes `{ t, tick }` |

Uplink is about 60 x 25 bytes framed = 1.5 KB/s.

### 1.2 Server to client

| Event | Emit | When | Payload |
|---|---|---|---|
| `pp:joined` | reliable | after seat | `{ you, arenaId, stake, tick, radius, holdMs, roster[], pickups[], rings: ArrayBuffer, trails: ArrayBuffer }` full world, built in the same synchronous call that does `socket.join(roomName)` so there is no gap between the payload and the event stream |
| `pp:s` | **volatile** | 30 Hz | one `ArrayBuffer` shared by the whole arena (1.3) |
| `pp:ev` | reliable | only on ticks with events | `{ tick, ev: [...], rings?: ArrayBuffer }` bundle, room-wide |
| `pp:base` / `pp:trail` | reliable | reply to `pp:need` | one ring or one full wire trail, to that socket only |
| `pp:dead` | reliable | to the victim | `{ reason, killerId, lostMicro, tick }` |
| `pp:cashout` | reliable | to the casher, exactly once | `{ gross, cut, net }` receipt (display values computed in index.js, like `cashout:result` at `server/index.js:2240`) |
| `pp:paid` / `pp:payerror` | reliable | after the chain answers | `{ sig }` / `{ message }` |
| `pp:refused` | reliable | any refusal | `{ why, refunded }` always says why (`server/index.js:2732`, `2605-2617`) |

`pp:ev` entry types (arrays, first element is the type): `['k', victimId, killerId|0, reason, micro, pickupId|0]`,
`['m', unitId, micro]` (money now), `['p+', pid, x, y, micro]`, `['p-', pid, byId]`, `['r+', {id,name,skin,bot,micro}]`,
`['r-', id]`, `['cap', unitId, gainPct]` (drives the stock "+x.xx%" label on the owner's client), `['mv', unitId]`
(re-seeded base, client snaps instead of smoothing).

### 1.3 The volatile frame `pp:s` (little-endian, one encode per arena per snapshot)

Header, 10 bytes: `u8 version`, `u32 tick`, `u16 radius*32`, `u8 unitCount`, `u8 rosterVer`, `u8 pickupVer`.

Per unit, 19 bytes plus tail:

| Field | Type | Why |
|---|---|---|
| id | u16 | stable per life; `game.units` is re-sorted every tick (`paperGame.js:445`), never send an index |
| x, y | u16 each, `round(v*32)` | arena is 2000 wide, 0.03 u resolution |
| dir | u16 of a full turn | `unit.direction` is unbounded radians (`paperGameMoves.js:63`), wrap first; u16 because the own square replays from it |
| flags | u8 | bit0 home (`in === base`), bit1 inside an enemy base, bit2 locked (cashing out), bit3 shrink-pushed this tick |
| hold | u8 | 0..255 cash-out progress, shown to everyone (a holder is a target) |
| ack | u8 | `seq` of the last `pp:in` applied to this unit (bots 0); lets the frame stay shared while each client still gets its own ack |
| pct | u16 of 1.0 | percent cannot be rebuilt from a decimated ring |
| bv | u16 | base ring version |
| te, tc | u8, u16 | trail epoch (bumps on every reset) and wire-trail point count |
| tailN + points | u8 + N x (u16,u16) | the last `min(4, tc)` wire-trail corners |

Budget: 10 + 16 x 19 + about 40 bytes of tails = about 350 B, x 30 = 10.5 KB/s per client. Rings average about
2.5 KB/s (section 3.2). A full arena costs the server about 220 KB/s egress and one encode per snapshot, which is the
"one payload per room" conclusion of the netcode notes (arena diameter 1900 fits one 2000-unit interest cell).
`shared/snapshotCodec.js` is snake-shaped (`:50-109`) so only its UMD pattern (`:36-40`) is reused, in a new
`shared/paperNet.js`.

Lever if bandwidth ever matters: 20 Hz snapshots. A square moves at constant speed with a capped turn rate of one turn
per second (`paperGameMoves.js:59`), so the worst linear-interpolation error at 20 Hz is a 0.18 u sagitta (turn radius
90 / 2pi = 14.3 u, chord 4.5 u). Kept at 30 Hz because the interpolation delay, not the error, is what the player
feels.

---

## 2. Own-square prediction and reconciliation

The square is the friendliest possible thing to predict: speed is constant (90 u/s, `paperSkins.js:196`), it never
stops except under the cash-out lock, and the only input is a wanted heading that the sim chases at a capped rate. Two
timelines that disagree about WHEN an angle arrived still travel the same distance; they differ only by heading for a
few ticks.

**Predictor** (`paperArenaPredict.js`, pure and node-testable):

```
step(state{x,y,dir}, angleByte, locked, dtMs, border, config) -> state
  scratch unit = { position, direction, target: locked ? null : pos + rot(angle*PI/127)*50, movement() }
  pieces = P.Game.prototype.getMovement.call({config, border}, dtMs, scratch)   // stock code, stock wall slide
  if outside border.radius: prepend the same inward push the server uses (shared helper in shared/paperNet.js)
```

`getMovement` reads only `config.unitSpeed`, the unit and `border` (`paperGameMoves.js:49-102`), so the client slides
along the wall exactly like solo. The target construction is `PlayerUnit.update`'s (`paperUnits.js:442-451`).

**Loop**: an accumulator runs predicted ticks at 1000/60 ms. Each tick: read the stock `InputController` through the
stock `readInput` (`paperGameMoves.js:105-133`), quantise to the angle byte exactly as `paperGame.js:409`, push
`{seq, angle, hold, stateAfter}` into a 64-entry ring buffer, send `pp:in`. The rendered own position is
`step(lastState, angle, locked, remainderMs)` on a scratch copy, so there is zero added display latency.

**Reconcile** on every `pp:s`: find own record, take `ack`. If `|server - buffer[ack].stateAfter| < 0.05 u` and heading
within 0.5 degrees, do nothing. Otherwise set state = server state, replay `ack+1 .. now` (6 to 12 cheap steps), then
hide the jump: `visualOffset = oldRendered - newPredicted`, decayed with a 100 ms time constant (the snake's "gentle
correction", `public/js/game.js:470-542`). Snap with no smoothing when the error is over 40 u or an `['mv']` event named
us. The server adds `rng()*0.01` ms per tick (`paperGame.js:406`), worth 0.0009 u, which the threshold absorbs.

**Lock**: Q down sets the hold bit and the predictor stops at once (`target = null`, the exact server mechanism:
`paperGameMoves.js:52-53`). Because the bit is part of the replayed input, prediction and server agree by construction.

**What is NOT predicted**: kills, captures, money, other squares. Two cosmetic predictions keep the own trail glued to
the square:

- `homePred = mirrorRing.inside(predPos)` per predicted tick. Own trail drawn = server wire trail (applied on
  receipt, not delayed) + predicted positions newer than the ack tick where `homePred` is false + the rendered
  position.
- Predicted home while the server still says away = "pending capture": keep drawing the trail until a new ring version
  for our base arrives or 500 ms pass. With a 60 ms round trip the land appears about 4 frames after touching home.

---

## 3. Other squares: interpolation, trails, rings

### 3.1 Interpolation

Copy the snake client's proven numbers: clock offset EMA, `INTERP_DELAY_MS` 70 plus an adaptive jitter buffer up to
180 ms, 200 ms dead-reckon cap, full reset on join (`public/js/game.js:73-84`, `361-428`, `667-702`). Position lerps and
heading slerps between the two frames around `renderTick`. When frames stop, dead-reckon along the heading at 90 u/s
(constant speed makes this nearly exact) for 200 ms, then freeze. Mirror `unit.target` = position + heading x 50 (the
renderer reads it, per `understand-solo-seams.md` 2.7).

### 3.2 Base rings

Rings change only on events: own return (`paperGameMoves.js:181-190`), being carved (`:241-248`), trim. The server keeps
`base.wireVer`. On a bump the ring is decimated ONCE (collinear filter at 0.15 u, then Douglas-Peucker at 0.4 u; the
stock `simplify` is 25 u and too coarse to draw), encoded, cached by version, and attached to that tick's `pp:ev`.
Budget guard: at most 3 ring encodes per tick, the rest wait a tick (versions coalesce), so a capture that carves five
bases cannot spike the tick. Rings reach 450 to 1851 raw vertices (probe), about 80 to 300 after decimation, 4 bytes
each. Join payloads reuse the cache.

The client applies a ring when `renderTick` reaches its tick (own base: on receipt), builds one `Path2D`, and clamps any
vertex beyond the current radius onto the wall (section 10.4). If a frame shows `bv` newer than anything received for
500 ms, send `pp:need`.

### 3.3 Trails

Raw trails gain a point per tick plus crossing points (`paperGameMoves.js:370-374`, `paperTerritory.js:94,109,130,147`)
and explode against the wall (probe: 5885 points in 25 s). The server keeps a **wire trail** per unit with a streaming
O(1) decimator: anchor A = last committed corner, d = direction of the first raw point after A; when a new raw point is
more than 0.3 u off the line (A, d), commit the previous raw point and restart; ignore points within 0.75 u of A. At the
maximum turn rate that is about 14 corners per second, typically 2 to 5. Wire corners are append-only, so an index is
stable; a reset (return, death, `recoverTail`) bumps `te` and zeroes `tc`.

Each frame carries the last 4 corners with `tc`, so new corners arrive in the same packet as the position (no lag) and
up to about 8 consecutive dropped frames heal with no request. A larger gap, or an epoch the client never saw start,
triggers `pp:need {what:'trail'}`. The client draws corners whose first-seen tick is at or before `renderTick`, then a
line to the interpolated position, rebuilding that unit's `Path2D` per frame (under 100 points).

---

## 4. The client replica

`ClientArenaGame extends P.Game` (new file). `mirror.player` = the local mirror unit, which makes `isPlayer`, the camera
focus, the HUD gate and killer-follow work unchanged (`paperGame.js:566-581`, `680-682`; `paperRender.js:629-635`).

- `update(dt)` is replaced: run the predictor ticks, advance `renderTick`, apply due timeline events, interpolate
  remotes, then run only the cosmetic subset of the stock tick (labels `paperGame.js:449-452`, particles `:453`, camera
  scale ease `:523-525`, per-unit `scale` from percent `:421`), sort `units` by percent and set `top`.
- Mirror units hold duck-typed geometry: `base.polygon {path, bounds, segments[{start,end}], simplify}` and
  `track.polyline {path, bounds, segments, start}`; that is all the renderer and `spawnDeathParticles` read
  (`paperRender.js:296-323`, `paperGame.js:353-356`). Nothing is committed to a `SpatialGrid`, which avoids the
  double-remove hazard (`paperGeom.js:390-397`).
- Death: on `['k']` at its tick, call the stock `P.spawnDeathParticles` on the mirror unit, then drop it. Crumbs use
  `P.Particle.emitCrumb` when a remote square is inside an enemy base (flag bit1).
- `render()` override: `super.render()`, then the HUD overlay (section 13). `getRenderContext()` is overridden only to
  cache its result, because the stock call eases the camera (`paperGame.js:543-547`) and must run once per frame.
- The mirror border is a `SafeArenaBorder` rebuilt when the frame radius moves 0.25 u (0.023 ms per rebuild, probe), and
  `mirror.square` is recomputed with it (`paperGame.js:77` computes it once only).
- Boot: `createGameApi` hardcodes `new P.Game` (`paperMain.js:86`) and `ensureCanvas` is private (`:425-434`), so the
  page has its own boot file and reuses `registerLanguages`, `pickDefaultLanguage`, `hudPreloadText`, `whenFontsReady`
  (`paperMain.js:489-495`).

---

## 5. Server sim: reuse and seams (solo files untouched)

`server/paper/loadSim.js` requires the seven sim files in page order (`public/paper.html:52-59`; they are IIFEs that
write `globalThis.DuelPaperLib`, `paperGame.js:1-3`), calls `P.installGameMoves()` once, returns `P`. No per-arena state
may live on `P`.

`server/paper/ArenaGame.js`:

- `class ArenaGame extends P.Game`, built with `controller = null`, `view = null`, `visible = false`, and `player`
  never set, which leaves every player-only block dormant (`paperGame.js:108-115`, `369-371`, `454-461`, `526-532`;
  `paperGameMoves.js:106-107`). `addPlayer` and `spawnPlayer` are never called (`spawnPlayer` evicts an arbitrary unit
  and retries forever, `paperGame.js:232-247`).
- `class ArenaHuman extends P.GameUnit`: `uid`, `angle`, `locked`, `holdStart`, `micro`, `wallet`, `sid`, `isHuman`.
  `update(dt)`: `super.update(dt); this.log.length = 0;` then `target = locked ? null : heading(angle) * 50 + position`.
  Bots get the same `log` wipe in the post-hook (`paperUnits.js:355,387` grows forever otherwise).
- `class SafeArenaBorder extends P.ArenaBorder`: `setRadius(r)` (rebuild polygon, `calcPath`, caller recomputes
  `game.square`), and an `intersections()` call counter reset per `getMovement`, returning `[]` past 12 calls. This
  caps the stock wall-slide loop that spins forever on an exact wall vertex (`paperGameMoves.js:70-99`; probe froze node
  at tick 633). Spawns and pushes also avoid exact symmetric coordinates (add a 1e-3 irrational offset).
- Overrides (all prototype methods, so no solo edit): `update` (wrap), `kill` (money, shrink veto), `getMovement` (push
  piece + loop-guard reset), `recoverTail` (run the stock body for every human; needed after trims), `handleReturn`
  (super, then flag the base for trimming, because trails laid before a shrink merge as land outside the wall; probe:
  5367 of 6469 vertices), `spawnBot` (paid: empty body, the second lock on THE ONE RULE).
- `spawnHuman(name, skin)`: up to 40 tries of `getSpawnPosition('random', baseRadius)` (`paperGame.js:121-174`, reads
  the live radius); free arena may first evict one `BotUnit` with reason 6; returns `null` on failure. `findSpawn()` is
  the dry-run half, called BEFORE the token is consumed.
- **`Vec2.space` rule**: it is one process-wide static (`paperGeom.js:293,386,518`) that `update` re-points only at the
  top of a tick (`paperGame.js:404`). Every public mutator of the arena (`join`, `leave`, `cashOut`, trim entry points)
  starts with `P.Vec2.space = this.space`. Node is single-threaded and ticks are synchronous, so a socket handler can
  never interleave with another arena's tick; the explicit set is sufficient and keeps the join synchronous, which the
  money path needs (seat decided, token consumed and unit created in one call chain).

Tick: `setInterval(16)`; `acc += now() - last`; run `min(4, floor(acc / DT))` steps of exactly `DT = 1000/60`, drop the
excess. Every deadline (hold, easing, sweep, warm-up, pickup age) reads `room.now()` so tests step a fake clock
(`server/ShooterRoom.js:157-164`, `test/shooter.test.js:8-17`). Cost: 0.074 ms per tick with 16 squares (probe), about
0.5 percent of a core per busy arena, so roughly 100 busy arenas per core before encode cost.

Same-tick ordering is rank order (`paperGame.js:445`, `paperGameMoves.js:333-336`). It is reference behaviour; with
money on it, it is documented in the page's help text rather than changed.

---

## 6. Room lifecycle and registry

`server/PaperRoom.js` (one arena: sockets, tick, ledger, pickups, holds, hooks, wire) and `server/PaperRegistry.js`
(arenas per stake). NOT in the snake `ladder`: its `makeRoom` builds a `GameRoom` and the solvency sum walks
`room.snakes` (`server/index.js:1600-1610`, `1702-1715`), and `LobbyRegistry` is one room per key
(`server/LobbyRegistry.js:31-52`) while Paper needs several.

- `registry.pick(stake)`: the fullest arena under 16 humans; ties go to the one holding floor money; none fits: create
  one (cap 8 per rung = 128 seats). Only this server's `REGION` (`server/index.js:1132-1138`).
- The room carries a numeric `stake`; `isFree()` is `stake === 0`; `botsAllowed()` returns `isFree()`; `topUpBots`
  deletes every bot first and unconditionally in a paid room, `addBot` returns null there
  (`server/GameRoom.js:76-107`, `137-143`, `377`). Config: `botsCount` 16 free, 0 paid (`paperGame.js:184`). Paper does
  not register with `server/botPopulation.js` (snake-only budget).
- Free arena: warmed once at creation in chunks of 100 updates per `setImmediate` (6000 updates cost 474 ms on the dev
  PC and would stall snake and agar on the shared thread; `paperMain.js:108-131`). With no humans it stops ticking and
  keeps its world frozen, so the next joiner owes no warm-up; `/api/live` reports the bot floor of an idle arena like
  the shooter (`server/index.js:1396-1411`).
- Paid arena: stops ticking with no humans. Swept after 5 empty minutes ONLY when `liveStakeTotal() === 0`. An empty
  arena with money on the floor stays listed and is the first pick for the next buyer at that rung, so the money is
  found, not destroyed (contrast `server/LobbyRegistry.js:84-95`).
- `removePlayer` calls `socket.leave(roomName)` (copy `server/GameRoom.js:262`, not the shooter).
- Console surface for `ALL_ROOMS`/`roomLabel` (`server/index.js:823-871`): `lobbyType` (`paper_s0`, `paper_s0_1`,
  `paper_s1`), `playerCount`, `botCount`, `addBot`, `clearBots`. For the maintenance drain the room exposes
  `liveEntities()` returning `{alive, isBot, worth}` records and `ops.drainStatus` gains one line to read it
  (`server/ops.js:57-66` only reads `room.snakes` today).
- No reconnect grace. Brief rule 5 says a disconnect drops the money, and a held square would be a stationary target.
  The client shows a "connection lost, your money dropped where you stood" screen; it never re-emits a used token
  (the Knockout client's mistake, `public/js/knockout.js:512-536`).

---

## 7. Socket handlers in `server/index.js` (one owner)

State on the socket: `_paperRoom`, `_paperStake` only (avoid the names listed in `understand-rooms-netcode.md`). The
payout wallet lives on the ROOM's player record, because the snake keeps it on the socket and loses it on reattach
(`server/index.js:2093-2104`, `2237`).

`pp:join`, strictly in this order (the snake's PLAY order, `server/index.js:2050-2140`):

1. `socketRL(socket, 'ppjoin', 1000)`; `sanitizeName`; `stake = Number(stake)`; refuse unless `isStake(stake)`.
2. Already seated and alive: ignore (duplicate guard, `:2051-2055`). Never the shooter's remove-then-add
   (`:2716-2717`), which would dump a paid player's money on the floor.
3. Maintenance: say why (`:2072-2075`). 4. `room = paperRegistry.pick(stake)`. 5. `spot = room.findSpawn()`.
6. Steps 3 to 5 failed and `stake > 0`: consume the token and **refund in full** through `paperRefund` (section 9.6),
   emit `pp:refused {why, refunded:true}`. A charged player gets a seat or a refund.
7. `entry = consumePaidEntryAtStake(entryToken, stake, 'paper')` (`:395-412`; this also writes `db.recordStake` through
   `recordEntry`, keeping the single `db.recordStake(` call the text test counts, `test/v2route.test.js:158-171`). Not ok
   and `stake > 0`: `pp:refused {why:'Entry fee not verified'}`, never a free seat (`:2605-2617`).
8. `room.addPlayer(socket, name, { micro: Math.round(entry.worth * 1e6), wallet: entry.walletAddress }, spot)`. Free:
   `micro 0`, `wallet null`. Then `socket._paperRoom`, `socket._paperStake`, `socket._walletAddress =
   entry.walletAddress` (token only, like the six existing sites).

`pp:respawn`: same steps with `stake = socket._paperStake`, same arena if it has room. `pp:in`: integer check, then
`room.setInput`. `disconnect`: one line next to `endShooter` (`:2835`): `leavePaper(socket)`.

---

## 8. Bots (free arena only)

Version 1 ships with zero solo edits: bots expand, defend and kill by accident, but never enter `attack` because
`game.player` is null (`paperBots.js:43-55`, `330-357`). The long-trail magnet (`paperGame.js:502-522`) is reproduced
per human in the `ArenaGame.update` post-hook. A separate, last task adds the one-line `preyFor` hook at
`paperBots.js:44`, `:335` and `paperUnits.js:480` (a strict no-op in solo: no draw added, no order changed) and re-runs
the golden parity by hand (`paperio-reference/spec/BUILD-BRIEF.md:23,68`). It is the only change to a solo file in the
whole build and it is isolated so it can be dropped.

---

## 9. Money

### 9.1 Entry and the label
Worth and wallet come only from the consumed token (section 7, step 7). The ladder path mints the exact rung
(`server/index.js:569-571`, `583`), so a fresh player reads exactly `$0.10`. Inside the room money is integer micro-USDC
(`100000`, `1000000`); labels are `(micro / 1e6).toFixed(2)`. The free arena keeps `micro = 0` and shows no label, so
every `worth > 0` guard in the payout path stays inert (`server/index.js:2226`, `2241`). Q still works in free and
simply leaves, which lets the owner test the hold for nothing.

### 9.2 Kill transfer: the `kill` override
```
kill(victim, killer, reason):
  if (victim.death) return                               // one capture can call kill twice (paperGameMoves.js:196-201)
  if (reason === 2 && this.shrinkVeto(victim)) { this.rescue(victim); return }     // section 10.3
  if (victim.isHuman && reason === 6) return             // a staked human is never "system removed" (paperGame.js:232-238)
  const m = victim.micro | 0;  victim.micro = 0          // zero FIRST, same synchronous step
  super.kill(victim, killer, reason)
  if (m > 0 && reason !== CASHOUT) {
    if (killer && !killer.death && killer.isHuman) { killer.micro += m; room.onTransfer(victim, killer, m, 'kill') }
    else room.dropPickup(victim.position, m, victim)     // reasons 1, 2, DISCONNECT, LEAVE, or a vanished killer
  }
  room.queueDeath(victim, killer, reason, m)
```
New reasons `CASHOUT = 7`, `DISCONNECT = 8`, `LEAVE = 9` pass through the base safely (it only compares against 6 and 0,
`paperGame.js:353,369`; probe). For a self cross the victim's position is already the crossing point
(`paperTerritory.js:232`), which is where the cash lands. `REASON_WIN` is unreachable with `player` null.

### 9.3 Pickups
`{pid, x, y, micro, srcWallet, srcName, bornAt}`. Each tick, after `super.update`, every living human within 12 u of a
pickup takes it; two in range on the same tick: the nearer one, then rank order. `collector.micro += p.micro`,
`room.onTransfer(src, collector, micro, 'pickup')`. Pickups are never culled or aged out (`server/Food.js:173-190` is the
precedent) and are moved radially to `radius - 20` when the wall passes them. They cannot exist in the free arena.

### 9.4 Cash-out hold (server clock, tick driven)
On each tick per human: hold bit set and `holdStart == null`: `holdStart = now()`, `locked = true`. Bit clear:
`holdStart = null`, `locked = false`. `now() - holdStart >= C.CASHOUT_HOLD_MS` (3000, `shared/constants.js:22`):
`room.cashOut(unit)`. The hold lives on the unit and dies with it, so the snake's die-mid-hold, respawn, instant cash-out
bug (`server/index.js:2147-2150`, `2209-2213`) cannot occur. A locked square can be killed; the money then moves by 9.2.

`room.cashOut(unit)`: re-check alive and elapsed; `m = unit.micro; unit.micro = 0;`
`kill(unit, undefined, CASHOUT)` (land and square removed, no credit, no pickup: brief "Decisions"); `ledger.out += m`;
`hooks.onCashout({sid, wallet, name, micro: m, stake, arenaId})` exactly once, synchronously.

### 9.5 Payout in index.js: `paperPayout(rec)`, a sibling of `doCashout` (`server/index.js:2209-2264`)
`worth = rec.micro / 1e6`; `cut = worth * 0.10`; `trackEarning({source:'game_rake', game:'paper', amountUsdc: cut,
wallet, name, lobbyType, region: REGION})` and `sweepRake(cut, 'paper ...')` (`:35-55`, `:2221-2233`); emit `pp:cashout`;
`money.withdraw(rec.wallet, worth - cut)`; then `db.recordEarnings(...)` and `pp:paid` on success; on failure
`db.recordFailedPayout(wallet, amount, name, reason, e.broadcast)` and `pp:payerror`, no resend (the NA drainer
recovers, `:1972-1996`). `rec.micro <= 0` or no wallet: receipt of zero and return.

### 9.6 Refund: `paperRefund(wallet, worth, name, why)`
Full worth, no rake, `money.withdraw`, `recordFailedPayout` on failure, no retry, NOT recorded as earnings (do not copy
`koSend`, `server/index.js:1245`).

### 9.7 Collusion, solvency, conservation
- `hooks.onTransfer` calls `collusion.record(srcWallet, dstWallet, micro / 1e6, { lobbyType })`
  (`server/CollusionMonitor.js:42-52`). Account id is the token-verified wallet, not the client-supplied `_googleId`. A
  player collecting their own dropped cash has equal ids, which the monitor ignores.
- `sumLiveSelfCustodyStakes` gains `total += paperRegistry.liveStakeTotal()` = human `micro` plus pickup `micro` over
  all arenas, divided by 1e6 (`server/index.js:1702-1728`). This also feeds the EU push and `/admin/finance`.
- Ledger per arena: `in === sum(unit.micro) + sum(pickup.micro) + out`, checked every snapshot tick; a mismatch logs
  `[PAPER] LEDGER` with the numbers and alerts the owner, never throws in production.

---

## 10. Arena radius by head count

### 10.1 Target and easing
`radiusFor(n) = clamp(950 * sqrt(n / 16), 475, 950)`, n = squares alive including bots (pure function in
`shared/paperNet.js`). Growth 40 u/s, shrink 4 u/s (one lost player at n = 16 is 30 u, about 7.5 s). The free arena sits
at 16 squares, so it stays at 950 and bots never meet a moving wall.

### 10.2 Every radius step (`understand-solo-seams.md` 5.2)
`border.setRadius(r)`; `game.square = border.polygon.square()` (`paperGame.js:77`, `259`, `418-421`); centre stays
(1000, 1000), r at most 950 (`SpatialGrid.cell` does not clamp, `paperGeom.js:304-310`). Applied every tick (cheap);
shrink work (push, pickups, trim) is separate.

### 10.3 Push and the wall-death veto
`getMovement` override: when a unit is beyond the radius, prepend `Segment(position, inwardPoint)` with `inwardPoint`
just inside the apothem (`r * cos(pi/300) - 0.05`, plus the tiny irrational offset), compute the rest from there, and
return `[push].concat(rest)`, so the push goes through the normal crossing dispatch and `in` flags stay right (probe:
zero overshoot from 950 to 800). It applies to locked units too. A naive push kills wall-hugging squares through the
stock self-cross rule as reason 2 (`paperTerritory.js:225-238`; probe: death on the first shrink step), and owner rule 6
says nobody dies from the shrink. So `shrinkVeto(victim)` is true while the radius is falling and for 1.5 s after;
`rescue` wipes the victim's trail and lets `recoverTail` put it home if needed. Pressing into a STATIC wall can still
kill, exactly as solo does.

### 10.4 The client side of a shrink
The frame carries the radius. The client rebuilds its border and DESTRUCTIVELY clamps stored ring vertices beyond it onto
the wall when it rebuilds a path. That is the same picture as the server's arc replacement, so a plain trim sends no
ring. When the target flips from shrinking to growing, the server re-sends every wall-touching ring once, which removes
any drift between the two.

---

## 11. The TRIM

Percent carries no money (money moves only by kill, pickup and cash-out), so the trim is best effort. The rule that makes
it safe: **compute and check everything first, mutate last, and treat "skip this base this pass" as a normal outcome.**

**When**: a pass runs at most every 250 ms, when the radius has fallen 0.5 u since the last pass, or a base is flagged by
the `handleReturn` override. At most 4 bases per pass. `server/paper/arenaTrim.js`, pure functions over `(P, game, base)`.

**Tier 1, in-place trim with the sim's own primitives** (the carve pattern, `paperGameMoves.js:207-255`):

1. Classify each ring vertex as outside with a radial shortcut: inside the apothem is in, beyond r is out, in between
   test the single wall edge of that angular sector (the wall is a convex regular 300-gon, so one half-plane test is
   exact). Tolerance 1e-7 counts as inside so old on-wall vertices stay. The wall is convex, so an edge with both ends
   inside is wholly inside; vertex tests are enough. No vertex out: done.
2. Crossings: for each in/out edge, the exact hit with `border.polygon.intersections(edge)` (`paperGeom.js:748-764`), hit
   nearest the inside end; record wall angle and type (exit or entry in ring order).
3. Pieces by Weiler-Atherton against a convex clip: from an entry crossing follow the inside run to its exit, then walk
   the wall in ring orientation to the NEXT entry crossing by angle, repeat until closed. One piece is the common case.
   Several pieces means a concave base was cut in two; keep the piece containing the owner's anchor (position when
   home, else `track.polyline.start`), the carve rule (`paperGameMoves.js:237-246`). This is what prevents a ring that
   doubles back along the wall.
4. The kept piece defines spans: for each of its wall arcs from exit E to entry N, the ring span E..N (outside runs and
   any dropped lobes between) will be replaced by the chord `[E, fresh clones of the wall vertices between, N]`. Wall
   vertices are cloned because the border polygon is never committed and is rebuilt every step
   (`paperTerritory.js:14-29`).
5. Guards, all checked before any mutation; one failure skips the base this pass:
   - away owner's exit vertex (`track.polyline.start`) is not inside a span (return looks it up by identity,
     `paperGameMoves.js:163-164`);
   - no vertex in a span has a segment owned by a live foreign trail (`seg.shape.owner.isTrack`), since those pair
     entries and exits in a later carve (`paperGameMoves.js:257-311`);
   - kept piece area at least 700 u^2 (a quarter of a spawn base), else Tier 2b;
   - a wall arc wider than 150 degrees is ambiguous, go to Tier 2a.
6. Mutate: `ring.insert(edge, E)` and `ring.insert(edge, N)` (`paperGeom.js:682-690`); if a span wraps index 0, rotate
   `ring.segments` first (a pure array rotation; nothing stores ring indices between calls, they are always looked up by
   identity, `paperGameMoves.js:163-164`, `220-221`), which avoids `right()` and its remove-everything path
   (`paperGeom.js:730-740`); then `ring.left(chord, idx(E), idx(N))` (commit new, remove old, `:717-727`). Kept vertices
   keep their `Vec2` objects, and no segment is removed twice (`:390-397`).
7. `base.calcSquare()` (exact, no drift; `paperTerritory.js:59-61`), `ring.calcPath()`, then any unit with
   `in === base` that is no longer inside gets `in = null` (mirrors `paperGameMoves.js:250-254`).
8. Post-check: at least 3 segments, each `end === next.start`, every `shape === ring`, no NaN, area above zero. A failure
   here goes straight to Tier 2a.

**Tier 2a, rebuild from a clipped copy (cannot fail)**, used when guards have failed for 3 s running or a post-check
fails: clip a plain copy of the ring to the wall, `ring.remove()`, `new P.Polygon(newVec2s)`, `commit(base)`,
`calcSquare`, `calcPath`. Then sanitise references so no later code meets a stale identity: if the owner is away, wipe
its trail and mark it home at a point inside (what `recoverTail` does, `paperGameMoves.js:137-149`); for every other
unit, delete its `track.intersections` entries for this base and clear `in` if it pointed here. A capture in flight
then simply does not carve this base: `handleReturn` finds no foreign segments on those vertices because the old ring's
segments are gone (`paperGameMoves.js:263-266`). Nobody dies and no money moves.

**Tier 2b, base wholly outside or too small**: re-seed a spawn circle (50-gon, radius 30, `paperSkins.js:190-191`).
First choice: centred on the pushed-in owner, at least 40 u inside the wall, rejected if any of its points is inside
another base, trying 8 nudges along the wall and inward. Second choice: `getSpawnPosition('random', baseRadius)`, 40
bounded tries, which guarantees no overlap; the client gets `['mv']` and snaps. Neither works: leave the base as it is
and retry next pass.

**Tier 3, display clamp**: always on, on the client (10.4). Even a base that is never trimmed looks right, and its
`pct` on the wire is computed from the clamped area.

---

## 12. Lobby wiring for Free, $0.10, $1.00 (one owner)

- **Page**: new `public/paper-arena.html` on the single-segment route `/paper-arena` (relative script urls, as
  `public/paper.html:8-10,52-61`). `/paper` and `paper.html` stay untouched for parity (`server/index.js:1123`).
- **Widget**: add `paper: '/paper-arena'` to `PAGES` (`wallet-widget/src/main.jsx:217-219`); today a paid Paper launch
  falls through to `/game.html` and would spend the token in the snake rung. Then `npm run build` and commit
  `public/wallet/widget.js` (the deploy does not build, `.github/workflows/deploy.yml:34-35`).
- **play.js**: remove `paper` from `OWN_PAGE` (`public/js/v2/play.js:274`) so all three rungs take the widget path, where
  stake 0 short-circuits to an empty token and the full hand-off is written to sessionStorage
  (`wallet-widget/src/main.jsx:187-209`). This also removes the stale-sessionStorage trap of the shortcut
  (`play.js:281-296`). `play.js` keeps its forbidden-string rule (`test/v2route.test.js:215-233`).
- **`/api/live`**: a new `livePaperBoard()` returns three always-present rows `{ id: 'paper:na:s0.1', game: 'paper',
  region, stake, players, bots, capacity: null, state: 'open' }` summed over that rung's arenas, and the route returns
  `liveBoard().concat(livePaperBoard())`. `liveBoard` itself is not reshaped (text-pinned, `test/v2route.test.js:197-213`).
- **v2.html**: catalogue row becomes `built:1, ladder:1` plus a new `nolook:1` flag that hides the snake colour row
  (`public/v2.html:2165`, `1862-1866`); `solo` and `soloNote` go. `startFromDetail` then takes the arena branch and
  sends the chosen rung (`public/v2.html:3302-3312`, `public/js/v2/play.js:320-359`).
- **board.js**: replace the pinned `paper:free` lobbyType row (`public/js/v2/board.js:127-130`) by pinning the real
  stake 0 row, as an ADDED line (the snake pin text is asserted verbatim, `test/v2route.test.js:806-822`).
- **test**: rewrite `test/v2route.test.js:1132-1137` in the same commit.
- **Page contract**: read `playerName`, `stake`, `entryToken`, `region`, `walletAddress` from sessionStorage once, then
  remove `entryToken`; exit with the exact string `'game:done'` (`public/js/v2/play.js:427-433`); paid "Play again" posts
  `{type:'duel:restake', game:'paper', stake}` and awaits `duel:restake:done` (`wallet-widget/src/main.jsx:355-378`,
  `public/js/game.js:2031-2046`); call `window.focus()` on load and first pointer down so Q works without a click.
- Optional, same owner as index.js: split `entryFeeLimiter` (one shared 10/min bucket for quote and submit,
  `server/index.js:359`, `513`, `544`) so fast die-and-rebuy is not throttled at five entries a minute.

---

## 13. HUD additions (overlay pass after the stock renderer)

World-space pass: re-apply the stock transform (`paperRender.js:599-604`) from the cached render context.
- **Money over heads**: a gold pill `$0.20` above the stock name (`drawUnitName`, `paperRender.js:141-168`), same HUD
  scale maths, hidden at zero. A 300 ms count-up when an `['m']` event lands, and a `+$0.10` floater on a kill.
- **Cash pickups**: a coin with its amount, gentle bob, drawn above land and below squares.
- **Cash-out ring**: an arc around the square, radius 26 u, driven for the own square by the local hold clock (capped at
  97 percent until `pp:cashout` arrives) and for others by the frame's `hold` byte.
Screen-space: "Hold Q to cash out $0.20" hint, a centre banner while holding ("Cashing out, release to cancel"), a kill
feed fed by `['k']`, and the receipt, death and disconnect screens as DOM.
- **Touch**: a 72 px DOM hold button bottom right with its own progress ring; `pointerdown` sets hold, `pointerup`,
  `pointercancel`, `pointerleave` and `blur` clear it; `touch-action: none`. It cannot steer because the stock
  controller listens on the canvas only (`paperInput.js:49-58`). Q follows the stock key rule
  `evt.target === document.body` (`paperInput.js:87-97`) and ignores key repeat.

---

## 14. Tests (flat in `test/`, `node:test`, no helpers in `test/`; shared doubles live in `server/paper/testkit.js`)

Every room test: construct, `stop()`, strip bots, step `tick()` on a subclassed `now()`; stub `Math.random`; call
`game.stop()` in `t.after` (the constructor starts a timer, `paperGame.js:95-97`). Float sums use a 1e-9 tolerance;
micro-unit sums use strict equality.

| File | Proves |
|---|---|
| `paperNet.test.js` | `radiusFor` table (4 -> 475, 16 -> 950, monotone); frame, ring and trail codecs round-trip; input integer pack |
| `paperPredict.test.js` | predictor equals the server `ArenaHuman` over 600 fixed ticks of random angles including wall slides; replay after a dropped input converges under 0.05 u; lock gives zero displacement |
| `paperArenaGame.test.js` | human steers from its own byte; two arenas do not corrupt each other's grid; wall-vertex hang is capped; `log` stays empty; `spawnHuman` is bounded and never evicts a human |
| `paperWire.test.js` | trail decimator stays within 0.3 u of the raw trail and is append-only; epoch bumps on return; ring cache re-encodes once per version; a client fed frames with 8 drops rebuilds the same trail; `pp:need` path |
| `paperRoomMoney.test.js` | kill transfer, stacked transfer, double `kill` call pays once, multi-victim capture, no-killer drop, pickup collect, nearer-wins tie, disconnect drop, ledger holds on every tick of a 5000-tick random game |
| `paperRoomHold.test.js` | hold locks movement, release cancels, 2999 ms pays nothing, 3000 ms calls `onCashout` exactly once with worth already zero, death mid-hold then respawn does not cash out, free room never pays, receipt is reliable and single |
| `paperTrim.test.js` | simple bulge, wrap past index 0, concave split keeps the anchor piece, away-owner exit vertex guard skips, foreign trail guard skips, Tier 2a leaves a valid committed ring and a later capture does not throw, Tier 2b re-seed without overlap, nobody dies across a 950 -> 475 shrink with 16 wandering units |
| `paperRegistry.test.js` | 17th human opens a second arena; paid rooms have zero bots whatever is asked; empty paid arena with floor money is not swept and is picked first; `liveStakeTotal` counts pickups |
| `paperJoinSmoke.test.js` | real server on a random port (`DATABASE_URL=''`, `NTFY_DISABLED=1`): free join gets `pp:joined` and frames; paid join without a token is refused with a reason; the hold is "not early" (`test/cashoutHold.test.js:103-116`) |
| `v2route.test.js` (edit) | Paper card is `built:1 ladder:1`, not solo; `PAGES` in the built bundle contains `paper` |

Manual gate: the solo golden parity and solo node tests in `../paperio-reference/harness/tests` are re-run by hand
before every commit that touches `public/js/paper/` (only task H does).

---

## 15. File-by-file breakdown (no two owners share a file)

Phase 0 lands first and alone because everyone builds against it. After that A to G run in parallel; H is last.

| Task | Owner | Files (all new unless marked) | Depends on |
|---|---|---|---|
| 0 Wire contract | Net | `shared/paperNet.js` (UMD: event names, constants, `radiusFor`, `pushPoint`, frame/ring/trail codecs, `fmtMicro`), `test/paperNet.test.js` | none |
| A Sim seams | Sim | `server/paper/loadSim.js`, `server/paper/ArenaGame.js`, `server/paper/testkit.js`, `test/paperArenaGame.test.js` | 0 |
| B Trim | Geometry | `server/paper/arenaTrim.js`, `test/paperTrim.test.js` (calls into A through two methods: `game.trimPass()`, `game.flagForTrim(base)`) | A's class skeleton |
| C Wire builder | Net | `server/paper/arenaWire.js` (wire trails, ring decimate and cache, frame and join payload builders), `test/paperWire.test.js` | 0, A |
| D Room and registry | Room | `server/PaperRoom.js`, `server/PaperRegistry.js`, `test/paperRoomMoney.test.js`, `test/paperRoomHold.test.js`, `test/paperRegistry.test.js` | 0, A, C (B behind a flag) |
| E Server wiring and money | Money | EDIT `server/index.js` (require, registry, `pp:*` handlers, `paperPayout`, `paperRefund`, `leavePaper` in disconnect, solvency term, `ALL_ROOMS`, `roomLabel`, `livePaperBoard`, `/paper-arena` route, optional limiter split), EDIT `server/ops.js` (one line), `test/paperJoinSmoke.test.js` | D's hook signatures (fixed in this doc, 9.4 to 9.6) |
| F Client | Client (can be two people by file) | `public/paper-arena.html`, `public/js/paper/mp/paperArenaBoot.js` (shell, sessionStorage, screens, restake, exit), `paperArenaNet.js` (socket, clock, frame buffer, event timeline, `pp:need`), `paperArenaMirror.js` (`ClientArenaGame`, mirror units, interpolation, paths, clamp), `paperArenaPredict.js` + `test/paperPredict.test.js`, `paperArenaHud.js` (money, ring, pickups, feed, touch button) | 0 |
| G Lobby | Lobby | EDIT `public/v2.html`, `public/js/v2/play.js`, `public/js/v2/board.js`, `wallet-widget/src/main.jsx`, rebuilt `public/wallet/widget.js`, `test/v2route.test.js` | E's `/api/live` rows and route name (fixed here) |
| H Bots hunt humans | Sim | EDIT `public/js/paper/paperBots.js:44,335`, `paperUnits.js:480` (the `preyFor` no-op hook), `ArenaGame.preyFor`; golden parity by hand | everything else shipped |

Integration order: 0, then A + F(predict, mirror against recorded frames) + G in parallel, then C, D, then E, then B
switched on, then H. The arena is playable without B (the display clamp hides untrimmed land) and without H.

---

## 16. Defaults chosen here that the owner may want to overrule

1. Money left on the floor of an emptied paid arena waits there for the next buyers at that rung; it is never swept to
   the house.
2. No reconnect grace: a dropped connection drops the money at once (brief rule 5 read literally).
3. The free arena shows no money label; Q there just leaves.
4. Any refusal after a valid payment (full, maintenance, no spawn spot) refunds 100 percent automatically.
5. Everyone can see a cash-out ring on a holding player.
6. A deploy restart still loses in-memory worth (existing limitation, `server/ops.js:19-23`); Paper is made visible to
   the drain status so the owner console warns first.
