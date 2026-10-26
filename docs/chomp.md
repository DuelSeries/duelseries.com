# Chomp: the Pac-Man-style arena

Hidden at `/chomp` (not in the lobby), free only, since 2026-10-25. Owen's brief: look exactly like Pac-Man and play
exactly like Pac-Man, in one big shared maze ("Arena, cash out anytime"), money later.

## The line we keep (IP)

Pac-Man is Bandai Namco's. We match the **gameplay** (documented publicly in Jamey Pittman's *The Pac-Man Dossier*)
and the classic arcade **style**, drawn by us in code. We never use Namco's sprites, ROM graphics, sound files, the
original maze layout, the name or the logo. Our maze module is our own layout (`shared/chompMaze.js`), every sprite is
computed from a shape test (`public/js/chomp/chompDraw.js`), the sounds are synthesized (`chompSound.js`), and the game
is called Chomp.

## Files

| Where | What |
|---|---|
| `shared/chompRules.js` | every number, tagged DOSSIER (sourced), ARENA (a dossier rule scaled to the arena) or CHOSEN (ours) |
| `shared/chompMaze.js` | the 28 x 31 module and the arena builder (3 x 3 modules, sealed outer edge) |
| `shared/chompMove.js` | chomper movement (buffered turns, cornering, dot pause), run by server AND page |
| `shared/chompWire.js` | the binary snapshot (14 B a player, 8 B a ghost) |
| `server/chomp/chompRoom.js` | the sim: eating, power, collisions, fruit, pellet respawn, bots fill, late turns |
| `server/chomp/chompGhosts.js` | the four personalities, scatter/chase, fright, house, eyes |
| `server/chomp/chompBots.js` | house bots (flee, hunt when powered, nearest dot by BFS) |
| `server/chomp/chompBoot.js` | the `/chomp` namespace, rate limits, per-IP cap, sleep when empty; `CHOMP=off` closes it |
| `public/chomp.html`, `public/js/chomp/*` | the page: title card, prediction, interpolation, renderer, HUD, sounds |
| `test/chomp.test.js` | maze shape, movement, targeting, eyes get home, bot arena run, wire, late turns |

## Owen's picks (2026-10-25)

- Look: **C Pixel** (the arcade's own 8 px grid, scaled up with hard edges). `?look=arcade` and `?look=neon` still work.
- Free rooms: **one life**, like slither.io. Caught once: the shared end card (dsEnd.js), then Play again.
- Money version ghosts: **a ghost kills you and your coins drop on the maze** for anyone to grab.
- Cash-out: **hold Q, the gold ring fills around you while you keep moving, like slither.io**.

## Netcode in one paragraph

The server sims at 60 Hz and sends a 20 Hz binary snapshot (volatile, sent before any reliable emit so it is not
dropped behind them). Dots, events and the board go reliable. The page predicts its own chomper with the same movement
code: every key press is numbered with the local tick; the server echoes the last number and how many ticks ago it
applied it, which maps its position onto one of our past ticks; a mismatch larger than a sixth of a tile replays our
ticks from its state. Turns are lined up with the tile the key went down in (`chompRoom.input` waits for a tile ahead,
`lateTurn` rewinds up to 250 ms for one already passed). Measured headless at 90 ms RTT with jitter: 3% of checks
corrected, most of them a tick of jitter.

## The money version (plan only, not built)

Reuse the paid machinery agar.io and Paper already run; nothing new in the money paths.

1. **Buy-in = worth.** The stake ladder ($0.50, $1.00) through the existing paid door: stake on-chain, the server mints
   the one-time entry token, `consumeAtStake` sets your worth from the token only. One paid seat per wallet.
2. **Coins on the maze.** Worth is shown as gold coins on your chomper's HUD and in the board (`DSCount`). Paid rooms
   draw coins in the slither gold (`breathing gold + $`), never mistakable for dots.
3. **Eating a player** (with your power pellet on) drops ALL their coins on the tiles around where they were eaten,
   like slither's death drop; whoever touches a coin takes it (the eater is usually first). Coins never vanish: every
   coin is a ledger row until picked up or swept to the house at room close.
4. **A ghost catching you** (Owen's pick): you are out and your coins drop the same way. Ghosts never hold money.
5. **Hold Q to cash out** (Owen): a 3 s hold, the shared gold "Three Count" ring (`DSEnd.ring`) fills around your
   chomper and you **keep moving** while it fills; getting eaten or caught during the hold drops your coins as usual.
   Phone: a held Cash out button. Paid out 90/10 through the parameterized payout (`paperPayout`), owed-row drainer,
   journal replay on restart, crash refunds, the same as agar.io.
6. **Bots never cash out**, carry no money unless funded from the Bot bank (paid-room bots rules), and never eat a
   person's coins in a paid room.
7. **Anti-collusion:** every coin pickup of another wallet's coins goes through `CollusionMonitor`.
8. **Power pellets in paid rooms** keep the dossier timings; the 18-tile fright radius and pellet respawn may need
   tuning so a paid room cannot be farmed by camping an energizer (decide after a playtest).
9. **Disconnect:** the agar.io rule (frozen 3 min, then cashed out 90/10 to the wallet).

## Open, for later

- Self-host the Press Start 2P font (OFL) instead of the Google Fonts link.
- Lobby card and the lobby frame (Lobby button, postMessage `game:done`), Spectate bar, chat, clip recorder.
- Arena size growing with the crowd (`MODULES_X/Y`), interest-group snapshots past ~40 players.
- Fruit beyond cherries (the dossier's level table) and the arcade's ghost-eaten freeze (no freeze in a shared world).
