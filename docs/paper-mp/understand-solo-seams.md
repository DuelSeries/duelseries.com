# Paper multiplayer: the solo sim and its single-human seams

Written 2026-09-20 from a full read of `public/js/paper/*.js`. Every claim about existing code carries a
`file:line` cite. Paths are relative to `public/js/paper/` unless shown otherwise. "Probe" means a throwaway
node script I ran against the real files (nothing in the repo was edited); the numbers are from this PC.

Binding brief: `docs/paper-multiplayer-brief.md`. Parity rule: the solo page, its golden runs and its node tests
must stay untouched, so every seam below is either (a) a subclass override in a NEW file, or (b) a one-line hook in
a solo file that is a strict no-op when the hook is absent (no extra `Math.random` or `game.rng` draw, no change in
iteration order, because the goldens count draws: `../paperio-reference/spec/BUILD-BRIEF.md:23,68`).

## 0. The short version

1. The sim already runs headless under node with SEVEN files and no DOM: `paperGeom, paperTerritory, paperBots,
   paperUnits, paperGame, paperGameMoves, paperSkins` (load order as in `public/paper.html:52-59`). They are IIFEs
   that write to `globalThis.DuelPaperLib`, not CommonJS modules (`paperGame.js:1-3,728`). `createGameApi` refuses to
   run without `Path2D` (`paperMain.js:71`), so the server builds `new P.Game(...)` itself.
2. With `game.player = null`, `controller = null`, `view = null`, `visible = false`, the stock `Game.update(dt)` is a
   complete server tick: every player-specific block is already guarded (section 2). Multi-human support therefore
   fits in a subclass (`ArenaGame extends P.Game`) that wraps `update`, and overrides `kill`, `getMovement`,
   `recoverTail`, `handleReturn`, `spawnBot`. All of these are prototype methods, so no solo edit is needed for them.
3. A human is a `GameUnit` subclass that steers from its OWN quantised angle instead of `game.angle`
   (`paperUnits.js:442-451`). Cash-out movement lock is `target = null`: `getMovement` returns no pieces when
   `unit.movement()` is falsy (`paperGameMoves.js:52-53`, `paperUnits.js:422-424`). Probe: locked unit moved 0.000.
4. `kill(victim, killer, reason)` (`paperGame.js:341-372`) is the single choke point for every death, so it is the
   money hook. `killer` is set for reasons 3, 4, 5 and undefined for 1, 2, 6.
5. Bots: `config.botsCount` alone controls them. Probe: `botsCount: 0` gives 0 units forever, `botsCount: 16` fills to
   16 total (humans in `units` count toward the cap because `player` is null, `paperGame.js:184`).
6. Process-wide statics are the biggest trap: `Vec2.space` is ONE static for the whole process
   (`paperGeom.js:293,386,518`). Probe: building a second arena silently re-points it. Any geometry change made
   outside `update()` (join, leave, cash-out, trim) must set `P.Vec2.space = arena.space` first.
7. The wall loop in `getMovement` can spin forever when a step lands exactly on a wall vertex (probe, section 6).
   One frozen tick freezes every game and every money path in the process. Guard it in the arena's border subclass.
8. Shrinking the wall needs four things the solo game never does: rebuild the border polygon, recompute
   `game.square`, push outside units in, trim land. A naive inward push KILLS wall-hugging units through the normal
   self-cross rule, so the arena must veto reason 2 (wall) deaths while shrinking (probe, section 5.4).
9. Territory percent carries no money under the owner's rules (money moves only by kill, pickup, cash-out), so the
   trim can be best-effort and conservative. It must never break the ring invariants in section 5.5.

## 1. How the solo sim is wired

| File | Role | Server needs it |
|---|---|---|
| `paperGeom.js` | Vec2 (vector AND shared graph vertex, pooled), Segment, SpatialGrid, Polyline, Polygon, `makeCirclePoints`, seeded LCG, kill reason constants (`:1078-1084`) | yes |
| `paperTerritory.js` | `ArenaBorder`, `TerritoryBase`, `UnitTrack` | yes |
| `paperBots.js` | bot state machine table `P.botBrainStates` | yes (free arena) |
| `paperUnits.js` | particles, score schemes, `GameUnit`, `PlayerUnit`, `BotUnit`, labels, name pool | yes |
| `paperGame.js` | `Game`: spawn, kill, update, camera context, rAF loop | yes |
| `paperGameMoves.js` | mixed into `Game.prototype` by `installGameMoves` (`:453-457`): `getMovement, readInput, recoverTail, handleReturn, handleUnitMovements, unifyHitPoints, dispatchBucket` | yes |
| `paperSkins.js` | skins AND `P.defaultPaperConfig` (`:183-224`) AND the 36 colour palette (`:226-233`) | yes, for config + colour names |
| `paperInput.js` | `InputController` (DOM listeners) | no |
| `paperRender.js` | canvas renderer, reads the Game, never writes sim state except `topListChanged` (`:501-502`) | no |
| `paperMain.js` | solo session API, warm-up, page shell | no |

