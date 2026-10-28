# 8 Ball Pool: the reference and our numbers

Owen's pick (2026-10-27): Miniclip's 8 Ball Pool web game at `8ballpool.com/game`, guest practice play. His two
screenshots are in `Claude Code Test/game-refs/pool8/` (`owen-vs-screen.webp`, `owen-table-break.webp`, both
2000x1247 browser captures).

**What the reference is.** The page embeds `https://prod-web-pool.miniclip.com/mc?localmc`, which loads
`static-web-pool-production.pool.miniclippt.com/game/wasm_guest_1.0.0_73372/`: Objective-C compiled to WebAssembly
(cocos2d style, `game.wasm` + `game-data.js`), drawn in one WebGL canvas. Its config files
(`GameConfiguration.plist`, `ValueMap.plist`) are **encrypted**, and a scan of the running heap found only Objective-C
selector and ivar names (`getPocketRadius`, `mMinPowerRatio`, `setTurnProgressForPlayer1WithTime:turnTime:`), no
values. So no constant could be read from its code: every number below is **measured** from frames (Owen's
screenshot or headless captures of the guest build) or **CHOSEN** where nothing could be measured, and says which.

Nothing of theirs ships: every texture, icon, sound and font in our page is drawn or synthesised by our own code
(`public/js/pool8/p8Art.js`, `p8Sound.js`). Only layout, proportions, colours and behaviour follow the reference.

## 1. Table geometry (table units: the field is 1000 long)

| What | Ours | Source |
|---|---|---|
| Play field (cushion nose to nose) | 1000 x 518.6 | MEASURED, Owen's screenshot: felt x 746..1554, y 478..897 (808 x 419 px) |
| Ball radius R | 14.9 | MEASURED, Owen's screenshot: rack rows 21 px apart across (2R cos 30), 24 px apart down (2R) on the 808 px field |
| Rack apex (foot spot) | x 0.75 L, centred | MEASURED, Owen's screenshot: apex at x 1345 = 0.741 L |
| Cue ball start / baulk line | x 0.25 L | MEASURED, Owen's screenshot: cue ball and the faint vertical line at x 955 = 0.259 L |
| Rack order | 1 at the apex, 8 in the middle of row 3, a solid and a stripe in the back corners | CHOSEN (the 8-ball racking rule); see section 7 for the reference's order |
| Corner mouth, side mouth | 2.2 D, 2.0 D (jaw tip to jaw tip) | CHOSEN, see section 7 |
| Pocket holes as drawn | 24 and 22 design px | MEASURED, Owen's screenshot |

## 2. Physics (ours: `shared/pool8Sim.js`)

The textbook model of pool: a struck ball slides until cloth friction makes it roll (a solid sphere's slip falls
7/2 as fast as its speed), then rolls to a stop at a constant deceleration; side spin decays on its own; ball to
ball hits exchange the normal speed with restitution; a cushion returns the normal speed with restitution and grips
the slip along the rail, which is what makes side spin change the angle. Top spin makes the cue ball follow after a
hit and back spin draws it back, both from that same slide-then-roll friction, with no special case.

| Constant | Value | Source |
|---|---|---|
| Full-power cue ball speed | 2600 units/s | CHOSEN, see section 7 |
| Rolling deceleration | 60 units/s^2 | CHOSEN, see section 7 |
| Sliding deceleration | 700 units/s^2 | CHOSEN, see section 7 |
| Ball restitution | 0.94 | CHOSEN, see section 7 |
| Cushion restitution | 0.78 | CHOSEN, see section 7 |
| Furthest tip offset | 0.5 R | CHOSEN |

## 3. Rules (ours: `shared/pool8Rules.js`)

Miniclip's 8 ball, as section 7 cites. Open table after the break; balls potted on the break keep the breaker at
the table but name no group; the first legal pot after the break names the groups; a foul (no ball hit, the cue
ball potted, the wrong ball first, no cushion after contact and nothing potted, the shot clock running out) gives
the other player the cue ball in hand anywhere; the 8 potted on the break comes back to the foot spot; you call the
pocket for the 8; the 8 in the called pocket after your group, with no foul, wins; the 8 early, in another pocket,
or with a foul, loses. CHOSEN: a third timed-out turn in a row loses the match (protects a paid table from a
player who walked away).

## 4. Shot clock and match flow

| What | Value | Source |
|---|---|---|
| Shot clock | 30 s | CHOSEN, see section 7 |
| VS cards before the break | 3 s | CHOSEN |
| Result hold after the deciding shot | 2.5 s after the balls stop | CHOSEN |

## 5. Look (ours: `public/js/pool8/p8Art.js`)

The game is drawn in the reference's own frame: the game area of Owen's screenshot, 1066 x 710, origin at its top
left (x 617, y 268 of the 2000 x 1247 capture). Positions MEASURED from that screenshot: top bar 0..110; field
129..937 x 210..629; rail 99..968 x 180..659; ball-return rail at x 990..1024, y 296..620; menu button 11..67;
name plates and seven slots at 140..378 and 688..926; avatars at 393 and 591 (82 square), the middle tile at 491;
spin button centre (1026, 54), radius 33; the message box centred low at y 690; the grey hint at y 132.
Colours MEASURED from the same pixels: felt centre #97c6d9, felt mid #6090b0, felt edge #2d4866, cushion #5080b0,
rail #7a271d (light #87392f, dark #4e1006), rail edge #401000, room #1a2033, top bar #2b2a33 to #383642, slots
#17161b.

## 6. Controls

PC: the cue follows the mouse; press, drag back and let go (the power is the distance dragged back); the wheel and
the arrow keys turn the aim finely (Shift for coarse). Phone: drag on the table to turn the cue around the cue ball,
tap a ball to aim at it, the strip at the right edge turns it finely, and the power bar on the left is pulled down
and let go. Both: the cue ball button opens the spin picker; a cue ball in hand is dragged into place; on the 8,
tap the pocket you call (it defaults to the pocket your aim sends the 8 toward). A phone held upright shows the
table turned a quarter, like turning the phone.

## 7. Measured from the running guest build

(Filled in from the headless capture work: `side-session-notes/<dispatcher>/pool8-measure.md`.)
