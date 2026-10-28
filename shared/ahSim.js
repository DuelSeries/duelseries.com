// Air Hockey's table and physics, one fixed step at a time. The server runs every match with it
// (server/AirHockeyRoom.js); the browser runs the very same step for its own mallet and the puck (rewind and replay,
// public/js/airhockey.js), so a hit on your screen is the hit the server makes a moment later.
//
// NO REFERENCE GAME (Owen 2026-10-27: "honestly just make this one yourself"). The numbers are ours, chosen from a
// real table's proportions and then tuned by playing it against the bot; docs/airhockey-design.md says why each one
// is what it is.
//
// UNITS: the table is 600 wide and 1000 long, y growing DOWN. Seat 0 defends the bottom goal (y = 1000) and
// attacks the top one; seat 1 defends the top goal (y = 0). Each player's screen turns the table so their own goal
// is at the bottom; the world never turns.
//
// THE MODEL, in one paragraph: the puck glides with a little air drag, bounces off the rails with most of its speed,
// and is capped at a top speed. A mallet is held by a hand, so it is never pushed around by the puck (infinite mass);
// it goes where its player points, as fast as a hand can move it, and stays on its own half. A hit is the puck
// bouncing off a moving circle: the mallet's own speed along the line of contact goes into the puck, which is what
// makes a swing feel like a swing. Each 60 Hz step runs as 4 sub-steps so a fast puck can never jump through a mallet.
(function (root) {
  'use strict';

  var AH = {
    W: 600, H: 1000,             // the playing surface
    CORNER: 70,                  // the rails' corner radius
    GOAL_W: 210,                 // the goal mouth, centred on each end rail
    GOAL_D: 70,                  // how deep the slot behind the mouth is (a puck that is in stops there)
    PUCK_R: 26,
    MALLET_R: 40,
    STEP: 1 / 60,
    SUB: 4,                      // sub-steps per step: a 2400/s puck moves 10 units a sub-step, under half its radius
    PUCK_MAX: 2400,              // the fastest a puck ever goes (units/s): end to end in about 0.42 s
    PUCK_MIN_SERVE: 0,
    MALLET_MAX: 2600,            // the fastest a hand moves a mallet (units/s)
    DRAG: 0.22,                  // air-film drag, per second (a 2000/s shot keeps 80% of its speed after a second)
    FRICTION: 14,                // and a little constant slowing, so a puck at rest stays at rest (units/s^2)
    RAIL_E: 0.9,                 // rail restitution
    RAIL_GRIP: 0.97,             // the share of the along-the-rail speed a bounce keeps
    MALLET_E: 0.78,              // mallet to puck restitution
    POST_E: 0.75,
    HALF_GAP: 20,                // a mallet's centre stays this far on its own side of the halfway line
    SERVE_Y: 0.75,               // the serve spot: three quarters of the way to your own end (your own half's middle)
    // The match (server/AirHockeyRoom.js reads these; the page shows them)
    TO_WIN: 7,                   // first to seven
    MATCH_MS: 240000,            // four minutes of play, then the leader wins
    SUDDEN_MS: 60000,            // level at 0:00: one more minute where the next goal wins; still level is a draw
    COUNTDOWN_MS: 3000,          // 3, 2, 1 before the first serve
    GOAL_PAUSE_MS: 1800,         // the GOAL! moment, then the puck is served to whoever conceded
    STALL_MS: 7000,              // a puck kept on one side this long goes to the other player (the real rule's 7 s)
    STALL_WARN_MS: 4000          // the warning ring starts here
  };
  AH.GOAL_X0 = (AH.W - AH.GOAL_W) / 2;
  AH.GOAL_X1 = (AH.W + AH.GOAL_W) / 2;
  AH.SDT = AH.STEP / AH.SUB;

  function newMallet(side) {
    var y = side === 0 ? AH.H - 130 : 130;
    return { x: AH.W / 2, y: y, tx: AH.W / 2, ty: y, vx: 0, vy: 0 };
  }
  function newPuck() { return { x: AH.W / 2, y: AH.H / 2, vx: 0, vy: 0, live: false }; }
  function newMatch() {
    return { tick: 0, puck: newPuck(), m: [newMallet(0), newMallet(1)] };
  }

  // Where a mallet's centre may be: on the table, clear of the rails (corners included) and on its own half.
  function clampMallet(side, x, y) {
    var r = AH.MALLET_R, W = AH.W, H = AH.H;
    if (!(x === x)) x = W / 2;
    if (!(y === y)) y = side === 0 ? H - 130 : 130;
    if (x < r) x = r; else if (x > W - r) x = W - r;
    if (side === 0) { if (y < H / 2 + AH.HALF_GAP) y = H / 2 + AH.HALF_GAP; else if (y > H - r) y = H - r; }
    else { if (y > H / 2 - AH.HALF_GAP) y = H / 2 - AH.HALF_GAP; else if (y < r) y = r; }
    var c = AH.CORNER, lim = c - r;
    var cx = x < c ? c : x > W - c ? W - c : -1, cy = y < c ? c : y > H - c ? H - c : -1;
    if (cx >= 0 && cy >= 0) {
      var dx = x - cx, dy = y - cy, d = Math.sqrt(dx * dx + dy * dy);
      if (d > lim && d > 0) { x = cx + dx / d * lim; y = cy + dy / d * lim; }
    }
    return [x, y];
  }

  // The puck off a fixed circle (a rounded corner from the inside: `inside`; a goal post from the outside).
  function bounceNormal(p, nx, ny, e, grip) {
    var vn = p.vx * nx + p.vy * ny;
    if (vn >= 0) return 0;                 // already leaving
    var tx = -ny, ty = nx, vt = p.vx * tx + p.vy * ty;
    vt *= grip;
    vn = -vn * e;
    p.vx = nx * vn + tx * vt;
    p.vy = ny * vn + ty * vt;
    return vn;
  }

  // The rails, the corners, the posts and the goal slots. Returns the hardest bounce this sub-step and what it hit.
  function rails(p, out) {
    var r = AH.PUCK_R, W = AH.W, H = AH.H, c = AH.CORNER, g0 = AH.GOAL_X0, g1 = AH.GOAL_X1;
    var hit = 0, what = null, s;
    var inMouth = p.x > g0 && p.x < g1;
    // In a goal slot (its centre past an end line): the slot's own side walls and its back.
    if (p.y < 0 || p.y > H) {
      if (p.x < g0 + r) { p.x = g0 + r; if (p.vx < 0) p.vx = -p.vx * 0.5; }
      if (p.x > g1 - r) { p.x = g1 - r; if (p.vx > 0) p.vx = -p.vx * 0.5; }
      if (p.y < -AH.GOAL_D) { p.y = -AH.GOAL_D; p.vy = Math.abs(p.vy) * 0.15; p.vx *= 0.4; }
      if (p.y > H + AH.GOAL_D) { p.y = H + AH.GOAL_D; p.vy = -Math.abs(p.vy) * 0.15; p.vx *= 0.4; }
      return null;
    }
    // Side rails.
    if (p.x < r) { p.x = r; s = bounceNormal(p, 1, 0, AH.RAIL_E, AH.RAIL_GRIP); if (s > hit) { hit = s; what = 'rail'; } }
    else if (p.x > W - r) { p.x = W - r; s = bounceNormal(p, -1, 0, AH.RAIL_E, AH.RAIL_GRIP); if (s > hit) { hit = s; what = 'rail'; } }
    // End rails, open across the mouth.
    if (!inMouth) {
      if (p.y < r) { p.y = r; s = bounceNormal(p, 0, 1, AH.RAIL_E, AH.RAIL_GRIP); if (s > hit) { hit = s; what = 'rail'; } }
      else if (p.y > H - r) { p.y = H - r; s = bounceNormal(p, 0, -1, AH.RAIL_E, AH.RAIL_GRIP); if (s > hit) { hit = s; what = 'rail'; } }
    }
    // Rounded corners, from the inside.
    var cx = p.x < c ? c : p.x > W - c ? W - c : -1, cy = p.y < c ? c : p.y > H - c ? H - c : -1;
    if (cx >= 0 && cy >= 0) {
      var dx = p.x - cx, dy = p.y - cy, d = Math.sqrt(dx * dx + dy * dy), lim = c - r;
      if (d > lim && d > 0) {
        var nx = -dx / d, ny = -dy / d;
        p.x = cx - nx * lim; p.y = cy - ny * lim;
        s = bounceNormal(p, nx, ny, AH.RAIL_E, AH.RAIL_GRIP);
        if (s > hit) { hit = s; what = 'rail'; }
      }
    }
    // The four posts (the mouth's edges), as points.
    var posts = [g0, g1];
    for (var i = 0; i < 2; i++) {
      for (var j = 0; j < 2; j++) {
        var px = posts[i], py = j ? H : 0;
        var ex = p.x - px, ey = p.y - py, dd = ex * ex + ey * ey;
        if (dd < r * r && dd > 1e-9) {
          var dl = Math.sqrt(dd), qx = ex / dl, qy = ey / dl;
          p.x = px + qx * r; p.y = py + qy * r;
          s = bounceNormal(p, qx, qy, AH.POST_E, 0.9);
          if (s > hit) { hit = s; what = 'post'; }
        }
      }
    }
    if (what && out) out.push({ e: what, v: Math.round(hit), x: Math.round(p.x), y: Math.round(p.y) });
    return what;
  }

  /* One step. inputs[i] is { x, y }: where seat i is pointing (world units). Mallets always move (in every phase:
     your hand is yours); the puck only moves and only collides while puck.live. `rules` (the server) also reports a
     goal; the page steps with rules off and leaves goals, the clock and the score to the server. Returns the step's
     events: hit { s, v }, rail / post { v }, goal { s: the scorer }. */
  function step(m, inputs, rules) {
    var ev = [];
    var p = m.puck, SUB = AH.SUB, sdt = AH.SDT;
    var R = AH.PUCK_R + AH.MALLET_R;
    // This step's targets, clamped; each sub-step walks a share of the way from the last step's target, so a hand's
    // motion is spread evenly over the step and a mallet's speed is smooth, never a burst and a stop.
    var from = [], to = [];
    for (var s = 0; s < 2; s++) {
      var mm = m.m[s], inp = inputs && inputs[s];
      var t = inp && typeof inp.x === 'number' && typeof inp.y === 'number' ? clampMallet(s, inp.x, inp.y) : [mm.tx, mm.ty];
      from[s] = [mm.tx, mm.ty]; to[s] = t;
      mm.tx = t[0]; mm.ty = t[1];
    }
    var hitDone = [false, false];
    var maxMove = AH.MALLET_MAX * sdt;
    for (var k = 1; k <= SUB; k++) {
      var u = k / SUB;
      var mv = [[0, 0], [0, 0]];
      for (s = 0; s < 2; s++) {
        var ml = m.m[s];
        var gx = from[s][0] + (to[s][0] - from[s][0]) * u, gy = from[s][1] + (to[s][1] - from[s][1]) * u;
        var dx = gx - ml.x, dy = gy - ml.y, d = Math.sqrt(dx * dx + dy * dy);
        if (d > maxMove) { dx *= maxMove / d; dy *= maxMove / d; }
        var nx0 = ml.x + dx, ny0 = ml.y + dy;
        var cl = clampMallet(s, nx0, ny0);
        mv[s][0] = cl[0] - ml.x; mv[s][1] = cl[1] - ml.y;
        ml.x = cl[0]; ml.y = cl[1];
        ml.vx = mv[s][0] / sdt; ml.vy = mv[s][1] / sdt;
      }
      if (!p.live) continue;
      // The puck glides.
      var sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
      if (sp > 0) {
        var ns = sp * (1 - AH.DRAG * sdt) - AH.FRICTION * sdt;
        if (ns < 0) ns = 0;
        if (ns > AH.PUCK_MAX) ns = AH.PUCK_MAX;
        p.vx *= ns / sp; p.vy *= ns / sp;
      }
      p.x += p.vx * sdt; p.y += p.vy * sdt;
      // Each mallet against the puck.
      for (s = 0; s < 2; s++) {
        var q = m.m[s];
        var ex = p.x - q.x, ey = p.y - q.y, dd = ex * ex + ey * ey;
        if (dd >= R * R) continue;
        var dl = Math.sqrt(dd), nx, ny;
        if (dl < 1e-6) { nx = 0; ny = s === 0 ? -1 : 1; dl = 0; } else { nx = ex / dl; ny = ey / dl; }
        p.x = q.x + nx * R; p.y = q.y + ny * R;
        var rv = (p.vx - q.vx) * nx + (p.vy - q.vy) * ny;
        if (rv < 0) {
          var j = -(1 + AH.MALLET_E) * rv;
          p.vx += j * nx; p.vy += j * ny;
          var sp2 = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
          if (sp2 > AH.PUCK_MAX) { p.vx *= AH.PUCK_MAX / sp2; p.vy *= AH.PUCK_MAX / sp2; }
          if (!hitDone[s] && j > 40) {
            hitDone[s] = true;
            ev.push({ e: 'hit', s: s, v: Math.round(j), x: Math.round(q.x + nx * AH.MALLET_R), y: Math.round(q.y + ny * AH.MALLET_R) });
          }
        }
      }
      rails(p, ev);
      // Pinned against a rail: the puck stays on the table and the mallet is held off it instead.
      for (s = 0; s < 2; s++) {
        var b = m.m[s];
        var fx = b.x - p.x, fy = b.y - p.y, f2 = fx * fx + fy * fy;
        if (f2 < R * R && f2 > 1e-9) {
          var fl = Math.sqrt(f2);
          var c2 = clampMallet(s, p.x + fx / fl * R, p.y + fy / fl * R);
          b.x = c2[0]; b.y = c2[1];
        }
      }
      if (rules) {
        if (p.y < -AH.PUCK_R) { p.live = false; ev.push({ e: 'goal', s: 0 }); break; }
        if (p.y > AH.H + AH.PUCK_R) { p.live = false; ev.push({ e: 'goal', s: 1 }); break; }
      }
    }
    m.tick++;
    return ev;
  }

  // The puck on a seat's serve spot, at rest (after a goal it goes to whoever conceded).
  function serve(m, side) {
    var p = m.puck;
    p.x = AH.W / 2;
    p.y = side === 0 ? AH.H * AH.SERVE_Y : AH.H * (1 - AH.SERVE_Y);
    p.vx = 0; p.vy = 0; p.live = true;
    // A mallet parked on the spot is moved off it, so the serve never starts inside somebody.
    for (var s = 0; s < 2; s++) {
      var q = m.m[s], dx = q.x - p.x, dy = q.y - p.y, R = AH.PUCK_R + AH.MALLET_R + 2;
      if (dx * dx + dy * dy < R * R) {
        var c = clampMallet(s, p.x + (dx >= 0 ? R : -R), q.y);
        q.x = c[0]; q.y = c[1];
      }
    }
  }

  // Which half the puck is on: 0 the bottom (seat 0's), 1 the top.
  function halfOf(p) { return p.y >= AH.H / 2 ? 0 : 1; }

  // The board's clock: the time left as "M:SS". A second shows until it has fully gone.
  function clockText(msLeft) {
    var s = Math.ceil(Math.max(0, msLeft) / 1000 - 1e-6), mm = Math.floor(s / 60), ss = s % 60;
    return mm + ':' + (ss < 10 ? '0' : '') + ss;
  }

  var r10 = function (v) { return Math.round(v * 10); };
  function packMallet(q) { return [r10(q.x), r10(q.y), r10(q.tx), r10(q.ty)]; }
  function unpackMallet(a, side) {
    var q = newMallet(side);
    q.x = a[0] / 10; q.y = a[1] / 10; q.tx = a[2] / 10; q.ty = a[3] / 10;
    return q;
  }
  function packPuck(p) { return [r10(p.x), r10(p.y), r10(p.vx), r10(p.vy), p.live ? 1 : 0]; }
  function unpackPuck(a) {
    var p = newPuck();
    p.x = a[0] / 10; p.y = a[1] / 10; p.vx = a[2] / 10; p.vy = a[3] / 10; p.live = !!a[4];
    return p;
  }

  var Sim = { AH: AH, newMatch: newMatch, newMallet: newMallet, newPuck: newPuck, step: step, serve: serve,
              clampMallet: clampMallet, halfOf: halfOf, clockText: clockText,
              packMallet: packMallet, unpackMallet: unpackMallet, packPuck: packPuck, unpackPuck: unpackPuck };
  if (typeof module === 'object' && module.exports) module.exports = Sim;
  else root.AHSim = Sim;
})(typeof self !== 'undefined' ? self : this);
