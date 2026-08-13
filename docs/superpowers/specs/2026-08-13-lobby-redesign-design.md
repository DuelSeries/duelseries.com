# Lobby redesign: a live match board for a multi-game arcade

Date: 2026-08-13
Status: draft, awaiting owner review

## The problem

DuelSeries is going from 2 games to roughly 8 (snake, agar, knockout, rock
paper scissors, battleship, tanks, paper.io, and more). The current lobby
cannot absorb that, for two separate reasons.

**Structurally**, the lobby is two hardcoded near-duplicate pages,
`#lobby-screen` and `#lobby-screen-2`, that you swipe between with arrows.
Eight games means eight copies of the same 2,100-line `lobby.js`. Every visual
change would have to be made eight times.

**Commercially**, fixed stake tiers fragment the player base:

| | pools |
|---|---|
| today | 2 games x 3 tiers (free / 10c / $1) = 6 pools |
| after adding games | 8 games x 3 tiers = 24 pools |

With 24 pools and, say, 30 concurrent players, the average pool holds one
person. This is already visible: ten players in the $1 lobby means the person
who picks 10c plays alone. Fixed tiers are actively breaking the game, and
adding games multiplies the damage.

## The principle

**Never show a player a room they can join alone.** Show them where people
already are, and let stakes be flexible rather than fixed.

## What the lobby becomes

The front page stops being a per-game page and becomes a single **live board**
of things you can join right now, grouped by game. Every row is an action.

Three row states, so the board is never empty. Every row shows one exact stake,
because every player in a lobby pays the same amount:

| row state | example | action |
|---|---|---|
| open, has room | `Snake · NA · $0.20 · 7/30 players` | Join |
| open, waiting | `Rock Paper Scissors · EU · $2 · 1/2 · waiting 40s` | Join |
| full | `Battleship · US · $5 · 2/2 players` | Spectate |

A waiting player becomes content on somebody else's front page instead of a
spinner on their own. A full match is still worth showing, because spectating
is a reason to stay. And because snake and agar are persistent worlds seeded
with bots, there is always at least one joinable row even with zero real
players online.

Supporting controls, all on the board:

- **Stake**: a free-text amount, not tier buttons. Any value at or above the
  minimum, with quick-pick chips for common amounts.
- **Region**: NA / EU per row and on create.
- **Visibility**: public or private when you create. Private lobbies let a
  player bring their own opponent, which is the only reliable answer to a cold
  start.
- **Filter**: by game, stake range and region, for when the board is busy.
- **Quick play**: joins the busiest open lobby for that game without browsing.

### Reference: playpulp.io

A separate project the owner co-builds, and the closest working example of this
model. Its home page, read in full on 2026-08-13, runs in this order:

1. **Live Matches** with a filter. Rows carry game, region, exact stake and
   occupancy: `Rock, Paper, Scissors · US · $6.70 · 2/2` and
   `Snake Teams · EU · $2 · 7/30`. Full rows offer spectate, open rows offer
   join. Persistent games show capacity, not just a count.
2. **Your look**, the skin preview and customize entry, on the home page.
3. **Your balance** with copy address, deposit and withdraw, also on the home
   page rather than behind a menu.
4. **Games list with live player counts**: Tanks 0, Snake Game 2, Knockout 0,
   Rock Paper Scissors 4, Battleship 0, Amoeba.io 0, Zone Wars 0.
5. **A scrolling activity ticker** of real results: `qesku won $6.20 Battle
   Royale Snake`, `tungsahur cashed out +$0.82 Slither`, and so on, looped.
6. **Scheduled tournaments**: "Most profit in Snake, Thu 1:00 to 2:30 PM EDT,
   live now, 38m left", a live top three podium, a $20 winner-takes-all prize
   plus a cosmetic, and a second event announced for 6:00 PM with a countdown.
   Eligibility is stake-bounded: "any wager from $0.50 to $3".

Three things worth taking, in order of value:

