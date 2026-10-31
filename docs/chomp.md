# Chomp: the Pac-Man-style arena

At `/chomp` since 2026-10-25; paid rungs and the lobby card (Free, $0.50, $1) since 2026-10-26 (Owen's OK). Owen's brief: look exactly like Pac-Man and play
exactly like Pac-Man, in one big shared maze ("Arena, cash out anytime"), money later.

## The line we keep (IP)

Pac-Man is Bandai Namco's. We match the **gameplay** (documented publicly in Jamey Pittman's *The Pac-Man Dossier*)
and the classic arcade **style**, drawn by us in code. We never use Namco's sprites, ROM graphics, sound files, the
original maze layout, the name or the logo. Our maze module is our own layout (`shared/chompMaze.js`), every sprite is
computed from a shape test (`public/js/chomp/chompDraw.js`), the sounds are synthesized (`chompSound.js`), and the game
is called Chomp.

Exception, Owen's call 2026-10-26 ("just change it to Pac-Man for now... we'll change it back later"): the name players
SEE is "Pac-Man" (the lobby card, the page title and title card, the paid door's lines, the join and earnings pushes).
That is Bandai Namco's trademark, so it is one constant, `shared/chompName.js`; changing it back is one line. Ids,
routes, keys, the owner console and shared links (`shared/shareGames.js`) stay Chomp.

## Files

| Where | What |
|---|---|
| `shared/chompRules.js` | every number, tagged DOSSIER (sourced), ARENA (a dossier rule scaled to the arena) or CHOSEN (ours) |
| `shared/chompMaze.js` | the 28 x 31 module and the arena builder (3 x 3 modules, sealed outer edge) |
| `shared/chompMove.js` | chomper movement (buffered turns, cornering, energizer pause), run by server AND page |
| `shared/chompWire.js` | the binary snapshot (14 B a player, 8 B a ghost) |
| `server/chomp/chompRoom.js` | the sim: eating, power, collisions, fruit, pellet respawn, bots fill, late turns |
| `server/chomp/chompGhosts.js` | the four personalities, scatter/chase, fright, house, eyes |
| `server/chomp/chompBots.js` | house bots (flee, hunt when powered, nearest dot by BFS) |
| `server/chomp/chompBoot.js` | the `/chomp` namespace, rate limits, per-IP cap, the paid door; `CHOMP=off` closes it |
| `server/chomp/chompArenas.js`, `chompMoney.js` | the paid rungs and their money (see below) |
| `public/chomp.html`, `public/js/chomp/*` | the page: title card, prediction, interpolation, renderer, HUD, sounds |
| `test/chomp.test.js` | maze shape, movement, targeting, eyes get home, bot arena run, wire, late turns |

## Owen's picks (2026-10-25)

- Look: **C Pixel** (the arcade's own 8 px grid, scaled up with hard edges). `?look=arcade` and `?look=neon` still work.
- Free rooms: **one life**, like slither.io. Caught once: the shared end card (dsEnd.js), then Play again.
- Money version ghosts: **a ghost kills you and your coins drop on the maze** for anyone to grab.
- Cash-out: **hold Q, the gold ring fills around you while you keep moving, like slither.io**.

## The map is a torus (Owen 2026-10-26)

"One continuous map, it works like a globe": `Maze.build(mx, my, { wrap: true })` gives every module a spacer to its
right and below (the last ones too) and runs the tunnels on across the seam, so walking off any edge comes back on the
opposite one. Every distance (ghost targets, prey, danger, fright radius, bots, coin drops) is the short way across
the seam (`A.dx`, `A.dy`), positions wrap after each move (`A.wx`, `A.wy`), and the walls are traced on a copy padded
with the map's far side (`chompWalls.js`). The page keeps the camera on you from the first frame (no edge to stop at),
draws everything the short way from the camera. (2026-10-26 to 10-30 a "you are here" pulse ringed every spawn; Owen
2026-10-30 had it removed with the outline round your own Pac-Man: the 2 s spawn flicker is the only cue.) The arena
starts at 2 x 2 modules (Owen) and grows with the crowd.

**Growing and shrinking** (`server/chomp/chompResize.js`, Owen's pick "add blocks where nobody is"): the crowd asks
for one module per `PLAYERS_PER_MODULE` chompers (at least 2 x 2, at most `MODULES_MAX`); every `RESIZE_EVERY_S` (and
at most once per `RESIZE_GAP_S`) the room adds or removes one module column or row at the seam with no person within
`SEAM_CLEAR` tiles (bots do not count; a bot in a removed column is placed elsewhere). The torus is first turned so
that seam is its edge (every position and tile shifted alike: nothing moves on screen), then the column goes in or
out at the edge. Dots, the pellet queue, fruit, ghosts (a new module brings its pair; a removed one's go with it,
never where a person can see) carry over, and in a paid room every coin in a removed column moves to the nearest path
tile outside it: no balance changes. The pages get `c:arena { axis, shift, mx, my, dots, coins, fruit, gmap }` before
the next snapshot and turn everything they hold the same way.

## Power pellets are per player; fruit; Customize (Owen 2026-10-26)

An energizer turns EVERY ghost blue for its eater only (`chompRoom.blueFor`): each player has their own fright timer
(`p.power` from `p.powerAt`), other players keep meeting normal ghosts unless they ate their own, and collisions use
the player's own state (a ghost blue for someone on its tile is eaten and its eyes fly home for everyone; else it
catches everyone there not blinking safe). A ghost that went home as eyes since your energizer comes back out normal for
you (`g.backAt`), as in the arcade. One ghost has one body, so its walk is shared: blue for any eater within
`FLEE_RADIUS` it takes the frightened walk (random turns, half speed). The ghost's fright left the wire: each page draws
blue from its own timer with the same rule (`chompMain.js` `ghostHome`: ghosts in eyes when your energizer lands, and
every one eaten since). A fruit (cherry) gives its eater a speed boost, predicted on the page (numbers in the next
section). Customize: free colours in `shared/chompSkins.js` (`duel.chomp.skin`) and the Shop's skins in
`shared/shopSkins.js` `SKINS.chomp` (pixel patterns, `chompPx`), sent in the socket handshake and checked once by
`chompBoot.skinOf` (a bought one only with a genuine skin pass), then carried to every page in the chomper's meta `s`.

## Simpler and faster (Owen 2026-10-30)

His Short of it took off and he said "there's just too much going on". All in `shared/chompRules.js`:
- **No rings.** The spawn pulse and the outline round your own Pac-Man are gone, and the powered halo too. Spawn safety
  is `SPAWN_SAFE_S` 2 s (was 3) shown only by the flicker. Yours is the one the camera stays on.
- **Open maze.** A new module (still 28 x 31, tunnels, house, fruit and spawn spots where they were): 12 plain blocks
  instead of about 26 small ones. Two ghosts a module (`MODULE_GHOSTS`: Blinky with Inky, Pinky with Clyde, the modules
  taking turns like a checkerboard), `PLAYERS_PER_MODULE` 1.25 (was 3), free-room bots 4 to 8 (was 5 to 12,
  `server/botPopulation.js`), dots back after 8 s and energizers after 25 s (were 30 and 40: the bots kept the maze bare).
- **Speed.** `R.pace(powered, boosted, bumped)` is the one speed rule the server and the page both use. Powered 105%
  (was the arcade's 90%), a cherry x1.45 for 4 s (was x1.1 for 3 s), each dot x1.08 for 20 ticks (the arcade's
  one-frame dot stop is gone). Fastest (powered and cherry) is 0.24 tile a tick, under half a tile, so no tile centre
  is ever skipped. The wire's flags carry BOOST (16) and BUMP (32).
- **Every boost shows** (`chompMain` speedLook, drawn by `chompPixel`): a cherry turns the Pac-Man orange with three
  after-images, speed lines and a glow, SPEED! rises where it was taken and a whoosh plays (`ch.whoosh`, softer for
  someone else's on your screen); powered gets two after-images and a glow; a dot's bump two faint speed lines.
- **Meetings between ticks.** `collide` also counts two things that swapped tiles in one tick (heading at each other
  they can pass through one another at speed): ghost and chomper, and a powered chomper and its prey.
- **Netcode at speed.** Each predicted tick keeps the speed it ran at, so a replay after a correction runs every tick
  at its own speed; a cherry that turns out to be somebody else's takes its boost back out of those ticks; the power
  count is compared at the same tick; the jitter allowance scales with speed. A press the server never got (two quick
  presses arriving together were dropped by the old 12 ms gap rule, now a token bucket of 4 in `chompBoot`) is
  pressed again after 30 ticks with no echo, so the page and the server can no longer go separate ways for seconds.

## Netcode in one paragraph

The server sims at 60 Hz and sends a 20 Hz binary snapshot (volatile, sent before any reliable emit so it is not
dropped behind them). Dots, events and the board go reliable. The page predicts its own chomper with the same movement
code: every key press is numbered with the local tick; the server echoes the last number and how many ticks ago it
applied it, which maps its position onto one of our past ticks; a mismatch larger than a sixth of a tile replays our
ticks from its state. Turns are lined up with the tile the key went down in (`chompRoom.input` waits for a tile ahead,
`lateTurn` rewinds up to 250 ms for one already passed). Measured headless at 90 ms RTT with jitter: 3% of checks
corrected, most of them a tick of jitter.

## The money version (built 2026-10-26)

Paid rungs $0.50 and $1 (`CHOMP_PAID`, on by default; instant off switch `chomp:paid:off` in the owner console,
saved across restarts). Nothing new in the money paths: paid agar.io's machinery is reused whole.

| Piece | Where |
|---|---|
| door (one-time entry token, stake row claim, refunds, resume key, one seat per wallet) | `server/ag/agPaidDoor.js` with `ev: 'c'`, `game: 'chomp'` |
| accounts, hold-Q cash-out, grace and dormant, release, emergency, shutdown, bounty bots | `server/ag/agMoney.js`, extended by `server/chomp/chompMoney.js` |
| coins on the maze | `ChompBank` (agBank over PaperBank floor coins): `dropCoins`, `collect`, a per-tile index |
| directory (rungs, maps, outcomes, cooldown, bots, sweep, `/api/live` rows) | `server/chomp/chompArenas.js` (agArenas' paid half) |
| 90/10 payout, refunds, house floor and breach income | `server/paperPayout.js` instance `chompPayout` (game `chomp`, prefix `c`) |
| crash journal, owed-row drainer, liability sum, drain status, shutdown refunds | shared with agar, Paper and paid snake (`server/index.js`) |
| page hand-off, restake, resume after a reload | `public/js/ag/agPaid.js` (`game: 'chomp'`), `public/js/chomp/chompPaid.js` |

Rules (Owen 2026-10-25/26):

1. **Buy-in = worth**, from the consumed token only. One open paid seat per wallet.
2. **A catch drops everything.** A ghost, or a player eating you with a power pellet, closes your account into coins
   on the path tiles around you (one coin per $0.125, 4 to 16, the death tile first); whoever steps on a coin's tile
   takes it. Coins are drawn in the shared DuelSeries gold with a $, never like a dot.
3. **Hold Q 3 s** (180 ticks; a held Cash out button on a phone) to cash out 90/10 while you keep moving; caught during
   the hold, your coins drop instead (death wins a same-tick tie). The count starts only once the spawn blink is over,
   so a fresh seat can never leave without having been catchable.
4. **Coins nobody takes go to the house** (Owen 2026-10-26): after an hour as `chomp_floor` income, at a restart or
   crash as one journal floor record (`chfloor:` key) booked at the next boot. Except: in a room a bounty bot ever
   played in they go back to whoever dropped them (owed rows), a bot's own money never goes to the house (seed back to
   the Bot bank, players' money back to them), and an emergency close gives every coin back.
5. **Disconnect**: the agar rule (5 s grace moving on, then still and catchable for 3 minutes, then cashed out 90/10).
   A restart or crash refunds every open balance 100% (owed rows).
6. **Bots** are the owner's bounty bots only (Control, room #0 of a rung, seeded from the Bot bank, never cash out,
   never back once caught); they go for coins first.
7. Paid rooms use the same 3x3 maze as the free room (Owen 2026-10-26).

Tests: `test/chompMoney.test.js` (ledger, every exit, bots, a fuzz run), `test/chompPaidDoor.test.js` (door,
directory, switches).

## Open, for later

- Self-host the Press Start 2P font (OFL) instead of the Google Fonts link.
- Lobby card and the lobby frame (Lobby button, postMessage `game:done`), Spectate bar, chat, clip recorder.
- Arena size growing with the crowd (`MODULES_X/Y`), interest-group snapshots past ~40 players.
- Fruit beyond cherries (the dossier's level table) and the arcade's ghost-eaten freeze (no freeze in a shared world).
