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
| Road | top 464b4b (renders 535864, measured), sides 3e4444; markings 5f6969, 6a7171 |
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
* Both players run the same map at the same time (made from a secret key, sent lane by lane: "The map on the wire"). Chunk rarity and lane speed use the lane's own row minus 18
  (the row the player stood on when the reference made it), so the map is the same for both and for the server.
* Each screen follows its own hopper exactly like the reference; the rival is a whole character with a name tag
  (Owen 2026-10-28), and you pass through each other.
* Each player has their own eagle clock (5 s, as the reference).
* First one hit, drowned, carried off or taken by the eagle loses. Both on the same tick: more coins wins (Owen
  2026-10-28), equal coins is a draw, both refunded.
* Pressure ramp: every vehicle, log and train spawn speed is multiplied by 1.0 for the first 45 s of the match,
  then +1.2% per second, capped at 2.0x (reached at 128 s). Measured with the bot-vs-bot harness.
* Safety stop: 5 minutes, then the one further ahead wins; level = draw.
* Coins are collected per player and shown, but they do not decide the match. Coins riding on logs are left out.
* The eagle's clock starts at GO for both players (the reference starts it at your first move, which in a duel would
  let a player stand still at the start forever).
* A 3 s countdown before GO.
* Leaving or losing the connection mid-match forfeits (Knockout's rule; no reconnect grace).
* The free-table bot (server/crossy/crossyBot.js) plans each crossing as a timed path at a middling pace; alone it
  reaches the 5-minute stop on almost every map ("The bot" below; `node scripts/crossyBotSim.js 200 solo keyed`).
* Netcode: each seat runs on its own timeline (Swim's), hops stamped with their tick, 250 ms lag allowance.

## Paid (reviewed 2026-10-28, Fable and Opus)
Fixed from the reviews: a leave or dropped connection is judged on both timelines first (the leaver's hopper stands
still from that tick; the stayer gets 0.5 s to reach it) so leaving never turns a locked-in loss into a refund or a
win; the lag floor never trails the clock by more than 0.5 s however slowly the server ticks; nobody is stepped past
the 5 minute stop; a room that throws ends as a draw with refunds instead of taking the server down.
Known and left (for Owen): the rival's row reaches a deliberately lagging client up to 0.25 s early. (The seed is no
longer sent: see "The map on the wire" below. A reconnect grace was added later: server/KnockoutLobby.js.)

## The map on the wire (2026-10-28, phase 2)
The server sends LANES, never a seed. Each match's map is made from a secret 256-bit key (crypto.randomBytes(32), never
sent or logged): every lane's own stream is seeded by HMAC-SHA256(key, 'row:' + r) and every chunk draw (which lanes come
next) is HMAC-SHA256(key, 'chunk:' + n). A lane goes out packed (S.packRow: what it was made with plus where its own
stream stood once made), reliably, as `cr:lanes`, never more than 24 rows beyond the furthest hopper as the server has it
(a screen draws 20 ahead; its own hopper runs at most a couple of rows ahead of the server's copy). Both seats and every
watcher get the same lanes at the same moment. The page's map is S.World.fromLanes: it makes nothing; a lane it has not
been sent blocks a hop (the server's correction then puts it right), so it never invents road. What this closes: a script
can no longer make the whole map and solve it offline, and with a 256-bit key there is nothing to brute-force from the
lanes it sees. What it cannot close: a script still sees the 24 lanes on its screen exactly, as any player does, so a
scripted player with perfect reactions is still possible (true of every real-time game). Test: test/crossy.test.js
("a screen's map made only from the lanes it was sent steps every hopper exactly as the server's").

## The 2026-10-28 redo: models, deaths and HUD (measured, then built as our own)
Owen after playing: "not a 1 to 1 replica". Every number below was read from the reference's model data (bounds and
colour layers only, from `AssetLoader`) or its source; the models are our own boxes drawn to those envelopes.

| Piece | Measured | Ours now (was) |
|---|---|---|
| Grass strip | earth 0-0.25, a 0.125 grass band on top; field (abs x < 4.5) a1cf4c/9bc846 over ba6868, outside 8bb639/84af34 over a95555 | same layers (was a 0.06 band, so a red earth line showed along every road) |
| Road marks | a cell-long dash on every even cell, 0.125 deep, at the near edge when the row before is road (strip rotated PI); 6a7171 in the field, 5f6969 outside | same (was 0.7 long every 1.5, 0.06 deep) |
| Rail strip | bed 0-0.25; sleepers 0.125 wide every unit, 0.25-0.375; two rails 0.125 wide at z +-0.3125, 0.375-0.5 | same |
| River | 53b7d2 all across, white foam from 4.375 to 4.75 each side with a 6ecfeb fringe; rapids bubbles at x +-4.55, y 0.1475 | our own ragged foam and bubbles at those places |
| Tree | trunk 0.375 square x 0.375; leaves 0.625 square, a dark 0.125 band then (light 0.25 + dark 0.125) per step, 9bb519 / acc721 | same rhythm (was a 0.25 trunk, 0.29 bands) |
| Side forest | nine trees packed at 0.625, heights 1.25 / 1.625 / 2.0 only | same mix (was six trees, any height) |
| Rock / stump | 0.75 x 0.625 x 0.75 in three steps / 0.375 cube with a cut top | our own stepped slabs at those sizes |
| Cars | electric 1.32 x 0.84 x 0.96, sedan/purple 1.8 x 1.08 x 0.96, muscle 2.04 x 1.08 x 0.72; trim 0.12-0.24, paint 0.24-0.6, black glass 0.6-0.84, white roof | our own cars in those envelopes and layers (was lilac glass and a paint roof) |
| Trucks | 3.0 x 1.08 x 1.32: a cab 0.72 long in front, a white box 0.36-1.32 | our own truck in that envelope |
| Train | engine 4.875, five carriages 4.5, tail 2.5 (1.625 tall), 1.875 tall, sits at y 0.375 | our own carriages over the 32-unit hit box |
| Signal | a 0.125 pole 1.875 tall, red and white, a 0.625 head at 1.5-1.75, two lamps that take turns | our own striped pole and head |
| Log | 0.5 x 0.5 x length, rests at y -0.13 (top 0.37), end caps 0.125 with a ring | our own log; rests at -0.13 (was -0.005, so it floated 0.125 high) |
| Lily | 0.5 x 0.125, rests at the lane's 0.45 less 0.15 = 0.3, turns slowly | same |
| Log and lily dip | 0.18 down when landed on (attack 0.1, hold 0.1, release 0.1 s); the hopper dips 0.2 (0.01, 0.1, 0.17, 0.1) | same envelopes |

Deaths (source, the player controller): run over = scale (1 + (1 - spread), splat + 0.05, 1) with spread falling over 1 s and
splat over 0.1 s, turned a random +-45 deg; a sideways hop into a car ("carside") = scale (1, 1.3, splat + 0.15) carried on
the car's side at +0.3 up and +0.6 toward the camera; a train flattens and carries the hopper (the camera follows its x
only within +-5); drowning = y 0.5 - easeOutQuint(t) x 1.4 over 1 s with a burst of 70 blue boxes (449EFF: acceleration 1.9,
gravity 0.3 a frame, spread 0.9, up 1.5, they stop below 0.3); the chicken's feathers on a hit = 40 flat boxes 0.1 x 0.02
(acceleration 0.4, gravity 0.02, spread 1.6, direction (3.5, 2, -3), spin 3). Ours run the same numbers on our own boxes;
our hen's feathers are her own colour. The start wobble: (1.1, 0.9, 1.1) while a 0.4 s envelope is up.