Node loading facts (probe):
- `new P.ColorSkinPool(undefined)` skips the DOM canvas work (`paperSkins.js:372-379` is guarded by `if (config)`), so
  `new P.SkinManager(new P.ColorSkinPool(undefined), new P.ClassicSkinPool(undefined, null, '', []), seed)` works
  under node. A colour skin's NAME is its main hex (`paperSkins.js:381,472`), which makes it a ready snapshot id.
- `Path2D` is replaced by `NullPath` under node (`paperGeom.js:89-97`).
- Cost on this PC: 6000 warm-up updates took 474 ms total; a steady 60 Hz tick with 15 bots costs 0.074 ms. After warm-up
  base rings hold 450 to 1851 vertices, live trails up to 263 points.
- The `Game` constructor starts a 500 ms `setInterval` (`paperGame.js:95-97`). Call `game.stop()` (`:100-106`) on
  teardown and in tests or node never exits.

World constants: arena 2000 x 2000, grid cell 20, border 300 points (`paperSkins.js:184-186`); centre (1000, 1000),
radius `min(cx, cy) * 0.95 = 950` (`paperMain.js:81-83`); spawn base is a 50-gon of radius 30
(`paperSkins.js:190-191`, `paperGame.js:252`); speed 90 u/s (`paperSkins.js:196`); turn cap one full turn per second
(`paperGameMoves.js:59`).

## 2. Every single-human assumption, and the seam for each

### 2.1 `game.player` (complete list)

| Where | What it does | Multi-human need | Smallest seam |
|---|---|---|---|
| `paperGame.js:68,108-115` | `player` field; `addPlayer` sets it, resets quality, makes one parity `Math.random()` draw | many humans, none special on the server | never call `addPlayer`; use `addUnit` (`:117-119`). Keep `player = null` on the server |
| `paperGame.js:126-130,137-140` | spawn mode `'player'` anchors on the player; trail clearance factor `lerp(3,1,player.percent)`, else 2 | no anchor player | none: with `player` null mode `'player'` returns undefined before any random draw (`:126-128`) and the factor is 2 |
| `paperGame.js:184` | bot cap is `units.length - (player ? 1 : 0) >= botsCount` | total squares = 16 in free, 0 bots in paid | config only: `botsCount: 16` (free), `botsCount: 0` (paid). Probe confirmed both |
| `paperGame.js:197-202` | census of bot types skips the player | humans have `type` undefined, so `census[undefined]++` makes a harmless NaN key | give human units `type = undefined` and ignore, or override `spawnBot` |
| `paperGame.js:226-261` | `spawnPlayer`: evicts `units[~~(len/2)]` when full (`:232-238`), retries FOREVER (`:241-247`), builds `PlayerUnit`, sets camera scale, start time | never evict a human (in paid that would destroy money); never loop unbounded on a server | do NOT call `spawnPlayer`. New `ArenaGame.spawnHuman()`: evict only a `BotUnit` (free arena), bounded tries, return null on failure so the room can refuse the join BEFORE the entry token is consumed |
| `paperGame.js:263-339` | `gameOver`: results object, territory screenshot (`document` guarded, `:287`), wall-clock `setTimeout` of 1000 or 2000 ms, then `player = null` and `gameOverCallback` | per-socket death event | none on the server: only reachable when `victim === this.player` (`:369-371`). The CLIENT mirror can reuse it unchanged |
| `paperGame.js:369-371` | a player death triggers `gameOver` | as above | none |
| `paperGame.js:410` + `paperGameMoves.js:137-149` | `recoverTail`: safety net for the PLAYER only (flagged home but outside its ring: nudge 1 unit past the nearest ring vertex, wipe the trail) | every human (and it is needed after a trim) | override `recoverTail()` in `ArenaGame` to run the same body for each human |
| `paperGame.js:454-461` | bot `level = lerp(startBotLevel, 1, player.percent)`, else `noPlayerBotLevel` (0.5); `config.botLevel !== -1` overrides | one difficulty for a shared arena | config only: leave `player` null (level 0.5) or set `botLevel` |
| `paperGame.js:502-522` | a player trail longer than `botAttackTrackLength` (1500) flips the NEAREST bot into `attack`, every tick | same pressure on each human in the free arena | run the same loop per human in the `ArenaGame.update` post-hook (it sits at the end of the stock tick anyway) |
| `paperGame.js:523-525` | camera scale eases to `player.scale` or `observerScale` | client concern | none on the server (harmless number) |
| `paperGame.js:526-529` | win at percent > 0.9999 | no rounds, nobody "wins" an arena | none: skipped when `player` is null |
| `paperGame.js:530-532` | `spawnBot('player')` near the player | n/a | none: no-op without a player |
| `paperGame.js:566-581` | camera focus: player, or the player's killer, else arena centre with a per-frame 1/30 glide | client follows ITS unit | client mirror sets `mirror.player` to the local unit; stock code then works |
| `paperGame.js:680-682` | `isPlayer(unit)` is `unit === this.player`; used by the renderer (`paperRender.js:411,471,477`) | "is this MY unit" on each client | none: true by construction on the client mirror |
| `paperUnits.js:480-484` | `BotUnit.update`: only the player can hide beyond `visionRange`; everyone else is sensed at any range | optional: humans hide the same way | hook (2.6) |
| `paperBots.js:43-55,136,172` | `isPlayerTrackInAggroRange(bot)` reads `bot.game.player` | bots hunt the nearest human | hook (2.6) |
| `paperBots.js:330-357` | `attack` state chases `game.player`'s trail | same | hook (2.6) |
| `paperRender.js:393-421,465-481,517-585,629-635` | minimap, own leaderboard row, score bar, BEST text, kills pill, the HUD gate `if (game.player)` | each client shows its own | none: the client mirror has `player` = local unit |

