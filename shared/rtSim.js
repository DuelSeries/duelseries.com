// Rooftop Snipers' rules and physics, one fixed step at a time. The server runs the whole match with it
// (server/RooftopRoom.js); the browser runs the very same step for its own player (prediction).
//
// THE REFERENCE IS "ROOFTOP SNIPERS" (Neweichgames, on Poki), a Godot 3.3.1 game. Its scripts and scenes were read
// from its own build (2026-10-27): every number below says where it came from. (S) its GDScript, with the file and
// identifier; (T) its scene files (.tscn), with the node; (P) its project settings (project.binary), which leave the
// physics at Godot 3.3's defaults; (E) the Godot 3.3 engine itself (the 2D physics server it runs on: gravity,
// damping, contact solver), ported here; (C) CHOSEN by us, with why. docs/rooftop-reference.md has the full table.
//
// UNITS ARE THE REFERENCE'S PIXELS: its base view is 1024 x 600 (P: no window size set, Godot's default) and its
// camera settles at zoom 1, so one unit here is one pixel of its base view. x grows to the right from the middle of
// the roof, y grows DOWN. Angles are radians, positive turns clockwise on screen (Godot's convention).
//
// Seat 0 is RED and starts on the left; seat 1 is BLUE and starts on the right (S: Gamemanger.create_players).
//
// CLEAN ROOM (2026-10-28). The game's rules in this file (the round modifiers and their odds, the righting, the
// jump, the arm, the shot, the rocket and the tomahawk, facing, falls, the slow motion and the round timers, the
// falling objects and the camera) are written from the behaviour in docs/rooftop-reference.md and from the tests,
// in our own structure. No code of the reference game is copied, translated or followed line by line; only its
// numbers and its observable behaviour are matched, each number tagged with where it was read or measured.
// The physics (the contact solver, the separating axis tests, contact generation, warm starting, the integration
// and the convex polygon partition) is a port of the Godot Engine's open source 2D physics server, under its
// licence below.
//
// Portions are a JavaScript port of the Godot Engine 3.3 2D physics server.
// Copyright (c) 2007-2021 Juan Linietsky, Ariel Manzur.
// Copyright (c) 2014-2021 Godot Engine contributors.
// Licensed under the MIT License:
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
// documentation files (the "Software"), to deal in the Software without restriction, including without limitation
// the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
// to permit persons to whom the Software is furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or substantial portions
// of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
// THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
// CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
// DEALINGS IN THE SOFTWARE.
(function (root) {
  'use strict';

  var RT = {
    STEP: 1 / 60,               // P: physics_fps not set -> Godot's 60
    ITERATIONS: 8,              // E: Physics2DServerSW iterations
    GRAVITY: 98 * 7,            // P: default_gravity 98 (unset) x T: Character.gravity_scale 7
    GRAVITY_BASE: 98,           // P: default_gravity 98, before each body's own gravity_scale
    LIN_DAMP: 0.1,              // P: default_linear_damp 0.1 (T: Character.linear_damp -0.9 < 0 means "use the default")
    ANG_DAMP: 1.0,              // P: default_angular_damp 1 (Character sets none)
    MAX_PEN: 0.3,               // E: Space2DSW contact_max_allowed_penetration
    MAX_SEP: 1.5,               // E: contact_max_separation
    RECYCLE: 1.0,               // E: contact_recycle_radius
    BIAS: 0.3,                  // E: BodyPair2DSW bias
    SUPPORT_EPS: 0.99998,       // E: _SEGMENT_IS_VALID_SUPPORT_THRESHOLD
    // The player (T: Character.tscn + Player.tscn).
    BOX_HX: 18, BOX_HY: 64, BOX_OY: -36,   // RectangleShape2D extents (18, 64) at (0, -36)
    MASS: 1,                    // RigidBody2D default mass
    /* The arm is its own RigidBody2D (T: Character PinJoint2D/RigidBody2D, mass 0.05, gravity_scale 1) pinned 58 above
       the origin, so the player and its arm move as one 1.05 body: a 500 jump launches at 476 and they fall at
       (686 + 0.05 x 98) / 1.05 = 658. M (frame-stepped on the real build): the jump fits g 658 and launch 452-476,
       peak 161, 83 frames in the air, which the player alone (686, 500) misses by 5%. */
    ARM_MASS: 0.05, ARM_GS: 1,
    FRICTION: 0.5, BOUNCE: 0.15,           // PhysicsMaterial "PlayerPhysMat"
    SLIP_FRICTION: 0.25,        // S: GameInfo.slip_amount (the Slippery round)
    JUMP: 500,                  // T: Player.jump_power 500 (the script's default 600 is overridden)
    JUMP_ATHLETE: 650,          // S: Gamemanger.create_ability: jump_power = 650
    JUMP_SPIN: 0.05,            // S: PlayerMovement.jump: a random spin of up to 0.05 rad/s either way
    JUMP_LOCK: 0.2,             // S: PlayerMovement.jump: each jump adds 0.2 s with no righting
    ALIGN_DEADZONE: 5,          // T: Player.align_deadzone 5 (degrees)
    ALIGN_SPEED: 1350,          // T: Player.align_speed 1350
    ALIGN_DAMP: 0.55,           // T: Player.align_damp_force 0.55
    ALIGN_STILL: 0.05,          // S: PlayerMovement.align: a spin at or under 0.05 rad/s is left alone
    RAY_X: 15, RAY_Y: 27.8, RAY_LEN: 20,   // T: Raycasts/RayCast2DL,R at (-+15, 27.8), cast_to (0, 20)
    // The arm and gun (T: Character.tscn PinJoint2D, Gun.tscn).
    PIN_Y: -58,                 // PlayerBody (0,-82) + PinJoint2D (0,24)
    MUZZLE_X: -6, MUZZLE_Y: 92, // arm body (0,14) from the pin + HoldSpot (0,20) + Gun ShootSpot (-6,58)
    ARM_START: -25,             // S: PlayerShoot.raise_gun: raised to -25 degrees, a degree either way at random
    ARM_SPEED: 360,             // S: PlayerShoot._physics_process: it then turns 360 degrees a second
    ARM_MAX: 200,               // S: PlayerShoot._physics_process: and stops at 200
    RAY_RANGE: 3000,            // T: Gun RayCast2D cast_to (0, 3000)
    RELOAD: 0.1,                // T: Gun.reload_time 0.1
    POWER: 400,                 // T: Gun.power 400
    POWER_STRONG: 600,          // T: StrongGun.power 600
    // Rocket Launchers (T: RocketLauncher.tscn, Rocket.tscn; S: RocketLauncher.shoot, Rocket._on_Rocket_body_entered).
    ROCKET_SPEED: 750,          // RocketLauncher.shoot_power 750, along the launcher's axis
    ROCKET_BLAST: 300,          // Rocket.explosion_power 300: an impulse along its flight on whatever it touches
    ROCKET_HX: 14, ROCKET_HY: 6,           // Rocket CollisionShape2D extents (14, 6); mass 1, gravity_scale 0
    ROCKET_MX: -16, ROCKET_MY: 69,         // its ShootSpot (-16, 35) + HoldSpot (0, 20) + the arm's (0, 14) from the pin
    ROCKET_FAR: 5000,           // C: a rocket this far from the roof is gone (the reference's flies for ever)
    // Tomahawks (T: Tomahawk.tscn, TomahawkRigid.tscn; S: Tomahawk.shoot, DestoyDelayed).
    TOM_SPEED: 900,             // T: Tomahawk.shoot_power 900, along the arm (the weapon's +y axis)
    TOM_SPIN: 16,               // S: Tomahawk.shoot: a forward spin of 16 rad/s (clockwise when its sprite is mirrored)
    TOM_MX: -20, TOM_MY: 34,    // its ShootSpot (-20, 0) + HoldSpot (0, 20) + the arm's (0, 14) from the pin
    TOM_MASS: 1.5, TOM_GS: 5.25, TOM_ANG_DAMP: 0,   // T: TomahawkRigid mass 1.5, gravity_scale 5.25, angular_damp 0
    TOM_FR: 0.5, TOM_BO: 0.3,   // T: TomahawkRigid PhysicsMaterial friction 0.5, bounce 0.3
    TOM_LIFE: 15,               // T: TomahawkRigid DestoyDelayed.wait_time 15 (seconds of game time)
    TOM_RELOAD: 0.2,            // S: Weapon.reload_time 0.2 (Tomahawk.tscn does not override it)
    // Falling objects (S: FallingObjects.gd, Civillian.gd; T: Civillian.tscn, BeachBall.tscn).
    FALL_WAIT: 5,               // S: FallingObjects.reset_time: the next one within 5 s, at random
    FALL_DX: 700, FALL_DY: -1000,          // S: FallingObjects.create_obj: up to 700 either side of the camera, 1000 above it
    CIV_LIFE: 10,               // S: Civillian._process: gone after 10 s
    BALL_R: 40.1863,            // T: BeachBall CircleShape2D radius 40.1863
    BALL_MASS: 0.1, BALL_GS: 3, BALL_VY: 200,      // T: BeachBall mass 0.1, gravity_scale 3, linear_velocity (0, 200)
    BALL_LIN_DAMP: 0.5, BALL_ANG_DAMP: 0.25,       // T: BeachBall linear_damp 0.5, angular_damp 0.25
    BALL_FR: 0.3, BALL_BO: 0.7, // T: BeachBall PhysicsMaterial friction 0.3, bounce 0.7
    BALL_LIFE: 15,              // T: BeachBall DestoyDelayed.wait_time 15
    // The camera (S: CameraFollow.gd; T: GameScene Camera2D position (0, -150)): FallingObjects drops from it.
    CAM_Y: -150, CAM_LERP: 5, CAM_LERP_FALL: 10,
    // The map (T: DefualtMap.tscn + MapNormal.tscn).
    SPAWN_X: 250, SPAWN_Y: -200,           // DefualtMap SpawnPosition (250, -200), x mirrored per seat
    DEATH_Y: 75,                // DefualtMap DeathLine y 75: below it the round is lost
    EDGE_X: 640,                // DefualtMap MapEdge x 640 (the roof's half width)
    // The match (S: GameInfo, Gamemanger, SloMo).
    PLAY_TO: 5,                 // S: GameInfo.play_up_to 5 (SettingsMenu's first choice)
    POINT_AFTER: 2,             // S: Gamemanger.wrap_point: the point 2 s after the fall (game seconds)
    NEXT_AFTER: 3,              // S: Gamemanger.wrap_scene: the next round 3 s after it
    END_AFTER: 3,               // S: Gamemanger.game_over: 2 s then 1 s more before the game-over menu
    SLOW_TO: 0.1, SLOW_FOR: 2, SLOW_RAMP: 0.4,   // S: Gamemanger.round_over, SloMo.slow_down: to 0.1, for 2 s, 0.4 s each way
    SLOW_LAG: 0,                // M: with no extra time the point and the next round land on the measured +212 / +272
                                //    frames after a fall (0.05 put them 3 frames late)
    READY_MS: 10000,            // C: the first round waits for both to press jump (S: ReadyUpManager); online it
                                //    also starts by itself after 10 s so nobody can hold a table hostage
    FLIP_GAP: 50,               // S: Gamemanger.check_flip hysteresis
    MAX_HELD: 38,               // ticks to reach ARM_MAX from ARM_START (225 / 6 = 37.5)
    CHARS: 8,                   // C: how many of OUR characters there are (the reference draws one of its own at
                                //    random for each player every round: CharacterManager.get_random_character_id)
  };

  // ── a seeded random (mulberry32), so the server and a client replaying the same ticks agree ──
  function rand(m) {
    var t = (m.rng = (m.rng + 0x6D2B79F5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // ── the round modifiers (doc: Rules and flow, "Later rounds") ──
  // Five slots: map, weapon, falling objects, weather, ability. A round's mods are one number per slot: 0 is plain,
  // k is the slot's k-th name below.
  var MOD_NAMES = [['Elevator', 'House', 'Blimp', 'Cabin'], ['Strong Snipers', 'Rocket Launchers', 'Tomahawks'],
                   ['Civilians', 'Beach Balls'], ['Slippery'], ['Athlete']];
  /* The odds of each slot as whole-number weights: plain first, then each choice in MOD_NAMES order. They are the
     reference's odds (S: Customizations), which keep a slot of n choices plain with chance (2 / (n + 1) + 1) / 3
     and share the rest evenly: the map is plain 7 times in 15 (each map 2 in 15), the weapon 3 in 6 (each 1 in 6),
     the falling objects 5 in 9 (each 2 in 9), the weather and the ability 2 in 3. */
  var MOD_WEIGHTS = [[7, 2, 2, 2, 2], [3, 1, 1, 1], [5, 2, 2], [2, 1], [2, 1]];
  // Which values of each slot this build plays: every one, so a roll is the reference's own odds. (A roll that
  // landed on a choice not built would play as plain; none is left.)
  var MOD_BUILT = [[0, 1, 2, 3, 4], [0, 1, 2, 3], [0, 1, 2], [0, 1], [0, 1]];
  // One seeded draw picks an entry of a weight list.
  function pickWeighted(m, weights) {
    var total = 0, i;
    for (i = 0; i < weights.length; i++) total += weights[i];
    var r = rand(m) * total;
    for (i = 0; i < weights.length - 1; i++) {
      if (r < weights[i]) return i;
      r -= weights[i];
    }
    return weights.length - 1;
  }
  function rollMods(m) {
    return MOD_WEIGHTS.map(function (w, slot) {
      var v = pickWeighted(m, w);
      return MOD_BUILT[slot].indexOf(v) >= 0 ? v : 0;
    });
  }
  // The label under the score (doc: "Later rounds"): the round's names joined by " + ", or "Normal".
  function modLabel(c) {
    var on = [];
    c.forEach(function (v, slot) { if (v > 0) on.push(MOD_NAMES[slot][v - 1]); });
    return on.join(' + ') || 'Normal';
  }

  // ── bodies ──
  // A box: half extents and an offset in the body's own frame. Static bodies have no inverse mass or inertia.
  function boxBody(x, y, hx, hy, ox, oy, fr, bo) {
    return { x: x, y: y, a: 0, vx: 0, vy: 0, w: 0, bvx: 0, bvy: 0, bw: 0, tq: 0,
             hx: hx, hy: hy, ox: ox || 0, oy: oy || 0, im: 0, ii: 0, fr: fr, bo: bo, dyn: false, first: false, gs: 0 };
  }
  function playerBody(x, y, fr) {
    var b = boxBody(x, y, RT.BOX_HX, RT.BOX_HY, 0, RT.BOX_OY, fr, RT.BOUNCE);
    var M = RT.MASS + RT.ARM_MASS;
    b.dyn = true; b.first = true;                         // E: first_integration skips forces once
    b.gs = (RT.MASS * 7 + RT.ARM_MASS * RT.ARM_GS) / M;   // T: gravity_scale 7 on the body, 1 on its arm, one weight
    // E: Body2DSW.update_inertias: the box's own moment (m * (w^2 + h^2) / 12) + m * offset^2, plus the arm's mass at
    // its pin (it turns freely on the pin, so only the pin's distance counts for the player's turning)
    var w = 2 * RT.BOX_HX, h = 2 * RT.BOX_HY;
    var I = RT.MASS * (w * w + h * h) / 12 + RT.MASS * (RT.BOX_OY * RT.BOX_OY) + RT.ARM_MASS * RT.PIN_Y * RT.PIN_Y;
    b.im = 1 / M; b.ii = 1 / I;
    return b;
  }

  /* Layers and masks (T, S: Player.init, RocketLauncher.shoot, Tomahawk.shoot): two bodies touch when one's layer is
     in the other's mask (E: CollisionObject2DSW.test_collision_mask). The map, the civilians and the beach balls are on
     layer 1 with mask 1; a player is on layer 2 (red) or 4 (blue) with mask 1 + the other's; a rocket or tomahawk takes
     its thrower's layer and mask, so it never touches its own thrower or his other rockets or tomahawks. */
  function layerOf(side) { return 1 << (side + 1); }
  function maskOf(side) { return 1 | (1 << (2 - side)); }
  function meets(a, b) { return !!(((a.ly || 1) & (b.mk || 1)) || ((b.ly || 1) & (a.mk || 1))); }

  // ── shapes beyond the one box (E: CircleShape2DSW, ConvexPolygonShape2DSW, a CollisionObject2D of several shapes) ──
  // A body with `sh` has several shapes, each { k: 0 box | 1 circle | 2 convex polygon, ox, oy (its offset in the body),
  // hx, hy | r | p (the polygon's points in the body's frame, counter-clockwise as Godot keeps them) and n (each edge's
  // outward normal) }. A body without `sh` is the single box it always was (hx, hy, ox, oy on the body itself).
  function shapesOf(b) { return b.sh || [b]; }
  function boxShape(ox, oy, hx, hy) { return { k: 0, ox: ox, oy: oy, hx: hx, hy: hy }; }
  function circleShape(r) { return { k: 1, ox: 0, oy: 0, r: r }; }
  function polyShape(pts) {
    var n = pts.length, nr = [], cx = 0, cy = 0, br = 0, i;
    for (i = 0; i < n; i++) {
      var q = pts[(i + 1) % n], ex = q[0] - pts[i][0], ey = q[1] - pts[i][1], l = Math.sqrt(ex * ex + ey * ey);
      nr.push([ey / l, -ex / l]);                 // E: ConvexPolygonShape2DSW.set_data: (pn - p).tangent().normalized()
      cx += pts[i][0] / n; cy += pts[i][1] / n;
    }
    for (i = 0; i < n; i++) br = Math.max(br, Math.sqrt((pts[i][0] - cx) * (pts[i][0] - cx) + (pts[i][1] - cy) * (pts[i][1] - cy)));
    return { k: 2, ox: 0, oy: 0, p: pts, n: nr, cx: cx, cy: cy, br: br };
  }
  /* A CollisionPolygon2D (BUILD_SOLIDS) is cut into convex pieces (E: Geometry.decompose_polygon_in_convex: the
     polypartition Hertel-Mehlhorn partition of an ear-clipping triangulation, Godot 3.3.1 thirdparty/misc/triangulator).
     The pieces below are that partition of each polygon, worked out by a line-for-line port of it, as indices into the
     polygon's own points; each piece is one shape, in that order. `s` is the CollisionPolygon2D's scale. */
  function polyPieces(poly, s, parts) {
    return parts.map(function (idx) { return polyShape(idx.map(function (i) { return [poly[2 * i] * s, poly[2 * i + 1] * s]; })); });
  }
  function staticBody(x, y, sh, fr, bo) { var b = boxBody(x, y, 0, 0, 0, 0, fr, bo); b.sh = sh; return b; }

  // The normal map's solid parts (T: MapNormal.tscn). Static material: Godot's default friction 1, bounce 0.
  function normalMap() {
    return [
      boxBody(0.244995, 651.08, 640, 700, 0, 0, 1, 0),        // MainBuilding (its top is the roof, y -48.92)
      boxBody(0, 1275, 6691.1, 50, 0, 0, 1, 0),               // Ground (the street)
      boxBody(696, 948, 57.215, 24.7254, 0, -16.8572, 0.5, 0.9),  // MainBuilding/Cover (its own bouncy material)
      boxBody(-696, 948, 76.1982, 33.5527, 0, 0, 1, 0),       // MainBuilding/Sign
      boxBody(-3200, 682, 528, 436, 3.8042, -109.067, 1, 0),  // BuildingLeft
      boxBody(3200, 682, 398.6, 436, 3.8042, -109.067, 1, 0), // BuildingRight
    ];
  }
  var ROOF_TOP = 651.08 - 700;

  /* The Elevator (T: MapElevator.tscn, which inherits MapNormal): the roof is two boxes (256 x 700 half extents at
     x -+384) with a 256 wide shaft between them, and in the shaft the ElevatorShaft, a kinematic RigidBody2D (mode 3)
     under the Elevator sprite at (0, -180) scaled 12.8: a floor box (10, 3) at (0, 13.1515) and a roof box (10, 1) at
     (0, -6.5), in that sprite's texels. Its AnimationPlayer (physics process) moves it from (0, 0) at 2 s down to
     (0, 60) texels (768 px) at 6.5 s and back up at 9.5 s, linear, looping every 13 s. */
  var LIFT = { X: 0, Y: -180, S: 12.8, LEN: 13, T0: 2, T1: 6.5, T2: 9.5, DOWN: 60, DOOR0: 1.5, DOOR1: 10 };
  function liftAt(t) {                     // the shaft's offset in texels at animation time t
    t = ((t % LIFT.LEN) + LIFT.LEN) % LIFT.LEN;
    if (t <= LIFT.T0 || t >= LIFT.T2) return 0;
    return t < LIFT.T1 ? LIFT.DOWN * (t - LIFT.T0) / (LIFT.T1 - LIFT.T0) : LIFT.DOWN * (LIFT.T2 - t) / (LIFT.T2 - LIFT.T1);
  }
  // T: the animation's Door and Door2 visibility keys: shut from 1.5 s to 10 s of each loop (drawn only).
  function doorsShut(t) { t = ((t % LIFT.LEN) + LIFT.LEN) % LIFT.LEN; return t >= LIFT.DOOR0 && t < LIFT.DOOR1; }
  function elevatorMap() {
    var w = normalMap();
    w[0] = staticBody(0, 651.08, [boxShape(-384, 0, 256, 700), boxShape(384, 0, 256, 700)], 1, 0);
    var s = LIFT.S, lift = staticBody(LIFT.X, LIFT.Y, [boxShape(0, -6.5 * s, 10 * s, 1 * s), boxShape(0, 13.1515 * s, 10 * s, 3 * s)], 1, 0);
    lift.kin = true; lift.nx = lift.x; lift.ny = lift.y;    // E: kinematic: moved, never pushed (no inverse mass)
    w.push(lift);
    return w;
  }
  // T: House.tscn: the House StaticBody2D at (0, 74.8837), its CollisionPolygon2D scaled 0.75; the Ground at 367.3.
  var HOUSE_POLY = [0, -296, 178, -115, 742.124, -115, 754.236, -64.6637, 640.287, -64.2359, 640.442, 319.983, -639.672,
    320.018, -640.002, -63.8837, -767.55, -64.0022, -754.191, -115, -178, -115];
  var HOUSE_PARTS = [[7, 8, 9, 10], [2, 3, 4, 1], [10, 0, 1], [10, 1, 4, 5, 6, 7]];
  function houseMap() {
    return [staticBody(0, 74.8837, polyPieces(HOUSE_POLY, 0.75, HOUSE_PARTS), 1, 0), boxBody(0, 367.336, 6691.1, 50, 0, 0, 1, 0)];
  }
  // T: Blimp.tscn: the Blimp StaticBody2D at (0, 374.567) with its own material (bounce 0.3, friction 1), its polygon
  // already convex (one piece); the Ground (grass) far below at 5120, half extents (10000, 292.62).
  var BLIMP_POLY = [-1011, -166, -934, -268, -614, -396, 614, -396, 934, -268, 1011, -166, 1009.57, -64.9095, 934.041,
    38.4029, 380.864, 189.396, -384.038, 193.278, -934.232, 37.7943, -1011.2, -66.4355];
  function blimpMap() {
    return [staticBody(0, 374.567, polyPieces(BLIMP_POLY, 1, [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]]), 1, 0.3),
            boxBody(0, 5120, 10000, 292.62, 0, 0, 1, 0)];
  }
  // T: Cabin.tscn: the Cabin StaticBody2D at (0, 74.8837), its CollisionPolygon2D scaled 0.75; the Ground at 352.956.
  var CABIN_POLY = [0, -312.907, 233.293, -209.777, 745.133, -171.5, 745.426, -43.1748, 716.855, -42.9479, 716.974, 314.75,
    -717.327, 320.018, -716.562, -44.3328, -748.491, -44.5618, -748.143, -172.922, -236.477, -211.124];
  var CABIN_PARTS = [[4, 5, 6, 7, 10, 1], [7, 8, 9, 10], [2, 3, 4, 1], [10, 0, 1]];
  function cabinMap() {
    return [staticBody(0, 74.8837, polyPieces(CABIN_POLY, 0.75, CABIN_PARTS), 1, 0), boxBody(0, 352.956, 6691.1, 50, 0, 0, 1, 0)];
  }
  /* The maps in the reference's order (T: GameScene maps = MapNormal, MapElevator, House, Blimp, Cabin). spawn is its
     SpawnPosition (x mirrored per seat), death its DeathLine y, edge its MapEdge x (the CPU's edge), all T; a scene
     that does not override one keeps DefualtMap's (250, -200), 75 and 640. The street props of each scene (cars,
     benches, bins, hydrants, the mailbox, the ATV, the truck, the skis) are not built: C, see the doc. */
  var MAPS = [
    { spawn: [250, -200], death: 75, edge: 640, build: normalMap },
    { spawn: [250, -200], death: 75, edge: 640, build: elevatorMap },
    { spawn: [246.965, -131.784], death: 83.0374, edge: 555.464, build: houseMap },
    { spawn: [250, -144.136], death: 248.984, edge: 613.4, build: blimpMap },
    { spawn: [263.138, -175.084], death: 75, edge: 557.925, build: cabinMap },
  ];
  function mapOf(m) { return MAPS[(m.mods && m.mods[0]) | 0] || MAPS[0]; }

  // ── the bodies a round adds (S: Tomahawk.shoot, FallingObjects.create_obj) ──
  /* E: Body2DSW.update_inertias for a body of several boxes: its mass is shared out by each shape's broadphase box
     (the shape's world AABB at the angle the body entered the space with, grown by 5% of (w + h) / 2:
     CollisionObject2DSW._update_shapes), and each adds m_i (w^2 + h^2) / 12 + m_i |offset|^2. */
  function boxesInertia(sh, mass, a) {
    var c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a)), areas = [], tot = 0, I = 0, i;
    for (i = 0; i < sh.length; i++) {
      var w = 2 * (c * sh[i].hx + s * sh[i].hy), h = 2 * (s * sh[i].hx + c * sh[i].hy), g = (w + h) * 0.5 * 0.05;
      areas.push((w + 2 * g) * (h + 2 * g)); tot += areas[i];
    }
    for (i = 0; i < sh.length; i++) {
      var mi = areas[i] * mass / tot, W = 2 * sh[i].hx, H = 2 * sh[i].hy;
      I += mi * (W * W + H * H) / 12 + mi * (sh[i].ox * sh[i].ox + sh[i].oy * sh[i].oy);
    }
    return I;
  }
  /* T: TomahawkRigid.tscn: two boxes, the handle (25.2773, 3.55856) at (10.0731, 0.627045) and the head
     (9.92318, 19.695) at (-5.96561, -0.195595); mass 1.5, gravity_scale 5.25, angular_damp 0, its own material.
     a0: the angle it was thrown at (its inertia depends on it, see boxesInertia). */
  function tomahawkBody(x, y, a0, side) {
    var b = staticBody(x, y, [boxShape(10.0731, 0.627045, 25.2773, 3.55856), boxShape(-5.96561, -0.195595, 9.92318, 19.695)], RT.TOM_FR, RT.TOM_BO);
    b.a = a0; b.dyn = true; b.gs = RT.TOM_GS; b.ad = RT.TOM_ANG_DAMP;
    b.im = 1 / RT.TOM_MASS; b.ii = 1 / boxesInertia(b.sh, RT.TOM_MASS, a0);
    b.ly = layerOf(side); b.mk = maskOf(side);
    return b;
  }
  /* T: Civillian.tscn is the Character scene with only Civillian.gd on it: the player's box, mass, material and arm,
     no righting and no jump, on layer 1 / mask 1. */
  function civilianBody(x, y, fr) { var b = playerBody(x, y, fr); b.first = false; return b; }
  // T: BeachBall.tscn: a circle of radius 40.1863, mass 0.1, gravity_scale 3, damping 0.5 / 0.25, bounce 0.7.
  function ballBody(x, y, fr) {
    var b = staticBody(x, y, [circleShape(RT.BALL_R)], fr, RT.BALL_BO);
    b.dyn = true; b.gs = RT.BALL_GS; b.ld = RT.BALL_LIN_DAMP; b.ad = RT.BALL_ANG_DAMP;
    b.im = 1 / RT.BALL_MASS; b.ii = 1 / (RT.BALL_MASS * RT.BALL_R * RT.BALL_R / 2);   // E: CircleShape2DSW m (r^2 + r^2) / 4
    return b;
  }
  function rocketBody(x, y, a, side) {
    var b = boxBody(x, y, RT.ROCKET_HX, RT.ROCKET_HY, 0, 0, 1, 0);
    b.dyn = true; b.gs = 0; b.a = a;
    var w = 2 * RT.ROCKET_HX, hh = 2 * RT.ROCKET_HY;
    b.im = 1; b.ii = 12 / (w * w + hh * hh);
    b.ly = layerOf(side); b.mk = maskOf(side);
    return b;
  }

  function cs(a) { return [Math.cos(a), Math.sin(a)]; }
  // Body frame -> world (rotation then translation): Godot's Transform2D(angle, pos).xform.
  function toWorld(b, lx, ly) {
    var c = Math.cos(b.a), s = Math.sin(b.a);
    return [b.x + lx * c - ly * s, b.y + lx * s + ly * c];
  }

  // ── the player ──
  function newPlayer(side, fr, jump, sp) {
    var body = playerBody((sp ? sp[0] : RT.SPAWN_X) * (side * 2 - 1), sp ? sp[1] : RT.SPAWN_Y, fr);
    body.ly = layerOf(side); body.mk = maskOf(side);
    return {
      side: side, body: body,
      enabled: false, hasContact: false, upright: true, jumpTime: 0, grounded: false, contactWith: -1,
      raising: false, arm: 0, armBase: 0, held: 0, reloaded: true, cool: 0, jump: jump,
      sx: side === 0 ? -1 : 1,                     // S: Gamemanger: red is mirrored at the start, so it faces right
      shots: 0,
      nj: 0, nd: 0, nr: 0,                         // presses applied so far (jump, shoot down, shoot up)
    };
  }

  function newMatch(seed) {
    var m = {
      tick: 0, rng: (seed >>> 0) || 1, score: [0, 0], round: 0, phase: 'ready', mods: [0, 0, 0, 0, 0],
      ts: 1, slow: null, timer: 0, pointShown: false, loser: -1, winner: -1, ready: [false, false],
      flipScale: 1, world: null, p: null, pairs: {}, power: RT.POWER, ev: [], objs: [], nextObj: 1,
    };
    startRound(m, true);
    return m;
  }

  // A new round: everything is built afresh (S: Gamemanger.wrap_scene reloads the scene). The first round is always
  // Normal (S: Customizations, on the first play) and waits for both to ready up.
  // mods: a given round instead of a roll (the tests' and the picture harness's; play always rolls).
  function startRound(m, first, mods) {
    m.round++;
    m.mods = mods ? mods.slice() : first ? [0, 0, 0, 0, 0] : rollMods(m);
    var slip = m.mods[3] === 1;
    var fr = slip ? RT.SLIP_FRICTION : RT.FRICTION;
    var jump = m.mods[4] === 1 ? RT.JUMP_ATHLETE : RT.JUMP;
    m.power = m.mods[1] === 1 ? RT.POWER_STRONG : RT.POWER;
    var mp = mapOf(m);                             // S: Gamemanger.create_map: the map slot's map
    m.world = mp.build(); m.wm = m.mods[0];
    m.anim = 0;                                    // the map's AnimationPlayer time (the Elevator's), from the scene load
    m.cam = { x: 0, y: RT.CAM_Y, t: -1 };          // T: GameScene Camera2D at (0, -150), following nobody yet
    m.fall = { k: m.mods[2], due: 0 };             // the falling slot's kind and the seconds to its next drop (see falling)
    var had = m.p;
    m.p = [newPlayer(0, fr, jump, mp.spawn), newPlayer(1, fr, jump, mp.spawn)];
    /* The press counts run for the whole match (the room's inputs never reset), so a new round's players start
       from the counts already applied: a fresh 0 would replay every earlier press (review 2026-10-28). */
    if (had) for (var q = 0; q < 2; q++) { m.p[q].nj = had[q].nj; m.p[q].nd = had[q].nd; m.p[q].nr = had[q].nr; }
    m.chars = [Math.floor(rand(m) * RT.CHARS), Math.floor(rand(m) * RT.CHARS)];
    m.pairs = {};
    m.objs = [];
    m.flipScale = 1;
    m.ts = 1; m.slow = null; m.timer = 0; m.pointShown = false; m.loser = -1;
    m.phase = first ? 'ready' : 'play';
    m.p[0].enabled = m.p[1].enabled = !first;     // S: Gamemanger.start_game lets both play (round 1: after ready-up)
    m.ev.push({ e: 'round', r: m.round, mods: m.mods.slice() });
  }

  // ── collision: Godot 3.3's box-box separating axis test and contact generation (E: collision_solver_2d_sat) ──
  // Shapes are tested in coordinates relative to A's origin, as BodyPair2DSW.setup does.
  // sh: which of the body's shapes (the body itself when it is one box). A polygon's points and normals come turned
  // and placed with it.
  function shapeXf(b, offx, offy, sh) {
    var c = Math.cos(b.a), s = Math.sin(b.a), q = sh || b;
    var t = { c: c, s: s, x: b.x - offx + q.ox * c - q.oy * s, y: b.y - offy + q.ox * s + q.oy * c, hx: q.hx, hy: q.hy, k: q.k | 0, r: q.r };
    if (t.k === 2) {
      t.p = []; t.n = [];
      for (var i = 0; i < q.p.length; i++) {
        var px = q.p[i][0], py = q.p[i][1];
        t.p.push([t.x + px * c - py * s, t.y + px * s + py * c]);
        t.n.push([q.n[i][0] * c - q.n[i][1] * s, q.n[i][0] * s + q.n[i][1] * c]);
      }
    }
    return t;
  }
  function project(t, nx, ny) {
    var mn = 1e20, mx = -1e20;
    for (var i = 0; i < 4; i++) {
      var lx = ((i & 1) * 2 - 1) * t.hx, ly = ((i >> 1) * 2 - 1) * t.hy;
      var d = nx * (t.x + lx * t.c - ly * t.s) + ny * (t.y + lx * t.s + ly * t.c);
      if (d > mx) mx = d;
      if (d < mn) mn = d;
    }
    return [mn, mx];
  }
  function supports(t, nx, ny) {
    // the normal into the shape's frame
    var lx = nx * t.c + ny * t.s, ly = -nx * t.s + ny * t.c;
    var ln = Math.sqrt(lx * lx + ly * ly); lx /= ln; ly /= ln;
    var out = [], h = [t.hx, t.hy], n = [lx, ly];
    for (var i = 0; i < 2; i++) {
      if (Math.abs(n[i]) < RT.SUPPORT_EPS) continue;
      var sg = n[i] > 0 ? 1 : -1, p0 = [0, 0], p1 = [0, 0];
      p0[i] = h[i] * sg; p0[i ^ 1] = h[i ^ 1];
      p1[i] = h[i] * sg; p1[i ^ 1] = -h[i ^ 1];
      out.push(p0, p1);
      break;
    }
    if (!out.length) out.push([lx < 0 ? -t.hx : t.hx, ly < 0 ? -t.hy : t.hy]);
    for (var k = 0; k < out.length; k++) {
      var p = out[k];
      out[k] = [t.x + p[0] * t.c - p[1] * t.s, t.y + p[0] * t.s + p[1] * t.c];
    }
    return out;
  }
  // Returns contact point pairs [[ax,ay,bx,by],...] (A's point, B's point) or null when separated.
  function collideBoxes(ta, tb) {
    var axes = [[ta.c, ta.s], [-ta.s, ta.c], [tb.c, tb.s], [-tb.s, tb.c]];
    var best = 1e15, bx = 0, by = 0;
    for (var i = 0; i < 4; i++) {
      var ax = axes[i][0], ay = axes[i][1];
      var ra = project(ta, ax, ay), rb = project(tb, ax, ay);
      var half = (ra[1] - ra[0]) * 0.5, mid = (ra[0] + ra[1]) * 0.5;
      var dmin = rb[0] - half - mid, dmax = rb[1] + half - mid;
      if (dmin > 0 || dmax < 0) return null;
      dmin = Math.abs(dmin);
      if (dmax < dmin) { if (dmax < best) { best = dmax; bx = ax; by = ay; } }
      else if (dmin < best) { best = dmin; bx = -ax; by = -ay; }
    }
    if (bx === 0 && by === 0) return null;
    return contactsFrom(supports(ta, -bx, -by), supports(tb, bx, by), bx, by);
  }
  // E: _generate_contacts_from_supports: the side with fewer support points goes first (the normal turned round).
  function contactsFrom(sa, sb, nx, ny) {
    var out = [], swap = false, pa = sa, pb = sb;
    if (sa.length > sb.length) { swap = true; nx = -nx; ny = -ny; pa = sb; pb = sa; }
    var call = function (a, b) { out.push(swap ? [b[0], b[1], a[0], a[1]] : [a[0], a[1], b[0], b[1]]); };
    if (pa.length === 1 && pb.length === 1) call(pa[0], pb[0]);
    else if (pa.length === 1) {
      // the point against the line through B's edge (Geometry::get_closest_point_to_segment_uncapped_2d)
      var p = pa[0], s0 = pb[0], s1 = pb[1], ex = s1[0] - s0[0], ey = s1[1] - s0[1];
      var l2 = ex * ex + ey * ey, u = l2 > 0 ? ((p[0] - s0[0]) * ex + (p[1] - s0[1]) * ey) / l2 : 0;
      call(p, [s0[0] + ex * u, s0[1] + ey * u]);
    } else {
      // edge against edge: the middle two of the four points along the tangent, each pressed onto the other plane
      var tx = ny, ty = -nx, dA = nx * pa[0][0] + ny * pa[0][1], dB = nx * pb[0][0] + ny * pb[0][1];
      var dv = [
        { d: tx * pa[0][0] + ty * pa[0][1], a: true, p: pa[0] }, { d: tx * pa[1][0] + ty * pa[1][1], a: true, p: pa[1] },
        { d: tx * pb[0][0] + ty * pb[0][1], a: false, p: pb[0] }, { d: tx * pb[1][0] + ty * pb[1][1], a: false, p: pb[1] },
      ];
      dv.sort(function (x, y) { return x.d - y.d; });
      for (var k = 1; k <= 2; k++) {
        var q = dv[k].p, a, b, dq = nx * q[0] + ny * q[1];
        if (dv[k].a) { a = q; b = [q[0] - nx * (dq - dB), q[1] - ny * (dq - dB)]; }
        else { b = q; a = [q[0] - nx * (dq - dA), q[1] - ny * (dq - dA)]; }
        if (nx * a[0] + ny * a[1] > nx * b[0] + ny * b[1] - 0.00001) continue;
        call(a, b);
      }
    }
    return out;
  }

  // ── circles and convex polygons (E: collision_solver_2d_sat, the same separating axis test) ──
  function proj(t, nx, ny) {
    if (t.k === 1) { var d = nx * t.x + ny * t.y; return [d - t.r, d + t.r]; }   // E: CircleShape2DSW.project_range
    if (t.k === 2) {
      var mn = 1e20, mx = -1e20;
      for (var i = 0; i < t.p.length; i++) { var v = nx * t.p[i][0] + ny * t.p[i][1]; if (v < mn) mn = v; if (v > mx) mx = v; }
      return [mn, mx];
    }
    return project(t, nx, ny);
  }
  function supp(t, nx, ny) {
    if (t.k === 1) return [[t.x + nx * t.r, t.y + ny * t.r]];                    // E: CircleShape2DSW.get_supports
    if (t.k === 2) {
      // E: ConvexPolygonShape2DSW.get_supports: an edge facing the normal within 0.36 degrees, else the farthest point
      var best = -1, d = -1e10;
      for (var i = 0; i < t.p.length; i++) {
        var ld = nx * t.p[i][0] + ny * t.p[i][1];
        if (ld > d) { best = i; d = ld; }
        if (t.n[i][0] * nx + t.n[i][1] * ny > RT.SUPPORT_EPS) return [t.p[i], t.p[(i + 1) % t.p.length]];
      }
      return [t.p[best]];
    }
    return supports(t, nx, ny);
  }
  // E: RectangleShape2DSW.get_circle_axis: from the circle's centre to the box's corner on the circle's side.
  function circleAxis(t, px, py) {
    var dx = px - t.x, dy = py - t.y, lx = dx * t.c + dy * t.s, ly = -dx * t.s + dy * t.c;
    var hx = lx < 0 ? -t.hx : t.hx, hy = ly < 0 ? -t.hy : t.hy;
    return [t.x + hx * t.c - hy * t.s - px, t.y + hx * t.s + hy * t.c - py];
  }
  /* A is the lower shape type (E: circle 3 < rectangle 4 < convex polygon 6): circle-circle, circle-box,
     circle-polygon or box-polygon, each testing the axes its _collision_* function tests, in its order. */
  function satPair(A, B) {
    var st = { d: 1e15, x: 0, y: 0 }, i;
    var ax = function (nx, ny) {
      if (Math.abs(nx) < 0.00001 && Math.abs(ny) < 0.00001) { nx = 0; ny = 1; }   // E: test_axis: a zero axis is up
      var ra = proj(A, nx, ny), rb = proj(B, nx, ny);
      var half = (ra[1] - ra[0]) * 0.5, mid = (ra[0] + ra[1]) * 0.5;
      var dmin = rb[0] - half - mid, dmax = rb[1] + half - mid;
      if (dmin > 0 || dmax < 0) return false;
      dmin = Math.abs(dmin);
      if (dmax < dmin) { if (dmax < st.d) { st.d = dmax; st.x = nx; st.y = ny; } }
      else if (dmin < st.d) { st.d = dmin; st.x = -nx; st.y = -ny; }
      return true;
    };
    var axn = function (v) {                         // E: Vector2.normalized() (a zero vector stays zero)
      var l = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
      return l !== 0 ? ax(v[0] / l, v[1] / l) : ax(0, 0);
    };
    if (A.k === 1 && B.k === 1) { if (!axn([A.x - B.x, A.y - B.y])) return null; }                  // TEST_POINT
    else if (A.k === 1 && B.k === 0) {
      if (!ax(B.c, B.s) || !ax(-B.s, B.c) || !axn(circleAxis(B, A.x, A.y))) return null;
    } else if (A.k === 1 && B.k === 2) {
      for (i = 0; i < B.p.length; i++) {
        if (!axn([B.p[i][0] - A.x, B.p[i][1] - A.y])) return null;                                      // TEST_POINT
        if (!ax(B.n[i][0], B.n[i][1])) return null;
      }
    } else if (A.k === 0 && B.k === 2) {
      if (!ax(A.c, A.s) || !ax(-A.s, A.c)) return null;
      for (i = 0; i < B.n.length; i++) if (!ax(B.n[i][0], B.n[i][1])) return null;
    } else return null;
    if (st.x === 0 && st.y === 0) return null;
    return contactsFrom(supp(A, -st.x, -st.y), supp(B, st.x, st.y), st.x, st.y);
  }
  var SHAPE_TYPE = [4, 3, 6];        // E: Physics2DServer.ShapeType of a box, a circle, a convex polygon
  // Contact point pairs (A's point, B's point) for any two shapes, or null when apart.
  function collideShapes(ta, tb) {
    if (!ta.k && !tb.k) return collideBoxes(ta, tb);
    if (SHAPE_TYPE[ta.k] > SHAPE_TYPE[tb.k]) {
      // E: sat_2d_calculate_penetration puts the lower type first, then its callback swaps each pair back
      var r = satPair(tb, ta);
      if (r) for (var i = 0; i < r.length; i++) r[i] = [r[i][2], r[i][3], r[i][0], r[i][1]];
      return r;
    }
    return satPair(ta, tb);
  }

  // ── the contact pair (E: BodyPair2DSW), with its contacts kept between steps for warm starting ──
  function pairOf(m, key) {
    return m.pairs[key] || (m.pairs[key] = { c: [], hit: false });
  }
  function aabbHit(a, b) {
    // a generous circle-around-the-box overlap test stands in for the broadphase (it only decides who is tested)
    var ra = Math.sqrt(a.hx * a.hx + a.hy * a.hy) + Math.sqrt(a.ox * a.ox + a.oy * a.oy) + 2;
    var rb = Math.sqrt(b.hx * b.hx + b.hy * b.hy) + Math.sqrt(b.ox * b.ox + b.oy * b.oy) + 2;
    var dx = a.x - b.x, dy = a.y - b.y;
    return dx * dx + dy * dy < (ra + rb) * (ra + rb);
  }
  // The same generous test for one shape of a body of several: a circle round the shape where it is.
  function shapeNear(A, sa, B, sb) {
    var ca = bound(A, sa), cb = bound(B, sb), dx = ca[0] - cb[0], dy = ca[1] - cb[1], r = ca[2] + cb[2] + 4;
    return dx * dx + dy * dy < r * r;
  }
  // The circle round the body's origin holding every shape's own circle (so it holds whatever shapeNear tests).
  function bodyRadius(b) {
    var sh = shapesOf(b), r = 0;
    for (var i = 0; i < sh.length; i++) {
      var q = sh[i], lx = q.k === 2 ? q.cx : q.ox, ly = q.k === 2 ? q.cy : q.oy;
      var e = q.k === 1 ? q.r : q.k === 2 ? q.br : Math.sqrt(q.hx * q.hx + q.hy * q.hy);
      r = Math.max(r, Math.sqrt(lx * lx + ly * ly) + e);
    }
    return r;
  }
  function bound(b, s) {
    var lx = s.k === 2 ? s.cx : s.ox, ly = s.k === 2 ? s.cy : s.oy, p = toWorld(b, lx, ly);
    return [p[0], p[1], s.k === 1 ? s.r : s.k === 2 ? s.br : Math.sqrt(s.hx * s.hx + s.hy * s.hy)];
  }
  // sa, sb: which shape of each (E: the broadphase pairs shapes, so each pair of shapes keeps its own contacts).
  function setupPair(pr, A, B, dt, rep, sa, sb) {
    var ox = B.x - A.x, oy = B.y - A.y;
    // E: _validate_contacts
    var cA = Math.cos(A.a), sA = Math.sin(A.a), cB = Math.cos(B.a), sB = Math.sin(B.a), i, c;
    for (i = 0; i < pr.c.length; i++) {
      c = pr.c[i];
      var erase = false;
      if (!c.reused) erase = true;
      else {
        c.reused = false;
        var gax = c.lax * cA - c.lay * sA, gay = c.lax * sA + c.lay * cA;
        var gbx = c.lbx * cB - c.lby * sB + ox, gby = c.lbx * sB + c.lby * cB + oy;
        var dep = (gax - gbx) * c.nx + (gay - gby) * c.ny;
        var ex = gbx + c.nx * dep - gax, ey = gby + c.ny * dep - gay;
        if (dep < -RT.MAX_SEP || ex * ex + ey * ey > RT.MAX_SEP * RT.MAX_SEP) erase = true;
      }
      if (erase) { pr.c[i] = pr.c[pr.c.length - 1]; pr.c.pop(); i--; }
    }
    var pts = collideShapes(shapeXf(A, A.x, A.y, sa), shapeXf(B, A.x, A.y, sb));
    if (!pts) { pr.hit = false; return false; }
    // E: _contact_added_callback, for each new point
    for (i = 0; i < pts.length; i++) addContact(pr, A, B, pts[i], ox, oy, cA, sA, cB, sB);
    var any = false, inv = 1 / dt;
    for (i = 0; i < pr.c.length; i++) {
      c = pr.c[i];
      var gAx = c.lax * cA - c.lay * sA, gAy = c.lax * sA + c.lay * cA;
      var gBx = c.lbx * cB - c.lby * sB + ox, gBy = c.lbx * sB + c.lby * cB + oy;
      var depth = c.nx * (gAx - gBx) + c.ny * (gAy - gBy);
      if (depth <= 0 || !c.reused) { c.active = false; continue; }
      c.active = true; any = true;
      if (rep) rep(depth);
      c.rax = gAx; c.ray = gAy; c.rbx = gBx - ox; c.rby = gBy - oy;
      var rnA = c.rax * c.nx + c.ray * c.ny, rnB = c.rbx * c.nx + c.rby * c.ny;
      var kN = A.im + B.im + A.ii * (c.rax * c.rax + c.ray * c.ray - rnA * rnA) + B.ii * (c.rbx * c.rbx + c.rby * c.rby - rnB * rnB);
      c.mn = 1 / kN;
      var tx = c.ny, ty = -c.nx;
      var rtA = c.rax * tx + c.ray * ty, rtB = c.rbx * tx + c.rby * ty;
      var kT = A.im + B.im + A.ii * (c.rax * c.rax + c.ray * c.ray - rtA * rtA) + B.ii * (c.rbx * c.rbx + c.rby * c.rby - rtB * rtB);
      c.mt = 1 / kT;
      c.bias = -RT.BIAS * inv * Math.min(0, -depth + RT.MAX_PEN);
      // warm start (E: ACCUMULATE_IMPULSES)
      var Px = c.accN * c.nx + c.accT * tx, Py = c.accN * c.ny + c.accT * ty;
      impulse(A, c.rax, c.ray, -Px, -Py); impulse(B, c.rbx, c.rby, Px, Py);
      c.bounce = Math.min(1, Math.max(0, A.bo + B.bo));                       // E: combine_bounce
      if (c.bounce) {
        var dvx = B.vx - B.w * c.rby - A.vx + A.w * c.ray, dvy = B.vy + B.w * c.rbx - A.vy - A.w * c.rax;
        c.bounce = c.bounce * (dvx * c.nx + dvy * c.ny);
      }
    }
    pr.hit = any;
    return any;
  }
  function addContact(pr, A, B, p, ox, oy, cA, sA, cB, sB) {
    // into each body's frame (basis only: the points are relative to A's origin)
    var lax = p[0] * cA + p[1] * sA, lay = -p[0] * sA + p[1] * cA;
    var qx = p[2] - ox, qy = p[3] - oy;
    var lbx = qx * cB + qy * sB, lby = -qx * sB + qy * cB;
    var nx = p[0] - p[2], ny = p[1] - p[3], nl = Math.sqrt(nx * nx + ny * ny);
    if (nl > 0) { nx /= nl; ny /= nl; } else { nx = 0; ny = 0; }
    var c = { lax: lax, lay: lay, lbx: lbx, lby: lby, nx: nx, ny: ny, accN: 0, accT: 0, accB: 0, reused: true, active: false };
    var r2 = RT.RECYCLE * RT.RECYCLE, idx = pr.c.length;
    for (var i = 0; i < pr.c.length; i++) {
      var o = pr.c[i];
      var da = (o.lax - lax) * (o.lax - lax) + (o.lay - lay) * (o.lay - lay);
      var db = (o.lbx - lbx) * (o.lbx - lbx) + (o.lby - lby) * (o.lby - lby);
      if (da < r2 && db < r2) { c.accN = o.accN; c.accT = o.accT; c.accB = o.accB; idx = i; break; }
    }
    if (idx === 2) {
      // E: MAX_CONTACTS 2: drop the least deep of the three
      var least = -1, minD = 1e10, all = pr.c.concat([c]);
      for (var k = 0; k < all.length; k++) {
        var q = all[k];
        var gax = q.lax * cA - q.lay * sA, gay = q.lax * sA + q.lay * cA;
        var gbx = q.lbx * cB - q.lby * sB + ox, gby = q.lbx * sB + q.lby * cB + oy;
        var d = (gax - gbx) * q.nx + (gay - gby) * q.ny;
        if (d < minD) { minD = d; least = k; }
      }
      if (least < pr.c.length) pr.c[least] = c;
      return;
    }
    pr.c[idx] = c;
  }
  function impulse(b, rx, ry, jx, jy) {
    if (!b.dyn) return;
    b.vx += jx * b.im; b.vy += jy * b.im; b.w += b.ii * (rx * jy - ry * jx);
  }
  function biasImpulse(b, rx, ry, jx, jy) {
    if (!b.dyn) return;
    b.bvx += jx * b.im; b.bvy += jy * b.im; b.bw += b.ii * (rx * jy - ry * jx);
  }
  function solvePair(pr, A, B) {
    for (var i = 0; i < pr.c.length; i++) {
      var c = pr.c[i];
      if (!c.active) continue;
      var dvx = B.vx - B.w * c.rby - A.vx + A.w * c.ray, dvy = B.vy + B.w * c.rbx - A.vy - A.w * c.rax;
      var dbx = B.bvx - B.bw * c.rby - A.bvx + A.bw * c.ray, dby = B.bvy + B.bw * c.rbx - A.bvy - A.bw * c.rax;
      var vn = dvx * c.nx + dvy * c.ny, vbn = dbx * c.nx + dby * c.ny;
      var tx = c.ny, ty = -c.nx, vt = dvx * tx + dvy * ty;
      var jbn = (c.bias - vbn) * c.mn, jbOld = c.accB;
      c.accB = Math.max(jbOld + jbn, 0);
      var jb = c.accB - jbOld;
      biasImpulse(A, c.rax, c.ray, -c.nx * jb, -c.ny * jb); biasImpulse(B, c.rbx, c.rby, c.nx * jb, c.ny * jb);
      var jn = -(c.bounce + vn) * c.mn, jnOld = c.accN;
      c.accN = Math.max(jnOld + jn, 0);
      var fr = Math.abs(Math.min(A.fr, B.fr));                               // E: combine_friction
      var jtMax = fr * c.accN, jt = -vt * c.mt, jtOld = c.accT;
      c.accT = Math.max(-jtMax, Math.min(jtMax, jtOld + jt));
      var dn = c.accN - jnOld, dtn = c.accT - jtOld;
      var jx = c.nx * dn + tx * dtn, jy = c.ny * dn + ty * dtn;
      impulse(A, c.rax, c.ray, -jx, -jy); impulse(B, c.rbx, c.rby, jx, jy);
    }
  }

  // ── one physics step (E: Step2DSW.step): forces, contacts, solve, move ──
  function physics(m, dt) {
    // Every moving body: the two players, then the round's objects in the order they came (rockets, tomahawks,
    // civilians, beach balls).
    var dyn = [m.p[0].body, m.p[1].body], keys = ['p0', 'p1'], i, j, b, wb;
    for (i = 0; i < m.objs.length; i++) { dyn.push(m.objs[i].body); keys.push('r' + m.objs[i].id); }
    for (i = 0; i < dyn.length; i++) {
      b = dyn[i];
      if (!b.first) {
        // E: integrate_forces: the body's own damping where its scene sets one (T), else the default area's (P)
        var d = Math.max(0, 1 - dt * (b.ld === undefined ? RT.LIN_DAMP : b.ld));
        var ad = Math.max(0, 1 - dt * (b.ad === undefined ? RT.ANG_DAMP : b.ad));
        b.vx *= d; b.vy *= d; b.w *= ad;
        b.vy += RT.GRAVITY_BASE * b.gs * dt;
        b.w += b.ii * b.tq * dt;
      }
      b.first = false;
      b.bvx = b.bvy = b.bw = 0;
    }
    // E: integrate_forces, kinematic: a body its animation moves (the Elevator's shaft) has the velocity that takes it
    // from where it is to where the animation put it in one step, and the solver carries what stands on it with that
    for (j = 0; j < m.world.length; j++) { wb = m.world[j]; if (wb.kin) { wb.vx = (wb.nx - wb.x) / dt; wb.vy = (wb.ny - wb.y) / dt; } }
    // the deepest contact each body reports this step (T: contacts_reported 1)
    var deep = dyn.map(function () { return { d: -1, k: -1 }; });
    var active = [], seen = {};
    var note = function (n, dep, k) { if (dep > deep[n].d) { deep[n].d = dep; deep[n].k = k; } };
    // One pair for each pair of shapes (a body of one shape keeps the key it always had). Two bodies of several shapes
    // whose bounding circles are apart have no shape pair near either: skipped whole (their pairs, unseen, go below).
    var rad = dyn.map(bodyRadius), wrad = m.world.map(bodyRadius);
    var worldRep = function (n, wk) { return function (dep) { note(n, dep, 100 + wk); }; };
    var bodyRep = function (x, y) { return function (dep) { note(x, dep, idOf(m, y)); note(y, dep, idOf(m, x)); }; };
    // x: the dynamic body's index; y: the other's, or -1 - its index in the map
    var pairUp = function (ka, kb, A, B, x, y) {
      var SA = shapesOf(A), SB = shapesOf(B), multi = SA.length > 1 || SB.length > 1, plain = !A.sh && !B.sh, rep = null;
      if (!plain) {
        var dx = A.x - B.x, dy = A.y - B.y, rr = rad[x] + (y < 0 ? wrad[-1 - y] : rad[y]) + 4;
        if (dx * dx + dy * dy >= rr * rr) return;
      }
      for (var si = 0; si < SA.length; si++) {
        for (var sj = 0; sj < SB.length; sj++) {
          var key = ka + ':' + kb + (multi ? '#' + si + '.' + sj : '');
          seen[key] = true;
          if (!(plain ? aabbHit(A, B) : shapeNear(A, SA[si], B, SB[sj]))) { delete m.pairs[key]; continue; }
          var pr = pairOf(m, key);
          if (!rep) rep = y < 0 ? worldRep(x, -1 - y) : bodyRep(x, y);
          if (setupPair(pr, A, B, dt, rep, SA[si], SB[sj])) active.push([pr, A, B]);
        }
      }
    };
    // each body against the map, then the bodies against each other (C: a fixed order for the solver)
    for (i = 0; i < dyn.length; i++) {
      for (j = 0; j < m.world.length; j++) if (meets(dyn[i], m.world[j])) pairUp(keys[i], 'w' + j, dyn[i], m.world[j], i, -1 - j);
    }
    for (i = 0; i < dyn.length; i++) {
      for (j = i + 1; j < dyn.length; j++) if (meets(dyn[i], dyn[j])) pairUp(keys[i], keys[j], dyn[i], dyn[j], i, j);
    }
    // a pair whose bodies stopped overlapping (or are gone) is dropped with its contacts, as the broadphase does
    for (var pk in m.pairs) if (!seen[pk]) delete m.pairs[pk];
    for (var it = 0; it < RT.ITERATIONS; it++) for (j = 0; j < active.length; j++) solvePair(active[j][0], active[j][1], active[j][2]);
    for (i = 0; i < dyn.length; i++) {
      b = dyn[i];
      b.a += (b.w + b.bw) * dt;
      b.x += (b.vx + b.bvx) * dt; b.y += (b.vy + b.bvy) * dt;
      b.a = Math.atan2(Math.sin(b.a), Math.cos(b.a));         // E: Transform2D keeps the angle in (-PI, PI]
      if (i < 2) m.p[i].reported = deep[i].k; else m.objs[i - 2].reported = deep[i].k;
    }
    // E: integrate_velocities, kinematic: it is now where its animation put it
    for (j = 0; j < m.world.length; j++) { wb = m.world[j]; if (wb.kin) { wb.x = wb.nx; wb.y = wb.ny; } }
  }
  // Who a dynamic body is, for a contact report: 0 and 1 the players, 1000 + id an object (a rocket, a tomahawk...).
  function idOf(m, n) { return n < 2 ? n : 1000 + m.objs[n - 2].id; }

  // ── rays (E: Rect2.intersects_segment against each shape in its own frame) ──
  // Returns the hit parameter t in [0, 1] along from -> to, or -1. sh: which box of the body (the body itself if one).
  function rayBox(b, fx, fy, tx, ty, sh) {
    var q = sh || b, c = Math.cos(b.a), s = Math.sin(b.a);
    var cx = b.x + q.ox * c - q.oy * s, cy = b.y + q.ox * s + q.oy * c;
    var ax = (fx - cx) * c + (fy - cy) * s, ay = -(fx - cx) * s + (fy - cy) * c;
    var bx = (tx - cx) * c + (ty - cy) * s, by = -(tx - cx) * s + (ty - cy) * c;
    var from = [ax, ay], to = [bx, by], h = [q.hx, q.hy], mn = 0, mx = 1;
    for (var i = 0; i < 2; i++) {
      var f = from[i], t = to[i], lo = -h[i], hi = h[i], cmin, cmax;
      if (f < t) {
        if (f > hi || t < lo) return -1;
        var len = t - f;
        cmin = f < lo ? (lo - f) / len : 0; cmax = t > hi ? (hi - f) / len : 1;
      } else {
        if (t > hi || f < lo) return -1;
        var len2 = t - f;
        cmin = f > hi ? (hi - f) / len2 : 0; cmax = t < lo ? (lo - f) / len2 : 1;
      }
      if (cmin > mn) mn = cmin;
      if (cmax < mx) mx = cmax;
      if (mx < mn) return -1;
    }
    return mn;
  }
  // E: CircleShape2DSW.intersect_segment (the nearer root, within the segment) and ConvexPolygonShape2DSW's (the
  // nearest edge the segment crosses: Geometry.segment_intersects_segment_2d, so a ray that starts inside a polygon
  // hits it only where it leaves).
  function rayShape(b, q, fx, fy, tx, ty) {
    if (!q.k) return rayBox(b, fx, fy, tx, ty, q);
    var t = shapeXf(b, 0, 0, q), lx = tx - fx, ly = ty - fy;
    if (t.k === 1) {
      var px = fx - t.x, py = fy - t.y, A = lx * lx + ly * ly, B = 2 * (px * lx + py * ly), C = px * px + py * py - t.r * t.r;
      var D = B * B - 4 * A * C;
      if (D < 0) return -1;
      var res = (-B - Math.sqrt(D)) / (2 * A);
      return res < 0 || res > 1 + 0.00001 ? -1 : res;
    }
    var L = lx * lx + ly * ly, best = -1;
    if (L <= 0) return -1;
    var bnx = lx / L, bny = ly / L;
    for (var i = 0; i < t.p.length; i++) {
      var p0 = t.p[i], p1 = t.p[(i + 1) % t.p.length];
      var Cx = p0[0] - fx, Cy = p0[1] - fy, Dx = p1[0] - fx, Dy = p1[1] - fy;
      var cX = Cx * bnx + Cy * bny, cY = Cy * bnx - Cx * bny, dX = Dx * bnx + Dy * bny, dY = Dy * bnx - Dx * bny;
      if ((cY < 0 && dY < 0) || (cY >= 0 && dY >= 0)) continue;
      var pos = dX + (cX - dX) * dY / (dY - cY);
      if (pos < 0 || pos > 1) continue;
      if (best < 0 || pos < best) best = pos;
    }
    return best;
  }
  // The nearest hit on any of a body's shapes (E: intersect_ray keeps the nearest over every shape it meets).
  function rayBody(b, fx, fy, tx, ty) {
    var sh = shapesOf(b), best = -1;
    for (var i = 0; i < sh.length; i++) { var t = rayShape(b, sh[i], fx, fy, tx, ty); if (t >= 0 && (best < 0 || t < best)) best = t; }
    return best;
  }
  // T: the foot rays keep RayCast2D's default collision_mask 1: the map, and the civilians and beach balls (layer 1).
  function grounded(m, p) {
    var b = p.body, j;
    for (var k = -1; k <= 1; k += 2) {
      var f = toWorld(b, k * RT.RAY_X, RT.RAY_Y), t = toWorld(b, k * RT.RAY_X, RT.RAY_Y + RT.RAY_LEN);
      for (j = 0; j < m.world.length; j++) if (rayBody(m.world[j], f[0], f[1], t[0], t[1]) >= 0) return true;
      for (j = 0; j < m.objs.length; j++) { var o = m.objs[j].body; if (((o.ly || 1) & 1) && rayBody(o, f[0], f[1], t[0], t[1]) >= 0) return true; }
    }
    return false;
  }

  // ── the arm and its weapon (doc: Arm, Shot, Rocket Launchers, Tomahawks) ──
  // The arm hangs from a pin PIN_Y above the origin. p.arm is its swing in degrees away from hanging straight down,
  // mirrored by the way the player faces (p.sx); armAngle is that swing in the world, the body's own lean included.
  function armAngle(p) { return p.body.a + p.arm * p.sx * Math.PI / 180; }
  function pinPoint(p) { return toWorld(p.body, 0, RT.PIN_Y); }
  // A point given in the arm's own frame (its x mirrored with the facing, its +y down the arm), in the world.
  function onArm(p, lx, ly) {
    var pin = pinPoint(p), a = armAngle(p), c = Math.cos(a), s = Math.sin(a), x = lx * p.sx;
    return [pin[0] + x * c - ly * s, pin[1] + x * s + ly * c];
  }
  // The unit vector the arm points along (its +y axis) in the world: where a shot or a throw goes.
  function armDir(p) { var a = armAngle(p); return [-Math.sin(a), Math.cos(a)]; }
  function muzzle(p) { return onArm(p, RT.MUZZLE_X, RT.MUZZLE_Y); }
  function wrapAngle(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }
  // The arm's swing after `ticks` steps of holding the button: ARM_SPEED a second from where the raise put it, up to
  // ARM_MAX. Both the arm as it turns and the shot read it, so the shot leaves at the angle the server counted.
  function swingAfter(base, ticks) { return Math.min(base + ticks * RT.ARM_SPEED * RT.STEP, RT.ARM_MAX); }

  // Pressing: the arm comes up to ARM_START, a degree either way at random, and starts turning.
  function raise(m, p) {
    if (!p.enabled || !p.reloaded) return;
    p.armBase = RT.ARM_START + (rand(m) - 0.5) * 2;
    p.arm = p.armBase; p.held = 0; p.raising = true;
  }
  // One step of holding: one more tick on the swing.
  function holdStep(p) {
    if (!p.raising) return;
    p.held++;
    p.arm = swingAfter(p.armBase, p.held);
  }
  // Letting go: the round's weapon goes off at the swing the server counted (never a hold the client names), and
  // the gun reloads.
  function shoot(m, p) {
    if (!p.enabled || !p.raising || !p.reloaded) return;
    p.arm = swingAfter(p.armBase, p.held);
    p.raising = false; p.reloaded = false; p.cool = reloadTime(m); p.shots++;
    var weapon = m.mods[1];
    if (weapon === 2) fireRocket(m, p);
    else if (weapon === 3) throwTomahawk(m, p);
    else fireRifle(m, p);
  }
  // The reload: a countdown from the shot; the gun is ready on the first step that finds it run out.
  function reloadTime(m) { return m.mods[1] === 3 ? RT.TOM_RELOAD : RT.RELOAD; }
  function reloadStep(p, dt) {
    if (p.reloaded) return;
    if (p.cool > 0) p.cool -= dt;
    else p.reloaded = true;
  }

  // Who a hit is, as the events and the contact reports name it: 0 and 1 the players, 100 + j the map's body j,
  // 1000 + id a round object. bodyOfId finds the body that can be pushed (none for the map).
  function bodyOfId(m, id) {
    if (id === 0 || id === 1) return m.p[id].body;
    for (var i = 0; id >= 1000 && i < m.objs.length; i++) if (1000 + m.objs[i].id === id) return m.objs[i].body;
    return null;
  }
  /* The nearest thing a ray from `from` to `to` meets among those its mask sees (E: a RayCast2D's collision_mask
     against each body's layer): { t: 0..1 along the ray, id, body } or null. The map first, then the players, then
     the round's objects; on an exact tie the earlier one is kept. */
  function nearestOnRay(m, from, to, mask) {
    var best = null, i;
    var consider = function (body, id) {
      if (!((body.ly || 1) & mask)) return;
      var t = rayBody(body, from[0], from[1], to[0], to[1]);
      if (t >= 0 && (!best || t < best.t)) best = { t: t, id: id, body: body };
    };
    for (i = 0; i < m.world.length; i++) consider(m.world[i], 100 + i);
    for (i = 0; i < 2; i++) consider(m.p[i].body, i);
    for (i = 0; i < m.objs.length; i++) consider(m.objs[i].body, 1000 + m.objs[i].id);
    return best;
  }
  /* The rifle (doc: Shot, Layers): a ray RAY_RANGE long from the muzzle along the arm. Its mask is the shooter's
     own (the map's layer 1 and the other player), so it stops on the map, on the other player, or on a civilian or a
     beach ball, and whatever it stops on that can move is pushed there with the round's power along the ray. */
  function fireRifle(m, p) {
    var from = muzzle(p), dir = armDir(p);
    var to = [from[0] + dir[0] * RT.RAY_RANGE, from[1] + dir[1] * RT.RAY_RANGE];
    var hit = nearestOnRay(m, from, to, maskOf(p.side)), f = hit ? hit.t : 1;
    var at = [from[0] + (to[0] - from[0]) * f, from[1] + (to[1] - from[1]) * f];
    if (hit) impulse(hit.body, at[0] - hit.body.x, at[1] - hit.body.y, dir[0] * m.power, dir[1] * m.power);
    m.ev.push({ e: 'shot', s: p.side, f: from, h: at, hit: hit && hit.id === 1 - p.side ? 1 : 0, strong: m.power > RT.POWER ? 1 : 0 });
  }
  // A thrown or fired body joins the round's objects with the next id.
  function addObj(m, rec) {
    rec.id = m.nextObj++; rec.reported = -1;
    m.objs.push(rec);
    return rec;
  }
  /* Rocket Launchers (doc): the rocket leaves the launcher's mouth along the arm at ROCKET_SPEED. Its box lies along
     its flight with its x axis pointing back the way it came (the way the picture draws it). It skips its first
     step's forces, as a player does. */
  function fireRocket(m, p) {
    var mouth = onArm(p, RT.ROCKET_MX, RT.ROCKET_MY), dir = armDir(p);
    var b = rocketBody(mouth[0], mouth[1], Math.atan2(-dir[1], -dir[0]), p.side);
    b.first = true;
    b.vx = dir[0] * RT.ROCKET_SPEED; b.vy = dir[1] * RT.ROCKET_SPEED;
    var r = addObj(m, { side: p.side, body: b, k: 0 });
    m.ev.push({ e: 'rocket', s: p.side, id: r.id, f: [b.x, b.y] });
  }
  /* Tomahawks (doc): it leaves its spot on the arm turned as that spot is (the arm's angle, half a turn more when
     the arm is mirrored), flies along the arm at TOM_SPEED and spins forward at TOM_SPIN, which is clockwise when
     the arm is mirrored. fl remembers the mirroring for the picture and the wire. */
  function throwTomahawk(m, p) {
    var spot = onArm(p, RT.TOM_MX, RT.TOM_MY), dir = armDir(p), mirrored = p.sx < 0;
    var a0 = wrapAngle(armAngle(p) + (mirrored ? Math.PI : 0));
    var b = tomahawkBody(spot[0], spot[1], a0, p.side);
    b.vx = dir[0] * RT.TOM_SPEED; b.vy = dir[1] * RT.TOM_SPEED;
    b.w = mirrored ? RT.TOM_SPIN : -RT.TOM_SPIN;
    var r = addObj(m, { side: p.side, body: b, k: 1, t: 0, a0: a0, fl: mirrored ? 1 : 0 });
    m.ev.push({ e: 'toss', s: p.side, id: r.id, f: [b.x, b.y] });
  }
  /* A rocket that touched something in the last step is spent (doc: Rocket Launchers): what it touched, if it can
     move, gets ROCKET_BLAST along the rocket's flight at the rocket's position (its own contact push already came in
     the step), and the rocket bursts and is gone. One that touches nothing is dropped ROCKET_FAR from the roof (C). */
  function rocketsLand(m) {
    var kept = [];
    m.objs.forEach(function (r) {
      var b = r.body;
      if (r.k !== 0) { kept.push(r); return; }
      if (r.reported < 0) {
        if (Math.abs(b.x) <= RT.ROCKET_FAR && Math.abs(b.y) <= RT.ROCKET_FAR) kept.push(r);
        return;
      }
      var target = bodyOfId(m, r.reported), speed = Math.hypot(b.vx, b.vy) || 1;
      if (target) impulse(target, b.x - target.x, b.y - target.y, b.vx / speed * RT.ROCKET_BLAST, b.vy / speed * RT.ROCKET_BLAST);
      m.ev.push({ e: 'boom', s: r.side, x: b.x, y: b.y, hit: r.reported < 2 ? 1 : 0 });
    });
    m.objs = kept;
  }

  // ── the player's own movement (doc: Jump, Jump allowed, Righting) ──
  /* The jump: only while a foot ray touches. JUMP (or the Athlete's) straight along the body's own up, so a leaning
     player jumps sideways; any righting torque built up is dropped, a small random spin is added, and the righting
     is off for JUMP_LOCK more seconds. */
  function jump(m, p) {
    if (!grounded(m, p)) return;
    var b = p.body, up = [Math.sin(b.a), -Math.cos(b.a)];
    b.tq = 0;
    impulse(b, 0, 0, up[0] * p.jump, up[1] * p.jump);
    b.w += (rand(m) - 0.5) * 2 * RT.JUMP_SPIN;
    p.jumpTime += RT.JUMP_LOCK;
    m.ev.push({ e: 'jump', s: p.side });
  }
  /* The righting controller. It works while the player is in play, touching something (by its contact report or
     its foot rays) and out of the lock after a jump; by the body's lean it is in one of two zones:
       leaning (ALIGN_DEADZONE degrees or more either way): a push back toward upright, in proportion to the lean
         and full at 90 degrees, is ADDED to the standing torque every step, so it keeps growing until the player
         comes back;
       settled (inside the dead zone): the first step back in, if the body still spins faster than ALIGN_STILL,
         drops the built up torque and brakes the spin by ALIGN_DAMP. p.upright says that brake has been spent. */
  function rightingOn(p) { return p.enabled && p.jumpTime <= 0 && (p.hasContact || p.grounded); }
  function align(p) {
    if (!rightingOn(p)) return;
    var b = p.body, lean = b.a * 180 / Math.PI;
    if (Math.abs(lean) >= RT.ALIGN_DEADZONE) {
      b.tq -= Math.max(-1, Math.min(1, lean / 90)) * RT.ALIGN_SPEED;
      p.upright = false;
    } else if (!p.upright && Math.abs(b.w) > RT.ALIGN_STILL) {
      b.tq = 0;
      b.w *= 1 - RT.ALIGN_DAMP;
      p.upright = true;
    }
  }
  // Touching: the body's deepest contact of the last step names something (T: contacts_reported 1).
  function contactSignal(p) {
    p.contactWith = p.reported === undefined ? -1 : p.reported;
    p.hasContact = p.contactWith >= 0;
  }

  // ── one tick of the whole game (the order Godot 3.3's main loop runs things in) ──
  // inputs[side]: running counts { j: jump presses, d: shoot presses, r: shoot releases, n: ticks the last shot was
  // held }. Each tick takes at most one of each kind that has not been applied yet, so a tap shorter than a tick
  // still counts, and the server and a client replaying the same counts agree.
  function tick(m, inputs) {
    m.ev = [];
    m.tick++;
    var dt = RT.STEP * m.ts, i, p;
    // 1. after the last step: each body's forces (the righting), then its contact report, then the rockets that hit
    for (i = 0; i < 2; i++) { align(m.p[i]); contactSignal(m.p[i]); }
    rocketsLand(m);
    // 2. the map's animation and the foot rays, the camera, the arms turning, the buttons
    animate(m, dt);
    for (i = 0; i < 2; i++) m.p[i].grounded = grounded(m, m.p[i]);
    camStep(m, dt);
    var want = [{ j: false }, { j: false }];
    for (i = 0; i < 2; i++) {
      p = m.p[i];
      holdStep(p);
      var inp = inputs && inputs[i];
      if (!inp) continue;
      if ((inp.d | 0) > p.nd) { p.nd++; raise(m, p); }
      /* The aim is the hold the SERVER saw, tick for tick (the arm turns from the press it applied to the release
         it applied). A hold the client names is never believed: a modified client could otherwise fire at any
         angle it had swept past (review 2026-10-28). */
      if ((inp.r | 0) > p.nr) { p.nr++; shoot(m, p); }
      /* One jump per press, and a backlog of presses is one press: several counted at once would stack impulses
         while the feet are still near the roof (a "super jump", review 2026-10-28). */
      if ((inp.j | 0) > p.nj) { p.nj = inp.j | 0; want[i].j = true; }
    }
    // 3. the physics step
    physics(m, dt);
    // 4. the rules first, then each player's timers and the jump key
    if (m.phase === 'ready') {
      for (i = 0; i < 2; i++) if (want[i].j && !m.ready[i]) { m.ready[i] = true; m.ev.push({ e: 'ready', s: i }); }
    }
    checkFlip(m);
    if (m.phase === 'play') checkDeath(m);
    falling(m, dt);
    for (i = 0; i < 2; i++) {
      p = m.p[i];
      if (p.jumpTime > 0) p.jumpTime -= dt;
      if (p.enabled) {
        reloadStep(p, dt);
        if (want[i].j) jump(m, p);
      }
    }
    objTimers(m, dt);
    slowMo(m);
    if (m.phase === 'down' || m.phase === 'end') afterFall(m, dt);
    return m.ev;
  }

  // T: the map's AnimationPlayer (playback_process_mode physics) moves the Elevator's shaft; it sets where the
  // kinematic body goes, and the step takes it there (E: Body2DSW new_transform).
  function animate(m, dt) {
    m.anim += dt;
    for (var j = 0; j < m.world.length; j++) {
      var w = m.world[j];
      if (w.kin) { w.nx = LIFT.X; w.ny = LIFT.Y + LIFT.S * liftAt(m.anim); }
    }
  }

  // ── the sim's camera (doc: Camera (in the sim)) ──
  // E: Math::round, which rounds halves away from zero.
  function roundHalfOut(v) { return v < 0 ? -Math.round(-v) : Math.round(v); }
  // Where it is heading: the players' middle at its own height, or once someone has fallen, that player.
  function camGoal(m) {
    var c = m.cam;
    if (c.t >= 0) return [m.p[c.t].body.x, m.p[c.t].body.y];
    return [(m.p[0].body.x + m.p[1].body.x) / 2, c.y];
  }
  /* Only its position is kept here, which the falling objects drop from (the zoom is the picture's, which the
     browser keeps). Each step it closes dt x CAM_LERP of the gap to its goal (CAM_LERP_FALL once following a fall),
     on whole pixels. */
  function camStep(m, dt) {
    var c = m.cam, goal = camGoal(m), k = dt * (c.t >= 0 ? RT.CAM_LERP_FALL : RT.CAM_LERP);
    c.x = roundHalfOut(c.x + (goal[0] - c.x) * k);
    c.y = roundHalfOut(c.y + (goal[1] - c.y) * k);
  }

  // ── the round's objects (doc: Falling, Civilians, Beach Balls) ──
  var OBJ_ROCKET = 0, OBJ_TOMAHAWK = 1, OBJ_CIVILIAN = 2, OBJ_BALL = 3;   // an object's k
  var FALL_CIVILIANS = 1, FALL_BALLS = 2;                                  // the falling slot (m.fall.k)
  /* While the game is on (not in the ready-up, not after time-up), the round's falling kind drops one object at
     once and then one each time a random wait of up to FALL_WAIT seconds runs out (m.fall.due counts it down). It
     appears FALL_DY above the camera and up to FALL_DX either side of it, turned at random. The seeded draws go in
     the order the doc fixes: a civilian's look, the x, the turn, then the next wait. */
  function falling(m, dt) {
    var f = m.fall;
    if (!f.k || m.phase === 'ready' || m.phase === 'frozen') return;
    f.due -= dt;
    if (f.due >= 0) return;
    var kind = f.k === FALL_CIVILIANS ? OBJ_CIVILIAN : OBJ_BALL;
    var look = kind === OBJ_CIVILIAN ? Math.floor(rand(m) * RT.CHARS) : 0;
    var x = m.cam.x + (rand(m) - 0.5) * 2 * RT.FALL_DX, y = m.cam.y + RT.FALL_DY;
    var body = makeFaller(kind, x, y, m.mods[3] === 1);
    body.a = rand(m) * 2 * Math.PI;
    var o = addObj(m, { side: -1, body: body, k: kind, t: 0, ch: look });
    m.ev.push({ e: 'drop', k: kind, id: o.id });
    f.due = rand(m) * RT.FALL_WAIT;
  }
  // A civilian keeps the player's friction (the Slippery one on a slippery round); a beach ball has its own, and
  // starts at BALL_VY down.
  function makeFaller(kind, x, y, slip) {
    if (kind === OBJ_CIVILIAN) return civilianBody(x, y, slip ? RT.SLIP_FRICTION : RT.FRICTION);
    var b = ballBody(x, y, slip ? RT.SLIP_FRICTION : RT.BALL_FR);
    b.vy = RT.BALL_VY;
    return b;
  }
  // How long each kind lasts (doc): a tomahawk and a beach ball 15 s, a civilian 10 s; a rocket has no clock (C:
  // ROCKET_FAR instead).
  var LIFE = [];
  LIFE[OBJ_TOMAHAWK] = RT.TOM_LIFE; LIFE[OBJ_CIVILIAN] = RT.CIV_LIFE; LIFE[OBJ_BALL] = RT.BALL_LIFE;
  function objTimers(m, dt) {
    m.objs = m.objs.filter(function (o) {
      if (o.k === OBJ_ROCKET) return true;
      o.t += dt;
      return o.t <= LIFE[o.k];
    });
  }

  // Both ready (or the ready wait ran out): the first round starts (S: ReadyUpManager, Gamemanger.start_game).
  function begin(m) {
    if (m.phase !== 'ready') return;
    m.phase = 'play';
    m.p[0].enabled = m.p[1].enabled = true;
    m.ev.push({ e: 'go' });
  }

  /* Facing (doc): red faces right and blue left while red is on the left (m.flipScale 1). They swap only once one
     has got past the other by FLIP_GAP: blue at least FLIP_GAP left of red, or back the other way, blue more than
     FLIP_GAP right of red. */
  function checkFlip(m) {
    var gap = m.p[1].body.x - m.p[0].body.x;          // how far blue is to red's right
    var redLeft = m.flipScale > 0;
    if (redLeft ? gap <= -RT.FLIP_GAP : gap > RT.FLIP_GAP) {
      m.flipScale = -m.flipScale;
      m.p[0].sx = -m.flipScale; m.p[1].sx = m.flipScale;
    }
  }

  // ── a fall and what follows (doc: Death, A fall, The winning fall) ──
  /* Whoever's origin is below the map's death line has lost the round; if both are, the lower one (C: the doc's
     "Ties on the same step"), and on an exact tie red. -1 when nobody is. */
  function fallen(m) {
    var line = mapOf(m).death, who = -1;
    for (var s = 0; s < 2; s++) {
      var y = m.p[s].body.y;
      if (y > line && (who < 0 || y > m.p[who].body.y)) who = s;
    }
    return who;
  }
  function checkDeath(m) {
    var loser = fallen(m);
    if (loser < 0) return;
    var winner = 1 - loser;
    m.phase = 'down'; m.loser = loser; m.timer = 0;
    m.score[winner]++;
    for (var s = 0; s < 2; s++) { m.p[s].enabled = false; m.p[s].raising = false; }
    m.cam.t = loser;                            // the camera follows the faller
    m.slow = startSlow(m, false);
    if (m.score[winner] >= RT.PLAY_TO) m.winner = winner;
    m.ev.push({ e: 'fall', s: loser, score: m.score.slice() });
  }

  /* The slow motion (doc: A fall) is a curve over real time: m.slow.n counts the real steps since it began, and the
     time scale is read off the curve each step.
       easing down: over SLOW_RAMP (N steps) from the scale it began at to SLOW_TO. What is left of the gap after n
         steps is the product of (1 - k / N) for k = 1..n, so it is nearly there in 17 frames (M) and exactly
         there at N;
       held at SLOW_TO;
       coming back: a straight line up to 1 over the last SLOW_RAMP, ending SLOW_FOR + SLOW_LAG after it began.
     The game-over slow-down (final) only eases down, and the game stays slow. */
  function startSlow(m, final) { return { n: 0, from: m.ts, final: !!final }; }
  function slowSteps() {
    var ramp = Math.round(RT.SLOW_RAMP / RT.STEP);
    return { ramp: ramp, end: Math.round((RT.SLOW_FOR + RT.SLOW_LAG) / RT.STEP) };
  }
  function slowScale(s) {
    var k = slowSteps(), i;
    if (s.final || s.n <= k.ramp) {
      var left = 1;
      for (i = 1; i <= Math.min(s.n, k.ramp); i++) left *= 1 - i / k.ramp;
      return RT.SLOW_TO + (s.from - RT.SLOW_TO) * left;
    }
    var back = k.end - k.ramp;                  // the step the climb back starts from
    if (s.n <= back) return RT.SLOW_TO;
    return RT.SLOW_TO + (1 - RT.SLOW_TO) * Math.min(1, (s.n - back) / k.ramp);
  }
  function slowMo(m) {
    var s = m.slow;
    if (!s) return;
    s.n++;
    m.ts = slowScale(s);
    var k = slowSteps();
    if (s.final ? s.n >= k.ramp : s.n >= k.end) { m.slow = null; if (!s.final) m.ts = 1; }
  }

  /* After a fall, by game time since it (m.timer): the point and the score at POINT_AFTER; then the next round at
     NEXT_AFTER, or after the winning fall the game-over at END_AFTER, with the slow-down again (staying slow). The
     winning fall also turns the falling objects to civilians when the point shows (doc: Falling). */
  function afterFall(m, dt) {
    m.timer += dt;
    if (m.phase !== 'down') return;
    var won = m.winner >= 0;
    if (!m.pointShown && m.timer >= RT.POINT_AFTER) {
      m.pointShown = true;
      if (won) m.fall.k = FALL_CIVILIANS;
      m.ev.push({ e: 'point', s: 1 - m.loser, score: m.score.slice() });
    }
    if (!won && m.timer >= RT.NEXT_AFTER) startRound(m, false);
    else if (won && m.pointShown && m.timer >= RT.END_AFTER) {
      m.phase = 'end';
      m.slow = startSlow(m, true);
      m.ev.push({ e: 'end', w: m.winner, score: m.score.slice() });
    }
  }

  // ── the wire: a whole state in a few numbers, so a client can rewind to it and replay its own presses ──
  function r2(v) { return Math.round(v * 100) / 100; }
  function r4(v) { return Math.round(v * 10000) / 10000; }
  function packPlayer(p) {
    var b = p.body;
    var f = (p.enabled ? 1 : 0) | (p.hasContact ? 2 : 0) | (p.upright ? 4 : 0) | (p.grounded ? 8 : 0) |
            (p.raising ? 16 : 0) | (p.reloaded ? 32 : 0) | (p.sx > 0 ? 64 : 0) | (b.first ? 128 : 0);
    return [r2(b.x), r2(b.y), r4(b.a), r2(b.vx), r2(b.vy), r4(b.w), r2(b.tq), f, r4(p.jumpTime), r2(p.arm), r2(p.armBase),
            p.held, r4(p.cool), p.contactWith, p.shots, p.nj, p.nd, p.nr];
  }
  function unpackPlayer(p, a) {
    var b = p.body;
    b.x = a[0]; b.y = a[1]; b.a = a[2]; b.vx = a[3]; b.vy = a[4]; b.w = a[5]; b.tq = a[6];
    var f = a[7];
    p.enabled = !!(f & 1); p.hasContact = !!(f & 2); p.upright = !!(f & 4); p.grounded = !!(f & 8);
    p.raising = !!(f & 16); p.reloaded = !!(f & 32); p.sx = f & 64 ? 1 : -1; b.first = !!(f & 128);
    p.jumpTime = a[8]; p.arm = a[9]; p.armBase = a[10]; p.held = a[11]; p.cool = a[12]; p.contactWith = a[13]; p.shots = a[14];
    p.nj = a[15]; p.nd = a[16]; p.nr = a[17];
  }
  /* The round's objects as the wire carries them (`ob`): one short string, because a Tomahawks round keeps dozens
     alive (each lasts 15 s) and the snapshot goes out 30 times a second, volatile (the mobile rule: keep it small).
     Each number is a whole one (the value times its unit below, rounded), zigzagged so a small negative one stays
     small, and written five bits to a character, low bits first, in a 64-letter alphabet that needs no escaping in
     JSON; a character with the 32 bit set says another follows. Per object, in id order (the order they came):
       the id's step from the one before; a code: kind (0 rocket, 1 tomahawk, 2 civilian, 3 beach ball)
       | (side + 1) << 2 | mirrored << 4 | a civilian's look << 5;
       x, y, the angle, vx, vy and the spin;
       then, but for a rocket (it has no clock), its age; and a tomahawk's throw angle (its inertia depends on it).
     The units are the old wire's rounding (hundredths of a pixel and of a pixel a second, ten-thousandths of a
     radian), so a client's replay agrees with the server exactly as closely as before (test/rooftop.test.js); the age
     goes in tenths of a tick. Only the writing is shorter: about 2 KB for 62 objects where it was 4.4 KB. The shapes,
     masses, layers and friction come back from the kind, the side and the round's Slippery. */
  var OBJ_P = 100, OBJ_A = 10000, OBJ_V = 100, OBJ_W = 10000, OBJ_T = 10 / RT.STEP, OBJ_A0 = 10000;
  var B64 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_', B64_AT = {};
  for (var bi = 0; bi < 64; bi++) B64_AT[B64.charCodeAt(bi)] = bi;
  function putInt(out, v) {
    var z = Math.round(v);
    z = z >= 0 ? 2 * z : -2 * z - 1;
    if (!(z < 9e15)) z = 0;                          // not a number: never a broken string
    while (z >= 32) { out.push(B64[32 + z % 32]); z = Math.floor(z / 32); }
    out.push(B64[z]);
  }
  function packObjs(objs) {
    var out = [], prev = 0;
    for (var i = 0; i < objs.length; i++) {
      var r = objs[i], b = r.body;
      putInt(out, r.id - prev);
      putInt(out, r.k | (r.side + 1) << 2 | (r.fl ? 16 : 0) | (r.k === OBJ_CIVILIAN ? (r.ch | 0) << 5 : 0));
      putInt(out, b.x * OBJ_P); putInt(out, b.y * OBJ_P); putInt(out, b.a * OBJ_A);
      putInt(out, b.vx * OBJ_V); putInt(out, b.vy * OBJ_V); putInt(out, b.w * OBJ_W);
      if (r.k !== OBJ_ROCKET) putInt(out, r.t * OBJ_T);
      if (r.k === OBJ_TOMAHAWK) putInt(out, r.a0 * OBJ_A0);
      prev = r.id;
    }
    return out.join('');
  }
  function unpackObjs(m, str) {
    var objs = [], id = 0, at = 0, n = str.length, slip = m.mods[3] === 1;
    var next = function () {
      var z = 0, mul = 1, d;
      do {
        d = B64_AT[str.charCodeAt(at++)];
        if (d === undefined) throw new Error('rt: bad object string');
        z += (d & 31) * mul; mul *= 32;
      } while (d & 32);
      return z % 2 ? -(z + 1) / 2 : z / 2;
    };
    while (at < n) {
      id += next();
      var c = next(), k = c & 3, side = (c >> 2 & 3) - 1, x = next() / OBJ_P, y = next() / OBJ_P, a = next() / OBJ_A, b;
      var vx = next() / OBJ_V, vy = next() / OBJ_V, w = next() / OBJ_W;
      var r = { id: id, side: side, reported: -1, k: k, t: k !== OBJ_ROCKET ? next() / OBJ_T : 0 };
      if (k === OBJ_TOMAHAWK) { r.a0 = next() / OBJ_A0; r.fl = c >> 4 & 1; b = tomahawkBody(x, y, r.a0, side); }
      else if (k === OBJ_CIVILIAN || k === OBJ_BALL) { r.ch = k === OBJ_CIVILIAN ? c >> 5 : 0; b = makeFaller(k, x, y, slip); }
      else b = rocketBody(x, y, a, side);
      b.a = a; b.vx = vx; b.vy = vy; b.w = w;
      r.body = b;
      objs.push(r);
    }
    return objs;
  }
  // The whole match as the wire carries it (the contact caches are not sent: a client keeps its own).
  function pack(m) {
    return { k: m.tick, r: m.rng >>> 0, ph: m.phase, rd: m.round, md: m.mods.slice(), ch: m.chars.slice(), sc: m.score.slice(), ts: r4(m.ts),
             tm: r4(m.timer), ps: m.pointShown ? 1 : 0, rdy: [m.ready[0] ? 1 : 0, m.ready[1] ? 1 : 0], lo: m.loser, wi: m.winner, fs: m.flipScale,
             sl: m.slow ? [m.slow.n, r4(m.slow.from), m.slow.final ? 1 : 0] : null,
             p: [packPlayer(m.p[0]), packPlayer(m.p[1])],
             ob: packObjs(m.objs), no: m.nextObj,
             an: r4(m.anim), cm: [m.cam.x, m.cam.y, m.cam.t], fo: [m.fall.k, r4(m.fall.due)] };
  }
  function unpack(m, s) {
    if (s.rd !== m.round) {
      // a round the client has not built yet: build it the same way, then overwrite
      m.round = s.rd - 1;
      m.rng = s.r >>> 0;
      startRound(m, s.rd === 1);
    }
    m.tick = s.k; m.rng = s.r >>> 0; m.phase = s.ph; m.mods = s.md.slice(); m.score = s.sc.slice(); if (Array.isArray(s.ch)) m.chars = s.ch.slice(); m.ts = s.ts;
    m.timer = s.tm; m.pointShown = !!s.ps; m.ready = [!!(s.rdy && s.rdy[0]), !!(s.rdy && s.rdy[1])]; m.loser = s.lo; m.winner = s.wi; m.flipScale = s.fs;
    m.slow = s.sl ? { n: s.sl[0] | 0, from: s.sl[1], final: !!s.sl[2] } : null;
    if (m.slow) m.ts = slowScale(m.slow);           // the curve's own value, not the rounded one
    var fr = m.mods[3] === 1 ? RT.SLIP_FRICTION : RT.FRICTION;
    var jp = m.mods[4] === 1 ? RT.JUMP_ATHLETE : RT.JUMP;
    m.power = m.mods[1] === 1 ? RT.POWER_STRONG : RT.POWER;
    for (var i = 0; i < 2; i++) { unpackPlayer(m.p[i], s.p[i]); m.p[i].body.fr = fr; m.p[i].jump = jp; }
    // the map: a round rebuilt above rolled its own (the rng it had is gone), so build the snapshot's if they differ
    if (m.wm !== m.mods[0]) { m.world = mapOf(m).build(); m.wm = m.mods[0]; m.pairs = {}; }
    if (typeof s.an === 'number') m.anim = s.an;
    for (var j = 0; j < m.world.length; j++) {
      var w = m.world[j];
      if (w.kin) { w.x = w.nx = LIFT.X; w.y = w.ny = LIFT.Y + LIFT.S * liftAt(m.anim); w.vx = w.vy = 0; }
    }
    if (Array.isArray(s.cm)) m.cam = { x: s.cm[0], y: s.cm[1], t: s.cm[2] };
    if (Array.isArray(s.fo)) m.fall = { k: s.fo[0], due: s.fo[1] };
    var keep = {};
    m.objs = unpackObjs(m, typeof s.ob === 'string' ? s.ob : '');
    for (var oi = 0; oi < m.objs.length; oi++) keep['r' + m.objs[oi].id] = true;
    if (typeof s.no === 'number') m.nextObj = s.no;
    for (var pk in m.pairs) {
      var ks = pk.split('#')[0].split(':');
      for (var q = 0; q < ks.length; q++) if (ks[q][0] === 'r' && !keep[ks[q]]) { delete m.pairs[pk]; break; }
    }
  }

  function clone(m) { return JSON.parse(JSON.stringify(m)); }

  var Sim = {
    RT: RT, MOD_NAMES: MOD_NAMES, ROOF_TOP: ROOF_TOP, newMatch: newMatch, tick: tick, begin: begin, startRound: startRound,
    modLabel: modLabel, rollMods: rollMods, muzzle: muzzle, pinPoint: pinPoint, armAngle: armAngle, toWorld: toWorld,
    grounded: grounded, collideBoxes: collideBoxes, shapeXf: shapeXf, rayBox: rayBox, pack: pack, unpack: unpack,
    packPlayer: packPlayer, unpackPlayer: unpackPlayer, clone: clone, rand: rand,
    MAPS: MAPS, mapOf: mapOf, liftAt: liftAt, doorsShut: doorsShut, LIFT: LIFT, collideShapes: collideShapes, rayBody: rayBody,
    shapesOf: shapesOf, MOD_BUILT: MOD_BUILT,
    // the Elevator shaft's y now (the picture's), and whether its doors are shut
    liftY: function (m) { return LIFT.Y + LIFT.S * liftAt(m.anim || 0); },
  };
  if (typeof module === 'object' && module.exports) module.exports = Sim;
  else root.RTSim = Sim;
})(typeof self !== 'undefined' ? self : this);
