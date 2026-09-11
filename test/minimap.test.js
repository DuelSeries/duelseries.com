'use strict';
/* THE MINIMAP MUST SHOW EVERY SNAKE, ALWAYS.

   The bug: `_drawMinimap` scaled by `R / state.worldRadius` and plotted dots at
   `cx + d.x * scale` with no centre offset. In a battle royale the zone both
   shrinks and travels, so the scale blew up while the map stayed pinned to
   world origin, and any snake far from the origin fell outside the clip circle
   and disappeared. Late in a match that is most of the board — which is exactly
   what was reported: the snakes stop showing once the border moves in.

   These drive the REAL method, lifted out of public/js/Renderer.js rather than
   copied, so the test cannot quietly stop describing the shipped code. It is
   called on a bare object because the only instance state it touches is
   `this._mapR`; that sidesteps the constructor's canvas and matchMedia. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const C = require('../shared/constants');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'Renderer.js'), 'utf8');
const sandbox = {
  window: { matchMedia: () => ({ matches: false }) },
  document: {}, navigator: {}, performance: { now: () => 0 },
};
vm.createContext(sandbox);
vm.runInContext(src + '\n;globalThis.__Renderer = Renderer;', sandbox);
const Renderer = sandbox.__Renderer;

/* A canvas that remembers the circles it was asked to draw. */
function recorder() {
  const arcs = [];
  return {
    arcs,
    save() {}, restore() {}, beginPath() {}, fill() {}, stroke() {}, clip() {},
    setLineDash() {},
    arc(x, y, r) { arcs.push({ x, y, r }); },
    fillStyle: '', strokeStyle: '', lineWidth: 0, globalAlpha: 1,
  };
}

const W = 1600, H = 900;
// Mirrors the widget geometry the method computes, so the assertions below are
// about the DOTS rather than about re-deriving the layout.
const R = Math.min(110, Math.floor(Math.min(W, H) * 0.15));
const cx = W - 12 - R, cy = H - 12 - R - 60;

/* Pull the SNAKE DOTS out of the recorded arcs.

   Filtering by radius is not enough: a zone closed down to 200 units draws at
   3.7px, which is inside any plausible "this looks like a dot" bound, and the
   first attempt at this test counted the border as a snake. The draw order is
   fixed and known — background, zone, next ring, dots, outer ring — so the dots
   are sliced out by position instead, which cannot be fooled by a coincidence
   of size. */
function paint(self, state, myId) {
  const ctx = recorder();
  Renderer.prototype._drawMinimap.call(self, ctx, state, myId || null, W, H);
  const lead = 1                                                  // background disc
    + ((state.worldRadius || 0) * (R / Math.max(state.mapRadius || 0,
        state.worldRadius || 0, 1)) > 0.5 ? 1 : 0)                // the live zone
    + (state.zoneTo ? 1 : 0);                                     // the next ring
  return { arcs: ctx.arcs, dots: ctx.arcs.slice(lead, -1) };
}

/* Snakes spread right across the world, which is the population that used to
   vanish. Placed on a ring near the edge so nothing sits near the old fixed
   centre by accident. */
function snakesAround(radius, n) {
  const mm = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    mm.push({ x: Math.cos(a) * radius, y: Math.sin(a) * radius, c: '#fff', id: 's' + i });
  }
  return mm;
}

test('every snake stays on the map as the zone shrinks and walks away', () => {
  const mm = snakesAround(C.MAX_WORLD_RADIUS * 0.92, 24);
  const self = {};

  /* Walk a whole match: the circle closes from the full world down to a last
     ring, drifting a long way off origin as it goes — the real shape of a
     battle royale, and the shape that broke this. */
  let worldRadius = C.MAX_WORLD_RADIUS, wcx = 0, wcy = 0;
  for (let step = 0; step < 30; step++) {
    worldRadius = Math.max(120, worldRadius * 0.82);
    wcx += 140; wcy -= 95;
    const { dots } = paint(self, {
      worldRadius, worldCx: wcx, worldCy: wcy,
      mapRadius: C.MAX_WORLD_RADIUS, mm, snakes: [], zoneTo: null,
    }, 's0');

    assert.ok(dots.length >= mm.length,
      `all ${mm.length} snakes plotted at step ${step} (got ${dots.length})`);
    for (const d of dots) {
      const dist = Math.hypot(d.x - cx, d.y - cy);
      assert.ok(dist <= R + 0.5,
        `a snake dot is inside the minimap at step ${step} `
        + `(dist ${dist.toFixed(1)} > R ${R}) — this is the vanishing bug`);
    }
  }
});

