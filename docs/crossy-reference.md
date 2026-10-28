# Crossy Road: reference numbers

Owen's reference (2026-10-27): Poki's "Crossy Road" by Hipster Whale, https://poki.com/en/g/crossy-road ,
the "original" world. The build is three.js r96 (`scripts/game.min.js`, obfuscated). Its string table was decoded
headless (`r7zz.g9G(n)` in the page) into a readable copy that stays OUTSIDE the repo
(`Claude Code Test/game-refs/crossy/game.deob.js`, never shipped, never copied). Every number below was read from
that source or measured from the running game (scene graph hooked through `THREE.Object3D.prototype.updateMatrixWorld`,
per-frame positions recorded at 60 fps). Our models, textures, sounds, font and characters are all our own.

Units: 1 world unit = 1 grid cell. Forward is -z. Row number = -z. Columns x = -4..4 (9 cells).

## Camera (source: resize handler and V5 follow loop)
| What | Value | Source |
|---|---|---|
| Type | OrthographicCamera, near -10, far 25 | live camera dump |
| Rotation | x = -PI/4, y = PI/9 (20 deg), order YXZ | source + live (-0.7854, 0.3491) |
| Half height | 3.6 world units (top 3.6, bottom -3.6), left/right = 3.6 x aspect | source F6d=3.6, live lrtb |
| Zoom by aspect | aspect > 1.25: zoom 1, x extra 0.3, y extra 0.5. aspect < 0.75: zoom 2/3, x extra 1, y extra 2.2. Between: linear in (aspect-0.75)*2 | source |
| Position | x = 2.388232 + xExtra + player.x; y = 10.25858 + yExtra; z = player.z + 4 + (4 - (eagleTime + 0.5)) | source (U5, Y0d, N5, F5) |
| Live landscape check | (2.688232, 10.75858, 9.5) with player at z=2 | live dump |
| Follow | x and z lerp toward the target by deltaTime each frame (rate 1 per second) | source |
| Dead | zoom lerps to 1.5 at 2 per second; death cam = player + (2.388232, 10.25858, 8) | source |

## Lighting (source: the world ShaderMaterial)
Vertex colours, lit per vertex with VIEW-space normals (`normalMatrix * normal`):
`colour = vc * (max(0, dot(normalize(0,1,2), n)) * 0.5 + max(0, dot((-1,1,1), n)) * 0.5 + (0.5, 0.5, 0.7)) * 0.8`.
Shadow: one directional light from (-10, 10, 0) relative to its target, 256 map, BasicShadowMap, bias -0.02,
shadow camera +-10, far 15; a pixel in shadow is multiplied by 0.7. Checked against the screenshot: tree top
9bb519 renders b7d521 (factor 1.179, 1.179, 1.339), tree front renders 667714 (factor 0.656, 0.656, 0.816), grass in
shadow 80a542 = b7ec5e x 0.7.

## Base colours (source: vertex colours in models/original_cast-world.json, RGBA)
| Piece | Colours |
|---|---|
| Grass rows (alternate by row parity) | top a1cf4c / 9bc846, side 8bb639 / 84af34, earth a95555 / ba6868 |
| Road | asphalt 3e4444, 464b4b; markings 5f6969, 6a7171 |
| Water | 53b7d2, 6ecfeb, foam ffffff |
| Rail row | sleepers 663931, rails 847e87, bed 3e4444 / 464b4b |
| Tree leaves / trunk | 9bb519, acc721 / 79473c, 6d372e |
| Rock / stump | ab9ba3 / 8e614e, 6d372e, 79473c |
| Log | 79473c, 6d372e, 8e614e, 9a745a |
| Lily pad | 1bb258, 0f9946 |
| Train warning light | ac3232, 340b0b, fd5252 (glow quad 990000 at 0.2 opacity) |
| Cars | sedan eb5f28/e54120, purple 8c76fb/7e52d1, teal 13c0cf/049fb9, trucks cd3042/e43334, glass ebfbff, tyres 000000, trim 7f7590 |

## Sizes (source: model bounds)
Grass top 0.375 high, road 0.25, water 0.125, rail 0.5. Trees 0.625 wide, 0.875 / 1.25 / 1.625 / 2.0 tall. Rock 0.75 wide,
0.625 tall. Stump 0.375. Car 0.84-1.08 wide, 1.32-2.04 long, 0.72-0.96 tall. Truck 1.08 x 3.0 x 1.32. Log 0.5 wide x 0.5
tall x 1/2/3 long. Lily 0.5 x 0.125. Train: front 4.875, five middles 4.5 apart, back 2.5, 1.875 tall. Hopper ~0.5 x 0.7 x 0.95.

