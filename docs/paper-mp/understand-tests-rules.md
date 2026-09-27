# Paper multiplayer: tests and house rules (understand notes)

Written 2026-09-20 for the engineer building the server-run Paper room. Read-only research; nothing in the repo was
changed except this file. Every claim cites `path:line`. Paths are relative to `slither-clone/` unless absolute.
Binding brief: `docs/paper-multiplayer-brief.md`. Architecture and money invariants: `CLAUDE.md`.

## 0. Baseline, measured today

- `npm test` is `node --test --test-force-exit` (`package.json:11`). No file arguments, so node's default discovery
  applies: everything under `test/` plus any `*.test.js` / `test-*.js` anywhere outside `node_modules`.
- Run on this machine (node v24.13.1): **470 tests, 470 pass, 0 fail, about 26 s**. That is the number to beat: the
  Paper build must leave it green and add to it.
- 33 test files, all flat in `test/`, all named `<topic>.test.js`. There is NO helpers folder and no shared fixture
  module: each file declares its own `io` stub and `sock()` factory at the top. A helper file dropped into `test/`
  would be executed as a test file by discovery, so keep helpers inline or put them outside `test/` with a name that
  does not match `*.test.js` or `test-*.js`.
- node:test runs each FILE in its own process and files run in parallel (`test/cashoutHold.test.js:103-107`). So
  patching `Date.now`, `Math.random` or `globalThis.performance` at the top of one file is safe and is done
  (`test/battleRoyale.test.js:30-32`).