- **Scheduled tournaments are a scheduling answer to a matchmaking problem.**
  Rather than hoping players independently choose the same game at the same
  stake at the same moment, you tell them when to show up. Everyone converges
  into a 90 minute window and the board is full for that window. This is far
  cheaper than acquiring more players and neither fixed tiers nor an open board
  achieves it. It is the single strongest idea on their site.
- **The activity ticker is social proof that survives a quiet board.** Real
  names and real amounts make the product feel alive even when only two people
  are playing. Note their games list is mostly zeroes and the ticker covers it.
- **Modes within a game** (Snake, Battle Royale Snake, Snake Teams) add depth
  without the cost of building a whole new game.

Two things to do differently:

1. PULP's snake page shows "No open lobbies" when quiet, which is a dead end
   with no invitation to start one. Bot-seeded persistent worlds mean our board
   always has something joinable.
2. PULP surfaces no trust signal at all. See the trust section below.

One thing to note rather than copy: PULP uses cosmetics as **tournament
prizes** ("+ Disco Ball Antenna") rather than as a shop. That is a use for
cosmetics that survives the decision to delete the cosmetics shop, since it
costs nothing and is earned rather than sold.

## Game types

Two kinds of game, and the lobby treats them differently. This is the only
distinction the shell needs to understand.

**Persistent** (snake, agar). A lobby starts as soon as you enter it and runs
until it empties. You do not wait for anyone. Others join over time and pay the
same stake you did. There is also always a free lobby per game per region.

**Match** (rock paper scissors, battleship, knockout, tanks). Needs a fixed
number of players before it can start, so creating a lobby means waiting until
it fills.

The mechanic is the same in both cases: a lobby at an exact stake that other
people can see and join. The only difference is whether the game can start with
one player in the room. The shell does not need to know anything else.

## Stake model

Fixed tiers are removed. In their place, **a lobby is created on demand at an
exact stake, and everyone who joins it pays exactly that amount.**

A lobby is identified by `(game, region, stake)`. You pick a game, type an
amount, and either join an open lobby already at that amount or create one.
A $0.50 player and a $20 player are never in the same room. Stakes never mix.

This is simpler than it first looks, and it removes a problem rather than
creating one. Because entry is symmetric, every fight inside a lobby is between
equal buy-ins, so no transfer cap, side-pot rule, or change to what dying costs
is needed. **The existing eat-and-take money rule is kept exactly as it is.**
An earlier draft of this document proposed mixing stakes in one world with a
capped transfer; that is rejected. It was more complex, it changed the meaning
of death, and it touched the money path for no gain.

Worth still diverges inside a lobby as players grow by eating, so a newcomer
buying in at $0.20 may face someone carrying $3.00. That is not the same
problem: entry was equal and the difference was earned in game. It is the core
loop of the game and it is how the current tiers already behave, so it is not a
regression.

### Then why is this not just tiers again?

Fixed tiers fail because the tiers are chosen up front, are always present, and
are usually empty. On-demand lobbies fail differently and much more gently:

- A lobby only exists because a real player created it, so an empty lobby is a
  lobby that just started, not a permanent ghost town.
- Open lobbies are **visible with their player counts**, so players converge on
  the ones that already have people. That convergence is the anti-fragmentation
  mechanism, and it is a behaviour rather than a rule.

Two nudges keep amounts from scattering across $0.50, $0.51, $0.52:

- **Quick-pick chips** for common amounts next to the free-text box, so most
  players land on the same handful of values without being restricted to them.
- **Sort the board by player count** by default, so the busiest lobbies are
  what a new player sees first.

### Match games

Identical mechanic. Rock paper scissors, battleship and the rest post a lobby
at an exact stake and wait for the required number of players. The only
difference from snake is whether the game can start with one player in the
room.

## Trust surface

This is the main thing that separates DuelSeries from damnbruh and from PULP,
and it costs little because it is already true.

- The escrow wallet address, published and linkable.
- The house cut (10%) stated plainly at the point of play, not in a footer.
- A recent payouts feed where every entry links to the real Solana transaction.
- "Every payout settles on-chain and you can verify it" as the headline claim.