### 2.2 `isPlayer` getter and `PlayerUnit`

- `GameUnit.isPlayer` is false, `PlayerUnit.isPlayer` is true (`paperUnits.js:372-374,438-440`). It drives only
  cosmetics: the "Kill" and "+x.xx%" floating labels (`:306-329`) and the leaderboard dirty flag (`:382-384`).
- `PlayerUnit.update` builds its target from the ONE shared `game.angle` (`:442-451`), which comes from the ONE shared
  `game.direction` (`paperGame.js:71,409`). That is the core single-human assumption in the sim.
- Seam: new class in the MP file, for example
  `class ArenaHuman extends P.GameUnit { update(dt) { super.update(dt); this.target = this.locked ? null : new P.Vec2(1,0).rotate(this.angle * Math.PI / 127).mulScalar(50).add(this.position); } }`.
  Probe: this exact class steers, leaves its base, lays a trail, and stands perfectly still when `locked`.
  Keep `isPlayer` false on the server so no labels are built there (labels read `skin.colors`, `language.killText`).
- A unit standing still while away from home keeps its trail cuttable. That is the intended risk of the 3 second hold.

### 2.3 The single `InputController`

- Built once in `paperMain.js:94`, polled once per tick by `Game.readInput` (`paperGameMoves.js:105-133`), which turns
  keys or pointer into `game.direction`; `Game.update` quantises it to `game.angle`, 254 steps
  (`paperGame.js:409`). Pointer steering is relative to the VIEW CENTRE (`paperGameMoves.js:42-44,128,131`), so the
  client camera must keep the local square centred.
- Server: pass `controller = null`; `readInput` returns at once (`paperGameMoves.js:106-107`).
- Wire format falls out for free: the client keeps the stock controller and `readInput`, and sends the 0..253 angle
  (one byte). The server stores it on the human unit; `getMovement` applies the same turn cap server-side
  (`paperGameMoves.js:56-63`), so a client cannot turn faster than allowed whatever it sends. Validate the byte is an
  integer in 0..253.
- Q hold and the touch hold button are NEW client code. `InputController.onKeyChange` ignores keys unless
  `evt.target === document.body` (`paperInput.js:87-97`); a Q handler should follow the same rule. Touch steering
  uses `changedTouches[0]` with no identifier tracking (`paperInput.js:49-58`), but only on the canvas element, so a
  separate DOM button does not steer.
- `dispose()` exists (`paperInput.js:74-80`) and is never called in solo. The MP page must call it if it ever
  rebuilds the game.

### 2.4 Level and difficulty

Covered by config (2.1). Bot skill per tick is `level + bot.jitter` (`paperGame.js:462-500`); the bot type wish list row
is picked by `level` (`:44-49,204`).

### 2.5 Spawn rules

`getSpawnPosition(mode, spawnRadius)` (`paperGame.js:121-174`) reads `this.border.radius` LIVE (`:123`), rejects
points near the wall (`:158`), inside any base (`:163`), or within clearance of any simplified base vertex or trail
vertex (`:166-171`). It uses `Math.random` (not the seeded rng) and returns undefined on failure, so callers must
loop with a bound. It works unchanged for humans: `getSpawnPosition('random', baseRadius)` as `spawnPlayer` does
(`:246`).

### 2.6 Bot aggro toward the player (free arena only; paid arenas have no bots)

With `player` null bots still expand, defend and kill by accident, but never enter `attack`. To keep solo's feel:

