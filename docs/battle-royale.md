# Battle Royale — the nightly event mode

A second mode for the slither.io game. Everyone gathers in one room, the owner
starts the match, the border closes in and moves, and the last snake alive takes
the night's $20.

This is the thing the Events tab has been describing. Until now that page named
a prize nothing awarded and an hour nothing measured.

## What was decided, and by whom

Owen answered these directly. They are written down because three of them are
the kind of decision that gets quietly reversed by an implementation detail
later, and one of them is a money path.

| Decision | Choice |
|---|---|
| Touching the closing border | **Instant death.** Not a damage-over-time drain. |
| Entry | **Free.** Nobody stakes anything to play. |
| Prize | **$20 from the house**, to first place only. Second and third take the placing. |
| Cash out during a match | **Disabled.** You play for the placing, not your snake's worth. |
| Start | **Owner presses a button.** If nobody has by 8:05pm Eastern, it starts itself. |

### The one caveat on instant death

I raised that a lag spike can kill you unfairly under instant death, and Owen
chose it anyway — it is his call and it is the more dramatic mode. The fix is
not to change the model, it is to make sure the model is applied to the truth:

**The border kill is evaluated ONLY against the server's authoritative head
position, never the client's predicted one.** The client already predicts its
own snake ahead of the server, so a predicted head can be over the line while
the real one is not. The existing code at `GameRoom.tick` already does this
correctly — the check lives on the server and the client only draws the ring —
and it must stay that way. The client must never kill its own snake on the
border locally, however tempting that is for responsiveness.

That removes almost all of the unfairness. What is left is honest: the wall
moved and you were too slow.

## What already exists (most of it)

The pleasant surprise is how little of this is new. The slither world is already
a circle that already kills on contact:

- `GameRoom.worldRadius` — the world is a circle, not a rectangle.
- `GameRoom.tick()` already kills a snake when `headDist >= this.worldRadius`.
  **Instant border death is already the behaviour**; it just is not scripted.
- `worldRadius` already travels to the client in the snapshot, is already
  interpolated (`game.js`), and is already drawn as a red ring and a shaded
  outside (`Renderer._drawBorder`) and on the minimap.
- The radius already moves smoothly toward a target each tick, so a shrink
  schedule has somewhere obvious to live.
- Owner-only socket commands already work and are already verified against a
  Privy token (`admin:spawnbot` is the existing proof).

So the mode is, in honest terms: **a match state machine, a scripted radius, and
a centre that can move.**

### The one genuinely new piece of geometry

The world circle is centred on world origin `(0, 0)` everywhere — the kill check,
the border draw, the minimap, food spawning. A battle royale needs the circle to
close in on somewhere that is *not* the middle. So the centre becomes real data:
`worldCx, worldCy`, defaulting to `(0, 0)` so every existing mode is unchanged.

That touches four places and no more: the kill check, `_drawBorder`, the
minimap, and food spawning.

## Phases

Each phase is shippable on its own and leaves the game working.

### Phase 1 — the zone

- `worldCx`/`worldCy` on the room, in the snapshot, and honoured by the kill
  check, the border draw, the minimap and food spawning. Default `(0,0)`.
- Verify: normal free play is pixel-identical, because the centre is still zero.

### Phase 2 — the match

- A `br` lobby type and its room, which does NOT take part in the buy-in ladder.
- A state machine: `waiting` → `running` → `over` → back to `waiting`.
- While `waiting`: everyone can join, nobody dies, the border sits at full size.
- While `running`: no new players (spectate only), and the zone follows a
  schedule of shrink → hold → shrink, each phase moving toward a new centre.
- `over` when one snake is left, or the clock runs out.

### Phase 3 — the controls

- Owner-only `br:start` over the socket, verified with the existing token check.
- The 8:05pm Eastern auto-start, server side, in real Eastern time (the same
  wall-clock reasoning as the Events countdown — never a fixed UTC offset).
- A minimum player count, so a match cannot be "won" by the only person present.

### Phase 4 — the money

- The winner is recorded server side and paid $20 from the house.
- Nothing here is client-supplied: the winner is the last snake the SERVER had
  alive, and the payout is triggered by the server, not by anything the winning
  client sends.
- Until this phase lands the mode runs with no prize on it, which is a perfectly
  good state to test in.

### Phase 5 — the page

- The Events tab shows the live state: waiting with a player count, running with
  a survivor count, and the podium seated with the real winner through the
  `V2Event.podium()` call that already exists.

## Rules that must not be broken

- **The server is authoritative.** The client draws the ring; it never decides
  who the ring killed.
- **Cash out is disabled in a BR room**, and disabled on the server, not just
  hidden in the UI. A hidden button is not a rule.
- **Free entry means no stake, so there is nothing to refund.** That is the
  whole reason free entry is the safe first version: a crashed match costs
  nobody anything.
- The prize is paid **once per match**, by the server, keyed to the match id, so
  a reconnect or a double event cannot pay twice.
