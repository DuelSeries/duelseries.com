# Paper multiplayer: the reuse-first design

Written 2026-09-20. Binding inputs: `docs/paper-multiplayer-brief.md` (owner rules) and the six reader notes in
`docs/paper-mp/understand-*.md`. Bias of this design: MAXIMUM REUSE, smallest diff. Paths are relative to
`slither-clone/`. Solo sim paths are relative to `public/js/paper/` when no folder is shown.

Everything below that says "verified" was read in the code by me today; line numbers are from that read.

## 0. The design in one page

1. **Zero edits to any existing solo file.** No file under `public/js/paper/paper*.js`, nor `public/paper.html`, nor the
   `/paper` route changes by a single byte. Golden parity therefore holds by construction, and the check is
   `git diff --stat -- public/js/paper/paper*.js public/paper.html` printing nothing (the goldens in
   `../paperio-reference` are still re-run once at the end, by hand, because `npm test` does not run them).
2. **Server sim = the stock `P.Game` with `player = null`.** `server/paper/ArenaGame.js` holds
   `ArenaGame extends P.Game`, `ArenaHuman extends P.GameUnit` and `SafeArenaBorder extends P.ArenaBorder`. The stock
   `update` (`paperGame.js:398-537`) is already a full server tick when `player`, `controller`, `view` are null and
   `visible` is false: `readInput` returns at once (`paperGameMoves.js:106-107`), the win check, level-from-player,
   long-trail magnet and `spawnBot('player')` are all guarded on `player` (`paperGame.js:454-461,502,526,126-128`).
   The subclass wraps `update` and overrides five prototype methods: `kill`, `getMovement`, `recoverTail`,
   `handleReturn`, `spawnBot`, plus `addUnit` (id assignment and the bot prey wrap, section 3.5).
3. **Money never touches a float inside the room.** Worth is integer micro-USDC on the unit. One choke point,
   `ArenaGame.kill`, zeroes the victim and credits the killer or creates a pickup in the same synchronous step. The
   room moves no money: it calls four hooks (`onCashout`, `onTransfer`, `onRefund`, `onHouse`) that `server/index.js`
   wires to the existing 90/10 withdraw path.
4. **Client = a replica `P.Game`.** `ClientArenaGame extends P.Game` holds mirror units whose `base.polygon` and
   `track.polyline` are real (uncommitted) `P.Polygon` / `P.Polyline` objects, with `player` = the local unit, so
   `P.renderGameFrame`, `getRenderContext`, `loop`, `updateMetrics`, the minimap, leaderboard, score bar and kills pill
   (`paperRender.js:589-636`) run unchanged. Its `update(dt)` interpolates others, predicts the own square with the
   real `getMovement`, and runs only the cosmetic subset of the stock tick.
5. **Three fixed arenas per boot (Free, $0.10, $1.00), overflow arenas on demand, no LobbyRegistry.** An arena with no
   human in it does not tick; its world (including money on the floor) simply waits.
6. **The trim is a Weiler-Atherton clip of each base ring against the convex 300-gon wall**, computed on plain
   numbers first, validated, then applied as ONE ring rebuild that reuses every kept `Vec2` by identity. It runs only
   in the post-tick hook (never in the middle of movement dispatch), skips a base whose preconditions fail and
   retries next step, and has a last-resort "reseat" so nobody is ever killed or stranded by a shrink.

## 1. What is reused as is, and what is new

| Piece | Reused unchanged | New |
|---|---|---|
| Geometry, territory, capture, carve, kill rules, bots, spawn rules | all seven sim files (`understand-solo-seams.md` section 1) | none |
| Server tick | `P.Game.prototype.update` | `ArenaGame.update` wrapper (pre and post hooks) |
| Human steering | turn cap and wall slide in `getMovement` (`paperGameMoves.js:49-102`) | `ArenaHuman.update` builds `target` from its own angle byte (same formula as `paperUnits.js:446-449`) |
| Entry, token, stake verify | `/api/stake-quote`, `/api/submit-stake`, `consumePaidEntryAtStake` (`server/index.js:395-412`) | a `paper:join` handler that calls them in the PLAY order |
| Payout | `trackEarning`, `sweepRake`, `money.withdraw`, `db.recordEarnings`, `db.recordFailedPayout` exactly as `doCashout` (`server/index.js:2209-2264`) | `server/paperPayout.js`, a sibling of `doCashout` with injected deps |
| Renderer, camera, HUD, input controller, fonts, languages | `paperRender.js`, `paperInput.js`, `P.registerLanguages`, `P.whenFontsReady`, `P.hudPreloadText` (`paperMain.js:489-495`; the file does not self-boot, it only exports) | one HUD overlay pass drawn after `renderGameFrame` |
| Lobby launch, restake | `launch()` (`public/js/v2/play.js:238-308`), widget `stakeAndPlay` and the `duel:restake` bridge (`wallet-widget/src/main.jsx:181-234,355-378`) | one `PAGES` entry, one catalogue row, three `/api/live` rows |

## 2. File map and ownership (nobody shares a file)

| WP | Owner | Files (all NEW unless marked EDIT) | Depends on |
|---|---|---|---|
| A sim | Eng 1 | `server/paper/loadPaperLib.js`, `server/paper/ArenaGame.js`, `test/paperArenaGame.test.js` | trim API (section 8.6), ledger API (5.1) as interfaces only |
| B trim | Eng 2 | `server/paper/arenaTrim.js`, `test/paperTrim.test.js` | nothing (pure functions over `P`) |
| C room + ledger | Eng 3 | `server/PaperRoom.js`, `server/paper/arenaLedger.js`, `test/paperRoom.test.js`, `test/paperRoomMoney.test.js`, `test/paperRoomBots.test.js` | A, B, D interfaces |
| D wire | Eng 4 | `public/js/paper/mp/paperWire.js` (UMD, loaded by node and browser), `test/paperWire.test.js` | nothing |
| E server wiring | Eng 5 | `server/paperArenas.js`, `server/paperSockets.js`, `server/paperPayout.js`, EDIT `server/index.js`, `test/paperPayout.test.js`, `test/paperArenas.test.js`, `test/paperJoinSmoke.test.js` | C hooks |
| F client net + mirror | Eng 6 | `public/js/paper/mp/paperNet.js`, `public/js/paper/mp/paperMirror.js` | D |
| G client page + HUD | Eng 7 | `public/paper-arena.html`, `public/js/paper/mp/paperHud.js`, `public/js/paper/mp/paperArenaMain.js`, `public/css/paper-arena.css` | F API (section 7.1) |
| H lobby | Eng 8 | EDIT `public/v2.html`, EDIT `public/js/v2/board.js`, EDIT `public/js/v2/play.js`, EDIT `wallet-widget/src/main.jsx`, REBUILD and commit `public/wallet/widget.js`, EDIT `test/v2route.test.js` | E's `/api/live` rows and the page route |