- Option A, zero solo edits: `ArenaGame` defines `get player()` returning a per-bot "prey" context and a no-op
  `set player(v)` (the base constructor assigns `this.player = null` in strict mode, `paperGame.js:68`, so the setter
  must exist). An `ArenaBot extends P.BotUnit` sets the context around `super.update(dt)`. Everything else in
  `Game.update` sees null. Catch: `spawnBot` hardcodes `new P.BotUnit` (`paperGame.js:211`), so `spawnBot` must be
  copied into the subclass (45 lines). Clever, fragile.
- Option B, recommended, two one-line hooks that are no-ops in solo:
  `paperBots.js:44` and `:335`, `paperUnits.js:480`: `bot.game.player` becomes
  `(bot.game.preyFor ? bot.game.preyFor(bot) : bot.game.player)`. No draw is added or removed. Re-run the goldens.
- The long-trail magnet (`paperGame.js:502-522`) is reproduced per human in the arena's post-hook either way.

### 2.7 Camera, zoom, HUD (client)

The renderer only READS: `units[]` (array order = rank), per unit `position, direction, target, name, skin, in, base.polygon
{path, bounds, segments}, track.polyline {path, bounds, segments, start}, schemes.scores()/print(), statistics.kills,
death`; and `border.polygon.path`, `space.width/height`, `config`, `particles`, `labels`, `best`, `language`,
`topListChanged`, `isPlayer()`, `getRenderContext()` (`paperRender.js:244-384,393-585,589-636`).
So the MP client can keep `P.renderGameFrame`, `getRenderContext`, `loop` and `updateMetrics` byte for byte by using a
MIRROR game: `class ClientArenaGame extends P.Game` whose `update(dt)` does interpolation plus the cosmetic subset of
the stock tick (labels `:449-452`, particles `:453`, camera scale ease `:523-525`, `readInput` + angle `:408-409`)
and never simulates other units. Per-unit camera zoom is derivable on the client from percent
(`paperGame.js:421`), no need to send it.

Money over the head: `drawUnitName` draws `unit.name` 12 px above the unit (`paperRender.js:141-168`); the leaderboard
prints the same string (`:459`). Either fold money into the mirrored name, or draw a separate pass after
`renderGameFrame` (re-apply the world transform from `:599-604`). No renderer edit is needed for either.

`createGameApi` hardcodes `new P.Game` (`paperMain.js:86`) and `ensureCanvas` is private (`:425-434`); the MP page
needs its own small boot file. Reusable exports: `registerLanguages, pickDefaultLanguage, hudPreloadText,
whenFontsReady` (`:489-495`). The lobby iframe contract is `postMessage('game:done')` (`:389-402`).

### 2.8 Game over and restart (solo flow, for reference)

`kill` of the player (`paperGame.js:369-371`) calls `gameOver(reason)`: results, `playerDeathCallback`, then after
`enemyKillDelay` 2000 ms (reasons 3, 4, 5) or `selfKillDelay` 1000 ms the player is nulled and `gameOverCallback`
fires (`:326-337`). While waiting, the camera follows `player.killer` (`:569-571`). The shell shows "Play again",
which re-runs `api.start`, which calls `spawnPlayer` in the SAME running world (`paperMain.js:287-346,133-151`). The
Game instance is never rebuilt. MP: the server sends a death event to that socket; free arena "Play again" asks the
server for a new unit, paid arenas go back to the lobby for a new buy-in (brief).

### 2.9 Loop, timestep, warm-up

- `loop()` (`paperGame.js:685-724`) is rAF driven: delta clamped to 1 ms..10 s, frames longer than `2 * FRAME_MS`
  (33.3 ms) are split into sub-steps with `Math.random()` jitter (`:703-713`), then `update(subStep)`, then render.
  `update` adds `rng() * 0.01` ms (`:406`). Movement and turn cap scale with dt
  (`paperGameMoves.js:54,59,65`).
- Server: never call `loop()` (no rAF). Call `arena.update(dtMs)` from the room's tick (project `TICK_RATE` is 60,
  `shared/constants.js:6`). Keep each call at or under 33.3 ms and sub-step a late tick the way `loop()` does, so a
  GC stall never produces one long step with a huge turn allowance.
- Warm-up: solo runs more than 6000 updates of `50 ms + Math.random()` before the first spawn so bots own land
  (`paperMain.js:108-131`, `paperSkins.js:187-188,198`); `api.start` can finish it synchronously with a 500 ms cap
  (`paperMain.js:135-143`). Free arena: warm up ONCE at room creation, in chunks (for example 200 updates per
  `setImmediate`), because 474 ms of blocking here (more on EC2) would stall the snake and agar rooms that share
  the process. Paid arenas have no bots, so no warm-up.
