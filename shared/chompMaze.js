// Chomp's maze: one module (our own layout, 28 x 31 tiles like the arcade's playfield, in the same style: corridors
// one tile wide, no dead ends, wall blocks at least two tiles thick, a ghost house in the middle, side tunnels) tiled
// into an arena of MODULES_X x MODULES_Y modules. Side tunnels join modules left and right, the tunnels in the top and
// bottom borders join them up and down, and the arena's outer edge is sealed (so it never has a dead end).
//
// Units are tiles. Tile (c, r) covers [c, c+1) x [r, r+1); its centre is (c + 0.5, r + 0.5).
// Server and browser build the same arena from the same table, so only the dots ever travel on the wire.
(function (root) {
  'use strict';

  // '#' wall  '.' dot  'o' energizer  '_' path, no dot  't' tunnel (ghosts slow down)  'H' house wall  'g' house  '=' door
  var MODULE = [
    '#####t################t#####',
    '#............##............#',
    '#.###.######.##.######.###.#',
    '#.###.######.##.######.###.#',
    '#o........................o#',
    '#.###.###.########.###.###.#',
    '#.###.###.########.###.###.#',
    '#.....###....##....###.....#',
    '#.###.######.##.######.###.#',
    '#.###.######.##.######.###.#',
    '#.###.######.##.######.###.#',
    '#.....###__________###.....#',
    '#####.###_HHH==HHH_###.#####',
    '#####.###_HggggggH_###.#####',
    'tttt______HggggggH______tttt',
    '#####.###_HggggggH_###.#####',
    '#####.###_HHHHHHHH_###.#####',
    '#####....__________....#####',
    '#####.###.########.###.#####',
    '#####.###.########.###.#####',
    '#............##............#',
    '#.###.######.##.######.###.#',
    '#.###.######.##.######.###.#',
    '#.....###..........###.....#',
    '#####.###.########.###.#####',
    '#####.###.########.###.#####',
    '#o....###....##....###....o#',
    '#.###.######.##.######.###.#',
    '#.###.######.##.######.###.#',
    '#..........................#',
    '#####t################t#####'
  ];
  var MW = 28, MH = 31;

  // Places inside a module (tile units, module-local). The house box is the wall ring rows 12..16, cols 10..17.
  var HOUSE = { c0: 10, r0: 12, c1: 17, r1: 16, doorX: 14, outY: 11.5, inY: 14.5 };
  // Start spots: Blinky outside above the door, the others inside (DOSSIER Chapter 4 layout, our house).
  var GHOST_START = {
    blinky: { x: 14, y: 11.5 },
    pinky: { x: 14, y: 14.5 },
    inky: { x: 12, y: 14.5 },
    clyde: { x: 16, y: 14.5 }
  };
  // DOSSIER scatter figure: Blinky top right, Pinky top left, Inky bottom right, Clyde bottom left, each target tile
  // in the dead space past the maze (3 rows above the top, 2 below the bottom on the 28 x 36 screen).
  var SCATTER = { blinky: [25, -3], pinky: [2, -3], inky: [27, 32], clyde: [0, 32] };
  var FRUIT = { x: 14, y: 17.5 };          // below the house, as in the arcade
  var SPAWN = { x: 14, y: 23.5 };          // the module's own start spot, below the fruit

  var WALL = 0, PATH = 1, TUNNEL = 2, HWALL = 3, HOUSE_IN = 4, DOOR = 5;
  var DOT = 1, ENERGIZER = 2;

  function build(mx, my) {
    var W = MW * mx, H = MH * my;
    var cell = new Uint8Array(W * H);
    var dot0 = new Uint8Array(W * H);
    var moduleOf = new Uint16Array(W * H);
    var modules = [];
    for (var j = 0; j < my; j++) for (var i = 0; i < mx; i++) {
      var ox = i * MW, oy = j * MH, m = modules.length;
      modules.push({ i: i, j: j, ox: ox, oy: oy, index: m });
      for (var r = 0; r < MH; r++) for (var c = 0; c < MW; c++) {
        var ch = MODULE[r][c], k = (oy + r) * W + ox + c, v = WALL;
        if (ch === '.') { v = PATH; dot0[k] = DOT; }
        else if (ch === 'o') { v = PATH; dot0[k] = ENERGIZER; }
        else if (ch === '_') v = PATH;
        else if (ch === 't') v = TUNNEL;
        else if (ch === 'H') v = HWALL;
        else if (ch === 'g') v = HOUSE_IN;
        else if (ch === '=') v = DOOR;
        // Seal the arena's outer edge: the side tunnel stub (cols 0..4 / 23..27 of row 14) and the border tunnels.
        if (i === 0 && r === 14 && c <= 4) v = WALL;
        if (i === mx - 1 && r === 14 && c >= MW - 5) v = WALL;
        if (j === 0 && r === 0) v = WALL;
        if (j === my - 1 && r === MH - 1) v = WALL;
        cell[k] = v;
        moduleOf[k] = m;
      }
    }
    var a = {
      W: W, H: H, mx: mx, my: my, MW: MW, MH: MH, cell: cell, dot0: dot0, moduleOf: moduleOf, modules: modules,
      idx: function (c, r) { return r * W + c; },
      inside: function (c, r) { return c >= 0 && r >= 0 && c < W && r < H; },
      // a chomper (and a ghost on the grid) may stand here
      walk: function (c, r) {
        if (c < 0 || r < 0 || c >= W || r >= H) return false;
        var v = cell[r * W + c];
        return v === PATH || v === TUNNEL;
      },
      tunnel: function (c, r) { return c >= 0 && r >= 0 && c < W && r < H && cell[r * W + c] === TUNNEL; },
      wallish: function (c, r) {
        if (c < 0 || r < 0 || c >= W || r >= H) return true;
        return cell[r * W + c] === WALL;
      },
      moduleAt: function (x, y) {
        var c = Math.max(0, Math.min(W - 1, Math.floor(x))), r = Math.max(0, Math.min(H - 1, Math.floor(y)));
        return modules[moduleOf[r * W + c]];
      }
    };
    return a;
  }

  var M = {
    MODULE: MODULE, MW: MW, MH: MH, HOUSE: HOUSE, GHOST_START: GHOST_START, SCATTER: SCATTER, FRUIT: FRUIT, SPAWN: SPAWN,
    WALL: WALL, PATH: PATH, TUNNEL: TUNNEL, HWALL: HWALL, HOUSE_IN: HOUSE_IN, DOOR: DOOR, DOT: DOT, ENERGIZER: ENERGIZER,
    build: build
  };
  if (typeof module === 'object' && module.exports) module.exports = M;
  else root.ChompMaze = M;
})(typeof self !== 'undefined' ? self : this);