## Hop (source: player controller; live trajectory matches)
| What | Value |
|---|---|
| Hop distance | 1 cell |
| Next hop allowed after | 0.15 s (hopDelay); one move is buffered (nextPlayerAction) |
| Position glide | previous -> target over 0.4 s, eased 1 - easeInCubic(1 - t/0.4) (live: z 0.121 at 0.2 s; formula 0.125) |
| Height arc | envelope attack 0.07 s, release 0.12 s, easeOutQuad, x 0.5 units, added to the target height |
| Squash | scale (1 + a x 0.1, 1 - a x 0.4) with a = arc/height x 0.5, lerp 15 per second (max 0.5 a frame) |
| Hold (press) squash | 1.2, 0.7, 1.1 while the key is down |
| Turn | slerp to the move direction over 0.4 s envelope at 5x |
| Side limits | right only while target.x < 3.5, left only while > -3.5 |
| Back limit | back only while target z <= 4 |
| Blocked | a tree or rock in the target cell blocks the move (cells array) |
| Score | max(row reached) + 2, start row -2 so the start shows 0 |

## Death rules (source)
* Car / truck / train: box overlap of the player's TARGET cell (0.29 wide, 0.52 deep) with the vehicle box
  (|dx| < (0.29 + hx)/2 and |dz| < (0.52 + hz)/2). Car hx: electric 1.1, sedan/purple 1.6, muscle 1.8, truck 2.8;
  hz 0.7. Train hx 32, hz 0.9.
* Water: checked when the hop arc ends (0.19 s): on a log if |x - log.x| < (0.05 + logHitX)/2 (log hit X 1.5 / 2.5 /
  3.5 for 1/2/3-long logs), on a lily if same cell, else drowned.
* Riding a log: x snaps to the log's cells, then moves with the log. Carried past |x| > 4.5 = dead ("log").
* Eagle: its clock runs once you have moved; +dt every frame, -1 per forward hop (floor 0), +1 per back hop;
  over 5 s it swoops at 30 units/s from 20 units ahead and takes you.

## Lanes (source: level generator, chunk table, strip table)
* Start: 1 field row, 2 full forest rows, 6 open grass rows, then chunks.
* Chunks are hand-made lane lists picked by rarity: Common < 70, Uncommon 70-84.9, Rare 84.9-94, Rarer 94-98.9,
  Epic 98.9-99.9, MostEpic >= 99.9 (of a random 0-100). Score thresholds change a chunk's rarity (the full table is
  copied as data into shared/crossySim.js, lane names only).
* grass: each column except x=0 has a 0.333 chance of a block; tall if |x| > 2 or 10%, else short. x=0 is always open.
  grass-hole: every column blocked except x=0. grass-empty: none. Forest walls at x = +-7.5 on every grass row.
* road: direction 50/50, truck if random > 0.831 else car (variant weights electric 0.2, purple 0.2, sedan 0.2,
  muscle 0.003). Speed = min(2 + random x F, 7), F = 2 + min(row/1000, 5) (+ row/300 past row 300).
  Spawn from x = -+12.5; gap 12/speed s, or 6/speed s for 0/0/0/1/2/3 short gaps in a row; prewarmed 7 s.
  After a log lane going the same way: no short gaps, speed +1. Cars leave past |x| > 14.
* log lanes: speed = 1 + random x (that same speed formula); spawn every (gap + width + random x 3)/speed with gap
  1 + random x 3; 3x speed in the rapids (|x| > 4.5 + width/2); prewarmed 15 s. poop-slow x1.2 and gap 2;
  poop-fast at least 2.2 and gap 1.1. Same direction as the previous car/log lane and a speed within 1: kept,
  otherwise previous + 1. Logs 2 and 3 long before row 100, 1 long allowed after.
* water-lilypad-rand: a lily at x=0, plus 50% each at two other columns from -3..2.
* train: direction 50/50, speed 60, next train every 9 + random x 4 s (first random x 10), warning light on when the
  next train is 1.2 s away, train starts 20 units beyond the spawn point.
* Rows are made 18 ahead of the player and dropped 10 behind.
* Coins: 0.09 chance per lane.

## CHOSEN for the duel (not in the reference; Owen picked the format)
* Both players run the same seeded map at the same time. Chunk rarity and lane speed use the lane's own row minus 18
  (the row the player stood on when the reference made it), so the map is the same for both and for the server.
* Each screen follows its own hopper exactly like the reference; the rival is drawn at 45% opacity with a name tag.
* Each player has their own eagle clock (5 s, as the reference).
* First one hit, drowned, carried off or taken by the eagle loses. Both on the same tick: draw, both refunded.
* Pressure ramp: every vehicle, log and train spawn speed is multiplied by 1.0 for the first 45 s of the match,
  then +1.2% per second, capped at 2.0x (reached at 128 s). Measured with the bot-vs-bot harness.
* Safety stop: 5 minutes, then the one further ahead wins; level = draw.
* Coins are collected per player and shown, but they do not decide the match. Coins riding on logs are left out.
* The eagle's clock starts at GO for both players (the reference starts it at your first move, which in a duel would
  let a player stand still at the start forever).
* A 3 s countdown before GO.
* Leaving or losing the connection mid-match forfeits (Knockout's rule; no reconnect grace).
* The free-table bot (server/crossy/crossyBot.js) looks three moves ahead and reacts every 2 to 5 ticks; alone it lasts
  30 s median, 65 s p90 (`node scripts/crossyBotSim.js`).
* Netcode: each seat runs on its own timeline (Swim's), hops stamped with their tick, 250 ms lag allowance.