- `prepareAndUpdate`, `preparing`, `finishPrepare` (`paperGame.js:374-395`) are only used by `loop()` while hidden.

### 2.10 `kill()` is the money hook

`kill(victim, killer, reason)` (`paperGame.js:341-372`): idempotent (`:342-344`), releases the skin, clears other units'
`in` that pointed at the victim's base (`:348-352`), removes trail and base from the grid (`:357-358`), splices the
unit out of `units` (`:359-360`), credits the killer (`:361-366`).

| Reason | Const | Raised at | killer |
|---|---|---|---|
| 1 self cross | `KILL_REASON_SELF_CROSS` | `paperTerritory.js:225-238` | undefined |
| 2 wall (a self cross within 5 units of the wall, `:233-236`) | `KILL_REASON_WALL` | same | undefined |
| 3 trail cut | `KILL_REASON_TRACK_CUT` | `paperTerritory.js:240` | the mover |
| 4 exit point captured | | `paperGameMoves.js:199-201` | the capturer |
| 5 encircled at home | | `paperGameMoves.js:196-198` | the capturer |
| 6 system removed (no particles, `paperGame.js:353`) | | `paperGame.js:232-235` | undefined |

`ArenaGame.kill` override: read `victim.death` FIRST (one capture can call `kill` twice for the same victim,
`paperGameMoves.js:196-201`; the second is a no-op), call `super.kill`, then move money: killer present means
`killer.money += victim.money`; no killer means drop a pickup at `victim.position` (for a self cross the position is
set to the crossing point just before the kill, `paperTerritory.js:232`). New reason codes 7 and up are safe: the base
only compares `!== 6` and `!== 0` (`paperGame.js:353,369`). Probe: `kill(unit, undefined, 7)` removed the unit
cleanly. Use one for cash-out (no pickup, no credit) and one for disconnect (pickup).
One capture can kill several victims; emit one transfer (and one CollusionMonitor record) per victim.

Move order inside a tick is `units` order, and `units` is re-sorted by score every tick
(`paperGame.js:445`, `paperGameMoves.js:333-336`), so the higher ranked square moves first and wins a same-tick
mutual trail cut. That is reference behaviour; with money on it, know it is rank order, not join order.

## 3. Recommended shape (all new files)

- `ArenaGame extends P.Game`: `update(dt)` = set `P.Vec2.space`, drain the room's command queue (join, leave, input,
  cash-out start/cancel), step the radius, `super.update(dt)`, then post-hooks (per-human magnet, pickups, cash-out
  timers, trim, `unit.log.length = 0`, event collection). Overrides: `kill`, `getMovement` (push + loop guard reset),
  `recoverTail`, `handleReturn` (super, then trim the returning unit's base), `spawnBot` (paid: empty body, belt and
  braces for THE ONE RULE).
- `ArenaHuman extends P.GameUnit` (2.2) with `id`, `angle`, `locked`, `money`, `wallet`.
- `SafeArenaBorder extends P.ArenaBorder` (section 6, pitfall 2) with `setRadius`.
- Client `ClientArenaGame extends P.Game` mirror (2.7).
- Solo edits: none required. Optional: the `preyFor` hook (2.6 B).

`super.getMovement` etc. resolve at call time, so it does not matter that `installGameMoves` assigns the methods
onto `P.Game.prototype` after class creation, or that `boot()` calls it again (`paperMain.js:209`).

## 4. What state defines the world (for snapshots)

| State | Source | Changes | Wire note |
|---|---|---|---|
| stable unit id | NEW | never | `units` is re-sorted every tick (`paperGame.js:445`): never use the index |
| name, skin name (colour hex), bot flag | `GameUnit.name`, `skin.name` | never within a life | send once per unit |
| position | `unit.position` | every tick while moving (1.5 u per 60 Hz tick) | arena is 2000 wide, so `Uint16 = round(x * 32)` is 0.03 u |
| direction (radians, UNBOUNDED, `paperGameMoves.js:63`) | `unit.direction` | every tick while turning | wrap to 0..2pi, one byte is plenty; the renderer rotates the avatar by it (`paperRender.js:211`) |
| trail points | `unit.track.polyline` | append only, about 1 point per tick while away (`paperGameMoves.js:370-374`) plus crossing points (`paperTerritory.js:94,109,130,147`); RESET on return (`:114`), death, `recoverTail` | send "reset" or "append N". Decimate: a unit crawling against the wall adds micro segments (probe: 5885 points in 25 s) |
| base ring | `unit.base.polygon.segments` | EVENT driven only: own return (`paperGameMoves.js:181-190`), being carved (`:241-248`), arena trim (new). `polygon.insert` on every boundary crossing adds an invisible collinear vertex (`paperGeom.js:680-690`) and needs no send | version counter per base; send the ring on version change, decimated (rings reach 450 to 1851 vertices after warm-up; `polygon.simplify` is a 25 u decimation, too coarse to draw) |
| percent | `base.square / game.square` (`paperGame.js:417-421`) | when the ring changes or the radius changes | send the number; a decimated ring cannot reproduce it |
| `in` (null, own base, or an enemy base) | `unit.in` | on boundary crossings | needed: `renderTracks` skips units that are home (`paperRender.js:307`), minimap "invaded" flag (`:410-413`), crumb particles (`paperUnits.js:117`) |
| death | removal from `units` (`paperGame.js:359-360`) | event | send victim id, killer id, reason, money moved |
| rank, score | derived from percent (`paperUnits.js:292-294`, `paperGame.js:445-448`) | | client sorts, or send order; crown goes to `units[0]` (`paperRender.js:386-389`) |
| kills counter | `unit.statistics.kills` | event | own unit only |
| money, cash-out hold progress, pickups | NEW | event | |
| arena radius | `border.radius` | while easing | client rebuilds its own `ArenaBorder.circular(center, 300, r)` for the path and `game.square` |

