# Paper multiplayer: owner's rules and build brief

Status: written 2026-09-20. The solo browser version is live at `/paper` (commit bffe6d5) and is proven identical to the
reference game by a deterministic golden-run diff (tools and goldens live OUTSIDE this repo in `../paperio-reference`,
see `../paperio-reference/spec/BUILD-BRIEF.md`). This document is the brief for the next phase: a server-run multiplayer
Paper with free, 10 cent and 1 dollar lobbies. Owen is building this for fun; there are no live players, so deploys are
low stakes, but the money code must still be correct (it moves real USDC).

## The rules, in Owen's words and answers (do not reinterpret)

1. You join a lobby by its buy-in (free, $0.10, $1.00). Your current money is shown OVER YOUR HEAD, for example `$0.10`.
2. If you kill someone you get ALL of their money. Kill a fresh $0.10 player and your head shows `$0.20`. If somebody then
   kills you, they get that `$0.20` on top of what they already have.
3. CASH OUT: hold Q for 3 seconds. Movement is LOCKED for those 3 seconds (you stand still; releasing Q cancels and you
   move again). When the hold completes you leave the arena with your money. The existing house cut applies (player
   gets 90%, 10% stays in escrow), paid on-chain exactly like the other games.
4. The map has a BASE SIZE and gets a little bigger when a player joins and a little smaller when a player dies or leaves.
5. A death with NO killer (you hit your own trail, or you disconnect): your money DROPS ON THE MAP as a cash pickup at
   the spot you died; whoever touches it first gets it. Money never leaves the arena except by cash-out.
6. When the map shrinks: it shrinks SLOWLY, territory outside the new edge is TRIMMED off, players outside are pushed
   inward. Nobody dies from the shrink itself.
7. An arena holds at most 16 real players. Paid arenas have NO BOTS (existing hard rule of this codebase: bots may exist
   only where nothing is staked, see `server/GameRoom.js` "THE ONE RULE"). The free arena fills with bots.

Everything else about the play (movement, speed, turning, trail, capture, cutting land, kill rules, camera, zoom, the whole
look and HUD) stays IDENTICAL to the solo version, which is identical to the reference. Multiplayer adds to it; it must
not change it. The solo page, its golden parity (600/600 on both seeds) and its node tests must keep passing untouched.

## Decisions already made by Claude (sensible defaults, change only with a reason)

- ONE implementation of the simulation. The modules under `public/js/paper/` already load under node (UMD wrapper,
  namespace `DuelPaperLib`). The server runs the same geometry, territory, unit and game code. Multiplayer behaviour
  goes into NEW files (an arena game class that extends the solo `Game`, a server room, a client net layer), not into
  edits that change solo behaviour. Where the solo `Game` needs a seam (a hook, an overridable method), add the seam in
  a way that is a strict no-op for the solo path and re-run the golden parity check.
- Server-authoritative, like every other game here: the server simulates, clients send steering input and render
  snapshots with interpolation, and predict only their own square. The server never trusts a client value for position,
  kills, money or cash-out.
- Money follows the existing model exactly: paid entry is an on-chain stake verified server-side, one-time signature
  claim, server-minted one-time entry token, worth taken ONLY from that token (`consumePaidEntry`), cash-out pays 90%
  via the existing withdraw path, earnings recorded, CollusionMonitor told about every transfer of value between players
  (kills and pickups), and the solvency monitor must count the money alive in Paper arenas as liability.
- Arena size keeps the reference's space per square: radius = 950 * sqrt(n / 16) where n = squares alive, clamped to a
  base size at n = 4 (radius 475) and to the full 950 at n = 16. The radius eases toward its target (growth quick,
  shrink slow). The free arena is kept at 16 squares by bots, so it is always full size, like the reference.
- A respawn in a paid arena is a new buy-in, as in the snake game.
- Leaving by cash-out removes your square and your land with no kill credit to anyone.
- The lobby card offers Free, $0.10 and $1.00. The free arena is also server-run (one game, not two); the solo page
  stays reachable for parity testing.

## Out of scope for this phase

EU region specifics, tournaments, skins shop, mobile-specific controls beyond what the solo page already has (touch
steering works; cash-out needs an on-screen hold button on touch devices: include a simple one).
