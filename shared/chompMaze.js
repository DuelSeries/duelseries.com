// Chomp's maze: one module (our own layout, 28 x 31 tiles like the arcade's playfield, in the same style: corridors
// one tile wide, no dead ends, wall blocks at least two tiles thick, a ghost house in the middle, side tunnels) tiled
// into an arena of MODULES_X x MODULES_Y modules. Side tunnels join modules left and right, the tunnels in the top and
// bottom borders join them up and down, and the arena's outer edge is sealed (so it never has a dead end).
//
// build(mx, my, { wrap: true }) makes the arena a torus (Owen 2026-10-26: "one continuous map, it works like a globe"):
// every module keeps a spacer to its right and below, the last ones included, and the tunnels through those spacers
// run on into the first module across the seam, so walking off any edge comes back on the opposite one. Tile helpers
// then wrap: walk, tunnel, wallish, moduleAt and k(c, r) take any integer tile, dx/dy give the shortest signed step
// from a to b across the seam.
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

  // Modules sit one tile apart (GAP): the spacer is wall, so every module keeps the arcade's full double frame, with
  // the tunnels running on through the spacer to the next module.
  var GAP = 1;

  function build(mx, my, opts) {
    var wrap = !!(opts && opts.wrap);
    var W = wrap ? (MW + GAP) * mx : MW * mx + GAP * (mx - 1), H = wrap ? (MH + GAP) * my : MH * my + GAP * (my - 1);
    var cell = new Uint8Array(W * H);          // all WALL to start: the spacers stay wall
    var dot0 = new Uint8Array(W * H);
    var moduleOf = new Uint16Array(W * H);
    var spacer = new Uint8Array(W * H).fill(1);
    var modules = [];
    for (var j = 0; j < my; j++) for (var i = 0; i < mx; i++) {
      var ox = i * (MW + GAP), oy = j * (MH + GAP), m = modules.length;
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
        // A torus has no outer edge: every tunnel runs on across the seam.
        if (!wrap && i === 0 && r === 14 && c <= 4) v = WALL;
        if (!wrap && i === mx - 1 && r === 14 && c >= MW - 5) v = WALL;
        if (!wrap && j === 0 && r === 0) v = WALL;
        if (!wrap && j === my - 1 && r === MH - 1) v = WALL;
        cell[k] = v;
        moduleOf[k] = m;
        spacer[k] = 0;
      }
      // the tunnels through the spacer to the right and below, and the module that owns those tiles
      if (wrap || i < mx - 1) { var kr = (oy + 14) * W + ox + MW; cell[kr] = TUNNEL; }
      if (wrap || j < my - 1) [5, MW - 6].forEach(function (c2) { cell[(oy + MH) * W + ox + c2] = TUNNEL; });
      for (var rr = 0; rr < MH + GAP; rr++) for (var cc = 0; cc < MW + GAP; cc++) {
        var y2 = oy + rr, x2 = ox + cc;
        if (x2 < W && y2 < H && (rr >= MH || cc >= MW)) moduleOf[y2 * W + x2] = m;
      }
    }
    function wc(c) { return wrap ? ((c % W) + W) % W : c; }
    function wr(r) { return wrap ? ((r % H) + H) % H : r; }
    var a = {
      W: W, H: H, mx: mx, my: my, MW: MW, MH: MH, GAP: GAP, cell: cell, dot0: dot0, moduleOf: moduleOf, spacer: spacer, modules: modules,
      wrap: wrap,
      wc: wc, wr: wr,
      // the tile key of any tile (wrapped on a torus)
      k: function (c, r) { return wr(r) * W + wc(c); },
      idx: function (c, r) { return r * W + c; },
      inside: function (c, r) { return c >= 0 && r >= 0 && c < W && r < H; },
      // a chomper (and a ghost on the grid) may stand here
      walk: function (c, r) {
        c = wc(c); r = wr(r);
        if (c < 0 || r < 0 || c >= W || r >= H) return false;
        var v = cell[r * W + c];
        return v === PATH || v === TUNNEL;
      },
      tunnel: function (c, r) { c = wc(c); r = wr(r); return c >= 0 && r >= 0 && c < W && r < H && cell[r * W + c] === TUNNEL; },
      wallish: function (c, r) {
        c = wc(c); r = wr(r);
        if (c < 0 || r < 0 || c >= W || r >= H) return true;
        return cell[r * W + c] === WALL;
      },
      moduleAt: function (x, y) {
        var c = wrap ? wc(Math.floor(x)) : Math.max(0, Math.min(W - 1, Math.floor(x)));
        var r = wrap ? wr(Math.floor(y)) : Math.max(0, Math.min(H - 1, Math.floor(y)));
        return modules[moduleOf[r * W + c]];
      },
      // the shortest signed step from a to b along x (or y): across the seam on a torus
      dx: function (a1, b1) { var d = b1 - a1; return wrap ? d - W * Math.round(d / W) : d; },
      dy: function (a1, b1) { var d = b1 - a1; return wrap ? d - H * Math.round(d / H) : d; },
      // a position back on the map (x in [0, W), y in [0, H)) on a torus; as it is otherwise
      wx: function (x) { return wrap ? x - W * Math.floor(x / W) : x; },
      wy: function (y) { return wrap ? y - H * Math.floor(y / H) : y; }
    };
    return a;
  }

  var M = {
    MODULE: MODULE, MW: MW, MH: MH, GAP: GAP, HOUSE: HOUSE, GHOST_START: GHOST_START, SCATTER: SCATTER, FRUIT: FRUIT, SPAWN: SPAWN,
    WALL: WALL, PATH: PATH, TUNNEL: TUNNEL, HWALL: HWALL, HOUSE_IN: HOUSE_IN, DOOR: DOOR, DOT: DOT, ENERGIZER: ENERGIZER,
    build: build
  };
  if (typeof module === 'object' && module.exports) module.exports = M;
  else root.ChompMaze = M;
})(typeof self !== 'undefined' ? self : this);
