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
| Ball spin | spins up to rolling over a long roll (an early short sample read .47 rad/s at 984 and was wrong) | M, physics check 2026-10-27 |
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

- **The clock (Owen 2026-10-27):** one 2-minute match, the board counting DOWN 2:00 to 0:00 in the same digits, no half
  time (theirs: 60 s shown as 00:00 to 90:00 with a half at 45:00).
- **Golden goal lasts one minute (Owen 2026-10-27):** level at 0:00 is golden goal, the next goal wins, with the board
  counting that minute down 1:00 to 0:00 and a SUDDEN DEATH call; still level after it is a draw, each seat refunded its
  own stake (theirs has no limit). Proved on the real server at $0.50: test/rungFiftyMoney.test.js.
- **Kick aim mirrored per seat** (above).
- **Pause:** an online match cannot pause, so the button (and Escape) asks "Leave the match?" and leaving is the
  existing leave (it forfeits, as walking out always has).
- **Names** of both players small over the plate's ends, and a YOU marker at the opening countdown.
- **Header sounds:** theirs makes no sound for a ball off a head; we keep a soft one.
- Cheering and sad faces after a goal are drawn; their cheer also makes the scorer hop (physics), ours does not.

## The look, measured for the 1:1 replica (2026-10-27)

Owen asked for an exact visual replica. Each slice was redrawn by hand in code and checked against the reference at
1366x768 (its hd assets) with the same game state: ours rendered from the reference's own display list and state, then a
per-cell colour difference. Whole-frame mean difference went from 21.3 to about 11 (kick-off and mid-play). No image, font
or sprite of theirs is used; the faces are invented. The measurement notes below give every value and its source
("atlas px" are pixels of its hd sprite frames; tools named in them were scratch scripts, not in the repo).

### Stadium: sky, clouds, roof, stands, crowd (public/js/headsoccer/hsScene.js)

Frames: ref-frames/level--bg-back, level--bg-front, level--tribune, character--crowd-1..5. 1 art px = 2.2222 units (1/.45).
Frame px -> world: tribune x = -2194.4 + px*U, y = 61.1 + py*U (S: sprite at H/2+30, 1975x836, display list y 61.1);
crowd y = 684.4 + py*U (S: H/2+130, display list); bg-back y = -200 + py*U; bg-front y = 200 + py*U. Frames are mirror
images about px 987.5 (block edges, struts, aisles checked both sides).

#### Sky (bg-back, 12 flat colours, histogram)
- top #72a0da; wavy bands below: #7ba8de mean -66, #84aee3 17, #8bb4e6 111, #92b9e9 190, #98beec 276, #a0c3ef 341: edge = per column count of rows above the level, mean + 2 strongest Fourier terms over the 4389 tile (DFT of the edge profile, k/amp/phase in code)
- flat: #a7c8f2 from 420 (py 279), #adcdf5 526.7 (327), #b2d1f6 642.2 (379), #b5d3f7 762.2 (433), #b8d5f8 913.3 (501): column runs
- 3 lens streaks: connected components of one colour inside another (x range, centre y and thickness at fifths measured)
- tile origin = screen left (S: tileSprite W x H at W/2)

#### Clouds (bg-front)
- colour #bae0ff: only colour in the frame (99.9 %); also sampled on the ref screenshot. The doc's #b6def4 is wrong.
- solid below y 796 (max of per-column solid top); tile 4389, .2 px/frame (S)
- cover per 50 units from 200: ref 4 13 24 37 47 56 67 73 82 92 94 99 %; ours 3 10 23 29 41 56 64 73 83 88 93 98 % (puff
  generator tuned to this target in a node mimic: s-work/cloudtune4.js; shapes are ours)
- 7 detached blobs: connected components of the alpha, boxes (tile x, top, w, h) in code. Big one drawn as a tilted pair (shape by eye)

#### Tribune (roof / bowl / rim): ellipses centred x 0, fitted to class boundaries per column (s-work/fitbands2.js, fitell.js)
- roof top #acb8d3 [1628.9, 3640, 1080] (err mean .57 max 1.5); underside #8b9abb [1885.7, 3640, 1270]; dark #677a9e [1337.6, 2860, 680];
  beam #acb8d3 [1844.9, 3440, 1140]; back wall #7b8aac [1925, 3480, 1190]; bowl #8b9abb [1558.2, 2740, 750] (max 2.5)