`server/index.js` has exactly one owner (E). `test/v2route.test.js` has exactly one owner (H). No test helper module
goes in `test/` (default discovery would run it, `package.json:11`); each test file declares its own io stub and
socket double as `test/shooter.test.js:6,20-32` does.

## 3. Server sim (WP A)

### 3.1 Loading the solo modules under node

`server/paper/loadPaperLib.js` requires the seven sim files in the relative order of `public/paper.html:52-59` (`paperGeom`,
`paperTerritory`, `paperBots`, `paperUnits`, `paperGame`, `paperGameMoves`, `paperSkins`) and returns
`globalThis.DuelPaperLib`. They are IIFEs over `typeof window !== 'undefined' ? window : globalThis`
(`paperGameMoves.js:458`), so `require` just executes them. It also requires `public/js/paper/mp/paperWire.js`.
No per-room state may live on `DuelPaperLib`.

### 3.2 Building one arena

```
makeArena({ stake, now })  ->  ArenaGame
  config  = Object.assign({}, P.defaultPaperConfig, { botsCount: stake > 0 ? 0 : 15 })   // own copy, it is mutated
  space   = new P.SpatialGrid(2000, 2000, config.quadSize)
  border  = new SafeArenaBorder(center(1000,1000), config.borderPoints, startRadius)
  skins   = new P.SkinManager(new P.ColorSkinPool(undefined), new P.ClassicSkinPool(undefined, null, '', []), seed)
  game    = new ArenaGame(config, null /*view*/, space, border, skins, null, nameManager, null /*controller*/,
                          languageStrings, schemesManager, seed)       // ctor order verified, paperGame.js:52-53
```

`game.player` stays null for ever; `addPlayer` and `spawnPlayer` are never called (`spawnPlayer` evicts
`units[~~(len/2)]` and retries without bound, `paperGame.js:232-247`). `game.stop()` (`paperGame.js:100-106`) is
called on teardown and at the end of every test because the constructor starts a 500 ms interval (`:95-97`).

### 3.3 THE static: `P.Vec2.space`

`Vec2.commit` registers points in whatever `Vec2.space` points at (`paperGeom.js:381-388`) and the `SpatialGrid`
constructor re-points it (`:293`). `Game.update` re-points it at the top of each tick (`paperGame.js:404`) and nothing
else does. Rule for this design: **every public mutating method of `ArenaGame` starts with `P.Vec2.space = this.space`**
through one private helper `_enter()`. Node is single threaded and no socket handler can run in the middle of an
`update`, so a synchronous mutation between ticks is safe once the static is right. That lets a join spawn its unit
synchronously in the socket handler, which is what makes "every refusal happens before the token is consumed"
simple (section 5.3). Test: two arenas, interleaved joins and kills, then assert each arena's grid point count equals
the points of its own shapes (`space.count()`, `paperGeom.js:296-302`).

### 3.4 `ArenaHuman`

```
class ArenaHuman extends P.GameUnit {
  // added fields: id, isHuman = true, angle (0..253), holding, holdMs, moneyMicro, wallet, socketId, pushGraceUntil
  update(dt) {
    super.update(dt);                                        // paperUnits.js:386-420
    this.target = this.holding ? null
      : new P.Vec2(1, 0).rotate(this.angle * Math.PI / 127).mulScalar(50).add(this.position);
  }
}
```

`target = null` makes `movement()` falsy (`paperUnits.js:422-424`) so `getMovement` returns no pieces
(`paperGameMoves.js:52-53`): that is the cash-out movement lock, applied in the server sim. `isPlayer` stays false on
the server so no labels are built (`paperUnits.js:306-329`). The turn cap in `getMovement` (`:56-63`) bounds turning
whatever byte a client sends; the room still rejects anything that is not an integer in 0..253.

### 3.5 `ArenaGame` overrides (all prototype methods, no solo edit)

- `addUnit(unit)`: assigns `unit.id` (stable Uint16, never an index: `units` is re-sorted every tick,
  `paperGame.js:445`), pushes, and for a `P.BotUnit` wraps the instance's `update` so bots hunt the nearest human:
  ```
  const stock = unit.update;  const g = this;
  unit.update = function (dt) { g._prey = g.nearestHuman(this); try { stock.call(this, dt); } finally { g._prey = null; } };
  ```
  together with `get player() { return this._prey || null; }  set player(v) {}` on `ArenaGame`. The setter is
  required because the base constructor assigns `this.player = null` (`paperGame.js:68`). All three bot reads of
  `game.player` happen inside `BotUnit.update` (verified: `paperUnits.js:480`, and `paperBots.js:44,335` run from
  `this.fsm.update()` at `paperUnits.js:516`), so everything else in the tick still sees null. `spawnBot` calls
  `this.addUnit(bot)` (`paperGame.js:222`), which is why no copy of `spawnBot` is needed. This replaces the
  `preyFor` hook of the notes and keeps the solo files untouched. Fallback if it proves fragile: the three one-line
  `preyFor` hooks (`understand-solo-seams.md` 2.6 B) plus a golden re-run.
- `spawnBot(mode)`: `if (this.stake > 0) return; return super.spawnBot(mode);` Second guard for THE ONE RULE on top of
  `botsCount: 0` (`paperGame.js:184`). Free arena: `config.botsCount` is kept at 15 so there are never more than 15
  bots; `BOT_TYPE_ROWS` rows have 15 entries (`paperGame.js:44-49`) and a 16th bot could read past the row end and get
  `type` undefined. With one or more humans the cap check `units.length >= botsCount` (player is null so nothing is
  subtracted) is lifted by setting `config.botsCount = 16` while `humans >= 1`: bots = 16 minus humans, at most 15.
- `kill(victim, killer, reason)`: the money hook, section 5.2. Also vetoes reason 2 during a push grace and reason 6
  against a human.
- `getMovement(dt, unit)`: resets the border's call counter, prepends the inward push piece when the unit is outside
  the wall (section 8.3), then `super.getMovement`.
- `recoverTail()`: runs the stock body (`paperGameMoves.js:137-149`) for every human instead of `this.player`.
- `handleReturn(unit)`: `const r = super.handleReturn(unit); unit.base._trimDirty = true; return r;` Nothing else. The
  actual trim is deferred to the post hook (section 8.5) so ring surgery never happens inside `dispatchBucket`, which
  is still holding hit records for segments of that ring (`paperGameMoves.js:412-449`).
- `update(dt)`:
  ```
  _enter(); this.nowMs += dt;
  stepRadius(dt);                       // section 8.1, may flag every base dirty
  super.update(dt);
  // post hooks, in this order:
  perHumanMagnet();                     // same loop as paperGame.js:502-522, once per human, free arena only
  stepHolds(dt);                        // section 5.4
  collectPickups();                     // section 5.5
  trimDirtyBases(max 4 per tick);       // section 8.5
  feedWireTrails();                     // section 6.3
  for (u of units) u.log.length = 0;    // stock pushes one entry per tick and never reads it (paperUnits.js:387)
  ```