HUD (measured at 1280 x 720): the score's glyphs are 50 px tall, 15 px from the corner, a black edge 5 px round and 10 px
on the lower right; the coin count is 35 px tall at the top right; the pause is two white bars 10 x 28 px with an 8 px
gap, 10 px from the right and 65 px down. On a phone the reference letterboxes to 9:16 (blue bars); ours keeps the 9:16
width and shows more road above and below, so the world and the HUD are the same size as the reference's on a phone.

Characters (2026-10-28, Owen: proper voxel animals): our own chicken (default), cat, dog, pig and frog, every one
our design, boxes in shared/crossyCast.js (the game and the lobby draw the same). The chicken is a plump white hen with
a big round head forward of its body, a three-lobed comb, red wattle, yellow beak, orange legs, grey-tipped wings and
a stepped tail fan, not the reference's tall single block. When both seats wear the same animal the rival wears its
second coat. Nugget, Pepper, Sprout, Bloop and Pebble are retired; an old saved id wears the chicken.

## The bot (free tables only), CHOSEN 2026-10-28
Owen: the old bot was "absolutely insane, they destroy me instantly". It looked again every 2 to 5 ticks (a machine's
33 to 83 ms) and planned three hops ahead. Now (server/crossy/crossyBot.js SKILL): it looks every 10 to 24 ticks
(0.17 to 0.4 s), presses 5 to 10 ticks after deciding (it acts on what it saw), plans one hop ahead and checks 24 ticks of
standing still after it, freezes on 10% of looks (unless the eagle is near) and hops forward blind on 4%. Measured alone,
80 maps (`node scripts/crossyBotSim.js 80 solo`): lives 3.3 / 11.7 / 47.1 s (p10 / p50 / p90), score 21 at the median;
the old one (`... 80 solo sharp`) lived 5.9 / 24.3 / 72.8 s and scored 97. Paid tables never get a bot.

