# Rooftop Snipers reference: Poki's "Rooftop Snipers" (Neweichgames)

Written 2026-10-28. The game Owen picked: poki.com/en/g/rooftop-snipers (Poki game id `5dd2c5c4-015f-11ea-ad56-9cb6d0d995f7`).

**Rule: no guessed numbers.** Every value says where it came from. **CHOSEN** marks the few we had to pick, with why.
Code: `shared/rtSim.js` (rules and physics), `server/RooftopRoom.js` / `RooftopLobby.js` / `rtBot.js`,
`public/rooftop.html` + `public/js/rooftop.js` + `public/js/rooftop/rtArt.js` + `rtFont.js` + `public/js/rooftopSound.js`.

**Clean room (2026-10-28).** The rules in `shared/rtSim.js` and the CPU in `server/rtBot.js` are written from this
document and the tests, in our own structure: only the reference's numbers and observable behaviour are matched, none
of its code. The physics in `shared/rtSim.js` is a port of the Godot Engine's MIT-licensed 2D physics server (source
**E**), with Godot's licence notice at the top of the file.

## Sources

| Tag | What | How |
|---|---|---|
| **S** | The game's own scripts (GDScript), by file and identifier | Its build is a **Godot 3.3.1** HTML5 export. The embed `games.poki.com/458768/5dd2c5c4-...` frames `5dd2c5c4-015f-11ea-ad56-9cb6d0d995f7.gdn.poki.com/943a5f17-e9b0-45ca-95eb-fb01d7964632/index.html`, which loads `Rooftop Snipers.pck`. The .pck was unpacked and its compiled scripts (`.gdc`, bytecode v13) decoded back to readable GDScript with our own decoder, in the scratchpad only, never in the repo. |
| **T** | Its scene files (`.tscn`, plain text in the .pck), by scene and node | as above |
| **P** | Its project settings (`project.binary`) | as above; it sets no physics values, so Godot 3.3's defaults apply |
| **E** | The Godot 3.3 engine's 2D physics server (Body2DSW, BodyPair2DSW, Step2DSW, the SAT solver) | ported to `shared/rtSim.js` from the engine's published source behaviour |
| **M** | Measured on the real build, run headless and stepped frame by frame | see "Measured" below |
| **A** | Its art, measured for layout and colour only | its textures decoded to PNG in the scratchpad and scanned for sizes and palettes. No image, sound or font of theirs is used: every sprite, sound and letter in ours is drawn or synthesised in code. |

## Units