- rim #bec8dd [1561.7, 2040, 315] (top 1246.7); face #acb8d3 +16.4 (fit top 1263.1); grass #76a75d +124.2 (fit 1685.9), cut at py 800 = 1838.9; frame bottom py 836
- posts: centres px 987.5, 796.5, 590, 393.5, 249, 82.5 (row runs), 16 px wide, #8b9abb, round foot 17.2 above the beam foot (columns 796, 393)
- struts (traced top..foot, s-work/strut.js): S1 438..453 @py345 slope .353 foot 505; S2 214..229 @380 slope .745 foot 496; S3 142..161 @400 slope .8 foot 497; centre 979..995 py 297..533
- aisle walls: outer 648..663 @319 -> 679..694 @540; inner 729..744 @319 -> 754..769 @537; 16 px
- stairs (column 705): landing #677a9e py 346..361 (stops 11.7 px short of inner wall, row 352); treads #96a6c5 at py 363-376, 387-390, 401-404, 415-418, 429-431, 443-445, 457-459, 471-473, 485-487, 498-501, 512-515, 526-529; risers #7b8aac; stringer 8 px #8b9abb with a 1 px #677a9e line 3.5 px from the wall (row 450)
- small side stair (rows 405..486): rail points and 3 step quads in code (row runs)

#### Crowd (character--crowd-1..5)
- 5 frames, S order 1 2 3 4 5 4 3 2 (Crowd._crowdFrames) -> exported CROWD_ORDER; hsArt still cycles 0..4 linearly (lead: use CROWD_ORDER)
- bob: block matching 12x12 patches frame 1 -> 2..5 (s-work/bob2.js): top trajectories [0,4,0,-4,4] 70, [0,-4,0,-4,-8] 68, [0,-4,0,4,-4] 56, [0,4,0,4,8] 55, [0,-4,0,4,0] 52, [0,4,8,4,4] 41
- blocks: outlines from per-row opaque runs of all 5 frames (s-work/rowruns.js), 4 a side; C middle, L3, L2 (notched by S2), L1 far
- grid: C front-row first fan (775, b 247), step 26.8 px, rows 22.9 px (face tops 19 -> 225 over 9 rows), 10 rows x 8; stagger 10 px (row 9 vs front); L3 a (518,252.6) u (21.2,-1.7) v (-4.1,-20.4); L2 a (331,282) u (22.6,-4.4) v (-8.1,-19.3); L1 a (65,342) u (23.4,-7.3) v (-4.5,-18.5) 11 rows
- side-block size .8: mean of face width, column pitch and face height ratios (L3 .80, L2 .81, L1 .79)
- jitter 1.5 px: row residual spread ~1.2 px (row 1 positions vs a straight row)
- fan (front row, column/row runs): face 19-20 px wide at b-14, 7-11 px at b-7, chin b-4; neck 3-4 px; shirt 17-18 px wide; hair top ~b-29.5, fringe to b-22 mid, b-16 sides; caps 21-24 x 12-15 (median 22.8); spikes 20 x 19; mops 38 x 33 centred b-20; long hair strands 8 x 11 beside the jaw
- palettes: skin #bea9a0 75, #635046 42, #88715d 18, #a39884 19 (face components in C1+C2); shirts #767998 21.7, #5b8d78 15.6, #8d69af 12.8, #b1ac76 12.8, #af6a67 12.1, #7279a3 10.8, #803f47 7.8 (front row shirt band %); hair styles by component counts big 34, spiky 32, cap 47, long 22; colours within style by whole-frame share
- check (screen, 3 crowd regions): ref skin 34.5 shirt 8.1 mops 21.4 other hair 27.6 bg 8.5 lum 117; ours 34.4 / 8.5 / 20.2 / 24.6 / 12.3 / 120
- no outlines, flat colours (108 colours in the frame, no outline colour)

#### UNKNOWN / chosen (not measured)
- shirt length (only known < 16 px: rows behind never show below the front faces); used 14
- the arrangement of individual fans (ours: staggered rows + bob + jitter; per-pixel floor: their own crowd shifted by half a fan vs itself = 38-48 mean diff in the C1 region, ours vs theirs 47)
- look pool of 64 (performance choice; their art also repeats: block C2 is C1 shifted 242 px)
- mop lobe count (10) and spike count (6 tips); front-row arm lines (1-2 px) not drawn
- back wall panel steps between struts (smooth ellipse used; crowd covers them)
- E-panel bits left of S3 (wide screens only) not drawn
- cloud puff shapes (procedural, tuned to measured coverage); big loose blob split by eye

#### Cost (headless Chrome, software canvas)
- stand layer (tribune + crowd) ~65 ms steady at 1366x768, ~130 ms at 1920x1080; one-time fan sheet ~65 ms; old code ~115 ms a layer

### Pitch, grass blocks, chalk, goals, nets, towers (hsPitch.js)

