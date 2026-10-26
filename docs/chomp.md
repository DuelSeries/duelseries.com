# Chomp: the Pac-Man-style arena

Hidden at `/chomp` (not in the lobby) since 2026-10-25; paid rungs since 2026-10-26. Owen's brief: look exactly like Pac-Man and play
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
| `server/chomp/chompBoot.js` | the `/chomp` namespace, rate limits, per-IP cap, the paid door; `CHOMP=off` closes it |
| `server/chomp/chompArenas.js`, `chompMoney.js` | the paid rungs and their money (see below) |
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