- The solo Paper node tests are NOT in this repo and are NOT run by `npm test`. They live in
  `C:\Users\owend\Documents\Coding Projects\Claude Code Test\paperio-reference\harness\tests\` (`test-paperGame.js`,
  `test-paperUnits.js`, `paperMain.test.js`, ...), are plain `assert` scripts, and `require` the shipped files by
  relative path (`paperio-reference/harness/tests/test-paperGame.js:63`). The brief's "solo node tests must keep
  passing" (`docs/paper-multiplayer-brief.md:26-27`) means running those by hand plus the golden diff
  (`paperio-reference/spec/BUILD-BRIEF.md:15-23`). `grep -i paper test/` finds only `test/v2route.test.js:1132-1137`.

## 1. Test conventions in this repo

### 1.1 Imports and style
- `const test = require('node:test')` or `const { test } = require('node:test')`, plus `require('node:assert')`.
  Both forms are in use (`test/tanks.test.js:2-3`, `test/entryStore.test.js:6-7`). No mocha, jest, sinon, chai.
- Test names are full sentences that state the rule, and the comment above explains the bug or the money-loss
  shape that the test exists for (`test/knockoutMoney.test.js:1-15`, `test/headOnCollision.test.js:1-30`). Match it.
- Every assertion carries a message string. Computed values go in the message
  (`test/shooter.test.js:238`, `test/botPopulation.test.js:38-39`).

### 1.2 The io and socket doubles
- Minimal io: `const io = { to: () => ({ emit: () => {} }) };` (`test/shooter.test.js:6`, `test/tanks.test.js:9`,
  `test/knockoutMoney.test.js:22`). GameRoom also wants `io.emit` (`test/headOnCollision.test.js:38`).
- Broadcast-capturing io, when the test is about what goes on the wire: `to: (room) => ({ volatile: { emit: (ev,
  payload) => emitted.push(...) } })` plus `sockets.adapter.rooms` (`test/agarRoom.test.js:59-65`).
- Socket double must have BOTH `emit` and `volatile.emit`. Snapshots go out volatile and may be dropped; a cash-out
  receipt goes out reliable and must not be. The shooter double records reliable emits per socket id and exposes
  `sentTo(t, event)` (`test/shooter.test.js:20-32`). Knockout's double records `{e, p}` on `sock.sent`
  (`test/knockoutMoney.test.js:23`). Copy the shooter one for Paper.

### 1.3 Three ways the clock is controlled (pick the first)
1. **A `now()` seam on the room, overridden in a test subclass.** `class Room extends ShooterRoom { now() { return
   this.t; } step(n) { this.t += 1000 / SH.TICK_RATE; this.tick(); } seconds(s) {...} }`
   (`test/shooter.test.js:8-17`). The comment there is the rule: a synchronous tick loop against the real clock
   advances no time, so nothing with a deadline ever fires and a green test proves nothing. Every deadline in the
   Paper room (cash-out hold, spawn shield, radius easing, bot top-up cadence) must read `this.now()`.
2. **One fake `Date.now` for the whole file** (`test/battleRoyale.test.js:22-32`), used when the code under test
   reads `Date.now` directly. Note the warning at `:34-39`: stateful timers must be stepped forward only.
3. **Pass the clock in** (`lob.enqueue(s, 'Owen', 'W1', 1, 1, T0)`, `lob.tick(T0 + PAID_WAIT_MS - 1)`,
   `test/knockoutMoney.test.js:125-139`). That comment records a real pre-deploy false failure caused by reading
   `Date.now()` twice. The two most recent commits before Paper are both clock-race fixes in tests (`git log`:
   93eb04b, 13cbe2a). Do not write a test that sleeps or reads the wall clock twice.
- The solo `Game` reads its clock through `nowMs()`, which looks up `performance.now` on every call
  (`public/js/paper/paperGame.js:16-19`), and advances by `update(tickDtMs)` (`paperGame.js:397-398`). So a headless
  test drives it with a fixed dt and, if needed, a virtual `globalThis.performance`, exactly as the reference tests
  do (`paperio-reference/harness/tests/test-paperGame.js:13-16`).
- `Game.update` adds `this.rng() * 0.01` to dt (`paperGame.js:406`) and spawns use global `Math.random`
  (`paperGame.js:138-155`). For deterministic room tests, seed `Math.random` at the top of the file (the reference
  tests use an LCG, `test-paperGame.js:9-11`) or place squares by hand with a `put()` helper like
  `test/shooter.test.js:44-46`.

### 1.4 Stop the room, strip the bots
- A room's `start()` runs a `setInterval`; tests call `r.stop()` right after construction or `addPlayer` and drive
  ticks by hand (`test/snakeBots.test.js:13-23`, `test/shooter.test.js:37-43`). `addPlayer` restarts the loop in the
  shooter, so tests call `r.stop()` again after every `addPlayer` (`test/shooter.test.js:287`, `:515`).
  `--test-force-exit` hides a leaked interval but do not rely on it.
- Bots are stripped by default in tests that are not about bots, because wandering bots make unrelated tests flaky
  in a full run (`test/shooter.test.js:33-43`). Snake tests stub `room.topUpBots = () => {}` and
  `room.broadcastSnapshot = () => {}` (`test/headOnCollision.test.js:40-46`).

### 1.5 Real-server boot tests (slow, few, worth it)
- `test/joinSmoke.test.js` and `test/cashoutHold.test.js` spawn `server/index.js` on a random port with
  `env: { REGION:'na', PORT, SESSION_SECRET:'test', MONEY_MODE:'usdc', DATABASE_URL:'', NTFY_DISABLED:'1' }`
  (`test/joinSmoke.test.js:41-50`, `test/cashoutHold.test.js:45-50`), wait on `/api/live`, connect with
  `socket.io-client` (`transports:['websocket'], forceNew:true, reconnection:false`), and always tear down in
  `t.after` (`joinSmoke:61-67`). `NTFY_DISABLED` matters: without it the suite buzzes Owen's phone (`:45-48`).
- They `t.skip` when `socket.io-client` is missing (`joinSmoke:37-39`). It is a devDependency (`package.json:39`)
  and the deploy installs with `--production`, so it never exists on the server.
- Why they exist: `node --check` and unit tests cannot see a `ReferenceError` on a line that only runs when a
  player joins; that took production down once (`test/joinSmoke.test.js:1-9`). They assert `srv.exitCode === null`
  and no `ReferenceError|TypeError` in stderr (`:88-91`).
- Timing assertions get generous slack and only assert "not EARLY" (`test/cashoutHold.test.js:103-116`).

### 1.6 Source-pinning tests (they WILL bite the Paper build)
`test/v2route.test.js` (1285 lines) reads `public/v2.html`, `public/js/v2/*.js`, `server/index.js` and the built
widget as TEXT and regex-asserts on them. Ones the Paper work touches:
- **`test/v2route.test.js:1132-1137` currently asserts the Paper lobby card is `built:1`, `solo:1`, NOT `paid:1`,
  NOT `duel:1`.** The card is `public/v2.html:2165`. The brief requires the card to offer Free, $0.10, $1.00
  (`docs/paper-multiplayer-brief.md:48-49`), so this test must be rewritten on purpose in the same commit. Do not
  delete it: replace it with what is now true (built, paid, not a duel, not soon).
- `:158-171`: `db.recordStake(` must appear EXACTLY ONCE in `server/index.js`, inside `recordEntry`
  (`server/index.js:401-412`). Paper's paid join must go through `consumePaidEntryAtStake(token, stake, 'paper')`
  (`server/index.js:395-397`) and must not add its own `db.recordStake`.
- `:235-241` and `:243-249`: the literal strings `consumePaidEntryAtStake(entryToken, socket._stake` and
  `consumePaidEntryAtStake(entryToken, Number(stake)` must stay in `server/index.js`.
- `:197-203`: the string `capacity: null` must remain in `server/index.js`.
- `:215-220`: `public/js/v2/play.js` must never contain `submit-stake`, `stake-quote` or `signTransaction`; the
  lobby only fires `duel:play` and the wallet widget owns the money (`public/js/v2/play.js:297-307`).
- `:222-233`: exact launch-detail strings in `play.js`.
- `:272-289`: `public/wallet/widget.js` is the BUILT bundle and is checked against `wallet-widget/src/main.jsx`.
  If the widget source changes, run `npm run build` and commit the bundle (the deploy does not build, see 5).
- `:1171-1189`: shows how a paid own-page game is pinned (`built:1`, `paid:1`, page route in `play.js`).
- `test/inlineScripts.test.js:22-61` parses EVERY inline `<script>` in EVERY `public/*.html` with `new Function`.
  A new or edited Paper page must keep inline scripts parseable; an inline `type="module"` block that uses `import`
  would fail there (`:36-38` lets module blocks through to `new Function`).

### 1.7 Client logic tests
Client functions are lifted out of the shipped file by name and run in a `vm` sandbox with a stub DOM rather than
copied (`test/brVictory.test.js:26-41`, `:62-90`). The Paper modules are easier: they are UMD-style and attach to
`globalThis.DuelPaperLib` with no `module.exports` (`public/js/paper/paperGame.js:3`,
`paperio-reference/spec/BUILD-BRIEF.md:88-99`). Under node: `require('../public/js/paper/paperGeom.js')` for the side
effect, then read `globalThis.DuelPaperLib`. Load order matters only for `class X extends P.Y` (`BUILD-BRIEF.md:97-98`).

## 2. How money paths are tested here (there is no Wallet/db stub)

- Nothing in `test/` stubs `Wallet`, `money` or `db` for a payout. `grep -n "withdraw|recordEarnings|markStakeSig"
  test/` finds nothing relevant. The only db double is a fake `pool.query` for the leaderboard
  (`test/leaderboardFlush.test.js:26-34`, fresh module via `delete require.cache[...]`).
- The house pattern is a split: **the room or lobby decides who is owed what and calls a hook; `server/index.js`
  moves the money.** Stated at `test/knockoutMoney.test.js:14-15` and `server/index.js:1145-1158`. Tests capture
  the hook: `lob.onSettled = (m) => settled.push(m)`, `lob.onRefund = ...` (`test/knockoutMoney.test.js:25-31`),
  then assert "settled once, not twice" (`:78-92`), "exactly one refund" across three exits (`:157-166`,
  `:209-222`), "a free table never settles anything" (`:112-120`), "the pot is a sum of recorded stakes, nothing a
  client sends can reach it" (`:184-195`).
- The index.js side of a payout, which Paper must reuse rather than copy: once-per-key guard
  (`_koPaid`, `server/index.js:1159-1165`), 10% cut via `trackEarning` + `sweepRake` (`:1180-1186`), and ONE sender
  `koSend` that calls `money.withdraw`, records earnings only after the payout lands, and on failure writes
  `db.recordFailedPayout` with NO retry because "a re-send is how you pay twice" (`:1237-1253`). The snake version
  of the same thing is `doCashout` (`server/index.js:2209-2264`): worth is read off the server entity, zeroed
  FIRST (`:2214-2215`), then split 90/10 (`:2221-2223`), then `money.withdraw` (`:2242`).
- The snake cash-out hold is owned end to end by the server: `cashout:start` arms a `setTimeout(C.CASHOUT_HOLD_MS)`
  (`server/index.js:2175-2178`), `cashout:cancel` and `disconnect` clear it (`:2183-2192`), the legacy `cashout`
  event grants nothing unless the hold ran (`:2197-2207`). `C.CASHOUT_HOLD_MS` is already 3000
  (`shared/constants.js:22`), which is Owen's 3 seconds. It is tested only through a real server boot
  (`test/cashoutHold.test.js:81-116`) plus a source pin that the client sends no speed (`:121-138`).
  For Paper, put the hold INSIDE the room on the room clock (the shooter does: `setInput(id, {bank:1})`,
  `test/shooter.test.js:650-687`) so it is unit-testable with a fake clock, and keep one boot test for the wire.
- Entry tokens: `server/entryStore.js` is pure and fully covered (`test/entryStore.test.js`): one-time (`:20-26`,
  `:108-113`), wrong rung refused (`:99-106`), expired (`:115-119`), forged or absent (`:121-125`), stake 0 is free
  with no token (`:127-130`), junk stake refused (`:132-136`), off-ladder cannot be minted (`:138-148`), the two
  doors do not launder into each other (`:150-166`). The ladder is exactly `[0, 0.10, 1]`
  (`test/stakeRules.test.js:7-17`), which is the three Paper lobbies. Tokens are NOT bound to a game
  (`server/entryStore.js:33-39` stores no game field); `game` is only a stats label (`server/index.js:401-410`).
- Float money: existing tests compare with `Math.abs(a - b) < 1e-9` (`test/agarRoom.test.js:40-41`) and the ladder
  has a float-noise test (`test/stakeRules.test.js:52-58`). `0.1 + 0.2` is not `0.3`; never `assert.equal` a summed
  worth.

## 3. THE ONE RULE (bots) and the population helpers

- `server/GameRoom.js:76-107`. "Bots may exist only where nothing is staked." `isFree()` asks what the room COSTS:
  if `this.stake` is set, free means `Number(this.stake) === 0`; only a room with no stake falls back to a shared
  LIST `C.FREE_LOBBY_TYPES` (`shared/constants.js:262`, `['free','br']`). `botsAllowed()` returns `isFree()`
  (`GameRoom.js:107`). The comment lists three of the seven times a string test on the room NAME got this wrong
  (`:82-96`). Never write `endsWith('free')` or `lobbyType !== 'free'`.
- `topUpBots()` first branch, unconditional: a paid room deletes every bot it has, alive or not
  (`GameRoom.js:137-143`). `addBot()` returns null in a paid room (`GameRoom.js:377`).
- `seedsBots()` (`GameRoom.js:109-125`) is the separate "should the automatic population fill this room" question.
- Same rule, same words, in the other arenas: `server/ShooterRoom.js:469-481` (`botsAllowed() { return
  !Number(this.stake || 0); }`), `:486-491`, `:451-452`; `server/AgarRoom.js:64-80`, `:234`.
- The owner console reads `botsAllowed()` off every room (`server/index.js:884-888`) and talks to rooms through
  `playerCount`, `botCount`, `addBot`, `clearBots` (`server/ShooterRoom.js:441-467`, `server/index.js:823-835`).
  A Paper room added to `ALL_ROOMS` must expose those four; note `roomLabel` and the `game:` ternary
  (`server/index.js:840-871`, `:879-881`) would label an unknown room "slither.io".
- `server/botPopulation.js` is the SNAKE's shared budget: `botTarget(at)` walks a daily curve between `C.BOT_MIN`
  22 and `C.BOT_MAX` 101 (`botPopulation.js:97-112`, `shared/constants.js:293`, `:317`), rooms `registerRoom`
  themselves and split it with `roomShare` / `globalHeadroom` (`:127-179`). Only `GameRoom` registers
  (`server/GameRoom.js:11`, `:226`, `:231`). The shooter and agar use a plain floor instead
  (`SH.BOT_FLOOR` 5 at `ShooterRoom.js:81`, `:503`; `C.BOT_FLOOR_FREE` at `AgarRoom.js:86`). **Paper should use
  the plain-floor model (fill to 16 minus live humans) and must NOT register with botPopulation**, or it will eat
  the snake rooms' share.
- Bot removal etiquette that tests enforce: only already-dead bots are culled when humans arrive; a live bot over
  the floor is left to die (`test/shooter.test.js:505-530`, `test/snakeBots.test.js:133`); hand-placed (`manual`)
  bots are exempt (`ShooterRoom.js:447-458`, `:497-504`); every bot is labelled as one in snapshots and boards
  (`test/shooter.test.js:547-561`); a bot can never bank (`test/shooter.test.js:532-545`).
- The lobby board reports bots separately from players and never adds them
  (`test/v2route.test.js:205-213`, `server/index.js:1390-1412`). An idle arena reports the floor it WILL fill to
  (`server/index.js:1396-1411`).

## 4. scripts/loadtest.js

- Snake-only: emits `play`, `view`, `input` and decodes `snapshot` with `shared/snapshotCodec`
  (`scripts/loadtest.js:34-44`, `:53`). It cannot drive a Paper room as written. Env: `LT_URL`, `LT_LEVELS`,
  `LT_HZ`, `LT_SAMPLE`, `LT_REGION`, `LT_LOBBY` (`:19-24`).
- Stale docs: `CLAUDE.md:73` and `scripts/loadtest.js:7-11` say `/api/debug/tick` was removed. It exists again
  (`server/index.js:1819`) but returns an OBJECT with a `rooms` map (`:1821-1837`), while loadtest calls
  `stats.find(...)` on it (`scripts/loadtest.js:85-86`). Read from code, not run: expect loadtest to throw there.
  Out of scope for Paper; flagged so nobody trusts its tick columns.
- A Paper arena caps at 16 real players (`docs/paper-multiplayer-brief.md:22`), so a loadtest matters less than a
  per-tick cost test in the style of `test/botAiCost.test.js` (16 squares, full territory, assert tick time budget).
- Other scripts are smoke/sim tools run by hand (`package.json:12-15`), not part of `npm test`.

## 5. Deploy pipeline facts that matter

- `.github/workflows/deploy.yml:3-6`: every push to `main` deploys. The job is SSH to the NA box, then
  `git fetch`, `git reset --hard origin/main`, `npm install --production`, `pm2 restart duelseries` (`:30-35`).
  EU deploy is commented out (`:37-58`). A phone push reports the result (`:60-79`).
- **There is NO test step, NO lint step and NO build step in CI.** Nothing stops a red suite from shipping; the
  only gate is running `npm test` locally and the `duelseries-deploy-check` skill
  (`C:\Users\owend\.claude\skills\duelseries-deploy-check\SKILL.md:14-30`: `node --check` every changed JS file,
  re-read the money flow, verify it works, then commit and push).
- No build on deploy means built artefacts must be committed: `public/wallet/widget.js` is tracked and pinned by
  `test/v2route.test.js:272-289`. `.gitignore` ignores only `node_modules/`, `.env`, `*.log`, `server/data/`.
- `--production` means devDependencies (socket.io-client, vite, nodemon) are absent on the server. Server code
  must never `require` one.
- What the server serves: explicit page routes declared BEFORE static (`server/index.js:1102-1123`, `/paper` at
  `:1123`), then `express.static('public')` (`:1125`) and `/shared` to `shared/` (`:1126`). Every response gets
  `Cache-Control: no-store` (`:1100`). So `public/js/paper/*.js` is both browser-served and `require`-able by the
  server from the same checkout; a new server file that loads them should use `path.join(__dirname, '../public/js/paper/...')`.
- `pm2 restart` drops every socket and every in-memory room. Live worth in a paid Paper arena at deploy time is
  lost from memory while the USDC stays in escrow. The snake has the same exposure; the owner console has a drain
  mode (`ops.drainStatus`, `server/index.js:896`). Low stakes today (no players, `CLAUDE.md:34-35`), but say so.
- No linter, no prettier, no husky, no git hooks (checked: no `.eslintrc*`, `eslint.config.*`, `.prettierrc*`,
  `.husky`, and `.git/hooks` has only samples). The style constraint is convention: `'use strict'`, CommonJS on the
  server, long explanatory block comments that say WHY.
- House rule from `CLAUDE.md:28-32`, `:76-78`: verify, then commit and push after every change. This workflow run
  is read-only and must not commit.

## 6. What the Paper room must look like to be testable here

Derived from the patterns above; these are requirements on the build, not style advice.

1. `server/PaperRoom.js` exports the class and its constants object (`module.exports = { PaperRoom, PAPER }`), like
   `{ ShooterRoom, SH, ... }` (`test/shooter.test.js:4`) and `{ TanksRoom, TANKS }` (`test/tanks.test.js:4`).
2. Constructor takes `(io, id, opts)` with `opts.stake` set ON THE ROOM so `botsAllowed()` can ask the cost
   (`server/ShooterRoom.js:481`).
3. `now()` seam for every deadline; `tick()` callable by hand; `start()` / `stop()` with `timer = null` when stopped
   (`test/shooter.test.js:480-487`).
4. Public methods that tests call directly, no socket events needed: `addPlayer(socket, name, wallet, worth)`,
   `setInput(id, input)`, `removePlayer(id)`, `respawn(id, worth)`, `snapshot(forId)`, `topUpBots()`, `addBot()`,
   `clearBots()`, getters `playerCount`, `botCount`.
5. Money leaves the room through ONE hook, for example `room.onCashout = ({ id, wallet, name, worth }) => {}`,
   called exactly once per completed hold with worth already zeroed on the square. `server/index.js` wires it to
   the existing 90/10 + `money.withdraw` + `recordEarnings` / `recordFailedPayout` path. Value transfers between
   accounts leave through a second hook or a direct `collusion.record(srcWallet, dstWallet, amount, { lobbyType })`
   call (`server/CollusionMonitor.js:42-52`; `_state` is exported for tests at `:107-111`).
6. `room.liveStakeTotal()` returning live worth PLUS uncollected pickups, and `sumLiveSelfCustodyStakes`
   (`server/index.js:1702-1728`) must add it. Today that function only walks `snakes` and agar `players`; a Paper
   arena would be invisible to the solvency monitor (`:1735-1750`) unless added. The comment at `:1711-1714`
   records this exact omission happening once already with the ladder rooms.
7. Kill and death flow goes through the solo `Game.kill(victim, killer, reason)` seam (`public/js/paper/paperGame.js:341-372`);
   `killer` is null for a self-kill. The money rule hangs off that one place, added as a no-op hook for solo
   (`docs/paper-multiplayer-brief.md:31-35`).

## 7. The tests a Paper room needs to be credible here

Suggested files: `test/paperRoom.test.js` (rules), `test/paperMoney.test.js` (money), `test/paperArena.test.js`
(radius, trim), `test/paperWire.test.js` (one real-server boot). All with a fake-clock subclass and seeded or
hand-placed squares. Numbers come from `docs/paper-multiplayer-brief.md`.

### Join and steer
1. A player joins and gets a square inside the arena, alive, with a snapshot that names them (`snap.you`) and
   carries no socket and no wallet string (`test/shooter.test.js:607-616`, `test/tanks.test.js:255-260`).
2. A 17th real player is refused; the room holds at most 16 (brief rule 7, `:22`). Bots make way first in free.
3. Steering: `setInput(id, { angle })` turns the square over ticks; a non-finite or absurd angle is ignored or
   clamped, never obeyed (`server/index.js:2277-2280`, `test/tanks.test.js:231-241`).
4. Input for an unknown id, a dead square, or a cashed-out square changes nothing and does not throw
   (`test/shooter.test.js:704-710`).
5. Solo parity guard: constructing the arena game class does not change a solo `Game` run (same seed, N ticks,
   identical unit state with and without the new seam loaded). This is the in-repo tripwire for brief `:26-27`.

### Kill transfers worth
6. A kills B (B fresh at 0.10, A at 0.10): A shows 0.20, B shows 0, B is dead, NO pickup is dropped, payout hook
   not called (brief rule 2, `:12-13`).
7. Chain: C then kills A and receives 0.20 on top of its own (brief `:12-13`). Assert with 1e-9 tolerance.
8. `collusion.record` is told once per kill with (victim wallet, killer wallet, amount)
   (`server/AgarRoom.js:511-512` is the model). Bot or wallet-less parties record nothing (`CollusionMonitor.js:43`).
9. Order independence: a mutual or same-tick kill is decided from start-of-tick state and the result does not
   depend on Map insertion order (the join-order bug, `test/headOnCollision.test.js:1-30`, `:60-75`). Whatever the
   solo rules decide, money is conserved and assigned exactly once.
10. Killing a bot in the free room pays 0 and calls no hook.

### No-killer death drops a pickup
11. Self-kill (own trail) with worth 0.30: a pickup of exactly 0.30 appears at the death position; the square's
    worth is 0 (brief rule 5, `:18-19`; model `test/shooter.test.js:203-221`).
12. A zero-worth death (any free-room death) drops NO pickup, so bots can never be seen "collecting money".
13. The pickup remembers its source wallet for collusion tracking (`server/GameRoom.js:280`, `:716`).

### Pickup collect
14. First square to touch it gets the full value; the pickup is removed; a second toucher in the same tick gets
    nothing (no double credit).
15. `collusion.record(sourceWallet, collectorWallet, value)` fires once (`server/GameRoom.js:562-564`). The
    original owner re-collecting their own drop after a re-buy records nothing (`src === dst`).
16. A square mid cash-out hold cannot collect (it is locked and stationary) or, if it can, the collected value is
    included in the payout exactly once: pick one and pin it.

### Cash-out hold, movement lock, cancel
17. Holding for `C.CASHOUT_HOLD_MS` (3000, `shared/constants.js:22`) on the ROOM clock fires the hook once with the
    full worth; at 2.9 s it has not fired (`test/shooter.test.js:650-664`).
18. Movement lock: during the hold the square's position does not change at all over N ticks, and input angles
    sent during the hold are not applied (brief rule 3, `:14-15`). This differs from the snake's slow crawl.
19. Releasing Q cancels: progress resets to 0, the square moves again next tick, and two holds of 2 s never add up
    (`test/shooter.test.js:666-678`).
20. A client that sends "cashout done" without holding gets nothing; the server owns the clock end to end
    (`test/cashoutHold.test.js:81-97`, `server/index.js:2165-2178`).
21. Killed during the hold: no payout; worth goes to the killer (or to a pickup if no killer)
    (`test/shooter.test.js:343`).
22. Completion removes the square AND its land with no kill credit to anyone (brief `:47`); others' snapshots no
    longer contain it (`test/shooter.test.js:284-295`); nothing is left on the floor (`:272-273`).
23. A reliable (non-volatile) receipt is emitted to that socket exactly once (`test/shooter.test.js:268-270`).
24. Holding with worth 0 in the free room: decide and pin. The snake still emits a zero result
    (`server/index.js:2261-2263`); the hook must not be called with `worth > 0` false.

### Payout 90/10 called once
25. Hook fires exactly once even if the completion path runs twice (double event, reconnect, retry):
    `test/knockoutMoney.test.js:78-92` is the model. Worth is zeroed before the hook runs
    (`server/index.js:2214-2215`).
26. The index.js wiring pays `worth * 0.9` via `money.withdraw`, keeps 10% (`trackEarning` + `sweepRake`), records
    earnings only on success and `recordFailedPayout` on failure with no retry (`server/index.js:1237-1253`,
    `:2221-2256`). Best done by extracting one `payCashout({ money, db, trackEarning, sweepRake }, seat)` function
    that takes its dependencies as arguments, so a test can pass doubles and assert one `withdraw(wallet, 0.9 *
    worth)` call. This would be the first injected-dependency money test in the repo; without it, pin by source
    text as `test/cashoutHold.test.js:121-138` does.
27. The payout wallet is the one recorded in the entry token (`entry.walletAddress`, `server/index.js:2620`), never
    a wallet field sent at join.
28. A free room never calls the payout hook (`test/knockoutMoney.test.js:112-120`).

### Disconnect
29. `removePlayer` on a live paid square: treated as a no-killer death. Pickup of exactly its worth at its last
    position, no payout, no kill credit (brief rule 5; model `test/shooter.test.js:223-231`). Note this is
    deliberately NOT the snake's reconnect-grace orphan path (`server/index.js:2857-2861`).
30. Disconnect during a hold cancels the hold and pays nothing (`server/index.js:2191-2192`).
31. Last human leaving: a free arena stops ticking and clears bots (`test/shooter.test.js:480-487`). A PAID arena
    with pickups still on the floor is an open product question (see Pitfalls); whatever is decided, pin it and keep
    the liability counted until it is resolved.

### Arena radius by head count
32. Pure function test of `targetRadius(n)`: n = 1..4 gives 475, n = 16 gives 950, n = 9 gives 712.5, n = 8 gives
    about 671.75, n > 16 clamps to 950, n = 0 gives base (brief `:43-45`).
33. n counts SQUARES ALIVE (humans plus bots), so the free arena at 16 is always 950 (brief `:45`).
34. Easing on the room clock: after a join the radius reaches target within the quick-growth window; after a death
    the radius is still above target after that same window (shrink is slower than growth) and never overshoots
    (brief `:44-45`, rule 6).
35. Join and death each move the TARGET immediately; cash-out and disconnect count as leaving (brief rule 4).

### Trim on shrink
36. After a shrink completes, no territory polygon vertex lies outside the new radius (within geometry epsilon),
    and total owned area did not increase for anyone.
37. A square outside the new edge is pushed inward, stays alive, and keeps its worth: nobody dies from the shrink
    (brief rule 6, `:20-21`).
38. A pickup outside the new edge is moved inside it, so money never leaves the arena except by cash-out
    (brief `:19`).
39. A trail crossing the new edge does not produce a kill or a self-kill as a side effect of trimming.

### No bots in paid rooms
40. `new PaperRoom(io, 'x', { stake: 0.10 })`: `botsAllowed() === false`, `addBot() === null`, `topUpBots()` adds
    none, and a bot smuggled straight into the unit list is swept on the next pass
    (`test/snakeBots.test.js:59-72`, `test/shooter.test.js:494-503`).
41. The free room fills to 16 minus live humans, culls only dead bots as humans arrive, leaves live ones
    (`test/shooter.test.js:505-530`); bots are labelled in snapshot and board (`:547-561`); a bot can never trigger
    the payout hook however much worth it is given (`:532-545`).
42. The room name is never consulted: a paid room called `'paper_free'` still refuses bots and a free room called
    `'paper_dollar'` with `stake: 0` still takes them (`server/GameRoom.js:82-101`).

### Entry token consumed once
43. Source pin in the v2route style: the Paper join and respawn handlers call
    `consumePaidEntryAtStake(entryToken, <stake>, 'paper')`, and `db.recordStake(` still appears once
    (`test/v2route.test.js:158-171`).
44. Respawn in a paid arena is a new buy-in checked against the socket's own recorded rung, not a client field
    (brief `:46`; `test/v2route.test.js:235-241`, `server/index.js:2369`).
45. Real-server boot test (`test/paperWire.test.js`, modelled on `test/cashoutHold.test.js`): join with `stake: 1`
    and no token is refused; with a forged token is refused; free join succeeds; server still alive and stderr has
    no `ReferenceError|TypeError` (`test/joinSmoke.test.js:88-91`). Replaying a spent token is already covered by
    `test/entryStore.test.js:20-26`, `:108-113`.
46. The ROOM is chosen from the same stake number the token was checked against. `consumeAtStake(undefined, 0)`
    returns `{ ok: true, worth: 0 }` (`server/entryStore.js:49`), so a handler that checks `stake: 0` but routes by
    a separate `lobbyType: 'dollar'` field would seat a zero-worth player in a paid arena, where a kill hands them
    real money. Knockout avoids this by using one number for both (`server/index.js:2610-2624`). Pin it.

### Client cannot inflate worth
47. `room.setInput(id, { angle: 1, worth: 999, money: 999, cashout: 'done', speed: 9 })` leaves worth, speed and
    hold state untouched (`test/cashoutHold.test.js:121-138`, `server/index.js:2275-2280`).
48. `addPlayer` worth comes only from the consumed token (`entry.worth`), and the advertised room stake is not the
    money: setting `room.stake = 999` changes no one's worth (`test/knockoutMoney.test.js:184-195`).
49. **Conservation property test** (the one that catches everything else): run a seeded scripted match of several
    hundred ticks with joins, kills, self-kills, pickups, disconnects and cash-outs, and after EVERY tick assert
    `sum(live worth) + sum(pickups) + sum(gross paid out) === sum(entries)` within 1e-9. Nothing else in this list
    proves money is neither minted nor lost.
50. `room.liveStakeTotal()` equals live worth plus pickups, and a source pin that `sumLiveSelfCustodyStakes`
    includes the Paper rooms (`server/index.js:1702-1728`).

### Lobby and page
51. Rewrite `test/v2route.test.js:1132-1137` for the new card; add the Paper page route pin if the page name
    changes (`:1184-1188`). `test/inlineScripts.test.js` covers the page automatically.
52. `/api/live` reports Paper players and bots as separate fields, never summed (`test/v2route.test.js:205-213`).

## 8. Pitfalls (short list)

- `test/v2route.test.js:1132-1137` fails the moment the Paper card becomes paid. Rewrite it in the same commit.
- A second `db.recordStake(` in `server/index.js` fails `test/v2route.test.js:165`.
- CI runs no tests. A red suite deploys. Run `npm test` before every push.
- Real clock in a room test is a false green (`test/shooter.test.js:8-11`) or a flaky red
  (`test/knockoutMoney.test.js:125-132`).
- Forgetting `r.stop()` after `addPlayer` leaves a live interval mutating state under the test.
- Registering Paper with `botPopulation` steals the snake rooms' bot share (`server/botPopulation.js:158-179`).
- Pickups are escrow liability. If solvency counts only live squares, it under-reports
  (`server/index.js:1711-1714` is the precedent).
- "An empty arena forgets the mess" (`test/shooter.test.js:480-487`) is right for free and WRONG for a paid Paper
  arena: sweeping paid pickups silently turns players' money into unrecorded house money. Needs an explicit
  decision from Owen and a recorded `trackEarning` if the house keeps it.
- Route by the checked stake, never by a second client field (test 46).
- Paper modules export through `globalThis.DuelPaperLib`, not `module.exports`; on the server that global is
  process-wide and shared by every arena, so nothing per-room may live on `P`. `P.Vec2.space` is reassigned per
  `update` (`public/js/paper/paperGame.js:404`), which is the existing answer to that for the spatial grid.
- `Game.kill` spawns death particles (`paperGame.js:353-356`) and `Game` starts a particle `setInterval`
  (`paperGame.js:95`): headless use needs those to be inert and `stop()` to clear them, or tests leak timers.
- Any new `public/*.html` inline script must parse under `new Function` (`test/inlineScripts.test.js:41-43`).
- Do not put helper modules in `test/`; discovery runs them as tests.