Units: hsPitch draws each sprite in its own atlas pixels (transform translate(sprite x, y) + scale 20/9).
Sprite origins from cmp/ref-pc-kickoff.json: field x -2194.4 y 1082.2 (1975 x 377 px); goal-back x 985.6 y 3.1
(184 x 554); goal-front x 1044.2 y -0.8 (160 x 567); left goal = mirror (sx -1). Field is 98.3 % mirror-symmetric
about px 987.5 (measured, sym.js), so one half is drawn and mirrored.
Tools used (scratchpad/f/): lr.js (palette runs), track.js (stripe-edge line fits), prof.js / aprof.js (tuft and hole
counts, widths, heights), acorr.js (hex mesh period), cmap.js/cmap2.js (letter maps), sbump.js (stripe-edge bumps).

#### Field (level--field.png, atlas px)
- Palette (whole sprite histogram): L #a3ce8e, m #96c280, p #93c47a, k #8bbc72, f #80b366, s #76a75d, chalk #fcfff7,
  chalk rim #dee4db. Nothing else (one #bec8dd pixel).
- Heights: block top far edge y 17; block top/front boundary 81; pitch far edge 150; pitch top/front 230; lawn top 255;
  bottom 377 (columns 10, 100, 300, 450, 560, 620, 750, 987 runs).
- Lawn stripes (k base, m stripes; k in the middle), fitted lines x@257 -> x@376: 199->46, 370->268, 568->485,
  684->621, 807->756, 928->904; leftmost m|k edge 20@256 -> 3.5@264 (extrapolated off-sprite).
- Pitch front face (y 230..255) vertical f/k edges: 568.3, 683.7, 805.9, 926.6 (track.js rows 232..249).
- Block fronts (y 81..255) vertical k/f edges: 20, 200, 370; side face from 517.
- Pitch top (p base, L stripes) fitted lines x@158 -> x@214: 614.4->580.6, 723.7->690.6, 833.3->816.7, 940.0->929.1.
- Block top (L base, p stripes) x@18 -> x@74: 130.2->31.2, 289.9->206.8, 448.6->374.9, 552.4->502.9 (last = bevel band).
- Side face s: (517,100) (571,32) (571,141) (517,207) from per-row s runs (rows 36..204); block top far corner r 10.
- Pitch bevel band right edge (581,150) -> (528,229) from L runs rows 150..228.
- Chalk: back line W rows 154..156, rim d 153/156, x 589..1388; front line W 217..221, rim d 216/221, x 546..1427.
  Centre circle = circle r 103 stroke 15 squashed 0.184, centre (987.5,185.5) (strokes: top W 165..167, bottom
  203..205, ends 877..892 horizontal); tails to x 862 / 1113 rows 182..188; spot ellipse (986.5,182.5) 14 x 3.5.
- Tufts (clusters of round-tipped blades 5..7 px wide; count per length, width min/median/max, height min/median/max):
  block top far edge 11/556 px, 6/9/23, 4/9/17 (colour p); block front top edge 16/516, 5/15/21, 5/10/16 (front stripe
  colour); block front stripe edges 5/163 rows, 6/8/15, 3/5/6 (inner stripe into outer); front into side face at 517
  4/106, 5/7/15, 4/5/6; side face far edge 5/131, 6/9/15, 3/5/7; pitch far edge 25/826, 3/11/23, 3/8/18 (local stripe
  colour); pitch front top edge 35/936, 4/7/26, 2/7/10; lawn top edge 70/1975, 3/7/15, 2/6/9 (lawn stripe colour);
  stripe edges ~3 per 120 px, 6..10, 2..7 (sbump.js); back chalk 13/796, 1/3/5, 2/2.5/3; front chalk 19/871, 2/4/12,
  2/3/6. Circle rim bumps: ~1 per 40 px of rim (rows 162..164, 206..208), 3..12 x 2..4 -- count APPROXIMATE.

#### Goal-back (level--goal-back.png, atlas px)
- Tower pole x 64.5..78: #7b8aac left, #677a9e core 70..74, #96a6c5 rim at 77; down to the base bar (502).
- Emblem box x 64.5..134, y 0..50.5 (foot slants to 47.5 at x 134), #677a9e; inset frame #48597a x 77..80, 128..131,
  bottom bar (77,42..45.5) -> (131,39.5..42); foot line #48597a.
