# Paper multiplayer: how rooms and netcode work in this codebase today

Written 2026-09-20 from a read of the code, for the engineer building the Paper room. Every claim cites a file and
line. Paths are relative to `slither-clone/`. Nothing here was run; it is a reading, not a measurement.

Binding context: `docs/paper-multiplayer-brief.md` (the owner's rules) and `CLAUDE.md` (money invariants, netcode rules).

---

## 0. The short version

- There is ONE Socket.IO server, ONE default namespace and ONE `io.on('connection')` block
  (`server/index.js:93-100`, `server/index.js:2028-2874`). Games are separated by EVENT PREFIX, not by namespace:
  snake uses the bare names in `C.EVENTS` plus `cashout:*`, `view`, `spectate:join`; agar uses `cell:*`; knockout
  `ko:*`; battleship `bs:*`; bowmasters `tanks:*`; the shooter `sh:*`; battle royale `br:*`. No `pp:` or `paper:`
  prefix exists yet, so Paper can take one without colliding.
- Each game page opens its OWN socket (`public/js/shooter.js:22`, `public/js/game.js:112`), inside the lobby's
  iframe. One socket therefore equals one game page. The handshake carries no identity (CLAUDE.md, "socket handshake
  session is EMPTY"); identity is whatever the entry token says (`server/index.js:2123-2127`).
- A room is a plain class that receives `io`, owns a `setInterval` tick, joins sockets to a Socket.IO room name, and
  emits snapshots with `volatile.emit`. `server/index.js` owns the socket handlers and ALL money movement; the room
  only says who and when (see the battle royale seam, `server/index.js:1289-1324`).
- The shooter (`server/ShooterRoom.js` + `public/js/shooter.js` + `public/shooter.html`) is the newest arena and the
  closest template: own page, own prefix, one class, per-socket JSON snapshots, testable clock. But it is FREE ONLY and
  single-room, so Paper needs three things the shooter does not have: a room per stake, the paid-entry door, and a
  server-timed cash-out that pays. Those come from the snake path (`server/index.js:2050-2140`, `2152-2264`,
  `2349-2384`).

---

## 1. Where rooms are created and registered (`server/index.js`)

| Thing | Where | Shape |
|---|---|---|
| Socket.IO server | `server/index.js:93-100` | `pingInterval: 5000`, `pingTimeout: 10000`, CORS allow-list. No transport is forced. |
| Page routes | `server/index.js:1119-1123` | `/shooter` and `/paper` are `sendFile` routes declared BEFORE `express.static` (`:1125`). `/shared` is served from `../shared` (`:1126`). |
| `gameRooms[region][type]` | `server/index.js:1130`, built at `:1264-1273` | Only THIS server's region is built (`for (const rgn of [REGION])`, reason at `:1132-1138`). Types: `free`, `dime`, `dollar` (class `GameRoom`) and `br` (`BattleRoyaleRoom`). The three fixed tiers are marked `fallbackOnly` (`:1288`) and are off the lobby board. |
| `agarRooms[region][type]` | `server/index.js:1131`, built at `:1326-1330` | `free`, `dime`, `dollar`, class `AgarRoom`, names `agar_${rgn}_${type}`. |
| Snake stake ladder | `server/index.js:1599-1610` | `new LobbyRegistry({ emptyMs: 5min, makeRoom })`. `makeRoom(game, rgn, stake)` IGNORES `game` and always builds a `GameRoom` named `${rgn}_s${stake}` with `r.stake = Number(stake)`. Free rung opened at boot (`:1619`). Swept every 60 s (`:1964`). |
| Shooter | `server/index.js:1261-1262` | ONE instance for the region: `new ShooterRoom(io, REGION)`, plus `endShooter(socketId)`. Not in any map. |
| Knockout / Battleship / Bowmasters | `server/index.js:1142-1143`, `:1192`, started `:1332-1334` | Queue objects that mint a room per match; settlement callbacks (`onSettled`, `onRefund`) live in index.js (`:1162-1234`). Not relevant to a persistent arena except as the pattern "room decides, index.js pays". |
| Room start | `server/index.js:1331-1335` | Fixed rooms are started at boot. Ladder rooms are started by `LobbyRegistry.get` (`server/LobbyRegistry.js:50`). The shooter starts itself on first join (`server/ShooterRoom.js:412`). |

### The ladder is already free, $0.10, $1.00

`server/stakeRules.js:36-38`: `STAKE_TIERS = [0.10, 1]`, `ALL_STAKES = [0, 0.10, 1]`. These are exactly Paper's three
lobbies. (The comment at `server/index.js:376` still lists nine rungs; it is stale, the code is three.)
`isStake(v)` compares in cents (`server/stakeRules.js:45-46`). The fixed-tier fee table is
`server/money.js:23` (`{ free: 0, br: 0, dime: 0.10, dollar: 1.00 }`), exposed as `LOBBY_FEES` (`server/index.js:365`).

### `LobbyRegistry` contract (`server/LobbyRegistry.js`)

- Key is `game:region:stake.toFixed(2)` (`:31-33`), so `ladder.get('paper', REGION, 0.1)` is a different key from the
  snake's and would not collide.
- `get` creates on demand and calls `room.start()` if present (`:35-54`).
- `list()` reads `room.players.size`, `room.botCount`, `room.capacity` (`:66-82`).
- `sweep()` needs `room.players.size` and calls `room.stop()`; the stake-0 room is never swept; a room with
  `holds > 0` is never swept (`:84-95`). `hold()` exists (`:59-64`) but NOTHING in index.js calls it; that is safe today
  only because `get` recreates a swept room on join.

### Things that iterate "all rooms" and assume a snake shape

Putting a Paper room INTO `ladder` is tempting and would break these, because they all walk `ladder.rooms`:

- `sumLiveSelfCustodyStakes` does `for (const [sid, snake] of room.snakes)` on every ladder room
  (`server/index.js:1704-1715`). A room without a `snakes` Map throws inside the solvency job.
- `ALL_SNAKE_ROOMS` pushes every ladder room (`server/index.js:813-822`); `roomLabel` prints every non-tanks, non-agar
  room as "slither.io" (`:840-871`).
- `liveBoard` filters `l.game === 'snake'` (`server/index.js:1361-1363`), so it is safe, but Paper rows would not
  appear either.

So Paper wants its OWN registry instance (a second `new LobbyRegistry({ makeRoom: ... PaperRoom })`) or a fixed
trio map like `agarRooms`. Either way it must then be ADDED BY HAND to the lists in section 8.

---

## 2. The shooter, end to end (the wiring Paper copies)

### Server class: `server/ShooterRoom.js`

- Constants live on an exported `SH` object in the room file, not in `shared/constants.js` (`:31-84`). Own
  `TICK_RATE: 30` (`:34`).
- Constructor `(io, roomId)`: `this.socketRoomName = 'sh_' + this.id` (`:133-136`), `this.lobbyType = 'tanks'`
  (what the owner console keys on, `:139`), entity Map `this.tanks` holding players AND bots (`:140`).
- `now()` is the single clock read (`:157-164`), so tests subclass it and step a fake clock
  (`test/shooter.test.js:12-17`). Tests pass `io = { to: () => ({ emit() {} }) }` and socket doubles with `join`,
  `emit`, `volatile.emit` (`test/shooter.test.js:6`, `:26-31`).
- `addPlayer(socket, name, weapon)`: make entity keyed by `socket.id`, keep `t.socket`, `socket.join(room)`,
  `topUpBots()`, `start()` (`:407-414`).
- `removePlayer(id)`: carried coins drop as a pickup, entity deleted; if no humans remain the room STOPS, clears every
  entity and rebuilds the map (`:416-436`). Note it never calls `socket.leave(this.socketRoomName)`, so a socket that
  pressed Leave keeps receiving `sh:killed` / `sh:banked` room broadcasts until it disconnects. `GameRoom.removePlayer`
  does leave (`server/GameRoom.js:262`). Copy the GameRoom behaviour.
- Owner-console interface, same four names on every room type: `playerCount`, `botCount`, `addBot()`, `clearBots()`
  (`:441-467`).
- THE ONE RULE: `botsAllowed() { return !Number(this.stake || 0); }` and `topUpBots()` deletes every bot the moment
  the room has a stake (`:469-491`). Same rule on the snake room: `isFree()` asks `this.stake`, never the room's name
  (`server/GameRoom.js:76-107`).
- Loop: `start()` is idempotent, `setInterval(tick, 1000 / SH.TICK_RATE)`; `stop()` clears it (`:586-590`).
- `tick()`: idle skip (runs 1 tick in 10 with no humans, `:606-612`), fixed `dt = 1 / TICK_RATE`, step entities,
  `broadcast()` EVERY tick, then clear the per-tick delta arrays (`:614-631`).
- Input: `setInput` coerces every field to 0/1 and accepts `aim` only if finite (`:552-561`). Bots are refused.
- Hold-to-bank is INPUT STATE timed by the room: `input.bank` accumulates `t.quickMs += dt * 1000`, resets to 0 the
  tick the flag is down, completes at `QUICK_BANK_MS` (`:699-723`). Progress is sent back as `you.quick` 0..1
  (`:1019`). This is the simplest server-owned hold in the codebase and it is driven by the room clock, so it is
  testable.
- Cash-out leaves the arena: `dead = true; cashedOut = true` (`:743-757`), a room-wide `sh:banked` and a RELIABLE
  per-socket `sh:cashedout` receipt (`:759-764`). Bots can never bank (`:731-735`).
- Death: carried value drops as ONE pickup at the death spot, killer only gets a kill count; whoever touches the
  pickup first takes it (`:951-971`, `:973-993`). Paper rule 5 (no-killer death) is this mechanic; Paper rule 2
  (killer takes all) is NOT, it is a direct transfer.
- Respawn is asked for, never automatic, and refused unless dead (`:767-775`).
- Snapshot: `snapshot(forId)` builds a per-viewer JSON object with a `you` block, everyone else, pickups, fx, per-tick
  deltas (`cells`, `hits`) and a top-6 board (`:1001-1055`). Value carried is shown over every head as `v`
  (`:1030-1035`). Numbers are rounded to 1 or 2 decimals (`:1087-1088`).
- Broadcast: one encode PER SOCKET, `t.socket.volatile.emit('sh:state', ...)`, justified by the small head count
  (`:1068-1077`).
- Static world sent once, reliably, on join: `mapPayload()` (`:1057-1066`), emitted from index.js (`:2718`).

### Socket handlers: `server/index.js:2708-2743`

```
sh:join    { name, weapon }  RL 1000ms, maintenance gate, removePlayer THEN addPlayer, then emit 'sh:map'
sh:input   (object)          type check only, volatile from the client, no rate limit
sh:weapon  { weapon }        RL 150ms, refusal is SAID ('sh:refused')
sh:respawn                   RL 400ms
sh:leave                     endShooter(socket.id)
disconnect                   endShooter(socket.id) at :2835
```

`sh:join` replaces an existing entity ("a second Play replaces the first", `:2716`). That is fine for a free room and
WRONG for a paid one: see pitfalls.

### Page and client: `public/shooter.html`, `public/js/shooter.js`

- Page loads `/socket.io/socket.io.js` then the game scripts (`public/shooter.html:109-113`). `public/paper.html`
  loads NO socket.io and NO `shared/` script today (`public/paper.html:52-61`).
- `var socket = io();` default transport, same origin (`public/js/shooter.js:22`). Name comes from
  `sessionStorage.playerName`, which the lobby writes before opening the frame (`public/js/shooter.js:24-27`,
  `public/js/v2/play.js:288`).
- Joins immediately on load: `begin()` emits `sh:join` (`public/js/shooter.js:1070-1083`). It does NOT re-emit on
  socket reconnect, unlike the snake (`public/js/game.js:127-134`).
- Input: `setInterval(sendInput, 1000 / 30)` with `socket.volatile.emit('sh:input', input)`
  (`public/js/shooter.js:214-239`). Full state every send, so a dropped packet is superseded.
- NO prediction, by design (`public/js/shooter.js:5-9`). It keeps the last two snapshots and lerps between them by
  arrival time, with the playback span smoothed toward the nominal 33 ms and clamped to 0.6x..2.2x
  (`public/js/shooter.js:259-277`, `:656-674`). Other tanks are matched by id, not index (`:798-815`).
- Leaving: `socket.emit('sh:leave')` then `window.parent.postMessage('game:done', '*')`, or `location.href = '/'` when
  not framed (`public/js/shooter.js:1085-1089`). The lobby's handler hides both frames, blanks `src`, resumes lobby
  animations, reloads the board and refreshes the wallet (`public/js/v2/play.js:427-433`).
- Receipt comes off the reliable event, not off a snapshot (`public/js/shooter.js:1107-1116`).
- Ping: `ping_check` / `pong_check` every 2 s, answered for every socket (`public/js/shooter.js:1128-1142`,
  `server/index.js:2386`).

### Lobby launch

- Free, own-page games skip the wallet widget: `OWN_PAGE` already contains `paper: '/paper'`
  (`public/js/v2/play.js:274`), taken only when `!staking` (`:280-296`). It sets `game-frame.src` and shows it.
- A PAID launch goes through the widget: `window.dispatchEvent(new CustomEvent('duel:play', { detail }))`
  (`public/js/v2/play.js:297-307`). The widget stakes (`stakeOnly`, `wallet-widget/src/main.jsx:75-144`), writes
  `playerName`, `googleId`, `walletAddress`, `stake` OR `lobbyType`, `entryToken`, `region` into sessionStorage
  (`:187-209`), then opens a page from `PAGES = { agar, knockout, battleship, snake }` in `game-frame`
  (`:216-230`). **`paper` is not in `PAGES`, so a paid Paper launch falls through to `/game.html` (the snake) holding
  a Paper-priced token.** The widget is a Vite build (`npm run build` to `public/wallet/`), so this is a source change
  plus a rebuild.
- Paid respawn: the game iframe posts `{ type: 'duel:restake', game, lobbyType, stake }` to the parent and waits for
  `duel:restake:done { entryToken }` (`public/js/game.js:2029-2046`, `wallet-widget/src/main.jsx:353-378`). The widget
  replies into `game-frame` for anything that is not agar (`:359`). Paper's "respawn is a new buy-in" reuses this as is.
- Catalogue: `public/v2.html:2165-2167` lists paper as `built:1, solo:1` with a "free, against bots" note;
  `ladder:1` (`:2133-2137`) is what tells the play path a game's Free is the stake-0 rung.
  `public/js/v2/board.js:127-130` pins a `paper:free` row with the comment that the server never reports it.

---

## 3. The snake room lifecycle (the paid pattern Paper must reuse)

### Join: `C.EVENTS.PLAY` (`server/index.js:2050-2140`)

Order matters and each step has a reason:

1. Duplicate guard: ignore PLAY while this socket's snake is alive (`:2051-2055`). The client re-emits PLAY on every
   socket `connect` (`public/js/game.js:127-134`).
2. Resolve the room from `stake` (ladder) or `lobbyType` (fixed tier) via `getRoomForJoin` (`:2066-2067`,
   `:1627-1633`). Unknown names fall back to the free tier LOUDLY (`:1641-1674`).
3. Maintenance gate, which SAYS why (`:2072-2075`).
4. Room-specific refusal (`br:locked`, `:2081-2084`).
5. `socket._stake` remembered for respawn (`:2085`).
6. RECONNECT BEFORE TOKEN: if `reconnectKey` matches a held snake, `room.reattach` and return without consuming a
   token (`:2093-2104`).
7. Paid entry: `consumePaidEntryAtStake(entryToken, stake, 'snake')` or `consumePaidEntry(entryToken, type, 'snake')`
   (`:2114-2120`). Defined at `:395-412`; the third argument is the game label written by `db.recordStake`. Free
   rooms pass through with `worth: 0`.
8. Identity from the token overrides the client's claim: `socket._googleId`, `socket._walletAddress` (`:2121-2127`).
9. `socket._room = room; socket._joinTime = Date.now(); room.addPlayer(socket, name, wallet, color, entry.worth)`
   (`:2128-2131`). Owner push notification, `lobbyConnections.delete`, `broadcastLobbyState()` (`:2132-2139`).

`GameRoom.addPlayer` joins the Socket.IO room, stores `{ socket, name, walletAddress, color }` in `players`, creates
the snake with `snake.worth = entrySol`, and emits a reliable `GAME_JOINED` carrying the static world
(`server/GameRoom.js:235-258`).

### Respawn: `C.EVENTS.RESPAWN` (`server/index.js:2349-2384`)

Blocked while alive (`:2351-2352`); room may veto via `allowsRespawn()` (`:2356-2359`); re-buys the room the socket
is ALREADY in using `socket._stake`, never a client-named room (`:2360-2370`); then `room.respawnPlayer`
(`server/GameRoom.js:751-770`) which re-emits `GAME_JOINED`.

### Cash-out hold (`server/index.js:2142-2273`)

- `cashout:start`: sets `snake.cashoutStartedAt`, arms `socket._cashoutTimer = setTimeout(doCashout, C.CASHOUT_HOLD_MS)`
  (3000 ms, `shared/constants.js:22`), broadcasts `cashout:started { id }` to the room and echoes to self
  (`:2152-2181`). THE SERVER COMPLETES THE HOLD; the client is never asked whether 3 s are up (`:2168-2174`).
- `cashout:cancel` clears the timer and broadcasts `cashout:cancelled` (`:2183-2189`). A second `disconnect` listener
  clears the hold too (`:2191-2192`).
- Legacy `cashout` event grants nothing unless the server-side hold has run (`:2197-2207`).
- `doCashout` (`:2209-2264`): read `worth` off the SERVER entity, zero it, mark dead without drops, take 10%,
  `trackEarning` + `sweepRake`, emit reliable `cashout:result`, `money.withdraw(socket._walletAddress, playerShare)`,
  on success `db.recordEarnings` + `cashout:paid`, on failure `db.recordFailedPayout` + `cashout:error`, never retry.
  It is closure-scoped per socket and exported as `socket._doCashout` (`:2273`) so a ROOM can trigger it
  (`:1301-1324`, which also re-checks `sock._room === room` before paying).
- Client side: Q hold UI, local ring, `cashout:start` / `cashout:cancel` (`public/js/game.js:1675-1746`). The snake
  SLOWS during the hold; Paper's rule is a full movement LOCK, which has to be applied in the sim by the server.

Two hold implementations exist: the snake's `setTimeout` in index.js, and the shooter's per-tick accumulator in the
room (`server/ShooterRoom.js:699-723`). For Paper the hold also has to freeze the unit inside the simulation, so the
room has to know about it either way; the shooter form (input flag, room clock, progress in the snapshot) keeps the
whole rule in one testable place, and the room then calls out to index.js to pay, the way the battle royale does.

### Disconnect (`server/index.js:2828-2873`)

One handler tears down every game: `tanksLobby.leave`, `knockoutLobby.leave`, `battleshipLobby.leave`,
`endShooter`, then agar (`socket._agarRoom.removePlayer`), then snake. The snake alone has a grace period: if the
snake is alive and the client sent a `reconnectKey`, `room.markOrphan(id, key, RECONNECT_GRACE_MS, finalize)` keeps it
gliding for 8 s (`:2857-2861`, `RECONNECT_GRACE_MS` at `:2000`, `server/GameRoom.js:287-337`); otherwise
`room.removePlayer` runs at once, which kills the snake and drops its worth as cash food tagged with the source
account for collusion tracking (`server/GameRoom.js:260-285`).

Socket properties in use, so Paper does not collide: `_room`, `_stake`, `_joinTime`, `_reconnectKey`,
`_cashoutTimer`, `_doCashout`, `_viewR`, `_viewX`, `_viewY`, `_cellRoom`, `_spectating` (snake); `_agarRoom`,
`_agarShortType`, `_agarViewR`, `_agarCellRoom` (agar); `_googleId`, `_walletAddress`, `_rl`, `_lastChat` (shared).

---

## 4. Tick loops and idle behaviour

| Room | Sim rate | Snapshot rate | Idle rule |
|---|---|---|---|
| `GameRoom` | `C.TICK_RATE` 60 (`shared/constants.js:6`, `server/GameRoom.js:227`) | `C.SNAPSHOT_RATE` 30: `everyN = round(TICK/SNAPSHOT)`, broadcast when `_tickN % everyN === 0` (`server/GameRoom.js:687-691`) | `audience() === 0` runs 1 tick in 10 and records `_tickSpan` so per-tick rate limits can compensate (`:424-453`). `audience()` counts players, else the Socket.IO room size so SPECTATORS count (`:802-810`). |
| `AgarRoom` | local `TICK_RATE = 60` (`server/AgarRoom.js:9`, `:105`) | every 2nd tick (`:306`) | same 1-in-10 skip (`:275-279`) |
| `ShooterRoom` | `SH.TICK_RATE` 30 (`server/ShooterRoom.js:34`, `:588`) | every tick (`:628`) | 1-in-10 skip with no humans (`:606-612`) AND a full stop plus reset when the last human leaves (`:427-434`) |

- All loops are plain `setInterval` on ONE thread shared with every periodic job; `GameRoom.tick` measures its own
  lateness and logs `[TICKLAG]` over 100 ms (`server/GameRoom.js:397-422`). `broadcastSnapshot` measures send gaps the
  same way (`:821-843`).
- GameRoom and ShooterRoom step a FIXED dt per tick, so a late tick slows the world rather than lengthening a step.
- Anything periodic inside a room is timed by the CLOCK, not by tick count, because the idle skip makes tick counts
  lie (`server/GameRoom.js:489-499`).
- Periodic process-wide jobs go through `everyStaggered(fn, periodMs, offsetMs, label)` so they do not pile onto one
  tick (`server/index.js:1879`, uses at `:1955-1965`).
- CPU is a real constraint: one core, and the comment at `server/ShooterRoom.js:596-600` records the instance's CPU
  credit balance at zero since 2026-09-08. An empty room must go quiet.
- The solo Paper `Game` is NOT a fixed-step sim. `Game.update(tickDtMs)` takes a variable dt
  (`public/js/paper/paperGame.js:398`); `Game.loop()` drives it from `requestAnimationFrame`, splitting long frames
  into sub-steps of at most `2 * FRAME_MS` with `Math.random()` jitter added (`:684-724`, `FRAME_MS` at `:12`). The
  server must call `update(dt)` from its own interval and never `loop()` (no rAF in node). The clock helper reads
  `performance.now()` when it exists (`:16-19`), which it does in node.
- The solo page also runs a WARM-UP before the player spawns: batches of `update((1000/60) * mult + Math.random())`
  until `config.prepareCounter` updates have run (`public/js/paper/paperMain.js:108-131`, early-start catch-up capped
  by `config.maxPreparingTime` at `:133-143`). A free arena that stops when empty, shooter-style, would owe that
  warm-up to the next person through the door, synchronously, on the shared thread.

---

## 5. Snapshot building and broadcast

### Snake: interest groups (`server/GameRoom.js:812-1052`)

1. Bail out if the Socket.IO room is empty (`:816-817`).
2. Serialize every live snake ONCE, with a bounding circle, plus a tiny minimap dot list `mm` that is never culled
   (`:859-877`). Arrays are reused across broadcasts to keep GC down (`:853-862`, measured cost quoted there).
3. For each socket in the room pick an EYE: own head if alive, else the camera the client reported via `view`
   (`:926-928`, handler at `server/index.js:2300-2307`). No eye means a full unculled send (`:930-934`).
4. Bucket by `CELL = 2000` world units; keep each socket in exactly one Socket.IO room
   `aoi_<roomId>_<ci>,<cj>` using `sock._cellRoom` (`:889-950`).
5. ONE encode per occupied cell, region = cell + widest reported view + 400 margin, snakes capped to the nearest
   `C.SNAKES_PER_SNAPSHOT` (28, `shared/constants.js:335`), food pulled from a coarse grid (`:955-1033`).
   `this.io.to(cell.roomName).volatile.emit(C.EVENTS.SNAPSHOT, enc.meta, enc.coords)` (`:1032`).
6. Dead and spectating sockets without a camera share ONE full encode (`:1046-1051`).

### Codec (`shared/snapshotCodec.js`)

UMD module: `module.exports` under node, `root.SnapshotCodec` in the browser (`:36-40`), so the same file encodes and
decodes. Wire shape is `emit('snapshot', meta, coordsBuffer)` (`:33`): coordinates as little-endian Int16 whole world
units (`:44`, `:62`), food as 12 fixed bytes with a per-snapshot colour palette (`:17-31`, `:73-92`), everything light
stays in the JSON `meta` (`:94-107`). `decodeSnapshot` handles both `ArrayBuffer` and node `Buffer` views
(`:115-119`). It is SNAKE-SHAPED (segments and food); Paper cannot reuse the functions, only the approach and the UMD
pattern. Int16 covers +/-32767, and Paper's world radius tops out at 950 (brief), so Int16 at 0.1-unit precision
(x10) would still fit.

### Agar

Same interest-group idea with `CELL = 1500` and JSON payloads (`server/AgarRoom.js:590-660`). Food travels as
`removedFoods` / `addedFoods` DELTAS inside the volatile `cell:state` emit; the delta lists are flushed before the
send (`:563-567`, `:654-659`).

### Shooter

Per-socket JSON, volatile, every tick (`server/ShooterRoom.js:1068-1077`). World changes (`cells`, `hits`) ride the
same volatile frame and are cleared right after the broadcast (`:1047-1048`, `:628-630`).

### The delta-in-volatile hazard (read this before designing Paper's territory sync)

Both the shooter's `cells` and agar's food deltas are sent ONCE inside a volatile emit. `volatile` means "drop it if
the client cannot take it now" (that is the whole point, CLAUDE.md netcode section), and nothing in either room
resends a dropped delta. For a broken crate that is a cosmetic desync. For Paper, territory IS the game state the
player reads to decide where it is safe, and it changes in discrete events (capture, cut, kill, shrink trim) rather
than every frame. Territory must not travel only as a one-shot delta in a volatile frame.

The codebase already shows the right split: reliable `emit` for things that must arrive (`GAME_JOINED`, `sh:map`,
`sh:cashedout`, `cashout:result`, `PLAYER_DIED`, kill feed) and `volatile.emit` for state that the next frame
supersedes (positions). The comment at `public/js/shooter.js:1107-1110` states the rule in one sentence.

---

## 6. Client netcode

### `public/js/game.js` (snake): buffered interpolation plus own-unit prediction

- Snapshot intake (`:391-428`): decode, then keep `clockOffset` as an EMA of `snap.t - performance.now()` (10% per
  sample, `:396-406`); measure lateness against `SNAP_PERIOD_MS` and grow `_jitterBuf` instantly on a spike (cap
  `MAX_JITTER_BUF` 180 ms), shrink at 3% per snapshot (`:408-416`, constants at `:81-84`); push into `snapBuffer`
  (max 30, `:418-419`); feed own snake to the predictor (`:420-425`).
- Render time = `now + clockOffset - (INTERP_DELAY_MS + _jitterBuf [+ SPECTATE_EXTRA_DELAY_MS])`, with
  `INTERP_DELAY_MS = 70` (about two snapshot periods, `:73`), ramped from 0 over the first 500 ms after spawn, and
  +100 ms for spectators (`:72`, `:470-498`). Find the bracketing pair and lerp (`:500-508`); older than the buffer
  shows the oldest (`:510-516`); newer dead-reckons forward at most 200 ms along each snake's own path (`:517-542`).
- `GAME_JOINED` RESETS all of it: buffer, offset, jitter, spawn time, predictor (`:361-389`). Every respawn goes
  through this.
- Prediction (`:86-99`, `:660-729`): the local head advances each frame with the server's own turn and speed rules;
  each snapshot pulls it back gently (10% position, 15% angle, scaled down above 60 ms ping, `:667-702`), translating
  the WHOLE body by the correction, never snapping.
- Input: `setInterval(sendInput, 1000 / 60)`, `socket.volatile.emit(INPUT, { angle, boost })`, absolute angle so a
  dropped packet is harmless (`:2219-2224`). Server validates `Number.isFinite(angle)` and nothing else
  (`server/index.js:2277-2280`).
- `view` is a reliable control message sent only on a real change or once a second (`:2226-2255`).
- Transport is left at the Socket.IO default on purpose (`:105-112`).
- Session `reconnectKey` generated per page load (`:114-120`).

### `public/js/shooter.js`: two-snapshot lerp, no prediction

Covered in section 2. It works because a tank's own motion at 30 Hz with about 33 ms of added latency is acceptable
for that game. Paper is a steering game where the player's own square reacting late to the mouse is felt directly, and
the brief says clients "predict only their own square", so Paper's client follows the SNAKE model for the own unit
and may follow either model for everyone else.

---

## 7. `/api/live` and idle reporting

- `GET /api/live` returns `{ lobbies: liveBoard(), stakes: ALL_STAKES, extras: liveExtras(), br }` and degrades to
  empty lists on error (`server/index.js:1491-1502`).
- `liveBoard()` lists EVERY rung of the snake ladder whether or not a room exists yet, `capacity: null`, sorted
  busiest first (`:1351-1382`). Row shape: `{ id: 'snake:na:s0.1', game, region, stake, players, bots, capacity, state }`.
- `liveExtras()` is for rooms off the ladder: `{ id: '<game>:free', game, region, players, bots }` (`:1390-1446`).
  The shooter reports `SHOOTER.BOT_FLOOR` bots while idle because an idle arena has deleted its bots
  (`:1395-1411`), i.e. it reports what you WILL find.
- Client: `public/js/v2/board.js` merges `extras` into its pinned rows by `id` (`:148-160`) and derives the buy-in
  buttons from `LOBBIES` rows whose `game` matches (`playableStakes`, `:141-146`). So Paper's three buy-ins light up
  in the lobby only if `/api/live` `lobbies` carries `game: 'paper'` rows with `stake` 0, 0.1 and 1; a row in `extras`
  only feeds a head count.
- Warning in that file: `enter()` sends `{ stake }` when a row has one, and for the SNAKE `PLAY` event the server
  resolves any stake through the snake ladder (`public/js/v2/board.js:96-108`, `server/index.js:1627-1633`). Paper's
  join event must resolve its own rooms and never call `getRoomForJoin`.
- `broadcastLobbyState` pushes combined head counts over the socket to lobby pages and is called on every join and
  leave (`server/index.js:2014-2026`); `totalInGame()` sums `gameRooms` only (`:2004-2007`).

---

## 8. Every list a new persistent room has to be added to by hand

| What | Where | Why it matters for Paper |
|---|---|---|
| Solvency liability | `sumLiveSelfCustodyStakes`, `server/index.js:1702-1728` | Brief: money alive in Paper arenas is escrow liability. Today it sums snake `worth` and agar `p.worth` only. Must also count money lying on the map as pickups, which no existing game has to do (snake cash food is not counted either; that is an existing gap, not a precedent to copy). |
| EU to NA stake push | `pushStatsToNA`, `server/index.js:345-351` | Sends `sumLiveSelfCustodyStakes()`, so fixing the row above fixes this. |
| Owner console rooms | `ALL_ROOMS`, `server/index.js:823-835`; labels `:840-871`; `opsSnapshot` `:875-896` | Needs `lobbyType`, `playerCount`, `botCount`, `addBot`, `clearBots`. `roomLabel` would call an unknown room "slither.io". |
| Maintenance drain | `ops.drainStatus`, `server/ops.js:57-66` | Skips any room without `.snakes`, so paid Paper players would read as "0 paid playing" while the owner waits for a drain. |
| Disconnect teardown | `server/index.js:2828-2873` | Add the Paper removal next to `endShooter`. |
| Lobby head counts | `liveBoard` / `liveExtras`, `server/index.js:1351-1446` | See section 7. |
| Paid page map | `PAGES`, `wallet-widget/src/main.jsx:217` | Missing `paper`; paid launch opens the snake. Needs `npm run build`. |
| Free page map | `OWN_PAGE`, `public/js/v2/play.js:274` | Already has `paper: '/paper'`. If multiplayer ships on a NEW page and `/paper` stays solo for parity, this entry must point at the new page. |
| Catalogue | `public/v2.html:2165-2167` | `solo:1` and the "against bots, nothing paid" note become false. |
| Pinned board row | `public/js/v2/board.js:127-130` | Comment says the server never reports Paper. |
| Stake game label | third arg of `consumePaidEntry*`, `server/index.js:395-412` | `db.recordStake(wallet, worth, game)`; pass `'paper'`. |
| Rake label | `trackEarning({ game })` + `sweepRake(amount, note)`, e.g. `server/index.js:2226-2233` | Same pair on every cash-out. |
| Collusion | `collusion.record(srcId, dstId, amount, ctx)`, `server/CollusionMonitor.js:42`; call sites `server/GameRoom.js:564`, `server/AgarRoom.js:512` | Brief: every kill transfer and every pickup. Ids are wallet addresses (`socket._googleId`). |

---

## 9. What this adds up to for the Paper room

Facts that size the problem, from the brief: at most 16 humans per arena, world radius 475..950, three arenas per
region (free, $0.10, $1.00), paid arenas have no bots, free arena is held at 16 squares by bots.

1. **Interest groups are unnecessary.** The snake's cell is 2000 units (`server/GameRoom.js:889`); a whole Paper arena
   (diameter 1900) fits inside one. Build ONE shared payload per snapshot and send it with
   `this.io.to(this.socketRoomName).volatile.emit(...)`. The CLAUDE.md rule "do not regress to per-socket encoding" is
   about hundred-player snake rooms; at 16 sockets the shooter's per-socket encode is also affordable
   (`server/ShooterRoom.js:1068-1071`), but a shared payload with the viewer finding itself by id (as the snake client
   does, `public/js/game.js:420`) is cheaper and simpler. Anything private to one player goes in a small reliable
   per-socket event.
2. **Two channels.** Volatile 30 Hz frame: per unit `id, x, y, direction, money, holding-progress, alive`, the current
   arena radius, the live part of each trail, server time `t`, and a territory VERSION number per unit. Reliable
   events: join payload with the full static state (all territories, all trails, names, skins, radius), territory
   changed (unit id, new version, new polygon), kill / death / pickup spawned / pickup taken, cash-out started /
   cancelled / result / paid / error. A client that sees a version in a frame it does not hold asks for a resync. This
   is the direct answer to the hazard in section 5.
3. **Rates.** Reuse `C.TICK_RATE` and `C.SNAPSHOT_RATE` with the `everyN` pattern (`server/GameRoom.js:687-691`), or
   keep Paper's own constants on the room like `SH`. The solo sim wants dt in ms; pass a fixed `1000 / 60` per tick for
   determinism in tests, reading time only through a `now()` method as the shooter does (`server/ShooterRoom.js:157-164`).
4. **Client.** Own square predicted by running the same `DuelPaperLib` movement locally and correcting gently toward
   the server (the snake's `_lCorrect` shape, `public/js/game.js:667-702`); everyone else interpolated from a time-
   stamped buffer with `clockOffset`, `INTERP_DELAY_MS`-style delay and the adaptive jitter buffer
   (`public/js/game.js:396-419`, `:470-508`). Reset all of it on every join payload (`:361-389`). Input is the absolute
   steering angle plus the Q flag, volatile, 30 to 60 Hz.
5. **Join door.** Copy the PLAY order in section 3 exactly: duplicate guard, maintenance, (reattach if Paper has one),
   `consumePaidEntryAtStake(entryToken, stake, 'paper')`, identity from the token, THEN `addPlayer`. Refuse a join when
   the arena already holds 16 humans BEFORE consuming the token, because a consumed token is a spent buy-in
   (`server/index.js:2114-2120` shows consume is the point of no return). No existing arena has a seat cap
   (`liveBoard` sets `capacity: null`, `server/index.js:1372-1375`), so there is no overflow pattern to copy: decide
   between refusing and opening a second arena at the same stake.
6. **Paying.** The room never moves money. It decides the hold finished and calls a function owned by index.js that
   reads the amount off the SERVER unit, zeroes it first, takes 10%, withdraws, records, and never retries
   (`server/index.js:2209-2264`). `doCashout` is closure-scoped to the snake socket and reads `socket._room.snakes`, so
   Paper needs its own sibling of it, not a call into it.
7. **Idle.** Paid arenas: no bots, so with no humans there is nothing to simulate; stop the interval (and let a
   registry sweep delete the room, `server/LobbyRegistry.js:84-95`) but ONLY when no money is lying on the map, since
   brief rule 5 says dropped money stays in the arena and the solvency sum must keep counting it. Free arena: either
   the 1-in-10 idle skip (`server/GameRoom.js:446-453`) or stop-and-reset (`server/ShooterRoom.js:427-434`); the
   second saves more CPU but owes the solo game's warm-up (section 4) to the next joiner and must report its bot floor
   to `/api/live` the way the shooter does (`server/index.js:1407-1409`).

---

## 10. Open decisions this reading surfaced (not decided here)

- **Reconnect grace.** The snake holds a disconnected paid snake for 8 s (`server/index.js:2857-2861`); the shooter
  removes at once (`:2835`). Brief rule 5 says a disconnect drops the money on the map. A short grace before that
  counts as a disconnect is mechanically available (`markOrphan` / `reattach`, `server/GameRoom.js:287-337`) but is an
  owner-rule question, because for 8 s the square would be a stationary, killable target carrying money.
- **Seat cap overflow** at 16 humans (point 5 above).
- **New page or same page.** The brief keeps the solo page reachable for parity. `OWN_PAGE.paper` and the route at
  `server/index.js:1123` both point at the solo page today.
- **Spectating.** The snake supports `spectate:join` without a token (`server/index.js:2322-2347`) and its idle rule
  counts spectators as audience. The brief does not ask for Paper spectating; if it is left out, nothing else needs it.