One unit is one pixel of its base view: **1024 x 600** (P: no window size set, Godot's default), stretch mode
`viewport` with aspect `expand` (P), so the view is widened (or heightened) to the window's shape and then scaled to
fill it without smoothing. x grows right from the middle of the roof, y grows down. Angles positive clockwise.

## Physics

| Thing | Value | Source |
|---|---|---|
| Step | 60 Hz, 8 solver iterations | P (physics_fps unset), E (Physics2DServerSW iterations) |
| Gravity on a player | 98 x 7 = 686 px/s^2 | P default_gravity 98; T Character.gravity_scale 7 |
| Damping | linear 0.1/s, angular 1.0/s | P defaults; T Character.linear_damp -0.9 (negative means "use the default") |
| Player body | box 36 x 128 centred 36 above the origin (origin 28 above the soles), mass 1, inertia 2769.3 | T Character CollisionShape2D extents (18, 64) at (0, -36); E update_inertias (box m(w^2+h^2)/12 + m d^2) |
| Its arm | its own body, mass 0.05, gravity_scale 1, pinned 58 above the origin: the two move as one 1.05 body that falls at (686 + 0.05 x 98) / 1.05 = 658, so a jump launches at 476 and a shot's 400 moves it 381; the arm adds 0.05 x 58^2 = 168 to the turning inertia | T Character PinJoint2D/RigidBody2D; M: the jump fits g 658 exactly |
| Player material | friction 0.5, bounce 0.15 | T PlayerPhysMat |
| Roof | static box (0.245, 651.08) half (640, 700): top at y -48.92, edges at x +-640 | T MapNormal MainBuilding |
| Roof material | friction 1, bounce 0 (Godot default) | E; combined friction = min, bounce = sum clamped (E combine_friction / combine_bounce) |
| Contacts | up to 2 per pair, warm-started; allowed penetration 0.3, bias 0.3, separation 1.5, recycle radius 1.0; box faces only count as a face within 0.36 degrees | E BodyPair2DSW, Space2DSW defaults, _SEGMENT_IS_VALID_SUPPORT_THRESHOLD 0.99998 |
| Jump | impulse 500 along the body's own up (so a leaning player jumps sideways), +-0.05 rad/s random spin, standing torque cleared, no righting for 0.2 s | T Player.jump_power 500 (script default 600 overridden); S PlayerMovement.jump |
| Jump allowed | when either foot ray touches the world: rays from (+-15, 27.8) 20 px down the body's own axis (so two quick taps can both count while the feet are still near the roof, as in the reference) | T Raycasts; S is_grounded |
| Righting | while touching something or grounded, and not in the 0.2 s after a jump: outside 5 degrees it ADDS clamp(-deg/90, -1, 1) x 1350 to the standing torque every step (it builds up); inside 5 degrees, if still turning faster than 0.05 rad/s, the torque is cleared and the spin cut by 55% | T Player align_deadzone 5, align_speed 1350, align_damp_force 0.55; S PlayerMovement.align |
| has_contact | body_entered / body_exited of the single deepest reported contact | T contacts_reported 1; S _on_Player_body_entered/exited |
| Arm | swings from a pin 58 above the origin; raising sets it to -25 (+-1) degrees and turns it 360 deg/s (6 a tick) up to 200; releasing fires from the muzzle at (-6, 92) along the arm | S PlayerShoot.raise_gun / _physics_process / shoot; T Character PinJoint2D (0,-82)+(0,24), arm (0,14), Gun HoldSpot (0,20), ShootSpot (-6,58) |
| Shot | a ray 3000 long; hitting the other player applies an impulse of 400 (600 with Strong Snipers) along the ray at the hit point; no recoil on the shooter; 0.1 s reload | T Gun.power 400, StrongGun.power 600, reload_time 0.1, RayCast2D cast_to (0,3000); S Gun.shoot |
| Rocket Launchers | a rocket (box 28 x 12, mass 1, no gravity) from the launcher's mouth at (-16, 69) from the pin, 750 px/s along the launcher; whatever it first touches gets an impulse of 300 along its flight at the rocket's position, and it is gone (its own contact push comes first, in the physics step) | T RocketLauncher.shoot_power 750, Rocket.explosion_power 300, Rocket extents (14, 6), gravity_scale 0; S RocketLauncher.shoot, Rocket._on_Rocket_body_entered |
| Tomahawks | thrown from the ShootSpot at (-20, 34) from the pin (x mirrored with the arm), turned as that spot is (the arm's angle, plus 180 degrees when the arm is mirrored: Godot's get_rotation is the angle of the x axis), at 900 along the arm, spinning 16 rad/s forward (+16 when mirrored, -16 when not); two boxes: handle (25.2773, 3.55856) at (10.0731, 0.627045), head (9.92318, 19.695) at (-5.96561, -0.195595); mass 1.5, gravity 98 x 5.25, angular damp 0, friction 0.5, bounce 0.3; gone after 15 s; reload 0.2 s (the in-hand one hidden until then). It pushes only by its contact (no script on the hit) | T Tomahawk.shoot_power 900, TomahawkRigid, DestoyDelayed.wait_time 15, Weapon.reload_time 0.2; S Tomahawk.shoot |
| A body of several shapes | each pair of shapes is its own contact pair (up to 2 contacts each); the body's mass is shared by each shape's broadphase box (its world AABB at the angle it entered the space with, grown 5%) for the inertia | E BodyPair2DSW per shape pair, Body2DSW.update_inertias, CollisionObject2DSW._update_shapes |
| Circles and polygons | the same separating-axis test: circle-circle on the centre line, circle-box on the box's two axes and the axis to its nearest corner, circle-polygon on each point and edge normal, box-polygon on the box's axes and each edge normal; a circle's single support is its centre plus r along the axis; a polygon's support is an edge within 0.36 degrees or its farthest point; the lower shape type goes first (circle 3, box 4, polygon 6) | E collision_solver_2d_sat (3.3.1), CircleShape2DSW, ConvexPolygonShape2DSW |
| Polygons | a CollisionPolygon2D is cut into convex pieces: the Hertel-Mehlhorn partition of an ear-clipping triangulation (our port of Godot 3.3.1's thirdparty polypartition gives House [7,8,9,10] [2,3,4,1] [10,0,1] [10,1,4,5,6,7], Cabin [4,5,6,7,10,1] [7,8,9,10] [2,3,4,1] [10,0,1], the Blimp already convex) | E Geometry.decompose_polygon_in_convex, TriangulatorPartition.ConvexPartition_HM |
| Layers | map, civilians and balls on layer 1 mask 1; red layer 2, blue layer 4, each masking 1 and the other; a rocket or tomahawk takes its thrower's layer and mask (never touches him or his own); the foot rays see layer 1 (map, civilians, balls); a shot sees layer 1 and the other player, so a civilian or a ball stops it and takes the push | T Player.tscn collision_layer 0, Character default 1; S Player.init, Gun.init, Tomahawk.shoot |
| Civilians | a Character (the player's box, mass, material and arm) with no script but a 10 s timer: no righting, no jump, a random look in the civilian colour #ab9b19 | T Civillian.tscn, CharacterMat new (0.671, 0.608, 0.098); S Civillian.gd |
| Beach Balls | a circle of radius 40.1863, mass 0.1, gravity 98 x 3, starting at 200 px/s down, damping 0.5 / 0.25, friction 0.3, bounce 0.7, inertia m r^2 / 2; gone after 15 s | T BeachBall.tscn; E CircleShape2DSW.get_moment_of_inertia |
| Falling | once the game has started, every randf() x 5 s (the first at once) one at (camera x + rand(-700, 700), camera y - 1000), turned at random, friction 0.25 when Slippery; the winning fall switches it to civilians 2 s after the fall | S FallingObjects.gd, Gamemanger.create_falling, game_over |
| Camera (in the sim) | position only: towards the players' midpoint x at its own height, by delta x 5 a step, rounded to whole pixels (halves away from zero); after a fall towards the faller by delta x 10 | T GameScene Camera2D (0, -150); S CameraFollow._physics_process, set_target_player |
| Maps | Normal; Elevator (MapNormal with the roof cut into two boxes 256 x 700 half extents at x -+384, and a kinematic car in the 256 px shaft: floor box (128, 38.4) at 168.34 and roof box (128, 12.8) at -83.2 below its origin at (0, -180); its animation moves it 768 px down from 2 s to 6.5 s and back up by 9.5 s, every 13 s, carrying what stands on it); House (polygon at (0, 74.8837) x 0.75, ground 367.336); Blimp (convex polygon at (0, 374.567), bounce 0.3, grass ground at 5120); Cabin (polygon at (0, 74.8837) x 0.75, ground 352.956) | T MapElevator, House, Blimp, Cabin .tscn; E Body2DSW kinematic (velocity = its move over the step) |
| Map spawn / death / edge | Normal and Elevator (250, -200) / 75 / 640; House (246.965, -131.784) / 83.0374 / 555.464; Blimp (250, -144.136) / 248.984 / 613.4; Cabin (263.138, -175.084) / 75 / 557.925 (the CPU's edge is the map's) | T each scene's SpawnPosition, DeathLine, MapEdge (DefualtMap's where not set) |
| Facing | each player faces the other, swapping when they cross with 50 px of slack | S Gamemanger.check_flip |
| Spawn | (-+250, -200), dropped onto the roof | T DefualtMap SpawnPosition |
| Death | origin below y 75 loses the round (124 px below the roof line) | T DefualtMap DeathLine; S check_death |

## Rules and flow

| Thing | Value | Source |
|---|---|---|
| Match | first to 5 points, one point per fall | S GameInfo.play_up_to 5 (SettingsMenu's first choice) |
| Round 1 | always plain ("Normal"); a "Ready Up" screen until both press jump | S Customizations.get_customization (first play), ReadyUpManager |
| Later rounds | each slot rolled: plain with chance (2/(n+1)+1)/3, else one of its n choices: map (Elevator, House, Blimp, Cabin), weapon (Strong Snipers, Rocket Launchers, Tomahawks), falling (Civilians, Beach Balls), weather (Slippery; snow instead of rain on the Cabin), ability (Athlete); the label under the score names them, joined by " + ". Every choice is built, so the roll is the reference's | S Customizations, Gamemanger.create_weather |
| Slippery | player friction 0.25, rain | S GameInfo.slip_amount, Gamemanger.create_weather; T Rain |
| Athlete | jump 650 and a sneaker | S create_ability |
| A fall | slow motion to 0.1 over 0.4 s, held, back over 0.4 s; the camera follows the faller at zoom 0.85; the point text and the score 2 s (game time) later; the next round 3 s after the fall | S round_over, SloMo.slow_down(0.1, 2, 0.4), wrap_point, wrap_scene, CameraFollow.set_target_player |
| The winning fall | the score at 2 s, the slow motion again (no return) 1 s later and the game-over menu ("Red Wins!") | S game_over |
| Camera | starts each round at zoom 1.65, settles on the players' midpoint at zoom 1, zooming out once they are more than 700 apart (up to 2.71) | T GameScene Camera2D zoom 1.65; S CameraFollow |
| Keys | W jump, E hold to raise and let go to fire (player 2: I and O) | P input map jumpP1/shootP1/jumpP2/shootP2 |
| Phone | a Jump button bottom left and a Shoot button bottom right, 150 x 100, 60 in from each side and 19 up | T GameCanvas PlayerButtons/1Player |
| Upright phone | a red "play in landscape" card | S OrientationManager (width/height < 1), T RotateScreen |

## CPU (the free table's bot) (S: ComputerInput.gd, at its default difficulty "Medium")

Waits 0.5 to 3.5 s between shots, aims off by up to 16 degrees, raises and lets go the first frame its gun points
within 60 degrees past the target's chest (or after 0.6 s); waits 0.5 to 6.5 s between jump checks and jumps when it
leans away from the nearer edge by more than its distance to that edge allows.

## Look (A, T)

Sky #6dd9e8 (MapData background_color). City strip 100 x 50 squares at 6.4 px on a 0.1 parallax, 240 px above its
layer, with the water (#8db9e5) under it and its reflection at 36% (DefualtMap). Clouds: pale squares (#e7efff) 25 px
x 1-2 x 1-1.4 drifting 25-60 px/s on a 0.02 parallax. The building 1280 x 1280 (100 squares at 12.8 px) with its top
on the roof line, drawn OVER the players (z 4): a 4-square grey ledge then bricks with dark windows from the 13th row.
Bodies 30 x 72 squares at 2 px, centred 44 above and 4 behind the origin; arms 3 x 11 at 4 px; rifles 6 x 17 at 4 px.
Team colours red #a02929 and blue #2e66bc (CharacterManager). Score: "0 To 0", size 70, red number, white "To", blue
number, black outline. Label size 30, slides down after 0.5 s. Point text size 60 wobbling 20 px each way every
0.35 s. Tracer 6 px, white (green for Strong Snipers) at 59% fading out over 0.5 s.

The round modifiers' sprites are ours, laid out where the reference's sit, at its square sizes and in its colours:
the Elevator's brick housing (20 x 21 squares at 12.8, x -128..128, y -314.4..-45.6, a grey cap #777777/#858585 over
red bricks) with its grey steel car (20 x 18, lamp #b7b49f) and the two dark doors (#404040, 25.6 x 230.4 at x
-+115.5) shut from 1.5 s to 10 s of each loop; the House (121 x 50 at 9.6 from (-585.3, -165.1): gable, roof band
#afbab9, siding #e3f0f1 and #ffffff, windows #aac9cb in #a79770, door) on a concrete street (#827d7d, a dark
#5a5a5a and a pale #e0d1b5 band at 309.5) behind backdrop strips #3d3d3d and #525252; the Blimp (158 x 62 at 12.8
from (-1011.2, -22.2): white to #ededed, fin #d0d0d0, gondola windows #398ab0) with grass (#74c548, #d2d8c3,
#84d25a/#77b455) at 5120; the Cabin (116 x 51 at 9.6 from (-556.8, -160.3): snow #fafbfc/#f1f4f6/#e5eaed, logs
#423225/#615245/#4a3829, posts, glass #31302f in #817d7a) on snow sheets (#e1e1e1 from 265.3, #f1f1f1 from 285.2),
with the city and water replaced by mountains (m 0.075: slate #575668 tinted (0.871, 0.875, 0.898) with snow tops,
a #4c4b5d fill from -121.8) and near hills (m 0.09: #c2c2c2 from -61.4). Snow (the Cabin's Slippery): the sky greyed
(0.298, 0.345, 0.396, 0.455), a light veil (0.761, 0.765, 0.788, 0.188) under the world, 40 white squares 13 px (60%
random smaller) 650 above the camera at 500 px/s along (1, 1) +-20 degrees, gravity 100, damping 52.28, 6 s each,
behind the buildings, and a front veil (0.549, 0.553, 0.573, 0.11). The tomahawk 14 x 10 squares at 4 (head left with
its bright edge #e9f1fb at the bottom, the handle right, team marks #e62828 / #2850e6); the beach ball 20 x 20 at 4
(white, red #ca2626, cyan #25d7dd, yellow #ddd225, shade #eaeaea). Civilians are our characters in #ab9b19.

All characters are ours (a chef, a builder, a clerk, a granny, a skater, a robot, an astronaut and a farmer); the
reference's are lookalikes of famous characters and none of them is copied.

## CHOSEN (not measurable or deliberately different)

- **Ties on the same step**: the lower body loses (the reference checks red first, which would favour blue in a paid match).
- **One standard rifle** for everyone in plain rounds (the reference gives some characters their own gun with a different muzzle offset; a paid duel must be the same for both seats).
- **The arm's own body** (mass 0.05 on a pin joint) is folded into the player as one rigid 1.05 body (its weight and its mass at the pin), and drawn as a damped pendulum, rather than solved as a second body on a joint. This is what matches the measured jump.
- **The ready-up wait** also ends by itself after 10 s online, so nobody can hold a table hostage.
- **Shot timing over the network**: the shooter's screen says how many ticks the button was held and the server uses that, capped at what it saw plus 15 ticks, so the aim you see is the aim you get.
- **Every round modifier is built** (2026-10-28): the four maps, Tomahawks, Civilians and Beach Balls joined Strong Snipers, Rocket Launchers, Slippery and Athlete, so a roll plays the reference's full odds.
- **Street props are not built**: each scene's cars, benches, bins (and the trash can's Area2D that hides falling things), hydrants, mailbox, ATV, truck and skis. They stand on the street below every death line, so they only ever meet a body that has already lost the round or a civilian or ball that fell off; the normal map already left them out.
- **The order of the seeded draws** for a falling object: its look (a civilian's), its x, its turn, then the next wait. The reference takes them from separate random generators; ours come from the one seeded stream so the server and a client agree.
- **A civilian's free arm** is drawn hanging straight down from its pin, not simulated (as for the players). Its look is one of our eight characters, picked from the seeded stream, in the reference's civilian colour.
- **The thrown tomahawk keeps the reference's turn-by-180 for a mirrored arm**, so its two boxes sit up to 1.3 px across the throw from a true mirror image. It follows which way a player faces, not a seat (players swap facing as they cross), so neither seat gains from it.
- **The Shoot animation's 6 px kick** of the arm graphic is not added to a rocket's or tomahawk's starting point (it only matters for a throw within a third of a second of the last; the reload alone is 0.1 or 0.2 s).
- **The sim's camera keeps only its position** (what FallingObjects reads); the zoom stays in the browser's own camera, which draws.
- **Falling objects stop at time-up** (the room's frozen phase): the reference has no time limit.
- **New bodies integrate forces from their first step** (tomahawks, civilians, beach balls): Godot 3.3.1's Body2DSW never sets first_integration (the constructor and set_space clear it). The players' and rockets' one skipped step is left as it was.
- **The maps' own small asymmetries are kept as measured** (not mirrored), for the lead to decide: the House's flat roof reaches x -565.7 on the left (red's starting side) but 556.6 on the right, its eave tips -575.7 / 565.7; the Cabin's eaves -561.1 / 558.8; the Blimp within 0.2; the normal roof is 0.245 off centre. Spawns are mirrored exactly, and players swap sides as they play.
- **Snow and the elevator doors** are pictures only (no physics in the reference either); the snowflakes' randomness is the browser's own.
- **The solver's constraint order** (player-roof pairs first, then player-player) and the broadphase (a bounding-circle check) stand in for Godot's island and hash-grid order.
- **A rocket that never hits anything** is removed 5000 px from the roof (the reference's flies on for ever).
- **The slow motion runs 3 frames (0.05 s) longer** than the reference's 2 s (`RT.SLOW_LAG`), as ours always has, so the
  point and the next round come 3 frames after the reference's (see Gaps). Setting it to 0 lands them on +212 and +272.
- **Characters**: eight of our own, drawn for each player at random each round as the reference does with its own.

## Measured on the real build (M)

The real build was served locally (it refuses other hosts), run in headless Chrome with requestAnimationFrame and the
clock under our control, one physics tick per step (checked: nothing moves without a step), keys sent between steps,
and each player tracked by the pixels of its team colour. At 1024 x 600 and zoom 1, world = screen - (512, 450) + camera.

| Thing | Reference (measured) | Ours (same inputs) |
|---|---|---|
| Drop from y -200 onto the roof | lands frame 38, bounces 1.75 px, rests at y -77 by frame 50 | lands 38, rests at -76.85 |
| Jump (one tap) | leaves the roof 2 frames after the key, peak 161 px at frames 43-44, 83 frames in the air; holding the key gives the same jump | peak 160.5 at frame 41 after the press is applied, 84 frames |
| Shot, gun held K frames | only K = 18 and 19 hit at 500 px apart | only 18 (83 degrees) and 19 hit |
| K = 18 hit | slides 169 px at about 336 px/s and stops at frame 58, tilt within 3 degrees | 160 px, stops at frame 59, tilt 1 degree |
| A fall | point and score +212 frames, next round +272 (slow motion 1 to 0.1 in 17 frames, held to frame 96, back by frame 120) | +215 and +275 |

Gaps: a K = 19 hit in the reference spins the player about 7 degrees a frame and flips it; ours was not compared frame
by frame. The point and next-round timings are 3 frames (50 ms) later than the reference's, all of it from `RT.SLOW_LAG` (CHOSEN).
