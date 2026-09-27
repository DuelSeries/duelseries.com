# Lobby tiers: how a game shows Free / $0.10 / $1.00 and launches (notes for the Paper multiplayer build)

Written 2026-09-20 against HEAD bffe6d5 (working tree clean apart from the brief). Read-only research. Every claim
cites file:line. Baseline before any change: `node --test test/v2route.test.js` = 67 pass, 0 fail.

Sibling notes: `docs/paper-mp/understand-paid-entry.md` covers the money trace (quote, submit, token, consume,
cash-out). This file covers the LOBBY side only and cross-references it instead of repeating it.

## 0. The answer in ten lines

Paper is `{built:1, solo:1}` with an own page at `/paper`. Today that means: no buy-in control, no lobby list, Play
always launches `{lobbyType:'free'}`, and `launch()` takes the `OWN_PAGE` shortcut straight to the solo page. To show
Free, $0.10 and $1.00 and launch correctly, SIX things change, in four files plus the bundle:

1. `public/v2.html:2165-2167` catalogue row: drop `solo:1` and `soloNote`, add `ladder:1` (and a way to hide the snake
   skin row, section 6).
2. `server/index.js` `/api/live`: list three Paper rows (`game:'paper'`, stake 0 / 0.1 / 1) in `lobbies`. Without
   rows the buy-in buttons are all struck through and `playChosen()` refuses every paid rung (section 3).
3. `public/js/v2/board.js:127-130`: remove the pinned `paper:free` row (it launches by `lobbyType`, not by stake) and
   pin Paper's free rung from the real list instead (section 4).
4. `public/js/v2/play.js:274`: take `paper` OUT of `OWN_PAGE` (recommended), so all three tiers go through the wallet
   widget exactly as the snake game does (section 5).
5. `wallet-widget/src/main.jsx:217`: add `paper` to `PAGES`, then `npm run build` and commit `public/wallet/widget.js`.
   Without this a PAID Paper launch opens the SNAKE game holding the player's token (section 5, pitfall P1).
6. `server/index.js:1123` area: a route for the multiplayer page. One path segment only (section 7).

Then `test/v2route.test.js:1132-1137` must be rewritten (section 9).

## 1. The catalogue flags (`public/v2.html:2132-2192`)

`GAMES` is the single list. Complete inventory of who READS each flag (grep of `g.`/`cur.` over v2.html):

| flag | meaning | readers |
|---|---|---|
| `soon` | nothing behind it | card class `v2.html:3005`; ticker filters `3117`, `3119`; detail `soon` class (only if not a duel) `3171`; `V2_IS_SOON` `3423` |
| `built` | overrides `soon`, and marks an own-page duel/solo | Play button text `3212`; `startFromDetail` `3309`; `V2_IS_SOON` `3423` |
| `solo` | one player, own page, no ladder, no list | detail class `3179` (CSS `900-903` hides `.sl .stakes .stakeoff .duelbet .lobwrap .lookrow .queued`, shows `.dbnote`); note text `3183-3185`; `startFromDetail` `3309` |
| `duel` | matched INTO, not a room | detail class `3170`; `3171`; `drawDuelBet` `3198`; button text `3212`; `startFromDetail` `3309-3310` |
| `paid` | a DUEL whose every rung is live | `refreshSteps` `2210-2214`; class `paidduel` `3178` (CSS only acts with `.duel`: `883-889`); note text `3189-3195` |
| `freeOnly` | a duel that seats only Free | `refreshSteps` `2215-2219`; class `3175`; note `3186-3188`; `drawDuelBet` `3355` |
| `ladder` | rooms are RUNGS priced by stake, Free is the stake-0 rung | `V2_HAS_LADDER` `3427`, asked by `playChosen` `play.js:352-356` |
| `real`, `type` | no reader found | documentation only |
| `soloNote` | per-game text for the solo note | `3184`. Paper is its only user (`2166`) |