- New methods: `findSpawn()` (bounded, read only), `spawnHuman(spec, spot)`, `removeHuman(id, reason)`,
  `setAngle(id, byte)`, `setHolding(id, on)`, `liveMicro()`, `snapshotState()`.

`SafeArenaBorder.intersections(seg)` counts calls since the last `resetGuard()` and returns `[]` past 12. That ends
the infinite wall loop the notes found when a step lands on a wall vertex (`paperGameMoves.js:70-99`); the push pass
repairs any escape on the next tick. `setRadius(r)` does `this.radius = r; this.polygon = new P.Polygon(
P.makeCirclePoints(center, 300, r)); this.polygon.calcPath();` (the wall is never committed to the grid,
`paperTerritory.js:14-29`, so this is free) and caches `apothem = r * cos(PI/300)` and the ring orientation sign.

### 3.6 Fixed timestep and lifecycle

- `PaperRoom` owns one `setInterval(…, 1000 / C.TICK_RATE)`. Each wake: `acc += now() - last`, run
  `min(4, floor(acc / DT))` steps of `arena.update(DT)` with `DT = 1000 / 60` exactly (never `loop()`, which needs
  rAF and adds `Math.random()` jitter, `paperGame.js:685-724`), and if more than 4 were due drop the backlog
  (`acc = 0`). `DT` is under `2 * FRAME_MS` so one call is always a legal step. Snapshots go out every second tick
  (30 Hz).
- Every deadline (hold, shrink delay, push grace, empty-arena sweep) reads `room.now()`; tests subclass and step it
  (`test/shooter.test.js:8-17`).
- **Idle:** the interval exists only while `humanCount > 0`. A paid arena with money on the floor and nobody in it is
  frozen, not destroyed. The free arena freezes its bots. The first join restarts the interval with `last = now()` so
  there is no catch-up burst.