Client-only cosmetics, never sent: particles (the server makes none because `visible` is false: `paperUnits.js:134`,
`paperGameMoves.js:375-377`), floating labels, camera scale and origin, quality and fps, `topListChanged`. The client
creates them from events with the stock helpers: `P.Particle.emitCrumb` and `P.spawnDeathParticles` (the mirror unit
must hold real `Polygon` and `Polyline` objects with `segments` at the moment of death).

Client prediction of the own square can call the real `P.Game.prototype.getMovement.call(mirror, dt, unit)`: it
only reads `config.unitSpeed`, the unit, and `border` (`paperGameMoves.js:49-102`), so wall sliding is identical.

## 5. ArenaBorder and changing the radius at runtime

### 5.1 How it is built and used

- `ArenaBorder.circular(center, 300, 950)` makes a plain `Polygon` from `makeCirclePoints`; it is NEVER committed to
  the spatial grid (`paperTerritory.js:14-29`), so replacing it costs no grid bookkeeping. Probe: a rebuild takes
  0.023 ms.
- `intersections(step)` fast-rejects when both ends are inside `radius^2 * 0.95` (about 0.975 r), else brute forces
  the 300 edges and drops overlay hits (`paperTerritory.js:31-43`). It is called only from `getMovement`.
- Sliding (`paperGameMoves.js:69-99`): on a hit where the step leans OUT of the edge, keep the part up to the touch
  point, project the leftover onto the wall edge, test again (corners). A step that leans back IN is never clipped
  (`:83-86`), so a unit outside the wall can always walk back in, and (probe) a unit outside the wall is NOT pulled
  back by anything: it kept going from 1229 to 1319.
- Everything that reads the wall: `border.radius` in `paperGame.js:123` (spawn), `paperTerritory.js:35-36,234`,
  `paperBots.js:86,100,157,177,321`; `border.polygon` in `getMovement`, the renderer (`paperRender.js:332-335,404,413`),
  and ONCE in the constructor for `game.square` (`paperGame.js:77`) and `calcPath` (`:89`).
- `game.square` feeds percent, camera scale, spawn scale and the "+x%" gain (`paperGame.js:259,418-421`,
  `paperGameMoves.js:319`).
- Keep the centre at (1000, 1000) and the radius at or under 950: `SpatialGrid.cell` does not clamp
  (`paperGeom.js:304-310`), a point outside 0..2000 crashes on commit.

### 5.2 Every radius step

1. `border.radius = r`.
2. `border.polygon = new P.Polygon(P.makeCirclePoints(center, config.borderPoints, r)); border.polygon.calcPath();`
3. `game.square = border.polygon.square();`
4. Shrink only: push units (5.4), move pickups inward, trim land (5.5).

Growth needs only 1 to 3. Step the radius in small quanta (for example every 0.5 to 1 u) rather than every tick, so the
trim runs a few times per second, not 60.

### 5.3 Bots and a moving wall

Bot states read `border.radius` live, so they adapt. The `exit` state re-validates its cached vertex against
`bot.base.polygon` by identity (`paperBots.js:148-154`). The brief keeps the free arena at full size, so bots never
see a moving wall in practice.

### 5.4 Pushing units inward (probed)

- Working zero-edit recipe: in `ArenaGame.getMovement`, when `unit.position.distance(center) > border.radius`, make a
  first piece `Segment(unit.position, inwardPoint)` with `inwardPoint` a hair inside the wall apothem
  (`r * cos(pi/300) - 0.05`), temporarily set `unit.position = inwardPoint`, call `super.getMovement`, restore, and
  return `[push].concat(rest)`. The push then runs through the normal crossing dispatch, so `in` flags, own-base
  crossings and enemy trail cuts stay consistent. Probe: worst overshoot 0.000 over a 950 to 800 shrink.
