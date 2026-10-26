# Chomp's arcade look: every number and where it came from

Owen 2026-10-25: "make it look exactly like the arcade, a one-to-one replica". The line we hold: we match every
measurable fact of the arcade's look and draw every shape ourselves by formula. We never copy the arcade's sprite or
tile data, its maze layout, its font or its sounds. Code: `public/js/chomp/chompPixel.js` (sprites, HUD, timing),
`shared/chompWalls.js` (walls), checks in `test/chomp.test.js` and the comparison page `chomp-arcade-compare.html`
(side-session notes folder).

## Sources

| Key | Source |
|---|---|
| LOMONT | Chris Lomont, *Pac-Man Emulation Guide* v0.1 (2008), lomont.org: hardware facts and the colour PROM's RGB values |
| CAP1 | *The Pac-Man Dossier* (pacman.holenet.info), `Level 256.png`: a native 224 x 288 arcade capture (left half is the normal maze) |
| CAP2 | Dossier `StartPositions.png` (2x), `Cornering.png`, `cornering_example2.png` (12x) |
| REC | Wikimedia Commons, *Pac-Man gameplay (1x pixel-perfect recreation).png* |
| JSP | github.com/jrhollis/jspacman, "a faithful recreation ... reverse engineered" (timings in its actor code) |
| P500 | github.com/jotd666/pacman500 (an Amiga port), `src/pacman.s` |

## Screen

| What | Value | Source |
|---|---|---|
| Screen | 224 x 288 px, 28 x 36 tiles of 8 x 8, 60.61 frames a second | LOMONT |
| Sprites | 16 x 16 | LOMONT |
| Score rows | 3 tile rows on top, maze, 2 rows below | CAP1, REC |
| Scale | whole numbers only: upright phones fit 224 px across, else 288 px tall to the nearest whole | ours (so pixels stay square and sharp) |

## Colours (LOMONT Figure 2)

Wall and scared ghost `#2121ff`, dots `#ffb8ae`, text and eye whites `#dedeff`, red `#ff0000`, pink `#ffb8ff`, cyan
`#00ffff`, orange `#ffb851`, yellow `#ffff00`, brown `#de9751`, green `#00ff00`, light blue `#47b8ff`, teal `#47b8ae`.
The house door is pink in CAP2 and peach in REC; we use pink. Other players' chompers use palette entries that are not
a ghost's, the scared blue or your yellow.

## Walls (measured on CAP1 and REC, checked identical on our render)

- 1 px lines, never filled.
- A wall's top and left edges sit 4 px into their tile, its bottom and right edges 3 px.
- Every outline corner: the lines stop 2 px short of the corner point, one pixel on the diagonal.
- The frame has a second line 3 px deeper: the outer line at the very edge (offset 0), the inner 3 px in. It follows
  parts 3+ tiles thick (the side boxes) and runs straight past 2-tile stubs and notches.
- Its corners: a 4 px round where it turns away from the wall (4 pixels: (2,1), (3,1), (1,2), (1,3)); a tight step
  (lines stop 1 px short) where it turns toward it.
- Ghost house: double box 3 px apart, square corners; door 16 x 2 at rows 1-2 of the house's top tile, with 1 px
  connectors either side of the gap.
- Dots: 2 x 2 at tile pixels (3..4, 3..4). Energizer: an 8 px disc of 52 pixels filling its tile.

## Sprites (sizes and placement measured; shapes drawn by our formulas)

- Sprite origin at floor(8 x position) - 8: Pac-Man's 13 px disc and the ghost's 14 x 14 box start 1 px in (CAP1, REC).
- Pac-Man: disc = every pixel within 6.5 px of the centre pixel (137 pixels shut, as measured in CAP1).
  Half mouth: wedge from 1 px behind the centre, half-width 0.4 px per pixel (REC). Wide: from 2 px behind, 45 degrees
  (CAP2 12x figure).
- Ghost eyes: whites 4 x 5 with the corners off, pupils 2 x 2; per direction (box coordinates, whites / pupils):
  up (2,1)(8,1) / (3,1)(9,1); left (1,3)(7,3) / (1,5)(7,5); down (2,4)(8,4) / (3,7)(9,7); right (3,3)(9,3) / (5,5)(11,5)
  (CAP1 Blinky left, Pinky down, Inky up; REC Pinky up, Clyde right).
- Ours on purpose: the ghost's dome and skirt, the scared face, the cherries, the death frames, the life icon.

## Timing (60 Hz ticks)

| What | Ticks | Source |
|---|---|---|
| Chew | 4 frames x 2: shut, half, wide, half; never stops shut | JSP `Pacman.js` animations[0], frameOffsetX, "pac man never stops with his mouth closed" |
| Ghost skirt | 2 frames x 8 | JSP `Ghost.js` animations[0] |
| Scared flash | 14 blue, 14 white, 5 times at the end | JSP `Ghost.js` (4 frames x 7 ticks); P500 `NB_FLASH_FRAMES = 14` |
| Energizer blink | 10 on, 10 off | JSP `Energizer.js` (P500 uses a 30-tick cycle; JSP is the frame-level one) |
| Caught | 30 frozen, then 14 frames x 8 | JSP `Pacman.js die()` and animations[1] |
| Ghost points | 60 (the arcade freezes everyone; the arena cannot, so only the points stay up) | JSP `GameScene.js eatGhost` |
| Fruit points | 80 | JSP `PacmanPoints.js` `ticksToLive = 80` (its comment says 2 s; the code wins) |
| 1UP blink | 16 on, 16 off while playing | JSP `Text.js` |
| Skirt while flashing | 4 frames of 7, in step with the flash | JSP `Ghost.js` animations[2] |

## Also matched (from the independent review, 2026-10-26)

- READY! sits 6 rows above your chomper, as the arcade's (row 20) sits over Pac-Man's start (row 26).
- Points are small (the arcade's are one 16 px sprite): our own 3 x 5 digits, "1600" is 15 px.
- Draw order: chompers first, then ghosts with Blinky last (JSP `GameScene.js`).
- Ghosts choose their exit one tile ahead and their eyes point there before they turn (DOSSIER "Looking Ahead",
  JSP `Ghost.js`); the server now locks that plan, as the arcade does.
- Text 1 px right of Press Start 2P's cell, scores 1 px lower, life icons at the measured rows.
- Only palette colours on the pixel grid: the safe blink and the power ring switch on and off instead of fading.
- Modules sit one wall tile apart, so each keeps the arcade's full double frame and the tunnels bend it.
- Note: several of our formula shapes come out the same as the arcade's pixels (the Pac-Man frames, the eyes, one
  skirt frame), because at this size a circle, a 45 degree wedge or a 4 x 5 eye has only one way to be drawn.

## Not matched yet

- The arcade font (we use Press Start 2P, an open 8 x 8 arcade-style face).
- The sounds (ours, synthesized).
