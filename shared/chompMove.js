// How a chomper moves, one sim tick at a time. The server runs it for every player and bot; the browser runs the
// very same code for its own chomper (prediction) so a key press turns at once on screen and the server agrees.
//
// DOSSIER Chapter 3 rules it follows:
//   - Pac-Man can reverse at any moment.
//   - A turn is taken when the tile Pac-Man is in has an opening in the wanted direction (the 3-4 px pre-turn and
//     post-turn windows cover the whole 8 px tile). A wanted direction is remembered until it can be taken.
//   - While turning he moves along BOTH axes at full speed (cornering: he cuts the corner, so turning early gains
//     ground), sliding back onto the centre line of the new corridor.
//   - He stops at the centre of a tile whose next tile is a wall.
//   - Eating a dot costs one tick of standing still, an energizer three (the "dots speed" column of Table A.1).
(function (root) {
  'use strict';
  var R = (typeof module === 'object' && module.exports) ? require('./chompRules') : root.ChompRules;
  var DIRS = R.DIRS;
  var EPS = 1e-7;

  function opp(d) { return (d + 2) & 3; }
  function canGo(A, c, r, d) { var v = DIRS[d]; return A.walk(c + v[0], r + v[1]); }
  function approach(v, target, step) {
    if (v < target) return Math.min(target, v + step);
    if (v > target) return Math.max(target, v - step);
    return v;
  }

  // Take the wanted direction if the rules allow it now. Returns true when the direction changed.
  function tryTurn(p, A) {
    var w = p.want;
    if (w == null || w < 0 || w === p.dir) return false;
    if (p.dir >= 0 && w === opp(p.dir)) { p.dir = w; return true; }
    var c = Math.floor(p.x), r = Math.floor(p.y);
    if (!canGo(A, c, r, w)) return false;
    // The turn window (TURN_WINDOW from the centre along the current axis): with 4 px on an 8 px tile it is the
    // whole tile, but keep the check so the number stays the one that decides.
    if (p.dir >= 0) {
      var v = DIRS[p.dir];
      var off = v[0] !== 0 ? Math.abs(p.x - (c + 0.5)) : Math.abs(p.y - (r + 0.5));
      if (off > R.TURN_WINDOW + EPS) return false;
    }
    p.dir = w;
    return true;
  }

  // Move dist tiles along p.dir (cornering on the cross axis). Sets p.moving.
  function advance(p, A, dist) {
    p.moving = false;
    if (p.dir == null || p.dir < 0) return;
    var c = Math.floor(p.x), r = Math.floor(p.y);
    var cx = c + 0.5, cy = r + 0.5;
    var v = DIRS[p.dir];
    var blocked = !canGo(A, c, r, p.dir);
    if (v[0] !== 0) {
      var ny = approach(p.y, cy, dist);
      if (Math.abs(ny - p.y) > EPS) p.moving = true;
      p.y = ny;
      var nx = p.x + v[0] * dist;
      if (blocked && (nx - cx) * v[0] >= 0) nx = cx;
      if (Math.abs(nx - p.x) > EPS) p.moving = true;
      p.x = nx;
    } else {
      var nx2 = approach(p.x, cx, dist);
      if (Math.abs(nx2 - p.x) > EPS) p.moving = true;
      p.x = nx2;
      var ny2 = p.y + v[1] * dist;
      if (blocked && (ny2 - cy) * v[1] >= 0) ny2 = cy;
      if (Math.abs(ny2 - p.y) > EPS) p.moving = true;
      p.y = ny2;
    }
  }

  // One tick. speed in tiles per second; dots is the arena's live dot array (or null); eat(k, kind) is called when
  // the chomper's tile holds a dot (the caller removes it). Returns the dot kind eaten this tick (0 none).
  function tick(p, A, speed, dt, dots, eat) {
    if (p.pause > 0) { p.pause--; p.moving = false; return 0; }
    tryTurn(p, A);
    advance(p, A, speed * dt);
    if (!dots) return 0;
    var c = Math.floor(p.x), r = Math.floor(p.y);
    if (!A.inside(c, r)) return 0;
    var k = r * A.W + c, kind = dots[k];
    if (!kind) return 0;
    p.pause = kind === 2 ? R.ENERGIZER_PAUSE_TICKS : R.DOT_PAUSE_TICKS;
    if (eat) eat(k, kind);
    return kind;
  }

  var Mv = { DIRS: DIRS, opp: opp, canGo: canGo, tryTurn: tryTurn, advance: advance, tick: tick };
  if (typeof module === 'object' && module.exports) module.exports = Mv;
  else root.ChompMove = Mv;
})(typeof self !== 'undefined' ? self : this);
