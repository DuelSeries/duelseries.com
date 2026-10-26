// Chomp's maze walls as arcade pixels: one value per pixel at 8 px a tile, drawn by the rules measured from public
// 1x captures of the arcade screen (docs/chomp-look.md, "Walls"). Our own maze layout, drawn the arcade's way:
//
//   - Walls are outlines one pixel wide, never filled. The outline runs through the centres of the wall tiles that
//     face a corridor: a wall's top and left edges sit 4 px into their tile, its bottom and right edges 3 px.
//   - Every outline corner, inside or outside, is cut by one diagonal pixel: the lines stop 2 px short of the corner
//     point and one pixel sits on the diagonal between them.
//   - The frame (each module's border ring and the walls joined to it) gets a second line 3 px deeper, but only round
//     the parts at least 3 tiles thick: the arcade's double line runs straight past its two-tile stubs and notches and
//     follows its big side boxes (so here: the frame after an opening by a 3 x 3 block of tiles; past the arena edge
//     counts as frame). Its corners: where the line turns toward the wall a tight step (the lines stop 1 px short,
//     nothing between), where it turns away a 4 px round.
//   - The ghost house is a double box 3 px apart with square corners; its door is a 16 x 2 bar in the gap.
//
// build(A) -> { PW, PH, mask } with mask[y * PW + x] 0 nothing, 1 wall, 2 door. Pure, so the tests can check it.
// A torus (A.wrap) is traced on a copy padded by PAD tiles of the map's own far side all round (past the padding is
// solid), then cropped: every tile of the map is drawn with its real neighbours across the seam, and the padding
// absorbs the edge of the copy.
(function (root) {
  'use strict';
  var Maze = (typeof module === 'object' && module.exports) ? require('./chompMaze') : root.ChompMaze;
  var T = 8;
  var ROUND4 = [[2, 1], [3, 1], [1, 2], [1, 3]];     // the 4 px round, as (along leaving, back along arriving)

  var PAD = 6;   // CHOSEN: tiles of padding round a torus copy (the deepest rule reaches 3 tiles: the 3 x 3 opening)

  function build(A) {
    var W = A.W, H = A.H, PW = W * T, PH = H * T;
    var mask = new Uint8Array(PW * PH);
    function put(x, y, v) { if (x >= 0 && y >= 0 && x < PW && y < PH) mask[y * PW + x] = v || 1; }

    // frame tiles: walls joined, inside their own module, to the module's border ring
    var frame = new Uint8Array(W * H);
    A.modules.forEach(function (m) {
      var q = [];
      for (var r = 0; r < Maze.MH; r++) for (var c = 0; c < Maze.MW; c++) {
        if (r !== 0 && r !== Maze.MH - 1 && c !== 0 && c !== Maze.MW - 1) continue;
        var k = (m.oy + r) * W + m.ox + c;
        if (A.cell[k] === Maze.WALL && !frame[k]) { frame[k] = 1; q.push(k); }
      }
      for (var h = 0; h < q.length; h++) {
        var kc = q[h] % W, kr = (q[h] - kc) / W;
        for (var d = 0; d < 4; d++) {
          var nc = kc + [1, -1, 0, 0][d], nr = kr + [0, 0, 1, -1][d];
          if (nc < m.ox || nr < m.oy || nc >= m.ox + Maze.MW || nr >= m.oy + Maze.MH) continue;
          var nk = nr * W + nc;
          if (A.cell[nk] === Maze.WALL && !frame[nk]) { frame[nk] = 1; q.push(nk); }
        }
      }
    });
    // the one-tile spacers between modules are frame too, so neighbouring modules' frames join into one thick wall
    if (A.spacer) for (var sk = 0; sk < W * H; sk++) if (A.spacer[sk] && A.cell[sk] === Maze.WALL) frame[sk] = 1;

    // The grid the outlines are traced on: the map itself, or on a torus the map padded with its own far side.
    var P = A.wrap ? PAD : 0;
    var GW = W + 2 * P, GH = H + 2 * P, GPW = GW * T, GPH = GH * T;
    var gmask = P ? new Uint8Array(GPW * GPH) : mask;
    function gput(x, y, v) { if (x >= 0 && y >= 0 && x < GPW && y < GPH) gmask[y * GPW + x] = v || 1; }
    // the map's tile key of grid tile (c, r), or -1 past the grid (solid)
    function keyOf(c, r) {
      if (c < 0 || r < 0 || c >= GW || r >= GH) return -1;
      return P ? A.k(c - P, r - P) : r * W + c;
    }
    function wallAt(c, r) { var k = keyOf(c, r); return k < 0 || A.cell[k] === Maze.WALL; }
    function frameRaw(c, r) { var k = keyOf(c, r); return k < 0 || !!frame[k]; }
    // opening by 3 x 3: erode (all 9 frame), then dilate (any of 9 eroded). Tiles 2 past the edge are frame for free.
    var EW = GW + 4, er = new Uint8Array(EW * (GH + 4));
    for (var r = -2; r < GH + 2; r++) for (var c = -2; c < GW + 2; c++) {
      var all = true;
      for (var dy = -1; dy <= 1 && all; dy++) for (var dx = -1; dx <= 1 && all; dx++) if (!frameRaw(c + dx, r + dy)) all = false;
      if (all) er[(r + 2) * EW + c + 2] = 1;
    }
    function eroded(c, r) { return c < -2 || r < -2 || c >= GW + 2 || r >= GH + 2 || !!er[(r + 2) * EW + c + 2]; }
    function frameThick(c, r) {
      var fk = keyOf(c, r);
      if (fk < 0) return true;
      if (!frame[fk]) return false;
      for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) if (eroded(c + dx, r + dy)) return true;
      return false;
    }

    trace(wallAt, 0);
    trace(frameThick, 3);
    // a torus: the padded copy cropped back to the map
    if (P) {
      for (var py = 0; py < PH; py++) {
        var src = (py + P * T) * GPW + P * T;
        mask.set(gmask.subarray(src, src + PW), py * PW);
      }
    }

    // the outline of a tile set: contour edges between tile centres, walked into loops, stroked at a depth
    function trace(solid, depth) {
      function inside(c, r) { return solid(c, r) && solid(c + 1, r) && solid(c, r + 1) && solid(c + 1, r + 1); }
      var VW = GW + 3;
      function vk(c, r) { return (r + 1) * VW + (c + 1); }
      function vc(v) { return [v % VW - 1, Math.floor(v / VW) - 1]; }
      var adj = new Map();
      function link(a, b, e) {
        if (!adj.has(a)) adj.set(a, []);
        if (!adj.has(b)) adj.set(b, []);
        adj.get(a).push({ to: b, e: e });
        adj.get(b).push({ to: a, e: e });
      }
      for (var r = -1; r <= GH; r++) for (var c = -1; c <= GW; c++) {
        if (c < GW) {
          var below = inside(c, r), above = inside(c, r - 1);
          if (below !== above) link(vk(c, r), vk(c + 1, r), { h: 1, n: [0, below ? 1 : -1] });
        }
        if (r < GH) {
          var right = inside(c, r), left = inside(c - 1, r);
          if (right !== left) link(vk(c, r), vk(c, r + 1), { h: 0, n: [right ? 1 : -1, 0] });
        }
      }
      // the pixel line of an edge at vertex (c, r): its y if horizontal, its x if vertical
      function lineOf(e, c, r) { return e.h ? r * T + (e.n[1] > 0 ? 4 : 3) : c * T + (e.n[0] > 0 ? 4 : 3); }
      var used = new Set();
      function ek(a, b) { return a < b ? a + ':' + b : b + ':' + a; }
      adj.forEach(function (_v, start) {
        adj.get(start).forEach(function (first) {
          if (used.has(ek(start, first.to))) return;
          var seq = [{ v: start, e: first.e }], cur = first.to, edge = first.e;
          used.add(ek(start, cur));
          for (var guard = 0; guard < 1e6 && cur !== start; guard++) {
            var list = adj.get(cur), next = null, i;
            for (i = 0; i < list.length && !next; i++) if (!used.has(ek(cur, list[i].to)) && list[i].e.h === edge.h) next = list[i];
            for (i = 0; i < list.length && !next; i++) if (!used.has(ek(cur, list[i].to))) next = list[i];
            if (!next) break;
            used.add(ek(cur, next.to));
            seq.push({ v: cur, e: next.e });
            cur = next.to; edge = next.e;
          }
          if (cur !== start) return;
          var n = seq.length, cs = [];
          for (var k = 0; k < n; k++) {
            var eIn = seq[(k - 1 + n) % n].e, eOut = seq[k].e;
            if (eIn.h === eOut.h) continue;
            var cr = vc(seq[k].v), hE = eIn.h ? eIn : eOut, vE = eIn.h ? eOut : eIn;
            cs.push({ x: lineOf(vE, cr[0], cr[1]), y: lineOf(hE, cr[0], cr[1]), nIn: eIn.n, nOut: eOut.n });
          }
          if (cs.length >= 4) stroke(cs, depth);
        });
      });
    }

    // one pass round a loop's corners at a depth (0 the outline, 3 the frame's second line)
    function stroke(cs, depth) {
      var m = cs.length;
      for (var j = 0; j < m; j++) {
        var P0 = cs[j], Q0 = cs[(j + 1) % m], O0 = cs[(j - 1 + m) % m];
        P0.dOut = [Math.sign(Q0.x - P0.x), Math.sign(Q0.y - P0.y)];
        P0.dIn = [Math.sign(P0.x - O0.x), Math.sign(P0.y - O0.y)];
      }
      var pts = cs.map(function (k) {
        var g = 2;
        if (depth) g = (k.dOut[0] * k.nIn[0] + k.dOut[1] * k.nIn[1]) > 0 ? 1 : 4;
        return { x: k.x + depth * (k.nIn[0] + k.nOut[0]), y: k.y + depth * (k.nIn[1] + k.nOut[1]), g: g, k: k };
      });
      for (var i = 0; i < m; i++) {
        var P = pts[i], Q = pts[(i + 1) % m];
        var dx = P.k.dOut[0], dy = P.k.dOut[1];
        var len = Math.abs(Q.x - P.x) + Math.abs(Q.y - P.y);
        for (var t = P.g; t <= len - Q.g; t++) gput(P.x + dx * t, P.y + dy * t);
        var a = [-P.k.dIn[0], -P.k.dIn[1]], b = P.k.dOut;
        if (P.g === 2) gput(P.x + a[0] + b[0], P.y + a[1] + b[1]);
        if (P.g === 4) ROUND4.forEach(function (ij) { gput(P.x + ij[0] * b[0] + ij[1] * a[0], P.y + ij[0] * b[1] + ij[1] * a[1]); });
      }
    }

    // ghost houses: a double box 3 px apart, square corners, the door gap over the house's middle two columns
    var Hs = Maze.HOUSE;
    A.modules.forEach(function (m) {
      var x0 = (m.ox + Hs.c0) * T + 4, y0 = (m.oy + Hs.r0) * T + 4;
      var x1 = (m.ox + Hs.c1) * T + 3, y1 = (m.oy + Hs.r1) * T + 3;
      var g0 = (m.ox + Hs.doorX - 1) * T, g1 = (m.ox + Hs.doorX + 1) * T - 1;
      for (var d = 0; d <= 3; d += 3) {
        for (var x = x0 + d; x <= x1 - d; x++) { if (x < g0 || x > g1) put(x, y0 + d); put(x, y1 - d); }
        for (var y = y0 + d; y <= y1 - d; y++) { put(x0 + d, y); put(x1 - d, y); }
      }
      for (var yy = y0; yy <= y0 + 3; yy++) { put(g0 - 1, yy); put(g1 + 1, yy); }
      for (var xx = g0; xx <= g1; xx++) { put(xx, y0 + 1, 2); put(xx, y0 + 2, 2); }
    });
    return { PW: PW, PH: PH, mask: mask };
  }

  var Wl = { build: build, T: T };
  if (typeof module === 'object' && module.exports) module.exports = Wl;
  else root.ChompWalls = Wl;
})(typeof self !== 'undefined' ? self : this);
