'use strict';
// Paper multiplayer wire module (T1): shared constants, codec round trips, radius table,
// O(1) wall test, trail decimator and the guarded border. Design sections 2, 4.3, 7, 9.1-9.2.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Required BEFORE any solo module, so this also proves it loads with no DuelPaperLib present.
const MP = require('../public/js/paper/mp/paperWire.js');
const C = require('../shared/constants');

const WIRE_FILE = path.join(__dirname, '../public/js/paper/mp/paperWire.js');
const PAPER_DIR = path.join(__dirname, '../public/js/paper');

function loadSolo() {
  require(path.join(PAPER_DIR, 'paperGeom.js'));
  require(path.join(PAPER_DIR, 'paperTerritory.js'));
  return globalThis.DuelPaperLib;
}

// Deterministic LCG so every run checks the same points.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test('loads standalone under require and as a classic browser script', () => {
  const src = fs.readFileSync(WIRE_FILE, 'utf8');
  const cjs = { module: { exports: {} } };
  vm.runInNewContext(src, cjs);
  assert.strictEqual(cjs.module.exports.HOLD_TICKS, 180);
  assert.strictEqual(cjs.DuelPaperLib.MP, cjs.module.exports);

  const win = {};
  win.window = win;
  vm.runInNewContext(src, win);
  assert.strictEqual(win.DuelPaperLib.MP.HOLD_TICKS, 180);
  assert.strictEqual(typeof win.DuelPaperLib.MP.encodeFrame, 'function');
});

test('every constant named in design section 2 is exported from MP', () => {
  const doc = fs.readFileSync(path.join(__dirname, '../docs/paper-multiplayer-design.md'), 'utf8');
  const sec = doc.slice(doc.indexOf('\n## 2.'), doc.indexOf('\n## 3.'));
  const names = [];
  for (const line of sec.split('\n')) {
    if (!line.startsWith('| `')) continue;
    const first = line.split('|')[1];
    for (const m of first.matchAll(/`([A-Z][A-Z0-9_]+)`/g)) names.push(m[1]);
  }
  assert.ok(names.length >= 50, 'parsed ' + names.length + ' names');
  for (const n of names) assert.notStrictEqual(MP[n], undefined, n + ' missing from MP');
});

test('constants agree with the project and with each other', () => {
  assert.strictEqual(MP.STEP_MS, 1000 / C.TICK_RATE);
  assert.strictEqual(MP.HOLD_MS, C.CASHOUT_HOLD_MS);
  assert.strictEqual(MP.HOLD_TICKS, 180);
  assert.ok(MP.PICKUP_WALL_INSET < MP.PICKUP_RADIUS);
  assert.deepStrictEqual(MP.PUSH_TWIST_CANDIDATES, [0.001, -0.001, 0.002]);
  assert.strictEqual(MP.FREE_SQUARES, MP.FREE_BOTS_IDLE + 1);
  assert.strictEqual(MP.R_MIN, MP.R_MAX * Math.sqrt(MP.N_BASE / MP.N_FULL));
});

test('radiusFor table and monotone', () => {
  const want = { 0: 475, 4: 475, 5: 950 * Math.sqrt(5 / 16), 8: 950 * Math.sqrt(0.5), 15: 950 * Math.sqrt(15 / 16), 16: 950, 20: 950 };
  for (const [n, r] of Object.entries(want)) assert.ok(Math.abs(MP.radiusFor(+n) - r) < 1e-9, 'n=' + n);
  let prev = -1;
  for (let n = 0; n <= 40; n++) {
    const r = MP.radiusFor(n);
    assert.ok(r >= prev, 'monotone at ' + n);
    assert.ok(r >= 475 && r <= 950);
    prev = r;
  }
});