test('the map never zooms in when the zone does', () => {
  /* The scale is what broke: tied to worldRadius, it grew without bound as the
     circle closed. Two snakes a fixed distance apart must stay a fixed distance
     apart on the widget, whatever the zone is doing. */
  const mm = [{ x: -3000, y: 0, c: '#fff', id: 'a' }, { x: 3000, y: 0, c: '#fff', id: 'b' }];
  const self = {};
  const spread = (worldRadius, wcx) => {
    const { dots: d } = paint(self, {
      worldRadius, worldCx: wcx, worldCy: 0, mapRadius: C.MAX_WORLD_RADIUS,
      mm, snakes: [], zoneTo: null,
    });
    assert.equal(d.length, 2, 'both snakes plotted');
    return Math.abs(d[0].x - d[1].x);
  };
  const wide = spread(C.MAX_WORLD_RADIUS, 0);
  const tight = spread(200, 2500);
  assert.ok(wide > 0, 'the two snakes are apart at all');
  assert.equal(tight.toFixed(4), wide.toFixed(4),
    'the same two snakes are the same distance apart on a closed-in zone');
});

test('the zone is drawn where it actually is, not at the origin', () => {
  /* The old code never read worldCx/worldCy, so the arena it drew and the arena
     being played were different places. */
  const { arcs } = paint({}, {
    worldRadius: 1000, worldCx: 3000, worldCy: 0, mapRadius: C.MAX_WORLD_RADIUS,
    mm: [], snakes: [], zoneTo: null,
  });
  const scale = R / C.MAX_WORLD_RADIUS;
  const zone = arcs.find(a => Math.abs(a.r - 1000 * scale) < 0.01);
  assert.ok(zone, 'the zone circle was drawn');
  assert.ok(Math.abs(zone.x - (cx + 3000 * scale)) < 0.01,
    'the zone circle is offset by worldCx, not pinned to the widget centre');
});

test('the next ring is drawn too, so you can see where to run', () => {
  const { arcs } = paint({}, {
    worldRadius: 2000, worldCx: 0, worldCy: 0, mapRadius: C.MAX_WORLD_RADIUS,
    mm: [], snakes: [], zoneTo: { x: 1200, y: -800, r: 900 },
  });
  const scale = R / C.MAX_WORLD_RADIUS;
  const target = arcs.find(a => Math.abs(a.r - 900 * scale) < 0.01);
  assert.ok(target, 'the next ring was drawn');
  assert.ok(Math.abs(target.x - (cx + 1200 * scale)) < 0.01
         && Math.abs(target.y - (cy + -800 * scale)) < 0.01,
    'and at the place the wall is actually travelling to');
});

test('an ordinary room still fills its map, and never zooms back in', () => {
  /* Normal worlds only grow, with the crowd. The high-water mark must follow
     them up and must not follow anything back down. */
  const self = {};
  const scaleAt = (worldRadius) => {
    const d = paint(self, {
      worldRadius, worldCx: 0, worldCy: 0,
      mm: [{ x: 1000, y: 0, c: '#fff', id: 'a' }], snakes: [], zoneTo: null,
    }).dots[0];
    return (d.x - cx) / 1000;             // widget units per world unit
  };
  const small = scaleAt(2000);
  const grown = scaleAt(4000);
  assert.ok(grown < small, 'the map zooms OUT as the world grows');
  assert.equal(scaleAt(2000).toFixed(6), grown.toFixed(6),
    'and does not zoom back in underneath the player');
});
