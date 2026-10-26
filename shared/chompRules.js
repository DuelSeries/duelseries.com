// Chomp (the hidden Pac-Man-style arena, /chomp): every rule number in one place, server and browser alike.
//
// Each number is tagged with where it came from:
//   DOSSIER  Jamey Pittman, "The Pac-Man Dossier" (pacman.holenet.info), the public write-up of the arcade game's
//            behaviour. Table A.1 (level 1 row), the scatter/chase table, the cornering and ghost AI chapters.
//   ARENA    a dossier rule scaled to a shared arena with many players (the arcade has one Pac-Man and one maze).
//   CHOSEN   ours: the dossier does not state it (or the arcade has no such thing). Owen can change any of these.
//
// Only the gameplay is matched. The maze is our own layout (shared/chompMaze.js), the art is drawn in code and the
// sounds are synthesized; no ROM graphics, sprite sheets, sound files, the original maze, or the name are used.
(function (root) {
  'use strict';

  // DOSSIER Table A.1 header: "100% speed = 75.75757625 pixels/sec", 8 px tiles (Chapter 2: tiles are 8 x 8 px).
  var TILE_PX = 8;
  var FULL_SPEED = 75.75757625 / TILE_PX;          // tiles per second at 100% (9.4697)

  var R = {
    TILE_PX: TILE_PX,
    FULL_SPEED: FULL_SPEED,

    // ---- the sim clock
    TICK_HZ: 60,                 // DOSSIER: the arcade runs 60 frames a second (60.606 Hz refresh); our sim ticks at 60
    SNAP_HZ: 20,                 // CHOSEN: snapshots per second to each browser (the other games send 20 to 30)
    INTERP_MS: 110,              // CHOSEN: how far behind the newest snapshot the browser draws other entities

    // ---- speeds, level 1 row of Table A.1 (fractions of FULL_SPEED)
    PAC_SPEED: 0.80,             // DOSSIER "Pac-Man Speed" 80%
    PAC_FRIGHT_SPEED: 0.90,      // DOSSIER "Fright. Pac-Man Speed" 90% (while your power pellet lasts)
    GHOST_SPEED: 0.75,           // DOSSIER "Ghost Speed" 75%
    GHOST_TUNNEL_SPEED: 0.40,    // DOSSIER "Ghost Tunnel Speed" 40%
    GHOST_FRIGHT_SPEED: 0.50,    // DOSSIER "Fright. Ghost Speed" 50%
    GHOST_EYES_SPEED: 1.50,      // CHOSEN: eyes rushing home (the dossier gives no number)
    GHOST_HOUSE_SPEED: 0.40,     // CHOSEN: bobbing and leaving the house (not stated)
    // The "Pac-Man Dots Speed" ~71% column is not a separate number: it is what the dot pause below does to 80%.
    DOT_PAUSE_TICKS: 1,          // DOSSIER: "stops moving for one frame" per dot
    ENERGIZER_PAUSE_TICKS: 3,    // DOSSIER: "three frames" per energizer

    // ---- cornering (DOSSIER Chapter 3): pre-turn and post-turn windows of 3 to 4 px on an 8 px tile, i.e. a turn
    // pressed anywhere in the tile that has the opening is taken, and Pac-Man cuts the corner diagonally.
    TURN_WINDOW: 4 / TILE_PX,    // DOSSIER, in tiles from the tile centre (4 px)

    // ---- points (DOSSIER Chapter 1)
    DOT_POINTS: 10,
    ENERGIZER_POINTS: 50,
    GHOST_POINTS: [200, 400, 800, 1600],   // DOSSIER: successive ghosts on one energizer
    PLAYER_POINTS: [200, 400, 800, 1600],  // ARENA: a player eaten counts on the same chain as a ghost
    FRUIT_POINTS: 100,                     // DOSSIER Table A.1 level 1 bonus: Cherries, 100
    EXTRA_LIFE_AT: 10000,                  // DOSSIER Chapter 1: the default bonus life at 10,000 points
    BONUS_LIFE: false,                     // Owen 2026-10-25: off, with one life there is no bonus life
    LIVES: 1,                              // Owen 2026-10-25: one life, like slither.io (the arcade default is 3)

    // ---- fright (power pellet), level 1
    FRIGHT_S: 6,                 // DOSSIER Table A.1 "Fright. Time" 6 s
    FRIGHT_FLASHES: 5,           // DOSSIER Table A.1 "# of Flashes" 5
    FLASH_PERIOD_S: 0.4,         // CHOSEN: one blue-white flash (the dossier gives no frame count)
    FRIGHT_RADIUS: 18,           // ARENA: ghosts within this many tiles of the eater turn blue (the arcade has one screen)

    // ---- scatter / chase, level 1 column (seconds). DOSSIER: S7 C20 S7 C20 S5 C20 S5 then chase for ever.
    // ARENA: an endless arena loops the list instead of chasing for ever.
    MODES: [['scatter', 7], ['chase', 20], ['scatter', 7], ['chase', 20], ['scatter', 5], ['chase', 20], ['scatter', 5], ['chase', 20]],

    // ---- the ghost house (DOSSIER Chapter 4): Pinky's dot limit 0, Inky 30, Clyde 60 on level 1, and a ghost leaves
    // anyway after 4 s with no dot eaten. ARENA: counted per maze module (each module has its own house and quartet).
    HOUSE_DOT_LIMIT: { pinky: 0, inky: 30, clyde: 60 },
    HOUSE_TIMER_S: 4,

    // ---- ghost targeting (DOSSIER Chapter 4)
    PINKY_AHEAD: 4,              // DOSSIER: four tiles ahead (moving up: also four left, the overflow bug)
    INKY_AHEAD: 2,               // DOSSIER: two tiles ahead, the vector from Blinky doubled
    CLYDE_NEAR: 8,               // DOSSIER: eight tiles or more, chase; closer, his scatter corner
    GHOST_SENSE: 22,             // ARENA: a ghost chases the nearest player within this many tiles, else scatters

    // ---- fruit (DOSSIER Chapter 1): after 70 and 170 dots, on screen 9 to 10 s. ARENA: per module, the count loops.
    FRUIT_AT: [70, 170],
    FRUIT_S: [9, 10],

    // ---- the arena (all ARENA / CHOSEN)
    MODULES_X: 3,                // CHOSEN: modules across and down (each one 28 x 31 tiles with its own four ghosts)
    MODULES_Y: 3,
    DOT_RESPAWN_S: 30,           // CHOSEN: an eaten dot comes back after this long
    ENERGIZER_RESPAWN_S: 40,     // CHOSEN
    RESPAWN_CLEAR: 4,            // CHOSEN: a pellet only reappears with no player within this many tiles
    DEATH_S: 1.6,                // CHOSEN: the death animation before you come back
    SPAWN_SAFE_S: 3,             // CHOSEN: invulnerable (blinking) after coming back
    SPAWN_GHOST_CLEAR: 8,        // CHOSEN: spawn at least this many tiles from any dangerous ghost
    MAX_PLAYERS: 40,             // CHOSEN: seats per room
    BOT_FILL: 8,                 // CHOSEN: bots top the room up to this many chompers
    LATE_TURN_TICKS: 15,         // CHOSEN: how far back (250 ms) the server honours a turn the browser already took

    // ---- directions: index order is the dossier's tie-break order "up, left, down, right"
    DIRS: [[0, -1], [-1, 0], [0, 1], [1, 0]]
  };

  R.speed = function (frac) { return frac * FULL_SPEED; };

  if (typeof module === 'object' && module.exports) module.exports = R;
  else root.ChompRules = R;
})(typeof self !== 'undefined' ? self : this);