- Ball: outline x 85..119 y 2..36 (#48597a ~2 px); #3f4f6c patches x 93..102 y 6..14, x 106..115 y 17..27,
  x 89..98 y 23..31 plus rim-cut ones top right (108..115, 3..10), bottom (103..111, 32..36), left (85..88, 12..20).
- Glass x 78..136, y 51 down to the plate: base #b3d6f7 a137, streaks #dbf3fd a129 (replace the base, not over it),
  streak slope dy/dx -1.35 (cols 82..130), spans along x 100: 54-80, 110-114, 133-155, 168-187, 201-224, 228-231,
  271-280; grey top shadow #8ea1a6 a143 rows 51..53; right rim #bde7ed a33.
- Plate: top edge (78,279) -> (136,298) (rows 283..296), bottom (64.5,321) -> (136,345); light rim #8b9abb under the top
  edge; inset frame #48597a; right side #48597a x 131..134.
- Bolts on the pole's right side at y 68, 117.5, 170, 218.5, 263, x 77..84, 11 px tall at the pole.
- Back post x 0..15: W 1..6, d 7..12, W 13 (rows 400..440); top outer edge y 331.
- Base bar rows 502..505 W, 505..511 d, x 0..118; joint W x 46..52, d 54..58, W 60. Grass holes in its bottom edge:
  5 per 119 px, 5/6/12 wide, 3/4/5 high (aprof.js).
- Back net: hex flat-top, side 6.35 px (autocorrelation periods x 19, y 11), a cell centred (31, 381.5); lines #b3d6f7
  a137 (anti-aliased with #b7def4 a186, #c0e7f4 a80, #bde7ed a33).
- Side frame line #a0c3ef: (16,331) -> (69,320) -> (78,336) -> (112,500).
- Side net right of that line: same cell, sheared: flat edges slope +0.6, columns along (0.2, 1.15) (from the zoom);
  greyer below y 505 (#8ea1a6 a143 / #91a689 a76). Outline (70,322) (100,328) (130,343) (170,478) (178,505)
  (184,516) (184,554) (180,554) (112,500). Shear factors read from the zoom image: APPROXIMATE.
- Roof (white mesh) quad (6,333) (69,320) (79,337) (37,351); mesh scale along its edges: APPROXIMATE.

#### Goal-front (level--goal-front.png, atlas px)
- Pole x 105..120: 105 #96a6c5, 106..107 #8b9abb, 108..113 #677a9e, 114..118 #48597a, 119 #677a9e; full height.
- Bolts on its left: centres y 69.5, 122.5, 180.5, 232.5, 282; x 100..105; 9 px tall at the pole; #48597a / #677a9e.
- Front post x 18..33: W 18..25, d 26..31, W 32, w 33; vertical from y 362; elbow + side bar up-left, 16 px thick,
  shaded band on its upper side (rows 349..366); bar continues the line to the back post's elbow.
- Base bar W 545..551, d 551..558, x 18..158; holes 7 per 140 px, 4/6/13 wide, 2/3/5 high.
- Front net: hex flat-top side 7.67 px (periods x 23, y 13.3), a cell centred (42, 375.6); #f9fbf2 a178 1 px lines
  (anti-aliased #dbf3fd a129, #c0e7f4 a80, #bde7ed a33); right of the pole to the side line (120.5,402)->(157,546) W 2 px.
- Roof: parallelogram front (33,365) -> (104,350), depth to (5,348) / (73,334); its front edge W ~2 px; the mesh is the
  same hexes, ~3.5 cell rows deep (counted on the zoom). Line alpha .88: APPROXIMATE (their roof lines are mostly
  opaque #fcfff7 with #f9fbf2 a178 edges).

#### level--frame0..6
BallReflect (game.fmt.js ~line 1033): a hex-mesh ripple ring, 85 x 185 px, shown at the goal sprite's x and the ball's
contact y when the ball touches the invisible net wall (net.body.onBeginContact), frames 0..5 every 66 ms then hidden.
It DOES draw in a match (on net hits). Not painted by hsPitch (static layers); needs a per-frame effect in hsArt.

#### Physics vs art
No disagreement: the art sits where their sprites sit, and hsSim's edges were read from the same reference. The block
side face spans x -1045.5..-925.5 (centre -985.5 ~ FIELD_HALF 990); the roof front edge slopes 12.2 deg (BAR_DEG 12).
The drawn surfaces are perspective faces: block top 1120..1262 around SHELF_Y 1181.8, pitch top 1415.5..1593.3 with
PITCH_Y 1471.8 inside it (their own collision line, not the drawn edge).

### Players and ball (hsChars.js)

Units: "atlas px" = one px of the hd atlas frame. Sprites are drawn at imageScale .45 and sprite scale .5, so
1 atlas px = 0.5 / 0.45 = 1.111 world units (U). Checked against the display list: pogba-head 131 x 187 px shows as
145.6 x 207.8 units (ref-pc-kickoff.json).

#### Sizes and placement (display list + source)
- Head frames: seat 0 = 131 x 187 (pogba-head), seat 1 = 132 x 167 (griezmann-head); anchor (.5, .8) at body (0, 55): S Player `_head.anchor.set(.5,.8)`, `_headRelativePosition (0,110) x .5`. Display list: pogba head top = y - 111.2, griezmann = y - 93.4 (matches).
- Hand-back 73 x 62 at (87.5, 85), foot 71 x 59 at (32.5, 130) and (-22.5, 130), hand-front 66 x 66 at (-97.5, 85): S `_leftArmRelativePosition (175,170)`, shoes (65,260) / (-45,260), arm (-195,170), all x .5; frame sizes from ref-frames.
- Draw order: hand-back, front boot, head, kicking boot, hand-front: S add order (leftArm, leftShoe, head, rightShoe, rightArm) and the display list order. (Old code had the hands swapped.)
- Head faces the ball: `lookAtPosition` scale.x = ball.x > x ? + : -.
- Jump: boots +47 and +50 deg x facing: S `jump()` tweens. Display list griezmann in air: rot -0.82 rad (= -47 deg, facing left).
- Kick: kicking boot angle set to 60 deg (NOT mirrored) and eased back to its old angle over the kick, Quadratic.Out; 1.5x scale; position from the body-relative target: S `kick()`. Fixed: old code multiplied the page's kdx (already body-relative, x facing) by facing again, so a left-facing kick swung the boot backwards.
- Ball: back 86 x 86 (95.6 units), front 92 x 90 (102.2 x 100); back never turns, front turns with the body: S ball update sets `_spriteFront.angle = body.angle` only.

#### Colours (sampled from ref-frames, exact hex)
- Outline everywhere #440201; softer inner line #571813 (also #4c0c09 AA): head/foot/hand frames.
- Outline width: silhouette ~2.5 px (rows: griezmann-head y40 x7..9, y90 x0..2), inner lines ~2 px. Ours: 2.5 to 2.7 silhouette, 1.4 to 2.2 inner.
- Dark skin #75504c, shade #5d473d, deep #4d352d / #514239, light #806870, lip #7e6570: pogba-head histogram.
- Light skin #eabfa8, shade #da958a, deep #b47c6e, mid #e2b09d: griezmann-head histogram (shade only 4% there, so seat 1 is lightly shaded).
- Black hair #2a2a33 / #1d1e25 / #554d48: lukaku-head. Brown hair #7b6352 / #514239 / #ae8b66: griezmann-head.
- Iris grey-blue #7ca2a4: griezmann-head row 82. Eye white / teeth #f8f7fd, #ece7ef, #ddd6e2, shade #d4c7d5: head + foot frames.
- Kit blue #393295 / dark #3b2f73 / deep #332655 / light #4c48a9: pogba-foot + collars. Kit red #ad1613 / #840f0c / #680906 / light #ee3937: pogba-foot sole + other feet.
- Boot: sole #840f0c with lit stripe #ee3937 (pogba-foot row 48), studs #ad1613, sock/laces white as above.
- Ball back #fcfff7, shade #c2acb5; lit disc = same radius shifted up 19 px (ball-back cols 43/10/75: white ends at 67, 53, 54).
- Ball front seams/patches #32282c, seam lip #3f4f6c (and #48597a): ball-front histogram + row 45.
- Gold back #ffc419 shade #f08808; gold front seams #c24000, patches #bd490f at alpha ~0.5: ball-gold frames.

#### Proportions (measured silhouettes, then drawn by hand)
- Per-row extents of both head frames (sil.js): e.g. pogba y48 20..115, y84 12..129, y120 4..120, y174 44..93;
  griezmann y24 13..120, y72 7..131, y126 11..121, y162 51..110. Our heads match these within ~3 px per row.
- Griezmann hairline (hair to skin) at x 50/70/90/110 = y 42/32/28/26; brow at y 62..73.
- Foot rows: sock top 5..33; heel counter x 3..9, red accent 12..16, upper 19.. at row 30; sole rows 45..50; studs to row 57.

#### Choices (not measured, by rule)
- Faces are invented: seat 0 dark skin + short black crop (not their blonde-top, which is Pogba's signature), seat 1 light skin + brown comb-back with a quiff. So the hair area of seat 0 will always differ in colour from their capture.
- Default kits: seat 0 their red, seat 1 their blue (both of their captured players are France blue). setKits still overrides; other colours get dark/deep/light by mixing (mix ratios UNKNOWN for non-measured kits).
- Ball panel layout is a true truncated icosahedron, hexagon toward the viewer, patches at about -63/43/157 deg (theirs -74/43/176, measured by eye from the 4x crop).
- Their heads have no blink or mood frames (one head frame per character in the atlas), so the page's blink/mood are now ignored.

#### Results (isolated parts: refparts vs ourparts at k 1.8, both France-blue kits, 3 px blur mean diff)
- Before: heads were a different cartoon (not measured in this harness); first new pass headA 36.1, headB 34.2.
- After: headA 34.0 (hair colour dominates: top cells 60..105), headB 28.9, hands+boots A 21.3 / B 24.4, ball 19.7, gold 10.5.
- Runtime: 8 canvases built once per screen scale; 2 players = 10 drawImage, ~0.05 ms per frame (headless).

#### Needs hsArt.js (not my file)
- ballAt rotates the whole cached ball, so the back's shade spins. Theirs keeps the back still. Cache P.ballBack and
  P.ballFront separately (same origin and size as P.ball) and draw the back unrotated, then the front rotated.

#### Revision 2 (coordinator: faces must not read as Pogba / Griezmann)
- Both heads redesigned from scratch inside the same frames (131 x 187, 132 x 167, anchor .5/.8); their per-row widths no longer followed.
- Seat 0: medium-brown skin #c47b43 / shade #b26138 / deep #8f5a38 / dots #a15f48 / light #dfa66c (pepe-head + ronaldo-head atlas entries),
  big scalloped afro #3b251b / #291a11 / curls #562c16 (buffon-head, bale-head), short boxed beard, brows raised, open-mouth shout.
- Seat 1: pale skin #eabfa8 with freckles #b47c6e, ginger = rust #b26138 / #8f5a38 / stipple #d99b66 (their atlas has no ginger; nearest
  warm entries, pepe-head/ronaldo-head), green iris #5cac60 (grigg-head), flat-top buzz cut, short sideburns, narrow square jaw, closed smirk.
- Resemblance check: c-work/heads-vs-ref.png (ours first two, then all 27 ref heads at native size). No ref head has an afro or ginger hair.
- Head diffs now (isolated, blur 3, blue kits): seat 0 54.1, seat 1 36.9 (up from 34.0 / 28.9 because the faces now differ on purpose).

#### Revision 3 (Owen: players much closer to theirs, faces still invented)
- Heads rebuilt in their construction: 3/4 view tipped forward, big cranium over a jutting jaw, squinting eyes under heavy
  brows, toothy grin, kit collar under the chin (same place as theirs), 3 tones (base / shadow side / deep) + halftone,
  hair as painted clumps with lit strokes. Same frames as their seats (131 x 187 and 132 x 167 at .5, anchor .5/.8).
- Seat 0: dark skin #75504c/#5d473d/#4d352d/#806870, shaved scalp (skin + #4d352d stubble dots), thick short beard
  #2a2a33/#1d1e25/#554d48 (lukaku-head). Seat 1: light skin #eabfa8/#da958a/#b47c6e, stubble tint #e0a493 + #b47c6e dots,
  spiky light-brown hair #ae8b66/#9a724b/#7b6352, lit #d2c097 (modric, schweinsteiger heads). Neither matches any of the
  27 (c-work/heads-vs-ref.png): no real head is dark-skinned + shaved + bearded; none has short even light-brown spikes + stubble.
- Poses from S Player: no idle bob; head faces the ball (lookAtPosition) but faces the body's way during cheer/sad;
  run cycle (steps/3, 60 x 30 body units, x .5) held in the air; jump boots +47 deg over .3 x Game.scale(2000) ms
  Quadratic.Out and +50 over .28 x that Quadratic.In (240 / 224 ms at 768 high: Game.scale(v) = imageScale x v, imageScale .4);
  kick (target, 1.5x, angle 60 not mirrored, back over 200 ms Quadratic.Out to the pre-kick spot and angle);
  cheer: arms to (175,70) at -90 deg / (-25,70) at 150 deg, punch every 800 ms to (215,-160) / (-115,-160), 350 ms yoyo;
  sad: head angle 45 x facing. Take-off and goal times are clocked inside hsChars from p.ground / st.mood changes.
- Reference poses captured by hs-tools/cap-c.js (run, kick, jump, cheer) -> cmp/ref-pc-<pose>.png/.json; ours by
  render-c.js (web/scene-c.html passes each player's anim); side by side: SP/players/index.html (players-c.js).
- Page nuance (headsoccer.js, not mine): S stops the run steps during a kick (_updateRunAnimation skipped while _isKicking);
  the page still adds to a.run while kicking. Gate it: `if (p.mv && p.ground && !(p.kickMs >= 0 && p.kickMs < HS.KICK_MS))`.
- Diffs now (isolated, blur 3, blue kits): head seat 0 33.5, seat 1 37.9; hands+boots 21.6 / 24.7; ball 19.7; gold 10.5.

### Scoreboard and HUD (hsArt.js)

Units: world/design units unless noted. "tribune px" = level--tribune.png pixel (2.2222 units, origin x -2194.4, y 61.1;
board centre at px 987.5). "score px" = ui--score.png (2.2222, origin -438.9, 1707.2). Screen = ref-pc-kickoff.png (0.4 px/unit).

#### Font choice
- HUD text font: Sofia Sans Extra Condensed 700 (Google Fonts). Source: fonttest-h.js scored 40+ Google fonts by soft IoU of
  the white glyph body vs their "normal" font (Refrigerator Deluxe, not free) over 0-9 - S P A C E H a l f t i m e:
  Sofia SEC 700 .785 (best), Oswald 500 .760, Big Shoulders Display 900 .741 ... Archivo 900 (old) .370.
- Size factor NF = (48/67.5)/0.665: their digit body is 48 of 67.5 font units tall (normal.png "0" rows 278..325);
  Sofia SEC 700 digit height / size = .665 (measured in Chrome).
- Layout: their .fnt advances/offsets/widths (normal.fnt) for 0-9, space, -, H a l f t i m e; anchor (.5,.5) => body
  baseline y + 30.8s (line top y - 36s, body 18.8s..66.8s below it). Dash drawn as a bar 15.5 x 5.4 font units
  centred 50.4 below the line top (normal.fnt '-' yoffset 43.65 h 13.5; screen bar 10x3 px).
- Outline: ~2.7 font units, navy rgba(6,47,101,.5) top -> rgba(96,137,181,.44) -> rgba(161,207,248,.4) bottom (normal.png
  "0" edge pixels rows 276 / 302 / 326).

#### Clock digits (digital-time)
- size 190 over font 54 (S: GameUI bitmapText); right edges -163, -40, 130, 253; y 230 (S: 45 +- 85 (+-123), H/2 - 730).
- Geometry fitted to digital-time.png by soft IoU (lcdfit-h.js): uprights 19.25 apart, stroke 5.5, slant .134, gap .3,
  x0 -0.03, y0 .5, height 43.1. Per glyph fit: 1 (verticals 14.95/14.9, flag (10.35,4.4)-(7.85,13.7) t 2.45), 2 stub to 10.4,
  3 bars from .35/.05/3.25, 4 uprights to the cell edges, 5 top bar to 22.75 stub from 32.55, 7 bar -.15..25 and
  diagonal (22.2,7.7)-(15.85,21.75), (14.5,22)-(3.5,43.6). IoU .84 (7) .. .93 (0, 6, 9).
- Screen offset +4 x, +4 y: their glyph centroids on ref-pc-kickoff land 1.6 px right / 1.5 px lower than the font layout says.
- Colour #fff (digital-time.png is pure white).

#### Board (tribune px -> units)
- caps x -333.3..-290 (pill under the frame), y 62.2..366.6, lit crescent #8b9abb, body #677a9e, dark #48597a; lit line
  -317.8..-313.3 (#7b8aac, #8b9abb): row y=60 runs 837..848.
- dark backing #48597a -313.3..315.6, y 70..367.7; frame #677a9e -306.7..308.9, y 62.2..356.6, lit #8b9abb to 72.2, #7b8aac to 74.4
  (column x=893). Corner radii (14, 16, 28) UNKNOWN exactly, chosen to match by eye/diff.
- panel #48597a -286.7..291.1 y 83.3..347.7; shadow #3f4f6c -286.7..288.9 y 83.3..345.5; inner #48597a -282.2..286.7 y 94.4..336.6.
- cells #3f4f6c [-266.7,-148.9] [-138.9,-21.1] [21.1,138.9] [150,267.8], y 112.2..316.6, r 24 (cell corner 11 px).
- colon: two slanted hexagons #fcfff7 (tribune px 984..994 x 52..66, 981..991 x 75..88).
- posts [-245.6,-203.3] [205.6,245.6]; #677a9e 367.7..392.2, #7b8aac ..394.4, #8b9abb ..588.9 (foot where the roof rim shows).

#### Score plate (score px)
- pill -438.9..438.9 y 1734..1856 (r 61): #8b9abb, inset 11 #3f4f6c, inset 22.4 #465778; sockets #3f4f6c r 37.8 at +-385.5, 1793.5.
- box caps -247.8..-200 (lit line -236.7..-234.4 #7b8aab), dark line #465778 to -230, frame #677a9e +-229 y 1708..1880.5 lit top to
  1716.1, band #536587 1873..1880.5; ring #3f4f6c +-216.7 y 1722.8..1866; body #465778 +-212.2 y 1731.6..1858.3;
  lilac shade #665a82 a.62 to 1882.8.
- ball icon r 30.4 (46 px at .6), dark rim #342d2f, patches placed from ui--ball.png (3 full, 3 at the rim), seams #9887a2.
- text: score size 120 at (0, 1785); history size 60 at +-340, 1783, anchors 0 / 1 (S: GameUI).

#### Pause (button-up 90 px + icon-pause .563; centre W-100, 100)
- rim #6f5a81 r 100; lilac #9887a2 r 97.8; ring white (disc centre -16.8 r 99) / cream #ffeddf (centre 10.1 r 99);
  green outline #2f6c14 r 82.2; face r 79.5: #7acc53, #9ad97c (+10.6), #4e8f2f (+16.2), #39851c (-14), #5ea040 (-19.5).
- bars x -38.7..-9.9 and 10.1..38.8, y -50..50, round ends r 14.4 (icon-pause 23 px bars, 80 tall).

#### Key hint (player-buttons-space at .9 = 2 units/px, alpha .8, top-left -1282, 1659)
- triangles (px): up (89.5,-5.3)(54.7,55)(124.3,55); left (-5.5,90)(56,54.5)(56,125.5); right mirrored about 91; corners r 6.
- face #0155dd, lit disc #0e64e9: up (89.5,22) r16, left (24,86) r15.3, right (158,86); side #0548ab +4 px; shadow lilac +7 px;
  side keys' base edge #0a52bf 2 px. SPACE key [60,120.5]x[78.5,102] r 4.5 #0e64e9; text 50 x 13 px (x 65..115, y 82..95),
  white with #2b76e8 outline.
- arrows: icon-back stroke 19 px round; rects from the display list (left -1233.5,1807.4; right mirrored; up rot 1.57);
  drawn as their own layer at .8 over the .8 keys (screen arrow colour #d4e4f6 = .8 white over .8 key).

#### GOAL! / GOLDEN GOAL (effects--goal 1119x349, effects--golden-goal 1152x175; .9 scale = 2 units/px)
- Hand-made slab letters G O A L ! D E N (unit height). GOAL! placement from face-colour runs (faceruns-h.js):
  top 6, height 246, middles/slants G 129 -.27, O 375 -.27, A 590 .04, L 786 .6, ! 977 .9.
- extrusion straight down 48 px, pulled in toward x 560 by .048 (G edge +23 px, O bottom 37-41 screen px);
  outer #8b0000, through counters #bf2906. Face #f94200 -> #e92700 -> #dc2400, lower-edge band #fb6943 5 px.
- sticker: white #f5f5ff 21 px below / 14 right (+9 left at the bottom), lilac #c0b7d7 28 below, shadow #9a91b4 45 below
  (column x=370: extrusion 255..302, white ..324, lilac ..331, shadow ..348).
- GOLDEN: top 13, height 122, letter x-scale 1.08, slant -.12 (E and N stems are near vertical), letter middles 82..1046
  estimated from top runs (UNKNOWN exactly; diff 35 vs ref sprite, GOAL! 22.7).
- Timeline unchanged (S: flashGoal). NOT matched: their rising "behind" copy is in backLayer (under players, ball,
  goal fronts and HUD); ours is drawn last, over everything (draw order lives in headsoccer.js).

#### Countdown / Half time
- countdown: refText size 170 at (0, 960), no animation (S: doCountDown swaps text every 600 ms); "3" centroid 681.4,394.0
  vs ref 681.1,394.4 (ref-pc-countdown.png).
- Half time: S: FlashText "Half time" (first letter capital), size 150, scale .2 -> 1.1 in 0.5 s, hold, back out after 1.5 s.

#### Phone buttons (ui--mobi-right / mobi-jump / mob-shoot 101 px; pressed: mobi-move-down / mobi-round-down)
- rings from the edge: 0 #214a0d, 3 #275412, 4 #2f6c14, 8.5 #7acc53, 11.5 #60a241 (row/column 50 runs).
- D shape: half disc r 50.5 at (50.5,50.5), flat left with 16 px corners (opaque profile rows 0..15).
- icons: right triangle (33,29)(69.5,50.5)(33,72) r4 (white rows 32..68); jump (50.5,26)(71,65.5)(30,65.5) r4; shoot: white ball
  r 22.3 with green pentagons and seams. Pressed: white ring 8 px centred on the outline (outer 54.5 of 109 px).

#### Results (mean colour diff, ref vs ours, regions in regions-h.js)
- before (cmp/before-ours-pch-kickoff.png): board 27.9, posts 13.8, plate 23.8, keys 16.8, pause 17.6.
- after (render-ours, digits 0300 vs the ref frame's 02:43): board 12.4, posts 5.4, plate 5.6, keys 4.4, pause 7.5;
  board with the same digits (0243): 5.7.

## UNKNOWN

- **Sound timbres:** their wav files were not analysed; ours are the house synth sounds mapped to the same moments.
- **Each crowd fan's exact position and look:** ours are drawn independently in their blocks, rows, sizes and palette.
- **Physics on contact:** bounces, rolling, rebounds and the kicker's recoil differ from theirs (straight-line motion and
  kicks match). A matching engine prototype and the measurements are in the follow-up notes; not in this change.
- The per-slice UNKNOWN items are listed in each notes section above.
