# 8 Ball Pool: the reference and our numbers

Owen's pick (2026-10-27): Miniclip's 8 Ball Pool web game at `8ballpool.com/game`, guest practice play. His two
screenshots are in `Claude Code Test/game-refs/pool8/`.

**What the reference is.** The page embeds `https://prod-web-pool.miniclip.com/mc?localmc`, which loads
`static-web-pool-production.pool.miniclippt.com/game/wasm_guest_1.0.0_73372/`: Objective-C compiled to WebAssembly,
drawn in one WebGL canvas (1154 x 768 native). Its config files (`GameConfiguration.plist`, `ValueMap.plist`) are
**encrypted**, and a scan of the running heap found only selector and ivar names, no values. So no constant could be
read from its code. Every number below is **MEASURED** from frames of the running guest build (a virtual clock
stepped one 1/60 s frame at a time, the cue ball tracked per frame by colour, 6-frame regression windows) or from
Owen's screenshot, or is **CHOSEN** where nothing could be measured. The raw notes, tracks and captures:
`side-session-notes/<dispatcher>/pool8-measure.md` and the scratchpad `p8/measure/` folder.

Nothing of theirs ships: every texture, icon, sound and font in our page is drawn or synthesised by our own code
(`public/js/pool8/p8Art.js`, `p8Sound.js`). Only layout, proportions, colours and behaviour follow the reference.

## 1. Table (`shared/pool8Sim.js`; table units: the field is 1000 long)

| What | Ours | Source |
|---|---|---|
| Play field, cushion nose to nose | 1000 x 500 | MEASURED 849.5 x 424.5 native px (2.001:1) |
| Ball radius | 15 | MEASURED 12.75 px (0.0150 L) from the rack pitch |
| Corner mouth, jaw tip to tip | 1.67 ball diameters | MEASURED 42.7 px; 45 degree jaws |
| Side mouth | 2.01 diameters | MEASURED 51.3 px |
| Corner hole | centre 16.5 past the nose corner on each axis, radius 30.4 | MEASURED 13.7/14.3 px out, 51.7 px across |
| Side hole | centre 27.7 past the nose line, radius 24.8 | MEASURED 23.5 px out, 42.2 px across |
| Foot spot (rack apex), head string (break line) | 0.75 L and 0.25 L, mid width | MEASURED 0.75 and 0.251 |
| Rack | random each game, the 8 in the middle of row 3, a solid and a stripe in the back corners | MEASURED on 4 racks (the corners rule seen on 3) |
| Diamonds | 6 per long rail, 3 per short rail | MEASURED |
| A ball drops | when its centre is over the hole | CHOSEN (the reference's capture could not be measured) |

## 2. Physics

The textbook model: a struck ball slides until cloth friction makes it roll (a centre hit rolls from 5/7 of its
launch speed, which is what the reference does), then rolls to a stop at a constant deceleration.

| Constant | Value | Source |
|---|---|---|
| Launch speed by pull | 2055 x power^1.25 units/s | MEASURED: 0.72 x drag^1.25 px/s over 5 pulls (215 to 1730 px/s), full = the longest pull seen (500 px) |
| Sliding deceleration | 783 units/s^2 | MEASURED 665 px/s^2 (4 fits, 650 to 679) |
| Rolling deceleration | 43.6 units/s^2 | MEASURED 37 px/s^2 (5 fits, 36 to 42) |
| Cushion restitution | by impact speed: 0.24 at 33, 0.42 at 86, 0.52 at 135, 0.65 at 327, 0.745 at 1013, 0.79 at 1766 units/s | MEASURED, 7 hits |
| Speed kept along a cushion | 0.8 | MEASURED 0.70 to 0.88 |
| Ball to ball restitution | 0.9 | MEASURED 0.84 to 0.94 (a full hit left the cue ball 6 to 16% of its speed) |
| Roll through a cushion | turns with the ball | CHOSEN |
| Spin: tip offset 0.5 R, side spin decay, english off a rail | | CHOSEN: the spin picker never opened in the headless guest build |
| Server aim error | 0.05 to 0.15 degrees, crypto | CHOSEN (anti-cheat, Opus review): the page runs the same physics |

## 3. Rules (`shared/pool8Rules.js`)

From Miniclip's own help and blog pages (cited in the measure notes; their help centre does not publish a full rule
page). Open table after the break; balls potted on the break keep the breaker at the table and name no group; the
first legal pot after the break names the groups (our reading: the guides do not say it exactly); fouls are no ball
hit, the cue ball potted, the wrong ball first, no cushion after contact and nothing potted, and the clock running
out; a foul gives the other player the cue ball in hand anywhere; the break is placed behind the line; you call the
pocket for the 8 (Miniclip's mid tables); the 8 in the called pocket after your group, with no foul, wins; the 8
early, in another pocket, or with a foul, loses. CHOSEN: the 8 potted on the break comes back to the foot spot (not
in official text); three timed-out turns in a match lose it (Miniclip states none; protects a paid table).
One match is one rack; the rack's winner takes the pot (Owen).

## 4. Clock and flow

| What | Value | Source |
|---|---|---|
| Shot clock | 25 s | MEASURED, the timer ring runs out in about 25 s (low to medium confidence) |
| VS cards before the break | 3 s | CHOSEN |
| Result hold after the deciding shot | the roll plus 2.5 s | CHOSEN |

## 5. Look (`public/js/pool8/p8Art.js`)

Drawn in the reference's frame (Owen's screenshot game area). Colours MEASURED from its pixels and the native
frames: felt brightest #6fb7ca to #97c6d9, mid #307b9d to #6090b0, edge #1f6181 to #2d4866; cushion #3183ae with a
#4dc4e7 nose; rail #520802 to #933429; pocket #0d0101 with a #450000 rim; room #192336; top bar #312f3b to #26242d;
slots #151519; menu button #24cc1d to #07aa01; timer ring #00ff00 turning orange near the end; aim line #eeeeee.
The aim guide: a line to the ghost ball, a white ring the size of a ball, the object ball's line 1.52 ball
diameters long (MEASURED); a red no-entry ring when the first ball is not yours (MEASURED). No cue ball deflection
line was seen on the reference.

## 6. Controls

Reference (MEASURED, PC guest build): press on the table and the cue turns to the press point, drag back along the
line and the cue pulls back, release fires; no power bar is drawn. Ours on PC: the same, plus the wheel and arrow
keys to fine-tune. Phone (Owen's ask; the reference's phone app is landscape with a power bar on the left and a fine
wheel on the right): drag on the table turns the cue, tap a ball to aim at it, the wheel on the right fine-tunes,
the power bar on the left is pulled down and let go; a phone held upright shows the table turned a quarter. Both: the
cue ball button opens the spin picker; a cue ball in hand is dragged into place; on the 8, tap the pocket you call.

## 7. Not matched (gaps)

- Spin: follow, draw and side spin could not be measured (the picker never opened headless), so their strength is
  the textbook model, not the reference's.
- The win and lose screens (the guest build covers them with a sign-up popup): ours is DuelSeries' shared result card.
- The reference's 3-ball centre icon, level stars and avatars are replaced with our own drawings and the player's initial.