test('wallInside agrees with a brute-force convex test on 10,000 points', () => {
  const P = loadSolo();
  const rand = rng(7);
  let checked = 0;
  let inside = 0;
  for (const radius of [950, 712.3, 475]) {
    const center = { x: 1000, y: 1000 };
    const verts = P.makeCirclePoints(new P.Vec2(1000, 1000), 300, radius);
    assert.strictEqual(verts.length, 300);
    const wall = { center, radius, pointCount: 300 };
    const n = radius === 950 ? 4000 : 3000;
    for (let i = 0; i < n; i++) {
      // Most samples land in the thin band between apothem and radius, where the edge test runs.
      const a = rand() * Math.PI * 2;
      const d = rand() < 0.8 ? radius * (0.9995 + rand() * 0.0015) : rand() * radius * 1.2;
      const x = center.x + Math.cos(a) * d;
      const y = center.y + Math.sin(a) * d;
      let minDist = Infinity;
      for (let k = 0; k < 300; k++) {
        const A = verts[k];
        const B = verts[(k + 1) % 300];
        const ex = B.x - A.x;
        const ey = B.y - A.y;
        const sd = (ex * (y - A.y) - ey * (x - A.x)) / Math.hypot(ex, ey);
        if (sd < minDist) minDist = sd;
      }
      if (Math.abs(minDist) < 1e-5) continue;
      checked++;
      const brute = minDist > 0;
      if (brute) inside++;
      assert.strictEqual(MP.wallInside(wall, x, y), brute, `r=${radius} (${x}, ${y}) margin ${minDist}`);
    }
  }
  assert.ok(checked > 9900, 'checked ' + checked);
  assert.ok(inside > 1000 && checked - inside > 1000, 'both sides sampled');
});

function sampleUnit(i, tailN) {
  const tail = [];
  for (let t = 0; t < tailN; t++) tail.push({ x: 100 + i * 7.3 + t, y: 1900 - i * 3.1 - t * 2 });
  return {
    id: 65535 - i * 97,
    x: 50 + i * 118.3,
    y: 1950 - i * 101.7,
    dir: -3 + i * 0.77,
    bot: i % 2 === 0,
    holding: i % 3 === 0,
    pushed: i % 5 === 0,
    holdTicks: i * 12,
    ack: (i * 37) & 255,
    trailEpoch: (i * 19) & 255,
    pct: i / 16,
    inId: i * 3,
    baseVer: i * 1000,
    trailCount: i * 40,
    micro: 100000 * i + 7,
    tail
  };
}