Current rows: snake `real:1, ladder:1` (`2136`); agar no flags (`2141`); omgshooter `built:1, solo:1` (`2145`); tanks
`duel:1, built:1, freeOnly:1` (`2150`); knockout and battleship `duel:1, built:1, paid:1` (`2155`, `2159`); paper
`built:1, solo:1` + `soloNote` (`2165-2167`).

Key point: `paid` is a DUEL concept. It is not what makes an ARENA game sell seats. An arena game (snake) sells seats
because the server lists its rungs on `/api/live` and `refreshSteps` falls into the last branch (section 2). Do not put
`paid:1` on Paper: it would set a duel note and a `paidduel` class that do nothing without `.duel`, and it still would
not make `playChosen()` find a room.

## 2. How the detail panel builds the buy-in control

Markup order is pinned by a test (`test/v2route.test.js:409-431`): `#stakes` then `#play-name` then
`startFromDetail()` then `#dlob`. Markup: `.sl` + `#stakes` + `#stakeoff` `v2.html:1776-1778`; duel stepper `#duelbet`
`1783-1811`; name row `1821-1846`; Play `1847`; `#dbnote` `1853`; `#play-msg` `1857`; snake skin row `.lookrow`
`1862-1866`; `.queued` `1870-1877`; `.lobwrap` / `#dlob` `1879-1882`.

`open_(id)` (`v2.html:3145-3254`) does, in order: `refreshSteps(id); si=defaultStep()` (`3152`), toggles the classes
`duel / soon / freeonly / paidduel / solo` (`3170-3179`), sets the note, picks the backdrop (live canvas only for snake
and agar, everything else shows `/img/games/<id>-wide.png`, `3202-3207`; `paper-wide.png` exists), builds the lobby
list (`3217-3252`), then `drawStake(); drawSkins()` (`3253`).

The ladder itself:
- `const LADDER=[0,0.10,1]` (`v2.html:2202`), identical to the server's `ALL_STAKES` (`server/stakeRules.js:36-38`).
  The server also ships `stakes` on `/api/live` (`server/index.js:1496`) but the client never reads it.
- `refreshSteps(gameId)` (`2204-2231`): `STEPS=LADDER.slice()`, then `STEPS_OFF` is: empty if `g.paid`; every paid
  rung if `g.freeOnly`; otherwise `STEPS` minus `V2Board.playableStakes(gameId)` (`2221-2222`).
- `V2Board.playableStakes(game)` (`board.js:141-146`) = the set of `stake` over `/api/live` `lobbies` rows whose
  `game` matches, plus a hardcoded `0` for agar. For a game with NO rows this is an EMPTY set, so EVERY rung including
  Free is drawn struck through and disabled (`drawStake`, `3395-3412`; `pickStake` refuses, `3413-3417`).
- `defaultStep()` (`2237-2249`): last stake played (`localStorage duelseries_last_stake`, shared across ALL games) if
  that rung is open, else the cheapest open PAID rung, else any open rung. So a first-time visitor to Paper with all
  three open lands on $0.10 selected, not Free. Same as snake today.
- `window.V2Detail = { game, stake: STEPS[si] }` (`3420`) is the only way the play module learns the choice.

Arena versus duel, as built today:

| kind | control shown | Play does |
|---|---|---|
| arena (snake, agar) | fixed ladder buttons, struck through where no row exists | `V2Play.playChosen()` (`3311`) |
| unbuilt duel | open stepper over `DUEL_LADDER=[0,.25,.5,1,2,5,10,20]` (`3330`) | `joinQueue()`, a fake queue that admits it (`3370-3389`) |
| built free-only duel (tanks) | fixed ladder, paid rungs struck | `launch(id,{lobbyType:'free'})` (`3309`) |
| built paid duel (knockout, battleship) | fixed ladder, all rungs live | `launch(id,{lobbyType:'free'})` (`3309`) |
| solo (omgshooter, paper) | nothing but name + Play + note | `launch(id,{lobbyType:'free'})` (`3309`) |

