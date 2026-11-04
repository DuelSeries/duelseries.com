// Pac-Man lab (branch chomp-rethink, never served by the real server): maze tables and an arena builder that
// produces the same arena object as shared/chompMaze.js build(), so the real game's arcade renderer
// (public/js/chomp/chompPixel.js) and wall tracer (shared/chompWalls.js) draw it unchanged.
//
// Tables use chompMaze's letters: '#' wall  '.' dot  'o' energizer  '_' path, no dot  't' tunnel  'H' house wall
// 'g' house  '=' door. Every table is 28 x 31 with the ghost house where chompMaze's is (the wall tracer expects it).
(function (root) {
  'use strict';
  var Maze = (typeof module === 'object' && module.exports) ? require('../../shared/chompMaze') : root.ChompMaze;

  // Our own layouts, drawn for this lab.
  var C = '#..........................#';
  var B1 = '#.####.#####.##.#####.####.#';
  var B1o = '#o####.#####.##.#####.####o#';
  var B2 = '#.##.#####.######.#####.##.#';
  var MID = [
    '#........__________........#',
    '#########_HHH==HHH_#########',
    '#########_HggggggH_#########',
    'tttt______HggggggH______tttt',
    '#########_HggggggH_#########',
    '#########_HHHHHHHH_#########',
    '#........__________........#'
  ];
  var EDGE = '############################';
  // BRICK: a dense lattice, about 70 junctions (the arcade maze has about 60): lots of corners to cut and lots of
  // ways out, so a chase between players is a real chase. Used by Royale and the Train Duel.
  var BRICK = [EDGE, C, B1, B1o, C, B2, B2, C, B1, B1, B1].concat(MID, [B2, B2, C, B1, B1, C, B2, B2, C, B1o, B1, C, EDGE]);

  // Spots inside a 28 x 31 table (tile centres).
  var CORNERS = [{ x: 1.5, y: 1.5 }, { x: 26.5, y: 29.5 }, { x: 26.5, y: 1.5 }, { x: 1.5, y: 29.5 }];
  var START = { x: 13.5, y: 23.5 };

  // build(table, mx, my, opts): mx x my copies of one table. opts.wrap: a torus (as chompMaze). Not wrapped, the side
  // tunnels still wrap left to right inside one screen (the arcade's own tunnel), the top and bottom stay sealed.
  function build(table, mx, my, opts) {
    if (table === 'module') return lift(Maze.build(mx, my, opts));
    var wrap = !!(opts && opts.wrap), MW = Maze.MW, MH = Maze.MH, GAP = wrap ? Maze.GAP : 0;
    var W = (MW + GAP) * mx, H = (MH + GAP) * my;
    var cell = new Uint8Array(W * H), dot0 = new Uint8Array(W * H), spacer = new Uint8Array(W * H).fill(GAP ? 1 : 0);
    var moduleOf = new Uint16Array(W * H), modules = [];
    for (var j = 0; j < my; j++) for (var i = 0; i < mx; i++) {
      var ox = i * (MW + GAP), oy = j * (MH + GAP), m = modules.length;
      modules.push({ i: i, j: j, ox: ox, oy: oy, index: m });
      for (var r = 0; r < MH; r++) for (var c = 0; c < MW; c++) {
        var ch = table[r][c], k = (oy + r) * W + ox + c, v = Maze.WALL;
        if (ch === '.') { v = Maze.PATH; dot0[k] = Maze.DOT; }
        else if (ch === 'o') { v = Maze.PATH; dot0[k] = Maze.ENERGIZER; }
        else if (ch === '_') v = Maze.PATH;
        else if (ch === 't') v = Maze.TUNNEL;
        else if (ch === 'H') v = Maze.HWALL;
        else if (ch === 'g') v = Maze.HOUSE_IN;
        else if (ch === '=') v = Maze.DOOR;
        cell[k] = v; moduleOf[k] = m; spacer[k] = 0;
      }
      if (GAP) {
        cell[(oy + 14) * W + ox + MW] = Maze.TUNNEL;
        for (var rr = 0; rr < MH + GAP; rr++) for (var cc = 0; cc < MW + GAP; cc++) {
          if (rr >= MH || cc >= MW) moduleOf[(oy + rr) * W + ox + cc] = m;
        }
      }
    }
    var A = {
      W: W, H: H, mx: mx, my: my, MW: MW, MH: MH, GAP: GAP, cell: cell, dot0: dot0, moduleOf: moduleOf, spacer: spacer,
      modules: modules, wrap: wrap, sideWrap: !wrap
    };
    return finish(A);
  }

  // chompMaze's own arena (today's module), with the lab's helpers added.
  function lift(A) { A.sideWrap = false; return finish(A); }

  function finish(A) {
    var W = A.W, H = A.H, cell = A.cell, wrap = A.wrap, side = A.sideWrap;
    function wc(c) { return (wrap || side) ? ((c % W) + W) % W : c; }
    function wr(r) { return wrap ? ((r % H) + H) % H : r; }
    A.wc = wc; A.wr = wr;
    A.k = function (c, r) { return wr(r) * W + wc(c); };
    A.idx = function (c, r) { return r * W + c; };
    A.inside = function (c, r) { return c >= 0 && r >= 0 && c < W && r < H; };
    A.walk = function (c, r) {
      c = wc(c); r = wr(r);
      if (c < 0 || r < 0 || c >= W || r >= H) return false;
      var v = cell[r * W + c];
      return v === Maze.PATH || v === Maze.TUNNEL;
    };
    A.ghostWalk = function (c, r, door) {
      c = wc(c); r = wr(r);
      if (c < 0 || r < 0 || c >= W || r >= H) return false;
      var v = cell[r * W + c];
      return v === Maze.PATH || v === Maze.TUNNEL || (door && (v === Maze.DOOR || v === Maze.HOUSE_IN));
    };
    A.tunnel = function (c, r) { c = wc(c); r = wr(r); return c >= 0 && r >= 0 && c < W && r < H && cell[r * W + c] === Maze.TUNNEL; };
    A.wallish = function (c, r) { c = wc(c); r = wr(r); if (c < 0 || r < 0 || c >= W || r >= H) return true; return cell[r * W + c] === Maze.WALL; };
    A.moduleAt = function (x, y) {
      var c = Math.max(0, Math.min(W - 1, wc(Math.floor(x)))), r = Math.max(0, Math.min(H - 1, wr(Math.floor(y))));
      return A.modules[A.moduleOf[r * W + c]];
    };
    // the short way across a seam (a torus both ways; one screen, only left and right through the tunnel)
    A.dx = function (a, b) { var d = b - a; return (wrap || side) ? d - W * Math.round(d / W) : d; };
    A.dy = function (a, b) { var d = b - a; return wrap ? d - H * Math.round(d / H) : d; };
    A.wx = function (x) { return (wrap || side) ? x - W * Math.floor(x / W) : x; };
    A.wy = function (y) { return wrap ? y - H * Math.floor(y / H) : y; };
    // every walkable tile key, for bots and spawns
    A.paths = [];
    for (var k = 0; k < W * H; k++) if (cell[k] === Maze.PATH || cell[k] === Maze.TUNNEL) A.paths.push(k);
    // the renderer only wraps a full torus; a one-screen maze is drawn sealed, its tunnel wraps in the sim
    return A;
  }

  var L = { BRICK: BRICK, CORNERS: CORNERS, START: START, build: build };
  if (typeof module === 'object' && module.exports) module.exports = L;
  else root.LabMaze = L;
})(typeof self !== 'undefined' ? self : this);