- It KILLS without a veto. Any unit that holds a heading into the wall slides until its heading is perpendicular to
  the wall and then crawls (last segment 0.0098 u). The first push makes it re-approach across its own micro trail:
  `UnitTrack.handleIntersect` raises reason 2 (`paperTerritory.js:225-238`). Probe: death on the first shrink step.
  Owner rule 6 says nobody dies from the shrink, so `ArenaGame.kill` must ignore reason 2 while the wall is shrinking
  (plus a short grace). With the veto the probe unit survived 1500 shrink ticks (1175 vetoes), walked home, and the
  capture merged without error.
- Note for honesty with the owner: pressing into a STATIC wall near-perpendicular also kills in the stock game after
  some seconds (probe: deaths at tick 826 and 1147, another run survived). That is reference behaviour and stays.
- A home unit inside its own base is pushed without any crossing and stays `in === base` (probe D).

### 5.5 Trimming land: how the existing cut works, and what a trim must respect

How enemy capture cuts a base today (`paperGameMoves.js:207-255`):
1. Crossing points are already SHARED `Vec2` objects: `handleEnemyIntersect` splits the victim's ring edge at the
   crossing with `polygon.insert` and adds the same object to the intruder's trail (`paperTerritory.js:129-131,146-148`).
2. `carve` finds the ring indices of the two crossing vertices by identity (`seg.start === cut.startPoint`,
   `:211-223`), orders the chord so it runs from the lower index to the higher (`:224-226`), builds both candidate
   sides, and keeps the side that holds the owner: its position when home, else its trail start (`:237-246`).
3. `polygon.left(chord, lo, hi)` replaces ring segments lo..hi-1 by the chord (commit new, then remove old);
   `polygon.right(chord, lo, hi)` keeps ONLY lo..hi-1 and closes with the reversed chord
   (`paperGeom.js:717-740`). Own captures use `splice` / `unsplice` the same way (`:701-714`).
4. Then `owner.square -= lost.square()`, `owner.polygon.calcPath()` (also refreshes `simplify` and `bounds`,
   `paperGeom.js:806-869`), and bystanders standing in the lost piece get `in = null` (`:247-254`).

A circle trim is the same operation with the chord running along the new wall: for each maximal run of ring vertices
outside the wall, insert the two wall crossings with `polygon.insert`, build the chord
`[A, wall vertices between, B]`, call `left` (or `right` when the run wraps ring index 0), subtract the lost area,
`calcPath`. Base edges that coincide with wall edges are a state the solo sim already lives with (captures made while
sliding put ring edges exactly on the wall; overlay hits on the own ring are ignored, `paperTerritory.js:78-81`).

Invariants a trim must not break (each one is a crash or silent corruption if broken):
- I1. One simple ring per base, committed with `polygon.commit(base)` so `seg.shape.owner` is the base
  (`paperGeom.js:663-667`, `paperTerritory.js:47-57`). `calcPath` reads `segments[0]` (`paperGeom.js:810`): an EMPTY
  ring throws. A base wholly outside the new wall cannot simply be trimmed to nothing.
- I2. While a unit is away, its `track.polyline.start` must remain the `.start` of a segment of its OWN ring, by object
  identity (`paperGameMoves.js:163-164`). If the trim deletes that vertex, the next return computes index -1 and
  splices garbage. Do not trim a run that contains the exit vertex of an away owner; retry after it returns or dies.
- I3. Crossing vertices shared with a LIVE foreign trail (`point.segments` holds a segment whose `shape.owner.isTrack`)
  pair up entries and exits in the capture walk (`paperGameMoves.js:257-311`). Deleting one mis-pairs a later carve.
  Skip runs that contain such a vertex, same retry rule.
- I4. Reuse the existing `Vec2` objects of every kept vertex. Never call `segment.remove()` twice or on a segment that
  was never committed: `Vec2.remove` does `splice(indexOf(...), 1)` with no guard, so -1 drops the point's LAST
  registration, which belongs to some other shape (`paperGeom.js:390-397`).
- I5. A concave base straddling the wall can clip into two pieces. Replacing both outside runs by wall arcs makes a
  ring that doubles back along the wall (coincident opposite edges). Use the carve rule instead: keep the piece that
  holds the owner's anchor and drop the rest.
- I6. A moved vertex must be re-registered (`point.cell.remove(point)`, then `Vec2.space.cell(point).commit(point)`)
  and every segment in `point.segments` needs `calc()` again (`paperGeom.js:123-135,264-276,380-388`). Only relevant if
  the design projects vertices instead of cutting.