test('frame round trip, sizes, and decode from a node Buffer', () => {
  const units = [];
  for (let i = 0; i < 16; i++) units.push(sampleUnit(i, i % 3));
  const pickups = [{ pid: 1, x: 999.9, y: 1000.1, micro: 100000 }, { pid: 65535, x: 60, y: 1940, micro: 4294967295 }];
  const frame = { tick: 4000000001, radius: 950, targetRadius: 712.25, shrinking: true, paid: true, units, pickups };
  const buf = MP.encodeFrame(frame);
  assert.strictEqual(buf.byteLength, MP.frameSize(units, pickups));
  const got = MP.decodeFrame(Buffer.from(buf));
  assert.strictEqual(got.tick, 4000000001);
  assert.strictEqual(got.shrinking, true);
  assert.strictEqual(got.paid, true);
  assert.strictEqual(got.radius, 950);
  assert.strictEqual(got.targetRadius, 712.25);
  assert.strictEqual(got.units.length, 16);
  const q = 0.5 / MP.POS_SCALE + 1e-9;
  units.forEach((u, i) => {
    const g = got.units[i];
    assert.strictEqual(g.id, u.id);
    assert.ok(Math.abs(g.x - u.x) <= q && Math.abs(g.y - u.y) <= q, 'position ' + i);
    let dd = Math.abs(MP.wrapAngle(g.dir) - MP.wrapAngle(u.dir));
    dd = Math.min(dd, Math.PI * 2 - dd);
    assert.ok(dd <= Math.PI / 65536 + 1e-12, 'dir ' + i);
    assert.strictEqual(g.bot, u.bot);
    assert.strictEqual(g.holding, u.holding);
    assert.strictEqual(g.pushed, u.pushed);
    assert.strictEqual(Math.round(g.hold * 255), MP.holdByte(u.holdTicks));
    assert.strictEqual(g.ack, u.ack);
    assert.strictEqual(g.trailEpoch, u.trailEpoch);
    assert.ok(Math.abs(g.pct - u.pct) <= 0.5 / 65535 + 1e-12);
    assert.strictEqual(g.inId, u.inId);
    assert.strictEqual(g.baseVer, u.baseVer);
    assert.strictEqual(g.trailCount, u.trailCount);
    assert.strictEqual(g.micro, u.micro);
    assert.strictEqual(g.tail.length, u.tail.length);
    g.tail.forEach((p, t) => assert.ok(Math.abs(p.x - u.tail[t].x) <= q && Math.abs(p.y - u.tail[t].y) <= q));
  });
  assert.deepStrictEqual(got.pickups.map(p => [p.pid, p.micro]), [[1, 100000], [65535, 4294967295]]);
  assert.ok(Math.abs(got.pickups[0].x - 999.9) <= q);

  const empty = [];
  for (let i = 0; i < 16; i++) empty.push(sampleUnit(i, 0));
  assert.strictEqual(MP.encodeFrame({ tick: 1, radius: 950, targetRadius: 950, units: empty, pickups: [] }).byteLength, 412);
  const full = [];
  for (let i = 0; i < 16; i++) full.push(sampleUnit(i, 9));
  const threeCoins = [0, 1, 2].map(k => ({ pid: k + 1, x: 1000, y: 1000, micro: 1 }));
  const fb = MP.encodeFrame({ tick: 1, radius: 950, targetRadius: 950, units: full, pickups: threeCoins });
  assert.strictEqual(fb.byteLength, 668 + 10 * 3);
  const fd = MP.decodeFrame(fb);
  assert.ok(fd.units.every(u => u.tail.length === MP.TRAIL_TAIL_MAX), 'tail capped at TRAIL_TAIL_MAX');
  assert.strictEqual(fd.units[0].tail[0].y, full[0].tail[0].y, 'the OLDEST tail corners are the ones sent');
});

test('money u32 is exact and saturates; pct saturates; hold byte; direction wraps', () => {
  const one = (u) => MP.decodeFrame(MP.encodeFrame({ tick: 0, radius: 1, targetRadius: 1, units: [Object.assign(sampleUnit(1, 0), u)] })).units[0];
  assert.strictEqual(one({ micro: 123456789 }).micro, 123456789);
  assert.strictEqual(one({ micro: 5e9 }).micro, 4294967295);
  assert.strictEqual(one({ micro: -5 }).micro, 0);
  assert.strictEqual(one({ micro: NaN }).micro, 0);
  assert.strictEqual(one({ pct: 1.2 }).pct, 1);
  assert.strictEqual(one({ pct: -0.3 }).pct, 0);
  assert.strictEqual(one({ pct: NaN }).pct, 0);
  assert.strictEqual(MP.clampPct(1.2), 1);
  assert.strictEqual(one({ holdTicks: MP.HOLD_TICKS }).hold, 1);
  assert.strictEqual(one({ holdTicks: MP.HOLD_TICKS + 40 }).hold, 1);
  assert.ok(one({ holdTicks: MP.HOLD_TICKS - 1 }).hold < 1);
  assert.strictEqual(one({ holdTicks: 0 }).hold, 0);
  const dirOf = (d) => one({ dir: d }).dir;
  assert.ok(Math.abs(dirOf(-Math.PI / 2) - 1.5 * Math.PI) < 1e-4);
  assert.ok(Math.abs(dirOf(7 * Math.PI + 0.25) - (Math.PI + 0.25)) < 1e-4);
  assert.ok(dirOf(Math.PI * 2 - 1e-9) < 1e-4, 'just under a full turn wraps to 0, not 65536');
});