- **Free arena warm-up:** once, at server boot, the primary free arena runs the solo warm-up (6000 updates of
  `50 + Math.random()` ms, `paperMain.js:108-131`, `paperSkins.js:198`) in chunks of 100 updates per `setImmediate`
  (about 8 ms per chunk from the notes' 474 ms total). A join that arrives mid warm-up is accepted; the chunks
  finish first because the interval is not started until `cycle >= prepareCounter`. Overflow free arenas skip the
  warm-up (bots spawn small and grow; two or three spawn attempts run every tick, `paperGame.js:530-534`).

## 4. Rooms, registry, sockets (WP C and E)

### 4.1 `server/paperArenas.js`

Not a `LobbyRegistry` (its sweep deletes a paid room after 5 empty minutes whatever is on its floor,
`server/LobbyRegistry.js:84-95`) and never the snake `ladder` (`server/index.js:1704-1715` would throw on
`room.snakes`). A plain map:

```
arenas = { '0.00': [PaperRoom], '0.10': [PaperRoom], '1.00': [PaperRoom] }     // keys: Number(stake).toFixed(2)
pick(stake)   -> first room with humanCount < 16; else a new overflow room while list.length < 8; else null
all()         -> every room
sweep(now)    -> delete an OVERFLOW room (index > 0) only when humanCount === 0 AND floorMicro() === 0 for 5 minutes
boardRows()   -> three rows, always (section 9.2)
```

Only this server's `REGION` gets arenas (`server/index.js:1264`). Room ids: `paper_na_s0_10_a0` style, set as
`room.lobbyType` for the owner console; `room.stake` is numeric and is the only thing `isFree()` and `botsAllowed()`
read (`server/GameRoom.js:76-107`).

### 4.2 `server/PaperRoom.js` public surface

```
constructor(io, id, stake, { now })        room.stake, room.lobbyType, room.socketRoomName = 'pp_' + id
findSpawn() -> spot | null                 read only, max 200 tries of getSpawnPosition('random', baseRadius)
addHuman(socket, { name, worthMicro, wallet, spot }) -> unit
setInput(socketId, angleByte)   setHolding(socketId, on)
removeHuman(socketId, why)                 'disconnect' | 'leave'  -> killer-less death, drops a pickup
hasLiveUnit(socketId)  humanCount  playerCount  botCount  capacity = 16
isFree()  botsAllowed()  topUpBots()  addBot()  clearBots()        console contract (server/ShooterRoom.js:441-491)
liveStakeTotal() -> USDC float             (live human micro + floor micro) / 1e6
floorMicro()
get snakes()                               Map of { alive, isBot, worth } for ops.drainStatus (server/ops.js:57-66)
get players()                              Map socketId -> { socket, unitId, name, wallet }
hooks: onCashout, onTransfer, onRefund, onHouse          (set by index.js; the room never requires money or db)
start() stop() tick()
```

`findSpawn` rejects candidates farther from the centre than `radiusFor(max(4, n - 3)) - 60`, so a fresh radius 30 base
is not swallowed by the next few shrinks (section 8.7). In the free arena with 16 squares `addHuman` first removes the
LOWEST ranked `BotUnit` with reason 6 (system removed, no particles, `paperGame.js:353`); it never removes a human.
`removeHuman` calls `socket.leave(socketRoomName)` (GameRoom does, ShooterRoom forgets: `server/GameRoom.js:262`).

### 4.3 Events (prefix `pp:`; unused today, see `understand-rooms-netcode.md`)

Client to server:

| Event | Payload | Emit | Notes |
|---|---|---|---|
| `pp:join` | `{ name, stake, entryToken }` | reliable | `socketRL` 1000 ms; order in 5.3 |
| `pp:respawn` | `{ entryToken }` | reliable | stake comes from `socket._ppStake`, never the message |
| `pp:i` | one integer 0..253 | **volatile**, 30 Hz and on change | `Number.isInteger` check |
| `pp:hold` | `{ on: bool }` | reliable | `socketRL` 100 ms |
| `pp:need` | `{ what: 'sync' }` | reliable | `socketRL` 2000 ms, full resync |
| `pp:ping` | `{ t0 }` | volatile, every 2 s | reply `pp:pong { t0, ts }` |
| `pp:leave` | none | reliable | same as disconnect: money drops |

Server to client, reliable: `pp:joined` (full world), `pp:refused { why, refunded }`, `pp:spawn`, `pp:die
{ id, killerId, reason, micro, pickup? }`, `pp:base { id, ver, percent, ring }`, `pp:trail { id, epoch, from, pts }`
(10 Hz batches), `pp:pick+`, `pp:pick-  { pid, byId, micro }`, `pp:money { id, micro }`, `pp:holding { id, on }`,
`pp:out { id }` (a square cashed out), and to one socket `pp:dead`, `pp:cashedout { gross, cut, net }`, `pp:paid
{ sig }`, `pp:payerror`, `pp:refunded`. Server to client, **volatile**: `pp:s` (section 6.1). Socket state:
`socket._ppRoom`, `socket._ppStake`. Nothing of the snake's (`_room`, `_stake`, `_cashoutTimer`, `_walletAddress`)
is read or written; the payout wallet lives on the room's player record, which removes the snake's reconnect bug
class by construction.

### 4.4 `server/index.js` edits (single owner, about 45 lines)

1. `const paper = require('./paperSockets')({ io, arenas, ops, socketRL, sanitizeName, isStake,
   consumePaidEntryAtStake, entryStore, payout })` near the shooter room (`:1261`).
2. Inside `io.on('connection')`: `paper.attach(socket);` next to the `sh:*` handlers (`:2708-2743`).
3. Disconnect handler: `paper.drop(socket.id);` next to `endShooter` (`:2835`).
4. `sumLiveSelfCustodyStakes`: `for (const r of arenas.all()) total += r.liveStakeTotal();` after the ladder loop
   (`:1715`).
5. `ALL_ROOMS`: push `arenas.all()` (`:833`); `roomLabel` and `opsSnapshot` get one `paper` branch each
   (`:840-845,879-881`).
6. `liveBoard`: `return out.concat(arenas.boardRows()).sort(...)`. The snake mapping text that
   `test/v2route.test.js:197-213` pins is not touched.
7. Route: `app.get('/paper-arena', ...)` next to `/paper` (`:1123`), one path segment so relative urls resolve.
8. `setInterval(() => arenas.sweep(Date.now()), 60000)`.

`db.recordStake(` still appears exactly once (`test/v2route.test.js:158-171`), because Paper goes through
`recordEntry` via `consumePaidEntryAtStake`.

## 5. Money

### 5.1 Ledger (`server/paper/arenaLedger.js`)

Integer micro-USDC everywhere inside the room: `toMicro(worth) = Math.round(worth * 1e6)`. The ledger keeps
`inMicro` (entries), `outMicro` (cash-outs), `refundMicro`, `houseMicro`, and asserts after every mutation and once
per tick in tests:

```
inMicro === sum(unit.moneyMicro of live humans) + sum(pickup.micro) + outMicro + refundMicro + houseMicro
```

A violated assert logs `[PAPER] CONSERVATION` with the numbers and does not throw in production. Free arena: every
value is 0, so `worth > 0` guards keep every money path inert. Bots always have `moneyMicro` 0.

### 5.2 `ArenaGame.kill`, the one choke point

```
kill(victim, killer, reason) {
  if (victim.death) return;                                    // one capture can call kill twice (paperGameMoves.js:196-201)
  if (reason === 2 && victim.pushGraceUntil > this.nowMs) return;      // nobody dies from the shrink (8.3)
  if (reason === 6 && victim.isHuman) return;                          // a human is never system-evicted
  const micro = victim.moneyMicro | 0;
  victim.moneyMicro = 0;                                               // zero FIRST
  victim.holding = false; victim.holdMs = 0;                           // a hold dies with its life
  const at = { x: victim.position.x, y: victim.position.y };
  super.kill(victim, killer, reason);                                  // paperGame.js:341-372
  let pickup = null;
  if (micro > 0) {
    if (killer && !killer.death && killer.isHuman) { killer.moneyMicro += micro; this.events.transfer(victim, killer, micro, 'kill'); }
    else pickup = this.dropPickup(at, micro, victim.wallet);           // reasons 1, 2, 8 (disconnect), 9 (leave)
  }
  this.events.death(victim, killer, reason, micro, pickup);
}
```

Killer is defined for reasons 3, 4, 5 and undefined for 1, 2, 6 (`paperTerritory.js:237,240`,
`paperGameMoves.js:197,200`). New reasons: 7 cash-out (worth is already zero when it is raised, so no pickup and no
credit), 8 disconnect, 9 leave. The base only compares `!== 6` and `!== 0` (`paperGame.js:353,369`). Same-tick mutual
cuts are decided by the stock move order, which is rank order (`paperGame.js:445`, `paperGameMoves.js:333-336`); the
money is assigned exactly once either way. `events.transfer` becomes the room's `onTransfer`, which index.js wires to
`collusion.record(srcWallet, dstWallet, micro / 1e6, { lobbyType })` (`server/CollusionMonitor.js:42-52`); the
account id is the token-verified wallet, never a client id.

### 5.3 Join and respawn order (`server/paperSockets.js`)

```
pp:join { name, stake, entryToken }
 1. socketRL(socket, 'ppjoin', 1000)
 2. stake = Number(msg.stake); if (!isStake(stake)) -> refuse('bad stake')            // stakeRules.js:36-69
 3. if (socket._ppRoom && socket._ppRoom.hasLiveUnit(socket.id)) return               // duplicate guard, PLAY :2051-2055
 4. if (ops.get().maintenance) -> refuse('maintenance')                                // says why, :2715
 5. room = arenas.pick(stake); if (!room) -> refuse('full')
 6. spot = room.findSpawn();  if (!spot) -> refuse('no room')
 7. entry = consumePaidEntryAtStake(msg.entryToken, stake, 'paper')                    // :395-397; SAME number as step 5
    if (!entry.ok) -> refuse('Entry fee not verified')                                 // visible, never seated free
    if (stake > 0 && !(entry.worth > 0 && entry.walletAddress)) -> refuse('Entry fee not verified')
 8. socket._ppRoom = room; socket._ppStake = stake
    room.addHuman(socket, { name: sanitizeName(name), worthMicro: toMicro(entry.worth), wallet: entry.walletAddress || null, spot })
```

Steps 5 and 6 are read only and run in the same synchronous turn as step 8, so the seat and the spot cannot be taken
in between. `pp:respawn` is the same list with `stake = socket._ppStake` and `room = socket._ppRoom` if it still has
a seat, else `pick`. The client gets a fresh token through the existing `duel:restake` bridge
(`wallet-widget/src/main.jsx:355-378`, reference client `public/js/game.js:2031-2046`).

**Seat or refund.** `refuse(why)` for steps 4 to 6, when `stake > 0`, calls
`entryStore.consumeAtStake(msg.entryToken, stake)` directly (`server/entryStore.js:46-55`; not through `recordEntry`,
so no stake row is written) and, if it returns `ok` with `worth > 0` and a wallet, hands `{ wallet, name, micro }` to
`payout.refund`, which is `money.withdraw(wallet, worth)` of the FULL stake, `db.recordFailedPayout` on failure, no
retry, and no `recordEarnings` (the Knockout refund records earnings, `server/index.js:1245`; not copied). The token
is one-time, so a refund can happen once. The reply is `pp:refused { why, refunded: true }`. This closes the
"paid, refused at the door, token expires" hole the notes list for the other games.

### 5.4 Cash-out hold (server clock, tick driven, on the unit)

`pp:hold { on: true }` sets `unit.holding = true` only if the unit is alive, human and `moneyMicro > 0`.
`ArenaHuman.update` then yields `target = null`, so the square stands still from the next tick; its trail stays
cuttable, which is the intended risk. `stepHolds(dt)` adds `dt` to `holdMs` while holding; `on: false`, death or
disconnect reset it to 0. When `holdMs >= C.CASHOUT_HOLD_MS` (`shared/constants.js:22`):

```
const micro = unit.moneyMicro; unit.moneyMicro = 0;          // zero first, synchronously
ledger.out(micro);
this.kill(unit, undefined, 7);                                // square and land removed, no credit, no pickup
room.onCashout({ cashoutId: ++seq, socket, wallet: unit.wallet, name: unit.name, micro, stake, lobbyType });   // exactly once
```

The client is never asked whether the hold finished. Because the hold lives on the unit and is advanced by the sim
tick, the snake's "die mid-hold, respawn, instant payout" bug (`server/index.js:2147-2213`) cannot occur here.

### 5.5 Pickups

`{ pid, x, y, micro, fromWallet }`, position clamped to `radius - 12` from the centre. `collectPickups()` each tick:
for each pickup, the first live HUMAN in `units` order with `distanceSq < 14 * 14` takes it:
`unit.moneyMicro += micro`, `onTransfer(fromWallet, unit.wallet, micro, 'pickup')`, reliable `pp:pick-`. Bots never
collect. Pickups are never culled; on a shrink they are moved radially to `radius - 12`. They count in
`liveStakeTotal()`. They survive an empty arena (the arena freezes). **Owner decision still open:** whether floor
money in an arena nobody has entered for a long time should be booked to the house; the default here is that it
stays until someone takes it, and the `onHouse` hook exists but is never called.

### 5.6 Payout (`server/paperPayout.js`, built with injected `{ money, db, trackEarning, sweepRake, REGION }`)

`pay({ cashoutId, socket, wallet, name, micro, lobbyType })`: refuses a `cashoutId` it has seen; `cut =
Math.round(micro * 0.10)`, `net = micro - cut`; if `micro > 0`: `trackEarning({ source: 'game_rake', game: 'paper',
amountUsdc: cut / 1e6, wallet, name, lobbyType, region })`, `sweepRake(cut / 1e6, 'paper ' + lobbyType)`; emit
reliable `pp:cashedout`; `money.withdraw(wallet, net / 1e6)` then `db.recordEarnings(wallet, name, amt,
money.fiatValue(amt))` and `pp:paid`, or on failure `db.recordFailedPayout(wallet, amt, name, 'paper …: ' +
e.message, e.broadcast)` and `pp:payerror`, never a resend (`server/index.js:2242-2256`). Injected deps make
"exactly once" and "failure is recorded, not retried" unit testable without the chain.

### 5.7 Disconnect, solvency, drain

- Disconnect or `pp:leave`: `room.removeHuman(id, why)` = `kill(unit, undefined, 8 or 9)`, which drops the pickup.
  No reconnect grace (brief rule 5; a held stationary square carrying money is a free kill). The client shows a
  "Disconnected, your money dropped where you stood" screen and does not re-emit `pp:join` on reconnect.
- Solvency: edit 4 in 4.4. Live human worth plus floor money, counted once each.
- Drain: the `snakes` getter lists live humans only, so `ops.drainStatus` reports paid Paper players with no edit
  to `server/ops.js`. Floor money is reported as `floorWorth` in the ops snapshot but does not block a drain.

## 6. Snapshots (WP D)

One shared payload per room per frame, `io.to(socketRoomName).volatile.emit('pp:s', buf)`. An arena is at most 1900
units wide with 16 squares, so interest cells are pointless here.

### 6.1 Volatile frame `pp:s`, 30 Hz, little-endian `ArrayBuffer`

Header, 16 bytes: `f64 serverTimeMs`, `u32 tick`, `u16 radius*64`, `u8 unitCount`, `u8 pickupCount`.
Per unit, 24 bytes: `u16 id`, `u16 x*32`, `u16 y*32`, `u8 dir` (radians wrapped to 0..2PI then `*256/2PI`;
`unit.direction` is unbounded, `paperGameMoves.js:63`), `u8 flags` (bit0 bot, bit1 holding), `u8 hold` (holdMs *
255 / 3000), `u8 trailEpoch`, `u16 inId` (0 none, own id home, else the enemy base owner), `u16 baseVer`,
`u16 percent*65535`, `u16 trailCount` (wire points sent reliably so far), `u32 moneyMicro`, then `u8 tailN` and
`tailN` pairs of `u16` (the provisional tail, 6.3). Per pickup, 10 bytes: `u16 pid`, `u16 x*32`, `u16 y*32`,
`u32 micro`. Sixteen squares is about 450 bytes.

Everything in the frame is STATE, never a delta, so a dropped frame costs 33 ms of staleness and nothing else. The
version fields (`baseVer`, `trailEpoch`, `trailCount`) let a client notice that its reliable stream and the frame
disagree for more than 500 ms and send `pp:need`.

### 6.2 Bases: reliable, versioned, decimated

`base.ver` is bumped by: own return (`handleReturn` override), being carved (detected in the post hook by comparing
`base.square` and `polygon.segments.length` with the last sent values; `polygon.insert` adds collinear vertices that
need no send, `paperGeom.js:680-690`), and a trim. On a bump the room sends `pp:base { id, ver, percent, ring }` with
the ring decimated by a streaming perpendicular-distance filter at 0.4 u and packed as `u16*32` pairs. Rings of 450 to
1851 vertices come down to a few hundred. Percent is sent as a number because a decimated ring cannot reproduce it.

### 6.3 Trails: reliable batches plus a provisional tail

Per away unit the server keeps a WIRE polyline fed in the post hook from new `track.polyline` points: a point is
committed to the wire when the newest point deviates more than 0.35 u from the line through the last wire point and
the current candidate, or lies more than 40 u past it. That removes the micro segments a wall-hugging unit lays
(5885 points in 25 s in the notes' probe). Every 100 ms the room sends reliable `pp:trail { id, epoch, from, pts }`
for units with new wire points. `epoch` increments on every trail reset (return, death, `recoverTail`). Wire points
committed since the last batch ride in the volatile frame as the provisional tail and are replaced wholesale each
frame. The client draws `reliable points + provisional tail + the unit's current position`; `strokeTrack` only
strokes `track.polyline.path` (`paperRender.js:45-50`), so the live head point is what keeps the trail attached to
the square. If `from` does not equal the client's count, it sends `pp:need`.

### 6.4 `pp:joined`

`{ you, stake, radius, serverTime, units: [{ id, name, skin, bot, x, y, dir, inId, money, percent, ring, ver, trail,
epoch }], pickups }`. `skin` is the colour skin NAME (its main hex); the server takes it with `skinManager.get()`
(random unused, 36 colours for 16 squares, `paperSkins.js:465-475,527`) and the client asks its own manager for
`get(name)`.

## 7. Client (WP F and G)

### 7.1 Replica game (`paperMirror.js`)

`ClientArenaGame extends P.Game`, built like `createGameApi.create` (`paperMain.js:77-103`) with the real view, a real
`P.InputController`, its own `SpatialGrid` and `P.ArenaBorder.circular`. `visible = true`, `cycle =
config.prepareCounter` so `loop()` takes the visible branch (`paperGame.js:690,702-713`), `renderer = function (g) {
P.renderGameFrame(g); hud.draw(g); }`. `player` = the local mirror unit, so the HUD gate, camera focus, follow-killer
glide and `isPlayer` all work as in solo (`paperRender.js:629-635`, `paperGame.js:566-581,680-682`).

`MirrorUnit extends P.GameUnit` (for `addLabel`, `onScoreChanged`, `schemes`, `statistics`). Its constructor commits a
`TerritoryBase` (`paperUnits.js:348`), so it is built with the first ring and then `this.base.remove()` is called at
once: commit and remove are balanced and the polygon object keeps working (`paperGeom.js:669-672`). After that:

- `setRing(points)`: `this.base.polygon = new P.Polygon(points); polygon.calcPath();` never committed.
- `setTrail(points)`: a `P.Polyline` filled by hand (`segments = new P.Segment(a, b)` per pair, `start`, `end`, bounds,
  a fresh path). `Polyline.addDistinct` is NOT used because it commits (`paperGeom.js:594-612`). Rebuilt each frame for
  away units in view only.
- `in` is resolved from `inId` to the owning mirror's `base` object so `renderTracks` and the minimap "invaded" test
  keep working (`paperRender.js:307,410-412`).
- The local unit overrides `get isPlayer() { return true; }` so stock "Kill" and "+x.xx%" labels appear
  (`paperUnits.js:306-329`); they are raised from `pp:die` and `pp:base` events.
- On `pp:die` the mirror calls `P.spawnDeathParticles` with the victim's real segment arrays, as `kill` does
  (`paperGame.js:354-355`), releases the skin and splices the unit. For the local unit it sets `killer` and keeps
  `player` for the stock follow-killer delay before the death overlay.

`update(dt)` (called by the unchanged `loop`): `readInput(dt)` and the angle quantise (one line, same as
`paperGame.js:409`); send the byte; sample the snapshot buffer; predict the own square; then the cosmetic subset of the
stock tick: `unit.scale` from percent (`:421`), sort by percent and set `top` (`:445-448`), labels and particles
(`:449-453`), camera scale ease (`:523-525`), crumb particles for units inside an enemy base
(`paperGameMoves.js:375-377`), `cycle++`.

### 7.2 Interpolation and prediction (`paperNet.js`)

Copied approach from `public/js/game.js` (clock offset EMA, `INTERP_DELAY_MS` 70 with an adaptive jitter buffer to
180 ms, 200 ms dead-reckon cap, full reset on join: `game.js:73-84,361-428`). Others: position lerp and shortest-arc
direction lerp between the two frames around `renderTime`. Own square: each client frame build `target` from the
local angle (null while holding), call `P.Game.prototype.getMovement.call(mirror, dt, me)` (it reads only
`config.unitSpeed`, the unit and the border, `paperGameMoves.js:49-102`) and walk `me.position` along the pieces.
Keep 1 s of predicted positions by time. On each frame: `err = serverPos - predictedAt(serverTime - rtt / 2)`; apply
10 percent of `err` per frame; snap if `|err| > 40` (push, respawn). The own `in` flag is predicted with
`me.base.polygon.inside(me.position)` so the trail starts on the frame you leave home. The client border is rebuilt
from the frame's radius, with `mirror.square` recomputed, whenever it changes by 0.5 u.

### 7.3 Page and shell (`paper-arena.html`, `paperArenaMain.js`)

Loads `/socket.io/socket.io.js`, the ten solo scripts in `paper.html` order (`public/paper.html:52-61`; `paperMain.js`
only exports, the solo page's own inline script is what boots solo), then `paperWire.js` and the four client `mp/`
files. No inline
module scripts (`test/inlineScripts.test.js:36-43`). Reads `playerName`, `stake`, `entryToken`, `walletAddress` from
sessionStorage, sends `pp:join` once, then `sessionStorage.removeItem('entryToken')`. Calls `window.focus()` on load
and on first pointer down (held Q needs focus). Exits with `window.parent.postMessage('game:done', '*')` and a
non-framed fallback (`public/js/shooter.js:1085-1089`). Overlays: refused (with the reason and "refunded" when
true), dead ("You lost $0.20" and Play again: free sends `pp:respawn`; paid posts `{ type: 'duel:restake', game:
'paper', stake }` and sends `pp:respawn` with the token from `duel:restake:done`), cashed out (gross, cut, net, then
"sent" or the delayed-payout message), disconnected.

### 7.4 HUD additions (`paperHud.js`), drawn after `renderGameFrame`

The pass rebuilds the world transform from `game.origin` and `game.scale` with the same maths as
`paperRender.js:599-604` and `paperGame.js:562-565`. It does NOT call `getRenderContext()` a second time, because that
call advances the follow-killer glide (`paperGame.js:576-582`).

- **Money over heads:** `'$' + (micro / 1e6).toFixed(2)` above the name, same font and shadow recipe as `drawUnitName`
  (`paperRender.js:141-168`) in a gold fill, one line higher. Hidden when `micro === 0`, so the free arena shows none.
- **Pickups:** a coin disc with the amount, world space.
- **Cash-out ring:** for every unit with the holding flag, an arc around the square filled to `hold / 255`; for the
  local player also a centred "Cashing out 2.1 s, release to cancel" line.
- **Controls:** Q keydown (ignoring `repeat`, and only when `evt.target === document.body`, the rule
  `paperInput.js:87-97` follows) sends `pp:hold on`, keyup or window blur sends off. A DOM button
  `#pp-cash`, bottom LEFT (the minimap owns bottom right, `paperRender.js:401`), `touch-action: none`, pointerdown =
  on, pointerup / pointercancel / pointerleave = off. It sits outside the canvas, so it never steers
  (`paperInput.js:49-58` listens on the canvas only). Shown when the arena is paid; on touch devices it is large, on
  desktop it is a small "Hold Q to cash out" hint. A Lobby button sits top left.

## 8. Arena radius and the trim (WP A for the stepping, WP B for the trim)

### 8.1 Target and easing

`radiusFor(n) = clamp(950 * sqrt(n / 16), 475, 950)`, exported from `paperWire.js` as a pure function. Paid arenas:
`n = units.length`. Free arena: fixed 950 (bots keep it full, and bots then never see a moving wall). Growth 60 u/s,
at once. Shrink 5 u/s, starting 2 s after the death that caused it. The radius is applied in quanta of 0.5 u:
`border.setRadius(r); game.square = border.polygon.square();` (`square` is otherwise computed once, in the
constructor, `paperGame.js:77`, and feeds percent and gain, `:418`, `paperGameMoves.js:319`). On a shrink quantum:
every base is flagged `_trimDirty` and pickups are clamped. Centre stays (1000, 1000) and the radius never exceeds
950 (`SpatialGrid.cell` does not clamp, `paperGeom.js:304-310`).

### 8.2 O(1) wall test

`makeCirclePoints` starts at angle 0 and steps `2PI / 300` (`paperGeom.js:883-897`), so wall edge `k` spans angles
`[k, k+1] * 2PI/300`. `wallInside(p)`: `d = |p - c|`; `d <= apothem` inside; `d > radius` outside; otherwise
`k = floor(atan2 / step)` and one half-plane test against edge `k`. Used by the push and by the trim.

### 8.3 Pushing squares inward (in `getMovement`)

Only when `!wallInside(unit.position)`, which in a static arena never happens (stock sliders sit ON the wall, so
reference behaviour is untouched). Push target = the point at `apothem - 0.5` on the radial through the unit, rotated
by 0.001 rad so it never lands on an exact symmetric coordinate (the wall-vertex hang). The push is the first piece,
`new P.Segment(unit.position, target)`, and the rest comes from `super.getMovement` evaluated from `target`; it runs
through the normal crossing pipeline so `in` flags, own-base crossings and trail cuts stay consistent. It applies to a
holding (locked) square too. It sets `unit.pushGraceUntil = nowMs + 750`; during that window `kill` ignores reason 2
for that unit only (the notes' probe: a wall-hugging square dies on the first shrink step through the stock
self-cross rule, `paperTerritory.js:225-238`, and survives 1500 shrink ticks with the veto). The veto is per unit and
timed, not "while the arena shrinks", so the stock rule that pressing into a static wall eventually kills is kept.

### 8.4 The trim algorithm (`arenaTrim.js`, pure, returns a plan; the caller applies it)

`planTrim(base, border, anchor) -> { status, keep? }` with `status` one of `clean`, `blocked`, `invalid`, `empty`,
`ok`.

1. **Classify.** `out[i] = !wallInside(v_i)` for every ring vertex `v_i = segments[i].start`. None out: `clean`.
   An edge with both ends inside is inside (the wall is convex). An edge with both ends outside is treated as outside:
   new and stock edges are at most one wall edge long (19.9 u), so the ignored sliver is under 0.1 u deep.
2. **Crossings.** For every ring edge whose ends differ, find the crossing by 40 rounds of bisection on `wallInside`,
   then project it onto its wall edge `k`. Record `{ ringIndex, kind: 'exit' | 'enter', k, t }` where `t` orders points
   along edge `k`. Exits and enters must alternate around the ring and be equal in number, else `invalid`.
3. **Walk (Weiler-Atherton, convex clip).** Sort crossings by wall position `(k, t)`. The wall is walked in the
   direction given by `sign(ring.rawSquare()) * sign(wall.rawSquare())` (same sign: increasing `k`). From each
   unvisited `enter` crossing: follow the ring's inside vertices to the next `exit`; then follow the wall to the next
   crossing in the walk direction, emitting the wall vertices passed; that crossing must be an `enter`, else
   `invalid`; repeat until back at the start. Each loop is one connected piece of `base ∩ arena`.
4. **Choose.** Keep the piece that contains `anchor` (the owner's position when home, else its trail start: the carve
   rule, `paperGameMoves.js:237-246`), tested with an uncommitted `new P.Polygon(pts).inside(anchor)`. None contains
   it: keep the largest. No pieces at all (every vertex out): `empty`.
5. **Preconditions (`blocked`).** Let `D` be the existing ring vertices that are NOT in the kept piece. Blocked if
   (a) the owner is away and `owner.track.polyline.start` is in `D` (the identity lookup at
   `paperGameMoves.js:163-164` would return -1), or (b) any vertex in `D` has a committed segment whose
   `shape.owner.isTrack` (a live trail crossing: deleting it mis-pairs a later carve, `paperGameMoves.js:257-311`).
   Both clear by themselves when that trail returns or dies.
6. **Validate (`invalid`).** At least 3 vertices; every coordinate finite and inside `radius + 0.01`; area at least
   50 and at most the old area plus 1; `sign(rawSquare)` unchanged; no new edge longer than 20 u (the broad phase
   finds a segment only through endpoints within one 20 u cell of the query, `paperGeom.js:323-349`).
7. **Plan.** `keep` = the vertex list in ring order, where every kept original vertex is the SAME `Vec2` object and
   crossings and wall vertices are new `Vec2`s (never the border polygon's own point objects).

`applyTrim(game, base, plan)` (ten lines, in `ArenaGame`, after `_enter()`):
`ring.remove(); ring.segments = pairs(keep).map(([a, b]) => new P.Segment(a, b)); ring.commit(base);
base.calcSquare(); ring.calcPath(); base.ver++;` then every unit with `in === base` whose position is no longer inside
gets `in = null`, exactly what carve does for bystanders (`paperGameMoves.js:250-254`). Remove-then-commit is the
order `Polygon.right` and `unsplice` already use (`paperGeom.js:709-740`); a shared vertex keeps its other shapes'
segments, and a vertex that drops to zero segments leaves its cell and is re-registered at the same coordinates on
commit (`paperGeom.js:381-397`). `segment.remove()` is called once per old segment, all of them committed, so the
unguarded `splice(-1)` hazard does not arise.

### 8.5 When it runs

Only in the post hook of `ArenaGame.update`, for bases flagged `_trimDirty` (every base on a shrink quantum, one base
after its own return because a trail laid before the shrink is merged as land outside the wall; the notes measured
5367 of 6469 ring vertices outside). At most 4 bases per tick; the flag stays set on `blocked` and `invalid`.

### 8.6 Fallbacks, in order

1. `blocked` or `invalid`: do nothing this tick, retry next tick. Land outside the wall is unreachable and harmless;
   percent carries no money.
2. Twenty consecutive `invalid` results for one base: log `[PAPER] TRIM` with the ring, stop retrying until the next
   radius quantum or return.
3. `empty`, or the owner cannot reach its base (no ring vertex inside the wall) for 3 s: **reseat**. With
   `_enter()`: `track.remove()`, `base.remove()`, take `findSpawn()`, give the unit a fresh spawn circle there
   (`P.makeCirclePoints(spot, baseCount, baseRadius)` as `spawnBot` does, `paperGame.js:216`), move the unit to it,
   `in = base`, `base.ver++`, reliable `pp:base` plus a snapped position. Money is untouched. If `findSpawn` fails,
   retry every second. Nobody is killed.

### 8.7 Making the hard cases rare

`findSpawn` keeps new humans inside the radius the arena would have with three fewer squares, minus 60 u. A one
player step is 30 to 56 u, so a fresh base survives several deaths before the wall reaches it.

## 9. Lobby wiring for Free, $0.10, $1.00 (WP H)

### 9.1 Catalogue and launch

- `public/v2.html:2165`: `{id:'paper', …, built:1, ladder:1, noskin:1, d:…}`; `solo:1` and `soloNote` go. `ladder:1`
  makes `startFromDetail` take the arena path (`playChosen`) instead of the forced `{lobbyType:'free'}` at `:3309`.
  `noskin` adds a class that hides the snake colour row (`.lookrow`, `:1862-1866`). Markup order `#stakes`,
  `#play-name`, `startFromDetail()`, `#dlob` is left alone (`test/v2route.test.js:409-431`).
- `public/js/v2/play.js:274`: `OWN_PAGE.paper` becomes `'/paper-arena'`. Free Paper keeps the no-login shortcut it
  has today (the widget path needs a wallet even for stake 0, `wallet-widget/src/main.jsx:181-189`), and a paid seat
  still never takes it (`play.js:280-281`). Two lines are ADDED inside the shortcut after the name write (`:288`):
  `sessionStorage.setItem('stake', '0'); sessionStorage.removeItem('entryToken');` so a free launch after a paid game
  cannot read a stale rung and a burnt token. `play.js` still contains none of `submit-stake`, `stake-quote`,
  `signTransaction`.
- `wallet-widget/src/main.jsx:217`: add `paper: '/paper-arena'` to `PAGES`, then `npm run build` and commit
  `public/wallet/widget.js` (the deploy does not build, `.github/workflows/deploy.yml:34-35`). Until this ships a paid
  Paper launch opens the snake page holding a Paper token, so H lands before or with E, never after.
- `public/js/v2/board.js:127-130`: the pinned `paper:free` lobbyType row is removed; the free rung is pinned by stake
  with one ADDED line next to the snake pin (the snake pin text is asserted verbatim, `test/v2route.test.js:806-822`).
- `test/v2route.test.js:1132-1137` is rewritten in the same commit: Paper is `built:1`, `ladder:1`, not `solo:1`, not
  `paid:1`; snake keeps `ladder:1`; agar still has none.

### 9.2 `/api/live`

`arenas.boardRows()` returns, always, `{ id: 'paper:na:s<rung>', game: 'paper', region, stake: rung, players,
bots, capacity: 16, state: 'open' }` for 0, 0.10 and 1, with `players` summed over that rung's arenas and, for the
free rung, `bots = players > 0 ? live bot count : 15` (what you will find, as the shooter reports,
`server/index.js:1396-1411`). Rows existing at all times is what lights the three rung buttons
(`public/js/v2/board.js:141-146`, `public/v2.html:2220-2223`).

## 10. Tests (all flat in `test/`, `node:test`, 470 existing tests stay green)

- `paperWire.test.js`: `radiusFor` table (n = 0, 4, 5, 8, 15, 16, 20); frame encode/decode round trip; direction wrap;
  trail decimator keeps corners and drops wall micro segments.
- `paperTrim.test.js` (stub `Math.random`): clean base untouched; one run trimmed and area equals the analytic
  circle-clip within 0.5 percent; kept `Vec2` identity preserved; grid point count balanced after apply; run wrapping
  ring index 0; U-shaped base keeps the anchor's prong; exit vertex outside gives `blocked`; foreign trail crossing in
  the dropped set gives `blocked`; `empty` for a base wholly outside; no output edge over 20 u; 200 random shrink
  steps on a warmed arena with zero throws and every surviving ring simple by area sign.
- `paperArenaGame.test.js`: steer by angle byte; hold gives zero displacement; two arenas interleaved keep separate
  grids; border guard ends the wall-vertex hang; shrink with a wall-hugging square: no death, ends inside; reseat;
  bots 15 plus humans never above 16; `spawnBot` inert at stake > 0; prey wrap makes a bot enter `attack` on a long
  human trail; `unit.log` stays empty; `stop()` clears the timer.
- `paperRoomMoney.test.js`: kill transfer (0.10 + 0.10 shows 0.20, then the next killer gets 0.20 on top); multi-victim
  capture pays once per victim; self-cross drops one pickup at the death point; pickup collected once, `onTransfer`
  called with the dropper's wallet; hold completes at 3000 ms on the fake clock and not at 2999; cancel resets;
  die mid-hold then respawn does not pay; `onCashout` exactly once with worth already zero and the unit gone;
  disconnect drops a pickup and clears the hold; `liveStakeTotal` equals humans plus floor; **conservation property
  test**: 5000 random ticks of joins, kills, pickups, cash-outs, disconnects and shrinks, assert the ledger identity
  every tick; free room never calls any hook.
- `paperRoomBots.test.js`: THE ONE RULE (`botsAllowed` from stake, `addBot` null and `topUpBots` inert at stake > 0),
  bots carry zero money and never trigger `onCashout`.
- `paperRoom.test.js`: socket double with `emit` and `volatile.emit`; `pp:s` is volatile, receipts reliable and sent
  once; idle room has no interval; `removeHuman` leaves the socket room; `snakes` getter shape for `drainStatus`.
- `paperPayout.test.js` (fake deps): 90/10 in integers; `recordEarnings` only after `withdraw` resolves;
  `recordFailedPayout` and no second `withdraw` on rejection; duplicate `cashoutId` ignored; refund pays 100 percent
  and records no earnings.
- `paperArenas.test.js`: 17th player gets an overflow arena; overflow with floor money is not swept; rows always three.
- `paperJoinSmoke.test.js` (real server, env as `test/joinSmoke.test.js:36-67`): free join gets `pp:joined` and
  `pp:s`; paid join with no token is refused visibly; bad stake refused; `/api/live` has three paper rows.
- By hand before shipping: the goldens and solo node tests in `../paperio-reference/harness`, and
  `node --check` on every new file.

## 11. Build order

D and B first (no dependencies). A next, against B's interface. C on A. E and F in parallel once C's hooks and D's
codec exist. G on F. H can start on day one but merges no later than E. First playable milestone: free arena end to
end (A, C, D, E without money, F, G). Second: paid entry, kill transfer, cash-out. Third: radius and trim.

## 12. Open questions for Owen (defaults chosen, none block the build)

1. Floor money in an arena nobody visits: stays for ever (default), or booked to the house after some hours.
2. A full stake refund when a paid join is refused at the door (default: yes).
3. A brief network drop costs the player their money (brief rule 5, no reconnect grace). Confirmed as intended?