EXISTING BUG, do not model Paper on it: for a paid duel the rung the player picks is never read. `startFromDetail`
(`3302-3312`) sends every `built && (duel || solo)` game to `{lobbyType:'free'}`. The commit that added paid Knockout
(8674b05) did not touch this function. No UI path anywhere calls `launch('knockout',{stake:0.1})`: the detail button is
hardcoded free, the pinned rows are free (`board.js:123-126`), and `/api/live` lists snake only. So Knockout's and
Battleship's $0.10 / $1.00 buttons are cosmetic from the lobby today. Paper must go down the ARENA path
(`playChosen`), which does read `V2Detail.stake`.

## 3. `/api/live` and `board.js`

Server: `app.get('/api/live')` returns `{ lobbies: liveBoard(), stakes: ALL_STAKES, extras: liveExtras(), br }`
(`server/index.js:1491-1502`).
- `liveBoard()` (`1351-1382`) lists ONE row per rung of `ALL_STAKES`, for snake only: it filters
  `ladder.list()` to `l.game === 'snake'` (`1361-1363`) and emits
  `{ id:'snake:<REGION>:s<rung>', game:'snake', region, stake, players, bots, capacity:null, state:'open' }`
  (`1364-1378`). Every rung is listed whether or not a room exists yet (comment `1357-1360`), which is precisely what
  keeps the buy-in buttons open on a cold server.
- `liveExtras()` (`1390-1446`) reports population only (`{id, game, region, players, bots}`) for the non-ladder free
  rooms: `agar:free`, `omgshooter:free`, `tanks:free`, `knockout:free`, `battleship:free`. There is no Paper entry,
  because solo Paper has no server room.

Client: `board.js`
- `load()` (`35-46`) keeps `LOBBIES = j.lobbies` and `EXTRAS = j.extras`. Polls every 10 s, only while the home screen
  is visible (`191-198`); `_pauseLobbyAnims` stops it during a game and `_resumeLobbyAnims` restarts it
  (`v2.html:2967-2977`).
- `occupied()` = `LOBBIES` with `players > 0` (`83`). Not filtered by game: any game's rows show on the home board.
- `PINNED` (`113-131`): six always-visible free rows with `stake:null, lobbyType:'free'`. They are deliberately NOT in
  `LOBBIES` (comment `110-112`). Paper's is `{ id:'paper:free', game:'paper', stake:null, lobbyType:'free' }`
  (`127-130`) with a comment that is about to become false.
- `rowsToShow()` (`148-160`): occupied rows, plus the free SNAKE rung pinned from `LOBBIES` even when empty
  (`150-151`), plus each `PINNED` row unless a row with the SAME id is already there, its counts filled from `EXTRAS`
  by id (`152-158`).
- `rowHTML()` (`48-76`): count shown = `players + bots` (`50`). Enter calls `V2Board.join(id)`.
- `join(id)` (`180-185`): looks in `PINNED` FIRST, then `LOBBIES`, then `V2Play.enter(row)`.
- Every per-game reader filters by `l.game`: `playableStakes` (`board.js:143`), `playChosen` (`play.js:323-324`), the
  detail list (`v2.html:3217`). So adding `game:'paper'` rows to `lobbies` cannot disturb snake's buttons.

What Paper needs from the server: three rows in `lobbies`, always present (even with nobody in them), shaped exactly
like the snake ones but `game:'paper'` and `id:'paper:<REGION>:s<rung>'`. `players` = real people, `bots` = bots
(free arena only; paid arenas have none by the brief). Once those rows exist, with NO client change:
`playableStakes('paper')` = {0, 0.1, 1} so all three buttons open; `playChosen()` finds the row for the chosen rung;
occupied Paper rooms appear on the home board and in the detail list with a working Enter. The comment at
`board.js:133-140` describes exactly this for agar's future paid rooms.