test('input integer round trips and rejects anything a client never sends', () => {
  for (let seq = 0; seq < 256; seq += 5) {
    for (let angle = 0; angle <= 253; angle++) {
      for (const hold of [false, true]) {
        const n = MP.encodeInput(seq, angle, hold);
        assert.deepStrictEqual(MP.decodeInput(n), { seq, angle, hold });
      }
    }
  }
  for (let b = 0; b <= 253; b++) assert.strictEqual(MP.angleToByte(MP.byteToAngle(b)), b);
  assert.strictEqual(MP.angleToByte(Math.PI * 2), 0);
  assert.strictEqual(MP.angleToByte(-Math.PI / 127), 253);
  for (const bad of [(254 << 8), (255 << 8), -1, 0x1000000, 1.5, '7', null, undefined, NaN, {}]) {
    assert.strictEqual(MP.decodeInput(bad), null, String(bad));
  }
  assert.strictEqual(MP.seqNewer(1, 0), true);
  assert.strictEqual(MP.seqNewer(0, 255), true);
  assert.strictEqual(MP.seqNewer(255, 0), false);
  assert.strictEqual(MP.seqNewer(7, 7), false);
});

test('ring and trail blobs round trip', () => {
  const pts = [];
  for (let i = 0; i < 1851; i++) pts.push({ x: 50 + (i * 1.0371) % 1900, y: 1950 - (i * 0.7713) % 1900 });
  const got = MP.decodePoints(Buffer.from(MP.encodePoints(pts)));
  assert.strictEqual(got.length, pts.length);
  got.forEach((p, i) => assert.ok(Math.abs(p.x - pts[i].x) <= 0.5 / 32 && Math.abs(p.y - pts[i].y) <= 0.5 / 32));
  assert.deepStrictEqual(MP.decodePoints(MP.encodePoints([])), []);
  assert.strictEqual(MP.encodePoints(pts).byteLength, 2 + 4 * 1851);
});

function maxDeviation(raw, poly) {
  let worst = 0;
  for (const p of raw) {
    let best = Infinity;
    for (let i = 0; i + 1 < poly.length; i++) {
      const d = MP.distToSegmentSq(p.x, p.y, poly[i].x, poly[i].y, poly[i + 1].x, poly[i + 1].y);
      if (d < best) best = d;
    }
    if (poly.length === 1) best = (p.x - poly[0].x) ** 2 + (p.y - poly[0].y) ** 2;
    worst = Math.max(worst, Math.sqrt(best));
  }
  return worst;
}

test('trail decimator stays within TRAIL_TOL and is append-only', () => {
  const rand = rng(11);
  const raw = [];
  let x = 1000, y = 1000, dir = 0;
  const maxTurn = 2 * Math.PI / 60;
  for (let i = 0; i < 3000; i++) {
    raw.push({ x, y });
    dir += (rand() * 2 - 1) * maxTurn * (rand() < 0.3 ? 1 : 0.2);
    x += Math.cos(dir) * 1.5;
    y += Math.sin(dir) * 1.5;
  }
  const d = new MP.Decimator();
  const seen = [];
  raw.forEach((p, i) => {
    d.push(p.x, p.y);
    if (i % 97 === 0) seen.push({ n: d.corners.length, copy: d.corners.map(c => [c, c.x, c.y]) });
  });
  for (const s of seen) {
    s.copy.forEach(([obj, cx, cy], k) => {
      assert.strictEqual(d.corners[k], obj, 'corner objects never replaced');
      assert.strictEqual(obj.x, cx);
      assert.strictEqual(obj.y, cy);
    });
  }
  const poly = d.corners.concat([d.head()]);
  assert.ok(maxDeviation(raw, poly) <= MP.TRAIL_TOL + 1e-9, 'deviation ' + maxDeviation(raw, poly));
  assert.ok(d.corners.length < raw.length / 3, 'it actually decimates: ' + d.corners.length);
  for (let i = 1; i < poly.length; i++) {
    assert.ok(Math.hypot(poly[i].x - poly[i - 1].x, poly[i].y - poly[i - 1].y) <= MP.TRAIL_MAX_GAP + 1e-9);
  }
});