Land outside the wall also appears AFTER a shrink: a trail laid before the shrink is merged on return (probe: a
returned ring had 5367 of 6469 vertices outside). So trim the returning unit's base inside the `handleReturn`
override too, not only on radius steps.

Because percent is not money, the safe policy is best-effort: if any precondition fails for a base this step, skip it
and retry on the next step. Untrimmed land outside the wall is unreachable and harmless to the sim.

Open design decisions for the design phase (not decided here):
- D1. A base entirely outside the new wall (a fresh radius 30 base at the rim is swallowed after a 60 u shrink): the
  owner must keep some ring. Options: re-seed a spawn circle at a legal `getSpawnPosition` point and move the unit
  there, or translate the ring inward. Both can overlap a neighbour, which the sim never normally allows.
- D2. Quantum and speed of the shrink, and the grace period of the wall-death veto.
- D3. Whether the chord uses the exact wall polygon vertices (matches solo's steady state) or a circle a hair inside
  (avoids collinear overlay cases; the unit then lays a hairline trail when sliding past its own trimmed edge).

## 6. Pitfalls found (ordered by how badly they bite)

1. `Vec2.space` is a process-wide static (`paperGeom.js:293,386,518`); `Game.update` re-points it (`paperGame.js:404`)
   but a join, cash-out removal, disconnect kill or trim done from a socket handler happens OUTSIDE update and would
   register points in another arena's grid: land and trails become invisible to collision, silently. Route every
   external command through a queue drained inside `ArenaGame.update`, after setting the static.
2. Infinite loop: a step that reaches a wall VERTEX exactly (within the 2^-26 tolerance) makes
   `while (wallHits.length)` in `getMovement` (`paperGameMoves.js:70-99`) spin forever (probe: a unit heading exactly
   east from y = 1000.0 froze node at tick 633, at x = 1949.77 just before wall vertex 0 at (1950, 1000); with slightly
   different dt the same unit walked THROUGH the wall instead). Random solo play essentially never lands on a vertex,
   but deterministic server coordinates can: exactly east is a real quantised heading (angle 0), and a spawn or push
   target on the centre line puts a unit on that ray. Never spawn or push a unit onto exact symmetric coordinates, and
   cap the loop without editing solo: `SafeArenaBorder.intersections` counts calls since the last `getMovement` and
   returns `[]` past a small cap (probe: cap 12 ended the hang). The push pass then repairs any escape.
3. `unit.log.push(this.position)` runs every tick and nothing ever reads it (`paperUnits.js:355,387`). Probe: one bot
   held 9027 entries after 9027 ticks alive (2.5 minutes at 60 Hz). In a persistent arena it pins every old position
   vector. Clear it each tick in the arena.
4. `units` order changes every tick (`paperGame.js:445`). Ids, not indices, on the wire and in room maps.
5. `spawnPlayer` has an unbounded retry loop and evicts an arbitrary unit (`paperGame.js:232-247`). Never call it on
   the server.
6. The sim uses unseeded `Math.random` for spawn points, particles and sub-step jitter
   (`paperGame.js:138-155,709-710`, `paperUnits.js:93-125`), so server runs are not reproducible from the seed alone.
   Tests that need determinism must stub `Math.random` the way the solo node tests do.
7. `Game` constructor timer (`paperGame.js:95-97`): call `stop()` or it leaks and keeps node alive.
8. Money on the ground (pickups) is still escrow liability. The solvency figure for a Paper arena is the sum of unit
   money PLUS pickups. A per-tick conservation assert is cheap: entries in = unit money + pickups + cashed out.
9. `unit.direction` is unbounded radians (`paperGameMoves.js:63`); wrap before quantising.
10. On the client mirror, removing never-committed shapes is safe only because their points have empty `segments`
    arrays (I4). Do not half-commit mirror geometry.

## 7. Probe record (throwaway scripts, scratchpad only)

- Headless boot with 7 files; warm-up 6000 updates 474 ms; 0.074 ms per tick with 15 bots; ring sizes 450..1851.
- `botsCount: 0` gives 0 units after 600 ticks; `botsCount: 16` gives 16.
- `GameUnit` subclass with own angle: moved 180 u in 120 ticks, trail 101 points, `game.player` null throughout.
- `target = null`: displacement 0.000 over 60 ticks, trail unchanged.
- `kill(unit, undefined, 7)`: clean removal.
- Second arena construction re-pointed `Vec2.space` away from the first.
- Exact wall vertex: stock loop hang; border call cap fixes it.
- Shrink 950 to 800 at 6 u/s with prepended push piece: no overshoot; wall-hugging unit dies on step 0 without the
  reason 2 veto, survives with it; standing (locked) unit survives with no veto needed; home unit stays home.
