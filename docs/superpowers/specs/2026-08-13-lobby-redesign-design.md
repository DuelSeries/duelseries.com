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

Three row types, so the board is never empty:

| row type | example | action |
|---|---|---|
| live world | `Snake · $1-$20 buy-in · 14 playing` | Join |
| open challenge | `Rock Paper Scissors · $2 · tungsahur waiting 40s` | Accept |
| full match | `Battleship · $5 · 2/2 players` | Spectate |

A waiting player becomes content on somebody else's front page instead of a
spinner on their own. A full match is still worth showing, because spectating
is a reason to stay. And because snake and agar are persistent worlds seeded
with bots, there is always at least one joinable row even with zero real
players online.

Supporting controls, all on the board:

- **Stake**: a free-text amount, not tier buttons. Any value at or above the
  minimum.
- **Region**: NA / EU per row and on create.
- **Visibility**: public or private when you create. Private lobbies let a
  player bring their own opponent, which is the only reliable answer to a cold
  start.
- **Filter**: by game, stake range and region, for when the board is busy.
- **Quick match**: accepts the best open challenge without browsing.

### Reference

playpulp.io (a separate project the owner co-builds) implements close to this
and validated it: a Live Matches board, arbitrary stake amounts such as $6.23,
region badges, spectate on full matches, join on open ones, and the skin picker
on the home page rather than buried. Two things to do differently:

1. PULP shows "No open lobbies" when quiet, which is a dead end. Bot-seeded
   persistent worlds mean our board always has something joinable.
2. PULP does not surface any trust signal. See the trust section below.

## Game types

Two kinds of game, and the lobby treats them differently. This is the only
distinction the shell needs to understand.

**Persistent** (snake, agar). Runs 24/7. No queue. One free world and one cash
world per game per region. You buy in at any amount and that becomes your
starting worth.

**Match** (rock paper scissors, battleship, knockout, tanks). Fixed player
count, has a start and an end. You post a challenge at your stake, or accept
someone else's. Both players stake the same amount.

## Stake model

Fixed tiers are removed. Buy-in is any amount at or above a per-game minimum.

That creates one problem which must be solved for the rest of the design to
work. In a shared cash world, a player who bought in for $0.50 can kill a
player who bought in for $20 and take the lot, risking almost nothing. Today
the fixed tiers are the only thing preventing this.

**Decision: capped transfer.** When you take another player's worth, you can
only take up to what you are currently carrying. The $0.50 player who kills the
$20 player wins $0.50. The remainder is returned to the loser's balance rather
than dropped as food, so it cannot be farmed by a third party.

In other words every encounter is played for the smaller of the two stakes.
This is the poker side-pot rule. It is worth being explicit that this **changes
what dying means**: today death costs you everything you carry, and afterwards
it costs you only the amount you were matched against. That is a deliberate
change to the money model, not a side effect, and it is the reason a whale's
$20 is only ever at risk against another whale.

Consequences:

- Any stake can safely share one world, which is what makes removing tiers
  possible.
- High rollers can only be meaningfully hurt by other high rollers.
- A cheap account cannot farm expensive ones, which closes an obvious attack.
- It needs care in the money path and its own tests. This is the riskiest part
  of the whole redesign and it touches real funds.

Match games are unaffected: both sides stake the same amount by construction.

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

- `GET /api/live` returns the board: `{ worlds: [...], challenges: [...],
  matches: [...] }`, already filtered to joinable state.
- A `ChallengeBoard` service holds open challenges for match games: post,
  accept, expire, cancel. Accepting is the money-critical path and must claim
  the challenge atomically so two players cannot accept the same one.
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
2. **Stake model.** Remove tiers, custom buy-in, capped transfer. Money
   critical, needs tests before anything else depends on it.
3. **Live board and challenges.** The new front page plus the `ChallengeBoard`
   service.
4. **Brand and visual identity.** Only now, once the shape is settled.
5. **New games,** one at a time against the registry.

Visual identity is deliberately fourth. Colours and type are cheap to change;
the shape of the product is not. Doing visuals first means redoing them.

This document is the north star for all five phases. Only **phase 1** goes to
an implementation plan next. Phases 2 to 5 each get their own spec when their
turn comes, so that decisions made while building phase 1 can inform them.

## Risks and open questions

- **Capped transfer touches real money.** It changes how worth moves between
  players and must not be shipped without tests covering the cap, the refund
  of the remainder, and the third-party-farming case.
- **Cold start.** Bots cover persistent games. Match games have no equivalent,
  so private lobbies and a visible challenge board are the mitigation. There is
  no bot answer for 1v1 without it being disclosed, which would be dishonest to
  hide.
- **Minimum stake per game** is unset. Needs a number before phase 2.
- **Challenge expiry** is unset. How long does an unaccepted challenge sit
  before it is withdrawn and the stake returned?
- **Spectating** is listed as a row action but does not exist yet in either
  game. It may need to move to a later phase.