test('a 5000-point wall crawl becomes under 200 corners', () => {
  const P = loadSolo();
  const verts = P.makeCirclePoints(new P.Vec2(1000, 1000), 300, 950);
  const raw = [];
  // Walk the wall polygon itself at 0.45 u spacing (the probe: 5885 raw points in 25 s).
  let k = 0, t = 0;
  while (raw.length < 5000) {
    const A = verts[k % 300];
    const B = verts[(k + 1) % 300];
    const len = Math.hypot(B.x - A.x, B.y - A.y);
    raw.push({ x: A.x + (B.x - A.x) * (t / len), y: A.y + (B.y - A.y) * (t / len) });
    t += 0.45;
    while (t >= len) { t -= len; k++; }
  }
  const d = new MP.Decimator();
  for (const p of raw) d.push(p.x, p.y);
  assert.ok(d.corners.length < 200, 'corners ' + d.corners.length);
  assert.ok(maxDeviation(raw, d.corners.concat([d.head()])) <= MP.TRAIL_TOL + 1e-9);
});

test('decimateRing keeps a ring within RING_TOL', () => {
  const P = loadSolo();
  const ring = P.makeCirclePoints(new P.Vec2(1000, 1000), 1500, 300);
  const out = MP.decimateRing(ring, MP.RING_TOL);
  assert.ok(out.length >= 3 && out.length < ring.length / 2, 'ring ' + out.length);
  assert.ok(maxDeviation(ring, out.concat([out[0]])) <= MP.RING_TOL + 1e-9);
});

test('guardedBorder caps, resets, rebuilds and reuses registered vertex objects', () => {
  const P = loadSolo();
  const center = new P.Vec2(1000, 1000);
  const border = MP.guardedBorder(center, 300, 950);
  assert.strictEqual(border.polygon.segments.length, 300);
  const seg = new P.Segment(new P.Vec2(1000, 1000), new P.Vec2(2100, 1003));
  for (let i = 0; i < MP.BORDER_GUARD_CALLS; i++) {
    assert.strictEqual(border.intersections(seg).length, 1, 'call ' + (i + 1) + ' is real');
  }
  assert.deepStrictEqual(border.intersections(seg), []);
  assert.strictEqual(border.guardTrips, 1);
  border.resetGuard();
  assert.strictEqual(border.intersections(seg).length, 1);

  border.setRadius(600);
  assert.strictEqual(border.radius, 600);
  assert.ok(Math.abs(border.apothem - 600 * Math.cos(Math.PI / 300)) < 1e-12);
  assert.strictEqual(border.orientation, 1);
  assert.ok(Math.abs(border.polygon.segments[0].start.x - 1600) < 1e-9);
  assert.ok(border.inside(1599, 1000) && !border.inside(1601, 1000));

  const grid = new P.SpatialGrid(2000, 2000, 20);
  const where = P.makeCirclePoints(center, 300, 800)[37];
  const registered = new P.Vec2(where.x, where.y);
  grid.cell(registered).commit(registered);
  const spaced = MP.guardedBorder(center, 300, 950, grid);
  spaced.setRadius(800);
  assert.strictEqual(spaced.polygon.segments[37].start, registered, 'vertex 37 is the registered object');
  assert.strictEqual(spaced.polygon.segments[36].end, registered);
  assert.notStrictEqual(spaced.polygon.segments[38].start, registered);
  const plain = MP.guardedBorder(center, 300, 800);
  assert.notStrictEqual(plain.polygon.segments[37].start, registered, 'no space: fresh objects');
});