A real-money site that shows its working looks safer than one that shows neon.

## Architecture

### Game registry

One data file, `shared/games.js`, is the single source of truth:

```js
{
  id: 'snake',
  name: 'Snake',
  type: 'persistent',        // or 'match'
  players: null,             // or 2
  minStake: 0.10,
  regions: ['na', 'eu'],
  status: 'live',            // or 'soon'
  art: '/img/games/snake.png',
  entry: '/game.html',
}
```

The lobby renders entirely from this. Adding a game becomes one registry entry
plus its server room class, not a new lobby page. Games with `status: 'soon'`
render as coming-soon cards, which is how the eight-game ambition gets
communicated before the games exist.

### Server

- `GET /api/live` returns the board as one flat list of lobbies:
  `{ id, game, region, stake, players, capacity, state }`, where `state` is
  `open` or `full`.
- A `LobbyRegistry` service owns the lifecycle: create on demand at an exact
  stake, list, join, expire when empty. Joining is the money-critical path. It
  must charge exactly the lobby's stake and must claim a seat atomically, so
  two players cannot take the last seat of a filling match at the same moment.
- Persistent rooms keep their existing `GameRoom` / `AgarRoom` shape. Only the
  lobby-type dimension is removed from room keys.

### Client

- `public/js/lobby/` replaces the single 2,114-line `lobby.js`: `board.js`
  (renders rows), `registry.js` (reads the shared registry), `stake.js` (the
  amount control), `wallet.js` (existing widget). Each file has one job.
- One `#lobby` screen. `#lobby-screen-2` and the swipe arrows are deleted.

## What gets deleted

- `#lobby-screen-2` and the prev/next lobby arrows.
- The Free / 10c / $1 lobby-type buttons and the `lobbyType` concept in the
  client.
- The per-game duplicated stat panels, replaced by one profile area.

## Phasing

Each phase ships on its own and leaves the game working.

1. **Game registry and data-driven shell.** Pure refactor, no visible change,
   no money touched. Unlocks everything else.
2. **Stake model.** Replace the three fixed tiers with a lobby keyed on an
   exact stake, created on demand. The eat-and-take money rule is unchanged, so
   this is smaller and safer than the earlier capped-transfer draft, but it
   still touches buy-in and needs tests.
3. **Live board.** The new front page: open lobbies with counts, quick-pick
   stake chips, filter, and the activity ticker.
4. **Brand and visual identity.** Only now, once the shape is settled.
5. **New games,** one at a time against the registry.

**Scheduled tournaments** are deliberately not numbered above. They are the
strongest single idea taken from PULP and they do not depend on the shell
refactor, so they can be built at any point once phase 3 exists. They may be
worth pulling forward ahead of phase 4, because they solve liquidity, which is
the actual problem, whereas visual identity solves perception.

Visual identity is deliberately fourth. Colours and type are cheap to change;
the shape of the product is not. Doing visuals first means redoing them.

This document is the north star for all five phases. Only **phase 1** goes to
an implementation plan next. Phases 2 to 5 each get their own spec when their
turn comes, so that decisions made while building phase 1 can inform them.

## Risks and open questions

- **Buy-in changes touch real money.** Smaller than the rejected capped-transfer
  idea, but joining a lobby must still charge exactly the lobby stake and
  nothing else, and two players must not be able to claim the last seat of a
  full lobby at once.
- **Cold start.** Bots cover persistent games. Match games have no equivalent,
  so private lobbies, a visible board and scheduled tournaments are the
  mitigation. There is no bot answer for 1v1 without disclosing it, and hiding
  that would be dishonest.
- **Minimum stake per game** is unset. Needs a number before phase 2.
- **Empty lobby expiry** is unset. How long does a lobby nobody joined sit on
  the board before it is withdrawn and the stake returned?
- **Spectating** is listed as a row action but does not exist yet in either
  game. It may need to move to a later phase.