Server constraint that decides how those rows are produced: do NOT put Paper rooms into the existing `ladder`
registry. `makeRoom` there always builds a snake `GameRoom` whatever `game` it is handed
(`server/index.js:1600-1610`), `ALL_SNAKE_ROOMS()` treats every `ladder` room as a snake room (`813-822`), and the
solvency sum walks `ladder.rooms` and iterates `room.snakes` (`1702-1715`), which would throw on a room that has no
`snakes` map. Use a second `LobbyRegistry` instance or a fixed
map for Paper. If `LobbyRegistry.list()` is reused (`server/LobbyRegistry.js:66-82`) the room must expose
`players` (a Map, `.size` = humans), `botCount`, optionally `capacity`, and `start()` / `stop()` (`35-54`, `84-95`);
only a `stake === 0` room is exempt from the sweeper (`88`).

Tests that pin the server text and must keep matching: `/players: hit \? hit\.players/` and `/bots: hit \?/`
(`test/v2route.test.js:205-213`), `/capacity: null/` and `app.get('/api/live'` (`197-203`). Add the Paper rows beside
the snake mapping, do not reshape it.

## 4. The pinned Paper row has to go

Today `paper:free` sends `{lobbyType:'free'}` (`board.js:129-130` to `play.js:311-317`). Once Paper is priced in rungs
that is the "two rooms both called Free" bug the codebase has already fixed three times (`v2.html:3231-3236`,
`play.js:327-351`, `test/v2route.test.js:1191-1232`). Also, because `rowsToShow` dedupes by id (`board.js:153`), a
pinned `paper:free` and a real occupied `paper:na:s0` would BOTH be listed.

Do this: delete the `PINNED` Paper entry and, inside `rowsToShow`, pin Paper's free rung from `LOBBIES` the way snake's
is, as an ADDED line. Do not edit the snake line: `test/v2route.test.js:814-817` asserts the exact text
`Number(l.stake) === 0 && l.game === 'snake'` and `!rows.some(r => r.id === free.id)`.

The detail screen's own free row already launches by stake, `V2Play.launch('<id>',{stake:0})` (`v2.html:3237`), so it is
correct for Paper as soon as `.lobwrap` is visible (it is hidden today by `#detail.solo`, `v2.html:900-902`). Quirk to
know: that row's count is the sum of humans over ALL of the game's occupied rooms, not just the free one
(`3217-3218`, `3228-3230`).

## 5. `V2Play.launch()` and the OWN_PAGE shortcut (`public/js/v2/play.js:238-308`)

Order of gates: already in a game (`239`); `V2_IS_SOON` (`244-247`); the room must be named by `stake` or `lobbyType`
or the launch is refused, because the widget defaults a missing room to the PAID `dime` tier (`248-257`, widget side
`main.jsx:344-346`); must be signed in, even for Free (`258-262`); must have a 3+ character name (`263-264`, `214-225`).

Then two exits:

A. The shortcut (`274-296`). `OWN_PAGE = { tanks, omgshooter, knockout, battleship, paper:'/paper' }`.
`staking = hasStake && Number(sel.stake) > 0` (`280`). If the game is in `OWN_PAGE` and NOT staking, the lobby itself
writes `sessionStorage.playerName` and NOTHING ELSE (`288`), sets `game-frame.src` (`292`), shows it, adds a
`body.playing` class that nothing reads or removes (`294`). It does not focus the frame. A paid seat never takes this
exit ("A PAID SEAT NEVER TAKES THIS SHORTCUT", `275-279`): the test is the amount, not the game.

