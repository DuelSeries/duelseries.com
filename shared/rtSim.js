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
    JUMP_SPIN: 0.05,            // S: PlayerMovement.jump: angular_velocity += randf() * 0.1 - 0.05
    JUMP_LOCK: 0.2,             // S: PlayerMovement.jump: jumpTime += 0.2 (no righting for that long)
    ALIGN_DEADZONE: 5,          // T: Player.align_deadzone 5 (degrees)
    ALIGN_SPEED: 1350,          // T: Player.align_speed 1350
    ALIGN_DAMP: 0.55,           // T: Player.align_damp_force 0.55
    RAY_X: 15, RAY_Y: 27.8, RAY_LEN: 20,   // T: Raycasts/RayCast2DL,R at (-+15, 27.8), cast_to (0, 20)
    // The arm and gun (T: Character.tscn PinJoint2D, Gun.tscn).
    PIN_Y: -58,                 // PlayerBody (0,-82) + PinJoint2D (0,24)
    MUZZLE_X: -6, MUZZLE_Y: 92, // arm body (0,14) from the pin + HoldSpot (0,20) + Gun ShootSpot (-6,58)
    ARM_START: -25,             // S: PlayerShoot.raise_gun: arm_rot = -25 + randf() * 2 - 1 (degrees)
    ARM_SPEED: 360,             // S: PlayerShoot._physics_process: arm_rot + 360 * delta
    ARM_MAX: 200,               // S: min(..., 200)
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
    // The map (T: DefualtMap.tscn + MapNormal.tscn).
    SPAWN_X: 250, SPAWN_Y: -200,           // DefualtMap SpawnPosition (250, -200), x mirrored per seat
    DEATH_Y: 75,                // DefualtMap DeathLine y 75: below it the round is lost
    EDGE_X: 640,                // DefualtMap MapEdge x 640 (the roof's half width)
    // The match (S: GameInfo, Gamemanger, SloMo).
    PLAY_TO: 5,                 // S: GameInfo.play_up_to 5 (SettingsMenu's first choice)
    POINT_AFTER: 2,             // S: Gamemanger.wrap_point: create_timer(2) (scaled seconds)
    NEXT_AFTER: 3,              // S: Gamemanger.wrap_scene: create_timer(3)
    END_AFTER: 3,               // S: Gamemanger.game_over: 2 s then 1 s more before the game-over menu
    SLOW_TO: 0.1, SLOW_FOR: 2, SLOW_RAMP: 0.4,   // S: round_over: SloMo.slow_down(0.1, 2, 0.4)
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

  // ── the round modifiers (S: Customizations.gd) ──
  var MOD_NAMES = [['Elevator', 'House', 'Blimp', 'Cabin'], ['Strong Snipers', 'Rocket Launchers', 'Tomahawks'],
                   ['Civilians', 'Beach Balls'], ['Slippery'], ['Athlete']];
  // Which choices this build plays. A roll that lands on one not built yet plays as the plain choice (C, until built).
  var MOD_BUILT = [[0], [0, 1, 2], [0], [0, 1], [0, 1]];
  function rollMods(m) {
    var c = [];
    for (var i = 0; i < MOD_NAMES.length; i++) {
      var n = MOD_NAMES[i].length;
      var plain = (2.0 / (n + 1) + 1) / 3.0;          // S: get_customization norm_comparison
      var v = rand(m) < plain ? 0 : 1 + Math.floor(rand(m) * n);
      c.push(MOD_BUILT[i].indexOf(v) >= 0 ? v : 0);
    }
    return c;
  }
  function modLabel(c) {
    var names = [];
    for (var i = 0; i < c.length; i++) if (c[i] > 0) names.push(MOD_NAMES[i][c[i] - 1]);
    return names.length ? names.join(' + ') : 'Normal';   // S: name_customization_string
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

  function cs(a) { return [Math.cos(a), Math.sin(a)]; }
  // Body frame -> world (rotation then translation): Godot's Transform2D(angle, pos).xform.
  function toWorld(b, lx, ly) {
    var c = Math.cos(b.a), s = Math.sin(b.a);
    return [b.x + lx * c - ly * s, b.y + lx * s + ly * c];
  }

  // ── the player ──
  function newPlayer(side, fr, jump) {
    return {
      side: side, body: playerBody(RT.SPAWN_X * (side * 2 - 1), RT.SPAWN_Y, fr),
      enabled: false, hasContact: false, upright: true, jumpTime: 0, grounded: false, contactWith: -1,
      raising: false, arm: 0, armBase: 0, held: 0, reloaded: true, cool: 0, jump: jump,
      sx: side === 0 ? -1 : 1,                     // S: set_player_scale(players[0], -1): red faces right
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

  // A new round: the scene reloads (S: wrap_scene -> reload_current_scene). The first round is always Normal
  // (S: Customizations.get_customization returns [0,0,0,0,0] on first play) and waits for both to ready up.
  function startRound(m, first) {
    m.round++;
    m.mods = first ? [0, 0, 0, 0, 0] : rollMods(m);
    var slip = m.mods[3] === 1;
    var fr = slip ? RT.SLIP_FRICTION : RT.FRICTION;
    var jump = m.mods[4] === 1 ? RT.JUMP_ATHLETE : RT.JUMP;
    m.power = m.mods[1] === 1 ? RT.POWER_STRONG : RT.POWER;
    m.world = normalMap();
    var had = m.p;
    m.p = [newPlayer(0, fr, jump), newPlayer(1, fr, jump)];
    /* The press counts run for the whole match (the room's inputs never reset), so a new round's players start
       from the counts already applied: a fresh 0 would replay every earlier press (review 2026-10-28). */
    if (had) for (var q = 0; q < 2; q++) { m.p[q].nj = had[q].nj; m.p[q].nd = had[q].nd; m.p[q].nr = had[q].nr; }
    m.chars = [Math.floor(rand(m) * RT.CHARS), Math.floor(rand(m) * RT.CHARS)];
    m.pairs = {};
    m.objs = [];
    m.flipScale = 1;
    m.ts = 1; m.slow = null; m.timer = 0; m.pointShown = false; m.loser = -1;
    m.phase = first ? 'ready' : 'play';
    m.p[0].enabled = m.p[1].enabled = !first;     // S: start_game enables both (round 1: after ready-up)
    m.ev.push({ e: 'round', r: m.round, mods: m.mods.slice() });
  }

  // ── collision: Godot 3.3's box-box separating axis test and contact generation (E: collision_solver_2d_sat) ──
  // Shapes are tested in coordinates relative to A's origin, as BodyPair2DSW.setup does.
  function shapeXf(b, offx, offy) {
    var c = Math.cos(b.a), s = Math.sin(b.a);
    return { c: c, s: s, x: b.x - offx + b.ox * c - b.oy * s, y: b.y - offy + b.ox * s + b.oy * c, hx: b.hx, hy: b.hy };
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
    var sa = supports(ta, -bx, -by), sb = supports(tb, bx, by);
    var out = [], swap = false, nx = bx, ny = by, pa = sa, pb = sb;
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

  // ── the contact pair (E: BodyPair2DSW), with its contacts kept between steps for warm starting ──
  function pairOf(m, ka, kb) {
    var key = ka + ':' + kb;
    return m.pairs[key] || (m.pairs[key] = { c: [], hit: false });
  }
  function aabbHit(a, b) {
    // a generous circle-around-the-box overlap test stands in for the broadphase (it only decides who is tested)
    var ra = Math.sqrt(a.hx * a.hx + a.hy * a.hy) + Math.sqrt(a.ox * a.ox + a.oy * a.oy) + 2;
    var rb = Math.sqrt(b.hx * b.hx + b.hy * b.hy) + Math.sqrt(b.ox * b.ox + b.oy * b.oy) + 2;
    var dx = a.x - b.x, dy = a.y - b.y;
    return dx * dx + dy * dy < (ra + rb) * (ra + rb);
  }
  function setupPair(pr, A, B, dt, rep) {
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
    var pts = collideBoxes(shapeXf(A, A.x, A.y), shapeXf(B, A.x, A.y));
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
    // Every moving body: the two players, then any rockets in flight (in the order they were fired).
    var dyn = [m.p[0].body, m.p[1].body], keys = ['p0', 'p1'], i, j, b;
    for (i = 0; i < m.objs.length; i++) { dyn.push(m.objs[i].body); keys.push('r' + m.objs[i].id); }
    for (i = 0; i < dyn.length; i++) {
      b = dyn[i];
      if (!b.first) {
        var d = Math.max(0, 1 - dt * RT.LIN_DAMP), ad = Math.max(0, 1 - dt * RT.ANG_DAMP);
        b.vx *= d; b.vy *= d; b.w *= ad;
        b.vy += RT.GRAVITY_BASE * b.gs * dt;
        b.w += b.ii * b.tq * dt;
      }
      b.first = false;
      b.bvx = b.bvy = b.bw = 0;
    }
    // the deepest contact each body reports this step (T: contacts_reported 1)
    var deep = dyn.map(function () { return { d: -1, k: -1 }; });
    var active = [], seen = {};
    var note = function (n, dep, k) { if (dep > deep[n].d) { deep[n].d = dep; deep[n].k = k; } };
    // each body against the map, then the bodies against each other (C: a fixed order for the solver)
    for (i = 0; i < dyn.length; i++) {
      for (j = 0; j < m.world.length; j++) {
        var key = keys[i] + ':w' + j;
        seen[key] = true;
        if (!aabbHit(dyn[i], m.world[j])) { delete m.pairs[key]; continue; }
        var pr = pairOf(m, keys[i], 'w' + j);
        (function (n, wk) {
          if (setupPair(pr, dyn[n], m.world[wk], dt, function (dep) { note(n, dep, 100 + wk); })) active.push([pr, dyn[n], m.world[wk]]);
        })(i, j);
      }
    }
    for (i = 0; i < dyn.length; i++) {
      for (j = i + 1; j < dyn.length; j++) {
        if (!collides(m, i, j)) continue;
        var k2 = keys[i] + ':' + keys[j];
        seen[k2] = true;
        if (!aabbHit(dyn[i], dyn[j])) { delete m.pairs[k2]; continue; }
        var pp = pairOf(m, keys[i], keys[j]);
        (function (x, y) {
          if (setupPair(pp, dyn[x], dyn[y], dt, function (dep) { note(x, dep, idOf(m, y)); note(y, dep, idOf(m, x)); }))
            active.push([pp, dyn[x], dyn[y]]);
        })(i, j);
      }
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
  }
  // Who a dynamic body is, for a contact report: 0 and 1 the players, 1000 + id a rocket.
  function idOf(m, n) { return n < 2 ? n : 1000 + m.objs[n - 2].id; }
  /* Layers and masks (T, S: Player.init, RocketLauncher.shoot): the players collide with each other; a rocket with
     the other player and the other player's rockets, never with its own shooter. */
  function collides(m, i, j) {
    var si = i < 2 ? -1 : m.objs[i - 2].side, sj = j < 2 ? -1 : m.objs[j - 2].side;
    if (i < 2 && j < 2) return true;
    if (i < 2) return sj !== i;
    if (j < 2) return si !== j;
    return si !== sj;
  }

  // ── rays (E: Rect2.intersects_segment against each shape in its own frame) ──
  // Returns the hit parameter t in [0, 1] along from -> to, or -1.
  function rayBox(b, fx, fy, tx, ty) {
    var c = Math.cos(b.a), s = Math.sin(b.a);
    var cx = b.x + b.ox * c - b.oy * s, cy = b.y + b.ox * s + b.oy * c;
    var ax = (fx - cx) * c + (fy - cy) * s, ay = -(fx - cx) * s + (fy - cy) * c;
    var bx = (tx - cx) * c + (ty - cy) * s, by = -(tx - cx) * s + (ty - cy) * c;
    var from = [ax, ay], to = [bx, by], h = [b.hx, b.hy], mn = 0, mx = 1;
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
  function grounded(m, p) {
    var b = p.body;
    for (var k = -1; k <= 1; k += 2) {
      var f = toWorld(b, k * RT.RAY_X, RT.RAY_Y), t = toWorld(b, k * RT.RAY_X, RT.RAY_Y + RT.RAY_LEN);
      for (var j = 0; j < m.world.length; j++) if (rayBox(m.world[j], f[0], f[1], t[0], t[1]) >= 0) return true;
    }
    return false;
  }

  // ── the arm and the shot (S: PlayerShoot.gd, Gun.gd) ──
  function armAngle(p) { return p.body.a + (p.arm * p.sx) * Math.PI / 180; }
  function pinPoint(p) { return toWorld(p.body, 0, RT.PIN_Y); }
  function muzzle(p) {
    var pin = pinPoint(p), a = armAngle(p), c = Math.cos(a), s = Math.sin(a);
    var lx = RT.MUZZLE_X * p.sx, ly = RT.MUZZLE_Y;
    return [pin[0] + lx * c - ly * s, pin[1] + lx * s + ly * c];
  }
  function raise(m, p) {
    if (!p.reloaded || !p.enabled) return;
    p.raising = true;
    p.armBase = RT.ARM_START + rand(m) * 2 - 1;
    p.arm = p.armBase; p.held = 0;
  }
  // held: ticks the button was down, as the shooter saw it (the arm turns 6 degrees a tick).
  function shoot(m, p, held) {
    if (!p.reloaded || !p.raising) return;
    var h = Math.max(0, Math.min(RT.MAX_HELD, held | 0));
    p.arm = Math.min(p.armBase + h * RT.ARM_SPEED * RT.STEP, RT.ARM_MAX);
    p.raising = false; p.reloaded = false; p.cool = RT.RELOAD; p.shots++;
    if (m.mods[1] === 2) { fireRocket(m, p); return; }
    var o = m.p[1 - p.side];
    var a = armAngle(p), dx = -Math.sin(a), dy = Math.cos(a);              // the gun's +y axis in the world
    var f = muzzle(p), tx = f[0] + dx * RT.RAY_RANGE, ty = f[1] + dy * RT.RAY_RANGE;
    var best = 2, who = -1;
    for (var j = 0; j < m.world.length; j++) { var t = rayBox(m.world[j], f[0], f[1], tx, ty); if (t >= 0 && t < best) { best = t; who = 100 + j; } }
    var to = rayBox(o.body, f[0], f[1], tx, ty);
    if (to >= 0 && to < best) { best = to; who = o.side; }
    var hx = f[0] + (tx - f[0]) * Math.min(best, 1), hy = f[1] + (ty - f[1]) * Math.min(best, 1);
    if (who === o.side) {
      // S: col.apply_impulse(hit - col.global_position, ray.global_transform.y * power)
      impulse(o.body, hx - o.body.x, hy - o.body.y, dx * m.power, dy * m.power);
    }
    m.ev.push({ e: 'shot', s: p.side, f: [f[0], f[1]], h: [hx, hy], hit: who === o.side ? 1 : 0, strong: m.power > RT.POWER ? 1 : 0 });
  }
  // S: RocketLauncher.shoot: a rocket from the launcher's mouth, flying along it at 750, turned to face its way.
  function fireRocket(m, p) {
    var pin = pinPoint(p), a = armAngle(p), c = Math.cos(a), sn = Math.sin(a);
    var lx = RT.ROCKET_MX * p.sx, ly = RT.ROCKET_MY;
    var b = boxBody(pin[0] + lx * c - ly * sn, pin[1] + lx * sn + ly * c, RT.ROCKET_HX, RT.ROCKET_HY, 0, 0, 1, 0);
    b.dyn = true; b.first = true; b.gs = 0; b.a = Math.atan2(Math.sin(a - Math.PI / 2), Math.cos(a - Math.PI / 2));
    var w = 2 * RT.ROCKET_HX, hh = 2 * RT.ROCKET_HY;
    b.im = 1; b.ii = 12 / (w * w + hh * hh);
    b.vx = -Math.sin(a) * RT.ROCKET_SPEED; b.vy = Math.cos(a) * RT.ROCKET_SPEED;
    var r = { id: m.nextObj++, side: p.side, body: b, reported: -1 };
    m.objs.push(r);
    m.ev.push({ e: 'rocket', s: p.side, id: r.id, f: [b.x, b.y] });
  }
  // S: Rocket._on_Rocket_body_entered, after the step that touched something: a push along its flight to a body
  // that can move, then the blast, and the rocket is gone.
  function rocketHits(m) {
    for (var i = m.objs.length - 1; i >= 0; i--) {
      var r = m.objs[i], b = r.body;
      if (r.reported >= 0) {
        var target = r.reported < 2 ? m.p[r.reported].body : null;
        if (r.reported >= 1000) for (var k = 0; k < m.objs.length; k++) if (1000 + m.objs[k].id === r.reported) target = m.objs[k].body;
        var sp = Math.hypot(b.vx, b.vy) || 1;
        if (target && target.dyn) impulse(target, b.x - target.x, b.y - target.y, b.vx / sp * RT.ROCKET_BLAST, b.vy / sp * RT.ROCKET_BLAST);
        m.ev.push({ e: 'boom', s: r.side, x: b.x, y: b.y, hit: r.reported < 2 ? 1 : 0 });
        m.objs.splice(i, 1);
      } else if (Math.abs(b.x) > RT.ROCKET_FAR || Math.abs(b.y) > RT.ROCKET_FAR) m.objs.splice(i, 1);
    }
  }
  function jump(m, p) {
    if (!grounded(m, p)) return;             // S: PlayerMovement.jump: only when a foot ray touches
    var b = p.body, ux = Math.sin(b.a), uy = -Math.cos(b.a);
    b.vx += ux * p.jump * b.im; b.vy += uy * p.jump * b.im;     // apply_impulse at the origin: no spin from it
    b.tq = 0;
    b.w += rand(m) * 2 * RT.JUMP_SPIN - RT.JUMP_SPIN;
    p.jumpTime += RT.JUMP_LOCK;
    m.ev.push({ e: 'jump', s: p.side });
  }

  // S: PlayerMovement._integrate_forces / align, run between physics steps.
  function align(p) {
    if (!p.enabled) return;
    if (!(p.jumpTime <= 0 && (p.hasContact || p.grounded))) return;
    var b = p.body, deg = b.a * 180 / Math.PI;
    if (Math.abs(deg) < RT.ALIGN_DEADZONE) {
      if (Math.abs(b.w) > 0.05 && p.upright === false) {
        b.tq = 0;
        b.w *= (1 - RT.ALIGN_DAMP);
        p.upright = true;
      }
      return;
    }
    b.tq += Math.max(-1, Math.min(1, -deg / 90)) * RT.ALIGN_SPEED;   // add_torque ADDS to the standing torque
    p.upright = false;
  }

  // ── one tick of the whole game (the order Godot 3.3's main loop runs things in) ──
  // inputs[side]: running counts { j: jump presses, d: shoot presses, r: shoot releases, n: ticks the last shot was
  // held }. Each tick takes at most one of each kind that has not been applied yet, so a tap shorter than a tick
  // still counts, and the server and a client replaying the same counts agree.
  function tick(m, inputs) {
    m.ev = [];
    m.tick++;
    var dt = RT.STEP * m.ts, i, p;
    // 1. after the last step: each body's _integrate_forces, then its contact signals (has_contact)
    for (i = 0; i < 2; i++) {
      p = m.p[i];
      align(p);
      var now = p.reported === undefined ? -1 : p.reported;
      if (now !== p.contactWith) {
        if (p.contactWith >= 0) p.hasContact = false;     // body_exited
        if (now >= 0) p.hasContact = true;                // body_entered (additions run after removals)
        p.contactWith = now;
      }
    }
    rocketHits(m);
    // 2. _physics_process: the foot rays, then the arm turning, then the shoot button
    for (i = 0; i < 2; i++) m.p[i].grounded = grounded(m, m.p[i]);
    var want = [{ j: false }, { j: false }];
    for (i = 0; i < 2; i++) {
      p = m.p[i];
      if (p.raising) { p.arm = Math.min(p.arm + RT.ARM_SPEED * dt, RT.ARM_MAX); p.held++; }
      var inp = inputs && inputs[i];
      if (!inp) continue;
      if ((inp.d | 0) > p.nd) { p.nd++; raise(m, p); }
      /* The aim is the hold the SERVER saw, tick for tick (the arm turns from the press it applied to the release
         it applied). A hold the client names is never believed: a modified client could otherwise fire at any
         angle it had swept past (review 2026-10-28). */
      if ((inp.r | 0) > p.nr) { p.nr++; if (p.enabled) shoot(m, p, p.held); }
      /* One jump per press, and a backlog of presses is one press: several counted at once would stack impulses
         while the feet are still near the roof (a "super jump", review 2026-10-28). */
      if ((inp.j | 0) > p.nj) { p.nj = inp.j | 0; want[i].j = true; }
    }
    // 3. the physics step
    physics(m, dt);
    // 4. _process: the rules first (the scene root), then each player's timers and the jump key
    if (m.phase === 'ready') {
      for (i = 0; i < 2; i++) if (want[i].j && !m.ready[i]) { m.ready[i] = true; m.ev.push({ e: 'ready', s: i }); }
    }
    checkFlip(m);
    if (m.phase === 'play') checkDeath(m);
    for (i = 0; i < 2; i++) {
      p = m.p[i];
      if (p.jumpTime > 0) p.jumpTime -= dt;
      if (p.enabled) {
        if (p.cool > 0) p.cool -= dt;
        else if (!p.reloaded) { p.reloaded = true; p.cool = RT.RELOAD; }   // S: reload() restarts the cooldown
        if (want[i].j) jump(m, p);
      }
    }
    slowMo(m);
    if (m.phase === 'down' || m.phase === 'end') roundTimers(m, dt);
    return m.ev;
  }

  // Both ready (or the ready wait ran out): the first round starts (S: ReadyUpManager -> Gamemanger.start_game).
  function begin(m) {
    if (m.phase !== 'ready') return;
    m.phase = 'play';
    m.p[0].enabled = m.p[1].enabled = true;
    m.ev.push({ e: 'go' });
  }

  function checkFlip(m) {
    var p0 = m.p[0].body, p1 = m.p[1].body;
    if ((p1.x - p0.x > RT.FLIP_GAP * -m.flipScale) !== (m.flipScale > 0)) {
      m.flipScale *= -1;
      m.p[0].sx = -m.flipScale; m.p[1].sx = m.flipScale;
    }
  }

  // S: check_death: the first player found below the line loses the round. Both on the same tick: the lower one
  // loses (C: the reference checks red first, which would favour blue in a paid match).
  function checkDeath(m) {
    var d0 = m.p[0].body.y > RT.DEATH_Y, d1 = m.p[1].body.y > RT.DEATH_Y;
    if (!d0 && !d1) return;
    var loser = d0 && d1 ? (m.p[0].body.y >= m.p[1].body.y ? 0 : 1) : d0 ? 0 : 1;
    m.phase = 'down';
    m.loser = loser;
    m.timer = 0;
    m.score[1 - loser]++;                       // S: round_over: scores[1 - player_id] += 1
    m.p[0].enabled = m.p[1].enabled = false;
    m.p[0].raising = m.p[1].raising = false;
    m.slow = { t: 0, cur: m.ts, back: false, wait: -1 };
    if (m.score[1 - loser] >= RT.PLAY_TO) m.winner = 1 - loser;
    m.ev.push({ e: 'fall', s: loser, score: m.score.slice() });
  }

  // S: SloMo.slow_down(0.1, 2, 0.4), frame by frame (its total_time counts real time: scaled delta / speed).
  function slowMo(m) {
    var s = m.slow;
    if (!s) return;
    var real = RT.STEP;
    if (!s.back && s.wait < 0) {
      s.t += real;
      s.cur = s.cur + (RT.SLOW_TO - s.cur) * (s.t / RT.SLOW_RAMP);
      m.ts = s.cur;
      if (s.t >= RT.SLOW_RAMP) {
        if (s.final) { m.slow = null; return; }                  // the game-over slow-down never comes back (S)
        s.wait = Math.max(RT.SLOW_FOR - RT.SLOW_RAMP * 2, 0) * RT.SLOW_TO;   // a scaled-time timer
      }
      return;
    }
    if (s.wait >= 0 && !s.back) {
      s.wait -= real * m.ts;
      if (s.wait <= 0) s.back = true;
      return;
    }
    s.t -= real;
    s.cur = 1 + (RT.SLOW_TO - 1) * Math.max(0, s.t / RT.SLOW_RAMP);
    m.ts = s.cur;
    if (s.t <= 0) { m.ts = 1; m.slow = null; }
  }

  function roundTimers(m, dt) {
    m.timer += dt;
    if (m.phase === 'down' && !m.pointShown && m.timer >= RT.POINT_AFTER) {
      m.pointShown = true;
      m.ev.push({ e: 'point', s: 1 - m.loser, score: m.score.slice() });
    }
    if (m.phase === 'down' && m.winner >= 0 && m.pointShown) {
      // S: game_over: the slow-down again after 1 s more, then the menu
      if (m.timer >= RT.END_AFTER) { m.phase = 'end'; m.slow = { t: 0, cur: m.ts, back: false, wait: -1, final: true }; m.ev.push({ e: 'end', w: m.winner, score: m.score.slice() }); }
      return;
    }
    if (m.phase === 'down' && m.winner < 0 && m.timer >= RT.NEXT_AFTER) startRound(m, false);
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
  // The whole match as the wire carries it (the contact caches are not sent: a client keeps its own).
  function pack(m) {
    return { k: m.tick, r: m.rng >>> 0, ph: m.phase, rd: m.round, md: m.mods.slice(), ch: m.chars.slice(), sc: m.score.slice(), ts: r4(m.ts),
             tm: r4(m.timer), ps: m.pointShown ? 1 : 0, rdy: [m.ready[0] ? 1 : 0, m.ready[1] ? 1 : 0], lo: m.loser, wi: m.winner, fs: m.flipScale,
             sl: m.slow ? [r4(m.slow.t), r4(m.slow.cur), m.slow.back ? 1 : 0, r4(m.slow.wait), m.slow.final ? 1 : 0] : null,
             p: [packPlayer(m.p[0]), packPlayer(m.p[1])],
             o: m.objs.map(function (r) { var b = r.body; return [r.id, r.side, r2(b.x), r2(b.y), r4(b.a), r2(b.vx), r2(b.vy), r4(b.w)]; }), no: m.nextObj };
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
    m.slow = s.sl ? { t: s.sl[0], cur: s.sl[1], back: !!s.sl[2], wait: s.sl[3], final: !!s.sl[4] } : null;
    var fr = m.mods[3] === 1 ? RT.SLIP_FRICTION : RT.FRICTION;
    var jp = m.mods[4] === 1 ? RT.JUMP_ATHLETE : RT.JUMP;
    m.power = m.mods[1] === 1 ? RT.POWER_STRONG : RT.POWER;
    for (var i = 0; i < 2; i++) { unpackPlayer(m.p[i], s.p[i]); m.p[i].body.fr = fr; m.p[i].jump = jp; }
    var keep = {};
    m.objs = (s.o || []).map(function (o) {
      var b = boxBody(o[2], o[3], RT.ROCKET_HX, RT.ROCKET_HY, 0, 0, 1, 0);
      b.dyn = true; b.gs = 0; b.a = o[4]; b.vx = o[5]; b.vy = o[6]; b.w = o[7];
      var w = 2 * RT.ROCKET_HX, hh = 2 * RT.ROCKET_HY; b.im = 1; b.ii = 12 / (w * w + hh * hh);
      keep['r' + o[0]] = true;
      return { id: o[0], side: o[1], body: b, reported: -1 };
    });
    if (typeof s.no === 'number') m.nextObj = s.no;
    for (var pk in m.pairs) { var ks = pk.split(':'); for (var q = 0; q < ks.length; q++) if (ks[q][0] === 'r' && !keep[ks[q]]) { delete m.pairs[pk]; break; } }
  }

  function clone(m) { return JSON.parse(JSON.stringify(m)); }

  var Sim = {
    RT: RT, MOD_NAMES: MOD_NAMES, ROOF_TOP: ROOF_TOP, newMatch: newMatch, tick: tick, begin: begin, startRound: startRound,
    modLabel: modLabel, rollMods: rollMods, muzzle: muzzle, pinPoint: pinPoint, armAngle: armAngle, toWorld: toWorld,
    grounded: grounded, collideBoxes: collideBoxes, shapeXf: shapeXf, rayBox: rayBox, pack: pack, unpack: unpack,
    packPlayer: packPlayer, unpackPlayer: unpackPlayer, clone: clone, rand: rand,
  };
  if (typeof module === 'object' && module.exports) module.exports = Sim;
  else root.RTSim = Sim;
})(typeof self !== 'undefined' ? self : this);