## Flicker (2026-10-28, Owen: "cars blink")
Cause: faces in the same plane with different colours (z-fighting): every car's white cab pillars sat exactly on the
black glass (10 to 12 such pairs per car), the truck's band and windscreen, the train's nose and tail windows.
`game-refs/crossy/harness/redo/coplanar.js` counts them in the running page: now 0 on every model. A second cause: the
reference starts a train with its nose already on screen, so it popped in; it is now drawn sliding in along the same
line just before (the rules, where it can hit, are unchanged). `redo/blink.js` records every vehicle per frame: no
vehicle vanishes or appears on screen any more.

Evening (Owen: now it "dies way too easy"; wanted safe, careful, a middling steady pace). SKILL is now careful: on grass or a
lily it waits out a pace of 30 to 44 ticks after each forward hop, then leaves only along a whole crossing it has found
(a search over hop, wait, left, right, each stepped tick by tick, to grass that leads on or a lily), walks round pockets of
trees (a grid search over the grass), and rushes only when the eagle is 3 s along. No blind hops, no freezes, no delay.
Solo over the full 5 minutes with the ramp, 20 maps: lives 18 / 53 s (p10 / p50), 116 rows a minute, deaths car 6 /
eagle 11 / log 3; the old sharp bot on the same runs: 3 / 17 s, 232 a minute. Not yet "alive at 5 minutes in most runs":
it still gets caught waiting by the eagle at long highways and drifting logs (open). The search found a rules bug: off a
log over water x was never rounded, so a hop from a log could never land on a lily (the reference rounds every frame it
has no log, then finds the lily by exact x); fixed in shared/crossySim.js, VERSION 3. That fix was only half done: the
lily test when the arc ends found the lily but never cleared the water, so EVERY hop from a log onto a lily still
drowned, and a lily row right after a log row (the water-lily-a chunk, or a lily chunk after a log chunk) was a wall
nobody could cross. Fixed 2026-10-28 night (VERSION 4; test "a hop from a log onto a lily lands on the lily"). Before
that fix the planning bot below reached the stop on 3 of 20 maps, and 16 of its 17 deaths were at such a wall.

Night (Owen: "make it so it doesn't die... like medium skill"). SKILL now PLANS (decidePlan, plan): every car, train and
log is a closed-form function of the lane clock, so on grass or a lily the bot searches (row, column, tick) for a whole
timed path to the next grass or lily: waits of 3 ticks and hops each way, against each lane's danger by tick (kept once
worked out); on a log it rides the log's own schedule, and a landing in the water counts the 14 ticks a log has to come
under it. Best first, each row made good worth 15 ticks. A path must end with the eagle at most 2.5 s along and with a
way on from there (a second, smaller search; grass and lilies are also checked for dead ends that need no search). It is
replayed through step() before it is used, then followed press by press. Its pace: no hop off grass or a lily before 50
to 70 ticks after its last forward hop, while the eagle is under 1.5 s. With no path it waits where it is, safe, and
looks again a fifth of a second later; only once the eagle is 3 s along does it take a path with no way on found, or the
old careful bot's choice. Each look shares 10,000 search nodes at most. Measured over the full 5 minutes with the ramp
(`scripts/crossyBotSim.js`; keyed = maps from a secret key as a match's): solo 200/200 keyed and 200/200 seeded maps
alive at the stop, 118 rows a minute (p10 114, p90 122), a look 0.05 ms at the 99th percentile of ticks and about 30 ms
at worst; two bots on one map, 100 matches: neither died in any (both still going at the stop).