B. The widget (`297-307`). Dispatches `duel:play` with exactly one of `{game, stake}` or `{game, lobbyType}`
(pinned by `test/v2route.test.js:222-233`). play.js must never quote, sign or submit a stake itself (`215-220`).
The widget (`wallet-widget/src/main.jsx`): `onPlay` (`335-351`) to `doStake` (`476-493`, drops re-clicks while busy)
to `stakeAndPlay` (`181-234`):
- `stakeOnly` (`75-144`) returns `{entryToken:'', worth:0}` immediately for stake 0 (`79-81`); otherwise quote, sign,
  `POST /api/submit-stake`, and returns the SERVER's `entryToken`, `worth`, `stake` (`138-143`). $0.10 and $1 are
  already valid rungs, so `/api/stake-quote?stake=0.1` and `submit-stake {stake}` work for Paper unchanged
  (`server/index.js:513-527`, `544-588`).
- then writes the hand-off into `sessionStorage` (`187-209`): `playerName`, `googleId` and `walletAddress` (both the
  wallet address), `stake` (the SERVER's rung as a string, `lobbyType` removed) or `lobbyType` (`stake` removed),
  `entryToken`, `entrySol` (= worth), `region`, `snakeColor`, `hatId`, `boostId`, `gameMode` (agar only), and removes
  `spectateOnly`.
- then picks the page: `PAGES = { agar, knockout, battleship, snake }`, **default `/game.html`** (`217-219`), loads it
  into `game-frame` (agar uses `agar-frame`), calls `_pauseLobbyAnims`, and focuses the frame on load so the keyboard
  works without a click (`220-230`).

`enter(row)` (`311-317`) launches by `stake` when the row has one, else by `lobbyType`. `playChosen()` (`320-359`)
needs a `LOBBIES` row with the same game and stake (`323-326`). With no rows at all and stake 0 it falls back:
`{stake:0}` if `V2_HAS_LADDER(game)`, else `{lobbyType:'free'}` (`352-356`). With no matching row and a paid stake it
says "No room at that buy-in" (`358`). That is why Paper needs `ladder:1` AND server rows.

RECOMMENDED for Paper: remove `paper` from `OWN_PAGE` and add `paper` to the widget's `PAGES`. Then Free, $0.10 and
$1.00 all take exit B, which is exactly how the snake game (not in `OWN_PAGE`) launches all of its rungs today. Gains:
one launch path for all three tiers; `stake`, `entryToken`, `region`, `walletAddress` are freshly written on EVERY
launch so nothing stale can be read; the frame is focused (Paper needs Q held for cash-out); lobby animations are
paused by the widget directly. Cost: one line in each file plus a rebuild.

Alternative (keep `paper` in `OWN_PAGE`, pointed at the new page): then the shortcut MUST be extended to write
`stake='0'` and remove `entryToken`, `entrySol`, `lobbyType`, or a free launch after a paid one reads the old `stake`
(see P3). `PAGES.paper` is needed either way for the paid tiers.

Either way `public/wallet/widget.js` must be rebuilt (`npm run build`: `vite.config.mjs:24-30` writes
`public/wallet/widget.js`) and COMMITTED. It is tracked in git and the deploy does not build
(`.github/workflows/deploy.yml:34-35` runs `npm install --production` then `pm2 restart`). Tests check the BUNDLE, not
just the source (`test/v2route.test.js:265-289`).

## 6. What the game iframe is told, and what it must say back

How a game page learns its room (all via same-origin `sessionStorage`, written by the top page just before it sets the
frame `src`):

| fact | key | written by | read by (precedent) |
|---|---|---|---|
| player name | `playerName` | shortcut `play.js:288`; widget `main.jsx:187` | `game.js:15`, `knockout.js:65-67`, `paper.html:63-66` |
| rung | `stake` (string, server's rung) | widget `main.jsx:195-197` only | `game.js:23-24`, `knockout.js:78-80` |
| fixed tier | `lobbyType` | widget `main.jsx:198-200`; `spectate` `play.js:369` | `game.js:25` |
| proof of payment | `entryToken` (one-time, 5 min TTL `server/index.js:374`) | widget `main.jsx:202` only | `game.js:38`, `knockout.js:81-83` |
| wallet | `walletAddress`, `googleId` | widget `main.jsx:188-189` only | `game.js:16-17` |
| region | `region` | widget `main.jsx:204`; `spectate` `play.js:365` | `game.js:39`, socket url `game.js:106-112` |
| snake colour | `snakeColor` from `localStorage duelseries_skin_color` | widget `main.jsx:205` | `game.js:125` |

Skin: the lobby's only skin picker is the SNAKE colour picker (`.lookrow` to `openLook()`, `v2.html:1862-1866`,
keys `duelseries_skin_id` / `duelseries_skin_color`, `2613-2628`). It is visible by default on any arena detail screen
(`.lookrow{display:flex}` `1086`; hidden only by `.duel` `893-894`, `.solo` `900-902`, `.soon` `979`). Paper has no
lobby skin: solo `boot()` takes `skin` and `''` means a random free colour (`paperMain.js:202`, `251`, `316-317`), and
`paper.html:66` passes none. Once Paper stops being `solo` the snake picker WILL appear on Paper's screen unless it is
hidden: add a flag (for example `nolook:1`), toggle a class beside `v2.html:3179`, and add
`#detail.nolook .lookrow{display:none}` beside `v2.html:900`. In multiplayer the server should assign colours anyway
(sixteen squares must be distinguishable).

The note under Play (`#dbnote`) is `display:none` unless `.duel` or `.solo` (`v2.html:947-949`, `903`), so Paper's
`soloNote` text disappears with `solo`. If a rules line is wanted ("kill a player, take their money, hold Q three
seconds to cash out") it needs its own show rule.

What the page must send back:
- Exit: `window.parent.postMessage('game:done','*')`. The STRING, compared with `!==` (`play.js:427-428`,
  `main.jsx:322`). The lobby then hides and blanks both frames, resumes animations and board polling, reloads the
  board, and refreshes the wallet balance (`play.js:429-432`); the widget clears its `playing` / `busy` state
  (`main.jsx:321-325`). Precedents: `game.js:3-6`, `knockout.js:639-645` (falls back to `location.href='/'` when not
  framed), solo Paper `paperMain.js:392-401`.
- Paid respawn (brief: a respawn in a paid arena is a new buy-in): post
  `{ type:'duel:restake', game:'paper', stake }` to the parent and wait for `duel:restake:done { entryToken }` or
  `duel:restake:error { message }` (`main.jsx:355-378`; it answers into `game-frame` for any game that is not agar,
  `359`). Reference client: `game.js:2031-2046`.
- Owner-only in-game actions, if any: the `duel:signaction` bridge (`play.js:397-423`).

Server side of the hand-off (detail in the sibling notes): the page echoes `stake` + `entryToken` on its join event and
the server takes worth and the payout wallet ONLY from `consumePaidEntryAtStake(entryToken, stake, 'paper')`
(`server/index.js:395-412`, `entryStore.js:46-55`; precedents: snake `2114-2131`, knockout `2601-2624`). The socket
knows nothing about who you are.

## 7. The page and its route

- `/paper` serves `public/paper.html` (`server/index.js:1123`). Nothing else on the server mentions Paper.
- `paper.html` uses RELATIVE urls for scripts and fonts (`paper.html:8-10`, `52-61`). Served at a ONE-segment path
  they resolve to `/js/paper/...`. A two-segment route such as `/paper/arena` would resolve them to
  `/paper/js/paper/...` and load nothing. Use something like `/paper-arena` (name is a suggestion), or absolute urls.
- The brief requires the solo page and its parity to stay untouched. The parity harness loads its own
  `harness/ours.html` on port 8795 (`paperio-reference/spec/BUILD-BRIEF.md:15`), not `/paper`, so leaving
  `paper.html` at `/paper` and adding a new page is the zero-risk choice. After the change the solo page is reachable
  by URL only, which is what the brief asks ("stays reachable for parity testing").
- Sockets: own pages use `io()` same-origin (`knockout.js:20`, `shooter.js:22`); snake picks the regional server
  (`game.js:106-112`). The widget stakes against `localStorage duelseries_region` (`main.jsx:61-62`) and the token lives
  in THAT server's memory. EU is out of scope and currently stopped, but the page should connect to the same region it
  reads from `sessionStorage.region`, or a player whose saved region is `eu` pays one server and joins another.

## 8. Exactly what changes for Paper (checklist)

1. `public/v2.html:2162-2167`: row becomes `type:'p', built:1, ladder:1` + the skin-row flag; delete `solo:1` and
   `soloNote`; rewrite the comment above it (it says there is no room on the server). Do not add `paid` or `duel`.
2. `public/v2.html`: class toggle + CSS to hide `.lookrow` for Paper (section 6). Optional rules note.
3. `server/index.js` `liveBoard()` / `/api/live` (`1351-1382`, `1491-1502`): three always-present Paper rows in
   `lobbies`. Keep the snake mapping text intact.
4. `public/js/v2/board.js:127-130` and `148-160`: drop the pinned `paper:free`; pin the free Paper rung from `LOBBIES`
   with an added line.
5. `public/js/v2/play.js:274`: remove `paper` from `OWN_PAGE` (recommended), or repoint it and clear the stale keys.
6. `wallet-widget/src/main.jsx:217`: `paper: '/<arena page>'` in `PAGES`; `npm run build`; commit the bundle.
7. `server/index.js:1119-1123`: route for the new page; new `public/<arena>.html` loading the shared
   `public/js/paper/*.js` plus the new net layer.
8. `test/v2route.test.js`: section 9.

No change needed: `LADDER` (`v2.html:2202`), `refreshSteps`, `drawStake`, `playChosen`, `enter`, `startFromDetail`
(Paper simply stops matching its first branch), `/api/stake-quote`, `/api/submit-stake`, `stakeRules.js`,
`entryStore.js`, the `game:done` handler, the restake bridge, the frames (`v2.html:3697-3703`).

## 9. `test/v2route.test.js`: what breaks and what to add

Must change:
- `1132-1137` (inside "a duel names its own stake"): asserts Paper's row has `built:1` AND `solo:1`, not `soon:1`, not
  `duel:1`, not `paid:1`, with the messages "paper.io is a built solo game" and "takes no stake". Removing `solo:1`
  fails line 1135. Rewrite to: `built:1`, `ladder:1`, not `solo:1`, not `soon:1`, not `duel:1`, and fix the comment at
  `1132-1133`.

Keep passing as they are, but easy to break while editing:
- `205-213`, `197-203`: server regexes on the snake board mapping and `capacity: null`.
- `211`: board.js must not contain `players + ...bots` on one expression the regex can match. Today's
  `(l.players || 0) + (l.bots || 0)` passes only because `|| 0)` sits between the word and the plus. Do not tidy it.
- `806-822`: exact text of the snake free-rung pin and of `occupied`. Also forbids the strings `fake`, `placeholder`
  and `players: 1` anywhere in board.js (`819`), comments included.
- `215-220`: play.js may not contain `submit-stake`, `stake-quote` or `signTransaction`, comments included.
- `222-233`: the unnamed-room guard and the two exact dispatch shapes.
- `366-374`: `rememberStake(Number(sel.stake))` must stay in play.js.
- `1171-1189`: `knockout:` and `battleship:` must stay in `OWN_PAGE`.
- `1191-1232`: the no-rows fallback text, `id:'snake'...ladder:1`, and agar must NOT get `ladder:1`.
- `265-289`: the bundle must contain `game-frame`, both quote urls and both submit shapes; source and bundle must agree.

Worth adding (same structural style as the file):
- Paper's row carries `ladder:1` and `V2_HAS_LADDER` is what the fallback asks (mirror `1227-1228`).
- `wallet-widget/src/main.jsx` AND `public/wallet/widget.js` both map `paper` to the arena page (mirror `282-289`).
  This is the test that stops P1 shipping.
- board.js has no pinned Paper row that launches by `lobbyType`.
- `server/index.js` lists `game: 'paper'` rows on `/api/live`.
- If `paper` stays in `OWN_PAGE`: the shortcut clears `entryToken` and sets `stake`.

## 10. Pitfalls (each verified in code)

- P1. PAID PAPER OPENS THE SNAKE GAME TODAY. `PAGES[game] || '/game.html'` (`main.jsx:217-219`) has no `paper`. The
  widget would take the stake, write `stake` + `entryToken`, and load `game.js`, which joins the snake rung with that
  token (`game.js:23-38`, `server/index.js:2114-2116`). Tokens are not bound to a game (`entryStore.js:46-55`; the
  `game` argument is a stats label, `server/index.js:401-411`). Add `paper` to `PAGES` and rebuild BEFORE any paid
  Paper button can be pressed.
- P2. The bundle is committed and the deploy never builds it (section 5). A source-only edit ships nothing.
- P3. Stale `sessionStorage`. The shortcut writes only `playerName` (`play.js:288`). `stake` is cleared only by
  `spectate` (`play.js:370`) and rewritten only by the widget; `entryToken` is removed only by `knockout.js:535` and
  `battleship.js:754`. After any paid game in the tab, a shortcut launch leaves `stake='0.1'` and a burnt token for the
  page to read. Taking Paper out of `OWN_PAGE` avoids this entirely.
- P4. No rows means no buttons. With no `game:'paper'` rows every rung, Free included, is struck through
  (`v2.html:2220-2223`, `board.js:141-146`). The same happens transiently if the detail screen is opened before the
  first `/api/live` answer, and it does not heal, because polling is gated on the home screen (`board.js:194-197`,
  explained at `play.js:330-334`). Free still launches through the `ladder:1` fallback; paid rungs say "No room at that
  buy-in" until the player goes back and reopens. Existing behaviour for snake; list the rows unconditionally so it is
  rare.
- P5. Do not copy the paid-duel wiring. `paid:1` + `startFromDetail` never sends a stake (section 2).
- P6. Two Frees. Any Paper row that launches `{lobbyType:'free'}` while the ladder launches `{stake:0}` recreates the
  split-room bug. After this change nothing for Paper should name a room by `lobbyType`.
- P7. Do not reuse the snake `ladder` registry for Paper rooms (section 3).
- P8. The lobby has no idea of "full". Rows carry `capacity` and `state` (`server/index.js:1375-1376`) but board.js
  reads neither. Paper caps at 16 real players (brief rule 7), and the stake is taken BEFORE the page opens. The server
  must check capacity before consuming the token (a consumed token is gone and the money is already on-chain), and
  should either open another arena at that rung or leave the token unspent so it can still be used within its 5
  minutes. If the lobby is to stop people paying into a full arena it needs new code reading `players >= capacity`.
- P9. `duelseries_wallet` is a dead key: `knockout.js:69`, `battleship.js:35` and `tanks.js:26` read it from
  `localStorage` and nothing in the repo (source or bundle) writes it, so it is always null. Use
  `sessionStorage.walletAddress` for display, and for payouts only the wallet recorded in the token.
- P10. Keyboard focus. Only the widget path focuses the frame (`main.jsx:225-228`). A page opened by the shortcut gets
  no focus, and Paper's cash-out is a held key. Call `window.focus()` in the page on load and on first pointer down
  regardless.
- P11. Names. The lobby allows `[a-zA-Z0-9]`, max 16 (`play.js:22`); solo Paper slices to 20 (`paper.html:65`). The
  server must sanitise again (`sanitizeName`, used at `server/index.js:2056`, `2623`).
- P12. Counts. The home row shows `players + bots` (`board.js:50`), so the free Paper arena will read 16 whenever it is
  bot-filled; paid rows can only ever show people. `occupied()` counts people only (`board.js:83`), so an all-bot free
  arena is listed only because it is pinned.
