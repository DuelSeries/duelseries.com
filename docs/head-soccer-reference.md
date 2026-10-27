# Head Soccer reference: Heads Arena Euro Soccer (Poki, 2016)

Written 2026-10-27. Replaces the earlier D&D Dream "Head Soccer" reference: the owner's game is **Heads Arena
Euro Soccer** (Poki Studios), not D&D Dream's.

**Rule: no guessed numbers.** Every value below says where it came from. `UNKNOWN` means it could not be got,
with what was tried. Machine-readable copy: `docs/head-soccer-reference.json`.

## Sources

| Tag | What | How |
|---|---|---|
| **S** | The game's own code: `game.min.js` (153 KB, BUILD_TIMESTAMP 1466667007676 = June 2016), Phaser 2.4.2 with P2 physics, plus its `assets/data/config.json` and the hd sprite atlases (`assets/sprites/hd/*.json`) | Found through the embed at papajogos.com.br: `games.poki.com/822223/headsarenaeurosoccer` frames `https://5dd29b99-015f-11ea-ad56-9cb6d0d995f7.gdn.poki.com/1e942d4f-1d4c-4f04-9af3-8d992117cd15/index.html`. Fetched with node (Referer header) into the scratchpad, never into the repo. Identifiers below are its class and field names. |
| **L** | Its running physics world, read live | The mirrored files served locally to headless Chrome (the CDN's Cloudflare blocks a direct browser visit); a Solo Normal match started with `Game.game.state.start("GameState", ...)`; every p2 body's shapes, positions, materials and the world settings read from `Game.game.physics.p2`. |
| **M** | Measured by stepping it | The same headless game, with its `gameplayHandler.update` hooked to record bodies every step while scripted moves, jumps, kicks and drops ran. |
| **A** | Its art, measured | The hd atlas PNGs drawn to a canvas and scanned pixel by pixel (colour runs along rows and columns), placed where its code places each sprite. Layout and colour only: no art is copied. |

Poki's own page for the game now redirects to its category page (the game "has moved"); the papajogos embed still
serves the build above.

## Units

Its frame is **1920 design units high** at any screen size (S: config.json `workingHeight` 1920; `Game.scale(v) =
imageScale * v`, so a value v in its source is v design units; the hd atlas is drawn at imageScale .45). Its width
follows the window's ratio, clamped to 4:3 .. 2.29:1 (S: `minRatio` .4375, `maxRatio` .75): 2560 to 4389 units. Our
`shared/hsSim.js` uses these units directly, with x measured from the halfway line and y down from the top.

## Physics (all S unless marked)

| Thing | Value | Source |
|---|---|---|
| Engine | P2, fixed step 1/60 s, 10 solver iterations | L: `p2.frameRate`, `useElapsedTime` false, `world.solver.iterations` |
| Gravity | 1600 units/s^2 | `_setupPhysics`: `p2.gravity.y = Game.scale(1600)`; L: 1600 |
| Extra pull on players | 2000 units/s^2 (so 3600 in all) | `Player.update`: `data.force[1] -= Game.scale(1E4)` on mass 100 |
| Contact friction | .3 (default material) | `defaultContactMaterial.friction = .3`; M: a released run loses about 8 a step beyond damping (480/s^2 = .3 x 1600) |
| Ball | circle r 46, mass 2, damping .1/s | `setCircle(.45 * sprite.width)` (ball-front 92 px x .5 / .45); L: r 46, mass 2, damping .1; M: rolling 984 -> 967 in 10 steps |
| Ball restitution | grass .8, goals .6, players .3, top wall 0 | `createContactMaterial(...).restitution`; bounds use the default material; M: 1568 -> 1247 off the grass |
| Ball spin | barely turns: .47 rad/s rolling at 984 | M (it slides rather than rolls) |
| Player body | head octagon 140 wide from -100 to +50, legs 40 wide from +50 to +150 (body centre to soles 150) | `_playerPolyRaw` x body.width x 2; L: exact vertices |
| Player mass, damping | 100, .5/s, fixed rotation | `body.mass = 100`, `damping = .5`, `fixedRotation` |
| Run | velocity set to 1000 every step a key is held; let go: x .6 each step | `_moveSpeed Game.scale(1E3)`, `update`: `velocity.x *= .6` when not moving; M: 16.35 units a step running |
| Jump | velocity.y = -2000; 2 jumps (one from the ground, one in the air) | `jump(Game.scale(2E3))`, `_jumpLimit 2`; M: -2000, -1917, ... |
| Ground | set when a contact begins with the pitch body (any face, so touching a step's wall gives the jumps back) or with a grounded player | `_setupCollisions` onBeginContact |
| Kick | reach 270 from the body centre to the ball's sprite corner (ball centre - (51.1, 50)); angle = atan2 to that point + .2 PI if grounded (sign by facing); ball velocity (sin a x 2900, cos a x 2900 x .7) | `kick`, `getKickAngle`, `_ballKickDistance`, `_kickForce`; M: (150,-50) -> (437, -2007), (200,0) -> (1682,-1654), (-150,-50) -> (-2860, 337), all within 3 of the formula |
| Kick timing | boot tween 200 ms + 200 ms before the next kick | `_kickTime`, `_kickDelay` |
| Pitch | sunken pitch top y 1471.8 between x +-950; 40-unit chamfers; step faces at +-990; shelves at y 1181.8 from +-1030 to +-1280 | `FieldDrawer.drawArenaOnBody` with `_fieldSize 1980`, `_fieldDepth 290`, `_cornerSize 40`, `_goalAreaSize 250`; L: exact convex pieces |
| Nets | walls, inner face x +-1214.2, full height | `Goal.net` (sprite width x 8 frames tall); L |
| Crossbars | 355.6 x 40 boxes at (+-1197, 752.2), tilted 12 degrees down toward the pitch | `Goal.bar`; L |
| Goal | ball centre past x +-1044.2 with y between 755.2 and 1259.2 | `Goal.isInGoal` (sprite.x -+ .5 width; sprite.y - .4 height .. sprite.y) |
| Kick-off spots | players at x +-495, dropped from y 1082.2; ball dropped from (0, 576) drifting (left score - right score) x 5 units/s | `startGame`, `getPlayerStart`, `ball.setStart` |

**Not symmetric in the reference:** its kick aims at the ball sprite's top-left corner for both players. Ours
mirrors that corner for the right seat so neither seat kicks differently (a money duel must be fair).

## Rules and clock (S)

| Thing | Value | Source |
|---|---|---|
| Match | 60 s of play shown as 90 game minutes (1.5 game minutes a second) | `Timer`: `_timeLimit 90`, `_actualTimeLimit 60`, +1.5 game seconds every 1/60 s |
| Clock | "MM:SS" of game time on the board, counting up 00:00 -> 90:00; stops during goals, breaks and countdowns | `_getDisplayTime`, `pause()` on goal |
| Countdown | 3, 2, 1, 0, one every 600 ms (the first 600 ms after the call), play starts at the 0: 2.4 s; the ball is already falling and nobody can move | `GameUI.doCountDown`, `disableInput` |
| Goal | input off, clock paused, GOAL! for 3 s, then back to the spots and the countdown | `GameplayHandler.update` goal callback, `_goalTimeout 3E3` |
| Half time | at 45:00: whistle, "Half time", input off, 3 s, then the kick-off countdown. Sides do not swap | Timer halftime callback, `_doHalfTimeAdCall` (the ad is skipped here) |
| Full time | at 90:00: level -> GOLDEN GOAL call, 2 s, kick-off with a golden ball, clock stays at 90:00, next goal wins (no time limit); else the score rises to the middle for 3 s | fulltime callback, `goldenGoalKickoff`, `endScreen` |
| Power shots / specials | none in the game (a "Will Grigg's on fire" cheer effect for one character only) | whole source |

## Its CPU (logic.AIControls, S)

Levels: easy 1, medium 5, hard 9 (`AILevels`); the solo CPU is the "attacker" role (easy plays the "idiot" role).
Per step: re-read the ball's landing every 10 x (10 - level) steps (`_bufferBallPositionForSteps`); stand .55 x 270
behind the ball toward its own goal (`_maxKickDelta`) within half that; near the ball (a third of the screen width)
go to where it lands, otherwise to the ball; jump every step the ball is .75 to 2 jump distances (150) above it;
when in line, kick after an "average shot" check that skips the kick only if it would send the ball toward its own
goal (`_estimatedShot`, using its own rough `getTrajectory`). Level 6+ also runs back for balls heading into its own
goal; 9 uses a "perfect shot". **Our bot is this at medium (5).**

## The look (A, positions from S)

| Thing | Value |
|---|---|
| Sky | gradient #72a0da (top) .. #b8d5f8 (y 913 down); a cloud strip (#b6def4, tops near y 351) scrolling right at .2 px a frame (26.7 units/s) |
| Roof | arch, top y 548 at the middle, 568 at x 667, 725 at x 2001; light band #acb8d3 (66), darker #8b9abb (102) with struts |
| Board | slate panel x -324..324, y 63..368 on two posts (x +-203..245); digits right-aligned at x -163, -40, 130, 253, centred y 230; colon at x 0, y 185..208 and 230..252 |
| Crowd | from y 684 (sprite at H/2 + 130), 5 frames cycling every 1 s, every 0.1 s for 4 s after a goal (`Crowd.setTempo`) |
| Stand front | #bec8dd 1245..1263, #acb8d3 1263..1370, grass #76a75d from 1370 |
| Pitch art | far edge y 1415, near edge 1593, front face to 1649; back line y 1422..1430 (x +-890), front line 1560..1571 (x +-980), centre ellipse (0, 1491) 278 x 49, spot (0, 1489) |
| Shelves | top face y 1120..1235, edge to 1249, front face to 1638, side face x -1038..-941 (#76a75d) |
| Greens | #93c47a, #a3ce8e, #96c280, faces #80b366, lawn #8bbc72 |
| Goals | front post x 1084..1120 from 788 to 1237; back post 988..1022 from 752 to 1136; floodlight tower 1130..1290 from 3 to 730 with a glass panel; front pole 1277..1308 to the grass (right goal; left mirrored) |
| Score plate | 878 x 176 at (0, 1795): side bar 1736..1854 (#465778, rim #8b9abb), centre box +-248 (#3f4f6c inside #677a9e); ball icons at +-385 (60 across); win counters at +-340; score "0 - 0" size 120 at y 1785. Hidden until the first countdown ends |
| Pause | green round button r 100 at (right edge - 100, 100): #60a241, cream ring #ffeddf |
| Key hint | blue (#0155dd) up / left / right keys and a SPACE bar, at (-1100, 1790), .9 scale, .8 alpha, desktop only |
| Phone | four 400 x 350 touch zones along the bottom: left, right from the left edge; kick then jump from the right edge; buttons 269 across |
| Words | countdown size 170 at the middle; GOAL! 2487 x 776 graphic: a copy grows up from the pitch (700 ms) while the big one drops from -600 to 400 (500 ms), shakes, flies off (1 s); HALF TIME fades in growing, holds, fades out |
| Players | head image -102..+94 around the body centre, boots at (32.5, 130) and (-22.5, 130), hands at (87.5, 85) and (-97.5, 85), mirrored by facing; the head turns to the ball; the back boot kicks (jumps to the ball, eases home in 200 ms, 1.5x, turned 60 degrees); boots circle while running (30 across, 15 up, steps/3) |

Their players are caricatures of real footballers. Ours are our own cartoon characters.

## Ours versus theirs (deliberate)

- **Golden goal safety stop:** theirs has none. A money match must end, so 5 minutes level in golden goal stops as
  a draw with each seat refunded (the rule this game already had).
- **Kick aim mirrored per seat** (above).
- **Pause:** an online match cannot pause, so the button (and Escape) asks "Leave the match?" and leaving is the
  existing leave (it forfeits, as walking out always has).
- **Names** of both players small over the plate's ends, and a YOU marker at the opening countdown.
- **Header sounds:** theirs makes no sound for a ball off a head; we keep a soft one.
- Cheering and sad faces after a goal are drawn; their cheer also makes the scorer hop (physics), ours does not.

## UNKNOWN

- **Mobile button art and colours** (`mobi-*` sprites): not scanned; ours are white translucent circles.
- **The bitmap fonts' exact glyph shapes and widths** ("normal", "digital-time"): not measured; ours are Archivo
  900 and drawn seven-segment digits sized to the measured digit positions.
- **Sound timbres:** their wav files were not analysed; ours are the house synth sounds mapped to the same moments.
- **Exact crowd figures, stair positions and roof struts:** approximated from the art sheet (aisles near x +-667).
